import type { PerchGeometryView, PerchSegmentView, PerchWindowView } from '../../shared/ipc'
import { visibleTopSegments, type PerchRawWindow } from './geometry'

/**
 * 物理像素几何 → 渲染端使用的 DIP 联合工作区坐标。
 *
 * 纯函数，便于在 Node 单测里模拟负坐标、跨屏与混合 DPI：
 * - 遮挡与上沿切分先在物理坐标里完成（Z 序关系只在那里成立）；
 * - 每段按显示器边界切开后各自调用 `toDip`，避免一段矩形跨不同缩放时被
 *   错误地整体换算；
 * - 最后裁剪到所有显示器工作区的并集，并减去并集原点。
 */

export interface PerchRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PerchConvertDisplay {
  /** DIP 下的显示器 bounds（Electron screen API）。 */
  boundsDip: PerchRect
  /** 同一显示器换算到物理像素后的 bounds。 */
  boundsPhysical: PerchRect
}

export interface PerchConvertContext {
  /** 所有显示器工作区并集（DIP）。 */
  unionDip: PerchRect
  displays: readonly PerchConvertDisplay[]
  /** 物理像素矩形 → DIP；由 Electron `screen.screenToDipRect` 提供。 */
  toDip: (rect: PerchRect) => PerchRect
}

interface Piece {
  x1: number
  x2: number
}

const MIN_PIECE_WIDTH = 1
const MIN_SEGMENT_WIDTH_DIP = 6
const MERGE_GAP_DIP = 2
const TOP_TOLERANCE_DIP = 1

export function convertPerchSnapshot(
  raw: readonly PerchRawWindow[],
  context: PerchConvertContext
): PerchWindowView[] {
  const union = context.unionDip
  if (union.width <= 0 || union.height <= 0) return []

  const segmented = visibleTopSegments(raw, { minSegmentWidth: 8, minGap: 1 })
  const output: PerchWindowView[] = []

  for (const window of segmented) {
    if (!window.support || window.id === '' || window.segments.length === 0) continue

    interface Group {
      top: number
      height: number
      segments: Piece[]
    }
    const groups = new Map<number, Group>()

    for (const piece of splitByDisplays(window, context.displays)) {
      const physical: PerchRect = {
        x: piece.x1,
        y: window.y,
        width: piece.x2 - piece.x1,
        height: Math.max(1, window.height)
      }
      const dip = context.toDip(physical)
      if (!isFiniteRect(dip) || dip.width < MIN_PIECE_WIDTH) continue
      // 上沿不在并集垂直范围内时不可停留（例如窗口整体在屏幕外）。
      if (
        dip.y < union.y - TOP_TOLERANCE_DIP ||
        dip.y > union.y + union.height + TOP_TOLERANCE_DIP
      ) {
        continue
      }
      const left = Math.max(union.x, dip.x)
      const right = Math.min(union.x + union.width, dip.x + dip.width)
      if (right - left < MIN_PIECE_WIDTH) continue

      const key = Math.round(dip.y)
      const group = groups.get(key)
      if (group === undefined) {
        groups.set(key, {
          top: dip.y,
          height: Math.max(1, Math.min(20_000, dip.height)),
          segments: [{ x1: left, x2: right }]
        })
      } else {
        group.segments.push({ x1: left, x2: right })
        group.height = Math.max(group.height, Math.min(20_000, dip.height))
      }
    }

    const built: Array<{ view: PerchWindowView; height: number }> = []
    for (const group of [...groups.values()].sort((a, b) => a.top - b.top)) {
      const segments = mergePieces(group.segments).filter(
        (segment) => segment.x2 - segment.x1 >= MIN_SEGMENT_WIDTH_DIP
      )
      if (segments.length === 0) continue
      const x1 = Math.min(...segments.map((segment) => segment.x1))
      const x2 = Math.max(...segments.map((segment) => segment.x2))
      const viewSegments: PerchSegmentView[] = segments.map((segment) => ({
        x1: segment.x1 - union.x,
        x2: segment.x2 - union.x
      }))
      built.push({
        height: group.height,
        view: {
          id: window.id,
          x: x1 - union.x,
          y: group.top - union.y,
          width: x2 - x1,
          height: Math.max(1, group.height),
          top: group.top - union.y,
          segments: viewSegments,
          foreground: window.foreground
        }
      })
    }

    // 同一物理窗口跨了不同缩放的屏幕时，按上沿拆成多条记录；
    // id 加后缀保证渲染端按 id 追踪时不会把两段混在一起。
    built.forEach((entry, index) => {
      const view: PerchWindowView =
        built.length > 1 ? { ...entry.view, id: `${window.id}~${index}` } : entry.view
      output.push(view)
    })
  }

  return output
}

/** 把上沿区间按显示器物理边界切开；只保留窗口上沿确实落在该屏内的部分。 */
function splitByDisplays(
  window: { y: number; height: number; segments: readonly PerchSegmentView[] },
  displays: readonly PerchConvertDisplay[]
): Piece[] {
  const fallback: Piece[] = window.segments.map((segment) => ({
    x1: segment.x1,
    x2: segment.x2
  }))
  if (displays.length === 0) return fallback

  const pieces: Piece[] = []
  for (const segment of window.segments) {
    for (const display of displays) {
      const bounds = display.boundsPhysical
      if (window.y < bounds.y || window.y >= bounds.y + bounds.height) continue
      const x1 = Math.max(segment.x1, bounds.x)
      const x2 = Math.min(segment.x2, bounds.x + bounds.width)
      if (x2 - x1 >= MIN_PIECE_WIDTH) pieces.push({ x1, x2 })
    }
  }
  if (pieces.length === 0) return fallback
  return pieces.sort((a, b) => a.x1 - b.x1 || a.x2 - b.x2)
}

function mergePieces(pieces: readonly Piece[]): Piece[] {
  if (pieces.length <= 1) return pieces.map((piece) => ({ ...piece }))
  const sorted = [...pieces].sort((a, b) => a.x1 - b.x1)
  const merged: Piece[] = []
  for (const piece of sorted) {
    const last = merged[merged.length - 1]
    if (last === undefined || piece.x1 - last.x2 > MERGE_GAP_DIP) {
      merged.push({ ...piece })
    } else if (piece.x2 > last.x2) {
      last.x2 = piece.x2
    }
  }
  return merged
}

function isFiniteRect(rect: PerchRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  )
}

/** 空几何（助手不可用时）使用同一个视图形状，便于渲染端统一处理。 */
export function emptyPerchGeometry(
  seq: number,
  at: number,
  reason: string | null
): PerchGeometryView {
  return { version: 1, seq, at, windows: [], unavailableReason: reason }
}
