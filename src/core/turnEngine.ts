import { runTurnLoop, type TurnLoopHooks, type TurnLoopOutcome } from './turnLoop'
import type { ModelProvider, ModelRequest, ModelEvent, Usage } from './types'

/** Shared turn order and physical model transport. View adapters supply presentation/policy hooks. */
export interface ToolCallAccum { index: number; id?: string; name?: string; arguments: string; started: boolean }
export class TurnEngine {
  async batch<T>(calls: readonly T[], execute: (call: T, index: number) => Promise<void | 'stop'>, skipped?: (call: T) => void): Promise<void> {
    let stopped = false
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index]!
      if (stopped) { skipped?.(call); continue }
      stopped = await execute(call, index) === 'stop'
    }
  }

  async attempts(attempt: () => Promise<void | 'retry'>): Promise<void> {
    while (await attempt() === 'retry') { /* adapters supply bounded retry policy */ }
  }

  accumulate(event: Extract<ModelEvent, { type: 'tool_call' }>, accums: Map<number, ToolCallAccum>, hooks: { onStart?: (id: string, name: string) => void; onArgs?: (id: string, delta: string) => void } = {}): void {
    let call = accums.get(event.index)
    if (!call) { call = { index: event.index, arguments: '', started: false }; accums.set(event.index, call) }
    if (event.id !== undefined) call.id = event.id
    if (event.name !== undefined) call.name = event.name
    if (call.id !== undefined && call.name !== undefined && !call.started) { call.started = true; hooks.onStart?.(call.id, call.name) }
    if (event.argumentsDelta !== undefined) { call.arguments += event.argumentsDelta; if (call.started && call.id !== undefined) hooks.onArgs?.(call.id, event.argumentsDelta) }
  }
  dispatch(event: ModelEvent, hooks: { onText(text: string): void; onReasoning(text: string): void; onToolCall(event: Extract<ModelEvent, { type: 'tool_call' }>): void; onUsage(usage: Usage): void }): void {
    if (event.type === 'text') hooks.onText(event.text)
    else if (event.type === 'reasoning') hooks.onReasoning(event.text)
    else if (event.type === 'tool_call') hooks.onToolCall(event)
    else if (event.type === 'usage') hooks.onUsage(event.usage)
  }

  run(hooks: TurnLoopHooks): Promise<TurnLoopOutcome> { return runTurnLoop(hooks) }

  stream(provider: ModelProvider, request: ModelRequest, signal: AbortSignal,
    options?: Parameters<ModelProvider['stream']>[2]): ReturnType<ModelProvider['stream']> {
    // Preserve provider iterator cancellation and usage semantics without adding an async boundary.
    return provider.stream(request, signal, options)
  }
}
