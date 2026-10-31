import type { TurnReport } from '../core/types'
import type { TurnFailureView } from './ipc'

/**
 * Core 的结构化报告 → 可进入 IPC 的脱敏视图。
 * 正常完成/正常沉默返回 null；用户主动停止仍保留类型，由各入口自行决定
 * 是否把它当成“失败”展示。
 */
export function turnFailureView(report: TurnReport): TurnFailureView | null {
  const failure = report.failure
  if (failure === null) return null
  return {
    turnId: report.turnId,
    at: report.at,
    source: report.source,
    outcome: report.outcome,
    kind: failure.kind,
    stage: failure.stage,
    errorCode: failure.errorCode,
    recoveryState: failure.recoveryState,
    retryable: failure.retryable,
    completed: [...failure.completed],
    partial: failure.partial,
    reason: failure.reason,
    userInitiated: report.userInitiated,
    background: report.background,
    repeatCount: report.repeatCount,
    firstAt: report.firstAt,
    round: report.round
  }
}
