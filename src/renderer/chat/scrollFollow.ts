/** 距底不超过这个距离且没有向上滚动时，才继续自动吸底。 */
export const FOLLOW_EPSILON_PX = 8

export interface ScrollFollowInput {
  previousScrollTop: number
  scrollTop: number
  distanceToBottom: number
}

/**
 * 用户滚动后是否继续保持自动吸底。
 *
 * 关键点：任何向上滚动（哪怕只拖了 1px）都立即释放跟随，而不是像旧的
 * “距底 < 90px 就算在底部”那样，让滑条的小幅拖动继续被流式 delta 拉回。
 * 只有再次真正回到底部附近才重新跟随。
 */
export function shouldFollowAfterScroll(input: ScrollFollowInput): boolean {
  const { previousScrollTop, scrollTop, distanceToBottom } = input
  if (
    !Number.isFinite(previousScrollTop) ||
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(distanceToBottom)
  ) {
    return false
  }
  if (scrollTop < previousScrollTop - 0.5) return false
  return distanceToBottom <= FOLLOW_EPSILON_PX
}
