import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'

/**
 * 文件读取与目录列举的共用底层。
 *
 * 这里只做 I/O 和文本判断，不决定某个路径是否在用户授权范围内，也不做
 * 审批、脱敏或错误码映射：调用方必须显式传入大小上限与二进制判断，
 * 并保留自己的范围校验和回执语义。
 */

export type TextFileFailureReason = 'not-file' | 'too-large' | 'binary' | 'read-failed'

export type TextFileReadResult =
  | {
      ok: true
      buffer: Buffer
      text: string
      size: number
      mtimeMs: number
    }
  | { ok: false; reason: 'not-file' }
  | { ok: false; reason: 'too-large'; size: number }
  | { ok: false; reason: 'binary'; size: number }
  | { ok: false; reason: 'read-failed'; error: unknown }

export interface ReadTextOptions {
  maxBytes: number
  /** 例如 `buffer.includes(0)` 或更严格的二进制探测；不传表示不做判断。 */
  isBinary?: (buffer: Buffer) => boolean
  stripBom?: boolean
}

export function readTextFile(path: string, options: ReadTextOptions): TextFileReadResult {
  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    return { ok: false, reason: 'read-failed', error }
  }
  if (!stat.isFile()) return { ok: false, reason: 'not-file' }
  if (stat.size > options.maxBytes) return { ok: false, reason: 'too-large', size: stat.size }

  let buffer: Buffer
  try {
    buffer = readFileSync(path)
  } catch (error) {
    return { ok: false, reason: 'read-failed', error }
  }
  // 统计与读取之间文件可能变大；以实际读到的长度为准再检查一次。
  if (buffer.length > options.maxBytes) {
    return { ok: false, reason: 'too-large', size: buffer.length }
  }
  if (options.isBinary?.(buffer) === true) {
    return { ok: false, reason: 'binary', size: buffer.length }
  }
  let text = buffer.toString('utf8')
  if (options.stripBom === true && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return { ok: true, buffer, text, size: buffer.length, mtimeMs: stat.mtimeMs }
}

export type DirectoryListing =
  | { ok: true; entries: Dirent[] }
  | { ok: false; error: unknown }

export function listDirectoryEntries(path: string): DirectoryListing {
  try {
    return { ok: true, entries: readdirSync(path, { withFileTypes: true }) }
  } catch (error) {
    return { ok: false, error }
  }
}

export function sortDirectoryEntries(
  entries: readonly Dirent[],
  options: { directoriesFirst?: boolean } = {}
): Dirent[] {
  return [...entries].sort((a, b) => {
    if (options.directoriesFirst === true && a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })
}

export interface TextLineMatch {
  line: number
  text: string
}

/**
 * 按行做子串搜索（不解析正则）。大小写策略由调用方显式选择：
 * Files 搜索不区分大小写，Workspace 内容搜索保持原样。
 */
export function findTextLines(
  text: string,
  query: string,
  options: { caseSensitive?: boolean; max?: number } = {}
): TextLineMatch[] {
  const needle = options.caseSensitive === false ? query.toLowerCase() : query
  if (needle === '') return []
  const max = options.max ?? Number.POSITIVE_INFINITY
  const out: TextLineMatch[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const haystack = options.caseSensitive === false ? line.toLowerCase() : line
    if (!haystack.includes(needle)) continue
    out.push({ line: index + 1, text: line })
    if (out.length >= max) break
  }
  return out
}
