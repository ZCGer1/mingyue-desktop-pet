import { PET_CATALOG } from '../petPresentation'
import type { Corner, PhysicsParams } from '../dshPet/types'


export type ReactionTier = 'quiet' | 'medium' | 'active'

export type RoleplayLevel = 'low' | 'normal' | 'high'

export type VisionLanguage = 'auto' | 'zh-Hans' | 'en-US'

export type ApprovalMode = 'model' | 'strict' | 'auto'

export type PetClickAction = 'quick-input' | 'full-chat' | 'none'

export type CuaPermission = 'ask-once' | 'ask-each-action'

/**
 * 自主模式：assigned 只听安排；assist 主动帮忙（可预授权任务）；
 * explore 允许她在已配置的授权目录里自选小目标、形成发现并主动开口。
 * explore 不会新增任何权限：写操作只限笔记目录，红区与桌面输入规则不变。
 */
export type AutonomyMode = 'assigned' | 'assist' | 'explore'


export interface AutonomyTaskConfig {
  /** 单次任务最长运行时间。 */
  maxMinutes: number
  /** 单次任务最多工具调用次数。 */
  maxToolCalls: number
  /** 完成/失败/取消的任务保留天数。 */
  retentionDays: number
  /** 重启后仅自动恢复没有未知副作用的任务。 */
  autoResume: boolean
}


/** 配置结构版本；只增不改，旧配置由 migrateConfig 补齐。 */
export const CONFIG_SCHEMA_VERSION = 28


/**
 * 新桌宠表现的默认尺寸（视频画布 CSS 宽度）。
 *
 * v17 用上游默认角色的 462px 画布宽度替换旧 `figure.scale`：旧 1.0 倍
 * 角色的可见身体高度与新尺寸下的身体高度接近，因此 `size = 462 × scale`
 * 作为迁移映射，而不是把 462 直接塞给旧 scale 字段。
 */
export const DSH_PET_DEFAULT_SIZE = PET_CATALOG.baseSize


/**
 * 自由探索的磁盘范围模式。
 *
 * - `all`：所有已挂载磁盘上当前账户可读的普通文件，包括系统盘普通目录。
 * - `non-system`：只自动纳入非系统卷；系统盘上的显式工作区/目录仍可读。
 * - `explicit`：不自动纳入任何卷根，只读取用户逐条选择的目录。
 *
 * 它只扩大读取；写入始终由作品目录与显式编辑根决定。
 */
export type VolumeAccessMode = 'all' | 'non-system' | 'explicit'


export interface PersonaConfig {
  name: string
  language: string
  tone: string
  roleplay: RoleplayLevel
  styleNotes: string[]
  /**
   * 用户自定义人格提示词（最多 4000 字）。追加在内置身份/风格之后，
   * 影响完整聊天、快捷对话与主动行为；不能覆盖代码层的安全边界与审批规则。
   */
  customPrompt: string
}


/**
 * 自主行为调度。它只决定「模型何时有机会醒来」，不决定模型说什么；
 * 沉默始终是合法结果。
 */
export interface AutonomyConfig {
  enabled: boolean
  /** v7：自主模式。explore 需要显式选择，且只在已有授权范围内行动。 */
  mode: AutonomyMode
  /** v6：持久任务的预算与保留策略。 */
  task: AutonomyTaskConfig
  /** v6：用户接管桌面后，任务/自主一侧的冷却时间。 */
  takeoverCooldownMs: number
  tickMinMs: number
  tickMaxMs: number
  backoffFactor: number
  /** 两次自主唤醒之间的最小间隔。 */
  wakeGapMs: number
  /** 用户发言后的一段时间内不主动插话。 */
  postUserCooldownMs: number
  respectQuietHours: boolean
  /** 锁屏、空闲或睡眠时是否暂停自主 tick；只影响自主唤醒，不影响用户消息。 */
  idlePauseTicks: boolean
  ambientContext: boolean
  alarmMinDelayMs: number
  maxActiveAlarms: number
  approvalMode: ApprovalMode
  /** 额外允许自动读写的目录；默认只含 workspace。 */
  trustedRoots: string[]
  sessionGrantMinutes: number
  /** 用户显式加入的命令前缀；空数组表示终端一律需要人工确认。 */
  terminalAllowlist: string[]
  maxAutoOpsPerHour: number
  autoWriteBackupCount: number
}


export interface QuickInputConfig {
  enabled: boolean
  width: number
  maxReplyChars: number
  closeOnEscape: boolean
  /** v5 起快捷聊天默认接工具；关闭后退回纯文本对话。 */
  allowTools: boolean
  /** 在默认白名单之外按名字禁用的工具。 */
  deniedTools: string[]
}


export interface ChatUiConfig {
  window: { width: number; height: number }
  quickInput: QuickInputConfig
  petClickAction: PetClickAction
  allowModelOpen: boolean
}


export interface BrowserPageConfig {
  enabled: boolean
  /** 明确同意的时间戳；为空时 enabled 不生效。 */
  consentAt: number | null
  shareTitle: boolean
  shareExcerpt: boolean
  includeHeadings: boolean
  excerptMaxChars: number
  coalesceMs: number
  maxPerMinute: number
  maxPerHour: number
  allowlistOnly: boolean
  allowlist: string[]
  denylist: string[]
  sensitiveDomains: string[]
}


/**
 * 主动浏览器控制的世界级开关与用户同意。
 *
 * 它只表示「允许通过浏览器扩展执行主动操作」，真正能做什么仍由
 * `exploration` 的集中授权和 CapabilityStore 逐次复验。旧配置迁移绝不
 * 从被动页面感知的同意推导这里。
 *
 * B 站浏览器适配器已退役：独立 B 站阅读使用 `worlds.bilibili`，普通网页
 * 浏览沿用本配置，不再有站点子配置。
 */
export interface BrowserDiscoveriesConfig {
  retentionDays: number
  maxRecords: number
}


/**
 * B 站独立 API 阅读配置。
 *
 * 它与浏览器扩展路线彻底分开：`enabled` 只表达用户意图，真正生效还需要
 * `consentAt`（API 读取与本地音频下载的明确同意）、自由探索授权和登录。
 * 旧浏览器路线的同意不会被搬到这里，因此迁移后必须重新确认一次。
 */
export interface BilibiliVisionConfig {
  enabled: boolean
  /** 默认抽几帧（1–6）。 */
  defaultFrames: number
  /** 单次最多几帧（1–6）。 */
  maxFrames: number
}


export type BiliAsrModel = 'tiny' | 'base' | 'small' | 'medium'


export interface BilibiliAsrConfig {
  enabled: boolean
  model: BiliAsrModel
  /** 单条媒体时长上限（分钟）。 */
  maxMediaMinutes: number
  /** 单次音频下载体积上限（MB）。 */
  maxDownloadMb: number
  /** 单次转写运行时间上限（分钟）。 */
  maxRunMinutes: number
  /** 转写缓存/模型目录体积上限（MB）。 */
  maxCacheMb: number
}


export interface BilibiliReportConfig {
  enabled: boolean
  retentionDays: number
}


export interface BilibiliConfig {
  enabled: boolean
  /** API 读取、字幕下载与本地音频转写的明确同意时间；为空时功能不生效。 */
  consentAt: number | null
  /** 单批候选上限。 */
  maxCandidatesPerBatch: number
  /** 单次会话最多精读的视频数。 */
  maxDetailsPerSession: number
  /** 单次阅读会话时长上限（毫秒）。 */
  sessionMaxMs: number
  /** 单次阅读会话工具调用上限。 */
  sessionMaxToolCalls: number
  /** 固定关注词；作为筛选软偏好，不绕过排除词。 */
  keywords: string[]
  /** 排除词；命中标题/标签/简介时不进入精读。 */
  excludeKeywords: string[]
  vision: BilibiliVisionConfig
  asr: BilibiliAsrConfig
  report: BilibiliReportConfig
}


export interface BrowserControlConfig {
  enabled: boolean
  /** 用户明确同意扩展接受主动指令的时间戳；为空时 enabled 不生效。 */
  consentAt: number | null
  /** 搜索地址模板；`{query}` 会替换为 URL 编码后的搜索词。 */
  searchUrl: string
  /** 她自己的标签页上限；超出后必须先关闭旧标签。 */
  maxTabs: number
  /** 页面加载/导航等待上限。 */
  waitTimeoutMs: number
  /** 是否允许把普通资料下载到她的作品目录。 */
  allowDownloads: boolean
  /** 浏览会话的时长上限（普通网页与独立 B 站共用同一预算语义）。 */
  sessionMaxMs: number
  /** 浏览会话的工具调用上限（普通网页与独立 B 站共用同一预算语义）。 */
  sessionMaxToolCalls: number
  /** 统一发现列表的保留策略（普通网页与 B 站共用）。 */
  discoveries: BrowserDiscoveriesConfig
}


/**
 * 「自由探索」集中授权。它是跨 World 的用户意图，因此放在顶层而不是
 * worlds 下。开启后各子范围仍可单独关闭；默认关闭，且默认不开启整屏
 * 观察与用户原始文件编辑。
 *
 * session 授权到期后所有子范围立即失效；always 授权持久保存，但用户随时
 * 可以一键撤销。撤销只改变本配置，不会把旧同意自动换算成任何新权限。
 */
export interface ExplorationConfig {
  enabled: boolean
  scope: 'session' | 'always'
  /** 用户最近一次开启自由探索的时间戳；为空时即使 enabled 也不生效。 */
  grantedAt: number | null
  /** session 授权的到期时间；always 时忽略。 */
  sessionExpiresAt: number | null
  /** 公开网页浏览与搜索。 */
  web: boolean
  /** 她自己的浏览器标签集合：新建、导航、读取、普通交互与关闭。 */
  browserTabs: boolean
  /** 普通桌面应用的发现、启动、窗口激活。 */
  apps: boolean
  /** 授权范围内的窗口观察。 */
  windows: boolean
  /**
   * 整屏/多显示器观察。与窗口授权分开，默认关闭；还需要 CUA 截图同意
   * 与模型图片输入。旧窗口授权不会自动升级成整屏授权。
   */
  fullScreen: boolean
  /** 个人资料目录与所选目录的宽范围只读探索。 */
  fileRead: boolean
  /**
   * 磁盘活动范围。卷枚举只提供事实，这个模式决定是否授权：
   * `all` 纳入所有已挂载可读卷（含系统盘的普通目录），`non-system`
   * 只自动纳入非系统卷，`explicit` 只读取下面列出的显式目录。
   * 新挂载的卷会在刷新窗口内被发现；只扩大读取，不扩大编辑范围。
   */
  volumeScope: VolumeAccessMode
  /** 她自己的作品/下载空间：自动创建、整理、更新。 */
  artifacts: boolean
  /** 用户明确授权目录内的连续编辑；默认关闭，原始文件默认只读。 */
  edits: boolean
  /** 是否把个人资料目录包含进只读范围（敏感目录仍由 guard 拒绝）。 */
  includeProfile: boolean
  /** 授权后新安装的普通应用是否继承类别授权；设置页必须显式展示。 */
  includeNewApps: boolean
  /** 用户排除的站点；支持精确域名与 `*.example.com`。 */
  excludedDomains: string[]
  /** 用户排除的应用（规范化进程名或普通名称）。 */
  excludedApps: string[]
  /** 额外只读目录/磁盘根。 */
  readRoots: string[]
  /** 作品目录；为空时依次回退到笔记目录、工作区根目录。 */
  artifactRoot: string
}


export interface ProviderConfig {
  id: 'deepseek'
  model: string
  utilityModel: string
  contextWindow: number
  maxOutputTokens: number
  thinking: boolean
  /** 是否允许把截图作为图片 part 发给模型；关闭后 CUA 不可用。 */
  visionInput: boolean
  baseUrl?: string
  /** 等待响应头的上限（毫秒）；超时只做有界重试，不会无限连接。 */
  requestTimeoutMs: number
  /** 流式响应两次数据之间的最长空闲（毫秒）；超时按传输故障处理。 */
  streamIdleTimeoutMs: number
}


export interface ContextConfig {
  maxTokens: number
  softRatio: number
  keepRatio: number
}


export interface BatchingConfig {
  quietGapMs: number
  minBatchAgeMs: number
  maxBatchAgeMs: number
  maxBatchSize: number
}


/**
 * 可选的关键帧语义理解。默认不把任何画面发给模型；只有用户在此显式
 * 开启 `shareFrames` 后，最多 2–4 张压缩关键帧才会进入独立视觉模型请求。
 * 它与 CUA 截图授权相互独立，也不会从旧 OCR 同意推导出来。
 */
export interface VisionSemanticConfig {
  /** 单次识图请求的超时；超时后丢弃结果，不补发旧帧。 */
  timeoutMs: number
}


/**
 * 整屏共享的同意范围版本。
 *
 * 旧版的 `semantic.shareFrames` 只描述“2–4 张前台窗口关键帧”，不等于本次
 * “前台所在显示器整屏”的范围。范围变化时必须提升版本，旧同意记录不再
 * 生效，用户需要重新确认。
 */
export const SCREEN_SHARE_CONSENT_VERSION = 1


/**
 * 连续屏幕感知。旧版的 interval/minGap/maxPerMinute/maxPerHour 已在 v14
 * 删除：采集由固定低频节奏、并发、背压与故障退避管理，不存在任何按小时
 * 计数的隐式额度。
 */
export interface VisionConfig {
  enabled: boolean
  /** 明确同意截图观察的时间戳；为空时 enabled 不生效。 */
  consentAt: number | null
  /**
   * 明确同意把前台所在显示器的整屏画面发送给当前聊天模型的时间戳。
   * 为空时只做本机截图，绝不向模型发送图片。
   */
  screenShareConsentAt: number | null
  /** `screenShareConsentAt` 对应的范围版本；与当前版本不一致时同意无效。 */
  screenShareConsentVersion: number
  /** 基础观察周期（采样开始时间的最小间隔），默认 60 秒。 */
  desktopSampleMs: number
  /** 连续静态后使用的观察周期，默认 120 秒；不得小于基础周期。 */
  staticSampleMs: number
  /** 本地 OCR 降级时可运行的最小间隔。 */
  ocrMinGapMs: number
  language: VisionLanguage
  keepSamples: number
  showOcrSnippet: boolean
  /**
   * 模型不可用时是否用本地 OCR 兜底。识图正常时不跑 OCR；默认关闭。
   */
  ocrFallback: boolean
  /**
   * 独立识图请求的配置。模型与地址始终跟随 `provider`；model/baseUrl
   * 仅作为旧版迁移提示保留，运行时忽略。
   */
  semantic: VisionSemanticConfig
}


export interface ActivityConfig {
  enabled: boolean
  sampleMs: number
  idleMinutes: number
  quietHours: [string, string]
  muteCategories: string[]
  exclude: string[]
  retainStatsDays: number
  vision: VisionConfig
  /** 是否把活动事件共享给模型。 */
  shareEventsToModel: boolean
  /** 是否共享应用显示名（非原始进程名）。 */
  shareAppName: boolean
  /** 是否共享脱敏窗口标题。 */
  shareWindowTitle: boolean
  /** 脱敏后标题的最大字符数。 */
  titleMaxChars: number
  /** 同类/异类应用切换的合并窗口。 */
  appSwitchCoalesceMs: number
  /** 连续切换时事件最长持有时间。 */
  appSwitchMaxHoldMs: number
  timelineMinutes: number
  timelineMaxEntries: number
}


export interface WorkspaceConfig {
  root: string
  /**
   * 她自己的笔记/草稿目录。对外只以 `notes/` 别名出现；
   * 与 API Key、权限数据库、运行状态隔离，默认未设置。
   */
  notesRoot: string
}


export interface WebConfig {
  enabled: boolean
  provider: 'deepseek'
  askBefore: boolean
}


export interface TerminalConfig {
  enabled: boolean
  shell: 'cmd.exe' | 'powershell.exe'
}


/** 初始位置（相对某块显示器工作区四角）。 */
export interface PetHomeConfig {
  corner: Corner
  marginX: number
  marginY: number
}


/**
 * 外观。packId 是运行时身份，不是用户可切换的皮肤：
 * 当前只打包了上游默认角色 main，未知值在归一化时回到默认。
 */
export interface PetAppearanceConfig {
  packId: 'main'
  /** 视频画布 CSS 宽度；高度固定 size × 9/16。 */
  size: number
  /** 尊重系统减少动态效果：关闭自主装饰动作与自主移动。 */
  reducedMotion: boolean
  home: PetHomeConfig
}


/**
 * 待机偶发动作策略（旧模型自主装饰通道）。语义动作与本地随机通道不受这里的
 * 长冷却限制；这些字段只服务「模型在自主轮里自行选择娱乐动作」的那条路径。
 */
export interface PetIdleActionsConfig {
  enabled: boolean
  /** 连续无实质活动多久后才允许自主娱乐动作。 */
  minIdleMs: number
  /** 两次成功开始的自主娱乐动作之间的最小间隔。 */
  minIntervalMs: number
  /** 同一段自主娱乐动作的重复间隔。 */
  sameActionIntervalMs: number
  /**
   * 张望类动作（东张西望 / 原地踱步张望）的最小间隔。
   * 与同一动作冷却同时生效，取两者中更严格的一个；所有入口共享。
   */
  lookAroundIntervalMs: number
}


/**
 * 本地随机小动作：不依赖模型、不生成气泡、不改变工作状态。
 * 每次真实 started 后独立采样 min–max 秒，到期只保留一个机会。
 */
export interface PetRandomIdleConfig {
  enabled: boolean
  minIntervalMs: number
  maxIntervalMs: number
}


/** 按当前发言/行为选择语义动作；同一轮至多一次，普通动作有最小间隔。 */
export interface PetSemanticConfig {
  enabled: boolean
  minGapMs: number
}


/** 混合策略：安静待机 + 本地低频随机 + 模型语义动作。 */
export interface PetAnimationConfig {
  policy: 'hybrid'
  idleActions: PetIdleActionsConfig
  randomIdle: PetRandomIdleConfig
  semantic: PetSemanticConfig
}


/** 本地随机漫游：独立计时，但复用同一身体控制器与移动桥。 */
export interface PetRandomRoamConfig {
  enabled: boolean
  minIntervalMs: number
  maxIntervalMs: number
}


/**
 * 移动的业务含义。`enabled` 仍是总开关；`randomRoam` 只控制本地随机移动，
 * 模型/用户明确移动仍沿用原有参数与约束。
 */
export interface PetMovementConfig {
  enabled: boolean
  pauseWithPanel: boolean
  /**
   * 身体连续静止多久后才允许自主移动。与待机小动作的门槛相互独立：
   * 关闭待机小动作不会关闭走动，思考/展示也不会重置这个静止时钟。
   */
  minIdleMs: number
  /** 无用户要求时两次自主移动之间的最小间隔；用户明确要求不受此限。 */
  autonomousMinIntervalMs: number
  randomRoam: PetRandomRoamConfig
}


export interface PetConfig {
  enabled: boolean
  reactions: ReactionTier
  appearance: PetAppearanceConfig
  animation: PetAnimationConfig
  /** 抛掷/反弹手感；默认与锁定上游一致，限制在安全范围。 */
  physics: PhysicsParams
  /** true = 宠物只在当前所在显示器工作区内活动。 */
  confineToScreen: boolean
  movement: PetMovementConfig
}


/**
 * 统一文件范围的显式目录与排除项。后台随机抽样已退役；文件工具是否可用
 * 由统一文件范围（工作区/笔记/信任目录/这些显式目录/自由探索授权）决定。
 */
export interface FilesConfig {
  roots: string[]
  exclude: string[]
}


export interface SystemAppEntry {
  id: string
  label: string
  path: string
  args: string[]
}


export interface SystemConfig {
  enabled: boolean
  apps: SystemAppEntry[]
  allowUrls: boolean
  allowPaths: boolean
}


/**
 * 电脑操作（CUA）。默认关闭，且必须同时具备键鼠授权与截图发送授权才生效。
 * 旧配置迁移永远不会自动授予这两项。
 */
export interface CuaConfig {
  enabled: boolean
  /** 用户同意模拟鼠标/键盘的时间戳。 */
  consentAt: number | null
  /** 用户同意截图发送给 DeepSeek 的时间戳。 */
  screenConsentAt: number | null
  /** ask-once：首次确认后 grantMinutes 内免问；ask-each-action：每次输入都问。 */
  permission: CuaPermission
  grantMinutes: number
  afterActionScreenshot: boolean
  actionOverlay: boolean
  maxActionsPerTurn: number
  screenshotMaxWidth: number
  jpegQuality: number
  settleMs: number
  /** 用户追加的进程名黑名单；固定敏感名单不可移除。 */
  blockedApps: string[]
}


/**
 * 用户显式加入的桌面观察应用。默认列表为空；迁移与 normalize 绝不自动添加。
 * `observe` 只允许窗口清单/UIA 文本/按窗口截图；`input` 才允许聚焦与 CUA 输入。
 */
export interface DesktopScopeApp {
  /** 规范化进程名（不带 .exe、全小写），例如 chrome / code / notepad。 */
  process: string
  /** 用户可读标签。 */
  label: string
  observe: boolean
  input: boolean
}


export interface DesktopScopeConfig {
  apps: DesktopScopeApp[]
  /** 允许读取 UI Automation 文本。 */
  structuredText: boolean
  /** 允许按窗口截图；还需 CUA 双重同意与 visionInput。 */
  windowCapture: boolean
  maxWindows: number
  maxTextChars: number
  maxObservePerHour: number
  /**
   * 已授权应用的窗口清单轮询间隔；0 关闭。只读取窗口标题（脱敏后进入内存
   * 事件），不读取正文、不写盘，也不占用 maxObservePerHour 的模型读取额度。
   */
  inventoryPollMs: number
}


export interface WorldsConfig {
  chat: { enabled: boolean }
  pet: PetConfig
  activity: ActivityConfig
  files: FilesConfig
  system: SystemConfig
  workspace: WorkspaceConfig
  web: WebConfig
  terminal: TerminalConfig
  browserPage: BrowserPageConfig
  browserControl: BrowserControlConfig
  /** 独立扫码登录 + Python API 的 B 站阅读；不依赖浏览器扩展。 */
  bilibili: BilibiliConfig
  cua: CuaConfig
  desktop: DesktopScopeConfig
}


/** 主动聊天节奏：quiet / natural / lively。 */
export type CompanionCadence = 'quiet' | 'natural' | 'lively'


export interface CompanionInterestsConfig {
  /** 活跃兴趣上限（2–4）。 */
  maxActive: number
  /** 兴趣最长保留天数。 */
  ttlDays: number
  /** 单个兴趣最多被专注的轮数。 */
  maxFocusCount: number
}


export interface CompanionExperiencesConfig {
  retentionDays: number
  maxRecords: number
}


export interface CompanionUnansweredConfig {
  /** 未回应时按此倍数退避。 */
  backoffFactor: number
  /** 退避上限。 */
  maxBackoffMs: number
}


/**
 * 真实变化触发的事件反馈通道。它和自主探索、定时闲聊分别保留用量统计；
 * 唤醒次数不设上限，本地即时动作也从不经过模型预算。
 */
export interface CompanionReactionConfig {
  /** 活动/窗口/页面变化触发事件对话。 */
  enabled: boolean
  /** 事件有效期；过期后不得排队补说。 */
  eventTtlMs: number
  /** 同一目标/变化类型的去重窗口。 */
  dedupeMs: number
}


/**
 * 屏幕陪伴反馈偏好。
 *
 * 只消费已接受的 `vision_model` 抽象摘要，不提高截图频率，也不扩大
 * 电脑操作授权；实际生效仍受 autonomy、reaction、活动事件共享、
 * 屏幕/整屏共享同意、类别静音、安静时间与用户安静等既有门控约束。
 */
export interface CompanionScreenFeedbackConfig {
  enabled: boolean
  /** 两次实际显示之间的最短间隔；不是每小时额度。 */
  minIntervalMs: number
  /** 同场景长时间无主动交流后，允许一次轻陪伴的基准等待。 */
  quietPresenceMs: number
  /** 两次主动问题之间的最短间隔；未答问题期间不再提问。 */
  questionMinIntervalMs: number
  /** 用户刚发消息后，主动屏幕反馈至少等待这么久。 */
  postUserCooldownMs: number
}


export interface CompanionConfig {
  cadence: CompanionCadence
  interests: CompanionInterestsConfig
  experiences: CompanionExperiencesConfig
  unanswered: CompanionUnansweredConfig
  reaction: CompanionReactionConfig
  screenFeedback: CompanionScreenFeedbackConfig
}


export interface MemoryConfig {
  enabled: boolean
  habits: boolean
  dream: boolean
}


export interface ApprovalConfig {
  ttlMs: number
  sessionAllowExactCommand: boolean
}


export interface AppConfig {
  schemaVersion: number
  persona: PersonaConfig
  provider: ProviderConfig
  context: ContextConfig
  batching: BatchingConfig
  autonomy: AutonomyConfig
  /** 跨 World 的「自由探索」集中授权；默认关闭。 */
  exploration: ExplorationConfig
  companion: CompanionConfig
  chatUi: ChatUiConfig
  worlds: WorldsConfig
  memory: MemoryConfig
  approval: ApprovalConfig
}


export function isVolumeAccessMode(value: unknown): value is VolumeAccessMode {
  return value === 'all' || value === 'non-system' || value === 'explicit'
}
