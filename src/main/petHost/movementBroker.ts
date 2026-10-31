import { randomUUID } from 'node:crypto'
import {
  isMovementAnimationId,
  type PetMovementOutcome,
  type PetMovementReceipt,
  type PetMovementRequest,
  type PetMovementStatus,
  type PetRequestClass
} from '../../shared/petPresentation'

/**
 * 移动的「主进程 → 宠物页 → 回执」桥。
 *
 * 发送 IPC 成功不代表真的开始移动。工具必须等页面 `started`（素材已出画、
 * 坐标驱动已启动）或 `already_at_target/blocked/interrupted/failed`；
 * `completed` 是到达终态，允许晚于工具回复通过回执事件继续反馈。
 */

const DEFAULT_TIMEOUT_MS = 8_000
const RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  'accepted',
  'started',
  'completed',
  'already_at_target',
  'blocked',
  'interrupted',
  'failed'
])

/** 一旦收到这些状态，工具调用就可以得到确定结果。 */
const RESOLVING_STATUSES: ReadonlySet<PetMovementStatus> = new Set([
  'started',
  'completed',
  'already_at_target',
  'blocked',
  'interrupted',
  'failed'
])

interface Pending {
  request: PetMovementRequest
  resolve: (outcome: PetMovementOutcome) => void
  timer: NodeJS.Timeout
}

/** 供回执观察者关联请求类别的脱敏元数据。 */
export interface PetMovementRequestMeta {
  requestId: string
  animationId: string
  requestClass: PetRequestClass
  autonomous: boolean
}

export interface PetMovementBrokerOptions {
  /** 把请求送到宠物页；返回 false 表示当前没有可用页面。 */
  send: (request: PetMovementRequest) => boolean
  now?: () => number
  timeoutMs?: number
  /** 终态回执（started 之后的 completed/interrupted）用于状态条/诊断。 */
  onReceipt?: (receipt: PetMovementReceipt, meta: PetMovementRequestMeta | null) => void
}

export class PetMovementBroker {
  private readonly send: (request: PetMovementRequest) => boolean
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly onReceipt:
    | ((receipt: PetMovementReceipt, meta: PetMovementRequestMeta | null) => void)
    | undefined
  private readonly pending = new Map<string, Pending>()
  private readonly recentMeta = new Map<string, PetMovementRequestMeta>()
  private lastReceipt: PetMovementReceipt | null = null

  constructor(options: PetMovementBrokerOptions) {
    this.send = options.send
    this.now = options.now ?? (() => Date.now())
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.onReceipt = options.onReceipt
  }

  get last(): PetMovementReceipt | null {
    return this.lastReceipt
  }

  /** 目标/素材在进入页面之前就校验；不合法时不产生「已发送」的假象。 */
  request(input: {
    target: number
    animationId: string
    autonomous: boolean
    requestClass?: PetRequestClass
    dedupeKey?: string
    expiresAt?: number
  }): Promise<PetMovementOutcome> {
    if (!Number.isFinite(input.target) || input.target < 0 || input.target > 1) {
      return Promise.resolve({
        status: 'failed',
        animationId: input.animationId,
        target: input.target,
        reason: 'invalid-target'
      })
    }
    if (!isMovementAnimationId(input.animationId)) {
      return Promise.resolve({
        status: 'failed',
        animationId: input.animationId,
        target: input.target,
        reason: 'invalid-animation'
      })
    }
    const request: PetMovementRequest = {
      requestId: randomUUID(),
      target: input.target,
      animationId: input.animationId,
      autonomous: input.autonomous,
      ...(input.requestClass === undefined ? {} : { requestClass: input.requestClass }),
      ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      createdAt: this.now()
    }
    this.rememberMeta(request)
    return new Promise<PetMovementOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(request.requestId, {
          status: 'failed',
          animationId: request.animationId,
          target: request.target,
          reason: 'timeout'
        })
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(request.requestId, { request, resolve, timer })
      let delivered = false
      try {
        delivered = this.send(request)
      } catch {
        delivered = false
      }
      if (!delivered) {
        this.finish(request.requestId, {
          status: 'failed',
          animationId: request.animationId,
          target: request.target,
          reason: 'page-unavailable'
        })
      }
    })
  }

  /** 页面回执入口；未知/过期 requestId 仍更新诊断但不影响已结束的调用。 */
  handleReceipt(raw: unknown): boolean {
    const receipt = normalizeMovementReceipt(raw, this.now())
    if (receipt === null) return false
    this.lastReceipt = receipt
    this.onReceipt?.(receipt, this.recentMeta.get(receipt.requestId) ?? null)
    if (receipt.status === 'accepted') return true
    const pending = this.pending.get(receipt.requestId)
    if (pending === undefined) return true
    if (RESOLVING_STATUSES.has(receipt.status)) {
      this.finish(receipt.requestId, {
        status: receipt.status,
        animationId: receipt.animationId,
        target: receipt.target,
        ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
        ...(receipt.xRatio === undefined ? {} : { xRatio: receipt.xRatio }),
        ...(receipt.facing === undefined ? {} : { facing: receipt.facing }),
        ...(receipt.reachableMinRatio === undefined
          ? {}
          : { reachableMinRatio: receipt.reachableMinRatio }),
        ...(receipt.reachableMaxRatio === undefined
          ? {}
          : { reachableMaxRatio: receipt.reachableMaxRatio })
      })
    }
    return true
  }

  /** 页面重载/窗口关闭时让所有等待方立即结束，并清理超时器。 */
  cancelAll(reason: string): void {
    for (const id of Array.from(this.pending.keys())) {
      const pending = this.pending.get(id)
      if (pending === undefined) continue
      this.finish(id, {
        status: 'failed',
        animationId: pending.request.animationId,
        target: pending.request.target,
        reason
      })
    }
  }

  private finish(requestId: string, outcome: PetMovementOutcome): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve({ ...outcome, requestId })
  }

  private rememberMeta(request: PetMovementRequest): void {
    this.recentMeta.delete(request.requestId)
    this.recentMeta.set(request.requestId, {
      requestId: request.requestId,
      animationId: request.animationId,
      requestClass:
        request.requestClass ??
        (request.autonomous ? 'model-decorative' : 'user-explicit'),
      autonomous: request.autonomous
    })
    while (this.recentMeta.size > 128) {
      const oldest = this.recentMeta.keys().next().value
      if (oldest === undefined) break
      this.recentMeta.delete(oldest)
    }
  }
}

function normalizeMovementReceipt(raw: unknown, now: number): PetMovementReceipt | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const requestId = typeof record['requestId'] === 'string' ? record['requestId'] : ''
  const animationId = typeof record['animationId'] === 'string' ? record['animationId'] : ''
  const status = typeof record['status'] === 'string' ? record['status'] : ''
  const target = record['target']
  if (requestId === '' || requestId.length > 80) return null
  if (animationId === '' || animationId.length > 120) return null
  if (!RECEIPT_STATUSES.has(status)) return null
  if (typeof target !== 'number' || !Number.isFinite(target) || target < 0 || target > 1) {
    return null
  }
  const at = typeof record['at'] === 'number' && Number.isFinite(record['at']) ? record['at'] : now
  const reason =
    typeof record['reason'] === 'string' ? record['reason'].slice(0, 120) : undefined
  const xRatio =
    typeof record['xRatio'] === 'number' &&
    Number.isFinite(record['xRatio']) &&
    record['xRatio'] >= 0 &&
    record['xRatio'] <= 1
      ? record['xRatio']
      : undefined
  const facing =
    record['facing'] === 'left' || record['facing'] === 'right'
      ? record['facing']
      : undefined
  const ratio = (key: string): number | undefined => {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : undefined
  }
  const reachableMinRatio = ratio('reachableMinRatio')
  const rawMax = ratio('reachableMaxRatio')
  const reachableMaxRatio =
    reachableMinRatio !== undefined && rawMax !== undefined && rawMax < reachableMinRatio
      ? reachableMinRatio
      : rawMax
  return {
    requestId,
    animationId,
    target,
    status: status as PetMovementStatus,
    at,
    ...(reason === undefined ? {} : { reason }),
    ...(xRatio === undefined ? {} : { xRatio }),
    ...(facing === undefined ? {} : { facing }),
    ...(reachableMinRatio === undefined ? {} : { reachableMinRatio }),
    ...(reachableMaxRatio === undefined ? {} : { reachableMaxRatio })
  }
}
