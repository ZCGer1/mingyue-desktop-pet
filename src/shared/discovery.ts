import type { BrowserFailureStage } from './browserControl'

/**
 * 主动浏览发现的共享类型与校验。
 *
 * 这里只放主进程、渲染进程和设置页都能看到的结构化视图；
 * 真正的持久化、证据推导和去重在 DiscoveryStore 内完成。
 * 普通网页与 B 站共用一份列表；网址只接受经过校验的公开规范形状，
 * 模型不能自带 URL。
 */

export const DISCOVERY_SITE_BILIBILI = 'bilibili' as const
export const DISCOVERY_SITE_WEB = 'web' as const
export type DiscoverySite = typeof DISCOVERY_SITE_BILIBILI | typeof DISCOVERY_SITE_WEB

export type DiscoveryKind = 'video' | 'webpage'

export type DiscoveryEvidenceLevel =
  | 'metadata'
  | 'description'
  | 'subtitle-partial'
  | 'subtitle'
  /** 本地转写实际返回并读到了文字（不是“已排队”）。 */
  | 'transcript'
  /** 故事板画面实际作为图片进入了本轮模型请求。 */
  | 'video-frames'
  | 'link'
  | 'excerpt'
  | 'content'

export type DiscoveryShareState = 'discovered' | 'pending-share' | 'shared' | 'opened'

export type DiscoveryFeedbackKind = 'like' | 'less' | 'drop-topic'

/** 仅用于 UI 与提示的诚实证据说明；不参与可信度计算。 */
export const DISCOVERY_EVIDENCE_LABELS: Record<DiscoveryEvidenceLevel, string> = {
  metadata: '仅标题',
  description: '看了简介',
  'subtitle-partial': '看了部分字幕',
  subtitle: '依据字幕全文',
  transcript: '依据本地转写',
  'video-frames': '依据视频画面',
  link: '仅链接/摘要',
  excerpt: '读了部分正文',
  content: '读了正文范围'
}

export const DISCOVERY_FEEDBACK_LABELS: Record<DiscoveryFeedbackKind, string> = {
  like: '喜欢这类',
  less: '少分享这类',
  'drop-topic': '别再研究这个'
}

export interface DiscoveryRecord {
  id: string
  site: DiscoverySite
  kind: DiscoveryKind
  /** 公开页面域名；B 站固定为 www.bilibili.com。 */
  domain: string
  /** B 站视频 ID；普通网页为空串。 */
  videoId: string
  partId: number | null
  canonicalUrl: string
  title: string
  author: string
  discoveredAt: number
  lastCheckedAt: number
  interestIds: string[]
  topicTags: string[]
  reason: string
  summary: string
  evidenceLevel: DiscoveryEvidenceLevel
  subtitleCoverage: number | null
  evidenceRefs: string[]
  shareState: DiscoveryShareState
  sharedAt: number | null
  openedAt: number | null
  feedback: DiscoveryFeedbackKind | null
  feedbackAt: number | null
  /** 运行时标记：记忆关闭时创建、不会落盘的记录。持久化前会被剥掉。 */
  ephemeral?: boolean
}

/** 页面真实观察输入；World 只从扩展回执构造，模型不能直接填写。 */
export interface DiscoveryObservationInput {
  /** 缺省为 B 站，兼容既有调用；普通网页必须显式传 web。 */
  site?: DiscoverySite
  /** B 站页面实际给出的规范视频 ID（来自 DOM 链接），不是模型记忆。 */
  videoId?: string
  partId?: number | null
  /** 普通网页的真实页面地址；只在 site=web 时使用。 */
  url?: string
  /** 页面里实际出现的正文摘录，仅用于判断证据等级，不持久化正文。 */
  excerpt?: string
  /** 是否通过 browser_read 真正读取了正文范围。 */
  contentRead?: boolean
  title: string
  author?: string
  /** 详情页简介是否实际非空；只用于证据层级，不持久化正文。 */
  description?: string
  tags?: string[]
  /** 字幕可获取状态；unknown/失败一律当作没有字幕。 */
  subtitle?: {
    status: 'none' | 'partial' | 'full'
    coverage?: number | null
  } | null
  /** 本地转写实际返回文字后才算证据；“已排队/运行中”不填。 */
  transcript?: {
    status: 'succeeded' | 'empty'
    chars?: number | null
  } | null
  /** 实际进入本轮模型请求的故事板帧数；只下载不算。 */
  visionFrames?: {
    delivered: number
    times?: number[]
  } | null
  now?: number
}

export interface DiscoveryObservationToken {
  observationId: string
  expiresAt: number
  evidenceLevel: DiscoveryEvidenceLevel
}

export interface SaveDiscoveryInput {
  observationId: string
  reason: string
  summary?: string
  topicTags?: string[]
  interestIds?: string[]
  now?: number
}

export interface SaveDiscoveryResult {
  ok: boolean
  code?:
    | 'DISCOVERY_STALE'
    | 'DISCOVERY_INVALID'
    | 'DISCOVERY_LIMIT'
    | 'DISCOVERY_NOT_FOUND'
    | 'MEMORY_OFF'
  message: string
  discovery?: DiscoveryRecord
  /** true 表示命中去重键并更新了原记录，没有新建。 */
  merged?: boolean
}

/** 渲染进程只拿到展示所需字段；证据引用等内部凭据不下发。 */
export interface DiscoveryCardView {
  id: string
  site: DiscoverySite
  kind: DiscoveryKind
  domain: string
  videoId: string
  partId: number | null
  url: string
  title: string
  author: string
  reason: string
  summary: string
  topicTags: string[]
  evidenceLevel: DiscoveryEvidenceLevel
  evidenceLabel: string
  subtitleCoverage: number | null
  shareState: DiscoveryShareState
  discoveredAt: number
  feedback: DiscoveryFeedbackKind | null
  /** 本次运行的内存记录：重启后不保留。 */
  memoryOnly: boolean
}

export interface DiscoveryListView {
  enabled: boolean
  memoryOnly: boolean
  items: DiscoveryCardView[]
  total: number
  retentionDays: number
  maxRecords: number
}

/**
 * 主动网页浏览（浏览器扩展路线）的会话阶段。
 *
 * 独立 B 站阅读有独立的服务与状态类型；这里只描述普通网页的后台标签
 * 会话，不再包含站点专属阶段。
 */
export type BrowsePhase =
  | 'off'
  | 'waiting-prerequisites'
  | 'idle'
  | 'reading-page'
  | 'paused'
  | 'error'

export type BrowseFailureCode =
  | 'extension-offline'
  | 'extension-unsupported'
  | 'protocol-mismatch'
  | 'browser-control-off'
  | 'no-consent'
  | 'exploration-off'
  | 'browser-tabs-off'
  | 'autonomous-restricted'
  | 'parse-failed'
  | 'network'
  | 'open-failed'
  | 'navigate-failed'
  | 'load-timeout'
  | 'bridge-timeout'
  | 'budget'
  | 'taken-over'
  | 'tab-lost'
  | 'guard-unavailable'
  | 'playback-uncontrolled'
  | 'mute-unavailable'
  | 'no-session'
  | 'stopped'
  | 'cooldown'
  | 'unknown'

export const BROWSE_FAILURE_LABELS: Record<BrowseFailureCode, string> = {
  'extension-offline': '浏览器扩展未连接',
  'extension-unsupported': '运行中的扩展版本不支持该浏览指令',
  'protocol-mismatch': '扩展协议版本与应用不匹配',
  'browser-control-off': '主动浏览控制未开启',
  'no-consent': '缺少浏览器控制同意',
  'exploration-off': '自由探索总开关未开启',
  'browser-tabs-off': '浏览范围内未允许浏览器标签页',
  'autonomous-restricted': '扩展到自主浏览的限制拒绝了这个动作',
  'parse-failed': '页面结构变化，暂时读不到内容',
  network: '网络或页面加载失败',
  'open-failed': '浏览器未能创建浏览标签页',
  'navigate-failed': '浏览器未能完成页面跳转',
  'load-timeout': '页面加载超时',
  'bridge-timeout': '浏览器控制通道等待回执超时',
  budget: '本次浏览用量已用完',
  'taken-over': '你接管了页面，她已停下',
  'tab-lost': '她的后台标签页已丢失',
  'guard-unavailable': '无法确认不播放，已停止进入页面',
  'playback-uncontrolled': '检测到媒体仍在播放，已停止继续浏览',
  'mute-unavailable': '无法静音她的标签页，已停止',
  'no-session': '还没有开始浏览会话',
  stopped: '主动浏览已停止',
  cooldown: '浏览已暂停/冷却中',
  unknown: '暂时无法浏览'
}

export interface BrowsePrerequisiteView {
  extensionConnected: boolean
  browserControlEnabled: boolean
  consent: boolean
  explorationEnabled: boolean
  browserTabs: boolean
  memoryEnabled: boolean
  /** 扩展实际运行版本/协议/构建；不是磁盘发布版本。 */
  extensionVersion: string | null
  extensionProtocol: number | null
  extensionBuildId: string | null
}

/**
 * 一条持久化的主动浏览失败诊断。只包含时间、来源、工具与固定枚举，
 * 不含页面标题、正文、URL 或查询参数；用于重启后仍能追溯。
 */
export interface BrowseFailureRecordView {
  /** ISO 时间；由 audit.jsonl 的 ts 原样展示。 */
  at: string
  tool: string
  /** 发起入口：chat / quick（审计里的 origin）。 */
  origin: string
  source: string
  code: string | null
  rawCode: string | null
  stage: string | null
  retryable: boolean | null
  cooldown: boolean
  durationMs: number | null
  commandId: string | null
  instanceId: string | null
  extensionVersion: string | null
  extensionBuildId: string | null
  protocolVersion: number | null
}

export interface BrowseStatusView {
  enabled: boolean
  phase: BrowsePhase
  phaseLabel: string
  active: boolean
  sessionActive: boolean
  sessionStartedAt: number | null
  sessionToolCalls: number
  sessionMaxToolCalls: number
  lastFailure: BrowseFailureCode | null
  lastFailureLabel: string | null
  /** 扩展/桥接返回的原始安全错误码，便于定位且不包含页面内容。 */
  lastFailureRawCode: string | null
  lastFailureStage: BrowserFailureStage | null
  lastFailureRetryable: boolean | null
  /** 最近若干次持久化的失败诊断（含来源/时间），不会覆盖历史审计。 */
  recentFailures: BrowseFailureRecordView[]
  lastActivityAt: number | null
  stoppedUntil: number | null
  prerequisites: BrowsePrerequisiteView
  discoveryCount: number
  memoryOnly: boolean
}

const BROWSE_PHASE_LABELS: Record<BrowsePhase, string> = {
  off: '未开启',
  'waiting-prerequisites': '等待授权或扩展',
  idle: '空闲，可能有空时会逛逛',
  'reading-page': '正在读网页',
  paused: '已暂停',
  error: '这次没逛成'
}

export function browsePhaseLabel(phase: BrowsePhase): string {
  return BROWSE_PHASE_LABELS[phase] ?? BROWSE_PHASE_LABELS.off
}

export function browseFailureLabel(code: BrowseFailureCode | null): string | null {
  return code === null ? null : (BROWSE_FAILURE_LABELS[code] ?? BROWSE_FAILURE_LABELS.unknown)
}

/** B 站规范视频 ID：BV + 10 位字母数字。 */
const BILI_VIDEO_ID = /^BV[0-9A-Za-z]{10}$/

export interface BiliVideoRef {
  videoId: string
  partId: number | null
  canonicalUrl: string
}

/**
 * 只接受 https://www.bilibili.com/video/BV... 的规范形状。
 * 用户名、密码、端口、片段、多余路径和未知参数一律拒绝；
 * 可识别的 `p` 分 P 参数归一化为数字后重新拼装，绝不原样保存。
 */
export function parseBiliVideoUrl(input: unknown): BiliVideoRef | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (raw.length === 0 || raw.length > 300) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '' || url.port !== '') return null
  if (url.hash !== '') return null
  if (url.hostname.toLowerCase() !== 'www.bilibili.com') return null
  const match = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(url.pathname)
  if (!match) return null
  const videoId = match[1]
  if (videoId === undefined || !BILI_VIDEO_ID.test(videoId)) return null

  let partId: number | null = null
  for (const [key, value] of url.searchParams.entries()) {
    if (key !== 'p') return null
    if (!/^[1-9][0-9]{0,2}$/.test(value)) return null
    if (partId !== null) return null
    partId = Number(value)
  }
  const canonicalUrl = canonicalUrlForBili(videoId, partId)
  if (canonicalUrl === null) return null
  return { videoId, partId, canonicalUrl }
}

/** 由已校验的 ID 重新拼装，永远不拼接用户/模型提供的原始 URL。 */
export function canonicalUrlForBili(videoId: string, partId: number | null): string | null {
  if (!BILI_VIDEO_ID.test(videoId)) return null
  if (partId !== null && (!Number.isInteger(partId) || partId < 1 || partId > 999)) return null
  return `https://www.bilibili.com/video/${videoId}${partId !== null ? `?p=${partId}` : ''}`
}

/** 规范分 P 标识：没有 partId 时为空串，用于去重键。 */
export function discoveryDedupeKey(site: DiscoverySite, videoId: string, partId: number | null): string {
  return `${site}:${videoId}:${partId ?? 0}`
}

export function discoveryKindForSite(site: DiscoverySite): DiscoveryKind {
  return site === DISCOVERY_SITE_WEB ? 'webpage' : 'video'
}

/** 普通网页去重键：只使用经过校验和正规化的地址。 */
export function webDiscoveryDedupeKey(canonicalUrl: string): string | null {
  const ref = parsePublicWebUrl(canonicalUrl)
  return ref === null ? null : `web:${ref.canonicalUrl}`
}

export interface PublicWebRef {
  canonicalUrl: string
  domain: string
}

/** 已知追踪参数：不改变页面内容，可安全剥离。 */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref_src',
  'ref_url',
  'spm',
  'scm',
  'share_source',
  'share_medium',
  'share_plat',
  'share_session_id',
  'share_tag',
  'share_times',
  'share_from',
  'vd_source',
  'from_spmid',
  'from_source',
  'is_story_h5',
  'buvid'
])

/**
 * 身份/会话参数：地址里出现这些键就不保存，避免把登录态或账号标识写进发现。
 * 只做键名判断，不读取值，也不记录被拒绝的地址。
 */
const IDENTITY_PARAMS = /(?:^|[_-])(?:token|auth|authorization|session|sessionid|sess|ticket|signature|secret|password|passwd|credential|apikey|api_key|accesskey|access_key|ssid|sessdata|bili_jct|dedeuserid|uid|userid|user_id|email|phone|mobile)(?:$|[_-])/i

/** 登录、账号、私信、订单等非公开页面路径。 */
const PRIVATE_PATH =
  /\/(?:login|log-in|signin|sign-in|signup|sign-up|register|auth|oauth|account|accounts|profile|settings|messages|message|chat|inbox|mail|dm|notifications|orders|purchase|wallet|billing|admin|wp-admin|user|users)(?:\/|$)/i

/** 常见的登录/账号/邮箱主机；这些页面即使是公开 URL 也不作为发现保存。 */
const PRIVATE_HOST =
  /(?:^|\.)(?:accounts?|login|signin|auth|sso|passport|mail|webmail|outlook|protonmail|messages|chat)\./i

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match === null) return false
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

function isPrivateIpv6(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!bare.includes(':')) return false
  return (
    bare === '::1' ||
    bare === '::' ||
    bare.startsWith('fc') ||
    bare.startsWith('fd') ||
    bare.startsWith('fe80:')
  )
}

function isPublicWebHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === '' || host.length > 253) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) {
    return false
  }
  if (host.endsWith('.home') || host.endsWith('.intranet') || host.endsWith('.corp')) {
    return false
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return false
  if (host.startsWith('[')) return isPrivateIpv6(host)
  // 单标签主机通常指向内网设备或搜索词，不是公开网页。
  if (!host.includes('.')) return false
  return true
}

function normalizeWebQuery(url: URL): string | null {
  const kept: Array<[string, string]> = []
  for (const [key, value] of url.searchParams.entries()) {
    if (key === '' || key.length > 80 || value.length > 500) return null
    const normalizedKey = key.toLowerCase()
    // utm_* 是标准投放追踪参数，不改变页面内容。
    if (TRACKING_PARAMS.has(normalizedKey) || normalizedKey.startsWith('utm_')) continue
    if (IDENTITY_PARAMS.test(key)) return null
    kept.push([key, value])
  }
  // 保留影响内容的 query 参数，只去掉已知追踪项；排序保证同一页面稳定去重。
  kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  const query = new URLSearchParams()
  for (const [key, value] of kept) query.append(key, value)
  return query.toString()
}

/**
 * 只接受可公开读取的普通网页：https、无凭据/端口/片段，主机不是内网或
 * 登录类域名，路径不是账号/私信/登录页。保留内容 query，剥离追踪参数。
 * 返回的 canonicalUrl 由校验后的片段重新拼装，绝不原样保存输入。
 */
export function parsePublicWebUrl(input: unknown): PublicWebRef | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (raw.length === 0 || raw.length > 2000) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '' || url.port !== '') return null
  if (url.hash !== '') return null
  const domain = url.hostname.toLowerCase()
  if (!isPublicWebHost(domain)) return null
  if (PRIVATE_HOST.test(domain)) return null
  const pathname = url.pathname === '' ? '/' : url.pathname
  if (pathname.length > 1000) return null
  if (PRIVATE_PATH.test(pathname)) return null
  const query = normalizeWebQuery(url)
  if (query === null) return null
  const canonicalUrl = `https://${domain}${pathname}${query === '' ? '' : `?${query}`}`
  if (canonicalUrl.length > 1500) return null
  return { canonicalUrl, domain }
}

export function discoveryCardUrl(record: {
  site?: DiscoverySite
  canonicalUrl: string
}): string {
  if (record.site === DISCOVERY_SITE_WEB) {
    return parsePublicWebUrl(record.canonicalUrl)?.canonicalUrl ?? ''
  }
  return parseBiliVideoUrl(record.canonicalUrl)?.canonicalUrl ?? ''
}
