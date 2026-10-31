import type { BatchingConfig } from '../shared/config'
import type { Clock, EventEnvelope, TriggerMode } from './types'
import { systemClock } from './util'

export interface QueuedEvent {
  env: EventEnvelope
  mode: TriggerMode
  firstAt: number
  lastAt: number
}

export interface Batch {
  events: EventEnvelope[]
  modes: TriggerMode[]
  /** 批次里是否有 flush/interrupt/preempt 这种“立即”触发。 */
  urgent: boolean
}

export interface WakeBusOptions {
  batching: BatchingConfig
  onReady: () => void
  clock?: Clock
}

/**
 * 事件总线（PLAN.md §2.2）。五种触发 + 合批 + 单消费者 FIFO。
 *
 * WakeBus 只负责排队与决定“什么时候可以取一批”；模型轮本身由 MainLoop
 * 单消费者执行。urgent 事件通过 onReady 唤醒；debounce 事件按 Cortico 的
 * 合批公式计算到期时刻；piggyback 只搭下一批的便车，不单独唤醒。
 */
export class WakeBus {
  private readonly batching: BatchingConfig
  private readonly onReady: () => void
  private readonly clock: Clock
  private queue: QueuedEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private pausedFlag = false

  constructor(options: WakeBusOptions) {
    this.batching = options.batching
    this.onReady = options.onReady
    this.clock = options.clock ?? systemClock
  }

  get size(): number {
    return this.queue.length
  }

  get paused(): boolean {
    return this.pausedFlag
  }

  push(env: EventEnvelope, mode: TriggerMode): void {
    const now = this.clock.now()
    const queued: QueuedEvent = { env, mode, firstAt: now, lastAt: now }
    this.queue.push(queued)
    this.queue.sort((a, b) => a.env.cursor - b.env.cursor)
    if (this.pausedFlag) return
    if (mode === 'preempt' || mode === 'interrupt' || mode === 'flush') {
      this.onReady()
      return
    }
    if (mode === 'debounce' && this.queue.length >= this.batching.maxBatchSize) {
      this.onReady()
    }
    this.schedule()
  }

  /**
   * 把游标不超过 cursor 的 piggyback 事件提升为 flush。
   * 用于审批解决后立即投递排队中的用户消息。
   */
  promote(cursor: number): void {
    let changed = false
    for (const item of this.queue) {
      if (item.env.cursor <= cursor && item.mode === 'piggyback') {
        item.mode = 'flush'
        changed = true
      }
    }
    if (changed && !this.pausedFlag) this.onReady()
  }

  /**
   * 只提升满足条件的 piggyback 事件。WakeGovernor 用它提升自主唤醒，
   * 不会误把等待审批的用户消息一起提前。
   */
  promoteMatching(predicate: (entry: QueuedEvent) => boolean): boolean {
    let changed = false
    for (const item of this.queue) {
      if (item.mode === 'piggyback' && predicate(item)) {
        item.mode = 'flush'
        changed = true
      }
    }
    if (changed && !this.pausedFlag) this.onReady()
    return changed
  }

  /**
   * 丢弃已过期的事件。事件对话的旧评论绝不能等到用户忙完后再补说，
   * 因此过期判断在入队、提升和取批前都要执行。
   */
  discardExpired(now = this.clock.now()): number {
    const before = this.queue.length
    this.queue = this.queue.filter((item) => {
      const expiresAt = item.env.meta?.['expiresAt']
      return typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt > now
    })
    const removed = before - this.queue.length
    if (removed > 0) this.schedule()
    return removed
  }

  /** 丢弃仍排队、但已经不属于当前情境的事件（如用户已切换到别的任务）。 */
  discardMatching(predicate: (entry: QueuedEvent) => boolean): number {
    const before = this.queue.length
    this.queue = this.queue.filter((item) => !predicate(item))
    const removed = before - this.queue.length
    if (removed > 0) this.schedule()
    return removed
  }

  /** 人工暂停：阻止投递，事件照常入队。 */
  pause(): void {
    this.pausedFlag = true
    this.clearTimer()
  }

  resume(): void {
    if (!this.pausedFlag) return
    this.pausedFlag = false
    if (this.queue.length > 0) {
      this.onReady()
      this.schedule()
    }
  }

  /**
   * 取一批。若当前没有到期/紧急事件，返回 null；调用方应在空闲时反复调用。
   * 有任一 urgent 或 debounce 到期 → 投递整个积压（FIFO，受 maxBatchSize 限制）。
   */
  takeBatch(): Batch | null {
    if (this.pausedFlag) return null
    this.discardExpired(this.clock.now())
    if (this.queue.length === 0) return null
    const now = this.clock.now()
    const hasUrgent = this.queue.some((item) => isUrgent(item.mode))
    const dueDebounce = this.queue.some((item) => item.mode === 'debounce' && this.dueAt(item) <= now)
    const sizeTrigger = this.queue.length >= this.batching.maxBatchSize
    const onlyPiggyback = this.queue.every((item) => item.mode === 'piggyback')
    if (!hasUrgent && !dueDebounce && !sizeTrigger) return null
    if (onlyPiggyback) {
      // piggyback 不单独触发模型：等下一批。
      return null
    }
    const picked = this.queue.slice(0, this.batching.maxBatchSize)
    this.queue = this.queue.slice(picked.length)
    const modes = [...new Set(picked.map((item) => item.mode))]
    this.schedule()
    return {
      events: picked.map((item) => item.env),
      modes,
      urgent: modes.some(isUrgent)
    }
  }

  /** 早于此刻的 debounce 合批到期时间（诊断/测试用）。 */
  nextDueAt(): number | null {
    if (this.pausedFlag) return null
    const debounce = this.queue.filter((item) => item.mode === 'debounce')
    if (debounce.length === 0) {
      return this.queue.some((item) => isUrgent(item.mode)) ? this.clock.now() : null
    }
    return Math.min(...debounce.map((item) => this.dueAt(item)))
  }

  peek(): QueuedEvent[] {
    return this.queue.map((item) => ({ ...item }))
  }

  clear(): void {
    this.queue = []
    this.clearTimer()
  }

  // -------------------------------------------------------------------------

  private dueAt(item: QueuedEvent): number {
    const debounceItems = this.queue.filter((entry) => entry.mode === 'debounce')
    const firstAt = debounceItems.length > 0 ? Math.min(...debounceItems.map((entry) => entry.firstAt)) : item.firstAt
    const lastAt = debounceItems.length > 0 ? Math.max(...debounceItems.map((entry) => entry.lastAt)) : item.lastAt
    return Math.min(
      firstAt + this.batching.maxBatchAgeMs,
      Math.max(firstAt + this.batching.minBatchAgeMs, lastAt + this.batching.quietGapMs)
    )
  }

  private schedule(): void {
    this.clearTimer()
    if (this.pausedFlag || this.queue.length === 0) return
    const due = this.nextDueAt()
    if (due === null) return
    const delay = Math.max(0, due - this.clock.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.onReady()
    }, delay)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

export function isUrgent(mode: TriggerMode): boolean {
  return mode === 'preempt' || mode === 'interrupt' || mode === 'flush'
}
