import { mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWrite } from '../../core/util'

/**
 * B 站登录凭据的持久化。
 *
 * - 只在主进程和受控 Python 子进程内存中存在。
 * - 通过 Electron `safeStorage`（Windows DPAPI）加密后写盘；不可用时拒绝保存，
 *   绝不退回明文，也不写 config.json / 日志 / 环境变量。
 * - 读取时会校验形状与长度；损坏的缓存视为未登录，由用户重新扫码。
 */

export interface BiliCredentials {
  sessdata: string
  biliJct: string
  buvid3: string
  dedeuserid: string
}

export interface BiliCredentialInfo {
  savedAt: number
  accountName: string | null
  uid: string | null
}

export interface BiliCredentialSnapshot {
  credentials: BiliCredentials
  info: BiliCredentialInfo
}

/** 可注入的加密后端，便于单元测试；生产环境固定用 safeStorage。 */
export interface BiliCryptoPort {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

interface StoredPayload {
  v: 1
  enc: string
}

const MAX_FIELD = 512
const FIELD_RE = /^[\x20-\x7e]+$/

function cleanField(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '' || text.length > MAX_FIELD || !FIELD_RE.test(text)) return ''
  return text
}

export function normalizeCredentials(raw: Partial<BiliCredentials>): BiliCredentials {
  return {
    sessdata: cleanField(raw.sessdata),
    biliJct: cleanField(raw.biliJct),
    buvid3: cleanField(raw.buvid3),
    dedeuserid: cleanField(raw.dedeuserid)
  }
}

export function credentialsUsable(credentials: BiliCredentials | null): boolean {
  return credentials !== null && credentials.sessdata !== ''
}

export class BiliCredentialStore {
  readonly file: string
  private readonly crypto: BiliCryptoPort
  private cached: BiliCredentialSnapshot | null | undefined = undefined

  constructor(file: string, crypto: BiliCryptoPort) {
    this.file = file
    this.crypto = crypto
  }

  storageAvailable(): boolean {
    try {
      return this.crypto.available()
    } catch {
      return false
    }
  }

  /** 返回内存快照；损坏或不可解密时返回 null，不抛错。 */
  load(): BiliCredentialSnapshot | null {
    if (this.cached !== undefined) return this.cached
    if (!this.storageAvailable()) {
      this.cached = null
      return null
    }
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      this.cached = null
      return null
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredPayload>
      if (parsed.v !== 1 || typeof parsed.enc !== 'string' || parsed.enc === '') {
        this.cached = null
        return null
      }
      const decrypted = this.crypto.decrypt(Buffer.from(parsed.enc, 'base64'))
      const decoded = JSON.parse(decrypted) as {
        credentials?: Partial<BiliCredentials>
        savedAt?: unknown
        accountName?: unknown
        uid?: unknown
      }
      const credentials = normalizeCredentials(decoded.credentials ?? {})
      if (credentials.sessdata === '') {
        this.cached = null
        return null
      }
      const savedAt =
        typeof decoded.savedAt === 'number' && Number.isFinite(decoded.savedAt)
          ? decoded.savedAt
          : 0
      this.cached = {
        credentials,
        info: {
          savedAt,
          accountName: typeof decoded.accountName === 'string' ? decoded.accountName.slice(0, 80) : null,
          uid: typeof decoded.uid === 'string' ? decoded.uid.slice(0, 40) : null
        }
      }
      return this.cached
    } catch {
      this.cached = null
      return null
    }
  }

  save(
    raw: Partial<BiliCredentials>,
    info: { accountName?: string | null; uid?: string | null } = {}
  ): { ok: true } | { ok: false; message: string } {
    if (!this.storageAvailable()) {
      return { ok: false, message: '系统加密存储不可用，无法安全保存 B 站登录凭据。' }
    }
    const credentials = normalizeCredentials(raw)
    if (credentials.sessdata === '') {
      return { ok: false, message: '登录凭据不完整，请重新扫码。' }
    }
    try {
      const payload = JSON.stringify({
        credentials,
        savedAt: Date.now(),
        accountName: typeof info.accountName === 'string' ? info.accountName.slice(0, 80) : null,
        uid: typeof info.uid === 'string' ? info.uid.slice(0, 40) : null
      })
      const enc = this.crypto.encrypt(payload).toString('base64')
      mkdirSync(dirname(this.file), { recursive: true })
      atomicWrite(this.file, `${JSON.stringify({ v: 1, enc })}\n`)
      this.cached = undefined
      return { ok: true }
    } catch {
      return { ok: false, message: 'B 站登录凭据加密保存失败。' }
    }
  }

  /** 只更新账号展示信息（昵称/UID），凭据值保持加密保存不变。 */
  updateInfo(info: { accountName?: string | null; uid?: string | null }): void {
    const current = this.load()
    if (current === null) return
    this.save(current.credentials, {
      accountName: info.accountName ?? current.info.accountName,
      uid: info.uid ?? current.info.uid
    })
  }

  clear(): void {
    this.cached = null
    try {
      unlinkSync(this.file)
    } catch {
      /* 文件本来就不存在 */
    }
  }
}
