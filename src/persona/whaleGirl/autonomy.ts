import type { AppConfig } from '../../shared/config'
import type { AutonomyRestMode, AutonomyRestRequest } from '../../shared/autonomy'
import {
  effectiveCapabilities,
  hasExploreScope
} from '../../shared/effectiveCapabilities'
import type { Logger } from '../../core/types'
import type { WakeDecision } from '../../core/wakeGovernor'

const RETRY_MS = 60_000
/** 连续只休息/等待达到这个次数后，提前复查候选池而不是继续沉默。 */
const REST_REVIEW_THRESHOLD = 2
/** 复查不会立刻打断当前回合，只把下一次机会提前到这个窗口。 */
const REST_REVIEW_DELAY_MS = 2 * 60_000
/** 新目标/能力恢复/候选到期时，允许提前复查的等待窗口。 */
const RELEVANT_REVIEW_DELAY_MS = 30_000
const ABANDONED_CANDIDATES_MAX = 8
/** explore tick 没有任何实际读取时，尽快再给一次机会。 */
const EXPLORE_RETRY_MS = 90_000
/** 准备就绪后的首次探索机会。 */
const FIRST_EXPLORE_MS = 90_000
/**
 * 正常活跃使用时的最大等待。退避可以拉长间隔，但不能让探索机会被
 * 无限推迟；这也是模型真正可以行动的最坏调度上限（不保证一定有发现）。
 */
const EXPLORE_MAX_WAIT_MS = 10 * 60_000

export type ExploreProgressKind =
  | 'observation'
  | 'action'
  | 'artifact'
  | 'planning'
  | 'rest'
  | 'no_progress'

export interface AutonomyOptions {
  getConfig: () => AppConfig
  isBusy: () => boolean
  isPaused: () => boolean
  /** 是否已有排队/运行中的自主任务；有则不重复注入探索 tick。 */
  hasActiveAutonomyTask?: () => boolean
  /** 脱敏环境快照（类别/应用名/标题/页面摘要），只进入本轮 ephemeral 上下文。 */
  describeContext?: () => string | null
  /** 可供继续/放弃的本地线索（兴趣、经历、最近看过）；只是候选，不是任务。 */
  describeCandidates?: () => string | null
  /**
   * 与设置页/诊断一致的运行时能力摘要。提供时优先于静态配置推导：
   * 扩展断线、目录失效或缺少同意时，提示词不会继续宣称“可以浏览/读取”。
   */
  capabilitySummary?: () => { scopes: string[]; reasons: string[] } | null
  /** 最近一次模型展示动作的时间（pet_say/emote/act/walk/open_chat）。 */
  lastPresentationAt?: () => number
  /** 最早的候选到期时间（兴趣回访/遗留任务定时）；只用于提前复查。 */
  nextCandidateAt?: () => number | null
  /** 经 WakeGovernor 注入自主唤醒；null 表示 Core 尚未装配。 */
  inject: (text: string) => WakeDecision | null
  logger: Logger
  now?: () => number
}

/**
 * 中性自主 tick（Phase 3）。
 *
 * 它只负责给模型一个「现在可以看看/想想/做点什么」的机会：
 * - 不使用固定问答或本地台词；模型不调用工具就是沉默；
 * - 间隔从 tickMin 起按指数退避到 tickMax，展示动作/用户活动/外部事件会重置；
 * - 暂停/忙碌/预算/探索暂停时只重试，不注入；
 * - 安静时段与“暂时别说话”不再阻止探索；只有用户明确的 explore pause 才暂停；
 * - 未回答的主动开场也不再阻止探索，那只是聊天 cadence 的退避条件。
 */
export class AutonomyController {
  private readonly getConfig: () => AppConfig
  private readonly isBusy: () => boolean
  private readonly isPaused: () => boolean
  private readonly hasActiveAutonomyTask: (() => boolean) | undefined
  private readonly describeContext: (() => string | null) | undefined
  private readonly describeCandidates: (() => string | null) | undefined
  private readonly capabilitySummary:
    | (() => { scopes: string[]; reasons: string[] } | null)
    | undefined
  private readonly lastPresentationAt: (() => number) | undefined
  private readonly nextCandidateAt: (() => number | null) | undefined
  private readonly inject: AutonomyOptions['inject']
  private readonly logger: Logger
  private readonly now: () => number

  private timer: NodeJS.Timeout | null = null
  private next: number | null = null
  private started = false
  private startedAt = 0
  private firing = false
  private silentStreak = 0
  private lastTickAt = 0
  private lastActivityAt = 0
  /** 最近一次真实进展（观察/动作/产物/规划），与「模型说了话」分开。 */
  private lastProgressAt = 0
  private lastProgressKind: ExploreProgressKind | null = null
  /**
   * 最近一次探索轮的结果，包含 no_progress/rest 这类「不是进展」的结果。
   * 它不能覆盖 lastProgressAt/lastProgressKind，否则诊断页会把一次空转
   * 显示成「最近进展」，和实际发生的事相反。
   */
  private lastOutcomeAt = 0
  private lastOutcomeKind: ExploreProgressKind | null = null
  /** 上一轮的多维结果；rest 不会覆盖同一轮已经取得的进展。 */
  private lastRoundKinds: ExploreProgressKind[] = []
  private lastRoundFailures = 0
  private lastRoundState: 'progress' | 'rest' | 'no_progress' | null = null
  /** 最近一次外部活动时间只用于诊断，不参与重排探索期限。 */
  private lastExternalAt = 0
  /** 用户明确的“暂停探索”；与 speech quiet 完全分开。 */
  private explorePausedUntil = 0
  /** 模型显式调整节奏：rest/waiting 会推迟新探索，quiet 不会。 */
  private restUntil = 0
  private restReason: string | null = null
  private restMode: AutonomyRestMode | null = null
  private restWaitFor: string | null = null
  private quietUntil = 0
  /** 独立于空转计数的连续「只休息/等待、无进展」轮次。 */
  private consecutiveRests = 0
  private outcomeRounds = 0
  private restRounds = 0
  /** 提前复查：由连续休息、新目标、能力恢复或候选到期触发。 */
  private restReviewAt = 0
  private restReviewReason: string | null = null
  private abandonedCandidates: Array<{ at: number; topic: string; reason: string }> = []
  private pauseSkipped = 0

  constructor(opts: AutonomyOptions) {
    this.getConfig = opts.getConfig
    this.isBusy = opts.isBusy
    this.isPaused = opts.isPaused
    this.hasActiveAutonomyTask = opts.hasActiveAutonomyTask
    this.describeContext = opts.describeContext
    this.describeCandidates = opts.describeCandidates
    this.capabilitySummary = opts.capabilitySummary
    this.lastPresentationAt = opts.lastPresentationAt
    this.nextCandidateAt = opts.nextCandidateAt
    this.inject = opts.inject
    this.logger = opts.logger
    this.now = opts.now ?? (() => Date.now())
  }

  get running(): boolean {
    return this.started
  }

  start(): void {
    if (this.started) return
    const now = this.now()
    this.started = true
    this.startedAt = now
    this.lastActivityAt = now
    this.lastProgressAt = now
    this.lastOutcomeAt = now
    this.refresh()
  }

  stop(): void {
    this.started = false
    this.clearTimer()
    this.next = null
  }

  /** 配置热更新、恢复/暂停变化后重新安排下一次 tick。 */
  refresh(): void {
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
    const blocker = this.explorePausedUntil > now ? this.explorePausedUntil : 0
    // quiet 不阻止探索；只有 waiting/rest 设置实际的休息期限。
    const rest =
      this.restMode !== 'quiet' && this.restUntil > now ? this.restUntil : 0
    if (blocker > now) {
      this.scheduleAt(blocker)
      return
    }
    if (rest > now) {
      this.maybeScheduleCandidateReview(now)
      const review = this.restReviewAt > now && this.restReviewAt < rest ? this.restReviewAt : 0
      this.scheduleAt(review > 0 ? review : rest)
      return
    }
    this.scheduleAt(this.dueAt(now))
  }

  /**
   * 用户发消息不应把探索期限往后推。它只更新诊断用的活动时间；
   * 探索仍按自己的上次进展/回访期限获得机会。
   */
  noteUserActivity(now = this.now()): void {
    this.lastActivityAt = now
  }

  /**
   * 活动/浏览器事件可以增加候选目标，但绝不能重置探索的保证期限。
   * 旧实现会把下一次探索推迟到「现在 + 最短间隔」，用户越活跃探索越
   * 永远不会发生。这里只记录诊断时间。
   */
  noteExternalActivity(now = this.now()): void {
    this.lastExternalAt = now
  }

  /** 展示动作不是探索进展，也不改变探索期限。 */
  notePresentation(now = this.now()): void {
    this.lastActivityAt = now
  }

  /**
   * 真实进展：只有成功的新观察、已检查的动作、回读通过的产物或建立
   * 可执行计划才调用这里。它重置退避，并按正常探索间隔安排下一次机会。
   */
  noteExploreProgress(
    kind: Exclude<ExploreProgressKind, 'no_progress' | 'rest'>,
    now = this.now()
  ): void {
    this.lastProgressAt = now
    this.lastProgressKind = kind
    this.lastOutcomeAt = now
    this.lastOutcomeKind = kind
    this.lastRoundKinds = [kind]
    this.lastRoundFailures = 0
    this.lastRoundState = 'progress'
    this.lastActivityAt = now
    this.silentStreak = 0
    if (!this.started || this.getConfig().autonomy.mode !== 'explore') return
    this.scheduleAt(now + this.intervalMs(0))
  }

  /**
   * 一轮探索结束时的完整结果。与 `noteExploreProgress` 相比，它保留
   * 同一轮的多个进展种类、失败数和调度下一步，供设置页分开显示。
   */
  noteExploreRound(
    result: {
      progressKinds: ExploreProgressKind[]
      rest: boolean
      failures: number
      nextState: 'progress' | 'rest' | 'no_progress'
    },
    now = this.now()
  ): void {
    this.outcomeRounds += 1
    this.lastOutcomeAt = now
    this.lastRoundKinds = [...result.progressKinds]
    this.lastRoundFailures = Math.max(0, Math.round(result.failures))
    this.lastRoundState = result.nextState
    this.lastOutcomeKind =
      result.progressKinds[0] ?? (result.rest ? 'rest' : 'no_progress')
    const quietRound = result.rest && this.restMode === 'quiet'
    if (result.progressKinds.length > 0) {
      this.consecutiveRests = 0
    } else if (result.rest && !quietRound) {
      this.consecutiveRests += 1
      this.restRounds += 1
      if (this.consecutiveRests >= REST_REVIEW_THRESHOLD) {
        this.markRestReview('consecutive-rest', now)
      }
    } else {
      this.consecutiveRests = 0
    }
    if (!this.started || this.getConfig().autonomy.mode !== 'explore') return
    if (result.progressKinds.length > 0) {
      const primary = result.progressKinds[0]!
      this.lastProgressAt = now
      this.lastProgressKind = primary
      this.silentStreak = 0
      this.lastActivityAt = now
      // 先观察再休息：进展要保留，但也不能把模型明确的休息期限覆盖掉。
      if (result.rest && !quietRound && this.restUntil > now) {
        this.scheduleAt(this.reviewOrRestAt(now))
      } else {
        this.scheduleAt(now + this.intervalMs(0))
      }
      return
    }
    if (result.rest && !quietRound) {
      // 休息期限由 autonomy_rest 负责；只有达到复查阈值时才提前。
      this.silentStreak = 0
      if (this.restUntil > now) this.scheduleAt(this.reviewOrRestAt(now))
      return
    }
    this.silentStreak = 0
    this.lastActivityAt = now
    this.scheduleAt(now + EXPLORE_RETRY_MS)
  }

  /**
   * 一次 explore tick 没有实际进展（仅 end_turn、表现动作、重复读取、
   * 失败工具或只查询状态）。尽快再给一次机会；同时由运行时决定是否兜底。
   */
  noteExploreMiss(now = this.now()): void {
    this.outcomeRounds += 1
    this.consecutiveRests = 0
    this.lastOutcomeAt = now
    this.lastOutcomeKind = 'no_progress'
    this.lastRoundKinds = []
    this.lastRoundState = 'no_progress'
    if (!this.started || this.getConfig().autonomy.mode !== 'explore') return
    this.silentStreak = 0
    this.lastActivityAt = now
    this.scheduleAt(now + EXPLORE_RETRY_MS)
  }

  /**
   * 旧的二参数调用保持「真正休息」语义，避免兼容调用变成另一种静默停止。
   * 新调用请用 noteRest 明确 quiet / waiting / rest。
   */
  noteExplicitRest(minutes: number, reason: string, now = this.now()): void {
    this.noteRest(
      {
        mode: 'rest',
        reason,
        minutes,
        waitFor: null,
        recheckMinutes: minutes
      },
      now
    )
  }

  /** 模型通过 autonomy_rest 调整节奏；只有 rest/waiting 会推迟新探索。 */
  noteRest(request: AutonomyRestRequest, now = this.now()): void {
    const bounded = Math.max(1, Math.min(120, Math.round(request.minutes)))
    const mode: AutonomyRestMode = request.mode
    const reason =
      request.reason.trim() === '' ? '模型选择休息' : request.reason.trim().slice(0, 120)
    this.restMode = mode
    this.restReason = reason
    this.restWaitFor =
      mode === 'waiting'
        ? (request.waitFor?.trim().slice(0, 160) || '相关变化或复查时间')
        : null
    // quiet 只表示不抢表达/前台动作；它不设置 restUntil，探索机会继续。
    this.restUntil = mode === 'quiet' ? 0 : now + bounded * 60_000
    this.quietUntil = mode === 'quiet' ? now + bounded * 60_000 : 0
    this.lastOutcomeAt = now
    this.lastOutcomeKind = mode === 'quiet' ? 'no_progress' : 'rest'
    // 工具调用时的即时状态；batch_end 会用完整多维结果覆盖它。
    this.lastRoundKinds = []
    this.lastRoundState = mode === 'quiet' ? 'no_progress' : 'rest'
    this.silentStreak = 0
    if (mode !== 'rest') {
      // 模式切换后旧的连续休息序列不再适用；rest 的计数由整轮结果维护。
      this.restReviewAt = 0
      this.restReviewReason = null
    }
    this.logger.info('自主探索节奏调整', {
      mode,
      minutes: bounded,
      until: mode === 'quiet' ? this.quietUntil : this.restUntil,
      waitFor: this.restWaitFor,
      reason
    })
    if (!this.started) return
    if (mode === 'quiet') {
      this.scheduleAt(this.dueAt(now))
    } else {
      this.maybeScheduleCandidateReview(now)
      this.scheduleAt(this.reviewOrRestAt(now))
    }
  }

  /**
   * 新相关目标、能力恢复或候选到期：允许模型自选的 rest/waiting 提前复查。
   * 用户明确暂停探索时绝不能借这个入口重新开始。
   */
  noteRelevantChange(kind: string, now = this.now()): void {
    if (this.explorePausedUntil > now) return
    if (this.restMode === null || this.restMode === 'quiet') return
    if (this.restUntil <= now) return
    this.markRestReview(
      `relevant-change:${kind.slice(0, 40)}`,
      now,
      RELEVANT_REVIEW_DELAY_MS
    )
    if (this.started) this.scheduleAt(this.reviewOrRestAt(now))
    this.logger.info('自主探索提前复查', {
      cause: kind,
      at: this.restReviewAt,
      mode: this.restMode
    })
  }

  /**
   * 外部异步结果（本地转写完成/失败）带来的一次性提前复查。
   *
   * 它不绕过用户暂停，也不把探索期限整体重置；只在当前休息期内标记一次
   * 提前复查，或把下一次机会提前到 delayMs 后。忙碌/暂停仍由 fire() 复验。
   */
  requestReview(cause: string, delayMs = RELEVANT_REVIEW_DELAY_MS, now = this.now()): void {
    if (!this.started || !this.getConfig().autonomy.enabled) return
    if (this.explorePausedUntil > now) return
    const label = `relevant-change:${cause.trim().slice(0, 40) || 'external'}`
    if (this.restMode !== null && this.restMode !== 'quiet' && this.restUntil > now) {
      this.markRestReview(label, now, Math.max(1_000, delayMs))
      this.scheduleAt(this.reviewOrRestAt(now))
      this.logger.info('自主探索提前复查', {
        cause,
        at: this.restReviewAt,
        mode: this.restMode
      })
      return
    }
    const at = now + Math.max(1_000, delayMs)
    if (this.next !== null && this.next <= at) return
    this.scheduleAt(at)
    this.logger.info('自主探索提前复查', { cause, at, mode: this.restMode })
  }

  /** 放弃候选的诊断：只记脱敏主题与原因，不记正文。 */
  noteCandidateAbandoned(topic: string, reason: string, now = this.now()): void {
    const cleanTopic = topic.trim().slice(0, 80)
    if (cleanTopic === '') return
    this.abandonedCandidates.unshift({
      at: now,
      topic: cleanTopic,
      reason: reason.trim().slice(0, 120) || '未说明原因'
    })
    if (this.abandonedCandidates.length > ABANDONED_CANDIDATES_MAX) {
      this.abandonedCandidates.length = ABANDONED_CANDIDATES_MAX
    }
  }

  /**
   * 暂停探索：在 until 之前不注入自主 tick。任务暂停/恢复由 Bot 另行处理；
   * 这里只负责不再产生新的探索机会，不触碰 speech quiet。
   */
  setExplorePausedUntil(until: number | null): void {
    const now = this.now()
    this.explorePausedUntil =
      until === null || !Number.isFinite(until) || until <= now ? 0 : Math.floor(until)
    if (!this.started) return
    if (this.explorePausedUntil > now) {
      this.scheduleAt(this.explorePausedUntil)
    } else {
      this.scheduleAt(this.dueAt(now))
    }
  }

  get explorePausedUntilAt(): number {
    return this.explorePausedUntil > this.now() ? this.explorePausedUntil : 0
  }

  nextAt(): number | null {
    return this.next
  }

  silentStreakCount(): number {
    return this.silentStreak
  }

  /** 清空本地数据/关闭自主时调用。 */
  reset(): void {
    this.silentStreak = 0
    this.pauseSkipped = 0
    this.explorePausedUntil = 0
    this.restUntil = 0
    this.restReason = null
    this.restMode = null
    this.restWaitFor = null
    this.quietUntil = 0
    this.consecutiveRests = 0
    this.outcomeRounds = 0
    this.restRounds = 0
    this.restReviewAt = 0
    this.restReviewReason = null
    this.abandonedCandidates = []
    this.lastTickAt = 0
    this.lastActivityAt = this.now()
    this.lastProgressAt = this.lastActivityAt
    this.lastProgressKind = null
    this.lastOutcomeAt = this.lastActivityAt
    this.lastOutcomeKind = null
    this.lastRoundKinds = []
    this.lastRoundFailures = 0
    this.lastRoundState = null
    if (this.started) this.refresh()
  }

  /**
   * 当前阻塞原因（调度层）。预算/模型可用性由 Bot 的就绪诊断另行补充。
   */
  blocker(now = this.now()): string | null {
    if (!this.getConfig().autonomy.enabled) return 'autonomy-disabled'
    if (!this.started) return 'not-started'
    if (this.explorePausedUntil > now) return 'explore-paused'
    if (this.restMode === 'waiting' && this.restUntil > now) return 'waiting-condition'
    if (this.restMode !== 'quiet' && this.restUntil > now) return 'explicit-rest'
    if (this.isPaused()) return 'paused'
    if (this.isBusy()) return 'busy'
    if (this.hasActiveAutonomyTask?.() === true) return 'active-autonomy-task'
    return null
  }

  diagnostics(now = this.now()): Record<string, unknown> {
    return {
      enabled: this.getConfig().autonomy.enabled,
      mode: this.getConfig().autonomy.mode,
      started: this.started,
      nextAt: this.next,
      /** 活跃使用时保证的最晚探索机会；与 nextAt 相同，便于就绪诊断直接消费。 */
      nextGuaranteedAt: this.next,
      silentStreak: this.silentStreak,
      pauseSkipped: this.pauseSkipped,
      explorePausedUntil: this.explorePausedUntilAt > 0 ? this.explorePausedUntilAt : null,
      restMode:
        this.restMode !== null &&
        this.restMode !== 'quiet' &&
        this.restUntil > now
          ? this.restMode
          : null,
      restUntil:
        this.restMode !== 'quiet' && this.restUntil > now ? this.restUntil : null,
      restReason:
        this.restMode !== 'quiet' && this.restUntil > now ? this.restReason : null,
      restWaitFor:
        this.restMode === 'waiting' && this.restUntil > now ? this.restWaitFor : null,
      quietUntil: this.quietUntil > now ? this.quietUntil : null,
      quietReason: this.quietUntil > now ? this.restReason : null,
      consecutiveRests: this.consecutiveRests,
      restRounds: this.restRounds,
      outcomeRounds: this.outcomeRounds,
      restRoundRatio:
        this.outcomeRounds === 0 ? null : this.restRounds / this.outcomeRounds,
      minutesSinceRealProgress:
        this.lastProgressAt > 0
          ? Math.max(0, Math.round((now - this.lastProgressAt) / 60_000))
          : null,
      restReviewAt: this.restReviewAt > now ? this.restReviewAt : null,
      restReviewReason: this.restReviewAt > now ? this.restReviewReason : null,
      abandonedCandidates: this.abandonedCandidates.map((entry) => ({ ...entry })),
      blocker: this.blocker(now),
      lastTickAt: this.lastTickAt > 0 ? this.lastTickAt : null,
      lastProgressAt: this.lastProgressAt > 0 ? this.lastProgressAt : null,
      lastProgressKind: this.lastProgressKind,
      lastOutcomeAt: this.lastOutcomeAt > 0 ? this.lastOutcomeAt : null,
      lastOutcomeKind: this.lastOutcomeKind,
      lastRoundKinds: [...this.lastRoundKinds],
      lastRoundFailures: this.lastRoundFailures,
      lastRoundState: this.lastRoundState,
      lastExternalAt: this.lastExternalAt > 0 ? this.lastExternalAt : null
    }
  }

  // ------------------------------------------------------------------

  private markRestReview(
    reason: string,
    now: number,
    delayMs = REST_REVIEW_DELAY_MS
  ): void {
    this.restReviewAt = Math.min(now + delayMs, this.restUntil)
    this.restReviewReason = reason
  }

  /**
   * 候选到期是相关变化：如果她正在 rest/waiting，就在到期点提前复查。
   * 到期时间来自兴趣回访/遗留任务定时，不来自鼠标移动等无关活动。
   */
  private maybeScheduleCandidateReview(now: number): void {
    if (this.nextCandidateAt === undefined) return
    if (this.explorePausedUntil > now) return
    if (this.restMode === null || this.restMode === 'quiet') return
    if (this.restUntil <= now) return
    let due: number | null = null
    try {
      due = this.nextCandidateAt()
    } catch {
      due = null
    }
    if (due === null || !Number.isFinite(due) || due <= now || due > this.restUntil) return
    if (this.restReviewAt > 0 && this.restReviewAt <= due) return
    this.restReviewAt = due
    this.restReviewReason = 'candidate-due'
  }

  private reviewOrRestAt(now: number): number {
    if (this.restReviewAt > now && this.restReviewAt < this.restUntil) {
      return this.restReviewAt
    }
    return this.restUntil > now ? this.restUntil : now + RETRY_MS
  }

  private async fire(): Promise<void> {
    this.timer = null
    this.next = null
    if (!this.started || this.firing) return
    const config = this.getConfig()
    if (!config.autonomy.enabled) return
    this.firing = true
    try {
      const now = this.now()
      this.observePresentation(now)

      if (now < this.explorePausedUntil) {
        this.pauseSkipped += 1
        this.scheduleAt(this.explorePausedUntil)
        return
      }

      let reviewCause: string | null = null
      if (this.restMode !== 'quiet' && now < this.restUntil) {
        // 连续休息/新目标等触发的复查只放行一次；之后继续尊重原休息期限。
        if (this.restReviewAt > 0 && now >= this.restReviewAt) {
          reviewCause = this.restReviewReason ?? 'rest-review'
          this.restReviewAt = 0
          this.restReviewReason = null
        } else {
          this.scheduleAt(this.reviewOrRestAt(now))
          return
        }
      }

      if (this.isPaused() || this.isBusy()) {
        this.scheduleAt(now + RETRY_MS)
        return
      }

      // 已有自主任务在排队/执行：不要用新的探索 tick 打断它的续跑。
      if (this.hasActiveAutonomyTask?.() === true) {
        this.scheduleAt(now + RETRY_MS)
        return
      }

      if (!this.started) return
      const at = this.now()
      const decision = this.inject(this.tickText(at, config, reviewCause))
      this.lastTickAt = at
      if (decision === null || decision.mode !== 'flush') {
        const deferred = decision?.mode === 'piggyback' ? decision.deferredAt : null
        this.scheduleAt(deferred !== null && deferred > at ? deferred : at + RETRY_MS)
        return
      }
      this.silentStreak += 1
      if (reviewCause !== null && this.restMode !== 'quiet' && this.restUntil > at) {
        // 复查后没有明确的节奏调整就继续原来的休息，而不是立刻恢复正常探索。
        this.scheduleAt(this.restUntil)
        return
      }
      this.scheduleNext(at)
    } catch (error) {
      this.logger.warn('自主 tick 失败', { error: String(error) })
      this.scheduleAt(this.now() + RETRY_MS)
    } finally {
      this.firing = false
    }
  }

  private observePresentation(_now: number): void {
    // 表现动作不是探索进展，也不重置退避；只保留 lastPresentationAt 供诊断。
  }

  /**
   * 探索期限由「上次真实进展」与退避次数决定，并被 10 分钟最大等待封顶。
   * 外部事件不参与计算，因此无法无限推迟。
   */
  private dueAt(now: number): number {
    const config = this.getConfig()
    if (config.autonomy.mode !== 'explore') {
      return now + this.intervalMs(this.silentStreak)
    }
    const first = this.startedAt + FIRST_EXPLORE_MS
    if (this.lastTickAt === 0 && this.lastProgressAt <= this.startedAt) {
      return now < first ? first : now + 1_000
    }
    const anchor = Math.max(this.lastProgressAt, this.startedAt, this.lastTickAt)
    const interval = this.intervalMs(this.silentStreak)
    // 休眠/长时间阻塞后立即补一次机会，但绝不因外部事件把期限往后推。
    return Math.min(Math.max(anchor + interval, now + 1_000), now + EXPLORE_MAX_WAIT_MS)
  }

  private scheduleNext(at: number): void {
    if (this.getConfig().autonomy.mode === 'explore') {
      const interval = Math.min(this.intervalMs(this.silentStreak), EXPLORE_MAX_WAIT_MS)
      this.scheduleAt(at + interval)
      return
    }
    this.scheduleAt(at + this.intervalMs(this.silentStreak))
  }

  private intervalMs(streak: number): number {
    const config = this.getConfig().autonomy
    const min = Math.max(60_000, config.tickMinMs)
    const max = Math.max(min, config.tickMaxMs)
    const factor = Math.max(1, config.backoffFactor)
    const value = min * Math.pow(factor, Math.max(0, streak))
    const capped = Math.min(max, Math.round(value))
    if (config.mode !== 'explore') return capped
    // 探索模式必须有界：正常活跃使用时至少每 10 分钟获得一次可运行机会。
    return Math.min(capped, EXPLORE_MAX_WAIT_MS)
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

  private quietMinutes(now: number): number {
    const since = Math.max(this.lastActivityAt, this.lastTickAt, now - 24 * 60 * 60_000)
    return Math.max(0, Math.round((now - since) / 60_000))
  }

  private tickText(
    now: number,
    config: AppConfig,
    reviewCause: string | null = null
  ): string {
    const clock = new Date(now).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
    const parts = [
      `[system/autonomy] 现在 ${clock}，已经安静 ${this.quietMinutes(now)} 分钟。` +
        '没有必须回应的内容；你可以保持安静，也可以看看、记住或做点什么。'
    ]
    if (config.autonomy.mode === 'explore') {
      const caps = effectiveCapabilities(config)
      const scopes: string[] = []
      if (caps.notesAvailable) scopes.push('写 notes/')
      if (caps.ordinaryApps) scopes.push('观察并操作普通桌面应用窗口（类别授权）')
      else if (caps.windowsCategory) scopes.push('观察普通窗口（窗口类别授权，不含输入）')
      else if (caps.observeApps.length > 0) {
        scopes.push(`观察 ${caps.observeApps.length} 个已授权应用窗口`)
      }
      if (!caps.ordinaryApps && caps.inputApps.length > 0) {
        scopes.push(`在 ${caps.inputApps.length} 个已授权应用里输入（需窗口截图）`)
      }
      if (caps.web) scopes.push('搜索并读取公开网页')
      else if (caps.browserPage) scopes.push('读取当前浏览器页面')
      if (caps.browserControl) scopes.push('在自己的浏览器标签里主动浏览普通网页')
      // B 站独立 API 路线不依赖扩展/标签页；也不额外制造强制产出定时器。
      if (caps.bilibili) {
        scopes.push('只读浏览 B 站推荐/搜索/字幕，按需看故事板并本地转写')
      }
      if (caps.ordinaryApps) scopes.push('发现、启动、切换普通应用')
      else if (caps.launchableApps.length > 0) {
        scopes.push(`启动 ${caps.launchableApps.length} 个系统应用白名单应用`)
      }
      if (caps.fileReadCategory) scopes.push('连续读取授权目录')
      if (caps.artifactsAvailable) scopes.push('在她自己的作品目录里写草稿/数据')
      if (
        caps.fileWorldRoots > 0 ||
        caps.workspaceRoot ||
        caps.trustedRoots > 0
      ) {
        scopes.push('读取已授权目录')
      }
      const brief = this.capabilitySummary?.() ?? null
      const scopeText =
        brief !== null
          ? brief.scopes.length === 0
            ? `当前没有实际可执行的目录、窗口、网页或启动范围${
                brief.reasons.length === 0 ? '' : `（${brief.reasons.join('；')}）`
              }；不要假装探索或反复重试同一失败动作，只用现有对话/记忆，或如实保持安静。`
            : `当前实际可用范围：${brief.scopes.join('；')}。未列出的能力此刻不可用，不要假设或反复重试。`
          : !hasExploreScope(caps)
            ? '当前没有可用的目录、窗口、网页或启动范围；不要假装探索，只用现有对话/记忆，或如实保持安静。'
            : `当前可用范围：${scopes.join('；')}。这些来自用户既有配置，不能扩大。`
      const notesText = caps.notesAvailable
        ? ''
        : caps.notesConfigured
          ? '笔记目录当前不可访问：不要声称写了笔记。'
          : '还没有可用的笔记目录：不要声称写了笔记，也不要声称写进 notes/。'
      parts.push(
        '自主探索已开启：这是一次实际查看的机会。可以先从兴趣/经历/最近对话里选一个候选，' +
          '用真实读取或已授权动作推进；需要连续几步时用 task_create（source=autonomy）给自己建一个有界小目标，' +
          '已有权限内不需要用户每一步确认。' +
          scopeText +
          notesText +
          '如果 task_list 里有你遗留的失败/过期自主目标，先用 task_abandon 放弃它再创建新目标；' +
          '你只能查看和管理自主目标，绝不能触碰用户任务。' +
          (caps.notesAvailable
            ? '形成值得分享的真实发现就写笔记并回读验证；'
            : '形成值得分享的真实发现可以（在配置允许时）用 pet_say 轻轻提一句，不要声称写了笔记；') +
          '没有发现可以保持安静或继续调查，但不能把“没看”说成“看过”。' +
          (caps.browserControl
            ? '如果此刻正好好奇，可以把“主动浏览普通网页一会儿”选成本轮小目标：先用 browser_status ' +
              '看扩展控制通道，再用 browser_open/browser_snapshot（view=structure 或 view=text）真实读取；只操作她自己的后台标签页，' +
              '绝不点赞/评论/发布/购买。没有值得分享的就结束会话，不要为了产出硬凑。'
            : '') +
          (caps.bilibili
            ? '也可以把“读一会儿 B 站”选成本轮小目标。这条路线是独立只读 API，不需要浏览器扩展或标签页：' +
              '用 bili_open 取推荐或 bili_search 搜索，挑 1-2 条用 bili_detail 看详情和分 P，' +
              '有字幕就分段读原文；没有字幕或覆盖不足时可提交本地转写，完成后再读取评价。' +
              '只有内容依赖画面时才用 bili_frames。每检查一条用 bili_assess 写真实判断，' +
              '值得分享再用 discovery_save 引用 observationId。绝不点赞/投币/收藏/关注/评论/私信，' +
              '也不要用固定定时器反复刷；空列表就是空列表。日报由系统按结构化记录更新，' +
              '不要声称看过没读到的内容。'
            : '') +
          '用户忙或不想被打扰时，优先选择不妨碍他的后台活动；只是少说话/不抢前台时用 autonomy_rest 的 mode=quiet，' +
          '探索机会仍会继续。只有确实要停下才用 mode=rest；在等一个可验证条件时用 mode=waiting 并写清 waitFor/recheckMinutes。' +
          '选择休息前先看候选池、遗留自主目标和当前实际能力；不能什么都没评估就连续休息。'
      )
      if (reviewCause !== null) {
        const progressAge =
          this.lastProgressAt > 0
            ? Math.max(0, Math.round((now - this.lastProgressAt) / 60_000))
            : null
        parts.push(
          '[rest-review] 这次是提前复查，不是常规唤醒：' +
            `原因=${reviewCause}；连续休息 ${this.consecutiveRests} 次；` +
            (progressAge === null ? '还没有真实进展记录' : `距上次真实进展 ${progressAge} 分钟`) +
            '。先重新检查候选池、遗留任务和当前能力：有可执行的后台目标就推进一小步；' +
            '确实都不可执行或条件未满足时，如实选择 waiting 或继续 rest，并说明恢复条件。'
        )
      }
      // 线索只提供“可以接着看什么”。是否继续、换一条、放弃或休息由模型判断，
      // 不把候选写成固定任务，也不要求每轮必须产出。
      if (this.describeCandidates !== undefined) {
        const candidates = this.describeCandidates()
        if (candidates !== null && candidates.trim() !== '') {
          parts.push(
            '[候选] 以下是本地已有线索，不是必须执行的任务；你可以选一条继续、放弃、换一条或休息。\n' +
              candidates.trim()
          )
        }
      }
    }
    if (config.autonomy.ambientContext && this.describeContext !== undefined) {
      const context = this.describeContext()
      if (context !== null && context.trim() !== '') parts.push(`[ambient] ${context.trim()}`)
    }
    return parts.join('\n')
  }
}
