/** 兴趣/经历/探索记录共用的脱敏与字段校验。 */

export type CompanionTargetKind = 'file' | 'window' | 'page' | 'web' | 'note' | 'app'

const SECRET_SHAPES: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/gi, ' '],
  [/(?:authorization\s*:\s*bearer\s+)\S+/gi, ' '],
  [/(?:api[_-]?key|password|passwd|pwd|secret|token)\s*[=:]\s*\S+/gi, ' '],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, ' ']
]

/**
 * 单行、去 URL、去绝对路径/UNC、去密钥形态、限长。
 * 用于兴趣标题/事实/问题/下一步、经历摘要等所有会被注入提示的自由文本。
 */
export function safeCompanionText(input: unknown, max = 240): string {
  if (typeof input !== 'string') return ''
  let text = input
    .replace(/\r?\n+/g, ' ')
    // 控制字符（含零宽/双向控制符）一律不进入持久记录。
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁯]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\\\\[^\s，。；;,]+/g, ' ')
    .replace(/[A-Za-z]:[\\/][^\s，。；;,]*/g, ' ')
    // 以 / 开头的整段按绝对路径处理；notes/... 相对路径不受影响。
    .replace(/(^|\s)\/[^\s，。；;,]+/g, ' ')
  for (const [pattern, replacement] of SECRET_SHAPES) text = text.replace(pattern, replacement)
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > max) text = text.slice(0, max).trimEnd()
  return text
}

/** 只接受 `notes/...` 相对路径；用于“她的作品”挂载。 */
export function safeNoteArtifact(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const path = input.replace(/\\/g, '/').trim()
  if (!/^notes\//i.test(path)) return null
  return safeRelativePath(path, 200)
}

/**
 * 相对路径（例如 `notes/潮汐.md`、`docs/a.txt`）。
 * 绝对路径、盘符、UNC、`..` 逃逸与空段一律拒绝。
 */
export function safeRelativePath(input: unknown, max = 200): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (raw === '' || raw.length > max) return null
  if (raw.startsWith('/') || raw.startsWith('//')) return null
  if (/^[A-Za-z]:/.test(raw)) return null
  if (raw.split('/').some((part) => part === '' || part === '.' || part === '..')) return null
  if (raw.split('/').some((part) => part.includes(':') || part.startsWith('/'))) return null
  return raw
}

/** 域名只保留 host，不保留 scheme/path/query。 */
export function safeDomainRef(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (raw === '') return null
  let host = raw
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      host = new URL(raw).hostname
    } catch {
      return null
    }
  }
  host = host.toLowerCase().replace(/\.$/, '')
  if (host.length < 3 || host.length > 253) return null
  if (!/^[a-z0-9.-]+$/.test(host)) return null
  if (!host.includes('.')) return null
  if (host.split('.').some((part) => part === '' || part.length > 63)) return null
  return host
}

/** 内容指纹：FNV 短哈希或浏览器内容哈希，只允许字母数字/冒号/下划线/连字符。 */
export function safeFingerprint(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!/^[A-Za-z0-9:_-]{4,80}$/.test(value)) return null
  return value
}

export function safeToolName(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  return /^[a-z][a-z0-9_]{0,39}$/i.test(value) ? value : null
}

/** 解析后的 targetRef；窗口/应用只保留安全短标签，不保留标题原文。 */
export function safeTargetRef(kind: string, input: unknown): string | null {
  switch (kind) {
    case 'file':
    case 'note':
      return safeRelativePath(input, 200)
    case 'page':
    case 'web':
      return safeDomainRef(input)
    case 'window':
    case 'app': {
      const label = safeCompanionText(input, 60)
      return label === '' ? null : label
    }
    default:
      return null
  }
}
