import type { PetInteractionKind, PetPointerSample } from '../../shared/ipc'
import { DRAG_THRESHOLD } from '../../shared/dshPet/constants'
import { buildPetMenu, type MenuLeaf } from '../../shared/dshPet/menu'
import { mountContextMenu, type ContextMenuMount } from './menuMount'
import type { Animations } from '../../shared/dshPet/types'
import { bodyCenter, feetPoint, type BodyBox, type Point } from '../../shared/dshPet/layout'
import type { PetActorView } from './view'
import type { PetController } from './controller'
import type { PerchController } from './perch'

/**
 * 页面里的指针路由 + 点击穿透 + 右键菜单。
 *
 * 窗口默认整窗穿透；只有指针落在宠物命中框或 `[data-agent-ui]`（气泡、状态、
 * 快捷输入、错误卡、菜单）上时，才请主进程暂时关闭穿透。拖拽/抛掷/菜单打开
 * 期间保持可交互。所有坐标都是桌宠页本地 CSS 像素。
 *
 * 行为与上游一致：移动超过 5px 才算拖拽；未拖拽的松手算点击；两次“按下”
 * 间隔小于 200ms 时本次拖拽按弹弓处理；温和放下时尝试吸附窗口上沿。
 */

const SAMPLE_INTERVAL_MS = 33
const TOUCH_LONG_PRESS_MS = 500
const TOUCH_LONG_PRESS_CANCEL_PX = 8
const POST_DRAG_MENU_SUPPRESS_MS = 120
/**
 * 原生 pointer 事件比主进程采样更新鲜。刚收到原生事件的一小段时间内
 * 忽略采样，避免 33ms 的采样把快速移动时的坐标回退到旧位置。
 */
const POINTER_SAMPLE_GRACE_MS = 80

export interface InteractionOptions {
  view: PetActorView
  controller: PetController
  perch: PerchController
  /** 点击身体后的真实入口（快捷输入/完整聊天/仅动画）。 */
  onActivate: () => void
  onQuickInput: () => void
  onOpenChat: () => void
  onOpenSettings: () => void
  onRefresh: () => void
  getHomeBody: () => BodyBox | null
  notifyInteraction: (kind: PetInteractionKind) => void
  /** 菜单占用变化；只用于主进程判断待机自主资格。 */
  reportActivity?: (kind: 'menu-open' | 'menu-close') => void
  onInteractiveChange: (interactive: boolean) => void
  /** 真正开始拖拽时请求最新窗口几何，缩短首次吸附等待。 */
  onGrab: () => void
  animations: Animations
  quickInputEnabled: boolean
  now?: () => number
}

export class PetInteraction {
  private readonly options: InteractionOptions
  private readonly now: () => number

  private point: Point | null = null
  private interactive = false
  private overBody = false
  private overUi = false

  private pressing = false
  private pressPointerId: number | null = null
  private pressStart: Point | null = null
  private pressOffset: Point = { x: 0, y: 0 }
  private slingArmed = false
  private dragging = false
  private longPressTimer = 0
  private longPressFired = false

  private menu: ContextMenuMount | null = null
  private animations: Animations
  private quickInputEnabled: boolean
  private lastDragEndAt = Number.NEGATIVE_INFINITY
  private lastPointerEventAt = Number.NEGATIVE_INFINITY

  private timer = 0
  private destroyed = false

  constructor(options: InteractionOptions) {
    this.options = options
    this.now = options.now ?? (() => performance.now())
    this.animations = options.animations
    this.quickInputEnabled = options.quickInputEnabled

    window.addEventListener('pointermove', this.onPointerMove, { passive: true })
    window.addEventListener('pointerdown', this.onPointerDown, { passive: false })
    window.addEventListener('pointerup', this.onPointerUp, { passive: true })
    window.addEventListener('pointercancel', this.onPointerCancel, { passive: true })
    window.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('resize', this.onResize)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.timer = window.setInterval(() => this.refresh(), SAMPLE_INTERVAL_MS)
    this.refresh()
  }

  /** 设置/聊天入口变化后刷新右键菜单内容；菜单正开着就关掉，避免旧树。 */
  setMenuConfig(animations: Animations, quickInputEnabled: boolean): void {
    const changed =
      animations !== this.animations || quickInputEnabled !== this.quickInputEnabled
    this.animations = animations
    this.quickInputEnabled = quickInputEnabled
    if (changed && this.menu !== null) this.closeMenu()
  }

  debugState(): {
    interactive: boolean
    overBody: boolean
    overUi: boolean
    pressing: boolean
    dragging: boolean
    slingArmed: boolean
    menuOpen: boolean
    point: Point | null
  } {
    return {
      interactive: this.interactive,
      overBody: this.overBody,
      overUi: this.overUi,
      pressing: this.pressing,
      dragging: this.dragging,
      slingArmed: this.slingArmed,
      menuOpen: this.menu !== null,
      point: this.point === null ? null : { ...this.point }
    }
  }

  /**
   * 主进程的系统光标采样。点击穿透状态下窗口收不到原生鼠标事件，
   * 这是页面唯一能知道光标进入身体/面板的途径。只更新位置和可交互
   * 判定，不参与按下/拖拽——那些仍由真实 pointer 事件驱动。
   */
  applyPointerSample(sample: PetPointerSample): void {
    if (this.destroyed) return
    if (this.now() - this.lastPointerEventAt < POINTER_SAMPLE_GRACE_MS) return
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return
    this.point = sample.inside ? { x: sample.x, y: sample.y } : null
    this.refresh()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.clearLongPress()
    window.clearInterval(this.timer)
    this.timer = 0
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerCancel)
    window.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('resize', this.onResize)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.closeMenu()
    this.setInteractive(false)
    document.documentElement.style.cursor = ''
  }

  // ------------------------------------------------------------------ 事件

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.destroyed) return
    this.lastPointerEventAt = this.now()
    const point = { x: event.clientX, y: event.clientY }
    this.point = point
    if (this.pressing && event.pointerId === this.pressPointerId) {
      const start = this.pressStart
      if (start !== null) {
        const distance = Math.hypot(point.x - start.x, point.y - start.y)
        if (!this.dragging && this.longPressTimer !== 0 && distance > TOUCH_LONG_PRESS_CANCEL_PX) {
          this.clearLongPress()
        }
        if (!this.dragging && distance >= DRAG_THRESHOLD) this.beginDrag(point)
        if (this.dragging) {
          this.options.controller.dragTo(point, this.pressOffset)
          this.showPerchPreview()
        }
      }
    }
    this.refresh()
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.destroyed) return
    this.lastPointerEventAt = this.now()
    if (event.button !== 0) {
      this.refresh()
      return
    }
    const point = { x: event.clientX, y: event.clientY }
    this.point = point
    if (this.isUiTarget(event.target)) {
      this.refresh()
      return
    }
    if (this.menu !== null) this.closeMenu()
    if (!this.options.view.isOnBody(point)) {
      this.refresh()
      return
    }
    // 透明窗口里的按下不能开始文本选择，也不能让浏览器生成默认拖拽。
    event.preventDefault()
    if (this.pressing) this.cancelPress(false)

    const center = bodyCenter(this.options.controller.body())
    this.pressing = true
    this.pressPointerId = event.pointerId
    this.pressStart = point
    this.pressOffset = { x: point.x - center.x, y: point.y - center.y }
    this.dragging = false
    this.slingArmed = false
    this.longPressFired = false
    this.options.controller.pressDown(point)
    this.slingArmed = this.options.controller.slingWasArmed()
    this.capturePointer(event.pointerId)
    this.setInteractive(true)
    this.options.perch.hidePreview()

    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') {
      this.scheduleLongPress(point)
    }
    this.refresh()
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.destroyed) return
    this.lastPointerEventAt = this.now()
    if (event.button !== 0 || !this.pressing || event.pointerId !== this.pressPointerId) {
      this.refresh()
      return
    }
    const point = { x: event.clientX, y: event.clientY }
    this.point = point
    this.clearLongPress()
    const wasDragging = this.dragging
    const wasLongPress = this.longPressFired
    const pointerId = this.pressPointerId
    this.pressing = false
    this.pressPointerId = null
    this.pressStart = null
    this.releasePointer(pointerId)

    if (wasDragging) {
      this.finishDrag()
    } else if (!wasLongPress) {
      this.options.controller.resetPressState()
      this.options.controller.clickFeedback()
      this.options.notifyInteraction('pet')
      this.options.onActivate()
    }
    this.slingArmed = false
    this.longPressFired = false
    this.refresh()
  }

  private readonly onPointerCancel = (): void => {
    if (!this.pressing) {
      this.refresh()
      return
    }
    const pointerId = this.pressPointerId
    const wasDragging = this.dragging
    this.cancelPress(wasDragging)
    this.releasePointer(pointerId)
    this.refresh()
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    if (this.destroyed) return
    this.lastPointerEventAt = this.now()
    const point = { x: event.clientX, y: event.clientY }
    this.point = point
    if (this.isUiTarget(event.target)) return
    if (!this.options.view.isOnBody(point)) {
      this.refresh()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (this.pressing || this.dragging) return
    if (this.now() - this.lastDragEndAt < POST_DRAG_MENU_SUPPRESS_MS) return
    this.openMenu(point)
  }

  private readonly onBlur = (): void => {
    if (!this.destroyed) {
      this.cancelPress(this.dragging)
      this.closeMenu()
      this.setInteractive(false)
      this.refresh()
    }
  }

  private readonly onVisibility = (): void => {
    if (!document.hidden || this.destroyed) return
    this.cancelPress(this.dragging)
    this.closeMenu()
    this.setInteractive(false)
    this.refresh()
  }

  private readonly onResize = (): void => {
    this.refresh()
  }

  // ------------------------------------------------------------------ 拖拽

  private beginDrag(point: Point): void {
    this.clearLongPress()
    if (this.options.controller.isBound()) this.options.perch.detach(false)
    this.options.controller.beginDrag()
    this.dragging = true
    this.options.notifyInteraction('grab')
    this.options.onGrab()
    this.options.controller.dragTo(point, this.pressOffset)
    this.showPerchPreview()
    this.refresh()
  }

  private finishDrag(): void {
    const controller = this.options.controller
    const velocity = this.slingArmed ? controller.slingVelocity() : controller.releaseVelocity()
    controller.resetPressState()
    this.dragging = false
    this.options.perch.hidePreview()

    controller.endDrag({ velocity })
    this.lastDragEndAt = this.now()
    if (velocity !== null) {
      this.options.notifyInteraction('throw')
      return
    }

    // 温和放下：尝试窗口上沿吸附；失败就留在物理层刚夹取好的位置。
    const feet = feetPoint(controller.body())
    const bound = this.options.perch.bind(feet)
    if (!bound) {
      // 吸附失败时 hint 已隐藏；这里不需要额外播放，endDrag 已恢复动画链。
    }
    this.options.notifyInteraction('drop')
  }

  private cancelPress(withDrop: boolean): void {
    this.clearLongPress()
    if (!this.pressing && !this.dragging) return
    const pointerId = this.pressPointerId
    this.pressing = false
    this.pressPointerId = null
    this.pressStart = null
    this.releasePointer(pointerId)
    this.options.perch.hidePreview()
    this.options.controller.resetPressState()
    if (withDrop) {
      this.dragging = false
      this.options.controller.endDrag({ velocity: null })
      this.lastDragEndAt = this.now()
    }
    this.dragging = false
    this.slingArmed = false
    this.longPressFired = false
  }

  private showPerchPreview(): void {
    const body = this.options.controller.body()
    this.options.perch.preview(feetPoint(body))
  }

  // ------------------------------------------------------------------ 菜单

  private openMenu(point: Point): void {
    this.closeMenu()
    this.options.controller.setMenuOpen(true)
    this.options.reportActivity?.('menu-open')
    const tree = buildPetMenu(this.animations, { quickInput: this.quickInputEnabled })
    let mount: ContextMenuMount | null = null
    mount = mountContextMenu({
      tree,
      x: point.x,
      y: point.y,
      onAction: (leaf) => this.handleMenuAction(leaf),
      onClose: () => {
        if (this.menu !== mount) return
        this.menu = null
        this.options.controller.setMenuOpen(false)
        this.options.reportActivity?.('menu-close')
        this.setInteractive(false)
        this.refresh()
      }
    })
    mount.el.setAttribute('data-agent-ui', '')
    this.menu = mount
    this.setInteractive(true)
    this.refresh()
  }

  closeMenu(): void {
    const menu = this.menu
    if (menu === null) return
    this.menu = null
    menu.close()
    this.options.controller.setMenuOpen(false)
    this.options.reportActivity?.('menu-close')
  }

  private handleMenuAction(leaf: MenuLeaf): void {
    switch (leaf.action) {
      case 'chat':
        this.options.onOpenChat()
        return
      case 'quick-input':
        this.options.onQuickInput()
        return
      case 'settings':
        this.options.onOpenSettings()
        return
      case 'home': {
        const home = this.options.getHomeBody()
        if (home === null) return
        this.options.perch.detach(false)
        this.options.controller.goTo(home)
        this.options.notifyInteraction('drop')
        return
      }
      case 'refresh':
        this.options.onRefresh()
        return
      case 'animation':
        if (leaf.anim !== undefined) this.options.controller.playMenu(leaf.anim)
        return
      default:
        return
    }
  }

  // ------------------------------------------------------------------ 长按/穿透

  private scheduleLongPress(point: Point): void {
    this.clearLongPress()
    const pointerId = this.pressPointerId
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = 0
      if (this.destroyed || !this.pressing || this.dragging) return
      this.pressing = false
      this.pressPointerId = null
      this.pressStart = null
      this.longPressFired = true
      this.releasePointer(pointerId)
      this.options.controller.resetPressState()
      this.openMenu(point)
      this.refresh()
    }, TOUCH_LONG_PRESS_MS)
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== 0) window.clearTimeout(this.longPressTimer)
    this.longPressTimer = 0
  }

  private capturePointer(pointerId: number | null): void {
    if (pointerId === null) return
    try {
      document.documentElement.setPointerCapture(pointerId)
    } catch {
      /* 某些合成事件没有活动指针；窗口级监听仍然能收到移动。 */
    }
  }

  private releasePointer(pointerId: number | null): void {
    if (pointerId === null) return
    try {
      if (document.documentElement.hasPointerCapture(pointerId)) {
        document.documentElement.releasePointerCapture(pointerId)
      }
    } catch {
      /* ignore */
    }
  }

  private isUiTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('[data-agent-ui]') !== null
  }

  private refresh(): void {
    if (this.destroyed) return
    const point = this.point
    const element = point === null ? null : document.elementFromPoint(point.x, point.y)
    this.overUi = element instanceof Element && element.closest('[data-agent-ui]') !== null
    this.overBody = point !== null && this.options.view.isOnBody(point)
    this.setInteractive(
      this.pressing || this.dragging || this.menu !== null || this.overUi || this.overBody
    )
    if (!this.dragging) {
      document.documentElement.style.cursor =
        this.overBody && !this.overUi && this.menu === null ? 'grab' : ''
    }
  }

  private setInteractive(interactive: boolean): void {
    if (this.interactive === interactive) return
    this.interactive = interactive
    this.options.onInteractiveChange(interactive)
  }
}
