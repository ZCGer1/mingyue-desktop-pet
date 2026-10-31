import { randomUUID } from 'node:crypto'
import type { DesktopLeaseKind } from './toolMeta'
import type { Logger } from './types'

/**
 * 桌面输入仲裁（PLAN.md §5）。
 *
 * 同一时刻只允许一个持有者观察/操作桌面。优先级 user > quick > task > system，
 * 同级 FIFO。高优先级可以抢占低优先级；用户真实接管或紧急停止会立即吊销
 * 当前租约，并进入「等用户确认」保持期，任务不会自动抢回。
 */

export type DesktopActor = 'user-chat' | 'quick-chat' | 'task' | 'system'
export type DesktopPriority = 'user' | 'quick' | 'task' | 'system'

export interface DesktopLeaseRequest {
  owner: DesktopActor
  priority: DesktopPriority
  kind: DesktopLeaseKind
  taskId?: string
  taskGeneration?: number
  signal: AbortSignal
  ttlMs?: number
  /** 被抢占/看门狗超时/用户接管时调用；用于中止正在执行的工具。 */
  abort?: () => void
  /** 仅用于诊断，不包含窗口标题或输入内容。 */
  label?: string
}

export interface DesktopLease {
  id: string
  owner: DesktopActor
  priority: DesktopPriority
  kind: DesktopLeaseKind
  taskId?: string
  acquiredAt: number
  release(): void
}

export type AcquireDeniedReason =
  | 'locked'
  | 'takeover-hold'
  | 'aborted'
  | 'disposed'
  | 'preempted'

export type AcquireResult =
  | { ok: true; lease: DesktopLease }
  | { ok: false; reason: AcquireDeniedReason; message: string }

interface QueuedRequest {
  request: DesktopLeaseRequest
  priority: number
  seq: number
  resolve: (result: AcquireResult) => void
  onAbort: () => void
}

interface CurrentLease {
  id: string
  request: DesktopLeaseRequest
  priority: number
  acquiredAt: number
  timer: ReturnType<typeof setTimeout> | null
}

const PRIORITY: Record<DesktopPriority, number> = {
  user: 3,
  quick: 2,
  task: 1,
  system: 0
}

const DEFAULT_TTL_MS: Record<DesktopLeaseKind, number> = {
  observe: 10_000,
  input: 15_000,
  launch: 20_000
}

export interface DesktopCoordinatorOptions {
  logger: Logger
  now?: () => number
  /** 默认 3000ms；来自 autonomy.takeoverCooldownMs。 */
  takeoverCooldownMs?: number
  onPreempt?: (info: { owner: DesktopActor; priority: DesktopPriority; reason: string }) => void
}

export class DesktopActionCoordinator {
  private readonly logger: Logger
  private readonly now: () => number
  private readonly takeoverCooldownMs: number
  private readonly onPreempt: DesktopCoordinatorOptions['onPreempt'] | null
  private current: CurrentLease | null = null
  private queue: QueuedRequest[] = []
  private seq = 0
  private holdUntilUser = false
  private holdReason: string | null = null
  private cooldownUntil = 0
  private locked = false
  private lockReason: string | null = null
  private disposed = false
  private deniedCount = 0
  private preemptCount = 0

  constructor(options: DesktopCoordinatorOptions) {
    this.logger = options.logger
    this.now = options.now ?? (() => Date.now())
    this.takeoverCooldownMs = Math.max(0, options.takeoverCooldownMs ?? 3_000)
    this.onPreempt = options.onPreempt ?? null
  }

  acquire(request: DesktopLeaseRequest): Promise<AcquireResult> {
    const denial = this.denyReason(request)
    if (denial !== null) {
      this.deniedCount += 1
      return Promise.resolve({ ok: false, ...denial })
    }
    if (request.signal.aborted) {
      return Promise.resolve({
        ok: false,
        reason: 'aborted',
        message: '操作已取消。'
      })
    }
    if (this.current === null) {
      return Promise.resolve({ ok: true, lease: this.grant(request) })
    }

    const incoming = PRIORITY[request.priority]
    const current = this.current
    if (incoming > current.priority) {
      this.preempt(current, `${request.owner} 优先`)
      return Promise.resolve({ ok: true, lease: this.grant(request) })
    }

    return new Promise<AcquireResult>((resolve) => {
      const onAbort = (): void => {
        this.queue = this.queue.filter((entry) => entry.onAbort !== onAbort)
        resolve({ ok: false, reason: 'aborted', message: '操作已取消。' })
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.queue.push({
        request,
        priority: incoming,
        seq: this.seq++,
        resolve: (result) => {
          request.signal.removeEventListener('abort', onAbort)
          resolve(result)
        },
        onAbort
      })
    })
  }

  /** 用户真实接管鼠标/键盘，或按下紧急停止。 */
  hold(reason: string): void {
    this.holdUntilUser = true
    this.holdReason = reason
    this.cooldownUntil = this.now() + this.takeoverCooldownMs
    if (this.current !== null) this.preempt(this.current, `用户接管：${reason}`)
    this.denyQueued(
      (entry) => PRIORITY[entry.request.priority] <= PRIORITY.task,
      'takeover-hold',
      '用户接管了桌面；任务需要你确认后才能继续。'
    )
    this.logger.info('桌面进入用户接管保持期', { reason: reason.slice(0, 80) })
  }

  /** 用户发送新消息、快捷聊天或显式恢复任务时解除保持期。 */
  noteUserActivity(): void {
    if (!this.holdUntilUser) return
    this.holdUntilUser = false
    this.holdReason = null
    this.cooldownUntil = 0
    this.logger.info('用户已回到桌面，解除接管保持期')
    this.pump()
  }

  lock(reason: string): void {
    this.locked = true
    this.lockReason = reason
    if (this.current !== null) this.preempt(this.current, `锁定：${reason}`)
    this.denyQueued(() => true, 'locked', '桌面已锁定，暂不执行电脑操作。')
    this.logger.info('桌面租约已锁定', { reason: reason.slice(0, 80) })
  }

  unlock(): void {
    if (!this.locked) return
    this.locked = false
    this.lockReason = null
    this.pump()
  }

  dispose(): void {
    this.disposed = true
    if (this.current !== null) this.preempt(this.current, '退出')
    this.denyQueued(() => true, 'disposed', '应用正在退出。')
    this.queue = []
  }

  status(): {
    held: boolean
    heldBy: DesktopActor | null
    kind: DesktopLeaseKind | null
    taskId: string | null
    queued: number
    userHold: boolean
    userHoldReason: string | null
    heldUntilUser: boolean
    locked: boolean
    lockReason: string | null
    deniedCount: number
    preemptCount: number
  } {
    return {
      held: this.current !== null,
      heldBy: this.current?.request.owner ?? null,
      kind: this.current?.request.kind ?? null,
      taskId: this.current?.request.taskId ?? null,
      queued: this.queue.length,
      userHold: this.holdUntilUser,
      userHoldReason: this.holdReason,
      heldUntilUser: this.holdUntilUser,
      locked: this.locked,
      lockReason: this.lockReason,
      deniedCount: this.deniedCount,
      preemptCount: this.preemptCount
    }
  }

  // ------------------------------------------------------------------

  private denyReason(request: DesktopLeaseRequest): {
    reason: AcquireDeniedReason
    message: string
  } | null {
    if (this.disposed) {
      return { reason: 'disposed', message: '应用正在退出，不能执行电脑操作。' }
    }
    if (this.locked) {
      return {
        reason: 'locked',
        message: '桌面已锁定或应用已暂停，暂不执行电脑操作。'
      }
    }
    if (
      this.holdUntilUser &&
      PRIORITY[request.priority] <= PRIORITY.task
    ) {
      return {
        reason: 'takeover-hold',
        message: '用户接管了桌面；任务需要你确认后才能继续，不能自动抢回。'
      }
    }
    return null
  }

  private grant(request: DesktopLeaseRequest): DesktopLease {
    const id = randomUUID()
    const ttl = clampTtl(request.ttlMs ?? DEFAULT_TTL_MS[request.kind])
    const timer = setTimeout(() => {
      if (this.current?.id !== id) return
      this.logger.warn('桌面租约超时，已中止', {
        owner: request.owner,
        kind: request.kind
      })
      this.preempt(this.current, '租约超时')
    }, ttl)
    timer.unref?.()
    this.current = {
      id,
      request,
      priority: PRIORITY[request.priority],
      acquiredAt: this.now(),
      timer
    }
    this.logger.debug('桌面租约开始', {
      owner: request.owner,
      kind: request.kind,
      taskId: request.taskId ?? null
    })
    return {
      id,
      owner: request.owner,
      priority: request.priority,
      kind: request.kind,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      acquiredAt: this.current.acquiredAt,
      release: () => this.release(id)
    }
  }

  private release(id: string): void {
    if (this.current === null || this.current.id !== id) return
    if (this.current.timer !== null) clearTimeout(this.current.timer)
    this.current = null
    this.pump()
  }

  private preempt(current: CurrentLease, reason: string): void {
    if (this.current === null || this.current.id !== current.id) return
    this.preemptCount += 1
    if (current.timer !== null) clearTimeout(current.timer)
    this.current = null
    try {
      current.request.abort?.()
    } catch {
      /* 中止回调失败也要继续释放租约 */
    }
    try {
      this.onPreempt?.({
        owner: current.request.owner,
        priority: current.request.priority,
        reason
      })
    } catch {
      /* ignore */
    }
    this.logger.info('桌面租约被抢占', {
      owner: current.request.owner,
      kind: current.request.kind,
      reason: reason.slice(0, 80)
    })
    this.pump()
  }

  /** 释放后按优先级/FIFO 交给下一个可执行请求。 */
  private pump(): void {
    if (this.current !== null || this.disposed) return
    while (this.queue.length > 0) {
      let bestIndex = 0
      for (let i = 1; i < this.queue.length; i += 1) {
        const entry = this.queue[i]!
        const best = this.queue[bestIndex]!
        if (
          entry.priority > best.priority ||
          (entry.priority === best.priority && entry.seq < best.seq)
        ) {
          bestIndex = i
        }
      }
      const [entry] = this.queue.splice(bestIndex, 1)
      if (entry === undefined) continue
      if (entry.request.signal.aborted) {
        entry.resolve({ ok: false, reason: 'aborted', message: '操作已取消。' })
        continue
      }
      const denial = this.denyReason(entry.request)
      if (denial !== null) {
        entry.resolve({ ok: false, ...denial })
        continue
      }
      entry.resolve({ ok: true, lease: this.grant(entry.request) })
      return
    }
  }

  private denyQueued(
    predicate: (entry: QueuedRequest) => boolean,
    reason: AcquireDeniedReason,
    message: string
  ): void {
    const kept: QueuedRequest[] = []
    for (const entry of this.queue) {
      if (predicate(entry)) {
        entry.resolve({ ok: false, reason, message })
        entry.request.signal.removeEventListener('abort', entry.onAbort)
      } else {
        kept.push(entry)
      }
    }
    this.queue = kept
  }
}

function clampTtl(value: number): number {
  if (!Number.isFinite(value)) return 15_000
  return Math.min(120_000, Math.max(1_000, Math.round(value)))
}
