import { existsSync, readFileSync, rmSync } from 'node:fs'
import { atomicWrite, safeJsonParse } from '../../core/util'
import type { ActivityCategory } from '../../worlds/activity/types'

export type RoleplayMood = 'calm' | 'cheerful' | 'playful' | 'concerned' | 'sleepy'

export interface RoleplaySnapshot {
  mood: RoleplayMood
  energy: number
  affinity: number
  lastInteractionAt: number | null
  lastActivityAt: number | null
  lastCategory: ActivityCategory | null
  recentTopics: string[]
}

interface StoredState {
  version: 1
  affinity: number
  lastInteractionAt: number | null
  lastActivityAt: number | null
  lastCategory: ActivityCategory | null
  recentTopics: string[]
}

const TOPIC_LABELS: Partial<Record<ActivityCategory, string>> = {
  editor: '一起写代码',
  terminal: '一起折腾命令行',
  office: '一起处理文档',
  browser: '一起上网找东西',
  media: '一起看视频听歌',
  design: '一起做设计',
  game: '一起打游戏',
  meeting: '一起开会'
}

const MOOD_LABELS: Record<RoleplayMood, string> = {
  calm: '平静',
  cheerful: '心情不错',
  playful: '有点想玩',
  concerned: '有点担心',
  sleepy: '有点困'
}

const MAX_TOPICS = 5

function defaultState(): StoredState {
  return {
    version: 1,
    affinity: 0,
    lastInteractionAt: null,
    lastActivityAt: null,
    lastCategory: null,
    recentTopics: []
  }
}

function clamp01(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function isCategory(value: unknown): value is ActivityCategory {
  return typeof value === 'string' && value in TOPIC_LABELS
}

function sanitize(raw: unknown): StoredState {
  if (typeof raw !== 'object' || raw === null) return defaultState()
  const input = raw as Partial<StoredState>
  return {
    version: 1,
    affinity: typeof input.affinity === 'number' ? clamp01(input.affinity) : 0,
    lastInteractionAt:
      typeof input.lastInteractionAt === 'number' && Number.isFinite(input.lastInteractionAt)
        ? input.lastInteractionAt
        : null,
    lastActivityAt:
      typeof input.lastActivityAt === 'number' && Number.isFinite(input.lastActivityAt)
        ? input.lastActivityAt
        : null,
    lastCategory: isCategory(input.lastCategory) ? input.lastCategory : null,
    recentTopics: Array.isArray(input.recentTopics)
      ? input.recentTopics.filter((item): item is string => typeof item === 'string').slice(0, MAX_TOPICS)
      : []
  }
}

/**
 * 角色的内部状态（PLAN.md §3.1）。只保存抽象类别与互动时间，不保存窗口标题、
 * 进程名、文件路径或聊天内容。状态只影响语气，不参与事实判断。
 */
export class RoleplayState {
  private readonly file: string | null
  private readonly now: () => number
  private stored: StoredState

  constructor(opts: { file?: string | null; now?: () => number } = {}) {
    this.file = opts.file ?? null
    this.now = opts.now ?? Date.now
    this.stored = this.load()
  }

  snapshot(): RoleplaySnapshot {
    const at = this.now()
    return {
      mood: this.moodAt(at),
      energy: Math.round(this.energyAt(at)),
      affinity: Math.round(this.stored.affinity),
      lastInteractionAt: this.stored.lastInteractionAt,
      lastActivityAt: this.stored.lastActivityAt,
      lastCategory: this.stored.lastCategory,
      recentTopics: [...this.stored.recentTopics]
    }
  }

  lastInteractionAt(): number | null {
    return this.stored.lastInteractionAt
  }

  noteInteraction(at = this.now()): void {
    const previous = this.stored.lastInteractionAt
    const gap = previous === null ? Number.POSITIVE_INFINITY : at - previous
    let gain = 0.25
    if (gap >= 12 * 60 * 60_000) gain = 3
    else if (gap >= 60 * 60_000) gain = 1.5
    else if (gap >= 10 * 60_000) gain = 0.75
    this.stored.affinity = clamp01(this.stored.affinity + gain)
    this.stored.lastInteractionAt = at
    this.persist()
  }

  noteActivity(category: ActivityCategory | null, at = this.now()): void {
    if (category === null) return
    const sameCategory = this.stored.lastCategory === category
    const recent = this.stored.lastActivityAt !== null && at - this.stored.lastActivityAt < 5 * 60_000
    if (sameCategory && recent) return
    this.stored.lastCategory = category
    this.stored.lastActivityAt = at
    const label = TOPIC_LABELS[category]
    if (label !== undefined) {
      this.stored.recentTopics = [
        label,
        ...this.stored.recentTopics.filter((item) => item !== label)
      ].slice(0, MAX_TOPICS)
    }
    this.persist()
  }

  clear(): void {
    this.stored = defaultState()
    if (this.file !== null) {
      try {
        rmSync(this.file, { force: true })
      } catch {
        /* 状态只是表现层，清理失败不阻断 */
      }
    }
  }

  /** 注入系统提示的一小段，不让模型看到原始事件或数值细节。 */
  segment(): string {
    const snapshot = this.snapshot()
    const energyWord = snapshot.energy < 35 ? '有点累' : snapshot.energy < 60 ? '一般' : snapshot.energy < 85 ? '还不错' : '很有精神'
    const affinityWord =
      snapshot.affinity < 15
        ? '刚认识不久'
        : snapshot.affinity < 40
          ? '渐渐熟悉'
          : snapshot.affinity < 70
            ? '已经很熟'
            : '很亲近'
    const topics =
      snapshot.recentTopics.length === 0 ? '还没有太多共同经历' : snapshot.recentTopics.join('、')
    return [
      '你此刻的角色状态（只影响语气，不要向用户报数值，也不要用它搪塞问题）：',
      `- 心情：${MOOD_LABELS[snapshot.mood]}；精力：${energyWord}；对用户的熟悉度：${affinityWord}。`,
      `- 最近一起经历过：${topics}。`,
      '- 用户当前说的话永远优先。状态可以让你更像一个住在这里的人，但不能压过事实、工具结果和用户需求。'
    ].join('\n')
  }

  // -------------------------------------------------------------------------

  private load(): StoredState {
    if (this.file === null || !existsSync(this.file)) return defaultState()
    try {
      return sanitize(safeJsonParse(readFileSync(this.file, 'utf8')))
    } catch {
      return defaultState()
    }
  }

  private persist(): void {
    if (this.file === null) return
    try {
      atomicWrite(this.file, `${JSON.stringify(this.stored, null, 2)}\n`)
    } catch {
      /* 状态文件写失败只影响语气，不影响对话 */
    }
  }

  private energyAt(at: number): number {
    const hour = new Date(at).getHours()
    let energy = 82
    if (hour < 6) energy = 48
    else if (hour < 9) energy = 66
    else if (hour >= 23) energy = 56
    else if (hour >= 22) energy = 70
    const last = this.stored.lastInteractionAt
    if (last !== null) {
      const gap = at - last
      if (gap < 5 * 60_000) energy += 6
      else if (gap > 72 * 60 * 60_000) energy -= 20
      else if (gap > 24 * 60 * 60_000) energy -= 10
    }
    return clamp01(energy)
  }

  private moodAt(at: number): RoleplayMood {
    const hour = new Date(at).getHours()
    if (hour >= 23 || hour < 6) return 'sleepy'
    const last = this.stored.lastInteractionAt
    if (last !== null && at - last < 15 * 60_000 && this.stored.affinity >= 20) return 'cheerful'
    const category = this.stored.lastCategory
    const activityRecent =
      this.stored.lastActivityAt !== null && at - this.stored.lastActivityAt < 4 * 60 * 60_000
    if (activityRecent && (category === 'game' || category === 'media')) {
      return 'playful'
    }
    if (activityRecent && category === 'meeting') return 'concerned'
    if (last !== null && at - last > 72 * 60 * 60_000) return 'concerned'
    return 'calm'
  }
}
