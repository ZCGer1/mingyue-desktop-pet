import type { ReactiveEventNotice } from '../../shared/reaction'
import type { SceneCategory, ScenePhase } from './scene'

/**
 * 活动感知的本地类型（PLAN.md §4.4）。
 *
 * 类别与抽象场景是唯一离开 Activity World 的语义；进程名、截图与 OCR
 * 原文只存在于本 World 内存里，不会出现在这些事件对象、日志或会话中。
 */

export type ActivityCategory =
  | 'editor'
  | 'terminal'
  | 'browser'
  | 'media'
  | 'office'
  | 'design'
  | 'game'
  | 'meeting'
  | 'other'
  | 'uwp'

export type TimeBucket = 'morning' | 'forenoon' | 'afternoon' | 'evening' | 'night' | 'late-night'

export type ActivityKind =
  | 'day_first'
  | 'category_enter'
  | 'category_exit'
  | 'focus_long'
  | 'switch_storm'
  | 'idle_start'
  | 'idle_return'
  | 'late_night'
  | 'long_session'
  | 'lock_away'
  | 'resume'
  /** 前台应用切换；同类别（浏览器 A → 浏览器 B）也会产生。 */
  | 'app_switch'
  /** 同一应用内已确认的窗口标题/文档内容变化（脱敏、稳定后才发出）。 */
  | 'content_change'
  /** 本机截图 + OCR 得到的抽象场景（不含原始像素/OCR 文本）。 */
  | 'scene_enter'
  | 'scene_change'
  /** 同一游戏/应用内可验证的阶段变化（菜单/加载/游玩/暂停/结算）。 */
  | 'scene_phase'
  | 'scene_stay'
  /** @deprecated v3 起 Reflex 删除，仅保留类型给迁移期测试使用。 */
  | 'category_change'

export interface ActivityEvent {
  kind: ActivityKind
  at: number
  category: ActivityCategory | null
  durationMinutes?: number
  milestoneMinutes?: number
  switchCount?: number
  awayMinutes?: number
  sleepMinutes?: number
  idleMinutes?: number
  timeBucket: TimeBucket
  /** 抽象场景描述（仅 scene_* 事件）；绝不含 OCR 原文、原始标题或进程名。 */
  activity?: string
  /** 应用显示名（非原始进程名）。 */
  appLabel?: string
  /** app_switch 的上一个应用显示名；敏感应用不共享时为 null。 */
  previousAppLabel?: string | null
  previousCategory?: ActivityCategory | null
  /** 已脱敏的窗口标题；原始标题绝不进入这里。 */
  titleSanitized?: string | null
  /** content_change 之前的脱敏标题。 */
  previousTitleSanitized?: string | null
  /** 标题因敏感词整条丢弃。 */
  titleSuppressed?: boolean
  /** 事件稳定后的置信度。 */
  eventConfidence?: number
  /** 上一个应用停留的分钟数。 */
  appStayMinutes?: number
  /** 合并窗口内被折叠的应用切换次数（含本次）。 */
  coalescedSwitches?: number
  confidence?: number
  sceneCategory?: SceneCategory
  scenePhase?: ScenePhase
  previousScenePhase?: ScenePhase | null
  /** 仅在用户允许共享 app 名时出现；不是进程名。 */
  sceneGame?: string | null
  /** 通用语义变化短句，不含 OCR 原文。 */
  sceneChange?: string | null
  sceneDetail?: string | null
  /** 观察证据链：observationId → sceneEventId → 决策/任务。 */
  observationId?: string
  evidenceAt?: number
  sceneRevision?: number
  /** 场景诊断与派发通知共用的稳定事件 id；非场景事件没有。 */
  sceneEventId?: string
  /**
   * 仅主进程内部使用：该场景已由屏幕陪伴通道接管，旧 reaction 不再唤醒。
   * 不进入事件 meta、日志或模型上下文。
   */
  sceneCompanionOwned?: boolean
}

/**
 * 给本地反应层的最小事件通知。不含原始进程名、原始标题或完整 URL；
 * `targetRef` / `evidenceRef` 都是不可逆摘要，用于去重与证据追踪。
 */
export type ActivityEventNotice = ReactiveEventNotice & {
  changeType: ActivityKind
  category: ActivityCategory | null
}

export const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  editor: '代码编辑器',
  terminal: '终端',
  browser: '浏览器',
  media: '影音',
  office: '文档办公',
  design: '设计',
  game: '游戏',
  meeting: '会议',
  other: '其他',
  uwp: '应用'
}

/** 进程名 → 类别。只用于本地采样层，不随事件外发。 */
export const PROCESS_CATEGORIES: Record<string, ActivityCategory> = {
  code: 'editor',
  'code - insiders': 'editor',
  cursor: 'editor',
  windsurf: 'editor',
  idea64: 'editor',
  webstorm64: 'editor',
  pycharm64: 'editor',
  devenv: 'editor',
  sublime_text: 'editor',
  notepad: 'editor',
  notepadpp: 'editor',
  vim: 'editor',
  nvim: 'editor',
  emacs: 'editor',

  windowsterminal: 'terminal',
  'windows-terminal': 'terminal',
  cmd: 'terminal',
  conhost: 'terminal',
  powershell: 'terminal',
  pwsh: 'terminal',
  wt: 'terminal',
  alacritty: 'terminal',
  wezterm: 'terminal',
  mintty: 'terminal',

  chrome: 'browser',
  msedge: 'browser',
  firefox: 'browser',
  brave: 'browser',
  opera: 'browser',
  vivaldi: 'browser',
  arc: 'browser',
  thunderbird: 'browser',

  spotify: 'media',
  vlc: 'media',
  mpv: 'media',
  potplayermini64: 'media',
  potplayer: 'media',
  musicbee: 'media',
  foobar2000: 'media',
  bilibili: 'media',
  '哔哩哔哩': 'media',

  winword: 'office',
  excel: 'office',
  powerpnt: 'office',
  onenote: 'office',
  outlook: 'office',
  wps: 'office',
  et: 'office',
  wpp: 'office',
  notion: 'office',
  obsidian: 'office',
  typora: 'office',

  photoshop: 'design',
  illustrator: 'design',
  figma: 'design',
  inkscape: 'design',
  blender: 'design',
  krita: 'design',
  aftereffects: 'design',
  premiere: 'design',
  'adobe premiere pro': 'design',

  steam: 'game',
  epicgameslauncher: 'game',
  'battle.net': 'game',
  riotclientservices: 'game',
  leagueclient: 'game',
  'league of legends': 'game',
  genshinimpact: 'game',
  yuanshen: 'game',
  'star rail': 'game',
  minecraft: 'game',
  javaw: 'game',

  zoom: 'meeting',
  teams: 'meeting',
  'ms-teams': 'meeting',
  dingtalk: 'meeting',
  wemeetapp: 'meeting',
  tencentmeeting: 'meeting',
  webexmta: 'meeting',
  discord: 'meeting',
  slack: 'meeting'
}

/** 这些类别默认在反射层静音（可在设置里改）。 */
export const DEFAULT_MUTE_CATEGORIES: ActivityCategory[] = ['meeting', 'game']

export function categoryLabel(category: ActivityCategory | null): string {
  if (category === null) return '未知'
  return CATEGORY_LABELS[category]
}

export function timeBucketOf(at: number): TimeBucket {
  const hour = new Date(at).getHours()
  if (hour >= 5 && hour < 9) return 'morning'
  if (hour >= 9 && hour < 12) return 'forenoon'
  if (hour >= 12 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 22) return 'evening'
  if (hour >= 22 || hour < 1) return 'night'
  return 'late-night'
}

/** 给 ENV_PROMPT 使用的类别表。 */
export function categoryTableMarkdown(): string {
  return (Object.entries(CATEGORY_LABELS) as Array<[ActivityCategory, string]>)
    .map(([id, label]) => `- \`${id}\`：${label}`)
    .join('\n')
}
