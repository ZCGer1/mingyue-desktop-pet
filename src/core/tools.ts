import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Logger, ToolContext, ToolDef, ToolOutcome, ToolSpec } from './types'
import { redact, truncate } from './util'

export const TOOL_RESULT_LIMIT = 8000

export function toolError(code: string, message: string): ToolOutcome {
  return { text: `[${code}] ${message}`, failed: true }
}

export interface RegisteredTool {
  def: ToolDef
  source: string
  spec: ToolSpec
}

/**
 * 所有工具 schema 统一附加的模型自判断字段。Core 在 handler 之前剥离它，
 * 因此每个工具的 Zod schema 不需要重复声明，也不会把字段传给业务代码。
 */
const APPROVAL_FIELD_SCHEMA = {
  type: 'string',
  enum: ['auto', 'ask'],
  description:
    '可选。auto 表示按当前权限策略执行；ask 表示你主动请求用户确认。红区操作无论填什么都需要人工确认。'
} as const

/**
 * 桌宠气泡与审批卡共用的一句角色化请求。宿主要先清洗再展示；它不参与
 * 风险与授权判断，也不能替代机械摘要和操作预览。
 */
const APPROVAL_ASK_FIELD_SCHEMA = {
  type: 'string',
  maxLength: 60,
  description:
    '可选。当你填 approval:"ask" 或这次操作需要用户确认时，用当前人格、自定义表达偏好和对话上下文写一句不超过 60 字的第一人称请求；' +
    '通常一到两句，说清准备做的具体动作，可带一句和上下文有关的理由。不要套固定句式，也不要写成系统通知或审批公文。' +
    '这句话会同时显示在桌宠头顶气泡和审批卡顶部。不能替代风险级别、摘要或操作预览；' +
    '不要写链接、完整命令、路径、风险等级、授权范围，也不要写“用户已同意”。不填时宿主会用中性问法补上。'
} as const

function withApprovalField(spec: ToolSpec): ToolSpec {
  const parameters = spec.function.parameters
  if (parameters === null || typeof parameters !== 'object') return spec
  const record = parameters as Record<string, unknown>
  if (record['type'] !== 'object') return spec
  const properties =
    record['properties'] !== null && typeof record['properties'] === 'object'
      ? (record['properties'] as Record<string, unknown>)
      : {}
  return {
    ...spec,
    function: {
      ...spec.function,
      parameters: {
        ...record,
        properties: {
          ...properties,
          approval: APPROVAL_FIELD_SCHEMA,
          approvalAsk: APPROVAL_ASK_FIELD_SCHEMA
        }
      }
    }
  }
}

function stripApprovalField(rawArgs: unknown): unknown {
  if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return rawArgs
  const record = rawArgs as Record<string, unknown>
  const hasApproval = Object.prototype.hasOwnProperty.call(record, 'approval')
  const hasAsk = Object.prototype.hasOwnProperty.call(record, 'approvalAsk')
  if (!hasApproval && !hasAsk) return rawArgs
  const { approval: _approval, approvalAsk: _approvalAsk, ...rest } = record
  return rest
}

/** 这些键下面是普通数据，不是子 schema，递归时不能改写。 */
const SCHEMA_DATA_KEYS: ReadonlySet<string> = new Set(['default', 'examples', 'enum', 'const'])
/** 这些键是“名字 → schema”的映射，需要逐个 value 递归。 */
const SCHEMA_MAP_KEYS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions'
])

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * zod-to-json-schema 的 openApi3 目标会把 positive()/gt()/lt() 生成为
 * `{ exclusiveMinimum: true, minimum: n }` 这类 OpenAPI 3.0 写法。
 * DeepSeek 等 OpenAI 兼容端点按 JSON Schema 校验，要求 exclusiveMinimum/
 * exclusiveMaximum 是数字，否则整个请求会 HTTP 400。
 * 这里只把布尔 exclusive 边界归一化成数值形式，其余字段保持不变。
 */
export function normalizeExclusiveBounds<T>(schema: T): T {
  return normalizeNode(schema) as T
}

function normalizeNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNode)
  if (!isJsonRecord(value)) return value

  const result: Record<string, unknown> = { ...value }
  for (const [exclusiveKey, boundKey] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum']
  ] as const) {
    const exclusive = result[exclusiveKey]
    if (exclusive === true) {
      const bound = result[boundKey]
      if (typeof bound === 'number') {
        result[exclusiveKey] = bound
        delete result[boundKey]
      } else {
        // 没有数值边界可转，布尔值不能发出去。
        delete result[exclusiveKey]
      }
    } else if (exclusive === false) {
      // false 等价于没有该约束，保留 minimum/maximum 即可。
      delete result[exclusiveKey]
    }
  }

  for (const [key, child] of Object.entries(result)) {
    if (SCHEMA_DATA_KEYS.has(key)) continue
    if (SCHEMA_MAP_KEYS.has(key) && isJsonRecord(child)) {
      const map: Record<string, unknown> = {}
      for (const [name, entry] of Object.entries(child)) map[name] = normalizeNode(entry)
      result[key] = map
      continue
    }
    if (isJsonRecord(child) || Array.isArray(child)) result[key] = normalizeNode(child)
  }
  return result
}

/**
 * 工具注册表（PLAN.md §2.5）。工具名全局唯一；参数用 Zod 定义并在发送前
 * 转成 JSON Schema；模型返回的参数再次校验，不合格不执行。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()
  private readonly logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  /**
   * 注册一组工具；冲突时不覆盖，返回冲突信息，由装配层拒绝启动。
   */
  register(source: string, defs: ToolDef[]): Array<{ name: string; first: string; second: string }> {
    const conflicts: Array<{ name: string; first: string; second: string }> = []
    for (const def of defs) {
      if (!/^[a-z][a-z0-9_]*$/.test(def.name)) {
        this.logger.warn('工具名不合法，已跳过', { name: def.name, source })
        continue
      }
      const existing = this.tools.get(def.name)
      if (existing !== undefined) {
        conflicts.push({ name: def.name, first: existing.source, second: source })
        continue
      }
      this.tools.set(def.name, {
        def,
        source,
        spec: {
          type: 'function',
          function: {
            name: def.name,
            description: def.description,
            parameters: normalizeExclusiveBounds(
              zodToJsonSchema(def.parameters, { target: 'openApi3', $refStrategy: 'none' })
            ) as Record<string, unknown>
          }
        }
      })
    }
    return conflicts
  }

  unregisterSource(source: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.source === source) this.tools.delete(name)
    }
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()]
  }

  names(): string[] {
    return [...this.tools.keys()].sort()
  }

  specs(allowlist: string[] | null): ToolSpec[] {
    return this.list()
      .filter((tool) => tool.def.enabled?.() !== false)
      .filter((tool) => allowlist === null || allowlist.includes(tool.def.name))
      .map((tool) => withApprovalField(tool.spec))
  }

  /**
   * 按请求暴露快照的名字生成 schema。names 由 ToolExposureController 决定，
   * 这里只保留运行时 enabled 复验；隐藏旧名不会因为调用方传错而重新出现。
   */
  specsFor(names: readonly string[]): ToolSpec[] {
    const allowed = new Set(names)
    return this.list()
      .filter((tool) => allowed.has(tool.def.name) && tool.def.enabled?.() !== false)
      .map((tool) => withApprovalField(tool.spec))
  }

  describe(): Array<{
    name: string
    description: string
    tags: string[]
    approval: 'auto' | 'required'
    enabled: boolean
  }> {
    return this.list().map((tool) => ({
      name: tool.def.name,
      description: tool.def.description,
      tags: tool.def.tags ?? [],
      approval: tool.def.approval ?? 'auto',
      enabled: tool.def.enabled?.() !== false
    }))
  }

  /**
   * 执行工具。allowlist 非 null 时，未列入的工具返回 TOOL_DENIED。
   * 参数校验、异常、非法回执全部转成标准失败回执，不终止进程。
   */
  async execute(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
    allowlist: string[] | null
  ): Promise<{ outcome: ToolOutcome; tool: RegisteredTool | undefined }> {
    if (allowlist !== null && !allowlist.includes(name)) {
      return { outcome: toolError('TOOL_DENIED', `本轮不允许调用 ${name}`), tool: undefined }
    }
    const tool = this.tools.get(name)
    if (tool === undefined) {
      return { outcome: toolError('UNKNOWN_TOOL', `没有名为 ${name} 的工具`), tool: undefined }
    }
    if (tool.def.enabled?.() === false) {
      return { outcome: toolError('TOOL_DISABLED', `工具 ${name} 当前不可用`), tool }
    }
    const parsed = tool.def.parameters.safeParse(stripApprovalField(rawArgs))
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      return { outcome: toolError('TOOL_FAILED_BAD_ARGS', issues), tool }
    }
    let outcome: ToolOutcome
    try {
      const result = await tool.def.handler(parsed.data, ctx)
      if (result === null || typeof result !== 'object' || typeof result.text !== 'string') {
        outcome = toolError('TOOL_FAILED', '工具返回了非法结果（缺少 text）')
      } else {
        outcome = result
      }
    } catch (error) {
      if (ctx.signal.aborted) {
        outcome = toolError('TOOL_ABORTED', '工具已中止')
      } else {
        const message = error instanceof Error ? error.message : String(error)
        this.logger.error('工具执行失败', { tool: name, error: redact(message) })
        outcome = toolError('TOOL_FAILED', redact(message).slice(0, 500))
      }
    }
    if (outcome.text.length > TOOL_RESULT_LIMIT) {
      this.logger.warn('工具回执超过上限，已截断', { tool: name, length: outcome.text.length })
      outcome = { ...outcome, text: truncate(outcome.text, TOOL_RESULT_LIMIT) }
    }
    return { outcome, tool }
  }
}
