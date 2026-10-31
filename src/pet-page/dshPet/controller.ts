import type {
  PetAgentStatusView,
  PetAnimationReceipt,
  PetAnimationRequest,
  PetAnimationReceiptStatus,
  PetDisplayView,
  PetMovementView
} from '../../shared/ipc'
import type {
  PetIdleActionsConfig,
  PetRandomIdleConfig,
  PetSemanticConfig
} from '../../shared/config'
import {
  DEFAULT_PET_MOVEMENT_ANIMATION,
  classifyAnimationRequest,
  classifyMovementRequest,
  isKnownAnimationId,
  isLookAroundAnimation,
  isMovementAnimationId,
  isTerminalWorkStatus,
  petPhaseToWorkStatus,
  type PetLookAroundState,
  type PetMovementReceipt,
  type PetMovementRequest,
  type PetMovementStatus,
  type PetPageStateSnapshot,
  type PetRequestClass,
  type WorkStatusState
} from '../../shared/petPresentation'
import { isAmbientEligibleAnimation } from '../../shared/dshPet/ambientCatalog'
import { isNoMirrorAnimation } from '../../shared/dshPet/menu'
import { pickSlot } from '../../shared/dshPet/pickers'
import type { Animations, MoveParams, PhysicsParams } from '../../shared/dshPet/types'
import {
  DEFAULT_THROW_POWER,
  SQ_SOFT_SPEED,
  SQ_SQUASH,
  estimateReleaseVelocity,
  landingSquash,
  pullAngle,
  slingshotPower,
  slingshotVelocity,
  springStep,
  throwSpace,
  throwStepRegion,
  throwSubsteps,
  type DragSample,
  type ThrowSpace,
  type ThrowState
} from '../../shared/dshPet/physics'
import {
  bodyCenter,
  clampBodyToDisplays,
  displayForBody,
  displayIndexForBody,
  displayRects,
  nearestLegalBody,
  primaryDisplay,
  type BodyBox,
  type PetMetrics
} from '../../shared/dshPet/layout'
import type { PetActorView } from './view'

/**
 * 唯一调度权。
 *
 * 连续性规则（高 → 低）：
 *  1. 用户拖拽/甩抛（独占位移，立即打断）
 *  2. 当前一次性动作播到自然边界；新的显式点播最多排队一个
 *  3. 最新工作状态（到达边界后显示，绝不回放过期的思考/工具/完成）
 *  4. 点击反馈（播完恢复上层状态）
 *  5. 满足空闲门槛和冷却的模型自主娱乐动作（不允许打断正在播放的动作）
 *  6. 待机循环（默认且唯一的自动基线）
 *
 * 本地随机小动作/走动的计时与候选选择只在主进程 AmbientScheduler 中；
 * 页面不另设定时器，只对每个请求复核实时占用、目录资格和冷却并返回准确回执。
 * 语义动作则由模型在同一轮对话/行为中通过既有工具提出，同样经过本控制器。
 *
 * 所有播放都带实例 token；迟到的 ended/error 回调不能影响新的播放。
 */

export type ActiveMode = 'idle-loop' | 'move' | 'work' | 'explicit' | 'menu' | 'drag' | 'click'

interface ActiveAnimation {
  mode: ActiveMode
  animationId: string
  request?: PetAnimationRequest
  /** 播放实例 token；play() 尚未返回时为 null。 */
  token: number | null
  /**
   * 与当前显式动作完全同动画、同模式的合并请求。它们已经收到 started，
   * 需要在自然结束/失败/被替换时收到同样确定的结果。
   */
  coalesced?: PetAnimationRequest[]
  /** 工作状态分段对应的期望状态，便于诊断。 */
  workState?: WorkStatusState
  /** 看门狗已尝试恢复自动暂停的次数，避免无限续播。 */
  watchdogChecks?: number
  watchdogResumed?: boolean
}

interface PendingAction {
  request: PetAnimationRequest
  /** 同动画、同模式的合并请求；不额外占用队列名额。 */
  aliases: PetAnimationRequest[]
  since: number
  timer: number
}

interface MoveRun {
  animationId: string
  /** 工具 move 请求；右键菜单的原地调用为 null（不产生工具回执）。 */
  request: PetMovementRequest | null
  startX: number
  targetX: number
  y: number
  startedAt: number
  leadSec: number
  tailSec: number
  /** 长距离循环播放移动素材；短距离仍按单段视频 lead/tail 驱动。 */
  loop: boolean
  /** 循环模式的恒定速度（像素/秒）。 */
  speedPxPerSec: number
  startedReported: boolean
}

export interface ControllerSettings {
  animations: Animations
  physics: PhysicsParams
  idleActions: PetIdleActionsConfig
  randomIdle: PetRandomIdleConfig
  semantic: PetSemanticConfig
  reducedMotion: boolean
  movement: PetMovementView
  confineToScreen: boolean
  /** 主进程已知的张望品类冷却截止（墙钟 epoch ms）；重载后不额外重置。 */
  lookAroundCooldownUntil: number
  /** 视频画布 CSS 宽度；改尺寸也在控制器内完成，避免两处各自缩放。 */
  size: number
}

export interface ControllerCallbacks {
  reportReceipt: (receipt: PetAnimationReceipt) => void
  reportMovement: (receipt: PetMovementReceipt) => void
  /** 位置稳定（走完/放下/落地/停靠跟随）后回调；运行时会防抖保存。 */
  onSettled: (body: BodyBox, facing: 'left' | 'right') => void
  onStateChange?: () => void
  /** 单调时钟：待播队列 TTL/看门狗。 */
  now?: () => number
  /** 墙钟：请求过期、语义节流与张望品类冷却；测试可注入。 */
  wallNow?: () => number
}

export interface ControllerOptions extends Omit<ControllerSettings, 'size'> {
  /** 缺省时从 view 的 metrics 读取（测试可直接给 view 尺寸）。 */
  size?: number
  view: PetActorView
  displays: PetDisplayView[]
  callbacks: ControllerCallbacks
}

const DRAG_SLING_MS = 200
const CLICK_MIN_MS = 0
/** 排队动作的生命周期；过期必须给出确定结果，不能永久挂着。 */
const PENDING_TTL_MS = 30_000
/** 张望品类的最小间隔：所有自动/模型通道共享，用户明确点播除外。 */
const LOOK_AROUND_CATEGORY_COOLDOWN_MS = 15 * 60_000
/** 语义去重键只保留最近若干条，避免长期运行无限增长。 */
const SEMANTIC_DEDUPE_LIMIT = 128

export class PetController {
  private readonly view: PetActorView
  private readonly callbacks: ControllerCallbacks
  private settings: ControllerSettings
  private displays: PetDisplayView[]
  private readonly now: () => number
  private readonly wallNow: () => number
  /** 点击回应按点击次数轮换，不跨分类随机。 */
  private clickIndex = 0
  private readonly playedErrorTurns = new Set<string>()

  private active: ActiveAnimation | null = null
  private workStatus: WorkStatusState | null = null
  /** 工作状态对应的可信入口；自主轮自身的思考/工具相位不能阻断自主动作。 */
  private workStatusSource: PetAgentStatusView['source'] = null
  private workRound = 0
  /** 已经播放过的终态事件键；新回合换了键才允许再播。 */
  private terminalPlayedKey: string | null = null
  /** waiting 每次从其它状态进入时算一个新事件；只播一次该事件。 */
  private waitingEventSeq = 0
  private waitingPlayedSeq = 0
  private explicit: PetAnimationRequest | null = null
  private faulted = false
  private failedAnimation: string | null = null

  private dragging = false
  private throwing = false
  private bound = false
  private suspended = false
  private panelOpen = false
  private menuOpen = false
  /** 当前 error 工作状态对应的可信 turnId；只用于避免重复播放同一失败。 */
  private errorTurnKey: string | null = null
  /** 唯一待播队列；拖拽/正在播放的一次性动作期间到达的显式点播。 */
  private pending: PendingAction | null = null
  /** 当前播放实例的看门狗（后台标签页暂停/ended 丢失时保证队列前进）。 */
  private segmentWatchdog = 0

  /** 语义动作按 message/turn 去重；只保存短哈希/固定键，不保存正文。 */
  private readonly semanticDedupe = new Set<string>()
  private lastSemanticStartAt = 0
  private lastSemanticAcceptAt = 0
  /** 页面侧张望品类时钟；与主进程策略共享 15 分钟下限，重载时由设置事件校准。 */
  private lookAroundCooldownUntil = 0
  private readonly lookAround: PetLookAroundState = {
    lastStartedAt: null,
    lastSource: null,
    lastAttemptAt: null,
    lastRejectedSource: null,
    lastRejectedReason: null,
    // 冷却截止单独保存在 `lookAroundCooldownUntil`；快照时合并，避免两份时钟走偏。
    cooldownUntil: 0
  }

  private moveRun: MoveRun | null = null
  private moveFrame = 0

  private dragTarget: BodyBox | null = null
  private dragFrame = 0
  private dragVelocity = { vx: 0, vy: 0 }
  private lastPressAt = 0
  private pressAnchor: { x: number; y: number } | null = null
  private dragSling = false
  private dragTrail: DragSample[] = []

  private throwFrame = 0
  private throwState: ThrowState | null = null
  private throwSpaceValue: ThrowSpace | null = null

  private destroyed = false

  constructor(options: ControllerOptions) {
    this.view = options.view
    this.callbacks = options.callbacks
    this.settings = {
      animations: options.animations,
      physics: options.physics,
      idleActions: options.idleActions,
      randomIdle: options.randomIdle,
      semantic: options.semantic,
      reducedMotion: options.reducedMotion,
      movement: options.movement,
      confineToScreen: options.confineToScreen,
      lookAroundCooldownUntil: options.lookAroundCooldownUntil,
      size: options.size ?? options.view.getMetrics().size
    }
    this.displays = options.displays
    this.now = options.callbacks.now ?? (() => performance.now())
    this.wallNow = options.callbacks.wallNow ?? (() => Date.now())
    this.lookAroundCooldownUntil = Math.max(0, options.lookAroundCooldownUntil)

    this.view.setPlayerCallbacks({
      onEnded: (id, token) => this.handleEnded(id, token),
      onRuntimeError: (id, reason, token) => this.handleRuntimeError(id, reason, token)
    })
  }

  // ---------------------------------------------------------------- 生命周期

  start(): void {
    this.ensureAnimation()
  }

  destroy(): void {
    this.stopMove('destroyed')
    this.destroyed = true
    this.clearSegmentWatchdog()
    this.closeActiveExplicit('destroyed')
    this.dropPending('destroyed')
    this.stopDragFollow()
    this.stopThrow()
    if (this.moveFrame !== 0) cancelAnimationFrame(this.moveFrame)
    this.moveFrame = 0
    this.view.destroy()
  }

  // ---------------------------------------------------------------- 读取

  body(): BodyBox {
    return this.view.getBody()
  }

  metrics(): PetMetrics {
    return this.view.getMetrics()
  }

  facing(): 'left' | 'right' {
    return this.view.getFacing()
  }

  /** 当前显示器上的可信位置与可到达范围；供主进程提示词使用。 */
  movementCapability(): {
    xRatio: number
    facing: 'left' | 'right'
    reachableMinRatio: number
    reachableMaxRatio: number
    displayWidth: number
    size: number
  } | null {
    const display = displayForBody(this.displays, this.body()) ?? primaryDisplay(this.displays)
    if (display === null || display.width <= 0) return null
    const metrics = this.metrics()
    const inset = (metrics.halfW - metrics.sideAllow) / display.width
    return {
      xRatio: this.bodyXRatio(),
      facing: this.view.getFacing(),
      reachableMinRatio: clamp(inset, 0, 1),
      reachableMaxRatio: clamp(1 - inset, 0, 1),
      displayWidth: display.width,
      size: metrics.size
    }
  }

  isDragging(): boolean {
    return this.dragging
  }

  isThrowing(): boolean {
    return this.throwing
  }

  isBound(): boolean {
    return this.bound
  }

  activeAnimationId(): string | null {
    return this.active?.animationId ?? null
  }

  workState(): WorkStatusState | null {
    return this.workStatus
  }

  debugState(): {
    mode: ActiveMode | null
    animationId: string | null
    workStatus: WorkStatusState | null
    dragging: boolean
    throwing: boolean
    bound: boolean
    suspended: boolean
    menuOpen: boolean
    faulted: boolean
    failedAnimation: string | null
    explicitRequestId: string | null
    pendingRequestId: string | null
    pendingAnimationId: string | null
    playbackToken: number | null
    waitingEventSeq: number
    waitingPlayedSeq: number
    moving: boolean
  } {
    return {
      mode: this.active?.mode ?? null,
      animationId: this.active?.animationId ?? null,
      workStatus: this.workStatus,
      dragging: this.dragging,
      throwing: this.throwing,
      bound: this.bound,
      suspended: this.suspended,
      menuOpen: this.menuOpen,
      faulted: this.faulted,
      failedAnimation: this.failedAnimation,
      explicitRequestId: this.explicit?.requestId ?? null,
      pendingRequestId: this.pending?.request.requestId ?? null,
      pendingAnimationId: this.pending?.request.animationId ?? null,
      playbackToken: this.active?.token ?? null,
      waitingEventSeq: this.waitingEventSeq,
      waitingPlayedSeq: this.waitingPlayedSeq,
      moving: this.moveRun !== null
    }
  }

  /**
   * 主进程调度用的实时快照。只含占用/几何/固定原因，不含正文或窗口内容。
   * 主进程不会据此直接播放：每次请求到达后，控制器仍会用同一份实时状态复核。
   */
  pageState(input: { ready: boolean; visible: boolean }): PetPageStateSnapshot {
    const capability = this.movementCapability()
    const active = this.active
    const activeNonIdle = active !== null && active.mode !== 'idle-loop'
    const idle =
      !activeNonIdle &&
      this.workStatus === null &&
      this.explicit === null &&
      this.pending === null &&
      this.moveRun === null &&
      !this.dragging &&
      !this.throwing &&
      !this.suspended &&
      !this.menuOpen &&
      !this.panelOpen
    return {
      at: this.wallNow(),
      ready: input.ready,
      visible: input.visible,
      idle,
      working: this.workStatus !== null,
      active: activeNonIdle,
      pending: this.pending !== null,
      panelOpen: this.panelOpen,
      menuOpen: this.menuOpen,
      dragging: this.dragging,
      throwing: this.throwing,
      perched: this.bound,
      moving: this.moveRun !== null,
      suspended: this.suspended,
      reducedMotion: this.settings.reducedMotion,
      xRatio: capability?.xRatio ?? null,
      reachableMinRatio: capability?.reachableMinRatio ?? null,
      reachableMaxRatio: capability?.reachableMaxRatio ?? null,
      displayWidth: capability?.displayWidth ?? null,
      size: this.metrics().size,
      lookAround: this.lookAroundSnapshot()
    }
  }

  lookAroundState(): PetLookAroundState {
    return this.lookAroundSnapshot()
  }

  private lookAroundSnapshot(): PetLookAroundState {
    return { ...this.lookAround, cooldownUntil: this.lookAroundCooldownUntil }
  }

  /** 外部按钮“回到初始位置”：停止一切位移并直接落位。 */
  goTo(body: BodyBox): void {
    if (this.destroyed) return
    this.bound = false
    this.dragging = false
    this.view.setDragging(false)
    this.stopDragFollow()
    this.stopThrow()
    this.stopMove('reset')
    this.dropPending('reset')
    this.setBody(clampBodyToDisplays(body, this.displays, this.metrics()))
    this.persist()
    this.ensureAnimation()
  }

  // ---------------------------------------------------------------- 设置/状态

  setDisplays(displays: PetDisplayView[]): void {
    this.displays = displays
    if (this.throwing) {
      this.stopThrow()
      this.throwing = false
      this.setBody(clampBodyToDisplays(this.body(), displays, this.metrics()))
      this.persist()
      this.ensureAnimation()
      return
    }
    if (this.dragging || this.dragFrame !== 0) return
    if (this.moveRun !== null) {
      this.stopMove('displays-changed')
      this.ensureAnimation()
    }
    this.setBody(clampBodyToDisplays(this.body(), displays, this.metrics()))
    this.persist()
  }

  setSettings(next: ControllerSettings): void {
    this.settings = { ...next }
    // 主进程的品类时钟可能比页面本地更晚（模型/等待状态刚从其它路径播放）。
    // 只取更严格者，页面自己记录的真实 started 不会被热更新提前清掉。
    this.lookAroundCooldownUntil = Math.max(
      this.lookAroundCooldownUntil,
      next.lookAroundCooldownUntil
    )
    const sizeChanged = next.size !== this.metrics().size
    if (sizeChanged) {
      this.stopMove('resized')
      this.stopThrow()
      this.throwing = false
      this.dragging = false
      this.view.setDragging(false)
      this.stopDragFollow()
      this.view.setSize(next.size)
      this.setBody(clampBodyToDisplays(this.body(), this.displays, this.metrics()))
      this.persist()
    }
    if (!next.movement.enabled) {
      this.stopMove('movement-disabled')
    } else if (next.movement.pauseWithPanel && this.panelOpen) {
      this.stopMove('panel-open')
    }
    if (next.reducedMotion && this.moveRun?.request?.autonomous === true) {
      this.stopMove('reduced-motion')
    }
    if (this.active === null || this.active.mode === 'idle-loop' || this.active.mode === 'move') {
      this.ensureAnimation()
    }
  }

  setPanelOpen(open: boolean): void {
    this.panelOpen = open
    if (open && this.settings.movement.pauseWithPanel && this.moveRun !== null) {
      this.stopMove('panel-open')
      this.ensureAnimation()
    }
    this.callbacks.onStateChange?.()
  }

  /** 右键菜单打开时冻结移动；显式点播仍按优先级执行。 */
  setMenuOpen(open: boolean): void {
    if (this.menuOpen === open) return
    this.menuOpen = open
    if (open) {
      this.stopThrow()
      this.stopMove('menu-open')
      this.ensureAnimation()
      return
    }
    if (!this.startPending()) this.ensureAnimation()
  }

  /** 停靠跟随/外部落位：只改位置，不改变当前动画。 */
  placeAt(body: BodyBox, persist = false): void {
    if (this.destroyed || this.dragging) return
    this.setBody(body)
    if (persist) this.persist()
  }

  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return
    this.suspended = suspended
    if (suspended) {
      this.stopMove('suspended')
      this.stopDragFollow()
      this.stopThrow()
      this.throwing = false
      this.dragging = false
      this.view.setDragging(false)
      this.throwInterruptExplicit('suspended')
      // 系统挂起期间 Chromium 可能冻结视频；恢复后从当前状态重新出画。
      this.clearSegmentWatchdog()
      this.active = null
      this.setBody(nearestLegalBody(this.body(), this.displays, this.metrics()))
      this.persist()
      return
    }
    if (!this.startPending()) this.ensureAnimation()
  }

  setQuietUntil(endsAt: number): void {
    // 安静只限制主进程的主动说话；表现层没有需要记住的静音计时。
    void endsAt
  }

  setBound(bound: boolean): void {
    if (this.bound === bound) return
    this.bound = bound
    if (bound) {
      this.stopMove('perched')
      this.stopThrow()
      this.throwing = false
      this.stopDragFollow()
      this.ensureAnimation()
    } else {
      this.ensureAnimation()
    }
  }

  /** 停靠窗口消失/屏被拔掉后的安全下落；不经过 ensureAnimation。 */
  dropFromPerch(): void {
    if (this.destroyed) return
    this.bound = false
    this.stopMove('perched')
    this.stopThrow()
    const body = this.body()
    this.startThrow(body.x, body.y, 0, 0)
    if (!this.throwing) this.ensureAnimation()
  }

  // ---------------------------------------------------------------- Agent 状态

  handleWorkStatus(status: PetAgentStatusView): void {
    if (this.destroyed) return
    const next = petPhaseToWorkStatus(status.petPhase, { cuaActive: status.cuaActive })
    const source = status.source ?? null
    const statusChanged = next !== this.workStatus
    const roundChanged = status.round !== this.workRound
    if (!statusChanged && source === this.workStatusSource && !roundChanged) return
    const previous = this.workStatus
    this.workStatus = next
    this.workStatusSource = source
    this.workRound = status.round
    this.errorTurnKey =
      next === 'error' && status.failure !== null ? status.failure.turnId : null
    if (statusChanged && next === 'waiting' && previous !== 'waiting') {
      // 每一次「进入等待」都是独立事件：播一次踱步张望，然后安静待机。
      this.waitingEventSeq += 1
    }
    if (next === null) {
      // 期望状态回到 idle：当前分段播到自然边界后再回待机；
      // 已经播过的终态键留着，迟到重复的同一完成事件不会重播。
      return
    }
    // 已经在播放一次性动作/点击/菜单/移动/拖拽时只记录最新期望状态；
    // 绝不为了显示工作状态而取消正在播放的动作。
    if (this.dragging) return
    if (this.active !== null && this.active.mode !== 'idle-loop') return
    if (this.explicit !== null) return
    if (this.active === null || this.active.mode === 'idle-loop') {
      // 静息待机是唯一自动基线，可以被真实状态立即替换；其它动作必须自然结束。
      this.playWorkStatus(next)
    }
  }

  // ---------------------------------------------------------------- 显式点播

  request(request: PetAnimationRequest): void {
    if (this.destroyed) return
    if (!isKnownAnimationId(request.animationId)) {
      this.sendReceipt(request, 'unsupported', 'unknown-animation')
      return
    }
    // 移动素材必须伴随真实位移；不能用 pet_act/pet_say 原地播放冒充。
    if (isMovementAnimationId(request.animationId)) {
      this.sendReceipt(request, 'rejected', 'use-pet-walk-to')
      return
    }
    const requestClass = classifyAnimationRequest(request)
    const wallNow = this.wallNow()
    if (
      request.expiresAt !== undefined &&
      Number.isFinite(request.expiresAt) &&
      wallNow > request.expiresAt
    ) {
      this.sendReceipt(request, 'rejected', 'expired')
      return
    }

    // 本地随机小动作是独立于模型/气泡的通道：永不复用待播队列，
    // 只要当前不安静就明确拒绝，由主进程调度器稍后重新判定。
    if (requestClass === 'ambient-random') {
      const reason = this.ambientActionRejectionReason(request.animationId)
      if (reason !== null) {
        this.sendReceipt(request, 'rejected', reason)
        return
      }
      this.sendReceipt(request, 'accepted')
      this.faulted = false
      this.failedAnimation = null
      this.view.hideError()
      this.startExplicitNow(request)
      return
    }

    if (requestClass === 'model-semantic') {
      const reason = this.semanticRejectionReason(request, wallNow)
      if (reason !== null) {
        this.sendReceipt(request, 'rejected', reason)
        return
      }
    }

    // 张望是一个昂贵的品类：等待状态、模型语义/装饰动作与历史映射共享
    // 15 分钟下限；用户明确点播不受限，但仍会重置随后自动通道的时钟。
    if (requestClass !== 'user-explicit' && isLookAroundAnimation(request.animationId)) {
      this.lookAround.lastAttemptAt = wallNow
      if (wallNow < this.lookAroundCooldownUntil) {
        this.noteLookAroundRejected(request.source, 'look-around-cooldown', wallNow)
        this.sendReceipt(request, 'rejected', 'look-around-cooldown')
        return
      }
    }

    if (request.autonomous === true) {
      const reason = this.autonomousRejectionReason()
      if (reason !== null) {
        this.sendReceipt(request, 'rejected', reason)
        return
      }
    } else {
      this.sendReceipt(request, 'accepted')
    }
    if (requestClass === 'model-semantic') {
      this.noteSemanticAccepted(request, wallNow)
    }
    this.faulted = false
    this.failedAnimation = null
    this.view.hideError()

    // 同一动画、同一模式的重复点播合并到当前播放，不重启动画。
    if (this.active?.mode === 'explicit' && this.active.request !== undefined) {
      if (this.sameExplicitIntent(this.active.request, request)) {
        this.active.coalesced = [...(this.active.coalesced ?? []), request]
        this.sendReceipt(request, 'started', 'coalesced')
        return
      }
    }
    if (this.pending !== null && this.sameExplicitIntent(this.pending.request, request)) {
      this.pending.aliases.push(request)
      this.sendReceipt(request, 'queued', 'coalesced')
      return
    }

    if (this.suspended) {
      // 系统挂起期间不出画；请求排队，恢复后重新校验 TTL/占用再决定是否播放。
      this.queuePending(request, 'suspended')
      return
    }
    if (this.dragging) {
      // 拖拽优先级最高：先接受并排队，松手后再真正播放；不会把宠物从指针下抢走。
      this.queuePending(request, 'dragging')
      return
    }
    if (this.menuOpen) {
      // 右键菜单是用户正在使用的直接界面：不在菜单期间抢播，等关闭后再处理。
      this.queuePending(request, 'menu-open')
      return
    }
    if (this.active !== null && this.active.mode !== 'idle-loop') {
      // 正在播放的一次性动作/工作状态/点击/菜单/移动：排到自然边界，不取消当前播放。
      this.queuePending(request, this.active.mode === 'move' ? 'moving' : 'protected')
      return
    }
    // 空闲循环没有需要保护的叙事内容，可以立即让位给显式点播。
    this.startExplicitNow(request)
  }

  /**
   * 自主轮的可选装饰动作：本地只检查物理占用/设置，不自行延后或补播。
   * 主进程负责空闲门槛与冷却；这里返回固定原因，让模型看到真实拒绝。
   */
  private autonomousRejectionReason(): string | null {
    if (this.settings.reducedMotion) return 'reduced-motion'
    if (!this.settings.idleActions.enabled) return 'idle-actions-disabled'
    if (this.dragging) return 'dragging'
    if (this.throwing) return 'throwing'
    if (this.suspended) return 'suspended'
    if (this.menuOpen) return 'menu-open'
    if (this.panelOpen) return 'panel-open'
    // 自主轮自身的思考/工具相位不是真实工作任务；否则自主动作永远无法开始。
    if (this.workStatus !== null && this.workStatusSource !== 'autonomy') {
      return 'work-status'
    }
    const ownAutonomyWork =
      this.active?.mode === 'work' && this.workStatusSource === 'autonomy'
    if (this.active !== null && this.active.mode !== 'idle-loop' && !ownAutonomyWork) {
      return 'busy'
    }
    if (this.explicit !== null || this.moveRun !== null) return 'busy'
    if (this.pending !== null) return 'busy'
    return null
  }

  /**
   * 本地随机小动作的页面侧复核。不排队的代价是可能偶尔放弃一次机会；
   * 主进程会保留一个待办并在安静后重新判定，不会形成补偿爆发。
   */
  private ambientActionRejectionReason(animationId: string): string | null {
    if (this.settings.reducedMotion) return 'reduced-motion'
    if (!this.settings.randomIdle.enabled) return 'random-idle-disabled'
    if (!isAmbientEligibleAnimation(animationId)) return 'ambient-ineligible'
    if (this.dragging) return 'dragging'
    if (this.throwing) return 'throwing'
    if (this.suspended) return 'suspended'
    if (this.menuOpen) return 'menu-open'
    if (this.panelOpen) return 'panel-open'
    if (this.workStatus !== null) return 'work-status'
    if (this.moveRun !== null) return 'moving'
    if (this.explicit !== null || this.pending !== null) return 'busy'
    if (this.active !== null && this.active.mode !== 'idle-loop') return 'busy'
    if (this.faulted) return 'playback-error'
    return null
  }

  /** 语义动作的页面侧闸门：开关、同轮去重与最短间隔。 */
  private semanticRejectionReason(
    request: { dedupeKey?: string },
    wallNow: number
  ): string | null {
    if (!this.settings.semantic.enabled) return 'semantic-disabled'
    const key = request.dedupeKey?.slice(0, 120)
    if (key !== undefined && key !== '' && this.semanticDedupe.has(key)) return 'duplicate'
    const minGap = Math.max(0, this.settings.semantic.minGapMs)
    const last = Math.max(this.lastSemanticStartAt, this.lastSemanticAcceptAt)
    if (minGap > 0 && last > 0 && wallNow - last < minGap) return 'semantic-gap'
    return null
  }

  private noteSemanticAccepted(
    request: { dedupeKey?: string },
    wallNow: number
  ): void {
    this.lastSemanticAcceptAt = wallNow
    const key = request.dedupeKey?.slice(0, 120)
    if (key === undefined || key === '') return
    this.semanticDedupe.delete(key)
    this.semanticDedupe.add(key)
    while (this.semanticDedupe.size > SEMANTIC_DEDUPE_LIMIT) {
      const oldest = this.semanticDedupe.values().next().value
      if (oldest === undefined) break
      this.semanticDedupe.delete(oldest)
    }
  }

  /** 与主进程策略同一口径：15 分钟下限 + 用户已有的更严格间隔。 */
  private lookAroundCategoryCooldownMs(): number {
    return Math.max(
      LOOK_AROUND_CATEGORY_COOLDOWN_MS,
      this.settings.idleActions.lookAroundIntervalMs,
      this.settings.idleActions.sameActionIntervalMs
    )
  }

  private noteLookAroundStarted(source: string): void {
    const now = this.wallNow()
    this.lookAround.lastStartedAt = now
    this.lookAround.lastSource = source
    this.lookAround.lastAttemptAt = now
    this.lookAroundCooldownUntil = Math.max(
      this.lookAroundCooldownUntil,
      now + this.lookAroundCategoryCooldownMs()
    )
  }

  private noteLookAroundRejected(source: string, reason: string, at: number): void {
    this.lookAround.lastAttemptAt = at
    this.lookAround.lastRejectedSource = source
    this.lookAround.lastRejectedReason = reason.slice(0, 120)
  }

  private sameExplicitIntent(a: PetAnimationRequest, b: PetAnimationRequest): boolean {
    return a.animationId === b.animationId && a.mode === b.mode
  }

  /** 立即开始显式点播（调用方已确认当前没有受保护动作）。 */
  private startExplicitNow(request: PetAnimationRequest, aliases: PetAnimationRequest[] = [], announce = true): void {
    this.faceForNoMirror(request.animationId)
    this.explicit = request
    const active: ActiveAnimation = {
      mode: 'explicit',
      animationId: request.animationId,
      request,
      token: null,
      ...(aliases.length > 0 ? { coalesced: aliases } : {})
    }
    this.active = active
    void this.playExplicit(active, announce)
  }

  private queuePending(request: PetAnimationRequest, reason: string): void {
    if (this.pending !== null) {
      // 队列只保留最新意图；被替换的请求必须得到确定回执。
      this.dropPending('superseded')
    }
    const timer = window.setTimeout(() => {
      if (this.pending?.request.requestId !== request.requestId) return
      this.dropPending('expired')
      // 过期只是丢弃待播意图；若当前恰好没有受保护动作，继续按最新状态出画。
      this.ensureAnimation()
      this.callbacks.onStateChange?.()
    }, PENDING_TTL_MS)
    this.pending = { request, aliases: [], since: this.now(), timer }
    this.sendReceipt(request, 'queued', reason)
    this.callbacks.onStateChange?.()
  }

  /** 取出并开始唯一的待播动作；返回是否已开始。 */
  private startPending(): boolean {
    const pending = this.pending
    if (pending === null || this.destroyed) return false
    if (this.dragging || this.suspended || this.menuOpen) return false
    // 待机循环只是一个自动基线，没有需要保护的叙事内容，可以被待播动作替换。
    if (this.active !== null && this.active.mode !== 'idle-loop') return false
    if (this.explicit !== null) return false
    this.pending = null
    window.clearTimeout(pending.timer)
    const wallNow = this.wallNow()
    const wallExpired = [pending.request, ...pending.aliases].some(
      (request) =>
        request.expiresAt !== undefined &&
        Number.isFinite(request.expiresAt) &&
        wallNow > request.expiresAt
    )
    if (this.now() - pending.since > PENDING_TTL_MS || wallExpired) {
      for (const request of [pending.request, ...pending.aliases]) {
        this.sendReceipt(request, 'interrupted', 'expired')
      }
      return false
    }
    this.startExplicitNow(pending.request, pending.aliases)
    return true
  }

  private dropPending(reason: string): void {
    const pending = this.pending
    if (pending === null) return
    this.pending = null
    window.clearTimeout(pending.timer)
    for (const request of [pending.request, ...pending.aliases]) {
      this.sendReceipt(request, 'interrupted', reason)
    }
  }

  private faceForNoMirror(animationId: string): void {
    if (
      isNoMirrorAnimation(this.settings.animations.categories, animationId) &&
      this.view.getFacing() === 'right'
    ) {
      this.view.setFacing('left')
    }
  }

  /**
   * 播放显式动作的一段。loop 请求也按单段播放，由控制器的 ended 边界
   * 决定继续同一动作还是让位给最新的工作状态/排队动作。
   */
  private async playExplicit(active: ActiveAnimation, announce: boolean): Promise<void> {
    const request = active.request
    if (request === undefined) return
    const result = await this.view.player.play(request.animationId, { loop: false })
    if (!this.ownsActive(active)) return
    if (!result.ok) {
      if (result.reason === 'interrupted') return
      this.explicit = null
      this.active = null
      this.failedAnimation = request.animationId
      this.faulted = true
      this.showPlaybackError(result.reason)
      this.sendReceipt(request, 'failed', result.reason ?? 'load')
      for (const alias of active.coalesced ?? []) {
        this.sendReceipt(alias, 'failed', result.reason ?? 'load')
      }
      this.ensureAnimation()
      return
    }
    active.token = result.token ?? this.view.player.playbackToken
    this.armSegmentWatchdog(active)
    if (announce) {
      if (classifyAnimationRequest(request) === 'model-semantic') {
        this.lastSemanticStartAt = this.wallNow()
      }
      if (isLookAroundAnimation(request.animationId)) {
        this.noteLookAroundStarted(request.source)
      }
      this.sendReceipt(request, 'started')
      for (const alias of active.coalesced ?? []) {
        this.sendReceipt(alias, 'started', 'coalesced')
      }
    }
    this.callbacks.onStateChange?.()
  }

  /** 右键菜单点播：不产生工具回执；动作失败仍显示可见错误。 */
  playMenu(animationId: string): void {
    if (this.destroyed || !isKnownAnimationId(animationId)) return
    this.faulted = false
    this.failedAnimation = animationId
    this.view.hideError()
    this.throwInterruptExplicit('menu')
    this.stopThrow()
    this.faulted = false
    this.faceForNoMirror(animationId)
    if (this.isMoveAction(animationId)) {
      // 菜单点播移动素材也必须产生真实位移；不能原地播放。
      if (this.startMenuMove(animationId)) return
      this.ensureAnimation()
      return
    }
    this.stopMove('superseded')
    const active: ActiveAnimation = { mode: 'menu', animationId, token: null }
    this.active = active
    void this.view.player
      .play(animationId, { loop: false })
      .then((result) => {
        if (!this.ownsActive(active)) return
        if (!result.ok) {
          if (result.reason === 'interrupted') return
          this.active = null
          this.failedAnimation = animationId
          this.faulted = true
          this.showPlaybackError(result.reason)
          this.ensureAnimation()
          return
        }
        active.token = result.token ?? this.view.player.playbackToken
        this.armSegmentWatchdog(active)
        // 菜单是用户明确点播，不受冷却限制，但会重置后续自动通道的品类时钟。
        if (isLookAroundAnimation(animationId)) this.noteLookAroundStarted('menu')
        this.callbacks.onStateChange?.()
      })
  }

  /** 错误卡上的重试：只重试一次，失败后再次停下，不做自动循环。 */
  retry(): void {
    this.view.hideError()
    this.faulted = false
    const target = this.failedAnimation
    this.failedAnimation = null
    if (target !== null && isKnownAnimationId(target)) {
      this.playMenu(target)
      return
    }
    this.ensureAnimation()
  }

  // ---------------------------------------------------------------- 点击与拖拽

  clickFeedback(): void {
    if (this.destroyed) return
    this.throwInterruptExplicit('click')
    this.stopMove('click')
    this.stopThrow()
    this.faulted = false
    this.failedAnimation = null
    this.view.hideError()
    this.view.startSquash(SQ_SQUASH, this.settings.reducedMotion)
    const pool = this.settings.animations.clicks
    this.active = null
    // 固定顺序轮换；只使用点击回应分类，不跨分类随机。
    const animationId =
      pool.length > 0 ? pool[this.clickIndex++ % pool.length] ?? null : null
    if (animationId === null) {
      this.ensureAnimation()
      return
    }
    const active: ActiveAnimation = { mode: 'click', animationId, token: null }
    this.active = active
    void this.view.player.play(animationId, { loop: false }).then((result) => {
      if (!this.ownsActive(active)) return
      if (!result.ok) {
        if (result.reason === 'interrupted') return
        this.active = null
        this.failedAnimation = animationId
        this.faulted = true
        this.showPlaybackError(result.reason)
        this.ensureAnimation()
        return
      }
      active.token = result.token ?? this.view.player.playbackToken
      this.armSegmentWatchdog(active)
    })
  }

  beginDrag(): void {
    if (this.destroyed) return
    this.throwInterruptExplicit('drag')
    this.stopThrow()
    this.stopMove('drag')
    this.stopDragFollow()
    this.faulted = false
    this.failedAnimation = null
    this.view.hideError()
    this.dragging = true
    this.view.setDragging(true)
    const pool = this.settings.animations.drag
    const animationId = pool[0] ?? null
    if (animationId === null) {
      this.active = null
      return
    }
    const active: ActiveAnimation = { mode: 'drag', animationId, token: null }
    this.active = active
    void this.view.player.play(animationId, { loop: false }).then((result) => {
      if (!this.ownsActive(active)) return
      if (!result.ok && result.reason !== 'interrupted') {
        this.active = null
        this.failedAnimation = animationId
        this.faulted = true
        this.showPlaybackError(result.reason)
        return
      }
      if (result.ok) {
        active.token = result.token ?? this.view.player.playbackToken
        this.armSegmentWatchdog(active)
      }
    })
  }

  /** 按下即接管：飞行中点击会先停住，移动中的宠物也不会从指针下走开。 */
  pressDown(point: { x: number; y: number }): void {
    if (this.destroyed) return
    this.stopThrow()
    this.stopMove('drag')
    this.notePointerDown(point)
  }

  /** 指针按下时记录抓取锚点与弹弓判定。 */
  notePointerDown(point: { x: number; y: number }): void {
    const now = this.now()
    this.dragSling = now - this.lastPressAt < DRAG_SLING_MS
    this.lastPressAt = this.dragSling ? 0 : now
    const center = bodyCenter(this.body())
    this.pressAnchor = { x: center.x, y: center.y }
    this.dragTrail = [{ t: now, x: point.x, y: point.y }]
  }

  dragTo(point: { x: number; y: number }, offset: { x: number; y: number }): void {
    if (!this.dragging) return
    const now = this.now()
    this.dragTrail.push({ t: now, x: point.x, y: point.y })
    if (this.dragTrail.length > 40) this.dragTrail.splice(0, this.dragTrail.length - 40)
    const metrics = this.metrics()
    this.dragTarget = {
      x: point.x - offset.x - metrics.halfW,
      y: point.y - offset.y - metrics.halfH,
      w: metrics.width,
      h: metrics.height
    }
    this.startDragFollow()
  }

  /**
   * 松手。velocity 非空 = 甩抛；sling = 弹弓；
   * deferResume 用于停靠吸附：先落位，随后由 PerchController 设 bound。
   */
  endDrag(options: { velocity?: { vx: number; vy: number } | null; deferResume?: boolean } = {}): void {
    if (!this.dragging) return
    this.dragging = false
    this.view.setDragging(false)
    this.stopDragFollow()
    let body = this.body()
    if (!this.throwing) {
      body = nearestLegalBody(body, this.displays, this.metrics())
      this.setBody(body)
    }
    this.dragTrail = []
    if (options.velocity !== undefined && options.velocity !== null && !this.throwing) {
      this.startThrow(body.x, body.y, options.velocity.vx, options.velocity.vy)
      // 甩抛期间仍可播上层动画；移动类由 throwing 守卫拒绝。
      if (this.active?.mode === 'drag') this.active = null
      if (!this.startPending() && this.explicit === null) this.ensureAnimation()
      return
    }
    this.persist()
    if (options.deferResume === true) {
      this.startPending()
      return
    }
    // 拖拽动画是循环的，不会自然 ended；松手后必须在这里清掉，
    // 否则温和放下会一直停在“悬空”姿态，直到片段被其他状态打断。
    if (this.active?.mode === 'drag') this.active = null
    if (!this.startPending()) this.ensureAnimation()
  }

  /** 当前拖拽轨迹的释放速度；供 Interaction 在松手瞬间调用。 */
  releaseVelocity(): { vx: number; vy: number } | null {
    return estimateReleaseVelocity(this.dragTrail, this.now(), this.settings.physics)
  }

  /** 弹弓：按下锚点 → 当前身体中心的拉向量；返回初速度（反方向）。 */
  slingWasArmed(): boolean {
    return this.dragSling
  }

  slingAnchor(): { x: number; y: number } | null {
    return this.pressAnchor
  }

  /** 供 Interaction 计算弹弓力度；不改变状态。 */
  slingPull(): { x: number; y: number } | null {
    const anchor = this.pressAnchor
    if (anchor === null) return null
    const center = bodyCenter(this.body())
    return { x: center.x - anchor.x, y: center.y - anchor.y }
  }

  /** 本次松手的弹弓初速（拉距决定力度，方向与拉向相反）。 */
  slingVelocity(): { vx: number; vy: number } | null {
    const pull = this.slingPull()
    if (pull === null) return null
    const distance = Math.hypot(pull.x, pull.y)
    const power = slingshotPower(distance, this.metrics().size)
    return slingshotVelocity(
      pullAngle(pull.x, pull.y),
      power,
      this.settings.physics.throwPower
    )
  }

  resetPressState(): void {
    this.dragSling = false
    this.pressAnchor = null
  }

  // ---------------------------------------------------------------- 移动

  /**
   * 工具 pet_walk_to / 页面移动事件：目标为当前屏工作区横向比例 0..1。
   * 所有结果都通过 reportMovement 回传；不会在无法移动时静默 return。
   */
  walkTo(request: PetMovementRequest): void {
    if (this.destroyed) return
    const animationId = request.animationId
    if (!isMovementAnimationId(animationId)) {
      this.sendMovementReceipt(request, 'failed', 'invalid-animation')
      return
    }
    if (!Number.isFinite(request.target) || request.target < 0 || request.target > 1) {
      this.sendMovementReceipt(request, 'failed', 'invalid-target')
      return
    }
    const requestClass = classifyMovementRequest({
      ...(request.requestClass === undefined ? {} : { requestClass: request.requestClass }),
      autonomous: request.autonomous === true
    })
    this.sendMovementReceipt(request, 'accepted')
    const wallNow = this.wallNow()
    if (
      request.expiresAt !== undefined &&
      Number.isFinite(request.expiresAt) &&
      wallNow > request.expiresAt
    ) {
      this.sendMovementReceipt(request, 'blocked', 'expired')
      return
    }
    if (requestClass === 'model-semantic') {
      const reason = this.semanticRejectionReason(request, wallNow)
      if (reason !== null) {
        this.sendMovementReceipt(request, 'blocked', reason)
        return
      }
    }
    if (request.autonomous === true && this.settings.reducedMotion) {
      this.sendMovementReceipt(request, 'blocked', 'reduced-motion')
      return
    }
    if (requestClass === 'ambient-roam') {
      // 本地随机走动不能替换任何正在进行的表现/移动，也不能落在
      // 工作、拖拽、菜单、面板、停靠或挂起状态上；不排队，由主进程稍后重试。
      if (!this.settings.movement.randomRoam.enabled) {
        this.sendMovementReceipt(request, 'blocked', 'random-roam-disabled')
        return
      }
      if (this.workStatus !== null) {
        this.sendMovementReceipt(request, 'blocked', 'work-status')
        return
      }
      // 随机走动始终避让输入面板；与用户可配置的 pauseWithPanel 无关，
      // 后者只决定模型/用户明确移动是否可以继续。
      if (this.panelOpen) {
        this.sendMovementReceipt(request, 'blocked', 'panel-open')
        return
      }
      if (this.explicit !== null || this.pending !== null) {
        this.sendMovementReceipt(request, 'blocked', 'busy')
        return
      }
      if (this.moveRun !== null) {
        this.sendMovementReceipt(request, 'blocked', 'moving')
        return
      }
      if (this.active !== null && this.active.mode !== 'idle-loop') {
        this.sendMovementReceipt(request, 'blocked', 'busy')
        return
      }
    } else if (request.autonomous === true) {
      // 优先级：真实工作、用户明确动作和用户明确移动都高于自主漫游。
      // 自主移动不能为了自己出发而打断这些状态；但自主轮自己的相位除外。
      if (this.workStatus !== null && this.workStatusSource !== 'autonomy') {
        this.sendMovementReceipt(request, 'blocked', 'work-status')
        return
      }
      if (this.explicit !== null) {
        this.sendMovementReceipt(request, 'blocked', 'busy')
        return
      }
      if (this.moveRun !== null && this.moveRun.request?.autonomous !== true) {
        this.sendMovementReceipt(request, 'blocked', 'busy')
        return
      }
    }
    const blocked = this.movementBlockedReason({ ignoreMenu: false })
    if (blocked !== null) {
      this.sendMovementReceipt(request, 'blocked', blocked)
      return
    }
    const display = displayForBody(this.displays, this.body()) ?? primaryDisplay(this.displays)
    if (display === null) {
      this.sendMovementReceipt(request, 'failed', 'no-display')
      return
    }
    const center = bodyCenter(this.body())
    const desired = display.x + request.target * display.width
    const metrics = this.metrics()
    const minCenter = display.x + metrics.halfW - metrics.sideAllow
    const maxCenter = display.x + display.width - metrics.halfW + metrics.sideAllow
    const targetCenterX = clamp(desired, minCenter, maxCenter)
    const targetX = targetCenterX - metrics.halfW
    if (Math.abs(targetCenterX - center.x) < 3) {
      // 新指令即使“已到目标”也优先于尚未结束的旧移动，不能让它继续走开。
      if (this.moveRun !== null) this.stopMove('superseded')
      this.sendMovementReceipt(request, 'already_at_target')
      return
    }
    // 新指令替换旧移动：旧请求先收到 interrupted，再开始新请求。
    if (this.moveRun !== null) this.stopMove('superseded')
    this.throwInterruptExplicit('movement')
    const started = this.startMovement({
      animationId,
      targetX,
      y: this.body().y,
      request
    })
    // 真正进入移动驱动后才占用语义间隔与同轮去重；被占用挡下时
    // 不消耗页面侧的语义时钟。实际 started 回执还会刷新开始时间。
    if (started && requestClass === 'model-semantic') {
      this.noteSemanticAccepted(request, wallNow)
    }
  }

  // ---------------------------------------------------------------- 内部：动画基线

  private ensureAnimation(): void {
    if (this.destroyed || this.dragging || this.suspended) return
    if (this.explicit !== null) return
    if (this.active !== null) return
    if (this.faulted) return
    if (this.menuOpen) return
    // 唯一待播队列优先于工作状态；它最多等一个自然边界。
    if (this.pending !== null) {
      if (this.startPending()) return
    }
    const desired = this.workStatus
    if (desired !== null) {
      if (isTerminalWorkStatus(desired)) {
        // 终态只在尚未播过同一个事件时补一次，随后回待机。
        if (this.terminalPlayedKey !== this.terminalKey(desired)) {
          this.playWorkStatus(desired)
          return
        }
      } else if (desired === 'waiting') {
        // waiting 每次事件只播一段踱步张望，不无限循环。
        if (this.waitingPlayedSeq !== this.waitingEventSeq) {
          this.playWorkStatus(desired)
          return
        }
      } else {
        // 思考/工具/结果在状态持续期间按段续播，但每段都重新读取最新状态。
        this.playWorkStatus(desired)
        return
      }
    }
    // 没有任何模型指令或真实事件时，永远回到安静待机。
    this.playIdleLoop()
  }

  private playIdleLoop(): void {
    const idle = this.settings.animations.idle
    if (idle.length === 0) return
    const animationId = idle[0]
    if (animationId === undefined) return
    const active: ActiveAnimation = { mode: 'idle-loop', animationId, token: null }
    this.active = active
    void this.view.player.play(animationId, { loop: true }).then((result) => {
      if (!this.ownsActive(active)) return
      if (!result.ok && result.reason !== 'interrupted') {
        this.active = null
        this.failedAnimation = animationId
        this.faulted = true
        this.showPlaybackError(result.reason)
        return
      }
      if (result.ok) active.token = result.token ?? this.view.player.playbackToken
    })
  }

  private handleEnded(animationId: string, token: number): void {
    const active = this.active
    if (this.destroyed || active === null || active.animationId !== animationId) return
    // token 守卫：同一动画的新一次播放不能被旧实例的迟到 ended 结束。
    if (active.token === null || active.token !== token) return
    this.clearSegmentWatchdog()
    switch (active.mode) {
      case 'idle-loop':
        // loop=true 不应自然结束；若解码器提前发 ended，续播一次循环。
        this.active = null
        this.playIdleLoop()
        return
      case 'move': {
        const run = this.moveRun
        if (run !== null) this.finishMoveRun(run, true)
        return
      }
      case 'work':
        this.active = null
        this.ensureAnimation()
        return
      case 'explicit':
        this.handleExplicitBoundary(active)
        return
      case 'menu':
        this.active = null
        this.ensureAnimation()
        return
      case 'drag':
        // 仍按着指针时保持最后一帧，松手后由 endDrag 决定续播。
        this.active = null
        if (!this.dragging) this.ensureAnimation()
        return
      case 'click':
        this.active = null
        this.ensureAnimation()
        return
    }
  }

  /** 显式动作到达自然边界：优先队列，其次最新工作状态，循环动作才续段。 */
  private handleExplicitBoundary(active: ActiveAnimation): void {
    const request = active.request
    this.active = null
    this.explicit = null
    if (request === undefined) {
      this.ensureAnimation()
      return
    }
    const aliases = active.coalesced ?? []
    if (request.mode === 'loop') {
      // 循环不是一次性完成；换段时若已有新的期望状态/排队动作，就明确结束它。
      if (this.pending !== null) {
        this.sendReceipt(request, 'interrupted', 'superseded')
        for (const alias of aliases) this.sendReceipt(alias, 'interrupted', 'superseded')
        this.ensureAnimation()
        return
      }
      if (this.workStatus !== null) {
        this.sendReceipt(request, 'interrupted', 'work-status')
        for (const alias of aliases) this.sendReceipt(alias, 'interrupted', 'work-status')
        this.ensureAnimation()
        return
      }
      // 受控单段续播：不重发 started，队列仍可在下一个边界插入。
      this.startExplicitNow(request, aliases, false)
      return
    }
    this.sendReceipt(request, 'completed')
    for (const alias of aliases) this.sendReceipt(alias, 'completed')
    this.ensureAnimation()
  }

  private handleRuntimeError(
    animationId: string,
    reason: 'unsupported' | 'load' | 'decode' | 'play' | 'timeout' | 'interrupted',
    token: number
  ): void {
    const active = this.active
    if (this.destroyed || active === null || active.animationId !== animationId) return
    if (active.token === null || active.token !== token) return
    this.clearSegmentWatchdog()
    if (active.mode === 'move') {
      const run = this.moveRun
      if (run !== null) this.failMoveRun(run, reason, false)
      return
    }
    this.active = null
    this.failedAnimation = animationId
    this.faulted = true
    if (active.mode === 'explicit' && active.request !== undefined) {
      this.explicit = null
      this.sendReceipt(active.request, 'failed', reason)
      for (const alias of active.coalesced ?? []) {
        this.sendReceipt(alias, 'failed', reason)
      }
    }
    this.showPlaybackError(reason)
  }

  // ---------------------------------------------------------------- 内部：工作状态

  /**
   * 播放一段工作状态。所有档位都按单段播放；是否续播、切换到哪个新状态，
   * 统一在 ended 边界由 ensureAnimation 依据最新 workStatus 决定。
   */
  private playWorkStatus(state: WorkStatusState): void {
    if (this.destroyed || this.suspended) return
    if (this.dragging || this.explicit !== null) return
    const terminal = isTerminalWorkStatus(state)
    // 同一失败通知重复到达时不重播；只按可信 turnId 去重，不合并不同的失败。
    if (
      state === 'error' &&
      this.errorTurnKey !== null &&
      this.playedErrorTurns.has(this.errorTurnKey)
    ) {
      return
    }
    if (terminal) {
      const key = this.terminalKey(state)
      if (this.terminalPlayedKey === key) return
      this.terminalPlayedKey = key
      if (state === 'error' && this.errorTurnKey !== null) {
        this.playedErrorTurns.add(this.errorTurnKey)
        if (this.playedErrorTurns.size > 20) {
          const oldest = this.playedErrorTurns.values().next().value
          if (oldest !== undefined) this.playedErrorTurns.delete(oldest)
        }
      }
    }
    if (state === 'waiting') {
      if (this.waitingPlayedSeq === this.waitingEventSeq) return
      this.waitingPlayedSeq = this.waitingEventSeq
    }
    const slots = this.settings.animations.events['workStatus'] ?? []
    const index = workStatusIndex(state)
    const slot = slots[index]
    if (slot === undefined) {
      this.active = null
      this.playIdleLoop()
      return
    }
    this.faulted = false
    this.failedAnimation = null
    this.view.hideError()
    const current = this.active?.animationId ?? ''
    const animationId = pickSlot(slot, current)
    if (isLookAroundAnimation(animationId)) {
      const wallNow = this.wallNow()
      this.lookAround.lastAttemptAt = wallNow
      if (wallNow < this.lookAroundCooldownUntil) {
        // 等待状态里的踱步张望也属于同一品类：冷却期直接回到安静待机，
        // 不占用一次动作，也不把内部等待回合当作新的随机种子。
        this.noteLookAroundRejected('work-status', 'look-around-cooldown', wallNow)
        this.active = null
        this.playIdleLoop()
        return
      }
    }
    const active: ActiveAnimation = {
      mode: 'work',
      animationId,
      token: null,
      workState: state
    }
    this.active = active
    void this.view.player.play(animationId, { loop: false }).then((result) => {
      if (!this.ownsActive(active)) return
      if (!result.ok && result.reason !== 'interrupted') {
        this.active = null
        this.failedAnimation = animationId
        this.faulted = true
        this.showPlaybackError(result.reason)
        // 工作状态素材损坏：显示错误并停链，等用户重试/状态变化。
        return
      }
      if (result.ok) {
        active.token = result.token ?? this.view.player.playbackToken
        this.armSegmentWatchdog(active)
        if (isLookAroundAnimation(animationId)) {
          this.noteLookAroundStarted('work-status')
        }
        // 让主进程尽快拿到页面内部 started 的快照，而不等 5 秒心跳。
        this.callbacks.onStateChange?.()
      }
    })
  }

  private terminalKey(state: WorkStatusState): string {
    if (state === 'error' && this.errorTurnKey !== null) {
      return `error:${this.errorTurnKey}`
    }
    return `${state}:${this.workStatusSource ?? 'none'}:${this.workRound}`
  }

  // ---------------------------------------------------------------- 内部：移动

  private movementBlockedReason(options: { ignoreMenu: boolean }): string | null {
    if (this.destroyed) return 'destroyed'
    if (this.suspended) return 'suspended'
    if (this.dragging) return 'dragging'
    if (this.throwing) return 'throwing'
    if (this.bound) return 'perched'
    if (!this.settings.movement.enabled) return 'movement-disabled'
    if (this.panelOpen && this.settings.movement.pauseWithPanel) return 'panel-open'
    if (!options.ignoreMenu && this.menuOpen) return 'menu-open'
    return null
  }

  private isMoveAction(animationId: string): boolean {
    return this.settings.animations.moves.actions.some((move) => move.name === animationId)
  }

  /**
   * 右键菜单点播移动素材：始终产生真实位移。朝当前方向走一段；
   * 到边后尝试反方向；仍无可走距离则不播放（不能原地冒充移动）。
   */
  private startMenuMove(animationId: string): boolean {
    if (this.movementBlockedReason({ ignoreMenu: true }) !== null) return false
    const display = displayForBody(this.displays, this.body()) ?? primaryDisplay(this.displays)
    if (display === null) return false
    const chosen = this.settings.animations.moves.actions.find((move) => move.name === animationId)
    if (chosen === undefined) return false
    const params: MoveParams = {
      ...this.settings.animations.moves.default,
      ...(chosen.params ?? {})
    }
    const metrics = this.metrics()
    const body = this.body()
    const center = bodyCenter(body)
    const scale = metrics.size / 462
    const minCenter = display.x + metrics.halfW - metrics.sideAllow
    const maxCenter = display.x + display.width - metrics.halfW + metrics.sideAllow
    const distance = Math.max(24, Math.min(params.maxDist * scale, display.width / 3))
    const direction = this.view.getFacing() === 'right' ? 1 : -1
    let targetCenter = clamp(center.x + direction * distance, minCenter, maxCenter)
    if (Math.abs(targetCenter - center.x) < 6) {
      targetCenter = clamp(center.x - direction * distance, minCenter, maxCenter)
    }
    if (Math.abs(targetCenter - center.x) < 6) return false
    if (this.moveRun !== null) this.stopMove('superseded')
    return this.startMovement({
      animationId,
      targetX: targetCenter - metrics.halfW,
      y: body.y,
      request: null
    })
  }

  /**
   * 开始一次真实位移。短距离用单段视频的 lead/tail 时间驱动；
   * 超过该素材合理行程时循环播放，并以受限制的恒定速度前进。
   */
  private startMovement(input: {
    animationId: string
    targetX: number
    y: number
    request: PetMovementRequest | null
  }): boolean {
    const moves = this.settings.animations.moves
    const chosen = moves.actions.find((move) => move.name === input.animationId)
    if (chosen === undefined) {
      if (input.request !== null) {
        this.sendMovementReceipt(input.request, 'failed', 'unknown-animation')
      }
      return false
    }
    const params: MoveParams = { ...moves.default, ...(chosen.params ?? {}) }
    const metrics = this.metrics()
    const current = this.body()
    const delta = input.targetX + metrics.halfW - bodyCenter(current).x
    if (Math.abs(delta) < 1) {
      if (input.request !== null) {
        this.sendMovementReceipt(input.request, 'already_at_target')
      }
      return false
    }
    const scale = metrics.size / 462
    const capacity = Math.max(1, params.maxDist * scale)
    const distance = Math.abs(delta)
    const loop = distance > capacity
    this.view.setFacing(delta >= 0 ? 'right' : 'left')
    this.faulted = false
    this.failedAnimation = null
    this.view.hideError()
    const active: ActiveAnimation = { mode: 'move', animationId: chosen.name, token: null }
    this.active = active
    const run: MoveRun = {
      animationId: chosen.name,
      request: input.request,
      startX: current.x,
      targetX: input.targetX,
      y: input.y,
      startedAt: this.now(),
      leadSec: Math.max(0, params.leadSec),
      tailSec: Math.max(0, params.tailSec),
      loop,
      speedPxPerSec: 0,
      startedReported: false
    }
    this.moveRun = run
    // 让主进程尽快知道身体已被移动占用；页面仍会在每个请求上二次复核。
    this.callbacks.onStateChange?.()
    // 同一移动素材的旧视频可能仍在半途；移动必须从 0 秒重新出画，
    // 否则 lead/tail 会从旧进度接管，身体出现瞬移或提前结束。
    void this.view.player.play(chosen.name, { loop, restart: true }).then((result) => {
      // 对象身份守卫：旧请求/被替换的移动的晚到结果不会影响新移动。
      if (this.destroyed || this.moveRun !== run || this.active !== active) return
      if (!result.ok) {
        if (result.reason === 'interrupted') return
        this.failMoveRun(run, result.reason ?? 'load', true)
        return
      }
      active.token = result.token ?? this.view.player.playbackToken
      const duration = this.view.player.duration()
      const total = duration > 0 ? duration : 2
      const travelWindow = Math.max(0.1, total - run.leadSec - run.tailSec)
      // 循环模式限制在可读的步速范围，避免把任意远目标塞进一段视频高速滑行。
      run.speedPxPerSec = loop
        ? clamp(capacity / travelWindow, 120 * scale, 480 * scale)
        : distance / travelWindow
      run.startedAt = this.now()
      run.startedReported = true
      if (run.request !== null) {
        if (classifyMovementRequest(run.request) === 'model-semantic') {
          this.lastSemanticStartAt = this.wallNow()
        }
        this.sendMovementReceipt(run.request, 'started')
      }
      this.startMoveDrive(run)
    })
    return true
  }

  private startMoveDrive(run: MoveRun): void {
    if (this.moveFrame !== 0) return
    const step = (): void => {
      this.moveFrame = 0
      if (this.destroyed || this.moveRun !== run || this.active?.mode !== 'move') return
      if (run.loop) {
        const elapsed = (this.now() - run.startedAt) / 1000
        const traveled = Math.max(0, elapsed - run.leadSec) * run.speedPxPerSec
        const direction = run.targetX >= run.startX ? 1 : -1
        const x =
          direction >= 0
            ? Math.min(run.targetX, run.startX + traveled)
            : Math.max(run.targetX, run.startX - traveled)
        this.setBody({ ...this.body(), x, y: run.y })
        if (
          (direction >= 0 && x >= run.targetX - 0.5) ||
          (direction < 0 && x <= run.targetX + 0.5)
        ) {
          this.finishMoveRun(run, true)
          return
        }
        this.moveFrame = requestAnimationFrame(step)
        return
      }
      const duration = this.view.player.duration()
      const currentTime = this.view.player.currentTime()
      const elapsed = (this.now() - run.startedAt) / 1000
      const total = duration > 0 ? duration : 2
      const t = duration > 0 ? currentTime : elapsed
      const travelWindow = Math.max(0.1, total - run.leadSec - run.tailSec)
      const p = clamp((t - run.leadSec) / travelWindow, 0, 1)
      const x = run.startX + (run.targetX - run.startX) * p
      this.setBody({ ...this.body(), x, y: run.y })
      // 正常由 ended 收尾；无时长元数据时兜底，避免永远停在半路。
      if (elapsed < total + 1.5) {
        this.moveFrame = requestAnimationFrame(step)
      } else {
        this.finishMoveRun(run, true)
      }
    }
    this.moveFrame = requestAnimationFrame(step)
  }

  private stopMovementFrame(): void {
    if (this.moveFrame !== 0) cancelAnimationFrame(this.moveFrame)
    this.moveFrame = 0
  }

  /** 停止移动；被中断时给旧请求真实回执，不偷偷回到旧目标。 */
  private stopMove(reason: string | null = null): void {
    this.stopMovementFrame()
    const run = this.moveRun
    this.moveRun = null
    if (this.active?.mode === 'move') {
      this.clearSegmentWatchdog()
      this.active = null
    }
    if (run !== null) {
      this.persist()
      if (reason !== null && run.request !== null) {
        this.sendMovementReceipt(run.request, 'interrupted', reason)
      }
    }
    this.callbacks.onStateChange?.()
  }

  private finishMoveRun(run: MoveRun, reachedTarget: boolean): void {
    if (this.moveRun !== run) return
    this.stopMovementFrame()
    this.moveRun = null
    if (this.active?.mode === 'move') {
      this.clearSegmentWatchdog()
      this.active = null
    }
    const x = reachedTarget ? run.targetX : run.startX
    this.setBody({ ...this.body(), x, y: run.y })
    this.persist()
    if (run.request !== null) {
      this.sendMovementReceipt(run.request, 'completed')
    }
    this.callbacks.onStateChange?.()
    if (!this.startPending()) this.ensureAnimation()
  }

  private failMoveRun(run: MoveRun, reason: string, restoreStart: boolean): void {
    if (this.moveRun !== run) return
    this.stopMovementFrame()
    this.moveRun = null
    this.clearSegmentWatchdog()
    this.active = null
    this.failedAnimation = run.animationId
    this.faulted = true
    if (restoreStart) this.setBody({ ...this.body(), x: run.startX, y: run.y })
    this.persist()
    if (run.request !== null) this.sendMovementReceipt(run.request, 'failed', reason)
    this.showPlaybackError(reason)
    this.callbacks.onStateChange?.()
    this.ensureAnimation()
  }

  /** 当前身体中心相对所在显示器的比例；用于回执与模型状态摘要。 */
  private bodyXRatio(): number {
    const display = displayForBody(this.displays, this.body()) ?? primaryDisplay(this.displays)
    if (display === null || display.width <= 0) return 0
    return clamp((bodyCenter(this.body()).x - display.x) / display.width, 0, 1)
  }

  private sendMovementReceipt(
    request: PetMovementRequest,
    status: PetMovementStatus,
    reason?: string
  ): void {
    const metrics = this.metrics()
    const display = displayForBody(this.displays, this.body()) ?? primaryDisplay(this.displays)
    const range =
      display === null || display.width <= 0
        ? {}
        : {
            reachableMinRatio: clamp(
              (metrics.halfW - metrics.sideAllow) / display.width,
              0,
              1
            ),
            reachableMaxRatio: clamp(
              1 - (metrics.halfW - metrics.sideAllow) / display.width,
              0,
              1
            )
          }
    this.callbacks.reportMovement({
      requestId: request.requestId,
      animationId: request.animationId,
      target: request.target,
      status,
      at: Date.now(),
      ...(reason === undefined ? {} : { reason: reason.slice(0, 120) }),
      xRatio: this.bodyXRatio(),
      facing: this.view.getFacing(),
      ...range
    })
  }

  // ---------------------------------------------------------------- 内部：拖拽弹簧

  private startDragFollow(): void {
    if (this.dragFrame !== 0 || this.dragTarget === null) return
    const metrics = this.metrics()
    let last = this.now()
    const step = (): void => {
      this.dragFrame = 0
      if (this.destroyed || !this.dragging || this.dragTarget === null) return
      const target = this.dragTarget
      const now = this.now()
      const dt = Math.min(Math.max((now - last) / 1000, 0), 1 / 30)
      last = now
      const body = this.body()
      const power = this.settings.physics.throwPower || DEFAULT_THROW_POWER
      this.dragVelocity.vx = springStep(this.dragVelocity.vx, body.x, target.x, dt, power)
      this.dragVelocity.vy = springStep(this.dragVelocity.vy, body.y, target.y, dt, power)
      const x = body.x + this.dragVelocity.vx * dt
      const y = body.y + this.dragVelocity.vy * dt
      this.setBody({ ...body, x, y, w: metrics.width, h: metrics.height })
      this.dragFrame = requestAnimationFrame(step)
    }
    this.dragVelocity = { vx: 0, vy: 0 }
    this.dragFrame = requestAnimationFrame(step)
  }

  private stopDragFollow(): void {
    if (this.dragFrame !== 0) cancelAnimationFrame(this.dragFrame)
    this.dragFrame = 0
    this.dragTarget = null
    this.dragVelocity = { vx: 0, vy: 0 }
  }

  // ---------------------------------------------------------------- 内部：抛掷

  private startThrow(x: number, y: number, vx: number, vy: number): void {
    this.stopThrow()
    this.stopDragFollow()
    this.stopMove()
    const space = throwSpace({
      areas: displayRects(this.displays),
      size: this.metrics().size,
      sideAllow: this.metrics().sideAllow
    })
    if (space.areas.length === 0) {
      this.setBody({ ...this.body(), x, y })
      this.persist()
      return
    }
    this.throwing = true
    this.throwState = { x, y, vx, vy }
    this.throwSpaceValue = space
    const lock =
      this.settings.confineToScreen
        ? displayIndexForBody(this.displays, { ...this.body(), x, y })
        : -1
    let last = this.now()
    const step = (): void => {
      this.throwFrame = 0
      if (this.destroyed || !this.throwing) return
      const state = this.throwState
      const currentSpace = this.throwSpaceValue
      if (state === null || currentSpace === null) return
      const now = this.now()
      const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05)
      last = now
      const falling = state.vy
      const substeps = throwSubsteps(state.vx, state.vy, dt)
      let res = throwStepRegion(
        state,
        dt / substeps,
        currentSpace,
        this.settings.physics,
        lock
      )
      for (let index = 1; index < substeps && !res.atRest; index += 1) {
        res = throwStepRegion(res, dt / substeps, currentSpace, this.settings.physics, lock)
      }
      this.throwState = { x: res.x, y: res.y, vx: res.vx, vy: res.vy }
      this.setBody({ ...this.body(), x: res.x, y: res.y })
      if (res.bounced && falling > SQ_SOFT_SPEED && res.vy <= 0) {
        this.view.startSquash(landingSquash(falling), this.settings.reducedMotion)
      }
      if (res.atRest) {
        this.finishThrow()
        return
      }
      this.throwFrame = requestAnimationFrame(step)
    }
    this.throwFrame = requestAnimationFrame(step)
  }

  private stopThrow(): void {
    if (this.throwFrame !== 0) cancelAnimationFrame(this.throwFrame)
    this.throwFrame = 0
    this.throwState = null
    this.throwSpaceValue = null
    if (this.throwing) {
      this.throwing = false
      this.persist()
    }
  }

  private finishThrow(): void {
    this.stopThrow()
    const settled = clampBodyToDisplays(this.body(), this.displays, this.metrics())
    this.setBody(settled)
    this.persist()
    if (this.active === null) this.ensureAnimation()
  }

  // ---------------------------------------------------------------- 内部：公共

  private setBody(body: BodyBox): void {
    const metrics = this.metrics()
    this.view.setBody({
      x: body.x,
      y: body.y,
      w: metrics.width,
      h: metrics.height
    })
  }

  private persist(): void {
    this.callbacks.onSettled(this.body(), this.view.getFacing())
  }

  private ownsActive(active: ActiveAnimation): boolean {
    return !this.destroyed && this.active === active
  }

  private closeActiveExplicit(reason: string): void {
    this.throwInterruptExplicit(reason)
  }

  private throwInterruptExplicit(reason: string): void {
    if (this.explicit === null) return
    const request = this.explicit
    const active = this.active?.mode === 'explicit' ? this.active : null
    this.explicit = null
    if (active !== null) {
      this.clearSegmentWatchdog()
      this.active = null
    }
    this.sendReceipt(request, 'interrupted', reason)
    for (const alias of active?.coalesced ?? []) {
      this.sendReceipt(alias, 'interrupted', reason)
    }
  }

  // ---------------------------------------------------------------- 看门狗

  private armSegmentWatchdog(active: ActiveAnimation): void {
    this.clearSegmentWatchdog()
    if (active.mode === 'idle-loop' || active.mode === 'move' || active.mode === 'drag') return
    const duration = this.view.player.duration()
    const delay = Math.min(
      120_000,
      Math.max(3_000, (duration > 0 ? duration * 1_000 : 5_000) + 3_000)
    )
    this.scheduleWatchdog(active, delay)
  }

  private scheduleWatchdog(active: ActiveAnimation, delay: number): void {
    this.segmentWatchdog = window.setTimeout(() => {
      this.segmentWatchdog = 0
      this.handleSegmentWatchdog(active)
    }, delay)
  }

  private clearSegmentWatchdog(): void {
    if (this.segmentWatchdog === 0) return
    window.clearTimeout(this.segmentWatchdog)
    this.segmentWatchdog = 0
  }

  /**
   * 后台标签页/系统节能可能暂停视频或丢失 ended；先尝试续播，再在保守的
   * 硬边界推进状态机，避免队列或工作状态被永久锁住。
   */
  private handleSegmentWatchdog(active: ActiveAnimation): void {
    if (!this.ownsActive(active) || active.token === null) return
    if (this.view.player.paused()) {
      if (active.watchdogResumed !== true) {
        active.watchdogResumed = true
        this.view.player.resume()
        this.scheduleWatchdog(active, 2_500)
        return
      }
    }
    const duration = this.view.player.duration()
    const current = this.view.player.currentTime()
    if (duration > 0 && current >= duration - 0.4) {
      // ended 事件丢失，但画面已经播完：按自然结束处理。
      this.handleEnded(active.animationId, active.token)
      return
    }
    if (
      duration > 0 &&
      (active.watchdogChecks ?? 0) < 2 &&
      !this.view.player.paused() &&
      current > 0
    ) {
      active.watchdogChecks = (active.watchdogChecks ?? 0) + 1
      this.scheduleWatchdog(active, Math.min(30_000, (duration - current) * 1_000 + 2_000))
      return
    }
    this.forceSegmentBoundary(active)
  }

  private forceSegmentBoundary(active: ActiveAnimation): void {
    if (!this.ownsActive(active)) return
    this.clearSegmentWatchdog()
    if (active.mode === 'work') {
      this.active = null
      this.ensureAnimation()
      return
    }
    if (active.mode === 'explicit') {
      const request = active.request
      if (request?.mode === 'loop') {
        this.handleExplicitBoundary(active)
        return
      }
      // 一次性动作没有自然结束证据：如实报告被卡住，不能伪造成 completed。
      this.active = null
      this.explicit = null
      if (request !== undefined) {
        this.sendReceipt(request, 'interrupted', 'stalled')
        for (const alias of active.coalesced ?? []) {
          this.sendReceipt(alias, 'interrupted', 'stalled')
        }
      }
      this.ensureAnimation()
      return
    }
    if (active.mode === 'idle-loop') {
      this.active = null
      this.playIdleLoop()
      return
    }
    if (active.mode === 'menu' || active.mode === 'click') {
      this.active = null
      this.ensureAnimation()
      return
    }
    if (active.mode === 'drag') {
      this.active = null
    }
  }

  private showPlaybackError(reason: string | undefined): void {
    this.view.showError(playbackErrorMessage(reason))
  }

  private sendReceipt(
    request: PetAnimationRequest,
    status: PetAnimationReceiptStatus,
    reason?: string
  ): void {
    this.callbacks.reportReceipt({
      requestId: request.requestId,
      animationId: request.animationId,
      status,
      at: Date.now(),
      ...(reason === undefined ? {} : { reason: reason.slice(0, 120) })
    })
  }
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

function playbackErrorMessage(reason: string | undefined): string {
  switch (reason) {
    case 'unsupported':
      return '没有这个动画素材。'
    case 'timeout':
      return '动画素材加载超时。请重试。'
    case 'play':
      return '系统阻止了动画播放。'
    case 'decode':
      return '动画素材无法解码，文件可能已损坏。'
    default:
      return '动画素材加载失败。请检查内置素材是否完整。'
  }
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}
