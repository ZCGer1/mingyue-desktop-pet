import { createHash } from 'node:crypto'
import type { CapabilityId, ToolSource } from './capabilityTypes'
import type { ToolRegistry } from './tools'
import type {
  ToolExposureLoadResult,
  ToolRequestExposure,
  ToolSpec
} from './types'

/**
 * 模型可见工具组（PLAN-MODEL-TOOL-SIMPLIFICATION-2026-10-30 §7）。
 *
 * 三层必须分开：
 * 1. 注册表保留全部真实 handler 与旧契约；
 * 2. 每个模型请求有独立暴露快照（本文件）；
 * 3. 执行器仍按快照 + allowlist + enabled + 能力/目标/审批复验。
 *
 * 组只是可见性分类，不是权限分类。tools_load 不授予权限、不执行动作。
 */

export type ToolExposureMode = 'groups' | 'full'

export const TOOL_EXPOSURE_ENV = 'MINGYUE_TOOL_EXPOSURE'
/** 单一参数的版本号；schema 哈希另行记录，二者共同进入请求快照。 */
export const TOOL_PARAM_VERSION = 1

export type ToolGroupId =
  | 'companion'
  | 'activity'
  | 'memory'
  | 'reminders'
  | 'alarms'
  | 'tasks'
  | 'files'
  | 'artifacts'
  | 'workspace'
  | 'apps'
  | 'window'
  | 'screen'
  | 'web'
  | 'page'
  | 'browser'
  | 'autoweb'
  | 'bilibili'
  | 'discovery'
  | 'terminal'

export interface ToolGroupDef {
  id: ToolGroupId
  title: string
  purpose: string
  tools: readonly string[]
  /** 加载本组时一并加载的依赖；按集合去重，不扩大权限。 */
  dependsOn: readonly ToolGroupId[]
}

/**
 * 隐藏的旧入口。handler 与参数契约仍保留在注册表里，历史回执也不改写；
 * 但新模型请求不再发送 schema，错误回执只给规范入口提示。
 */
export const HIDDEN_TOOL_REPLACEMENTS: Readonly<
  Record<string, { canonical: string | null; hint: string }>
> = {
  bili_media: {
    canonical: null,
    hint: 'B 站 API 路线没有播放器控制；需要状态/进度时用 bili_status，不要凭空控制播放。'
  },
  cua_screenshot: {
    canonical: 'screen_observe',
    hint: '改用 screen_observe（支持主屏/光标屏/displayId，截图与后续 CUA 坐标基准一致）。'
  },
  win_list: {
    canonical: 'computer_observe',
    hint: '改用 computer_observe({"target":"windows"}) 列出可观察窗口。'
  },
  win_elements: {
    canonical: 'computer_observe',
    hint: '改用 computer_observe({"target":"window","windowId":"..."}) 读取控件；可带 maxElements。'
  },
  browser_read: {
    canonical: 'browser_snapshot',
    hint: '改用 browser_snapshot({"view":"text",...}) 读取正文；结构视图用 view=structure（默认）。'
  },
  apps_find: {
    canonical: 'apps_list',
    hint: '改用 apps_list({"query":"..."}) 查找应用；列表会保留歧义提示且不会自动启动。'
  },
  win_read: {
    canonical: 'computer_observe',
    hint: '改用 computer_observe({"target":"window","windowId":"...","view":"text"}) 读取窗口文本。'
  },
  win_act: {
    canonical: 'computer_act',
    hint:
      '改用 computer_act({"windowId":"...","elementId":"...","action":"invoke"}) 按已观察 ID 操作；' +
      'action 按控件支持的动作填写。'
  },
  pet_emote: {
    canonical: 'pet_act',
    hint: '改用 pet_act({"preset":"focus"})；preset 与 animation/expression/motion 互斥。'
  }
}

export const CATALOG_TOOL_NAMES: readonly string[] = ['tool_groups', 'tools_load']

export const TOOL_GROUPS: readonly ToolGroupDef[] = [
  {
    id: 'companion',
    title: '表现与陪伴',
    purpose: '说话、表情动作、安静/暂停探索、打开聊天、结束当前回复',
    tools: [
      'pet_say',
      'reaction_respond',
      'pet_act',
      'pet_walk_to',
      'pet_quiet',
      'pet_pause_explore',
      'pet_open_chat',
      'end_turn'
    ],
    dependsOn: []
  },
  {
    id: 'activity',
    title: '活动感知',
    purpose: '查看前台应用、场景、活动摘要与时间线（不含截图）',
    tools: ['act_current', 'act_scene', 'act_summary', 'act_timeline'],
    dependsOn: []
  },
  {
    id: 'memory',
    title: '记忆与兴趣',
    purpose: '记忆检索/写入、兴趣管理、对陪伴方式的反馈',
    tools: [
      'mem_read',
      'mem_search',
      'mem_write',
      'mem_forget',
      'interest_create',
      'interest_update',
      'interest_list',
      'companion_feedback'
    ],
    dependsOn: []
  },
  {
    id: 'reminders',
    title: '用户提醒',
    purpose: '设置、查看、取消用户要求的提醒',
    tools: ['remind_set', 'remind_list', 'remind_cancel'],
    dependsOn: []
  },
  {
    id: 'alarms',
    title: '桌宠自唤醒',
    purpose: '设置、查看、取消桌宠自己安排的唤醒',
    tools: ['alarm_set', 'alarm_list', 'alarm_cancel'],
    dependsOn: []
  },
  {
    id: 'tasks',
    title: '任务管理',
    purpose: '持久任务的创建、检查点、完成/取消/放弃与休息',
    tools: [
      'task_create',
      'task_checkpoint',
      'task_complete',
      'task_status',
      'task_list',
      'task_cancel',
      'task_abandon',
      'autonomy_rest'
    ],
    dependsOn: []
  },
  {
    id: 'files',
    title: '文件探索',
    purpose: '只读查看可用范围、目录树、搜索与文件正文',
    tools: [
      'files_roots',
      'files_list',
      'files_tree',
      'files_search',
      'files_read',
      'files_info'
    ],
    dependsOn: []
  },
  {
    id: 'artifacts',
    title: '作品写入',
    purpose: '在作品目录内写入、编辑、移动、删除文件（含所需读取入口）',
    tools: [
      'files_artifact_list',
      'files_artifact_read',
      'files_artifact_write',
      'files_artifact_edit',
      'files_artifact_mkdir',
      'files_artifact_move',
      'files_artifact_delete'
    ],
    dependsOn: ['files']
  },
  {
    id: 'workspace',
    title: '工作区编辑',
    purpose: '工作区完整读写；写入前先读取并保留 hash/mtime 校验',
    tools: ['ws_list', 'ws_read', 'ws_search', 'ws_write', 'ws_replace', 'ws_delete', 'ws_move'],
    dependsOn: []
  },
  {
    id: 'apps',
    title: '应用与系统',
    purpose: '发现/启动/切换应用，打开系统白名单路径与 URL，系统动作',
    tools: [
      'apps_list',
      'apps_launch',
      'apps_focus',
      'apps_wait',
      'sys_open_app',
      'sys_open_path',
      'sys_open_url',
      'sys_action',
      'win_focus'
    ],
    dependsOn: []
  },
  {
    id: 'window',
    title: '窗口语义操作',
    purpose: '观察窗口/元素/文本、跨窗口查找、按 elementId 或语义控件操作、单窗口截图',
    tools: ['computer_observe', 'computer_find', 'computer_act', 'win_capture', 'win_focus'],
    dependsOn: []
  },
  {
    id: 'screen',
    title: '屏幕与键鼠',
    purpose: '整屏观察、缩放、点击/滚动/拖动/输入/按键、等待与停止',
    tools: [
      'screen_observe',
      'cua_zoom',
      'cua_click',
      'cua_scroll',
      'cua_drag',
      'cua_type',
      'cua_key',
      'cua_wait',
      'cua_stop'
    ],
    dependsOn: []
  },
  {
    id: 'web',
    title: '公开网页',
    purpose: '搜索与抓取公开网页，不依赖浏览器扩展',
    tools: ['web_search', 'web_fetch'],
    dependsOn: []
  },
  {
    id: 'page',
    title: '当前页面',
    purpose: '只读用户当前浏览器标签页的脱敏标题与摘要',
    tools: ['page_current'],
    dependsOn: []
  },
  {
    id: 'browser',
    title: '浏览器操作',
    purpose: '扩展连接的标签页状态、结构观察、点击/输入/导航/下载',
    tools: [
      'browser_status',
      'browser_tabs',
      'browser_open',
      'browser_navigate',
      'browser_snapshot',
      'browser_find',
      'browser_click',
      'browser_type',
      'browser_select',
      'browser_key',
      'browser_scroll',
      'browser_back',
      'browser_forward',
      'browser_wait',
      'browser_tab_switch',
      'browser_tab_close',
      'browser_restore_tabs',
      'browser_download'
    ],
    dependsOn: []
  },
  {
    id: 'autoweb',
    title: '自主网页阅读',
    purpose: '受限主动浏览会话与媒体控制；带观察、等待与发现证据入口',
    tools: [
      'web_open',
      'web_navigate',
      'web_media',
      'browser_status',
      'browser_tabs',
      'browser_snapshot',
      'browser_find',
      'browser_wait'
    ],
    dependsOn: ['discovery']
  },
  {
    id: 'bilibili',
    title: 'B 站阅读',
    purpose: '推荐/搜索/详情/字幕/封面/抽帧/转写与状态（不含播放器控制）',
    tools: [
      'bili_status',
      'bili_open',
      'bili_listing',
      'bili_search',
      'bili_detail',
      'bili_subtitle',
      'bili_frames',
      'bili_cover',
      'bili_transcribe',
      'bili_transcribe_status',
      'bili_assess',
      'bili_stop'
    ],
    dependsOn: ['discovery']
  },
  {
    id: 'discovery',
    title: '发现管理',
    purpose: '保存经浏览校验的发现、查看/分享与偏好反馈',
    tools: ['discovery_save', 'discovery_list', 'discovery_show', 'discovery_feedback'],
    dependsOn: []
  },
  {
    id: 'terminal',
    title: '终端',
    purpose: '在允许范围内运行白名单终端命令',
    tools: ['term_run'],
    dependsOn: []
  }
]

const GROUP_BY_ID = new Map<ToolGroupId, ToolGroupDef>(
  TOOL_GROUPS.map((group) => [group.id, group])
)
const CANONICAL_NAMES = new Set<string>(
  TOOL_GROUPS.flatMap((group) => group.tools).concat(CATALOG_TOOL_NAMES)
)
const GROUP_IDS = new Set<string>(TOOL_GROUPS.map((group) => group.id))

const BASE_GROUPS: Readonly<Record<ToolSource, readonly ToolGroupId[]>> = {
  'user-chat': ['companion', 'memory', 'reminders', 'alarms'],
  'quick-chat': ['companion'],
  autonomy: ['companion', 'tasks', 'memory'],
  task: ['companion', 'tasks']
}

/**
 * 任务能力 → 预载组。只决定 schema 可见性；每个动作仍必须命中任务 grant。
 * 同一能力可能对应多个入口（例如 desktop.observe 同时包含窗口与整屏观察）。
 */
export const CAPABILITY_TOOL_GROUPS: Readonly<
  Partial<Record<CapabilityId, readonly ToolGroupId[]>>
> = {
  'desktop.observe': ['window', 'screen'],
  'desktop.input': ['window', 'screen'],
  'app.launch': ['apps'],
  'browser.control': ['browser', 'autoweb'],
  'bilibili.read': ['bilibili', 'discovery'],
  'file.read': ['files', 'artifacts'],
  'file.write': ['artifacts'],
  'workspace.write': ['workspace'],
  'workspace.delete': ['workspace', 'artifacts'],
  'terminal.run': ['terminal'],
  'web.read': ['web', 'page'],
  'memory.write': ['memory']
}

export function isToolGroupId(value: string): value is ToolGroupId {
  return GROUP_IDS.has(value)
}

export function toolGroupsFor(name: string): ToolGroupId[] {
  return TOOL_GROUPS.filter((group) => group.tools.includes(name)).map((group) => group.id)
}

export function isCanonicalToolName(name: string): boolean {
  return CANONICAL_NAMES.has(name)
}

export function isHiddenLegacyTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(HIDDEN_TOOL_REPLACEMENTS, name)
}

export function groupsForCapabilities(
  capabilities: readonly CapabilityId[]
): ToolGroupId[] {
  const out = new Set<ToolGroupId>()
  for (const capability of capabilities) {
    for (const group of CAPABILITY_TOOL_GROUPS[capability] ?? []) out.add(group)
  }
  return [...out]
}

export function resolveToolExposureMode(
  explicit?: ToolExposureMode | null,
  env: NodeJS.ProcessEnv = process.env
): ToolExposureMode {
  if (explicit === 'groups' || explicit === 'full') return explicit
  return env[TOOL_EXPOSURE_ENV] === 'full' ? 'full' : 'groups'
}

/** 旧入口的规范替代提示；只含工具名，不含任何用户内容。 */
export function hiddenToolHint(name: string): string {
  const entry = HIDDEN_TOOL_REPLACEMENTS[name]
  if (entry === undefined) return ''
  return entry.hint
}

/**
 * World 的 ENV_PROMPT 可能同时说明多个工具组（例如浏览器/自主网页、
 * 文件读取/作品写入）。提示词块用 `<!-- tools-group: a b -->` 标注后，
 * 只保留本轮已加载组的块，避免模型读到根本调不到的入口说明。
 * 未标注的文字始终保留；没有标记的旧提示词保持原样。
 */
export function filterWorldPromptGroups(
  prompt: string,
  loaded: readonly ToolGroupId[]
): string {
  const loadedSet = new Set(loaded)
  const visible: boolean[] = []
  const out: string[] = []
  for (const line of prompt.split(/\r?\n/)) {
    const start = /^\s*<!--\s*tools-group:\s*([a-z0-9_, -]+)\s*-->\s*$/.exec(line)
    if (start !== null) {
      const ids = (start[1] ?? '').split(/[,\s]+/).filter(Boolean)
      visible.push(ids.some((id) => isToolGroupId(id) && loadedSet.has(id)))
      continue
    }
    if (/^\s*<!--\s*\/tools-group\s*-->\s*$/.test(line)) {
      visible.pop()
      continue
    }
    if (visible.every(Boolean)) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 新入口的“逻辑操作身份”。用于能力 grant、快捷 deniedTools 与审批动作，
 * 避免把旧 grant 自动拓宽到新模式，也避免旧禁用名失效。
 *
 * 注意：这里只改变授权比较使用的动作名；handler、审计与实际工具名保持
 * 调用者使用的规范名，历史记录不改写。
 */
export function toolOperationFor(name: string, rawArgs: unknown): string {
  const args =
    rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {}
  const text = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : ''

  if (name === 'computer_observe') {
    const windowId = text(args['windowId'])
    const target = text(args['target']) === '' ? (windowId === '' ? 'windows' : 'window') : text(args['target'])
    if (target === 'windows') return 'win_list'
    if (text(args['view']) === 'text') return 'win_read'
    if (text(args['query']) !== '') return 'computer_observe'
    return 'win_elements'
  }
  if (name === 'computer_act') {
    return text(args['elementId']) === '' ? 'computer_act' : 'win_act'
  }
  if (name === 'browser_snapshot') {
    return text(args['view']) === 'text' ? 'browser_read' : 'browser_snapshot'
  }
  if (name === 'apps_list') {
    return text(args['query']) === '' ? 'apps_list' : 'apps_find'
  }
  if (name === 'pet_act') {
    return text(args['preset']) === '' ? 'pet_act' : 'pet_emote'
  }
  return name
}

/** 旧 deniedTools 无法精确表达模式时，按更保守的规范入口收窄。 */
export function deniedOperationsFor(deniedTools: readonly string[]): Set<string> {
  const out = new Set<string>(deniedTools)
  for (const name of deniedTools) {
    if (name === 'cua_screenshot') out.add('screen_observe')
  }
  return out
}

export interface RequestToolSnapshot {
  requestId: string
  turnId: string | null
  source: ToolSource
  taskId?: string
  taskGeneration?: number
  groups: string[]
  revision: number
  names: string[]
  paramVersion: number
  /** 实际发送的 schema UTF-8 字节数（含 approval/approvalAsk 字段）。 */
  schemaBytes: number
  /** 工具名 → schema JSON 的短 SHA-256；用于发现同轮参数版本漂移。 */
  schemaHashes: Record<string, string>
  /** 系统提示中工具组目录的 UTF-8 字节数。 */
  groupCatalogBytes: number
  createdAt: number
}

export interface PreparedToolRequest {
  specs: ToolSpec[]
  snapshot: RequestToolSnapshot
}

export interface BeginExposureInput {
  turnId: string | null
  source: ToolSource
  taskId?: string
  taskGeneration?: number
  /** 真实 reaction 轮才暴露 reaction_respond。 */
  reaction?: boolean
  /** 宿主可信预载；仍会与 base 组做依赖闭包。 */
  preloadedGroups?: readonly string[]
}

export interface PrepareToolRequestInput {
  registry: ToolRegistry
  allowlist: string[] | null
  requestId: string
  turnId: string | null
  source: ToolSource
  taskId?: string
  taskGeneration?: number
}

interface ToolExposureControllerOptions {
  mode?: ToolExposureMode
  env?: NodeJS.ProcessEnv
  now?: () => number
}

/**
 * 活动回合/任务范围内的工具组状态。Core 与快捷聊天各持有一个实例，
 * 绝不能做成跨聊天共享的全局 Set。
 */
export class ToolExposureController {
  private readonly mode: ToolExposureMode
  private readonly now: () => number
  private loaded = new Set<ToolGroupId>()
  private revisionValue = 0
  private turnId: string | null = null
  private taskId: string | undefined
  private taskGeneration: number | undefined
  private reaction = false
  private loadCalls = 0
  private noChangeLoads = 0
  private lastSnapshot: RequestToolSnapshot | null = null
  private readonly history: RequestToolSnapshot[] = []

  constructor(options: ToolExposureControllerOptions = {}) {
    this.mode = resolveToolExposureMode(options.mode, options.env)
    this.now = options.now ?? (() => Date.now())
  }

  getMode(): ToolExposureMode {
    return this.mode
  }

  revision(): number {
    return this.revisionValue
  }

  currentTurnId(): string | null {
    return this.turnId
  }

  beginCycle(input: BeginExposureInput): void {
    this.turnId = input.turnId
    this.taskId = input.taskId
    this.taskGeneration = input.taskGeneration
    this.reaction = input.reaction === true
    this.loadCalls = 0
    this.noChangeLoads = 0
    const base =
      this.mode === 'full' ? TOOL_GROUPS.map((group) => group.id) : BASE_GROUPS[input.source]
    const expanded = this.expandGroups(
      [...base, ...(input.preloadedGroups ?? []).filter(isToolGroupId)]
    )
    this.loaded = new Set(expanded.groups)
    this.revisionValue += 1
  }

  /** 快照固定在发送时的可见集合；tools_load 只能改写下一次请求。 */
  currentRequest(): RequestToolSnapshot | null {
    return this.lastSnapshot
  }

  historyEntries(): readonly RequestToolSnapshot[] {
    return this.history
  }

  loadedGroups(): ToolGroupId[] {
    return TOOL_GROUPS.map((group) => group.id).filter((id) => this.loaded.has(id))
  }

  isGroupLoaded(id: string): boolean {
    return isToolGroupId(id) && this.loaded.has(id)
  }

  enabledNames(registry: ToolRegistry): string[] {
    return registry
      .list()
      .filter((tool) => tool.def.enabled?.() !== false)
      .map((tool) => tool.def.name)
  }

  visibleToolNames(registry: ToolRegistry): string[] {
    const enabledNames = this.enabledNames(registry)
    const enabled = new Set(enabledNames)
    // 隐藏旧名永远不回到模型请求；开发回退返回当前启用的全部规范工具，
    // 并保留宿主/测试注册的额外工具（它们不在组目录里）。
    if (this.mode === 'full') {
      return enabledNames.filter(
        (name) => !isHiddenLegacyTool(name) && (name !== 'reaction_respond' || this.reaction)
      )
    }
    const all = [...CANONICAL_NAMES].filter((name) => enabled.has(name))
    return all.filter((name) => {
      if (CATALOG_TOOL_NAMES.includes(name)) return true
      if (name === 'reaction_respond' && !this.reaction) return false
      const groups = toolGroupsFor(name)
      return groups.length === 0 || groups.some((group) => this.loaded.has(group))
    })
  }

  loadGroups(registry: ToolRegistry, requested: readonly string[]): ToolExposureLoadResult {
    this.loadCalls += 1
    if (this.loadCalls > 12) {
      return {
        text: '[TOOLS_LOAD_LIMIT] 本轮加载请求过多，不再处理。请直接用当前可见工具继续，或结束本轮。',
        changed: false,
        failed: true
      }
    }

    const unique = [...new Set(requested.map((value) => value.trim()).filter(Boolean))]
    const unknown = unique.filter((value) => !isToolGroupId(value))
    const valid = unique.filter(isToolGroupId)
    const already = valid.filter((id) => this.loaded.has(id))
    const unavailable: Array<{ id: string; reason: string }> = unknown.map((id) => ({
      id,
      reason: '未知工具组'
    }))

    if (this.mode === 'full') {
      const text = this.buildLoadText([], already, unavailable, [], true)
      return { text, changed: false }
    }

    const expanded = this.expandGroups(valid)
    const before = new Set(this.loaded)
    for (const id of expanded.groups) {
      if (this.loaded.has(id)) continue
      const enabled = TOOL_GROUPS.find((group) => group.id === id)!.tools.filter((name) =>
        registry.get(name)?.def.enabled?.() !== false
      )
      if (enabled.length === 0) {
        unavailable.push({ id, reason: '当前配置或运行条件没有启用该组工具' })
        continue
      }
      this.loaded.add(id)
    }

    // 以加载前的集合判断真实变化。依赖组可能早已随上一组加载；若按
    // “不在本次请求列表里”判断，会把它误报成新加载，重复加载也永远
    // 不算 no-op，导致每轮无谓提升 revision。
    const newlyLoaded = expanded.groups.filter(
      (id) => this.loaded.has(id) && !before.has(id)
    )
    const changed = newlyLoaded.length > 0
    if (changed) {
      this.revisionValue += 1
      this.noChangeLoads = 0
    } else {
      this.noChangeLoads += 1
      if (this.noChangeLoads >= 3) {
        return {
          text:
            '[TOOLS_LOAD_NOOP] 本轮已多次请求相同工具组，没有新的可见变化。' +
            '下一轮已经可以使用已加载工具；请直接继续，不要重复加载。',
          changed: false
        }
      }
    }
    const dependencyOnly = newlyLoaded.filter((id) => !valid.includes(id))
    const text = this.buildLoadText(
      newlyLoaded.filter((id) => valid.includes(id)),
      already,
      unavailable,
      dependencyOnly,
      changed
    )
    return { text, changed }
  }

  catalogText(registry: ToolRegistry): string {
    const enabled = new Set(this.enabledNames(registry))
    const lines = [
      '[TOOL_GROUPS]',
      '工具组只是可见性分类，不是权限分类。加载只让 schema 在下一轮模型请求可见，' +
        '不执行动作、不授予权限，也不启动应用或联网。',
      '已加载组的可用工具会进入后续请求的可见集合，但仍受当前入口白名单与运行时开关约束；' +
        '未加载组需要先 tools_load。具体可见工具以每轮工具列表为准。'
    ]
    for (const group of TOOL_GROUPS) {
      const available = group.tools.filter((name) => enabled.has(name))
      const loaded = this.loaded.has(group.id)
      const disabled = group.tools.filter((name) => !enabled.has(name))
      const status = loaded ? '已加载' : '未加载'
      const availability =
        available.length === 0
          ? '；当前不可用（没有启用工具）'
          : `；可用 ${available.length}/${group.tools.length}`
      const missing =
        disabled.length === 0
          ? ''
          : `；未启用：${disabled.slice(0, 4).join('/')}${disabled.length > 4 ? ' 等' : ''}`
      lines.push(`- ${group.id}（${group.title}，${status}${availability}）：${group.purpose}${missing}`)
    }
    lines.push(
      '需要其他领域时调用 tools_load({"groups":["组id", ...]})；结果在下一轮模型请求生效。' +
        '一次只加载当前任务真正需要的组，不要为了“看看有什么”加载全部。'
    )
    return lines.join('\n')
  }

  /**
   * 为一个物理/逻辑模型请求生成快照与实际 specs。allowlist 是显式窄化，
   * 与组可见集合取交集，不用于代替组状态。
   */
  prepareRequest(input: PrepareToolRequestInput): PreparedToolRequest {
    const names = this.visibleToolNames(input.registry).filter(
      (name) => input.allowlist === null || input.allowlist.includes(name)
    )
    const specs =
      typeof input.registry.specsFor === 'function'
        ? input.registry.specsFor(names)
        : input.registry.specs(names)
    const actualNames = specs.map((spec) => spec.function.name)
    const schemaHashes: Record<string, string> = {}
    let schemaBytes = 0
    for (const spec of specs) {
      const json = JSON.stringify(spec)
      schemaBytes += Buffer.byteLength(json, 'utf8')
      schemaHashes[spec.function.name] = createHash('sha256')
        .update(json)
        .digest('hex')
        .slice(0, 12)
    }
    const snapshot: RequestToolSnapshot = {
      requestId: input.requestId,
      turnId: input.turnId,
      source: input.source,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.taskGeneration === undefined
        ? {}
        : { taskGeneration: input.taskGeneration }),
      groups: [...this.loadedGroups()],
      revision: this.revisionValue,
      names: actualNames,
      paramVersion: TOOL_PARAM_VERSION,
      schemaBytes,
      schemaHashes,
      groupCatalogBytes: Buffer.byteLength(this.catalogText(input.registry), 'utf8'),
      createdAt: this.now()
    }
    this.lastSnapshot = snapshot
    this.history.push(snapshot)
    if (this.history.length > 40) this.history.splice(0, this.history.length - 40)
    return { specs, snapshot }
  }

  /** 执行器/工具上下文使用的固定快照视图。 */
  handleFor(
    snapshot: RequestToolSnapshot,
    registry: ToolRegistry,
    extra: {
      deniedNames?: ReadonlySet<string>
      deniedOperations?: ReadonlySet<string>
    } = {}
  ): ToolRequestExposure {
    const names = new Set(snapshot.names)
    return {
      requestId: snapshot.requestId,
      revision: snapshot.revision,
      names,
      groups: [...snapshot.groups],
      ...(extra.deniedNames === undefined ? {} : { deniedNames: extra.deniedNames }),
      ...(extra.deniedOperations === undefined
        ? {}
        : { deniedOperations: extra.deniedOperations }),
      load: (groups) => this.loadGroups(registry, groups),
      catalog: () => this.catalogText(registry)
    }
  }

  private expandGroups(ids: readonly ToolGroupId[]): { groups: ToolGroupId[] } {
    const out = new Set<ToolGroupId>()
    const visit = (id: ToolGroupId): void => {
      if (out.has(id)) return
      out.add(id)
      for (const dep of GROUP_BY_ID.get(id)?.dependsOn ?? []) visit(dep)
    }
    for (const id of ids) visit(id)
    return { groups: TOOL_GROUPS.map((group) => group.id).filter((id) => out.has(id)) }
  }

  private buildLoadText(
    newlyLoaded: readonly string[],
    already: readonly string[],
    unavailable: ReadonlyArray<{ id: string; reason: string }>,
    dependencyOnly: readonly string[],
    changed: boolean
  ): string {
    const lines: string[] = []
    if (newlyLoaded.length > 0) {
      lines.push(
        `[TOOLS_LOADED] 已加载：${newlyLoaded.join('、')}；这些组的 schema 从下一轮模型请求开始可用。`
      )
    }
    if (dependencyOnly.length > 0) {
      lines.push(`已同时加载依赖组：${dependencyOnly.join('、')}。`)
    }
    if (already.length > 0) {
      lines.push(`已在可见集合：${already.join('、')}。`)
    }
    if (unavailable.length > 0) {
      lines.push(
        `[TOOLS_LOAD_UNAVAILABLE] ${unavailable
          .map((entry) => `${entry.id}（${entry.reason}）`)
          .join('；')}。`
      )
    }
    if (!changed && newlyLoaded.length === 0 && unavailable.length === 0) {
      lines.push('[TOOLS_LOAD_NOOP] 这些组已经加载，下一轮可直接使用。')
    }
    lines.push('加载不执行任何动作，也不改变权限；当前响应里尚未加载的动作不会提前执行。')
    return lines.join('\n')
  }
}
