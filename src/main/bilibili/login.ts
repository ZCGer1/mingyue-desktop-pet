import QRCode from 'qrcode'
import type { Logger } from '../../core/types'
import type {
  BiliCredentials,
  BiliCredentialSnapshot
} from './credentials'
import type {
  BiliLoginQrView,
  BiliLoginState,
  BiliLoginView
} from '../../shared/bilibili'
import { maskUid } from '../../shared/bilibili'

/**
 * B 站扫码登录。
 *
 * 只在主进程运行：
 * - 二维码链接与 qrcode_key 只保存在内存；不写日志、不进配置。
 * - 登录成功后从 `Set-Cookie` 读取 SESSDATA 等，立即交给凭据存储加密；
 *   本类不持久化明文。
 * - 二维码过期、等待扫码、已扫码、取消、登录失效是不同状态。
 * - 轮询有硬超时，取消/退出会清空定时器，不留下后台请求。
 */

export const BILI_QR_GENERATE_URL =
  'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
export const BILI_QR_POLL_URL =
  'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
export const BILI_FINGERPRINT_URL = 'https://api.bilibili.com/x/frontend/finger/spi'

const POLL_INTERVAL_MS = 2000
const REQUEST_TIMEOUT_MS = 12_000
const QR_TTL_MS = 180_000
const MAX_MESSAGE = 160

export interface BiliLoginDeps {
  logger: Logger
  fetchImpl?: typeof fetch
  now?: () => number
  toDataUrl?: (text: string) => Promise<string>
  /** 登录成功：主进程在这里加密保存，并让服务用新凭据重启。 */
  onSignedIn: (credentials: BiliCredentials, uid: string | null) => Promise<void>
  /** 状态变化通知（设置页轮询之外的可选推送）。 */
  onChanged?: () => void
}

interface QrSession {
  key: string
  url: string
  imageDataUrl: string
  expiresAt: number
  expiresTimer: NodeJS.Timeout | null
}

interface GeneratePayload {
  url?: unknown
  qrcode_key?: unknown
}

interface PollPayload {
  code?: unknown
  message?: unknown
  url?: unknown
}

type CookieMap = Record<string, string>

export class BiliLoginManager {
  private readonly deps: BiliLoginDeps
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly toDataUrl: (text: string) => Promise<string>
  private state: BiliLoginState = 'unlogged'
  private message: string | null = null
  private accountName: string | null = null
  private uid: string | null = null
  private savedAt: number | null = null
  private session: QrSession | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private pollGeneration = 0
  private polling = false
  private disposed = false

  constructor(deps: BiliLoginDeps) {
    this.deps = deps
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.now = deps.now ?? Date.now
    this.toDataUrl =
      deps.toDataUrl ??
      ((text) => QRCode.toDataURL(text, { margin: 1, width: 240, errorCorrectionLevel: 'M' }))
  }

  /** 启动时从加密存储恢复登录态；没有凭据则为未登录。 */
  restore(saved: BiliCredentialSnapshot | null): void {
    if (saved === null) {
      this.state = 'unlogged'
      this.accountName = null
      this.uid = null
      this.savedAt = null
      return
    }
    this.state = 'logged-in'
    this.accountName = saved.info.accountName
    this.uid = saved.info.uid
    this.savedAt = saved.info.savedAt || null
    this.message = null
  }

  /** 服务确认凭据已失效（登录过期）时调用；不删除密文，等用户重新扫码。 */
  markSessionExpired(): void {
    if (this.state === 'logged-in') {
      this.state = 'session-expired'
      this.message = 'B 站登录已失效，请重新扫码。'
      this.deps.onChanged?.()
    }
  }

  markLoggedOut(): void {
    this.stopPolling()
    this.session = null
    this.state = 'unlogged'
    this.accountName = null
    this.uid = null
    this.savedAt = null
    this.message = null
    this.deps.onChanged?.()
  }

  /** 服务通过 bili_account 获取到昵称后回填；UID 不写入日志。 */
  noteAccount(name: string | null, uid: string | null): void {
    if (this.state !== 'logged-in' && this.state !== 'scanned') return
    if (typeof name === 'string' && name.trim() !== '') this.accountName = name.trim().slice(0, 80)
    if (typeof uid === 'string' && uid.trim() !== '') this.uid = uid.trim().slice(0, 40)
    this.deps.onChanged?.()
  }

  view(): BiliLoginView {
    return {
      state: this.state,
      accountName: this.state === 'logged-in' ? this.accountName : null,
      uidMasked: this.state === 'logged-in' ? maskUid(this.uid) : null,
      savedAt: this.savedAt,
      message: this.message
    }
  }

  qrView(): BiliLoginQrView {
    const session = this.session
    const active = session !== null && (this.state === 'waiting-scan' || this.state === 'scanned')
    return {
      state: this.state,
      imageDataUrl: active ? session.imageDataUrl : null,
      expiresAt: active ? session.expiresAt : null,
      accountName: this.state === 'logged-in' ? this.accountName : null,
      uidMasked: this.state === 'logged-in' ? maskUid(this.uid) : null,
      message: this.message
    }
  }

  /** 生成新二维码并开始轮询；重复调用会取消上一张。 */
  async start(): Promise<BiliLoginQrView> {
    if (this.disposed) {
      return this.fail('登录组件已停止，请重启应用。')
    }
    this.stopPolling()
    this.session = null
    this.accountName = null
    this.uid = null
    this.state = 'waiting-scan'
    this.message = null
    const generation = ++this.pollGeneration

    let response: Response
    try {
      response = await this.fetchJson(BILI_QR_GENERATE_URL)
    } catch {
      return this.fail('无法连接 B 站登录服务，请检查网络后重试。')
    }
    if (!response.ok) {
      return this.fail('B 站登录服务暂时不可用，请稍后重试。')
    }
    let payload: { data?: GeneratePayload } | null = null
    try {
      payload = (await response.json()) as { data?: GeneratePayload }
    } catch {
      payload = null
    }
    const data = payload?.data
    const key = typeof data?.qrcode_key === 'string' ? data.qrcode_key.trim() : ''
    const url = typeof data?.url === 'string' ? data.url.trim() : ''
    if (key === '' || url === '' || key.length > 256 || !isHttpsUrl(url)) {
      return this.fail('B 站返回的登录二维码不完整，请重试。')
    }
    let imageDataUrl: string
    try {
      imageDataUrl = await this.toDataUrl(url)
    } catch {
      return this.fail('无法生成登录二维码图片。')
    }
    if (generation !== this.pollGeneration || this.disposed) {
      return this.qrView()
    }
    this.session = {
      key,
      url,
      imageDataUrl,
      expiresAt: this.now() + QR_TTL_MS,
      expiresTimer: null
    }
    this.session.expiresTimer = setTimeout(() => {
      if (this.session !== null && this.session.key === key && this.polling) {
        this.expire()
      }
    }, QR_TTL_MS)
    this.session.expiresTimer.unref?.()
    this.deps.onChanged?.()
    // 生成接口可能已经下发 buvid3；保留在内存，登录成功时合并。
    const generateCookies = readCookies(response)
    void this.pollLoop(generation, generateCookies)
    return this.qrView()
  }

  /** 取消扫码：清空二维码与轮询；不清除已经保存的登录凭据。 */
  cancel(): BiliLoginQrView {
    this.pollGeneration += 1
    this.stopPolling()
    this.clearSession()
    if (this.state !== 'logged-in') {
      this.state = 'unlogged'
      this.message = null
    }
    this.deps.onChanged?.()
    return this.qrView()
  }

  /** 主动轮询一次，供设置页在后台定时器不可用时兜底。 */
  async refresh(): Promise<BiliLoginQrView> {
    if (this.state === 'waiting-scan' || this.state === 'scanned') {
      if (!this.polling) void this.pollLoop(this.pollGeneration, {})
    }
    return this.qrView()
  }

  dispose(): void {
    this.disposed = true
    this.pollGeneration += 1
    this.stopPolling()
    this.clearSession()
  }

  // ------------------------------------------------------------------ 轮询

  private async pollLoop(generation: number, initialCookies: CookieMap): Promise<void> {
    if (this.polling) return
    this.polling = true
    const cookies: CookieMap = { ...initialCookies }
    try {
      while (!this.disposed && generation === this.pollGeneration) {
        const session = this.session
        if (session === null) break
        if (this.now() >= session.expiresAt) {
          this.expire()
          break
        }
        await delay(POLL_INTERVAL_MS)
        if (this.disposed || generation !== this.pollGeneration || this.session !== session) break
        let response: Response
        try {
          response = await this.fetchJson(
            `${BILI_QR_POLL_URL}?qrcode_key=${encodeURIComponent(session.key)}&source=main-fe-header`
          )
        } catch {
          // 单次网络失败不立即判死；保留二维码，下一轮继续。
          continue
        }
        if (this.disposed || generation !== this.pollGeneration) break
        Object.assign(cookies, readCookies(response))
        let payload: { data?: PollPayload } | null = null
        try {
          payload = (await response.json()) as { data?: PollPayload }
        } catch {
          payload = null
        }
        const data = payload?.data
        const code = typeof data?.code === 'number' ? data.code : -1
        if (code === 86101) {
          if (this.state !== 'waiting-scan') {
            this.state = 'waiting-scan'
            this.deps.onChanged?.()
          }
          continue
        }
        if (code === 86090) {
          if (this.state !== 'scanned') {
            this.state = 'scanned'
            this.message = '已扫码，请在手机 B 站上确认登录。'
            this.deps.onChanged?.()
          }
          continue
        }
        if (code === 86038) {
          this.expire()
          break
        }
        if (code !== 0) {
          this.fail(messageOf(data?.message) ?? '登录请求失败，请重试。')
          break
        }
        await this.complete(cookies, data?.url, generation)
        break
      }
    } finally {
      this.polling = false
    }
  }

  private async complete(
    cookies: CookieMap,
    redirectUrl: unknown,
    generation: number
  ): Promise<void> {
    const merged: CookieMap = { ...cookies, ...queryCookies(redirectUrl) }
    const credentials: BiliCredentials = {
      sessdata: merged['SESSDATA'] ?? '',
      biliJct: merged['bili_jct'] ?? '',
      buvid3: merged['buvid3'] ?? '',
      dedeuserid: merged['DedeUserID'] ?? ''
    }
    if (credentials.sessdata === '') {
      this.fail('登录成功但没有取得会话凭据，请重新扫码。')
      return
    }
    if (credentials.buvid3 === '') {
      credentials.buvid3 = await this.fetchBuvid3()
    }
    const uid = credentials.dedeuserid === '' ? null : credentials.dedeuserid
    this.stopPolling()
    this.clearSession()
    this.state = 'logged-in'
    this.uid = uid
    this.accountName = null
    this.message = '已登录，正在确认账号信息。'
    try {
      await this.deps.onSignedIn(credentials, uid)
      this.savedAt = this.now()
      this.message = null
    } catch {
      this.state = 'error'
      this.message = '登录凭据保存失败，请重试。'
    }
    if (generation !== this.pollGeneration) return
    this.deps.onChanged?.()
  }

  private async fetchBuvid3(): Promise<string> {
    try {
      const response = await this.fetchJson(BILI_FINGERPRINT_URL)
      const payload = (await response.json()) as { data?: { b_3?: unknown } }
      const value = payload?.data?.b_3
      return typeof value === 'string' && value.length <= 512 ? value : ''
    } catch {
      return ''
    }
  }

  private fetchJson(url: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    timer.unref?.()
    return this.fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.bilibili.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    }).finally(() => clearTimeout(timer))
  }

  private expire(): void {
    this.pollGeneration += 1
    this.stopPolling()
    this.clearSession()
    this.state = 'expired'
    this.message = '二维码已过期，请重新生成。'
    this.deps.onChanged?.()
  }

  private fail(message: string): BiliLoginQrView {
    this.pollGeneration += 1
    this.stopPolling()
    this.clearSession()
    this.state = 'error'
    this.message = message.slice(0, MAX_MESSAGE)
    this.deps.logger.warn('B 站扫码登录失败', { message: this.message })
    this.deps.onChanged?.()
    return this.qrView()
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    this.polling = false
  }

  private clearSession(): void {
    if (this.session?.expiresTimer != null) clearTimeout(this.session.expiresTimer)
    if (this.session !== null) {
      this.session.imageDataUrl = ''
      this.session = null
    }
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function messageOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text.slice(0, MAX_MESSAGE)
}

/** 从响应头读取 cookie；只保留名字/值，不保留属性。 */
function readCookies(response: Response): CookieMap {
  const out: CookieMap = {}
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  let list: string[] = []
  if (typeof headers.getSetCookie === 'function') {
    list = headers.getSetCookie()
  } else {
    const raw = headers.get('set-cookie')
    if (raw !== null) list = splitCookieHeader(raw)
  }
  for (const entry of list) {
    const pair = entry.split(';', 1)[0] ?? ''
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (name === '' || value === '' || value.length > 512) continue
    if (/[\r\n\0]/.test(value)) continue
    out[name] = value
  }
  return out
}

function splitCookieHeader(raw: string): string[] {
  return raw
    .split(/,(?=\s*[A-Za-z0-9_\-]+=)/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** 登录成功时部分客户端从跳转 URL 的查询串取凭据；两种来源都支持。 */
function queryCookies(value: unknown): CookieMap {
  if (typeof value !== 'string') return {}
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return {}
  }
  if (url.protocol !== 'https:') return {}
  const host = url.hostname.toLowerCase()
  if (host !== 'bilibili.com' && !host.endsWith('.bilibili.com')) return {}
  const out: CookieMap = {}
  for (const name of ['SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID']) {
    const raw = url.searchParams.get(name)
    if (raw === null) continue
    const text = raw.trim()
    if (text === '' || text.length > 512 || /[\r\n\0]/.test(text)) continue
    out[name] = text
  }
  return out
}
