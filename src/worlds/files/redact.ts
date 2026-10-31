import { redact } from '../../core/util'

export interface RedactedSnippet {
  /** 脱敏后的正文；高置信秘密内容时为 null。 */
  text: string | null
  /** 是否发生了替换。 */
  changed: boolean
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已隐藏私钥]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[已隐藏 AWS Key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[已隐藏 Token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[已隐藏 Token]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏 Key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[已隐藏 Token]'],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)('[^']*'|"[^"]*"|[^\s,;]+)/gi, '$1[已隐藏]'],
  [/(authorization:\s*(?:bearer|basic)\s+)[^\s"']+/gi, '$1[已隐藏]']
]

const HIGH_CONFIDENCE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
]

/**
 * 文件正文进入模型前的本地脱敏。检测到高置信秘密时不分享正文，
 * 只让模型知道「文件存在但内容未共享」。
 */
export function redactSnippet(input: string): RedactedSnippet {
  if (HIGH_CONFIDENCE.some((pattern) => pattern.test(input))) return { text: null, changed: true }
  let text = redact(input)
  let changed = text !== input
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    const next = text.replace(pattern, replacement)
    if (next !== text) changed = true
    text = next
  }
  return { text, changed }
}

/** 只保留可打印文本；NUL 或大段控制字符视为二进制。 */
export function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false
  let control = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i]!
    if (byte === 0) return true
    if (byte < 7 || (byte > 13 && byte < 32)) control += 1
  }
  return control / buffer.length > 0.3
}
