import type { PetCuaActionEvent } from '../shared/ipc'

/**
 * CUA 动作标记层。
 *
 * 主进程把全局 DIP 坐标换算成桌宠页本地 CSS 像素后发送；这里只画动作类型，
 * 不接触截图、窗口标题或输入文字。canvas 永远 pointer-events:none，
 * 不参与 PointerRouter 的命中测试；桌宠窗口的 content protection 会阻止
 * 这些标记出现在 CUA 自己的截图里。
 */

interface CuaEffect {
  event: PetCuaActionEvent
  startedAt: number
}

const EFFECT_TTL_MS = 1200
const MAX_EFFECTS = 24
const COLOR = '#9fd8ff'

export interface CuaOverlayOptions {
  reducedMotion?: boolean
  now?: () => number
}

export class CuaOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private reducedMotion: boolean
  private readonly now: () => number
  private readonly effects: CuaEffect[] = []
  private frame = 0
  private destroyed = false
  private readonly onResize = (): void => this.resize()

  constructor(options: CuaOverlayOptions = {}) {
    this.reducedMotion =
      options.reducedMotion ??
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    this.now = options.now ?? (() => performance.now())

    this.canvas = document.createElement('canvas')
    this.canvas.id = 'cua-overlay'
    this.canvas.setAttribute('data-cua-overlay', '')
    this.canvas.setAttribute('aria-hidden', 'true')
    this.canvas.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147482450;'
    ;(document.getElementById('overlay-host') ?? document.body).appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')
    this.resize()
    window.addEventListener('resize', this.onResize)
  }

  /** 通过 window.mingyue.pet.onCuaAction 订阅；返回取消函数。 */
  subscribe(): () => void {
    return window.mingyue.pet.onCuaAction((event) => this.handle(event))
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced
  }

  handle(event: PetCuaActionEvent): void {
    if (this.destroyed || !this.valid(event)) return
    this.effects.push({ event, startedAt: this.now() })
    if (this.effects.length > MAX_EFFECTS) this.effects.splice(0, this.effects.length - MAX_EFFECTS)
    this.start()
  }

  destroy(): void {
    this.destroyed = true
    window.removeEventListener('resize', this.onResize)
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.effects.length = 0
    this.canvas.remove()
  }

  // -------------------------------------------------------------------------

  private valid(event: PetCuaActionEvent): boolean {
    const finite = (value: number | undefined): boolean =>
      value === undefined || Number.isFinite(value)
    return Number.isFinite(event.x) && Number.isFinite(event.y) && finite(event.toX) && finite(event.toY)
  }

  private resize(): void {
    if (this.destroyed) return
    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
    const width = Math.max(1, Math.round(window.innerWidth * ratio))
    const height = Math.max(1, Math.round(window.innerHeight * ratio))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    this.ctx?.setTransform(ratio, 0, 0, ratio, 0, 0)
    this.draw()
  }

  private start(): void {
    if (this.frame !== 0 || this.destroyed) return
    this.frame = requestAnimationFrame(() => this.tick())
  }

  private tick(): void {
    this.frame = 0
    if (this.destroyed) return
    const now = this.now()
    const ttl = this.reducedMotion ? 700 : EFFECT_TTL_MS
    while (this.effects.length > 0 && now - (this.effects[0]?.startedAt ?? 0) > ttl) {
      this.effects.shift()
    }
    this.draw(now, ttl)
    if (this.effects.length > 0) this.start()
  }

  private draw(now = this.now(), ttl = EFFECT_TTL_MS): void {
    const ctx = this.ctx
    if (ctx === null) return
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
    for (const effect of this.effects) {
      const age = Math.max(0, now - effect.startedAt)
      const p = Math.min(1, age / ttl)
      const alpha = this.reducedMotion ? 0.65 : 1 - p
      if (alpha <= 0.02) continue
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.strokeStyle = COLOR
      ctx.fillStyle = COLOR
      ctx.lineWidth = 2
      switch (effect.event.kind) {
        case 'screenshot':
          this.drawScreenshot(ctx, p)
          break
        case 'click':
          this.drawClick(ctx, effect.event.x, effect.event.y, p)
          break
        case 'drag':
          this.drawDrag(ctx, effect.event, p)
          break
        case 'type':
        case 'key':
          this.drawKeyboard(ctx, effect.event.x, effect.event.y, p)
          break
        case 'scroll':
          this.drawScroll(ctx, effect.event.x, effect.event.y, p)
          break
      }
      ctx.restore()
    }
  }

  private drawScreenshot(ctx: CanvasRenderingContext2D, p: number): void {
    const inset = 10
    const width = window.innerWidth - inset * 2
    const height = window.innerHeight - inset * 2
    ctx.globalAlpha *= 1 - p * 0.6
    ctx.strokeRect(inset, inset, width, height)
    if (!this.reducedMotion) {
      const y = inset + height * p
      ctx.beginPath()
      ctx.moveTo(inset, y)
      ctx.lineTo(inset + width, y)
      ctx.stroke()
    }
  }

  private drawClick(ctx: CanvasRenderingContext2D, x: number, y: number, p: number): void {
    const radius = this.reducedMotion ? 18 : 12 + p * 30
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, 3, 0, Math.PI * 2)
    ctx.fill()
  }

  private drawDrag(
    ctx: CanvasRenderingContext2D,
    event: PetCuaActionEvent,
    p: number
  ): void {
    const toX = event.toX ?? event.x
    const toY = event.toY ?? event.y
    ctx.beginPath()
    ctx.moveTo(event.x, event.y)
    ctx.lineTo(toX, toY)
    ctx.stroke()
    if (!this.reducedMotion) {
      ctx.beginPath()
      ctx.arc(event.x + (toX - event.x) * p, event.y + (toY - event.y) * p, 6, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.beginPath()
    ctx.arc(toX, toY, 5, 0, Math.PI * 2)
    ctx.stroke()
  }

  private drawKeyboard(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    p: number
  ): void {
    const scale = this.reducedMotion ? 1 : 1 + p * 0.25
    const width = 34 * scale
    const height = 22 * scale
    const left = x - width / 2
    const top = y - height / 2
    ctx.strokeRect(left, top, width, height)
    ctx.beginPath()
    for (let index = 0; index < 3; index += 1) {
      const dotX = left + 8 * scale + index * 9 * scale
      ctx.moveTo(dotX + 1, top + height / 2)
      ctx.arc(dotX, top + height / 2, 1.5, 0, Math.PI * 2)
    }
    ctx.fill()
  }

  private drawScroll(ctx: CanvasRenderingContext2D, x: number, y: number, p: number): void {
    const offset = this.reducedMotion ? 0 : Math.sin(p * Math.PI) * 8
    for (const direction of [-1, 1]) {
      const tipY = y + direction * (10 + offset)
      ctx.beginPath()
      ctx.moveTo(x - 7, tipY - direction * 6)
      ctx.lineTo(x, tipY)
      ctx.lineTo(x + 7, tipY - direction * 6)
      ctx.stroke()
    }
  }
}
