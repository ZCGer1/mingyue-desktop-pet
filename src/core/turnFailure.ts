import type {
  ProviderFailureNotice,
  TurnFailure,
  TurnFailureKind,
  TurnRecoveryState
} from './types'

/**
 * 失败归类只依赖工具名、回执开头的错误码和 Provider 通知。
 * 不读取回执正文、参数、路径或页面内容，结果可以安全进入状态条与诊断。
 */

const AUTHORIZATION_HINTS =
  /DENIED|CAPABILITY|NOT_ALLOWED|DISABLED|CONSENT|SCOPE|UNAUTHORIZED|APPROVAL|PERMISSION/
const TARGET_HINTS =
  /NOT_FOUND|STALE|UNAVAILABLE|EMPTY|MISSING|BAD_ARGS|OUTSIDE|INVALID|EXPIRED/
const CANCEL_HINTS = /ABORTED|SKIPPED|CANCELLED|CANCELED/

/** 回执开头的 `[CODE]`；没有时用通用工具失败。 */
export function toolFailureCode(text: string): string {
  const match = /\[([A-Z][A-Z0-9_]{1,63})\]/.exec(text)
  return match?.[1] ?? 'TOOL_FAILED'
}

export function classifyToolFailure(code: string): {
  kind: TurnFailureKind
  recoveryState: TurnRecoveryState
  retryable: boolean
} {
  if (CANCEL_HINTS.test(code)) {
    return { kind: 'cancelled', recoveryState: 'not-needed', retryable: false }
  }
  if (AUTHORIZATION_HINTS.test(code)) {
    return { kind: 'authorization', recoveryState: 'needs-user', retryable: false }
  }
  if (TARGET_HINTS.test(code)) {
    return { kind: 'target', recoveryState: 'needs-user', retryable: false }
  }
  return { kind: 'tool', recoveryState: 'retryable', retryable: true }
}

/** 429/5xx/网络等可重试；协议阻断与配置缺失需要单独处理。 */
export function providerRecovery(notice: {
  code: string
  retryable: boolean
}): TurnRecoveryState {
  if (notice.code === 'PROTOCOL_BLOCKED') return 'blocked'
  if (notice.code === 'NO_API_KEY') return 'needs-user'
  return notice.retryable ? 'retryable' : 'needs-user'
}

export function providerFailure(
  notice: ProviderFailureNotice,
  completed: readonly string[]
): TurnFailure {
  const kind: TurnFailureKind =
    notice.code === 'PROTOCOL_BLOCKED'
      ? 'protocol'
      : notice.code === 'NO_API_KEY'
        ? 'config'
        : 'provider'
  const stage =
    notice.stage === 'model-request'
      ? 'model-request'
      : notice.stage === 'stream'
        ? 'model-stream'
        : notice.stage === 'handoff'
          ? 'handoff'
          : 'other'
  return {
    kind,
    stage,
    errorCode: notice.code,
    recoveryState: providerRecovery(notice),
    retryable: notice.retryable,
    completed: [...completed],
    partial: completed.length > 0,
    reason: notice.reason
  }
}

/** 同一故障指纹：只合并同类、同来源、同阶段的重复提示。 */
export function sameFailure(a: TurnFailure | null, b: TurnFailure | null): boolean {
  if (a === null || b === null) return false
  return a.kind === b.kind && a.stage === b.stage && a.errorCode === b.errorCode
}

export function cancelledFailure(
  reason: string,
  completed: readonly string[]
): TurnFailure {
  return {
    kind: 'cancelled',
    stage: 'cancel',
    errorCode: 'TURN_CANCELLED',
    recoveryState: 'not-needed',
    retryable: false,
    completed: [...completed],
    partial: completed.length > 0,
    reason
  }
}

export function roundCapFailure(completed: readonly string[]): TurnFailure {
  return {
    kind: 'round-cap',
    stage: 'round-limit',
    errorCode: 'ROUND_CAP',
    recoveryState: 'retryable',
    retryable: true,
    completed: [...completed],
    partial: completed.length > 0,
    reason: '已达到本轮工具调用轮数上限，进展已保留，可以继续'
  }
}

export function toolTurnFailure(
  tool: string,
  code: string,
  completed: readonly string[]
): TurnFailure {
  const classified = classifyToolFailure(code)
  return {
    ...classified,
    stage: 'tools',
    errorCode: code,
    completed: [...completed],
    partial: completed.length > 0,
    reason: `工具 ${tool} 没有完成（${code}）`
  }
}

/** 运行时自身异常：不是模型选择沉默，也不能冒充某个工具失败。 */
export function internalFailure(
  reason: string,
  completed: readonly string[]
): TurnFailure {
  return {
    kind: 'internal',
    stage: 'other',
    errorCode: 'TURN_INTERNAL',
    recoveryState: 'retryable',
    retryable: true,
    completed: [...completed],
    partial: completed.length > 0,
    reason
  }
}

/** 用户可见的短标签；后台失败不冒充用户刚执行的操作。 */
export function failureLabel(failure: TurnFailure, userInitiated: boolean): string {
  const prefix = userInitiated ? '' : '后台'
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
