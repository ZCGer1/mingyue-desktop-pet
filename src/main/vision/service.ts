import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { AppConfig } from '../../shared/config'
import type { Logger } from '../../core/types'
import type { ActivityCategory } from '../../worlds/activity/types'
import type {
  SceneCaptureQuality,
  SceneCategory,
  SceneDescriptor,
  SceneEvidenceSource,
  SceneFrameInfo,
  ScenePhase,
  SceneProvider,
  SceneSemanticStatus,
  SceneStatus,
  SceneTimings
} from '../../worlds/activity/scene'
import { sceneLabel } from '../../worlds/activity/scene'
import {
  captureScreen,
  listCaptureDisplays,
  type CaptureDisplayInfo,
  type ScreenCapture
} from './capture'
import { classifyScene, normalizeOcrText } from './classify'
import { frameChangeScore, frameQuality, sampleFrame, type FrameSample } from './frames'
import type { WindowsOcr } from './ocr'
import { PhaseTracker, type PhaseObservation } from '../../worlds/activity/scenePhase'
import {
  hasScreenShareConsent,
  SemanticInterpreter,
  type SemanticPreviousSummary,
  type SemanticRequest,
  type SemanticResult
} from './semantic'

export interface VisionForegroundContext {
  /** 前台窗口所在屏幕的物理像素矩形。 */
  bounds: { x: number; y: number; width: number; height: number } | null
  /** 可共享的游戏显示名；未允许共享应用名时为 null。 */
  game: string | null
  /**
   * 前台窗口的不透明身份（ActivityWorld 对进程名 + 真实 HWND 的哈希）。
   * 只在本机内存使用；不进入事件、日志或模型上下文。
   */
  windowKey: string | null
}

export interface VisionServiceOptions {
  getConfig: () => AppConfig
  logger: Logger
  /** 本地 OCR 是可选降级；组件缺失时为 null，不影响主模型识图。 */
  ocr: WindowsOcr | null
  getPetWindow?: () => BrowserWindow | null
  /** 当前前台类别（本地抽象）；无法得知时返回 null。 */
  currentCategory: () => ActivityCategory | null
  /** 前台窗口矩形、游戏显示名与真实窗口身份；只在本机使用。 */
  foregroundContext?: () => VisionForegroundContext | null
  /**
   * 当前是否必须停止采集。由 ActivityWorld 提供：用户暂停观察、锁屏、
   * 挂起或敏感应用。Core 忙、审批、静音、无键鼠输入都不应出现在这里。
   */
  captureBlockedReason?: () => string | null
  getApiKey?: () => string | null
  fetchImpl?: typeof fetch
  isSensitive?: () => boolean
  /** CUA 正在输入时让出截图资源，避免与操作后的截图竞争。 */
  isCuaBusy?: () => boolean
  /** 桌宠/设置页自己在前台时跳过，避免观察自身形成反馈循环。 */
  isSelfForeground?: () => boolean
  /** 摘要失效时通知 ActivityWorld；传原因但绝不含画面内容。 */
  onSceneInvalidated?: (reason: string) => void
  onDegraded?: (reason: string) => void
  now?: () => number
  rng?: () => number
  /** 测试注入；默认使用 Electron 采集。 */
  capture?: (
    options: NonNullable<Parameters<typeof captureScreen>[0]>
  ) => Promise<ScreenCapture>
  listDisplays?: () => CaptureDisplayInfo[]
  /** 测试注入语义解释器；null 表示不可用。 */
  semantic?: SemanticInterpreter | null
}

const MIN_SAMPLE_MS = 60_000
const MAX_STATIC_SAMPLE_MS = 120_000
/** 连续 3 次有效采样没有明显变化后降到 120 秒档。 */
const STATIC_AFTER = 3
const DISABLED_RETRY_MS = 30_000
const BLOCKED_RETRY_MS = 15_000
const CUA_RETRY_MS = 10_000
const MODEL_UNAVAILABLE_RETRY_MS = 30_000
const CAPTURE_BACKOFF_MS = [15_000, 60_000, 180_000, 600_000]
const FAILURE_STREAK_LIMIT = 3
/** 摘要有效期从截图时间算起；120 秒静态档会短暂显示过期，这是正常的。 */
const SUMMARY_TTL_MS = 90_000
/** 采集时间早于现在太久的帧不能当成新证据。 */
const STALE_FRAME_MS = 10_000
/** 相对“上次成功解释画面”的变化阈值。 */
const CHANGE_THRESHOLD = 0.12
/** “下一帧刷新一次摘要”的一次性需求的存活时间；过期即重新评估。 */
const SUMMARY_REFRESH_TTL_MS = 5 * 60_000
/** 重复请求合并窗口，避免安静陪伴计时器反复排入同一需求。 */
const SUMMARY_REFRESH_DEDUPE_MS = 30_000

interface SemanticRequestRecord {
  observationId: string
  capturedAt: number
  expiresAt: number
  targetKey: string
  windowKey: string
  displayId: string
  generation: number
  sample: FrameSample
  quality: SceneCaptureQuality
  category: SceneCategory
  appLabel: string
  gameHint: string | null
}

interface TickOutcome {
  ok: boolean
  reason: string | null
}

/**
 * 连续场景感知。
 *
 * - 严格跟随前台窗口所在显示器的整屏；目标无法确认时跳过，绝不改拍光标屏。
 * - 基础周期 60 秒；连续静态后 120 秒；窗口切换恢复基础节奏且不立即补拍。
 * - 单帧即可请求视觉模型；不再保留视频式帧环。原始 JPEG 只存在于正在
 *   提交的请求里，不写盘、不记录日志。
 * - 模型不可用时，只有用户显式开启本地 OCR 降级才运行本地分类；否则
 *   保留前台粗分类并明确标注来源。
 */
export class VisionService implements SceneProvider {
  private readonly opts: VisionServiceOptions
  private readonly now: () => number
  private readonly rng: () => number
  private readonly capture: NonNullable<VisionServiceOptions['capture']>
  private readonly listDisplays: () => CaptureDisplayInfo[]
  private readonly semantic: SemanticInterpreter | null

  private onScene: ((scene: SceneDescriptor) => void) | null = null
  private onError: ((error: Error) => void) | null = null
  private timer: NodeJS.Timeout | null = null
  private nextCheckAt: number | null = null
  private running = false
  private tickInFlight = false
  private observePromise: Promise<TickOutcome> | null = null
  private paused = false

  private blockedReason: string | null = null
  private skipReason: string | null = null
  private lastError: string | null = null
  private quality: SceneCaptureQuality | null = null
  private captureHealthy = true
  private captureFailures = 0
  private degradedNotified = false

  private intervalMs = MIN_SAMPLE_MS
  private lastSampleStartAt = 0
  private lastFrameAt: number | null = null
  private lastFrameInfo: SceneFrameInfo | null = null
  private framesCaptured = 0
  private requestsSent = 0
  private captureTimes: number[] = []
  private staticStreak = 0

  private previousSample: FrameSample | null = null
  private lastInterpretedSample: FrameSample | null = null
  private lastTargetKey = ''
  private targetDisplayId: string | null = null
  private targetKind: SceneStatus['targetKind'] = null
  private targetHasModelSummary = false
  /** 一次性“下一次正常采样也请求摘要”需求；不等同于手动采样。 */
  private summaryRefreshRequestedAt: number | null = null
  private lastModelSummaryAt: number | null = null
  private lastModelEvidenceAt = 0
  private lastModelSummary: SemanticPreviousSummary | null = null
  private foregroundFallbackTarget = ''
  private lastForegroundFallbackAt = 0

  private phaseTracker = new PhaseTracker()
  private lastPhase: ScenePhase | null = null
  private lastGame: string | null = null
  private lastCategory: SceneCategory | null = null
  private lastActivity: string | null = null
  private lastConfidence: number | null = null
  private lastDescriptorAt: number | null = null
  private lastEvidenceSource: SceneEvidenceSource | null = null

  private ocrAvailable: boolean | null = null
  private ocrFailures = 0
  private ocrNextAllowedAt = 0
  private lastSnippet: string | null = null
  private probing = false

  private timings: SceneTimings | null = null
  private lastSemanticLatencyMs: number | null = null
  private sceneVersion = 0
  private observationCounter = 0
  private generation = 0
  private providerSignature = ''
  private lastEnabled = false
  private lastShareConsent = false
  private records = new Map<string, SemanticRequestRecord>()

  constructor(opts: VisionServiceOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
    this.rng = opts.rng ?? Math.random
    this.capture = opts.capture ?? captureScreen
    this.listDisplays = opts.listDisplays ?? listCaptureDisplays
    if (opts.semantic !== undefined) {
      this.semantic = opts.semantic
    } else if (opts.getApiKey !== undefined) {
      this.semantic = new SemanticInterpreter({
        getConfig: opts.getConfig,
        getApiKey: opts.getApiKey,
        ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
        logger: opts.logger,
        onResult: (result) => this.handleSemanticResult(result),
        ...(opts.now === undefined ? {} : { now: opts.now })
      })
    } else {
      this.semantic = null
    }
    const config = opts.getConfig()
    this.providerSignature = this.computeProviderSignature(config)
    this.lastEnabled = config.worlds.activity.vision.enabled && config.worlds.activity.vision.consentAt !== null
    this.lastShareConsent = hasScreenShareConsent(config)
    this.intervalMs = this.baseInterval()
  }

  start(onScene: (scene: SceneDescriptor) => void, onError: (error: Error) => void): void {
    this.onScene = onScene
    this.onError = onError
    if (this.running) return
    this.running = true
    this.resetObservationState('started', { clearTarget: true, invalidate: false })
    this.semantic?.resume()
    const config = this.opts.getConfig()
    this.lastEnabled = config.worlds.activity.vision.enabled && config.worlds.activity.vision.consentAt !== null
    this.lastShareConsent = hasScreenShareConsent(config)
    this.intervalMs = this.baseInterval()
    this.probeOcr()
    // 应用重启后按基础周期排期，不在启动时集中抢资源；用户首次在本进程内
    // 开启感知时由 refresh() 触发一次反馈观察。
    this.scheduleAt(this.now() + this.intervalMs, false)
  }

  stop(): void {
    this.running = false
    this.paused = false
    this.onScene = null
    this.onError = null
    this.clearTimer()
    this.generation += 1
    this.records.clear()
    this.previousSample = null
    this.lastInterpretedSample = null
    this.lastFrameInfo = null
    this.lastSnippet = null
    this.lastModelSummary = null
    this.timings = null
    this.semantic?.stop()
  }

  refresh(): void {
    if (!this.running) return
    const config = this.opts.getConfig()
    const vision = config.worlds.activity.vision
    const enabled = config.worlds.activity.enabled && vision.enabled && vision.consentAt !== null
    const share = hasScreenShareConsent(config)
    const signature = this.computeProviderSignature(config)
    const becameEnabled = enabled && !this.lastEnabled
    const becameDisabled = !enabled && this.lastEnabled
    const shareGranted = share && !this.lastShareConsent
    const shareRevoked = !share && this.lastShareConsent
    const providerChanged = signature !== this.providerSignature
    this.providerSignature = signature
    this.lastEnabled = enabled
    this.lastShareConsent = share

    if (vision.ocrFallback !== true) this.lastSnippet = null
    if (vision.ocrFallback === true && this.ocrAvailable === null) this.probeOcr()

    if (becameDisabled) {
      this.clearTimer()
      this.resetObservationState('observation-disabled', { clearTarget: true, invalidate: true })
      this.blockedReason = 'observation-disabled'
      this.quality = 'blocked'
      this.scheduleAt(this.now() + DISABLED_RETRY_MS, false)
      return
    }
    if (becameEnabled) {
      this.semantic?.resume()
      this.blockedReason = null
      this.skipReason = null
      this.resetObservationState('observation-enabled', { clearTarget: true, invalidate: true })
      this.scheduleAt(this.now() + 500, false)
      return
    }
    if (!enabled) {
      this.clearTimer()
      this.scheduleAt(this.now() + DISABLED_RETRY_MS, false)
      return
    }

    if (shareRevoked) {
      this.resetObservationState('share-revoked', { clearTarget: false, invalidate: true })
      this.scheduleAt(Math.max(this.now() + 1_000, this.lastSampleStartAt + this.baseInterval()), false)
      return
    }
    if (shareGranted) {
      // 新的整屏共享范围刚被明确同意：先做一次反馈观察。
      this.resetObservationState('share-granted', { clearTarget: false, invalidate: true })
      this.scheduleAt(this.now() + 500, false)
      return
    }
    if (providerChanged) {
      // 配置修正后清除“不支持图片/退避”等旧状态，重新探测。
      this.semantic?.resetCapability()
      this.resetObservationState('provider-changed', { clearTarget: false, invalidate: true })
      this.scheduleAt(this.now() + 1_000, false)
      return
    }

    this.intervalMs = this.currentInterval()
    if (this.paused) return
    if (this.blockedReason !== null) {
      if (this.timer === null) this.scheduleAt(this.now() + BLOCKED_RETRY_MS, false)
      return
    }
    const due =
      this.lastSampleStartAt > 0
        ? Math.max(this.now() + 1_000, this.lastSampleStartAt + this.intervalMs)
        : this.now() + this.intervalMs
    // 配置变慢/变快时重排；不允许重排把下一次采样压到最小间隔之前。
    this.scheduleAt(due, false)
  }

  /**
   * ActivityWorld 发现前台窗口身份或几何变化时调用。
   * `window`：身份变化，旧摘要立即失效；`bounds`：只提前下一次检查，
   * 等实际采样确认是否换了显示器，不先作废可能仍然有效的摘要。
   */
  targetChanged(kind: 'window' | 'bounds' = 'window'): void {
    if (!this.running || this.paused) return
    if (kind === 'window') {
      this.resetObservationState('target-changed', { clearTarget: true, invalidate: true })
      this.skipReason = '等待重新确认前台目标'
    }
    this.accelerateCheck()
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    this.clearTimer()
    this.resetObservationState('paused', { clearTarget: true, invalidate: true })
    this.blockedReason = 'paused'
    this.quality = 'blocked'
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.blockedReason = null
    this.skipReason = null
    this.resetObservationState('resumed', { clearTarget: true, invalidate: true })
    this.semantic?.resume()
    if (this.running) this.scheduleAt(this.now() + 500, false)
  }

  async observeNow(): Promise<{ ok: boolean; reason: string | null }> {
    if (this.observePromise !== null) {
      const pending = await this.observePromise
      return { ok: pending.ok, reason: pending.reason }
    }
    const promise = this.tick(true)
    this.observePromise = promise
    try {
      const result = await promise
      return { ok: result.ok, reason: result.reason }
    } finally {
      if (this.observePromise === promise) this.observePromise = null
    }
  }

  /**
   * 请求在下一次正常采样点重新请求一次摘要。只设置一次性需求，不额外
   * 截图、不缩短 60/120 秒节奏，也不绕过授权/敏感/锁屏阻断。
   */
  requestSummaryRefresh(): boolean {
    const config = this.opts.getConfig()
    const activity = config.worlds.activity
    const vision = activity.vision
    if (!this.running || this.paused) return false
    if (!activity.enabled || !vision.enabled || vision.consentAt === null) return false
    if (!hasScreenShareConsent(config)) return false
    if (!this.modelReadiness().ready) return false
    if (this.blockedReason !== null) return false
    const now = this.now()
    if (
      this.summaryRefreshRequestedAt !== null &&
      now - this.summaryRefreshRequestedAt < SUMMARY_REFRESH_DEDUPE_MS
    ) {
      return true
    }
    this.summaryRefreshRequestedAt = now
    return true
  }

  status(): SceneStatus {
    const config = this.opts.getConfig()
    const vision = config.worlds.activity.vision
    this.pruneCaptureTimes()
    const semantic = this.semantic?.status() ?? emptySemanticStatus()
    return {
      enabled: vision.enabled && vision.consentAt !== null,
      available: this.captureHealthy,
      reason: this.blockedReason ?? this.skipReason ?? (this.captureHealthy ? null : this.lastError),
      lastAt: this.lastDescriptorAt,
      lastFrameAt: this.lastFrameAt,
      lastSentAt: semantic.lastSentAt,
      lastInterpretedAt: semantic.lastInterpretedAt,
      lastCategory: this.lastCategory,
      lastActivity: this.lastActivity,
      lastConfidence: this.lastConfidence,
      lastDurationMs: this.timings?.totalMs ?? null,
      lastError: this.lastError,
      framesCaptured: this.framesCaptured,
      framesLastMinute: this.captureTimes.length,
      requestsSent: this.requestsSent,
      bufferFrames: 0,
      frameBufferSeconds: 0,
      targetDisplayId: this.targetDisplayId,
      targetKind: this.targetKind,
      quality: this.quality,
      blockedReason: this.blockedReason,
      paused: this.paused,
      intervalMs: this.intervalMs,
      nextCheckAt: this.nextCheckAt,
      ocrAvailable: this.ocrAvailable,
      ocrFallback: vision.ocrFallback === true,
      phase: this.lastPhase,
      game: this.lastGame,
      evidenceSource: this.lastEvidenceSource,
      revision: this.sceneVersion,
      timings: this.timings === null ? null : { ...this.timings },
      lastFrame: this.lastFrameInfo === null ? null : cloneFrameInfo(this.lastFrameInfo),
      semantic
    }
  }

  /** 设置页诊断用；目标选择本身永远跟随前台窗口，不使用这里的值。 */
  displays(): CaptureDisplayInfo[] {
    try {
      return this.listDisplays()
    } catch {
      return []
    }
  }

  /** 设置页预览可选 OCR 片段；默认配置下为 null，绝不进入日志/模型。 */
  previewSnippet(): string | null {
    if (!this.opts.getConfig().worlds.activity.vision.showOcrSnippet) {
      this.lastSnippet = null
      return null
    }
    return this.lastSnippet
  }

  preview(): string | null {
    return this.previewSnippet()
  }

  clear(): void {
    this.clearTimer()
    this.resetObservationState('cleared', { clearTarget: true, invalidate: true })
    this.lastAtReset()
    this.framesCaptured = 0
    this.requestsSent = 0
    this.captureTimes = []
    this.lastFrameAt = null
    this.lastError = null
    this.skipReason = null
    this.captureFailures = 0
    this.captureHealthy = true
    this.degradedNotified = false
    this.quality = null
    this.timings = null
    this.lastSemanticLatencyMs = null
    this.ocrNextAllowedAt = 0
    this.semantic?.clear()
    if (this.running && !this.paused) {
      if (this.blockedReason !== null && this.blockedReason !== 'paused') {
        this.scheduleAt(this.now() + BLOCKED_RETRY_MS, false)
      } else {
        this.intervalMs = this.baseInterval()
        this.scheduleAt(this.now() + this.intervalMs, false)
      }
    }
  }

  // ------------------------------------------------------------------ 调度

  private async tick(manual: boolean): Promise<TickOutcome> {
    if (!this.running) return { ok: false, reason: 'not-running' }
    if (this.paused) return { ok: false, reason: 'paused' }
    if (this.tickInFlight) return { ok: false, reason: 'in-flight' }
    this.tickInFlight = true
    this.clearTimer()
    this.nextCheckAt = null
    const started = this.now()
    const startGeneration = this.generation
    try {
      const config = this.opts.getConfig()
      const activity = config.worlds.activity
      const vision = activity.vision
      if (!activity.enabled || !vision.enabled || vision.consentAt === null) {
        this.setBlocked('observation-disabled')
        this.scheduleAt(this.now() + DISABLED_RETRY_MS, false)
        return { ok: false, reason: 'observation-disabled' }
      }

      const external = this.externalBlockedReason()
      if (external !== null) {
        this.handleBlocked(external)
        this.scheduleAt(
          this.now() + (external === 'activity-disabled' ? DISABLED_RETRY_MS : BLOCKED_RETRY_MS),
          false
        )
        return { ok: false, reason: external }
      }
      this.clearBlocked()

      if (this.opts.currentCategory() === 'meeting') {
        // 会议画面常含他人隐私，沿用原有的保守阻断；不因为模型能力增强而放开。
        this.handleBlocked('meeting')
        this.scheduleAt(this.now() + BLOCKED_RETRY_MS, false)
        return { ok: false, reason: 'meeting' }
      }

      if (this.opts.isCuaBusy?.() === true) {
        // 让出资源；不取消当前摘要，只在状态里说明并很快重试。
        this.blockedReason = 'cua-busy'
        this.skipReason = 'cua-busy'
        this.quality = 'blocked'
        this.scheduleAt(this.now() + CUA_RETRY_MS, false)
        return { ok: false, reason: 'cua-busy' }
      }
      if (this.opts.isSelfForeground?.() === true) {
        const reason = 'self-foreground'
        this.handleBlocked(reason)
        this.scheduleAt(this.now() + BLOCKED_RETRY_MS, false)
        return { ok: false, reason }
      }

      if (vision.ocrFallback === true && this.ocrAvailable === null) void this.probeOcr()

      const model = this.modelReadiness()
      const ocrUsable = this.ocrUsable()
      if (!model.ready && !ocrUsable) {
        const reason = model.reason ?? '视觉模型不可用'
        this.skipReason = reason
        this.noteForegroundOnlyFallback()
        this.scheduleAt(this.now() + MODEL_UNAVAILABLE_RETRY_MS, false)
        return { ok: false, reason }
      }

      const foreground = this.foregroundContext()
      if (foreground === null || foreground.bounds === null || foreground.windowKey === null) {
        const reason = 'foreground-unknown'
        this.handleBlocked(reason)
        this.skipReason = '无法确认前台窗口所在显示器'
        this.scheduleAt(this.now() + BLOCKED_RETRY_MS, false)
        return { ok: false, reason: 'foreground-unknown' }
      }

      this.lastSampleStartAt = started
      const captureStarted = this.now()
      let shot: ScreenCapture
      try {
        shot = await this.capture({
          getPetWindow: this.opts.getPetWindow,
          maxWidth: 1280,
          format: 'jpeg',
          jpegQuality: 70,
          includeBitmap: true,
          targetBounds: foreground.bounds,
          requireTarget: true,
          purpose: 'ambient',
          targetKey: `fg:${foreground.windowKey}`
        })
      } catch (error) {
        this.noteCaptureFailure(error)
        return { ok: false, reason: this.lastError }
      }
      const captureMs = this.now() - captureStarted
      if (!this.running) return { ok: false, reason: 'stopped' }
      if (this.paused) {
        this.scheduleAt(this.now() + BLOCKED_RETRY_MS, false)
        return { ok: false, reason: 'paused' }
      }
      if (this.generation !== startGeneration) {
        // 采集期间发生了暂停、清除、目标切换或配置变化；这帧不属于当前世代。
        this.skipReason = '观察状态已变化'
        this.scheduleNextSample(started)
        return { ok: false, reason: 'generation-changed' }
      }
      if (shot.purpose !== 'ambient' || shot.targetKind !== 'foreground-window') {
        this.lastError = '采集没有绑定前台窗口所在显示器，已丢弃'
        this.skipReason = 'target-mismatch'
        this.scheduleNextSample(started)
        return { ok: false, reason: 'target-mismatch' }
      }
      if (shot.bitmap === null) {
        this.lastError = '截图没有返回位图数据'
        this.skipReason = 'capture-incomplete'
        this.scheduleNextSample(started)
        return { ok: false, reason: 'capture-incomplete' }
      }
      const now = this.now()
      if (!Number.isFinite(shot.capturedAt) || now - shot.capturedAt > STALE_FRAME_MS) {
        this.lastError = '采集帧过旧，已丢弃'
        this.skipReason = 'stale-frame'
        this.scheduleNextSample(started)
        return { ok: false, reason: 'stale-frame' }
      }

      // 截图期间目标可能已经切换：重新核对身份、几何与授权，旧帧直接丢弃。
      const postForeground = this.foregroundContext()
      if (
        postForeground === null ||
        postForeground.windowKey !== foreground.windowKey ||
        postForeground.bounds === null ||
        !sameBounds(postForeground.bounds, foreground.bounds)
      ) {
        this.resetObservationState('target-changed-during-capture', {
          clearTarget: true,
          invalidate: true
        })
        this.skipReason = 'target-changed'
        this.scheduleNextSample(started)
        return { ok: false, reason: 'target-changed' }
      }
      if (this.externalBlockedReason() !== null) {
        const reason = this.externalBlockedReason() ?? 'capture-state-changed'
        this.handleBlocked(reason)
        this.scheduleAt(this.now() + BLOCKED_RETRY_MS, false)
        return { ok: false, reason }
      }

      const targetKey = `fg:${foreground.windowKey}@${shot.displayId}`
      if (this.lastTargetKey !== '' && this.lastTargetKey !== targetKey) {
        this.resetObservationState('target-changed', { clearTarget: true, invalidate: true })
      }
      this.lastTargetKey = targetKey
      this.targetDisplayId = shot.displayId
      this.targetKind = 'foreground-window'

      const signatureStarted = this.now()
      const sample = sampleFrame(shot.bitmap, shot.width, shot.height)
      const quality = frameQuality(this.previousSample, sample)
      const previous = this.previousSample
      const changedVsPrevious = previous !== null && !quality.static
      this.staticStreak =
        previous === null ? 0 : changedVsPrevious ? 0 : this.staticStreak + 1
      this.previousSample = sample
      const signatureMs = this.now() - signatureStarted

      this.lastFrameAt = shot.capturedAt
      this.framesCaptured += 1
      this.captureTimes.push(shot.capturedAt)
      this.pruneCaptureTimes()
      this.captureFailures = 0
      this.captureHealthy = true
      this.degradedNotified = false
      this.lastError = null
      this.lastFrameInfo = {
        at: shot.capturedAt,
        sourceId: shot.sourceId,
        displayId: shot.displayId,
        width: shot.width,
        height: shot.height,
        // 被动观察发送整块显示器；整幅图就是观察范围，不做窗口裁剪。
        validRegion: { x: 0, y: 0, width: shot.width, height: shot.height },
        visible: quality.quality !== 'black',
        quality: quality.quality === 'black' ? 'black' : sample.lowResolution ? 'low' : quality.static ? 'static' : 'good'
      }
      const qualityValue = this.lastFrameInfo.quality
      this.quality = qualityValue
      this.timings = {
        captureMs,
        signatureMs,
        semanticMs: this.lastSemanticLatencyMs,
        totalMs: null
      }

      if (quality.quality === 'black') {
        this.lastError = '画面黑屏或受保护内容'
        this.skipReason = 'black-frame'
        // 黑屏/受保护内容不能当作有效画面；退回前台粗分类，并保留 black
        // 画质让 ActivityWorld 把这条场景标记为 stale。
        this.noteForegroundOnlyFallback('black')
        this.scheduleNextSample(started)
        return { ok: false, reason: 'black-frame' }
      }

      const changedVsInterpreted =
        this.lastInterpretedSample === null ||
        frameChangeScore(this.lastInterpretedSample, sample) >= CHANGE_THRESHOLD
      const firstForTarget = !this.targetHasModelSummary
      const refreshRequested =
        this.summaryRefreshRequestedAt !== null &&
        now - this.summaryRefreshRequestedAt <= SUMMARY_REFRESH_TTL_MS
      if (this.summaryRefreshRequestedAt !== null && !refreshRequested) {
        this.summaryRefreshRequestedAt = null
      }
      // 需求只在正常 tick 内生效：不额外截图，也不因“安静陪伴到点”而
      // 绕过变化检测去抢拍；画质/目标/授权阻断仍然优先。
      const shouldRequest =
        model.ready && (manual || firstForTarget || changedVsInterpreted || refreshRequested)

      if (shouldRequest) {
        const jpeg = shot.jpeg
        if (jpeg === null || jpeg.length === 0) {
          this.lastError = '截图为空，未发送给模型'
          this.skipReason = 'empty-frame'
          this.scheduleNextSample(started)
          return { ok: false, reason: 'empty-frame' }
        }
        // 发送前最后一次核对目标与授权；之后才把帧交给独立识图请求。
        const sendForeground = this.foregroundContext()
        if (
          sendForeground === null ||
          sendForeground.windowKey !== foreground.windowKey ||
          this.externalBlockedReason() !== null
        ) {
          this.resetObservationState('target-changed-before-send', {
            clearTarget: true,
            invalidate: true
          })
          this.skipReason = 'target-changed'
          this.scheduleNextSample(started)
          return { ok: false, reason: 'target-changed' }
        }
        const category = this.opts.currentCategory()
        const base = classifyScene({ text: '', category, at: shot.capturedAt })
        const observationId = this.nextObservationId()
        const expiresAt = shot.capturedAt + SUMMARY_TTL_MS
        const request: SemanticRequest = {
          observationId,
          capturedAt: shot.capturedAt,
          expiresAt,
          targetKey,
          generation: this.generation,
          category: base.category,
          appLabel: base.appLabel,
          gameHint: category === 'game' ? foreground.game : null,
          localPhase: this.phaseTracker.current().phase,
          frame: { jpeg, at: shot.capturedAt },
          previous: this.lastModelSummary,
          // 只有真正开始 HTTP 请求才计数；排队后被替换的候选不算“已发送”。
          onSent: () => {
            this.requestsSent += 1
          }
        }
        this.records.set(observationId, {
          observationId,
          capturedAt: shot.capturedAt,
          expiresAt,
          targetKey,
          windowKey: foreground.windowKey,
          displayId: shot.displayId,
          generation: this.generation,
          sample,
          quality: qualityValue,
          category: base.category,
          appLabel: base.appLabel,
          gameHint: category === 'game' ? foreground.game : null
        })
        this.pruneRecords(now)
        this.semantic?.submit(request)
        this.summaryRefreshRequestedAt = null
        this.skipReason = null
      } else if (!model.ready && ocrUsable) {
        if (!this.hasFreshModelSummary(now)) {
          const ran = await this.runOcrFallback(
            shot,
            sample,
            qualityValue,
            foreground,
            quality.static
          )
          this.skipReason = ran ? null : (this.lastError ?? '本地 OCR 未返回结果')
        } else {
          this.skipReason = '保留仍有效的模型摘要，等待模型恢复'
        }
      } else {
        this.skipReason = '画面没有明显变化'
      }

      this.intervalMs = this.currentInterval()
      this.scheduleNextSample(started)
      return { ok: true, reason: this.skipReason }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message.slice(0, 300)
      this.reportError(new Error(message))
      if (this.running && this.timer === null) {
        this.scheduleAt(this.now() + BLOCKED_RETRY_MS, false)
      }
      return { ok: false, reason: this.lastError }
    } finally {
      if (this.timings !== null) {
        this.timings = { ...this.timings, totalMs: Math.max(0, this.now() - started) }
      }
      this.tickInFlight = false
    }
  }

  // ------------------------------------------------------------------ 状态/生命周期

  private resetObservationState(
    reason: string,
    opts: { clearTarget: boolean; invalidate: boolean }
  ): void {
    this.generation += 1
    this.semantic?.cancel(reason)
    this.records.clear()
    if (opts.invalidate) this.invalidateScene(reason)
    this.previousSample = null
    this.lastInterpretedSample = null
    this.lastModelSummary = null
    this.lastModelSummaryAt = null
    this.lastModelEvidenceAt = 0
    this.targetHasModelSummary = false
    this.summaryRefreshRequestedAt = null
    this.foregroundFallbackTarget = ''
    this.lastForegroundFallbackAt = 0
    this.staticStreak = 0
    this.intervalMs = this.baseInterval()
    this.phaseTracker.reset()
    this.lastPhase = null
    this.lastGame = null
    this.lastCategory = null
    this.lastActivity = null
    this.lastConfidence = null
    this.lastDescriptorAt = null
    this.lastEvidenceSource = null
    this.lastSnippet = null
    this.quality = null
    if (opts.clearTarget) {
      this.lastTargetKey = ''
      this.targetDisplayId = null
      this.targetKind = null
      this.lastFrameInfo = null
    }
  }

  private lastAtReset(): void {
    this.lastDescriptorAt = null
    this.lastCategory = null
    this.lastActivity = null
    this.lastConfidence = null
    this.lastPhase = null
    this.lastGame = null
    this.lastEvidenceSource = null
  }

  private invalidateScene(reason: string): void {
    // ActivityWorld 在失效时也会推高它自己的 revision；本地版本必须同步前进，
    // 否则下一次有效 descriptor 会被误判为“旧版本”而拒绝。
    this.sceneVersion += 1
    try {
      this.opts.onSceneInvalidated?.(reason.slice(0, 40))
    } catch (error) {
      this.opts.logger.warn('场景失效通知失败', { error: String(error).slice(0, 200) })
    }
  }

  private setBlocked(reason: string): void {
    if (this.blockedReason === reason) return
    this.resetObservationState(reason, { clearTarget: true, invalidate: true })
    this.blockedReason = reason
    this.quality = 'blocked'
    this.skipReason = null
  }

  private handleBlocked(reason: string): void {
    this.setBlocked(reason)
  }

  private clearBlocked(): void {
    if (this.blockedReason === null) return
    this.blockedReason = null
    if (this.quality === 'blocked') this.quality = null
  }

  private externalBlockedReason(): string | null {
    try {
      const reason = this.opts.captureBlockedReason?.() ?? null
      if (reason !== null && reason !== '') return reason
    } catch {
      return 'capture-state-unknown'
    }
    if (this.opts.isSensitive?.() === true) return 'sensitive-app'
    return null
  }

  private foregroundContext(): VisionForegroundContext | null {
    try {
      return this.opts.foregroundContext?.() ?? null
    } catch {
      return null
    }
  }

  private modelReadiness(): { ready: boolean; reason: string | null } {
    const config = this.opts.getConfig()
    if (this.semantic === null) return { ready: false, reason: '视觉模型通路未初始化' }
    if (!hasScreenShareConsent(config)) {
      return { ready: false, reason: '未同意把整屏画面发送给当前聊天模型' }
    }
    if (config.provider.visionInput !== true) {
      return { ready: false, reason: '当前聊天模型未开启图片输入' }
    }
    let apiKey: string | null = null
    try {
      apiKey = this.opts.getApiKey?.() ?? null
    } catch {
      apiKey = null
    }
    if (apiKey === null || apiKey === '') return { ready: false, reason: '没有配置 API Key' }
    const status = this.semantic.status()
    if (!status.available) {
      return { ready: false, reason: status.reason ?? '视觉模型暂不可用' }
    }
    return { ready: true, reason: null }
  }

  private ocrUsable(): boolean {
    return (
      this.opts.getConfig().worlds.activity.vision.ocrFallback === true &&
      this.ocrAvailable === true &&
      this.opts.ocr !== null
    )
  }

  private probeOcr(): void {
    if (this.probing) return
    const ocr = this.opts.ocr
    if (ocr === null) {
      this.ocrAvailable = false
      return
    }
    this.probing = true
    void ocr
      .probe()
      .then((result) => {
        if (!result.ok) {
          this.ocrAvailable = false
          this.opts.logger.warn('本地 OCR 不可用', { reason: result.error ?? '未知原因' })
          return
        }
        if (result.languages.length === 0) {
          this.ocrAvailable = false
          this.opts.logger.warn('本地 OCR 没有可用语言包')
          return
        }
        this.ocrAvailable = true
      })
      .catch((error: unknown) => {
        this.ocrAvailable = false
        this.opts.logger.warn('本地 OCR 探测异常', {
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)
        })
      })
      .finally(() => {
        this.probing = false
      })
  }

  private async runOcrFallback(
    shot: ScreenCapture,
    sample: FrameSample,
    quality: SceneCaptureQuality,
    foreground: VisionForegroundContext,
    isStatic: boolean
  ): Promise<boolean> {
    const ocr = this.opts.ocr
    const jpeg = shot.jpeg
    if (ocr === null || jpeg === null || jpeg.length === 0) return false
    const config = this.opts.getConfig()
    const vision = config.worlds.activity.vision
    const now = this.now()
    if (now < this.ocrNextAllowedAt) return false
    this.ocrNextAllowedAt = now + Math.max(1_000, vision.ocrMinGapMs)
    const generation = this.generation
    const targetKey = this.lastTargetKey
    const windowKey = foreground.windowKey
    let text: string
    try {
      const result = await ocr.recognize(jpeg, vision.language, 8_000)
      if (!result.ok) {
        this.noteOcrFailure(result.error)
        return false
      }
      text = result.text
      this.ocrFailures = 0
      this.lastSnippet = vision.showOcrSnippet ? text.slice(0, 600) : null
    } catch (error) {
      this.noteOcrFailure(error instanceof Error ? error.message : String(error))
      return false
    }
    // OCR 期间可能已经切换窗口/暂停/撤销；旧识别结果不得回填。
    if (
      !this.running ||
      this.paused ||
      this.generation !== generation ||
      this.lastTargetKey !== targetKey ||
      this.foregroundContext()?.windowKey !== windowKey
    ) {
      return false
    }
    this.lastError = null
    const category = this.opts.currentCategory()
    const classification = classifyScene({ text, category, at: shot.capturedAt })
    const normalized = normalizeOcrText(text).replace(/\s+/g, ' ').trim()
    const phaseObservation = this.phaseTracker.update({
      text: normalized,
      category: classification.category,
      at: shot.capturedAt,
      frameChanged: !isStatic,
      game: foreground.game
    })
    const phase: ScenePhase =
      classification.category === 'gaming' ? phaseObservation.phase : 'unknown'
    const game = classification.category === 'gaming' ? (foreground.game ?? phaseObservation.game) : null
    this.emitDescriptor({
      category: classification.category,
      activity: classification.activity,
      appLabel: classification.appLabel,
      title: null,
      keywords: classification.keywords.slice(0, 6),
      confidence: classification.confidence,
      at: shot.capturedAt,
      game,
      phase,
      previousPhase: phaseObservation.previousPhase,
      detail: phaseObservation.detail,
      change: phaseObservation.change,
      evidenceSource: 'local_ocr',
      quality,
      observationId: this.nextObservationId(),
      sourceId: shot.displayId,
      evidenceAt: shot.capturedAt,
      expiresAt: shot.capturedAt + SUMMARY_TTL_MS,
      revision: this.nextSceneRevision()
    })
    return true
  }

  private noteOcrFailure(message: string): void {
    this.ocrFailures += 1
    this.lastError = message.slice(0, 300)
    if (this.ocrFailures >= FAILURE_STREAK_LIMIT) {
      this.ocrAvailable = false
      if (!this.degradedNotified) {
        this.degradedNotified = true
        this.opts.onDegraded?.(`本地 OCR 连续 ${this.ocrFailures} 次失败`)
      }
    }
  }

  // ------------------------------------------------------------------ 模型结果

  private handleSemanticResult(result: SemanticResult): void {
    const record = this.records.get(result.observationId)
    if (record === undefined) return
    this.records.delete(result.observationId)
    if (result.cancelled) return
    if (record.generation !== this.generation) return
    if (record.targetKey !== this.lastTargetKey) return

    const now = this.now()
    if (now > record.expiresAt || record.capturedAt < this.lastModelEvidenceAt) return
    const current = this.foregroundContext()
    if (current === null || current.windowKey !== record.windowKey) {
      this.resetObservationState('target-changed-before-result', {
        clearTarget: true,
        invalidate: true
      })
      return
    }

    if (!result.ok) {
      // 失败不伪造摘要；仅在没有任何仍有效的摘要时退回前台粗分类。
      if (!this.hasFreshModelSummary(now)) {
        this.emitForegroundFallback(record)
      }
      return
    }

    const category: SceneCategory = result.category ?? record.category
    const phase: ScenePhase =
      category === 'gaming' ? (result.phase ?? 'unknown') : 'unknown'
    const game =
      category === 'gaming' ? (result.game ?? record.gameHint) : null
    const activity = result.activity ?? sceneLabel(category)
    if (category === 'gaming' && result.phase !== null) {
      this.phaseTracker.adopt(result.phase, result.at)
    }
    this.lastSemanticLatencyMs = result.latencyMs
    this.targetHasModelSummary = true
    this.lastModelSummaryAt = record.capturedAt
    this.lastModelEvidenceAt = record.capturedAt
    this.lastInterpretedSample = record.sample
    this.lastModelSummary = {
      activity,
      detail: result.detail,
      at: record.capturedAt
    }
    this.foregroundFallbackTarget = ''
    this.emitDescriptor({
      category,
      activity,
      appLabel: record.appLabel,
      title: null,
      keywords: [],
      confidence: result.confidence,
      at: result.at,
      game,
      phase,
      previousPhase: this.lastPhase,
      detail: result.detail,
      change: result.change,
      evidenceSource: 'vision_model',
      quality: record.quality,
      observationId: record.observationId,
      sourceId: record.displayId,
      evidenceAt: record.capturedAt,
      expiresAt: record.capturedAt + SUMMARY_TTL_MS,
      revision: this.nextSceneRevision()
    })
    this.skipReason = null
  }

  private emitForegroundFallback(record: SemanticRequestRecord): void {
    const now = this.now()
    if (now - this.lastForegroundFallbackAt < 30_000) return
    this.lastForegroundFallbackAt = now
    this.foregroundFallbackTarget = record.windowKey
    this.emitDescriptor({
      category: record.category,
      activity: record.category === 'unknown' ? '在用电脑' : sceneLabel(record.category),
      appLabel: record.appLabel,
      title: null,
      keywords: [],
      confidence: record.category === 'unknown' ? 0.2 : 0.3,
      at: now,
      game: record.category === 'gaming' ? record.gameHint : null,
      phase: 'unknown',
      previousPhase: this.lastPhase,
      // 这不是画面描述，只是“没有拿到视觉摘要”时的前台粗分类；来源字段负责说明。
      detail: null,
      change: null,
      evidenceSource: 'foreground',
      quality: record.quality,
      observationId: record.observationId,
      sourceId: record.displayId,
      evidenceAt: now,
      expiresAt: now + 30_000,
      revision: this.nextSceneRevision()
    })
  }

  /**
   * 没有截图通路可用时保留前台粗分类：不声称看过画面，只给出本地类别，
   * 来源标为 foreground，有效期为 30 秒且每个目标只发一次。
   */
  private noteForegroundOnlyFallback(
    quality: SceneCaptureQuality = 'unavailable'
  ): void {
    const config = this.opts.getConfig()
    const vision = config.worlds.activity.vision
    if (!vision.enabled || vision.consentAt === null) return
    if (quality !== 'black' && this.hasFreshModelSummary(this.now())) return
    const foreground = this.foregroundContext()
    if (foreground === null || foreground.windowKey === null) return
    const now = this.now()
    if (now - this.lastForegroundFallbackAt < 30_000) return
    const category = this.opts.currentCategory()
    if (category === null) return
    const base = classifyScene({ text: '', category, at: now })
    this.lastForegroundFallbackAt = now
    this.foregroundFallbackTarget = foreground.windowKey
    this.emitDescriptor({
      category: base.category,
      activity: base.activity,
      appLabel: base.appLabel,
      title: null,
      keywords: [],
      confidence: Math.min(0.35, base.confidence),
      at: now,
      game: category === 'game' ? foreground.game : null,
      phase: 'unknown',
      previousPhase: this.lastPhase,
      detail: null,
      change: null,
      evidenceSource: 'foreground',
      quality,
      observationId: this.nextObservationId(),
      sourceId: this.targetDisplayId,
      evidenceAt: now,
      expiresAt: now + 30_000,
      revision: this.nextSceneRevision()
    })
  }

  private emitDescriptor(descriptor: SceneDescriptor): void {
    this.lastDescriptorAt = descriptor.at
    this.lastCategory = descriptor.category
    this.lastActivity = descriptor.activity
    this.lastConfidence = descriptor.confidence
    this.lastPhase = descriptor.phase ?? null
    this.lastGame = descriptor.game ?? null
    this.lastEvidenceSource = descriptor.evidenceSource ?? null
    if (descriptor.quality !== undefined) this.quality = descriptor.quality
    this.onSceneSafely(descriptor)
  }

  private hasFreshModelSummary(now: number): boolean {
    return (
      this.lastModelSummaryAt !== null && now - this.lastModelSummaryAt <= SUMMARY_TTL_MS
    )
  }

  // ------------------------------------------------------------------ 采集/调度辅助

  private noteCaptureFailure(error: unknown): void {
    this.captureFailures += 1
    this.captureHealthy = false
    this.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300)
    this.skipReason = 'capture-failed'
    this.quality = 'unavailable'
    this.reportError(error instanceof Error ? error : new Error(this.lastError))
    if (this.captureFailures >= FAILURE_STREAK_LIMIT) {
      if (!this.degradedNotified) {
        this.degradedNotified = true
        this.opts.onDegraded?.(`连续 ${this.captureFailures} 次截图失败`)
      }
      this.scheduleAt(this.now() + CAPTURE_BACKOFF_MS[CAPTURE_BACKOFF_MS.length - 1]!, false)
      return
    }
    this.scheduleAt(
      this.now() + CAPTURE_BACKOFF_MS[Math.min(this.captureFailures - 1, CAPTURE_BACKOFF_MS.length - 1)]!,
      false
    )
  }

  private scheduleNextSample(sampleStartedAt: number): void {
    if (!this.running) return
    const interval = this.currentInterval()
    this.intervalMs = interval
    const due = Math.max(this.now() + 1_000, sampleStartedAt + interval)
    this.scheduleAt(due, true)
  }

  private accelerateCheck(): void {
    if (!this.running || this.paused) return
    if (this.tickInFlight || this.blockedReason !== null) return
    const due = Math.max(
      this.now() + 1_000,
      this.lastSampleStartAt > 0 ? this.lastSampleStartAt + this.baseInterval() : 0
    )
    if (this.nextCheckAt !== null && this.nextCheckAt <= due) return
    this.scheduleAt(due, false)
  }

  private scheduleAt(due: number, jitter: boolean): void {
    if (!this.running) return
    this.clearTimer()
    let actual = due
    if (jitter) {
      // 只向后抖动；任何情况下都不能把采样开始间隔压到最小周期以下。
      actual += Math.floor(this.rng() * Math.min(3_000, this.intervalMs * 0.05))
    }
    const delay = Math.max(250, Math.round(actual - this.now()))
    const at = this.now() + delay
    this.nextCheckAt = at
    this.timer = setTimeout(() => {
      this.timer = null
      this.nextCheckAt = null
      void this.tick(false)
    }, delay)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.nextCheckAt = null
  }

  private baseInterval(): number {
    const vision = this.opts.getConfig().worlds.activity.vision
    return Math.max(MIN_SAMPLE_MS, Math.min(MAX_STATIC_SAMPLE_MS, vision.desktopSampleMs))
  }

  private staticInterval(): number {
    const vision = this.opts.getConfig().worlds.activity.vision
    const base = this.baseInterval()
    return Math.max(base, Math.min(MAX_STATIC_SAMPLE_MS, vision.staticSampleMs))
  }

  private currentInterval(): number {
    return this.staticStreak >= STATIC_AFTER ? this.staticInterval() : this.baseInterval()
  }

  private pruneCaptureTimes(now = this.now()): void {
    const cutoff = now - 60_000
    while (this.captureTimes.length > 0 && this.captureTimes[0]! <= cutoff) this.captureTimes.shift()
  }

  private pruneRecords(now: number): void {
    for (const [id, record] of this.records) {
      if (now > record.expiresAt + 30_000) this.records.delete(id)
    }
    while (this.records.size > 4) {
      const oldest = this.records.keys().next()
      if (oldest.done === true) break
      this.records.delete(oldest.value)
    }
  }

  private nextObservationId(): string {
    this.observationCounter += 1
    return `${this.now().toString(36)}-${this.observationCounter.toString(36)}-${randomUUID().slice(0, 8)}`
  }

  private nextSceneRevision(): number {
    this.sceneVersion += 1
    return this.sceneVersion
  }

  private computeProviderSignature(config: AppConfig): string {
    let key = 'none'
    try {
      const apiKey = this.opts.getApiKey?.() ?? null
      if (apiKey !== null && apiKey !== '') key = `${apiKey.length}:${hashString(apiKey)}`
    } catch {
      key = 'error'
    }
    const vision = config.worlds.activity.vision
    return [
      config.provider.model,
      config.provider.baseUrl ?? '',
      String(config.provider.visionInput),
      String(vision.semantic.timeoutMs),
      key
    ].join('|')
  }

  private onSceneSafely(scene: SceneDescriptor): void {
    try {
      this.onScene?.(scene)
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private reportError(error: Error): void {
    try {
      this.onError?.(error)
    } catch {
      /* ignore */
    }
  }
}

function emptySemanticStatus(): SceneSemanticStatus {
  return {
    enabled: false,
    available: false,
    model: null,
    lastAt: null,
    lastSentAt: null,
    lastInterpretedAt: null,
    lastLatencyMs: null,
    lastError: null,
    imageSupported: null,
    shareFrames: false,
    inFlight: false,
    usage: null,
    reason: '视觉模型通路未初始化'
  }
}

function cloneFrameInfo(info: SceneFrameInfo): SceneFrameInfo {
  return { ...info, validRegion: { ...info.validRegion } }
}

function sameBounds(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean {
  const tolerance = 2
  return (
    Math.abs(left.x - right.x) <= tolerance &&
    Math.abs(left.y - right.y) <= tolerance &&
    Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance
  )
}

function hashString(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}
