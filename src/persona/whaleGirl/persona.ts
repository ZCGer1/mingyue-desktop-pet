import { join } from 'node:path'
import type { AppConfig } from '../../shared/config'
import { effectiveCapabilities } from '../../shared/effectiveCapabilities'
import { DiscoveryStore } from '../companion/discoveryStore'
import { ExperienceStore } from '../companion/experienceStore'
import { ExplorationStore } from '../companion/explorationStore'
import { InterestStore } from '../companion/interestStore'
import type {
  ContextRecord,
  CoreApi,
  EventEnvelope,
  PrefixSegment,
  SessionDecl,
  ToolDef,
  TurnOutcome,
  WorldPrefixContext
} from '../../core/types'
import type { DiscoveryRecord } from '../../shared/discovery'
import type { AuditLog } from '../../core/audit'
import type { Logger } from '../../core/types'
import { createToolCatalogTools } from '../../core/toolCatalog'
import type { ActivityCategory } from '../../worlds/activity/types'
import { AutonomyController } from './autonomy'
import { ChatCadenceController, type CadenceDecision } from './chatCadence'
import { createAlarmTools } from './alarms'
import { createCompanionTools, type CompanionFeedback } from './companionTools'
import { createDiscoveryTools } from './discoveryTools'
import { generateHandoffNote, buildHandoffTail } from './handoff'
import { MemoryStore } from './memory'
import { createMemoryTools } from './memoryTools'
import {
  AUTONOMY_SEGMENT,
  EPISTEMOLOGY_SEGMENT,
  MEMORY_PROTOCOL_SEGMENT,
  buildBoundarySegment,
  buildCapabilitySegment,
  buildCustomInstructionsSegment,
  buildDiscoveriesSegment,
  buildDiscoveryFeedbackSegment,
  buildDiscoveryProtocolSegment,
  buildEnvironmentSegment,
  buildExperiencesSegment,
  buildIdentitySegment,
  buildInterestsSegment,
  buildMemorySegment,
  buildPermissionSegment,
  buildStyleSegment,
  renderWorldPrompts
} from './prompt'
import { createReminderTools } from './reminders'
import { RoleplayState } from './state'

export interface WhaleGirlOptions {
  getConfig: () => AppConfig
  memoryDir: string
  /** 兴趣/经历/探索进度目录；默认放在记忆目录下的 companion/。 */
  companionDir?: string
  /** 角色状态文件；为 null 时只保留在内存里（测试用）。 */
  stateFile?: string | null
  logger: Logger
  audit?: AuditLog | null
  rng?: () => number
  now?: () => number
  /** 自主 tick 用的脱敏环境快照；由装配层提供。 */
  autonomyContext?: () => string | null
  /** 自主探索候选（兴趣/经历/最近看过）；由装配层从 companion 存储汇总。 */
  exploreCandidates?: () => string | null
  /** 与设置页/诊断共用的运行时能力摘要；由装配层从统一快照生成。 */
  capabilitySummary?: () => { scopes: string[]; reasons: string[] } | null
  /** 用户是否真的不在电脑前；只影响主动聊天，不阻断探索。 */
  isUserAway?: () => boolean | Promise<boolean>
  hasActiveAutonomyTask?: () => boolean
  /** 是否存在真正等待回答的主动问题；评论/提议不算。 */
  hasOpenQuestion?: () => boolean
  /** 当前未回答问题的过期时刻。 */
  openQuestionExpiresAt?: () => number | null
  /** 最近一次模型展示动作的时间（PetWorld）。 */
  lastPresentationAt?: () => number
  /** 最早的相关候选到期时间；用于 rest/waiting 的提前复查。 */
  nextCandidateAt?: () => number | null
  /** 兴趣/经历/探索文件变化时通知装配层（用于刷新状态）。 */
  onCompanionChange?: () => void
  /** 发现成功写入后通知装配层（用于关联 B 站阅读记录与日报）。 */
  onDiscoverySaved?: (record: DiscoveryRecord) => void
  /** 模型或快捷面板记下用户反馈后的脱敏回调；只调整聊天节奏。 */
  onCompanionFeedback?: (feedback: CompanionFeedback) => void
  /** 聊天节奏做出决策/开口后通知装配层刷新状态（节流由装配层负责）。 */
  onCadenceChange?: () => void
  /** 脱敏的节奏决策回调；只带枚举原因与时间。 */
  onCadenceDecision?: (decision: CadenceDecision) => void
  /** 她真的开口时回调；装配层只记时间/计数。 */
  onCadenceSpoke?: (at: number) => void
}

/**
 * 「桌宠」Persona 的装配（PLAN.md §3）。
 * 负责系统前缀、Memory、闹钟/提醒与自主 tick；不直接读 World 状态。
 *
 * 所有语义决策都交给模型：这里没有本地台词、问候或沉默补位。
 */
export class WhaleGirlPersona {
  readonly memoryDir: string
  readonly companionDir: string
  readonly autonomy: AutonomyController
  readonly cadence: ChatCadenceController
  private readonly getConfig: () => AppConfig
  private readonly logger: Logger
  private readonly memory: MemoryStore
  private readonly interests: InterestStore
  private readonly experiences: ExperienceStore
  private readonly exploration: ExplorationStore
  private readonly discoveries: DiscoveryStore
  private readonly state: RoleplayState
  private readonly tools: ToolDef[]
  private readonly audit: AuditLog | null
  private core: CoreApi | null = null
  private softWarnedOnce = false

  constructor(opts: WhaleGirlOptions) {
    this.getConfig = opts.getConfig
    this.memoryDir = opts.memoryDir
    this.companionDir = opts.companionDir ?? join(opts.memoryDir, 'companion')
    this.logger = opts.logger
    this.audit = opts.audit ?? null
    const now = opts.now ?? Date.now
    const memoryEnabled = (): boolean => this.getConfig().memory.enabled

    this.state = new RoleplayState({
      file: opts.stateFile ?? null,
      now
    })

    this.memory = new MemoryStore({
      dir: opts.memoryDir,
      enabled: memoryEnabled,
      audit: opts.audit ?? null,
      logger: opts.logger
    })

    this.interests = new InterestStore({
      file: join(this.companionDir, 'interests.json'),
      enabled: memoryEnabled,
      limits: () => this.getConfig().companion.interests,
      now,
      logger: opts.logger,
      ...(opts.onCompanionChange === undefined ? {} : { onChange: opts.onCompanionChange })
    })
    this.experiences = new ExperienceStore({
      file: join(this.companionDir, 'experiences.json'),
      enabled: memoryEnabled,
      limits: () => this.getConfig().companion.experiences,
      now,
      logger: opts.logger,
      ...(opts.onCompanionChange === undefined ? {} : { onChange: opts.onCompanionChange })
    })
    this.exploration = new ExplorationStore({
      file: join(this.companionDir, 'exploration.json'),
      enabled: memoryEnabled,
      now,
      logger: opts.logger,
      ...(opts.onCompanionChange === undefined ? {} : { onChange: opts.onCompanionChange })
    })
    this.discoveries = new DiscoveryStore({
      file: join(this.companionDir, 'discoveries.json'),
      enabled: memoryEnabled,
      limits: () => ({
        retentionDays: this.getConfig().worlds.browserControl.discoveries.retentionDays,
        maxRecords: this.getConfig().worlds.browserControl.discoveries.maxRecords
      }),
      now,
      logger: opts.logger,
      ...(opts.onCompanionChange === undefined ? {} : { onChange: opts.onCompanionChange })
    })

    this.autonomy = new AutonomyController({
      getConfig: this.getConfig,
      isBusy: () => this.core?.isBusy() ?? false,
      isPaused: () => this.core?.isPaused() ?? false,
      ...(opts.hasActiveAutonomyTask === undefined
        ? {}
        : { hasActiveAutonomyTask: opts.hasActiveAutonomyTask }),
      ...(opts.autonomyContext === undefined ? {} : { describeContext: opts.autonomyContext }),
      ...(opts.exploreCandidates === undefined
        ? {}
        : { describeCandidates: opts.exploreCandidates }),
      ...(opts.capabilitySummary === undefined
        ? {}
        : { capabilitySummary: opts.capabilitySummary }),
      ...(opts.lastPresentationAt === undefined
        ? {}
        : { lastPresentationAt: opts.lastPresentationAt }),
      ...(opts.nextCandidateAt === undefined
        ? {}
        : { nextCandidateAt: opts.nextCandidateAt }),
      inject: (text) => this.core?.injectWake(text, 'autonomy') ?? null,
      logger: opts.logger,
      now
    })

    this.cadence = new ChatCadenceController({
      getConfig: this.getConfig,
      isBusy: () => this.core?.isBusy() ?? false,
      isPaused: () => this.core?.isPaused() ?? false,
      ...(opts.isUserAway === undefined ? {} : { isUserAway: opts.isUserAway }),
      ...(opts.hasOpenQuestion === undefined ? {} : { hasOpenQuestion: opts.hasOpenQuestion }),
      ...(opts.openQuestionExpiresAt === undefined
        ? {}
        : { openQuestionExpiresAt: opts.openQuestionExpiresAt }),
      describeCompanion: () => this.companionContext(),
      inject: (text) => {
        const decision = this.core?.injectWake(text, 'companion')
        return (
          decision ?? {
            mode: 'piggyback',
            reason: 'disabled',
            deferredAt: null
          }
        )
      },
      logger: opts.logger,
      now,
      ...(opts.rng === undefined ? {} : { rng: opts.rng }),
      onDecision: (decision) => {
        opts.onCadenceChange?.()
        opts.onCadenceDecision?.(decision)
      },
      onSpoke: (at) => {
        opts.onCadenceChange?.()
        opts.onCadenceSpoke?.(at)
      }
    })

    this.tools = [
      ...createToolCatalogTools(),
      ...createMemoryTools(this.memory),
      ...createCompanionTools({
        interests: this.interests,
        now,
        ...(opts.onCompanionFeedback === undefined
          ? {}
          : { onFeedback: (feedback) => opts.onCompanionFeedback?.(feedback) })
      }),
      ...createDiscoveryTools({
        discoveries: this.discoveries,
        enabled: () =>
          this.getConfig().worlds.browserControl.enabled ||
          this.getConfig().worlds.bilibili.enabled,
        ...(opts.onDiscoverySaved === undefined
          ? {}
          : { onSaved: (record) => opts.onDiscoverySaved?.(record) }),
        now
      }),
      ...createReminderTools(() => this.core),
      ...createAlarmTools(
        () => this.core,
        () => this.getConfig()
      )
    ]
  }

  attach(core: CoreApi): void {
    this.core = core
  }

  get memoryStore(): MemoryStore {
    return this.memory
  }

  get autonomyController(): AutonomyController {
    return this.autonomy
  }

  get cadenceController(): ChatCadenceController {
    return this.cadence
  }

  get interestStore(): InterestStore {
    return this.interests
  }

  get experienceStore(): ExperienceStore {
    return this.experiences
  }

  get explorationStore(): ExplorationStore {
    return this.exploration
  }

  get discoveryStore(): DiscoveryStore {
    return this.discoveries
  }

  declareSessions(): SessionDecl[] {
    return [
      {
        id: 'main',
        label: this.getConfig().persona.name,
        rounds: () => ({ soft: 12, hard: 20 }),
        persistent: true,
        receivesEvents: true,
        eventDelivery: 'user',
        tools: () => this.tools
      }
    ]
  }

  async systemSegments(ctx: {
    now: Date
    timezone: string
    worlds: WorldPrefixContext[]
    toolExposure?: { loadedGroups: readonly string[]; catalogText: string }
  }): Promise<PrefixSegment[]> {
    const config = this.getConfig()
    const loaded = new Set(ctx.toolExposure?.loadedGroups ?? [])
    const groupVisible = (id: string): boolean =>
      ctx.toolExposure === undefined || loaded.has(id)
    const memoryVisible = config.memory.enabled
    const memoryText = buildMemorySegment(this.memory, config)
    const worldText = renderWorldPrompts(ctx.worlds)
    const segments: PrefixSegment[] = [
      { id: 'identity', text: buildIdentitySegment(config) },
      { id: 'style', text: buildStyleSegment(config) }
    ]
    const custom = buildCustomInstructionsSegment(config)
    if (custom !== '') segments.push({ id: 'custom-persona', text: custom })
    segments.push({ id: 'roleplay-state', text: this.state.segment() })
    if (memoryVisible) {
      const due = this.interests.dueRevisits(ctx.now.getTime())
      segments.push({
        id: 'interests',
        text: buildInterestsSegment(this.interests.activeForPrompt(4), due)
      })
      const experiences = buildExperiencesSegment(
        this.experiences.recentForPrompt(5),
        ctx.now.getTime()
      )
      if (experiences !== '') segments.push({ id: 'experiences', text: experiences })
    }
    segments.push(
      { id: 'capabilities', text: buildCapabilitySegment(config) },
      { id: 'boundaries', text: buildBoundarySegment(config) },
      { id: 'autonomy', text: AUTONOMY_SEGMENT },
      { id: 'permissions', text: buildPermissionSegment(config) },
      { id: 'epistemology', text: EPISTEMOLOGY_SEGMENT }
    )
    if (memoryVisible) {
      if (groupVisible('memory')) segments.push({ id: 'memory-protocol', text: MEMORY_PROTOCOL_SEGMENT })
      segments.push({ id: 'memory', text: memoryText })
    }
    const caps = effectiveCapabilities(config)
    if (caps.browserControl || caps.bilibili) {
      const protocol = buildDiscoveryProtocolSegment(config)
      if (groupVisible('discovery') && protocol !== '') segments.push({ id: 'discovery-protocol', text: protocol })
      if (config.memory.enabled) {
        const unshared = this.discoveries.unsharedForPrompt(4)
        const discoveryText = buildDiscoveriesSegment(unshared, {
          memoryEnabled: config.memory.enabled,
          total: this.discoveries.count()
        })
        if (discoveryText !== '') segments.push({ id: 'discoveries', text: discoveryText })
        // 反馈只作为后续挑选的软信号；即使这批发现都已分享，偏好仍要留在
        // 上下文里，否则“少来点/别再研究”只写进列表、不会影响下一次浏览。
        const feedbackText = buildDiscoveryFeedbackSegment(this.discoveries.recentFeedback(3))
        if (feedbackText !== '') {
          segments.push({ id: 'discovery-feedback', text: feedbackText })
        }
      }
    }
    if (worldText !== '') segments.push({ id: 'worlds', text: worldText })
    if (ctx.toolExposure !== undefined && ctx.toolExposure.catalogText.trim() !== '') {
      segments.push({ id: 'tool-groups', text: ctx.toolExposure.catalogText })
    }
    segments.push({
      id: 'environment',
      text: buildEnvironmentSegment({
        now: ctx.now,
        timezone: ctx.timezone,
        worlds: ctx.worlds,
        config
      })
    })
    return segments
  }

  onOpening(ctx: { reason: 'new' | 'restarted' | 'cleared' }): void {
    this.memory.ensureDefaults()
    this.autonomy.start()
    this.cadence.start()
    this.logger.info('Persona 开场', {
      reason: ctx.reason,
      memoryDir: this.memoryDir,
      autonomy: this.getConfig().autonomy.enabled,
      cadence: this.getConfig().companion.cadence
    })
  }

  onDelivery(ctx: { events: EventEnvelope[] }): void | string {
    const events = ctx.events
    const hasUser = events.some((event) => event.type === 'chat.user_message')
    const hasTimer = events.some((event) => event.type === 'timer.due')
    const hasExternal = events.some(
      (event) => event.type.startsWith('activity.') || event.type.startsWith('browser.')
    )
    if (hasExternal || hasTimer) this.autonomy.noteExternalActivity()
    if (hasUser) {
      this.autonomy.noteUserActivity()
      const first = events.find((event) => event.type === 'chat.user_message')
      const at = first === undefined ? Date.now() : Date.parse(first.ts)
      const when = Number.isFinite(at) ? at : Date.now()
      this.cadence.noteUserActivity(when)
      this.state.noteInteraction(when)
      this.softWarnedOnce = false
    }
    for (const event of events) {
      if (!event.type.startsWith('activity.')) continue
      const category = event.meta?.['category']
      if (typeof category === 'string') {
        this.noteActivityCategory(category as ActivityCategory, Date.parse(event.ts))
      }
    }
    return undefined
  }

  onBatchEnd(): void {
    if (this.core === null) return
    const config = this.getConfig()
    const info = this.core.sessionInfo('main')
    const hardCapacity = Math.min(
      config.context.maxTokens,
      Math.max(1024, config.provider.contextWindow - config.provider.maxOutputTokens)
    )
    const soft = hardCapacity * config.context.softRatio
    if (info.estTokens <= soft) {
      this.softWarnedOnce = false
      return
    }
    if (!this.softWarnedOnce) {
      this.softWarnedOnce = true
      this.logger.info('上下文超过软阈值，先提醒', { est: info.estTokens, soft: Math.round(soft) })
      return
    }
    this.logger.info('上下文仍超过软阈值，请求交接', { est: info.estTokens })
    this.core.requestContextHandoff()
  }

  onTurnEnded(outcome: TurnOutcome): void {
    if (outcome === 'failed') this.logger.warn('本轮以失败结束')
  }

  // 空闲回调不再重排自主/聊天节奏：无关的聊天或任务轮不能把探索与主动
  // 聊天的下一次考虑不断往后推。两个控制器自己会在暂停/忙碌后重试。

  async onHandoff(
    snapshot: ContextRecord[],
    ctx: { hardTokens: number | null }
  ): Promise<{ tail: ContextRecord[] | null; trim?: boolean }> {
    void ctx
    const tail = buildHandoffTail(snapshot)
    if (this.core !== null && this.getConfig().memory.enabled) {
      const note = await generateHandoffNote({
        core: this.core,
        records: snapshot,
        logger: this.logger,
        enabled: true,
        name: this.getConfig().persona.name
      })
      if (note !== '') this.memory.appendRecent(note)
    }
    return { tail, trim: true }
  }

  ownToolNames(): string[] {
    return this.tools.map((tool) => tool.name)
  }

  /** 设置页「清空本地数据」时一并清掉角色状态与自主退避。 */
  clearRoleplayState(): void {
    this.state.clear()
    this.autonomy.reset()
    this.cadence.clear()
  }

  /** 设置页「清空本地数据」：兴趣/经历/探索进度/发现一起清空。 */
  clearCompanionData(): void {
    this.interests.clear()
    this.experiences.clear()
    this.exploration.clear()
    this.discoveries.clear()
  }

  /** 删除记忆关键词时同步遗忘相关兴趣/经历/指纹/发现。 */
  forgetCompanionMatching(query: string): {
    interests: number
    experiences: number
    exploration: number
    discoveries: number
  } {
    const removed = {
      interests: this.interests.forgetMatching(query),
      experiences: this.experiences.forgetMatching(query),
      exploration: this.exploration.forgetMatching(query),
      discoveries: this.discoveries.forgetMatching(query)
    }
    return removed
  }

  /** 用户直接触摸/拖拽桌宠；由 Bot 限频后调用，不让每次拖拽都加 affinity。 */
  noteUserTouch(at = Date.now()): void {
    this.state.noteInteraction(at)
    this.cadence.noteUserActivity(at)
  }

  /** 最近一次用户互动时间；用于自主探索的空闲判断。 */
  lastInteractionAt(): number | null {
    return this.state.lastInteractionAt()
  }

  /** 设置页诊断。 */
  diagnostics(): Record<string, unknown> {
    return {
      memoryDir: this.memoryDir,
      memoryEnabled: this.getConfig().memory.enabled,
      memoryFiles: this.memory.list(),
      roleplay: this.state.snapshot(),
      autonomy: this.autonomy.diagnostics(),
      companion: {
        interests: this.interests.countByStatus(),
        experiences: this.experiences.count(),
        exploration: this.exploration.count(),
        discoveries: this.discoveries.count(),
        discoveriesMemoryOnly: this.discoveries.hasEphemeral(),
        cadence: this.cadence.diagnostics()
      }
    }
  }

  /**
   * 只含已脱敏的兴趣标题/下一步与经历摘要；不注入原文或标题。
   * 主聊天、快捷聊天和屏幕评论共用这份背景。
   */
  companionBackdrop(): string | null {
    return this.companionContext()
  }

  private companionContext(): string | null {
    if (!this.getConfig().memory.enabled) return null
    const parts: string[] = []
    const active = this.interests.activeForPrompt(3)
    if (active.length > 0) {
      const records = active.map((record) =>
        record.nextStep === null
          ? `「${record.title}」`
          : `「${record.title}」（下一步：${record.nextStep}）`
      )
      parts.push(`活跃兴趣：${records.join('；')}`)
    }
    const recent = this.experiences.recentForPrompt(3)
    if (recent.length > 0) {
      parts.push(`最近真实经历：${recent.map((record) => record.summary).join('；')}`)
    }
    // 只给数量，不把网页标题/摘要塞进聊天节奏提示；正文在系统前缀里按
    // 不可信数据单独呈现。
    const unshared = this.discoveries.unsharedForPrompt(8).length
    if (unshared > 0) {
      parts.push(`有 ${unshared} 条自己逛到、还没分享的视频发现`)
    }
    return parts.length > 0 ? parts.join('\n') : null
  }

  private noteActivityCategory(category: ActivityCategory, at: number): void {
    if (!Number.isFinite(at)) return
    // 只存抽象类别与时间，不存进程名/窗口标题。
    this.state.noteActivity(category, at)
  }
}

/** 供装配层使用的默认记忆目录。 */
export function memoryDirFor(dataRoot: string): string {
  return join(dataRoot, 'memory')
}
