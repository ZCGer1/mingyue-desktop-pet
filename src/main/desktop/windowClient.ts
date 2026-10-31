import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import {
  DesktopPortError,
  type DesktopElementAction,
  type DesktopElementRef,
  type DesktopElementResult,
  type DesktopElementSnapshot,
  type DesktopRect,
  type DesktopWindowText
} from '../../worlds/desktop/types'

/**
 * helper 返回的是物理屏幕像素（脚本已启用 Per-Monitor DPI 感知）；
 * 转成 Electron DIP 的工作由 ElectronDesktopPort 完成。
 */
export interface HelperWindowRef {
  id: string
  process: string
  title: string
  foreground: boolean
  bounds: DesktopRect | null
}

export interface HelperCapture {
  base64: string
  mimeType: 'image/png'
  width: number
  height: number
  bounds: DesktopRect
}

export interface WindowHelperOptions {
  scriptPath: string
  powershellPath?: string
  timeoutMs?: number
}

const MAX_STDOUT = 24 * 1024 * 1024
const MAX_STDERR = 16 * 1024

type HelperResponse = Record<string, unknown>

/**
 * 一次性 PowerShell 窗口辅助调用。每次操作都重新传 allowlist 与 salt，
 * 不信任主进程缓存；stdout 只解析 JSON，不写日志（窗口标题/文本不落盘）。
 */
export class WindowHelperClient {
  private readonly scriptPath: string
  private readonly powershellPath: string
  private readonly timeoutMs: number

  constructor(opts: WindowHelperOptions) {
    this.scriptPath = opts.scriptPath
    this.powershellPath = opts.powershellPath ?? 'powershell.exe'
    this.timeoutMs = Math.max(2_000, Math.min(15_000, opts.timeoutMs ?? 5_000))
  }

  async listWindows(
    allowedProcesses: readonly string[],
    salt: string
  ): Promise<HelperWindowRef[]> {
    this.assertWindows()
    const response = await this.run('list', ['-AllowProcesses', allowedProcesses.join(',')], salt)
    if (!Array.isArray(response.windows)) {
      throw new DesktopPortError('helper-bad-output', '窗口清单返回了无效数据')
    }
    const result: HelperWindowRef[] = []
    for (const item of response.windows) {
      if (item === null || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (
        typeof record.id !== 'string' ||
        typeof record.process !== 'string' ||
        typeof record.title !== 'string' ||
        typeof record.foreground !== 'boolean'
      ) {
        continue
      }
      result.push({
        id: record.id,
        process: record.process,
        title: record.title,
        foreground: record.foreground,
        bounds: parseRect(record.bounds) ?? null
      })
    }
    return result
  }

  async readWindow(
    id: string,
    allowedProcesses: readonly string[],
    salt: string,
    maxChars: number,
    signal?: AbortSignal
  ): Promise<DesktopWindowText> {
    this.assertWindows()
    const response = await this.run(
      'read',
      [
        '-AllowProcesses',
        allowedProcesses.join(','),
        '-WindowId',
        id,
        '-MaxChars',
        String(Math.max(100, Math.min(20_000, Math.round(maxChars))))
      ],
      salt,
      signal
    )
    if (typeof response.text !== 'string') {
      throw new DesktopPortError('helper-bad-output', '窗口文本返回了无效数据')
    }
    return {
      text: response.text,
      truncated: response.truncated === true,
      uiaAvailable: response.uiaAvailable !== false,
      sensitive: response.sensitive === true
    }
  }

  async captureWindow(
    id: string,
    allowedProcesses: readonly string[],
    salt: string,
    signal?: AbortSignal
  ): Promise<HelperCapture> {
    this.assertWindows()
    const response = await this.run(
      'capture',
      ['-AllowProcesses', allowedProcesses.join(','), '-WindowId', id],
      salt,
      signal
    )
    const bounds = parseRect(response.bounds)
    if (
      typeof response.base64 !== 'string' ||
      response.mimeType !== 'image/png' ||
      typeof response.width !== 'number' ||
      typeof response.height !== 'number' ||
      bounds === null
    ) {
      throw new DesktopPortError('helper-bad-output', '窗口截图返回了无效数据')
    }
    return {
      base64: response.base64,
      mimeType: 'image/png',
      width: response.width,
      height: response.height,
      bounds
    }
  }

  async focusWindow(id: string, allowedProcesses: readonly string[], salt: string): Promise<boolean> {
    this.assertWindows()
    const response = await this.run(
      'focus',
      ['-AllowProcesses', allowedProcesses.join(','), '-WindowId', id],
      salt
    )
    return response.focused === true
  }

  async listElements(
    id: string,
    allowedProcesses: readonly string[],
    salt: string,
    maxElements: number,
    signal?: AbortSignal
  ): Promise<DesktopElementSnapshot> {
    this.assertWindows()
    const response = await this.run(
      'elements',
      [
        '-AllowProcesses',
        allowedProcesses.join(','),
        '-WindowId',
        id,
        '-MaxElements',
        String(Math.max(1, Math.min(200, Math.round(maxElements))))
      ],
      salt,
      signal
    )
    if (!Array.isArray(response.elements)) {
      throw new DesktopPortError('helper-bad-output', '控件树返回了无效数据')
    }
    const elements: DesktopElementRef[] = []
    for (const item of response.elements) {
      if (item === null || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (
        typeof record.id !== 'string' ||
        typeof record.role !== 'string' ||
        typeof record.name !== 'string' ||
        typeof record.enabled !== 'boolean'
      ) {
        continue
      }
      const value = typeof record.value === 'string' ? record.value : null
      const bounds = parseRect(record.bounds)
      elements.push({
        id: record.id,
        role: record.role,
        name: record.name,
        value,
        enabled: record.enabled,
        actions: parseElementActions(record.actions),
        ...(bounds === null ? {} : { bounds })
      })
    }
    return {
      elements,
      truncated: response.truncated === true,
      sensitive: response.sensitive === true
    }
  }

  async actElement(
    id: string,
    allowedProcesses: readonly string[],
    salt: string,
    elementId: string,
    action: DesktopElementAction,
    value: string | null,
    signal?: AbortSignal
  ): Promise<DesktopElementResult> {
    this.assertWindows()
    const response = await this.run(
      'act',
      [
        '-AllowProcesses',
        allowedProcesses.join(','),
        '-WindowId',
        id,
        '-ElementId',
        elementId,
        '-ElementAction',
        action,
        ...(value === null ? [] : ['-Value', value.slice(0, 2000)])
      ],
      salt,
      signal
    )
    return {
      executed: response.executed === true,
      verified: response.verified === true,
      valueAfter: typeof response.valueAfter === 'string' ? response.valueAfter : null,
      verification:
        typeof response.verification === 'string' && response.verification !== ''
          ? response.verification
          : 'unknown'
    }
  }

  async listApps(): Promise<string[]> {
    this.assertWindows()
    const response = await this.run('list-apps', [], '')
    if (!Array.isArray(response.apps)) {
      throw new DesktopPortError('helper-bad-output', '应用列表返回了无效数据')
    }
    return response.apps.filter((item): item is string => typeof item === 'string')
  }

  private assertWindows(): void {
    if (process.platform !== 'win32') {
      throw new DesktopPortError('not-windows', '当前系统不是 Windows，窗口观察不可用')
    }
  }

  private run(
    action: string,
    args: string[],
    salt: string,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted === true) {
      return Promise.reject(new DesktopPortError('aborted', '窗口操作已取消'))
    }
    return new Promise((resolve, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>
      try {
        child = spawn(
          this.powershellPath,
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            this.scriptPath,
            '-Action',
            action,
            ...args,
            ...(salt === '' ? [] : ['-Salt', salt])
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        )
      } catch (error) {
        reject(new DesktopPortError('helper-exit', `无法启动窗口辅助组件：${String(error)}`))
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false
      let killedByTimeout = false
      let aborted = false

      const finish = (error: DesktopPortError | null, value?: Record<string, unknown>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error !== null) reject(error)
        else resolve(value ?? {})
      }

      const kill = (): void => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      }
      const onAbort = (): void => {
        aborted = true
        kill()
      }
      const timer = setTimeout(() => {
        killedByTimeout = true
        kill()
      }, this.timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < MAX_STDOUT) stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR) stderr += chunk
      })
      child.on('error', (error) => {
        finish(new DesktopPortError('helper-exit', `窗口辅助组件错误：${error.message}`))
      })
      child.on('close', (code) => {
        if (killedByTimeout) {
          finish(new DesktopPortError('helper-timeout', `窗口操作超时（${this.timeoutMs}ms）`))
          return
        }
        if (aborted) {
          finish(new DesktopPortError('aborted', '窗口操作已取消'))
          return
        }
        const parsed = parseJson(stdout)
        if (parsed === null) {
          // 不把原始 stdout 放进错误（可能包含窗口文本）。
          finish(
            new DesktopPortError(
              code === 0 ? 'helper-bad-output' : 'helper-exit',
              code === 0 ? '窗口辅助组件返回了无效数据' : `窗口辅助组件退出（code=${String(code)}）`
            )
          )
          return
        }
        if (parsed.ok === false) {
          finish(helperFailure(parsed))
          return
        }
        finish(null, parsed)
      })
    })
  }
}

function helperFailure(parsed: HelperResponse): DesktopPortError {
  const code = typeof parsed['code'] === 'string' && parsed['code'] !== '' ? parsed['code'] : 'helper-failed'
  const message =
    typeof parsed['error'] === 'string' && parsed['error'] !== ''
      ? parsed['error']
      : '窗口辅助组件失败'
  return new DesktopPortError(code, message)
}

const ELEMENT_ACTIONS: readonly DesktopElementAction[] = [
  'invoke',
  'set_value',
  'select',
  'toggle',
  'expand',
  'collapse',
  'scroll',
  'focus'
]

function parseElementActions(raw: unknown): DesktopElementAction[] {
  if (!Array.isArray(raw)) return []
  const out: DesktopElementAction[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const action = ELEMENT_ACTIONS.find((candidate) => candidate === item)
    if (action !== undefined && !out.includes(action)) out.push(action)
  }
  return out
}

function parseRect(raw: unknown): DesktopRect | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const x = value['x']
  const y = value['y']
  const width = value['width']
  const height = value['height']
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null
  }
  return { x, y, width, height }
}

function parseJson(stdout: string): HelperResponse | null {
  const lines = stdout.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim()
    if (line === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* 尝试前一行；PowerShell 可能输出警告。 */
    }
  }
  return null
}
