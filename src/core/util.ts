import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Clock } from './types'

export const systemClock: Clock = { now: () => Date.now() }

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === 'AbortError' || error.message === 'aborted')) ||
    (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError')
  )
}

/** 原子写：先写 .tmp 再 rename。 */
export function atomicWrite(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

/**
 * 粗略 token 估算：CJK 字符约 1 token/字，其他约 1 token/4 字符。
 * 只用于软阈值与上下文裁剪，不作为计费依据。
 */
export function estimateTokens(text: string): number {
  if (text === '') return 0
  let cjk = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1
    }
  }
  const other = text.length - cjk
  return Math.ceil(cjk + other / 4) + 2
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-***'],
  [/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1***'],
  // URL 里的用户名/密码（含 baseUrl 被写进错误消息的情况）。
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***@'],
  [/(api[_-]?key\s*[=:]\s*)[^\s"',}]+/gi, '$1***'],
  [/(password\s*[=:]\s*)[^\s"',}]+/gi, '$1***']
]

/** 日志脱敏：移除密钥形态的字符串。 */
export function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]'
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactObject(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (/key|token|secret|password|authorization/i.test(key) && typeof item === 'string') {
        out[key] = '***'
      } else {
        out[key] = redactObject(item, depth + 1)
      }
    }
    return out
  }
  return value
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`
}

/** 带时区的 ISO 8601 时间戳。 */
export function isoNow(now = Date.now()): string {
  const date = new Date(now)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const pad = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
  return `${local}${sign}${pad(offset / 60)}:${pad(offset % 60)}`
}

export function dateKey(now: number, timezoneOffsetMinutes = new Date(now).getTimezoneOffset()): string {
  return new Date(now - timezoneOffsetMinutes * 60000).toISOString().slice(0, 10)
}

export function minutesOfDay(now: number): number {
  const date = new Date(now)
  return date.getHours() * 60 + date.getMinutes()
}

/** 解析 "HH:MM" 为当天分钟数。 */
export function parseClockTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/** 判断当前分钟是否位于 [start,end) 的静音时段内（支持跨午夜）。 */
export function inQuietHours(now: number, quietHours: [string, string]): boolean {
  const start = parseClockTime(quietHours[0])
  const end = parseClockTime(quietHours[1])
  if (start === null || end === null) return false
  const current = minutesOfDay(now)
  if (start === end) return false
  if (start < end) return current >= start && current < end
  return current >= start || current < end
}

export function shortHash(text: string): string {
  // FNV-1a 32-bit，足够做本地变更检测（不是密码学哈希）。
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function safeJsonParse<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export function withJitter(ms: number, ratio = 0.2): number {
  const delta = ms * ratio
  return Math.max(0, Math.round(ms - delta + Math.random() * delta * 2))
}
