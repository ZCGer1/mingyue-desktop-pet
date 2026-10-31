import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redact } from '../core/util'
import type {
  DiagnosticsLogView,
  DiagnosticsToolCallView,
  DiagnosticsView
} from '../shared/ipc'

/**
 * 诊断导出（PLAN.md §7.3）。
 *
 * 这里刻意只读取 logs 目录下的 JSONL 尾部：不碰会话、记忆、工作区文件，
 * 也不读取 API Key。返回给导出包的路径、URL、密钥形态字符串还会再做一轮
 * 脱敏，避免把用户名、工作区位置或临时令牌带给别人。
 */

const TAIL_BYTES = 256 * 1024
const DEFAULT_LIMIT = 20

function readTailLines(file: string, maxBytes = TAIL_BYTES): string[] {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return []
  }
  if (size === 0) return []
  const length = Math.min(size, maxBytes)
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
  } catch {
    return []
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

function readJsonLines(file: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of readTailLines(file)) {
    try {
      const value: unknown = JSON.parse(line)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        out.push(value as Record<string, unknown>)
      }
    } catch {
      // 尾部截断会产生半行，忽略即可。
    }
  }
  return out
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 最近工具调用来自审计日志；审计只记路径/命令摘要，不记文件内容。 */
export function readRecentToolCalls(
  logsDir: string,
  limit = DEFAULT_LIMIT
): DiagnosticsToolCallView[] {
  const entries = readJsonLines(join(logsDir, 'audit.jsonl'))
  const calls: DiagnosticsToolCallView[] = []
  for (const entry of entries) {
    if (entry['kind'] !== 'tool') continue
    const tool = asString(entry['tool'])
    if (tool === null) continue
    calls.push({
      at: asString(entry['ts']) ?? '',
      tool,
      result: asString(entry['result']) ?? 'unknown',
      approval: asString(entry['approval']),
      durationMs: asNumber(entry['durationMs']),
      summary: asString(entry['summary'])
    })
  }
  return calls.slice(-limit).reverse()
}

/** 最近错误/警告来自应用日志；日志写盘前已脱敏。 */
export function readRecentErrors(
  logsDir: string,
  limit = DEFAULT_LIMIT
): DiagnosticsLogView[] {
  let files: string[]
  try {
    files = readdirSync(logsDir)
      .filter((name) => /^app-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .reverse()
  } catch {
    return []
  }

  const out: DiagnosticsLogView[] = []
  for (const name of files) {
    const entries = readJsonLines(join(logsDir, name))
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry === undefined) continue
      const level = asString(entry['level'])
      if (level !== 'error' && level !== 'warn') continue
      out.push({
        at: asString(entry['ts']) ?? '',
        level,
        message: asString(entry['msg']) ?? '',
        data: asRecord(entry['data'])
      })
      if (out.length >= limit) return out
    }
  }
  return out
}

interface SanitizeContext {
  pathReplacements: Array<{ pattern: RegExp; label: string }>
}

const SENSITIVE_KEY = /api[_-]?key|token|secret|password|authorization|cookie|credential/i
/**
 * 屏幕陪伴的窄状态本应只有 ID/枚举/时间/计数；这里再按字段名兜底，
 * 防止未来把摘要/台词/OCR 原文误加进诊断对象。
 */
const FORBIDDEN_DATA_KEY =
  /^(processName|process|windowTitle|window|clipboard|screenshot|ocr|screenSummary|screenText|screenComment|screenOcr|observationText|spokenText|lastComment)$/i

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function addPathReplacement(
  map: Map<string, string>,
  raw: string | undefined,
  label: string
): void {
  if (raw === undefined) return
  const value = raw.trim()
  if (value.length < 3) return
  map.set(value, label)
  const forward = value.replace(/\\/g, '/')
  if (forward !== value) map.set(forward, label)
  const back = value.replace(/\//g, '\\')
  if (back !== value) map.set(back, label)
}

function makeContext(view: DiagnosticsView, home = homedir()): SanitizeContext {
  const map = new Map<string, string>()
  // 长路径优先，避免工作区位于 HOME 下时先被替换成 [HOME] 的子路径。
  addPathReplacement(map, view.config.worlds.workspace.root, '[WORKSPACE]')
  addPathReplacement(map, view.paths.rootDir, '[APP_DATA]')
  addPathReplacement(
    map,
    view.config.provider.baseUrl === undefined ? undefined : view.config.provider.baseUrl,
    '[PROVIDER_BASE_URL]'
  )
  addPathReplacement(map, home, '[HOME]')
  const replacements = [...map.entries()]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([value, label]) => ({
      pattern: new RegExp(escapeRegExp(value), 'gi'),
      label
    }))
  return { pathReplacements: replacements }
}

function stripUrlDetails(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw)
      return `${url.protocol}//${url.host}`
    } catch {
      return '[URL]'
    }
  })
}

function sanitizeString(text: string, ctx: SanitizeContext): string {
  let out = stripUrlDetails(text)
  for (const replacement of ctx.pathReplacements) {
    out = out.replace(replacement.pattern, replacement.label)
  }
  return redact(out)
}

/**
 * 配置里的自定义人格提示词是用户自由文本，可能包含私密信息；
 * 路径/URL/密钥形态脱敏覆盖不了它，诊断包里整段替换。
 */
function sanitizeConfig(config: unknown, ctx: SanitizeContext): unknown {
  const out = sanitizeValue(config, ctx)
  const record = asRecord(out)
  const persona = record === null ? null : asRecord(record['persona'])
  if (persona !== null && typeof persona['customPrompt'] === 'string') {
    persona['customPrompt'] = '<redacted>'
  }
  return out
}

function sanitizeValue(value: unknown, ctx: SanitizeContext, depth = 0): unknown {
  if (depth > 8) return '[deep]'
  if (typeof value === 'string') return sanitizeString(value, ctx)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, ctx, depth + 1))
  }
  const record = asRecord(value)
  if (record === null) return '[value]'
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (FORBIDDEN_DATA_KEY.test(key)) {
      out[key] = '[redacted]'
      continue
    }
    if (/^baseUrl$/i.test(key) && typeof item === 'string') {
      out[key] = '[PROVIDER_BASE_URL]'
      continue
    }
    if (SENSITIVE_KEY.test(key) && typeof item === 'string') {
      out[key] = '***'
      continue
    }
    out[key] = sanitizeValue(item, ctx, depth + 1)
  }
  return out
}

function companionMetricsOf(diagnostics: Record<string, unknown>): unknown {
  const companion = asRecord(diagnostics['companion'])
  return companion === null ? null : (companion['metrics'] ?? null)
}

export interface DiagnosticPackageMeta {
  platform: string
  homeDir?: string
}

/**
 * 生成脱敏诊断包。调用方只应写入用户通过保存对话框选择的位置。
 */
export function buildDiagnosticPackage(
  view: DiagnosticsView,
  meta: DiagnosticPackageMeta
): Record<string, unknown> {
  const ctx = makeContext(view, meta.homeDir ?? homedir())
  const toolCalls = view.recentToolCalls.map((call) => ({
    at: sanitizeString(call.at, ctx),
    tool: sanitizeString(call.tool, ctx),
    result: sanitizeString(call.result, ctx),
    approval: call.approval === null ? null : sanitizeString(call.approval, ctx),
    durationMs: call.durationMs
    // summary 可能包含工作区路径或终端命令，脱敏诊断包不导出它。
  }))
  return {
    schema: 'mingyue-diagnostic-package',
    schemaVersion: 1,
    generatedAt: view.generatedAt,
    app: {
      version: view.version,
      platform: meta.platform
    },
    runtime: sanitizeValue(view.runtime, ctx),
    config: sanitizeConfig(view.config, ctx),
    diagnostics: sanitizeValue(view.diagnostics, ctx),
    // 汇总指标只有计数/枚举/资源数值；默认不导出兴趣摘要或经历正文。
    companionMetrics: sanitizeValue(companionMetricsOf(view.diagnostics), ctx),
    worlds: sanitizeValue(view.worlds, ctx),
    paths: sanitizeValue(view.paths, ctx),
    recentToolCalls: toolCalls,
    recentErrors: sanitizeValue(view.recentErrors, ctx),
    redaction: {
      pathPlaceholders: {
        '[APP_DATA]': '应用数据目录',
        '[WORKSPACE]': '工作区根目录',
        '[HOME]': '用户主目录',
        '[PROVIDER_BASE_URL]': '自定义 API Base URL'
      },
      secrets: '***',
      removed: [
        'API Key',
        '聊天正文与记忆内容',
        '人格提示词原文',
        '工具参数摘要',
        '原始进程名与窗口标题',
        '屏幕陪伴摘要与台词',
        'URL 路径、查询串与令牌'
      ]
    }
  }
}
