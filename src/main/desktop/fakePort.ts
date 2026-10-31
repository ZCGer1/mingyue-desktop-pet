import {
  DesktopPortError,
  type DesktopCapture,
  type DesktopElementAction,
  type DesktopElementRef,
  type DesktopElementResult,
  type DesktopElementSnapshot,
  type DesktopHealth,
  type DesktopPort,
  type DesktopRect,
  type DesktopWindowRef,
  type DesktopWindowText
} from '../../worlds/desktop/types'

interface FakeWindow extends DesktopWindowRef {
  text: string
  bounds: DesktopRect
  scaleFactor: number
}

const DEFAULT_WINDOWS: readonly FakeWindow[] = [
  {
    id: 'win-note-1',
    process: 'notepad',
    title: '未命名 - 记事本',
    foreground: true,
    bounds: { x: 100, y: 120, width: 640, height: 400 },
    scaleFactor: 1,
    text: '示例文档\n这是山海之间的一段可观察正文。\n第二行包含一个可以用笔记下来的细节。'
  },
  {
    id: 'win-browser-1',
    process: 'chrome',
    title: '示例文档 - 浏览器',
    foreground: false,
    bounds: { x: 200, y: 160, width: 800, height: 600 },
    scaleFactor: 1,
    text: '示例页面\n浏览器里当前打开的是被动观察到的页面文本。'
  }
]

/**
 * E2E/集成测试用假桌面。只在 MINGYUE_E2E_DESKTOP_FAKE=1 时由 runtime 注入；
 * 永不读取真实窗口，也不提供截图。
 */
export class E2EFakeDesktopPort implements DesktopPort {
  private readonly windows: FakeWindow[]
  private readonly reachable: boolean
  private readonly capture: DesktopCapture | null
  private readonly elementStore = new Map<string, DesktopElementRef[]>()
  private readonly values = new Map<string, string | null>()

  constructor(
    opts: {
      windows?: FakeWindow[]
      reachable?: boolean
      captureAllowed?: boolean
      capture?: DesktopCapture | null
      /** windowId → 控件树；测试用。 */
      elements?: Record<string, DesktopElementRef[]>
    } = {}
  ) {
    this.windows = opts.windows ?? DEFAULT_WINDOWS.map((window) => ({ ...window }))
    this.reachable = opts.reachable ?? true
    this.capture = opts.capture ?? null
    for (const [windowId, elements] of Object.entries(opts.elements ?? {})) {
      const copy = elements.map((element) => ({ ...element, actions: [...element.actions] }))
      this.elementStore.set(windowId, copy)
      for (const element of copy) this.values.set(`${windowId}:${element.id}`, element.value)
    }
  }

  async listWindows(allowedProcesses: readonly string[]): Promise<DesktopWindowRef[]> {
    this.ensureReachable()
    const allowed = new Set(allowedProcesses.map((item) => item.toLowerCase().replace(/\.exe$/, '')))
    return this.windows
      .filter((window) => allowed.has(window.process))
      .map(({ id, process, title, foreground, bounds, scaleFactor }) => ({
        id,
        process,
        title,
        foreground,
        bounds: { ...bounds },
        scaleFactor
      }))
  }

  /** 测试窗口移动/缩放：下一次自动截图与输入前探针会看到新边界。 */
  moveWindow(id: string, bounds: DesktopRect): boolean {
    const window = this.windows.find((item) => item.id === id)
    if (window === undefined) return false
    window.bounds = { ...bounds }
    return true
  }

  async readWindow(
    id: string,
    allowedProcesses: readonly string[],
    _maxChars: number,
    signal?: AbortSignal
  ): Promise<DesktopWindowText> {
    this.ensureReachable()
    if (signal?.aborted === true) throw new DesktopPortError('aborted', '窗口操作已取消')
    const window = this.findTarget(id, allowedProcesses)
    return { text: window.text, truncated: false, uiaAvailable: true, sensitive: false }
  }

  async captureWindow(
    id: string,
    allowedProcesses: readonly string[],
    _signal?: AbortSignal
  ): Promise<DesktopCapture> {
    this.ensureReachable()
    const window = this.findTarget(id, allowedProcesses)
    if (this.capture === null) {
      throw new DesktopPortError('capture-unavailable', '测试假桌面不提供真实截图')
    }
    return {
      ...this.capture,
      bounds: { ...window.bounds },
      scaleFactor: window.scaleFactor
    }
  }

  async focusWindow(id: string, allowedProcesses: readonly string[]): Promise<boolean> {
    this.ensureReachable()
    this.findTarget(id, allowedProcesses)
    return true
  }

  async listElements(
    id: string,
    allowedProcesses: readonly string[],
    maxElements: number,
    signal?: AbortSignal
  ): Promise<DesktopElementSnapshot> {
    this.ensureReachable()
    if (signal?.aborted === true) throw new DesktopPortError('aborted', '窗口操作已取消')
    this.findTarget(id, allowedProcesses)
    const elements = (this.elementStore.get(id) ?? []).slice(0, Math.max(1, maxElements))
    return {
      elements: elements.map((element) => ({
        ...element,
        actions: [...element.actions],
        ...(element.bounds === undefined ? {} : { bounds: { ...element.bounds } })
      })),
      truncated: (this.elementStore.get(id)?.length ?? 0) > elements.length,
      sensitive: false
    }
  }

  async actElement(
    id: string,
    allowedProcesses: readonly string[],
    elementId: string,
    action: DesktopElementAction,
    value: string | null,
    signal?: AbortSignal
  ): Promise<DesktopElementResult> {
    this.ensureReachable()
    if (signal?.aborted === true) throw new DesktopPortError('aborted', '窗口操作已取消')
    this.findTarget(id, allowedProcesses)
    const element = this.elementStore.get(id)?.find((item) => item.id === elementId)
    if (element === undefined) {
      throw new DesktopPortError('element-not-found', '控件不存在或控件树已变化')
    }
    if (!element.actions.includes(action)) {
      throw new DesktopPortError('pattern-unavailable', '该控件不支持这个动作')
    }
    if (action === 'set_value') {
      this.values.set(`${id}:${elementId}`, value ?? '')
    }
    const valueAfter = this.values.get(`${id}:${elementId}`) ?? null
    return {
      executed: true,
      verified: action !== 'invoke',
      valueAfter: action === 'set_value' ? valueAfter : element.value,
      verification: action === 'invoke' ? 'not-observable' : 'simulated'
    }
  }

  async listApps(): Promise<string[]> {
    this.ensureReachable()
    return [...new Set(this.windows.map((window) => window.process))]
  }

  health(): DesktopHealth {
    return this.reachable
      ? { state: 'ok', reason: null }
      : { state: 'unavailable', reason: '测试假桌面不可用' }
  }

  private ensureReachable(): void {
    if (!this.reachable) throw new DesktopPortError('helper-exit', '测试假桌面不可用')
  }

  private findTarget(id: string, allowedProcesses: readonly string[]): FakeWindow {
    const allowed = new Set(allowedProcesses.map((item) => item.toLowerCase().replace(/\.exe$/, '')))
    const window = this.windows.find((item) => item.id === id)
    if (window === undefined || !allowed.has(window.process)) {
      throw new DesktopPortError('window-not-found', '窗口不存在或不在当前观察范围')
    }
    return window
  }
}
