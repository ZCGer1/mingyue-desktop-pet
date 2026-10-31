import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { join, sep } from 'node:path'
import type { AuditLog } from '../../core/audit'
import type { Logger } from '../../core/types'
import { atomicWrite, shortHash } from '../../core/util'

export const MEMORY_FILES = ['profile.md', 'boundaries.md', 'projects.md', 'recent.md', 'habits.md'] as const
export type MemoryFile = (typeof MEMORY_FILES)[number]

const DEFAULT_CONTENT: Record<MemoryFile, string> = {
  'profile.md': '# 关于你\n\n（还没有记录。你可以告诉我希望怎么称呼你。）\n',
  'boundaries.md': '# 边界\n\n（还没有记录。明确说过的边界会写在这里，优先级最高。）\n',
  'projects.md': '# 项目\n\n（还没有记录。正在做的事会整理在这里。）\n',
  'recent.md': '# 最近\n',
  'habits.md': '# 作息\n\n（仅在用户允许时记录类别级习惯，不含具体应用。）\n'
}

/** 注入时的字节/字符上限（PLAN.md §3.2）。 */
const INJECT_LIMITS: Record<MemoryFile, number> = {
  'profile.md': 2048,
  'boundaries.md': 2048,
  'projects.md': 4096,
  'recent.md': 3072,
  'habits.md': 2048
}

export const MEMORY_WRITE_LIMIT = 16 * 1024

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /authorization\s*:\s*bearer\s+\S+/i,
  /api[_-]?key\s*[=:]\s*\S+/i,
  /password\s*[=:]\s*\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]

export interface MemoryWriteResult {
  ok: boolean
  message: string
  bytes?: number
}

export interface MemoryEntryInfo {
  name: MemoryFile
  bytes: number
  modifiedAt: number
}

/**
 * Persona 的 Memory（PLAN.md §3.2）。只允许五个固定文件；
 * 每次写入都做路径/符号链接/长度检查并记审计，不把内容写进日志。
 */
export class MemoryStore {
  readonly dir: string
  private readonly enabled: () => boolean
  private readonly audit: AuditLog | null
  private readonly logger: Logger

  constructor(opts: { dir: string; enabled: () => boolean; audit?: AuditLog | null; logger: Logger }) {
    this.dir = opts.dir
    this.enabled = opts.enabled
    this.audit = opts.audit ?? null
    this.logger = opts.logger
  }

  /** 首次使用时创建空模板；已存在的文件绝不覆盖。 */
  ensureDefaults(): void {
    if (!this.enabled()) return
    try {
      mkdirSync(this.dir, { recursive: true })
      for (const name of MEMORY_FILES) {
        const file = join(this.dir, name)
        if (!existsSync(file)) atomicWrite(file, DEFAULT_CONTENT[name])
      }
    } catch (error) {
      this.logger.warn('Memory 初始化失败', { error: String(error) })
    }
  }

  isEnabled(): boolean {
    return this.enabled()
  }

  list(): MemoryEntryInfo[] {
    const out: MemoryEntryInfo[] = []
    for (const name of MEMORY_FILES) {
      const file = join(this.dir, name)
      try {
        const info = statSync(file)
        out.push({ name, bytes: info.size, modifiedAt: info.mtimeMs })
      } catch {
        out.push({ name, bytes: 0, modifiedAt: 0 })
      }
    }
    return out
  }

  /** 读取一个文件；仅接受白名单文件名。 */
  read(rawPath: string): { ok: true; name: MemoryFile; text: string } | { ok: false; message: string } {
    if (!this.enabled()) return { ok: false, message: '记忆功能已关闭' }
    const name = normaliseMemoryPath(rawPath)
    if (name === null) return { ok: false, message: '只能访问 memory 目录下的 profile/boundaries/projects/recent/habits' }
    const file = this.safeFile(name)
    if (file === null) return { ok: false, message: '记忆文件路径不合法' }
    try {
      return { ok: true, name, text: readFileSync(file, 'utf8') }
    } catch {
      return { ok: true, name, text: DEFAULT_CONTENT[name] }
    }
  }

  /** 注入系统提示的内容；关闭记忆或文件不存在时为空。 */
  readForPrompt(includeHabits: boolean): Array<{ name: MemoryFile; text: string }> {
    if (!this.enabled()) return []
    const out: Array<{ name: MemoryFile; text: string }> = []
    for (const name of MEMORY_FILES) {
      if (name === 'habits.md' && !includeHabits) continue
      const file = this.safeFile(name)
      if (file === null) continue
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      text = text.trim()
      if (text === '') continue
      // recent.md 只在末尾追加；从头部截断会让最新交接笔记永远不可见。
      // 其余文件（档案/边界/项目）仍按头部优先级注入。
      const limited =
        name === 'recent.md'
          ? buildRecentInjection(text, INJECT_LIMITS[name])
          : truncateChars(text, INJECT_LIMITS[name])
      out.push({ name, text: limited })
    }
    return out
  }

  write(rawPath: string, content: string, mode: 'replace' | 'append'): MemoryWriteResult {
    if (!this.enabled()) return { ok: false, message: '记忆功能已关闭' }
    const name = normaliseMemoryPath(rawPath)
    if (name === null) return { ok: false, message: '只能写 profile/boundaries/projects/recent/habits' }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MEMORY_WRITE_LIMIT) {
      return { ok: false, message: `单次写入不能超过 ${MEMORY_WRITE_LIMIT} 字节（当前 ${bytes}）` }
    }
    const secret = SECRET_PATTERNS.find((pattern) => pattern.test(content))
    if (secret !== undefined) {
      return { ok: false, message: '内容看起来包含密钥/密码，已拒绝写入记忆' }
    }
    const file = this.safeFile(name, true)
    if (file === null) return { ok: false, message: '记忆文件路径不合法' }
    try {
      mkdirSync(this.dir, { recursive: true })
      const previous = mode === 'append' && existsSync(file) ? readFileSync(file, 'utf8') : ''
      const next = mode === 'append' ? `${previous}${previous.endsWith('\n') || previous === '' ? '' : '\n'}${content}` : content
      atomicWrite(file, next)
      if (name === 'recent.md') this.pruneRecent()
      this.audit?.write({
        kind: 'memory',
        session: 'main',
        tool: 'mem_write',
        summary: `${name} len=${bytes} hash=${shortHash(content)} mode=${mode}`,
        result: 'ok'
      })
      return { ok: true, message: `已${mode === 'append' ? '追加' : '写入'} ${name}（${bytes} 字节）`, bytes }
    } catch (error) {
      this.logger.warn('Memory 写入失败', { file: name, error: String(error) })
      return { ok: false, message: `写入失败：${String(error)}` }
    }
  }

  appendRecent(note: string): void {
    if (!this.enabled()) return
    const trimmed = note.trim()
    if (trimmed === '') return
    const result = this.write('recent.md', `\n## ${new Date().toLocaleString('zh-CN', { hour12: false })}\n${trimmed}\n`, 'append')
    if (!result.ok) this.logger.warn('交接笔记写入失败', { message: result.message })
  }

  search(query: string, limit = 20): Array<{ name: MemoryFile; line: number; text: string }> {
    if (!this.enabled() || query.trim() === '') return []
    const needle = query.toLowerCase()
    const out: Array<{ name: MemoryFile; line: number; text: string }> = []
    for (const name of MEMORY_FILES) {
      const file = this.safeFile(name)
      if (file === null) continue
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length && out.length < limit; i += 1) {
        const line = lines[i] ?? ''
        if (line.toLowerCase().includes(needle)) out.push({ name, line: i + 1, text: line.slice(0, 300) })
      }
      if (out.length >= limit) break
    }
    return out
  }

  /** 删除整个文件，或删除包含 query 的行。 */
  forget(target: { path?: string; query?: string }): { ok: boolean; message: string } {
    if (!this.enabled()) return { ok: false, message: '记忆功能已关闭' }
    if (target.path !== undefined) {
      const name = normaliseMemoryPath(target.path)
      if (name === null) return { ok: false, message: '只能删除记忆白名单文件' }
      const file = this.safeFile(name)
      if (file === null) return { ok: false, message: '记忆文件路径不合法' }
      try {
        if (existsSync(file)) unlinkSync(file)
        atomicWrite(file, DEFAULT_CONTENT[name])
        this.audit?.write({
          kind: 'memory',
          session: 'main',
          tool: 'mem_forget',
          summary: `${name} cleared`,
          result: 'ok'
        })
        return { ok: true, message: `已清空 ${name}` }
      } catch (error) {
        return { ok: false, message: `清空失败：${String(error)}` }
      }
    }
    if (target.query !== undefined && target.query.trim() !== '') {
      const needle = target.query.toLowerCase()
      let removed = 0
      for (const name of MEMORY_FILES) {
        const file = this.safeFile(name)
        if (file === null) continue
        let text = ''
        try {
          text = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        const lines = text.split(/\r?\n/)
        const kept = lines.filter((line) => !line.toLowerCase().includes(needle))
        removed += lines.length - kept.length
        if (kept.length !== lines.length) atomicWrite(file, kept.join('\n'))
      }
      this.audit?.write({
        kind: 'memory',
        session: 'main',
        tool: 'mem_forget',
        summary: `query hash=${shortHash(target.query)} removed=${removed}`,
        result: 'ok'
      })
      return { ok: true, message: removed === 0 ? '没有找到匹配的记忆' : `已删除 ${removed} 行相关记忆` }
    }
    return { ok: false, message: '需要提供 path 或 query' }
  }

  /**
   * 用户主动清空全部本地记忆。即使记忆功能已关闭也允许调用，
   * 因为文件可能仍然存在；这里只恢复默认模板，不写审计内容。
   */
  clearAll(): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      for (const name of MEMORY_FILES) {
        atomicWrite(join(this.dir, name), DEFAULT_CONTENT[name])
      }
      this.logger.info('全部记忆已由用户清空')
    } catch (error) {
      this.logger.warn('清空记忆失败', { error: String(error) })
    }
  }

  /** 设置页使用：返回所有文件内容（不经过模型）。 */
  snapshot(): Array<{ name: MemoryFile; text: string }> {
    return MEMORY_FILES.map((name) => {
      const file = this.safeFile(name)
      let text = ''
      try {
        text = file === null ? '' : readFileSync(file, 'utf8')
      } catch {
        text = ''
      }
      return { name, text }
    })
  }

  filesInDir(): string[] {
    try {
      return readdirSync(this.dir)
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------------------

  private safeFile(name: MemoryFile, allowMissing = false): string | null {
    let realDir: string
    try {
      mkdirSync(this.dir, { recursive: true })
      realDir = realpathSync(this.dir)
    } catch {
      return null
    }
    const file = join(realDir, name)
    try {
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) {
        this.logger.warn('Memory 文件是符号链接，已拒绝')
        return null
      }
      const realFile = realpathSync(file)
      if (!realFile.startsWith(realDir.endsWith(sep) ? realDir : `${realDir}${sep}`)) return null
      return realFile
    } catch {
      return allowMissing ? file : file
    }
  }

  /**
   * recent.md 只在达到上限时清理。按 Markdown 时间块整体保留，避免留下
   * 半条交接笔记；最新一条块本身超限时只截断它自己。
   */
  private pruneRecent(): void {
    const file = this.safeFile('recent.md')
    if (file === null) return
    try {
      const text = readFileSync(file, 'utf8')
      if (Buffer.byteLength(text, 'utf8') <= 16 * 1024) return
      const { header, blocks } = splitRecentBlocks(text)
      if (blocks.length === 0) {
        const lines = text.split(/\r?\n/)
        const kept: string[] = []
        let bytes = 0
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i] ?? ''
          bytes += Buffer.byteLength(line, 'utf8') + 1
          if (bytes > 12 * 1024) break
          kept.unshift(line)
        }
        atomicWrite(file, `${kept.join('\n')}\n`)
        return
      }
      const kept: string[] = []
      let bytes = 0
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i] ?? ''
        const size = Buffer.byteLength(block, 'utf8')
        if (bytes + size <= 12 * 1024) {
          kept.unshift(block)
          bytes += size
          continue
        }
        if (kept.length === 0) kept.unshift(truncateToBytes(block, 12 * 1024))
        break
      }
      atomicWrite(file, [header, ...kept].filter((part) => part !== '').join('\n\n') + '\n')
    } catch {
      /* ignore */
    }
  }
}

export function normaliseMemoryPath(raw: string): MemoryFile | null {
  const cleaned = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (cleaned === '' || cleaned.includes('..')) return null
  const parts = cleaned.split('/')
  const base = (parts[parts.length - 1] ?? '').toLowerCase()
  if (!(MEMORY_FILES as readonly string[]).includes(base)) return null
  if (parts.length > 1 && !(parts.length === 2 && parts[0]?.toLowerCase() === 'memory')) return null
  return base as MemoryFile
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…（记忆内容过长，已截断）`
}

const RECENT_BLOCK_HEADING = /^##(?!#)\s+\S/
const EARLIER_OMITTED = '…（更早的记忆已省略）'

/**
 * 把 recent.md 拆成标题与若干「## 时间」块。块是注入和清理的最小单位；
 * 没有块的旧文件由调用方走行级兜底。
 */
function splitRecentBlocks(text: string): { header: string; blocks: string[] } {
  const lines = text.split(/\r?\n/)
  const headerLines: string[] = []
  const blocks: string[][] = []
  let current: string[] | null = null
  for (const line of lines) {
    if (RECENT_BLOCK_HEADING.test(line)) {
      if (current !== null) blocks.push(current)
      current = [line]
    } else if (current === null) {
      headerLines.push(line)
    } else {
      current.push(line)
    }
  }
  if (current !== null) blocks.push(current)
  // 旧版 recent.md 可能没有「## 时间」块，只有一大段正文。把首行标题之外的
  // 正文当成最旧的一个块，避免它被当成 header 无上限地注入。
  const preambleText = headerLines.join('\n').trim()
  const leadingBlocks: string[] = []
  let header = ''
  if (preambleText !== '') {
    const preambleLines = preambleText.split(/\r?\n/)
    const first = preambleLines[0] ?? ''
    if (/^#(?!#)\s/.test(first)) {
      header = first
      const rest = preambleLines.slice(1).join('\n').trim()
      if (rest !== '') leadingBlocks.push(rest)
    } else {
      leadingBlocks.push(preambleText)
    }
  }
  return {
    header,
    blocks: [
      ...leadingBlocks,
      ...blocks.map((block) => block.join('\n').trim()).filter((block) => block !== '')
    ]
  }
}

/** 注入 recent.md：保留标题，从最新块往前选整块，再按时间顺序拼回。 */
function buildRecentInjection(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const { header, blocks } = splitRecentBlocks(text)
  if (blocks.length === 0) {
    return `${EARLIER_OMITTED}\n${tailCharsAtLineBoundary(text, maxChars - EARLIER_OMITTED.length - 1)}`
  }
  const reserve = header === '' ? EARLIER_OMITTED.length + 2 : header.length + EARLIER_OMITTED.length + 4
  let remaining = Math.max(200, maxChars - reserve)
  const kept: string[] = []
  let omitted = false
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i] ?? ''
    if (block.length <= remaining) {
      kept.unshift(block)
      remaining -= block.length + 2
      continue
    }
    if (kept.length === 0) {
      // 最新一条块本身就超预算：保留它的开头（包含时间和结论），而不是丢掉。
      kept.unshift(truncateChars(block, Math.max(200, remaining)))
    }
    omitted = true
    break
  }
  if (kept.length < blocks.length) omitted = true
  return [header, omitted ? EARLIER_OMITTED : '', ...kept]
    .filter((part) => part !== '')
    .join('\n\n')
}

/** 从末尾按整行取文本，避免截出半行；单行超限时才按字符截断。 */
function tailCharsAtLineBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  let length = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? ''
    if (length + line.length + 1 > maxChars) break
    kept.unshift(line)
    length += line.length + 1
  }
  if (kept.length === 0) return text.slice(-maxChars)
  return kept.join('\n')
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = ''
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    out += char
    bytes += size
  }
  return `${out}\n…（更早的记忆已省略）`
}
