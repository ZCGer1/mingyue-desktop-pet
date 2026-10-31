import type { Logger } from './types'

/**
 * 主动表达候选的统一协议。
 *
 * 探索发现、屏幕场景、任务进展和自然聊天到期最终都可能变成一句主动气泡。
 * 这里不生成台词，也不重新实现各来源的预算/权限；它只要求所有来源在真正
 * 开口前带着同一组可核对的事实进入唯一表达闸门：
 *
 * - 来源与真实依据引用（发现 id、观察 id、任务 id），不复制正文；
 * - 话题 id 用于判断是不是同一件事；
 * - 时间与过期时刻用于丢弃迟到/过时候选；
 * - 是否可打断用户当前 turn；
 * - 是否已经展示过。
 *
 * 硬规则（过期、已分享、用户正在说话、已有待回答问题、重复话题）在这里
 * 统一判断；语义上“值不值得说”仍由模型决定。展示成功与否以 PetWorld 的
 * `displayed` 回执为准，不能因为生成了文本就标记 shared。
 */

export type CompanionCandidateSource =
  | 'autonomy'
  | 'task'
  | 'discovery'
  | 'screen'
  | 'interest-revisit'
  | 'cadence'

export type CompanionEvidenceKind =
  | 'discovery'
  | 'task'
  | 'observation'
  | 'episode'
  | 'none'

export interface CompanionCandidate {
  /** 运行时 id；只用于候选台账，不进入提示词或持久化。 */
  id: string
  source: CompanionCandidateSource
  evidenceKind: CompanionEvidenceKind
  /** 真实依据 id；没有依据时为 null。绝不存放正文。 */
  evidenceRef: string | null
  /** 同一话题的稳定标识；用于阻止同一发现/观察连续刷屏。 */
  topicId: string | null
  createdAt: number
  /** null 表示不因时间本身过期；仍会受用户 turn/待回答问题等规则约束。 */
  expiresAt: number | null
  /** 是否允许在用户当前 turn 中插话；后台发现/屏幕评论默认 false。 */
  interruptible: boolean
  /** 依据已经在之前成功展示过；平台回执更新。 */
  shared: boolean
  kind: 'comment' | 'question' | 'proposal' | 'task_update'
}

export type CompanionCandidateDecision = 'admit' | 'defer' | 'drop'

export type CompanionCandidateReason =
  | 'admitted'
  | 'expired'
  | 'already-shared'
  | 'user-turn'
  | 'pending-question'
  | 'duplicate-topic'

export interface CompanionAdmissionContext {
  now: number
  /** Core 当前批是否由用户消息触发。 */
  userTurnActive: boolean
  /** 是否已有等待用户回答的主动问题。 */
  hasOpenQuestion: boolean
}

export interface CompanionAdmission {
  decision: CompanionCandidateDecision
  reason: CompanionCandidateReason
}

interface CandidateEntry {
  candidate: CompanionCandidate
  decision: CompanionCandidateDecision
  reason: CompanionCandidateReason
  decidedAt: number
  episodeId: string | null
  displayedAt: number | null
}

const MAX_ENTRIES = 64
/** 已展示话题的去重窗口；只影响主动表达，不影响发现本身的保留。 */
const DISPLAYED_TOPIC_TTL_MS = 6 * 60 * 60_000

export class CompanionCandidateBoard {
  private readonly entries: CandidateEntry[] = []
  private readonly now: () => number
  private readonly logger: Logger | null
  private readonly displayedTopics = new Map<string, number>()

  constructor(options: { now?: () => number; logger?: Logger } = {}) {
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger ?? null
  }

  /**
   * 唯一表达仲裁。只执行硬规则；不会自行调用模型或展示气泡。
   * 同一候选重复提交时返回第一次的决定，避免重试路径绕过去重。
   */
  admit(
    candidate: CompanionCandidate,
    context: CompanionAdmissionContext
  ): CompanionAdmission {
    const existing = this.entries.find((entry) => entry.candidate.id === candidate.id)
    if (existing !== undefined) {
      return { decision: existing.decision, reason: existing.reason }
    }
    const decision = this.decide(candidate, context)
    this.record(candidate, decision, context.now)
    return decision
  }

  private decide(
    candidate: CompanionCandidate,
    context: CompanionAdmissionContext
  ): CompanionAdmission {
    if (candidate.expiresAt !== null && candidate.expiresAt <= context.now) {
      return { decision: 'drop', reason: 'expired' }
    }
    if (candidate.shared) {
      return { decision: 'drop', reason: 'already-shared' }
    }
    if (context.userTurnActive && !candidate.interruptible) {
      return { decision: 'defer', reason: 'user-turn' }
    }
    if (context.hasOpenQuestion && candidate.kind === 'question') {
      return { decision: 'defer', reason: 'pending-question' }
    }
    // 任务进展是同一话题的“下一步”，不是复述上周期的开场；允许模型在
    // 真实进展后继续汇报，其余来源仍按话题去重。
    if (
      candidate.kind !== 'task_update' &&
      candidate.topicId !== null &&
      this.displayedTopicAt(candidate.topicId, context.now) !== null
    ) {
      return { decision: 'drop', reason: 'duplicate-topic' }
    }
    return { decision: 'admit', reason: 'admitted' }
  }

  private record(
    candidate: CompanionCandidate,
    decision: CompanionAdmission,
    at: number
  ): void {
    this.entries.push({
      candidate: { ...candidate },
      decision: decision.decision,
      reason: decision.reason,
      decidedAt: at,
      episodeId: null,
      displayedAt: null
    })
    this.prune(at)
    if (decision.decision !== 'admit') {
      // 只记固定枚举与依据类别，不记开场文本。
      this.logger?.debug('主动候选未进入表达', {
        source: candidate.source,
        decision: decision.decision,
        reason: decision.reason,
        evidenceKind: candidate.evidenceKind
      })
    }
  }

  /** 气泡建立后把候选与 Episode 关联；展示回执到达时据此更新已分享状态。 */
  bindEpisode(episodeId: string, candidateId: string): void {
    const entry = this.entries.find((item) => item.candidate.id === candidateId)
    if (entry !== undefined) entry.episodeId = episodeId
  }

  /** 真实页面回执：只有 displayed 才把话题记为已说过。 */
  markDisplayed(episodeId: string, at = this.now()): void {
    const entry = this.entries.find((item) => item.episodeId === episodeId)
    if (entry === undefined) return
    entry.displayedAt = at
    if (entry.candidate.topicId !== null) {
      this.displayedTopics.set(entry.candidate.topicId, at)
    }
  }

  /** 展示失败/取消：候选已消费但不算说过，话题去重不更新。 */
  cancelEpisode(episodeId: string): void {
    const entry = this.entries.find((item) => item.episodeId === episodeId)
    if (entry !== undefined) entry.episodeId = null
  }

  /** 用户接住了一条主动开场：重置该话题的重复窗口，允许下一轮继续进展。 */
  noteAnswered(episodeId: string): void {
    const entry = this.entries.find((item) => item.episodeId === episodeId)
    if (entry?.candidate.topicId !== null && entry?.candidate.topicId !== undefined) {
      this.displayedTopics.delete(entry.candidate.topicId)
    }
  }

  diagnostics(now = this.now()): {
    admitted: number
    deferred: number
    dropped: number
    displayed: number
    pending: number
  } {
    const active = this.entries.filter(
      (entry) =>
        entry.displayedAt === null &&
        (entry.candidate.expiresAt === null || entry.candidate.expiresAt > now)
    )
    return {
      admitted: this.entries.filter((entry) => entry.decision === 'admit').length,
      deferred: this.entries.filter((entry) => entry.decision === 'defer').length,
      dropped: this.entries.filter((entry) => entry.decision === 'drop').length,
      displayed: this.entries.filter((entry) => entry.displayedAt !== null).length,
      pending: active.length
    }
  }

  clear(): void {
    this.entries.length = 0
    this.displayedTopics.clear()
  }

  private displayedTopicAt(topicId: string, now: number): number | null {
    const at = this.displayedTopics.get(topicId)
    if (at === undefined) return null
    if (now - at > DISPLAYED_TOPIC_TTL_MS) {
      this.displayedTopics.delete(topicId)
      return null
    }
    return at
  }

  private prune(now: number): void {
    while (this.entries.length > MAX_ENTRIES) this.entries.shift()
    for (const [topicId, at] of this.displayedTopics) {
      if (now - at > DISPLAYED_TOPIC_TTL_MS) this.displayedTopics.delete(topicId)
    }
  }
}
