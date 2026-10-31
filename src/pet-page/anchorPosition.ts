import type { PetAnchor } from '../shared/dshPet/layout'

/**
 * 快捷输入的屏幕定位。优先放在桌宠身体右侧，其次左侧，空间都不够时放到头顶；
 * 头顶也放不下再落到脚下。所有结果都会被夹回当前视口。
 */
export interface AnchorPosition {
  left: number
  top: number
}

export interface AnchorViewport {
  width: number
  height: number
}

const MARGIN = 8
const ANCHOR_GAP = 14

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

export function computeAnchorPosition(
  anchor: PetAnchor | null,
  size: { width: number; height: number },
  viewport: AnchorViewport
): AnchorPosition {
  const { width, height } = size
  const maxLeft = Math.max(MARGIN, viewport.width - width - MARGIN)
  const maxTop = Math.max(MARGIN, viewport.height - height - MARGIN)
  let left = maxLeft
  let top = maxTop

  if (anchor !== null) {
    const box = anchor.box
    const rightRoom = viewport.width - (box.x + box.w) - ANCHOR_GAP - MARGIN
    const leftRoom = box.x - ANCHOR_GAP - MARGIN
    const headTop = clamp(anchor.bubble.y - 48, MARGIN, maxTop)
    if (rightRoom >= width) {
      left = box.x + box.w + ANCHOR_GAP
      top = headTop
    } else if (leftRoom >= width) {
      left = box.x - ANCHOR_GAP - width
      top = headTop
    } else {
      left = clamp(box.x + box.w / 2 - width / 2, MARGIN, maxLeft)
      const above = anchor.bubble.y - ANCHOR_GAP - height
      top = above >= MARGIN ? above : clamp(box.y + box.h + ANCHOR_GAP, MARGIN, maxTop)
    }
  }

  return {
    left: Math.round(clamp(left, MARGIN, maxLeft)),
    top: Math.round(clamp(top, MARGIN, maxTop))
  }
}
