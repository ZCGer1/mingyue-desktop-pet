import { z } from 'zod'
import type { CoreApi, ToolDef, ToolOutcome } from '../../core/types'

const MAX_TIMERS = 20
const MIN_DELAY_MS = 60_000

/**
 * 提醒工具（PLAN.md §3.6）。只应响应用户明确请求；到期由 Core timers
 * 产生 timer.due，再由模型用 pet_say 提醒。
 */
export function createReminderTools(getCore: () => CoreApi | null): ToolDef[] {
  return [
    {
      name: 'remind_set',
      description:
        '设置一个提醒。at 是本地时间（ISO 或 YYYY-MM-DD HH:mm），或改用 after_minutes。note 不超过 200 字。只在用户明确要求时使用。',
      parameters: z.object({
        note: z.string().min(1).max(200),
        at: z.string().max(64).optional(),
        after_minutes: z.number().int().min(1).max(10080).optional()
      }),
      tags: ['presentation'],
      approval: 'auto',
      handler: async (args): Promise<ToolOutcome> => {
        const core = getCore()
        if (core === null) return { text: '[REMIND_FAILED] Core 尚未就绪', failed: true }
        const { note, at, after_minutes } = args as {
          note: string
          at?: string
          after_minutes?: number
        }
        if ((at === undefined) === (after_minutes === undefined)) {
          return { text: '[REMIND_BAD_ARGS] 需要且只能提供 at 或 after_minutes 之一', failed: true }
        }
        const active = core.timers.list().filter((item) => item.kind === 'reminder')
        if (active.length >= MAX_TIMERS) {
          return { text: `[REMIND_LIMIT] 最多同时保留 ${MAX_TIMERS} 条提醒`, failed: true }
        }
        const now = Date.now()
        let target: number
        if (after_minutes !== undefined) {
          target = now + after_minutes * 60_000
        } else {
          target = new Date(at ?? '').getTime()
          if (!Number.isFinite(target)) return { text: '[REMIND_BAD_ARGS] 无法解析 at 时间', failed: true }
        }
        if (target - now < MIN_DELAY_MS) {
          return { text: '[REMIND_BAD_ARGS] 提醒时间至少要比现在晚 1 分钟', failed: true }
        }
        const id = core.timers.set(new Date(target).toISOString(), { note, kind: 'reminder' })
        return { text: `已设置提醒 ${id}：${new Date(target).toLocaleString('zh-CN', { hour12: false })} — ${note}` }
      }
    },
    {
      name: 'remind_list',
      description: '列出尚未到期的提醒。',
      parameters: z.object({}),
      tags: ['presentation', 'read'],
      approval: 'auto',
      handler: async (): Promise<ToolOutcome> => {
        const core = getCore()
        if (core === null) return { text: '[REMIND_FAILED] Core 尚未就绪', failed: true }
        const list = core.timers.list().filter((item) => item.kind === 'reminder')
        if (list.length === 0) return { text: '当前没有提醒。' }
        return {
          text: list
            .map(
              (item) =>
                `${item.id} · ${new Date(item.at).toLocaleString('zh-CN', { hour12: false })} · ${item.note}`
            )
            .join('\n')
        }
      }
    },
    {
      name: 'remind_cancel',
      description: '按 id 取消一条提醒。',
      parameters: z.object({ id: z.string().min(1).max(64) }),
      tags: ['presentation'],
      approval: 'auto',
      handler: async (args): Promise<ToolOutcome> => {
        const core = getCore()
        if (core === null) return { text: '[REMIND_FAILED] Core 尚未就绪', failed: true }
        const { id } = args as { id: string }
        const record = core.timers.list().find((item) => item.id === id)
        if (record === undefined || record.kind !== 'reminder') {
          return { text: `[REMIND_NOT_FOUND] 没有提醒 ${id}`, failed: true }
        }
        core.timers.cancel(id)
        return { text: `已取消提醒 ${id}` }
      }
    }
  ]
}
