import type { TurnFailureView } from './ipc'

/**
 * 失败提示的本地文案。只消费脱敏后的 TurnFailureView：没有回复正文、
 * 工具参数、路径或页面内容；主进程状态条与聊天窗共用同一套分型。
 */

export function turnFailureLabel(failure: TurnFailureView): string {
  const prefix = failure.userInitiated ? '' : '后台'
  switch (failure.kind) {
    case 'provider':
      return `${prefix}模型请求失败`
    case 'protocol':
      return `${prefix}会话请求被暂停`
    case 'config':
      return '还没有配置 API Key'
    case 'authorization':
      return `${prefix}缺少授权，操作未完成`
    case 'target':
      return `${prefix}目标已失效或不存在`
    case 'tool':
      return `${prefix}工具没有完成`
    case 'round-cap':
      return '达到本轮上限，进展已保留'
    case 'cancelled':
      return '已停止这一轮'
    case 'internal':
      return `${prefix}运行时遇到内部错误`
  }
}

function recoveryHint(failure: TurnFailureView): string {
  switch (failure.recoveryState) {
    case 'retryable':
      return failure.kind === 'round-cap' ? '可以继续说“继续”' : '可以直接重试'
    case 'needs-user':
      return failure.kind === 'config'
        ? '到设置 → 模型里填写 Key'
        : failure.kind === 'authorization'
          ? '补充授权后再试'
          : '需要你确认目标或配置后再试'
    case 'blocked':
      return '已暂停这条请求，请清理会话或重启后再试'
    case 'not-needed':
      return ''
  }
}

/** 聊天提示：说清楚哪一步没成功、已经做到什么、是否可恢复。 */
export function turnFailureNote(failure: TurnFailureView): string {
  const parts = [turnFailureLabel(failure)]
  if (failure.partial && failure.completed.length > 0) {
    parts.push(`已完成：${failure.completed.slice(0, 6).join('、')}`)
  }
  if (failure.repeatCount > 1) {
    parts.push(
      `同类问题连续第 ${failure.repeatCount} 次（首次 ${new Date(failure.firstAt).toLocaleTimeString()}）`
    )
  }
  const hint = recoveryHint(failure)
  if (hint !== '') parts.push(hint)
  return parts.join('；')
}

/** 诊断页的详细行；错误码与阶段给可复现的定位，不包含请求正文。 */
export function turnFailureDiagnosticLine(failure: TurnFailureView): string {
  const parts = [
    turnFailureLabel(failure),
    `${failure.kind}/${failure.stage}/${failure.errorCode}`
  ]
  if (failure.repeatCount > 1) parts.push(`×${failure.repeatCount}`)
  if (failure.reason !== '') parts.push(failure.reason)
  return parts.join(' · ')
}
