import type {
  EventEnvelope,
  Logger,
  OutputTap,
  TapEvent,
  World,
  WorldDescribe,
  WorldHost
} from '../../core/types'
import ENV_PROMPT from './ENV_PROMPT.md?raw'

export const MAX_USER_MESSAGE_CHARS = 8000

export interface ChatSink {
  onTap(event: TapEvent): void
  onUserMessage(event: EventEnvelope): void
}

/**
 * `chat` World（PLAN.md §4.2）：只负责把聊天窗的输入推上总线，
 * 并把 Core 的流式 tap 转发给渲染层。审批卡由 ApprovalGate 直接走 IPC。
 */
export class ChatWorld implements World {
  readonly id = 'chat'
  readonly describe: WorldDescribe = {
    tools: [],
    events: [
      { type: 'chat.user_message', description: '用户在聊天窗发送的消息' },
      { type: 'chat.stop', description: '用户点击停止' }
    ]
  }

  private readonly logger: Logger
  private sink: ChatSink | null = null
  private host: WorldHost | null = null
  private externalized = false

  constructor(opts: { logger: Logger }) {
    this.logger = opts.logger
  }

  setSink(sink: ChatSink | null): void {
    this.sink = sink
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host
  }

  async stop(): Promise<void> {
    this.host = null
  }

  envPromptVars(): Record<string, string> | null {
    return {}
  }

  envPrompt(): string {
    return ENV_PROMPT
  }

  tools(): [] {
    return []
  }

  outputTap(): OutputTap {
    return {
      onEvent: (event) => {
        if (event.type === 'batch_start') this.externalized = false
        if (
          event.type === 'assistant_start' ||
          (event.type === 'text_delta' && event.text.trim() !== '') ||
          event.type === 'tool_call_start' ||
          event.type === 'tool_result'
        ) {
          this.externalized = true
        }
        try {
          this.sink?.onTap(event)
        } catch (error) {
          this.logger.warn('聊天窗 tap 异常', { error: String(error) })
        }
      },
      externalizes: () => this.externalized
    }
  }

  /**
   * 聊天窗发送一条用户消息；空白消息忽略。
   * `episodeId` 只作为不透明 id 进入事件 meta，供 Core 当轮取安全衔接文本；
   * `conversationHandoff` 只说明「本轮需要跨入口短期片段」，正文不进事件库。
   */
  submit(
    text: string,
    options: { episodeId?: string; conversationHandoff?: boolean } = {}
  ): EventEnvelope | null {
    const host = this.host
    if (host === null) return null
    const trimmed = text.trim()
    if (trimmed === '') return null
    const clipped = trimmed.length > MAX_USER_MESSAGE_CHARS ? trimmed.slice(0, MAX_USER_MESSAGE_CHARS) : trimmed
    if (clipped.length !== trimmed.length) {
      this.logger.warn('用户消息过长，已截断', { length: trimmed.length })
    }
    const meta: Record<string, unknown> = {
      ...(options.episodeId === undefined ? {} : { episodeId: options.episodeId }),
      ...(options.conversationHandoff === true ? { conversationHandoff: true } : {})
    }
    const event = host.pushEvent({
      type: 'chat.user_message',
      source: 'chat',
      origin: 'external',
      text: clipped,
      trigger: 'flush',
      ...(Object.keys(meta).length === 0 ? {} : { meta })
    })
    try {
      this.sink?.onUserMessage(event)
    } catch {
      /* ignore */
    }
    return event
  }

  /** 停止按钮；中断当前轮，且不作为上下文投递。 */
  requestStop(): void {
    if (this.host === null) return
    this.host.pushEvent({
      type: 'chat.stop',
      source: 'chat',
      origin: 'external',
      text: '[system] 用户点击了停止',
      trigger: 'interrupt'
    })
  }

  isReady(): boolean {
    return this.host !== null
  }
}
