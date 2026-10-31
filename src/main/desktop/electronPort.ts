import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { screen } from 'electron'
import {
  DesktopPortError,
  type DesktopCapture,
  type DesktopElementAction,
  type DesktopElementResult,
  type DesktopElementSnapshot,
  type DesktopHealth,
  type DesktopPort,
  type DesktopRect,
  type DesktopWindowRef,
  type DesktopWindowText
} from '../../worlds/desktop/types'
import { WindowHelperClient, type HelperCapture, type HelperWindowRef } from './windowClient'

export interface ElectronDesktopPortOptions {
  scriptPath: string
  selfProcessNames?: readonly string[]
  powershellPath?: string
  timeoutMs?: number
  /** 测试注入；默认每次应用启动随机生成，不落日志。 */
  salt?: string
}

/**
 * 真实桌面观察端口。每次调用都带当前 allowlist 与本次启动的 salt；
 * 设置页候选列表也过滤自身与敏感进程。窗口标题不会出现在日志里。
 */
export class ElectronDesktopPort implements DesktopPort {
  private readonly client: WindowHelperClient
  private readonly salt: string
  private readonly selfKeys: Set<string>
  private lastError: string | null = null
  private lastErrorAt = 0
  private lastSuccessAt = 0

  constructor(opts: ElectronDesktopPortOptions) {
    this.client = new WindowHelperClient({
      scriptPath: opts.scriptPath,
      ...(opts.powershellPath === undefined ? {} : { powershellPath: opts.powershellPath }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs })
    })
    this.salt = opts.salt ?? randomBytes(16).toString('hex')
    this.selfKeys = new Set(
      (opts.selfProcessNames ?? []).map((name) => normalizeKey(name)).filter((name) => name !== '')
    )
    this.selfKeys.add('electron')
    this.selfKeys.add('mingyue-desktop-pet')
  }

  async listWindows(allowedProcesses: readonly string[]): Promise<DesktopWindowRef[]> {
    const windows = await this.call(() => this.client.listWindows(allowedProcesses, this.salt))
    return windows.map((window) => this.toDipWindow(window))
  }

  async readWindow(
    id: string,
    allowedProcesses: readonly string[],
    maxChars: number,
    signal?: AbortSignal
  ): Promise<DesktopWindowText> {
    return this.call(() =>
      this.client.readWindow(id, allowedProcesses, this.salt, maxChars, signal)
    )
  }

  async captureWindow(
    id: string,
    allowedProcesses: readonly string[],
    signal?: AbortSignal
  ): Promise<DesktopCapture> {
    const capture = await this.call(() =>
      this.client.captureWindow(id, allowedProcesses, this.salt, signal)
    )
    return this.toDipCapture(capture)
  }

  async focusWindow(id: string, allowedProcesses: readonly string[]): Promise<boolean> {
    return this.call(() => this.client.focusWindow(id, allowedProcesses, this.salt))
  }

  async listElements(
    id: string,
    allowedProcesses: readonly string[],
    maxElements: number,
    signal?: AbortSignal
  ): Promise<DesktopElementSnapshot> {
    const snapshot = await this.call(() =>
      this.client.listElements(id, allowedProcesses, this.salt, maxElements, signal)
    )
    return {
      elements: snapshot.elements.map((element) =>
        element.bounds === undefined
          ? element
          : { ...element, ...this.toDipRect(element.bounds) }
      ),
      truncated: snapshot.truncated,
      sensitive: snapshot.sensitive
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
    return this.call(() =>
      this.client.actElement(
        id,
        allowedProcesses,
        this.salt,
        elementId,
        action,
        value,
        signal
      )
    )
  }

  async listApps(): Promise<string[]> {
    const apps = await this.call(() => this.client.listApps())
    return apps.filter((app) => {
      const key = normalizeKey(app)
      return key !== '' && !this.selfKeys.has(key)
    })
  }

  health(): DesktopHealth {
    if (process.platform !== 'win32') {
      return { state: 'unavailable', reason: '当前系统不是 Windows，窗口观察不可用' }
    }
    if (this.lastError !== null && this.lastErrorAt > this.lastSuccessAt) {
      return { state: 'degraded', reason: this.lastError }
    }
    return { state: 'ok', reason: null }
  }

  private toDipWindow(window: HelperWindowRef): DesktopWindowRef {
    const base: DesktopWindowRef = {
      id: window.id,
      process: window.process,
      title: window.title,
      foreground: window.foreground
    }
    if (window.bounds === null) return base
    return { ...base, ...this.toDipRect(window.bounds) }
  }

  private toDipCapture(capture: HelperCapture): DesktopCapture {
    return {
      base64: capture.base64,
      mimeType: capture.mimeType,
      width: capture.width,
      height: capture.height,
      ...this.toDipRect(capture.bounds)
    }
  }

  /** helper 返回物理像素；Electron 的 DIP 换算负责混合 DPI 与负坐标显示器。 */
  private toDipRect(rect: DesktopRect): { bounds: DesktopRect; scaleFactor: number } {
    const center = {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2)
    }
    const display = screen.getDisplayNearestPoint(center)
    const dipped = screen.screenToDipRect(null, rect)
    return {
      bounds: {
        x: dipped.x,
        y: dipped.y,
        width: dipped.width,
        height: dipped.height
      },
      scaleFactor: display.scaleFactor
    }
  }

  /** helper 自身错误才影响健康；单窗口 UIA/截图失败由 World 作为降级回执处理。 */
  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      const result = await run()
      this.lastSuccessAt = Date.now()
      return result
    } catch (error) {
      if (error instanceof DesktopPortError && isHelperLevel(error.code)) {
        this.lastError = `窗口辅助组件：${error.message}`
        this.lastErrorAt = Date.now()
      }
      throw error
    }
  }
}

function isHelperLevel(code: string): boolean {
  return code === 'helper-exit' || code === 'helper-timeout' || code === 'helper-bad-output' || code === 'not-windows'
}

function normalizeKey(raw: string): string {
  return basename(raw.trim())
    .toLowerCase()
    .replace(/\.exe$/, '')
}

export function defaultSelfProcessNames(execPath: string, appName: string): string[] {
  return [basename(execPath), `${appName}.exe`, 'electron.exe']
}
