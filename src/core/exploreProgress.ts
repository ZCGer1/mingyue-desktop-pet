/**
 * 自主探索结果分类。
 *
 * 工具「开始调用」不算进展；只有成功的工具回执才进入判断，并且：
 * - 只结束回合 / 表现动作 / 状态查询 / 失败工具 / 重复读取 = no_progress；
 * - 真正读到新内容 = observation；动作发生 = action；
 * - 写入后回读到同一目标 = artifact；建立可执行目标 = planning；
 * - autonomy_rest = rest（有界休息，受尊重）。
 *
 * 这里保持纯函数，便于回归「end_turn × N 也必须触发空转处理」。
 */

export interface ExploreCycle {
  results: number
  failed: number
  duplicate: number
  rest: boolean
  planning: boolean
  observation: boolean
  action: boolean
  artifact: boolean
  pendingArtifacts: Set<string>
}

export type ExploreCycleKind =
  | 'observation'
  | 'action'
  | 'artifact'
  | 'planning'
  | 'rest'
  | 'no_progress'

export interface ExploreToolResult {
  id: string
  name: string
  failed: boolean
  text: string
  meta?: { targetRef?: string | null; operation?: string }
}

const NO_PROGRESS_TOOLS: ReadonlySet<string> = new Set([
  'tool_groups',
  'tools_load',
  'end_turn',
  'pet_say',
  'pet_emote',
  'pet_act',
  'pet_walk_to',
  'pet_quiet',
  'pet_pause_explore',
  'pet_open_chat',
  'reaction_respond',
  'act_summary',
  'act_current',
  'act_scene',
  'act_timeline',
  'task_status',
  'task_list',
  'win_list',
  'cua_wait',
  'cua_stop',
  'browser_status',
  'browser_tabs',
  'browser_wait',
  'apps_list',
  'apps_find',
  'apps_wait',
  'files_roots',
  'interest_list',
  'remind_list',
  'alarm_list',
  'companion_feedback'
])

const READ_TOOLS: ReadonlySet<string> = new Set([
  'ws_list',
  'ws_read',
  'ws_search',
  'win_read',
  'win_capture',
  'win_elements',
  'computer_observe',
  'computer_find',
  'screen_observe',
  'cua_screenshot',
  'cua_zoom',
  'page_current',
  'web_fetch',
  'web_search',
  'browser_snapshot',
  'browser_read',
  'browser_find',
  'files_list',
  'files_tree',
  'files_search',
  'files_read',
  'files_info',
  'files_artifact_list',
  'files_artifact_read',
  'mem_read',
  'mem_search'
])

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'ws_write',
  'ws_replace',
  'files_artifact_write',
  'files_artifact_edit',
  'files_artifact_mkdir',
  'files_artifact_move'
])

const ACTION_TOOLS: ReadonlySet<string> = new Set([
  'cua_click',
  'cua_scroll',
  'cua_drag',
  'cua_type',
  'cua_key',
  'win_focus',
  'win_act',
  'computer_act',
  'sys_open_app',
  'sys_open_path',
  'sys_open_url',
  'sys_action',
  'apps_launch',
  'apps_focus',
  'browser_open',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_key',
  'browser_scroll',
  'browser_back',
  'browser_forward',
  'browser_tab_switch',
  'browser_tab_close',
  'browser_restore_tabs',
  'browser_download',
  'files_artifact_delete',
  'term_run',
  'ws_move',
  'ws_delete'
])

const PLANNING_TOOLS: ReadonlySet<string> = new Set([
  'task_create',
  'task_checkpoint',
  'task_complete',
  'task_abandon',
  'task_cancel',
  'interest_create',
  'interest_update',
  'remind_set',
  'alarm_set'
])

export function createExploreCycle(): ExploreCycle {
  return {
    results: 0,
    failed: 0,
    duplicate: 0,
    rest: false,
    planning: false,
    observation: false,
    action: false,
    artifact: false,
    pendingArtifacts: new Set<string>()
  }
}

export function classifyExploreResult(cycle: ExploreCycle, event: ExploreToolResult): void {
  cycle.results += 1
  if (event.failed) {
    cycle.failed += 1
    return
  }
  const name = event.name
  if (name === 'autonomy_rest') {
    cycle.rest = true
    return
  }
  // 统一观察入口按旧操作身份分类：列窗口（旧 win_list）只是状态查询，
  // 不能因为合并入口变成 computer_observe 就算作新观察。
  if (name === 'computer_observe' && event.meta?.operation === 'win_list') return
  if (NO_PROGRESS_TOOLS.has(name)) return
  const targetRef = typeof event.meta?.targetRef === 'string' ? event.meta.targetRef : ''
  if (WRITE_TOOLS.has(name)) {
    cycle.pendingArtifacts.add(targetRef === '' ? `__${event.id}` : targetRef)
    return
  }
  const isRead = READ_TOOLS.has(name)
  if (isRead && targetRef !== '' && cycle.pendingArtifacts.delete(targetRef)) {
    cycle.artifact = true
    return
  }
  if (isRead) {
    // ws_read 对已看过的内容会加 [已看过] 提示；重复读取不是进展。
    if (event.text.includes('[已看过]')) {
      cycle.duplicate += 1
      return
    }
    cycle.observation = true
    return
  }
  if (ACTION_TOOLS.has(name)) {
    cycle.action = true
    return
  }
  if (PLANNING_TOOLS.has(name)) {
    cycle.planning = true
  }
}

export function exploreCycleKind(cycle: ExploreCycle): ExploreCycleKind {
  if (cycle.rest) return 'rest'
  if (cycle.artifact) return 'artifact'
  if (cycle.action) return 'action'
  if (cycle.observation) return 'observation'
  if (cycle.planning) return 'planning'
  return 'no_progress'
}

export type ExploreProgressKind = Exclude<ExploreCycleKind, 'rest' | 'no_progress'>
export type ExploreNextState = 'progress' | 'rest' | 'no_progress'

export interface ExploreCycleSummary {
  /** 同一次探索里的全部真实进展，按显著性排序；不被 rest 覆盖。 */
  progressKinds: ExploreProgressKind[]
  /** 这一轮是否主动选择休息（可与进展同时存在）。 */
  rest: boolean
  failures: number
  /** 调度上的下一步：有进展优先继续；只有休息才算休息。 */
  nextState: ExploreNextState
}

/**
 * 多维结果：一次「先观察再休息」既保留 observation，也保留 rest。
 * `exploreCycleKind` 为兼容旧调用保留单一优先级分类。
 */
export function exploreCycleSummary(cycle: ExploreCycle): ExploreCycleSummary {
  const progressKinds: ExploreProgressKind[] = []
  if (cycle.artifact) progressKinds.push('artifact')
  if (cycle.action) progressKinds.push('action')
  if (cycle.observation) progressKinds.push('observation')
  if (cycle.planning) progressKinds.push('planning')
  return {
    progressKinds,
    rest: cycle.rest,
    failures: cycle.failed,
    nextState:
      progressKinds.length > 0 ? 'progress' : cycle.rest ? 'rest' : 'no_progress'
  }
}
