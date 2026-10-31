import type { ApprovalRequest } from '../../core/types'

/**
 * bootstrap 与本地实时审批合并。current 里的对象始终优先。
 *
 * 当 bootstrap 的 id 序列与 current 完全一致时返回原数组，避免窗口 focus
 * 触发的 refresh 制造新引用、进而让滚动 effect 误以为有新内容。审批对象
 * 创建后不再原地更新，因此保留 current 不会丢掉新字段。
 */
export function mergeApprovals(
  fromBootstrap: ApprovalRequest[],
  current: ApprovalRequest[]
): ApprovalRequest[] {
  if (fromBootstrap.length === current.length) {
    let same = true
    for (let index = 0; index < current.length; index += 1) {
      if (fromBootstrap[index]?.id !== current[index]?.id) {
        same = false
        break
      }
    }
    if (same) return current
  }

  const map = new Map<string, ApprovalRequest>()
  for (const request of fromBootstrap) map.set(request.id, request)
  for (const request of current) map.set(request.id, request)
  return [...map.values()]
}
