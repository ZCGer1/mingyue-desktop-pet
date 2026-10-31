/**
 * 主动浏览器控制的线路协议。
 *
 * 扩展的 service worker 长轮询 /v1/command，拿到一条指令后在页面/标签上
 * 执行，再用 /v1/result 回传结果。桥只做鉴权、排队和超时；页面内容不写盘、
 * 不写日志。结果里的文本由 BrowserControlWorld 再次清洗后才交给模型。
 */

export interface BrowserCommand {
  id: string
  op: string
  params: Record<string, unknown>
  /** 指令生成的本地时间；扩展可据此丢弃过期指令。 */
  issuedAt: number
}

/**
 * 失败发生的位置。只使用固定枚举，扩展不能用页面文字自由填写；
 * 诊断与模型回执都靠它区分“没打开标签”“页面没加载”“解析失败”。
 */
export type BrowserFailureStage =
  | 'preflight'
  | 'approval'
  | 'dispatch'
  | 'tab-create'
  | 'navigation'
  | 'content-ready'
  | 'media-guard'
  | 'extraction'
  | 'result-validation'

export const BROWSER_FAILURE_STAGES: readonly BrowserFailureStage[] = [
  'preflight',
  'approval',
  'dispatch',
  'tab-create',
  'navigation',
  'content-ready',
  'media-guard',
  'extraction',
  'result-validation'
]

export function isBrowserFailureStage(value: unknown): value is BrowserFailureStage {
  return typeof value === 'string' && (BROWSER_FAILURE_STAGES as readonly string[]).includes(value)
}

export interface BrowserCommandResult {
  ok: boolean
  code?: string
  error?: string
  /** 失败阶段；成功时通常缺省。 */
  stage?: BrowserFailureStage
  /** 有界重试提示；扩展只报告“是否值得重试”，不自行重放。 */
  retryable?: boolean
  /** 指令来源操作（web_open 等）；只用于本地诊断。 */
  op?: string
  /** 桥生成的指令编号；只用于本地串联指令与运行实例，不含页面内容。 */
  commandId?: string
  /** 实际执行/拒绝该指令的扩展实例与运行版本；由桥在分发时绑定。 */
  instanceId?: string
  extensionVersion?: string | null
  extensionBuildId?: string | null
  protocolVersion?: number | null
  result?: unknown
  durationMs: number
}

/** 桥与扩展的协议版本；扩展握手必须回报且不得高于服务端。 */
export const BROWSER_CONTROL_PROTOCOL_VERSION = 1

/** 旧扩展（没有 supportedOps 声明）可被信任的通用浏览指令。 */
export const LEGACY_BROWSER_CONTROL_OPS: readonly string[] = [
  'tabs',
  'open',
  'navigate',
  'snapshot',
  'find',
  'click',
  'type',
  'select',
  'key',
  'scroll',
  'wait',
  'tab_switch',
  'tab_close',
  'restore_tabs',
  'back',
  'forward',
  'download'
]

/** 普通网页主动浏览（与 B 站共用会话/预算的通用适配指令）。 */
export const WEB_BROWSER_OPS: readonly string[] = ['web_open', 'web_navigate', 'web_media', 'web_close']

export const ALL_BROWSER_CONTROL_OPS: readonly string[] = [
  ...LEGACY_BROWSER_CONTROL_OPS,
  ...WEB_BROWSER_OPS
]

/**
 * 浏览器里正在运行的一个扩展实例。`version`/`buildId` 来自运行时握手，
 * 不是磁盘上安装包的版本；`supportedOps` 为空且 capabilitiesDeclared 为
 * true 时，表示扩展明确声明了能力但没有任何当前协议认识的指令。
 */
export interface BrowserExtensionRuntimeView {
  instanceId: string
  version: string | null
  protocolVersion: number | null
  buildId: string | null
  capabilitiesDeclared: boolean
  supportedOps: string[]
  controlConsent: boolean | null
  controlConnected: boolean
  lastHelloAt: number | null
  lastPollAt: number | null
  lastResultAt: number | null
}

/** 扩展回报的标签/页面摘要（可能含标题；只在当轮使用）。 */
export interface BrowserTabInfo {
  tabId: number
  windowId?: number
  active: boolean
  owned: boolean
  title?: string
  url?: string
  status?: string
}

export interface BrowserElementInfo {
  ref: string
  role: string
  name: string
  tag: string
  value?: string
  checked?: boolean
  disabled?: boolean
  href?: string
  frameId?: number
}

export interface BrowserSnapshot {
  tabId: number
  frameId: number
  pageId: string
  pageVersion: number
  url: string
  title: string
  readyState: string
  capturedAt: number
  elements: BrowserElementInfo[]
  text: string
  headings?: string[]
  truncated: boolean
  hasMore?: boolean
  totalElements?: number
  dialogs?: string[]
  frames?: Array<{ frameId: number; url: string; name?: string }>
}

export interface BrowserActionResult {
  ok: boolean
  executed: boolean
  verified: boolean
  code?: string
  message?: string
  pageId?: string
  pageVersion?: number
  url?: string
  title?: string
  value?: string
  requiresConfirmation?: boolean
  externalAction?: string
  newTabs?: BrowserTabInfo[]
  observation?: BrowserSnapshot
}
