import type { ContextRecord, CoreApi, Logger } from '../../core/types'
import { repairToolPairingRecords } from '../../core/session'
import { dateKey, truncate } from '../../core/util'

const NOTE_LIMIT = 1500
/** 交接尾部保留的最近对话单元与最近工具事务数。 */
const KEEP_CONVERSATION_UNITS = 6
const KEEP_TOOL_UNITS = 8

interface HandoffUnit {
  kind: 'conversation' | 'tool'
  records: ContextRecord[]
}

/**
 * 交接时保留的尾部（PLAN.md §3.5）：按完整工具调用事务裁剪。
 *
 * 一组 `assistant.tool_calls` 与它后面的全部 `tool` 回执作为一个不可分割
 * 的单元保留；不再分别抽取「对话条数」和「工具回执条数」，否则工具密集
 * 的一轮会把成功回执留在原地、却让调用被裁掉，最后被配对修复写成“结果
 * 未知”。当前用户目标（最后一条 user）无论多早都至少保留一条。
 */
export function buildHandoffTail(records: ContextRecord[]): ContextRecord[] {
  const units = groupHandoffUnits(records)
  const picked = new Set<number>()
  let conversational = 0
  let tools = 0
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i]
    if (unit === undefined) continue
    if (unit.kind === 'conversation') {
      if (conversational >= KEEP_CONVERSATION_UNITS) continue
      conversational += 1
      picked.add(i)
    } else {
      if (tools >= KEEP_TOOL_UNITS) continue
      tools += 1
      picked.add(i)
    }
  }
  // 当前目标：最后一条用户消息必须进入尾部，即使它已经被更近的对话挤出。
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i]
    if (unit?.kind === 'conversation' && unit.records.some((record) => record.kind === 'user')) {
      picked.add(i)
      break
    }
  }
  const tail = [...picked]
    .sort((a, b) => a - b)
    .flatMap((index) => units[index]?.records ?? [])
  return repairToolPairingRecords(tail, [])
}

/** 把记录切成对话单元与完整工具事务；系统记录不参与交接尾部。 */
function groupHandoffUnits(records: ContextRecord[]): HandoffUnit[] {
  const units: HandoffUnit[] = []
  let index = 0
  while (index < records.length) {
    const record = records[index]
    index += 1
    if (record === undefined || record.kind === 'system') continue
    if (record.kind === 'assistant' && (record.toolCalls?.length ?? 0) > 0) {
      const group: ContextRecord[] = [record]
      // 只吞并紧随其后的回执；中间出现别的记录时，剩余回执交给配对修复。
      while (index < records.length && records[index]?.kind === 'tool') {
        group.push(records[index]!)
        index += 1
      }
      units.push({ kind: 'tool', records: group })
      continue
    }
    if (record.kind === 'tool') {
      // 孤立回执单独成组，配对修复会删除它。
      units.push({ kind: 'tool', records: [record] })
      continue
    }
    units.push({ kind: 'conversation', records: [record] })
  }
  return units
}

/**
 * 用 utility model 生成 ≤1.5KB 的交接笔记；没有模型时退回元信息。
 * 摘录只包含对话文本，不包含工具回执（避免文件内容/URL 进入笔记）。
 * 最早一条用户目标始终进入摘录，避免工具密集轮次把目标挤出最后 16 行。
 */
export async function generateHandoffNote(opts: {
  core: CoreApi
  records: ContextRecord[]
  logger: Logger
  enabled: boolean
  now?: number
  /** 当前有效角色名；只用于给交接笔记标注说话人，不覆盖自定义名字。 */
  name?: string
}): Promise<string> {
  const now = opts.now ?? Date.now()
  const day = dateKey(now)
  const name = opts.name === undefined || opts.name.trim() === '' ? '桌宠' : opts.name.trim()
  const assistantCount = opts.records.filter((record) => record.kind === 'assistant').length
  if (!opts.enabled) return ''

  const excerpt = buildExcerpt(opts.records, name)
  if (excerpt.trim() === '') {
    return `- ${day}：聊过 ${assistantCount} 轮。`
  }

  try {
    const result = await opts.core.spawnFork({
      purpose: 'handoff',
      maxTokens: 700,
      messages: [
        {
          role: 'system',
          content:
            `你是桌面宠物「${name}」的记忆整理器。根据对话摘录写一份给下一次对话使用的交接笔记。` +
            '只写摘录中能确认的事实，不编造；不要包含原始活动事件、进程名、窗口标题、URL、文件内容或密钥。' +
            '用 Markdown 短列表，保留进行中的话题、用户偏好与待办；全文不超过 1500 字符。'
        },
        {
          role: 'user',
          content: `今天日期：${day}\n\n对话摘录：\n${excerpt}`
        }
      ]
    })
    const text = result.text.trim()
    if (text === '') return `- ${day}：聊过 ${assistantCount} 轮。`
    return truncate(text, NOTE_LIMIT)
  } catch (error) {
    opts.logger.warn('交接笔记生成失败，使用本地元信息', { error: String(error) })
    return `- ${day}：聊过 ${assistantCount} 轮。`
  }
}

function buildExcerpt(records: ContextRecord[], name: string): string {
  const lines: string[] = []
  for (const record of records) {
    if (record.kind === 'user') {
      const text = record.text.replace(/^\[(?:chat|system|persona|activity)\]\s*/, '').trim()
      if (text !== '') lines.push(`用户：${truncate(text, 400)}`)
    } else if (record.kind === 'assistant') {
      const text = record.text.trim()
      if (text !== '') lines.push(`${name}：${truncate(text, 400)}`)
      else if ((record.toolCalls?.length ?? 0) > 0) {
        lines.push(`${name}：（调用了 ${record.toolCalls?.map((call) => call.name).join('、')}）`)
      }
    }
  }
  const recent = lines.slice(-16)
  const firstGoal = lines.find((line) => line.startsWith('用户：'))
  return firstGoal !== undefined && !recent.includes(firstGoal)
    ? [firstGoal, ...recent].join('\n')
    : recent.join('\n')
}
