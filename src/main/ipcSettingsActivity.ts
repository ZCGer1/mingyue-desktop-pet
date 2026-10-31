import { IPC, type ActivityRawSampleView, type VisionSceneEventView, type VisionSceneView, type VisionStatusView } from '../shared/ipc';
import { CATEGORY_LABELS, type ActivityCategory } from '../worlds/activity/types';
/**
 * 主进程 IPC 白名单（PLAN.md §6）。
 *
 * 每个通道都绑定一个渲染窗口；参数在主进程再次校验。设置页专属通道
 * （API Key、原始活动样本、记忆、诊断）绝不接受聊天/桌宠页调用。
 */
import { activityView, handle } from './ipcSupport';
import type { IpcContext } from './ipcSupport';

export function registerSettingsActivityIpc(ctx: IpcContext): void {
  // 原始进程名只允许设置页通过这个 invoke 读取；不广播、不写日志。
  handle(ctx, IPC.settingsActivityRaw, 'settings', (): ActivityRawSampleView[] => {
    return ctx.bot.activityRawSamples().map((sample) => ({
      processName: sample.processName,
      category: sample.category,
      categoryLabel: CATEGORY_LABELS[sample.category as ActivityCategory] ?? '其他',
      durationMinutes: sample.durationMinutes,
      at: sample.at
    }))
  })
  handle(ctx, IPC.settingsActivityClearRaw, 'settings', () => {
    ctx.bot.clearActivityRawSamples()
  })
  handle(ctx, IPC.settingsActivityStats, 'settings', () => activityView(ctx))
  handle(ctx, IPC.settingsClearActivityStats, 'settings', () => {
    ctx.bot.activityWorld.clearStats()
    ctx.windows.sendToSettings(IPC.settingsActivityChanged)
  })
  // 场景状态与最近 descriptor 只在本机设置页可见；原始 OCR 片段仅在用户
  // 显式开启 showOcrSnippet 时返回，且永远不写日志/事件/诊断。
  handle(ctx, IPC.settingsVisionStatus, 'settings', (): VisionStatusView | null => {
    const status = ctx.bot.activityWorld.sceneStatus()
    if (status === null) return null
    return {
      enabled: status.enabled,
      available: status.available,
      reason: status.reason,
      lastAt: status.lastAt,
      lastFrameAt: status.lastFrameAt,
      lastSentAt: status.lastSentAt,
      lastInterpretedAt: status.lastInterpretedAt,
      lastCategory: status.lastCategory,
      lastActivity: status.lastActivity,
      lastConfidence: status.lastConfidence,
      lastDurationMs: status.lastDurationMs,
      lastError: status.lastError,
      framesCaptured: status.framesCaptured,
      framesLastMinute: status.framesLastMinute,
      requestsSent: status.requestsSent,
      targetDisplayId: status.targetDisplayId,
      targetKind: status.targetKind,
      quality: status.quality,
      blockedReason: status.blockedReason,
      paused: status.paused,
      intervalMs: status.intervalMs,
      nextCheckAt: status.nextCheckAt,
      ocrAvailable: status.ocrAvailable,
      ocrFallback: status.ocrFallback,
      displays: ctx.bot.activityWorld.sceneDisplays(),
      phase: status.phase,
      game: status.game,
      evidenceSource: status.evidenceSource,
      revision: status.revision,
      timings: status.timings === null ? null : { ...status.timings },
      lastFrame:
        status.lastFrame === undefined || status.lastFrame === null
          ? null
          : {
              ...status.lastFrame,
              validRegion: { ...status.lastFrame.validRegion }
            },
      semantic: { ...status.semantic },
      snippet: ctx.bot.activityWorld.scenePreview()
    }
  })
  handle(ctx, IPC.settingsVisionScenes, 'settings', (): VisionSceneView[] => {
    const now = Date.now()
    return ctx.bot.activityWorld.recentScenes().map((scene) => ({
      category: scene.category,
      activity: scene.activity,
      appLabel: scene.appLabel,
      title: scene.title,
      keywords: [...scene.keywords],
      confidence: scene.confidence,
      at: scene.at,
      phase: scene.phase ?? null,
      game: scene.game ?? null,
      quality: scene.quality ?? null,
      source: scene.evidenceSource ?? null,
      observationId: scene.observationId ?? null,
      evidenceAt: scene.evidenceAt ?? null,
      stale: scene.expiresAt !== undefined && now > scene.expiresAt
    }))
  })
  handle(ctx, IPC.settingsVisionEvents, 'settings', (): VisionSceneEventView[] => {
    return ctx.bot.activityWorld.recentSceneEvents().map((event) => ({
      ...event,
      chain: event.chain.map((step) => ({ ...step }))
    }))
  })
  handle(ctx, IPC.settingsVisionClear, 'settings', () => {
    ctx.bot.activityWorld.clearScene()
    ctx.windows.sendToSettings(IPC.settingsActivityChanged)
  })
  // 单独暂停屏幕感知：行为感知继续；恢复后等下一次正常采样，不补拍旧帧。
  handle(ctx, IPC.settingsVisionPause, 'settings', () => {
    ctx.bot.activityWorld.pauseScene()
    ctx.windows.sendToSettings(IPC.settingsActivityChanged)
  })
  handle(ctx, IPC.settingsVisionResume, 'settings', () => {
    ctx.bot.activityWorld.resumeScene()
    ctx.windows.sendToSettings(IPC.settingsActivityChanged)
  })
  // “立即观察一次”仍以真实授权、敏感状态、CUA 忙与单飞限制为准；
  // 用户显式点击可以让模型再解释一次同一画面，但不绕过任何隐私门。
  handle(ctx, IPC.settingsVisionObserveNow, 'settings', async () => {
    const result = await ctx.bot.activityWorld.observeSceneNow()
    ctx.windows.sendToSettings(IPC.settingsActivityChanged)
    return result
  })
  // CUA 诊断只有状态与动作类型；不含截图、坐标、窗口标题、进程名或输入文字。
  handle(ctx, IPC.settingsCuaStatus, 'settings', () => ctx.bot.cuaStatus())
  handle(ctx, IPC.settingsCuaStop, 'settings', async () => {
    await ctx.bot.stopCua('settings')
    ctx.broadcastStatus()
  })
  handle(ctx, IPC.settingsCuaClearGrants, 'settings', () => {
    ctx.bot.clearCuaGrants()
    ctx.broadcastNotice('已清除电脑操作的免问授权；下次操作会重新确认。')
  })
}
