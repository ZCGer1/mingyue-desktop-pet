import { IPC, type CapabilityGrantView, type ChatActionResult, type TaskView } from '../shared/ipc';
/**
 * 主进程 IPC 白名单（PLAN.md §6）。
 *
 * 每个通道都绑定一个渲染窗口；参数在主进程再次校验。设置页专属通道
 * （API Key、原始活动样本、记忆、诊断）绝不接受聊天/桌宠页调用。
 */
import { asString, asTaskAction, handle } from './ipcSupport';
import type { IpcContext } from './ipcSupport';

export function registerSettingsTasksIpc(ctx: IpcContext): void {
  // 任务视图不含截图、窗口标题或输入文字；设置页只做展示与暂停/恢复/取消。
  handle(ctx, IPC.settingsTasks, 'settings', (): TaskView[] => ctx.bot.taskViews(50))
  handle(ctx, IPC.settingsTaskAction, 'settings', (_event, args): ChatActionResult => {
    const id = asString(args[0], 200)
    const action = asTaskAction(args[1])
    if (id === null || action === null) return { ok: false, message: '任务操作参数无效。' }
    if (action === 'pause') {
      return ctx.bot.pauseTask(id)
        ? { ok: true, message: '任务已暂停。' }
        : { ok: false, message: '任务无法暂停或已结束。' }
    }
    if (action === 'resume') {
      return ctx.bot.resumeTask(id)
        ? { ok: true, message: '任务已恢复。' }
        : { ok: false, message: '任务当前不能恢复。' }
    }
    return ctx.bot.cancelTask(id)
      ? { ok: true, message: '任务已取消，相关授权已撤销。' }
      : { ok: false, message: '任务不存在或已结束。' }
  })
  handle(ctx, IPC.settingsCapabilityGrants, 'settings', (): CapabilityGrantView[] =>
    ctx.bot.capabilityViews()
  )
  handle(ctx, IPC.settingsRevokeCapability, 'settings', (_event, args): ChatActionResult => {
    const id = asString(args[0], 200)
    if (id === null) return { ok: false, message: '授权编号无效。' }
    return ctx.bot.revokeCapability(id)
      ? { ok: true, message: '授权已撤销，正在执行的任务会停下。' }
      : { ok: false, message: '授权不存在或已失效。' }
  })

}
