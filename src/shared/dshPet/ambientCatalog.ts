/**
 * 桌宠随机/语义动作的独立产品标签层。
 *
 * 素材目录仍以 `catalog.generated.ts` 为唯一事实来源；这里不新增、不猜测任何
 * 资源名，只回答：
 *  - 哪些动作适合本地随机娱乐（排除待机、张望、拖拽、点击、移动、余额、
 *    工作状态和依赖发言的专用事件动作）；
 *  - 哪些动作适合按场景提供给模型做语义选择；
 *  - 给定可注入 RNG 时，如何用洗牌袋 + 近期去重保持多样性。
 *
 * 不依赖 Electron/DOM，主进程、宠物页与单元测试共用。
 */

import {
  PET_ANIMATION_IDS,
  PET_CATALOG,
  PET_LOOK_AROUND_ANIMATIONS,
  PET_MOVEMENT_ANIMATIONS,
  isKnownAnimationId
} from '../petPresentation'

/** 默认随机娱乐来源分类。季节/节日与含文字动作默认不随机播放。 */
export const AMBIENT_CATEGORY_IDS = ['小动作', '玩耍', '吃什么'] as const
export const AMBIENT_SEASONAL_CATEGORY_IDS = ['时节', '文字'] as const

export interface AmbientCandidate {
  id: string
  category: string
  /** true = 只在明确配置/语境下启用，默认不进随机池。 */
  seasonal: boolean
}

const IDLE = new Set(PET_CATALOG.animations.idle)
const TURN = new Set(PET_CATALOG.animations.turn)
const DRAG = new Set(PET_CATALOG.animations.drag)
const CLICKS = new Set(PET_CATALOG.animations.clicks)
const MOVES = new Set(PET_MOVEMENT_ANIMATIONS)
const LOOK_AROUND = new Set(PET_LOOK_AROUND_ANIMATIONS)

/** 事件资源（余额/碎碎念/工作状态）不能伪装成随机娱乐或真实工作。 */
const EVENT_ACTIONS = new Set<string>()
for (const slots of Object.values(PET_CATALOG.animations.events)) {
  for (const slot of slots) {
    if (typeof slot === 'string') EVENT_ACTIONS.add(slot)
    else for (const name of slot) EVENT_ACTIONS.add(name)
  }
}

/** 固定排除原因；控制器与调度器都用它做最后一道校验。 */
export function ambientExclusionReason(animationId: string): string | null {
  if (!isKnownAnimationId(animationId)) return 'unknown-animation'
  if (LOOK_AROUND.has(animationId)) return 'look-around'
  if (MOVES.has(animationId)) return 'movement'
  if (IDLE.has(animationId)) return 'idle'
  if (TURN.has(animationId)) return 'turn'
  if (DRAG.has(animationId)) return 'drag'
  if (CLICKS.has(animationId)) return 'click-response'
  if (EVENT_ACTIONS.has(animationId)) return 'event-resource'
  return null
}

export const AMBIENT_CANDIDATES: readonly AmbientCandidate[] = PET_CATALOG.animations.categories.flatMap(
  (category) =>
    category.actions.map((id) => ({
      id,
      category: category.id,
      seasonal: !(AMBIENT_CATEGORY_IDS as readonly string[]).includes(category.id)
    }))
)

/** 默认随机动作池：只包含普通原地娱乐动作，不包含任何固定排除分类。 */
export const DEFAULT_AMBIENT_POOL: readonly string[] = AMBIENT_CANDIDATES.filter(
  (candidate) => !candidate.seasonal && ambientExclusionReason(candidate.id) === null
).map((candidate) => candidate.id)

export function isAmbientEligibleAnimation(animationId: unknown): boolean {
  return (
    typeof animationId === 'string' &&
    DEFAULT_AMBIENT_POOL.includes(animationId) &&
    ambientExclusionReason(animationId) === null
  )
}

/** 诊断用：池大小与固定排除分类，不暴露用户内容。 */
export function ambientPoolDiagnostics(): {
  categoryIds: readonly string[]
  seasonalCategoryIds: readonly string[]
  candidates: number
  pool: number
  excluded: Record<string, number>
} {
  const excluded: Record<string, number> = {}
  for (const id of PET_ANIMATION_IDS) {
    const reason = ambientExclusionReason(id)
    if (reason !== null) excluded[reason] = (excluded[reason] ?? 0) + 1
  }
  return {
    categoryIds: [...AMBIENT_CATEGORY_IDS],
    seasonalCategoryIds: [...AMBIENT_SEASONAL_CATEGORY_IDS],
    candidates: AMBIENT_CANDIDATES.length,
    pool: DEFAULT_AMBIENT_POOL.length,
    excluded
  }
}

/**
 * 洗牌袋选择器：每轮候选不重复，跨轮避免最近播放过的素材；
 * 候选为空时返回 null（调用方必须回待机，不能忙循环或回退张望）。
 */
export class AmbientActionPicker {
  private readonly candidates: readonly string[]
  private readonly random: () => number
  private readonly recentLimit: number
  private readonly recent: string[] = []
  private bag: string[] = []
  private lastPicked: string | null = null

  constructor(options: {
    candidates?: readonly string[]
    random?: () => number
    recentLimit?: number
  } = {}) {
    this.candidates = options.candidates ?? DEFAULT_AMBIENT_POOL
    this.random = options.random ?? Math.random
    this.recentLimit = Math.max(1, options.recentLimit ?? Math.min(12, this.candidates.length - 1))
  }

  /** 抽取一个候选；excluded 由调用方提供（隔离中的失败素材等）。 */
  pick(excluded?: ReadonlySet<string>): string | null {
    // 洗牌袋可能是在隔离发生前装的；排掉多个坏素材后仍需继续找，
    // 不能只试两轮就误报空池。袋子耗尽且补充后仍为空才返回 null。
    for (;;) {
      if (this.bag.length === 0) this.refill(excluded)
      if (this.bag.length === 0) return null
      const id = this.bag.pop()
      if (id === undefined) return null
      if (excluded?.has(id) === true) continue
      this.lastPicked = id
      return id
    }
  }

  /** 随机通道真正 started 后记录；后续洗牌袋会尽量避开。 */
  notePlayed(animationId: string): void {
    this.remember(animationId)
    this.bag = this.bag.filter((id) => id !== animationId)
  }

  /** 模型/用户刚播放过的同素材也进入近期记录，避免紧接着随机重播。 */
  noteForegroundPlayed(animationId: string): void {
    if (!this.candidates.includes(animationId)) return
    this.remember(animationId)
    this.bag = this.bag.filter((id) => id !== animationId)
  }

  diagnostics(): {
    candidates: number
    bagRemaining: number
    recent: string[]
    lastPicked: string | null
  } {
    return {
      candidates: this.candidates.length,
      bagRemaining: this.bag.length,
      recent: [...this.recent],
      lastPicked: this.lastPicked
    }
  }

  private remember(animationId: string): void {
    const index = this.recent.indexOf(animationId)
    if (index >= 0) this.recent.splice(index, 1)
    this.recent.push(animationId)
    while (this.recent.length > this.recentLimit) this.recent.shift()
  }

  private refill(excluded?: ReadonlySet<string>): void {
    const available = this.candidates.filter((id) => excluded?.has(id) !== true)
    if (available.length === 0) return
    const fresh = available.filter((id) => !this.recent.includes(id))
    // 近期素材只在候选太少、全避开会没有选择时才放回，避免池被锁死。
    const pool = fresh.length >= Math.min(3, available.length) ? fresh : available
    const shuffled = [...pool]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(this.random() * (index + 1))
      const value = shuffled[index]!
      shuffled[index] = shuffled[swap]!
      shuffled[swap] = value
    }
    // bag 从尾部弹出；保证上一段不会成为下一次的第一个。
    if (shuffled.length > 1 && shuffled[shuffled.length - 1] === this.lastPicked) {
      shuffled[shuffled.length - 1] = shuffled[0]!
      shuffled[0] = this.lastPicked
    }
    this.bag = shuffled
  }
}

// ---------------------------------------------------------------------------
// 语义动作目录（供模型按场景选择，不做关键词触发器）
// ---------------------------------------------------------------------------

export interface SemanticSceneGroup {
  id: string
  label: string
  actions: readonly string[]
}

function categoryActions(categoryId: string): string[] {
  return (
    PET_CATALOG.animations.categories.find((category) => category.id === categoryId)?.actions ?? []
  )
}

const CLICK_MOOD_ACTIONS = [
  '点击回应-开心跃动',
  '点击回应-害羞惊讶',
  '点击回应-傲娇生气',
  '点击回应-元气挥手'
].filter((id) => isKnownAnimationId(id))

const REST_ACTIONS = [
  '超大伸懒腰',
  '哈欠连天',
  '原地小憩沉眠',
  '打瞌睡被惊醒',
  '摇扇纳凉',
  '晨间刷牙',
  '悠闲哼歌'
].filter((id) => isKnownAnimationId(id))

const FOCUS_ACTIONS = ['轻快记录', '写代码'].filter((id) => isKnownAnimationId(id))

const PLAY_HIGHLIGHTS = [
  '原地专心玩魔方',
  '撸猫',
  '小提琴演奏',
  '吹笛子',
  '下五子棋',
  '踢毽子',
  '三球抛接',
  '荡秋千',
  '放风筝',
  '可爱宅舞',
  '轻快摇摆舞'
].filter((id) => isKnownAnimationId(id))

const DAILY_HIGHLIGHTS = [
  '照镜子',
  '整体换装试色',
  '女仆屈膝礼仪',
  '偷吃零食被抓住',
  '原地重力下蹲压缩',
  '小幅度原地360度旋转展示'
].filter((id) => isKnownAnimationId(id))

/**
 * 场景分组：同一素材只出现一次；未列出的目录动作仍可在知道精确名称时使用。
 * 这里只描述能力与语境，不声称素材真的执行了现实动作。
 */
export const SEMANTIC_SCENE_GROUPS: readonly SemanticSceneGroup[] = [
  { id: 'rest', label: '放松/疲惫/休息', actions: REST_ACTIONS },
  { id: 'eat', label: '吃东西/用餐话题', actions: categoryActions('吃什么') },
  { id: 'play', label: '玩耍/兴趣', actions: PLAY_HIGHLIGHTS },
  { id: 'focus', label: '记录/专注/写东西', actions: FOCUS_ACTIONS },
  { id: 'daily', label: '日常小动作', actions: DAILY_HIGHLIGHTS },
  { id: 'mood', label: '情绪回应（近似表情）', actions: CLICK_MOOD_ACTIONS },
  {
    id: 'play-more',
    label: '更多玩耍',
    actions: categoryActions('玩耍').filter((id) => !PLAY_HIGHLIGHTS.includes(id))
  },
  {
    id: 'daily-more',
    label: '更多日常',
    actions: categoryActions('小动作').filter(
      (id) => !REST_ACTIONS.includes(id) && !FOCUS_ACTIONS.includes(id) && !DAILY_HIGHLIGHTS.includes(id)
    )
  },
  {
    id: 'season',
    label: '季节/节日（只在语境相符时，不用于随机）',
    actions: categoryActions('时节')
  }
].filter((group) => group.actions.length > 0)

/** 供 `{{animations}}` 使用的紧凑场景目录；不是一串无结构文件名。 */
export function semanticGuideText(): string {
  return SEMANTIC_SCENE_GROUPS.map(
    (group) => `- ${group.label}：${group.actions.join('、')}`
  ).join('\n')
}

// ---------------------------------------------------------------------------
// 随机移动目标
// ---------------------------------------------------------------------------

export interface RoamTargetInput {
  xRatio: number
  reachableMinRatio: number
  reachableMaxRatio: number
  /** 当前显示器工作区宽度（DIP）。 */
  displayWidth: number
  /** 宠物画布宽度（DIP）；用于把素材默认距离换算到当前尺寸。 */
  size?: number
  /** 所选移动素材的目录参数（基础尺寸 462）。 */
  params?: { minDist?: number; maxDist?: number }
  random?: () => number
  /** 目标可见距离下限/上限（DIP）。 */
  minDistanceDip?: number
  maxDistanceDip?: number
}

export interface RoamTarget {
  targetRatio: number
  distanceDip: number
  direction: 'left' | 'right'
}

/**
 * 在当前显示器可达范围内选一个 60–240 DIP 的短程目标；
 * 靠近边缘时优先往内侧走，避免反复抽到当前点或一直撞边。
 */
export function pickRoamTarget(input: RoamTargetInput): RoamTarget | null {
  const width = input.displayWidth
  if (!Number.isFinite(width) || width <= 0) return null
  const minRatio = clamp01(Math.min(input.reachableMinRatio, input.reachableMaxRatio))
  const maxRatio = clamp01(Math.max(input.reachableMinRatio, input.reachableMaxRatio))
  if (maxRatio - minRatio < 0.0001) return null
  const current = Math.min(maxRatio, Math.max(minRatio, clamp01(input.xRatio)))
  const random = input.random ?? Math.random
  const scale = Math.max(0.2, Math.min(4, (input.size ?? 462) / 462))
  const baseMin = input.params?.minDist ?? PET_CATALOG.animations.moves.default.minDist
  const baseMax = input.params?.maxDist ?? PET_CATALOG.animations.moves.default.maxDist
  const minDistance = Math.min(240, Math.max(60, baseMin * scale))
  const maxDistance = Math.max(
    minDistance,
    Math.min(240, Math.max(60, baseMax * scale))
  )
  const leftCapacity = (current - minRatio) * width
  const rightCapacity = (maxRatio - current) * width
  const edgeBand = (maxRatio - minRatio) * 0.18
  const preferRight =
    current - minRatio < edgeBand
      ? true
      : maxRatio - current < edgeBand
        ? false
        : random() < 0.5
  const order: Array<'left' | 'right'> = preferRight ? ['right', 'left'] : ['left', 'right']
  // 任何随机走动都必须产生 60 DIP 以上的实际位移；空间不足就交给调度器
  // 当作一次 no-op/重采样，而不是贴着边缘挪 20–50 DIP 假装走动。
  const minRoamDip = 60
  for (const direction of order) {
    const capacity = direction === 'right' ? rightCapacity : leftCapacity
    if (capacity < minRoamDip) continue
    const upper = Math.min(maxDistance, capacity)
    const lower = Math.min(minDistance, upper)
    const distance = lower + random() * Math.max(0, upper - lower)
    const signed = direction === 'right' ? distance : -distance
    const targetRatio = Math.min(maxRatio, Math.max(minRatio, current + signed / width))
    const actual = Math.abs(targetRatio - current) * width
    if (actual + 1e-6 < minRoamDip) continue
    return { targetRatio, distanceDip: actual, direction }
  }
  return null
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
