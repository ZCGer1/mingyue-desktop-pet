import { safeEvidence } from './taskEvidence'
import { existsSync, readFileSync, copyFileSync } from 'node:fs'
import type { Logger } from './types'
import type {
  TaskCheckpoint,
  TaskCheckpointStep,
  TaskRecord,
  TaskState
} from './taskTypes'
import { isTerminalTaskState, TASK_STATES } from './taskTypes'
import { atomicWrite, safeJsonParse } from './util'

const SCHEMA_VERSION = 3
const MAX_TASKS = 200
const MAX_STEPS = 200

interface TaskFile {
  schemaVersion: number
  tasks: TaskRecord[]
}

export interface TaskStoreOptions {
  file: string
  logger: Logger
}

/**
 * `data/tasks.json` 的原子读写。
 *
 * 只保存任务元数据与脱敏步骤摘要；截图、输入文字、窗口标题、页面正文
 * 都不允许进入这里。WAL 的 intent/done/unknown 也落在同一份记录里。
 */
export class TaskStore {
  private readonly file: string
  private readonly logger: Logger
  private tasks: TaskRecord[] = []
  private readonly listeners = new Set<(tasks: TaskRecord[]) => void>()

  constructor(options: TaskStoreOptions) {
    this.file = options.file
    this.logger = options.logger
    this.load()
  }

  list(): TaskRecord[] {
    return this.tasks.map(cloneTask)
  }

  get(id: string): TaskRecord | undefined {
    const task = this.tasks.find((entry) => entry.id === id)
    return task === undefined ? undefined : cloneTask(task)
  }

  /** 写入一份完整任务记录；不存在时新增。 */
  save(task: TaskRecord, notify = true): void {
    const normalized: TaskRecord = {
      ...cloneTask(task),
      steps: task.steps.slice(-MAX_STEPS)
    }
    const index = this.tasks.findIndex((entry) => entry.id === task.id)
    if (index === -1) {
      if (this.tasks.length >= MAX_TASKS) {
        throw new Error(`任务数量已达上限（${MAX_TASKS}）；请先清理已完成任务。`)
      }
      this.tasks.push(normalized)
    } else {
      this.tasks[index] = normalized
    }
    this.persist()
    if (notify) this.notify()
  }

  remove(id: string): boolean {
    const before = this.tasks.length
    this.tasks = this.tasks.filter((task) => task.id !== id)
    if (this.tasks.length === before) return false
    this.persist()
    this.notify()
    return true
  }

  /** 删除超过保留期的终态任务。 */
  prune(now: number, retentionDays: number): number {
    const cutoff = now - Math.max(1, retentionDays) * 24 * 60 * 60_000
    const before = this.tasks.length
    this.tasks = this.tasks.filter((task) => {
      if (!isTerminalTaskState(task.state)) return true
      const ended = task.endedAt ?? task.updatedAt
      return ended > cutoff
    })
    const removed = before - this.tasks.length
    if (removed > 0) {
      this.persist()
      this.notify()
    }
    return removed
  }

  clear(): void {
    this.tasks = []
    this.persist()
    this.notify()
  }

  onChange(listener: (tasks: TaskRecord[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    const snapshot = this.list()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.logger.warn('任务监听器异常', { error: String(error) })
      }
    }
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const parsed = safeJsonParse<TaskFile>(readFileSync(this.file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
        this.logger.warn('任务文件结构无效，已忽略')
        return
      }
      if (parsed.schemaVersion < SCHEMA_VERSION) copyFileSync(this.file, this.file + '.bak-' + Date.now())
      const tasks: TaskRecord[] = []
      for (const item of parsed.tasks) {
        const task = parseTask(item)
        if (task === null) {
          this.logger.warn('任务记录损坏，已跳过')
          continue
        }
        tasks.push(parsed.schemaVersion < SCHEMA_VERSION ? { ...task, legacyEvidence: true } : task)
        if (tasks.length >= MAX_TASKS) break
      }
      this.tasks = tasks
    } catch {
      this.logger.warn('任务文件损坏，已忽略')
    }
  }

  private persist(): void {
    try {
      const payload: TaskFile = { schemaVersion: SCHEMA_VERSION, tasks: this.tasks }
      atomicWrite(this.file, `${JSON.stringify(payload, null, 2)}\n`)
    } catch (error) {
      this.logger.error('任务保存失败', { error: String(error).slice(0, 200) })
    }
  }
}

function cloneTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    capabilities: [...task.capabilities],
    grantIds: [...task.grantIds],
    budget: { ...task.budget },
    usage: { ...task.usage },
    checkpoint:
      task.checkpoint === null
        ? null
        : task.checkpoint.v === 1
          ? { ...task.checkpoint }
          : {
              ...task.checkpoint,
              steps: task.checkpoint.steps.map((step) => ({ ...step }))
            },
    steps: task.steps.map((step) => ({ ...step }))
  }
}

function parseTask(raw: unknown): TaskRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (typeof record['id'] !== 'string' || record['id'] === '') return null
  if (typeof record['title'] !== 'string') return null
  const state = record['state']
  if (typeof state !== 'string' || !(TASK_STATES as readonly string[]).includes(state)) return null
  const source =
    record['source'] === 'quick-chat'
      ? 'quick-chat'
      : record['source'] === 'autonomy'
        ? 'autonomy'
        : 'user-chat'
  const steps = Array.isArray(record['steps'])
    ? record['steps']
        .map(parseStep)
        .filter((step): step is TaskRecord['steps'][number] => step !== null)
        .slice(-MAX_STEPS)
    : []
  return {
    id: record['id'],
    title: record['title'].slice(0, 120),
    intent: typeof record['intent'] === 'string' ? record['intent'].slice(0, 2000) : '',
    source,
    interestId: parseOpaqueId(record['interestId']),
    state: state as TaskState,
    revision: numberOr(record['revision'], 1),
    generation: numberOr(record['generation'], 0),
    createdAt: numberOr(record['createdAt'], 0),
    updatedAt: numberOr(record['updatedAt'], 0),
    scheduledAt: nullableNumber(record['scheduledAt']),
    startedAt: nullableNumber(record['startedAt']),
    endedAt: nullableNumber(record['endedAt']),
    capabilities: Array.isArray(record['capabilities'])
      ? record['capabilities'].filter((entry): entry is TaskRecord['capabilities'][number] =>
          typeof entry === 'string'
        )
      : [],
    grantIds: Array.isArray(record['grantIds'])
      ? record['grantIds'].filter((entry): entry is string => typeof entry === 'string')
      : [],
    budget: {
      maxMinutes: numberOr((record['budget'] as Record<string, unknown> | null)?.['maxMinutes'], 15),
      maxToolCalls: numberOr(
        (record['budget'] as Record<string, unknown> | null)?.['maxToolCalls'],
        40
      )
    },
    usage: {
      toolCalls: numberOr((record['usage'] as Record<string, unknown> | null)?.['toolCalls'], 0),
      modelCycles: numberOr(
        (record['usage'] as Record<string, unknown> | null)?.['modelCycles'],
        0
      ),
      startedAt: nullableNumber(
        (record['usage'] as Record<string, unknown> | null)?.['startedAt']
      )
    },
    checkpoint: parseCheckpoint(record['checkpoint']),
    steps,
    alarmId: typeof record['alarmId'] === 'string' ? record['alarmId'] : null,
    pendingApprovalId:
      typeof record['pendingApprovalId'] === 'string' ? record['pendingApprovalId'] : null,
    waitReason: typeof record['waitReason'] === 'string' ? record['waitReason'].slice(0, 500) : null,
    lastError: typeof record['lastError'] === 'string' ? record['lastError'].slice(0, 500) : null,
    result: typeof record['result'] === 'string' ? record['result'].slice(0, 2000) : null,
    legacyEvidence: record['legacyEvidence'] === true,
    ...(['observed','visual','deterministic','user-confirmed'].includes(String(record['evidenceLevel'])) ? { evidenceLevel: record['evidenceLevel'] as import('./taskEvidence').EvidenceLevel } : {}),
    evidence: typeof record['evidence'] === 'string' ? record['evidence'].slice(0, 2000) : null
  }
}

function parseStep(raw: unknown): TaskRecord['steps'][number] | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record['tool'] !== 'string') return null
  const status = record['status']
  if (status !== 'intent' && status !== 'done' && status !== 'failed' && status !== 'unknown') {
    return null
  }
  return {
    id: typeof record['id'] === 'string' ? record['id'] : '',
    callId: typeof record['callId'] === 'string' ? record['callId'] : '',
    at: numberOr(record['at'], 0),
    kind: record['kind'] === 'checkpoint' ? 'checkpoint' : 'tool',
    tool: record['tool'].slice(0, 80),
    status,
    sideEffect: record['sideEffect'] === true,
    verify: record['verify'] === true,
    summary: typeof record['summary'] === 'string' ? record['summary'].slice(0, 200) : '',
    ...safeEvidence(record),
    targetRef: safeTargetRef(record['targetRef'])
  }
}

/** 旧 schema 的纯字符串进度升级为 v1；v2 解析失败时退回 v1 摘要。 */
function parseCheckpoint(raw: unknown): TaskCheckpoint | null {
  if (typeof raw === 'string') return { v: 1, summary: raw.slice(0, 2000) }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const summary = typeof record['summary'] === 'string' ? record['summary'].slice(0, 2000) : ''
  if (summary === '') return null
  if (record['v'] !== 2) return { v: 1, summary }
  const steps: TaskCheckpointStep[] = Array.isArray(record['steps'])
    ? record['steps']
        .map((item): TaskCheckpointStep | null => {
          if (item === null || typeof item !== 'object') return null
          const step = item as Record<string, unknown>
          if (typeof step['tool'] !== 'string') return null
          return {
            at: numberOr(step['at'], 0),
            tool: step['tool'].slice(0, 80),
            targetRef: safeTargetRef(step['targetRef'])
          }
        })
        .filter((step): step is TaskCheckpointStep => step !== null)
        .slice(-20)
    : []
  const lastTool =
    typeof record['lastTool'] === 'string' ? record['lastTool'].slice(0, 80) : null
  return { v: 2, summary, steps, lastTool }
}

function parseOpaqueId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null
}

/**
 * 相对路径/域名/应用标签；绝对路径、UNC、协议与 Windows 盘符一律丢弃。
 * 任务 WAL 只保存这些安全短引用。
 */
function safeTargetRef(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/[\r\n\t]/g, ' ')
  if (text === '' || text.length > 120) return null
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/') || text.startsWith('\\\\')) return null
  if (/^(?:https?|file|javascript):/i.test(text)) return null
  if (text.includes('..')) return null
  return text.slice(0, 120)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
