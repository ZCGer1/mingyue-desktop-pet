import { DshPetPlayer } from './player'
import {
  anchorFor,
  createMetrics,
  hitBoxFor,
  isPointOnBody,
  type BodyBox,
  type PetAnchor,
  type PetMetrics,
  type Point
} from '../../shared/dshPet/layout'

/**
 * 透明舞台 DOM。
 *
 * 结构（与上游一致）：
 *   .dsh-pet-root   ← 身体盒（left/top/size/height 由本类写）
 *     .dsh-pet-stage ← 向下偏移 bottomPad：视频画布的脚底线落在 root 底边
 *       video ×2      ← A/B 双缓冲
 *       .dsh-pet-hit  ← 仅用于绘制/诊断；命中由 PointerRouter 的几何判定完成
 *
 * 页面根窗口本身是 click-through 的，透明区域不能出现 pointer-events:auto
 * 的节点；真正可交互的是 overay 里的 `[data-agent-ui]`。
 */

const ERROR_CARD_ID = 'dsh-pet-error'

export interface ActorViewOptions {
  stage: HTMLElement
  size: number
  onRetry: () => void
}

export class PetActorView {
  readonly root: HTMLDivElement
  readonly videos: [HTMLVideoElement, HTMLVideoElement]
  readonly player: DshPetPlayer
  private readonly stageEl: HTMLDivElement
  private readonly hitEl: HTMLDivElement
  private readonly errorCard: HTMLDivElement
  private readonly errorText: HTMLSpanElement
  private readonly options: ActorViewOptions
  private metrics: PetMetrics
  private body: BodyBox
  private facing: 'left' | 'right' = 'left'
  private dragging = false
  private squash = 1
  private squashFrame = 0
  private errorVisible = false

  constructor(options: ActorViewOptions) {
    this.options = options
    this.metrics = createMetrics(options.size)
    this.body = { x: 0, y: 0, w: this.metrics.width, h: this.metrics.height }

    this.root = document.createElement('div')
    this.root.className = 'dsh-pet-root'
    this.root.setAttribute('data-pet-root', '')

    this.stageEl = document.createElement('div')
    this.stageEl.className = 'dsh-pet-stage'
    this.stageEl.style.transform = `translateY(${this.metrics.bottomPad}px)`

    const videoA = document.createElement('video')
    const videoB = document.createElement('video')
    for (const video of [videoA, videoB]) {
      video.className = 'dsh-pet-video'
      video.muted = true
      video.playsInline = true
      video.autoplay = true
      video.preload = 'auto'
      video.setAttribute('aria-hidden', 'true')
    }
    this.videos = [videoA, videoB]

    this.hitEl = document.createElement('div')
    this.hitEl.className = 'dsh-pet-hit'
    this.hitEl.setAttribute('aria-hidden', 'true')

    this.stageEl.append(videoA, videoB, this.hitEl)
    this.root.appendChild(this.stageEl)
    options.stage.appendChild(this.root)

    this.errorCard = document.createElement('div')
    this.errorCard.className = 'dsh-pet-error'
    this.errorCard.id = ERROR_CARD_ID
    this.errorCard.setAttribute('data-agent-ui', '')
    this.errorCard.setAttribute('role', 'alert')
    this.errorCard.hidden = true
    this.errorText = document.createElement('span')
    this.errorText.className = 'dsh-pet-error-text'
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'dsh-pet-error-retry'
    retry.textContent = '重试'
    retry.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.hideError()
      this.options.onRetry()
    })
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'dsh-pet-error-dismiss'
    dismiss.textContent = '关闭'
    dismiss.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.hideError()
    })
    this.errorCard.append(this.errorText, retry, dismiss)
    document.body.appendChild(this.errorCard)

    this.player = new DshPetPlayer([videoA, videoB], {
      onEnded: () => undefined,
      onRuntimeError: () => undefined
    })
    this.applyGeometry()
    this.applyTransform()
    window.addEventListener('resize', this.onResize)
  }

  /** 页面内的播放器回调由控制器安装（构造时还不知道控制器）。 */
  setPlayerCallbacks(callbacks: {
    onEnded: (animationId: string, token: number) => void
    onRuntimeError: (
      animationId: string,
      reason: 'unsupported' | 'load' | 'decode' | 'play' | 'timeout' | 'interrupted',
      token: number
    ) => void
  }): void {
    this.player.setCallbacks(callbacks)
  }

  getMetrics(): PetMetrics {
    return this.metrics
  }

  getBody(): BodyBox {
    return { ...this.body }
  }

  setBody(body: BodyBox): void {
    this.body = { ...body, w: this.metrics.width, h: this.metrics.height }
    this.applyGeometry()
  }

  setSize(size: number): PetMetrics {
    const next = createMetrics(size)
    const feet = this.body.y + this.metrics.height
    const center = this.body.x + this.metrics.halfW
    this.metrics = next
    this.body = {
      x: center - next.halfW,
      y: feet - next.height,
      w: next.width,
      h: next.height
    }
    this.applyGeometry()
    this.applyTransform()
    return next
  }

  setFacing(facing: 'left' | 'right'): void {
    this.facing = facing
    this.applyTransform()
  }

  getFacing(): 'left' | 'right' {
    return this.facing
  }

  setDragging(dragging: boolean): void {
    this.dragging = dragging
    this.hitEl.classList.toggle('dragging', dragging)
    document.documentElement.style.cursor = dragging ? 'grabbing' : ''
  }

  anchor(): PetAnchor {
    return anchorFor(this.body, this.metrics)
  }

  isOnBody(point: Point): boolean {
    return isPointOnBody(this.body, this.metrics, point)
  }

  hitBox(): { x: number; y: number; w: number; h: number } {
    return hitBoxFor(this.body, this.metrics)
  }

  /** 点击/落地的 Q 弹；reducedMotion 时不启动。 */
  startSquash(depth: number, reducedMotion: boolean): void {
    if (reducedMotion) return
    if (this.squashFrame !== 0) cancelAnimationFrame(this.squashFrame)
    const start = performance.now()
    const duration = 220
    const step = (): void => {
      const u = Math.min((performance.now() - start) / duration, 1)
      this.squash = squashCurve(u, depth)
      this.applyTransform()
      if (u < 1) this.squashFrame = requestAnimationFrame(step)
      else {
        this.squashFrame = 0
        this.squash = 1
        this.applyTransform()
      }
    }
    this.squashFrame = requestAnimationFrame(step)
  }

  showError(message: string): void {
    this.errorVisible = true
    this.errorText.textContent = message
    this.errorCard.hidden = false
    this.positionError()
  }

  hideError(): void {
    this.errorVisible = false
    this.errorCard.hidden = true
  }

  get errorShown(): boolean {
    return this.errorVisible
  }

  destroy(): void {
    window.removeEventListener('resize', this.onResize)
    if (this.squashFrame !== 0) cancelAnimationFrame(this.squashFrame)
    this.squashFrame = 0
    this.player.destroy()
    this.errorCard.remove()
    this.root.remove()
    document.documentElement.style.cursor = ''
  }

  // -------------------------------------------------------------------------

  private readonly onResize = (): void => {
    this.positionError()
  }

  private applyGeometry(): void {
    const size = this.metrics.width
    const height = this.metrics.height
    this.root.style.left = `${this.body.x}px`
    this.root.style.top = `${this.body.y}px`
    this.root.style.width = `${size}px`
    this.root.style.height = `${height}px`
    this.stageEl.style.width = `${size}px`
    this.stageEl.style.height = `${height}px`
    this.stageEl.style.transform = `translateY(${this.metrics.bottomPad}px)`
    const hit = this.metrics.hit
    this.hitEl.style.left = `${hit.left}px`
    // hit 相对 body 盒；stage 已向下平移 bottomPad，诊断框要减去这段偏移。
    this.hitEl.style.top = `${hit.top - this.metrics.bottomPad}px`
    this.hitEl.style.width = `${hit.width}px`
    this.hitEl.style.height = `${hit.height}px`
    this.hitEl.dataset['dragging'] = this.dragging ? '1' : '0'
    this.positionError()
  }

  private applyTransform(): void {
    const mirror = this.facing === 'right' ? 'scaleX(-1) ' : ''
    const transform = `${mirror}scaleY(${this.squash.toFixed(4)})`
    for (const video of this.videos) {
      video.style.transform = transform
      video.style.transformOrigin = 'center bottom'
    }
    this.root.dataset['facing'] = this.facing
  }

  private positionError(): void {
    if (!this.errorVisible) return
    const anchor = this.anchor()
    const width = 300
    const left = clamp(anchor.bubble.x - width / 2, 8, Math.max(8, window.innerWidth - width - 8))
    const top = clamp(anchor.bubble.y - 96, 8, Math.max(8, window.innerHeight - 110))
    this.errorCard.style.left = `${Math.round(left)}px`
    this.errorCard.style.top = `${Math.round(top)}px`
    this.errorCard.style.width = `${Math.round(width)}px`
  }
}

function squashCurve(u: number, squash: number): number {
  if (u < 0.45) {
    const p = u / 0.45
    return 1 - (1 - squash) * p * p
  }
  const p = (u - 0.45) / 0.55
  const c1 = 1.70158
  const c3 = c1 + 1
  const f = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)
  return Math.min(1.12, squash + (1 - squash) * Math.max(f, 0))
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}
