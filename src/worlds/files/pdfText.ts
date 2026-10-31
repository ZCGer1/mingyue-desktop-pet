import { inflateSync } from 'node:zlib'

/**
 * 轻量 PDF 文本层提取：不依赖原生模块，只解析未加密 PDF 的文本对象。
 *
 * 支持：未压缩/Flate/ASCIIHex/ASCII85 内容流，常见的 Tj/TJ/'/" 文本操作符，
 * 以及 ToUnicode CMap 中的 bfchar/bfrange（可还原部分中文 PDF）。
 * 不支持：扫描件 OCR、加密 PDF、对象流中的文本、复杂字体编码与版式。
 * 任何不确定都通过 warnings 说明，不把空白当成“读到了”。
 */

const MAX_STREAMS = 5_000
const MAX_STREAM_BYTES = 32 * 1024 * 1024
const MAX_TEXT_CHARS = 2_000_000
const MAX_CMAP_ENTRIES = 200_000

export interface PdfTextResult {
  text: string
  pages: number
  notes: string[]
}

interface CMapTable {
  map: Map<string, string>
  codeLengths: number[]
}

export function extractPdfText(buffer: Buffer): PdfTextResult {
  const source = buffer.toString('latin1')
  const notes: string[] = []
  if (!source.startsWith('%PDF-')) {
    notes.push('文件头不是 %PDF-，解析结果可能不可靠。')
  }
  const pages = countPages(source)
  const cmap: CMapTable = { map: new Map(), codeLengths: [] }
  const streams: string[] = []
  let decodedBytes = 0
  let scanned = 0

  const pattern = /stream(?:\r\n|\n|\r)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    if (streams.length >= MAX_STREAMS || decodedBytes >= MAX_STREAM_BYTES) break
    const dataStart = match.index + match[0].length
    const objectStart = source.lastIndexOf('obj', match.index)
    const dictStart = objectStart < 0 ? Math.max(0, match.index - 4_096) : objectStart + 3
    const dict = source.slice(dictStart, match.index)
    if (/\/Subtype\s*\/Image\b/.test(dict)) continue
    if (/\/Type\s*\/XRef\b/.test(dict)) continue
    const length = directLength(dict, source)
    let dataEnd = -1
    if (length !== null && dataStart + length <= source.length) {
      dataEnd = dataStart + length
    } else {
      const end = source.indexOf('endstream', dataStart)
      if (end < 0) continue
      dataEnd = end
      while (dataEnd > dataStart && (source[dataEnd - 1] === '\n' || source[dataEnd - 1] === '\r')) {
        dataEnd -= 1
      }
    }
    if (dataEnd <= dataStart || dataEnd - dataStart > MAX_STREAM_BYTES) continue
    const raw = buffer.subarray(dataStart, dataEnd)
    const decoded = decodeFilters(raw, dict)
    if (decoded === null) {
      scanned += 1
      continue
    }
    decodedBytes += decoded.length
    if (decodedBytes > MAX_STREAM_BYTES * 4) {
      notes.push('PDF 解压后的内容流过大，只解析前一部分。')
      break
    }
    const content = decoded.toString('latin1')
    if (content.includes('begincmap')) {
      // 先收集所有 ToUnicode 表，最后再抽取正文，避免 CMap 晚于正文流出现。
      mergeCMap(cmap, parseCMap(content), notes)
      continue
    }
    if (!content.includes('BT')) continue
    streams.push(content)
  }

  const chunks: string[] = []
  let textChars = 0
  for (const content of streams) {
    if (textChars >= MAX_TEXT_CHARS) break
    scanned += 1
    const text = extractContentText(content, cmap)
    if (text === '') continue
    chunks.push(text)
    textChars += text.length
  }

  let text = chunks.join('\n')
  text = normalizePdfText(text)
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS)
    notes.push('PDF 文本超过 200 万字符，已截断。')
  }
  if (text === '' && scanned > 0) {
    notes.push('找到了内容流，但没有可识别的文本操作符。')
  }
  if (text === '' && /\/Type\s*\/ObjStm\b/.test(source)) {
    notes.push('文本可能位于 PDF 对象流中，当前解析器不支持。')
  }
  return { text, pages, notes }
}

function countPages(source: string): number {
  let count = 0
  const pattern = /\/Type\s*\/Page\b/g
  while (pattern.exec(source) !== null) count += 1
  return count
}

function directLength(dict: string, source: string): number | null {
  const indirect = /\/Length\s+(\d+)\s+(\d+)\s+R/.exec(dict)
  if (indirect !== null) {
    const objectNumber = indirect[1]!
    const objectPattern = new RegExp(`(?:^|[^0-9])${objectNumber}\\s+\\d+\\s+obj\\s+(\\d+)`, 'g')
    const found = objectPattern.exec(source)
    if (found === null) return null
    const value = Number.parseInt(found[1]!, 10)
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  const direct = /\/Length\s+(\d+)/.exec(dict)
  if (direct === null) return null
  const value = Number.parseInt(direct[1]!, 10)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function decodeFilters(raw: Buffer, dict: string): Buffer | null {
  const filterMatch = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict)
  if (filterMatch === null) return raw
  const names = [...filterMatch[1]!.matchAll(/\/([A-Za-z0-9]+)/g)].map((item) => item[1]!)
  let data = raw
  // PDF 的 Filter 数组按编码顺序书写，解码时逆序执行。
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const name = names[index]!
    if (name === 'FlateDecode' || name === 'Fl') {
      try {
        data = inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES })
      } catch {
        return null
      }
    } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
      const decoded = decodeAsciiHex(data)
      if (decoded === null) return null
      data = decoded
    } else if (name === 'ASCII85Decode' || name === 'A85') {
      const decoded = decodeAscii85(data)
      if (decoded === null) return null
      data = decoded
    } else {
      // 图像编码、加密或未知过滤器不能安全地当文本解释。
      return null
    }
  }
  return data
}

function decodeAsciiHex(data: Buffer): Buffer | null {
  const text = data.toString('latin1').replace(/\s+/g, '').replace(/>$/, '')
  if (!/^[0-9a-fA-F]*$/.test(text)) return null
  const out = Buffer.alloc(Math.ceil(text.length / 2))
  for (let index = 0; index < out.length; index += 1) {
    const pair = text.slice(index * 2, index * 2 + 2)
    out[index] = Number.parseInt(pair.length === 1 ? `${pair}0` : pair, 16)
  }
  return out
}

function decodeAscii85(data: Buffer): Buffer | null {
  let text = data.toString('latin1').replace(/\s+/g, '')
  if (text.startsWith('<~')) text = text.slice(2)
  const end = text.indexOf('~>')
  if (end >= 0) text = text.slice(0, end)
  const out: number[] = []
  let group: number[] = []
  for (const char of text) {
    if (char === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    const code = char.charCodeAt(0)
    if (code < 33 || code > 117) return null
    group.push(code - 33)
    if (group.length === 5) {
      let value = 0
      for (const digit of group) value = value * 85 + digit
      if (value > 0xffffffff) return null
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
      group = []
    }
  }
  if (group.length > 0) {
    const missing = 5 - group.length
    for (let index = 0; index < missing; index += 1) group.push(84)
    let value = 0
    for (const digit of group) value = value * 85 + digit
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    out.push(...bytes.slice(0, 4 - missing))
  }
  return Buffer.from(out)
}

// ------------------------------------------------------------------ CMap

function mergeCMap(target: CMapTable, addition: CMapTable, notes: string[]): void {
  for (const [key, value] of addition.map) {
    if (target.map.size >= MAX_CMAP_ENTRIES) {
      notes.push('ToUnicode 表过大，仅使用前 20 万项。')
      return
    }
    if (!target.map.has(key)) target.map.set(key, value)
  }
  target.codeLengths = [...new Set([...target.codeLengths, ...addition.codeLengths])].sort(
    (a, b) => a - b
  )
}

function parseCMap(content: string): CMapTable {
  const table: CMapTable = { map: new Map(), codeLengths: [] }
  const add = (sourceHex: string, value: string): void => {
    const normalized = sourceHex.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
    if (normalized === '' || normalized.length > 8 || normalized.length % 2 !== 0) return
    if (!table.map.has(normalized)) table.map.set(normalized, value)
    const byteLength = normalized.length / 2
    if (!table.codeLengths.includes(byteLength)) table.codeLengths.push(byteLength)
  }
  for (const block of content.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      add(pair[1]!, hexToUnicode(pair[2]!))
    }
  }
  for (const block of content.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]!
    const single = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g
    for (const item of body.matchAll(single)) {
      const low = Number.parseInt(item[1]!, 16)
      const high = Number.parseInt(item[2]!, 16)
      const target = item[3]!
      if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) continue
      const width = item[1]!.length
      if (high - low > 65_536) continue
      const base = hexToCodePoints(target)
      if (base.length === 0) continue
      for (let offset = 0; low + offset <= high; offset += 1) {
        const cp = [...base]
        cp[cp.length - 1] = (cp[cp.length - 1] ?? 0) + offset
        add(
          (low + offset).toString(16).toUpperCase().padStart(width, '0'),
          String.fromCodePoint(...cp.filter((value) => value >= 0 && value <= 0x10ffff))
        )
      }
    }
    const arrays = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/g
    for (const item of body.matchAll(arrays)) {
      const low = Number.parseInt(item[1]!, 16)
      const high = Number.parseInt(item[2]!, 16)
      if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) continue
      const width = item[1]!.length
      const values = [...item[3]!.matchAll(/<([0-9a-fA-F]+)>/g)].map((value) => hexToUnicode(value[1]!))
      for (let offset = 0; low + offset <= high && offset < values.length; offset += 1) {
        add((low + offset).toString(16).toUpperCase().padStart(width, '0'), values[offset]!)
      }
    }
  }
  return table
}

function hexToCodePoints(hex: string): number[] {
  const clean = hex.length % 4 === 0 ? hex : hex.padStart(Math.ceil(hex.length / 4) * 4, '0')
  const out: number[] = []
  for (let index = 0; index + 4 <= clean.length; index += 4) {
    out.push(Number.parseInt(clean.slice(index, index + 4), 16))
  }
  if (out.length === 0 && clean !== '') out.push(Number.parseInt(clean, 16))
  return out
}

function hexToUnicode(hex: string): string {
  const clean = hex.length % 4 === 0 ? hex : hex.padStart(Math.ceil(hex.length / 4) * 4, '0')
  const units: number[] = []
  for (let index = 0; index + 4 <= clean.length; index += 4) {
    units.push(Number.parseInt(clean.slice(index, index + 4), 16))
  }
  return units.length === 0 ? '' : safeFromCodePoints(units)
}

// ------------------------------------------------------------- content text

const DELIMITERS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'])

function extractContentText(content: string, cmap: CMapTable): string {
  let index = 0
  let output = ''
  let operands: unknown[] = []
  const arrays: unknown[][] = []
  let lastY: number | null = null
  let lastWasNewline = true

  const pushValue = (value: unknown): void => {
    if (arrays.length > 0) arrays[arrays.length - 1]!.push(value)
    else operands.push(value)
  }
  const append = (value: string): void => {
    if (value === '') return
    output += value
    lastWasNewline = value.endsWith('\n')
  }
  const newline = (): void => {
    if (output !== '' && !lastWasNewline) {
      output += '\n'
      lastWasNewline = true
    }
  }
  while (index < content.length && output.length < MAX_TEXT_CHARS) {
    const char = content[index]!
    if (char === '%') {
      while (index < content.length && content[index] !== '\n' && content[index] !== '\r') index += 1
      continue
    }
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '(') {
      const decoded = readLiteralString(content, index)
      if (decoded === null) break
      pushValue({ kind: 'str', bytes: decoded.bytes })
      index = decoded.next
      continue
    }
    if (char === '<' && content[index + 1] === '<') {
      let depth = 0
      while (index < content.length) {
        if (content[index] === '<' && content[index + 1] === '<') {
          depth += 1
          index += 2
          continue
        }
        if (content[index] === '>' && content[index + 1] === '>') {
          depth -= 1
          index += 2
          if (depth <= 0) break
          continue
        }
        index += 1
      }
      continue
    }
    if (char === '<') {
      const end = content.indexOf('>', index + 1)
      if (end < 0) break
      const bytes = parseHexString(content.slice(index + 1, end))
      pushValue({ kind: 'str', bytes })
      index = end + 1
      continue
    }
    if (char === '[') {
      arrays.push([])
      index += 1
      continue
    }
    if (char === ']') {
      const value = arrays.pop() ?? []
      pushValue({ kind: 'array', values: value })
      index += 1
      continue
    }
    if (char === '/') {
      let end = index + 1
      while (end < content.length && !/\s/.test(content[end]!) && !DELIMITERS.has(content[end]!)) {
        end += 1
      }
      pushValue({ kind: 'name', value: content.slice(index + 1, end) })
      index = end
      continue
    }
    if (char === '>' || char === ')' || char === '}' || char === '{') {
      index += 1
      continue
    }
    // 普通 token：数字或操作符。
    let end = index
    while (
      end < content.length &&
      !/\s/.test(content[end]!) &&
      !DELIMITERS.has(content[end]!)
    ) {
      end += 1
    }
    if (end === index) {
      index += 1
      continue
    }
    const token = content.slice(index, end)
    index = end
    const numeric = Number(token)
    if (token !== '' && Number.isFinite(numeric)) {
      pushValue(numeric)
      continue
    }
    if (arrays.length > 0) continue

    switch (token) {
      case 'Tj': {
        const value = operands[operands.length - 1]
        if (isStr(value)) append(decodePdfString(value.bytes, cmap))
        break
      }
      case "'": {
        newline()
        const value = operands[operands.length - 1]
        if (isStr(value)) append(decodePdfString(value.bytes, cmap))
        break
      }
      case '"': {
        newline()
        const value = operands[operands.length - 1]
        if (isStr(value)) append(decodePdfString(value.bytes, cmap))
        break
      }
      case 'TJ': {
        const value = operands[operands.length - 1]
        if (isArray(value)) {
          for (const item of value.values) {
            if (isStr(item)) append(decodePdfString(item.bytes, cmap))
            else if (typeof item === 'number' && item <= -100) append(' ')
          }
        }
        break
      }
      case 'Td':
      case 'TD': {
        const y = operands.filter((item): item is number => typeof item === 'number').pop()
        if (y !== undefined && y !== 0) newline()
        break
      }
      case 'Tm': {
        const numbers = operands.filter((item): item is number => typeof item === 'number')
        const y = numbers[5]
        if (y !== undefined && lastY !== null && y !== lastY) newline()
        if (y !== undefined) lastY = y
        break
      }
      case 'T*':
        newline()
        break
      case 'ET':
        break
      default:
        break
    }
    operands = []
  }
  return output
}

interface StringValue {
  kind: 'str'
  bytes: number[]
}

interface ArrayValue {
  kind: 'array'
  values: unknown[]
}

function isStr(value: unknown): value is StringValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'str' &&
    Array.isArray((value as { bytes?: unknown }).bytes)
  )
}

function isArray(value: unknown): value is ArrayValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'array' &&
    Array.isArray((value as { values?: unknown }).values)
  )
}

function readLiteralString(
  content: string,
  start: number
): { bytes: number[]; next: number } | null {
  let index = start + 1
  let depth = 1
  const bytes: number[] = []
  while (index < content.length) {
    const char = content[index]!
    if (char === '\\') {
      const next = content[index + 1]
      if (next === undefined) break
      index += 2
      if (next === 'n') bytes.push(10)
      else if (next === 'r') bytes.push(13)
      else if (next === 't') bytes.push(9)
      else if (next === 'b') bytes.push(8)
      else if (next === 'f') bytes.push(12)
      else if (next === '(' || next === ')' || next === '\\') bytes.push(next.charCodeAt(0))
      else if (next === '\n') {
        /* 续行 */
      } else if (next === '\r') {
        if (content[index] === '\n') index += 1
      } else if (/[0-7]/.test(next)) {
        let octal = next
        while (octal.length < 3 && index < content.length && /[0-7]/.test(content[index]!)) {
          octal += content[index]!
          index += 1
        }
        bytes.push(Number.parseInt(octal, 8) & 0xff)
      } else {
        bytes.push(next.charCodeAt(0) & 0xff)
      }
      continue
    }
    if (char === '(') {
      depth += 1
      bytes.push(40)
      index += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      index += 1
      if (depth === 0) return { bytes, next: index }
      bytes.push(41)
      continue
    }
    bytes.push(char.charCodeAt(0) & 0xff)
    index += 1
  }
  return null
}

function parseHexString(input: string): number[] {
  const clean = input.replace(/[^0-9a-fA-F]/g, '')
  const padded = clean.length % 2 === 0 ? clean : `${clean}0`
  const out: number[] = []
  for (let index = 0; index < padded.length; index += 2) {
    out.push(Number.parseInt(padded.slice(index, index + 2), 16))
  }
  return out
}

function decodePdfString(bytes: readonly number[], cmap: CMapTable): string {
  if (bytes.length === 0) return ''
  // UTF-16BE BOM：某些 PDF 直接存 Unicode。
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const units: number[] = []
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      units.push(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0))
    }
    return safeFromCodePoints(units)
  }
  if (cmap.map.size > 0) {
    let candidates = [...cmap.codeLengths].sort((a, b) => b - a)
    // 全 ASCII 字节通常来自 1 字节编码；优先按 1 字节查表，避免被 2 字节键误判。
    if (bytes.every((byte) => byte < 0x80) && candidates.includes(1)) {
      candidates = [1, ...candidates.filter((length) => length !== 1)]
    }
    for (const bytesPerCode of candidates) {
      if (bytesPerCode <= 0 || bytes.length % bytesPerCode !== 0) continue
      const codes: string[] = []
      let mapped = 0
      for (let index = 0; index + bytesPerCode <= bytes.length; index += bytesPerCode) {
        let hex = ''
        for (let offset = 0; offset < bytesPerCode; offset += 1) {
          hex += (bytes[index + offset] ?? 0).toString(16).padStart(2, '0')
        }
        const upper = hex.toUpperCase()
        codes.push(upper)
        if (cmap.map.has(upper)) mapped += 1
      }
      if (mapped === codes.length && codes.length > 0) {
        return codes.map((code) => cmap.map.get(code) ?? '').join('')
      }
    }
  }
  // 无 CMap 时按 Latin-1 解释；非 ASCII 字节保留为可见替代，避免静默丢弃。
  return bytes.map((byte) => (byte === 0 ? '' : String.fromCharCode(byte))).join('')
}

function safeFromCodePoints(units: readonly number[]): string {
  let out = ''
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index] ?? 0
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = units[index + 1]
      if (low !== undefined && low >= 0xdc00 && low <= 0xdfff) {
        out += String.fromCodePoint(((unit - 0xd800) << 10) + (low - 0xdc00) + 0x10000)
        index += 1
        continue
      }
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) continue
    out += String.fromCharCode(unit)
  }
  return out
}

function normalizePdfText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}
