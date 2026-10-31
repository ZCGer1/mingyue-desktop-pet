import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import type { Logger } from '../../core/types'
import { normalizeProcessName } from './appIdentity'

/** 前台窗口矩形，单位为屏幕物理像素；只用于选择观察显示器，不进入模型。 */
export interface ForegroundWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 一次前台样本。title 是原始标题，只在 ActivityWorld 内存里脱敏；不得写日志。 */
export interface ForegroundSample {
  processName: string
  title: string | null
  bounds?: ForegroundWindowBounds | null
  minimized?: boolean
  /**
   * 本机窗口句柄的不透明字符串（来自辅助脚本的 HWND）。
   *
   * 只用于区分同一应用的两个窗口并让旧观察失效；ActivityWorld 会再哈希，
   * 原始句柄不进入事件、日志、模型上下文或持久化。
   */
  windowId?: string | null
}

export type ForegroundSampleHandler = (sample: ForegroundSample | null) => void

/** 只读前台进程名与窗口标题；不读 URL、路径、剪贴板或输入。 */
export interface ForegroundProvider {
  start(onSample: ForegroundSampleHandler, onError: (error: Error) => void): void | Promise<void>
  stop(): void | Promise<void>
  /** 采样间隔热更新；支持时无需重启应用。 */
  updateInterval?(intervalMs: number): void
}

/** 由 Electron main 注入的空闲/锁屏/睡眠信号（Activity World 不 import Electron）。 */
export interface SystemActivityProvider {
  getIdleSeconds(): number | Promise<number>
  onLock(listener: () => void): () => void
  onUnlock(listener: () => void): () => void
  onSuspend(listener: () => void): () => void
  onResume(listener: () => void): () => void
}

export interface PowerShellForegroundOptions {
  scriptPath: string
  logger: Logger
  intervalMs?: number
  powershellPath?: string
  onDegraded?: (reason: string) => void
}

/**
 * 常驻 PowerShell 辅助进程（PLAN.md §4.4）。采样失败按 1s/5s/30s 退避重启；
 * 连续失败 5 次降级，只保留 powerMonitor 信号。
 */
export class PowerShellForegroundProvider implements ForegroundProvider {
  private readonly scriptPath: string
  private readonly logger: Logger
  private intervalMs: number
  private readonly powershellPath: string
  private readonly onDegraded?: (reason: string) => void

  private child: ChildProcessByStdio<null, Readable, Readable> | null = null
  private onSample: ForegroundSampleHandler | null = null
  private onError: ((error: Error) => void) | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private stopped = true
  private failures = 0
  private lastSampleAt = 0
  private degraded = false
  /** 主动重启（采样间隔变化）时忽略这个旧进程的 exit 回调。 */
  private expectedExitChild: ChildProcessByStdio<null, Readable, Readable> | null = null

  constructor(opts: PowerShellForegroundOptions) {
    this.scriptPath = opts.scriptPath
    this.logger = opts.logger
    this.intervalMs = Math.max(500, opts.intervalMs ?? 2000)
    this.powershellPath = opts.powershellPath ?? 'powershell.exe'
    this.onDegraded = opts.onDegraded
  }

  start(onSample: ForegroundSampleHandler, onError: (error: Error) => void): void {
    this.onSample = onSample
    this.onError = onError
    this.stopped = false
    this.failures = 0
    this.degraded = false
    this.spawnHelper()
    this.watchdog = setInterval(() => this.checkWatchdog(), 10_000)
    this.watchdog.unref?.()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.killChild()
    this.onSample = null
    this.onError = null
  }

  /** 采样间隔变化时重启辅助进程；失败计数不变。 */
  updateInterval(intervalMs: number): void {
    const next = Math.max(500, Math.min(60_000, Math.round(intervalMs)))
    if (next === this.intervalMs) return
    this.intervalMs = next
    if (this.stopped || this.degraded) return
    this.expectedExitChild = this.child
    this.killChild()
    this.lastSampleAt = Date.now()
    this.spawnHelper()
  }

  private spawnHelper(): void {
    if (this.stopped || this.degraded) return
    if (process.platform !== 'win32') {
      this.degrade('当前系统不是 Windows')
      return
    }
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn(
        this.powershellPath,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.scriptPath,
          '-IntervalMs',
          String(this.intervalMs)
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (error) {
      this.handleExit(`无法启动辅助进程：${String(error)}`)
      return
    }
    this.child = child
    this.lastSampleAt = Date.now()

    const stdout = createInterface({ input: child.stdout })
    stdout.on('line', (line) => this.handleLine(line))

    const stderr = createInterface({ input: child.stderr })
    stderr.on('line', (line) => {
      if (line.trim() !== '') this.logger.warn('活动辅助进程 stderr', { line: line.slice(0, 300) })
    })

    child.on('error', (error) => {
      this.logger.warn('活动辅助进程错误', { error: error.message })
      this.handleExit(error.message)
    })
    child.on('exit', (code, signal) => {
      this.handleExit(`辅助进程退出 code=${String(code)} signal=${String(signal)}`, child)
    })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    let parsed: {
      processName?: unknown
      title?: unknown
      bounds?: unknown
      minimized?: unknown
      windowId?: unknown
    }
    try {
      parsed = JSON.parse(trimmed) as {
        processName?: unknown
        title?: unknown
        bounds?: unknown
        minimized?: unknown
        windowId?: unknown
      }
    } catch {
      return
    }
    const name = sanitiseProcessName(typeof parsed.processName === 'string' ? parsed.processName : null)
    // 原始标题最多保留 300 字符，只传给 ActivityWorld 做本地脱敏；这里不记录。
    const rawTitle = typeof parsed.title === 'string' ? parsed.title.trim() : ''
    const title = rawTitle === '' ? null : rawTitle.slice(0, 300)
    const bounds = parseBounds(parsed.bounds)
    const windowId = parseWindowId(parsed.windowId)
    this.lastSampleAt = Date.now()
    this.failures = 0
    this.onSample?.(
      name === null
        ? null
        : {
            processName: name,
            title,
            ...(bounds === null ? {} : { bounds }),
            ...(parsed.minimized === true ? { minimized: true } : {}),
            ...(windowId === null ? {} : { windowId })
          }
    )
  }

  private handleExit(reason: string, source?: ChildProcessByStdio<null, Readable, Readable>): void {
    if (
      source !== undefined &&
      this.expectedExitChild !== null &&
      source === this.expectedExitChild
    ) {
      this.expectedExitChild = null
      return
    }
    // 旧进程的延迟 exit 不应杀掉刚重启的新进程。
    if (source !== undefined && this.child !== null && source !== this.child) return
    this.killChild()
    if (this.stopped) return
    this.failures += 1
    try {
      this.onError?.(new Error(reason))
    } catch {
      /* ignore */
    }
    if (this.failures >= 5) {
      this.degrade(`连续 ${this.failures} 次采样失败`)
      return
    }
    const delay = [1000, 5000, 30_000][Math.min(this.failures - 1, 2)] ?? 30_000
    this.logger.warn('活动辅助进程将重启', { attempt: this.failures, delay })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spawnHelper()
    }, delay)
    this.restartTimer.unref?.()
  }

  private checkWatchdog(): void {
    if (this.stopped || this.degraded) return
    if (this.lastSampleAt !== 0 && Date.now() - this.lastSampleAt > 15_000) {
      this.logger.warn('活动采样超时，重启辅助进程')
      this.handleExit('采样超时')
    }
  }

  private degrade(reason: string): void {
    if (this.degraded) return
    this.degraded = true
    this.logger.warn('行为感知已降级', { reason })
    try {
      this.onDegraded?.(reason)
    } catch {
      /* ignore */
    }
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    if (child === null) return
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }

  private clearTimers(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.watchdog !== null) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
  }
}

/** 校验 helper 输出的窗口矩形；任何异常值都当作“没有几何信息”。 */
function parseBounds(raw: unknown): ForegroundWindowBounds | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const x = typeof record['x'] === 'number' ? record['x'] : NaN
  const y = typeof record['y'] === 'number' ? record['y'] : NaN
  const width = typeof record['width'] === 'number' ? record['width'] : NaN
  const height = typeof record['height'] === 'number' ? record['height'] : NaN
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null
  if (width <= 0 || height <= 0 || width > 100_000 || height > 100_000) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  }
}

/** HWND 只接受十进制句柄文本；0/空值视为没有窗口身份，不回退猜测。 */
function parseWindowId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!/^-?\d{1,20}$/.test(text)) return null
  return /^-?0+$/.test(text) ? null : text
}

/**
 * 只保留进程名本体：去路径、.exe、控制字符；支持中文等 Unicode 名称。
 * 具体规则与 appIdentity 共用，避免采样层与脱敏层不一致。
 */
export function sanitiseProcessName(raw: string | null): string | null {
  return normalizeProcessName(raw)
}
