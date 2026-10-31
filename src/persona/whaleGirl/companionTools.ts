import { z } from 'zod'
import type { ToolDef, ToolOutcome } from '../../core/types'
import type { InterestMutationResult, InterestStore } from '../companion/interestStore'

export type CompanionFeedbackKind = 'more' | 'less' | 'stop_topic' | 'resume'

export interface CompanionFeedback {
  kind: CompanionFeedbackKind
  interestId: string | null
  note: string | null
  at: number
}

export interface CompanionToolDeps {
  interests: InterestStore
  now?: () => number
  /** P3 的聊天节奏/Episode 接线；这里只上报脱敏后的反馈。 */
  onFeedback?: (feedback: CompanionFeedback) => void
}

/** 兴趣与反馈工具（Persona 所有；只写她自己的受限状态）。 */
export function createCompanionTools(deps: CompanionToolDeps): ToolDef[] {
  const now = deps.now ?? (() => Date.now())
  const store = deps.interests

  return [
    {
      name: 'interest_create',
      description:
        '创建一个有明确结束条件的长期兴趣。只写你自己的脱敏总结；不要写原文、绝对路径、窗口标题或密钥。' +
        '如果这一轮刚读过网页/屏幕内容，先把发现写进 notes/，下一轮再创建兴趣。',
      parameters: z.object({
        title: z.string().min(1).max(80).describe('兴趣标题，不超过 60 字'),
        reason: z.string().max(240).optional().describe('为什么开始关注，脱敏总结'),
        endCondition: z.string().min(1).max(240).describe('什么情况下算完成，必须明确'),
        nextStep: z.string().max(240).optional().describe('下一步想做什么'),
        nextTool: z
          .string()
          .max(64)
          .optional()
          .describe('下一步预计使用的工具名，例如 files_read/web_fetch；只用于候选筛选'),
        requiredCapability: z
          .string()
          .max(64)
          .optional()
          .describe('继续所需能力标签，例如 file.read/web/desktop.observe'),
        backgroundSafe: z
          .boolean()
          .optional()
          .describe('用户忙时是否适合后台推进；会抢焦点的操作应设为 false'),
        recheckCondition: z
          .string()
          .max(240)
          .optional()
          .describe('什么条件或多久后值得重新检查这个候选'),
        questions: z
          .array(z.string().max(240))
          .max(3)
          .optional()
          .describe('还想弄清的问题，最多 3 个')
      }),
      tags: ['memory', 'write'],
      approval: 'auto',
      enabled: () => store.isEnabled(),
      handler: async (args, ctx): Promise<ToolOutcome> => {
        const input = args as {
          title: string
          reason?: string
          endCondition: string
          nextStep?: string
          nextTool?: string
          requiredCapability?: string
          backgroundSafe?: boolean
          recheckCondition?: string
          questions?: string[]
        }
        if (ctx.tainted === true) {
          return {
            text:
              '[PAGE_UNTRUSTED_INTEREST] 本轮包含网页/屏幕内容，不能直接固化成兴趣。' +
              '先把发现写进 notes/；等下一轮不再包含新的不可信结果时，再由你自己总结创建兴趣。',
            failed: true
          }
        }
        const fromChat = ctx.source === 'user-chat' || ctx.source === 'quick-chat'
        const result = store.create({
          title: input.title,
          endCondition: input.endCondition,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.nextStep === undefined ? {} : { nextStep: input.nextStep }),
          ...(input.nextTool === undefined ? {} : { nextTool: input.nextTool }),
          ...(input.requiredCapability === undefined
            ? {}
            : { requiredCapability: input.requiredCapability }),
          ...(input.backgroundSafe === undefined
            ? {}
            : { backgroundSafe: input.backgroundSafe }),
          ...(input.recheckCondition === undefined
            ? {}
            : { recheckCondition: input.recheckCondition }),
          ...(input.questions === undefined ? {} : { questions: input.questions }),
          source: fromChat ? 'user' : 'autonomy',
          ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
          now: now()
        })
        return mutationOutcome(result)
      }
    },
    {
      name: 'interest_update',
      description:
        '更新一个已有兴趣：补充脱敏事实/问题/下一步，或改状态与回访时间。' +
        '本轮读过网页/屏幕内容时只能改 status 和 nextRevisitMinutes；正文要等下一轮自己总结。',
      parameters: z.object({
        id: z.string().min(8).max(80).describe('interest_list 返回的兴趣 id'),
        facts: z.array(z.string().max(240)).max(5).optional().describe('替换已有事实列表'),
        questions: z.array(z.string().max(240)).max(3).optional().describe('替换已有问题列表'),
        nextStep: z.string().max(240).nullable().optional(),
        nextTool: z.string().max(64).nullable().optional(),
        requiredCapability: z.string().max(64).nullable().optional(),
        backgroundSafe: z.boolean().nullable().optional(),
        recheckCondition: z.string().max(240).nullable().optional(),
        status: z.enum(['active', 'paused', 'done', 'abandoned']).optional(),
        abandonedReason: z.string().max(240).optional().describe('放弃时的脱敏原因'),
        nextRevisitMinutes: z
          .number()
          .int()
          .min(0)
          .max(60 * 24 * 30)
          .nullable()
          .optional()
          .describe('多少分钟后再回访；0/null 表示不安排')
      }),
      tags: ['memory', 'write'],
      approval: 'auto',
      enabled: () => store.isEnabled(),
      handler: async (args, ctx): Promise<ToolOutcome> => {
        const input = args as {
          id: string
          facts?: string[]
          questions?: string[]
          nextStep?: string | null
          nextTool?: string | null
          requiredCapability?: string | null
          backgroundSafe?: boolean | null
          recheckCondition?: string | null
          status?: 'active' | 'paused' | 'done' | 'abandoned'
          abandonedReason?: string
          nextRevisitMinutes?: number | null
        }
        if (
          ctx.tainted === true &&
          (input.facts !== undefined ||
            input.questions !== undefined ||
            input.nextStep !== undefined ||
            input.nextTool !== undefined ||
            input.requiredCapability !== undefined ||
            input.recheckCondition !== undefined ||
            input.backgroundSafe !== undefined ||
            input.abandonedReason !== undefined)
        ) {
          return {
            text:
              '[PAGE_UNTRUSTED_INTEREST] 本轮包含网页/屏幕内容，不能把当轮正文写进兴趣。' +
              '只能更新 status 或 nextRevisitMinutes；正文先落到 notes/，下一轮再总结。',
            failed: true
          }
        }
        if (input.status === 'abandoned' && input.abandonedReason === undefined) {
          input.abandonedReason = '她决定先放下'
        }
        const patch = {
          ...(input.facts === undefined ? {} : { facts: input.facts }),
          ...(input.questions === undefined ? {} : { questions: input.questions }),
          ...(input.nextStep === undefined ? {} : { nextStep: input.nextStep }),
          ...(input.nextTool === undefined ? {} : { nextTool: input.nextTool }),
          ...(input.requiredCapability === undefined
            ? {}
            : { requiredCapability: input.requiredCapability }),
          ...(input.backgroundSafe === undefined
            ? {}
            : { backgroundSafe: input.backgroundSafe }),
          ...(input.recheckCondition === undefined
            ? {}
            : { recheckCondition: input.recheckCondition }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.abandonedReason === undefined
            ? {}
            : { abandonedReason: input.abandonedReason }),
          ...(input.nextRevisitMinutes === undefined
            ? {}
            : { nextRevisitMinutes: input.nextRevisitMinutes }),
          now: now()
        }
        const result = store.update(input.id, patch)
        if (result.ok && ctx.taskId !== undefined) store.addTask(input.id, ctx.taskId)
        return mutationOutcome(result)
      }
    },
    {
      name: 'interest_list',
      description:
        '列出你当前活跃的兴趣与到期该回访的兴趣（含 id、下一步、结束条件、最近成果）。' +
        '探索前先看一眼，避免重复；没有兴趣时可以先创建一个小目标。',
      parameters: z.object({}),
      tags: ['memory', 'read'],
      approval: 'auto',
      enabled: () => store.isEnabled(),
      handler: async (): Promise<ToolOutcome> => {
        const active = store.activeForPrompt(4)
        const due = store.dueRevisits(now())
        if (active.length === 0 && due.length === 0) {
          return { text: '当前没有活跃兴趣。可以先创建一个有明确结束条件的小兴趣。' }
        }
        const dueIds = new Set(due.map((record) => record.id))
        const lines: string[] = []
        for (const record of active) {
          const parts = [`- ${record.id}「${record.title}」`]
          if (dueIds.has(record.id)) parts.push('[到期回访]')
          if (record.focusCount > 0) parts.push(`关注 ${record.focusCount} 次`)
          lines.push(parts.join(' '))
          if (record.nextStep !== null) lines.push(`  下一步：${record.nextStep}`)
          if (record.nextTool !== null) lines.push(`  下一步工具：${record.nextTool}`)
          if (record.requiredCapability !== null) {
            lines.push(`  需要能力：${record.requiredCapability}`)
          }
          if (record.backgroundSafe !== null) {
            lines.push(`  可后台推进：${record.backgroundSafe ? '是' : '否（需找合适时机）'}`)
          }
          if (record.recheckCondition !== null) {
            lines.push(`  复查条件：${record.recheckCondition}`)
          }
          lines.push(`  结束条件：${record.endCondition}`)
          if (record.artifacts.length > 0) lines.push(`  最近成果：${record.artifacts.join('、')}`)
          if (record.nextRevisitAt !== null && !dueIds.has(record.id)) {
            const minutes = Math.max(1, Math.round((record.nextRevisitAt - now()) / 60_000))
            lines.push(`  约 ${minutes} 分钟后回访`)
          }
        }
        return { text: lines.join('\n') }
      }
    },
    {
      name: 'companion_feedback',
      description:
        '记录用户对某个话题的反馈并调整你自己的节奏：more 多聊一点、less 少聊一点、' +
        'stop_topic 暂停这个话题、resume 恢复。不改任何权限；本轮含网页/屏幕内容时 note 会被忽略。',
      parameters: z.object({
        kind: z.enum(['more', 'less', 'stop_topic', 'resume']),
        interestId: z.string().min(8).max(80).optional(),
        note: z.string().max(240).optional().describe('脱敏后的简短说明')
      }),
      tags: ['memory'],
      approval: 'auto',
      handler: async (args, ctx): Promise<ToolOutcome> => {
        const input = args as {
          kind: CompanionFeedbackKind
          interestId?: string
          note?: string
        }
        const note = ctx.tainted === true ? null : (input.note ?? null)
        const interestId = input.interestId ?? null
        if (interestId !== null) {
          const record = store.get(interestId)
          if (record === undefined) {
            return { text: '[INTEREST_NOT_FOUND] 没有找到这个兴趣', failed: true }
          }
          if (input.kind === 'more') {
            store.update(interestId, { nextRevisitMinutes: 30, now: now() })
          } else if (input.kind === 'less') {
            store.update(interestId, { nextRevisitMinutes: 180, now: now() })
          } else if (input.kind === 'stop_topic') {
            store.update(interestId, { status: 'paused', now: now() })
          } else {
            const result = store.update(interestId, { status: 'active', now: now() })
            if (!result.ok) return mutationOutcome(result)
          }
        }
        deps.onFeedback?.({ kind: input.kind, interestId, note, at: now() })
        const labels: Record<CompanionFeedbackKind, string> = {
          more: '会多留意这个话题',
          less: '会少提这个话题',
          stop_topic: '先放下这个话题',
          resume: '可以重新聊这个话题了'
        }
        return { text: `记下了：${labels[input.kind]}。` }
      }
    }
  ]
}

function mutationOutcome(result: InterestMutationResult): ToolOutcome {
  if (result.ok) {
    const lines = [result.message]
    if (result.interest !== undefined) {
      lines.push(`id：${result.interest.id}`)
      lines.push(`结束条件：${result.interest.endCondition}`)
      if (result.interest.nextStep !== null) lines.push(`下一步：${result.interest.nextStep}`)
      if (result.interest.nextTool !== null) {
        lines.push(`下一步工具：${result.interest.nextTool}`)
      }
      if (result.interest.requiredCapability !== null) {
        lines.push(`需要能力：${result.interest.requiredCapability}`)
      }
      if (result.interest.backgroundSafe !== null) {
        lines.push(
          `可后台推进：${result.interest.backgroundSafe ? '是' : '否（需找合适时机）'}`
        )
      }
      if (result.interest.status !== 'active') lines.push(`状态：${result.interest.status}`)
    }
    return { text: lines.join('\n') }
  }
  const lines = [`[${result.code ?? 'INTEREST_FAILED'}] ${result.message}`]
  if (result.closable !== undefined && result.closable.length > 0) {
    lines.push('可以先结束或放弃其中一个：')
    for (const record of result.closable) {
      lines.push(`- ${record.id}「${record.title}」结束条件：${record.endCondition}`)
    }
  }
  return { text: lines.join('\n'), failed: true }
}
