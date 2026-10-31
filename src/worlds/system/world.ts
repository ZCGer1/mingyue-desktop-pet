import { basename } from 'node:path'
import { z } from 'zod'
import type {
  ApprovalInfo,
  Logger,
  ToolContext,
  ToolDef,
  ToolOutcome,
  World,
  WorldDescribe,
  WorldHost
} from '../../core/types'
import type { AuditLog } from '../../core/audit'
import type { AppConfig } from '../../shared/config'
import { normalizeProcessKey } from '../../shared/processName'
import type { DesktopPort } from '../desktop/types'
import { executeAppLaunch, type AppLaunchFacts } from '../shared/appLaunch'
import ENV_PROMPT from './ENV_PROMPT.md?raw'
import {
  SystemError,
  auditUrl,
  resolveOpenTarget,
  systemErrorMessage,
  validateAppPath,
  validateOpenUrl
} from './guard'
import {
  SYSTEM_ACTIONS,
  SYSTEM_ACTION_LABELS,
  type SystemAction,
  type SystemPort
} from './port'

const OPEN_APP_SCHEMA = z.object({
  appId: z.string().min(1).max(64)
})
// 参数名刻意不用 path/url：Core 的通用审计摘要会记录这些键。
// SystemWorld 通过 auditSummary 自己给出脱敏摘要。
const OPEN_PATH_SCHEMA = z.object({
  target: z.string().min(1).max(1024)
})
const OPEN_URL_SCHEMA = z.object({
  target: z.string().min(1).max(2048)
})
const ACTION_SCHEMA = z.object({
  action: z.enum(SYSTEM_ACTIONS as [SystemAction, ...SystemAction[]])
})

const MAX_RECENT = 20
/** 白名单应用启动后最多观察窗口的时间；没有窗口接口时不等待。 */
const OPEN_APP_WINDOW_WAIT_MS = 3_000

export interface SystemRecentAction {
  at: number
  tool: string
  /** 仅供本机设置页展示；不写日志、不进模型上下文。 */
  target: string
  ok: boolean
}

interface SystemWorldOptions {
  getConfig: () => AppConfig
  logger: Logger
  port: SystemPort | null
  /** 只用于启动后观察窗口，不参与路径或白名单授权。 */
  desktopPort?: DesktopPort | null
  audit?: AuditLog | null
  deniedRoots?: () => string[]
  now?: () => number
}

/**
 * `system` World：白名单应用启动、打开文件/文件夹、http(s) 链接与有限系统动作。
 *
 * 这里没有鼠标/键盘注入，也没有窗口聚焦/切换 API。真正的平台调用由注入的
 * `SystemPort` 完成（Electron 主进程用 shell/spawn/PowerShell 实现）。
 */
export class SystemWorld implements World {
  readonly id = 'system'
  readonly describe: WorldDescribe = {
    tools: [
      { name: 'sys_open_app', description: '启动设置里白名单应用的 appId', tags: ['write'], approval: 'required' },
      {
        name: 'sys_open_path',
        description: '用系统默认方式打开文件/文件夹（禁止可执行文件与敏感路径）',
        tags: ['write'],
        approval: 'required'
      },
      { name: 'sys_open_url', description: '在默认浏览器打开 http/https 链接', tags: ['network'], approval: 'required' },
      {
        name: 'sys_action',
        description: '固定支持系统的音量、媒体播放与锁屏动作',
        tags: ['write'],
        approval: 'required'
      }
    ],
    events: []
  }

  private readonly getConfig: () => AppConfig
  private readonly logger: Logger
  private readonly port: SystemPort | null
  private readonly desktopPort: DesktopPort | null
  private readonly audit: AuditLog | null
  private readonly deniedRoots: () => string[]
  private readonly now: () => number
  private recent: SystemRecentAction[] = []
  private host: WorldHost | null = null

  constructor(opts: SystemWorldOptions) {
    this.getConfig = opts.getConfig
    this.logger = opts.logger
    this.port = opts.port
    this.desktopPort = opts.desktopPort ?? null
    this.audit = opts.audit ?? null
    this.deniedRoots = opts.deniedRoots ?? (() => [])
    this.now = opts.now ?? Date.now
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host
  }

  async stop(): Promise<void> {
    this.host = null
  }

  envPromptVars(): Record<string, string> | null {
    const apps = this.getConfig().worlds.system.apps
    if (apps.length === 0) return { appList: '（白名单为空；可请用户在设置 → 电脑能力里添加）' }
    return {
      appList: apps
        .map((app) => `- ${app.id}：${app.label}`)
        .join('\n')
    }
  }

  envPrompt(): string | null {
    const config = this.getConfig().worlds.system
    return config.enabled && this.port !== null ? ENV_PROMPT : null
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'sys_open_app',
        description:
          '启动设置中白名单里的应用。只接受 appId，绝不接受路径或命令行。是否询问由风险策略与审批模式决定。',
        parameters: OPEN_APP_SCHEMA,
        tags: ['write'],
        approval: 'required',
        approvalInfo: (raw) => this.appApproval(raw),
        auditSummary: (raw) => {
          const parsed = OPEN_APP_SCHEMA.safeParse(raw)
          return parsed.success ? `sys_open_app app=${parsed.data.appId}` : 'sys_open_app'
        },
        handler: async (raw): Promise<ToolOutcome> => this.openApp(raw as z.infer<typeof OPEN_APP_SCHEMA>)
      },
      {
        name: 'sys_open_path',
        description:
          '用系统默认程序打开一个文件或文件夹。路径必须在允许范围内；系统目录、AppData、密钥文件与可执行/脚本会被拒绝。是否询问由风险策略与审批模式决定。',
        parameters: OPEN_PATH_SCHEMA,
        tags: ['write'],
        approval: 'required',
        approvalInfo: (raw) => this.pathApproval(raw),
        auditSummary: (raw) => {
          const parsed = OPEN_PATH_SCHEMA.safeParse(raw)
          if (!parsed.success) return 'sys_open_path'
          const ext = parsed.data.target.toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] ?? ''
          return `sys_open_path kind=${ext === '' ? 'folder-or-noext' : ext}`
        },
        handler: async (raw): Promise<ToolOutcome> => this.openPath(raw as z.infer<typeof OPEN_PATH_SCHEMA>)
      },
      {
        name: 'sys_open_url',
        description: '在默认浏览器打开 http 或 https 链接。拒绝 file/javascript/data/UNC 等其它协议。是否询问由风险策略与审批模式决定。',
        parameters: OPEN_URL_SCHEMA,
        tags: ['network'],
        approval: 'required',
        approvalInfo: (raw) => this.urlApproval(raw),
        auditSummary: (raw) => {
          const parsed = OPEN_URL_SCHEMA.safeParse(raw)
          if (!parsed.success) return 'sys_open_url'
          try {
            return `sys_open_url ${auditUrl(validateOpenUrl(parsed.data.target))}`
          } catch {
            return 'sys_open_url invalid'
          }
        },
        handler: async (raw): Promise<ToolOutcome> => this.openUrl(raw as z.infer<typeof OPEN_URL_SCHEMA>)
      },
      {
        name: 'sys_action',
        description:
          '执行固定支持的系统动作：调音量、播放/暂停/切歌、锁屏。没有关机、重启、结束进程或注册表能力。是否询问由风险策略与审批模式决定。',
        parameters: ACTION_SCHEMA,
        tags: ['write'],
        approval: 'required',
        approvalInfo: (raw) => this.actionApproval(raw),
        auditSummary: (raw) => {
          const parsed = ACTION_SCHEMA.safeParse(raw)
          return parsed.success ? `sys_action ${parsed.data.action}` : 'sys_action'
        },
        handler: async (raw): Promise<ToolOutcome> => this.action(raw as z.infer<typeof ACTION_SCHEMA>)
      }
    ]
  }

  /**
   * 供任务/自主来源解析 `sys_open_path` 的真实目标；不是该工具或解析失败时
   * 返回 undefined，由带路径约束的授权 fail closed。
   */
  resolveOpenPathTarget(argsJson: string): string[] | undefined {
    if (!this.getConfig().worlds.system.enabled || !this.getConfig().worlds.system.allowPaths) {
      return undefined
    }
    try {
      const parsed = OPEN_PATH_SCHEMA.safeParse(JSON.parse(argsJson) as unknown)
      if (!parsed.success) return undefined
      return [resolveOpenTarget(parsed.data.target, this.deniedRoots()).real]
    } catch {
      return undefined
    }
  }

  /** 设置页「最近动作」：只在本进程内存中保留 20 条。 */
  recentActions(): SystemRecentAction[] {
    return this.recent.map((entry) => ({ ...entry }))
  }

  clearRecent(): void {
    this.recent = []
  }

  // ------------------------------------------------------------------ 工具

  private async openApp(input: z.infer<typeof OPEN_APP_SCHEMA>): Promise<ToolOutcome> {
    const config = this.getConfig().worlds.system
    if (!config.enabled) return fail('SYS_DISABLED', '电脑操作能力已关闭')
    if (this.port === null) return fail('SYS_UNAVAILABLE', '当前平台没有可用的系统操作接口')
    const wanted = input.appId.trim().toLowerCase()
    const app = config.apps.find((entry) => entry.id.trim().toLowerCase() === wanted)
    if (app === undefined) {
      return fail('SYS_APP_NOT_FOUND', '这个 appId 不在白名单里。请让用户在设置 → 电脑能力里添加应用。')
    }
    let real: string
    try {
      real = validateAppPath(app.path).real
    } catch (error) {
      return this.guardFailure(error)
    }
    const started = this.now()
    let facts: AppLaunchFacts
    try {
      facts = await executeAppLaunch(this.port, {
        real,
        args: [...app.args],
        process: normalizeProcessKey(real),
        desktopPort: this.desktopPort,
        waitMs: OPEN_APP_WINDOW_WAIT_MS,
        now: this.now
      })
    } catch (error) {
      this.record('sys_open_app', app.label, false, started)
      return fail('SYS_FAILED', systemErrorMessage(error))
    }
    this.record('sys_open_app', app.label, facts.accepted, started)
    if (!facts.accepted) {
      return fail('SYS_FAILED', facts.message ?? '系统没有完成这个操作')
    }
    return { text: this.launchText(app.label, facts) }
  }

  private async openPath(input: z.infer<typeof OPEN_PATH_SCHEMA>): Promise<ToolOutcome> {
    const config = this.getConfig().worlds.system
    if (!config.enabled) return fail('SYS_DISABLED', '电脑操作能力已关闭')
    if (!config.allowPaths) return fail('SYS_DISABLED', '打开文件/文件夹的能力已关闭')
    if (this.port === null) return fail('SYS_UNAVAILABLE', '当前平台没有可用的系统操作接口')
    let target
    try {
      target = resolveOpenTarget(input.target, this.deniedRoots())
    } catch (error) {
      return this.guardFailure(error)
    }
    const started = this.now()
    const result = await this.port.openPath(target.real)
    return this.finish('sys_open_path', target.real, result, started)
  }

  private async openUrl(input: z.infer<typeof OPEN_URL_SCHEMA>): Promise<ToolOutcome> {
    const config = this.getConfig().worlds.system
    if (!config.enabled) return fail('SYS_DISABLED', '电脑操作能力已关闭')
    if (!config.allowUrls) return fail('SYS_DISABLED', '打开链接的能力已关闭')
    if (this.port === null) return fail('SYS_UNAVAILABLE', '当前平台没有可用的系统操作接口')
    let url: URL
    try {
      url = validateOpenUrl(input.target)
    } catch (error) {
      return this.guardFailure(error)
    }
    const started = this.now()
    const result = await this.port.openUrl(url.toString())
    return this.finish('sys_open_url', auditUrl(url), result, started)
  }

  private async action(input: z.infer<typeof ACTION_SCHEMA>): Promise<ToolOutcome> {
    const config = this.getConfig().worlds.system
    if (!config.enabled) return fail('SYS_DISABLED', '电脑操作能力已关闭')
    // schema 已限制固定枚举；直接调用 handler 时再守一道，未知动作绝不
    // 到达平台端口。
    if (!(SYSTEM_ACTIONS as readonly string[]).includes(input.action)) {
      return fail('SYS_BAD_ACTION', '不支持这个系统动作')
    }
    if (this.port === null) return fail('SYS_UNAVAILABLE', '当前平台没有可用的系统操作接口')
    const started = this.now()
    const result = await this.port.action(input.action)
    return this.finish('sys_action', SYSTEM_ACTION_LABELS[input.action], result, started)
  }

  private record(tool: string, target: string, ok: boolean, started: number): void {
    const durationMs = this.now() - started
    this.recent.push({ at: this.now(), tool, target, ok })
    if (this.recent.length > MAX_RECENT) this.recent = this.recent.slice(-MAX_RECENT)
    // 日志只有工具名、结果与耗时；目标路径/链接绝不写入日志。
    this.logger.info('系统操作', { tool, ok, durationMs })
    this.audit?.write({
      kind: 'system',
      session: 'main',
      tool,
      summary: tool,
      result: ok ? 'ok' : 'failed',
      durationMs
    })
  }

  private launchText(target: string, facts: AppLaunchFacts): string {
    return [
      `[SYS_OPEN_APP accepted=true executed=true verified=${facts.verified}] 已请求系统启动：${target}。`,
      facts.verified && facts.window !== null
        ? `已看到窗口（windowId=${facts.window.id}）。本助手没有主动聚焦或切换窗口。`
        : '启动请求已执行，但没有确认到窗口；这不等于已经打开。本助手没有主动聚焦或切换窗口。'
    ].join('\n')
  }

  private finish(
    tool: string,
    target: string,
    result: { ok: boolean; message?: string },
    started: number
  ): ToolOutcome {
    this.record(tool, target, result.ok, started)
    if (!result.ok) {
      return fail('SYS_FAILED', result.message ?? '系统没有完成这个操作')
    }
    if (tool === 'sys_open_path') {
      return {
        text: `已请求系统用默认程序打开：${basename(target)}。系统可能会自行把目标窗口带到前台。`
      }
    }
    if (tool === 'sys_open_url') {
      return { text: `已在默认浏览器中打开 ${target}。系统可能会自行把浏览器带到前台。` }
    }
    return { text: `已执行系统动作：${target}。` }
  }

  private guardFailure(error: unknown): ToolOutcome {
    if (error instanceof SystemError) return fail(error.code, error.message)
    this.logger.warn('系统操作守卫失败', { error: systemErrorMessage(error) })
    return fail('SYS_FAILED', systemErrorMessage(error))
  }

  // ------------------------------------------------------------------ 审批卡

  private appApproval(raw: unknown): ApprovalInfo {
    const parsed = OPEN_APP_SCHEMA.safeParse(raw)
    if (!parsed.success) return invalidApproval('启动应用', raw)
    // 与 openApp/风险策略保持同一匹配规则，避免大小写差异让审批卡误报“不在白名单”。
    const wanted = parsed.data.appId.trim().toLowerCase()
    const app = this.getConfig().worlds.system.apps.find(
      (entry) => entry.id.trim().toLowerCase() === wanted
    )
    if (app === undefined) {
      return {
        summary: `启动应用：${parsed.data.appId}（不在白名单）`,
        preview: {
          kind: 'list',
          title: '应用不在白名单',
          body: '执行时会被拒绝。请先在设置 → 电脑能力里添加这个应用。'
        },
        risk: 'high'
      }
    }
    return {
      summary: `启动应用：${app.label}`,
      preview: {
        kind: 'list',
        title: `启动 ${app.label}`,
        body: `${app.path}${app.args.length === 0 ? '' : `\n参数：${app.args.join(' ')}`}`,
        path: app.path
      },
      risk: 'medium'
    }
  }

  private pathApproval(raw: unknown): ApprovalInfo {
    const parsed = OPEN_PATH_SCHEMA.safeParse(raw)
    if (!parsed.success) return invalidApproval('打开文件', raw)
    return {
      // 审计会记录 summary；这里只用文件名，完整路径只出现在审批卡本地预览。
      summary: `打开：${basename(parsed.data.target)}`,
      preview: {
        kind: 'list',
        title: '用系统默认程序打开',
        body: parsed.data.target,
        path: parsed.data.target
      },
      risk: 'medium'
    }
  }

  private urlApproval(raw: unknown): ApprovalInfo {
    const parsed = OPEN_URL_SCHEMA.safeParse(raw)
    if (!parsed.success) return invalidApproval('打开链接', raw)
    let host = '未知主机'
    try {
      host = validateOpenUrl(parsed.data.target).host
    } catch {
      /* 非法链接在审批后会被工具拒绝；审批卡仍展示原文给用户判断。 */
    }
    return {
      // 查询串可能含令牌；审计 summary 只保留主机名。
      summary: `打开链接：${host}`,
      preview: {
        kind: 'list',
        title: '在默认浏览器中打开',
        body: parsed.data.target
      },
      risk: 'medium'
    }
  }

  private actionApproval(raw: unknown): ApprovalInfo {
    const parsed = ACTION_SCHEMA.safeParse(raw)
    if (!parsed.success) return invalidApproval('系统动作', raw)
    return {
      summary: `系统动作：${SYSTEM_ACTION_LABELS[parsed.data.action]}`,
      preview: {
        kind: 'list',
        title: SYSTEM_ACTION_LABELS[parsed.data.action],
        body: '这是一次本地系统动作，不会读写文件，也不会模拟鼠标键盘。'
      },
      risk: parsed.data.action === 'lock' ? 'medium' : 'low'
    }
  }
}

function fail(code: string, message: string): ToolOutcome {
  return { text: `[${code}] ${message}`, failed: true }
}

function invalidApproval(title: string, raw: unknown): ApprovalInfo {
  return {
    summary: title,
    preview: { kind: 'text', title, body: JSON.stringify(raw).slice(0, 2000) },
    risk: 'high'
  }
}
