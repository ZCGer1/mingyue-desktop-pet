import { CANVAS_H, FEET_Y, HIT_BOX } from './constants'
import type { Corner, Rect } from './types'
import { anchorPixel } from './motion'
import { clampPointToRegion, nearestIndex, rectAtPoint } from './displays'
import type { PetDisplayView, PetSavedPositionView } from '../ipc'

/**
 * 桌宠页的几何模型。
 *
 * 上游把舞台整体下移 `bottomPad`，让视频画布的脚底线（330/360）落在根盒
 * 底边；本移植保持这个偏移，但**拖拽时也不移除它**，于是页面里只有一个
 * 稳定坐标：`BodyBox` = 视频盒内实际身体所占的包围盒（宽 size、高
 * size×9/16），脚底 = body.y + height。视频本身画在 body.y + bottomPad 处，
 * 下方多出的底边透明区不影响命中。
 *
 * 所有函数都是纯计算，输入是主进程给出的显示器工作区（相对桌宠窗口并集）
 * 与保存比例；负坐标、混合 DPI、任务栏留白和屏间空洞都不会被悄悄当成
 * 一个外接矩形。
 */

export interface Point {
  x: number
  y: number
}

export interface BodyBox {
  x: number
  y: number
  w: number
  h: number
}

/** PetOverlay / QuickInput 共用的锚点：气泡头顶与身体盒。 */
export interface PetAnchor {
  bubble: Point
  box: { x: number; y: number; w: number; h: number }
}

export interface HitBox {
  x: number
  y: number
  w: number
  h: number
}

export interface PetMetrics {
  size: number
  width: number
  height: number
  bottomPad: number
  halfW: number
  halfH: number
  /** 身体相对视频盒左右各内缩的透明边余量。 */
  sideAllow: number
  /** 命中框相对 body 盒左上角的偏移。 */
  hit: { left: number; top: number; width: number; height: number }
}

export interface LegacyStoredPosition {
  displayId: string
  xRatio: number
  yRatio: number
}

export function createMetrics(size: number): PetMetrics {
  const safe = Number.isFinite(size) ? Math.max(96, Math.min(960, Math.round(size))) : 462
  const width = safe
  const height = (safe * 9) / 16
  const bottomPad = (height * (CANVAS_H - FEET_Y)) / CANVAS_H
  return {
    size: safe,
    width,
    height,
    bottomPad,
    halfW: width / 2,
    halfH: height / 2,
    sideAllow: (HIT_BOX.x0 / 640) * width,
    hit: {
      left: (HIT_BOX.x0 / 640) * width,
      top: bottomPad + (HIT_BOX.y0 / 360) * height,
      width: ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * width,
      height: ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * height
    }
  }
}

export function bodyFromCenter(cx: number, cy: number, metrics: PetMetrics): BodyBox {
  return { x: cx - metrics.halfW, y: cy - metrics.halfH, w: metrics.width, h: metrics.height }
}

export function bodyFromFeet(centerX: number, feetY: number, metrics: PetMetrics): BodyBox {
  return { x: centerX - metrics.halfW, y: feetY - metrics.height, w: metrics.width, h: metrics.height }
}

export function bodyCenter(body: BodyBox): Point {
  return { x: body.x + body.w / 2, y: body.y + body.h / 2 }
}

export function feetPoint(body: BodyBox): Point {
  return { x: body.x + body.w / 2, y: body.y + body.h }
}

export function hitBoxFor(body: BodyBox, metrics: PetMetrics): HitBox {
  return {
    x: body.x + metrics.hit.left,
    y: body.y + metrics.hit.top,
    w: metrics.hit.width,
    h: metrics.hit.height
  }
}

export function isPointOnBody(body: BodyBox, metrics: PetMetrics, point: Point): boolean {
  const hit = hitBoxFor(body, metrics)
  return (
    point.x >= hit.x && point.x <= hit.x + hit.w && point.y >= hit.y && point.y <= hit.y + hit.h
  )
}

/** 气泡锚点：命中框顶部中央（头顶），box = 身体盒。 */
export function anchorFor(body: BodyBox, metrics: PetMetrics): PetAnchor {
  return {
    bubble: { x: body.x + metrics.halfW, y: body.y + metrics.hit.top },
    box: { x: body.x, y: body.y, w: body.w, h: body.h }
  }
}

export function displayRect(display: PetDisplayView): Rect {
  return { x: display.x, y: display.y, width: display.width, height: display.height }
}

export function displayRects(displays: readonly PetDisplayView[]): Rect[] {
  return displays.map(displayRect)
}

export function displayById(
  displays: readonly PetDisplayView[],
  id: string | null
): PetDisplayView | null {
  if (id === null) return null
  return displays.find((display) => display.id === id) ?? null
}

export function primaryDisplay(displays: readonly PetDisplayView[]): PetDisplayView | null {
  return displays.find((display) => display.primary) ?? displays[0] ?? null
}

/** 点所在屏；空洞/屏外时取最近屏幕。 */
export function displayForPoint(
  displays: readonly PetDisplayView[],
  point: Point
): PetDisplayView | null {
  if (displays.length === 0) return null
  const rects = displayRects(displays)
  const hit = rectAtPoint(rects, point.x, point.y)
  if (hit !== null) {
    const index = rects.indexOf(hit)
    return displays[index] ?? null
  }
  const index = nearestIndex(rects, point.x, point.y)
  return index >= 0 ? (displays[index] ?? null) : null
}

/** 脚底所在屏优先，其次身体中心；用于保存位置与跨屏判定。 */
export function displayForBody(
  displays: readonly PetDisplayView[],
  body: BodyBox
): PetDisplayView | null {
  return (
    displayForPoint(displays, feetPoint(body)) ?? displayForPoint(displays, bodyCenter(body))
  )
}

export function clampBodyToArea(body: BodyBox, area: PetDisplayView, metrics: PetMetrics): BodyBox {
  // 身体（不是视频盒）贴边：左右允许伸进视频的透明边。
  const minX = area.x - metrics.sideAllow
  const maxX = area.x + area.width - metrics.width + metrics.sideAllow
  const minY = area.y
  const maxY = area.y + area.height - metrics.height
  const x = clamp(body.x, minX, maxX)
  const y = clamp(body.y, minY, maxY)
  return { x, y, w: metrics.width, h: metrics.height }
}

/** 把身体夹回某块屏；落在屏间空洞时先找最近屏。 */
export function clampBodyToDisplays(
  body: BodyBox,
  displays: readonly PetDisplayView[],
  metrics: PetMetrics
): BodyBox {
  const display = displayForBody(displays, body)
  if (display === null) return body
  return clampBodyToArea(body, display, metrics)
}

export function feetOnFloor(
  body: BodyBox,
  area: PetDisplayView,
  metrics: PetMetrics
): BodyBox {
  const center = bodyCenter(body)
  return clampBodyToArea(
    bodyFromFeet(center.x, area.y + area.height, metrics),
    area,
    metrics
  )
}

/** 初始角落位置（主屏，否则第一块屏）。 */
export function homeBody(
  home: { corner: Corner; marginX: number; marginY: number },
  displays: readonly PetDisplayView[],
  metrics: PetMetrics,
  viewport: { width: number; height: number }
): BodyBox {
  const display = primaryDisplay(displays)
  const area: Rect =
    display === null
      ? { x: 0, y: 0, width: viewport.width, height: viewport.height }
      : displayRect(display)
  const pixel = anchorPixel({
    corner: home.corner,
    marginX: home.marginX,
    marginY: home.marginY,
    size: metrics.size,
    W: viewport.width,
    H: viewport.height,
    area
  })
  const body = { x: pixel.x, y: pixel.y, w: metrics.width, h: metrics.height }
  return display === null
    ? body
    : clampBodyToArea(body, display, metrics)
}

/**
 * 保存比例 → 页面身体盒。
 * xRatio = 身体中心 / 工作区宽；feetRatio = 脚底 / 工作区高。
 */
export function bodyFromSaved(
  saved: PetSavedPositionView,
  displays: readonly PetDisplayView[],
  metrics: PetMetrics,
  viewport: { width: number; height: number }
): BodyBox {
  const display =
    displayById(displays, saved.displayId) ?? primaryDisplay(displays) ?? null
  const area: Rect =
    display === null
      ? { x: 0, y: 0, width: viewport.width, height: viewport.height }
      : displayRect(display)
  const xRatio = clamp(saved.xRatio, 0, 1)
  const feetRatio = clamp(saved.feetRatio, 0, 1)
  const body = bodyFromFeet(
    area.x + area.width * xRatio,
    area.y + area.height * feetRatio,
    metrics
  )
  return display === null
    ? body
    : clampBodyToArea(body, display, metrics)
}

export function savedFromBody(
  body: BodyBox,
  displays: readonly PetDisplayView[],
  facing: 'left' | 'right',
  now: number
): PetSavedPositionView | null {
  const display = displayForBody(displays, body)
  if (display === null) return null
  const center = bodyCenter(body)
  const feet = feetPoint(body)
  const xRatio = clamp((center.x - display.x) / display.width, 0, 1)
  const feetRatio = clamp((feet.y - display.y) / display.height, 0, 1)
  return { displayId: display.id, xRatio, feetRatio, facing, savedAt: now }
}

/** 旧版 localStorage 位置；旧运行时读取时忽略 yRatio，始终落到该屏底边。 */
export function parseLegacyStoredPosition(raw: string | null): LegacyStoredPosition | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const displayId = record['displayId']
    const xRatio = Number(record['xRatio'])
    const yRatio = Number(record['yRatio'])
    if (typeof displayId !== 'string' || displayId === '') return null
    if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio)) return null
    return { displayId, xRatio: clamp(xRatio, 0, 1), yRatio: clamp(yRatio, 0, 1) }
  } catch {
    return null
  }
}

/** 旧位置迁移：保留屏与横向比例，脚落回该屏底边（旧运行时就是这个语义）。 */
export function bodyFromLegacy(
  legacy: LegacyStoredPosition,
  displays: readonly PetDisplayView[],
  metrics: PetMetrics
): BodyBox | null {
  const display =
    displayById(displays, legacy.displayId) ?? primaryDisplay(displays) ?? null
  if (display === null) return null
  const x = display.x + display.width * legacy.xRatio
  return feetOnFloor(bodyFromFeet(x, display.y + display.height, metrics), display, metrics)
}

/**
 * 抛掷/弹簧位移时保证脚不会踩进屏间空洞：
 * 返回离当前包围盒最近的合法 body 位置（拖动过程本身不夹取，
 * 只在落定/窗口变化时调用）。
 */
export function nearestLegalBody(
  body: BodyBox,
  displays: readonly PetDisplayView[],
  metrics: PetMetrics
): BodyBox {
  if (displays.length === 0) return body
  const center = bodyCenter(body)
  const rects = displayRects(displays)
  const hit = rectAtPoint(rects, center.x, center.y)
  if (hit !== null && hit.width >= metrics.width && hit.height >= metrics.height) {
    const index = rects.indexOf(hit)
    const display = displays[index]
    return display === undefined ? body : clampBodyToArea(body, display, metrics)
  }
  const nearest = clampPointToRegion(rects, center.x, center.y)
  const display = displayForPoint(displays, nearest)
  if (display === null) return body
  const moved = {
    ...body,
    x: nearest.x - metrics.halfW,
    y: nearest.y - metrics.halfH
  }
  return clampBodyToArea(moved, display, metrics)
}

/** 当前所在显示器在 displays 数组里的索引（confineToScreen 抛掷锁定用）。 */
export function displayIndexForBody(
  displays: readonly PetDisplayView[],
  body: BodyBox
): number {
  if (displays.length === 0) return -1
  const feet = feetPoint(body)
  const rects = displayRects(displays)
  const exact = rects.findIndex(
    (rect) =>
      feet.x >= rect.x &&
      feet.x < rect.x + rect.width &&
      feet.y >= rect.y &&
      feet.y < rect.y + rect.height
  )
  if (exact >= 0) return exact
  return nearestIndex(rects, feet.x, feet.y)
}

export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}
