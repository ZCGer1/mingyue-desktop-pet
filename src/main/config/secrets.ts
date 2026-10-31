import { mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { atomicWrite } from '../../core/util'

export interface ApiKeyStatus {
  configured: boolean
  /** safeStorage/DPAPI 是否可用；不可用时拒绝保存，而不是退回明文。 */
  storageAvailable: boolean
  hint: string | null
}

/**
 * DeepSeek API Key（PLAN.md §6）。
 *
 * - 只存在主进程；渲染进程只能写入、查询「是否已配置」和触发验证。
 * - `safeStorage`（Windows DPAPI）可用时加密后写盘；不可用时拒绝保存。
 * - 不写 config.json、不写日志、不注入子进程环境。
 */
export class SecretStore {
  readonly file: string
  private cached: string | null | undefined = undefined

  constructor(file: string) {
    this.file = file
  }

  storageAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  get(): string | null {
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
      const parsed = JSON.parse(raw) as unknown
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        (parsed as { v?: unknown }).v !== 1 ||
        typeof (parsed as { enc?: unknown }).enc !== 'string'
      ) {
        this.cached = null
        return null
      }
      const decrypted = safeStorage.decryptString(
        Buffer.from((parsed as { enc: string }).enc, 'base64')
      )
      const key = decrypted.trim()
      this.cached = key === '' ? null : key
      return this.cached
    } catch {
      this.cached = null
      return null
    }
  }

  /** 写入前只做最小的形状校验；真正的验证是设置页的 `/models` 请求。 */
  set(raw: string): { ok: true } | { ok: false; message: string } {
    if (!this.storageAvailable()) {
      return { ok: false, message: '系统加密存储不可用，无法安全保存 API Key。' }
    }
    const key = raw.trim()
    if (key === '') return { ok: false, message: 'API Key 不能为空。' }
    if (key.length > 512) return { ok: false, message: 'API Key 过长。' }
    if (/\s|[\u0000-\u001f\u007f]/.test(key)) {
      return { ok: false, message: 'API Key 不应包含空白或控制字符。' }
    }
    try {
      const enc = safeStorage.encryptString(key).toString('base64')
      mkdirSync(dirname(this.file), { recursive: true })
      atomicWrite(this.file, `${JSON.stringify({ v: 1, enc })}\n`)
      this.cached = key
      return { ok: true }
    } catch {
      return { ok: false, message: 'API Key 加密保存失败。' }
    }
  }

  clear(): void {
    this.cached = null
    try {
      unlinkSync(this.file)
    } catch {
      /* 文件可能本来就不存在 */
    }
  }

  status(): ApiKeyStatus {
    const configured = this.get() !== null
    const available = this.storageAvailable()
    return {
      configured,
      storageAvailable: available,
      hint: available
        ? configured
          ? null
          : '还没有保存 DeepSeek API Key；纯桌宠模式仍然可用。'
        : '当前系统的安全存储不可用，无法保存 API Key。'
    }
  }
}
