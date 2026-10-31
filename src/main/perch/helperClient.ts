import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { PerchRawWindow } from './geometry'

/**
 * 常驻窗口几何助手客户端。
 *
 * 与 `WindowHelperClient` 的一次性调用不同，这里只启动一个 PowerShell 进程，
 * 通过 stdin/stdout 持续交换按行 JSON：stdout 只有矩形、Z 序、前台标记与
 * 加盐 id。没有窗口标题/文本/截图，也没有进程名输出。
 *
 * 助手退出（或启动失败）后按指数退避重启，直到 `stop()`；重启窗口的短暂
 * 空档由 `onStatus` 报告，渲染端会退回屏幕底部而不是冻结在半空。
 */
export interface PerchHelperSnapshot {
  at: number
  windows: PerchRawWindow[]
}

export interface PerchHelperOptions {
  scriptPath: string
  salt: string
  powershellPath?: string
  onSnapshot: (snapshot: PerchHelperSnapshot) => void
  onStatus?: (reason: string | null) => void
}

const MAX_LINE_LENGTH = 256 * 1024
const MAX_WINDOWS = 128
const RESTART_MIN_MS = 400
const RESTART_MAX_MS = 8_000
const STOP_GRACE_MS = 1_500

export class PerchHelperClient {
  private readonly scriptPath: string
  private readonly salt: string
  private readonly powershellPath: string
  private readonly onSnapshot: (snapshot: PerchHelperSnapshot) => void
  private readonly onStatus: (reason: string | null) => void

  private child: ChildProcessWithoutNullStreams | null = null
  private started = false
  private buffer = ''
  private restartTimer: NodeJS.Timeout | null = null
  private restartDelay = RESTART_MIN_MS
  private stderrTail = ''
  private excludes: string[] = []
  private rateMs = 0
  private status: string | null = null

  constructor(options: PerchHelperOptions) {
    this.scriptPath = options.scriptPath
    this.salt = options.salt
    this.powershellPath = options.powershellPath ?? 'powershell.exe'
    this.onSnapshot = options.onSnapshot
    this.onStatus = options.onStatus ?? (() => {})
  }

  start(): void {
    if (this.started) return
    this.started = true
    if (process.platform !== 'win32') {
      this.setStatus('当前系统不是 Windows，窗口支撑不可用')
      return
    }
    this.spawnChild()
  }

  stop(): void {
    this.started = false
    this.clearRestart()
    const child = this.child
    this.child = null
    if (child === null) return
    this.send('quit')
    try {
      child.stdin.end()
    } catch {
      /* 进程可能已退出。 */
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }, STOP_GRACE_MS)
    timer.unref?.()
  }

  getStatus(): string | null {
    return this.status
  }

  isRunning(): boolean {
    return this.child !== null
  }

  /** 更新需要从支撑面/遮挡计算中排除的窗口句柄（十六进制字符串）。 */
  updateExcludes(handles: readonly string[]): void {
    const normalized: string[] = []
    for (const raw of handles) {
      const hex = raw.trim().replace(/^0x/i, '').toLowerCase()
      if (!/^[0-9a-f]{1,16}$/.test(hex)) continue
      if (!normalized.includes(hex)) normalized.push(hex)
    }
    normalized.sort()
    const key = normalized.join(',')
    if (key === this.excludes.join(',')) return
    this.excludes = normalized
    this.send(`exclude ${key}`)
  }

  setRate(intervalMs: number): void {
    const value = Math.max(200, Math.min(5_000, Math.round(intervalMs)))
    if (value === this.rateMs) return
    this.rateMs = value
    this.send(`rate ${value}`)
  }

  /** 请求立即重采一次（例如拖拽开始、宠物窗口刚创建时）。 */
  refresh(): void {
    this.send('refresh')
  }

  private spawnChild(): void {
    if (!this.started) return
    this.clearRestart()
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.scriptPath,
      '-Salt',
      this.salt
    ]
    if (this.excludes.length > 0) args.push('-ExcludeHandles', this.excludes.join(','))

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.powershellPath, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      this.fail(`无法启动窗口几何助手：${String(error)}`)
      this.scheduleRestart()
      return
    }

    this.child = child
    this.buffer = ''
    this.stderrTail = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child === child) this.consume(chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // 只保留尾部用于诊断；这里的内容是脚本报错，不含窗口数据。
      this.stderrTail = (this.stderrTail + chunk).slice(-2_000)
    })
    child.stdin.on('error', () => {
      /* 进程退出时的 EPIPE 由 close 统一处理。 */
    })
    child.on('error', (error) => {
      if (this.child !== child) return
      this.child = null
      this.fail(`窗口几何助手错误：${error.message}`)
      this.scheduleRestart()
    })
    child.on('close', (code) => {
      if (this.child !== child) return
      this.child = null
      const tail = this.stderrTail.trim()
      this.fail(
        code === 0
          ? '窗口几何助手已退出'
          : `窗口几何助手已退出（code=${String(code)}${tail === '' ? '' : `：${tail.slice(-160)}`}）`
      )
      this.scheduleRestart()
    })

    if (this.rateMs > 0) this.send(`rate ${this.rateMs}`)
  }

  private scheduleRestart(): void {
    if (!this.started || this.restartTimer !== null) return
    const delay = this.restartDelay
    this.restartDelay = Math.min(RESTART_MAX_MS, this.restartDelay * 2)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spawnChild()
    }, delay)
    this.restartTimer.unref?.()
  }

  private clearRestart(): void {
    if (this.restartTimer === null) return
    clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line !== '') this.handleLine(line)
      newline = this.buffer.indexOf('\n')
    }
    // 单行异常长时丢弃，避免内存随输出无限增长。
    if (this.buffer.length > MAX_LINE_LENGTH) this.buffer = ''
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    const snapshot = parsePerchSnapshot(parsed)
    if (snapshot === null) return
    if (this.status !== null) this.setStatus(null)
    this.restartDelay = RESTART_MIN_MS
    this.onSnapshot(snapshot)
  }

  private send(command: string): void {
    const child = this.child
    if (child === null || !child.stdin.writable) return
    try {
      child.stdin.write(`${command}\n`)
    } catch {
      /* 助手退出后由 close 重启。 */
    }
  }

  private fail(reason: string): void {
    this.setStatus(reason)
  }

  private setStatus(reason: string | null): void {
    if (this.status === reason) return
    this.status = reason
    this.onStatus(reason)
  }
}

/** 校验助手输出；任何字段异常都丢弃该窗口，而不是让整份几何失效。 */
export function parsePerchSnapshot(raw: unknown): PerchHelperSnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (record['ok'] !== true) return null
  if (!Array.isArray(record['windows'])) return null
  const at = typeof record['at'] === 'number' && Number.isFinite(record['at']) ? record['at'] : 0
  const windows: PerchRawWindow[] = []
  for (const item of record['windows'].slice(0, MAX_WINDOWS)) {
    const window = parseWindow(item)
    if (window !== null) windows.push(window)
  }
  return { at, windows }
}

function parseWindow(raw: unknown): PerchRawWindow | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const x = record['x']
  const y = record['y']
  const width = record['width']
  const height = record['height']
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 20_000 ||
    height > 20_000
  ) {
    return null
  }
  return {
    id: typeof record['id'] === 'string' ? record['id'] : '',
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    support: record['support'] === true,
    foreground: record['foreground'] === true
  }
}
