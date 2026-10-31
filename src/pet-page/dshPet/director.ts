import type {
  PetAgentStatusView,
  PetSayEvent,
  QuickChatEvent,
  QuickChatSnapshot
} from '../../shared/ipc'
import type { PetBiliReportEvent } from '../../shared/bilibili'
import type { PetController } from './controller'
import type { PetOverlay } from '../overlay'

/**
 * 主进程事件 → 气泡 / 状态条 / 唯一动画控制器。
 *
 * 这里不再有第二套表情词表：工作状态直接进入 dsh-pet 的真实动画池，
 * 主动说话只在事件携带已验证的显式点播时调用控制器。快捷聊天的
 * turnId/seq 守卫与重载续接与旧版一致。
 */

/** 快捷回复气泡停留时间：随长度增加，但限制在 6–20 秒。 */
export function quickBubbleTtlMs(text: string): number {
  return Math.max(6000, Math.min(20_000, text.length * 120))
}

export class PetDirector {
  private readonly overlay: PetOverlay
  private readonly controller: PetController
  private destroyed = false
  private quickTurnId: string | null = null
  private quickSeq = -1
  private quickText = ''
  private lastQuickDoneId: string | null = null

  constructor(overlay: PetOverlay, controller: PetController) {
    this.overlay = overlay
    this.controller = controller
  }

  handleStatus(status: PetAgentStatusView): void {
    if (this.destroyed) return
    this.overlay.setStatus(status)
    this.controller.handleWorkStatus(status)
  }

  /** 返回气泡是否真的显示；供页面回执，而不是仅确认收到 IPC。 */
  handleSay(event: PetSayEvent): boolean {
    if (this.destroyed) return false
    const displayed = this.overlay.showSay(event)
    if (event.animation !== undefined) this.controller.request(event.animation)
    return displayed
  }

  /** B 站本轮阅读迷你卡；不触发任何动画或模型上下文。 */
  handleBiliReport(event: PetBiliReportEvent): void {
    if (this.destroyed) return
    this.overlay.showBiliReport(event)
  }

  /** 无气泡的显式点播（pet_act / pet_emote / reaction）。 */
  handleAnimation(event: { request: Parameters<PetController['request']>[0] }): void {
    if (this.destroyed) return
    this.controller.request(event.request)
  }

  handleQuickEvent(event: QuickChatEvent): void {
    if (this.destroyed) return
    switch (event.type) {
      case 'start':
        this.quickTurnId = event.id
        this.quickSeq = -1
        this.quickText = ''
        this.overlay.beginStreamingSay()
        return
      case 'delta':
        if (event.id !== this.quickTurnId || event.seq <= this.quickSeq) return
        this.quickSeq = event.seq
        this.quickText = event.text
        this.overlay.updateStreamingSay(event.text)
        return
      case 'done': {
        if (this.quickTurnId !== null && event.id !== this.quickTurnId) return
        this.lastQuickDoneId = event.id
        this.resetQuickTurn()
        this.overlay.endStreamingSay(event.text, quickBubbleTtlMs(event.text))
        return
      }
      case 'error': {
        if (this.quickTurnId !== null && event.id !== this.quickTurnId) return
        const partial = event.text ?? this.quickText
        this.resetQuickTurn()
        if (partial.trim() !== '') this.overlay.endStreamingSay(partial, 6000)
        else this.overlay.clearSay()
        return
      }
      case 'ended':
        this.resetQuickTurn()
        return
      case 'reset':
        this.resetQuickTurn()
        this.overlay.clearSay()
        return
    }
  }

  /**
   * 重载后续接：流式中恢复当前 turn 的气泡；否则在快照里补上
   * 15 秒内刚完成的回复。已有更新 turn 时不回退。
   */
  handleQuickSnapshot(snapshot: QuickChatSnapshot): void {
    if (this.destroyed) return
    if (snapshot.phase === 'streaming' && snapshot.turnId !== null) {
      if (this.quickTurnId === snapshot.turnId) {
        if (snapshot.seq <= this.quickSeq) return
        this.quickSeq = snapshot.seq
        this.quickText = snapshot.text
        if (snapshot.text.trim() !== '') this.overlay.updateStreamingSay(snapshot.text)
        return
      }
      if (this.quickTurnId !== null) return
      this.quickTurnId = snapshot.turnId
      this.quickSeq = snapshot.seq
      this.quickText = snapshot.text
      this.overlay.beginStreamingSay()
      if (snapshot.text.trim() !== '') this.overlay.updateStreamingSay(snapshot.text)
      return
    }
    if (this.quickTurnId !== null) return
    const done = snapshot.lastDone
    if (done === null || done.id === this.lastQuickDoneId) return
    this.lastQuickDoneId = done.id
    this.overlay.endStreamingSay(done.text, quickBubbleTtlMs(done.text))
  }

  destroy(): void {
    this.destroyed = true
  }

  private resetQuickTurn(): void {
    this.quickTurnId = null
    this.quickSeq = -1
    this.quickText = ''
  }
}
