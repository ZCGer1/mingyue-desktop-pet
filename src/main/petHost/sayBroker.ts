import { randomUUID } from 'node:crypto'
import type { PetSayReceipt } from '../../shared/ipc'

/**
 * 气泡「主进程 → 宠物页 → 真实显示回执」桥。
 *
 * 发送 IPC 成功不等于气泡真的显示：页面可能被审批、流式回复或迷你卡
 * 占用，也可能直接销毁。只有页面回执 `displayed=true` 才结算为成功；
 * 超时、页面不可用、页面明确丢弃都返回 false，绝不把发送成功写成开口。
 */

const DEFAULT_TIMEOUT_MS = 6_000

export interface PetSayDisplayResult {
  displayed: boolean
  reason?: string
}

interface Pending {
  resolve: (result: PetSayDisplayResult) => void
  timer: NodeJS.Timeout
}

export interface PetSayBrokerOptions {
  now?: () => number
  timeoutMs?: number
  onReceipt?: (receipt: PetSayReceipt) => void
}

export class PetSayBroker {
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly onReceipt: ((receipt: PetSayReceipt) => void) | undefined
  private readonly pending = new Map<string, Pending>()
  private lastReceipt: PetSayReceipt | null = null

  constructor(options: PetSayBrokerOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.onReceipt = options.onReceipt
  }

  get last(): PetSayReceipt | null {
    return this.lastReceipt
  }

  /**
   * 发送一条气泡并等待页面回执。`send` 返回 false 表示页面当前不可用，
   * 会立即以 displayed=false 结算，不会占用等待超时。
   */
  request(send: (sayId: string) => boolean): Promise<PetSayDisplayResult> {
    const sayId = randomUUID()
    return new Promise<PetSayDisplayResult>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(sayId, { displayed: false, reason: 'timeout' })
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(sayId, { resolve, timer })
      let delivered = false
      try {
        delivered = send(sayId)
      } catch {
        delivered = false
      }
      if (!delivered) {
        this.finish(sayId, { displayed: false, reason: 'page-unavailable' })
      }
    })
  }

  /** 页面回执入口；未知/过期 sayId 直接丢弃。 */
  handleReceipt(raw: unknown): boolean {
    const receipt = normalizeReceipt(raw, this.now())
    if (receipt === null) return false
    this.lastReceipt = receipt
    try {
      this.onReceipt?.(receipt)
    } catch {
      /* 诊断回调不能影响结算 */
    }
    this.finish(receipt.sayId, {
      displayed: receipt.displayed,
      ...(receipt.displayed
        ? {}
        : { reason: receipt.reason ?? 'page-dropped' })
    })
    return true
  }

  /** 已知这条气泡不可能再回执时立即结算失败（例如同事件的动画未能发送）。 */
  cancel(sayId: string | null, reason: string): void {
    if (sayId === null) return
    this.finish(sayId, { displayed: false, reason })
  }

  /** 页面重载/关闭/桌宠禁用时让所有等待方立即结束。 */
  cancelAll(reason: string): void {
    for (const sayId of Array.from(this.pending.keys())) {
      this.finish(sayId, { displayed: false, reason })
    }
  }

  private finish(sayId: string, result: PetSayDisplayResult): void {
    const pending = this.pending.get(sayId)
    if (pending === undefined) return
    this.pending.delete(sayId)
    clearTimeout(pending.timer)
    pending.resolve({ ...result })
  }
}

function normalizeReceipt(raw: unknown, now: number): PetSayReceipt | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const sayId = typeof record['sayId'] === 'string' ? record['sayId'] : ''
  if (sayId === '' || sayId.length > 80) return null
  if (typeof record['displayed'] !== 'boolean') return null
  const at =
    typeof record['at'] === 'number' && Number.isFinite(record['at']) ? record['at'] : now
  const reason =
    record['displayed'] === false && typeof record['reason'] === 'string'
      ? record['reason'].replace(/[^\w-]/g, '').slice(0, 40) || 'page-dropped'
      : undefined
  return {
    sayId,
    displayed: record['displayed'],
    at,
    ...(reason === undefined ? {} : { reason })
  }
}
