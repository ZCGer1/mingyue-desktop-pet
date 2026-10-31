import {
  BrowserWindow,
  screen,
  type Rectangle,
  type WebContents
} from 'electron'
import { join } from 'node:path'
import { IPC, type ChatOpenEvent, type PetDisplayView } from '../shared/ipc'

/**
 * 三个窗口：
 *
 *  - 桌宠：全工作区透明、置顶、默认点击穿透、不抢焦点；点击它只出现快捷输入；
 *  - 聊天：独立的普通窗口，从托盘/快捷键/模型打开，关闭时只隐藏；
 *  - 设置：普通窗口，只在用户操作时打开。
 *
 * 窗口只加载本地页面，拒绝一切导航、弹窗、webview 与权限请求。
 */

const PET_ORIGIN_FALLBACK = 'http://127.0.0.1'
const POINTER_SAMPLE_MS = 33
const SETTINGS_SIZE = { width: 880, height: 700 }
const CHAT_MIN_SIZE = { width: 420, height: 520 }
const CHAT_DEFAULT_SIZE = { width: 640, height: 720 }
const MAX_PENDING_CHAT_EVENTS = 1_000

interface QueuedChatEvent {
  channel: string
  payload: unknown
}

/**
 * 点击穿透时是否采样系统光标并转发鼠标移动。
 *
 * 生产环境必须开启：整窗穿透的窗口收不到原生鼠标事件，页面靠主进程的
 * 光标采样（`pet:event:pointer-sample`）判断光标是否进入身体/面板。
 * Electron 的 `forward: true` 只作为支持平台上的补充，不能单独依赖。
 * E2E 在真实桌面上运行，系统光标会混进用例；测试夹具设置
 * `MINGYUE_E2E_ISOLATE_POINTER=1` 关闭采样和转发，Playwright 注入的
 * 指针事件不经过操作系统命中测试，仍然照常送达页面。
 */
function forwardMouse(): boolean {
  return process.env['MINGYUE_E2E_ISOLATE_POINTER'] !== '1'
}

/** 所有显示器工作区的并集（DIP）。桌宠窗口覆盖它，坐标可以为负。 */
export function petWorkAreaUnion(): Rectangle {
  const areas = screen.getAllDisplays().map((display) => display.workArea)
  if (areas.length === 0) return screen.getPrimaryDisplay().workArea
  const left = Math.min(...areas.map((area) => area.x))
  const top = Math.min(...areas.map((area) => area.y))
  const right = Math.max(...areas.map((area) => area.x + area.width))
  const bottom = Math.max(...areas.map((area) => area.y + area.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * 显示器工作区相对桌宠窗口并集的坐标。base 与 boot 都使用它，
 * 保证底边计算与实际窗口坐标一致（支持负坐标/竖向排列）。
 */
export function petDisplayViews(): PetDisplayView[] {
  const union = petWorkAreaUnion()
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((display) => ({
    id: String(display.id),
    x: display.workArea.x - union.x,
    y: display.workArea.y - union.y,
    width: display.workArea.width,
    height: display.workArea.height,
    scaleFactor: display.scaleFactor,
    primary: display.id === primaryId
  }))
}

export interface WindowManagerOptions {
  preloadPath: string
  petUrl: string
  rendererUrl: string | undefined
  isPackaged: boolean
  onPetGone?: (reason: string) => void
  onPetReady?: () => void
  /** 桌宠窗口创建（含崩溃后重建）时通知，用于更新窗口支撑的排除句柄。 */
  onPetWindowCreated?: (win: BrowserWindow) => void
}

export class WindowManager {
  private readonly opts: WindowManagerOptions
  private pet: BrowserWindow | null = null
  private chat: BrowserWindow | null = null
  private settings: BrowserWindow | null = null
  private petVisible = true
  private interactive = false
  private panelOpen = false
  private petReady = false
  private chatReady = false
  private chatSize = { ...CHAT_DEFAULT_SIZE }
  private pendingPetChatOpen: ChatOpenEvent | null = null
  private pendingChatEvents: QueuedChatEvent[] = []
  private pendingChatShow: { activate: boolean; reason: string; flash: boolean } | null = null
  private quitting = false
  private petReloadTimer: NodeJS.Timeout | null = null
  private pointerTimer: NodeJS.Timeout | null = null
  private readonly onDisplaysChanged = (): void => this.syncPetBounds()

  constructor(options: WindowManagerOptions) {
    this.opts = options
  }

  setPetUrl(url: string): void {
    this.opts.petUrl = url
  }

  // ------------------------------------------------------------------ 桌宠

  get petWindow(): BrowserWindow | null {
    return this.pet
  }

  get settingsWindow(): BrowserWindow | null {
    return this.settings
  }

  get petWebContents(): WebContents | null {
    return this.pet?.webContents ?? null
  }

  get chatWindow(): BrowserWindow | null {
    return this.chat
  }

  get chatWebContents(): WebContents | null {
    return this.chat?.webContents ?? null
  }

  get settingsWebContents(): WebContents | null {
    return this.settings?.webContents ?? null
  }

  get isPetVisible(): boolean {
    return this.petVisible
  }

  get isPetReady(): boolean {
    return this.petReady
  }

  /** 设置页/启动流程把配置里的聊天窗尺寸同步过来；对已存在的窗口立即生效。 */
  setChatSize(size: { width: number; height: number }): void {
    const width = Math.max(CHAT_MIN_SIZE.width, Math.round(size.width))
    const height = Math.max(CHAT_MIN_SIZE.height, Math.round(size.height))
    this.chatSize = { width, height }
    const win = this.chat
    if (win === null || win.isDestroyed()) return
    const current = win.getSize()
    if (current[0] !== width || current[1] !== height) win.setSize(width, height)
  }

  createPetWindow(): BrowserWindow {
    if (this.pet !== null && !this.pet.isDestroyed()) return this.pet
    const workArea = petWorkAreaUnion()
    const win = new BrowserWindow({
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      webPreferences: {
        preload: this.opts.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        backgroundThrottling: false,
        spellcheck: false,
        devTools: !this.opts.isPackaged,
        safeDialogs: true,
        navigateOnDragDrop: false
      }
    })
    this.pet = win
    win.setMenu(null)
    try {
      this.opts.onPetWindowCreated?.(win)
    } catch {
      /* 支撑服务失败不能阻止桌宠窗口创建。 */
    }
    win.setAlwaysOnTop(true, 'screen-saver', 1)
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    } catch {
      /* 非 macOS 上部分版本不支持 */
    }
    win.setIgnoreMouseEvents(true, { forward: forwardMouse() })
    win.setFocusable(false)

    this.harden(win)
    win.on('ready-to-show', () => {
      if (this.petVisible) win.showInactive()
    })
    win.on('closed', () => {
      this.stopPointerSampling()
      if (this.pet === win) this.pet = null
    })
    win.webContents.on('did-start-loading', () => {
      this.petReady = false
    })
    win.webContents.on('did-finish-load', () => {
      this.petReady = false
      this.applyMouseMode()
      if (this.petVisible) win.showInactive()
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      if (this.quitting || this.pet !== win) return
      this.opts.onPetGone?.(`桌宠渲染进程退出（${details.reason}）`)
      this.schedulePetReload()
    })
    win.webContents.on('unresponsive', () => {
      if (this.quitting) return
      this.schedulePetReload()
    })
    win.on('resize', () => this.syncPetBounds())
    screen.on('display-added', this.onDisplaysChanged)
    screen.on('display-removed', this.onDisplaysChanged)
    screen.on('display-metrics-changed', this.onDisplaysChanged)
    win.on('show', () => {
      this.petVisible = true
      this.startPointerSampling()
    })
    win.on('hide', () => {
      this.petVisible = false
      this.stopPointerSampling()
    })

    void win.loadURL(this.petUrlWithSlash())
    return win
  }

  reloadPetPage(): void {
    const win = this.pet
    if (win === null || win.isDestroyed()) return
    win.webContents.reload()
  }

  schedulePetReload(): void {
    if (this.quitting || this.petReloadTimer !== null) return
    this.petReloadTimer = setTimeout(() => {
      this.petReloadTimer = null
      if (this.quitting) return
      const win = this.pet
      if (win === null || win.isDestroyed()) {
        this.createPetWindow()
      } else {
        win.webContents.reload()
      }
    }, 1_500)
    this.petReloadTimer.unref?.()
  }

  syncPetBounds(): void {
    const win = this.pet
    if (win === null || win.isDestroyed()) return
    const area = petWorkAreaUnion()
    const current = win.getBounds()
    if (
      current.x !== area.x ||
      current.y !== area.y ||
      current.width !== area.width ||
      current.height !== area.height
    ) {
      win.setBounds(area)
    }
    // 并集没变时 window.resize 不会触发；显示器增删/缩放变化仍要告诉桌宠页，
    // 否则她会继续沿着旧屏幕的底边走。
    if (this.petReady) {
      this.sendToPet(IPC.petDisplays, { displays: petDisplayViews() })
    }
  }

  showPet(): void {
    this.petVisible = true
    const win = this.pet ?? this.createPetWindow()
    if (!win.isDestroyed()) win.showInactive()
  }

  hidePet(): void {
    this.petVisible = false
    const win = this.pet
    if (win !== null && !win.isDestroyed()) win.hide()
  }

  togglePet(): void {
    if (this.petVisible) this.hidePet()
    else this.showPet()
  }

  setInteractive(interactive: boolean): void {
    this.interactive = interactive
    this.applyMouseMode()
  }

  /**
   * 面板开关只调整窗口是否接受键盘焦点；鼠标命中仍由页面探针逐点决定。
   * 绝不能在这里 `setIgnoreMouseEvents(false)`：那会让透明区域吞掉桌面点击。
   */
  setPanelOpen(open: boolean, options: { focus?: boolean } = {}): void {
    this.panelOpen = open
    const win = this.pet
    if (win === null || win.isDestroyed()) return
    if (open) {
      win.setFocusable(true)
      if (options.focus === true) {
        if (!win.isVisible()) win.show()
        win.focus()
      }
    } else {
      if (win.isFocused()) win.blur()
      win.setFocusable(false)
    }
  }

  /** 桌宠页完成启动（IPC pet:notify-ready）后，再补发等待中的打开事件。 */
  markPetReady(): void {
    this.petReady = true
    if (this.pendingPetChatOpen !== null) {
      const pending = this.pendingPetChatOpen
      this.pendingPetChatOpen = null
      this.sendToPet(IPC.chatOpen, pending)
    }
  }

  /** 返回是否真的送给了活跃的桌宠页；动画回执桥用它判断页面可用性。 */
  sendToPet(channel: string, payload?: unknown): boolean {
    const wc = this.pet?.webContents
    if (wc === undefined || wc.isDestroyed()) return false
    if (payload === undefined) wc.send(channel)
    else wc.send(channel, payload)
    return true
  }

  // ------------------------------------------------------------------ 聊天窗

  /**
   * 打开（或隐藏后重新显示）独立聊天窗。`activate` 为 false 时用
   * `showInactive` 显示，审批等场景不会打断用户正在做的事。
   */
  async openChat(options: { activate?: boolean; reason?: string; flash?: boolean } = {}): Promise<void> {
    const win = this.ensureChatWindow()
    if (win === null || win.isDestroyed()) return
    const activate = options.activate === true
    const reason = options.reason ?? (activate ? 'user' : 'assistant')
    const show = (): void => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      if (activate) {
        win.show()
        win.focus()
      } else if (!win.isVisible()) {
        win.showInactive()
      }
      if (options.flash === true) win.flashFrame(true)
    }

    if (this.chatReady) {
      show()
      this.sendToChatWindow(IPC.chatOpen, { reason } satisfies ChatOpenEvent)
    } else {
      // 首次加载时等页面就绪再显示，避免白屏；重载中的窗口保持原状态。
      if (win.isVisible()) show()
      this.pendingChatShow = { activate, reason, flash: options.flash === true }
    }

    // 桌宠页据此收起快捷输入；它不打开任何面板。
    if (this.petReady) this.sendToPet(IPC.chatOpen, { reason } satisfies ChatOpenEvent)
    else this.pendingPetChatOpen = { reason }
  }

  hideChat(): void {
    const win = this.chat
    if (win !== null && !win.isDestroyed()) win.hide()
  }

  /** 聊天事件同时送到独立聊天窗和桌宠页（桌宠页只用 open 收起快捷面板）。 */
  sendToChat(channel: string, payload?: unknown): void {
    this.sendToChatWindow(channel, payload)
    this.sendToPet(channel, payload)
  }

  sendToChatWindow(channel: string, payload?: unknown): void {
    const win = this.chat
    if (win === null || win.isDestroyed()) return
    if (!this.chatReady) {
      if (this.pendingChatEvents.length >= MAX_PENDING_CHAT_EVENTS) this.pendingChatEvents.shift()
      this.pendingChatEvents.push({ channel, payload })
      return
    }
    const wc = win.webContents
    if (wc.isDestroyed()) return
    if (payload === undefined) wc.send(channel)
    else wc.send(channel, payload)
  }

  private ensureChatWindow(): BrowserWindow | null {
    if (this.chat !== null && !this.chat.isDestroyed()) return this.chat
    const win = new BrowserWindow({
      width: this.chatSize.width,
      height: this.chatSize.height,
      minWidth: CHAT_MIN_SIZE.width,
      minHeight: CHAT_MIN_SIZE.height,
      show: false,
      title: '桌宠',
      backgroundColor: '#0f1726',
      autoHideMenuBar: true,
      skipTaskbar: true,
      webPreferences: {
        preload: this.opts.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        spellcheck: false,
        devTools: !this.opts.isPackaged,
        safeDialogs: true,
        navigateOnDragDrop: false
      }
    })
    this.chat = win
    this.chatReady = false
    win.setMenu(null)
    this.harden(win)
    win.on('close', (event) => {
      if (this.quitting) return
      event.preventDefault()
      win.hide()
    })
    win.on('closed', () => {
      if (this.chat === win) {
        this.chat = null
        this.chatReady = false
        this.pendingChatEvents = []
        this.pendingChatShow = null
      }
    })
    win.webContents.on('did-start-loading', () => {
      this.chatReady = false
    })
    win.webContents.on('did-finish-load', () => {
      this.chatReady = true
      const queued = this.pendingChatEvents.splice(0)
      for (const item of queued) {
        if (win.isDestroyed()) return
        if (item.payload === undefined) win.webContents.send(item.channel)
        else win.webContents.send(item.channel, item.payload)
      }
      const pending = this.pendingChatShow
      this.pendingChatShow = null
      if (pending !== null && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        if (pending.activate) {
          win.show()
          win.focus()
        } else if (!win.isVisible()) {
          win.showInactive()
        }
        if (pending.flash) win.flashFrame(true)
        win.webContents.send(IPC.chatOpen, { reason: pending.reason } satisfies ChatOpenEvent)
      }
    })
    this.loadRenderer(win, 'chat')
    return win
  }

  // ------------------------------------------------------------------ 设置

  openSettings(): void {
    const win = this.ensureSettingsWindow()
    if (win === null) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  /** 打开展示诊断区；新窗口会等页面加载完再改 hash。 */
  openDiagnostics(): void {
    const win = this.ensureSettingsWindow()
    if (win === null) return
    const reveal = (): void => {
      if (win.isDestroyed()) return
      void win.webContents
        .executeJavaScript("window.location.hash = '#advanced/diagnostics'", true)
        .catch(() => {
          /* 页面尚未就绪时忽略；下次打开仍可手动进入诊断。 */
        })
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    if (win.webContents.isLoadingMainFrame()) {
      win.webContents.once('did-finish-load', reveal)
    } else {
      reveal()
    }
  }

  sendToSettings(channel: string, payload?: unknown): void {
    const wc = this.settings?.webContents
    if (wc === undefined || wc.isDestroyed()) return
    if (payload === undefined) wc.send(channel)
    else wc.send(channel, payload)
  }

  private ensureSettingsWindow(): BrowserWindow | null {
    if (this.settings !== null && !this.settings.isDestroyed()) return this.settings
    const win = new BrowserWindow({
      width: SETTINGS_SIZE.width,
      height: SETTINGS_SIZE.height,
      minWidth: 720,
      minHeight: 560,
      show: false,
      title: '桌宠 · 设置',
      backgroundColor: '#151517',
      autoHideMenuBar: true,
      skipTaskbar: false,
      webPreferences: {
        preload: this.opts.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        devTools: !this.opts.isPackaged
      }
    })
    this.settings = win
    win.setMenu(null)
    this.harden(win)
    win.on('close', (event) => {
      if (this.quitting) return
      event.preventDefault()
      win.hide()
    })
    win.on('closed', () => {
      if (this.settings === win) this.settings = null
    })
    this.loadRenderer(win, 'settings')
    return win
  }

  // ------------------------------------------------------------------ 生命周期

  destroyAll(): void {
    this.quitting = true
    this.stopPointerSampling()
    if (this.petReloadTimer !== null) {
      clearTimeout(this.petReloadTimer)
      this.petReloadTimer = null
    }
    screen.removeListener('display-added', this.onDisplaysChanged)
    screen.removeListener('display-removed', this.onDisplaysChanged)
    screen.removeListener('display-metrics-changed', this.onDisplaysChanged)
    for (const win of [this.settings, this.chat, this.pet]) {
      if (win !== null && !win.isDestroyed()) win.destroy()
    }
    this.settings = null
    this.chat = null
    this.pet = null
    this.pendingChatEvents = []
    this.pendingChatShow = null
  }

  // ------------------------------------------------------------------ 内部

  /**
   * 点击穿透期间，窗口收不到原生 mouse/pointer 事件（Electron 的 forward
   * 在 Windows 上实测不可靠），因此由主进程轮询系统光标，把窗口内 CSS
   * 坐标发给页面。页面据此翻转可交互状态；一旦可交互，真实输入自然到达。
   */
  private startPointerSampling(): void {
    if (this.pointerTimer !== null || !forwardMouse()) return
    this.pointerTimer = setInterval(() => this.samplePointer(), POINTER_SAMPLE_MS)
    this.pointerTimer.unref?.()
    this.samplePointer()
  }

  private stopPointerSampling(): void {
    if (this.pointerTimer === null) return
    clearInterval(this.pointerTimer)
    this.pointerTimer = null
  }

  private samplePointer(): void {
    const win = this.pet
    if (win === null || win.isDestroyed() || win.webContents.isDestroyed()) return
    if (!win.isVisible()) return
    const cursor = screen.getCursorScreenPoint()
    const bounds = win.getContentBounds()
    const x = cursor.x - bounds.x
    const y = cursor.y - bounds.y
    const inside =
      x >= 0 && y >= 0 && x < bounds.width && y < bounds.height
    win.webContents.send(IPC.petPointerSample, { x, y, inside })
  }

  private applyMouseMode(): void {
    const win = this.pet
    if (win === null || win.isDestroyed()) return
    win.setIgnoreMouseEvents(!this.interactive, { forward: forwardMouse() })
  }

  private petUrlWithSlash(): string {
    const base = this.opts.petUrl === '' ? PET_ORIGIN_FALLBACK : this.opts.petUrl
    return `${base.replace(/\/+$/, '')}/`
  }

  private loadRenderer(win: BrowserWindow, page: 'settings' | 'chat'): void {
    const base = this.opts.rendererUrl
    if (base !== undefined && base !== '') {
      void win.loadURL(`${base.replace(/\/+$/, '')}/${page}/index.html`)
    } else {
      void win.loadFile(join(__dirname, '..', 'renderer', page, 'index.html'))
    }
  }

  private harden(win: BrowserWindow): void {
    const wc = win.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (event) => {
      event.preventDefault()
    })
    wc.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
    wc.on('will-redirect', (event) => {
      event.preventDefault()
    })
  }
}
