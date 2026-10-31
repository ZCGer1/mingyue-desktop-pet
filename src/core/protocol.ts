import type { Logger, ModelMessage } from './types'

/**
 * 临时观察正文到期后的回执壳。它不含正文，但明确说明该工具**执行成功**、
 * 只是内容不再可用；与「失败」和「结果未知」严格区分，禁止模型据此重放
 * 有副作用的动作。
 */
export const EXPIRED_TOOL_TEXT =
  '[该工具已成功执行；观察内容已过期，需要时请重新读取。不要把这次调用当成失败或结果未知，也不要自动重放。]'

/**
 * 临时工具回执原本就是失败时，过期壳必须继续标明失败。不能改成
 * “已执行完成”，否则模型会把失败的打开/读取当成成功，并基于不存在的
 * 页面继续行动。
 */
export const EXPIRED_FAILED_TOOL_TEXT =
  '[失败回执的详细内容已过期；该工具本次执行失败，不会自动重放，需要时请重新判断是否重试。]'

/** 结果未知（缺少原始回执）且临时正文过期；继续保持“未知”，不伪造成成功或普通失败。 */
export const EXPIRED_UNKNOWN_TOOL_TEXT =
  '[结果未知：原始回执缺失且临时内容已过期，未自动重放该操作。]'

/**
 * 历史记录缺少回执时的占位。执行结果无法从现有数据确定，禁止自动重放
 * 有副作用的工具。
 */
export const UNKNOWN_TOOL_TEXT =
  '[结果未知：缺少对应的工具回执，未自动重放该操作。]'

export interface ProtocolGap {
  callId: string
  name?: string
  /** 在消息数组中的下标；只用于本地诊断。 */
  at: number
}

export interface ProtocolReport {
  ok: boolean
  groups: number
  calls: number
  results: number
  missing: ProtocolGap[]
  orphanResults: number
  duplicateResults: number
  duplicateCallIds: string[]
}

const TOOL_PAIRING_400 =
  /must be followed by tool messages|insufficient tool messages|tool_call_id|tool_calls.*tool message|missing tool (?:message|result)/i

const CONTEXT_LENGTH_400 =
  /context.*(length|too long)|maximum context|token.*exceed|prompt is too long/i

/**
 * 是否是「工具调用/回执配对」类的 HTTP 400。
 * 明确排除上下文超长：那需要交接而不是修配对。
 */
export function isToolPairingError(error: {
  status?: number
  code?: string
  message?: string
}): boolean {
  const message = error.message ?? ''
  if (CONTEXT_LENGTH_400.test(message)) return false
  const is400 = error.status === 400 || error.code === 'HTTP_400'
  if (!is400) return false
  return TOOL_PAIRING_400.test(message)
}

/**
 * 只读检查消息数组里的工具协议结构。不修改输入，不记录正文。
 */
export function inspectToolProtocol(messages: ModelMessage[]): ProtocolReport {
  const missing: ProtocolGap[] = []
  const duplicateCallIds: string[] = []
  let orphanResults = 0
  let duplicateResults = 0
  let groups = 0
  let calls = 0
  let results = 0
  let i = 0
  while (i < messages.length) {
    const message = messages[i]
    if (message === undefined) break
    if (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0) {
      groups += 1
      const expected = new Set<string>()
      for (const call of message.tool_calls ?? []) {
        calls += 1
        if (expected.has(call.id)) duplicateCallIds.push(call.id)
        else expected.add(call.id)
      }
      const seen = new Set<string>()
      let j = i + 1
      while (j < messages.length && messages[j]?.role === 'tool') {
        const toolMessage = messages[j]
        const id = toolMessage?.tool_call_id ?? ''
        results += 1
        if (!expected.has(id)) {
          orphanResults += 1
          j += 1
          continue
        }
        if (seen.has(id)) duplicateResults += 1
        else seen.add(id)
        j += 1
      }
      for (const call of message.tool_calls ?? []) {
        if (!seen.has(call.id) && !missing.some((gap) => gap.callId === call.id && gap.at === i)) {
          missing.push({ callId: call.id, name: call.function.name, at: i })
        }
      }
      i = j
      continue
    }
    if (message.role === 'tool') {
      results += 1
      orphanResults += 1
    }
    i += 1
  }
  return {
    ok:
      missing.length === 0 &&
      orphanResults === 0 &&
      duplicateResults === 0 &&
      duplicateCallIds.length === 0,
    groups,
    calls,
    results,
    missing,
    orphanResults,
    duplicateResults,
    duplicateCallIds
  }
}

/**
 * 修复消息数组的工具配对：
 * - 同一调用 id 只保留一次；
 * - 每个调用 id 恰好一条回执；
 * - 缺失回执补「结果未知」，不伪造成功、不重放工具；
 * - 孤立/重复回执删除，并把缺失回执补在组内，保证紧跟 assistant。
 */
export function repairModelMessages(
  messages: ModelMessage[],
  warnings: string[] = []
): ModelMessage[] {
  const out: ModelMessage[] = []
  let i = 0
  while (i < messages.length) {
    const message = messages[i]
    if (message === undefined) break
    if (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0) {
      const seenCalls = new Set<string>()
      const calls = (message.tool_calls ?? []).filter((call) => {
        if (seenCalls.has(call.id)) {
          warnings.push(`重复工具调用 id ${call.id}，已去重`)
          return false
        }
        seenCalls.add(call.id)
        return true
      })
      out.push({ ...message, tool_calls: calls })
      const expected = new Set(calls.map((call) => call.id))
      const seenResults = new Set<string>()
      let j = i + 1
      while (j < messages.length && messages[j]?.role === 'tool') {
        const toolMessage = messages[j]
        const id = toolMessage?.tool_call_id ?? ''
        if (!expected.has(id)) {
          warnings.push('孤立工具回执，已删除')
          j += 1
          continue
        }
        if (seenResults.has(id)) {
          warnings.push(`重复工具回执 ${id}，已保留第一条`)
          j += 1
          continue
        }
        seenResults.add(id)
        out.push(toolMessage as ModelMessage)
        j += 1
      }
      for (const call of calls) {
        if (seenResults.has(call.id)) continue
        out.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: UNKNOWN_TOOL_TEXT
        })
        warnings.push(`工具调用 ${call.function.name} 缺少回执，已补「结果未知」占位`)
      }
      i = j
      continue
    }
    if (message.role === 'tool') {
      warnings.push('孤立工具回执，已删除')
      i += 1
      continue
    }
    out.push(message)
    i += 1
  }
  return out
}

/** 只含结构的指纹；用于识别「同版本、同结构」的重复 400。 */
export function protocolMessageFingerprint(messages: ModelMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0) {
      parts.push(`A:${message.tool_calls?.map((call) => `${call.id}/${call.function.name}`).join('|') ?? ''}`)
    } else if (message.role === 'tool') {
      parts.push(`T:${message.tool_call_id ?? ''}`)
    }
  }
  return `${parts.length}:${fnv1a(parts.join('\n'))}`
}

function fnv1a(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(16)
}

/** 日志用的结构摘要；绝不包含消息正文或工具参数。 */
export function protocolLogData(report: ProtocolReport): Record<string, unknown> {
  return {
    ok: report.ok,
    groups: report.groups,
    calls: report.calls,
    results: report.results,
    missingCount: report.missing.length,
    missingTools: report.missing.map((gap) => gap.name ?? 'unknown'),
    orphanResults: report.orphanResults,
    duplicateResults: report.duplicateResults,
    duplicateCallIds: report.duplicateCallIds.length
  }
}

/**
 * 所有 Provider 入口的统一协议闸门：先检查，必要时修复并记录结构摘要。
 * 返回可直接发送的消息；不修改调用方数组。
 */
export function prepareMessagesForProvider(
  messages: ModelMessage[],
  opts: { source: string; logger?: Logger; sessionId?: string } = { source: 'chat' }
): { messages: ModelMessage[]; repaired: boolean; report: ProtocolReport } {
  const before = inspectToolProtocol(messages)
  if (before.ok) return { messages, repaired: false, report: before }
  const warnings: string[] = []
  const repairedMessages = repairModelMessages(messages, warnings)
  const after = inspectToolProtocol(repairedMessages)
  const data = {
    source: opts.source,
    ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
    before: protocolLogData(before),
    after: protocolLogData(after),
    warnings
  }
  if (after.ok) opts.logger?.warn('Provider 请求前修复了工具协议', data)
  else opts.logger?.error('Provider 请求前工具协议仍不完整', data)
  return { messages: repairedMessages, repaired: true, report: after }
}
