import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Logger, TimerApi } from './types'
import { atomicWrite, isoNow, safeJsonParse } from './util'

export interface TimerRecord {
  id: string
  at: string
  note: string
  kind: string
  repeat?: 'daily'
  /** kind === 'task'：到点后交给 TaskRunner，不投递普通 timer.due。 */
  taskId?: string
  taskGeneration?: number
}

/**
 * 跨重启定时器（PLAN.md §2.6）。用于提醒，不用于活动检测。
 */
export class Timers implements TimerApi {
  private readonly file: string
  private readonly onDue: (record: TimerRecord) => void
  private readonly logger: Logger
  private records: TimerRecord[] = []
  private handles = new Map<string, NodeJS.Timeout>()

  constructor(file: string, onDue: (record: TimerRecord) => void, logger: Logger) {
    this.file = file
    this.onDue = onDue
    this.logger = logger
    if (existsSync(file)) {
      try {
        const parsed = safeJsonParse<TimerRecord[]>(readFileSync(file, 'utf8'))
        if (Array.isArray(parsed)) {
          this.records = parsed.filter(
            (item) => item !== null && typeof item === 'object' && typeof item.id === 'string' && typeof item.at === 'string'
          )
        }
      } catch {
        this.logger.warn('定时器文件损坏，已忽略')
      }
    }
  }

  /** 启动后恢复；到期回调在 start 返回后的下一个 tick 触发。 */
  start(): void {
    for (const record of [...this.records]) this.schedule(record)
  }

  stop(): void {
    for (const handle of this.handles.values()) clearTimeout(handle)
    this.handles.clear()
  }

  set(
    atIso: string,
    payload: {
      note: string
      kind: string
      repeat?: 'daily'
      taskId?: string
      taskGeneration?: number
    }
  ): string {
    const at = new Date(atIso).getTime()
    if (!Number.isFinite(at)) throw new Error('无效的提醒时间')
    if (payload.repeat === 'daily' && payload.taskId !== undefined) {
      throw new Error('任务定时器不能设为每日重复')
    }
    const record: TimerRecord = {
      id: randomUUID(),
      at: new Date(at).toISOString(),
      note: payload.note.slice(0, 200),
      kind: payload.kind,
      ...(payload.repeat === 'daily' ? { repeat: 'daily' as const } : {}),
      ...(payload.taskId === undefined ? {} : { taskId: payload.taskId }),
      ...(payload.taskGeneration === undefined
        ? {}
        : { taskGeneration: payload.taskGeneration })
    }
    this.records.push(record)
    this.persist()
    this.schedule(record)
    return record.id
  }

  cancel(id: string): boolean {
    const index = this.records.findIndex((record) => record.id === id)
    if (index === -1) return false
    this.records.splice(index, 1)
    const handle = this.handles.get(id)
    if (handle !== undefined) clearTimeout(handle)
    this.handles.delete(id)
    this.persist()
    return true
  }

  list(): Array<{
    id: string
    at: string
    note: string
    kind: string
    repeat?: 'daily'
    taskId?: string
    taskGeneration?: number
  }> {
    return this.records.map((record) => ({ ...record })).sort((a, b) => a.at.localeCompare(b.at))
  }

  clear(): void {
    this.stop()
    this.records = []
    this.persist()
  }

  private schedule(record: TimerRecord): void {
    const existing = this.handles.get(record.id)
    if (existing !== undefined) clearTimeout(existing)
    const dueAt = new Date(record.at).getTime()
    const delay = Math.max(0, dueAt - Date.now())
    const handle = setTimeout(() => {
      this.handles.delete(record.id)
      if (record.repeat === 'daily') {
        // 先按到期时刻投递一次（重启后过期的每日闹钟也只补投一次），
        // 再把这个 id 重排到下一个未来的同一本地时刻。
        const fired: TimerRecord = { ...record }
        record.at = new Date(nextDailyAfter(dueAt, Date.now())).toISOString()
        this.persist()
        this.schedule(record)
        try {
          this.onDue(fired)
        } catch (error) {
          this.logger.error('定时器回调失败', { id: record.id, error: String(error) })
        }
        return
      }
      this.records = this.records.filter((item) => item.id !== record.id)
      this.persist()
      try {
        this.onDue(record)
      } catch (error) {
        this.logger.error('定时器回调失败', { id: record.id, error: String(error) })
      }
    }, delay)
    handle.unref?.()
    this.handles.set(record.id, handle)
  }

  private persist(): void {
    try {
      atomicWrite(this.file, JSON.stringify(this.records, null, 2))
    } catch (error) {
      this.logger.warn('定时器保存失败', { error: String(error), at: isoNow() })
    }
  }
}

/** 从到期时刻起找下一个严格晚于 now 的同一本地时刻。 */
function nextDailyAfter(dueAt: number, now: number): number {
  const candidate = new Date(dueAt)
  while (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}
