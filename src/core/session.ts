import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ContextImage,
  ContextRecord,
  ContextToolCall,
  ModelContentPart,
  ModelMessage,
  ModelToolCall,
  SessionInfo,
  ToolImage
} from './types'
import { atomicWrite, estimateTokens, isoNow } from './util'
import {
  EXPIRED_FAILED_TOOL_TEXT,
  EXPIRED_TOOL_TEXT,
  EXPIRED_UNKNOWN_TOOL_TEXT,
  UNKNOWN_TOOL_TEXT
} from './protocol'

/** 单张截图的 token 估算上限；只用于上下文预算，不参与真实计费。 */
const IMAGE_TOKEN_CAP = 1_500
const IMAGE_TOKEN_DIVISOR = 750

export { EXPIRED_TOOL_TEXT, UNKNOWN_TOOL_TEXT }

export interface SessionOptions {
  id: string
  label: string
  file?: string
  persistent: boolean
  hardTokens?: number | null
  rounds?: { soft: number; hard: number }
}

export interface LoadResult {
  warnings: string[]
}

/**
 * 主会话上下文（PLAN.md §2.3）。JSONL 只追加；交接时 .tmp + rename。
 * 重启恢复时清理孤立工具回执、为缺失回执补占位。
 */
export class Session {
  readonly id: string
  readonly label: string
  readonly persistent: boolean
  readonly file?: string
  hardTokens: number | null
  rounds: { soft: number; hard: number }
  records: ContextRecord[] = []
  roundCount = 0

  constructor(options: SessionOptions) {
    this.id = options.id
    this.label = options.label
    this.persistent = options.persistent
    this.file = options.file
    this.hardTokens = options.hardTokens ?? null
    this.rounds = options.rounds ?? { soft: 12, hard: 20 }
    if (this.persistent && this.file !== undefined) mkdirSync(dirname(this.file), { recursive: true })
  }

  load(): LoadResult {
    const warnings: string[] = []
    if (this.file === undefined || !existsSync(this.file)) return { warnings }
    let raw = readFileSync(this.file, 'utf8')
    if (raw === '') return { warnings }
    const endsWithNewline = raw.endsWith('\n')
    const lines = raw.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line) as ContextRecord
        if (typeof record !== 'object' || record === null || typeof record.kind !== 'string') {
          throw new Error('bad record')
        }
        // 截图永远不落盘；旧版本/手改文件里的 images 一律丢弃。
        if (record.kind === 'user' && Array.isArray(record.images) && record.images.length > 0) {
          delete record.images
          warnings.push('会话中存在截图记录，已丢弃')
        }
        this.records.push(record)
      } catch {
        if (i === lines.length - 1 && !endsWithNewline) {
          const complete = lines.slice(0, i).join('\n')
          atomicWrite(this.file, complete === '' ? '' : `${complete}\n`)
          raw = complete
          warnings.push('会话末行不完整，已截断到最后一个完整行')
        } else {
          warnings.push(`会话第 ${i + 1} 行损坏，已跳过`)
        }
      }
    }
    const repaired = repairToolPairingRecords(this.records, warnings)
    if (!recordsEqual(this.records, repaired)) {
      // 先备份原始会话，再原子重写修复后的记录；不要求用户清空数据。
      this.backupFile()
      this.records = repaired
      this.expireEphemeral()
      this.persistAll()
      warnings.push('会话工具配对已修复并保存，原文件已备份')
    } else {
      this.records = repaired
    }
    return { warnings }
  }

  /** 会话文件的一次性备份；失败不影响修复，只记录在 warnings 之外。 */
  private backupFile(): void {
    if (this.file === undefined || !existsSync(this.file)) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      copyFileSync(this.file, `${this.file}.bak-${stamp}`)
    } catch {
      /* 备份失败不阻塞修复；原文件仍可通过撤销目录恢复 */
    }
  }

  append(record: ContextRecord, options: { persist?: boolean } = {}): void {
    this.records.push(record)
    // 带截图的记录即使调用方忘了标 ephemeral，也绝不写 JSONL。
    const persist = options.persist !== false && record.retention !== 'memory' && !recordHasImages(record)
    if (this.persistent && this.file !== undefined && persist) {
      try {
        appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8')
      } catch {
        /* 内容仍在内存里 */
      }
    }
  }

  appendSystem(text: string, ephemeral = false): void {
    this.append({ kind: 'system', text, ts: isoNow(), ...(ephemeral ? { ephemeral: true } : {}) }, { persist: !ephemeral })
  }

  appendUser(text: string, cursors?: number[], ephemeral = false, images?: ToolImage[]): void {
    const hasImages = images !== undefined && images.length > 0
    // 有截图时必须 ephemeral：截图只活在当前 turn 的内存里。
    const eph = ephemeral || hasImages
    const stamped: ContextImage[] | undefined = hasImages
      ? images.map((image) => ({ ...image, at: Date.now() }))
      : undefined
    this.append(
      {
        kind: 'user',
        text,
        ts: isoNow(),
        ...(cursors === undefined ? {} : { cursors }),
        ...(stamped === undefined ? {} : { images: stamped }),
        ...(eph ? { ephemeral: true } : {})
      },
      { persist: !eph }
    )
  }

  appendAssistant(text: string, toolCalls?: ContextToolCall[], reasoning?: string, aborted?: boolean): void {
    this.append({
      kind: 'assistant',
      text,
      ts: isoNow(),
      ...(toolCalls === undefined || toolCalls.length === 0 ? {} : { toolCalls }),
      ...(reasoning === undefined || reasoning === '' ? {} : { reasoning }),
      ...(aborted === true ? { aborted: true } : {})
    })
  }

  appendTool(toolCallId: string, name: string, text: string, failed = false, ephemeral = false): void {
    this.append(
      {
        kind: 'tool',
        toolCallId,
        name,
        text,
        ts: isoNow(),
        ...(failed ? { failed: true } : {}),
        ...(ephemeral ? { ephemeral: true } : {})
      },
      { persist: !ephemeral }
    )
  }

  /**
   * 清理上一批留下的临时内容，但绝不破坏工具调用/回执结构。
   *
   * - 临时 user/system 记录（含截图、网页正文）直接移除；
   * - 临时 assistant 正文清空，同组的 toolCalls 保留；
   * - 临时 tool 回执替换为同 id、同工具名、不含正文的过期壳，并转为持久
   *   记录，让重启后的会话仍然是合法协议。
   *
   * 落盘会话文件按顺序重写一次，保证过期壳位于原回执的位置。
   */
  expireEphemeral(): void {
    const next: ContextRecord[] = []
    let structureChanged = false
    for (const record of this.records) {
      if (record.retention === 'memory') {
        if (record.kind === 'user' && record.images) { const { images, ...textOnly } = record; next.push(textOnly) }
        else next.push(record)
        continue
      }
      if (!isEphemeralRecord(record)) {
        next.push(record)
        continue
      }
      if (record.kind === 'tool') {
        const { ephemeral: _ephemeral, ...rest } = record
        const failed = record.failed === true
        // 失败/未知事实必须保留；只用准确的过期壳替换正文。
        const text =
          record.unknown === true
            ? EXPIRED_UNKNOWN_TOOL_TEXT
            : failed
              ? EXPIRED_FAILED_TOOL_TEXT
              : EXPIRED_TOOL_TEXT
        next.push({
          ...rest,
          text,
          expired: true,
          failed
        })
        structureChanged = true
        continue
      }
      if (record.kind === 'assistant') {
        if ((record.toolCalls?.length ?? 0) > 0) {
          next.push({
            kind: 'assistant',
            text: '',
            ts: record.ts,
            ...(record.toolCalls === undefined ? {} : { toolCalls: record.toolCalls }),
            ...(record.reasoning === undefined ? {} : { reasoning: record.reasoning }),
            ...(record.aborted === true ? { aborted: true } : {})
          })
          structureChanged = true
        }
        // 没有工具调用的临时 assistant 正文可以直接丢弃。
        continue
      }
      // ephemeral user/system：正文和图片只存在于当轮内存。
    }
    this.records = next
    if (structureChanged) this.persistAll()
  }

  /**
   * 兼容旧调用名。语义已从「全删」改为「只清理正文、保留协议结构」，
   * 避免调用方在不知情时再次制造缺失回执。
   */
  dropEphemeral(): void {
    this.expireEphemeral()
  }

  /**
   * 立即修复会话记录里的工具配对，返回是否发生了改动。
   * 加载、交接、投递前和 Provider 报告配对错误时都会调用。
   */
  repairPairing(warnings: string[] = []): boolean {
    const before = this.records
    const repaired = repairToolPairingRecords(before, warnings)
    if (recordsEqual(before, repaired)) return false
    this.records = repaired
    this.persistAll()
    return true
  }

  /**
   * 只包含工具调用/回执结构的指纹（不含正文、时间或临时事件）。
   * 用于识别「同一会话版本、同一结构」的重复 Provider 配对错误。
   */
  protocolFingerprint(): string {
    const parts: string[] = []
    for (const record of this.records) {
      if (record.kind === 'assistant' && (record.toolCalls?.length ?? 0) > 0) {
        parts.push(`A:${record.toolCalls?.map((call) => `${call.id}/${call.name}`).join('|') ?? ''}`)
      } else if (record.kind === 'tool') {
        parts.push(`T:${record.toolCallId}`)
      }
    }
    let hash = 2166136261
    const text = parts.join('\n')
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 16777619) >>> 0
    }
    return `${parts.length}:${hash.toString(16)}`
  }

  estTokens(): number {
    let total = 0
    for (const record of this.records) {
      if (record.kind === 'system') total += estimateTokens(record.text)
      else if (record.kind === 'user') {
        total += estimateTokens(record.text)
        for (const image of record.images ?? []) total += imageTokens(image)
      } else if (record.kind === 'assistant') {
        total += estimateTokens(record.text)
        for (const call of record.toolCalls ?? []) total += estimateTokens(call.name + call.arguments)
      } else {
        total += estimateTokens(record.text)
      }
    }
    return total
  }

  info(): SessionInfo {
    return {
      id: this.id,
      label: this.label,
      rounds: this.roundCount,
      estTokens: this.estTokens(),
      hardTokens: this.hardTokens,
      messageCount: this.records.length
    }
  }

  /** 主会话消息（不含系统提示；系统提示由 Core 用 Persona.systemSegments 重建）。 */
  messages(options: { omitBaseSystem?: boolean } = {}): ModelMessage[] {
    const messages: ModelMessage[] = []
    for (const record of this.records) {
      if (record.kind === 'system') {
        if (options.omitBaseSystem && !record.ephemeral) continue
        messages.push({ role: 'system', content: record.text })
        continue
      }
      if (record.kind === 'user') {
        const images = record.images ?? []
        if (images.length === 0) {
          messages.push({ role: 'user', content: record.text })
          continue
        }
        const parts: ModelContentPart[] = []
        if (record.text !== '') parts.push({ type: 'text', text: record.text })
        for (const image of images) {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${image.mimeType};base64,${image.data}`,
              ...(image.detail === undefined ? {} : { detail: image.detail })
            }
          })
        }
        messages.push({ role: 'user', content: parts })
        continue
      }
      if (record.kind === 'assistant') {
        const hasCalls = (record.toolCalls?.length ?? 0) > 0
        if (record.text === '' && !hasCalls) continue
        const toolCalls: ModelToolCall[] | undefined = hasCalls
          ? record.toolCalls?.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.arguments }
            }))
          : undefined
        messages.push({
          role: 'assistant',
          content: hasCalls ? (record.text === '' ? null : record.text) : record.text,
          ...(toolCalls === undefined ? {} : { tool_calls: toolCalls })
        })
        continue
      }
      messages.push({
        role: 'tool',
        content: record.text,
        tool_call_id: record.toolCallId,
        name: record.name
      })
    }
    return messages
  }

  /** 交接：用新的尾部记录替换全部消息，原子重写。 */
  replaceAll(records: ContextRecord[]): void {
    this.records = records
    this.persistAll()
  }

  setRounds(rounds: { soft: number; hard: number }): void {
    this.rounds = rounds
  }

  resetRounds(): void {
    this.roundCount = 0
  }

  persistAll(): void {
    if (!this.persistent || this.file === undefined) return
    const body = stripImagesFromRecords(this.records)
      .filter((record) => record.retention !== 'memory' && !('ephemeral' in record && record.ephemeral === true))
      .map((record) => JSON.stringify(record))
      .join('\n')
    atomicWrite(this.file, body === '' ? '' : `${body}\n`)
  }

}

/**
 * 运行时判断临时标记。assistant 类型目前不声明 ephemeral，但旧数据/手改
 * 文件可能带上；用运行时检查而不是 `in` 收窄，避免修复逻辑漏掉这类记录。
 */
function isEphemeralRecord(record: ContextRecord): boolean {
  return (record as { ephemeral?: boolean }).ephemeral === true
}

function recordsEqual(a: ContextRecord[], b: ContextRecord[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

function recordHasImages(record: ContextRecord): boolean {
  return record.kind === 'user' && (record.images?.length ?? 0) > 0
}

function imageTokens(image: { width: number; height: number }): number {
  const area = Math.max(0, image.width) * Math.max(0, image.height)
  return Math.min(IMAGE_TOKEN_CAP, Math.max(1, Math.ceil(area / IMAGE_TOKEN_DIVISOR)))
}

/** 交接/落盘前统一剥离截图；返回浅拷贝，不改变调用方数组。 */
export function stripImagesFromRecords(records: ContextRecord[]): ContextRecord[] {
  return records.map((record) => {
    if (record.kind !== 'user' || record.images === undefined) return record
    const copy = { ...record }
    delete copy.images
    return copy
  })
}

/**
 * 修复工具调用配对：删除孤立/重复/对不上号的回执，为每个调用补齐回执。
 *
 * 这是所有入口共用的唯一修复逻辑（加载、投递前、交接、Provider 配对报错、
 * 快捷聊天）。原则：
 * - 每个 assistant.tool_calls 的 id 只出现一次；重复调用 id 只保留第一个。
 * - 每个 call id 恰好一条 tool 回执；重复回执保留第一条，其余删除。
 * - 缺失回执补 `UNKNOWN_TOOL_TEXT` 且 `unknown: true`、`failed: true`，
 *   明确「结果未知」，绝不伪造成成功，也绝不自动重放有副作用的工具。
 * - 回执按调用顺序补齐，保证并行调用也能稳定配对。
 */
export function repairToolPairingRecords(records: ContextRecord[], warnings: string[]): ContextRecord[] {
  const out: ContextRecord[] = []
  let i = 0
  while (i < records.length) {
    const record = records[i]
    if (record === undefined) break
    if (record.kind !== 'assistant' || (record.toolCalls?.length ?? 0) === 0) {
      // 孤立的工具回执：没有前置调用
      if (record.kind === 'tool') {
        warnings.push('会话中存在孤立工具回执，已删除')
        i += 1
        continue
      }
      out.push(record)
      i += 1
      continue
    }
    const expected = new Map<string, ContextToolCall>()
    const duplicateCalls = new Set<string>()
    for (const call of record.toolCalls ?? []) {
      if (expected.has(call.id)) {
        duplicateCalls.add(call.id)
        continue
      }
      expected.set(call.id, call)
    }
    if (duplicateCalls.size > 0) {
      warnings.push(`会话中存在重复工具调用 id（${[...duplicateCalls].join(', ')}），已去重`)
      out.push({
        ...record,
        toolCalls: record.toolCalls?.filter((call) => expected.get(call.id) === call)
      })
    } else {
      out.push(record)
    }
    let j = i + 1
    const seen = new Set<string>()
    while (j < records.length) {
      const next = records[j]
      if (next === undefined || next.kind !== 'tool') break
      if (!expected.has(next.toolCallId)) {
        warnings.push('会话中存在对不上号的工具回执，已删除')
        j += 1
        continue
      }
      if (seen.has(next.toolCallId)) {
        warnings.push(`工具调用 ${next.toolCallId} 存在重复回执，已保留第一条`)
        j += 1
        continue
      }
      seen.add(next.toolCallId)
      out.push(next)
      j += 1
    }
    for (const [id, call] of expected) {
      if (!seen.has(id)) {
        out.push({
          kind: 'tool',
          toolCallId: id,
          name: call.name,
          text: UNKNOWN_TOOL_TEXT,
          ts: isoNow(),
          failed: true,
          unknown: true,
          ...(record.source ? { source: record.source } : {}),
          ...(record.retention ? { retention: record.retention } : {})
        })
        warnings.push(`工具调用 ${call.name} 缺少回执，已补「结果未知」占位`)
      }
    }
    i = j
  }
  return out
}
