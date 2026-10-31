import { DeepSeekProvider } from '../core/provider/deepseek';
import { providerFetch } from './providerFetch';
import type { AppConfig } from '../shared/config';
import { IPC, type ApprovalGrantView, type KeyActionResult, type KeyVerifyResult, type ModelListResult, type SaveConfigResult, type WorkspaceChoiceResult } from '../shared/ipc';
import { normalizeConfig } from './config/store';
/**
 * 主进程 IPC 白名单（PLAN.md §6）。
 *
 * 每个通道都绑定一个渲染窗口；参数在主进程再次校验。设置页专属通道
 * （API Key、原始活动样本、记忆、诊断）绝不接受聊天/桌宠页调用。
 */
import { asInteger, canonicalDir, errorMessage, handle, isPlainObject, normalizeKey, pickFile, settingsBootstrap, testConfigSaveDelay, testConfigSaveFailure, testSettingsBootstrapDelay, testSettingsBootstrapFailure, workspaceError } from './ipcSupport';
import type { IpcContext } from './ipcSupport';
const MAX_CONFIG_BYTES = 256 * 1024

export function registerSettingsCoreIpc(ctx: IpcContext): void {
  // ---------------------------------------------------------------- settings

  handle(ctx, IPC.settingsBootstrap, 'settings', async () => {
    await testSettingsBootstrapDelay()
    if (testSettingsBootstrapFailure()) {
      // E2E 模拟主进程读取失败；渲染层必须显示可理解的错误而不是空白页。
      throw new Error('E2E forced settings bootstrap failure')
    }
    return settingsBootstrap(ctx)
  })

  handle(ctx, IPC.settingsCapabilitySnapshot, 'settings', () => ({
    ...ctx.bot.capabilitySnapshot(),
    configRevision: ctx.getConfigRevision()
  }))

  handle(ctx, IPC.settingsVolumeScope, 'settings', (_event, args) =>
    ctx.bot.volumeScopeView(args[0] === true)
  )

  handle(ctx, IPC.settingsFileScope, 'settings', (_event, args) =>
    ctx.bot.fileScopeView(args[0] === true)
  )

  handle(ctx, IPC.settingsRevokeExploration, 'settings', () => ctx.revokeExploration())

  handle(ctx, IPC.settingsSaveConfig, 'settings', async (_event, args): Promise<SaveConfigResult> => {
    const raw = args[0]
    const baseRevision = asInteger(args[1])
    const currentRevision = ctx.getConfigRevision()
    if (!isPlainObject(raw)) {
      return {
        ok: false,
        config: ctx.bot.getConfig(),
        revision: currentRevision,
        message: '配置格式无效。'
      }
    }
    if (baseRevision === null) {
      return {
        ok: false,
        config: ctx.bot.getConfig(),
        revision: currentRevision,
        message: '缺少配置版本，请重新载入设置页。'
      }
    }
    if (baseRevision !== currentRevision) {
      return {
        ok: false,
        config: ctx.bot.getConfig(),
        revision: currentRevision,
        conflict: true,
        message: '配置已在别处更新。你的草稿仍保留；请先查看新配置再决定是否覆盖。'
      }
    }
    await testConfigSaveDelay()
    // 延迟期间可能有其他窗口/托盘写入新配置；应用前必须重新核对版本。
    if (baseRevision !== ctx.getConfigRevision()) {
      return {
        ok: false,
        config: ctx.bot.getConfig(),
        revision: ctx.getConfigRevision(),
        conflict: true,
        message: '配置已在别处更新。你的草稿仍保留；请先查看新配置再决定是否覆盖。'
      }
    }
    if (testConfigSaveFailure()) {
      // E2E 模拟主进程落盘失败；渲染层必须保留草稿与脏标记。
      throw new Error('E2E forced config save failure')
    }
    let size = 0
    try {
      size = JSON.stringify(raw).length
    } catch {
      return {
        ok: false,
        config: ctx.bot.getConfig(),
        revision: currentRevision,
        message: '配置无法序列化。'
      }
    }
    if (size > MAX_CONFIG_BYTES) {
      return {
        ok: false,
        config: ctx.bot.getConfig(),
        revision: currentRevision,
        message: '配置过大。'
      }
    }
    const current = ctx.bot.getConfig()
    const next = normalizeConfig(raw as unknown as AppConfig)
    const nextRoot = next.worlds.workspace.root.trim()
    const prevRoot = current.worlds.workspace.root.trim()
    if (nextRoot !== '' && nextRoot !== prevRoot) {
      const problem = workspaceError(ctx, nextRoot)
      if (problem !== null) {
        return { ok: false, config: current, revision: currentRevision, message: problem }
      }
    }
    const nextNotes = next.worlds.workspace.notesRoot.trim()
    const prevNotes = current.worlds.workspace.notesRoot.trim()
    if (nextNotes !== '' && nextNotes !== prevNotes) {
      const problem = workspaceError(ctx, nextNotes)
      if (problem !== null) {
        return { ok: false, config: current, revision: currentRevision, message: problem }
      }
    }
    return ctx.applyConfig(next, baseRevision)
  })

  handle(ctx, IPC.settingsSetApiKey, 'settings', (_event, args): KeyActionResult => {
    const key = normalizeKey(args[0])
    if (key === null) {
      return {
        ok: false,
        message: 'API Key 格式无效。',
        status: ctx.secrets.status()
      }
    }
    const result = ctx.secrets.set(key)
    return {
      ok: result.ok,
      message: result.ok ? 'API Key 已加密保存。' : result.message,
      status: ctx.secrets.status()
    }
  })

  handle(ctx, IPC.settingsClearApiKey, 'settings', (): KeyActionResult => {
    ctx.secrets.clear()
    return { ok: true, message: 'API Key 已清除。', status: ctx.secrets.status() }
  })

  handle(
    ctx,
    IPC.settingsVerifyApiKey,
    'settings',
    async (_event, args): Promise<KeyVerifyResult> => {
      const candidate = args[0] === null || args[0] === undefined ? null : normalizeKey(args[0])
      const key = candidate ?? ctx.secrets.get()
      if (key === null || key === '') {
        return { ok: false, message: '还没有提供 API Key。' }
      }
      const config = ctx.bot.getConfig().provider
      try {
        const provider = new DeepSeekProvider({
          apiKey: key,
          fetchImpl: providerFetch,
          model: config.model,
          contextWindow: config.contextWindow,
          maxOutputTokens: config.maxOutputTokens,
          ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl })
        })
        const models = await provider.listModels()
        return {
          ok: true,
          message: `连接成功，可用模型 ${models.length} 个。`,
          models: models.map((model) => model.id)
        }
      } catch (error) {
        return { ok: false, message: errorMessage(error, '验证失败。') }
      }
    }
  )

  handle(ctx, IPC.settingsListModels, 'settings', async (): Promise<ModelListResult> => {
    try {
      const models = await ctx.bot.listModels()
      return { ok: true, models }
    } catch (error) {
      return { ok: false, models: [], message: errorMessage(error, '获取模型列表失败。') }
    }
  })

  handle(ctx, IPC.settingsChooseWorkspace, 'settings', async (): Promise<WorkspaceChoiceResult> => {
    const picked = await pickFile(ctx, {
      title: '选择 Agent 的工作区目录',
      properties: ['openDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, root: '', message: '已取消。' }
    }
    const raw = picked.filePaths[0] as string
    const problem = workspaceError(ctx, raw)
    if (problem !== null) return { ok: false, root: '', message: problem }
    return { ok: true, root: canonicalDir(raw) ?? raw }
  })

  // 她自己的笔记目录：只接受存在的绝对路径，且不能落在应用数据目录里。
  handle(ctx, IPC.settingsChooseNotesRoot, 'settings', async (): Promise<WorkspaceChoiceResult> => {
    const picked = await pickFile(ctx, {
      title: '选择她的笔记目录',
      properties: ['openDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, root: '', message: '已取消。' }
    }
    const raw = picked.filePaths[0] as string
    const problem = workspaceError(ctx, raw)
    if (problem !== null) return { ok: false, root: '', message: problem }
    return { ok: true, root: canonicalDir(raw) ?? raw }
  })

  // 额外信任目录：只接受存在的绝对路径；设置页可随时移除。
  handle(ctx, IPC.settingsChooseTrustedRoot, 'settings', async (): Promise<WorkspaceChoiceResult> => {
    const picked = await pickFile(ctx, {
      title: '选择额外信任的目录',
      properties: ['openDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, root: '', message: '已取消。' }
    }
    const raw = picked.filePaths[0] as string
    const problem = workspaceError(ctx, raw)
    if (problem !== null) return { ok: false, root: '', message: problem }
    return { ok: true, root: canonicalDir(raw) ?? raw }
  })

  // 自由探索的只读目录：与信任目录一样只接受存在的绝对路径，不落在应用数据目录内。
  handle(
    ctx,
    IPC.settingsChooseExplorationRoot,
    'settings',
    async (): Promise<WorkspaceChoiceResult> => {
      const picked = await pickFile(ctx, {
        title: '选择允许她浏览的目录（只读）',
        properties: ['openDirectory']
      })
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: false, root: '', message: '已取消。' }
      }
      const raw = picked.filePaths[0] as string
      const problem = workspaceError(ctx, raw)
      if (problem !== null) return { ok: false, root: '', message: problem }
      return { ok: true, root: canonicalDir(raw) ?? raw }
    }
  )

  // 她自己的作品 / 下载空间：探索产生的笔记、草稿与下载放在这里，不写回用户原文件。
  handle(
    ctx,
    IPC.settingsChooseArtifactRoot,
    'settings',
    async (): Promise<WorkspaceChoiceResult> => {
      const picked = await pickFile(ctx, {
        title: '选择她自己的作品与下载目录',
        properties: ['openDirectory', 'createDirectory']
      })
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: false, root: '', message: '已取消。' }
      }
      const raw = picked.filePaths[0] as string
      const problem = workspaceError(ctx, raw)
      if (problem !== null) return { ok: false, root: '', message: problem }
      return { ok: true, root: canonicalDir(raw) ?? raw }
    }
  )

  // 授权摘要只含工具、范围、到期时间；授权键与操作参数都留在主进程。
  handle(ctx, IPC.settingsApprovalGrants, 'settings', (): ApprovalGrantView[] => {
    return ctx.bot.gate.listGrants()
  })
  handle(ctx, IPC.settingsClearApprovalGrants, 'settings', () => {
    ctx.bot.gate.clearGrants()
    ctx.broadcastNotice('已清除全部会话授权与永久授权。')
  })

}
