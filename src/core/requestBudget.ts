import type { ModelMessage, ToolSpec } from './types'
import { estimateTokens } from './util'

/**
 * 请求级上下文预算（PLAN.md R3）。
 *
 * 只看会话文本是不够的：工具 schema、图片、输出预留和协议开销都在同一次
 * 请求里。这里对「即将发出的整包请求」做一次统一估算，主聊天与快捷聊天
 * 共用同一套口径。估算偏保守（图片按上限计），真实 usage 只用于校准系数，
 * 不把 schemaBytes 直接当成 token。
 */

const IMAGE_TOKEN_CAP = 1_500
const MIN_SAFETY_MARGIN = 512
const SAFETY_RATIO = 0.08
export const MIN_CALIBRATION = 0.9
export const MAX_CALIBRATION = 2.5

export interface RequestBudgetInput {
  messages: ModelMessage[]
  tools?: ToolSpec[]
  /** 输出预留；每次请求只计一次。 */
  outputReserve?: number
  /** 显式安全余量；缺省按输入估算的 8%，至少 512。 */
  safetyMargin?: number
  /** 由真实 usage 校准出的系数，缺省 1。 */
  calibration?: number
}

export interface RequestBudgetEstimate {
  /** 未校准的完整输入估算；usage 校准只能使用这个口径。 */
  rawInputTokens: number
  /** 消息正文与工具参数（未校准）。 */
  messageTokens: number
  /** 工具 schema（未校准）。 */
  toolTokens: number
  /** 图片（未校准，按每张上限保守计）。 */
  imageTokens: number
  /** 校准后的输入总量，不含输出预留与安全余量。 */
  inputTokens: number
  outputReserve: number
  safetyMargin: number
  /** 整包估算：输入 + 输出预留 + 安全余量。 */
  total: number
  calibration: number
}

export function estimateMessagesTokens(messages: ModelMessage[]): {
  textTokens: number
  imageTokens: number
} {
  let textTokens = 0
  let imageTokens = 0
  for (const message of messages) {
    if (typeof message.content === 'string') {
      textTokens += estimateTokens(message.content)
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text') textTokens += estimateTokens(part.text)
        else if (part.type === 'image_url') imageTokens += IMAGE_TOKEN_CAP
      }
    }
    for (const call of message.tool_calls ?? []) {
      textTokens += estimateTokens(call.function.name + call.function.arguments)
    }
  }
  return { textTokens, imageTokens }
}

export function estimateToolsTokens(tools: ToolSpec[] = []): number {
  let total = 0
  for (const tool of tools) {
    total += estimateTokens(tool.function.name + tool.function.description)
    total += estimateTokens(JSON.stringify(tool.function.parameters))
  }
  return total
}

export function estimateRequestBudget(input: RequestBudgetInput): RequestBudgetEstimate {
  const { textTokens, imageTokens } = estimateMessagesTokens(input.messages)
  const toolTokens = estimateToolsTokens(input.tools ?? [])
  const calibration = clampCalibration(input.calibration ?? 1)
  const rawInput = textTokens + toolTokens + imageTokens
  const inputTokens = Math.ceil(rawInput * calibration)
  const outputReserve = Math.max(0, Math.round(input.outputReserve ?? 0))
  const safetyMargin =
    input.safetyMargin === undefined
      ? Math.max(MIN_SAFETY_MARGIN, Math.ceil(inputTokens * SAFETY_RATIO))
      : Math.max(0, Math.round(input.safetyMargin))
  return {
    rawInputTokens: rawInput,
    messageTokens: textTokens,
    toolTokens,
    imageTokens,
    inputTokens,
    outputReserve,
    safetyMargin,
    total: inputTokens + outputReserve + safetyMargin,
    calibration
  }
}

/**
 * 用真实 promptTokens 校准下一次估算。只有实际用量足够大、估算也不失真时
 * 才更新；平滑系数避免单次异常把预算拉飞。校准只允许在 [0.9, 2.5] 内，
 * 不会因为服务商少报缓存命中而把历史裁得过猛。
 */
export function calibrateFromUsage(
  previous: number,
  estimatedInput: number,
  actualPromptTokens: number
): number {
  if (
    !Number.isFinite(previous) ||
    !Number.isFinite(estimatedInput) ||
    !Number.isFinite(actualPromptTokens)
  ) {
    return 1
  }
  if (actualPromptTokens < 256 || estimatedInput < 128) return clampCalibration(previous)
  const ratio = clampCalibration(actualPromptTokens / estimatedInput)
  const next = clampCalibration(previous * 0.7 + ratio * 0.3)
  return Math.round(next * 1_000) / 1_000
}

export function clampCalibration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.min(MAX_CALIBRATION, Math.max(MIN_CALIBRATION, value))
}
