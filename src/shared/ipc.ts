import type {
  AppConfig,
  CompanionCadence,
  PetAnimationConfig,
  PetAppearanceConfig,
  PetClickAction,
  PetRandomRoamConfig,
  QuickInputConfig
} from './config'
import type { CapabilitySnapshotView } from './capabilityStatus'
import type { BrowserExtensionRuntimeView } from './browserControl'
import type {
  BiliLoginQrView,
  BiliReadingView,
  BiliReportOpenResult,
  BiliReportSummary,
  BiliSessionReportView,
  BiliSettingsAction,
  BiliStatusView,
  PetBiliReportEvent
} from './bilibili'
import type {
  DiscoveryCardView,
  DiscoveryFeedbackKind,
  DiscoveryListView
} from './discovery'
import type { VolumeScopeView } from './volumeScope'
import type { FileScopeView } from './fileScope'
import type { PhysicsParams } from './dshPet/types'
import type {
  PetAnimationReceipt,
  PetAnimationRequest,
  PetMovementReceipt,
  PetMovementRequest,
  PetPageStateSnapshot
} from './petPresentation'
import type { WakeDecisionReason } from './wake'
import type {
  ScreenCompanionStatusView,
  ScreenCompanionTestResultView
} from './screenCompanion'
import type { CapabilityId, GrantScope, GrantSource, ToolSource } from '../core/capabilityTypes'
import type { TaskState, TaskView } from '../core/taskTypes'
import type {
  ApprovalOrigin,
  ApprovalRequest,
  ApprovalScope,
  ModelInfo,
  ModelPhase,
  TurnFailureKind,
  TurnFailureStage,
  TurnOutcome,
  TurnRecoveryState,
  Usage
} from '../core/types'

export type { TaskView }
export type { BiliSettingsAction } from './bilibili'
export type { CapabilitySnapshotView } from './capabilityStatus'
export type { VolumeScopeView } from './volumeScope'
export type { FileScopeView } from './fileScope'
export type {
  PetAnimationOutcome,
  PetAnimationReceipt,
  PetAnimationRequest,
  PetAnimationReceiptStatus,
  PetAnimationSource,
  PetMovementOutcome,
  PetMovementReceipt,
  PetMovementRequest,
  PetMovementStatus,
  PetPageStateSnapshot,
  PetRequestClass
} from './petPresentation'

/**
 * main ↔ preload ↔ renderer 的类型契约（PLAN.md §6）。
 *
 * 这里只有类型与固定的 channel 名；任何接收原始进程名的结构都不在这里定义
 * —— 活动原始样本只在设置页自己的 IPC 返回类型里出现，不随通用状态广播。
 */

export const IPC = {
  // chat / shared
  appBootstrap: 'app:bootstrap',
  appOpenChat: 'app:open-chat',
  appOpenSettings: 'app:open-settings',
  appOpenDiagnostics: 'app:open-diagnostics',
  appQuit: 'app:quit',
  appSetAutoLaunch: 'app:set-auto-launch',
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  chatRefresh: 'chat:refresh',
  chatResolveApproval: 'chat:resolve-approval',
  chatUndo: 'chat:undo',
  chatMarkCleared: 'chat:mark-cleared',
  chatSetPaused: 'chat:set-paused',
  chatHideWindow: 'chat:hide-window',
  chatTask: 'chat:task',
  chatTaskCancel: 'chat:task-cancel',
  chatOpenBiliVideo: 'chat:open-bili-video',
  // pet page
  petBootstrap: 'pet:bootstrap',
  petSetInteractive: 'pet:set-interactive',
  petSetPanelOpen: 'pet:set-panel-open',
  petOpenChat: 'pet:open-chat',
  petOpenSettings: 'pet:open-settings',
  /** 桌宠迷你视频卡：只传 bvid + partIndex，URL 由主进程重建。 */
  petOpenBiliVideo: 'pet:open-bili-video',
  petResetPosition: 'pet:reset-position',
  petSetRoam: 'pet:set-roam',
  petNotifyReady: 'pet:notify-ready',
  petInteraction: 'pet:interaction',
  petStopCua: 'pet:stop-cua',
  petTask: 'pet:task',
  petFeedback: 'pet:feedback',
  /** 页面 → 主进程：带时间戳的占用/可见性快照，供唯一调度器判断是否可插播。 */
  petPageState: 'pet:page-state',
  /** 页面 → 主进程：真实播放回执（accepted/started/completed/...）。 */
  petAnimationReceipt: 'pet:animation-receipt',
  /** 页面 → 主进程：真实移动回执（accepted/started/completed/blocked/...）。 */
  petMovementReceipt: 'pet:movement-receipt',
  /** 页面 → 主进程：气泡是否真的进入页面 DOM；不是 IPC 发送成功。 */
  petSayReceipt: 'pet:say-receipt',
  /** 页面 → 主进程：菜单/面板等真实占用，用于退出自主空闲资格。 */
  petActivity: 'pet:activity',
  /** 页面 → 主进程：拖拽/抛掷/漫游结束后保存位置。 */
  petSavePosition: 'pet:save-position',
  petPerchSubscribe: 'pet:perch-subscribe',
  petPerchUnsubscribe: 'pet:perch-unsubscribe',
  petPerchRefresh: 'pet:perch-refresh',
  // quick chat（脱离 main 会话的短对话；仅桌宠页可调用）
  quickBootstrap: 'quick:bootstrap',
  quickSend: 'quick:send',
  quickStop: 'quick:stop',
  quickEnd: 'quick:end',
  quickReset: 'quick:reset',
  quickResolveApproval: 'quick:resolve-approval',
  quickEvent: 'quick:event',
  // settings
  settingsBootstrap: 'settings:bootstrap',
  settingsSaveConfig: 'settings:save-config',
  settingsCapabilitySnapshot: 'settings:capability-snapshot',
  settingsVolumeScope: 'settings:volume-scope',
  settingsFileScope: 'settings:file-scope',
  settingsRevokeExploration: 'settings:revoke-exploration',
  settingsSetApiKey: 'settings:set-api-key',
  settingsClearApiKey: 'settings:clear-api-key',
  settingsVerifyApiKey: 'settings:verify-api-key',
  settingsListModels: 'settings:list-models',
  settingsChooseWorkspace: 'settings:choose-workspace',
  settingsChooseNotesRoot: 'settings:choose-notes-root',
  settingsChooseTrustedRoot: 'settings:choose-trusted-root',
  settingsChooseExplorationRoot: 'settings:choose-exploration-root',
  settingsChooseArtifactRoot: 'settings:choose-artifact-root',
  settingsApprovalGrants: 'settings:approval-grants',
  settingsClearApprovalGrants: 'settings:clear-approval-grants',
  settingsActivityRaw: 'settings:activity-raw',
  settingsActivityClearRaw: 'settings:activity-clear-raw',
  settingsActivityStats: 'settings:activity-stats',
  settingsVisionStatus: 'settings:vision-status',
  settingsVisionScenes: 'settings:vision-scenes',
  settingsVisionEvents: 'settings:vision-events',
  settingsVisionClear: 'settings:vision-clear',
  settingsVisionPause: 'settings:vision-pause',
  settingsVisionResume: 'settings:vision-resume',
  settingsVisionObserveNow: 'settings:vision-observe-now',
  settingsCuaStatus: 'settings:cua-status',
  settingsCuaStop: 'settings:cua-stop',
  settingsCuaClearGrants: 'settings:cua-clear-grants',
  settingsRunningApps: 'settings:running-apps',
  settingsBrowserStatus: 'settings:browser-status',
  settingsBrowserRotateToken: 'settings:browser-rotate-token',
  settingsBrowserOpenExtension: 'settings:browser-open-extension',
  settingsSystemRecent: 'settings:system-recent',
  settingsSystemClearRecent: 'settings:system-clear-recent',
  settingsSystemScanApps: 'settings:system-scan-apps',
  settingsActivityPaused: 'settings:activity-paused',
  settingsAgentPaused: 'settings:agent-paused',
  settingsMemorySnapshot: 'settings:memory-snapshot',
  settingsMemoryWrite: 'settings:memory-write',
  settingsMemoryForget: 'settings:memory-forget',
  settingsCompanion: 'settings:companion',
  settingsCompanionAction: 'settings:companion-action',
  /** 设置页「一次陪伴反馈测试」：只消费新鲜摘要/安排下一次正常采样。 */
  settingsScreenCompanionTest: 'settings:screen-companion-test',
  settingsDiscovery: 'settings:discovery',
  settingsBiliAction: 'settings:bili-action',
  discoveryAction: 'discovery:action',
  settingsDiagnostics: 'settings:diagnostics',
  settingsExportDiagnostics: 'settings:export-diagnostics',
  settingsWorlds: 'settings:worlds',
  settingsPetCommand: 'settings:pet-command',
  settingsUndoList: 'settings:undo-list',
  settingsUndo: 'settings:undo',
  settingsSetRoam: 'settings:set-roam',
  settingsClearActivityStats: 'settings:clear-activity-stats',
  settingsClearLocalData: 'settings:clear-local-data',
  settingsResetPetSettings: 'settings:reset-pet-settings',
  settingsOpenLogsNote: 'settings:open-logs-note',
  settingsTasks: 'settings:tasks',
  settingsTaskAction: 'settings:task-action',
  settingsCapabilityGrants: 'settings:capability-grants',
  settingsRevokeCapability: 'settings:revoke-capability',
  // main → renderers
  chatTap: 'chat:event:tap',
  chatUserMessage: 'chat:event:user-message',
  chatApproval: 'chat:event:approval',
  chatApprovalCleared: 'chat:event:approval-cleared',
  chatPhase: 'chat:event:phase',
  chatTerminal: 'chat:event:terminal',
  chatWeb: 'chat:event:web',
  chatStatus: 'chat:event:status',
  chatOpen: 'chat:event:open',
  chatCleared: 'chat:event:cleared',
  chatBiliReport: 'chat:event:bili-report',
  petPerchGeometry: 'pet:event:perch-geometry',
  /** 主进程轮询到的系统光标位置（窗口内 CSS 像素）。 */
  petPointerSample: 'pet:event:pointer-sample',
  petSay: 'pet:event:say',
  /** 显式动画点播（pet_act / pet_emote / reaction_respond 等）。 */
  petAnimation: 'pet:event:animation',
  petMovement: 'pet:event:movement',
  petQuiet: 'pet:event:quiet',
  petAgentStatus: 'pet:event:agent-status',
  /** 一轮 B 站阅读结束后的迷你视频卡；完整报告仍走 chat:event:bili-report。 */
  petBiliReport: 'pet:event:bili-report',
  petCommand: 'pet:event:command',
  petPower: 'pet:event:power',
  /** 外观/物理/动画链/移动设置热更新。 */
  petSettings: 'pet:event:settings',
  petDisplays: 'pet:event:displays',
  petChatUi: 'pet:event:chat-ui',
  petCuaAction: 'pet:event:cua-action',
  petOpenQuick: 'pet:event:open-quick',
  petTaskChanged: 'pet:event:task-changed',
  settingsNotice: 'settings:event:notice',
  settingsActivityChanged: 'settings:event:activity-changed',
  settingsTaskChanged: 'settings:event:task-changed'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

// ---------------------------------------------------------------------------
// 共享视图
// ---------------------------------------------------------------------------

export interface ApiKeyStatusView {
  configured: boolean
  storageAvailable: boolean
  hint: string | null
}

/**
 * 一次失败/停止的脱敏视图。turnId 把状态条、聊天提示与诊断页关联到同一轮；
 * 不含回复正文、工具参数、路径、页面内容或窗口标题。
 */
export interface TurnFailureView {
  turnId: string
  at: number
  source: ToolSource
  outcome: TurnOutcome
  kind: TurnFailureKind
  stage: TurnFailureStage
  errorCode: string
  recoveryState: TurnRecoveryState
  retryable: boolean
  /** 失败前已完成的步骤名（工具名或“部分回复”）；不含参数。 */
  completed: string[]
  partial: boolean
  reason: string
  userInitiated: boolean
  background: boolean
  /** 同一故障链的重复次数与首次时间；用于合并提示。 */
  repeatCount: number
  firstAt: number
  round: number
}

export interface UiPhaseSnapshot {
  phase: ModelPhase
  round: number
  running: string[]
  retryAt?: number
  approvalPending: boolean
  busy: boolean
  paused: boolean
  queue: number
  enteredAt: number
}

export interface ChatHistoryItem {
  kind: 'user' | 'assistant'
  text: string
  at: number
  aborted?: boolean
}

export interface ChatBootstrap {
  version: string
  config: AppConfig
  phase: UiPhaseSnapshot
  hasApiKey: boolean
  approvals: ApprovalRequest[]
  undoCount: number
  petRunning: boolean
  platform: string
  history: ChatHistoryItem[]
  /** 运行时「本轮阅读」快照；聊天窗未就绪时的事件靠它补回。 */
  biliReports: BiliSessionReportView[]
}

export type ChatTapEvent =
  | { type: 'conversation_append'; history: ChatHistoryItem[] }
  | { type: 'conversation_reset' }
  | { type: 'batch_start'; count: number; proactive: boolean }
  | { type: 'assistant_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_args'; id: string; delta: string }
  | { type: 'tool_result'; id: string; name: string; text: string; failed: boolean }
  | { type: 'assistant_end'; text: string; aborted: boolean }
  | { type: 'usage'; usage: Usage }
  | { type: 'turn_end'; outcome: TurnOutcome; failure: TurnFailureView | null }
  | { type: 'batch_end'; outcome: TurnOutcome; failure: TurnFailureView | null }

export interface ChatUserMessageEvent {
  cursor: number
  text: string
  at: number
}

export interface ChatApprovalEvent {
  approval: ApprovalRequest
  all: ApprovalRequest[]
}

export interface ChatApprovalClearedEvent {
  id: string
  approved: boolean
  all: ApprovalRequest[]
}

export interface ChatTerminalEvent {
  stream: 'stdout' | 'stderr' | 'started'
  text: string
  command?: string
  cwd?: string
}

export interface ChatWebEvent {
  kind: 'search' | 'fetch'
  target: string
}

export interface ChatOpenEvent {
  reason: string
}

/**
 * 气泡事件。文字必须显示；`animation` 只是可选的点播，不影响气泡。
 * `animationNotice` 让工具结果/诊断看到旧词被近似映射或不支持的事实。
 */
export interface PetSayEvent {
  /** 主进程生成；页面回执原样带回，用于确认气泡真的显示。 */
  sayId?: string
  text: string
  preset: string | null
  ttlMs: number
  /** 主动开场对应的衔接记录；普通回复没有。 */
  episodeId?: string
  animation?: PetAnimationRequest
  animationNotice?: string
}

/** 气泡真实展示回执；页面明确丢弃/被占用挡住时必须 displayed=false。 */
export interface PetSayReceipt {
  sayId: string
  displayed: boolean
  /** 固定短原因；不含台词或页面内容。 */
  reason?: string
  at: number
}

/** 无气泡的显式动画点播。 */
export interface PetAnimationEvent {
  request: PetAnimationRequest
}

/** 无气泡的移动请求；requestId 由主进程生成，页面必须回执。 */
export interface PetMovementEvent {
  request: PetMovementRequest
}

/** 页面报告真实占用变化；只用于空闲资格与移动提示，不含任何用户内容。 */
export type PetActivityKind =
  | 'menu-open'
  | 'menu-close'
  | 'panel-open'
  | 'panel-close'
  | 'perch-bind'
  | 'perch-unbind'
  | 'suspend'
  | 'resume'
  | 'movement-ready'

/** 页面能提供的移动事实：当前位置、朝向与可安全到达的横向范围。 */
export interface PetMovementCapabilityView {
  xRatio: number
  facing: 'left' | 'right'
  reachableMinRatio: number
  reachableMaxRatio: number
}

export interface PetActivityEvent {
  kind: PetActivityKind
  movement?: PetMovementCapabilityView
}

export interface PetQuietEvent {
  minutes: number
  endsAt: number
}

/**
 * 由主进程从真实运行时状态推导的陪伴动作，不让模型自报。
 * 只用于本机状态条与表情映射，不进入模型上下文。
 */
export type PetActivity =
  | 'idle'
  | 'exploring'
  | 'reading'
  | 'writing'
  | 'revisiting'
  | 'wanting-talk'
  | 'resting'
  | 'degraded'
  | 'speech-quiet'
  | 'explore-paused'

export interface PetAgentStatusView {
  label: string
  activity: PetActivity
  phase: ModelPhase
  /** 映射后的客户端相位（thinking/tool/asking/queued/done/failed/idle）。 */
  petPhase: string
  /** 当前相位来自哪个可信入口；页面只用于区分自主轮自身状态与真实工作。 */
  source?: ToolSource | null
  approvalPending: boolean
  /** 当前审批属于哪个入口；没有审批时为 null。快捷优先。 */
  approvalOrigin: ApprovalOrigin | null
  /** 当前主审批请求的 id；无审批时为 null。 */
  approvalId: string | null
  /** 当前主审批请求的第一人称口语请求；仅供桌宠气泡展示。 */
  approvalAsk: string | null
  /** 是否有 CUA 工具正在截图/操作。 */
  cuaActive: boolean
  /** CUA 活动时的简短状态文案（不含窗口标题/坐标/输入内容）。 */
  cuaLabel: string | null
  busy: boolean
  paused: boolean
  round: number
  /** 最近一次尚未被同来源成功轮次清除的失败；正常待机时为 null。 */
  failure: TurnFailureView | null
  /** 当前任务摘要；只含标题与状态，不含截图或输入文字。 */
  task: { id: string; title: string; state: TaskState } | null
}

/** 桌宠 figure 的触摸/拖拽反馈；只在本机页面使用，不进入模型上下文。 */
export type PetInteractionKind = 'grab' | 'pet' | 'drop' | 'throw' | 'poke' | 'crash'

/** CUA 动作标记；坐标是桌宠页本地 CSS 像素。 */
export interface PetCuaActionEvent {
  kind: 'screenshot' | 'click' | 'drag' | 'type' | 'key' | 'scroll'
  x: number
  y: number
  toX?: number
  toY?: number
}

/** 快捷审批到达时自动展开面板；focus 始终为 false，不抢键盘。 */
export interface PetOpenQuickEvent {
  approvalId: string
}

export type PetCommand = 'reset' | 'settings' | 'refresh' | 'reset-settings'

export interface PetDisplayView {
  /** Electron display id（字符串形式，避免超过 JS 安全整数）。 */
  id: string
  /** 相对桌宠窗口（所有显示器工作区并集）的 DIP 坐标。 */
  x: number
  y: number
  width: number
  height: number
  scaleFactor: number
  primary: boolean
}

/** 窗口上沿的一段可见区间，相对桌宠窗口并集的 DIP。 */
export interface PerchSegmentView {
  x1: number
  x2: number
}

/**
 * 可作为支撑面的窗口几何。只含矩形、层叠后的可见上沿与前台标记；
 * 不含标题、文本、进程名或截图，也不代表获得了窗口内容权限。
 */
export interface PerchWindowView {
  /** 本次运行内稳定的窗口标识（加盐哈希，重启后失效）。 */
  id: string
  /** 相对桌宠窗口并集的 DIP。 */
  x: number
  y: number
  width: number
  height: number
  /** 上沿 y（与 y 相同，显式给出，避免调用方误解为工作区底边）。 */
  top: number
  segments: PerchSegmentView[]
  foreground: boolean
}

export interface PerchGeometryView {
  version: 1
  seq: number
  at: number
  windows: PerchWindowView[]
  /** 非 Windows、辅助组件缺失或启动失败时的原因；不阻断桌宠其他功能。 */
  unavailableReason: string | null
}

export interface PetMovementView {
  enabled: boolean
  pauseWithPanel: boolean
  autonomousMinIntervalMs: number
  randomRoam: PetRandomRoamConfig
}

/** 主进程保存的位置；比例为身体中心/脚底相对当前工作区的值。 */
export interface PetSavedPositionView {
  displayId: string | null
  xRatio: number
  feetRatio: number
  facing: 'left' | 'right'
  savedAt: number
}

export interface PetBootstrap {
  version: string
  phase: string
  activityPaused: boolean
  petVisible: boolean
  platform: string
  personaName: string
  appearance: PetAppearanceConfig
  animation: PetAnimationConfig
  physics: PhysicsParams
  confineToScreen: boolean
  movement: PetMovementView
  /** 张望品类冷却截止（墙钟 epoch ms）；页面重载后仍共享主进程的计时。 */
  lookAroundCooldownUntil: number
  /** 上次保存的位置；首次启动为 null（页面使用 appearance.home）。 */
  position: PetSavedPositionView | null
  /** 位置损坏/不可恢复的原因；正常为 null。 */
  positionReason: string | null
  chatUi: {
    quickInput: QuickInputConfig
    petClickAction: PetClickAction
  }
  displays: PetDisplayView[]
}

export interface PetPowerEvent {
  suspended: boolean
}

/** 设置保存后的表现层热更新；不需要重启页面。 */
export interface PetSettingsEvent {
  appearance: PetAppearanceConfig
  animation: PetAnimationConfig
  physics: PhysicsParams
  confineToScreen: boolean
  movement: PetMovementView
  lookAroundCooldownUntil: number
}

/** 显示器增删/分辨率变化；坐标为相对桌宠窗口并集的 DIP。 */
export interface PetDisplaysEvent {
  displays: PetDisplayView[]
}

/**
 * 主进程系统光标采样。点击穿透时窗口收不到任何原生鼠标事件，
 * 页面靠这条样本判断光标是否进入身体/面板。坐标为桌宠页 CSS 像素；
 * `inside` 为 false 时表示光标不在窗口内，x/y 仅用于诊断。
 */
export interface PetPointerSample {
  x: number
  y: number
  inside: boolean
}

/** 设置保存后把点击动作/快捷输入配置热更新到已运行的桌宠页。 */
export interface PetChatUiEvent {
  quickInput: QuickInputConfig
  petClickAction: PetClickAction
}

// ---------------------------------------------------------------------------
// 快捷聊天（独立于 main 会话的短对话）
// ---------------------------------------------------------------------------

export type QuickChatPhase = 'idle' | 'streaming' | 'ended'

export interface QuickChatLastDone {
  id: string
  text: string
  at: number
}

export interface QuickChatSnapshot {
  hasKey: boolean
  personaName: string
  /** 'ended' 表示上一段上下文已结束，新消息会开始新 turn。 */
  phase: QuickChatPhase
  /** 当前 turn 的 id；没有进行中的 turn 时为 null。 */
  turnId: string | null
  /** 已发出的最后一个 delta 序号，用于重载去重。 */
  seq: number
  /** 仅流式进行中非空；用于桌宠页重载后续接当前气泡。 */
  text: string
  lastError: string | null
  /** 最近一次完成但可能丢失 done 事件的回复；仅在 15 秒内返回。 */
  lastDone: QuickChatLastDone | null
  /** 快捷聊天正在等待确认的审批；没有则为 null。 */
  pendingApproval: ApprovalRequest | null
  /** 当前正在执行的工具名；没有工具时为 null。 */
  toolName: string | null
  /** 快捷聊天是否正在执行 CUA 工具。 */
  cuaActive: boolean
  /** 仍未被回应的主动开场 id；有值时面板显示轻量反馈按钮。 */
  episodeId: string | null
}

/**
 * QuickChatService 自己产出的状态；personaName 与 episodeId 由主进程 IPC 层补充。
 * 快捷聊天服务本身不持有 Episode，只能看到自己的 turn/tool 状态。
 */
export type QuickChatState = Omit<QuickChatSnapshot, 'personaName' | 'episodeId'>

export type QuickChatEvent =
  | { type: 'start'; id: string; userText: string }
  /** text 是累计全文而不是增量片段；客户端按 seq 丢弃旧事件。 */
  | { type: 'delta'; id: string; seq: number; text: string }
  | {
      type: 'done'
      id: string
      seq: number
      text: string
      aborted?: boolean
      truncated?: boolean
    }
  | { type: 'error'; id: string; message: string; seq?: number; text?: string }
  | {
      type: 'phase'
      id: string
      phase: 'thinking' | 'tool' | 'waiting' | 'speaking'
      tool?: string
      cua?: boolean
    }
  | { type: 'tool'; id: string; toolCallId: string; name: string; state: 'start' | 'done'; failed?: boolean }
  | { type: 'approval'; id: string; approval: ApprovalRequest }
  | { type: 'approval-cleared'; id: string; approvalId: string; approved: boolean }
  | { type: 'notice'; id: string; text: string }
  | { type: 'ended'; reason: 'close' | 'idle' }
  | { type: 'reset' }

export interface QuickSendResult {
  ok: boolean
  error?: string
  /** 这次回复接住的发现卡片；只在回应主动开场时返回。 */
  discovery?: DiscoveryCardView
}

export interface ChatSendResult extends ChatActionResult {
  /** 用户回应主动分享后要展示的发现卡片。 */
  discovery?: DiscoveryCardView
}

/** 设置页的 B 站独立服务状态、今日阅读投影与发现列表（均不含凭据）。 */
export interface DiscoverySettingsView {
  /** 服务未初始化（例如缺少安全存储）时为 null，界面显示不可用原因。 */
  status: BiliStatusView | null
  unavailableReason: string | null
  /** 当前扫码会话的二维码；未在扫码时为 null。 */
  qr: BiliLoginQrView | null
  reading: BiliReadingView | null
  report: BiliReportSummary | null
  list: DiscoveryListView
}

export type DiscoveryActionRequest =
  | { action: 'feedback'; id: string; kind: DiscoveryFeedbackKind }
  | { action: 'open'; id: string }
  | { action: 'delete'; id: string }
  | { action: 'clear' }

/** 设置页 B 站动作的统一回执；状态总是重新读取，二维码只随扫码动作返回。 */
export interface BiliActionView {
  ok: boolean
  message: string
  status: BiliStatusView | null
  qr: BiliLoginQrView | null
  report: BiliReportOpenResult | null
}

/** 发现卡片/列表上的本机动作；不会把 URL 交给渲染进程。 */
export interface DiscoveryBridge {
  open(id: string): Promise<ChatActionResult>
  feedback(id: string, kind: DiscoveryFeedbackKind): Promise<ChatActionResult>
  /** 设置页删除单条；聊天卡片不使用。 */
  remove(id: string): Promise<ChatActionResult>
  /** 设置页清空全部发现；会同时让相关 Episode 引用失效。 */
  clear(): Promise<ChatActionResult>
}

/** 快捷面板的三个轻量反馈；只调整她自己的节奏/兴趣，不授予权限。 */
export type PetFeedbackKind = 'more' | 'less' | 'stop' | 'quiet'

export interface QuickBridge {
  bootstrap(): Promise<QuickChatSnapshot>
  send(text: string, episodeId?: string): Promise<QuickSendResult>
  feedback(kind: PetFeedbackKind, episodeId?: string): Promise<ChatActionResult>
  stop(): Promise<void>
  end(): Promise<void>
  reset(confirmed?: boolean): Promise<void>
  resolveApproval(id: string, approved: boolean, scope?: ApprovalScope): Promise<ChatActionResult>
  onEvent(callback: (event: QuickChatEvent) => void): () => void
}

export interface ChatActionResult {
  ok: boolean
  message?: string
}

export interface SaveConfigResult {
  ok: boolean
  config: AppConfig
  /** 保存成功后的配置版本；失败时为当前版本。 */
  revision: number
  /** 调用方基于旧版本保存时为 true；此时不会覆盖磁盘上的新配置。 */
  conflict?: boolean
  message?: string
}

/** 立即撤销自由探索：只写已保存授权，不提交设置页其他草稿。 */
export interface RevokeExplorationResult {
  ok: boolean
  message: string
  config: AppConfig
  revision: number
  capabilitySnapshot: CapabilitySnapshotView
}

export interface KeyActionResult {
  ok: boolean
  message: string
  status: ApiKeyStatusView
}

export interface KeyVerifyResult {
  ok: boolean
  message: string
  models?: string[]
}

export interface ModelListResult {
  ok: boolean
  models: ModelInfo[]
  message?: string
}

export interface WorkspaceChoiceResult {
  ok: boolean
  root: string
  message?: string
}

export type MemoryFileName = 'profile.md' | 'boundaries.md' | 'projects.md' | 'recent.md' | 'habits.md'

export interface MemoryEntryView {
  name: MemoryFileName
  bytes: number
  modifiedAt: number
}

export interface MemorySnapshotView {
  enabled: boolean
  habits: boolean
  dir: string
  entries: MemoryEntryView[]
  contents: Array<{ name: MemoryFileName; text: string }>
}

export interface MemoryWriteResultView {
  ok: boolean
  message: string
  bytes?: number
}

/** 本地设置页可见的兴趣/经历快照；字段已在主进程脱敏。 */
export interface CompanionInterestView {
  id: string
  title: string
  source: 'user' | 'autonomy' | 'event'
  status: 'active' | 'paused' | 'done' | 'abandoned'
  nextStep: string | null
  nextTool: string | null
  requiredCapability: string | null
  backgroundSafe: boolean | null
  recheckCondition: string | null
  endCondition: string
  artifacts: string[]
  taskCount: number
  focusCount: number
  talkCount: number
  lastFocusAt: number | null
  nextRevisitAt: number | null
  updatedAt: number
}

export interface CompanionExperienceView {
  id: string
  at: number
  kind: 'observe' | 'read' | 'write' | 'chat' | 'task'
  summary: string
  tool: string
  targetKind: 'file' | 'window' | 'page' | 'web' | 'note' | 'app'
  targetRef: string | null
  taskId: string | null
  interestId: string | null
  artifact: string | null
}

/** 她实际能去哪里：只有计数与布尔值，不含路径、进程名、域名或标题。 */
export interface AutonomyScopeView {
  notes: boolean
  workspace: boolean
  trustedRoots: number
  files: number
  observeApps: number
  inputApps: number
  launchApps: number
  web: boolean
  browserPage: boolean
  browserControl: boolean
  terminal: boolean
  /** 「自由探索」当前是否生效，以及各子范围的有效状态。 */
  exploration: boolean
  explorationWeb: boolean
  explorationTabs: boolean
  explorationApps: boolean
  explorationWindows: boolean
  explorationFullScreen: boolean
  explorationFiles: boolean
  explorationArtifacts: boolean
  explorationEdits: boolean
  explorationReadRoots: number
  explorationExcludedDomains: number
  explorationExcludedApps: number
}

export type AutonomyReadinessState = 'ready' | 'limited' | 'blocked'

export type AutonomyCapabilityState = 'ready' | 'limited' | 'blocked'

/** 能力维度：真正缺少的范围/授权；休息与忙碌不属于这里。 */
export interface AutonomyCapabilityView {
  state: AutonomyCapabilityState
  reasons: string[]
  scopeReasons: string[]
}

export type AutonomyScheduleState =
  | 'ready'
  | 'waiting'
  | 'waiting-condition'
  | 'quiet'
  | 'active'
  | 'resting'
  | 'paused'
  | 'disabled'
  | 'blocked'

/** 调度维度：下一次机会、当前正在做什么、是否休息/暂停。 */
export interface AutonomyScheduleView {
  state: AutonomyScheduleState
  reason: string | null
  nextAt: number | null
  restUntil: number | null
  restReason: string | null
  /** quiet 是静默后台活动（探索继续），waiting 是等待条件，rest 才是真正暂停。 */
  mode: 'quiet' | 'waiting' | 'rest' | null
  waitFor: string | null
  quietUntil: number | null
  quietReason: string | null
  /** 提前复查的原因/时间；不改变用户暂停。 */
  reviewAt: number | null
  reviewReason: string | null
  consecutiveRests: number
  /** 休息轮次占已完成探索轮次的比例；只用于诊断，不是额度。 */
  restRoundRatio: number | null
  minutesSinceRealProgress: number | null
}

/** 上一轮探索的真实结果；rest 不覆盖同一轮已经取得的进展。 */
export interface AutonomyLastRoundView {
  at: number | null
  progressKinds: string[]
  failures: number
  nextState: 'progress' | 'rest' | 'no_progress' | 'unknown'
}

export interface AutonomyFallbackView {
  at: number
  ok: boolean
  stage: 'capability' | 'create'
  reason: string
  capabilityCount: number
  scopeKinds: string[]
}

/**
 * 自主活动状态里的文件范围摘要；与电脑能力页读取同一个版本快照。
 * 只放计数与模式，具体路径在文件探索面板里查看。
 */
export interface AutonomyFileScopeView {
  version: number
  active: boolean
  mode: 'all' | 'non-system' | 'explicit'
  modeLabel: string
  readRoots: number
  unavailableRoots: number
  includesWorkspace: boolean
  includesNotes: boolean
  volumeUnavailable: number
}

/** 自主活动状态；设置页与诊断包共用。 */
export interface AutonomyReadinessView {
  /**
   * 兼容旧调用方的聚合状态；新界面必须分别展示 capability/schedule/lastRound，
   * 不能把“休息”或“正在执行”显示成能力受限。
   */
  state: AutonomyReadinessState
  capability: AutonomyCapabilityView
  schedule: AutonomyScheduleView
  lastRound: AutonomyLastRoundView
  lastFallback: AutonomyFallbackView | null
  effectiveScope: AutonomyScopeView
  /** 统一文件范围摘要；null 表示文件范围服务尚未就绪。 */
  fileScope: AutonomyFileScopeView | null
  /** 最近一次真实探索进展（观察/动作/产物/规划/休息），不是“说过话”。 */
  lastProgressAt: number | null
  lastProgressKind: string | null
  /** 调度与唤醒预算都允许的下一次机会；null 表示自主已关闭。 */
  nextGuaranteedAt: number | null
  /** 当前最主要的阻塞原因；ready 时为 null。 */
  blocker: string | null
  blockers: string[]
  /** 没有任何可执行范围时，来自统一能力快照的具体原因（最多 3 条）。 */
  scopeReasons: string[]
  /** WakeGovernor 的只读评估：预算/安静/忙碌等原因与恢复时间。 */
  wakeReason: WakeDecisionReason | null
  wakeDeferredAt: number | null
  /** 最近主动放弃的候选与脱敏原因，用于解释「为什么等待/换目标」。 */
  abandonedCandidates: Array<{ at: number; topic: string; reason: string }>
}

export interface CompanionSnapshotView {
  enabled: boolean
  /** 屏幕陪伴反馈的窄状态；不含摘要或台词。 */
  screenFeedback: ScreenCompanionStatusView
  /** 当前聊天档位与下一次考虑时间；只用于设置页展示。 */
  cadence: CompanionCadence
  nextCadenceAt: number | null
  speechQuietUntil: number | null
  explorePausedUntil: number | null
  unansweredEpisode: boolean
  readiness: AutonomyReadinessView
  interests: CompanionInterestView[]
  revisits: CompanionInterestView[]
  experiences: CompanionExperienceView[]
  counts: {
    active: number
    paused: number
    done: number
    abandoned: number
    experiences: number
    exploration: number
  }
}

export type CompanionActionView =
  | 'pause-interest'
  | 'resume-interest'
  | 'done-interest'
  | 'delete-interest'
  | 'clear-experiences'
  | 'clear-all'
  | 'quiet-speech'
  | 'resume-speech'
  | 'pause-explore'
  | 'resume-explore'

export interface CompanionActionResultView {
  ok: boolean
  message: string
  removed?: number
}

export interface WorldHealthView {
  id: string
  enabled: boolean
  available: boolean
  reason: string | null
  tools: Array<{ name: string; description: string; tags: string[]; approval: string }>
  events: Array<{ type: string; description: string }>
}

export interface ActivityDayStatsView {
  date: string
  categories: Record<string, number>
  switches: number
  idleMinutes: number
  longestFocusMinutes: number
  lateNight: boolean
}

export interface ActivityRawSampleView {
  processName: string
  category: string
  categoryLabel: string
  durationMinutes: number
  at: number
}

/**
 * 屏幕感知状态。只在本机设置页展示；捕获/发送/理解时间分开显示，
 * `snippet` 仅在用户显式开启 `showOcrSnippet` 时非空，且永远不写日志、
 * 事件或模型上下文。
 */
export interface VisionStatusView {
  enabled: boolean
  available: boolean
  reason: string | null
  lastAt: number | null
  /** 最近成功采集的时间。 */
  lastFrameAt: number | null
  /** 最近一次真正提交给模型的时间。 */
  lastSentAt: number | null
  /** 最近一次得到有效摘要的时间；本地像素比较不刷新它。 */
  lastInterpretedAt: number | null
  lastCategory: string | null
  lastActivity: string | null
  lastConfidence: number | null
  lastDurationMs: number | null
  lastError: string | null
  /** 只用于观测，不参与任何额度判断。 */
  framesCaptured: number
  framesLastMinute: number
  /** 累计真正提交给视觉模型的请求数；只用于诊断，不是额度。 */
  requestsSent: number
  targetDisplayId: string | null
  targetKind: string | null
  quality: string | null
  blockedReason: string | null
  /** 用户单独暂停屏幕感知（不等于暂停行为感知）。 */
  paused: boolean
  /** 当前周期：60 秒基础档或 120 秒静态档。 */
  intervalMs: number | null
  nextCheckAt: number | null
  /** 本地 OCR 兜底是否可用；null 表示尚未探测。 */
  ocrAvailable: boolean | null
  ocrFallback: boolean
  displays: Array<{ id: string; label: string; width: number; height: number; primary: boolean }>
  phase: string | null
  game: string | null
  evidenceSource: string | null
  revision: number
  /** 一次采样的采集/签名/模型/总耗时；不含画面内容。 */
  timings: {
    captureMs: number | null
    signatureMs: number | null
    semanticMs: number | null
    totalMs: number | null
  } | null
  /** 最近一帧的来源/尺寸/有效区域/可见性；不含像素。 */
  lastFrame?: {
    at: number
    sourceId: string
    displayId: string
    width: number
    height: number
    validRegion: { x: number; y: number; width: number; height: number }
    visible: boolean
    quality: string
  } | null
  semantic: {
    enabled: boolean
    available: boolean
    model: string | null
    lastAt: number | null
    lastSentAt: number | null
    lastInterpretedAt: number | null
    lastLatencyMs: number | null
    lastError: string | null
    imageSupported: boolean | null
    shareFrames: boolean
    inFlight: boolean
    usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null
    reason: string | null
  }
  snippet: string | null
}

/** “立即观察一次”的本机结果；reason 只含枚举式短原因。 */
export interface VisionObserveResultView {
  ok: boolean
  reason: string | null
}

/** 抽象场景预览；title 与 keywords 只在本机设置页显示，不进入模型。 */
export interface VisionSceneView {
  category: string
  activity: string
  appLabel: string
  title: string | null
  keywords: string[]
  confidence: number
  at: number
  phase: string | null
  game: string | null
  quality: string | null
  source: string | null
  observationId: string | null
  evidenceAt: number | null
  stale: boolean
}

/** 诊断链的一步：固定枚举 + 不透明引用，不含正文。 */
export interface VisionSceneTraceView {
  at: number
  stage: string
  outcome: string
  reason: string
  ref: string | null
}

/**
 * 最近的场景事件诊断链；不含标题、OCR 原文或进程名。
 * observationId 对应一次观察，eventId 对应由它产生的本地事件；
 * chain 记录 decision → reaction/task → outcome 的时间与原因。
 */
export interface VisionSceneEventView {
  eventId: string
  kind: string
  at: number
  evidenceAt: number
  observationId: string | null
  category: string
  activity: string
  phase: string
  previousPhase: string | null
  game: string | null
  change: string | null
  detail: string | null
  source: string | null
  quality: string | null
  revision: number | null
  chain: VisionSceneTraceView[]
}

/** 只在本机设置页展示的最近系统动作（不写入模型/诊断）。 */
export interface SystemRecentActionView {
  at: number
  tool: string
  target: string
  ok: boolean
}

/** 开始菜单扫描候选；加入白名单前由用户勾选。 */
export interface SystemAppCandidateView {
  label: string
  path: string
  args: string[]
}

/** 当前有可见窗口、可加入观察范围的应用；只含进程名与标签，不含标题。 */
export interface RunningAppView {
  process: string
  label: string
}

export interface ActivityStatsView {
  today: ActivityDayStatsView
  session: ActivityDayStatsView
  sampling: boolean
  userPaused: boolean
  currentCategory: string | null
  enabled: boolean
  retainStatsDays: number
}

export interface SettingsBootstrap {
  version: string
  platform: string
  config: AppConfig
  /** 已保存配置的单调版本；保存与快照都用它检测草稿过期。 */
  configRevision: number
  /** 主进程统一能力快照（已保存授权 + 运行时事实，不含未保存草稿）。 */
  capabilitySnapshot: CapabilitySnapshotView
  keyStatus: ApiKeyStatusView
  paths: {
    rootDir: string
    configFile: string
    memoryDir: string
    logsDir: string
    portable: boolean
  }
  petUrl: string | null
  hasApiKey: boolean
  agentPaused: boolean
  activityPaused: boolean
  autoLaunch: boolean
  usage: {
    calls: number
    promptTokens: number
    completionTokens: number
    cacheHitTokens: number
    estimatedCny: number
  }
  session: {
    rounds: number
    estTokens: number
    contextTokens: number
  }
  diagnostics: Record<string, unknown>
  warning: string | null
}

export interface DiagnosticsRuntimeView {
  phase: string
  round: number
  queue: number
  paused: boolean
  approvalsPending: number
  lastDeliveredCursor: number
  nextDueAt: number | null
  session: {
    rounds: number
    estTokens: number
    hardTokens: number | null
    messageCount: number
  }
  usage: {
    calls: number
    promptTokens: number
    completionTokens: number
    cacheHitTokens: number
    estimatedCny: number
  }
}

/** 诊断页只展示工具名/结果/耗时；参数摘要单独放在 summary，导出时会移除。 */
export interface DiagnosticsToolCallView {
  at: string
  tool: string
  result: string
  approval: string | null
  durationMs: number | null
  summary: string | null
}

export interface DiagnosticsLogView {
  at: string
  level: string
  message: string
  data: Record<string, unknown> | null
}

export interface DiagnosticsView {
  generatedAt: string
  version: string
  config: AppConfig
  diagnostics: Record<string, unknown>
  runtime: DiagnosticsRuntimeView
  worlds: WorldHealthView[]
  paths: Record<string, string>
  recentToolCalls: DiagnosticsToolCallView[]
  recentErrors: DiagnosticsLogView[]
  /** 按故障指纹合并的近期失败；turnId 供聊天/状态条跳转后定位。 */
  recentTurnFailures: TurnFailureView[]
}

export interface DiagnosticsExportResultView {
  ok: boolean
  message: string
  path?: string
}

export interface LocalDataClearResultView {
  ok: boolean
  message: string
}

/**
 * 浏览器桥状态。只含连接/计数，不含页面标题、域名或摘要——
 * 设置页永远看不到当前页面内容。
 */
export interface BrowserBridgeStatusView {
  enabled: boolean
  consentAt: number | null
  bridge: {
    running: boolean
    port: number | null
    pairingCode: string | null
    lastPageAt: number | null
    pagesLastMinute: number
    pagesLastHour: number
    rejectedLastMinute: number
    lastError: string | null
    /** 主动控制通道是否就绪（配置 + 同意 + 自由探索标签页范围）。 */
    controlReady: boolean
    /** 扩展最近是否通过任一通道联系过本机（页面感知也算）。 */
    extensionConnected: boolean
    /** 扩展是否正在长轮询主动控制通道。 */
    controlConnected: boolean
    /** 扩展弹窗是否允许主动浏览；null 表示尚未收到握手。 */
    extensionControlConsent: boolean | null
    /** 最近一次选中的运行实例；运行版本/协议/构建/能力以握手为准。 */
    runtime: BrowserExtensionRuntimeView | null
    /** 近期联系过本机的全部扩展实例（Chrome/Edge、新/旧扩展）。 */
    runtimes: BrowserExtensionRuntimeView[]
    pendingCommands: number
    lastCommandAt: number | null
    lastResultAt: number | null
    commandsLastHour: number
    commandFailuresLastHour: number
    lastCommandError: string | null
    /**
     * 上次使用的端口与本次实际监听端口不同时为旧端口；扩展若仍指向旧地址，
     * 会表现为「未联系」，并不等于扩展被删除。扩展重新按新配对码连上后清除。
     */
    portChangedFrom: number | null
  }
  page: {
    hasPage: boolean
    updatedAt: number | null
    eventsLastHour: number
    droppedLastHour: number
  }
  /** 主动浏览的有效范围；只有布尔/计数，不含标签页标题或网址。 */
  control: {
    active: boolean
    configEnabled: boolean
    consented: boolean
    explorationTabs: boolean
    /** 扩展是否正在长轮询主动控制通道。 */
    controlConnected: boolean
    observedTabs: number
    lastObservationAt: number | null
  }
  /** 已持久化的扩展目录/版本；null 表示尚未成功准备过。 */
  extension: BrowserExtensionInfoView | null
}

/** 只含安装位置与发布版本；不含浏览器配置或用户数据。 */
export interface BrowserExtensionInfoView {
  ready: boolean
  path: string
  version: string | null
  hash: string | null
  changed: boolean
  created: boolean
  retryable: boolean
  error: string | null
}

export interface BrowserExtensionOpenResultView extends Partial<BrowserExtensionInfoView> {
  ok: boolean
  message: string
}

export interface UndoEntryView {
  kind: string
  at: number
  path: string
}

/** 审批授权摘要；不包含授权键或具体参数。 */
export interface ApprovalGrantView {
  tool: string
  scope: 'session' | 'always'
  expiresAt: number | null
}

export type TaskActionView = 'pause' | 'resume' | 'cancel'

export interface TaskActionRequestView {
  id: string
  action: TaskActionView
}

/**
 * 能力授权摘要；不含工具参数、窗口内容或输入文字。
 * taskId 只用于把授权关联到设置页任务条目。
 */
export interface CapabilityGrantView {
  id: string
  capability: CapabilityId
  scope: GrantScope
  source: GrantSource
  actions: string[]
  taskId: string | null
  createdAt: number
  expiresAt: number | null
  autoApproveYellow: boolean
}

export interface UndoResultView {
  ok: boolean
  message: string
}

/** CUA 运行诊断；不包含截图、坐标、窗口标题、进程名或输入文字。 */
export interface CuaStatusView {
  enabled: boolean
  available: boolean
  permission: 'ask-once' | 'ask-each-action'
  helperHealthy: boolean
  actionsThisTurn: number
  maxActionsPerTurn: number
  lastAction: string | null
  lastActionAt: number | null
}

// ---------------------------------------------------------------------------
// contextBridge 暴露给渲染进程的窄接口
// ---------------------------------------------------------------------------

export interface ChatBridge {
  bootstrap(): Promise<ChatBootstrap>
  send(text: string): Promise<ChatSendResult>
  stop(): Promise<void>
  refresh(): Promise<ChatBootstrap>
  resolveApproval(id: string, approved: boolean, scope?: ApprovalScope): Promise<ChatActionResult>
  undo(count?: number): Promise<UndoResultView>
  markCleared(): Promise<void>
  /** 打开「本轮阅读」卡里的视频；只传 bvid + partIndex，由主进程拼 URL。 */
  openBiliVideo(bvid: string, partIndex: number): Promise<ChatActionResult>
  setPaused(paused: boolean): Promise<void>
  /** 收起聊天窗。渲染进程的 window.close() 在 Electron 中会销毁窗口，故走主进程隐藏。 */
  hideWindow(): void
  openSettings(): Promise<void>
  /** 打开设置页并定位到诊断区；失败提示里的“查看”走这里。 */
  openDiagnostics(): Promise<void>
  quit(): Promise<void>
  /** 最近任务的脱敏视图；审批卡据此显示任务来源。 */
  taskList(): Promise<TaskView[]>
  /** 审批卡上的「撤销该任务」：取消任务并撤销其临时授权。 */
  cancelTask(id: string): Promise<ChatActionResult>
  onTap(callback: (event: ChatTapEvent) => void): () => void
  onUserMessage(callback: (event: ChatUserMessageEvent) => void): () => void
  onApproval(callback: (event: ChatApprovalEvent) => void): () => void
  onApprovalCleared(callback: (event: ChatApprovalClearedEvent) => void): () => void
  onPhase(callback: (event: UiPhaseSnapshot) => void): () => void
  onStatus(callback: (event: UiPhaseSnapshot) => void): () => void
  onTerminal(callback: (event: ChatTerminalEvent) => void): () => void
  onWeb(callback: (event: ChatWebEvent) => void): () => void
  onOpen(callback: (event: ChatOpenEvent) => void): () => void
  onCleared(callback: () => void): () => void
  onBiliReport(callback: (report: BiliSessionReportView) => void): () => void
}

export interface PetBridge {
  bootstrap(): Promise<PetBootstrap>
  setInteractive(interactive: boolean): void
  setPanelOpen(open: boolean | { open: boolean; focus?: boolean }): void
  openChat(): void
  openSettings(): void
  /** 在浏览器打开迷你视频卡里的视频；参数经主进程校验后重建 URL。 */
  openBiliVideo(bvid: string, partIndex: number): Promise<ChatActionResult>
  /** 状态条上的失败提示跳转到诊断区。 */
  openDiagnostics(): void
  resetPosition(): void
  /** 拖拽/抛掷/漫游结束后保存；返回主进程是否接受。 */
  savePosition(position: PetSavedPositionView): Promise<boolean>
  /** 真实播放回执；页面在 started/completed/rejected/unsupported/failed 时调用。 */
  reportAnimation(receipt: PetAnimationReceipt): void
  /** 真实移动回执；页面在 accepted/started/completed/... 时调用。 */
  reportMovement(receipt: PetMovementReceipt): void
  /** 气泡真实展示回执；主进程只在 displayed=true 时计入主动发言。 */
  reportSayReceipt(receipt: PetSayReceipt): void
  /** 菜单/面板占用与位置范围的真实变化；只用于空闲资格与提示词。 */
  reportActivity(kind: PetActivityEvent['kind'], movement?: PetMovementCapabilityView): void
  /** 带时间戳的占用快照；主进程唯一调度器只在快照新鲜时插播随机活动。 */
  reportPageState(state: PetPageStateSnapshot): void
  notifyReady(): void
  notifyInteraction(kind: PetInteractionKind): void
  stopCua(): void
  /** 订阅窗口上沿几何（仅几何）；桌宠页卸载/关闭前退订。 */
  perchSubscribe(): void
  perchUnsubscribe(): void
  /** 拖拽开始时立即要一份最新几何，减少首次吸附等待。 */
  perchRefresh(): void
  onPerchGeometry(callback: (geometry: PerchGeometryView) => void): () => void
  /** 系统光标采样；点击穿透时唯一的光标来源。 */
  onPointerSample(callback: (sample: PetPointerSample) => void): () => void
  /** 当前任务（若有）；只含脱敏状态，不含截图或输入文字。 */
  currentTask(): Promise<TaskView | null>
  onSay(callback: (event: PetSayEvent) => void): () => void
  onAnimation(callback: (event: PetAnimationEvent) => void): () => void
  onMovement(callback: (event: PetMovementEvent) => void): () => void
  onQuiet(callback: (event: PetQuietEvent) => void): () => void
  onAgentStatus(callback: (event: PetAgentStatusView) => void): () => void
  /** 本轮阅读迷你卡；只含标题/作者/分P，不含 URL 与判定理由。 */
  onBiliReport(callback: (event: PetBiliReportEvent) => void): () => void
  onCommand(callback: (event: PetCommand) => void): () => void
  onPower(callback: (event: PetPowerEvent) => void): () => void
  onSettings(callback: (event: PetSettingsEvent) => void): () => void
  onDisplays(callback: (event: PetDisplaysEvent) => void): () => void
  onChatUi(callback: (event: PetChatUiEvent) => void): () => void
  onCuaAction(callback: (event: PetCuaActionEvent) => void): () => void
  onOpenQuick(callback: (event: PetOpenQuickEvent) => void): () => void
  onTaskChanged(callback: (event: TaskView[]) => void): () => void
}

export interface SettingsBridge {
  bootstrap(): Promise<SettingsBootstrap>
  /** baseRevision 来自 bootstrap/上一次保存；不匹配时返回 conflict，不覆盖。 */
  saveConfig(config: AppConfig, baseRevision: number): Promise<SaveConfigResult>
  /** 重新读取已保存配置与能力状态；设置页轮询/窗口聚焦时调用。 */
  capabilitySnapshot(): Promise<CapabilitySnapshotView>
  /** 当前卷清单（卷身份、挂载点、可读性、授权来源）；refresh 时真实枚举。 */
  volumeScope(refresh?: boolean): Promise<VolumeScopeView>
  /** 统一文件范围快照；与自主执行路径共用同一份解析结果。 */
  fileScope(refresh?: boolean): Promise<FileScopeView>
  /** 立即撤销自由探索并让任务/缓存失效；不会保存其他页面的草稿。 */
  revokeExploration(): Promise<RevokeExplorationResult>
  setApiKey(key: string): Promise<KeyActionResult>
  clearApiKey(): Promise<KeyActionResult>
  verifyApiKey(key?: string): Promise<KeyVerifyResult>
  listModels(): Promise<ModelListResult>
  chooseWorkspace(): Promise<WorkspaceChoiceResult>
  chooseNotesRoot(): Promise<WorkspaceChoiceResult>
  chooseTrustedRoot(): Promise<WorkspaceChoiceResult>
  /** 自由探索的只读根目录；返回路径，由设置页决定加入哪个字段。 */
  chooseExplorationRoot(): Promise<WorkspaceChoiceResult>
  /** 她自己的作品/下载空间。 */
  chooseArtifactRoot(): Promise<WorkspaceChoiceResult>
  listApprovalGrants(): Promise<ApprovalGrantView[]>
  clearApprovalGrants(): Promise<void>
  getActivityRaw(): Promise<ActivityRawSampleView[]>
  clearActivityRaw(): Promise<void>
  getActivityStats(): Promise<ActivityStatsView>
  clearActivityStats(): Promise<void>
  getVisionStatus(): Promise<VisionStatusView | null>
  getVisionScenes(): Promise<VisionSceneView[]>
  getVisionEvents(): Promise<VisionSceneEventView[]>
  clearVision(): Promise<void>
  /** 只暂停屏幕感知，不改变行为感知/对话；恢复后不补拍旧帧。 */
  pauseVision(): Promise<void>
  resumeVision(): Promise<void>
  /** 按当前授权与隐私状态立即观察一次；重复点击合并。 */
  observeVisionNow(): Promise<VisionObserveResultView>
  getCuaStatus(): Promise<CuaStatusView>
  stopCua(): Promise<void>
  clearCuaGrants(): Promise<void>
  runningApps(): Promise<RunningAppView[]>
  getBrowserStatus(): Promise<BrowserBridgeStatusView>
  /** B 站独立服务状态、今日阅读投影与发现列表（只含展示字段）。 */
  getDiscovery(): Promise<DiscoverySettingsView>
  /** 扫码登录、退出、安装、停止/恢复与日报入口；参数在主进程复验。 */
  biliAction(action: BiliSettingsAction): Promise<BiliActionView>
  rotateBrowserToken(): Promise<string | null>
  openBrowserExtensionFolder(): Promise<BrowserExtensionOpenResultView>
  getSystemRecent(): Promise<SystemRecentActionView[]>
  clearSystemRecent(): Promise<void>
  scanSystemApps(): Promise<SystemAppCandidateView[]>
  clearLocalData(): Promise<LocalDataClearResultView>
  setActivityPaused(paused: boolean): Promise<void>
  setAgentPaused(paused: boolean): Promise<void>
  setRoam(enabled: boolean): Promise<void>
  memorySnapshot(): Promise<MemorySnapshotView>
  memoryWrite(name: MemoryFileName, content: string, mode: 'replace' | 'append'): Promise<MemoryWriteResultView>
  memoryForget(target: { path?: string; query?: string }): Promise<MemoryWriteResultView>
  companionSnapshot(): Promise<CompanionSnapshotView>
  companionAction(target: {
    action: CompanionActionView
    interestId?: string
  }): Promise<CompanionActionResultView>
  /** 设置页的一次屏幕陪伴测试；不授予任何许可，也不额外截图。 */
  screenCompanionTest(): Promise<ScreenCompanionTestResultView>
  diagnostics(): Promise<DiagnosticsView>
  exportDiagnostics(): Promise<DiagnosticsExportResultView>
  worlds(): Promise<WorldHealthView[]>
  petCommand(command: PetCommand): Promise<void>
  undoList(): Promise<UndoEntryView[]>
  undo(count?: number): Promise<UndoResultView>
  resetPetSettings(): Promise<ChatActionResult>
  setAutoLaunch(enabled: boolean): Promise<boolean>
  openChat(): Promise<void>
  quit(): Promise<void>
  tasks(): Promise<TaskView[]>
  taskAction(id: string, action: TaskActionView): Promise<ChatActionResult>
  capabilityGrants(): Promise<CapabilityGrantView[]>
  revokeCapability(id: string): Promise<ChatActionResult>
  onNotice(callback: (message: string) => void): () => void
  onActivityChanged(callback: () => void): () => void
  onTaskChanged(callback: (event: TaskView[]) => void): () => void
}

export interface AppBridge {
  openChat(): Promise<void>
  openSettings(): Promise<void>
  openDiagnostics(): Promise<void>
  quit(): Promise<void>
  setAutoLaunch(enabled: boolean): Promise<boolean>
}

export interface MingyueBridge {
  app: AppBridge
  chat: ChatBridge
  pet: PetBridge
  quick: QuickBridge
  settings: SettingsBridge
  discovery: DiscoveryBridge
}

declare global {
  interface Window {
    mingyue: MingyueBridge
  }
}
