import { randomBytes } from 'node:crypto'
import { screen } from 'electron'
import type { PerchGeometryView } from '../../shared/ipc'
import {
  convertPerchSnapshot,
  type PerchConvertDisplay,
  type PerchRect
} from './convert'
import { PerchHelperClient, type PerchHelperSnapshot } from './helperClient'

/**
 * 窗口支撑服务：只在宠物页订阅期间运行常驻几何助手。
 *
 * 边界（见计划 §窗口支撑）：
 * - 只用窗口矩形/Z 序/前台标记，不读窗口文本、不截图、不调用模型；
 * - 不支持作为支撑面的窗口（工具窗、敏感应用、桌宠自身）仍会遮挡上沿；
 * - 助手失败时推送空几何，渲染端平滑退回屏幕底部。
 */
export interface PerchServiceOptions {
  scriptPath: string
  powershellPath?: string
  salt?: string
  intervalMs?: number
  push: (geometry: PerchGeometryView) => void
}

export interface PerchServiceStatus {
  subscribed: boolean
  running: boolean
  reason: string | null
}

export class PerchService {
  private readonly helper: PerchHelperClient
  private readonly push: (geometry: PerchGeometryView) => void
  private readonly intervalMs: number
  private subscribed = false
  private seq = 0
  private lastKey = ''
  private lastReason: string | null = null
  private excludeHandles: string[] = []

  constructor(options: PerchServiceOptions) {
    this.push = options.push
    this.intervalMs = Math.max(200, Math.min(5_000, options.intervalMs ?? 450))
    this.helper = new PerchHelperClient({
      scriptPath: options.scriptPath,
      salt: options.salt ?? randomBytes(8).toString('hex'),
      ...(options.powershellPath === undefined ? {} : { powershellPath: options.powershellPath }),
      onSnapshot: (snapshot) => this.handleSnapshot(snapshot),
      onStatus: (reason) => this.handleStatus(reason)
    })
  }

  /** 幂等：桌宠页重载时重复订阅不会累积计数，也不会留下永不停止的助手。 */
  subscribe(): void {
    if (this.subscribed) return
    this.subscribed = true
    this.lastKey = ''
    this.helper.setRate(this.intervalMs)
    this.helper.start()
    this.helper.refresh()
  }

  unsubscribe(): void {
    if (!this.subscribed) return
    this.subscribed = false
    this.lastKey = ''
    this.lastReason = null
    this.helper.stop()
  }

  refresh(): void {
    if (!this.subscribed) return
    this.helper.refresh()
  }

  /** 宠物窗口自身的句柄必须排除，否则会把自己当成支撑面/遮挡物。 */
  setExcludeHandles(handles: readonly string[]): void {
    const normalized: string[] = []
    for (const raw of handles) {
      const hex = raw.trim().replace(/^0x/i, '').toLowerCase()
      if (!/^[0-9a-f]{1,16}$/.test(hex)) continue
      if (!normalized.includes(hex)) normalized.push(hex)
    }
    normalized.sort()
    if (normalized.join(',') === this.excludeHandles.join(',')) return
    this.excludeHandles = normalized
    this.helper.updateExcludes(normalized)
    this.helper.refresh()
  }

  getStatus(): PerchServiceStatus {
    return {
      subscribed: this.subscribed,
      running: this.helper.isRunning(),
      reason: this.lastReason
    }
  }

  dispose(): void {
    this.subscribed = false
    this.helper.stop()
  }

  private handleSnapshot(snapshot: PerchHelperSnapshot): void {
    if (!this.subscribed) return
    try {
      const { displays, union } = this.buildGeometryContext()
      const windows = convertPerchSnapshot(snapshot.windows, {
        unionDip: union,
        displays,
        toDip: (rect) => screen.screenToDipRect(null, rect)
      })
      const key = JSON.stringify(windows)
      if (key === this.lastKey && this.lastReason === null) return
      this.lastKey = key
      this.lastReason = null
      this.emit(windows, null, snapshot.at || Date.now())
    } catch (error) {
      const reason = `窗口几何换算失败：${error instanceof Error ? error.message : String(error)}`
      this.handleStatus(reason)
    }
  }

  private handleStatus(reason: string | null): void {
    if (reason === null) {
      // 具体几何由紧随其后的快照推送；这里只清除旧原因。
      if (this.lastReason !== null) this.lastReason = null
      return
    }
    this.lastReason = reason
    if (!this.subscribed) return
    this.lastKey = ''
    this.emit([], reason, Date.now())
  }

  private emit(
    windows: PerchGeometryView['windows'],
    reason: string | null,
    at: number
  ): void {
    this.seq += 1
    try {
      this.push({ version: 1, seq: this.seq, at, windows, unavailableReason: reason })
    } catch {
      // 宠物窗口正在销毁时推送失败可以忽略；下次订阅会重新开始。
    }
  }

  private buildGeometryContext(): { displays: PerchConvertDisplay[]; union: PerchRect } {
    const all = screen.getAllDisplays()
    const displays = all.map((display) => ({
      boundsDip: toRect(display.bounds),
      boundsPhysical: toRect(screen.dipToScreenRect(null, display.bounds))
    }))
    let x1 = Number.POSITIVE_INFINITY
    let y1 = Number.POSITIVE_INFINITY
    let x2 = Number.NEGATIVE_INFINITY
    let y2 = Number.NEGATIVE_INFINITY
    for (const display of all) {
      const area = display.workArea
      x1 = Math.min(x1, area.x)
      y1 = Math.min(y1, area.y)
      x2 = Math.max(x2, area.x + area.width)
      y2 = Math.max(y2, area.y + area.height)
    }
    const union: PerchRect =
      all.length === 0
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
    return { displays, union }
  }
}

function toRect(rect: PerchRect): PerchRect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}
