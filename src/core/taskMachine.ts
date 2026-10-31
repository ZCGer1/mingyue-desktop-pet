import {
  isTerminalTaskState,
  type TaskCheckpointStep,
  type TaskRecord,
  type TaskState
} from './taskTypes'

/**
 * 纯任务状态机。TaskRunner 负责持久化、预算与 generation，这里只做状态迁移。
 * 非法迁移原样返回，调用方据此判断是否真的发生了变化。
 */

export type TaskEvent =
  | { type: 'start'; at: number }
  | {
      type: 'checkpoint'
      at: number
      text: string
      steps?: TaskCheckpointStep[]
      lastTool?: string | null
    }
  | { type: 'complete'; at: number; result: string; evidence: string }
  | { type: 'fail'; at: number; error: string }
  | { type: 'block'; at: number; reason: string }
  | { type: 'wait_user'; at: number; reason: string }
  | { type: 'pause'; at: number }
  | { type: 'resume'; at: number }
  /** 重启恢复：从进行中的状态回到 queued，并让迟到回调失效。 */
  | { type: 'requeue'; at: number }
  | { type: 'cancel'; at: number; reason?: string }
  | { type: 'approval_wait'; at: number; approvalId: string }
  | { type: 'approval_resolved'; at: number; approved: boolean }

const ACTIVE: ReadonlySet<TaskState> = new Set([
  'queued',
  'observing',
  'planning',
  'running',
  'waiting_approval',
  'waiting_user',
  'paused',
  'blocked'
])

function transition(task: TaskRecord, patch: Partial<TaskRecord>, at: number): TaskRecord {
  return {
    ...task,
    ...patch,
    revision: task.revision + 1,
    updatedAt: at
  }
}

function bump(task: TaskRecord, patch: Partial<TaskRecord>, at: number): TaskRecord {
  return transition(task, { ...patch, generation: task.generation + 1 }, at)
}

export function reduceTask(task: TaskRecord, event: TaskEvent): TaskRecord {
  if (isTerminalTaskState(task.state)) return task

  switch (event.type) {
    case 'start':
      if (task.state !== 'queued') return task
      return transition(
        task,
        {
          state: 'planning',
          waitReason: null,
          lastError: null
        },
        event.at
      )
    case 'checkpoint':
      if (task.state !== 'planning' && task.state !== 'running' && task.state !== 'waiting_user') {
        return task
      }
      return transition(
        task,
        {
          checkpoint: {
            v: 2,
            summary: event.text.slice(0, 2000),
            steps: (event.steps ?? []).slice(-20).map((step) => ({
              at: step.at,
              tool: step.tool.slice(0, 80),
              targetRef: step.targetRef
            })),
            lastTool: event.lastTool ?? null
          }
        },
        event.at
      )
    case 'complete':
      if (
        task.state !== 'planning' &&
        task.state !== 'running' &&
        task.state !== 'observing' &&
        task.state !== 'waiting_user'
      ) {
        return task
      }
      return transition(
        task,
        {
          state: 'completed',
          endedAt: event.at,
          result: event.result.slice(0, 2000),
          evidence: event.evidence.slice(0, 2000),
          waitReason: null,
          lastError: null
        },
        event.at
      )
    case 'fail':
      return transition(
        task,
        {
          state: 'failed',
          endedAt: event.at,
          lastError: event.error.slice(0, 500),
          waitReason: null
        },
        event.at
      )
    case 'block':
      return transition(
        task,
        {
          state: 'blocked',
          endedAt: event.at,
          waitReason: event.reason.slice(0, 500)
        },
        event.at
      )
    case 'wait_user':
      return transition(
        task,
        {
          state: 'waiting_user',
          waitReason: event.reason.slice(0, 500)
        },
        event.at
      )
    case 'pause':
      if (!ACTIVE.has(task.state) || task.state === 'paused') return task
      return bump(
        task,
        {
          state: 'paused',
          waitReason: '已由用户暂停'
        },
        event.at
      )
    case 'resume':
      if (task.state !== 'paused' && task.state !== 'waiting_user' && task.state !== 'blocked') {
        return task
      }
      return bump(
        task,
        {
          state: 'queued',
          endedAt: null,
          waitReason: null,
          lastError: null
        },
        event.at
      )
    case 'requeue':
      // 只允许把真正“还没结束”的状态放回队列；排队/等待用户等状态
      // 由各自的恢复规则处理，避免一次重启把用户暂停的任务抢回。
      if (
        task.state !== 'planning' &&
        task.state !== 'running' &&
        task.state !== 'observing'
      ) {
        return task
      }
      return bump(
        task,
        {
          state: 'queued',
          scheduledAt: null,
          alarmId: null,
          endedAt: null,
          pendingApprovalId: null,
          waitReason: null,
          lastError: null
        },
        event.at
      )
    case 'cancel':
      if (!ACTIVE.has(task.state)) return task
      return bump(
        task,
        {
          state: 'cancelled',
          endedAt: event.at,
          waitReason: event.reason?.slice(0, 500) ?? '已由用户取消'
        },
        event.at
      )
    case 'approval_wait':
      if (task.state !== 'running') return task
      return transition(
        task,
        {
          state: 'waiting_approval',
          pendingApprovalId: event.approvalId
        },
        event.at
      )
    case 'approval_resolved':
      if (task.state !== 'waiting_approval') return task
      if (event.approved) {
        return transition(task, { state: 'running', pendingApprovalId: null }, event.at)
      }
      return bump(
        task,
        {
          state: 'waiting_user',
          pendingApprovalId: null,
          waitReason: '用户拒绝了这次操作，任务已停下'
        },
        event.at
      )
  }
}

/** TaskRunner 的接管/撤销需要让所有迟到回调失效。 */
export function bumpGeneration(task: TaskRecord, at: number): TaskRecord {
  return bump(task, {}, at)
}
