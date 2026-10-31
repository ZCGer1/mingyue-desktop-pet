import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowseFailureRecordView } from '../shared/discovery'
import { redact } from './util'

export interface AuditEntry {
  kind: 'tool' | 'approval' | 'memory' | 'workspace' | 'files' | 'vision' | 'system'
  session: string
  tool?: string
  /** 参数摘要：路径/命令摘要，不含文件内容与密钥。 */
  summary: string
  result: 'approved' | 'denied' | 'ok' | 'failed' | 'timeout' | 'aborted'
  durationMs?: number
  approval?: 'auto' | 'required' | 'session' | 'always'
  extra?: Record<string, string | number | boolean>
}

/** 诊断字段只接受短 ASCII 标识；不把自由文本写进审计。 */
const AUDIT_DIAGNOSTIC_TEXT = /^[A-Za-z0-9._:-]{1,80}$/
const AUDIT_TAIL_BYTES = 256 * 1024
const AUDIT_FAILURE_LIMIT = 8
const BROWSER_FAILURE_TOOL = /^web_[a-z_]+$/

function auditText(value: unknown): string | null {
  return typeof value === 'string' && AUDIT_DIAGNOSTIC_TEXT.test(value) ? value : null
}

function auditNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= 1_000_000_000
    ? Math.trunc(number)
    : null
}

function auditBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * `logs/audit.jsonl`。只记路径/操作/审批结果/耗时，不记文件内容。
 * 主动浏览失败的诊断字段由执行器按白名单写入，这里只读取并再次校验。
 */
export class AuditLog {
  private readonly file: string

  constructor(file: string) {
    this.file = file
    mkdirSync(dirname(file), { recursive: true })
  }

  write(entry: AuditEntry): void {
    const record = {
      ts: new Date().toISOString(),
      ...entry,
      summary: redact(entry.summary)
    }
    try {
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      /* 审计失败不阻塞工具执行（但会在应用日志里留 warning） */
    }
  }

  /**
   * 重启后仍可查看的最近主动浏览失败记录。
   * 只读取文件尾部；所有字段再次按枚举/长度校验，绝不回放页面内容。
   */
  recentBrowseFailures(limit = AUDIT_FAILURE_LIMIT): BrowseFailureRecordView[] {
    const max = Math.min(20, Math.max(1, Math.trunc(limit)))
    let text = ''
    try {
      const stat = statSync(this.file)
      const size = Math.min(stat.size, AUDIT_TAIL_BYTES)
      if (size <= 0) return []
      const fd = openSync(this.file, 'r')
      try {
        const buffer = Buffer.alloc(size)
        readSync(fd, buffer, 0, size, stat.size - size)
        text = buffer.toString('utf8')
      } finally {
        closeSync(fd)
      }
      if (size < stat.size) {
        // 首行可能是被截断的半行；从下一个换行后开始。
        const newline = text.indexOf('\n')
        text = newline >= 0 ? text.slice(newline + 1) : ''
      }
    } catch {
      return []
    }
    const out: BrowseFailureRecordView[] = []
    const lines = text.split('\n')
    for (let index = lines.length - 1; index >= 0 && out.length < max; index -= 1) {
      const line = lines[index]?.trim() ?? ''
      if (line === '') continue
      let record: Record<string, unknown>
      try {
        const parsed = JSON.parse(line) as unknown
        if (parsed === null || typeof parsed !== 'object') continue
        record = parsed as Record<string, unknown>
      } catch {
        continue
      }
      if (record['kind'] !== 'tool' || record['result'] !== 'failed') continue
      const tool = auditText(record['tool'])
      if (tool === null || !BROWSER_FAILURE_TOOL.test(tool)) continue
      const extra =
        record['extra'] !== null && typeof record['extra'] === 'object'
          ? (record['extra'] as Record<string, unknown>)
          : {}
      const at = typeof record['ts'] === 'string' ? record['ts'].slice(0, 40) : ''
      out.push({
        at,
        tool,
        origin: auditText(extra['origin']) ?? '',
        source: auditText(extra['source']) ?? '',
        code: auditText(extra['code']),
        rawCode: auditText(extra['rawCode']),
        stage: auditText(extra['stage']),
        retryable: auditBool(extra['retryable']),
        cooldown: extra['cooldown'] === true,
        durationMs: auditNumber(record['durationMs']),
        commandId: auditText(extra['commandId']),
        instanceId: auditText(extra['instanceId']),
        extensionVersion: auditText(extra['extVersion']),
        extensionBuildId: auditText(extra['extBuild']),
        protocolVersion: auditNumber(extra['extProtocol'])
      })
    }
    return out
  }
}
