import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path'
import { isPathInside, normalizedForCompare } from '../../shared/path'

export { isPathInside, normalizedForCompare }

export class WorkspaceError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
  }
}

export interface ResolvedWorkspacePath {
  /** 未解析符号链接的规范化绝对路径。 */
  abs: string
  /** 最近存在父目录 realpath + 剩余段；用于越界判断。 */
  real: string
  /** 相对实际根目录（主工作区/信任目录/笔记目录），使用 `/`。 */
  rel: string
  /** 实际解析根；笔记空间中为笔记目录。 */
  root: string
  /** 是否通过 `notes/` 别名解析到笔记目录。 */
  isNotes: boolean
  /** 对外展示路径：普通空间为 `<rel>`/`.`，笔记空间为 `notes/<rel>`。 */
  display: string
  exists: boolean
  isDirectory: boolean
  isFile: boolean
  isSymbolicLink: boolean
}

interface GuardOptions {
  getRoot: () => string
  /** 用户显式选择的笔记目录；只通过 `notes/` 别名访问。 */
  getNotesRoot?: () => string
  /** 用户在设置里显式追加的信任目录；只允许绝对路径访问，不改变默认根。 */
  getExtraRoots?: () => string[]
  /** 应用数据目录等必须永远拒绝的路径。 */
  deniedRoots?: () => string[]
}

/** `notes` / `notes/...` / `notes\...`（大小写不敏感）。 */
const NOTES_ALIAS = /^notes(?:[\\/]|$)/i

const SENSITIVE_PATTERNS = [
  /(^|[\\/])\.env($|\.)/i,
  /(^|[\\/])\.env\.example$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|[\\/])id_rsa/i,
  /(^|[\\/])credentials/i,
  /(^|[\\/])secrets?/i,
  /\.pfx$/i,
  /\.p12$/i,
  /(^|[\\/])cookies(\.sqlite)?$/i,
  /(^|[\\/])login data$/i,
  /(^|[\\/])web data$/i
]

export function isSensitivePath(pathOrRel: string): boolean {
  const name = basename(pathOrRel)
  if (/^\.env\.example$/i.test(name)) return false
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(pathOrRel))
}

export function isGitInternal(rel: string): boolean {
  return rel.split(/[\\/]+/).some((part) => part.toLowerCase() === '.git')
}

export function isHeavyDir(rel: string): boolean {
  return rel
    .split(/[\\/]+/)
    .some((part) => ['node_modules', 'dist', 'build', '.next', 'out'].includes(part.toLowerCase()))
}

export function isUncPath(path: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(path)
}

/** 系统目录 / 盘符根 / 用户主目录 / 应用数据目录不能作为工作区。 */
export function isDeniedWorkspaceRoot(root: string, deniedRoots: string[]): boolean {
  if (root.trim() === '' || isUncPath(root)) return true
  let real: string
  try {
    real = realpathSync.native(root)
  } catch {
    return true
  }
  let stat
  try {
    stat = statSync(real)
  } catch {
    return true
  }
  if (!stat.isDirectory()) return true

  const compare = normalizedForCompare(real)
  if (compare === normalizedForCompare(parse(real).root)) return true

  const exactDenied = new Set<string>()
  const subtreeDenied = new Set<string>()
  for (const entry of deniedRoots) {
    if (entry.trim() !== '') subtreeDenied.add(normalizedForCompare(entry))
  }
  const env = process.env
  for (const entry of [
    env['WINDIR'],
    env['SystemRoot'],
    env['ProgramFiles'],
    env['ProgramFiles(x86)'],
    env['ProgramW6432'],
    env['ProgramData'],
    env['APPDATA'],
    env['LOCALAPPDATA']
  ]) {
    if (entry !== undefined && entry.trim() !== '') subtreeDenied.add(normalizedForCompare(entry))
  }
  // 用户主目录只有根本身不可作为工作区，其下的项目目录可以。
  if (env['USERPROFILE'] !== undefined && env['USERPROFILE'].trim() !== '') {
    exactDenied.add(normalizedForCompare(env['USERPROFILE']))
  }
  for (const entry of exactDenied) if (compare === entry) return true
  for (const entry of subtreeDenied) if (isPathInside(entry, real)) return true
  return false
}

/**
 * 工作区路径守卫（PLAN.md §4.5）。每次调用都重新计算 realpath，
 * 根目录切换、符号链接/junction 与大小写差异都按当前状态判断。
 */
export class WorkspaceGuard {
  private readonly getRoot: () => string
  private readonly getNotesRoot: () => string
  private readonly getExtraRoots: () => string[]
  private readonly getDeniedRoots: () => string[]

  constructor(opts: GuardOptions) {
    this.getRoot = opts.getRoot
    this.getNotesRoot = opts.getNotesRoot ?? (() => '')
    this.getExtraRoots = opts.getExtraRoots ?? (() => [])
    this.getDeniedRoots = opts.deniedRoots ?? (() => [])
  }

  root(): string {
    const raw = this.getRoot().trim()
    if (raw === '') throw new WorkspaceError('WORKSPACE_NOT_SET', '还没有选择工作区目录')
    if (isUncPath(raw)) throw new WorkspaceError('WORKSPACE_ROOT_INVALID', '工作区不能位于 UNC 网络路径')
    let real: string
    try {
      real = realpathSync.native(raw)
    } catch {
      throw new WorkspaceError('WORKSPACE_ROOT_INVALID', '工作区目录不存在或不可访问')
    }
    if (isDeniedWorkspaceRoot(real, this.getDeniedRoots())) {
      throw new WorkspaceError('WORKSPACE_ROOT_INVALID', '该目录不允许作为工作区')
    }
    return real
  }

  /**
   * 笔记目录；未设置/无效/属于应用数据目录时返回 null。
   * 只接受用户显式选择且真实存在的目录。
   */
  notesRootOrNull(): string | null {
    const raw = this.getNotesRoot().trim()
    if (raw === '' || isUncPath(raw)) return null
    let real: string
    try {
      real = realpathSync.native(raw)
      if (!statSync(real).isDirectory()) return null
    } catch {
      return null
    }
    if (isDeniedWorkspaceRoot(real, this.getDeniedRoots())) return null
    return real
  }

  notesRoot(): string {
    const root = this.notesRootOrNull()
    if (root === null) throw new WorkspaceError('NOTES_NOT_SET', '还没有选择笔记目录')
    return root
  }

  /** `input` 可以是相对路径、工作区/信任目录内的绝对路径，或 `notes/...`。 */
  resolve(input: string, opts: { mustExist?: boolean } = {}): ResolvedWorkspacePath {
    const raw = input.trim()
    if (raw === '' || raw.includes('\0')) throw new WorkspaceError('WORKSPACE_BAD_PATH', '路径为空或包含非法字符')
    if (isUncPath(raw)) throw new WorkspaceError('WORKSPACE_BAD_PATH', '不允许 UNC 路径')

    const isNotes = !isAbsolute(raw) && NOTES_ALIAS.test(raw)
    let abs: string
    let root: string
    if (isNotes) {
      // 笔记空间独立于主工作区：即使没有选择工作区，也可以使用 notes/ 别名。
      const notesRoot = this.notesRoot()
      const rest = raw.replace(NOTES_ALIAS, '')
      abs = normalize(resolve(notesRoot, rest))
      if (!isPathInside(notesRoot, abs)) {
        throw new WorkspaceError('WORKSPACE_NOTES_OUTSIDE', '笔记路径不能跳出笔记目录')
      }
      root = notesRoot
    } else {
      const mainRoot = this.root()
      abs = normalize(isAbsolute(raw) ? raw : resolve(mainRoot, raw))
      root = mainRoot
      if (!isPathInside(mainRoot, abs)) {
        const extra = this.extraRoots().find((entry) => isPathInside(entry, abs))
        if (extra === undefined) throw new WorkspaceError('WORKSPACE_OUTSIDE', '路径不在工作区内')
        root = extra
      }
    }

    this.assertNotDenied(abs)

    const exists = existsSync(abs)
    const rel = relative(root, abs).split(sep).join('/')
    if (opts.mustExist === true && !exists) {
      throw new WorkspaceError('WORKSPACE_NOT_FOUND', `找不到：${displayFor(isNotes, rel)}`)
    }

    let real: string
    let isDirectory = false
    let isFile = false
    let isSymbolicLink = false
    if (exists) {
      try {
        const lstat = lstatSync(abs)
        isSymbolicLink = lstat.isSymbolicLink()
        real = realpathSync.native(abs)
        const stat = statSync(real)
        isDirectory = stat.isDirectory()
        isFile = stat.isFile()
      } catch {
        throw new WorkspaceError('WORKSPACE_BAD_PATH', '无法解析路径')
      }
    } else {
      real = this.realForMissing(abs)
    }

    if (!isPathInside(root, real)) {
      throw new WorkspaceError('WORKSPACE_SYMLINK_ESCAPE', '路径通过符号链接/junction 跳出了工作区')
    }
    this.assertNotDenied(real)

    return {
      abs,
      real,
      rel,
      root,
      isNotes,
      display: displayFor(isNotes, rel),
      exists,
      isDirectory,
      isFile,
      isSymbolicLink
    }
  }

  /** 确保路径可以被写/删/移：根目录与 `.git/` 内部只读。 */
  assertMutable(resolved: ResolvedWorkspacePath): void {
    if (resolved.rel === '') throw new WorkspaceError('WORKSPACE_ROOT_READONLY', '根目录本身不可修改')
    if (isGitInternal(resolved.rel)) {
      throw new WorkspaceError('WORKSPACE_GIT_READONLY', '.git/ 内部默认只读')
    }
  }

  assertNotDenied(path: string): void {
    for (const denied of this.getDeniedRoots()) {
      if (denied.trim() === '') continue
      if (isPathInside(denied, path)) {
        throw new WorkspaceError('WORKSPACE_APP_DATA', '该路径属于应用数据目录，工作区工具永远不能访问')
      }
    }
  }

  /** 解析并过滤用户配置的信任目录；无效/系统/应用数据目录会被忽略。 */
  private extraRoots(): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of this.getExtraRoots()) {
      const value = raw.trim()
      if (value === '' || isUncPath(value)) continue
      let real: string
      try {
        real = realpathSync.native(value)
        if (!statSync(real).isDirectory()) continue
      } catch {
        continue
      }
      if (isDeniedWorkspaceRoot(real, this.getDeniedRoots())) continue
      const compare = normalizedForCompare(real)
      if (seen.has(compare)) continue
      seen.add(compare)
      out.push(real)
    }
    return out
  }

  /** 对外展示路径；绝不把笔记目录的绝对路径暴露给模型。 */
  displayFor(resolved: ResolvedWorkspacePath): string {
    return resolved.display
  }

  /** 对尚不存在的目标：取最近存在的祖先 realpath，再把剩余段拼回去。 */
  private realForMissing(path: string): string {
    let current = path
    for (let i = 0; i < 64; i += 1) {
      if (existsSync(current)) {
        try {
          const realAncestor = realpathSync.native(current)
          return join(realAncestor, relative(current, path))
        } catch {
          break
        }
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    throw new WorkspaceError('WORKSPACE_BAD_PATH', '无法解析目标路径的父目录')
  }
}

function displayFor(isNotes: boolean, rel: string): string {
  if (isNotes) return rel === '' ? 'notes' : `notes/${rel}`
  return rel === '' ? '.' : rel
}
