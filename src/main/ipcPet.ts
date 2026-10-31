import { app } from 'electron'
import type { ChatActionResult, PetBootstrap, PetFeedbackKind, PetInteractionKind, QuickChatSnapshot, QuickSendResult, TaskView } from '../shared/ipc'
import { IPC } from '../shared/ipc'
import { isTerminalTaskState } from '../core/taskTypes'
import { openBiliVideo } from './biliVideoOpen'
import { normalizeConfig } from './config/store'
import { phaseSnapshot, petStatus } from './status'
import { petDisplayViews } from './windows'
import {
  asApprovalScope,
  asBoolean,
  asString,
  handle,
  isPlainObject,
  normalizeMovementCapability,
  normalizePetPageState,
  on,
  petMovementView,
  petPositionPayload
} from './ipcSupport'
import type { IpcContext } from './ipcSupport'

const MAX_CHAT_CHARS = 32_000
const PET_COMMANDS: ReadonlySet<string> = new Set(['reset', 'settings', 'refresh', 'reset-settings'])
const PET_FEEDBACK_KINDS: ReadonlySet<string> = new Set(['more', 'less', 'stop', 'quiet'])
const PET_INTERACTIONS: ReadonlySet<string> = new Set([
  'grab',
  'pet',
  'drop',
  'throw',
  'poke',
  'crash'
])

export function registerPetIpc(ctx: IpcContext): void {
  // ---------------------------------------------------------------- pet page

  handle(ctx, IPC.petBootstrap, 'pet', (): PetBootstrap => {
    const config = ctx.bot.getConfig()
    const pet = config.worlds.pet
    const loaded = ctx.petPositions.load()
    return {
      version: app.getVersion(),
      phase: ctx.petHost.currentPhase,
      activityPaused: ctx.bot.isActivityPaused(),
      petVisible: ctx.windows.isPetVisible,
      platform: process.platform,
      personaName: config.persona.name,
      appearance: {
        ...pet.appearance,
        home: { ...pet.appearance.home }
      },
      animation: {
        ...pet.animation,
        idleActions: { ...pet.animation.idleActions }
      },
      physics: { ...pet.physics },
      confineToScreen: pet.confineToScreen,
      movement: petMovementView(ctx.bot),
      lookAroundCooldownUntil: ctx.bot.petWorld.lookAroundCooldownUntil(),
      position: loaded.position,
      positionReason: loaded.reason,
      chatUi: {
        quickInput: { ...config.chatUi.quickInput },
        petClickAction: config.chatUi.petClickAction
      },
      displays: petDisplayViews()
    }
  })

  on(ctx, IPC.petSetInteractive, 'pet', (args) => {
    const interactive = asBoolean(args[0])
    if (interactive !== null) ctx.windows.setInteractive(interactive)
  })
  on(ctx, IPC.petSetPanelOpen, 'pet', (args) => {
    const raw = args[0]
    const direct = asBoolean(raw)
    const record = isPlainObject(raw) ? raw : null
    const open = direct ?? (record !== null && typeof record['open'] === 'boolean' ? record['open'] : null)
    if (open === null) return
    const focus = record !== null ? asBoolean(record['focus']) ?? false : false
    ctx.windows.setPanelOpen(open, { focus })
    // 面板打开/关闭都是真实交互；模块级状态不能靠「下一条无关事件」刷新。
    ctx.bot.petWorld.noteActivity(open ? 'panel-open' : 'panel-close')
  })
  on(ctx, IPC.petOpenChat, 'pet', () => {
    ctx.bot.notifyUserInteraction()
    void ctx.windows.openChat({ activate: true, reason: 'user' })
  })
  on(ctx, IPC.petOpenSettings, 'pet', () => {
    ctx.bot.notifyUserInteraction()
    ctx.windows.openSettings()
  })
  on(ctx, IPC.petResetPosition, 'pet', () => {
    ctx.bot.notifyUserInteraction()
    ctx.petPositions.clear()
    ctx.windows.sendToPet(IPC.petCommand, 'reset')
  })
  on(ctx, IPC.petSetRoam, 'pet', (args) => {
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
  })
  handle(ctx, IPC.petSavePosition, 'pet', (_event, args): boolean => {
    const payload = petPositionPayload(args[0])
    if (payload === null) return false
    return ctx.petPositions.save({ ...payload, version: 1 })
  })
  on(ctx, IPC.petAnimationReceipt, 'pet', (args) => {
    ctx.petAnimations.handleReceipt(args[0])
  })
  on(ctx, IPC.petMovementReceipt, 'pet', (args) => {
    ctx.petMovement.handleReceipt(args[0])
  })
  on(ctx, IPC.petSayReceipt, 'pet', (args) => {
    ctx.petSay.handleReceipt(args[0])
  })
  on(ctx, IPC.petPageState, 'pet', (args) => {
    const state = normalizePetPageState(args[0])
    if (state !== null) ctx.reportPetPageState(state)
  })
  on(ctx, IPC.petActivity, 'pet', (args) => {
    const kind = asString(args[0], 20)
    if (
      kind !== 'menu-open' &&
      kind !== 'menu-close' &&
      kind !== 'panel-open' &&
      kind !== 'panel-close' &&
      kind !== 'perch-bind' &&
      kind !== 'perch-unbind' &&
      kind !== 'suspend' &&
      kind !== 'resume' &&
      kind !== 'movement-ready'
    ) {
      return
    }
    if (kind === 'movement-ready') {
      const capability = normalizeMovementCapability(args[1])
      if (capability === null) return
      ctx.bot.petWorld.noteMovementCapability(capability)
      return
    }
    ctx.bot.petWorld.noteActivity(kind)
  })
  on(ctx, IPC.petNotifyReady, 'pet', () => {
    // 页面重载后旧请求已不可能再回执；先让等待方结束，再标记就绪。
    ctx.petAnimations.cancelAll('page-reloaded')
    ctx.petMovement.cancelAll('page-reloaded')
    ctx.petSay.cancelAll('page-reloaded')
    // 新页面的占用快照从空开始；重载前打开的菜单/面板不会自动复原。
    ctx.bot.petWorld.resetPresence()
    ctx.windows.markPetReady()
    ctx.broadcastStatus()
    ctx.windows.sendToPet(IPC.petAgentStatus, petStatus(ctx.bot, ctx.bot.isPaused()))
    const config = ctx.bot.getConfig()
    const pet = config.worlds.pet
    ctx.windows.sendToPet(IPC.petSettings, {
      appearance: { ...pet.appearance, home: { ...pet.appearance.home } },
      animation: {
        ...pet.animation,
        idleActions: { ...pet.animation.idleActions }
      },
      physics: { ...pet.physics },
      confineToScreen: pet.confineToScreen,
      movement: petMovementView(ctx.bot),
      lookAroundCooldownUntil: ctx.bot.petWorld.lookAroundCooldownUntil()
    })
    // 页面重载时状态重发已携带审批请求，桌宠气泡会自行恢复；
    // 不再自动展开快捷面板，避免打断用户。
  })
  on(ctx, IPC.petInteraction, 'pet', (args) => {
    const kind = asString(args[0], 20)
    if (kind === null || !PET_INTERACTIONS.has(kind)) return
    ctx.bot.noteTouch(kind as PetInteractionKind)
  })
  on(ctx, IPC.petStopCua, 'pet', () => {
    void ctx.bot.stopCua('pet-status').then(() => ctx.broadcastStatus())
  })
  // 窗口支撑只送几何；订阅幂等，页面重载不会累积助手进程。
  on(ctx, IPC.petPerchSubscribe, 'pet', () => {
    ctx.perch.subscribe()
  })
  on(ctx, IPC.petPerchUnsubscribe, 'pet', () => {
    ctx.perch.unsubscribe()
  })
  on(ctx, IPC.petPerchRefresh, 'pet', () => {
    ctx.perch.refresh()
  })
  // 桌宠页只能读取当前任务状态；停止入口统一走 petStopCua（会中止任务）。
  handle(ctx, IPC.petTask, 'pet', (): TaskView | null => {
    const views = ctx.bot.taskViews(50)
    const activeId = ctx.bot.tasks.activeTaskId()
    if (activeId !== null) {
      const active = views.find((task) => task.id === activeId)
      if (active !== undefined) return active
    }
    return views.find((task) => !isTerminalTaskState(task.state)) ?? null
  })

  // ---------------------------------------------------------------- 快捷聊天（仅桌宠页）

  handle(ctx, IPC.quickBootstrap, 'pet', (): QuickChatSnapshot => {
    return {
      ...ctx.bot.quickChat.snapshot(),
      personaName: ctx.bot.getConfig().persona.name,
      episodeId: ctx.bot.episodes.latestOpen()?.id ?? null
    }
  })

  handle(ctx, IPC.quickSend, 'pet', (_event, args): QuickSendResult => {
    const text = asString(args[0], MAX_CHAT_CHARS)
    if (text === null || text.trim() === '') {
      return { ok: false, error: '消息不能为空。' }
    }
    // 显式 id 来自被点击的气泡；无效/缺省时由 Bot 回退到最新未回答的开场。
    // 这里只传不透明 id，衔接文本由 Bot 从内存 Episode 安全生成。
    const rawEpisodeId = asString(args[1], 80)
    // 用户主动输入同时解除桌面接管保持期（但不会自动恢复任务）。
    ctx.bot.noteUserInput()
    return ctx.bot.sendQuickMessage(text, rawEpisodeId ?? undefined)
  })

  handle(ctx, IPC.petFeedback, 'pet', (_event, args): ChatActionResult => {
    const kind = asString(args[0], 20)
    if (kind === null || !PET_FEEDBACK_KINDS.has(kind)) {
      return { ok: false, message: '反馈参数无效。' }
    }
    const episodeId = asString(args[1], 80)
    // 用户主动反馈也是真实用户活动：解除接管保持期并重置聊天退避。
    ctx.bot.noteUserInput()
    const result = ctx.bot.applyCompanionFeedback(
      kind as PetFeedbackKind,
      episodeId ?? undefined
    )
    return { ok: result.ok, message: result.message }
  })

  handle(ctx, IPC.quickStop, 'pet', () => {
    ctx.bot.quickChat.stop()
  })

  handle(ctx, IPC.quickEnd, 'pet', (_event, args) => {
    // 失焦自动收起不结束上下文；只有用户显式收起会走到这里。
    if (asString(args[0], 20) !== 'close') return
    ctx.bot.quickChat.hideView()
  })

  handle(ctx, IPC.quickReset, 'pet', (_event, args) => {
    if (ctx.bot.session.records.some(record => record.kind !== 'system' && record.retention !== 'memory') && args[0] !== true) throw new Error('结束当前共享话题需要确认：完整聊天记录也会清空。')
    ctx.bot.quickChat.reset()
    ctx.bot.core.clearConversation()
  })

  handle(ctx, IPC.quickResolveApproval, 'pet', (_event, args): ChatActionResult => {
    const id = asString(args[0], 200)
    const approved = asBoolean(args[1])
    const scope = asApprovalScope(args[2])
    if (id === null || approved === null) return { ok: false, message: '审批参数无效。' }
    const resolved = ctx.bot.resolveQuickApproval(id, approved, scope)
    return resolved
      ? { ok: true, message: approved ? '已允许。' : '已拒绝。' }
      : { ok: false, message: '审批已过期或不属于快捷聊天。' }
  })

}
