import { z } from 'zod'
import type { AppConfig } from '../../shared/config'
import type { CoreApi, ToolDef, ToolOutcome } from '../../core/types'

const HOUR_MINUTE = /^([01]?\d|2[0-3]):([0-5]\d)$/

/**
 * 模型自设闹钟（`kind: 'alarm'`）。与用户提醒分开列出/取消，
 * 支持一次性 `after_minutes`、绝对时间以及每日重复。
 */
export function createAlarmTools(
  getCore: () => CoreApi | null,
  getConfig: () => AppConfig
): ToolDef[] {
  return [
    {
      name: 'alarm_set',
      description:
        '给自己设一个闹钟：到点后你会收到 timer.due，可以决定说话或做事。' +
        '用 at（ISO / YYYY-MM-DD HH:mm / HH:mm）或 after_minutes；daily=true 表示每天同一时刻。' +
        'note 不超过 200 字。闹钟不替代用户提醒。',
      parameters: z.object({
        note: z.string().min(1).max(200),
        at: z.string().max(64).optional(),
        after_minutes: z.number().int().min(1).max(10080).optional(),
        daily: z.boolean().optional()
      }),
      tags: ['presentation'],
      approval: 'auto',
      handler: async (args): Promise<ToolOutcome> => {
        const core = getCore()
        if (core === null) return { text: '[ALARM_FAILED] Core 尚未就绪', failed: true }
        const { note, at, after_minutes, daily } = args as {
          note: string
          at?: string
          after_minutes?: number
          daily?: boolean
        }
        if ((at === undefined) === (after_minutes === undefined)) {
          return { text: '[ALARM_BAD_ARGS] 需要且只能提供 at 或 after_minutes 之一', failed: true }
        }
        if (daily === true && after_minutes !== undefined) {
          return { text: '[ALARM_BAD_ARGS] daily 需要提供 at 时刻，不能与 after_minutes 同用', failed: true }
        }
        const config = getConfig()
        const active = core.timers.list().filter((item) => item.kind === 'alarm')
        if (active.length >= config.autonomy.maxActiveAlarms) {
          return {
            text: `[ALARM_LIMIT] 最多同时保留 ${config.autonomy.maxActiveAlarms} 个闹钟`,
            failed: true
          }
        }
        const now = Date.now()
        let target: number
        if (after_minutes !== undefined) {
          target = now + after_minutes * 60_000
        } else {
          const parsed = parseAlarmTime(at ?? '', now, daily === true)
          if (parsed === null) return { text: '[ALARM_BAD_ARGS] 无法解析 at 时间', failed: true }
          target = parsed
        }
        if (target - now < config.autonomy.alarmMinDelayMs) {
          return {
            text: `[ALARM_BAD_ARGS] 闹钟时间至少要比现在晚 ${Math.round(
              config.autonomy.alarmMinDelayMs / 1000
            )} 秒`,
            failed: true
          }
        }
        const id = core.timers.set(new Date(target).toISOString(), {
          note,
          kind: 'alarm',
          ...(daily === true ? { repeat: 'daily' as const } : {})
        })
        return {
          text: `已设置闹钟 ${id}：${new Date(target).toLocaleString('zh-CN', {
            hour12: false
          })}${daily === true ? '（每天）' : ''} — ${note}`
        }
      }
    },
    {
      name: 'alarm_list',
      description: '列出你给自己设置的闹钟（不含用户提醒）。',
      parameters: z.object({}),
      tags: ['presentation', 'read'],
      approval: 'auto',
      handler: async (): Promise<ToolOutcome> => {
        const core = getCore()
        if (core === null) return { text: '[ALARM_FAILED] Core 尚未就绪', failed: true }
        const list = core.timers.list().filter((item) => item.kind === 'alarm')
        if (list.length === 0) return { text: '当前没有闹钟。' }
        return {
          text: list
            .map(
              (item) =>
                `${item.id} · ${new Date(item.at).toLocaleString('zh-CN', {
                  hour12: false
                })}${item.repeat === 'daily' ? ' · 每天' : ''} · ${item.note}`
            )
            .join('\n')
        }
      }
    },
    {
      name: 'alarm_cancel',
      description: '按 id 取消一个你自己设置的闹钟。',
      parameters: z.object({ id: z.string().min(1).max(64) }),
      tags: ['presentation'],
      approval: 'auto',
      handler: async (args): Promise<ToolOutcome> => {
        const core = getCore()
        if (core === null) return { text: '[ALARM_FAILED] Core 尚未就绪', failed: true }
        const { id } = args as { id: string }
        const record = core.timers.list().find((item) => item.id === id)
        if (record === undefined || record.kind !== 'alarm') {
          return { text: `[ALARM_NOT_FOUND] 没有闹钟 ${id}`, failed: true }
        }
        core.timers.cancel(id)
        return { text: `已取消闹钟 ${id}` }
      }
    }
  ]
}

/** 支持 ISO、`YYYY-MM-DD HH:mm` 与 `HH:mm`；每日闹钟在过去时刻顺延到明天。 */
export function parseAlarmTime(raw: string, now: number, daily: boolean): number | null {
  const text = raw.trim()
  if (text === '') return null
  const clock = HOUR_MINUTE.exec(text)
  if (clock !== null) {
    const date = new Date(now)
    date.setHours(Number(clock[1]), Number(clock[2]), 0, 0)
    let at = date.getTime()
    while (at <= now) at += 24 * 60 * 60_000
    return at
  }
  let at = new Date(text).getTime()
  if (!Number.isFinite(at)) return null
  if (daily) {
    while (at <= now) at += 24 * 60 * 60_000
  }
  return at
}
