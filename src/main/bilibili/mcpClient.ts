import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import type { Logger } from '../../core/types'
import type { BiliReadFailureCode } from '../../shared/bilibili'
import type { BiliCredentials } from './credentials'
import { biliChildEnv } from './childEnv'
import { killProcessTree } from './kill'

/**
 * 只读 B 站 MCP 的 stdio 客户端。
 *
 * - 换行分隔 JSON-RPC 2.0；不依赖 MCP SDK。
 * - 凭据只出现在 initialize 的 `_meta.bilibili_credentials`，不进 argv/env。
 * - 白名单由 `BILI_MCP_TOOLS` 强制下发；返回工具列表必须与白名单完全一致。
 * - 取消时先发 `notifications/cancelled`，短时间无响应就终止整个进程树，
 *   避免 Python 网络请求把取消吞掉。
 * - stderr 只保留净化的短诊断，不转发完整账号响应。
 */

export const BILI_MCP_TOOLS = [
  'bili_recommend',
  'bili_search',
  'bili_video_info',
  'bili_subtitle',
  'bili_frames',
  'bili_cover',
  'bili_account'
] as const

const PROTOCOL_VERSION = '2024-11-05'
const START_TIMEOUT_MS = 25_000
const CANCEL_GRACE_MS = 1500
const MAX_STDERR_LINES = 20
const MAX_IMAGE_BYTES = 2_000_000

export type BiliMcpToolName = (typeof BILI_MCP_TOOLS)[number]

export interface BiliMcpImage {
  mimeType: 'image/jpeg' | 'image/png'
  /** base64，不含 data URL 前缀。 */
  data: string
  width: number
  height: number
}

export interface BiliMcpToolResult {
  payload: Record<string, unknown>
  images: BiliMcpImage[]
}

export interface BiliMcpClientOptions {
  pythonPath: string
  scriptPath: string
  logger: Logger
  /** 子进程崩溃/被杀时的回调；调用方负责状态与重启。 */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void
  spawnImpl?: typeof spawn
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  hardCancel: NodeJS.Timeout | null
}

interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown }
}

export class BiliMcpError extends Error {
  readonly code: BiliReadFailureCode
  readonly retryable: boolean

  constructor(code: BiliReadFailureCode, message: string, retryable = false) {
    super(message)
    this.name = 'BiliMcpError'
    this.code = code
    this.retryable = retryable
  }
}

export class BiliMcpClient {
  private readonly options: BiliMcpClientOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private reader: ReadlineInterface | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private started = false
  private stopping = false
  private exited = false
  private exitPromise: Promise<void> | null = null
  private exitResolve: (() => void) | null = null
  private stderrLines: string[] = []
  private serverVersion: string | null = null

  constructor(options: BiliMcpClientOptions) {
    this.options = options
  }

  get running(): boolean {
    return this.child !== null && !this.exited && this.started
  }

  get version(): string | null {
    return this.serverVersion
  }

  /** 最近一条净化后的 stderr；只用于主进程诊断，不进入模型上下文。 */
  lastDiagnostic(): string | null {
    return this.stderrLines.length === 0 ? null : this.stderrLines[this.stderrLines.length - 1] ?? null
  }

  async start(credentials: BiliCredentials | null): Promise<void> {
    if (this.child !== null) throw new BiliMcpError('internal', 'B 站服务已经在运行。')
    this.stopping = false
    this.exited = false
    this.started = false
    this.stderrLines = []
    this.serverVersion = null
    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve
    })

    let child: ChildProcessWithoutNullStreams
    try {
      const spawnImpl = this.options.spawnImpl ?? spawn
      child = spawnImpl(this.options.pythonPath, [this.options.scriptPath], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: biliChildEnv({
          // 凭据绝不经环境变量；这里只下发显式白名单，并剥掉 shell 里可能
          // 残留的 B 站登录变量。
          BILI_MCP_TOOLS: BILI_MCP_TOOLS.join(','),
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONDONTWRITEBYTECODE: '1'
        })
      }) as ChildProcessWithoutNullStreams
    } catch (error) {
      this.exitResolve = null
      this.exitPromise = null
      throw new BiliMcpError(
        'service-start-failed',
        `无法启动 B 站服务：${error instanceof Error ? error.message.slice(0, 120) : 'spawn failed'}`
      )
    }
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    this.reader = createInterface({ input: child.stdout })
    this.reader.on('line', (line) => this.onLine(line))
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk))
    child.on('error', (error) => {
      this.options.logger.warn('B 站服务进程错误', {
        message: error instanceof Error ? error.message.slice(0, 160) : 'unknown'
      })
    })
    child.on('exit', (code, signal) => {
      this.onExit(code, signal)
    })

    try {
      const init = (await this.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'mingyue-desktop-pet', version: '1.0.0' },
          _meta: {
            bilibili_credentials: credentialMeta(credentials)
          }
        },
        START_TIMEOUT_MS
      )) as {
        protocolVersion?: unknown
        serverInfo?: { name?: unknown; version?: unknown }
      }
      if (
        init === null ||
        typeof init !== 'object' ||
        init.serverInfo?.name !== 'mingyue-bilibili'
      ) {
        throw new BiliMcpError('service-start-failed', 'B 站服务握手失败。')
      }
      this.serverVersion =
        typeof init.serverInfo.version === 'string' ? init.serverInfo.version.slice(0, 40) : null
      this.notify('notifications/initialized', {})
      const listed = (await this.request('tools/list', {}, START_TIMEOUT_MS)) as {
        tools?: Array<{ name?: unknown }>
      }
      const names = Array.isArray(listed?.tools)
        ? listed.tools
            .map((tool) => (typeof tool?.name === 'string' ? tool.name : ''))
            .filter((name) => name !== '')
        : []
      const expected = [...BILI_MCP_TOOLS]
      if (
        names.length !== expected.length ||
        expected.some((name) => !names.includes(name))
      ) {
        throw new BiliMcpError('service-start-failed', 'B 站服务工具白名单不一致。')
      }
      this.started = true
      this.options.logger.info('B 站只读服务已就绪', {
        version: this.serverVersion,
        tools: names.length
      })
    } catch (error) {
      await this.stop()
      throw error instanceof BiliMcpError
        ? error
        : new BiliMcpError('service-start-failed', 'B 站服务启动失败。')
    }
  }

  async call(
    name: BiliMcpToolName,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<BiliMcpToolResult> {
    if (!this.running) throw new BiliMcpError('service-start-failed', 'B 站服务没有运行。')
    if (options.signal?.aborted === true) throw new BiliMcpError('cancelled', '已取消。')
    const timeout = options.timeoutMs ?? 30_000
    let id = 0
    const request = new Promise<unknown>((resolve, reject) => {
      id = this.sendRequest('tools/call', { name, arguments: args }, timeout, resolve, reject)
    })
    const abort = (): void => {
      if (!this.pending.has(id)) return
      this.notify('notifications/cancelled', { requestId: id })
      const pending = this.pending.get(id)
      if (pending !== undefined && pending.hardCancel === null) {
        pending.hardCancel = setTimeout(() => {
          if (!this.pending.has(id)) return
          this.settle(id, new BiliMcpError('cancelled', '已取消。'))
          // 服务没有响应取消：整个进程不再可信，下轮重新启动。
          killProcessTree(this.child?.pid)
        }, CANCEL_GRACE_MS)
        pending.hardCancel.unref?.()
      }
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      const result = await request
      return parseToolResult(result)
    } finally {
      options.signal?.removeEventListener('abort', abort)
    }
  }

  /** 优雅关闭；超时则终止进程树。 */
  async stop(): Promise<void> {
    const child = this.child
    if (child === null) {
      this.cleanup()
      return
    }
    this.stopping = true
    this.started = false
    try {
      child.stdin.end()
    } catch {
      /* ignore */
    }
    const exit = this.exitPromise
    if (exit !== null) {
      await Promise.race([exit, delay(2500)])
    }
    if (!this.exited) {
      killProcessTree(child.pid)
      await Promise.race([this.exitPromise ?? Promise.resolve(), delay(1500)])
    }
    this.cleanup()
  }

  // ------------------------------------------------------------------ 内部

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void
  ): number {
    const child = this.child
    if (child === null || this.exited) {
      reject(new BiliMcpError('service-crashed', 'B 站服务没有运行。'))
      return 0
    }
    const id = this.nextId++
    const timer = setTimeout(() => {
      this.settle(id, new BiliMcpError('timeout', 'B 站服务响应超时。', true))
      // 超时可能意味着 Python 卡在网络调用上；终止服务，避免请求堆积。
      killProcessTree(child.pid)
    }, timeoutMs)
    timer.unref?.()
    this.pending.set(id, { resolve, reject, timer, hardCancel: null })
    if (!this.write({ jsonrpc: '2.0', id, method, params })) {
      this.settle(id, new BiliMcpError('service-crashed', 'B 站服务写入失败。'))
    }
    return id
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.sendRequest(method, params, timeoutMs, resolve, reject)
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(message: Record<string, unknown>): boolean {
    const child = this.child
    if (child === null || this.exited) return false
    try {
      if (child.stdin.destroyed || !child.stdin.writable) return false
      child.stdin.write(`${JSON.stringify(message)}\n`)
      return true
    } catch {
      return false
    }
  }

  private onLine(line: string): void {
    const text = line.trim()
    if (text === '') return
    let message: JsonRpcMessage
    try {
      message = JSON.parse(text) as JsonRpcMessage
    } catch {
      this.pushStderr('服务输出了无法解析的协议行')
      return
    }
    if (message.id === undefined || typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    if (message.error !== undefined) {
      const code = typeof message.error.code === 'number' ? message.error.code : 0
      if (code === -32800) {
        this.settle(message.id, new BiliMcpError('cancelled', '已取消。'))
      } else {
        const detail =
          typeof message.error.message === 'string' ? message.error.message.slice(0, 120) : ''
        this.settle(
          message.id,
          new BiliMcpError('internal', detail === '' ? 'B 站服务返回错误。' : detail)
        )
      }
      return
    }
    this.settle(message.id, message.result)
  }

  private settle(id: number, value: unknown): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.hardCancel !== null) clearTimeout(pending.hardCancel)
    if (value instanceof Error) pending.reject(value)
    else pending.resolve(value)
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const text = sanitizeLine(line)
      if (text === '') continue
      this.stderrLines.push(text)
      if (this.stderrLines.length > MAX_STDERR_LINES) this.stderrLines.shift()
    }
  }

  private pushStderr(text: string): void {
    this.stderrLines.push(sanitizeLine(text))
    if (this.stderrLines.length > MAX_STDERR_LINES) this.stderrLines.shift()
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true
    const expected = this.stopping
    if (!expected) {
      this.options.logger.warn('B 站服务进程退出', { code, signal })
    }
    for (const id of [...this.pending.keys()]) {
      this.settle(id, new BiliMcpError('service-crashed', 'B 站服务意外退出。', true))
    }
    this.exitResolve?.()
    this.exitResolve = null
    try {
      this.options.onExit?.({ code, signal, expected })
    } catch {
      /* 状态回调不能影响进程清理 */
    }
  }

  private cleanup(): void {
    this.reader?.close()
    this.reader = null
    this.child = null
    this.started = false
    this.exited = true
    for (const id of [...this.pending.keys()]) {
      this.settle(id, new BiliMcpError('stopped', 'B 站服务已停止。'))
    }
  }
}

function credentialMeta(credentials: BiliCredentials | null): Record<string, string> {
  if (credentials === null) return {}
  const out: Record<string, string> = {}
  if (credentials.sessdata !== '') out.sessdata = credentials.sessdata
  if (credentials.biliJct !== '') out.bili_jct = credentials.biliJct
  if (credentials.buvid3 !== '') out.buvid3 = credentials.buvid3
  if (credentials.dedeuserid !== '') out.dedeuserid = credentials.dedeuserid
  return out
}

function sanitizeLine(line: string): string {
  return line
    .replace(/(SESSDATA|bili_jct|buvid3|dedeuserid)=([^&\s;]+)/gi, '$1=<redacted>')
    .replace(/\?[^\s)]{8,}/g, '?<query>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function parseToolResult(result: unknown): BiliMcpToolResult {
  if (result === null || typeof result !== 'object') {
    throw new BiliMcpError('parse-failed', 'B 站服务返回结构不正确。')
  }
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) {
    throw new BiliMcpError('parse-failed', 'B 站服务返回内容为空。')
  }
  let payload: Record<string, unknown> | null = null
  const images: BiliMcpImage[] = []
  for (const item of content) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (entry.type === 'text' && typeof entry.text === 'string' && payload === null) {
      try {
        const parsed = JSON.parse(entry.text) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>
        }
      } catch {
        throw new BiliMcpError('parse-failed', 'B 站服务返回了无法解析的文本。')
      }
    } else if (entry.type === 'image') {
      const image = parseImage(entry)
      if (image !== null) images.push(image)
    }
  }
  if (payload === null) {
    throw new BiliMcpError('parse-failed', 'B 站服务没有返回结构化结果。')
  }
  if (payload.ok === false) {
    const code = typeof payload.code === 'string' ? payload.code : 'internal'
    const message = typeof payload.message === 'string' ? payload.message.slice(0, 200) : 'B 站读取失败。'
    const retryable = payload.retryable === true
    throw new BiliMcpError(asFailureCode(code), message, retryable)
  }
  return { payload, images }
}

function parseImage(entry: Record<string, unknown>): BiliMcpImage | null {
  const mimeType = entry.mimeType
  const data = entry.data
  const width = entry.width
  const height = entry.height
  if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') return null
  if (typeof data !== 'string' || data.length === 0) return null
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null
  if ((width as number) < 1 || (height as number) < 1) return null
  if (data.length > MAX_IMAGE_BYTES * 1.4) return null
  return {
    mimeType,
    data,
    width: width as number,
    height: height as number
  }
}

function asFailureCode(code: string): BiliReadFailureCode {
  const allowed: readonly BiliReadFailureCode[] = [
    'disabled',
    'no-consent',
    'exploration-off',
    'python-missing',
    'service-not-installed',
    'service-start-failed',
    'service-crashed',
    'service-timeout',
    'login-required',
    'login-expired',
    'qrcode-expired',
    'login-cancelled',
    'risk-control',
    'captcha',
    'not-found',
    'no-candidates',
    'video-unavailable',
    'no-subtitle',
    'parse-failed',
    'network',
    'timeout',
    'cancelled',
    'budget',
    'no-session',
    'stopped',
    'cooldown',
    'vision-unavailable',
    'asr-not-installed',
    'asr-model-missing',
    'asr-limit',
    'asr-failed',
    'asr-empty',
    'evidence-insufficient',
    'report-failed',
    'internal'
  ]
  return allowed.includes(code as BiliReadFailureCode)
    ? (code as BiliReadFailureCode)
    : 'internal'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
