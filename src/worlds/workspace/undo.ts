import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Logger } from '../../core/types'
import { movePath } from '../shared/fsMove'

type UndoKind = 'write' | 'delete' | 'move'

interface UndoMeta {
  version: 1
  kind: UndoKind
  at: number
  session: string
  turn: number
  path: string
  existed?: boolean
  contentFile?: string
  trashFile?: string
  from?: string
  to?: string
}

export interface UndoResult {
  ok: boolean
  message: string
}

/** 与配置允许的 autoWriteBackupCount 上限一致；实际值由用户配置限制。 */
const MAX_OPS = 100
const MAX_BYTES = 500 * 1024 * 1024

/**
 * 工作区撤销存储（PLAN.md §4.5）：写前快照、删除进应用回收站、
 * 移动记录原路径。按操作目录保存，默认保留 50 轮 / 500MB。
 */
export class UndoStore {
  private readonly root: string
  private readonly logger: Logger
  private readonly validatePath: ((path: string) => void) | null
  private readonly maxOps: () => number

  constructor(
    root: string,
    logger: Logger,
    validatePath?: (path: string) => void,
    maxOps?: () => number
  ) {
    this.root = join(root, 'ops')
    this.logger = logger
    this.validatePath = validatePath ?? null
    this.maxOps = maxOps ?? (() => MAX_OPS)
    mkdirSync(this.root, { recursive: true })
  }

  /** 用户主动清空本地数据：删除全部撤销快照，不影响工作区文件。 */
  clear(): void {
    try {
      rmSync(this.root, { recursive: true, force: true })
      mkdirSync(this.root, { recursive: true })
      this.logger.info('撤销快照已清空')
    } catch (error) {
      this.logger.warn('清空撤销快照失败', { error: String(error) })
    }
  }

  /** 写入/替换前调用，返回 opId；失败时调用 cancel(opId)。 */
  recordWrite(path: string, oldContent: string | null, session: string, turn: number): string {
    const meta: UndoMeta = {
      version: 1,
      kind: 'write',
      at: Date.now(),
      session,
      turn,
      path,
      existed: oldContent !== null
    }
    const dir = this.newOpDir()
    if (oldContent !== null) {
      const contentFile = 'content.txt'
      writeFileSync(join(dir, contentFile), oldContent, 'utf8')
      meta.contentFile = contentFile
    }
    this.writeMeta(dir, meta)
    this.cleanup()
    return basename(dir)
  }

  /** 删除前调用：把目标移进应用回收站。 */
  recordDelete(path: string, session: string, turn: number): string {
    const dir = this.newOpDir()
    const trashDir = join(dir, 'trash')
    mkdirSync(trashDir, { recursive: true })
    const target = join(trashDir, basename(path))
    const meta: UndoMeta = {
      version: 1,
      kind: 'delete',
      at: Date.now(),
      session,
      turn,
      path,
      trashFile: target
    }
    this.writeMeta(dir, meta)
    try {
      movePath(path, target)
    } catch (error) {
      this.removeOp(dir)
      throw error
    }
    this.markReady(dir)
    this.cleanup()
    return basename(dir)
  }

  /** 移动前调用。 */
  recordMove(from: string, to: string, session: string, turn: number): string {
    const dir = this.newOpDir()
    const meta: UndoMeta = {
      version: 1,
      kind: 'move',
      at: Date.now(),
      session,
      turn,
      path: from,
      from,
      to
    }
    this.writeMeta(dir, meta)
    this.markReady(dir)
    this.cleanup()
    return basename(dir)
  }

  /** 写入成功后调用；只有已提交的快照会出现在撤销列表里。 */
  commit(opId: string): void {
    const dir = join(this.root, opId)
    if (existsSync(join(dir, 'meta.json'))) this.markReady(dir)
  }

  cancel(opId: string): void {
    this.removeOp(join(this.root, opId))
  }

  /** 撤销最近一次（或多次）操作；返回每步结果。 */
  undoLast(count = 1): UndoResult[] {
    const results: UndoResult[] = []
    const ops = this.listOpDirs().reverse()
    let done = 0
    for (const dir of ops) {
      if (done >= Math.max(1, count)) break
      if (!existsSync(join(dir, 'ready'))) continue
      if (existsSync(join(dir, 'undone'))) continue
      let meta: UndoMeta
      try {
        meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as UndoMeta
      } catch {
        continue
      }
      const result = this.applyUndo(dir, meta)
      results.push(result)
      if (result.ok) {
        this.removeOp(dir)
        done += 1
      }
    }
    return results
  }

  count(): number {
    return this.listOpDirs().filter(
      (dir) => existsSync(join(dir, 'ready')) && !existsSync(join(dir, 'undone'))
    ).length
  }

  /** 供设置页显示最近操作（路径与类型，不含内容）。 */
  list(): Array<{ kind: UndoKind; at: number; path: string }> {
    const out: Array<{ kind: UndoKind; at: number; path: string }> = []
    for (const dir of this.listOpDirs().reverse()) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as UndoMeta
        out.push({ kind: meta.kind, at: meta.at, path: meta.path })
      } catch {
        /* ignore */
      }
    }
    return out
  }

  // -------------------------------------------------------------------------

  private applyUndo(dir: string, meta: UndoMeta): UndoResult {
    try {
      this.validatePath?.(meta.path)
      if (meta.from !== undefined) this.validatePath?.(meta.from)
      if (meta.to !== undefined) this.validatePath?.(meta.to)
      if (meta.kind === 'write') {
        if (meta.existed === true) {
          if (meta.contentFile === undefined) return { ok: false, message: '快照缺少内容' }
          const content = readFileSync(join(dir, meta.contentFile), 'utf8')
          mkdirSync(dirname(meta.path), { recursive: true })
          writeFileSync(meta.path, content, 'utf8')
          return { ok: true, message: `已还原 ${meta.path}` }
        }
        if (existsSync(meta.path)) unlinkSync(meta.path)
        return { ok: true, message: `已删除新建文件 ${meta.path}` }
      }
      if (meta.kind === 'delete') {
        if (meta.trashFile === undefined || !existsSync(meta.trashFile)) {
          return { ok: false, message: `回收站里找不到 ${meta.path}` }
        }
        if (existsSync(meta.path)) return { ok: false, message: `原位置已有同名文件：${meta.path}` }
        mkdirSync(dirname(meta.path), { recursive: true })
        movePath(meta.trashFile, meta.path)
        return { ok: true, message: `已恢复 ${meta.path}` }
      }
      if (meta.from === undefined || meta.to === undefined) return { ok: false, message: '移动记录不完整' }
      if (!existsSync(meta.to)) return { ok: false, message: `找不到移动后的路径：${meta.to}` }
      if (existsSync(meta.from)) return { ok: false, message: `原位置已有同名文件：${meta.from}` }
      mkdirSync(dirname(meta.from), { recursive: true })
      movePath(meta.to, meta.from)
      return { ok: true, message: `已移回 ${meta.from}` }
    } catch (error) {
      this.logger.warn('撤销失败', { error: String(error) })
      return { ok: false, message: `撤销失败：${String(error)}` }
    }
  }

  private newOpDir(): string {
    const dir = join(this.root, `${Date.now()}-${randomUUID().slice(0, 8)}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private writeMeta(dir: string, meta: UndoMeta): void {
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
  }

  private markReady(dir: string): void {
    writeFileSync(join(dir, 'ready'), '1', 'utf8')
  }

  private listOpDirs(): string[] {
    try {
      return readdirSync(this.root)
        .filter((name) => /^\d{10,}-[a-z0-9-]+$/i.test(name))
        .sort()
        .map((name) => join(this.root, name))
    } catch {
      return []
    }
  }

  private removeOp(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  private cleanup(): void {
    const dirs = this.listOpDirs()
    // 至少保留 1 条：删除/移动的回收站快照也走同一清理逻辑，不能因配置为 0
    // 而把刚移入回收站的文件永久删掉。
    const limit = Math.max(1, Math.min(MAX_OPS, Math.floor(this.maxOps())))
    let bytes = 0
    const sizes = new Map<string, number>()
    for (const dir of dirs) {
      const size = dirSize(dir)
      sizes.set(dir, size)
      bytes += size
    }
    const remove: string[] = []
    while (dirs.length - remove.length > limit) {
      const oldest = dirs.find((dir) => !remove.includes(dir))
      if (oldest === undefined) break
      remove.push(oldest)
      bytes -= sizes.get(oldest) ?? 0
    }
    while (bytes > MAX_BYTES) {
      const oldest = dirs.find((dir) => !remove.includes(dir))
      if (oldest === undefined) break
      remove.push(oldest)
      bytes -= sizes.get(oldest) ?? 0
    }
    for (const dir of remove) this.removeOp(dir)
  }
}

function dirSize(path: string): number {
  try {
    const stat = statSync(path)
    if (stat.isFile()) return stat.size
    if (!stat.isDirectory()) return 0
    let total = 0
    for (const entry of readdirSync(path)) total += dirSize(join(path, entry))
    return total
  } catch {
    return 0
  }
}
