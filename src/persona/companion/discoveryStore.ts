import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { Logger } from '../../core/types'
import { atomicWrite, safeJsonParse } from '../../core/util'
import {
  DISCOVERY_EVIDENCE_LABELS,
  DISCOVERY_SITE_BILIBILI,
  DISCOVERY_SITE_WEB,
  canonicalUrlForBili,
  discoveryCardUrl,
  discoveryDedupeKey,
  discoveryKindForSite,
  parseBiliVideoUrl,
  parsePublicWebUrl,
  webDiscoveryDedupeKey,
  type DiscoveryCardView,
  type DiscoveryEvidenceLevel,
  type DiscoveryFeedbackKind,
  type DiscoveryKind,
  type DiscoveryObservationInput,
  type DiscoveryObservationToken,
  type DiscoveryRecord,
  type DiscoveryShareState,
  type DiscoverySite,
  type SaveDiscoveryInput,
  type SaveDiscoveryResult
} from '../../shared/discovery'
import { safeCompanionText } from './sanitize'

export const DISCOVERY_TITLE_MAX = 160
export const DISCOVERY_AUTHOR_MAX = 80
export const DISCOVERY_REASON_MAX = 120
export const DISCOVERY_SUMMARY_MAX = 300
export const DISCOVERY_TAGS_MAX = 6
export const DISCOVERY_TAG_MAX = 24
export const DISCOVERY_INTERESTS_MAX = 4
export const DISCOVERY_EVIDENCE_REFS_MAX = 8
export const DISCOVERY_OBSERVATION_TTL_MS = 45 * 60_000
export const DISCOVERY_OBSERVATION_MAX = 60

const SHARE_STATES: readonly DiscoveryShareState[] = [
  'discovered',
  'pending-share',
  'shared',
  'opened'
]
const BILI_EVIDENCE_LEVELS: readonly DiscoveryEvidenceLevel[] = [
  'metadata',
  'description',
  'subtitle-partial',
  'subtitle',
  'transcript',
  'video-frames'
]
const WEB_EVIDENCE_LEVELS: readonly DiscoveryEvidenceLevel[] = ['link', 'excerpt', 'content']
const FEEDBACK_KINDS: readonly DiscoveryFeedbackKind[] = ['like', 'less', 'drop-topic']

export interface DiscoveryLimits {
  retentionDays: number
  maxRecords: number
}

export interface DiscoveryStoreOptions {
  file: string
  enabled: () => boolean
  limits: () => DiscoveryLimits
  now?: () => number
  logger?: Logger
  /** 记录变化（含删除/清理）；用于让 Episode 清理失效的 discoveryId 关联。 */
  onChange?: () => void
}

export interface DiscoveryMutationResult {
  ok: boolean
  code?: 'DISCOVERY_NOT_FOUND' | 'DISCOVERY_INVALID'
  message: string
  discovery?: DiscoveryRecord
}

interface PersistedDiscoveries {
  version: 1
  records: DiscoveryRecord[]
}

interface ObservationEntry extends DiscoveryObservationToken {
  site: DiscoverySite
  kind: DiscoveryKind
  domain: string
  videoId: string
  partId: number | null
  canonicalUrl: string
  title: string
  author: string
  hasDescription: boolean
  tags: string[]
  subtitleStatus: 'none' | 'partial' | 'full'
  subtitleCoverage: number | null
  /** 仅本地使用的证据引用（例如转写 jobId、抽帧时间）；不进入模型文本。 */
  extraRefs: string[]
}

/**
 * 受限发现存储。
 *
 * 与 InterestStore 相同的边界习惯：只保存脱敏公开元数据、规范链接和
 * 模型生成的短理由/摘要；原始 HTML、整页 DOM、完整字幕、截图与登录信息
 * 永不进入这里。保存必须绑定一次真实页面观察产生的内存 token，模型不能
 * 自己填 URL 或自称读过字幕。
 */
export class DiscoveryStore {
  private readonly file: string
  private readonly enabled: () => boolean
  private readonly limits: () => DiscoveryLimits
  private readonly now: () => number
  private readonly logger: Logger | undefined
  private readonly onChange: (() => void) | undefined
  private records: DiscoveryRecord[]
  private readonly observations = new Map<string, ObservationEntry>()

  constructor(options: DiscoveryStoreOptions) {
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

  /** 页面观察：返回一次性凭据；token 只在本次进程内存中有效。 */
  noteObservation(input: DiscoveryObservationInput): DiscoveryObservationToken | null {
    const at = input.now ?? this.now()
    this.pruneObservations(at)
    const title = safeCompanionText(input.title, DISCOVERY_TITLE_MAX)
    if (title === '') return null
    const author = safeCompanionText(input.author ?? '', DISCOVERY_AUTHOR_MAX)

    if (input.site === DISCOVERY_SITE_WEB) {
      const ref = parsePublicWebUrl(input.url)
      if (ref === null) return null
      // 普通网页发现不借用字幕枚举：只看链接/摘要、部分正文、正文范围。
      const hasExcerpt = safeCompanionText(input.excerpt ?? '', 400).length > 0
      const contentRead = input.contentRead === true && hasExcerpt
      const evidenceLevel: DiscoveryEvidenceLevel = contentRead
        ? 'content'
        : hasExcerpt
          ? 'excerpt'
          : 'link'
      return this.putObservation({
        at,
        site: DISCOVERY_SITE_WEB,
        domain: ref.domain,
        videoId: '',
        partId: null,
        canonicalUrl: ref.canonicalUrl,
        title,
        author,
        hasDescription: safeCompanionText(input.description ?? '', 400).length > 0,
        tags: safeTags(input.tags),
        subtitleStatus: 'none',
        subtitleCoverage: null,
        evidenceLevel,
        extraRefs: []
      })
    }

    const videoId = typeof input.videoId === 'string' ? input.videoId.trim() : ''
    if (!/^BV[0-9A-Za-z]{10}$/.test(videoId)) return null
    const partId =
      input.partId === null || input.partId === undefined
        ? null
        : Number.isInteger(input.partId) && input.partId >= 1 && input.partId <= 999
          ? input.partId
          : null
    const hasDescription = safeCompanionText(input.description ?? '', 400).length > 0
    const tags = safeTags(input.tags)
    const subtitle = input.subtitle
    const subtitleStatus =
      subtitle?.status === 'full' || subtitle?.status === 'partial' ? subtitle.status : 'none'
    const subtitleCoverage = normalizeCoverage(subtitle?.coverage ?? null)
    const transcriptChars =
      input.transcript?.status === 'succeeded' && typeof input.transcript.chars === 'number'
        ? Math.max(0, Math.trunc(input.transcript.chars))
        : 0
    const framesDelivered =
      typeof input.visionFrames?.delivered === 'number'
        ? Math.max(0, Math.min(6, Math.trunc(input.visionFrames.delivered)))
        : 0
    const extraRefs: string[] = []
    if (transcriptChars > 0) extraRefs.push(`transcript:${transcriptChars}`)
    if (framesDelivered > 0) {
      const times = (input.visionFrames?.times ?? [])
        .filter((time) => Number.isFinite(time) && time >= 0)
        .slice(0, 6)
        .map((time) => Math.round(time))
      extraRefs.push(`frames:${framesDelivered}${times.length === 0 ? '' : `@${times.join(',')}`}`)
    }
    // 证据等级由宿主按“实际读到什么”决定；模型自报只影响理由/摘要。
    const evidenceLevel: DiscoveryEvidenceLevel =
      subtitleStatus === 'full' && subtitleCoverage !== null && subtitleCoverage >= 0.9
        ? 'subtitle'
        : transcriptChars > 0
          ? 'transcript'
          : framesDelivered > 0
            ? 'video-frames'
            : subtitleStatus !== 'none'
              ? 'subtitle-partial'
              : hasDescription
                ? 'description'
                : 'metadata'
    const canonicalUrl = canonicalUrlForBili(videoId, partId)
    if (canonicalUrl === null) return null
    return this.putObservation({
      at,
      site: DISCOVERY_SITE_BILIBILI,
      domain: 'www.bilibili.com',
      videoId,
      partId,
      canonicalUrl,
      title,
      author,
      hasDescription,
      tags,
      subtitleStatus,
      subtitleCoverage,
      evidenceLevel,
      extraRefs
    })
  }

  private putObservation(input: {
    at: number
    site: DiscoverySite
    domain: string
    videoId: string
    partId: number | null
    canonicalUrl: string
    title: string
    author: string
    hasDescription: boolean
    tags: string[]
    subtitleStatus: 'none' | 'partial' | 'full'
    subtitleCoverage: number | null
    evidenceLevel: DiscoveryEvidenceLevel
    extraRefs: string[]
  }): DiscoveryObservationToken {
    const observationId = `obs-${randomUUID()}`
    const expiresAt = input.at + DISCOVERY_OBSERVATION_TTL_MS
    this.observations.set(observationId, {
      observationId,
      expiresAt,
      evidenceLevel: input.evidenceLevel,
      site: input.site,
      kind: discoveryKindForSite(input.site),
      domain: input.domain,
      videoId: input.videoId,
      partId: input.partId,
      canonicalUrl: input.canonicalUrl,
      title: input.title,
      author: input.author,
      hasDescription: input.hasDescription,
      tags: input.tags,
      subtitleStatus: input.subtitleStatus,
      subtitleCoverage: input.subtitleCoverage,
      extraRefs: input.extraRefs
    })
    return { observationId, expiresAt, evidenceLevel: input.evidenceLevel }
  }

  /**
   * 停止浏览时废弃所有尚未使用的页面观察 token。
   *
   * 在途回合可能已经拿到 observationId；停止后它不能再把停止前的页面读取
   * 保存成新发现。需要时只能重新开始一次真实浏览再观察。
   */
  /**
   * 作废尚未保存的页面观察。传入 site 时只清理该来源，避免停止普通网页浏览
   * 误删独立 B 站的观察凭据（反之亦然）；省略时保留旧的“全部清理”语义。
   */
  clearObservations(site?: DiscoverySite): number {
    if (site === undefined) {
      const count = this.observations.size
      this.observations.clear()
      return count
    }
    let count = 0
    for (const [id, entry] of this.observations) {
      if (entry.site !== site) continue
      this.observations.delete(id)
      count += 1
    }
    return count
  }

  /** 模型只能引用观察 token；标题/链接/作者/证据都由本地观察数据决定。 */
  save(input: SaveDiscoveryInput): SaveDiscoveryResult {
    const at = input.now ?? this.now()
    this.prune(at)
    this.pruneObservations(at)
    const observationId = typeof input.observationId === 'string' ? input.observationId.trim() : ''
    const observation = this.observations.get(observationId)
    if (observation === undefined) {
      return {
        ok: false,
        code: 'DISCOVERY_STALE',
        message: '这次页面观察已过期，请重新读取当前视频后再保存'
      }
    }
    const reason = safeCompanionText(input.reason, DISCOVERY_REASON_MAX)
    if (reason === '') {
      return { ok: false, code: 'DISCOVERY_INVALID', message: '保存发现需要一句她自己的理由' }
    }
    const summary = safeCompanionText(input.summary ?? '', DISCOVERY_SUMMARY_MAX)
    const topicTags = safeTags(input.topicTags, observation.tags)
    const interestIds = safeIds(input.interestIds, DISCOVERY_INTERESTS_MAX)
    // 同一视频/分 P 可能先后产生多个观察（详情、字幕、抽帧、转写）。模型
    // 若引用较早的 observationId，不能因此把已经读到的更强证据降级；这里
    // 取同一去重键下证据最高的未过期观察，等级仍完全由宿主决定。
    const key = observationDedupeKey(observation)
    let best = observation
    for (const entry of this.observations.values()) {
      if (entry.expiresAt <= at) continue
      if (observationDedupeKey(entry) !== key) continue
      if (evidenceRank(entry.evidenceLevel) >= evidenceRank(best.evidenceLevel)) best = entry
    }
    // token 是一次性的：保存成功后同一视频的观察凭据全部作废，不能反复伪造。
    for (const [id, entry] of this.observations) {
      if (observationDedupeKey(entry) === key) this.observations.delete(id)
    }
    return this.saveObservationRecord(best, {
      at,
      reason,
      summary,
      topicTags,
      interestIds,
      canonicalUrl: best.canonicalUrl
    })
  }

  private saveObservationRecord(
    observation: ObservationEntry,
    input: {
      at: number
      reason: string
      summary: string
      topicTags: string[]
      interestIds: string[]
      canonicalUrl: string
    }
  ): SaveDiscoveryResult {
    const key = observationDedupeKey(observation)
    const existing = this.records.find((record) => recordDedupeKey(record) === key)
    if (existing !== undefined) {
      existing.lastCheckedAt = input.at
      if (existing.author === '' && observation.author !== '') existing.author = observation.author
      if (evidenceRank(observation.evidenceLevel) > evidenceRank(existing.evidenceLevel)) {
        existing.evidenceLevel = observation.evidenceLevel
        existing.subtitleCoverage = observation.subtitleCoverage
      }
      if (
        existing.shareState === 'discovered' ||
        existing.shareState === 'pending-share'
      ) {
        existing.reason = input.reason
        if (input.summary !== '') existing.summary = input.summary
        existing.topicTags = mergeList(existing.topicTags, input.topicTags, DISCOVERY_TAGS_MAX)
        existing.interestIds = mergeList(
          existing.interestIds,
          input.interestIds,
          DISCOVERY_INTERESTS_MAX
        )
      }
      existing.evidenceRefs = mergeList(
        existing.evidenceRefs,
        [observation.observationId, ...observation.extraRefs],
        DISCOVERY_EVIDENCE_REFS_MAX
      )
      this.persist()
      return {
        ok: true,
        message: `这条内容已在她的发现列表里，已合并观察（${DISCOVERY_EVIDENCE_LABELS[existing.evidenceLevel]}）`,
        discovery: cloneRecord(existing),
        merged: true
      }
    }

    const limits = this.clampedLimits()
    if (this.records.length >= limits.maxRecords) {
      // 超限先按最久未验证/发现时间清理；仍是满额则拒绝新增，不能悄悄挤掉
      // 用户关心的旧记录。
      this.prune(input.at)
      if (this.records.length >= limits.maxRecords) {
        this.evictOne(input.at)
      }
    }
    const record: DiscoveryRecord = {
      id: randomUUID(),
      site: observation.site,
      kind: observation.kind,
      domain: observation.domain,
      videoId: observation.videoId,
      partId: observation.partId,
      canonicalUrl: input.canonicalUrl,
      title: observation.title,
      author: observation.author,
      discoveredAt: input.at,
      lastCheckedAt: input.at,
      interestIds: input.interestIds,
      topicTags: input.topicTags,
      reason: input.reason,
      summary: input.summary,
      evidenceLevel: observation.evidenceLevel,
      subtitleCoverage: observation.subtitleCoverage,
      evidenceRefs: [observation.observationId, ...observation.extraRefs],
      shareState: 'discovered',
      sharedAt: null,
      openedAt: null,
      feedback: null,
      feedbackAt: null,
      ephemeral: !this.enabled()
    }
    this.records.push(record)
    this.persist()
    return {
      ok: true,
      message: `已加入她的发现列表（${DISCOVERY_EVIDENCE_LABELS[record.evidenceLevel]}）`,
      discovery: cloneRecord(record),
      merged: false
    }
  }

  list(): DiscoveryRecord[] {
    this.prune(this.now())
    return this.records
      .slice()
      .sort((a, b) => b.discoveredAt - a.discoveredAt || a.id.localeCompare(b.id))
      .map(cloneRecord)
  }

  /** 设置页使用的视图；memoryOnly 是本次运行创建、不会落盘的记录。 */
  card(id: string): DiscoveryCardView | null {
    this.prune(this.now())
    const record = this.records.find((entry) => entry.id === id)
    return record === undefined ? null : toCardView(record)
  }

  cards(): DiscoveryCardView[] {
    return this.list().map(toCardView)
  }

  get(id: string): DiscoveryRecord | null {
    const record = this.records.find((entry) => entry.id === id)
    return record === undefined ? null : cloneRecord(record)
  }

  findByUrl(rawUrl: string): DiscoveryRecord | null {
    const bili = parseBiliVideoUrl(rawUrl)
    if (bili !== null) return this.getByVideo(bili.videoId, bili.partId)
    const web = parsePublicWebUrl(rawUrl)
    if (web === null) return null
    return this.getByWebUrl(web.canonicalUrl)
  }

  getByVideo(videoId: string, partId: number | null): DiscoveryRecord | null {
    const key = discoveryDedupeKey(DISCOVERY_SITE_BILIBILI, videoId, partId)
    const record = this.records.find((entry) => recordDedupeKey(entry) === key)
    return record === undefined ? null : cloneRecord(record)
  }

  getByWebUrl(canonicalUrl: string): DiscoveryRecord | null {
    const key = webDiscoveryDedupeKey(canonicalUrl)
    if (key === null) return null
    const record = this.records.find((entry) => recordDedupeKey(entry) === key)
    return record === undefined ? null : cloneRecord(record)
  }

  ids(): string[] {
    return this.records.map((record) => record.id)
  }

  count(): number {
    this.prune(this.now())
    return this.records.length
  }

  hasEphemeral(): boolean {
    return this.records.some((record) => record.ephemeral === true)
  }

  /** 提示词只给少量未分享、仍有效的新发现，不倾倒整份列表。 */
  unsharedForPrompt(limit = 4): DiscoveryRecord[] {
    this.prune(this.now())
    const capped = Math.max(1, Math.min(8, Math.trunc(limit)))
    return this.records
      .filter((record) => record.shareState === 'discovered')
      .sort((a, b) => b.discoveredAt - a.discoveredAt)
      .slice(0, capped)
      .map(cloneRecord)
  }

  recentFeedback(limit = 5): DiscoveryRecord[] {
    this.prune(this.now())
    const capped = Math.max(1, Math.min(20, Math.trunc(limit)))
    return this.records
      .filter((record) => record.feedback !== null)
      .sort((a, b) => (b.feedbackAt ?? 0) - (a.feedbackAt ?? 0))
      .slice(0, capped)
      .map(cloneRecord)
  }

  markPendingShare(id: string): DiscoveryMutationResult {
    return this.mutate(id, (record) => {
      if (record.shareState === 'shared' || record.shareState === 'opened') return false
      record.shareState = 'pending-share'
      return true
    })
  }

  /** 只有气泡真实展示成功后才调用；失败/取消用 markDiscovered 回退。 */
  markShared(id: string): DiscoveryMutationResult {
    const at = this.now()
    return this.mutate(id, (record) => {
      if (record.shareState !== 'pending-share') return false
      record.shareState = 'shared'
      record.sharedAt = at
      return true
    })
  }

  markDiscovered(id: string): DiscoveryMutationResult {
    return this.mutate(id, (record) => {
      if (record.shareState !== 'pending-share') return false
      record.shareState = 'discovered'
      return true
    })
  }

  /** 用户自行打开链接：只记录“打开过”，不推断喜欢或看完。 */
  markOpened(id: string): DiscoveryMutationResult {
    const at = this.now()
    return this.mutate(id, (record) => {
      if (record.shareState === 'opened') return false
      record.shareState = 'opened'
      record.openedAt = at
      return true
    })
  }

  noteFeedback(id: string, kind: DiscoveryFeedbackKind): DiscoveryMutationResult {
    if (!FEEDBACK_KINDS.includes(kind)) {
      return { ok: false, code: 'DISCOVERY_INVALID', message: '未知的反馈类型' }
    }
    const at = this.now()
    return this.mutate(id, (record) => {
      record.feedback = kind
      record.feedbackAt = at
      return true
    })
  }

  /** 用户删除单条；即便记忆关闭也允许，只做本地清理。 */
  delete(id: string): boolean {
    const before = this.records.length
    this.records = this.records.filter((record) => record.id !== id)
    const removed = this.records.length !== before
    if (removed) {
      // 即使落盘失败，内存里的删除也必须通知 Episode 关联失效，因此显式通知一次。
      this.persist(true, false)
      this.onChange?.()
    }
    return removed
  }

  clear(): boolean {
    if (this.records.length === 0) return false
    this.records = []
    this.persist(true, false)
    this.onChange?.()
    return true
  }

  /** 用户记忆删除：匹配标题/作者/理由/摘要/标签。 */
  forgetMatching(query: string): number {
    const needle = safeCompanionText(query, 200).toLowerCase()
    if (needle === '') return 0
    const before = this.records.length
    this.records = this.records.filter((record) => {
      const haystack = [
        record.title,
        record.author,
        record.reason,
        record.summary,
        ...record.topicTags
      ]
        .join('\n')
        .toLowerCase()
      return !haystack.includes(needle)
    })
    const removed = before - this.records.length
    if (removed > 0) {
      this.persist(true, false)
      this.onChange?.()
    }
    return removed
  }

  // -------------------------------------------------------------------------

  private mutate(
    id: string,
    apply: (record: DiscoveryRecord) => boolean
  ): DiscoveryMutationResult {
    this.prune(this.now())
    const record = this.records.find((entry) => entry.id === id)
    if (record === undefined) {
      return { ok: false, code: 'DISCOVERY_NOT_FOUND', message: '没有找到这条发现' }
    }
    if (!apply(record)) {
      return { ok: true, message: '这条发现已经是该状态', discovery: cloneRecord(record) }
    }
    this.persist()
    return { ok: true, message: '已更新这条发现', discovery: cloneRecord(record) }
  }

  private clampedLimits(): DiscoveryLimits {
    const raw = this.limits()
    return {
      retentionDays: clampInt(raw.retentionDays, 1, 90, 30),
      maxRecords: clampInt(raw.maxRecords, 10, 500, 200)
    }
  }

  /** 到期清理 + 超额兜底；确定性排序，不依赖文件顺序。 */
  private prune(now: number): void {
    const limits = this.clampedLimits()
    const cutoff = now - limits.retentionDays * 24 * 60 * 60_000
    const before = this.records.length
    this.records = this.records.filter((record) => record.lastCheckedAt >= cutoff)
    while (this.records.length > limits.maxRecords) {
      const oldest = this.records
        .slice()
        .sort(
          (a, b) =>
            a.lastCheckedAt - b.lastCheckedAt ||
            a.discoveredAt - b.discoveredAt ||
            a.id.localeCompare(b.id)
        )[0]
      if (oldest === undefined) break
      this.records = this.records.filter((record) => record !== oldest)
    }
    if (this.records.length !== before) this.persist()
  }

  private evictOne(now: number): void {
    const oldest = this.records
      .slice()
      .sort(
        (a, b) =>
          a.discoveredAt - b.discoveredAt ||
          a.lastCheckedAt - b.lastCheckedAt ||
          a.id.localeCompare(b.id)
      )[0]
    if (oldest === undefined) return
    this.records = this.records.filter((record) => record !== oldest)
    this.logger?.info('发现列表达到上限，已按最旧记录淘汰', { now })
  }

  private pruneObservations(now: number): void {
    for (const [id, entry] of this.observations) {
      if (entry.expiresAt <= now) this.observations.delete(id)
    }
    while (this.observations.size > DISCOVERY_OBSERVATION_MAX) {
      const oldest = this.observations.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.observations.delete(oldest)
    }
  }

  private persist(force = false, notify = true): void {
    if (!this.enabled() && !force) return
    try {
      // 记忆关闭时创建的记录标记为 ephemeral，永不写入磁盘。
      const data: PersistedDiscoveries = {
        version: 1,
        records: this.records.filter((record) => !record.ephemeral).map(stripRuntime)
      }
      atomicWrite(this.file, JSON.stringify(data, null, 2))
      if (notify) this.onChange?.()
    } catch (error) {
      this.logger?.warn('发现记录保存失败', { error: String(error) })
    }
  }

  private load(): DiscoveryRecord[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed = safeJsonParse<unknown>(readFileSync(this.file, 'utf8'))
      if (parsed === null || parsed === undefined || typeof parsed !== 'object') return []
      const rawRecords = (parsed as { records?: unknown }).records
      if (!Array.isArray(rawRecords)) return []
      const now = this.now()
      const out: DiscoveryRecord[] = []
      for (const raw of rawRecords) {
        const record = parseDiscoveryRecord(raw, now)
        if (record !== null) out.push(record)
      }
      return out
    } catch (error) {
      this.logger?.warn('发现文件损坏，已回退为空', { error: String(error) })
      return []
    }
  }
}

function toCardView(record: DiscoveryRecord): DiscoveryCardView {
  return {
    id: record.id,
    site: record.site,
    kind: record.kind,
    domain: record.domain,
    videoId: record.videoId,
    partId: record.partId,
    url: discoveryCardUrl(record),
    title: record.title,
    author: record.author,
    reason: record.reason,
    summary: record.summary,
    topicTags: record.topicTags.slice(),
    evidenceLevel: record.evidenceLevel,
    evidenceLabel: DISCOVERY_EVIDENCE_LABELS[record.evidenceLevel],
    subtitleCoverage: record.subtitleCoverage,
    shareState: record.shareState,
    discoveredAt: record.discoveredAt,
    feedback: record.feedback,
    memoryOnly: record.ephemeral === true
  }
}

function evidenceRank(level: DiscoveryEvidenceLevel): number {
  switch (level) {
    case 'metadata':
    case 'link':
      return 0
    case 'description':
    case 'excerpt':
      return 1
    case 'subtitle-partial':
    case 'content':
      return 2
    case 'video-frames':
      return 3
    case 'transcript':
      return 4
    case 'subtitle':
      return 5
  }
}

function observationDedupeKey(observation: Pick<ObservationEntry, 'site' | 'videoId' | 'partId' | 'canonicalUrl'>): string | null {
  return observation.site === DISCOVERY_SITE_WEB
    ? webDiscoveryDedupeKey(observation.canonicalUrl)
    : discoveryDedupeKey(observation.site, observation.videoId, observation.partId)
}

function recordDedupeKey(record: Pick<DiscoveryRecord, 'site' | 'videoId' | 'partId' | 'canonicalUrl'>): string | null {
  return record.site === DISCOVERY_SITE_WEB
    ? webDiscoveryDedupeKey(record.canonicalUrl)
    : discoveryDedupeKey(record.site, record.videoId, record.partId)
}

function normalizeCoverage(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000))
}

function safeTags(input: unknown, fallback: string[] = []): string[] {
  const values = Array.isArray(input) ? input : fallback
  const out: string[] = []
  for (const value of values) {
    const tag = safeCompanionText(value, DISCOVERY_TAG_MAX).replace(/^#/, '')
    if (tag === '' || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= DISCOVERY_TAGS_MAX) break
  }
  return out
}

function safeIds(input: unknown, max: number): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const value of input) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id) || out.includes(id)) continue
    out.push(id)
    if (out.length >= max) break
  }
  return out
}

function mergeList(base: string[], extra: string[], max: number): string[] {
  const out = base.slice()
  for (const value of extra) {
    if (out.includes(value)) continue
    out.push(value)
    if (out.length >= max) break
  }
  return out.slice(-max)
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback
}

function finiteTime(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function nullableTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function cloneRecord(record: DiscoveryRecord): DiscoveryRecord {
  return {
    ...record,
    interestIds: record.interestIds.slice(),
    topicTags: record.topicTags.slice(),
    evidenceRefs: record.evidenceRefs.slice()
  }
}

function stripRuntime(record: DiscoveryRecord): DiscoveryRecord {
  const { ephemeral: _ephemeral, ...rest } = record
  return rest
}

function parseDiscoveryRecord(raw: unknown, now: number): DiscoveryRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const id = typeof input.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(input.id) ? input.id : null
  const title = safeCompanionText(input.title, DISCOVERY_TITLE_MAX)
  const reason = safeCompanionText(input.reason, DISCOVERY_REASON_MAX)
  if (id === null || title === '' || reason === '') return null
  // 旧记录没有 site/kind/domain 字段：按 B 站视频解析，保持 id/分享状态/时间不变。
  const site: DiscoverySite = input.site === DISCOVERY_SITE_WEB ? DISCOVERY_SITE_WEB : DISCOVERY_SITE_BILIBILI
  const biliRef = site === DISCOVERY_SITE_BILIBILI ? parseBiliVideoUrl(input.canonicalUrl) : null
  const webRef =
    site === DISCOVERY_SITE_WEB && parseBiliVideoUrl(input.canonicalUrl) === null
      ? parsePublicWebUrl(input.canonicalUrl)
      : null
  if (site === DISCOVERY_SITE_BILIBILI && biliRef === null) return null
  if (site === DISCOVERY_SITE_WEB && webRef === null) return null
  const discoveredAt = finiteTime(input.discoveredAt, now)
  const shareState = SHARE_STATES.includes(input.shareState as DiscoveryShareState)
    ? (input.shareState as DiscoveryShareState)
    : 'discovered'
  const allowedEvidence = site === DISCOVERY_SITE_WEB ? WEB_EVIDENCE_LEVELS : BILI_EVIDENCE_LEVELS
  const evidenceLevel = allowedEvidence.includes(input.evidenceLevel as DiscoveryEvidenceLevel)
    ? (input.evidenceLevel as DiscoveryEvidenceLevel)
    : site === DISCOVERY_SITE_WEB
      ? 'link'
      : 'metadata'
  const feedback = FEEDBACK_KINDS.includes(input.feedback as DiscoveryFeedbackKind)
    ? (input.feedback as DiscoveryFeedbackKind)
    : null
  return {
    id,
    site,
    kind: discoveryKindForSite(site),
    domain: site === DISCOVERY_SITE_WEB ? webRef!.domain : 'www.bilibili.com',
    videoId: site === DISCOVERY_SITE_BILIBILI ? biliRef!.videoId : '',
    partId: site === DISCOVERY_SITE_BILIBILI ? biliRef!.partId : null,
    canonicalUrl: site === DISCOVERY_SITE_BILIBILI ? biliRef!.canonicalUrl : webRef!.canonicalUrl,
    title,
    author: safeCompanionText(input.author, DISCOVERY_AUTHOR_MAX),
    discoveredAt,
    lastCheckedAt: finiteTime(input.lastCheckedAt, discoveredAt),
    interestIds: safeIds(input.interestIds, DISCOVERY_INTERESTS_MAX),
    topicTags: safeTags(input.topicTags),
    reason,
    summary: safeCompanionText(input.summary, DISCOVERY_SUMMARY_MAX),
    evidenceLevel,
    subtitleCoverage:
      site === DISCOVERY_SITE_BILIBILI
        ? normalizeCoverage(typeof input.subtitleCoverage === 'number' ? input.subtitleCoverage : null)
        : null,
    evidenceRefs: safeIds(input.evidenceRefs, DISCOVERY_EVIDENCE_REFS_MAX),
    shareState,
    sharedAt: nullableTime(input.sharedAt),
    openedAt: nullableTime(input.openedAt),
    feedback,
    feedbackAt: nullableTime(input.feedbackAt),
    ephemeral: false
  }
}
