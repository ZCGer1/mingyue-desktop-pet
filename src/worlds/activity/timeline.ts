import type { ActivityCategory } from './types'
import { CATEGORY_LABELS } from './types'

/**
 * 内存活动时间线。只保留应用显示名/类别/停留时长，不保存窗口标题、
 * 原始进程名或任何页面内容；进程退出、关闭感知或清空本地数据即消失。
 */
export interface TimelineEntry {
  at: number
  kind: 'app' | 'idle' | 'resume'
  appLabel: string | null
  category: ActivityCategory | null
  /** 该段结束时间；当前仍在进行的段为空。 */
  until?: number
}

export interface TimelineQuery {
  minutes?: number
  limit?: number
}

export class ActivityTimeline {
  private entries: TimelineEntry[] = []
  private minutes: number
  private maxEntries: number
  private readonly now: () => number

  constructor(opts: { minutes: number; maxEntries: number; now?: () => number }) {
    this.minutes = Math.max(1, opts.minutes)
    this.maxEntries = Math.max(1, opts.maxEntries)
    this.now = opts.now ?? (() => Date.now())
  }

  configure(minutes: number, maxEntries: number): void {
    this.minutes = Math.max(1, minutes)
    this.maxEntries = Math.max(1, maxEntries)
    this.prune(this.now())
  }

  pushApp(at: number, appLabel: string | null, category: ActivityCategory | null): void {
    const last = this.entries[this.entries.length - 1]
    if (last !== undefined && last.until === undefined) last.until = at
    this.entries.push({ at, kind: 'app', appLabel, category })
    this.prune(at)
  }

  markIdle(at: number): void {
    const last = this.entries[this.entries.length - 1]
    if (last !== undefined && last.until === undefined) last.until = at
    this.entries.push({ at, kind: 'idle', appLabel: null, category: null })
    this.prune(at)
  }

  markResume(at: number): void {
    const last = this.entries[this.entries.length - 1]
    if (last !== undefined && last.until === undefined) last.until = at
    this.entries.push({ at, kind: 'resume', appLabel: null, category: null })
    this.prune(at)
  }

  /** 进入不可共享的应用（敏感/排除/静音）时关闭当前段，不留下新信息。 */
  closeCurrent(at: number): void {
    const last = this.entries[this.entries.length - 1]
    if (last !== undefined && last.until === undefined) last.until = at
  }

  list(query: TimelineQuery = {}, now = this.now()): TimelineEntry[] {
    this.prune(now)
    const minutes = Math.max(1, Math.min(this.minutes, query.minutes ?? this.minutes))
    const limit = Math.max(1, Math.min(50, query.limit ?? 50))
    const cutoff = now - minutes * 60_000
    return this.entries
      .filter((entry) => entry.at >= cutoff)
      .slice(-limit)
      .map((entry) => ({ ...entry }))
  }

  size(): number {
    this.prune(this.now())
    return this.entries.length
  }

  clear(): void {
    this.entries = []
  }

  private prune(now: number): void {
    const cutoff = now - this.minutes * 60_000
    let index = 0
    while (index < this.entries.length && this.entries[index]!.at < cutoff) index += 1
    if (index > 0) this.entries.splice(0, index)
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries)
    }
  }
}

export function formatTimeline(entries: TimelineEntry[], now: number, maxChars?: number): string {
  if (entries.length === 0) return '最近没有可用的活动记录。'
  const lines = entries.map((entry) => {
    const time = clockLabel(entry.at)
    if (entry.kind === 'idle') return `${time} 空闲`
    if (entry.kind === 'resume') return `${time} 回到电脑前`
    const app = entry.appLabel ?? '未命名应用'
    const category = entry.category === null ? '' : `（${CATEGORY_LABELS[entry.category]}）`
    const end = entry.until ?? now
    const minutes = Math.max(1, Math.round((end - entry.at) / 60_000))
    return `${time} ${app}${category}，停留 ${minutes} 分钟`
  })
  let text = lines.join('\n')
  if (maxChars !== undefined && text.length > maxChars) text = text.slice(0, maxChars)
  return text
}

function clockLabel(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
