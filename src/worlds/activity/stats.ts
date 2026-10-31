import { existsSync, readFileSync } from 'node:fs'
import type { Logger } from '../../core/types'
import { atomicWrite, dateKey, safeJsonParse } from '../../core/util'
import type { ActivityCategory } from './types'

export interface DayStats {
  date: string
  categories: Partial<Record<ActivityCategory, number>>
  switches: number
  idleMinutes: number
  longestFocusMinutes: number
  lateNight: boolean
}

function emptyDay(date: string): DayStats {
  return { date, categories: {}, switches: 0, idleMinutes: 0, longestFocusMinutes: 0, lateNight: false }
}

/**
 * 类别级统计（可选保留）。只保存类别/分钟/切换次数/空闲/深夜标记，
 * 绝不保存进程名。`retentionDays=0` 时只留内存，不落盘。
 */
export class ActivityStats {
  private readonly file: string | null
  private readonly logger: Logger
  private days: Record<string, DayStats> = {}
  private session: DayStats = emptyDay('session')
  private retentionDays: number
  private persistTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(file: string | null, retentionDays: number, logger: Logger) {
    this.file = file
    this.retentionDays = retentionDays
    this.logger = logger
    this.load()
  }

  setRetention(days: number): void {
    this.retentionDays = Math.max(0, Math.floor(days))
    if (this.retentionDays === 0 && this.file !== null && existsSync(this.file)) {
      // 用户关闭保留：删除历史统计（内存中的今日仍可用于工具摘要）。
      try {
        atomicWrite(this.file, JSON.stringify({ version: 1, days: {} }))
        this.days = {}
      } catch {
        /* ignore */
      }
    }
    this.prune()
    this.schedulePersist()
  }

  addActive(category: ActivityCategory, ms: number, at = Date.now()): void {
    if (ms <= 0) return
    const minutes = ms / 60_000
    const day = this.today(at)
    day.categories[category] = (day.categories[category] ?? 0) + minutes
    this.session.categories[category] = (this.session.categories[category] ?? 0) + minutes
    this.touch()
  }

  addIdle(ms: number, at = Date.now()): void {
    if (ms <= 0) return
    const minutes = ms / 60_000
    const day = this.today(at)
    day.idleMinutes += minutes
    this.session.idleMinutes += minutes
    this.touch()
  }

  addSwitch(at = Date.now()): void {
    this.today(at).switches += 1
    this.session.switches += 1
    this.touch()
  }

  noteFocus(minutes: number, at = Date.now()): void {
    if (!Number.isFinite(minutes) || minutes <= 0) return
    const day = this.today(at)
    if (minutes > day.longestFocusMinutes) day.longestFocusMinutes = minutes
    if (minutes > this.session.longestFocusMinutes) this.session.longestFocusMinutes = minutes
    this.touch()
  }

  noteLateNight(at = Date.now()): void {
    this.today(at).lateNight = true
    this.session.lateNight = true
    this.touch()
  }

  /** 今天是否已经打过「首次活动」标记（用于重启后不重复打招呼）。 */
  hasActivityToday(at = Date.now()): boolean {
    const day = this.days[dateKey(at)]
    if (day === undefined) return false
    return Object.keys(day.categories).length > 0 || day.switches > 0
  }

  lateNightSeenToday(at = Date.now()): boolean {
    return this.days[dateKey(at)]?.lateNight === true
  }

  today(now = Date.now()): DayStats {
    const key = dateKey(now)
    let day = this.days[key]
    if (day === undefined) {
      day = emptyDay(key)
      this.days[key] = day
    }
    return day
  }

  sessionSnapshot(): DayStats {
    return {
      ...this.session,
      categories: { ...this.session.categories },
      date: 'session'
    }
  }

  /** 设置页展示用：最近 N 天。 */
  allDays(): DayStats[] {
    return Object.values(this.days).sort((a, b) => a.date.localeCompare(b.date))
  }

  /** 设置页「清除活动统计」：清空内存与磁盘，只保留一个空文件。 */
  clearAll(): void {
    this.days = {}
    this.session = emptyDay('session')
    this.clearTimer()
    this.dirty = false
    if (this.file === null) return
    try {
      atomicWrite(this.file, JSON.stringify({ version: 1, days: {} }, null, 2))
    } catch (error) {
      this.logger.warn('活动统计清除失败', { error: String(error) })
    }
  }

  flush(): void {
    this.clearTimer()
    if (!this.dirty || this.retentionDays <= 0 || this.file === null) return
    this.prune()
    try {
      atomicWrite(this.file, JSON.stringify({ version: 1, days: this.days }, null, 2))
      this.dirty = false
    } catch (error) {
      this.logger.warn('活动统计写入失败', { error: String(error) })
    }
  }

  close(): void {
    this.flush()
    this.clearTimer()
  }

  // -------------------------------------------------------------------------

  private touch(): void {
    this.dirty = true
    this.schedulePersist()
  }

  private schedulePersist(): void {
    if (!this.dirty || this.retentionDays <= 0 || this.file === null) return
    if (this.persistTimer !== null) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.flush()
    }, 30_000)
    this.persistTimer.unref?.()
  }

  private clearTimer(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
  }

  private prune(): void {
    if (this.retentionDays <= 0) return
    const cutoff = Date.now() - this.retentionDays * 86400_000
    const cutoffKey = dateKey(cutoff)
    for (const key of Object.keys(this.days)) {
      if (key < cutoffKey) delete this.days[key]
    }
  }

  private load(): void {
    if (this.file === null || !existsSync(this.file)) return
    try {
      const parsed = safeJsonParse<{ version?: number; days?: Record<string, DayStats> }>(readFileSync(this.file, 'utf8'))
      if (parsed !== undefined && parsed !== null && typeof parsed.days === 'object' && parsed.days !== null) {
        this.days = parsed.days
      }
    } catch (error) {
      this.logger.warn('活动统计文件损坏，已忽略', { error: String(error) })
    }
  }
}
