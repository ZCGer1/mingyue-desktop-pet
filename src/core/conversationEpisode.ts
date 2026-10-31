import { randomUUID } from 'node:crypto'

/** 一次主动开场的最小衔接记录；只存在内存里，从不持久化正文。 */
export type EpisodeFeedback = 'more' | 'less' | 'stop'

/**
 * 主动开场的语义类型。只有 `question` 代表“确实在等用户回答”，
 * 评论/提议/任务进度即使没有被回应，也不应挡住后续有价值的新事件。
 */
export type EpisodeKind = 'comment' | 'question' | 'proposal' | 'task_update'

export interface ConversationEpisode {
  id: string
  /** 自主探索、用户任务或屏幕陪伴产生的主动开场。 */
  source: 'autonomy' | 'task' | 'screen'
  taskId: string | null
  /** 关联兴趣；只用于话题延续与节奏，不授予任何权限。 */
  interestId: string | null
  /** pet_say 原句，≤60 字。 */
  openingText: string
  kind: EpisodeKind
  /** 任务标题/目标，≤80 字。 */
  topic: string
  /** 只允许 `notes/...` 相对路径。 */
  artifact: { path: string; title: string } | null
  /** 脱敏摘要，≤300 字、单行。 */
  discovery: string | null
  /** 关联的本地发现 id；只作为分享卡片引用，不授予浏览/打开权限。 */
  discoveryId: string | null
  pendingQuestion: string | null
  /** 过期仍未回答的次数由 ChatCadence 统计；这里记录这一条被忽略过。 */
  ignoredCount: number
  lastFeedback: EpisodeFeedback | null
  /**
   * 本轮含网页/屏幕内容时为 false：Episode 仍可在内存中衔接，
   * 但不写入磁盘，避免不可信正文跨重启变成长期记录。
   */
  persistable: boolean
  createdAt: number
  answeredAt: number | null
  supersededAt: number | null
  expiresAt: number
}

export interface OpenEpisodeInput {
  source: 'autonomy' | 'task' | 'screen'
  taskId: string | null
  interestId?: string | null
  openingText: string
  /** 显式语义；缺省时按是否带 pendingQuestion 推断为 question/comment。 */
  kind?: EpisodeKind
  topic?: string
  artifact?: { path: string; title: string } | null
  discovery?: string | null
  /** 主动分享的发现 id；必须已存在于 DiscoveryStore。 */
  discoveryId?: string | null
  pendingQuestion?: string | null
  /** false 表示本轮含网页/屏幕内容：只留在内存，不进入持久化快照。 */
  persistable?: boolean
}

export interface ConversationEpisodeOptions {
  now?: () => number
  ttlMs?: number
  maxEntries?: number
  /** Episode 过期且从未回答时回调；恢复启动时已过期的条目不补发。 */
  onUnanswered?: (episode: ConversationEpisode) => void
}

export const EPISODE_TTL_MS = 30 * 60_000
export const EPISODE_MAX_ENTRIES = 8

const MAX_OPENING = 60
const MAX_TOPIC = 80
const MAX_DISCOVERY = 300

/**
 * 主动对话 Episode：把「她刚才为什么开口」变成快捷聊天/完整聊天都能取的
 * 安全衔接记录。原始文件内容、截图、绝对路径、密钥都不进入这里。
 */
export class ConversationEpisodeStore {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly onUnanswered: ((episode: ConversationEpisode) => void) | null
  private episodes: ConversationEpisode[] = []

  constructor(options: ConversationEpisodeOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = Math.max(60_000, options.ttlMs ?? EPISODE_TTL_MS)
    this.maxEntries = Math.max(1, options.maxEntries ?? EPISODE_MAX_ENTRIES)
    this.onUnanswered = options.onUnanswered ?? null
  }

  /**
   * 同一任务的连续 pet_say 更新同一个开场；不同任务/无任务则替代旧开场。
   * 返回 Episode id，供气泡携带。
   */
  openOrUpdate(input: OpenEpisodeInput): ConversationEpisode {
    const now = this.now()
    this.prune(now)
    const sameTask =
      input.taskId === null
        ? undefined
        : this.episodes.find(
            (episode) =>
              episode.taskId === input.taskId &&
              episode.answeredAt === null &&
              episode.supersededAt === null &&
              episode.expiresAt > now
          )
    // 开场、目标与追问都可能由模型生成：进 Episode 前同样去 URL/绝对路径。
    const openingText = clampLine(safeDiscovery(input.openingText), MAX_OPENING)
    const topic = clampLine(safeDiscovery(input.topic ?? ''), MAX_TOPIC)
    const artifact = safeArtifact(input.artifact ?? null)
    const discovery =
      input.discovery === undefined || input.discovery === null
        ? null
        : safeDiscovery(input.discovery) || null
    const pendingQuestion =
      input.pendingQuestion === undefined || input.pendingQuestion === null
        ? null
        : clampLine(safeDiscovery(input.pendingQuestion), MAX_OPENING)
    const kind: EpisodeKind =
      input.kind ??
      (pendingQuestion !== null && pendingQuestion !== '' ? 'question' : 'comment')
    const interestId = safeOpaqueId(input.interestId) ?? null
    const discoveryId = safeOpaqueId(input.discoveryId) ?? null

    if (sameTask !== undefined) {
      sameTask.openingText = openingText !== '' ? openingText : sameTask.openingText
      // 同一活动的更新可以升级语义；没有显式 kind/问题时保留原类型，
      // 避免一句补充评论把尚未回答的问题降级成 comment。
      if (input.kind !== undefined || pendingQuestion !== null) sameTask.kind = kind
      if (topic !== '') sameTask.topic = topic
      if (artifact !== null) sameTask.artifact = artifact
      if (discovery !== null) sameTask.discovery = discovery
      if (discoveryId !== null) sameTask.discoveryId = discoveryId
      if (pendingQuestion !== null) sameTask.pendingQuestion = pendingQuestion
      if (interestId !== null) sameTask.interestId = interestId
      if (input.persistable === false) sameTask.persistable = false
      return cloneEpisode(sameTask)
    }

    for (const episode of this.episodes) {
      if (episode.answeredAt === null && episode.supersededAt === null && episode.expiresAt > now) {
        episode.supersededAt = now
      }
    }
    const episode: ConversationEpisode = {
      id: randomUUID(),
      source: input.source,
      taskId: input.taskId,
      interestId,
      openingText,
      kind,
      topic,
      artifact,
      discovery,
      discoveryId,
      pendingQuestion,
      ignoredCount: 0,
      lastFeedback: null,
      // 屏幕来源的语音只在内存中服务当轮问答；即使调用方误传 persistable，
      // 也不能把屏幕衍生的开场写进磁盘。
      persistable: input.source !== 'screen' && input.persistable !== false,
      createdAt: now,
      answeredAt: null,
      supersededAt: null,
      expiresAt: now + this.ttlMs
    }
    this.episodes.push(episode)
    this.trim()
    return cloneEpisode(episode)
  }

  get(id: string): ConversationEpisode | undefined {
    this.prune(this.now())
    const episode = this.episodes.find((entry) => entry.id === id)
    return episode === undefined ? undefined : cloneEpisode(episode)
  }

  /** 最新一个未回答、未替代、未过期的 Episode。 */
  latestOpen(): ConversationEpisode | undefined {
    const now = this.now()
    this.prune(now)
    const open = this.episodes
      .filter(
        (episode) =>
          episode.answeredAt === null &&
          episode.supersededAt === null &&
          episode.expiresAt > now
      )
      .sort((a, b) => b.createdAt - a.createdAt)
    const latest = open[0]
    return latest === undefined ? undefined : cloneEpisode(latest)
  }

  hasOpen(): boolean {
    return this.latestOpen() !== undefined
  }

  /**
   * 只返回真正等待回答的主动问题。评论/提议/任务进度不算“用户忽略了
   * 一个问题”，不参与闲聊退避，也不阻止新的高价值事件开口。
   */
  latestOpenQuestion(): ConversationEpisode | undefined {
    const latest = this.latestOpen()
    return latest?.kind === 'question' ? latest : undefined
  }

  hasOpenQuestion(): boolean {
    return this.latestOpenQuestion() !== undefined
  }

  markAnswered(id: string): boolean {
    const now = this.now()
    this.prune(now)
    const episode = this.episodes.find((entry) => entry.id === id)
    if (episode === undefined || episode.supersededAt !== null) return false
    if (episode.answeredAt !== null) return true
    episode.answeredAt = now
    return true
  }

  /** 主动气泡没有真正显示时取消 Episode，避免之后仍把它当成上下文。 */
  cancel(id: string): boolean {
    const now = this.now()
    this.prune(now)
    const episode = this.episodes.find((entry) => entry.id === id)
    if (episode === undefined) return false
    if (episode.answeredAt !== null || episode.supersededAt !== null) return false
    episode.supersededAt = now
    return true
  }

  /** 用户在快捷面板给出反馈；只记录枚举，不存原话。 */
  markFeedback(id: string, feedback: EpisodeFeedback): boolean {
    this.prune(this.now())
    const episode = this.episodes.find((entry) => entry.id === id)
    if (episode === undefined) return false
    episode.lastFeedback = feedback
    return true
  }

  /** 低频巡检：没有其它访问时也能发现过期未回答的 Episode。 */
  tick(now = this.now()): void {
    this.prune(now)
  }

  /**
   * 可持久化的完整快照；字段本身已全部脱敏，不含正文/路径/标题原文。
   * 含网页/屏幕来源的 Episode 只留在内存，不进入快照。
   */
  snapshot(): ConversationEpisode[] {
    return this.episodes.filter((episode) => episode.persistable).map(cloneEpisode)
  }

  /**
   * 启动恢复。已过期的 Episode 只清理，不补发 onUnanswered，
   * 避免重启时把上次没回复误判成“被忽略”。
   */
  restore(input: unknown, now = this.now()): void {
    if (!Array.isArray(input)) return
    const restored: ConversationEpisode[] = []
    for (const raw of input) {
      const episode = parseEpisode(raw, now, this.ttlMs)
      if (episode !== null) restored.push(episode)
      if (restored.length >= this.maxEntries) break
    }
    this.episodes = restored
    this.prune(now, false)
    this.trim()
  }

  /** 任务结束时用安全摘要补全对应开场；找不到或已回答则忽略。 */
  setDiscoveryForTask(taskId: string, text: string): boolean {
    const now = this.now()
    this.prune(now)
    const episode = this.episodes.find(
      (entry) =>
        entry.taskId === taskId &&
        entry.answeredAt === null &&
        entry.supersededAt === null &&
        entry.expiresAt > now
    )
    if (episode === undefined) return false
    const safe = safeDiscovery(text)
    if (safe === '') return false
    episode.discovery = safe
    return true
  }

  /**
   * 发现被用户删除/清空后，Episode 里的引用也必须失效；
   * 否则之后回复旧气泡时还可能展示已删除内容的卡片。
   */
  forgetDiscovery(discoveryId: string): number {
    let cleared = 0
    for (const episode of this.episodes) {
      if (episode.discoveryId !== discoveryId) continue
      episode.discoveryId = null
      cleared += 1
    }
    return cleared
  }

  /**
   * 即将被新开场替代/覆盖的 Episode 上关联的发现 id（排除这次要用的 id）。
   * 调用方据此把旧发现的 pending-share 回退，避免记录永远卡在“准备分享”。
   */
  staleDiscoveryIdsForOpen(taskId: string | null, keepDiscoveryId: string | null): string[] {
    const now = this.now()
    this.prune(now)
    const open = this.episodes.filter(
      (episode) =>
        episode.answeredAt === null &&
        episode.supersededAt === null &&
        episode.expiresAt > now
    )
    const sameTask =
      taskId === null ? undefined : open.find((episode) => episode.taskId === taskId)
    // 与 openOrUpdate 一致：同任务更新只影响这一条；否则新开场会替代全部旧开场。
    const affected = sameTask === undefined ? open : [sameTask]
    const ids = new Set<string>()
    for (const episode of affected) {
      if (episode.discoveryId === null) continue
      if (episode.discoveryId === keepDiscoveryId) continue
      ids.add(episode.discoveryId)
    }
    return [...ids]
  }

  /** 发现被删除/清空后清掉失效引用；返回清理数量。 */
  pruneDiscoveries(exists: (discoveryId: string) => boolean): number {
    let cleared = 0
    for (const episode of this.episodes) {
      if (episode.discoveryId === null) continue
      if (exists(episode.discoveryId)) continue
      episode.discoveryId = null
      cleared += 1
    }
    return cleared
  }

  /** 开启中的分享 Episode：用于停止浏览时取消尚未展示的分享。 */
  openWithDiscovery(discoveryId: string): ConversationEpisode | undefined {
    const now = this.now()
    this.prune(now)
    const episode = this.episodes.find(
      (entry) =>
        entry.discoveryId === discoveryId &&
        entry.answeredAt === null &&
        entry.supersededAt === null &&
        entry.expiresAt > now
    )
    return episode === undefined ? undefined : cloneEpisode(episode)
  }

  clear(): void {
    this.episodes = []
  }

  /** 诊断用：不含 opening/discovery 正文。 */
  count(): number {
    this.prune(this.now())
    return this.episodes.length
  }

  private prune(now: number, notify = true): void {
    const unanswered: ConversationEpisode[] = []
    if (notify) {
      for (const episode of this.episodes) {
        if (episode.expiresAt > now) continue
        if (episode.answeredAt !== null || episode.supersededAt !== null) continue
        unanswered.push({ ...cloneEpisode(episode), ignoredCount: episode.ignoredCount + 1 })
      }
    }
    this.episodes = this.episodes.filter((episode) => episode.expiresAt > now)
    this.trim()
    // 先从内存移除再回调，避免回调里再次访问 store 触发递归清理。
    for (const episode of unanswered) {
      try {
        this.onUnanswered?.(episode)
      } catch {
        /* 回调失败不能影响 Episode 清理 */
      }
    }
  }

  private trim(): void {
    if (this.episodes.length <= this.maxEntries) return
    this.episodes.sort((a, b) => a.createdAt - b.createdAt)
    this.episodes = this.episodes.slice(this.episodes.length - this.maxEntries)
  }
}

/** 单行、去 URL、去 Windows 绝对路径、限长。用于所有进入 Episode 的自由文本。 */
export function safeDiscovery(input: string): string {
  let text = input
    .replace(/\r?\n+/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\\\\[^\s，。；;,]+/g, ' ')
    .replace(/[A-Za-z]:[\\/][^\s，。；;,]*/g, ' ')
    // 以 / 开头的整段也按绝对路径处理；notes/... 相对路径不受影响。
    .replace(/(^|\s)\/[^\s，。；;,]+/g, ' ')
    // 明显的 API Key 形态不进入 Episode。
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > MAX_DISCOVERY) text = text.slice(0, MAX_DISCOVERY).trimEnd()
  return text
}

/**
 * 交给模型的衔接说明。只含安全字段，并明确「不要问哪个笔记」与
 * 「没有本轮工具回执不要编造正文」。
 */
export function episodeContextText(episode: ConversationEpisode): string {
  const lines = [
    '[主动对话] 你刚才主动开启了这段交流，系统记录了真实上下文：',
    episode.openingText === '' ? null : `- 你刚才说：${episode.openingText}`,
    `- 这段话的类型：${episode.kind}`,
    episode.topic === '' ? null : `- 相关目标：${episode.topic}`,
    episode.artifact === null
      ? null
      : `- 你写下的笔记：${episode.artifact.path}（标题：${episode.artifact.title}）`,
    episode.discovery === null ? null : `- 安全摘要：${episode.discovery}`,
    episode.discoveryId === null ? null : `- 关联发现：discoveryId=${episode.discoveryId}`,
    episode.pendingQuestion === null ? null : `- 你留下的问题：${episode.pendingQuestion}`,
    '用户现在是在回应这段主动交流；直接接着聊，不要问“哪个笔记/什么笔记”。',
    '上面的笔记路径与摘要可以引用；没有本轮工具回执时不要编造笔记正文。需要展示内容就用 ws_read 读取该路径（若工具可用），或建议展开完整聊天。',
    episode.discoveryId === null
      ? null
      : '关联发现可以用 discovery_show 取标题/理由/证据层级；不要凭记忆补造视频内容、字幕或链接。'
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

function clampLine(input: string, max: number): string {
  const text = input.replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max).trimEnd() : text
}

/** 只接受 notes/ 相对路径；绝对路径与 .. 逃逸一律丢弃。 */
function safeArtifact(
  artifact: { path: string; title: string } | null
): { path: string; title: string } | null {
  if (artifact === null) return null
  const path = artifact.path.replace(/\\/g, '/').trim()
  if (!/^notes\//i.test(path)) return null
  if (path.split('/').some((part) => part === '' || part === '..' || part === '.')) return null
  if (/^[A-Za-z]:/.test(path) || path.startsWith('//')) return null
  // 路径段内也不允许出现盘符或根路径（例如 notes/C:/Users/...）。
  if (path.split('/').some((part) => part.includes(':') || part.startsWith('/'))) return null
  const title = clampLine(safeDiscovery(artifact.title), MAX_TOPIC)
  return { path: path.slice(0, 200), title }
}

function cloneEpisode(episode: ConversationEpisode): ConversationEpisode {
  return {
    ...episode,
    artifact: episode.artifact === null ? null : { ...episode.artifact }
  }
}

/** 恢复时的显式校验：损坏字段回退/丢弃，绝不把任意文本带进 Episode。 */
function parseEpisode(
  raw: unknown,
  now: number,
  ttlMs: number
): ConversationEpisode | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  const id =
    typeof input.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(input.id) ? input.id : null
  if (id === null) return null
  const source = input.source === 'task' ? 'task' : input.source === 'autonomy' ? 'autonomy' : null
  if (source === null) return null
  const createdAt = finiteTime(input.createdAt, now)
  const openingText = clampLine(safeDiscovery(stringOr(input.openingText, '')), MAX_OPENING)
  const topic = clampLine(safeDiscovery(stringOr(input.topic, '')), MAX_TOPIC)
  const discovery =
    input.discovery === null || input.discovery === undefined
      ? null
      : safeDiscovery(stringOr(input.discovery, '')) || null
  const pendingQuestion =
    input.pendingQuestion === null || input.pendingQuestion === undefined
      ? null
      : clampLine(safeDiscovery(stringOr(input.pendingQuestion, '')), MAX_OPENING)
  const feedback =
    input.lastFeedback === 'more' || input.lastFeedback === 'less' || input.lastFeedback === 'stop'
      ? input.lastFeedback
      : null
  const kind: EpisodeKind =
    input.kind === 'question' ||
    input.kind === 'proposal' ||
    input.kind === 'task_update' ||
    input.kind === 'comment'
      ? input.kind
      : pendingQuestion !== null && pendingQuestion !== ''
        ? 'question'
        : 'comment'
  return {
    id,
    source,
    taskId: safeOpaqueId(input.taskId),
    interestId: safeOpaqueId(input.interestId),
    openingText,
    kind,
    topic,
    artifact: safeArtifact(parseArtifact(input.artifact)),
    discovery,
    discoveryId: safeOpaqueId(input.discoveryId),
    pendingQuestion,
    ignoredCount: clampCount(input.ignoredCount),
    lastFeedback: feedback,
    // 只有可持久化的 Episode 会被写入快照；恢复出来的都按可持久化处理。
    persistable: true,
    createdAt,
    answeredAt: nullableTime(input.answeredAt),
    supersededAt: nullableTime(input.supersededAt),
    expiresAt: finiteTime(input.expiresAt, createdAt + ttlMs)
  }
}

function parseArtifact(raw: unknown): { path: string; title: string } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  if (typeof input.path !== 'string' || typeof input.title !== 'string') return null
  return { path: input.path, title: input.title }
}

function safeOpaqueId(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  return /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function finiteTime(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function nullableTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function clampCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(1_000, Math.max(0, Math.trunc(value)))
}
