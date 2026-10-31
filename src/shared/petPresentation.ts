/**
 * 新桌宠表现契约（R01–R07）。
 *
 * 单一事实来源：
 *  - 可点播动画名来自校验后的上游目录 `dshPet/catalog.generated`；
 *  - 工作状态档位来自 `dshPet/workStatus`，索引顺序与上游 `events.workStatus` 一致；
 *  - 旧 expression/motion 只做迁移期解析，明确标注近似动作，绝不伪装成等价能力。
 *
 * 这里不依赖 Electron / DOM，主进程与宠物页共用。
 */

import {
  DSH_PET_ANIMATION_ID_SET,
  DSH_PET_ANIMATION_IDS,
  DSH_PET_CATALOG
} from './dshPet/catalog.generated'
import type { DshPetCatalog } from './dshPet/types'
import type { WorkStatusState } from './dshPet/workStatus'

export {
  WORK_STATUS_INDEX,
  WORK_STATUS_STATES,
  toWorkStatus
} from './dshPet/workStatus'
export type { WorkStatusSnapshot, WorkStatusState } from './dshPet/workStatus'

export const DSH_PET_ENGINE = 'dsh-pet'
export const DSH_PET_PACK_ID = 'main'
export const DSH_PET_CATALOG_VERSION = '0.3.8' as const

/** 运行时的唯一目录（配置校验与页面渲染共用）。 */
export const PET_CATALOG: DshPetCatalog = DSH_PET_CATALOG
export const PET_ANIMATION_IDS: readonly string[] = DSH_PET_ANIMATION_IDS

export function isKnownAnimationId(value: unknown): value is string {
  return typeof value === 'string' && DSH_PET_ANIMATION_ID_SET.has(value)
}

/** 动画从哪来；只用于回执/诊断，不进入模型上下文。 */
export type PetAnimationSource =
  | 'say'
  | 'emote'
  | 'act'
  | 'reaction'
  | 'menu'
  | 'system'
  | 'work-status'
  /** 主进程本地随机娱乐通道；不来自模型工具调用。 */
  | 'ambient'

/**
 * 可信请求类别。由宿主调用路径/轮次推导，模型参数不能填写。
 * 旧调用没有 requestClass 时按来源兼容推导，见 `classifyAnimationRequest`。
 */
export type PetRequestClass =
  | 'ambient-random'
  | 'ambient-roam'
  | 'model-semantic'
  | 'model-decorative'
  | 'work-status'
  | 'user-explicit'
  | 'interaction'

/** 普通语义动作的过期时间：迟到的旧回复不再补做动作。 */
export const PET_SEMANTIC_TTL_MS = 30_000

/**
 * 旧请求的兼容分类：
 *  - 明确标了 requestClass 的以它为准；
 *  - autonomous=true 仍是旧的模型自主娱乐通道；
 *  - 工作状态/菜单有固定来源；
 *  - 其余旧显式点播按用户明确点播处理（不做语义节流，保持向后兼容）。
 */
export function classifyAnimationRequest(input: {
  requestClass?: PetRequestClass
  source: PetAnimationSource
  autonomous?: boolean
}): PetRequestClass {
  if (input.requestClass !== undefined) return input.requestClass
  if (input.source === 'work-status') return 'work-status'
  if (input.source === 'menu') return 'user-explicit'
  if (input.source === 'ambient') return 'ambient-random'
  if (input.autonomous === true) return 'model-decorative'
  return 'user-explicit'
}

/** 移动请求的兼容分类；新调用应显式携带 requestClass。 */
export function classifyMovementRequest(input: {
  requestClass?: PetRequestClass
  autonomous: boolean
}): PetRequestClass {
  if (input.requestClass !== undefined) return input.requestClass
  return input.autonomous ? 'model-decorative' : 'user-explicit'
}

/**
 * 「移动」分类的素材名。只有这些动画可以伴随真实位移；
 * 普通点播（pet_act / pet_say.animation / reaction）会被拒绝，必须改用 pet_walk_to。
 */
export const PET_MOVEMENT_ANIMATIONS: readonly string[] = PET_CATALOG.animations.moves.actions.map(
  (move) => move.name
)
export const DEFAULT_PET_MOVEMENT_ANIMATION = PET_MOVEMENT_ANIMATIONS[0] ?? '螃蟹走路'

export function isMovementAnimationId(value: unknown): value is string {
  return typeof value === 'string' && PET_MOVEMENT_ANIMATIONS.includes(value)
}

/** 点播方式：once 播完回到工作状态/静息待机；loop 持续到被打断（分段续播）。 */
export type PetAnimationMode = 'once' | 'loop'

/**
 * 语义上的「左右张望」动作类别。
 *
 * `东张西望` 来自旧 look/turn 与 curious 预设；`工作状态-原地踱步张望` 是
 * waiting 档位的素材。两者在语义上是同一类「张望」，共享冷却与去重，
 * 但移动等待状态本身仍可每轮播放一次，不会无限循环。
 */
export const PET_LOOK_AROUND_ANIMATIONS: readonly string[] = [
  '东张西望',
  '工作状态-原地踱步张望'
]

export function isLookAroundAnimation(animationId: unknown): boolean {
  return typeof animationId === 'string' && PET_LOOK_AROUND_ANIMATIONS.includes(animationId)
}

/**
 * 主进程 → 宠物页的一次显式点播。
 * `requestId` 由主进程生成；页面必须在真实播放/失败/被打断时回执。
 */
export interface PetAnimationRequest {
  requestId: string
  animationId: string
  mode: PetAnimationMode
  source: PetAnimationSource
  /**
   * 由主进程根据可信调用来源推导，模型不能填。
   * true = 自主轮里的可选装饰动作，必须服从待机门槛与冷却；false = 用户明确点播/工作状态。
   */
  autonomous?: boolean
  /**
   * 可信请求类别；决定是否需要空闲门槛、语义 TTL 与随机池校验。
   * 省略时按旧来源兼容推导，避免旧页面/旧测试失效。
   */
  requestClass?: PetRequestClass
  /** 同一条消息/轮次的去重键；只用于语义动作，不含用户正文。 */
  dedupeKey?: string
  /** 墙钟过期时间（epoch ms）；过期请求丢弃，不做迟到补播。 */
  expiresAt?: number
  /** 仅诊断显示，不含用户内容。 */
  label?: string
  createdAt: number
}

/**
 * 回执状态：
 *  - accepted：页面收到并通过目录校验，尚未出画；
 *  - queued：当前动作受保护，请求已进入唯一待播队列，稍后自动开始；
 *  - started：播放器确认 play() 兑现（真实出画）；
 *  - completed：once/loop 的自然结束（loop 被打断则不是 completed）；
 *  - rejected：资格/占用/冷却不满足，或移动素材被错误地当作原地动作；
 *  - interrupted：被新的显式点播、拖拽、状态切换或冻结打断（被替换的排队请求也用它）；
 *  - unsupported：目录里没有该动画/页面不可用；
 *  - failed：素材加载、解码或播放失败。
 *
 * IPC 发送成功不等于动画完成；只有页面播放器能给出 started/completed。
 */
export type PetAnimationReceiptStatus =
  | 'accepted'
  | 'queued'
  | 'started'
  | 'completed'
  | 'rejected'
  | 'interrupted'
  | 'unsupported'
  | 'failed'

export interface PetAnimationReceipt {
  requestId: string
  animationId: string
  status: PetAnimationReceiptStatus
  at: number
  /** 固定枚举/短原因，不含文件路径与用户内容。 */
  reason?: string
}

/** 工具层的动作结果；与动画回执同一口径，便于模型看到 unsupported。 */
export interface PetAnimationOutcome {
  status: PetAnimationReceiptStatus
  animationId: string
  /** 宿主生成的请求 ID；调度器/诊断用它关联迟到回执，不进入模型正文。 */
  requestId?: string
  reason?: string
}

// ---------------------------------------------------------------------------
// 移动（pet_walk_to）
// ---------------------------------------------------------------------------

/**
 * 移动回执状态：
 *  - accepted：已收到，尚未确认开始（页面还没兑现视频）；
 *  - started：所选移动素材已开始播放，坐标驱动真实启动；
 *  - completed：到达有效目标；
 *  - already_at_target：已在目标附近，没有重播动画；
 *  - blocked：当前不允许移动（关闭、拖拽、停靠、面板、菜单等）；
 *  - interrupted：开始后被拖拽/甩抛/新指令/挂起/显示器变化打断；
 *  - failed：页面不可用、素材/解码失败、无效参数或超时。
 *
 * 工具只能声称已确认的阶段；IPC 发送成功不等于已开始或已到达。
 */
export type PetMovementStatus =
  | 'accepted'
  | 'started'
  | 'completed'
  | 'already_at_target'
  | 'blocked'
  | 'interrupted'
  | 'failed'

export interface PetMovementRequest {
  requestId: string
  /** 目标为当前所在显示器工作区的横向比例 0..1（身体中心）。 */
  target: number
  animationId: string
  /** 由可信调用来源推导；true = 自主移动，受最小间隔限制。 */
  autonomous: boolean
  /** 可信类别；本地随机漫游为 ambient-roam，需要额外的占用复核。 */
  requestClass?: PetRequestClass
  /** 模型语义移动的同轮去重键；由主进程推导，模型不能填写。 */
  dedupeKey?: string
  /** 墙钟过期时间（epoch ms）；迟到的语义移动不再执行。 */
  expiresAt?: number
  createdAt: number
}

export interface PetMovementReceipt {
  requestId: string
  animationId: string
  target: number
  status: PetMovementStatus
  at: number
  /** 固定枚举/短原因，不含用户内容。 */
  reason?: string
  /** 回执时身体中心相对当前显示器的比例；已到达/已开始时尽量带上。 */
  xRatio?: number
  facing?: 'left' | 'right'
  /** 当前显示器上身体中心可安全到达的比例范围；用于给模型可信的目标边界。 */
  reachableMinRatio?: number
  reachableMaxRatio?: number
}

export interface PetMovementOutcome {
  status: PetMovementStatus
  animationId: string
  target: number
  /** 宿主生成的请求 ID；供调度器关联回执，不进入模型正文。 */
  requestId?: string
  reason?: string
  xRatio?: number
  facing?: 'left' | 'right'
  reachableMinRatio?: number
  reachableMaxRatio?: number
}

/**
 * 张望类别的页面侧诊断。主进程的策略诊断只覆盖模型入口；
 * 等待状态与用户点播在页面内播放，必须共享同一品类时钟并在此回报。
 */
export interface PetLookAroundState {
  /** 最近一次真实 started 的墙钟时间（epoch ms）。 */
  lastStartedAt: number | null
  lastSource: string | null
  lastAttemptAt: number | null
  lastRejectedSource: string | null
  lastRejectedReason: string | null
  /** 页面本地计算的张望品类冷却截止（epoch ms）；0 表示从未播放。 */
  cooldownUntil: number
}

/**
 * 宠物页 → 主进程的有时间戳占用快照。只含状态与几何，不含正文、窗口标题或用户内容。
 * 主进程只在快照新鲜时调度随机活动；页面在执行前仍会按实时状态复核。
 */
export interface PetPageStateSnapshot {
  /** 页面墙钟时间（epoch ms）；主进程用它判断快照是否过期。 */
  at: number
  ready: boolean
  visible: boolean
  /** 没有任何受保护动作/任务/交互时的安静状态。 */
  idle: boolean
  /** 真实工作状态（思考/工具/等待/完成/失败）存在。 */
  working: boolean
  /** 有非待机循环的动作正在播放。 */
  active: boolean
  pending: boolean
  panelOpen: boolean
  menuOpen: boolean
  dragging: boolean
  throwing: boolean
  perched: boolean
  moving: boolean
  suspended: boolean
  reducedMotion: boolean
  xRatio: number | null
  reachableMinRatio: number | null
  reachableMaxRatio: number | null
  /** 当前显示器工作区宽度（DIP）；未知为 null。 */
  displayWidth: number | null
  /** 宠物画布宽度（DIP）。 */
  size: number
  lookAround: PetLookAroundState
}

/**
 * 引用旧词表的一次解析结果。
 * `approximate` 永远为 true：透明 WebM 没有可独立叠加的表情，任何映射都是近似动作。
 */
export interface LegacyAnimationResolution {
  animationId: string
  from: string
  approximate: true
  /** 同时提供了两个旧词时，未被采用的那个。 */
  ignored?: string
}

/**
 * 旧 expression → 真实存在的 WebM 动作。没有等价素材的词不在此表中，
 * 调用方必须返回 unsupported（不能静默改用待机）。
 */
export const LEGACY_EXPRESSION_ANIMATIONS = {
  neutral: '待机呼吸休闲',
  happy: '点击回应-开心跃动',
  wink: '点击回应-害羞惊讶',
  love: '点击回应-害羞惊讶',
  shy: '点击回应-害羞惊讶',
  surprised: '被吓一跳',
  angry: '点击回应-傲娇生气',
  sad: '工作状态-垂头叹气冒汗',
  sleepy: '哈欠连天',
  thinking: '工作状态-思考冒泡',
  smug: '点击回应-傲娇生气',
  pout: '点击回应-傲娇生气',
  worried: '工作状态-原地踱步张望',
  determined: '轻快记录',
  flustered: '点击回应-害羞惊讶',
  scared: '被吓一跳',
  excited: '点击回应-开心跃动',
  cry: '工作状态-垂头叹气冒汗',
  confused: '工作状态-思考冒泡'
} as const satisfies Readonly<Record<string, string>>

/** 旧词表类型只服务于迁移期解析；生产代码应使用动画目录。 */
export type LegacyExpression = keyof typeof LEGACY_EXPRESSION_ANIMATIONS

/** 旧 motion → 真实 WebM。walk/run 点播会走真实位移（控制器按移动素材处理）。 */
export const LEGACY_MOTION_ANIMATIONS = {
  stand: '待机呼吸休闲',
  jump: '点击回应-开心跃动',
  hop: '点击回应-开心跃动',
  look: '东张西望',
  turn: '东张西望',
  nod: '女仆屈膝礼仪',
  shake: '被吓一跳',
  spin: '小幅度原地360度旋转展示',
  sit: '原地小憩沉眠',
  sleep: '原地小憩沉眠',
  dizzy: '工作状态-垂头叹气冒汗',
  walk: '螃蟹走路',
  run: '原地左转奔跑',
  wave: '点击回应-元气挥手',
  bow: '女仆屈膝礼仪',
  shiver: '被吓一跳',
  flap: '点击回应-元气挥手',
  dance: '可爱宅舞'
} as const satisfies Readonly<Record<string, string>>

export type LegacyMotion = keyof typeof LEGACY_MOTION_ANIMATIONS

/** 业务预设 → 目录动画（旧 pet_emote 的兼容回退；明确为近似）。 */
export const PET_PRESET_ANIMATIONS: Readonly<Record<string, string>> = {
  focus: '轻快记录',
  rest: '原地小憩沉眠',
  late: '哈欠连天',
  'welcome-back': '点击回应-元气挥手',
  curious: '东张西望',
  quiet: '待机呼吸休闲'
}

/**
 * 解析旧 expression/motion。优先 motion（动作比表情更可观察），另一个作为 ignored 标注。
 * 返回 null 表示没有任何可兑现的素材——调用方必须返回 unsupported。
 */
export function resolveLegacyAnimation(input: {
  expression?: string | undefined
  motion?: string | undefined
}): LegacyAnimationResolution | null {
  // 工具参数允许任意字符串；这里按普通字典查找，未知词自然得到 undefined。
  const motionTable: Readonly<Record<string, string>> = LEGACY_MOTION_ANIMATIONS
  const expressionTable: Readonly<Record<string, string>> = LEGACY_EXPRESSION_ANIMATIONS
  const motion = typeof input.motion === 'string' ? motionTable[input.motion] : undefined
  const expression =
    typeof input.expression === 'string' ? expressionTable[input.expression] : undefined
  if (motion !== undefined) {
    return {
      animationId: motion,
      from: `motion:${input.motion ?? ''}`,
      approximate: true,
      ...(expression !== undefined && input.expression !== undefined
        ? { ignored: `expression:${input.expression}` }
        : {})
    }
  }
  if (expression !== undefined) {
    return {
      animationId: expression,
      from: `expression:${input.expression ?? ''}`,
      approximate: true
    }
  }
  return null
}

/** 旧 preset 的兼容回退；未知 preset 返回 null。 */
export function resolvePresetAnimation(preset: string): string | null {
  return PET_PRESET_ANIMATIONS[preset] ?? null
}

/**
 * 应用内部相位 → 上游工作状态。显式、可测试；不把普通回答误判成 result。
 *
 * - tool 只在工具真实执行期间出现；
 * - helper 是 CUA 子任务，执行中归 working，否则 waiting；
 * - done/failed 是终态，只播一次；
 * - idle 永远返回 null，不伪造忙碌。
 */
export function petPhaseToWorkStatus(
  petPhase: string,
  options: { cuaActive?: boolean } = {}
): WorkStatusState | null {
  switch (petPhase) {
    case 'thinking':
      return 'thinking'
    case 'tool':
      return 'working'
    case 'result':
      return 'result'
    case 'helper':
      return options.cuaActive === true ? 'working' : 'waiting'
    case 'waiting':
    case 'asking':
    case 'queued':
      return 'waiting'
    case 'done':
      return 'success'
    case 'failed':
      return 'error'
    default:
      return null
  }
}

export function isTerminalWorkStatus(state: WorkStatusState | null): boolean {
  return state === 'success' || state === 'error'
}

/** 目录中某个工作状态档位的候选动画；索引语义与上游严格一致。 */
export function workStatusPool(state: WorkStatusState): string[] {
  const pool = PET_CATALOG.animations.events['workStatus'] ?? []
  const slot = pool[workStatusIndex(state)]
  if (slot === undefined) return []
  return typeof slot === 'string' ? [slot] : [...slot]
}

function workStatusIndex(state: WorkStatusState): number {
  switch (state) {
    case 'thinking':
      return 0
    case 'working':
      return 1
    case 'result':
      return 2
    case 'waiting':
      return 3
    case 'success':
      return 4
    case 'error':
      return 5
  }
}

/** 兼容旧调用：sanitize 后仍未识别时返回 null，而不是丢给页面猜。 */
export function normalizeAnimationId(value: unknown): string | null {
  return isKnownAnimationId(value) ? value : null
}
