import type { Bot } from '../bot'
import type { TaskView } from '../core/taskTypes'
import type { RunPhaseState } from '../core/types'
import type { PetActivity, PetAgentStatusView, UiPhaseSnapshot } from '../shared/ipc'
import { turnFailureLabel } from '../shared/turnFailureText'
import type { ClientPhase } from '../worlds/pet/petWorld'

/** 主进程 → 两个渲染界面的状态快照。 */

export function phaseSnapshot(bot: Bot): UiPhaseSnapshot {
  const phase = bot.core.phase
  return {
    phase: phase.phase,
    round: phase.round,
    running: [...phase.running],
    ...(phase.retryAt === undefined ? {} : { retryAt: phase.retryAt }),
    approvalPending: phase.approvalPending,
    busy: bot.isBusy(),
    paused: bot.isPaused(),
    queue: bot.core.eventQueueSize,
    enteredAt: phase.enteredAt
  }
}

/**
 * 桌宠气泡是否可用：页面真实可见且已就绪时，审批/迷你卡才可以只靠气泡提醒。
 * 纯函数便于单测；有窗口对象不等于用户看得到。
 */
export function canShowPetBubble(input: {
  petEnabled: boolean
  petVisible: boolean
  petReady: boolean
}): boolean {
  return input.petEnabled && input.petVisible && input.petReady
}

const LABELS: Record<ClientPhase, string> = {
  idle: '待机中',
  thinking: '正在想…',
  tool: '正在处理…',
  waiting: '稍等一下…',
  asking: '等你确认',
  helper: '来搭把手',
  queued: '稍后重试',
  done: '完成啦',
  /** 没有结构化失败时的最后兜底；正常失败都应带 TurnFailure 说明具体阶段。 */
  failed: '未完成，可查看诊断'
}

/** 只在当轮工具名上做归类，不读取参数或结果正文。 */
const READING_TOOLS: ReadonlySet<string> = new Set([
  'ws_list',
  'ws_read',
  'win_list',
  'win_read',
  'win_capture',
  'page_current',
  'web_fetch',
  'mem_search',
  'mem_read',
  'interest_list',
  'cua_screenshot',
  'cua_zoom',
  'screen_observe',
  'computer_observe',
  'browser_snapshot'
])
const WRITING_TOOLS: ReadonlySet<string> = new Set([
  'ws_write',
  'ws_replace',
  'ws_mkdir',
  'mem_write',
  'interest_create',
  'interest_update'
])

function toolActivity(running: readonly string[]): PetActivity | null {
  if (running.some((name) => WRITING_TOOLS.has(name))) return 'writing'
  if (running.some((name) => READING_TOOLS.has(name))) return 'reading'
  return null
}

/**
 * 从真实运行时状态推导动作；模型无法自报，也不读取任何正文。
 * 这里只返回正在发生的动作（读/写/探索/回看），不返回安静、探索暂停或
 * helper 健康这类长期陪伴模式——那些不属于头顶动作条，设置与诊断里仍可查看。
 */
function deriveActivity(
  bot: Bot,
  paused: boolean,
  task: TaskView | null
): PetActivity {
  if (paused) return 'resting'

  const running = [
    ...bot.quickActivity().running,
    ...bot.core.executor.runningFor('chat'),
    ...bot.core.phase.running
  ]
  const byTool = toolActivity(running)
  const taskActive =
    task !== null && task.state !== 'paused' && task.state !== 'waiting_user' && task.state !== 'blocked'
  if (taskActive) {
    if (byTool !== null) return byTool
    if (task.source === 'autonomy') {
      return bot.isRevisitTask(task.interestId) ? 'revisiting' : 'exploring'
    }
  } else if (byTool !== null) {
    return byTool
  }

  return 'idle'
}

export function petStatus(bot: Bot, paused: boolean): PetAgentStatusView {
  const presentation = bot.petWorld.currentPresentation()
  const quick = bot.quickActivity()
  const cuaActive = quick.cua || bot.core.executor.hasRunningCua('chat')
  const cuaLabel =
    cuaActive
      ? [...quick.running, ...bot.core.executor.runningFor('chat')].some(
          (name) =>
            name === 'cua_screenshot' ||
            name === 'cua_zoom' ||
            name === 'screen_observe'
        )
        ? '正在看屏幕…'
        : '正在操作…'
      : null
  const quickRequests = bot.gate.list('quick')
  const chatRequests = bot.gate.list('chat')
  const quickPending = quickRequests.length > 0
  const chatPending = chatRequests.length > 0
  const approvalPending = presentation.approvalPending || quickPending || chatPending
  // 沿用快捷优先；同来源由 ApprovalGate.list 按 createdAt 升序返回。
  const primaryApproval = quickRequests[0] ?? chatRequests[0] ?? null
  const approvalOrigin = primaryApproval?.origin ?? null
  const activeTaskId = bot.tasks.activeTaskId()
  const activeTask = activeTaskId === null ? null : bot.taskView(activeTaskId)
  const corePhase = bot.core.phase
  const failure = bot.currentTurnFailure()
  const botBusy = bot.isBusy()
  // 后台 reaction 与无输出的自主轮不应在头顶冒充用户任务；审批、CUA 与失败仍要出现。
  const urgent = approvalPending || cuaActive
  const reactionMuted =
    corePhase.reaction === true && !urgent && presentation.phase !== 'failed'
  const silentIdle =
    corePhase.phase === 'idle' &&
    corePhase.silentEnd === true &&
    !urgent &&
    presentation.phase !== 'failed'
  const muted = reactionMuted || silentIdle
  // finishCycle 内 Core.running 仍为 true；必须同时排掉它，否则最后一条广播会留下忙碌。
  const busy = muted
    ? false
    : bot.petWorld.isAgentBusy() || botBusy || bot.gate.pendingCount > 0 || cuaActive
  let petPhase = muted ? 'idle' : presentation.phase
  if (cuaActive && !approvalPending && !paused) petPhase = 'helper'
  // 具体失败类型优先于兜底提示；审批/CUA/暂停仍优先，
  // 因为它们是当下必须处理的动作。
  let label = failure === null ? LABELS[petPhase] : turnFailureLabel(failure)
  if (paused) label = '已暂停'
  else if (approvalPending) label = '等你确认'
  else if (cuaLabel !== null) label = cuaLabel
  const taskSummary =
    activeTask === null
      ? null
      : { id: activeTask.id, title: activeTask.title, state: activeTask.state }
  return {
    label,
    activity: deriveActivity(bot, paused, activeTask),
    phase: reactionMuted ? 'idle' : corePhase.phase,
    petPhase,
    source: corePhase.source ?? null,
    approvalPending,
    approvalOrigin,
    approvalId: primaryApproval?.id ?? null,
    approvalAsk: primaryApproval?.approvalAsk ?? null,
    cuaActive,
    cuaLabel,
    busy,
    paused,
    round: presentation.round,
    failure,
    task: taskSummary
  }
}

/** Core 相位 → 参考客户端的宠物相位（与 PetWorld 的映射保持一致）。 */
export function clientPhaseFor(
  phase: RunPhaseState['phase'],
  approvalPending: boolean
): ClientPhase {
  switch (phase) {
    case 'delivering':
    case 'model':
    case 'handoff':
      return 'thinking'
    case 'tools':
      return approvalPending ? 'asking' : 'tool'
    case 'backoff':
      return 'queued'
    default:
      return 'idle'
  }
}
