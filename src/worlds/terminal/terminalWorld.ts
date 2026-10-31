import { spawn, type ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import { z } from 'zod'
import type {
  ApprovalInfo,
  ApprovalRisk,
  Logger,
  ToolContext,
  ToolDef,
  ToolOutcome,
  World,
  WorldDescribe,
  WorldHost
} from '../../core/types'
import type { AppConfig } from '../../shared/config'
import { truncate } from '../../core/util'
import { WorkspaceError, WorkspaceGuard } from '../workspace/guard'
import ENV_PROMPT from './ENV_PROMPT.md?raw'

const TERM_SCHEMA = z.object({
  command: z
    .string()
    .min(1)
    .max(4000)
    .refine((value) => !value.includes('\0'), '包含非法字符'),
  cwd: z.string().max(1024).optional(),
  timeout_ms: z.number().int().min(1000).max(300_000).optional()
})

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_CAPTURE = 100_000

export interface TerminalSink {
  onOutput(output: { stream: 'stdout' | 'stderr'; text: string; command: string }): void
  onStarted(info: { command: string; cwd: string; shell: string }): void
}

interface TerminalWorldOptions {
  getConfig: () => AppConfig
  logger: Logger
  deniedRoots?: () => string[]
}

/**
 * `terminal` World（PLAN.md §4.7）：工作区内、风险分级审批、可中止。
 * 不开交互式 shell；硬阻断高危系统命令。
 */
export class TerminalWorld implements World {
  readonly id = 'terminal'
  readonly describe: WorldDescribe = {
    tools: [
      {
        name: 'term_run',
        description: '在工作区内运行一条非交互命令；是否询问由风险策略与审批模式决定，可中止；默认 60 秒超时。',
        tags: ['terminal'],
        approval: 'required'
      }
    ],
    events: []
  }

  private readonly getConfig: () => AppConfig
  private readonly logger: Logger
  private readonly guard: WorkspaceGuard
  private host: WorldHost | null = null
  private sink: TerminalSink | null = null

  constructor(opts: TerminalWorldOptions) {
    this.getConfig = opts.getConfig
    this.logger = opts.logger
    this.guard = new WorkspaceGuard({
      getRoot: () => this.getConfig().worlds.workspace.root,
      deniedRoots: opts.deniedRoots ?? (() => [])
    })
  }

  setSink(sink: TerminalSink | null): void {
    this.sink = sink
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host
  }

  async stop(): Promise<void> {
    this.host = null
    this.sink = null
  }

  envPromptVars(): Record<string, string> | null {
    const config = this.getConfig()
    if (!config.worlds.terminal.enabled) return null
    const root = config.worlds.workspace.root.trim()
    return {
      shell: config.worlds.terminal.shell,
      rootName: root === '' ? '（未设置）' : basename(root) || root,
      timeout: String(Math.round(DEFAULT_TIMEOUT_MS / 1000))
    }
  }

  envPrompt(): string | null {
    return this.getConfig().worlds.terminal.enabled ? ENV_PROMPT : null
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'term_run',
        description:
          '在工作区内用 cmd.exe 或 PowerShell 运行一条非交互命令。是否询问由风险策略与审批模式决定；cwd 必须在工作区内；超时/停止会杀掉进程树；输出截断。',
        parameters: TERM_SCHEMA,
        tags: ['terminal'],
        approval: 'required',
        interruptible: true,
        approvalInfo: (raw) => this.approvalInfo(raw),
        handler: async (raw, ctx): Promise<ToolOutcome> => this.run(raw as z.infer<typeof TERM_SCHEMA>, ctx)
      }
    ]
  }

  private approvalInfo(raw: unknown): ApprovalInfo {
    const parsed = TERM_SCHEMA.safeParse(raw)
    if (!parsed.success) {
      return {
        summary: '运行终端命令',
        preview: { kind: 'command', title: '终端命令', body: truncate(JSON.stringify(raw), 2000) },
        risk: 'high'
      }
    }
    const input = parsed.data
    const config = this.getConfig()
    const shell = config.worlds.terminal.shell
    const cwd = input.cwd ?? '.'
    const blocked = blockedReason(input.command)
    const risk: ApprovalRisk = blocked !== null ? 'high' : commandRisk(input.command)
    const body = [
      input.command,
      '',
      `cwd: ${cwd}`,
      `shell: ${shell}`,
      `timeout: ${Math.round((input.timeout_ms ?? DEFAULT_TIMEOUT_MS) / 1000)}s`,
      ...(blocked === null ? [] : ['', `硬阻断：${blocked}`])
    ].join('\n')
    return {
      summary: `运行命令${risk === 'high' ? '（高风险）' : ''}：${truncate(input.command, 80)}`,
      preview: {
        kind: 'command',
        title: '运行终端命令',
        command: input.command,
        cwd,
        body
      },
      risk,
      exactCommand: `${shell}\0${this.resolveCwdForApproval(cwd)}\0${input.command}`
    }
  }

  private resolveCwdForApproval(cwd: string): string {
    try {
      return this.guard.resolve(cwd, { mustExist: true }).abs
    } catch {
      return cwd
    }
  }

  private async run(input: z.infer<typeof TERM_SCHEMA>, ctx: ToolContext): Promise<ToolOutcome> {
    const config = this.getConfig()
    if (!config.worlds.terminal.enabled) return fail('TERM_DISABLED', '终端 World 已关闭')
    let cwd: string
    try {
      const resolved = this.guard.resolve(input.cwd ?? '.', { mustExist: true })
      if (!resolved.isDirectory) return fail('TERM_BAD_CWD', 'cwd 不是目录')
      cwd = resolved.abs
    } catch (error) {
      if (error instanceof WorkspaceError) return fail(error.code, error.message)
      return fail('TERM_BAD_CWD', messageOf(error))
    }

    const blocked = blockedReason(input.command)
    if (blocked !== null) {
      this.logger.warn('终端命令被硬阻断', { reason: blocked })
      return fail('TERM_BLOCKED', `该命令被硬阻断：${blocked}`)
    }

    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS
    const shell = config.worlds.terminal.shell
    const command = input.command
    const shellArgs =
      shell === 'powershell.exe'
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`
          ]
        : ['/d', '/s', '/c', `chcp 65001>nul & ${command}`]

    this.sink?.onStarted({ command, cwd, shell })

    return new Promise<ToolOutcome>((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let aborted = false
      let timedOut = false
      let child: ChildProcess | null = null

      const settle = (outcome: ToolOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      const onAbort = (): void => {
        aborted = true
        killTree(child)
        settle(fail('TOOL_ABORTED', '命令已中止'))
      }
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
        settle(fail('TERM_TIMEOUT', `命令超过 ${Math.round(timeoutMs / 1000)} 秒，已终止进程树`))
      }, timeoutMs)
      timer.unref?.()
      if (ctx.signal.aborted) {
        clearTimeout(timer)
        resolve(fail('TOOL_ABORTED', '命令已中止'))
        return
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      try {
        child = spawn(shell, shellArgs, {
          cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env }
        })
      } catch (error) {
        settle(fail('TERM_SPAWN_FAILED', `无法启动终端：${messageOf(error)}`))
        return
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stdout = appendCapped(stdout, text)
        this.emit('stdout', text, command)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stderr = appendCapped(stderr, text)
        this.emit('stderr', text, command)
      })
      child.on('error', (error) => {
        if (!aborted && !timedOut) settle(fail('TERM_SPAWN_FAILED', `终端进程错误：${error.message}`))
      })
      child.on('close', (code, signal) => {
        if (aborted || timedOut) return
        const header = `exit=${code ?? 'null'}${signal === null ? '' : ` signal=${signal}`} cwd=${cwd}`
        const body = [header]
        if (stdout !== '') body.push('--- stdout ---', stdout.trimEnd())
        if (stderr !== '') body.push('--- stderr ---', stderr.trimEnd())
        if (stdout === '' && stderr === '') body.push('（无输出）')
        settle({ text: truncate(body.join('\n'), 8000), failed: code !== 0 })
      })
    })
  }

  private emit(stream: 'stdout' | 'stderr', text: string, command: string): void {
    try {
      this.sink?.onOutput({ stream, text, command })
    } catch {
      /* ignore */
    }
  }
}

function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURE) return current
  const next = current + chunk
  return next.length > MAX_CAPTURE ? `${next.slice(0, MAX_CAPTURE)}\n…（输出超过 ${MAX_CAPTURE} 字符，已截断）` : next
}

function killTree(child: ChildProcess | null): void {
  if (child === null || child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.unref()
    } catch {
      /* ignore */
    }
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  } else {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

/** 硬阻断（PLAN.md §4.7）。返回原因；null 表示允许进入审批。 */
export function blockedReason(command: string): string | null {
  const raw = command.replace(/\r/g, '\n')
  const lower = raw.toLowerCase().replace(/\s+/g, ' ')
  const rules: Array<[RegExp, string]> = [
    [/\bformat(?:\.com)?\s+[a-z]:/i, '格式化磁盘'],
    [/\bdiskpart\b/i, '磁盘分区工具'],
    [/\bbcdedit\b/i, '启动配置修改'],
    [/\breg\s+delete\b/i, '注册表删除'],
    [/\bremove-item\b[^\n]*(?:hklm:|hkcu:|hkey_)/i, '注册表删除'],
    [/\bregedit\b/i, '注册表编辑器'],
    [/\bshutdown(?:\.exe)?\b/i, '关机/重启'],
    [/\brestart-computer\b/i, '重启计算机'],
    [/\bstop-computer\b/i, '关闭计算机'],
    [/\blogoff(?:\.exe)?\b/i, '注销系统'],
    [/(?:^|[&|;\n])\s*(?:rd|rmdir)\s+\/s(?:\s+\/q)?\s+[a-z]:[\\/]?\s*(?:$|[&|;\n])/i, '盘符根递归删除'],
    [/(?:^|[&|;\n])\s*del\s+\/s(?:\s+\/q)?\s+[a-z]:[\\/]?\s*(?:$|[&|;\n])/i, '盘符根递归删除'],
    [/(?:^|[&|;\n])\s*remove-item\b[^\n]*-recurse[^\n]*[a-z]:[\\/]?\s*(?:$|[&|;\n])/i, '盘符根递归删除'],
    [/(?:curl|wget|iwr|invoke-webrequest)\b[^\n]*\|\s*(?:iex|invoke-expression|powershell|cmd|sh)\b/i, '下载后直接执行'],
    [/\b(?:downloadstring|downloadfile|downloaddata)\b[^\n]*(?:iex|invoke-expression|\|\s*&\s*)/i, '下载后直接执行'],
    [/(?:^|\s)-enc(?:odedcommand)?\s+[a-z0-9+/=]{8,}/i, 'EncodedCommand'],
    [/\brunas(?:\.exe)?\b/i, '提权'],
    [/\bstart-process\b[^\n]*-verb\s+runas/i, '提权'],
    [/(?:^|[&|;\n])\s*sudo\b/i, '提权'],
    [/\bvssadmin\s+delete\b/i, '删除卷影副本'],
    [/\bwbadmin\s+delete\b/i, '删除备份'],
    [/\bcipher\s+\/w\b/i, '擦除磁盘空闲空间'],
    [/\b(?:mkfs|dd\s+if=)/i, '磁盘写入'],
    [/>\s*\\\\\.\\physicaldrive/i, '直接写物理磁盘']
  ]
  for (const [pattern, reason] of rules) {
    if (pattern.test(lower)) return reason
  }
  return null
}

function commandRisk(command: string): ApprovalRisk {
  if (/\b(?:del|erase|rmdir|rd|rm|remove-item|unlink|taskkill|kill|stop-process)\b/i.test(command)) return 'high'
  if (/\b(?:reg\s+add|sc\s+(?:config|delete|stop|start)|netsh|icacls|takeown|attrib|new-item|move-item|copy-item|start-process|invoke-webrequest|curl)\b/i.test(command)) {
    return 'high'
  }
  return 'medium'
}

function fail(code: string, message: string): ToolOutcome {
  return { text: `[${code}] ${message}`, failed: true }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
