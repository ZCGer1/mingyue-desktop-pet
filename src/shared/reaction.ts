/**
 * 事件反馈通道的共享通知类型。
 *
 * 它只包含已脱敏的事件字段：目标/证据引用都是不可逆摘要，不携带原始
 * 窗口标题、完整 URL 或进程名。主进程用它做本地即时动作与模型事件对话，
 * 不写会话、不落盘。
 */

export type ReactionAttribution = 'user' | 'pet' | 'uncertain'

export interface ReactiveEventNotice {
  eventId: string
  type: string
  at: number
  changeType: string
  /** 当前活动片段的稳定引用（摘要）；用于去重与过期取消。 */
  targetRef: string | null
  /** 本次变化的证据引用（摘要）；新证据必须产生新的 evidenceRef。 */
  evidenceRef: string
  confidence: number
  expiresAt: number
  /**
   * true 表示这是采样时立即发出的本地注意提示，还没有经过应用切换合并。
   * 同一变化之后仍会作为正式事件派发一次；引用相同，反应层按 evidenceRef
   * 去重，因此本地只播一次，候选统计也不会重复计。
   */
  immediate?: boolean
  actionAttribution: ReactionAttribution
  category?: string | null
  appLabel?: string | null
  hasTitle?: boolean
  /** 细粒度场景阶段（仅 scene_phase 事件），用于选择更贴切的本地动作。 */
  phase?: string | null
  previousPhase?: string | null
  /** 可共享的游戏显示名；仅在用户允许共享 app 名时出现。 */
  game?: string | null
  /** 通用语义变化短句；不含 OCR 原文。 */
  detail?: string | null
  /** 已脱敏、可进入 ephemeral 上下文的事件文本。 */
  text: string
}
