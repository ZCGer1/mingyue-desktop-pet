import type { PerchCandidate } from './perchSupport'

/**
 * 拖拽时的窗口上沿预览线。
 *
 * 只是视觉提示：`pointer-events: none`，不会成为命中目标，也不会让透明
 * 窗口吞掉桌面点击。真正的落点由 PetController 的停靠几何判断决定。
 */
export class PerchHint {
  private readonly element: HTMLDivElement

  constructor() {
    const element = document.createElement('div')
    element.className = 'my-perch-hint'
    element.setAttribute('aria-hidden', 'true')
    element.style.display = 'none'
    document.body.appendChild(element)
    this.element = element
  }

  show(candidate: PerchCandidate): void {
    const width = Math.max(1, Math.round(candidate.segmentX2 - candidate.segmentX1))
    this.element.style.display = 'block'
    this.element.style.left = `${Math.round(candidate.segmentX1)}px`
    this.element.style.top = `${Math.round(candidate.top) - 1}px`
    this.element.style.width = `${width}px`
    this.element.dataset['perch'] = 'window'
  }

  hide(): void {
    if (this.element.style.display === 'none') return
    this.element.style.display = 'none'
    delete this.element.dataset['perch']
  }

  destroy(): void {
    this.element.remove()
  }
}
