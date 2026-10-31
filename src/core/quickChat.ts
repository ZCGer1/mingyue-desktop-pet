import type { AppConfig } from '../shared/config'
import type { QuickChatEvent, QuickChatState, QuickSendResult } from '../shared/ipc'
import { assembleContext, prepareContextMessages } from './contextAssembler'
import { isToolPairingError, repairModelMessages } from './protocol'
import { TurnEngine, type ToolCallAccum } from './turnEngine'
import {
  MAX_SCREENSHOT_IMAGES,
  MAX_VIDEO_FRAME_IMAGES,
  describeToolImages,
  selectToolImages,
  toolImageKind
} from './toolImages'
import type { QuickToolGateway, QuickToolCall } from './quickTools'
import type { ToolExecutionResult } from './toolExecutor'
import { ProviderError } from './types'
import type {
  Logger,
  ModelContentPart,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ToolImage
} from './types'
import type { UsageTracker } from './usage'
import type { ConversationRuntime } from './conversationRuntime'
import { stripImagesFromRecords } from './session'
import type { ContextRecord } from './types'
import { BudgetCalibrator } from './budgetCalibrator'
import { estimateRequestBudget } from './requestBudget'

/**
 * Quick view adapter for the shared user topic. Only the in-flight transaction is
 * buffered locally; committed records belong to ConversationRuntime.session.
 * Source retention is memory-only, independently of the main chat disk policy.
 */

export const QUICK_IDLE_TIMEOUT_MS = 10 * 60_000
export const QUICK_LAST_DONE_TTL_MS = 15_000
export const QUICK_HISTORY_MAX_MESSAGES = 12
export const QUICK_HISTORY_MAX_CHARS = 6_000
export const QUICK_TRANSCRIPT_MAX_CHARS = 12_000
export const QUICK_SUMMARY_TRANSCRIPT_MAX_CHARS = 2_000
export const QUICK_SUMMARY_MAX_CHARS = 80
export const QUICK_MAX_TOOL_ROUNDS = 8
export const QUICK_MAX_TOOL_CALLS = 24
/** 兼容旧调用：截图上限；视频抽帧另有上限。 */
export const QUICK_MAX_IMAGES = MAX_SCREENSHOT_IMAGES
export const QUICK_TOOL_MAX_TOKENS = 2048

const QUICK_TEXT_MAX_TOKENS = 512
const QUICK_ERROR_MESSAGE = '她刚才走神了一下，再试一次吧。'
const QUICK_NO_KEY_MESSAGE = '还没有配置 DeepSeek API Key。去设置里填一个就能聊天了。'
const QUICK_BUSY_MESSAGE = '她还在说上一句，等一下吧。'
const QUICK_TOOL_LIMIT_NOTICE = '这次先做到这里，我用一句话总结。'
const QUICK_BUDGET_MESSAGE = '这次内容太长，超出了模型上下文预算；清理快捷对话或缩小任务后再试。'
const QUICK_BUDGET_NOTICE = '这段内容已经接近模型上下文上限，我先停在这里。'

export const QUICK_SUMMARY_PROMPT = `你是快捷对话摘要器。用一句不超过 80 字的中文概括这段快捷对话：用户想做什么/情绪是什么、她回应的要点。
只输出摘要正文，不要 Markdown、列表或引号。
不要包含密码、API Key、token、文件路径、文件内容、URL、工具参数、输入文字或屏幕内容；没有实质内容只输出 [无]。`

export interface QuickChatDeps {
  onRecordsChanged?: (records: ContextRecord[] | null) => void
  conversationRuntime?: ConversationRuntime
  budgetCalibrator?: BudgetCalibrator
  provider: ModelProvider
  hasApiKey: () => boolean
  getConfig: () => AppConfig
  usage: UsageTracker
  logger: Logger
  buildSystemPrompt: (episodeContext?: string) => string
  summarize: (messages: ModelMessage[], signal: AbortSignal) => Promise<string>
  appendRecent: (note: string) => void
  requestPromptRefresh: () => void
  /**
   * 一轮快捷回复完成：把助手原话交给跨入口话题交接。
   * 同步、只在内存，不等待摘要，也不受 memory.enabled 影响。
   */
  onAssistantReply?: (text: string, at: number) => void
  /** 用户点「新对话」或清空本地数据：当前话题结束。 */
  onReset?: () => void
  /** 共享工具网关；缺省时退回纯文本快捷聊天（单元测试/旧配置）。 */
  tools?: QuickToolGateway
  /** 便于测试注入；默认 Date.now。 */
  now?: () => number
}

type QuickChatPhase = QuickChatState['phase']
type FinishSource = 'close' | 'idle'

interface TranscriptItem {
  role: 'user' | 'assistant'
  text: string
  /** 被 stop/reset/错误打断的部分回复。 */
  interrupted?: boolean
}

interface HistorySnapshot {
  messages: ModelMessage[]
  transcript: TranscriptItem[]
  /** 只记录工具名，绝不记录参数、路径、输入文字或屏幕内容。 */
  toolNotes: string[]
}

interface TurnRequest {
  startedAt: number
  roundsUsed?: number
  toolsUsed?: number
  model: string
  maxChars: number
  systemPrompt: string
  /** 工具组加载后用于重建提示词；只在本轮内存里保存。 */
  episodeContext?: string
  toolsEnabled: boolean
  /** 无工具路径使用发送时的历史快照；工具路径每轮重新从 this.messages 构造。 */
  messages: ModelMessage[]
}

function errorTag(error: unknown): string {
  if (error instanceof Error) return error.name
  return typeof error
}

function summaryText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'「『“]+|["'」』”]+$/g, '')
    .slice(0, QUICK_SUMMARY_MAX_CHARS)
    .trim()
}

function hasExchange(transcript: TranscriptItem[]): boolean {
  const hasUser = transcript.some((item) => item.role === 'user' && item.text.trim() !== '')
  const hasAssistant = transcript.some(
    (item) => item.role === 'assistant' && item.text.trim() !== ''
  )
  return hasUser && hasAssistant
}

/** 摘要转写只保留 user/assistant 文本，超长时保尾部（最近的交换更重要）。 */
function buildTranscript(transcript: TranscriptItem[], toolNotes: string[]): string {
  const lines: string[] = []
  for (const item of transcript) {
    const text = item.text.trim()
    if (text === '') continue
    lines.push(`${item.role === 'user' ? '用户' : '她'}：${text}`)
  }
  const tools = [...new Set(toolNotes)]
  if (tools.length > 0) lines.push(`（使用了工具：${tools.join('、')}）`)
  const joined = lines.join('\n')
  if (joined.length <= QUICK_SUMMARY_TRANSCRIPT_MAX_CHARS) return joined
  return `…${joined.slice(-(QUICK_SUMMARY_TRANSCRIPT_MAX_CHARS - 1))}`
}

function contentTextLength(message: ModelMessage): number {
  let total = 0
  if (typeof message.content === 'string') total += message.content.length
  else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') total += part.text.length
    }
  }
  for (const call of message.tool_calls ?? []) total += call.function.arguments.length
  return total
}

function hasImagePart(message: ModelMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === 'image_url')
  )
}

function isPlainUserMessage(message: ModelMessage): boolean {
  return message.role === 'user' && !hasImagePart(message)
}

function cloneMessage(message: ModelMessage): ModelMessage {
  if (!Array.isArray(message.content)) return { ...message }
  return { ...message, content: message.content.map((part) => ({ ...part })) }
}

/**
 * 快捷聊天的历史修剪只保留满足工具配对的消息。
 * 与主会话共用同一套修复：缺回执补「结果未知」，不伪造成功、不重放工具。
 */
export function repairToolPairingMessages(messages: ModelMessage[]): ModelMessage[] {
  return repairModelMessages(messages)
}

export class QuickChatService {
  private readonly deps: QuickChatDeps
  private readonly engine: TurnEngine
  private readonly unsubscribeTopic: (() => void) | undefined
  private readonly budgetCalibrator: BudgetCalibrator
  private readonly now: () => number
  private readonly listeners = new Set<(event: QuickChatEvent) => void>()

  private phase: QuickChatPhase = 'idle'
  private messages: ModelMessage[] = []
  /** 图片消息与图片类别一一对应；截图和视频抽帧分开限额，不能混算。 */
  private readonly imageKinds = new WeakMap<ModelMessage, Array<'screenshot' | 'video-frame'>>()
  private transcript: TranscriptItem[] = []
  private toolNotes: string[] = []
  private turnSeq = 0
  private activeTurnId: string | null = null
  private seq = 0
  private currentText = ''
  private lastError: string | null = null
  private lastDone: QuickChatState['lastDone'] = null
  private abortController: AbortController | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private finishAfterStream: FinishSource | null = null
  private summaryAbort: AbortController | null = null
  private summaryChain: Promise<void> = Promise.resolve()
  private generation = 0
  private disposed = false
  /** 每个用户 turn 最多因工具配对 400 修复重试一次，避免同一结构反复发送。 */
  private pairingRepairUsed = false

  constructor(deps: QuickChatDeps) {
    this.deps = deps
    this.engine = deps.conversationRuntime?.engine ?? new TurnEngine()
    this.unsubscribeTopic = deps.conversationRuntime?.onClear(() => {
      this.invalidateTurn()
      this.messages = []; this.transcript = []; this.toolNotes = []
      this.currentText = ''; this.phase = 'idle'; this.lastDone = null
      this.emit({ type: 'reset' })
      this.deps.onRecordsChanged?.(null)
    })
    this.budgetCalibrator = deps.budgetCalibrator ?? new BudgetCalibrator()
    this.now = deps.now ?? (() => Date.now())
  }

  // ------------------------------------------------------------------ 对外接口

  onEvent(listener: (event: QuickChatEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot(): QuickChatState {
    const done =
      this.lastDone !== null &&
      this.now() - this.lastDone.at <= QUICK_LAST_DONE_TTL_MS
        ? { ...this.lastDone }
        : null
    const tools = this.deps.tools
    const pending = tools?.pendingApproval() ?? null
    const active = tools?.active()
    return {
      hasKey: this.deps.hasApiKey(),
      phase: this.phase,
      turnId: this.activeTurnId,
      seq: this.seq,
      text: this.phase === 'streaming' ? this.currentText : '',
      lastError: this.lastError,
      lastDone: done,
      pendingApproval: pending,
      toolName: active?.running[0] ?? pending?.toolName ?? null,
      cuaActive: active?.cua === true
    }
  }

  /**
   * 发送一条快捷消息。返回很快；回复通过 `start/delta/done` 事件流式送出。
   * 无 Key、空文本、上一句未完成都返回友好错误，不抛异常。
   */
  send(rawText: string, options: { episodeContext?: string } = {}): QuickSendResult {
    if (this.disposed) return { ok: false, error: QUICK_NO_KEY_MESSAGE }
    const text = rawText.trim()
    if (text === '') return { ok: false, error: '说点什么吧。' }
    if (this.phase === 'streaming') return { ok: false, error: QUICK_BUSY_MESSAGE }
    if (!this.deps.hasApiKey()) {
      this.lastError = QUICK_NO_KEY_MESSAGE
      return { ok: false, error: QUICK_NO_KEY_MESSAGE }
    }

    this.clearIdleTimer()
    if (this.phase === 'ended') {
      this.phase = 'idle'
      this.messages = []
      this.transcript = []
      this.toolNotes = []
      this.seq = 0
    }
    this.lastError = null
    this.finishAfterStream = null
    this.turnSeq += 1
    const turnId = `quick-${this.turnSeq}`
    this.activeTurnId = turnId
    this.seq = 0
    this.currentText = ''
    this.phase = 'streaming'
    this.messages.push({ role: 'user', content: text })
    this.transcript.push({ role: 'user', text })
    this.toolNotes = []
    this.deps.tools?.beginTurn(turnId)
    const config = this.deps.getConfig()
    const toolsEnabled =
      config.chatUi.quickInput.allowTools && this.deps.tools !== undefined
    const systemPrompt = this.deps.buildSystemPrompt(options.episodeContext)
    // 新消息也可能触发上限；先按整包预算（system + 历史 + 工具 schema +
    // 输出预留）裁剪，再构造请求。只裁到当前 turn 仍超限时明确报错。
    this.pruneHistory(systemPrompt)
    const initialBudget = this.estimateRequestBudgetFor(systemPrompt, toolsEnabled)
    if (initialBudget.over && !this.deps.conversationRuntime) {
      if (this.messages.at(-1)?.role === 'user') this.messages.pop()
      if (this.transcript.at(-1)?.role === 'user') this.transcript.pop()
      this.toolNotes = []
      this.currentText = ''
      this.activeTurnId = null
      this.abortController = null
      this.phase = 'idle'
      this.lastError = QUICK_BUDGET_MESSAGE
      this.scheduleIdle()
      return { ok: false, error: QUICK_BUDGET_MESSAGE }
    }
    this.pairingRepairUsed = false
    const controller = new AbortController()
    this.abortController = controller

    this.emit({ type: 'start', id: turnId, userText: text })
    void this.runTurn(turnId, controller, {
      startedAt: this.now(),
      model: config.provider.model,
      maxChars: Math.max(1, config.chatUi.quickInput.maxReplyChars),
      systemPrompt,
      ...(options.episodeContext === undefined
        ? {}
        : { episodeContext: options.episodeContext }),
      toolsEnabled,
      messages: prepareContextMessages(
        [{ role: 'system', content: systemPrompt }, ...this.messages.map(cloneMessage)],
        { source: 'quick-chat', logger: this.deps.logger }
      )
    })
    return { ok: true }
  }

  /** 停止当前流；已收到的部分文本以 done(aborted) 结束。重复调用是 no-op。 */
  stop(): void {
    if (this.phase !== 'streaming') return
    this.deps.tools?.rejectApprovals('快捷聊天已停止')
    this.abortController?.abort()
  }

  /**
   * 显式结束这段快捷上下文：关闭面板、展开完整聊天或 10 分钟空闲。
   * 流式中会等 done/error 后再摘要；失焦自动收起不应调用这里。
   */
  finish(source: FinishSource): void {
    if (this.disposed) return
    if (this.phase === 'streaming') {
      // 等审批或正在操作电脑时，关闭必须立即拒绝/中止，不能挂着 promise。
      const tools = this.deps.tools
      const active = tools?.active()
      if (
        tools !== undefined &&
        (tools.pendingApproval() !== null || (active?.running.length ?? 0) > 0)
      ) {
        tools.rejectApprovals('快捷聊天已关闭')
        this.abortController?.abort()
      }
      this.finishAfterStream = source
      return
    }
    this.finalize(source)
  }

  /** 隐藏视图不停止执行、不清空历史、不写长期摘要。 */
  hideView(): void {
    this.clearIdleTimer()
  }

  /** 用户点「新对话」：丢弃当前上下文，必要时对已发生的交换生成摘要。 */
  reset(): void {
    if (this.disposed) return
    // 无论快捷面板此刻是否为空，「新对话」都明确结束跨入口的当前话题。
    try {
      this.deps.onReset?.()
    } catch (error) {
      this.deps.logger.warn('快捷聊天话题重置回调失败', { error: errorTag(error) })
    }
    if (
      this.phase === 'ended' &&
      this.activeTurnId === null &&
      this.messages.length === 0 &&
      this.transcript.length === 0 &&
      this.currentText === ''
    ) {
      return
    }

    const snapshot = this.takeSnapshot()
    this.deps.conversationRuntime?.clear()
    this.invalidateTurn()
    this.clearIdleTimer()
    this.summaryAbort?.abort()
    this.summaryAbort = null
    this.messages = []
    this.transcript = []
    this.toolNotes = []
    this.currentText = ''
    this.lastError = null
    this.lastDone = null
    this.finishAfterStream = null
    this.seq = 0
    this.phase = 'ended'

    this.emit({ type: 'reset' })
    this.scheduleSummary(snapshot)
  }

  /** 清空本地数据：中断流与摘要，且不生成摘要。 */
  clear(): void {
    if (this.disposed) return
    this.deps.conversationRuntime?.clear()
    try {
      this.deps.onReset?.()
    } catch (error) {
      this.deps.logger.warn('快捷聊天话题重置回调失败', { error: errorTag(error) })
    }
    this.generation += 1
    this.invalidateTurn()
    this.clearIdleTimer()
    this.summaryAbort?.abort()
    this.summaryAbort = null
    this.messages = []
    this.transcript = []
    this.toolNotes = []
    this.currentText = ''
    this.lastError = null
    this.lastDone = null
    this.finishAfterStream = null
    this.seq = 0
    this.phase = 'idle'
    this.emit({ type: 'reset' })
  }

  /** 应用退出：中断所有请求，不生成摘要。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeTopic?.()
    this.generation += 1
    this.invalidateTurn()
    this.clearIdleTimer()
    this.summaryAbort?.abort()
    this.summaryAbort = null
    this.messages = []
    this.transcript = []
    this.toolNotes = []
    this.currentText = ''
    this.lastError = null
    this.lastDone = null
    this.finishAfterStream = null
    this.seq = 0
    this.phase = 'idle'
    this.listeners.clear()
  }

  private async *streamWithBudget(
    request: Parameters<ModelProvider['stream']>[0],
    signal: AbortSignal
  ): ReturnType<ModelProvider['stream']> {
    const key = this.deps.getConfig().provider.baseUrl + '/' + request.model
    const raw = estimateRequestBudget({ messages: request.messages, tools: request.tools }).rawInputTokens
    for await (const event of this.engine.stream(this.deps.provider, request, signal)) {
      if (event.type === 'usage') this.budgetCalibrator.observe(key, raw, event.usage.promptTokens)
      yield event
    }
  }

  isUserTurnActive(): boolean {
    return this.phase === 'streaming' || (this.deps.tools?.pendingApproval() ?? null) !== null
  }

  // ------------------------------------------------------------------ 流式 turn

  private async runTurn(
    turnId: string,
    controller: AbortController,
    request: TurnRequest
  ): Promise<void> {
    const runtime = this.deps.conversationRuntime
    const lease = runtime ? await runtime.acquire() : null
    let base = 0
    let prepared = false
    try {
      if (!this.isCurrent(turnId) || controller.signal.aborted || (runtime && lease && !runtime.current(lease.generation))) return
      if (runtime) {
        runtime.session.records = stripImagesFromRecords(runtime.session.records)
        const user = request.messages.at(-1)!
        runtime.userWorkState.noteUser(typeof user.content === 'string' ? user.content : '', this.now())
        request.systemPrompt += '\n\n' + (runtime.userWorkState.toPrompt() ?? '')
        this.messages = [...runtime.session.messages({ omitBaseSystem: true }).filter(message => !(message.role === 'system' && typeof message.content === 'string' && message.content.startsWith('[工作状态]'))), user]
        base = this.messages.length - 1
        prepared = true
        request.messages = this.requestMessages(request.systemPrompt)
        if (this.estimateRequestBudgetFor(request.systemPrompt, request.toolsEnabled).over) { prepared = false; throw new Error(QUICK_BUDGET_MESSAGE) }
      }
      await this.engine.attempts(() => this.runEngineTurn(turnId, controller, request))
    } catch (error) {
      if (this.isCurrent(turnId)) this.failTurn(turnId, error)
    } finally {
      if (runtime && lease && prepared && runtime.current(lease.generation)) {
        const committed: ContextRecord[] = []
        for (const message of repairToolPairingMessages(this.messages.slice(base))) {
          const ts = new Date(this.now()).toISOString()
          const meta = { ts, source: 'quick' as const, retention: 'memory' as const }
          const text = typeof message.content === 'string' ? message.content : ''
          let record: ContextRecord | null = null
          if (message.role === 'user') record = { ...meta, kind: 'user', text, ...(Array.isArray(message.content) ? { images: message.content.filter(part => part.type === 'image_url').map(part => ({ mimeType: part.image_url.url.startsWith('data:image/png') ? 'image/png' as const : 'image/jpeg' as const, data: part.image_url.url.split(',')[1] ?? '', width: 0, height: 0, at: this.now() })) } : {}) }
          if (message.role === 'assistant') record = { ...meta, kind: 'assistant', text, ...(message.tool_calls ? { toolCalls: message.tool_calls.map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })) } : {}) }
          if (message.role === 'tool') record = { ...meta, kind: 'tool', text, toolCallId: message.tool_call_id!, name: message.name ?? '' }
          if (record) {
            if (record.kind === 'user' && committed.length === 0) record.ts = new Date(request.startedAt).toISOString()
            runtime.session.append(record)
            committed.push(record)
          }
        }
        this.deps.onRecordsChanged?.(committed)
        this.messages = []
      }
      lease?.release()
    }
  }

  private async runEngineTurn(
    turnId: string,
    controller: AbortController,
    request: TurnRequest
  ): Promise<void | 'retry'> {
    const tools: QuickToolGateway = this.deps.tools ?? {
      specs: () => [], allowedNames: () => [], visibleNames: () => [], catalogText: () => '', revision: () => 0,
      lastSnapshot: () => null, beginTurn: () => {}, rejectApprovals: () => {}, pendingApproval: () => null,
      active: () => ({ running: [], cua: false }),
      execute: async () => ({ outcome: { text: '[TOOL_DENIED] 此视图未启用工具', failed: true }, endsTurn: false })
    }

    const streamingText = !request.toolsEnabled
    let finalText = ''
    let truncated = false
    let aborted = false
    let capped = false
    let budgetCapped = false
    let toolCallsUsed = request.toolsUsed ?? 0
    let limitNoticed = false
    let promptRevision = tools.revision()
    let cancelled = false

    try {
      const outcome = await this.engine.run({
        hardRounds: Math.max(1, QUICK_MAX_TOOL_ROUNDS - (request.roundsUsed ?? 0)),
        isStopped: () => cancelled || controller.signal.aborted,
        prepareRound: () => {
          if ((request.roundsUsed ?? 0) >= QUICK_MAX_TOOL_ROUNDS) return 'budget-exceeded'
          request.roundsUsed = (request.roundsUsed ?? 0) + 1
          if (!this.isCurrent(turnId)) {
            cancelled = true
            return 'stop'
          }
          // tools_load 只改下一轮；提示词里的可见工具与目录必须同步刷新。
          if (tools.revision() !== promptRevision) {
            request.systemPrompt = this.deps.buildSystemPrompt(request.episodeContext)
            promptRevision = tools.revision()
          }
          // 工具回执或新加载的 schema 可能让请求突然变大；每轮发送前重算。
          this.pruneHistory(request.systemPrompt)
          if (this.estimateRequestBudgetFor(request.systemPrompt, request.toolsEnabled).over) {
            finalText = QUICK_BUDGET_NOTICE
            capped = true
            budgetCapped = true
            return 'budget-exceeded'
          }
          if (!streamingText) this.emit({ type: 'phase', id: turnId, phase: 'thinking' })
          return 'continue'
        },
        modelRound: async () => {
          const accums = new Map<number, ToolCallAccum>()
          let roundText = ''
          for await (const event of this.streamWithBudget(
            {
              model: request.model,
              messages: this.requestMessages(request.systemPrompt),
              ...(request.toolsEnabled ? { tools: tools.specs() } : {}),
              maxTokens: request.toolsEnabled ? QUICK_TOOL_MAX_TOKENS : QUICK_TEXT_MAX_TOKENS,
              thinking: false
            },
            controller.signal
          )) {
            if (event.type === 'usage') {
              this.deps.usage.record(request.model, 'quick-chat', event.usage, {
                turnId,
                source: 'quick-chat'
              })
              continue
            }
            if (controller.signal.aborted) break
            if (event.type === 'text') {
              roundText += event.text
              if (streamingText && this.isCurrent(turnId)) {
                const visible = roundText.slice(0, request.maxChars)
                const delta = visible.slice(this.currentText.length)
                this.currentText = visible
                if (delta) { this.seq++; this.emit({ type: 'delta', id: turnId, seq: this.seq, text: visible }) }
              }
            }
            else if (event.type === 'tool_call') this.engine.accumulate(event, accums)
          }
          if (!this.isCurrent(turnId)) {
            cancelled = true
            return { toolCalls: [], failed: false, needsHandoff: false }
          }
          if (controller.signal.aborted) {
            aborted = true
            finalText = roundText
            return { toolCalls: [], failed: false, needsHandoff: false }
          }

          const calls = (request.toolsEnabled ? [...accums.values()] : [])
            .sort((a, b) => a.index - b.index)
            .filter(
              (call): call is ToolCallAccum & { id: string; name: string } =>
                typeof call.id === 'string' &&
                call.id !== '' &&
                typeof call.name === 'string' &&
                call.name !== ''
            )
            .map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }))

          if (calls.length === 0) {
            finalText = roundText
            return { toolCalls: [], failed: false, needsHandoff: false }
          }

          // 中间轮的文字只作为 assistant 上下文，不写进气泡。
          this.messages.push({
            role: 'assistant',
            content: roundText === '' ? null : roundText,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.arguments }
            }))
          })
          return { toolCalls: calls, failed: false, needsHandoff: false }
        },
        onCapped: () => {
          capped = true
        },
        toolRound: async (calls) => {
          const images: ToolImage[] = []
          let batchAborted = false
          let batchCapped = false
          let batchEnded = false

          await this.engine.batch(calls, async (call) => {
            if (controller.signal.aborted) batchAborted = true
            if (batchAborted || batchCapped) {
              this.appendToolPlaceholder(
                call,
                batchAborted
                  ? '[TOOL_ABORTED] 已停止'
                  : '[TOOL_SKIPPED] 本次快捷操作已达到上限'
              )
              return
            }
            if (toolCallsUsed >= QUICK_MAX_TOOL_CALLS) {
              batchCapped = true
              this.appendToolPlaceholder(call, '[TOOL_SKIPPED] 本次快捷操作已达到上限')
              return
            }
            toolCallsUsed += 1
            request.toolsUsed = toolCallsUsed

            this.emit({
              type: 'phase',
              id: turnId,
              phase: 'tool',
              tool: call.name,
              cua: call.name.startsWith('cua_')
            })
            this.emit({
              type: 'tool',
              id: turnId,
              toolCallId: call.id,
              name: call.name,
              state: 'start'
            })
            let result: ToolExecutionResult
            try {
              result = await tools.execute(call, {
                turnId,
                turn: this.turnSeq,
                signal: controller.signal,
                onApproval: (name) => {
                  if (!this.isCurrent(turnId)) return
                  this.emit({
                    type: 'phase',
                    id: turnId,
                    phase: 'waiting',
                    tool: name,
                    cua: name.startsWith('cua_')
                  })
                }
              })
            } catch (error) {
              // 必须留下同 id 的回执，否则下一轮请求会缺 tool 消息。
              const detail = error instanceof Error ? error.message : String(error)
              this.deps.logger.error('快捷工具执行异常', {
                tool: call.name,
                callId: call.id,
                error: detail.slice(0, 300)
              })
              result = {
                outcome: {
                  text: `[TOOL_FAILED] ${call.name} 执行异常：${detail.slice(0, 180)}`,
                  failed: true
                },
                endsTurn: false
              }
            }
            if (!this.isCurrent(turnId)) {
              cancelled = true
              return 'stop'
            }

            this.messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: result.outcome.text
            })
            this.deps.conversationRuntime?.userWorkState.noteTool({ tool: call.name, targetRef: result.outcome.meta?.targetRef, failed: result.outcome.failed, text: result.outcome.text }, this.now())
            this.toolNotes.push(call.name)
            this.emit({
              type: 'tool',
              id: turnId,
              toolCallId: call.id,
              name: call.name,
              state: 'done',
              ...(result.outcome.failed === true ? { failed: true } : {})
            })
            if (result.outcome.failed !== true) {
              for (const image of result.outcome.images ?? []) images.push(image)
            }

            if (result.endsTurn) {
              batchEnded = true
              return 'stop'
            }
            if (controller.signal.aborted) batchAborted = true
          }, call => this.appendToolPlaceholder(call, '[TOOL_SKIPPED] 本轮已结束，未执行'))

          if (images.length > 0) this.appendToolImages(images)
          this.pruneHistory()

          if (batchAborted) {
            aborted = true
            return { endsTurn: false, stopped: true }
          }
          if (batchEnded || batchCapped || toolCallsUsed >= QUICK_MAX_TOOL_CALLS) {
            return { endsTurn: false, capped: true }
          }
          return { endsTurn: false }
        }
      })

      if (cancelled || !this.isCurrent(turnId)) return
      if (outcome === 'stopped') aborted = true
      if (outcome === 'budget-exceeded') budgetCapped = true
      if (!aborted && !budgetCapped && (capped || finalText === '')) {
        if (capped && !limitNoticed) {
          limitNoticed = true
          this.emit({ type: 'notice', id: turnId, text: QUICK_TOOL_LIMIT_NOTICE })
        }
        finalText = await this.runFinalSummaryRequest(turnId, controller, request)
        if (!this.isCurrent(turnId)) return
        if (controller.signal.aborted) aborted = true
      }
    } catch (error) {
      if (!this.isCurrent(turnId)) return
      if (!controller.signal.aborted) {
        if (!this.pairingRepairUsed && isToolPairingError(error as { status?: number; code?: string; message?: string })) {
          this.pairingRepairUsed = true
          const warnings: string[] = []
          const before = this.messages.length
          this.messages = repairModelMessages(this.messages, warnings)
          this.deps.logger.warn('快捷聊天工具配对错误，修复后重试一次', {
            error: errorTag(error),
            messagesBefore: before,
            messagesAfter: this.messages.length,
            warnings
          })
          return 'retry'
        }
        this.deps.tools?.rejectApprovals('快捷聊天出错')
        this.failTurn(turnId, error)
        return
      }
      aborted = true
    }

    if (!this.isCurrent(turnId)) return
    // 气泡截断只影响呈现；完整 finalText 仍进入历史/转写/聊天交接。
    const displayText =
      finalText.length > request.maxChars
        ? finalText.slice(0, request.maxChars)
        : finalText
    if (displayText.length < finalText.length) truncated = true
    if (displayText !== '' && !streamingText) {
      this.currentText = displayText
      this.seq += 1
      this.emit({ type: 'delta', id: turnId, seq: this.seq, text: displayText })
    }
    this.completeTurn(turnId, aborted, truncated, finalText)
  }

  /** 达到轮次/动作上限后的无工具收尾：只要一两句话总结。 */
  private async runFinalSummaryRequest(
    turnId: string,
    controller: AbortController,
    request: TurnRequest
  ): Promise<string> {
    // 收尾请求不带工具，但仍使用同一段历史；放不下时不要发送必然失败的请求。
    if (this.estimateRequestBudgetFor(request.systemPrompt, false).over) {
      return QUICK_BUDGET_NOTICE
    }
    let text = ''
    for await (const event of this.streamWithBudget(
      {
        model: request.model,
        messages: this.requestMessages(request.systemPrompt),
        maxTokens: QUICK_TEXT_MAX_TOKENS,
        thinking: false
      },
      controller.signal
    )) {
      if (event.type === 'usage') {
        this.deps.usage.record(request.model, 'quick-chat', event.usage, {
          turnId,
          source: 'quick-chat'
        })
        continue
      }
      if (controller.signal.aborted) break
      if (event.type !== 'text' || !this.isCurrent(turnId)) continue
      // 收尾摘要同样是模型输出；呈现长度在 runEngineTurn 里统一裁剪。
      text += event.text
    }
    return text
  }

  private requestMessages(systemPrompt: string): ModelMessage[] {
    return prepareContextMessages(
      [{ role: 'system', content: systemPrompt }, ...this.messages.map(cloneMessage)],
      { source: 'quick-chat', logger: this.deps.logger }
    )
  }

  private appendToolPlaceholder(call: QuickToolCall, text: string): void {
    this.messages.push({
      role: 'tool',
      tool_call_id: call.id,
      name: call.name,
      content: text
    })
  }

  /** 图片只能作为独立 user 消息，且必须排在整批 tool 回执之后。 */
  private appendToolImages(images: ToolImage[]): void {
    const latest = selectToolImages(images, {
      screenshots: MAX_SCREENSHOT_IMAGES,
      frames: MAX_VIDEO_FRAME_IMAGES
    })
    if (latest.length === 0) return
    const parts: ModelContentPart[] = [
      { type: 'text', text: describeToolImages(latest) }
    ]
    for (const image of latest) {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${image.mimeType};base64,${image.data}`,
          ...(image.detail === undefined ? {} : { detail: image.detail })
        }
      })
    }
    const message: ModelMessage = { role: 'user', content: parts }
    this.messages.push(message)
    this.imageKinds.set(
      message,
      latest.map((image) => toolImageKind(image))
    )
    this.pruneImages()
  }

  /**
   * `contextText` 是模型完整输出，用于历史/转写/聊天交接；
   * `currentText` 是已经发给气泡的呈现文本，`lastDone`/done 只暴露后者。
   */
  private completeTurn(
    turnId: string,
    aborted: boolean,
    truncated: boolean,
    contextText: string = this.currentText
  ): void {
    if (!this.isCurrent(turnId)) return
    this.deps.tools?.rejectApprovals('本轮已结束')
    const displayText = this.currentText
    this.deps.conversationRuntime?.userWorkState.noteAssistant(contextText, this.now())
    const fullText = contextText.trim() !== '' ? contextText : displayText
    if (fullText.trim() !== '') {
      this.messages.push({ role: 'assistant', content: fullText })
      this.transcript.push({ role: 'assistant', text: fullText })
      this.pruneHistory()
      this.pruneTranscript()
    }
    this.currentText = ''
    this.activeTurnId = null
    this.abortController = null
    this.phase = 'idle'
    this.lastError = null
    if (displayText.trim() !== '') {
      this.lastDone = { id: turnId, text: displayText, at: this.now() }
    }
    // 只交接完整说完的回复；用户 stop 掉的部分回复不能当作稳定事实。
    if (!aborted && fullText.trim() !== '') {
      try {
        this.deps.onAssistantReply?.(fullText, this.now())
      } catch (error) {
        this.deps.logger.warn('快捷聊天交接回调失败', { error: errorTag(error) })
      }
    }

    this.emit({
      type: 'done',
      id: turnId,
      seq: this.seq,
      text: displayText,
      ...(aborted ? { aborted: true } : {}),
      ...(truncated ? { truncated: true } : {})
    })
    this.scheduleIdle()
    this.flushFinishAfterStream()
  }

  private failTurn(
    turnId: string,
    error: unknown,
    contextText: string = this.currentText
  ): void {
    if (!this.isCurrent(turnId)) return
    this.deps.tools?.rejectApprovals('快捷聊天出错')
    const displayPartial = this.currentText
    const partial = contextText.trim() !== '' ? contextText : displayPartial
    if (partial.trim() !== '') {
      // 片段只进摘要转写，不进下一轮上下文：失败的回复不当作事实。
      this.transcript.push({ role: 'assistant', text: partial, interrupted: true })
      this.pruneTranscript()
    }
    this.currentText = ''
    this.activeTurnId = null
    this.abortController = null
    this.phase = 'idle'
    this.lastError = QUICK_ERROR_MESSAGE
    this.deps.logger.warn('快捷聊天请求失败', {
      error: errorTag(error),
      ...(error instanceof ProviderError
        ? {
            code: error.code,
            category: error.category,
            status: error.status ?? null,
            causeStatus: error.diagnostics.causeStatus,
            causeCode: error.diagnostics.causeCode ?? null,
            transportPhase: error.diagnostics.transportPhase
          }
        : {})
    })

    this.emit({
      type: 'error',
      id: turnId,
      message: QUICK_ERROR_MESSAGE,
      seq: this.seq,
      ...(displayPartial !== '' ? { text: displayPartial } : {})
    })
    this.scheduleIdle()
    this.flushFinishAfterStream()
  }

  private flushFinishAfterStream(): void {
    if (this.finishAfterStream === null) return
    const source = this.finishAfterStream
    this.finishAfterStream = null
    this.finalize(source)
  }

  // ------------------------------------------------------------------ 结束与摘要

  private takeSnapshot(): HistorySnapshot {
    const transcript = this.transcript.map((item) => ({ ...item }))
    if (this.currentText.trim() !== '') {
      transcript.push({ role: 'assistant', text: this.currentText, interrupted: true })
    }
    return {
      messages: this.messages.map(cloneMessage),
      transcript,
      toolNotes: [...this.toolNotes]
    }
  }

  private finalize(source: FinishSource): void {
    if (this.disposed) return
    if (this.phase === 'ended' && this.messages.length === 0 && this.transcript.length === 0) {
      return
    }
    const snapshot = this.takeSnapshot()
    this.messages = []
    this.transcript = []
    this.toolNotes = []
    this.currentText = ''
    this.activeTurnId = null
    this.abortController = null
    this.lastError = null
    this.finishAfterStream = null
    this.phase = 'ended'
    this.clearIdleTimer()

    this.emit({ type: 'ended', reason: source })
    this.scheduleSummary(snapshot)
  }

  private scheduleSummary(snapshot: HistorySnapshot): void {
    if (this.disposed || !this.deps.getConfig().memory.enabled) return
    if (!hasExchange(snapshot.transcript)) return
    const transcript = buildTranscript(snapshot.transcript, snapshot.toolNotes)
    if (transcript === '') return
    const generation = this.generation

    this.summaryChain = this.summaryChain
      .then(() => this.runSummary(transcript, generation))
      .catch((error: unknown) => {
        // 摘要链本身不能断；这里只记错误类型，不记对话内容。
        this.deps.logger.warn('快捷对话摘要任务异常', { error: errorTag(error) })
      })
  }

  private async runSummary(transcript: string, generation: number): Promise<void> {
    if (generation !== this.generation || this.disposed) return
    if (!this.deps.getConfig().memory.enabled) return

    const controller = new AbortController()
    this.summaryAbort = controller
    let raw = ''
    try {
      raw = await this.deps.summarize(
        [
          { role: 'system', content: QUICK_SUMMARY_PROMPT },
          { role: 'user', content: transcript }
        ],
        controller.signal
      )
    } catch (error) {
      if (generation === this.generation && !this.disposed) {
        this.deps.logger.warn('快捷对话摘要失败', { error: errorTag(error) })
      }
      return
    } finally {
      if (this.summaryAbort === controller) this.summaryAbort = null
    }

    // 摘要 await 期间可能已经 clear()/dispose()：仅靠 abort 拦不住已完成的 promise。
    if (generation !== this.generation || this.disposed) return
    if (!this.deps.getConfig().memory.enabled) return

    const summary = summaryText(raw)
    if (summary === '' || summary === '[无]') return
    try {
      this.deps.appendRecent(`快捷对话摘要：${summary}`)
      this.deps.requestPromptRefresh()
      this.deps.logger.info('快捷对话摘要已写入', { chars: summary.length })
    } catch (error) {
      this.deps.logger.warn('快捷对话摘要写入失败', { error: errorTag(error) })
    }
  }

  // ------------------------------------------------------------------ 内部

  private isCurrent(turnId: string): boolean {
    return !this.disposed && this.activeTurnId === turnId
  }

  private invalidateTurn(): void {
    this.turnSeq += 1
    this.activeTurnId = null
    this.deps.tools?.rejectApprovals('快捷聊天已结束')
    this.abortController?.abort()
    this.abortController = null
  }

  /**
   * 以“真实用户 turn”为单位从最早处丢弃，保证 tool_calls 与其回执不会被拆散。
   * 图片 user 消息不是 turn 边界，只受截图/视频抽帧的分别限额约束。
   */
  private pruneHistory(systemPrompt?: string): void {
    if (this.deps.conversationRuntime) return
    this.messages = repairToolPairingMessages(this.messages)
    this.pruneImages()
    while (this.historyTooLong(systemPrompt)) {
      const start = this.messages.findIndex(isPlainUserMessage)
      if (start < 0) break
      let next = -1
      for (let i = start + 1; i < this.messages.length; i += 1) {
        const message = this.messages[i]
        if (message !== undefined && isPlainUserMessage(message)) {
          next = i
          break
        }
      }
      // 只剩当前 turn：宁可略超上限，也不用孤立 tool 消息破坏配对。
      if (next < 0) break
      this.messages.splice(0, next)
      this.messages = repairToolPairingMessages(this.messages)
      this.pruneImages()
    }
  }

  /**
   * 快捷通道与主聊天共用请求级预算口径：system 提示、历史、工具 schema、
   * 图片和输出预留一起算。消息条数/字符数仍作为便宜的早期上限。
   */
  private historyTooLong(systemPrompt?: string): boolean {
    if (this.messages.length > QUICK_HISTORY_MAX_MESSAGES) return true
    const textChars = this.messages.reduce(
      (total, message) => total + contentTextLength(message),
      0
    )
    if (textChars > QUICK_HISTORY_MAX_CHARS) return true
    return this.estimateRequestBudgetFor(
      systemPrompt ?? this.deps.buildSystemPrompt(),
      this.quickToolsEnabled()
    ).over
  }

  private quickToolsEnabled(): boolean {
    const config = this.deps.getConfig()
    return config.chatUi.quickInput.allowTools && this.deps.tools !== undefined
  }

  private estimateRequestBudgetFor(
    systemPrompt: string,
    toolsEnabled: boolean
  ): { over: boolean; total: number; capacity: number } {
    const config = this.deps.getConfig()
    const window = config.provider.contextWindow
    const capacity = Math.max(
      1_024,
      Math.min(
        config.context.maxTokens > 0 ? config.context.maxTokens : 64_000,
        Number.isFinite(window) && window > 0 ? window : Number.POSITIVE_INFINITY
      )
    )
    const assembly = assembleContext({
      messages: [
        { role: 'system', content: systemPrompt },
        ...this.messages.map(cloneMessage)
      ],
      tools: toolsEnabled
        ? (this.deps.tools?.budgetSpecs?.() ?? this.deps.tools?.specs() ?? [])
        : [],
      outputReserve: QUICK_TOOL_MAX_TOKENS,
      safetyMargin: 256,
      calibration: this.budgetCalibrator.factor(config.provider.baseUrl + '/' + config.provider.model),
      capacity,
      source: 'quick-chat',
      logger: this.deps.logger
    })
    return { over: assembly.over, total: assembly.budget.total, capacity }
  }

  /**
   * 截图最多 2 张、B 站故事板抽帧最多 6 张；超出的从最老的图片消息开始删。
   * 两类图片分开计数，避免抽帧把坐标截图挤掉，或反被截图挤掉。
   */
  private pruneImages(): void {
    const counts: Record<'screenshot' | 'video-frame', number> = {
      screenshot: 0,
      'video-frame': 0
    }
    for (const message of this.messages) {
      if (!Array.isArray(message.content)) continue
      const kinds = this.imageKinds.get(message)
      let imageIndex = 0
      for (const part of message.content) {
        if (part.type !== 'image_url') continue
        const kind = kinds?.[imageIndex] ?? 'screenshot'
        counts[kind] += 1
        imageIndex += 1
      }
    }
    const excess: Record<'screenshot' | 'video-frame', number> = {
      screenshot: Math.max(0, counts.screenshot - MAX_SCREENSHOT_IMAGES),
      'video-frame': Math.max(0, counts['video-frame'] - MAX_VIDEO_FRAME_IMAGES)
    }
    if (excess.screenshot === 0 && excess['video-frame'] === 0) return
    let messageIndex = 0
    while (messageIndex < this.messages.length) {
      const message = this.messages[messageIndex]
      if (message === undefined || !Array.isArray(message.content)) {
        messageIndex += 1
        continue
      }
      const kinds = this.imageKinds.get(message) ?? []
      const remainingKinds: Array<'screenshot' | 'video-frame'> = []
      let imageIndex = 0
      const content = message.content.filter((part) => {
        if (part.type !== 'image_url') return true
        const kind = kinds[imageIndex] ?? 'screenshot'
        imageIndex += 1
        if (excess[kind] > 0) {
          excess[kind] -= 1
          return false
        }
        remainingKinds.push(kind)
        return true
      })
      if (remainingKinds.length === 0) {
        this.messages.splice(messageIndex, 1)
        continue
      }
      message.content = content
      this.imageKinds.set(message, remainingKinds)
      messageIndex += 1
    }
  }

  private pruneTranscript(): void {
    const chars = (): number =>
      this.transcript.reduce((total, item) => total + item.text.length, 0)
    while (this.transcript.length > 2 && chars() > QUICK_TRANSCRIPT_MAX_CHARS) {
      this.transcript.shift()
    }
  }

  private scheduleIdle(): void {
    this.clearIdleTimer()
    if (this.disposed) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.hideView()
    }, QUICK_IDLE_TIMEOUT_MS)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private emit(event: QuickChatEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.deps.logger.warn('快捷聊天监听器异常', { error: errorTag(error) })
      }
    }
  }
}

