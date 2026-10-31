import { existsSync, readFileSync } from 'node:fs'
import type { Logger } from '../../core/types'
import { atomicWrite, safeJsonParse } from '../../core/util'
import {
  safeCompanionText,
  safeFingerprint,
  type CompanionTargetKind
} from './sanitize'

export const EXPLORATION_MAX_PER_OWNER = 50
export const EXPLORATION_MAX_TOTAL = 300
export const EXPLORATION_WINDOW_MS = 24 * 60 * 60_000

const TARGET_KINDS: readonly CompanionTargetKind[] = [
  'file',
  'window',
  'page',
  'web',
  'note',
  'app'
]

export interface ExplorationVisit {
  /** 内容指纹；不含正文。 */
  key: string
  at: number
  kind: CompanionTargetKind
  /** 应用标签/相对路径/域名等安全短引用。 */
  label: string
}

interface ExplorationBucket {
  /** `interest:<id>` / `task:<id>` / `global`。 */
  owner: string
  visited: ExplorationVisit[]
}

export interface RecordExplorationInput {
  fingerprint: string
  kind: CompanionTargetKind
  label?: string | null
  interestId?: string | null
  taskId?: string | null
  at?: number
}

export interface ExplorationStoreOptions {
  file: string
  enabled: () => boolean
  now?: () => number
  logger?: Logger
  onChange?: () => void
  maxPerOwner?: number
  maxTotal?: number
  windowMs?: number
}

interface PersistedExploration {
  version: 1
  buckets: ExplorationBucket[]
}

/**
 * 探索进度与去重：只按内容指纹记录“看过”，不保存任何正文。
 * 指纹命中只提示模型“最近看过”，不阻止再次读取。
 */
export class ExplorationStore {
  private readonly file: string
  private readonly enabled: () => boolean
  private readonly now: () => number
  private readonly logger: Logger | undefined
  private readonly onChange: (() => void) | undefined
  private readonly maxPerOwner: number
  private readonly maxTotal: number
  private readonly windowMs: number
  private buckets: ExplorationBucket[]

  constructor(options: ExplorationStoreOptions) {
    this.file = options.file
    this.enabled = options.enabled
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
    this.onChange = options.onChange
    this.maxPerOwner = Math.min(
      200,
      Math.max(1, Math.trunc(options.maxPerOwner ?? EXPLORATION_MAX_PER_OWNER))
    )
    this.maxTotal = Math.min(
      2000,
      Math.max(1, Math.trunc(options.maxTotal ?? EXPLORATION_MAX_TOTAL))
    )
    this.windowMs = Math.max(60_000, Math.trunc(options.windowMs ?? EXPLORATION_WINDOW_MS))
    this.buckets = this.load()
    this.trim()
  }

  isEnabled(): boolean {
    return this.enabled()
  }

  /** 最近 windowMs 内是否看过同一指纹；关闭记忆时不做提示。 */
  seen(fingerprint: string, windowMs?: number): boolean {
    if (!this.enabled()) return false
    const key = safeFingerprint(fingerprint)
    if (key === null) return false
    const since = this.now() - (windowMs ?? this.windowMs)
    return this.buckets.some((bucket) =>
      bucket.visited.some((visit) => visit.key === key && visit.at >= since)
    )
  }

  record(input: RecordExplorationInput): boolean {
    if (!this.enabled()) return false
    const key = safeFingerprint(input.fingerprint)
    if (key === null) return false
    const at = input.at ?? this.now()
    const kind = TARGET_KINDS.includes(input.kind) ? input.kind : 'file'
    const label = safeCompanionText(input.label ?? '', 80) || kind
    const owner = ownerOf(input.interestId, input.taskId)
    let bucket = this.buckets.find((entry) => entry.owner === owner)
    if (bucket === undefined) {
      bucket = { owner, visited: [] }
      this.buckets.push(bucket)
    }
    const existing = bucket.visited.find((visit) => visit.key === key)
    if (existing !== undefined) {
      existing.at = at
      existing.kind = kind
      existing.label = label
    } else {
      bucket.visited.push({ key, at, kind, label })
    }
    this.trim()
    this.save()
    return true
  }

  /** 用户删除兴趣时同时清掉它的探索指纹。 */
  forgetInterest(interestId: string): void {
    const owner = `interest:${interestId}`
    const before = this.buckets.length
    this.buckets = this.buckets.filter((bucket) => bucket.owner !== owner)
    if (this.buckets.length !== before) this.save(true)
  }

  forgetMatching(query: string): number {
    const needle = safeCompanionText(query, 80).toLowerCase()
    if (needle === '') return 0
    let removed = 0
    for (const bucket of this.buckets) {
      const before = bucket.visited.length
      bucket.visited = bucket.visited.filter((visit) => !visit.label.toLowerCase().includes(needle))
      removed += before - bucket.visited.length
    }
    if (removed > 0) this.save(true)
    return removed
  }

  clear(): void {
    if (this.buckets.length === 0) return
    this.buckets = []
    this.save(true)
  }

  count(): number {
    return this.buckets.reduce((total, bucket) => total + bucket.visited.length, 0)
  }

  snapshot(): Array<{ owner: string; visited: ExplorationVisit[] }> {
    return this.buckets.map((bucket) => ({
      owner: bucket.owner,
      visited: bucket.visited.map((visit) => ({ ...visit }))
    }))
  }

  // -------------------------------------------------------------------------

  private trim(): void {
    for (const bucket of this.buckets) {
      if (bucket.visited.length <= this.maxPerOwner) continue
      bucket.visited.sort((a, b) => a.at - b.at)
      bucket.visited = bucket.visited.slice(bucket.visited.length - this.maxPerOwner)
    }
    const total = this.buckets.reduce((sum, bucket) => sum + bucket.visited.length, 0)
    if (total <= this.maxTotal) return
    const all = this.buckets
      .flatMap((bucket) => bucket.visited.map((visit) => ({ owner: bucket.owner, visit })))
      .sort((a, b) => a.visit.at - b.visit.at)
    const keep = new Set(all.slice(all.length - this.maxTotal).map((entry) => entry.visit))
    for (const bucket of this.buckets) {
      bucket.visited = bucket.visited.filter((visit) => keep.has(visit))
    }
    this.buckets = this.buckets.filter((bucket) => bucket.visited.length > 0)
  }

  private save(force = false): void {
    if (!this.enabled() && !force) return
    try {
      const data: PersistedExploration = { version: 1, buckets: this.buckets }
      atomicWrite(this.file, JSON.stringify(data, null, 2))
      this.onChange?.()
    } catch (error) {
      this.logger?.warn('探索进度保存失败', { error: String(error) })
    }
  }

  private load(): ExplorationBucket[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed = safeJsonParse<unknown>(readFileSync(this.file, 'utf8'))
      if (parsed === null || parsed === undefined || typeof parsed !== 'object') return []
      const rawBuckets = (parsed as { buckets?: unknown }).buckets
      if (!Array.isArray(rawBuckets)) return []
      const out: ExplorationBucket[] = []
      for (const raw of rawBuckets) {
        const bucket = parseBucket(raw)
        if (bucket !== null) out.push(bucket)
      }
      return out
    } catch (error) {
      this.logger?.warn('探索进度文件损坏，已回退为空', { error: String(error) })
      return []
    }
  }
}

function parseBucket(raw: unknown): ExplorationBucket | null {
  if (raw === null || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const owner = typeof input.owner === 'string' ? input.owner : ''
  if (!/^(?:interest:[A-Za-z0-9_-]{1,80}|task:[A-Za-z0-9_-]{1,80}|global)$/.test(owner)) {
    return null
  }
  if (!Array.isArray(input.visited)) return null
  const visited: ExplorationVisit[] = []
  for (const entry of input.visited) {
    if (entry === null || typeof entry !== 'object') continue
    const visit = entry as Record<string, unknown>
    const key = safeFingerprint(visit.key)
    const at = typeof visit.at === 'number' && Number.isFinite(visit.at) ? visit.at : null
    if (key === null || at === null) continue
    const kind = TARGET_KINDS.includes(visit.kind as CompanionTargetKind)
      ? (visit.kind as CompanionTargetKind)
      : 'file'
    const label = safeCompanionText(visit.label ?? '', 80) || kind
    if (!visited.some((existing) => existing.key === key)) {
      visited.push({ key, at, kind, label })
    }
  }
  return { owner, visited }
}

function ownerOf(interestId: string | null | undefined, taskId: string | null | undefined): string {
  const interest = safeOpaqueId(interestId)
  if (interest !== null) return `interest:${interest}`
  const task = safeOpaqueId(taskId)
  if (task !== null) return `task:${task}`
  return 'global'
}

function safeOpaqueId(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  return /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null
}
