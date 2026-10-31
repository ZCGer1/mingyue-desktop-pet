/**
 * 域名规范化与匹配（不依赖 Electron）。
 *
 * 授权、站点排除和浏览器导航共用同一套规则：精确域名或点边子域命中，
 * 不做“相似就行”的猜测。URL 解析失败一律返回 null，由调用方 fail closed。
 */

export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let value = raw.trim().toLowerCase()
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0] ?? ''
  value = value.replace(/:\d+$/, '').replace(/\.$/, '')
  if (value === '' || value.length > 253 || value.includes('..')) return null
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
    return null
  }
  return value
}

export function normalizeDomainPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  const wildcard = trimmed.startsWith('*.')
  const base = normalizeDomain(wildcard ? trimmed.slice(2) : trimmed)
  if (base === null) return null
  return wildcard ? `*.${base}` : base
}

export function domainMatches(pattern: string, domain: string): boolean {
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2)
    return domain.endsWith(`.${base}`)
  }
  return domain === pattern || domain.endsWith(`.${pattern}`)
}

/** 任一模式命中即返回 true；坏模式被忽略（调用方对“排除列表”按不扩大处理）。 */
export function domainMatchesAny(patterns: readonly string[], target: unknown): boolean {
  const domain = normalizeDomain(target)
  if (domain === null) return false
  for (const raw of patterns) {
    const pattern = normalizeDomainPattern(raw)
    if (pattern !== null && domainMatches(pattern, domain)) return true
  }
  return false
}

export function domainFromUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return normalizeDomain(url.hostname)
  } catch {
    return null
  }
}
