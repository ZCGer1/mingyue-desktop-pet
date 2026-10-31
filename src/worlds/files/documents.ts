import { inflateRawSync } from 'node:zlib'
import { posix } from 'node:path'
import { extractPdfText } from './pdfText'

/**
 * 文档正文解析（只读、纯内存）。Office/ODF/EPUB 都是 ZIP + XML，
 * 这里不引入额外依赖，也不把文件解压到磁盘。
 *
 * 解析结果与普通文本一样是不可信数据；调用方负责脱敏、分页与当轮可见。
 */

const MAX_ZIP_ENTRIES = 20_000
const MAX_ZIP_COMPRESSED = 64 * 1024 * 1024
const MAX_ZIP_ENTRY = 64 * 1024 * 1024
const MAX_ZIP_TOTAL = 128 * 1024 * 1024
const MAX_DOCUMENT_CHARS = 2_000_000
const MAX_CELLS = 20_000
const MAX_SLIDES = 2_000

export const PARSED_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.docx',
  '.pptx',
  '.xlsx',
  '.odt',
  '.ods',
  '.odp',
  '.epub'
])

/** 旧式二进制 Office 格式没有可靠、无 Office 依赖的解析器。 */
export const LEGACY_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.doc',
  '.ppt',
  '.xls'
])

export class DocumentParseError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'DocumentParseError'
    this.code = code
  }
}

export interface ParsedDocument {
  text: string
  format: string
  /** 可供模型理解的页数/工作表数；未知时为 null。 */
  units: number | null
  warnings: string[]
}

export function parseDocumentBuffer(buffer: Buffer, ext: string): ParsedDocument {
  const normalized = ext.toLowerCase()
  if (!PARSED_DOCUMENT_EXTENSIONS.has(normalized)) {
    throw new DocumentParseError('FILES_FORMAT_UNSUPPORTED', `暂不支持解析 ${ext} 正文。`)
  }
  let parsed: ParsedDocument
  try {
    switch (normalized) {
      case '.docx':
        parsed = parseDocx(buffer)
        break
      case '.pptx':
        parsed = parsePptx(buffer)
        break
      case '.xlsx':
        parsed = parseXlsx(buffer)
        break
      case '.odt':
      case '.ods':
      case '.odp':
        parsed = parseOpenDocument(buffer, normalized)
        break
      case '.epub':
        parsed = parseEpub(buffer)
        break
      case '.pdf':
        parsed = parsePdf(buffer)
        break
      default:
        throw new DocumentParseError('FILES_FORMAT_UNSUPPORTED', `暂不支持解析 ${ext} 正文。`)
    }
  } catch (error) {
    if (error instanceof DocumentParseError) throw error
    throw new DocumentParseError('FILES_PARSE_FAILED', '文档结构无法解析（可能已损坏或格式不符）。')
  }
  return capDocument(parsed)
}

function capDocument(parsed: ParsedDocument): ParsedDocument {
  let text = normalizeText(parsed.text)
  const warnings = [...parsed.warnings]
  if (text.length > MAX_DOCUMENT_CHARS) {
    text = text.slice(0, MAX_DOCUMENT_CHARS)
    warnings.push('正文超过 200 万字符，已截断。')
  }
  return { ...parsed, text, warnings }
}

// --------------------------------------------------------------------- ZIP

interface ZipEntry {
  name: string
  data: Buffer
}

function readZip(buffer: Buffer): Map<string, ZipEntry> {
  if (buffer.length < 22) {
    throw new DocumentParseError('FILES_PARSE_FAILED', '文件太短，不是有效的 ZIP/Office 文档。')
  }
  const eocd = findEocd(buffer)
  if (eocd < 0) {
    throw new DocumentParseError('FILES_PARSE_FAILED', '找不到 ZIP 目录；可能不是有效的 Office 文档。')
  }
  const entriesTotal = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (
    entriesTotal === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new DocumentParseError('FILES_FORMAT_UNSUPPORTED', '暂不支持 ZIP64 文档。')
  }
  if (entriesTotal > MAX_ZIP_ENTRIES) {
    throw new DocumentParseError('FILES_TOO_LARGE', '文档内条目过多。')
  }
  if (directoryOffset + directorySize > buffer.length) {
    throw new DocumentParseError('FILES_PARSE_FAILED', 'ZIP 目录越界。')
  }

  const out = new Map<string, ZipEntry>()
  let total = 0
  let pointer = directoryOffset
  for (let index = 0; index < entriesTotal; index += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) {
      throw new DocumentParseError('FILES_PARSE_FAILED', 'ZIP 中央目录损坏。')
    }
    const flags = buffer.readUInt16LE(pointer + 8)
    const method = buffer.readUInt16LE(pointer + 10)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const uncompressedSize = buffer.readUInt32LE(pointer + 24)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const localOffset = buffer.readUInt32LE(pointer + 42)
    if (pointer + 46 + nameLength + extraLength + commentLength > buffer.length) {
      throw new DocumentParseError('FILES_PARSE_FAILED', 'ZIP 条目名称越界。')
    }
    const name = buffer
      .subarray(pointer + 46, pointer + 46 + nameLength)
      .toString('utf8')
      .replace(/\\/g, '/')
    pointer += 46 + nameLength + extraLength + commentLength

    if ((flags & 0x1) !== 0) {
      throw new DocumentParseError('FILES_FORMAT_UNSUPPORTED', '暂不支持加密文档。')
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new DocumentParseError('FILES_FORMAT_UNSUPPORTED', '暂不支持 ZIP64 文档。')
    }
    if (name.endsWith('/')) continue
    if (compressedSize > MAX_ZIP_COMPRESSED) {
      throw new DocumentParseError('FILES_TOO_LARGE', '文档内单个条目过大。')
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new DocumentParseError('FILES_PARSE_FAILED', 'ZIP 本地文件头损坏。')
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) {
      throw new DocumentParseError('FILES_PARSE_FAILED', 'ZIP 条目数据越界。')
    }
    const raw = buffer.subarray(dataStart, dataEnd)
    let data: Buffer
    if (method === 0) {
      data = raw
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: MAX_ZIP_ENTRY })
      } catch {
        throw new DocumentParseError('FILES_PARSE_FAILED', 'ZIP 条目解压失败。')
      }
    } else {
      throw new DocumentParseError(
        'FILES_FORMAT_UNSUPPORTED',
        `暂不支持 ZIP 压缩方式 ${String(method)}。`
      )
    }
    if (data.length > MAX_ZIP_ENTRY || data.length > uncompressedSize + 16) {
      throw new DocumentParseError('FILES_TOO_LARGE', 'ZIP 条目解压后大小异常。')
    }
    total += data.length
    if (total > MAX_ZIP_TOTAL) {
      throw new DocumentParseError('FILES_TOO_LARGE', '文档解压后总体积过大。')
    }
    out.set(name, { name, data })
  }
  return out
}

function findEocd(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - 65_557)
  for (let pointer = buffer.length - 22; pointer >= start; pointer -= 1) {
    if (buffer.readUInt32LE(pointer) === 0x06054b50) return pointer
  }
  return -1
}

function zipText(zip: Map<string, ZipEntry>, name: string): string {
  const entry = zip.get(name)
  if (entry === undefined) {
    throw new DocumentParseError('FILES_PARSE_FAILED', `文档缺少 ${name}。`)
  }
  return entry.data.toString('utf8')
}

// --------------------------------------------------------------------- XML

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

export function decodeXmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    })
    .replace(/&#(\d+);/g, (match, decimal: string) => {
      const code = Number.parseInt(decimal, 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    })
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => NAMED_ENTITIES[name] ?? match)
}

function xmlToText(fragment: string): string {
  return decodeXmlEntities(fragment.replace(/<[^>]*>/g, ''))
}

function readAttr(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag)
  if (match === null) return null
  return decodeXmlEntities(match[2] ?? match[3] ?? '')
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function capText(text: string, limit = MAX_DOCUMENT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

// ------------------------------------------------------------------- DOCX

function parseDocx(buffer: Buffer): ParsedDocument {
  const zip = readZip(buffer)
  const xml = zipText(zip, 'word/document.xml')
  const chunks: string[] = []
  let chars = 0
  const pattern =
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/?>|<\/w:(p|tc|tr)>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    if (chars >= MAX_DOCUMENT_CHARS) break
    if (match[1] !== undefined) {
      const text = decodeXmlEntities(match[1])
      chunks.push(text)
      chars += text.length
      continue
    }
    if (match[2] !== undefined) {
      chunks.push(match[2] === 'tab' ? '\t' : '\n')
      continue
    }
    if (match[3] === 'p') chunks.push('\n')
    else if (match[3] === 'tc') chunks.push('\t')
    else chunks.push('\n')
    chars += 1
  }
  return {
    text: chunks.join(''),
    format: 'docx',
    units: null,
    warnings: ['仅解析正文文本；图片、批注、修订痕迹和复杂排版不会还原。']
  }
}

// ------------------------------------------------------------------- PPTX

function parsePptx(buffer: Buffer): ParsedDocument {
  const zip = readZip(buffer)
  const slides = [...zip.keys()]
    .map((name) => ({ name, match: /^ppt\/slides\/slide(\d+)\.xml$/.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
    .map((item) => ({ name: item.name, number: Number(item.match[1]) }))
    .filter((item) => Number.isFinite(item.number))
    .sort((a, b) => a.number - b.number)
    .slice(0, MAX_SLIDES)
  if (slides.length === 0) {
    throw new DocumentParseError('FILES_PARSE_FAILED', '演示文稿里没有找到幻灯片。')
  }
  const chunks: string[] = []
  for (const slide of slides) {
    chunks.push(`\n--- 第 ${slide.number} 页 ---\n`)
    const xml = zipText(zip, slide.name)
    const pattern = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<\/a:p>/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(xml)) !== null) {
      if (match[1] !== undefined) chunks.push(decodeXmlEntities(match[1]))
      else chunks.push('\n')
      if (chunks.reduce((sum, item) => sum + item.length, 0) > MAX_DOCUMENT_CHARS) break
    }
  }
  return {
    text: chunks.join(''),
    format: 'pptx',
    units: slides.length,
    warnings: ['仅解析幻灯片文本；图表、图片、备注和动画不会还原。']
  }
}

// ------------------------------------------------------------------- XLSX

function parseXlsx(buffer: Buffer): ParsedDocument {
  const zip = readZip(buffer)
  const shared = parseSharedStrings(zip)
  const sheets = worksheetMap(zip)
  const chunks: string[] = []
  let cells = 0
  for (const sheet of sheets) {
    chunks.push(`\n--- ${sheet.label} ---\n`)
    const xml = zipText(zip, sheet.path)
    const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g
    let rowMatch: RegExpExecArray | null
    while ((rowMatch = rowPattern.exec(xml)) !== null && cells < MAX_CELLS) {
      const row = rowMatch[0]
      const rowNumber = readAttr(row.slice(0, row.indexOf('>') + 1), 'r')
      const values: string[] = []
      const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g
      let cellMatch: RegExpExecArray | null
      while ((cellMatch = cellPattern.exec(row)) !== null) {
        const attrs = cellMatch[1] ?? cellMatch[3] ?? ''
        const body = cellMatch[2] ?? ''
        const ref = readAttr(`<c ${attrs}>`, 'r')
        const type = readAttr(`<c ${attrs}>`, 't')
        const value = cellValue(body, type, shared)
        if (value === '') continue
        values.push(`${ref === null ? '' : `${ref}=`}${value}`)
        cells += 1
        if (cells >= MAX_CELLS) break
      }
      if (values.length > 0) {
        chunks.push(`${rowNumber === null ? '' : `第 ${rowNumber} 行：`}${values.join('\t')}\n`)
      }
    }
  }
  return {
    text: chunks.join(''),
    format: 'xlsx',
    units: sheets.length,
    warnings: ['单元格按存储值显示；公式、日期格式和图表不会完整还原。']
  }
}

function parseSharedStrings(zip: Map<string, ZipEntry>): string[] {
  const entry = zip.get('xl/sharedStrings.xml')
  if (entry === undefined) return []
  const xml = entry.data.toString('utf8')
  const out: string[] = []
  const pattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    const texts = [...(match[1] ?? '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((item) =>
      decodeXmlEntities(item[1] ?? '')
    )
    out.push(texts.join(''))
  }
  return out
}

function worksheetMap(
  zip: Map<string, ZipEntry>
): Array<{ label: string; path: string }> {
  const fallback = [...zip.keys()]
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
    .sort()
    .map((path, index) => ({ label: path.split('/').pop()?.replace(/\.xml$/i, '') ?? `sheet${index + 1}`, path }))
  if (fallback.length === 0) {
    throw new DocumentParseError('FILES_PARSE_FAILED', '工作簿里没有找到工作表。')
  }
  const workbook = zip.get('xl/workbook.xml')
  const rels = zip.get('xl/_rels/workbook.xml.rels')
  if (workbook === undefined || rels === undefined) return fallback
  try {
    const relTargets = new Map<string, string>()
    const relXml = rels.data.toString('utf8')
    for (const match of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = readAttr(match[0], 'Id')
      const target = readAttr(match[0], 'Target')
      if (id !== null && target !== null) {
        const normalized = target.replace(/\\/g, '/').replace(/^\/+/, '')
        relTargets.set(id, normalized.startsWith('xl/') ? normalized : posix.normalize(`xl/${normalized}`))
      }
    }
    const sheets: Array<{ label: string; path: string }> = []
    for (const match of workbook.data.toString('utf8').matchAll(/<sheet\b[^>]*>/g)) {
      const label = readAttr(match[0], 'name')
      const relId = readAttr(match[0], 'r:id')
      if (label === null || relId === null) continue
      const path = relTargets.get(relId)
      if (path === undefined || !zip.has(path)) continue
      sheets.push({ label, path })
    }
    return sheets.length > 0 ? sheets : fallback
  } catch {
    return fallback
  }
}

function cellValue(body: string, type: string | null, shared: readonly string[]): string {
  if (type === 's') {
    const index = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
    const parsed = index === undefined ? NaN : Number.parseInt(index.trim(), 10)
    return Number.isInteger(parsed) && parsed >= 0 && parsed < shared.length ? (shared[parsed] ?? '') : ''
  }
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((item) => decodeXmlEntities(item[1] ?? ''))
      .join('')
  }
  if (type === 'b') {
    const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]?.trim()
    return value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : ''
  }
  const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
  if (value !== undefined) return decodeXmlEntities(value).trim()
  return [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((item) => decodeXmlEntities(item[1] ?? ''))
    .join('')
}

// ---------------------------------------------------------------- ODF

function parseOpenDocument(buffer: Buffer, ext: string): ParsedDocument {
  const zip = readZip(buffer)
  const xml = zipText(zip, 'content.xml')
  const marked = xml
    .replace(/<text:(p|h)\b[^>]*>/g, '\n')
    .replace(/<\/text:(p|h)>/g, '\n')
    .replace(/<text:tab\b[^>]*\/>/g, '\t')
    .replace(/<text:line-break\b[^>]*\/>/g, '\n')
    .replace(/<text:s\b([^>]*)\/>/g, (_match, attrs: string) => {
      const count = Number.parseInt(readAttr(`<text:s ${attrs}>`, 'text:c') ?? '1', 10)
      return ' '.repeat(Number.isFinite(count) && count > 0 && count <= 80 ? count : 1)
    })
    .replace(/<\/table:table-cell>/g, '\t')
    .replace(/<\/table:table-row>/g, '\n')
    .replace(/<\/table:table>/g, '\n')
  const text = xmlToText(marked)
  return {
    text,
    format: ext.slice(1),
    units: null,
    warnings: ['仅解析文档文本；图片、图表和复杂排版不会还原。']
  }
}

// ------------------------------------------------------------------- EPUB

function parseEpub(buffer: Buffer): ParsedDocument {
  const zip = readZip(buffer)
  let opfPath: string | null = null
  const container = zip.get('META-INF/container.xml')
  if (container !== undefined) {
    const xml = container.data.toString('utf8')
    for (const match of xml.matchAll(/<rootfile\b[^>]*>/g)) {
      const fullPath = readAttr(match[0], 'full-path')
      if (fullPath !== null && zip.has(fullPath)) {
        opfPath = fullPath
        break
      }
    }
  }
  const chunks: string[] = []
  if (opfPath !== null) {
    const base = posix.dirname(opfPath)
    const opf = zipText(zip, opfPath)
    const manifest = new Map<string, string>()
    for (const match of opf.matchAll(/<item\b[^>]*>/g)) {
      const id = readAttr(match[0], 'id')
      const href = readAttr(match[0], 'href')
      if (id !== null && href !== null) {
        manifest.set(id, resolveZipPath(base, href))
      }
    }
    const spine: string[] = []
    for (const match of opf.matchAll(/<itemref\b[^>]*>/g)) {
      const idref = readAttr(match[0], 'idref')
      if (idref === null) continue
      const path = manifest.get(idref)
      if (path !== undefined && zip.has(path)) spine.push(path)
    }
    const paths = spine.length > 0 ? spine : [...manifest.values()].filter((path) => zip.has(path))
    for (const path of paths) {
      appendHtmlText(zipText(zip, path), chunks)
      if (chunks.reduce((sum, item) => sum + item.length, 0) > MAX_DOCUMENT_CHARS) break
    }
  }
  if (chunks.length === 0) {
    const paths = [...zip.keys()]
      .filter((name) => /\.(x?html?|xhtml)$/i.test(name))
      .sort()
    for (const path of paths) {
      appendHtmlText(zipText(zip, path), chunks)
      if (chunks.reduce((sum, item) => sum + item.length, 0) > MAX_DOCUMENT_CHARS) break
    }
  }
  if (chunks.length === 0) {
    throw new DocumentParseError('FILES_PARSE_FAILED', 'EPUB 里没有找到可读的正文。')
  }
  return {
    text: chunks.join(''),
    format: 'epub',
    units: null,
    warnings: ['仅解析电子书正文；图片、脚注样式与版式不会还原。']
  }
}

function resolveZipPath(base: string, href: string): string {
  const decoded = href.replace(/[?#].*$/, '')
  let unescaped = decoded
  try {
    unescaped = decodeURIComponent(decoded)
  } catch {
    /* 保留原字符串 */
  }
  return posix.normalize(posix.isAbsolute(unescaped) ? unescaped.slice(1) : posix.join(base, unescaped))
}

function appendHtmlText(html: string, chunks: string[]): void {
  const body =
    /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ??
    /<html\b[^>]*>([\s\S]*?)<\/html>/i.exec(html)?.[1] ??
    html
  const marked = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
  chunks.push(`${xmlToText(marked)}\n`)
}

// -------------------------------------------------------------------- PDF

function parsePdf(buffer: Buffer): ParsedDocument {
  const result = extractPdfText(buffer)
  if (result.text.trim() === '') {
    throw new DocumentParseError(
      'FILES_PDF_NO_TEXT',
      '这个 PDF 没有可提取的文本层（可能是扫描件/图片版）；不要假装读过内容。可以让用户用支持 OCR 的方式打开。'
    )
  }
  const warnings = [
    'PDF 只提取文本层；扫描件需要 OCR，复杂排版、表格与页眉页脚顺序可能不准确。'
  ]
  if (result.notes.length > 0) warnings.push(...result.notes)
  return {
    text: result.text,
    format: 'pdf',
    units: result.pages > 0 ? result.pages : null,
    warnings
  }
}
