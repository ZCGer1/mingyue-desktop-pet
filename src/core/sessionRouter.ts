import type { ConversationHandoffStore, HandoffSource } from './conversationHandoff'
import type { ConversationEpisode, ConversationEpisodeStore } from './conversationEpisode'

/**
 * 会话入口路由：把“这句话接的是哪个话题”从 Bot 的发送/气泡代码里收口。
 *
 * 它不保存第二份话题状态，只围绕已有的两个内存存储做确定性解析：
 * - ConversationEpisodeStore 记录主动开场的生命周期；
 * - ConversationHandoffStore 记录同一话题在快捷/完整入口之间的短期片段。
 *
 * 完整聊天与快捷聊天的回退顺序必须一致：显式 episode id → 最新未回答开场 →
 * 仍绑定且未被替代的回答过话题。两个入口都不得各自实现一套近似规则。
 */

export type SessionEntry = 'chat' | 'quick-chat'

export interface ChatRoute {
  /** 本轮事件应携带的 episode id；没有可衔接话题时为 undefined。 */
  episodeId?: string
  /** 最新未回答开场；用于回答后的指标/兴趣计数。 */
  openEpisode?: ConversationEpisode
  /** 本轮对应的 episode（未回答开场优先，其次已回答但仍绑定的话题）。 */
  activeEpisode?: ConversationEpisode
  /** 另一入口留下的短期片段是否应当注入本轮。 */
  carryHandoff: boolean
}

export interface QuickRoute {
  episode?: ConversationEpisode
}

export class SessionRouter {
  constructor(
    private readonly options: {
      episodes: ConversationEpisodeStore
      handoff: ConversationHandoffStore
    }
  ) {}

  get episodes(): ConversationEpisodeStore {
    return this.options.episodes
  }

  get handoff(): ConversationHandoffStore {
    return this.options.handoff
  }

  /** 当前交接话题绑定的 Episode；已被替代时不再当作可衔接话题。 */
  validHandoffEpisode(): ConversationEpisode | undefined {
    const id = this.handoff.activeEpisodeId()
    if (id === null) return undefined
    const episode = this.episodes.get(id)
    return episode !== undefined && episode.supersededAt === null ? episode : undefined
  }

  validHandoffEpisodeId(): string | undefined {
    return this.validHandoffEpisode()?.id
  }

  /**
   * 完整聊天入口。新的未回答开场优先；否则沿用仍在有效期内的已回答话题。
   * 只有仍在绑定同一话题时，才把另一入口的片段带进本轮。
   */
  resolveChatRoute(): ChatRoute {
    const open = this.episodes.latestOpen()
    const handoffEpisode = this.validHandoffEpisode()
    const active = open ?? handoffEpisode
    const continuesBoundTopic =
      open === undefined || this.handoff.activeEpisodeId() === open.id
    const carryHandoff =
      continuesBoundTopic && this.handoff.hasOtherSource('chat')
    return {
      ...(active === undefined ? {} : { episodeId: active.id, activeEpisode: active }),
      ...(open === undefined ? {} : { openEpisode: open }),
      carryHandoff
    }
  }

  /**
   * 快捷入口：显式 id 优先，其次最新未回答开场，最后回退到已回答但仍在
   * 交接的话题。显式 id 已过期/已替代时不会被采用。
   */
  resolveQuickRoute(episodeId?: string): QuickRoute {
    if (episodeId !== undefined && episodeId !== '') {
      const explicit = this.episodes.get(episodeId)
      if (explicit !== undefined && explicit.supersededAt === null) {
        return { episode: explicit }
      }
    }
    const open = this.episodes.latestOpen()
    if (open !== undefined) return { episode: open }
    const active = this.validHandoffEpisode()
    return active === undefined ? {} : { episode: active }
  }

  bindEpisode(episodeId: string | null): void {
    this.handoff.bindEpisode(episodeId)
  }

  noteUser(
    text: string,
    source: HandoffSource,
    episodeId?: string | null
  ): void {
    this.handoff.noteUser(text, source, episodeId)
  }

  noteAssistant(text: string, source: HandoffSource): void {
    this.handoff.noteAssistant(text, source)
  }

  contextText(
    target: HandoffSource,
    options: { includeSameSource?: boolean } = {}
  ): string | null {
    return this.handoff.contextText(target, options)
  }

  /** 明确的“新对话”：只结束跨入口话题，不删除主动开场历史。 */
  clearTopic(): void {
    this.handoff.clear()
  }

  /** 清空本地数据：话题和主动开场一起结束。 */
  clearAll(): void {
    this.episodes.clear()
    this.handoff.clear()
  }

  diagnostics(): {
    handoff: ReturnType<ConversationHandoffStore['diagnostics']>
    hasOpenEpisode: boolean
  } {
    return {
      handoff: this.handoff.diagnostics(),
      hasOpenEpisode: this.episodes.hasOpen()
    }
  }
}
