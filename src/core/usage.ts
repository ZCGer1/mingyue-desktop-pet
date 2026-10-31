import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Usage } from './types'

/**
 * 估算价格（人民币 / 百万 token）。仅用于设置页的“估算费用”，
 * 实际账单以 DeepSeek 控制台为准。模型改名时可在此补充。
 */
export const PRICING: Record<string, { input: number; cacheHit: number; output: number }> = {
  'deepseek-flash': { input: 1, cacheHit: 0.1, output: 4 },
  'deepseek-v4-pro': { input: 4, cacheHit: 0.4, output: 16 }
}

export interface UsageRecord {
  ts: string
  model: string
  purpose: string
  promptTokens: number
  completionTokens: number
  cacheHitTokens?: number
  estimatedCny: number
  /** 与模型请求/轮次关联，便于验证失败后哪次请求真正产生了用量。 */
  requestId?: string
  turnId?: string
  source?: string
}

export function estimateCostCnY(model: string, usage: Usage): number {
  const price = PRICING[model]
  if (price === undefined) return 0
  const hit = usage.cacheHitTokens ?? 0
  const miss = Math.max(0, usage.promptTokens - hit)
  return (miss * price.input + hit * price.cacheHit + usage.completionTokens * price.output) / 1_000_000
}

/** `logs/usage.jsonl` + 内存累计（诊断/设置页）。 */
export class UsageTracker {
  private readonly file: string | null
  private total: UsageRecord = {
    ts: '',
    model: '',
    purpose: 'total',
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    estimatedCny: 0
  }
  private calls = 0

  constructor(file: string | null) {
    this.file = file
    if (file !== null) mkdirSync(dirname(file), { recursive: true })
  }

  record(
    model: string,
    purpose: string,
    usage: Usage,
    meta: { requestId?: string; turnId?: string; source?: string } = {}
  ): void {
    const estimatedCny = estimateCostCnY(model, usage)
    const record: UsageRecord = {
      ts: new Date().toISOString(),
      model,
      purpose,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cacheHitTokens: usage.cacheHitTokens,
      estimatedCny,
      ...(meta.requestId === undefined ? {} : { requestId: meta.requestId }),
      ...(meta.turnId === undefined ? {} : { turnId: meta.turnId }),
      ...(meta.source === undefined ? {} : { source: meta.source })
    }
    this.calls += 1
    this.total.promptTokens += usage.promptTokens
    this.total.completionTokens += usage.completionTokens
    this.total.cacheHitTokens = (this.total.cacheHitTokens ?? 0) + (usage.cacheHitTokens ?? 0)
    this.total.estimatedCny += estimatedCny
    if (this.file !== null) {
      try {
        appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8')
      } catch {
        /* 用量日志失败可忽略 */
      }
    }
  }

  /** 清空内存计数与用量日志（用户主动清除本地数据时调用）。 */
  reset(): void {
    this.calls = 0
    this.total = {
      ts: '',
      model: '',
      purpose: 'total',
      promptTokens: 0,
      completionTokens: 0,
      cacheHitTokens: 0,
      estimatedCny: 0
    }
    if (this.file !== null) {
      try {
        writeFileSync(this.file, '', 'utf8')
      } catch {
        /* ignore */
      }
    }
  }

  summary(): { calls: number; promptTokens: number; completionTokens: number; cacheHitTokens: number; estimatedCny: number } {
    return {
      calls: this.calls,
      promptTokens: this.total.promptTokens,
      completionTokens: this.total.completionTokens,
      cacheHitTokens: this.total.cacheHitTokens ?? 0,
      estimatedCny: this.total.estimatedCny
    }
  }
}
