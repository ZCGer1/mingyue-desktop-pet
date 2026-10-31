import { IPC, type ChatActionResult, type ChatSendResult, type TaskView, type UndoResultView } from '../shared/ipc';
import { openBiliVideo } from './biliVideoOpen';
/**
 * 主进程 IPC 白名单（PLAN.md §6）。
 *
 * 每个通道都绑定一个渲染窗口；参数在主进程再次校验。设置页专属通道
 * （API Key、原始活动样本、记忆、诊断）绝不接受聊天/桌宠页调用。
 */
import { asApprovalScope, asBoolean, asCount, asString, chatBootstrap, handle, handleAny, on, openExternalForBili, undoResult } from './ipcSupport';
import type { IpcContext } from './ipcSupport';
const MAX_CHAT_CHARS = 32_000

export function registerChatIpc(ctx: IpcContext): void {
  // ---------------------------------------------------------------- chat / 应用

  handleAny(ctx, IPC.appBootstrap, ['chat'], () => chatBootstrap(ctx))
  handleAny(ctx, IPC.chatRefresh, ['chat'], () => chatBootstrap(ctx))
  handleAny(ctx, IPC.appOpenChat, ['chat', 'settings', 'pet'], () => {
    void ctx.windows.openChat({ activate: true, reason: 'user' })
  })
  handleAny(ctx, IPC.appOpenSettings, ['chat', 'settings', 'pet'], () => {
    ctx.windows.openSettings()
  })
  handleAny(ctx, IPC.appOpenDiagnostics, ['chat', 'settings', 'pet'], () => {
    ctx.windows.openDiagnostics()
  })
  handleAny(ctx, IPC.appQuit, ['chat', 'settings', 'pet'], () => ctx.quit())
  handleAny(ctx, IPC.appSetAutoLaunch, ['chat', 'settings'], (_event, args) => {
    const enabled = asBoolean(args[0])
    return enabled === null ? false : ctx.setAutoLaunch(enabled)
  })

  handleAny(ctx, IPC.chatSend, ['chat'], (_event, args): ChatSendResult => {
    const text = asString(args[0], MAX_CHAT_CHARS)
    if (text === null || text.trim() === '') {
      return { ok: false, message: '消息不能为空。' }
    }
    if (!ctx.bot.running) return { ok: false, message: '助手还没有启动完成。' }
    const { event, discovery } = ctx.bot.sendMessageWithDiscovery(text)
    if (event === null) return { ok: false, message: '助手当前不可用。' }
    return discovery === null ? { ok: true } : { ok: true, discovery }
  })

  handleAny(ctx, IPC.chatStop, ['chat'], () => {
    ctx.bot.stopGeneration()
  })

  handleAny(ctx, IPC.chatResolveApproval, ['chat'], (_event, args): ChatActionResult => {
    const id = asString(args[0], 200)
    const approved = asBoolean(args[1])
    const scope = asApprovalScope(args[2])
    if (id === null || approved === null) return { ok: false, message: '审批参数无效。' }
    const resolved = ctx.bot.resolveApproval(id, approved, scope)
    return resolved
      ? { ok: true, message: approved ? '已允许。' : '已拒绝。' }
      : { ok: false, message: '审批已过期或不存在。' }
  })

  handleAny(ctx, IPC.chatUndo, ['chat'], (_event, args): UndoResultView => {
    return undoResult(ctx.bot.undoLast(asCount(args[0])))
  })

  handleAny(ctx, IPC.chatMarkCleared, ['chat'], () => {
    ctx.bot.markCleared()
  })

  handleAny(ctx, IPC.chatSetPaused, ['chat'], (_event, args) => {
    const paused = asBoolean(args[0])
    if (paused === null) return
    if (paused) ctx.bot.pause('manual')
    else ctx.bot.resume()
    ctx.broadcastStatus()
    ctx.refreshTray()
  })

  // 聊天页可读任务视图；取消只用于审批卡上的「撤销该任务」。
  handle(ctx, IPC.chatTask, 'chat', (): TaskView[] => ctx.bot.taskViews(50))
  handle(ctx, IPC.chatTaskCancel, 'chat', (_event, args): ChatActionResult => {
    const id = asString(args[0], 200)
    if (id === null) return { ok: false, message: '任务编号无效。' }
    return ctx.bot.cancelTask(id)
      ? { ok: true, message: '任务已取消，相关授权已撤销。' }
      : { ok: false, message: '任务不存在或已结束。' }
  })

  // 「本轮阅读」卡与桌宠迷你卡的打开动作共用校验；渲染进程只传 bvid + partIndex。
  handle(ctx, IPC.chatOpenBiliVideo, 'chat', (_event, args): Promise<ChatActionResult> =>
    openBiliVideo({ openExternal: openExternalForBili }, args[0], args[1])
  )
  handle(ctx, IPC.petOpenBiliVideo, 'pet', (_event, args): Promise<ChatActionResult> =>
    openBiliVideo({ openExternal: openExternalForBili }, args[0], args[1])
  )

  // 渲染进程的 window.close() 会直接销毁 BrowserWindow；收起统一走这里。
  on(ctx, IPC.chatHideWindow, 'chat', () => {
    ctx.windows.hideChat()
  })



}
