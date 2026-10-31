/**
 * 自主/陪伴唤醒的共享类型。
 *
 * 单独放在 shared/ 是为了让渲染进程也能引用 CoreApi 的类型，而不把
 * WakeGovernor 的 Node 依赖（StateStore/util）带进 web 工程。
 */

/**
 * 三条主动路径各自计数：
 * - autonomy：自主探索 tick；
 * - companion：定时闲聊；
 * - reaction：真实活动/页面/窗口变化触发的即时反馈。
 */
export type WakeKind = 'autonomy' | 'companion' | 'reaction'

export type WakeDecisionReason =
  | 'eligible'
  | 'ambient'
  | 'disabled'
  | 'paused'
  | 'busy'
  | 'quiet'
  | 'speech-quiet'
  | 'gap'
  | 'user-cooldown'
  | 'reminder'
  | 'expired'

export interface WakeDecision {
  mode: 'flush' | 'piggyback'
  reason: WakeDecisionReason
  /** piggyback 时建议重新评估的时刻；null 表示无需额外定时。 */
  deferredAt: number | null
}
