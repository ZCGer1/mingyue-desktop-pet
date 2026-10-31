import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { AppConfig } from '../shared/config'
import { effectiveExploration } from '../shared/exploration'
import type { Logger } from '../core/types'
import {
  ALL_BROWSER_CONTROL_OPS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  LEGACY_BROWSER_CONTROL_OPS,
  isBrowserFailureStage,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserExtensionRuntimeView,
  type BrowserFailureStage
} from '../shared/browserControl'
import type { BrowserPagePayload } from '../worlds/browserPage/types'

const MAX_BODY_BYTES = 64 * 1024
/** 命令结果可能包含一页元素清单；上限仍远小于一张截图。 */
const MAX_COMMAND_RESULT_BYTES = 512 * 1024
const MAX_COMMAND_WAIT_MS = 25_000
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const DEFAULT_PORT = 43_123
const PORT_ATTEMPTS = 20
const RATE_PER_MINUTE = 30

interface PendingCommand {
  command: BrowserCommand
  createdAt: number
  /** 已选定的扩展实例；null 表示等第一条能力已知的轮询再绑定。 */
  instanceId: string | null
  resolve: (result: BrowserCommandResult) => void
  timer: NodeJS.Timeout
  cleanup: () => void
  done: boolean
}

/** 单个扩展实例的运行期事实；不代表磁盘上的发布版本。 */
interface ExtensionInstance {
  instanceId: string
  version: string | null
  protocolVersion: number | null
  buildId: string | null
  /** null 表示扩展没有声明 supportedOps（旧版扩展）。 */
  supportedOps: ReadonlySet<string> | null
  capabilitiesDeclared: boolean
  controlConsent: boolean | null
  lastHelloAt: number | null
  lastPollAt: number | null
  lastResultAt: number | null
}

interface PollWaiter {
  res: ServerResponse
  instanceId: string
  timer: NodeJS.Timeout | null
}

export type { BrowserExtensionRuntimeView }

interface BridgeFile {
  version: 1
  port: number
  token: string
  /**
   * 最近一次启动时从哪个端口迁走。扩展继续访问旧端口会显示离线；
   * 设置页据此提示「配对地址变化」，而不是误报扩展被删除。
   * 扩展凭当前 token 重新联系本机后清空。
   */
  portChangedFrom?: number | null
}

export interface BrowserBridgeStatus {
  running: boolean
  port: number | null
  pairingCode: string | null
  lastPageAt: number | null
  pagesLastMinute: number
  pagesLastHour: number
  rejectedLastMinute: number
  lastError: string | null
  /** 主动控制已开启（世界开关 + 用户同意）。 */
  controlReady: boolean
  /**
   * 最近 90 秒内扩展通过任一已鉴权通道联系过本机。
   * 页面感知在线不等于主动控制通道在线。
   */
  extensionConnected: boolean
  /** 最近 90 秒内扩展在长轮询 /v1/command，说明主动控制通道在线。 */
  controlConnected: boolean
  /** 扩展最近一次 hello 报告的主动浏览授权；null 表示尚未收到。 */
  extensionControlConsent: boolean | null
  /** 最近一次选中的运行实例；含实际运行版本/协议/构建/能力，不是磁盘发布版本。 */
  runtime: BrowserExtensionRuntimeView | null
  /** 所有近期联系过本机的扩展实例；用于区分 Chrome/Edge 与新老扩展。 */
  runtimes: BrowserExtensionRuntimeView[]
  pendingCommands: number
  lastCommandAt: number | null
  lastResultAt: number | null
  /** 最近一小时成功/失败/超时的指令数；只有计数。 */
  commandsLastHour: number
  commandFailuresLastHour: number
  lastCommandError: string | null
  portChangedFrom: number | null
}

export interface BrowserBridgeOptions {
  dataDir: string
  getConfig: () => AppConfig
  onPage: (payload: BrowserPagePayload) => void
  logger: Logger
  now?: () => number
  /** 测试用：固定端口；0 表示随机端口。 */
  port?: number
  host?: string
}

/**
 * 浏览器扩展的本机回环桥。
 *
 * - 只绑定 127.0.0.1；随机 token 存在 data/browser-bridge.json（0600）。
 * - 不记录请求 body、标题、域名或摘要；只保留计数与状态。
 * - 页面感知关闭/未同意时，页面请求一律 403；健康检查仍可用。
 */
export class BrowserBridge {
  private readonly dataDir: string
  private readonly file: string
  private readonly getConfig: () => AppConfig
  private readonly onPage: (payload: BrowserPagePayload) => void
  private readonly logger: Logger
  private readonly now: () => number
  private readonly host: string
  private readonly requestedPort: number
  private server: Server | null = null
  private token = ''
  private port: number | null = null
  private portChangedFrom: number | null = null
  private starting: Promise<void> | null = null
  private lastError: string | null = null
  private lastPageAt: number | null = null
  private pageTimes: number[] = []
  private rejectTimes: number[] = []
  private stopped = false
  private readonly queue: PendingCommand[] = []
  private active: PendingCommand | null = null
  private readonly waiters = new Map<string, PollWaiter>()
  private readonly instances = new Map<string, ExtensionInstance>()
  private lastExtensionAt: number | null = null
  private lastHelloAt: number | null = null
  private lastPollAt: number | null = null
  private lastCommandAt: number | null = null
  private lastResultAt: number | null = null
  private commandTimes: number[] = []
  private commandFailureTimes: number[] = []
  private lastCommandError: string | null = null

  constructor(opts: BrowserBridgeOptions) {
    this.dataDir = opts.dataDir
    this.file = join(opts.dataDir, 'browser-bridge.json')
    this.getConfig = opts.getConfig
    this.onPage = opts.onPage
    this.logger = opts.logger
    this.now = opts.now ?? (() => Date.now())
    this.host = opts.host ?? '127.0.0.1'
    this.requestedPort = opts.port ?? DEFAULT_PORT
    const state = this.loadFile()
    this.token = state.token
    this.port = state.port
    this.portChangedFrom = state.portChangedFrom ?? null
  }

  private pageEnabled(): boolean {
    const config = this.getConfig().worlds.browserPage
    return config.enabled && config.consentAt !== null
  }

  /**
   * 主动控制是独立的世界级同意；与被动页面感知互不推导。
   * 用户撤销「自由探索」里的标签页范围后，控制通道立即关闭，扩展会收到 403。
   */
  private controlEnabled(): boolean {
    const config = this.getConfig()
    const control = config.worlds.browserControl
    if (!control.enabled || typeof control.consentAt !== 'number') return false
    const view = effectiveExploration(config, this.now())
    return view.active && view.browserTabs
  }

  controlReady(): boolean {
    return this.controlEnabled() && this.startedServer()
  }

  /** 进入运行状态的端口；未运行时返回上次使用的端口。 */
  currentPort(): number | null {
    return this.port
  }

  pairingCode(): string | null {
    if (this.token === '' || this.port === null) return null
    return `${this.port}#${this.token}`
  }

  /** 配置热更新：任一通道开启时启动，都关闭时停止。 */
  refresh(): void {
    if (this.stopped) return
    if (this.pageEnabled() || this.controlEnabled()) {
      void this.start()
    } else {
      this.stopServer()
      this.failAll('DISABLED', '主动浏览已关闭')
    }
  }

  async start(): Promise<void> {
    if (this.startedServer()) return
    if (this.starting !== null) return this.starting
    this.stopped = false
    this.starting = this.listen().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private startedServer(): boolean {
    return this.server !== null && this.server.listening
  }

  private async listen(): Promise<void> {
    const preferred = this.requestedPort === 0 ? 0 : this.port ?? this.requestedPort
    const attempts = this.requestedPort === 0 ? 1 : PORT_ATTEMPTS
    for (let offset = 0; offset < attempts; offset += 1) {
      const port = preferred === 0 ? 0 : preferred + offset
      try {
        await this.listenOn(port)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EADDRINUSE') {
          this.lastError = '端口绑定失败'
          this.logger.warn('浏览器桥启动失败', { code: code ?? 'unknown' })
          return
        }
      }
    }
    this.lastError = '没有可用端口'
    this.logger.warn('浏览器桥没有可用端口', { preferred })
  }

  private listenOn(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res)
      })
      server.once('error', reject)
      server.listen(port, this.host, () => {
        server.off('error', reject)
        const address = server.address()
        const actual = typeof address === 'object' && address !== null ? address.port : port
        this.server = server
        const previousPort = this.port
        this.port = actual
        // 端口被别的程序占用而回退时，扩展保存的仍是旧端口。把变化记录下来，
        // 让设置页提示重新复制配对码，而不是让用户以为扩展「消失了」。
        if (previousPort !== null && previousPort !== actual) {
          this.portChangedFrom = this.portChangedFrom ?? previousPort
        }
        this.lastError = null
        this.saveFile()
        this.logger.info('浏览器桥已启动', {
          port: actual,
          host: this.host,
          ...(this.portChangedFrom === null
            ? {}
            : { portChangedFrom: this.portChangedFrom })
        })
        resolve()
      })
    })
  }

  private stopServer(): void {
    this.endWaiters()
    this.failAll('STOPPED', '浏览器桥已停止')
    if (this.server === null) return
    const server = this.server
    this.server = null
    server.close()
    this.logger.info('浏览器桥已停止')
  }

  /** 主动指令：排队、等待扩展长轮询，并在超时/中止时给出结构化结果。 */
  execute(
    op: string,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<BrowserCommandResult> {
    if (!this.controlEnabled()) {
      return Promise.resolve({
        ok: false,
        code: 'DISABLED',
        error: '主动浏览未开启或未同意',
        stage: 'preflight',
        retryable: false,
        durationMs: 0
      })
    }
    if (!this.startedServer()) {
      return Promise.resolve({
        ok: false,
        code: 'BRIDGE_DOWN',
        error: '浏览器桥没有运行',
        stage: 'preflight',
        retryable: true,
        durationMs: 0
      })
    }
    const now = this.now()
    this.pruneInstances(now)
    const consent = this.aggregateControlConsent()
    if (consent === false && !this.controlConnected(now)) {
      // 扩展最近明确报告尚未授权主动浏览、且控制通道也确实不在线时，不必让
      // 用户干等；如果轮询已经在线，说明授权至少已经生效，以实际通道为准。
      return Promise.resolve(this.offlineResult(0))
    }
    const selection = this.selectInstance(op, now)
    if (selection.kind === 'unsupported') {
      return Promise.resolve(this.unsupportedResult(op, selection.instance, 0))
    }
    const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, 120_000))
    return new Promise((resolve) => {
      const command: BrowserCommand = {
        id: randomUUID(),
        op,
        params,
        issuedAt: now
      }
      let settled = false
      const onAbort = (): void => {
        this.finish(job, this.withInstance({
          ok: false,
          code: 'ABORTED',
          error: '指令已中止',
          stage: 'dispatch',
          retryable: false,
          durationMs: this.now() - job.createdAt
        }, job.instanceId))
      }
      const job: PendingCommand = {
        command,
        createdAt: now,
        instanceId: selection.kind === 'selected' ? selection.instance.instanceId : null,
        resolve,
        timer: setTimeout(() => {
          const current = this.now()
          // 如果超时的时候扩展根本没有在轮询控制通道，给用户可执行的修复提示，
          // 而不是只报一个含糊的 TIMEOUT。
          this.finish(
            job,
            this.controlConnected(current)
              ? this.withInstance({
                  ok: false,
                  code: 'TIMEOUT',
                  error: '浏览指令在限定时间内没有回执；页面可能已经打开，先核实标签状态再决定是否重试。',
                  stage: 'dispatch',
                  retryable: false,
                  durationMs: current - job.createdAt
                }, job.instanceId)
              : this.offlineResult(current - job.createdAt, job.instanceId)
          )
        }, timeoutMs),
        cleanup: () => {
          if (!settled) {
            settled = true
            options.signal?.removeEventListener('abort', onAbort)
          }
        },
        done: false
      }
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          clearTimeout(job.timer)
          job.cleanup()
          resolve({
            ok: false,
            code: 'ABORTED',
            error: '指令已中止',
            stage: 'dispatch',
            retryable: false,
            durationMs: 0
          })
          return
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.queue.push(job)
      this.pump()
    })
  }

  private protocolCompatible(instance: ExtensionInstance): boolean {
    return (
      instance.protocolVersion === null ||
      instance.protocolVersion <= BROWSER_CONTROL_PROTOCOL_VERSION
    )
  }

  private supportsOp(instance: ExtensionInstance, op: string): boolean {
    // 协议比本应用新的扩展可能改变了结果形状，不盲目投递任何指令，
    // 让用户先更新应用或扩展。
    if (!this.protocolCompatible(instance)) return false
    if (instance.supportedOps !== null) return instance.supportedOps.has(op)
    // 没有能力声明的旧扩展只保留已经存在过的通用浏览指令。
    return LEGACY_BROWSER_CONTROL_OPS.includes(op)
  }

  private ensureInstance(instanceId: string): ExtensionInstance {
    const existing = this.instances.get(instanceId)
    if (existing !== undefined) return existing
    const created: ExtensionInstance = {
      instanceId,
      version: null,
      protocolVersion: null,
      buildId: null,
      supportedOps: null,
      capabilitiesDeclared: false,
      controlConsent: null,
      lastHelloAt: null,
      lastPollAt: null,
      lastResultAt: null
    }
    this.instances.set(instanceId, created)
    return created
  }

  private registerHello(hello: ParsedHello, now: number): void {
    const instance = this.ensureInstance(hello.instanceId ?? 'legacy')
    if (hello.version !== null) instance.version = hello.version
    if (hello.protocolVersion !== null) instance.protocolVersion = hello.protocolVersion
    if (hello.buildId !== null) instance.buildId = hello.buildId
    if (hello.supportedOps !== null) {
      instance.supportedOps = new Set(hello.supportedOps)
      instance.capabilitiesDeclared = true
    }
    instance.controlConsent = hello.controlConsent
    instance.lastHelloAt = now
  }

  private registerPoll(
    instanceId: string,
    facts: {
      version: string | null
      protocolVersion: number | null
      buildId: string | null
      supportedOps: string[] | null
    },
    now: number
  ): ExtensionInstance {
    const instance = this.ensureInstance(instanceId)
    // 轮询参数可能比 hello 更完整（例如 hello 因未授权而没发）。旧扩展
    // 不带这些参数，保留先前的已知信息。
    if (facts.version !== null) instance.version = facts.version
    if (facts.protocolVersion !== null) instance.protocolVersion = facts.protocolVersion
    if (facts.buildId !== null) instance.buildId = facts.buildId
    if (facts.supportedOps !== null) {
      instance.supportedOps = new Set(facts.supportedOps)
      instance.capabilitiesDeclared = true
    }
    instance.lastPollAt = now
    return instance
  }

  private selectInstance(
    op: string,
    now: number
  ):
    | { kind: 'selected'; instance: ExtensionInstance }
    | { kind: 'unsupported'; instance: ExtensionInstance | null }
    | { kind: 'unknown' } {
    const known = this.liveInstances(now)
    if (known.length === 0) return { kind: 'unknown' }
    const connected = known.filter(
      (entry) => entry.lastPollAt !== null && now - entry.lastPollAt < 90_000
    )
    const pool = connected.length > 0 ? connected : known
    const supporting = pool.filter((entry) => this.supportsOp(entry, op))
    if (supporting.length === 0) {
      const latest = pool
        .slice()
        .sort((a, b) => this.instanceRecency(b) - this.instanceRecency(a))[0] ?? null
      return { kind: 'unsupported', instance: latest }
    }
    const instance = supporting
      .slice()
      .sort((a, b) => this.instanceRecency(b) - this.instanceRecency(a))[0]
    return instance === undefined ? { kind: 'unknown' } : { kind: 'selected', instance }
  }

  private instanceRecency(instance: ExtensionInstance): number {
    return Math.max(instance.lastPollAt ?? 0, instance.lastHelloAt ?? 0)
  }

  private liveInstances(now: number): ExtensionInstance[] {
    const out: ExtensionInstance[] = []
    for (const instance of this.instances.values()) {
      const last = Math.max(instance.lastPollAt ?? 0, instance.lastHelloAt ?? 0)
      if (last > 0 && now - last < 90_000) out.push(instance)
    }
    return out
  }

  private aggregateControlConsent(): boolean | null {
    let sawFalse = false
    for (const instance of this.instances.values()) {
      if (instance.controlConsent === true) return true
      if (instance.controlConsent === false) sawFalse = true
    }
    return sawFalse ? false : null
  }

  private bestRuntime(now: number): ExtensionInstance | null {
    const connected = this.liveInstances(now).filter(
      (entry) => entry.lastPollAt !== null && now - entry.lastPollAt < 90_000
    )
    const pool = connected.length > 0 ? connected : this.liveInstances(now)
    return (
      pool.slice().sort((a, b) => this.instanceRecency(b) - this.instanceRecency(a))[0] ?? null
    )
  }

  private runtimeView(instance: ExtensionInstance, now: number): BrowserExtensionRuntimeView {
    const supported = instance.supportedOps === null ? LEGACY_BROWSER_CONTROL_OPS : [...instance.supportedOps]
    return {
      instanceId: instance.instanceId,
      version: instance.version,
      protocolVersion: instance.protocolVersion,
      buildId: instance.buildId,
      capabilitiesDeclared: instance.capabilitiesDeclared,
      supportedOps: supported.slice(0, 64),
      controlConsent: instance.controlConsent,
      controlConnected: instance.lastPollAt !== null && now - instance.lastPollAt < 90_000,
      lastHelloAt: instance.lastHelloAt,
      lastPollAt: instance.lastPollAt,
      lastResultAt: instance.lastResultAt
    }
  }

  private withInstance(
    result: BrowserCommandResult,
    instanceId: string | null
  ): BrowserCommandResult {
    if (instanceId === null) return result
    const instance = this.instances.get(instanceId)
    if (instance === undefined) return result
    return {
      ...result,
      instanceId,
      extensionVersion: instance.version,
      extensionBuildId: instance.buildId,
      protocolVersion: instance.protocolVersion
    }
  }

  private unsupportedResult(
    op: string,
    instance: ExtensionInstance | null,
    durationMs: number
  ): BrowserCommandResult {
    const version =
      instance === null || instance.version === null ? '未知' : `v${instance.version}`
    const supportedOps =
      instance === null
        ? []
        : (instance.supportedOps === null
            ? LEGACY_BROWSER_CONTROL_OPS
            : [...instance.supportedOps]
          ).slice(0, 64)
    const protocolMismatch =
      instance !== null && !this.protocolCompatible(instance)
    return {
      ok: false,
      code: protocolMismatch ? 'EXTENSION_PROTOCOL_MISMATCH' : 'EXTENSION_UNSUPPORTED_OP',
      error: protocolMismatch
        ? `浏览器里正在运行的扩展协议版本（v${instance.protocolVersion ?? '?'}）高于本应用支持的 v${BROWSER_CONTROL_PROTOCOL_VERSION}。请更新桌宠，或换回与该桌宠版本匹配的扩展；这不是网站或网络故障。`
        : `浏览器里正在运行的扩展（${version}）没有声明支持这次浏览指令。请更新并重新加载扩展后再试。`,
      stage: 'preflight',
      retryable: false,
      ...(instance === null
        ? {}
        : { instanceId: instance.instanceId, extensionVersion: instance.version }),
      result: {
        requiredOp: op,
        protocolVersion: instance?.protocolVersion ?? null,
        serverProtocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        capabilitiesDeclared: instance?.capabilitiesDeclared === true,
        supportedOps
      },
      durationMs
    }
  }

  private finish(job: PendingCommand, result: BrowserCommandResult): void {
    if (job.done) return
    job.done = true
    clearTimeout(job.timer)
    job.cleanup()
    const queued = this.queue.indexOf(job)
    if (queued >= 0) this.queue.splice(queued, 1)
    if (this.active === job) this.active = null
    const now = this.now()
    const finalResult = {
      ...this.withInstance(result, job.instanceId),
      op: job.command.op,
      commandId: job.command.id
    }
    this.commandTimes.push(now)
    this.commandTimes = this.commandTimes.filter((at) => now - at < 60 * 60_000)
    if (!finalResult.ok) {
      this.commandFailureTimes.push(now)
      this.commandFailureTimes = this.commandFailureTimes.filter((at) => now - at < 60 * 60_000)
      this.lastCommandError = (finalResult.error ?? finalResult.code ?? 'command-failed').slice(0, 200)
    }
    if (job.instanceId !== null) {
      const instance = this.instances.get(job.instanceId)
      if (instance !== undefined) instance.lastResultAt = now
    }
    this.lastResultAt = now
    job.resolve(finalResult)
    this.pump()
  }

  private failAll(code: string, error: string): void {
    const jobs = [...this.queue, ...(this.active === null ? [] : [this.active])]
    for (const job of jobs) {
      this.finish(job, {
        ok: false,
        code,
        error,
        stage: 'dispatch',
        retryable: false,
        durationMs: Math.max(0, this.now() - job.createdAt)
      })
    }
    this.queue.length = 0
    this.active = null
  }

  /** 扩展是否仍在联系本机（页面、过滤规则、控制轮询或结果回传）。 */
  private extensionLive(now: number): boolean {
    return this.lastExtensionAt !== null && now - this.lastExtensionAt < 90_000
  }

  /** 主动控制长轮询是否在线；与页面感知在线是两件事。 */
  private controlConnected(now: number): boolean {
    return this.lastPollAt !== null && now - this.lastPollAt < 90_000
  }

  private offlineResult(durationMs: number, instanceId: string | null = null): BrowserCommandResult {
    const instance = instanceId === null ? null : this.instances.get(instanceId) ?? null
    const base = {
      ok: false,
      stage: 'preflight' as const,
      retryable: true,
      ...(instance === null
        ? {}
        : { instanceId: instance.instanceId, extensionVersion: instance.version }),
      durationMs
    }
    if (this.aggregateControlConsent() === false) {
      return {
        ...base,
        code: 'CONTROL_NOT_CONSENTED',
        error:
          '扩展弹窗里「允许主动浏览」未勾选；页面感知连通不代表允许主动浏览。' +
          '请打开浏览器扩展弹窗勾选后再试。'
      }
    }
    if (this.extensionLive(this.now())) {
      return {
        ...base,
        code: 'CONTROL_CHANNEL_OFFLINE',
        error:
          '扩展在线，但主动控制通道没有连接。请打开扩展弹窗确认「允许主动浏览」已勾选，' +
          '并刷新扩展后重试。'
      }
    }
    return {
      ...base,
      code: 'EXTENSION_OFFLINE',
      error: '扩展还没有连接本机。请确认扩展已加载、配对码正确，且桌宠正在运行。'
    }
  }

  /**
   * 把队列里的指令交给匹配的扩展实例。
   *
   * 已在入队时绑定的指令只交给该实例；尚未绑定的指令只交给明确支持该 op
   * 的实例。若当前只有不支持该 op 的旧扩展在轮询，立即返回可操作的能力
   * 错误，而不是盲发后让旧扩展回 UNKNOWN_COMMAND。
   */
  private pump(): void {
    if (this.active !== null) return
    while (this.queue.length > 0) {
      const job = this.queue[0]
      if (job === undefined) return
      if (job.done) {
        this.queue.shift()
        continue
      }
      let key: string | null = null
      if (job.instanceId !== null) {
        if (this.waiters.has(job.instanceId)) key = job.instanceId
      } else {
        for (const [candidateKey, waiter] of this.waiters) {
          const instance = this.instances.get(waiter.instanceId)
          if (instance !== undefined && this.supportsOp(instance, job.command.op)) {
            key = candidateKey
            break
          }
        }
        if (key === null && this.waiters.size > 0) {
          // 已有扩展在轮询，但没有一个声明支持这条指令。不能把命令交给
          // 旧实例碰运气；直接失败并保留实际运行版本。
          this.queue.shift()
          const any = this.waiters.values().next().value as PollWaiter | undefined
          const instance = any === undefined ? null : this.instances.get(any.instanceId) ?? null
          this.finish(job, this.unsupportedResult(job.command.op, instance, this.now() - job.createdAt))
          return
        }
      }
      if (key === null) return
      const waiter = this.waiters.get(key)
      if (waiter === undefined) return
      this.waiters.delete(key)
      if (waiter.timer !== null) clearTimeout(waiter.timer)
      this.queue.shift()
      if (job.instanceId === null) job.instanceId = waiter.instanceId
      if (job.instanceId !== waiter.instanceId) {
        // 已被其他实例绑定；把等待者放回去，避免错误投递。
        this.waiters.set(key, waiter)
        return
      }
      this.active = job
      this.lastCommandAt = this.now()
      this.json(waiter.res, 200, { ok: true, command: job.command })
      return
    }
  }

  private endWaiters(): void {
    for (const waiter of this.waiters.values()) {
      if (waiter.timer !== null) clearTimeout(waiter.timer)
      this.noContent(waiter.res)
    }
    this.waiters.clear()
  }

  private noContent(res: ServerResponse): void {
    if (res.headersSent || res.writableEnded) return
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  }

  /** 轮换 token；扩展需要重新配对。 */
  rotateToken(): string | null {
    this.token = randomBytes(32).toString('hex')
    // 旧扩展已经失效，连接状态不能继续沿用，直到新 token 重新联系本机。
    this.lastExtensionAt = null
    this.lastHelloAt = null
    this.lastPollAt = null
    this.instances.clear()
    this.portChangedFrom = null
    this.saveFile()
    this.logger.info('浏览器桥 token 已轮换')
    return this.pairingCode()
  }

  stop(): void {
    this.stopped = true
    this.stopServer()
  }

  status(): BrowserBridgeStatus {
    const now = this.now()
    this.pageTimes = this.pageTimes.filter((at) => now - at < 60 * 60_000)
    this.rejectTimes = this.rejectTimes.filter((at) => now - at < 60_000)
    this.commandTimes = this.commandTimes.filter((at) => now - at < 60 * 60_000)
    this.commandFailureTimes = this.commandFailureTimes.filter(
      (at) => now - at < 60 * 60_000
    )
    this.pruneInstances(now)
    const live = this.liveInstances(now)
    const runtimes = live
      .slice()
      .sort((a, b) => this.instanceRecency(b) - this.instanceRecency(a))
      .map((entry) => this.runtimeView(entry, now))
    const best = this.bestRuntime(now)
    return {
      running: this.startedServer(),
      port: this.startedServer() ? this.port : null,
      pairingCode: this.pairingCode(),
      lastPageAt: this.lastPageAt,
      pagesLastMinute: this.pageTimes.filter((at) => now - at < 60_000).length,
      pagesLastHour: this.pageTimes.length,
      rejectedLastMinute: this.rejectTimes.length,
      lastError: this.lastError,
      controlReady: this.controlEnabled() && this.startedServer(),
      extensionConnected: this.extensionLive(now),
      controlConnected: this.controlConnected(now),
      extensionControlConsent: this.aggregateControlConsent(),
      runtime: best === null ? null : this.runtimeView(best, now),
      runtimes,
      pendingCommands: this.queue.length + (this.active === null ? 0 : 1),
      lastCommandAt: this.lastCommandAt,
      lastResultAt: this.lastResultAt,
      commandsLastHour: this.commandTimes.length,
      commandFailuresLastHour: this.commandFailureTimes.length,
      lastCommandError: this.lastCommandError,
      portChangedFrom: this.portChangedFrom
    }
  }

  /** 只保留最近 10 分钟联系过的实例；同时最多保留 8 个，状态页不会被刷爆。 */
  private pruneInstances(now: number): void {
    for (const [id, instance] of this.instances) {
      const last = Math.max(instance.lastPollAt ?? 0, instance.lastHelloAt ?? 0)
      if (last === 0 || now - last > 10 * 60_000) this.instances.delete(id)
    }
    if (this.instances.size <= 8) return
    const sorted = [...this.instances.values()].sort(
      (a, b) => this.instanceRecency(a) - this.instanceRecency(b)
    )
    for (const instance of sorted.slice(0, this.instances.size - 8)) {
      this.instances.delete(instance.instanceId)
    }
  }

  // ------------------------------------------------------------------ HTTP

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null
    const originOk = this.originAllowed(origin)
    const path = (req.url ?? '').split('?')[0] ?? ''

    if (req.method === 'OPTIONS') {
      if (!originOk) {
        this.reject(res, 403, 'origin')
        return
      }
      this.cors(res, origin)
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
      res.setHeader('Access-Control-Max-Age', '600')
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true')
      }
      res.writeHead(204)
      res.end()
      return
    }

    if (path === '/v1/health' && req.method === 'GET') {
      this.cors(res, origin)
      this.json(res, 200, {
        ok: true,
        version: 2,
        page: this.pageEnabled(),
        control: this.controlEnabled()
      })
      return
    }

    // 页面/过滤器接口：token +（扩展 Origin 或扩展 Service Worker 的无 Origin）+ 开关。
    if (!originOk) {
      this.reject(res, 403, 'origin', origin)
      return
    }
    if (!this.authorized(req)) {
      this.reject(res, 401, 'unauthorized', origin)
      return
    }
    this.cors(res, origin)
    // 任一通过 token 鉴权的请求都说明扩展仍在联系本机。
    // 注意这不等同于主动控制长轮询在线。
    this.lastExtensionAt = this.now()
    // 扩展已用当前 token 连上新端口，旧配对地址提示失去意义。
    if (this.portChangedFrom !== null) {
      this.portChangedFrom = null
      this.saveFile()
    }

    if (path === '/v1/hello' && req.method === 'POST') {
      const contentType = String(req.headers['content-type'] ?? '')
      if (!contentType.toLowerCase().startsWith('application/json')) {
        this.reject(res, 415, 'content-type', origin)
        return
      }
      void this.readBody(req)
        .then((body) => {
          const hello = parseHello(body)
          if (hello === null) {
            this.reject(res, 400, 'invalid-body', origin)
            return
          }
          const now = this.now()
          this.lastHelloAt = now
          this.registerHello(hello, now)
          this.json(res, 200, {
            ok: true,
            protocol: BROWSER_CONTROL_PROTOCOL_VERSION,
            instanceId: hello.instanceId ?? 'legacy'
          })
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === 'too-large') {
            this.reject(res, 413, 'too-large', origin)
            return
          }
          this.reject(res, 400, 'bad-request', origin)
        })
      return
    }

    if (path === '/v1/filters' && req.method === 'GET') {
      if (!this.pageEnabled()) {
        this.reject(res, 403, 'disabled', origin)
        return
      }
      const config = this.getConfig().worlds.browserPage
      this.json(res, 200, {
        allowlistOnly: config.allowlistOnly,
        allowlist: config.allowlist,
        denylist: config.denylist,
        sensitiveDomains: config.sensitiveDomains,
        // 扩展据此决定是否读取/发送标题与摘要；不包含任何页面内容。
        shareTitle: config.shareTitle,
        shareExcerpt: config.shareExcerpt,
        includeHeadings: config.includeHeadings,
        excerptMaxChars: config.excerptMaxChars,
        coalesceMs: config.coalesceMs,
        version: 1
      })
      return
    }

    if (path === '/v1/page' && req.method === 'POST') {
      if (!this.pageEnabled()) {
        this.reject(res, 403, 'disabled', origin)
        return
      }
      if (!this.allowPageRequest()) {
        this.reject(res, 429, 'rate-limit', origin)
        return
      }
      const contentType = String(req.headers['content-type'] ?? '')
      if (!contentType.toLowerCase().startsWith('application/json')) {
        this.reject(res, 415, 'content-type', origin)
        return
      }
      void this.readBody(req)
        .then((body) => {
          const payload = parsePayload(body)
          if (payload === null) {
            this.reject(res, 400, 'invalid-body', origin)
            return
          }
          this.pageTimes.push(this.now())
          this.lastPageAt = this.now()
          this.onPage(payload)
          this.json(res, 200, { ok: true })
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === 'too-large') {
            this.reject(res, 413, 'too-large', origin)
            return
          }
          this.reject(res, 400, 'bad-request', origin)
        })
      return
    }

    if (path === '/v1/command' && req.method === 'GET') {
      this.handleCommandPoll(req, res, origin)
      return
    }

    if (path === '/v1/result' && req.method === 'POST') {
      if (!this.controlEnabled()) {
        this.reject(res, 403, 'disabled', origin)
        return
      }
      const contentType = String(req.headers['content-type'] ?? '')
      if (!contentType.toLowerCase().startsWith('application/json')) {
        this.reject(res, 415, 'content-type', origin)
        return
      }
      void this.readBody(req, MAX_COMMAND_RESULT_BYTES)
        .then((body) => {
          const parsed = parseCommandResult(body)
          if (parsed === null) {
            this.reject(res, 400, 'invalid-body', origin)
            return
          }
          const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
          const reportedInstance = parsed.instanceId ?? query.get('instance')
          const active = this.active
          if (active === null || active.command.id !== parsed.id) {
            this.json(res, 409, { ok: false, error: 'stale-command' })
            return
          }
          // 多实例绑定：结果必须来自被投递的那个实例。旧版扩展没有实例字段，
          // 只有绑定到兼容实例 'legacy' 的指令才接受无实例回执。
          if (
            reportedInstance !== null &&
            active.instanceId !== null &&
            reportedInstance !== active.instanceId
          ) {
            this.json(res, 409, { ok: false, error: 'wrong-instance' })
            return
          }
          if (
            reportedInstance === null &&
            active.instanceId !== null &&
            active.instanceId !== 'legacy'
          ) {
            this.json(res, 409, { ok: false, error: 'missing-instance' })
            return
          }
          if (reportedInstance !== null) {
            const instance = this.instances.get(reportedInstance)
            if (instance !== undefined) instance.lastResultAt = this.now()
          }
          this.finish(active, {
            ok: parsed.ok,
            ...(parsed.code === undefined ? {} : { code: parsed.code }),
            ...(parsed.error === undefined ? {} : { error: parsed.error }),
            ...(parsed.stage === undefined ? {} : { stage: parsed.stage }),
            ...(parsed.retryable === undefined ? {} : { retryable: parsed.retryable }),
            ...(parsed.result === undefined ? {} : { result: parsed.result }),
            durationMs: Math.max(0, this.now() - active.createdAt)
          })
          this.json(res, 200, { ok: true })
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === 'too-large') {
            this.reject(res, 413, 'too-large', origin)
            return
          }
          this.reject(res, 400, 'bad-request', origin)
        })
      return
    }

    this.reject(res, 404, 'not-found', origin)
  }

  private handleCommandPoll(
    req: IncomingMessage,
    res: ServerResponse,
    origin: string | null
  ): void {
    if (!this.controlEnabled()) {
      this.reject(res, 403, 'disabled', origin)
      return
    }
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
    const rawInstance = query.get('instance')
    if (rawInstance !== null && !VALID_INSTANCE_ID.test(rawInstance)) {
      this.reject(res, 400, 'invalid-instance', origin)
      return
    }
    const facts = parsePollFacts(query)
    if (facts === null) {
      this.reject(res, 400, 'invalid-capabilities', origin)
      return
    }
    const now = this.now()
    const instanceId = rawInstance ?? 'legacy'
    this.lastPollAt = now
    this.registerPoll(instanceId, facts, now)
    this.pruneInstances(now)
    if (this.active !== null) {
      // 同一时刻只投递一条指令；其余实例先结束本次长轮询，下次再来。
      this.noContent(res)
      return
    }
    const existing = this.waiters.get(instanceId)
    if (existing !== undefined) {
      // 同一实例重连时旧连接已无意义，先结束它，避免命令写到废弃响应。
      if (existing.timer !== null) clearTimeout(existing.timer)
      this.waiters.delete(instanceId)
      this.noContent(existing.res)
    }
    const waitRaw = Number(query.get('wait') ?? '0')
    const waitMs =
      Number.isFinite(waitRaw) && waitRaw > 0
        ? Math.min(MAX_COMMAND_WAIT_MS, Math.round(waitRaw))
        : 0
    const waiter: PollWaiter = { res, instanceId, timer: null }
    const clear = (): void => {
      if (this.waiters.get(instanceId) !== waiter) return
      this.waiters.delete(instanceId)
      if (waiter.timer !== null) {
        clearTimeout(waiter.timer)
        waiter.timer = null
      }
    }
    res.once('close', clear)
    if (waitMs > 0) {
      waiter.timer = setTimeout(() => {
        if (this.waiters.get(instanceId) !== waiter) return
        this.waiters.delete(instanceId)
        waiter.timer = null
        this.noContent(res)
      }, waitMs)
    }
    this.waiters.set(instanceId, waiter)
    this.pump()
    if (this.waiters.get(instanceId) === waiter && waitMs === 0) {
      this.waiters.delete(instanceId)
      this.noContent(res)
    }
  }

  private readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          reject(new Error('too-large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  private authorized(req: IncomingMessage): boolean {
    const header = String(req.headers.authorization ?? '')
    const prefix = 'Bearer '
    if (!header.startsWith(prefix)) return false
    const provided = Buffer.from(header.slice(prefix.length))
    const expected = Buffer.from(this.token)
    if (provided.length !== expected.length) return false
    try {
      return timingSafeEqual(provided, expected)
    } catch {
      return false
    }
  }

  /**
   * Chrome/Edge 扩展的 Service Worker 对已授权主机发 fetch 时不会带 Origin
   * （Chromium 实测为缺失，而不是 `chrome-extension://…`）。这类请求仍必须
   * 通过 token 鉴权；显式的非扩展 Origin 仍拒绝，防止普通网页跨源访问。
   */
  private originAllowed(origin: string | null): boolean {
    if (origin === null) return true
    return origin.startsWith('chrome-extension://') || origin.startsWith('edge-extension://')
  }

  private allowPageRequest(): boolean {
    const now = this.now()
    this.pageTimes = this.pageTimes.filter((at) => now - at < 60 * 60_000)
    return this.pageTimes.filter((at) => now - at < 60_000).length < RATE_PER_MINUTE
  }

  private cors(res: ServerResponse, origin: string | null): void {
    if (origin !== null && this.originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
  }

  private reject(
    res: ServerResponse,
    code: number,
    reason: string,
    origin: string | null = null
  ): void {
    this.rejectTimes.push(this.now())
    if (origin !== null) this.cors(res, origin)
    this.json(res, code, { ok: false, error: reason })
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    if (res.headersSent) return
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  // ------------------------------------------------------------------ 持久化

  private loadFile(): BridgeFile {
    const fallback: BridgeFile = {
      version: 1,
      port: this.requestedPort,
      token: randomBytes(32).toString('hex')
    }
    try {
      if (!existsSync(this.file)) return fallback
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<BridgeFile>
      const port =
        typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port >= 0 && parsed.port <= 65_535
          ? parsed.port
          : fallback.port
      const token =
        typeof parsed.token === 'string' && /^[a-f0-9]{64}$/i.test(parsed.token) ? parsed.token : fallback.token
      const portChangedFrom =
        typeof parsed.portChangedFrom === 'number' &&
        Number.isInteger(parsed.portChangedFrom) &&
        parsed.portChangedFrom > 0 &&
        parsed.portChangedFrom <= 65_535
          ? parsed.portChangedFrom
          : null
      return { version: 1, port, token, portChangedFrom }
    } catch {
      return fallback
    }
  }

  private saveFile(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const body: BridgeFile = {
        version: 1,
        port: this.port ?? this.requestedPort,
        token: this.token,
        ...(this.portChangedFrom === null
          ? {}
          : { portChangedFrom: this.portChangedFrom })
      }
      writeFileSync(this.file, `${JSON.stringify(body)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      this.logger.warn('浏览器桥配置写入失败')
    }
  }
}

const VALID_INSTANCE_ID = /^[A-Za-z0-9._:-]{1,80}$/
const VALID_VERSION = /^[0-9A-Za-z._-]{1,32}$/
const VALID_BUILD_ID = /^[A-Za-z0-9._:-]{1,64}$/
const MAX_DECLARED_OPS = 64

interface ParsedHello {
  instanceId: string | null
  version: string | null
  protocolVersion: number | null
  buildId: string | null
  /** null 表示扩展没有能力声明（旧版）。 */
  supportedOps: string[] | null
  controlConsent: boolean | null
}

interface PollFacts {
  version: string | null
  protocolVersion: number | null
  buildId: string | null
  supportedOps: string[] | null
}

/** 只接受当前协议认识的 op，未知项丢弃；空列表表示“声明了但不支持任何已知 op”。 */
function parseSupportedOps(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const ops: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    if (!ALL_BROWSER_CONTROL_OPS.includes(item)) continue
    if (!ops.includes(item)) ops.push(item)
    if (ops.length >= MAX_DECLARED_OPS) break
  }
  return ops
}

function parseOpsParam(value: string | null): string[] | null {
  if (value === null) return null
  return parseSupportedOps(value.split(',').map((item) => item.trim()))
}

function parseProtocolParam(value: string | null): number | null {
  if (value === null || value === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1_000 ? parsed : null
}

function parsePollFacts(query: URLSearchParams): PollFacts | null {
  const versionRaw = query.get('version')
  const buildRaw = query.get('build')
  const protocolRaw = query.get('protocol')
  if (versionRaw !== null && !VALID_VERSION.test(versionRaw)) return null
  if (buildRaw !== null && !VALID_BUILD_ID.test(buildRaw)) return null
  if (protocolRaw !== null && parseProtocolParam(protocolRaw) === null) return null
  return {
    version: versionRaw,
    protocolVersion: parseProtocolParam(protocolRaw),
    buildId: buildRaw,
    supportedOps: parseOpsParam(query.get('ops'))
  }
}

function parseCommandResult(body: string): {
  id: string
  ok: boolean
  code?: string
  error?: string
  stage?: BrowserFailureStage
  retryable?: boolean
  instanceId?: string
  result?: unknown
} | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw['id'] !== 'string' || raw['id'].length > 80) return null
  if (typeof raw['ok'] !== 'boolean') return null
  const code =
    typeof raw['code'] === 'string' && raw['code'].length <= 60 ? raw['code'] : undefined
  const error =
    typeof raw['error'] === 'string' ? raw['error'].slice(0, 500) : undefined
  const stage = isBrowserFailureStage(raw['stage']) ? raw['stage'] : undefined
  const retryable = typeof raw['retryable'] === 'boolean' ? raw['retryable'] : undefined
  const instanceId =
    typeof raw['instance'] === 'string' && VALID_INSTANCE_ID.test(raw['instance'])
      ? raw['instance']
      : undefined
  return {
    id: raw['id'],
    ok: raw['ok'],
    ...(code === undefined ? {} : { code }),
    ...(error === undefined ? {} : { error }),
    ...(stage === undefined ? {} : { stage }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(raw['result'] === undefined ? {} : { result: raw['result'] })
  }
}

/**
 * 扩展在线握手只携带能力/授权元数据，不携带页面内容。
 * 应用据此区分「页面感知在线」和「扩展弹窗允许主动浏览」，以及正在运行的
 * 扩展到底支持哪些指令；磁盘上的发布版本不能当作运行时版本。
 */
function parseHello(body: string): ParsedHello | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>

  const instanceRaw = raw['instanceId']
  if (
    instanceRaw !== undefined &&
    (typeof instanceRaw !== 'string' || !VALID_INSTANCE_ID.test(instanceRaw))
  ) {
    return null
  }
  const versionRaw = raw['version']
  if (
    versionRaw !== undefined &&
    (typeof versionRaw !== 'string' || !VALID_VERSION.test(versionRaw))
  ) {
    return null
  }
  const buildRaw = raw['buildId']
  if (
    buildRaw !== undefined &&
    (typeof buildRaw !== 'string' || !VALID_BUILD_ID.test(buildRaw))
  ) {
    return null
  }
  let protocolVersion: number | null = null
  const protocolRaw = raw['protocolVersion']
  if (protocolRaw !== undefined) {
    if (
      typeof protocolRaw !== 'number' ||
      !Number.isInteger(protocolRaw) ||
      protocolRaw <= 0 ||
      protocolRaw > 1_000
    ) {
      return null
    }
    protocolVersion = protocolRaw
  }
  const supportedOps =
    raw['supportedOps'] === undefined ? null : parseSupportedOps(raw['supportedOps'])
  if (raw['supportedOps'] !== undefined && supportedOps === null) return null

  return {
    instanceId: typeof instanceRaw === 'string' ? instanceRaw : null,
    version: typeof versionRaw === 'string' ? versionRaw : null,
    protocolVersion,
    buildId: typeof buildRaw === 'string' ? buildRaw : null,
    supportedOps,
    controlConsent:
      typeof raw['controlConsent'] === 'boolean' ? raw['controlConsent'] : null
  }
}

function parsePayload(body: string): BrowserPagePayload | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.clear === true || raw.suppressed === true) {
    return { domain: '', suppressed: raw.suppressed === true, clear: raw.clear === true }
  }
  if (typeof raw.domain !== 'string' || raw.domain.length > 253) return null
  const title = typeof raw.title === 'string' ? raw.title.slice(0, 300) : null
  const excerpt = typeof raw.excerpt === 'string' ? raw.excerpt.slice(0, 8_000) : null
  const headings = Array.isArray(raw.headings)
    ? raw.headings
        .filter((item): item is string => typeof item === 'string' && item.length <= 300)
        .slice(0, 20)
    : []
  const source = typeof raw.source === 'string' ? raw.source.slice(0, 20) : undefined
  return {
    domain: raw.domain,
    title,
    excerpt,
    headings,
    ...(source === undefined ? {} : { source })
  }
}
