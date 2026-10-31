import type { PerchGeometryView, PerchWindowView } from '../shared/ipc'

/**
 * 窗口上沿停靠的纯几何判断。
 *
 * 坐标全部是桌宠舞台坐标（与 `PerchGeometryView` 一样，原点在显示器工作区并集
 * 左上角）。这里不依赖 DOM，便于覆盖负坐标、遮挡与窗口移动。
 */

export interface PerchCandidate {
  windowId: string
  top: number
  segmentIndex: number
  segmentX1: number
  segmentX2: number
  /** clamp 到可见区间后的脚部 x。 */
  x: number
  /** y 距离越小越优先；已包含水平距离。 */
  score: number
  foreground: boolean
}

export interface PerchBinding {
  windowId: string
  segmentIndex: number
  /** 脚在可见区间内的相对位置（0..1），窗口移动时保持。 */
  ratio: number
}

export interface PerchFollowTarget {
  windowId: string
  top: number
  segmentIndex: number
  segmentX1: number
  segmentX2: number
  x: number
  foreground: boolean
}

/** 上沿至少要给头和身体留出这么多空间，避免最大化窗口把桌宠顶出屏幕。 */
export const PERCH_HEADROOM_RATIO = 0.95
/** 脚距离上沿多远仍算“放到窗口上”。 */
export const PERCH_DROP_TOLERANCE = 28
/** 脚离可见区间水平方向的最大吸附距离。 */
export const PERCH_X_REACH = 48
/** 脚与区间边缘至少留一点，避免半只脚悬空。 */
export const PERCH_EDGE_MARGIN = 8

function clamp(value: number, min: number, max: number): number {
  if (max < min) return (min + max) / 2
  return Math.min(max, Math.max(min, value))
}

function segmentMargin(x1: number, x2: number): number {
  const width = x2 - x1
  return Math.min(PERCH_EDGE_MARGIN, Math.max(0, width / 2 - 1))
}

export function segmentRange(
  segmentX1: number,
  segmentX2: number
): [number, number] {
  const margin = segmentMargin(segmentX1, segmentX2)
  const min = segmentX1 + margin
  const max = segmentX2 - margin
  return max < min ? [segmentX1, segmentX2] : [min, max]
}

/** 落点吸附：脚必须靠近某条可见上沿，且该上沿上方有足够头部空间。 */
export function findPerchCandidate(
  geometry: PerchGeometryView | null,
  feet: { x: number; y: number },
  options: {
    bodyHeight: number
    tolerance?: number
    xReach?: number
  }
): PerchCandidate | null {
  if (geometry === null || geometry.unavailableReason !== null) return null
  const tolerance = options.tolerance ?? PERCH_DROP_TOLERANCE
  const xReach = options.xReach ?? PERCH_X_REACH
  const minTop = options.bodyHeight * PERCH_HEADROOM_RATIO + 4

  let best: PerchCandidate | null = null
  for (const window of geometry.windows) {
    if (window.top < minTop) continue
    const dy = Math.abs(window.top - feet.y)
    if (dy > tolerance) continue
    for (let index = 0; index < window.segments.length; index += 1) {
      const segment = window.segments[index]
      if (segment === undefined) continue
      const dx =
        feet.x < segment.x1 ? segment.x1 - feet.x : feet.x > segment.x2 ? feet.x - segment.x2 : 0
      if (dx > xReach) continue
      const [minX, maxX] = segmentRange(segment.x1, segment.x2)
      const score = dy * 2 + dx + (window.foreground ? 0 : 0.5)
      if (best === null || score < best.score) {
        best = {
          windowId: window.id,
          top: window.top,
          segmentIndex: index,
          segmentX1: segment.x1,
          segmentX2: segment.x2,
          x: clamp(feet.x, minX, maxX),
          score,
          foreground: window.foreground
        }
      }
    }
  }
  return best
}

/** 窗口移动/缩放/被部分遮挡后，重新计算脚应该站在哪里。 */
export function resolveFollow(
  geometry: PerchGeometryView | null,
  binding: PerchBinding,
  xHint: number
): PerchFollowTarget | null {
  if (geometry === null || geometry.unavailableReason !== null) return null
  const window = findWindow(geometry, binding.windowId)
  if (window === null || window.segments.length === 0) return null
  const index = nearestSegmentIndex(window, xHint, binding.segmentIndex)
  const segment = window.segments[index]
  if (segment === undefined) return null
  const [minX, maxX] = segmentRange(segment.x1, segment.x2)
  const ratio = clamp(binding.ratio, 0, 1)
  return {
    windowId: window.id,
    top: window.top,
    segmentIndex: index,
    segmentX1: segment.x1,
    segmentX2: segment.x2,
    x: clamp(segment.x1 + (segment.x2 - segment.x1) * ratio, minX, maxX),
    foreground: window.foreground
  }
}

export function findWindow(
  geometry: PerchGeometryView,
  windowId: string
): PerchWindowView | null {
  return geometry.windows.find((window) => window.id === windowId) ?? null
}

/** 绑定后脚在区间里的相对位置；区间宽度为 0 时退回中点。 */
export function bindingRatio(segmentX1: number, segmentX2: number, x: number): number {
  const width = segmentX2 - segmentX1
  if (width <= 1) return 0.5
  return clamp((x - segmentX1) / width, 0, 1)
}

function nearestSegmentIndex(
  window: PerchWindowView,
  x: number,
  preferred: number
): number {
  for (let index = 0; index < window.segments.length; index += 1) {
    const segment = window.segments[index]
    if (segment !== undefined && x >= segment.x1 && x <= segment.x2) return index
  }
  let best = clamp(preferred, 0, window.segments.length - 1)
  let bestDistance = Number.POSITIVE_INFINITY
  window.segments.forEach((segment, index) => {
    const distance =
      x < segment.x1 ? segment.x1 - x : x > segment.x2 ? x - segment.x2 : 0
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  })
  return best
}
