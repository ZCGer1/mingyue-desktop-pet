import { shell } from 'electron';
import type { BiliLoginQrView, BiliReportOpenResult } from '../shared/bilibili';
import type { DiscoveryFeedbackKind } from '../shared/discovery';
import { IPC, type BiliActionView, type ChatActionResult, type DiscoverySettingsView } from '../shared/ipc';
/**
 * 主进程 IPC 白名单（PLAN.md §6）。
 *
 * 每个通道都绑定一个渲染窗口；参数在主进程再次校验。设置页专属通道
 * （API Key、原始活动样本、记忆、诊断）绝不接受聊天/桌宠页调用。
 */
import { asBiliSettingsAction, asString, errorMessage, handle, handleAny, isPlainObject } from './ipcSupport';
import type { IpcContext } from './ipcSupport';
const DISCOVERY_FEEDBACK_KINDS: ReadonlySet<string> = new Set(['like', 'less', 'drop-topic'])

export function registerSettingsBiliIpc(ctx: IpcContext): void {
  handle(ctx, IPC.settingsDiscovery, 'settings', (): DiscoverySettingsView => {
    const service = ctx.bot.bilibiliService
    const list = ctx.bot.discoveryListView()
    if (service === null) {
      return {
        status: null,
        unavailableReason: 'B 站阅读服务未初始化：缺少服务资源或系统安全存储。',
        qr: null,
        reading: null,
        report: null,
        list
      }
    }
    try {
      return {
        status: service.status(),
        unavailableReason: null,
        qr: service.loginQrView(),
        reading: service.readingView(),
        report: service.reportSummary(),
        list
      }
    } catch (error) {
      return {
        status: null,
        unavailableReason: errorMessage(error, '无法读取 B 站阅读服务状态。'),
        qr: null,
        reading: null,
        report: null,
        list
      }
    }
  })
  handle(ctx, IPC.settingsBiliAction, 'settings', async (_event, args): Promise<BiliActionView> => {
    const action = asBiliSettingsAction(args[0])
    const service = ctx.bot.bilibiliService
    if (action === null) {
      return { ok: false, message: '操作参数无效。', status: null, qr: null, report: null }
    }
    if (service === null) {
      return {
        ok: false,
        message: 'B 站阅读服务在当前环境不可用（缺少服务资源或安全存储）。',
        status: null,
        qr: null,
        report: null
      }
    }
    let ok = true
    let message = ''
    let qr: BiliLoginQrView | null = null
    let report: BiliReportOpenResult | null = null
    try {
      switch (action.action) {
        case 'stop':
          // 只结束她自己的阅读会话；用户浏览器和已保存发现不受影响。
          service.stopBrowsing('user')
          message = '已停止 B 站阅读；待发的分享已取消。'
          break
        case 'resume':
          service.resumeBrowsing()
          message = '已恢复 B 站阅读，之后按原有节奏进行。'
          break
        case 'login-start':
          qr = await service.loginStart()
          ok = qr.state === 'logged-in' || qr.imageDataUrl !== null
          message =
            qr.message ?? (ok ? '请用 B 站手机客户端扫码并在手机上确认。' : '二维码生成失败，请重试。')
          break
        case 'login-cancel':
          qr = service.loginCancel()
          message = qr.message ?? '已取消扫码登录。'
          break
        case 'logout':
          await service.logout()
          message = '已退出 B 站账号；本地阅读记录与历史日报保留。'
          break
        case 'install': {
          const result = await service.install(action.kind)
          ok = result.ok
          message = result.message
          break
        }
        case 'retry-service':
          await service.retryService()
          message = '已重新启动 B 站服务。'
          break
        case 'report-open':
          report = await service.openReport()
          ok = report.ok
          message = report.message
          break
        case 'report-open-folder':
          report = await service.openReportFolder()
          ok = report.ok
          message = report.message
          break
      }
    } catch (error) {
      ok = false
      message = errorMessage(error, 'B 站操作失败。')
    }
    let status: BiliActionView['status'] = null
    try {
      status = service.status()
    } catch {
      status = null
    }
    return { ok, message, status, qr, report }
  })
  // 发现卡片的打开/反馈/删除；渲染进程从不接触原始链接，
  // 打开前由 Bot 重新校验规范 URL。
  handleAny(
    ctx,
    IPC.discoveryAction,
    ['settings', 'chat', 'pet'],
    async (_event, args): Promise<ChatActionResult> => {
      const raw = args[0]
      if (!isPlainObject(raw)) return { ok: false, message: '参数无效。' }
      const action = raw['action']
      if (action === 'clear') {
        return ctx.bot.clearDiscoveries()
      }
      const id = asString(raw['id'], 80)
      if (id === null || id.trim() === '') {
        return { ok: false, message: '发现编号无效。' }
      }
      if (action === 'open') {
        const target = ctx.bot.discoveryOpenUrl(id)
        if (!target.ok) return { ok: false, message: target.message }
        try {
          await shell.openExternal(target.url)
          return { ok: true, message: '已在你的浏览器中打开。' }
        } catch {
          return { ok: false, message: '打开浏览器失败。' }
        }
      }
      if (action === 'feedback') {
        const kind = asString(raw['kind'], 20)
        if (kind === null || !DISCOVERY_FEEDBACK_KINDS.has(kind)) {
          return { ok: false, message: '反馈参数无效。' }
        }
        return ctx.bot.noteDiscoveryFeedback(id, kind as DiscoveryFeedbackKind)
      }
      if (action === 'delete') {
        return ctx.bot.deleteDiscovery(id)
      }
      return { ok: false, message: '不支持的操作。' }
    }
  )
  // 最近系统动作只在内存中；目标路径/链接仅供本机设置页展示。
}
