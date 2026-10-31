import type { PerchGeometryView, PetDisplayView } from '../../shared/ipc'
import {
  bindingRatio,
  findPerchCandidate,
  resolveFollow,
  type PerchBinding,
  type PerchCandidate
} from '../perchSupport'
import { PerchHint } from '../perchHint'
import { bodyFromFeet, feetPoint, type BodyBox, type Point } from '../../shared/dshPet/layout'
import type { PetController } from './controller'

/**
 * 窗口上沿停靠。
 *
 * 只使用主进程给出的窗口矩形和可见上沿；没有窗口标题、内容或截图。停靠时
 * 播放的仍是当前真实的动作素材——不会伪造“坐着”的姿态，也不会为了停靠
 * 另建一套动画引擎。窗口移动时按脚在可见区间内的比例跟随；窗口消失、
 * 几何不可用或被拖走时解除绑定，并让物理层安全落地（除非是用户开始拖拽）。
 */

export interface PerchControllerOptions {
  controller: PetController
  /** 预览线默认由内部创建；测试可注入替身。 */
  hint?: Pick<PerchHint, 'show' | 'hide' | 'destroy'>
  /** true 表示当前停在窗口上沿；重复的跟随刷新也会回调，由调用方去重。 */
  onStateChange?: (bound: boolean) => void
}

export class PerchController {
  private readonly controller: PetController
  private readonly hint: Pick<PerchHint, 'show' | 'hide' | 'destroy'>
  private readonly ownsHint: boolean
  private readonly onStateChange: ((bound: boolean) => void) | undefined
  private geometry: PerchGeometryView | null = null
  private binding: PerchBinding | null = null
  private destroyed = false

  constructor(options: PerchControllerOptions) {
    this.controller = options.controller
    this.hint = options.hint ?? new PerchHint()
    this.ownsHint = options.hint === undefined
    this.onStateChange = options.onStateChange
  }

  get bound(): boolean {
    return this.binding !== null
  }

  setGeometry(geometry: PerchGeometryView): void {
    if (this.destroyed) return
    this.geometry = geometry
    if (this.binding === null) return
    if (geometry.unavailableReason !== null) {
      this.releaseWithFall()
      return
    }
    const currentX = feetPoint(this.controller.body()).x
    const target = resolveFollow(geometry, this.binding, currentX)
    if (target === null) {
      this.releaseWithFall()
      return
    }
    this.binding = {
      windowId: target.windowId,
      segmentIndex: target.segmentIndex,
      ratio: this.binding.ratio
    }
    // 停靠的 y 不是可恢复的桌面位置（窗口 id 只在本次运行有效）；保留最后一次
    // 落地位置，重启后不会凭空悬在半空。
    this.controller.placeAt(
      bodyFromFeet(target.x, target.top, this.controller.metrics()),
      false
    )
    this.onStateChange?.(true)
  }

  /** 拖拽中显示候选上沿；返回候选便于测试，不影响绑定。 */
  preview(feet: Point): PerchCandidate | null {
    if (this.destroyed || this.controller.isBound()) return null
    const candidate = findPerchCandidate(this.geometry, feet, {
      bodyHeight: this.controller.metrics().height
    })
    if (candidate === null) this.hint.hide()
    else this.hint.show(candidate)
    return candidate
  }

  hidePreview(): void {
    this.hint.hide()
  }

  /** 松手落点吸附；只在温和放下时调用（甩抛走物理，不吸窗口）。 */
  bind(feet: Point): boolean {
    if (this.destroyed || this.controller.isDragging()) return false
    const candidate = findPerchCandidate(this.geometry, feet, {
      bodyHeight: this.controller.metrics().height
    })
    this.hint.hide()
    if (candidate === null) return false
    return this.bindCandidate(candidate)
  }

  bindCandidate(candidate: PerchCandidate): boolean {
    if (this.destroyed) return false
    this.binding = {
      windowId: candidate.windowId,
      segmentIndex: candidate.segmentIndex,
      ratio: bindingRatio(candidate.segmentX1, candidate.segmentX2, candidate.x)
    }
    this.controller.setBound(true)
    this.controller.placeAt(
      bodyFromFeet(candidate.x, candidate.top, this.controller.metrics()),
      false
    )
    this.hint.hide()
    this.onStateChange?.(true)
    return true
  }

  /**
   * 解除停靠。withFall=true 用于窗口消失/几何失效：走重力落地；
   * false 用于用户拖拽或归位：用户马上接管位置，不需要额外下落。
   */
  detach(withFall: boolean): boolean {
    if (this.binding === null) return false
    this.binding = null
    this.hint.hide()
    if (withFall) this.controller.dropFromPerch()
    else this.controller.setBound(false)
    this.onStateChange?.(false)
    return true
  }

  /** 显示器布局变化：若脚已经悬在不属于任何屏的位置，立即安全下落。 */
  setDisplays(displays: PetDisplayView[]): void {
    if (this.binding === null) return
    const feet = feetPoint(this.controller.body())
    const onAnyDisplay = displays.some(
      (display) =>
        feet.x >= display.x &&
        feet.x <= display.x + display.width &&
        feet.y >= display.y &&
        feet.y <= display.y + display.height
    )
    if (!onAnyDisplay) this.releaseWithFall()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.binding = null
    this.hint.hide()
    if (this.ownsHint) this.hint.destroy()
  }

  debugState(): {
    bound: boolean
    windowId: string | null
    segmentIndex: number | null
    ratio: number | null
    windows: number
    unavailableReason: string | null
    body: BodyBox
  } {
    const body = this.controller.body()
    return {
      bound: this.binding !== null,
      windowId: this.binding?.windowId ?? null,
      segmentIndex: this.binding?.segmentIndex ?? null,
      ratio: this.binding?.ratio ?? null,
      windows: this.geometry?.windows.length ?? 0,
      unavailableReason: this.geometry?.unavailableReason ?? null,
      body
    }
  }

  private releaseWithFall(): void {
    if (this.binding === null) return
    this.binding = null
    this.hint.hide()
    this.controller.dropFromPerch()
    this.onStateChange?.(false)
  }
}
