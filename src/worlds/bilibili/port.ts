import type {
  BiliAsrJobView,
  BiliAsrRead,
  BiliFrameRead,
  BiliReadFailureCode,
  BiliReadingRecord,
  BiliReportSummary,
  BiliStatusView,
  BiliSubtitleRead,
  BiliVerdict
} from '../../shared/bilibili'
import type {
  DiscoveryEvidenceLevel,
  DiscoveryObservationInput,
  DiscoveryObservationToken,
  DiscoverySite
} from '../../shared/discovery'
import type { ToolImage } from '../../core/types'

/**
 * B 站阅读 World 到主进程的窄接口。
 *
 * World 不直接碰 Electron、Python、凭据或文件；这里只暴露只读调用、
 * 阅读记录投影和登录态/日报状态。所有内容都由主进程重新校验后才写盘。
 */

export type BiliServiceToolName =
  | 'bili_recommend'
  | 'bili_search'
  | 'bili_video_info'
  | 'bili_subtitle'
  | 'bili_frames'
  | 'bili_cover'

export interface BiliServiceImage {
  mimeType: 'image/jpeg' | 'image/png'
  data: string
  width: number
  height: number
}

export interface BiliServiceToolResult {
  payload: Record<string, unknown>
  images: BiliServiceImage[]
}

export interface BiliReadingPatch {
  cid?: number | null
  title?: string
  author?: string
  durationSec?: number | null
  descriptionReadAt?: number
  descriptionChars?: number
  tags?: string[]
  subtitle?: BiliSubtitleRead | null
  frames?: BiliFrameRead | null
  asr?: BiliAsrRead | null
  transcriptReadChars?: number
  verdict?: BiliVerdict | null
  reason?: string | null
  keyPoints?: string[]
  evidenceLevel?: DiscoveryEvidenceLevel | null
  discoveryId?: string | null
}

export interface BiliReadingEnsureInput {
  bvid: string
  partIndex: number
  cid?: number | null
  title: string
  author: string
  durationSec?: number | null
  origin: 'recommend' | 'search' | 'open'
  query?: string | null
}

export interface BiliAsrReadResult {
  job: BiliAsrJobView
  text: string
  offset: number
  totalChars: number
  nextOffset: number | null
  complete: boolean
}

export interface BiliReportResult {
  ok: boolean
  summary: BiliReportSummary
  error: string | null
}

export interface BiliReadingPort {
  status(): BiliStatusView
  callTool(
    name: BiliServiceToolName,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<BiliServiceToolResult>
  submitAsr(input: {
    bvid: string
    page: number
    title: string
    durationSec: number | null
  }): BiliAsrJobView
  asrStatus(jobId: string): BiliAsrJobView
  asrRead(jobId: string, offset?: number, limit?: number): BiliAsrReadResult
  readingEnsure(input: BiliReadingEnsureInput): BiliReadingRecord
  readingUpdate(bvid: string, partIndex: number, patch: BiliReadingPatch): BiliReadingRecord | null
  readingGet(bvid: string, partIndex: number): BiliReadingRecord | null
  finalizeReport(date?: string): BiliReportResult
  reportSummary(date?: string): BiliReportSummary
  recordReadingFailure(code: BiliReadFailureCode): void
  isStopped(): boolean
  /** World 只能代表用户停止；撤权/退出/关机由主进程自己调用服务。 */
  stopBrowsing(reason: 'user'): void
}

/** 共享发现存储的窄接口；World 不直接持有 persona 存储。 */
export interface BiliDiscoveryPort {
  noteObservation(input: DiscoveryObservationInput): DiscoveryObservationToken | null
  findByVideo(
    videoId: string,
    partId: number | null
  ): { id: string; shareState: string } | null
  /** 省略 site 表示清理全部；B 站停止只清理自己的观察。 */
  clearObservations(site?: DiscoverySite): number
  count(): number
  isEnabled(): boolean
}

export type BiliToolImage = ToolImage

export function isBiliPortError(
  error: unknown
): error is Error & { code?: string; retryable?: boolean } {
  return error instanceof Error
}
