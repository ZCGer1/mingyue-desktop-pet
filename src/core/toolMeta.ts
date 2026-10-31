import {
  CAPABILITY_ACTIONS,
  type CapabilityId
} from './capabilityTypes'

/**
 * 工具 → 能力 / 桌面租约 / 副作用的集中元数据。
 *
 * 这里只有静态语义；运行时是否可用仍由 World.enabled、RiskPolicy 与
 * CapabilityStore 决定。新增工具必须在这里登记，否则按「无能力要求、
 * 有副作用」处理，宁可多问一次也不静默放行。
 */

export type DesktopLeaseKind = 'observe' | 'input' | 'launch'

export interface ToolMeta {
  targetless?: boolean
  visual?: boolean
  capability?: CapabilityId
  /** 需要 DesktopActionCoordinator 串行化的桌面动作类型。 */
  desktop?: DesktopLeaseKind
  /** 是否可能改变外部状态（文件、界面、网络提交等）。 */
  sideEffect: boolean
  /** 可作为任务「已完成」的验证证据（在最后副作用之后）。 */
  verify?: boolean
}

const OBSERVE = new Set([
  'cua_screenshot',
  'cua_zoom',
  'win_capture',
  'win_elements',
  'computer_observe',
  'computer_find',
  'screen_observe'
])
const INPUT = new Set([
  'cua_click',
  'cua_scroll',
  'cua_drag',
  'cua_type',
  'cua_key',
  'win_focus',
  'win_act',
  'computer_act'
])
const LAUNCH = new Set([
  'sys_open_app',
  'sys_open_path',
  'sys_open_url',
  'apps_launch',
  'apps_focus'
])
/**
 * 只改变桌宠表现、不改变任何外部状态的工具。
 * 它们可以出现在任务最后（例如 pet_say 邀请用户看笔记），不能被当成
 * 「需要再验证的副作用」，否则任务永远无法通过完成校验。
 */
const PRESENTATION_TOOLS = new Set([
  'pet_say',
  'pet_emote',
  'pet_act',
  'pet_walk_to',
  'pet_quiet',
  'pet_open_chat',
  'end_turn'
])
const READ_TOOLS = new Set([
  'cua_screenshot',
  'cua_zoom',
  'ws_read',
  'ws_list',
  'ws_search',
  'page_current',
  'web_search',
  'web_fetch',
  'win_read',
  'win_elements',
  'computer_observe',
  'computer_find',
  'apps_list',
  'apps_find',
  'apps_wait',
  'browser_status',
  'browser_tabs',
  'browser_snapshot',
  'browser_read',
  'browser_find',
  'browser_wait',
  'bili_status',
  'bili_open',
  'bili_listing',
  'bili_search',
  'bili_detail',
  'bili_subtitle',
  'bili_frames',
  'bili_cover',
  'bili_transcribe_status',
  'bili_media',
  'web_media',
  'files_roots',
  'files_list',
  'files_tree',
  'files_search',
  'files_read',
  'files_info',
  'files_artifact_list',
  'files_artifact_read',
  'mem_read',
  'mem_search',
  'act_current',
  'act_scene',
  'act_summary',
  'act_timeline',
  'task_list',
  'task_status'
])
const SIDE_EFFECT_TOOLS = new Set([
  'cua_click',
  'cua_scroll',
  'cua_drag',
  'cua_type',
  'cua_key',
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
  'bili_transcribe',
  'bili_assess',
  'web_open',
  'web_navigate',
  'win_act',
  'computer_act',
  'files_artifact_write',
  'files_artifact_edit',
  'files_artifact_mkdir',
  'files_artifact_move',
  'files_artifact_delete',
  'term_run',
  'ws_write',
  'ws_replace',
  'ws_move',
  'ws_delete',
  'mem_write',
  'mem_forget',
  'alarm_set',
  'alarm_cancel',
  'remind_set',
  'remind_cancel',
  'task_create',
  'task_checkpoint',
  'task_complete',
  'task_cancel'
])

function capabilityFor(name: string): CapabilityId | undefined {
  for (const [capability, actions] of Object.entries(CAPABILITY_ACTIONS) as Array<
    [CapabilityId, readonly string[]]
  >) {
    if (actions.includes(name)) return capability
  }
  return undefined
}

export function toolMetaFor(name: string, operation: string = name): ToolMeta {
  if (name === 'sys_action') return { sideEffect: true, targetless: true }
  // 工具目录只改变下一轮 schema 可见性，不执行动作、不算完成证据。
  if (name === 'tool_groups' || name === 'tools_load') {
    return { sideEffect: false }
  }
  // 合并入口必须沿用旧操作身份的租约与完成证据语义：
  // - 窗口清单（旧 win_list）不拿桌面观察租约，也不算任务完成证据；
  // - 窗口文本（旧 win_read）只读、可作验证证据，但不拿租约。
  // 否则 computer_observe 会因为统一入口而凭空升级验证能力。
  if (name === 'computer_observe' && operation === 'win_list') {
    return { capability: 'desktop.observe', sideEffect: false }
  }
  if (name === 'computer_observe' && operation === 'win_read') {
    return { capability: 'desktop.observe', sideEffect: false, verify: true }
  }
  const capability = capabilityFor(name)
  if (OBSERVE.has(name)) {
    return { capability: 'desktop.observe', desktop: 'observe', sideEffect: false, verify: true, ...(['cua_screenshot', 'cua_zoom', 'win_capture', 'screen_observe'].includes(name) || operation === 'win_capture' ? { visual: true } : {}) }
  }
  if (INPUT.has(name)) {
    return { capability: 'desktop.input', desktop: 'input', sideEffect: true }
  }
  if (LAUNCH.has(name)) {
    return { capability: 'app.launch', desktop: 'launch', sideEffect: true }
  }
  if (name === 'win_list') {
    return { capability: 'desktop.observe', sideEffect: false }
  }
  // 停止/状态是安全阀，不要求能力、不算副作用，也不作为任务完成证据。
  if (name === 'bili_stop' || name === 'bili_status') return { sideEffect: false }
  if (name === 'task_complete') return { sideEffect: true }
  if (PRESENTATION_TOOLS.has(name)) return { sideEffect: false }
  if (READ_TOOLS.has(name)) {
    return {
      ...(capability === undefined ? {} : { capability }),
      sideEffect: false,
      verify: true
    }
  }
  if (SIDE_EFFECT_TOOLS.has(name)) {
    return { ...(capability === undefined ? {} : { capability }), sideEffect: true }
  }
  return { ...(capability === undefined ? {} : { capability }), sideEffect: true }
}

export function isVerifyTool(name: string): boolean {
  return toolMetaFor(name).verify === true
}
