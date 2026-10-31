/**
 * 能力授权（PLAN.md §4）。
 *
 * CapabilityStore 只回答「这个来源/这次动作有没有资格」，不决定风险等级，
 * 也不决定要不要弹审批卡；那两件事仍由 RiskPolicy 与 ApprovalGate 负责。
 * 授权只能由用户当轮请求、用户审批或用户显式预授权产生；网页/屏幕/
 * 文件/终端内容永远不能铸造或扩大授权。
 */

export type CapabilityId =
  | 'desktop.observe'
  | 'desktop.input'
  | 'app.launch'
  | 'browser.control'
  /** 独立扫码登录 + Python API 的 B 站只读阅读；与浏览器标签页解耦。 */
  | 'bilibili.read'
  | 'file.read'
  | 'file.write'
  | 'workspace.write'
  | 'workspace.delete'
  | 'terminal.run'
  | 'web.read'
  | 'memory.write'

/** 工具调用来自哪个入口；与 UI 的 ApprovalOrigin（chat/quick）分开。 */
export type ToolSource = 'user-chat' | 'quick-chat' | 'autonomy' | 'task'

export type GrantScope = 'turn' | 'task' | 'session' | 'always'

export type GrantSource =
  | 'user-turn'
  | 'approval'
  | 'config-consent'
  | 'task-preauthorization'

export interface CapabilityConstraints {
  appAllowlist?: string[]
  pathRoots?: string[]
  domains?: string[]
  maxActions?: number
}

export interface CapabilityGrant {
  id: string
  capability: CapabilityId
  scope: GrantScope
  source: GrantSource
  /** 精确到工具名的动作列表；空列表表示没有任何动作被授权。 */
  actions: string[]
  constraints: CapabilityConstraints
  createdAt: number
  expiresAt: number | null
  revokedAt: number | null
  /** task scope 必填；其它 scope 为 null。 */
  taskId: string | null
  revision: number
  /** 已预占的动作次数；执行前预占，失败也计入。 */
  usedActions: number
  /** 仅对黄区有效；红区/forceAsk=always 永远不会被它绕过。 */
  autoApproveYellow: boolean
}

export interface CapabilityCheckInput {
  capability: CapabilityId
  action: string
  source: ToolSource
  taskId?: string
  taskGeneration?: number
  /**
   * 本次动作实际会触及的绝对路径（已 realpath）。
   * grant 带 `pathRoots` 时必须提供，否则 fail closed。
   */
  targetPaths?: string[]
  /** 目标窗口所属进程键（已规范化）。grant 带 appAllowlist 时必须提供。 */
  targetApps?: string[]
  /** 本次实际访问的域名（含重定向后的最终域名）。grant 带 domains 时必须提供。 */
  targetDomains?: string[]
  now: number
}

/** 执行器解析出的本次动作目标；缺失字段按 fail closed 解释。 */
export interface CapabilityTargets {
  paths?: string[]
  apps?: string[]
  domains?: string[]
}

/** 拒绝的结构化原因；模型与设置页可据它区分“缺目标/越界/授权失效”。 */
export type CapabilityDenialCode =
  | 'target-resolution-missing'
  | 'grant-expired'
  | 'path-outside-scope'
  | 'window-scope-missing'
  | 'excluded-target'
  | 'domain-outside-scope'
  | 'desktop-disabled'
  | 'unsupported-autonomy-action'
  | 'policy-denied'

export interface CapabilityCheckResult {
  allowed: boolean
  code?: 'CAPABILITY_DENIED'
  reason?: string
  reasonCode?: CapabilityDenialCode
  grant?: CapabilityGrant
}

export const ALL_CAPABILITIES: readonly CapabilityId[] = [
  'desktop.observe',
  'desktop.input',
  'app.launch',
  'browser.control',
  'bilibili.read',
  'file.read',
  'file.write',
  'workspace.write',
  'workspace.delete',
  'terminal.run',
  'web.read',
  'memory.write'
]

export const CAPABILITY_LABELS: Record<CapabilityId, string> = {
  'desktop.observe': '查看屏幕与窗口',
  'desktop.input': '操作鼠标键盘',
  'app.launch': '发现/启动/切换普通应用',
  'browser.control': '主动浏览网页',
  'bilibili.read': '通过 API 阅读 B 站视频',
  'file.read': '读取授权范围内的文件',
  'file.write': '写入她自己的作品/受权文件',
  'workspace.write': '写入工作区文件',
  'workspace.delete': '删除文件',
  'terminal.run': '运行终端命令',
  'web.read': '读取网页内容',
  'memory.write': '写入长期记忆'
}

/**
 * 每个能力默认覆盖的工具。授权按动作收敛，避免「允许看屏幕」被解释成
 * 「允许点击」。
 */
export const CAPABILITY_ACTIONS: Record<CapabilityId, readonly string[]> = {
  'desktop.observe': [
    'cua_screenshot',
    'cua_zoom',
    'win_list',
    'win_read',
    'win_capture',
    'win_elements',
    'screen_observe',
    'computer_observe',
    'computer_find'
  ],
  'desktop.input': [
    'cua_click',
    'cua_scroll',
    'cua_drag',
    'cua_type',
    'cua_key',
    'win_focus',
    'win_act',
    'computer_act'
  ],
  'app.launch': [
    'sys_open_app',
    'sys_open_path',
    'sys_open_url',
    'apps_list',
    'apps_find',
    'apps_launch',
    'apps_focus',
    'apps_wait'
  ],
  'browser.control': [
    'browser_status',
    'browser_tabs',
    'browser_open',
    'browser_navigate',
    'browser_snapshot',
    'browser_read',
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
    'browser_download',
    'browser_restore_tabs',
    'web_open',
    'web_navigate',
    'web_media'
  ],
  'bilibili.read': [
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
    'bili_media'
    // bili_status / bili_stop 是安全阀，永远不要求能力。
  ],
  'file.read': [
    'files_roots',
    'files_list',
    'files_tree',
    'files_search',
    'files_read',
    'files_info',
    'files_artifact_list',
    'files_artifact_read'
  ],
  'file.write': [
    'files_artifact_write',
    'files_artifact_edit',
    'files_artifact_mkdir',
    'files_artifact_move'
  ],
  'workspace.write': ['ws_write', 'ws_replace', 'ws_move'],
  'workspace.delete': ['ws_delete', 'files_artifact_delete'],
  'terminal.run': ['term_run'],
  'web.read': ['web_search', 'web_fetch', 'page_current'],
  'memory.write': ['mem_write', 'mem_forget']
}

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === 'string' && (ALL_CAPABILITIES as readonly string[]).includes(value)
}
