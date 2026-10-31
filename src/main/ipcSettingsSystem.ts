import { app, dialog } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScreenCompanionTestResultView } from '../shared/screenCompanion';
import { IPC, type BrowserBridgeStatusView, type BrowserExtensionOpenResultView, type ChatActionResult, type CompanionActionResultView, type CompanionExperienceView, type CompanionInterestView, type CompanionSnapshotView, type DiagnosticsExportResultView, type DiagnosticsView, type LocalDataClearResultView, type MemorySnapshotView, type MemoryWriteResultView, type PetCommand, type RunningAppView, type SystemAppCandidateView, type SystemRecentActionView, type UndoEntryView, type UndoResultView } from '../shared/ipc';
import { MEMORY_FILES, MEMORY_WRITE_LIMIT } from '../persona/whaleGirl/memory';
import type { MemoryFile } from '../persona/whaleGirl/memory';
import { normalizeConfig } from './config/store';
import { buildDiagnosticPackage } from './diagnosticsExport';
import { scanStartMenuApps } from './system/startMenu';
/**
 * 主进程 IPC 白名单（PLAN.md §6）。
 *
 * 每个通道都绑定一个渲染窗口；参数在主进程再次校验。设置页专属通道
 * （API Key、原始活动样本、记忆、诊断）绝不接受聊天/桌宠页调用。
 */
import { asBoolean, asCount, asString, diagnosticsView, errorMessage, handle, isPlainObject, undoResult, worldView } from './ipcSupport';
import type { IpcContext } from './ipcSupport';
const MAX_QUERY_CHARS = 500
const PET_COMMANDS: ReadonlySet<string> = new Set(['reset', 'settings', 'refresh', 'reset-settings'])

export function registerSettingsBrowserIpc(ctx: IpcContext): void {
  // 只返回有可见窗口的进程键与标签，不含标题；由用户逐应用加入观察范围。
  handle(ctx, IPC.settingsRunningApps, 'settings', async (): Promise<RunningAppView[]> =>
    ctx.bot.runningDesktopApps()
  )
  // 浏览器桥状态只含连接/计数；设置页不返回标题、域名或摘要。
  handle(ctx, IPC.settingsBrowserStatus, 'settings', (): BrowserBridgeStatusView =>
    ctx.getBrowserBridgeStatus()
  )
  handle(ctx, IPC.settingsBrowserRotateToken, 'settings', (): string | null => {
    const code = ctx.rotateBrowserToken()
    if (code !== null) {
      ctx.broadcastNotice('浏览器桥配对码已轮换，请在扩展设置里重新粘贴。')
    }
    return code
  })
  handle(ctx, IPC.settingsBrowserOpenExtension, 'settings', async (): Promise<BrowserExtensionOpenResultView> => {
    return ctx.openBrowserExtensionFolder()
  })
  // B 站独立 API：状态只含阶段/计数/错误枚举；发现列表只含展示字段。
}

export function registerSettingsSystemIpc(ctx: IpcContext): void {
  handle(ctx, IPC.settingsSystemRecent, 'settings', (): SystemRecentActionView[] =>
    ctx.bot.systemWorld.recentActions()
  )
  handle(ctx, IPC.settingsSystemClearRecent, 'settings', () => {
    ctx.bot.systemWorld.clearRecent()
  })
  handle(ctx, IPC.settingsSystemScanApps, 'settings', async (): Promise<SystemAppCandidateView[]> => {
    try {
      return await scanStartMenuApps()
    } catch {
      return []
    }
  })
  handle(ctx, IPC.settingsClearLocalData, 'settings', async (): Promise<LocalDataClearResultView> => {
    const result = await ctx.bot.clearLocalData()
    ctx.windows.sendToChat(IPC.chatCleared)
    ctx.windows.sendToSettings(IPC.settingsActivityChanged)
    ctx.broadcastStatus()
    return result
  })
  handle(ctx, IPC.settingsActivityPaused, 'settings', (_event, args) => {
    const paused = asBoolean(args[0])
    if (paused === null) return
    ctx.bot.setActivityPaused(paused)
    ctx.bot.state.set('activityPaused', paused)
    ctx.windows.sendToSettings(IPC.settingsActivityChanged)
    ctx.refreshTray()
  })
  handle(ctx, IPC.settingsAgentPaused, 'settings', (_event, args) => {
    const paused = asBoolean(args[0])
    if (paused === null) return
    if (paused) ctx.bot.pause('manual')
    else ctx.bot.resume()
    ctx.broadcastStatus()
    ctx.refreshTray()
  })
  handle(ctx, IPC.settingsSetRoam, 'settings', (_event, args) => {
    const enabled = asBoolean(args[0])
    if (enabled === null) return
    const config = ctx.bot.getConfig()
    const next = normalizeConfig({
      ...config,
      worlds: {
        ...config.worlds,
        pet: { ...config.worlds.pet, movement: { ...config.worlds.pet.movement, enabled } }
      }
    })
    const result = ctx.applyConfig(next)
    if (!result.ok) ctx.broadcastNotice(result.message ?? '保存走动设置失败。')
    ctx.refreshTray()
  })

  handle(ctx, IPC.settingsMemorySnapshot, 'settings', (): MemorySnapshotView => {
    const store = ctx.bot.persona.memoryStore
    const config = ctx.bot.getConfig()
    return {
      enabled: config.memory.enabled,
      habits: config.memory.habits,
      dir: store.dir,
      entries: store.list(),
      contents: store.snapshot()
    }
  })

  handle(ctx, IPC.settingsMemoryWrite, 'settings', (_event, args): MemoryWriteResultView => {
    const name = args[0]
    const content = asString(args[1], MEMORY_WRITE_LIMIT * 2)
    const mode = args[2]
    if (
      typeof name !== 'string' ||
      !(MEMORY_FILES as readonly string[]).includes(name) ||
      content === null ||
      (mode !== 'replace' && mode !== 'append')
    ) {
      return { ok: false, message: '记忆写入参数无效。' }
    }
    return ctx.bot.persona.memoryStore.write(name as MemoryFile, content, mode)
  })

  handle(ctx, IPC.settingsMemoryForget, 'settings', (_event, args): MemoryWriteResultView => {
    const raw = args[0]
    if (!isPlainObject(raw)) return { ok: false, message: '参数无效。' }
    const path = raw['path'] === undefined ? undefined : asString(raw['path'], 100)
    const query = raw['query'] === undefined ? undefined : asString(raw['query'], MAX_QUERY_CHARS)
    if (
      (raw['path'] !== undefined && path === null) ||
      (raw['query'] !== undefined && query === null)
    ) {
      return { ok: false, message: '参数无效。' }
    }
    if (path === undefined && query === undefined) {
      return { ok: false, message: '需要提供要忘记的文件或关键词。' }
    }
    const target: { path?: string; query?: string } = {}
    if (typeof path === 'string') target.path = path
    if (typeof query === 'string') target.query = query
    const result = ctx.bot.persona.memoryStore.forget(target)
    // 用户删除记忆关键词时，兴趣/经历/探索指纹一并遗忘，
    // 避免同一内容换个位置继续出现在她自己的记录里。
    if (result.ok && typeof query === 'string' && query.trim() !== '') {
      ctx.bot.forgetCompanionMatching(query)
    }
    return result
  })

  handle(ctx, IPC.settingsCompanion, 'settings', (): CompanionSnapshotView => {
    const persona = ctx.bot.persona
    const config = ctx.bot.getConfig()
    const toView = (record: {
      id: string
      title: string
      source: 'user' | 'autonomy' | 'event'
      status: 'active' | 'paused' | 'done' | 'abandoned'
      nextStep: string | null
      nextTool: string | null
      requiredCapability: string | null
      backgroundSafe: boolean | null
      recheckCondition: string | null
      endCondition: string
      artifacts: string[]
      taskIds: string[]
      focusCount: number
      talkCount: number
      lastFocusAt: number | null
      nextRevisitAt: number | null
      updatedAt: number
    }): CompanionInterestView => ({
      id: record.id,
      title: record.title,
      source: record.source,
      status: record.status,
      nextStep: record.nextStep,
      nextTool: record.nextTool,
      requiredCapability: record.requiredCapability,
      backgroundSafe: record.backgroundSafe,
      recheckCondition: record.recheckCondition,
      endCondition: record.endCondition,
      artifacts: [...record.artifacts],
      taskCount: record.taskIds.length,
      focusCount: record.focusCount,
      talkCount: record.talkCount,
      lastFocusAt: record.lastFocusAt,
      nextRevisitAt: record.nextRevisitAt,
      updatedAt: record.updatedAt
    })
    const interests = persona.interestStore.snapshot().map(toView)
    const revisits = persona.interestStore.dueRevisits().map(toView)
    const experiences: CompanionExperienceView[] = persona.experienceStore.list().map((record) => ({
      id: record.id,
      at: record.at,
      kind: record.kind,
      summary: record.summary,
      tool: record.tool,
      targetKind: record.targetKind,
      targetRef: record.targetRef,
      taskId: record.taskId,
      interestId: record.interestId,
      artifact: record.artifact
    }))
    const byStatus = persona.interestStore.countByStatus()
    const rhythm = ctx.bot.companionState()
    return {
      enabled: config.memory.enabled,
      screenFeedback: ctx.bot.screenCompanionStatus(),
      cadence: config.companion.cadence,
      nextCadenceAt: persona.cadenceController.nextAt(),
      speechQuietUntil: rhythm.speechQuietUntil > 0 ? rhythm.speechQuietUntil : null,
      explorePausedUntil: rhythm.explorePausedUntil > 0 ? rhythm.explorePausedUntil : null,
      unansweredEpisode: rhythm.unansweredEpisode,
      readiness: ctx.bot.autonomyReadiness(),
      interests,
      revisits,
      experiences,
      counts: {
        active: byStatus.active,
        paused: byStatus.paused,
        done: byStatus.done,
        abandoned: byStatus.abandoned,
        experiences: persona.experienceStore.count(),
        exploration: persona.explorationStore.count()
      }
    }
  })

  handle(
    ctx,
    IPC.settingsCompanionAction,
    'settings',
    (_event, args): CompanionActionResultView => {
      const raw = args[0]
      if (!isPlainObject(raw)) return { ok: false, message: '参数无效。' }
      const action = raw['action']
      const interestId =
        raw['interestId'] === undefined ? undefined : asString(raw['interestId'], 80)
      if (raw['interestId'] !== undefined && interestId === null) {
        return { ok: false, message: '兴趣 id 无效。' }
      }
      const persona = ctx.bot.persona
      if (action === 'quiet-speech') {
        ctx.bot.setSpeechQuietUntil(Date.now() + 30 * 60_000)
        return { ok: true, message: '接下来 30 分钟不主动说话；探索可以继续。' }
      }
      if (action === 'resume-speech') {
        ctx.bot.setSpeechQuietUntil(null)
        return { ok: true, message: '已恢复主动说话。' }
      }
      if (action === 'pause-explore') {
        ctx.bot.setExplorePausedUntil(Date.now() + 30 * 60_000)
        return { ok: true, message: '自主探索已暂停 30 分钟，当前自主任务已挂起。' }
      }
      if (action === 'resume-explore') {
        ctx.bot.setExplorePausedUntil(null)
        return { ok: true, message: '已恢复自主探索，暂停的自主任务会继续。' }
      }
      if (
        action === 'pause-interest' ||
        action === 'resume-interest' ||
        action === 'done-interest'
      ) {
        if (interestId === undefined || interestId === null || interestId === '') {
          return { ok: false, message: '需要指定兴趣。' }
        }
        const result = persona.interestStore.update(interestId, {
          ...(action === 'pause-interest' ? { status: 'paused' as const } : {}),
          ...(action === 'resume-interest' ? { status: 'active' as const } : {}),
          ...(action === 'done-interest'
            ? { status: 'done' as const, nextRevisitMinutes: null }
            : {})
        })
        return { ok: result.ok, message: result.message }
      }
      if (action === 'delete-interest') {
        if (interestId === undefined || interestId === null || interestId === '') {
          return { ok: false, message: '需要指定要删除的兴趣。' }
        }
        const removed = persona.interestStore.delete(interestId)
        persona.explorationStore.forgetInterest(interestId)
        let experiences = 0
        for (const record of persona.experienceStore.list()) {
          if (record.interestId === interestId && persona.experienceStore.delete(record.id)) {
            experiences += 1
          }
        }
        return {
          ok: removed,
          message: removed
            ? `已删除这个兴趣及其 ${experiences} 条相关经历。`
            : '没有找到这个兴趣。',
          removed: removed ? 1 + experiences : 0
        }
      }
      if (action === 'clear-experiences') {
        const before = persona.experienceStore.count()
        persona.experienceStore.clear()
        return { ok: true, message: `已清空 ${before} 条经历。`, removed: before }
      }
      if (action === 'clear-all') {
        const interests = persona.interestStore.snapshot().length
        const experiences = persona.experienceStore.count()
        const exploration = persona.explorationStore.count()
        persona.interestStore.clear()
        persona.experienceStore.clear()
        persona.explorationStore.clear()
        return {
          ok: true,
          message: `已清空 ${interests} 条兴趣、${experiences} 条经历与 ${exploration} 条探索记录。`,
          removed: interests + experiences + exploration
        }
      }
      return { ok: false, message: '不支持的操作。' }
    }
  )

  handle(
    ctx,
    IPC.settingsScreenCompanionTest,
    'settings',
    (): ScreenCompanionTestResultView => ctx.bot.screenCompanionTest()
  )

  handle(ctx, IPC.settingsDiagnostics, 'settings', (): DiagnosticsView => diagnosticsView(ctx))

  handle(
    ctx,
    IPC.settingsExportDiagnostics,
    'settings',
    async (): Promise<DiagnosticsExportResultView> => {
      const view = diagnosticsView(ctx)
      const stamp = new Date(view.generatedAt)
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, '-')
      const options = {
        title: '导出脱敏诊断包',
        defaultPath: join(app.getPath('documents'), `桌宠诊断包-${stamp}.json`),
        filters: [{ name: 'JSON 诊断包', extensions: ['json'] }]
      }
      const owner = ctx.windows.settingsWindow
      const picked =
        owner === null || owner.isDestroyed()
          ? await dialog.showSaveDialog(options)
          : await dialog.showSaveDialog(owner, options)
      if (picked.canceled || picked.filePath === undefined || picked.filePath === '') {
        return { ok: false, message: '已取消。' }
      }
      const file = picked.filePath.toLowerCase().endsWith('.json')
        ? picked.filePath
        : `${picked.filePath}.json`
      try {
        const payload = buildDiagnosticPackage(view, { platform: process.platform })
        writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
        return { ok: true, message: `脱敏诊断包已写入：${file}`, path: file }
      } catch (error) {
        return { ok: false, message: errorMessage(error, '写入诊断包失败。') }
      }
    }
  )

  handle(ctx, IPC.settingsWorlds, 'settings', () => worldView(ctx))

  handle(ctx, IPC.settingsPetCommand, 'settings', (_event, args) => {
    const command = asString(args[0], 40)
    if (command === null || !PET_COMMANDS.has(command)) return
    ctx.bot.notifyUserInteraction()
    if (command === 'refresh') {
      ctx.reloadPetPage()
      return
    }
    ctx.windows.sendToPet(IPC.petCommand, command as PetCommand)
  })

  handle(ctx, IPC.settingsUndoList, 'settings', (): UndoEntryView[] => ctx.bot.undoList())
  handle(ctx, IPC.settingsUndo, 'settings', (_event, args): UndoResultView =>
    undoResult(ctx.bot.undoLast(asCount(args[0])))
  )

  handle(ctx, IPC.settingsResetPetSettings, 'settings', (): ChatActionResult => {
    // 位置由主进程持久化；页面还保留旧版本地缓存，`reset-settings` 让页面
    // 一并清掉并重新加载到默认位置。
    ctx.bot.notifyUserInteraction()
    ctx.petPositions.clear()
    ctx.windows.sendToPet(IPC.petCommand, 'reset-settings')
    return { ok: true, message: '桌宠位置与页面缓存已重置。' }
  })
}
