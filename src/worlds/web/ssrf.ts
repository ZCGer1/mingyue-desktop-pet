import { lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { RequestOptions as HttpsRequestOptions } from 'node:https'

export class WebFetchError extends Error {
  readonly code: string
  readonly status: number | undefined

  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'WebFetchError'
    this.code = code
    this.status = status
  }
}

interface ResolvedAddress {
  address: string
  family: number
}

export interface PublicTarget {
  url: URL
  address: string
  family: number
}

export interface SafeFetchResult {
  url: string
  status: number
  headers: Record<string, string>
  body: Buffer
}

export interface SafeFetchOptions {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  signal?: AbortSignal
  userAgent?: string
}

/** 对 URL 做协议/凭据/hostname 检查，并解析 DNS；任何私网地址都拒绝。 */
export async function resolvePublicTarget(raw: string): Promise<PublicTarget> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WebFetchError('WEB_BAD_URL', 'URL 无法解析')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchError('WEB_BAD_SCHEME', '只允许 http/https URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw new WebFetchError('WEB_BAD_URL', 'URL 不能包含用户名或密码')
  }
  if (url.hostname === '') throw new WebFetchError('WEB_BAD_URL', 'URL 缺少主机名')
  if (raw.length > 8192) throw new WebFetchError('WEB_BAD_URL', 'URL 过长')

  const hostname = stripBrackets(url.hostname).replace(/\.$/, '').toLowerCase()
  if (hostname === '' || isBlockedHostname(hostname)) {
    throw new WebFetchError('WEB_BLOCKED_HOST', '该主机名不允许访问')
  }

  const literalFamily = isIP(hostname)
  let addresses: ResolvedAddress[]
  if (literalFamily !== 0) {
    addresses = [{ address: hostname, family: literalFamily }]
  } else {
    addresses = await lookupAll(hostname)
  }
  if (addresses.length === 0) throw new WebFetchError('WEB_DNS_FAILED', '域名没有可用地址')
  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) {
      throw new WebFetchError('WEB_BLOCKED_ADDRESS', '解析到了不允许访问的内网地址')
    }
  }
  const first = addresses[0]
  if (first === undefined) throw new WebFetchError('WEB_DNS_FAILED', '域名没有可用地址')
  return { url, address: first.address, family: first.family }
}

export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
  const timeoutMs = opts.timeoutMs ?? 15_000
  const maxRedirects = opts.maxRedirects ?? 5
  let current = raw
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (opts.signal?.aborted === true) throw new WebFetchError('WEB_ABORTED', '抓取已中止')
    const target = await resolvePublicTarget(current)
    const response = await requestOnce(target, {
      maxBytes,
      timeoutMs,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      userAgent: opts.userAgent ?? 'MingYuePet/0.1 (+local desktop pet)'
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers['location']
      if (location === undefined) {
        throw new WebFetchError('WEB_REDIRECT', '重定向缺少 Location', response.status)
      }
      if (redirect === maxRedirects) throw new WebFetchError('WEB_REDIRECT_LIMIT', '重定向次数过多')
      current = new URL(location, target.url).toString()
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      throw new WebFetchError('WEB_HTTP', `目标返回 HTTP ${response.status}`, response.status)
    }
    return { ...response, url: target.url.toString() }
  }
  throw new WebFetchError('WEB_REDIRECT_LIMIT', '重定向次数过多')
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  for (const suffix of ['.local', '.internal', '.home', '.lan', '.intranet']) {
    if (host.endsWith(suffix)) return true
  }
  return false
}

export function isBlockedAddress(address: string): boolean {
  const clean = stripBrackets(address).split('%')[0] ?? ''
  const family = isIP(clean)
  if (family === 4) return isBlockedIPv4(clean)
  if (family === 6) return isBlockedIPv6(clean)
  return true
}

function isBlockedIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  if (value === null) return true
  const ranges: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
    ['255.255.255.255', 32]
  ]
  for (const [base, bits] of ranges) {
    const start = ipv4ToInt(base)
    if (start === null) continue
    const size = 2 ** (32 - bits)
    if (value >= start && value < start + size) return true
  }
  return false
}

function isBlockedIPv6(raw: string): boolean {
  const ip = raw.toLowerCase().split('%')[0] ?? ''
  if (ip === '::' || ip === '::1') return true
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped !== null && mapped[1] !== undefined) return isBlockedIPv4(mapped[1])
  const compat = ip.match(/^::(\d+\.\d+\.\d+\.\d+)$/)
  if (compat !== null && compat[1] !== undefined) return isBlockedIPv4(compat[1])
  if (ip.startsWith('::ffff:')) {
    const hex = ip.slice('::ffff:'.length)
    const value = hexToEmbeddedIPv4(hex)
    if (value !== null) return isBlockedIPv4(value)
  }
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true
  if (/^fe[89ab]/.test(ip)) return true
  if (ip.startsWith('ff')) return true
  if (ip.startsWith('fec')) return true
  if (ip.startsWith('2001:db8:') || ip === '2001:db8::') return true
  if (ip.startsWith('2001:10:')) return true
  if (ip.startsWith('64:ff9b:')) return true
  if (ip.startsWith('2001::') || ip.startsWith('2002:')) {
    // 6to4 / Teredo 可嵌入 IPv4；不展开计算时整体拒绝更安全。
    return true
  }
  return false
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    const byte = Number(part)
    if (byte < 0 || byte > 255) return null
    value = value * 256 + byte
  }
  return value
}

function hexToEmbeddedIPv4(hex: string): string | null {
  const parts = hex.split(':')
  if (parts.length !== 2) return null
  const high = Number.parseInt(parts[0] ?? '', 16)
  const low = Number.parseInt(parts[1] ?? '', 16)
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function lookupAll(hostname: string): Promise<ResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new WebFetchError('WEB_DNS_TIMEOUT', 'DNS 解析超时')), 5000)
    timer.unref?.()
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      clearTimeout(timer)
      if (error !== null) {
        reject(new WebFetchError('WEB_DNS_FAILED', `DNS 解析失败：${error.message}`))
        return
      }
      resolve(addresses.map((entry) => ({ address: entry.address, family: entry.family })))
    })
  })
}

interface RequestOnceOptions {
  maxBytes: number
  timeoutMs: number
  signal?: AbortSignal
  userAgent: string
}

async function requestOnce(
  target: PublicTarget,
  opts: RequestOnceOptions
): Promise<Omit<SafeFetchResult, 'url'>> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted === true) {
      reject(new WebFetchError('WEB_ABORTED', '抓取已中止'))
      return
    }
    const isHttps = target.url.protocol === 'https:'
    const hostname = stripBrackets(target.url.hostname)
    const family = target.family
    let request: ClientRequest | null = null
    let timer: NodeJS.Timeout | null = null
    let settled = false

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      opts.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (error: Error | null, result?: Omit<SafeFetchResult, 'url'>): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error !== null) reject(error)
      else if (result !== undefined) resolve(result)
      else reject(new WebFetchError('WEB_NETWORK', '未知错误'))
    }
    const onAbort = (): void => {
      request?.destroy()
      finish(new WebFetchError('WEB_ABORTED', '抓取已中止'))
    }
    const onResponse = (response: IncomingMessage): void => {
      const status = response.statusCode ?? 0
      const headers = normalizeHeaders(response.headers)
      if (status >= 300 && status < 400) {
        response.resume()
        finish(null, { status, headers, body: Buffer.alloc(0) })
        return
      }
      const declared = Number(headers['content-length'] ?? '0')
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        response.destroy()
        finish(new WebFetchError('WEB_TOO_LARGE', '响应体超过大小上限', status))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > opts.maxBytes) {
          response.destroy()
          finish(new WebFetchError('WEB_TOO_LARGE', '响应体超过大小上限', status))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (settled) return
        try {
          const body = decodeBody(Buffer.concat(chunks), headers, opts.maxBytes)
          finish(null, { status, headers, body })
        } catch (error) {
          finish(error instanceof Error ? error : new WebFetchError('WEB_DECODE', String(error), status))
        }
      })
      response.on('error', (error) => finish(new WebFetchError('WEB_NETWORK', error.message, status)))
    }

    const requestOptions = {
      protocol: target.url.protocol,
      hostname,
      ...(target.url.port === '' ? {} : { port: Number(target.url.port) }),
      path: `${target.url.pathname}${target.url.search}`,
      method: 'GET',
      headers: {
        Host: target.url.host,
        'User-Agent': opts.userAgent,
        Accept: 'text/html,text/plain,application/json,application/xml,text/markdown;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'identity',
        Connection: 'close'
      },
      ...(isHttps ? { servername: hostname } : {}),
      autoSelectFamily: false,
      lookup: (
        _lookupHost: string,
        _options: unknown,
        callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void
      ) => {
        callback(null, target.address, family)
      }
    } as unknown as HttpsRequestOptions

    try {
      request = isHttps ? httpsRequest(requestOptions, onResponse) : httpRequest(requestOptions, onResponse)
    } catch (error) {
      finish(new WebFetchError('WEB_NETWORK', error instanceof Error ? error.message : String(error)))
      return
    }
    timer = setTimeout(() => {
      request?.destroy()
      finish(new WebFetchError('WEB_TIMEOUT', '抓取超时'))
    }, opts.timeoutMs)
    timer.unref?.()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    request.on('error', (error) => finish(new WebFetchError('WEB_NETWORK', error.message)))
    request.end()
  })
}

function decodeBody(buffer: Buffer, headers: Record<string, string>, maxBytes: number): Buffer {
  const encoding = (headers['content-encoding'] ?? '').toLowerCase()
  let body = buffer
  try {
    if (encoding === 'gzip') body = gunzipSync(buffer)
    else if (encoding === 'deflate') body = inflateSync(buffer)
    else if (encoding === 'br') body = brotliDecompressSync(buffer)
  } catch {
    throw new WebFetchError('WEB_DECODE', '响应解压失败')
  }
  if (body.length > maxBytes * 5) throw new WebFetchError('WEB_TOO_LARGE', '解压后的响应体过大')
  return body
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(', ')
  }
  return out
}

/** 直接 fetch 兜底时的 HTML → 纯文本。 */
export function htmlToText(html: string): string {
  let text = html
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
  text = text.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  text = text.replace(/<(?:br|hr)\s*\/?>/gi, '\n')
  text = text.replace(/<\/(?:p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
  text = text.replace(/<[^>]+>/g, ' ')
  text = decodeEntities(text)
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    copy: '©'
  }
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match)
}

export function decodeTextBody(buffer: Buffer, contentType: string): string {
  const charsetMatch = contentType.match(/charset\s*=\s*"?([\w-]+)"?/i)
  const charset = charsetMatch?.[1]?.toLowerCase() ?? 'utf-8'
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return new TextDecoder('utf-8').decode(buffer)
  }
}
