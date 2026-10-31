import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * 浏览器扩展持久化安装器。
 *
 * 打包资源里的 `browser-extension` 只是只读模板；portable 版每次启动都可能
 * 解压到新的临时目录，直接把用户引导到那里，重启后目录消失，浏览器扩展页
 * 就会显示「找不到」。这里把发布文件复制到稳定的应用数据目录：
 *
 *   %APPDATA%/<产品>/browser-extension
 *   或 portable: <真实 exe 目录>/data/browser-extension
 *
 * 只复制扩展发布文件（js/html/css/图片等），绝不复制用户数据、日志、配对
 * 令牌或密钥；不读写 Chrome/Edge 的 Preferences、数据库、策略或注册表。
 * 升级采用暂存 + 校验 + 原地覆盖 + 旧版本备份/回滚，失败时保留上一完整版本。
 */

export interface BrowserExtensionInstallInfo {
  ready: boolean
  path: string
  version: string | null
  hash: string | null
  changed: boolean
  created: boolean
  retryable: boolean
  error: string | null
}

export interface BrowserExtensionManagerOptions {
  /** 打包/开发资源里的只读扩展模板目录。 */
  sourceDir: string
  /** 稳定目标目录（AppPaths.rootDir/browser-extension）。 */
  targetDir: string
  /** 安装元数据目录（AppPaths.dataDir）。 */
  dataDir: string
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void } | null
}

interface InstallMetadata {
  version: 1
  manifestVersion: string
  hash: string
  files: string[]
  /** 上一版本中删除失败、尚未清理的发布文件；下次启动继续尝试。 */
  staleFiles?: string[]
  installedAt: number
  sourceDir: string
}

interface StagedExtension {
  dir: string
  manifestVersion: string
  hash: string
  files: string[]
}

const ALLOWED_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.html',
  '.htm',
  '.css',
  '.md',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.svg',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.wasm'
])

const PRIVATE_FILE = /(^|[._-])(pairing|token|secret|credential|browser-bridge|user-data|userdata)([._-]|$)/i
const PRIVATE_EXTENSION = new Set(['.key', '.pem', '.log', '.sqlite', '.sqlite3', '.db', '.env', '.jsonl'])
const SKIP_DIRECTORIES = new Set([
  'logs',
  'log',
  'user-data',
  'userdata',
  'pairing',
  'keys',
  'secrets',
  'tokens',
  'data',
  'node_modules',
  '.git'
])

const LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EROFS'])

export class BrowserExtensionManager {
  private readonly sourceDir: string
  private readonly targetDir: string
  private readonly dataDir: string
  private readonly logger: BrowserExtensionManagerOptions['logger']
  private readonly metadataPath: string

  constructor(options: BrowserExtensionManagerOptions) {
    this.sourceDir = resolve(options.sourceDir)
    this.targetDir = resolve(options.targetDir)
    this.dataDir = resolve(options.dataDir)
    this.logger = options.logger ?? null
    this.metadataPath = join(this.dataDir, 'browser-extension-install.json')
  }

  /** 幂等：内容未变时不复制、不删除；失败时尽量恢复上一完整版本。 */
  prepare(): BrowserExtensionInstallInfo {
    const previous = this.readMetadata()
    const existingReady = this.validateDirectory(this.targetDir)
    if (!existsSync(this.sourceDir)) {
      const error = `扩展模板目录不存在：${this.sourceDir}`
      return this.resultFromExisting(previous, existingReady, false, false, error, false)
    }

    let staged: StagedExtension
    try {
      staged = this.stageSource()
    } catch (error) {
      const message = this.describeError(error)
      this.logger?.warn('浏览器扩展暂存失败', { error: message })
      return this.resultFromExisting(previous, existingReady, false, false, message, this.isRetryable(error))
    }

    try {
      // 内容完全一致且目标完整：不触碰现有目录，浏览器无需重新载入；
      // 只顺手重试上次删除失败的旧发布文件。
      if (
        previous !== null &&
        previous.hash === staged.hash &&
        existingReady &&
        previous.files.every((file) => existsSync(join(this.targetDir, file)))
      ) {
        this.retryStaleCleanup(previous)
        return this.installInfo(true, previous.manifestVersion, previous.hash, false, false, null, false)
      }

      const created = !existsSync(this.targetDir)
      // 无论目标是否已存在，都必须在应用数据目录内（防止误删/误写任意路径）。
      if (!this.isContained(this.targetDir)) {
        const message = '目标目录不在应用数据目录内'
        this.logger?.warn('浏览器扩展目标目录被拒绝', { targetDir: this.targetDir })
        return this.resultFromExisting(previous, existingReady, false, false, message, false)
      }

      const oldFiles = [...(previous?.files ?? []), ...(previous?.staleFiles ?? [])]
      const oldSet = new Set(oldFiles)
      const preexisting = new Set<string>()
      const temporaryFiles: string[] = []
      let backup: string | null = null
      try {
        mkdirSync(this.targetDir, { recursive: true })
        // 记录复制前已存在的文件（含用户自己的同名文件），回滚时只清理本次新建的。
        for (const file of staged.files) {
          if (existsSync(this.safeJoin(this.targetDir, file))) preexisting.add(file)
        }
        // 升级前备份上一版本（只备份安装器登记过的发布文件）。
        backup = this.backupExisting(previous, existingReady)
        const newSet = new Set(staged.files)
        for (const file of staged.files) {
          const destination = this.safeJoin(this.targetDir, file)
          mkdirSync(dirname(destination), { recursive: true })
          const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`
          temporaryFiles.push(temporary)
          copyFileSync(this.safeJoin(staged.dir, file), temporary)
          renameSync(temporary, destination)
        }
        if (!this.validateDirectory(this.targetDir)) {
          throw new ExtensionInstallError('复制后的扩展未通过校验', false)
        }
        // 只清理安装器登记过的旧文件，绝不删除用户自己放进来的文件。
        // 删除失败的文件继续登记，下次启动重试，避免留下永远无人清理的旧版本。
        const staleFiles = this.removeStaleFiles(oldFiles, newSet)
        const metadata: InstallMetadata = {
          version: 1,
          manifestVersion: staged.manifestVersion,
          hash: staged.hash,
          files: staged.files,
          ...(staleFiles.length > 0 ? { staleFiles } : {}),
          installedAt: Date.now(),
          sourceDir: this.sourceDir
        }
        this.writeMetadata(metadata)
        return this.installInfo(
          true,
          staged.manifestVersion,
          staged.hash,
          true,
          created,
          null,
          false
        )
      } catch (error) {
        // 清理未完成 rename 的临时副本，避免在扩展目录留下 .tmp-* 垃圾。
        for (const temporary of temporaryFiles) {
          try {
            rmSync(temporary, { force: true })
          } catch {
            /* 临时文件清理失败不改变错误结果；下次更新会覆盖。 */
          }
        }
        this.restoreBackup(backup)
        // 失败时移除本次新建、从未登记过的文件；用户原有文件保持不动。
        for (const file of staged.files) {
          if (oldSet.has(file) || preexisting.has(file)) continue
          try {
            rmSync(this.safeJoin(this.targetDir, file), { force: true })
          } catch (cleanupError) {
            this.logger?.warn('回滚时清理本次新增的扩展文件失败', {
              file,
              error: this.describeError(cleanupError)
            })
          }
        }
        const restored = this.validateDirectory(this.targetDir)
        const message = this.describeError(error)
        this.logger?.warn('浏览器扩展更新失败，已尝试恢复上一版本', { error: message, restored })
        return this.resultFromExisting(
          previous,
          restored,
          false,
          false,
          message,
          this.isRetryable(error)
        )
      } finally {
        this.cleanupBackup(backup)
      }
    } finally {
      this.safeRemove(staged.dir)
    }
  }

  /** 验证目标目录是否是完整可加载的 MV3 扩展。 */
  static validate(targetDir: string): boolean {
    return new BrowserExtensionManager({
      sourceDir: targetDir,
      targetDir,
      dataDir: targetDir
    }).validateDirectory(targetDir)
  }

  // -------------------------------------------------------------------------

  private stageSource(): StagedExtension {
    mkdirSync(this.dataDir, { recursive: true })
    const dir = join(
      this.dataDir,
      `browser-extension-staging-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    )
    mkdirSync(dir, { recursive: true })
    try {
      const files = this.collectPublishedFiles(this.sourceDir)
      if (!files.includes('manifest.json')) {
        throw new ExtensionInstallError('扩展模板缺少 manifest.json', false)
      }
      for (const file of files) {
        const destination = this.safeJoin(dir, file)
        mkdirSync(dirname(destination), { recursive: true })
        copyFileSync(this.safeJoin(this.sourceDir, file), destination)
      }
      const validation = this.validateManifest(dir)
      if (validation === null) {
        throw new ExtensionInstallError('扩展模板校验失败', false)
      }
      return {
        dir,
        manifestVersion: validation.version,
        hash: this.hashFiles(dir, files),
        files
      }
    } catch (error) {
      this.safeRemove(dir)
      throw error
    }
  }

  private collectPublishedFiles(root: string): string[] {
    const out: string[] = []
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = entry.name
        if (name.startsWith('.')) continue
        const relativePath = prefix === '' ? name : `${prefix}/${name}`
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (SKIP_DIRECTORIES.has(name.toLowerCase())) continue
          walk(join(dir, name), relativePath)
          continue
        }
        if (!entry.isFile()) continue
        const extension = extname(name).toLowerCase()
        if (!ALLOWED_EXTENSIONS.has(extension)) continue
        if (PRIVATE_EXTENSION.has(extension)) continue
        if (PRIVATE_FILE.test(name)) continue
        // 除 manifest 外不复制任意 JSON，避免把扩展本地设置/缓存带进发布目录。
        if (extension === '.json' && name !== 'manifest.json') continue
        out.push(relativePath)
      }
    }
    walk(root, '')
    return out.sort()
  }

  private validateDirectory(dir: string): boolean {
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return false
      return this.validateManifest(dir) !== null
    } catch {
      return false
    }
  }

  private validateManifest(dir: string): { version: string } | null {
    try {
      const raw = readFileSync(join(dir, 'manifest.json'), 'utf8')
      const manifest = JSON.parse(raw) as Record<string, unknown>
      if (manifest['manifest_version'] !== 3) return null
      const version = typeof manifest['version'] === 'string' ? manifest['version'] : ''
      if (version === '' || version.length > 40) return null
      const background = manifest['background']
      if (background === null || typeof background !== 'object' || Array.isArray(background)) {
        return null
      }
      const worker = (background as Record<string, unknown>)['service_worker']
      if (typeof worker !== 'string' || !this.safeRelativeFile(dir, worker)) return null
      const required = new Set<string>(['manifest.json', worker])

      const action = manifest['action']
      if (action !== null && typeof action === 'object' && !Array.isArray(action)) {
        const popup = (action as Record<string, unknown>)['default_popup']
        if (typeof popup === 'string') required.add(popup)
      }
      const options = manifest['options_ui']
      if (options !== null && typeof options === 'object' && !Array.isArray(options)) {
        const page = (options as Record<string, unknown>)['page']
        if (typeof page === 'string') required.add(page)
      }
      const scripts = manifest['content_scripts']
      if (Array.isArray(scripts)) {
        for (const entry of scripts) {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
          const js = (entry as Record<string, unknown>)['js']
          if (Array.isArray(js)) {
            for (const file of js) if (typeof file === 'string') required.add(file)
          }
          const css = (entry as Record<string, unknown>)['css']
          if (Array.isArray(css)) {
            for (const file of css) if (typeof file === 'string') required.add(file)
          }
        }
      }
      for (const file of required) {
        if (!this.safeRelativeFile(dir, file)) return null
      }
      return { version }
    } catch {
      return null
    }
  }

  private safeRelativeFile(dir: string, file: string): boolean {
    if (file === '' || file.startsWith('/') || file.startsWith('\\') || file.includes('..')) {
      return false
    }
    const path = resolve(dir, file)
    if (!this.isInside(dir, path)) return false
    try {
      return existsSync(path) && statSync(path).isFile()
    } catch {
      return false
    }
  }

  private hashFiles(dir: string, files: string[]): string {
    const hash = createHash('sha256')
    for (const file of files) {
      hash.update(file)
      hash.update('\0')
      hash.update(readFileSync(join(dir, file)))
      hash.update('\0')
    }
    return hash.digest('hex')
  }

  private backupExisting(
    previous: InstallMetadata | null,
    existingReady: boolean
  ): string | null {
    if (!existingReady || previous === null) return null
    const backup = join(
      this.dataDir,
      `browser-extension-backup-${process.pid}-${Date.now()}`
    )
    mkdirSync(backup, { recursive: true })
    for (const file of previous.files) {
      const source = this.safeJoin(this.targetDir, file)
      if (!existsSync(source)) continue
      const destination = this.safeJoin(backup, file)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(source, destination)
    }
    return backup
  }

  /**
   * 删除安装器登记过、且新版本不再包含的文件。失败项返回给调用方继续登记，
   * 由下次启动/更新重试；绝不递归删除未登记的用户文件。
   */
  private removeStaleFiles(files: string[], keep: ReadonlySet<string>): string[] {
    const remaining: string[] = []
    for (const file of files) {
      if (keep.has(file)) continue
      try {
        rmSync(this.safeJoin(this.targetDir, file), { force: true })
      } catch (error) {
        remaining.push(file)
        this.logger?.warn('旧扩展文件暂未清理，将在下次启动重试', {
          file,
          error: this.describeError(error)
        })
      }
    }
    return remaining
  }

  /** 内容未变化的幂等启动：只重试上次失败的旧文件清理。 */
  private retryStaleCleanup(previous: InstallMetadata): void {
    const staleFiles = previous.staleFiles ?? []
    if (staleFiles.length === 0) return
    const remaining = this.removeStaleFiles(staleFiles, new Set())
    if (remaining.length === staleFiles.length) return
    try {
      this.writeMetadata({
        ...previous,
        ...(remaining.length > 0 ? { staleFiles: remaining } : { staleFiles: undefined })
      })
    } catch (error) {
      this.logger?.warn('记录扩展旧文件清理结果失败', { error: this.describeError(error) })
    }
  }

  private restoreBackup(backup: string | null): void {
    if (backup === null) return
    for (const file of this.collectAllFiles(backup)) {
      try {
        const destination = this.safeJoin(this.targetDir, file)
        mkdirSync(dirname(destination), { recursive: true })
        copyFileSync(this.safeJoin(backup, file), destination)
      } catch (error) {
        this.logger?.warn('恢复浏览器扩展旧版本文件失败', {
          file,
          error: this.describeError(error)
        })
      }
    }
  }

  private cleanupBackup(backup: string | null): void {
    if (backup !== null) this.safeRemove(backup)
  }

  private collectAllFiles(root: string): string[] {
    const out: string[] = []
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) walk(join(dir, entry.name), relativePath)
        else if (entry.isFile()) out.push(relativePath)
      }
    }
    if (existsSync(root)) walk(root, '')
    return out.sort()
  }

  private readMetadata(): InstallMetadata | null {
    try {
      const raw = JSON.parse(readFileSync(this.metadataPath, 'utf8')) as Record<string, unknown>
      if (raw['version'] !== 1) return null
      const manifestVersion =
        typeof raw['manifestVersion'] === 'string' ? raw['manifestVersion'].slice(0, 40) : ''
      const hash = typeof raw['hash'] === 'string' ? raw['hash'] : ''
      const files = Array.isArray(raw['files'])
        ? raw['files']
            .filter((file): file is string => typeof file === 'string' && isSafeRelativePath(file))
            .slice(0, 500)
        : []
      if (manifestVersion === '' || hash === '' || files.length === 0) return null
      const staleFiles = Array.isArray(raw['staleFiles'])
        ? raw['staleFiles']
            .filter((file): file is string => typeof file === 'string' && isSafeRelativePath(file))
            .slice(0, 500)
        : []
      return {
        version: 1,
        manifestVersion,
        hash,
        files,
        ...(staleFiles.length > 0 ? { staleFiles } : {}),
        installedAt: typeof raw['installedAt'] === 'number' ? raw['installedAt'] : 0,
        sourceDir: typeof raw['sourceDir'] === 'string' ? raw['sourceDir'] : ''
      }
    } catch {
      return null
    }
  }

  private writeMetadata(metadata: InstallMetadata): void {
    mkdirSync(this.dataDir, { recursive: true })
    const temporary = `${this.metadataPath}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.metadataPath)
  }

  private installInfo(
    ready: boolean,
    version: string | null,
    hash: string | null,
    changed: boolean,
    created: boolean,
    error: string | null,
    retryable: boolean
  ): BrowserExtensionInstallInfo {
    return {
      ready,
      path: this.targetDir,
      version,
      hash,
      changed,
      created,
      retryable,
      error
    }
  }

  private resultFromExisting(
    previous: InstallMetadata | null,
    existingReady: boolean,
    changed: boolean,
    created: boolean,
    error: string | null,
    retryable: boolean
  ): BrowserExtensionInstallInfo {
    if (existingReady) {
      const version = previous?.manifestVersion ?? this.readManifestVersion(this.targetDir)
      const hash = previous?.hash ?? null
      return this.installInfo(true, version, hash, changed, created, error, retryable)
    }
    return this.installInfo(false, null, null, changed, created, error, retryable)
  }

  private readManifestVersion(dir: string): string | null {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >
      return typeof manifest['version'] === 'string' ? manifest['version'] : null
    } catch {
      return null
    }
  }

  private safeJoin(root: string, file: string): string {
    const path = resolve(root, ...file.split('/'))
    if (!this.isInside(root, path)) {
      throw new ExtensionInstallError(`扩展文件路径越界：${file}`, false)
    }
    return path
  }

  private isContained(path: string): boolean {
    return this.isInside(this.dataDir, path) || this.isInside(dirname(this.dataDir), path)
  }

  private isInside(root: string, path: string): boolean {
    const rel = relative(resolve(root), resolve(path))
    if (rel === '') return true
    // 跨盘符时 relative() 会返回绝对路径；它不属于 root 内部。
    if (isAbsolute(rel)) return false
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)
  }

  private safeRemove(path: string): void {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch (error) {
      this.logger?.warn('清理扩展暂存目录失败', { error: this.describeError(error) })
    }
  }

  private isRetryable(error: unknown): boolean {
    return error instanceof ExtensionInstallError
      ? error.retryable
      : LOCK_CODES.has(this.errorCode(error))
  }

  private errorCode(error: unknown): string {
    if (error === null || typeof error !== 'object') return ''
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : ''
  }

  private describeError(error: unknown): string {
    const code = this.errorCode(error)
    if (LOCK_CODES.has(code)) {
      return `扩展文件被占用（${code}）；请关闭正在读取该目录的浏览器扩展页、资源管理器或杀毒软件后重试。`
    }
    if (error instanceof Error) return error.message.slice(0, 300)
    return String(error).slice(0, 300)
  }
}

class ExtensionInstallError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'ExtensionInstallError'
    this.retryable = retryable
  }
}

/** 设置页展示用的简短文件名（不含用户目录）。 */
export function extensionFolderName(path: string): string {
  return basename(path)
}

/** 元数据中只接受扩展目录内的相对发布路径，避免被篡改后越界读写。 */
function isSafeRelativePath(file: string): boolean {
  if (file === '' || file.length > 240) return false
  if (file.startsWith('/') || file.startsWith('\\')) return false
  if (/^[a-zA-Z]:/.test(file)) return false
  const parts = file.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}
