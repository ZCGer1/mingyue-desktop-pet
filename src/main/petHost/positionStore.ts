import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWrite } from '../../core/util'

/**
 * 桌宠位置的主进程持久化。
 *
 * 旧实现把坐标放在宠物页 origin 的 localStorage 里；本地宿主端口变化时
 * origin 随之变化，位置就丢了。新实现由主进程按「稳定显示器 id + 工作区
 * 比例」保存：分辨率/缩放变化后仍落在同一块屏幕的相近相对位置。
 *
 * 文件损坏、越界或无法读取时返回原因并让调用方使用安全 home；绝不因为
 * 一次读取失败清空文件。
 */

export const PET_POSITION_VERSION = 1
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000

export type PetFacing = 'left' | 'right'

export interface PetSavedPosition {
  version: 1
  /** Electron display.id 的字符串形式；显示器不存在时页面回退主屏。 */
  displayId: string | null
  /** 身体中心相对工作区宽度的比例（0..1）。 */
  xRatio: number
  /** 脚底相对工作区高度的比例（0..1）。 */
  feetRatio: number
  facing: PetFacing
  savedAt: number
}

export interface PositionLoadResult {
  position: PetSavedPosition | null
  /** 损坏、越界或不可读时的可读原因；正常/首次启动为 null。 */
  reason: string | null
}

export function normalizeSavedPosition(value: unknown, now = Date.now()): PetSavedPosition | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record['version'] !== PET_POSITION_VERSION) return null
  const displayId =
    typeof record['displayId'] === 'string' && record['displayId'].length <= 64
      ? record['displayId']
      : null
  const xRatio = record['xRatio']
  const feetRatio = record['feetRatio']
  const savedAt = record['savedAt']
  const facing = record['facing'] === 'left' ? 'left' : 'right'
  if (typeof xRatio !== 'number' || !Number.isFinite(xRatio)) return null
  if (typeof feetRatio !== 'number' || !Number.isFinite(feetRatio)) return null
  if (xRatio < -0.05 || xRatio > 1.05 || feetRatio < -0.05 || feetRatio > 1.05) return null
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null
  if (savedAt > now + 60_000 || now - savedAt > MAX_AGE_MS) return null
  return {
    version: PET_POSITION_VERSION,
    displayId,
    xRatio: Math.min(1, Math.max(0, xRatio)),
    feetRatio: Math.min(1, Math.max(0, feetRatio)),
    facing,
    savedAt: Math.round(savedAt)
  }
}

export class PetPositionStore {
  readonly file: string

  constructor(file: string) {
    this.file = file
  }

  load(now = Date.now()): PositionLoadResult {
    if (!existsSync(this.file)) return { position: null, reason: null }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
    } catch {
      return { position: null, reason: '位置文件无法解析；已回退到安全初始位置。' }
    }
    const position = normalizeSavedPosition(parsed, now)
    if (position === null) {
      return { position: null, reason: '保存的位置无效或过旧；已回退到安全初始位置。' }
    }
    return { position, reason: null }
  }

  save(value: unknown): boolean {
    const position = normalizeSavedPosition(value)
    if (position === null) return false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      atomicWrite(this.file, `${JSON.stringify(position, null, 2)}\n`)
      return true
    } catch {
      return false
    }
  }

  clear(): void {
    try {
      rmSync(this.file, { force: true })
    } catch {
      /* 文件不存在或只读：页面仍会收到 reset，使用 home。 */
    }
  }
}
