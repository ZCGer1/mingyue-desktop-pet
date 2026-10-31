import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { extname, join, sep } from 'node:path'
import { DshPetAssetCatalog } from './assetCatalog'

/**
 * 桌宠页的本地 HTTP 宿主。
 *
 * 页面需要同源 HTTP（ES module、fetch、媒体 Range），因此主进程起一个只绑定
 * `127.0.0.1` 的小服务：
 *
 *  - 固定端口 17321；被占用时只向 17322…17340 顺延，实际端口回传给窗口；
 *  - 每条请求都验证 TCP 对端是回环地址、Host 恰好是当前监听端口；
 *  - 响应加 CORP/nosniff；页面加 CSP；不提供任何写接口；
 *  - 页面资源走固定白名单；动画素材走「生成目录白名单 + realpath containment」。
 *
 * 动画是透明 VP9 WebM，Chromium 会用 Range 请求做跳转/缓存；这里实现单段
 * Range（206/416）、HEAD、Content-Length，并以流式读取限制内存。旧 figure
 * 运行时、旧 frame 路由与 pack 路由已经移除，CSP 不再有 iframe 例外。
 *
 * 服务本身不 import Electron，方便在 vitest 里直接起停。
 */

const CAP_PAGE = 4 * 1024 * 1024
const CAP_IMAGE = 24 * 1024 * 1024
const CAP_MEDIA = 16 * 1024 * 1024
const VALID_PHASE = /^[a-z][a-z0-9-]{0,23}$/
const WEBM_PREFIX = '/dsh-pet/webm/'
const WEBM_SUFFIX = '.webm'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg'
}

/** 桌宠页自身的 CSP：没有 iframe、没有外部源。 */
const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'"
].join('; ')

/** 页面白名单：路径固定，不经过任何用户输入。 */
const PAGE_FILES: Record<string, { file: string; cap: number; html?: boolean }> = {
  '/': { file: 'index.html', cap: CAP_PAGE, html: true },
  '/index.html': { file: 'index.html', cap: CAP_PAGE, html: true },
  '/app.js': { file: 'app.js', cap: CAP_PAGE },
  '/app.css': { file: 'app.css', cap: CAP_PAGE },
  '/favicon.svg': { file: 'favicon.svg', cap: CAP_IMAGE }
}

export interface PetHostLogger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

export interface PetHostOptions {
  /** `vendor/dsh-pet/assets/webm`（打包后位于 resources/vendor/...）。 */
  webmDir: string
  /** 桌宠页构建产物目录。 */
  petPageDir: string
  port?: number
  host?: string
  logger?: PetHostLogger
}

export class PetHostServer {
  private readonly opts: PetHostOptions
  private readonly logger: PetHostLogger
  private readonly server: Server
  private readonly assets: DshPetAssetCatalog
  private portValue = 0
  private phase = 'idle'
  private started = false

  constructor(options: PetHostOptions) {
    this.opts = options
    this.assets = new DshPetAssetCatalog(options.webmDir)
    this.logger = options.logger ?? {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    }
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        this.logger.error('桌宠宿主请求失败', { error: String(error) })
        if (!response.headersSent) this.sendJson(response, 500, { ok: false, error: 'internal' })
        else response.destroy()
      })
    })
    this.server.headersTimeout = 10_000
    this.server.requestTimeout = 20_000
    this.server.keepAliveTimeout = 5_000
    if (!this.assets.available) {
      this.logger.warn('桌宠动画目录不可用', { root: options.webmDir })
    }
  }

  get port(): number {
    return this.portValue
  }

  get url(): string {
    return this.portValue === 0 ? '' : `http://127.0.0.1:${this.portValue}`
  }

  get currentPhase(): string {
    return this.phase
  }

  get assetsAvailable(): boolean {
    return this.assets.available
  }

  async start(): Promise<{ url: string; port: number }> {
    if (this.started) return { url: this.url, port: this.portValue }
    const host = this.opts.host ?? '127.0.0.1'
    const preferred = this.opts.port ?? 17321
    let lastError: unknown = null
    for (let offset = 0; offset < 20; offset += 1) {
      const candidate = preferred + offset
      try {
        await this.listen(host, candidate)
        this.portValue = (this.server.address() as AddressInfo).port
        this.started = true
        this.logger.info('桌宠宿主已启动', { port: this.portValue })
        return { url: this.url, port: this.portValue }
      } catch (error) {
        lastError = error
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EADDRINUSE' && code !== 'EACCES') break
      }
    }
    throw new Error(`无法绑定本地桌宠端口: ${String(lastError)}`)
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
    this.portValue = 0
    this.logger.info('桌宠宿主已停止')
  }

  /** Agent 相位由主进程记录，`pet:bootstrap` 读取；沿用旧的调用点。 */
  setPhase(phase: string): void {
    const value = phase.trim().toLowerCase()
    if (!VALID_PHASE.test(value) || value === this.phase) return
    this.phase = value
  }

  private async listen(host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(port, host)
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.applyCommonHeaders(response)
    if (!this.loopbackPeer(request)) {
      this.sendJson(response, 403, { ok: false, error: 'forbidden' })
      return
    }
    if (!this.trustedHost(request)) {
      this.sendJson(response, 403, { ok: false, error: 'untrusted-host' })
      return
    }
    let pathname: string
    try {
      pathname = new URL(request.url ?? '/', `http://127.0.0.1:${this.portValue}`).pathname
    } catch {
      this.sendJson(response, 400, { ok: false, error: 'bad-request' })
      return
    }

    if (pathname.startsWith(WEBM_PREFIX)) {
      await this.handleAnimation(request, response, pathname.slice(WEBM_PREFIX.length))
      return
    }

    const page = PAGE_FILES[pathname]
    if (page !== undefined) {
      await this.serveFile(
        request,
        response,
        this.opts.petPageDir,
        join(this.opts.petPageDir, page.file),
        page.cap,
        page.html === true ? { 'Content-Security-Policy': HTML_CSP } : {}
      )
      return
    }

    this.sendJson(response, 404, { ok: false, error: 'not-found' })
  }

  private loopbackPeer(request: IncomingMessage): boolean {
    const address = request.socket.remoteAddress ?? ''
    return (
      address === '' ||
      address === '127.0.0.1' ||
      address === '::1' ||
      address === '::ffff:127.0.0.1'
    )
  }

  /** DNS rebinding：Host 必须指向当前实际监听端口的本机地址。 */
  private trustedHost(request: IncomingMessage): boolean {
    const host = (request.headers.host ?? '').toLowerCase()
    const port = this.portValue
    if (port === 0) return false
    return (
      host === `127.0.0.1:${port}` ||
      host === `localhost:${port}` ||
      host === `[::1]:${port}`
    )
  }

  private allowRead(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.method === 'GET' || request.method === 'HEAD') return true
    response.setHeader('allow', 'GET, HEAD')
    this.sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
    return false
  }

  /**
   * `/dsh-pet/webm/<动画名>.webm`。名字来自固定目录，先解码再精确比对；
   * 文件必须真实存在于 webm 根目录内。只允许单段 Range。
   */
  private async handleAnimation(
    request: IncomingMessage,
    response: ServerResponse,
    rawName: string
  ): Promise<void> {
    if (!this.allowRead(request, response)) return
    let animationId: string
    try {
      if (!rawName.endsWith(WEBM_SUFFIX)) throw new Error('suffix')
      animationId = decodeURIComponent(rawName.slice(0, -WEBM_SUFFIX.length))
    } catch {
      this.sendJson(response, 404, { ok: false, error: 'not-found' })
      return
    }
    const asset = this.assets.resolve(animationId)
    if (asset === null) {
      this.sendJson(response, 404, { ok: false, error: 'not-found' })
      return
    }
    if (asset.size > CAP_MEDIA) {
      this.sendJson(response, 413, { ok: false, error: 'file-too-large' })
      return
    }
    const etag = weakEtag(asset)
    const range = request.headers.range
    if (range === undefined) {
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304, { etag, 'cache-control': 'no-cache' })
        response.end()
        return
      }
      response.writeHead(200, {
        'content-type': 'video/webm',
        'content-length': asset.size,
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
        etag,
        'x-content-type-options': 'nosniff'
      })
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      this.stream(response, asset.file, 0, asset.size - 1)
      return
    }

    const parsed = parseSingleRange(range, asset.size)
    if (parsed === null) {
      response.writeHead(416, {
        'content-range': `bytes */${asset.size}`,
        'accept-ranges': 'bytes',
        'content-type': 'video/webm',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff'
      })
      response.end()
      return
    }
    const { start, end } = parsed
    response.writeHead(206, {
      'content-type': 'video/webm',
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${asset.size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
      etag,
      'x-content-type-options': 'nosniff'
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    this.stream(response, asset.file, start, end)
  }

  private stream(response: ServerResponse, file: string, start: number, end: number): void {
    const stream = createReadStream(file, { start, end })
    let finished = false
    const fail = (): void => {
      if (finished) return
      finished = true
      stream.destroy()
      response.destroy()
    }
    response.on('close', () => {
      finished = true
      stream.destroy()
    })
    stream.on('error', fail)
    stream.pipe(response)
  }

  private async serveFile(
    request: IncomingMessage,
    response: ServerResponse,
    base: string,
    file: string,
    cap: number,
    extraHeaders: Record<string, string> = {}
  ): Promise<void> {
    const resolved = contained(base, file)
    if (resolved === undefined) {
      this.sendJson(response, 403, { ok: false, error: 'forbidden' })
      return
    }
    let stat
    try {
      stat = statSync(resolved)
      if (!stat.isFile()) throw new Error('not a file')
      if (stat.size > cap) {
        this.sendJson(response, 413, { ok: false, error: 'file-too-large' })
        return
      }
    } catch {
      this.sendJson(response, 404, { ok: false, error: 'not-found' })
      return
    }
    const etag = weakEtag(stat)
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { etag, 'cache-control': 'no-cache' })
      response.end()
      return
    }
    let body: Buffer
    try {
      body = readFileSync(resolved)
    } catch {
      this.sendJson(response, 404, { ok: false, error: 'not-found' })
      return
    }
    const headers: Record<string, string | number> = {
      'content-type': MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.byteLength,
      'cache-control': 'no-cache',
      etag,
      'x-content-type-options': 'nosniff',
      ...extraHeaders
    }
    response.writeHead(200, headers)
    if (request.method === 'HEAD') response.end()
    else response.end(body)
  }

  private sendJson(response: ServerResponse, status: number, payload: unknown): void {
    if (response.writableEnded) return
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    })
    response.end(body)
  }

  private applyCommonHeaders(response: ServerResponse): void {
    response.setHeader('cross-origin-resource-policy', 'same-origin')
    response.setHeader('x-frame-options', 'DENY')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader(
      'permissions-policy',
      'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=(), gamepad=(), serial=(), usb=(), hid=()'
    )
  }
}

/**
 * 解析单段 Range。返回 null 表示应回 416；多段、非数字、起点越界都不接受。
 * 后缀形式 `bytes=-N` 取末尾 N 字节；`end` 超出文件大小按文件末尾截断。
 */
export function parseSingleRange(
  header: string,
  size: number
): { start: number; end: number } | null {
  if (size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null
  let start: number
  let end: number
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
    if (start < 0 || start >= size || end < start) return null
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

function contained(base: string, candidate: string): string | undefined {
  try {
    const realBase = realpathSync(base)
    const realCandidate = realpathSync(candidate)
    return realCandidate === realBase || realCandidate.startsWith(realBase + sep)
      ? realCandidate
      : undefined
  } catch {
    return undefined
  }
}

function weakEtag(stat: { size: number; mtimeMs: number }): string {
  return `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`
}
