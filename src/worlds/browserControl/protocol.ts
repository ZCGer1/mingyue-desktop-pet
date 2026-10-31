import {
  isBrowserFailureStage,
  type BrowserCommandResult,
  type BrowserElementInfo,
  type BrowserFailureStage,
  type BrowserSnapshot
} from '../../shared/browserControl'
import type { BrowseFailureCode } from '../../shared/discovery'

/**
 * 扩展回执与失败诊断的协议适配层。
 *
 * 这里只做无副作用的解析、分类和格式化；会话状态、权限检查、冷却与
 * 工具回执仍由 BrowserControlWorld 自己决定。
 */

export interface ObservationSummary {
  frameId: number
  tabId: number
  pageId: string
  pageVersion: number
  url: string
  title: string
}

export interface ClassifiedBrowseFailure {
  code: BrowseFailureCode
  rawCode: string | null
  stage: BrowserFailureStage | null
  retryable: boolean | null
}

export function safeDiagnosticToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const token = value.trim()
  return /^[A-Za-z0-9._:-]{1,80}$/.test(token) ? token : null
}

export function safeRawCode(code: string | undefined): string | null {
  if (typeof code !== 'string') return null
  const value = code.trim().toUpperCase()
  return /^[A-Z0-9_:-]{1,60}$/.test(value) ? value : null
}

const DEFAULT_FAILURE_STAGES: Record<string, BrowserFailureStage> = {
  UNKNOWN_COMMAND: 'dispatch',
  INVALID_COMMAND: 'dispatch',
  EXTENSION_UNSUPPORTED_OP: 'dispatch',
  EXTENSION_PROTOCOL_MISMATCH: 'dispatch',
  TIMEOUT: 'dispatch',
  BRIDGE_TIMEOUT: 'dispatch',
  AUTONOMOUS_RESTRICTED: 'preflight',
  TAB_TAKEN_OVER: 'preflight',
  TAB_NOT_OWNED: 'preflight',
  INVALID_URL: 'preflight',
  INVALID_QUERY: 'preflight',
  INVALID_ACTION: 'preflight',
  BLOCKED_DESTINATION: 'navigation',
  TAB_LIMIT: 'preflight',
  OPEN_FAILED: 'tab-create',
  NAVIGATE_FAILED: 'navigation',
  LOAD_TIMEOUT: 'content-ready',
  CONTENT_UNREACHABLE: 'content-ready',
  UNSUPPORTED_PAGE: 'content-ready',
  SNAPSHOT_FAILED: 'extraction',
  FIND_FAILED: 'extraction',
  PAGE_ACTION_FAILED: 'extraction',
  GUARD_UNAVAILABLE: 'media-guard',
  PLAYBACK_UNCONTROLLED: 'media-guard',
  MUTE_UNAVAILABLE: 'media-guard',
  TAB_CLOSED: 'result-validation',
  TAB_NOT_FOUND: 'result-validation',
  NETWORK: 'content-ready',
  CONTROL_CHANNEL_OFFLINE: 'dispatch',
  EXTENSION_OFFLINE: 'dispatch',
  BROWSE_BUDGET: 'preflight',
  BROWSE_SESSION_ENDED: 'preflight',
  DOWNLOAD_FAILED: 'dispatch',
  REMOVED_COMMAND: 'dispatch'
}

const RETRYABLE_FAILURE_CODES = new Set([
  'NETWORK',
  'LOAD_TIMEOUT',
  'CONTENT_UNREACHABLE',
  'BRIDGE_TIMEOUT',
  'TIMEOUT'
])

export function classifyBrowseFailure(result: BrowserCommandResult): ClassifiedBrowseFailure {
  const code = safeRawCode(result.code)
  const value = code ?? ''
  const codeMap: Record<string, BrowseFailureCode> = {
    TAB_TAKEN_OVER: 'taken-over',
    GUARD_UNAVAILABLE: 'guard-unavailable',
    PLAYBACK_UNCONTROLLED: 'playback-uncontrolled',
    MUTE_UNAVAILABLE: 'mute-unavailable',
    TAB_CLOSED: 'tab-lost',
    TAB_NOT_FOUND: 'tab-lost',
    TAB_NOT_OWNED: 'tab-lost',
    SNAPSHOT_FAILED: 'parse-failed',
    FIND_FAILED: 'parse-failed',
    PAGE_ACTION_FAILED: 'parse-failed',
    CONTENT_UNREACHABLE: 'parse-failed',
    UNSUPPORTED_PAGE: 'parse-failed',
    OPEN_FAILED: 'open-failed',
    NAVIGATE_FAILED: 'navigate-failed',
    LOAD_TIMEOUT: 'load-timeout',
    TIMEOUT: 'bridge-timeout',
    BRIDGE_TIMEOUT: 'bridge-timeout',
    UNKNOWN_COMMAND: 'extension-unsupported',
    EXTENSION_UNSUPPORTED_OP: 'extension-unsupported',
    EXTENSION_PROTOCOL_MISMATCH: 'protocol-mismatch',
    REMOVED_COMMAND: 'extension-unsupported',
    AUTONOMOUS_RESTRICTED: 'autonomous-restricted',
    NETWORK: 'network',
    CONTROL_CHANNEL_OFFLINE: 'extension-offline',
    EXTENSION_OFFLINE: 'extension-offline',
    BROWSE_BUDGET: 'budget',
    BROWSE_SESSION_ENDED: 'stopped'
  }
  let classified: BrowseFailureCode = 'unknown'
  if (value.startsWith('HTTP_') || value.startsWith('API_')) classified = 'network'
  else if (code !== null && codeMap[code] !== undefined) classified = codeMap[code]
  const declaredStage = isBrowserFailureStage(result.stage) ? result.stage : null
  return {
    code: classified,
    rawCode: code,
    // 扩展显式报告的 stage 优先；否则使用本地枚举映射。未知码绝不猜成页面原因。
    stage: declaredStage ?? (code === null ? null : DEFAULT_FAILURE_STAGES[code] ?? 'dispatch'),
    retryable:
      typeof result.retryable === 'boolean'
        ? result.retryable
        : code === null || classified === 'unknown'
          ? null
          : RETRYABLE_FAILURE_CODES.has(code)
  }
}

export function browseFailureHint(code: BrowseFailureCode): string {
  switch (code) {
    case 'guard-unavailable':
    case 'playback-uncontrolled':
    case 'mute-unavailable':
      return '这是安全降级：无法确认静音和不播放就停止进入页面。不要换工具或换页面绕过。'
    case 'taken-over':
      return '用户已接管这个标签页；不要继续操作、不要关闭它，也不要把接管前的旧内容当成当前页面。'
    case 'budget':
      return '本次会话已到用量上限；等下次有空或用户手动继续，不要伪造浏览结果。'
    case 'network':
    case 'load-timeout':
      return '网络或页面加载失败；不要假装已经读过内容。'
    case 'open-failed':
    case 'navigate-failed':
      return '浏览器没有完成打开/跳转；不要假设页面已经就绪，也不要假装读过内容。'
    case 'bridge-timeout':
      return '应用没有等到扩展回执，页面状态未知；不要重放动作，也不要假装已经读过内容。'
    case 'extension-unsupported':
      return '这是运行时扩展能力缺口，不是页面/网络问题。请用户更新并重新加载扩展后再试；不要改用其它方式偷偷浏览。'
    case 'protocol-mismatch':
      return '扩展与应用协议不匹配；需要更新并重载，不要绕过协议检查。'
    case 'autonomous-restricted':
      return '扩展到自主浏览的限制拒绝了该动作；不要换工具或换页面绕过。'
    case 'no-session':
      return '先用 web_open 打开她自己的后台标签页。'
    case 'parse-failed':
      return '页面结构可能变化；不要用猜测的标题或链接补全。'
    case 'stopped':
      return '浏览已停止；不要继续调用浏览工具，也不要发出基于旧页面的开场。'
    case 'cooldown':
      return '浏览已暂停/冷却中，这次没有发送任何打开或读取指令；等冷却结束或用户手动继续，不要重试绕过。'
    case 'extension-offline':
    case 'browser-control-off':
    case 'no-consent':
    case 'exploration-off':
    case 'browser-tabs-off':
      return '需要恢复扩展连接或用户授权；不要改用其它方式偷偷浏览。'
    case 'tab-lost':
      return '她自己的后台标签页已丢失；不要假设页面还在。'
    default:
      return '不要假装看过页面或编造内容；可以稍后再试或结束这次浏览。'
  }
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asObservation(value: unknown): ObservationSummary | null {
  const record = asRecord(value)
  if (record === null) return null
  if (typeof record.tabId !== 'number' || !Number.isInteger(record.tabId)) return null
  if (typeof record.pageId !== 'string' || record.pageId === '') return null
  if (!Number.isInteger(record.pageVersion)) return null
  return {
    frameId: Number.isInteger(record.frameId) ? Number(record.frameId) : Number.NaN,
    tabId: record.tabId,
    pageId: record.pageId,
    pageVersion: Number(record.pageVersion),
    url: typeof record.url === 'string' ? record.url : '',
    title: typeof record.title === 'string' ? record.title : ''
  }
}

export function asSnapshot(value: unknown): BrowserSnapshot | null {
  const record = asRecord(value)
  if (record === null) return null
  if (!Array.isArray(record.elements)) return null
  if (typeof record.pageId !== 'string' || !Number.isInteger(record.pageVersion)) return null
  if (typeof record.tabId !== 'number') return null
  return record as unknown as BrowserSnapshot
}

export function formatElement(element: Record<string, unknown> | BrowserElementInfo): string {
  const role = typeof element.role === 'string' ? element.role : '元素'
  const name = typeof element.name === 'string' ? element.name : ''
  const parts = [`${role}${name === '' ? '' : ` "${name}"`}`]
  if (typeof element.value === 'string' && element.value !== '') {
    parts.push(`value="${element.value}"`)
  }
  if (element.disabled === true) parts.push('(禁用)')
  if (element.checked === true) parts.push('(已勾选)')
  if (typeof element.href === 'string' && element.href !== '') {
    parts.push(`-> ${element.href}`)
  }
  return parts.join(' ')
}

export function targetLabel(value: unknown): string | null {
  const target = asRecord(value)
  if (target === null) return null
  const role = typeof target.role === 'string' ? target.role : ''
  const name = typeof target.name === 'string' ? target.name : ''
  if (role === '' && name === '') return null
  return `${role}${name === '' ? '' : ` "${name}"`}`.slice(0, 200)
}
