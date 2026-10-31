import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { Logger } from '../../core/types'
import { atomicWrite, safeJsonParse } from '../../core/util'
import {
  safeCompanionText,
  safeNoteArtifact,
  safeTargetRef,
  safeToolName,
  type CompanionTargetKind
} from './sanitize'

export type ExperienceKind = 'observe' | 'read' | 'write' | 'chat' | 'task'
export type ExperienceTargetKind = CompanionTargetKind

const KINDS: readonly ExperienceKind[] = ['observe', 'read', 'write', 'chat', 'task']
const TARGET_KINDS: readonly ExperienceTargetKind[] = [
  'file',
  'window',
  'page',
  'web',
  'note',
  'app'
]

export const EXPERIENCE_SUMMARY_MAX = 240
export const EXPERIENCE_DEDUPE_MS = 10 * 60_000

export interface ExperienceRecord {
  id: string
  at: number
  kind: ExperienceKind
  summary: string
  tool: string
  targetKind: ExperienceTargetKind
  targetRef: string | null
  taskId: string | null
  interestId: string | null
  artifact: string | null
  expiresAt: number
}

export interface ExperienceLimits {
  retentionDays: number
  maxRecords: number
}

export interface RecordExperienceInput {
  kind: ExperienceKind
  summary: string
  tool: string
  targetKind: ExperienceTargetKind
  targetRef?: string | null
  taskId?: string | null
  interestId?: string | null
  artifact?: string | null
  at?: number
}

export interface ExperienceMutationResult {
  ok: boolean
  message: string
  code?: 'MEMORY_OFF' | 'EXPERIENCE_INVALID'
  record?: ExperienceRecord
}

export interface ExperienceStoreOptions {
  file: string
  enabled: () => boolean
  limits: () => ExperienceLimits
  now?: () => number
  logger?: Logger
  onChange?: () => void
}

interface PersistedExperiences {
  version: 1
  records: ExperienceRecord[]
}

/**
 * 她真实做过/看到过什么的短摘要。只由运行时工具结果/任务结果写入，
 * 模型不能直接写任意经历；绝对路径、窗口标题原文与正文永不落盘。
 */
export class ExperienceStore {
  private readonly file: string
  private readonly enabled: () => boolean
  private readonly limits: () => ExperienceLimits
  private readonly now: () => number
  private readonly logger: Logger | undefined
  private readonly onChange: (() => void) | undefined
  private records: ExperienceRecord[]

  constructor(options: ExperienceStoreOptions) {
    this.file = options.file
    this.enabled = options.enabled
    this.limits = options.limits
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
    this.onChange = options.onChange
    this.records = this.load()
    this.prune(this.now())
  }

  isEnabled(): boolean {
    return this.enabled()
  }

  record(input: RecordExperienceInput): ExperienceMutationResult {
    if (!this.enabled()) {
      return { ok: false, code: 'MEMORY_OFF', message: '记忆功能已关闭，经历不会保存' }
    }
    const at = input.at ?? this.now()
    this.prune(at)
    const summary = safeCompanionText(input.summary, EXPERIENCE_SUMMARY_MAX)
    if (summary === '') {
      return { ok: false, code: 'EXPERIENCE_INVALID', message: '经历摘要为空或不可用' }
    }
    const targetKind = TARGET_KINDS.includes(input.targetKind) ? input.targetKind : 'file'
    const tool = safeToolName(input.tool) ?? 'unknown'
    const targetRef = safeTargetRef(targetKind, input.targetRef ?? null)
    const taskId = safeOpaqueId(input.taskId)
    const interestId = safeOpaqueId(input.interestId)
    const artifact = safeNoteArtifact(input.artifact ?? null)
    const limits = this.clampedLimits()
    const expiresAt = at + limits.retentionDays * 24 * 60 * 60_000

    // 同一任务/工具/目标在 10 分钟内合并，避免一次任务刷出几十条重复经历。
    const existing = this.records.find(
      (record) =>
        record.taskId === taskId &&
        record.tool === tool &&
        record.targetRef === targetRef &&
        at - record.at <= EXPERIENCE_DEDUPE_MS
    )
    if (existing !== undefined) {
      // 保留首次发生时间作为去重基准；只更新摘要与保留期，
      // 避免同一任务的连续读取把 10 分钟窗口无限滑动。
      existing.summary = summary
      existing.kind = input.kind
      existing.targetKind = targetKind
      existing.expiresAt = expiresAt
      if (interestId !== null) existing.interestId = interestId
      if (artifact !== null) existing.artifact = artifact
      this.save()
      return { ok: true, message: '已合并到最近的经历', record: cloneRecord(existing) }
    }

    const record: ExperienceRecord = {
      id: randomUUID(),
      at,
      kind: input.kind,
      summary,
      tool,
      targetKind,
      targetRef,
      taskId,
      interestId,
      artifact,
      expiresAt
    }
    this.records.push(record)
    this.trim(limits.maxRecords)
    this.save()
    return { ok: true, message: '已记录一条经历', record: cloneRecord(record) }
  }

  /** 注入提示用：最近 limit 条；关闭记忆时为空。 */
  recentForPrompt(limit = 5): ExperienceRecord[] {
    if (!this.enabled()) return []
    this.prune(this.now())
    return this.records
      .slice()
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(0, Math.min(limit, 20)))
      .map(cloneRecord)
  }

  /** 设置页快照：本地可见，即使记忆关闭也返回已有摘要。 */
  list(): ExperienceRecord[] {
    this.prune(this.now())
    return this.records
      .slice()
      .sort((a, b) => b.at - a.at)
      .map(cloneRecord)
  }

  get(id: string): ExperienceRecord | undefined {
    const record = this.records.find((entry) => entry.id === id)
    return record === undefined ? undefined : cloneRecord(record)
  }

  delete(id: string): boolean {
    const before = this.records.length
    this.records = this.records.filter((record) => record.id !== id)
    const removed = this.records.length !== before
    if (removed) this.save(true)
    return removed
  }

  forgetMatching(query: string): number {
    const needle = safeCompanionText(query, 200).toLowerCase()
    if (needle === '') return 0
    const before = this.records.length
    this.records = this.records.filter((record) => {
      const haystack = [record.summary, record.tool, record.targetRef ?? '', record.artifact ?? '']
        .join('\n')
        .toLowerCase()
      return !haystack.includes(needle)
    })
    const removed = before - this.records.length
    if (removed > 0) this.save(true)
    return removed
  }

  clear(): void {
    if (this.records.length === 0) return
    this.records = []
    this.save(true)
  }

  count(): number {
    this.prune(this.now())
    return this.records.length
  }

  // -------------------------------------------------------------------------

  private clampedLimits(): ExperienceLimits {
    const raw = this.limits()
    return {
      retentionDays: clampInt(raw.retentionDays, 1, 365, 14),
      maxRecords: clampInt(raw.maxRecords, 1, 500, 50)
    }
  }

  private prune(now: number): void {
    const before = this.records.length
    this.records = this.records.filter((record) => record.expiresAt > now)
    if (this.records.length !== before) this.save()
  }

  private trim(maxRecords: number): void {
    if (this.records.length <= maxRecords) return
    // 保留最新：按时间升序排序后丢掉最旧的。
    this.records.sort((a, b) => a.at - b.at)
    this.records = this.records.slice(this.records.length - maxRecords)
  }

  private save(force = false): void {
    if (!this.enabled() && !force) return
    try {
      const data: PersistedExperiences = { version: 1, records: this.records }
      atomicWrite(this.file, JSON.stringify(data, null, 2))
      this.onChange?.()
    } catch (error) {
      this.logger?.warn('经历保存失败', { error: String(error) })
    }
  }

  private load(): ExperienceRecord[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed = safeJsonParse<unknown>(readFileSync(this.file, 'utf8'))
      if (parsed === null || parsed === undefined || typeof parsed !== 'object') return []
      const rawRecords = (parsed as { records?: unknown }).records
      if (!Array.isArray(rawRecords)) return []
      const now = this.now()
      const out: ExperienceRecord[] = []
      for (const raw of rawRecords) {
        const record = parseExperienceRecord(raw, now)
        if (record !== null) out.push(record)
      }
      return out
    } catch (error) {
      this.logger?.warn('经历文件损坏，已回退为空', { error: String(error) })
      return []
    }
  }
}

function parseExperienceRecord(raw: unknown, now: number): ExperienceRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const id =
    typeof input.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(input.id) ? input.id : null
  const summary = safeCompanionText(input.summary, EXPERIENCE_SUMMARY_MAX)
  if (id === null || summary === '') return null
  const kind = KINDS.includes(input.kind as ExperienceKind)
    ? (input.kind as ExperienceKind)
    : 'task'
  const targetKind = TARGET_KINDS.includes(input.targetKind as ExperienceTargetKind)
    ? (input.targetKind as ExperienceTargetKind)
    : 'file'
  const at = finiteTime(input.at, now)
  const expiresAt = finiteTime(input.expiresAt, at + 14 * 24 * 60 * 60_000)
  return {
    id,
    at,
    kind,
    summary,
    tool: safeToolName(input.tool) ?? 'unknown',
    targetKind,
    targetRef: safeTargetRef(targetKind, input.targetRef ?? null),
    taskId: safeOpaqueId(input.taskId),
    interestId: safeOpaqueId(input.interestId),
    artifact: safeNoteArtifact(input.artifact ?? null),
    expiresAt
  }
}

function safeOpaqueId(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  return /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null
}

function finiteTime(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function cloneRecord(record: ExperienceRecord): ExperienceRecord {
  return { ...record }
}
