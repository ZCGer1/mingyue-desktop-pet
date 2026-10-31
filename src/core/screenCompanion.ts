import { randomUUID } from 'node:crypto'
import type { AppConfig } from '../shared/config'
import { SCREEN_SHARE_CONSENT_VERSION } from '../shared/config'
import type {
  ScreenCompanionStatusView,
  ScreenFeedbackReason,
  ScreenFeedbackState,
  ScreenFeedbackTrigger
} from '../shared/screenCompanion'
import type { Logger } from './types'
import { inQuietHours } from './util'
import type { SceneCategory, ScenePhase } from '../worlds/activity/scene'

/**
 * 屏幕陪伴反馈策略控制器（PLAN-SCREEN-COMPANION-FEEDBACK §4/§5）。
 *
 * 输入是 ActivityWorld 已经接受并校验过的 `vision_model` 抽象摘要；这里只
 * 决定「现在是否值得让她开口」，不截图、不调用工具、也不直接发 IPC。
 * 台词由独立、无工具的短文本请求生成，展示统一走 PetWorld。
 *
 * 所有等待/取消/失败都保留固定原因；只有页面真实回执 `displayed` 才推进
 * 成功冷却与计数。
 */

export interface ScreenObservation {
  observationId: string
  category: SceneCategory
  activity: string
  appLabel: string
  phase: ScenePhase
  game: string | null
  change: string | null
  detail: string | null
  confidence: number
  evidenceAt: number
  expiresAt: number
  revision: number
  sourceId: string | null
  /** 前台窗口/目标的不可逆标识；只在内存中用于目标切换校验。 */
  targetKey: string
  muted: boolean
}

export interface ScreenFeedbackGenerationInput {
  observation: ScreenObservation
  trigger: ScreenFeedbackTrigger
  recent: string[]
  allowQuestion: boolean
  now: number
  signal: AbortSignal
}

export interface ScreenFeedbackGenerationOutput {
  kind: 'comment' | 'question' | 'skip'
  text?: string
  /** 仅用于诊断的固定枚举；未知值统一记为 no-comment。 */
  reason?: string
}

export class ScreenFeedbackGenerationError extends Error {
  readonly code: 'invalid-output' | 'provider-failed' | 'cancelled'
  constructor(code: 'invalid-output' | 'provider-failed' | 'cancelled', message: string) {
    super(message)
    this.name = 'ScreenFeedbackGenerationError'
    this.code = code
  }
}

export interface ScreenFeedbackDeliveryInput {
  feedbackId: string
  observationId: string
  text: string
  kind: 'comment' | 'question'
  pendingQuestion?: string
  ttlMs?: number
}

export type ScreenFeedbackDeliveryOutcome = 'displayed' | 'failed' | 'cancelled'

export interface ScreenFeedbackDeliveryResult {
  outcome: ScreenFeedbackDeliveryOutcome
  reason?: string
  episodeId?: string
}

export interface ScreenCompanionOptions {
  getConfig: () => AppConfig
  logger: Logger
  now?: () => number
  rng?: () => number
  isSpeechQuiet: () => boolean
  isBusy: () => boolean
  /** 当前前台目标是否仍是该观察；缺省时不额外校验。 */
  isCurrentObservation?: (observation: ScreenObservation) => boolean
  /** 是否已有待回答的主动问题；有问题时不再生成新问题。 */
  hasOpenQuestion?: () => boolean
  /** 请求 VisionService 在下一次正常采样点刷新摘要。 */
  requestFreshSummary?: () => boolean
  generate: (input: ScreenFeedbackGenerationInput) => Promise<ScreenFeedbackGenerationOutput>
  deliver: (input: ScreenFeedbackDeliveryInput) => Promise<ScreenFeedbackDeliveryResult>
  onStatusChanged?: () => void
  /** 每次候选/阻断只上报固定原因，用于本地指标。 */
  onConsidered?: (reason: string, at: number) => void
  generationTimeoutMs?: number
}

interface Candidate {
  observation: ScreenObservation
  trigger: ScreenFeedbackTrigger
  at: number
}

interface InFlight extends Candidate {
  token: number
  controller: AbortController
}

const LOW_CONFIDENCE = 0.4
const MAX_COMMENT_CHARS = 60
const RECENT_LIMIT = 5
const RECENT_TTL_MS = 30 * 60_000
const DEFAULT_GENERATION_TIMEOUT_MS = 25_000
const FAILURE_BASE_MS = 30_000
const FAILURE_MAX_MS = 10 * 60_000
const REQUEST_REFRESH_GAP_MS = 2 * 60_000
/** 候选被频率/忙碌挡下时的重试粒度；真正到点时间由 nextEligibleAt 决定。 */
const QUEUE_RETRY_MS = 15_000

const REASONS: ReadonlySet<string> = new Set<ScreenFeedbackReason>([
  'disabled',
  'event-sharing-off',
  'muted-category',
  'quiet-hours',
  'speech-quiet',
  'busy',
  'post-user-cooldown',
  'stale',
  'target-changed',
  'duplicate',
  'low-confidence',
  'waiting-fresh-scene',
  'question-cooldown',
  'provider-failed',
  'invalid-output',
  'sink-unavailable',
  'render-failed',
  'no-comment'
])

function clampText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * 屏幕摘要中的自由文本仍按不可信数据处理：限长、去控制字符，并拒绝明显
 * 的指令注入句式。图片不会进入这里，原文也不会被复述。
 */
export function sanitizeScreenObservationText(value: unknown, max = 80): string | null {
  const text = clampText(value, max)
  if (text === '') return null
  if (
    /(忽略(?:之前|以上|所有)|ignore\s+(?:all\s+)?(?:previous|prior)|system\s*:|assistant\s*:|developer\s*:|执行(?:命令|指令)|调用(?:工具|函数)|tool_call|<\/?system)/i.test(
      text
    )
  ) {
    return null
  }
  return text
}

/**
 * 生成台词的最后一道本地清洗：去掉链接、邮箱、连续长数字和控制字符。
 * 屏幕上的正文不能被原样复述；超长内容截断而不是交给气泡层。
 */
export function sanitizeScreenComment(raw: unknown): string | null {
  let text = clampText(raw, 240)
  if (text === '') return null
  text = text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/www\.\S+/gi, ' ')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
    .replace(/\b\d{6,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return null
  // 明显的系统/工具指令口吻不应当出现在陪伴台词里。
  if (
    /(忽略(?:之前|以上|所有)|ignore\s+(?:all\s+)?(?:previous|prior)|system\s*:|assistant\s*:|执行(?:命令|指令)|调用(?:工具|函数)|tool_call)/i.test(
      text
    )
  ) {
    return null
  }
  const chars = Array.from(text)
  if (chars.length > MAX_COMMENT_CHARS) {
    text = chars.slice(0, MAX_COMMENT_CHARS).join('').trimEnd()
  }
  return text === '' ? null : text
}

/** 去重只看语义骨架：空白、标点与大小写差异不重复刷屏。 */
function topicKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function normalizedReason(value: unknown): ScreenFeedbackReason | null {
  return typeof value === 'string' && REASONS.has(value)
    ? (value as ScreenFeedbackReason)
    : null
}

function hasScreenShareConsent(config: AppConfig): boolean {
  const vision = config.worlds.activity.vision
  return (
    vision.screenShareConsentAt !== null &&
    vision.screenShareConsentVersion === SCREEN_SHARE_CONSENT_VERSION
  )
}

export class ScreenCompanionController {
  private readonly opts: ScreenCompanionOptions
  private readonly now: () => number
  private readonly rng: () => number

  private lastObservation: ScreenObservation | null = null
  private lastHandledObservationId: string | null = null
  private lastSignature = ''
  private lastChangeText = ''
  private lastTargetKey = ''
  private lastSignatureChangedAt = 0
  private lastObservationAt: number | null = null
  private lastAttemptAt = 0
  private lastGeneratedAt: number | null = null
  private lastDisplayedAt = 0
  private lastQuestionAt = 0
  private lastUserInputAt = 0
  private lastRefreshRequestAt = 0
  private firstAttempted = false
  private failureStreak = 0
  private backoffUntil = 0
  private quietJitter: number | null = null
  private inFlight: InFlight | null = null
  private queued: Candidate | null = null
  private quietTimer: NodeJS.Timeout | null = null
  private state: ScreenFeedbackState = 'idle'
  private lastReason: ScreenFeedbackReason | null = null
  private lastFeedbackId: string | null = null
  private lastKind: 'comment' | 'question' | null = null
  private readonly recent: Array<{ text: string; at: number; key: string }> = []
  private readonly counts = {
    observations: 0,
    candidates: 0,
    displayed: 0,
    skipped: 0,
    cancelled: 0,
    failed: 0,
    questions: 0
  }

  constructor(options: ScreenCompanionOptions) {
    this.opts = options
    this.now = options.now ?? (() => Date.now())
    this.rng = options.rng ?? Math.random
  }

  /**
   * 旧 reaction 路径是否应把同一条 vision_model 场景事件让给本通道。
   * 只看持久开关与类别；频率/安静由候选评估处理，避免两条路径双发。
   */
  shouldOwn(observation: ScreenObservation): boolean {
    const config = this.opts.getConfig()
    if (this.staticBlocker(config) !== null) return false
    if (observation.muted) return false
    if (observation.confidence < LOW_CONFIDENCE) return false
    if (this.now() > observation.expiresAt) return false
    return true
  }

  observe(observation: ScreenObservation, options: { manual?: boolean } = {}): void {
    const now = this.now()
    const manual = options.manual === true
    const clean = this.cleanObservation(observation)
    this.counts.observations += 1
    this.lastObservationAt = now
    this.lastObservation = clean

    if (clean.targetKey !== '' && clean.targetKey !== this.lastTargetKey) {
      // 新目标覆盖旧目标；在途文本不得补说。
      if (this.inFlight !== null || this.queued !== null) {
        this.abortInFlight('target-changed', now)
      }
      this.lastTargetKey = clean.targetKey
      this.lastSignature = ''
      this.lastChangeText = ''
      this.lastSignatureChangedAt = now
    }

    if (!manual && clean.observationId === this.lastHandledObservationId) {
      this.noteSkip('duplicate', now)
      return
    }
    this.lastHandledObservationId = clean.observationId

    const staleReason = this.observationBlocker(clean, now)
    if (staleReason !== null) {
      this.noteSkip(staleReason, now)
      return
    }

    const signature = [
      clean.category,
      clean.activity,
      clean.appLabel,
      clean.phase,
      clean.game ?? ''
    ].join('|')
    const changeText = sanitizeScreenObservationText(clean.change, 60) ?? ''
    const signatureChanged = signature !== this.lastSignature
    const changeChanged = changeText !== '' && changeText !== this.lastChangeText
    const meaningful = signatureChanged || changeChanged
    if (signatureChanged) {
      this.lastSignature = signature
      this.lastSignatureChangedAt = now
    }
    if (changeText !== '') this.lastChangeText = changeText

    let trigger: ScreenFeedbackTrigger | null = null
    if (manual) trigger = 'manual_test'
    else if (!this.firstAttempted) trigger = 'first_observation'
    else if (meaningful) trigger = 'meaningful_change'
    else if (this.quietDue(now)) trigger = 'quiet_presence'

    if (trigger === null) {
      this.lastReason = 'waiting-fresh-scene'
      this.state = 'waiting'
      this.scheduleQuietTimer()
      this.emitStatus()
      return
    }

    if (this.inFlight !== null) {
      this.queued = { observation: clean, trigger, at: now }
      this.state = 'queued'
      this.scheduleQuietTimer()
      this.emitStatus()
      return
    }

    this.opts.onConsidered?.(trigger, now)
    this.startOrDefer({ observation: clean, trigger, at: now }, manual, now)
  }

  /** 用户开始聊天：立即作废在途台词与旧候选，聊天后按冷却重新评估。 */
  noteUserInput(at = this.now()): void {
    this.lastUserInputAt = at
    if (this.inFlight !== null) this.abortInFlight('post-user-cooldown', at)
    this.queued = null
    this.state = 'waiting'
    this.lastReason = 'post-user-cooldown'
    this.scheduleQuietTimer()
    this.emitStatus()
  }

  /** 其它通道的真实主动气泡也重置“安静较久”计时，避免轮番打扰。 */
  noteProactiveSpoken(at = this.now()): void {
    if (at > this.lastDisplayedAt) this.lastDisplayedAt = at
    this.scheduleQuietTimer()
  }

  /** 暂停、锁屏、撤销、清除、配置变化等使所有旧候选失效。 */
  invalidate(reason: ScreenFeedbackReason = 'disabled', at = this.now()): void {
    if (this.inFlight !== null) this.abortInFlight(reason, at)
    this.queued = null
    this.clearQuietTimer()
    this.lastSignature = ''
    this.lastChangeText = ''
    this.state = reason === 'speech-quiet' || reason === 'quiet-hours' ? 'waiting' : 'cancelled'
    this.lastReason = reason
    this.emitStatus()
  }

  /** 手动测试：消费当前有效摘要；没有新帧时请求下一次正常采样刷新。 */
  test(observation: ScreenObservation | null): {
    mode: 'immediate' | 'scheduled' | 'blocked'
    reason: ScreenFeedbackReason | null
  } {
    const now = this.now()
    if (this.inFlight !== null) {
      return { mode: 'blocked', reason: 'waiting-fresh-scene' }
    }
    const config = this.opts.getConfig()
    const blocker = this.staticBlocker(config)
    if (blocker !== null) return { mode: 'blocked', reason: blocker }
    if (this.opts.isSpeechQuiet() || this.inQuietHours(config, now)) {
      return {
        mode: 'blocked',
        reason: this.opts.isSpeechQuiet() ? 'speech-quiet' : 'quiet-hours'
      }
    }
    if (observation !== null && observation.expiresAt > now) {
      this.observe(observation, { manual: true })
      return { mode: 'immediate', reason: null }
    }
    const requested = this.requestFreshSummary(now)
    this.lastReason = 'waiting-fresh-scene'
    this.state = 'waiting'
    this.emitStatus()
    return {
      mode: requested ? 'scheduled' : 'blocked',
      reason: requested ? 'waiting-fresh-scene' : 'stale'
    }
  }

  status(): ScreenCompanionStatusView {
    const config = this.opts.getConfig()
    const staticBlocker = this.staticBlocker(config)
    const observationBlocker =
      this.lastObservation === null
        ? staticBlocker
        : this.observationBlocker(this.lastObservation, this.now())
    return {
      enabled: config.companion.screenFeedback.enabled,
      active: staticBlocker === null,
      state: this.state,
      lastReason: this.lastReason,
      blocker: observationBlocker,
      lastObservationAt: this.lastObservationAt,
      lastGeneratedAt: this.lastGeneratedAt,
      lastDisplayedAt: this.lastDisplayedAt > 0 ? this.lastDisplayedAt : null,
      lastQuestionAt: this.lastQuestionAt > 0 ? this.lastQuestionAt : null,
      nextEligibleAt: this.nextEligibleAt(this.now()),
      inFlight: this.inFlight !== null,
      queued: this.queued !== null,
      lastFeedbackId: this.lastFeedbackId,
      lastKind: this.lastKind,
      counts: { ...this.counts }
    }
  }

  // ------------------------------------------------------------------ 候选

  private startOrDefer(candidate: Candidate, manual: boolean, now: number): boolean {
    const config = this.opts.getConfig()
    const blocker = this.gateBlocker(candidate.observation, config, now)
    if (blocker !== null) {
      this.lastReason = blocker
      if (blocker === 'busy' || blocker === 'waiting-fresh-scene') {
        this.queued = candidate
        this.state = 'queued'
      } else {
        this.state = blocker === 'stale' || blocker === 'target-changed' ? 'cancelled' : 'skipped'
        this.counts.skipped += 1
      }
      this.scheduleQuietTimer()
      this.emitStatus()
      this.opts.onConsidered?.(blocker, now)
      return false
    }
    if (manual) this.lastRefreshRequestAt = 0
    this.firstAttempted = true
    this.counts.candidates += 1
    this.lastAttemptAt = now
    this.state = 'generating'
    this.lastReason = null
    const token = (this.inFlight?.token ?? 0) + 1
    const controller = new AbortController()
    this.inFlight = { ...candidate, token, controller }
    this.queued = null
    this.emitStatus()
    void this.run(this.inFlight).catch((error: unknown) => {
      this.opts.logger.warn('屏幕陪伴生成链路异常', {
        error: String(error).slice(0, 200)
      })
    })
    return true
  }

  private async run(candidate: InFlight): Promise<void> {
    const { observation, trigger, token, controller } = candidate
    const recent = this.recentTexts()
    const allowQuestion =
      this.lastQuestionAt === 0 ||
      this.now() - this.lastQuestionAt >=
        this.opts.getConfig().companion.screenFeedback.questionMinIntervalMs
    const questionOpen = this.opts.hasOpenQuestion?.() === true
    let timer: NodeJS.Timeout | null = null
    let timedOut = false
    let output: ScreenFeedbackGenerationOutput
    try {
      const timeoutMs = Math.max(
        5_000,
        this.opts.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS
      )
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      timer.unref?.()
      output = await this.opts.generate({
        observation,
        trigger,
        recent,
        allowQuestion: allowQuestion && !questionOpen,
        now: this.now(),
        signal: controller.signal
      })
    } catch (error) {
      if (timer !== null) clearTimeout(timer)
      if (!this.isCurrentToken(token)) return
      this.inFlight = null
      const code =
        error instanceof ScreenFeedbackGenerationError
          ? error.code
          : controller.signal.aborted && !timedOut
            ? 'cancelled'
            : 'provider-failed'
      if (code === 'cancelled') {
        this.counts.cancelled += 1
        this.state = 'cancelled'
        this.lastReason = 'target-changed'
      } else if (code === 'invalid-output') {
        this.counts.skipped += 1
        this.state = 'skipped'
        this.lastReason = 'invalid-output'
        this.failureStreak = 0
      } else {
        this.noteFailure('provider-failed')
      }
      this.scheduleQuietTimer()
      this.emitStatus()
      return
    }
    if (timer !== null) clearTimeout(timer)
    if (!this.isCurrentToken(token)) return

    if (output.kind === 'skip') {
      this.inFlight = null
      this.counts.skipped += 1
      this.state = 'skipped'
      this.lastReason = this.mapSkipReason(output.reason) ?? 'no-comment'
      this.lastGeneratedAt = this.now()
      this.scheduleQuietTimer()
      this.emitStatus()
      return
    }

    const text = sanitizeScreenComment(output.text)
    if (text === null) {
      this.inFlight = null
      this.counts.skipped += 1
      this.state = 'skipped'
      this.lastReason = 'invalid-output'
      this.failureStreak = 0
      this.scheduleQuietTimer()
      this.emitStatus()
      return
    }
    const kind = output.kind === 'question' ? 'question' : 'comment'
    const now = this.now()
    if (
      kind === 'question' &&
      (!allowQuestion ||
        questionOpen ||
        (this.lastQuestionAt > 0 &&
          now - this.lastQuestionAt <
            this.opts.getConfig().companion.screenFeedback.questionMinIntervalMs))
    ) {
      this.inFlight = null
      this.counts.skipped += 1
      this.state = 'skipped'
      this.lastReason = 'question-cooldown'
      this.scheduleQuietTimer()
      this.emitStatus()
      return
    }
    const key = topicKey(text)
    if (this.recent.some((item) => item.key === key && now - item.at < RECENT_TTL_MS)) {
      this.inFlight = null
      this.counts.skipped += 1
      this.state = 'skipped'
      this.lastReason = 'duplicate'
      this.lastGeneratedAt = now
      this.scheduleQuietTimer()
      this.emitStatus()
      return
    }

    // 生成完成后再次核对：目标、时效、开关、安静与用户聊天都可能变化。
    const finalBlocker = this.deliveryBlocker(observation, now)
    if (finalBlocker !== null) {
      this.inFlight = null
      this.lastGeneratedAt = now
      if (finalBlocker === 'busy' || finalBlocker === 'post-user-cooldown') {
        this.queued = { observation, trigger, at: now }
        this.state = 'queued'
      } else {
        this.counts.cancelled += 1
        this.state = 'cancelled'
      }
      this.lastReason = finalBlocker
      if (finalBlocker === 'target-changed' || finalBlocker === 'stale') this.queued = null
      this.scheduleQuietTimer()
      this.emitStatus()
      return
    }

    const feedbackId = randomUUID()
    let delivery: ScreenFeedbackDeliveryResult
    try {
      delivery = await this.opts.deliver({
        feedbackId,
        observationId: observation.observationId,
        text,
        kind,
        ...(kind === 'question' ? { pendingQuestion: text } : {})
      })
    } catch (error) {
      delivery = {
        outcome: 'failed',
        reason: String(error).slice(0, 80)
      }
    }
    if (!this.isCurrentToken(token)) return
    this.inFlight = null
    this.lastGeneratedAt = now
    this.lastFeedbackId = feedbackId
    this.lastKind = kind
    if (delivery.outcome === 'displayed') {
      this.counts.displayed += 1
      if (kind === 'question') {
        this.counts.questions += 1
        this.lastQuestionAt = now
      }
      this.lastDisplayedAt = now
      this.failureStreak = 0
      this.backoffUntil = 0
      this.pushRecent(text, now)
      this.state = 'displayed'
      this.lastReason = null
      this.scheduleQuietTimer()
    } else if (delivery.outcome === 'cancelled') {
      this.counts.cancelled += 1
      this.lastReason = this.mapDeliveryReason(delivery.reason) ?? 'sink-unavailable'
      if (this.lastReason === 'busy' || this.lastReason === 'speech-quiet') {
        this.queued = { observation, trigger, at: now }
        this.state = 'queued'
      } else {
        this.state = 'cancelled'
      }
    } else {
      this.noteFailure(this.mapDeliveryReason(delivery.reason) ?? 'render-failed')
      this.counts.failed += 1
    }
    this.scheduleQuietTimer()
    this.emitStatus()
  }

  // ------------------------------------------------------------------ 门控

  private cleanObservation(observation: ScreenObservation): ScreenObservation {
    return {
      ...observation,
      activity: sanitizeScreenObservationText(observation.activity, 80) ?? '不确定在做什么',
      appLabel: clampText(observation.appLabel, 40),
      game: observation.game === null ? null : sanitizeScreenObservationText(observation.game, 40),
      change: observation.change === null ? null : sanitizeScreenObservationText(observation.change, 60),
      detail: observation.detail === null ? null : sanitizeScreenObservationText(observation.detail, 100),
      confidence: Number.isFinite(observation.confidence)
        ? Math.max(0, Math.min(1, observation.confidence))
        : 0,
      targetKey: clampText(observation.targetKey, 80)
    }
  }

  private staticBlocker(config: AppConfig): ScreenFeedbackReason | null {
    const vision = config.worlds.activity.vision
    if (
      !config.companion.screenFeedback.enabled ||
      !config.autonomy.enabled ||
      !config.worlds.pet.enabled ||
      !config.worlds.activity.enabled ||
      !vision.enabled ||
      vision.consentAt === null ||
      !hasScreenShareConsent(config) ||
      !config.companion.reaction.enabled
    ) {
      return 'disabled'
    }
    if (!config.worlds.activity.shareEventsToModel) return 'event-sharing-off'
    return null
  }

  private observationBlocker(
    observation: ScreenObservation,
    now: number
  ): ScreenFeedbackReason | null {
    const config = this.opts.getConfig()
    const staticBlocker = this.staticBlocker(config)
    if (staticBlocker !== null) return staticBlocker
    if (observation.muted) return 'muted-category'
    if (now > observation.expiresAt) return 'stale'
    if (observation.confidence < LOW_CONFIDENCE) return 'low-confidence'
    if (this.inQuietHours(config, now)) return 'quiet-hours'
    if (this.opts.isSpeechQuiet()) return 'speech-quiet'
    if (this.opts.isBusy()) return 'busy'
    if (
      this.opts.isCurrentObservation !== undefined &&
      !this.opts.isCurrentObservation(observation)
    ) {
      return 'target-changed'
    }
    return null
  }

  /** 频率与用户聊天冷却；生成前使用。 */
  private gateBlocker(
    observation: ScreenObservation,
    config: AppConfig,
    now: number
  ): ScreenFeedbackReason | null {
    const blocker = this.observationBlocker(observation, now)
    if (blocker !== null) return blocker
    if (this.lastUserInputAt > 0 && now - this.lastUserInputAt < config.companion.screenFeedback.postUserCooldownMs) {
      return 'post-user-cooldown'
    }
    if (this.backoffUntil > now) return 'provider-failed'
    if (
      this.lastDisplayedAt > 0 &&
      now - this.lastDisplayedAt < config.companion.screenFeedback.minIntervalMs
    ) {
      return 'waiting-fresh-scene'
    }
    const minAttemptGap = Math.min(30_000, config.companion.screenFeedback.minIntervalMs)
    if (this.lastAttemptAt > 0 && now - this.lastAttemptAt < minAttemptGap) {
      return 'waiting-fresh-scene'
    }
    return null
  }

  /** 生成完成后、展示前使用；忙碌/用户聊天可回到 queued，其它直接取消。 */
  private deliveryBlocker(
    observation: ScreenObservation,
    now: number
  ): ScreenFeedbackReason | null {
    const config = this.opts.getConfig()
    const blocker = this.observationBlocker(observation, now)
    if (blocker !== null) return blocker
    if (
      this.lastUserInputAt > 0 &&
      now - this.lastUserInputAt < config.companion.screenFeedback.postUserCooldownMs
    ) {
      return 'post-user-cooldown'
    }
    return null
  }

  private inQuietHours(config: AppConfig, now: number): boolean {
    return (
      config.autonomy.respectQuietHours &&
      inQuietHours(now, config.worlds.activity.quietHours)
    )
  }

  private mapSkipReason(value: unknown): ScreenFeedbackReason | null {
    const reason = normalizedReason(value)
    if (reason === null) return null
    // 模型只能描述“为什么不值得说”；开关/权限/调度原因不能由模型设置。
    return reason === 'no-comment' || reason === 'duplicate' || reason === 'low-confidence'
      ? reason
      : 'no-comment'
  }

  private mapDeliveryReason(value: unknown): ScreenFeedbackReason | null {
    const reason = normalizedReason(value)
    if (reason === null) return null
    return reason === 'busy' ||
      reason === 'speech-quiet' ||
      reason === 'sink-unavailable' ||
      reason === 'render-failed' ||
      reason === 'disabled'
      ? reason
      : null
  }

  private noteSkip(reason: ScreenFeedbackReason, now: number): void {
    this.counts.skipped += 1
    this.state = 'skipped'
    this.lastReason = reason
    this.opts.onConsidered?.(reason, now)
    this.scheduleQuietTimer()
    this.emitStatus()
  }

  private noteFailure(reason: ScreenFeedbackReason): void {
    this.failureStreak = Math.min(10, this.failureStreak + 1)
    const backoff = Math.min(
      FAILURE_MAX_MS,
      FAILURE_BASE_MS * 2 ** Math.max(0, this.failureStreak - 1)
    )
    this.backoffUntil = this.now() + backoff
    this.state = 'failed'
    this.lastReason = reason
    this.emitStatus()
  }

  // ------------------------------------------------------------------ 安静陪伴/刷新

  private quietDue(now: number): boolean {
    const recent = Math.max(
      this.lastDisplayedAt,
      this.lastSignatureChangedAt,
      this.lastUserInputAt
    )
    return now - recent >= this.quietDelayMs()
  }

  private quietDelayMs(): number {
    const base = this.opts.getConfig().companion.screenFeedback.quietPresenceMs
    if (this.quietJitter === null) {
      // 8–12 分钟（基准 10 分钟）的自然抖动；只在进程内固定一次。
      this.quietJitter = 0.8 + this.rng() * 0.4
    }
    return Math.round(base * this.quietJitter)
  }

  private scheduleQuietTimer(): void {
    this.clearQuietTimer()
    const config = this.opts.getConfig()
    if (this.staticBlocker(config) !== null) return
    const now = this.now()
    const recent = Math.max(
      this.lastDisplayedAt,
      this.lastSignatureChangedAt,
      this.lastUserInputAt
    )
    let due = recent + this.quietDelayMs()
    if (this.queued !== null) {
      // 候选被最小间隔/退避/用户聊天挡下时，也要有到点重试；否则它
      // 只能等下一次不同场景，可能永远轮不到。
      const eligible = this.nextEligibleAt(now) ?? now
      due = Math.min(due, Math.max(now + QUEUE_RETRY_MS, eligible))
    }
    const delay = Math.max(1_000, due - now)
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null
      this.onQuietTimer()
    }, Math.min(delay, 30 * 60_000))
    this.quietTimer.unref?.()
  }

  private clearQuietTimer(): void {
    if (this.quietTimer !== null) {
      clearTimeout(this.quietTimer)
      this.quietTimer = null
    }
  }

  private onQuietTimer(): void {
    const config = this.opts.getConfig()
    if (this.staticBlocker(config) !== null) return
    const now = this.now()
    if (this.queued !== null && this.inFlight === null) {
      const candidate = this.queued
      this.queued = null
      const blocker = this.gateBlocker(candidate.observation, config, now)
      if (blocker === null) {
        this.opts.onConsidered?.(candidate.trigger, now)
        this.startOrDefer(candidate, false, now)
        return
      }
      if (
        blocker === 'busy' ||
        blocker === 'waiting-fresh-scene' ||
        blocker === 'post-user-cooldown'
      ) {
        this.queued = candidate
        this.state = 'queued'
        this.lastReason = blocker
        this.emitStatus()
        this.scheduleQuietTimer()
        return
      }
      // 目标/时效/权限已经变化：候选不再值得说。
      this.counts.cancelled += 1
      this.state = 'cancelled'
      this.lastReason = blocker
      this.scheduleQuietTimer()
      this.emitStatus()
      return
    }
    if (!this.quietDue(now) || this.inFlight !== null) {
      this.scheduleQuietTimer()
      return
    }
    const requested = this.requestFreshSummary(now)
    if (!requested) {
      this.lastReason = 'waiting-fresh-scene'
      this.state = 'waiting'
      this.emitStatus()
      // 没有可用的刷新通路时，稍后再试；不循环请求。
      this.lastRefreshRequestAt = now
      this.scheduleQuietTimer()
    }
  }

  private requestFreshSummary(now: number): boolean {
    if (now - this.lastRefreshRequestAt < REQUEST_REFRESH_GAP_MS) return false
    let requested = false
    try {
      requested = this.opts.requestFreshSummary?.() === true
    } catch {
      requested = false
    }
    if (requested) {
      this.lastRefreshRequestAt = now
      this.lastReason = 'waiting-fresh-scene'
      this.state = 'waiting'
    }
    return requested
  }

  // ------------------------------------------------------------------ 状态/生命周期

  private isCurrentToken(token: number): boolean {
    return this.inFlight !== null && this.inFlight.token === token
  }

  private abortInFlight(reason: ScreenFeedbackReason, now: number): void {
    if (this.inFlight === null) return
    const flight = this.inFlight
    this.inFlight = null
    flight.controller.abort()
    this.counts.cancelled += 1
    this.state = 'cancelled'
    this.lastReason = reason
    this.lastAttemptAt = now
    this.emitStatus()
  }

  private pushRecent(text: string, at: number): void {
    this.recent.push({ text, at, key: topicKey(text) })
    while (this.recent.length > RECENT_LIMIT) this.recent.shift()
    this.pruneRecent(at)
  }

  private pruneRecent(now: number): void {
    while (this.recent.length > 0 && now - (this.recent[0]?.at ?? 0) > RECENT_TTL_MS) {
      this.recent.shift()
    }
  }

  private recentTexts(): string[] {
    const now = this.now()
    this.pruneRecent(now)
    return this.recent.map((item) => item.text)
  }

  private nextEligibleAt(now: number): number | null {
    const config = this.opts.getConfig()
    if (this.staticBlocker(config) !== null) return null
    const points = [
      this.lastDisplayedAt > 0
        ? this.lastDisplayedAt + config.companion.screenFeedback.minIntervalMs
        : 0,
      this.lastUserInputAt > 0
        ? this.lastUserInputAt + config.companion.screenFeedback.postUserCooldownMs
        : 0,
      this.lastAttemptAt > 0
        ? this.lastAttemptAt +
          Math.min(30_000, config.companion.screenFeedback.minIntervalMs)
        : 0,
      this.backoffUntil
    ].filter((value) => value > now)
    return points.length === 0 ? now : Math.max(...points)
  }

  private emitStatus(): void {
    try {
      this.opts.onStatusChanged?.()
    } catch {
      /* ignore */
    }
  }
}
