import type { Logger, ModelMessage, PrefixSegment, ToolSpec } from './types'
import {
  estimateMessagesTokens,
  estimateRequestBudget,
  type RequestBudgetEstimate
} from './requestBudget'
import { prepareMessagesForProvider } from './protocol'

/**
 * 请求上下文装配的唯一入口。
 *
 * 它不生产人格、记忆或工具说明，只把各段已经准备好的内容合成一次请求：
 * - 先过现有 Provider 协议闸门；
 * - 再按同一口径估算消息/图片/工具 schema/输出预留；
 * - 保留每段的来源与规模，供诊断定位“哪一段把窗口撑大”。
 *
 * Core 与 QuickChat 都走这里，避免各自维护一套预算公式。段的原文不会进入
 * 诊断，只保留 id、字符数与估算 token。
 */

export interface ContextSegmentUsage {
  id: string
  kind: 'persona' | 'system' | 'history'
  chars: number
  tokens: number
}

export interface ContextAssemblyInput {
  messages: readonly ModelMessage[]
  /** 系统提示的分段来源；没有时按第一条 system 消息记一段。 */
  systemSegments?: readonly PrefixSegment[]
  tools?: readonly ToolSpec[]
  outputReserve: number
  capacity: number
  calibration?: number
  safetyMargin?: number
  source: string
  sessionId?: string
  logger?: Logger
}

export interface ContextAssembly {
  messages: ModelMessage[]
  segments: ContextSegmentUsage[]
  budget: RequestBudgetEstimate
  capacity: number
  over: boolean
  repaired: boolean
}

function messageTextChars(message: ModelMessage): number {
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

function systemText(messages: readonly ModelMessage[]): string | null {
  const first = messages[0]
  if (first?.role !== 'system' || typeof first.content !== 'string') return null
  return first.content
}

function segmentUsage(
  input: ContextAssemblyInput,
  messages: readonly ModelMessage[],
  messageTextTokens: number
): ContextSegmentUsage[] {
  const raw =
    input.systemSegments !== undefined && input.systemSegments.length > 0
      ? input.systemSegments.map((segment) => ({
          id: segment.id,
          kind: 'persona' as const,
          chars: segment.text.length,
          tokens: estimateMessagesTokens([
            { role: 'system', content: segment.text }
          ]).textTokens
        }))
      : (() => {
          const text = systemText(messages)
          if (text === null) return []
          return [
            {
              id: 'system',
              kind: 'system' as const,
              chars: text.length,
              tokens: estimateMessagesTokens([{ role: 'system', content: text }]).textTokens
            }
          ]
        })()
  const segmentTokens = raw.reduce((sum, segment) => sum + segment.tokens, 0)
  const historyChars = messages.reduce(
    (sum, message) => sum + messageTextChars(message),
    0
  )
  const historyTokens = Math.max(0, messageTextTokens - segmentTokens)
  const segments: ContextSegmentUsage[] = [...raw]
  if (historyTokens > 0 || historyChars > 0) {
    segments.push({
      id: 'history',
      kind: 'history',
      chars: Math.max(0, historyChars - raw.reduce((sum, segment) => sum + segment.chars, 0)),
      tokens: historyTokens
    })
  }
  return segments
}

export function assembleContext(input: ContextAssemblyInput): ContextAssembly {
  const prepared = prepareMessagesForProvider([...input.messages], {
    source: input.source,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId })
  })
  const estimated = estimateMessagesTokens(prepared.messages)
  const budget = estimateRequestBudget({
    messages: prepared.messages,
    tools: input.tools === undefined ? [] : [...input.tools],
    outputReserve: input.outputReserve,
    ...(input.calibration === undefined ? {} : { calibration: input.calibration }),
    ...(input.safetyMargin === undefined ? {} : { safetyMargin: input.safetyMargin })
  })
  return {
    messages: prepared.messages,
    segments: segmentUsage(input, prepared.messages, estimated.textTokens),
    budget,
    capacity: input.capacity,
    over: budget.total > input.capacity,
    repaired: prepared.repaired
  }
}

/** 只做协议闸门；不估算、不产生分段，供不需要预算的发送路径复用。 */
export function prepareContextMessages(
  messages: readonly ModelMessage[],
  options: { source: string; logger?: Logger; sessionId?: string }
): ModelMessage[] {
  return prepareMessagesForProvider([...messages], options).messages
}
