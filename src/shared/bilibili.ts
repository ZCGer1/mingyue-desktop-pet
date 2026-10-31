/**
 * B 站 API 阅读路线的共享契约。
 *
 * 这里只放可序列化的状态、错误枚举、阅读/日报结构和纯函数；真正的网络、
 * Python 生命周期与凭据都在主进程。渲染进程只接触展示字段，永远拿不到
 * SESSDATA 等凭据。
 */

import type { DiscoveryEvidenceLevel } from './discovery'

/** 主进程 B 站服务状态机。 */
export type BiliServiceState = 'stopped' | 'starting' | 'ready' | 'failed'

/** 设置页展示的总体阶段。 */
export type BiliPhase =
  | 'disabled'
  | 'missing-consent'
  | 'env-missing'
  | 'installing'
  | 'starting'
  | 'login-required'
  | 'login-expired'
  | 'ready'
  | 'stopped'
  | 'fault'

export const BILI_PHASE_LABELS: Record<BiliPhase, string> = {
  disabled: '未启用',
  'missing-consent': '等待你确认启用',
  'env-missing': '需要安装 B 站服务',
  installing: '正在安装依赖',
  starting: '服务启动中',
  'login-required': '需要扫码登录',
  'login-expired': '登录已失效，需要重新扫码',
  ready: '可读取推荐、搜索与视频原文',
  stopped: '已停止，等待恢复',
  fault: '服务故障，可重试'
}

/** 扫码登录状态；二维码过期与请求失败分开。 */
export type BiliLoginState =
  | 'unlogged'
  | 'waiting-scan'
  | 'scanned'
  | 'expired'
  | 'logged-in'
  | 'session-expired'
  | 'error'

export const BILI_LOGIN_LABELS: Record<BiliLoginState, string> = {
  unlogged: '未登录',
  'waiting-scan': '等待扫码',
  scanned: '已扫码，等待手机确认',
  expired: '二维码已过期',
  'logged-in': '已登录',
  'session-expired': '登录已失效',
  error: '登录请求失败'
}

export type BiliInstallState = 'unknown' | 'missing' | 'installing' | 'ready' | 'failed'
export type BiliInstallKind = 'python' | 'service' | 'asr' | 'model'

export interface BiliInstallView {
  kind: BiliInstallKind
  state: BiliInstallState
  /** 0–1；只在安装中给出，未知时为 null。 */
  progress: number | null
  message: string | null
  /** 只放版本号，不放安装路径。 */
  version: string | null
  updatedAt: number | null
}

/** 失败阶段固定枚举，避免把账号响应原文写进诊断。 */
export type BiliFailureStage =
  | 'config'
  | 'environment'
  | 'login'
  | 'service'
  | 'network'
  | 'parse'
  | 'subtitle'
  | 'vision'
  | 'asr'
  | 'report'
  | 'budget'
  | 'cancel'
  | 'unknown'

export type BiliReadFailureCode =
  | 'disabled'
  | 'no-consent'
  | 'exploration-off'
  | 'python-missing'
  | 'service-not-installed'
  | 'service-start-failed'
  | 'service-crashed'
  | 'service-timeout'
  | 'login-required'
  | 'login-expired'
  | 'qrcode-expired'
  | 'login-cancelled'
  | 'risk-control'
  | 'captcha'
  | 'not-found'
  | 'no-candidates'
  | 'excluded'
  | 'video-unavailable'
  | 'no-subtitle'
  | 'parse-failed'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'budget'
  | 'no-session'
  | 'stopped'
  | 'cooldown'
  | 'vision-unavailable'
  | 'asr-disabled'
  | 'asr-not-installed'
  | 'asr-model-missing'
  | 'asr-limit'
  | 'asr-failed'
  | 'asr-empty'
  | 'evidence-insufficient'
  | 'report-failed'
  | 'internal'

export const BILI_FAILURE_LABELS: Record<BiliReadFailureCode, string> = {
  disabled: 'B 站阅读未启用',
  'no-consent': '缺少 B 站 API 阅读同意',
  'exploration-off': '自由探索总开关未开启',
  'python-missing': '找不到可用的 Python',
  'service-not-installed': 'B 站服务依赖尚未安装',
  'service-start-failed': 'B 站服务启动失败',
  'service-crashed': 'B 站服务意外退出',
  'service-timeout': 'B 站服务响应超时',
  'login-required': '需要扫码登录 B 站',
  'login-expired': 'B 站登录已失效',
  'qrcode-expired': '二维码已过期',
  'login-cancelled': '扫码登录已取消',
  'risk-control': 'B 站风控要求稍后再试',
  captcha: 'B 站要求验证码，需要你处理',
  'not-found': '没有找到这个视频或候选',
  'no-candidates': '这次请求正常返回了空列表',
  excluded: '内容命中本地排除词，已跳过',
  'video-unavailable': '视频不可见或已删除',
  'no-subtitle': '没有可读取的字幕',
  'parse-failed': 'B 站返回内容结构变化，暂时无法解析',
  network: '网络请求失败',
  timeout: '请求超时',
  cancelled: '已取消',
  budget: '本轮 B 站读取用量已用完',
  'no-session': '还没有开始阅读会话',
  stopped: 'B 站阅读已停止',
  cooldown: 'B 站阅读正在冷却',
  'vision-unavailable': '当前模型或配置不能接收图片，无法用画面作证据',
  'asr-disabled': '本地转写已在设置中关闭',
  'asr-not-installed': '本地转写依赖尚未安装',
  'asr-model-missing': '本地转写模型尚未准备',
  'asr-limit': '转写超过时长、体积或缓存限制',
  'asr-failed': '本地转写失败',
  'asr-empty': '本地转写没有识别出文字',
  'evidence-insufficient': '这次读到的证据不足，不能给出评价',
  'report-failed': '日报写入失败，可从阅读记录重建',
  internal: '内部错误'
}

export interface BiliFailureView {
  code: BiliReadFailureCode
  label: string
  stage: BiliFailureStage
  retryable: boolean
  at: number
  /** 已净化的短消息；不包含账号响应、URL 查询串或凭据。 */
  message: string | null
  requestId: string | null
  elapsedMs: number | null
}

export type BiliAsrState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'empty'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export const BILI_ASR_LABELS: Record<BiliAsrState, string> = {
  queued: '排队中',
  running: '转写中',
  succeeded: '转写完成',
  empty: '没有识别出文字',
  failed: '转写失败',
  cancelled: '已取消',
  interrupted: '重启中断'
}

export interface BiliAsrJobView {
  id: string
  bvid: string
  partIndex: number
  title: string
  state: BiliAsrState
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  durationSec: number | null
  model: string
  attempts: number
  errorCode: BiliReadFailureCode | null
  errorMessage: string | null
  chars: number | null
}

export interface BiliSessionView {
  active: boolean
  runId: string | null
  startedAt: number | null
  toolCalls: number
  maxToolCalls: number
  details: number
  maxDetails: number
  candidatesSeen: number
  stoppedUntil: number | null
  cooldownReason: string | null
  lastFailure: BiliFailureView | null
}

export interface BiliEnvironmentView {
  /** 只展示探测结果，不展示 Python 路径。 */
  pythonFound: boolean
  pythonVersion: string | null
  python: BiliInstallView
  service: BiliInstallView
  asr: BiliInstallView
  model: BiliInstallView
}

export interface BiliLoginView {
  state: BiliLoginState
  accountName: string | null
  /** 只显示脱敏后的 UID 尾部。 */
  uidMasked: string | null
  savedAt: number | null
  message: string | null
}

export interface BiliStatusView {
  phase: BiliPhase
  phaseLabel: string
  enabled: boolean
  consented: boolean
  explorationActive: boolean
  service: {
    state: BiliServiceState
    startedAt: number | null
    restarts: number
    version: string | null
    lastError: BiliFailureView | null
  }
  environment: BiliEnvironmentView
  login: BiliLoginView
  session: BiliSessionView
  vision: {
    available: boolean
    reason: string | null
  }
  report: {
    enabled: boolean
    retentionDays: number
    todayDate: string
    todayPath: string | null
    todayReady: boolean
    /** 最近一次日报写入失败的安全说明；不影响已保存的阅读记录。 */
    lastError: string | null
  }
  asr: {
    enabled: boolean
    model: string
    running: number
    queued: number
    recent: BiliAsrJobView[]
  }
  limits: {
    sessionMaxMs: number
    sessionMaxToolCalls: number
    maxDetailsPerSession: number
    maxCandidatesPerBatch: number
    maxFrames: number
    asrMaxMediaMinutes: number
    asrMaxDownloadMb: number
    asrMaxRunMinutes: number
    asrMaxCacheMb: number
  }
  recentFailures: BiliFailureView[]
}

/** 扫码登录的展示结果；二维码图片只在本机渲染，不写日志。 */
export interface BiliLoginQrView {
  state: BiliLoginState
  /** `data:image/png;base64,...`；过期/成功后为 null。 */
  imageDataUrl: string | null
  expiresAt: number | null
  accountName: string | null
  uidMasked: string | null
  message: string | null
}

export type BiliVerdict = 'worth' | 'okay' | 'skip' | 'unknown'

export const BILI_VERDICT_LABELS: Record<BiliVerdict, string> = {
  worth: '值得看',
  okay: '可以看',
  skip: '不推荐',
  unknown: '暂无法判断'
}

export interface BiliSubtitleRead {
  status: 'full' | 'partial' | 'none'
  language: string | null
  /** 0–1，按实际读到的段数 / 可读段数计算。 */
  coverage: number
  segmentsRead: number
  segmentsTotal: number
  chars: number
  readAt: number
  partIndex: number
  /** 只保留真实可读到的分 P；不把第 1P 当成整条视频。 */
  cid: number | null
}

export interface BiliFrameRead {
  delivered: number
  requested: number
  times: number[]
  coveredSec: number | null
  at: number
  partIndex: number
}

export interface BiliAsrRead {
  jobId: string
  state: BiliAsrState
  model: string
  submittedAt: number
  finishedAt: number | null
  chars: number | null
  errorCode: BiliReadFailureCode | null
}

/** 结构化阅读记录；日报与去重都从这里投影，不从 Markdown 反推。 */
export interface BiliReadingRecord {
  id: string
  /** 账号分区只存哈希前缀；账号切换后不复用旧分区。 */
  accountKey: string
  bvid: string
  partIndex: number
  cid: number | null
  title: string
  author: string
  url: string
  durationSec: number | null
  origin: 'recommend' | 'search' | 'open'
  query: string | null
  discoveredAt: number
  updatedAt: number
  descriptionReadAt: number | null
  descriptionChars: number
  tags: string[]
  subtitle: BiliSubtitleRead | null
  frames: BiliFrameRead | null
  asr: BiliAsrRead | null
  /** 实际读过的转写字符数；只记录读取覆盖，不保存转写全文。 */
  transcriptReadChars: number
  verdict: BiliVerdict | null
  reason: string | null
  keyPoints: string[]
  evidenceLevel: DiscoveryEvidenceLevel | null
  discoveryId: string | null
  /** 首次进入探索的本地日期（Asia/Shanghai）。 */
  explorationDate: string
  /** 完成评价或转写的本地日期；跨日时与 explorationDate 不同。 */
  completedDate: string | null
}

export interface BiliReportSummary {
  date: string
  path: string | null
  exists: boolean
  inMemory: boolean
  entries: number
  worth: number
  okay: number
  skip: number
  unknown: number
  skipped: number
  failed: number
  generatedAt: number | null
  markdown: string
}

export interface BiliReportEntryView {
  id: string
  title: string
  author: string
  url: string
  verdict: BiliVerdict
  reason: string
  evidenceLevel: DiscoveryEvidenceLevel | null
  subtitleCoverage: number | null
  frameTimes: number[]
  explorationDate: string
  completedDate: string | null
}

/** 阅读记录的一次快照；IPC 只下发日报所需的展示字段。 */
export interface BiliReadingView {
  date: string
  entries: BiliReportEntryView[]
  counts: {
    checked: number
    worth: number
    okay: number
    skip: number
    unknown: number
  }
}

/** 「本轮阅读」卡里的单个视频；只有宿主能生成，URL 由 biliVideoUrl 推导。 */
export interface BiliSessionReportVideoView {
  bvid: string
  partIndex: number
  /** 1-based 展示页码。 */
  part: number
  title: string
  author: string
  /** 宿主用 biliVideoUrl(bvid, partIndex) 推导，绝不接受模型传入。 */
  url: string
  verdict: BiliVerdict | null
  reason: string | null
  evidenceLevel: DiscoveryEvidenceLevel | null
  /** 0–1；没有字幕时为 null。 */
  subtitleCoverage: number | null
  /** 实际交付给模型的画面张数。 */
  frameCount: number
  /** 实际读过的转写字符数。 */
  transcriptChars: number
}

/** 一轮 B 站阅读结束后由宿主生成的展示快照；只存在运行时内存。 */
export interface BiliSessionReportView {
  /** 会话 runId，用于 UI 去重。 */
  id: string
  at: number
  reason: 'turn' | 'stop' | 'budget' | 'timeout'
  videos: BiliSessionReportVideoView[]
}

/**
 * 桌宠迷你视频卡只展示标题/作者/分P，点开时由主进程重建 URL。
 * 这里刻意不包含 url、理由、判定与证据字段，避免完整报告进入桌宠页。
 */
export interface PetBiliReportVideoView {
  bvid: string
  partIndex: number
  /** 1-based 展示页码。 */
  part: number
  title: string
  author: string
}

export interface PetBiliReportEvent {
  /** 本轮有效视频总数；videos 只带前几条。 */
  total: number
  videos: PetBiliReportVideoView[]
}

export type BiliSettingsAction =
  | { action: 'stop' | 'resume' }
  | { action: 'login-start' }
  | { action: 'login-cancel' }
  | { action: 'logout' }
  | { action: 'install'; kind: BiliInstallKind }
  | { action: 'retry-service' }
  | { action: 'report-open' }
  | { action: 'report-open-folder' }

export interface BiliReportOpenResult {
  ok: boolean
  message: string
  path: string | null
}

/** 固定站点域名；主进程与 Python 服务都只访问这些来源。 */
export const BILI_ALLOWED_HOSTS = ['www.bilibili.com', 'api.bilibili.com', 'passport.bilibili.com'] as const
export const BILI_ASSET_HOST_SUFFIXES = ['hdslb.com', 'bilivideo.com'] as const

const BVID_RE = /^BV[0-9A-Za-z]{10}$/

export function isBvid(value: unknown): value is string {
  return typeof value === 'string' && BVID_RE.test(value)
}

export function biliVideoUrl(bvid: string, partIndex = 0): string {
  const page = Number.isInteger(partIndex) && partIndex > 0 ? `?p=${partIndex + 1}` : ''
  return `https://www.bilibili.com/video/${bvid}/${page}`
}

/** 0-based 分 P 序号 → 展示用 1-based 页码。 */
export function partNumber(partIndex: number): number {
  return Number.isInteger(partIndex) && partIndex >= 0 ? partIndex + 1 : 1
}

export function safePartIndex(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(n) || n < 0 || n > 199) return 0
  return n
}

const PET_BILI_REPORT_VIDEO_LIMIT = 3
const PET_BILI_TITLE_MAX = 120
const PET_BILI_AUTHOR_MAX = 60
/** 控制字符、零宽字符与双向控制字符：展示前统一剥离，避免伪造行/顺序。 */
const UNSAFE_PET_TEXT_RE =
  /[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu

function cleanPetText(value: string, max: number): string {
  const cleaned = value.replace(UNSAFE_PET_TEXT_RE, ' ').replace(/\s+/g, ' ').trim()
  const points = Array.from(cleaned)
  return points.length <= max ? cleaned : points.slice(0, max).join('').trimEnd()
}

/**
 * 完整报告 → 桌宠气泡安全视图。非法 bvid 直接丢弃；没有有效视频时返回 null，
 * 不生成空卡片。标题/作者按码点截断，回退值不带任何页面内容。
 */
export function toPetBiliReportEvent(
  report: BiliSessionReportView
): PetBiliReportEvent | null {
  const videos: PetBiliReportVideoView[] = []
  for (const video of report.videos) {
    if (!isBvid(video.bvid)) continue
    const partIndex = safePartIndex(video.partIndex)
    videos.push({
      bvid: video.bvid,
      partIndex,
      part: partNumber(partIndex),
      title: cleanPetText(video.title, PET_BILI_TITLE_MAX) || video.bvid,
      author: cleanPetText(video.author, PET_BILI_AUTHOR_MAX) || '未知 UP 主'
    })
  }
  if (videos.length === 0) return null
  return { total: videos.length, videos: videos.slice(0, PET_BILI_REPORT_VIDEO_LIMIT) }
}

/** 固定 Asia/Shanghai 的本地日期键；日报“当天”按用户所在时区。 */
export function localDateKey(timestamp: number, timeZone = 'Asia/Shanghai'): string {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return '1970-01-01'
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970'
  const month = parts.find((part) => part.type === 'month')?.value ?? '01'
  const day = parts.find((part) => part.type === 'day')?.value ?? '01'
  return `${year}-${month}-${day}`
}

export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export const BILI_ACCOUNT_ANONYMOUS = 'anonymous'

/** 账号分区只用哈希前缀，不把 UID 原文写进阅读记录/日报。 */
export function accountPartition(uid: string | null, hash: (value: string) => string): string {
  const raw = typeof uid === 'string' ? uid.trim() : ''
  if (raw === '') return BILI_ACCOUNT_ANONYMOUS
  return hash(raw).slice(0, 16)
}

export function maskUid(uid: string | null): string | null {
  const raw = typeof uid === 'string' ? uid.trim() : ''
  if (raw === '') return null
  return raw.length <= 4 ? `…${raw}` : `…${raw.slice(-4)}`
}

export function biliFailure(
  code: BiliReadFailureCode,
  stage: BiliFailureStage,
  options: {
    at?: number
    retryable?: boolean
    message?: string | null
    requestId?: string | null
    elapsedMs?: number | null
  } = {}
): BiliFailureView {
  return {
    code,
    label: BILI_FAILURE_LABELS[code],
    stage,
    retryable: options.retryable ?? false,
    at: options.at ?? Date.now(),
    message: options.message ?? null,
    requestId: options.requestId ?? null,
    elapsedMs: options.elapsedMs ?? null
  }
}
