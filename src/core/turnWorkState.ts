import { truncate } from './util'

/** 一条已成功执行的动作；只保留工具名与脱敏目标引用。 */
export interface TurnWorkAction {
  tool: string
  targetRef: string | null
  at: number
}

/** 一次失败或结果未知的动作；不会因为压缩被误写成成功。 */
export interface TurnWorkIssue {
  tool: string
  code: string | null
  targetRef: string | null
  at: number
}

export const WORK_STATE_MARKER = '[工作状态]'
const MAX_ACTIONS = 12
const MAX_ISSUES = 6
const MAX_CORRECTIONS = 3

/**
 * 当前任务的短期工作状态。它只驻内存，跨上下文压缩保留，不写会话文件，
 * 也不绕过 `memory.enabled`：长期记忆仍由 MemoryStore 决定是否落盘。
 *
 * 交接裁剪只能保住“最近说了什么”；工具密集的一轮仍可能丢掉更早的目标。
 * 这里固定保存目标、用户修正、已成功动作、未解决问题和最近回复，交接后
 * 作为一条 ephemeral system 记录重新注入。
 */
export class TurnWorkState {
  private goal: string | null = null
  private corrections: string[] = []
  private actions: TurnWorkAction[] = []
  private issues: TurnWorkIssue[] = []
  private lastAssistant: string | null = null
  private updatedAt = 0

  noteUser(text: string, now: number): void {
    const clean = cleanLine(text, 400)
    if (clean === '') return
    const continuation = /^(不[，,、是]|改为|改成|更正|纠正|补充|另外要求|继续|接着|还是|刚才|上面|上述)/.test(clean)
    if (this.goal !== null && continuation) {
      this.corrections = [clean, ...this.corrections.filter((item) => item !== clean)].slice(0, MAX_CORRECTIONS)
    } else {
      this.reset()
      this.goal = clean
    }
    this.updatedAt = now
  }

  noteAssistant(text: string, now: number): void {
    const clean = cleanLine(text, 300)
    if (clean === '') return
    this.lastAssistant = clean
    this.updatedAt = now
  }

  noteTool(
    input: {
      tool: string
      targetRef?: string | null
      failed?: boolean
      unknown?: boolean
      text?: string
    },
    now: number
  ): void {
    const tool = input.tool.trim().slice(0, 80)
    if (tool === '') return
    const targetRef = normalizeRef(input.targetRef)
    if (input.failed === true || input.unknown === true) {
      const issue: TurnWorkIssue = {
        tool,
        code: input.unknown === true ? 'UNKNOWN' : resultCode(input.text ?? ''),
        targetRef,
        at: now
      }
      this.issues = [
        issue,
        ...this.issues.filter(
          (item) => !(item.tool === issue.tool && item.targetRef === issue.targetRef)
        )
      ].slice(0, MAX_ISSUES)
      return
    }
    this.actions = [
      { tool, targetRef, at: now },
      ...this.actions.filter(
        (item) => !(item.tool === tool && item.targetRef === targetRef)
      )
    ].slice(0, MAX_ACTIONS)
    // 同一目标后来操作成功，之前的失败不再作为未解决问题继续提示。
    this.issues = this.issues.filter(
      (item) => !(item.tool === tool && item.targetRef === targetRef)
    )
    this.updatedAt = now
  }

  hasContent(): boolean {
    return (
      this.goal !== null ||
      this.actions.length > 0 ||
      this.issues.length > 0 ||
      this.lastAssistant !== null
    )
  }

  /**
   * 供模型阅读的短状态；只包含本地可确认的事实。没有内容时返回 null，
   * 不向上下文塞空段落。
   */
  toPrompt(maxChars = 1600): string | null {
    if (!this.hasContent()) return null
    const lines: string[] = [
      `${WORK_STATE_MARKER} 以下内容是本次任务的临时工作状态（不是长期记忆，也不要向用户复述本段）。`
    ]
    if (this.goal !== null) lines.push(`当前目标：${this.goal}`)
    if (this.corrections.length > 0) {
      lines.push(`用户最新修正：${this.corrections.map((item) => truncate(item, 120)).join(' / ')}`)
    }
    if (this.actions.length > 0) {
      const shown = this.actions.slice(0, 8).map(formatAction).join('、')
      lines.push(`已成功执行：${shown}。这些动作已完成，不要重放。`)
    }
    if (this.issues.length > 0) {
      const shown = this.issues.slice(0, 4).map(formatIssue).join('、')
      lines.push(`未解决/结果未知：${shown}。需要时重新观察或改用其他方式，不要假设成功。`)
    }
    if (this.lastAssistant !== null) lines.push(`最近一次回复：${this.lastAssistant}`)
    const text = lines.join('\n')
    return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 12))}\n…（已截断）`
  }

  /**
   * 诊断只暴露规模、工具名和布尔状态，不复制目标/回复正文；诊断包会被
   * 设置页读取，也可能被用户导出，不能成为第二条保存用户内容的路径。
   */
  summary(): {
    hasGoal: boolean
    goalChars: number
    corrections: number
    actions: Array<{ tool: string; hasTarget: boolean; at: number }>
    issues: Array<{ tool: string; code: string | null; hasTarget: boolean; at: number }>
    hasLastAssistant: boolean
    lastAssistantChars: number
    updatedAt: number
  } {
    return {
      hasGoal: this.goal !== null,
      goalChars: this.goal?.length ?? 0,
      corrections: this.corrections.length,
      actions: this.actions.map((action) => ({
        tool: action.tool,
        hasTarget: action.targetRef !== null,
        at: action.at
      })),
      issues: this.issues.map((issue) => ({
        tool: issue.tool,
        code: issue.code,
        hasTarget: issue.targetRef !== null,
        at: issue.at
      })),
      hasLastAssistant: this.lastAssistant !== null,
      lastAssistantChars: this.lastAssistant?.length ?? 0,
      updatedAt: this.updatedAt
    }
  }

  reset(): void {
    this.goal = null
    this.corrections = []
    this.actions = []
    this.issues = []
    this.lastAssistant = null
    this.updatedAt = 0
  }
}

function cleanLine(raw: string, maxChars: number): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

function normalizeRef(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || text.length > 120) return null
  return text
}

function resultCode(text: string): string | null {
  const match = /^\[([A-Z0-9_]+)\]/.exec(text.trim())
  return match?.[1] ?? null
}

function formatAction(action: TurnWorkAction): string {
  return action.targetRef === null ? action.tool : `${action.tool}(${action.targetRef})`
}

function formatIssue(issue: TurnWorkIssue): string {
  const base = issue.targetRef === null ? issue.tool : `${issue.tool}(${issue.targetRef})`
  return issue.code === null ? base : `${base}[${issue.code}]`
}
