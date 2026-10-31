import type { PetIdleActionsConfig } from '../../shared/config'
import { isLookAroundAnimation } from '../../shared/petPresentation'

/**
 * 待机自主表现策略：本地只回答「是否允许模型选择」，绝不替模型决定播放。
 *
 * - 空闲资格：真实用户输入、任务工具、审批、触摸/拖拽/面板/菜单会重置；
 *   纯表现工具与用于选择的模型推理不会重置，避免自主轮把自己的资格清零。
 * - 身体静止时钟与动作空闲门槛独立：自主思考/展示不重置身体时钟，
 *   关闭待机小动作也不影响走动；真实交互、工作与移动会重置它。
 * - 张望是语义类别：两种张望动画共享一个品类冷却，取品类间隔与同动作间隔中
 *   更严格的一个。用户明确点播仍可通过（由调用方绕过），但会刷新品类时钟。
 * - 冷却：只在真实 `started` 后计时；失败有短退避，移动失败使用单独退避。
 * - 持久化只保存墙钟时间与动作 ID，不含任何用户内容；进程内计时使用单调时钟。
 */

export interface PetIdlePolicyConfig {
  idleActions: PetIdleActionsConfig
  movementEnabled: boolean
  movementMinIdleMs: number
  movementAutonomousMinIntervalMs: number
  reducedMotion: boolean
}

export interface PetPolicyStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export type IdleActionRejection =
  | 'reduced-motion'
  | 'idle-actions-disabled'
  | 'not-idle'
  | 'cooldown'
  | 'same-action-cooldown'
  | 'look-around-cooldown'
  | 'failure-backoff'

export type MovementRejection =
  | 'reduced-motion'
  | 'movement-disabled'
  | 'not-idle'
  | 'cooldown'
  | 'failure-backoff'

export interface ActionEligibility {
  ok: boolean
  reason?: IdleActionRejection
  retryAfterMs?: number
}

export interface MovementEligibility {
  ok: boolean
  reason?: MovementRejection
  retryAfterMs?: number
}

export interface RecentAction {
  id: string
  ageSec: number
  status: 'started' | 'failed'
}

export interface IdlePolicySummary {
  canIdleAction: boolean
  actionReason: IdleActionRejection | null
  canAutonomousMove: boolean
  movementReason: MovementRejection | null
  idleForSec: number
  idleRequiredSec: number
  /** 身体连续静止时长与自主移动门槛（与动作空闲门槛独立）。 */
  bodyIdleForSec: number
  movementIdleRequiredSec: number
  actionCooldownRemainingSec: number
  sameActionCooldownRemainingSec: number
  lookAroundCooldownRemainingSec: number
  movementCooldownRemainingSec: number
  failureBackoffRemainingSec: number
  movementFailureBackoffRemainingSec: number
  lastActionId: string | null
  lastActionAgeSec: number | null
  recentActions: RecentAction[]
}

const FAILURE_BACKOFF_MS = 60_000
const PERSIST_KEY_ACTION = 'pet.autonomy.lastAction'
const PERSIST_KEY_ACTION_TIMES = 'pet.autonomy.actionTimes'
const PERSIST_KEY_MOVEMENT = 'pet.autonomy.lastMovementAt'
const PERSIST_KEY_FAILURE = 'pet.autonomy.lastFailureAt'
const PERSIST_KEY_MOVEMENT_FAILURE = 'pet.autonomy.lastMovementFailureAt'
const PERSIST_KEY_LOOK_AROUND = 'pet.autonomy.lastLookAroundAt'
const FUTURE_TOLERANCE_MS = 5 * 60_000
const MAX_AGE_MS = 30 * 24 * 60 * 60_000
const RECENT_LIMIT = 6
/** 张望是共享品类：即使旧配置调得更短，也不低于 15 分钟。 */
const LOOK_AROUND_CATEGORY_MIN_INTERVAL_MS = 15 * 60_000
/** 只为跨重启的同动作冷却保留最近若干个动作；不保存任何文本。 */
const ACTION_TIME_LIMIT = 24

interface TimedId {
  id: string
  at: number
}

export class PetIdlePolicy {
  private readonly getConfig: () => PetIdlePolicyConfig
  private readonly store: PetPolicyStore | null
  private readonly now: () => number
  private readonly wallNow: () => number

  private lastActivityAt: number
  /** 身体连续静止的起点；自主表现不会重置它。 */
  private lastBodyActivityAt: number
  private lastActionAt: number | null = null
  private lastActionId: string | null = null
  private lastFailureAt: number | null = null
  private lastMovementFailureAt: number | null = null
  private lastMovementAt: number | null = null
  /** 两种张望动画共享的品类时间戳。 */
  private lastLookAroundAt: number | null = null
  /** 张望诊断：真实 started 的墙钟/来源与最近一次拒绝；不含正文。 */
  private lastLookAroundStartedWallAt: number | null = null
  private lastLookAroundSource: string | null = null
  private lastLookAroundAttemptWallAt: number | null = null
  private lastLookAroundRejectedSource: string | null = null
  private lastLookAroundRejectedReason: string | null = null
  /** 自主移动资格评估的脱敏聚合数；只供诊断，不落盘。 */
  private movementEvaluationCount = 0
  private movementAllowedCount = 0
  private readonly movementRejections = new Map<MovementRejection, number>()
  /** 每个动作最近一次真正 started 的单调时间；同动作冷却按它判断。 */
  private readonly actionTimes = new Map<string, number>()
  private readonly recent: Array<{ id: string; at: number; status: 'started' | 'failed' }> = []

  constructor(options: {
    getConfig: () => PetIdlePolicyConfig
    store?: PetPolicyStore | null
    /** 单调时钟（process.hrtime/performance.now）；测试可注入。 */
    now?: () => number
    /** 墙钟；只用于持久化与跨重启换算。 */
    wallNow?: () => number
  }) {
    this.getConfig = options.getConfig
    this.store = options.store ?? null
    this.now = options.now ?? (() => performance.now())
    this.wallNow = options.wallNow ?? (() => Date.now())
    this.lastActivityAt = this.now()
    this.lastBodyActivityAt = this.lastActivityAt
    this.restore()
  }

  /**
   * 真实活动：用户输入、菜单/面板、拖拽/点击、审批、非表现类工具。
   * 同时重置动作空闲门槛与身体静止时钟，但不延长/清空动作冷却。
   */
  markActivity(): void {
    const now = this.now()
    this.lastActivityAt = now
    this.lastBodyActivityAt = now
  }

  /**
   * 只重置身体静止时钟：移动完成后的落点、真实身体交互等。
   * 不重置动作空闲门槛（移动不是「用户在聊天/工作」）。
   */
  markBodyActivity(): void {
    this.lastBodyActivityAt = this.now()
  }

  /** 自主动作通过播放器真实 started 后调用；失败/被拒绝不得调用。 */
  noteActionStarted(id: string, source = 'model-decorative'): void {
    const now = this.now()
    this.lastActionAt = now
    this.lastActionId = id
    if (isLookAroundAnimation(id)) {
      this.lastLookAroundSource = source.slice(0, 80)
      this.noteLookAroundStartedAt(now)
    }
    // 重复动作先删再插，保证 Map 的插入顺序就是最近使用顺序；裁剪时
    // 淘汰的才是真正最久没有播放过的动作，而不是最早出现过的那一个。
    this.actionTimes.delete(id)
    this.actionTimes.set(id, now)
    while (this.actionTimes.size > ACTION_TIME_LIMIT) {
      const oldest = this.actionTimes.keys().next().value
      if (oldest === undefined) break
      this.actionTimes.delete(oldest)
    }
    this.pushRecent(id, 'started')
    this.persistTimedId(PERSIST_KEY_ACTION, { id, at: this.wallNow() })
    this.persistActionTimes()
  }

  noteActionFailed(id: string): void {
    this.lastFailureAt = this.now()
    this.pushRecent(id, 'failed')
    this.store?.set(PERSIST_KEY_FAILURE, this.wallNow())
  }

  /**
   * 用户明确点播张望时刷新共享品类时钟（调用方已决定绕过冷却）。
   * 不写入自主动作冷却/最近动作，避免把用户行为算成自主选择。
   */
  noteLookAroundStarted(source = 'user-explicit'): void {
    this.lastLookAroundSource = source.slice(0, 80)
    this.noteLookAroundStartedAt(this.now())
  }

  /** 记录一次未播出的张望尝试；调用方已确定固定拒绝原因。 */
  noteLookAroundRejected(source: string, reason: string): void {
    this.lastLookAroundAttemptWallAt = this.wallNow()
    this.lastLookAroundRejectedSource = source.slice(0, 80)
    this.lastLookAroundRejectedReason = reason.slice(0, 120)
  }

  /** 墙钟截止；页面重载/设置热更新用，避免本地计时重新开始。 */
  lookAroundCooldownUntil(): number {
    return this.wallNow() + this.lookAroundRemaining(this.getConfig())
  }

  /** 最近一次真实张望 started 的墙钟；用于和页面内部通道（等待/菜单）去重。 */
  lookAroundStartedWallAt(): number | null {
    return this.lastLookAroundStartedWallAt
  }

  noteMovementStarted(): void {
    const now = this.now()
    this.lastMovementAt = now
    this.lastBodyActivityAt = now
    this.store?.set(PERSIST_KEY_MOVEMENT, this.wallNow())
  }

  /** 移动失败使用独立退避，不阻塞待机小动作，也不伪装成成功移动。 */
  noteMovementFailed(id: string): void {
    this.lastMovementFailureAt = this.now()
    this.pushRecent(id, 'failed')
    this.store?.set(PERSIST_KEY_MOVEMENT_FAILURE, this.wallNow())
  }

  evaluateAction(id: string): ActionEligibility {
    const config = this.getConfig()
    if (config.reducedMotion) return { ok: false, reason: 'reduced-motion' }
    if (!config.idleActions.enabled) return { ok: false, reason: 'idle-actions-disabled' }
    const now = this.now()
    const idleFor = now - this.lastActivityAt
    if (idleFor < config.idleActions.minIdleMs) {
      return {
        ok: false,
        reason: 'not-idle',
        retryAfterMs: config.idleActions.minIdleMs - idleFor
      }
    }
    const failure = this.remaining(this.lastFailureAt, FAILURE_BACKOFF_MS)
    if (failure > 0) return { ok: false, reason: 'failure-backoff', retryAfterMs: failure }
    const cooldown = this.remaining(this.lastActionAt, config.idleActions.minIntervalMs)
    if (cooldown > 0) return { ok: false, reason: 'cooldown', retryAfterMs: cooldown }
    if (isLookAroundAnimation(id)) {
      // 两种张望共用一个品类窗口；与同动作冷却取更严格者。
      const look = this.lookAroundRemaining(config)
      if (look > 0) return { ok: false, reason: 'look-around-cooldown', retryAfterMs: look }
    }
    const sameActionAt = this.actionTimes.get(id) ?? null
    const sameActionRemaining = this.remaining(
      sameActionAt,
      config.idleActions.sameActionIntervalMs
    )
    if (sameActionRemaining > 0) {
      return {
        ok: false,
        reason: 'same-action-cooldown',
        retryAfterMs: sameActionRemaining
      }
    }
    return { ok: true }
  }

  /**
   * 非自主入口（聊天回复里的动作、预设、实时反应）也要遵守张望品类冷却。
   * 用户明确要求「张望/环顾/左右看」时由调用方绕过，不调用此检查。
   */
  evaluateLookAround(): ActionEligibility {
    const remaining = this.lookAroundRemaining(this.getConfig())
    return remaining > 0
      ? { ok: false, reason: 'look-around-cooldown', retryAfterMs: remaining }
      : { ok: true }
  }

  evaluateMovement(): MovementEligibility {
    const eligibility = this.movementEligibility(this.getConfig())
    // 只供脱敏诊断的聚合数；不参与资格判断，也不改变节奏。
    this.movementEvaluationCount += 1
    if (eligibility.ok) {
      this.movementAllowedCount += 1
    } else if (eligibility.reason !== undefined) {
      this.movementRejections.set(
        eligibility.reason,
        (this.movementRejections.get(eligibility.reason) ?? 0) + 1
      )
    }
    return eligibility
  }

  private movementEligibility(config: PetIdlePolicyConfig): MovementEligibility {
    if (config.reducedMotion) return { ok: false, reason: 'reduced-motion' }
    // 自主走动与「待机偶发小动作」是两个独立开关：只需移动总开关和空闲门槛，
    // 关闭小动作不能连带关闭模型在空闲时选择的走动。
    if (!config.movementEnabled) return { ok: false, reason: 'movement-disabled' }
    const now = this.now()
    // 身体静止门槛独立于待机小动作；自主思考/展示不会推进这个时钟。
    const idleFor = now - this.lastBodyActivityAt
    if (idleFor < config.movementMinIdleMs) {
      return {
        ok: false,
        reason: 'not-idle',
        retryAfterMs: config.movementMinIdleMs - idleFor
      }
    }
    const failure = this.remaining(this.lastMovementFailureAt, FAILURE_BACKOFF_MS)
    if (failure > 0) return { ok: false, reason: 'failure-backoff', retryAfterMs: failure }
    const cooldown = this.remaining(
      this.lastMovementAt,
      config.movementAutonomousMinIntervalMs
    )
    if (cooldown > 0) return { ok: false, reason: 'cooldown', retryAfterMs: cooldown }
    return { ok: true }
  }

  summary(): IdlePolicySummary {
    const config = this.getConfig()
    const now = this.now()
    // 通用资格不绑定具体动作；同动作冷却单独在 summary 里报告。
    const action = this.evaluateAction('')
    // summary 只是展示当前资格，不能算作一次模型决策机会。
    const movement = this.movementEligibility(config)
    return {
      canIdleAction: action.ok,
      actionReason: action.reason ?? null,
      canAutonomousMove: movement.ok,
      movementReason: movement.reason ?? null,
      idleForSec: Math.max(0, Math.floor((now - this.lastActivityAt) / 1000)),
      idleRequiredSec: Math.round(config.idleActions.minIdleMs / 1000),
      bodyIdleForSec: Math.max(0, Math.floor((now - this.lastBodyActivityAt) / 1000)),
      movementIdleRequiredSec: Math.round(config.movementMinIdleMs / 1000),
      actionCooldownRemainingSec: Math.ceil(
        this.remaining(this.lastActionAt, config.idleActions.minIntervalMs) / 1000
      ),
      sameActionCooldownRemainingSec:
        this.lastActionId === null
          ? 0
          : Math.ceil(
              this.remaining(
                this.actionTimes.get(this.lastActionId) ?? this.lastActionAt,
                config.idleActions.sameActionIntervalMs
              ) / 1000
            ),
      lookAroundCooldownRemainingSec: Math.ceil(this.lookAroundRemaining(config) / 1000),
      movementCooldownRemainingSec: Math.ceil(
        this.remaining(
          this.lastMovementAt,
          config.movementAutonomousMinIntervalMs
        ) / 1000
      ),
      failureBackoffRemainingSec: Math.ceil(
        this.remaining(this.lastFailureAt, FAILURE_BACKOFF_MS) / 1000
      ),
      movementFailureBackoffRemainingSec: Math.ceil(
        this.remaining(this.lastMovementFailureAt, FAILURE_BACKOFF_MS) / 1000
      ),
      lastActionId: this.lastActionId,
      lastActionAgeSec:
        this.lastActionAt === null
          ? null
          : Math.max(0, Math.floor((now - this.lastActionAt) / 1000)),
      recentActions: this.recent
        .slice()
        .reverse()
        .map((item) => ({
          id: item.id,
          ageSec: Math.max(0, Math.floor((now - item.at) / 1000)),
          status: item.status
        }))
    }
  }

  /** 只用于诊断，不含任何用户内容。 */
  diagnostics(): Record<string, unknown> {
    return {
      ...this.summary(),
      actionCooldownActive: this.lastActionAt !== null,
      lastMovementAt: this.lastMovementAt,
      lastMovementFailureAt: this.lastMovementFailureAt,
      movementEvaluations: this.movementEvaluationCount,
      movementAllowedEvaluations: this.movementAllowedCount,
      movementRejections: Object.fromEntries(this.movementRejections),
      lookAround: {
        lastStartedAt: this.lastLookAroundStartedWallAt,
        lastSource: this.lastLookAroundSource,
        lastAttemptAt: this.lastLookAroundAttemptWallAt,
        lastRejectedSource: this.lastLookAroundRejectedSource,
        lastRejectedReason: this.lastLookAroundRejectedReason,
        cooldownUntil: this.lookAroundCooldownUntil()
      }
    }
  }

  private remaining(at: number | null, intervalMs: number): number {
    if (at === null || intervalMs <= 0) return 0
    return Math.max(0, intervalMs - (this.now() - at))
  }

  /** 张望品类冷却 = max(品类间隔, 同动作间隔)，两种张望共用。 */
  private lookAroundRemaining(config: PetIdlePolicyConfig): number {
    if (this.lastLookAroundAt === null) return 0
    return this.remaining(
      this.lastLookAroundAt,
      Math.max(
        LOOK_AROUND_CATEGORY_MIN_INTERVAL_MS,
        config.idleActions.lookAroundIntervalMs,
        config.idleActions.sameActionIntervalMs
      )
    )
  }

  private noteLookAroundStartedAt(at: number): void {
    this.lastLookAroundAt = at
    this.lastLookAroundStartedWallAt = this.wallNow()
    this.lastLookAroundAttemptWallAt = this.lastLookAroundStartedWallAt
    try {
      this.store?.set(PERSIST_KEY_LOOK_AROUND, this.lastLookAroundStartedWallAt)
    } catch {
      /* 与其它持久化一致：失败只影响重启后的品类冷却。 */
    }
  }

  private pushRecent(id: string, status: 'started' | 'failed'): void {
    this.recent.push({ id, at: this.now(), status })
    if (this.recent.length > RECENT_LIMIT) this.recent.shift()
  }

  private persistTimedId(key: string, value: TimedId): void {
    try {
      this.store?.set(key, value)
    } catch {
      /* 持久化失败只影响重启后的冷却，不阻塞表现。 */
    }
  }

  private persistActionTimes(): void {
    if (this.store === null) return
    const now = this.now()
    const wallNow = this.wallNow()
    const items = Array.from(this.actionTimes.entries())
      .filter(([, at]) => now - at <= MAX_AGE_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, ACTION_TIME_LIMIT)
      .map(([id, at]) => ({ id: id.slice(0, 120), at: wallNow - (now - at) }))
    try {
      this.store.set(PERSIST_KEY_ACTION_TIMES, items)
    } catch {
      /* 同 persistTimedId：持久化失败不能阻塞表现。 */
    }
  }

  private restore(): void {
    const action = this.readTimedId(PERSIST_KEY_ACTION)
    if (action !== null) {
      this.lastActionId = action.id
      this.lastActionAt = action.at
    }
    for (const item of this.readActionTimes()) {
      this.actionTimes.set(item.id, item.at)
      if (this.lastActionId === item.id) this.lastActionAt = item.at
    }
    this.lastMovementAt = this.readWallTime(PERSIST_KEY_MOVEMENT)
    this.lastFailureAt = this.readWallTime(PERSIST_KEY_FAILURE)
    this.lastMovementFailureAt = this.readWallTime(PERSIST_KEY_MOVEMENT_FAILURE)
    this.lastLookAroundAt = this.readWallTime(PERSIST_KEY_LOOK_AROUND)
  }

  private readActionTimes(): Array<{ id: string; at: number }> {
    const raw = this.store?.get(PERSIST_KEY_ACTION_TIMES)
    if (!Array.isArray(raw)) return []
    const out: Array<{ id: string; at: number }> = []
    for (const entry of raw.slice(0, ACTION_TIME_LIMIT)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      const id = typeof record['id'] === 'string' ? record['id'].slice(0, 120) : ''
      const wall = typeof record['at'] === 'number' ? record['at'] : Number.NaN
      if (id === '') continue
      const at = this.toMonotonic(wall)
      if (at === null) continue
      out.push({ id, at })
    }
    return out
  }

  private readTimedId(key: string): { id: string; at: number } | null {
    const raw = this.store?.get(key)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? record['id'].slice(0, 120) : ''
    const wall = typeof record['at'] === 'number' ? record['at'] : Number.NaN
    if (id === '') return null
    const at = this.toMonotonic(wall)
    return at === null ? null : { id, at }
  }

  private readWallTime(key: string): number | null {
    const raw = this.store?.get(key)
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
    return this.toMonotonic(raw)
  }

  /**
   * 墙钟 → 单调时钟。未来时间只容忍 5 分钟（休眠/时钟微调），超过则视为
   * 时钟异常并忽略；过旧时间已经超过所有冷却，也无需保留。
   */
  private toMonotonic(wall: number): number | null {
    const wallNow = this.wallNow()
    if (!Number.isFinite(wall) || wall > wallNow + FUTURE_TOLERANCE_MS) return null
    const age = wallNow - wall
    if (age > MAX_AGE_MS) return null
    return this.now() - Math.max(0, age)
  }
}
