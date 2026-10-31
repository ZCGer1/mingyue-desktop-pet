import { z } from 'zod'
import type {
  Logger,
  ToolDef,
  ToolOutcome,
  World,
  WorldDescribe,
  WorldHost
} from '../../core/types'
import type { AuditLog } from '../../core/audit'
import type { AppConfig } from '../../shared/config'
import { effectiveExploration, isExplorationAppExcluded } from '../../shared/exploration'
import { normalizeProcessKey } from '../../shared/processName'
import type { DesktopPort, DesktopWindowRef } from '../desktop/types'
import type { SystemPort } from '../system/port'
import { SystemError, validateAppPath } from '../system/guard'
import { sanitizeWindowTitle } from '../activity/appIdentity'
import {
  confirmWindowForeground,
  executeAppLaunch,
  waitForProcessWindow,
  type AppLaunchFacts
} from '../shared/appLaunch'
import {
  dedupeScan,
  matchApps,
  toCatalogEntry,
  type AppCatalogEntry,
  type AppScanEntry
} from './catalog'
import ENV_PROMPT from './ENV_PROMPT.md?raw'

const LIST_SCHEMA = z.object({
  query: z.string().max(80).optional(),
  offset: z.number().int().min(0).max(1000).optional(),
  limit: z.number().int().min(1).max(100).optional()
})
const FIND_SCHEMA = z.object({
  query: z.string().min(1).max(80)
})
const LAUNCH_SCHEMA = z.object({
  appId: z.string().min(1).max(64),
  waitSeconds: z.number().int().min(0).max(15).optional()
})
const FOCUS_SCHEMA = z.object({
  appId: z.string().min(1).max(64),
  windowId: z.string().min(4).max(64).optional()
})
const WAIT_SCHEMA = z.object({
  appId: z.string().min(1).max(64),
  timeoutSeconds: z.number().int().min(1).max(15).optional()
})

const CATALOG_TTL_MS = 5 * 60_000
const MAX_CATALOG = 400
const POLL_INTERVAL_MS = 400

interface AppsWorldOptions {
  getConfig: () => AppConfig
  logger: Logger
  port: SystemPort | null
  desktopPort: DesktopPort | null
  /** 扫描开始菜单等处的应用；不注入时只能看到系统白名单。 */
  scanApps?: () => Promise<AppScanEntry[]>
  audit?: AuditLog | null
  now?: () => number
}

/**
 * `apps` World：普通应用发现、启动、切换与等待。
 *
 * 模型只看到稳定 appId、显示名与进程键；真实路径只在本进程内用于校验和
 * 启动，不写入回执、日志或记忆。启动结果区分 accepted / executed / verified，
 * 没有看到窗口时绝不声称已经打开。
 */
export class AppsWorld implements World {
  readonly id = 'apps'
  readonly describe: WorldDescribe = {
    tools: [
      {
        name: 'apps_list',
        description: '列出已发现的普通应用；带 query 时按名字查找并返回有限候选与歧义提示',
        tags: ['read'],
        approval: 'auto'
      },
      {
        name: 'apps_find',
        description: '兼容旧名，已隐藏；新请求请用 apps_list 的 query 参数',
        tags: ['read'],
        approval: 'auto'
      },
      { name: 'apps_launch', description: '按 appId 启动应用并尝试验证窗口', tags: ['write'], approval: 'required' },
      { name: 'apps_focus', description: '把应用窗口切到前台并验证', tags: ['write'], approval: 'required' },
      { name: 'apps_wait', description: '等待应用窗口出现', tags: ['read'], approval: 'auto' }
    ],
    events: []
  }

  private readonly getConfig: () => AppConfig
  private readonly logger: Logger
  private readonly port: SystemPort | null
  private readonly desktopPort: DesktopPort | null
  private readonly scanApps: (() => Promise<AppScanEntry[]>) | null
  private readonly audit: AuditLog | null
  private readonly now: () => number
  private catalog: AppCatalogEntry[] = []
  private catalogAt = 0
  private scanning: Promise<AppCatalogEntry[]> | null = null
  private host: WorldHost | null = null

  constructor(opts: AppsWorldOptions) {
    this.getConfig = opts.getConfig
    this.logger = opts.logger
    this.port = opts.port
    this.desktopPort = opts.desktopPort
    this.scanApps = opts.scanApps ?? null
    this.audit = opts.audit ?? null
    this.now = opts.now ?? Date.now
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host
  }

  async stop(): Promise<void> {
    this.host = null
  }

  envPrompt(): string | null {
    const view = effectiveExploration(this.getConfig())
    if (!view.active || !view.apps) return null
    return ENV_PROMPT
  }

  envPromptVars(): Record<string, string> | null {
    return null
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'apps_list',
        description:
          '分页列出已发现的普通应用（appId、名称、进程名）；带 query 时按名称/进程名查找并返回有限候选与歧义提示；不会返回安装路径，也不会自动启动。',
        parameters: LIST_SCHEMA,
        tags: ['read'],
        approval: 'auto',
        enabled: () => this.appsAvailable(),
        handler: async (raw): Promise<ToolOutcome> =>
          this.list(raw as z.infer<typeof LIST_SCHEMA>)
      },
      {
        name: 'apps_find',
        description: '按名称/进程名查找应用，返回多个候选；不要在有歧义时自己挑一个。',
        parameters: FIND_SCHEMA,
        tags: ['read'],
        approval: 'auto',
        enabled: () => this.appsAvailable(),
        handler: async (raw): Promise<ToolOutcome> =>
          this.find(raw as z.infer<typeof FIND_SCHEMA>)
      },
      {
        name: 'apps_launch',
        description:
          '按 appId 启动应用。回执区分 accepted、executed、verified；没看到窗口时不要声称已经打开。',
        parameters: LAUNCH_SCHEMA,
        tags: ['write'],
        approval: 'required',
        enabled: () => this.appsAvailable(),
        handler: async (raw): Promise<ToolOutcome> =>
          this.launch(raw as z.infer<typeof LAUNCH_SCHEMA>)
      },
      {
        name: 'apps_focus',
        description: '把应用窗口切到前台；有多个窗口时返回候选，不盲选。',
        parameters: FOCUS_SCHEMA,
        tags: ['write'],
        approval: 'required',
        enabled: () => this.appsAvailable(),
        handler: async (raw): Promise<ToolOutcome> =>
          this.focus(raw as z.infer<typeof FOCUS_SCHEMA>)
      },
      {
        name: 'apps_wait',
        description: '等待应用窗口出现（最多 15 秒）；超时如实返回未验证。',
        parameters: WAIT_SCHEMA,
        tags: ['read'],
        approval: 'auto',
        enabled: () => this.appsAvailable(),
        handler: async (raw): Promise<ToolOutcome> =>
          this.wait(raw as z.infer<typeof WAIT_SCHEMA>)
      }
    ]
  }

  /**
   * 任务 grant 的目标解析：appId → 进程键。解析不到时返回 undefined，
   * 让带 appAllowlist 的授权 fail closed。
   */
  async resolveCapabilityTargets(action: string, argsJson: string): Promise<string[] | undefined> {
    if (action !== 'apps_launch' && action !== 'apps_focus' && action !== 'apps_wait') return undefined
    let args: unknown
    try {
      args = JSON.parse(argsJson) as unknown
    } catch {
      return undefined
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
    const appId = (args as Record<string, unknown>)['appId']
    if (typeof appId !== 'string' || appId.trim() === '') return undefined
    const entry = await this.resolveEntry(appId.trim())
    return entry === null ? undefined : [entry.process]
  }

  // ------------------------------------------------------------------

  private appsAvailable(): boolean {
    const config = this.getConfig()
    const view = effectiveExploration(config)
    return (
      (config.worlds.system.enabled && config.worlds.system.apps.length > 0) ||
      (view.active && view.apps)
    )
  }

  private async ensureCatalog(): Promise<AppCatalogEntry[]> {
    const fresh = this.catalogAt > 0 && this.now() - this.catalogAt < CATALOG_TTL_MS
    const config = this.getConfig()
    const systemEntries: AppCatalogEntry[] = []
    if (config.worlds.system.enabled) {
      for (const app of config.worlds.system.apps) {
        const entry = toCatalogEntry(
          { label: app.label, path: app.path, args: [...app.args] },
          'system'
        )
        if (entry !== null) systemEntries.push(entry)
      }
    }
    if (fresh) return this.mergeSystem(systemEntries)
    if (this.scanning !== null) return this.scanning
    const scan = this.scanApps
    if (scan === null) {
      this.catalog = []
      this.catalogAt = this.now()
      return this.mergeSystem(systemEntries)
    }
    this.scanning = (async () => {
      try {
        const scanned = dedupeScan(await scan())
        const entries: AppCatalogEntry[] = []
        for (const raw of scanned) {
          const entry = toCatalogEntry(raw, 'start-menu')
          if (entry === null) continue
          entries.push(entry)
          if (entries.length >= MAX_CATALOG) break
        }
        this.catalog = entries
        this.catalogAt = this.now()
        this.logger.info('应用目录已更新', { count: entries.length })
        return this.mergeSystem(systemEntries)
      } catch (error) {
        this.logger.warn('应用目录扫描失败', { error: String(error) })
        this.catalogAt = this.now()
        return this.mergeSystem(systemEntries)
      } finally {
        this.scanning = null
      }
    })()
    return this.scanning
  }

  private mergeSystem(systemEntries: AppCatalogEntry[]): AppCatalogEntry[] {
    const out: AppCatalogEntry[] = []
    const seen = new Set<string>()
    for (const entry of [...systemEntries, ...this.catalog]) {
      const key = entry.id
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
    return out
  }

  private async resolveEntry(appId: string): Promise<AppCatalogEntry | null> {
    const entries = await this.ensureCatalog()
    const id = appId.trim().toLowerCase()
    return entries.find((entry) => entry.id.toLowerCase() === id) ?? null
  }

  private allowed(entry: AppCatalogEntry): string | null {
    const config = this.getConfig()
    const view = effectiveExploration(config)
    if (isExplorationAppExcluded(view, entry.process)) {
      return '这个应用在用户的排除名单里，不能自动启动或切换。'
    }
    const inWhitelist = config.worlds.system.enabled &&
      config.worlds.system.apps.some(
        (app) => normalizeProcessKey(app.path) === entry.process
      )
    if (inWhitelist) return null
    if (!view.active || !view.apps) {
      return '普通应用范围未开启；只能启动用户白名单里的应用。'
    }
    // 新安装应用的继承规则：用户关闭「新应用继承类别授权」后，扫描到的
    // 快捷方式必须早于授权时间。无法确认安装时间时 fail closed，让用户
    // 在设置里显式加入白名单；系统白名单条目不受此限制。
    if (!view.includeNewApps && entry.source === 'start-menu') {
      const grantedAt = config.exploration.grantedAt
      if (entry.installedAt === null) {
        return '无法确认这个应用是否在授权前已安装；请先在设置中显式加入白名单。'
      }
      if (typeof grantedAt === 'number' && entry.installedAt > grantedAt) {
        return '这个应用是在自由探索授权之后新安装的；当前设置不自动继承，请先显式放行。'
      }
    }
    return null
  }

  private async list(input: z.infer<typeof LIST_SCHEMA>): Promise<ToolOutcome> {
    const entries = await this.ensureCatalog()
    const visible = entries.filter((entry) => this.allowed(entry) === null)
    const query = input.query?.trim() ?? ''
    const filtered = query === '' ? visible : matchApps(visible, query, MAX_CATALOG)
    const offset = input.offset ?? 0
    const limit = input.limit ?? 50
    const slice = filtered.slice(offset, offset + limit)
    if (slice.length === 0) {
      if (query !== '') {
        // 区分「没有任何匹配」与「offset 越过已有匹配」：后者不是查询失败，
        // 只是这一页没内容。误报失败会让模型断言应用不存在。
        if (filtered.length === 0) {
          return {
            text: `[APPS_NOT_FOUND] 没有找到「${query.slice(0, 40)}」。可以不带 query 用 apps_list 查看已发现的应用；不要猜测 appId，也不要自动启动任何应用。`,
            failed: true
          }
        }
        return {
          text: `[APPS_FIND] 共 ${filtered.length} 个匹配，offset=${offset} 已超出这个范围，没有更多候选。请从 offset=0 重新查看；不要猜测 appId，也不要自动启动任何应用。`
        }
      }
      return {
        text:
          filtered.length === 0
            ? '[APPS_LIST] 没有可用的应用。请确认用户已开启自由探索的普通应用范围，或系统白名单非空。'
            : '[APPS_LIST] 这个范围内没有更多应用。'
      }
    }
    const lines = slice.map(
      (entry) => `- ${entry.id} | ${entry.label} | ${entry.process}`
    )
    if (query !== '') {
      // 保留旧 apps_find 的“单匹配可直接启动 / 多匹配不要盲选”语义，
      // 同时保留 offset/limit 分页；这个工具永远只列候选，不自动启动。
      const header =
        filtered.length === 1
          ? `[APPS_FIND] 找到 1 个匹配：`
          : `[APPS_FIND] 找到 ${filtered.length} 个候选（offset=${offset}，limit=${limit}）；不要自行挑选，先确认：`
      return {
        text: [
          header,
          ...lines,
          filtered.length === 1
            ? '用 apps_launch 启动它；不要自动启动。'
            : '需要更多候选时用 offset/limit 继续查看；不要自动启动第一个匹配。',
          filtered.length > offset + limit
            ? `继续查看请用 offset=${offset + limit}。`
            : ''
        ]
          .filter((line) => line !== '')
          .join('\n')
      }
    }
    return {
      text: [
        `[APPS_LIST] 共 ${filtered.length} 个可用应用（offset=${offset}，limit=${limit}）：`,
        ...lines,
        filtered.length > offset + limit
          ? `继续查看请用 offset=${offset + limit}。`
          : ''
      ]
        .filter((line) => line !== '')
        .join('\n')
    }
  }

  private async find(input: z.infer<typeof FIND_SCHEMA>): Promise<ToolOutcome> {
    const entries = await this.ensureCatalog()
    const visible = entries.filter((entry) => this.allowed(entry) === null)
    const matches = matchApps(visible, input.query, 10)
    if (matches.length === 0) {
      return {
        text: `[APPS_NOT_FOUND] 没有找到「${input.query.slice(0, 40)}」。可以用 apps_list 查看已发现的应用；不要猜测 appId。`,
        failed: true
      }
    }
    if (matches.length === 1) {
      const entry = matches[0]!
      return {
        text: `[APPS_FIND] 找到 1 个匹配：\n- ${entry.id} | ${entry.label} | ${entry.process}\n用 apps_launch 启动它。`
      }
    }
    return {
      text: [
        `[APPS_FIND] 找到 ${matches.length} 个候选；不要自行挑选，先确认：`,
        ...matches.map((entry) => `- ${entry.id} | ${entry.label} | ${entry.process}`)
      ].join('\n')
    }
  }

  private async launch(input: z.infer<typeof LAUNCH_SCHEMA>): Promise<ToolOutcome> {
    const entry = await this.resolveEntry(input.appId)
    if (entry === null) {
      return {
        text: '[APPS_NOT_FOUND] appId 不在已发现的应用里；先用 apps_list 确认（传 query 查找），不要猜测。',
        failed: true
      }
    }
    const denied = this.allowed(entry)
    if (denied !== null) return { text: `[APPS_DENIED] ${denied}`, failed: true }
    if (this.port === null) {
      return { text: '[APPS_UNAVAILABLE] 当前平台没有可用的启动接口。', failed: true }
    }
    let real: string
    try {
      real = validateAppPath(entry.path).real
    } catch (error) {
      const message = error instanceof SystemError ? error.message : '应用路径不可用'
      return { text: `[APPS_LAUNCH_FAILED] ${message}`, failed: true }
    }

    let facts: AppLaunchFacts
    try {
      facts = await executeAppLaunch(this.port, {
        real,
        args: [...entry.args],
        process: entry.process,
        desktopPort: this.desktopPort,
        waitMs: (input.waitSeconds ?? 6) * 1000,
        now: this.now,
        pollMs: POLL_INTERVAL_MS
      })
    } catch (error) {
      return {
        text: `[APPS_LAUNCH_FAILED] ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
        failed: true
      }
    }
    if (!facts.accepted) {
      this.auditLaunch(entry, 'failed')
      return {
        text: `[APPS_LAUNCH_FAILED accepted=false executed=false verified=false] ${(facts.message ?? '系统拒绝了启动请求').slice(0, 200)}`,
        failed: true
      }
    }
    this.auditLaunch(entry, 'ok')
    return {
      text: this.launchReceipt(entry, facts.window),
      ...(facts.window === null ? {} : { ephemeral: true })
    }
  }

  private async focus(input: z.infer<typeof FOCUS_SCHEMA>): Promise<ToolOutcome> {
    const entry = await this.resolveEntry(input.appId)
    if (entry === null) {
      return { text: '[APPS_NOT_FOUND] appId 不在已发现的应用里。', failed: true }
    }
    const denied = this.allowed(entry)
    if (denied !== null) return { text: `[APPS_DENIED] ${denied}`, failed: true }
    if (this.desktopPort === null) {
      return { text: '[APPS_UNAVAILABLE] 窗口观察接口不可用，不能切换窗口。', failed: true }
    }
    const windows = await this.windowsFor(entry.process)
    if (windows.length === 0) {
      return {
        text: `[APPS_FOCUS_UNVERIFIED] 没有找到「${entry.label}」的窗口；应用可能还没启动，或窗口在别的桌面。`,
        failed: true
      }
    }
    let target: DesktopWindowRef
    if (input.windowId !== undefined) {
      const found = windows.find((window) => window.id === input.windowId)
      if (found === undefined) {
        return {
          text: `[APPS_WINDOW_NOT_FOUND] 这个 windowId 不属于「${entry.label}」。候选：\n${this.windowCandidates(windows)}`,
          failed: true
        }
      }
      target = found
    } else if (windows.length === 1) {
      target = windows[0]!
    } else {
      return {
        text: `[APPS_FOCUS_AMBIGUOUS] 「${entry.label}」有 ${windows.length} 个窗口；请指定 windowId，不要盲选：\n${this.windowCandidates(windows)}`
      }
    }
    let focused = false
    try {
      focused = await this.desktopPort.focusWindow(target.id, [entry.process])
    } catch {
      focused = false
    }
    if (!focused) {
      return {
        text: '[APPS_FOCUS_FAILED] 系统没有接受这次聚焦请求；不要声称已经切换。',
        failed: true
      }
    }
    // 与 win_focus 共用前台确认，绝不在只发出请求时就声称已经切换。
    const verified = await confirmWindowForeground(
      this.desktopPort,
      entry.process,
      target.id,
      1500,
      this.now
    )
    return {
      text: [
        `[APPS_FOCUS accepted=true executed=true verified=${verified}] ${entry.label}`,
        verified ? '窗口已在前台。' : '聚焦请求已执行，但还没有确认前台状态；请重新观察。'
      ].join('\n'),
      ephemeral: true
    }
  }

  private async wait(input: z.infer<typeof WAIT_SCHEMA>): Promise<ToolOutcome> {
    const entry = await this.resolveEntry(input.appId)
    if (entry === null) {
      return { text: '[APPS_NOT_FOUND] appId 不在已发现的应用里。', failed: true }
    }
    const denied = this.allowed(entry)
    if (denied !== null) return { text: `[APPS_DENIED] ${denied}`, failed: true }
    const timeout = (input.timeoutSeconds ?? 8) * 1000
    const window =
      this.desktopPort === null
        ? null
        : await waitForProcessWindow(
            this.desktopPort,
            entry.process,
            timeout,
            this.now,
            POLL_INTERVAL_MS
          )
    if (window === null) {
      return {
        text: `[APPS_WAIT_TIMEOUT] ${Math.round(timeout / 1000)} 秒内没有看到「${entry.label}」的窗口；不要声称已经打开。`,
        failed: true
      }
    }
    return {
      text: `[APPS_WAIT verified=true windowId=${window.id}] 「${entry.label}」的窗口已出现。`,
      ephemeral: true
    }
  }

  private async windowsFor(process: string): Promise<DesktopWindowRef[]> {
    if (this.desktopPort === null) return []
    try {
      return await this.desktopPort.listWindows([process])
    } catch {
      return []
    }
  }

  private launchReceipt(entry: AppCatalogEntry, window: DesktopWindowRef | null): string {
    const verified = window !== null
    return [
      `[APPS_LAUNCH accepted=true executed=true verified=${verified} appId=${entry.id} process=${entry.process}]`,
      `应用：${entry.label}`,
      verified
        ? `已看到窗口（windowId=${window.id}）。`
        : '启动请求已执行，但还没有看到窗口；这不等于已经打开。可以用 apps_wait 继续等待，或如实告诉用户还没看到。'
    ].join('\n')
  }

  private windowCandidates(windows: readonly DesktopWindowRef[]): string {
    return windows
      .map((window) => {
        const title = sanitizeWindowTitle(window.title, { appLabel: null, maxChars: 60 }).text
        return `- ${window.id}${title === null || title === '' ? '' : ` | ${title}`}${window.foreground ? ' | 前台' : ''}`
      })
      .join('\n')
  }

  private auditLaunch(entry: AppCatalogEntry, result: 'ok' | 'failed'): void {
    this.audit?.write({
      kind: 'system',
      session: 'apps',
      tool: 'apps_launch',
      summary: `apps_launch source=${entry.source}`,
      result,
      approval: 'auto',
      extra: { source: entry.source }
    })
  }
}
