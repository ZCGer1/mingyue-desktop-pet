import {
  app,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type OpenDialogReturnValue
} from 'electron'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import type { Bot } from '../bot'
import type { AppConfig } from '../shared/config'
import type { ApprovalScope, World } from '../core/types'
import { effectiveCapabilities } from '../shared/effectiveCapabilities'
import type {
  ActivityDayStatsView,
  ActivityStatsView,
  BrowserBridgeStatusView,
  BrowserExtensionOpenResultView,
  ChatBootstrap,
  DiagnosticsRuntimeView,
  DiagnosticsView,
  PetMovementCapabilityView,
  PetMovementView,
  PetPageStateSnapshot,
  PetSavedPositionView,
  RevokeExplorationResult,
  SaveConfigResult,
  SettingsBootstrap,
  TaskActionView,
  UndoEntryView,
  UndoResultView,
  WorldHealthView
} from '../shared/ipc'
import type { BiliSettingsAction } from '../shared/bilibili'
import type { DayStats } from '../worlds/activity/stats'
import type { AppPaths } from './paths'
import type { ConfigStore } from './config/store'
import type { SecretStore } from './config/secrets'
import { buildChatHistory } from '../worlds/chat/history'
import { readRecentErrors, readRecentToolCalls } from './diagnosticsExport'
import type { PerchService } from './perch/perchService'
import type { PetHostServer } from './petHost/server'
import type { PetAnimationBroker } from './petHost/animationBroker'
import type { PetMovementBroker } from './petHost/movementBroker'
import type { PetSayBroker } from './petHost/sayBroker'
import type { PetPositionStore } from './petHost/positionStore'
import { phaseSnapshot } from './status'
import type { WindowManager } from './windows'

export interface IpcContext {
  paths: AppPaths
  bot: Bot
  configStore: ConfigStore
  secrets: SecretStore
  petHost: PetHostServer
  petPositions: PetPositionStore
  petAnimations: PetAnimationBroker
  petMovement: PetMovementBroker
  petSay: PetSayBroker
  windows: WindowManager
  perch: PerchService
  getConfigWarning(): string | null
  getConfigRevision(): number
  applyConfig(next: AppConfig, baseRevision?: number): SaveConfigResult
  /** 桌宠页占用快照；仅用于主进程随机调度，不进入模型上下文。 */
  reportPetPageState(state: PetPageStateSnapshot): void
  /** 随机动作/走动的调度诊断；只有时间、动作 ID 与固定原因。 */
  getAmbientDiagnostics(): Record<string, unknown>
  revokeExploration(): RevokeExplorationResult
  broadcastNotice(message: string): void
  broadcastStatus(): void
  refreshTray(): void
  reloadPetPage(): void
  getAutoLaunch(): boolean
  setAutoLaunch(enabled: boolean): boolean
  getBrowserBridgeStatus(): BrowserBridgeStatusView
  rotateBrowserToken(): string | null
  openBrowserExtensionFolder(): Promise<BrowserExtensionOpenResultView>
  quit(): void
}

export type Role = 'chat' | 'settings' | 'pet'

const MAX_CHAT_CHARS = 32_000
const MAX_QUERY_CHARS = 500
const MAX_CONFIG_BYTES = 256 * 1024
const PET_COMMANDS: ReadonlySet<string> = new Set(['reset', 'settings', 'refresh', 'reset-settings'])
const PET_FEEDBACK_KINDS: ReadonlySet<string> = new Set(['more', 'less', 'stop', 'quiet'])
const DISCOVERY_FEEDBACK_KINDS: ReadonlySet<string> = new Set(['like', 'less', 'drop-topic'])
const PET_INTERACTIONS: ReadonlySet<string> = new Set([
  'grab',
  'pet',
  'drop',
  'throw',
  'poke',
  'crash'
])

export function petMovementView(bot: Bot): PetMovementView {
  const movement = bot.getConfig().worlds.pet.movement
  return {
    enabled: movement.enabled,
    pauseWithPanel: movement.pauseWithPanel,
    autonomousMinIntervalMs: movement.autonomousMinIntervalMs,
    randomRoam: { ...movement.randomRoam }
  }
}

export function petPositionPayload(value: unknown): PetSavedPositionView | null {
  if (!isPlainObject(value)) return null
  const displayId = typeof value['displayId'] === 'string' ? value['displayId'] : null
  const xRatio = value['xRatio']
  const feetRatio = value['feetRatio']
  const facing = value['facing'] === 'left' ? 'left' : 'right'
  const savedAt = value['savedAt']
  if (typeof xRatio !== 'number' || !Number.isFinite(xRatio)) return null
  if (typeof feetRatio !== 'number' || !Number.isFinite(feetRatio)) return null
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null
  return { displayId, xRatio, feetRatio, facing, savedAt }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

export function senderId(ctx: IpcContext, role: Role): number | null {
  if (role === 'chat') return ctx.windows.chatWebContents?.id ?? null
  if (role === 'pet') return ctx.windows.petWebContents?.id ?? null
  return ctx.windows.settingsWebContents?.id ?? null
}

export function allowed(ctx: IpcContext, event: IpcMainEvent | IpcMainInvokeEvent, role: Role): boolean {
  // 桌宠页只保留 pet + quick；快捷聊天不再复用 main 会话，因此它不能调用
  // chat.send / chat.bootstrap，也不能确认审批。chat:event:* 推送不经过这里。
  const id = senderId(ctx, role)
  return id !== null && event.sender.id === id
}

export function handle<T>(
  ctx: IpcContext,
  channel: string,
  role: Role,
  handler: (event: IpcMainInvokeEvent, args: unknown[]) => T | Promise<T>
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!allowed(ctx, event, role)) throw new Error('unauthorized')
    return handler(event, args)
  })
}

export function handleAny<T>(
  ctx: IpcContext,
  channel: string,
  roles: readonly Role[],
  handler: (event: IpcMainInvokeEvent, args: unknown[]) => T | Promise<T>
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    const permitted = roles.some((role) => allowed(ctx, event, role))
    if (!permitted) throw new Error('unauthorized')
    return handler(event, args)
  })
}

export function on(
  ctx: IpcContext,
  channel: string,
  role: Role,
  handler: (args: unknown[]) => void
): void {
  ipcMain.on(channel, (event, ...args: unknown[]) => {
    if (!allowed(ctx, event, role)) return
    try {
      handler(args)
    } catch {
      /* IPC 参数错误不应让主进程崩溃 */
    }
  })
}

export function asString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

/**
 * B 站视频打开器。E2E 用环境变量捕获目标 URL，避免在真实桌面上拉起浏览器；
 * 仅在未打包构建生效，生产路径仍交给系统 shell。
 */
export async function openExternalForBili(url: string): Promise<void> {
  if (!app.isPackaged && process.env['MINGYUE_E2E_CAPTURE_OPEN_EXTERNAL'] === '1') {
    const scope = globalThis as typeof globalThis & {
      __mingyueE2EOpenedExternal?: string[]
    }
    const captured = scope.__mingyueE2EOpenedExternal ?? []
    captured.push(url)
    scope.__mingyueE2EOpenedExternal = captured
    return
  }
  await shell.openExternal(url)
}

export function normalizeMovementCapability(raw: unknown): PetMovementCapabilityView | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const ratio = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : null
  const xRatio = ratio(record['xRatio'])
  const min = ratio(record['reachableMinRatio'])
  const max = ratio(record['reachableMaxRatio'])
  const facing = record['facing'] === 'left' || record['facing'] === 'right' ? record['facing'] : null
  if (xRatio === null || min === null || max === null || facing === null) return null
  if (max < min) return null
  return { xRatio, facing, reachableMinRatio: min, reachableMaxRatio: max }
}

/** 页面快照只含占用/几何/固定原因；所有字段缺一不可，避免调度器把未知当空闲。 */
export function normalizePetPageState(raw: unknown): PetPageStateSnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const flag = (key: string): boolean | null =>
    typeof record[key] === 'boolean' ? (record[key] as boolean) : null
  const numberOrNull = (value: unknown): number | null | undefined =>
    value === null
      ? null
      : typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined
  const ratio = (key: string): number | null | undefined => {
    const value = numberOrNull(record[key])
    if (value === undefined || value === null) return value
    return value >= 0 && value <= 1 ? value : undefined
  }
  const at = numberOrNull(record['at'])
  const size = numberOrNull(record['size'])
  const displayWidth = numberOrNull(record['displayWidth'])
  if (at === null || at === undefined) return null
  if (size === null || size === undefined || size <= 0) return null
  if (displayWidth !== null && (displayWidth === undefined || displayWidth <= 0)) return null
  const xRatio = ratio('xRatio')
  const min = ratio('reachableMinRatio')
  const max = ratio('reachableMaxRatio')
  if (xRatio === undefined || min === undefined || max === undefined) return null
  if (min !== null && max !== null && max < min) return null
  const bools = [
    'ready',
    'visible',
    'idle',
    'working',
    'active',
    'pending',
    'panelOpen',
    'menuOpen',
    'dragging',
    'throwing',
    'perched',
    'moving',
    'suspended',
    'reducedMotion'
  ] as const
  const values: Partial<Record<(typeof bools)[number], boolean>> = {}
  for (const key of bools) {
    const value = flag(key)
    if (value === null) return null
    values[key] = value
  }
  const lookRaw = record['lookAround']
  const look = isPlainObject(lookRaw) ? lookRaw : {}
  const nullableAt = (key: string): number | null => {
    const value = look[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  const nullableText = (key: string): string | null => {
    const value = look[key]
    return typeof value === 'string' ? value.slice(0, 120) : null
  }
  return {
    at,
    ready: values.ready as boolean,
    visible: values.visible as boolean,
    idle: values.idle as boolean,
    working: values.working as boolean,
    active: values.active as boolean,
    pending: values.pending as boolean,
    panelOpen: values.panelOpen as boolean,
    menuOpen: values.menuOpen as boolean,
    dragging: values.dragging as boolean,
    throwing: values.throwing as boolean,
    perched: values.perched as boolean,
    moving: values.moving as boolean,
    suspended: values.suspended as boolean,
    reducedMotion: values.reducedMotion as boolean,
    xRatio,
    reachableMinRatio: min,
    reachableMaxRatio: max,
    displayWidth,
    size,
    lookAround: {
      lastStartedAt: nullableAt('lastStartedAt'),
      lastSource: nullableText('lastSource'),
      lastAttemptAt: nullableAt('lastAttemptAt'),
      lastRejectedSource: nullableText('lastRejectedSource'),
      lastRejectedReason: nullableText('lastRejectedReason'),
      // 页面本地时间（epoch ms）；0/非法值按 0 处理，表示从未播放。
      cooldownUntil: Math.max(0, nullableAt('cooldownUntil') ?? 0)
    }
  }
}

export function asApprovalScope(value: unknown): ApprovalScope {
  return value === 'session' || value === 'always' ? value : 'once'
}

export function asTaskAction(value: unknown): TaskActionView | null {
  return value === 'pause' || value === 'resume' || value === 'cancel' ? value : null
}

/** 设置页 B 站动作的白名单；渲染进程传什么都在主进程重新构造。 */
export function asBiliSettingsAction(value: unknown): BiliSettingsAction | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as { action?: unknown; kind?: unknown }
  switch (record.action) {
    case 'stop':
    case 'resume':
    case 'login-start':
    case 'login-cancel':
    case 'logout':
    case 'retry-service':
    case 'report-open':
    case 'report-open-folder':
      return { action: record.action }
    case 'install':
      return record.kind === 'service' || record.kind === 'asr' || record.kind === 'model'
        ? { action: 'install', kind: record.kind }
        : null
    default:
      return null
  }
}

export function asCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.max(1, Math.min(50, Math.round(value)))
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message.slice(0, 300)
  return fallback
}

// ---------------------------------------------------------------------------
// 视图组装
// ---------------------------------------------------------------------------

export function chatBootstrap(ctx: IpcContext): ChatBootstrap {
  return {
    version: app.getVersion(),
    config: ctx.bot.getConfig(),
    phase: phaseSnapshot(ctx.bot),
    hasApiKey: ctx.bot.hasApiKey(),
    approvals: ctx.bot.listApprovals('chat'),
    undoCount: ctx.bot.undoCount(),
    petRunning: ctx.windows.isPetVisible,
    platform: process.platform,
    history: buildChatHistory(ctx.bot.session.records),
    biliReports: ctx.bot.biliSessionReports()
  }
}

export function settingsBootstrap(ctx: IpcContext): SettingsBootstrap {
  const info = ctx.bot.session.info()
  return {
    version: app.getVersion(),
    platform: process.platform,
    config: ctx.bot.getConfig(),
    configRevision: ctx.getConfigRevision(),
    capabilitySnapshot: {
      ...ctx.bot.capabilitySnapshot(),
      configRevision: ctx.getConfigRevision()
    },
    keyStatus: ctx.secrets.status(),
    paths: {
      rootDir: ctx.paths.rootDir,
      configFile: ctx.paths.configFile,
      memoryDir: ctx.paths.memoryDir,
      logsDir: ctx.paths.logsDir,
      portable: ctx.paths.portable
    },
    petUrl: ctx.petHost.url === '' ? null : ctx.petHost.url,
    hasApiKey: ctx.bot.hasApiKey(),
    agentPaused: ctx.bot.isPaused(),
    activityPaused: ctx.bot.isActivityPaused(),
    autoLaunch: ctx.getAutoLaunch(),
    usage: ctx.bot.usage.summary(),
    session: {
      rounds: info.rounds,
      estTokens: info.estTokens,
      contextTokens: ctx.bot.getConfig().context.maxTokens
    },
    diagnostics: ctx.bot.diagnostics(),
    warning: ctx.getConfigWarning()
  }
}

export function dayView(day: DayStats): ActivityDayStatsView {
  const categories: Record<string, number> = {}
  for (const [key, value] of Object.entries(day.categories)) {
    if (typeof value === 'number' && Number.isFinite(value)) categories[key] = Math.round(value)
  }
  return {
    date: day.date,
    categories,
    switches: day.switches,
    idleMinutes: Math.round(day.idleMinutes),
    longestFocusMinutes: Math.round(day.longestFocusMinutes),
    lateNight: day.lateNight
  }
}

export function activityView(ctx: IpcContext): ActivityStatsView {
  const config = ctx.bot.getConfig()
  return {
    today: dayView(ctx.bot.todayActivity()),
    session: dayView(ctx.bot.sessionActivity()),
    sampling: ctx.bot.isActivitySampling(),
    userPaused: ctx.bot.isActivityPaused(),
    currentCategory: ctx.bot.activityWorld.currentCategoryLabel(),
    enabled: config.worlds.activity.enabled,
    retainStatsDays: config.worlds.activity.retainStatsDays
  }
}

export function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function runtimeView(raw: Record<string, unknown>): DiagnosticsRuntimeView {
  const core = isPlainObject(raw['core']) ? raw['core'] : {}
  const session = isPlainObject(core['session']) ? core['session'] : {}
  const usage = isPlainObject(core['usage']) ? core['usage'] : {}
  const hardTokens = session['hardTokens']
  const nextDueAt = core['nextDueAt']
  return {
    phase: typeof core['phase'] === 'string' ? core['phase'] : 'idle',
    round: numberField(session, 'rounds'),
    queue: numberField(core, 'queue'),
    paused: raw['paused'] === true,
    approvalsPending: numberField(raw, 'approvalsPending'),
    lastDeliveredCursor: numberField(core, 'lastDeliveredCursor'),
    nextDueAt: typeof nextDueAt === 'number' && Number.isFinite(nextDueAt) ? nextDueAt : null,
    session: {
      rounds: numberField(session, 'rounds'),
      estTokens: numberField(session, 'estTokens'),
      hardTokens:
        typeof hardTokens === 'number' && Number.isFinite(hardTokens) ? hardTokens : null,
      messageCount: numberField(session, 'messageCount')
    },
    usage: {
      calls: numberField(usage, 'calls'),
      promptTokens: numberField(usage, 'promptTokens'),
      completionTokens: numberField(usage, 'completionTokens'),
      cacheHitTokens: numberField(usage, 'cacheHitTokens'),
      estimatedCny: numberField(usage, 'estimatedCny')
    }
  }
}

export function diagnosticsView(ctx: IpcContext): DiagnosticsView {
  const diagnostics = {
    ...ctx.bot.diagnostics(),
    ambient: ctx.getAmbientDiagnostics()
  }
  return {
    generatedAt: new Date().toISOString(),
    version: app.getVersion(),
    config: ctx.bot.getConfig(),
    diagnostics,
    runtime: runtimeView(diagnostics),
    worlds: worldView(ctx),
    paths: {
      rootDir: ctx.paths.rootDir,
      configFile: ctx.paths.configFile,
      memoryDir: ctx.paths.memoryDir,
      dataDir: ctx.paths.dataDir,
      logsDir: ctx.paths.logsDir
    },
    recentToolCalls: readRecentToolCalls(ctx.paths.logsDir),
    recentErrors: readRecentErrors(ctx.paths.logsDir),
    recentTurnFailures: ctx.bot.recentTurnFailures()
  }
}

export function worldView(ctx: IpcContext): WorldHealthView[] {
  const config = ctx.bot.getConfig()
  const caps = effectiveCapabilities(config)
  const workspaceConfigured =
    config.worlds.workspace.root.trim() !== '' || config.worlds.workspace.notesRoot.trim() !== ''
  // 这里是设置页「Worlds」的唯一事实来源：每个 World 的开关按它自己的
  // 配置判定，没有独立开关的常驻 World 也明确列出，避免草稿配置与
  // fallback 推断不一致。新增 World 必须在此补一行，WorldsTab 会显示
  // 未登记模块而不是静默猜成“已启用”。
  const entries: Array<{ world: World; enabled: boolean }> = [
    { world: ctx.bot.chatWorld, enabled: config.worlds.chat.enabled },
    { world: ctx.bot.petWorld, enabled: config.worlds.pet.enabled },
    { world: ctx.bot.activityWorld, enabled: config.worlds.activity.enabled },
    { world: ctx.bot.filesWorld, enabled: caps.fileReadConfigured },
    { world: ctx.bot.workspaceWorld, enabled: workspaceConfigured },
    { world: ctx.bot.webWorld, enabled: config.worlds.web.enabled },
    { world: ctx.bot.browserWorld, enabled: config.worlds.browserPage.enabled },
    { world: ctx.bot.browserControlWorld, enabled: config.worlds.browserControl.enabled },
    { world: ctx.bot.bilibiliWorld, enabled: config.worlds.bilibili.enabled },
    { world: ctx.bot.appsWorld, enabled: true },
    { world: ctx.bot.systemWorld, enabled: config.worlds.system.enabled },
    { world: ctx.bot.cuaWorld, enabled: config.worlds.cua.enabled },
    {
      world: ctx.bot.desktopWorld,
      enabled: config.worlds.desktop.apps.some((app) => app.observe)
    },
    { world: ctx.bot.terminalWorld, enabled: config.worlds.terminal.enabled },
    { world: ctx.bot.tasksWorld, enabled: true }
  ]
  return entries.map(({ world, enabled }) => ({
    id: world.id,
    enabled,
    available: world.available === true,
    reason: world.unavailableReason ?? null,
    tools: world.describe.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      tags: [...tool.tags],
      approval: tool.approval
    })),
    events: world.describe.events.map((event) => ({
      type: event.type,
      description: event.description
    }))
  }))
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function canonicalDir(raw: string): string | null {
  if (!isAbsolute(raw)) return null
  try {
    const real = realpathSync.native(raw)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

export function workspaceError(ctx: IpcContext, raw: string): string | null {
  const dir = canonicalDir(raw)
  if (dir === null) return '目录必须是一个存在的绝对路径。'
  const appRoot = canonicalDir(ctx.paths.rootDir) ?? ctx.paths.rootDir
  const lowerDir = dir.toLowerCase()
  const lowerRoot = appRoot.toLowerCase()
  if (lowerDir === lowerRoot || inside(lowerDir, lowerRoot)) {
    return '不能选择应用数据目录或它的子目录。'
  }
  return null
}

export function testDelayEnv(name: string): number {
  const raw = process.env[name]
  if (raw === undefined) return 0
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.min(10_000, Math.floor(ms))
}

export async function waitForTestDelay(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * E2E 专用：让保存请求在途数百毫秒，以稳定复现“保存期间继续编辑”的竞态；
 * 让首次 bootstrap 变慢或失败，以核对加载与错误界面。
 * 只在未打包构建且显式设置环境变量时生效；生产构建始终走正常路径。
 */
export async function testConfigSaveDelay(): Promise<void> {
  if (app.isPackaged) return
  await waitForTestDelay(testDelayEnv('MINGYUE_E2E_CONFIG_SAVE_DELAY_MS'))
}

export async function testSettingsBootstrapDelay(): Promise<void> {
  if (app.isPackaged) return
  await waitForTestDelay(testDelayEnv('MINGYUE_E2E_SETTINGS_BOOTSTRAP_DELAY_MS'))
}

export function testSettingsBootstrapFailure(): boolean {
  return !app.isPackaged && process.env['MINGYUE_E2E_SETTINGS_BOOTSTRAP_FAIL'] === '1'
}

export function testConfigSaveFailure(): boolean {
  return !app.isPackaged && process.env['MINGYUE_E2E_CONFIG_SAVE_FAIL'] === '1'
}

export function normalizeKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  if (key === '' || key.length > 512) return null
  if (/\s|[\u0000-\u001f\u007f]/.test(key)) return null
  return key
}

export async function pickFile(
  ctx: IpcContext,
  options: OpenDialogOptions
): Promise<OpenDialogReturnValue> {
  const owner = ctx.windows.settingsWindow
  if (owner === null || owner.isDestroyed()) return dialog.showOpenDialog(options)
  return dialog.showOpenDialog(owner, options)
}

export function undoResult(
  results: Array<{ ok: boolean; message: string }>
): UndoResultView {
  const ok = results.length > 0 && results.every((result) => result.ok)
  return {
    ok,
    message:
      results.length === 0
        ? '没有可以撤销的操作。'
        : results.map((result) => result.message).join(' ')
  }
}
