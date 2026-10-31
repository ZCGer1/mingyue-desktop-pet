import { toolMetaFor } from './toolMeta'
import { bindable, related, safeEvidence, verificationLevel, type EvidenceLevel } from './taskEvidence'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { AppConfig } from '../shared/config'
import { effectiveExploration, isExplorationAppExcluded } from '../shared/exploration'
import { isPathInside } from '../shared/path'
import { normalizeProcessKey } from '../shared/processName'
import { domainConstraintError, type CapabilityStore } from './capabilityStore'
import type { CapabilityConstraints, CapabilityId } from './capabilityTypes'
import { CAPABILITY_ACTIONS } from './capabilityTypes'
import type { TaskStore } from './taskStore'
import { bumpGeneration, reduceTask } from './taskMachine'
import type { TaskCheckpointStep, TaskRecord, TaskStep } from './taskTypes'
import { isTerminalTaskState, toTaskView, type TaskView } from './taskTypes'
import type {
  EventInput,
  Logger,
  TaskRuntimeHooks,
  TimerApi,
  ToolOutcome,
  TurnOutcome
} from './types'

export interface TaskRunnerOptions {
  store: TaskStore
  capabilities: CapabilityStore
  logger: Logger
  getConfig: () => AppConfig
  now?: () => number
  /** 拒绝绑定此任务的待审批请求（取消/接管时）。 */
  rejectApprovals?: (taskId: string, reason: string) => void
}

interface TaskRuntime {
  pushEvent(input: EventInput): void
  timers: TimerApi
  abortCycle(reason: string): void
}

/** 由 TasksWorld 按配置构造的受限 grant；绝不从模型参数直接透传。 */
export interface TaskGrantPlan {
  capability: CapabilityId
  actions: string[]
  constraints: CapabilityConstraints
  autoApproveYellow: boolean
}

export interface CreateTaskInput {
  title: string
  intent: string
  source: 'user-chat' | 'quick-chat' | 'autonomy'
  capabilities: CapabilityId[]
  /** 关联的活跃兴趣；只用于提示/成果归档，不授予权限。 */
  interestId?: string | null
  /** 自主任务的受限预授权；缺省时保持原有「能力默认动作」行为。 */
  grants?: TaskGrantPlan[]
  /** 绝对时间；null/过去表示立即开始。 */
  startAt: number | null
  durationMinutes?: number
}

/** 自主小目标最多推进的模型轮数；用尽后终止目标并释放自主槽位。 */
export const AUTONOMY_MAX_MODEL_CYCLES = 6
/** 单轮被工具轮数上限截断后的续跑退避：给界面/网络一瞬间稳定。 */
const AUTONOMY_CAPPED_RETRY_MS = 3_000
/** 单轮执行失败的最多重试次数与指数退避基数（封顶 5 分钟）。 */
const AUTONOMY_MAX_FAILURE_RETRIES = 2
const AUTONOMY_FAILURE_BACKOFF_MS = 60_000
const AUTONOMY_MAX_BACKOFF_MS = 5 * 60_000

const TERMINAL_BLOCK_CODES = new Set([
  'CAPABILITY_DENIED',
  'CUA_BLOCKED',
  'CUA_LIMIT',
  'CUA_RATE_LIMITED'
])
const USER_STOP_CODES = new Set([
  'TOOL_DENIED',
  'CUA_ABORTED',
  'TOOL_ABORTED',
  'USER_TAKEOVER_HOLD',
  // 桌面租约拒绝：接管保持、锁屏、被用户入口抢占、退出或取消排队。
  'DESKTOP_LOCKED',
  'DESKTOP_TAKEOVER_HOLD',
  'DESKTOP_ABORTED',
  'DESKTOP_PREEMPTED',
  'DESKTOP_DISPOSED'
])

/**
 * 串行任务调度与持久化。
 *
 * 它不调用模型：只把 `task.kick` 注入 Core，由唯一的模型循环推进；每一轮
 * 工具结果再回到这里更新 WAL、预算与状态。所有迟到回调都必须通过
 * `taskId + generation + 非终态` 三项校验。
 */
export class TaskRunner implements TaskRuntimeHooks {
  private readonly store: TaskStore
  private readonly capabilities: CapabilityStore
  private readonly logger: Logger
  private readonly getConfig: () => AppConfig
  private readonly now: () => number
  private readonly rejectApprovals: ((taskId: string, reason: string) => void) | null
  private runtime: TaskRuntime | null = null
  private currentTaskId: string | null = null
  private consecutiveFailures = 0
  /** 自主目标连续失败的续跑次数；成功一轮即清零。 */
  private readonly autonomyFailureRetries = new Map<string, number>()
  /** 下一次 kick 要告诉模型的续跑原因（截断/失败/环境复验）。 */
  private readonly autonomyResumeNotes = new Map<string, string>()
  /** recoverAfterRestart 记录下来、等 Core.start() 之后才唤醒的任务。 */
  private recoveredReady: string[] = []

  constructor(options: TaskRunnerOptions) {
    this.store = options.store
    this.capabilities = options.capabilities
    this.logger = options.logger
    this.getConfig = options.getConfig
    this.now = options.now ?? (() => Date.now())
    this.rejectApprovals = options.rejectApprovals ?? null
  }

  private rejectPending(taskId: string, reason: string): void {
    try {
      this.rejectApprovals?.(taskId, reason)
    } catch (error) {
      this.logger.warn('拒绝任务审批失败', { error: String(error).slice(0, 200) })
    }
  }

  bindRuntime(runtime: TaskRuntime): void {
    this.runtime = runtime
  }

  // ------------------------------------------------------------------ 创建/查询

  createTask(input: CreateTaskInput): TaskRecord {
    const config = this.getConfig()
    const maxMinutes = config.autonomy.task.maxMinutes
    const duration = clampInt(input.durationMinutes ?? maxMinutes, 1, maxMinutes, maxMinutes)
    const now = this.now()
    const id = randomUUID()
    const task: TaskRecord = {
      id,
      title: input.title.trim().slice(0, 80),
      intent: input.intent.trim().slice(0, 1200),
      source: input.source,
      interestId: safeOpaqueId(input.interestId) ?? null,
      state: 'queued',
      revision: 1,
      generation: 0,
      createdAt: now,
      updatedAt: now,
      scheduledAt: input.startAt,
      startedAt: null,
      endedAt: null,
      capabilities: [...new Set(input.capabilities)],
      grantIds: [],
      budget: { maxMinutes: duration, maxToolCalls: config.autonomy.task.maxToolCalls },
      usage: { toolCalls: 0, modelCycles: 0, startedAt: null },
      checkpoint: null,
      steps: [],
      alarmId: null,
      pendingApprovalId: null,
      waitReason: null,
      lastError: null,
      result: null,
      evidence: null
    }

    // 任务授权只覆盖本任务与本次时长；到期/撤销后执行器会拒绝。
    // 自主任务的 plan 只能收窄动作并附加路径约束，不能扩大能力默认动作。
    for (const capability of task.capabilities) {
      const plan = input.grants?.find((entry) => entry.capability === capability)
      const allowedActions = new Set<string>(CAPABILITY_ACTIONS[capability])
      const actions =
        plan === undefined
          ? undefined
          : plan.actions.filter((action) => allowedActions.has(action))
      const grant = this.capabilities.issue({
        capability,
        scope: 'task',
        source: 'task-preauthorization',
        taskId: id,
        ...(actions === undefined ? {} : { actions }),
        ...(plan === undefined ? {} : { constraints: { ...plan.constraints } }),
        ttlMs: (duration + 5) * 60_000,
        autoApproveYellow: plan === undefined ? true : plan.autoApproveYellow
      })
      task.grantIds.push(grant.id)
    }

    try {
      this.store.save(task)
    } catch (error) {
      // 任务没能写入（例如达到数量上限）时不能留下孤立的预授权 grant。
      for (const grantId of task.grantIds) this.capabilities.revoke(grantId)
      throw error
    }
    this.schedule(task)
    this.logger.info('任务已创建', {
      taskId: id.slice(0, 12),
      capabilities: task.capabilities,
      minutes: duration
    })
    return this.get(id) ?? task
  }

  get(id: string): TaskRecord | undefined {
    return this.store.get(id)
  }

  views(): TaskView[] {
    return this.store
      .list()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(toTaskView)
  }

  current(): TaskRecord | undefined {
    const id = this.currentTaskId
    if (id === null) return undefined
    const task = this.store.get(id)
    return task !== undefined && isTerminalTaskState(task.state) ? undefined : task
  }

  activeTaskId(): string | null {
    return this.currentTaskId
  }

  list(limit = 50): TaskRecord[] {
    return this.store
      .list()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, limit))
  }

  // ------------------------------------------------------------------ 用户操作

  pauseTask(id: string): boolean {
    const task = this.store.get(id)
    if (task === undefined || isTerminalTaskState(task.state)) return false
    if (task.state === 'paused') return false
    this.cancelAlarm(task)
    const next = reduceTask(
      { ...task, alarmId: null },
      { type: 'pause', at: this.now() }
    )
    this.store.save(next)
    this.rejectPending(id, '任务已暂停')
    if (this.currentTaskId === id) {
      this.currentTaskId = null
      this.runtime?.abortCycle('task-paused')
    }
    return true
  }

  resumeTask(id: string): boolean {
    const task = this.store.get(id)
    if (task === undefined) return false
    if (task.state !== 'paused' && task.state !== 'waiting_user' && task.state !== 'blocked') {
      return false
    }
    const next = reduceTask(task, { type: 'resume', at: this.now() })
    if (next === task) return false
    next.scheduledAt = this.now()
    next.alarmId = null
    this.store.save(next)
    this.kick(next.id, next.generation)
    return true
  }

  cancelTask(id: string, reason = '用户取消'): boolean {
    const task = this.store.get(id)
    if (task === undefined || isTerminalTaskState(task.state)) return false
    this.cancelAlarm(task)
    const next = reduceTask(
      { ...task, alarmId: null },
      { type: 'cancel', at: this.now(), reason }
    )
    this.store.save(next)
    this.capabilities.revokeTask(id)
    this.rejectPending(id, '任务已取消')
    if (this.currentTaskId === id) {
      this.currentTaskId = null
      this.runtime?.abortCycle('task-cancelled')
    }
    this.logger.info('任务已取消', { taskId: id.slice(0, 12) })
    return true
  }

  /**
   * 授权范围变化（关闭自主/改模式/换笔记目录）时立即停掉所有自主目标：
   * 排队中的取消定时器，运行中的中止当前轮并撤销 grant。
   */
  invalidateAutonomyTasks(reason: string): number {
    const ids = this.store
      .list()
      .filter((task) => task.source === 'autonomy' && !isTerminalTaskState(task.state))
      .map((task) => task.id)
    let count = 0
    for (const id of ids) {
      if (this.cancelTask(id, reason)) count += 1
    }
    return count
  }

  /**
   * 自主运行时放弃自己的失败/过期目标。与用户取消不同，这是终态 failed，
   * 会立刻撤销授权并释放唯一的自主槽位；只允许自主目标调用（由 TasksWorld 校验）。
   */
  abandonTask(id: string, reason: string): boolean {
    const task = this.store.get(id)
    if (task === undefined || task.source !== 'autonomy') return false
    if (isTerminalTaskState(task.state)) return false
    this.terminalizeAutonomy(task, this.now(), `自主目标已放弃：${reason}`)
    return true
  }

  /**
   * 用户真实接管/按下紧急停止：当前任务停下等用户，不再自动抢回。
   * 返回是否有任务被改变。
   */
  noteUserStop(reason: string): boolean {
    const id = this.currentTaskId
    if (id === null) return false
    const task = this.store.get(id)
    if (task === undefined || isTerminalTaskState(task.state)) return false
    if (task.state === 'paused' || task.state === 'waiting_user') return false
    const next = bumpGeneration(
      reduceTask(task, {
        type: 'wait_user',
        at: this.now(),
        reason: `用户接管了桌面：${reason}`
      }),
      this.now()
    )
    this.store.save(next)
    this.currentTaskId = null
    this.rejectPending(id, '用户接管了桌面')
    this.logger.info('任务因用户接管停止', { taskId: id.slice(0, 12) })
    return true
  }

  // ------------------------------------------------------------------ 调度

  /** 定时器到点；只在状态/generation 匹配时重新注入 task.kick。 */
  onTimer(taskId: string, generation: number | undefined, now: number): boolean {
    const task = this.store.get(taskId)
    if (task === undefined) {
      this.logger.info('忽略已不存在任务的定时器', { taskId: taskId.slice(0, 12) })
      return true
    }
    if (generation !== undefined && generation !== task.generation) {
      this.logger.info('忽略过期任务定时器', { taskId: taskId.slice(0, 12) })
      return true
    }
    if (task.state !== 'queued') return true
    this.store.save({
      ...task,
      scheduledAt: now,
      alarmId: null,
      updatedAt: now,
      revision: task.revision + 1
    })
    this.kick(taskId, task.generation)
    return true
  }

  canRun(taskId: string, generation: number, _now: number): boolean {
    const task = this.store.get(taskId)
    return task !== undefined && task.state === 'queued' && task.generation === generation
  }

  isCurrent(taskId: string, generation: number): boolean {
    const task = this.store.get(taskId)
    return (
      task !== undefined &&
      task.generation === generation &&
      !isTerminalTaskState(task.state) &&
      task.state !== 'paused'
    )
  }

  private schedule(task: TaskRecord): void {
    if (this.runtime === null) {
      this.logger.warn('任务运行时尚未绑定，无法调度', { taskId: task.id.slice(0, 12) })
      return
    }
    const now = this.now()
    if (task.scheduledAt !== null && task.scheduledAt > now + 2_000) {
      try {
        const alarmId = this.runtime.timers.set(new Date(task.scheduledAt).toISOString(), {
          note: `任务：${task.title}`.slice(0, 200),
          kind: 'task',
          taskId: task.id,
          taskGeneration: task.generation
        })
        const next = this.store.get(task.id)
        if (next !== undefined) {
          this.store.save({
            ...next,
            alarmId,
            updatedAt: now,
            revision: next.revision + 1
          })
        }
      } catch (error) {
        this.logger.error('任务定时失败', { error: String(error).slice(0, 200) })
        this.blockTask(task.id, '无法创建任务定时器')
      }
      return
    }
    const next = this.store.get(task.id)
    if (next === undefined) return
    this.store.save({
      ...next,
      scheduledAt: now,
      alarmId: null,
      updatedAt: now,
      revision: next.revision + 1
    })
    this.kick(task.id, next.generation)
  }

  private kick(taskId: string, generation: number): void {
    if (this.runtime === null) {
      this.logger.warn('任务运行时尚未绑定，无法唤醒', { taskId: taskId.slice(0, 12) })
      return
    }
    const task = this.store.get(taskId)
    if (task === undefined || task.state !== 'queued') return
    const progress: string[] = []
    if (task.checkpoint !== null && task.checkpoint.summary.trim() !== '') {
      progress.push(`上次进度：${task.checkpoint.summary.trim()}`)
    }
    if (task.checkpoint?.v === 2 && task.checkpoint.steps.length > 0) {
      const done = task.checkpoint.steps
        .slice(-8)
        .map((step) => `${step.tool}${step.targetRef === null ? '' : `(${step.targetRef})`}`)
        .join('、')
      progress.push(`已完成步骤：${done}。这些不要重复做。`)
    }
    if (task.source === 'autonomy') {
      const resumeNote = this.autonomyResumeNotes.get(taskId)
      if (resumeNote !== undefined) {
        this.autonomyResumeNotes.delete(taskId)
        progress.push(`续跑说明：${resumeNote}`)
      }
    }
    if (task.interestId !== null) {
      progress.push(
        `这个任务关联兴趣 id=${task.interestId}；完成后用 interest_update 更新进展，并把 notes/ 成果挂到该兴趣。`
      )
    }
    const text =
      task.source === 'autonomy'
        ? [
            `[task] 自主目标「${task.title}」继续推进（id=${task.id.slice(0, 12)}，generation=${generation}）。`,
            `目标：${task.intent}`,
            '这是你自己发起的自主目标（用户没有新指令）。',
            '只用已授权能力；读取/搜索可直接用，写入只能在 notes/。',
            ...progress,
            '先确认现状，基于真实读取形成发现；写笔记后用 ws_read 回读验证。',
            '把安全、简短、无绝对路径的发现写进 task_checkpoint。',
            '如果写了值得分享的笔记，先调用 pet_say 用一句自然的话邀请用户看看（不要报路径），再调用 task_complete 并给出验证证据。',
            '没有发现就保持安静，不要编造笔记或发现。'
          ].join('\n')
        : [
            `[task] 任务「${task.title}」开始（id=${task.id.slice(0, 12)}，generation=${generation}）。`,
            `目标：${task.intent}`,
            `已授权能力：${task.capabilities.join('、')}；预算：${task.budget.maxMinutes} 分钟 / ${task.budget.maxToolCalls} 次工具调用。`,
            ...progress,
            '请先用只读工具确认当前状态，再执行操作；每次关键操作后验证。完成时必须调用 task_complete 并说明验证证据。',
            '若权限不足、用户接管或界面不属于任务范围，停止并说明，不要绕过。'
          ].join('\n')
    this.runtime.pushEvent({
      type: 'task.kick',
      source: 'task',
      origin: 'internal',
      text,
      attention: 'wake',
      persist: false,
      ephemeral: true,
      meta: {
        taskId,
        taskGeneration: generation,
        taskTitle: task.title,
        // 只用于预载下一轮可见工具组；每个动作仍必须命中任务 grant。
        taskCapabilities: task.capabilities
      }
    })
    this.logger.info('任务已唤醒', { taskId: taskId.slice(0, 12) })
  }

  private cancelAlarm(task: TaskRecord): void {
    if (task.alarmId === null || this.runtime === null) return
    try {
      this.runtime.timers.cancel(task.alarmId)
    } catch {
      /* 忽略 */
    }
  }

  private blockTask(taskId: string, reason: string): void {
    const task = this.store.get(taskId)
    if (task === undefined || isTerminalTaskState(task.state)) return
    if (task.source === 'autonomy') {
      // 自主目标没有在场的用户来解除 blocked；留在非终态会永久占用唯一
      // 自主槽位，因此调度失败等异常直接终止并释放授权。
      this.terminalizeAutonomy(task, this.now(), reason)
      return
    }
    this.cancelAlarm(task)
    const next = reduceTask(
      { ...task, alarmId: null },
      { type: 'block', at: this.now(), reason }
    )
    this.store.save(next)
    if (this.currentTaskId === taskId) {
      this.currentTaskId = null
      this.runtime?.abortCycle('task-blocked')
    }
  }

  /** 自主目标进入终态 failed：撤销授权、拒绝待审批、释放槽位。 */
  private terminalizeAutonomy(task: TaskRecord, at: number, error: string): void {
    if (isTerminalTaskState(task.state)) return
    this.cancelAlarm(task)
    const next = reduceTask(
      { ...task, alarmId: null, pendingApprovalId: null },
      { type: 'fail', at, error }
    )
    this.store.save(next)
    this.capabilities.revokeTask(task.id)
    this.rejectPending(task.id, error)
    this.autonomyFailureRetries.delete(task.id)
    this.autonomyResumeNotes.delete(task.id)
    if (this.currentTaskId === task.id) {
      this.currentTaskId = null
      this.runtime?.abortCycle('task-failed')
    }
    this.logger.info('自主目标已终止', {
      taskId: task.id.slice(0, 12),
      reason: error.slice(0, 160)
    })
  }

  /** 自主目标的总预算（模型轮数/工具次数/时长）是否已经用尽。 */
  private autonomyBudgetProblem(task: TaskRecord, now: number): string | null {
    if (task.usage.modelCycles >= AUTONOMY_MAX_MODEL_CYCLES) {
      return `自主目标达到 ${AUTONOMY_MAX_MODEL_CYCLES} 轮模型上限，已终止`
    }
    if (task.usage.toolCalls >= task.budget.maxToolCalls) {
      return `自主目标用完工具调用预算（${task.budget.maxToolCalls} 次），已终止`
    }
    if (
      task.usage.startedAt !== null &&
      now - task.usage.startedAt >= task.budget.maxMinutes * 60_000
    ) {
      return `自主目标用完 ${task.budget.maxMinutes} 分钟时长预算，已终止`
    }
    return null
  }

  /**
   * 在总预算内续跑自主目标：先 wait_user 提升 generation（让迟到回调失效），
   * 再排队并按退避时间重新调度。next kick 会带上 resumeNote。
   */
  private resumeAutonomy(
    task: TaskRecord,
    at: number,
    delayMs: number,
    reason: string,
    resumeNote: string
  ): boolean {
    const stopped = bumpGeneration(
      reduceTask({ ...task, pendingApprovalId: null }, { type: 'wait_user', at, reason }),
      at
    )
    const resumed = reduceTask(stopped, { type: 'resume', at })
    if (resumed === stopped) return false
    resumed.scheduledAt = at + Math.max(0, Math.round(delayMs))
    resumed.alarmId = null
    this.store.save(resumed)
    this.autonomyResumeNotes.set(resumed.id, resumeNote)
    this.schedule(resumed)
    return true
  }

  // ------------------------------------------------------------------ TaskRuntimeHooks

  /**
   * 用户回合开始时保留未完成用户任务所需组。只用于可见性预载：
   * 返回声明能力，不代表当前授权，也不把自主目标的能力带进用户聊天。
   */
  unfinishedTaskCapabilities(): readonly string[] {
    const current = this.current()
    if (current !== undefined && current.source !== 'autonomy') {
      return [...current.capabilities]
    }
    const task = this.store
      .list()
      .filter((candidate) => candidate.source !== 'autonomy')
      .filter((candidate) => !isTerminalTaskState(candidate.state))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return task === undefined ? [] : [...task.capabilities]
  }

  onCycleStarted(ctx: { taskId: string; generation: number; now: number }): void {
    const task = this.store.get(ctx.taskId)
    if (task === undefined || task.generation !== ctx.generation || task.state !== 'queued') {
      return
    }
    this.currentTaskId = task.id
    this.consecutiveFailures = 0
    const started = reduceTask(task, { type: 'start', at: ctx.now })
    started.startedAt = started.startedAt ?? ctx.now
    started.usage = { ...started.usage, startedAt: started.usage.startedAt ?? ctx.now }
    this.store.save(started)
  }

  onToolIntent(ctx: {
    taskId: string
    generation: number
    callId: string
    tool: string
    sideEffect: boolean
    verify: boolean
    now: number
  }): void {
    const task = this.fresh(ctx.taskId, ctx.generation)
    if (task === undefined) return
    // 任务控制面工具自己维护状态，不写外部副作用 WAL。
    if (ctx.tool.startsWith('task_')) return
    // 只有副作用工具需要 WAL intent；读工具在结果回来时直接记 done。
    if (!ctx.sideEffect) return
    const step: TaskStep = {
      id: randomUUID(),
      callId: ctx.callId,
      at: ctx.now,
      kind: 'tool',
      tool: ctx.tool,
      status: 'intent',
      sideEffect: true,
      verify: ctx.verify,
      summary: `${ctx.tool} → 执行中`,
      targetRef: null
    }
    this.store.save({
      ...task,
      steps: [...task.steps, step].slice(-200),
      updatedAt: ctx.now,
      revision: task.revision + 1
    })
  }

  onToolResult(ctx: {
    taskId: string
    generation: number
    callId: string
    tool: string
    outcome: ToolOutcome
    sideEffect: boolean
    verify: boolean
    now: number
  }): { abort: boolean; reason?: string } {
    const task = this.fresh(ctx.taskId, ctx.generation)
    if (task === undefined) return { abort: false }
    const code = outcomeCode(ctx.outcome)
    const failed = ctx.outcome.failed === true
    const targetRef = safeTargetRef(ctx.outcome.meta?.targetRef)
    let steps = [...task.steps]
    const intentIndex = steps.findIndex(
      (step) => step.callId === ctx.callId && step.status === 'intent'
    )
    const mayHaveExecuted = ctx.sideEffect
    const status: TaskStep['status'] = failed
      ? mayHaveExecuted
        ? USER_STOP_CODES.has(code) || TERMINAL_BLOCK_CODES.has(code)
          ? 'failed'
          : 'unknown'
        : 'failed'
      : 'done'
    if (intentIndex >= 0) {
      steps[intentIndex] = {
        ...steps[intentIndex]!,
        status,
        at: ctx.now,
        summary: `${ctx.tool} → ${code}`,
        targetRef,
        ...safeEvidence({ ...ctx.outcome.meta, visual: ctx.outcome.meta?.visual === true || toolMetaFor(ctx.tool, ctx.outcome.meta?.operation).visual === true })
      }
    } else if (!ctx.tool.startsWith('task_')) {
      // task_checkpoint 自己写步骤，task_complete/cancel 会直接进入终态；
      // 控制面工具不重复记一条外部步骤。
      steps.push({
        id: randomUUID(),
        callId: ctx.callId,
        at: ctx.now,
        kind: 'tool',
        tool: ctx.tool,
        status,
        sideEffect: ctx.sideEffect,
        verify: ctx.verify,
        summary: `${ctx.tool} → ${code}`,
        targetRef,
        ...safeEvidence({ ...ctx.outcome.meta, visual: ctx.outcome.meta?.visual === true || toolMetaFor(ctx.tool, ctx.outcome.meta?.operation).visual === true })
      })
    }
    steps = steps.slice(-200)
    this.consecutiveFailures = failed ? this.consecutiveFailures + 1 : 0

    let next: TaskRecord = {
      ...task,
      steps,
      usage: { ...task.usage, toolCalls: task.usage.toolCalls + 1 },
      updatedAt: ctx.now,
      revision: task.revision + 1
    }

    let abort = false
    let reason: string | undefined
    // terminalizeAutonomy 会自己落盘 failed；结束时不能再把旧 next 覆盖回去。
    let terminalized = false
    if (TERMINAL_BLOCK_CODES.has(code)) {
      if (next.source === 'autonomy') {
        // 没有用户在场地解除 blocked：终止并释放自主槽位。
        this.terminalizeAutonomy(next, ctx.now, `权限或安全限制阻止了自主目标：${code}`)
        terminalized = true
        abort = true
        reason = 'task-failed'
      } else {
        next = reduceTask(
          next,
          { type: 'block', at: ctx.now, reason: `权限或安全限制阻止了任务：${code}` }
        )
        abort = true
        reason = 'task-blocked'
        this.currentTaskId = null
      }
    } else if (USER_STOP_CODES.has(code)) {
      next = reduceTask(
        next,
        { type: 'wait_user', at: ctx.now, reason: `操作被用户停止或拒绝：${code}` }
      )
      abort = true
      reason = 'task-wait-user'
      this.currentTaskId = null
    } else if (next.usage.toolCalls > next.budget.maxToolCalls) {
      if (next.source === 'autonomy') {
        this.terminalizeAutonomy(
          next,
          ctx.now,
          `自主目标用完工具调用预算（${next.budget.maxToolCalls} 次），已终止`
        )
        terminalized = true
        abort = true
        reason = 'task-budget'
      } else {
        next = reduceTask(next, {
          type: 'block',
          at: ctx.now,
          reason: `工具调用次数超出预算（${next.budget.maxToolCalls}）`
        })
        abort = true
        reason = 'task-budget'
        this.currentTaskId = null
      }
    } else if (
      next.usage.startedAt !== null &&
      ctx.now - next.usage.startedAt > next.budget.maxMinutes * 60_000
    ) {
      if (next.source === 'autonomy') {
        this.terminalizeAutonomy(
          next,
          ctx.now,
          `自主目标用完 ${next.budget.maxMinutes} 分钟时长预算，已终止`
        )
        terminalized = true
        abort = true
        reason = 'task-budget'
      } else {
        next = reduceTask(next, {
          type: 'block',
          at: ctx.now,
          reason: `任务运行时间超出预算（${next.budget.maxMinutes} 分钟）`
        })
        abort = true
        reason = 'task-budget'
        this.currentTaskId = null
      }
    } else if (this.consecutiveFailures >= 3) {
      if (next.source === 'autonomy') {
        this.terminalizeAutonomy(
          next,
          ctx.now,
          '连续三次工具失败，已终止自主目标以免重复副作用'
        )
        terminalized = true
        abort = true
        reason = 'task-failed'
      } else {
        next = reduceTask(next, {
          type: 'block',
          at: ctx.now,
          reason: '连续三次工具失败，已停止以免重复副作用'
        })
        abort = true
        reason = 'task-blocked'
        this.currentTaskId = null
      }
    }
    if (!terminalized && next !== task) this.store.save(next)
    return { abort, ...(reason === undefined ? {} : { reason }) }
  }

  onCycleEnded(ctx: {
    taskId: string
    generation: number
    outcome: TurnOutcome
    now: number
  }): void {
    const task = this.store.get(ctx.taskId)
    if (task === undefined || task.generation !== ctx.generation) return
    if (isTerminalTaskState(task.state)) return
    const usage = { ...task.usage, modelCycles: task.usage.modelCycles + 1 }
    if (task.state === 'waiting_user' || task.state === 'blocked' || task.state === 'paused') {
      this.store.save({ ...task, usage, updatedAt: ctx.now, revision: task.revision + 1 })
      return
    }
    const withUsage: TaskRecord = {
      ...task,
      usage,
      updatedAt: ctx.now,
      revision: task.revision + 1
    }

    if (task.source !== 'autonomy') {
      const reason =
        ctx.outcome === 'failed'
          ? task.lastError ?? '本轮中断，任务已停下等待你确认'
          : ctx.outcome === 'capped'
            ? '本轮达到轮数上限，任务尚未完成'
            : '本轮结束但任务没有通过 task_complete 验证'
      const stopped = bumpGeneration(
        reduceTask(withUsage, { type: 'wait_user', at: ctx.now, reason }),
        ctx.now
      )
      this.store.save(stopped)
      if (this.currentTaskId === ctx.taskId) this.currentTaskId = null
      return
    }

    // 自主目标：跨单轮截断/失败续跑，但始终受总预算约束；预算用尽或授权
    // 失效时进入终态，释放唯一的自主槽位。用户明确的暂停/停止走
    // waiting_user/paused，上面的分支直接返回，绝不自动续跑。
    if (ctx.outcome === 'done') this.autonomyFailureRetries.delete(task.id)

    const grantProblem = this.taskGrantProblem(withUsage, ctx.now)
    if (grantProblem !== null) {
      this.terminalizeAutonomy(withUsage, ctx.now, grantProblem)
      return
    }
    const budgetProblem = this.autonomyBudgetProblem(withUsage, ctx.now)
    if (budgetProblem !== null) {
      this.terminalizeAutonomy(withUsage, ctx.now, budgetProblem)
      return
    }
    if (withUsage.pendingApprovalId !== null) {
      const stopped = bumpGeneration(
        reduceTask(withUsage, {
          type: 'wait_user',
          at: ctx.now,
          reason: '等待用户处理审批，任务已暂停'
        }),
        ctx.now
      )
      this.store.save(stopped)
      if (this.currentTaskId === ctx.taskId) this.currentTaskId = null
      return
    }

    if (ctx.outcome === 'failed') {
      const retries = (this.autonomyFailureRetries.get(task.id) ?? 0) + 1
      if (retries > AUTONOMY_MAX_FAILURE_RETRIES) {
        this.terminalizeAutonomy(
          withUsage,
          ctx.now,
          `自主目标连续 ${retries} 轮执行失败，已放弃`
        )
        return
      }
      this.autonomyFailureRetries.set(task.id, retries)
      const delay = Math.min(
        AUTONOMY_MAX_BACKOFF_MS,
        AUTONOMY_FAILURE_BACKOFF_MS * 2 ** (retries - 1)
      )
      this.resumeAutonomy(
        withUsage,
        ctx.now,
        delay,
        '本轮执行失败，稍后重试',
        '上一轮执行失败。先重新确认环境、窗口/文件现状和已完成步骤；不要重复已完成的副作用，确认后再继续。'
      )
      return
    }

    // done / capped：只要总预算还在就继续推进。capped 时补一个自动检查点，
    // 让模型下一轮（或重启后）能从真实进度接着做，而不是重复副作用。
    const base = ctx.outcome === 'capped' ? this.ensureAutonomyCheckpoint(withUsage) : withUsage
    this.resumeAutonomy(
      base,
      ctx.now,
      ctx.outcome === 'capped' ? AUTONOMY_CAPPED_RETRY_MS : 0,
      ctx.outcome === 'capped' ? '本轮达到轮数上限，继续推进' : '本轮结束但任务尚未完成',
      ctx.outcome === 'capped'
        ? '上一轮达到单轮工具轮数上限；已保存自动检查点。先重新确认窗口/文件现状，再从未完成的步骤继续，不要重复已完成的副作用。'
        : '本轮结束但还没有 task_complete。先确认现状，再继续；完成时必须提供验证证据。'
    )
  }

  /** 截断续跑前保住进度：只在模型没有写检查点时补一条自动检查点。 */
  private ensureAutonomyCheckpoint(task: TaskRecord): TaskRecord {
    if (task.checkpoint !== null && task.checkpoint.summary.trim() !== '') return task
    const lastTools = task.steps
      .filter((step) => step.kind === 'tool' && step.status === 'done')
      .slice(-6)
      .map((step) => step.tool)
      .join('、')
    this.store.save(task)
    this.checkpoint(
      task.id,
      task.generation,
      `自动续跑检查点：上一轮达到单轮工具轮数上限，任务尚未完成。最近完成：${lastTools === '' ? '（暂无成功的工具步骤）' : lastTools}。`
    )
    return this.store.get(task.id) ?? task
  }

  // ------------------------------------------------------------------ 任务工具支持

  checkpoint(taskId: string, generation: number, text: string): boolean {
    const task = this.fresh(taskId, generation)
    if (task === undefined) return false
    const now = this.now()
    const checkpointSteps: TaskCheckpointStep[] = task.steps
      .filter(
        (step) =>
          step.kind === 'tool' &&
          step.status === 'done' &&
          !step.tool.startsWith('task_')
      )
      .slice(-8)
      .map((step) => ({
        at: step.at,
        tool: step.tool.slice(0, 80),
        targetRef: safeTargetRef(step.targetRef)
      }))
    const lastTool =
      checkpointSteps.length === 0
        ? null
        : checkpointSteps[checkpointSteps.length - 1]!.tool
    const next = reduceTask(task, {
      type: 'checkpoint',
      at: now,
      text,
      steps: checkpointSteps,
      lastTool
    })
    if (next === task) return false
    const step: TaskStep = {
      id: randomUUID(),
      callId: '',
      at: now,
      kind: 'checkpoint',
      tool: 'task_checkpoint',
      status: 'done',
      sideEffect: false,
      verify: false,
      summary: '记录进度',
      targetRef: null
    }
    this.store.save({
      ...next,
      steps: [...next.steps, step].slice(-200),
      updatedAt: now,
      revision: next.revision + 1
    })
    return true
  }

  /**
   * 完成校验：至少一个成功工具；若有副作用，必须在其之后有成功的验证步骤。
   * 不满足时任务保持原状态，并返回给模型可执行的下一步提示。
   */
  verifyComplete(
    taskId: string,
    generation: number,
    result: string,
    evidence: string,
    opts: { userConfirmed?: boolean } = {}
  ): { ok: boolean; message: string; evidenceLevel?: EvidenceLevel; needsUserConfirmation?: boolean } {
    const task = this.fresh(taskId, generation)
    if (task === undefined) {
      return { ok: false, message: '任务已取消/暂停或不是当前任务；不能标记完成。' }
    }
    if (result.trim() === '' || evidence.trim() === '') {
      return {
        ok: false,
        message: 'result 与 evidence 都必须填写：说明做了什么，以及如何验证。'
      }
    }
    const done = task.steps
      .map((step, index) => ({ step, index }))
      .filter((entry) => entry.step.kind === 'tool' && entry.step.status === 'done')
    if (done.length === 0) {
      return {
        ok: false,
        message: '还没有任何成功的工具步骤；先观察/操作并验证，再调用 task_complete。'
      }
    }
    const lastSideEffect = task.steps.map((step, index) => ({ step, index })).reverse().find(entry => entry.step.kind === 'tool' && entry.step.sideEffect)
    let evidenceLevel: EvidenceLevel = 'observed'
    if (lastSideEffect !== undefined) {
      if (lastSideEffect.step.status !== 'done') return { ok: false, message: '最后一个副作用失败、未知或未收到回执；请重新观察或重试，不能标记完成。' }
      if (!bindable(lastSideEffect.step.targetRef) && !bindable(lastSideEffect.step.postRef) && toolMetaFor(lastSideEffect.step.tool).targetless) {
        // These static commands have no object identity or observable postcondition.
      } else {
        const candidates = done.filter(entry => entry.index > lastSideEffect.index && entry.step.verify)
        if (candidates.length === 0) return { ok: false, message: '最后一个副作用之后还没有成功的验证步骤；请先重新观察或回读。' }
        const effect = lastSideEffect.step
        const matches = candidates.filter(({ step }) => bindable(step.targetRef) && ((bindable(effect.targetRef) && related(step.targetRef, effect.targetRef)) || step.targetRef === effect.postRef))
        if (matches.length === 0) {
          if (candidates.some(({ step }) => bindable(step.targetRef)) && (bindable(effect.targetRef) || bindable(effect.postRef))) return { ok: false, message: '验证的是另一个目标，请回读刚刚操作的目标。' }
          if (task.source === 'autonomy') return { ok: false, message: '目标引用不足，自动任务必须重新观察，不能自行确认完成。' }
          if (!opts.userConfirmed) return { ok: false, needsUserConfirmation: true, message: '目标身份无法绑定，请重新观察或由用户明确确认完成。' }
          evidenceLevel = 'user-confirmed'
        } else {
          for (const { step } of matches) {
            const level = verificationLevel(effect, step)
            if (level === 'deterministic' || (level === 'visual' && evidenceLevel === 'observed')) evidenceLevel = level
          }
        }
      }
    }
    const now = this.now()
    this.cancelAlarm(task)
    if (task.legacyEvidence && evidenceLevel === 'deterministic') evidenceLevel = 'observed'
    const completed = reduceTask(
      { ...task, alarmId: null },
      {
        type: 'complete',
        at: now,
        result: result.trim(),
        evidence: evidence.trim()
      }
    )
    this.store.save({ ...completed, evidenceLevel })
    this.capabilities.revokeTask(taskId)
    if (this.currentTaskId === taskId) this.currentTaskId = null
    this.logger.info('任务已完成并验证', {
      taskId: taskId.slice(0, 12),
      evidenceLevel
    })
    return {
      ok: true,
      message:
        evidenceLevel === 'deterministic'
          ? '任务已完成；目标身份与动作后置状态的回读一致，证据已记录。'
          : '任务已完成，验证证据已记录（观察级证据）。',
      evidenceLevel
    }
  }

  // ------------------------------------------------------------------ 维护

  clear(): void {
    for (const task of this.store.list()) this.cancelAlarm(task)
    this.currentTaskId = null
    this.store.clear()
    this.capabilities.revokeAll()
  }

  prune(now = this.now()): void {
    const config = this.getConfig()
    this.store.prune(now, config.autonomy.task.retentionDays)
    const activeIds = new Set(
      this.store
        .list()
        .filter((task) => !isTerminalTaskState(task.state))
        .map((task) => task.id)
    )
    this.capabilities.prune(now, activeIds)
  }

  // ------------------------------------------------------------------ 重启恢复

  /**
   * 启动时恢复持久任务。必须在 Core.start()/自主 tick 之前调用：
   * 这里只修正状态、重建定时器，不立即 pushEvent；需要马上继续的任务
   * 先放进 recoveredReady，由 resumeRecovered() 在 Core 启动后唤醒。
   *
   * 规则：
   * - 有未闭环 intent 的副作用 → 停下等用户，绝不重放；
   * - 其余 planning/running/observing → 按 autoResume 决定 requeue 或等用户；
   * - waiting_approval 的审批卡已不存在 → 转 waiting_user 说明需重新确认；
   * - waiting_user/paused/blocked 保持，不自动抢回；
   * - 逐个复验 grant（过期/撤销/配额/当前桌面范围/路径/域名），失效即撤销。
   */
  recoverAfterRestart(): { changed: number; waiting: number; ready: number } {
    const now = this.now()
    const config = this.getConfig()
    let changed = 0
    let waiting = 0
    this.recoveredReady = []

    for (const original of this.store.list()) {
      if (isTerminalTaskState(original.state)) continue
      if (original.alarmId !== null) this.cancelAlarm(original)
      const task: TaskRecord =
        original.alarmId === null ? original : { ...original, alarmId: null }

      if (task.state === 'waiting_user' || task.state === 'paused' || task.state === 'blocked') {
        if (task !== original) this.store.save(task, false)
        continue
      }

      const problem = this.taskGrantProblem(task, now)
      if (problem !== null) {
        this.capabilities.revokeTask(task.id)
        this.store.save(reduceTask(task, { type: 'wait_user', at: now, reason: problem }))
        changed += 1
        waiting += 1
        continue
      }

      switch (task.state) {
        case 'queued': {
          if (task.scheduledAt !== null && task.scheduledAt > now + 2_000) {
            this.schedule(task)
          } else {
            const next: TaskRecord = {
              ...task,
              scheduledAt: now,
              alarmId: null,
              updatedAt: now,
              revision: task.revision + 1
            }
            this.store.save(next)
            this.recoveredReady.push(next.id)
          }
          changed += 1
          break
        }
        case 'waiting_approval': {
          const next = bumpGeneration(
            {
              ...reduceTask(task, {
                type: 'wait_user',
                at: now,
                reason: '重启后原来的审批已失效，需要你重新确认这个任务'
              }),
              // 审批卡不在重启后恢复，旧 id 不能继续指向任何待办。
              pendingApprovalId: null
            },
            now
          )
          this.store.save(next)
          changed += 1
          waiting += 1
          break
        }
        case 'planning':
        case 'running':
        case 'observing': {
          const unclosed = task.steps.some((step) => step.status === 'intent')
          if (unclosed) {
            this.store.save(
              reduceTask(task, {
                type: 'wait_user',
                at: now,
                reason: '重启时发现未确认的副作用，等你确认'
              })
            )
            changed += 1
            waiting += 1
            break
          }
          if (!config.autonomy.task.autoResume) {
            const next = reduceTask(task, {
              type: 'wait_user',
              at: now,
              reason: '自动恢复已关闭，等你确认是否继续'
            })
            this.store.save(next)
            changed += 1
            waiting += 1
            break
          }
          const requeued = reduceTask(task, { type: 'requeue', at: now })
          if (requeued !== task) {
            requeued.scheduledAt = now
            requeued.alarmId = null
            this.store.save(requeued)
            this.recoveredReady.push(requeued.id)
            changed += 1
          }
          break
        }
        default:
          break
      }
    }

    if (changed > 0) {
      this.logger.info('任务重启恢复完成', {
        changed,
        waiting,
        ready: this.recoveredReady.length
      })
    }
    return { changed, waiting, ready: this.recoveredReady.length }
  }

  /** Core.start() 之后调用，唤醒 recoverAfterRestart 收集到的到期任务。 */
  resumeRecovered(): number {
    const ids = this.recoveredReady
    this.recoveredReady = []
    let count = 0
    for (const id of ids) {
      const task = this.store.get(id)
      if (task === undefined || task.state !== 'queued') continue
      this.kick(task.id, task.generation)
      count += 1
    }
    return count
  }

  /**
   * 重启后 grant 的静态复验（执行期仍由 CapabilityStore 逐次检查）。
   * 只验证数据仍然自洽且与当前配置范围一致；不扩大任何权限。
   */
  private taskGrantProblem(task: TaskRecord, now: number): string | null {
    if (task.capabilities.length === 0) return null
    const active = this.capabilities
      .listForTask(task.id)
      .filter((grant) => grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > now))
    if (active.length === 0) {
      return '任务授权已过期或被撤销，需要你重新确认'
    }
    for (const capability of task.capabilities) {
      if (!active.some((grant) => grant.capability === capability && grant.actions.length > 0)) {
        return '任务授权不完整，需要你重新确认'
      }
    }
    const config = this.getConfig()
    const view = effectiveExploration(config, now)
    const category = view.active && (view.windows || view.apps)
    const categoryInput = view.active && view.apps
    const observeApps = config.worlds.desktop.apps.filter((app) => app.observe)
    const allowedRoots = [config.worlds.workspace.notesRoot, ...config.autonomy.trustedRoots].filter(
      (root): root is string => typeof root === 'string' && root.trim() !== ''
    )
    for (const grant of active) {
      const max = grant.constraints.maxActions
      if (typeof max === 'number' && grant.usedActions >= max) {
        return '任务的动作次数已用完，需要你决定下一步'
      }
      const apps = grant.constraints.appAllowlist
      if (apps !== undefined && apps.length > 0) {
        if (observeApps.length === 0 && !category) return '桌面观察范围已改变，任务授权失效'
        const needsInput = grant.actions.some((action) =>
          CAPABILITY_ACTIONS['desktop.input'].includes(action)
        )
        if (category && needsInput && !categoryInput) {
          return '「普通应用」类别输入授权已关闭，任务授权失效'
        }
        for (const raw of apps) {
          const key = normalizeProcessKey(raw)
          if (key === null) return '任务授权中的应用范围无效，已撤销'
          if (isExplorationAppExcluded(view, key)) {
            return '任务授权中的应用已被加入排除名单，任务授权失效'
          }
          if (!category) {
            const app = observeApps.find((entry) => entry.process === key)
            if (app === undefined) return '桌面观察范围已改变，任务授权失效'
            if (needsInput && !app.input) {
              return `应用「${app.label.trim() === '' ? key : app.label.trim()}」的输入权限已关闭，任务授权失效`
            }
          }
        }
      }
      const roots = grant.constraints.pathRoots
      if (roots !== undefined && roots.length > 0) {
        for (const root of roots) {
          if (typeof root !== 'string' || root.trim() === '' || !isAbsolute(root)) {
            return '任务授权中的目录范围无效，已撤销'
          }
          if (!allowedRoots.some((base) => isPathInside(base, root))) {
            return '笔记目录或可信目录已改变，任务授权失效'
          }
        }
      }
      const domains = grant.constraints.domains
      if (domains !== undefined && domains.length > 0) {
        for (const domain of domains) {
          if (domainConstraintError([domain], [domain]) !== null) {
            return '任务授权中的域名范围无效，已撤销'
          }
        }
      }
    }
    return null
  }

  diagnostics(): Record<string, unknown> {
    const tasks = this.store.list()
    return {
      total: tasks.length,
      active: tasks.filter((task) => !isTerminalTaskState(task.state)).length,
      currentTaskId: this.currentTaskId,
      byState: tasks.reduce<Record<string, number>>((acc, task) => {
        acc[task.state] = (acc[task.state] ?? 0) + 1
        return acc
      }, {})
    }
  }

  // ------------------------------------------------------------------

  private fresh(taskId: string, generation: number): TaskRecord | undefined {
    const task = this.store.get(taskId)
    if (task === undefined) return undefined
    if (task.generation !== generation) return undefined
    if (isTerminalTaskState(task.state)) return undefined
    if (
      task.state !== 'planning' &&
      task.state !== 'running' &&
      task.state !== 'observing' &&
      task.state !== 'waiting_user'
    ) {
      return undefined
    }
    return task
  }
}

/** 兴趣/任务 id 只允许不透明短标识；任何模型给出的其他形状都丢弃。 */
function safeOpaqueId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null
}

/**
 * 任务 WAL 里的目标引用：只接受相对路径/域名/应用标签等短引用。
 * 绝对路径、盘符、UNC、URL 协议、`..` 与控制字符一律丢弃。
 */
function safeTargetRef(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/[\r\n\t]/g, ' ')
  if (text === '' || text.length > 120) return null
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/') || text.startsWith('\\\\')) return null
  if (/^(?:https?|file|javascript):/i.test(text)) return null
  if (text.includes('..')) return null
  return text.slice(0, 120)
}

function outcomeCode(outcome: ToolOutcome): string {
  if (outcome.code && /^[A-Z0-9_]+$/.test(outcome.code)) return outcome.code
  const match = /^\[([A-Z0-9_]+)\]/.exec(outcome.text.trim())
  if (match?.[1] !== undefined) return match[1]
  return outcome.failed === true ? 'TOOL_FAILED' : 'OK'
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}
