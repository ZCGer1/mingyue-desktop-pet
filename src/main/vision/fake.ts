import type {
  SceneDescriptor,
  SceneProvider,
  SceneStatus
} from '../../worlds/activity/scene'

/**
 * E2E 专用场景来源（`MINGYUE_E2E_VISION_FAKE=1`）。
 *
 * 不截屏、不 OCR，只在采样启动后注入一条固定 descriptor。真实用户路径永远
 * 不会构造这个类；它存在的目的只是让端到端测试验证「抽象场景进入
 * ActivityWorld → 设置页可预览 → 原始字段不落盘/不进模型」这条链路。
 */
export class E2EFakeSceneProvider implements SceneProvider {
  private readonly delayMs: number
  private readonly scene: SceneDescriptor
  private timer: NodeJS.Timeout | null = null
  private running = false
  private last: SceneDescriptor | null = null

  constructor(opts: { delayMs?: number; scene?: Partial<SceneDescriptor> } = {}) {
    this.delayMs = opts.delayMs ?? 2_000
    this.scene = {
      category: 'watching_video',
      activity: '在看视频',
      appLabel: '浏览器',
      title: 'E2E-OCR-SENTINEL-视频标题',
      keywords: ['e2e-ocr-sentinel'],
      confidence: 0.92,
      at: 0,
      ...opts.scene
    }
  }

  start(onScene: (scene: SceneDescriptor) => void): void {
    this.stop()
    this.running = true
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.running) return
      const at = Date.now()
      const scene: SceneDescriptor = {
        ...this.scene,
        at,
        // 只有显式伪装成视觉模型证据时，才补上真实摘要会携带的时效字段；
        // 默认仍保持“仅本地场景”，不冒充模型看过画面。
        ...(this.scene.evidenceSource === 'vision_model'
          ? {
              evidenceAt: at,
              expiresAt: at + 90_000,
              revision: this.scene.revision ?? 1
            }
          : {})
      }
      this.last = scene
      onScene(scene)
    }, this.delayMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  refresh(): void {
    /* 固定场景，不需要重新采样 */
  }

  status(): SceneStatus {
    return {
      enabled: true,
      available: true,
      reason: null,
      lastAt: this.last?.at ?? null,
      lastFrameAt: this.last?.at ?? null,
      lastSentAt: null,
      lastInterpretedAt: this.last?.at ?? null,
      lastCategory: this.last?.category ?? null,
      lastActivity: this.last?.activity ?? null,
      lastConfidence: this.last?.confidence ?? null,
      lastDurationMs: this.last === null ? null : 5,
      lastError: null,
      framesCaptured: this.last === null ? 0 : 1,
      framesLastMinute: this.last === null ? 0 : 1,
      requestsSent: 0,
      bufferFrames: 0,
      frameBufferSeconds: 0,
      targetDisplayId: 'e2e',
      targetKind: 'foreground-window',
      quality: 'good',
      blockedReason: null,
      paused: false,
      intervalMs: 60_000,
      nextCheckAt: null,
      ocrAvailable: false,
      ocrFallback: false,
      phase: this.last?.phase ?? null,
      game: this.last?.game ?? null,
      evidenceSource: this.last?.evidenceSource ?? 'local_ocr',
      revision: 1,
      timings: { captureMs: 3, signatureMs: 1, semanticMs: null, totalMs: 4 },
      lastFrame: null,
      semantic: {
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
        reason: 'E2E 固定场景不调用视觉模型'
      }
    }
  }

  clear(): void {
    this.last = null
  }

  preview(): string | null {
    return null
  }
}
