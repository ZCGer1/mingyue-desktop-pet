import { lstatSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path'
import type { AppConfig } from '../../shared/config'
import { effectiveExploration } from '../../shared/exploration'
import { isInsideArtifactRoot } from '../../core/explorationGuard'
import { volumeScopeAllowsVolumes, type FileScopeView } from '../../shared/fileScope'
import {
  isPathInside,
  isSensitivePath,
  isUncPath,
  normalizedForCompare
} from '../workspace/guard'
import { FileScopeResolver, type EffectiveFileScope } from './scope'
import type { VolumeReader } from './volumes'

export class FilesError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'FilesError'
    this.code = code
  }
}

/** 目录/文件通用的解析结果；只在本进程内使用，不写入日志或事件。 */
export interface ResolvedPath {
  real: string
  name: string
  ext: string
  isFile: boolean
  isDirectory: boolean
  bytes: number
  mtimeMs: number
  isSymbolicLink: boolean
}

export interface ResolvedWriteTarget {
  real: string
  exists: boolean
  isFile: boolean
  /** 目标落在她的作品目录内。 */
  inArtifact: boolean
  /** 目标落在显式编辑授权内的用户目录。 */
  inEditable: boolean
}

interface GuardOptions {
  getConfig: () => AppConfig
  /** 应用数据目录等永远拒绝的路径。 */
  deniedRoots?: () => string[]
  /** 主进程唯一的卷清单；卷事实由它提供。 */
  volumes?: VolumeReader | null
  /** 与 FilesWorld/CapabilityStore 共用的有效范围解析器。 */
  scope?: FileScopeResolver
}

/**
 * 永远不进入的敏感目录（凭据、系统保护目录）。它们不是“没有权限”的
 * 统称：`.git`、`node_modules` 等重目录只在扫描时按性能默认跳过，
 * 仍可被明确分页读取，见 `isHeavyDirectory`。
 */
const DENIED_SEGMENTS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  'system volume information',
  '$recycle.bin',
  'windows.old'
])

/** 体积大/重扫描目录：目录列表仍可见，默认不递归；明确指定时按预算读取。 */
const HEAVY_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'bower_components',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.gradle',
  '.m2',
  'target',
  'dist',
  'build',
  'out'
])

const DENIED_NAME_PATTERNS = [
  /^\.env(\.|$)/i,
  /\.(pem|key|pfx|p12|kdbx|ovpn|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^credentials(\..*)?$/i,
  /^(cookies|login data|web data|local state)$/i,
  /^(wallet\.dat|\.netrc|\.npmrc|\.pypirc|\.git-credentials)$/i,
  /^secrets?(\..*)?$/i
]

function wildcardSegment(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * FilesWorld 的只读路径守卫。每次调用都按当前配置与 realpath 重新判断，
 * 符号链接/junction 逃逸、UNC、系统目录、浏览器数据、密钥文件都会被拒绝。
 */
export class FilesGuard {
  private readonly getConfig: () => AppConfig
  private readonly getDeniedRoots: () => string[]
  private readonly volumes: VolumeReader | null
  private readonly scopeResolver: FileScopeResolver
  private deniedCache: string[] | null = null

  constructor(opts: GuardOptions) {
    this.getConfig = opts.getConfig
    this.getDeniedRoots = opts.deniedRoots ?? (() => [])
    this.volumes = opts.volumes ?? null
    this.scopeResolver =
      opts.scope ??
      new FileScopeResolver({
        getConfig: this.getConfig,
        volumes: this.volumes,
        deniedRoots: this.getDeniedRoots
      })
  }

  // ------------------------------------------------------------------
  // 主动文件探索：连续读取、目录树、搜索与作品写入
  // ------------------------------------------------------------------

  /**
   * 主动探索的只读根，来自唯一的 FileScopeResolver：
   * 工作区 ∪ 笔记 ∪ 作品 ∪ 信任目录 ∪ 文件显式目录 ∪ 自由探索显式目录
   * ∪ 已授权个人目录 ∪ 当前磁盘模式涵盖且实际可读的卷根。
   *
   * 不可用目录、离线卷和枚举失败不会清空其他候选；失败项只在范围视图里
   * 标注原因。逐文件敏感名/符号链接逃逸仍由本类继续检查。
   */
  readScopeRoots(): string[] {
    return this.fileScope().readRoots
  }

  /**
   * 明确允许连续编辑的根。它与只读范围解耦：
   * - 不包含任何自动发现的卷根（含“全部已挂载磁盘”模式）；
   * - 不包含仅因 includeProfile 加入的用户主目录（除非旧配置明确开启）；
   * - 作品目录仍由 `resolveWrite` 单独放行。
   */
  editScopeRoots(): string[] {
    return this.fileScope().editRoots
  }

  /**
   * 只做路径规范化，供能力目标解析使用；范围/敏感名仍由 CapabilityStore
   * 和实际工具处理。这样“范围外”会得到明确的 path-outside-scope，而不是
   * 被混成“无法解析目标”。不存在的路径仍返回 null。
   */
  capabilityTargetPath(input: string): string | null {
    try {
      const raw = this.readPath(input)
      return realpathSync.native(raw)
    } catch {
      return null
    }
  }

  /** 当前有效文件范围（执行路径共用；含不可用项与原因）。 */
  fileScope(): EffectiveFileScope {
    return this.scopeResolver.resolve()
  }

  /** 设置页/能力卡片用的同一版本范围快照。 */
  fileScopeView(): FileScopeView {
    return this.scopeResolver.view()
  }

  /** 她的作品目录（已 realpath）；目录不存在时返回 null，写入 fail closed。 */
  artifactRootReal(): string | null {
    return this.fileScope().artifactRoot
  }

  /** 主动读取：目标必须是已存在且落在只读范围内的普通文件或目录。 */
  resolveRead(input: string): ResolvedPath {
    const raw = this.readPath(input)
    let real: string
    try {
      real = realpathSync.native(raw)
    } catch (error) {
      throw this.fsError(error, '路径不存在或不可访问')
    }
    this.assertDenied(real)
    const roots = this.readScopeRoots()
    if (roots.length === 0) {
      throw new FilesError('FILES_SCOPE_EMPTY', '没有可用的文件读取范围；请先配置工作区或自由探索目录')
    }
    if (!roots.some((root) => isPathInside(root, real))) {
      throw new FilesError('FILES_OUTSIDE', '路径不在授权的文件读取范围内')
    }
    let stat
    try {
      stat = statSync(real)
    } catch (error) {
      throw this.fsError(error, '路径不存在或不可访问')
    }
    let link = false
    try {
      link = lstatSync(raw).isSymbolicLink()
    } catch {
      link = false
    }
    return {
      real,
      name: basename(real),
      ext: extname(real).toLowerCase(),
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      isSymbolicLink: link
    }
  }

  /**
   * 写入目标解析。作品目录内允许新建；作品目录外只有在「连续编辑」开启且
   * 目标位于只读根内、并且已经存在时才允许覆盖。所有路径都先解析最近的
   * 已存在祖先，再拼回缺失段，防止用 junction/符号链接逃逸。
   */
  resolveWrite(input: string, options: { create?: boolean } = {}): ResolvedWriteTarget {
    const raw = this.ordinaryPath(input)
    const existing = this.tryRealpath(raw)
    const real = existing ?? this.realpathMissing(raw)
    this.assertDenied(real)
    const artifactRoot = this.artifactRootReal()
    const inArtifact = artifactRoot !== null && isPathInside(artifactRoot, real)
    const view = effectiveExploration(this.getConfig())
    // 只读范围（包括新加入的非系统卷）不能因为 edits=true 自动变成可写；
    // 编辑仍只落在用户此前明确的目录内。
    const inEditable =
      view.active &&
      view.edits &&
      this.editScopeRoots().some((root) => isPathInside(root, real))
    if (!inArtifact && !inEditable) {
      throw new FilesError(
        'FILES_OUTSIDE',
        artifactRoot === null
          ? '作品目录不可用，且目标不在显式编辑授权的目录内'
          : '目标不在她的作品目录内，且没有该目录的连续编辑授权'
      )
    }
    if (!inArtifact && existing === null) {
      throw new FilesError('FILES_OUTSIDE', '用户目录内只允许修改已存在的文件，不能新建')
    }
    if (!inArtifact && !view.edits) {
      throw new FilesError('FILES_EDITS_DISABLED', '用户原始文件的连续编辑授权未开启')
    }
    if (options.create === false && existing === null) {
      throw new FilesError('FILES_NOT_FOUND', '目标文件不存在')
    }
    let stat = null
    if (existing !== null) {
      try {
        stat = statSync(existing)
      } catch {
        throw new FilesError('FILES_NOT_FOUND', '目标不可访问')
      }
      if (stat.isDirectory()) throw new FilesError('FILES_IS_DIRECTORY', '目标是目录，不是文件')
    }
    return {
      real,
      exists: existing !== null,
      isFile: stat === null ? false : stat.isFile(),
      inArtifact: inArtifact && isInsideArtifactRoot(view, real),
      inEditable: inEditable && !inArtifact
    }
  }

  /** 创建一个目录；只允许在作品目录内（或显式编辑目录内新建子目录）。 */
  resolveMkdir(input: string): { real: string; exists: boolean } {
    const target = this.resolveWrite(input, { create: true })
    if (target.exists) {
      if (target.isFile) throw new FilesError('FILES_IS_FILE', '同名文件已存在')
      return { real: target.real, exists: true }
    }
    if (!target.inArtifact && !target.inEditable) {
      throw new FilesError('FILES_OUTSIDE', '不能在未授权目录创建文件夹')
    }
    return { real: target.real, exists: false }
  }

  /**
   * 目录遍历用：不做 realpath，只做范围与敏感名判断。
   * `knownRoots` 由调用方传入，避免对每个条目重新 realpath 所有根；
   * 省略时使用当前统一文件范围的有效只读根。
   */
  isAllowedPath(path: string, knownRoots?: string[]): boolean {
    if (isSensitivePath(path)) return false
    if (this.hasDeniedSegment(path)) return false
    if (this.isDeniedByConfig(path)) return false
    const roots = knownRoots ?? this.readScopeRoots()
    return roots.some((root) => isPathInside(root, path))
  }

  isDeniedDirectory(path: string): boolean {
    if (this.isDeniedByConfig(path)) return true
    return this.hasDeniedSegment(path)
  }

  /**
   * 重目录只在默认递归/搜索时跳过，不是“无权限”。模型可以直接把
   * `files_list/files_tree/files_search` 的 path 指到这些目录里继续读。
   */
  isHeavyDirectory(path: string): boolean {
    const parts = path.split(/[\\/]+/).filter((part) => part !== '')
    return parts.some((part) => HEAVY_SEGMENTS.has(part.toLowerCase()))
  }

  /** 把 Windows 拒绝访问、卷离线与普通不存在区分开，便于模型如实说明。 */
  static fsErrorCode(error: unknown): string {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (code === 'EACCES' || code === 'EPERM') return 'FILES_ACCESS_DENIED'
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENODEV' || code === 'EIO') {
      return 'FILES_UNAVAILABLE'
    }
    if (code === 'EBUSY') return 'FILES_BUSY'
    return 'FILES_READ_FAILED'
  }

  static fsErrorMessage(error: unknown, fallback: string): string {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (code === 'EACCES' || code === 'EPERM') {
      return 'Windows 拒绝访问这个位置；不会自动提权或修改 ACL'
    }
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return '路径不存在、已卸载或所在卷当前离线'
    }
    if (code === 'ENODEV' || code === 'EIO') return '卷不可用或已断开'
    if (code === 'EBUSY') return '文件或目录正被其他程序占用'
    return fallback
  }

  private fsError(error: unknown, fallback: string): FilesError {
    return new FilesError(FilesGuard.fsErrorCode(error), FilesGuard.fsErrorMessage(error, fallback))
  }

  private ordinaryPath(input: string): string {
    const raw = this.expandHome(input.trim())
    if (raw === '' || raw.includes('\0')) {
      throw new FilesError('FILES_BAD_PATH', '路径为空或包含非法字符')
    }
    if (isUncPath(raw)) throw new FilesError('FILES_BAD_PATH', '不允许 UNC 网络路径')
    if (!isAbsolute(raw)) throw new FilesError('FILES_BAD_PATH', '请提供绝对路径')
    return raw
  }

  /**
   * 读取路径：已挂载且授权的网络卷 UNC 会映射到本地挂载点；
   * 任意陌生 UNC 仍然拒绝，不触发新网络连接或凭据获取。
   */
  private readPath(input: string): string {
    const expanded = this.expandHome(input.trim())
    if (expanded === '' || expanded.includes('\0')) {
      throw new FilesError('FILES_BAD_PATH', '路径为空或包含非法字符')
    }
    let raw = expanded
    if (isUncPath(raw)) {
      const view = effectiveExploration(this.getConfig())
      const mapped =
        view.active && view.fileRead && volumeScopeAllowsVolumes(view.volumeScope)
          ? (this.volumes?.mapAuthorizedUnc(raw) ?? null)
          : null
      if (mapped === null) {
        throw new FilesError('FILES_BAD_PATH', '该 UNC 网络路径未映射到已授权且已挂载的卷')
      }
      raw = mapped
    }
    if (!isAbsolute(raw)) throw new FilesError('FILES_BAD_PATH', '请提供绝对路径')
    this.volumes?.refreshInBackground()
    return raw
  }

  private assertDenied(real: string): void {
    if (isSensitivePath(real)) throw new FilesError('FILES_SENSITIVE', '该路径属于敏感文件，已拒绝')
    if (this.isDeniedByConfig(real)) throw new FilesError('FILES_DENIED', '该路径属于敏感位置，已拒绝')
    if (this.hasDeniedSegment(real)) {
      throw new FilesError('FILES_DENIED', '该路径包含不允许访问的目录')
    }
  }

  private tryRealpath(path: string): string | null {
    try {
      return realpathSync.native(path)
    } catch {
      return null
    }
  }

  /** 解析不存在的目标：找到最近的真实祖先，再把缺失段拼回去。 */
  private realpathMissing(path: string): string {
    let current = resolve(path)
    const missing: string[] = []
    for (let guard = 0; guard < 64; guard += 1) {
      const real = this.tryRealpath(current)
      if (real !== null) {
        let stat
        try {
          stat = statSync(real)
        } catch {
          throw new FilesError('FILES_NOT_FOUND', '目标不可访问')
        }
        if (!stat.isDirectory()) {
          throw new FilesError('FILES_NOT_DIRECTORY', '路径的一部分不是目录')
        }
        return missing.length === 0 ? real : join(real, ...missing)
      }
      const parent = dirname(current)
      if (parent === current) {
        throw new FilesError('FILES_BAD_PATH', '找不到可用的父目录')
      }
      missing.unshift(basename(current))
      current = parent
    }
    throw new FilesError('FILES_BAD_PATH', '路径层级过深')
  }

  private deniedRoots(): string[] {
    if (this.deniedCache !== null) return this.deniedCache
    const out: string[] = []
    const env = process.env
    for (const entry of [
      env['WINDIR'],
      env['SystemRoot'],
      env['ProgramFiles'],
      env['ProgramFiles(x86)'],
      env['ProgramW6432'],
      env['ProgramData'],
      env['APPDATA'],
      env['LOCALAPPDATA'],
      join(homedir(), '.config', 'gcloud'),
      join(homedir(), '.config', 'gh'),
      ...this.getDeniedRoots()
    ]) {
      if (entry !== undefined && entry.trim() !== '') out.push(entry)
    }
    this.deniedCache = out
    return out
  }

  private isDeniedByConfig(path: string): boolean {
    const compare = normalizedForCompare(path)
    if (this.deniedRoots().some((entry) => isPathInside(entry, path))) return true
    for (const pattern of this.getConfig().worlds.files.exclude) {
      const trimmed = pattern.trim()
      if (trimmed === '') continue
      if (isAbsolute(trimmed)) {
        if (isPathInside(trimmed, path)) return true
        continue
      }
      const segments = compare.split(/[\\/]+/).filter((part) => part !== '')
      const matcher = wildcardSegment(trimmed)
      if (segments.some((part) => matcher.test(part))) return true
    }
    return false
  }

  private hasDeniedSegment(path: string): boolean {
    const parts = parse(path)
    const relative = path.slice(parts.root.length).split(/[\\/]+/).filter((part) => part !== '')
    for (const part of relative) {
      if (DENIED_SEGMENTS.has(part.toLowerCase())) return true
      if (DENIED_NAME_PATTERNS.some((pattern) => pattern.test(part))) return true
    }
    return false
  }

  private expandHome(input: string): string {
    if (input === '~') return homedir()
    if (input.startsWith('~/') || input.startsWith('~\\')) return resolve(homedir(), input.slice(2))
    return input
  }
}
