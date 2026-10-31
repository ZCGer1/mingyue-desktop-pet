import { randomUUID } from 'node:crypto'
import {
  classifyAnimationRequest,
  type PetAnimationOutcome,
  type PetAnimationReceipt,
  type PetAnimationReceiptStatus,
  type PetAnimationRequest,
  type PetAnimationSource,
  type PetAnimationMode,
  type PetRequestClass
} from '../../shared/petPresentation'

/**
 * 显式点播的「主进程 → 宠物页 → 回执」桥。
 *
 * 发送 IPC 成功不代表动画出画。工具调用必须等页面播放器回 `started`
 * （真实 play() 兑现）或 `unsupported/failed/interrupted`；超时或页面不可用
 * 也返回失败，绝不把「请求已发送」写成成功。
 */

const DEFAULT_TIMEOUT_MS = 8_000
const RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  'accepted',
  'queued',
  'started',
  'completed',
  'rejected',
  'interrupted',
  'unsupported',
  'failed'
])

export interface PetAnimationIntent {
  animationId: string
  mode: PetAnimationMode
  source: PetAnimationSource
  /** 可信来源推导；模型参数不能直接设置。 */
  autonomous?: boolean
  /** 可信请求类别；由调用路径推导，模型不能填写。 */
  requestClass?: PetRequestClass
  /** 同一轮/同一条消息的语义去重键；不含用户正文。 */
  dedupeKey?: string
  /** 墙钟过期时间；过期请求不做迟到补播。 */
  expiresAt?: number
  label?: string
}

/** 供回执观察者关联请求类别的脱敏元数据。 */
export interface PetAnimationRequestMeta {
  requestId: string
  animationId: string
  source: PetAnimationSource
  requestClass: PetRequestClass
  autonomous: boolean
}

interface Pending {
  request: PetAnimationRequest
  resolve: (outcome: PetAnimationOutcome) => void
  timer: NodeJS.Timeout
}

export interface PetAnimationBrokerOptions {
  /** 把请求送到宠物页；返回 false 表示当前没有可用页面。 */
  send: (request: PetAnimationRequest) => boolean
  now?: () => number
  timeoutMs?: number
  /**
   * 所有真实回执（含 started 之后的 completed/interrupted）的观察入口。
   * 用于前台活动优先级/诊断；不能改变工具调用的结算结果。
   */
  onReceipt?: (receipt: PetAnimationReceipt, meta: PetAnimationRequestMeta | null) => void
}

export class PetAnimationBroker {
  private readonly send: (request: PetAnimationRequest) => boolean
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly onReceipt:
    | ((receipt: PetAnimationReceipt, meta: PetAnimationRequestMeta | null) => void)
    | undefined
  private readonly pending = new Map<string, Pending>()
  /** 最近请求的脱敏元数据；迟到回执也要能识别来源类别。 */
  private readonly recentMeta = new Map<string, PetAnimationRequestMeta>()
  /** 最近一次真实回执，仅用于诊断，不进入模型上下文。 */
  private lastReceipt: PetAnimationReceipt | null = null

  constructor(options: PetAnimationBrokerOptions) {
    this.send = options.send
    this.now = options.now ?? (() => Date.now())
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.onReceipt = options.onReceipt
  }

  get last(): PetAnimationReceipt | null {
    return this.lastReceipt
  }

  /**
   * `deliver` 用于把请求嵌进其它事件（例如 pet_say 的气泡 + 动作）；
   * 不传则走构造时的 send。返回 false 表示页面当前不可用。
   */
  request(
    intent: PetAnimationIntent,
    deliver?: (request: PetAnimationRequest) => boolean
  ): Promise<PetAnimationOutcome> {
    const request: PetAnimationRequest = {
      requestId: randomUUID(),
      animationId: intent.animationId,
      mode: intent.mode,
      source: intent.source,
      createdAt: this.now(),
      ...(intent.autonomous === true ? { autonomous: true } : {}),
      ...(intent.requestClass === undefined ? {} : { requestClass: intent.requestClass }),
      ...(intent.dedupeKey === undefined ? {} : { dedupeKey: intent.dedupeKey.slice(0, 120) }),
      ...(intent.expiresAt === undefined ? {} : { expiresAt: intent.expiresAt }),
      ...(intent.label === undefined ? {} : { label: intent.label.slice(0, 80) })
    }
    this.rememberMeta(request)
    return new Promise<PetAnimationOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(request.requestId, {
          status: 'failed',
          animationId: request.animationId,
          reason: 'timeout'
        })
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(request.requestId, { request, resolve, timer })
      let delivered = false
      try {
        delivered = (deliver ?? this.send)(request)
      } catch {
        delivered = false
      }
      if (!delivered) {
        this.finish(request.requestId, {
          status: 'failed',
          animationId: request.animationId,
          reason: 'page-unavailable'
        })
      }
    })
  }

  /** 页面回执入口；未知/过期 requestId 直接丢弃。 */
  handleReceipt(raw: unknown): boolean {
    const receipt = normalizeReceipt(raw, this.now())
    if (receipt === null) return false
    this.lastReceipt = receipt
    this.onReceipt?.(receipt, this.recentMeta.get(receipt.requestId) ?? null)
    if (receipt.status === 'accepted') return true
    const pending = this.pending.get(receipt.requestId)
    if (pending === undefined) return true
    if (receipt.status === 'queued') {
      // 排队是当前这一轮调用的确定结果；稍后的 started 不会再次唤醒工具调用。
      this.finish(receipt.requestId, {
        status: receipt.status,
        animationId: receipt.animationId,
        ...(receipt.reason === undefined ? {} : { reason: receipt.reason })
      })
    } else if (receipt.status === 'started' || receipt.status === 'completed') {
      this.finish(receipt.requestId, {
        status: receipt.status,
        animationId: receipt.animationId,
        ...(receipt.reason === undefined ? {} : { reason: receipt.reason })
      })
    } else if (
      receipt.status === 'unsupported' ||
      receipt.status === 'failed' ||
      receipt.status === 'rejected' ||
      receipt.status === 'interrupted'
    ) {
      this.finish(receipt.requestId, {
        status: receipt.status,
        animationId: receipt.animationId,
        ...(receipt.reason === undefined ? {} : { reason: receipt.reason })
      })
    }
    return true
  }

  /** 页面重载/窗口关闭时让所有等待方立即结束。 */
  cancelAll(reason: string): void {
    for (const id of Array.from(this.pending.keys())) {
      const pending = this.pending.get(id)
      if (pending === undefined) continue
      this.finish(id, {
        status: 'failed',
        animationId: pending.request.animationId,
        reason
      })
    }
  }

  private finish(requestId: string, outcome: PetAnimationOutcome): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve({ ...outcome, requestId })
  }

  private rememberMeta(request: PetAnimationRequest): void {
    this.recentMeta.delete(request.requestId)
    this.recentMeta.set(request.requestId, {
      requestId: request.requestId,
      animationId: request.animationId,
      source: request.source,
      requestClass: classifyAnimationRequest({
        ...(request.requestClass === undefined ? {} : { requestClass: request.requestClass }),
        source: request.source,
        ...(request.autonomous === true ? { autonomous: true } : {})
      }),
      autonomous: request.autonomous === true
    })
    while (this.recentMeta.size > 128) {
      const oldest = this.recentMeta.keys().next().value
      if (oldest === undefined) break
      this.recentMeta.delete(oldest)
    }
  }
}

function normalizeReceipt(raw: unknown, now: number): PetAnimationReceipt | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const requestId = typeof record['requestId'] === 'string' ? record['requestId'] : ''
  const animationId = typeof record['animationId'] === 'string' ? record['animationId'] : ''
  const status = typeof record['status'] === 'string' ? record['status'] : ''
  if (requestId === '' || requestId.length > 80) return null
  if (animationId === '' || animationId.length > 120) return null
  if (!RECEIPT_STATUSES.has(status)) return null
  const at = typeof record['at'] === 'number' && Number.isFinite(record['at']) ? record['at'] : now
  const reason =
    typeof record['reason'] === 'string' ? record['reason'].slice(0, 120) : undefined
  return {
    requestId,
    animationId,
    status: status as PetAnimationReceiptStatus,
    at,
    ...(reason === undefined ? {} : { reason })
  }
}
