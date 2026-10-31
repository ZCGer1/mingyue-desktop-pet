/**
 * 双缓冲透明 WebM 播放器（移植自上游 dsh-pet `pet.ts` 的 A/B video 切换）。
 *
 * 只有两个 `<video>` 元素，永远不新建；新动画先加载到后台元素，等
 * `loadeddata` 且 `play()` 真正兑现后才交换 `.is-front`，因此：
 *  - 切换不会先黑一帧（后台元素 opacity 0）；
 *  - `started` 回执只代表真实出画，而不是「已设置 src」；
 *  - 加载失败/超时保留前一段画面，调用方可以把错误显示出来；
 *  - 不做自动重试，下一次播放必须显式发起（避免坏素材触发无限请求）。
 */

const LOAD_TIMEOUT_MS = 10_000
const FADE_PAUSE_MS = 220

export type PlayFailureReason =
  | 'unsupported'
  | 'load'
  | 'decode'
  | 'play'
  | 'timeout'
  | 'interrupted'

export interface PlayResult {
  ok: boolean
  reason?: PlayFailureReason
  /** 复用当前已在播放的同一段循环动画（没有重新加载）。 */
  reused?: boolean
  /** 本次播放实例的令牌；回调会带回同一个值，用来丢弃迟到的旧事件。 */
  token?: number
}

export interface DshPetPlayerCallbacks {
  /** 前台视频自然播完（loop=false）；token 标识具体播放实例。 */
  onEnded: (animationId: string, token: number) => void
  /** 已经出画的视频在播放中报错。 */
  onRuntimeError: (animationId: string, reason: PlayFailureReason, token: number) => void
}

export function animationUrl(animationId: string): string {
  return `/dsh-pet/webm/${encodeURIComponent(animationId)}.webm`
}

export class DshPetPlayer {
  private readonly videos: [HTMLVideoElement, HTMLVideoElement]
  private callbacks: DshPetPlayerCallbacks
  private front = -1
  private token = 0
  private animationId: string | null = null
  private loop = false
  private pauseTimer = 0
  private destroyed = false

  constructor(
    videos: [HTMLVideoElement, HTMLVideoElement],
    callbacks: DshPetPlayerCallbacks
  ) {
    this.videos = videos
    this.callbacks = callbacks
    for (const video of videos) {
      video.muted = true
      video.autoplay = true
      video.playsInline = true
      video.preload = 'auto'
      video.addEventListener('ended', () => this.handleEnded(video))
      video.addEventListener('error', () => this.handleError(video))
    }
  }

  /** 控制器构造完成后再接回调；构造期播放器不会开始任何加载。 */
  setCallbacks(callbacks: DshPetPlayerCallbacks): void {
    this.callbacks = callbacks
  }

  get currentId(): string | null {
    return this.animationId
  }

  get currentLoop(): boolean {
    return this.loop
  }

  /** 当前前台播放实例的令牌；没有播放时为 0。 */
  get playbackToken(): number {
    return this.animationId === null ? 0 : this.token
  }

  /** 前台视频是否暂停（后台标签页/系统节能可能自动暂停，需要续播）。 */
  paused(): boolean {
    const video = this.frontVideo()
    return video !== null && video.paused
  }

  /** 尝试恢复前台视频；不改变 token，也不重新加载素材。 */
  resume(): void {
    const video = this.frontVideo()
    if (video === null || this.destroyed) return
    void video.play().catch(() => {
      /* 自动播放策略/后台节流失败时由看门狗决定硬边界。 */
    })
  }

  /** 前台视频的播放进度；走位按 lead/tail 时间驱动。 */
  currentTime(): number {
    const video = this.frontVideo()
    return video === null || !Number.isFinite(video.currentTime) ? 0 : video.currentTime
  }

  duration(): number {
    const video = this.frontVideo()
    return video === null || !Number.isFinite(video.duration) || video.duration <= 0
      ? 0
      : video.duration
  }

  /**
   * 加载并开始播放；失败时前台画面保持不变。
   * `restart` 用于必须从 0 秒精确同步的移动：同一素材也不能复用旧进度。
   */
  async play(
    animationId: string,
    options: { loop: boolean; restart?: boolean }
  ): Promise<PlayResult> {
    if (this.destroyed) return { ok: false, reason: 'unsupported' }
    if (animationId.trim() === '') return { ok: false, reason: 'unsupported' }
    if (
      options.restart !== true &&
      this.animationId === animationId &&
      this.loop === options.loop &&
      this.frontVideo() !== null &&
      !this.frontVideo()?.paused
    ) {
      return { ok: true, reused: true, token: this.token }
    }

    const token = ++this.token
    if (this.pauseTimer !== 0) {
      window.clearTimeout(this.pauseTimer)
      this.pauseTimer = 0
    }
    const oldIndex = this.front
    const backIndex = oldIndex === 0 ? 1 : 0
    const back = this.videos[backIndex]
    if (back === undefined) return { ok: false, reason: 'unsupported' }

    try {
      back.pause()
      back.loop = options.loop
      back.src = animationUrl(animationId)
      back.load()
      await this.waitForLoad(back, token)
      if (token !== this.token || this.destroyed) return { ok: false, reason: 'interrupted' }
      try {
        back.currentTime = 0
      } catch {
        /* 元数据尚未允许 seek 时忽略；自动播放仍从 0 开始。 */
      }
      try {
        await back.play()
      } catch {
        if (token !== this.token || this.destroyed) return { ok: false, reason: 'interrupted' }
        return { ok: false, reason: 'play' }
      }
      if (token !== this.token || this.destroyed) {
        back.pause()
        return { ok: false, reason: 'interrupted' }
      }

      const old = oldIndex >= 0 ? (this.videos[oldIndex] ?? null) : null
      back.classList.add('is-front')
      if (old !== null && old !== back) {
        old.classList.remove('is-front')
        const oldRef = old
        this.pauseTimer = window.setTimeout(() => {
          this.pauseTimer = 0
          if (this.frontVideo() !== oldRef) oldRef.pause()
        }, FADE_PAUSE_MS)
      }
      this.front = backIndex
      this.animationId = animationId
      this.loop = options.loop
      return { ok: true, token }
    } catch (error) {
      if (token !== this.token || this.destroyed) return { ok: false, reason: 'interrupted' }
      const reason = error instanceof PlayerWaitError ? error.reason : 'load'
      try {
        back.pause()
        back.removeAttribute('src')
        back.load()
      } catch {
        /* ignore */
      }
      return { ok: false, reason }
    }
  }

  /** 冻结并清空播放器（页面卸载/重置）。 */
  stop(): void {
    this.token += 1
    if (this.pauseTimer !== 0) {
      window.clearTimeout(this.pauseTimer)
      this.pauseTimer = 0
    }
    for (const video of this.videos) {
      try {
        video.pause()
        video.classList.remove('is-front')
        video.removeAttribute('src')
        video.load()
      } catch {
        /* ignore */
      }
    }
    this.front = -1
    this.animationId = null
    this.loop = false
  }

  destroy(): void {
    this.destroyed = true
    this.stop()
  }

  // -------------------------------------------------------------------------

  private frontVideo(): HTMLVideoElement | null {
    return this.front >= 0 ? (this.videos[this.front] ?? null) : null
  }

  private waitForLoad(video: HTMLVideoElement, token: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error: PlayerWaitError | null): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        video.removeEventListener('loadeddata', onLoaded)
        video.removeEventListener('error', onError)
        if (token !== this.token || this.destroyed) {
          reject(new PlayerWaitError('interrupted'))
          return
        }
        if (error === null) resolve()
        else reject(error)
      }
      const onLoaded = (): void => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish(null)
      }
      const onError = (): void => {
        // 不把 video.error.message 直接暴露到 UI：它可能包含本地 URL；
        // 页面只按固定枚举给出可读提示。
        const code = video.error?.code
        finish(new PlayerWaitError(code === 3 ? 'decode' : 'load'))
      }
      const timer = window.setTimeout(() => finish(new PlayerWaitError('timeout')), LOAD_TIMEOUT_MS)
      video.addEventListener('loadeddata', onLoaded)
      video.addEventListener('error', onError)
      // 缓存命中/已经可播时不会再有 loadeddata（极少数实现），主动补一次。
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish(null)
    })
  }

  private handleEnded(video: HTMLVideoElement): void {
    if (this.destroyed || video !== this.frontVideo()) return
    if (this.loop) return
    const id = this.animationId
    if (id === null) return
    this.callbacks.onEnded(id, this.token)
  }

  private handleError(video: HTMLVideoElement): void {
    if (this.destroyed) return
    // 后台加载错误由 waitForLoad 处理；这里只关心已经出画后的运行期解码失败。
    if (video !== this.frontVideo()) return
    const id = this.animationId
    if (id === null) return
    const code = video.error?.code
    this.callbacks.onRuntimeError(id, code === 3 ? 'decode' : 'load', this.token)
  }
}

class PlayerWaitError extends Error {
  readonly reason: PlayFailureReason

  constructor(reason: PlayFailureReason) {
    super(reason)
    this.name = 'PlayerWaitError'
    this.reason = reason
  }
}
