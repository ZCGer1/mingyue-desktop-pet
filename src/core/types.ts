import type { EvidenceFields } from '../shared/taskEvidence'
import type { ZodTypeAny } from 'zod'
import type { AppConfig } from '../shared/config'
import type { ToolSource } from './capabilityTypes'

// ---------------------------------------------------------------------------
// 事件流
// ---------------------------------------------------------------------------

/** WakeBus 的五种触发方式（语义与默认用法见 PLAN.md §2.2）。 */
export type TriggerMode = 'preempt' | 'interrupt' | 'flush' | 'debounce' | 'piggyback'

/**
 * 自主唤醒意图。
 * wake：值得单独叫醒模型；ambient：只随下一次唤醒/用户消息顺带投递。
 */
export type EventAttention = 'wake' | 'ambient'

/** 事件封装。只有 text 会进入模型上下文；meta 只用于本地诊断。 */
export interface EventEnvelope {
  cursor: number
  run?: string
  type: string
  ts: string
  source: string
  origin: 'external' | 'internal'
  text: string
  tags?: string[]
  meta?: Record<string, unknown>
  attention?: EventAttention
  persist?: false
  deliver?: false
  ephemeral?: true
}

export interface EventInput {
  type: string
  source: string
  origin?: 'external' | 'internal'
  text: string
  tags?: string[]
  meta?: Record<string, unknown>
  /** 默认触发；未填时按来源推断（chat→flush，activity→debounce，其余→flush）。 */
  trigger?: TriggerMode
  /** 自主唤醒意图；存在时由 WakeGovernor 统一决定 flush/piggyback。 */
  attention?: EventAttention
  persist?: false
  deliver?: false
  ephemeral?: true
}

export type TurnOutcome = 'done' | 'failed' | 'capped'

export interface RunPhaseState {
  phase: 'idle' | 'delivering' | 'model' | 'tools' | 'backoff' | 'handoff'
  round: number
  running: string[]
  retryAt?: number
  enteredAt: number
  approvalPending: boolean
  /** 本拍受信任的来源；表现层据此区分用户明确请求与自主选择。 */
  source?: ToolSource
  /** 本轮由真实 reaction 事件触发；状态条在运行期间不展示思考/工具相位。 */
  reaction?: boolean
  /** 本轮进入 idle 时没有用户可见输出；状态条不展示完成态；失败仍展示。 */
  silentEnd?: boolean
}

export type ModelPhase = RunPhaseState['phase']

/** 流式输出接收器的事件。聊天窗与诊断都从这一路取流式输出。 */
export type TapEvent =
  | { type: 'conversation_append'; history: Array<{ kind: 'user' | 'assistant'; text: string; at: number; aborted?: boolean }> }
  | { type: 'conversation_reset' }
  | {
      type: 'batch_start'
      events: EventEnvelope[]
      /** 纯自主批次：正文只用于当轮，不显示也不写入会话。 */
      proactive: boolean
    }
  | { type: 'assistant_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_args'; id: string; delta: string }
  | {
      type: 'tool_result'
      id: string
      name: string
      text: string
      failed: boolean
      /** 仅本地运行时使用：指纹/目标引用等，不显示、不落盘。 */
      meta?: ToolOutcomeMeta
    }
  | { type: 'assistant_end'; text: string; aborted: boolean }
  | { type: 'usage'; usage: Usage }
  | { type: 'turn_end'; outcome: TurnOutcome; report: TurnReport }
  | { type: 'batch_end'; outcome: TurnOutcome; report: TurnReport }

export interface OutputTap {
  onEvent(event: TapEvent): void
  /** 是否已经产生外部可见输出（preempt 据此判断能否取消当前轮）。 */
  externalizes(): boolean
}

// ---------------------------------------------------------------------------
// 模型协议
// ---------------------------------------------------------------------------

export interface ModelToolCall {
  id: string
  type?: 'function'
  function: { name: string; arguments: string }
}

/** OpenAI 兼容的 content parts；图片只允许出现在 user 消息里。 */
export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ModelContentPart[] | null
  tool_calls?: ModelToolCall[]
  tool_call_id?: string
  name?: string
}

/** 工具返回的截图；base64 只进内存，绝不落盘。 */
export interface ToolImage {
  mimeType: 'image/jpeg' | 'image/png'
  /** 纯 base64，不含 data: 前缀。 */
  data: string
  width: number
  height: number
  label?: string
  detail?: 'auto' | 'low' | 'high'
  /**
   * 图片来源类别。截图与 B 站故事板抽帧有不同的数量上限和标签；
   * 老工具省略时按屏幕截图处理。
   */
  kind?: 'screenshot' | 'video-frame'
}

export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens?: number
  cacheMissTokens?: number
}

export interface ModelFacts {
  model: string
  contextWindow?: number
  maxOutputTokens?: number
}

export interface ModelRequest {
  model: string
  messages: ModelMessage[]
  tools?: ToolSpec[]
  maxTokens?: number
  thinking?: boolean
}

export type ModelEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool_call'
      index: number
      id?: string
      name?: string
      argumentsDelta?: string
    }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason?: string }

export interface ModelInfo {
  id: string
  ownedBy?: string
}

/** Provider 在 HTTP 响应头到达时回调；让 Core 能区分“请求中/已到响应头/流中”。 */
export interface ModelStreamObserver {
  onResponseStarted?(): void
}

export interface ModelProvider {
  id: 'deepseek'
  stream(
    req: ModelRequest,
    signal: AbortSignal,
    observer?: ModelStreamObserver
  ): AsyncIterable<ModelEvent>
  listModels(): Promise<ModelInfo[]>
  modelFacts(): ModelFacts
  /** 脱敏后的服务地址 origin；用于诊断，不包含路径、查询串或凭据。 */
  endpointOrigin?(): string
}

/** 一次失败/停止的归类；与“正常完成”“正常沉默”严格分开。 */
export type TurnFailureKind =
  | 'provider'
  | 'protocol'
  | 'config'
  | 'tool'
  | 'authorization'
  | 'target'
  | 'round-cap'
  | 'cancelled'
  /** 运行时自身异常；不等于模型请求失败或工具失败。 */
  | 'internal'

export type TurnFailureStage =
  | 'delivery'
  | 'model-request'
  | 'model-stream'
  | 'handoff'
  | 'tools'
  | 'approval'
  | 'round-limit'
  | 'cancel'
  | 'other'

export type TurnRecoveryState =
  /** 用户主动停止或没有可恢复内容。 */
  | 'not-needed'
  /** 可再次尝试，或用户可继续当前任务。 */
  | 'retryable'
  /** 需要用户补充授权、改目标或检查配置。 */
  | 'needs-user'
  /** 自动恢复被禁止（例如同一协议结构被阻断）。 */
  | 'blocked'

/** 单轮结构化结果；供状态条、聊天提示与诊断共用，不含正文/参数/路径。 */
export interface TurnFailure {
  kind: TurnFailureKind
  stage: TurnFailureStage
  errorCode: string
  recoveryState: TurnRecoveryState
  retryable: boolean
  /** 已完成的安全步骤名（工具名或轮次阶段），不含参数。 */
  completed: string[]
  /** 失败前已有可验证进展；防止把部分完成说成完全失败。 */
  partial: boolean
  /** 已脱敏的短原因；只用于诊断与状态条。 */
  reason: string
}

export interface TurnReport {
  /** 每次模型批次唯一；用于把状态、聊天提示与诊断关联起来。 */
  turnId: string
  sessionId: string
  at: number
  source: ToolSource
  outcome: TurnOutcome
  /** null 表示正常完成/正常沉默，不是失败。 */
  failure: TurnFailure | null
  /** 同一故障链的重复次数与首次时间；用于合并提示。 */
  repeatCount: number
  firstAt: number
  userInitiated: boolean
  background: boolean
  round: number
}

/** 失败所属层：传输、超时、HTTP、响应格式、取消、配置、协议或运行时内部错误。 */
export type ProviderErrorCategory =
  | 'transport'
  | 'timeout'
  | 'http'
  | 'response'
  | 'cancelled'
  | 'config'
  | 'protocol'
  | 'internal'

/** 失败发生在请求生命周期的哪一段；unknown 表示无法确定，不做猜测。 */
export type ProviderTransportPhase = 'request' | 'response-headers' | 'stream' | 'unknown'

export type ProviderCauseStatus = 'present' | 'none'

/** 经过白名单筛选的底层原因；不含堆栈、请求体或响应正文。 */
export interface ProviderCauseInfo {
  name: string
  code?: string
  errno?: string | number
  syscall?: string
  /** 已脱敏并截断的底层错误消息。 */
  message?: string
}

export interface ProviderErrorDiagnostics {
  category: ProviderErrorCategory
  transportPhase: ProviderTransportPhase
  /** none 表示底层错误确实没有携带 cause；不是“没查”。 */
  causeStatus: ProviderCauseStatus
  causeCode?: string
  causeName?: string
  /** 至多 4 条，已按深度/条数截断并防循环。 */
  causes?: ProviderCauseInfo[]
  aggregateCount?: number
  truncated?: boolean
}

export interface ProviderErrorOptions {
  status?: number
  retryable?: boolean
  code?: string
  category?: ProviderErrorCategory
  diagnostics?: ProviderErrorDiagnostics
  /** 原始错误；保留在 Error.cause 上供调用方检查，不直接写日志。 */
  cause?: unknown
}

const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

export class ProviderError extends Error {
  readonly status: number | undefined
  readonly retryable: boolean
  readonly code: string
  readonly category: ProviderErrorCategory
  readonly diagnostics: ProviderErrorDiagnostics

  constructor(message: string, opts: ProviderErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'ProviderError'
    this.status = opts.status
    this.category = opts.category ?? (opts.status === undefined ? 'transport' : 'http')
    this.code = opts.code ?? (opts.status === undefined ? 'NETWORK' : `HTTP_${opts.status}`)
    this.retryable =
      opts.retryable ??
      (opts.status === undefined ? true : RETRYABLE_HTTP_STATUS.has(opts.status))
    this.diagnostics =
      opts.diagnostics ??
      {
        category: this.category,
        transportPhase: 'unknown',
        causeStatus: opts.cause === undefined ? 'none' : 'present'
      }
  }

  /** 底层错误的第一个 code（例如 ECONNRESET/ENOTFOUND）；没有时不猜测。 */
  get causeCode(): string | undefined {
    return this.diagnostics.causeCode
  }

  get causeName(): string | undefined {
    return this.diagnostics.causeName
  }

  get transportPhase(): ProviderTransportPhase {
    return this.diagnostics.transportPhase
  }
}

/** 结构化模型请求失败通知；不含请求/响应正文。 */
export interface ProviderFailureNotice {
  sessionId: string
  turnId: string
  turn: number
  source: ToolSource
  stage: 'model-request' | 'stream' | 'handoff' | 'other'
  code: string
  status?: number
  retryable: boolean
  recoveryState: TurnRecoveryState
  userInitiated: boolean
  /** 已脱敏的短原因；只用于诊断与状态条。 */
  reason: string
  at: number
  /** 失败层与生命周期阶段；与“是否收到过 ModelEvent”无关。 */
  category: ProviderErrorCategory
  transportPhase: ProviderTransportPhase
  causeStatus: ProviderCauseStatus
  causeCode?: string
  causeName?: string
  causes?: ProviderCauseInfo[]
  aggregateCount?: number
  /** cause 链因深度/条数/长度限制被截断。 */
  causeTruncated?: boolean
  /** 同一次逻辑请求（重试共享）；缺失表示失败在请求发出前（如缺少 Key）。 */
  requestId?: string
  /** 物理请求序号，从 1 开始；重试时递增。 */
  attempt?: number
  model?: string
  /** 脱敏后的 origin；不含路径与查询串。 */
  origin?: string
  elapsedMs?: number
  headersReceived?: boolean
  sawModelEvent?: boolean
}

// ---------------------------------------------------------------------------
// 会话上下文
// ---------------------------------------------------------------------------

export interface ContextToolCall {
  id: string
  name: string
  arguments: string
}

export interface ContextImage extends ToolImage {
  at: number
}

export type ContextRecord = { source?: 'chat' | 'quick' | 'background'; retention?: 'persistent' | 'memory' } & (
  | { kind: 'system'; text: string; ts: string; ephemeral?: boolean }
  | {
      kind: 'user'
      text: string
      ts: string
      cursors?: number[]
      ephemeral?: boolean
      /** 只存在于内存的截图；带图片的 user 记录永远是 ephemeral。 */
      images?: ContextImage[]
    }
  | {
      kind: 'assistant'
      text: string
      ts: string
      toolCalls?: ContextToolCall[]
      reasoning?: string
      aborted?: boolean
    }
  | {
      kind: 'tool'
      toolCallId: string
      name: string
      text: string
      ts: string
      failed?: boolean
      /**
       * 真实执行了工具，但正文只存在于当轮内存；清理后保留一个不含正文的
       * 回执壳，维持工具调用/回执的协议配对。
       */
      expired?: boolean
      /** 缺少真实回执（进程重启/会话损坏），执行结果未知，不能当成成功。 */
      unknown?: boolean
      ephemeral?: boolean
    }

)

export interface SessionInfo {
  id: string
  label: string
  rounds: number
  estTokens: number
  hardTokens: number | null
  messageCount: number
}

export interface SessionDecl {
  id: string
  label: string
  rounds: () => { soft: number; hard: number }
  persistent: boolean
  receivesEvents: boolean
  eventDelivery: 'user'
  tools: () => ToolDef[]
}

export interface PrefixSegment {
  id: string
  text: string
}

export interface WorldPrefixContext {
  id: string
  vars: Record<string, string> | null
  /** `ENV_PROMPT.md` 原文（由 World 提供，Core 只搬运）。 */
  prompt?: string | null
}

export interface Persona {
  attach(core: CoreApi): void
  declareSessions(): SessionDecl[]
  systemSegments(ctx: {
    now: Date
    timezone: string
    worlds: WorldPrefixContext[]
    /** 本轮模型可见的工具组；用于按需裁剪组说明，不参与权限判断。 */
    toolExposure?: {
      loadedGroups: readonly string[]
      catalogText: string
    }
  }): Promise<PrefixSegment[]>
  onOpening?(ctx: { reason: 'new' | 'restarted' | 'cleared' }): void
  /**
   * 每批事件进入上下文前的钩子。返回值会作为一条 ephemeral 的 system 说明
   * 插在批首；不返回则不插。
   */
  onDelivery?(ctx: { events: EventEnvelope[] }): void | string | Promise<void | string>
  onBatchEnd?(): void | Promise<void>
  onTurnEnded?(outcome: TurnOutcome): void
  onIdle?(): void | Promise<void>
  onHandoff?(
    snapshot: ContextRecord[],
    ctx: { hardTokens: number | null }
  ): Promise<{ tail: ContextRecord[] | null; trim?: boolean }>
  ownToolNames?(): string[]
  /**
   * 与主聊天共享的少量人格背景（活跃兴趣/真实经历）。屏幕评论等独立短请求
   * 用它保持“我知道什么”一致；返回 null 表示没有可带内容。
   */
  companionBackdrop?(): string | null
  memoryDir: string
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export type ToolTargetKind = 'file' | 'window' | 'page' | 'web' | 'note' | 'app'

export interface ToolOutcomeMeta extends EvidenceFields {
  /** 内容指纹：只用于本地去重，不进入模型文本、不落盘。 */
  fingerprint?: string
  targetKind?: ToolTargetKind
  /** 相对路径/域名/应用标签；绝不放绝对路径或窗口标题。 */
  targetLabel?: string | null
  targetRef?: string | null
  /** 跟随重定向后的最终 URL；执行器在把正文交给模型前复验域名。 */
  finalUrl?: string
  /**
   * 新模式映射到的旧操作身份（如 computer_observe(target=windows) → win_list）。
   * 仅供本地进展分类/诊断；不显示给模型，也不落盘。
   */
  operation?: string
}

/**
 * 失败的可持久化诊断事实。
 *
 * 只允许固定枚举/计数/短标识；绝不放页面标题、正文、字幕、Cookie、token、
 * 完整 URL 或查询参数。执行器会经严格白名单写入 audit.jsonl，供重启后追溯。
 */
export interface ToolDiagnostics {
  /** 工具/操作名，如 bili_open、web_navigate。 */
  op?: string
  /** 浏览器失败阶段（固定枚举）。 */
  stage?: string
  /** 应用分类码，如 load-timeout、cooldown。 */
  code?: string
  /** 扩展返回的原始错误码，如 LOAD_TIMEOUT。 */
  rawCode?: string
  /** 页面适配器解析码，如 LINK_REJECTED。 */
  parseCode?: string
  retryable?: boolean
  /** 本次工具尝试标识；只用于本地串联。 */
  attemptId?: string
  /** 桥分配的命令编号；只用于本地串联。 */
  commandId?: string
  /** 运行中的扩展实例与版本（运行时握手，不是磁盘版本）。 */
  instanceId?: string
  extensionVersion?: string | null
  extensionBuildId?: string | null
  protocolVersion?: number | null
  /** 是否在冷却/暂停期被前置拒绝；这类拒绝没有真正执行。 */
  cooldown?: boolean
  /** 是否因用户接管而停下。 */
  takenOver?: boolean
  /** 候选计数；只保留数量，不保留标题/链接。 */
  candidateCount?: number
  rejectedCount?: number
}

export interface ToolOutcome {
  code?: string
  text: string
  /** 仅当前 turn 的模型消息可见；与文本回执一样不落盘。 */
  images?: ToolImage[]
  blobs?: Record<string, string>
  failed?: boolean
  /**
   * 工具回执只在当前轮可见：留在内存供模型继续使用，但不写会话 JSONL，
   * 并会在下一批投递前被 dropEphemeral 清除。用于页面正文等不可落盘内容。
   */
  ephemeral?: true
  /** 仅执行器/运行时可见的本地元数据。 */
  meta?: ToolOutcomeMeta
  /** 失败的安全诊断；执行器白名单写入审计，不进入会话/模型文本。 */
  diagnostics?: ToolDiagnostics
}

export interface DynamicApprovalRequest {
  origin?: ApprovalOrigin
  reason: string
  preview?: ApprovalPreview
  risk?: ApprovalRisk
}

export type ApprovalRisk = 'low' | 'medium' | 'high'

/** 黄区审批可选的授权范围；红区只允许 once。 */
export type ApprovalScope = 'once' | 'session' | 'always'

export interface ApprovalPreview {
  kind: 'diff' | 'command' | 'text' | 'list'
  title: string
  body?: string
  diff?: string
  path?: string
  command?: string
  cwd?: string
}

/** 审批来自哪个入口；两个入口的 UI 与计数互不干扰。 */
export type ApprovalOrigin = 'chat' | 'quick'

export interface ApprovalRequest {
  id: string
  toolName: string
  summary: string
  preview: ApprovalPreview
  risk: ApprovalRisk
  createdAt: number
  expiresAt: number
  /** 是否允许“本会话”授权。红区恒为 false。 */
  sessionScoped: boolean
  /** 是否允许“始终允许此类”授权。红区恒为 false。 */
  alwaysScoped: boolean
  /** 授权范围的人类可读说明，例如“同一工作区内的写入”。 */
  grantLabel?: string
  /** “本会话”按钮的展示文案；CUA 用“30 分钟内”。 */
  sessionScopeLabel?: string
  /** 模型写的一句第一人称请求（已清洗）；仅展示，不参与风险/授权判断。 */
  approvalAsk?: string
  origin: ApprovalOrigin
  sessionId: string
  /** 工具调用的真实来源；用于审批卡显示「来自任务/自主」。 */
  source?: ToolSource
  /** 任务来源时绑定任务 id；UI 可据此提供「撤销该任务」。 */
  taskId?: string
  taskTitle?: string
}

export interface ApprovalDecision {
  approved: boolean
  reason?: string
  grantScope?: ApprovalScope
}

/**
 * 工具组加载结果。只改变“下一轮可见集合”，不授予权限、不执行动作。
 * failed 仅用于“请求无效/重复空循环”，不表示组内动作失败。
 */
export interface ToolExposureLoadResult {
  text: string
  changed: boolean
  failed?: boolean
}

/**
 * 执行器交给模型的当轮暴露快照。names 固定于发送该模型请求时，
 * tools_load 只能影响下一次请求；它绝不是授权，执行仍要过权限校验。
 */
export interface ToolRequestExposure {
  requestId: string | null
  revision: number
  names: ReadonlySet<string>
  groups: readonly string[]
  /** 快捷聊天配置里按名字禁用的工具；同时检查旧操作身份。 */
  deniedNames?: ReadonlySet<string>
  deniedOperations?: ReadonlySet<string>
  load(groups: readonly string[]): ToolExposureLoadResult
  catalog(): string
}

export interface ToolContext {
  sessionId: string
  /** 宿主分配的当前回合/批次稳定 ID；用于同一回复的展示去重。 */
  turnId?: string
  turn: number
  /** 调用来自哪个入口；任务工具据此拒绝自主心跳/越权调用。 */
  source: ToolSource
  /** 任务来源时绑定任务 id；其它来源为 undefined。 */
  taskId?: string
  /** 任务来源时的 generation；用于拒绝迟到/已撤销任务的动作。 */
  taskGeneration?: number
  /** 执行器从任务 grant 解析出的受权应用；CUA 输入前再次核对前台应用。 */
  allowedDesktopApps?: string[]
  /** 执行器从任务 grant 解析出的受权域名；联网抓取必须走可复验重定向的路径。 */
  allowedDomains?: string[]
  /** 本轮已接触网页/屏幕等不可信内容；兴趣正文等长期写入必须等下一轮。 */
  tainted?: boolean
  /** 当前请求的工具组入口；只有 tool_groups/tools_load 需要读取。 */
  toolExposure?: ToolRequestExposure
  signal: AbortSignal
  /** 工具 handler 可在执行中再请求一次审批（敏感读取、大文件等）。 */
  requireApproval(request: DynamicApprovalRequest): Promise<boolean>
  log: (level: LogLevel, msg: string, data?: Record<string, unknown>) => void
  now(): number
}

export interface ApprovalInfo {
  summary: string
  preview: ApprovalPreview
  risk?: ApprovalRisk
  /** 终端类工具：用户可选择“本会话允许该精确命令”。 */
  exactCommand?: string
}

export interface ToolDef {
  name: string
  description: string
  parameters: ZodTypeAny
  tags?: Array<'read' | 'write' | 'delete' | 'network' | 'terminal' | 'presentation' | 'memory'>
  approval?: 'auto' | 'required'
  /** 返回 false 时模型看不到该工具，执行也会被拒绝（CUA 开关热更新）。 */
  enabled?: () => boolean
  interruptible?: boolean
  endsTurn?: boolean
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolOutcome>
  /** 静态审批为 required 时，用来生成审批卡内容。 */
  approvalInfo?: (args: unknown) => ApprovalInfo
  /** 覆盖审计摘要；用于避免把完整路径、链接查询串等写进 logs/audit.jsonl。 */
  auditSummary?: (args: unknown) => string
}

export interface ToolSummary {
  name: string
  description: string
  tags: string[]
  approval: 'auto' | 'required'
  /** 运行时是否可用；静态 describe 列表可省略。 */
  enabled?: boolean
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export interface EventSummary {
  type: string
  description: string
}

export interface WorldDescribe {
  tools: ToolSummary[]
  events: EventSummary[]
}

export interface WorldStore {
  /** 只读查询本 World 自己的事件。 */
  query(filter: { source: string; typePrefix?: string; limit?: number }): EventEnvelope[]
}

export interface WorldHost {
  pushEvent(input: EventInput): EventEnvelope
  pushDeferred(text: string): void
  store: WorldStore
  log: (level: LogLevel, msg: string, data?: Record<string, unknown>) => void
  modelFacts(): ModelFacts
  reportUsage(usage: Usage): void
}

export interface World {
  id: string
  envPromptVars(): Record<string, string> | null | Promise<Record<string, string> | null>
  /** World 的 `ENV_PROMPT.md`；没有环境提示词时返回 null。 */
  envPrompt?(): string | null
  tools(): ToolDef[]
  start(host: WorldHost): Promise<void>
  stop(): Promise<void>
  outputTap?(): OutputTap | undefined
  onRunPhase?(phase: RunPhaseState): void
  onEventsSettled?(events: EventEnvelope[], outcome: 'delivered' | 'discarded'): void
  onHandoffEnded?(): void
  onTurnEnded?(outcome: TurnOutcome): void
  describe: WorldDescribe
  /** 由 Core 在 start 成功后设置；构造/启动失败时该 World 不可用。 */
  available?: boolean
  unavailableReason?: string
}

// ---------------------------------------------------------------------------
// Core API / Persona
// ---------------------------------------------------------------------------

export interface ForkOptions {
  purpose: string
  messages: ModelMessage[]
  model?: string
  maxTokens?: number
  /** 调用方取消（例如清空数据/退出）时中止 fork 请求。 */
  signal?: AbortSignal
}

export interface CoreApi {
  injectInternal(
    text: string,
    kind: string,
    opts?: {
      attention?: EventAttention
      meta?: Record<string, unknown>
      trigger?: TriggerMode
    }
  ): void
  /**
   * 自主/陪伴唤醒：先经过 WakeGovernor 的独立预算与安静判断。
   * 返回实际决策；被降级时调用方应自行安排下一次评估。
   */
  injectWake(
    text: string,
    wakeKind: 'autonomy' | 'companion',
    opts?: { meta?: Record<string, unknown> }
  ): import('../shared/wake').WakeDecision
  /** 不经 chat.user_message 的用户输入（快捷聊天/触摸），重置主动聊天冷却。 */
  noteUserActivity(now?: number): void
  requestContextHandoff(): void
  spawnFork(opts: ForkOptions): Promise<{ text: string; usage?: Usage }>
  sessionInfo(id: string): SessionInfo
  isBusy(): boolean
  isPaused(): boolean
  timers: TimerApi
  log: Logger
  /** 只对下一轮模型调用生效的工具白名单；null 表示不限制。 */
  setTurnToolAllowlist(names: string[] | null): void
  /**
   * 宿主可信路径预载工具组（任务能力/异步转写等）。只影响下一次活动回合，
   * 仍需通过原有授权；模型不能用自然语言调用这个入口。
   */
  preloadToolGroups(groups: string[], reason: string): void
}

export interface TimerApi {
  set(
    atIso: string,
    payload: {
      note: string
      kind: string
      repeat?: 'daily'
      taskId?: string
      taskGeneration?: number
    }
  ): string
  cancel(id: string): boolean
  list(): Array<{
    id: string
    at: string
    note: string
    kind: string
    repeat?: 'daily'
    taskId?: string
    taskGeneration?: number
  }>
  clear(): void
}

/**
 * Core 与任务运行时之间的窄接口。Core 只负责把「这批事件属于哪个任务」
 * 与工具结果转交出去；任务状态、预算与持久化都在 TaskRunner。
 */
export interface TaskRuntimeHooks {
  canRun(taskId: string, generation: number, now: number): boolean
  /** 执行器复验：任务非终态、未暂停，且 generation 仍匹配。 */
  isCurrent(taskId: string, generation: number): boolean
  onCycleStarted(ctx: { taskId: string; generation: number; now: number }): void
  onToolIntent(ctx: {
    taskId: string
    generation: number
    callId: string
    tool: string
    sideEffect: boolean
    verify: boolean
    now: number
  }): void
  onToolResult(ctx: {
    taskId: string
    generation: number
    callId: string
    tool: string
    outcome: ToolOutcome
    sideEffect: boolean
    verify: boolean
    now: number
  }): { abort: boolean; reason?: string }
  onCycleEnded(ctx: {
    taskId: string
    generation: number
    outcome: TurnOutcome
    now: number
  }): void
  /** 返回 true 表示由 TaskRunner 接管（Core 不再投递普通 timer.due）。 */
  onTimer(taskId: string, generation: number | undefined, now: number): boolean
  /**
   * 可信未完成用户任务声明的能力。仅供下一轮工具组可见性预载；
   * 不授予权限，不能替代 task grant 或用户审批。
   */
  unfinishedTaskCapabilities?(): readonly string[]
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  log(level: LogLevel, msg: string, data?: Record<string, unknown>): void
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

// ---------------------------------------------------------------------------
// Provider 相关
// ---------------------------------------------------------------------------

export interface ProviderConfigView {
  apiKey: string
  config: AppConfig['provider']
}

export interface Clock {
  now(): number
  sleep?(ms: number, signal?: AbortSignal): Promise<void>
}
