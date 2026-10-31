import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Logger } from '../../core/types'
import type { CuaForeground, CuaTakeoverKind } from '../../worlds/cua/port'

/**
 * 常驻 PowerShell 输入助手的 Node 客户端。
 *
 * 协议是 JSON Lines：
 *   请求 `{ id, op, ... }`
 *   响应 `{ id, ok, ... }` / `{ id, ok:false, error }`
 *   事件 `{ event:'takeover', kind:'mouse'|'keyboard'|'input' }`
 *
 * 这里绝不记录请求正文（坐标、输入文字）、截图或窗口标题；日志只有 op、耗时和
 * 截断后的错误。输入失败不自动重发——重复点击比失败更危险。
 */

export interface CuaInputClientOptions {
  scriptPath: string
  logger: Logger
  /** 默认 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`。 */
  executablePath?: string
  requestTimeoutMs?: number
  startupTimeoutMs?: number
  spawnImpl?: typeof spawn
  now?: () => number
}

interface PendingRequest {
  op: string
  resolve: (value: HelperResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface HelperResponse {
  id?: number
  ok?: boolean
  error?: string
  event?: string
  kind?: string
  hooks?: boolean
  processName?: string
  titleSensitive?: boolean
  pid?: number
}

const MAX_RESTART_STREAK = 2
const RESTART_COOLDOWN_MS = 30_000
const STDERR_LIMIT = 800

export class CuaInputClient {
  private readonly options: CuaInputClientOptions
  private readonly logger: Logger
  private readonly requestTimeoutMs: number
  private readonly startupTimeoutMs: number
  private readonly spawnImpl: typeof spawn
  private readonly now: () => number
  private readonly listeners = new Set<(kind: CuaTakeoverKind) => void>()

  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private startPromise: Promise<void> | null = null
  private stopping = false
  private exited = false
  private failureStreak = 0
  private disabledUntil = 0
  private lastHealthy = true

  constructor(options: CuaInputClientOptions) {
    this.options = options
    this.logger = options.logger
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000
    this.startupTimeoutMs = options.startupTimeoutMs ?? 8_000
    this.spawnImpl = options.spawnImpl ?? spawn
    this.now = options.now ?? Date.now
  }

  health(): { healthy: boolean } {
    return { healthy: this.lastHealthy && this.failureStreak < MAX_RESTART_STREAK }
  }

  onTakeover(listener: (kind: CuaTakeoverKind) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async inspect(): Promise<CuaForeground> {
    await this.ensureStarted()
    const response = await this.request('inspect')
    const processName = typeof response.processName === 'string' ? response.processName : ''
    if (processName.trim() === '') {
      throw new Error('无法识别当前前台应用')
    }
    return {
      processName,
      titleSensitive: response.titleSensitive === true,
      ...(typeof response.pid === 'number' ? { pid: response.pid } : {})
    }
  }

  async click(x: number, y: number, button: 'left' | 'right' | 'middle', count: 1 | 2): Promise<void> {
    await this.ensureStarted()
    await this.request('click', { x, y, button, count })
  }

  async scroll(x: number, y: number, deltaY: number, deltaX: number): Promise<void> {
    await this.ensureStarted()
    await this.request('scroll', { x, y, deltaY, deltaX })
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    await this.ensureStarted()
    await this.request('drag', { fromX, fromY, toX, toY })
  }

  async type(text: string): Promise<void> {
    await this.ensureStarted()
    await this.request('type', { text })
  }

  async key(combo: string): Promise<void> {
    await this.ensureStarted()
    await this.request('key', { combo })
  }

  async releaseAll(): Promise<void> {
    if (this.child === null || this.exited) return
    try {
      await this.request('release_all', {}, 2_000)
    } catch (error) {
      this.logger.warn('CUA 释放输入失败', { error: safeMessage(error) })
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    this.stopping = true
    if (child !== null && !this.exited) {
      try {
        await this.request('shutdown', {}, 1_000)
      } catch {
        /* 强杀兜底 */
      }
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    this.child = null
    this.startPromise = null
    this.failureStreak = 0
    this.disabledUntil = 0
    this.lastHealthy = true
    this.exited = false
    this.stopping = false
    this.clearPending(new Error('电脑操作已停止'))
  }

  // ------------------------------------------------------------------ 进程

  private async ensureStarted(): Promise<void> {
    if (this.exited || this.child === null) {
      if (this.now() < this.disabledUntil) {
        throw new Error('输入助手连续启动失败，已暂停；请稍后重试或重启应用')
      }
      if (this.failureStreak >= MAX_RESTART_STREAK) {
        this.disabledUntil = this.now() + RESTART_COOLDOWN_MS
        this.failureStreak = 0
        throw new Error('输入助手连续启动失败，已暂停 30 秒')
      }
    }
    if (this.startPromise === null) {
      this.startPromise = this.startHelper()
    }
    await this.startPromise
  }

  private async startHelper(): Promise<void> {
    const executable = this.options.executablePath ?? powershellPath()
    const child = this.spawnImpl(
      executable,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.options.scriptPath],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    ) as ChildProcessWithoutNullStreams

    this.child = child
    this.exited = false
    this.stdoutBuffer = ''
    this.stderrBuffer = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-STDERR_LIMIT)
    })
    child.on('error', (error) => {
      this.onExit(`spawn error: ${error.message}`)
    })
    child.on('exit', (code, signal) => {
      this.onExit(`exit code=${String(code)} signal=${String(signal)}`)
    })
    child.stdin.on('error', (error) => {
      this.onExit(`stdin error: ${error.message}`)
    })

    try {
      const response = await this.request('ping', {}, this.startupTimeoutMs)
      if (response.ok !== true) throw new Error('输入助手未就绪')
      this.failureStreak = 0
      this.lastHealthy = true
      this.logger.info('CUA 输入助手已启动', {
        hooks: response.hooks === true
      })
    } catch (error) {
      this.failureStreak += 1
      this.lastHealthy = false
      this.logger.warn('CUA 输入助手启动失败', {
        error: safeMessage(error),
        streak: this.failureStreak,
        stderr: this.stderrBuffer.trim() === '' ? undefined : this.stderrBuffer.trim().slice(0, 300)
      })
      this.killChild()
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  private onExit(reason: string): void {
    // stop()/killChild() 已经把 child 置空；迟到的 exit 事件不再重复处理。
    if (this.child === null) return
    const wasIntentional = this.stopping
    this.exited = true
    this.child = null
    this.startPromise = null
    this.clearPending(new Error('输入助手已退出，操作结果未知；请先重新截图确认'))
    if (!wasIntentional) {
      this.failureStreak += 1
      this.lastHealthy = false
      this.logger.warn('CUA 输入助手退出', {
        reason: reason.slice(0, 160),
        streak: this.failureStreak
      })
    }
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    this.startPromise = null
    this.exited = true
    if (child !== null) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    this.clearPending(new Error('输入助手已停止，操作结果未知；请先重新截图确认'))
  }

  // ------------------------------------------------------------------ 协议

  private request(
    op: string,
    payload: Record<string, unknown> = {},
    timeoutMs = this.requestTimeoutMs
  ): Promise<HelperResponse> {
    return new Promise<HelperResponse>((resolve, reject) => {
      if (this.child === null || this.exited) {
        // 只有确认助手已在运行时才允许发送；启动流程由 ensureStarted 负责。
        reject(new Error('输入助手未运行'))
        return
      }
      const child = this.child
      const id = this.nextId
      this.nextId += 1
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.lastHealthy = false
        // 超时后助手状态未知，直接杀掉，下一次调用重新懒启动。
        this.killChild()
        reject(new Error(`输入助手执行 ${op} 超时；界面状态未知，请先重新截图确认`))
      }, Math.max(500, timeoutMs))
      this.pending.set(id, { op, resolve, reject, timer })
      try {
        child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let index = this.stdoutBuffer.indexOf('\n')
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (line !== '') this.handleLine(line)
      index = this.stdoutBuffer.indexOf('\n')
    }
    // 防御异常 helper：绝不无限累积。
    if (this.stdoutBuffer.length > 256_000) this.stdoutBuffer = this.stdoutBuffer.slice(-64_000)
  }

  private handleLine(line: string): void {
    let parsed: HelperResponse
    try {
      parsed = JSON.parse(line) as HelperResponse
    } catch {
      return
    }
    if (parsed.event === 'takeover') {
      const kind: CuaTakeoverKind =
        parsed.kind === 'mouse' ? 'mouse' : parsed.kind === 'keyboard' ? 'keyboard' : 'input'
      for (const listener of this.listeners) {
        try {
          listener(kind)
        } catch (error) {
          this.logger.warn('CUA takeover 监听器异常', { error: safeMessage(error) })
        }
      }
      return
    }
    if (typeof parsed.id !== 'number') return
    const pending = this.pending.get(parsed.id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pending.delete(parsed.id)
    if (parsed.ok === true) {
      this.lastHealthy = true
      pending.resolve(parsed)
    } else {
      const message =
        typeof parsed.error === 'string' && parsed.error.trim() !== ''
          ? parsed.error.trim().slice(0, 300)
          : '输入助手返回失败'
      pending.reject(new Error(message))
    }
  }

  private clearPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function powershellPath(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}
