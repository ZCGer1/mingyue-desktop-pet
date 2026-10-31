import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'
import type { EventEnvelope, EventInput, WorldStore } from './types'
import type { StateStore } from './state'
import { atomicWrite, isoNow } from './util'

export class EventStoreCorruptError extends Error {
  readonly file: string
  readonly line: number

  constructor(file: string, line: number, cause: unknown) {
    super(`事件库损坏：${file}:${line}（${String(cause)}）`)
    this.name = 'EventStoreCorruptError'
    this.file = file
    this.line = line
  }
}

export interface EventStoreOptions {
  dir: string
  runId: string
  state: StateStore
  /** 单行最大长度保护：防止异常大对象写爆事件库。 */
  maxLineBytes?: number
}

/**
 * JSONL 事件库（PLAN.md §2.1）。
 *
 * - 全局递增游标在入队时分配；
 * - persist:false 只留内存，不写盘、重启不补投；
 * - 重启恢复只重放 lastDeliveredCursor 之后的外部持久事件；
 * - 末尾半行截断并补换行；中间坏行抛错，不静默跳过。
 */
export class EventStore {
  readonly dir: string
  readonly runId: string
  private readonly state: StateStore
  private readonly maxLineBytes: number
  private memoryEvents: EventEnvelope[] = []
  private lastCursor: number

  constructor(options: EventStoreOptions) {
    this.dir = options.dir
    this.runId = options.runId
    this.state = options.state
    this.maxLineBytes = options.maxLineBytes ?? 256 * 1024
    mkdirSync(this.dir, { recursive: true })
    this.lastCursor = Math.max(this.state.get('lastCursor'), this.scanMaxCursorFromTails())
  }

  get currentCursor(): number {
    return this.lastCursor
  }

  get file(): string {
    return join(this.dir, `${this.runId}.jsonl`)
  }

  /**
   * 入队：分配游标并落盘。事件对象上的生产字段保持不变，Core 不改写 text。
   */
  push(input: EventInput, now = Date.now()): EventEnvelope {
    const cursor = ++this.lastCursor
    const env: EventEnvelope = {
      cursor,
      run: this.runId,
      type: input.type,
      ts: isoNow(now),
      source: input.source,
      origin: input.origin ?? 'external',
      text: input.text,
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      ...(input.meta === undefined ? {} : { meta: input.meta }),
      ...(input.persist === false ? { persist: false as const } : {}),
      ...(input.deliver === false ? { deliver: false as const } : {}),
      ...(input.ephemeral === true ? { ephemeral: true as const } : {}),
      ...(input.attention === undefined ? {} : { attention: input.attention })
    }
    this.state.set('lastCursor', cursor)
    if (env.persist === false) {
      this.memoryEvents.push(env)
      if (this.memoryEvents.length > 500) this.memoryEvents.splice(0, this.memoryEvents.length - 500)
    } else {
      const line = `${JSON.stringify(env)}\n`
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        // 保护事件库：超长文本截断后再落盘（模型上下文里仍是完整文本）。
        const shortened: EventEnvelope = {
          ...env,
          text: `${env.text.slice(0, this.maxLineBytes / 4)}\n…（事件文本过长，已截断存档）`
        }
        appendFileSync(this.file, `${JSON.stringify(shortened)}\n`, 'utf8')
      } else {
        appendFileSync(this.file, line, 'utf8')
      }
    }
    return env
  }

  markDelivered(cursor: number): void {
    if (cursor > this.state.get('lastDeliveredCursor')) {
      this.state.set('lastDeliveredCursor', cursor)
    }
  }

  deliveredCursor(): number {
    return this.state.get('lastDeliveredCursor')
  }

  /**
   * 重启恢复：只取游标之后的外部持久事件。内部事件（心跳/提醒/诊断）不补投。
   * 遇到损坏中间行时抛 EventStoreCorruptError，由调用方记 error 并决定是否继续。
   */
  replaySince(cursor = this.deliveredCursor()): EventEnvelope[] {
    const files = this.listRunFiles()
    const out: EventEnvelope[] = []
    for (const file of files) {
      const rows = this.readFile(file)
      for (const row of rows) {
        if (row.cursor <= cursor) continue
        if (row.origin !== 'external') continue
        if (row.persist === false) continue
        out.push(row)
      }
    }
    out.sort((a, b) => a.cursor - b.cursor)
    return out
  }

  /** 只读查询（WorldStore 用；不返回其他 World 的持久事件以外内容）。 */
  query(filter: { source: string; typePrefix?: string; limit?: number }): EventEnvelope[] {
    const rows = this.readAll()
    const filtered = rows.filter(
      (row) =>
        row.source === filter.source &&
        (filter.typePrefix === undefined || row.type.startsWith(filter.typePrefix))
    )
    const limit = filter.limit ?? 100
    return filtered.slice(-limit)
  }

  /** 用户主动清除本地数据：删除所有事件分片并重置游标。 */
  clear(): void {
    for (const file of this.listRunFiles(true)) {
      try {
        unlinkSync(file)
      } catch {
        /* 文件可能已被删除 */
      }
    }
    this.memoryEvents = []
    this.lastCursor = 0
    this.state.update({ lastCursor: 0, lastDeliveredCursor: 0 })
  }

  readAll(): EventEnvelope[] {
    const out: EventEnvelope[] = []
    for (const file of this.listRunFiles()) out.push(...this.readFile(file))
    out.push(...this.memoryEvents)
    out.sort((a, b) => a.cursor - b.cursor)
    return out
  }

  /** 保留策略：30 天 / 200MB，按 run 分片从旧到新删除。 */
  prune(retentionDays = 30, maxBytes = 200 * 1024 * 1024): string[] {
    const files = this.listRunFiles(true)
    const removed: string[] = []
    const cutoff = Date.now() - retentionDays * 86400_000
    let total = 0
    const sized = files.map((file) => {
      let size = 0
      try {
        size = statSync(file).size
      } catch {
        size = 0
      }
      total += size
      return { file, size, mtime: statSync(file).mtimeMs }
    })
    for (const item of sized) {
      if (item.mtime < cutoff) {
        try {
          unlinkSync(item.file)
          removed.push(item.file)
          total -= item.size
        } catch {
          /* ignore */
        }
      }
    }
    if (total > maxBytes) {
      const rest = sized.filter((item) => !removed.includes(item.file)).sort((a, b) => a.mtime - b.mtime)
      for (const item of rest) {
        if (total <= maxBytes) break
        try {
          unlinkSync(item.file)
          removed.push(item.file)
          total -= item.size
        } catch {
          /* ignore */
        }
      }
    }
    return removed
  }

  /** 写 WorldStore 适配器。 */
  worldStore(): WorldStore {
    return {
      query: (filter) => this.query(filter)
    }
  }

  // -------------------------------------------------------------------------

  private listRunFiles(withAbsolute = false): string[] {
    if (!existsSync(this.dir)) return []
    let names: string[]
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith('.jsonl'))
    } catch {
      return []
    }
    names.sort()
    return names.map((name) => (withAbsolute ? join(this.dir, name) : name))
  }

  private readFile(name: string): EventEnvelope[] {
    const file = join(this.dir, name)
    if (!existsSync(file)) return []
    const raw = readFileSync(file, 'utf8')
    if (raw === '') return []
    const endsWithNewline = raw.endsWith('\n')
    const lines = raw.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const out: EventEnvelope[] = []
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as EventEnvelope
        if (typeof parsed.cursor !== 'number' || typeof parsed.text !== 'string') {
          throw new Error('missing cursor/text')
        }
        out.push(parsed)
      } catch (error) {
        const isLast = i === lines.length - 1
        if (isLast && (!endsWithNewline || lines.length === 1)) {
          // 末行不完整：截断到最后一个完整行并补换行
          const complete = lines.slice(0, i).join('\n')
          if (complete === '') atomicWrite(file, '')
          else atomicWrite(file, `${complete}\n`)
          break
        }
        if (isLast) {
          // 末行损坏（但有换行）：同样按“不完整”处理，截断末行。
          const complete = lines.slice(0, i).join('\n')
          atomicWrite(file, complete === '' ? '' : `${complete}\n`)
          break
        }
        throw new EventStoreCorruptError(file, i + 1, error)
      }
    }
    return out
  }

  private scanMaxCursorFromTails(): number {
    let max = 0
    for (const name of this.listRunFiles()) {
      const file = join(this.dir, name)
      try {
        const size = statSync(file).size
        if (size === 0) continue
        const fd = readFileSync(file, 'utf8')
        const lines = fd.trimEnd().split('\n')
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i -= 1) {
          try {
            const parsed = JSON.parse(lines[i] ?? '') as EventEnvelope
            if (typeof parsed.cursor === 'number' && parsed.cursor > max) max = parsed.cursor
            break
          } catch {
            /* 尝试上一行 */
          }
        }
      } catch {
        /* ignore */
      }
    }
    return max
  }
}
