import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger, LogLevel } from './types'
import { dateKey, redact, redactObject } from './util'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LoggerOptions {
  dir: string
  minLevel?: LogLevel
  console?: boolean
  /** 额外的内存捕获（诊断页用）。 */
  onEntry?: (entry: Record<string, unknown>) => void
}

/** `logs/app-<date>.jsonl`。所有字符串写盘前脱敏。 */
export class FileLogger implements Logger {
  private readonly dir: string
  private readonly minLevel: number
  private readonly echo: boolean
  private readonly onEntry?: (entry: Record<string, unknown>) => void

  constructor(options: LoggerOptions) {
    this.dir = options.dir
    this.minLevel = LEVEL_ORDER[options.minLevel ?? 'info']
    this.echo = options.console ?? false
    this.onEntry = options.onEntry
    mkdirSync(this.dir, { recursive: true })
  }

  log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.minLevel) return
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: redact(msg),
      ...(data === undefined ? {} : { data: redactObject(data) })
    }
    try {
      appendFileSync(join(this.dir, `app-${dateKey(Date.now())}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      /* 日志写不进去不能影响主流程 */
    }
    this.onEntry?.(entry)
    if (this.echo) {
      const line = `[${level}] ${entry.msg}${data === undefined ? '' : ` ${JSON.stringify(entry.data)}`}`
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    }
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log('debug', msg, data)
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log('info', msg, data)
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log('warn', msg, data)
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log('error', msg, data)
  }
}

/** 测试用：静默 logger。 */
export const nullLogger: Logger = {
  log: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}
