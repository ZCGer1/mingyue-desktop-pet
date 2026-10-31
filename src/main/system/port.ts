import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { shell } from 'electron'
import type { Logger } from '../../core/types'
import type { SystemAction, SystemPort, SystemPortResult } from '../../worlds/system/port'

interface ElectronSystemPortOptions {
  /** `resources/system/actions.ps1`。 */
  scriptPath: string
  logger: Logger
  /** 媒体/音量动作最长执行时间；超时会终止子进程。 */
  actionTimeoutMs?: number
  /** E2E 专用：所有方法返回成功但不触碰系统。由环境变量在 Runtime 中开启。 */
  dryRun?: boolean
}

const DEFAULT_ACTION_TIMEOUT_MS = 12_000

function powershellExe(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows'
  const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(full) ? full : 'powershell.exe'
}

function runPowerShell(
  scriptPath: string,
  action: SystemAction,
  timeoutMs: number
): Promise<{ ok: boolean; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    if (!existsSync(scriptPath)) {
      resolve({ ok: false, code: null, timedOut: false })
      return
    }
    let settled = false
    const child = execFile(
      powershellExe(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Action',
        action
      ],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 }
    )
    const finish = (ok: boolean, code: number | null, timedOut = false): void => {
      if (settled) return
      settled = true
      resolve({ ok, code, timedOut })
    }
    child.on('error', (error) => {
      const timedOut = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
      finish(false, null, timedOut)
    })
    child.on('exit', (code) => finish(code === 0, code))
  })
}

/**
 * 系统操作的 Electron/Windows 实现。所有输入都已在 SystemWorld 的守卫里
 * 校验；这里不再拼接 shell 命令。绝对不包含键鼠注入、窗口聚焦或切换。
 */
export class ElectronSystemPort implements SystemPort {
  private readonly scriptPath: string
  private readonly logger: Logger
  private readonly actionTimeoutMs: number
  private readonly dryRun: boolean

  constructor(opts: ElectronSystemPortOptions) {
    this.scriptPath = opts.scriptPath
    this.logger = opts.logger
    this.actionTimeoutMs = opts.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS
    this.dryRun = opts.dryRun ?? false
  }

  async openPath(path: string): Promise<SystemPortResult> {
    if (this.dryRun) return { ok: true }
    try {
      const message = await shell.openPath(path)
      return message === '' ? { ok: true } : { ok: false, message }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async openUrl(url: string): Promise<SystemPortResult> {
    if (this.dryRun) return { ok: true }
    try {
      await shell.openExternal(url, { activate: false })
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  launch(file: string, args: string[]): Promise<SystemPortResult> {
    if (this.dryRun) return Promise.resolve({ ok: true })
    return new Promise((resolve) => {
      let settled = false
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(file, args, {
          detached: true,
          shell: false,
          stdio: 'ignore',
          windowsHide: false
        })
      } catch (error) {
        resolve({ ok: false, message: error instanceof Error ? error.message : String(error) })
        return
      }
      child.once('error', (error) => {
        if (settled) return
        settled = true
        resolve({ ok: false, message: error.message })
      })
      child.once('spawn', () => {
        if (settled) return
        settled = true
        child.unref()
        resolve({ ok: true })
      })
    })
  }

  async action(action: SystemAction): Promise<SystemPortResult> {
    if (this.dryRun) return { ok: true }
    const result = await runPowerShell(this.scriptPath, action, this.actionTimeoutMs)
    // 不把 stderr 返回给模型或日志：PowerShell 的错误可能带本机路径。
    this.logger.info('系统动作执行结束', {
      action,
      ok: result.ok,
      code: result.code,
      timedOut: result.timedOut
    })
    if (result.ok) return { ok: true }
    if (result.timedOut) return { ok: false, message: '系统动作超时，已停止' }
    if (!existsSync(this.scriptPath)) {
      return { ok: false, message: '系统动作脚本缺失，请重新安装或检查打包资源' }
    }
    return { ok: false, message: '系统没有接受这个动作' }
  }
}
