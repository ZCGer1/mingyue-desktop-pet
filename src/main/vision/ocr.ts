import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface OcrSuccess {
  ok: true
  text: string
  lines: number
  lang: string
}

export interface OcrFailure {
  ok: false
  error: string
}

export type OcrResult = OcrSuccess | OcrFailure

export interface OcrProbeResult {
  ok: boolean
  languages: string[]
  error: string | null
}

export interface WindowsOcrOptions {
  scriptPath: string
  powershellPath?: string
  timeoutMs?: number
}

const MAX_STDOUT = 4 * 1024 * 1024
const MAX_STDERR = 16 * 1024

/**
 * 一次性 PowerShell OCR 调用。图片（PNG/JPEG）以 base64 走 stdin，
 * 不写临时文件；每次调用结束后子进程退出，不常驻。
 */
export class WindowsOcr {
  private readonly scriptPath: string
  private readonly powershellPath: string
  private readonly timeoutMs: number

  constructor(opts: WindowsOcrOptions) {
    this.scriptPath = opts.scriptPath
    this.powershellPath = opts.powershellPath ?? 'powershell.exe'
    this.timeoutMs = Math.max(3_000, opts.timeoutMs ?? 8_000)
  }

  async recognize(image: Buffer, lang: string, maxChars = 8_000): Promise<OcrResult> {
    if (process.platform !== 'win32') {
      return { ok: false, error: '当前系统不是 Windows，OCR 不可用' }
    }
    if (image.length === 0) return { ok: false, error: '截图数据为空' }
    // BitmapDecoder 自动识别格式；字段名保持无格式假设，并同时发送旧字段
    // 以兼容仍在运行的旧版 helper。
    const base64 = image.toString('base64')
    const payload = JSON.stringify({
      imageBase64: base64,
      pngBase64: base64,
      lang,
      maxChars: Math.max(100, Math.min(20_000, maxChars))
    })
    return this.run(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], payload)
  }

  async probe(): Promise<OcrProbeResult> {
    if (process.platform !== 'win32') {
      return { ok: false, languages: [], error: '当前系统不是 Windows' }
    }
    const raw = await this.capture(
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-Probe'],
      ''
    )
    if (raw.error !== null) return { ok: false, languages: [], error: raw.error }
    if (raw.timedOut) {
      return { ok: false, languages: [], error: `OCR 探测超时（${this.timeoutMs}ms）` }
    }
    return parseOcrProbeOutput(raw.stdout, raw.code, raw.stderr)
  }

  private async run(args: string[], input: string): Promise<OcrResult> {
    const raw = await this.capture(args, input)
    if (raw.error !== null) return { ok: false, error: raw.error }
    if (raw.timedOut) return { ok: false, error: `OCR 超时（${this.timeoutMs}ms）` }
    const parsed = parseJson(raw.stdout)
    if (parsed !== null) {
      const record = parsed as {
        ok?: unknown
        text?: unknown
        lines?: unknown
        lang?: unknown
        error?: unknown
      }
      if (record.ok === true && typeof record.text === 'string') {
        return {
          ok: true,
          text: record.text,
          lines:
            typeof record.lines === 'number' ? record.lines : record.text.split('\n').length,
          lang: typeof record.lang === 'string' ? record.lang : 'unknown'
        }
      }
      if (typeof record.error === 'string') {
        return { ok: false, error: record.error.slice(0, 500) }
      }
    }
    const detail = raw.stderr.trim().replace(/\s+/g, ' ').slice(0, 300)
    return {
      ok: false,
      error: detail === '' ? `OCR 失败（退出码 ${String(raw.code)}）` : `OCR 失败：${detail}`
    }
  }

  /**
   * 只负责启动、收集与超时；不做 OCR/探测结果解释。
   * 之前 probe 复用 run 的 OCR 解析器，而探测输出没有 text 字段，
   * 会把“语言包可用”误报成失败，进而让自动观察完全跳过 OCR。
   */
  private capture(args: string[], input: string): Promise<RawOcrRun> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(this.powershellPath, args, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (error) {
        resolve({
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          error: `无法启动 OCR 组件：${String(error)}`
        })
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      let closeCode: number | null = null
      const timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      }, this.timeoutMs)
      timer.unref?.()

      const finish = (error: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: closeCode, stdout, stderr, timedOut, error })
      }

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < MAX_STDOUT) stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR) stderr += chunk
      })
      child.on('error', (error) => {
        finish(`OCR 组件错误：${error.message}`)
      })
      child.on('close', (code) => {
        closeCode = code
        finish(null)
      })

      try {
        child.stdin.end(input, 'utf8')
      } catch (error) {
        finish(`无法写入 OCR 输入：${String(error)}`)
      }
    })
  }
}

interface RawOcrRun {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  error: string | null
}

/** 解析 `ocr.ps1 -Probe` 的单行 JSON；与 OCR 识别结果分开。 */
export function parseOcrProbeOutput(
  stdout: string,
  code: number | null = 0,
  stderr = ''
): OcrProbeResult {
  const parsed = parseJson(stdout)
  if (parsed === null) {
    const detail = stderr.trim().replace(/\s+/g, ' ').slice(0, 300)
    return {
      ok: false,
      languages: [],
      error:
        detail === ''
          ? `OCR 探测返回了无效 JSON（退出码 ${String(code)}）`
          : `OCR 探测失败：${detail}`
    }
  }
  const record = parsed as { ok?: unknown; languages?: unknown; error?: unknown }
  if (record.ok !== true) {
    return {
      ok: false,
      languages: [],
      error:
        typeof record.error === 'string'
          ? record.error.slice(0, 500)
          : `OCR 探测失败（退出码 ${String(code)}）`
    }
  }
  if (!Array.isArray(record.languages)) {
    return {
      ok: false,
      languages: [],
      error: 'OCR 探测返回缺少 languages 字段'
    }
  }
  const languages = record.languages.filter(
    (item): item is string => typeof item === 'string'
  )
  return { ok: true, languages, error: null }
}

function parseJson(stdout: string): unknown | null {
  const lines = stdout.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? ''
    if (line === '' || !line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      /* 继续找上一行 */
    }
  }
  return null
}
