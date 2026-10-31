import type { BiliSessionReportView, PetBiliReportEvent } from '../shared/bilibili'
import { toPetBiliReportEvent } from '../shared/bilibili'
import { canShowPetBubble } from './status'

/**
 * B 站一轮阅读的唯一投递路径。
 *
 * sink 刻意只有“写聊天记录”和“发桌宠迷你卡”两个能力，没有打开窗口的入口；
 * 这样任何可用性组合下都不可能因为分享卡而弹出完整聊天窗。桌宠不可见时
 * 报告只静默写进聊天记录，等用户下次打开聊天再补看。
 */
export interface BiliReportAvailability {
  petEnabled: boolean
  petVisible: boolean
  petReady: boolean
}

export interface BiliReportSink {
  sendToChat(report: BiliSessionReportView): void
  sendToPet(event: PetBiliReportEvent): void
}

export function deliverBiliReport(
  report: BiliSessionReportView,
  availability: BiliReportAvailability,
  sink: BiliReportSink
): void {
  sink.sendToChat(report)
  if (!canShowPetBubble(availability)) return
  const event = toPetBiliReportEvent(report)
  if (event !== null) sink.sendToPet(event)
}
