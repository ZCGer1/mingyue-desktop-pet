/**
 * 窗口上沿可见区间计算。
 *
 * 输入是辅助组件按 Z 序（最上层在前）返回的物理像素矩形。输出只保留
 * “一段上沿是否被更高层窗口挡住”的几何结果，不涉及标题、文本、进程名或截图。
 * 纯函数便于在单元测试里覆盖负坐标、部分遮挡与完全遮挡。
 */

export interface PerchRawWindow {
  id: string
  x: number
  y: number
  width: number
  height: number
  /** 是否允许作为支撑面；工具窗口/敏感窗口仍参与遮挡，但不输出可停留区间。 */
  support: boolean
  foreground: boolean
}

export interface PerchRawSegment {
  x1: number
  x2: number
}

export interface PerchSegmentedWindow extends PerchRawWindow {
  segments: PerchRawSegment[]
}

interface Interval {
  x1: number
  x2: number
}

/** 上沿线被更高层窗口覆盖时切掉；重叠的遮挡物合并后再计算。 */
function subtractIntervals(intervals: Interval[], blockers: Interval[]): Interval[] {
  if (blockers.length === 0) return intervals
  let current = intervals
  for (const blocker of blockers) {
    if (blocker.x2 <= blocker.x1) continue
    const next: Interval[] = []
    for (const interval of current) {
      if (blocker.x2 <= interval.x1 || blocker.x1 >= interval.x2) {
        next.push(interval)
        continue
      }
      if (blocker.x1 > interval.x1) next.push({ x1: interval.x1, x2: blocker.x1 })
      if (blocker.x2 < interval.x2) next.push({ x1: blocker.x2, x2: interval.x2 })
    }
    current = next
    if (current.length === 0) return []
  }
  return current
}

function mergeIntervals(intervals: Interval[], minGap = 1): Interval[] {
  if (intervals.length <= 1) return intervals
  const sorted = [...intervals].sort((a, b) => a.x1 - b.x1)
  const merged: Interval[] = []
  for (const interval of sorted) {
    const last = merged[merged.length - 1]
    if (last === undefined || interval.x1 - last.x2 > minGap) {
      merged.push({ ...interval })
    } else if (interval.x2 > last.x2) {
      last.x2 = interval.x2
    }
  }
  return merged
}

/**
 * 计算每个可停留窗口的可见上沿。
 *
 * - 输入必须按 Z 序从高到低排列（EnumWindows 的顺序）。
 * - `support=false` 的窗口不产生区间，但仍会遮挡它下面的窗口。
 * - 完全被挡住的窗口 `segments` 为空；调用方应丢弃。
 */
export function visibleTopSegments(
  windows: readonly PerchRawWindow[],
  options: { minSegmentWidth?: number; minGap?: number } = {}
): PerchSegmentedWindow[] {
  const minSegmentWidth = Math.max(1, options.minSegmentWidth ?? 8)
  const minGap = Math.max(0.5, options.minGap ?? 1)
  const result: PerchSegmentedWindow[] = []

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index]
    if (window === undefined) continue
    if (!window.support || window.width <= 0) {
      result.push({ ...window, segments: [] })
      continue
    }
    const blockers: Interval[] = []
    // 更高层窗口：只要它的矩形覆盖这一条上沿线，就会挡住这段。
    for (let above = 0; above < index; above += 1) {
      const other = windows[above]
      if (other === undefined) continue
      const bottom = other.y + other.height
      if (other.y <= window.y && bottom > window.y) {
        blockers.push({ x1: other.x, x2: other.x + other.width })
      }
    }
    const visible = subtractIntervals(
      [{ x1: window.x, x2: window.x + window.width }],
      blockers
    )
    const segments = mergeIntervals(
      visible.filter((interval) => interval.x2 - interval.x1 >= minSegmentWidth),
      minGap
    )
    result.push({ ...window, segments })
  }
  return result
}

/** 上沿上离 x 最近的可见点；没有任何区间时返回 null。 */
export function nearestPointOnSegments(
  segments: readonly PerchRawSegment[],
  x: number
): number | null {
  if (segments.length === 0) return null
  let best: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const segment of segments) {
    const point = Math.min(segment.x2, Math.max(segment.x1, x))
    const distance = Math.abs(point - x)
    if (distance < bestDistance) {
      bestDistance = distance
      best = point
    }
  }
  return best
}
