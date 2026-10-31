import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { ToolSource } from './capabilityTypes'
import { isTerminalTaskState, type TaskSource, type TaskState } from './taskTypes'
import type { Logger } from './types'

/**
 * 陪伴/探索的本地运行指标（P4）。
 *
 * 只记录计数、枚举、时间与数值采样：没有气泡正文、兴趣摘要、任务标题、
 * 窗口标题、路径或工具参数。文件按本地日期轮转，并有单文件上限；这里位于
 * `src/core`，不能 import Electron，CPU/内存采样由主进程注入。
 */

export type MetricsWakeKind = 'autonomy' | 'companion' | 'reaction' | 'screen'

export type ExploreMetricKind =
  | 'observation'
  | 'action'
  | 'artifact'
  | 'planning'
  | 'rest'
  | 'no_progress'

export type ReactionMetricAction =
  | 'candidate'
  | 'coalesced'
  | 'expired'
  | 'silent'
  | 'spoken'
  | 'local-action'
  | 'model-action'
  | 'model-declined'
  | 'provider-failed'
  | 'render-rejected'
  | 'deduped'
  | 'busy-deferred'
  | 'user-quiet'
  | 'continued'
  | 'own-action-suppressed'
  | 'cancelled'
  | 'model-decision-required'

export interface CompanionMetricsSummary {
  day: string
  considerations: {
    total: number
    autonomy: number
    companion: number
    reaction: number
    screen: number
  }
  spoke: {
    total: number
    autonomy: number
    companion: number
    reaction: number
    screen: number
  }
  reasons: Record<string, number>
  exploration: {
    observation: number
    action: number
    artifact: number
    planning: number
    rest: number
    noProgress: number
  }
  reactions: {
    candidates: number
    coalesced: number
    localActions: number
    modelActions: number
    continued: number
    spoken: number
    silent: number
    expired: number
    /** 模型主动选择不回应（不是请求失败）。 */
    modelDeclined: number
    /** 模型请求/网络/鉴权失败；本地反应与动作不受影响。 */
    providerFailed: number
    /** 真正被展示层拒绝：播放失败、已有未回应开场等；不是频率配额。 */
    renderRejected: number
    deduped: number
    busyDeferred: number
    userQuiet: number
    ownActionSuppressed: number
    /** 用户已切换情境，仍在队列里的旧反应事件被丢弃。 */
    cancelled: number
    /** 事件进入反应层到本地可见动作的时延。 */
    latencySamples: number
    latencyP50Ms: number | null
    latencyP95Ms: number | null
    /** 从 OS 观察到事件到本地动作；采样/去抖延迟单独记录。 */
    eventAgeSamples: number
    eventAgeP50Ms: number | null
    eventAgeP95Ms: number | null
    /** 从 OS 观察到模型真正开口/动作的时延；报告用。 */
    modelLatencySamples: number
    modelLatencyP50Ms: number | null
    modelLatencyP95Ms: number | null
  }
  episodes: { answered: number; unanswered: number }
  tasks: {
    started: number
    completed: number
    failed: number
    cancelled: number
    autonomyStarted: number
    autonomyCompleted: number
  }
  tools: {
    calls: number
    reads: number
    observes: number
    noteWrites: number
    duplicateReads: number
  }
  actions: { cua: number; vision: number }
  cost: {
    modelCalls: number
    promptTokens: number
    completionTokens: number
    cacheHitTokens: number
    estimatedCny: number
  }
  process: {
    samples: number
    cpuPercent: number | null
    memoryMB: number | null
    maxMemoryMB: number | null
    sampledAt: number | null
  }
  /** 最近 20 次自主/陪伴考虑；只有枚举原因与时间。 */
  recent: Array<{ at: number; kind: MetricsWakeKind; reason: string }>
  file: { truncated: boolean }
}

export interface ProcessSample {
  cpuPercent: number
  memoryMB: number
}

export interface CompanionMetricsOptions {
  /** `logs/companion-metrics.jsonl`；null 时只保留内存计数。 */
  file: string | null
  now?: () => number
  logger?: Logger
  /** 主进程注入的进程采样；不传时不采样 CPU/内存。 */
  processSampler?: () => ProcessSample | null
  maxFileBytes?: number
}

interface Counters {
  considerations: Record<MetricsWakeKind, number>
  spoke: Record<MetricsWakeKind, number>
  reasons: Record<string, number>
  exploreObservation: number
  exploreAction: number
  exploreArtifact: number
  explorePlanning: number
  exploreRest: number
  exploreNoProgress: number
  reactionCandidates: number
  reactionCoalesced: number
  reactionLocalActions: number
  reactionModelActions: number
  reactionContinued: number
  reactionSpoken: number
  reactionSilent: number
  reactionExpired: number
  reactionModelDeclined: number
  reactionProviderFailed: number
  reactionRenderRejected: number
  reactionDeduped: number
  reactionBusyDeferred: number
  reactionUserQuiet: number
  reactionOwnActionSuppressed: number
  reactionCancelled: number
  reactionLatencies: number[]
  reactionEventAges: number[]
  reactionModelLatencies: number[]
  episodesAnswered: number
  episodesUnanswered: number
  tasksStarted: number
  tasksCompleted: number
  tasksFailed: number
  tasksCancelled: number
  autonomyTasksStarted: number
  autonomyTasksCompleted: number
  toolCalls: number
  reads: number
  observes: number
  noteWrites: number
  duplicateReads: number
  cuaActions: number
  visionActions: number
  modelCalls: number
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  estimatedCny: number
  processSamples: number
  lastCpuPercent: number | null
  lastMemoryMB: number | null
  maxMemoryMB: number | null
  lastProcessAt: number | null
}

type MetricsEvent =
  | { t: 'wake'; at: number; kind: MetricsWakeKind; reason: string }
  | { t: 'spoke'; at: number; kind: MetricsWakeKind | null }
  | { t: 'explore'; at: number; kind: ExploreMetricKind }
  | { t: 'reaction'; at: number; action: ReactionMetricAction; reason?: string }
  | { t: 'reaction-latency'; at: number; ms: number }
  | { t: 'reaction-event-age'; at: number; ms: number }
  | { t: 'reaction-model-latency'; at: number; ms: number }
  | { t: 'episode'; at: number; action: 'answered' | 'unanswered' }
  | {
      t: 'task'
      at: number
      action: 'start' | 'complete' | 'fail' | 'cancel'
      autonomy: boolean
    }
  | {
      t: 'tool'
      at: number
      tool: string
      ok: boolean
      source: ToolSource
      dup: boolean
    }
  | {
      t: 'cost'
      at: number
      calls: number
      promptTokens: number
      completionTokens: number
      cacheHitTokens: number
      cny: number
    }
  | { t: 'process'; at: number; cpu: number; mem: number }

const DEFAULT_MAX_FILE_BYTES = 512 * 1024
const MAX_RECENT = 20
const READ_TOOLS = new Set([
  'ws_read',
  'ws_search',
  'page_current',
  'web_fetch',
  'win_read',
  'computer_observe'
])
const OBSERVE_TOOLS = new Set([
  'win_list',
  'win_read',
  'win_capture',
  'page_current',
  'computer_observe'
])
const NOTE_WRITE_TOOLS = new Set(['ws_write', 'ws_replace', 'ws_move'])
const VISION_TOOLS = new Set(['win_capture', 'cua_screenshot', 'cua_zoom', 'screen_observe'])
// 原因标签是固定的短枚举。允许下划线是为了保留 content_change 这类
// 变化类型；仍拒绝大写、空格、斜杠和任意文本，避免把正文写进日志。
const REASON_PATTERN = /^[a-z][a-z_-]{0,39}$/
const TOOL_PATTERN = /^[a-z][a-z0-9_]{0,39}$/

export interface ToolMetricInput {
  name: string
  source: ToolSource
  failed: boolean
  /** 本次读取的内容指纹在 24 小时内是否已经看过。 */
  duplicate?: boolean
}

export interface UsageDeltaInput {
  calls: number
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  estimatedCny: number
}

export class CompanionMetrics {
  private readonly file: string | null
  private readonly now: () => number
  private readonly logger: Logger | undefined
  private readonly processSampler: (() => ProcessSample | null) | undefined
  private readonly maxFileBytes: number
  private day: string
  private counters: Counters = emptyCounters()
  private recent: Array<{ at: number; kind: MetricsWakeKind; reason: string }> = []
  private fileBytes = 0
  private truncated = false
  private readonly taskStates = new Map<string, { state: TaskState; source: TaskSource }>()
  private lastUsage: UsageDeltaInput = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    estimatedCny: 0
  }

  constructor(options: CompanionMetricsOptions) {
    this.file = options.file
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
    this.processSampler = options.processSampler
    this.maxFileBytes = Math.max(16 * 1024, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
    this.day = dayKey(this.now())
    if (this.file !== null) {
      try {
        mkdirSync(dirname(this.file), { recursive: true })
        this.rotateStale()
        this.hydrate()
        this.pruneArchives()
      } catch (error) {
        this.logger?.warn('陪伴指标文件初始化失败', { error: String(error).slice(0, 200) })
      }
    }
  }

  noteConsideration(kind: MetricsWakeKind, reason: string): void {
    this.rollIfNeeded()
    const safeReason = REASON_PATTERN.test(reason) ? reason : 'unknown'
    this.counters.considerations[kind] += 1
    this.counters.reasons[safeReason] = (this.counters.reasons[safeReason] ?? 0) + 1
    this.recent.push({ at: this.now(), kind, reason: safeReason })
    if (this.recent.length > MAX_RECENT) this.recent.shift()
    this.writeEvent({ t: 'wake', at: this.now(), kind, reason: safeReason })
  }

  /** 她真的开口；kind 未知时只计入总数，不猜测来源。 */
  noteSpoke(kind: MetricsWakeKind | null = null): void {
    this.rollIfNeeded()
    if (kind !== null) this.counters.spoke[kind] += 1
    this.writeEvent({ t: 'spoke', at: this.now(), kind })
  }

  /** 自主探索这一轮的真实结果；只有实际回执分类后调用。 */
  noteExploreResult(kind: ExploreMetricKind): void {
    this.rollIfNeeded()
    switch (kind) {
      case 'observation':
        this.counters.exploreObservation += 1
        break
      case 'action':
        this.counters.exploreAction += 1
        break
      case 'artifact':
        this.counters.exploreArtifact += 1
        break
      case 'planning':
        this.counters.explorePlanning += 1
        break
      case 'rest':
        this.counters.exploreRest += 1
        break
      case 'no_progress':
        this.counters.exploreNoProgress += 1
        break
    }
    this.writeEvent({ t: 'explore', at: this.now(), kind })
  }

  /**
   * 事件反馈通道的漏斗：候选、合并、本地动作、发言、沉默、过期与预算阻塞。
   * reason 只允许枚举式短串，不记录事件正文。
   */
  noteReaction(action: ReactionMetricAction, reason?: string): void {
    this.rollIfNeeded()
    switch (action) {
      case 'candidate':
        this.counters.reactionCandidates += 1
        break
      case 'coalesced':
        this.counters.reactionCoalesced += 1
        break
      case 'local-action':
        this.counters.reactionLocalActions += 1
        break
      case 'model-action':
        this.counters.reactionModelActions += 1
        break
      case 'continued':
        this.counters.reactionContinued += 1
        break
      case 'spoken':
        this.counters.reactionSpoken += 1
        break
      case 'silent':
        this.counters.reactionSilent += 1
        break
      case 'expired':
        this.counters.reactionExpired += 1
        break
      case 'model-declined':
        this.counters.reactionModelDeclined += 1
        break
      case 'provider-failed':
        this.counters.reactionProviderFailed += 1
        break
      case 'render-rejected':
        this.counters.reactionRenderRejected += 1
        break
      case 'deduped':
        this.counters.reactionDeduped += 1
        break
      case 'busy-deferred':
        this.counters.reactionBusyDeferred += 1
        break
      case 'user-quiet':
        this.counters.reactionUserQuiet += 1
        break
      case 'own-action-suppressed':
        this.counters.reactionOwnActionSuppressed += 1
        break
      case 'cancelled':
        this.counters.reactionCancelled += 1
        break
      case 'model-decision-required':
        // 事件仍在队列里等待模型决定，不计入任何本地动作指标。
        break
    }
    const safeReason =
      reason !== undefined && REASON_PATTERN.test(reason) ? reason : undefined
    this.writeEvent({
      t: 'reaction',
      at: this.now(),
      action,
      ...(safeReason === undefined ? {} : { reason: safeReason })
    })
  }

  /** 从真实事件稳定到模型给出有意义反馈（动作/发言）的时延，毫秒。 */
  noteReactionLatency(ms: number): void {
    this.rollIfNeeded()
    if (!Number.isFinite(ms) || ms < 0) return
    const value = Math.min(10 * 60_000, Math.round(ms))
    this.counters.reactionLatencies.push(value)
    if (this.counters.reactionLatencies.length > 200) this.counters.reactionLatencies.shift()
    this.writeEvent({ t: 'reaction-latency', at: this.now(), ms: value })
  }

  /** OS 观察到事件 → 本地动作的年龄；用于把采样与去抖延迟单独统计。 */
  noteReactionEventAge(ms: number): void {
    this.rollIfNeeded()
    if (!Number.isFinite(ms) || ms < 0) return
    const value = Math.min(10 * 60_000, Math.round(ms))
    this.counters.reactionEventAges.push(value)
    if (this.counters.reactionEventAges.length > 200) this.counters.reactionEventAges.shift()
    this.writeEvent({ t: 'reaction-event-age', at: this.now(), ms: value })
  }

  /** 首次可运行反应事件 → 模型真正发言/动作的时延，毫秒。 */
  noteReactionModelLatency(ms: number): void {
    this.rollIfNeeded()
    if (!Number.isFinite(ms) || ms < 0) return
    const value = Math.min(30 * 60_000, Math.round(ms))
    this.counters.reactionModelLatencies.push(value)
    if (this.counters.reactionModelLatencies.length > 200) {
      this.counters.reactionModelLatencies.shift()
    }
    this.writeEvent({ t: 'reaction-model-latency', at: this.now(), ms: value })
  }

  noteEpisode(action: 'answered' | 'unanswered'): void {
    this.rollIfNeeded()
    if (action === 'answered') this.counters.episodesAnswered += 1
    else this.counters.episodesUnanswered += 1
    this.writeEvent({ t: 'episode', at: this.now(), action })
  }

  /** 启动时把已有任务当作已知状态，避免把恢复出来的旧任务误记为今天新建。 */
  seedTasks(tasks: Array<{ id: string; state: TaskState; source: TaskSource }>): void {
    for (const task of tasks) this.taskStates.set(task.id, { state: task.state, source: task.source })
  }

  noteTaskState(id: string, state: TaskState, source: TaskSource): void {
    this.rollIfNeeded()
    const previous = this.taskStates.get(id)
    const autonomy = source === 'autonomy'
    const terminal = isTerminalTaskState(state)
    if (previous === undefined) {
      if (!terminal) {
        this.recordTaskEvent('start', autonomy)
      } else {
        this.recordTaskTerminal(state, autonomy)
      }
    } else if (!isTerminalTaskState(previous.state) && terminal) {
      this.recordTaskTerminal(state, autonomy)
    }
    this.taskStates.set(id, { state, source })
  }

  noteTool(input: ToolMetricInput): void {
    this.rollIfNeeded()
    const own = input.source === 'autonomy' || input.source === 'task'
    const name = TOOL_PATTERN.test(input.name) ? input.name : 'unknown'
    const duplicate = input.duplicate === true
    if (own && !input.failed) {
      this.counters.toolCalls += 1
      if (READ_TOOLS.has(name)) this.counters.reads += 1
      if (OBSERVE_TOOLS.has(name)) this.counters.observes += 1
      if (duplicate) this.counters.duplicateReads += 1
      if (NOTE_WRITE_TOOLS.has(name)) this.counters.noteWrites += 1
    }
    if (name.startsWith('cua_') || name === 'screen_observe') this.counters.cuaActions += 1
    if (VISION_TOOLS.has(name)) this.counters.visionActions += 1
    // 用户聊天里的普通工具不进入指标文件；只留探索/CUA/视觉相关调用。
    if (own || name.startsWith('cua_') || VISION_TOOLS.has(name)) {
      this.writeEvent({
        t: 'tool',
        at: this.now(),
        tool: name,
        ok: !input.failed,
        source: input.source,
        dup: duplicate
      })
    }
  }

  noteProcessSample(): void {
    this.rollIfNeeded()
    if (this.processSampler === undefined) return
    let sample: ProcessSample | null = null
    try {
      sample = this.processSampler()
    } catch {
      sample = null
    }
    if (sample === null) return
    const cpu = finiteOr(sample.cpuPercent, 0)
    const mem = Math.max(0, finiteOr(sample.memoryMB, 0))
    this.counters.processSamples += 1
    this.counters.lastCpuPercent = cpu
    this.counters.lastMemoryMB = mem
    this.counters.maxMemoryMB = Math.max(this.counters.maxMemoryMB ?? 0, mem)
    this.counters.lastProcessAt = this.now()
    this.writeEvent({ t: 'process', at: this.now(), cpu, mem })
  }

  /** 按 UsageTracker 的累计值取增量；同一进程内多次调用不会重复计费。 */
  sampleUsage(total: UsageDeltaInput): void {
    this.rollIfNeeded()
    const calls = Math.max(0, total.calls - this.lastUsage.calls)
    const promptTokens = Math.max(0, total.promptTokens - this.lastUsage.promptTokens)
    const completionTokens = Math.max(
      0,
      total.completionTokens - this.lastUsage.completionTokens
    )
    const cacheHitTokens = Math.max(
      0,
      total.cacheHitTokens - this.lastUsage.cacheHitTokens
    )
    const cny = Math.max(0, total.estimatedCny - this.lastUsage.estimatedCny)
    this.lastUsage = { ...total }
    if (
      calls === 0 &&
      promptTokens === 0 &&
      completionTokens === 0 &&
      cacheHitTokens === 0 &&
      cny === 0
    ) {
      return
    }
    this.counters.modelCalls += calls
    this.counters.promptTokens += promptTokens
    this.counters.completionTokens += completionTokens
    this.counters.cacheHitTokens += cacheHitTokens
    this.counters.estimatedCny += cny
    this.writeEvent({
      t: 'cost',
      at: this.now(),
      calls,
      promptTokens,
      completionTokens,
      cacheHitTokens,
      cny
    })
  }

  summary(): CompanionMetricsSummary {
    this.rollIfNeeded()
    const counters = this.counters
    return {
      day: this.day,
      considerations: {
        total:
          counters.considerations.autonomy +
          counters.considerations.companion +
          counters.considerations.reaction +
          counters.considerations.screen,
        autonomy: counters.considerations.autonomy,
        companion: counters.considerations.companion,
        reaction: counters.considerations.reaction,
        screen: counters.considerations.screen
      },
      spoke: {
        total:
          counters.spoke.autonomy +
          counters.spoke.companion +
          counters.spoke.reaction +
          counters.spoke.screen,
        autonomy: counters.spoke.autonomy,
        companion: counters.spoke.companion,
        reaction: counters.spoke.reaction,
        screen: counters.spoke.screen
      },
      reasons: { ...counters.reasons },
      exploration: {
        observation: counters.exploreObservation,
        action: counters.exploreAction,
        artifact: counters.exploreArtifact,
        planning: counters.explorePlanning,
        rest: counters.exploreRest,
        noProgress: counters.exploreNoProgress
      },
      reactions: {
        candidates: counters.reactionCandidates,
        coalesced: counters.reactionCoalesced,
        localActions: counters.reactionLocalActions,
        modelActions: counters.reactionModelActions,
        continued: counters.reactionContinued,
        spoken: counters.reactionSpoken,
        silent: counters.reactionSilent,
        expired: counters.reactionExpired,
        modelDeclined: counters.reactionModelDeclined,
        providerFailed: counters.reactionProviderFailed,
        renderRejected: counters.reactionRenderRejected,
        deduped: counters.reactionDeduped,
        busyDeferred: counters.reactionBusyDeferred,
        userQuiet: counters.reactionUserQuiet,
        ownActionSuppressed: counters.reactionOwnActionSuppressed,
        cancelled: counters.reactionCancelled,
        latencySamples: counters.reactionLatencies.length,
        latencyP50Ms: percentile(counters.reactionLatencies, 50),
        latencyP95Ms: percentile(counters.reactionLatencies, 95),
        eventAgeSamples: counters.reactionEventAges.length,
        eventAgeP50Ms: percentile(counters.reactionEventAges, 50),
        eventAgeP95Ms: percentile(counters.reactionEventAges, 95),
        modelLatencySamples: counters.reactionModelLatencies.length,
        modelLatencyP50Ms: percentile(counters.reactionModelLatencies, 50),
        modelLatencyP95Ms: percentile(counters.reactionModelLatencies, 95)
      },
      episodes: {
        answered: counters.episodesAnswered,
        unanswered: counters.episodesUnanswered
      },
      tasks: {
        started: counters.tasksStarted,
        completed: counters.tasksCompleted,
        failed: counters.tasksFailed,
        cancelled: counters.tasksCancelled,
        autonomyStarted: counters.autonomyTasksStarted,
        autonomyCompleted: counters.autonomyTasksCompleted
      },
      tools: {
        calls: counters.toolCalls,
        reads: counters.reads,
        observes: counters.observes,
        noteWrites: counters.noteWrites,
        duplicateReads: counters.duplicateReads
      },
      actions: { cua: counters.cuaActions, vision: counters.visionActions },
      cost: {
        modelCalls: counters.modelCalls,
        promptTokens: counters.promptTokens,
        completionTokens: counters.completionTokens,
        cacheHitTokens: counters.cacheHitTokens,
        estimatedCny: round(counters.estimatedCny, 6)
      },
      process: {
        samples: counters.processSamples,
        cpuPercent: counters.lastCpuPercent,
        memoryMB: counters.lastMemoryMB,
        maxMemoryMB: counters.maxMemoryMB,
        sampledAt: counters.lastProcessAt
      },
      recent: this.recent.map((entry) => ({ ...entry })),
      file: { truncated: this.truncated }
    }
  }

  /** 用户清空本地数据时一并清空；旧指标文件保留与否由调用方决定。 */
  reset(): void {
    this.counters = emptyCounters()
    this.recent = []
    this.truncated = false
    this.fileBytes = 0
    this.lastUsage = {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheHitTokens: 0,
      estimatedCny: 0
    }
    if (this.file !== null) {
      try {
        writeFileSync(this.file, '', 'utf8')
      } catch {
        /* 清空失败不影响运行 */
      }
    }
  }

  // ------------------------------------------------------------------

  private recordTaskEvent(action: 'start', autonomy: boolean): void {
    this.counters.tasksStarted += 1
    if (autonomy) this.counters.autonomyTasksStarted += 1
    this.writeEvent({ t: 'task', at: this.now(), action, autonomy })
  }

  private recordTaskTerminal(state: TaskState, autonomy: boolean): void {
    if (state === 'completed') {
      this.counters.tasksCompleted += 1
      if (autonomy) this.counters.autonomyTasksCompleted += 1
      this.writeEvent({ t: 'task', at: this.now(), action: 'complete', autonomy })
    } else if (state === 'failed') {
      this.counters.tasksFailed += 1
      this.writeEvent({ t: 'task', at: this.now(), action: 'fail', autonomy })
    } else if (state === 'cancelled') {
      this.counters.tasksCancelled += 1
      this.writeEvent({ t: 'task', at: this.now(), action: 'cancel', autonomy })
    }
  }

  private writeEvent(event: MetricsEvent): void {
    if (this.file === null || this.truncated) return
    const line = `${JSON.stringify(event)}\n`
    if (this.fileBytes + Buffer.byteLength(line) > this.maxFileBytes) {
      this.truncated = true
      this.logger?.warn('陪伴指标文件达到单日上限，今日不再写入')
      return
    }
    try {
      appendFileSync(this.file, line, 'utf8')
      this.fileBytes += Buffer.byteLength(line)
    } catch (error) {
      this.truncated = true
      this.logger?.warn('陪伴指标写入失败，已停止本次写入', {
        error: String(error).slice(0, 200)
      })
    }
  }

  private rollIfNeeded(): void {
    const day = dayKey(this.now())
    if (day === this.day) return
    this.rotate()
    this.day = day
    this.counters = emptyCounters()
    this.recent = []
    this.truncated = false
    this.fileBytes = 0
    this.pruneArchives()
  }

  private rotate(): void {
    if (this.file === null) return
    try {
      if (!existsSync(this.file)) return
      const archive = join(dirname(this.file), `companion-metrics-${this.day}.jsonl`)
      renameSync(this.file, archive)
    } catch (error) {
      this.logger?.warn('陪伴指标轮转失败，继续写入原文件', {
        error: String(error).slice(0, 200)
      })
    }
  }

  /**
   * 启动时若当前文件属于更早的一天，先归档再开始今天。
   *
   * 以文件里最后一条事件的 `at` 判断归属日期，而不是文件 mtime：主进程可以
   * 注入时钟（测试/受控时钟），mtime 与事件日期可能不在同一天；mtime 只在
   * 文件为空或全部无法解析时兜底。
   */
  private rotateStale(): void {
    if (this.file === null || !existsSync(this.file)) return
    try {
      let fileDay: string | null = null
      let text = ''
      try {
        text = readFileSync(this.file, 'utf8')
      } catch {
        text = ''
      }
      const lines = text.split('\n')
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]
        if (line === undefined || line.trim() === '') continue
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>
          const at = finiteOr(parsed['at'], Number.NaN)
          if (Number.isFinite(at)) {
            fileDay = dayKey(at)
            break
          }
        } catch {
          /* 跳过损坏行，继续找最近一条可读事件 */
        }
      }
      if (fileDay === null) fileDay = dayKey(statSync(this.file).mtimeMs)
      if (fileDay === this.day) return
      const archive = join(dirname(this.file), `companion-metrics-${fileDay}.jsonl`)
      renameSync(this.file, archive)
    } catch {
      /* 读不到 mtime 时按当天文件处理 */
    }
  }

  private hydrate(): void {
    if (this.file === null || !existsSync(this.file)) return
    let text = ''
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    this.fileBytes = Buffer.byteLength(text)
    const lines = text.split('\n')
    for (const line of lines) {
      if (line.trim() === '') continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        continue
      }
      this.applyEvent(raw)
    }
  }

  private applyEvent(raw: unknown): void {
    if (raw === null || typeof raw !== 'object') return
    const event = raw as Record<string, unknown>
    switch (event['t']) {
      case 'wake': {
        const kind =
          event['kind'] === 'companion'
            ? 'companion'
            : event['kind'] === 'reaction'
              ? 'reaction'
              : event['kind'] === 'screen'
                ? 'screen'
                : 'autonomy'
        const reason = typeof event['reason'] === 'string' && REASON_PATTERN.test(event['reason'])
          ? event['reason']
          : 'unknown'
        const at = finiteOr(event['at'], this.now())
        this.counters.considerations[kind] += 1
        this.counters.reasons[reason] = (this.counters.reasons[reason] ?? 0) + 1
        this.recent.push({ at, kind, reason })
        if (this.recent.length > MAX_RECENT) this.recent.shift()
        break
      }
      case 'spoke': {
        const kind =
          event['kind'] === 'companion'
            ? 'companion'
            : event['kind'] === 'reaction'
              ? 'reaction'
              : event['kind'] === 'autonomy'
                ? 'autonomy'
                : event['kind'] === 'screen'
                  ? 'screen'
                  : null
        if (kind !== null) this.counters.spoke[kind] += 1
        break
      }
      case 'explore': {
        const kind = event['kind']
        if (
          kind === 'observation' ||
          kind === 'action' ||
          kind === 'artifact' ||
          kind === 'planning' ||
          kind === 'rest' ||
          kind === 'no_progress'
        ) {
          this.applyExploreCount(kind)
        }
        break
      }
      case 'reaction': {
        const action = event['action']
        if (
          action === 'candidate' ||
          action === 'coalesced' ||
          action === 'expired' ||
          action === 'silent' ||
          action === 'spoken' ||
          action === 'local-action' ||
          action === 'model-action' ||
          action === 'continued' ||
          action === 'own-action-suppressed' ||
          action === 'cancelled'
        ) {
          this.applyReactionCount(action)
        }
        break
      }
      case 'reaction-latency': {
        const ms = finiteOr(event['ms'], -1)
        if (ms >= 0) {
          this.counters.reactionLatencies.push(Math.min(10 * 60_000, Math.round(ms)))
          if (this.counters.reactionLatencies.length > 200) {
            this.counters.reactionLatencies.shift()
          }
        }
        break
      }
      case 'reaction-event-age': {
        const ms = finiteOr(event['ms'], -1)
        if (ms >= 0) {
          this.counters.reactionEventAges.push(Math.min(10 * 60_000, Math.round(ms)))
          if (this.counters.reactionEventAges.length > 200) {
            this.counters.reactionEventAges.shift()
          }
        }
        break
      }
      case 'reaction-model-latency': {
        const ms = finiteOr(event['ms'], -1)
        if (ms >= 0) {
          this.counters.reactionModelLatencies.push(Math.min(30 * 60_000, Math.round(ms)))
          if (this.counters.reactionModelLatencies.length > 200) {
            this.counters.reactionModelLatencies.shift()
          }
        }
        break
      }
      case 'episode':
        if (event['action'] === 'answered') this.counters.episodesAnswered += 1
        else if (event['action'] === 'unanswered') this.counters.episodesUnanswered += 1
        break
      case 'task': {
        const autonomy = event['autonomy'] === true
        const action = event['action']
        if (action === 'start') {
          this.counters.tasksStarted += 1
          if (autonomy) this.counters.autonomyTasksStarted += 1
        } else if (action === 'complete') {
          this.counters.tasksCompleted += 1
          if (autonomy) this.counters.autonomyTasksCompleted += 1
        } else if (action === 'fail') {
          this.counters.tasksFailed += 1
        } else if (action === 'cancel') {
          this.counters.tasksCancelled += 1
        }
        break
      }
      case 'tool': {
        const tool = typeof event['tool'] === 'string' ? event['tool'] : 'unknown'
        const source = event['source']
        const own = source === 'autonomy' || source === 'task'
        const ok = event['ok'] === true
        const dup = event['dup'] === true
        this.applyToolCounts(tool, own && ok, dup)
        break
      }
      case 'cost': {
        this.counters.modelCalls += finiteOr(event['calls'], 0)
        this.counters.promptTokens += finiteOr(event['promptTokens'], 0)
        this.counters.completionTokens += finiteOr(event['completionTokens'], 0)
        this.counters.cacheHitTokens += finiteOr(event['cacheHitTokens'], 0)
        this.counters.estimatedCny += finiteOr(event['cny'], 0)
        break
      }
      case 'process': {
        const cpu = finiteOr(event['cpu'], 0)
        const mem = Math.max(0, finiteOr(event['mem'], 0))
        this.counters.processSamples += 1
        this.counters.lastCpuPercent = cpu
        this.counters.lastMemoryMB = mem
        this.counters.maxMemoryMB = Math.max(this.counters.maxMemoryMB ?? 0, mem)
        this.counters.lastProcessAt = finiteOr(event['at'], this.now())
        break
      }
      default:
        break
    }
  }

  private applyExploreCount(kind: ExploreMetricKind): void {
    switch (kind) {
      case 'observation':
        this.counters.exploreObservation += 1
        break
      case 'action':
        this.counters.exploreAction += 1
        break
      case 'artifact':
        this.counters.exploreArtifact += 1
        break
      case 'planning':
        this.counters.explorePlanning += 1
        break
      case 'rest':
        this.counters.exploreRest += 1
        break
      case 'no_progress':
        this.counters.exploreNoProgress += 1
        break
    }
  }

  private applyReactionCount(action: ReactionMetricAction): void {
    switch (action) {
      case 'candidate':
        this.counters.reactionCandidates += 1
        break
      case 'coalesced':
        this.counters.reactionCoalesced += 1
        break
      case 'expired':
        this.counters.reactionExpired += 1
        break
      case 'silent':
        this.counters.reactionSilent += 1
        break
      case 'spoken':
        this.counters.reactionSpoken += 1
        break
      case 'local-action':
        this.counters.reactionLocalActions += 1
        break
      case 'model-action':
        this.counters.reactionModelActions += 1
        break
      case 'model-declined':
        this.counters.reactionModelDeclined += 1
        break
      case 'provider-failed':
        this.counters.reactionProviderFailed += 1
        break
      case 'render-rejected':
        this.counters.reactionRenderRejected += 1
        break
      case 'deduped':
        this.counters.reactionDeduped += 1
        break
      case 'busy-deferred':
        this.counters.reactionBusyDeferred += 1
        break
      case 'user-quiet':
        this.counters.reactionUserQuiet += 1
        break
      case 'continued':
        this.counters.reactionContinued += 1
        break
      case 'own-action-suppressed':
        this.counters.reactionOwnActionSuppressed += 1
        break
      case 'cancelled':
        this.counters.reactionCancelled += 1
        break
      case 'model-decision-required':
        break
    }
  }

  private applyToolCounts(tool: string, ownOk: boolean, duplicate: boolean): void {
    if (ownOk) {
      this.counters.toolCalls += 1
      if (READ_TOOLS.has(tool)) this.counters.reads += 1
      if (OBSERVE_TOOLS.has(tool)) this.counters.observes += 1
      if (duplicate) this.counters.duplicateReads += 1
      if (NOTE_WRITE_TOOLS.has(tool)) this.counters.noteWrites += 1
    }
    if (tool.startsWith('cua_') || tool === 'screen_observe') this.counters.cuaActions += 1
    if (VISION_TOOLS.has(tool)) this.counters.visionActions += 1
  }

  private pruneArchives(): void {
    if (this.file === null) return
    try {
      const dir = dirname(this.file)
      const archives = readdirSync(dir)
        .filter((name) => /^companion-metrics-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort()
      for (const name of archives.slice(0, Math.max(0, archives.length - 14))) {
        try {
          unlinkSync(join(dir, name))
        } catch {
          /* 单个旧文件删不掉不影响指标 */
        }
      }
    } catch {
      /* 目录不可读时忽略 */
    }
  }
}

function emptyCounters(): Counters {
  return {
    considerations: { autonomy: 0, companion: 0, reaction: 0, screen: 0 },
    spoke: { autonomy: 0, companion: 0, reaction: 0, screen: 0 },
    reasons: {},
    exploreObservation: 0,
    exploreAction: 0,
    exploreArtifact: 0,
    explorePlanning: 0,
    exploreRest: 0,
    exploreNoProgress: 0,
    reactionCandidates: 0,
    reactionCoalesced: 0,
    reactionLocalActions: 0,
    reactionModelActions: 0,
    reactionContinued: 0,
    reactionSpoken: 0,
    reactionSilent: 0,
    reactionExpired: 0,
    reactionModelDeclined: 0,
    reactionProviderFailed: 0,
    reactionRenderRejected: 0,
    reactionDeduped: 0,
    reactionBusyDeferred: 0,
    reactionUserQuiet: 0,
    reactionOwnActionSuppressed: 0,
    reactionCancelled: 0,
    reactionLatencies: [],
    reactionEventAges: [],
    reactionModelLatencies: [],
    episodesAnswered: 0,
    episodesUnanswered: 0,
    tasksStarted: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksCancelled: 0,
    autonomyTasksStarted: 0,
    autonomyTasksCompleted: 0,
    toolCalls: 0,
    reads: 0,
    observes: 0,
    noteWrites: 0,
    duplicateReads: 0,
    cuaActions: 0,
    visionActions: 0,
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    estimatedCny: 0,
    processSamples: 0,
    lastCpuPercent: null,
    lastMemoryMB: null,
    maxMemoryMB: null,
    lastProcessAt: null
  }
}

function dayKey(at: number): string {
  const date = new Date(at)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] ?? null
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
