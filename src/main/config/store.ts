import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  CONFIG_SCHEMA_VERSION,
  DSH_PET_DEFAULT_SIZE,
  SCREEN_SHARE_CONSENT_VERSION,
  defaultConfig,
  isVolumeAccessMode,
  mergeConfig,
  migrateConfig,
  type AppConfig,
  type DesktopScopeApp,
  type SystemAppEntry,
  type VisionLanguage
} from '../../shared/config'
import { PET_CATALOG } from '../../shared/petPresentation'
import { atomicWrite } from '../../core/util'
import { isFixedSensitiveProcess, processKey } from '../../worlds/cua/guard'

/** 绝不能进入桌面观察范围的自身进程。 */
const SELF_PROCESS_KEYS = new Set([
  'electron',
  'mingyue-desktop-pet',
  '溟月桌宠',
  '桌宠',
  'mingyue'
])

export interface ConfigLoadResult {
  config: AppConfig
  /** 给设置页/托盘气泡看的中文提示；不包含损坏文件内容。 */
  warning: string | null
  created: boolean
}

/**
 * config.json 的读写与损坏备份（PLAN.md §7.1）。
 * 绝不把坏文件内容拼进日志或界面提示。
 */
export class ConfigStore {
  readonly file: string
  readonly backupFile: string

  constructor(file: string, backupFile: string) {
    this.file = file
    this.backupFile = backupFile
  }

  load(): ConfigLoadResult {
    if (!existsSync(this.file)) {
      return { config: defaultConfig(), warning: null, created: true }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
    } catch {
      this.backupCorrupt()
      const config = defaultConfig()
      this.save(config)
      return {
        config,
        warning: '配置文件无法解析，已备份为 config.bad.json，并以默认设置启动。',
        created: false
      }
    }
    this.backupBeforeMigration(parsed)
    return { config: normalizeConfig(mergeConfig(migrateConfig(parsed))), warning: null, created: false }
  }

  save(config: AppConfig): void {
    const normalized = normalizeConfig(config)
    mkdirSync(dirname(this.file), { recursive: true })
    atomicWrite(this.file, `${JSON.stringify(normalized, null, 2)}\n`)
  }

  private backupCorrupt(): void {
    try {
      mkdirSync(dirname(this.backupFile), { recursive: true })
      copyFileSync(this.file, this.backupFile)
    } catch {
      /* 备份失败也要能用默认值启动；提示里仍会说明 */
    }
  }

  /**
   * 迁移前保留原始配置（只写一次，不覆盖更早的备份）。
   *
   * 文件名使用「迁移前版本」，例如 config.v16.bak.json；迁移失败或用户
   * 想核对旧值时可恢复。重复启动不会因为每次 normalize 而反复生成备份。
   */
  private backupBeforeMigration(raw: unknown): void {
    const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    const version =
      record !== null && typeof record['schemaVersion'] === 'number'
        ? Math.max(0, Math.trunc(record['schemaVersion']))
        : 0
    if (record !== null && version >= CONFIG_SCHEMA_VERSION) return
    const target = this.file.replace(/\.json$/i, `.v${version}.bak.json`)
    try {
      if (existsSync(target)) return
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(this.file, target)
    } catch {
      /* 备份失败不影响迁移；损坏回退仍走 config.bad.json */
    }
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

/**
 * mergeConfig 只保证类型，不保证范围。入模前再夹一次关键数值，
 * 避免手改配置把上下文窗口或审批超时设成离谱值。
 */
export function normalizeConfig(raw: AppConfig): AppConfig {
  const out = mergeConfig(raw)
  out.provider.model = out.provider.model.trim() === '' ? 'deepseek-flash' : out.provider.model.trim()
  out.provider.utilityModel =
    out.provider.utilityModel.trim() === '' ? out.provider.model : out.provider.utilityModel.trim()
  out.provider.contextWindow = Math.round(clamp(out.provider.contextWindow, 8_000, 1_000_000, 128_000))
  out.provider.maxOutputTokens = Math.round(
    clamp(out.provider.maxOutputTokens, 256, Math.min(65_536, out.provider.contextWindow - 1), 8192)
  )
  out.context.maxTokens = Math.round(clamp(out.context.maxTokens, 1_000, out.provider.contextWindow, 64_000))
  out.context.softRatio = clamp(out.context.softRatio, 0.5, 0.98, 0.85)
  out.context.keepRatio = clamp(out.context.keepRatio, 0.05, 0.8, 0.33)
  out.batching.quietGapMs = Math.round(clamp(out.batching.quietGapMs, 2_000, 600_000, 20_000))
  out.batching.minBatchAgeMs = Math.round(clamp(out.batching.minBatchAgeMs, 2_000, 600_000, 30_000))
  out.batching.maxBatchAgeMs = Math.round(
    clamp(out.batching.maxBatchAgeMs, out.batching.minBatchAgeMs, 900_000, 120_000)
  )
  out.batching.maxBatchSize = Math.round(clamp(out.batching.maxBatchSize, 1, 64, 8))
  out.worlds.activity.sampleMs = Math.round(clamp(out.worlds.activity.sampleMs, 1_000, 60_000, 2_000))
  out.worlds.activity.idleMinutes = Math.round(clamp(out.worlds.activity.idleMinutes, 1, 240, 5))
  out.worlds.activity.retainStatsDays = Math.round(clamp(out.worlds.activity.retainStatsDays, 0, 30, 0))
  out.approval.ttlMs = Math.round(clamp(out.approval.ttlMs, 30_000, 3_600_000, 600_000))

  out.schemaVersion = CONFIG_SCHEMA_VERSION
  // v27：遥测从未有上报通路，也没有可开启的功能；旧版 IPC/手改负载不能
  // 借 mergeConfig 的未知键兼容把它写回磁盘。
  delete (out as unknown as Record<string, unknown>)['privacy']
  normalizePersona(out)
  normalizePet(out)
  normalizeWorkspace(out)
  normalizeAutonomy(out)
  normalizeCompanion(out)
  normalizeChatUi(out)
  normalizeActivity(out)
  normalizeVision(out)
  normalizeBrowserPage(out)
  normalizeBrowserControl(out)
  normalizeBilibili(out)
  normalizeCua(out)
  normalizeDesktop(out)
  normalizeExploration(out)
  normalizeFiles(out)
  normalizeSystem(out)

  return out
}

function normalizePersona(out: AppConfig): void {
  // v27：没有运行时消费者的旧人格字段退出运行配置。heartbeatMinutes 的
  // 迁移映射已在 migrateConfig 中完成，这里只负责落盘前清理。
  const persona = out.persona as unknown as Record<string, unknown>
  delete persona['greeting']
  delete persona['proactive']
  delete persona['heartbeatMinutes']
  out.persona.name = text(out.persona.name, 40) || '桌宠'
  out.persona.language = text(out.persona.language, 32) || 'zh-CN'
  out.persona.tone = text(out.persona.tone, 40) || 'gentle'
  if (out.persona.roleplay !== 'low' && out.persona.roleplay !== 'normal' && out.persona.roleplay !== 'high') {
    out.persona.roleplay = 'high'
  }
  out.persona.styleNotes = uniqueTexts(out.persona.styleNotes, 20, 200)
  out.persona.customPrompt = text(out.persona.customPrompt, 4_000)
}

const PET_CORNERS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right'])

function normalizePet(out: AppConfig): void {
  const pet = out.worlds.pet
  if (pet.reactions !== 'quiet' && pet.reactions !== 'medium' && pet.reactions !== 'active') {
    pet.reactions = 'medium'
  }

  const appearance = pet.appearance
  // packId 是已打包能力的身份；手改成别的值不能凭空获得素材。
  // 引擎是固定实现常量，不再是用户配置。
  delete (appearance as unknown as Record<string, unknown>)['engine']
  appearance.packId = 'main'
  appearance.size = Math.round(clamp(appearance.size, 160, 900, DSH_PET_DEFAULT_SIZE))
  appearance.reducedMotion = appearance.reducedMotion === true
  if (!PET_CORNERS.has(appearance.home.corner)) appearance.home.corner = 'top-right'
  appearance.home.marginX = Math.round(clamp(appearance.home.marginX, 0, 5_000, 24))
  appearance.home.marginY = Math.round(clamp(appearance.home.marginY, 0, 5_000, 100))

  const defaults = defaultConfig().worlds.pet
  const animation = pet.animation
  // 旧随机链字段即使用户手写也退出运行配置，不能重新变成绕过路径。
  const legacyAnimation = animation as unknown as Record<string, unknown>
  delete legacyAnimation['randomEnabled']
  delete legacyAnimation['weights']
  animation.policy = 'hybrid'
  const idle = animation.idleActions
  idle.enabled = idle.enabled !== false
  idle.minIdleMs = clamp(
    idle.minIdleMs,
    30_000,
    30 * 60_000,
    defaults.animation.idleActions.minIdleMs
  )
  idle.minIntervalMs = clamp(
    idle.minIntervalMs,
    60_000,
    24 * 60 * 60_000,
    defaults.animation.idleActions.minIntervalMs
  )
  idle.sameActionIntervalMs = clamp(
    idle.sameActionIntervalMs,
    60_000,
    7 * 24 * 60 * 60_000,
    defaults.animation.idleActions.sameActionIntervalMs
  )
  idle.lookAroundIntervalMs = clamp(
    idle.lookAroundIntervalMs,
    60_000,
    7 * 24 * 60 * 60_000,
    defaults.animation.idleActions.lookAroundIntervalMs
  )

  // v20 本地随机娱乐通道：与旧 idleActions 的待机门槛/冷却完全独立。
  // 空池/不可用由调度器回待机，不在这里偷偷关闭。
  const randomIdle = animation.randomIdle
  randomIdle.enabled = randomIdle.enabled !== false
  randomIdle.minIntervalMs = Math.round(
    clamp(randomIdle.minIntervalMs, 30_000, 30 * 60_000, defaults.animation.randomIdle.minIntervalMs)
  )
  randomIdle.maxIntervalMs = Math.round(
    clamp(randomIdle.maxIntervalMs, 30_000, 60 * 60_000, defaults.animation.randomIdle.maxIntervalMs)
  )
  if (randomIdle.maxIntervalMs < randomIdle.minIntervalMs) {
    randomIdle.maxIntervalMs = randomIdle.minIntervalMs
  }

  // 普通语义动作的节流；0 表示允许连续回复各配一次（仍有单轮一次上限）。
  const semantic = animation.semantic
  semantic.enabled = semantic.enabled !== false
  semantic.minGapMs = Math.round(clamp(semantic.minGapMs, 0, 5 * 60_000, defaults.animation.semantic.minGapMs))

  const physics = pet.physics
  physics.gravity = clamp(physics.gravity, 0, 5_000, PET_CATALOG.physics.gravity)
  physics.restitution = clamp(physics.restitution, 0, 1, PET_CATALOG.physics.restitution)
  physics.groundFriction = clamp(
    physics.groundFriction,
    0,
    50,
    PET_CATALOG.physics.groundFriction
  )
  physics.ceilingBounce = physics.ceilingBounce !== false
  physics.throwPower = clamp(physics.throwPower, 0.2, 3, PET_CATALOG.physics.throwPower)
  physics.petCollision = physics.petCollision === true
  pet.confineToScreen = pet.confineToScreen === true

  const move = pet.movement
  const legacyMovement = move as unknown as Record<string, unknown>
  delete legacyMovement['autoWalk']
  move.enabled = move.enabled !== false
  move.pauseWithPanel = move.pauseWithPanel !== false
  move.minIdleMs = clamp(move.minIdleMs, 5_000, 30 * 60_000, defaults.movement.minIdleMs)
  move.autonomousMinIntervalMs = clamp(
    move.autonomousMinIntervalMs,
    30_000,
    24 * 60 * 60_000,
    defaults.movement.autonomousMinIntervalMs
  )

  // v20：偶尔随机走动。movement.enabled 仍是总开关（reducedMotion 再叠一层）。
  const randomRoam = move.randomRoam
  randomRoam.enabled = randomRoam.enabled !== false
  randomRoam.minIntervalMs = Math.round(
    clamp(randomRoam.minIntervalMs, 60_000, 60 * 60_000, defaults.movement.randomRoam.minIntervalMs)
  )
  randomRoam.maxIntervalMs = Math.round(
    clamp(randomRoam.maxIntervalMs, 60_000, 2 * 60 * 60_000, defaults.movement.randomRoam.maxIntervalMs)
  )
  if (randomRoam.maxIntervalMs < randomRoam.minIntervalMs) {
    randomRoam.maxIntervalMs = randomRoam.minIntervalMs
  }
}

function normalizeWorkspace(out: AppConfig): void {
  const workspace = out.worlds.workspace
  // v27：“敏感文件额外审批”从未被运行时消费；读取只保留普通范围授权与
  // 通用审批规则。落盘前删除，避免旧版负载把它带回来。
  delete (workspace as unknown as Record<string, unknown>)['sensitiveApproval']
  workspace.root = pathText(workspace.root, 500)
  workspace.notesRoot = pathText(workspace.notesRoot, 500)
}

function normalizeAutonomy(out: AppConfig): void {
  const autonomy = out.autonomy
  // explore 是用户显式选择的 P0 模式；非法值仍回退到 assist。
  if (autonomy.mode !== 'assigned' && autonomy.mode !== 'assist' && autonomy.mode !== 'explore') {
    autonomy.mode = 'assist'
  }
  autonomy.task.maxMinutes = Math.round(clamp(autonomy.task.maxMinutes, 1, 120, 15))
  autonomy.task.maxToolCalls = Math.round(clamp(autonomy.task.maxToolCalls, 1, 200, 40))
  autonomy.task.retentionDays = Math.round(clamp(autonomy.task.retentionDays, 1, 365, 30))
  autonomy.takeoverCooldownMs = Math.round(
    clamp(autonomy.takeoverCooldownMs, 0, 60_000, 3_000)
  )
  autonomy.tickMinMs = Math.round(clamp(autonomy.tickMinMs, 60_000, 3_600_000, 300_000))
  autonomy.tickMaxMs = Math.round(
    clamp(autonomy.tickMaxMs, Math.max(300_000, autonomy.tickMinMs), 21_600_000, 1_800_000)
  )
  autonomy.backoffFactor = clamp(autonomy.backoffFactor, 1, 4, 2)
  autonomy.wakeGapMs = Math.round(clamp(autonomy.wakeGapMs, 10_000, 300_000, 30_000))
  autonomy.postUserCooldownMs = Math.round(clamp(autonomy.postUserCooldownMs, 0, 600_000, 45_000))
  autonomy.alarmMinDelayMs = Math.round(clamp(autonomy.alarmMinDelayMs, 5_000, 3_600_000, 30_000))
  autonomy.maxActiveAlarms = Math.round(clamp(autonomy.maxActiveAlarms, 1, 200, 20))
  if (
    autonomy.approvalMode !== 'model' &&
    autonomy.approvalMode !== 'strict' &&
    autonomy.approvalMode !== 'auto'
  ) {
    autonomy.approvalMode = 'model'
  }
  autonomy.trustedRoots = uniqueTexts(autonomy.trustedRoots, 32, 500)
  autonomy.sessionGrantMinutes = Math.round(clamp(autonomy.sessionGrantMinutes, 5, 1_440, 480))
  autonomy.terminalAllowlist = uniqueTexts(autonomy.terminalAllowlist, 100, 200)
  // v24 已移除独立的自动打开名单；手改配置或旧版 IPC 负载若仍带该键，
  // 在落盘前再次删除，避免 mergeConfig 的未知键兼容把它带回来。
  delete (autonomy as unknown as Record<string, unknown>)['appOpenAllowlist']
  autonomy.maxAutoOpsPerHour = Math.round(clamp(autonomy.maxAutoOpsPerHour, 1, 300, 60))
  autonomy.autoWriteBackupCount = Math.round(clamp(autonomy.autoWriteBackupCount, 0, 100, 20))
}

function normalizeCompanion(out: AppConfig): void {
  const companion = out.companion
  // v27：旧 B 站浏览器路线已退役，companion.bilibili 只作为迁移输入；
  // 独立 B 站配置全部在 worlds.bilibili。
  delete (companion as unknown as Record<string, unknown>)['bilibili']
  if (
    companion.cadence !== 'quiet' &&
    companion.cadence !== 'natural' &&
    companion.cadence !== 'lively'
  ) {
    companion.cadence = 'natural'
  }
  companion.interests.maxActive = Math.round(clamp(companion.interests.maxActive, 2, 4, 4))
  companion.interests.ttlDays = Math.round(clamp(companion.interests.ttlDays, 1, 90, 14))
  companion.interests.maxFocusCount = Math.round(
    clamp(companion.interests.maxFocusCount, 1, 100, 12)
  )
  companion.experiences.retentionDays = Math.round(
    clamp(companion.experiences.retentionDays, 1, 90, 14)
  )
  companion.experiences.maxRecords = Math.round(clamp(companion.experiences.maxRecords, 10, 200, 50))
  const screenFeedback = companion.screenFeedback
  screenFeedback.minIntervalMs = Math.round(
    clamp(screenFeedback.minIntervalMs, 60_000, 30 * 60_000, 180_000)
  )
  screenFeedback.quietPresenceMs = Math.round(
    clamp(screenFeedback.quietPresenceMs, 5 * 60_000, 30 * 60_000, 600_000)
  )
  screenFeedback.questionMinIntervalMs = Math.round(
    clamp(screenFeedback.questionMinIntervalMs, 5 * 60_000, 60 * 60_000, 1_200_000)
  )
  screenFeedback.postUserCooldownMs = Math.round(
    clamp(screenFeedback.postUserCooldownMs, 10_000, 5 * 60_000, 60_000)
  )
  companion.unanswered.backoffFactor = clamp(companion.unanswered.backoffFactor, 1, 4, 2)
  companion.unanswered.maxBackoffMs = Math.round(
    clamp(companion.unanswered.maxBackoffMs, 60_000, 6 * 3_600_000, 3_600_000)
  )
}

function normalizeChatUi(out: AppConfig): void {
  const ui = out.chatUi
  ui.window.width = Math.round(clamp(ui.window.width, 360, 1_200, 640))
  ui.window.height = Math.round(clamp(ui.window.height, 400, 1_400, 720))
  ui.quickInput.width = Math.round(clamp(ui.quickInput.width, 280, 600, 380))
  ui.quickInput.maxReplyChars = Math.round(clamp(ui.quickInput.maxReplyChars, 100, 2_000, 400))
  ui.quickInput.deniedTools = uniqueTexts(ui.quickInput.deniedTools, 100, 64).filter((name) =>
    /^[a-z][a-z0-9_]*$/.test(name)
  )
  if (ui.petClickAction !== 'quick-input' && ui.petClickAction !== 'full-chat' && ui.petClickAction !== 'none') {
    ui.petClickAction = 'quick-input'
  }
  if (!ui.quickInput.enabled) {
    // 快捷输入被关掉时，点击桌宠不能落回到一个不存在的入口。
    if (ui.petClickAction === 'quick-input') ui.petClickAction = 'none'
  }
  // v27：快捷会话的真实审批转交行为不受这个旧开关影响，字段不再落盘。
  delete (ui.quickInput as unknown as Record<string, unknown>)['showApprovals']
}

function normalizeActivity(out: AppConfig): void {
  const activity = out.worlds.activity
  activity.titleMaxChars = Math.round(clamp(activity.titleMaxChars, 20, 160, 80))
  activity.appSwitchCoalesceMs = Math.round(clamp(activity.appSwitchCoalesceMs, 500, 10_000, 2_500))
  activity.appSwitchMaxHoldMs = Math.round(
    clamp(activity.appSwitchMaxHoldMs, activity.appSwitchCoalesceMs, 30_000, Math.max(activity.appSwitchCoalesceMs, 6_000))
  )
  activity.timelineMinutes = Math.round(clamp(activity.timelineMinutes, 5, 1_440, 90))
  activity.timelineMaxEntries = Math.round(clamp(activity.timelineMaxEntries, 20, 1_000, 200))
}

function normalizeBrowserPage(out: AppConfig): void {
  const page = out.worlds.browserPage
  if (page.consentAt !== null && !Number.isFinite(page.consentAt)) page.consentAt = null
  // 没有明确同意时间戳就不能启用；迁移与手改配置都不得绕过首次授权。
  if (page.consentAt === null) page.enabled = false
  page.excerptMaxChars = Math.round(clamp(page.excerptMaxChars, 200, 4_000, 1_200))
  page.coalesceMs = Math.round(clamp(page.coalesceMs, 1_000, 30_000, 3_000))
  page.maxPerMinute = Math.round(clamp(page.maxPerMinute, 1, 30, 6))
  page.maxPerHour = Math.round(clamp(page.maxPerHour, page.maxPerMinute, 300, 60))
  page.allowlist = normalizeDomains(page.allowlist, 200)
  page.denylist = normalizeDomains(page.denylist, 200)
  page.sensitiveDomains = normalizeDomains(page.sensitiveDomains, 200)
}

function normalizeBrowserControl(out: AppConfig): void {
  const control = out.worlds.browserControl
  if (control.consentAt !== null && !Number.isFinite(control.consentAt)) {
    control.consentAt = null
  }
  // 没有明确同意时间戳就不能开启；迁移/手改配置都不能绕过首次授权。
  if (control.consentAt === null) control.enabled = false
  // v27：后台标签偏好无消费者；站点表随旧 B 站浏览器路线一起退役。
  // 普通网页与独立 B 站各自使用自己的配置。
  const controlRecord = control as unknown as Record<string, unknown>
  delete controlRecord['backgroundTabs']
  delete controlRecord['sites']
  control.maxTabs = Math.round(clamp(control.maxTabs, 1, 12, 8))
  control.waitTimeoutMs = Math.round(clamp(control.waitTimeoutMs, 5_000, 30_000, 15_000))
  control.sessionMaxMs = Math.round(clamp(control.sessionMaxMs, 60_000, 900_000, 300_000))
  control.sessionMaxToolCalls = Math.round(
    clamp(control.sessionMaxToolCalls, 1, 60, 20)
  )
  control.discoveries.retentionDays = Math.round(
    clamp(control.discoveries.retentionDays, 1, 90, 30)
  )
  control.discoveries.maxRecords = Math.round(
    clamp(control.discoveries.maxRecords, 10, 500, 200)
  )
}

function normalizeBilibili(out: AppConfig): void {
  const bili = out.worlds.bilibili
  if (bili.consentAt !== null && (!Number.isFinite(bili.consentAt) || bili.consentAt <= 0)) {
    bili.consentAt = null
  }
  // 注意：这里不因为 consentAt 为空就抹掉 enabled。旧浏览器路线的开关
  // 意图需要被保留，设置页据此提示“需要重新确认”；真正是否生效由
  // effectiveCapabilities / World 的前置条件统一判定为 false。
  bili.enabled = bili.enabled === true
  bili.maxCandidatesPerBatch = Math.round(clamp(bili.maxCandidatesPerBatch, 5, 40, 20))
  bili.maxDetailsPerSession = Math.round(clamp(bili.maxDetailsPerSession, 1, 10, 5))
  bili.sessionMaxMs = Math.round(clamp(bili.sessionMaxMs, 60_000, 900_000, 300_000))
  bili.sessionMaxToolCalls = Math.round(clamp(bili.sessionMaxToolCalls, 1, 60, 20))
  bili.keywords = uniqueTexts(bili.keywords, 20, 40)
  bili.excludeKeywords = uniqueTexts(bili.excludeKeywords, 40, 40)
  bili.vision.enabled = bili.vision.enabled !== false
  bili.vision.maxFrames = Math.round(clamp(bili.vision.maxFrames, 1, 6, 6))
  bili.vision.defaultFrames = Math.round(
    clamp(bili.vision.defaultFrames, 1, bili.vision.maxFrames, 3)
  )
  if (!['tiny', 'base', 'small', 'medium'].includes(bili.asr.model)) bili.asr.model = 'small'
  bili.asr.enabled = bili.asr.enabled !== false
  bili.asr.maxMediaMinutes = Math.round(clamp(bili.asr.maxMediaMinutes, 1, 240, 30))
  bili.asr.maxDownloadMb = Math.round(clamp(bili.asr.maxDownloadMb, 50, 2_048, 300))
  bili.asr.maxRunMinutes = Math.round(clamp(bili.asr.maxRunMinutes, 1, 120, 20))
  bili.asr.maxCacheMb = Math.round(clamp(bili.asr.maxCacheMb, 256, 10_240, 1_024))
  bili.report.enabled = bili.report.enabled !== false
  bili.report.retentionDays = Math.round(clamp(bili.report.retentionDays, 1, 90, 30))
}

function normalizeCua(out: AppConfig): void {
  const cua = out.worlds.cua
  if (cua.permission !== 'ask-once' && cua.permission !== 'ask-each-action') {
    cua.permission = 'ask-once'
  }
  if (cua.consentAt !== null && !Number.isFinite(cua.consentAt)) cua.consentAt = null
  if (cua.screenConsentAt !== null && !Number.isFinite(cua.screenConsentAt)) {
    cua.screenConsentAt = null
  }
  // 键鼠授权与截图发送授权缺一不可；手改配置不能绕过首次同意。
  if (cua.consentAt === null || cua.screenConsentAt === null) cua.enabled = false
  cua.grantMinutes = Math.round(clamp(cua.grantMinutes, 5, 120, 30))
  cua.maxActionsPerTurn = Math.round(clamp(cua.maxActionsPerTurn, 1, 60, 30))
  cua.screenshotMaxWidth = Math.round(clamp(cua.screenshotMaxWidth, 960, 1_920, 1_280))
  cua.jpegQuality = Math.round(clamp(cua.jpegQuality, 50, 90, 72))
  cua.settleMs = Math.round(clamp(cua.settleMs, 100, 2_000, 350))
  cua.blockedApps = normalizeProcessNames(cua.blockedApps)
}

function normalizeDesktop(out: AppConfig): void {
  const desktop = out.worlds.desktop
  desktop.structuredText = desktop.structuredText !== false
  desktop.windowCapture = desktop.windowCapture === true
  desktop.maxWindows = Math.round(clamp(desktop.maxWindows, 1, 20, 8))
  desktop.maxTextChars = Math.round(clamp(desktop.maxTextChars, 500, 20_000, 8_000))
  desktop.maxObservePerHour = Math.round(clamp(desktop.maxObservePerHour, 1, 200, 30))

  const apps: DesktopScopeApp[] = []
  const seen = new Set<string>()
  if (Array.isArray(desktop.apps)) {
    for (const raw of desktop.apps) {
      if (raw === null || typeof raw !== 'object') continue
      const record = raw as Partial<DesktopScopeApp>
      const key = processKey(text(record.process, 120))
      if (key === '' || seen.has(key)) continue
      // 固定敏感/提权/终端/自身进程永远不能加入观察范围。
      if (SELF_PROCESS_KEYS.has(key) || isFixedSensitiveProcess(key)) continue
      const observe = record.observe === true
      const input = record.input === true && observe
      seen.add(key)
      apps.push({
        process: key,
        label: text(record.label, 40) || APP_LABEL_FALLBACKS[key] || key,
        observe,
        input
      })
      if (apps.length >= 12) break
    }
  }
  desktop.apps = apps
}

/** 设置页不需要知道全部内置应用名；这里只给常见项一个默认标签。 */
const APP_LABEL_FALLBACKS: Record<string, string> = {
  chrome: 'Chrome',
  msedge: 'Edge',
  firefox: 'Firefox',
  code: 'VS Code',
  cursor: 'Cursor',
  notepad: '记事本',
  explorer: '文件资源管理器',
  obsidian: 'Obsidian',
  notion: 'Notion',
  winword: 'Word',
  excel: 'Excel',
  spotify: 'Spotify'
}

function normalizeProcessNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const name = text(item, 120).toLowerCase()
    if (name === '' || seen.has(name) || /[\\/\u0000-\u001f]/.test(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= 100) break
  }
  return out
}

function normalizeVision(out: AppConfig): void {
  const vision = out.worlds.activity.vision
  const languages: VisionLanguage[] = ['auto', 'zh-Hans', 'en-US']
  if (!languages.includes(vision.language)) vision.language = 'auto'
  // 高频截图造成卡顿：第一版只开放经验证的 60/120 秒。30 秒要等性能验收
  // 通过后再开放，加载旧配置同样不能把周期压到 60 秒以下。
  // 第一版只开放 60/120 秒两档；旧配置或手改的中间值归到更慢的一档，
  // 避免出现设置页没有对应选项、却仍在运行的隐藏节奏。
  const requestedDesktop = clamp(vision.desktopSampleMs, 60_000, 120_000, 60_000)
  vision.desktopSampleMs = requestedDesktop > 60_000 ? 120_000 : 60_000
  // 连续静态档第一版固定 120 秒；不允许旧配置或手改把它压回基础周期，
  // 否则设置页显示的“静止 120 秒”与实际节奏不一致。
  vision.staticSampleMs = 120_000
  vision.ocrMinGapMs = Math.round(clamp(vision.ocrMinGapMs, 1_000, 30_000, 3_000))
  vision.keepSamples = Math.round(clamp(vision.keepSamples, 0, 100, 20))
  vision.ocrFallback = vision.ocrFallback === true
  if (vision.consentAt !== null && !Number.isFinite(vision.consentAt)) vision.consentAt = null
  // 没有明确同意时间戳就不能启用；避免手改配置绕过首次授权。
  if (vision.consentAt === null) vision.enabled = false
  if (
    vision.screenShareConsentAt !== null &&
    (!Number.isFinite(vision.screenShareConsentAt) || vision.screenShareConsentAt <= 0)
  ) {
    vision.screenShareConsentAt = null
  }
  // 同意范围版本必须与当前代码一致；旧版本同意不能自动扩大成整屏共享。
  if (
    vision.screenShareConsentAt === null ||
    vision.screenShareConsentVersion !== SCREEN_SHARE_CONSENT_VERSION
  ) {
    vision.screenShareConsentAt = null
    vision.screenShareConsentVersion = 0
  }

  const semantic = vision.semantic
  semantic.timeoutMs = Math.round(clamp(semantic.timeoutMs, 5_000, 60_000, 20_000))

  // 已退出运行配置的旧字段不能通过 mergeConfig/手改文件继续落盘，否则
  // 设置页会看到“看似还存在”的开关，旧值也可能在回退版本后复活。
  const visionRecord = vision as unknown as Record<string, unknown>
  delete visionRecord['gameSampleMs']
  delete visionRecord['frameBufferSeconds']
  delete visionRecord['maxFrames']
  delete visionRecord['pinnedDisplayId']
  const semanticRecord = semantic as unknown as Record<string, unknown>
  delete semanticRecord['enabled']
  delete semanticRecord['shareFrames']
  delete semanticRecord['maxKeyframes']
  delete semanticRecord['minIntervalMs']
  // v27：旧独立视觉模型/地址退出运行配置；整屏共享仍需重新确认。
  delete semanticRecord['model']
  delete semanticRecord['baseUrl']
}

/**
 * 磁盘范围模式必须显式合法；手改或旧字段回退到 fail-closed 的 explicit，
 * 不把坏值解释成“全部磁盘”。excludedDomains/Apps 的校验在设置页与
 * 各 World 里继续执行，这里只做基本类型收敛。
 */
function normalizeExploration(out: AppConfig): void {
  if (!isVolumeAccessMode(out.exploration.volumeScope)) {
    out.exploration.volumeScope = 'explicit'
  }
  out.exploration.readRoots = uniqueTexts(out.exploration.readRoots, 64, 500)
  out.exploration.excludedDomains = uniqueTexts(out.exploration.excludedDomains, 200, 200)
  out.exploration.excludedApps = uniqueTexts(out.exploration.excludedApps, 200, 200)
  out.exploration.artifactRoot = pathText(out.exploration.artifactRoot, 500)
}

function normalizeFiles(out: AppConfig): void {
  const files = out.worlds.files
  // v27：后台随机抽样整条链路退役。只删除抽样专用键；roots/exclude 仍是
  // 主动文件探索与读写的统一范围，不在这里扩张或收缩。
  const filesRecord = files as unknown as Record<string, unknown>
  delete filesRecord['enabled']
  delete filesRecord['includeFixedDrives']
  delete filesRecord['peekIntervalMinutes']
  delete filesRecord['maxReadBytes']
  delete filesRecord['allowContent']
  delete filesRecord['shareExcerptWithModel']
  delete filesRecord['shareFileNameWithModel']
  delete filesRecord['rememberDays']
  files.roots = uniqueTexts(files.roots, 32, 500)
  files.exclude = uniqueTexts(files.exclude, 200, 200)
}

function normalizeSystem(out: AppConfig): void {
  const system = out.worlds.system
  // v24 起系统动作固定为七种，不再有用户分组配置；同 appOpenAllowlist，
  // 在规范化阶段删除旧键，保证保存后不复活。
  delete (system as unknown as Record<string, unknown>)['actions']
  // v27：白名单自动审批开关从未被 systemWorld 消费；审批仍由实际策略决定。
  delete (system as unknown as Record<string, unknown>)['autoApproveWhitelisted']

  const seen = new Set<string>()
  const apps: SystemAppEntry[] = []
  for (const app of system.apps) {
    const id = text(app.id, 64)
    const path = text(app.path, 500)
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || seen.has(id) || path === '') continue
    seen.add(id)
    apps.push({
      id,
      label: text(app.label, 80) || id,
      path,
      args: uniqueTexts(app.args, 20, 200)
    })
    if (apps.length >= 64) break
  }
  system.apps = apps
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** 目录字段：去空白/限长；NUL、UNC 与应用数据目录校验留给 IPC 与 Guard。 */
function pathText(value: unknown, max: number): string {
  const s = text(value, max)
  if (s.includes('\u0000')) return ''
  if (s.startsWith('\\\\') || s.startsWith('//')) return ''
  return s
}

function uniqueTexts(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const s = text(item, maxLength)
    if (s === '' || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= maxItems) break
  }
  return out
}

/** 域名/通配符模式：小写、去掉协议与路径，只保留字母数字点和连字符。 */
function normalizeDomains(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    let s = item.trim().toLowerCase()
    s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0] ?? ''
    s = s.replace(/:\d+$/, '')
    if (s === '' || s.length > 200) continue
    if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(s)) continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= maxItems) break
  }
  return out
}
