import type { EventEnvelope, Logger, Persona } from './types'
import type { Session } from './session'

export interface DeliveryResult {
  delivered: EventEnvelope[]
  skipped: EventEnvelope[]
}

/**
 * 把一批事件写入主会话上下文（PLAN.md §2.3）。
 * 外部事件以带来源前缀的 user 消息进入；内部事件以 [system] 进入；
 * Persona.onDelivery 的说明作为一条 ephemeral 的批首说明。
 */
export async function deliverBatch(
  events: EventEnvelope[],
  session: Session,
  persona: Persona,
  logger: Logger
): Promise<DeliveryResult> {
  const delivered = events.filter((event) => event.deliver !== false)
  const skipped = events.filter((event) => event.deliver === false)
  if (delivered.length === 0) return { delivered, skipped }

  // 只让临时正文到期，保留工具调用/回执结构；随后再兜底修复一次配对，
  // 防止旧版本遗留的坏结构继续发给 Provider。
  session.expireEphemeral()
  session.repairPairing()

  let note: string | undefined
  try {
    const value = await persona.onDelivery?.({ events: delivered })
    if (typeof value === 'string' && value.trim() !== '') note = value.trim()
  } catch (error) {
    logger.warn('Persona.onDelivery 失败', { error: String(error) })
  }
  if (note !== undefined) session.appendUser(`[system] ${note}`, undefined, true)

  for (const event of delivered) {
    const isSystem = event.origin === 'internal' || event.source === 'core' || event.source === 'persona'
    const text = isSystem
      ? event.text.startsWith('[')
        ? event.text
        : `[system] ${event.text}`
      : `[${event.source}] ${event.text}`
    session.appendUser(text, [event.cursor], event.ephemeral === true)
  }
  return { delivered, skipped }
}

/** 判断一批的来源构成，供测试与诊断使用。 */
export function batchKinds(events: EventEnvelope[]): {
  allActivity: boolean
  hasUserMessage: boolean
  hasTimer: boolean
  hasAutonomy: boolean
  /** 兼容旧调用：用户消息或定时器都算“非纯自主批次”。 */
  hasUser: boolean
} {
  const meaningful = events.filter((event) => event.deliver !== false)
  const hasUserMessage = meaningful.some((event) => event.type === 'chat.user_message')
  const hasTimer = meaningful.some((event) => event.type === 'timer.due')
  const hasAutonomy = meaningful.some(
    (event) => event.type === 'system.autonomy' || event.type === 'system.quiet_end'
  )
  return {
    allActivity: meaningful.length > 0 && meaningful.every((event) => event.type.startsWith('activity.')),
    hasUserMessage,
    hasTimer,
    hasAutonomy,
    hasUser: hasUserMessage || hasTimer
  }
}
