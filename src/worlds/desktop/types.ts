/**
 * 桌面观察端口类型。窗口 id 是不透明摘要；原始 HWND、标题与文本
 * 只在主进程与当轮工具回执中存在，不落盘、不进日志。
 */

export interface DesktopRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopWindowRef {
  /** opaque id = hash(salt + hwnd)，只在本次应用启动内有效。 */
  id: string
  /** 规范化进程键（小写、无 .exe）。 */
  process: string
  /** 窗口标题原文；World 负责在进入模型前脱敏。 */
  title: string
  foreground: boolean
  /** 窗口当前的全局 DIP 边界；用于验证截图基线是否仍然有效。 */
  bounds?: DesktopRect
  /** 窗口所在显示器的缩放比例；不参与坐标换算，仅用于诊断。 */
  scaleFactor?: number
}

export interface DesktopWindowText {
  text: string
  truncated: boolean
  uiaAvailable: boolean
  /** 标题或 UIA 文本命中敏感词；World 不得把内容交给模型。 */
  sensitive: boolean
}

export type DesktopHealthState = 'ok' | 'degraded' | 'unavailable'

export interface DesktopHealth {
  state: DesktopHealthState
  reason: string | null
}

export interface DesktopCapture {
  /** 只存在于当轮图片；不落盘。 */
  base64: string
  mimeType: 'image/png'
  width: number
  height: number
  /** 截图时窗口的全局 DIP 边界；图像像素按此范围线性映射。 */
  bounds: DesktopRect
  /** 截图所在显示器的缩放比例。 */
  scaleFactor: number
}

/**
 * `win_capture` 成功后交给 CUA 世界登记的窗口截图。同一份几何信息既用于
 * 把图像像素换算成全局 DIP，也用于输入前确认窗口没有移动/缩放。
 */
export interface DesktopWindowCaptureInfo extends DesktopCapture {
  windowId: string
  /** 规范化进程键。 */
  appProcess: string
  appLabel: string
  capturedAt: number
}

/** 输入前对目标窗口的低成本探针；只读，不截图。 */
export interface DesktopWindowProbe {
  foreground: boolean
  process: string | null
  bounds: DesktopRect | null
  scaleFactor: number | null
}

/** UI Automation 控件可执行的语义动作；不包含任何“按坐标点击”。 */
export type DesktopElementAction =
  | 'invoke'
  | 'set_value'
  | 'select'
  | 'toggle'
  | 'expand'
  | 'collapse'
  | 'scroll'
  | 'focus'

/**
 * 一个 UIA 控件。`id` 是不可逆摘要（salt + windowId + RuntimeId），只在
 * 本次应用启动内有效；每次操作都会重新遍历控件树定位，不能拿旧 id 盲操作。
 */
export interface DesktopElementRef {
  id: string
  /** ControlType 的程序化名称，如 Button/Edit/MenuItem。 */
  role: string
  /** 控件名称；可能包含窗口内容，World 负责脱敏并只当轮使用。 */
  name: string
  /** ValuePattern 的当前值；没有该模式时为 null。 */
  value: string | null
  enabled: boolean
  actions: DesktopElementAction[]
  /** 全局 DIP 边界；只用于诊断，不用于输入。 */
  bounds?: DesktopRect
  /** 元素所在显示器的缩放比例。 */
  scaleFactor?: number
}

export interface DesktopElementSnapshot {
  elements: DesktopElementRef[]
  truncated: boolean
  /** 控件文本命中敏感词；World 不得把控件内容交给模型。 */
  sensitive: boolean
}

export interface DesktopElementResult {
  /** 控件模式调用已经发生（不等于产生了业务效果）。 */
  executed: boolean
  /** 动作后读回了可观察状态，且与预期一致。 */
  verified: boolean
  /** 动作后能读到的值（已截断）；仅当轮使用，不落盘。 */
  valueAfter: string | null
  /** 不能验证时的诚实原因，例如 not-observable。 */
  verification: string
}

export class DesktopPortError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'DesktopPortError'
    this.code = code
  }
}

export interface DesktopPort {
  listWindows(allowedProcesses: readonly string[]): Promise<DesktopWindowRef[]>
  /**
   * 读取窗口的 UI Automation 文本。allowedProcesses 由调用方按当前配置传入，
   * helper 会重新验证目标窗口属于该范围（不能只信任缓存 id）。
   */
  readWindow(
    id: string,
    allowedProcesses: readonly string[],
    maxChars: number,
    signal?: AbortSignal
  ): Promise<DesktopWindowText>
  captureWindow(
    id: string,
    allowedProcesses: readonly string[],
    signal?: AbortSignal
  ): Promise<DesktopCapture>
  focusWindow(id: string, allowedProcesses: readonly string[]): Promise<boolean>
  /** 读取窗口的 UIA 控件树（名称/类型/值/可用动作），跳过密码框与不可见元素。 */
  listElements(
    id: string,
    allowedProcesses: readonly string[],
    maxElements: number,
    signal?: AbortSignal
  ): Promise<DesktopElementSnapshot>
  /** 对控件执行语义动作；helper 会重新定位 id 并读回状态做验证。 */
  actElement(
    id: string,
    allowedProcesses: readonly string[],
    elementId: string,
    action: DesktopElementAction,
    value: string | null,
    signal?: AbortSignal
  ): Promise<DesktopElementResult>
  /** 设置页候选：只有进程键，不含标题。 */
  listApps(): Promise<string[]>
  health(): DesktopHealth
}
