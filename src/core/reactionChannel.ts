import type { AppConfig } from '../shared/config'
import type { LegacyExpression, LegacyMotion } from '../shared/petPresentation'
import type { ReactiveEventNotice } from '../shared/reaction'
import type { CompanionMetrics } from './companionMetrics'
import type { Logger } from './types'

/**
 * 即时反应层：把已脱敏的外部变化快速映射成 dsh-pet 动作。
 *
 * 它不生成任何台词，也不判断内容语义；只表达「注意到了变化」。
 * 本地动作与模型事件对话相互独立：动作不等待模型，模型仍可在
 * `reaction` 唤醒里选择发言、继续共同任务或保持安静。
 */

export interface LocalReactionCue {
  expression?: LegacyExpression
  motion?: LegacyMotion
  durationMs: number
  /** 仅供诊断的枚举标签，不进入用户界面。 */
  label: string
}

export interface ReactionTrace {
  stage: 'decision' | 'reaction'
  /** 固定枚举：suppressed/candidate/coalesced/local-action/render-rejected。 */
  outcome: string
  /** 固定枚举原因。 */
  reason: string
}

export interface ReactionChannelOptions {
  getConfig: () => AppConfig
  metrics: CompanionMetrics
  logger: Logger
  /** 真正播放本地动作；通常走 PetWorld 的展示 sink。 */
  emit: (cue: LocalReactionCue, notice: ReactiveEventNotice) => void
  /**
   * 是否允许本地直接播放装饰动作。生产路径关闭：事件仍被感知并交给模型，
   * 但是否动作由模型在自主轮决定。默认 true 保留旧调用/测试语义。
   */
  autoEmit?: boolean
  /**
   * 诊断钩子：记录本地反应层的决策。只传事件引用与固定枚举，不传正文；
   * 场景事件会据此补齐 decision → reaction 诊断链。
   */
  onTrace?: (notice: ReactiveEventNotice, trace: ReactionTrace) => void
  now?: () => number
}

interface PendingReaction {
  notice: ReactiveEventNotice
  receivedAt: number
  firstAt: number
  merged: number
  timer: NodeJS.Timeout
}

/**
 * 快速连续切换合并窗口；从最新事件重新计时，但总等待有上限。
 *
 * 目标是「事件进入反应层到可见动作」< 300 ms，因此合并窗口本身必须
 * 留出调度余量，不能把 300 ms 全部花在等待上。持续变化最多等 280 ms，
 * 仍能合并短促抖动，又不会把第一个事件压到目标之外。
 */
const COALESCE_MS = 220
const MAX_COALESCE_MS = 280

interface CueTemplate {
  expression?: LegacyExpression
  motion: LegacyMotion
  durationMs: number
}

const CUE_BY_CHANGE: Record<string, CueTemplate> = {
  window_open: { expression: 'surprised', motion: 'look', durationMs: 900 },
  window_change: { expression: 'thinking', motion: 'nod', durationMs: 900 },
  content_change: { expression: 'thinking', motion: 'look', durationMs: 1100 },
  page_open: { expression: 'thinking', motion: 'turn', durationMs: 900 },
  page_change: { expression: 'thinking', motion: 'look', durationMs: 1100 },
  scene_enter: { expression: 'surprised', motion: 'turn', durationMs: 1000 },
  scene_change: { expression: 'thinking', motion: 'look', durationMs: 1000 },
  idle_return: { expression: 'happy', motion: 'wave', durationMs: 1600 },
  resume: { expression: 'happy', motion: 'wave', durationMs: 1600 },
  day_first: { expression: 'happy', motion: 'wave', durationMs: 1600 }
}

/**
 * 应用切换不再一律 `look`。按目标摘要稳定地选一个短反应：同一目标每次
 * 表现一致，不同应用之间又能看出转向、探看和点头的差别。这里不做随机
 * 跳舞，也不读取标题内容。
 */
const APP_SWITCH_CUES: CueTemplate[] = [
  { expression: 'thinking', motion: 'turn', durationMs: 900 },
  { expression: 'thinking', motion: 'look', durationMs: 800 },
  { motion: 'nod', durationMs: 700 },
  { expression: 'surprised', motion: 'look', durationMs: 800 }
]

function cueIndex(key: string, length: number): number {
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0
  }
  return hash % length
}

function cueFor(notice: ReactiveEventNotice): CueTemplate | undefined {
  if (notice.changeType === 'app_switch') {
    return APP_SWITCH_CUES[
      cueIndex(`${notice.targetRef ?? ''}|${notice.appLabel ?? ''}|${notice.category ?? ''}`, APP_SWITCH_CUES.length)
    ]
  }
  return CUE_BY_CHANGE[notice.changeType]
}

export class ReactionChannel {
  private readonly getConfig: () => AppConfig
  private readonly metrics: CompanionMetrics
  private readonly logger: Logger
  private readonly emit: (cue: LocalReactionCue, notice: ReactiveEventNotice) => void
  private readonly autoEmit: boolean
  private readonly onTrace: ((notice: ReactiveEventNotice, trace: ReactionTrace) => void) | null
  private readonly now: () => number

  private pending: PendingReaction | null = null
  private lastLocalAt = 0
  private readonly recentEvidence = new Map<string, number>()
  private received = 0
  private emitted = 0
  private lastSuppressedReason: string | null = null

  constructor(options: ReactionChannelOptions) {
    this.getConfig = options.getConfig
    this.metrics = options.metrics
    this.logger = options.logger
    this.emit = options.emit
    this.autoEmit = options.autoEmit !== false
    this.onTrace = options.onTrace ?? null
    this.now = options.now ?? (() => Date.now())
  }

  /** World 的真实事件进入本地反应层。调用方已保证文本/引用已脱敏。 */
  note(notice: ReactiveEventNotice): void {
    const config = this.getConfig().companion.reaction
    if (!config.enabled) {
      this.trace(notice, 'decision', 'suppressed', 'disabled')
      return
    }
    const now = this.now()
    if (notice.actionAttribution === 'pet') {
      this.metrics.noteReaction('own-action-suppressed', 'self-action')
      this.lastSuppressedReason = 'own-action'
      this.trace(notice, 'decision', 'suppressed', 'own-action')
      return
    }
    if (now > notice.expiresAt) {
      this.metrics.noteReaction('expired', 'ttl')
      this.lastSuppressedReason = 'expired'
      this.trace(notice, 'decision', 'suppressed', 'expired')
      return
    }
    this.received += 1
    this.pruneEvidence(now)
    const lastEvidence = this.recentEvidence.get(notice.evidenceRef)
    if (lastEvidence !== undefined && now - lastEvidence < config.dedupeMs) {
      // 采样时已经发过同一证据的即时提示；正式事件只是合并后的同一次变化，
      // 不能再算一个新候选，否则候选数会被同一次切换抬高。
      this.metrics.noteReaction('deduped', 'dedupe')
      this.lastSuppressedReason = 'deduped'
      this.trace(notice, 'decision', 'suppressed', 'dedupe')
      return
    }
    this.recentEvidence.set(notice.evidenceRef, now)
    this.metrics.noteReaction('candidate', notice.changeType)
    this.trace(notice, 'decision', 'candidate', notice.changeType)

    if (this.pending !== null) {
      this.pending.notice = notice
      this.pending.merged += 1
      this.metrics.noteReaction('coalesced', 'pending')
      this.lastSuppressedReason = 'coalesced'
      this.trace(notice, 'decision', 'coalesced', 'pending')
      const wait = Math.min(COALESCE_MS, this.pending.firstAt + MAX_COALESCE_MS - now)
      this.schedule(this.pending, Math.max(0, wait))
      return
    }
    const pending: PendingReaction = {
      notice,
      receivedAt: now,
      firstAt: now,
      merged: 0,
      timer: setTimeout(() => undefined, 0)
    }
    pending.timer = this.schedule(pending, COALESCE_MS)
    this.pending = pending
  }

  /** 停止时丢弃尚未播出的动作；过期事件绝不补播。 */
  stop(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending.timer)
      this.pending = null
    }
    this.recentEvidence.clear()
  }

  diagnostics(): Record<string, unknown> {
    return {
      received: this.received,
      emitted: this.emitted,
      pending: this.pending !== null,
      lastLocalAt: this.lastLocalAt > 0 ? this.lastLocalAt : null,
      lastSuppressedReason: this.lastSuppressedReason,
      recentEvidence: this.recentEvidence.size
    }
  }

  private schedule(pending: PendingReaction, delayMs: number): NodeJS.Timeout {
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    const handle = setTimeout(() => {
      if (this.pending !== pending) return
      this.pending = null
      this.flush(pending)
    }, Math.max(0, Math.round(delayMs)))
    handle.unref?.()
    // 合并窗口会随最新事件重新计时；必须把新句柄写回，否则下一次
    // schedule 清不掉这个定时器，旧窗口会提前触发。
    pending.timer = handle
    return handle
  }

  private flush(pending: PendingReaction): void {
    const now = this.now()
    const notice = pending.notice
    if (now > notice.expiresAt) {
      this.metrics.noteReaction('expired', 'ttl')
      this.lastSuppressedReason = 'expired'
      this.trace(notice, 'decision', 'suppressed', 'expired-before-flush')
      return
    }
    const cue = cueFor(notice)
    if (cue === undefined) {
      this.trace(notice, 'decision', 'suppressed', 'no-cue')
      return
    }
    if (!this.autoEmit) {
      // 事件已经进入感知与模型通知；本地只记录「需由模型决定」。
      this.lastSuppressedReason = 'model-decision-required'
      this.metrics.noteReaction('model-decision-required', notice.changeType)
      this.trace(notice, 'reaction', 'deferred', 'model-decision-required')
      return
    }
    // 不再有固定的本地动作冷却。dsh-pet 动画层会按优先级合并、替换或延后；
    // 事件层如果在这里用 8 秒窗口丢弃，就会把有效的第二次反馈变成“没反应”。
    this.lastLocalAt = now
    this.emitted += 1
    try {
      this.emit(
        {
          ...cue,
          label: notice.changeType
        },
        notice
      )
      this.metrics.noteReaction('local-action', notice.changeType)
      this.metrics.noteReactionLatency(now - pending.receivedAt)
      this.metrics.noteReactionEventAge(now - notice.at)
      this.trace(notice, 'reaction', 'local-action', notice.changeType)
    } catch (error) {
      // 只有真正播放失败才记为 render-rejected；不再因频率规则丢事件。
      this.metrics.noteReaction('render-rejected', 'emit-failed')
      this.lastSuppressedReason = 'render-rejected'
      this.trace(notice, 'reaction', 'render-rejected', 'emit-failed')
      this.logger.warn('本地反应动作播放失败', { error: String(error).slice(0, 200) })
    }
  }

  private trace(
    notice: ReactiveEventNotice,
    stage: ReactionTrace['stage'],
    outcome: string,
    reason: string
  ): void {
    if (this.onTrace === null) return
    try {
      this.onTrace(notice, { stage, outcome, reason })
    } catch (error) {
      this.logger.warn('反应诊断记录失败', { error: String(error).slice(0, 200) })
    }
  }

  private pruneEvidence(now: number): void {
    const ttl = Math.max(60_000, this.getConfig().companion.reaction.dedupeMs * 2)
    for (const [key, at] of this.recentEvidence) {
      if (now - at > ttl) this.recentEvidence.delete(key)
    }
  }
}
