/**
 * 本地环境活动调度器（主进程唯一所有者）。
 *
 * 负责两个独立截止时间：
 *  - 随机小动作：默认每 U(120s, 300s) 一段 once；
 *  - 随机走动：默认每 U(180s, 360s) 一次短程真实位移。
 *
 * 它不播放动画、不做物理、不调用 LLM，也不生成气泡；只把到期的
 * ambient-random / ambient-roam 请求交给现有 animationBroker / movementBroker，
 * 以页面真实回执决定是否重新采样。页面状态快照过期、隐藏、挂起或配置关闭时
 * 暂停，不补播积压。所有时间/RNG/计时器均可注入，便于用可控时钟验收。
 */

import {
  PET_CATALOG,
  PET_MOVEMENT_ANIMATIONS,
  isLookAroundAnimation,
  type PetAnimationOutcome,
  type PetAnimationReceipt,
  type PetMovementOutcome,
  type PetMovementReceipt,
  type PetPageStateSnapshot
} from '../../shared/petPresentation'
import type { PetAnimationRequestMeta } from './animationBroker'
import type { PetMovementRequestMeta } from './movementBroker'
import {
  AmbientActionPicker,
  isAmbientEligibleAnimation,
  pickRoamTarget
} from '../../shared/dshPet/ambientCatalog'

export interface AmbientSchedulerConfig {
  petEnabled: boolean
  reducedMotion: boolean
  movementEnabled: boolean
  randomIdle: { enabled: boolean; minIntervalMs: number; maxIntervalMs: number }
  randomRoam: { enabled: boolean; minIntervalMs: number; maxIntervalMs: number }
}

export interface AmbientActionRequest {
  animationId: string
  mode: 'once'
  source: 'ambient'
  requestClass: 'ambient-random'
  expiresAt: number
}

export interface AmbientRoamRequest {
  target: number
  animationId: string
  autonomous: true
  requestClass: 'ambient-roam'
}

export interface AmbientSchedulerDeps {
  getConfig: () => AmbientSchedulerConfig
  requestAction: (request: AmbientActionRequest) => Promise<PetAnimationOutcome>
  requestRoam: (request: AmbientRoamRequest) => Promise<PetMovementOutcome>
  now?: () => number
  random?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
  logger?: (event: string, data?: Record<string, unknown>) => void
  /** 测试可注入固定候选；生产使用默认池。 */
  actionPicker?: AmbientActionPicker
  roamPicker?: AmbientActionPicker
}

type ActivityKind = 'action' | 'roam'

interface ResultRecord {
  animationId: string
  status: string
  reason: string | null
  at: number
  /** 从原截止时间到实际开始/失败的等待时长；用于诊断互斥/占用延迟。 */
  delayMs: number
  /** 最近一次造成等待的固定原因，例如 background-gap / busy / panel-open。 */
  waitReason: string | null
}

/** 到期被占用后，连续安静这么久才重新尝试。 */
const QUIET_RECHECK_MS = 10_000
/** 页面快照超过这个年龄就暂停尝试；重载期间保留截止时间。 */
const PAGE_STALE_MS = 20_000
/** 两类后台活动启动之间至少间隔，避免一段表演后立刻跑走。 */
const MIN_BACKGROUND_GAP_MS = 45_000
/** 素材失败后的隔离时长；隔离期间仍可随机到其它候选。 */
const QUARANTINE_MS = 15 * 60_000
const MAX_FAILURE_BACKOFF_MS = 15 * 60_000
/** 随机请求的迟到上限；过期后页面必须拒绝。 */
const AMBIENT_TTL_MS = 30_000
const MAX_TIMER_MS = 2_147_000_000

const IDLE_ANIMATIONS = new Set<string>(PET_CATALOG.animations.idle)

function defaultTimer(callback: () => void, delayMs: number): unknown {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return timer
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * 页面状态里属于「不能插播」的占用。随机动作允许停靠时播放，
 * 随机走动在停靠时必须等待下窗沿。
 */
export function ambientBlockerReason(
  state: PetPageStateSnapshot,
  kind: ActivityKind,
  config: AmbientSchedulerConfig
): string | null {
  if (state.reducedMotion || config.reducedMotion) return 'reduced-motion'
  if (!state.ready) return 'page-not-ready'
  if (!state.visible) return 'page-hidden'
  if (state.suspended) return 'suspended'
  if (state.dragging) return 'dragging'
  if (state.throwing) return 'throwing'
  if (state.panelOpen) return 'panel-open'
  if (state.menuOpen) return 'menu-open'
  if (state.working) return 'work-status'
  if (state.moving) return 'moving'
  if (state.pending) return 'pending-action'
  if (state.active) return 'busy'
  if (kind === 'roam') {
    if (!config.movementEnabled) return 'movement-disabled'
    if (state.perched) return 'perched'
    if (
      state.xRatio === null ||
      state.reachableMinRatio === null ||
      state.reachableMaxRatio === null ||
      state.displayWidth === null
    ) {
      return 'no-geometry'
    }
  }
  return null
}

export class AmbientScheduler {
  private readonly getConfig: () => AmbientSchedulerConfig
  private readonly requestAction: (request: AmbientActionRequest) => Promise<PetAnimationOutcome>
  private readonly requestRoam: (request: AmbientRoamRequest) => Promise<PetMovementOutcome>
  private readonly now: () => number
  private readonly random: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly logger: (event: string, data?: Record<string, unknown>) => void
  private readonly actionPicker: AmbientActionPicker
  private readonly roamPicker: AmbientActionPicker

  private started = false
  private disposed = false
  private timer: unknown | null = null
  private pageState: PetPageStateSnapshot | null = null

  private nextActionAt: number | null = null
  private nextRoamAt: number | null = null
  private actionDue = false
  private roamDue = false
  private inFlight: ActivityKind | null = null
  private wasBlocked = false
  private quietSince: number | null = null
  private lastBackgroundStartAt: number | null = null
  private failureStreak = 0
  private readonly quarantined = new Map<string, number>()
  private readonly externalPauses = new Set<string>()
  private configKey = ''
  private hadConfig = false
  private pauseReason: string | null = null
  private emptyPoolReason: string | null = null
  private lastAction: ResultRecord | null = null
  private lastRoam: ResultRecord | null = null
  private lastActionWaitReason: string | null = null
  private lastRoamWaitReason: string | null = null
  private lastForegroundAnimation: string | null = null
  private lastForegroundMovementAt: number | null = null

  constructor(deps: AmbientSchedulerDeps) {
    this.getConfig = deps.getConfig
    this.requestAction = deps.requestAction
    this.requestRoam = deps.requestRoam
    this.now = deps.now ?? (() => Date.now())
    this.random = deps.random ?? Math.random
    this.setTimer = deps.setTimer ?? defaultTimer
    this.clearTimer = deps.clearTimer ?? defaultClearTimer
    this.logger = deps.logger ?? (() => undefined)
    this.actionPicker = deps.actionPicker ?? new AmbientActionPicker({ random: this.random })
    this.roamPicker =
      deps.roamPicker ??
      new AmbientActionPicker({
        candidates: PET_MOVEMENT_ANIMATIONS,
        random: this.random,
        recentLimit: 2
      })
  }

  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    this.evaluate('start')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.started = false
    this.clearTimerIfAny()
    this.pageState = null
    this.inFlight = null
  }

  /** 配置保存、窗口显示/隐藏、系统恢复后都调用；只维护一个 timer。 */
  refresh(reason = 'refresh'): void {
    if (!this.started || this.disposed) return
    this.evaluate(reason)
  }

  setExternalPaused(reason: string, paused: boolean): void {
    if (this.disposed) return
    if (paused) {
      if (this.externalPauses.has(reason)) return
      this.externalPauses.add(reason)
      this.clearDeadlines()
    } else {
      if (!this.externalPauses.delete(reason)) return
    }
    if (this.started) this.evaluate(paused ? `pause:${reason}` : `resume:${reason}`)
  }

  /** 页面每次上报（ready/可见/占用/位置变化）都从这里进入。 */
  updatePageState(snapshot: PetPageStateSnapshot): void {
    if (this.disposed) return
    if (!Number.isFinite(snapshot.at)) return
    if (this.pageState !== null && snapshot.at < this.pageState.at) return
    this.pageState = snapshot
    if (this.started) this.evaluate('page-state')
  }

  /**
   * 前台动作回执观察。只有真正 started 的非基础、非张望动作会重采样随机动作计时，
   * 避免刚根据聊天演完一段又立刻随机重播；点击/思考/待机不重置。
   */
  noteAnimationReceipt(
    receipt: PetAnimationReceipt,
    meta: PetAnimationRequestMeta | null
  ): void {
    if (!this.started || this.disposed || meta === null) return
    if (receipt.status !== 'started') return
    if (
      meta.requestClass === 'work-status' ||
      meta.requestClass === 'ambient-random' ||
      meta.requestClass === 'ambient-roam' ||
      meta.requestClass === 'interaction'
    ) {
      return
    }
    if (isLookAroundAnimation(receipt.animationId) || IDLE_ANIMATIONS.has(receipt.animationId)) {
      return
    }
    // 只有真正出画的模型/用户动作才进入近期去重；被拒/排队不算播放过。
    this.actionPicker.noteForegroundPlayed(receipt.animationId)
    this.lastForegroundAnimation = receipt.animationId
    this.resampleAction(this.now(), 'foreground-animation')
    this.evaluate('foreground-animation')
  }

  /** 模型/用户真实移动成功也从 started 重新采样随机走动。 */
  noteMovementReceipt(
    receipt: PetMovementReceipt,
    meta: PetMovementRequestMeta | null
  ): void {
    if (!this.started || this.disposed) return
    if (meta?.requestClass === 'ambient-roam') return
    if (receipt.status !== 'started') return
    this.lastForegroundMovementAt = receipt.at
    this.resampleRoam(this.now(), 'foreground-movement')
    this.evaluate('foreground-movement')
  }

  diagnostics(): Record<string, unknown> {
    const now = this.now()
    const state = this.pageState
    return {
      started: this.started,
      disposed: this.disposed,
      pauseReason: this.pauseReason,
      externalPauses: [...this.externalPauses],
      pageStateAgeMs: state === null ? null : Math.max(0, now - state.at),
      pageState:
        state === null
          ? null
          : {
              ready: state.ready,
              visible: state.visible,
              idle: state.idle,
              working: state.working,
              active: state.active,
              pending: state.pending,
              moving: state.moving,
              panelOpen: state.panelOpen,
              menuOpen: state.menuOpen,
              dragging: state.dragging,
              throwing: state.throwing,
              perched: state.perched,
              suspended: state.suspended,
              reducedMotion: state.reducedMotion
            },
      nextActionAt: this.nextActionAt,
      nextRoamAt: this.nextRoamAt,
      actionDue: this.actionDue,
      roamDue: this.roamDue,
      inFlight: this.inFlight,
      quietRecheckPending: this.quietSince !== null,
      timerScheduled: this.timer !== null,
      lastBackgroundStartAt: this.lastBackgroundStartAt,
      lastAction: this.lastAction,
      lastRoam: this.lastRoam,
      lastForegroundAnimation: this.lastForegroundAnimation,
      lastForegroundMovementAt: this.lastForegroundMovementAt,
      failureStreak: this.failureStreak,
      emptyPoolReason: this.emptyPoolReason,
      quarantined: [...this.quarantined.entries()].map(([animationId, until]) => ({
        animationId,
        until
      })),
      actionPicker: this.actionPicker.diagnostics(),
      roamPicker: this.roamPicker.diagnostics(),
      lookAround: state?.lookAround ?? null
    }
  }

  // ------------------------------------------------------------------ 内部

  private evaluate(reason: string): void {
    if (!this.started || this.disposed) return
    const now = this.now()
    const config = this.getConfig()
    this.syncConfig(now, config)

    const hardPause = this.hardPauseReason(config)
    if (hardPause !== null) {
      if (
        this.pauseReason !== hardPause ||
        this.nextActionAt !== null ||
        this.nextRoamAt !== null ||
        this.actionDue ||
        this.roamDue
      ) {
        this.clearDeadlines()
      }
      this.pauseReason = hardPause
      this.clearTimerIfAny()
      return
    }
    this.pauseReason = null

    // 首次采样必须等页面真正 ready；启动早期不预先消耗一段随机间隔。
    // 已存在的截止时间在 renderer 重载/短暂未 ready 时保留，不重新抽取。
    const canSample = this.pageState !== null && this.pageState.ready
    if (canSample && this.nextActionAt === null && config.randomIdle.enabled) {
      this.nextActionAt = now + this.sampleInterval(config.randomIdle)
      this.logger('sample-action', { at: this.nextActionAt })
    }
    if (
      canSample &&
      this.nextRoamAt === null &&
      config.randomRoam.enabled &&
      config.movementEnabled
    ) {
      this.nextRoamAt = now + this.sampleInterval(config.randomRoam)
      this.logger('sample-roam', { at: this.nextRoamAt })
    }

    this.pruneQuarantine(now)
    if (this.nextActionAt !== null && now >= this.nextActionAt) this.actionDue = true
    if (this.nextRoamAt !== null && now >= this.nextRoamAt) this.roamDue = true

    if (!this.actionDue && !this.roamDue) {
      this.wasBlocked = false
      this.quietSince = null
      this.armForNext(now)
      return
    }
    if (this.inFlight !== null) {
      this.noteDueWait('body-busy')
      return
    }

    const state = this.pageState
    if (state === null || !state.ready) {
      // 页面重载/首次加载：保留截止时间，等新快照唤醒；不补播离线期间的多次机会。
      this.noteDueWait('page-not-ready')
      this.clearTimerIfAny()
      return
    }
    if (now - state.at > PAGE_STALE_MS) {
      // 快照陈旧：暂停尝试，但保留 due，收到新快照后只兑现一次。
      this.noteDueWait('page-stale')
      this.clearTimerIfAny()
      return
    }

    // 最早到期的一项若被其独有占用挡住（典型是停靠/无几何时的随机走动），
    // 不能连带饿死另一项已经到期的随机小动作；共享占用仍会让两者一起等待。
    let kind = this.chooseDueKind()
    let blocker = ambientBlockerReason(state, kind, config)
    if (blocker !== null && this.actionDue && this.roamDue) {
      const alternative: ActivityKind = kind === 'action' ? 'roam' : 'action'
      if (ambientBlockerReason(state, alternative, config) === null) {
        kind = alternative
        blocker = null
      }
    }
    if (blocker !== null) {
      // 分别记录各自真实的占用原因；停靠只挡走动时不应把已到期的小动作
      // 诊断成同样在等停靠。
      const actionBlocker = this.actionDue
        ? ambientBlockerReason(state, 'action', config)
        : null
      const roamBlocker = this.roamDue
        ? ambientBlockerReason(state, 'roam', config)
        : null
      if (actionBlocker !== null) this.lastActionWaitReason = actionBlocker
      if (roamBlocker !== null) this.lastRoamWaitReason = roamBlocker
      this.wasBlocked = true
      this.quietSince = null
      this.arm(QUIET_RECHECK_MS)
      return
    }
    if (this.wasBlocked && this.quietSince === null) {
      // 占用刚解除：先观察约 10 秒连续安静，避免拖拽松手/菜单关闭的瞬间插播。
      this.quietSince = now
      this.arm(QUIET_RECHECK_MS)
      return
    }
    if (this.quietSince !== null && now - this.quietSince < QUIET_RECHECK_MS) {
      this.arm(this.quietSince + QUIET_RECHECK_MS - now)
      return
    }
    this.wasBlocked = false
    this.quietSince = null

    const gap = this.backgroundGapRemaining(now)
    if (gap > 0) {
      this.noteDueWait('background-gap')
      this.arm(gap)
      return
    }

    this.clearTimerIfAny()
    if (kind === 'action') void this.runAction(now, config)
    else void this.runRoam(now, config)
  }

  private syncConfig(now: number, config: AmbientSchedulerConfig): void {
    const key = JSON.stringify(config)
    if (!this.hadConfig) {
      this.hadConfig = true
      this.configKey = key
      return
    }
    if (key === this.configKey) return
    const previous = this.configKey
    this.configKey = key
    this.logger('config-changed', { previous })
    // 间隔/开关变化立即生效：重置对应截止时间，由本轮 evaluate 重新采样。
    this.nextActionAt = null
    this.actionDue = false
    this.nextRoamAt = null
    this.roamDue = false
    this.quietSince = null
    this.wasBlocked = false
    void now
  }

  private hardPauseReason(config: AmbientSchedulerConfig): string | null {
    if (!config.petEnabled) return 'pet-disabled'
    if (config.reducedMotion) return 'reduced-motion'
    if (this.externalPauses.size > 0) {
      return [...this.externalPauses].sort()[0] ?? 'external-pause'
    }
    const state = this.pageState
    // 尚未收到页面快照时不算暂停；收到后才第一次采样。
    if (state === null) return null
    if (!state.visible) return 'page-hidden'
    if (state.suspended) return 'suspended'
    if (state.reducedMotion) return 'reduced-motion'
    return null
  }

  /** 记录到期等待原因；只在真的 due 时写入，避免污染未到期项目。 */
  private noteDueWait(reason: string): void {
    if (this.actionDue) this.lastActionWaitReason = reason
    if (this.roamDue) this.lastRoamWaitReason = reason
  }

  private chooseDueKind(): ActivityKind {
    if (this.actionDue && this.roamDue) {
      const actionAt = this.nextActionAt ?? Number.POSITIVE_INFINITY
      const roamAt = this.nextRoamAt ?? Number.POSITIVE_INFINITY
      return actionAt <= roamAt ? 'action' : 'roam'
    }
    return this.actionDue ? 'action' : 'roam'
  }

  private backgroundGapRemaining(now: number): number {
    if (this.lastBackgroundStartAt === null) return 0
    const elapsed = now - this.lastBackgroundStartAt
    return elapsed >= MIN_BACKGROUND_GAP_MS ? 0 : MIN_BACKGROUND_GAP_MS - elapsed
  }

  private armForNext(now: number): void {
    const deadlines = [this.nextActionAt, this.nextRoamAt].filter(
      (value): value is number => value !== null
    )
    if (deadlines.length === 0) {
      this.clearTimerIfAny()
      return
    }
    const next = Math.min(...deadlines)
    if (next <= now) {
      // 不应发生：到期会在上面转成 due；给 1ms 兜底而不是忙循环。
      this.arm(1)
      return
    }
    this.arm(next - now)
  }

  private arm(delayMs: number): void {
    this.clearTimerIfAny()
    const delay = Math.max(1, Math.min(MAX_TIMER_MS, Math.round(delayMs)))
    this.timer = this.setTimer(() => {
      this.timer = null
      this.evaluate('timer')
    }, delay)
  }

  private clearTimerIfAny(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }

  private sampleInterval(range: { minIntervalMs: number; maxIntervalMs: number }): number {
    const low = Math.max(1_000, Math.min(range.minIntervalMs, range.maxIntervalMs))
    const high = Math.max(low, Math.max(range.minIntervalMs, range.maxIntervalMs))
    return Math.round(low + this.random() * (high - low))
  }

  private resampleAction(now: number, reason: string): void {
    const config = this.getConfig()
    if (!config.randomIdle.enabled || !config.petEnabled || config.reducedMotion) {
      this.nextActionAt = null
      this.actionDue = false
      this.lastActionWaitReason = null
      return
    }
    this.actionDue = false
    this.nextActionAt = now + this.sampleInterval(config.randomIdle)
    this.quietSince = null
    this.wasBlocked = false
    this.lastActionWaitReason = null
    this.logger('resample-action', { reason, at: this.nextActionAt })
  }

  private resampleRoam(now: number, reason: string): void {
    const config = this.getConfig()
    if (!config.randomRoam.enabled || !config.movementEnabled || !config.petEnabled) {
      this.nextRoamAt = null
      this.roamDue = false
      this.lastRoamWaitReason = null
      return
    }
    this.roamDue = false
    this.nextRoamAt = now + this.sampleInterval(config.randomRoam)
    this.quietSince = null
    this.wasBlocked = false
    this.lastRoamWaitReason = null
    this.logger('resample-roam', { reason, at: this.nextRoamAt })
  }

  private clearDeadlines(): void {
    this.nextActionAt = null
    this.nextRoamAt = null
    this.actionDue = false
    this.roamDue = false
    this.quietSince = null
    this.wasBlocked = false
    this.lastActionWaitReason = null
    this.lastRoamWaitReason = null
  }

  private quarantineSet(now: number): Set<string> {
    const excluded = new Set<string>()
    for (const [id, until] of this.quarantined) {
      if (until > now) excluded.add(id)
    }
    return excluded
  }

  private pruneQuarantine(now: number): void {
    for (const [id, until] of this.quarantined) {
      if (until <= now) this.quarantined.delete(id)
    }
  }

  private async runAction(now: number, config: AmbientSchedulerConfig): Promise<void> {
    this.inFlight = 'action'
    const scheduledAt = this.nextActionAt
    const animationId = this.actionPicker.pick(this.quarantineSet(now))
    if (animationId === null || !isAmbientEligibleAnimation(animationId)) {
      this.emptyPoolReason = 'no-eligible-animation'
      this.actionDue = false
      this.inFlight = null
      this.resampleAction(now, 'empty-pool')
      this.logger('action-empty-pool', { reason: this.emptyPoolReason })
      this.evaluate('action-empty-pool')
      return
    }
    this.emptyPoolReason = null
    let outcome: PetAnimationOutcome
    try {
      outcome = await this.requestAction({
        animationId,
        mode: 'once',
        source: 'ambient',
        requestClass: 'ambient-random',
        expiresAt: now + AMBIENT_TTL_MS
      })
    } catch {
      outcome = { status: 'failed', animationId, reason: 'scheduler-error' }
    }
    if (!this.started || this.disposed) return
    this.inFlight = null
    const finishedAt = this.now()
    this.lastAction = {
      animationId,
      status: outcome.status,
      reason: outcome.reason ?? null,
      at: finishedAt,
      delayMs: scheduledAt === null ? 0 : Math.max(0, finishedAt - scheduledAt),
      waitReason: this.lastActionWaitReason
    }
    if (outcome.status === 'started' || outcome.status === 'completed') {
      this.actionDue = false
      this.failureStreak = 0
      this.wasBlocked = false
      this.quietSince = null
      this.lastBackgroundStartAt = finishedAt
      this.actionPicker.notePlayed(animationId)
      this.resampleAction(finishedAt, 'started')
      this.logger('action-started', { animationId, at: finishedAt })
    } else if (this.isDeferredOutcome(outcome.status, outcome.reason)) {
      // 页面在快照之后被占用/请求过期/重载：保留单个 due，安静后重试。
      this.wasBlocked = true
      this.quietSince = null
      this.arm(QUIET_RECHECK_MS)
      this.logger('action-deferred', {
        animationId,
        status: outcome.status,
        reason: outcome.reason ?? null
      })
    } else {
      this.recordActionFailure(animationId, outcome, finishedAt, config)
    }
    this.evaluate('action-result')
  }

  private async runRoam(now: number, config: AmbientSchedulerConfig): Promise<void> {
    this.inFlight = 'roam'
    const scheduledAt = this.nextRoamAt
    const animationId = this.roamPicker.pick(this.quarantineSet(now))
    if (animationId === null) {
      this.roamDue = false
      this.inFlight = null
      this.resampleRoam(now, 'empty-pool')
      this.logger('roam-empty-pool')
      this.evaluate('roam-empty-pool')
      return
    }
    const state = this.pageState
    const move = PET_CATALOG.animations.moves.actions.find((item) => item.name === animationId)
    const target =
      state === null
        ? null
        : pickRoamTarget({
            xRatio: state.xRatio ?? 0.5,
            reachableMinRatio: state.reachableMinRatio ?? 0,
            reachableMaxRatio: state.reachableMaxRatio ?? 1,
            displayWidth: state.displayWidth ?? 0,
            size: state.size,
            ...(move?.params === undefined ? {} : { params: move.params }),
            random: this.random
          })
    if (target === null) {
      this.roamDue = false
      this.inFlight = null
      const waitReason = this.lastRoamWaitReason
      this.resampleRoam(now, 'no-target')
      this.lastRoam = {
        animationId,
        status: 'skipped',
        reason: 'no-target',
        at: now,
        delayMs: scheduledAt === null ? 0 : Math.max(0, now - scheduledAt),
        waitReason
      }
      this.logger('roam-no-target', { animationId })
      this.evaluate('roam-no-target')
      return
    }
    let outcome: PetMovementOutcome
    try {
      outcome = await this.requestRoam({
        target: target.targetRatio,
        animationId,
        autonomous: true,
        requestClass: 'ambient-roam'
      })
    } catch {
      outcome = { status: 'failed', animationId, target: target.targetRatio, reason: 'scheduler-error' }
    }
    if (!this.started || this.disposed) return
    this.inFlight = null
    const finishedAt = this.now()
    this.lastRoam = {
      animationId,
      status: outcome.status,
      reason: outcome.reason ?? null,
      at: finishedAt,
      delayMs: scheduledAt === null ? 0 : Math.max(0, finishedAt - scheduledAt),
      waitReason: this.lastRoamWaitReason
    }
    if (outcome.status === 'started' || outcome.status === 'completed') {
      this.roamDue = false
      this.failureStreak = 0
      this.wasBlocked = false
      this.quietSince = null
      this.lastBackgroundStartAt = finishedAt
      this.roamPicker.notePlayed(animationId)
      this.resampleRoam(finishedAt, 'started')
      this.logger('roam-started', {
        animationId,
        target: Math.round(target.targetRatio * 1000) / 1000,
        distanceDip: Math.round(target.distanceDip)
      })
    } else if (outcome.status === 'already_at_target') {
      // 没有真实位移就不算一次活动；按正常节奏重新采样，不做高频重试。
      this.roamDue = false
      this.resampleRoam(finishedAt, 'already-at-target')
      this.logger('roam-noop', { animationId })
    } else if (
      outcome.reason === 'page-unavailable' ||
      outcome.reason === 'page-gone' ||
      outcome.status === 'blocked' ||
      outcome.status === 'interrupted'
    ) {
      // 页面重载/暂时不可用与实际占用一样保留 due，等新快照后重试一次。
      this.wasBlocked = true
      this.quietSince = null
      this.arm(QUIET_RECHECK_MS)
      this.logger('roam-deferred', {
        animationId,
        status: outcome.status,
        reason: outcome.reason ?? null
      })
    } else {
      this.recordRoamFailure(animationId, outcome, finishedAt, config)
    }
    this.evaluate('roam-result')
  }

  private isDeferredOutcome(status: string, reason: string | undefined): boolean {
    // renderer 重载/页面暂时不可用并不代表素材坏了；保留原 due，
    // 新页面就绪后重试一次，不能隔离素材或重新抽一整个间隔。
    if (reason === 'page-unavailable' || reason === 'page-gone') return true
    if (status === 'rejected') {
      // 配置/页面素材问题由结果路径处理；占用与竞态保留 due 等安静后重试。
      return (
        reason === 'expired' ||
        reason === 'busy' ||
        reason === 'dragging' ||
        reason === 'throwing' ||
        reason === 'suspended' ||
        reason === 'menu-open' ||
        reason === 'panel-open' ||
        reason === 'work-status' ||
        reason === 'moving' ||
        reason === 'pending' ||
        reason === 'protected' ||
        reason === 'look-around-cooldown' ||
        reason === 'semantic-gap' ||
        reason === 'reduced-motion'
      )
    }
    return status === 'queued' || status === 'interrupted'
  }

  private recordActionFailure(
    animationId: string,
    outcome: PetAnimationOutcome,
    at: number,
    config: AmbientSchedulerConfig
  ): void {
    this.actionDue = false
    this.failureStreak += 1
    const reason = outcome.reason ?? 'unknown'
    if (this.shouldQuarantine(outcome.status, reason)) {
      this.quarantined.set(animationId, at + QUARANTINE_MS)
    }
    this.resampleAfterFailure(at, config.randomIdle, 'action')
    this.logger('action-failed', { animationId, status: outcome.status, reason })
  }

  private recordRoamFailure(
    animationId: string,
    outcome: PetMovementOutcome,
    at: number,
    config: AmbientSchedulerConfig
  ): void {
    this.roamDue = false
    this.failureStreak += 1
    const reason = outcome.reason ?? 'unknown'
    if (this.shouldQuarantine(outcome.status, reason)) {
      this.quarantined.set(animationId, at + QUARANTINE_MS)
    }
    this.resampleAfterFailure(at, config.randomRoam, 'roam')
    this.logger('roam-failed', { animationId, status: outcome.status, reason })
  }

  private shouldQuarantine(status: string, reason: string): boolean {
    if (status !== 'failed' && status !== 'unsupported') return false
    return reason !== 'timeout' && reason !== 'page-unavailable' && reason !== 'scheduler-error'
  }

  private resampleAfterFailure(
    at: number,
    range: { minIntervalMs: number; maxIntervalMs: number },
    kind: ActivityKind
  ): void {
    const backoff = Math.min(
      MAX_FAILURE_BACKOFF_MS,
      30_000 * Math.pow(2, Math.max(0, this.failureStreak - 1))
    )
    const delay = Math.max(this.sampleInterval(range), backoff)
    if (kind === 'action') {
      this.actionDue = false
      this.nextActionAt = at + delay
      this.quietSince = null
      this.wasBlocked = false
      this.lastActionWaitReason = null
    } else {
      this.roamDue = false
      this.nextRoamAt = at + delay
      this.quietSince = null
      this.wasBlocked = false
      this.lastRoamWaitReason = null
    }
  }
}
