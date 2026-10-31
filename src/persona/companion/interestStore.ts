import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { Logger } from '../../core/types'
import { atomicWrite, safeJsonParse } from '../../core/util'
import { safeCompanionText, safeNoteArtifact } from './sanitize'

export type InterestSource = 'user' | 'autonomy' | 'event'
export type InterestStatus = 'active' | 'paused' | 'done' | 'abandoned'

const SOURCES: readonly InterestSource[] = ['user', 'autonomy', 'event']
const STATUSES: readonly InterestStatus[] = ['active', 'paused', 'done', 'abandoned']

export const INTEREST_TITLE_MAX = 60
export const INTEREST_TEXT_MAX = 200
export const INTEREST_FACTS_MAX = 5
export const INTEREST_QUESTIONS_MAX = 3
export const INTEREST_ARTIFACTS_MAX = 8
export const INTEREST_TASKS_MAX = 8

export interface InterestRecord {
  id: string
  title: string
  source: InterestSource
  status: InterestStatus
  facts: string[]
  questions: string[]
  nextStep: string | null
  /** 下一步预计使用的 harness 工具；只用于候选筛选，不授予权限。 */
  nextTool: string | null
  /** 继续这个目标实际需要的能力标签（如 file.read / web）。 */
  requiredCapability: string | null
  /** 是否适合在用户忙碌时后台推进；null 表示尚未判断。 */
  backgroundSafe: boolean | null
  /** 什么情况/多久后值得重新检查这个候选。 */
  recheckCondition: string | null
  endCondition: string
  artifacts: string[]
  taskIds: string[]
  createdAt: number
  updatedAt: number
  lastFocusAt: number | null
  nextRevisitAt: number | null
  focusCount: number
  talkCount: number
  lastTalkedAt: number | null
  abandonedReason: string | null
}

export interface InterestLimits {
  maxActive: number
  ttlDays: number
  maxFocusCount: number
}

export interface CreateInterestInput {
  title: string
  reason?: string
  endCondition: string
  nextStep?: string | null
  nextTool?: string | null
  requiredCapability?: string | null
  backgroundSafe?: boolean | null
  recheckCondition?: string | null
  questions?: string[]
  facts?: string[]
  source?: InterestSource
  taskId?: string | null
  now?: number
}

export interface UpdateInterestInput {
  facts?: string[]
  questions?: string[]
  nextStep?: string | null
  nextTool?: string | null
  requiredCapability?: string | null
  backgroundSafe?: boolean | null
  recheckCondition?: string | null
  status?: InterestStatus
  abandonedReason?: string | null
  nextRevisitMinutes?: number | null
  now?: number
}

export interface InterestMutationResult {
  ok: boolean
  code?: 'INTEREST_LIMIT' | 'INTEREST_NOT_FOUND' | 'INTEREST_INVALID' | 'MEMORY_OFF'
  message: string
  interest?: InterestRecord
  /** 达到上限时供模型选择先结束/放弃哪一项。 */
  closable?: InterestRecord[]
}

export interface InterestStoreOptions {
  file: string
  enabled: () => boolean
  limits: () => InterestLimits
  now?: () => number
  logger?: Logger
  onChange?: () => void
}

interface PersistedInterests {
  version: 1
  records: InterestRecord[]
}

/**
 * 她的长期兴趣：只保存脱敏标题/事实/问题/结束条件、`notes/...` 相对路径
 * 与不透明任务 id。原始窗口/页面/文件正文永不进入这里。
 */
export class InterestStore {
  private readonly file: string
  private readonly enabled: () => boolean
  private readonly limits: () => InterestLimits
  private readonly now: () => number
  private readonly logger: Logger | undefined
  private readonly onChange: (() => void) | undefined
  private records: InterestRecord[]

  constructor(options: InterestStoreOptions) {
    this.file = options.file
    this.enabled = options.enabled
    this.limits = options.limits
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
    this.onChange = options.onChange
    this.records = this.load()
    this.expire(this.now())
  }

  isEnabled(): boolean {
    return this.enabled()
  }

  create(input: CreateInterestInput): InterestMutationResult {
    if (!this.enabled()) return { ok: false, code: 'MEMORY_OFF', message: '记忆功能已关闭，兴趣不会保存' }
    const at = input.now ?? this.now()
    this.expire(at)
    const title = safeCompanionText(input.title, INTEREST_TITLE_MAX)
    const endCondition = safeCompanionText(input.endCondition, INTEREST_TEXT_MAX)
    if (title === '' || endCondition === '') {
      return { ok: false, code: 'INTEREST_INVALID', message: '兴趣需要标题与结束条件' }
    }
    const limits = this.clampedLimits()
    const active = this.records.filter((record) => record.status === 'active')
    if (active.length >= limits.maxActive) {
      return {
        ok: false,
        code: 'INTEREST_LIMIT',
        message: `活跃兴趣已达上限（${limits.maxActive}）。先结束或放弃一个，再开始新的。`,
        closable: active.map(cloneRecord)
      }
    }

    const facts = safeList(input.facts, INTEREST_FACTS_MAX, INTEREST_TEXT_MAX)
    const reason = safeCompanionText(input.reason ?? '', INTEREST_TEXT_MAX)
    if (reason !== '' && !facts.includes(reason)) facts.unshift(reason)
    const record: InterestRecord = {
      id: randomUUID(),
      title,
      source:
        input.source !== undefined && SOURCES.includes(input.source) ? input.source : 'autonomy',
      status: 'active',
      facts: facts.slice(0, INTEREST_FACTS_MAX),
      questions: safeList(input.questions, INTEREST_QUESTIONS_MAX, INTEREST_TEXT_MAX),
      nextStep: nullableText(input.nextStep, INTEREST_TEXT_MAX),
      nextTool: safeToolName(input.nextTool),
      requiredCapability: safeCapabilityLabel(input.requiredCapability),
      backgroundSafe:
        typeof input.backgroundSafe === 'boolean' ? input.backgroundSafe : null,
      recheckCondition: nullableText(input.recheckCondition, INTEREST_TEXT_MAX),
      endCondition,
      artifacts: [],
      taskIds: safeTaskIds(input.taskId === undefined || input.taskId === null ? [] : [input.taskId]),
      createdAt: at,
      updatedAt: at,
      lastFocusAt: null,
      nextRevisitAt: null,
      focusCount: 0,
      talkCount: 0,
      lastTalkedAt: null,
      abandonedReason: null
    }
    this.records.push(record)
    this.save()
    return { ok: true, message: `已创建兴趣「${record.title}」`, interest: cloneRecord(record) }
  }

  update(id: string, patch: UpdateInterestInput): InterestMutationResult {
    if (!this.enabled()) return { ok: false, code: 'MEMORY_OFF', message: '记忆功能已关闭' }
    const at = patch.now ?? this.now()
    this.expire(at)
    const record = this.records.find((entry) => entry.id === id)
    if (record === undefined) {
      return { ok: false, code: 'INTEREST_NOT_FOUND', message: '没有找到这个兴趣' }
    }

    if (patch.facts !== undefined) {
      record.facts = safeList(patch.facts, INTEREST_FACTS_MAX, INTEREST_TEXT_MAX)
    }
    if (patch.questions !== undefined) {
      record.questions = safeList(patch.questions, INTEREST_QUESTIONS_MAX, INTEREST_TEXT_MAX)
    }
    if (patch.nextStep !== undefined) {
      record.nextStep =
        patch.nextStep === null ? null : nullableText(patch.nextStep, INTEREST_TEXT_MAX)
    }
    if (patch.nextTool !== undefined) {
      record.nextTool = patch.nextTool === null ? null : safeToolName(patch.nextTool)
    }
    if (patch.requiredCapability !== undefined) {
      record.requiredCapability =
        patch.requiredCapability === null
          ? null
          : safeCapabilityLabel(patch.requiredCapability)
    }
    if (patch.backgroundSafe !== undefined) {
      record.backgroundSafe =
        typeof patch.backgroundSafe === 'boolean' ? patch.backgroundSafe : null
    }
    if (patch.recheckCondition !== undefined) {
      record.recheckCondition =
        patch.recheckCondition === null
          ? null
          : nullableText(patch.recheckCondition, INTEREST_TEXT_MAX)
    }
    if (patch.abandonedReason !== undefined) {
      record.abandonedReason =
        patch.abandonedReason === null
          ? null
          : nullableText(patch.abandonedReason, INTEREST_TEXT_MAX)
    }
    if (patch.nextRevisitMinutes !== undefined) {
      if (patch.nextRevisitMinutes === null || patch.nextRevisitMinutes === 0) {
        record.nextRevisitAt = null
      } else {
        const minutes = Number(patch.nextRevisitMinutes)
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 60 * 24 * 365) {
          return { ok: false, code: 'INTEREST_INVALID', message: '下次回访时间不合法' }
        }
        record.nextRevisitAt = at + Math.round(minutes * 60_000)
      }
    }
    if (patch.status !== undefined) {
      if (!STATUSES.includes(patch.status)) {
        return { ok: false, code: 'INTEREST_INVALID', message: '兴趣状态不合法' }
      }
      if (patch.status === 'active' && record.status !== 'active') {
        const limits = this.clampedLimits()
        const active = this.records.filter(
          (entry) => entry.status === 'active' && entry.id !== record.id
        )
        if (active.length >= limits.maxActive) {
          return {
            ok: false,
            code: 'INTEREST_LIMIT',
            message: `活跃兴趣已达上限（${limits.maxActive}）。先结束或放弃一个，再恢复这个。`,
            closable: active.map(cloneRecord)
          }
        }
      }
      record.status = patch.status
      if (patch.status === 'done' || patch.status === 'abandoned') {
        record.nextRevisitAt = null
        if (patch.status === 'done') record.abandonedReason = null
      }
    }

    record.updatedAt = at
    this.save()
    return { ok: true, message: `已更新兴趣「${record.title}」`, interest: cloneRecord(record) }
  }

  /** 结束/放弃指定兴趣；closeCondition 只写脱敏摘要。 */
  close(id: string, status: 'done' | 'abandoned', reason?: string): InterestMutationResult {
    return this.update(id, {
      status,
      ...(reason === undefined ? {} : { abandonedReason: reason })
    })
  }

  get(id: string): InterestRecord | undefined {
    this.expire(this.now())
    const record = this.records.find((entry) => entry.id === id)
    return record === undefined ? undefined : cloneRecord(record)
  }

  list(statuses?: InterestStatus[]): InterestRecord[] {
    this.expire(this.now())
    const allowed = statuses === undefined ? null : new Set(statuses)
    return this.records
      .filter((record) => allowed === null || allowed.has(record.status))
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(cloneRecord)
  }

  /** 注入提示：关闭记忆时为空；按最近关注/更新排序，最多 limit 条。 */
  activeForPrompt(limit = 4): InterestRecord[] {
    if (!this.enabled()) return []
    this.expire(this.now())
    return this.records
      .filter((record) => record.status === 'active')
      .sort((a, b) => (b.lastFocusAt ?? b.updatedAt) - (a.lastFocusAt ?? a.updatedAt))
      .slice(0, Math.max(0, Math.min(limit, 4)))
      .map(cloneRecord)
  }

  dueRevisits(now?: number): InterestRecord[] {
    if (!this.enabled()) return []
    const at = now ?? this.now()
    this.expire(at)
    return this.records
      .filter(
        (record) =>
          record.status === 'active' &&
          record.nextRevisitAt !== null &&
          record.nextRevisitAt <= at
      )
      .sort((a, b) => (a.nextRevisitAt ?? 0) - (b.nextRevisitAt ?? 0))
      .map(cloneRecord)
  }

  noteFocus(id: string, now?: number): InterestMutationResult {
    if (!this.enabled()) return { ok: false, code: 'MEMORY_OFF', message: '记忆功能已关闭' }
    const at = now ?? this.now()
    const record = this.records.find((entry) => entry.id === id)
    if (record === undefined) {
      return { ok: false, code: 'INTEREST_NOT_FOUND', message: '没有找到这个兴趣' }
    }
    if (record.status === 'active') {
      record.focusCount += 1
      record.lastFocusAt = at
      record.updatedAt = at
      const limits = this.clampedLimits()
      if (record.focusCount >= limits.maxFocusCount) {
        record.status = 'paused'
        record.nextRevisitAt = null
        if (record.nextStep === null) {
          record.nextStep = `已达到 ${limits.maxFocusCount} 次关注上限，先停一停`
        }
        this.save()
        return {
          ok: true,
          message: `兴趣「${record.title}」已达到 ${limits.maxFocusCount} 次关注上限，已暂停，等你决定是否继续`,
          interest: cloneRecord(record)
        }
      }
      this.save()
    }
    return { ok: true, message: `已记录对「${record.title}」的关注`, interest: cloneRecord(record) }
  }

  noteTalk(id: string, now?: number): boolean {
    if (!this.enabled()) return false
    const at = now ?? this.now()
    const record = this.records.find((entry) => entry.id === id)
    if (record === undefined) return false
    record.talkCount += 1
    record.lastTalkedAt = at
    // 聊过之后给一个默认回访点，避免主动聊天只围着同一条转。
    record.nextRevisitAt = at + 45 * 60_000
    record.updatedAt = at
    this.save()
    return true
  }

  addArtifact(id: string, path: string): boolean {
    if (!this.enabled()) return false
    const artifact = safeNoteArtifact(path)
    const record = this.records.find((entry) => entry.id === id)
    if (artifact === null || record === undefined) return false
    if (!record.artifacts.includes(artifact)) {
      record.artifacts.push(artifact)
      if (record.artifacts.length > INTEREST_ARTIFACTS_MAX) {
        record.artifacts = record.artifacts.slice(record.artifacts.length - INTEREST_ARTIFACTS_MAX)
      }
    }
    record.updatedAt = this.now()
    this.save()
    return true
  }

  addTask(id: string, taskId: string): boolean {
    if (!this.enabled()) return false
    const ids = safeTaskIds([taskId])
    const record = this.records.find((entry) => entry.id === id)
    if (ids.length === 0 || record === undefined) return false
    if (!record.taskIds.includes(ids[0]!)) {
      record.taskIds.push(ids[0]!)
      if (record.taskIds.length > INTEREST_TASKS_MAX) {
        record.taskIds = record.taskIds.slice(record.taskIds.length - INTEREST_TASKS_MAX)
      }
    }
    record.updatedAt = this.now()
    this.save()
    return true
  }

  /** 用户或记忆删除：删除标题/事实/问题/下一步/成果中匹配的记录。 */
  forgetMatching(query: string): number {
    const needle = safeCompanionText(query, 200).toLowerCase()
    if (needle === '') return 0
    const before = this.records.length
    this.records = this.records.filter((record) => {
      const haystack = [
        record.title,
        record.endCondition,
        record.nextStep ?? '',
        record.nextTool ?? '',
        record.requiredCapability ?? '',
        record.recheckCondition ?? '',
        ...record.facts,
        ...record.questions,
        ...record.artifacts,
        record.abandonedReason ?? ''
      ]
        .join('\n')
        .toLowerCase()
      return !haystack.includes(needle)
    })
    const removed = before - this.records.length
    if (removed > 0) this.save()
    return removed
  }

  /** 用户删除单个兴趣；即使记忆关闭也允许（只是本地清理）。 */
  delete(id: string): boolean {
    const before = this.records.length
    this.records = this.records.filter((record) => record.id !== id)
    const removed = this.records.length !== before
    if (removed) this.save(true)
    return removed
  }

  /** 用户清空全部兴趣。 */
  clear(): void {
    if (this.records.length === 0) return
    this.records = []
    this.save(true)
  }

  /** 设置页/诊断使用的完整快照（本地读取，不经过模型）。 */
  snapshot(): InterestRecord[] {
    this.expire(this.now())
    return this.records
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(cloneRecord)
  }

  countByStatus(): Record<InterestStatus, number> {
    this.expire(this.now())
    const out: Record<InterestStatus, number> = { active: 0, paused: 0, done: 0, abandoned: 0 }
    for (const record of this.records) out[record.status] += 1
    return out
  }

  // -------------------------------------------------------------------------

  private clampedLimits(): InterestLimits {
    const raw = this.limits()
    return {
      maxActive: clampInt(raw.maxActive, 1, 12, 4),
      ttlDays: clampInt(raw.ttlDays, 1, 365, 14),
      maxFocusCount: clampInt(raw.maxFocusCount, 1, 1000, 12)
    }
  }

  /** TTL / 关注次数到期的自动状态迁移；返回是否发生变化。 */
  private expire(now: number): void {
    const limits = this.clampedLimits()
    const ttlMs = limits.ttlDays * 24 * 60 * 60_000
    let changed = false
    for (const record of this.records) {
      if (record.status !== 'active') continue
      if (record.focusCount >= limits.maxFocusCount) {
        record.status = 'paused'
        record.nextRevisitAt = null
        record.updatedAt = now
        changed = true
        continue
      }
      const basis = record.lastFocusAt ?? record.updatedAt
      if (now - basis > ttlMs) {
        record.status = 'abandoned'
        record.abandonedReason = `超过 ${limits.ttlDays} 天没有继续，已自动放下`
        record.nextRevisitAt = null
        record.updatedAt = now
        changed = true
      }
    }
    if (changed) this.save()
  }

  private save(force = false): void {
    if (!this.enabled() && !force) return
    try {
      const data: PersistedInterests = { version: 1, records: this.records }
      atomicWrite(this.file, JSON.stringify(data, null, 2))
      this.onChange?.()
    } catch (error) {
      this.logger?.warn('兴趣保存失败', { error: String(error) })
    }
  }

  private load(): InterestRecord[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed = safeJsonParse<unknown>(readFileSync(this.file, 'utf8'))
      if (parsed === null || parsed === undefined || typeof parsed !== 'object') return []
      const rawRecords = (parsed as { records?: unknown }).records
      if (!Array.isArray(rawRecords)) return []
      const now = this.now()
      const out: InterestRecord[] = []
      for (const raw of rawRecords) {
        const record = parseInterestRecord(raw, now)
        if (record !== null) out.push(record)
      }
      return out
    } catch (error) {
      this.logger?.warn('兴趣文件损坏，已回退为空', { error: String(error) })
      return []
    }
  }
}

function parseInterestRecord(raw: unknown, now: number): InterestRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const id =
    typeof input.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(input.id) ? input.id : null
  const title = safeCompanionText(input.title, INTEREST_TITLE_MAX)
  const endCondition = safeCompanionText(input.endCondition, INTEREST_TEXT_MAX)
  if (id === null || title === '' || endCondition === '') return null
  const status = STATUSES.includes(input.status as InterestStatus)
    ? (input.status as InterestStatus)
    : 'active'
  const source = SOURCES.includes(input.source as InterestSource)
    ? (input.source as InterestSource)
    : 'event'
  const createdAt = finiteTime(input.createdAt, now)
  return {
    id,
    title,
    source,
    status,
    facts: safeList(input.facts, INTEREST_FACTS_MAX, INTEREST_TEXT_MAX),
    questions: safeList(input.questions, INTEREST_QUESTIONS_MAX, INTEREST_TEXT_MAX),
    nextStep: nullableText(input.nextStep, INTEREST_TEXT_MAX),
    nextTool: safeToolName(input.nextTool),
    requiredCapability: safeCapabilityLabel(input.requiredCapability),
    backgroundSafe:
      typeof input.backgroundSafe === 'boolean' ? input.backgroundSafe : null,
    recheckCondition: nullableText(input.recheckCondition, INTEREST_TEXT_MAX),
    endCondition,
    artifacts: safeArtifacts(input.artifacts),
    taskIds: safeTaskIds(input.taskIds),
    createdAt,
    updatedAt: finiteTime(input.updatedAt, createdAt),
    lastFocusAt: nullableTime(input.lastFocusAt),
    nextRevisitAt: nullableTime(input.nextRevisitAt),
    focusCount: nonNegativeInt(input.focusCount),
    talkCount: nonNegativeInt(input.talkCount),
    lastTalkedAt: nullableTime(input.lastTalkedAt),
    abandonedReason: nullableText(input.abandonedReason, INTEREST_TEXT_MAX)
  }
}

function safeList(input: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const item of input) {
    const text = safeCompanionText(item, maxLen)
    if (text === '' || out.includes(text)) continue
    out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

function safeArtifacts(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const item of input) {
    const path = safeNoteArtifact(item)
    if (path === null || out.includes(path)) continue
    out.push(path)
    if (out.length >= INTEREST_ARTIFACTS_MAX) break
  }
  return out
}

function safeTaskIds(input: unknown): string[] {
  const items = Array.isArray(input) ? input : []
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || out.includes(id)) continue
    out.push(id)
    if (out.length >= INTEREST_TASKS_MAX) break
  }
  return out
}

/** 只接受工具名形状，防止把路径/正文塞进候选项。 */
function safeToolName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return /^[a-z][a-z0-9_]{1,60}$/.test(name) ? name : null
}

/** 能力标签是枚举式短标识（如 file.read、web），不接受自由文本。 */
function safeCapabilityLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.trim()
  return /^[a-z][a-z0-9_.-]{1,60}$/.test(label) ? label : null
}

function nullableText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null
  const text = safeCompanionText(value, max)
  return text === '' ? null : text
}

function nullableTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function finiteTime(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function cloneRecord(record: InterestRecord): InterestRecord {
  return {
    ...record,
    facts: [...record.facts],
    questions: [...record.questions],
    artifacts: [...record.artifacts],
    taskIds: [...record.taskIds]
  }
}
