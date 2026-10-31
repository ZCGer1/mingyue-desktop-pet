import type { AppConfig } from '../shared/config'
import { normalizeProcessKey } from '../shared/processName'
import { sanitizeApprovalAsk, type ApprovalGate } from './approval'
import type { AuditLog } from './audit'
import { domainConstraintError, type CapabilityStore } from './capabilityStore'
import type {
  CapabilityCheckResult,
  CapabilityGrant,
  CapabilityTargets,
  ToolSource
} from './capabilityTypes'
import type { DesktopActionCoordinator, DesktopLease } from './desktopCoordinator'
import { RiskPolicy, type RiskAssessment } from './riskPolicy'
import { toolMetaFor, type ToolMeta } from './toolMeta'
import type { ToolRegistry } from './tools'
import {
  hiddenToolHint,
  isHiddenLegacyTool,
  toolGroupsFor,
  toolOperationFor
} from './toolExposure'
import type {
  ApprovalOrigin,
  ApprovalPreview,
  ApprovalScope,
  Clock,
  Logger,
  ToolContext,
  ToolDef,
  ToolDiagnostics,
  ToolOutcome,
  ToolOutcomeMeta,
  ToolRequestExposure
} from './types'
import { isAbortError, truncate } from './util'

/** 一轮内自动执行黄区操作的上限（按小时，完整/快捷共享）。 */
const AUTO_OP_WINDOW_MS = 60 * 60_000
/** 成功接触这些工具后，本轮上下文视为不可信（禁止固化长期记忆）。 */
const TAINT_TOOLS = new Set([
  'page_current',
  'cua_screenshot',
  'cua_zoom',
  'win_list',
  'win_read',
  'win_capture',
  'screen_observe',
  'computer_observe',
  'computer_find',
  'browser_snapshot',
  'web_fetch',
  'web_search',
  // B 站适配读取返回标题/简介/字幕，属于外部不可信数据；保存发现是
  // 唯一被明确允许的持久化出口，由 discovery_save 自己校验观察凭据。
  'bili_open',
  'bili_listing',
  'bili_search',
  'bili_detail',
  'bili_subtitle',
  'bili_transcribe_status'
])
/**
 * 本轮包含不可信页面/屏幕内容时禁止写长期记忆。
 * 兴趣工具不在这里整轮拒绝：P2 的 InterestWorld 只允许结构字段，
 * 正文必须等下一轮由模型自己总结后再写。
 */
const UNTRUSTED_MEMORY_TOOLS = new Set(['mem_write', 'mem_forget'])

export interface ToolCallRequest {
  id: string
  name: string
  arguments: string
}

export interface ToolSurface {
  kind: ApprovalOrigin
  sessionId: string
  /** Core 回合 ID / 快捷 turn ID；同一回复内的多次工具批次共享。 */
  turnId?: string
  turn: number
  allowlist: string[] | null
  /** 调用来源；授权判断只看它，不再看 userInitiated。 */
  source: ToolSource
  /** 任务来源时绑定任务 id / generation。 */
  taskId?: string
  taskGeneration?: number
  taskTitle?: string
  /** 仅保留给审计/兼容；任何授权判断都不得使用。 */
  userInitiated: boolean
  /** 本轮是否已接触网页/屏幕等不可信内容。 */
  tainted: boolean
  /**
   * 生成本次模型请求时的工具暴露快照。它是可见性/拒绝集合，不是授权：
   * 授权仍由 capability/target/approval 按当前状态重新判定。
   */
  exposure?: ToolRequestExposure
  /** 调用方（Core/快捷聊天）的停止信号。 */
  signal: AbortSignal
}

/** 工具真实执行后的本地回调；只含元数据，不含正文。 */
export interface ToolResultInfo {
  name: string
  source: ToolSource
  taskId?: string
  taskGeneration?: number
  failed: boolean
  meta?: ToolOutcomeMeta
}

export interface ToolExecutionStep {
  callId: string
  name: string
  args: unknown
  meta: ToolMeta
}

export interface ToolExecutionHooks {
  onRunningChange?(names: string[]): void
  onTaint?(toolName: string): void
  /** 即将进入人工审批（静态或工具内部动态请求）；用于 UI 切到“等你确认”。 */
  onApprovalRequest?(toolName: string): void
  /**
   * 审批与桌面租约之后、handler 之前。TaskRunner 用它写 WAL intent。
   * 返回 abort 时不会执行 handler。
   */
  onBeforeExecute?(step: ToolExecutionStep): { abort: boolean; reason?: string } | void
  /** handler 结束后（包括失败/中止）。TaskRunner 用它写 done/unknown 与预算。 */
  onExecuted?(
    step: ToolExecutionStep & { outcome: ToolOutcome }
  ): { abort: boolean; reason?: string } | void
}

export interface ToolExecutionResult {
  outcome: ToolOutcome
  risk?: RiskAssessment
  effective?: 'auto' | 'ask'
  grantScope?: ApprovalScope
  endsTurn: boolean
  /** 任务执行器要求本轮立即停止（预算/授权/接管）。 */
  halt?: boolean
}

export interface ApprovalCounters {
  autoGreen: number
  autoYellow: number
  askGreen: number
  askYellow: number
  askRed: number
  approved: number
  denied: number
}

export interface ToolExecutorOptions {
  config: AppConfig
  dataDir: string
  registry: ToolRegistry
  gate: ApprovalGate
  audit: AuditLog
  logger: Logger
  clock: Clock
  capabilities: CapabilityStore
  /** 桌面观察/输入/启动的唯一仲裁；没有桌面端口时可为 null。 */
  coordinator?: DesktopActionCoordinator | null
  /** 任务仍处于可执行 generation？迟到回调必须返回 false。 */
  isTaskRunnable?: (taskId: string, generation: number) => boolean
  /**
   * 解析本次动作会触及的路径/应用/域名。返回 undefined 表示无法解析；
   * 只要 grant 带对应约束就会 fail closed。CUA 前台应用必须实时解析。
   */
  resolveCapabilityTargets?: (
    call: ToolCallRequest,
    surface: ToolSurface
  ) => Promise<CapabilityTargets | undefined>
  /** 工具真实执行结束后回调（含失败）；用于经历/探索进度等本地记录。 */
  onToolResult?: (info: ToolResultInfo) => void
}

/**
 * 单次工具调用的共享执行器。
 *
 * Core 与快捷聊天都只通过它执行工具：风险分级、审批、auto-op 预算、
 * 运行中状态、审计与 abort 只有一份实现，避免两个入口的安全策略漂移。
 * 它不接触 Session/聊天历史；调用方负责把回执追加到各自的上下文。
 */
export class ToolExecutor {
  private readonly config: AppConfig
  private readonly registry: ToolRegistry
  private readonly gate: ApprovalGate
  private readonly audit: AuditLog
  private readonly logger: Logger
  private readonly clock: Clock
  private readonly capabilities: CapabilityStore
  private readonly coordinator: DesktopActionCoordinator | null
  private readonly isTaskRunnable: ((taskId: string, generation: number) => boolean) | null
  private readonly resolveCapabilityTargets:
    | ((
        call: ToolCallRequest,
        surface: ToolSurface
      ) => Promise<CapabilityTargets | undefined>)
    | null
  private readonly onToolResult: ((info: ToolResultInfo) => void) | null
  private readonly riskPolicy: RiskPolicy
  private readonly autoOps: number[] = []
  private readonly counters: ApprovalCounters = {
    autoGreen: 0,
    autoYellow: 0,
    askGreen: 0,
    askYellow: 0,
    askRed: 0,
    approved: 0,
    denied: 0
  }
  private readonly running: Record<ApprovalOrigin, string[]> = { chat: [], quick: [] }
  private readonly interruptible = new Map<AbortController, ApprovalOrigin>()

  constructor(options: ToolExecutorOptions) {
    this.config = options.config
    this.registry = options.registry
    this.gate = options.gate
    this.audit = options.audit
    this.logger = options.logger
    this.clock = options.clock
    this.capabilities = options.capabilities
    this.coordinator = options.coordinator ?? null
    this.isTaskRunnable = options.isTaskRunnable ?? null
    this.resolveCapabilityTargets = options.resolveCapabilityTargets ?? null
    this.onToolResult = options.onToolResult ?? null
    this.riskPolicy = new RiskPolicy({
      getConfig: () => this.config,
      dataDir: options.dataDir
    })
    this.gate.onResolved((_request, decision) => {
      if (decision.approved) this.counters.approved += 1
      else this.counters.denied += 1
    })
  }

  get pendingCount(): number {
    return this.gate.pendingCount
  }

  runningFor(origin: ApprovalOrigin): string[] {
    return [...this.running[origin]]
  }

  hasRunningCua(origin: ApprovalOrigin): boolean {
    return this.running[origin].some(
      (name) => name.startsWith('cua_') || name === 'screen_observe'
    )
  }

  /** 中止某个入口正在运行的 interruptible 工具；不会影响另一个聊天。 */
  abortInterruptible(origin: ApprovalOrigin): void {
    for (const [controller, owner] of [...this.interruptible.entries()]) {
      if (owner === origin) controller.abort()
    }
  }

  async execute(
    call: ToolCallRequest,
    surface: ToolSurface,
    hooks: ToolExecutionHooks = {}
  ): Promise<ToolExecutionResult> {
    // 旧入口永远不执行：即使模型看到了历史回执里的旧名，也只回规范提示。
    if (isHiddenLegacyTool(call.name)) {
      return rejected(hiddenNotVisibleText(call.name))
    }
    if (surface.allowlist !== null && !surface.allowlist.includes(call.name)) {
      return rejected(`[TOOL_DENIED] 本轮不允许调用 ${call.name}`)
    }

    let args: unknown = {}
    if (call.arguments.trim() !== '') {
      try {
        args = JSON.parse(call.arguments)
      } catch {
        return rejected('[TOOL_FAILED_BAD_ARGS] 工具参数不是合法 JSON')
      }
    }

    const tool = this.registry.get(call.name)
    if (tool === undefined) {
      return rejected(`[UNKNOWN_TOOL] 没有名为 ${call.name} 的工具`)
    }
    if (tool.def.enabled?.() === false) {
      return rejected(`[TOOL_DISABLED] 工具 ${call.name} 当前不可用`)
    }
    const visibility = visibilityError(call.name, surface.exposure)
    if (visibility !== null) return rejected(visibility)

    // 逻辑操作身份：旧 grant / 旧 deniedTools 按原动作名继续生效，
    // 但新模式不会被旧授权自动拓宽（例如 win_read 不会放行 elements 视图）。
    const operation = toolOperationFor(call.name, args)
    const denied = deniedText(call.name, operation, surface.exposure)
    if (denied !== null) return rejected(denied)

    // 屏幕/网页内容是不可信数据：接触过后禁止把内容固化成长期记忆或兴趣正文。
    if (surface.tainted && UNTRUSTED_MEMORY_TOOLS.has(call.name)) {
      return rejected(
        '[PAGE_UNTRUSTED_MEMORY] 本轮包含网页或屏幕内容，禁止写入/删除长期记忆或直接固化兴趣正文。'
      )
    }

    const meta = toolMetaFor(call.name, operation)
    const stale = this.taskContextError(surface)
    if (stale !== null) {
      const outcome: ToolOutcome = { text: `[TASK_STALE] ${stale}`, failed: true }
      this.auditDenied(call, args, surface, meta, 'stale-task')
      return { outcome, endsTurn: false }
    }

    // 带约束的任务 grant 必须知道本次动作的真实目标；解析失败即 undefined，
    // 由 CapabilityStore 按 fail closed 拒绝。CUA 前台应用必须实时解析。
    const targets =
      meta.capability === undefined ? undefined : await this.targetsFor(call, surface)
    const targetArgs = capabilityTargetArgs(targets)

    // 授权判断只看 source/taskId；userInitiated 不再参与任何放行。
    let capabilityCheck: CapabilityCheckResult =
      meta.capability === undefined
        ? { allowed: true }
        : this.capabilities.check({
            source: surface.source,
            ...(surface.taskId === undefined ? {} : { taskId: surface.taskId }),
            capability: meta.capability,
            action: operation,
            ...targetArgs,
            now: this.clock.now()
          })
    if (!capabilityCheck.allowed) {
      const outcome: ToolOutcome = {
        text: capabilityDeniedText(capabilityCheck),
        failed: true
      }
      this.auditDenied(call, args, surface, meta, 'capability-denied')
      const halt = this.notifyDenied(hooks, call, args, meta, outcome)
      return { outcome, endsTurn: false, ...(halt ? { halt: true } : {}) }
    }

    const modelChoice = modelApprovalChoice(args)
    const approvalAsk = approvalAskArg(args)
    const risk = this.riskPolicy.assess(call.name, args, {
      ...(tool.def.tags === undefined ? {} : { tags: tool.def.tags }),
      ...(tool.def.approval === undefined ? {} : { approval: tool.def.approval })
    })
    const scopedKey = this.scopedGrantKey(risk, surface.kind)
    const autoGrant: CapabilityGrant | null =
      surface.source === 'task' && risk.level === 'yellow' && risk.forceAsk !== 'always'
        ? this.capabilities.autoApprovesYellow({
            taskId: surface.taskId,
            action: operation,
            ...targetArgs,
            now: this.clock.now()
          })
        : null
    const taskAuto = autoGrant !== null
    const effective = this.effectiveApproval(risk, modelChoice, scopedKey, taskAuto)
    this.countRisk(risk.level, effective)

    // 红区永远 ask；grantScope 保持 once 是因为 sessionScoped/alwaysScoped 均为 false。
    let grantScope: ApprovalScope = 'once'
    if (effective === 'ask') {
      hooks.onApprovalRequest?.(call.name)
      const base =
        tool.def.approvalInfo?.(args) ?? {
          summary: call.name,
          preview: {
            kind: 'text' as const,
            title: call.name,
            body: truncate(call.arguments, 2000)
          },
          risk: risk.approvalRisk
        }
      const summary = truncate(`${risk.reason}：${base.summary}`, 400)
      const grantable = risk.level === 'yellow' && scopedKey !== undefined
      const sessionScoped = grantable && risk.forceAsk !== 'always'
      const alwaysScoped = sessionScoped && risk.forceAsk !== 'always' && risk.sharedGrant !== true
      const decision = await this.gate.request({
        toolName: call.name,
        summary,
        preview: base.preview,
        risk: risk.approvalRisk,
        riskLevel: risk.level,
        modelChoice,
        effective,
        approvalAsk: approvalAsk ?? fallbackApprovalAsk(base.preview),
        sessionId: surface.sessionId,
        origin: surface.kind,
        source: surface.source,
        ...(surface.taskId === undefined ? {} : { taskId: surface.taskId }),
        ...(surface.taskTitle === undefined ? {} : { taskTitle: surface.taskTitle }),
        ...(sessionScoped && scopedKey !== undefined ? { grantKey: scopedKey } : {}),
        sessionScoped,
        alwaysScoped,
        ...(risk.grantLabel === undefined ? {} : { grantLabel: risk.grantLabel }),
        ...(risk.grantTtlMs === undefined
          ? {}
          : {
              grantTtlMs: risk.grantTtlMs,
              sessionScopeLabel: `${Math.max(1, Math.round(risk.grantTtlMs / 60_000))} 分钟内`
            })
      })
      if (!decision.approved) {
        const reason = decision.reason ?? '用户拒绝'
        const outcome: ToolOutcome = { text: `[TOOL_DENIED] ${reason}`, failed: true }
        this.auditResult(call, tool.def, args, outcome, risk, modelChoice, effective, 'once', surface, 0)
        const halt = this.notifyDenied(hooks, call, args, meta, outcome)
        return {
          outcome,
          risk,
          effective,
          grantScope: 'once',
          endsTurn: false,
          ...(halt ? { halt: true } : {})
        }
      }
      grantScope = decision.grantScope ?? 'once'
    }

    // 审批等待期间可能发生：任务被取消/接管、grant 被撤销或过期。
    // 这里必须按当前状态重新计算，不能相信审批前的结果。
    const revalidatedStale = this.taskContextError(surface)
    if (revalidatedStale !== null) {
      const outcome: ToolOutcome = { text: `[TASK_STALE] ${revalidatedStale}`, failed: true }
      this.auditDenied(call, args, surface, meta, 'stale-task-after-approval')
      return { outcome, risk, effective, grantScope, endsTurn: false }
    }
    if (meta.capability !== undefined) {
      // 等待审批期间窗口/路径/域名可能变化：重新解析，而不是复用审批前的目标。
      const revalidatedTargets = await this.targetsFor(call, surface)
      capabilityCheck = this.capabilities.revalidate({
        source: surface.source,
        ...(surface.taskId === undefined ? {} : { taskId: surface.taskId }),
        capability: meta.capability,
        action: operation,
        ...capabilityTargetArgs(revalidatedTargets),
        now: this.clock.now()
      })
      if (!capabilityCheck.allowed) {
        const outcome: ToolOutcome = {
          text: capabilityDeniedText(capabilityCheck),
          failed: true
        }
        this.auditDenied(call, args, surface, meta, 'capability-revoked')
        const halt = this.notifyDenied(hooks, call, args, meta, outcome)
        return {
          outcome,
          risk,
          effective,
          grantScope,
          endsTurn: false,
          ...(halt ? { halt: true } : {})
        }
      }
    }

    const startedAt = this.clock.now()
    const interruptible = tool.def.interruptible === true
    const controller = new AbortController()
    if (surface.signal.aborted) controller.abort()
    const onAbort = (): void => controller.abort()
    surface.signal.addEventListener('abort', onAbort, { once: true })
    if (interruptible) this.interruptible.set(controller, surface.kind)
    this.pushRunning(surface.kind, call.name, hooks)

    let outcome: ToolOutcome | null = null
    let lease: DesktopLease | null = null
    let releaseMerged: (() => void) | null = null
    let handlerRan = false
    let leaseDenied = false
    let halt = false
    try {
      if (controller.signal.aborted) {
        outcome = { text: '[TOOL_ABORTED] 已停止', failed: true }
      } else {
        let handlerSignal = controller.signal
        if (meta.desktop !== undefined && this.coordinator !== null) {
          const leaseAbort = new AbortController()
          const merged = mergeSignals([controller.signal, leaseAbort.signal])
          releaseMerged = merged.dispose
          const acquired = await this.coordinator.acquire({
            owner: desktopOwner(surface),
            priority: desktopPriority(surface),
            kind: meta.desktop,
            ...(surface.taskId === undefined ? {} : { taskId: surface.taskId }),
            ...(surface.taskGeneration === undefined
              ? {}
              : { taskGeneration: surface.taskGeneration }),
            signal: merged.signal,
            abort: () => leaseAbort.abort(),
            label: call.name
          })
          if (!acquired.ok) {
            leaseDenied = true
            outcome = {
              text: `[DESKTOP_${acquired.reason.toUpperCase().replace(/-/g, '_')}] ${acquired.message}`,
              failed: true
            }
          } else {
            lease = acquired.lease
            handlerSignal = merged.signal
          }
        }

        if (outcome === null) {
          const step: ToolExecutionStep = { callId: call.id, name: call.name, args, meta }
          const before = hooks.onBeforeExecute?.(step)
          if (before?.abort === true) {
            outcome = {
              text: `[TASK_HALTED] ${before.reason ?? '任务已停止'}`,
              failed: true
            }
          } else {
            // 执行前预占配额：失败也计入尝试，避免“部分执行后重试”越过上限。
            const consumeGrant = capabilityCheck.grant ?? autoGrant
            if (consumeGrant !== null && !this.capabilities.consume(consumeGrant.id)) {
              outcome = {
                text: '[CAPABILITY_DENIED] 这个授权的动作次数已用完，或授权已失效。',
                failed: true
              }
              halt = this.notifyDenied(hooks, call, args, meta, outcome) || halt
            } else {
              const ctx: ToolContext = {
                sessionId: surface.sessionId,
                ...(surface.turnId === undefined ? {} : { turnId: surface.turnId }),
                turn: surface.turn,
                source: surface.source,
                ...(surface.taskId === undefined ? {} : { taskId: surface.taskId }),
                ...(surface.taskGeneration === undefined
                  ? {}
                  : { taskGeneration: surface.taskGeneration }),
                ...(capabilityCheck.grant?.constraints.appAllowlist === undefined
                  ? {}
                  : {
                      allowedDesktopApps:
                        capabilityCheck.grant.constraints.appAllowlist
                          .map((name) => normalizeProcessKey(name))
                          .filter((name): name is string => name !== null)
                    }),
                ...(capabilityCheck.grant?.constraints.domains === undefined
                  ? {}
                  : {
                      allowedDomains: [...capabilityCheck.grant.constraints.domains]
                    }),
                tainted: surface.tainted,
                ...(surface.exposure === undefined
                  ? {}
                  : { toolExposure: surface.exposure }),
                signal: handlerSignal,
                requireApproval: async (request) => {
                  hooks.onApprovalRequest?.(call.name)
                  const decision = await this.gate.request({
                    toolName: call.name,
                    summary: truncate(request.reason, 400),
                    preview: request.preview ?? { kind: 'text', title: request.reason },
                    risk: request.risk ?? 'medium',
                    approvalAsk:
                      approvalAsk ??
                      fallbackApprovalAsk(
                        request.preview ?? { kind: 'text', title: request.reason }
                      ),
                    sessionId: surface.sessionId,
                    origin: call.name === 'task_complete' ? (request.origin ?? surface.kind) : surface.kind,
                    source: surface.source,
                    ...(surface.taskId === undefined ? {} : { taskId: surface.taskId }),
                    ...(surface.taskTitle === undefined ? {} : { taskTitle: surface.taskTitle })
                  })
                  return decision.approved
                },
                log: (level, msg, data) => this.logger.log(level, msg, data),
                now: () => this.clock.now()
              }
              handlerRan = true
              const result = await this.registry.execute(call.name, args, ctx, surface.allowlist)
              outcome = result.outcome
              // 重定向后的最终 URL 必须再次命中授权域名，正文才允许交给模型。
              const finalError = this.finalTargetError(
                outcome,
                capabilityCheck.grant ?? null
              )
              if (finalError !== null) {
                outcome = { text: `[CAPABILITY_DENIED] ${finalError}`, failed: true }
              }
            }
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        outcome = { text: '[TOOL_ABORTED] 工具已中止', failed: true }
      } else {
        const message = error instanceof Error ? error.message : String(error)
        this.logger.error('工具执行器异常', { tool: call.name, error: message.slice(0, 300) })
        outcome = { text: '[TOOL_FAILED] 工具执行失败', failed: true }
      }
    } finally {
      lease?.release()
      releaseMerged?.()
      surface.signal.removeEventListener('abort', onAbort)
      if (interruptible) this.interruptible.delete(controller)
      this.popRunning(surface.kind, call.name, hooks)
    }

    const finalOutcome = outcome ?? { text: '[TOOL_FAILED] 工具执行失败', failed: true }
    if (operation !== call.name) {
      // 只补充本地操作身份，供自主探索分类等运行时判断；不进入模型文本。
      finalOutcome.meta = { ...finalOutcome.meta, operation }
    }
    if (handlerRan || leaseDenied) {
      // 桌面租约被拒绝意味着任务必须立刻停下（接管/锁屏/退出），
      // 即使 handler 从未运行也要把结果交给任务运行时。
      const step = { callId: call.id, name: call.name, args, meta, outcome: finalOutcome }
      const after = hooks.onExecuted?.(step)
      if (after?.abort === true) halt = true
    }
    if (handlerRan) {
      try {
        this.onToolResult?.({
          name: call.name,
          source: surface.source,
          ...(surface.taskId === undefined ? {} : { taskId: surface.taskId }),
          ...(surface.taskGeneration === undefined
            ? {}
            : { taskGeneration: surface.taskGeneration }),
          failed: finalOutcome.failed === true,
          ...(finalOutcome.meta === undefined ? {} : { meta: finalOutcome.meta })
        })
      } catch (error) {
        this.logger.warn('工具结果回调失败', { tool: call.name, error: String(error) })
      }
    }
    if (finalOutcome.failed !== true) {
      // 截图/页面正文本身就是不可信输入；任何返回图片的 CUA 动作也一样。
      if (TAINT_TOOLS.has(call.name) || (finalOutcome.images?.length ?? 0) > 0) {
        hooks.onTaint?.(call.name)
      }
    }
    if (effective === 'auto' && risk.level === 'yellow' && finalOutcome.failed !== true) {
      this.recordAutoOp()
    }
    this.auditResult(
      call,
      tool.def,
      args,
      finalOutcome,
      risk,
      modelChoice,
      effective,
      grantScope,
      surface,
      this.clock.now() - startedAt,
      {
        ...(capabilityCheck.allowed && capabilityCheck.grant !== undefined
          ? { grantId: capabilityCheck.grant.id }
          : {}),
        ...(lease === null ? {} : { leaseId: lease.id }),
        ...(operation === call.name ? {} : { operation })
      }
    )

    return {
      outcome: finalOutcome,
      risk,
      effective,
      grantScope,
      endsTurn: tool.def.endsTurn === true,
      ...(halt ? { halt: true } : {})
    }
  }

  diagnostics(): {
    counters: ApprovalCounters
    autoOpsLastHour: number
    maxAutoOpsPerHour: number
    running: Record<ApprovalOrigin, string[]>
  } {
    const cutoff = this.clock.now() - AUTO_OP_WINDOW_MS
    return {
      counters: { ...this.counters },
      autoOpsLastHour: this.autoOps.filter((at) => at > cutoff).length,
      maxAutoOpsPerHour: this.config.autonomy.maxAutoOpsPerHour,
      running: { chat: this.runningFor('chat'), quick: this.runningFor('quick') }
    }
  }

  // ------------------------------------------------------------------

  private auditResult(
    call: ToolCallRequest,
    def: ToolDef,
    args: unknown,
    outcome: ToolOutcome,
    risk: RiskAssessment,
    modelChoice: 'auto' | 'ask',
    effective: 'auto' | 'ask',
    grantScope: ApprovalScope,
    surface: ToolSurface,
    durationMs: number,
    extraIds: { grantId?: string; leaseId?: string; operation?: string } = {}
  ): void {
    const approvalKind: 'auto' | 'required' | 'session' | 'always' =
      grantScope === 'session'
        ? 'session'
        : grantScope === 'always'
          ? 'always'
          : effective === 'auto'
            ? 'auto'
            : 'required'
    this.audit.write({
      kind: 'tool',
      session: surface.sessionId,
      tool: call.name,
      summary: def.auditSummary?.(args) ?? summaryFor(call.name, args),
      result: outcome.failed === true ? 'failed' : 'ok',
      durationMs,
      approval: approvalKind,
      extra: {
        risk: risk.level,
        modelChoice,
        effective,
        grantScope,
        origin: surface.kind,
        source: surface.source,
        ...(surface.taskId === undefined ? {} : { taskId: surface.taskId.slice(0, 12) }),
        ...(surface.taskGeneration === undefined
          ? {}
          : { taskGeneration: surface.taskGeneration }),
        ...(extraIds.grantId === undefined ? {} : { grantId: extraIds.grantId.slice(0, 12) }),
        ...(extraIds.leaseId === undefined ? {} : { leaseId: extraIds.leaseId.slice(0, 12) }),
        ...(extraIds.operation === undefined ? {} : { operation: extraIds.operation.slice(0, 40) }),
        ...sanitizeToolDiagnostics(outcome.diagnostics, call.id)
      }
    })
  }

  /**
   * 被授权层直接拒绝时也写一条审计：只记来源/工具/任务 id，
   * 不含参数、截图或窗口内容。
   */
  private auditDenied(
    call: ToolCallRequest,
    _args: unknown,
    surface: ToolSurface,
    meta: ToolMeta,
    reason: string
  ): void {
    this.audit.write({
      kind: 'tool',
      session: surface.sessionId,
      tool: call.name,
      summary: call.name,
      result: 'denied',
      extra: {
        source: surface.source,
        denied: reason,
        ...(meta.capability === undefined ? {} : { capability: meta.capability }),
        ...(surface.taskId === undefined ? {} : { taskId: surface.taskId.slice(0, 12) }),
        ...(surface.taskGeneration === undefined
          ? {}
          : { taskGeneration: surface.taskGeneration })
      }
    })
  }

  /**
   * 在 handler 之前被拒绝时也把结构化结果交给任务运行时：
   * 任务需要立刻 blocked/waiting_user，而不是等模型自己结束本轮。
   */
  private notifyDenied(
    hooks: ToolExecutionHooks,
    call: ToolCallRequest,
    args: unknown,
    meta: ToolMeta,
    outcome: ToolOutcome
  ): boolean {
    if (hooks.onExecuted === undefined) return false
    const result = hooks.onExecuted({ callId: call.id, name: call.name, args, meta, outcome })
    return result?.abort === true
  }

  private async targetsFor(
    call: ToolCallRequest,
    surface: ToolSurface
  ): Promise<CapabilityTargets | undefined> {
    if (this.resolveCapabilityTargets === null) return undefined
    try {
      return await this.resolveCapabilityTargets(call, surface)
    } catch {
      // 解析器异常等同于“拿不到目标”，带约束的 grant 会拒绝。
      return undefined
    }
  }

  /**
   * 工具已返回正文后复验最终 URL。重定向到授权域名之外时，正文不能交给模型。
   * 只读回执文本本身也被替换为拒绝信息。
   */
  private finalTargetError(
    outcome: ToolOutcome,
    grant: CapabilityGrant | null
  ): string | null {
    const finalUrl = outcome.meta?.finalUrl
    if (finalUrl === undefined || grant === null) return null
    const domains = grant.constraints.domains
    if (domains === undefined || domains.length === 0) return null
    let host: string
    try {
      host = new URL(finalUrl).hostname
    } catch {
      return '无法验证重定向后的最终域名，已丢弃网页内容。'
    }
    return domainConstraintError(domains, [host])
  }

  private taskContextError(surface: ToolSurface): string | null {
    if (surface.source !== 'task') return null
    if (surface.taskId === undefined || surface.taskId === '') {
      return '任务来源缺少 taskId，不能执行动作。'
    }
    if (surface.taskGeneration === undefined) {
      return '任务来源缺少 generation，不能执行动作。'
    }
    if (
      this.isTaskRunnable !== null &&
      !this.isTaskRunnable(surface.taskId, surface.taskGeneration)
    ) {
      return '任务已暂停、取消或被用户接管；这个迟到的动作不会再执行。'
    }
    return null
  }

  private scopedGrantKey(risk: RiskAssessment, origin: ApprovalOrigin): string | undefined {
    if (risk.grantKey === undefined || risk.grantKey === '') return undefined
    // CUA 的输入授权在完整/快捷之间共享；普通工具按入口隔离。
    if (risk.sharedGrant === true) return risk.grantKey
    return origin === 'quick' ? `quick\u0000${risk.grantKey}` : risk.grantKey
  }

  private countRisk(level: RiskAssessment['level'], effective: 'auto' | 'ask'): void {
    if (effective === 'auto') {
      if (level === 'green') this.counters.autoGreen += 1
      else if (level === 'yellow') this.counters.autoYellow += 1
      return
    }
    if (level === 'green') this.counters.askGreen += 1
    else if (level === 'yellow') this.counters.askYellow += 1
    else this.counters.askRed += 1
  }

  /**
   * 模型选择 + 风险底线。红区永远 ask；forceAsk 先于模式与预算；
   * 黄区还受每小时自动操作预算限制。模型只能把自动升为 ask。
   */
  private effectiveApproval(
    risk: RiskAssessment,
    modelChoice: 'auto' | 'ask',
    scopedKey: string | undefined,
    taskAuto: boolean
  ): 'auto' | 'ask' {
    if (risk.level === 'red') return 'ask'
    if (risk.forceAsk === 'always') return 'ask'
    // 任务预授权只覆盖黄区；红区与 forceAsk:'always' 已在上面拦截。
    if (taskAuto) return 'auto'
    if (risk.forceAsk === 'until-grant' && (scopedKey === undefined || !this.gate.hasGrant(scopedKey))) {
      return 'ask'
    }
    if (risk.level === 'yellow' && this.autoOpsExhausted()) return 'ask'
    const mode = this.config.autonomy.approvalMode
    if (mode === 'auto') return 'auto'
    if (mode === 'strict') {
      if (risk.level === 'green' && !risk.sideEffect) {
        return modelChoice === 'ask' ? 'ask' : 'auto'
      }
      return 'ask'
    }
    return modelChoice === 'ask' ? 'ask' : 'auto'
  }

  private autoOpsExhausted(): boolean {
    const cutoff = this.clock.now() - AUTO_OP_WINDOW_MS
    while (this.autoOps.length > 0 && (this.autoOps[0] ?? 0) <= cutoff) this.autoOps.shift()
    return this.autoOps.length >= this.config.autonomy.maxAutoOpsPerHour
  }

  private recordAutoOp(): void {
    this.autoOps.push(this.clock.now())
    if (this.autoOps.length > 500) this.autoOps.splice(0, this.autoOps.length - 500)
  }

  private pushRunning(
    origin: ApprovalOrigin,
    name: string,
    hooks: ToolExecutionHooks
  ): void {
    this.running[origin] = [...this.running[origin], name]
    hooks.onRunningChange?.([...this.running[origin]])
  }

  private popRunning(
    origin: ApprovalOrigin,
    name: string,
    hooks: ToolExecutionHooks
  ): void {
    const next = [...this.running[origin]]
    const index = next.lastIndexOf(name)
    if (index >= 0) next.splice(index, 1)
    this.running[origin] = next
    hooks.onRunningChange?.([...next])
  }
}

function rejected(text: string): ToolExecutionResult {
  return { outcome: { text, failed: true }, endsTurn: false }
}

/** 旧名只返回规范提示；调用本身不会执行，也不会先执行再警告。 */
function hiddenNotVisibleText(name: string): string {
  return `[TOOL_NOT_VISIBLE] 旧入口 ${name} 不在本轮可见集合（已隐藏），本次未执行。${hiddenToolHint(name)}`
}

/**
 * 规范工具不在本次请求快照里：属于未加载组时给出 tools_load 下一步。
 * 快照缺失（直接调用执行器的宿主/测试）不做可见性限制。
 */
function visibilityError(
  name: string,
  exposure?: ToolRequestExposure
): string | null {
  if (exposure === undefined || exposure.names.has(name)) return null
  const groups = toolGroupsFor(name)
  if (groups.length > 0) {
    const list = groups.map((group) => `"${group}"`).join(',')
    return (
      `[TOOL_NOT_VISIBLE] ${name} 不在本轮可见集合，本次未执行。` +
      `它属于「${groups.join('、')}」组；如需使用，先调用 tools_load({"groups":[${list}]})，` +
      '下一轮模型请求生效后再调用。'
    )
  }
  return `[TOOL_NOT_VISIBLE] ${name} 不在本轮可见集合，本次未执行。`
}

/** 快捷聊天的 deniedTools 同时按规范名与旧操作身份生效，且不会放宽旧的拒绝。 */
function deniedText(
  name: string,
  operation: string,
  exposure?: ToolRequestExposure
): string | null {
  if (exposure === undefined) return null
  if (exposure.deniedNames?.has(name) === true) {
    return `[TOOL_DENIED] ${name} 已被本轮明确禁用`
  }
  if (exposure.deniedOperations?.has(operation) === true) {
    const alias = operation === name ? '' : `（操作身份 ${operation}）`
    return `[TOOL_DENIED] ${name}${alias} 已被本轮明确禁用`
  }
  return null
}

function capabilityTargetArgs(targets: CapabilityTargets | undefined): {
  targetPaths?: string[]
  targetApps?: string[]
  targetDomains?: string[]
} {
  if (targets === undefined) return {}
  return {
    ...(targets.paths === undefined ? {} : { targetPaths: targets.paths }),
    ...(targets.apps === undefined ? {} : { targetApps: targets.apps }),
    ...(targets.domains === undefined ? {} : { targetDomains: targets.domains })
  }
}

function desktopOwner(surface: ToolSurface) {
  if (surface.source === 'task') return 'task'
  if (surface.source === 'quick-chat') return 'quick-chat'
  if (surface.source === 'user-chat') return 'user-chat'
  return 'system'
}

function desktopPriority(surface: ToolSurface): 'user' | 'quick' | 'task' | 'system' {
  if (surface.source === 'task') return 'task'
  if (surface.source === 'quick-chat') return 'quick'
  if (surface.source === 'user-chat') return 'user'
  return 'system'
}

/** 合并工具停止信号与租约抢占信号；dispose 必须与 handler 同生命周期。 */
function mergeSignals(signals: AbortSignal[]): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const listeners: Array<() => void> = []
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    listeners.push(() => signal.removeEventListener('abort', onAbort))
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of listeners) remove()
    }
  }
}

/** 模型可在工具参数里放 `approval: 'ask'` 主动请求确认；未知值按 auto。 */
function modelApprovalChoice(args: unknown): 'auto' | 'ask' {
  if (args === null || typeof args !== 'object') return 'auto'
  return (args as Record<string, unknown>)['approval'] === 'ask' ? 'ask' : 'auto'
}

/** 读取并清洗模型写的审批请求；数组/原始值一律忽略。 */
function approvalAskArg(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  return sanitizeApprovalAsk((args as Record<string, unknown>)['approvalAsk'])
}

/**
 * 模型漏填时的宿主兜底：只保证气泡和卡片有一句中性请求，不冒充角色台词。
 * 不拼接 preview.title，避免把工具名或技术标题念成一句拟人化对白。
 */
function fallbackApprovalAsk(preview: ApprovalPreview): string {
  if (preview.kind === 'command') return '可以让我执行这条命令吗？'
  if (preview.kind === 'diff') return '可以让我改动这个文件吗？'
  return '可以让我继续这一步吗？'
}

/** 拒绝原因保持可读，同时把结构化代码放在固定位置，便于模型/日志分辨下一步。 */
function capabilityDeniedText(result: CapabilityCheckResult): string {
  const code = result.reasonCode === undefined ? '' : ` [${result.reasonCode}]`
  return `[CAPABILITY_DENIED]${code} ${result.reason ?? '已拒绝'}`
}

const DIAGNOSTIC_TEXT = /^[A-Za-z0-9._:-]{1,80}$/

function diagnosticText(value: unknown): string | undefined {
  return typeof value === 'string' && DIAGNOSTIC_TEXT.test(value) ? value : undefined
}

function diagnosticCount(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= 1_000_000_000
    ? Math.trunc(number)
    : undefined
}

/**
 * 把工具失败诊断收敛成固定键、固定类型的审计字段。
 *
 * 这里刻意不遍历原对象：只复制已知字段，因此调用方即使误传页面标题、
 * URL、正文或任意 meta，也不会进入 audit.jsonl。字符串还限制为短 ASCII
 * 标识，计数只保留整数。`attemptId` 缺省时用本次工具调用 id。
 */
export function sanitizeToolDiagnostics(
  value: ToolDiagnostics | undefined,
  fallbackAttemptId = ''
): Record<string, string | number | boolean> {
  if (value === undefined || value === null || typeof value !== 'object') return {}
  const out: Record<string, string | number | boolean> = {}
  const text: Array<[keyof ToolDiagnostics, string]> = [
    ['op', 'op'],
    ['stage', 'stage'],
    ['code', 'code'],
    ['rawCode', 'rawCode'],
    ['parseCode', 'parseCode'],
    ['commandId', 'commandId'],
    ['instanceId', 'instanceId'],
    ['extensionVersion', 'extVersion'],
    ['extensionBuildId', 'extBuild']
  ]
  for (const [field, key] of text) {
    const normalized = diagnosticText(value[field])
    if (normalized !== undefined) out[key] = normalized
  }
  const attempt = diagnosticText(value.attemptId) ?? diagnosticText(fallbackAttemptId)
  if (attempt !== undefined) out['attemptId'] = attempt
  const protocol = diagnosticCount(value.protocolVersion)
  if (protocol !== undefined) out['extProtocol'] = protocol
  const candidates = diagnosticCount(value.candidateCount)
  if (candidates !== undefined) out['candidates'] = candidates
  const rejected = diagnosticCount(value.rejectedCount)
  if (rejected !== undefined) out['rejected'] = rejected
  for (const [field, key] of [
    ['retryable', 'retryable'],
    ['cooldown', 'cooldown'],
    ['takenOver', 'takenOver']
  ] as const) {
    if (typeof value[field] === 'boolean') out[key] = value[field]
  }
  return out
}

function summaryFor(toolName: string, args: unknown): string {
  if (args !== null && typeof args === 'object') {
    const record = args as Record<string, unknown>
    for (const key of ['path', 'command', 'query', 'url', 'name']) {
      const value = record[key]
      if (typeof value === 'string') return `${toolName} ${key}=${truncate(value, 160)}`
    }
  }
  return toolName
}
