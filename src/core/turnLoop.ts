import type { ToolCallRequest } from './toolExecutor'

/**
 * 单个用户 turn / 快捷 turn 的唯一轮次循环。
 *
 * Core 与 QuickChat 的 Provider 调用、会话写入、工具执行仍然由各自适配器负责，
 * 但“什么时候再请求模型、什么时候交接、什么时候结束”只能在这里决定。这样
 * 两个入口不会各自维护一套轮数/停止/预算顺序，也不会出现一个入口能在交接后
 * 重置硬上限、另一个入口不能的差异。
 *
 * 适配器必须保持同步调用：本函数不捕获模型或工具异常，异常语义仍由调用方
 * 决定（Core 记失败报告，QuickChat 走配对修复或通用错误）。
 */

export type TurnLoopOutcome = 'done' | 'failed' | 'capped' | 'stopped' | 'budget-exceeded'

export type TurnLoopPrepare =
  | 'continue'
  | 'stop'
  | 'budget-exceeded'
  /** 调用方已在 prepare 内完成交接，仍在本轮继续请求模型。 */
  | 'handoff'

export interface TurnLoopModelResult {
  toolCalls: readonly ToolCallRequest[]
  failed: boolean
  needsHandoff: boolean
  /** 发送前整包预算已经超限；调用方不应再重试同一个请求。 */
  budgetExceeded?: boolean
}

export interface TurnLoopToolResult {
  /** 工具侧主动结束本轮（例如 task_halt 或 end_turn）。 */
  endsTurn: boolean
  /** 工具侧消耗完自己的轮次/动作预算；不结束整个 turn，但不再请求模型。 */
  capped?: boolean
  /** 执行期间用户停止。 */
  stopped?: boolean
}

export interface TurnLoopHooks {
  /** 整个 turn 的模型轮硬上限；交接不能重置它。 */
  hardRounds: number
  /** 达到后调用一次 onSoftRound；通常用于提示模型收尾。 */
  softRounds?: number
  isStopped: () => boolean
  /**
   * 每轮请求前的准备（上下文软上限、交接、提示词刷新、请求预算）。
   * 返回 stop/budget-exceeded 时不会调用 modelRound。
   */
  prepareRound?: (round: number) => Promise<TurnLoopPrepare> | TurnLoopPrepare
  modelRound: () => Promise<TurnLoopModelResult>
  /** 模型报告上下文超限时调用；同一个 turn 只尝试一次。 */
  onNeedsHandoff?: () => Promise<void> | void
  /** 已经交接/超预算仍放不下时调用，供入口写入用户提示。 */
  onBudgetExceeded?: () => void
  onSoftRound?: () => void
  onCapped?: () => void
  toolRound: (calls: readonly ToolCallRequest[]) => Promise<TurnLoopToolResult>
}

export async function runTurnLoop(hooks: TurnLoopHooks): Promise<TurnLoopOutcome> {
  const hardRounds = Math.max(1, Math.floor(hooks.hardRounds))
  let handoffTried = false

  for (let round = 1; round <= hardRounds; round += 1) {
    if (hooks.isStopped()) return 'stopped'

    const prepared =
      hooks.prepareRound === undefined ? 'continue' : await hooks.prepareRound(round)
    if (prepared === 'stop') return 'stopped'
    if (prepared === 'budget-exceeded') {
      hooks.onBudgetExceeded?.()
      return 'budget-exceeded'
    }
    if (hooks.isStopped()) return 'stopped'

    const model = await hooks.modelRound()
    if (model.needsHandoff && !handoffTried) {
      handoffTried = true
      await hooks.onNeedsHandoff?.()
      // 与旧 Core 一致：交接消耗这一轮，下一轮重新装配请求；不重置轮数。
      if (hooks.isStopped()) return 'stopped'
      continue
    }
    if (model.budgetExceeded === true) {
      hooks.onBudgetExceeded?.()
      return 'budget-exceeded'
    }
    if (model.failed) return 'failed'
    if (hooks.isStopped()) return 'stopped'
    if (model.toolCalls.length === 0) return 'done'

    const tool = await hooks.toolRound(model.toolCalls)
    if (hooks.isStopped() || tool.stopped === true) return 'stopped'
    if (tool.endsTurn) return 'done'
    if (tool.capped === true) {
      hooks.onCapped?.()
      return 'capped'
    }
    if (round >= hardRounds) {
      hooks.onCapped?.()
      return 'capped'
    }
    if (hooks.softRounds !== undefined && round >= hooks.softRounds) {
      hooks.onSoftRound?.()
    }
  }

  hooks.onCapped?.()
  return 'capped'
}
