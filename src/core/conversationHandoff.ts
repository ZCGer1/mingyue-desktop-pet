import { safeDiscovery } from './conversationEpisode'

/**
 * 跨快捷/完整聊天的短期话题交接。
 *
 * 它只存在内存里，不写会话文件、不依赖 `memory.enabled`，也不等待异步摘要：
 * - 用户在哪一个入口接住了主动开场，Episode 仍由 ConversationEpisodeStore 记录；
 * - 这里额外保留最近的对话片段，让另一个入口在下一轮就能看到事实与偏好；
 * - 只有明确的「新对话」、新话题或 30 分钟无更新才结束话题，而不是一回答就结束。
 */

export const HANDOFF_TTL_MS = 30 * 60_000
export const HANDOFF_MAX_TURNS = 8
export const HANDOFF_TURN_MAX_CHARS = 400
export const HANDOFF_CONTEXT_MAX_CHARS = 2_400

export type HandoffSource = 'quick-chat' | 'chat'

export interface HandoffTurn {
  role: 'user' | 'assistant'
  text: string
  source: HandoffSource
  at: number
}

export interface ConversationHandoffOptions {
  now?: () => number
  ttlMs?: number
}

function sourceLabel(source: HandoffSource): string {
  return source === 'quick-chat' ? '快捷聊天' : '完整聊天'
}

/**
 * 只保留最近的、已脱敏的单行片段。用户新增的偏好通常很短；
 * 400 字足够承接事实，又不会把整段笔记正文带进另一个入口。
 */
function handoffText(input: string): string {
  return safeDiscovery(input).slice(0, HANDOFF_TURN_MAX_CHARS).trim()
}

export class ConversationHandoffStore {
  private readonly now: () => number
  private readonly ttlMs: number
  private episodeId: string | null = null
  private turns: HandoffTurn[] = []
  private updatedAt = 0

  constructor(options: ConversationHandoffOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = Math.max(60_000, options.ttlMs ?? HANDOFF_TTL_MS)
  }

  /**
   * 绑定当前话题对应的 Episode。换了一个 Episode 就视为新话题：
   * 旧的短期片段清空，避免把上一个话题的偏好带进新开场。
   */
  bindEpisode(episodeId: string | null): void {
    this.prune()
    if (episodeId === null || episodeId === '' || episodeId === this.episodeId) return
    this.episodeId = episodeId
    this.turns = []
    this.updatedAt = this.now()
  }

  /** 当前话题的 Episode id；已回答开场仍保留，回答不等于话题结束。 */
  activeEpisodeId(): string | null {
    this.prune()
    return this.episodeId
  }

  noteUser(text: string, source: HandoffSource, episodeId?: string | null): void {
    if (episodeId !== undefined && episodeId !== null) this.bindEpisode(episodeId)
    this.note('user', text, source)
  }

  noteAssistant(text: string, source: HandoffSource): void {
    this.note('assistant', text, source)
  }

  /** 是否有来自另一个入口、值得带给对方的话题片段。 */
  hasOtherSource(target: HandoffSource): boolean {
    this.prune()
    return this.turns.some((turn) => turn.source !== target)
  }

  /**
   * 给指定入口的短期上下文。完整聊天自己的话已在会话里，默认只带快捷内容；
   * 快捷面板关闭后内存历史会被清空，因此它可以要求连自己的片段一起带上。
   */
  contextText(
    target: HandoffSource,
    options: { includeSameSource?: boolean } = {}
  ): string | null {
    this.prune()
    const turns = this.turns.filter(
      (turn) => options.includeSameSource === true || turn.source !== target
    )
    if (turns.length === 0) return null
    const lines = turns.map(
      (turn) =>
        `- ${turn.role === 'user' ? '用户' : '她'}（${sourceLabel(turn.source)}）：${turn.text}`
    )
    return [
      '[当前话题交接] 这是系统在内存中保留的同一段对话，不依赖长期记忆或异步摘要：',
      ...lines,
      '直接接着当前话题继续，不要问“我们刚才聊了什么/哪个笔记”。需要正文时再用工具读取，不要编造。'
    ].join('\n')
  }

  /** 明确的「新对话」或清空本地数据：话题结束。 */
  clear(): void {
    this.episodeId = null
    this.turns = []
    this.updatedAt = 0
  }

  diagnostics(): { episodes: number; turns: number; updatedAt: number | null } {
    this.prune()
    return {
      episodes: this.episodeId === null ? 0 : 1,
      turns: this.turns.length,
      updatedAt: this.updatedAt > 0 ? this.updatedAt : null
    }
  }

  // ------------------------------------------------------------------

  private note(role: HandoffTurn['role'], input: string, source: HandoffSource): void {
    this.prune()
    const text = handoffText(input)
    if (text === '') return
    const at = this.now()
    this.turns.push({ role, text, source, at })
    this.updatedAt = at
    this.trim()
  }

  private prune(): void {
    if (this.turns.length === 0 && this.episodeId === null) return
    const now = this.now()
    if (this.updatedAt > 0 && now - this.updatedAt <= this.ttlMs) return
    this.clear()
  }

  private trim(): void {
    while (this.turns.length > HANDOFF_MAX_TURNS) this.turns.shift()
    let total = this.turns.reduce((sum, turn) => sum + turn.text.length, 0)
    while (this.turns.length > 1 && total > HANDOFF_CONTEXT_MAX_CHARS) {
      total -= this.turns[0]?.text.length ?? 0
      this.turns.shift()
    }
  }
}
