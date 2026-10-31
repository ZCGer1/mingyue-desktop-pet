import type { EvidenceFields, EvidenceLevel } from '../shared/taskEvidence'
import type { CapabilityId } from './capabilityTypes'

/** 任务状态机（PLAN.md §8）。P1 打通主路径，P3 补全恢复边界。 */
export type TaskState =
  | 'queued'
  | 'observing'
  | 'planning'
  | 'running'
  | 'waiting_approval'
  | 'waiting_user'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const TASK_STATES: readonly TaskState[] = [
  'queued',
  'observing',
  'planning',
  'running',
  'waiting_approval',
  'waiting_user',
  'paused',
  'blocked',
  'completed',
  'failed',
  'cancelled'
]

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'completed',
  'failed',
  'cancelled'
])

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state)
}

/** 任务来源：用户完整聊天、快捷聊天，或她在 explore 模式下自建的小目标。 */
export type TaskSource = 'user-chat' | 'quick-chat' | 'autonomy'

export type TaskStepStatus = 'intent' | 'done' | 'failed' | 'unknown'

export interface TaskStep extends EvidenceFields {
  id: string
  callId: string
  at: number
  kind: 'tool' | 'checkpoint'
  tool: string
  status: TaskStepStatus
  sideEffect: boolean
  verify: boolean
  /** 脱敏摘要：工具名/结果码，不含输入文字、截图或窗口标题。 */
  summary: string
  /** 相对路径/域名/应用标签；绝无绝对路径或窗口标题。 */
  targetRef: string | null
}

export interface TaskCheckpointStep {
  at: number
  tool: string
  targetRef: string | null
}

/**
 * 结构化进度。v1 只来自旧任务的纯字符串，v2 才有可恢复的步骤摘要。
 * steps 只存工具名与相对引用，不存标题、正文或输入文字。
 */
export type TaskCheckpoint =
  | { v: 1; summary: string }
  | {
      v: 2
      summary: string
      steps: TaskCheckpointStep[]
      lastTool: string | null
    }

export function checkpointSummary(checkpoint: TaskCheckpoint | null): string | null {
  return checkpoint === null ? null : checkpoint.summary
}

export interface TaskBudget {
  maxMinutes: number
  maxToolCalls: number
}

export interface TaskUsage {
  toolCalls: number
  modelCycles: number
  /** 本任务累计发起过多少次完整 Core 轮次。 */
  startedAt: number | null
}

export interface TaskRecord {
  id: string
  title: string
  intent: string
  source: TaskSource
  /** 关联的活跃兴趣；只影响提示与成果归档，不授予任何权限。 */
  interestId: string | null
  state: TaskState
  revision: number
  /** 取消/暂停/接管时递增；迟到回调必须核对。 */
  generation: number
  createdAt: number
  updatedAt: number
  scheduledAt: number | null
  startedAt: number | null
  endedAt: number | null
  capabilities: CapabilityId[]
  grantIds: string[]
  budget: TaskBudget
  usage: TaskUsage
  checkpoint: TaskCheckpoint | null
  steps: TaskStep[]
  alarmId: string | null
  pendingApprovalId: string | null
  waitReason: string | null
  lastError: string | null
  result: string | null
  legacyEvidence?: boolean
  evidenceLevel?: EvidenceLevel
  evidence: string | null
}

/** 渲染进程/诊断可见的脱敏任务视图。 */
export interface TaskView {
  id: string
  title: string
  intent: string
  state: TaskState
  source: TaskSource
  interestId: string | null
  generation: number
  createdAt: number
  updatedAt: number
  scheduledAt: number | null
  startedAt: number | null
  endedAt: number | null
  capabilities: CapabilityId[]
  toolCalls: number
  maxToolCalls: number
  maxMinutes: number
  checkpoint: string | null
  waitReason: string | null
  lastError: string | null
  result: string | null
  legacyEvidence?: boolean
  evidenceLevel?: EvidenceLevel
  evidence: string | null
  steps: Array<{
    at: number
    tool: string
    status: TaskStepStatus
    sideEffect: boolean
    verify: boolean
    summary: string
  }>
}

export function toTaskView(task: TaskRecord): TaskView {
  return {
    id: task.id,
    title: task.title,
    intent: task.intent,
    state: task.state,
    source: task.source,
    interestId: task.interestId,
    generation: task.generation,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    scheduledAt: task.scheduledAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    capabilities: [...task.capabilities],
    toolCalls: task.usage.toolCalls,
    maxToolCalls: task.budget.maxToolCalls,
    maxMinutes: task.budget.maxMinutes,
    checkpoint: checkpointSummary(task.checkpoint),
    waitReason: task.waitReason,
    lastError: task.lastError,
    result: task.result,
    evidence: task.evidence,
    ...(task.evidenceLevel === undefined ? {} : { evidenceLevel: task.evidenceLevel }),
    steps: task.steps.map((step) => ({
      at: step.at,
      tool: step.tool,
      status: step.status,
      sideEffect: step.sideEffect,
      verify: step.verify,
      summary: step.summary
    }))
  }
}
