import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../../core/types'
import type {
  BiliAsrRead,
  BiliAsrState,
  BiliFrameRead,
  BiliReadingRecord,
  BiliReadingView,
  BiliReportSummary,
  BiliSubtitleRead,
  BiliVerdict
} from '../../shared/bilibili'
import {
  biliVideoUrl,
  isBvid,
  isDateKey,
  localDateKey,
  safePartIndex
} from '../../shared/bilibili'
import type { DiscoveryEvidenceLevel } from '../../shared/discovery'
import { atomicWrite } from '../../core/util'
import type { BiliPaths } from './paths'
import {
  buildDailyReport,
  pruneReportFiles,
  recordsForDate,
  reportExists,
  reportPathFor,
  toEntryView,
  writeDailyReport,
  type ReportFailureCount
} from './dailyReport'

/**
 * B 站阅读记录：日报、去重关联与设置的唯一结构化来源。
 *
 * - 按账号哈希分区存盘，账号切换不串数据。
 * - 记忆关闭时新记录只保存在内存（ephemeral），日报也只存在内存，不落盘。
 * - 先写记录，再重建日报；日报失败可重试，不丢阅读状态。
 * - 删除发现/记忆时从这里清理投影，防止日报把已删内容带回来。
 * - 不保存字幕/转写全文，只保存覆盖度、字数、抽帧时间等元数据。
 */

export interface ReadingStoreOptions {
  paths: BiliPaths
  logger: Logger
  now?: () => number
  timeZone?: string
  onChange?: () => void
}

export interface ReadingRecordInput {
  bvid: string
  partIndex: number
  cid?: number | null
  title: string
  author: string
  durationSec?: number | null
  origin: BiliReadingRecord['origin']
  query?: string | null
  discoveredAt?: number
}

export interface ReadingRecordPatch {
  cid?: number | null
  title?: string
  author?: string
  durationSec?: number | null
  descriptionReadAt?: number
  descriptionChars?: number
  tags?: string[]
  subtitle?: BiliSubtitleRead | null
  frames?: BiliFrameRead | null
  asr?: BiliAsrRead | null
  transcriptReadChars?: number
  verdict?: BiliVerdict | null
  reason?: string | null
  keyPoints?: string[]
  evidenceLevel?: DiscoveryEvidenceLevel | null
  discoveryId?: string | null
}

interface Entry {
  record: BiliReadingRecord
  ephemeral: boolean
}

interface ReadingFile {
  v: 1
  records: BiliReadingRecord[]
  failures: ReportFailureCount[]
}

export class BiliReadingStore {
  private readonly opts: ReadingStoreOptions
  private readonly entries = new Map<string, Entry>()
  private failures: ReportFailureCount[] = []
  private accountKey = 'anonymous'
  private memoryEnabled = true
  private retentionDays = 30
  private lastReportAt = new Map<string, number>()
  private lastReportError: string | null = null
  private loaded = false

  constructor(options: ReadingStoreOptions) {
    this.opts = options
  }

  get currentAccountKey(): string {
    return this.accountKey
  }

  get memoryOnly(): boolean {
    return !this.memoryEnabled
  }

  get reportLastError(): string | null {
    return this.lastReportError
  }

  /**
   * 切换账号分区。先 flush 旧分区（仅在可落盘时），再加载新分区；
   * 内存态记录不会跨账号保留，避免在途结果混入新账号。
   */
  openAccount(accountKey: string, options: { memoryEnabled: boolean }): void {
    const key = normalizeAccountKey(accountKey)
    if (this.loaded && key === this.accountKey) {
      this.memoryEnabled = options.memoryEnabled
      return
    }
    if (this.loaded) this.flush()
    this.entries.clear()
    this.failures = []
    this.lastReportAt.clear()
    this.lastReportError = null
    this.accountKey = key
    this.memoryEnabled = options.memoryEnabled
    this.loaded = true
    this.load()
    this.pruneRecords()
  }

  setMemoryEnabled(enabled: boolean): void {
    this.memoryEnabled = enabled
  }

  setRetentionDays(days: number): void {
    this.retentionDays = Math.min(365, Math.max(1, Math.trunc(days)))
    this.pruneRecords()
  }

  /** 选中候选时创建/更新基础记录；never 覆盖已读证据。 */
  ensure(input: ReadingRecordInput): BiliReadingRecord {
    const partIndex = safePartIndex(input.partIndex)
    const bvid = isBvid(input.bvid) ? input.bvid : ''
    if (bvid === '') throw new Error('invalid bvid')
    const id = recordId(bvid, partIndex)
    const existing = this.entries.get(id)
    const now = this.now()
    if (existing !== undefined) {
      const record = existing.record
      record.title = cleanText(input.title) || record.title
      record.author = cleanText(input.author) || record.author
      if (input.cid !== undefined) record.cid = safeCid(input.cid)
      if (input.durationSec !== undefined) {
        record.durationSec = safeDuration(input.durationSec)
      }
      if (record.origin === 'open' && input.origin !== 'open') record.origin = input.origin
      if (record.query === null && input.query != null) record.query = cleanText(input.query)
      record.updatedAt = now
      this.persist()
      return clone(record)
    }
    const record: BiliReadingRecord = {
      id,
      accountKey: this.accountKey,
      bvid,
      partIndex,
      cid: input.cid === undefined ? null : safeCid(input.cid),
      title: cleanText(input.title) || bvid,
      author: cleanText(input.author),
      url: biliVideoUrl(bvid, partIndex),
      durationSec: input.durationSec === undefined ? null : safeDuration(input.durationSec),
      origin: input.origin,
      query: input.query == null ? null : cleanText(input.query),
      discoveredAt: typeof input.discoveredAt === 'number' ? input.discoveredAt : now,
      updatedAt: now,
      descriptionReadAt: null,
      descriptionChars: 0,
      tags: [],
      subtitle: null,
      frames: null,
      asr: null,
      transcriptReadChars: 0,
      verdict: null,
      reason: null,
      keyPoints: [],
      evidenceLevel: null,
      discoveryId: null,
      explorationDate: this.dateKey(now),
      completedDate: null
    }
    this.entries.set(id, { record, ephemeral: !this.memoryEnabled })
    this.persist()
    return clone(record)
  }

  update(bvid: string, partIndex: number, patch: ReadingRecordPatch): BiliReadingRecord | null {
    const entry = this.entries.get(recordId(bvid, safePartIndex(partIndex)))
    if (entry === undefined) return null
    const record = entry.record
    const now = this.now()
    if (patch.cid !== undefined) record.cid = safeCid(patch.cid)
    if (patch.title !== undefined && patch.title.trim() !== '') record.title = cleanText(patch.title)
    if (patch.author !== undefined && patch.author.trim() !== '') record.author = cleanText(patch.author)
    if (patch.durationSec !== undefined) record.durationSec = safeDuration(patch.durationSec)
    if (patch.descriptionReadAt !== undefined) {
      record.descriptionReadAt = patch.descriptionReadAt
      record.descriptionChars = Math.max(0, Math.min(20_000, Math.trunc(patch.descriptionChars ?? record.descriptionChars)))
    }
    if (patch.tags !== undefined) {
      record.tags = patch.tags
        .map((tag) => cleanText(tag))
        .filter((tag) => tag !== '')
        .slice(0, 20)
    }
    if (patch.subtitle !== undefined) record.subtitle = patch.subtitle
    if (patch.frames !== undefined) record.frames = patch.frames
    if (patch.asr !== undefined) {
      const previousJobId = record.asr?.jobId ?? null
      const nextJobId = patch.asr?.jobId ?? null
      record.asr = patch.asr
      // 新任务重新计数；同一任务的状态更新不能抹掉已读覆盖。
      if (nextJobId !== null && nextJobId !== previousJobId) {
        record.transcriptReadChars = 0
      }
      if (patch.asr !== null && patch.asr.state === 'succeeded') {
        record.completedDate = this.dateKey(patch.asr.finishedAt ?? now)
      }
    }
    if (patch.transcriptReadChars !== undefined) {
      record.transcriptReadChars = Math.max(
        record.transcriptReadChars,
        Math.max(0, Math.min(200_000, Math.trunc(patch.transcriptReadChars)))
      )
    }
    if (patch.verdict !== undefined) {
      record.verdict = patch.verdict
      if (patch.verdict !== null) record.completedDate = this.dateKey(now)
    }
    if (patch.reason !== undefined) record.reason = limitText(patch.reason, 500)
    if (patch.keyPoints !== undefined) {
      record.keyPoints = patch.keyPoints
        .map((point) => limitText(point, 160))
        .filter((point): point is string => point !== null)
        .slice(0, 8)
    }
    if (patch.evidenceLevel !== undefined) record.evidenceLevel = patch.evidenceLevel
    if (patch.discoveryId !== undefined) record.discoveryId = patch.discoveryId
    record.updatedAt = now
    this.persist()
    return clone(record)
  }

  get(bvid: string, partIndex: number): BiliReadingRecord | null {
    const entry = this.entries.get(recordId(bvid, safePartIndex(partIndex)))
    return entry === undefined ? null : clone(entry.record)
  }

  byId(id: string): BiliReadingRecord | null {
    const entry = this.entries.get(id)
    return entry === undefined ? null : clone(entry.record)
  }

  list(): BiliReadingRecord[] {
    return [...this.entries.values()]
      .map((entry) => clone(entry.record))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  noteFailure(code: string): void {
    const date = this.dateKey(this.now())
    const existing = this.failures.find((item) => item.date === date && item.code === code)
    if (existing === undefined) this.failures.push({ date, code, count: 1 })
    else existing.count += 1
    this.pruneFailures()
    this.persist()
  }

  /**
   * 删除发现时清理日报投影。返回受影响的日期，调用方据此重建日报；
   * 删除发生在持久层，任何 ASR 迟到结果都不能复活记录。
   */
  removeByDiscoveryIds(ids: readonly string[]): string[] {
    const wanted = new Set(ids.filter((id) => typeof id === 'string' && id !== ''))
    if (wanted.size === 0) return []
    const dates = new Set<string>()
    for (const [key, entry] of this.entries) {
      if (entry.record.discoveryId === null || !wanted.has(entry.record.discoveryId)) continue
      dates.add(entry.record.explorationDate)
      if (entry.record.completedDate !== null) dates.add(entry.record.completedDate)
      this.entries.delete(key)
    }
    if (dates.size > 0) this.persist()
    return [...dates]
  }

  /** 记忆删除按标题/作者匹配；只影响本账号，不复活已删条目。 */
  removeByText(terms: readonly string[]): string[] {
    const needles = terms
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length >= 2)
    if (needles.length === 0) return []
    const dates = new Set<string>()
    for (const [key, entry] of this.entries) {
      const haystack = `${entry.record.title}\n${entry.record.author}`.toLowerCase()
      if (!needles.some((needle) => haystack.includes(needle))) continue
      dates.add(entry.record.explorationDate)
      if (entry.record.completedDate !== null) dates.add(entry.record.completedDate)
      this.entries.delete(key)
    }
    if (dates.size > 0) this.persist()
    return [...dates]
  }

  clear(): string[] {
    const dates = new Set<string>()
    for (const entry of this.entries.values()) {
      dates.add(entry.record.explorationDate)
      if (entry.record.completedDate !== null) dates.add(entry.record.completedDate)
    }
    this.entries.clear()
    this.persist()
    return [...dates]
  }

  recordsFor(date: string): BiliReadingRecord[] {
    return recordsForDate(
      [...this.entries.values()].map((entry) => entry.record),
      date
    )
  }

  /**
   * 重建某天日报。没有实际探索/失败时不会凭空创建空报告；
   * 已存在但记录被删空的日报会被移除。
   */
  rebuildReport(
    date: string,
    options: { enabled: boolean; today?: string }
  ): { ok: boolean; path: string | null; summary: BiliReportSummary; error: string | null } {
    const today = options.today ?? this.dateKey(this.now())
    const records = this.recordsFor(date)
    const hasFailures = this.failures.some((item) => item.date === date && item.count > 0)
    const summary = this.summary(date, options.enabled)
    if (!options.enabled) {
      return { ok: true, path: null, summary, error: null }
    }
    if (records.length === 0 && !hasFailures) {
      this.removeReportFile(date)
      const empty = this.summary(date, true)
      this.lastReportError = null
      return { ok: true, path: null, summary: empty, error: null }
    }
    if (!this.memoryEnabled) {
      // 记忆关闭：只保留内存 Markdown，不写任何文件。
      this.lastReportAt.set(date, this.now())
      this.lastReportError = null
      return { ok: true, path: null, summary: this.summary(date, true), error: null }
    }
    const built = buildDailyReport({
      date,
      records: [...this.entries.values()].map((entry) => entry.record),
      failures: this.failures,
      generatedAt: this.now()
    })
    const written = writeDailyReport(this.opts.paths, this.accountKey, date, built.markdown)
    if (!written.ok) {
      this.lastReportError = written.message
      return { ok: false, path: null, summary: this.summary(date, true), error: written.message }
    }
    this.lastReportAt.set(date, built.summary.generatedAt ?? this.now())
    this.lastReportError = null
    try {
      pruneReportFiles(this.opts.paths, this.accountKey, this.retentionDays, today)
    } catch {
      /* 保留期清理失败不影响日报本身 */
    }
    return { ok: true, path: written.path, summary: this.summary(date, true), error: null }
  }

  summary(date: string, reportEnabled = true): BiliReportSummary {
    const records = this.recordsFor(date)
    const hasFailures = this.failures.some((item) => item.date === date && item.count > 0)
    const exists = reportExists(this.opts.paths, this.accountKey, date)
    if (records.length === 0 && !hasFailures) {
      return emptySummary(date, exists)
    }
    const built = buildDailyReport({
      date,
      records: [...this.entries.values()].map((entry) => entry.record),
      failures: this.failures,
      generatedAt: this.lastReportAt.get(date) ?? this.now()
    })
    return {
      ...built.summary,
      path: exists ? reportPathFor(this.opts.paths, this.accountKey, date) : null,
      exists,
      inMemory: !reportEnabled || !this.memoryEnabled
    }
  }

  readingView(date: string): BiliReadingView {
    const records = this.recordsFor(date)
    return {
      date,
      entries: records.map(toEntryView),
      counts: {
        checked: records.length,
        worth: records.filter((record) => record.verdict === 'worth').length,
        okay: records.filter((record) => record.verdict === 'okay').length,
        skip: records.filter((record) => record.verdict === 'skip').length,
        unknown: records.filter((record) => record.verdict === 'unknown').length
      }
    }
  }

  flush(): void {
    this.persist()
  }

  // ------------------------------------------------------------------ 持久化

  private load(): void {
    const file = this.file()
    if (!existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ReadingFile>
      if (parsed.v !== 1 || !Array.isArray(parsed.records)) return
      for (const raw of parsed.records) {
        const record = parseRecord(raw, this.accountKey)
        if (record === null) continue
        this.entries.set(record.id, { record, ephemeral: false })
      }
      if (Array.isArray(parsed.failures)) {
        this.failures = parsed.failures
          .filter(
            (item): item is ReportFailureCount =>
              item !== null &&
              typeof item === 'object' &&
              isDateKey((item as ReportFailureCount).date) &&
              typeof (item as ReportFailureCount).code === 'string' &&
              typeof (item as ReportFailureCount).count === 'number'
          )
          .slice(-200)
      }
    } catch (error) {
      this.opts.logger.warn('B 站阅读记录读取失败', {
        message: error instanceof Error ? error.message.slice(0, 120) : 'parse failed'
      })
    }
  }

  private persist(): void {
    if (!this.memoryEnabled) {
      this.opts.onChange?.()
      return
    }
    const file = this.file()
    const payload: ReadingFile = {
      v: 1,
      records: [...this.entries.values()]
        .filter((entry) => !entry.ephemeral)
        .map((entry) => entry.record),
      failures: this.failures
    }
    try {
      mkdirSync(join(this.opts.paths.readingDir), { recursive: true })
      atomicWrite(file, JSON.stringify(payload))
    } catch {
      this.opts.logger.warn('B 站阅读记录写入失败')
    }
    this.opts.onChange?.()
  }

  private file(): string {
    return join(this.opts.paths.readingDir, `${this.accountKey}.json`)
  }

  private removeReportFile(date: string): void {
    if (!isDateKey(date)) return
    try {
      rmSync(reportPathFor(this.opts.paths, this.accountKey, date), { force: true })
    } catch {
      /* 文件可能不存在 */
    }
  }

  private pruneRecords(): void {
    const cutoff = this.now() - this.retentionDays * 24 * 60 * 60_000
    for (const [key, entry] of this.entries) {
      if (entry.ephemeral) continue
      if (entry.record.updatedAt < cutoff) this.entries.delete(key)
    }
    this.pruneFailures()
  }

  private pruneFailures(): void {
    const cutoff = this.now() - this.retentionDays * 24 * 60 * 60_000
    const keepFrom = this.dateKey(cutoff)
    this.failures = this.failures.filter((item) => item.date >= keepFrom).slice(-200)
  }

  private dateKey(timestamp: number): string {
    return localDateKey(timestamp, this.opts.timeZone ?? 'Asia/Shanghai')
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}

function recordId(bvid: string, partIndex: number): string {
  return `${bvid}#${partIndex}`
}

function normalizeAccountKey(value: string): string {
  return /^(?:anonymous|[a-f0-9]{8,32})$/.test(value) ? value : 'anonymous'
}

function cleanText(value: string | null): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

function limitText(value: string | null, max: number): string | null {
  const text = cleanText(value)
  return text === '' ? null : text.slice(0, max)
}

function safeCid(value: number | null): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function safeDuration(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null
}

function clone(record: BiliReadingRecord): BiliReadingRecord {
  return {
    ...record,
    tags: [...record.tags],
    keyPoints: [...record.keyPoints],
    subtitle: record.subtitle === null ? null : { ...record.subtitle },
    frames:
      record.frames === null
        ? null
        : { ...record.frames, times: [...record.frames.times] },
    asr: record.asr === null ? null : { ...record.asr }
  }
}

function emptySummary(date: string, exists: boolean): BiliReportSummary {
  return {
    date,
    path: null,
    exists,
    inMemory: false,
    entries: 0,
    worth: 0,
    okay: 0,
    skip: 0,
    unknown: 0,
    skipped: 0,
    failed: 0,
    generatedAt: null,
    markdown: ''
  }
}

function parseRecord(value: unknown, accountKey: string): BiliReadingRecord | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Partial<BiliReadingRecord>
  if (typeof raw.bvid !== 'string' || !isBvid(raw.bvid)) return null
  if (typeof raw.partIndex !== 'number') return null
  const partIndex = safePartIndex(raw.partIndex)
  const id = recordId(raw.bvid, partIndex)
  if (raw.id !== id) return null
  const title = typeof raw.title === 'string' ? cleanText(raw.title) : ''
  if (title === '') return null
  const now = Date.now()
  return {
    id,
    accountKey,
    bvid: raw.bvid,
    partIndex,
    cid: safeCid(typeof raw.cid === 'number' ? raw.cid : null),
    title,
    author: typeof raw.author === 'string' ? cleanText(raw.author) : '',
    url: biliVideoUrl(raw.bvid, partIndex),
    durationSec: safeDuration(typeof raw.durationSec === 'number' ? raw.durationSec : null),
    origin:
      raw.origin === 'recommend' || raw.origin === 'search' || raw.origin === 'open'
        ? raw.origin
        : 'open',
    query: typeof raw.query === 'string' ? cleanText(raw.query) : null,
    discoveredAt: numberOr(raw.discoveredAt, now),
    updatedAt: numberOr(raw.updatedAt, now),
    descriptionReadAt:
      typeof raw.descriptionReadAt === 'number' ? raw.descriptionReadAt : null,
    descriptionChars:
      typeof raw.descriptionChars === 'number' ? Math.max(0, Math.trunc(raw.descriptionChars)) : 0,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((tag): tag is string => typeof tag === 'string').map(cleanText).slice(0, 20)
      : [],
    subtitle: parseSubtitle(raw.subtitle),
    frames: parseFrames(raw.frames),
    asr: parseAsr(raw.asr),
    transcriptReadChars:
      typeof raw.transcriptReadChars === 'number'
        ? Math.max(0, Math.min(200_000, Math.trunc(raw.transcriptReadChars)))
        : 0,
    verdict:
      raw.verdict === 'worth' || raw.verdict === 'okay' || raw.verdict === 'skip' || raw.verdict === 'unknown'
        ? raw.verdict
        : null,
    reason: typeof raw.reason === 'string' ? limitText(raw.reason, 500) : null,
    keyPoints: Array.isArray(raw.keyPoints)
      ? raw.keyPoints
          .filter((point): point is string => typeof point === 'string')
          .map((point) => limitText(point, 160))
          .filter((point): point is string => point !== null)
          .slice(0, 8)
      : [],
    evidenceLevel: parseEvidence(raw.evidenceLevel),
    discoveryId: typeof raw.discoveryId === 'string' ? raw.discoveryId.slice(0, 80) : null,
    explorationDate: isDateKey(raw.explorationDate) ? raw.explorationDate : localDateKey(now),
    completedDate: isDateKey(raw.completedDate) ? raw.completedDate : null
  }
}

function parseSubtitle(value: unknown): BiliSubtitleRead | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Partial<BiliSubtitleRead>
  if (typeof raw.readAt !== 'number') return null
  return {
    status: raw.status === 'full' || raw.status === 'partial' || raw.status === 'none' ? raw.status : 'partial',
    language: typeof raw.language === 'string' ? raw.language.slice(0, 20) : null,
    coverage: clamp01(typeof raw.coverage === 'number' ? raw.coverage : 0),
    segmentsRead: Math.max(0, Math.trunc(typeof raw.segmentsRead === 'number' ? raw.segmentsRead : 0)),
    segmentsTotal: Math.max(0, Math.trunc(typeof raw.segmentsTotal === 'number' ? raw.segmentsTotal : 0)),
    chars: Math.max(0, Math.trunc(typeof raw.chars === 'number' ? raw.chars : 0)),
    readAt: raw.readAt,
    partIndex: safePartIndex(raw.partIndex ?? 0),
    cid: safeCid(typeof raw.cid === 'number' ? raw.cid : null)
  }
}

function parseFrames(value: unknown): BiliFrameRead | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Partial<BiliFrameRead>
  if (typeof raw.at !== 'number') return null
  return {
    delivered: Math.max(0, Math.trunc(typeof raw.delivered === 'number' ? raw.delivered : 0)),
    requested: Math.max(0, Math.trunc(typeof raw.requested === 'number' ? raw.requested : 0)),
    times: Array.isArray(raw.times)
      ? raw.times.filter((time): time is number => typeof time === 'number').slice(0, 6)
      : [],
    coveredSec:
      typeof raw.coveredSec === 'number' && Number.isFinite(raw.coveredSec)
        ? Math.max(0, raw.coveredSec)
        : null,
    at: raw.at,
    partIndex: safePartIndex(raw.partIndex ?? 0)
  }
}

function parseAsr(value: unknown): BiliAsrRead | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Partial<BiliAsrRead>
  if (typeof raw.jobId !== 'string') return null
  return {
    jobId: raw.jobId.slice(0, 64),
    state: isAsrState(raw.state) ? raw.state : 'failed',
    model: typeof raw.model === 'string' ? raw.model.slice(0, 20) : 'small',
    submittedAt: numberOr(raw.submittedAt, Date.now()),
    finishedAt: typeof raw.finishedAt === 'number' ? raw.finishedAt : null,
    chars: typeof raw.chars === 'number' ? Math.max(0, Math.trunc(raw.chars)) : null,
    errorCode: typeof raw.errorCode === 'string' ? (raw.errorCode as BiliAsrRead['errorCode']) : null
  }
}

function parseEvidence(value: unknown): DiscoveryEvidenceLevel | null {
  return value === 'metadata' ||
    value === 'link' ||
    value === 'description' ||
    value === 'excerpt' ||
    value === 'transcript' ||
    value === 'video-frames'
    ? value
    : null
}

function isAsrState(value: unknown): value is BiliAsrState {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'empty' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'interrupted'
  )
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
