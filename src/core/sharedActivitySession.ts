import type { ReactiveEventNotice } from '../shared/reaction'
import type { ToolOutcomeMeta } from './types'
import type { ToolSource } from './capabilityTypes'
import { safeDiscovery } from './conversationEpisode'

/**
 * 共同操作会话（轻量、纯内存）。
 *
 * 它回答“我们现在一起做什么、她上次实际看到了什么、下一步该看哪里”，
 * 而不是再复制一套任务/授权：
 * - 进入会话不授予任何新权限；工具仍走既有 CapabilityStore 与审批；
 * - 只保存脱敏目标引用、工具级步骤与事件级推断，不保存页面/窗口正文；
 * - 完整聊天、快捷聊天、桌宠气泡读到同一份状态；
 * - 用户接管时暂停操作，自己的窗口变化不会被当作用户的新意图。
 */

export const SHARED_SESSION_TTL_MS = 30 * 60_000
const MAX_FACTS = 6
const MAX_INFERENCES = 5
const MAX_COMPLETED = 10
const MAX_PENDING = 5
const MAX_PENDING_WRITE_REFS = 3
const MAX_TARGET_CHARS = 120

export type SharedEntry = 'chat' | 'quick-chat' | 'pet'
export type SharedContextEntry = SharedEntry | 'core'
export type SharedActor = 'user' | 'pet' | 'uncertain'

export interface SharedActivitySessionOptions {
  now?: () => number
  ttlMs?: number
}

export interface SharedUserTextResult {
  active: boolean
  started: boolean
  ended: boolean
  paused: boolean
}

export interface SharedLeaseView {
  held: boolean
  heldBy: string | null
  kind: string | null
  userHold: boolean
  locked: boolean
}

export interface SharedSessionDiagnostics {
  active: boolean
  paused: boolean
  inputInvited: boolean
  goalChars: number
  observationVersion: number
  targetKind: string | null
  hasTarget: boolean
  facts: number
  inferences: number
  completedSteps: number
  pendingSteps: number
  entries: SharedEntry[]
  lastActor: SharedActor | null
  ageMs: number
  endedReason: string | null
}

interface StepRecord {
  text: string
  at: number
  actor: SharedActor
}

interface InferenceRecord {
  text: string
  at: number
  source: 'activity' | 'pet' | 'plan'
}

interface SharedState {
  id: string
  goal: string
  originalGoal: string
  lastUserRequest: string
  targetRef: string | null
  targetKind: string | null
  targetLabel: string | null
  observationVersion: number
  lastObservationAt: number | null
  interfaceChanged: boolean
  lastActor: SharedActor | null
  facts: string[]
  inferences: InferenceRecord[]
  completed: StepRecord[]
  pending: string[]
  pendingWriteRefs: string[]
  inputInvited: boolean
  paused: boolean
  pauseReason: string | null
  entries: Set<SharedEntry>
  createdAt: number
  updatedAt: number
  lastUserAt: number
  lastPetAt: number | null
  endedAt: number | null
  endReason: string | null
}

const INVITE_RE =
  /(?:陪我|和我|跟我|我们|一起|一块儿?|共同)(?:一起)?(?:看看|看一下|看下|看这个|看这|看那份|做|改|弄|处理|整理|写|读|研究|搞|修|完成|打开|填写|填一下)|(?:帮我|替我)(?:看看|看一下|看下|看这个|看这|看那份|做|改|弄|处理|整理|写|读|研究|搞|修|打开|填写|填一下)|(?:let'?s|help me)\s+(?:look|work|edit|fix|open|read|do)\b/i

const END_RE =
  /(?:先不(?:弄|做|看|改|用|管)了?|不(?:弄|做|看|改)了|我自己(?:来|弄|做|改|看)|退出(?:共同|一起)?|结束(?:吧|一下)?|就到(?:这|这里)|先到(?:这|这里)|先这样|回头再(?:说|弄)|不用(?:了|你帮)|别弄了)/

const PAUSE_RE = /(?:暂停(?:一下|一下下)?|先停(?:一下)?|停一下|等一下再|等会儿再)/

const RESUME_RE = /(?:继续|接着(?:来|弄|做|看)?|好了|可以了|你来吧|你来|开始吧)/

// 「好了/可以了」可能只是聊天里的应答；只有明确的继续语义才允许把
// 刚结束的共同会话重新打开。否则用户一句「好了」会把已收尾的任务拉回来。
const REOPEN_RE = /(?:继续|接着(?:来|弄|做|看)?|我们(?:接着|继续)|开始吧)/

const INPUT_INVITE_RE =
  /(?:帮我|替我|你来|你帮我|由你|让你|请你)[^，。；\n]{0,12}(?:改|填|输入|点|操作|整理|保存|替换|删除|打开|切换|运行|执行|弄|处理|写|做)|(?:陪我|和我|跟我|我们|一起|一块儿?)[^，。；\n]{0,8}(?:改|填|输入|点|操作|保存|替换|删除|运行|执行|弄|处理|写|做)/

const READ_TOOLS: ReadonlySet<string> = new Set([
  'win_read',
  'win_capture',
  'win_list',
  'cua_screenshot',
  'cua_zoom',
  'screen_observe',
  'computer_observe',
  'computer_find',
  'ws_list',
  'ws_read',
  'ws_search',
  'web_fetch',
  'web_search',
  'page_current',
  'mem_read',
  'mem_search'
])

const WRITE_TOOLS: ReadonlySet<string> = new Set(['ws_write', 'ws_replace', 'ws_move', 'ws_delete'])

const ACTION_TOOLS: ReadonlySet<string> = new Set([
  'cua_click',
  'cua_scroll',
  'cua_drag',
  'cua_type',
  'cua_key',
  'win_focus',
  'computer_act',
  'sys_open_app',
  'sys_open_path',
  'sys_open_url',
  'sys_action',
  'term_run'
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

const TOOL_LABELS: Readonly<Record<string, string>> = {
  win_read: '读取授权窗口文本',
  win_capture: '查看授权窗口截图',
  win_list: '查看授权窗口清单',
  cua_screenshot: '查看屏幕',
  cua_zoom: '放大查看屏幕',
  screen_observe: '查看屏幕',
  computer_observe: '观察授权窗口与控件',
  computer_act: '操作授权窗口控件',
  ws_read: '读取文件',
  ws_list: '查看目录',
  ws_search: '搜索文件',
  web_fetch: '读取网页',
  web_search: '搜索网页',
  page_current: '读取当前页面',
  mem_read: '查看记忆',
  mem_search: '搜索记忆',
  ws_write: '写入文件',
  ws_replace: '修改文件',
  ws_move: '移动文件',
  ws_delete: '删除文件',
  cua_click: '点击界面',
  cua_scroll: '滚动界面',
  cua_drag: '拖动界面',
  cua_type: '输入文字',
  cua_key: '按键',
  win_focus: '切换授权窗口',
  sys_open_app: '打开应用',
  sys_open_path: '打开路径',
  sys_open_url: '打开链接',
  sys_action: '执行系统动作',
  term_run: '运行终端命令'
}

function cleanText(input: unknown, max = 160): string {
  if (typeof input !== 'string') return ''
  return safeDiscovery(input).slice(0, max).trim()
}

function cleanRef(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = cleanText(input, MAX_TARGET_CHARS)
  return value === '' ? null : value
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? '执行操作'
}

function actorLabel(actor: SharedActor | null): string {
  if (actor === 'pet') return '她自己的动作'
  if (actor === 'uncertain') return '无法确定的一方'
  return '用户'
}

function ageText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} 分钟前`
  return `${Math.round(minutes / 60)} 小时前`
}

function dedupePush(list: string[], value: string, max: number): void {
  if (value === '') return
  const index = list.indexOf(value)
  if (index !== -1) list.splice(index, 1)
  list.push(value)
  while (list.length > max) list.shift()
}

function addCompleted(
  state: SharedState,
  text: string,
  actor: SharedActor,
  at: number
): void {
  const index = state.completed.findIndex((step) => step.text === text)
  if (index !== -1) state.completed.splice(index, 1)
  state.completed.push({ text, at, actor })
  while (state.completed.length > MAX_COMPLETED) state.completed.shift()
}

function bigrams(input: string): Set<string> {
  const normalized = input.replace(/[\s，。！？,.!?、；;：“”"'（）()]/g, '')
  const grams = new Set<string>()
  for (let i = 0; i < normalized.length - 1; i += 1) grams.add(normalized.slice(i, i + 2))
  return grams
}

const TARGET_NOUNS: ReadonlyArray<[string, RegExp]> = [
  ['document', /文档|文件|稿子|论文|报告/],
  ['page', /网页|页面|网站|链接/],
  ['spreadsheet', /表格|工作表|Excel/i],
  ['image', /图片|照片|截图/],
  ['code', /代码|脚本|程序/],
  ['note', /笔记|便签/],
  ['mail', /邮件|邮箱/],
  ['slide', /幻灯片|演示文稿|PPT/i],
  ['folder', /文件夹|目录/],
  ['app', /应用|软件/]
]

function targetNoun(input: string): string | null {
  for (const [name, pattern] of TARGET_NOUNS) {
    if (pattern.test(input)) return name
  }
  return null
}

/** 新邀请是在改述同一目标，还是换了对象。 */
function goalChanged(previous: string, next: string): boolean {
  if (previous === next) return false
  const before = targetNoun(previous)
  const after = targetNoun(next)
  if (before !== null && after !== null && before !== after) return true
  const a = bigrams(previous)
  const b = bigrams(next)
  if (a.size === 0 || b.size === 0) return false
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  const union = a.size + b.size - shared
  return shared / union < 0.15
}

function hasTargetSpecificState(state: SharedState): boolean {
  return (
    state.targetRef !== null ||
    state.facts.length > 0 ||
    state.completed.length > 0 ||
    state.pending.length > 0
  )
}

function resetForNewGoal(state: SharedState, goal: string): void {
  state.goal = goal
  state.targetRef = null
  state.targetKind = null
  state.targetLabel = null
  state.observationVersion = 0
  state.lastObservationAt = null
  state.interfaceChanged = false
  state.lastActor = null
  state.facts = []
  state.inferences = []
  state.completed = []
  state.pending = []
  state.pendingWriteRefs = []
}

export function detectSharedInvitation(input: string): boolean {
  return INVITE_RE.test(input)
}

export function detectSharedInputInvitation(input: string): boolean {
  return INPUT_INVITE_RE.test(input)
}

export function detectSharedEnd(input: string): boolean {
  return END_RE.test(input)
}

export class SharedActivitySession {
  private readonly now: () => number
  private readonly ttlMs: number
  private state: SharedState | null = null

  constructor(options: SharedActivitySessionOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = Math.max(60_000, options.ttlMs ?? SHARED_SESSION_TTL_MS)
  }

  isActive(): boolean {
    this.prune()
    return this.activeState() !== null
  }

  /**
   * 用户入口文字：自然表达“一起…”时建立/更新会话；明确退出则收尾。
   * 任何时候都不会因为这句话授予权限。
   */
  noteUserText(input: string, entry: SharedEntry): SharedUserTextResult {
    this.prune()
    const text = cleanText(input, 220)
    const now = this.now()
    const state = this.activeState()
    if (text === '') {
      return { active: state !== null, started: false, ended: false, paused: state?.paused === true }
    }

    if (state !== null) {
      state.entries.add(entry)
      state.lastUserAt = now
      state.updatedAt = now
      if (END_RE.test(text)) {
        this.end('user-exit')
        return { active: false, started: false, ended: true, paused: false }
      }
      if (PAUSE_RE.test(text)) {
        this.pause('用户要求暂停共同操作')
        return { active: true, started: false, ended: false, paused: true }
      }
      if (state.paused && (RESUME_RE.test(text) || detectSharedInputInvitation(text))) {
        state.paused = false
        state.pauseReason = null
      }
      if (this.isMeaningfulRequest(text)) state.lastUserRequest = text
      if (INVITE_RE.test(text)) {
        // 新邀请可能换了一个目标；目标明显不同则清掉旧目标的观察与步骤，
        // 避免把旧窗口/旧文件的事实带进新任务。
        if (goalChanged(state.goal, text) && hasTargetSpecificState(state)) {
          resetForNewGoal(state, text)
        } else {
          state.goal = text
        }
      }
      // 邀请一旦给出就保持，直到会话结束；后续补充说明不应把权限收回。
      if (detectSharedInputInvitation(text)) state.inputInvited = true
      return { active: true, started: false, ended: false, paused: state.paused }
    }

    if (!INVITE_RE.test(text)) {
      // 用户先明确收尾（如「我自己来」），随后又说「继续吧」：在 TTL 内
      // 接回原来的共同目标与步骤，而不是从零新建一个空会话。
      const ended = this.state
      if (
        REOPEN_RE.test(text) &&
        ended !== null &&
        ended.endedAt !== null &&
        now - ended.endedAt <= this.ttlMs
      ) {
        ended.endedAt = null
        ended.endReason = null
        ended.paused = false
        ended.pauseReason = null
        ended.entries.add(entry)
        ended.lastUserAt = now
        ended.updatedAt = now
        if (this.isMeaningfulRequest(text)) ended.lastUserRequest = text
        if (detectSharedInputInvitation(text)) ended.inputInvited = true
        return { active: true, started: false, ended: false, paused: false }
      }
      return { active: false, started: false, ended: false, paused: false }
    }
    const goal = text.slice(0, 200)
    this.state = {
      id: `shared-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      goal,
      originalGoal: goal,
      lastUserRequest: text,
      targetRef: null,
      targetKind: null,
      targetLabel: null,
      observationVersion: 0,
      lastObservationAt: null,
      interfaceChanged: false,
      lastActor: null,
      facts: [],
      inferences: [],
      completed: [],
      pending: [],
      pendingWriteRefs: [],
      inputInvited: detectSharedInputInvitation(text),
      paused: false,
      pauseReason: null,
      entries: new Set([entry]),
      createdAt: now,
      updatedAt: now,
      lastUserAt: now,
      lastPetAt: null,
      endedAt: null,
      endReason: null
    }
    return { active: true, started: true, ended: false, paused: false }
  }

  /**
   * 真实工具回执（不是调用开始）。只有用户邀请/用户任务里的动作才算“她”
   * 在共同操作；自主探索轮不进入这段会话。
   */
  noteToolResult(
    info: {
      name: string
      source: ToolSource
      taskId?: string
      failed: boolean
      meta?: ToolOutcomeMeta
    },
    options: { taskSource?: string | null } = {}
  ): void {
    this.prune()
    const state = this.activeState()
    if (state === null) return
    const petActed =
      info.source === 'user-chat' ||
      info.source === 'quick-chat' ||
      (info.source === 'task' && options.taskSource !== 'autonomy')
    if (!petActed) return

    const now = this.now()
    state.updatedAt = now
    state.lastPetAt = now
    state.lastActor = 'pet'
    const ref = cleanRef(info.meta?.targetRef)
    const kind = typeof info.meta?.targetKind === 'string' ? info.meta.targetKind : null
    if (ref !== null) {
      state.targetRef = ref
      state.targetKind = kind
      if (kind === 'window' || kind === 'app') state.targetLabel = ref
      else if (state.targetLabel === null) state.targetLabel = null
    }

    if (info.failed) {
      dedupePush(
        state.pending,
        `上一步“${toolLabel(info.name)}”失败；先读取当前状态或向用户说明，不要重复同一失败动作。`,
        MAX_PENDING
      )
      this.addInference(state, `“${toolLabel(info.name)}”没有成功；需要重新确认环境。`, 'plan')
      return
    }

    if (WRITE_TOOLS.has(info.name)) {
      const target = ref === null ? '' : `：${ref}`
      addCompleted(state, `写入了产物${target}`, 'pet', now)
      if (ref !== null) {
        dedupePush(state.pendingWriteRefs, ref, MAX_PENDING_WRITE_REFS)
        dedupePush(state.pending, `回读刚写入的 ${ref}，确认结果真实存在。`, MAX_PENDING)
      } else {
        dedupePush(state.pending, '回读刚写入的产物，确认结果真实存在。', MAX_PENDING)
      }
      this.addInference(state, '产物刚写入，尚未回读验证；不能声称已经完成。', 'plan')
      return
    }

    if (READ_TOOLS.has(info.name)) {
      const label = ref === null ? '' : `：${ref}`
      const matched = ref !== null && state.pendingWriteRefs.includes(ref)
      if (matched && ref !== null) {
        state.pendingWriteRefs = state.pendingWriteRefs.filter((entry) => entry !== ref)
        state.pending = state.pending.filter((entry) => !entry.includes(ref))
        dedupePush(state.facts, `已回读验证写入${label}`, MAX_FACTS)
        addCompleted(state, `回读确认了写入${label}`, 'pet', now)
      } else {
        dedupePush(state.facts, `已用工具读取${label === '' ? '了当前对象' : label}`, MAX_FACTS)
        addCompleted(state, `读取${label === '' ? '当前内容' : label}`, 'pet', now)
      }
      state.observationVersion += 1
      state.lastObservationAt = now
      state.interfaceChanged = false
      state.lastActor = 'pet'
      return
    }

    if (ACTION_TOOLS.has(info.name)) {
      addCompleted(state, `${toolLabel(info.name)}${ref === null ? '' : `：${ref}`}`, 'pet', now)
      dedupePush(state.pending, '检查刚才动作的结果，确认界面符合预期。', MAX_PENDING)
      state.observationVersion += 1
      state.lastObservationAt = now
      state.interfaceChanged = true
      return
    }

    if (PLANNING_TOOLS.has(info.name)) {
      addCompleted(state, toolLabel(info.name), 'pet', now)
      state.interfaceChanged = false
    }
  }

  /**
   * 已脱敏的观察事件。用户侧变化更新目标与观察版本；自身动作只标记归属，
   * 不生成“用户新意图”的评论依据。
   */
  noteActivity(notice: ReactiveEventNotice): void {
    this.prune()
    const state = this.activeState()
    if (state === null) return
    const now = this.now()
    state.updatedAt = now
    const ref = cleanRef(notice.targetRef)
    const label = cleanText(notice.appLabel ?? '', 48)
    if (ref !== null) {
      state.targetRef = ref
      state.targetKind = notice.type.startsWith('desktop')
        ? 'window'
        : notice.type.startsWith('browser')
          ? 'page'
          : 'activity'
    }
    if (label !== '') state.targetLabel = label
    state.observationVersion += 1
    state.lastObservationAt = now
    state.interfaceChanged = true
    state.lastActor = notice.actionAttribution

    if (notice.actionAttribution === 'pet') {
      if (state.lastPetAt === null || now - state.lastPetAt > 12_000) {
        this.addInference(
          state,
          '最近的界面变化来自她自己的操作，不是用户的新意图；不要据此评论或再开一轮自我触发。',
          'pet'
        )
      }
      return
    }

    const change =
      notice.changeType === 'content_change' ||
      notice.changeType === 'page_change' ||
      notice.changeType === 'window_change'
        ? '内容/标题变化'
        : notice.changeType === 'window_open' || notice.changeType === 'page_open'
          ? '出现了新窗口/页面'
          : notice.changeType === 'app_switch'
            ? '前台应用切换'
            : '前台活动变化'
    this.addInference(
      state,
      `用户侧出现${change}${label === '' ? '' : `（${label}）`}；只有事件级证据，正文未核实，下一步应先重新观察。`,
      'activity'
    )
  }

  markInputTakenOver(reason: string): void {
    const state = this.activeState()
    if (state === null) return
    this.pause(reason)
  }

  pause(reason: string, at = this.now()): void {
    this.prune()
    const state = this.activeState()
    if (state === null) return
    state.paused = true
    state.pauseReason = cleanText(reason, 120) || '已暂停'
    state.updatedAt = at
  }

  resume(at = this.now()): void {
    const state = this.activeState()
    if (state === null) return
    state.paused = false
    state.pauseReason = null
    state.updatedAt = at
  }

  end(reason: string, at = this.now()): void {
    const state = this.state
    if (state === null || state.endedAt !== null) return
    state.endedAt = at
    state.endReason = cleanText(reason, 80) || 'ended'
    state.updatedAt = at
  }

  clear(): void {
    this.state = null
  }

  /** 当轮 ephemeral 上下文；未激活/已结束时为 null。 */
  contextText(
    entry: SharedContextEntry,
    lease: SharedLeaseView | null = null
  ): string | null {
    this.prune()
    const state = this.activeState()
    if (state === null) return null
    const now = this.now()
    const age = state.lastObservationAt === null ? 0 : now - state.lastObservationAt
    const lines: string[] = [
      `[共同操作会话] 你正和用户一起处理：${state.goal}`,
      `用户最近明确要求：${state.lastUserRequest}`
    ]
    lines.push(
      state.targetRef === null
        ? '当前共同关注的对象：尚未确认；先用只读观察或对话确认，不要假装已经看到。'
        : `当前共同关注：${state.targetLabel ?? state.targetKind ?? '对象'}（引用 ${state.targetRef}）`
    )
    lines.push(
      state.lastObservationAt === null
        ? '观察版本：还没有本轮的真实观察。'
        : `观察版本：v${state.observationVersion}，最近一次观察在 ${ageText(age)}（来自${actorLabel(state.lastActor)}）。`
    )
    if (state.interfaceChanged) {
      lines.push(
        '界面在上次观察后发生了变化：先重新读取当前窗口/页面，再决定下一步；不要盲目执行旧计划、旧坐标或旧步骤。'
      )
    }
    if (state.facts.length > 0) {
      lines.push('已知事实（已由工具核实）：', ...state.facts.map((fact) => `- ${fact}`))
    } else {
      lines.push('已知事实：尚无本轮工具核实的事实；事件级观察只能当推断。')
    }
    if (state.inferences.length > 0) {
      lines.push('未确认推断：', ...state.inferences.map((entry) => `- ${entry.text}`))
    }
    if (state.completed.length > 0) {
      lines.push(
        '已完成步骤：',
        ...state.completed.slice(-6).map((step) => `- ${ageText(now - step.at)} ${step.text}`)
      )
    }
    if (state.pending.length > 0) {
      lines.push('待确认/下一步：', ...state.pending.map((step) => `- ${step}`))
    }
    lines.push(
      `动作归属：最近界面变化来自${actorLabel(state.lastActor)}` +
        (state.lastActor === 'pet'
          ? '；不要把她自己造成的窗口变化当作用户的新指令，也不要形成自我触发的评论循环。'
          : '。')
    )
    lines.push(
      state.inputInvited
        ? '输入：用户已邀请你动手；仍只能使用已有任务授权、既有应用范围和必要审批，不能扩大范围。'
        : '输入：用户尚未邀请你操作；先观察和对话，除非用户明确让你动手。'
    )
    lines.push(
      state.paused
        ? `状态：已暂停（${state.pauseReason ?? '原因未知'}）。只回应对话，不执行操作；除非用户明确让你继续，不要抢回桌面。`
        : '状态：进行中。'
    )
    if (lease !== null) {
      const holder =
        lease.held && lease.heldBy !== null ? `由 ${lease.heldBy} 持有（${lease.kind ?? '未知'}）` : '空闲'
      lines.push(
        `输入租约：${holder}${lease.userHold ? '；用户接管保持期' : ''}${lease.locked ? '；桌面已锁定/暂停' : ''}。`
      )
    }
    lines.push(
      `这段状态在完整聊天、快捷聊天和桌宠气泡之间共享；想继续时直接接着当前步骤，不要问“我们刚才在做什么”。`
    )
    if (entry === 'core') {
      lines.push(
        '本轮可能是完整聊天、共同任务或后台唤醒：只有用户本轮直接说话/共同任务轮到执行时才接着操作；后台探索不要借这段状态抢占桌面。'
      )
    } else {
      lines.push(`当前入口：${entry === 'chat' ? '完整聊天' : entry === 'quick-chat' ? '快捷聊天' : '桌宠气泡'}。`)
    }
    return lines.join('\n')
  }

  diagnostics(): SharedSessionDiagnostics {
    this.prune()
    const state = this.state
    const active = this.activeState()
    const now = this.now()
    return {
      active: active !== null && active.endedAt === null,
      paused: active?.paused === true,
      inputInvited: active?.inputInvited === true,
      goalChars: active?.goal.length ?? 0,
      observationVersion: active?.observationVersion ?? 0,
      targetKind: active?.targetKind ?? null,
      hasTarget: active !== null && active.targetRef !== null,
      facts: active?.facts.length ?? 0,
      inferences: active?.inferences.length ?? 0,
      completedSteps: active?.completed.length ?? 0,
      pendingSteps: active?.pending.length ?? 0,
      entries: active === null ? [] : [...active.entries],
      lastActor: active?.lastActor ?? null,
      ageMs:
        active === null
          ? 0
          : Math.max(0, now - (state?.lastObservationAt ?? state?.updatedAt ?? now)),
      endedReason: state?.endReason ?? null
    }
  }

  // ------------------------------------------------------------------

  private activeState(): SharedState | null {
    const state = this.state
    if (state === null || state.endedAt !== null) return null
    return state
  }

  private prune(): void {
    const state = this.state
    if (state === null || state.endedAt !== null) return
    if (this.now() - state.updatedAt <= this.ttlMs) return
    state.endedAt = state.updatedAt + this.ttlMs
    state.endReason = 'expired'
  }

  private isMeaningfulRequest(text: string): boolean {
    if (text.length < 2) return false
    if (/^(?:嗯|哦|噢|好|好的|行|对|是|可以|ok|okay|哈哈|好呀|收到|继续|接着来)[。！!,.，\s]*$/i.test(text)) {
      return false
    }
    return true
  }

  private addInference(
    state: SharedState,
    text: string,
    source: InferenceRecord['source']
  ): void {
    const now = this.now()
    const last = state.inferences[state.inferences.length - 1]
    if (last !== undefined && last.source === source && now - last.at < 5_000) {
      last.text = text
      last.at = now
      return
    }
    state.inferences.push({ text, at: now, source })
    while (state.inferences.length > MAX_INFERENCES) state.inferences.shift()
  }
}
