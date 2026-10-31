import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppConfig } from '../../shared/config'
import type {
  Logger,
  RunPhaseState,
  ToolDef,
  ToolOutcome,
  World,
  WorldDescribe,
  WorldHost
} from '../../core/types'
import { dateKey, inQuietHours } from '../../core/util'
import type { ScreenObservation } from '../../core/screenCompanion'
import ENV_PROMPT from './ENV_PROMPT.md?raw'
import type { ForegroundProvider, ForegroundSample, SystemActivityProvider } from './foreground'
import { normalizeProcessName, resolveAppLabel, sanitizeWindowTitle } from './appIdentity'
import type {
  SceneDescriptor,
  SceneEvidenceSource,
  ScenePhase,
  SceneProvider,
  SceneState,
  SceneStatus
} from './scene'
import { isKnownPhase, sceneLabel, scenePhaseLabel } from './scene'
import { ActivityStats, type DayStats } from './stats'
import { ActivityTimeline, formatTimeline } from './timeline'
import {
  CATEGORY_LABELS,
  PROCESS_CATEGORIES,
  categoryLabel,
  categoryTableMarkdown,
  timeBucketOf,
  type ActivityCategory,
  type ActivityEvent,
  type ActivityEventNotice,
  type ActivityKind,
  type TimeBucket
} from './types'

const PRIORITY: Record<ActivityKind, number> = {
  category_change: 0,
  app_switch: 105,
  content_change: 103,
  day_first: 100,
  resume: 98,
  lock_away: 97,
  idle_return: 96,
  late_night: 85,
  long_session: 80,
  focus_long: 75,
  idle_start: 70,
  category_enter: 65,
  category_exit: 64,
  scene_enter: 64,
  scene_phase: 63,
  scene_change: 62,
  switch_storm: 40,
  scene_stay: 39
}

const WAKE_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  'app_switch',
  'content_change',
  'idle_return',
  'lock_away',
  'resume',
  'focus_long',
  'long_session',
  'switch_storm',
  'late_night',
  'scene_enter',
  'scene_phase',
  'scene_change'
])

const MAX_RAW_SAMPLES = 20

/**
 * 明确不做截图/OCR 的前台应用（密码管理器、常见银行/钱包客户端与系统凭据 UI）。
 * 进程名只在本对象内存里比较，不会离开 ActivityWorld。
 * 进入这些应用不产生事件、不写 timeline、不共享应用名或标题。
 */
const SENSITIVE_PROCESSES = new Set([
  '1password',
  'bitwarden',
  'keepass',
  'keepassxc',
  'lastpass',
  'dashlane',
  'enpass',
  'roboform',
  'nordpass',
  'authy',
  'credentialuibroker',
  'logonui'
])

const SENSITIVE_PROCESS_PATTERNS = ['password', 'bank', 'wallet', 'authenticator']

interface RawSample {
  processName: string
  category: ActivityCategory
  since: number
  lastAt: number
}

interface PendingSample {
  processName: string
  /** 原始标题只在本对象内存里停留到下一次采样。 */
  title: string | null
}

/** 诊断链阶段：从观察到本地反应、任务与最终结果。 */
export type SceneTraceStage = 'decision' | 'reaction' | 'task' | 'outcome'

/**
 * 一个诊断步骤。只允许固定枚举与不透明引用；不保存屏幕正文、标题、
 * OCR 原文或工具回执。
 */
export interface SceneTraceStep {
  at: number
  stage: SceneTraceStage
  /** 固定枚举：accepted/deferred/suppressed/candidate/local-action/speak/silent… */
  outcome: string
  /** 固定枚举原因：eligible/busy/quiet/expired/dedupe/no_need/provider-failed… */
  reason: string
  /** 任务 id 前缀或动作标签；不是正文。 */
  ref: string | null
}

/**
 * 场景事件诊断链：只保留抽象字段与证据时间，不含标题、关键词或 OCR 原文。
 * 这是内存环形记录，用来核对 observationId → sceneEventId → 决策 → 反应/任务 → 结果。
 */
export interface SceneEventDiagnostic {
  eventId: string
  kind: ActivityKind
  at: number
  evidenceAt: number
  observationId: string | null
  category: SceneDescriptor['category']
  activity: string
  phase: ScenePhase
  previousPhase: ScenePhase | null
  game: string | null
  change: string | null
  detail: string | null
  source: string | null
  quality: string | null
  revision: number | null
  /** 处理链，按发生顺序；每个事件最多保留 12 步。 */
  chain: SceneTraceStep[]
}

/** 诊断字段只接受短枚举/不透明引用，防止正文意外混入。 */
function cleanTraceToken(value: unknown, max = 40): string {
  if (typeof value !== 'string') return ''
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '')
    .slice(0, max)
}

interface PendingAppSwitch {
  firstAt: number
  lastAt: number
  category: ActivityCategory
  previousCategory: ActivityCategory | null
  appLabel: string | null
  previousAppLabel: string | null
  titleSanitized: string | null
  titleSuppressed: boolean
  appStayMinutes: number
  coalescedSwitches: number
  timeBucket: TimeBucket
}

interface ActivityWorldOptions {
  getConfig: () => AppConfig
  logger: Logger
  foreground?: ForegroundProvider | null
  system?: SystemActivityProvider | null
  /** 截图/OCR 场景来源；不传则只有进程类别感知。 */
  scene?: SceneProvider | null
  statsFile?: string | null
  /** 测试时可关掉定时器，只用 ingest* 方法。 */
  autoSample?: boolean
  isOnBattery?: () => boolean
  onDegraded?: (reason: string) => void
  /** 本地反应层：事件派发时同步通知（脱敏字段，不落盘）。 */
  onEvent?: (notice: ActivityEventNotice) => void
  /** 最近是否有桌宠自己发起的桌面动作；有则事件标记为自身动作。 */
  isSelfAction?: () => boolean
  /**
   * 每次接受 `vision_model` 摘要后同步通知（即使场景 key 没有变化）。
   * 新的屏幕陪伴通道据此评估是否需要独立开口，不依赖模型主动调用工具。
   */
  onModelScene?: (observation: ScreenObservation) => void
  /**
   * 该观察是否已经由屏幕陪伴通道接管。接管时旧 reaction 只保留 ambient，
   * 避免同一条场景同时走两条主动发言路径。
   */
  ownsModelScene?: (observation: ScreenObservation) => boolean
  /** 场景因锁屏/挂起/敏感应用/目标切换/暂停而失效；控制器需取消在途候选。 */
  onSceneInvalidated?: (reason: string) => void
  now?: () => number
}

/**
 * Activity World（PLAN.md §4.4）：只读、类别级、脱敏。
 * 原始进程名只保留在本对象内存与设置页的本地快照里；原始窗口标题不落盘。
 * 事件里的应用显示名与标题都经过 appIdentity 脱敏，且只走 ephemeral 通道。
 */
export class ActivityWorld implements World {
  readonly id = 'activity'
  readonly describe: WorldDescribe = {
    tools: [
      { name: 'act_summary', description: '今天的类别时长、切换、专注、空闲与深夜摘要', tags: ['read'], approval: 'auto' },
      { name: 'act_current', description: '当前应用显示名、类别与已停留分钟', tags: ['read'], approval: 'auto' },
      { name: 'act_scene', description: '当前抽象场景（视频/浏览/写代码/游戏等）', tags: ['read'], approval: 'auto' },
      { name: 'act_timeline', description: '最近的活动时间线（应用显示名/类别/停留，不含标题）', tags: ['read'], approval: 'auto' }
    ],
    events: [
      { type: 'activity.app_switch', description: '前台应用切换（含同类别切换；已脱敏）' },
      { type: 'activity.content_change', description: '同一应用内窗口标题稳定变化（已脱敏，仅标题级证据）' },
      { type: 'activity.day_first', description: '当天首次活动' },
      { type: 'activity.category_enter', description: '类别连续停留 ≥10 分钟' },
      { type: 'activity.category_exit', description: '离开停留 ≥30 分钟的类别' },
      { type: 'activity.focus_long', description: '同类连续专注 50/90/120 分钟' },
      { type: 'activity.switch_storm', description: '10 分钟内切换 ≥20 次' },
      { type: 'activity.idle_start', description: '空闲 ≥5 分钟' },
      { type: 'activity.idle_return', description: '空闲后恢复' },
      { type: 'activity.late_night', description: '22:30–23:30 仍活跃' },
      { type: 'activity.long_session', description: '连续活跃 ≥2 小时' },
      { type: 'activity.lock_away', description: '锁屏 ≥15 分钟后解锁' },
      { type: 'activity.resume', description: '睡眠恢复' },
      { type: 'activity.scene_enter', description: '截图/OCR 识别到新的抽象场景（不含原文）' },
      { type: 'activity.scene_phase', description: '同一应用内的游戏阶段变化（菜单/加载/游玩/暂停/结算）' },
      { type: 'activity.scene_change', description: '场景或可验证的语义发生变化' },
      { type: 'activity.scene_stay', description: '同一场景持续 ≥30 分钟（低频）' }
    ]
  }

  private readonly getConfig: () => AppConfig
  private readonly logger: Logger
  private readonly foreground: ForegroundProvider | null
  private readonly system: SystemActivityProvider | null
  private readonly scene: SceneProvider | null
  private readonly autoSample: boolean
  private readonly isOnBattery: () => boolean
  private readonly onDegraded: ((reason: string) => void) | undefined
  private readonly onEvent: ((notice: ActivityEventNotice) => void) | undefined
  private readonly isSelfAction: (() => boolean) | undefined
  private readonly onModelScene: ((observation: ScreenObservation) => void) | undefined
  private readonly ownsModelScene: ((observation: ScreenObservation) => boolean) | undefined
  private readonly onSceneInvalidated: ((reason: string) => void) | undefined
  private readonly now: () => number
  private readonly stats: ActivityStats
  private readonly timeline: ActivityTimeline

  private host: WorldHost | null = null
  private sampling = false
  private userPaused = false
  private idleTimer: NodeJS.Timeout | null = null
  private systemUnsubs: Array<() => void> = []
  private lastIdlePollAt = 0

  private currentProcess: string | null = null
  private pendingSample: PendingSample | null = null
  private currentCategory: ActivityCategory | null = null
  private currentAppLabel: string | null = null
  private currentTitle: string | null = null
  private currentTitleSuppressed = false
  private currentShareable = false
  private sensitiveActive = false
  private stayStart = 0
  private appSince = 0
  private enterEmitted = false
  private milestones = new Set<number>()
  private switchTimes: number[] = []
  private lastStormAt = 0
  private lastLongSessionAt = 0
  private sessionStart = 0
  private lastProcessSampleAt = 0
  private lastStatsAt = 0
  private idle = false
  private idleSince = 0
  private locked = false
  private lockStart = 0
  private suspended = false
  private suspendStart = 0
  private lastDayFirstDay = ''
  private lastLateNightDay = ''
  private pendingEvents: ActivityEvent[] = []
  private pendingAppSwitch: PendingAppSwitch | null = null
  private rawSamples: RawSample[] = []
  private currentScene: SceneDescriptor | null = null
  private sceneSamples: SceneDescriptor[] = []
  private sceneEventLog: SceneEventDiagnostic[] = []
  private lastSceneKey = ''
  private lastSceneStayAt = 0
  private lastSceneEvidenceAt = 0
  private lastSemanticEvidenceAt = 0
  private lastAcceptedSceneRevision = -1
  private lastSceneChange: string | null = null
  private scenePhaseSince = 0
  private lastForegroundBounds: { x: number; y: number; width: number; height: number } | null = null
  /** 前台窗口的不透明标识（进程名哈希），只用于重建场景跟踪。 */
  private foregroundWindowRef: string | null = null
  /** 最近一次规范化的前台进程名；只在本机用于识别桌宠自己的窗口。 */
  private lastForegroundProcess: string | null = null
  /** 同一应用内标题变化的稳定性确认，避免每次按键都成为“内容变化”。 */
  private pendingContent: {
    title: string
    firstAt: number
    previousTitle: string | null
  } | null = null
  private lastContentEventTitle: string | null = null
  private lastContentEventAt = 0

  constructor(opts: ActivityWorldOptions) {
    this.getConfig = opts.getConfig
    this.logger = opts.logger
    this.foreground = opts.foreground ?? null
    this.system = opts.system ?? null
    this.scene = opts.scene ?? null
    this.autoSample = opts.autoSample ?? true
    this.isOnBattery = opts.isOnBattery ?? (() => false)
    this.onDegraded = opts.onDegraded
    this.onEvent = opts.onEvent
    this.isSelfAction = opts.isSelfAction
    this.onModelScene = opts.onModelScene
    this.ownsModelScene = opts.ownsModelScene
    this.onSceneInvalidated = opts.onSceneInvalidated
    this.now = opts.now ?? (() => Date.now())
    this.stats = new ActivityStats(
      opts.statsFile ?? null,
      this.getConfig().worlds.activity.retainStatsDays,
      opts.logger
    )
    const config = this.getConfig()
    this.timeline = new ActivityTimeline({
      minutes: config.worlds.activity.timelineMinutes,
      maxEntries: config.worlds.activity.timelineMaxEntries,
      now: this.now
    })
    if (this.stats.hasActivityToday(this.now())) {
      this.lastDayFirstDay = dateKey(this.now())
    }
    if (this.stats.lateNightSeenToday(this.now())) {
      this.lastLateNightDay = dateKey(this.now())
    }
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host
    this.refresh()
  }

  async stop(): Promise<void> {
    this.stopSampling()
    this.stats.close()
    this.host = null
  }

  /** 配置热更新：启停采样、更新保留天数、采样间隔与 timeline 容量。 */
  refresh(): void {
    const config = this.getConfig()
    this.stats.setRetention(config.worlds.activity.retainStatsDays)
    this.timeline.configure(config.worlds.activity.timelineMinutes, config.worlds.activity.timelineMaxEntries)
    try {
      this.foreground?.updateInterval?.(config.worlds.activity.sampleMs)
    } catch (error) {
      this.logger.warn('前台采样间隔更新失败', { error: String(error) })
    }
    if (config.worlds.activity.enabled && !this.userPaused) {
      if (!this.sampling) this.startSampling()
    } else if (this.sampling) {
      this.stopSampling()
    }
    try {
      this.scene?.refresh?.()
    } catch (error) {
      this.logger.warn('场景感知刷新失败', { error: String(error) })
    }
  }

  /** 托盘「暂停行为感知」：只停采样，不改配置、不清统计。 */
  setPaused(paused: boolean): void {
    if (this.userPaused === paused) return
    this.userPaused = paused
    if (paused) {
      this.stopSampling()
    } else {
      this.refresh()
    }
  }

  isUserPaused(): boolean {
    return this.userPaused
  }

  envPromptVars(): Record<string, string> | null {
    const config = this.getConfig()
    if (!config.worlds.activity.enabled) return null
    return {
      categoryTable: categoryTableMarkdown(),
      retention: config.worlds.activity.retainStatsDays > 0 ? `${config.worlds.activity.retainStatsDays} 天` : '不保留',
      shareAppName: config.worlds.activity.shareAppName ? '是' : '否',
      shareWindowTitle: config.worlds.activity.shareWindowTitle ? '已脱敏共享' : '否'
    }
  }

  envPrompt(): string | null {
    return this.getConfig().worlds.activity.enabled ? ENV_PROMPT : null
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'act_summary',
        description:
          '读取类别级活动摘要：各类别分钟数、切换次数、最长专注、空闲分钟、是否深夜。不含进程名、窗口标题或路径。',
        parameters: z.object({
          range: z.enum(['today', 'session']).optional().describe('默认 today')
        }),
        tags: ['read'],
        approval: 'auto',
        handler: async (args): Promise<ToolOutcome> => {
          if (!this.getConfig().worlds.activity.enabled) {
            return { text: '[ACTIVITY_DISABLED] 行为感知未开启', failed: true }
          }
          const { range } = args as { range?: 'today' | 'session' }
          const data = range === 'session' ? this.stats.sessionSnapshot() : this.stats.today(this.now())
          return { text: this.formatSummary(data, range ?? 'today') }
        }
      },
      {
        name: 'act_current',
        description:
          '读取当前应用显示名、类别与已停留分钟。不含原始进程名、窗口标题或 URL。',
        parameters: z.object({}),
        tags: ['read'],
        approval: 'auto',
        handler: async (): Promise<ToolOutcome> => {
          if (!this.getConfig().worlds.activity.enabled) {
            return { text: '[ACTIVITY_DISABLED] 行为感知未开启', failed: true }
          }
          return { text: this.formatCurrent() }
        }
      },
      {
        name: 'act_timeline',
        description:
          '读取最近的活动时间线：应用显示名、类别、停留分钟与空闲。不含窗口标题、原始进程名、URL 或页面内容。',
        parameters: z.object({
          minutes: z.number().int().min(5).max(360).optional().describe('回看分钟数，默认使用设置值'),
          limit: z.number().int().min(1).max(50).optional()
        }),
        tags: ['read'],
        approval: 'auto',
        handler: async (args): Promise<ToolOutcome> => {
          const config = this.getConfig()
          if (!config.worlds.activity.enabled) {
            return { text: '[ACTIVITY_DISABLED] 行为感知未开启', failed: true }
          }
          const { minutes, limit } = args as { minutes?: number; limit?: number }
          const now = this.now()
          let entries = this.timeline.list(
            {
              minutes: Math.min(minutes ?? config.worlds.activity.timelineMinutes, config.worlds.activity.timelineMinutes),
              limit: limit ?? 20
            },
            now
          )
          if (!config.worlds.activity.shareAppName) {
            entries = entries.map((entry) => ({ ...entry, appLabel: null }))
          }
          return { text: `最近活动时间线（不含标题）：\n${formatTimeline(entries, now)}` }
        }
      },
      {
        name: 'act_scene',
        description:
          '读取当前抽象场景：看视频、浏览网页、写代码、玩游戏、开会、写文档等。只是类别化描述，不含原始 OCR、页面标题、URL 或进程名。',
        parameters: z.object({}),
        tags: ['read'],
        approval: 'auto',
        handler: async (): Promise<ToolOutcome> => {
          const config = this.getConfig()
          if (!config.worlds.activity.enabled) {
            return { text: '[ACTIVITY_DISABLED] 行为感知未开启', failed: true }
          }
          if (!config.worlds.activity.vision.enabled || config.worlds.activity.vision.consentAt === null) {
            return { text: '[VISION_DISABLED] 屏幕感知未开启', failed: true }
          }
          const state = this.sceneState()
          if (state.category === null) {
            return {
              text: '[SCENE_EMPTY] 还没有识别到场景。不要猜测用户在看什么。',
              failed: true
            }
          }
          const ageSeconds =
            state.evidenceAt === null
              ? null
              : Math.max(0, Math.round((this.now() - state.evidenceAt) / 1000))
          const sourceText =
            state.source === 'vision_model'
              ? '视觉模型'
              : state.source === 'local_ocr'
                ? '本地 OCR 兜底'
                : state.source === 'foreground'
                  ? '仅前台应用类别（没有理解画面）'
                  : '未知'
          const lines = [
            `当前场景：${state.activity ?? sceneLabel(state.category)}`,
            `- 抽象类别：${sceneLabel(state.category)}`,
            `- 应用类别：${state.appLabel ?? '未知'}`,
            `- 可信度：${Math.round(state.confidence * 100)}%`,
            `- 证据来源：${sourceText}`,
            `- 最近证据：${ageSeconds === null ? '未知' : `${ageSeconds} 秒前`}`,
            `- 画质：${state.quality ?? '未知'}`
          ]
          if (isKnownPhase(state.phase)) {
            lines.push(`- 阶段：${scenePhaseLabel(state.phase)}`)
            const minutes = this.scenePhaseMinutes()
            if (minutes !== null) lines.push(`- 阶段已持续：约 ${minutes} 分钟`)
          }
          if (state.game !== null) lines.push(`- 游戏：${state.game}`)
          if (state.recentChange !== null) lines.push(`- 最近变化：${state.recentChange}`)
          if (state.stale) {
            lines.push('- 状态：这条场景已过期或采集被暂停；不要把它当作当前画面断言。')
          }
          lines.push(
            '（来自低频屏幕感知的抽象描述；只是某一时刻的证据，不是操作录像，不能证明刚刚发生的点击或保存。没有原始像素、OCR 原文、标题或 URL。）'
          )
          return { text: lines.join('\n') }
        }
      }
    ]
  }

  onRunPhase(phase: RunPhaseState): void {
    void phase
  }

  onTurnEnded(): void {
    /* no-op */
  }

  // ------------------------------------------------------------------ 采样入口

  /** 测试/宿主注入一次前台样本（已脱敏或原始进程名均可）。 */
  ingestProcess(sample: ForegroundSample | string | null, at = this.now()): void {
    if (!this.sampling || this.locked || this.suspended) return
    const config = this.getConfig()
    if (!config.worlds.activity.enabled) return
    if (this.autoSample && at - this.lastProcessSampleAt < Math.max(500, config.worlds.activity.sampleMs - 100)) return
    this.lastProcessSampleAt = at
    this.accrueStats(at)

    const normalized: ForegroundSample | null =
      sample === null ? null : typeof sample === 'string' ? { processName: sample, title: null } : sample
    const previousWindowRef = this.foregroundWindowRef
    if (normalized === null) {
      this.lastForegroundBounds = null
      this.foregroundWindowRef = null
      this.lastForegroundProcess = null
      // 前台不可观察（桌面/锁屏）时，旧摘要立即作废，等重新确认目标。
      if (previousWindowRef !== null) this.scene?.targetChanged?.('window')
      if (
        previousWindowRef !== null ||
        (this.currentScene !== null && this.currentScene.evidenceSource !== 'none')
      ) {
        this.invalidateScene('foreground-unavailable')
      }
      return
    }
    const processName = normalizeProcessName(normalized.processName)
    if (processName === null) return
    this.lastForegroundProcess = processName

    const sensitive = this.isSensitiveProcess(processName)
    // 进程级排除与敏感应用：等同于不存在——不记录原始样本、不建类别、不计时、
    // 不产生事件、不写 timeline。返回普通应用时按首次活动处理（previous=null）。
    if (sensitive || this.isExcluded(processName, config)) {
      this.flushPendingAppSwitch(at, true)
      this.flushEvents(at)
      if (this.currentShareable) this.timeline.closeCurrent(at)
      this.resetStay()
      const wasSensitive = this.sensitiveActive
      this.sensitiveActive = sensitive
      this.foregroundWindowRef = null
      this.sessionStart = 0
      // 敏感应用/排除应用：旧画面摘要不得留到用户切回普通应用之后。
      if (previousWindowRef !== null) this.scene?.targetChanged?.('window')
      if (
        previousWindowRef !== null ||
        (this.currentScene !== null && this.currentScene.evidenceSource !== 'none') ||
        (!wasSensitive && sensitive)
      ) {
        this.invalidateScene(sensitive ? 'sensitive-app' : 'excluded-app')
      }
      return
    }
    this.sensitiveActive = false
    // 进程名不足以区分同一应用的两个窗口；辅助脚本提供 HWND 时把它一并
    // 哈希。句柄只在本机内存使用，不写日志/事件/模型上下文。
    const windowIdentity = normalized.windowId ?? 'unknown'
    const previousBounds = this.lastForegroundBounds
    this.foregroundWindowRef = hashRef('fg-window', `${processName}:${windowIdentity}`)
    // 前台窗口几何只用于本机选择观察显示器；窗口最小化时保留最后一次
    // 可见位置，但不把它当成新证据。
    if (normalized.minimized === true) {
      /* keep last visible bounds */
    } else if (normalized.bounds !== undefined && normalized.bounds !== null) {
      this.lastForegroundBounds = { ...normalized.bounds }
    }
    if (previousWindowRef !== null) {
      if (previousWindowRef !== this.foregroundWindowRef) {
        // 同一进程的新窗口（HWND 不同）也是真正的目标切换。
        this.scene?.targetChanged?.('window')
      } else if (
        previousBounds !== null &&
        this.lastForegroundBounds !== null &&
        !sameBounds(previousBounds, this.lastForegroundBounds)
      ) {
        this.scene?.targetChanged?.('bounds')
      }
    }

    if (this.idle) {
      // 没有键鼠输入不等于用户离开：游戏手柄、观看视频都可能保持前台。
      // 空闲期间仍更新“当前前台类别/几何”，供连续感知选择正确显示器；
      // 但不产生应用切换/内容变化事件，也不计入活跃统计。
      this.touchRawSample(processName, at)
      this.updateForegroundWhileIdle(processName, normalized.title, config)
      return
    }
    if (this.sessionStart === 0) this.sessionStart = at

    if (processName === this.currentProcess) {
      this.pendingSample = null
      this.updateCurrentTitle(normalized.title, at)
    } else if (this.pendingSample !== null && this.pendingSample.processName === processName) {
      this.confirmSample(processName, normalized.title, at)
    } else {
      // 正式事件仍要等下一次采样确认，避免 alt-tab 抖动污染语义上下文；
      // 但本地「注意到了」不该陪着等。第一次看到新前台就先发一条即时提示，
      // 正式事件之后按同一 evidenceRef 去重，不会重复播放。
      this.pendingSample = { processName, title: normalized.title }
      this.noteImmediateAppSwitch(processName, normalized.title, at)
    }

    if (this.currentCategory !== null) {
      this.checkDayMarks(at)
      this.checkPeriodic(at)
    }
    this.maybeFlushAppSwitch(at)
    this.flushEvents(at)
  }

  /** 测试/宿主注入一次空闲秒数。 */
  ingestIdleSeconds(seconds: number, at = this.now()): void {
    if (!this.sampling || this.locked || this.suspended) return
    if (!this.getConfig().worlds.activity.enabled) return
    this.accrueStats(at)
    const threshold = Math.max(1, this.getConfig().worlds.activity.idleMinutes) * 60
    if (!this.idle && seconds >= threshold) {
      this.flushPendingAppSwitch(at, true)
      this.idle = true
      this.idleSince = at - seconds * 1000
      this.timeline.markIdle(at)
      if (seconds >= 300) {
        this.resetStay()
        this.sessionStart = 0
      }
      this.queueEvent({
        kind: 'idle_start',
        at,
        category: this.currentCategory,
        idleMinutes: Math.max(1, Math.round(seconds / 60)),
        timeBucket: timeBucketOf(at)
      })
    } else if (this.idle && seconds < threshold) {
      const awayMinutes = Math.max(1, Math.round((at - this.idleSince) / 60_000))
      this.flushPendingAppSwitch(at, true)
      this.idle = false
      this.resetStay()
      this.timeline.markResume(at)
      if (awayMinutes >= 5 || this.sessionStart === 0) this.sessionStart = at
      this.queueEvent({
        kind: 'idle_return',
        at,
        category: null,
        awayMinutes,
        timeBucket: timeBucketOf(at)
      })
    }
    this.flushEvents(at)
  }

  /**
   * 宿主注入一次场景 descriptor（测试可用 fake SceneProvider）。
   * 只保存抽象字段；标题与关键词留在本对象内，不进入事件 meta。
   */
  ingestScene(descriptor: SceneDescriptor, at = this.now()): void {
    if (!this.sampling || this.locked || this.suspended || this.sensitiveActive) return
    const config = this.getConfig()
    if (!config.worlds.activity.enabled) return
    if (!config.worlds.activity.vision.enabled || config.worlds.activity.vision.consentAt === null) return
    const activity = descriptor.activity.trim()
    if (activity === '') return

    const now = this.now()
    const eventAt = Number.isFinite(descriptor.at) ? descriptor.at : at
    const evidenceAt = Number.isFinite(descriptor.evidenceAt)
      ? (descriptor.evidenceAt as number)
      : eventAt
    // 不提供有效期的旧 provider/测试 descriptor 视为不过期；真实
    // VisionService 总会带上明确有效期，迟到结果会被这里拒绝。
    const expiresAt = Number.isFinite(descriptor.expiresAt)
      ? (descriptor.expiresAt as number)
      : Number.POSITIVE_INFINITY
    // 已经过期的视觉结果绝不补更新/补播报。
    if (expiresAt < now) return

    const revision = Number.isFinite(descriptor.revision)
      ? (descriptor.revision as number)
      : null
    // 旧版本的迟到结果不能覆盖已经进入新版本的状态。
    if (revision !== null && revision < this.lastAcceptedSceneRevision) return

    const change = cleanSceneText(descriptor.change, 60)
    const detail = cleanSceneText(descriptor.detail, 100)
    const modelEvidence = descriptor.evidenceSource === 'vision_model'
    const hasSemantic =
      modelEvidence || isKnownPhase(descriptor.phase) || change !== null || detail !== null
    // 同一场景内，纯帧刷新不能把当前场景退回更早的检查点；只有更新的
    // 语义证据（新的观察 id/更晚的语义证据时间）才允许补充描述。
    if (this.currentScene !== null && evidenceAt < this.lastSceneEvidenceAt) {
      if (!hasSemantic || evidenceAt <= this.lastSemanticEvidenceAt) return
    }

    const previous = this.currentScene
    const previousPhase = previous?.phase ?? null
    const gameRaw = descriptor.category === 'gaming' ? (descriptor.game ?? null) : null
    const game = config.worlds.activity.shareAppName
      ? cleanSceneText(gameRaw, 40)
      : null
    const sameIdentity =
      previous !== null &&
      previous.category === descriptor.category &&
      (previous.game ?? null) === game
    const requestedPhase: ScenePhase =
      descriptor.category === 'gaming' ? (descriptor.phase ?? 'unknown') : 'unknown'
    // 无新证据时，不要把已知阶段“降级”成 unknown；保留最后可验证阶段，
    // 由 expiresAt/stale 明确表达它已经不是新鲜证据。
    const phase: ScenePhase =
      requestedPhase === 'unknown' && sameIdentity && isKnownPhase(previousPhase)
        ? previousPhase
        : requestedPhase

    if (revision !== null && revision > this.lastAcceptedSceneRevision) {
      this.lastAcceptedSceneRevision = revision
    }
    if (evidenceAt > this.lastSceneEvidenceAt) this.lastSceneEvidenceAt = evidenceAt
    if (modelEvidence || change !== null) {
      this.lastSemanticEvidenceAt = Math.max(this.lastSemanticEvidenceAt, evidenceAt)
    }

    const normalized: SceneDescriptor = {
      ...descriptor,
      at: eventAt,
      activity,
      appLabel: descriptor.appLabel.slice(0, 40),
      title: descriptor.title === null ? null : descriptor.title.slice(0, 120),
      keywords: [...descriptor.keywords].slice(0, 12).map((word) => word.slice(0, 40)),
      confidence: Math.max(0, Math.min(1, descriptor.confidence)),
      phase,
      previousPhase,
      game,
      detail,
      change,
      evidenceAt,
      expiresAt,
      revision: revision ?? Math.max(0, this.lastAcceptedSceneRevision)
    }
    // 关键顺序：先更新 currentScene，再决定是否通知。这样设置页和工具
    // 不会先看到一个旧场景，而事件却已经描述新场景。
    this.currentScene = normalized

    // 屏幕陪伴通道只看已接受的 vision_model 摘要；无论场景 key 是否变化、
    // 是否最终生成 scene_* 事件，都要让控制器看到这次新证据，才能覆盖
    // “首帧/静态刷新/安静陪伴”这些不产生 scene_change 的情形。
    let sceneCompanionOwned = false
    if (modelEvidence) {
      const observation = this.sceneObservationFrom(normalized, config)
      try {
        sceneCompanionOwned = this.ownsModelScene?.(observation) === true
      } catch (error) {
        this.logger.warn('屏幕陪伴接管判断失败', { error: String(error).slice(0, 200) })
      }
      try {
        this.onModelScene?.(observation)
      } catch (error) {
        this.logger.warn('屏幕陪伴观察回调失败', { error: String(error).slice(0, 200) })
      }
    }

    const key = [normalized.category, activity, normalized.appLabel, phase, game ?? ''].join('|')
    const previousKey = this.lastSceneKey
    let kind: ActivityKind | null = null
    let eventChange: string | null = change
    if (previousKey === '') {
      kind = 'scene_enter'
    } else if (previousPhase !== phase && (isKnownPhase(phase) || isKnownPhase(previousPhase))) {
      kind = 'scene_phase'
      if (eventChange === null) eventChange = phaseChangeText(previousPhase, phase, game)
    } else if (key !== previousKey) {
      kind = 'scene_change'
    } else if (
      change !== null &&
      change !== this.lastSceneChange &&
      isSubstantiveSceneChange(change)
    ) {
      // 只有新的、可验证的语义变化才成为事件；镜头移动/画面抖动等
      // 单纯像素变化已经在本地被过滤。
      kind = 'scene_change'
    }
    if (change !== null) this.lastSceneChange = change

    if (kind === null) {
      if (previousKey === key && now - this.lastSceneStayAt >= 30 * 60_000) kind = 'scene_stay'
      else return
    }

    const phaseChanged = previousPhase !== phase
    if (kind === 'scene_stay') {
      // 节流按到达时间计，不按帧的旧采集时间；否则迟到的静帧
      // 会在同一轮里反复触发 scene_stay。
      this.lastSceneStayAt = now
    } else {
      this.lastSceneKey = key
      this.lastSceneStayAt = now
      if (phaseChanged || kind === 'scene_enter') this.scenePhaseSince = eventAt
    }
    const sceneEventId = this.recordSceneEvent(kind, normalized, previousPhase, eventChange, detail)
    const keepSamples = Math.max(
      0,
      Math.min(100, config.worlds.activity.vision.keepSamples)
    )
    if (keepSamples === 0) {
      this.sceneSamples = []
    } else {
      this.sceneSamples.push(normalized)
      if (this.sceneSamples.length > keepSamples) {
        this.sceneSamples.splice(0, this.sceneSamples.length - keepSamples)
      }
    }

    this.queueEvent({
      kind,
      at: eventAt,
      category: this.currentCategory,
      activity: normalized.activity,
      appLabel: normalized.appLabel,
      confidence: normalized.confidence,
      eventConfidence: normalized.confidence,
      sceneCategory: normalized.category,
      scenePhase: phase,
      previousScenePhase: previousPhase,
      sceneGame: game,
      sceneChange: eventChange,
      sceneDetail: detail,
      observationId: normalized.observationId,
      evidenceAt,
      sceneRevision: normalized.revision,
      sceneEventId,
      sceneCompanionOwned,
      timeBucket: timeBucketOf(eventAt)
    })
    this.maybeFlushAppSwitch(eventAt)
    this.flushEvents(eventAt)
  }

  ingestLock(at = this.now()): void {
    if (!this.sampling || this.locked) return
    this.accrueStats(at)
    this.flushPendingAppSwitch(at, true)
    this.locked = true
    this.lockStart = at
    this.timeline.markIdle(at)
    this.resetStay()
    this.sessionStart = 0
    this.flushEvents(at)
    // 锁屏立即取消在途观察并作废旧摘要，不等下一次采样 tick。
    this.scene?.targetChanged?.('window')
    this.invalidateScene('locked')
  }

  ingestUnlock(at = this.now()): void {
    if (!this.locked) return
    const awayMinutes = Math.max(1, Math.round((at - this.lockStart) / 60_000))
    this.locked = false
    this.lastStatsAt = at
    this.idle = false
    this.resetStay()
    this.sessionStart = 0
    if (awayMinutes >= 15) {
      this.timeline.markResume(at)
      this.queueEvent({
        kind: 'lock_away',
        at,
        category: null,
        awayMinutes,
        timeBucket: timeBucketOf(at)
      })
    }
    this.flushEvents(at)
  }

  ingestSuspend(at = this.now()): void {
    if (!this.sampling || this.suspended) return
    this.accrueStats(at)
    this.flushPendingAppSwitch(at, true)
    this.suspended = true
    this.suspendStart = at
    this.timeline.markIdle(at)
    this.resetStay()
    this.sessionStart = 0
    this.flushEvents(at)
    // 系统挂起同样立即取消请求；恢复后不补发旧帧。
    this.scene?.targetChanged?.('window')
    this.invalidateScene('suspended')
  }

  ingestResume(at = this.now()): void {
    if (!this.suspended) return
    const sleepMinutes = Math.max(1, Math.round((at - this.suspendStart) / 60_000))
    this.suspended = false
    this.lastStatsAt = at
    this.idle = false
    this.resetStay()
    this.sessionStart = 0
    this.timeline.markResume(at)
    this.queueEvent({
      kind: 'resume',
      at,
      category: null,
      sleepMinutes,
      timeBucket: timeBucketOf(at)
    })
    this.flushEvents(at)
  }

  /** 设置页本地预览：只在内存里，绝不进入日志/模型。 */
  recentRawSamples(): Array<{ processName: string; category: ActivityCategory; durationMinutes: number; at: number }> {
    return this.rawSamples
      .map((sample) => ({
        processName: sample.processName,
        category: sample.category,
        durationMinutes: Math.max(1, Math.round((sample.lastAt - sample.since) / 60_000)),
        at: sample.since
      }))
      .slice(-MAX_RAW_SAMPLES)
  }

  clearRawSamples(): void {
    this.rawSamples = []
  }

  clearTimeline(): void {
    this.timeline.clear()
  }

  /** 设置页「清除活动统计」；只清类别级统计，不触碰当前采样。 */
  clearStats(): void {
    this.stats.clearAll()
    this.logger.info('活动统计已清除')
  }

  sessionStats(): DayStats {
    return this.stats.sessionSnapshot()
  }

  todayStats(): DayStats {
    return this.stats.today(this.now())
  }

  isSampling(): boolean {
    return this.sampling
  }

  isIdle(): boolean {
    return this.idle
  }

  currentCategoryLabel(): string | null {
    return this.currentCategory === null ? null : categoryLabel(this.currentCategory)
  }

  /** 当前类别；空闲时返回 null。供 files/vision 等旁路调度做静音判断。 */
  currentCategoryId(): ActivityCategory | null {
    return this.idle ? null : this.currentCategory
  }

  /**
   * 脱敏快照。只包含类别、应用显示名、停留时间、空闲与抽象场景；
   * 不含窗口标题、原始进程名、scene title/keywords 或 OCR 原文。
   */
  currentSnapshot(): {
    category: ActivityCategory | null
    categoryLabel: string | null
    appLabel: string | null
    stayMinutes: number | null
    appStayMinutes: number | null
    idle: boolean
    idleMinutes: number | null
    scene: {
      activity: string
      appLabel: string
      category: SceneDescriptor['category']
      phase: ScenePhase
      game: string | null
      confidence: number
      minutes: number
      stale: boolean
      detail: string | null
      change: string | null
      evidenceAt: number | null
      expiresAt: number | null
      source: SceneEvidenceSource | null
    } | null
  } {
    const now = this.now()
    const scene = this.currentScene
    return {
      category: this.currentCategory,
      categoryLabel: this.currentCategory === null ? null : CATEGORY_LABELS[this.currentCategory],
      appLabel: this.currentShareable ? this.currentAppLabel : null,
      stayMinutes:
        this.currentCategory === null
          ? null
          : Math.max(1, Math.round((now - this.stayStart) / 60_000)),
      appStayMinutes:
        this.appSince === 0 ? null : Math.max(1, Math.round((now - this.appSince) / 60_000)),
      idle: this.idle,
      idleMinutes: this.idle ? Math.max(1, Math.round((now - this.idleSince) / 60_000)) : null,
      scene:
        scene === null
          ? null
          : {
              activity: scene.activity,
              appLabel: scene.appLabel,
              category: scene.category,
              phase: scene.phase ?? 'unknown',
              game: scene.game ?? null,
              confidence: scene.confidence,
              minutes: Math.max(1, Math.round((now - scene.at) / 60_000)),
              stale: this.sceneState().stale,
              detail: scene.detail ?? null,
              change: scene.change ?? null,
              evidenceAt: scene.evidenceAt ?? null,
              expiresAt: scene.expiresAt ?? null,
              source: scene.evidenceSource ?? null
            }
    }
  }

  /**
   * 只用于 ephemeral tick / Persona.onDelivery 的环境快照。
   * 标题已经脱敏；敏感/静音/排除应用返回 null。
   */
  ambientSnapshot(): {
    category: ActivityCategory | null
    categoryLabel: string | null
    appLabel: string | null
    title: string | null
    titleSuppressed: boolean
    stayMinutes: number | null
    appStayMinutes: number | null
    switchCount10m: number
    idle: boolean
    idleMinutes: number | null
    quiet: boolean
    sensitive: boolean
  } {
    const config = this.getConfig()
    const now = this.now()
    const share = this.currentShareable && !this.sensitiveActive
    const recentSwitches = this.switchTimes.filter((time) => now - time <= 10 * 60_000).length
    return {
      category: share ? this.currentCategory : null,
      categoryLabel: share && this.currentCategory !== null ? CATEGORY_LABELS[this.currentCategory] : null,
      appLabel: share && config.worlds.activity.shareAppName ? this.currentAppLabel : null,
      title: share && config.worlds.activity.shareWindowTitle ? this.currentTitle : null,
      titleSuppressed: share && this.currentTitleSuppressed,
      stayMinutes:
        share && this.currentCategory !== null
          ? Math.max(1, Math.round((now - this.stayStart) / 60_000))
          : null,
      appStayMinutes:
        share && this.appSince !== 0 ? Math.max(1, Math.round((now - this.appSince) / 60_000)) : null,
      switchCount10m: recentSwitches,
      idle: this.idle,
      idleMinutes: this.idle ? Math.max(1, Math.round((now - this.idleSince) / 60_000)) : null,
      quiet: inQuietHours(now, config.worlds.activity.quietHours),
      sensitive: this.sensitiveActive
    }
  }

  /**
   * 锁屏、挂起、用户暂停或敏感应用时停止采集。空闲不在其中：没有键盘
   * 输入也可能正在用手柄游玩，采集由画面新鲜度和前台窗口判断。
   */
  captureBlockedReason(): string | null {
    if (!this.getConfig().worlds.activity.enabled) return 'activity-disabled'
    if (this.userPaused || !this.sampling) return 'user-paused'
    if (this.locked) return 'locked'
    if (this.suspended) return 'suspended'
    if (this.sensitiveActive || this.currentProcessIsSensitive()) return 'sensitive-app'
    return null
  }

  isCaptureBlocked(): boolean {
    return this.captureBlockedReason() !== null
  }

  /** @deprecated 使用 isCaptureBlocked；保留给旧调用方。 */
  isScreenInactive(): boolean {
    return this.isCaptureBlocked()
  }

  /** 观察目标选择用：空闲时仍返回最后确认的前台类别。 */
  currentCategoryForVision(): ActivityCategory | null {
    return this.sensitiveActive ? null : this.currentCategory
  }

  /** 前台窗口的屏幕物理像素矩形；只在本机用于选屏，不进入模型/日志。 */
  foregroundBounds(): { x: number; y: number; width: number; height: number } | null {
    if (this.sensitiveActive || this.locked || this.suspended) return null
    return this.lastForegroundBounds === null ? null : { ...this.lastForegroundBounds }
  }

  /**
   * 前台窗口的不透明标识（进程名 + HWND 的哈希）；供连续感知在窗口
   * 切换/关闭时清空旧帧。只在本机内存使用，不进入事件、日志或模型上下文。
   */
  foregroundWindowKey(): string | null {
    if (this.sensitiveActive || this.locked || this.suspended) return null
    return this.foregroundWindowRef
  }

  /**
   * 最近一次规范化前台进程名。只供本机判断“桌宠窗口是不是当前前台”，
   * 不写日志、事件或模型上下文；锁屏/敏感状态由采集阻断单独处理。
   */
  foregroundProcessName(): string | null {
    return this.lastForegroundProcess
  }

  /** 可共享的游戏显示名；仅在游戏类别且用户允许共享应用名时返回。 */
  currentGameName(): string | null {
    const config = this.getConfig()
    if (this.sensitiveActive || !config.worlds.activity.shareAppName) return null
    if (this.currentCategory !== 'game' || this.currentProcess === null) return null
    return resolveAppLabel(this.currentProcess, config)
  }

  /** 当前前台应用是否属于敏感类别（密码管理器/银行/钱包等）。 */
  currentProcessIsSensitive(): boolean {
    if (this.sensitiveActive) return true
    const name = this.currentProcess
    return name !== null && this.isSensitiveProcess(name)
  }

  /** 最近一次抽象场景；不含原始 OCR。 */
  currentSceneDescriptor(): SceneDescriptor | null {
    return this.currentScene === null ? null : { ...this.currentScene }
  }

  /**
   * 供屏幕陪伴控制器读取的当前观察（仅主进程内存）。过期摘要也返回，
   * 由控制器明确判定 stale；不包含标题、关键词、图片或 OCR 原文。
   */
  currentScreenObservation(): ScreenObservation | null {
    const scene = this.currentScene
    return scene === null ? null : this.sceneObservationFrom(scene, this.getConfig())
  }

  /**
   * 请求 VisionService 在下一次正常采样点刷新一次摘要（不额外截图、
   * 不改变 60/120 秒节奏）。没有视觉通路时返回 false。
   */
  requestSceneSummaryRefresh(): boolean {
    try {
      return this.scene?.requestSummaryRefresh?.() === true
    } catch {
      return false
    }
  }

  private sceneObservationFrom(scene: SceneDescriptor, config: AppConfig): ScreenObservation {
    return {
      observationId:
        scene.observationId ?? `scene-${scene.category}-${Math.round(scene.evidenceAt ?? scene.at)}`,
      category: scene.category,
      activity: scene.activity,
      appLabel: config.worlds.activity.shareAppName ? scene.appLabel : '',
      phase: scene.phase ?? 'unknown',
      game: scene.game ?? null,
      change: scene.change ?? null,
      detail: scene.detail ?? null,
      confidence: scene.confidence,
      evidenceAt: scene.evidenceAt ?? scene.at,
      expiresAt: scene.expiresAt ?? scene.at + 90_000,
      revision: scene.revision ?? 0,
      sourceId: scene.sourceId ?? null,
      targetKey:
        this.foregroundWindowRef ?? scene.sourceId ?? `${scene.category}|${scene.appLabel}`,
      // 静音列表按前台进程类别配置，不是场景语义类别；敏感应用同样静音。
      muted:
        this.sensitiveActive ||
        (this.currentCategory !== null &&
          this.isMutedCategory(this.currentCategory, config))
    }
  }

  /** 供设置页/自主活动读取的短期场景状态；过期状态明确标记 stale。 */
  sceneState(): SceneState {
    const scene = this.currentScene
    const now = this.now()
    const validUntil = scene?.expiresAt ?? null
    const blocked = this.captureBlockedReason() !== null
    return {
      observationId: scene?.observationId ?? null,
      category: scene?.category ?? null,
      activity: scene?.activity ?? null,
      appLabel: scene?.appLabel ?? null,
      game: scene?.game ?? null,
      phase: scene?.phase ?? 'unknown',
      previousPhase: scene?.previousPhase ?? null,
      recentChange: this.lastSceneChange,
      detail: scene?.detail ?? null,
      evidenceAt: scene?.evidenceAt ?? null,
      confidence: scene?.confidence ?? 0,
      source: scene?.evidenceSource ?? null,
      quality: scene?.quality ?? (blocked ? 'blocked' : null),
      sourceId: scene?.sourceId ?? null,
      validUntil,
      stale:
        scene === null ||
        blocked ||
        scene.quality === 'black' ||
        // 主动作废（锁屏/挂起/敏感应用/目标切换）在同一毫秒也要立即算过期，
        // 不能等 now > expiresAt 才生效。
        scene.evidenceSource === 'none' ||
        (validUntil !== null && now > validUntil)
    }
  }

  /** 设置页「我看到了什么」使用的短阶段时长。 */
  scenePhaseMinutes(): number | null {
    if (this.currentScene === null || this.scenePhaseSince === 0) return null
    return Math.max(0, Math.round((this.now() - this.scenePhaseSince) / 60_000))
  }

  /** 最近场景事件（诊断用）：不含标题、关键词、OCR 原文。 */
  recentSceneEvents(limit = 30): SceneEventDiagnostic[] {
    const count = Math.max(1, Math.min(100, Math.round(limit)))
    return this.sceneEventLog
      .slice(-count)
      .map((event) => ({ ...event, chain: event.chain.map((step) => ({ ...step })) }))
  }

  /**
   * 给一条场景事件追加诊断步骤（决策/本地反应/任务/结果）。
   *
   * 只按 eventId 匹配场景事件，非场景事件自然 no-op；所有字段都经过
   * 白名单清洗，调用方不能把标题、回执或 OCR 原文带进诊断链。
   */
  noteSceneTrace(
    eventId: string | null | undefined,
    step: {
      stage: SceneTraceStage
      outcome: string
      reason: string
      ref?: string | null
      at?: number
    }
  ): void {
    if (eventId === null || eventId === undefined || eventId === '') return
    const event = this.sceneEventLog.find((entry) => entry.eventId === eventId)
    if (event === undefined) return
    const outcome = cleanTraceToken(step.outcome)
    const reason = cleanTraceToken(step.reason)
    if (outcome === '' || reason === '') return
    const at = Number.isFinite(step.at) ? (step.at as number) : this.now()
    event.chain.push({
      at,
      stage: step.stage,
      outcome,
      reason,
      ref: step.ref === null || step.ref === undefined ? null : cleanTraceToken(step.ref) || null
    })
    if (event.chain.length > 12) event.chain.splice(0, event.chain.length - 12)
  }

  /** 设置页本地预览：只在进程内存里，不落盘、不进事件库。 */
  recentScenes(): SceneDescriptor[] {
    return this.sceneSamples.map((scene) => ({ ...scene, keywords: [...scene.keywords] }))
  }

  sceneStatus(): SceneStatus | null {
    return this.scene?.status?.() ?? null
  }

  /** 设置页固定观察目标；不含窗口内容。 */
  sceneDisplays(): Array<{ id: string; label: string; width: number; height: number; primary: boolean }> {
    try {
      return this.scene?.displays?.() ?? []
    } catch {
      return []
    }
  }

  /** 仅在用户开启 `showOcrSnippet` 时返回；由 VisionService 判定。 */
  scenePreview(): string | null {
    try {
      return this.scene?.preview?.() ?? null
    } catch {
      return null
    }
  }

  clearScene(): void {
    this.currentScene = null
    this.sceneSamples = []
    this.sceneEventLog = []
    this.lastSceneKey = ''
    this.lastSceneStayAt = 0
    this.lastSceneEvidenceAt = 0
    this.lastSemanticEvidenceAt = 0
    this.lastAcceptedSceneRevision = -1
    this.lastSceneChange = null
    this.scenePhaseSince = 0
    try {
      this.scene?.clear?.()
    } catch {
      /* ignore */
    }
  }

  /**
   * 让当前摘要立即失效：前台窗口/显示器切换、暂停、锁屏、敏感应用、
   * 撤销共享或配置变化时调用。保留最后一条描述用于诊断，但明确过期，
   * 聊天与设置页不得再把它当成当前画面。
   */
  invalidateScene(reason: string): void {
    // 即使还没有 accepted scene，也要通知屏幕陪伴通道取消在途候选/旧观察；
    // 例如首帧尚未到达就锁屏或切到敏感应用。
    try {
      this.onSceneInvalidated?.(reason.slice(0, 40))
    } catch (error) {
      this.logger.warn('场景失效回调失败', { error: String(error).slice(0, 200) })
    }
    const scene = this.currentScene
    if (scene === null) return
    const now = this.now()
    this.currentScene = {
      ...scene,
      expiresAt: now,
      quality: 'unavailable',
      evidenceSource: 'none'
    }
    this.lastSceneEvidenceAt = Math.min(this.lastSceneEvidenceAt, now)
    this.lastSemanticEvidenceAt = Math.min(this.lastSemanticEvidenceAt, now)
    // 增加诊断版本，让任何仍在途的旧观察结果无法回填。
    this.lastAcceptedSceneRevision = Math.max(0, this.lastAcceptedSceneRevision) + 1
    this.currentScene = { ...this.currentScene, revision: this.lastAcceptedSceneRevision }
    const note = reason.trim().slice(0, 40)
    if (note !== '') {
      this.currentScene = { ...this.currentScene, detail: `观察已失效：${note}` }
    }
  }

  /** 设置页单独暂停/恢复屏幕感知；行为感知本身继续运行。 */
  pauseScene(): void {
    try {
      this.scene?.pause?.()
    } catch {
      /* ignore */
    }
  }

  resumeScene(): void {
    try {
      this.scene?.resume?.()
    } catch {
      /* ignore */
    }
  }

  /** 设置页“立即观察一次”；真实实现会遵守授权、敏感状态与并发限制。 */
  async observeSceneNow(): Promise<{ ok: boolean; reason: string | null }> {
    try {
      const result = await this.scene?.observeNow?.()
      return result ?? { ok: false, reason: '当前场景来源不支持立即观察' }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  timelineSize(): number {
    return this.timeline.size()
  }

  // ------------------------------------------------------------------ 采样生命周期

  private startSampling(): void {
    if (this.sampling) return
    this.sampling = true
    this.lastStatsAt = this.now()
    this.sessionStart = 0
    this.logger.info('行为感知开始')

    if (this.foreground !== null) {
      try {
        this.foreground.start(
          (sample) => this.ingestProcess(sample),
          (error) => this.logger.warn('前台采样错误', { error: error.message })
        )
      } catch (error) {
        this.logger.warn('前台采样启动失败', { error: String(error) })
      }
    }

    if (this.system !== null) {
      this.systemUnsubs.push(this.system.onLock(() => this.ingestLock()))
      this.systemUnsubs.push(this.system.onUnlock(() => this.ingestUnlock()))
      this.systemUnsubs.push(this.system.onSuspend(() => this.ingestSuspend()))
      this.systemUnsubs.push(this.system.onResume(() => this.ingestResume()))
    }

    if (this.scene !== null) {
      try {
        this.scene.start(
          (descriptor) => this.ingestScene(descriptor),
          (error) => this.logger.warn('场景感知错误', { error: error.message })
        )
      } catch (error) {
        this.logger.warn('场景感知启动失败', { error: String(error) })
      }
    }

    this.idleTimer = setInterval(() => void this.pollIdle(), 5000)
    this.idleTimer.unref?.()
  }

  private stopSampling(): void {
    if (!this.sampling) return
    this.sampling = false
    this.logger.info('行为感知停止')
    if (this.foreground !== null) {
      try {
        void this.foreground.stop()
      } catch {
        /* ignore */
      }
    }
    for (const unsub of this.systemUnsubs.splice(0)) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
    if (this.idleTimer !== null) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    if (this.scene !== null) {
      try {
        this.scene.stop()
      } catch {
        /* ignore */
      }
    }
    this.currentScene = null
    this.sceneEventLog = []
    this.lastSceneKey = ''
    this.lastSceneStayAt = 0
    this.lastSceneEvidenceAt = 0
    this.lastSemanticEvidenceAt = 0
    this.lastAcceptedSceneRevision = -1
    this.lastSceneChange = null
    this.scenePhaseSince = 0
    this.lastForegroundBounds = null
    this.lastForegroundProcess = null
    this.pendingAppSwitch = null
    this.timeline.clear()
    this.resetStay()
    this.pendingEvents = []
    this.idle = false
    this.locked = false
    this.suspended = false
    this.stats.flush()
  }

  private async pollIdle(): Promise<void> {
    if (!this.sampling || this.system === null || this.locked || this.suspended) return
    const now = this.now()
    if (this.isOnBattery() && now - this.lastIdlePollAt < 10_000) return
    this.lastIdlePollAt = now
    try {
      const seconds = await this.system.getIdleSeconds()
      if (Number.isFinite(seconds) && seconds >= 0) this.ingestIdleSeconds(seconds, now)
    } catch (error) {
      this.logger.warn('空闲采样失败', { error: String(error) })
    }
  }

  // ------------------------------------------------------------------ 状态机

  /**
   * 采样阶段的第一反应：只用于本地注意动作，不进入模型事件队列。
   *
   * 必须在 `dispatch` 的同一套隐私门槛下工作：静音类别、敏感应用、自身
   * 动作和关闭事件共享时都不发出。`event.at` 用真实观察时间，方便指标把
   * 采样延迟与反应层延迟分开。
   */
  private noteImmediateAppSwitch(processName: string, rawTitle: string | null, at: number): void {
    if (this.onEvent === undefined || this.currentProcess === null) return
    if (processName === this.currentProcess) return
    const config = this.getConfig()
    if (!config.worlds.activity.enabled || !config.worlds.activity.shareEventsToModel) return
    if (this.isSelfAction?.() === true) return
    const category = PROCESS_CATEGORIES[processName] ?? 'other'
    if (this.isMutedCategory(category, config)) return
    const appLabel = resolveAppLabel(processName, config)
    const titleInfo = this.sanitizeTitle(rawTitle, appLabel, category, config)
    const event: ActivityEvent = {
      kind: 'app_switch',
      at,
      category,
      ...(config.worlds.activity.shareAppName && appLabel !== null ? { appLabel } : {}),
      previousAppLabel: this.currentShareable ? this.currentAppLabel : null,
      previousCategory: this.currentShareable ? this.currentCategory : null,
      appStayMinutes:
        this.appSince === 0 ? 0 : Math.max(1, Math.round((at - this.appSince) / 60_000)),
      coalescedSwitches: 1,
      titleSanitized: titleInfo.text,
      titleSuppressed: titleInfo.suppressed,
      timeBucket: timeBucketOf(at)
    }
    try {
      this.onEvent(this.buildNotice(event, config, true))
    } catch (error) {
      this.logger.warn('即时活动提示失败', { error: String(error).slice(0, 200) })
    }
  }

  /**
   * 空闲期间只维护“当前前台是什么”这一最小状态，让观察目标仍跟随用户
   * 实际正在看的窗口。不写统计、不排事件、不改变空闲判定。
   */
  private updateForegroundWhileIdle(
    processName: string,
    rawTitle: string | null,
    config: AppConfig
  ): void {
    this.currentProcess = processName
    this.currentCategory = PROCESS_CATEGORIES[processName] ?? 'other'
    const shareable = !this.isMutedCategory(this.currentCategory, config)
    this.currentShareable = shareable
    this.currentAppLabel =
      shareable && config.worlds.activity.shareAppName
        ? resolveAppLabel(processName, config)
        : null
    const titleInfo = this.sanitizeTitle(rawTitle, this.currentAppLabel, this.currentCategory, config)
    this.currentTitle = shareable ? titleInfo.text : null
    this.currentTitleSuppressed = shareable ? titleInfo.suppressed : false
    // 空闲期间前台变化不是正式切换，但场景阶段必须以新的前台为准；
    // 离开游戏后旧游戏阶段不能继续冒充当前画面。
    if (this.currentCategory !== 'game' && this.currentScene !== null) {
      this.currentScene = null
      this.lastSceneKey = ''
      this.lastSceneChange = null
      this.scenePhaseSince = 0
    }
  }

  private confirmSample(processName: string, rawTitle: string | null, at: number): void {
    const config = this.getConfig()
    const category = PROCESS_CATEGORIES[processName] ?? 'other'
    const appLabel = resolveAppLabel(processName, config)
    const shareable = !this.isMutedCategory(category, config)
    const titleInfo = this.sanitizeTitle(rawTitle, appLabel, category, config)

    this.pendingSample = null
    this.touchRawSample(processName, at)
    // 切换应用后，旧窗口的标题变化不再属于当前片段；回到旧窗口时允许重新
    // 形成一次内容变化事件（仍受 60 秒间隔与反应层去重约束）。
    this.pendingContent = null
    this.lastContentEventTitle = null

    const isFirst = this.currentCategory === null
    if (isFirst) {
      this.currentProcess = processName
      this.currentCategory = category
      this.stayStart = at
      this.appSince = at
      this.enterEmitted = false
      this.milestones.clear()
      this.currentShareable = shareable
      this.currentAppLabel = shareable && config.worlds.activity.shareAppName ? appLabel : null
      this.currentTitle = shareable ? titleInfo.text : null
      this.currentTitleSuppressed = shareable ? titleInfo.suppressed : false
      if (shareable) this.timeline.pushApp(at, this.currentAppLabel, category)
      this.queueAppSwitch(at, category, null, null, 0, titleInfo)
      return
    }

    const previousCategory = this.currentCategory
    const previousShareable = this.currentShareable
    const previousAppLabel = previousShareable ? this.currentAppLabel : null
    const previousCategoryShared = previousShareable ? previousCategory : null
    const previousStayMinutes =
      this.appSince === 0 ? 0 : Math.max(1, Math.round((at - this.appSince) / 60_000))
    const previousCategoryStayMinutes = Math.max(1, Math.round((at - this.stayStart) / 60_000))

    if (category !== previousCategory) {
      if (previousShareable && previousCategoryStayMinutes >= 30) {
        this.queueEvent({
          kind: 'category_exit',
          at,
          category: previousCategory,
          durationMinutes: previousCategoryStayMinutes,
          timeBucket: timeBucketOf(at)
        })
      }
      this.stats.addSwitch(at)
      this.switchTimes.push(at)
      this.enterEmitted = false
      this.milestones.clear()
      this.stayStart = at
    }

    this.currentProcess = processName
    this.currentCategory = category
    this.appSince = at
    this.currentShareable = shareable
    this.currentAppLabel = shareable && config.worlds.activity.shareAppName ? appLabel : null
    this.currentTitle = shareable ? titleInfo.text : null
    this.currentTitleSuppressed = shareable ? titleInfo.suppressed : false

    if (shareable) {
      this.timeline.pushApp(at, this.currentAppLabel, category)
      this.queueAppSwitch(
        at,
        category,
        previousAppLabel,
        previousCategoryShared,
        previousStayMinutes,
        titleInfo
      )
    } else {
      // 进入静音类别：此前尚未派发的普通应用切换先按实际发生顺序送出，
      // 之后不再产生任何能标识该应用/标题的事件。
      this.flushPendingAppSwitch(at, true)
      this.timeline.closeCurrent(at)
    }
  }

  private updateCurrentTitle(rawTitle: string | null, at: number): void {
    const config = this.getConfig()
    if (!this.currentShareable || !config.worlds.activity.shareWindowTitle) {
      this.currentTitle = null
      this.currentTitleSuppressed = false
      this.pendingContent = null
      return
    }
    const info = sanitizeWindowTitle(rawTitle, {
      appLabel: this.currentAppLabel,
      maxChars: config.worlds.activity.titleMaxChars,
      categoryLabel: this.currentCategory === null ? null : CATEGORY_LABELS[this.currentCategory]
    })
    const next = info.text
    const previous = this.currentTitle
    this.currentTitle = next
    this.currentTitleSuppressed = info.suppressed

    // 标题为空、被隐私过滤或整条抑制时不产生内容变化事件。
    if (next === null || info.suppressed) {
      this.pendingContent = null
      return
    }
    if (this.pendingContent !== null) {
      if (this.pendingContent.title === next) {
        const stableMs = Math.max(1500, config.worlds.activity.sampleMs)
        const stable = at - this.pendingContent.firstAt >= stableMs
        if (stable) {
          // 和上次已派发的标题相同：不重复说同一件事。
          if (next === this.lastContentEventTitle) {
            this.pendingContent = null
            return
          }
          // 频率上限未到：保留稳定性，下一次采样再判断，不丢事件。
          if (at - this.lastContentEventAt < 60_000) return
          const previousTitle = this.pendingContent.previousTitle
          this.lastContentEventTitle = next
          this.lastContentEventAt = at
          this.pendingContent = null
          this.queueEvent({
            kind: 'content_change',
            at,
            category: this.currentCategory,
            appLabel: this.currentAppLabel ?? undefined,
            titleSanitized: next,
            previousTitleSanitized: previousTitle,
            eventConfidence: 0.7,
            timeBucket: timeBucketOf(at)
          })
          return
        }
        return
      }
      // 标题又变了：以最新标题重新开始稳定性计时。
      this.pendingContent = { title: next, firstAt: at, previousTitle: previous }
      return
    }
    if (next === previous) return
    this.pendingContent = { title: next, firstAt: at, previousTitle: previous }
  }

  private sanitizeTitle(
    rawTitle: string | null,
    appLabel: string | null,
    category: ActivityCategory,
    config: AppConfig
  ): { text: string | null; suppressed: boolean } {
    if (!config.worlds.activity.shareWindowTitle) return { text: null, suppressed: false }
    return sanitizeWindowTitle(rawTitle, {
      appLabel,
      maxChars: config.worlds.activity.titleMaxChars,
      categoryLabel: CATEGORY_LABELS[category]
    })
  }

  private queueAppSwitch(
    at: number,
    category: ActivityCategory,
    previousAppLabel: string | null,
    previousCategory: ActivityCategory | null,
    previousStayMinutes: number,
    titleInfo: { text: string | null; suppressed: boolean }
  ): void {
    const config = this.getConfig()
    const existing = this.pendingAppSwitch
    const canMerge =
      existing !== null &&
      at - existing.lastAt <= config.worlds.activity.appSwitchCoalesceMs &&
      at - existing.firstAt <= config.worlds.activity.appSwitchMaxHoldMs
    if (existing !== null && !canMerge) this.flushPendingAppSwitch(at, true)

    if (canMerge) {
      existing.lastAt = at
      existing.category = category
      existing.previousCategory = previousCategory
      existing.appLabel = this.currentAppLabel
      existing.previousAppLabel = previousAppLabel
      existing.titleSanitized = titleInfo.text
      existing.titleSuppressed = titleInfo.suppressed
      existing.appStayMinutes = previousStayMinutes
      existing.coalescedSwitches += 1
      return
    }

    this.pendingAppSwitch = {
      firstAt: at,
      lastAt: at,
      category,
      previousCategory,
      appLabel: this.currentAppLabel,
      previousAppLabel,
      titleSanitized: titleInfo.text,
      titleSuppressed: titleInfo.suppressed,
      appStayMinutes: previousStayMinutes,
      coalescedSwitches: 1,
      timeBucket: timeBucketOf(at)
    }
  }

  private maybeFlushAppSwitch(at: number): void {
    const pending = this.pendingAppSwitch
    if (pending === null) return
    const config = this.getConfig()
    if (
      at - pending.lastAt >= config.worlds.activity.appSwitchCoalesceMs ||
      at - pending.firstAt >= config.worlds.activity.appSwitchMaxHoldMs
    ) {
      this.flushPendingAppSwitch(at, true)
    }
  }

  private flushPendingAppSwitch(at: number, force: boolean): void {
    const pending = this.pendingAppSwitch
    if (pending === null) return
    if (!force) return
    this.pendingAppSwitch = null
    this.queueEvent({
      kind: 'app_switch',
      at: pending.firstAt,
      category: pending.category,
      previousCategory: pending.previousCategory,
      appLabel: pending.appLabel ?? undefined,
      previousAppLabel: pending.previousAppLabel,
      titleSanitized: pending.titleSanitized,
      titleSuppressed: pending.titleSuppressed,
      appStayMinutes: pending.appStayMinutes,
      coalescedSwitches: pending.coalescedSwitches,
      durationMinutes: pending.appStayMinutes > 0 ? pending.appStayMinutes : undefined,
      timeBucket: pending.timeBucket
    })
    void at
  }

  private checkDayMarks(at: number): void {
    const day = dateKey(at)
    if (day !== this.lastDayFirstDay) {
      this.lastDayFirstDay = day
      if (this.currentShareable) {
        this.queueEvent({
          kind: 'day_first',
          at,
          category: this.currentCategory,
          timeBucket: timeBucketOf(at)
        })
      }
    }
    if (day !== this.lastLateNightDay) {
      const date = new Date(at)
      const minutes = date.getHours() * 60 + date.getMinutes()
      if (minutes >= 22 * 60 + 30 && minutes < 23 * 60 + 30) {
        this.lastLateNightDay = day
        this.stats.noteLateNight(at)
        if (this.currentShareable) {
          this.queueEvent({
            kind: 'late_night',
            at,
            category: this.currentCategory,
            timeBucket: timeBucketOf(at)
          })
        }
      }
    }
  }

  private checkPeriodic(at: number): void {
    if (this.currentCategory === null) return
    const stayMinutes = (at - this.stayStart) / 60_000
    this.stats.noteFocus(stayMinutes, at)

    if (!this.currentShareable) {
      this.switchTimes = this.switchTimes.filter((time) => at - time <= 10 * 60_000)
      return
    }

    if (!this.enterEmitted && stayMinutes >= 10) {
      this.enterEmitted = true
      this.queueEvent({
        kind: 'category_enter',
        at,
        category: this.currentCategory,
        durationMinutes: Math.round(stayMinutes),
        timeBucket: timeBucketOf(at)
      })
    }

    for (const milestone of [50, 90, 120]) {
      if (stayMinutes >= milestone && !this.milestones.has(milestone)) {
        this.milestones.add(milestone)
        this.queueEvent({
          kind: 'focus_long',
          at,
          category: this.currentCategory,
          durationMinutes: Math.round(stayMinutes),
          milestoneMinutes: milestone,
          timeBucket: timeBucketOf(at)
        })
      }
    }

    if (this.sessionStart > 0 && at - this.sessionStart >= 2 * 60 * 60_000 && at - this.lastLongSessionAt >= 60 * 60_000) {
      this.lastLongSessionAt = at
      this.queueEvent({
        kind: 'long_session',
        at,
        category: this.currentCategory,
        durationMinutes: Math.round((at - this.sessionStart) / 60_000),
        timeBucket: timeBucketOf(at)
      })
    }

    this.switchTimes = this.switchTimes.filter((time) => at - time <= 10 * 60_000)
    if (this.switchTimes.length >= 20 && at - this.lastStormAt >= 10 * 60_000) {
      this.lastStormAt = at
      this.queueEvent({
        kind: 'switch_storm',
        at,
        category: this.currentCategory,
        switchCount: this.switchTimes.length,
        timeBucket: timeBucketOf(at)
      })
    }
  }

  private accrueStats(at: number): void {
    if (this.lastStatsAt === 0) {
      this.lastStatsAt = at
      return
    }
    const delta = Math.min(60_000, Math.max(0, at - this.lastStatsAt))
    if (delta <= 0) return
    if (this.idle || this.locked || this.suspended) this.stats.addIdle(delta, at)
    else if (this.currentCategory !== null) this.stats.addActive(this.currentCategory, delta, at)
    this.lastStatsAt = at
  }

  private resetStay(): void {
    this.currentProcess = null
    this.pendingSample = null
    this.currentCategory = null
    this.currentAppLabel = null
    this.currentTitle = null
    this.currentTitleSuppressed = false
    this.currentShareable = false
    this.stayStart = 0
    this.appSince = 0
    this.enterEmitted = false
    this.milestones.clear()
    this.switchTimes = []
    this.lastForegroundBounds = null
  }

  private isExcluded(processName: string, config: AppConfig): boolean {
    const exclude = config.worlds.activity.exclude
    if (exclude.length === 0) return false
    for (const entry of exclude) {
      if (normalizeProcessName(entry) === processName) return true
    }
    return false
  }

  private isSensitiveProcess(processName: string): boolean {
    if (SENSITIVE_PROCESSES.has(processName)) return true
    return SENSITIVE_PROCESS_PATTERNS.some((pattern) => processName.includes(pattern))
  }

  private isMutedCategory(category: ActivityCategory, config: AppConfig): boolean {
    return config.worlds.activity.muteCategories.includes(category)
  }

  private touchRawSample(processName: string, at: number): void {
    const category = PROCESS_CATEGORIES[processName] ?? 'other'
    const last = this.rawSamples[this.rawSamples.length - 1]
    if (last !== undefined && last.processName === processName && last.category === category) {
      last.lastAt = at
      return
    }
    this.rawSamples.push({ processName, category, since: at, lastAt: at })
    if (this.rawSamples.length > MAX_RAW_SAMPLES) this.rawSamples.splice(0, this.rawSamples.length - MAX_RAW_SAMPLES)
  }

  // ------------------------------------------------------------------ 事件输出

  /** 内存环形诊断；不含标题/关键词/OCR 原文，也不写入日志或事件库。 */
  private recordSceneEvent(
    kind: ActivityKind,
    scene: SceneDescriptor,
    previousPhase: ScenePhase | null,
    change: string | null,
    detail: string | null
  ): string {
    const eventId = randomUUID()
    this.sceneEventLog.push({
      eventId,
      kind,
      at: scene.at,
      evidenceAt: scene.evidenceAt ?? scene.at,
      observationId: scene.observationId ?? null,
      category: scene.category,
      activity: scene.activity,
      phase: scene.phase ?? 'unknown',
      previousPhase,
      game: scene.game ?? null,
      change,
      detail,
      source: scene.evidenceSource ?? null,
      quality: scene.quality ?? null,
      revision: scene.revision ?? null,
      chain: []
    })
    if (this.sceneEventLog.length > 100) {
      this.sceneEventLog.splice(0, this.sceneEventLog.length - 100)
    }
    return eventId
  }

  private queueEvent(event: ActivityEvent): void {
    this.pendingEvents.push(event)
  }

  private flushEvents(at: number): void {
    if (this.pendingEvents.length === 0) return
    const events = this.pendingEvents
    this.pendingEvents = []
    events.sort((a, b) => (PRIORITY[b.kind] ?? 0) - (PRIORITY[a.kind] ?? 0))
    for (const event of events) this.dispatch(event, at)
  }

  /**
   * 生成与正式派发完全一致的脱敏引用。即时提示和合并后的事件共用同一套
   * targetRef/evidenceRef，反应层才能按证据去重，而不是把同一次切换播两遍。
   */
  private buildNotice(event: ActivityEvent, config: AppConfig, immediate: boolean): ActivityEventNotice {
    const selfAction = this.isSelfAction?.() === true
    const appLabel = config.worlds.activity.shareAppName ? event.appLabel ?? null : null
    const title = config.worlds.activity.shareWindowTitle ? event.titleSanitized ?? null : null
    const targetRef = hashRef(
      'target',
      [appLabel ?? event.category ?? 'unknown', title ?? '', event.sceneGame ?? ''].join('|')
    )
    const evidenceRef = hashRef(
      'evidence',
      [
        event.kind,
        appLabel ?? '',
        title ?? '',
        event.previousTitleSanitized ?? '',
        event.scenePhase ?? '',
        event.previousScenePhase ?? '',
        event.sceneGame ?? '',
        event.sceneChange ?? '',
        event.observationId ?? ''
      ].join('|')
    )
    // 有效期从「事件实际发生」算起，而不是从派发时刻算起。合并窗口、采样
    // 暂停或降级恢复都可能让派发晚于观察；若按派发时间续期，一条几分钟前
    // 的旧切换会以新鲜事件的身份进入反应层，模型就会补说早已过期的变化。
    const expiresAt = event.at + Math.max(10_000, config.companion.reaction.eventTtlMs)
    const confidence =
      event.eventConfidence ??
      event.confidence ??
      (event.kind === 'app_switch' ? 0.9 : event.kind === 'content_change' ? 0.7 : 0.6)
    const baseText = this.activityText(event, config)
    return {
      // 场景事件的诊断 id 与派发 id 必须一致，才能从设置页一路追到
      // reaction/task/outcome；其它事件仍在派发时生成独立 id。
      eventId: event.sceneEventId ?? randomUUID(),
      type: `activity.${event.kind}`,
      at: event.at,
      changeType: event.kind,
      targetRef,
      evidenceRef,
      confidence,
      expiresAt,
      ...(immediate ? { immediate: true } : {}),
      actionAttribution: selfAction ? 'pet' : 'user',
      category: event.category,
      appLabel,
      hasTitle: title !== null,
      ...(event.scenePhase === undefined
        ? {}
        : {
            phase: event.scenePhase,
            previousPhase: event.previousScenePhase ?? null,
            game: event.sceneGame ?? null,
            detail: event.sceneChange ?? event.sceneDetail ?? null
          }),
      text: selfAction ? `[自身动作] ${baseText}` : baseText
    }
  }

  private dispatch(event: ActivityEvent, at: number): void {
    void at
    const config = this.getConfig()
    if (this.host === null) return
    if (!config.worlds.activity.enabled || !config.worlds.activity.shareEventsToModel) return
    if (event.category !== null && this.isMutedCategory(event.category, config)) return
    if (this.sensitiveActive && event.kind !== 'resume' && event.kind !== 'idle_return' && event.kind !== 'lock_away') {
      return
    }
    const notice = this.buildNotice(event, config, false)
    const selfAction = notice.actionAttribution === 'pet'
    // 屏幕陪伴通道接管后，旧 reaction 只保留 ambient 供上下文参考；
    // 否则同一次 vision_model 观察可能被两条路径各说一遍。
    const reaction =
      WAKE_KINDS.has(event.kind) && !selfAction && event.sceneCompanionOwned !== true
    const attention: 'wake' | 'ambient' = reaction ? 'wake' : 'ambient'
    const appLabel = notice.appLabel ?? null
    const title = config.worlds.activity.shareWindowTitle ? event.titleSanitized ?? null : null
    const { targetRef, evidenceRef, expiresAt, confidence } = notice
    // meta 只放安全字段：绝不放标题。标题（已脱敏）只出现在 ephemeral 的 text 里。
    const meta: Record<string, unknown> = {
      eventId: notice.eventId,
      observedAt: event.at,
      source: 'activity',
      changeType: event.kind,
      targetRef,
      evidenceRef,
      confidence,
      expiresAt,
      actionAttribution: selfAction ? 'pet' : 'user',
      category: event.category,
      categoryLabel: event.category === null ? null : CATEGORY_LABELS[event.category],
      durationMinutes: event.durationMinutes,
      switchCount: event.switchCount,
      milestoneMinutes: event.milestoneMinutes,
      timeBucket: event.timeBucket
    }
    if (reaction) meta.wakeKind = 'reaction'
    if (event.kind === 'app_switch') {
      meta.appLabel = appLabel
      meta.previousAppLabel = config.worlds.activity.shareAppName ? event.previousAppLabel ?? null : null
      meta.previousCategory = event.previousCategory ?? null
      meta.appStayMinutes = event.appStayMinutes
      meta.coalescedSwitches = event.coalescedSwitches
    }
    if (event.kind === 'content_change') {
      meta.appLabel = appLabel
      meta.hasTitle = title !== null
    }
    if (
      event.kind === 'scene_enter' ||
      event.kind === 'scene_phase' ||
      event.kind === 'scene_change' ||
      event.kind === 'scene_stay'
    ) {
      meta.activity = event.activity
      meta.appLabel = event.appLabel
      meta.confidence = confidence
      meta.sceneCategory = event.sceneCategory
      meta.scenePhase = event.scenePhase ?? null
      meta.previousScenePhase = event.previousScenePhase ?? null
      meta.sceneGame = event.sceneGame ?? null
      meta.sceneChange = event.sceneChange ?? null
      meta.sceneDetail = event.sceneDetail ?? null
      meta.observationId = event.observationId ?? null
      meta.evidenceAt = event.evidenceAt ?? event.at
      meta.sceneRevision = event.sceneRevision ?? null
    }

    this.host.pushEvent({
      type: `activity.${event.kind}`,
      source: 'activity',
      origin: 'external',
      text: notice.text,
      tags: ['activity', event.kind],
      meta,
      attention,
      persist: false,
      ephemeral: true
    })
    if (this.onEvent !== undefined) {
      try {
        // 本地反应层要能看到「观察 → 动作」的真实年龄，包括采样与合并
        // 窗口；notice.at 使用事件发生时间，不能用派发时刻。
        this.onEvent(notice)
      } catch (error) {
        this.logger.warn('活动事件本地回调失败', { error: String(error).slice(0, 200) })
      }
    }
  }

  // ------------------------------------------------------------------ 摘要

  private formatSummary(data: DayStats, range: 'today' | 'session'): string {
    const title = range === 'session' ? '本次运行的活动摘要' : `今日活动摘要（${data.date}）`
    const entries = (Object.entries(data.categories) as Array<[ActivityCategory, number]>)
      .filter(([, minutes]) => minutes > 0.5)
      .sort((a, b) => b[1] - a[1])
    const lines = [title]
    if (entries.length === 0) lines.push('- 暂无类别记录')
    else for (const [category, minutes] of entries) lines.push(`- ${CATEGORY_LABELS[category]}：${Math.round(minutes)} 分钟`)
    lines.push(
      `- 切换：${data.switches} 次`,
      `- 最长专注：${Math.round(data.longestFocusMinutes)} 分钟`,
      `- 空闲：${Math.round(data.idleMinutes)} 分钟`,
      `- 深夜活跃：${data.lateNight ? '是' : '否'}`
    )
    if (this.currentCategory !== null && !this.idle) {
      lines.push(`- 当前：${CATEGORY_LABELS[this.currentCategory]}（${Math.max(1, Math.round((this.now() - this.stayStart) / 60_000))} 分钟）`)
    }
    return lines.join('\n')
  }

  private formatCurrent(): string {
    if (this.sensitiveActive) {
      return '[ACTIVITY_PRIVATE] 当前前台应用被隐私过滤，不能提供应用名、类别或标题。'
    }
    if (this.idle) {
      return `当前空闲（已离开约 ${Math.max(1, Math.round((this.now() - this.idleSince) / 60_000))} 分钟）。`
    }
    if (this.currentCategory === null) return '还没有确认当前类别。'
    if (!this.currentShareable) {
      return `当前类别：${CATEGORY_LABELS[this.currentCategory]}（该类别已静音，不共享应用名与标题）。`
    }
    const minutes = Math.max(1, Math.round((this.now() - this.stayStart) / 60_000))
    const config = this.getConfig()
    const app =
      config.worlds.activity.shareAppName && this.currentAppLabel !== null
        ? `当前应用：${this.currentAppLabel}（${CATEGORY_LABELS[this.currentCategory]}）`
        : `当前类别：${CATEGORY_LABELS[this.currentCategory]}`
    return `${app}；已停留 ${minutes} 分钟；时段：${bucketLabel(timeBucketOf(this.now()))}。`
  }

  private activityText(event: ActivityEvent, config: AppConfig): string {
    const label = event.category === null ? '未确认类别' : CATEGORY_LABELS[event.category]
    const parts: string[] = []
    const shareApp = config.worlds.activity.shareAppName
    switch (event.kind) {
      case 'app_switch': {
        const app = shareApp && event.appLabel != null ? `「${event.appLabel}」` : ''
        const prev = shareApp && event.previousAppLabel != null ? `「${event.previousAppLabel}」` : ''
        const prevCategory =
          event.previousCategory == null ? null : CATEGORY_LABELS[event.previousCategory]
        parts.push(`应用切换到${app || '新应用'}（${label}）`)
        if (event.titleSanitized != null && config.worlds.activity.shareWindowTitle) {
          parts.push(`窗口：${event.titleSanitized}`)
        }
        if (prev !== '' || event.previousAppLabel === null) {
          const previous = prev !== '' ? prev : prevCategory !== null ? `上一类别「${prevCategory}」` : ''
          if (previous !== '') {
            parts.push(
              event.appStayMinutes !== undefined && event.appStayMinutes > 0
                ? `此前在${previous}停留 ${event.appStayMinutes} 分钟`
                : `此前在${previous}`
            )
          }
        }
        if ((event.coalescedSwitches ?? 1) > 1) {
          parts.push(`合并了 ${event.coalescedSwitches} 次切换`)
        }
        break
      }
      case 'content_change': {
        const app = shareApp && event.appLabel != null ? `「${event.appLabel}」` : ''
        parts.push(`同一应用${app}的窗口标题稳定变化（${label}）`)
        if (event.titleSanitized != null && config.worlds.activity.shareWindowTitle) {
          parts.push(`现在：${event.titleSanitized}`)
        }
        if (
          event.previousTitleSanitized != null &&
          config.worlds.activity.shareWindowTitle
        ) {
          parts.push(`此前：${event.previousTitleSanitized}`)
        }
        parts.push('只有标题级证据，不能据此断言正文内容')
        break
      }
      case 'day_first':
        parts.push(`今天第一次活动（${label}）`)
        break
      case 'category_enter':
        parts.push(`进入类别：${label}；已停留 ${event.durationMinutes ?? 10} 分钟`)
        break
      case 'category_exit':
        parts.push(`离开类别：${label}；共停留 ${event.durationMinutes ?? 30} 分钟`)
        break
      case 'focus_long':
        parts.push(`同类专注 ${event.milestoneMinutes ?? 50} 分钟（${label}）`)
        break
      case 'switch_storm':
        parts.push(`10 分钟内切换 ${event.switchCount ?? 20} 次`)
        break
      case 'idle_start':
        parts.push(`空闲 ${event.idleMinutes ?? 5} 分钟`)
        break
      case 'idle_return':
        parts.push(`空闲 ${event.awayMinutes ?? 5} 分钟后恢复`)
        break
      case 'late_night':
        parts.push(`深夜仍活跃（${label}）`)
        break
      case 'long_session':
        parts.push(`连续活跃约 ${event.durationMinutes ?? 120} 分钟`)
        break
      case 'lock_away':
        parts.push(`锁屏离开 ${event.awayMinutes ?? 15} 分钟后回来`)
        break
      case 'resume':
        parts.push(`睡眠 ${event.sleepMinutes ?? 1} 分钟后恢复`)
        break
      case 'scene_enter':
      case 'scene_change':
        parts.push(`场景：${event.activity ?? '在用电脑'}`)
        if (event.sceneGame != null) parts.push(`游戏：${event.sceneGame}`)
        if (event.scenePhase !== undefined && isKnownPhase(event.scenePhase)) {
          parts.push(`阶段：${scenePhaseLabel(event.scenePhase)}`)
        }
        if (event.sceneChange != null) parts.push(event.sceneChange)
        if (event.appLabel !== undefined) parts.push(`应用类别：${event.appLabel}`)
        if ((event.confidence ?? 1) < 0.5) parts.push('可信度较低')
        break
      case 'scene_phase': {
        const phase = event.scenePhase ?? 'unknown'
        const label = scenePhaseLabel(phase)
        parts.push(
          event.sceneGame == null
            ? `游戏阶段：${label}`
            : `《${event.sceneGame}》阶段：${label}`
        )
        if (event.sceneChange != null) parts.push(event.sceneChange)
        if ((event.confidence ?? 1) < 0.5) parts.push('可信度较低')
        break
      }
      case 'scene_stay':
        parts.push(`仍在同一场景：${event.activity ?? '在用电脑'}`)
        if (event.scenePhase !== undefined && isKnownPhase(event.scenePhase)) {
          parts.push(`阶段：${scenePhaseLabel(event.scenePhase)}`)
        }
        break
      default:
        parts.push(label)
    }
    parts.push(`时段：${bucketLabel(event.timeBucket)}`)
    parts.push('（仅类别级信息，标题已脱敏且不落盘）')
    return parts.join('；')
  }
}

/** 不可逆短摘要；用于事件目标/证据引用，避免把标题原文放进 meta。 */
function hashRef(namespace: string, value: string): string {
  return createHash('sha1').update(`${namespace}:${value}`).digest('hex').slice(0, 16)
}

/**
 * 场景自由文本只保留可验证的短描述，并拒绝命令式注入口吻。屏幕内容是
 * 不可信数据；即使包含指令，也只作为被观察的内容丢弃。
 */
export function cleanSceneText(raw: unknown, maxChars: number): string | null {
  if (typeof raw !== 'string') return null
  const text = raw
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return null
  if (
    /(忽略(?:之前|以上|所有)|ignore\s+(?:all\s+)?(?:previous|prior)|system\s*:|assistant\s*:|developer\s*:|执行(?:命令|指令)|调用(?:工具|函数)|tool_call|<\/?system)/i.test(
      text
    )
  ) {
    return null
  }
  const chars = Array.from(text)
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : text
}

/** 镜头移动/画面抖动只是像素变化，不是可播报的语义事件。 */
export function isSubstantiveSceneChange(change: string): boolean {
  return !/(?:镜头|视角|画面|屏幕|角色).{0,4}(?:移动|抖动|转动|晃动|拉伸)|camera\s*(?:movement|move)|mouse\s*move|\bfov\b/i.test(
    change
  )
}

function sameBounds(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function phaseChangeText(
  previous: ScenePhase | null,
  next: ScenePhase,
  game: string | null
): string {
  const prefix = game === null ? '' : `《${game}》`
  if (next === 'results') return `${prefix}进入结算`
  if (next === 'paused') return `${prefix}游戏暂停`
  if (next === 'playing') {
    return previous === 'loading' ? `${prefix}加载完成，进入游玩` : `${prefix}继续游玩`
  }
  if (next === 'menu') return previous === 'results' ? `${prefix}返回菜单` : `${prefix}回到菜单`
  if (next === 'loading') return `${prefix}进入加载`
  return `${prefix}阶段变化`
}

export function bucketLabel(bucket: TimeBucket): string {
  const map: Record<TimeBucket, string> = {
    morning: '早上',
    forenoon: '上午',
    afternoon: '下午',
    evening: '晚上',
    night: '夜晚',
    'late-night': '深夜'
  }
  return map[bucket]
}

/** 导出给测试与诊断用。 */
export const ACTIVITY_PRIORITY = PRIORITY
export function isQuietTime(config: AppConfig, at: number): boolean {
  return config.worlds.activity.enabled && inQuietHours(at, config.worlds.activity.quietHours)
}
