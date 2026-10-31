import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, parse, resolve } from 'node:path'
import { isPathInside, isSensitivePath, isUncPath, normalizedForCompare } from '../workspace/guard'

export class SystemError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SystemError'
    this.code = code
  }
}

export interface ResolvedOpenTarget {
  real: string
  isDirectory: boolean
  ext: string
}

/** 这些目录对 `sys_open_path` 一律不可见；白名单应用不受此限制。 */
const DENIED_SEGMENTS = new Set([
  'windows',
  'windows.old',
  'program files',
  'program files (x86)',
  'programdata',
  'appdata',
  '$recycle.bin',
  'system volume information',
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  'node_modules'
])

/** 可执行/脚本后缀：只能通过白名单 sys_open_app 启动，不能由 sys_open_path 打开。 */
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe',
  '.com',
  '.bat',
  '.cmd',
  '.ps1',
  '.psm1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.msi',
  '.msp',
  '.msc',
  '.cpl',
  '.scr',
  '.pif',
  '.lnk',
  '.url',
  '.reg',
  '.hta',
  '.jar'
])

/**
 * 脚本宿主/终端不应通过应用白名单获得“任意参数执行”的能力。
 * 参数虽然只来自本地配置，但这条边界让 sys_open_app 永远不成为第二个终端。
 */
const DENIED_APP_NAMES = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
  'rundll32.exe',
  'regsvr32.exe',
  'msiexec.exe',
  'conhost.exe',
  'wt.exe',
  'bash.exe',
  'wsl.exe',
  'python.exe',
  'pythonw.exe',
  'node.exe',
  'java.exe',
  'javaw.exe'
])

const MAX_URL_LENGTH = 2048

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return resolve(homedir(), input.slice(2))
  return input
}

function isDriveLetterPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path)
}

function hasDeniedSegment(path: string): boolean {
  const root = parse(path).root
  const parts = path.slice(root.length).split(/[\\/]+/).filter((part) => part !== '')
  return parts.some((part) => DENIED_SEGMENTS.has(part.toLowerCase()))
}

function assertLocalAbsolute(raw: string, label: string): void {
  if (raw.trim() === '' || raw.includes('\0')) {
    throw new SystemError('SYS_BAD_PATH', `${label}为空或包含非法字符`)
  }
  if (isUncPath(raw)) {
    throw new SystemError('SYS_BAD_PATH', '不允许网络/UNC 路径')
  }
  if (!isAbsolute(raw)) {
    throw new SystemError('SYS_BAD_PATH', '请提供绝对路径')
  }
  if (!isDriveLetterPath(raw)) {
    throw new SystemError('SYS_BAD_PATH', '只允许本机磁盘路径')
  }
  const rest = raw.slice(parse(raw).root.length)
  // NTFS 备用数据流（file.txt:secret）不在这里处理。
  if (rest.includes(':')) {
    throw new SystemError('SYS_BAD_PATH', '不允许备用数据流路径')
  }
}

function realpathOf(raw: string): string {
  try {
    return realpathSync.native(raw)
  } catch {
    throw new SystemError('SYS_NOT_FOUND', '路径不存在或不可访问')
  }
}

/**
 * `sys_open_path` 的守卫：只允许本机磁盘上的普通文件或目录，拒绝系统目录、
 * 用户 AppData、密钥文件、可执行/脚本和 UNC。绝不做路径拼接或 shell 展开。
 */
export function resolveOpenTarget(input: string, deniedRoots: string[] = []): ResolvedOpenTarget {
  const raw = expandHome(input)
  assertLocalAbsolute(raw, '路径')
  const real = realpathOf(raw)
  assertLocalAbsolute(real, '真实路径')
  if (parse(real).root === real) {
    throw new SystemError('SYS_BAD_PATH', '不能直接打开磁盘根目录')
  }
  if (isSensitivePath(real)) {
    throw new SystemError('SYS_SENSITIVE', '该文件属于敏感文件，已拒绝')
  }
  if (hasDeniedSegment(real)) {
    throw new SystemError('SYS_DENIED', '该路径属于系统/应用数据等敏感位置，已拒绝')
  }
  if (deniedRoots.some((root) => root.trim() !== '' && isPathInside(root, real))) {
    throw new SystemError('SYS_DENIED', '该路径属于应用数据目录，已拒绝')
  }
  let stat
  try {
    stat = statSync(real)
  } catch {
    throw new SystemError('SYS_NOT_FOUND', '路径不存在或不可访问')
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new SystemError('SYS_NOT_FILE', '只能打开普通文件或目录')
  }
  const ext = stat.isFile() ? extname(real).toLowerCase() : ''
  if (ext !== '' && EXECUTABLE_EXTENSIONS.has(ext)) {
    throw new SystemError(
      'SYS_EXECUTABLE_DENIED',
      '可执行文件和脚本只能通过白名单应用启动，不能由 sys_open_path 打开'
    )
  }
  return { real, isDirectory: stat.isDirectory(), ext }
}

/**
 * 白名单应用路径校验。只有设置页写入的 appId 才能到达这里；
 * 模型永远不能传路径。realpath 后启动，避免符号链接在审批后指向别处。
 */
export function validateAppPath(input: string): { real: string; ext: string } {
  const raw = expandHome(input)
  assertLocalAbsolute(raw, '应用路径')
  const real = realpathOf(raw)
  assertLocalAbsolute(real, '应用真实路径')
  if (isSensitivePath(real)) {
    throw new SystemError('SYS_SENSITIVE', '该文件属于敏感文件，拒绝作为应用启动')
  }
  const name = basename(real).toLowerCase()
  if (DENIED_APP_NAMES.has(name)) {
    throw new SystemError('SYS_APP_DENIED', '脚本宿主/解释器不能加入应用白名单')
  }
  let stat
  try {
    stat = statSync(real)
  } catch {
    throw new SystemError('SYS_NOT_FOUND', '应用不存在或不可访问')
  }
  if (!stat.isFile()) throw new SystemError('SYS_NOT_FILE', '应用路径不是普通文件')
  const ext = extname(real).toLowerCase()
  if (ext !== '.exe' && ext !== '.com') {
    throw new SystemError('SYS_APP_DENIED', '只允许启动 .exe / .com 应用')
  }
  return { real, ext }
}

/** 只允许 http/https，且拒绝 URL 内嵌凭据。 */
export function validateOpenUrl(input: string): URL {
  const raw = input.trim()
  if (raw === '' || raw.length > MAX_URL_LENGTH) {
    throw new SystemError('SYS_BAD_URL', `链接为空或超过 ${MAX_URL_LENGTH} 字符`)
  }
  if (raw.includes('\0') || /[\r\n]/.test(raw)) {
    throw new SystemError('SYS_BAD_URL', '链接包含非法字符')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SystemError('SYS_BAD_URL', '不是合法的 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SystemError('SYS_BAD_URL', '只允许 http/https 链接')
  }
  if (url.username !== '' || url.password !== '') {
    throw new SystemError('SYS_BAD_URL', '链接中不能包含用户名或密码')
  }
  if (url.hostname === '') {
    throw new SystemError('SYS_BAD_URL', '链接缺少主机名')
  }
  return url
}

/** 审计只用 origin；路径与查询串可能含令牌，不写日志。 */
export function auditUrl(url: URL): string {
  return `${url.protocol}//${url.host}`
}

export function systemErrorMessage(error: unknown): string {
  return messageOf(error)
}

export function normalizedPath(path: string): string {
  return normalizedForCompare(path)
}
