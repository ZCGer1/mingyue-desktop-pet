import type { ContextRecord } from '../../core/types'
import type { ChatHistoryItem } from '../../shared/ipc'

const CHAT_PREFIX = '[chat] '

/**
 * 从会话记录重建聊天窗历史（窗口重载/应用重启后使用）。
 *
 * 只返回聊天来源的用户消息与有正文的助手消息；活动、提醒、系统提示、
 * ephemeral 说明和工具回执都不进入聊天历史。会话被交接裁剪后，这里
 * 也只能看到保留的尾部——这与模型当前上下文一致。
 */
export function buildChatHistory(records: ContextRecord[], limit = 120): ChatHistoryItem[] {
  const out: ChatHistoryItem[] = []
  for (const record of records) {
    if (record.kind === 'user') {
      if (record.ephemeral === true) continue
      if (record.source !== 'quick' && !record.text.startsWith(CHAT_PREFIX)) continue
      const text = (record.source === 'quick' ? record.text : record.text.slice(CHAT_PREFIX.length)).trim()
      if (text === '') continue
      out.push({ kind: 'user', text, at: parseTs(record.ts) })
      continue
    }
    if (record.kind === 'assistant') {
      const text = record.text.trim()
      if (text === '') continue
      out.push({
        kind: 'assistant',
        text: record.text,
        at: parseTs(record.ts),
        aborted: record.aborted === true
      })
    }
  }
  return out.slice(Math.max(0, out.length - Math.max(1, limit)))
}

function parseTs(ts: string): number {
  const value = Date.parse(ts)
  return Number.isFinite(value) ? value : 0
}
