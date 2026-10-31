import type { AppConfig, CompanionCadence } from '../../shared/config'
import type { Logger } from '../../core/types'
import { inQuietHours } from '../../core/util'
import { quietEnd, type WakeDecision } from '../../core/wakeGovernor'

/** 只保留枚举原因，诊断日志里不出现任何正文。 */
export type CadenceDecisionReason =
  | 'quiet-hours'
  | 'speech-quiet'
  | 'topic-cooldown'
  | 'unanswered-backoff'
  | 'wake-gap'
  | 'user-cooldown'
  | 'busy'
  | 'paused'
  | 'pending-episode'
  | 'idle-away'
  | 'disabled'
  | 'no-real-event'
  | 'eligible'

export interface CadenceDecision {
  at: number
  kind: 'consider'
  reason: CadenceDecisionReason
}

export interface ChatCadenceOptions {
  getConfig: () => AppConfig
  isBusy: () => boolean
  isPaused: () => boolean
  /** 用户是否真的不在电脑前；只在 idlePauseTicks 开启时用于压制主动聊天。 */
  isUserAway?: () => boolean | Promise<boolean>
  /** 是否有一个真正等待用户回答的主动问题；评论/提议不算。 */
  hasOpenQuestion?: () => boolean
  /** 未回答问题的过期时刻；用于把下一次考虑排在它之后。 */
  openQuestionExpiresAt?: () => number | null
  /** 脱敏的兴趣/经历摘要；绝不包含页面正文、标题或绝对路径。 */
  describeCompanion?: () => string | null
  /** 注入 companion 唤醒；返回 WakeGovernor 的决策，便于按 defer 时间重排。 */
  inject: (text: string) => WakeDecision
  logger: Logger
  now?: () => number
  rng?: () => number
  onDecision?: (decision: CadenceDecision) => void
  onSpoke?: (at: number) => void
}

interface CadenceProfile {
  minMs: number
  maxMs: number
}

const MINUTE = 60_000
const RETRY_MS = 60_000
const MAX_DECISIONS = 20
const MAX_UNANSWERED = 4
const TOPIC_COOLDOWN_MS = 30 * MINUTE

/** 档位只决定自然节奏的间隔范围，不是每小时/每日次数上限。 */
export const CADENCE_PROFILES: Record<CompanionCadence, CadenceProfile> = {
  quiet: { minMs: 17 * MINUTE, maxMs: 37 * MINUTE },
  natural: { minMs: 5 * MINUTE, maxMs: 12 * MINUTE },
  lively: { minMs: 1 * MINUTE, maxMs: 5 * MINUTE }
}

const CADENCE_LABELS: Record<CompanionCadence, string> = {
  quiet: '安静',
  natural: '自然',
  lively: '活泼'
}

/**
 * 独立于自主探索的聊天节奏。
 *
 * 它只决定「什么时候给模型一次主动说话的机会」，不生成台词；模型仍可沉默。
 * 间隔带抖动，并按未回应次数指数退避；没有每小时/每日次数上限，档位只表达
 * 节奏偏好。探索暂停、安静时段与 speech quiet 都不会反过来冻结探索。
 */
export class ChatCadenceController {
  private readonly getConfig: () => AppConfig
  private readonly isBusy: () => boolean
  private readonly isPaused: () => boolean
  private readonly isUserAway: (() => boolean | Promise<boolean>) | undefined
  private readonly hasOpenQuestion: (() => boolean) | undefined
  private readonly openQuestionExpiresAt: (() => number | null) | undefined
  private readonly describeCompanion: (() => string | null) | undefined
  private readonly inject: (text: string) => WakeDecision
  private readonly logger: Logger
  private readonly now: () => number
  private readonly rng: () => number
  private readonly onDecision: ((decision: CadenceDecision) => void) | undefined
  private readonly onSpoke: ((at: number) => void) | undefined

  private timer: NodeJS.Timeout | null = null
  private next: number | null = null
  private started = false
  private firing = false
  private lastConsiderAt = 0
  private lastSpokeAt = 0
  private lastReason: CadenceDecisionReason | null = null
  private unansweredCount = 0
  private feedbackScale = 1
  private topicCooldownUntil = 0
  private speechQuietUntil = 0
  private readonly decisions: CadenceDecision[] = []

  constructor(opts: ChatCadenceOptions) {
    this.getConfig = opts.getConfig
    this.isBusy = opts.isBusy
    this.isPaused = opts.isPaused
    this.isUserAway = opts.isUserAway
    this.hasOpenQuestion = opts.hasOpenQuestion
    this.openQuestionExpiresAt = opts.openQuestionExpiresAt
    this.describeCompanion = opts.describeCompanion
    this.inject = opts.inject
    this.logger = opts.logger
    this.now = opts.now ?? (() => Date.now())
    this.rng = opts.rng ?? Math.random
    this.onDecision = opts.onDecision
    this.onSpoke = opts.onSpoke
  }

  get running(): boolean {
    return this.started
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.scheduleNext(this.now())
  }

  stop(): void {
    this.started = false
    this.clearTimer()
    this.next = null
  }

  /** 配置热更新/暂停恢复后重新排下一次考虑。 */
  refresh(): void {
    if (!this.started) return
    this.scheduleNext(this.now())
  }

  /** 用户发消息、快捷回复或触摸：重置未回应退避与话题冷却。 */
  noteUserActivity(now = this.now()): void {
    this.unansweredCount = 0
    this.feedbackScale = 1
    this.topicCooldownUntil = 0
    if (this.started) this.scheduleNext(now)
  }

  /** Episode 过期仍未回答：只累计退避，不阻断探索。 */
  noteUnanswered(now = this.now()): void {
    this.unansweredCount = Math.min(MAX_UNANSWERED, this.unansweredCount + 1)
    this.recordDecision(now, 'unanswered-backoff')
    if (this.started) this.scheduleAt(now + this.backoffDelay())
  }

  /** 她真的开口（任务/自主 pet_say）后调用；用于状态与诊断。 */
  noteSpoken(at = this.now()): void {
    this.lastSpokeAt = at
    this.onSpoke?.(at)
  }

  /** 用户的轻量反馈：只调整她自己的节奏，不涉及任何权限。 */
  noteFeedback(kind: 'more' | 'less' | 'stop_topic' | 'resume', at = this.now()): void {
    if (kind === 'more') {
      this.feedbackScale = Math.max(0.6, this.feedbackScale * 0.8)
      this.topicCooldownUntil = 0
    } else if (kind === 'less') {
      this.feedbackScale = Math.min(2.5, this.feedbackScale * 1.25)
    } else if (kind === 'stop_topic') {
      this.feedbackScale = 1
      this.topicCooldownUntil = at + TOPIC_COOLDOWN_MS
    } else {
      this.feedbackScale = 1
      this.topicCooldownUntil = 0
      this.unansweredCount = 0
    }
    if (this.started) this.scheduleNext(at)
  }

  /** pet_quiet：只压主动聊天；探索与任务不受影响。 */
  setSpeechQuietUntil(until: number | null, now = this.now()): void {
    this.speechQuietUntil =
      until === null || !Number.isFinite(until) || until <= now ? 0 : Math.floor(until)
    if (!this.started) return
    if (this.speechQuietUntil > now) this.scheduleAt(this.speechQuietUntil)
    else this.scheduleNext(now)
  }

  nextAt(): number | null {
    return this.next
  }

  /** 状态栏用：刚刚考虑过但还没有可见发言时，短暂显示“想说话”。 */
  wantsToTalk(now = this.now()): boolean {
    if (this.lastConsiderAt === 0 || this.lastReason !== 'eligible') return false
    if (this.hasOpenQuestion?.() === true) return false
    return now - this.lastConsiderAt <= 5 * MINUTE && now - this.lastSpokeAt > 5 * MINUTE
  }

  diagnostics(now = this.now()): Record<string, unknown> {
    const profile = this.profile()
    return {
      cadence: this.getConfig().companion.cadence,
      started: this.started,
      nextAt: this.next,
      lastConsiderAt: this.lastConsiderAt > 0 ? this.lastConsiderAt : null,
      lastSpokeAt: this.lastSpokeAt > 0 ? this.lastSpokeAt : null,
      lastReason: this.lastReason,
      unansweredCount: this.unansweredCount,
      feedbackScale: this.feedbackScale,
      speechQuietUntil: this.speechQuietUntil > now ? this.speechQuietUntil : null,
      topicCooldownUntil: this.topicCooldownUntil > now ? this.topicCooldownUntil : null,
      intervalMinutes: {
        min: Math.round(profile.minMs / MINUTE),
        max: Math.round(profile.maxMs / MINUTE)
      },
      unlimited: true,
      decisions: this.decisions.slice(-MAX_DECISIONS)
    }
  }

  clear(): void {
    this.clearTimer()
    this.unansweredCount = 0
    this.feedbackScale = 1
    this.topicCooldownUntil = 0
    this.speechQuietUntil = 0
    this.lastConsiderAt = 0
    this.lastSpokeAt = 0
    this.lastReason = null
    this.decisions.length = 0
    if (this.started) this.scheduleNext(this.now())
  }

  // ------------------------------------------------------------------

  private async fire(): Promise<void> {
    this.timer = null
    this.next = null
    if (!this.started || this.firing) return
    this.firing = true
    try {
      const config = this.getConfig()
      const now = this.now()
      this.lastConsiderAt = now

      if (!config.autonomy.enabled) {
        this.recordDecision(now, 'disabled')
        return
      }
      if (this.isPaused()) {
        this.recordDecision(now, 'paused')
        this.scheduleAt(now + RETRY_MS)
        return
      }
      if (this.isBusy()) {
        this.recordDecision(now, 'busy')
        this.scheduleAt(now + RETRY_MS)
        return
      }
      if (config.autonomy.respectQuietHours && inQuietHours(now, config.worlds.activity.quietHours)) {
        this.recordDecision(now, 'quiet-hours')
        const end = quietEnd(now, config.worlds.activity.quietHours)
        this.scheduleAt(end ?? now + RETRY_MS)
        return
      }
      if (now < this.speechQuietUntil) {
        this.recordDecision(now, 'speech-quiet')
        this.scheduleAt(this.speechQuietUntil)
        return
      }
      if (now < this.topicCooldownUntil) {
        this.recordDecision(now, 'topic-cooldown')
        this.scheduleAt(this.topicCooldownUntil)
        return
      }
      const unansweredBefore = this.unansweredCount
      if (this.hasOpenQuestion?.() === true) {
        this.recordDecision(now, 'pending-episode')
        const expiry = this.openQuestionExpiresAt?.() ?? null
        this.scheduleAt(
          expiry !== null && expiry > now ? Math.min(expiry, now + 5 * MINUTE) : now + RETRY_MS
        )
        return
      }
      // 这次检查可能刚好触发 Episode 过期清理，onUnanswered 已在同一调用栈里
      // 把退避次数加一并按退避重排；不能在同一拍立刻开新话题。
      if (this.unansweredCount > unansweredBefore) {
        if (this.next === null) this.scheduleAt(now + this.backoffDelay())
        return
      }
      if (config.autonomy.idlePauseTicks && this.isUserAway !== undefined) {
        let away = false
        try {
          away = (await this.isUserAway()) === true
        } catch {
          away = false
        }
        if (!this.started) return
        if (away) {
          this.recordDecision(this.now(), 'idle-away')
          this.scheduleAt(this.now() + RETRY_MS)
          return
        }
      }

      if (!this.started) return
      const at = this.now()
      const decision = this.inject(this.buildText(at, config))
      if (decision.mode === 'flush') {
        this.recordDecision(at, 'eligible')
        this.scheduleNext(at)
        return
      }
      const reason = mapGovernorReason(decision.reason)
      this.recordDecision(at, reason)
      const deferred = decision.deferredAt
      this.scheduleAt(deferred !== null && deferred > at ? deferred : at + RETRY_MS)
    } catch (error) {
      this.logger.warn('聊天节奏考虑失败', { error: String(error).slice(0, 200) })
      this.scheduleAt(this.now() + RETRY_MS)
    } finally {
      this.firing = false
    }
  }

  private buildText(now: number, config: AppConfig): string {
    const clock = new Date(now).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
    const cadence = config.companion.cadence
    const since = this.lastSpokeAt > 0 ? Math.max(0, Math.round((now - this.lastSpokeAt) / MINUTE)) : null
    const lines = [
      `[system/companion_chat] 现在 ${clock}，聊天档位「${CADENCE_LABELS[cadence]}」。` +
        (since === null ? '还没有主动开过口。' : `距上次主动开口约 ${since} 分钟。`) +
        '你可以主动说一句话，也可以保持沉默；没有真实依据或真正想问的事时，沉默是正常的。',
      '不要机械重复上次开场，也不要把“没看/没做”说成看过做过；不要为了填空而提问。',
      '如果想暂时安静一会儿，可以调用 pet_quiet；它只停止主动聊天，不会停止探索。'
    ]
    if (this.unansweredCount > 0) {
      lines.push(`上次主动开场没有得到回应，已退避 ${this.unansweredCount} 次；除非有新的真实内容，否则更倾向于沉默。`)
    }
    if (config.autonomy.mode !== 'explore') {
      lines.push('当前不是自主探索模式：不能读取新的文件或窗口；想继续了解什么，先如实说明。')
    }
    const context = this.describeCompanion?.()
    if (context !== undefined && context !== null && context.trim() !== '') {
      lines.push(`[companion-context] ${context.trim()}`)
    }
    return lines.join('\n')
  }

  private profile(): CadenceProfile {
    return CADENCE_PROFILES[this.getConfig().companion.cadence]
  }

  /** 正常间隔：档位内抖动，再乘用户反馈缩放。 */
  private intervalMs(): number {
    const profile = this.profile()
    const jitter = profile.minMs + this.rng() * Math.max(1, profile.maxMs - profile.minMs)
    return Math.round(Math.max(MINUTE, jitter * this.feedbackScale))
  }

  /** 未回答退避：档位下限 × 退避因子^次数，受配置上限约束。 */
  private backoffDelay(): number {
    const config = this.getConfig()
    const base = this.profile().minMs * this.feedbackScale
    const factor = Math.max(1, config.companion.unanswered.backoffFactor)
    const value = base * Math.pow(factor, this.unansweredCount)
    return Math.round(
      Math.min(
        config.companion.unanswered.maxBackoffMs,
        Math.max(MINUTE, value)
      )
    )
  }

  private scheduleNext(from: number): void {
    if (this.unansweredCount > 0) {
      this.scheduleAt(from + this.backoffDelay())
      return
    }
    this.scheduleAt(from + this.intervalMs())
  }

  private scheduleAt(at: number): void {
    this.clearTimer()
    if (!this.started) {
      this.next = null
      return
    }
    if (!this.getConfig().autonomy.enabled) {
      this.next = null
      return
    }
    const now = this.now()
    const target = Math.max(now + 1000, Math.round(at))
    this.next = target
    this.timer = setTimeout(() => {
      void this.fire()
    }, Math.max(0, target - now))
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private recordDecision(at: number, reason: CadenceDecisionReason): void {
    this.lastReason = reason
    const decision: CadenceDecision = { at, kind: 'consider', reason }
    this.decisions.push(decision)
    if (this.decisions.length > MAX_DECISIONS) this.decisions.shift()
    try {
      this.onDecision?.(decision)
    } catch {
      /* 诊断回调不能影响调度 */
    }
  }
}

function mapGovernorReason(reason: string): CadenceDecisionReason {
  switch (reason) {
    case 'quiet':
      return 'quiet-hours'
    case 'speech-quiet':
      return 'speech-quiet'
    case 'gap':
      return 'wake-gap'
    case 'user-cooldown':
      return 'user-cooldown'
    case 'busy':
      return 'busy'
    case 'paused':
      return 'paused'
    case 'disabled':
      return 'disabled'
    default:
      return 'no-real-event'
  }
}
