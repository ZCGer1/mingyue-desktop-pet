/**
 * 浏览器页面的二次脱敏。扩展端已经做过一次过滤，但扩展是不可信来源，
 * 主进程必须独立再过滤：域名规范化、域名规则、标题、摘要与标题列表。
 */

import { sanitizeWindowTitle } from '../activity/appIdentity'
import type { BrowserPagePayload } from './types'

const URL_PATTERN = /(?:\b(?:https?|ftp|file):\/\/|\bwww\.)[^\s<>"']+/gi
const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu
const WINDOWS_PATH_PATTERN = /[A-Za-z]:[\\/][^\s<>"'|]*/g
const UNC_PATH_PATTERN = /\\\\[^\s<>"'|\\]+(?:\\[^\s<>"'|\\]*)+/g
const POSIX_PATH_PATTERN = /(?:^|(?<=\s))(?:\/[A-Za-z0-9._-]+){2,}\/?/g
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
// 12 位以上的编号/卡号，以及中国大陆 11 位手机号。
const LONG_DIGITS_PATTERN = /\b(?:\d{12,}|1[3-9]\d{9})\b/g
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_\-+=]{24,}\b/g
const CONTROL_PATTERN = /[\p{Cc}\p{Cf}]/gu

/** 只接受裸域名（可含端口已被去掉），拒绝路径、协议、空白与超长值。 */
export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let domain = raw
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
  domain = domain.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0] ?? ''
  domain = domain.replace(/:\d+$/, '')
  if (domain === '' || domain.length > 253) return null
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) return null
  if (domain.includes('..')) return null
  return domain
}

/**
 * 域名规则匹配：
 * - `example.com` 精确匹配；
 * - `*.example.com` 匹配自身与所有子域名。
 */
export function domainMatches(domain: string, pattern: string): boolean {
  const d = normalizeDomain(domain)
  if (d === null) return false
  const p = pattern.trim().toLowerCase().replace(/\.$/, '')
  if (p === '') return false
  if (p.startsWith('*.')) {
    const base = p.slice(2)
    if (base === '') return false
    return d === base || d.endsWith(`.${base}`)
  }
  return d === p
}

export function matchesAny(domain: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => domainMatches(domain, pattern))
}

export function isDomainAllowed(
  domain: string,
  rules: {
    allowlistOnly: boolean
    allowlist: string[]
    denylist: string[]
    sensitiveDomains: string[]
  }
): boolean {
  if (matchesAny(domain, rules.denylist)) return false
  if (matchesAny(domain, rules.sensitiveDomains)) return false
  if (rules.allowlistOnly && !matchesAny(domain, rules.allowlist)) return false
  return true
}

/** 摘要/标题列表：去控制字符、URL、邮箱、路径与高熵长串，再折叠空白。 */
export function sanitizePageText(raw: unknown, maxChars: number): string | null {
  if (typeof raw !== 'string') return null
  const limit = Math.max(1, Math.round(maxChars))
  let text = raw
    .normalize('NFKC')
    .replace(CONTROL_PATTERN, ' ')
    .replace(URL_PATTERN, ' [链接] ')
    .replace(EMAIL_PATTERN, ' [邮箱] ')
    .replace(WINDOWS_PATH_PATTERN, ' [路径] ')
    .replace(UNC_PATH_PATTERN, ' [路径] ')
    .replace(POSIX_PATH_PATTERN, ' [路径] ')
    .replace(UUID_PATTERN, ' [标识] ')
    .replace(LONG_DIGITS_PATTERN, ' [标识] ')
    .replace(LONG_TOKEN_PATTERN, ' [标识] ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return null
  const chars = Array.from(text)
  if (chars.length > limit) text = `${chars.slice(0, limit).join('')}…`
  return text
}

export function sanitizeHeadings(raw: unknown, maxItems = 8): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const text = sanitizePageText(item, 200)
    if (text === null) continue
    if (out.includes(text)) continue
    out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

export interface SanitizedPage {
  domain: string
  title: string | null
  excerpt: string | null
  headings: string[]
  titleSuppressed: boolean
}

/**
 * 将扩展 payload 规范化为可进入模型上下文的最小页面描述。
 * 返回 null 表示整页被过滤（敏感域名、密码字段、无意义内容）。
 */
export function sanitizePage(
  payload: BrowserPagePayload,
  opts: {
    shareTitle: boolean
    shareExcerpt: boolean
    includeHeadings: boolean
    titleMaxChars: number
    excerptMaxChars: number
  }
): SanitizedPage | null {
  const domain = normalizeDomain(payload.domain)
  if (domain === null) return null
  const sanitizedTitle = opts.shareTitle
    ? sanitizeWindowTitle(payload.title ?? null, { appLabel: domain, maxChars: opts.titleMaxChars })
    : { text: null, suppressed: false }
  const excerpt = opts.shareExcerpt ? sanitizePageText(payload.excerpt, opts.excerptMaxChars) : null
  const headings = opts.includeHeadings ? sanitizeHeadings(payload.headings) : []
  if (sanitizedTitle.text === null && sanitizedTitle.suppressed) {
    // 标题整条命中敏感词，说明页面很可能包含凭据/支付信息；整页不作为描述。
    return null
  }
  if (sanitizedTitle.text === null && excerpt === null && headings.length === 0) {
    // 只有域名也算有效页面，但内容为空时仍需让模型知道「有一个页面」。
    return { domain, title: null, excerpt: null, headings: [], titleSuppressed: false }
  }
  return {
    domain,
    title: sanitizedTitle.text,
    excerpt,
    headings,
    titleSuppressed: sanitizedTitle.suppressed
  }
}
