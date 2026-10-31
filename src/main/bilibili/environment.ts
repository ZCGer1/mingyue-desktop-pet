import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../../core/types'
import type { BiliInstallKind, BiliInstallView } from '../../shared/bilibili'
import { atomicWrite } from '../../core/util'
import { biliModelDir, type BiliPaths } from './paths'
import { biliChildEnv } from './childEnv'
import { killProcessTree } from './kill'

/**
 * B 站服务的隔离依赖环境。
 *
 * - 只用系统 Python 创建两个独立 venv：service 与 asr。系统 Python 不装包。
 * - 安装是显式动作，有阶段进度/失败原因；不会静默联网。
 * - 服务/ASR/模型三种状态分开：Python 缺失与 ASR 缺失可区分。
 * - 子进程不接收 B 站凭据；安装命令参数固定，不接受模型/用户输入拼接。
 */

export interface BiliPythonRuntime {
  /** 可执行文件（系统 Python 命令或 venv 解释器绝对路径）。 */
  command: string
  /** 命令前缀参数，例如 `py -3`。 */
  prefix: string[]
  version: string
}

export interface BiliPythonInstaller {
  version: string
  url: string
  sha256: string
  maxBytes: number
}

export interface BiliEnvironmentOptions {
  paths: BiliPaths
  /** 打包/开发时的 resources/bilibili 目录。 */
  resourcesDir: string
  logger: Logger
  spawnImpl?: typeof spawn
  fetchImpl?: typeof fetch
  /** 仅供测试/审计注入；生产固定使用 BILI_PYTHON_INSTALLER。 */
  installer?: BiliPythonInstaller
  now?: () => number
  onChanged?: () => void
}

/**
 * 固定来源的 Windows Python 安装包。
 * URL 只指向 python.org，SHA-256 在 2026-10-29 下载后固定；
 * 安装目标始终是应用数据目录，不修改 PATH、文件关联或全局 Python。
 */
export const BILI_PYTHON_INSTALLER: BiliPythonInstaller = {
  version: '3.12.10',
  url: 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe',
  sha256: '67b5635e80ea51072b87941312d00ec8927c4db9ba18938f7ad2d27b328b95fb',
  maxBytes: 40 * 1024 * 1024
}

interface Marker {
  v: 1
  installedAt: number
  requirementsSha: string
  python: string
  packageVersion: string | null
}

interface InstallResult {
  ok: boolean
  code?: string
  message: string
  version?: string | null
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const PYTHON_CANDIDATES: Array<{ command: string; prefix: string[] }> = [
  { command: 'py', prefix: ['-3.12'] },
  { command: 'py', prefix: ['-3.11'] },
  { command: 'py', prefix: ['-3.10'] },
  { command: 'py', prefix: ['-3'] },
  { command: 'python', prefix: [] },
  { command: 'python3', prefix: [] }
]

const MIN_PYTHON = [3, 10] as const
const DETECT_TIMEOUT_MS = 6000
const VENV_TIMEOUT_MS = 120_000
const PIP_TIMEOUT_MS = 15 * 60_000
const MODEL_TIMEOUT_MS = 20 * 60_000
const PYTHON_INSTALL_TIMEOUT_MS = 10 * 60_000
const INSTALLER_HOST_SUFFIX = '.python.org'
const MAX_CAPTURE = 200_000

export class BiliEnvironment {
  private readonly opts: BiliEnvironmentOptions
  private python: BiliPythonRuntime | null | undefined = undefined
  private readonly views = new Map<BiliInstallKind, BiliInstallView>()
  private running: ReturnType<typeof spawn> | null = null
  private downloading: AbortController | null = null
  private installing: BiliInstallKind | null = null
  private disposed = false
  private model = 'small'

  constructor(options: BiliEnvironmentOptions) {
    this.opts = options
    for (const kind of ['python', 'service', 'asr', 'model'] as const) {
      this.views.set(kind, {
        kind,
        state: 'unknown',
        progress: null,
        message: null,
        version: null,
        updatedAt: null
      })
    }
  }

  /**
   * 重新探测 Python、安装标记与模型目录；设置页打开或配置里的模型名变化时
   * 调用。`forcePython` 只在用户显式重试安装/刷新环境时使用，避免每次状态
   * 刷新都去 spawn 系统 Python。
   */
  async refresh(forcePython = false, model = 'small'): Promise<void> {
    this.model = normalizeModel(model)
    const python = await this.detectPython(forcePython)
    const service = this.inspectService(python)
    const asr = this.inspectAsr(python)
    // inspectModel() 依赖 asrPython() 的当前视图；先把 Python、服务和 ASR
    // 状态提交，否则首次探测时模型总会被误报为“请先安装本地转写依赖”。
    this.setView(this.inspectPython(python))
    this.setView(service)
    this.setView(asr)
    this.setView(this.inspectModel(python))
  }

  view(kind: BiliInstallKind): BiliInstallView {
    return this.views.get(kind) ?? {
      kind,
      state: 'unknown',
      progress: null,
      message: null,
      version: null,
      updatedAt: null
    }
  }

  pythonView(): { found: boolean; version: string | null } {
    return {
      found: this.python !== null && this.python !== undefined,
      version: this.python?.version ?? null
    }
  }

  servicePython(): string | null {
    if (!this.installed('service')) return null
    return this.venvPython('service')
  }

  asrPython(): string | null {
    if (!this.installed('asr')) return null
    return this.venvPython('asr')
  }

  modelReady(model: string): boolean {
    try {
      return statSync(join(biliModelDir(this.opts.paths, model), 'model.bin')).isFile()
    } catch {
      return false
    }
  }

  /** 安装入口；同一时间只允许一个安装任务。 */
  async install(kind: BiliInstallKind, options: { model?: string } = {}): Promise<InstallResult> {
    if (this.disposed) return { ok: false, message: '应用正在退出，无法开始安装。' }
    if (this.installing !== null) {
      return { ok: false, message: `正在安装 ${this.installingLabel()}，请等它完成。` }
    }
    const python = await this.detectPython(true)
    if (kind === 'python' && python !== null) {
      this.setView(this.inspectPython(python))
      return {
        ok: true,
        message: `已检测到可用的 Python ${python.version}，无需再安装。`,
        version: python.version
      }
    }
    if (kind !== 'python' && python === null) {
      const message = '找不到 Python 3.10 或更高版本，请先安装 Python。'
      this.setView({
        kind,
        state: 'failed',
        progress: null,
        message,
        version: null,
        updatedAt: this.now()
      })
      return { ok: false, code: 'python-missing', message }
    }
    this.installing = kind
    try {
      if (kind === 'python') return await this.installPythonRuntime()
      if (python === null) return { ok: false, code: 'python-missing', message: '找不到 Python。' }
      if (kind === 'service') return await this.installService(python)
      if (kind === 'asr') return await this.installAsr(python)
      return await this.installModel(python, options.model ?? 'small')
    } catch (error) {
      const message =
        this.disposed
          ? '安装已中断。'
          : error instanceof Error
            ? error.message.slice(0, 160)
            : '安装失败。'
      this.setView({
        kind,
        state: this.disposed ? 'unknown' : 'failed',
        progress: null,
        message,
        version: null,
        updatedAt: this.now()
      })
      this.opts.logger.warn('B 站依赖安装失败', { kind, message })
      return { ok: false, message }
    } finally {
      this.installing = null
      this.running = null
      this.opts.onChanged?.()
    }
  }

  dispose(): void {
    this.disposed = true
    this.downloading?.abort()
    this.downloading = null
    if (this.running !== null) killProcessTree(this.running.pid)
    this.running = null
  }

  // ------------------------------------------------------------------ 安装

  /**
   * 用户显式点击后安装应用专用 Python。安装包 URL/哈希固定，下载后先校验
   * SHA-256 再执行；TargetDir 在应用数据目录，PrependPath=0、Shortcuts=0，
   * 不修改系统 PATH、文件关联或全局 site-packages。
   */
  private async installPythonRuntime(): Promise<InstallResult> {
    if (process.platform !== 'win32') {
      return this.failed('python', '自动安装 Python 目前只支持 Windows。', 'python-missing')
    }
    if (this.disposed) return { ok: false, message: '应用正在退出，安装已中断。' }
    const installer = this.opts.installer ?? BILI_PYTHON_INSTALLER
    mkdirSync(this.opts.paths.rootDir, { recursive: true })
    const file = join(this.opts.paths.rootDir, `python-installer-${process.pid}.exe`)
    try {
      this.progress('python', 0.02, `正在下载 Python ${installer.version}（固定来源）…`)
      const download = await this.downloadInstaller(installer, file)
      if (!download.ok) {
        return this.failed('python', download.message, 'python-missing')
      }
      this.progress('python', 0.5, '安装包校验通过，正在安装应用专用 Python…')
      const result = await this.runCommand(
        file,
        [
          '/quiet',
          'InstallAllUsers=0',
          `TargetDir=${this.opts.paths.pythonDir}`,
          'Include_pip=1',
          'Include_launcher=0',
          'Include_test=0',
          'Include_doc=0',
          'Include_tcltk=0',
          'Include_idle=0',
          'AssociateFiles=0',
          'Shortcuts=0',
          'PrependPath=0',
          'CompileAll=0',
          'SimpleInstall=1'
        ],
        PYTHON_INSTALL_TIMEOUT_MS
      )
      if (this.disposed) return { ok: false, message: '安装已中断。' }
      if (result.timedOut) {
        return this.failed('python', 'Python 安装超时，请稍后重试。', 'python-missing')
      }
      if (result.code !== 0) {
        return this.failed('python', 'Python 安装失败，请稍后重试。', 'python-missing')
      }
      this.python = undefined
      const python = await this.detectPython(true)
      if (python === null) {
        return this.failed(
          'python',
          'Python 安装完成，但无法启动；请重启应用后重试。',
          'python-missing'
        )
      }
      this.setView(this.inspectPython(python))
      this.opts.logger.info('B 站应用专用 Python 已安装', { version: python.version })
      return { ok: true, message: `Python ${python.version} 已安装。`, version: python.version }
    } finally {
      try {
        rmSync(file, { force: true })
      } catch {
        /* 临时安装包清理失败不改变安装结果 */
      }
    }
  }

  private async downloadInstaller(
    installer: BiliPythonInstaller,
    target: string
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      return { ok: false, message: '当前运行环境不支持下载 Python 安装包。' }
    }
    const controller = new AbortController()
    this.downloading = controller
    try {
      const response = await fetchImpl(installer.url, {
        signal: controller.signal,
        redirect: 'follow'
      })
      if (!response.ok) {
        return { ok: false, message: 'Python 安装包下载失败，请检查网络后重试。' }
      }
      const finalUrl = response.url === '' ? installer.url : response.url
      if (!isAllowedInstallerUrl(finalUrl)) {
        return { ok: false, message: 'Python 安装包来源校验失败，已停止安装。' }
      }
      const length = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(length) && length > installer.maxBytes) {
        return { ok: false, message: 'Python 安装包体积异常，已停止安装。' }
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength > installer.maxBytes) {
        return { ok: false, message: 'Python 安装包体积异常，已停止安装。' }
      }
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== installer.sha256) {
        return { ok: false, message: 'Python 安装包完整性校验失败，已停止安装。' }
      }
      writeFileSync(target, bytes, { mode: 0o600 })
      return { ok: true }
    } catch {
      if (this.disposed || controller.signal.aborted) {
        return { ok: false, message: '下载已取消。' }
      }
      return { ok: false, message: 'Python 安装包下载失败，请检查网络后重试。' }
    } finally {
      if (this.downloading === controller) this.downloading = null
    }
  }

  private async installService(python: BiliPythonRuntime): Promise<InstallResult> {
    const start = () => this.progress('service', 0.04, '正在创建独立运行环境…')
    start()
    const venv = await this.ensureVenv('service', python)
    if (!venv.ok) return this.failed('service', venv.message, 'service-start-failed')
    const requirements = join(this.opts.resourcesDir, 'requirements.txt')
    const installed = await this.pipInstall('service', venv.python, requirements)
    if (!installed.ok) return this.failed('service', installed.message, 'service-start-failed')
    this.progress('service', 0.9, '正在自检只读服务…')
    const check = await this.runCommand(
      venv.python.command,
      [
        ...venv.python.prefix,
        '-c',
        'import json,bilibili_api,aiohttp,PIL;print(json.dumps({"bilibili_api":getattr(bilibili_api,"__version__","unknown"),"aiohttp":aiohttp.__version__,"Pillow":PIL.__version__}))'
      ],
      VENV_TIMEOUT_MS
    )
    const versions = parseJsonObject(lastJsonLine(check.stdout))
    if (check.code !== 0 || versions === null) {
      return this.failed('service', '依赖安装完成，但只读服务自检失败。', 'service-start-failed')
    }
    const installedNow = this.now()
    this.writeMarker('service', {
      v: 1,
      installedAt: installedNow,
      requirementsSha: this.requirementsSha(requirements),
      python: python.version,
      packageVersion: stringField(versions['bilibili_api'])
    })
    this.setView({
      kind: 'service',
      state: 'ready',
      progress: 1,
      message: null,
      version: stringField(versions['bilibili_api']),
      updatedAt: installedNow
    })
    this.opts.logger.info('B 站只读服务依赖已安装', {
      bilibiliApi: stringField(versions['bilibili_api']),
      aiohttp: stringField(versions['aiohttp'])
    })
    return { ok: true, message: 'B 站只读服务已安装。', version: stringField(versions['bilibili_api']) }
  }

  private async installAsr(python: BiliPythonRuntime): Promise<InstallResult> {
    this.progress('asr', 0.04, '正在创建独立转写环境…')
    const venv = await this.ensureVenv('asr', python)
    if (!venv.ok) return this.failed('asr', venv.message, 'asr-not-installed')
    const requirements = join(this.opts.resourcesDir, 'requirements-asr.txt')
    const installed = await this.pipInstall('asr', venv.python, requirements)
    if (!installed.ok) return this.failed('asr', installed.message, 'asr-not-installed')
    this.progress('asr', 0.9, '正在自检本地转写…')
    const check = await this.runCommand(
      venv.python.command,
      [...venv.python.prefix, join(this.opts.resourcesDir, 'asr_worker.py'), '--check'],
      VENV_TIMEOUT_MS
    )
    const payload = parseJsonObject(lastJsonLine(check.stdout))
    if (check.code !== 0 || payload === null || payload['ok'] !== true) {
      return this.failed('asr', '依赖安装完成，但本地转写自检失败。', 'asr-not-installed')
    }
    const version = stringField(payload['fasterWhisper'])
    const installedNow = this.now()
    this.writeMarker('asr', {
      v: 1,
      installedAt: installedNow,
      requirementsSha: this.requirementsSha(requirements),
      python: python.version,
      packageVersion: version
    })
    this.setView({
      kind: 'asr',
      state: 'ready',
      progress: 1,
      message: null,
      version,
      updatedAt: installedNow
    })
    this.opts.logger.info('B 站本地转写依赖已安装', {
      fasterWhisper: version,
      ytDlp: stringField(payload['ytDlp'])
    })
    return { ok: true, message: '本地转写依赖已安装。', version }
  }

  private async installModel(python: BiliPythonRuntime, model: string): Promise<InstallResult> {
    const asr = this.asrPython()
    if (asr === null) {
      return this.failed('model', '请先安装本地转写依赖，再准备模型。', 'asr-not-installed')
    }
    this.progress('model', 0.05, '正在准备本地转写模型（可能需要几分钟）…')
    const script = join(this.opts.resourcesDir, 'prepare_model.py')
    mkdirSync(this.opts.paths.modelsDir, { recursive: true })
    const result = await this.runCommand(
      asr,
      [script, '--model', model, '--dir', this.opts.paths.modelsDir],
      MODEL_TIMEOUT_MS,
      (line) => {
        if (line.includes('Downloading') || line.includes('Fetching')) {
          this.progress('model', 0.3, '正在下载模型…')
        } else if (line.includes('100%')) {
          this.progress('model', 0.85, '正在校验模型文件…')
        }
      }
    )
    const payload = parseJsonObject(lastJsonLine(result.stdout))
    if (result.code !== 0 || payload === null || payload['ok'] !== true) {
      const message =
        payload !== null && typeof payload['message'] === 'string'
          ? payload['message']
          : '模型准备失败。'
      return this.failed('model', message, 'asr-model-missing')
    }
    const bytes = typeof payload['bytes'] === 'number' ? payload['bytes'] : 0
    this.setView({
      kind: 'model',
      state: 'ready',
      progress: 1,
      message: bytes > 0 ? `模型大小约 ${Math.round(bytes / 1024 / 1024)} MB` : null,
      version: model,
      updatedAt: this.now()
    })
    this.opts.logger.info('B 站转写模型已准备', { model, bytes })
    return { ok: true, message: `本地转写模型 ${model} 已准备。`, version: model }
  }

  private async ensureVenv(
    kind: 'service' | 'asr',
    python: BiliPythonRuntime
  ): Promise<{ ok: true; python: BiliPythonRuntime } | { ok: false; message: string }> {
    const dir = kind === 'service' ? this.opts.paths.serviceVenvDir : this.opts.paths.asrVenvDir
    const pythonPath = venvPythonPath(dir)
    if (!existsSync(pythonPath)) {
      mkdirSync(dir, { recursive: true })
      this.progress(kind, 0.1, '正在创建独立运行环境…')
      const result = await this.runCommand(
        python.command,
        [...python.prefix, '-I', '-m', 'venv', dir],
        VENV_TIMEOUT_MS
      )
      if (result.code !== 0 || !existsSync(pythonPath)) {
        return { ok: false, message: '创建独立运行环境失败，请确认 Python 安装完整。' }
      }
    }
    return { ok: true, python: { command: pythonPath, prefix: [], version: python.version } }
  }

  private async pipInstall(
    kind: 'service' | 'asr',
    python: BiliPythonRuntime,
    requirements: string
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!existsSync(requirements)) {
      return { ok: false, message: '依赖清单缺失，应用资源不完整。' }
    }
    this.progress(kind, 0.15, '正在获取依赖…')
    const result = await this.runCommand(
      python.command,
      [
        ...python.prefix,
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '--no-input',
        '--no-warn-script-location',
        '-r',
        requirements
      ],
      PIP_TIMEOUT_MS,
      (line) => {
        const text = line.trim()
        if (text === '') return
        if (text.startsWith('Collecting ')) {
          const name = text.slice(11).split(/\s+/)[0] ?? ''
          this.progress(kind, 0.2, `正在获取 ${safePackageName(name)}…`)
        } else if (text.startsWith('Downloading ')) {
          this.progress(kind, 0.4, '正在下载依赖…')
        } else if (text.includes('Installing collected packages')) {
          this.progress(kind, 0.7, '正在安装依赖…')
        } else if (text.startsWith('Successfully installed')) {
          this.progress(kind, 0.85, '依赖安装完成，正在自检…')
        }
      }
    )
    if (result.timedOut) return { ok: false, message: '依赖安装超时，请检查网络后重试。' }
    if (result.code !== 0) {
      const detail = result.stderr.toLowerCase()
      const message = detail.includes('ssl') || detail.includes('connection') || detail.includes('timeout')
        ? '依赖下载网络失败，请检查网络或代理后重试。'
        : detail.includes('no space')
          ? '磁盘空间不足，无法安装依赖。'
          : '依赖安装失败，请稍后重试。'
      return { ok: false, message }
    }
    return { ok: true }
  }

  // ------------------------------------------------------------------ 探测

  private async detectPython(force = false): Promise<BiliPythonRuntime | null> {
    if (force) this.python = undefined
    if (this.python !== undefined) return this.python
    const local = localPythonPath(this.opts.paths.pythonDir)
    const candidates = existsSync(local)
      ? [{ command: local, prefix: [] }, ...PYTHON_CANDIDATES]
      : PYTHON_CANDIDATES
    for (const candidate of candidates) {
      try {
        const result = await this.runCommand(
          candidate.command,
          [
            ...candidate.prefix,
            '-I',
            '-c',
            'import json,sys;print(json.dumps({"version":"%d.%d.%d"%sys.version_info[:3]}))'
          ],
          DETECT_TIMEOUT_MS
        )
        const payload = parseJsonObject(lastJsonLine(result.stdout))
        const version = payload === null ? null : stringField(payload['version'])
        if (result.code === 0 && version !== null && versionAtLeast(version, MIN_PYTHON)) {
          this.python = { ...candidate, version }
          return this.python
        }
      } catch {
        /* 尝试下一个候选 */
      }
    }
    this.python = null
    return null
  }

  private inspectPython(python: BiliPythonRuntime | null): BiliInstallView {
    if (python === null) {
      return this.missing('python', '未检测到 Python 3.10+，可安装应用专用 Python。')
    }
    return {
      kind: 'python',
      state: 'ready',
      progress: null,
      message: null,
      version: python.version,
      updatedAt: null
    }
  }

  private inspectService(python: BiliPythonRuntime | null): BiliInstallView {
    if (python === null) {
      return this.missing('service', '找不到 Python 3.10 或更高版本。')
    }
    const pythonPath = venvPythonPath(this.opts.paths.serviceVenvDir)
    if (!existsSync(pythonPath)) return this.missing('service', '尚未安装 B 站只读服务。')
    const marker = this.readMarker('service')
    if (marker === null) return this.missing('service', '尚未安装 B 站只读服务。')
    if (marker.requirementsSha !== this.requirementsSha(join(this.opts.resourcesDir, 'requirements.txt'))) {
      return this.missing('service', '依赖清单已更新，请重新安装 B 站只读服务。')
    }
    return {
      kind: 'service',
      state: 'ready',
      progress: null,
      message: null,
      version: marker.packageVersion,
      updatedAt: marker.installedAt
    }
  }

  private inspectAsr(python: BiliPythonRuntime | null): BiliInstallView {
    if (python === null) {
      return this.missing('asr', '找不到 Python 3.10 或更高版本。')
    }
    const pythonPath = venvPythonPath(this.opts.paths.asrVenvDir)
    if (!existsSync(pythonPath)) return this.missing('asr', '尚未安装本地转写依赖。')
    const marker = this.readMarker('asr')
    if (marker === null) return this.missing('asr', '尚未安装本地转写依赖。')
    if (marker.requirementsSha !== this.requirementsSha(join(this.opts.resourcesDir, 'requirements-asr.txt'))) {
      return this.missing('asr', '依赖清单已更新，请重新安装本地转写依赖。')
    }
    return {
      kind: 'asr',
      state: 'ready',
      progress: null,
      message: null,
      version: marker.packageVersion,
      updatedAt: marker.installedAt
    }
  }

  private inspectModel(python: BiliPythonRuntime | null): BiliInstallView {
    const model = this.model
    if (python === null) return this.missing('model', '需要先安装 Python 与本地转写依赖。')
    if (this.asrPython() === null) return this.missing('model', '请先安装本地转写依赖。')
    if (!this.modelReady(model)) return this.missing('model', `尚未准备本地转写模型 ${model}。`)
    let updatedAt: number | null = null
    try {
      updatedAt = statSync(biliModelDir(this.opts.paths, model)).mtimeMs
    } catch {
      updatedAt = null
    }
    return {
      kind: 'model',
      state: 'ready',
      progress: null,
      message: null,
      version: model,
      updatedAt
    }
  }

  private installed(kind: 'service' | 'asr'): boolean {
    return this.views.get(kind)?.state === 'ready' && existsSync(venvPythonPath(kind === 'service' ? this.opts.paths.serviceVenvDir : this.opts.paths.asrVenvDir))
  }

  private venvPython(kind: 'service' | 'asr'): string | null {
    const path = venvPythonPath(
      kind === 'service' ? this.opts.paths.serviceVenvDir : this.opts.paths.asrVenvDir
    )
    return existsSync(path) ? path : null
  }

  // ------------------------------------------------------------------ 工具

  private requirementsSha(file: string): string {
    try {
      return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
    } catch {
      return ''
    }
  }

  private readMarker(kind: 'service' | 'asr'): Marker | null {
    const file = kind === 'service' ? this.opts.paths.serviceMarkerFile : this.opts.paths.asrMarkerFile
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Marker>
      if (
        parsed.v !== 1 ||
        typeof parsed.installedAt !== 'number' ||
        typeof parsed.requirementsSha !== 'string' ||
        typeof parsed.python !== 'string'
      ) {
        return null
      }
      return {
        v: 1,
        installedAt: parsed.installedAt,
        requirementsSha: parsed.requirementsSha,
        python: parsed.python,
        packageVersion:
          typeof parsed.packageVersion === 'string' ? parsed.packageVersion : null
      }
    } catch {
      return null
    }
  }

  private writeMarker(kind: 'service' | 'asr', marker: Marker): void {
    const file = kind === 'service' ? this.opts.paths.serviceMarkerFile : this.opts.paths.asrMarkerFile
    atomicWrite(file, `${JSON.stringify(marker)}\n`)
  }

  private progress(kind: BiliInstallKind, progress: number, message: string): void {
    const current = this.views.get(kind)
    this.setView({
      kind,
      state: 'installing',
      progress: clamp01(progress),
      message,
      version: current?.version ?? null,
      updatedAt: current?.updatedAt ?? null
    })
  }

  private missing(kind: BiliInstallKind, message: string): BiliInstallView {
    return {
      kind,
      state: 'missing',
      progress: null,
      message,
      version: null,
      updatedAt: null
    }
  }

  private failed(
    kind: BiliInstallKind,
    message: string,
    code: string
  ): InstallResult {
    this.setView({
      kind,
      state: 'failed',
      progress: null,
      message,
      version: null,
      updatedAt: this.now()
    })
    return { ok: false, code, message }
  }

  private setView(view: BiliInstallView): void {
    this.views.set(view.kind, view)
    this.opts.onChanged?.()
  }

  private installingLabel(): string {
    return this.installing === 'python'
      ? 'Python'
      : this.installing === 'service'
        ? '只读服务'
        : this.installing === 'asr'
          ? '本地转写'
          : '转写模型'
  }

  private runCommand(
    command: string,
    args: string[],
    timeoutMs: number,
    onLine?: (line: string) => void
  ): Promise<RunResult> {
    if (this.disposed) {
      return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false })
    }
    return new Promise((resolve) => {
      const spawnImpl = this.opts.spawnImpl ?? spawn
      let child: ReturnType<typeof spawn>
      try {
        child = spawnImpl(command, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: biliChildEnv({
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
            PYTHONDONTWRITEBYTECODE: '1',
            PIP_DISABLE_PIP_VERSION_CHECK: '1'
          })
        })
      } catch (error) {
        resolve({
          code: null,
          stdout: '',
          stderr: error instanceof Error ? error.message : 'spawn failed',
          timedOut: false
        })
        return
      }
      this.running = child
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      const timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child.pid)
      }, timeoutMs)
      timer.unref?.()
      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.running === child) this.running = null
        resolve({ code, stdout, stderr, timedOut })
      }
      const attach = (stream: NodeJS.ReadableStream | null, target: 'out' | 'err'): void => {
        if (stream === null) return
        stream.setEncoding('utf8')
        let buffer = ''
        stream.on('data', (chunk: string) => {
          if (target === 'out') {
            stdout = (stdout + chunk).slice(-MAX_CAPTURE)
          } else {
            stderr = (stderr + chunk).slice(-MAX_CAPTURE)
          }
          buffer += chunk
          let index = buffer.indexOf('\n')
          while (index >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, '')
            buffer = buffer.slice(index + 1)
            onLine?.(line)
            index = buffer.indexOf('\n')
          }
        })
      }
      attach(child.stdout, 'out')
      attach(child.stderr, 'err')
      child.on('error', (error) => {
        stderr = (stderr + String(error.message)).slice(-MAX_CAPTURE)
        finish(null)
      })
      child.on('close', (code) => finish(code))
    })
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}

function venvPythonPath(dir: string): string {
  return process.platform === 'win32' ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python')
}

function localPythonPath(dir: string): string {
  return process.platform === 'win32' ? join(dir, 'python.exe') : join(dir, 'bin', 'python3')
}

function isAllowedInstallerUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'python.org' || url.hostname.endsWith(INSTALLER_HOST_SUFFIX))
    )
  } catch {
    return false
  }
}

function normalizeModel(value: string): string {
  return ['tiny', 'base', 'small', 'medium'].includes(value) ? value : 'small'
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100))
}

function lastJsonLine(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line !== undefined && line.startsWith('{') && line.endsWith('}')) return line
  }
  return null
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 40) : null
}

function safePackageName(value: string): string {
  const match = /^[A-Za-z0-9_.\-\[\]]{1,60}/.exec(value)
  return match?.[0] ?? '依赖'
}

function versionAtLeast(version: string, min: readonly [number, number]): boolean {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number(part))
  return major > min[0] || (major === min[0] && minor >= min[1])
}
