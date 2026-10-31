import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from '../../core/util'
import type {
  BiliReadingRecord,
  BiliReportSummary,
  BiliReportEntryView
} from '../../shared/bilibili'
import {
  BILI_FAILURE_LABELS,
  BILI_VERDICT_LABELS,
  isDateKey,
  partNumber
} from '../../shared/bilibili'
import type { BiliPaths } from './paths'

/**
 * 日报只从结构化阅读记录投影生成；不解析 Markdown 反推状态。
 *
 * - 每次重建整份当天文件（原子替换），同日多轮不会追加重复条目。
 * - 跨日完成的 ASR/评价出现在完成当天的日报，同时标注最初探索日期。
 * - 删除/关闭记忆由阅读记录层先清理，再调用这里重建；写失败不回滚记录。
 * - 报告不包含字幕/转写全文、音频、Cookie 或账号 UID 原文。
 */

export interface ReportFailureCount {
  date: string
  code: string
  count: number
}

export interface DailyReportInput {
  date: string
  records: BiliReadingRecord[]
  failures: ReportFailureCount[]
  generatedAt: number
}

export interface DailyReportBuild {
  markdown: string
  summary: Omit<BiliReportSummary, 'path' | 'exists' | 'inMemory'>
  entries: BiliReportEntryView[]
}

const ACCOUNT_KEY_RE = /^(?:anonymous|[a-f0-9]{8,32})$/

export function reportAccountDir(paths: BiliPaths, accountKey: string): string {
  const key = ACCOUNT_KEY_RE.test(accountKey) ? accountKey : 'anonymous'
  return join(paths.reportsDir, key)
}

export function reportPathFor(paths: BiliPaths, accountKey: string, date: string): string {
  const safeDate = isDateKey(date) ? date : '1970-01-01'
  return join(reportAccountDir(paths, accountKey), `${safeDate}.md`)
}

/** 参与某天日报的记录：当天开始探索，或当天完成评价/转写。 */
export function recordsForDate(
  records: readonly BiliReadingRecord[],
  date: string
): BiliReadingRecord[] {
  return records
    .filter((record) => record.explorationDate === date || record.completedDate === date)
    .slice()
    .sort((a, b) => {
      const rank = verdictRank(b.verdict) - verdictRank(a.verdict)
      return rank !== 0 ? rank : b.updatedAt - a.updatedAt
    })
}

export function buildDailyReport(input: DailyReportInput): DailyReportBuild {
  const records = recordsForDate(input.records, input.date)
  const counts = {
    checked: records.length,
    worth: records.filter((record) => record.verdict === 'worth').length,
    okay: records.filter((record) => record.verdict === 'okay').length,
    skip: records.filter((record) => record.verdict === 'skip').length,
    unknown: records.filter((record) => record.verdict === 'unknown').length
  }
  const pending = records.filter((record) => record.verdict === null)
  const failures = input.failures
    .filter((item) => item.date === input.date)
    .reduce((sum, item) => sum + Math.max(0, item.count), 0)
  const lines: string[] = []
  lines.push(`# 桌宠 B 站探索日报 · ${input.date}`)
  lines.push('')
  lines.push(
    `检查 ${counts.checked} 条 · 值得看 ${counts.worth} · 可以看 ${counts.okay} · 不推荐 ${counts.skip} · 暂无法判断 ${counts.unknown} · 未完成 ${pending.length} · 读取失败 ${failures}`
  )
  lines.push('')
  if (records.length === 0) {
    lines.push('今天没有开始阅读的视频。')
    lines.push('')
  } else {
    lines.push('## 今日条目')
    lines.push('')
    for (const record of records) {
      lines.push(renderEntry(record, input.date))
    }
  }
  if (pending.length > 0) {
    lines.push('## 未完成')
    lines.push('')
    for (const record of pending) {
      lines.push(
        `- ${inline(record.title)}（${inline(record.author)}）· 已获取证据：${evidenceText(record)} · [打开](${record.url})`
      )
    }
    lines.push('')
  }
  const failureLines = renderFailures(input.failures, input.date)
  if (failureLines.length > 0) {
    lines.push('## 读取失败分类')
    lines.push('')
    lines.push(...failureLines)
    lines.push('')
  }
  lines.push(`_生成于 ${new Date(input.generatedAt).toISOString()}；仅记录实际读取到的内容，不包含字幕/转写全文。_`)
  lines.push('')
  const summary = {
    date: input.date,
    entries: records.length,
    worth: counts.worth,
    okay: counts.okay,
    skip: counts.skip,
    unknown: counts.unknown,
    skipped: pending.length,
    failed: failures,
    generatedAt: input.generatedAt,
    markdown: lines.join('\n')
  }
  return {
    markdown: summary.markdown,
    summary,
    entries: records.map((record) => toEntryView(record))
  }
}

export function writeDailyReport(
  paths: BiliPaths,
  accountKey: string,
  date: string,
  markdown: string
): { ok: true; path: string } | { ok: false; message: string } {
  if (!isDateKey(date)) return { ok: false, message: '日报日期不合法。' }
  try {
    const file = reportPathFor(paths, accountKey, date)
    mkdirSync(reportAccountDir(paths, accountKey), { recursive: true })
    atomicWrite(file, markdown)
    return { ok: true, path: file }
  } catch {
    return { ok: false, message: '日报写入失败，阅读记录仍已保存，可稍后重建。' }
  }
}

export function reportExists(paths: BiliPaths, accountKey: string, date: string): boolean {
  try {
    return existsSync(reportPathFor(paths, accountKey, date))
  } catch {
    return false
  }
}

/** 删除超过保留期的日报文件；只处理本账号分区。 */
export function pruneReportFiles(
  paths: BiliPaths,
  accountKey: string,
  retentionDays: number,
  today: string
): void {
  const dir = reportAccountDir(paths, accountKey)
  const keepFrom = shiftDate(today, -Math.max(1, retentionDays))
  try {
    for (const name of readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue
      const date = name.slice(0, 10)
      if (date < keepFrom) {
        try {
          rmSync(join(dir, name), { force: true })
        } catch {
          /* 单个文件删不掉不影响其他 */
        }
      }
    }
  } catch {
    /* 目录不存在 */
  }
}

function renderEntry(record: BiliReadingRecord, date: string): string {
  const verdict = record.verdict === null ? '未完成' : BILI_VERDICT_LABELS[record.verdict]
  const page = record.partIndex > 0 ? ` · P${partNumber(record.partIndex)}` : ''
  const completedElsewhere =
    record.completedDate !== null && record.completedDate !== date
      ? ` · 完成于 ${record.completedDate}`
      : ''
  const exploredElsewhere =
    record.explorationDate !== date ? ` · 探索于 ${record.explorationDate}` : ''
  const lines = [
    `### [${inline(record.title)}](${record.url})`,
    '',
    `- ${inline(record.author)}${page} · **${verdict}** · 证据：${evidenceText(record)}${completedElsewhere}${exploredElsewhere}`
  ]
  if (record.reason !== null && record.reason.trim() !== '') {
    lines.push(`- 理由：${inline(record.reason)}`)
  }
  if (record.keyPoints.length > 0) {
    lines.push(`- 要点：${record.keyPoints.slice(0, 6).map((point) => inline(point)).join('；')}`)
  }
  if (record.frames !== null && record.frames.times.length > 0) {
    lines.push(
      `- 抽帧：${record.frames.times.map((time) => formatClock(time)).join(' / ')}（实际交付 ${record.frames.delivered}/${record.frames.requested}）`
    )
  }
  if (record.subtitle !== null) {
    const coverage = Math.round(record.subtitle.coverage * 100)
    lines.push(
      `- 字幕：${record.subtitle.language ?? '未知语言'}，覆盖 ${coverage}%（${record.subtitle.segmentsRead}/${record.subtitle.segmentsTotal} 段）`
    )
  }
  if (record.asr !== null) {
    if (record.asr.state === 'succeeded') {
      const total = record.asr.chars ?? 0
      const read = record.transcriptReadChars
      const complete = total > 0 && read >= Math.ceil(total * 0.9)
      lines.push(
        `- 本地转写完成，${total} 字；实际读 ${read} 字${complete ? '（已读完）' : '（未读完）'}（模型 ${record.asr.model}）`
      )
    } else {
      lines.push(`- ${BILI_ASR_LABEL_FALLBACK[record.asr.state]}（模型 ${record.asr.model}）`)
    }
  }
  if (record.descriptionReadAt !== null && record.subtitle === null && record.asr === null && record.frames === null) {
    lines.push('- 仅读取了标题/简介，证据不足。')
  }
  lines.push('')
  return lines.join('\n')
}

const BILI_ASR_LABEL_FALLBACK: Record<string, string> = {
  queued: '本地转写排队中',
  running: '本地转写中',
  succeeded: '本地转写完成',
  empty: '本地转写没有识别出文字',
  failed: '本地转写失败',
  cancelled: '本地转写已取消',
  interrupted: '本地转写被中断'
}

function evidenceText(record: BiliReadingRecord): string {
  const parts: string[] = []
  if (record.subtitle !== null) {
    parts.push(`字幕 ${Math.round(record.subtitle.coverage * 100)}%`)
  }
  if (record.asr !== null && record.asr.state === 'succeeded' && record.transcriptReadChars > 0) {
    parts.push(`本地转写已读 ${record.transcriptReadChars}/${record.asr.chars ?? 0} 字`)
  }
  if (record.frames !== null && record.frames.delivered > 0) {
    parts.push(`画面 ${record.frames.delivered} 帧`)
  }
  if (parts.length === 0 && record.descriptionReadAt !== null) parts.push('标题/简介')
  return parts.length === 0 ? '无' : parts.join(' + ')
}

function renderFailures(failures: ReportFailureCount[], date: string): string[] {
  const grouped = new Map<string, number>()
  for (const item of failures) {
    if (item.date !== date || item.count <= 0) continue
    grouped.set(item.code, (grouped.get(item.code) ?? 0) + item.count)
  }
  if (grouped.size === 0) return []
  return [...grouped.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => {
      const label =
        BILI_FAILURE_LABELS[code as keyof typeof BILI_FAILURE_LABELS] ?? '读取失败'
      return `- ${label}：${count} 次`
    })
}

export function toEntryView(record: BiliReadingRecord): BiliReportEntryView {
  return {
    id: record.id,
    title: record.title,
    author: record.author,
    url: record.url,
    verdict: record.verdict ?? 'unknown',
    reason: record.reason ?? '',
    evidenceLevel: record.evidenceLevel,
    subtitleCoverage: record.subtitle?.coverage ?? null,
    frameTimes: record.frames?.times ?? [],
    explorationDate: record.explorationDate,
    completedDate: record.completedDate
  }
}

function verdictRank(verdict: BiliReadingRecord['verdict']): number {
  switch (verdict) {
    case 'worth':
      return 4
    case 'okay':
      return 3
    case 'unknown':
      return 2
    case 'skip':
      return 1
    default:
      return 0
  }
}

function inline(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .trim()
    .slice(0, 300)
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}

/** 只做日期加减，不引入时区库；today 为 YYYY-MM-DD。 */
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map((part) => Number(part))
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return '1970-01-01'
  }
  const stamp = Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days)
  const next = new Date(stamp)
  return next.toISOString().slice(0, 10)
}
