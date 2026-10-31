import { createHash, randomUUID } from 'node:crypto'
import type { AuditLog } from './audit'
import type { StateStore } from './state'
import type {
  ApprovalDecision,
  ApprovalOrigin,
  ApprovalPreview,
  ApprovalRequest,
  ApprovalRisk,
  ApprovalScope,
  Clock,
  Logger
} from './types'
import { systemClock } from './util'

export interface ApprovalInput {
  toolName: string
  summary: string
  preview: ApprovalPreview
  risk?: ApprovalRisk
  /** 风险分级（绿/黄/红），只用于审计，不展示给模型。 */
  riskLevel?: 'green' | 'yellow' | 'red'
  /** 模型主动选择的审批策略。 */
  modelChoice?: 'auto' | 'ask'
  /** 风险底线与模型选择合并后的实际决定。 */
  effective?: 'auto' | 'ask'
  /** 模型写的一句第一人称请求；只展示，不参与风险/授权判断。 */
  approvalAsk?: string
  sessionId: string
  /**
   * 稳定、不可逆的授权键（工具 + 根目录 + 命令前缀等）。
   * 只有黄区会提供；红区不提供，因此永远无法被会话/永久授权。
   */
  grantKey?: string
  /** 授权范围的人类可读说明，不会显示原始键。 */
  grantLabel?: string
  /** 是否允许“本会话”授权（默认 false）。 */
  sessionScoped?: boolean
  /** 是否允许“始终允许此类”授权（默认 false）。 */
  alwaysScoped?: boolean
  /** 审批来自完整聊天还是快捷聊天；默认 chat。 */
  origin?: ApprovalOrigin
  /** 覆盖本次“本会话”授权的有效期；CUA 用 30 分钟。 */
  grantTtlMs?: number
  /** “本会话”按钮的展示文案；CUA 用“30 分钟内”。 */
  sessionScopeLabel?: string
  /** 工具调用来源；任务/自主审批据此显示来源并支持撤销任务。 */
  source?: ApprovalRequest['source']
  taskId?: string
  taskTitle?: string
}

interface StoredGrant {
  /** sha256(grantKey)；不保存原始路径或命令。 */
  key: string
  tool: string
  scope: 'always'
  createdAt: number
  expiresAt: number | null
}

interface PendingEntry {
  request: ApprovalRequest
  resolve: (decision: ApprovalDecision) => void
  timer: NodeJS.Timeout
  hashedKey?: string
  allowSession: boolean
  allowAlways: boolean
  grantTtlMs?: number
  riskLevel?: 'green' | 'yellow' | 'red'
  modelChoice?: 'auto' | 'ask'
  effective?: 'auto' | 'ask'
}

const GRANT_STATE_KEY = 'approval.grants'
const DEFAULT_SESSION_GRANT_MINUTES = 480
const APPROVAL_ASK_MAX_CHARS = 60

const ASK_CONTROL_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const ASK_URL_RE = /https?:\/\/\S+/gi
const ASK_WRAPPING_QUOTES_RE = /^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g

/**
 * 审批请求文本的唯一收口：单行、无链接、无方向控制符、按码点限长。
 * 返回 undefined 表示没有可展示的请求，由宿主改用中性问法。
 */
export function sanitizeApprovalAsk(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let text = value
    .replace(ASK_CONTROL_RE, ' ')
    .replace(ASK_URL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(ASK_WRAPPING_QUOTES_RE, '')
    .trim()
  if (text === '') return undefined
  const chars = Array.from(text)
  if (chars.length > APPROVAL_ASK_MAX_CHARS) {
    text = `${chars.slice(0, APPROVAL_ASK_MAX_CHARS - 1).join('').trimEnd()}…`
  }
  return text === '' ? undefined : text
}

/**
 * 审批门（PLAN.md §2.5 / Phase 3）。
 *
 * - 队列按 createdAt 排序，聊天窗显示 1/N；
 * - TTL 到期自动拒绝；
 * - interrupt / 停止时 rejectAll；
 * - 黄区可“仅本次 / 本会话 / 始终允许此类”；红区只允许本次；
 * - 授权键只以 sha256 保存，状态文件里没有原始路径或命令；
 * - 同一授权键的并发请求合并为一次审批。
 */
export class ApprovalGate {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly pendingByKey = new Map<string, Promise<ApprovalDecision>>()
  private readonly sessionGrants = new Map<string, { tool: string; expiresAt: number }>()
  private readonly ttlMs: number
  private readonly sessionGrantsEnabled: boolean
  private readonly sessionGrantMinutes: number
  private readonly state: StateStore | null
  private readonly audit: AuditLog | null
  private readonly logger: Logger
  private readonly clock: Clock
  private requestListeners = new Set<(request: ApprovalRequest) => void>()
  private resolveListeners = new Set<(request: ApprovalRequest, decision: ApprovalDecision) => void>()
  private pendingListeners = new Set<(count: number) => void>()

  constructor(opts: {
    ttlMs: number
    sessionAllowExactCommand: boolean
    sessionGrantMinutes?: number
    state?: StateStore | null
    audit?: AuditLog | null
    logger: Logger
    clock?: Clock
  }) {
    this.ttlMs = opts.ttlMs
    this.sessionGrantsEnabled = opts.sessionAllowExactCommand
    this.sessionGrantMinutes = Math.max(5, opts.sessionGrantMinutes ?? DEFAULT_SESSION_GRANT_MINUTES)
    this.state = opts.state ?? null
    this.audit = opts.audit ?? null
    this.logger = opts.logger
    this.clock = opts.clock ?? systemClock
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /** 只统计某个入口的待审批数；完整聊天不能被快捷审批误判为“忙”。 */
  pendingCountFor(origin?: ApprovalOrigin): number {
    if (origin === undefined) return this.pending.size
    let count = 0
    for (const entry of this.pending.values()) {
      if (entry.request.origin === origin) count += 1
    }
    return count
  }

  list(origin?: ApprovalOrigin): ApprovalRequest[] {
    return [...this.pending.values()]
      .map((entry) => entry.request)
      .filter((request) => origin === undefined || request.origin === origin)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** forceAsk:'until-grant' 用：授权键当前是否仍被本会话/永久授权覆盖。 */
  hasGrant(grantKey: string): boolean {
    this.pruneGrants()
    return this.findGrant(hashKey(grantKey)) !== null
  }

  onRequest(listener: (request: ApprovalRequest) => void): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  onResolved(listener: (request: ApprovalRequest, decision: ApprovalDecision) => void): () => void {
    this.resolveListeners.add(listener)
    return () => this.resolveListeners.delete(listener)
  }

  onPendingChange(listener: (count: number) => void): () => void {
    this.pendingListeners.add(listener)
    return () => this.pendingListeners.delete(listener)
  }

  request(input: ApprovalInput): Promise<ApprovalDecision> {
    this.pruneGrants()
    const hashedKey =
      input.grantKey === undefined || input.grantKey === '' ? undefined : hashKey(input.grantKey)
    const allowSession =
      this.sessionGrantsEnabled && hashedKey !== undefined && input.sessionScoped === true
    const allowAlways =
      this.sessionGrantsEnabled && hashedKey !== undefined && input.alwaysScoped === true

    if (hashedKey !== undefined) {
      const existing = this.findGrant(hashedKey)
      if (existing !== null) {
        if (this.audit !== null) {
          this.audit.write({
            kind: 'approval',
            session: input.sessionId,
            tool: input.toolName,
            summary: input.summary,
            result: 'approved',
            approval: existing,
            extra: {
              grantScope: existing,
              risk: input.risk ?? 'medium',
              ...(input.riskLevel === undefined ? {} : { riskLevel: input.riskLevel }),
              ...(input.modelChoice === undefined ? {} : { modelChoice: input.modelChoice }),
              ...(input.effective === undefined ? {} : { effective: input.effective })
            }
          })
        }
        return Promise.resolve({
          approved: true,
          reason: existing === 'always' ? '始终允许此类操作' : '本会话已允许此类操作',
          grantScope: existing
        })
      }

      const inFlight = this.pendingByKey.get(hashedKey)
      if (inFlight !== undefined) return inFlight
    }

    const now = this.clock.now()
    const approvalAsk = sanitizeApprovalAsk(input.approvalAsk)
    const request: ApprovalRequest = {
      id: randomUUID(),
      toolName: input.toolName,
      summary: input.summary,
      preview: input.preview,
      risk: input.risk ?? 'medium',
      createdAt: now,
      expiresAt: now + this.ttlMs,
      sessionScoped: allowSession,
      alwaysScoped: allowAlways,
      ...(approvalAsk === undefined ? {} : { approvalAsk }),
      ...(input.grantLabel === undefined ? {} : { grantLabel: input.grantLabel }),
      ...(input.sessionScopeLabel === undefined
        ? {}
        : { sessionScopeLabel: input.sessionScopeLabel }),
      origin: input.origin ?? 'chat',
      sessionId: input.sessionId,
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.taskTitle === undefined ? {} : { taskTitle: input.taskTitle })
    }
    const promise = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(request.id, { approved: false, reason: '审批超时，已自动拒绝', grantScope: 'once' }, 'timeout')
      }, this.ttlMs)
      timer.unref?.()
      this.pending.set(request.id, {
        request,
        resolve,
        timer,
        ...(hashedKey === undefined ? {} : { hashedKey }),
        allowSession,
        allowAlways,
        ...(input.grantTtlMs === undefined ? {} : { grantTtlMs: input.grantTtlMs }),
        ...(input.riskLevel === undefined ? {} : { riskLevel: input.riskLevel }),
        ...(input.modelChoice === undefined ? {} : { modelChoice: input.modelChoice }),
        ...(input.effective === undefined ? {} : { effective: input.effective })
      })
      this.emitPending()
      for (const listener of this.requestListeners) {
        try {
          listener(request)
        } catch (error) {
          this.logger.warn('审批监听器异常', { error: String(error) })
        }
      }
    })
    if (hashedKey !== undefined && (allowSession || allowAlways)) {
      this.pendingByKey.set(hashedKey, promise)
      void promise.finally(() => {
        if (this.pendingByKey.get(hashedKey) === promise) this.pendingByKey.delete(hashedKey)
      })
    }
    return promise
  }

  resolve(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined) return false
    let scope: ApprovalScope = decision.grantScope ?? 'once'
    if (decision.approved) {
      if (scope === 'session' && !entry.allowSession) scope = 'once'
      if (scope === 'always' && !entry.allowAlways) scope = 'once'
      if (scope !== 'once' && entry.hashedKey !== undefined) {
        this.rememberGrant(entry.hashedKey, entry.request.toolName, scope, entry.grantTtlMs)
      }
    } else {
      scope = 'once'
    }
    this.finish(id, { ...decision, grantScope: scope }, decision.approved ? 'approved' : 'denied')
    return true
  }

  /** interrupt / 停止：拒绝所有 pending，并把原因回传给工具。 */
  rejectAll(reason: string): void {
    for (const id of [...this.pending.keys()]) {
      this.finish(id, { approved: false, reason, grantScope: 'once' }, 'aborted')
    }
  }

  /** 只拒绝某个入口的 pending；另一个聊天不受影响。 */
  rejectByOrigin(origin: ApprovalOrigin, reason: string): void {
    this.rejectMatching((request) => request.origin === origin, reason)
  }

  rejectMatching(predicate: (request: ApprovalRequest) => boolean, reason: string): void {
    for (const [id, entry] of [...this.pending.entries()]) {
      if (!predicate(entry.request)) continue
      this.finish(id, { approved: false, reason, grantScope: 'once' }, 'aborted')
    }
  }

  /** 设置页/诊断：只返回工具、范围与到期时间，不含授权键。 */
  listGrants(): Array<{ tool: string; scope: 'session' | 'always'; expiresAt: number | null }> {
    this.pruneGrants()
    const out: Array<{ tool: string; scope: 'session' | 'always'; expiresAt: number | null }> = []
    for (const grant of this.sessionGrants.values()) {
      out.push({ tool: grant.tool, scope: 'session', expiresAt: grant.expiresAt })
    }
    for (const grant of this.loadAlwaysGrants()) {
      out.push({ tool: grant.tool, scope: 'always', expiresAt: grant.expiresAt })
    }
    return out
  }

  clearGrants(): void {
    this.sessionGrants.clear()
    try {
      this.state?.set(GRANT_STATE_KEY, [])
    } catch {
      /* ignore */
    }
  }

  /** 切换 CUA 权限模式时清除旧的 cua_* 授权，避免旧 grant 绕过“每次都问”。 */
  clearGrantsForToolPrefix(prefix: string): void {
    for (const [key, grant] of [...this.sessionGrants.entries()]) {
      if (grant.tool.startsWith(prefix)) this.sessionGrants.delete(key)
    }
    const always = this.loadAlwaysGrants()
    const kept = always.filter((grant) => !grant.tool.startsWith(prefix))
    if (kept.length !== always.length) {
      try {
        this.state?.set(GRANT_STATE_KEY, kept)
      } catch {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------------

  private finish(
    id: string,
    decision: ApprovalDecision,
    result: 'approved' | 'denied' | 'timeout' | 'aborted',
    approvalKind: 'required' | 'session' | 'always' = 'required'
  ): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    this.pending.delete(id)
    if (entry.hashedKey !== undefined && this.pendingByKey.has(entry.hashedKey)) {
      // Promise 的 finally 会清理；这里提前删除避免新请求误合并到已结束的请求。
      this.pendingByKey.delete(entry.hashedKey)
    }
    this.emitPending()
    if (this.audit !== null) {
      this.audit.write({
        kind: 'approval',
        session: entry.request.sessionId,
        tool: entry.request.toolName,
        summary: entry.request.summary,
        result,
        approval: approvalKind,
        extra: {
          grantScope: decision.grantScope ?? 'once',
          risk: entry.request.risk,
          ...(entry.request.source === undefined ? {} : { source: entry.request.source }),
          ...(entry.request.taskId === undefined
            ? {}
            : { taskId: entry.request.taskId.slice(0, 12) }),
          ...(entry.riskLevel === undefined ? {} : { riskLevel: entry.riskLevel }),
          ...(entry.modelChoice === undefined ? {} : { modelChoice: entry.modelChoice }),
          ...(entry.effective === undefined ? {} : { effective: entry.effective })
        }
      })
    }
    for (const listener of this.resolveListeners) {
      try {
        listener(entry.request, decision)
      } catch {
        /* ignore */
      }
    }
    entry.resolve(decision)
  }

  private rememberGrant(
    hashedKey: string,
    tool: string,
    scope: Exclude<ApprovalScope, 'once'>,
    ttlMs?: number
  ): void {
    const now = this.clock.now()
    if (scope === 'session') {
      const ttl = ttlMs !== undefined && ttlMs > 0 ? ttlMs : this.sessionGrantMinutes * 60_000
      this.sessionGrants.set(hashedKey, {
        tool,
        expiresAt: now + ttl
      })
      return
    }
    const grants = this.loadAlwaysGrants().filter((grant) => grant.key !== hashedKey)
    grants.push({ key: hashedKey, tool, scope: 'always', createdAt: now, expiresAt: null })
    try {
      this.state?.set(GRANT_STATE_KEY, grants)
    } catch {
      this.logger.warn('永久授权保存失败')
    }
  }

  private findGrant(hashedKey: string): 'session' | 'always' | null {
    const session = this.sessionGrants.get(hashedKey)
    if (session !== undefined) {
      if (session.expiresAt > this.clock.now()) return 'session'
      this.sessionGrants.delete(hashedKey)
    }
    const always = this.loadAlwaysGrants().find((grant) => grant.key === hashedKey)
    if (always === undefined) return null
    if (always.expiresAt !== null && always.expiresAt <= this.clock.now()) return null
    return 'always'
  }

  private pruneGrants(): void {
    const now = this.clock.now()
    for (const [key, grant] of this.sessionGrants) {
      if (grant.expiresAt <= now) this.sessionGrants.delete(key)
    }
  }

  private loadAlwaysGrants(): StoredGrant[] {
    let raw: unknown
    try {
      raw = this.state?.get(GRANT_STATE_KEY)
    } catch {
      raw = undefined
    }
    if (!Array.isArray(raw)) return []
    const now = this.clock.now()
    const out: StoredGrant[] = []
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue
      const record = item as Partial<StoredGrant>
      if (typeof record.key !== 'string' || record.key.length !== 64) continue
      if (typeof record.tool !== 'string') continue
      if (record.scope !== 'always') continue
      const expiresAt =
        typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) ? record.expiresAt : null
      if (expiresAt !== null && expiresAt <= now) continue
      out.push({
        key: record.key,
        tool: record.tool,
        scope: 'always',
        createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
        expiresAt
      })
    }
    if (out.length !== raw.length) {
      try {
        this.state?.set(GRANT_STATE_KEY, out)
      } catch {
        /* ignore */
      }
    }
    return out
  }

  private emitPending(): void {
    const count = this.pending.size
    for (const listener of this.pendingListeners) {
      try {
        listener(count)
      } catch {
        /* ignore */
      }
    }
  }
}

function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}
