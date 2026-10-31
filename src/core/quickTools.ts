import type { AppConfig } from '../shared/config'
import type { ApprovalGate } from './approval'
import {
  deniedOperationsFor,
  isHiddenLegacyTool,
  ToolExposureController,
  type RequestToolSnapshot,
  type ToolExposureMode
} from './toolExposure'
import type { ToolExecutionResult, ToolExecutor } from './toolExecutor'
import type { ToolRegistry } from './tools'
import type { ApprovalRequest, ToolRequestExposure, ToolSpec } from './types'

/**
 * 快捷聊天与共享 ToolExecutor 之间的窄网关。
 *
 * 快捷聊天不直接接触 RiskPolicy/ApprovalGate/AuditLog，只通过这里取工具列表、
 * 执行一次调用并读取活动状态。这样单元测试可以注入 fake gateway，也不需要把
 * Electron 或真实文件系统带进 QuickChatService。
 */

export interface QuickToolCall {
  id: string
  name: string
  arguments: string
}

export interface QuickToolExecuteOptions {
  /** 当前快捷 turn 的 id（用于审批/日志关联，不包含用户正文）。 */
  turnId: string
  /** 第几次快捷 turn；工具审计里的 turn 字段。 */
  turn: number
  signal: AbortSignal
  onRunning?(names: string[]): void
  /** 即将弹出快捷审批；调用方把 UI 切到 waiting。 */
  onApproval?(toolName: string): void
}

export interface QuickToolActivity {
  running: string[]
  cua: boolean
}

export interface QuickToolGateway {
  /** 当前配置下快捷聊天可见的工具 schema；调用即固定本轮请求快照。 */
  specs(): ToolSpec[]
  /**
   * 只读的 schema 估算：不固定请求快照、不推进请求序号。请求级预算用它，
   * 真正的请求仍由 specs() 固定快照。缺省时调用方退回 specs()。
   */
  budgetSpecs?(): ToolSpec[]
  /** 快捷聊天允许的规范工具名（组之外仍是显式 allowlist）。 */
  allowedNames(): string[]
  /** 本轮实际可见的规范工具名；用于提示词与测试断言。 */
  visibleNames(): string[]
  /** 工具组目录文本；只含工具名与用途，不含用户内容。 */
  catalogText(): string
  /** 暴露 revision；tools_load 成功后会递增，提示词需随之刷新。 */
  revision(): number
  /** 最近一次模型请求的快照（诊断用）。 */
  lastSnapshot(): RequestToolSnapshot | null
  /** 开始新 turn：重建基础组并清空上一轮的 taint/快照。 */
  beginTurn(turnId?: string): void
  execute(call: QuickToolCall, options: QuickToolExecuteOptions): Promise<ToolExecutionResult>
  /** 停止/重置时拒绝所有快捷审批，避免 promise 悬挂。 */
  rejectApprovals(reason: string): void
  pendingApproval(): ApprovalRequest | null
  active(): QuickToolActivity
}

export interface QuickToolGatewayOptions {
  sessionId?: () => string
  getConfig: () => AppConfig
  executor: ToolExecutor
  registry: ToolRegistry
  gate: ApprovalGate
  toolExposureMode?: ToolExposureMode
  now?: () => number
}

/**
 * 快捷回复只开放「配一个动作/明确走动」，不开放气泡和自主探索控制：
 * 文字仍走快捷气泡本身，避免 `pet_say` 重复一句。
 */
const QUICK_PRESENTATION_TOOLS: ReadonlySet<string> = new Set([
  'pet_act',
  'pet_emote',
  'pet_walk_to'
])

/**
 * 快捷聊天工具白名单：
 * - 文字表现由快捷气泡承担；仅开放按语义配动作与真实走动；
 * - `pet_say`、探索控制和 `end_turn` 不暴露；
 * - 用户可在设置里按名字额外禁用；
 * - CUA 等运行时开关由 ToolRegistry.specs()/执行器再按 enabled 过滤。
 */
export function quickToolAllowlist(config: AppConfig, names: string[]): string[] {
  if (!config.chatUi.quickInput.allowTools) return []
  const denied = new Set(config.chatUi.quickInput.deniedTools)
  return names.filter((name) => {
    if (name === 'end_turn' || denied.has(name)) return false
    if (!name.startsWith('pet_')) return true
    return QUICK_PRESENTATION_TOOLS.has(name)
  })
}

export class QuickToolGatewayImpl implements QuickToolGateway {
  private readonly options: QuickToolGatewayOptions
  private readonly exposure: ToolExposureController
  private tainted = false
  private turnId: string | null = null
  private requestSeq = 0
  private activeExposure: ToolRequestExposure | null = null
  private snapshot: RequestToolSnapshot | null = null

  constructor(options: QuickToolGatewayOptions) {
    this.options = options
    this.exposure = new ToolExposureController({
      ...(options.toolExposureMode === undefined
        ? {}
        : { mode: options.toolExposureMode }),
      ...(options.now === undefined ? {} : { now: options.now })
    })
  }

  allowedNames(): string[] {
    // registry.names() 包含运行时被关闭的工具（例如 CUA 未授权时的 cua_*）与
    // 旧入口；快捷聊天的显式 allowlist 只保留当前启用的规范工具。
    const enabledNames = this.options.registry
      .list()
      .filter((tool) => tool.def.enabled?.() !== false)
      .map((tool) => tool.def.name)
      .filter((name) => !isHiddenLegacyTool(name))
    return quickToolAllowlist(this.options.getConfig(), enabledNames)
  }

  visibleNames(): string[] {
    const allowed = new Set(this.allowedNames())
    return this.exposure.visibleToolNames(this.options.registry).filter((name) => allowed.has(name))
  }

  catalogText(): string {
    return this.exposure.catalogText(this.options.registry)
  }

  revision(): number {
    return this.exposure.revision()
  }

  lastSnapshot(): RequestToolSnapshot | null {
    return this.snapshot
  }

  specs(): ToolSpec[] {
    this.requestSeq += 1
    const prepared = this.exposure.prepareRequest({
      registry: this.options.registry,
      allowlist: this.allowedNames(),
      requestId: `quick-req-${this.requestSeq}`,
      turnId: this.turnId,
      source: 'quick-chat'
    })
    const denied = this.deniedTools()
    this.activeExposure = this.exposure.handleFor(prepared.snapshot, this.options.registry, {
      deniedNames: denied,
      deniedOperations: deniedOperationsFor([...denied])
    })
    this.snapshot = prepared.snapshot
    return prepared.specs
  }

  budgetSpecs(): ToolSpec[] {
    const allowlist = this.allowedNames()
    const names = this.exposure
      .visibleToolNames(this.options.registry)
      .filter((name) => allowlist.includes(name))
    return typeof this.options.registry.specsFor === 'function'
      ? this.options.registry.specsFor(names)
      : this.options.registry.specs(names)
  }

  beginTurn(turnId?: string): void {
    this.tainted = false
    this.turnId = turnId ?? this.turnId
    this.activeExposure = null
    this.snapshot = null
    this.exposure.beginCycle({ turnId: this.turnId, source: 'quick-chat' })
  }

  async execute(
    call: QuickToolCall,
    options: QuickToolExecuteOptions
  ): Promise<ToolExecutionResult> {
    // 正常情况下 execute 紧跟同一轮的 specs()；防御性兜底也生成固定快照。
    // 用户 deniedTools 是当前配置，不是请求快照的一部分：中途在设置里新增的
    // 禁用项必须立刻生效，不能靠旧的 activeExposure 继续放行。
    const snapshotExposure = this.activeExposure ?? this.fallbackExposure()
    const denied = this.deniedTools()
    const exposure: ToolRequestExposure = {
      ...snapshotExposure,
      deniedNames: denied,
      deniedOperations: deniedOperationsFor([...denied])
    }
    return this.options.executor.execute(
      call,
      {
        kind: 'quick',
        sessionId: this.options.sessionId?.() ?? 'quick',
        turnId: options.turnId,
        turn: options.turn,
        allowlist: this.allowedNames(),
        source: 'quick-chat',
        // 仅审计/兼容；授权由 source='quick-chat' 决定。
        userInitiated: true,
        tainted: this.tainted,
        exposure,
        signal: options.signal
      },
      {
        ...(options.onRunning === undefined ? {} : { onRunningChange: options.onRunning }),
        onTaint: () => {
          this.tainted = true
        },
        ...(options.onApproval === undefined
          ? {}
          : { onApprovalRequest: (toolName: string) => options.onApproval?.(toolName) })
      }
    )
  }

  private deniedTools(): Set<string> {
    return new Set(this.options.getConfig().chatUi.quickInput.deniedTools)
  }

  private fallbackExposure(): ToolRequestExposure {
    this.requestSeq += 1
    const prepared = this.exposure.prepareRequest({
      registry: this.options.registry,
      allowlist: this.allowedNames(),
      requestId: `quick-req-${this.requestSeq}`,
      turnId: this.turnId,
      source: 'quick-chat'
    })
    const denied = this.deniedTools()
    this.activeExposure = this.exposure.handleFor(prepared.snapshot, this.options.registry, {
      deniedNames: denied,
      deniedOperations: deniedOperationsFor([...denied])
    })
    this.snapshot = prepared.snapshot
    return this.activeExposure
  }

  rejectApprovals(reason: string): void {
    this.options.gate.rejectByOrigin('quick', reason)
  }

  pendingApproval(): ApprovalRequest | null {
    return this.options.gate.list('quick')[0] ?? null
  }

  active(): QuickToolActivity {
    return {
      running: this.options.executor.runningFor('quick'),
      cua: this.options.executor.hasRunningCua('quick')
    }
  }
}
