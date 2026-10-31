import { join } from 'node:path'
import type { AppConfig } from '../shared/config'
import { ApprovalGate } from './approval'
import type { AuditLog } from './audit'
import type { CapabilityStore } from './capabilityStore'
import type { DesktopActionCoordinator } from './desktopCoordinator'
import type { CapabilityId, CapabilityTargets, ToolSource } from './capabilityTypes'
import { WakeBus } from './bus'
import { deliverBatch } from './delivery'
import { EventStore } from './eventStore'
import type { FileLogger } from './log'
import {
  inspectToolProtocol,
  isToolPairingError,
  prepareMessagesForProvider,
  protocolLogData,
  protocolMessageFingerprint
} from './protocol'
import {
  assembleContext,
  prepareContextMessages,
  type ContextSegmentUsage
} from './contextAssembler'
import type { RequestBudgetEstimate } from './requestBudget'
import { BudgetCalibrator } from './budgetCalibrator'
import { trimTail } from './contextWindow'
import { Session, stripImagesFromRecords } from './session'

/** 兼容旧导入路径；裁剪规则与实现归 `contextWindow.ts`。 */
export { trimTail }
import { StateStore } from './state'
import { TurnWorkState, WORK_STATE_MARKER } from './turnWorkState'
import type { TurnLoopPrepare } from './turnLoop'
import { Timers, type TimerRecord } from './timers'
import {
  ToolExecutor,
  type ToolCallRequest,
  type ToolExecutionResult,
  type ToolResultInfo,
  type ToolSurface
} from './toolExecutor'
import { ToolRegistry } from './tools'
import { auditToolContracts, type ToolContractReport } from './toolContract'
import { worldPromptVisible } from './worldPrompt'
import {
  ToolExposureController,
  filterWorldPromptGroups,
  groupsForCapabilities,
  isToolGroupId,
  type ToolExposureMode,
  type ToolGroupId
} from './toolExposure'
import {
  WakeGovernor,
  type WakeDecision,
  type WakeDecisionReason,
  type WakeKind
} from './wakeGovernor'
import type {
  ContextRecord,
  CoreApi,
  EventEnvelope,
  EventInput,
  ForkOptions,
  Logger,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  OutputTap,
  Persona,
  PrefixSegment,
  ProviderFailureNotice,
  RunPhaseState,
  SessionDecl,
  SessionInfo,
  TapEvent,
  TaskRuntimeHooks,
  TimerApi,
  ToolImage,
  ToolOutcome,
  ToolRequestExposure,
  TriggerMode,
  TurnFailure,
  TurnOutcome,
  TurnReport,
  Usage,
  World,
  WorldHost,
  WorldPrefixContext
} from './types'
import { ProviderError } from './types'
import { describeToolImages, selectToolImages } from './toolImages'
import { providerErrorFromUnknown, sanitizeErrorText } from './provider/diagnostics'
import {
  cancelledFailure,
  classifyToolFailure,
  internalFailure,
  providerFailure,
  providerRecovery,
  roundCapFailure,
  sameFailure,
  toolFailureCode,
  toolTurnFailure
} from './turnFailure'
import { isAbortError, isoNow, sleep, withJitter } from './util'
import type { UsageTracker } from './usage'
import { ConversationRuntime } from './conversationRuntime'

interface ToolCallAccum {
  index: number
  id?: string
  name?: string
  arguments: string
  started: boolean
}

/** 一次物理模型请求的可诊断上下文；只用于日志与失败通知。 */
interface ProviderFailureTrace {
  requestId: string
  attempt: number
  model: string
  origin: string
  startedAt: number
  headersAt: number | null
  firstEventAt: number | null
  headersReceived: boolean
  sawModelEvent: boolean
}

export interface CoreOptions {
  conversationRuntime?: ConversationRuntime
  budgetCalibrator?: BudgetCalibrator
  config: AppConfig
  dataDir: string
  session: Session
  eventStore: EventStore
  state: StateStore
  provider: ModelProvider | null
  logger: Logger
  usage: UsageTracker
  audit: AuditLog
  approvalGate: ApprovalGate
  persona: Persona
  worlds: World[]
  capabilities: CapabilityStore
  coordinator?: DesktopActionCoordinator | null
  taskHooks?: TaskRuntimeHooks | null
  /**
   * 任务与自主探索共用的工具目标解析；用户聊天/快捷聊天沿原有语义，
   * 不按工具参数收窄本轮授权。解析不到目标时由能力层继续 fail closed。
   */
  resolveCapabilityTargets?: (
    call: ToolCallRequest,
    surface: ToolSurface
  ) => Promise<CapabilityTargets | undefined>
  /** 按被动对话 id 取一段只在本轮有效的安全衔接说明。 */
  episodeContext?: (episodeId: string) => string | null
  /** 跨快捷/完整聊天的短期话题片段；只在本轮注入，不写盘、不依赖长期记忆。 */
  conversationHandoff?: () => string | null
  /** 共同操作会话的当轮状态；只在本轮注入，不写盘，不授予任何权限。 */
  sharedActivityContext?: () => string | null
  /** 工具真实执行后的本地回调；只含元数据，供经历/探索进度记录。 */
  onToolResult?: (info: ToolResultInfo) => void
  /** 唤醒预算的真实决策；用于反应/自主/闲聊的分项诊断，不记录内容。 */
  onWakeDecision?: (decision: WakeDecision, input: EventInput) => void
  /** 模型请求失败的结构化通知；只在主进程内用于状态与诊断，不含正文。 */
  onProviderFailure?: (notice: ProviderFailureNotice) => void
  /** 每轮结束的结构化结果；状态、聊天提示与诊断共用，不含正文。 */
  onTurnReport?: (report: TurnReport) => void
  /**
   * 工具暴露模式：groups 为默认按组暴露；full 仅用于开发回退，
   * 仍不把旧入口放回模型请求。
   */
  toolExposureMode?: ToolExposureMode
  clock?: { now(): number }
}

export interface CycleResult {
  outcome: TurnOutcome
}

/**
 * Core 运行时（PLAN.md §2）。Electron-free。
 *
 * 单消费者：同一时刻只跑一个模型轮/工具轮；事件在轮次边界进入。
 * 相位只驱动表现与诊断，不承载语义。
 */
export class Core implements CoreApi {
  readonly config: AppConfig
  private activeSession: Session
  private readonly userSession: Session
  readonly conversationRuntime: ConversationRuntime
  private readonly unsubscribeTopic: () => void
  get session(): Session { return this.activeSession }
  readonly events: EventStore
  readonly state: StateStore
  readonly gate: ApprovalGate
  readonly bus: WakeBus
  readonly registry: ToolRegistry
  readonly persona: Persona
  readonly worlds: World[]
  readonly timers: TimerApi
  readonly logger: Logger
  /** 完整聊天与快捷聊天共享的工具执行器（风险/审批/预算/审计只有一份）。 */
  readonly executor: ToolExecutor
  /** 完整聊天自己的工具暴露状态；快捷聊天有独立实例，绝不共享组状态。 */
  readonly toolExposure: ToolExposureController
  /** CoreApi.log 的别名；Persona 通过它写日志。 */
  readonly log: Logger
  private readonly wakeGovernor: WakeGovernor
  private readonly timersImpl: Timers
  private readonly provider: ModelProvider | null
  private readonly usage: UsageTracker
  private readonly audit: AuditLog
  private readonly clock: { now(): number }
  private readonly episodeContext: ((episodeId: string) => string | null) | null
  private readonly onWakeDecision:
    | ((decision: WakeDecision, input: EventInput) => void)
    | null
  private readonly onProviderFailure:
    | ((notice: ProviderFailureNotice) => void)
    | null
  private readonly onTurnReport: ((report: TurnReport) => void) | null
  private readonly conversationHandoff: (() => string | null) | null
  private readonly sharedActivityContext: (() => string | null) | null
  private readonly taps: OutputTap[] = []
  private readonly phaseListeners = new Set<(state: RunPhaseState) => void>()
  private readonly worldHosts = new Map<string, WorldHost>()
  private readonly mainDecl: SessionDecl | null
  /** 启动时对已注册工具做一次只读契约审计；不是第二套注册表。 */
  private toolContract: ToolContractReport = { tools: [], issues: [] }

  private started = false
  private stopped = false
  private running = false
  private pumpScheduled = false
  private phaseState: RunPhaseState
  private cycleAbort: AbortController | null = null
  /** 工具轮的中止信号；只属于完整聊天，不影响快捷聊天。 */
  private cycleSignal: AbortController | null = null
  private interrupted = false
  private externalized = false
  /** 本轮是否产生了用户可见输出（正文或最终工具调用）；只用于状态条是否宣告完成。 */
  private turnHadOutput = false
  /** 本轮是否已经外显过回复正文；失败时用来区分“完全没开始”和“说到一半”。 */
  private turnHadReplyText = false
  /** 本轮包含网页事件或调用过 page_current：正文/发言参数只写占位。 */
  private pageDerivedCycle = false
  /** 本轮是否由用户消息触发。 */
  private hasUserMessageCycle = false
  /** 本轮是否由自主调度/感知/定时器触发；纯主动轮的 assistant 正文不落会话。 */
  private proactiveCycle = false
  /** 每次批次唯一的 turnId；状态、聊天提示与诊断靠它关联到同一次失败。 */
  private turnId = ''
  private turnSeq = 0
  /** 每次逻辑模型请求唯一；物理重试共享同一个 requestId。 */
  private requestSeq = 0
  /** 本轮已成功完成的工具名（不含参数）；失败时用来如实描述“做到了哪一步”。 */
  private turnCompleted: string[] = []
  /** 本轮最后一个未恢复的 Provider 失败；后续成功不会保留它。 */
  private turnProviderFailure: ProviderFailureNotice | null = null
  /** 本轮最后一个工具失败；之后有工具成功就清除，避免把已恢复的步骤当成失败。 */
  private turnToolFailure: { tool: string; code: string } | null = null
  /** 用户停止的真实原因；不能用笼统的“这次没成功”覆盖。 */
  private interruptReason: string | null = null
  /** 同一来源、同一故障指纹的连续失败链；只用于合并提示与计数。 */
  private failureChain: {
    source: ToolSource
    failure: TurnFailure
    count: number
    firstAt: number
    lastAt: number
  } | null = null
  private pendingUserCursors: number[] = []
  private wakeKickTimer: NodeJS.Timeout | null = null
  private pendingAllowlist: string[] | null = null
  private handoffRequested = false
  /** turn 级单调轮数；交接/压缩不会把它归零，保证硬上限覆盖整个 turn。 */
  private turnRoundCount = 0
  /** 最近一次请求级预算估算；只用于诊断与 usage 校准。 */
  private lastRequestBudget:
    | (RequestBudgetEstimate & {
        capacity: number
        over: boolean
        requestId: string
        turnId: string
      })
    | null = null
  /** 最近一次请求的上下文分段规模；只含 id/字符数/token，不含原文。 */
  private lastContextSegments: ContextSegmentUsage[] = []
  /** 最近一次构建系统提示时的分段；请求装配用它避免把整段 system 当一个黑盒。 */
  private systemSegmentCache: PrefixSegment[] = []
  /** 真实 usage / 估算的平滑系数；只放大预算，不用于计费。 */
  private readonly budgetCalibrator: BudgetCalibrator
  private get budgetCalibration(): number {
    return this.budgetCalibrator.factor(this.config.provider.baseUrl + '/' + this.config.provider.model)
  }
  /** 当前任务的短期状态；跨压缩保留，只驻内存。 */
  private workState = new TurnWorkState()
  private readonly workStates = new Map<string, TurnWorkState>()
  private environmentDirty = false
  private softWarned = false
  private idleNotified = true
  private currentEvents: EventEnvelope[] = []
  private cycleRetries = 0
  /**
   * 工具配对修复失败后的模型链暂停标记。fingerprint 命中时不再发送同一个
   * 结构必然 400 的请求；会话结构变化（交接/清理）后自动解除。
   */
  private protocolBlock: { fingerprint: string; reason: string; at: number } | null = null
  private runningTools: string[] = []
  private readonly taskHooks: TaskRuntimeHooks | null
  /** 本轮绑定的任务；只有 task.kick 单独触发时才设置。 */
  private cycleTask: { taskId: string; generation: number; title?: string } | null = null
  /** 本轮任务声明的能力；只用于预载工具组，不代表授权。 */
  private cycleTaskCapabilities: string[] = []
  /** 宿主可信预载；在下一次 beginCycle 消费，绝不中途替换本轮 schema。 */
  private pendingToolGroups = new Set<ToolGroupId>()
  /** 本轮已消费的宿主预载；若本回合没有发出任何模型请求，需要放回待消费。 */
  private cyclePreloadedGroups: ToolGroupId[] = []
  /** 最近一次模型请求的固定暴露快照；工具轮只能用它执行。 */
  private activeExposure: ToolRequestExposure | null = null
  /** 系统提示构建时的暴露 revision；组变化后下一次请求前重建。 */
  private promptExposureRevision = -1
  private cycleSource: ToolSource = 'user-chat'
  /** 用户消息与任务唤醒同批时，任务推迟到本轮之后。 */
  private deferredTaskKicks: Array<{
    taskId: string
    generation: number
    text: string
    taskTitle?: string
    taskCapabilities?: string[]
  }> = []
  private idleWaiters: Array<() => void> = []
  private openingReason: 'new' | 'restarted' | 'cleared' = 'new'
  private clearRequested = false

  constructor(options: CoreOptions) {
    this.budgetCalibrator = options.budgetCalibrator ?? new BudgetCalibrator()
    this.config = options.config
    this.activeSession = this.userSession = options.session
    this.conversationRuntime = options.conversationRuntime ?? new ConversationRuntime(options.session)
    this.unsubscribeTopic = this.conversationRuntime.onClear(() => { this.workStates.clear(); this.workState.reset(); this.promptExposureRevision = -1; if (this.running && this.activeSession === this.userSession) { this.clearRequested = true; this.interrupt('user-clear') } })
    this.events = options.eventStore
    this.state = options.state
    this.gate = options.approvalGate
    this.persona = options.persona
    this.worlds = options.worlds
    this.logger = options.logger
    this.log = options.logger
    this.provider = options.provider
    this.usage = options.usage
    this.audit = options.audit
    this.clock = options.clock ?? { now: () => Date.now() }
    this.episodeContext = options.episodeContext ?? null
    this.onWakeDecision = options.onWakeDecision ?? null
    this.onProviderFailure = options.onProviderFailure ?? null
    this.onTurnReport = options.onTurnReport ?? null
    this.conversationHandoff = options.conversationHandoff ?? null
    this.sharedActivityContext = options.sharedActivityContext ?? null
    this.taskHooks = options.taskHooks ?? null
    this.registry = new ToolRegistry(options.logger)
    this.toolExposure = new ToolExposureController({
      ...(options.toolExposureMode === undefined
        ? {}
        : { mode: options.toolExposureMode }),
      now: () => this.clock.now()
    })
    this.executor = new ToolExecutor({
      config: this.config,
      dataDir: options.dataDir,
      registry: this.registry,
      gate: this.gate,
      audit: this.audit,
      logger: options.logger,
      clock: this.clock,
      capabilities: options.capabilities,
      coordinator: options.coordinator ?? null,
      ...(this.taskHooks === null
        ? {}
        : {
            isTaskRunnable: (taskId: string, generation: number) =>
              this.taskHooks!.isCurrent(taskId, generation)
          }),
      ...(options.resolveCapabilityTargets === undefined
        ? {}
        : { resolveCapabilityTargets: options.resolveCapabilityTargets }),
      ...(options.onToolResult === undefined ? {} : { onToolResult: options.onToolResult })
    })
    const decls = options.persona.declareSessions()
    this.mainDecl = decls.find((decl) => decl.id === 'main') ?? decls[0] ?? null
    if (this.mainDecl !== null) this.session.setRounds(this.mainDecl.rounds())

    this.phaseState = {
      phase: 'idle',
      round: 0,
      running: [],
      enteredAt: this.clock.now(),
      approvalPending: false
    }

    this.timersImpl = new Timers(join(options.dataDir, 'timers.json'), (record) => this.onTimerDue(record), options.logger)
    this.timers = this.timersImpl

    this.bus = new WakeBus({
      batching: options.config.batching,
      clock: this.clock,
      onReady: () => this.schedulePump()
    })

    this.wakeGovernor = new WakeGovernor({
      getConfig: () => this.config,
      isBusy: () => this.isBusy(),
      isPaused: () => this.isPaused(),
      state: options.state,
      clock: this.clock
    })

    this.gate.onRequest((request) => {
      this.logger.info('等待审批', { tool: request.toolName, risk: request.risk })
      this.setApprovalPending(this.gate.pendingCountFor('chat') > 0)
    })
    this.gate.onResolved((request, decision) => {
      this.pushEvent({
        type: 'system.approval_resolved',
        source: 'core',
        origin: 'internal',
        text: `${request.toolName}: ${decision.approved ? 'approved' : 'denied'}`,
        deliver: false,
        trigger: 'piggyback'
      })
      for (const cursor of this.pendingUserCursors.splice(0)) this.bus.promote(cursor)
      this.kickWake()
      // 若此时仍停在 tools 相位，让表现层知道审批已清空
      if (this.phaseState.approvalPending) this.setPhase(this.phaseState.phase)
    })
    this.gate.onPendingChange(() => {
      if (this.gate.pendingCountFor('chat') === 0 && this.phaseState.approvalPending) {
        this.setApprovalPending(false)
      }
    })
  }

  // ------------------------------------------------------------------ 生命周期

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.session.hardTokens = this.hardTokens()

    // 1) Persona 先拿到 CoreApi（心跳在 onOpening 里才启动）
    this.persona.attach(this)

    // 2) World 逐个启动；单个失败只标记不可用
    for (const world of this.worlds) {
      try {
        const host = this.makeWorldHost(world)
        await world.start(host)
        world.available = true
        this.worldHosts.set(world.id, host)
        const tap = world.outputTap?.()
        if (tap !== undefined) this.taps.push(tap)
        this.logger.info('World 已启动', { world: world.id })
      } catch (error) {
        world.available = false
        world.unavailableReason = error instanceof Error ? error.message : String(error)
        this.logger.error('World 启动失败，已隔离', { world: world.id, error: world.unavailableReason })
      }
    }

    // 3) 工具注册（启动成功的 World + Persona）
    const conflicts: Array<{ name: string; first: string; second: string }> = []
    if (this.mainDecl !== null) {
      conflicts.push(...this.registry.register(`persona:${this.persona.constructor.name}`, this.mainDecl.tools()))
    }
    for (const world of this.worlds) {
      if (world.available !== true) continue
      conflicts.push(...this.registry.register(`world:${world.id}`, world.tools()))
      this.validateDescribe(world)
    }
    if (conflicts.length > 0) {
      throw new Error(
        `工具名冲突，拒绝启动：${conflicts.map((item) => `${item.name}（${item.first} vs ${item.second}）`).join('，')}`
      )
    }
    // 契约审计只读现有注册表/组/元数据；未启动的 World 不会被误判为缺失。
    this.toolContract = auditToolContracts(this.registry.list())
    for (const issue of this.toolContract.issues) {
      this.logger.warn('工具契约不一致', {
        code: issue.code,
        tool: issue.tool,
        detail: issue.detail
      })
    }

    // 4) 系统提示 + 会话恢复
    if (this.session.records.length === 0) {
      const load = this.session.load()
      for (const warning of load.warnings) this.logger.warn(warning)
    }
    const hadConversation = this.session.records.some((record) => record.kind !== 'system')
    await this.rebuildSystemPrompt()
    this.openingReason = this.openingReason === 'cleared' ? 'cleared' : hadConversation ? 'restarted' : 'new'
    this.persona.onOpening?.({ reason: this.openingReason })

    // 5) 定时器
    this.timersImpl.start()

    // 6) 重启恢复：只补投外部持久事件
    try {
      const replay = this.events.replaySince()
      for (const event of replay) this.bus.push(event, 'flush')
      if (replay.length > 0) this.logger.info('恢复未投递事件', { count: replay.length })
    } catch (error) {
      this.logger.error('事件库恢复失败，未补投历史事件', { error: String(error) })
    }

    this.started = true
    this.schedulePump()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.unsubscribeTopic()
    this.interrupt('shutdown')
    if (this.wakeKickTimer !== null) {
      clearTimeout(this.wakeKickTimer)
      this.wakeKickTimer = null
    }
    this.timersImpl.stop()
    for (const world of this.worlds) {
      try {
        await world.stop()
      } catch (error) {
        this.logger.warn('World 停止失败', { world: world.id, error: String(error) })
      }
    }
    this.state.flush()
  }

  /**
   * 清空主会话上下文。若正在流式输出，先中断，等本轮收尾后再删除记录，
   * 避免已开始的一轮把旧上下文重新写回会话。
   */
  clearConversation(): void {
    this.openingReason = 'cleared'
    this.conversationRuntime.clear()
    this.gate.rejectByOrigin('quick', '对话已清空')
    this.bus.clear()
    this.pendingUserCursors = []
    this.handoffRequested = false
    // 只取消完整聊天的审批；快捷聊天自己的请求不受影响。
    this.gate.rejectByOrigin('chat', '对话已清空，审批已取消')
    if (!this.running) {
      this.applyClearConversation()
      return
    }
    this.clearRequested = true
    this.interrupt('user-clear')
  }

  /** 兼容旧调用名；现在会真正清空会话，而不只是设置开场原因。 */
  markCleared(): void {
    this.clearConversation()
  }

  private applyClearConversation(): void {
    this.clearRequested = false
    this.session.replaceAll([])
    this.session.resetRounds()
    this.workState.reset()
    this.workStates.clear()
    this.softWarned = false
    this.environmentDirty = true
    this.schedulePump()
  }

  // ------------------------------------------------------------------ CoreApi

  injectInternal(
    text: string,
    kind: string,
    opts: {
      attention?: EventEnvelope['attention']
      meta?: Record<string, unknown>
      trigger?: TriggerMode
    } = {}
  ): void {
    this.pushEvent({
      type: `system.${kind}`,
      source: 'persona',
      origin: 'internal',
      text,
      ...(opts.attention === undefined ? {} : { attention: opts.attention }),
      ...(opts.meta === undefined ? {} : { meta: opts.meta }),
      ...(opts.trigger === undefined ? { trigger: 'flush' as const } : { trigger: opts.trigger })
    })
  }

  /**
   * 自主/陪伴唤醒的唯一入口：由 WakeGovernor 按 kind 独立评估预算、安静与忙碌。
   * 不合格时不入队，把 defer 时间交还调用方，避免每个调度周期堆一条事件。
   */
  injectWake(
    text: string,
    wakeKind: WakeKind,
    opts: { meta?: Record<string, unknown> } = {}
  ): WakeDecision {
    const type =
      wakeKind === 'companion'
        ? 'system.companion_chat'
        : wakeKind === 'reaction'
          ? 'system.reaction'
          : 'system.autonomy'
    const input: EventInput = {
      type,
      source: 'persona',
      origin: 'internal',
      text,
      attention: 'wake',
      meta: { ...(opts.meta ?? {}), wakeKind }
    }
    const decision = this.wakeGovernor.decisionFor(input, this.clock.now())
    this.reportWakeDecision(decision, input)
    if (decision.mode !== 'flush') return decision
    // 决策已经消耗预算；显式 trigger 避免 pushEvent 再评估一次。
    this.pushEvent({ ...input, trigger: 'flush' })
    return decision
  }

  /**
   * 就绪诊断：只读查询某个 wake 通道现在是否可用、若不可用何时恢复。
   * 不消耗预算、不注入事件。
   */
  wakeDeferral(
    kind: WakeKind
  ): { at: number | null; reason: WakeDecisionReason | null } {
    return this.wakeGovernor.deferralFor(kind)
  }

  requestContextHandoff(): void {
    this.handoffRequested = true
    this.schedulePump()
  }

  /**
   * 配置热更新后重建系统提示（不裁剪对话）。在下一批投递前空闲时刻执行，
   * 避免在模型轮进行中替换 session 记录。
   */
  requestSystemPromptRefresh(): void {
    this.environmentDirty = true
    this.schedulePump()
  }

  /**
   * 宿主可信预载：只影响下一轮模型请求的 schema 可见性，不执行工具、
   * 不授予权限。中途调用会等到下一次 beginCycle，避免同一响应内换 schema。
   */
  preloadToolGroups(groups: string[], reason: string): void {
    let added = 0
    for (const group of groups) {
      if (!isToolGroupId(group)) continue
      if (this.pendingToolGroups.has(group)) continue
      this.pendingToolGroups.add(group)
      added += 1
    }
    if (added > 0) {
      this.logger.info('工具组已预载到下一轮', {
        groups: [...this.pendingToolGroups],
        reason: reason.slice(0, 80)
      })
    }
  }

  async spawnFork(opts: ForkOptions): Promise<{ text: string; usage?: Usage }> {
    if (this.provider === null) throw new Error('没有可用的模型 Provider')
    const model = opts.model ?? this.config.provider.utilityModel
    const controller = new AbortController()
    const external = opts.signal
    const onAbort = (): void => controller.abort()
    if (external !== undefined) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', onAbort, { once: true })
    }
    let text = ''
    let usage: Usage | undefined
    try {
      // fork 通常没有工具，但摘要/整理提示可能复用带工具的历史消息；
      // 与主聊天共用同一道协议闸门。
      const prepared = prepareMessagesForProvider(opts.messages, {
        source: `fork:${opts.purpose}`,
        logger: this.logger
      })
      const stream = this.conversationRuntime.engine.stream(this.provider!,
        {
          model,
          messages: prepared.messages,
          maxTokens: opts.maxTokens ?? 1024,
          thinking: false
        },
        controller.signal
      )
      for await (const event of stream) {
        if (event.type === 'text') text += event.text
        else if (event.type === 'usage') {
          usage = event.usage
          this.usage.record(model, `fork:${opts.purpose}`, event.usage)
        }
      }
    } finally {
      external?.removeEventListener('abort', onAbort)
    }
    return usage === undefined ? { text } : { text, usage }
  }

  sessionInfo(id: string): SessionInfo {
    const info = this.session.info()
    return id === this.session.id ? info : { ...info, id }
  }

  isBusy(): boolean {
    return this.running || this.gate.pendingCountFor('chat') > 0 || this.phaseState.phase !== 'idle'
  }

  /** 当前批是否由用户消息触发；后台任务/自主轮不算。 */
  isUserTurnActive(): boolean {
    return this.hasUserMessageCycle
  }

  isPaused(): boolean {
    return this.bus.paused
  }

  /** 当前/最近一轮是否含网页或屏幕等不可信内容；供持久化边界判断。 */
  isPageDerived(): boolean {
    return this.pageDerivedCycle
  }

  /**
   * 当前或最近一轮的稳定 ID。空闲时仍返回上一轮 ID，调用方应先看
   * `isBusy()`；停止浏览用它标记“停止时已经在途的回合”。
   */
  currentTurnId(): string {
    return this.turnId
  }

  /** 任务被取消/暂停/接管时中止当前轮；只影响完整聊天循环。 */
  abortTaskCycle(reason = 'task-stopped'): void {
    if (this.cycleTask === null) return
    this.interrupt(reason)
  }

  setTurnToolAllowlist(names: string[] | null): void {
    this.pendingAllowlist = names === null ? null : [...names]
  }

  pause(reason = 'manual'): void {
    if (this.bus.paused) return
    this.bus.pause()
    this.state.set('paused', true)
    this.logger.info('总线已暂停', { reason })
  }

  resume(): void {
    if (!this.bus.paused) return
    this.bus.resume()
    this.state.set('paused', false)
    this.bus.promote(Number.MAX_SAFE_INTEGER)
    this.logger.info('总线已恢复')
    this.kickWake()
    this.schedulePump()
  }

  // ------------------------------------------------------------------ 事件入口

  private reportWakeDecision(decision: WakeDecision, input: EventInput): void {
    if (this.onWakeDecision === null) return
    try {
      this.onWakeDecision(decision, input)
    } catch (error) {
      this.logger.warn('唤醒决策回调异常', { error: String(error).slice(0, 200) })
    }
  }

  pushEvent(rawInput: EventInput): EventEnvelope {
    const input: EventInput =
      rawInput.type === 'chat.stop'
        ? { ...rawInput, deliver: false, persist: false }
        : rawInput
    if (input.type === 'chat.user_message') this.wakeGovernor.noteUserMessage(this.clock.now())
    // attention 事件只在这里评估一次：符合条件才消耗一次自主唤醒预算。
    const wakeDecision =
      input.trigger === undefined && input.attention !== undefined
        ? this.wakeGovernor.decisionFor(input, this.clock.now())
        : null
    if (wakeDecision !== null) this.reportWakeDecision(wakeDecision, input)
    const env = this.events.push(input, this.clock.now())
    const mode = this.modeFor(input, wakeDecision)
    const busy = this.isBusy()

    if (busy) {
      if (mode === 'interrupt') {
        this.interrupt('user-interrupt')
      } else if (mode === 'preempt') {
        if (this.externalized) {
          // 已经有外部输出：不丢弃，按 flush 排队
          this.bus.push(env, 'flush')
          return env
        }
        this.interrupt('preempt')
      }
    }

    if (input.type === 'chat.user_message' && this.gate.pendingCountFor('chat') > 0) {
      this.pendingUserCursors.push(env.cursor)
    }

    this.bus.push(env, mode)
    if (
      wakeDecision !== null &&
      input.attention === 'wake' &&
      wakeDecision.mode === 'piggyback'
    ) {
      this.scheduleWakeKick(wakeDecision.deferredAt)
    }
    return env
  }

  private modeFor(input: EventInput, wakeDecision: ReturnType<WakeGovernor['decisionFor']> | null): TriggerMode {
    if (input.trigger !== undefined) return input.trigger
    if (wakeDecision !== null) return wakeDecision.mode
    switch (input.type) {
      case 'chat.user_message':
        if (this.gate.pendingCountFor('chat') > 0) return 'piggyback'
        return this.isBusy() ? 'interrupt' : 'flush'
      case 'chat.stop':
        return 'interrupt'
      case 'system.approval_resolved':
      case 'world.status':
        return 'piggyback'
      case 'timer.due':
        return 'flush'
      default:
        if (input.type.startsWith('activity.')) return 'debounce'
        return 'flush'
    }
  }

  /**
   * 把排队中的自主唤醒提升为 flush。只在存在 attention === 'wake' 的
   * piggyback 事件时调用，避免空耗预算。
   */
  kickWake(): void {
    if (this.wakeKickTimer !== null) {
      clearTimeout(this.wakeKickTimer)
      this.wakeKickTimer = null
    }
    if (!this.started || this.stopped) return
    const now = this.clock.now()
    // 旧评论一旦过期就不再排队补说；在提升前先清掉。
    this.bus.discardExpired(now)
    const queued = this.bus.peek()
    // 任务唤醒优先于普通自主唤醒，且不消耗自主/陪伴/反应预算。
    if (queued.some((entry) => entry.env.type === 'task.kick')) {
      if (this.wakeGovernor.tryPromoteTask(now)) {
        this.bus.promoteMatching((entry) => entry.env.type === 'task.kick')
        return
      }
    }
    const isKind = (entry: (typeof queued)[number], kind: WakeKind): boolean =>
      entry.mode === 'piggyback' &&
      entry.env.attention === 'wake' &&
      entry.env.meta?.['wakeKind'] === kind
    const hasReaction = queued.some((entry) => isKind(entry, 'reaction'))
    const hasCompanion = queued.some((entry) => isKind(entry, 'companion'))
    const hasAutonomy = queued.some(
      (entry) =>
        entry.mode === 'piggyback' &&
        entry.env.attention === 'wake' &&
        entry.env.meta?.['wakeKind'] !== 'companion' &&
        entry.env.meta?.['wakeKind'] !== 'reaction'
    )
    if (!hasReaction && !hasCompanion && !hasAutonomy) return
    let promoted = false
    // 事件反馈最讲时效，优先于闲聊与探索；预算彼此独立。
    if (hasReaction && this.wakeGovernor.tryPromoteReaction(now)) {
      this.bus.promoteMatching((entry) => isKind(entry, 'reaction'))
      promoted = true
    }
    if (!promoted && hasCompanion && this.wakeGovernor.tryPromoteCompanion(now)) {
      this.bus.promoteMatching((entry) => isKind(entry, 'companion'))
      promoted = true
    }
    if (!promoted && hasAutonomy && this.wakeGovernor.tryPromote(now)) {
      this.bus.promoteMatching(
        (entry) =>
          entry.env.attention === 'wake' &&
          entry.env.meta?.['wakeKind'] !== 'companion' &&
          entry.env.meta?.['wakeKind'] !== 'reaction'
      )
      promoted = true
    }
    if (promoted) return
    const autonomyAt = this.wakeGovernor.nextDeferredAtFor('autonomy', now)
    const companionAt = this.wakeGovernor.nextDeferredAtFor('companion', now)
    const reactionAt = this.wakeGovernor.nextDeferredAtFor('reaction', now)
    const next = [autonomyAt, companionAt, reactionAt].filter(
      (at): at is number => at !== null
    )
    this.scheduleWakeKick(next.length === 0 ? null : Math.min(...next))
  }

  /**
   * 用户已经切换到别的活动时，取消排队中的旧反应评论。
   * 保留 keepTargetRef 相同的事件；传 null 表示全部取消。
   */
  cancelReactionEvents(keepTargetRef: string | null): number {
    return this.bus.discardMatching((entry) => {
      if (entry.env.meta?.['wakeKind'] !== 'reaction') return false
      if (keepTargetRef === null) return true
      return entry.env.meta?.['targetRef'] !== keepTargetRef
    })
  }

  private scheduleWakeKick(at: number | null): void {
    if (at === null || !this.started || this.stopped) return
    if (this.wakeKickTimer !== null) {
      clearTimeout(this.wakeKickTimer)
      this.wakeKickTimer = null
    }
    // 分片等待：系统睡眠/长时间安静后也能重新评估，而不是依赖一个超长定时器。
    const delay = Math.max(0, Math.min(at - this.clock.now(), 30 * 60_000))
    this.wakeKickTimer = setTimeout(() => {
      this.wakeKickTimer = null
      this.kickWake()
    }, delay)
    this.wakeKickTimer.unref?.()
  }

  /** 快捷聊天/触摸等不进 chat.user_message 的用户活动：重置主动聊天冷却。 */
  noteUserActivity(now = this.clock.now()): void {
    this.wakeGovernor.noteUserMessage(now)
  }

  /** 当前是否处于用户要求的安静时段（只影响主动开口）。 */
  isSpeechQuiet(now = this.clock.now()): boolean {
    return this.wakeGovernor.speechQuietUntilAt > now
  }

  /** pet_quiet：在 until 之前不发起新的主动聊天；探索与任务不受影响。 */
  setSpeechQuietUntil(until: number | null): void {
    this.wakeGovernor.setSpeechQuietUntil(until, this.clock.now())
    const quiet = this.wakeGovernor.speechQuietUntilAt
    if (quiet > 0) {
      this.scheduleWakeKick(quiet)
      return
    }
    this.kickWake()
  }

  /** 清空自主唤醒计数与待提升定时器（清空本地数据时调用）。 */
  clearAutonomyState(): void {
    if (this.wakeKickTimer !== null) {
      clearTimeout(this.wakeKickTimer)
      this.wakeKickTimer = null
    }
    this.wakeGovernor.clear()
  }

  // ------------------------------------------------------------------ 主循环

  private schedulePump(delay = 0): void {
    if (!this.started || this.stopped || this.pumpScheduled || this.running) return
    this.pumpScheduled = true
    const handle = setTimeout(() => {
      this.pumpScheduled = false
      void this.pump()
    }, delay)
    handle.unref?.()
  }

  private async pump(): Promise<void> {
    if (!this.started || this.stopped || this.running) return
    if (this.bus.paused) return

    // 配置热更新：先按新 World/模型信息刷新系统提示，再投递排队事件。
    if (this.environmentDirty) {
      this.environmentDirty = false
      try {
        await this.rebuildSystemPrompt()
        this.logger.info('系统提示已按新配置刷新')
      } catch (error) {
        this.logger.error('系统提示刷新失败', { error: String(error) })
      }
    }

    // 只在完全空闲时整理上下文，避免打断正在排队的一批事件
    if (this.handoffRequested && this.bus.size === 0) {
      this.handoffRequested = false
      try {
        await this.handoff()
      } catch (error) {
        this.logger.error('上下文交接失败', { error: String(error) })
      }
      this.schedulePump()
      return
    }

    const batch = this.bus.takeBatch()
    if (batch === null) {
      if (this.bus.size === 0) this.notifyIdle()
      return
    }

    this.running = true
    const lease = batch.events.some(event => event.type === 'chat.user_message' && event.deliver !== false) ? await this.conversationRuntime.acquire() : null
    try {
      if (lease && !this.conversationRuntime.current(lease.generation)) return
      await this.runCycle(batch.events)
    } catch (error) {
      this.logger.error('模型轮异常', { error: error instanceof Error ? error.message : String(error) })
      try {
        // 仍走统一的结束路径：结构化结果、故障合并与清理都不会因异常被跳过。
        this.finishCycle('failed', false)
      } catch (finishError) {
        this.logger.error('异常轮结束后处理失败', { error: String(finishError) })
        this.emitTap({ type: 'turn_end', outcome: 'failed', report: this.buildTurnReport('failed') })
        this.setPhase('idle')
      }
    } finally {
      this.activeSession = this.userSession
      lease?.release()
      this.running = false
      this.cycleAbort = null
      this.cycleSignal = null
      this.runningTools = []
      this.cycleTask = null
      this.cycleTaskCapabilities = []
      // 用户轮标志只描述“当前批”；结束后必须复位，否则空闲期到达的主动
      // 候选会被一直当作“用户正在说话”而错误推迟。
      this.hasUserMessageCycle = false
      this.activeExposure = null
      // 被用户消息挤到下一轮的任务，在本轮完全结束后重新注入。
      for (const kick of this.deferredTaskKicks.splice(0)) {
        this.pushEvent({
          type: 'task.kick',
          source: 'task',
          origin: 'internal',
          text: kick.text,
          attention: 'wake',
          persist: false,
          ephemeral: true,
          meta: {
            taskId: kick.taskId,
            taskGeneration: kick.generation,
            ...(kick.taskTitle === undefined ? {} : { taskTitle: kick.taskTitle }),
            ...(kick.taskCapabilities === undefined
              ? {}
              : { taskCapabilities: kick.taskCapabilities })
          }
        })
      }
      if (this.clearRequested) this.applyClearConversation()
      // 轮次已结束：此时 isBusy() 才是可靠的 false，再提升忙碌期间积压的自主唤醒。
      this.kickWake()
      this.schedulePump()
    }
  }

  /** 每个批次重置一次失败上下文；重复计数只跨批次保留。 */
  private beginTurn(): void {
    this.turnSeq += 1
    this.turnId = `turn-${this.clock.now().toString(36)}-${this.turnSeq.toString(36)}`
    // session.roundCount 仍用于会话/压缩诊断，但 turn 的强制上限必须独立，
    // 否则同一 turn 内交接后可以从零开始，变相放大轮数预算。
    this.turnRoundCount = 0
    this.turnCompleted = []
    this.turnProviderFailure = null
    this.turnToolFailure = null
    this.interruptReason = null
    this.turnHadReplyText = false
  }

  private async runCycle(events: EventEnvelope[]): Promise<void> {
    this.beginTurn()
    this.interrupted = false
    this.externalized = false
    this.turnHadOutput = false
    this.cycleSignal = new AbortController()
    this.deferredTaskKicks = []
    this.pageDerivedCycle = events.some(
      (event) => event.type.startsWith('browser.page_') && event.deliver !== false
    )
    this.hasUserMessageCycle = events.some(
      (event) => event.type === 'chat.user_message' && event.deliver !== false
    )

    // task.kick 单独成轮：同一时刻只有一个任务；用户消息优先，任务推迟。
    const taskEvents = events.filter(
      (event) =>
        event.type === 'task.kick' &&
        event.deliver !== false &&
        typeof event.meta?.['taskId'] === 'string' &&
        typeof event.meta?.['taskGeneration'] === 'number'
    )
    this.cycleTask = null
    this.cycleTaskCapabilities = []
    const suppressedTasks = new Set<number>()
    for (const event of taskEvents) {
      const taskId = event.meta!['taskId'] as string
      const generation = event.meta!['taskGeneration'] as number
      const deferredTitle =
        typeof event.meta?.['taskTitle'] === 'string'
          ? (event.meta['taskTitle'] as string)
          : undefined
      const taskCapabilities = capabilityList(event.meta?.['taskCapabilities'])
      if (this.hasUserMessageCycle || this.cycleTask !== null) {
        suppressedTasks.add(event.cursor)
        this.deferredTaskKicks.push({
          taskId,
          generation,
          text: event.text,
          ...(deferredTitle === undefined ? {} : { taskTitle: deferredTitle }),
          ...(taskCapabilities.length === 0 ? {} : { taskCapabilities })
        })
        continue
      }
      if (
        this.taskHooks === null ||
        !this.taskHooks.canRun(taskId, generation, this.clock.now())
      ) {
        suppressedTasks.add(event.cursor)
        continue
      }
      const title =
        typeof event.meta?.['taskTitle'] === 'string'
          ? (event.meta['taskTitle'] as string)
          : undefined
      this.cycleTask = {
        taskId,
        generation,
        ...(title === undefined ? {} : { title })
      }
      this.cycleTaskCapabilities = taskCapabilities
    }
    if (this.cycleTask !== null) {
      this.taskHooks?.onCycleStarted({
        taskId: this.cycleTask.taskId,
        generation: this.cycleTask.generation,
        now: this.clock.now()
      })
    }
    this.cycleSource =
      this.cycleTask !== null ? 'task' : this.hasUserMessageCycle ? 'user-chat' : 'autonomy'
    this.activeSession = this.hasUserMessageCycle ? this.userSession : this.conversationRuntime.background(this.cycleTask ? `task:${this.cycleTask.taskId}` : events.some(event => event.type === 'system.reaction') ? 'reaction' : 'autonomy')
    this.promptExposureRevision = -1
    const workScope = this.cycleTask !== null
      ? `task:${this.cycleTask.taskId}`
      : this.hasUserMessageCycle ? 'user' : 'background'
    this.workState = this.hasUserMessageCycle ? this.conversationRuntime.userWorkState : this.workStates.get(workScope) ?? new TurnWorkState()
    this.workStates.delete(workScope)
    this.workStates.set(workScope, this.workState)
    while (this.workStates.size > 32) this.workStates.delete(this.workStates.keys().next().value!)


    this.proactiveCycle =
      !this.hasUserMessageCycle &&
      events.some(
        (event) =>
          event.deliver !== false &&
          (event.type === 'system.autonomy' ||
            event.type === 'system.reaction' ||
            event.type === 'system.quiet_end' ||
            event.type === 'timer.due' ||
            event.type === 'task.kick' ||
            event.type.startsWith('activity.') ||
            event.type.startsWith('browser.'))
      )
    this.cycleRetries = 0
    this.idleNotified = false
    this.currentEvents = events
    this.activeExposure = null

    // 每个用户 turn / 任务轮/自主轮都重建基础组；tools_load 的增量只在
    // 本 turn 内有效。任务能力与宿主预载只影响可见性，不授予权限。
    const preloadedGroups = [...this.pendingToolGroups]
    this.pendingToolGroups.clear()
    this.cyclePreloadedGroups = preloadedGroups
    // 用户回合没有绑定 task.kick 时，仍保留可信未完成用户任务所需组；
    // 这只是可见性，执行时仍按用户入口的当前能力/审批逐次复验。
    const unfinishedTaskGroups =
      this.cycleTask === null && this.cycleSource === 'user-chat'
        ? (() => {
            const capabilities = (this.taskHooks?.unfinishedTaskCapabilities?.() ?? []) as CapabilityId[]
            return capabilities.length === 0
              ? []
              : [...groupsForCapabilities(capabilities), 'tasks' as ToolGroupId]
          })()
        : []
    this.toolExposure.beginCycle({
      turnId: this.turnId,
      source: this.cycleSource,
      ...(this.cycleTask === null
        ? {}
        : {
            taskId: this.cycleTask.taskId,
            taskGeneration: this.cycleTask.generation
          }),
      reaction: this.isReactionCycle(),
      preloadedGroups: [
        ...new Set([
          ...preloadedGroups,
          ...groupsForCapabilities(this.cycleTaskCapabilities as CapabilityId[]),
          ...unfinishedTaskGroups
        ])
      ]
    })
    this.phaseState.approvalPending = this.gate.pendingCountFor('chat') > 0
    this.emitTap({ type: 'batch_start', events, proactive: this.proactiveCycle })

    const deliverable = events.filter(
      (event) => event.deliver !== false && !suppressedTasks.has(event.cursor)
    )
    if (deliverable.length === 0) {
      // 本轮没有发出任何模型请求，宿主预载（例如 B 站异步转写完成）不能
      // 随空批次丢掉；保留到下一个真正请求模型的回合再消费。
      for (const group of preloadedGroups) this.pendingToolGroups.add(group)
      this.cyclePreloadedGroups = []
      this.markSettled(events, 'discarded')
      this.finishCycle('done')
      return
    }

    this.setPhase('delivering')
    const delivered = await deliverBatch(deliverable, this.session, this.persona, this.logger)
    this.events.markDelivered(Math.max(...events.map((event) => event.cursor)))
    this.markSettled(delivered.delivered, 'delivered')
    // 主动开场的衔接说明只属于当前批：ephemeral system record 在下一批
    // 交接/清理时自然丢弃，绝不写进会话文件或事件库。
    const episodeText = this.takeEpisodeContext(deliverable)
    if (episodeText !== null) this.session.appendSystem(episodeText, true)
    // 用户目标进入内存工作状态；它不依赖 memory.enabled，也不写会话文件。
    const workNow = this.clock.now()
    for (const event of deliverable) {
      if (event.type === 'chat.user_message' && event.deliver !== false) {
        this.workState.noteUser(event.text, workNow)
      }
    }
    this.injectWorkState()

    // 主动批次与用户批次拥有同一套工具；是否需要审批由 RiskPolicy 决定。
    // pendingAllowlist 只保留给测试/显式窄化调用。
    const allowlist: string[] | null = this.pendingAllowlist
    if (this.pendingAllowlist !== null) this.pendingAllowlist = null

    this.session.resetRounds()
    this.softWarned = false

    const hardRounds = this.session.rounds.hard
    const softRounds = this.session.rounds.soft
    // 模型/工具轮次顺序由共享 TurnRunner 决定；Core 只提供会话、交接和
    // 工具执行适配。交接不会重置 turnRoundCount，也不会重置这个循环的轮数。
    const loopOutcome = await this.conversationRuntime.engine.run({
      hardRounds,
      softRounds,
      isStopped: () => this.interrupted,
      prepareRound: async (): Promise<TurnLoopPrepare> => {
        const capacity = this.hardTokens() ?? this.config.context.maxTokens
        const softLimit = capacity * this.config.context.softRatio
        if (this.session.estTokens() > softLimit) {
          if (!this.softWarned) {
            this.session.appendSystem('上下文接近上限，请在完成当前任务后准备交接。', true)
            this.softWarned = true
          } else {
            this.handoffRequested = true
          }
        }
        if (this.handoffRequested) {
          this.handoffRequested = false
          try {
            await this.handoff()
          } catch (error) {
            this.logger.error('上下文交接失败', { error: String(error) })
          }
          this.softWarned = false
        }
        this.session.roundCount += 1
        this.turnRoundCount += 1
        return 'continue'
      },
      modelRound: () => this.modelRound(allowlist),
      onNeedsHandoff: async () => {
        await this.handoff()
        this.softWarned = false
      },
      onBudgetExceeded: () => {
        // 已经尝试过交接仍然放不下：不再反复清历史后发送同一个超限请求。
        const note =
          '（这次请求仍然超过当前模型的上下文预算：必要的历史和工具说明放不进窗口。我先停在这里；可以清理会话、缩小任务或调低工具组后再试。）'
        this.emitTap({ type: 'text_delta', text: note })
        this.externalized = true
        this.turnHadOutput = true
        this.logger.warn('请求级预算不足，已停止发送', {
          requestId: this.lastRequestBudget?.requestId ?? null,
          turnId: this.turnId,
          source: this.cycleSource,
          estimate: this.lastRequestBudget?.total ?? null,
          capacity: this.lastRequestBudget?.capacity ?? null
        })
      },
      onSoftRound: () => {
        if (!this.softWarned) {
          this.session.appendSystem('轮数接近上限，请开始收尾。', true)
          this.softWarned = true
        }
      },
      onCapped: () => {
        const note = '（已达到本轮工具调用轮数上限，先停在这里。你可以继续让我做。）'
        this.emitTap({ type: 'text_delta', text: note })
        this.externalized = true
      },
      toolRound: async (calls) => {
        const result = await this.toolRound(calls, allowlist)
        return { endsTurn: result.endsTurn }
      }
    })
    const outcome: TurnOutcome =
      loopOutcome === 'done' ? 'done' : loopOutcome === 'capped' ? 'capped' : 'failed'

    this.finishCycle(outcome)
  }

  // ------------------------------------------------------------------ 模型轮

  /**
   * 当前批是否只是在回应外部变化（没有用户消息，也没有任务）。
   * 这类批通常只需一次 reaction 工具调用，时效目标远紧于聊天/任务；
   * 显式思考会明显拉长首个可见反馈的时延，因此单独关闭。
   */
  private isReactionCycle(): boolean {
    if (this.cycleSource !== 'autonomy') return false
    return this.currentEvents.some(
      (event) =>
        event.deliver !== false &&
        (event.type === 'system.reaction' || event.meta?.['wakeKind'] === 'reaction')
    )
  }

  /**
   * 本回合若在发出任何模型请求前就结束（未配置 Key、协议暂停、提示词刷新
   * 失败），宿主预载不能随失败路径丢失；放回待消费集合，下一回合再用。
   */
  private restoreCyclePreloadsIfNoRequest(): void {
    if (this.cyclePreloadedGroups.length === 0) return
    for (const group of this.cyclePreloadedGroups) this.pendingToolGroups.add(group)
    this.cyclePreloadedGroups = []
  }

  private async modelRound(allowlist: string[] | null): Promise<{
    toolCalls: Array<{ id: string; name: string; arguments: string }>
    failed: boolean
    needsHandoff: boolean
    /** 请求在发送前就超过整包预算；调用方决定是否已无法再交接。 */
    budgetExceeded?: boolean
  }> {
    this.setPhase('model')
    if (this.provider === null) {
      this.emitTap({ type: 'assistant_start' })
      const text = '（还没有配置 DeepSeek API Key。到设置 → 模型里填一个 Key 就能聊天了。）'
      this.recordProviderFailure(
        new ProviderError('还没有配置 DeepSeek API Key', {
          retryable: false,
          code: 'NO_API_KEY',
          category: 'config'
        }),
        'model-request'
      )
      this.emitTap({ type: 'text_delta', text })
      this.emitTap({ type: 'assistant_end', text, aborted: false })
      this.externalized = true
      this.turnHadOutput = true
      this.restoreCyclePreloadsIfNoRequest()
      return { toolCalls: [], failed: true, needsHandoff: false }
    }

    const blocked = this.protocolBlock
    if (blocked !== null) {
      if (blocked.fingerprint === this.session.protocolFingerprint()) {
        this.logger.error('模型请求已暂停：工具协议结构无法修复', {
          sessionId: this.session.id,
          turn: this.session.roundCount,
          source: this.cycleSource,
          fingerprint: blocked.fingerprint,
          reason: blocked.reason,
          since: blocked.at
        })
        this.recordProviderFailure(
          new ProviderError('会话里的工具调用记录无法自动修复，已暂停本次模型请求', {
            status: 400,
            retryable: false,
            code: 'PROTOCOL_BLOCKED',
            category: 'protocol'
          }),
          'model-request'
        )
        this.emitTap({ type: 'assistant_start' })
        const text = '（会话里的工具调用记录仍不完整，已暂停本次模型请求；可以清理会话或重启后再试。）'
        this.emitTap({ type: 'text_delta', text })
        this.emitTap({ type: 'assistant_end', text, aborted: false })
        this.externalized = true
        this.turnHadOutput = true
        this.restoreCyclePreloadsIfNoRequest()
        return { toolCalls: [], failed: true, needsHandoff: false }
      }
      this.protocolBlock = null
    }

    // tools_load 只改下一次请求；先刷新系统提示里的组目录，再固定本轮
    // schema 快照。刷新失败时不发送任何请求，避免工具列表与提示教不同版本。
    if (this.promptExposureRevision !== this.toolExposure.revision()) {
      try {
        await this.rebuildSystemPrompt()
      } catch (error) {
        this.logger.error('工具组变更后系统提示刷新失败，已取消本次模型请求', {
          error: String(error)
        })
        this.emitTap({ type: 'assistant_start' })
        const text = '（工具组说明刷新失败，本轮没有发送模型请求；请重试或重启后再试。）'
        this.emitTap({ type: 'text_delta', text })
        this.emitTap({ type: 'assistant_end', text, aborted: false })
        this.externalized = true
        this.turnHadOutput = true
        this.restoreCyclePreloadsIfNoRequest()
        return { toolCalls: [], failed: true, needsHandoff: false }
      }
    }
    this.requestSeq += 1
    const requestId = `req-${this.clock.now().toString(36)}-${this.requestSeq.toString(36)}`
    const prepared = this.toolExposure.prepareRequest({
      registry: this.registry,
      allowlist,
      requestId,
      turnId: this.turnId,
      source: this.cycleSource,
      ...(this.cycleTask === null
        ? {}
        : {
            taskId: this.cycleTask.taskId,
            taskGeneration: this.cycleTask.generation
          })
    })
    const tools = prepared.specs
    const capacity = this.requestCapacity()
    // 请求级预算：消息 + 工具 schema + 图片 + 输出预留 + 安全余量。
    // 覆盖 tools_load 后 schema 突然增大、单条超长工具回执和超大 system。
    const assembly = assembleContext({
      messages: this.buildMessages(),
      systemSegments: this.systemSegmentCache,
      tools,
      outputReserve: this.config.provider.maxOutputTokens,
      calibration: this.budgetCalibration,
      capacity,
      source: `chat:${this.cycleSource}`,
      logger: this.logger,
      sessionId: this.session.id
    })
    let messages = assembly.messages
    const budget = assembly.budget
    const overBudget = assembly.over
    this.lastContextSegments = assembly.segments
    this.lastRequestBudget = {
      ...budget,
      capacity,
      over: overBudget,
      requestId,
      turnId: this.turnId
    }
    if (overBudget) {
      this.logger.warn('请求超过上下文预算', {
        requestId,
        turnId: this.turnId,
        source: this.cycleSource,
        messages: messages.length,
        tools: tools.length,
        inputTokens: budget.inputTokens,
        toolTokens: budget.toolTokens,
        imageTokens: budget.imageTokens,
        outputReserve: budget.outputReserve,
        safetyMargin: budget.safetyMargin,
        total: budget.total,
        capacity,
        calibration: budget.calibration,
        segments: assembly.segments.map((segment) => ({
          id: segment.id,
          kind: segment.kind,
          chars: segment.chars,
          tokens: segment.tokens
        }))
      })
      this.restoreCyclePreloadsIfNoRequest()
      return { toolCalls: [], failed: false, needsHandoff: true, budgetExceeded: true }
    }
    this.activeExposure = this.toolExposure.handleFor(prepared.snapshot, this.registry)
    this.logger.info('工具暴露快照', {
      requestId,
      turnId: this.turnId,
      source: this.cycleSource,
      revision: prepared.snapshot.revision,
      tools: tools.length,
      schemaBytes: prepared.snapshot.schemaBytes,
      groupCatalogBytes: prepared.snapshot.groupCatalogBytes,
      groups: prepared.snapshot.groups.length
    })
    // 请求已经准备好并即将发出；预载已被这一轮消费，不再放回。
    this.cyclePreloadedGroups = []
    const model = this.config.provider.model
    const origin = this.provider.endpointOrigin?.() ?? 'unknown'
    const thinking = this.config.provider.thinking && !this.isReactionCycle()
    let text = ''
    const toolAccums = new Map<number, ToolCallAccum>()
    let aborted = false
    let streamFailed = false
    let needsHandoff = false
    /** 已使用的网络重试次数；上限 2。 */
    let attempt = 0
    let pairingRepairs = 0
    /** 物理请求序号（含配对重发）；每次请求独立编号。 */
    let physicalAttempts = 0

    this.emitTap({ type: 'assistant_start' })

    await this.conversationRuntime.engine.attempts(async () => {
      physicalAttempts += 1
      const controller = new AbortController()
      this.cycleAbort = controller
      const attemptStartedAt = this.clock.now()
      const trace: ProviderFailureTrace = {
        requestId,
        attempt: physicalAttempts,
        model,
        origin,
        startedAt: attemptStartedAt,
        headersAt: null,
        firstEventAt: null,
        headersReceived: false,
        sawModelEvent: false
      }
      let usage: Usage | undefined
      let retryable: ProviderError | null = null
      let pairingRetry = false
      streamFailed = false

      this.logger.info('模型请求开始', {
        requestId,
        turnId: this.turnId,
        attempt: physicalAttempts,
        source: this.cycleSource,
        model,
        origin,
        messages: messages.length,
        tools: tools.length,
        thinking
      })

      try {
        const stream = this.conversationRuntime.engine.stream(this.provider!,
          {
            model,
            messages,
            ...(tools.length === 0 ? {} : { tools }),
            maxTokens: this.config.provider.maxOutputTokens,
            thinking
          },
          controller.signal,
          {
            onResponseStarted: () => {
              if (trace.headersReceived) return
              trace.headersReceived = true
              trace.headersAt = this.clock.now()
            }
          }
        )
        for await (const event of stream) {
          if (this.interrupted) break
          if (!trace.sawModelEvent) {
            trace.sawModelEvent = true
            trace.firstEventAt = this.clock.now()
          }
          this.conversationRuntime.engine.dispatch(event, {
            onText: (delta) => {
              text += delta
              if (delta !== '') this.turnHadReplyText = true
              this.externalized = true
              this.emitTap({ type: 'text_delta', text: delta })
            },
            onReasoning: (delta) => {
              this.emitTap({ type: 'reasoning_delta', text: delta })
            },
            onToolCall: (call) => this.conversationRuntime.engine.accumulate(call, toolAccums, { onStart: (id, name) => { this.externalized = true; this.emitTap({ type: 'tool_call_start', id, name }) }, onArgs: (id, delta) => this.emitTap({ type: 'tool_call_args', id, delta }) }),
            onUsage: (value) => {
              usage = value
            }
          })
        }
      } catch (error) {
        if (this.interrupted || isAbortError(error)) {
          aborted = true
        } else {
          const providerError =
            error instanceof ProviderError
              ? error
              : providerErrorFromUnknown(error, {
                  transportPhase: trace.sawModelEvent ? 'stream' : 'unknown'
                })
          const stage = this.stageForProviderError(providerError, trace.sawModelEvent)
          if (
            providerError.status === 400 &&
            /context.*(length|too long)|maximum context|token.*exceed/i.test(providerError.message)
          ) {
            needsHandoff = true
            this.logger.info('上下文超出模型窗口，准备交接', {
              requestId,
              turnId: this.turnId,
              attempt: physicalAttempts,
              source: this.cycleSource,
              code: providerError.code
            })
          } else if (isToolPairingError(providerError)) {
            const report = inspectToolProtocol(messages)
            const beforeFingerprint = protocolMessageFingerprint(messages)
            const changed = this.session.repairPairing()
            const afterFingerprint = this.session.protocolFingerprint()
            this.logger.error('Provider 工具配对错误', {
              requestId,
              turnId: this.turnId,
              attempt: physicalAttempts,
              sessionId: this.session.id,
              turn: this.session.roundCount,
              source: this.cycleSource,
              stage: 'model-request',
              code: providerError.code,
              status: providerError.status,
              category: providerError.category,
              fingerprint: beforeFingerprint,
              afterFingerprint,
              repaired: changed,
              structure: protocolLogData(report)
            })
            // 只在结构确实发生变化时重发一次；同一个结构绝不重复发送。
            if (
              changed &&
              afterFingerprint !== beforeFingerprint &&
              pairingRepairs < 1 &&
              text === '' &&
              toolAccums.size === 0
            ) {
              pairingRepairs += 1
              pairingRetry = true
              this.logger.warn('工具配对已修复，重发一次模型请求', {
                requestId,
                turnId: this.turnId,
                attempt: physicalAttempts,
                nextAttempt: physicalAttempts + 1,
                sessionId: this.session.id,
                turn: this.session.roundCount,
                source: this.cycleSource,
                fingerprint: afterFingerprint
              })
            } else {
              streamFailed = true
              this.protocolBlock = {
                fingerprint: afterFingerprint,
                reason: '工具调用/回执结构无法自动修复',
                at: this.clock.now()
              }
              this.emitProviderError(
                new ProviderError(
                  '会话里的工具调用记录无法自动修复，已暂停本次模型请求',
                  {
                    status: 400,
                    retryable: false,
                    code: 'PROTOCOL_BLOCKED',
                    category: 'protocol'
                  }
                ),
                'model-request',
                trace,
                'protocol-blocked'
              )
            }
          } else {
            const retryBlock = this.retryBlockReason(
              providerError,
              attempt,
              text !== '',
              toolAccums.size > 0
            )
            if (retryBlock === null) {
              retryable = providerError
            } else {
              streamFailed = true
              this.emitProviderError(providerError, stage, trace, retryBlock)
            }
          }
        }
      }

      if (usage !== undefined) {
        // 用量与请求关联：失败重试后仍能看到哪次物理请求真正产生了用量。
        this.usage.record(model, 'chat', usage, {
          requestId,
          turnId: this.turnId,
          source: this.cycleSource
        })
        // 用真实 promptTokens 校准同一请求的估算；小样本（测试/极短请求）
        // 不参与，避免把预算系数带偏。
        if (this.lastRequestBudget?.requestId === requestId) {
          this.budgetCalibrator.observe(
            this.config.provider.baseUrl + '/' + model,
            this.lastRequestBudget.rawInputTokens,
            usage.promptTokens
          )
        }
        this.emitTap({ type: 'usage', usage })
      }

      if (pairingRetry) {
        // 修复后必须用新的会话记录重建请求；不进入网络退避计数。
        messages = this.prepareMessagesForModel(this.buildMessages())
        toolAccums.clear()
        return 'retry'
      }

      if (retryable !== null) {
        attempt += 1
        this.cycleRetries += 1
        const delay = withJitter(attempt === 1 ? 2000 : 10000)
        this.logger.warn('模型请求将重试', {
          requestId,
          turnId: this.turnId,
          attempt: physicalAttempts,
          nextAttempt: physicalAttempts + 1,
          source: this.cycleSource,
          model,
          origin,
          code: retryable.code,
          category: retryable.category,
          status: retryable.status ?? null,
          causeStatus: retryable.diagnostics.causeStatus,
          causeCode: retryable.diagnostics.causeCode ?? null,
          transportPhase: retryable.diagnostics.transportPhase,
          retryReason: 'transient',
          delayMs: delay,
          elapsedMs: Math.max(0, this.clock.now() - attemptStartedAt),
          headersReceived: trace.headersReceived,
          sawModelEvent: trace.sawModelEvent
        })
        this.setPhase('backoff', { retryAt: this.clock.now() + delay })
        try {
          await sleep(delay, controller.signal)
        } catch {
          aborted = true
        }
        if (aborted) {
          // 退避等待被用户中断：不是一次新的失败，也不应继续重试。
          this.logger.info('模型请求重试已取消', {
            requestId,
            turnId: this.turnId,
            attempt: physicalAttempts,
            source: this.cycleSource,
            reason: 'cancelled-during-backoff'
          })
          return
        }
        // 重试时从干净的累积状态开始（未外显的部分已外显的保留在聊天里）
        toolAccums.clear()
        return 'retry'
      }

      if (!streamFailed) {
        const outcome = aborted || this.interrupted ? 'aborted' : needsHandoff ? 'handoff' : 'done'
        const recovered = physicalAttempts > 1 && outcome === 'done'
        this.logger.info(
          outcome === 'aborted' ? '模型请求已取消' : recovered ? '模型请求重试成功' : '模型请求完成', {
          requestId,
          turnId: this.turnId,
          attempt: physicalAttempts,
          source: this.cycleSource,
          model,
          origin,
          outcome,
          elapsedMs: Math.max(0, this.clock.now() - attemptStartedAt),
          headersMs:
            trace.headersAt === null ? null : Math.max(0, trace.headersAt - attemptStartedAt),
          firstEventMs:
            trace.firstEventAt === null
              ? null
              : Math.max(0, trace.firstEventAt - attemptStartedAt),
          headersReceived: trace.headersReceived,
          sawModelEvent: trace.sawModelEvent,
          ...(recovered
            ? { recoveredAfterFailures: physicalAttempts - 1 }
            : {})
        })
      }
      return
    })

    if (this.interrupted) aborted = true

    const toolCalls = [...toolAccums.values()]
      .sort((a, b) => a.index - b.index)
      .filter((call): call is ToolCallAccum & { id: string; name: string } =>
        typeof call.id === 'string' && call.id !== '' && typeof call.name === 'string' && call.name !== ''
      )
      .map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }))

    // 注意不要复用 externalized：空 text delta 与工具流开始都会置位它，
    // 但那些并不等于用户能看到的结果。
    if (text.trim() !== '' || toolCalls.length > 0) this.turnHadOutput = true

    // 页面内容不可落盘：网页批次里的正文与 pet_say 参数只保存占位符。
    // 纯主动轮（没有用户消息）的正文也不写会话，只让工具动作/气泡留在界面上。
    const sessionText = this.sessionSafeAssistantText(text)
    if (sessionText !== '' && !sessionText.startsWith('[')) {
      this.workState.noteAssistant(sessionText, this.clock.now())
    }
    const sessionCalls = toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: this.sessionSafeToolArguments(call.name, call.arguments)
    }))
    // 流在中途失败时，已累积的工具调用参数可能不完整，不能执行；也绝不能
    // 只把 assistant.tool_calls 写进会话而不留下对应回执，否则下一次请求会因
    // “tool_calls 缺少 tool 消息”整批 HTTP 400，主动轮次会一直失败下去。
    if (!aborted && !streamFailed && sessionCalls.length > 0) {
      this.session.appendAssistant(sessionText, sessionCalls)
    } else if (sessionText !== '') {
      this.session.appendAssistant(sessionText, undefined, undefined, aborted)
    }
    this.emitTap({ type: 'assistant_end', text, aborted })
    if (aborted) return { toolCalls: [], failed: false, needsHandoff }
    if (streamFailed) return { toolCalls: [], failed: true, needsHandoff }
    return { toolCalls, failed: false, needsHandoff }
  }

  private recordProviderFailure(
    error: ProviderError,
    stage: ProviderFailureNotice['stage'] = 'model-request',
    trace: ProviderFailureTrace | null = null,
    retryReason: string | null = null
  ): ProviderFailureNotice {
    const now = this.clock.now()
    const reason = sanitizeErrorText(error.message, 200)
    const elapsedMs =
      trace === null ? undefined : Math.max(0, now - trace.startedAt)
    // 最终失败只在这里写一条完整记录；bot 不再重复写一条“结构化失败”。
    this.logger.error('模型请求失败详情', {
      requestId: trace?.requestId ?? null,
      turnId: this.turnId,
      attempt: trace?.attempt ?? null,
      source: this.cycleSource,
      model: trace?.model ?? this.config.provider.model,
      origin: trace?.origin ?? null,
      category: error.category,
      code: error.code,
      status: error.status ?? null,
      retryable: error.retryable,
      causeStatus: error.diagnostics.causeStatus,
      causeCode: error.diagnostics.causeCode ?? null,
      causeName: error.diagnostics.causeName ?? null,
      causes: error.diagnostics.causes ?? null,
      aggregateCount: error.diagnostics.aggregateCount ?? null,
      causeTruncated: error.diagnostics.truncated ?? false,
      transportPhase: error.diagnostics.transportPhase,
      stage,
      elapsedMs: elapsedMs ?? null,
      headersMs:
        trace === null || trace.headersAt === null
          ? null
          : Math.max(0, trace.headersAt - trace.startedAt),
      firstEventMs:
        trace === null || trace.firstEventAt === null
          ? null
          : Math.max(0, trace.firstEventAt - trace.startedAt),
      headersReceived: trace?.headersReceived ?? false,
      sawModelEvent: trace?.sawModelEvent ?? false,
      retryDecision: trace === null ? 'none' : 'no-retry',
      retryReason,
      reason
    })
    const notice: ProviderFailureNotice = {
      sessionId: this.session.id,
      turnId: this.turnId,
      turn: this.session.roundCount,
      source: this.cycleSource,
      stage,
      code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
      retryable: error.retryable,
      recoveryState: providerRecovery(error),
      userInitiated: this.hasUserMessageCycle,
      reason,
      at: now,
      category: error.category,
      transportPhase: error.diagnostics.transportPhase,
      causeStatus: error.diagnostics.causeStatus,
      ...(error.diagnostics.causeCode === undefined
        ? {}
        : { causeCode: error.diagnostics.causeCode }),
      ...(error.diagnostics.causeName === undefined
        ? {}
        : { causeName: error.diagnostics.causeName }),
      ...(error.diagnostics.causes === undefined
        ? {}
        : { causes: error.diagnostics.causes }),
      ...(error.diagnostics.aggregateCount === undefined
        ? {}
        : { aggregateCount: error.diagnostics.aggregateCount }),
      ...(error.diagnostics.truncated === true ? { causeTruncated: true } : {}),
      ...(trace === null
        ? {}
        : {
            requestId: trace.requestId,
            attempt: trace.attempt,
            model: trace.model,
            origin: trace.origin,
            elapsedMs: elapsedMs ?? 0,
            headersReceived: trace.headersReceived,
            sawModelEvent: trace.sawModelEvent
          })
    }
    // 只有最终失败才留下记录；成功重试不会覆盖它，也不会被误报成失败。
    this.turnProviderFailure = notice
    try {
      this.onProviderFailure?.(notice)
    } catch (callbackError) {
      this.logger.warn('Provider 失败回调异常', { error: String(callbackError).slice(0, 200) })
    }
    return notice
  }

  /** 失败阶段由 Provider 给出的传输阶段决定；没有阶段信息时才退回事件观察。 */
  private stageForProviderError(
    error: ProviderError,
    sawModelEvent: boolean
  ): ProviderFailureNotice['stage'] {
    if (error.diagnostics.transportPhase === 'stream') return 'stream'
    if (
      error.diagnostics.transportPhase === 'request' ||
      error.diagnostics.transportPhase === 'response-headers'
    ) {
      return 'model-request'
    }
    return sawModelEvent ? 'stream' : 'model-request'
  }

  /**
   * 明确记录“为什么不重试”。已输出正文或已收到工具参数时绝不重放整轮，
   * 避免重复执行工具或破坏 assistant/tool 配对。
   */
  private retryBlockReason(
    error: ProviderError,
    attempt: number,
    hasReplyText: boolean,
    hasToolFragment: boolean
  ): string | null {
    if (!error.retryable) return 'not-retryable'
    if (hasReplyText) return 'reply-started'
    if (hasToolFragment) return 'tool-fragment'
    if (attempt >= 2) return 'attempts-exhausted'
    if (this.cycleRetries >= 4) return 'turn-retry-budget-exhausted'
    return null
  }

  private emitProviderError(
    error: ProviderError,
    stage: ProviderFailureNotice['stage'] = 'model-request',
    trace: ProviderFailureTrace | null = null,
    retryReason: string | null = null
  ): void {
    this.recordProviderFailure(error, stage, trace, retryReason)
    const text = `（${sanitizeErrorText(error.message, 300)}）`
    this.emitTap({ type: 'text_delta', text })
    this.externalized = true
  }

  // ------------------------------------------------------------------ 工具轮

  private async toolRound(
    calls: readonly ToolCallRequest[],
    allowlist: string[] | null
  ): Promise<{ endsTurn: boolean }> {
    this.setPhase('tools')
    let endsTurn = false
    let skippedFrom = -1
    const images: ToolImage[] = []
    const signal = this.cycleSignal?.signal ?? new AbortController().signal

    await this.conversationRuntime.engine.batch(calls, async (call, index) => {
      if (call === undefined) return
      if (this.interrupted) {
        skippedFrom = index
        return 'stop'
      }
      // 单次执行、风险、审批、预算与审计都在共享执行器里；Core 只负责
      // 把回执写入自己的会话并维持工具配对。
      const taskCycle = this.cycleTask
      const taskHooks = this.taskHooks
      let result: ToolExecutionResult
      try {
        result = await this.executor.execute(
          call,
          {
            kind: 'chat',
            sessionId: this.session.id,
            turnId: this.turnId,
            turn: this.session.roundCount,
            allowlist,
            source: this.cycleSource,
            ...(taskCycle === null
              ? {}
              : { taskId: taskCycle.taskId, taskGeneration: taskCycle.generation }),
            ...(taskCycle?.title === undefined ? {} : { taskTitle: taskCycle.title }),
            userInitiated: this.hasUserMessageCycle,
            tainted: this.pageDerivedCycle,
            ...(this.activeExposure === null ? {} : { exposure: this.activeExposure }),
            signal
          },
          {
            onRunningChange: (names) => {
              this.runningTools = names
              this.setPhase('tools')
            },
            onTaint: () => {
              this.pageDerivedCycle = true
            },
            ...(taskCycle === null || taskHooks === null
              ? {}
              : {
                  onBeforeExecute: (step) => {
                    taskHooks.onToolIntent({
                      taskId: taskCycle.taskId,
                      generation: taskCycle.generation,
                      callId: step.callId,
                      tool: step.name,
                      sideEffect: step.meta.sideEffect,
                      verify: step.meta.verify === true,
                      now: this.clock.now()
                    })
                  },
                  onExecuted: (step) =>
                    taskHooks.onToolResult({
                      taskId: taskCycle.taskId,
                      generation: taskCycle.generation,
                      callId: step.callId,
                      tool: step.name,
                      outcome: step.outcome,
                      sideEffect: step.meta.sideEffect,
                      verify: step.meta.verify === true,
                      now: this.clock.now()
                    })
                })
          }
        )
      } catch (error) {
        // 执行器自身异常也必须留下回执，否则 assistant.tool_calls 会永远缺一条
        // tool 消息，下一次请求必定 400。这里绝不重放有副作用的工具。
        const detail = error instanceof Error ? error.message : String(error)
        this.logger.error('工具执行器抛出异常', {
          tool: call.name,
          callId: call.id,
          source: this.cycleSource,
          error: detail.slice(0, 300)
        })
        result = {
          outcome: {
            text: `[TOOL_FAILED] ${call.name} 执行异常：${detail.slice(0, 180)}`,
            failed: true
          },
          endsTurn: false
        }
      }
      if (result.outcome.failed !== true) {
        for (const image of result.outcome.images ?? []) images.push(image)
      }
      // 只保留“最后一个尚未被成功步骤接续”的工具失败。模型在收到失败回执后
      // 换一种方式做成功时，不应把整轮说成失败；反过来，最终停在一个失败上时
      // 要能说清是授权、目标失效还是普通工具错误。
      if (result.outcome.failed === true) {
        const code = toolFailureCode(result.outcome.text)
        if (classifyToolFailure(code).kind !== 'cancelled') {
          this.turnToolFailure = { tool: call.name, code }
        }
      } else {
        this.turnToolFailure = null
        this.turnCompleted.push(call.name)
      }
      this.appendToolResult(call.id, call.name, result.outcome)
      this.workState.noteTool(
        {
          tool: call.name,
          targetRef: result.outcome.meta?.targetRef ?? null,
          failed: result.outcome.failed === true,
          text: result.outcome.text
        },
        this.clock.now()
      )
      if (result.halt === true) {
        this.logger.info('任务执行器要求停止本轮')
        this.interrupt('task-halt')
        endsTurn = true
        skippedFrom = index + 1
        return 'stop'
      }
      if (result.endsTurn) {
        endsTurn = true
        skippedFrom = index + 1
        return 'stop'
      }
    })

    if (skippedFrom >= 0) {
      for (let i = skippedFrom; i < calls.length; i += 1) {
        const call = calls[i]
        if (call === undefined) continue
        if (this.session.records.some((record) => record.kind === 'tool' && record.toolCallId === call.id)) {
          continue
        }
        this.appendToolResult(call.id, call.name, {
          text: this.interrupted ? '[TOOL_ABORTED] 用户已停止本轮' : '[SKIPPED] 本轮已结束，未执行',
          failed: true
        })
      }
    }
    // 图片必须等整批 tool 回执都配好对之后再追加，绝不能被插在 tool 消息之间。
    if (images.length > 0) this.appendToolImages(images)
    if (!this.interrupted) this.setPhase('tools')
    return { endsTurn }
  }

  /**
   * 把截图作为独立的 ephemeral user 消息交给模型，并只保留最近一组。
   * 图片记录本身永不写盘，这里再主动删掉更老的记录，避免上下文膨胀。
   */
  private appendToolImages(images: ToolImage[]): void {
    // 截图与 B 站故事板抽帧分属不同证据类型，各自限流、各自标号；
    // 不能因为一个批次里同时有截图就把抽帧截到只剩 2 张。
    const latest = selectToolImages(images)
    if (latest.length === 0) return
    this.session.appendUser(describeToolImages(latest), undefined, true, latest)
    const imageRecords = this.session.records.filter(
      (record) => record.kind === 'user' && (record.images?.length ?? 0) > 0
    )
    if (imageRecords.length <= 1) return
    const keep = new Set(imageRecords.slice(-1))
    this.session.records = this.session.records.filter(
      (record) =>
        !(record.kind === 'user' && (record.images?.length ?? 0) > 0) || keep.has(record)
    )
  }

  private appendToolResult(toolCallId: string, name: string, outcome: ToolOutcome): void {
    this.session.appendTool(
      toolCallId,
      name,
      outcome.text,
      outcome.failed === true,
      outcome.ephemeral === true
    )
    this.emitTap({
      type: 'tool_result',
      id: toolCallId,
      name,
      text: outcome.text,
      failed: outcome.failed === true,
      ...(outcome.meta === undefined ? {} : { meta: outcome.meta })
    })
  }

  private sessionSafeAssistantText(text: string): string {
    if (text === '') return ''
    if (this.pageDerivedCycle) return '[page-derived speech omitted]'
    if (this.proactiveCycle) return ''
    return text
  }

  private sessionSafeToolArguments(name: string, args: string): string {
    if (!this.pageDerivedCycle) return args
    if (name === 'pet_say') return JSON.stringify({ text: '[page-derived speech omitted]' })
    return args
  }

  // ------------------------------------------------------------------ 结束/相位

  /** 已完成步骤只含工具名/阶段名，绝不含参数、路径或页面内容。 */
  private completedSteps(): string[] {
    const steps = [...new Set(this.turnCompleted)]
    if (this.turnHadReplyText) steps.push('部分回复')
    return steps.slice(0, 12)
  }

  private turnFailureFor(outcome: TurnOutcome): TurnFailure | null {
    // 用户停止优先：这是用户的决定，不是 Provider 或工具的失败。
    if (this.interrupted) {
      return cancelledFailure(this.interruptReason ?? '已停止这一轮', this.completedSteps())
    }
    if (this.turnProviderFailure !== null) {
      return providerFailure(this.turnProviderFailure, this.completedSteps())
    }
    if (outcome === 'capped') return roundCapFailure(this.completedSteps())
    if (this.turnToolFailure !== null) {
      // “部分完成”只按真正成功的工具步骤算；模型解释性正文不是进展。
      return toolTurnFailure(this.turnToolFailure.tool, this.turnToolFailure.code, [
        ...new Set(this.turnCompleted)
      ])
    }
    if (outcome === 'failed') {
      return internalFailure('这一轮在未归类的阶段中止', this.completedSteps())
    }
    return null
  }

  private buildTurnReport(outcome: TurnOutcome): TurnReport {
    const now = this.clock.now()
    const failure = this.turnFailureFor(outcome)
    let repeatCount = 1
    let firstAt = now
    if (failure !== null) {
      const chain = this.failureChain
      const merged =
        chain !== null &&
        chain.source === this.cycleSource &&
        sameFailure(chain.failure, failure) &&
        now - chain.lastAt <= 10 * 60_000
      if (merged && chain !== null) {
        chain.failure = failure
        chain.count += 1
        chain.lastAt = now
        repeatCount = chain.count
        firstAt = chain.firstAt
      } else {
        this.failureChain = {
          source: this.cycleSource,
          failure,
          count: 1,
          firstAt: now,
          lastAt: now
        }
      }
    } else if (this.failureChain !== null && this.failureChain.source === this.cycleSource) {
      // 同一来源恢复正常后清除旧失败链；其他来源的失败不受影响。
      this.failureChain = null
    }
    if (this.turnId === '') this.turnSeq += 1
    return {
      turnId: this.turnId === '' ? `turn-${now.toString(36)}-${this.turnSeq.toString(36)}` : this.turnId,
      sessionId: this.session.id,
      at: now,
      source: this.cycleSource,
      outcome,
      failure,
      repeatCount,
      firstAt,
      userInitiated: this.hasUserMessageCycle,
      background: !this.hasUserMessageCycle,
      round: this.session.roundCount
    }
  }

  private publishTurnReport(report: TurnReport): void {
    if (this.onTurnReport === null) return
    try {
      this.onTurnReport(report)
    } catch (error) {
      this.logger.warn('onTurnReport 回调异常', { error: String(error).slice(0, 200) })
    }
  }

  private finishCycle(outcome: TurnOutcome, emitBatchEnd = true): void {
    // 兜底：任何在发出请求前结束的异常路径都不能吞掉宿主预载。
    this.restoreCyclePreloadsIfNoRequest()
    const report = this.buildTurnReport(outcome)
    this.publishTurnReport(report)
    if (this.cycleTask !== null && this.taskHooks !== null) {
      const task = this.cycleTask
      this.cycleTask = null
      try {
        this.taskHooks.onCycleEnded({
          taskId: task.taskId,
          generation: task.generation,
          outcome,
          now: this.clock.now()
        })
      } catch (error) {
        this.logger.warn('TaskRunner.onCycleEnded 失败', { error: String(error) })
      }
    }
    this.setPhase('idle')
    this.emitTap({ type: 'turn_end', outcome, report })
    if (emitBatchEnd) this.emitTap({ type: 'batch_end', outcome, report })
    try {
      this.persona.onTurnEnded?.(outcome)
    } catch (error) {
      this.logger.warn('Persona.onTurnEnded 失败', { error: String(error) })
    }
    for (const world of this.worlds) {
      try {
        world.onTurnEnded?.(outcome)
      } catch (error) {
        this.logger.warn('World.onTurnEnded 失败', { world: world.id, error: String(error) })
      }
    }
    void Promise.resolve(this.persona.onBatchEnd?.()).catch((error: unknown) => {
      this.logger.warn('Persona.onBatchEnd 失败', { error: String(error) })
    })
    for (const cursor of this.pendingUserCursors.splice(0)) this.bus.promote(cursor)
    this.kickWake()
  }

  private setPhase(
    phase: RunPhaseState['phase'],
    extra: { retryAt?: number } = {}
  ): void {
    this.phaseState = {
      phase,
      round: this.session.roundCount,
      running: [...this.runningTools],
      ...(extra.retryAt === undefined ? {} : { retryAt: extra.retryAt }),
      enteredAt: this.clock.now(),
      approvalPending: this.gate.pendingCountFor('chat') > 0,
      source: this.cycleSource,
      ...(this.isReactionCycle() ? { reaction: true } : {}),
      ...(phase === 'idle' && (this.cycleSource === 'autonomy' || !this.turnHadOutput)
        ? { silentEnd: true }
        : {})
    }
    for (const world of this.worlds) {
      if (world.available !== true) continue
      try {
        world.onRunPhase?.(this.phaseState)
      } catch (error) {
        this.logger.warn('World.onRunPhase 失败', { world: world.id, error: String(error) })
      }
    }
    this.emitPhase()
  }

  private setApprovalPending(pending: boolean): void {
    if (this.phaseState.approvalPending === pending) return
    this.phaseState = { ...this.phaseState, approvalPending: pending }
    for (const world of this.worlds) {
      if (world.available !== true) continue
      try {
        world.onRunPhase?.(this.phaseState)
      } catch {
        /* ignore */
      }
    }
    this.emitPhase()
  }

  private emitPhase(): void {
    const snapshot = this.phase
    for (const listener of this.phaseListeners) {
      try {
        listener(snapshot)
      } catch {
        /* UI 监听器异常不能影响 Core */
      }
    }
  }

  private markSettled(events: EventEnvelope[], outcome: 'delivered' | 'discarded'): void {
    for (const world of this.worlds) {
      if (world.available !== true) continue
      try {
        world.onEventsSettled?.(events, outcome)
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 从本批事件的不透明 meta 中取 episodeId / 跨入口交接标记，向装配层换取
   * 当轮 ephemeral 衔接文本。事件库只保存 id 与布尔标记；摘要、笔记路径、
   * 对话正文都不进入 meta。
   */
  private takeEpisodeContext(events: EventEnvelope[]): string | null {
    const parts: string[] = []
    const seen = new Set<string>()
    let handoffRequested = false
    // 共同操作状态与具体 Episode 无关：只要会话仍有效，每一批模型轮次都能
    // 看到同一份“当前目标/观察版本/已核实事实/待办”；换入口不必重新问。
    if (this.sharedActivityContext !== null) {
      try {
        const text = this.sharedActivityContext()
        if (text !== null && text.trim() !== '') parts.push(text.trim())
      } catch (error) {
        this.logger.warn('共同操作会话读取失败', { error: String(error) })
      }
    }
    for (const event of events) {
      if (event.meta?.['conversationHandoff'] === true) handoffRequested = true
      const id = event.meta?.['episodeId']
      if (typeof id !== 'string' || id === '' || seen.has(id)) continue
      seen.add(id)
      if (this.episodeContext === null) continue
      try {
        const text = this.episodeContext(id)
        if (text !== null && text.trim() !== '') parts.push(text.trim())
      } catch (error) {
        this.logger.warn('主动对话衔接读取失败', { error: String(error) })
      }
    }
    if (handoffRequested && this.conversationHandoff !== null) {
      try {
        const text = this.conversationHandoff()
        if (text !== null && text.trim() !== '') parts.push(text.trim())
      } catch (error) {
        this.logger.warn('跨入口话题交接读取失败', { error: String(error) })
      }
    }
    return parts.length === 0 ? null : parts.join('\n\n')
  }

  private notifyIdle(): void {
    if (this.idleNotified) return
    this.idleNotified = true
    try {
      void Promise.resolve(this.persona.onIdle?.()).catch(() => undefined)
    } catch {
      /* ignore */
    }
    const waiters = this.idleWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  /** 测试/诊断：等到总线空闲、且没有运行中的轮次。 */
  waitUntilIdle(timeoutMs = 5000): Promise<boolean> {
    if (!this.running && this.bus.size === 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== onIdle)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      const onIdle = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      this.idleWaiters.push(onIdle)
    })
  }

  // ------------------------------------------------------------------ 中断

  private interrupt(reason: string): void {
    if (!this.running) return
    this.logger.info('中断当前轮', { reason })
    this.interrupted = true
    this.interruptReason = reason
    this.gate.rejectByOrigin('chat', reason === 'user-interrupt' ? '用户中断，审批已取消' : '已停止')
    this.cycleAbort?.abort()
    this.cycleSignal?.abort()
    this.executor.abortInterruptible('chat')
  }

  // ------------------------------------------------------------------ 上下文

  private buildMessages(): ModelMessage[] {
    // 记录层先修（无改动时是空操作）；协议闸门由 ContextAssembler 在整包
    // 装配时统一过，主聊天、主动轮、陪伴轮、任务轮都走同一条路径。
    this.session.repairPairing()
    return this.session.messages()
  }

  private prepareMessagesForModel(messages: ModelMessage[]): ModelMessage[] {
    return prepareContextMessages(messages, {
      source: `chat:${this.cycleSource}`,
      logger: this.logger,
      sessionId: this.session.id
    })
  }

  private async rebuildSystemPrompt(): Promise<void> {
    const segments = await this.systemSegments()
    this.systemSegmentCache = segments
    const text = segments.map((segment) => segment.text).join('\n\n')
    const record: ContextRecord = { kind: 'system', text, ts: isoNow() }
    // 只替换持久的基础提示词；本轮 ephemeral system 记录（共同操作会话、
    // episode 衔接、上下文警告）必须保留，否则工具组变化触发的重建会把
    // 刚注入的当轮上下文吞掉。
    const existing = this.session.records
    const baseIndex = existing.findIndex(
      (item) => item.kind === 'system' && item.ephemeral !== true
    )
    const next =
      baseIndex === -1
        ? [record, ...existing]
        : existing.map((item, index) => (index === baseIndex ? record : item))
    this.session.replaceAll(next)
    this.session.hardTokens = this.hardTokens()
    this.promptExposureRevision = this.toolExposure.revision()
  }

  private async systemSegments(): Promise<PrefixSegment[]> {
    const loadedGroups = this.toolExposure.loadedGroups()
    const toolExposure = {
      loadedGroups,
      catalogText: this.toolExposure.catalogText(this.registry)
    }
    const worldContexts: WorldPrefixContext[] = []
    for (const world of this.worlds) {
      if (world.available !== true) continue
      // 未加载组的 World 提示词不进入上下文，避免模型看到用不了的入口；
      // 目录仍会说明如何加载。没有映射的 World 始终保留。
      if (!worldPromptVisible(world.id, loadedGroups)) continue
      let vars: Record<string, string> | null = null
      try {
        vars = await world.envPromptVars()
      } catch (error) {
        this.logger.warn('World.envPromptVars 失败', { world: world.id, error: String(error) })
      }
      const rawPrompt = world.envPrompt?.() ?? null
      const prompt =
        rawPrompt === null ? null : filterWorldPromptGroups(rawPrompt, loadedGroups)
      worldContexts.push({
        id: world.id,
        vars,
        prompt: prompt === null || prompt.trim() === '' ? null : prompt
      })
    }
    return this.persona.systemSegments({
      now: new Date(this.clock.now()),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      worlds: worldContexts,
      toolExposure
    })
  }

  private async handoff(): Promise<void> {
    this.setPhase('handoff')
    const hardTokens = this.hardTokens()
    let tail: ContextRecord[] | null = null
    try {
      const handler = this.persona.onHandoff
      if (handler !== undefined) {
        // 截图只属于当前 turn；交接快照绝不把 base64 交给 Persona。
        const snapshot = stripImagesFromRecords(this.session.records.filter(record => record.retention !== 'memory'))
        const result = await handler.call(this.persona, snapshot, { hardTokens })
        tail = result.tail
      }
    } catch (error) {
      this.logger.error('Persona.onHandoff 失败，使用本地裁剪', { error: String(error) })
    }
    if (tail === null) {
      tail = this.session.records.filter((record) => record.kind !== 'system' && record.retention !== 'memory').slice(-10)
    }
    tail = stripImagesFromRecords(tail.filter((record) => record.kind !== 'system'))
    const segments = await this.systemSegments()
    this.systemSegmentCache = segments
    const systemRecord: ContextRecord = {
      kind: 'system',
      text: segments.map((segment) => segment.text).join('\n\n'),
      ts: isoNow()
    }
    const capacity = hardTokens ?? this.config.context.maxTokens
    const budget = Math.max(1024, Math.floor(capacity * Math.max(0.15, this.config.context.keepRatio)))
    const trimmed = trimTail(tail, budget)
    this.session.replaceAll([systemRecord, ...trimmed, ...this.session.records.filter(record => record.retention === 'memory')])
    this.promptExposureRevision = this.toolExposure.revision()
    // 裁剪后兜底修复一次；如果之前因配对错误暂停过模型链，新结构会自然解除。
    this.session.repairPairing()
    this.protocolBlock = null
    this.session.resetRounds()
    // 交接后重新注入内存工作状态：目标、已完成动作与未知结果不能随着
    // 滚动窗口一起消失；memory.enabled=false 时同样有效。
    this.injectWorkState()
    this.session.hardTokens = hardTokens
    this.softWarned = false
    for (const world of this.worlds) {
      if (world.available !== true) continue
      try {
        world.onHandoffEnded?.()
      } catch {
        /* ignore */
      }
    }
    this.logger.info('上下文已交接', { kept: trimmed.length, hardTokens })
    this.setPhase('idle')
  }

  private hardTokens(): number | null {
    const facts = this.provider?.modelFacts()
    const cw = facts?.contextWindow ?? this.config.provider.contextWindow
    const mo = facts?.maxOutputTokens ?? this.config.provider.maxOutputTokens
    if (cw === undefined || !Number.isFinite(cw)) return null
    return Math.max(0, Math.min(this.config.context.maxTokens, cw - (mo ?? 0)))
  }

  /**
   * 请求级预算使用的窗口上限：完整窗口（含输出），由整包估算自己扣除
   * 输出预留与安全余量；不再与 hardTokens 的预扣重复计算。
   */
  private requestCapacity(): number {
    const facts = this.provider?.modelFacts()
    const window = facts?.contextWindow ?? this.config.provider.contextWindow
    const configured = this.config.context.maxTokens
    if (!Number.isFinite(window) || window <= 0) return configured
    return Math.max(1_024, Math.min(configured, window))
  }

  /** 把当前工作状态作为一条 ephemeral system 记录放进会话；重复调用只更新。 */
  private injectWorkState(): void {
    const text = this.workState.toPrompt()
    if (text === null) {
      this.session.replaceAll(this.session.records.filter(item => !(item.kind === 'system' && item.ephemeral === true && item.text.startsWith(WORK_STATE_MARKER))))
      return
    }
    const record: ContextRecord = {
      kind: 'system',
      text,
      ts: isoNow(),
      ephemeral: true
    }
    const index = this.session.records.findIndex(
      (item) =>
        item.kind === 'system' &&
        item.ephemeral === true &&
        item.text.startsWith(WORK_STATE_MARKER)
    )
    if (index >= 0) {
      this.session.records[index] = record
      return
    }
    // 放在当前用户消息之前：让「工作状态」紧邻本轮输入，又不会成为最后一条
    // 消息（最后一条必须保持 user，工具调用循环才符合常见 Provider 的语义）。
    let insertAt = -1
    for (let i = this.session.records.length - 1; i >= 0; i -= 1) {
      if (this.session.records[i]?.kind === 'user') {
        insertAt = i
        break
      }
    }
    if (insertAt >= 0) this.session.records.splice(insertAt, 0, record)
    else this.session.append(record, { persist: false })
  }

  // ------------------------------------------------------------------ 定时器

  private onTimerDue(record: TimerRecord): void {
    if (record.kind === 'task' || record.taskId !== undefined) {
      // 任务定时器绝不作为普通提醒投递；由 TaskRunner 校验状态与 generation。
      if (record.taskId === undefined) return
      this.taskHooks?.onTimer(record.taskId, record.taskGeneration, this.clock.now())
      return
    }
    this.pushEvent({
      type: 'timer.due',
      source: 'core',
      origin: 'internal',
      text: `[system/timer] 定时到：${record.note}（${record.at}）`,
      attention: 'wake',
      meta: { kind: record.kind }
    })
  }

  // ------------------------------------------------------------------ World 装配

  private makeWorldHost(world: World): WorldHost {
    return {
      pushEvent: (input) => {
        const env = this.pushEvent({ ...input, source: input.source || world.id })
        return env
      },
      pushDeferred: (text) => {
        if (text.trim() === '') return
        this.pushEvent({
          type: 'world.deferred',
          source: world.id,
          origin: 'internal',
          text,
          trigger: 'piggyback',
          persist: false
        })
      },
      store: {
        query: (filter) => this.events.query(filter)
      },
      log: (level, msg, data) => this.logger.log(level, `${world.id}: ${msg}`, data),
      modelFacts: () => this.provider?.modelFacts() ?? { model: this.config.provider.model },
      reportUsage: (usage) => this.usage.record('world:' + world.id, 'world', usage)
    }
  }

  private validateDescribe(world: World): void {
    const declaredTools = new Set(world.describe.tools.map((tool) => tool.name))
    for (const def of world.tools()) {
      if (!declaredTools.has(def.name)) {
        this.logger.warn('World 工具未在 describe 中声明', { world: world.id, tool: def.name })
      }
    }
  }

  // ------------------------------------------------------------------ 输出

  private emitTap(event: TapEvent): void {
    for (const tap of this.taps) {
      try {
        tap.onEvent(event)
      } catch (error) {
        this.logger.warn('outputTap 异常', { error: String(error) })
      }
    }
  }

  get phase(): RunPhaseState {
    return { ...this.phaseState, running: [...this.phaseState.running] }
  }

  /** 界面订阅 RunPhase（不进入模型上下文）。 */
  onPhase(listener: (state: RunPhaseState) => void): () => void {
    this.phaseListeners.add(listener)
    return () => this.phaseListeners.delete(listener)
  }

  get currentBatch(): EventEnvelope[] {
    return [...this.currentEvents]
  }

  get eventQueueSize(): number {
    return this.bus.size
  }

  /** World 设置页/诊断需要的运行时快照。 */
  diagnostics(): Record<string, unknown> {
    return {
      phase: this.phase,
      queue: this.bus.size,
      nextDueAt: this.bus.nextDueAt(),
      lastCursor: this.events.currentCursor,
      lastDeliveredCursor: this.events.deliveredCursor(),
      session: {
        ...this.session.info(),
        turnRounds: this.turnRoundCount
      },
      requestBudget: {
        calibration: this.budgetCalibration,
        last: this.lastRequestBudget,
        segments: this.lastContextSegments
      },
      workState: this.workState.summary(),
      usage: this.usage.summary(),
      wake: this.wakeGovernor.diagnostics(),
      approvals: {
        ...this.executor.diagnostics(),
        grants: this.gate.listGrants().length
      },
      pendingWake: this.bus
        .peek()
        .filter((entry) => entry.mode === 'piggyback' && entry.env.attention === 'wake').length,
      tools: this.registry.names(),
      toolContract: {
        entries: this.toolContract.tools.length,
        issues: this.toolContract.issues
      },
      exposure: {
        mode: this.toolExposure.getMode(),
        revision: this.toolExposure.revision(),
        loadedGroups: this.toolExposure.loadedGroups(),
        pendingGroups: [...this.pendingToolGroups],
        lastRequest: this.toolExposure.currentRequest(),
        requestHistory: this.toolExposure.historyEntries().map((entry) => ({
          requestId: entry.requestId,
          turnId: entry.turnId,
          source: entry.source,
          revision: entry.revision,
          tools: entry.names.length,
          schemaBytes: entry.schemaBytes,
          groupCatalogBytes: entry.groupCatalogBytes,
          groups: entry.groups.length
        }))
      },
      worlds: this.worlds.map((world) => ({
        id: world.id,
        available: world.available === true,
        reason: world.unavailableReason ?? null
      }))
    }
  }
}

/** task.kick meta 里的能力列表；只接受字符串，未知能力由映射自然忽略。 */
function capabilityList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))]
}

