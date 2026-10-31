/**
 * 场景感知的抽象描述（PLAN.md §4）。
 *
 * 原始截图、帧环与 OCR 文本只存在于主进程 VisionService 的短期内存里；
 * 离开感知层的是这个 descriptor（页面标题只用于本地设置页预览，
 * 不会进入 Core、事件库或模型上下文）。
 */

export type SceneCategory =
  | 'watching_video'
  | 'browsing'
  | 'coding'
  | 'gaming'
  | 'meeting'
  | 'writing'
  | 'shopping'
  | 'social'
  | 'reading'
  | 'designing'
  | 'unknown'

/**
 * 通用粗粒度阶段。具体游戏可以在此之后追加 HUD/OCR 规则，但事件只能
 * 基于可验证的本地证据，不能从颜色、单帧黑屏或按键量猜测。
 */
export type ScenePhase =
  | 'unknown'
  | 'menu'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'results'

export type SceneEvidenceSource = 'local_ocr' | 'vision_model' | 'foreground' | 'none'

/** 采集质量；`blocked` 表示用户/隐私/系统状态不允许采集，不是失败。 */
export type SceneCaptureQuality =
  | 'good'
  | 'low'
  | 'static'
  | 'black'
  | 'frozen'
  | 'blocked'
  | 'unavailable'

export interface SceneDescriptor {
  category: SceneCategory
  /** 中文短描述，例如「在看视频」「在游戏菜单」。 */
  activity: string
  /** 抽象应用类别，例如「浏览器」「游戏」；不是进程名。 */
  appLabel: string
  /** 归一化后的短标题，仅供本机设置页预览，不进入模型。 */
  title: string | null
  /** 命中关键词的规范词，不是原始 OCR 片段。 */
  keywords: string[]
  /** 0–1；由关键词强度、阶段稳定性与模型结果共同决定。 */
  confidence: number
  at: number
  /** 可共享的游戏显示名（仅在用户允许共享应用名时出现）；不是进程名。 */
  game?: string | null
  phase?: ScenePhase
  previousPhase?: ScenePhase | null
  /** 可共享的短语义变化，例如「进入胜利结算」；不得包含 OCR 原文。 */
  detail?: string | null
  change?: string | null
  evidenceSource?: SceneEvidenceSource
  quality?: SceneCaptureQuality
  /** 一次观察的稳定 id；迟到结果靠它与 revision/evidenceAt 拒绝覆盖新状态。 */
  observationId?: string
  /** 采集来源：显示器 id 或固定窗口标签；不进入模型上下文。 */
  sourceId?: string | null
  /** 证据发生时间（帧采集时间），与派发时间分开。 */
  evidenceAt?: number
  /** 该观察语义有效期；过期后不得补播报。 */
  expiresAt?: number
  revision?: number
}

/** 设置页/工具读取的短期场景状态；所有字段都来自最近一次有效证据。 */
export interface SceneState {
  observationId: string | null
  category: SceneCategory | null
  activity: string | null
  appLabel: string | null
  game: string | null
  phase: ScenePhase
  previousPhase: ScenePhase | null
  recentChange: string | null
  detail: string | null
  evidenceAt: number | null
  confidence: number
  source: SceneEvidenceSource | null
  quality: SceneCaptureQuality | null
  sourceId: string | null
  validUntil: number | null
  stale: boolean
}

export interface SceneSemanticUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface SceneSemanticStatus {
  /** 配置上是否允许把整屏画面交给当前聊天模型。 */
  enabled: boolean
  /** 当前是否真的具备可用的模型图片通路（成功验证过或已配置但尚未验证）。 */
  available: boolean
  model: string | null
  /** 最近一次请求完成（无论成功）的时间。 */
  lastAt: number | null
  /** 最近一次真正提交给模型的时间；设置页用它区分“已采集”与“已发送”。 */
  lastSentAt: number | null
  /** 最近一次成功得到有效摘要的时间；本地像素比较不会刷新它。 */
  lastInterpretedAt: number | null
  lastLatencyMs: number | null
  lastError: string | null
  /** null 表示尚未验证；false 表示实际请求被拒绝/不支持。 */
  imageSupported: boolean | null
  /** 是否真的会把整屏画面发送给模型；隐私设置页必须准确显示。 */
  shareFrames: boolean
  inFlight: boolean
  usage: SceneSemanticUsage | null
  reason: string | null
}

/** 一次采样各阶段的耗时；只含指标，不含图像或页面内容。 */
export interface SceneTimings {
  captureMs: number | null
  signatureMs: number | null
  semanticMs: number | null
  totalMs: number | null
}

/** 最近一帧的来源元数据；不含像素、标题或窗口内容。 */
export interface SceneFrameInfo {
  at: number
  sourceId: string
  displayId: string
  width: number
  height: number
  /** 目标窗口在采集图内的有效区域（图像坐标系）。 */
  validRegion: { x: number; y: number; width: number; height: number }
  visible: boolean
  quality: SceneCaptureQuality
}

export interface SceneStatus {
  enabled: boolean
  /** 截图通路是否可用（前台粗分类始终可用；不代表模型可用）。 */
  available: boolean
  reason: string | null
  lastAt: number | null
  /** 最近成功采集的时间。 */
  lastFrameAt: number | null
  /** 最近一次真正提交给模型的时间；与 lastFrameAt 分开。 */
  lastSentAt: number | null
  /** 最近一次成功理解的时间；本地像素比较不刷新它。 */
  lastInterpretedAt: number | null
  lastCategory: SceneCategory | null
  lastActivity: string | null
  lastConfidence: number | null
  /** 最近一次本机处理（采集 + 签名/可选 OCR）耗时。 */
  lastDurationMs: number | null
  lastError: string | null
  /** 只用于观测，不参与任何额度判断。 */
  framesCaptured: number
  framesLastMinute: number
  /** 累计真正提交给视觉模型的请求数；只用于诊断，不是额度。 */
  requestsSent: number
  /** @deprecated 常规感知不再保留帧环；保留字段便于旧设置页兼容。 */
  bufferFrames: number
  /** @deprecated 同上。 */
  frameBufferSeconds: number
  targetDisplayId: string | null
  targetKind: 'foreground-window' | null
  quality: SceneCaptureQuality | null
  /** 当前不采集的原因（用户暂停/锁屏/敏感应用等）；null 表示正在观察。 */
  blockedReason: string | null
  /** 用户单独暂停屏幕感知（不影响行为感知本身）。 */
  paused: boolean
  /** 当前周期（毫秒）：60 秒基础档或 120 秒静态档。 */
  intervalMs: number | null
  /** 下一次允许采样的时间；没有排期时为 null。 */
  nextCheckAt: number | null
  /** 只表示本地 OCR 兜底是否可用；null 表示未探测。 */
  ocrAvailable: boolean | null
  ocrFallback: boolean
  phase: ScenePhase | null
  game: string | null
  evidenceSource: SceneEvidenceSource | null
  revision: number
  timings: SceneTimings | null
  /** 最近一帧的来源/尺寸/可见性；没有帧时为 null。 */
  lastFrame?: SceneFrameInfo | null
  semantic: SceneSemanticStatus
}

export const SCENE_LABELS: Record<SceneCategory, string> = {
  watching_video: '看视频',
  browsing: '浏览网页',
  coding: '写代码',
  gaming: '玩游戏',
  meeting: '开会',
  writing: '写文档',
  shopping: '购物',
  social: '刷社交',
  reading: '阅读',
  designing: '做设计',
  unknown: '在用电脑'
}

export const SCENE_PHASE_LABELS: Record<ScenePhase, string> = {
  unknown: '未确认阶段',
  menu: '菜单',
  loading: '加载',
  playing: '游玩中',
  paused: '已暂停',
  results: '结算',
  // 兼容旧数据/未来阶段时保持诚实：未列出的阶段不发明新含义。
}

export function sceneLabel(category: SceneCategory): string {
  return SCENE_LABELS[category] ?? SCENE_LABELS.unknown
}

export function scenePhaseLabel(phase: ScenePhase): string {
  return SCENE_PHASE_LABELS[phase] ?? SCENE_PHASE_LABELS.unknown
}

export function isKnownPhase(phase: ScenePhase | null | undefined): phase is ScenePhase {
  return (
    phase === 'menu' ||
    phase === 'loading' ||
    phase === 'playing' ||
    phase === 'paused' ||
    phase === 'results'
  )
}

/**
 * 场景来源接口。Electron 主进程实现它，Activity World 只依赖这个窄接口；
 * 测试可以注入 fake，不需要截图或 OCR。
 */
export interface SceneProvider {
  start(onScene: (scene: SceneDescriptor) => void, onError: (error: Error) => void): void
  stop(): void
  /** 配置热更新后调用；实现可重新安排下一次采样。 */
  refresh?(): void
  status?(): SceneStatus
  /** 本机可观察的显示器列表；只用于设置页诊断，不参与目标选择。 */
  displays?(): Array<{ id: string; label: string; width: number; height: number; primary: boolean }>
  clear?(): void
  /** 用户单独暂停/恢复屏幕感知；恢复后不补拍暂停前的旧帧。 */
  pause?(): void
  resume?(): void
  /**
   * 前台窗口身份/几何变化时通知感知层：`window` 立即作废旧摘要并更新目标，
   * `bounds` 只提前一次检查（可能只是拖动窗口，摘要在 90 秒有效期内仍可保留）。
   */
  targetChanged?(kind: 'window' | 'bounds'): void
  /** 设置页“立即观察一次”；遵守授权、敏感状态与并发限制，重复点击合并。 */
  observeNow?(): Promise<{ ok: boolean; reason: string | null }>
  /**
   * 请求在当前正常采样节奏内刷新一次摘要（不额外截图、不抢跑）。
   * 供屏幕陪伴的“等待新画面”使用；重复请求合并。
   */
  requestSummaryRefresh?(): boolean
  /**
   * 仅供本机设置页预览的最近 OCR 片段；默认配置下必须返回 null。
   * 绝不可以把返回值写进日志、事件或模型上下文。
   */
  preview?(): string | null
}
