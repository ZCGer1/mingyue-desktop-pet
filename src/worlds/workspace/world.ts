import { stateHash } from '../../core/taskEvidence'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { createTwoFilesPatch } from 'diff'
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
import type { AppConfig } from '../../shared/config'
import { atomicWrite, truncate } from '../../core/util'
import { applyExactTextEdit, replaceFirstText } from '../shared/textEdit'
import {
  findTextLines,
  listDirectoryEntries,
  readTextFile,
  sortDirectoryEntries
} from '../shared/fsRead'
import ENV_PROMPT from './ENV_PROMPT.md?raw'
import {
  WorkspaceError,
  WorkspaceGuard,
  isGitInternal,
  isHeavyDir,
  isPathInside,
  isSensitivePath,
  normalizedForCompare,
  type ResolvedWorkspacePath
} from './guard'
import { UndoStore } from './undo'
import { movePath } from '../shared/fsMove'

export const MAX_READ_BYTES = 2 * 1024 * 1024
export const MAX_READ_LINES = 2000
export const MAX_WRITE_BYTES = 1024 * 1024
export const MAX_LIST_ENTRIES = 500
export const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
const READ_VALID_MS = 30 * 60_000

const PATH_FIELD = z.string().min(1).max(1024)
const READ_SCHEMA = z.object({
  path: PATH_FIELD,
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
  max_lines: z.number().int().min(1).max(MAX_READ_LINES).optional()
})
const LIST_SCHEMA = z.object({
  path: z.string().max(1024).optional(),
  depth: z.number().int().min(1).max(3).optional(),
  max: z.number().int().min(1).max(MAX_LIST_ENTRIES).optional()
})
const SEARCH_SCHEMA = z.object({
  query: z.string().min(1).max(200).refine((value) => !value.includes('\0'), '包含非法字符'),
  path: z.string().max(1024).optional(),
  mode: z.enum(['content', 'filename']).optional(),
  glob: z.string().max(200).optional(),
  max_results: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional()
})
const WRITE_SCHEMA = z.object({
  path: PATH_FIELD,
  content: z.string().max(MAX_WRITE_BYTES),
  create: z.boolean().optional()
})
const REPLACE_SCHEMA = z.object({
  path: PATH_FIELD,
  old_text: z.string().min(1).max(20_000),
  new_text: z.string().max(MAX_WRITE_BYTES)
})
const DELETE_SCHEMA = z.object({ path: PATH_FIELD })
const MOVE_SCHEMA = z.object({ from: PATH_FIELD, to: PATH_FIELD })

interface ReadRecord {
  hash: string
  size: number
  mtimeMs: number
  at: number
}

export interface NoteArtifact {
  /** 对外路径，固定为 `notes/...`；绝不包含绝对路径。 */
  path: string
  title: string
  taskId: string
  at: number
}

const MAX_NOTE_ARTIFACTS_PER_TASK = 8

interface WorkspaceWorldOptions {
  getConfig: () => AppConfig
  logger: Logger
  dataDir: string
  deniedRoots?: () => string[]
  /** 24 小时内是否看过同一内容指纹；命中只在回执前加提示，不阻止读取。 */
  seenHint?: (fingerprint: string) => boolean
}

/**
 * `workspace` World（PLAN.md §4.5）：工作区边界、先读后写、
 * diff/命令级审批、应用回收站与撤销。
 */
export class WorkspaceWorld implements World {
  readonly id = 'workspace'
  readonly describe: WorldDescribe = {
    tools: [
      { name: 'ws_list', description: '列目录（深度/数量上限）', tags: ['read'], approval: 'auto' },
      { name: 'ws_read', description: '读文本（2MB/2000 行上限，敏感文件只标记）', tags: ['read'], approval: 'auto' },
      { name: 'ws_search', description: '文件名/内容搜索（ripgrep，敏感内容隐藏）', tags: ['read'], approval: 'auto' },
      { name: 'ws_write', description: '新建/覆盖文本（覆盖前须读过；按风险策略确认）', tags: ['write'], approval: 'required' },
      { name: 'ws_replace', description: '唯一精确替换（按风险策略确认）', tags: ['write'], approval: 'required' },
      { name: 'ws_delete', description: '移入应用回收站（按风险策略确认）', tags: ['delete'], approval: 'required' },
      { name: 'ws_move', description: '移动/重命名（按风险策略确认）', tags: ['write'], approval: 'required' }
    ],
    events: []
  }

  private readonly getConfig: () => AppConfig
  private readonly logger: Logger
  private readonly guard: WorkspaceGuard
  private readonly undo: UndoStore
  private readonly reads = new Map<string, ReadRecord>()
  private readonly noteArtifacts = new Map<string, NoteArtifact[]>()
  private readonly seenHint: ((fingerprint: string) => boolean) | null
  private rgPathPromise: Promise<string | null> | null = null
  private host: WorldHost | null = null

  constructor(opts: WorkspaceWorldOptions) {
    this.getConfig = opts.getConfig
    this.logger = opts.logger
    this.seenHint = opts.seenHint ?? null
    this.guard = new WorkspaceGuard({
      getRoot: () => this.getConfig().worlds.workspace.root,
      getNotesRoot: () => this.getConfig().worlds.workspace.notesRoot,
      getExtraRoots: () => this.getConfig().autonomy.trustedRoots,
      deniedRoots: opts.deniedRoots ?? (() => [])
    })
    this.undo = new UndoStore(
      join(opts.dataDir, 'undo'),
      opts.logger,
      (path) => {
        this.guard.resolve(path, { mustExist: false })
      },
      () => this.getConfig().autonomy.autoWriteBackupCount
    )
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host
  }

  async stop(): Promise<void> {
    this.host = null
    this.reads.clear()
  }

  /** 供 TasksWorld 构造受限 grant；未设置/无效/应用数据目录时为 null。 */
  notesRootOrNull(): string | null {
    return this.guard.notesRootOrNull()
  }

  lastNoteArtifact(taskId: string): NoteArtifact | null {
    const list = this.noteArtifacts.get(taskId)
    const last = list === undefined ? undefined : list[list.length - 1]
    return last === undefined ? null : { ...last }
  }

  noteArtifactsFor(taskId: string): NoteArtifact[] {
    return (this.noteArtifacts.get(taskId) ?? []).map((artifact) => ({ ...artifact }))
  }

  clearNoteArtifacts(): void {
    this.noteArtifacts.clear()
  }

  envPromptVars(): Record<string, string> | null {
    const root = this.getConfig().worlds.workspace.root.trim()
    const notes = this.getConfig().worlds.workspace.notesRoot.trim()
    if (root === '' && notes === '') return null
    return {
      rootName: root === '' ? '（未设置）' : basename(root) || root,
      notesRootName: notes === '' ? '（未设置）' : basename(notes) || notes
    }
  }

  envPrompt(): string | null {
    const workspace = this.getConfig().worlds.workspace
    return workspace.root.trim() === '' && workspace.notesRoot.trim() === ''
      ? null
      : ENV_PROMPT
  }

  /**
   * 把写入类工具的目标解析成绝对 realpath，供 CapabilityStore 的
   * pathRoots 约束复验。解析失败返回 undefined，由约束侧 fail closed。
   */
  resolveCapabilityTargets(action: string, argsJson: string): string[] | undefined {
    if (!['ws_write', 'ws_replace', 'ws_move', 'ws_delete'].includes(action)) return undefined
    let args: unknown
    try {
      args = JSON.parse(argsJson) as unknown
    } catch {
      return undefined
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
    const record = args as Record<string, unknown>
    const rawPaths =
      action === 'ws_move' ? [record['from'], record['to']] : [record['path']]
    const out: string[] = []
    for (const value of rawPaths) {
      if (typeof value !== 'string' || value.trim() === '') return undefined
      try {
        out.push(this.guard.resolve(value, { mustExist: false }).real)
      } catch {
        return undefined
      }
    }
    return out.length === 0 ? undefined : out
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'ws_list',
        description: '列出工作区目录，最多 3 层 / 500 项；不跟随符号链接，跳过 .git 内部。',
        parameters: LIST_SCHEMA,
        tags: ['read'],
        approval: 'auto',
        handler: async (raw, ctx): Promise<ToolOutcome> => {
          void ctx
          try {
            return this.list(raw as z.infer<typeof LIST_SCHEMA>)
          } catch (error) {
            return this.failure(error)
          }
        }
      },
      {
        name: 'ws_read',
        description: '读取文本文件，支持行范围；上限 2MB / 2000 行。敏感文件仅标记，读取仍走普通范围授权与通用审批规则。',
        parameters: READ_SCHEMA,
        tags: ['read'],
        approval: 'auto',
        handler: async (raw, ctx): Promise<ToolOutcome> => {
          try {
            return await this.read(raw as z.infer<typeof READ_SCHEMA>, ctx)
          } catch (error) {
            return this.failure(error)
          }
        }
      },
      {
        name: 'ws_search',
        description:
          '在工作区内搜索文件名或文本内容，最多 200 条；默认跳过 .git 内部，敏感文件只返回路径。',
        parameters: SEARCH_SCHEMA,
        tags: ['read'],
        approval: 'auto',
        handler: async (raw, ctx): Promise<ToolOutcome> => {
          try {
            return await this.search(raw as z.infer<typeof SEARCH_SCHEMA>, ctx)
          } catch (error) {
            if (ctx.signal.aborted) throw error
            return this.failure(error)
          }
        }
      },
      {
        name: 'ws_write',
        description:
          '新建或覆盖文本文件。覆盖已存在文件前必须先 ws_read；新建需 create=true。是否询问由风险策略与审批模式决定；被询问时会展示 diff。',
        parameters: WRITE_SCHEMA,
        tags: ['write'],
        approval: 'required',
        approvalInfo: (raw) => this.writeApproval(raw),
        handler: async (raw, ctx): Promise<ToolOutcome> => {
          try {
            return this.write(raw as z.infer<typeof WRITE_SCHEMA>, ctx)
          } catch (error) {
            return this.failure(error)
          }
        }
      },
      {
        name: 'ws_replace',
        description: '在已读文件中做唯一精确替换；0 处或多处匹配都会失败。是否询问由风险策略与审批模式决定；被询问时会展示 diff。',
        parameters: REPLACE_SCHEMA,
        tags: ['write'],
        approval: 'required',
        approvalInfo: (raw) => this.replaceApproval(raw),
        handler: async (raw, ctx): Promise<ToolOutcome> => {
          try {
            return this.replace(raw as z.infer<typeof REPLACE_SCHEMA>, ctx)
          } catch (error) {
            return this.failure(error)
          }
        }
      },
      {
        name: 'ws_delete',
        description: '把文件或目录移入应用回收站（不是永久删除）；是否询问由风险策略与审批模式决定。可用撤销恢复。',
        parameters: DELETE_SCHEMA,
        tags: ['delete'],
        approval: 'required',
        approvalInfo: (raw) => {
          const parsed = DELETE_SCHEMA.safeParse(raw)
          const path = parsed.success ? parsed.data.path : '?'
          return {
            summary: `移入应用回收站：${path}`,
            preview: { kind: 'list', title: '删除（可撤销）', body: path, path },
            risk: 'high'
          }
        },
        handler: async (raw, ctx): Promise<ToolOutcome> => {
          try {
            return this.delete(raw as z.infer<typeof DELETE_SCHEMA>, ctx)
          } catch (error) {
            return this.failure(error)
          }
        }
      },
      {
        name: 'ws_move',
        description: '移动或重命名工作区内路径；目标已存在时拒绝。是否询问由风险策略与审批模式决定。',
        parameters: MOVE_SCHEMA,
        tags: ['write'],
        approval: 'required',
        approvalInfo: (raw) => {
          const parsed = MOVE_SCHEMA.safeParse(raw)
          const from = parsed.success ? parsed.data.from : '?'
          const to = parsed.success ? parsed.data.to : '?'
          return {
            summary: `移动：${from} → ${to}`,
            preview: { kind: 'list', title: '移动/重命名', body: `${from}\n→ ${to}`, path: from },
            risk: 'high'
          }
        },
        handler: async (raw, ctx): Promise<ToolOutcome> => {
          try {
            return this.move(raw as z.infer<typeof MOVE_SCHEMA>, ctx)
          } catch (error) {
            return this.failure(error)
          }
        }
      }
    ]
  }

  /** 设置页/主进程使用：撤销最近操作。 */
  undoLast(count = 1): Array<{ ok: boolean; message: string }> {
    const results = this.undo.undoLast(count)
    this.reads.clear()
    return results
  }

  /** 用户主动清空本地数据：丢弃撤销快照，不触碰工作区里的文件。 */
  clearUndo(): void {
    this.undo.clear()
  }

  undoCount(): number {
    return this.undo.count()
  }

  undoList(): Array<{ kind: string; at: number; path: string }> {
    return this.undo.list()
  }

  // ------------------------------------------------------------------ 读

  private list(input: z.infer<typeof LIST_SCHEMA>): ToolOutcome {
    const start = this.guard.resolve(input.path ?? '.', { mustExist: true })
    if (!start.isDirectory) return fail('WS_NOT_DIRECTORY', '目标不是目录')
    const depth = input.depth ?? 1
    const max = input.max ?? 200
    const lines: string[] = []
    let truncated = false
    const skipGit = !isGitInternal(start.rel)

    const walk = (dirAbs: string, relBase: string, left: number): void => {
      if (lines.length >= max) {
        truncated = true
        return
      }
      const listing = listDirectoryEntries(dirAbs)
      if (!listing.ok) {
        lines.push(`- ${relBase}/ [无法读取：${String(listing.error)}]`)
        return
      }
      const entries = sortDirectoryEntries(listing.entries)
      for (const entry of entries) {
        if (lines.length >= max) {
          truncated = true
          return
        }
        if (skipGit && entry.name === '.git') {
          lines.push(`- ${joinRel(relBase, entry.name)}/ (只读，已跳过)`)
          continue
        }
        const childRel = joinRel(relBase, entry.name)
        const childAbs = join(dirAbs, entry.name)
        let isDir = entry.isDirectory()
        let isLink = entry.isSymbolicLink()
        let size = 0
        try {
          if (isLink) {
            const stat = statSync(childAbs)
            isDir = stat.isDirectory()
          } else if (!entry.isDirectory()) {
            size = statSync(childAbs).size
          }
        } catch {
          lines.push(`- ${childRel} [无法读取]`)
          continue
        }
        if (isDir) {
          lines.push(`- ${childRel}/${isLink ? '@' : ''}${isSensitivePath(childRel) ? ' [敏感]' : ''}`)
          if (left > 1 && !isLink) walk(childAbs, childRel, left - 1)
        } else {
          lines.push(
            `- ${childRel}${isLink ? '@' : ''} (${formatSize(size)})${isSensitivePath(childRel) ? ' [敏感]' : ''}`
          )
        }
      }
    }

    // 笔记空间必须以 notes/ 前缀展示，否则模型后续 ws_read 会解析到主工作区。
    walk(start.abs, start.display, depth)
    const header = start.isNotes
      ? `笔记空间：notes（${start.display}）`
      : `工作区：${basename(start.root)}（${start.display}）`
    if (lines.length === 0) return { text: `${header}\n（空目录）` }
    return {
      text: `${header}\n${lines.join('\n')}${truncated ? `\n… 已截断（上限 ${max}）` : ''}`
    }
  }

  private async read(input: z.infer<typeof READ_SCHEMA>, ctx: ToolContext): Promise<ToolOutcome> {
    const resolved = this.guard.resolve(input.path, { mustExist: true })
    if (!resolved.isFile) return fail('WS_NOT_FILE', '目标不是文件')
    if (resolved.isSymbolicLink) {
      // 允许工作区内的符号链接，但读取的是解析后的文件；realpath 已在 guard 里校验。
    }
    // 敏感路径仍只用于回执标记；读取本身走普通范围授权与通用审批规则，
    // 不再因为路径名额外弹出一次单独确认。
    const sensitive = isSensitivePath(resolved.rel)
    const file = this.loadText(resolved)
    this.reads.set(normalizedForCompare(resolved.abs), {
      hash: file.hash,
      size: file.size,
      mtimeMs: file.mtimeMs,
      at: Date.now()
    })

    const lines = file.text.split('\n')
    const maxLines = input.max_lines ?? MAX_READ_LINES
    const startLine = Math.min(Math.max(1, input.start_line ?? 1), Math.max(1, lines.length))
    const requestedEnd = input.end_line ?? startLine + maxLines - 1
    const endLine = Math.min(lines.length, requestedEnd, startLine + maxLines - 1)
    const body = lines
      .slice(startLine - 1, endLine)
      .map((line) => line.replace(/\r$/, ''))
      .join('\n')
    const header = `${resolved.display}（行 ${startLine}-${endLine} / 共 ${lines.length} 行）${
      sensitive ? ' [敏感文件]' : ''
    }`
    const hint =
      this.seenHint?.(file.hash) === true
        ? '[已看过] 这处内容最近看过，不要当成新发现。\n'
        : ''
    return {
      text: `${hint}${header}\n${body}`,
      meta: {
        fingerprint: file.hash,
        stateRef: file.hash,
        targetKind: resolved.isNotes ? 'note' : 'file',
        targetLabel: resolved.display,
        targetRef: 'path:' + stateHash(resolved.real).slice(0, 16)
      }
    }
  }

  // ------------------------------------------------------------------ 搜索

  private async search(input: z.infer<typeof SEARCH_SCHEMA>, ctx: ToolContext): Promise<ToolOutcome> {
    const start = this.guard.resolve(input.path ?? '.', { mustExist: true })
    const mode = input.mode ?? 'content'
    const max = input.max_results ?? 50
    if (start.isFile) return this.searchSingleFile(start, input, max)
    // 以实际解析根为 cwd：主工作区、信任目录和笔记目录各自独立。
    const rg = await this.resolveRipgrep()
    if (rg !== null) {
      const viaRg = await this.searchWithRipgrep(rg, start, input, max, ctx)
      if (viaRg !== null) return viaRg
    }
    return this.searchFallback(start, input, max)
  }

  private searchSingleFile(
    start: ResolvedWorkspacePath,
    input: z.infer<typeof SEARCH_SCHEMA>,
    max: number
  ): ToolOutcome {
    const mode = input.mode ?? 'content'
    if (mode === 'filename') {
      const hit = start.rel.toLowerCase().includes(input.query.toLowerCase())
      return { text: this.formatFilenameMatches(hit ? [start.display] : [], false) }
    }
    if (isSensitivePath(start.rel)) {
      return { text: this.formatContentMatches([`${start.display}: [敏感文件，已隐藏内容]`], false) }
    }
    const file = readTextFile(start.abs, {
      maxBytes: MAX_SEARCH_FILE_BYTES,
      isBinary: (buffer) => buffer.includes(0)
    })
    if (!file.ok) {
      if (file.reason === 'too-large') return fail('WS_TOO_LARGE', '文件过大，未搜索')
      if (file.reason === 'binary') return fail('WS_BINARY', '二进制文件不参与内容搜索')
      if (file.reason === 'not-file') return fail('WS_NOT_FILE', '目标不是文件')
      return this.failure(file.error)
    }
    const results = findTextLines(file.text, input.query, {
      caseSensitive: true,
      max
    }).map((match) => `${start.display}:${match.line}: ${truncate(match.text.trim(), 400)}`)
    return { text: this.formatContentMatches(results, results.length >= max) }
  }

  private async resolveRipgrep(): Promise<string | null> {
    if (this.rgPathPromise !== null) return this.rgPathPromise
    this.rgPathPromise = (async () => {
      try {
        const mod = (await import('@vscode/ripgrep')) as { rgPath?: string }
        if (typeof mod.rgPath === 'string' && existsSync(mod.rgPath)) return mod.rgPath
      } catch {
        /* optional dependency missing */
      }
      return null
    })()
    return this.rgPathPromise
  }

  private async searchWithRipgrep(
    rgPath: string,
    start: ResolvedWorkspacePath,
    input: z.infer<typeof SEARCH_SCHEMA>,
    max: number,
    ctx: ToolContext
  ): Promise<ToolOutcome | null> {
    const target = start.rel === '' ? '.' : start.rel
    const mode = input.mode ?? 'content'
    const args =
      mode === 'filename'
        ? ['--files', '--glob', '!.git/**', ...(input.glob === undefined ? [] : ['--glob', input.glob]), target]
        : [
            '--line-number',
            '--no-heading',
            '--color',
            'never',
            '--fixed-strings',
            '--max-count',
            String(Math.min(200, max * 4)),
            '--max-filesize',
            '2M',
            '--glob',
            '!.git/**',
            ...(input.glob === undefined ? [] : ['--glob', input.glob]),
            '--',
            input.query,
            target
          ]
    const result = await runProcess(rgPath, args, start.root, 15_000, 8 * 1024 * 1024, ctx.signal)
    if (result.code === null || result.code === 2) return null
    if (result.aborted) throw new Error('搜索已中止')

    const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
    if (mode === 'filename') {
      const matches = lines
        .map((line) => line.replace(/\\/g, '/'))
        .filter((line) => line.toLowerCase().includes(input.query.toLowerCase()))
        .slice(0, max)
        .map((line) => this.displayPath(start, line))
      return { text: this.formatFilenameMatches(matches, lines.length > max) }
    }

    const out: string[] = []
    const hiddenSensitive = new Set<string>()
    let total = 0
    for (const line of lines) {
      const first = line.indexOf(':')
      const second = first < 0 ? -1 : line.indexOf(':', first + 1)
      if (second < 0) continue
      const relRaw = line.slice(0, first).replace(/\\/g, '/')
      const lineNo = Number(line.slice(first + 1, second))
      const content = line.slice(second + 1)
      if (!Number.isFinite(lineNo)) continue
      total += 1
      const rel = this.displayPath(start, relRaw)
      if (isSensitivePath(relRaw)) {
        if (!hiddenSensitive.has(relRaw) && out.length < max) {
          hiddenSensitive.add(relRaw)
          out.push(`${rel}: [敏感文件，已隐藏内容]`)
        }
        continue
      }
      if (out.length >= max) continue
      out.push(`${rel}:${lineNo}: ${truncate(content, 400)}`)
    }
    return { text: this.formatContentMatches(out, total > out.length) }
  }

  private searchFallback(
    start: ResolvedWorkspacePath,
    input: z.infer<typeof SEARCH_SCHEMA>,
    max: number
  ): ToolOutcome {
    const mode = input.mode ?? 'content'
    const matcher = makeGlobMatcher(input.glob)
    const results: string[] = []
    let visited = 0
    let truncated = false
    const stack: Array<{ abs: string; rel: string }> = [{ abs: start.abs, rel: start.rel }]

    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) break
      const listing = listDirectoryEntries(current.abs)
      if (!listing.ok) continue
      for (const entry of listing.entries) {
        if (entry.name === '.git') continue
        const rel = joinRel(current.rel, entry.name)
        const abs = join(current.abs, entry.name)
        if (entry.isDirectory()) {
          stack.push({ abs, rel })
          continue
        }
        if (entry.isSymbolicLink()) continue
        if (matcher !== null && !matcher(rel)) continue
        visited += 1
        if (visited > 5000) {
          truncated = true
          break
        }
        if (mode === 'filename') {
          if (rel.toLowerCase().includes(input.query.toLowerCase())) {
            results.push(this.displayPath(start, rel))
            if (results.length >= max) {
              truncated = true
              break
            }
          }
          continue
        }
        if (isSensitivePath(rel)) {
          results.push(`${this.displayPath(start, rel)}: [敏感文件，已隐藏内容]`)
          if (results.length >= max) {
            truncated = true
            break
          }
          continue
        }
        const file = readTextFile(abs, {
          maxBytes: MAX_SEARCH_FILE_BYTES,
          isBinary: (buffer) => buffer.includes(0)
        })
        if (!file.ok) continue
        const matches = findTextLines(file.text, input.query, {
          caseSensitive: true,
          max: max - results.length
        })
        for (const match of matches) {
          results.push(
            `${this.displayPath(start, rel)}:${match.line}: ${truncate(match.text.trim(), 400)}`
          )
          if (results.length >= max) {
            truncated = true
            break
          }
        }
        if (results.length >= max) break
      }
      if (results.length >= max) break
    }
    if (mode === 'filename') return { text: this.formatFilenameMatches(results, truncated) }
    return { text: this.formatContentMatches(results, truncated) }
  }

  private formatFilenameMatches(matches: string[], truncated: boolean): string {
    if (matches.length === 0) return '未找到匹配的文件。'
    return `匹配文件（${matches.length}）：\n${matches.join('\n')}${truncated ? '\n… 结果已截断' : ''}`
  }

  private formatContentMatches(matches: string[], truncated: boolean): string {
    if (matches.length === 0) return '未找到匹配的内容。'
    return `匹配内容（${matches.length}）：\n${matches.join('\n')}${truncated ? '\n… 结果已截断' : ''}`
  }

  // ------------------------------------------------------------------ 写

  private write(input: z.infer<typeof WRITE_SCHEMA>, ctx: ToolContext): ToolOutcome {
    const resolved = this.guard.resolve(input.path, { mustExist: false })
    this.guard.assertMutable(resolved)
    const bytes = Buffer.byteLength(input.content, 'utf8')
    if (bytes > MAX_WRITE_BYTES) return fail('WS_TOO_LARGE', `内容超过 ${formatSize(MAX_WRITE_BYTES)} 上限`)
    if (resolved.exists && !resolved.isFile) return fail('WS_NOT_FILE', '目标是目录，不能作为文件写入')
    if (!resolved.exists) {
      if (input.create !== true) return fail('WS_NOT_FOUND', '目标不存在；新建文件请传 create: true')
      if (!existsSync(dirname(resolved.abs))) return fail('WS_PARENT_MISSING', '父目录不存在')
      if (!statSync(dirname(resolved.abs)).isDirectory()) return fail('WS_PARENT_MISSING', '父路径不是目录')
    }
    const existing = resolved.exists ? this.loadText(resolved) : null
    if (existing !== null) this.assertReadBeforeWrite(resolved, existing)
    if (existing !== null && existing.text === input.content) {
      this.rememberNoteArtifact(resolved, input.content, ctx.taskId)
      return {
        text: `内容未变化：${resolved.display}`,
        meta: this.writeMeta(resolved, input.content)
      }
    }
    const opId = this.undo.recordWrite(resolved.abs, existing?.text ?? null, ctx.sessionId, ctx.turn)
    try {
      atomicWrite(resolved.abs, input.content)
      this.undo.commit(opId)
    } catch (error) {
      this.undo.cancel(opId)
      throw error
    }
    this.rememberWrite(resolved, input.content)
    this.rememberNoteArtifact(resolved, input.content, ctx.taskId)
    return {
      text: `${resolved.exists ? '已覆盖' : '已创建'}：${resolved.display}（${formatSize(bytes)}）`,
      meta: this.writeMeta(resolved, input.content)
    }
  }

  private writeMeta(
    resolved: ResolvedWorkspacePath,
    content: string
  ): { fingerprint: string; targetKind: 'note' | 'file'; targetRef: string; targetLabel: string; expectedStateRef: string } {
    return {
      fingerprint: hashOf(Buffer.from(content, 'utf8')),
      expectedStateRef: hashOf(Buffer.from(content, 'utf8')),
      targetKind: resolved.isNotes ? 'note' : 'file',
      targetLabel: resolved.display,
        targetRef: 'path:' + stateHash(resolved.real).slice(0, 16)
    }
  }

  private replace(input: z.infer<typeof REPLACE_SCHEMA>, ctx: ToolContext): ToolOutcome {
    const resolved = this.guard.resolve(input.path, { mustExist: true })
    this.guard.assertMutable(resolved)
    if (!resolved.isFile) return fail('WS_NOT_FILE', '目标不是文件')
    const current = this.loadText(resolved)
    this.assertReadBeforeWrite(resolved, current)
    const edited = applyExactTextEdit(current.text, input.old_text, input.new_text)
    if (!edited.ok) {
      if (edited.reason === 'no-match') {
        return fail('WS_NO_MATCH', '没有找到要替换的文本，请重新读取后再试')
      }
      if (edited.reason === 'ambiguous') {
        return fail('WS_NOT_UNIQUE', 'old_text 出现多次；请提供更长、唯一的上下文')
      }
      return fail('WS_NO_MATCH', '要替换的文本不能为空')
    }
    const updated = edited.text
    if (Buffer.byteLength(updated, 'utf8') > MAX_WRITE_BYTES) {
      return fail('WS_TOO_LARGE', `结果超过 ${formatSize(MAX_WRITE_BYTES)} 上限`)
    }
    const opId = this.undo.recordWrite(resolved.abs, current.text, ctx.sessionId, ctx.turn)
    try {
      atomicWrite(resolved.abs, updated)
      this.undo.commit(opId)
    } catch (error) {
      this.undo.cancel(opId)
      throw error
    }
    this.rememberWrite(resolved, updated)
    this.rememberNoteArtifact(resolved, updated, ctx.taskId)
    return {
      text: `已替换：${resolved.display}（1 处）`,
      meta: this.writeMeta(resolved, updated)
    }
  }

  // ------------------------------------------------------------------ 删/移

  private delete(input: z.infer<typeof DELETE_SCHEMA>, ctx: ToolContext): ToolOutcome {
    const resolved = this.guard.resolve(input.path, { mustExist: true })
    this.guard.assertMutable(resolved)
    if (resolved.isSymbolicLink) return fail('WS_SYMLINK_DENIED', '不直接删除符号链接，请先确认其真实路径')
    this.undo.recordDelete(resolved.abs, ctx.sessionId, ctx.turn)
    this.clearReads(resolved.abs)
    return { text: `已移入应用回收站：${resolved.display}（可撤销）` }
  }

  private move(input: z.infer<typeof MOVE_SCHEMA>, ctx: ToolContext): ToolOutcome {
    const source = this.guard.resolve(input.from, { mustExist: true })
    const dest = this.guard.resolve(input.to, { mustExist: false })
    this.guard.assertMutable(source)
    this.guard.assertMutable(dest)
    if (source.isSymbolicLink) return fail('WS_SYMLINK_DENIED', '不直接移动符号链接')
    if (dest.exists) return fail('WS_DEST_EXISTS', '目标已存在；请换一个名字')
    if (source.isDirectory && isPathInside(source.abs, dest.abs)) {
      return fail('WS_BAD_MOVE', '不能把目录移动到它自己内部')
    }
    if (!existsSync(dirname(dest.abs))) return fail('WS_PARENT_MISSING', '目标父目录不存在')
    const opId = this.undo.recordMove(source.abs, dest.abs, ctx.sessionId, ctx.turn)
    try {
      movePath(source.abs, dest.abs)
    } catch (error) {
      this.undo.cancel(opId)
      throw error
    }
    this.clearReads(source.abs)
    return { text: `已移动：${source.display} → ${dest.display}（可撤销）` }
  }

  // ------------------------------------------------------------------ 审批预览

  private writeApproval(raw: unknown): ApprovalInfo {
    const parsed = WRITE_SCHEMA.safeParse(raw)
    if (!parsed.success) return invalidApproval('写入文件', raw)
    const input = parsed.data
    try {
      const resolved = this.guard.resolve(input.path, { mustExist: false })
      const abs = resolved.display
      const oldText = resolved.exists ? this.readForDiff(resolved) : null
      const existed = oldText !== null
      const patch =
        oldText === null
          ? createTwoFilesPatch('/dev/null', abs, '', input.content, '', '', { context: 3 })
          : createTwoFilesPatch(`a/${abs}`, `b/${abs}`, oldText, input.content, 'before', 'after', {
              context: 3
            })
      const risk = this.mutationRisk(resolved)
      return {
        summary: `${existed ? '覆盖' : '新建'}文件：${abs}${risk === 'high' ? '（高风险）' : ''}`,
        preview: {
          kind: 'diff',
          title: `${existed ? '写入' : '新建'} ${abs}`,
          path: abs,
          diff: truncate(patch, 14_000)
        },
        risk
      }
    } catch (error) {
      return {
        summary: `写入文件：${input.path}`,
        preview: { kind: 'text', title: '无法预览', path: input.path, body: messageOf(error) },
        risk: 'high'
      }
    }
  }

  private replaceApproval(raw: unknown): ApprovalInfo {
    const parsed = REPLACE_SCHEMA.safeParse(raw)
    if (!parsed.success) return invalidApproval('替换文件内容', raw)
    const input = parsed.data
    try {
      const resolved = this.guard.resolve(input.path, { mustExist: true })
      const oldText = this.readForDiff(resolved) ?? ''
      const first = oldText.indexOf(input.old_text)
      const updated = first < 0 ? oldText : replaceFirstText(oldText, input.old_text, input.new_text)
      const patch = createTwoFilesPatch(
        `a/${resolved.display}`,
        `b/${resolved.display}`,
        oldText,
        updated,
        'before',
        'after',
        { context: 3 }
      )
      const risk = this.mutationRisk(resolved)
      return {
        summary: `替换 ${resolved.display} 中的文本${risk === 'high' ? '（高风险）' : ''}`,
        preview: {
          kind: 'diff',
          title: `替换 ${resolved.display}`,
          path: resolved.display,
          diff: truncate(
            first < 0 ? `${patch}\n（注意：old_text 当前未找到，执行时会失败）` : patch,
            14_000
          )
        },
        risk
      }
    } catch (error) {
      return {
        summary: `替换文件内容：${input.path}`,
        preview: { kind: 'text', title: '无法预览', path: input.path, body: messageOf(error) },
        risk: 'high'
      }
    }
  }

  private mutationRisk(resolved: ResolvedWorkspacePath): 'medium' | 'high' {
    if (isSensitivePath(resolved.rel) || isHeavyDir(resolved.rel)) return 'high'
    return 'medium'
  }

  // ------------------------------------------------------------------ 读状态

  private assertReadBeforeWrite(resolved: ResolvedWorkspacePath, current: { hash: string; size: number; mtimeMs: number }): void {
    const record = this.reads.get(normalizedForCompare(resolved.abs))
    if (record === undefined) throw new WorkspaceError('WS_NOT_READ', '覆盖前必须先读取该文件')
    if (Date.now() - record.at > READ_VALID_MS) throw new WorkspaceError('WS_STALE_READ', '读取已超过 30 分钟，请重新读取')
    if (
      record.hash !== current.hash ||
      record.size !== current.size ||
      record.mtimeMs !== current.mtimeMs
    ) {
      throw new WorkspaceError('WS_CHANGED', '文件在读取后被修改过，请重新读取后再写')
    }
  }

  private loadText(resolved: ResolvedWorkspacePath): {
    text: string
    hash: string
    size: number
    mtimeMs: number
  } {
    const file = readTextFile(resolved.abs, {
      maxBytes: MAX_READ_BYTES,
      isBinary: (buffer) => buffer.includes(0),
      stripBom: true
    })
    if (!file.ok) {
      if (file.reason === 'not-file') throw new WorkspaceError('WS_NOT_FILE', '目标不是文件')
      if (file.reason === 'too-large') {
        throw new WorkspaceError('WS_TOO_LARGE', `文件超过 ${formatSize(MAX_READ_BYTES)}，拒绝读取`)
      }
      if (file.reason === 'binary') {
        throw new WorkspaceError('WS_BINARY', '看起来是二进制文件，拒绝按文本读取')
      }
      throw file.error
    }
    return {
      text: file.text,
      hash: hashOf(file.buffer),
      size: file.size,
      mtimeMs: file.mtimeMs
    }
  }

  /** diff 预览用；超大文件只返回 null（审批卡显示缺失）。 */
  private readForDiff(resolved: ResolvedWorkspacePath): string | null {
    const file = readTextFile(resolved.abs, {
      maxBytes: MAX_READ_BYTES,
      isBinary: (buffer) => buffer.includes(0)
    })
    return file.ok ? file.text : null
  }

  private rememberWrite(resolved: ResolvedWorkspacePath, text: string): void {
    const buffer = Buffer.from(text, 'utf8')
    const stat = statSync(resolved.abs)
    this.reads.set(normalizedForCompare(resolved.abs), {
      hash: hashOf(buffer),
      size: buffer.length,
      mtimeMs: stat.mtimeMs,
      at: Date.now()
    })
  }

  private displayPath(start: ResolvedWorkspacePath, rel: string): string {
    let normalized = rel.replace(/\\/g, '/')
    while (normalized.startsWith('./')) normalized = normalized.slice(2)
    if (!start.isNotes) return normalized === '' || normalized === '.' ? '.' : normalized
    return normalized === '' || normalized === '.' ? 'notes' : `notes/${normalized}`
  }

  /**
   * 记录任务写过的笔记路径与标题；只保存在内存，不读取正文。
   * 这是主动对话 Episode 中笔记路径的唯一来源。
   */
  private rememberNoteArtifact(
    resolved: ResolvedWorkspacePath,
    text: string,
    taskId: string | undefined
  ): void {
    if (!resolved.isNotes || taskId === undefined || taskId === '') return
    const list = this.noteArtifacts.get(taskId) ?? []
    const artifact: NoteArtifact = {
      path: resolved.display,
      title: noteTitle(resolved, text),
      taskId,
      at: Date.now()
    }
    const next = list.filter((entry) => entry.path !== artifact.path)
    next.push(artifact)
    if (next.length > MAX_NOTE_ARTIFACTS_PER_TASK) {
      next.splice(0, next.length - MAX_NOTE_ARTIFACTS_PER_TASK)
    }
    this.noteArtifacts.set(taskId, next)
  }

  private clearReads(path: string): void {
    const target = normalizedForCompare(path)
    for (const key of this.reads.keys()) {
      if (key === target || key.startsWith(`${target}\\`) || key.startsWith(`${target}/`)) {
        this.reads.delete(key)
      }
    }
  }

  private failure(error: unknown): ToolOutcome {
    if (error instanceof WorkspaceError) return fail(error.code, error.message)
    this.logger.warn('工作区工具失败', { error: String(error) })
    return fail('TOOL_FAILED', messageOf(error))
  }
}

// ---------------------------------------------------------------------------

function fail(code: string, message: string): ToolOutcome {
  return { text: `[${code}] ${message}`, failed: true }
}

function invalidApproval(title: string, raw: unknown): ApprovalInfo {
  return {
    summary: title,
    preview: { kind: 'text', title, body: truncate(JSON.stringify(raw), 2000) },
    risk: 'high'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function joinRel(base: string, name: string): string {
  return base === '' || base === '.' ? name : `${base}/${name}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function hashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 笔记标题：首个非空行，去 Markdown 标记；含 URL/绝对路径时退回文件名。 */
function noteTitle(resolved: ResolvedWorkspacePath, text: string): string {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '')
  if (first !== undefined) {
    const cleaned = first.replace(/^#+\s*/, '').trim()
    if (cleaned !== '' && !/https?:\/\//i.test(cleaned) && !/[A-Za-z]:[\\/]/.test(cleaned)) {
      return cleaned.slice(0, 80)
    }
  }
  return basename(resolved.abs).slice(0, 80)
}

function makeGlobMatcher(glob: string | undefined): ((rel: string) => boolean) | null {
  if (glob === undefined || glob.trim() === '') return null
  const pattern = glob
    .replace(/\\/g, '/')
    .split('')
    .map((char) => {
      if (char === '*') return '\u0000'
      if (char === '?') return '\u0001'
      return char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
    .replace(/\u0000\u0000/g, '.*')
    .replace(/\u0000/g, '[^/]*')
    .replace(/\u0001/g, '[^/]')
  let regex: RegExp
  try {
    regex = new RegExp(`^${pattern}$`, 'i')
  } catch {
    return null
  }
  return (rel) => regex.test(rel.replace(/\\/g, '/'))
}

interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
  aborted: boolean
}

function runProcess(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
  signal: AbortSignal
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ code: null, stdout: '', stderr: '', aborted: true })
      return
    }
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let aborted = false
    let oversized = false
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, aborted })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    timer.unref?.()
    const onAbort = (): void => {
      aborted = true
      child.kill()
      finish(null)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (oversized) return
      stdout += chunk.toString('utf8')
      if (stdout.length > maxBytes) {
        oversized = true
        stdout = stdout.slice(0, maxBytes)
        child.kill()
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 20_000) stderr += chunk.toString('utf8')
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
  })
}

