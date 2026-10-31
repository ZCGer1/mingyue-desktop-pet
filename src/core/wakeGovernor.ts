import type { AppConfig } from '../shared/config'
import type {
  WakeDecision,
  WakeDecisionReason,
  WakeKind
} from '../shared/wake'
import type { StateStore } from './state'
import type { EventAttention, EventInput } from './types'
import { dateKey, inQuietHours, parseClockTime } from './util'

export type { WakeDecision, WakeDecisionReason, WakeKind }

interface WakeCounters {
  hourKey: string
  hourCount: number
  dayKey: string
  dayCount: number
  lastWakeAt: number
}

interface CompanionCounters {
  hourKey: string
  hourCount: number
  lastWakeAt: number
}

export interface WakeGovernorOptions {
  getConfig: () => AppConfig
  isBusy: () => boolean
  isPaused: () => boolean
  state?: StateStore | null
  clock?: { now(): number }
}

const AUTONOMY_STATE_KEY = 'autonomy.wake'
const COMPANION_STATE_KEY = 'companion.wake'
const REACTION_STATE_KEY = 'reaction.wake'
const SPEECH_QUIET_STATE_KEY = 'companion.speechQuietUntil'
const DEFAULT_COUNTERS: WakeCounters = {
  hourKey: '',
  hourCount: 0,
  dayKey: '',
  dayCount: 0,
  lastWakeAt: 0
}
const DEFAULT_COMPANION_COUNTERS: CompanionCounters = {
  hourKey: '',
  hourCount: 0,
  lastWakeAt: 0
}
const DEFAULT_REACTION_COUNTERS: WakeCounters = { ...DEFAULT_COUNTERS }

/**
 * 自主/陪伴唤醒的总闸门。它只决定「现在是否给模型一次醒来的机会」，
 * 不产生任何语义内容；模型仍然可以保持沉默。
 *
 * v12 起没有任何小时/每日/滚动窗口次数上限。计数只用于诊断统计；是否
 * 唤醒由内容、授权、忙碌、用户安静指令与去重/合并决定。说话安静
 * （speech quiet）只拦 companion，不压住探索或任务。
 * 只持久化计数与时间戳，不保存任何事件文本。
 */
export class WakeGovernor {
  private readonly getConfig: () => AppConfig
  private readonly isBusy: () => boolean
  private readonly isPaused: () => boolean
  private readonly state: StateStore | null
  private readonly now: () => number
  private lastUserAt = 0
  /** 用户临时要求安静：只影响 companion 主动聊天，探索与任务照常。 */
  private speechQuietUntil = 0

  constructor(opts: WakeGovernorOptions) {
    this.getConfig = opts.getConfig
    this.isBusy = opts.isBusy
    this.isPaused = opts.isPaused
    this.state = opts.state ?? null
    this.now = opts.clock?.now ?? (() => Date.now())
    this.speechQuietUntil = this.loadSpeechQuiet(opts.clock?.now() ?? Date.now())
  }

  noteUserMessage(now = this.now()): void {
    this.lastUserAt = now
  }

  /** pet_quiet：到 before 之前不发起新的主动聊天；null 或过去时间立即恢复。 */
  setSpeechQuietUntil(until: number | null, now = this.now()): void {
    this.speechQuietUntil =
      until === null || !Number.isFinite(until) || until <= now ? 0 : Math.floor(until)
    try {
      this.state?.set(
        SPEECH_QUIET_STATE_KEY,
        this.speechQuietUntil > 0 ? this.speechQuietUntil : null
      )
    } catch {
      /* 状态存储失败不应阻止安静立即生效 */
    }
  }

  get speechQuietUntilAt(): number {
    return this.speechQuietUntil > this.now() ? this.speechQuietUntil : 0
  }

  decisionFor(
    input: Pick<EventInput, 'type' | 'attention' | 'meta'>,
    now = this.now()
  ): WakeDecision {
    if (isReminder(input)) {
      return { mode: 'flush', reason: 'reminder', deferredAt: null }
    }
    // 预授权任务不受自主/陪伴预算与安静时段限制。
    if (input.type === 'task.kick') return this.assessTaskWake(now)
    const attention = input.attention ?? 'ambient'
    if (attention === 'ambient') {
      return { mode: 'piggyback', reason: 'ambient', deferredAt: null }
    }
    const kind = wakeKindFor(input.meta)
    if (kind === 'companion') {
      const { decision, counters } = this.assessCompanionWake(now)
      if (decision.mode === 'flush') this.consumeCompanion(counters, now)
      return decision
    }
    if (kind === 'reaction') {
      const { decision, counters } = this.assessReactionWake(now)
      if (decision.mode === 'flush') this.consumeReaction(counters, now)
      return decision
    }
    const { decision, counters } = this.assessWake(now)
    if (decision.mode === 'flush') this.consume(counters, now)
    return decision
  }

  /**
   * 到点/轮后提升自主事件：条件满足时记一次唤醒并返回 true。
   * 调用方据此只提升 attention === 'wake' 且 wakeKind 为 autonomy 的事件。
   */
  tryPromote(now = this.now()): boolean {
    const { decision, counters } = this.assessWake(now)
    if (decision.mode !== 'flush') return false
    this.consume(counters, now)
    return true
  }

  /** 陪伴聊天独立预算；与自主探索互不挤占。 */
  tryPromoteCompanion(now = this.now()): boolean {
    const { decision, counters } = this.assessCompanionWake(now)
    if (decision.mode !== 'flush') return false
    this.consumeCompanion(counters, now)
    return true
  }

  /** 事件反馈独立预算；与自主探索、定时闲聊互不挤占。 */
  tryPromoteReaction(now = this.now()): boolean {
    const { decision, counters } = this.assessReactionWake(now)
    if (decision.mode !== 'flush') return false
    this.consumeReaction(counters, now)
    return true
  }

  /**
   * 任务唤醒的提升路径：只看暂停/忙碌，不消耗自主或陪伴预算。
   * 队列里没有 task.kick 时调用方不应调用。
   */
  tryPromoteTask(now = this.now()): boolean {
    return this.assessTaskWake(now).mode === 'flush'
  }

  /**
   * 若现在还不能唤醒，返回下次应重新评估的时刻；已可唤醒返回 null。
   * 只读，不消耗预算。
   */
  nextDeferredAtFor(kind: WakeKind, now = this.now()): number | null {
    const decision =
      kind === 'companion'
        ? this.assessCompanionWake(now).decision
        : kind === 'reaction'
          ? this.assessReactionWake(now).decision
          : this.assessWake(now).decision
    return decision.mode === 'flush' ? null : decision.deferredAt
  }

  /** 兼容旧调用：自主唤醒的下次评估时刻。 */
  nextDeferredAt(now = this.now()): number | null {
    return this.nextDeferredAtFor('autonomy', now)
  }

  /**
   * 只读就绪原因：现在为什么不能醒来、最早何时恢复评估。
   * 不消耗预算，也不改变任何计时器。
   */
  deferralFor(
    kind: WakeKind,
    now = this.now()
  ): { at: number | null; reason: WakeDecisionReason | null } {
    const decision =
      kind === 'companion'
        ? this.assessCompanionWake(now).decision
        : kind === 'reaction'
          ? this.assessReactionWake(now).decision
          : this.assessWake(now).decision
    return decision.mode === 'flush'
      ? { at: null, reason: null }
      : { at: decision.deferredAt, reason: decision.reason }
  }

  diagnostics(now = this.now()): Record<string, unknown> {
    const counters = this.refreshBudget(now)
    const companion = this.refreshCompanionBudget(now)
    const reaction = this.refreshReactionBudget(now)
    const config = this.getConfig()
    return {
      lastUserAt: this.lastUserAt > 0 ? this.lastUserAt : null,
      unlimited: true,
      lastWakeAt: counters.lastWakeAt > 0 ? counters.lastWakeAt : null,
      // 以下全部只是用量统计，不参与任何放行/拦截判断。
      wakesThisHour: counters.hourCount,
      wakesToday: counters.dayCount,
      wakeGapMs: config.autonomy.wakeGapMs,
      companion: {
        lastWakeAt: companion.lastWakeAt > 0 ? companion.lastWakeAt : null,
        wakesThisHour: companion.hourCount,
        unlimited: true,
        speechQuietUntil: this.speechQuietUntilAt
      },
      reaction: {
        enabled: config.companion.reaction.enabled,
        lastWakeAt: reaction.lastWakeAt > 0 ? reaction.lastWakeAt : null,
        wakesThisHour: reaction.hourCount,
        wakesToday: reaction.dayCount,
        unlimited: true
      },
      speechQuietUntil: this.speechQuietUntilAt
    }
  }

  clear(): void {
    this.lastUserAt = 0
    this.speechQuietUntil = 0
    try {
      this.state?.set(AUTONOMY_STATE_KEY, { ...DEFAULT_COUNTERS })
      this.state?.set(COMPANION_STATE_KEY, { ...DEFAULT_COMPANION_COUNTERS })
      this.state?.set(REACTION_STATE_KEY, { ...DEFAULT_REACTION_COUNTERS })
      this.state?.set(SPEECH_QUIET_STATE_KEY, null)
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------

  private assessTaskWake(now: number): WakeDecision {
    if (this.isPaused()) return { mode: 'piggyback', reason: 'paused', deferredAt: null }
    if (this.isBusy()) return { mode: 'piggyback', reason: 'busy', deferredAt: null }
    return { mode: 'flush', reason: 'eligible', deferredAt: null }
  }

  private assessWake(now: number): { decision: WakeDecision; counters: WakeCounters } {
    const config = this.getConfig().autonomy
    const counters = this.refreshBudget(now)
    const deferred = (reason: WakeDecisionReason, at: number | null): { decision: WakeDecision; counters: WakeCounters } => ({
      decision: { mode: 'piggyback', reason, deferredAt: at },
      counters
    })

    if (!config.enabled) return deferred('disabled', null)
    if (this.isPaused()) return deferred('paused', null)
    if (this.isBusy()) return deferred('busy', null)
    if (counters.lastWakeAt > 0 && now - counters.lastWakeAt < config.wakeGapMs) {
      return deferred('gap', counters.lastWakeAt + config.wakeGapMs)
    }
    if (this.lastUserAt > 0 && now - this.lastUserAt < config.postUserCooldownMs) {
      return deferred('user-cooldown', this.lastUserAt + config.postUserCooldownMs)
    }
    return {
      decision: { mode: 'flush', reason: 'eligible', deferredAt: null },
      counters
    }
  }

  private assessCompanionWake(
    now: number
  ): { decision: WakeDecision; counters: CompanionCounters } {
    const config = this.getConfig()
    const counters = this.refreshCompanionBudget(now)
    const deferred = (
      reason: WakeDecisionReason,
      at: number | null
    ): { decision: WakeDecision; counters: CompanionCounters } => ({
      decision: { mode: 'piggyback', reason, deferredAt: at },
      counters
    })

    if (!config.autonomy.enabled) return deferred('disabled', null)
    if (this.isPaused()) return deferred('paused', null)
    if (this.isBusy()) return deferred('busy', null)
    if (now < this.speechQuietUntil) return deferred('speech-quiet', this.speechQuietUntil)
    if (config.autonomy.respectQuietHours && this.inQuiet(now)) {
      return deferred('quiet', quietEnd(now, config.worlds.activity.quietHours))
    }
    if (counters.lastWakeAt > 0 && now - counters.lastWakeAt < config.autonomy.wakeGapMs) {
      return deferred('gap', counters.lastWakeAt + config.autonomy.wakeGapMs)
    }
    if (
      this.lastUserAt > 0 &&
      now - this.lastUserAt < config.autonomy.postUserCooldownMs
    ) {
      return deferred('user-cooldown', this.lastUserAt + config.autonomy.postUserCooldownMs)
    }
    return {
      decision: { mode: 'flush', reason: 'eligible', deferredAt: null },
      counters
    }
  }

  /**
   * 真实变化触发的反馈：不占用自主探索或定时闲聊预算，也不受「用户刚
   * 说过话」冷却限制——用户自己的操作正需要及时反馈。忙碌、说话安静、
   * 夜间安静与独立预算仍然生效。
   */
  private assessReactionWake(
    now: number
  ): { decision: WakeDecision; counters: WakeCounters } {
    const config = this.getConfig()
    const counters = this.refreshReactionBudget(now)
    const deferred = (
      reason: WakeDecisionReason,
      at: number | null
    ): { decision: WakeDecision; counters: WakeCounters } => ({
      decision: { mode: 'piggyback', reason, deferredAt: at },
      counters
    })

    if (!config.autonomy.enabled || !config.companion.reaction.enabled) {
      return deferred('disabled', null)
    }
    if (this.isPaused()) return deferred('paused', null)
    if (this.isBusy()) return deferred('busy', null)
    if (now < this.speechQuietUntil) return deferred('speech-quiet', this.speechQuietUntil)
    if (config.autonomy.respectQuietHours && this.inQuiet(now)) {
      return deferred('quiet', quietEnd(now, config.worlds.activity.quietHours))
    }
    // 不再有固定 minGap/小时额度。重复事件由 ReactionChannel 的证据去重与
    // WakeBus 的短合并处理；新的有效变化可以立即进入模型决策。
    return {
      decision: { mode: 'flush', reason: 'eligible', deferredAt: null },
      counters
    }
  }

  private consume(counters: WakeCounters, now: number): void {
    counters.lastWakeAt = now
    counters.hourCount += 1
    counters.dayCount += 1
    this.persist(counters)
  }

  private consumeCompanion(counters: CompanionCounters, now: number): void {
    counters.lastWakeAt = now
    counters.hourCount += 1
    this.persistCompanion(counters)
  }

  private consumeReaction(counters: WakeCounters, now: number): void {
    counters.lastWakeAt = now
    counters.hourCount += 1
    counters.dayCount += 1
    this.persistReaction(counters)
  }

  private inQuiet(now: number): boolean {
    return inQuietHours(now, this.getConfig().worlds.activity.quietHours)
  }

  private refreshBudget(now: number): WakeCounters {
    const hourKey = `${dateKey(now)}-${new Date(now).getHours()}`
    const dayKey = dateKey(now)
    const counters = this.load()
    if (counters.hourKey !== hourKey) {
      counters.hourKey = hourKey
      counters.hourCount = 0
    }
    if (counters.dayKey !== dayKey) {
      counters.dayKey = dayKey
      counters.dayCount = 0
    }
    return counters
  }

  private refreshCompanionBudget(now: number): CompanionCounters {
    const hourKey = `${dateKey(now)}-${new Date(now).getHours()}`
    const counters = this.loadCompanion()
    if (counters.hourKey !== hourKey) {
      counters.hourKey = hourKey
      counters.hourCount = 0
    }
    return counters
  }

  private refreshReactionBudget(now: number): WakeCounters {
    const hourKey = `${dateKey(now)}-${new Date(now).getHours()}`
    const dayKey = dateKey(now)
    const counters = this.loadReaction()
    if (counters.hourKey !== hourKey) {
      counters.hourKey = hourKey
      counters.hourCount = 0
    }
    if (counters.dayKey !== dayKey) {
      counters.dayKey = dayKey
      counters.dayCount = 0
    }
    return counters
  }

  private load(): WakeCounters {
    let raw: unknown
    try {
      raw = this.state?.get(AUTONOMY_STATE_KEY)
    } catch {
      raw = undefined
    }
    if (raw === null || typeof raw !== 'object') return { ...DEFAULT_COUNTERS }
    const record = raw as Partial<WakeCounters>
    return {
      hourKey: typeof record.hourKey === 'string' ? record.hourKey : '',
      hourCount: numberOrZero(record.hourCount),
      dayKey: typeof record.dayKey === 'string' ? record.dayKey : '',
      dayCount: numberOrZero(record.dayCount),
      lastWakeAt: numberOrZero(record.lastWakeAt)
    }
  }

  private loadCompanion(): CompanionCounters {
    let raw: unknown
    try {
      raw = this.state?.get(COMPANION_STATE_KEY)
    } catch {
      raw = undefined
    }
    if (raw === null || typeof raw !== 'object') return { ...DEFAULT_COMPANION_COUNTERS }
    const record = raw as Partial<CompanionCounters>
    return {
      hourKey: typeof record.hourKey === 'string' ? record.hourKey : '',
      hourCount: numberOrZero(record.hourCount),
      lastWakeAt: numberOrZero(record.lastWakeAt)
    }
  }

  private loadReaction(): WakeCounters {
    let raw: unknown
    try {
      raw = this.state?.get(REACTION_STATE_KEY)
    } catch {
      raw = undefined
    }
    if (raw === null || typeof raw !== 'object') return { ...DEFAULT_REACTION_COUNTERS }
    const record = raw as Partial<WakeCounters>
    return {
      hourKey: typeof record.hourKey === 'string' ? record.hourKey : '',
      hourCount: numberOrZero(record.hourCount),
      dayKey: typeof record.dayKey === 'string' ? record.dayKey : '',
      dayCount: numberOrZero(record.dayCount),
      lastWakeAt: numberOrZero(record.lastWakeAt)
    }
  }

  private loadSpeechQuiet(now: number): number {
    let raw: unknown
    try {
      raw = this.state?.get(SPEECH_QUIET_STATE_KEY)
    } catch {
      return 0
    }
    return typeof raw === 'number' && Number.isFinite(raw) && raw > now ? Math.floor(raw) : 0
  }

  private persist(counters: WakeCounters): void {
    try {
      this.state?.set(AUTONOMY_STATE_KEY, { ...counters })
    } catch {
      /* 状态存储失败不应阻止本轮唤醒 */
    }
  }

  private persistCompanion(counters: CompanionCounters): void {
    try {
      this.state?.set(COMPANION_STATE_KEY, { ...counters })
    } catch {
      /* 状态存储失败不应阻止本轮唤醒 */
    }
  }

  private persistReaction(counters: WakeCounters): void {
    try {
      this.state?.set(REACTION_STATE_KEY, { ...counters })
    } catch {
      /* 状态存储失败不应阻止本轮唤醒 */
    }
  }
}

function wakeKindFor(meta: Record<string, unknown> | undefined): WakeKind {
  const kind = meta?.['wakeKind']
  if (kind === 'companion') return 'companion'
  if (kind === 'reaction') return 'reaction'
  return 'autonomy'
}

function isReminder(input: Pick<EventInput, 'type' | 'meta'>): boolean {
  return input.type === 'timer.due' && input.meta?.kind === 'reminder'
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 当前安静时段的结束时刻；不在安静时段时返回 null。 */
export function quietEnd(now: number, quietHours: [string, string]): number | null {
  if (!inQuietHours(now, quietHours)) return null
  const start = parseClockTime(quietHours[0])
  const end = parseClockTime(quietHours[1])
  if (start === null || end === null || start === end) return null
  const date = new Date(now)
  const candidate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Math.floor(end / 60),
    end % 60,
    0,
    0
  )
  if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

export type { EventAttention }
