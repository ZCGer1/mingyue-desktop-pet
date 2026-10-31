import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import type { AppConfig } from '../shared/config'
import {
  effectiveExploration,
  isExplorationAppExcluded,
  isExplorationDomainExcluded,
  type EffectiveExploration
} from '../shared/exploration'
import { isPathInside } from '../shared/path'
import { normalizeProcessKey } from '../shared/processName'
import {
  explorationPathDenial,
  type ExplorationPathDenial
} from './explorationGuard'
import type { StateStore } from './state'
import type {
  CapabilityCheckInput,
  CapabilityCheckResult,
  CapabilityConstraints,
  CapabilityDenialCode,
  CapabilityGrant,
  CapabilityId,
  GrantScope,
  GrantSource,
  ToolSource
} from './capabilityTypes'
import { CAPABILITY_ACTIONS, CAPABILITY_LABELS } from './capabilityTypes'
import type { Logger } from './types'

const STATE_KEY = 'capability.grants'
/** 过期/撤销的 grant 再保留一天用于诊断，然后彻底删除。 */
const REVOKED_GRACE_MS = 24 * 60 * 60_000
/**
 * 自主轮没有任务上下文，但允许只读/搜索类动作；这些动作不会改变外部状态，
 * 且对应 World 的开关/同意仍由配置与 World 自己把关。
 */
const AUTONOMY_READ_ACTIONS: ReadonlySet<string> = new Set([
  'page_current',
  'web_search',
  'web_fetch'
])
/** 只读桌面观察工具；不含任何输入动作。 */
const DESKTOP_OBSERVE_TOOLS: ReadonlySet<string> = new Set([
  'win_list',
  'win_read',
  'win_capture',
  'win_elements',
  'computer_observe',
  'computer_find'
])
/** 需要窗口级范围/身份复验的工具。 */
const WINDOW_TOOLS: ReadonlySet<string> = new Set([
  'win_list',
  'win_read',
  'win_capture',
  'win_elements',
  'win_focus',
  'win_act',
  'computer_observe',
  'computer_find',
  'computer_act'
])
/** 需要整屏授权与截屏同意的工具。 */
const FULL_SCREEN_OBSERVE_TOOLS: ReadonlySet<string> = new Set([
  'cua_screenshot',
  'cua_zoom',
  'screen_observe'
])
/** 以“应用”为目标、可由类别授权放行的动作。 */
const APP_TARGET_TOOLS: ReadonlySet<string> = new Set([
  'sys_open_app',
  'apps_launch',
  'apps_focus',
  'apps_wait'
])

/**
 * 旧动作名到等价规范动作的授权别名。只登记一对一替代，例如旧整屏截图
 * 放行 screen_observe；不能把 win_read 之类映射到整个 computer_observe，
 * 否则旧授权会被拓宽到未批准的模式。
 */
const GRANT_ACTION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  screen_observe: ['cua_screenshot']
}

function grantActionsAllow(actions: readonly string[], action: string): boolean {
  if (actions.includes(action)) return true
  return (GRANT_ACTION_ALIASES[action] ?? []).some((alias) => actions.includes(alias))
}

export interface CapabilityStoreOptions {
  state: StateStore
  logger: Logger
  now?: () => number
  /** 检查桌面能力时读取当前 CUA 同意状态；不传则不额外限制。 */
  getConfig?: () => AppConfig
  /**
   * 主进程统一的有效读取根（工作区/笔记/信任目录/显式目录/个人目录/卷）。
   * 提供时，自主路径复验直接用它，不再由本类重新拼范围。
   */
  resolveReadRoots?: () => readonly string[]
  /** @deprecated 旧的非系统卷根；仅在未提供 resolveReadRoots 时使用。 */
  resolveVolumeRoots?: () => readonly string[]
  /** 明确允许编辑的根；不与自动发现的只读卷混用。 */
  resolveEditRoots?: () => readonly string[]
}

interface ScopedDenial {
  message: string
  code: CapabilityDenialCode
}

export interface IssueGrantInput {
  capability: CapabilityId
  scope: GrantScope
  source: GrantSource
  taskId?: string | null
  actions?: string[]
  constraints?: CapabilityConstraints
  ttlMs?: number | null
  autoApproveYellow?: boolean
}

/**
 * 能力授权的铸造、检查、复验与撤销。
 *
 * 授权存储只保存能力、工具名、任务 id 与时间，不含截图、窗口标题、
 * 输入文字或页面正文。检查永远以「当前时间 + 当前任务 id」重新计算，
 * 不复用调用方缓存的判断。
 */
export class CapabilityStore {
  private readonly state: StateStore
  private readonly logger: Logger
  private readonly now: () => number
  private readonly getConfig: (() => AppConfig) | null
  private readonly resolveReadRoots: (() => readonly string[]) | null
  private readonly resolveVolumeRoots: (() => readonly string[]) | null
  private readonly resolveEditRoots: (() => readonly string[]) | null

  constructor(options: CapabilityStoreOptions) {
    this.state = options.state
    this.logger = options.logger
    this.now = options.now ?? (() => Date.now())
    this.getConfig = options.getConfig ?? null
    this.resolveReadRoots = options.resolveReadRoots ?? null
    this.resolveVolumeRoots = options.resolveVolumeRoots ?? null
    this.resolveEditRoots = options.resolveEditRoots ?? null
  }

  list(now = this.now()): CapabilityGrant[] {
    return this.load()
      .filter(
        (grant) =>
          grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > now)
      )
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  listForTask(taskId: string): CapabilityGrant[] {
    return this.load().filter((grant) => grant.taskId === taskId && grant.revokedAt === null)
  }

  get(id: string): CapabilityGrant | undefined {
    return this.load().find((grant) => grant.id === id)
  }

  issue(input: IssueGrantInput): CapabilityGrant {
    const now = this.now()
    if (input.scope === 'task' && (input.taskId === undefined || input.taskId === null || input.taskId === '')) {
      throw new Error('task scope 授权必须绑定 taskId')
    }
    const actions = (input.actions ?? CAPABILITY_ACTIONS[input.capability]).filter(
      (name) => typeof name === 'string' && name !== ''
    )
    const grant: CapabilityGrant = {
      id: randomUUID(),
      capability: input.capability,
      scope: input.scope,
      source: input.source,
      actions: [...new Set(actions)],
      constraints: { ...(input.constraints ?? {}) },
      createdAt: now,
      expiresAt:
        input.ttlMs === undefined || input.ttlMs === null
          ? null
          : now + Math.max(0, Math.round(input.ttlMs)),
      revokedAt: null,
      taskId: input.taskId ?? null,
      revision: 1,
      usedActions: 0,
      autoApproveYellow: input.autoApproveYellow === true
    }
    const grants = this.load()
    grants.push(grant)
    this.persist(grants)
    this.logger.info('已铸造能力授权', {
      capability: grant.capability,
      scope: grant.scope,
      taskId: grant.taskId === null ? null : grant.taskId.slice(0, 12),
      actions: grant.actions.length
    })
    return clone(grant)
  }

  /** 按当前来源、动作、任务与时间重新判断资格。 */
  check(input: CapabilityCheckInput): CapabilityCheckResult {
    if (input.source === 'autonomy') {
      return this.checkAutonomy(input)
    }

    if (input.source === 'user-chat' || input.source === 'quick-chat') {
      return this.checkUserPresent(input)
    }

    if (input.source === 'task') {
      return this.checkTask(input)
    }

    return denied('未知的工具来源，已拒绝')
  }

  /** 已通过审批后、真正执行前的复验；条件和 check 完全一致。 */
  revalidate(input: CapabilityCheckInput): CapabilityCheckResult {
    return this.check(input)
  }

  /**
   * 任务预授权是否允许黄区动作免问。只看任务 grant；
   * 红区永远不经过这里，`forceAsk:'always'` 由 RiskPolicy 先拦截。
   */
  autoApprovesYellow(input: {
    taskId: string | undefined
    action: string
    targetPaths?: string[]
    targetApps?: string[]
    targetDomains?: string[]
    now?: number
  }): CapabilityGrant | null {
    if (input.taskId === undefined || input.taskId === '') return null
    const now = input.now ?? this.now()
    const check: CapabilityCheckInput = {
      capability: 'desktop.observe',
      action: input.action,
      source: 'task',
      taskId: input.taskId,
      now,
      ...(input.targetPaths === undefined ? {} : { targetPaths: input.targetPaths }),
      ...(input.targetApps === undefined ? {} : { targetApps: input.targetApps }),
      ...(input.targetDomains === undefined ? {} : { targetDomains: input.targetDomains })
    }
    const grant = this.load().find(
      (entry) =>
        entry.taskId === input.taskId &&
        entry.source === 'task-preauthorization' &&
        entry.autoApproveYellow &&
        entry.revokedAt === null &&
        (entry.expiresAt === null || entry.expiresAt > now) &&
        grantActionsAllow(entry.actions, input.action) &&
        this.constraintError(entry, check) === null
    )
    return grant === undefined ? null : clone(grant)
  }

  /**
   * 动作执行前预占一次配额并持久化。失败也计入尝试，避免重试越过上限。
   * 返回 false 表示 grant 已失效/撤销或配额已耗尽，调用方必须拒绝执行。
   */
  consume(grantId: string, now = this.now()): boolean {
    const grants = this.load()
    const grant = grants.find((entry) => entry.id === grantId)
    if (grant === undefined || grant.revokedAt !== null) return false
    if (grant.expiresAt !== null && grant.expiresAt <= now) return false
    const max = grant.constraints.maxActions
    if (max !== undefined) {
      if (typeof max !== 'number' || !Number.isFinite(max) || max < 0) return false
      if (grant.usedActions >= max) return false
    }
    grant.usedActions += 1
    grant.revision += 1
    this.persist(grants)
    return true
  }

  revoke(id: string): boolean {
    const grants = this.load()
    const grant = grants.find((entry) => entry.id === id)
    if (grant === undefined || grant.revokedAt !== null) return false
    grant.revokedAt = this.now()
    grant.revision += 1
    this.persist(grants)
    return true
  }

  /** 撤销一个任务的全部授权；返回撤销数量。 */
  revokeTask(taskId: string): number {
    const grants = this.load()
    let count = 0
    for (const grant of grants) {
      if (grant.taskId !== taskId || grant.revokedAt !== null) continue
      grant.revokedAt = this.now()
      grant.revision += 1
      count += 1
    }
    if (count > 0) this.persist(grants)
    return count
  }

  revokeAll(): number {
    const grants = this.load()
    let count = 0
    for (const grant of grants) {
      if (grant.revokedAt !== null) continue
      grant.revokedAt = this.now()
      grant.revision += 1
      count += 1
    }
    if (count > 0) this.persist(grants)
    return count
  }

  /** 清理过期/撤销超过保留期/所属任务已不再活跃的授权。 */
  prune(now = this.now(), activeTaskIds: ReadonlySet<string> | null = null): void {
    const grants = this.load()
    const kept = grants.filter((grant) => {
      const expired = grant.expiresAt !== null && grant.expiresAt + REVOKED_GRACE_MS <= now
      const revoked = grant.revokedAt !== null && grant.revokedAt + REVOKED_GRACE_MS <= now
      const taskGone =
        activeTaskIds !== null && grant.taskId !== null && !activeTaskIds.has(grant.taskId)
      return !expired && !revoked && !taskGone
    })
    if (kept.length !== grants.length) this.persist(kept)
  }

  /** 诊断/UI：不包含授权键、参数或窗口内容。 */
  view(): Array<{
    id: string
    capability: CapabilityId
    scope: GrantScope
    source: GrantSource
    actions: string[]
    taskId: string | null
    createdAt: number
    expiresAt: number | null
    usedActions: number
    maxActions: number | null
    autoApproveYellow: boolean
  }> {
    return this.list().map((grant) => ({
      id: grant.id,
      capability: grant.capability,
      scope: grant.scope,
      source: grant.source,
      actions: [...grant.actions],
      taskId: grant.taskId,
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt,
      usedActions: grant.usedActions,
      maxActions:
        typeof grant.constraints.maxActions === 'number' ? grant.constraints.maxActions : null,
      autoApproveYellow: grant.autoApproveYellow
    }))
  }

  // ------------------------------------------------------------------

  /**
   * 自主来源不再要求「用户先创建任务」。它使用和聊天/任务完全相同的
   * 有效授权：自由探索总开关 + 对应子范围 + World 自身开关/同意。
   * 真正的用户边界仍然保留：终端、删除、长期记忆不由探索授权放行。
   */
  private checkAutonomy(input: CapabilityCheckInput): CapabilityCheckResult {
    // 网页只读不需要探索授权：它仍受 Web/BrowserPage World 的开关约束。
    if (input.capability === 'web.read' && AUTONOMY_READ_ACTIONS.has(input.action)) {
      return { allowed: true }
    }
    if (input.capability === 'terminal.run') {
      return denied(
        '自主唤醒不能运行终端命令；这需要用户在场并明确决定。',
        'unsupported-autonomy-action'
      )
    }
    if (input.capability === 'workspace.delete') {
      return denied(
        '自主唤醒不能删除文件；不可逆删除/大范围覆盖需要用户明确决定。',
        'unsupported-autonomy-action'
      )
    }
    if (input.capability === 'memory.write') {
      return denied('自主唤醒不能直接写长期记忆。', 'unsupported-autonomy-action')
    }

    const config = this.getConfig?.()
    if (config === undefined) return denied('当前配置不可用，已拒绝。', 'policy-denied')
    const view = effectiveExploration(config, input.now)
    if (!view.active) {
      return denied(
        '自由探索未开启，或本会话授权已到期。请用户在设置 → 自由探索中授权；不需要先创建任务。',
        'grant-expired'
      )
    }

    switch (input.capability) {
      case 'browser.control': {
        if (!view.browserTabs) {
          return denied(
            '自由探索里的「她自己的浏览器标签」未开启，已拒绝。',
            'grant-expired'
          )
        }
        if (input.action === 'browser_download') {
          if (!view.artifacts) {
            return denied('作品/下载空间未开启，不能下载文件。', 'grant-expired')
          }
          const pathError = this.explorationPathScopeError(input, view)
          if (pathError !== null) return denied(pathError.message, pathError.code)
        }
        const excluded = this.excludedDomainError(view, input.action, input.targetDomains)
        if (excluded !== null) return denied(excluded, 'excluded-target')
        return { allowed: true }
      }
      case 'bilibili.read': {
        // API 路线不借用 browserTabs，但必须有自己的开关和新同意；旧的
        // 浏览器扩展同意不能替代这里的判断。
        if (!config.worlds.bilibili.enabled) {
          return denied('B 站 API 阅读未启用，已拒绝。', 'grant-expired')
        }
        if (config.worlds.bilibili.consentAt === null) {
          return denied(
            'B 站 API 阅读缺少新的用户同意；请先在设置页确认启用并扫码登录。',
            'grant-expired'
          )
        }
        const excluded = this.excludedDomainError(view, input.action, input.targetDomains)
        if (excluded !== null) return denied(excluded, 'excluded-target')
        return { allowed: true }
      }
      case 'file.read':
      case 'file.write':
      case 'workspace.write': {
        const pathError = this.explorationPathScopeError(input, view)
        if (pathError !== null) return denied(pathError.message, pathError.code)
        return { allowed: true }
      }
      case 'desktop.observe': {
        if (FULL_SCREEN_OBSERVE_TOOLS.has(input.action)) {
          if (!view.fullScreen) {
            return denied(
              '整屏观察未开启。窗口观察与整屏观察是两份额外决定。',
              'grant-expired'
            )
          }
          const missing = this.desktopPrecondition(input.capability, input.action, view, config)
          return missing === null
            ? { allowed: true }
            : denied(missing, 'desktop-disabled')
        }
        if (!DESKTOP_OBSERVE_TOOLS.has(input.action)) {
          return denied(
            `自主唤醒没有「${CAPABILITY_LABELS[input.capability]}」的有效范围，已拒绝。`,
            'unsupported-autonomy-action'
          )
        }
        if (!view.windows && !view.apps) {
          return denied('窗口观察未开启，已拒绝。', 'grant-expired')
        }
        const missing = this.desktopPrecondition(input.capability, input.action, view, config)
        if (missing !== null) return denied(missing, 'desktop-disabled')
        const scope = this.windowScopeError(input, view, config)
        if (scope !== null) return denied(scope.message, scope.code)
        const excluded = this.excludedAppError(view, input.targetApps)
        return excluded === null ? { allowed: true } : denied(excluded, 'excluded-target')
      }
      case 'desktop.input': {
        if (!view.apps) {
          return denied('普通应用操作未开启，已拒绝。', 'grant-expired')
        }
        const missing = this.desktopPrecondition(input.capability, input.action, view, config)
        if (missing !== null) return denied(missing, 'desktop-disabled')
        const scope = this.windowScopeError(input, view, config)
        if (scope !== null) return denied(scope.message, scope.code)
        const excluded = this.excludedAppError(view, input.targetApps)
        return excluded === null ? { allowed: true } : denied(excluded, 'excluded-target')
      }
      case 'app.launch': {
        if (!view.apps) {
          return denied('普通应用发现/启动未开启，已拒绝。', 'grant-expired')
        }
        if (APP_TARGET_TOOLS.has(input.action)) {
          if (input.targetApps === undefined || input.targetApps.length === 0) {
            return denied(
              '无法确认这次要启动/切换的应用，已拒绝。',
              'target-resolution-missing'
            )
          }
          const excluded = this.excludedAppError(view, input.targetApps)
          return excluded === null ? { allowed: true } : denied(excluded, 'excluded-target')
        }
        if (input.action === 'apps_list' || input.action === 'apps_find') {
          return { allowed: true }
        }
        if (input.action === 'sys_open_url') {
          const excluded = this.excludedDomainError(view, input.action, input.targetDomains)
          if (excluded !== null) return denied(excluded, 'excluded-target')
          if (input.targetDomains === undefined || input.targetDomains.length === 0) {
            return denied('无法确认链接目标，已拒绝。', 'target-resolution-missing')
          }
          return { allowed: true }
        }
        if (input.action === 'sys_open_path') {
          const pathError = this.explorationPathScopeError(input, view)
          return pathError === null
            ? { allowed: true }
            : denied(pathError.message, pathError.code)
        }
        return denied(
          `自主唤醒没有「${CAPABILITY_LABELS[input.capability]}」的有效范围，已拒绝。`,
          'unsupported-autonomy-action'
        )
      }
      default:
        return denied(
          `自主唤醒没有「${CAPABILITY_LABELS[input.capability]}」的有效授权，已拒绝。`,
          'unsupported-autonomy-action'
        )
    }
  }

  private explorationPathScopeError(
    input: CapabilityCheckInput,
    view: EffectiveExploration
  ): ExplorationPathDenial | null {
    return explorationPathDenial({
      capability: input.capability,
      action: input.action,
      targetPaths: input.targetPaths,
      view,
      profileRoot: homedir(),
      // 与 FilesWorld/任务 grant 共用同一个 FileScopeResolver 结果。
      ...(this.resolveReadRoots === null
        ? { volumeRoots: this.resolveVolumeRoots?.() ?? [] }
        : { readRoots: this.resolveReadRoots() }),
      // 编辑范围独立于只读范围；未传时退回 view.readRoots（旧语义）。
      ...(this.resolveEditRoots === null ? {} : { editRoots: this.resolveEditRoots() })
    })
  }

  private excludedAppError(
    view: EffectiveExploration,
    targets: readonly string[] | undefined
  ): string | null {
    if (targets === undefined) return null
    for (const target of targets) {
      if (isExplorationAppExcluded(view, target)) {
        return '这个应用在用户的排除名单里，不能自动打开或操作。'
      }
    }
    return null
  }

  private excludedDomainError(
    view: EffectiveExploration,
    action: string,
    targets: readonly string[] | undefined
  ): string | null {
    if (view.excludedDomains.length === 0) return null
    if (targets === undefined || targets.length === 0) {
      // 导航类动作在没有可验证域名时不能假装排除规则不存在。
      if (action === 'browser_navigate' || action === 'sys_open_url') {
        return '无法确认这次导航的域名是否在排除名单内，已拒绝。'
      }
      return null
    }
    for (const target of targets) {
      if (isExplorationDomainExcluded(view, target)) {
        return '这个站点在用户的排除名单里，不能自动访问。'
      }
    }
    return null
  }

  /**
   * 只有会截图/看屏幕的动作才需要截图同意与视觉输入。
   * 窗口清单与 UIA 文本只依赖用户显式配置的桌面范围，不能被“未开 CUA”误伤。
   * 自由探索的窗口/整屏子范围是一次集中、明确的选择，可替代旧的逐次同意。
   */
  private desktopPrecondition(
    capability: CapabilityId,
    action: string,
    view: EffectiveExploration | null = null,
    config: AppConfig | null = null
  ): string | null {
    if (capability !== 'desktop.observe' && capability !== 'desktop.input') return null
    const needsCua =
      action.startsWith('cua_') ||
      action === 'win_capture' ||
      FULL_SCREEN_OBSERVE_TOOLS.has(action)
    if (!needsCua) return null
    const cfg = config ?? this.getConfig?.()
    if (cfg === undefined) return null
    const cua = cfg.worlds.cua
    if (action === 'win_capture') {
      if (view !== null && view.active && (view.windows || view.fullScreen)) {
        if (!cfg.worlds.desktop.windowCapture) return '按窗口截图已关闭。'
        if (cfg.provider.visionInput !== true) return '模型图片输入已关闭，无法查看窗口截图。'
        return null
      }
    } else if (FULL_SCREEN_OBSERVE_TOOLS.has(action)) {
      if (view !== null && view.active && view.fullScreen) {
        if (!cua.enabled) return '电脑截图后端未开启。'
        if (cfg.provider.visionInput !== true) return '模型图片输入已关闭，无法查看屏幕。'
        return null
      }
    }
    if (
      !cua.enabled ||
      typeof cua.consentAt !== 'number' ||
      typeof cua.screenConsentAt !== 'number' ||
      cfg.provider.visionInput !== true
    ) {
      return '电脑操作未开启，或缺少键鼠/截图授权。'
    }
    return null
  }

  /**
   * 窗口工具只能看到用户显式加入观察范围的应用。
   * win_list 没有具体目标：只要范围内至少有一个 observe 应用即可。
   */
  private windowScopeError(
    input: CapabilityCheckInput,
    view: EffectiveExploration | null = null,
    config: AppConfig | null = null
  ): ScopedDenial | null {
    if (!WINDOW_TOOLS.has(input.action)) return null
    const cfg = config ?? this.getConfig?.()
    if (cfg === undefined) {
      return { code: 'window-scope-missing', message: '桌面观察范围不可用，已拒绝。' }
    }
    const desktop = cfg.worlds.desktop
    const category = view !== null && view.active && (view.windows || view.apps)
    const observeApps = desktop.apps.filter((app) => app.observe)
    if (observeApps.length === 0 && !category) {
      return {
        code: 'window-scope-missing',
        message: '桌面观察范围为空。请先在设置里逐应用加入，或开启自由探索的窗口/应用范围。'
      }
    }
    // 窗口清单/跨窗口查找没有具体目标：只要类别授权或至少一个 observe 应用即可。
    if (
      input.action === 'win_list' ||
      ((input.action === 'computer_observe' || input.action === 'computer_find') &&
        (input.targetApps === undefined || input.targetApps.length === 0))
    ) {
      return null
    }
    const targets = input.targetApps
    if (targets === undefined || targets.length === 0) {
      return {
        code: 'target-resolution-missing',
        message: '无法确认这次动作对应的窗口应用，已拒绝。'
      }
    }
    if (
      (input.action === 'win_read' ||
        input.action === 'win_elements' ||
        input.action === 'computer_observe' ||
        input.action === 'computer_find') &&
      !desktop.structuredText
    ) {
      return { code: 'desktop-disabled', message: '结构化文本观察已关闭。' }
    }
    if (input.action === 'win_capture' && !desktop.windowCapture) {
      return { code: 'desktop-disabled', message: '按窗口截图已关闭。' }
    }
    if ((input.action === 'win_act' || input.action === 'computer_act') && !desktop.structuredText) {
      return {
        code: 'desktop-disabled',
        message: '结构化控件操作需要开启 UIA 文本观察。'
      }
    }
    for (const raw of targets) {
      const key = normalizeProcessKey(raw)
      if (key === null) {
        return { code: 'target-resolution-missing', message: '窗口应用名无效，已拒绝。' }
      }
      if (view !== null && isExplorationAppExcluded(view, key)) {
        return {
          code: 'excluded-target',
          message: '这个应用在用户的排除名单里，不能自动观察或操作。'
        }
      }
      if (!category) {
        const app = observeApps.find((entry) => entry.process === key)
        if (app === undefined) {
          return {
            code: 'window-scope-missing',
            message: `应用「${key}」不在桌面观察范围内，已拒绝。`
          }
        }
        if (
          (input.action === 'win_focus' ||
            input.action === 'win_act' ||
            input.action === 'computer_act') &&
          !app.input
        ) {
          return {
            code: 'window-scope-missing',
            message: `应用「${key}」没有开启输入权限，不能聚焦或操作。`
          }
        }
      }
    }
    return null
  }

  private checkUserPresent(input: CapabilityCheckInput): CapabilityCheckResult {
    const config = this.getConfig?.() ?? null
    const view =
      config === null ? null : effectiveExploration(config, input.now)
    const missing = this.desktopPrecondition(input.capability, input.action, view, config)
    if (missing !== null) return denied(missing)
    // 用户聊天与自主使用同一份活动范围：显式 observe 应用，或自由探索的
    // 窗口/应用类别授权。用户直接请求时排除名单仍可拦截自动路径。
    const scope = this.windowScopeError(input, view, config)
    if (scope !== null) return denied(scope.message, scope.code)
    return { allowed: true }
  }

  private checkTask(input: CapabilityCheckInput): CapabilityCheckResult {
    if (input.taskId === undefined || input.taskId === '') {
      return denied('任务来源缺少 taskId，不能执行有权限要求的动作。')
    }
    // 任务授权不能绕过 CUA 的全局开关/双重同意：用户关闭电脑操作后，
    // 已存在的任务 grant 也必须立即失效。
    const config = this.getConfig?.() ?? null
    const view =
      config === null ? null : effectiveExploration(config, input.now)
    const missing = this.desktopPrecondition(input.capability, input.action, view, config)
    if (missing !== null) return denied(missing)
    // 桌面范围在任务运行期间也可能被缩小/关闭；每次执行都按当前配置复核。
    const scope = this.windowScopeError(input, view, config)
    if (scope !== null) return denied(scope.message, scope.code)
    const grant = this.load().find(
      (entry) =>
        entry.taskId === input.taskId &&
        entry.capability === input.capability &&
        entry.revokedAt === null &&
        (entry.expiresAt === null || entry.expiresAt > input.now) &&
        grantActionsAllow(entry.actions, input.action)
    )
    if (grant === undefined) {
      return denied(
        `任务没有「${CAPABILITY_LABELS[input.capability]}」的有效授权（或已过期/撤销），已停止。`,
        'grant-expired'
      )
    }
    const constraint = this.constraintError(grant, input)
    if (constraint !== null) return denied(constraint.message, constraint.code)
    return { allowed: true, grant: clone(grant) }
  }

  /**
   * grant 约束全部 fail closed：路径必须落在 roots 内，应用必须命中
   * appAllowlist，域名必须精确或点边子域命中；任一目标缺失都拒绝。
   * maxActions 在 consume() 里按预占次数检查。
   */
  private constraintError(
    grant: CapabilityGrant,
    input: CapabilityCheckInput
  ): ScopedDenial | null {
    const roots = grant.constraints.pathRoots
    if (roots !== undefined && roots.length > 0) {
      const targetPaths = input.targetPaths
      if (targetPaths === undefined || targetPaths.length === 0) {
        return {
          code: 'target-resolution-missing',
          message: '该授权限定了目标目录，但本次动作没有可验证的目标路径，已拒绝。'
        }
      }
      for (const root of roots) {
        if (typeof root !== 'string' || root.trim() === '' || !isAbsolute(root)) {
          return {
            code: 'policy-denied',
            message: '授权中的目标目录无效，已拒绝本次动作。'
          }
        }
      }
      for (const target of targetPaths) {
        if (typeof target !== 'string' || target.trim() === '' || !isAbsolute(target)) {
          return {
            code: 'target-resolution-missing',
            message: '本次动作的目标路径无效，已拒绝。'
          }
        }
        if (!roots.some((root) => isPathInside(root, target))) {
          return {
            code: 'path-outside-scope',
            message: '本次动作的目标不在任务授权目录内，已拒绝。'
          }
        }
      }
    }

    const max = grant.constraints.maxActions
    if (max !== undefined) {
      if (typeof max !== 'number' || !Number.isFinite(max) || max < 0) {
        return { code: 'policy-denied', message: '授权中的动作次数上限无效，已拒绝。' }
      }
      if (grant.usedActions >= max) {
        return {
          code: 'policy-denied',
          message: '这个授权的动作次数已用完。请先结束任务，让用户决定下一步。'
        }
      }
    }

    const appAllowlist = grant.constraints.appAllowlist
    if (appAllowlist !== undefined && appAllowlist.length > 0) {
      const allowed = new Set<string>()
      for (const entry of appAllowlist) {
        const key = normalizeProcessKey(entry)
        // 授权数据损坏时 fail closed，绝不忽略坏条目。
        if (key === null) {
          return { code: 'policy-denied', message: '授权中的应用范围无效，已拒绝。' }
        }
        allowed.add(key)
      }
      if (
        input.action === 'win_list' ||
        ((input.action === 'computer_observe' || input.action === 'computer_find') &&
          (input.targetApps === undefined || input.targetApps.length === 0))
      ) {
        // 清单/跨窗口查找没有具体应用：显式观察范围内至少有一个交集；
        // 自由探索的类别授权已经替代逐应用列表，此时只要求授权本身非空。
        const config = this.getConfig?.()
        const view = config === undefined ? null : effectiveExploration(config, input.now)
        const category = view !== null && view.active && (view.windows || view.apps)
        if (!category) {
          const observing = new Set(
            (config?.worlds.desktop.apps ?? [])
              .filter((app) => app.observe)
              .map((app) => app.process)
          )
          const any = [...allowed].some((key) => observing.has(key))
          if (!any) {
            return {
              code: 'window-scope-missing',
              message: '桌面观察范围内没有该授权允许的应用，已拒绝。'
            }
          }
        }
      } else {
        const targets = input.targetApps
        if (targets === undefined || targets.length === 0) {
          return {
            code: 'target-resolution-missing',
            message: '该授权限定了应用范围，但本次动作没有可验证的目标应用，已拒绝。'
          }
        }
        for (const raw of targets) {
          const key = normalizeProcessKey(raw)
          if (key === null || !allowed.has(key)) {
            return {
              code: 'window-scope-missing',
              message: '本次动作的目标应用不在任务授权范围内，已拒绝。'
            }
          }
        }
      }
    }

    const domainError = domainConstraintError(
      grant.constraints.domains,
      input.targetDomains
    )
    if (domainError === null) return null
    return {
      code:
        input.targetDomains === undefined || input.targetDomains.length === 0
          ? 'target-resolution-missing'
          : 'domain-outside-scope',
      message: domainError
    }
  }

  private load(): CapabilityGrant[] {
    let raw: unknown
    try {
      raw = this.state.get(STATE_KEY)
    } catch {
      raw = undefined
    }
    if (!Array.isArray(raw)) return []
    const out: CapabilityGrant[] = []
    for (const item of raw) {
      const grant = parseGrant(item)
      if (grant !== null) out.push(grant)
    }
    return out
  }

  private persist(grants: CapabilityGrant[]): void {
    try {
      this.state.set(STATE_KEY, grants)
    } catch (error) {
      this.logger.error('能力授权保存失败', { error: String(error).slice(0, 200) })
    }
  }
}

function denied(reason: string, reasonCode?: CapabilityDenialCode): CapabilityCheckResult {
  return {
    allowed: false,
    code: 'CAPABILITY_DENIED',
    ...(reasonCode === undefined ? {} : { reasonCode }),
    reason
  }
}

function clone(grant: CapabilityGrant): CapabilityGrant {
  return {
    ...grant,
    actions: [...grant.actions],
    constraints: { ...grant.constraints }
  }
}

function parseGrant(raw: unknown): CapabilityGrant | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (typeof record['id'] !== 'string' || record['id'] === '') return null
  const capability = record['capability']
  if (!(typeof capability === 'string') || !(capability in CAPABILITY_ACTIONS)) return null
  const scope = record['scope']
  if (scope !== 'turn' && scope !== 'task' && scope !== 'session' && scope !== 'always') {
    return null
  }
  const times = ['createdAt', 'expiresAt', 'revokedAt']
  for (const key of times) {
    const value = record[key]
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) return null
  }
  const taskId = record['taskId']
  if (taskId !== null && typeof taskId !== 'string') return null
  const actions = Array.isArray(record['actions'])
    ? record['actions'].filter((entry): entry is string => typeof entry === 'string')
    : []
  const constraints =
    record['constraints'] !== null &&
    typeof record['constraints'] === 'object' &&
    !Array.isArray(record['constraints'])
      ? (record['constraints'] as CapabilityConstraints)
      : {}
  const source = record['source']
  const grantSource: GrantSource =
    source === 'user-turn' ||
    source === 'approval' ||
    source === 'config-consent' ||
    source === 'task-preauthorization'
      ? source
      : 'approval'
  return {
    id: record['id'],
    capability: capability as CapabilityId,
    scope,
    source: grantSource,
    actions: [...new Set(actions)],
    constraints: { ...constraints },
    createdAt: typeof record['createdAt'] === 'number' ? record['createdAt'] : 0,
    expiresAt: typeof record['expiresAt'] === 'number' ? record['expiresAt'] : null,
    revokedAt: typeof record['revokedAt'] === 'number' ? record['revokedAt'] : null,
    taskId: typeof taskId === 'string' ? taskId : null,
    revision: typeof record['revision'] === 'number' ? record['revision'] : 1,
    usedActions:
      typeof record['usedActions'] === 'number' &&
      Number.isFinite(record['usedActions']) &&
      record['usedActions'] >= 0
        ? record['usedActions']
        : 0,
    autoApproveYellow: record['autoApproveYellow'] === true
  }
}

/**
 * 域名约束复验；供执行器在跟随重定向后、把正文交给模型前再次调用。
 * 约束为空返回 null；约束存在但目标缺失/无效一律拒绝（fail closed）。
 */
export function domainConstraintError(
  domains: readonly string[] | undefined,
  targetDomains: readonly string[] | undefined
): string | null {
  if (domains === undefined || domains.length === 0) return null
  const patterns: string[] = []
  for (const entry of domains) {
    const pattern = normalizeDomainPattern(entry)
    if (pattern === null) return '授权中的域名范围无效，已拒绝。'
    patterns.push(pattern)
  }
  if (targetDomains === undefined || targetDomains.length === 0) {
    return '该授权限定了域名范围，但本次动作没有可验证的目标域名，已拒绝。'
  }
  for (const raw of targetDomains) {
    const domain = normalizeDomain(raw)
    if (domain === null || !patterns.some((pattern) => domainMatches(pattern, domain))) {
      return '本次动作访问的域名不在任务授权范围内，已拒绝。'
    }
  }
  return null
}

function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let value = raw.trim().toLowerCase()
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0] ?? ''
  value = value.replace(/:\d+$/, '').replace(/\.$/, '')
  if (value === '' || value.length > 253 || value.includes('..')) return null
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
    return null
  }
  return value
}

function normalizeDomainPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  const wildcard = trimmed.startsWith('*.')
  const base = normalizeDomain(wildcard ? trimmed.slice(2) : trimmed)
  if (base === null) return null
  return wildcard ? `*.${base}` : base
}

function domainMatches(pattern: string, domain: string): boolean {
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2)
    return domain.endsWith(`.${base}`)
  }
  return domain === pattern || domain.endsWith(`.${pattern}`)
}

export type { ToolSource }
