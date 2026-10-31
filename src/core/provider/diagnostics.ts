import type {
  ProviderCauseInfo,
  ProviderErrorCategory,
  ProviderErrorDiagnostics,
  ProviderTransportPhase
} from '../types'
import { ProviderError } from '../types'
import { redact } from '../util'

const MAX_CAUSE_DEPTH = 3
const MAX_CAUSES = 4
const MAX_CAUSE_MESSAGE = 180
const MAX_DETAIL = 200

/**
 * 稳定配置类错误：证书、TLS 与非法地址重试也不会自己变好。
 * DNS 未解析（ENOTFOUND）、连接重置等仍按暂时故障处理，但只做有界重试。
 */
const STABLE_TRANSPORT_CODE =
  /^(?:CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_(?:VERIFY|GET)_|HOSTNAME_MISMATCH|ERR_TLS_|ERR_SSL_|ERR_INVALID_URL|ERR_INVALID_PROTOCOL|ERR_UNESCAPED_CHARACTERS)/

/** 写日志/状态前的错误文本：去凭据、压空白、限长。 */
export function sanitizeErrorText(value: string, max = MAX_DETAIL): string {
  const cleaned = redact(value).replace(/\s+/g, ' ').trim()
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…`
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/**
 * 收集底层 cause / AggregateError 的白名单字段。
 * 不序列化整个错误，不读取 stack，限制深度/条数/长度并防循环。
 */
export function collectErrorDiagnostics(
  error: unknown,
  transportPhase: ProviderTransportPhase,
  category: ProviderErrorCategory
): ProviderErrorDiagnostics {
  const direct = causeOf(error)
  const topLevelAggregate = direct === undefined ? aggregateErrors(error) : null
  const queue: Array<{ value: unknown; depth: number }> = []
  if (direct !== undefined) queue.push({ value: direct, depth: 0 })
  else if (topLevelAggregate !== null) {
    for (const item of topLevelAggregate.slice(0, MAX_CAUSES)) queue.push({ value: item, depth: 0 })
  }

  const causes: ProviderCauseInfo[] = []
  const seen = new Set<object>()
  let truncated = false
  let aggregateCount: number | undefined = topLevelAggregate?.length

  while (queue.length > 0) {
    if (causes.length >= MAX_CAUSES) {
      truncated = true
      break
    }
    const item = queue.shift()
    if (item === undefined) break
    const value = item.value
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) {
        truncated = true
        continue
      }
      seen.add(value)
    }
    causes.push(pickCause(value))

    const aggregate = aggregateErrors(value)
    if (aggregate !== null) {
      aggregateCount = aggregate.length
      const room = Math.max(0, MAX_CAUSES - causes.length)
      if (room === 0) truncated = true
      for (const child of aggregate.slice(0, room)) {
        if (item.depth < MAX_CAUSE_DEPTH) queue.push({ value: child, depth: item.depth + 1 })
        else truncated = true
      }
      if (aggregate.length > room) truncated = true
    }

    const nested = causeOf(value)
    if (nested !== undefined) {
      if (item.depth >= MAX_CAUSE_DEPTH) truncated = true
      else queue.push({ value: nested, depth: item.depth + 1 })
    }
  }

  const hasCause = direct !== undefined || topLevelAggregate !== null
  const firstWithCode = causes.find((cause) => cause.code !== undefined)
  const top = causes[0]
  return {
    category,
    transportPhase,
    causeStatus: hasCause ? 'present' : 'none',
    ...(firstWithCode?.code === undefined ? {} : { causeCode: firstWithCode.code }),
    ...(top === undefined ? {} : { causeName: top.name }),
    ...(causes.length === 0 ? {} : { causes }),
    ...(aggregateCount === undefined ? {} : { aggregateCount }),
    ...(truncated ? { truncated: true } : {})
  }
}

/** 不含 message 的简短摘要；用于把底层 code 带进用户可见的错误消息。 */
export function causeSummary(diagnostics: ProviderErrorDiagnostics): string {
  const codes = [
    ...new Set(
      (diagnostics.causes ?? [])
        .map((cause) => cause.code)
        .filter((code): code is string => code !== undefined && code !== '')
    )
  ]
  if (codes.length > 0) return codes.slice(0, 3).join(', ')
  return diagnostics.causeName ?? ''
}

/** 传输类错误消息；没有 cause 时保持原样，不猜测 DNS/TLS 等具体原因。 */
export function formatTransportMessage(
  prefix: string,
  error: unknown,
  diagnostics: ProviderErrorDiagnostics
): string {
  const base = sanitizeErrorText(errorText(error), 160) || '底层错误没有可用消息'
  const summary = causeSummary(diagnostics)
  if (summary === '' || base.includes(summary)) return `${prefix}：${base}`
  return `${prefix}：${base}（底层 ${summary}）`
}

export function isStableTransportFailure(diagnostics: ProviderErrorDiagnostics): boolean {
  return (diagnostics.causes ?? []).some(
    (cause) => typeof cause.code === 'string' && STABLE_TRANSPORT_CODE.test(cause.code)
  )
}

/** 只保留 scheme://host[:port]；URL.origin 天然不含用户名、密码、路径与查询串。 */
export function redactedOrigin(baseUrl: string | undefined, fallback = 'https://api.deepseek.com'): string {
  const raw = (baseUrl ?? '').trim() === '' ? fallback : (baseUrl ?? '').trim()
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'invalid'
    return url.origin
  } catch {
    return 'invalid'
  }
}

/** 非 ProviderError 的运行时异常：保留诊断字段，但标记为 internal。 */
export function providerErrorFromUnknown(
  error: unknown,
  opts: { transportPhase: ProviderTransportPhase; retryable?: boolean }
): ProviderError {
  if (error instanceof ProviderError) return error
  const diagnostics = collectErrorDiagnostics(error, opts.transportPhase, 'internal')
  return new ProviderError(`模型调用失败：${sanitizeErrorText(errorText(error), 160)}`, {
    code: 'PROVIDER_INTERNAL',
    category: 'internal',
    retryable: opts.retryable ?? true,
    diagnostics,
    cause: error
  })
}

function pickCause(value: unknown): ProviderCauseInfo {
  if (value === null || typeof value !== 'object') {
    return {
      name: typeof value,
      message: sanitizeErrorText(String(value), MAX_CAUSE_MESSAGE)
    }
  }
  const record = value as Record<string, unknown>
  const rawName = record['name']
  const name =
    typeof rawName === 'string' && rawName !== ''
      ? rawName.slice(0, 80)
      : value instanceof Error
        ? value.constructor.name
        : 'Object'
  const info: ProviderCauseInfo = { name }
  const code = record['code']
  if (typeof code === 'string' && code !== '') info.code = code.slice(0, 80)
  else if (typeof code === 'number' && Number.isFinite(code)) info.code = String(code)
  const errno = record['errno']
  if (typeof errno === 'string' && errno !== '') info.errno = errno.slice(0, 80)
  else if (typeof errno === 'number' && Number.isFinite(errno)) info.errno = errno
  const syscall = record['syscall']
  if (typeof syscall === 'string' && syscall !== '') info.syscall = syscall.slice(0, 80)
  const message = record['message']
  if (typeof message === 'string' && message !== '') {
    info.message = sanitizeErrorText(message, MAX_CAUSE_MESSAGE)
  }
  return info
}

function causeOf(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return undefined
  const cause = (value as { cause?: unknown }).cause
  return cause === undefined || cause === null ? undefined : cause
}

function aggregateErrors(value: unknown): unknown[] | null {
  if (value === null || typeof value !== 'object') return null
  if (!(value instanceof AggregateError)) return null
  return Array.isArray(value.errors) ? value.errors : []
}
