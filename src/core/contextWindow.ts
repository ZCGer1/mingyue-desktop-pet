import { EXPIRED_TOOL_TEXT } from './protocol'
import type { ContextRecord } from './types'
import { estimateTokens } from './util'

/** 交接时超过这个长度的成功回执正文先收缩成“成功已过期”壳。 */
const HANDOFF_TOOL_BODY_LIMIT = 400

/**
 * 按 token 预算从旧到新裁剪 tail，保持工具调用配对。
 *
 * 顺序：先把过长的成功工具正文收缩成明确的「已成功、内容已过期」壳（保留
 * 动作事实，只丢正文），仍然超预算才删除最早的完整单元。最后一条用户目标
 * 受到保护，不会因为工具回执太多而被裁掉。
 *
 * 这是纯函数：不读写会话、不改写原始记录，也不决定何时交接。
 */
export function trimTail(records: ContextRecord[], budget: number): ContextRecord[] {
  let out = [...records]
  const cost = (list: ContextRecord[]): number =>
    list.reduce((sum, record) => {
      if (record.kind === 'tool') return sum + estimateTokens(record.text)
      if (record.kind === 'assistant') {
        return (
          sum +
          estimateTokens(record.text) +
          (record.toolCalls ?? []).reduce(
            (inner, call) => inner + estimateTokens(call.name + call.arguments),
            0
          )
        )
      }
      if (record.kind === 'system' || record.kind === 'user') {
        return sum + estimateTokens(record.text)
      }
      return sum
    }, 0)

  if (cost(out) > budget) {
    out = out.map((record) => {
      if (record.kind !== 'tool') return record
      if (record.failed === true || record.unknown === true) return record
      if (record.text === EXPIRED_TOOL_TEXT || record.text.length <= HANDOFF_TOOL_BODY_LIMIT) {
        return record
      }
      return { ...record, text: EXPIRED_TOOL_TEXT, expired: true }
    })
  }

  while (out.length > 1 && cost(out) > budget) {
    // 保护最后一条用户消息（当前目标）；其余从最早处删除。
    const goalIndex = findLastUserIndex(out)
    const dropIndex = out.findIndex((_, index) => index !== goalIndex)
    if (dropIndex < 0) break
    const dropped = out[dropIndex]
    out.splice(dropIndex, 1)
    // 如果删掉的是带 toolCalls 的 assistant，后面的回执也要删
    if (dropped?.kind === 'assistant' && (dropped.toolCalls?.length ?? 0) > 0) {
      const ids = new Set(dropped.toolCalls?.map((call) => call.id) ?? [])
      out = out.filter(
        (record) => record.kind !== 'tool' || !ids.has(record.toolCallId)
      )
    }
  }
  // 开头的 tool 回执没有前置调用：删除
  while (out.length > 0 && out[0]?.kind === 'tool') out = out.slice(1)
  return out
}

function findLastUserIndex(records: ContextRecord[]): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.kind === 'user') return index
  }
  return -1
}
