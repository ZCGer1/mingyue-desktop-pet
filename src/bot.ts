import { buildChatHistory } from './worlds/chat/history'
import { randomUUID } from 'node:crypto'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from './shared/config'
import { ConfigurableDeepSeekProvider } from './botProvider'
import { ApprovalGate } from './core/approval'
import { AuditLog } from './core/audit'
import { CapabilityStore } from './core/capabilityStore'
import { CompanionMetrics, type ProcessSample } from './core/companionMetrics'
import {
  ConversationEpisodeStore,
  episodeContextText,
  safeDiscovery,
  type ConversationEpisode,
  type EpisodeFeedback
} from './core/conversationEpisode'
import { ConversationHandoffStore } from './core/conversationHandoff'
import {
  CompanionCandidateBoard,
  type CompanionCandidate,
  type CompanionCandidateReason
} from './core/companionCandidate'
import { Core } from './core/core'
import { SessionRouter } from './core/sessionRouter'
import { DesktopActionCoordinator } from './core/desktopCoordinator'
import { EpisodePersistence } from './core/episodePersistence'
import { EventStore } from './core/eventStore'
import {
  classifyExploreResult,
  createExploreCycle,
  exploreCycleSummary,
  type ExploreCycle
} from './core/exploreProgress'
import type { ToolResultInfo } from './core/toolExecutor'
import type { ToolExposureMode } from './core/toolExposure'
import type { ExperienceKind } from './persona/companion/experienceStore'
import { safeTargetRef } from './persona/companion/sanitize'
import { FileLogger } from './core/log'
import { QuickChatService } from './core/quickChat'
import { QuickToolGatewayImpl } from './core/quickTools'
import { ReactionChannel } from './core/reactionChannel'
import {
  ScreenCompanionController,
  ScreenFeedbackGenerationError,
  type ScreenFeedbackDeliveryInput,
  type ScreenFeedbackDeliveryResult,
  type ScreenFeedbackGenerationInput,
  type ScreenFeedbackGenerationOutput
} from './core/screenCompanion'
import { Session } from './core/session'
import { SharedActivitySession } from './core/sharedActivitySession'
import { StateStore } from './core/state'
import { TaskRunner } from './core/taskRunner'
import { TaskStore } from './core/taskStore'
import {
  checkpointSummary,
  isTerminalTaskState,
  type TaskView
} from './core/taskTypes'
import type {
  ApprovalDecision,
  ApprovalOrigin,
  ApprovalRequest,
  ApprovalScope,
  EventEnvelope,
  Logger,
  LogLevel,
  ModelInfo,
  ModelMessage,
  ProviderFailureNotice,
  TapEvent,
  TurnReport
} from './core/types'
import type { CapabilityTargets } from './core/capabilityTypes'
import type { ReactiveEventNotice } from './shared/reaction'
import { resolveLegacyAnimation } from './shared/petPresentation'
import {
  effectiveCapabilities,
  effectiveScopeSummary
} from './shared/effectiveCapabilities'
import {
  buildCapabilitySnapshot,
  capabilitySnapshotReady,
  capabilitySnapshotSummary,
  type CapabilityRuntimeFacts,
  type CapabilitySnapshotView
} from './shared/capabilityStatus'
import { normalizeProcessKey } from './shared/processName'
import { turnFailureView } from './shared/turnFailureView'
import type {
  AutonomyReadinessView,
  AutonomyScheduleState,
  ChatActionResult,
  PetInteractionKind,
  QuickSendResult,
  TurnFailureView
} from './shared/ipc'
import type {
  ScreenCompanionStatusView,
  ScreenCompanionTestResultView,
  ScreenFeedbackReason
} from './shared/screenCompanion'
import {
  DISCOVERY_SITE_BILIBILI,
  DISCOVERY_SITE_WEB,
  discoveryCardUrl,
  type DiscoveryCardView,
  type DiscoveryFeedbackKind,
  type DiscoveryListView
} from './shared/discovery'
import type { BiliAsrJobView, BiliSessionReportView } from './shared/bilibili'
import { UsageTracker } from './core/usage'
import { BudgetCalibrator } from './core/budgetCalibrator'
import { WhaleGirlPersona } from './persona/whaleGirl/persona'
import type { CompanionFeedback } from './persona/whaleGirl/companionTools'
import { buildQuickChatSystemPrompt } from './persona/whaleGirl/prompt'
import {
  buildScreenFeedbackSystemPrompt,
  buildScreenFeedbackUserPrompt,
  parseScreenFeedbackReply
} from './persona/whaleGirl/screenFeedbackPrompt'
import { ActivityWorld, bucketLabel } from './worlds/activity/activityWorld'
import { PowerShellForegroundProvider } from './worlds/activity/foreground'
import type { ForegroundProvider, SystemActivityProvider } from './worlds/activity/foreground'
import type { SceneProvider } from './worlds/activity/scene'
import {
  categoryLabel,
  timeBucketOf,
  type ActivityCategory
} from './worlds/activity/types'
import { AppsWorld } from './worlds/apps/world'
import type { AppScanEntry } from './worlds/apps/catalog'
import { BrowserWorld } from './worlds/browserPage/world'
import type { BrowserPagePayload } from './worlds/browserPage/types'
import { BrowserControlWorld } from './worlds/browserControl/world'
import type {
  BrowseStopReason,
  BrowserControlPort,
  BrowserDiscoveryPort
} from './worlds/browserControl/world'
import { BilibiliService } from './main/bilibili/service'
import type { BiliCryptoPort } from './main/bilibili/credentials'
import { BilibiliWorld } from './worlds/bilibili/world'
import type { BiliDiscoveryPort } from './worlds/bilibili/port'
import { ChatWorld } from './worlds/chat/chatWorld'
import { CuaWorld } from './worlds/cua/world'
import type { CuaPort, CuaSink, CuaStatus, CuaTakeoverKind } from './worlds/cua/port'
import { FilesWorld } from './worlds/files/world'
import { DesktopWorld } from './worlds/desktop/world'
import type { DesktopPort } from './worlds/desktop/types'
import { PetWorld } from './worlds/pet/petWorld'
import { PetIdlePolicy } from './worlds/pet/petIdlePolicy'
import type { PetPresentationSink, PetSayResult } from './worlds/pet/petWorld'
import { SYSTEM_ACTIONS, type SystemPort } from './worlds/system/port'
import { SystemWorld } from './worlds/system/world'
import { TerminalWorld } from './worlds/terminal/terminalWorld'
import type { TerminalSink } from './worlds/terminal/terminalWorld'
import { DeepSeekWebTransport, WebWorld } from './worlds/web/world'
import type { WebObserver } from './worlds/web/world'
import { TasksWorld } from './worlds/tasks/world'
import { WorkspaceWorld } from './worlds/workspace/world'

/** 兼容旧导入路径；实现与配置热替换逻辑归 `botProvider.ts`。 */
export { ConfigurableDeepSeekProvider }

const MAX_BILI_SESSION_REPORTS = 20
const SPEECH_QUIET_KEY = 'companion.speechQuietUntil'
const EXPLORE_PAUSE_KEY = 'autonomy.explorePausedUntil'
const EXPLORE_PAUSED_TASKS_KEY = 'autonomy.explorePausedTasks'
/** 探索暂停只接管仍在推进的自主任务；用户已要求处理的任务不碰。 */
const EXPLORE_PAUSABLE_STATES = new Set([
  'queued',
  'planning',
  'running',
  'observing',
  'waiting_approval'
])

export interface BotOptions {
  /** 应用数据根目录（`%APPDATA%/桌宠` 或便携模式 `<exe>/data`）。 */
  rootDir: string
  config: AppConfig
  getApiKey: () => string | null
  logger?: Logger
  consoleLog?: boolean
  onLogEntry?: (entry: Record<string, unknown>) => void
  /** Electron `powerMonitor` 等平台信号；不传则只有采样入口可用。 */
  system?: SystemActivityProvider | null
  /** 前台进程采样器；不传时若提供脚本路径则创建 PowerShell helper。 */
  foreground?: ForegroundProvider | null
  foregroundScriptPath?: string
  /** 截图/OCR 场景来源（Electron 主进程注入）；不传则只有类别感知。 */
  scene?: SceneProvider | null
  /** 系统操作平台端口（Electron 主进程注入）；不传时相关工具明确不可用。 */
  systemPort?: SystemPort | null
  /** 电脑操作端口（Electron 主进程或测试 fake）；不传时 CUA 工具明确不可用。 */
  cuaPort?: CuaPort | null
  /** 窗口观察端口（Electron 主进程或测试 fake）；不传时窗口工具明确不可用。 */
  desktopPort?: DesktopPort | null
  /** 普通应用目录扫描器（Electron 主进程注入）；不传时只能看到系统白名单。 */
  scanApps?: () => Promise<AppScanEntry[]>
  /** 桌宠自身进程名，CUA 永远不操作自己。 */
  cuaSelfNames?: string[]
  powershellPath?: string
  isOnBattery?: () => boolean
  onDegraded?: (reason: string) => void
  /** 除应用数据目录外，工作区工具还绝不能触碰的目录。 */
  extraDeniedRoots?: string[] | (() => string[])
  fetchImpl?: typeof fetch
  clock?: { now(): number }
  /** Electron `app.getVersion()`；用于把日志与正在运行的构建对应起来。 */
  appVersion?: string
  /** 低频进程采样（主进程注入）；不传时不记录 CPU/内存。 */
  processSampler?: () => ProcessSample | null
  /**
   * B 站独立阅读服务资源目录（Electron 主进程注入）。与 `biliCrypto` 同时
   * 提供才接入服务；测试/无 Electron 环境下 B 站工具明确不可用。
   */
  bilibiliResourcesDir?: string
  /** Electron `safeStorage` 适配器；只用于登录凭据加解密，绝不进入渲染进程。 */
  biliCrypto?: BiliCryptoPort
  /** 主进程注入 `shell.openPath`，用于打开日报；测试可省略。 */
  biliOpenPath?: (path: string) => Promise<string>
  /**
   * 工具暴露模式；默认 groups。full 只用于开发回退（仍隐藏旧入口），
   * 测试可显式指定。
   */
  toolExposureMode?: ToolExposureMode
}

export interface BotDiagnostics {
  [key: string]: unknown
}

function hardTokensFor(config: AppConfig): number {
  return Math.max(
    0,
    Math.min(config.context.maxTokens, config.provider.contextWindow - config.provider.maxOutputTokens)
  )
}

/**
 * 感知链路的失效原因来自 ActivityWorld / VisionService，统一映射成屏幕陪伴
 * 的固定原因枚举；未知原因按目标变化处理，宁可取消也不补说旧画面。
 */
function mapSceneInvalidation(reason: string): ScreenFeedbackReason {
  const value = reason.trim().toLowerCase()
  if (value === 'sensitive-app' || value === 'excluded-app') return 'muted-category'
  if (value === 'paused' || value === 'cleared' || value.includes('revoked') || value.includes('disabled')) {
    return 'disabled'
  }
  if (value === 'locked' || value === 'suspended') return 'stale'
  if (value === 'target-changed' || value === 'target-changed-during-capture') {
    return 'target-changed'
  }
  if (value === 'foreground-unavailable') return 'target-changed'
  return 'stale'
}

/** 设置页测试按钮的固定、无屏幕内容的阻断说明。 */
function screenTestBlockedMessage(reason: ScreenFeedbackReason | null): string {
  switch (reason) {
    case 'disabled':
      return '屏幕陪伴未启用，或屏幕感知/反应/事件分享等既有许可不完整；不会自动替你开启。'
    case 'event-sharing-off':
      return '「把事件分享给模型」已关闭；屏幕陪伴不会绕过它。'
    case 'speech-quiet':
      return '当前处于「暂时别说话」；等安静结束后再试。'
    case 'quiet-hours':
      return '当前处于安静时段；等时段结束后再试。'
    case 'muted-category':
      return '当前应用属于静音类别；不会为测试绕过静音。'
    case 'waiting-fresh-scene':
      return '已有一条屏幕陪伴在生成或排队中，请稍后再试。'
    case 'stale':
      return '当前没有可用摘要，且暂时无法请求刷新；等下一次正常采样后再试。'
    case 'target-changed':
      return '前台目标刚刚变化；等新画面稳定后再试。'
    case 'low-confidence':
      return '当前画面识别置信度太低，暂不据此开口。'
    default:
      return '当前条件不允许进行屏幕陪伴测试。'
  }
}

const COMPANION_KIND_LABELS: Record<string, string> = {
  file: '文件',
  window: '窗口',
  page: '页面',
  web: '网页',
  note: '笔记',
  app: '应用'
}

function shortAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/**
 * Bot 是 Electron-free 的装配层：把 Core、Persona、World 和本地存储
 * 拼成一个可被主进程使用/测试的实例（PLAN.md §2、§4、§8）。
 *
 * 这里不 import Electron。所有平台能力（前台进程采样、锁屏/空闲信号、
 * 窗口与宠物页）由调用方以接口注入。Provider 的配置热替换已移到
 * `botProvider.ts`，Bot 只持有实例。
 *
 * 装配完整运行实例。异步启动后才能收发事件。
 */
export class Bot {
  readonly rootDir: string
  readonly dataDir: string
  readonly logsDir: string
  readonly memoryDir: string
  /** 运行中的应用版本；测试或非 Electron 环境为 null。 */
  readonly appVersion: string | null

  readonly logger: Logger
  readonly audit: AuditLog
  readonly state: StateStore
  readonly session: Session
  readonly events: EventStore
  readonly usage: UsageTracker
  private readonly budgetCalibrator = new BudgetCalibrator()
  /** 本地运行指标：只含计数/枚举/数值，不含正文、路径或窗口标题。 */
  readonly metrics: CompanionMetrics
  readonly gate: ApprovalGate
  /** 能力授权：任务/会话级 grant 的唯一铸造与复验入口。 */
  readonly capabilities: CapabilityStore
  /** 桌面单操作者仲裁；所有 CUA 与启动应用动作都要先取租约。 */
  readonly coordinator: DesktopActionCoordinator
  readonly taskStore: TaskStore
  readonly tasks: TaskRunner
  /** 主动开场的衔接记录（纯内存，不持久化正文）。 */
  readonly episodes: ConversationEpisodeStore
  /** 跨快捷/完整聊天的当前话题片段（纯内存，不依赖摘要与长期记忆）。 */
  readonly conversationHandoff: ConversationHandoffStore
  /** 完整/快捷入口的话题解析唯一入口；不持有第二份状态。 */
  readonly sessions: SessionRouter
  /** 所有主动气泡在展示前的唯一表达仲裁；只记依据引用与固定枚举。 */
  readonly companionCandidates: CompanionCandidateBoard
  readonly provider: ConfigurableDeepSeekProvider
  readonly persona: WhaleGirlPersona
  readonly core: Core
  /** 快捷聊天与共享 ToolExecutor 之间的窄网关（同一套风险/审批/审计）。 */
  readonly quickTools: QuickToolGatewayImpl
  /** 独立于 Core 会话的快捷短对话（可选工具，只写一行摘要到记忆）。 */
  readonly quickChat: QuickChatService
  /** 真实外部事件的本地即时反应（不生成台词，不等待模型）。 */
  readonly reactionChannel: ReactionChannel
  /** 共同操作会话：跨完整/快捷聊天/桌宠气泡的当轮状态（纯内存，不存正文）。 */
  readonly sharedActivity: SharedActivitySession

  readonly chatWorld: ChatWorld
  readonly petWorld: PetWorld
  /** 屏幕陪伴反馈：接受 vision_model 摘要后独立生成一句短陪伴。 */
  readonly screenCompanion: ScreenCompanionController
  readonly activityWorld: ActivityWorld
  readonly browserWorld: BrowserWorld
  readonly browserControlWorld: BrowserControlWorld
  /** 独立扫码登录 + Python API 的 B 站只读阅读 World。 */
  readonly bilibiliWorld: BilibiliWorld
  /** 只有 Electron 主进程同时注入资源目录与 safeStorage 时才存在。 */
  readonly bilibiliService: BilibiliService | null
  readonly filesWorld: FilesWorld
  readonly appsWorld: AppsWorld
  readonly systemWorld: SystemWorld
  readonly cuaWorld: CuaWorld
  readonly desktopWorld: DesktopWorld
  readonly workspaceWorld: WorkspaceWorld
  readonly webWorld: WebWorld
  readonly terminalWorld: TerminalWorld
  readonly tasksWorld: TasksWorld

  private readonly configRef: AppConfig
  private readonly getApiKey: () => string | null
  /** 待机偶发动作/自主移动的唯一资格与冷却来源；进程内用单调时钟。 */
  private readonly petIdlePolicy: PetIdlePolicy
  private petSink: PetPresentationSink | null = null
  /** 最近一次桌宠自己的桌面动作；用于给随之而来的观察事件标注动作归属。 */
  private lastPetDesktopActionAt = 0
  /** 当前自主轮是否包含真实 reaction 事件；用于发言归因与模型时延。 */
  private reactionCycle: {
    startedAt: number
    eventAt: number
    /** 本轮实际投递的 reaction 事件 id；用于回填诊断链 outcome。 */
    eventIds: string[]
    spoke: boolean
    decided: boolean
    providerFailed: boolean
    aborted: boolean
  } | null = null
  /** 最近一次结构化模型请求失败；供反应归因与状态条使用，不含正文。 */
  private lastProviderFailure: ProviderFailureNotice | null = null
  /** 最近一次仍需用户知道的结构化失败；同来源成功轮次会清除它。 */
  private lastTurnFailure: TurnFailureView | null = null
  /** 近期失败历史（脱敏、按指纹合并）；供诊断页与报告使用。 */
  private failureHistory: TurnFailureView[] = []
  private readonly system: SystemActivityProvider | null
  private readonly nowMs: () => number
  private readonly bootedAt = Date.now()
  private lastTouchAffinityAt: number | null = null
  /** 当前 proactive 批次是否来自 explore tick，以及这一轮实际调用了几次工具。 */
  private exploreCycle: ExploreCycle | null = null
  /** 连续「一个工具都没调用」的 explore 轮数；单轮安静不算故障。 */
  private exploreEmptyStreak = 0
  private lastExploreFallbackAt = 0
  /** 最近一次兜底创建的结构化结果；只含枚举/计数，供报告和诊断页使用。 */
  private lastExploreFallback: {
    at: number
    ok: boolean
    stage: 'capability' | 'create'
    reason: string
    capabilityCount: number
    scopeKinds: string[]
  } | null = null
  /** 当前完整聊天用户批次里最后一段完整回复，用于跨入口话题交接。 */
  private handoffBatch: {
    lastAssistant: string
    lastAssistantFollowedByToolCall: boolean
    /** 本模型轮是否已出现工具调用；用于区分过程说明与最终回复。 */
    pendingToolCalls: boolean
  } | null = null
  private readonly tapListeners = new Set<(event: TapEvent) => void>()
  private readonly userMessageListeners = new Set<(event: EventEnvelope) => void>()
  private readonly taskListeners = new Set<(tasks: TaskView[]) => void>()
  private readonly statusListeners = new Set<() => void>()
  /** 本轮阅读卡只保存在运行时内存；聊天窗通过 bootstrap 恢复。 */
  private biliReports: BiliSessionReportView[] = []
  private readonly biliReportListeners = new Set<(report: BiliSessionReportView) => void>()
  private readonly extraDeniedRoots: string[] | (() => string[])
  private readonly episodePersistence: EpisodePersistence
  private statusBroadcastTimer: NodeJS.Timeout | null = null
  private explorePauseTimer: NodeJS.Timeout | null = null
  private metricsTimer: NodeJS.Timeout | null = null
  private explorePausedTaskIds: string[] = []
  private started = false
  private stopped = false
  private clearing = false

  constructor(options: BotOptions) {
    this.rootDir = options.rootDir
    this.dataDir = join(options.rootDir, 'data')
    this.logsDir = join(options.rootDir, 'logs')
    this.memoryDir = join(options.rootDir, 'memory')
    this.configRef = options.config
    this.getApiKey = options.getApiKey
    this.appVersion = options.appVersion ?? null
    this.extraDeniedRoots = options.extraDeniedRoots ?? []
    this.system = options.system ?? null
    this.nowMs = options.clock?.now ?? Date.now

    this.logger =
      options.logger ??
      new FileLogger({
        dir: this.logsDir,
        console: options.consoleLog ?? false,
        ...(options.onLogEntry === undefined ? {} : { onEntry: options.onLogEntry })
      })

    this.audit = new AuditLog(join(this.logsDir, 'audit.jsonl'))
    this.state = new StateStore(join(this.dataDir, 'state.json'))
    this.petIdlePolicy = new PetIdlePolicy({
      getConfig: () => ({
        idleActions: this.configRef.worlds.pet.animation.idleActions,
        movementEnabled: this.configRef.worlds.pet.movement.enabled,
        movementMinIdleMs: this.configRef.worlds.pet.movement.minIdleMs,
        movementAutonomousMinIntervalMs:
          this.configRef.worlds.pet.movement.autonomousMinIntervalMs,
        reducedMotion: this.configRef.worlds.pet.appearance.reducedMotion
      }),
      // 只持久化动作 ID 与墙钟时间；不写任何用户正文。
      store: {
        get: (key) => this.state.get(key),
        set: (key, value) => this.state.set(key, value)
      }
    })
    this.events = new EventStore({
      dir: join(this.dataDir, 'events'),
      runId: 'main',
      state: this.state
    })
    this.usage = new UsageTracker(join(this.logsDir, 'usage.jsonl'))
    this.metrics = new CompanionMetrics({
      file: join(this.logsDir, 'companion-metrics.jsonl'),
      now: this.nowMs,
      logger: this.logger,
      ...(options.processSampler === undefined
        ? {}
        : { processSampler: options.processSampler })
    })
    this.session = new Session({
      id: 'main',
      label: this.configRef.persona.name,
      file: join(this.dataDir, 'session-main.jsonl'),
      persistent: true,
      hardTokens: hardTokensFor(this.configRef),
      rounds: { soft: 12, hard: 20 }
    })
    this.gate = new ApprovalGate({
      ttlMs: this.configRef.approval.ttlMs,
      sessionAllowExactCommand: this.configRef.approval.sessionAllowExactCommand,
      sessionGrantMinutes: this.configRef.autonomy.sessionGrantMinutes,
      state: this.state,
      audit: this.audit,
      logger: this.logger
    })

    this.capabilities = new CapabilityStore({
      state: this.state,
      logger: this.logger,
      now: this.nowMs,
      getConfig: () => this.configRef,
      // 工作区/笔记/信任目录/显式目录/授权卷的统一并集；任务 grant 与
      // 执行复验读取同一个解析结果。
      resolveReadRoots: () => this.filesWorld.capabilityReadRoots(),
      resolveEditRoots: () => this.filesWorld.capabilityEditRoots()
    })
    this.coordinator = new DesktopActionCoordinator({
      logger: this.logger,
      now: this.nowMs,
      takeoverCooldownMs: this.configRef.autonomy.takeoverCooldownMs
    })
    this.taskStore = new TaskStore({
      file: join(this.dataDir, 'tasks.json'),
      logger: this.logger
    })
    this.episodes = new ConversationEpisodeStore({
      now: this.nowMs,
      // 过期未回答只影响聊天退避，不阻断探索。
      onUnanswered: (episode) => {
        // 没有显示/没有回应的发现不能一直停在“正在准备分享”。
        if (episode.discoveryId !== null) {
          this.persona?.discoveryStore.markDiscovered(episode.discoveryId)
        }
        this.metrics.noteEpisode('unanswered')
        this.persona?.cadenceController.noteUnanswered(episode.expiresAt)
        this.scheduleStatusBroadcast()
      }
    })
    this.episodePersistence = new EpisodePersistence({
      file: join(this.dataDir, 'episodes.json'),
      store: this.episodes,
      logger: this.logger
    })
    this.episodePersistence.restore()
    this.conversationHandoff = new ConversationHandoffStore({ now: this.nowMs })
    this.sessions = new SessionRouter({
      episodes: this.episodes,
      handoff: this.conversationHandoff
    })
    this.companionCandidates = new CompanionCandidateBoard({
      now: this.nowMs,
      logger: this.logger
    })
    this.sharedActivity = new SharedActivitySession({ now: this.nowMs })
    this.loadExplorePausedTasks()
    this.tasks = new TaskRunner({
      store: this.taskStore,
      capabilities: this.capabilities,
      logger: this.logger,
      getConfig: () => this.configRef,
      now: this.nowMs,
      rejectApprovals: (taskId, reason) => {
        this.gate.rejectMatching((request) => request.taskId === taskId, reason)
      }
    })
    // 恢复出来的任务不是今天新建的；先记为已知，只统计之后的状态变化。
    this.metrics.seedTasks(this.tasks.list(500))
    this.tasksWorld = new TasksWorld({
      runner: this.tasks,
      now: this.nowMs,
      getConfig: () => this.configRef,
      resolveNotesRoot: () => this.workspaceWorld.notesRootOrNull(),
      resolveReadRoots: () => this.filesWorld.capabilityReadRoots(),
      resolveArtifactRoot: () => this.filesWorld.capabilityArtifactRoot(),
      isActiveInterest: (interestId) =>
        this.persona.interestStore.get(interestId)?.status === 'active',
      onRest: (_reason, _minutes, request) =>
        this.persona.autonomyController.noteRest(request),
      onAbandon: (topic, reason) =>
        this.persona.autonomyController.noteCandidateAbandoned(topic, reason)
    })
    this.taskStore.onChange((records) => {
      for (const task of records) {
        // 指标只记状态迁移与来源，不记标题、意图或步骤。
        this.metrics.noteTaskState(task.id, task.state, task.source)
        // 任务关联兴趣只是本地归档，不授予任何权限；已关联时不再重复写盘。
        if (task.interestId !== null) {
          const interest = this.persona.interestStore.get(task.interestId)
          if (interest !== undefined && !interest.taskIds.includes(task.id)) {
            this.persona.interestStore.addTask(task.interestId, task.id)
          }
        }
        // 自主目标结束时把安全结果补进尚未回答的开场，方便用户随后接话。
        if (task.source !== 'autonomy') continue
        if (task.state !== 'completed' && task.state !== 'failed' && task.state !== 'cancelled') {
          // 有可继续的自主目标时，即使她正在 rest/waiting 也值得提前复查。
          this.persona.autonomyController.noteRelevantChange('autonomy-task')
          continue
        }
        const summary = safeDiscovery(task.result ?? '')
        if (summary !== '' && this.episodes.setDiscoveryForTask(task.id, summary)) {
          this.episodePersistence.scheduleSave()
        }
        if (summary !== '' && task.state === 'completed' && this.configRef.memory.enabled) {
          this.persona.experienceStore.record({
            kind: 'task',
            summary,
            tool: 'task_complete',
            targetKind: 'file',
            targetRef: null,
            taskId: task.id,
            interestId: task.interestId
          })
        }
      }
      const views = this.tasks.views()
      for (const listener of this.taskListeners) {
        try {
          listener(views)
        } catch (error) {
          this.logger.warn('任务变更监听器异常', { error: String(error) })
        }
      }
      this.scheduleStatusBroadcast()
    })

    this.provider = new ConfigurableDeepSeekProvider({
      getApiKey: this.getApiKey,
      getConfig: () => this.configRef,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    })

    this.persona = new WhaleGirlPersona({
      getConfig: () => this.configRef,
      memoryDir: this.memoryDir,
      // 兴趣/经历/探索进度与她自己的状态一起放在 data/，清空/诊断好定位。
      companionDir: this.dataDir,
      stateFile: join(this.dataDir, 'persona-state.json'),
      logger: this.logger,
      audit: this.audit,
      autonomyContext: () => this.describeAmbientContext(),
      exploreCandidates: () => this.describeExploreCandidates(),
      capabilitySummary: () => this.capabilityPromptSummary(),
      isUserAway: () => this.isUserAway(),
      hasOpenQuestion: () => this.episodes.hasOpenQuestion(),
      openQuestionExpiresAt: () => this.episodes.latestOpenQuestion()?.expiresAt ?? null,
      hasActiveAutonomyTask: () => this.hasActiveAutonomyTask(),
      lastPresentationAt: () => this.petWorld.lastPresentationAt(),
      nextCandidateAt: () => this.nextRelevantCandidateAt(),
      onCompanionFeedback: (feedback) => this.applyModelFeedback(feedback),
      onCompanionChange: () => {
        // 新兴趣/候选/发现是相关变化：允许模型自选的休息提前复查，但不解除用户暂停。
        this.persona?.autonomyController.noteRelevantChange('companion-data')
        this.scheduleStatusBroadcast()
      },
      onDiscoverySaved: (record) => {
        // 只有宿主保存成功后才允许把 discoveryId 关联到阅读记录；模型不能
        // 自己凭 observationId 建立这条关联。
        if (record.site !== 'bilibili') return
        const partIndex = record.partId === null ? 0 : Math.max(0, record.partId - 1)
        this.bilibiliService?.linkReadingDiscovery(record.id, record.videoId, partIndex)
      },
      onCadenceChange: () => this.scheduleStatusBroadcast(),
      onCadenceDecision: (decision) =>
        this.metrics.noteConsideration('companion', decision.reason)
    })

    this.reactionChannel = new ReactionChannel({
      getConfig: () => this.configRef,
      metrics: this.metrics,
      logger: this.logger,
      now: this.nowMs,
      // 环境变化仍更新感知与模型事件，但不再由本地自动播放装饰动作。
      autoEmit: false,
      onTrace: (notice, trace) => {
        // 场景事件的 eventId 与 ActivityWorld 诊断链一致；其它事件会被忽略。
        this.activityWorld?.noteSceneTrace(notice.eventId, trace)
      },
      emit: (cue, notice) => {
        const sink = this.petSink
        if (sink === null || !this.configRef.worlds.pet.enabled) return
        // 旧反应词表只做真实素材的近似映射；没有等价动画就不播，不伪装成功。
        const resolved = resolveLegacyAnimation({
          ...(cue.expression === undefined ? {} : { expression: cue.expression }),
          ...(cue.motion === undefined ? {} : { motion: cue.motion })
        })
        if (resolved === null) return
        void sink
          .onAnimate({
            animationId: resolved.animationId,
            mode: 'once',
            source: 'reaction',
            label: cue.label || notice.changeType
          })
          .then((outcome) => {
            if (outcome.status === 'unsupported' || outcome.status === 'failed') {
              this.logger.debug('本地反应动画未播放', {
                animation: outcome.animationId,
                status: outcome.status,
                reason: outcome.reason ?? ''
              })
            }
          })
          .catch((error: unknown) => {
            this.logger.warn('本地反应动作播放失败', {
              error: String(error).slice(0, 200)
            })
          })
      }
    })
    this.chatWorld = new ChatWorld({ logger: this.logger })
    this.petWorld = new PetWorld({
      logger: this.logger,
      isEnabled: () => this.configRef.worlds.pet.enabled,
      canOpenChat: () => this.configRef.chatUi.allowModelOpen,
      isSpeechQuiet: () => this.core.isSpeechQuiet(),
      policy: this.petIdlePolicy,
      isMovementEnabled: () => this.configRef.worlds.pet.movement.enabled,
      isMovementPauseWithPanel: () =>
        this.configRef.worlds.pet.movement.pauseWithPanel,
      getSemanticConfig: () => this.configRef.worlds.pet.animation.semantic,
      getReactions: () => this.configRef.worlds.pet.reactions,
      onProactiveSay: (input) => this.handleProactiveSay(input),
      onSayResult: (result) => this.handlePetSayResult(result),
      onQuiet: (until) => this.setSpeechQuietUntil(until),
      onPauseExplore: (until) => this.setExplorePausedUntil(until),
      canRespondReaction: () => this.reactionCycle !== null,
      onReactionResponse: (decision, reason, at) => {
        if (this.reactionCycle !== null) {
          this.reactionCycle.decided = true
          // 发言要等到气泡真正播出时再记时延；否则同一次发言会在
          // 「模型决定」和「真的开口」两处各记一次，样本被重复计数。
          if (decision === 'act') {
            this.metrics.noteReactionModelLatency(at - this.reactionCycle.eventAt)
          }
          this.traceReactionCycle('outcome', decision, reason, at)
          if (decision === 'continue_shared') {
            const active = this.tasks.activeTaskId()
            this.traceReactionCycle(
              'task',
              'continue',
              'model-continue-shared',
              at,
              active === null ? null : active.slice(0, 12)
            )
          }
        }
        if (decision === 'silent') this.metrics.noteReaction('silent', reason)
        else if (decision === 'act') this.metrics.noteReaction('model-action', reason)
        else if (decision === 'read_more' || decision === 'continue_shared') {
          this.metrics.noteReaction('continued', reason)
        }
      },
      onSpoken: (at, detail) => {
        // 只把“真的开口”计入指标；来源按屏幕通道/当前任务/反应轮区分。
        if (detail?.channel === 'screen_feedback') {
          this.metrics.noteSpoke('screen')
          this.screenCompanion.noteProactiveSpoken(at)
          this.persona.cadenceController.noteSpoken(at)
          this.scheduleStatusBroadcast()
          return
        }
        const activeId = this.tasks.activeTaskId()
        const active = activeId === null ? undefined : this.tasks.get(activeId)
        const kind =
          this.reactionCycle !== null
            ? 'reaction'
            : active?.source === 'autonomy'
              ? 'autonomy'
              : 'companion'
        this.metrics.noteSpoke(kind)
        if (this.reactionCycle !== null && !this.reactionCycle.spoke) {
          this.reactionCycle.spoke = true
          this.metrics.noteReaction('spoken', 'spoke')
          this.metrics.noteReactionModelLatency(at - this.reactionCycle.eventAt)
        }
        // 其它通道的主动开口同样重置屏幕陪伴的“安静较久”计时。
        if (kind === 'reaction' || kind === 'autonomy') {
          this.screenCompanion.noteProactiveSpoken(at)
        }
        this.persona.cadenceController.noteSpoken(at)
        this.scheduleStatusBroadcast()
      }
    })
    this.screenCompanion = new ScreenCompanionController({
      getConfig: () => this.configRef,
      logger: this.logger,
      now: () => this.nowMs(),
      isSpeechQuiet: () => this.core.isSpeechQuiet(),
      isBusy: () => this.core.isBusy() || this.core.isPaused() || this.quickChat?.isUserTurnActive() === true,
      isCurrentObservation: (observation) => {
        const current = this.activityWorld.currentScreenObservation()
        return current !== null && current.observationId === observation.observationId
      },
      hasOpenQuestion: () => this.episodes.latestOpenQuestion() !== undefined,
      requestFreshSummary: () => this.activityWorld.requestSceneSummaryRefresh(),
      generate: (input) => this.generateScreenFeedback(input),
      deliver: (input) => this.deliverScreenFeedback(input),
      onStatusChanged: () => this.scheduleStatusBroadcast(),
      onConsidered: (reason) => this.metrics.noteConsideration('screen', reason)
    })
    this.activityWorld = new ActivityWorld({
      getConfig: () => this.configRef,
      logger: this.logger,
      statsFile: join(this.dataDir, 'activity-stats.json'),
      foreground: this.makeForeground(options),
      scene: options.scene ?? null,
      system: options.system ?? null,
      autoSample: true,
      isOnBattery: options.isOnBattery ?? (() => false),
      isSelfAction: () => this.isPetDesktopActing(),
      onEvent: (notice) => this.handleReactiveNotice(notice),
      onModelScene: (observation) => this.screenCompanion.observe(observation),
      ownsModelScene: (observation) => this.screenCompanion.shouldOwn(observation),
      onSceneInvalidated: (reason) =>
        this.screenCompanion.invalidate(mapSceneInvalidation(reason)),
      ...(options.onDegraded === undefined ? {} : { onDegraded: options.onDegraded }),
      ...(options.clock === undefined ? {} : { now: () => options.clock!.now() })
    })
    this.browserWorld = new BrowserWorld({
      getConfig: () => this.configRef,
      logger: this.logger,
      onEvent: (notice) => this.handleReactiveNotice(notice),
      ...(options.clock === undefined ? {} : { now: () => options.clock!.now() })
    })
    this.browserControlWorld = new BrowserControlWorld({
      getConfig: () => this.configRef,
      logger: this.logger,
      discoveries: () => this.discoveryPort(),
      audit: this.audit,
      onBrowseStopped: (reason, hadSession) => this.handleBrowsingStopped(reason, hadSession),
      ...(options.clock === undefined ? {} : { now: () => options.clock!.now() })
    })
    this.bilibiliWorld = new BilibiliWorld({
      getConfig: () => this.configRef,
      logger: this.logger,
      discoveries: () => this.discoveryPort(),
      onSessionReport: (report) => this.recordBiliSessionReport(report),
      ...(options.clock === undefined ? {} : { now: () => options.clock!.now() })
    })
    this.bilibiliService = this.createBilibiliService(options)
    if (this.bilibiliService !== null) {
      const service = this.bilibiliService
      this.bilibiliWorld.setPort(service)
      service.setSessionProvider(() => this.bilibiliWorld.sessionView())
      service.setVisionProvider(() => this.biliVisionState())
      service.setOnChanged(() => this.scheduleStatusBroadcast())
      service.setOnAccountChanged((reason) => this.handleBiliAccountChanged(reason))
      service.setOnAsrTerminal((job) => this.handleBiliAsrTerminal(job))
      service.setOnStopRequested((reason) => this.handleBiliStopRequested(reason))
    }
    this.filesWorld = new FilesWorld({
      getConfig: () => this.configRef,
      dataDir: this.dataDir,
      deniedRoots: () => this.deniedRoots(),
      audit: this.audit,
      ...(options.clock === undefined ? {} : { now: () => options.clock!.now() })
    })
    this.systemWorld = new SystemWorld({
      getConfig: () => this.configRef,
      logger: this.logger,
      port: options.systemPort ?? null,
      desktopPort: options.desktopPort ?? null,
      audit: this.audit,
      deniedRoots: () => this.deniedRoots(),
      ...(options.clock === undefined ? {} : { now: () => options.clock!.now() })
    })
    this.workspaceWorld = new WorkspaceWorld({
      getConfig: () => this.configRef,
      logger: this.logger,
      dataDir: this.rootDir,
      deniedRoots: () => this.deniedRoots(),
      seenHint: (fingerprint) => this.persona.explorationStore.seen(fingerprint)
    })
    this.webWorld = new WebWorld({
      getConfig: () => this.configRef,
      logger: this.logger,
      transport: new DeepSeekWebTransport({
        getApiKey: this.getApiKey,
        getBaseUrl: () => this.configRef.provider.baseUrl ?? 'https://api.deepseek.com',
        logger: this.logger,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
      })
    })
    this.terminalWorld = new TerminalWorld({
      getConfig: () => this.configRef,
      logger: this.logger,
      deniedRoots: () => this.deniedRoots()
    })
    this.cuaWorld = new CuaWorld({
      getConfig: () => this.configRef,
      logger: this.logger,
      port: options.cuaPort ?? null,
      audit: this.audit,
      selfNames: options.cuaSelfNames ?? [],
      onUserTakeover: (kind) => this.handleUserTakeover(kind),
      ...(options.clock === undefined ? {} : { now: () => options.clock!.now() })
    })
    this.desktopWorld = new DesktopWorld({
      getConfig: () => this.configRef,
      logger: this.logger,
      port: options.desktopPort ?? null,
      seenHint: (fingerprint) => this.persona.explorationStore.seen(fingerprint),
      onWindowCapture: (ctx, info) => this.cuaWorld.adoptWindowCapture(ctx, info),
      isSelfAction: () => this.isPetDesktopActing(),
      onEvent: (notice) => this.handleReactiveNotice(notice),
      ...(options.clock === undefined ? {} : { now: () => options.clock!.now() })
    })
    this.appsWorld = new AppsWorld({
      getConfig: () => this.configRef,
      logger: this.logger,
      port: options.systemPort ?? null,
      desktopPort: options.desktopPort ?? null,
      ...(options.scanApps === undefined ? {} : { scanApps: options.scanApps }),
      audit: this.audit,
      ...(options.clock === undefined ? {} : { now: () => options.clock!.now() })
    })
    // 窗口截图与 CUA 输入共用同一套窗口身份/几何；桥只读取 DesktopWorld，
    // 不把 DesktopPort 暴露给 CuaWorld，也不允许退化成整屏截图。
    this.cuaWorld.setWindowBridge({
      probe: (windowId) => this.desktopWorld.probeWindowForCua(windowId),
      recapture: (windowId) => this.desktopWorld.recaptureWindowForCua(windowId)
    })

    this.chatWorld.setSink({
      onTap: (event) => this.dispatchTap(event),
      onUserMessage: (event) => {
        for (const listener of this.userMessageListeners) {
          try {
            listener(event)
          } catch (error) {
            this.logger.warn('用户消息监听器异常', { error: String(error) })
          }
        }
      }
    })

    this.core = new Core({
      budgetCalibrator: this.budgetCalibrator,
      config: this.configRef,
      dataDir: this.dataDir,
      session: this.session,
      eventStore: this.events,
      state: this.state,
      provider: this.provider,
      logger: this.logger,
      usage: this.usage,
      audit: this.audit,
      approvalGate: this.gate,
      capabilities: this.capabilities,
      coordinator: this.coordinator,
      taskHooks: this.tasks,
      resolveCapabilityTargets: async (call, surface) => {
        // 用户直聊/快捷聊天沿用原有语义：本轮授权不按工具参数收窄。
        // 任务与自主探索必须解析真实目标，二者共用同一套 World 解析器；
        // 解析结果缺失时由 CapabilityStore 继续 fail closed。
        if (surface.source !== 'task' && surface.source !== 'autonomy') return undefined
        const targets: CapabilityTargets = {}
        const setPaths = (paths: string[] | undefined): void => {
          if (paths !== undefined) targets.paths = paths
        }
        setPaths(this.workspaceWorld.resolveCapabilityTargets(call.name, call.arguments))
        setPaths(
          this.filesWorld.resolveCapabilityTargets(call.name, call.arguments, surface.source)
        )
        if (call.name === 'apps_launch' || call.name === 'apps_focus' || call.name === 'apps_wait') {
          const appTargets = await this.appsWorld.resolveCapabilityTargets(
            call.name,
            call.arguments
          )
          if (appTargets !== undefined) targets.apps = appTargets
        }
        if (call.name.startsWith('win_') || call.name.startsWith('computer_')) {
          // DesktopWorld 同时支持 win_* 与 computer_*；只按 win_ 前缀路由会
          // 让指定窗口的 computer_observe/find/act 缺少应用目标。
          const apps = await this.desktopWorld.resolveCapabilityTargets(
            call.name,
            call.arguments
          )
          if (apps !== undefined) targets.apps = apps
        } else if (call.name.startsWith('cua_') || call.name === 'screen_observe') {
          // screen_observe 承载旧 cua_screenshot 的整屏观察语义：带应用约束的
          // grant 仍按当前前台进程复验，不能因为改名而放宽。
          const app = await this.cuaWorld.foregroundProcessKey()
          if (app !== null) targets.apps = [app]
        } else if (call.name === 'page_current') {
          const domain = this.browserWorld.capabilityDomain()
          if (domain !== null) targets.domains = [domain]
        } else if (call.name === 'web_fetch') {
          const domain = domainFromToolArgs(call.arguments)
          if (domain !== null) targets.domains = [domain]
        } else if (call.name === 'browser_download') {
          // 下载落点由作品目录统一约束；域名仍可被排除名单/任务约束复验。
          const domain = domainFromToolArgs(call.arguments)
          if (domain !== null) targets.domains = [domain]
          const root = this.filesWorld.capabilityArtifactRoot()
          if (root !== null) targets.paths = [root]
        } else if (call.name === 'browser_open' || call.name === 'browser_navigate') {
          // 主动浏览的导航目标同样要能被任务 grant 的域名约束复验。
          const domain = domainFromToolArgs(call.arguments)
          if (domain !== null) targets.domains = [domain]
        } else if (call.name === 'web_open' || call.name === 'web_navigate') {
          // 普通网页与 B 站共用主动浏览能力：显式 URL 按真实域名复验；
          // 只给搜索词时按配置的搜索起点域名复验。解析不到就给空目标，
          // 让带约束的 grant fail closed。
          targets.domains = webCapabilityTargetDomains(
            call.arguments,
            call.name,
            this.configRef.worlds.browserControl.searchUrl
          )
        } else if (call.name.startsWith('bili_')) {
          // B 站工具没有 url 参数，但实际访问的站点是固定的；给出真实域名，
          // 让任务 grant 的 domains 约束能生效（解析不到时 fail closed）。
          targets.domains = biliCapabilityTargetDomains(call.name)
        } else if (call.name === 'sys_open_app') {
          // app.launch 的 grant 按可执行文件进程名收窄；appId 与进程名不同，
          // 必须从当前配置解析。解析不到时给空目标，让 CapabilityStore fail closed。
          const appId = appIdFromToolArgs(call.arguments)?.trim().toLowerCase() ?? null
          const app =
            appId === null || appId === ''
              ? undefined
              : this.configRef.worlds.system.apps.find(
                  (entry) => entry.id.trim().toLowerCase() === appId
                )
          const key = app === undefined ? null : normalizeProcessKey(app.path)
          targets.apps = key === null ? [] : [key]
        } else if (call.name === 'sys_open_path') {
          targets.paths = this.systemWorld.resolveOpenPathTarget(call.arguments) ?? []
        } else if (call.name === 'sys_open_url') {
          // 参数名是 target，而不是 url；解析不到时给空数组，让排除名单/约束复验拒绝。
          const domain = domainFromToolArgs(call.arguments)
          targets.domains = domain === null ? [] : [domain]
        }
        return Object.keys(targets).length === 0 ? undefined : targets
      },
      episodeContext: (episodeId) => this.episodeContextFor(episodeId),

      sharedActivityContext: () =>
        this.sharedActivity.contextText('core', this.coordinator.status()),
      onToolResult: (info) => this.recordToolExperience(info),
      onWakeDecision: (decision, input) => {
        if (input.meta?.['wakeKind'] !== 'reaction') return
        // 诊断链：事件进入唤醒调度时先记下决策（接受/推迟/暂停/安静）。
        const eventId =
          typeof input.meta?.['eventId'] === 'string' ? input.meta['eventId'] : null
        this.activityWorld.noteSceneTrace(eventId, {
          stage: 'decision',
          outcome: decision.mode === 'flush' ? 'accepted' : 'deferred',
          reason: decision.reason
        })
        if (decision.mode === 'flush') return
        // 不再把“这一拍没说话”笼统记成 silent。忙碌/用户安静/关闭分别可见，
        // 便于区分“她判断不需要回应”和“系统现在没让她进入模型”。
        if (decision.reason === 'busy') {
          this.metrics.noteReaction('busy-deferred', 'busy')
        } else if (decision.reason === 'speech-quiet' || decision.reason === 'quiet') {
          this.metrics.noteReaction('user-quiet', decision.reason)
        } else if (decision.reason === 'paused' || decision.reason === 'disabled') {
          this.metrics.noteReaction('cancelled', `wake-${decision.reason}`)
        } else {
          this.metrics.noteReaction('silent', decision.reason)
        }
      },
      onProviderFailure: (notice) => {
        this.lastProviderFailure = notice
        if (this.reactionCycle !== null) this.reactionCycle.providerFailed = true
        // 完整诊断已由 Core 以“模型请求失败详情”写出一条；这里不再重复写
        // 容易被误解为“结构化输出错误”的第二条失败记录。
        this.scheduleStatusBroadcast()
      },
      onTurnReport: (report) => this.recordTurnReport(report),
      persona: this.persona,
      ...(options.toolExposureMode === undefined
        ? {}
        : { toolExposureMode: options.toolExposureMode }),
      worlds: [
        this.chatWorld,
        this.petWorld,
        this.activityWorld,
        this.browserWorld,
        this.browserControlWorld,
        this.bilibiliWorld,
        this.filesWorld,
        this.appsWorld,
        this.systemWorld,
        this.workspaceWorld,
        this.webWorld,
        this.terminalWorld,
        this.tasksWorld,
        this.cuaWorld,
        this.desktopWorld
      ],
      ...(options.clock === undefined ? {} : { clock: options.clock })
    })
    this.tasks.bindRuntime({
      pushEvent: (input) => {
        this.core.pushEvent(input)
      },
      timers: this.core.timers,
      abortCycle: (reason) => this.core.abortTaskCycle(reason)
    })

    this.quickTools = new QuickToolGatewayImpl({
      sessionId: () => this.session.id,
      getConfig: () => this.configRef,
      executor: this.core.executor,
      registry: this.core.registry,
      gate: this.gate,
      ...(options.toolExposureMode === undefined
        ? {}
        : { toolExposureMode: options.toolExposureMode }),
      ...(options.clock === undefined ? {} : { now: () => options.clock!.now() })
    })

    this.quickChat = new QuickChatService({
      onRecordsChanged: records => this.dispatchTap(records === null ? { type: 'conversation_reset' } : { type: 'conversation_append', history: buildChatHistory(records) }),
      conversationRuntime: this.core.conversationRuntime,
      budgetCalibrator: this.budgetCalibrator,
      provider: this.provider,
      hasApiKey: () => this.provider.hasApiKey(),
      getConfig: () => this.configRef,
      usage: this.usage,
      logger: this.logger,
      tools: this.quickTools,
      buildSystemPrompt: (episodeContext) => {
        // 提示词只列本轮真正可见的规范工具；可用组目录说明如何加载其他领域。
        const toolNames = this.quickTools.visibleNames()
        const backdrop = this.persona.companionBackdrop?.() ?? null
        return buildQuickChatSystemPrompt(this.configRef, this.persona.memoryStore, {
          toolsEnabled: toolNames.length > 0,
          toolNames,
          toolCatalog: this.quickTools.catalogText(),
          cuaEnabled: toolNames.some(
            (name) => name.startsWith('cua_') || name === 'screen_observe'
          ),
          ...(episodeContext === undefined ? {} : { episodeContext }),
          ...(backdrop === null ? {} : { backdrop })
        })
      },
      summarize: async (messages, signal) => {
        const result = await this.core.spawnFork({
          purpose: 'quick-summary',
          messages,
          maxTokens: 160,
          signal
        })
        return result.text
      },
      appendRecent: (note) => this.persona.memoryStore.appendRecent(note),
      requestPromptRefresh: () => this.core.requestSystemPromptRefresh(),

      onReset: () => this.sessions.clearTopic()
    })
  }

  private createBilibiliService(options: BotOptions): BilibiliService | null {
    const resourcesDir = options.bilibiliResourcesDir
    const crypto = options.biliCrypto
    // 测试/非 Electron 装配没有资源或安全存储时必须显式缺席，不能退回明文
    // 保存凭据，也不能假装 Python 服务可用。
    if (resourcesDir === undefined || crypto === undefined) return null
    try {
      return new BilibiliService({
        rootDir: this.rootDir,
        resourcesDir,
        logger: this.logger,
        crypto,
        getConfig: () => this.configRef,
        ...(options.clock === undefined ? {} : { now: () => options.clock!.now() }),
        ...(options.biliOpenPath === undefined ? {} : { openPath: options.biliOpenPath })
      })
    } catch (error) {
      this.logger.error('B 站阅读服务初始化失败', { error: String(error).slice(0, 200) })
      return null
    }
  }

  private biliVisionState(): { available: boolean; reason: string | null } {
    if (!this.configRef.worlds.bilibili.vision.enabled) {
      return { available: false, reason: 'B 站画面辅助已关闭' }
    }
    if (!this.configRef.provider.visionInput) {
      return { available: false, reason: '当前模型的图片输入已关闭' }
    }
    return { available: true, reason: null }
  }

  // ------------------------------------------------------------------ 生命周期

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    // 先清理过期终态任务，再恢复排队/中断的任务；恢复只改状态与定时器，
    // 不在这里 pushEvent，等 Core 启动后再唤醒，避免投递到未启动的总线。
    this.tasks.prune()
    const recovered = this.tasks.recoverAfterRestart()
    await this.core.start()
    // 恢复登录/分区与环境探测可能需要几秒；不阻塞桌宠启动。真正调用工具前
    // World 仍会逐次复验服务状态与用户同意。
    if (this.bilibiliService !== null) {
      void this.bilibiliService.start().catch((error: unknown) => {
        this.logger.warn('B 站阅读服务启动失败', { error: String(error).slice(0, 200) })
      })
    }
    const resumed = this.tasks.resumeRecovered()
    if (recovered.changed > 0 || resumed > 0) {
      this.logger.info('任务恢复结果', {
        changed: recovered.changed,
        waiting: recovered.waiting,
        resumed
      })
    }
    if (this.state.get('paused') === true) {
      this.core.pause('restore')
    }
    // 说话安静与探索暂停是两件事，重启后分别恢复；探索暂停期间被暂停的
    // 自主任务只恢复由本次暂停接管的那些，不碰用户自己暂停的任务。
    this.restoreCompanionState()
    // 低频指标采样：进程资源与模型用量增量；不含任何内容。
    this.metrics.noteProcessSample()
    this.metrics.sampleUsage(this.usage.summary())
    this.metricsTimer = setInterval(() => {
      this.metrics.noteProcessSample()
      this.metrics.sampleUsage(this.usage.summary())
    }, 60_000)
    this.metricsTimer.unref?.()
    // 无人访问时也要让过期 Episode 触发“未回答”回调并落盘。
    this.episodePersistence.startTicking(() => this.scheduleStatusBroadcast())
    this.logger.info('Bot 已启动', {
      model: this.configRef.provider.model,
      hasApiKey: this.provider.hasApiKey(),
      workspace: this.configRef.worlds.workspace.root.trim() === '' ? null : '[configured]',
      // 运行构建与实际网络栈；下次失败时可核对日志是否来自被检查的源码/安装包。
      appVersion: this.appVersion,
      electron: process.versions['electron'] ?? null,
      node: process.versions.node,
      chrome: process.versions.chrome ?? null,
      undici: process.versions['undici'] ?? null,
      fetchImplementation: this.provider.fetchKind,
      endpointOrigin: this.provider.endpointOrigin(),
      // 只记录是否设置了代理变量，不记录可能含凭据的 URL。
      proxyEnv: ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].filter(
        (name) => (process.env[name] ?? '').trim() !== ''
      ),
      noProxyEnv: (process.env['NO_PROXY'] ?? process.env['no_proxy'] ?? '').trim() !== ''
    })
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.episodePersistence.stopTicking()
    if (this.metricsTimer !== null) clearInterval(this.metricsTimer)
    this.metricsTimer = null
    this.metrics.noteProcessSample()
    this.metrics.sampleUsage(this.usage.summary())
    if (this.explorePauseTimer !== null) clearTimeout(this.explorePauseTimer)
    this.explorePauseTimer = null
    if (this.statusBroadcastTimer !== null) clearTimeout(this.statusBroadcastTimer)
    this.statusBroadcastTimer = null
    this.episodePersistence.flush()
    // 退出前终止本地转写并重建当天日报；dispose 只清理进程/临时文件，
    // 不删除阅读记录或已写出的日报。
    if (this.bilibiliService !== null) {
      try {
        this.bilibiliService.cancelAllAsr('interrupted')
        this.bilibiliService.finalizeReport()
      } catch (error) {
        this.logger.warn('退出时收尾 B 站阅读失败', {
          error: String(error).slice(0, 200)
        })
      }
    }
    // 先中断快捷流与摘要，再停 Core；退出不生成摘要。
    this.quickChat.dispose()
    this.reactionChannel.stop()
    await this.core.stop()
    this.bilibiliService?.dispose()
    this.coordinator.dispose()
    this.logger.info('Bot 已停止')
  }

  get running(): boolean {
    return this.started && !this.stopped
  }

  // ------------------------------------------------------------------ 配置

  getConfig(): AppConfig {
    return this.configRef
  }

  /**
   * 热更新配置。工作区路径、模型名、行为感知开关等在下一批/下一次请求生效。
   * 顶层字段直接替换，保持引用稳定（Core 与各 World 共享同一对象）。
   */
  updateConfig(next: AppConfig): void {
    const previousCua = {
      enabled: this.configRef.worlds.cua.enabled,
      permission: this.configRef.worlds.cua.permission,
      visionInput: this.configRef.provider.visionInput
    }
    const previousAutonomy = {
      enabled: this.configRef.autonomy.enabled,
      mode: this.configRef.autonomy.mode,
      notesRoot: this.configRef.worlds.workspace.notesRoot
    }
    const previousDesktop = JSON.stringify(this.configRef.worlds.desktop)
    const previousExploration = JSON.stringify(this.configRef.exploration)
    const previousBrowserControl = JSON.stringify(this.configRef.worlds.browserControl)
    const previousBili = JSON.stringify(this.configRef.worlds.bilibili)
    const previousBiliActive = this.bilibiliWorld.active()
    Object.assign(this.configRef, next)
    this.session.hardTokens = hardTokensFor(this.configRef)
    this.activityWorld.refresh()
    this.browserWorld.refresh()
    this.browserControlWorld.refresh()
    this.bilibiliWorld.refresh()
    this.desktopWorld.refresh()
    this.persona.autonomyController.refresh()
    // 聊天档位/安静时段/预算变化下一次考虑即生效，不需要重启。
    this.persona.cadenceController.refresh()
    this.scheduleStatusBroadcast()
    // 自主范围（开关/模式/笔记目录）任何变化都必须让旧目标立刻失效，
    // 包括排队中的定时任务和正在读取/写入的轮次。
    if (
      previousAutonomy.enabled !== this.configRef.autonomy.enabled ||
      previousAutonomy.mode !== this.configRef.autonomy.mode ||
      previousAutonomy.notesRoot !== this.configRef.worlds.workspace.notesRoot
    ) {
      this.tasks.invalidateAutonomyTasks('自主探索授权范围已改变')
    }
    void this.filesWorld.refresh()
    // 自由探索或主动浏览授权变化：旧观察/标签页/任务范围立即失效。
    // 用户撤销授权后，排队中的自主任务不能再凭旧配置继续行动。
    const explorationChanged =
      previousExploration !== JSON.stringify(this.configRef.exploration)
    const browserControlChanged =
      previousBrowserControl !== JSON.stringify(this.configRef.worlds.browserControl)
    const biliChanged = previousBili !== JSON.stringify(this.configRef.worlds.bilibili)
    if (biliChanged && this.bilibiliService !== null) {
      void this.bilibiliService.updateConfig().catch((error: unknown) => {
        this.logger.warn('B 站阅读配置热更新失败', { error: String(error).slice(0, 200) })
      })
    }
    if (
      explorationChanged ||
      browserControlChanged ||
      biliChanged ||
      previousCua.enabled !== this.configRef.worlds.cua.enabled ||
      previousCua.permission !== this.configRef.worlds.cua.permission
    ) {
      // 能力恢复/收紧是相关变化；休息中的自主目标可提前复查。
      this.persona.autonomyController.noteRelevantChange('capability-change')
    }
    if (explorationChanged || browserControlChanged) {
      this.browserControlWorld.refresh()
      this.tasks.invalidateAutonomyTasks('自由探索/主动浏览范围已改变')
      const affected = new Set([
        'browser.control',
        'file.read',
        'file.write',
        'app.launch',
        'desktop.observe',
        'desktop.input'
      ])
      for (const grant of this.capabilities.list()) {
        if (affected.has(grant.capability)) this.capabilities.revoke(grant.id)
      }
      this.gate.rejectMatching(
        (request) =>
          request.toolName.startsWith('browser_') || request.toolName.startsWith('bili_'),
        '自由探索/主动浏览范围已改变，请重新确认'
      )
    }
    // B 站独立 API 路线的开关/同意/限额变化：已铸造的 bilibili.read 授权和
    // 待确认请求立即失效。关闭站点或探索范围时还要结束会话、取消转写和待发分享。
    const biliActiveNow = this.bilibiliWorld.active()
    if (explorationChanged || biliChanged) {
      for (const grant of this.capabilities.list()) {
        if (grant.capability === 'bilibili.read') this.capabilities.revoke(grant.id)
      }
      this.gate.rejectMatching(
        (request) => request.toolName.startsWith('bili_'),
        'B 站阅读授权范围已改变，请重新确认'
      )
    }
    if (previousBiliActive && !biliActiveNow) {
      this.bilibiliWorld.reset()
      this.tasks.invalidateAutonomyTasks('B 站阅读授权范围已改变')
      // 冷却设为 0：这不是用户主动“停止”，重新授权后无需再点一次恢复。
      this.bilibiliService?.stopBrowsing('permission', 0)
    }
    // 撤销/收紧观察授权后不能继续用旧窗口清单、截图基线或变化版本；
    // 轮询会在 refresh() 里按新范围停止，这里清掉已收集的缓存。
    if (explorationChanged) {
      this.desktopWorld.resetInventory()
      this.cuaWorld.invalidateObservations()
      this.gate.rejectMatching(
        (request) =>
          request.toolName.startsWith('cua_') || request.toolName === 'screen_observe',
        '自由探索观察范围已改变，请重新确认'
      )
    }
    // 切换“每次操作都问”时旧 grant 必须立即失效；关闭 CUA 时释放所有输入。
    // 任务预授权同样作废：用户收紧权限后，旧任务不能继续免问操作桌面。
    if (previousCua.permission !== this.configRef.worlds.cua.permission) {
      this.gate.clearGrantsForToolPrefix('cua_')
      for (const grant of this.capabilities.list()) {
        if (grant.taskId !== null && grant.capability.startsWith('desktop.')) {
          this.capabilities.revoke(grant.id)
        }
      }
    }
    if (
      previousCua.enabled &&
      (!this.configRef.worlds.cua.enabled || !this.configRef.provider.visionInput)
    ) {
      void this.stopCua('config-disabled')
    }
    // 桌面范围变化：旧 windowId/缓存立即失效，排队与运行中的自主任务让位，
    // 任务里的 desktop.* grant 一并撤销，下次动作必须重新按新范围授权。
    if (previousDesktop !== JSON.stringify(this.configRef.worlds.desktop)) {
      this.desktopWorld.resetInventory()
      this.tasks.invalidateAutonomyTasks('桌面观察范围已改变')
      for (const grant of this.capabilities.list()) {
        if (grant.taskId !== null && grant.capability.startsWith('desktop.')) {
          this.capabilities.revoke(grant.id)
        }
      }
      this.gate.rejectMatching(
        (request) =>
          (request.toolName.startsWith('win_') && request.toolName !== 'win_list') ||
          request.toolName === 'computer_observe' ||
          request.toolName === 'computer_act' ||
          request.toolName === 'computer_find',
        '桌面观察范围已改变，请重新确认'
      )
    }
    this.core.requestSystemPromptRefresh()
    this.logger.info('配置已热更新', {
      model: this.configRef.provider.model,
      activity: this.configRef.worlds.activity.enabled,
      cua: this.configRef.worlds.cua.enabled
    })
  }

  // ------------------------------------------------------------------ 用户入口

  sendMessage(text: string): EventEnvelope | null {
    return this.sendMessageWithDiscovery(text).event
  }

  /**
   * 完整聊天发送；同时返回这条消息接住的发现卡片。
   * 卡片只在用户真的回应主动开场后展示，不会自己弹窗或打开链接。
   */
  sendMessageWithDiscovery(text: string): {
    event: EventEnvelope | null
    discovery: DiscoveryCardView | null
  } {
    if (!this.running) return { event: null, discovery: null }
    this.noteUserInput()
    this.petWorld.noteUserText(text)
    // 用户接管对话：还没投递的旧反应评论不能再插到这条消息前面。
    this.dropStaleReactionWakes('user-took-floor', null)
    // 共同操作状态先于本轮事件更新，Core 才能在同一批注入最新目标/观察版本。
    this.sharedActivity.noteUserText(text, 'chat')
    // 新的未回答开场优先；否则沿用仍在有效期内的跨入口话题（即使开场已回答）。
    const route = this.sessions.resolveChatRoute()
    const event = this.chatWorld.submit(text, {
      ...(route.episodeId === undefined ? {} : { episodeId: route.episodeId }),
      // Same-topic context is owned by the shared Session.
    })
    if (event !== null) {
      if (route.openEpisode !== undefined) {
        this.sessions.bindEpisode(route.openEpisode.id)
      }

      if (route.openEpisode !== undefined) this.markEpisodeAnswered(route.openEpisode)
    }
    // 已回答但仍绑定的交接话题也要能拿回卡片：用户可能先在快捷入口回应，
    // 再在完整聊天里说“刚才那个视频”。和快捷入口共用同一套回退规则。
    return {
      event,
      discovery:
        event === null ||
        route.activeEpisode?.discoveryId === null ||
        route.activeEpisode?.discoveryId === undefined
          ? null
          : this.persona.discoveryStore.card(route.activeEpisode.discoveryId)
    }
  }

  /** 用户接住了主动开场：重置聊天退避，并记一次兴趣对话（不存原话）。 */
  private markEpisodeAnswered(episode: ConversationEpisode): void {
    if (!this.episodes.markAnswered(episode.id)) return
    // 用户接住了这个话题：解除已展示话题的防重复窗口，后续进展可以继续。
    this.companionCandidates.noteAnswered(episode.id)
    this.metrics.noteEpisode('answered')
    this.persona.cadenceController.noteUserActivity(this.nowMs())
    if (episode.interestId !== null) {
      this.persona.interestStore.noteTalk(episode.interestId, this.nowMs())
    }
    this.episodePersistence.scheduleSave()
    this.scheduleStatusBroadcast()
  }

  /** 按 id 取主动开场衔接文本；已回答但未过期/未被替代的仍可取用。 */
  episodeContextFor(episodeId: string): string | null {
    const episode = this.episodes.get(episodeId)
    if (episode === undefined || episode.supersededAt !== null) return null
    return episodeContextText(episode)
  }

  /** 保留给现有调用方；解析规则只在 SessionRouter 维护。 */
  resolveProactiveEpisode(episodeId?: string): ConversationEpisode | undefined {
    return this.sessions.resolveQuickRoute(episodeId).episode
  }

  markProactiveEpisodeAnswered(episodeId: string): void {
    this.episodes.markAnswered(episodeId)
  }

  /**
   * 快捷入口发送：解析主动开场 → 当轮注入安全衔接 → 成功后标记已接住。
   * 失败/忙/无 Key 不改 Episode，气泡仍可再次点击。
   */
  sendQuickMessage(text: string, episodeId?: string): QuickSendResult {
    // 快捷入口同样代表用户在场：解除接管保持期，并重置聊天退避/冷却。
    this.noteUserInput()
    this.petWorld.noteUserText(text)
    this.dropStaleReactionWakes('user-took-floor', null)
    // 共同操作状态先更新，本轮的快捷回复立即看到用户刚提出的/结束的目标。
    this.sharedActivity.noteUserText(text, 'quick-chat')
    const episode = this.sessions.resolveQuickRoute(episodeId).episode
    const episodeText = episode === undefined ? null : this.episodeContextFor(episode.id)
    // 完整聊天刚说过的话必须当轮可见，不能等异步摘要，也不能要求开启长期记忆；
    // 快捷面板关闭后自己的内存历史会清空，所以连自己的片段也一并带上。
    const handoffText = null
    const sharedText = this.sharedActivity.contextText('quick-chat', this.coordinator.status())
    const context = [sharedText, episodeText, handoffText]
      .filter((part): part is string => part !== null && part.trim() !== '')
      .join('\n\n')
    const result = this.quickChat.send(text, {
      ...(context === '' ? {} : { episodeContext: context })
    })
    if (result.ok) {
      if (episode !== undefined) {
        this.sessions.bindEpisode(episode.id)
        this.markEpisodeAnswered(episode)
      }

    }
    const discovery =
      result.ok && episode?.discoveryId !== null && episode?.discoveryId !== undefined
        ? this.persona.discoveryStore.card(episode.discoveryId)
        : null
    return discovery === null ? result : { ...result, discovery }
  }

  /** 设置页的发现列表：只含展示字段，不含观察凭据或页面原文。 */
  discoveryListView(): DiscoveryListView {
    const store = this.persona.discoveryStore
    const config = this.configRef.worlds.browserControl
    const bili = this.configRef.worlds.bilibili
    return {
      // 网页主动浏览与 B 站独立阅读共用同一份发现；任一入口已开启并同意
      // 就可回看，不能因为另一条路线关闭而把已有发现标成不可用。
      enabled:
        (config.enabled && config.consentAt !== null) ||
        (bili.enabled && bili.consentAt !== null),
      memoryOnly: store.hasEphemeral(),
      items: store.cards(),
      total: store.count(),
      retentionDays: config.discoveries.retentionDays,
      maxRecords: config.discoveries.maxRecords
    }
  }

  deleteDiscovery(id: string): ChatActionResult {
    if (!this.persona.discoveryStore.delete(id)) {
      return { ok: false, message: '没有找到这条发现。' }
    }
    // 阅读记录只保留有发现依据的条目；删除条目后连同当天日报一起重建。
    this.bilibiliService?.removeReadingByDiscoveryIds([id])
    // 删除/清空发现时一并撤掉还没显示的分享气泡，不能让旧队列随后把
    // 已删除的内容补回桌面；其他发现的气泡保留。
    this.petWorld.cancelPendingDiscoveryShares(
      'discovery-deleted',
      (pendingId) => pendingId !== id
    )
    this.reconcileDiscoveryRefs()
    this.scheduleStatusBroadcast()
    return { ok: true, message: '已删除这条发现。' }
  }

  clearDiscoveries(): ChatActionResult {
    const had = this.persona.discoveryStore.count() > 0
    // 先记下关联的 B 站阅读记录；清空后再按 id 重建受影响日期的日报。
    const discoveryIds = this.persona.discoveryStore
      .list()
      .filter((record) => record.site === 'bilibili')
      .map((record) => record.id)
    this.persona.discoveryStore.clear()
    if (discoveryIds.length > 0) {
      this.bilibiliService?.removeReadingByDiscoveryIds(discoveryIds)
    }
    this.petWorld.cancelPendingDiscoveryShares('discoveries-cleared')
    this.reconcileDiscoveryRefs()
    this.scheduleStatusBroadcast()
    return { ok: true, message: had ? '已清空发现列表。' : '发现列表已经是空的。' }
  }

  /** 记忆关键词删除：同步清理兴趣/经历/指纹/发现，并让 Episode 引用失效。 */
  forgetCompanionMatching(query: string): ReturnType<WhaleGirlPersona['forgetCompanionMatching']> {
    const store = this.persona.discoveryStore
    const biliBefore = new Set(
      store
        .list()
        .filter((record) => record.site === 'bilibili')
        .map((record) => record.id)
    )
    const removed = this.persona.forgetCompanionMatching(query)
    // forgetMatching 可能只删掉其中部分发现；只取消/清理已经不存在的那几条。
    const gone = [...biliBefore].filter((id) => store.get(id) === null)
    if (gone.length > 0) this.bilibiliService?.removeReadingByDiscoveryIds(gone)
    this.petWorld.cancelPendingDiscoveryShares(
      'discovery-forgotten',
      (pendingId) => store.get(pendingId) !== null
    )
    this.reconcileDiscoveryRefs()
    this.scheduleStatusBroadcast()
    return removed
  }

  noteDiscoveryFeedback(id: string, kind: DiscoveryFeedbackKind): ChatActionResult {
    const result = this.persona.discoveryStore.noteFeedback(id, kind)
    if (!result.ok) return { ok: false, message: result.message }
    this.scheduleStatusBroadcast()
    return { ok: true, message: '已记下反馈。' }
  }

  /**
   * 用户点开发现：重新校验规范 URL 后交给主进程 shell.openExternal。
   * 模型/页面内容都不能直接提供打开的网址。
   */
  discoveryOpenUrl(id: string): { ok: true; url: string } | { ok: false; message: string } {
    const record = this.persona.discoveryStore.get(id)
    if (record === null) return { ok: false, message: '没有找到这条发现。' }
    // 统一发现：B 站按视频规范链接，普通网页按公开 URL 规则重新校验；
    // 两边都只返回重新构造出的规范地址，不信任记录里的原始字符串。
    const url = discoveryCardUrl(record)
    if (url === '') return { ok: false, message: '这条发现的链接不合法。' }
    this.persona.discoveryStore.markOpened(id)
    this.scheduleStatusBroadcast()
    return { ok: true, url }
  }

  /**
   * 屏幕陪伴台词的独立短请求：没有工具、没有图片、没有主对话历史。
   * 只带脱敏摘要与最近短句；解析失败最多修复一次，之后按 invalid-output。
   */
  private async generateScreenFeedback(
    input: ScreenFeedbackGenerationInput
  ): Promise<ScreenFeedbackGenerationOutput> {
    if (input.signal.aborted) {
      throw new ScreenFeedbackGenerationError('cancelled', '屏幕陪伴请求已取消')
    }
    const config = this.configRef
    const backdrop = this.persona.companionBackdrop?.() ?? null
    const messages: ModelMessage[] = [
      { role: 'system', content: buildScreenFeedbackSystemPrompt(config, backdrop) },
      {
        role: 'user',
        content: buildScreenFeedbackUserPrompt({
          observation: {
            category: input.observation.category,
            activity: input.observation.activity,
            appLabel: input.observation.appLabel,
            phase: input.observation.phase,
            game: input.observation.game,
            change: input.observation.change,
            detail: input.observation.detail,
            confidence: input.observation.confidence
          },
          recent: input.recent,
          allowQuestion: input.allowQuestion,
          trigger: input.trigger
        })
      }
    ]
    const fork = async (
      purpose: string,
      requestMessages: ModelMessage[],
      maxTokens: number
    ): Promise<string> => {
      try {
        const result = await this.core.spawnFork({
          purpose,
          messages: requestMessages,
          maxTokens,
          signal: input.signal
        })
        return result.text
      } catch (error) {
        if (input.signal.aborted) {
          throw new ScreenFeedbackGenerationError('cancelled', '屏幕陪伴请求已取消')
        }
        throw new ScreenFeedbackGenerationError(
          'provider-failed',
          String(error).slice(0, 120)
        )
      }
    }
    const raw = await fork('screen-feedback', messages, 220)
    let reply = parseScreenFeedbackReply(raw)
    if (reply === null) {
      // 有界修复：一次；仍不合格就放弃，不无限重试，也不把原文当台词。
      const repaired = await fork(
        'screen-feedback-repair',
        [
          ...messages,
          { role: 'assistant' as const, content: raw.slice(0, 1200) },
          {
            role: 'user' as const,
            content:
              '上一次回复不符合 JSON 契约。请只输出一个合法 JSON 对象：{"kind":"comment"|"question"|"skip","text"或"reason":"..."}；不要解释、不要代码围栏。'
          }
        ],
        160
      )
      reply = parseScreenFeedbackReply(repaired)
    }
    if (reply === null) {
      throw new ScreenFeedbackGenerationError('invalid-output', '屏幕陪伴回复不是合法 JSON')
    }
    if (reply.kind === 'skip') {
      return {
        kind: 'skip',
        ...(reply.reason === undefined ? {} : { reason: reply.reason })
      }
    }
    return {
      kind: reply.kind,
      ...(reply.text === undefined ? {} : { text: reply.text })
    }
  }

  /** 统一走 PetWorld 的屏幕反馈入口；返回真实页面回执，不猜成功。 */
  private async deliverScreenFeedback(
    input: ScreenFeedbackDeliveryInput
  ): Promise<ScreenFeedbackDeliveryResult> {
    try {
      return await this.petWorld.displayScreenFeedback(input)
    } catch (error) {
      this.logger.warn('屏幕陪伴展示链路异常', {
        error: String(error).slice(0, 120)
      })
      return { outcome: 'failed', reason: 'host-error' }
    }
  }

  /** 任务/自主/屏幕 pet_say → Episode；只记录安全字段，不读笔记正文。 */
  private handleProactiveSay(input: {
    text: string
    taskId?: string
    kind?: 'comment' | 'question' | 'proposal' | 'task_update'
    pendingQuestion?: string
    discoveryId?: string
    channel?: 'screen_feedback'
    feedbackId?: string
    observationId?: string
    now: number
  }): { episodeId?: string; rejected?: string } | undefined {
    const openingText = input.text.trim()
    if (openingText === '') return undefined
    // 分享 id 必须真实存在；模型不能凭记忆编一个发现，也不能在已删除后继续用。
    const proposedDiscovery =
      input.discoveryId === undefined
        ? null
        : this.persona.discoveryStore.get(input.discoveryId)
    if (input.discoveryId !== undefined && proposedDiscovery === null) {
      return { rejected: '这条发现已经不存在；不要凭记忆分享或补造链接。' }
    }
    const task = input.taskId === undefined ? undefined : this.tasks.get(input.taskId)
    const open = this.episodes.latestOpenQuestion()
    const candidate = this.buildCompanionCandidate(input, proposedDiscovery, task)
    // 所有主动气泡——探索发现、任务进展、屏幕评论和自然聊天——只在这里
    // 进入同一个表达闸门。来源控制器仍拥有各自的采样/生成/队列；这里不再
    // 重写一套近似规则，也不保存第二份候选正文。
    const admission = this.companionCandidates.admit(candidate, {
      now: input.now,
      userTurnActive: this.core.isUserTurnActive() || this.quickChat.isUserTurnActive(),
      // 同一任务续问自己的问题不算“叠一个新问题”；不同任务仍要退避。
      hasOpenQuestion:
        open !== undefined && (input.taskId === undefined || open.taskId !== input.taskId)
    })
    if (admission.decision !== 'admit') {
      if (this.reactionCycle !== null) {
        this.metrics.noteReaction('render-rejected', admission.reason)
      }
      return { rejected: rejectionText(admission.reason) }
    }
    // 屏幕陪伴：来源与话题固定为通用标签，Episode 只留在内存；屏幕原文/
    // 摘要/窗口信息不进入开场记录，也不参与发现分享。
    if (input.channel === 'screen_feedback') {
      const episode = this.episodes.openOrUpdate({
        source: 'screen',
        taskId: null,
        openingText,
        ...(input.kind === 'comment' || input.kind === 'question'
          ? { kind: input.kind }
          : {}),
        topic: '屏幕陪伴',
        ...(input.pendingQuestion === undefined
          ? {}
          : { pendingQuestion: input.pendingQuestion }),
        persistable: false
      })
      this.companionCandidates.bindEpisode(episode.id, candidate.id)
      this.episodePersistence.scheduleSave()
      this.scheduleStatusBroadcast()
      return { episodeId: episode.id }
    }
    const source: 'autonomy' | 'task' =
      task?.source === 'autonomy' || input.taskId === undefined ? 'autonomy' : 'task'
    const artifact =
      input.taskId === undefined ? null : this.workspaceWorld.lastNoteArtifact(input.taskId)
    // 分享发现时优先用发现自己的短摘要/理由，避免把任务进度混进这段衔接。
    const recordSummary =
      proposedDiscovery === null
        ? ''
        : safeDiscovery(
            proposedDiscovery.summary !== ''
              ? proposedDiscovery.summary
              : proposedDiscovery.reason
          )
    const discovery =
      recordSummary ||
      safeDiscovery(checkpointSummary(task?.checkpoint ?? null) ?? '') ||
      safeDiscovery(task?.intent ?? '')
    if (proposedDiscovery !== null) {
      // 即将被替代/覆盖的旧开场不能留下永远 pending 的分享状态。
      for (const staleId of this.episodes.staleDiscoveryIdsForOpen(
        input.taskId ?? null,
        proposedDiscovery.id
      )) {
        this.persona.discoveryStore.markDiscovered(staleId)
      }
    }
    const episode = this.episodes.openOrUpdate({
      source,
      taskId: input.taskId ?? null,
      interestId: task?.interestId ?? null,
      openingText,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(task === undefined ? {} : { topic: task.title }),
      ...(artifact === null
        ? {}
        : { artifact: { path: artifact.path, title: artifact.title } }),
      ...(discovery === '' ? {} : { discovery }),
      ...(proposedDiscovery === null ? {} : { discoveryId: proposedDiscovery.id }),
      ...(input.pendingQuestion === undefined
        ? {}
        : { pendingQuestion: input.pendingQuestion }),
      // 网页/屏幕来源的发言只留在内存衔接，不跨重启落盘；发现分享也属于
      // 网页来源，标题/摘要只进专门的 DiscoveryStore，不复制进 episodes.json。
      persistable: proposedDiscovery === null && !this.core.isPageDerived()
    })
    this.companionCandidates.bindEpisode(episode.id, candidate.id)
    if (proposedDiscovery !== null) {
      this.persona.discoveryStore.markPendingShare(proposedDiscovery.id)
    }
    this.episodePersistence.scheduleSave()
    this.scheduleStatusBroadcast()
    return { episodeId: episode.id }
  }

  /**
   * 把不同来源的开口事实整理成统一候选。候选中没有任何台词正文；
   * 发现/观察/任务 id 只作为真实依据引用，供仲裁和展示回执关联。
   */
  private buildCompanionCandidate(
    input: {
      taskId?: string
      kind?: 'comment' | 'question' | 'proposal' | 'task_update'
      pendingQuestion?: string
      discoveryId?: string
      channel?: 'screen_feedback'
      feedbackId?: string
      observationId?: string
      now: number
    },
    discovery: ReturnType<WhaleGirlPersona['discoveryStore']['get']>,
    task: ReturnType<TaskRunner['get']>
  ): CompanionCandidate {
    const kind =
      input.kind ??
      (input.pendingQuestion !== undefined ? ('question' as const) : ('comment' as const))
    if (input.channel === 'screen_feedback') {
      // 画面是否仍新鲜由 ScreenCompanionController 用同一时钟判定；这里只给
      // 已生成台词一个短暂的投递窗口，避免把控制器的时效规则再抄一遍。
      return {
        id: randomUUID(),
        source: 'screen',
        evidenceKind: 'observation',
        evidenceRef: input.observationId ?? input.feedbackId ?? null,
        topicId: input.observationId ?? input.feedbackId ?? null,
        createdAt: input.now,
        expiresAt: input.now + 2 * 60_000,
        interruptible: false,
        shared: false,
        kind: kind === 'question' ? 'question' : 'comment'
      }
    }
    if (discovery !== null && discovery !== undefined) {
      return {
        id: randomUUID(),
        source: 'discovery',
        evidenceKind: 'discovery',
        evidenceRef: discovery.id,
        topicId: discovery.id,
        createdAt: discovery.discoveredAt,
        // 发现本身按保留策略长期存在；能不能现在说取决于它是否已分享。
        expiresAt: null,
        interruptible: false,
        shared: discovery.shareState !== 'discovered',
        kind: kind === 'question' ? 'question' : 'comment'
      }
    }
    if (task !== undefined) {
      return {
        id: randomUUID(),
        source: 'task',
        evidenceKind: 'task',
        evidenceRef: task.id,
        topicId: task.interestId ?? task.id,
        createdAt: input.now,
        expiresAt: null,
        interruptible: false,
        shared: false,
        kind
      }
    }
    return {
      id: randomUUID(),
      source: 'autonomy',
      evidenceKind: 'none',
      evidenceRef: null,
      // 没有任务/发现的自主开口按“当前探索进展”归类；不伪造依据引用。
      topicId: null,
      createdAt: input.now,
      expiresAt: null,
      interruptible: false,
      shared: false,
      kind
    }
  }

  /** World 的发现端口适配：模型只能通过观察 token 保存，不能自带 URL。 */
  private discoveryPort(): BrowserDiscoveryPort & BiliDiscoveryPort {
    const store = this.persona.discoveryStore
    return {
      noteObservation: (input) => store.noteObservation(input),
      findByVideo: (videoId, partId) => store.getByVideo(videoId, partId),
      clearObservations: () => store.clearObservations(),
      count: () => store.count(),
      isEnabled: () => store.isEnabled()
    }
  }

  /** 带发现 id / 屏幕反馈 id 的气泡终态：失败必须回滚并取消开场。 */
  private handlePetSayResult(result: PetSayResult): void {
    if (result.episodeId !== undefined) {
      if (result.outcome === 'displayed') {
        // 只有真实页面回执才算“说过”；生成成功但被抑制/取消不建立话题去重。
        this.companionCandidates.markDisplayed(result.episodeId, this.nowMs())
      } else {
        this.companionCandidates.cancelEpisode(result.episodeId)
        if (this.episodes.cancel(result.episodeId)) this.episodePersistence.scheduleSave()
      }
    }
    if (result.discoveryId !== undefined) {
      const record = this.persona.discoveryStore.get(result.discoveryId)
      if (record !== null) {
        if (record.shareState === 'discovered') {
          this.persona.discoveryStore.markPendingShare(result.discoveryId)
        }
        if (result.outcome === 'displayed') {
          this.persona.discoveryStore.markShared(result.discoveryId)
        } else {
          this.persona.discoveryStore.markDiscovered(result.discoveryId)
        }
      }
    }
    if (result.outcome !== 'displayed' && result.reason !== undefined) {
      // 只记录固定原因/ID；屏幕摘要与台词正文不进入日志。
      this.logger.info(
        result.channel === 'screen_feedback' ? '屏幕陪伴气泡未显示' : '发现分享气泡未显示',
        {
          outcome: result.outcome,
          reason: result.reason.slice(0, 80),
          ...(result.feedbackId === undefined ? {} : { feedbackId: result.feedbackId }),
          ...(result.observationId === undefined
            ? {}
            : { observationId: result.observationId })
        }
      )
    }
    this.scheduleStatusBroadcast()
  }

  /**
   * 停止浏览/接管页面：作废停止前的页面观察、取消队列里的主动气泡，
   * 并标记停止时仍在途的回合，防止它稍后用旧结果补发主动气泡（尤其是
   * 发现分享）。已经显示出来的气泡保留。
   */
  private handleBrowsingStopped(reason: BrowseStopReason, hadSession: boolean): void {
    if (hadSession && this.core.isBusy()) {
      this.petWorld.noteStaleProactiveTurn(this.core.currentTurnId())
    }
    // 只作废普通网页观察：独立 B 站有自己的停止/清理路径，不能被浏览器
    // 停止连带清空（反之亦然）。
    const cleared = this.persona.discoveryStore.clearObservations(DISCOVERY_SITE_WEB)
    const cancelled = this.petWorld.cancelPendingProactiveSays(`browse-${reason}`)
    if (cancelled > 0 || cleared > 0) {
      this.logger.info('停止主动浏览：作废观察并取消待展示分享', {
        clearedObservations: cleared,
        cancelled,
        reason
      })
    }
    this.scheduleStatusBroadcast()
  }

  /** 独立 B 站 API 路线被用户/撤权/账号变化停下时的清理。 */
  private handleBiliStopRequested(
    reason: 'user' | 'permission' | 'shutdown' | 'login' | 'account'
  ): void {
    this.bilibiliWorld.reset()
    if (this.core.isBusy()) {
      this.petWorld.noteStaleProactiveTurn(this.core.currentTurnId())
    }
    const cleared = this.persona.discoveryStore.clearObservations(DISCOVERY_SITE_BILIBILI)
    // 只取消 B 站的待发发现，普通网页分享仍按自己的停止/删除语义处理。
    const cancelled = this.petWorld.cancelPendingDiscoveryShares(
      `bili-api-${reason}`,
      (id) => this.persona.discoveryStore.get(id)?.site !== DISCOVERY_SITE_BILIBILI
    )
    if (cancelled > 0 || cleared > 0) {
      this.logger.info('停止 B 站阅读：作废观察并取消待展示分享', {
        clearedObservations: cleared,
        cancelled,
        reason
      })
    }
    this.scheduleStatusBroadcast()
  }

  /** 登录账号切换/退出登录：旧分区的会话、观察和待发分享不能跨账号复活。 */
  private handleBiliAccountChanged(reason: 'switch' | 'logout' | 'expired'): void {
    this.bilibiliWorld.reset()
    if (this.core.isBusy()) {
      this.petWorld.noteStaleProactiveTurn(this.core.currentTurnId())
    }
    this.persona.discoveryStore.clearObservations(DISCOVERY_SITE_BILIBILI)
    this.petWorld.cancelPendingDiscoveryShares(
      `bili-account-${reason}`,
      (id) => this.persona.discoveryStore.get(id)?.site !== DISCOVERY_SITE_BILIBILI
    )
    this.core.requestSystemPromptRefresh()
    this.scheduleStatusBroadcast()
  }

  /** 本地转写结束：给它一次提前复查的机会，让它自己决定是否读取并评价。 */
  private handleBiliAsrTerminal(job: BiliAsrJobView): void {
    if (job.state === 'cancelled' || job.state === 'interrupted') return
    // 转写完成是可信宿主事件：下一轮自主复查前预载 B 站读取组，
    // 避免只看到目录却无法读取刚完成的结果。预载不授权、不执行动作。
    if (job.state === 'succeeded') {
      this.core.preloadToolGroups(['bilibili', 'discovery'], 'bili-asr-ready')
    }
    this.persona.autonomyController.requestReview(
      job.state === 'succeeded' ? 'bili-asr-ready' : 'bili-asr-terminal'
    )
    this.core.requestSystemPromptRefresh()
    this.scheduleStatusBroadcast()
  }

  /** 发现被删除/清空后，Episode 里的引用同步失效。 */
  private reconcileDiscoveryRefs(): number {
    const store = this.persona.discoveryStore
    const cleared = this.episodes.pruneDiscoveries((id) => store.get(id) !== null)
    if (cleared > 0) this.episodePersistence.scheduleSave()
    return cleared
  }

  /**
   * 用户主动输入（完整聊天或快捷聊天）：解除「用户接管」保持期。
   * 只解除 hold，不会自动恢复暂停/等待中的任务。
   */
  noteUserInput(): void {
    this.petWorld.notifyUserInteraction()
    // 用户开始说话：在途/排队的屏幕台词立即作废，回复优先级最高。
    this.screenCompanion.noteUserInput(this.nowMs())
    this.coordinator.noteUserActivity()
    this.persona.cadenceController.noteUserActivity(this.nowMs())
    this.core.noteUserActivity()
    this.scheduleStatusBroadcast()
  }

  stopGeneration(): void {
    if (!this.running) return
    this.chatWorld.requestStop()
    this.petWorld.notifyUserInteraction()
    // 用户夺回发言权：旧屏幕候选不再补说。
    this.screenCompanion.noteUserInput(this.nowMs())
  }

  markCleared(): void {
    // 完整聊天的「清空对话」也是明确的“话题结束”，不能把片段留给下一段。
    this.sessions.clearTopic()
    this.sharedActivity.clear()
    this.handoffBatch = null
    this.biliReports = []
    this.core.markCleared()
  }

  /**
   * 设置页「清空本地数据」：清除聊天会话、事件库、记忆、活动统计/原始采样、
   * 撤销快照、提醒、用量与日志。配置、API Key、桌宠外观与工作区文件都保留。
   */
  async clearLocalData(): Promise<{ ok: boolean; message: string }> {
    if (this.clearing) return { ok: false, message: '正在清空本地数据，请稍候。' }
    this.clearing = true
    // 先丢弃快捷上下文并阻止排队中的摘要，避免清空后又写回 recent.md。
    this.quickChat.clear()
    this.core.conversationRuntime.clearBackgrounds()
    const wasPaused = this.core.isPaused()
    let pausedForClear = false
    let idle = true
    try {
      // 停止后台浏览/独立 B 站阅读并丢掉尚未展示的主动分享，避免清空后
      // 旧页面结果或转写又冒出来。
      this.browserControlWorld.stopBrowsing('shutdown')
      this.bilibiliWorld.reset()
      this.biliReports = []
      this.bilibiliService?.stopBrowsing('shutdown', 0)
      this.petWorld.cancelPendingProactiveSays('cleared')
      // 先中断当前轮并等它收尾，避免旧上下文在清空后又被写回。
      this.core.clearConversation()
      if (this.running && this.core.isBusy()) {
        // 暂停中的总线不会触发 Core 的空闲通知，改用短轮询等待轮次收尾。
        idle = wasPaused
          ? await this.waitForClearIdle(6000)
          : await this.core.waitUntilIdle(6000)
      }
      if (this.running && !wasPaused) {
        this.core.pause('clear-local-data')
        pausedForClear = true
      }

      this.session.replaceAll([])
      this.session.resetRounds()
      this.events.clear()
      this.persona.memoryStore.clearAll()
      this.persona.clearRoleplayState()
      this.persona.clearCompanionData()
      // 发现已被清空，关联的阅读记录与日报也不能留在盘上。
      this.bilibiliService?.clearReading()
      this.activityWorld.clearStats()
      this.activityWorld.clearRawSamples()
      this.activityWorld.clearTimeline()
      this.browserWorld.clear()
      this.core.clearAutonomyState()
      // 任务及其临时授权一并清空；跑协程的定时器随后由 timers.clear() 清理。
      this.tasks.clear()
      this.gate.clearGrants()
      this.persona.autonomyController.reset()
      this.exploreCycle = null
      this.exploreEmptyStreak = 0
      this.lastExploreFallbackAt = 0
      this.workspaceWorld.clearNoteArtifacts()
      this.sessions.clearAll()
      this.companionCandidates.clear()
      this.sharedActivity.clear()
      this.handoffBatch = null
      this.episodePersistence.flush()
      this.workspaceWorld.clearUndo()
      this.core.timers.clear()
      this.usage.reset()
      this.clearLogs()
      this.metrics.reset()
      this.logger.info('本地数据已由用户清空', {
        pendingTurn: !idle
      })

      return {
        ok: true,
        message: idle
          ? '已清空聊天、事件、记忆、活动统计、撤销快照、提醒、用量与日志；设置和 API Key 已保留。'
          : '已清空现有本地数据；一个未能立即中断的任务收尾后可能写入少量新的诊断日志。设置和 API Key 已保留。'
      }
    } catch (error) {
      this.logger.error('清空本地数据失败', { error: String(error) })
      return { ok: false, message: `清空本地数据失败：${String(error)}` }
    } finally {
      // 无论成功失败都恢复用户原本的暂停状态，避免清理把助手留在暂停。
      if (pausedForClear) this.core.resume()
      this.clearing = false
    }
  }

  private async waitForClearIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.core.isBusy()) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return !this.core.isBusy()
  }

  private clearLogs(): void {
    let names: string[]
    try {
      names = readdirSync(this.logsDir)
    } catch {
      return
    }
    for (const name of names) {
      // 指标归档同样属于本地数据；当前 metrics 文件由 metrics.reset() 截断。
      if (/^companion-metrics-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) {
        try {
          rmSync(join(this.logsDir, name))
        } catch {
          /* 日志清不掉不应阻塞其他数据清除 */
        }
        continue
      }
      if (!/^app-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name !== 'audit.jsonl') continue
      try {
        writeFileSync(join(this.logsDir, name), '', 'utf8')
      } catch {
        /* 日志清不掉不应阻塞其他数据清除 */
      }
    }
  }

  pause(reason = 'manual'): void {
    this.core.pause(reason)
  }

  resume(): void {
    this.core.resume()
  }

  isPaused(): boolean {
    return this.core.isPaused()
  }

  isBusy(): boolean {
    return this.core.isBusy()
  }

  // ------------------------------------------------------------------ 陪伴节奏

  /** 暂时别说话：只压主动聊天；探索与任务继续。 */
  setSpeechQuietUntil(until: number | null): void {
    const now = this.nowMs()
    const at =
      until === null || !Number.isFinite(until) || until <= now ? 0 : Math.floor(until)
    this.core.setSpeechQuietUntil(at > 0 ? at : null)
    this.persona.cadenceController.setSpeechQuietUntil(at > 0 ? at : null, now)
    this.scheduleStatusBroadcast()
  }

  /** 暂停探索：新自主 tick 停下，当前自主任务转 paused；到期自动恢复。 */
  setExplorePausedUntil(until: number | null): void {
    const now = this.nowMs()
    const at =
      until === null || !Number.isFinite(until) || until <= now ? 0 : Math.floor(until)
    this.state.set(EXPLORE_PAUSE_KEY, at > 0 ? at : null)
    this.persona.autonomyController.setExplorePausedUntil(at > 0 ? at : null)
    if (this.explorePauseTimer !== null) {
      clearTimeout(this.explorePauseTimer)
      this.explorePauseTimer = null
    }
    if (at > 0) {
      this.pauseActiveAutonomyTasks()
      this.scheduleExplorePauseTimer(at)
    } else {
      this.resumeExplorePausedTasks()
    }
    this.scheduleStatusBroadcast()
  }

  companionState(): {
    speechQuietUntil: number
    explorePausedUntil: number
    unansweredEpisode: boolean
    wantsToTalk: boolean
  } {
    const now = this.nowMs()
    const speech = this.stateTime(SPEECH_QUIET_KEY, now)
    return {
      speechQuietUntil: speech,
      explorePausedUntil: this.persona.autonomyController.explorePausedUntilAt,
      unansweredEpisode: this.episodes.hasOpen(),
      wantsToTalk: this.persona.cadenceController.wantsToTalk(now)
    }
  }

  /** 设置页用的屏幕陪伴窄状态；只有 ID/枚举/时间/计数。 */
  screenCompanionStatus(): ScreenCompanionStatusView {
    return this.screenCompanion.status()
  }

  /**
   * 「一次陪伴反馈测试」：消费当前有效摘要，或请求下一次正常采样刷新。
   * 不提高截图频率、不绕过开关/同意/安静；是否真的开口仍由真实回执决定。
   */
  screenCompanionTest(): ScreenCompanionTestResultView {
    const result = this.screenCompanion.test(
      this.activityWorld.currentScreenObservation()
    )
    let message: string
    if (result.mode === 'immediate') {
      message = '已用当前屏幕摘要发起一次测试；只有气泡真实显示才算成功。'
    } else if (result.mode === 'scheduled') {
      message = '当前没有可用摘要，已请求在下一次正常采样刷新；不会提高截图频率。'
    } else {
      message = screenTestBlockedMessage(result.reason)
    }
    return {
      ok: result.mode !== 'blocked',
      mode: result.mode,
      message
    }
  }

  /**
   * 自主活动状态：有效范围来自与提示词/任务授权相同的 effectiveCapabilities，
   * 文件范围另附统一解析器的版本化摘要。
   * 只有计数/枚举；不输出目录、进程名、域名、标题或密钥。
   */
  autonomyReadiness(now = this.nowMs()): AutonomyReadinessView {
    const config = this.configRef
    const caps = effectiveCapabilities(config, {
      notesRootAvailable: this.workspaceWorld.notesRootOrNull() !== null
    })
    const controller = this.persona.autonomyController
    const diag = controller.diagnostics(now)
    const wake = this.core.wakeDeferral('autonomy')
    // 与设置页/诊断使用同一份快照：运行时断线、目录失效或缺少同意时，
    // 不再因为某个授权布尔值为真就判定“有探索范围”。
    const snapshot = this.capabilitySnapshot(now)
    const scopeAvailable = capabilitySnapshotReady(snapshot)
    const reasons = new Set<string>()
    if (!config.autonomy.enabled) reasons.add('autonomy-disabled')
    if (config.autonomy.mode !== 'explore') reasons.add('mode-not-explore')
    if (!this.provider.hasApiKey()) reasons.add('provider-key-missing')
    if (!scopeAvailable) reasons.add('no-effective-scope')
    const controllerBlocker = controller.blocker(now)
    if (controllerBlocker !== null) reasons.add(controllerBlocker)
    if (wake.reason === 'disabled' || wake.reason === 'paused' || wake.reason === 'quiet') {
      reasons.add(`wake-${wake.reason}`)
    }
    if (caps.notesConfigured && !caps.notesAvailable) reasons.add('notes-unavailable')
    if (caps.inputApps.length > 0) {
      if (!caps.cua || !config.provider.visionInput) reasons.add('cua-not-ready')
      else if (!config.worlds.desktop.windowCapture) reasons.add('window-capture-off')
    }
    const hardBlocked =
      !config.autonomy.enabled ||
      config.autonomy.mode !== 'explore' ||
      !this.provider.hasApiKey() ||
      !scopeAvailable
    const scopeReasons = scopeAvailable
      ? []
      : [
          ...new Set(
            snapshot.cards.flatMap((card) =>
              card.checks
                .filter((item) => item.state !== 'ready')
                .map((item) => `${item.label}：${item.reason ?? '不可用'}`)
            )
          )
        ].slice(0, 3)
    const blockers = [...reasons]
    const nextScheduled = typeof diag.nextAt === 'number' ? diag.nextAt : null
    const nextGuaranteedAt = hardBlocked
      ? null
      : nextScheduled === null
        ? wake.at
        : wake.at === null
          ? nextScheduled
          : Math.max(nextScheduled, wake.at)

    // 能力维度：只放“实际缺什么”，不把休息、忙碌、已有任务算成受限。
    const capabilityReasons = [
      ...new Set(
        blockers.filter((reason) =>
          [
            'autonomy-disabled',
            'mode-not-explore',
            'provider-key-missing',
            'no-effective-scope',
            'notes-unavailable',
            'cua-not-ready',
            'window-capture-off'
          ].includes(reason)
        )
      )
    ]
    const capability = {
      state: hardBlocked
        ? ('blocked' as const)
        : capabilityReasons.length > 0
          ? ('limited' as const)
          : ('ready' as const),
      reasons: capabilityReasons,
      scopeReasons
    }

    // 调度维度：她是在等下一次机会、正在执行、休息、暂停，还是被关闭。
    const restUntil = typeof diag.restUntil === 'number' ? diag.restUntil : null
    const restReason = typeof diag.restReason === 'string' ? diag.restReason : null
    const restMode =
      diag.restMode === 'quiet' || diag.restMode === 'waiting' || diag.restMode === 'rest'
        ? diag.restMode
        : null
    const waitFor = typeof diag.restWaitFor === 'string' ? diag.restWaitFor : null
    const quietUntil = typeof diag.quietUntil === 'number' ? diag.quietUntil : null
    const quietReason = typeof diag.quietReason === 'string' ? diag.quietReason : null
    const reviewAt = typeof diag.restReviewAt === 'number' ? diag.restReviewAt : null
    const reviewReason =
      typeof diag.restReviewReason === 'string' ? diag.restReviewReason : null
    const consecutiveRests =
      typeof diag.consecutiveRests === 'number' ? diag.consecutiveRests : 0
    const restRoundRatio =
      typeof diag.restRoundRatio === 'number' ? diag.restRoundRatio : null
    const minutesSinceRealProgress =
      typeof diag.minutesSinceRealProgress === 'number'
        ? diag.minutesSinceRealProgress
        : null
    let scheduleState: AutonomyScheduleState = 'ready'
    let scheduleReason: string | null = null
    if (!config.autonomy.enabled) {
      scheduleState = 'disabled'
      scheduleReason = 'autonomy-disabled'
    } else if (controllerBlocker === 'explore-paused' || controllerBlocker === 'paused') {
      scheduleState = 'paused'
      scheduleReason = controllerBlocker
    } else if (controllerBlocker === 'waiting-condition') {
      scheduleState = 'waiting-condition'
      scheduleReason = 'autonomy-waiting'
    } else if (controllerBlocker === 'explicit-rest' || restUntil !== null) {
      scheduleState = 'resting'
      scheduleReason = 'explicit-rest'
    } else if (quietUntil !== null) {
      scheduleState = 'quiet'
      scheduleReason = 'quiet-background'
    } else if (controllerBlocker === 'busy') {
      scheduleState = 'active'
      scheduleReason = 'busy'
    } else if (controllerBlocker === 'active-autonomy-task') {
      scheduleState = 'active'
      scheduleReason = 'active-autonomy-task'
    } else if (controllerBlocker === 'not-started') {
      scheduleState = 'blocked'
      scheduleReason = 'not-started'
    } else if (
      wake.reason === 'quiet' ||
      wake.reason === 'disabled' ||
      wake.reason === 'paused'
    ) {
      scheduleState = 'waiting'
      scheduleReason = `wake-${wake.reason}`
    } else if (nextGuaranteedAt !== null && nextGuaranteedAt > now) {
      scheduleState = 'waiting'
      scheduleReason = 'next-scheduled'
    }

    const lastRoundKinds = Array.isArray(diag.lastRoundKinds)
      ? diag.lastRoundKinds.filter((kind): kind is string => typeof kind === 'string')
      : []
    const rawRoundState = diag.lastRoundState
    const lastRound: AutonomyReadinessView['lastRound'] = {
      at: typeof diag.lastOutcomeAt === 'number' ? diag.lastOutcomeAt : null,
      progressKinds: lastRoundKinds,
      failures: typeof diag.lastRoundFailures === 'number' ? diag.lastRoundFailures : 0,
      nextState:
        rawRoundState === 'progress' ||
        rawRoundState === 'rest' ||
        rawRoundState === 'no_progress'
          ? rawRoundState
          : 'unknown'
    }

    return {
      state: hardBlocked ? 'blocked' : blockers.length > 0 ? 'limited' : 'ready',
      capability,
      schedule: {
        state: scheduleState,
        reason: scheduleReason,
        nextAt: nextGuaranteedAt,
        restUntil,
        restReason,
        mode: restMode,
        waitFor,
        quietUntil,
        quietReason,
        reviewAt,
        reviewReason,
        consecutiveRests,
        restRoundRatio,
        minutesSinceRealProgress
      },
      lastRound,
      lastFallback: this.lastExploreFallback,
      effectiveScope: effectiveScopeSummary(caps),
      fileScope: (() => {
        const scope = this.filesWorld.fileScopeSnapshot()
        return {
          version: scope.version,
          active: scope.active,
          mode: scope.mode,
          modeLabel: scope.modeLabel,
          readRoots: scope.readRoots.length,
          unavailableRoots: scope.unavailableRoots,
          includesWorkspace: scope.includesWorkspace,
          includesNotes: scope.includesNotes,
          volumeUnavailable: scope.volumes.unavailable
        }
      })(),
      lastProgressAt: typeof diag.lastProgressAt === 'number' ? diag.lastProgressAt : null,
      lastProgressKind:
        typeof diag.lastProgressKind === 'string' ? diag.lastProgressKind : null,
      nextGuaranteedAt,
      blocker: blockers[0] ?? null,
      blockers,
      scopeReasons,
      wakeReason: wake.reason === 'eligible' ? null : wake.reason,
      wakeDeferredAt: wake.at,
      abandonedCandidates: Array.isArray(diag.abandonedCandidates)
        ? diag.abandonedCandidates
            .filter(
              (entry): entry is { at: number; topic: string; reason: string } =>
                entry !== null &&
                typeof entry === 'object' &&
                typeof (entry as { at?: unknown }).at === 'number' &&
                typeof (entry as { topic?: unknown }).topic === 'string' &&
                typeof (entry as { reason?: unknown }).reason === 'string'
            )
            .slice(0, 8)
            .map((entry) => ({ at: entry.at, topic: entry.topic, reason: entry.reason }))
        : []
    }
  }

  /** 当前任务是否在继续一个已到回访时间的兴趣；只用于状态推导。 */
  isRevisitTask(interestId: string | null): boolean {
    if (interestId === null) return false
    const interest = this.persona.interestStore.get(interestId)
    return (
      interest !== undefined &&
      interest.status === 'active' &&
      interest.nextRevisitAt !== null &&
      interest.nextRevisitAt <= this.nowMs()
    )
  }

  /**
   * 快捷面板的三类轻量反馈。只改她自己的节奏/兴趣状态，不授予任何权限；
   * 不保存用户原话，诊断只记录枚举。
   */
  applyCompanionFeedback(
    kind: 'more' | 'less' | 'stop' | 'quiet',
    episodeId?: string
  ): { ok: boolean; message: string } {
    const now = this.nowMs()
    if (kind === 'quiet') {
      this.setSpeechQuietUntil(now + 30 * 60_000)
      return { ok: true, message: '接下来 30 分钟不主动说话；探索可以继续。' }
    }
    const episode =
      episodeId === undefined || episodeId === ''
        ? this.episodes.latestOpen()
        : this.episodes.get(episodeId)
    if (episode === undefined || episode.supersededAt !== null) {
      return { ok: false, message: '没有正在进行的话题。' }
    }
    this.episodes.markFeedback(episode.id, kind)
    this.persona.cadenceController.noteFeedback(kind === 'stop' ? 'stop_topic' : kind, now)
    if (episode.interestId !== null) {
      if (kind === 'more') {
        this.persona.interestStore.update(episode.interestId, {
          nextRevisitMinutes: 30,
          now
        })
      } else if (kind === 'less') {
        this.persona.interestStore.update(episode.interestId, {
          nextRevisitMinutes: 180,
          now
        })
      } else {
        this.persona.interestStore.update(episode.interestId, {
          status: 'paused',
          now
        })
      }
    }
    this.episodePersistence.scheduleSave()
    this.core.requestSystemPromptRefresh()
    this.scheduleStatusBroadcast()
    return {
      ok: true,
      message:
        kind === 'more'
          ? '会多聊一点这个话题。'
          : kind === 'less'
            ? '会少提这个话题。'
            : '先换个话题。'
    }
  }

  /** 模型通过 companion_feedback 记录的自然语言反馈；同样只调整节奏。 */
  private applyModelFeedback(feedback: CompanionFeedback): void {
    this.persona.cadenceController.noteFeedback(feedback.kind, feedback.at)
    const open = this.episodes.latestOpen()
    if (
      open !== undefined &&
      feedback.interestId !== null &&
      open.interestId === feedback.interestId
    ) {
      const mapped: EpisodeFeedback | null =
        feedback.kind === 'more' || feedback.kind === 'less'
          ? feedback.kind
          : feedback.kind === 'stop_topic'
            ? 'stop'
            : null
      if (mapped !== null) this.episodes.markFeedback(open.id, mapped)
      this.episodePersistence.scheduleSave()
    }
    this.scheduleStatusBroadcast()
  }

  // ------------------------------------------------------------------ 表现桥接

  setPetSink(sink: PetPresentationSink | null): void {
    this.petSink = sink
    this.petWorld.setSink(sink)
  }

  setTerminalSink(sink: TerminalSink | null): void {
    this.terminalWorld.setSink(sink)
  }

  setWebObserver(observer: WebObserver | null): void {
    this.webWorld.setObserver(observer)
  }

  /** 聊天窗订阅所有 Core tap（批次、流式文本、工具、用量、轮次结束）。 */
  onTap(listener: (event: TapEvent) => void): () => void {
    this.tapListeners.add(listener)
    return () => this.tapListeners.delete(listener)
  }

  onUserMessage(listener: (event: EventEnvelope) => void): () => void {
    this.userMessageListeners.add(listener)
    return () => this.userMessageListeners.delete(listener)
  }

  /** 聊天窗订阅「本轮阅读」卡；实时事件丢失时可用 biliSessionReports() 恢复。 */
  onBiliReport(listener: (report: BiliSessionReportView) => void): () => void {
    this.biliReportListeners.add(listener)
    return () => this.biliReportListeners.delete(listener)
  }

  biliSessionReports(): BiliSessionReportView[] {
    return this.biliReports.slice()
  }

  private recordBiliSessionReport(report: BiliSessionReportView): void {
    this.biliReports.push(report)
    if (this.biliReports.length > MAX_BILI_SESSION_REPORTS) {
      this.biliReports.splice(0, this.biliReports.length - MAX_BILI_SESSION_REPORTS)
    }
    for (const listener of this.biliReportListeners) {
      try {
        listener(report)
      } catch (error) {
        this.logger.warn('B 站本轮阅读监听器异常', { error: String(error).slice(0, 200) })
      }
    }
  }

  onApprovalRequest(listener: (request: ApprovalRequest) => void): () => void {
    return this.gate.onRequest(listener)
  }

  onApprovalResolved(
    listener: (request: ApprovalRequest, decision: ApprovalDecision) => void
  ): () => void {
    return this.gate.onResolved(listener)
  }

  onApprovalPendingChange(listener: (count: number) => void): () => void {
    return this.gate.onPendingChange(listener)
  }

  notifyUserInteraction(): void {
    this.petWorld.notifyUserInteraction()
  }

  /**
   * 桌宠 dsh-pet 的触摸/拖拽。affinity 最多每 3 分钟记一次；事件由 PetWorld
   * 按 reactions 档位再限频（最多每 2 分钟），不会为每次触摸调用模型。
   */
  noteTouch(kind: PetInteractionKind): void {
    const now = this.nowMs()
    this.petWorld.notifyUserInteraction()
    // 触摸是“用户在场”的真实信号：每次都重置聊天退避，但 affinity 仍限频。
    this.persona.cadenceController.noteUserActivity(now)
    this.core.noteUserActivity(now)
    if (this.lastTouchAffinityAt === null || now - this.lastTouchAffinityAt >= 3 * 60_000) {
      this.lastTouchAffinityAt = now
      this.persona.noteUserTouch(now)
    }
    this.petWorld.noteTouch(kind)
    this.scheduleStatusBroadcast()
  }

  /** 热键/状态条/锁屏/设置页共用的紧急停止。 */
  async stopCua(reason: string): Promise<void> {
    this.gate.rejectMatching(
      (request) =>
        request.toolName.startsWith('cua_') ||
        request.toolName === 'screen_observe' ||
        request.toolName === 'win_capture' ||
        request.toolName === 'win_focus' ||
        request.toolName === 'computer_observe' ||
        request.toolName === 'computer_act' ||
        request.toolName === 'computer_find',
      '电脑操作已停止'
    )
    // 任务同样立即让出桌面：撤销当前租约，任务转 waiting_user，不自动抢回。
    this.coordinator.hold(`紧急停止：${reason}`)
    this.tasks.noteUserStop(reason)
    this.core.abortTaskCycle('user-stop')
    this.core.executor.abortInterruptible('chat')
    this.core.executor.abortInterruptible('quick')
    this.desktopWorld.resetInventory()
    await this.cuaWorld.forceStop(reason)
    this.logger.info('已请求停止电脑操作', { reason: reason.slice(0, 40) })
  }

  /** 运行时注入动作标记/状态反馈；不包含截图、坐标文字或窗口标题。 */
  setCuaSink(sink: CuaSink | null): void {
    this.cuaWorld.setSink(sink)
  }

  cuaStatus(): CuaStatus {
    return this.cuaWorld.status()
  }

  /** 设置页候选应用；只含进程键/标签，不含窗口标题。 */
  runningDesktopApps(): Promise<Array<{ process: string; label: string }>> {
    return this.desktopWorld.listRunningApps()
  }

  /** 设置页“清除电脑操作授权”：只清 CUA 与桌面任务的授权，不影响其它工具。 */
  clearCuaGrants(): void {
    this.gate.clearGrantsForToolPrefix('cua_')
    for (const grant of this.capabilities.list()) {
      if (grant.capability.startsWith('desktop.')) this.capabilities.revoke(grant.id)
    }
    this.desktopWorld.resetInventory()
  }

  // ------------------------------------------------------------------ 审批 / 撤销

  listApprovals(origin?: ApprovalOrigin): ApprovalRequest[] {
    return this.gate.list(origin)
  }

  resolveApproval(id: string, approved: boolean, scope: ApprovalScope = 'once'): boolean {
    return this.resolveApprovalFor('chat', id, approved, scope)
  }

  /** 快捷面板只能确认 origin=quick 的审批，避免拿到完整聊天的审批 id 越权。 */
  resolveQuickApproval(id: string, approved: boolean, scope: ApprovalScope = 'once'): boolean {
    return this.resolveApprovalFor('quick', id, approved, scope)
  }

  private resolveApprovalFor(
    origin: ApprovalOrigin,
    id: string,
    approved: boolean,
    scope: ApprovalScope
  ): boolean {
    const request = this.gate.list(origin).find((entry) => entry.id === id)
    if (request === undefined) return false
    // 用户处理审批是真实交互，退出自主空闲资格。
    this.petIdlePolicy.markActivity()
    return this.gate.resolve(id, {
      approved,
      ...(approved && scope !== 'once' ? { grantScope: scope } : {})
    })
  }

  /** 快捷聊天的工具/审批活动；不包含工具参数或截图。 */
  quickActivity(): {
    running: string[]
    cua: boolean
    pendingApproval: ApprovalRequest | null
  } {
    const active = this.quickTools.active()
    return {
      running: active.running,
      cua: active.cua,
      pendingApproval: this.quickTools.pendingApproval()
    }
  }

  // ------------------------------------------------------------------ 任务

  /** 任务列表/状态变化；只广播脱敏 TaskView，不含截图或输入文字。 */
  onTasksChanged(listener: (tasks: TaskView[]) => void): () => void {
    this.taskListeners.add(listener)
    return () => this.taskListeners.delete(listener)
  }

  taskViews(limit = 50): TaskView[] {
    return this.tasks.views().slice(0, Math.max(1, limit))
  }

  taskView(id: string): TaskView | null {
    return this.tasks.views().find((task) => task.id === id) ?? null
  }

  pauseTask(id: string): boolean {
    return this.tasks.pauseTask(id)
  }

  resumeTask(id: string): boolean {
    // 用户点击恢复即视为回到桌面：解除接管保持期，但不会自动恢复其它任务。
    this.coordinator.noteUserActivity()
    const ok = this.tasks.resumeTask(id)
    if (ok) {
      // 用户手动恢复过的任务不再由探索暂停到期事件接管。
      if (this.explorePausedTaskIds.includes(id)) {
        this.explorePausedTaskIds = this.explorePausedTaskIds.filter((entry) => entry !== id)
        this.persistExplorePausedTasks()
      }
      this.core.requestSystemPromptRefresh()
      this.scheduleStatusBroadcast()
    }
    return ok
  }

  cancelTask(id: string, reason = '用户取消'): boolean {
    return this.tasks.cancelTask(id, reason)
  }

  capabilityViews(): ReturnType<CapabilityStore['view']> {
    return this.capabilities.view()
  }

  revokeCapability(id: string): boolean {
    const grant = this.capabilities.get(id)
    const ok = this.capabilities.revoke(id)
    if (ok && grant?.capability.startsWith('desktop.')) {
      this.desktopWorld.resetInventory()
    }
    if (ok && grant?.taskId != null) {
      const task = this.tasks.get(grant.taskId)
      if (task?.source === 'autonomy') {
        // 自主探索没有可等待的用户指令：撤销授权必须连排队中的任务一起停掉。
        this.tasks.cancelTask(grant.taskId, '自主任务授权被撤销')
      } else {
        // UI 撤销任务 grant 等同收紧任务范围：阻止本任务后续动作。
        this.tasks.noteUserStop('任务授权被撤销')
      }
    }
    return ok
  }

  coordinatorStatus(): ReturnType<DesktopActionCoordinator['status']> {
    return this.coordinator.status()
  }

  undoLast(count = 1): Array<{ ok: boolean; message: string }> {
    return this.workspaceWorld.undoLast(count)
  }

  undoCount(): number {
    return this.workspaceWorld.undoCount()
  }

  undoList(): Array<{ kind: string; at: number; path: string }> {
    return this.workspaceWorld.undoList()
  }

  // ------------------------------------------------------------------ 活动感知

  setActivityPaused(paused: boolean): void {
    this.activityWorld.setPaused(paused)
  }

  isActivityPaused(): boolean {
    return this.activityWorld.isUserPaused()
  }

  isActivitySampling(): boolean {
    return this.activityWorld.isSampling()
  }

  /**
   * 仅供设置页「她看到了什么」的本地 IPC。原始进程名不会写日志、
   * 不会进入事件库或模型上下文；调用方也不得持久化。
   */
  activityRawSamples(): Array<{
    processName: string
    category: ActivityCategory
    durationMinutes: number
    at: number
  }> {
    return this.activityWorld.recentRawSamples()
  }

  clearActivityRawSamples(): void {
    this.activityWorld.clearRawSamples()
  }

  todayActivity(): ReturnType<ActivityWorld['todayStats']> {
    return this.activityWorld.todayStats()
  }

  sessionActivity(): ReturnType<ActivityWorld['sessionStats']> {
    return this.activityWorld.sessionStats()
  }

  /**
   * 本机桥入口：接收扩展的页面描述。内容只留在 BrowserWorld 内存，
   * 不写日志、事件库或会话；发送被限频时也只是更新当前页。
   */
  ingestBrowserPage(payload: BrowserPagePayload): ReturnType<BrowserWorld['ingestPage']> {
    return this.browserWorld.ingestPage(payload)
  }

  browserPageStatus(): ReturnType<BrowserWorld['status']> {
    return this.browserWorld.status()
  }

  /** 主进程在创建 BrowserBridge 后注入；Bot 构造时桥尚不存在。 */
  setBrowserControlPort(port: BrowserControlPort | null): void {
    this.browserControlWorld.setPort(port)
  }

  browserControlStatus(): ReturnType<BrowserControlWorld['status']> {
    return this.browserControlWorld.status()
  }

  /**
   * 统一能力快照：已保存授权 + World 前置条件 + 刚观察到的运行时事实。
   *
   * 设置页、自主就绪诊断与诊断包共用它；草稿不得进入这里。快照只用于展示
   * 与调度，真正执行仍由 CapabilityStore 按当前配置逐次复验。
   */
  /** 设置页卷清单；refresh=true 会真实枚举一次并返回最新快照。 */
  async volumeScopeView(refresh = false): ReturnType<FilesWorld['volumeScopeView']> {
    return this.filesWorld.volumeScopeView(refresh)
  }

  /** 设置页统一文件范围快照；refresh 只刷新卷事实，不改配置。 */
  async fileScopeView(refresh = false): ReturnType<FilesWorld['fileScopeView']> {
    return this.filesWorld.fileScopeView(refresh)
  }

  capabilitySnapshot(now = this.nowMs()): CapabilitySnapshotView {
    const config = this.configRef
    const browser = this.browserControlStatus().bridge
    const cua = this.cuaStatus()
    const volumes = this.filesWorld.volumeScopeSummary()
    // 范围计数直接来自统一解析器：候选根与可用根不再由快照层重新相加。
    const fileScope = this.filesWorld.fileScopeSnapshot()
    const configuredRoots = fileScope.roots.length
    const bilibiliFacts = this.bilibiliCapabilityFacts()
    const worldFacts = (entry: unknown): {
      enabled: boolean
      available: boolean
      reason: string | null
    } => {
      const value = entry as { available?: unknown; unavailableReason?: unknown }
      return {
        enabled: value.available !== false,
        available: value.available !== false,
        reason: typeof value.unavailableReason === 'string' ? value.unavailableReason : null
      }
    }
    return buildCapabilitySnapshot(
      config,
      {
        notesRootAvailable: this.workspaceWorld.notesRootOrNull() !== null,
        readRootsConfigured: configuredRoots,
        readRootsAvailable: fileScope.readRoots.length,
        fileScope: {
          active: fileScope.active,
          mode: fileScope.mode,
          readRoots: fileScope.readRoots.length,
          unavailableRoots: fileScope.unavailableRoots,
          volumeStatus: fileScope.volumes.status,
          volumeTotal: fileScope.volumes.total,
          volumeReadable: fileScope.volumes.readable,
          volumeAuthorized: fileScope.volumes.authorized,
          volumeUnavailable: fileScope.volumes.unavailable,
          volumeSystem: fileScope.volumes.system,
          version: fileScope.version
        },
        volumes,
        artifactRootAvailable: this.filesWorld.capabilityArtifactRoot() !== null,
        browser: {
          running: browser?.running ?? false,
          extensionConnected: browser?.extensionConnected ?? false,
          controlConnected: browser?.controlConnected ?? false,
          extensionControlConsent: browser?.extensionControlConsent ?? null
        },
        cua: {
          helperHealthy: cua.helperHealthy === true,
          available: cua.available === true
        },
        ...(bilibiliFacts.runtime === undefined ? {} : { bilibili: bilibiliFacts.runtime }),
        worlds: {
          web: worldFacts(this.webWorld),
          files: worldFacts(this.filesWorld),
          apps: worldFacts(this.appsWorld),
          desktop: worldFacts(this.desktopWorld),
          cua: worldFacts(this.cuaWorld),
          system: worldFacts(this.systemWorld),
          browser: worldFacts(this.browserWorld),
          browserControl: worldFacts(this.browserControlWorld),
          bilibili: worldFacts(bilibiliFacts.world)
        }
      },
      { now }
    )
  }

  /**
   * B 站能力卡片的运行时事实。服务不存在时不能假装 ready；配置关闭时
   * 也不把“没有初始化”当成故障。
   */
  private bilibiliCapabilityFacts(): {
    runtime?: NonNullable<CapabilityRuntimeFacts['bilibili']>
    world: { available: boolean; unavailableReason?: string }
  } {
    const service = this.bilibiliService
    if (service === null) {
      const wanted = this.configRef.worlds.bilibili.enabled
      return {
        ...(wanted ? { runtime: { phase: 'fault' as const, loginState: 'unlogged' as const } } : {}),
        world: wanted
          ? { available: false, unavailableReason: 'B 站阅读服务未初始化（缺少资源或安全存储）。' }
          : { available: true }
      }
    }
    try {
      const status = service.status()
      const world =
        status.service.state === 'ready'
          ? { available: true }
          : {
              available: false,
              unavailableReason: status.service.lastError?.message ?? status.phaseLabel
            }
      return {
        runtime: { phase: status.phase, loginState: status.login.state },
        world
      }
    } catch {
      return {
        runtime: { phase: 'fault' as const, loginState: 'error' as const },
        world: { available: false, unavailableReason: '无法读取 B 站阅读服务状态。' }
      }
    }
  }

  /**
   * 自主探索提示词用的能力摘要。只列出快照中真正 ready 的路径；未列出的
   * 能力不能假设可用。全部不可用时给出具体原因，避免“无范围”空转。
   */
  capabilityPromptSummary(): { scopes: string[]; reasons: string[] } {
    const snapshot = this.capabilitySnapshot()
    const scopes: string[] = []
    const reasons: string[] = []
    for (const card of snapshot.cards) {
      for (const item of card.checks) {
        if (item.state === 'ready') {
          if (!scopes.includes(item.label)) scopes.push(item.label)
        } else if (
          item.state === 'fault' ||
          item.state === 'pending-connection' ||
          item.state === 'missing-consent' ||
          item.state === 'directory-unavailable' ||
          item.state === 'expired'
        ) {
          const reason = `${item.label}：${item.reason ?? '不可用'}`
          if (!reasons.includes(reason)) reasons.push(reason)
        }
      }
    }
    return { scopes, reasons: reasons.slice(0, 4) }
  }

  /** 诊断包里的脱敏能力摘要；不含目录、域名、进程名或标题。 */
  capabilityDiagnostics(): Record<string, unknown> {
    return capabilitySnapshotSummary(this.capabilitySnapshot())
  }

  // ------------------------------------------------------------------ 诊断

  async listModels(): Promise<ModelInfo[]> {
    return this.provider.listModels()
  }

  hasApiKey(): boolean {
    return this.provider.hasApiKey()
  }

  diagnostics(): BotDiagnostics {
    return {
      running: this.running,
      phase: this.core.phase,
      queue: this.core.eventQueueSize,
      paused: this.core.isPaused(),
      approvalsPending: this.gate.pendingCount,
      provider: {
        hasApiKey: this.provider.hasApiKey(),
        model: this.configRef.provider.model,
        utilityModel: this.configRef.provider.utilityModel
      },
      core: this.core.diagnostics(),
      persona: this.persona.diagnostics(),
      activity: {
        enabled: this.configRef.worlds.activity.enabled,
        sampling: this.activityWorld.isSampling(),
        userPaused: this.activityWorld.isUserPaused(),
        currentCategory: this.activityWorld.currentCategoryLabel(),
        currentApp: this.activityWorld.currentSnapshot().appLabel,
        timelineEntries: this.activityWorld.timelineSize(),
        today: this.activityWorld.todayStats(),
        vision: this.activityWorld.sceneStatus()
      },
      browserPage: {
        consentAt: this.configRef.worlds.browserPage.consentAt,
        ...this.browserWorld.status()
      },
      browserControl: {
        consentAt: this.configRef.worlds.browserControl.consentAt,
        ...this.browserControlWorld.status()
      },
      system: {
        enabled: this.configRef.worlds.system.enabled,
        apps: this.configRef.worlds.system.apps.length,
        // 固定支持能力，不是用户配置；诊断包不包含目标路径/链接。
        supportedActions: [...SYSTEM_ACTIONS],
        // 诊断包不包含目标路径/链接，只保留工具名与结果。
        recent: this.systemWorld
          .recentActions()
          .slice(-5)
          .map(({ at, tool, ok }) => ({ at, tool, ok }))
      },
      cua: {
        // 不包含截图、坐标、输入文字、窗口标题或前台进程名。
        ...this.cuaWorld.status(),
        consent: this.configRef.worlds.cua.consentAt !== null,
        screenConsent: this.configRef.worlds.cua.screenConsentAt !== null,
        visionInput: this.configRef.provider.visionInput
      },
      tasks: {
        ...this.tasks.diagnostics(),
        // 只保留计数；任务标题/目标/步骤摘要不进入诊断包。
        grants: this.capabilityViews().length
      },
      // 只输出计数与节奏决策枚举；兴趣标题/经历摘要/气泡正文不进入诊断包。
      autonomyReadiness: this.autonomyReadiness(),
      // 统一能力状态的脱敏摘要：只有卡片/检查 id 与状态。
      capabilities: this.capabilityDiagnostics(),
      // 共同会话只输出规模/标签，不输出目标原文、路径或窗口引用。
      sharedActivity: this.sharedActivity.diagnostics(),
      companion: {
        enabled: this.configRef.memory.enabled,
        interests: this.persona.interestStore.countByStatus(),
        experiences: this.persona.experienceStore.count(),
        exploration: this.persona.explorationStore.count(),
        revisitsDue: this.persona.interestStore.dueRevisits().length,
        cadence: this.persona.cadenceController.diagnostics(),
        // 统一主动表达候选项的计数/固定原因；不包含候选正文或依据内容。
        candidateBoard: this.companionCandidates.diagnostics(this.nowMs()),
        speechQuietUntil: this.stateTime(SPEECH_QUIET_KEY) || null,
        explorePausedUntil: this.persona.autonomyController.explorePausedUntilAt || null,
        unansweredEpisode: this.episodes.hasOpen(),
        explorePausedTaskCount: this.explorePausedTaskIds.length,
        // 今日本地指标：只有计数/枚举/资源数值，不含正文、路径或标题。
        metrics: this.metrics.summary(),
        // 本地反应通道的队列/去重状态；同样只有计数与时间，没有事件文本。
        reactionChannel: this.reactionChannel.diagnostics(),
        // 屏幕陪伴：只有状态/固定原因/时间/计数与不可逆 ID，没有摘要或台词。
        screenFeedback: this.screenCompanion.status(),
        // 待机动作/自主移动的资格与冷却；只有时间、动作 ID 和固定枚举。
        idlePolicy: this.petIdlePolicy.diagnostics(),
        // 移动链路聚合：决策摘要读取、模型选择、各阶段回执；不含坐标/正文。
        movement: this.petWorld.movementDiagnostics(),
        // 语义动作选择/真实回执聚合：只有计数和固定拒绝原因，不含轮次键。
        semantic: this.petWorld.semanticDiagnostics()
      },
      // 结构化失败：turnId/source/stage/errorCode/recoveryState，不含正文。
      turnFailures: {
        current: this.currentTurnFailure(),
        recent: this.recentTurnFailures()
      },
      desktop: this.coordinator.status(),
      desktopScope: this.desktopWorld.health(),
      undoCount: this.workspaceWorld.undoCount()
    }
  }

  /** 当前仍需展示的失败；同来源成功轮次会清除，避免伪造“已恢复”。 */
  currentTurnFailure(): TurnFailureView | null {
    return this.lastTurnFailure === null ? null : { ...this.lastTurnFailure }
  }

  /** 近期失败历史；按指纹/来源合并重复，只保留脱敏字段。 */
  recentTurnFailures(): TurnFailureView[] {
    return this.failureHistory.map((item) => ({ ...item, completed: [...item.completed] }))
  }

  private recordTurnReport(report: TurnReport): void {
    const view = turnFailureView(report)
    if (view === null) {
      if (this.lastTurnFailure !== null && this.lastTurnFailure.source === report.source) {
        this.lastTurnFailure = null
      }
      this.scheduleStatusBroadcast()
      return
    }
    // 用户主动停止不是错误，不占用状态条；诊断仍保留这一轮的取消记录。
    this.lastTurnFailure = view.kind === 'cancelled' ? null : view
    this.rememberFailure(view)
    this.scheduleStatusBroadcast()
  }

  private rememberFailure(view: TurnFailureView): void {
    const now = view.at
    const index = this.failureHistory.findIndex(
      (item) =>
        item.source === view.source &&
        item.kind === view.kind &&
        item.stage === view.stage &&
        item.errorCode === view.errorCode &&
        now - item.at <= 10 * 60_000
    )
    if (index >= 0) this.failureHistory.splice(index, 1)
    this.failureHistory.unshift(view)
    if (this.failureHistory.length > 8) this.failureHistory.length = 8
  }

  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    this.logger.log(level, message, data)
  }

  // ------------------------------------------------------------------ 内部

  /** 状态栏/overlay 的真实动作变化；80ms 内合并多次变更。 */
  onStatusChanged(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  scheduleStatusBroadcast(): void {
    if (this.statusListeners.size === 0 || this.statusBroadcastTimer !== null) return
    this.statusBroadcastTimer = setTimeout(() => {
      this.statusBroadcastTimer = null
      for (const listener of this.statusListeners) {
        try {
          listener()
        } catch (error) {
          this.logger.warn('状态广播监听器异常', { error: String(error) })
        }
      }
    }, 80)
    this.statusBroadcastTimer.unref?.()
  }

  private stateTime(key: string, now = this.nowMs()): number {
    let raw: unknown
    try {
      raw = this.state.get(key)
    } catch {
      return 0
    }
    return typeof raw === 'number' && Number.isFinite(raw) && raw > now ? Math.floor(raw) : 0
  }

  private loadExplorePausedTasks(): void {
    const raw = this.state.get(EXPLORE_PAUSED_TASKS_KEY)
    if (!Array.isArray(raw)) return
    this.explorePausedTaskIds = raw
      .filter((id): id is string => typeof id === 'string' && id !== '')
      .slice(0, 50)
  }

  private persistExplorePausedTasks(): void {
    this.state.set(
      EXPLORE_PAUSED_TASKS_KEY,
      this.explorePausedTaskIds.length > 0 ? [...this.explorePausedTaskIds] : null
    )
  }

  /** 重启后分别恢复 speech quiet 与 explore pause；不补发任何错过的内容。 */
  private restoreCompanionState(): void {
    const now = this.nowMs()
    const speech = this.stateTime(SPEECH_QUIET_KEY, now)
    if (speech > 0) this.persona.cadenceController.setSpeechQuietUntil(speech, now)
    const rawPause = this.state.get(EXPLORE_PAUSE_KEY)
    const pause =
      typeof rawPause === 'number' && Number.isFinite(rawPause) && rawPause > 0
        ? Math.floor(rawPause)
        : 0
    if (pause > now) {
      this.setExplorePausedUntil(pause)
      return
    }
    if (pause > 0) this.state.set(EXPLORE_PAUSE_KEY, null)
    this.resumeExplorePausedTasks()
  }

  private pauseActiveAutonomyTasks(): void {
    let changed = false
    for (const task of this.tasks.list(200)) {
      if (task.source !== 'autonomy' || isTerminalTaskState(task.state)) continue
      if (!EXPLORE_PAUSABLE_STATES.has(task.state)) continue
      if (this.explorePausedTaskIds.includes(task.id)) continue
      if (this.tasks.pauseTask(task.id)) {
        this.explorePausedTaskIds.push(task.id)
        changed = true
      }
    }
    if (changed) this.persistExplorePausedTasks()
  }

  private resumeExplorePausedTasks(): void {
    if (this.explorePausedTaskIds.length === 0) return
    const ids = [...this.explorePausedTaskIds]
    this.explorePausedTaskIds = []
    this.persistExplorePausedTasks()
    for (const id of ids) {
      const task = this.tasks.get(id)
      if (task?.source === 'autonomy' && task.state === 'paused') {
        this.tasks.resumeTask(id)
      }
    }
  }

  private scheduleExplorePauseTimer(at: number): void {
    const now = this.nowMs()
    const delay = Math.max(1000, Math.min(at - now, 24 * 60 * 60_000))
    this.explorePauseTimer = setTimeout(() => {
      this.explorePauseTimer = null
      this.expireExplorePause()
    }, delay)
    this.explorePauseTimer.unref?.()
  }

  private expireExplorePause(): void {
    let raw: unknown
    try {
      raw = this.state.get(EXPLORE_PAUSE_KEY)
    } catch {
      raw = null
    }
    const at =
      typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
    if (at > this.nowMs()) {
      this.scheduleExplorePauseTimer(at)
      return
    }
    this.state.set(EXPLORE_PAUSE_KEY, null)
    this.persona.autonomyController.setExplorePausedUntil(null)
    this.resumeExplorePausedTasks()
    this.scheduleStatusBroadcast()
    this.logger.info('探索暂停已到期，自主任务恢复')
  }

  /**
   * 用户真实接管鼠标/键盘：立即吊销桌面租约并让当前任务等待用户。
   * 保持期只由新的用户输入或显式恢复解除，任务不会自动抢回。
   */
  private handleUserTakeover(kind: CuaTakeoverKind): void {
    const label = kind === 'mouse' ? '鼠标' : kind === 'keyboard' ? '键盘' : '键盘/鼠标'
    this.coordinator.hold(`用户接管${label}`)
    this.tasks.noteUserStop(`用户接管了${label}`)
    this.sharedActivity.markInputTakenOver(`用户接管了${label}`)
    this.core.abortTaskCycle('user-takeover')
    this.petWorld.notifyUserInteraction()
    this.logger.info('用户接管，桌面与任务已让出', { kind })
  }

  /**
   * 外部观察事件先更新共同操作会话，再进入本地即时反应。
   * 事件已由各 World 脱敏；这里不读取窗口正文，也不因事件授予任何权限。
   */
  private handleReactiveNotice(notice: ReactiveEventNotice): void {
    // 新证据已经把注意力带到别处：丢弃仍排队、属于旧目标的模型评论。
    // 本地即时动作由 ReactionChannel 自己合并/取消，不受这里影响。
    if (notice.actionAttribution !== 'pet' && notice.targetRef !== null) {
      this.dropStaleReactionWakes('stale-target', notice.targetRef, notice.changeType)
    }
    try {
      this.sharedActivity.noteActivity(notice)
    } catch (error) {
      this.logger.warn('共同操作状态更新失败', { error: String(error).slice(0, 200) })
    }
    this.reactionChannel.note(notice)
  }

  /** keepTargetRef 为 null 时取消全部排队中的反应唤醒。 */
  private dropStaleReactionWakes(
    reason: string,
    keepTargetRef: string | null,
    changeType?: string
  ): void {
    try {
      const removed = this.core.cancelReactionEvents(keepTargetRef)
      if (removed > 0) {
        this.metrics.noteReaction('cancelled', reason)
        // 只记录脱敏引用与固定枚举，便于诊断「是否取消过多」；
        // 不记录事件正文、标题或队列内容。
        this.logger.info('已取消过期的反应唤醒', {
          reason,
          removed,
          keepTargetRef,
          changeType: changeType ?? 'unknown'
        })
      }
    } catch (error) {
      this.logger.warn('取消过期反应唤醒失败', { error: String(error).slice(0, 200) })
    }
  }

  /**
   * 工具真实执行后的本地记录：只接收工具名、来源、任务 id 与安全元数据，
   * 不接触回执正文、截图、窗口标题或输入文字。
   */
  private recordToolExperience(info: ToolResultInfo): void {
    const task = info.taskId === undefined ? undefined : this.tasks.get(info.taskId)
    // 共同会话只关心“她刚做了什么、观察到什么版本”；失败动作也要留下待确认，
    // 所以这段必须早于指标/记忆门槛，并且不接触回执正文。
    try {
      this.sharedActivity.noteToolResult(info, { taskSource: task?.source ?? null })
    } catch (error) {
      this.logger.warn('共同操作工具状态更新失败', { error: String(error).slice(0, 200) })
    }
    const meta = info.meta
    const fingerprint = meta?.fingerprint ?? ''
    const duplicate =
      fingerprint !== '' && this.persona.explorationStore.seen(fingerprint)
    // 指标在记忆开关/来源门槛之前记录；只写工具名、来源与计数。
    this.metrics.noteTool({
      name: info.name,
      source: info.source,
      failed: info.failed,
      duplicate
    })
    if (info.failed || !this.configRef.memory.enabled) return
    const sourceIsOwn = info.source === 'autonomy' || info.source === 'task'
    if (!sourceIsOwn) return
    const interestId = task?.interestId ?? null
    if (meta === undefined) return
    const targetKind = meta.targetKind ?? 'file'
    // 浏览器页面内容按既有隐私约定只留内存：连域名也不落盘，只记指纹。
    const targetRef =
      info.name === 'page_current' ? null : safeTargetRef(targetKind, meta.targetLabel ?? meta.targetRef ?? null)

    // 合并入口按旧操作身份归类：computer_observe 的 text 模式对应旧 win_read，
    // 不应因为统一入口被记成“观察”。缺失旧身份时回退到当前工具名。
    const kind = experienceKindFor(info.meta?.operation ?? info.name)
    if (kind !== null) {
      const verb = experienceVerb(kind)
      const summary =
        targetRef === null ? `${verb}了一些内容` : `${verb}：${targetRef}`
      this.persona.experienceStore.record({
        kind,
        summary,
        tool: info.name,
        targetKind,
        targetRef,
        taskId: info.taskId ?? null,
        interestId
      })
    }

    // 指纹只记录她自己探索/任务轮里的真实读取；普通用户聊天不算她的探索。
    if (meta.fingerprint !== undefined && meta.fingerprint !== '') {
      this.persona.explorationStore.record({
        fingerprint: meta.fingerprint,
        kind: targetKind,
        label: targetRef,
        taskId: info.taskId ?? null,
        interestId
      })
    }

    // notes/ 成果挂到任务关联兴趣；失败/非笔记写入不会进入 artifact。
    if (
      interestId !== null &&
      info.taskId !== undefined &&
      (info.name === 'ws_write' || info.name === 'ws_replace' || info.name === 'ws_move')
    ) {
      for (const artifact of this.workspaceWorld.noteArtifactsFor(info.taskId)) {
        this.persona.interestStore.addArtifact(interestId, artifact.path)
      }
    }
  }

  private dispatchTap(event: TapEvent): void {
    if (
      event.type === 'tool_result' &&
      !event.failed &&
      SELF_DESKTOP_ACTION_TOOLS.has(event.name)
    ) {
      // 只用于判断随后观察到的窗口变化是否由她自己导致；不记录动作内容。
      this.lastPetDesktopActionAt = this.nowMs()
    }
    try {
      this.trackExplore(event)
    } catch (error) {
      this.logger.warn('探索轮跟踪失败', { error: String(error).slice(0, 200) })
    }
    try {
      this.trackReaction(event)
    } catch (error) {
      this.logger.warn('反应轮跟踪失败', { error: String(error).slice(0, 200) })
    }
    try {
      this.trackHandoff(event)
    } catch (error) {
      this.logger.warn('话题交接跟踪失败', { error: String(error).slice(0, 200) })
    }
    for (const listener of this.tapListeners) {
      try {
        listener(event)
      } catch (error) {
        this.logger.warn('tap 监听器异常', { error: String(error) })
      }
    }
  }

  /**
   * 跟踪 explore tick 的实际结果，而不是工具调用次数。
   *
   * 只有成功的新观察、已执行动作、写入并回读的产物或可执行计划算进展；
   * end_turn、表现动作、失败工具、重复读取和只查询状态都算 no_progress。
   * 显式 autonomy_rest 是受尊重的休息，不算空转。连续两轮 no_progress
   * 才启动受限兜底，避免模型反复只结束回合却永远不触发处理。
   */
  private trackExplore(event: TapEvent): void {
    if (event.type === 'batch_start') {
      const exploreTick =
        event.proactive &&
        this.configRef.autonomy.enabled &&
        this.configRef.autonomy.mode === 'explore' &&
        event.events.some((entry) => entry.type === 'system.autonomy')
      // 运行时兜底或模型自建的自主任务不是 explore tick，但它的真实
      // 读写仍是自主探索的结果。只看 batch 标志会把这类任务漏成
      // no_progress（本次 61 分钟运行就漏掉了两份笔记产物）。
      const autonomyTaskKick = event.events.some((entry) => {
        if (entry.type !== 'task.kick') return false
        const taskId = entry.meta?.['taskId']
        return (
          typeof taskId === 'string' &&
          this.tasks.get(taskId)?.source === 'autonomy'
        )
      })
      const tracked = exploreTick || autonomyTaskKick
      this.exploreCycle = tracked ? createExploreCycle() : null
      if (exploreTick) this.metrics.noteConsideration('autonomy', 'tick')
      return
    }
    if (event.type === 'tool_result' && this.exploreCycle !== null) {
      classifyExploreResult(this.exploreCycle, {
        id: event.id,
        name: event.name,
        failed: event.failed === true,
        text: event.text,
        ...(event.meta === undefined ? {} : { meta: event.meta })
      })
      return
    }
    if (event.type !== 'batch_end' || this.exploreCycle === null) return
    const cycle = this.exploreCycle
    this.exploreCycle = null
    if (event.outcome !== 'done') return
    const summary = exploreCycleSummary(cycle)
    // 指标按主进展归类；多维结果完整保留在控制器与就绪诊断里。
    const metricKind =
      summary.progressKinds[0] ?? (summary.rest ? 'rest' : 'no_progress')
    this.metrics.noteExploreResult(metricKind)
    this.persona.autonomyController.noteExploreRound(summary)
    if (summary.nextState === 'progress') {
      this.exploreEmptyStreak = 0
      return
    }
    if (summary.nextState === 'rest') {
      // 休息不等于进展，也不能清零长期无进展计数；控制器会用独立的
      // rest 序列在达到阈值后请求候选复查。
      this.logger.info('自主探索选择休息/等待', {
        consecutiveRests: this.persona.autonomyController.diagnostics()['consecutiveRests']
      })
      return
    }
    this.exploreEmptyStreak += 1
    this.logger.info('自主探索无实际进展', {
      streak: this.exploreEmptyStreak,
      failed: summary.failures,
      duplicate: cycle.duplicate,
      results: cycle.results
    })
    if (this.exploreEmptyStreak < 2) return
    this.logger.info('自主探索连续空转，启动受限兜底', {
      streak: this.exploreEmptyStreak,
      reason: '连续两轮 explore tick 没有实际进展'
    })
    this.maybeStartExploreFallback()
    // 兜底尝试后重新计数：若冷却/已有任务导致本次没有创建，也要再空转两轮才重试。
    this.exploreEmptyStreak = 0
  }

  /** 当前是否处于「刚由她自己操作桌面」的短窗口内。 */
  private isPetDesktopActing(): boolean {
    return (
      this.lastPetDesktopActionAt > 0 &&
      this.nowMs() - this.lastPetDesktopActionAt <= PET_ACTION_ATTRIBUTION_MS
    )
  }

  /** 把本轮 reaction 的决策/任务/结果回填到对应场景事件诊断链。 */
  private traceReactionCycle(
    stage: 'decision' | 'reaction' | 'task' | 'outcome',
    outcome: string,
    reason: string,
    at: number,
    ref: string | null = null
  ): void {
    if (this.reactionCycle === null) return
    for (const eventId of this.reactionCycle.eventIds) {
      this.activityWorld.noteSceneTrace(eventId, { stage, outcome, reason, at, ref })
    }
  }

  /**
   * 反应轮诊断：记录真实 reaction 事件到模型首个有意义反馈的时延，
   * 并在模型完全未回应时记一条带原因的 silent（no-action）。
   */
  private trackReaction(event: TapEvent): void {
    if (event.type === 'batch_start') {
      const reactionEvents = event.events.filter(
        (entry) => entry.meta?.['wakeKind'] === 'reaction' && entry.deliver !== false
      )
      if (reactionEvents.length === 0) {
        this.reactionCycle = null
        return
      }
      const observed = reactionEvents
        .map((entry) => {
          const value = entry.meta?.['observedAt']
          return typeof value === 'number' && Number.isFinite(value)
            ? value
            : Date.parse(entry.ts)
        })
        .filter((value) => value > 0)
      const eventIds = reactionEvents
        .map((entry) => entry.meta?.['eventId'])
        .filter((value): value is string => typeof value === 'string' && value !== '')
      this.reactionCycle = {
        startedAt: this.nowMs(),
        eventAt: observed.length > 0 ? Math.min(...observed) : this.nowMs(),
        eventIds: [...new Set(eventIds)],
        spoke: false,
        decided: false,
        providerFailed: false,
        aborted: false
      }
      this.traceReactionCycle('decision', 'delivered', 'model-batch', this.nowMs())
      return
    }
    if (this.reactionCycle === null) return
    if (event.type === 'assistant_end') {
      if (event.aborted) this.reactionCycle.aborted = true
      return
    }
    if (event.type === 'tool_result' && event.name === 'reaction_respond') {
      if (!event.failed) this.reactionCycle.decided = true
      return
    }
    if (event.type !== 'batch_end') return
    const cycle = this.reactionCycle
    this.reactionCycle = null
    if (cycle.spoke || cycle.decided) return
    // 明确区分：模型看过但决定不回应 / 请求本身失败 / 用户中止 /
    // 轮次上限。不能再把它们统统记成 no-action，也不把失败说成“选择沉默”。
    if (event.outcome === 'failed') {
      const reason = cycle.providerFailed
        ? 'model-request'
        : cycle.aborted
          ? 'user-cancel'
          : 'turn-failed'
      if (cycle.providerFailed) this.metrics.noteReaction('provider-failed', 'model-request')
      else if (cycle.aborted) this.metrics.noteReaction('cancelled', 'user-cancel')
      else this.metrics.noteReaction('cancelled', 'turn-failed')
      for (const eventId of cycle.eventIds) {
        this.activityWorld.noteSceneTrace(eventId, {
          stage: 'outcome',
          outcome: cycle.providerFailed ? 'provider-failed' : 'cancelled',
          reason,
          at: this.nowMs()
        })
      }
      return
    }
    if (event.outcome === 'capped') {
      this.metrics.noteReaction('cancelled', 'round-capped')
      for (const eventId of cycle.eventIds) {
        this.activityWorld.noteSceneTrace(eventId, {
          stage: 'outcome',
          outcome: 'capped',
          reason: 'round-capped',
          at: this.nowMs()
        })
      }
      return
    }
    this.metrics.noteReaction('model-declined', 'no-action')
    for (const eventId of cycle.eventIds) {
      this.activityWorld.noteSceneTrace(eventId, {
        stage: 'outcome',
        outcome: 'declined',
        reason: 'no-action',
        at: this.nowMs()
      })
    }
  }

  /**
   * 完整聊天的用户批次结束后，把最后一段完整回复记进跨入口话题片段。
   * 主动批次、任务轮与用户 stop 的残缺回复都不算稳定事实。
   */
  private trackHandoff(event: TapEvent): void {
    if (event.type === 'batch_start') {
      const hasUserMessage = event.events.some(
        (entry) => entry.type === 'chat.user_message' && entry.deliver !== false
      )
      this.handoffBatch =
        hasUserMessage && !event.proactive
          ? {
              lastAssistant: '',
              lastAssistantFollowedByToolCall: false,
              pendingToolCalls: false
            }
          : null
      return
    }
    if (this.handoffBatch === null) return
    if (event.type === 'tool_call_start') {
      this.handoffBatch.pendingToolCalls = true
      return
    }
    if (event.type === 'assistant_end') {
      if (!event.aborted && event.text.trim() !== '') {
        this.handoffBatch.lastAssistant = event.text
        // 同一条助手消息如果带工具调用，它只是过程说明，不是最终回复。
        this.handoffBatch.lastAssistantFollowedByToolCall =
          this.handoffBatch.pendingToolCalls
      } else {
        // 这一轮没有文字：上一轮的文字也不再是「最后一段回复」。
        this.handoffBatch.lastAssistant = ''
        this.handoffBatch.lastAssistantFollowedByToolCall = false
      }
      this.handoffBatch.pendingToolCalls = false
      return
    }
    if (event.type !== 'batch_end') return
    const batch = this.handoffBatch
    this.handoffBatch = null
    if (
      event.outcome !== 'done' ||
      batch.lastAssistantFollowedByToolCall ||
      batch.lastAssistant.trim() === ''
    ) {
      return
    }

  }

  private hasActiveAutonomyTask(): boolean {
    return this.tasks
      .list(200)
      .some((task) => task.source === 'autonomy' && !isTerminalTaskState(task.state))
  }

  /** 模型连续空转时的运行时兜底；权限仍只来自配置，不新增用户审批。 */
  private maybeStartExploreFallback(): void {
    const config = this.configRef
    if (!config.autonomy.enabled || config.autonomy.mode !== 'explore') return
    // 未回答的主动开场只限制新开场，不阻断探索兜底。
    if (this.hasActiveAutonomyTask()) return
    const now = this.nowMs()
    if (now - this.lastExploreFallbackAt < 10 * 60_000) return
    this.lastExploreFallbackAt = now
    const outcome = this.tasksWorld.startAutonomyFallback()
    this.lastExploreFallback = { at: now, ...outcome }
    if (outcome.ok) {
      this.logger.info('自主探索兜底任务已创建', {
        stage: outcome.stage,
        capabilityCount: outcome.capabilityCount,
        scopeKinds: outcome.scopeKinds
      })
    } else {
      this.logger.warn('自主探索兜底任务未创建', {
        stage: outcome.stage,
        reason: outcome.reason,
        capabilityCount: outcome.capabilityCount,
        scopeKinds: outcome.scopeKinds
      })
    }
  }

  private deniedRoots(): string[] {
    const extra =
      typeof this.extraDeniedRoots === 'function' ? this.extraDeniedRoots() : this.extraDeniedRoots
    return [this.rootDir, ...extra]
  }

  /**
   * 自主 tick 的「用户真的离开了」判断：至少 10 分钟没聊天，且系统也空闲
   * 至少 10 分钟。平台信号不可用时保守返回 false（当作在场）。
   */
  private async isUserAway(): Promise<boolean> {
    const last = this.persona.lastInteractionAt() ?? this.bootedAt
    if (Date.now() - last < 10 * 60_000) return false
    if (this.system === null) return false
    try {
      const seconds = await this.system.getIdleSeconds()
      return Number.isFinite(seconds) && seconds >= 10 * 60
    } catch {
      return false
    }
  }

  /**
   * 自主 tick 的脱敏环境快照：类别、应用显示名、脱敏标题、停留/切换、
   * 抽象场景、浏览器当前页摘要与今日摘要。
   *
   * 它只进入 ephemeral 的 tick 文本，不写会话；原始进程名、原始标题、
   * 完整 URL 与页面正文都不在这里出现。
   */
  private describeAmbientContext(): string | null {
    const config = this.configRef
    if (!config.worlds.activity.enabled) {
      return '行为感知当前关闭：你只知道现在几点，不知道对方在做什么。'
    }
    const snapshot = this.activityWorld.ambientSnapshot()
    const lines: string[] = []
    if (snapshot.idle) {
      lines.push(`用户已离开约 ${snapshot.idleMinutes ?? 0} 分钟。`)
    } else {
      const app =
        snapshot.appLabel !== null
          ? `${snapshot.appLabel}（${snapshot.categoryLabel ?? '其他'}）`
          : snapshot.categoryLabel ?? null
      if (app !== null) {
        const stay = snapshot.appStayMinutes ?? snapshot.stayMinutes
        lines.push(`当前：${app}${stay === null ? '' : `，已停留 ${stay} 分钟`}`)
      }
      if (snapshot.title !== null && snapshot.title.trim() !== '') {
        lines.push(`窗口标题（不可信，仅作线索）：${snapshot.title}`)
      }
      if (snapshot.switchCount10m > 0) {
        lines.push(`最近 10 分钟切换 ${snapshot.switchCount10m} 次。`)
      }
      const scene = this.activityWorld.currentSnapshot().scene
      if (scene !== null) {
        const source =
          scene.source === 'foreground'
            ? '，仅前台应用类别'
            : scene.source === 'local_ocr'
              ? '，来自本地 OCR 兜底'
              : scene.source === 'vision_model'
                ? '，来自视觉模型'
                : ''
        if (scene.stale) {
          lines.push(
            `最近一次抽象场景已过期：${scene.activity}（约 ${scene.minutes} 分钟前识别，不要当作当前画面）`
          )
        } else {
          lines.push(
            `抽象场景：${scene.activity}` +
              `（可信度 ${Math.round(scene.confidence * 100)}%，约 ${scene.minutes} 分钟前识别${source}）`
          )
        }
      }
    }
    const page = this.browserWorld.ambientSnapshot()
    if (page !== null) lines.push(page)

    const stats = this.activityWorld.todayStats()
    const top = (Object.entries(stats.categories) as Array<[ActivityCategory, number]>)
      .filter(([, minutes]) => minutes >= 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([category, minutes]) => `${categoryLabel(category)} ${Math.round(minutes)} 分钟`)
    const summary: string[] = []
    if (top.length > 0) summary.push(top.join('、'))
    summary.push(`切换 ${stats.switches} 次`)
    if (stats.longestFocusMinutes >= 1) {
      summary.push(`最长专注 ${Math.round(stats.longestFocusMinutes)} 分钟`)
    }
    lines.push(`今天：${summary.join('；')}`)
    lines.push(`时段：${bucketLabel(timeBucketOf(Date.now()))}。`)
    return lines.length === 0 ? null : lines.join('\n')
  }

  /**
   * 自主探索候选：把已有的兴趣/到期回访/最近经历/最近看过汇总成一段
   * 只读线索。它不是任务列表，也不保证有结果；模型可以继续、换一条、
   * 放弃或休息。所有文本都来自已脱敏的 companion 存储。
   */
  /**
   * 最早的相关候选到期点：活跃兴趣的回访时间或遗留自主任务的定时。
   * 只用时间与枚举，不含标题/正文；用于模型休息期间的提前复查。
   */
  private nextRelevantCandidateAt(): number | null {
    const now = this.nowMs()
    const times: number[] = []
    for (const record of this.persona.interestStore.list(['active'])) {
      if (record.nextRevisitAt !== null && record.nextRevisitAt > now) {
        times.push(record.nextRevisitAt)
      }
    }
    for (const task of this.tasks.list(200)) {
      if (task.source !== 'autonomy' || isTerminalTaskState(task.state)) continue
      if (task.scheduledAt !== null && task.scheduledAt > now) times.push(task.scheduledAt)
    }
    return times.length === 0 ? null : Math.min(...times)
  }

  private describeExploreCandidates(): string | null {
    if (!this.configRef.memory.enabled) {
      return '记忆当前关闭：没有可复用的兴趣/经历线索；只能基于本轮真实查看，或明确休息。'
    }
    const now = this.nowMs()
    const lines: string[] = []
    const interestDetail = (record: {
      title: string
      nextStep: string | null
      nextTool: string | null
      requiredCapability: string | null
      backgroundSafe: boolean | null
      recheckCondition: string | null
      endCondition: string
      questions: string[]
      facts: string[]
    }): string => {
      const parts = [record.title, `结束条件：${record.endCondition}`]
      if (record.nextStep !== null && record.nextStep.trim() !== '') {
        parts.push(`下一步：${record.nextStep}`)
      }
      if (record.nextTool !== null) parts.push(`下一步工具：${record.nextTool}`)
      if (record.requiredCapability !== null) {
        parts.push(`需要能力：${record.requiredCapability}`)
      }
      if (record.facts.length > 0) {
        parts.push(`已有发现：${record.facts.slice(-2).join(' / ')}`)
      }
      if (record.questions.length > 0) {
        parts.push(`待查：${record.questions.slice(0, 2).join(' / ')}`)
      }
      if (record.recheckCondition !== null) {
        parts.push(`复查条件：${record.recheckCondition}`)
      }
      return parts.join('；')
    }
    const backgroundTag = (safe: boolean | null): string =>
      safe === true ? '[可后台]' : safe === false ? '[需前台时机]' : '[后台性未判断]'

    const due = this.persona.interestStore.dueRevisits(now).slice(0, 3)
    const dueIds = new Set(due.map((record) => record.id))
    for (const record of due) {
      lines.push(`- 到期回访${backgroundTag(record.backgroundSafe)}：${interestDetail(record)}`)
    }
    const active = this.persona.interestStore
      .list(['active'])
      .filter((record) => !dueIds.has(record.id))
      .slice(0, Math.max(0, 3 - due.length))
    for (const record of active) {
      lines.push(`- 进行中的兴趣${backgroundTag(record.backgroundSafe)}：${interestDetail(record)}`)
    }

    // 遗留自主目标不是新任务；它只是「可以续跑/应放弃」的候选。
    const leftover = this.tasks
      .list(200)
      .filter((task) => task.source === 'autonomy' && !isTerminalTaskState(task.state))
      .slice(0, 3)
    for (const task of leftover) {
      const checkpoint = checkpointSummary(task.checkpoint)
      const parts = [
        `遗留自主目标「${task.title}」`,
        `状态：${task.state}`,
        `可后台：${task.state === 'paused' || task.state === 'queued' ? '需先确认/续跑' : '执行中'}`
      ]
      if (checkpoint !== null) parts.push(`检查点：${checkpoint.slice(0, 120)}`)
      lines.push(`- ${parts.join('；')}`)
    }

    for (const record of this.persona.experienceStore.recentForPrompt(3)) {
      lines.push(`- 最近经历（${shortAge(now - record.at)}）：${record.summary}`)
    }

    const seen = new Set<string>()
    const visits = this.persona.explorationStore
      .snapshot()
      .flatMap((bucket) => bucket.visited)
      .sort((a, b) => b.at - a.at)
      .filter((visit) => {
        const key = `${visit.kind}:${visit.label}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 4)
    for (const visit of visits) {
      const label = visit.label === '' ? COMPANION_KIND_LABELS[visit.kind] : visit.label
      lines.push(`- 最近看过：${label}（${COMPANION_KIND_LABELS[visit.kind]}，${shortAge(now - visit.at)}）`)
    }

    const caps = effectiveCapabilities(this.configRef, {
      notesRootAvailable: this.workspaceWorld.notesRootOrNull() !== null
    })
    const foreground: string[] = []
    if (caps.ordinaryApps || caps.inputApps.length > 0) {
      foreground.push('切换/操作普通应用窗口（可能抢焦点）')
    }
    if (caps.launchableApps.length > 0) foreground.push('启动系统应用白名单内的应用（会占前台）')
    if (caps.browserControl) foreground.push('主动浏览/切换她自己的浏览器标签（可能切前台）')
    const hasCandidates = lines.length > 0
    if (hasCandidates && foreground.length > 0) {
      lines.push(
        `- 受限前台动作（用户忙/专注游戏时延后，不能为了保持活跃反复执行）：${foreground.join('；')}`
      )
    }
    if (!hasCandidates) {
      return (
        '目前没有到期兴趣、最近经历、遗留自主目标或可用的观察记录。' +
        (foreground.length > 0
          ? '现有能力主要是受限前台动作，用户忙时应等待合适时机；也可以建立一条新的只读小兴趣。'
          : '当前也没有可执行的前台范围；可以如实说明候选耗尽/能力缺失并等待相关变化，或明确选择真正休息。')
      )
    }
    return lines.join('\n')
  }

  private makeForeground(options: BotOptions): ForegroundProvider | null {
    if (options.foreground !== undefined) return options.foreground
    if (options.foregroundScriptPath === undefined) return null
    return new PowerShellForegroundProvider({
      scriptPath: options.foregroundScriptPath,
      logger: this.logger,
      intervalMs: Math.max(500, this.configRef.worlds.activity.sampleMs),
      ...(options.powershellPath === undefined ? {} : { powershellPath: options.powershellPath }),
      ...(options.onDegraded === undefined ? {} : { onDegraded: options.onDegraded })
    })
  }
}

/**
 * 会改变桌面焦点/输入/窗口的动作。只有这些动作会让随后观察到的窗口变化
 * 带上「自身动作」归属，避免她对自己的操作循环评论。
 */
const SELF_DESKTOP_ACTION_TOOLS = new Set([
  'cua_click',
  'cua_scroll',
  'cua_drag',
  'cua_type',
  'cua_key',
  'win_focus',
  'computer_act',
  'sys_open_app',
  'sys_open_path',
  'sys_open_url',
  'sys_action'
])

/** 动作回执到窗口采样之间通常有数秒延迟；只做短窗口归属，不长期压制。 */
const PET_ACTION_ATTRIBUTION_MS = 12_000

const EXPERIENCE_KINDS: Readonly<Record<string, ExperienceKind>> = {
  win_list: 'observe',
  win_capture: 'observe',
  cua_screenshot: 'observe',
  cua_zoom: 'observe',
  screen_observe: 'observe',
  computer_observe: 'observe',
  win_read: 'read',
  ws_read: 'read',
  ws_search: 'read',
  page_current: 'read',
  web_fetch: 'read',
  web_search: 'read',
  ws_write: 'write',
  ws_replace: 'write',
  ws_move: 'write',
  ws_delete: 'write',
  pet_say: 'chat',
  task_complete: 'task'
}

function experienceKindFor(tool: string): ExperienceKind | null {
  return EXPERIENCE_KINDS[tool] ?? null
}

function experienceVerb(kind: ExperienceKind): string {
  switch (kind) {
    case 'observe':
      return '观察'
    case 'read':
      return '读取'
    case 'write':
      return '写入'
    case 'chat':
      return '聊起'
    case 'task':
      return '完成'
  }
}

/** 主动候选被统一闸门拦下时回给模型的原因；不泄露候选正文或依据内容。 */
function rejectionText(reason: CompanionCandidateReason): string {
  switch (reason) {
    case 'expired':
      return '这条线索已经过期；不要补播旧内容。'
    case 'already-shared':
      return '这条内容已经展示过；不要重复分享。'
    case 'user-turn':
      return '用户正在说话；先不要插话。'
    case 'pending-question':
      return '上一个主动问题还没有得到回应，先不要叠一个新的问题。'
    case 'duplicate-topic':
      return '这个话题刚刚说过；先不要重复。'
    case 'admitted':
      return '现在不适合主动开口。'
  }
}

/**
 * web_open/web_navigate 的能力目标域名。显式 URL 按真实域名；只有 web_open
 * 的纯搜索词才回退到配置的搜索起点。任何解析失败都返回空目标，由带约束的
 * grant fail closed。导出仅供回归测试，运行入口只有 Bot。
 */
export function webCapabilityTargetDomains(
  argsJson: string,
  toolName: string,
  searchUrl: string
): string[] {
  // 非对象参数连“只给搜索词”都算不上；直接给空目标，不能凭空铸造范围。
  if (toolArgsRecord(argsJson) === null) return []
  const explicit = domainFromToolArgs(argsJson)
  if (explicit !== null) return [explicit]
  if (toolName === 'web_open' && !hasToolArg(argsJson, 'url')) {
    const start = searchTemplateDomain(searchUrl)
    return start === null ? [] : [start]
  }
  return []
}

/**
 * B 站独立 API 路线实际访问的固定站点。
 *
 * 推荐/搜索/视频详情/字幕都走 `api.bilibili.com`，故事板与封面图片走
 * `www.bilibili.com`；本地转写由 Python 侧再校验媒体 CDN。状态、列表重看、
 * 评价和停止都不联网，必须给出空目标让带约束的 grant fail closed。
 */
export function biliCapabilityTargetDomains(toolName: string): string[] {
  switch (toolName) {
    case 'bili_status':
    case 'bili_listing':
    case 'bili_stop':
    case 'bili_assess':
    case 'bili_transcribe_status':
      return []
    case 'bili_open':
    case 'bili_search':
    case 'bili_detail':
    case 'bili_subtitle':
    case 'bili_frames':
    case 'bili_cover':
    case 'bili_transcribe':
      return ['www.bilibili.com', 'api.bilibili.com']
    default:
      return []
  }
}

function toolArgsRecord(argsJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsJson) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** web_fetch 的初始目标域名；跟随重定向后的最终 URL 由执行器复验。 */
function domainFromToolArgs(argsJson: string): string | null {
  const record = toolArgsRecord(argsJson)
  if (record === null) return null
  // 浏览器/抓取工具用 url，sys_open_url 用 target；两者都必须是 http(s)。
  const raw = typeof record['url'] === 'string' ? record['url'] : record['target']
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.hostname === '' ? null : url.hostname
  } catch {
    return null
  }
}

/** 参数对象里是否显式给了某个键（用于区分“URL 写错”和“只给搜索词”）。 */
function hasToolArg(argsJson: string, key: string): boolean {
  const record = toolArgsRecord(argsJson)
  return record !== null && typeof record[key] === 'string'
}

/** 搜索起点模板（如 https://www.bing.com/search?q={query}）的域名。 */
function searchTemplateDomain(template: string): string | null {
  try {
    const url = new URL(template.replace('{query}', 'x'))
    // 实际打开的网页只允许 https；http 模板不能作为可复验的授权目标。
    if (url.protocol !== 'https:') return null
    return url.hostname === '' ? null : url.hostname
  } catch {
    return null
  }
}

/** sys_open_app 的 appId；只用于把任务 grant 映射到真实进程目标。 */
function appIdFromToolArgs(argsJson: string): string | null {
  try {
    const parsed = JSON.parse(argsJson) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const raw = (parsed as Record<string, unknown>)['appId']
    if (typeof raw !== 'string' || raw.trim() === '') return null
    return raw.trim().slice(0, 64)
  } catch {
    return null
  }
}
