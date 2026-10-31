/**
 * 屏幕陪伴反馈的窄视图与固定原因枚举。
 *
 * 这里只允许 ID、枚举、时间与计数；屏幕摘要、生成台词、图片和 OCR 原文
 * 不得出现在设置页快照、日志或诊断包中。
 */

export type ScreenFeedbackTrigger =
  | 'first_observation'
  | 'meaningful_change'
  | 'quiet_presence'
  | 'manual_test'

export type ScreenFeedbackReason =
  | 'disabled'
  | 'event-sharing-off'
  | 'muted-category'
  | 'quiet-hours'
  | 'speech-quiet'
  | 'busy'
  | 'post-user-cooldown'
  | 'stale'
  | 'target-changed'
  | 'duplicate'
  | 'low-confidence'
  | 'waiting-fresh-scene'
  | 'question-cooldown'
  | 'provider-failed'
  | 'invalid-output'
  | 'sink-unavailable'
  | 'render-failed'
  | 'no-comment'

export type ScreenFeedbackState =
  | 'idle'
  | 'waiting'
  | 'generating'
  | 'queued'
  | 'displayed'
  | 'skipped'
  | 'cancelled'
  | 'failed'

export interface ScreenCompanionStatusView {
  /** 偏好开关本身；不代表当前一定没有其它阻断。 */
  enabled: boolean
  /** 偏好 + 既有许可/开关后的实际可用性。 */
  active: boolean
  state: ScreenFeedbackState
  /** 最近一次评估/阻断的固定原因。 */
  lastReason: ScreenFeedbackReason | null
  /** 当前最主要的阻断原因（不含频率冷却）。 */
  blocker: ScreenFeedbackReason | null
  lastObservationAt: number | null
  lastGeneratedAt: number | null
  /** 只有真实页面回执成功才推进。 */
  lastDisplayedAt: number | null
  lastQuestionAt: number | null
  nextEligibleAt: number | null
  inFlight: boolean
  queued: boolean
  lastFeedbackId: string | null
  lastKind: 'comment' | 'question' | null
  counts: {
    observations: number
    candidates: number
    displayed: number
    skipped: number
    cancelled: number
    failed: number
    questions: number
  }
}

export interface ScreenCompanionTestResultView {
  ok: boolean
  /** 固定枚举：immediate/scheduled/blocked。 */
  mode: 'immediate' | 'scheduled' | 'blocked'
  message: string
}
