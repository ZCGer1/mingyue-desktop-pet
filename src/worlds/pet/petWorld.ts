import { z } from 'zod'
import type {
  EventAttention,
  Logger,
  RunPhaseState,
  ToolContext,
  ToolDef,
  ToolOutcome,
  TurnOutcome,
  World,
  WorldDescribe,
  WorldHost
} from '../../core/types'
import type { PetSemanticConfig, ReactionTier } from '../../shared/config'
import {
  DEFAULT_PET_MOVEMENT_ANIMATION,
  PET_ANIMATION_IDS,
  PET_MOVEMENT_ANIMATIONS,
  PET_SEMANTIC_TTL_MS,
  isKnownAnimationId,
  isLookAroundAnimation,
  isMovementAnimationId,
  resolveLegacyAnimation,
  resolvePresetAnimation,
  type PetAnimationMode,
  type PetAnimationOutcome,
  type PetAnimationReceipt,
  type PetAnimationSource,
  type PetMovementOutcome,
  type PetMovementReceipt,
  type PetRequestClass
} from '../../shared/petPresentation'
import { semanticGuideText } from '../../shared/dshPet/ambientCatalog'
import type { PetIdlePolicy } from './petIdlePolicy'
import ENV_PROMPT from './ENV_PROMPT.md?raw'

/** 参考客户端 `pet.json` 的七种 Agent 相位 + 待机。 */
export type ClientPhase =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'waiting'
  | 'asking'
  | 'helper'
  | 'queued'
  | 'done'
  | 'failed'

export interface AgentPresentation {
  phase: ClientPhase
  approvalPending: boolean
  retryAt?: number
  round: number
}

/** 表情/动作预设；只影响 figure 表达，不再产生任何台词。 */
export const PET_PRESETS = ['focus', 'rest', 'late', 'welcome-back', 'curious', 'quiet'] as const
export type PetPreset = (typeof PET_PRESETS)[number]

export type PetTouchKind = 'grab' | 'pet' | 'drop' | 'throw' | 'poke' | 'crash'

/**
 * 动作参数：`animation` 是当前目录里的真实动画名；`expression/motion` 是
 * 旧词，只在迁移期做近似映射。未知值返回 unsupported，不静默改用待机。
 */
const ANIMATION_ARGS = {
  animation: z
    .string()
    .max(120)
    .optional()
    .describe('动画目录中的动作名（与右键「动作」菜单同名）；优先于旧词'),
  expression: z.string().max(40).optional().describe('旧版表情词，仅迁移期近似映射'),
  motion: z.string().max(40).optional().describe('旧版动作词，仅迁移期近似映射')
}

/** 只产生表现、不产生真实工作的工具；自主轮里的这些名字不算实质活动。 */
const PRESENTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'pet_say',
  'reaction_respond',
  'pet_emote',
  'pet_act',
  'pet_walk_to',
  'pet_quiet',
  'pet_pause_explore',
  'pet_open_chat',
  'end_turn'
])

function isAutonomousSource(source: ToolContext['source']): boolean {
  // 后台自主任务与自主心跳都属于「她自己发起」；用户聊天/快捷聊天才是明确点播。
  return source === 'autonomy' || source === 'task'
}

/** 主动气泡来源：任务、自主心跳与屏幕陪伴；用户聊天回复永远不受安静/队列限制。 */
function isProactiveSaySource(source: PendingSay['source']): boolean {
  return source === 'task' || source === 'autonomy' || source === 'screen_feedback'
}

interface AnimationArgInput {
  animation?: string
  expression?: string
  motion?: string
}

function resolveAnimationIntent(
  input: AnimationArgInput,
  source: PetAnimationSource,
  opts: { preset?: PetPreset; mode?: PetAnimationMode; autonomous?: boolean } = {}
): { intent?: PetAnimationIntent; notice?: string; unsupported?: string } {
  const mode = opts.mode ?? 'once'
  const autonomous = opts.autonomous === true ? { autonomous: true as const } : {}
  if (typeof input.animation === 'string' && input.animation.trim() !== '') {
    if (!PET_ANIMATION_IDS.includes(input.animation)) {
      return { unsupported: `未知动作：${input.animation.slice(0, 40)}` }
    }
    return {
      intent: { animationId: input.animation, mode, source, ...autonomous },
      ...(input.expression !== undefined || input.motion !== undefined
        ? { notice: '已优先使用 animation，忽略同时提供的 expression/motion' }
        : {})
    }
  }
  if (input.expression !== undefined || input.motion !== undefined) {
    const resolved = resolveLegacyAnimation({
      expression: input.expression,
      motion: input.motion
    })
    if (resolved === null) {
      const raw = [input.expression, input.motion].filter((v) => v !== undefined).join('/')
      return { unsupported: `旧词没有等价素材：${raw.slice(0, 60)}` }
    }
    return {
      intent: {
        animationId: resolved.animationId,
        mode,
        source,
        ...autonomous,
        label: resolved.from
      },
      notice: `旧词近似映射：${resolved.from} → ${resolved.animationId}`
    }
  }
  if (opts.preset !== undefined) {
    const animationId = resolvePresetAnimation(opts.preset)
    if (animationId === null) return { unsupported: `预设没有等价素材：${opts.preset}` }
    return {
      intent: { animationId, mode, source, ...autonomous, label: `preset:${opts.preset}` },
      notice: `预设近似映射：${opts.preset} → ${animationId}`
    }
  }
  return {}
}

function animationOutcomeText(outcome: PetAnimationOutcome): string {
  switch (outcome.status) {
    case 'started':
    case 'completed':
      return `动作「${outcome.animationId}」已开始播放`
    case 'accepted':
      return `动作「${outcome.animationId}」已受理`
    case 'queued':
      return `动作「${outcome.animationId}」已排队，将在当前动作播到自然边界后播放${outcome.reason === 'coalesced' ? '（与当前动作合并）' : ''}`
    case 'interrupted':
      return `动作「${outcome.animationId}」播放被打断`
    case 'unsupported':
      return `[PET_ANIMATION_UNSUPPORTED] 动作「${outcome.animationId}」不受支持`
    case 'rejected':
      return `[PET_ANIMATION_REJECTED] 动作「${outcome.animationId}」未开始（${outcome.reason ?? 'rejected'}）`
    case 'failed':
      return `[PET_ANIMATION_FAILED] 动作「${outcome.animationId}」播放失败（${outcome.reason ?? 'unknown'}）`
  }
}

function positionLabel(position: 'left' | 'center' | 'right' | number, target: number): string {
  if (position === 'left') return `左边（${Math.round(target * 100)}%）`
  if (position === 'center') return `中间（${Math.round(target * 100)}%）`
  if (position === 'right') return `右边（${Math.round(target * 100)}%）`
  return `${Math.round(target * 100)}%`
}

function retryHint(retryAfterMs: number | undefined): string {
  if (retryAfterMs === undefined) return ''
  return `（约 ${Math.max(1, Math.ceil(retryAfterMs / 1000))} 秒后可再试）`
}

function describeMovementOutcome(
  outcome: PetMovementOutcome,
  targetText: string
): { text: string; failed: boolean } {
  switch (outcome.status) {
    case 'started':
      return {
        text: `移动已开始：使用「${outcome.animationId}」向 ${targetText} 移动；到达后页面会更新位置。`,
        failed: false
      }
    case 'completed':
      return {
        text: `已到达 ${targetText}（使用「${outcome.animationId}」）。`,
        failed: false
      }
    case 'accepted':
      return {
        text: `移动请求已受理，尚未确认开始（「${outcome.animationId}」）。`,
        failed: false
      }
    case 'already_at_target':
      return { text: `已经在该位置附近，无需移动（目标 ${targetText}）。`, failed: false }
    case 'blocked':
      return {
        text: `[PET_MOVE_BLOCKED] 未能开始移动：${outcome.reason ?? 'blocked'}。`,
        failed: true
      }
    case 'interrupted':
      return {
        text: `[PET_MOVE_INTERRUPTED] 移动被打断：${outcome.reason ?? 'interrupted'}。`,
        failed: true
      }
    case 'failed':
      return {
        text: `[PET_MOVE_FAILED] 移动失败：${outcome.reason ?? 'unknown'}。`,
        failed: true
      }
  }
}

function describeSayResult(delivery: PetSayDelivery, notice: string | undefined): string {
  const parts = delivery.displayed
    ? ['气泡已显示。']
    : ['[PET_FAILED] 桌宠页面不可用，气泡未显示。']
  if (delivery.animation !== null) parts.push(animationOutcomeText(delivery.animation))
  if (notice !== undefined) parts.push(notice)
  return parts.join(' ')
}

const TOUCH_TEXT: Record<PetTouchKind, string> = {
  grab: '把你拎了起来',
  pet: '摸了摸你的头',
  drop: '把你放了下来',
  throw: '把你抛了出去',
  poke: '戳了戳你',
  crash: '把你摔得有点晕'
}
/** 提示词只记录交互类别，不含坐标、正文或窗口内容。 */
const TOUCH_KIND_LABEL: Record<PetTouchKind, string> = {
  grab: '抓取',
  pet: '点击',
  drop: '放下',
  throw: '抛掷',
  poke: '戳',
  crash: '摔落'
}
const TOUCH_EVENT_GAP_MS = 2 * 60_000
const TOUCH_WAKE_GAP_MS = 60_000

/** 一次显式动画意图；requestId 由主进程回执桥生成。 */
export interface PetAnimationIntent {
  animationId: string
  mode: PetAnimationMode
  source: PetAnimationSource
  /** 由 ToolContext.source 推导，模型参数不能设置。 */
  autonomous?: boolean
  /** 宿主推导的请求类别；当前工具动作均为 model-semantic。 */
  requestClass?: PetRequestClass
  /** 同一 session/turn 的语义去重键；不含正文，不进入模型上下文。 */
  dedupeKey?: string
  /** 墙钟过期时间；迟到的旧回复不再补做动作。 */
  expiresAt?: number
  label?: string
}

/** 气泡投递结果：送达页面与动画结果分开报告，避免把失败写成成功。 */
export interface PetSayDelivery {
  displayed: boolean
  /** 未请求动画时为 null。 */
  animation: PetAnimationOutcome | null
  /** 展示未发生时的固定短原因；成功展示时为空。 */
  reason?: string
  /** 已建立的主动 Episode；失败时装配层用于回滚。 */
  episodeId?: string
  /** 与 PetSayResult.outcome 对齐的终态，避免调用方从布尔值猜测。 */
  outcome?: PetSayResultOutcome
}

/**
 * 带发现 id 的气泡的终态。队列丢弃、安静跳过、页面不可用都必须回调，
 * 让装配层把 pending-share 退回 discovered，不能假装已经分享。
 */
export type PetSayResultOutcome = 'displayed' | 'failed' | 'cancelled'

export interface PetSayResult {
  /** 发现分享气泡才有；屏幕陪伴反馈没有本地发现。 */
  discoveryId?: string
  /** 屏幕陪伴反馈的稳定 id（仅内存/诊断，不含台词）。 */
  feedbackId?: string
  observationId?: string
  channel?: 'screen_feedback'
  /** 已经建立、但气泡没有显示出来的 Episode；装配层应取消它。 */
  episodeId?: string
  outcome: PetSayResultOutcome
  reason?: string
  now: number
}

const DISCOVERY_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/

export interface PetPresentationSink {
  onPhase(presentation: AgentPresentation): void
  /**
   * 请求显示气泡并可选点播动作。页面不可用/素材失败必须如实返回，
   * 不能只回 IPC 发送成功。
   */
  onSay(say: {
    text: string
    preset: PetPreset | null
    ttlMs: number
    /** 主动开场对应的 ConversationEpisode；普通聊天回复不带。 */
    episodeId?: string
    animation?: PetAnimationIntent
    /** 旧词近似映射/不支持说明；只用于工具结果与诊断。 */
    animationNotice?: string
  }): Promise<PetSayDelivery>
  onAnimate(intent: PetAnimationIntent): Promise<PetAnimationOutcome>
  /**
   * 真实移动请求。返回页面确认过的阶段；旧测试桩可以返回 void，
   * 生产 sink 必须返回 outcome，不能在未确认时声称已开始。
   */
  onWalkTo(walk: {
    target: number
    animationId: string
    autonomous?: boolean
    requestClass?: PetRequestClass
    dedupeKey?: string
    expiresAt?: number
  }): Promise<PetMovementOutcome> | PetMovementOutcome | void
  onQuiet(quiet: { minutes: number; endsAt: number }): void
  onOpenChat(reason: string): void
}

const DONE_MS = 6500
const FAILED_MS = 7500
/**
 * 气泡展示的最小间隔。它不是「次数上限」：间隔内的新内容进入有界队列，
 * 按顺序展示；同任务/同内容的连续更新只保留最新一版。用户聊天回复永远
 * 立即显示，不被主动气泡排队挡住。
 */
const SAY_MIN_GAP_MS = 1_500
const SAY_QUEUE_LIMIT = 4
const OPEN_CHAT_COOLDOWN_MS = 5 * 60_000
/** 只在内存里保留最近若干轮的语义去重键；不保存正文，不参与持久化。 */
const SEMANTIC_TURN_LIMIT = 64

interface PendingSay {
  text: string
  preset: PetPreset | null
  animation?: PetAnimationIntent
  animationNotice?: string
  ttlMs: number
  source: ToolContext['source'] | 'screen_feedback'
  /** 产生这条气泡的回合；用于停止浏览后拦截迟到的发现分享。 */
  turnId?: string
  /** 这条气泡要分享的本地发现；显示成功/失败都会回调 onSayResult。 */
  discoveryId?: string
  /** 屏幕陪伴反馈；只用于回执/Episode，不进入模型上下文。 */
  feedbackId?: string
  observationId?: string
  channel?: 'screen_feedback'
  taskId?: string
  kind?: 'comment' | 'question' | 'proposal' | 'task_update'
  pendingQuestion?: string
  enqueuedAt: number
  expiresAt: number
}

/**
 * `pet` World（PLAN.md §4.3）：Agent 相位仲裁 + 模型可见的身体/表现工具。
 * 它不操作窗口，只把「该显示什么」交给宿主（Bot → IPC → 宠物页）。
 *
 * 这里没有任何本地台词或语义兜底：模型不调用工具时，桌宠只保留 figure
 * 自己的待机动画。
 */
export class PetWorld implements World {
  readonly id = 'pet'
  readonly describe: WorldDescribe = {
    tools: [
      { name: 'pet_say', description: '角色气泡，可绑定一个与发言相符的动作，≤60 字', tags: ['presentation'], approval: 'auto' },
      { name: 'reaction_respond', description: '回应真实外部事件：发言/动作/读取更多/继续/安静', tags: ['presentation'], approval: 'auto' },
      { name: 'pet_emote', description: '兼容旧名，已隐藏；新请求请用 pet_act 的 preset', tags: ['presentation'], approval: 'auto' },
      { name: 'pet_act', description: '按预设或当前行为选择一个动作，不说话', tags: ['presentation'], approval: 'auto' },
      { name: 'pet_walk_to', description: '在当前显示器内保持支撑高度横向走动', tags: ['presentation'], approval: 'auto' },
      { name: 'pet_quiet', description: '暂时只停止主动聊天，探索可继续', tags: ['presentation'], approval: 'auto' },
      { name: 'pet_pause_explore', description: '暂停自主探索与当前自主任务', tags: ['presentation'], approval: 'auto' },
      { name: 'pet_open_chat', description: '打开完整聊天窗（5 分钟节流）', tags: ['presentation'], approval: 'auto' },
      { name: 'end_turn', description: '干净地结束本拍', tags: ['presentation'], approval: 'auto' }
    ],
    events: []
  }

  private readonly logger: Logger
  private readonly isEnabled: () => boolean
  private readonly canOpenChat: () => boolean
  private readonly isSpeechQuiet: () => boolean
  private readonly onQuiet: (until: number) => void
  private readonly onPauseExplore: (until: number) => void
  private readonly onSpoken:
    | ((
        now: number,
        detail?: {
          channel?: 'screen_feedback'
          feedbackId?: string
          observationId?: string
        }
      ) => void)
    | null
  private readonly getReactions: () => ReactionTier
  private readonly canRespondReaction: () => boolean
  private readonly onReactionResponse:
    | ((
        decision: 'speak' | 'act' | 'silent' | 'read_more' | 'continue_shared',
        reason: string,
        now: number
      ) => void)
    | null
  private readonly onProactiveSay:
    | ((input: {
        text: string
        taskId?: string
        kind?: 'comment' | 'question' | 'proposal' | 'task_update'
        pendingQuestion?: string
        discoveryId?: string
        channel?: 'screen_feedback'
        feedbackId?: string
        observationId?: string
        now: number
      }) => { episodeId?: string; rejected?: string } | undefined)
    | null
  private readonly onSayResult: ((result: PetSayResult) => void) | null
  private readonly policy: PetIdlePolicy | null
  private readonly isMovementEnabled: () => boolean
  private readonly isMovementPauseWithPanel: () => boolean
  private readonly getSemanticConfig: () => PetSemanticConfig
  /** 同一 session:turn 只允许一个语义动作；键不含正文，只保留短窗口。 */
  private readonly semanticTurns = new Map<string, { animationId: string; at: number }>()
  /** 语义动作选择/拒绝的脱敏聚合数；不包含轮次键或任何正文。 */
  private readonly semanticEvents = {
    selected: 0,
    disabled: 0,
    duplicate: 0,
    started: 0,
    rejected: 0,
    lastRejection: null as string | null
  }
  private host: WorldHost | null = null
  private sink: PetPresentationSink | null = null

  private agentPhase: RunPhaseState['phase'] = 'idle'
  private phase: ClientPhase = 'idle'
  private approvalPending = false
  private round = 0
  private retryAt: number | undefined
  private lastPhaseKey = ''
  private transient: 'done' | 'failed' | null = null
  private transientTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private lastSayTime = 0
  private lastOpenChatTime = 0
  private readonly pendingSays: PendingSay[] = []
  private sayTimer: NodeJS.Timeout | null = null
  private droppedSays = 0
  private lastPresentationTime = 0
  /**
   * 停止浏览时仍在途的回合；这些回合迟到的主动气泡（尤其是发现分享）
   * 不得再显示。
   */
  private readonly staleProactiveTurnIds = new Set<string>()
  private lastTouchAt: number | null = null
  private lastTouchEventAt = 0
  private lastTouchWakeAt = 0
  private readonly touchCounts = new Map<PetTouchKind, number>()
  private lastMovement: {
    xRatio: number | null
    facing: 'left' | 'right' | null
    reachableMinRatio: number | null
    reachableMaxRatio: number | null
    status: string | null
    reason: string | null
    at: number | null
  } = {
    xRatio: null,
    facing: null,
    reachableMinRatio: null,
    reachableMaxRatio: null,
    status: null,
    reason: null,
    at: null
  }
  /**
   * 自主移动链路的脱敏聚合数：决策摘要被读取、模型选择调用、各阶段回执。
   * 只有聚合数、固定枚举与目标/实际比例，不含正文或截图，也不参与调度。
   */
  private readonly movementEvents = {
    promptViews: 0,
    autonomousSelections: 0,
    receipts: {} as Record<string, number>,
    lastStatus: null as string | null,
    lastReason: null as string | null,
    lastTargetRatio: null as number | null,
    lastXRatio: null as number | null
  }
  /** 身体最近一次真实位移/被拖动的墙钟时间；用于静止时长提示。 */
  private lastBodyMotionAt = Date.now()
  /** 用户正文里明确要求「张望/环顾」的短期许可；普通聊天不算明确意图。 */
  private explicitLookUntil = 0
  /** 页面快照里已同步过的张望 started 时间，避免 5 秒心跳反复续期。 */
  private lastPageLookAroundStartedAt: number | null = null
  /** 页面上报的占用快照；只用于提示词与空闲资格，不含坐标或正文。 */
  private readonly presence = {
    menuOpen: false,
    panelOpen: false,
    perched: false,
    suspended: false,
    dragging: false
  }
  private lastTouchKind: PetTouchKind | null = null
  private turnActive = false
  private turnSilent = false
  private turnSubstantive = false
  private turnHadPresentation = false
  private turnSource: ToolContext['source'] | null = null

  constructor(opts: {
    logger: Logger
    isEnabled: () => boolean
    canOpenChat?: () => boolean
    /** 用户要求暂时安静：主动气泡跳过，探索与任务继续。 */
    isSpeechQuiet?: () => boolean
    onQuiet?: (until: number) => void
    onPauseExplore?: (until: number) => void
    onSpoken?: (
      now: number,
      detail?: { channel?: 'screen_feedback'; feedbackId?: string; observationId?: string }
    ) => void
    getReactions?: () => ReactionTier
    /** 当前自主轮是否由真实 reaction 事件触发；用于限制 reaction_respond。 */
    canRespondReaction?: () => boolean
    /** reaction_respond 的枚举决策，用于诊断漏斗。 */
    onReactionResponse?: (
      decision: 'speak' | 'act' | 'silent' | 'read_more' | 'continue_shared',
      reason: string,
      now: number
    ) => void
    /** 任务/自主 tick 的 pet_say 主动开场；返回 episodeId 供气泡携带。 */
    onProactiveSay?: (input: {
      text: string
      taskId?: string
      kind?: 'comment' | 'question' | 'proposal' | 'task_update'
      pendingQuestion?: string
      discoveryId?: string
      channel?: 'screen_feedback'
      feedbackId?: string
      observationId?: string
      now: number
    }) => { episodeId?: string; rejected?: string } | undefined
    /** 带 discoveryId 的气泡终态回调；只用于分享状态修正，不参与展示。 */
    onSayResult?: (result: PetSayResult) => void
    /** 自主娱乐/移动的资格与冷却；缺省时不做冷却限制（仅测试桩使用）。 */
    policy?: PetIdlePolicy | null
    isMovementEnabled?: () => boolean
    /** 打开输入面板时是否禁止移动；与页面控制器使用同一配置。 */
    isMovementPauseWithPanel?: () => boolean
    /** 新语义动作开关与最短间隔；缺省按开启处理（仅测试桩）。 */
    getSemanticConfig?: () => PetSemanticConfig
  }) {
    this.logger = opts.logger
    this.isEnabled = opts.isEnabled
    this.canOpenChat = opts.canOpenChat ?? (() => false)
    this.isSpeechQuiet = opts.isSpeechQuiet ?? (() => false)
    this.onQuiet = opts.onQuiet ?? (() => undefined)
    this.onPauseExplore = opts.onPauseExplore ?? (() => undefined)
    this.onSpoken = opts.onSpoken ?? null
    this.getReactions = opts.getReactions ?? (() => 'medium')
    this.canRespondReaction = opts.canRespondReaction ?? (() => false)
    this.onReactionResponse = opts.onReactionResponse ?? null
    this.onProactiveSay = opts.onProactiveSay ?? null
    this.onSayResult = opts.onSayResult ?? null
    this.policy = opts.policy ?? null
    this.isMovementEnabled = opts.isMovementEnabled ?? (() => true)
    this.isMovementPauseWithPanel = opts.isMovementPauseWithPanel ?? (() => true)
    this.getSemanticConfig = opts.getSemanticConfig ?? (() => ({ enabled: true, minGapMs: 20_000 }))
  }

  /**
   * 只有用户正文里明确要求「张望/环顾/左右看」才短暂绕过张望品类冷却。
   * 普通聊天、模型自发动作都不算明确意图。
   */
  noteUserText(text: string): void {
    const value = text.slice(0, 500)
    const explicit =
      /张望|东张西望|环顾|左右看|左看右看|看看(四周|周围|左右)|转头(看看|看一眼)|扭头看看/i.test(
        value
      ) || /\b(look around|look left|look right|turn (your|her) head)\b/i.test(value)
    if (explicit) this.explicitLookUntil = Date.now() + 2 * 60_000
  }

  setSink(sink: PetPresentationSink | null): void {
    this.sink = sink
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host
  }

  async stop(): Promise<void> {
    this.cancelPendingProactiveSays('shutdown')
    this.clearSayTimer()
    this.clearTimers()
    this.host = null
    this.sink = null
    this.phase = 'idle'
    this.transient = null
  }

  envPromptVars(): Record<string, string> | null {
    return {
      presets: PET_PRESETS.join(' / '),
      // 按场景分组，而不是把上百个文件名塞给模型；精确名仍可来自目录/菜单。
      animations: semanticGuideText(),
      moves: PET_MOVEMENT_ANIMATIONS.join(' / '),
      idleState: this.describeIdleState(),
      movementState: this.describeMovementState()
    }
  }

  /**
   * 只读语义/节奏摘要；不含用户正文。随机小动作由主进程独立调度，
   * 模型不需要为了「让桌宠动起来」而主动选择，也不会被旧的娱乐冷却拦住。
   */
  private describeIdleState(): string {
    const summary = this.policy?.summary() ?? null
    const lookAround =
      summary === null
        ? '张望品类剩余时间未知'
        : summary.lookAroundCooldownRemainingSec <= 0
          ? '当前可以选一次张望类动作'
          : `张望品类还有约 ${summary.lookAroundCooldownRemainingSec} 秒（两个张望素材共享，用户正文明确要求时例外）`
    return [
      '本地随机小动作由主进程每 2–5 分钟独立决定，不依赖你调用工具，也不会生成气泡；不要为了填空而反复表演',
      '聊天/行为语义动作不需要先空闲 120 秒，也不受随机娱乐的长冷却限制；同一条回复最多一个，连续普通语义动作约需间隔 20 秒，过期会丢弃',
      '没有贴切素材时可以选择不做动作；不要默认用张望表达情绪',
      lookAround
    ].join('；')
  }

  private describeMovementState(): string {
    this.movementEvents.promptViews += 1
    const last = this.lastMovement
    const summary = this.policy?.summary() ?? null
    const position =
      last.xRatio === null ? '位置未知（尚未收到移动回执）' : `横向位置约 ${Math.round(last.xRatio * 100)}%`
    const facing = last.facing === null ? '朝向未知' : `朝向${last.facing === 'left' ? '左' : '右'}`
    const range =
      last.reachableMinRatio === null || last.reachableMaxRatio === null
        ? '可到达范围未知（页面尚未回报）'
        : `可到达范围约 ${Math.round(last.reachableMinRatio * 100)}%–${Math.round(
            last.reachableMaxRatio * 100
          )}%`
    const stationarySec = Math.max(
      0,
      Math.floor((Date.now() - this.lastBodyMotionAt) / 1000)
    )
    const lastResult =
      last.status === null
        ? '最近没有移动记录'
        : `最近移动：${last.status}${last.reason === null ? '' : `（${last.reason}）`}`
    const lastAction =
      summary === null
        ? ''
        : summary.lastActionId === null
          ? '最近没有自主娱乐动作'
          : `最近自主娱乐动作 ${summary.lastActionId}（${summary.lastActionAgeSec ?? 0} 秒前）`
    const occupancy = this.movementOccupancyReason()
    let eligibility: string
    if (occupancy !== null) {
      // 主进程与页面控制器必须一致：占用状态优先于策略冷却。
      eligibility = `canAutonomousMove=false；自主移动当前不可选：${occupancy}${
        summary === null ? '' : `，冷却剩余约 ${summary.movementCooldownRemainingSec} 秒`
      }`
    } else if (summary !== null) {
      const failure =
        summary.movementFailureBackoffRemainingSec > 0
          ? `，移动失败退避剩余 ${summary.movementFailureBackoffRemainingSec} 秒`
          : ''
      eligibility = summary.canAutonomousMove
        ? `canAutonomousMove=true；自主移动可选（仍需你明确决定），冷却剩余 ${summary.movementCooldownRemainingSec} 秒${failure}`
        : `canAutonomousMove=false；自主移动当前不可选：${summary.movementReason ?? '不可用'}，已静止 ${summary.bodyIdleForSec} 秒（门槛 ${summary.movementIdleRequiredSec} 秒），冷却剩余约 ${summary.movementCooldownRemainingSec} 秒${failure}`
    } else {
      eligibility = '移动策略不可用；不要假设可以自主移动'
    }
    const hint =
      stationarySec >= 5 * 60 && occupancy === null && summary?.canAutonomousMove === true
        ? '提示：已静止较久；如果你判断换个位置更自然（陪伴、让出视线或换个角落），可以自主走一小段，不必等待外部任务。'
        : ''
    return [
      `移动总开关：${this.isMovementEnabled() ? '开启' : '关闭'}`,
      this.describePresenceState(),
      position,
      facing,
      range,
      `已静止 ${stationarySec} 秒`,
      lastResult,
      lastAction,
      eligibility,
      hint
    ]
      .filter((part) => part !== '')
      .join('；')
  }

  /** 与页面 movementBlockedReason 保持同一口径的占用检查。 */
  private movementOccupancyReason(): string | null {
    if (!this.isMovementEnabled()) return 'movement-disabled'
    if (this.presence.suspended) return 'suspended'
    if (this.presence.dragging) return 'dragging'
    if (this.presence.perched) return 'perched'
    if (this.presence.panelOpen && this.isMovementPauseWithPanel()) return 'panel-open'
    if (this.presence.menuOpen) return 'menu-open'
    return null
  }

  /** 停靠/拖拽/菜单/面板/挂起占用；只含固定枚举与相对时间。 */
  private describePresenceState(): string {
    const active: string[] = []
    if (this.presence.dragging) active.push('用户正在拖拽')
    if (this.presence.menuOpen) active.push('右键菜单打开')
    if (this.presence.panelOpen) active.push('输入面板打开')
    if (this.presence.suspended) active.push('页面挂起')
    const lastTouch =
      this.lastTouchKind === null || this.lastTouchAt === null
        ? ''
        : `；最近用户操作：${TOUCH_KIND_LABEL[this.lastTouchKind]}（${Math.max(
            0,
            Math.floor((Date.now() - this.lastTouchAt) / 1000)
          )} 秒前）`
    return `停靠窗口上沿：${this.presence.perched ? '是（移动会返回 blocked: perched）' : '否'}；交互占用：${
      active.length === 0 ? '无' : active.join('、')
    }${lastTouch}`
  }

  /** 页面就绪/落定后的位置与可达范围；只含几何，不含任何用户内容。 */
  noteMovementCapability(capability: {
    xRatio: number
    facing: 'left' | 'right'
    reachableMinRatio: number
    reachableMaxRatio: number
  }): void {
    this.lastMovement = {
      ...this.lastMovement,
      xRatio: capability.xRatio,
      facing: capability.facing,
      reachableMinRatio: capability.reachableMinRatio,
      reachableMaxRatio: capability.reachableMaxRatio
    }
  }

  /** 页面回执：只保留位置/朝向/固定原因，不含正文或截图。 */
  noteMovementReceipt(receipt: PetMovementReceipt): void {
    this.movementEvents.receipts[receipt.status] =
      (this.movementEvents.receipts[receipt.status] ?? 0) + 1
    this.movementEvents.lastStatus = receipt.status
    this.movementEvents.lastReason = receipt.reason ?? null
    this.movementEvents.lastTargetRatio = receipt.target
    const xRatio = receipt.xRatio ?? this.lastMovement.xRatio
    this.movementEvents.lastXRatio = xRatio
    const facing = receipt.facing ?? this.lastMovement.facing
    const reachableMinRatio =
      receipt.reachableMinRatio ?? this.lastMovement.reachableMinRatio
    const reachableMaxRatio =
      receipt.reachableMaxRatio ?? this.lastMovement.reachableMaxRatio
    this.lastMovement = {
      xRatio,
      facing,
      reachableMinRatio,
      reachableMaxRatio,
      status: receipt.status,
      reason: receipt.reason ?? null,
      at: receipt.at
    }
    if (receipt.status === 'started' || receipt.status === 'completed') {
      // 身体开始/完成真实位移：静止时钟与自主移动冷却都从真实事件计时。
      this.lastBodyMotionAt = Date.now()
      this.policy?.markBodyActivity()
    }
    if (receipt.status === 'failed') {
      this.policy?.noteMovementFailed(receipt.animationId)
    }
  }

  /** 自主移动诊断：只看聚合数、最近阶段、固定原因与比例，不含正文。 */
  movementDiagnostics(): Record<string, unknown> {
    return {
      promptViews: this.movementEvents.promptViews,
      autonomousSelections: this.movementEvents.autonomousSelections,
      receipts: { ...this.movementEvents.receipts },
      lastStatus: this.movementEvents.lastStatus,
      lastReason: this.movementEvents.lastReason,
      lastTargetRatio: this.movementEvents.lastTargetRatio,
      lastXRatio: this.movementEvents.lastXRatio
    }
  }

  /** 真实用户交互（菜单/面板/停靠/挂起状态变化）立即退出自主空闲资格。 */
  noteActivity(kind?: string): void {
    switch (kind) {
      case 'menu-open':
        this.presence.menuOpen = true
        break
      case 'menu-close':
        this.presence.menuOpen = false
        break
      case 'panel-open':
        this.presence.panelOpen = true
        break
      case 'panel-close':
        this.presence.panelOpen = false
        break
      case 'perch-bind':
        this.presence.perched = true
        break
      case 'perch-unbind':
        this.presence.perched = false
        break
      case 'suspend':
        this.presence.suspended = true
        this.presence.dragging = false
        break
      case 'resume':
        this.presence.suspended = false
        break
      default:
        break
    }
    this.policy?.markActivity()
  }

  /**
   * 页面重载/重建后清空可能已不存在的占用快照；避免主进程一直以为
   * 角色仍停靠或被菜单占用。最近触摸历史保留，只清除“正在拖拽”状态。
   */
  resetPresence(): void {
    this.presence.menuOpen = false
    this.presence.panelOpen = false
    this.presence.perched = false
    this.presence.suspended = false
    this.presence.dragging = false
  }

  envPrompt(): string {
    return ENV_PROMPT
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'pet_say',
        description:
          '在角色头顶显示一句短气泡（≤60 字）。自动执行；短时间连续内容会按顺序展示，不会因频率失败。' +
          '可根据这句话的含义可选地绑定一个 animation；场景分组见环境提示。没有贴切动作时省略即可。' +
          '同一条回复最多一个语义动作；旧 expression/motion 会被近似映射并明确标注。' +
          '文字气泡一定会显示，动作失败/语义动作关闭/重复都不会吞掉文字。没有想说的就不调用。',
        parameters: z.object({
          text: z.string().min(1).max(60),
          preset: z.enum(PET_PRESETS).optional(),
          ...ANIMATION_ARGS,
          ttl_ms: z.number().int().min(2000).max(20_000).optional(),
          pendingQuestion: z
            .string()
            .max(60)
            .optional()
            .describe('想留给用户回应的问题；会被脱敏并限制在 60 字内'),
          discoveryId: z
            .string()
            .min(8)
            .max(80)
            .regex(DISCOVERY_ID_PATTERN)
            .optional()
            .describe(
              '要分享的本地发现 id（来自 discovery_save/list）；气泡正文不要贴链接，用户回应后用卡片继续'
            )
        }),
        tags: ['presentation'],
        approval: 'auto',
        handler: async (args, ctx): Promise<ToolOutcome> => {
          return this.performSay(args, ctx)
        }
      },
      {
        name: 'reaction_respond',
        description:
          '只用于真实 reaction 事件（应用/窗口/页面变化）触发的自主轮。' +
          '先判断值不值得回应：speak 发一句短评论，act 只做与事件含义相符的动作，' +
          'read_more 去调用读取工具核实，continue_shared 继续当前共同任务，' +
          'silent 明确保持安静。必须给出枚举 reason。不要对每次点击/按键回应；' +
          '同一轮已经选择过动作时，act 会返回重复拒绝，不能在同轮补第二个。',
        parameters: z.object({
          decision: z.enum(['speak', 'act', 'silent', 'read_more', 'continue_shared']),
          reason: z.enum([
            'new_event',
            'follow_up',
            'user_return',
            'content_change',
            'task_step',
            'question',
            'low_value',
            'stale',
            'own_action',
            'no_need'
          ]),
          text: z.string().min(1).max(60).optional(),
          ...ANIMATION_ARGS,
          pendingQuestion: z.string().max(60).optional()
        }),
        tags: ['presentation'],
        approval: 'auto',
        handler: async (args, ctx): Promise<ToolOutcome> => {
          if (!this.isEnabled()) return { text: '[PET_DISABLED] 桌宠表现已关闭', failed: true }
          this.noteToolContext(ctx)
          if (!this.canRespondReaction()) {
            return {
              text: '[REACTION_UNAVAILABLE] 当前这轮不是真实事件反应；请用 pet_say、pet_act(preset=...) 或继续原任务。',
              failed: true
            }
          }
          const input = args as {
            decision: 'speak' | 'act' | 'silent' | 'read_more' | 'continue_shared'
            reason: string
            text?: string
            pendingQuestion?: string
          } & AnimationArgInput
          const now = ctx.now()
          this.onReactionResponse?.(input.decision, input.reason, now)
          if (input.decision === 'silent') {
            return { text: '已记录保持安静。' }
          }
          if (input.decision === 'read_more' || input.decision === 'continue_shared') {
            return {
              text:
                input.decision === 'read_more'
                  ? '可以继续调用只读工具核实这个事件；没有证据前不要断言正文内容。'
                  : '可以继续当前共同任务；仍受已有权限与审批约束。'
            }
          }
          if (input.decision === 'act') {
            if (
              input.animation === undefined &&
              input.expression === undefined &&
              input.motion === undefined
            ) {
              return {
                text: '[REACTION_BAD_ARGS] act 需要 animation、expression 或 motion',
                failed: true
              }
            }
            const resolved = resolveAnimationIntent(input, 'reaction', {
              autonomous: isAutonomousSource(ctx.source)
            })
            if (resolved.intent === undefined) {
              return {
                text: `[PET_ANIMATION_UNSUPPORTED] ${resolved.unsupported ?? '没有可播放的动作'}`,
                failed: true
              }
            }
            if (isMovementAnimationId(resolved.intent.animationId)) {
              return {
                text: '[PET_MOVEMENT_REQUIRED] 移动分类素材必须通过 pet_walk_to 使用，普通动作不会产生位移。',
                failed: true
              }
            }
            const selected = this.selectSemanticIntent(ctx, resolved.intent)
            if (selected.intent === undefined) {
              return {
                text: this.semanticRejectionText(selected.reason),
                failed: true
              }
            }
            this.touchPresentation(now)
            const outcome = await this.sink?.onAnimate(selected.intent)
            if (outcome === undefined) {
              return { text: '[PET_ANIMATION_FAILED] 桌宠页面不可用', failed: true }
            }
            this.noteAnimationOutcome(selected.intent, outcome)
            return {
              text:
                animationOutcomeText(outcome) +
                (resolved.notice === undefined ? '' : `（${resolved.notice}）`),
              ...(outcome.status === 'unsupported' ||
              outcome.status === 'failed' ||
              outcome.status === 'rejected'
                ? { failed: true }
                : {})
            }
          }
          if (input.text === undefined) {
            return { text: '[REACTION_BAD_ARGS] speak 需要 text', failed: true }
          }
          return this.performSay(
            {
              text: input.text,
              ...(input.animation === undefined ? {} : { animation: input.animation }),
              ...(input.expression === undefined ? {} : { expression: input.expression }),
              ...(input.motion === undefined ? {} : { motion: input.motion }),
              ...(input.pendingQuestion === undefined
                ? { kind: 'comment' as const }
                : { kind: 'question' as const, pendingQuestion: input.pendingQuestion })
            },
            ctx
          )
        }
      },
      {
        name: 'pet_emote',
        description:
          '根据当前发言/行为播放一个语义相符的短暂动作；透明 WebM 不能叠加独立表情，' +
          '预设会映射为近似动作并明确标注。也可用 animation 选择场景分组里的精确素材。' +
          '不是每句话都要配动作；同一条回复最多一个。',
        parameters: z.object({
          preset: z.enum(PET_PRESETS),
          ...ANIMATION_ARGS
        }),
        tags: ['presentation'],
        approval: 'auto',
        handler: async (args, ctx): Promise<ToolOutcome> => {
          if (!this.isEnabled()) return { text: '[PET_DISABLED] 桌宠表现已关闭', failed: true }
          this.noteToolContext(ctx)
          const input = args as { preset: PetPreset } & AnimationArgInput
          const resolved = resolveAnimationIntent(input, 'emote', {
            preset: input.preset,
            autonomous: isAutonomousSource(ctx.source)
          })
          if (resolved.intent === undefined) {
            return {
              text: `[PET_ANIMATION_UNSUPPORTED] ${resolved.unsupported ?? '没有可播放的动作'}`,
              failed: true
            }
          }
          if (isMovementAnimationId(resolved.intent.animationId)) {
            return {
              text: '[PET_MOVEMENT_REQUIRED] 移动分类素材必须通过 pet_walk_to 使用，普通动作不会产生位移。',
              failed: true
            }
          }
          const selected = this.selectSemanticIntent(ctx, resolved.intent)
          if (selected.intent === undefined) {
            return { text: this.semanticRejectionText(selected.reason), failed: true }
          }
          this.touchPresentation()
          const outcome = await this.sink?.onAnimate(selected.intent)
          if (outcome === undefined) {
            return { text: '[PET_ANIMATION_FAILED] 桌宠页面不可用', failed: true }
          }
          this.noteAnimationOutcome(selected.intent, outcome)
          return {
            text:
              animationOutcomeText(outcome) +
              (resolved.notice === undefined ? '' : `（${resolved.notice}）`),
            ...(outcome.status === 'unsupported' ||
            outcome.status === 'failed' ||
            outcome.status === 'rejected'
              ? { failed: true }
              : {})
          }
        }
      },
      {
        name: 'pet_act',
        description:
          '不显示气泡，只播放一个与当前行为/语境相符的动作。preset 使用固定语义预设；' +
          'animation 使用目录里的真实动作名；二者与旧 expression/motion 互斥。' +
          '不要求动作和每段回复都出现，可选无动作；无等价素材时返回 unsupported；' +
          '同一轮最多一个语义动作。',
        parameters: z.object({
          preset: z.enum(PET_PRESETS).optional(),
          ...ANIMATION_ARGS,
          duration_ms: z.number().int().min(1000).max(20_000).optional()
        }),
        tags: ['presentation'],
        approval: 'auto',
        handler: async (args, ctx): Promise<ToolOutcome> => {
          if (!this.isEnabled()) return { text: '[PET_DISABLED] 桌宠表现已关闭', failed: true }
          this.noteToolContext(ctx)
          const input = args as AnimationArgInput & {
            preset?: PetPreset
            duration_ms?: number
          }
          const hasAnimationIntent =
            input.animation !== undefined ||
            input.expression !== undefined ||
            input.motion !== undefined
          if (input.preset !== undefined && hasAnimationIntent) {
            return {
              text:
                '[PET_BAD_ARGS] pet_act 的 preset 与 animation/expression/motion 互斥；' +
                '只选一种意图，不要同时传。',
              failed: true
            }
          }
          if (input.preset === undefined && !hasAnimationIntent) {
            return {
              text: '[PET_BAD_ARGS] pet_act 需要 preset、animation、expression 或 motion',
              failed: true
            }
          }
          const resolved = resolveAnimationIntent(input, 'act', {
            ...(input.preset === undefined ? {} : { preset: input.preset }),
            autonomous: isAutonomousSource(ctx.source)
          })
          if (resolved.intent === undefined) {
            return {
              text: `[PET_ANIMATION_UNSUPPORTED] ${resolved.unsupported ?? '没有可播放的动作'}`,
              failed: true
            }
          }
          if (isMovementAnimationId(resolved.intent.animationId)) {
            return {
              text: '[PET_MOVEMENT_REQUIRED] pet_act 只播放原地动作，不会产生真实位移；请改用 pet_walk_to。',
              failed: true
            }
          }
          const selected = this.selectSemanticIntent(ctx, resolved.intent)
          if (selected.intent === undefined) {
            return { text: this.semanticRejectionText(selected.reason), failed: true }
          }
          this.touchPresentation()
          const outcome = await this.sink?.onAnimate(selected.intent)
          if (outcome === undefined) {
            return { text: '[PET_ANIMATION_FAILED] 桌宠页面不可用', failed: true }
          }
          this.noteAnimationOutcome(selected.intent, outcome)
          return {
            text:
              animationOutcomeText(outcome) +
              (resolved.notice === undefined ? '' : `（${resolved.notice}）`),
            ...(outcome.status === 'unsupported' ||
            outcome.status === 'failed' ||
            outcome.status === 'rejected'
              ? { failed: true }
              : {})
          }
        }
      },
      {
        name: 'pet_walk_to',
        description:
          '让角色在当前显示器内真实地横向走动：position 为 left/center/right，或 0（最左）到 1（最右）的比例。' +
          `可选 animation 必须是「移动」分类中的素材（${PET_MOVEMENT_ANIMATIONS.join('、')}）；` +
          '省略时使用「螃蟹走路」。普通动作不能代替位移。' +
          '工具只在页面确认 started 后才回复已开始，不会声称已经到达。' +
          '本地会偶尔自行短途走动，不需要为了「活动一下」而调用；' +
          '只有当前语境确实需要改变位置（让出视线、靠近/避开对话对象等）时才选一次，' +
          '不需要改变位置时不要反复调用。',
        parameters: z.object({
          position: z.union([z.enum(['left', 'center', 'right']), z.number().min(0).max(1)]),
          animation: z
            .string()
            .max(120)
            .optional()
            .describe('移动分类动作名；省略时使用螃蟹走路。其它分类会被拒绝')
        }),
        tags: ['presentation'],
        approval: 'auto',
        handler: async (args, ctx): Promise<ToolOutcome> => {
          if (!this.isEnabled()) return { text: '[PET_DISABLED] 桌宠表现已关闭', failed: true }
          this.noteToolContext(ctx)
          const input = args as {
            position: 'left' | 'center' | 'right' | number
            animation?: string
          }
          const animationId = input.animation ?? DEFAULT_PET_MOVEMENT_ANIMATION
          if (!isMovementAnimationId(animationId)) {
            return {
              text: `[PET_MOVEMENT_INVALID] 「${String(animationId).slice(0, 40)}」不是移动分类素材；可选：${PET_MOVEMENT_ANIMATIONS.join('、')}`,
              failed: true
            }
          }
          const { position } = input
          const target =
            position === 'left'
              ? 0.08
              : position === 'center'
                ? 0.5
                : position === 'right'
                  ? 0.92
                  : position
          const targetText = positionLabel(position, target)
          if (!this.isMovementEnabled()) {
            // 主进程不会把请求送到页面；这里先给出真实原因，避免误报成页面不可用。
            return {
              text: '[PET_MOVE_BLOCKED] 移动总开关已关闭，不会产生位移；请在设置或托盘菜单中开启走动。',
              failed: true
            }
          }
          const autonomous = isAutonomousSource(ctx.source)
          if (autonomous) this.movementEvents.autonomousSelections += 1
          if (autonomous && this.policy !== null) {
            const eligibility = this.policy.evaluateMovement()
            if (!eligibility.ok) {
              return {
                text: `[PET_MOVE_REJECTED] 当前不允许自主移动（${eligibility.reason ?? 'not-idle'}）${retryHint(eligibility.retryAfterMs)}`,
                failed: true
              }
            }
          }
          // 模型在用户对话/快捷聊天里调用的移动也属于语义动作：与 pet_say/
          // pet_act/pet_emote 共用同轮一次、20 秒间隔和 30 秒 TTL。自主移动
          // 仍走旧的 model-decorative 通道，不受语义开关误伤。
          const semanticMove = autonomous
            ? {
                requestClass: 'model-decorative' as const,
                dedupeKey: undefined,
                expiresAt: undefined
              }
            : this.claimSemanticMovement(ctx, animationId)
          if (semanticMove.requestClass === undefined) {
            return {
              text: this.semanticRejectionText(semanticMove.reason),
              failed: true
            }
          }
          this.touchPresentation()
          const outcome = await this.sink?.onWalkTo({
            target,
            animationId,
            ...(autonomous ? { autonomous: true } : {}),
            requestClass: semanticMove.requestClass,
            ...(semanticMove.dedupeKey === undefined ? {} : { dedupeKey: semanticMove.dedupeKey }),
            ...(semanticMove.expiresAt === undefined ? {} : { expiresAt: semanticMove.expiresAt })
          })
          if (outcome === undefined) {
            return {
              text: '[PET_MOVE_FAILED] 桌宠页面不可用，移动未开始。',
              failed: true
            }
          }
          if (outcome.status === 'started' || outcome.status === 'completed') {
            // 用户明确移动也刷新真实移动时间与身体静止时钟；自主资格已在上方绕过检查。
            this.policy?.noteMovementStarted()
            if (outcome.status === 'completed') this.policy?.markBodyActivity()
          } else if (outcome.status === 'failed') {
            this.policy?.noteMovementFailed(animationId)
          }
          return describeMovementOutcome(outcome, targetText)
        }
      },
      {
        name: 'pet_quiet',
        description:
          '暂时停止主动聊天（分钟）：不会再主动开新话题或发气泡，但自主探索和任务可以继续；' +
          '用户消息和用户设置的提醒仍然有效。只想“别说话”时用它；想连探索一起停下，用 pet_pause_explore。',
        parameters: z.object({
          minutes: z.number().int().min(1).max(720)
        }),
        tags: ['presentation'],
        approval: 'auto',
        endsTurn: true,
        handler: async (args, ctx): Promise<ToolOutcome> => {
          if (!this.isEnabled()) return { text: '[PET_DISABLED] 桌宠表现已关闭', failed: true }
          this.noteToolContext(ctx)
          const { minutes } = args as { minutes: number }
          const endsAt = Date.now() + minutes * 60_000
          this.touchPresentation()
          // 立即丢掉尚未展示的主动积压；安静结束后不补播。
          this.dropPendingActiveSays('quiet')
          this.onQuiet(endsAt)
          this.sink?.onQuiet({ minutes, endsAt })
          return { text: `接下来 ${minutes} 分钟不主动说话；探索可以继续。` }
        }
      },
      {
        name: 'pet_pause_explore',
        description:
          '暂停自主探索（分钟）：不再发起新的探索 tick，当前自主任务转为暂停并在到期后恢复；' +
          '主动聊天不受影响。仅当用户明确要求暂停探索时调用。',
        parameters: z.object({
          minutes: z.number().int().min(1).max(1440)
        }),
        tags: ['presentation'],
        approval: 'auto',
        endsTurn: true,
        handler: async (args, ctx): Promise<ToolOutcome> => {
          if (!this.isEnabled()) return { text: '[PET_DISABLED] 桌宠表现已关闭', failed: true }
          this.noteToolContext(ctx)
          const { minutes } = args as { minutes: number }
          const endsAt = Date.now() + minutes * 60_000
          this.touchPresentation()
          this.onPauseExplore(endsAt)
          return { text: `自主探索已暂停 ${minutes} 分钟；到期后恢复。` }
        }
      },
      {
        name: 'pet_open_chat',
        description:
          '打开完整聊天窗口并聚焦，让用户看到当前对话。5 分钟内最多 1 次；' +
          '没有需要展开的内容时不要调用。',
        parameters: z.object({
          reason: z.string().min(1).max(200)
        }),
        tags: ['presentation'],
        approval: 'auto',
        handler: async (args, ctx): Promise<ToolOutcome> => {
          if (!this.isEnabled()) return { text: '[PET_DISABLED] 桌宠表现已关闭', failed: true }
          this.noteToolContext(ctx)
          if (!this.canOpenChat()) {
            return { text: '[PET_CHAT_DISABLED] 用户关闭了「允许桌宠打开聊天窗」', failed: true }
          }
          const now = Date.now()
          if (now - this.lastOpenChatTime < OPEN_CHAT_COOLDOWN_MS) {
            // 这是窗口操作节流，不是气泡/唤醒次数上限；使用独立错误码，
            // 避免诊断把聊天气泡与打开窗口混为一谈。
            return { text: '[PET_CHAT_COOLDOWN] 刚打开过聊天窗，5 分钟内不重复弹出', failed: true }
          }
          const { reason } = args as { reason: string }
          this.lastOpenChatTime = now
          this.touchPresentation(now)
          this.sink?.onOpenChat(reason.trim().slice(0, 200))
          return { text: '完整聊天窗已打开。' }
        }
      },
      {
        name: 'end_turn',
        description:
          '结束本拍，不再做任何事。用于执行完动作后干净收尾；不需要向用户解释。',
        parameters: z.object({}),
        tags: ['presentation'],
        approval: 'auto',
        endsTurn: true,
        handler: async (): Promise<ToolOutcome> => ({ text: '本拍结束。' })
      }
    ]
  }

  onRunPhase(state: RunPhaseState): void {
    this.agentPhase = state.phase
    this.approvalPending = state.approvalPending
    this.round = state.round
    this.retryAt = state.retryAt
    // 真实等待审批会退出空闲资格；用户解决审批时由 Bot 再次标记活动。
    if (state.approvalPending) this.policy?.markActivity()
    if (state.phase !== 'idle') {
      if (!this.turnActive) {
        this.resetTurnTracking()
        this.turnActive = true
        this.turnSource = state.source ?? null
      } else if (this.turnSource === null && state.source !== undefined) {
        this.turnSource = state.source
      }
      // 用户聊天与真实任务持续期间都算实质活动；自主心跳不在这里重置，
      // 否则它自己的短暂推理会永久清空下一次待机资格。
      if (state.source === 'user-chat' || state.source === 'task') {
        this.policy?.markActivity()
      }
      for (const name of state.running) {
        if (PRESENTATION_TOOL_NAMES.has(name)) {
          this.turnHadPresentation = true
        } else {
          // 真实业务工具会让本轮视为实质工作；自主娱乐冷却不会因此重置，
          // 但也不会把真实工作误演成「空轮庆祝」。
          this.turnSubstantive = true
          this.policy?.markActivity()
        }
      }
    }
    // silentEnd 通常随本轮的最后一拍（idle）到达；在新轮初始化之后再写入，
    // 避免第一拍就携带 silentEnd 时被 resetTurnTracking 清掉。
    if (state.silentEnd === true) this.turnSilent = true
    if (!this.isEnabled()) return

    if (state.phase === 'idle') {
      // Core 先发 idle，再发 onTurnEnded；短暂等待以免闪一下 idle。
      this.scheduleIdle()
      return
    }
    this.cancelIdleTimer()
    this.cancelTransient()
    const mapped = mapPhase(state)
    this.emitPhase(mapped, true)
  }

  onTurnEnded(outcome: TurnOutcome): void {
    if (!this.isEnabled()) {
      this.resetTurnTracking()
      return
    }
    this.cancelIdleTimer()
    // 达到单轮上限不是失败：进展已经保留，具体原因由结构化 TurnFailure
    // 在状态条/诊断里显示，不能把它和 Provider 故障一起演成“没成功”。
    if (outcome === 'capped') {
      this.cancelTransient()
      this.emitPhase('idle', true)
      this.resetTurnTracking()
      return
    }
    // 纯表现轮、空自主轮与自主 tick 不演成功庆祝；否则每次点击动作/内部
    // tick 都会制造一次「thinking → working → success」循环。
    const suppressSuccess =
      outcome === 'done' &&
      (this.turnSilent ||
        this.turnSource === 'autonomy' ||
        (this.turnHadPresentation && !this.turnSubstantive))
    // task 轮只要真正做了业务工具，仍应保留一次成功庆祝；纯表现的任务轮被
    // 上面的 presentation-only 规则抑制。
    if (suppressSuccess) {
      this.cancelTransient()
      this.emitPhase('idle', true)
      this.resetTurnTracking()
      return
    }
    const phase: ClientPhase = outcome === 'done' ? 'done' : 'failed'
    this.transient = outcome === 'done' ? 'done' : 'failed'
    this.emitPhase(phase, true)
    this.transientTimer = setTimeout(() => {
      this.transientTimer = null
      this.transient = null
      if (this.agentPhase === 'idle') this.emitPhase('idle', true)
    }, outcome === 'done' ? DONE_MS : FAILED_MS)
    this.transientTimer.unref?.()
    this.resetTurnTracking()
  }

  /** 用户拖动/点击/打开聊天：立刻结束瞬时 done/failed，并退出空闲资格。 */
  notifyUserInteraction(): void {
    this.policy?.markActivity()
    if (this.transient !== null) {
      this.cancelTransient()
      if (this.agentPhase === 'idle') this.emitPhase('idle', true)
    }
  }

  /**
   * 用户触摸桌宠。只记录次数与时间；是否让模型看到由 reactions 档位决定。
   * 事件只有动作类别，不含坐标、窗口或屏幕内容；不会打断正在运行的任务。
   */
  noteTouch(kind: PetTouchKind): void {
    const now = Date.now()
    this.policy?.markActivity()
    this.lastBodyMotionAt = now
    this.lastTouchAt = now
    this.lastTouchKind = kind
    if (kind === 'grab') this.presence.dragging = true
    else if (kind === 'drop' || kind === 'throw' || kind === 'crash') {
      this.presence.dragging = false
    }
    this.touchCounts.set(kind, (this.touchCounts.get(kind) ?? 0) + 1)
    this.notifyUserInteraction()

    if (!this.isEnabled() || this.host === null) return
    if (this.getReactions() === 'quiet') return
    if (now - this.lastTouchEventAt < TOUCH_EVENT_GAP_MS) return
    this.lastTouchEventAt = now

    let attention: EventAttention = 'ambient'
    if (
      this.getReactions() === 'active' &&
      !this.isAgentBusy() &&
      now - this.lastTouchWakeAt >= TOUCH_WAKE_GAP_MS
    ) {
      this.lastTouchWakeAt = now
      attention = 'wake'
    }

    this.host.pushEvent({
      type: 'pet.touch',
      source: 'pet',
      origin: 'internal',
      text: `[PET_TOUCH] 用户刚刚${TOUCH_TEXT[kind]}。这是本机互动，不是新的对话要求；想回应时再回应，不必每次开口。`,
      tags: ['pet', 'touch'],
      meta: { kind },
      trigger: 'piggyback',
      attention,
      persist: false
    })
  }

  /** 只读诊断：触摸次数与最后时间，不含任何屏幕/坐标信息。 */
  touchStats(): { lastAt: number | null; counts: Record<string, number> } {
    return { lastAt: this.lastTouchAt, counts: Object.fromEntries(this.touchCounts) }
  }

  isAgentBusy(): boolean {
    return this.agentPhase !== 'idle' || this.approvalPending || this.transient !== null
  }

  /** 最近一次模型展示动作的时间；自主 tick 用它重置退避。 */
  lastPresentationAt(): number {
    return this.lastPresentationTime
  }

  currentPresentation(): AgentPresentation {
    return {
      phase: this.phase,
      approvalPending: this.approvalPending,
      ...(this.retryAt === undefined ? {} : { retryAt: this.retryAt }),
      round: this.round
    }
  }

  // -------------------------------------------------------------------------

  private noteToolContext(ctx: ToolContext): void {
    // Core 的相位来源更权威；只有测试/旧调用没有相位来源时才用工具上下文补。
    if (this.turnSource === null) this.turnSource = ctx.source
    this.turnHadPresentation = true
  }

  /**
   * 将同一轮模型选择的动作标记为 `model-semantic`。
   *
   * 语义动作不走旧的「空闲 ≥120 秒 + 娱乐冷却」闸门；这里只做本进程可见的
   * 开关与同轮去重，真正的 20 秒节流、占用和 TTL 由页面控制器复核。用户正文
   * 明确要求张望时，类别降为 `user-explicit`，但仍计入同轮一次动作。
   */
  private selectSemanticIntent(
    ctx: ToolContext,
    intent: PetAnimationIntent
  ): {
    intent?: PetAnimationIntent
    reason?: 'disabled' | 'duplicate' | 'look-around-cooldown'
  } {
    if (!this.getSemanticConfig().enabled) {
      this.semanticEvents.disabled += 1
      return { reason: 'disabled' }
    }
    const turnKey = ctx.turnId ?? `${ctx.turn}`
    const key = `${ctx.sessionId}:${turnKey}`.slice(0, 120)
    if (this.semanticTurns.has(key)) {
      this.semanticEvents.duplicate += 1
      return { reason: 'duplicate' }
    }
    const lookAround = isLookAroundAnimation(intent.animationId)
    const userExplicitLook = lookAround && ctx.now() < this.explicitLookUntil
    // 非用户明确要求的张望先过共享品类下限；被挡住时不占用本轮的「一个动作」
    // 名额，模型仍可改选其他动作或只说话。页面还会基于真实回执复核一次。
    if (lookAround && !userExplicitLook) {
      const eligibility = this.policy?.evaluateLookAround()
      if (eligibility !== undefined && !eligibility.ok) {
        this.semanticEvents.rejected += 1
        this.semanticEvents.lastRejection = 'look-around-cooldown'
        return { reason: 'look-around-cooldown' }
      }
    }
    this.semanticTurns.set(key, { animationId: intent.animationId, at: ctx.now() })
    while (this.semanticTurns.size > SEMANTIC_TURN_LIMIT) {
      const oldest = this.semanticTurns.keys().next().value
      if (oldest === undefined) break
      this.semanticTurns.delete(oldest)
    }
    this.semanticEvents.selected += 1
    const requestClass: PetRequestClass = userExplicitLook ? 'user-explicit' : 'model-semantic'
    // 语义动作不是旧的「模型空闲娱乐」通道：不把旧的 autonomous 标记带到页面，
    // 否则会被旧 120 秒/娱乐开关再次拦截。来源仍保留在 source 中供诊断。
    const semanticIntent: PetAnimationIntent = { ...intent }
    delete semanticIntent.autonomous
    return {
      intent: {
        ...semanticIntent,
        requestClass,
        dedupeKey: key,
        expiresAt: ctx.now() + PET_SEMANTIC_TTL_MS
      }
    }
  }

  /**
   * 语义移动的宿主侧闸门：与普通动作共用 turn 去重、开关和 TTL。
   * 张望品类冷却与移动无关，真实占用由页面控制器复核。
   */
  private claimSemanticMovement(
    ctx: ToolContext,
    _animationId: string
  ): {
    requestClass?: PetRequestClass
    dedupeKey?: string
    expiresAt?: number
    reason?: 'disabled' | 'duplicate'
  } {
    if (!this.getSemanticConfig().enabled) {
      this.semanticEvents.disabled += 1
      return { reason: 'disabled' }
    }
    const turnKey = ctx.turnId ?? `${ctx.turn}`
    const key = `${ctx.sessionId}:${turnKey}`.slice(0, 120)
    if (this.semanticTurns.has(key)) {
      this.semanticEvents.duplicate += 1
      return { reason: 'duplicate' }
    }
    this.semanticTurns.set(key, { animationId: _animationId, at: ctx.now() })
    while (this.semanticTurns.size > SEMANTIC_TURN_LIMIT) {
      const oldest = this.semanticTurns.keys().next().value
      if (oldest === undefined) break
      this.semanticTurns.delete(oldest)
    }
    this.semanticEvents.selected += 1
    return {
      requestClass: 'model-semantic',
      dedupeKey: key,
      expiresAt: ctx.now() + PET_SEMANTIC_TTL_MS
    }
  }

  private semanticRejectionText(
    reason: 'disabled' | 'duplicate' | 'look-around-cooldown' | undefined
  ): string {
    if (reason === 'disabled') {
      return '[PET_SEMANTIC_DISABLED] 用户关闭了「按聊天与行为配动作」，本轮不播放动作。'
    }
    if (reason === 'duplicate') {
      return '[PET_SEMANTIC_DUPLICATE] 同一轮已经选择过一个动作；本轮不再重复播放。'
    }
    if (reason === 'look-around-cooldown') {
      return '[PET_LOOK_AROUND_COOLDOWN] 张望类动作仍在共享冷却中；本轮不播放，可改选其他动作或只说话。'
    }
    return '[PET_SEMANTIC_UNAVAILABLE] 当前没有可用的语义动作。'
  }

  /** 主进程保存的张望品类截止时间；用于设置热更新与页面重载校准。 */
  lookAroundCooldownUntil(): number {
    return this.policy?.lookAroundCooldownUntil() ?? 0
  }

  /** 语义动作聚合诊断；只有计数与固定原因，不含轮次键或正文。 */
  semanticDiagnostics(): Record<string, unknown> {
    return { ...this.semanticEvents }
  }

  /**
   * 所有真实动画回执的观察入口（含排队后迟到的 started/rejected）。
   * 页面里的等待状态和用户点播不在本 World 的调用栈里，但通过这里同步张望
   * 品类时钟；模型语义拒绝原因也在这里留痕。
   *
   * started 与 completed 是两次独立回执，只有 started 能计数/刷新品类时钟；
   * 否则一段 10 秒的张望播完还会再续 15 分钟，语义诊断也会重复计数。
   */
  noteAnimationReceipt(
    receipt: PetAnimationReceipt,
    meta: { source: string; requestClass: PetRequestClass } | null
  ): void {
    if (meta?.requestClass === 'model-semantic') {
      if (receipt.status === 'started') {
        this.semanticEvents.started += 1
      } else if (receipt.status === 'rejected' || receipt.status === 'unsupported') {
        this.semanticEvents.rejected += 1
        this.semanticEvents.lastRejection = (receipt.reason ?? receipt.status).slice(0, 120)
      }
    }
    if (!isLookAroundAnimation(receipt.animationId)) return
    if (receipt.status === 'started') {
      this.policy?.noteLookAroundStarted(meta?.source ?? 'animation-receipt')
      return
    }
    if (
      receipt.status === 'rejected' ||
      receipt.status === 'unsupported' ||
      receipt.status === 'failed'
    ) {
      this.policy?.noteLookAroundRejected(
        meta?.source ?? 'animation-receipt',
        `${receipt.status}:${receipt.reason ?? 'unknown'}`
      )
    }
  }

  /**
   * 页面快照里的张望 started：等待档位、右键菜单等页面内部通道不经过
   * animation broker，却必须计入同一品类冷却，并让 renderer 重载后仍能
   * 从主进程拿到正确的截止时间。重复心跳只处理时间更新的新事件。
   */
  notePageLookAround(
    state: { lastStartedAt: number | null; lastSource: string | null } | null | undefined
  ): void {
    const startedAt = state?.lastStartedAt
    if (startedAt === null || startedAt === undefined || !Number.isFinite(startedAt)) return
    if (
      this.lastPageLookAroundStartedAt !== null &&
      startedAt <= this.lastPageLookAroundStartedAt
    ) {
      return
    }
    this.lastPageLookAroundStartedAt = startedAt
    if (this.policy === null) return
    // 同一段模型张望通常先经 broker 回执（页面墙钟与主进程观察时间相差很小），
    // 快照不能把它再续一次；只有页面独有的事件才落在这里。
    const policyStartedAt = this.policy.lookAroundStartedWallAt()
    if (policyStartedAt !== null && startedAt <= policyStartedAt + 1_500) return
    this.policy.noteLookAroundStarted(state?.lastSource ?? 'page')
  }

  private noteAnimationOutcome(
    intent: PetAnimationIntent,
    outcome: PetAnimationOutcome
  ): void {
    const started = outcome.status === 'started' || outcome.status === 'completed'
    if (isLookAroundAnimation(intent.animationId)) {
      // 页面原始回执也会同步一次；重复刷新同一个真实 started 不改变语义。
      if (started) {
        this.policy?.noteLookAroundStarted(intent.requestClass ?? intent.source)
      } else if (
        outcome.status === 'rejected' ||
        outcome.status === 'unsupported' ||
        outcome.status === 'failed'
      ) {
        this.policy?.noteLookAroundRejected(
          intent.requestClass ?? intent.source,
          `${outcome.status}:${outcome.reason ?? 'unknown'}`
        )
      }
    }
    // 只有旧版「模型自主装饰」通道才更新娱乐冷却；语义动作和用户点播不能
    // 把随后的本地随机小动作推到旧的长冷却里。
    const legacyDecorative =
      intent.requestClass === undefined || intent.requestClass === 'model-decorative'
    if (!legacyDecorative || intent.autonomous !== true) return
    if (started) {
      this.policy?.noteActionStarted(intent.animationId, intent.source)
    } else if (
      outcome.status === 'failed' ||
      outcome.status === 'unsupported' ||
      outcome.status === 'rejected'
    ) {
      this.policy?.noteActionFailed(intent.animationId)
    }
  }

  private resetTurnTracking(): void {
    this.turnActive = false
    this.turnSilent = false
    this.turnSubstantive = false
    this.turnHadPresentation = false
    this.turnSource = null
  }

  /**
   * 气泡显示 + 主动 Episode 的唯一实现。pet_say 与 reaction_respond 共用，
   * 保证展示协调、脱敏与持久化边界一致。
   *
   * 频率不再用 `failed` 拒绝：间隔内的新内容进入有界队列，按时序展示；
   * 同一任务/同一文本的连续更新只替换尚未展示的旧版本。用户聊天回复
   * 永远立即显示，并清掉不再相关的主动积压。
   */
  private async performSay(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    if (!this.isEnabled()) return { text: '[PET_DISABLED] 桌宠表现已关闭', failed: true }
    this.noteToolContext(ctx)
    const input = args as {
      text: string
      preset?: PetPreset
      ttl_ms?: number
      pendingQuestion?: string
      kind?: 'comment' | 'question' | 'proposal' | 'task_update'
      discoveryId?: string
    } & AnimationArgInput
    const text = cleanSay(input.text)
    if (text === '') return { text: '[PET_FAILED] 气泡文本为空', failed: true }
    if (
      input.discoveryId !== undefined &&
      !DISCOVERY_ID_PATTERN.test(input.discoveryId)
    ) {
      return {
        text: '[PET_BAD_DISCOVERY] discoveryId 形状不合法；气泡未显示。',
        failed: true
      }
    }
    const resolved = resolveAnimationIntent(input, 'say', {
      autonomous: isAutonomousSource(ctx.source)
    })
    // 安静时段只停「主动」气泡：任务进度、自主发现和事件评论都不显示。
    // 用户直接聊天仍走聊天回复，不受这里影响。返回成功而不是失败，
    // 避免任务把“按用户要求没说话”误判成工具故障后重试。
    const proactive = isProactiveSaySource(ctx.source)
    if (
      this.isStaleProactiveTurn({
        source: ctx.source,
        ...(ctx.turnId === undefined ? {} : { turnId: ctx.turnId })
      })
    ) {
      // 停止浏览后，在途回合不能再补发主动气泡；发现记录仍保留，留给以后
      // 的新回合决定是否分享。返回非 failed，避免模型在同一轮重试。
      this.reportSayResult(
        { discoveryId: input.discoveryId },
        'cancelled',
        undefined,
        'bili-stopped'
      )
      return {
        text:
          input.discoveryId === undefined
            ? '[PET_STALE_SAY] 用户刚停止了这次浏览，这句主动气泡没有显示。'
            : '[PET_STALE_SHARE] 用户刚停止了这次浏览，这句发现分享没有显示；' +
              '发现仍保留，以后想分享时可以在新的回合里再说。'
      }
    }
    if (proactive && this.isSpeechQuiet()) {
      // 即使没有展示，也要让带 discoveryId 的分享落定为 cancelled，
      // 否则发现会一直停在待分享状态。
      this.reportSayResult({ discoveryId: input.discoveryId }, 'cancelled', undefined, 'quiet')
      return { text: '用户要求暂时安静，主动气泡已跳过；探索和任务可以继续。' }
    }

    const now = ctx.now()
    let animationIntent = resolved.intent
    let notice =
      resolved.unsupported === undefined
        ? resolved.notice
        : `[PET_ANIMATION_UNSUPPORTED] ${resolved.unsupported}（气泡仍会显示）`
    if (animationIntent !== undefined && isMovementAnimationId(animationIntent.animationId)) {
      // 普通气泡动作不能冒充位移；文字仍可显示。
      animationIntent = undefined
      notice = '[PET_MOVEMENT_REQUIRED] 移动分类素材请使用 pet_walk_to；气泡仍会显示。'
    } else if (animationIntent !== undefined) {
      const selected = this.selectSemanticIntent(ctx, animationIntent)
      if (selected.intent === undefined) {
        animationIntent = undefined
        notice = `${this.semanticRejectionText(selected.reason)}（气泡仍会显示）`
      } else {
        animationIntent = selected.intent
      }
    }
    const payload: PendingSay = {
      text,
      preset: input.preset ?? null,
      ttlMs: clamp(input.ttl_ms ?? 8000, 2000, 20_000),
      source: ctx.source,
      ...(ctx.turnId === undefined ? {} : { turnId: ctx.turnId }),
      enqueuedAt: now,
      expiresAt: now + clamp(input.ttl_ms ?? 8000, 2000, 20_000),
      ...(input.discoveryId === undefined ? {} : { discoveryId: input.discoveryId }),
      ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
      ...(animationIntent === undefined ? {} : { animation: animationIntent }),
      ...(notice === undefined ? {} : { animationNotice: notice }),
      ...(input.pendingQuestion === undefined ? {} : { pendingQuestion: input.pendingQuestion }),
      ...(input.kind === undefined ? {} : { kind: input.kind })
    }

    if (!proactive) {
      // 用户正在等回复：立即显示，并丢弃已被新对话取代的主动内容。
      this.dropPendingActiveSays()
      const delivery = await this.displaySay(payload, now)
      return {
        text: describeSayResult(delivery, payload.animationNotice),
        ...(delivery.displayed ? {} : { failed: true })
      }
    }

    this.pruneSays(now)
    if (this.pendingSays.length === 0 && now - this.lastSayTime >= SAY_MIN_GAP_MS) {
      const delivery = await this.displaySay(payload, now)
      return {
        text: describeSayResult(delivery, payload.animationNotice),
        ...(delivery.displayed ? {} : { failed: true })
      }
    }
    const merged = this.enqueueSay(payload, now)
    return {
      text: merged
        ? '气泡内容已更新；会按顺序展示最新一版。'
        : '气泡已进入展示队列，会按顺序展示。'
    }
  }

  /**
   * 屏幕陪伴的专用显示入口。不经过模型工具调用；台词由独立短请求生成，
   * 与 performSay 共用 displaySay，保证回执、Episode、安静与隐私边界一致。
   *
   * 忙碌时返回 cancelled/busy，由控制器保留最新候选，绝不插入别人排队中的
   * 主动气泡；只有真实页面回执 displayed 才返回 displayed。
   */
  async displayScreenFeedback(input: {
    feedbackId: string
    observationId: string
    text: string
    kind: 'comment' | 'question'
    pendingQuestion?: string
    ttlMs?: number
  }): Promise<{ outcome: PetSayResultOutcome; reason?: string; episodeId?: string }> {
    const now = Date.now()
    if (!this.isEnabled()) return { outcome: 'cancelled', reason: 'disabled' }
    if (!/^[A-Za-z0-9_-]{6,140}$/.test(input.feedbackId)) {
      return { outcome: 'failed', reason: 'invalid-id' }
    }
    if (!/^[A-Za-z0-9_-]{6,160}$/.test(input.observationId)) {
      return { outcome: 'failed', reason: 'invalid-id' }
    }
    const text = cleanSay(input.text)
    if (text === '') return { outcome: 'failed', reason: 'invalid-text' }
    if (this.isSpeechQuiet()) return { outcome: 'cancelled', reason: 'speech-quiet' }
    this.pruneSays(now)
    if (this.pendingSays.length > 0 || now - this.lastSayTime < SAY_MIN_GAP_MS) {
      return { outcome: 'cancelled', reason: 'busy' }
    }
    const ttlMs = clamp(input.ttlMs ?? 9000, 4000, 20_000)
    const payload: PendingSay = {
      text,
      preset: null,
      ttlMs,
      source: 'screen_feedback',
      channel: 'screen_feedback',
      feedbackId: input.feedbackId,
      observationId: input.observationId,
      kind: input.kind,
      ...(input.kind === 'question' && input.pendingQuestion !== undefined
        ? { pendingQuestion: input.pendingQuestion }
        : {}),
      enqueuedAt: now,
      expiresAt: now + ttlMs
    }
    const delivery = await this.displaySay(payload, now)
    return {
      outcome: delivery.outcome ?? (delivery.displayed ? 'displayed' : 'failed'),
      ...(delivery.reason === undefined ? {} : { reason: delivery.reason }),
      ...(delivery.episodeId === undefined ? {} : { episodeId: delivery.episodeId })
    }
  }

  /**
   * 有界合并：同任务或同文本的连续更新替换旧版本；队列满时替换最旧的
   * 待展示项，而不是把新内容判成失败。过期内容直接丢弃。
   */
  private enqueueSay(payload: PendingSay, now: number): boolean {
    this.pruneSays(now)
    for (let index = this.pendingSays.length - 1; index >= 0; index -= 1) {
      const item = this.pendingSays[index]
      if (item === undefined) continue
      const sameTask =
        payload.taskId !== undefined &&
        item.taskId === payload.taskId &&
        item.source === payload.source
      if (sameTask || item.text === payload.text) {
        this.pendingSays[index] = payload
        this.reportSayResult(item, 'cancelled', undefined, 'replaced')
        this.scheduleSayFlush()
        return true
      }
    }
    if (this.pendingSays.length >= SAY_QUEUE_LIMIT) {
      const dropped = this.pendingSays.shift()
      if (dropped !== undefined) {
        this.droppedSays += 1
        this.reportSayResult(dropped, 'cancelled', undefined, 'queue-overflow')
      }
    }
    this.pendingSays.push(payload)
    this.scheduleSayFlush()
    return false
  }

  private pruneSays(now: number): void {
    for (let index = this.pendingSays.length - 1; index >= 0; index -= 1) {
      const item = this.pendingSays[index]
      if (item === undefined) continue
      if (now > item.expiresAt) {
        this.pendingSays.splice(index, 1)
        this.droppedSays += 1
        this.reportSayResult(item, 'cancelled', undefined, 'expired')
      }
    }
  }

  private dropPendingActiveSays(reason = 'superseded'): void {
    this.cancelPendingProactiveSays(reason)
  }

  /**
   * 取消所有尚未展示的主动气泡。用户停止浏览、接管页面或关闭分享时调用；
   * 已显示的气泡不受影响。返回取消数量（诊断用）。
   */
  cancelPendingProactiveSays(reason = 'cancelled'): number {
    let count = 0
    for (let index = this.pendingSays.length - 1; index >= 0; index -= 1) {
      const item = this.pendingSays[index]
      if (item === undefined) continue
      if (!isProactiveSaySource(item.source)) continue
      this.pendingSays.splice(index, 1)
      this.droppedSays += 1
      count += 1
      this.reportSayResult(item, 'cancelled', undefined, reason)
    }
    if (this.pendingSays.length === 0) this.clearSayTimer()
    return count
  }

  /**
   * 取消指定发现的待展示气泡（删除/清空发现时调用）。`keep` 返回 true 的
   * 发现保留；不传 `keep` 表示全部取消。已展示的气泡和没有 discoveryId 的
   * 气泡不受影响，避免有关于其他发现的队列被一并清掉。
   */
  cancelPendingDiscoveryShares(
    reason = 'discovery-removed',
    keep?: (discoveryId: string) => boolean
  ): number {
    let count = 0
    for (let index = this.pendingSays.length - 1; index >= 0; index -= 1) {
      const item = this.pendingSays[index]
      if (item === undefined || item.discoveryId === undefined) continue
      if (keep !== undefined && keep(item.discoveryId)) continue
      this.pendingSays.splice(index, 1)
      this.droppedSays += 1
      count += 1
      this.reportSayResult(item, 'cancelled', undefined, reason)
    }
    if (this.pendingSays.length === 0) this.clearSayTimer()
    return count
  }

  /**
   * 记录“用户停止浏览时正在进行的回合”。这个回合之后才到达的主动气泡
   * （包括已排队和还在工具调用里的）一律不再显示；新回合不受影响。
   * 回合 ID 不会复用，集合只保留最近几个即可。
   */
  noteStaleProactiveTurn(turnId: string | null | undefined): void {
    if (typeof turnId !== 'string') return
    const value = turnId.trim()
    if (value === '') return
    this.staleProactiveTurnIds.add(value)
    while (this.staleProactiveTurnIds.size > 8) {
      const oldest = this.staleProactiveTurnIds.values().next().value
      if (oldest === undefined) break
      this.staleProactiveTurnIds.delete(oldest)
    }
  }

  private isStaleProactiveTurn(payload: {
    source?: PendingSay['source']
    turnId?: string
  }): boolean {
    return (
      isProactiveSaySource(payload.source ?? 'user-chat') &&
      payload.turnId !== undefined &&
      this.staleProactiveTurnIds.has(payload.turnId)
    )
  }

  /** 带发现 id / 屏幕反馈 id 的气泡终态统一回写；都没有时是空操作。 */
  private reportSayResult(
    payload: {
      discoveryId?: string
      feedbackId?: string
      observationId?: string
      channel?: 'screen_feedback'
    },
    outcome: PetSayResultOutcome,
    episodeId?: string,
    reason?: string
  ): void {
    const discoveryId = payload.discoveryId
    const feedbackId = payload.feedbackId
    if ((discoveryId === undefined && feedbackId === undefined) || this.onSayResult === null) {
      return
    }
    try {
      this.onSayResult({
        ...(discoveryId === undefined ? {} : { discoveryId }),
        ...(feedbackId === undefined ? {} : { feedbackId }),
        ...(payload.observationId === undefined
          ? {}
          : { observationId: payload.observationId }),
        ...(payload.channel === undefined ? {} : { channel: payload.channel }),
        ...(episodeId === undefined ? {} : { episodeId }),
        outcome,
        ...(reason === undefined ? {} : { reason }),
        now: Date.now()
      })
    } catch (error) {
      this.logger.warn('气泡终态回写失败', { error: String(error).slice(0, 200) })
    }
  }

  private scheduleSayFlush(): void {
    if (this.sayTimer !== null || this.pendingSays.length === 0) return
    const delay = Math.max(0, this.lastSayTime + SAY_MIN_GAP_MS - Date.now())
    this.sayTimer = setTimeout(() => {
      this.sayTimer = null
      this.flushSayQueue()
    }, delay)
    this.sayTimer.unref?.()
  }

  private clearSayTimer(): void {
    if (this.sayTimer !== null) {
      clearTimeout(this.sayTimer)
      this.sayTimer = null
    }
  }

  private flushSayQueue(): void {
    if (!this.isEnabled()) {
      for (const item of this.pendingSays) {
        this.reportSayResult(item, 'cancelled', undefined, 'disabled')
      }
      this.pendingSays.length = 0
      return
    }
    const now = Date.now()
    this.pruneSays(now)
    if (
      this.isSpeechQuiet() &&
      this.pendingSays.some((item) => isProactiveSaySource(item.source))
    ) {
      // 用户要求安静后不补播积压的主动内容；直接聊天回复不在此列。
      this.dropPendingActiveSays('quiet')
    }
    while (this.pendingSays.length > 0) {
      if (now - this.lastSayTime < SAY_MIN_GAP_MS) {
        this.scheduleSayFlush()
        return
      }
      const next = this.pendingSays.shift()
      if (next === undefined) return
      if (isProactiveSaySource(next.source)) {
        if (this.isSpeechQuiet()) {
          this.droppedSays += 1
          this.reportSayResult(next, 'cancelled', undefined, 'quiet')
          continue
        }
      }
      void this.displaySay(next, now).catch((error: unknown) => {
        this.logger.warn('气泡展示失败', { error: String(error).slice(0, 200) })
      })
      if (this.pendingSays.length > 0) this.scheduleSayFlush()
      return
    }
  }

  private async displaySay(payload: PendingSay, now: number): Promise<PetSayDelivery> {
    const hidden = (
      reason: string,
      outcome: PetSayResultOutcome,
      episodeId?: string
    ): PetSayDelivery => ({
      displayed: false,
      animation: null,
      reason,
      outcome,
      ...(episodeId === undefined ? {} : { episodeId })
    })
    if (!this.isEnabled()) {
      this.reportSayResult(payload, 'cancelled', undefined, 'disabled')
      return hidden('disabled', 'cancelled')
    }
    const proactive = isProactiveSaySource(payload.source)
    if (this.isStaleProactiveTurn(payload)) {
      // 已经排队的主动气泡在停止浏览后也不能补发；尚未展示就不建立 Episode。
      this.reportSayResult(payload, 'cancelled', undefined, 'bili-stopped')
      return hidden('bili-stopped', 'cancelled')
    }
    if (proactive && this.isSpeechQuiet()) {
      this.reportSayResult(payload, 'cancelled', undefined, 'quiet')
      return hidden('quiet', 'cancelled')
    }

    // 只有任务/自主唤醒/屏幕陪伴的主动开口才建立 Episode；用户聊天回复不算。
    let episodeId: string | undefined
    if (this.onProactiveSay !== null && proactive) {
      try {
        const episode = this.onProactiveSay({
          text: payload.text,
          ...(payload.taskId === undefined ? {} : { taskId: payload.taskId }),
          ...(payload.discoveryId === undefined
            ? {}
            : { discoveryId: payload.discoveryId }),
          ...(payload.channel === undefined ? {} : { channel: payload.channel }),
          ...(payload.feedbackId === undefined ? {} : { feedbackId: payload.feedbackId }),
          ...(payload.observationId === undefined
            ? {}
            : { observationId: payload.observationId }),
          ...(payload.kind === undefined && payload.pendingQuestion === undefined
            ? {}
            : payload.pendingQuestion === undefined
              ? { kind: payload.kind }
              : {
                  kind: payload.kind ?? ('question' as const),
                  pendingQuestion: payload.pendingQuestion
                }),
          now
        })
        if (episode?.rejected !== undefined) {
          this.logger.info('主动气泡因已有未回应开场而跳过', {
            reason: episode.rejected.slice(0, 80)
          })
          this.droppedSays += 1
          this.reportSayResult(payload, 'cancelled', undefined, 'episode-rejected')
          return hidden('episode-rejected', 'cancelled')
        }
        episodeId = episode?.episodeId
      } catch (error) {
        this.logger.warn('主动对话记录失败', { error: String(error).slice(0, 200) })
      }
    }
    // 屏幕陪伴必须落进 Episode，才能在气泡失败时回滚、在被用户接话时关联。
    if (payload.channel === 'screen_feedback' && episodeId === undefined) {
      this.droppedSays += 1
      this.reportSayResult(payload, 'cancelled', undefined, 'episode-unavailable')
      return hidden('episode-unavailable', 'cancelled')
    }
    const sink = this.sink
    if (sink === null) {
      this.reportSayResult(payload, 'cancelled', episodeId, 'sink-unavailable')
      return hidden('sink-unavailable', 'cancelled', episodeId)
    }
    try {
      const delivery = await sink.onSay({
        text: payload.text,
        preset: payload.preset,
        ttlMs: payload.ttlMs,
        ...(episodeId === undefined ? {} : { episodeId }),
        ...(payload.animation === undefined ? {} : { animation: payload.animation }),
        ...(payload.animationNotice === undefined
          ? {}
          : { animationNotice: payload.animationNotice })
      })
      if (delivery.displayed) {
        // 只有真实页面回执才算“说过”：推进间隔、表现时间与指标。
        this.lastSayTime = now
        this.touchPresentation(now)
        this.onSpoken?.(
          now,
          payload.channel === 'screen_feedback'
            ? {
                channel: 'screen_feedback',
                ...(payload.feedbackId === undefined
                  ? {}
                  : { feedbackId: payload.feedbackId }),
                ...(payload.observationId === undefined
                  ? {}
                  : { observationId: payload.observationId })
              }
            : undefined
        )
      }
      if (payload.animation !== undefined) {
        this.noteAnimationOutcome(payload.animation, delivery.animation ?? {
          status: 'failed',
          animationId: payload.animation.animationId,
          reason: 'no-outcome'
        })
      }
      this.reportSayResult(
        payload,
        delivery.displayed ? 'displayed' : 'failed',
        episodeId,
        delivery.displayed ? undefined : 'not-displayed'
      )
      return {
        ...delivery,
        outcome: delivery.displayed ? 'displayed' : 'failed',
        ...(delivery.displayed
          ? {}
          : { reason: delivery.reason ?? 'not-displayed' }),
        ...(episodeId === undefined ? {} : { episodeId })
      }
    } catch (error) {
      this.logger.warn('气泡展示失败', { error: String(error).slice(0, 200) })
      const animation: PetAnimationOutcome | null =
        payload.animation === undefined
          ? null
          : {
              status: 'failed',
              animationId: payload.animation.animationId,
              reason: 'host-error'
            }
      if (payload.animation !== undefined && animation !== null) {
        this.noteAnimationOutcome(payload.animation, animation)
      }
      this.reportSayResult(payload, 'failed', episodeId, 'host-error')
      return {
        displayed: false,
        animation,
        reason: 'host-error',
        outcome: 'failed',
        ...(episodeId === undefined ? {} : { episodeId })
      }
    }
  }

  private touchPresentation(now = Date.now()): void {
    this.lastPresentationTime = now
  }

  private scheduleIdle(): void {
    if (this.idleTimer !== null) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.agentPhase === 'idle' && this.transient === null && !this.approvalPending) {
        if (this.phase !== 'idle') this.emitPhase('idle', true)
      }
    }, 120)
    this.idleTimer.unref?.()
  }

  private emitPhase(phase: ClientPhase, force = false): void {
    const previous = this.phase
    this.phase = phase
    // 不在相位切换时直接记张望：页面可能因品类冷却/减少动态效果而没播。
    // 真实 started 会经 animation broker 或页面快照（notePageLookAround）回来。
    const key = `${phase}:${this.approvalPending ? 1 : 0}:${this.retryAt ?? 0}`
    if (!force && key === this.lastPhaseKey) return
    this.lastPhaseKey = key
    try {
      this.sink?.onPhase({
        phase,
        approvalPending: this.approvalPending,
        ...(this.retryAt === undefined ? {} : { retryAt: this.retryAt }),
        round: this.round
      })
    } catch (error) {
      this.logger.warn('相位展示失败', { error: String(error) })
    }
  }

  private cancelTransient(): void {
    if (this.transientTimer !== null) {
      clearTimeout(this.transientTimer)
      this.transientTimer = null
    }
    this.transient = null
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private clearTimers(): void {
    this.cancelTransient()
    this.cancelIdleTimer()
  }
}

function mapPhase(state: RunPhaseState): ClientPhase {
  switch (state.phase) {
    case 'delivering':
    case 'model':
    case 'handoff':
      return 'thinking'
    case 'tools':
      return state.approvalPending ? 'asking' : 'tool'
    case 'backoff':
      return 'queued'
    default:
      return 'idle'
  }
}

function cleanSay(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 60)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}
