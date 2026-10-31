/**
 * dsh-pet 表现层共享类型（锁定 commit: 2fa04a51）。
 *
 * 这里的结构由上游 `src/shared/types.ts` 裁剪而来，只保留运行时真正消费的
 * animations / weights / physics / workStatus 字段；素材目录由
 * `catalog.generated.ts` 提供（从 vendor 默认配置生成并校验）。
 */

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** 轴对齐矩形（左上角 + 宽高）。显示器工作区、窗口内容区、可视夹取区共用同一形状。 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface PhysicsParams {
  gravity: number
  restitution: number
  groundFriction: number
  ceilingBounce: boolean
  throwPower: number
  petCollision: boolean
}

export interface Weights {
  idle: number
  turn: number
  move: number
}

export interface MoveParams {
  minDist: number
  maxDist: number
  margin: number
  leadSec: number
  tailSec: number
}

export interface MoveSpec {
  name: string
  params?: Partial<MoveParams>
}

export interface MovesConfig {
  default: MoveParams
  actions: MoveSpec[]
}

export interface Category {
  id: string
  weight: number
  noMirror?: boolean
  actions: string[]
}

/** 事件档位槽位：单个动画名（固定播放）或候选数组（档内随机抽 1）。 */
export type EventSlot = string | string[]

/** 事件名 → 档位槽位数组。workStatus 的索引语义固定为 0..5。 */
export type Events = Record<string, EventSlot[]>

export interface Animations {
  idle: string[]
  turn: string[]
  drag: string[]
  clicks: string[]
  moves: MovesConfig
  categories: Category[]
  events: Events
}

export interface DshPetCatalog {
  /** 素材包 id（默认角色为 main）。 */
  packId: string
  /** 展示名，仅用于诊断/设置说明。 */
  name: string
  /** 上游默认尺寸（视频画布 CSS 宽度）。 */
  baseSize: number
  animations: Animations
  weights: Weights
  physics: PhysicsParams
}
