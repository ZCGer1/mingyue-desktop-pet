import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { spawn } from 'node:child_process'
import type { Logger } from '../../core/types'
import type { AppConfig } from '../../shared/config'
import type {
  BiliAsrJobView,
  BiliEnvironmentView,
  BiliFailureStage,
  BiliFailureView,
  BiliInstallKind,
  BiliLoginQrView,
  BiliLoginView,
  BiliPhase,
  BiliReadFailureCode,
  BiliReadingRecord,
  BiliReadingView,
  BiliReportOpenResult,
  BiliReportSummary,
  BiliServiceState,
  BiliSessionView,
  BiliStatusView
} from '../../shared/bilibili'
import {
  BILI_PHASE_LABELS,
  accountPartition,
  biliFailure,
  isBvid,
  localDateKey
} from '../../shared/bilibili'
import type {
  BiliCryptoPort,
  BiliCredentials,
  BiliCredentialSnapshot
} from './credentials'
import { BiliCredentialStore as CredentialStore } from './credentials'
import { BiliMcpClient, BiliMcpError, type BiliMcpToolName, type BiliMcpToolResult } from './mcpClient'
import { BiliLoginManager } from './login'
import { BiliEnvironment } from './environment'
import { BiliAsrJobs, AsrError, type BiliAsrLimits } from './asrJobs'
import { BiliReadingStore } from './readingStore'
import { reportAccountDir } from './dailyReport'
import { resolveBiliPaths, type BiliPaths } from './paths'

/**
 * B 站阅读路线的主进程编排。
 *
 * World 只通过这里访问 Python 服务、登录、转写和阅读记录；渲染进程只能
 * 拿到展示视图。所有失败都映射到固定 code/阶段，凭据不进入任何视图或日志。
 */
export interface BilibiliServiceOptions {
  rootDir: string
  resourcesDir: string
  logger: Logger
  crypto: BiliCryptoPort
  getConfig: () => AppConfig
  spawnImpl?: typeof spawn
  now?: () => number
  /** 测试注入；生产环境由 runtime 传入 `shell.openPath`。 */
  openPath?: (path: string) => Promise<string>
}

export interface BiliSessionProvider {
  (): BiliSessionView
}

export interface BiliVisionProvider {
  (): { available: boolean; reason: string | null }
}

type StopReason = 'user' | 'permission' | 'shutdown' | 'login' | 'account'

const STOP_COOLDOWN_MS = 30 * 60_000
const MAX_CRASH_RESTARTS = 3
const STABLE_RESET_MS = 60_000

export class BilibiliService {
  readonly paths: BiliPaths
  readonly reading: BiliReadingStore
  private readonly opts: BilibiliServiceOptions
  private readonly logger: Logger
  private readonly credentialStore: CredentialStore
  private readonly login: BiliLoginManager
  private readonly environment: BiliEnvironment
  private client: BiliMcpClient
  private readonly asr: BiliAsrJobs
  private credentials: BiliCredentialSnapshot | null = null
  private state: BiliServiceState = 'stopped'
  private startedAt: number | null = null
  private restarts = 0
  private crashCount = 0
  private lastServiceError: BiliFailureView | null = null
  private recentFailures: BiliFailureView[] = []
  private lastFailureValue: BiliFailureView | null = null
  private starting = false
  private disposed = false
  private restartTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private stoppedUntil = 0
  private stopReason: string | null = null
  private sessionProvider: BiliSessionProvider = () => defaultSession()
  private visionProvider: BiliVisionProvider = () => ({
    available: false,
    reason: '尚未检查当前模型的图片能力'
  })
  private onChanged: () => void = () => undefined
  private onAccountChanged: (reason: 'switch' | 'logout' | 'expired') => void = () => undefined
  private onAsrTerminal: (job: BiliAsrJobView) => void = () => undefined
  private onStopRequested: (reason: StopReason) => void = () => undefined
  private readonly asrAccounts = new Map<string, string>()
  /** 在途 MCP 请求的中止句柄；停止/退出/切换账号时必须真正取消。 */
  private readonly activeCalls = new Set<AbortController>()
  private initialized = false

  constructor(options: BilibiliServiceOptions) {
    this.opts = options
    this.logger = options.logger
    this.paths = resolveBiliPaths(options.rootDir)
    this.credentialStore = new CredentialStore(this.paths.credentialsFile, options.crypto)
    this.reading = new BiliReadingStore({
      paths: this.paths,
      logger: this.logger,
      ...(options.now === undefined ? {} : { now: options.now }),
      onChange: () => this.notify()
    })
    this.environment = new BiliEnvironment({
      paths: this.paths,
      resourcesDir: options.resourcesDir,
      logger: this.logger,
      ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
      ...(options.now === undefined ? {} : { now: options.now }),
      onChanged: () => this.notify()
    })
    this.login = new BiliLoginManager({
      logger: this.logger,
      onSignedIn: (credentials, uid) => this.handleSignedIn(credentials, uid),
      onChanged: () => this.notify()
    })
    this.client = new BiliMcpClient({
      pythonPath: '',
      scriptPath: '',
      logger: this.logger,
      onExit: (info) => this.handleClientExit(info)
    })
    this.asr = new BiliAsrJobs({
      paths: this.paths,
      resourcesDir: options.resourcesDir,
      asrPython: () => this.environment.asrPython(),
      logger: this.logger,
      ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
      ...(options.now === undefined ? {} : { now: options.now }),
      onFinished: (job) => this.handleAsrFinished(job)
    })
  }

  setSessionProvider(provider: BiliSessionProvider): void {
    this.sessionProvider = provider
  }

  setVisionProvider(provider: BiliVisionProvider): void {
    this.visionProvider = provider
  }

  setOnChanged(listener: () => void): void {
    this.onChanged = listener
  }

  setOnAccountChanged(listener: (reason: 'switch' | 'logout' | 'expired') => void): void {
    this.onAccountChanged = listener
  }

  setOnAsrTerminal(listener: (job: BiliAsrJobView) => void): void {
    this.onAsrTerminal = listener
  }

  setOnStopRequested(listener: (reason: StopReason) => void): void {
    this.onStopRequested = listener
  }

  /**
   * 启动时恢复登录、阅读分区与环境状态；不自动安装依赖，也不在无同意时
   * 启动服务。设置页首次打开前也可能调用，因此必须可重入。
   */
  async start(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await this.refreshEnvironment(true)
    const saved = this.credentialStore.load()
    this.credentials = saved
    if (saved === null) {
      this.login.restore(null)
      this.reading.openAccount('anonymous', { memoryEnabled: this.memoryEnabled() })
    } else {
      this.login.restore(saved)
      this.reading.openAccount(accountKeyFor(saved.info.uid), {
        memoryEnabled: this.memoryEnabled()
      })
    }
    this.applyReadingConfig()
    await this.reconcile()
    this.notify()
  }

  async updateConfig(): Promise<void> {
    if (this.disposed) return
    this.applyReadingConfig()
    await this.refreshEnvironment(false)
    await this.reconcile()
    this.notify()
  }

  async refreshEnvironment(force = false): Promise<void> {
    await this.environment.refresh(force, this.config().worlds.bilibili.asr.model)
    this.notify()
  }

  status(): BiliStatusView {
    const cfg = this.config().worlds.bilibili
    const today = localDateKey(this.now())
    const summary = this.reading.summary(today, cfg.report.enabled)
    const environment: BiliEnvironmentView = {
      pythonFound: this.environment.pythonView().found,
      pythonVersion: this.environment.pythonView().version,
      python: this.environment.view('python'),
      service: this.environment.view('service'),
      asr: this.environment.view('asr'),
      model: this.environment.view('model')
    }
    const login = this.login.view()
    const session = this.sessionWithStop()
    return {
      phase: this.phase(cfg, environment, login),
      phaseLabel: BILI_PHASE_LABELS[this.phase(cfg, environment, login)],
      enabled: cfg.enabled,
      consented: cfg.consentAt !== null,
      explorationActive: this.config().exploration.enabled,
      service: {
        state: this.state,
        startedAt: this.startedAt,
        restarts: this.restarts,
        version: this.client.version,
        lastError: this.lastServiceError
      },
      environment,
      login,
      session,
      vision: this.visionProvider(),
      report: {
        enabled: cfg.report.enabled,
        retentionDays: cfg.report.retentionDays,
        todayDate: today,
        todayPath: summary.path,
        todayReady: summary.markdown !== '',
        lastError: this.reading.reportLastError
      },
      asr: {
        enabled: cfg.asr.enabled,
        model: cfg.asr.model,
        running: this.asr.runningCount,
        queued: this.asr.queuedCount,
        recent: this.asr.recent(5)
      },
      limits: {
        sessionMaxMs: cfg.sessionMaxMs,
        sessionMaxToolCalls: cfg.sessionMaxToolCalls,
        maxDetailsPerSession: cfg.maxDetailsPerSession,
        maxCandidatesPerBatch: cfg.maxCandidatesPerBatch,
        maxFrames: cfg.vision.maxFrames,
        asrMaxMediaMinutes: cfg.asr.maxMediaMinutes,
        asrMaxDownloadMb: cfg.asr.maxDownloadMb,
        asrMaxRunMinutes: cfg.asr.maxRunMinutes,
        asrMaxCacheMb: cfg.asr.maxCacheMb
      },
      recentFailures: this.recentFailures.slice()
    }
  }

  // ------------------------------------------------------------------ 生命周期

  private async reconcile(): Promise<void> {
    if (this.disposed) return
    const cfg = this.config().worlds.bilibili
    if (!cfg.enabled || cfg.consentAt === null || this.credentials === null) {
      await this.stopClient()
      return
    }
    if (this.environment.view('service').state !== 'ready') {
      await this.stopClient()
      return
    }
    if (this.client.running || this.starting) return
    if (this.state === 'failed' && this.crashCount >= MAX_CRASH_RESTARTS) return
    await this.startClient()
  }

  private async startClient(): Promise<void> {
    if (this.disposed || this.starting) return
    const cfg = this.config().worlds.bilibili
    if (!cfg.enabled || cfg.consentAt === null || this.credentials === null) return
    const python = this.environment.servicePython()
    const script = this.scriptPath()
    if (python === null) {
      this.state = 'failed'
      this.lastServiceError = biliFailure('service-not-installed', 'environment', {
        message: 'B 站只读服务依赖尚未安装。',
        retryable: true
      })
      this.notify()
      return
    }
    if (script === '') {
      this.state = 'failed'
      this.lastServiceError = biliFailure('service-start-failed', 'environment', {
        message: '应用资源缺少 B 站服务脚本。'
      })
      this.notify()
      return
    }
    this.starting = true
    this.state = 'starting'
    this.lastServiceError = null
    this.notify()
    const clientWithPaths = new BiliMcpClient({
      pythonPath: python,
      scriptPath: script,
      logger: this.logger,
      onExit: (info) => this.handleClientExit(info)
    })
    this.client = clientWithPaths
    try {
      await clientWithPaths.start(this.credentials.credentials)
      if (this.disposed || !this.wanted()) {
        await clientWithPaths.stop()
        this.state = 'stopped'
      } else {
        this.state = 'ready'
        this.startedAt = this.now()
        this.lastServiceError = null
        this.scheduleStableReset()
        void this.refreshAccountInfo()
      }
    } catch (error) {
      this.state = 'failed'
      const code: BiliReadFailureCode =
        error instanceof BiliMcpError && error.code === 'service-start-failed'
          ? 'service-start-failed'
          : 'service-crashed'
      this.lastServiceError = biliFailure(code, 'service', {
        message: error instanceof Error ? sanitizeMessage(error.message) : 'B 站服务启动失败。',
        retryable: true
      })
      this.recordFailure(['service-crashed', 'service-start-failed'].includes(code) ? code : 'service-start-failed', 'service', error)
      this.scheduleRestart()
    } finally {
      this.starting = false
      this.notify()
      await this.reconcileAfterStart()
    }
  }

  private async reconcileAfterStart(): Promise<void> {
    if (this.disposed) return
    if (!this.wanted() && this.client.running) {
      await this.stopClient()
    }
  }

  private async stopClient(): Promise<void> {
    this.clearTimers()
    this.abortActiveCalls()
    if (this.client.running) {
      await this.client.stop()
    }
    this.state = 'stopped'
    this.startedAt = null
    this.notify()
  }

  private handleClientExit(info: {
    code: number | null
    signal: NodeJS.Signals | null
    expected: boolean
  }): void {
    if (info.expected || this.disposed) return
    if (this.starting) return
    this.state = 'failed'
    this.lastServiceError = biliFailure('service-crashed', 'service', {
      message: 'B 站服务意外退出，已停止在途请求。',
      retryable: true
    })
    this.recordFailure('service-crashed', 'service', null)
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.disposed || this.restartTimer !== null) return
    if (!this.wanted()) return
    if (this.crashCount >= MAX_CRASH_RESTARTS) return
    this.crashCount += 1
    this.restarts += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.wanted()) return
      this.state = 'stopped'
      void this.startClient()
    }, 2500)
    this.restartTimer.unref?.()
    this.notify()
  }

  private scheduleStableReset(): void {
    if (this.stableTimer !== null) clearTimeout(this.stableTimer)
    this.stableTimer = setTimeout(() => {
      this.crashCount = 0
      this.stableTimer = null
    }, STABLE_RESET_MS)
    this.stableTimer.unref?.()
  }

  private clearTimers(): void {
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    if (this.stableTimer !== null) clearTimeout(this.stableTimer)
    this.restartTimer = null
    this.stableTimer = null
  }

  private wanted(): boolean {
    const cfg = this.config().worlds.bilibili
    const login = this.login.view().state
    return (
      cfg.enabled &&
      cfg.consentAt !== null &&
      this.credentials !== null &&
      login !== 'session-expired' &&
      login !== 'unlogged'
    )
  }

  // ------------------------------------------------------------------ 工具调用

  async callTool(
    name: BiliMcpToolName,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<BiliMcpToolResult> {
    if (this.isStopped()) {
      throw new BiliMcpError('stopped', 'B 站阅读已停止，等待恢复。')
    }
    this.assertCallable()
    if (!this.client.running) {
      throw new BiliMcpError(
        this.state === 'failed' ? 'service-crashed' : 'service-start-failed',
        this.state === 'failed' ? 'B 站服务意外退出。' : 'B 站服务尚未就绪。',
        true
      )
    }
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (options.signal?.aborted === true) {
      throw new BiliMcpError('cancelled', '已取消。')
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    this.activeCalls.add(controller)
    try {
      return await this.client.call(name, args, { ...options, signal: controller.signal })
    } catch (error) {
      throw this.noteFailure(error)
    } finally {
      this.activeCalls.delete(controller)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 中止所有在途 MCP 调用。只取消请求，不主动杀服务；MCP 客户端会在
   * 服务不响应取消时自行终止不可信的进程树。
   */
  private abortActiveCalls(): void {
    for (const controller of [...this.activeCalls]) {
      try {
        controller.abort()
      } catch {
        /* 单个取消失败不影响其余请求 */
      }
    }
    this.activeCalls.clear()
  }

  private assertCallable(): void {
    const cfg = this.config().worlds.bilibili
    if (!cfg.enabled) throw new BiliMcpError('disabled', 'B 站阅读未启用。')
    if (cfg.consentAt === null) throw new BiliMcpError('no-consent', '缺少 B 站 API 阅读同意。')
    if (this.credentials === null) {
      throw new BiliMcpError('login-required', '需要先扫码登录 B 站。')
    }
    if (this.login.view().state === 'session-expired') {
      throw new BiliMcpError('login-expired', 'B 站登录已失效，请重新扫码。', true)
    }
    if (this.environment.view('service').state !== 'ready') {
      throw new BiliMcpError('service-not-installed', 'B 站只读服务依赖尚未安装。')
    }
    if (this.state === 'failed') {
      throw new BiliMcpError('service-crashed', 'B 站服务意外退出。', true)
    }
  }

  private noteFailure(error: unknown): BiliMcpError {
    const mapped =
      error instanceof BiliMcpError
        ? error
        : new BiliMcpError('internal', 'B 站读取失败。')
    const code = mapped.code
    if (code !== 'cancelled' && code !== 'stopped') {
      this.recordFailure(code, stageForCode(code), mapped)
      if (
        (code === 'login-expired' || code === 'login-required') &&
        this.credentials !== null
      ) {
        this.invalidateLogin()
      }
    }
    return mapped
  }

  private invalidateLogin(): void {
    if (this.login.view().state === 'session-expired') return
    this.login.markSessionExpired()
    this.lastServiceError = biliFailure('login-expired', 'login', {
      message: 'B 站登录已失效，请重新扫码。',
      retryable: true
    })
    this.onAccountChanged('expired')
    void this.stopClient()
  }

  lastFailure(): BiliFailureView | null {
    return this.lastFailureValue
  }

  // ------------------------------------------------------------------ 登录

  async loginStart(): Promise<BiliLoginQrView> {
    const cfg = this.config().worlds.bilibili
    if (!cfg.enabled) {
      return {
        state: 'error',
        imageDataUrl: null,
        expiresAt: null,
        accountName: null,
        uidMasked: null,
        message: '请先启用 B 站阅读。'
      }
    }
    return this.login.start()
  }

  loginCancel(): BiliLoginQrView {
    return this.login.cancel()
  }

  /** 设置页轮询时重新取得当前二维码；图像只在内存，不落盘。 */
  loginQrView(): BiliLoginQrView {
    return this.login.qrView()
  }

  async logout(): Promise<void> {
    this.credentialStore.clear()
    this.credentials = null
    this.login.markLoggedOut()
    this.asr.cancelAll('cancelled')
    this.asrAccounts.clear()
    this.onAccountChanged('logout')
    await this.stopClient()
    this.reading.openAccount('anonymous', { memoryEnabled: this.memoryEnabled() })
    this.applyReadingConfig()
    this.notify()
  }

  private async handleSignedIn(credentials: BiliCredentials, uid: string | null): Promise<void> {
    const saved = this.credentialStore.save(credentials, { uid })
    if (!saved.ok) throw new Error(saved.message)
    const snapshot = this.credentialStore.load()
    if (snapshot === null) throw new Error('登录凭据读取失败。')
    const previous = this.reading.currentAccountKey
    const next = accountKeyFor(uid)
    this.credentials = snapshot
    if (previous !== next && previous !== 'anonymous') {
      this.asr.cancelAll('cancelled')
      this.asrAccounts.clear()
      this.onAccountChanged('switch')
    }
    if (this.client.running) await this.stopClient()
    this.reading.openAccount(next, { memoryEnabled: this.memoryEnabled() })
    this.applyReadingConfig()
    this.state = 'stopped'
    await this.reconcile()
    this.notify()
  }

  private async refreshAccountInfo(): Promise<void> {
    if (!this.client.running || this.credentials === null) return
    try {
      const result = await this.client.call('bili_account', {}, { timeoutMs: 20_000 })
      const uid = typeof result.payload.uid === 'string' ? result.payload.uid : null
      const name = typeof result.payload.name === 'string' ? result.payload.name : null
      if (uid === null) return
      const current = this.credentials
      const previousKey = this.reading.currentAccountKey
      const nextKey = accountKeyFor(uid)
      if (previousKey !== nextKey) {
        this.asr.cancelAll('cancelled')
        this.asrAccounts.clear()
        this.onAccountChanged('switch')
        this.reading.openAccount(nextKey, { memoryEnabled: this.memoryEnabled() })
      }
      this.login.noteAccount(name, uid)
      this.login.restore({
        credentials: current.credentials,
        info: { savedAt: current.info.savedAt, accountName: name, uid }
      })
      this.credentialStore.updateInfo({ accountName: name, uid })
    } catch (error) {
      if (error instanceof BiliMcpError && (error.code === 'login-expired' || error.code === 'login-required')) {
        this.invalidateLogin()
      }
    }
  }

  // ------------------------------------------------------------------ 安装

  async install(kind: BiliInstallKind): Promise<{ ok: boolean; message: string; version: string | null }> {
    const model = this.config().worlds.bilibili.asr.model
    const result = await this.environment.install(kind, { model })
    await this.environment.refresh(false, model)
    if (result.ok) await this.reconcile()
    this.notify()
    return {
      ok: result.ok,
      message: result.message,
      version: result.version ?? null
    }
  }

  retryService(): Promise<void> {
    this.crashCount = 0
    this.restarts += 1
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.state = 'stopped'
    return this.startClient()
  }

  // ------------------------------------------------------------------ 会话与停止

  isStopped(): boolean {
    if (this.stoppedUntil <= this.now()) {
      if (this.stoppedUntil !== 0) {
        this.stoppedUntil = 0
        this.stopReason = null
      }
      return false
    }
    return true
  }

  stopBrowsing(reason: StopReason, cooldownMs = STOP_COOLDOWN_MS): void {
    this.stoppedUntil = this.now() + Math.max(0, cooldownMs)
    this.stopReason = reason === 'user' ? '用户停止了 B 站阅读' : 'B 站阅读已停止'
    this.abortActiveCalls()
    this.cancelAllAsr('cancelled')
    this.onStopRequested(reason)
    this.notify()
  }

  resumeBrowsing(): void {
    this.stoppedUntil = 0
    this.stopReason = null
    this.notify()
  }

  sessionView(): BiliSessionView {
    return this.sessionWithStop()
  }

  private sessionWithStop(): BiliSessionView {
    const base = this.sessionProvider()
    return {
      ...base,
      stoppedUntil: this.stoppedUntil > this.now() ? this.stoppedUntil : null,
      cooldownReason: this.isStopped() ? this.stopReason : base.cooldownReason,
      lastFailure: this.lastFailureValue ?? base.lastFailure
    }
  }

  // ------------------------------------------------------------------ ASR

  submitAsr(input: {
    bvid: string
    page: number
    title: string
    durationSec: number | null
  }): BiliAsrJobView {
    const cfg = this.config().worlds.bilibili
    if (!cfg.asr.enabled) {
      throw new AsrError('asr-disabled', '本地转写已在设置中关闭。')
    }
    if (!isBvid(input.bvid)) throw new AsrError('not-found', '视频 BV 号不合法。')
    const limits: BiliAsrLimits = {
      model: cfg.asr.model,
      maxMediaMinutes: cfg.asr.maxMediaMinutes,
      maxDownloadMb: cfg.asr.maxDownloadMb,
      maxRunMinutes: cfg.asr.maxRunMinutes,
      maxCacheMb: cfg.asr.maxCacheMb
    }
    const job = this.asr.submit({ ...input, limits })
    this.asrAccounts.set(job.id, this.reading.currentAccountKey)
    const record = this.reading.get(input.bvid, Math.max(0, input.page - 1))
    if (record !== null) {
      this.reading.update(input.bvid, Math.max(0, input.page - 1), {
        asr: {
          jobId: job.id,
          state: job.state,
          model: job.model,
          submittedAt: job.queuedAt,
          finishedAt: job.finishedAt,
          chars: job.chars,
          errorCode: job.errorCode
        }
      })
    }
    this.notify()
    return job
  }

  asrStatus(jobId: string): BiliAsrJobView {
    const view = this.asr.view(jobId)
    if (view === null) throw new AsrError('not-found', '找不到这个转写任务。')
    return view
  }

  asrRead(jobId: string, offset = 0, limit = 8000) {
    const owner = this.asrAccounts.get(jobId)
    if (owner !== undefined && owner !== this.reading.currentAccountKey) {
      throw new AsrError('not-found', '转写任务不属于当前账号。')
    }
    return this.asr.read(jobId, offset, limit)
  }

  cancelAsr(jobId: string): BiliAsrJobView {
    const owner = this.asrAccounts.get(jobId)
    if (owner !== undefined && owner !== this.reading.currentAccountKey) {
      throw new AsrError('not-found', '转写任务不属于当前账号。')
    }
    const view = this.asr.cancel(jobId)
    this.notify()
    return view
  }

  /** 停止阅读、撤权或退出账号时取消全部排队/运行中的转写。 */
  cancelAllAsr(reason: 'cancelled' | 'interrupted' = 'cancelled'): void {
    this.asr.cancelAll(reason)
    for (const job of this.asr.recent(40)) {
      if (job.state !== 'cancelled' && job.state !== 'interrupted') continue
      const record = this.reading.get(job.bvid, Math.max(0, job.partIndex - 1))
      if (record === null) continue
      this.reading.update(job.bvid, Math.max(0, job.partIndex - 1), {
        asr: {
          jobId: job.id,
          state: job.state,
          model: job.model,
          submittedAt: job.queuedAt,
          finishedAt: job.finishedAt,
          chars: job.chars,
          errorCode: job.errorCode
        }
      })
    }
    this.finalizeReport()
    this.notify()
  }

  private handleAsrFinished(job: BiliAsrJobView): void {
    const owner = this.asrAccounts.get(job.id)
    if (owner !== undefined) this.asrAccounts.delete(job.id)
    if (owner !== undefined && owner !== this.reading.currentAccountKey) return
    const record = this.reading.get(job.bvid, Math.max(0, job.partIndex - 1))
    if (record !== null) {
      this.reading.update(job.bvid, Math.max(0, job.partIndex - 1), {
        asr: {
          jobId: job.id,
          state: job.state,
          model: job.model,
          submittedAt: job.queuedAt,
          finishedAt: job.finishedAt,
          chars: job.chars,
          errorCode: job.errorCode
        }
      })
    }
    this.finalizeReport()
    try {
      this.onAsrTerminal(job)
    } catch {
      /* 唤醒回调不能影响队列 */
    }
    this.notify()
  }

  // ------------------------------------------------------------------ 日报

  finalizeReport(date?: string): {
    ok: boolean
    summary: BiliReportSummary
    error: string | null
  } {
    const cfg = this.config().worlds.bilibili
    const day = date ?? localDateKey(this.now())
    const result = this.reading.rebuildReport(day, {
      enabled: cfg.report.enabled,
      today: localDateKey(this.now())
    })
    if (result.error !== null) {
      this.logger.warn('B 站日报写入失败', { message: result.error })
    }
    this.notify()
    return { ok: result.ok, summary: result.summary, error: result.error }
  }

  reportSummary(date?: string): BiliReportSummary {
    const cfg = this.config().worlds.bilibili
    return this.reading.summary(date ?? localDateKey(this.now()), cfg.report.enabled)
  }

  readingView(date?: string): BiliReadingView {
    return this.reading.readingView(date ?? localDateKey(this.now()))
  }

  readingGet(bvid: string, partIndex: number): BiliReadingRecord | null {
    return this.reading.get(bvid, partIndex)
  }

  readingEnsure(input: {
    bvid: string
    partIndex: number
    cid?: number | null
    title: string
    author: string
    durationSec?: number | null
    origin: 'recommend' | 'search' | 'open'
    query?: string | null
  }): BiliReadingRecord {
    return this.reading.ensure(input)
  }

  readingUpdate(
    bvid: string,
    partIndex: number,
    patch: Parameters<BiliReadingStore['update']>[2]
  ): BiliReadingRecord | null {
    return this.reading.update(bvid, partIndex, patch)
  }

  /** 发现保存后用稳定 discoveryId 关联阅读记录，删除发现时才能同步清理。 */
  linkReadingDiscovery(discoveryId: string, bvid: string, partIndex: number): void {
    const record = this.reading.get(bvid, partIndex)
    if (record === null) return
    this.reading.update(bvid, partIndex, { discoveryId })
    this.finalizeReport(record.explorationDate)
    if (record.completedDate !== null && record.completedDate !== record.explorationDate) {
      this.finalizeReport(record.completedDate)
    }
  }

  async openReport(): Promise<BiliReportOpenResult> {
    const cfg = this.config().worlds.bilibili
    if (!cfg.report.enabled) {
      return { ok: false, message: '日报已在设置中关闭。', path: null }
    }
    const result = this.finalizeReport()
    const summary = result.summary
    if (result.error !== null) {
      return { ok: false, message: result.error, path: null }
    }
    if (summary.markdown === '') {
      return { ok: false, message: '今天还没有可生成的日报。', path: null }
    }
    if (summary.path === null) {
      if (this.reading.memoryOnly) {
        return {
          ok: false,
          message: '记忆关闭时日报只存在内存中，不会落盘；可在设置页查看内容。',
          path: null
        }
      }
      return {
        ok: false,
        message: result.error ?? '日报尚未成功写入，请稍后重试。',
        path: null
      }
    }
    const openPath = this.opts.openPath
    if (openPath === undefined) {
      return { ok: false, message: '当前环境无法打开日报文件。', path: summary.path }
    }
    const error = await openPath(summary.path)
    return error === ''
      ? { ok: true, message: `已打开今天的日报：${summary.path}`, path: summary.path }
      : { ok: false, message: `无法打开日报（${error}）。`, path: summary.path }
  }

  async openReportFolder(): Promise<BiliReportOpenResult> {
    const dir = reportAccountDir(this.paths, this.reading.currentAccountKey)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return { ok: false, message: '无法创建日报目录。', path: null }
    }
    const openPath = this.opts.openPath
    if (openPath === undefined) {
      return { ok: false, message: '当前环境无法打开日报目录。', path: dir }
    }
    const error = await openPath(dir)
    return error === ''
      ? { ok: true, message: `已打开日报目录：${dir}`, path: dir }
      : { ok: false, message: `无法打开日报目录（${error}）。`, path: dir }
  }

  /** 发现删除/清空后调用；重建受影响日期的日报。 */
  removeReadingByDiscoveryIds(ids: readonly string[]): void {
    const dates = this.reading.removeByDiscoveryIds(ids)
    for (const date of dates) this.finalizeReport(date)
    this.notify()
  }

  /** 设置页「清空本地数据」：删除当前账号的全部阅读记录与对应日报。 */
  clearReading(): void {
    this.asr.cancelAll('cancelled')
    const dates = this.reading.clear()
    for (const date of dates) this.finalizeReport(date)
    this.notify()
  }

  removeReadingByText(terms: readonly string[]): void {
    const dates = this.reading.removeByText(terms)
    for (const date of dates) this.finalizeReport(date)
    this.notify()
  }

  recordReadingFailure(code: BiliReadFailureCode): void {
    this.reading.noteFailure(code)
    this.notify()
  }

  // ------------------------------------------------------------------ 配置/状态

  private config(): AppConfig {
    return this.opts.getConfig()
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private memoryEnabled(): boolean {
    return this.config().memory.enabled
  }

  private applyReadingConfig(): void {
    const cfg = this.config()
    this.reading.setMemoryEnabled(cfg.memory.enabled)
    this.reading.setRetentionDays(cfg.worlds.bilibili.report.retentionDays)
  }

  private scriptPath(): string {
    return join(this.opts.resourcesDir, 'mcp_server.py')
  }

  private phase(cfg: AppConfig['worlds']['bilibili'], environment: BiliEnvironmentView, login: BiliLoginView): BiliPhase {
    if (!cfg.enabled) return 'disabled'
    if (cfg.consentAt === null) return 'missing-consent'
    if (!environment.pythonFound) return 'env-missing'
    if (
      environment.service.state === 'installing' ||
      environment.asr.state === 'installing' ||
      environment.model.state === 'installing'
    ) {
      return 'installing'
    }
    if (environment.service.state !== 'ready') return 'env-missing'
    if (
      login.state === 'unlogged' ||
      login.state === 'expired' ||
      login.state === 'session-expired' ||
      login.state === 'error'
    ) {
      return 'login-required'
    }
    if (this.isStopped()) return 'stopped'
    if (this.state === 'failed') return 'fault'
    if (this.state === 'starting') return 'starting'
    if (this.state === 'ready') return 'ready'
    return 'starting'
  }

  private recordFailure(code: BiliReadFailureCode, stage: BiliFailureStage, error: unknown): void {
    const message =
      error instanceof Error && error.message.trim() !== ''
        ? sanitizeMessage(error.message)
        : null
    const failure = biliFailure(code, stage, {
      message,
      retryable:
        error instanceof BiliMcpError
          ? error.retryable
          : code === 'service-crashed' || code === 'timeout' || code === 'network'
    })
    this.lastFailureValue = failure
    this.recentFailures.push(failure)
    if (this.recentFailures.length > 10) this.recentFailures.shift()
    this.notify()
  }

  private notify(): void {
    try {
      this.onChanged()
    } catch {
      /* 状态监听不能影响服务 */
    }
  }

  /** 退出：终止服务、转写与轮询，清理临时音频；不删除阅读记录/日报。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimers()
    this.abortActiveCalls()
    this.login.dispose()
    this.environment.dispose()
    this.asr.cancelAll('interrupted')
    this.asr.dispose()
    this.reading.flush()
    void this.client.stop().catch(() => undefined)
    this.state = 'stopped'
  }
}

function defaultSession(): BiliSessionView {
  return {
    active: false,
    runId: null,
    startedAt: null,
    toolCalls: 0,
    maxToolCalls: 0,
    details: 0,
    maxDetails: 0,
    candidatesSeen: 0,
    stoppedUntil: null,
    cooldownReason: null,
    lastFailure: null
  }
}

function accountKeyFor(uid: string | null): string {
  return accountPartition(uid, (value) => createHash('sha256').update(value).digest('hex'))
}

function stageForCode(code: BiliReadFailureCode): BiliFailureStage {
  switch (code) {
    case 'login-required':
    case 'login-expired':
    case 'qrcode-expired':
    case 'login-cancelled':
      return 'login'
    case 'service-not-installed':
    case 'service-start-failed':
    case 'service-crashed':
    case 'python-missing':
      return 'service'
    case 'network':
    case 'timeout':
    case 'risk-control':
    case 'captcha':
      return 'network'
    case 'no-subtitle':
      return 'subtitle'
    case 'no-candidates':
      return 'parse'
    case 'vision-unavailable':
      return 'vision'
    case 'asr-disabled':
    case 'asr-not-installed':
    case 'asr-model-missing':
    case 'asr-limit':
    case 'asr-failed':
    case 'asr-empty':
      return 'asr'
    case 'report-failed':
      return 'report'
    case 'cancelled':
    case 'stopped':
      return 'cancel'
    case 'parse-failed':
    case 'not-found':
    case 'video-unavailable':
      return 'parse'
    case 'budget':
    case 'cooldown':
    case 'no-session':
    case 'evidence-insufficient':
    case 'exploration-off':
    case 'disabled':
    case 'no-consent':
      return 'budget'
    default:
      return 'unknown'
  }
}

function sanitizeMessage(message: string): string {
  return message
    .replace(/(SESSDATA|bili_jct|buvid3|dedeuserid)=([^&\s;]+)/gi, '$1=<redacted>')
    .replace(/\?[^\s)]{8,}/g, '?<query>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

