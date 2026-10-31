import type {
  PetBootstrap,
  PetDisplayView,
  PetPageStateSnapshot,
  PetSettingsEvent,
  PetSavedPositionView
} from '../shared/ipc'
import { DSH_PET_CATALOG } from '../shared/dshPet/catalog.generated'
import { MENU_CSS } from '../shared/dshPet/menu'
import type { Animations } from '../shared/dshPet/types'
import { CuaOverlay } from './cuaOverlay'
import { PetOverlay } from './overlay'
import { QuickInput } from './quickInput'
import { PetActorView } from './dshPet/view'
import { PetController } from './dshPet/controller'
import { PetInteraction } from './dshPet/interaction'
import { PerchController } from './dshPet/perch'
import { PetDirector } from './dshPet/director'
import {
  bodyFromLegacy,
  bodyFromSaved,
  homeBody,
  parseLegacyStoredPosition,
  savedFromBody,
  type BodyBox,
  type PetMetrics,
  type PetAnchor
} from '../shared/dshPet/layout'

/**
 * 桌宠页启动器（dsh-pet 运行时）。
 *
 * 组装：bootstrap → 位置迁移 → 透明视频视图 → 唯一动画控制器 → 停靠/指针路由
 *      → 气泡/快捷输入 → 事件订阅 → notifyReady。
 *
 * 页面里只有一套播放循环（PetController + 双缓冲 <video>）。旧 figure iframe、
 * ActionDirector、TravelController 与触摸粒子层都不再参与生产路径。
 */

const LEGACY_POSITION_KEYS = [
  'mingyue.figure.position.v1',
  'mingyue.roam.position.v1'
] as const
const MENU_STYLE_ID = 'dsh-pet-menu-style'
const SAVE_DEBOUNCE_MS = 350
/** 页面状态快照：变化时最多 1 秒一条，另有 5 秒心跳；主进程按更新时间判新鲜。 */
const PAGE_STATE_MIN_INTERVAL_MS = 1_000
const PAGE_STATE_HEARTBEAT_MS = 5_000

export interface PetDebugApi {
  layout(): {
    body: BodyBox
    metrics: PetMetrics
    facing: 'left' | 'right'
    anchor: PetAnchor
    hit: { x: number; y: number; w: number; h: number }
  }
  isOnBody(x: number, y: number): boolean
  controller(): ReturnType<PetController['debugState']>
  interaction(): ReturnType<PetInteraction['debugState']>
  perch(): ReturnType<PerchController['debugState']>
  displays(): PetDisplayView[]
  savedPosition(): PetSavedPositionView | null
  positionReason(): string | null
  settings(): {
    size: number
    reducedMotion: boolean
    policy: PetBootstrap['animation']['policy']
    idleActions: PetBootstrap['animation']['idleActions']
    randomIdle: PetBootstrap['animation']['randomIdle']
    semantic: PetBootstrap['animation']['semantic']
    movement: PetBootstrap['movement']
    confineToScreen: boolean
  }
}

export function showFatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[pet-page]', error)
  const card = document.createElement('div')
  card.className = 'pet-fatal'
  card.setAttribute('data-pet-fatal', '')
  card.setAttribute('data-agent-ui', '')
  const title = document.createElement('strong')
  title.textContent = '桌宠页面启动失败'
  const detail = document.createElement('span')
  detail.textContent = message
  const hint = document.createElement('span')
  hint.className = 'pet-fatal-hint'
  hint.textContent = '可在设置中重新加载桌宠；若持续失败，请检查内置素材是否完整。'
  card.append(title, detail, hint)
  document.body.appendChild(card)
}

function injectMenuStyles(): void {
  if (document.getElementById(MENU_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = MENU_STYLE_ID
  style.textContent = MENU_CSS
  document.head.appendChild(style)
}

function readLegacyPosition(): { key: string; raw: string } | null {
  for (const key of LEGACY_POSITION_KEYS) {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw !== null) return { key, raw }
    } catch {
      /* 禁用 localStorage 时仍然使用主进程位置/初始角落。 */
    }
  }
  return null
}

function clearLegacyPositions(): void {
  for (const key of LEGACY_POSITION_KEYS) {
    try {
      window.localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  }
}

export async function boot(): Promise<void> {
  const initial: PetBootstrap = await window.mingyue.pet.bootstrap()
  injectMenuStyles()

  const animations: Animations = DSH_PET_CATALOG.animations
  let displays: PetDisplayView[] = initial.displays
  let appearance = initial.appearance
  let physics = initial.physics
  let movement = initial.movement
  let confineToScreen = initial.confineToScreen
  let animationConfig = initial.animation
  let clickAction = initial.chatUi.petClickAction
  let quickInputConfig = initial.chatUi.quickInput
  const positionReason = initial.positionReason

  const viewport = (): { width: number; height: number } => ({
    width: window.innerWidth,
    height: window.innerHeight
  })
  const homeBodyNow = (): BodyBox =>
    homeBody(appearance.home, displays, view.getMetrics(), viewport())

  const stage = document.getElementById('stage') ?? document.body
  let retryHandler = (): void => undefined
  const view = new PetActorView({
    stage,
    size: appearance.size,
    onRetry: () => retryHandler()
  })

  // ---------------------------------------------------------------- 位置迁移
  // 主进程位置优先；没有时把旧 localStorage 的屏 + 横向比例迁移过来。
  // 旧运行时保存的 yRatio 从未被读取（脚始终落在该屏底边），迁移保持同一语义。
  let initialBody: BodyBox
  const saved = initial.position
  if (saved !== null) {
    initialBody = bodyFromSaved(saved, displays, view.getMetrics(), viewport())
    view.setFacing(saved.facing)
  } else {
    const legacyStored = readLegacyPosition()
    const legacy = legacyStored === null ? null : parseLegacyStoredPosition(legacyStored.raw)
    const legacyBody =
      legacy === null ? null : bodyFromLegacy(legacy, displays, view.getMetrics())
    if (legacyBody !== null) {
      initialBody = legacyBody
    } else {
      initialBody = homeBodyNow()
      view.setFacing('left')
    }
  }
  view.setBody(initialBody)
  if (positionReason !== null) {
    console.warn('[pet-page] 位置恢复提示：', positionReason)
  }

  // ---------------------------------------------------------------- 动画/物理
  let pageReady = false
  let pageStateReportTimer = 0
  let lastPageStateReportAt = 0

  const petController: PetController = new PetController({
    view,
    displays,
    animations,
    physics,
    idleActions: animationConfig.idleActions,
    randomIdle: animationConfig.randomIdle,
    semantic: animationConfig.semantic,
    reducedMotion: appearance.reducedMotion,
    movement,
    confineToScreen,
    lookAroundCooldownUntil: initial.lookAroundCooldownUntil,
    size: appearance.size,
    callbacks: {
      reportReceipt: (receipt) => window.mingyue.pet.reportAnimation(receipt),
      reportMovement: (receipt) => window.mingyue.pet.reportMovement(receipt),
      onSettled: (body, facing) => {
        scheduleSave(body, facing)
        reportMovementCapability()
      },
      onStateChange: () => schedulePageStateReport()
    }
  })

  /** 主进程随机调度只看这份实时快照；页面仍在每个请求上独立复核。 */
  function sendPageState(): void {
    pageStateReportTimer = 0
    lastPageStateReportAt = Date.now()
    const snapshot: PetPageStateSnapshot = petController.pageState({
      ready: pageReady,
      visible: document.visibilityState === 'visible'
    })
    try {
      window.mingyue.pet.reportPageState(snapshot)
    } catch {
      /* 页面卸载/主进程退出时忽略。 */
    }
  }

  function schedulePageStateReport(delayMs = 200): void {
    if (pageStateReportTimer !== 0) return
    const elapsed = Date.now() - lastPageStateReportAt
    const wait = Math.max(delayMs, PAGE_STATE_MIN_INTERVAL_MS - elapsed)
    pageStateReportTimer = window.setTimeout(sendPageState, wait)
  }

  /** 只上报几何事实：当前位置、朝向、可安全到达的横向范围。 */
  function reportMovementCapability(): void {
    const capability = petController.movementCapability()
    if (capability !== null) {
      window.mingyue.pet.reportActivity('movement-ready', capability)
    }
  }

  // ---------------------------------------------------------------- 保存
  let saveTimer = 0
  let pendingSave: PetSavedPositionView | null = null
  let lastSavedPosition: PetSavedPositionView | null = saved

  const flushSave = async (): Promise<void> => {
    if (saveTimer !== 0) {
      window.clearTimeout(saveTimer)
      saveTimer = 0
    }
    const payload = pendingSave
    pendingSave = null
    if (payload === null) return
    try {
      const ok = await window.mingyue.pet.savePosition(payload)
      if (ok) {
        lastSavedPosition = payload
        // 主进程已经接受真实位置后，旧 localStorage 键才算迁移完成（幂等）。
        clearLegacyPositions()
      }
    } catch {
      /* 下次落定再写；旧键保留。 */
    }
  }

  function scheduleSave(body: BodyBox, facing: 'left' | 'right'): void {
    const payload = savedFromBody(body, displays, facing, Date.now())
    if (payload === null) return
    pendingSave = payload
    if (saveTimer !== 0) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(flushSave, SAVE_DEBOUNCE_MS)
  }

  // 首次位置也写回主进程：迁移成功后旧键才可安全删除；写失败保留旧键下次再试。
  scheduleSave(view.getBody(), view.getFacing())

  const reloadAfterSave = (): void => {
    window.clearTimeout(saveTimer)
    saveTimer = 0
    void flushSave().finally(() => {
      window.location.reload()
    })
  }

  // ---------------------------------------------------------------- 停靠/指针
  // 只报告状态变化，窗口跟随时的重复 true 不反复打断主进程的空闲计时。
  let lastPerchBound = false
  const reportPerchBound = (bound: boolean): void => {
    if (bound === lastPerchBound) return
    lastPerchBound = bound
    window.mingyue.pet.reportActivity(bound ? 'perch-bind' : 'perch-unbind')
  }
  const perch = new PerchController({
    controller: petController,
    onStateChange: reportPerchBound
  })
  let panel: QuickInput | null = null

  function activatePet(reason: string, episodeId?: string): void {
    if (clickAction === 'full-chat') {
      window.mingyue.pet.openChat()
      return
    }
    if (clickAction !== 'quick-input') return
    if (panel?.isOpen === true) {
      if (episodeId !== undefined) panel.attachEpisode(episodeId)
      return
    }
    panel?.open(reason, episodeId)
  }

  const overlay = new PetOverlay(
    () => view.anchor(),
    {
      onBubbleActivate: (episodeId) => activatePet('user', episodeId),
      onApprovalActivate: (origin) => {
        // 快捷审批只能在快捷面板解决，不能走 petClickAction 的完整聊天分支。
        if (origin === 'quick') {
          panel?.open('approval')
          return
        }
        window.mingyue.pet.openChat()
      },
      onStatusActivate: (status) => {
        if (status.cuaActive && !status.approvalPending) {
          window.mingyue.pet.stopCua()
          return
        }
        if (status.failure !== null && !status.approvalPending) {
          window.mingyue.pet.openDiagnostics()
          return
        }
        if (status.task !== null && !status.approvalPending && clickAction !== 'none') {
          if (panel !== null) panel.open('task')
          else window.mingyue.pet.openChat()
          return
        }
        if (status.approvalOrigin === 'quick' && clickAction !== 'none') {
          panel?.open('approval')
          return
        }
        if (status.approvalPending || clickAction === 'none') {
          window.mingyue.pet.openChat()
          return
        }
        activatePet('user')
      }
    }
  )

  panel = new QuickInput({
    config: quickInputConfig,
    getAnchor: () => view.anchor(),
    onOpen: () => {
      petController.setPanelOpen(true)
      window.mingyue.pet.reportActivity('panel-open')
    },
    onClose: () => {
      petController.setPanelOpen(false)
      window.mingyue.pet.reportActivity('panel-close')
    }
  })

  const interaction = new PetInteraction({
    view,
    controller: petController,
    perch,
    onActivate: () => activatePet('user'),
    onQuickInput: () => panel?.open('user'),
    onOpenChat: () => window.mingyue.pet.openChat(),
    onOpenSettings: () => window.mingyue.pet.openSettings(),
    onRefresh: reloadAfterSave,
    getHomeBody: homeBodyNow,
    notifyInteraction: (kind) => window.mingyue.pet.notifyInteraction(kind),
    reportActivity: (kind) => window.mingyue.pet.reportActivity(kind),
    onInteractiveChange: (interactive) => window.mingyue.pet.setInteractive(interactive),
    onGrab: () => window.mingyue.pet.perchRefresh(),
    animations,
    quickInputEnabled: quickInputConfig.enabled
  })

  const director = new PetDirector(overlay, petController)
  retryHandler = () => petController.retry()
  const cuaOverlay = new CuaOverlay({ reducedMotion: appearance.reducedMotion })

  // ---------------------------------------------------------------- 设置热更新
  const applySettings = (event: PetSettingsEvent): void => {
    appearance = event.appearance
    animationConfig = event.animation
    physics = event.physics
    movement = event.movement
    confineToScreen = event.confineToScreen
    petController.setSettings({
      animations,
      physics: event.physics,
      idleActions: event.animation.idleActions,
      randomIdle: event.animation.randomIdle,
      semantic: event.animation.semantic,
      reducedMotion: event.appearance.reducedMotion,
      movement: event.movement,
      confineToScreen: event.confineToScreen,
      lookAroundCooldownUntil: event.lookAroundCooldownUntil,
      size: event.appearance.size
    })
    cuaOverlay.setReducedMotion(event.appearance.reducedMotion)
  }

  const applyDisplays = (next: PetDisplayView[]): void => {
    displays = next
    petController.setDisplays(next)
    perch.setDisplays(next)
    interaction.closeMenu()
    reportMovementCapability()
  }

  // ---------------------------------------------------------------- 订阅
  const unsubscribers: Array<() => void> = [
    window.mingyue.pet.onSay((event) => {
      const displayed = director.handleSay(event)
      // 页面回执是“真实显示”的唯一凭据；IPC 送达/动画开始都不算。
      if (event.sayId !== undefined) {
        window.mingyue.pet.reportSayReceipt({
          sayId: event.sayId,
          displayed,
          ...(displayed ? {} : { reason: 'bubble-suppressed' }),
          at: Date.now()
        })
      }
    }),
    window.mingyue.pet.onAnimation((event) => director.handleAnimation(event)),
    window.mingyue.pet.onMovement((event) => petController.walkTo(event.request)),
    window.mingyue.pet.onQuiet((event) => petController.setQuietUntil(event.endsAt)),
    window.mingyue.pet.onAgentStatus((status) => director.handleStatus(status)),
    window.mingyue.pet.onBiliReport((event) => director.handleBiliReport(event)),
    window.mingyue.pet.onSettings((event) => applySettings(event)),
    window.mingyue.pet.onDisplays((event) => applyDisplays(event.displays)),
    window.mingyue.pet.onChatUi((event) => {
      clickAction = event.petClickAction
      quickInputConfig = event.quickInput
      panel?.setConfig(event.quickInput)
      interaction.setMenuConfig(animations, event.quickInput.enabled)
    }),
    window.mingyue.pet.onPower((event) => {
      petController.setSuspended(event.suspended)
      // 挂起时页面仍可报告状态；恢复后主进程能重新判断空闲资格。
      window.mingyue.pet.reportActivity(event.suspended ? 'suspend' : 'resume')
    }),
    window.mingyue.pet.onPerchGeometry((geometry) => perch.setGeometry(geometry)),
    window.mingyue.pet.onPointerSample((sample) => interaction.applyPointerSample(sample)),
    window.mingyue.pet.onCommand((command) => {
      if (command === 'reset') {
        interaction.closeMenu()
        perch.detach(false)
        petController.goTo(homeBodyNow())
        overlay.clearAll()
      } else if (command === 'settings') {
        window.mingyue.pet.openSettings()
      } else if (command === 'reset-settings') {
        clearLegacyPositions()
        window.location.reload()
      } else if (command === 'refresh') {
        reloadAfterSave()
      }
    }),
    window.mingyue.pet.onOpenQuick(() => {
      if (panel?.isOpen !== true) panel?.open('approval')
    }),
    cuaOverlay.subscribe(),
    window.mingyue.quick.onEvent((event) => director.handleQuickEvent(event))
  ]

  const onResize = (): void => {
    interaction.closeMenu()
  }
  window.addEventListener('resize', onResize)
  const onVisibilityChange = (): void => {
    // 隐藏/恢复时不等待节流，主进程需要立即暂停或重新取一份新鲜几何。
    sendPageState()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  const pageStateHeartbeat = window.setInterval(() => {
    if (pageReady) sendPageState()
  }, PAGE_STATE_HEARTBEAT_MS)

  // 只在宠物页存在期间运行几何助手；重载后重新订阅并立即要一份快照。
  window.mingyue.pet.perchSubscribe()
  window.mingyue.pet.perchRefresh()

  // ---------------------------------------------------------------- 调试探针
  const debugApi: PetDebugApi = {
    layout: () => ({
      body: view.getBody(),
      metrics: view.getMetrics(),
      facing: view.getFacing(),
      anchor: view.anchor(),
      hit: view.hitBox()
    }),
    isOnBody: (x, y) => view.isOnBody({ x, y }),
    controller: () => petController.debugState(),
    interaction: () => interaction.debugState(),
    perch: () => perch.debugState(),
    displays: () => displays.map((display) => ({ ...display })),
    savedPosition: () => lastSavedPosition,
    positionReason: () => positionReason,
    settings: () => ({
      size: view.getMetrics().size,
      reducedMotion: appearance.reducedMotion,
      policy: animationConfig.policy,
      idleActions: animationConfig.idleActions,
      randomIdle: animationConfig.randomIdle,
      semantic: animationConfig.semantic,
      movement,
      confineToScreen
    })
  }
  ;(window as unknown as { __mingyuePet?: PetDebugApi }).__mingyuePet = debugApi

  const cleanup = (): void => {
    window.removeEventListener('resize', onResize)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.clearInterval(pageStateHeartbeat)
    window.clearTimeout(pageStateReportTimer)
    pageStateReportTimer = 0
    pageReady = false
    window.clearTimeout(saveTimer)
    saveTimer = 0
    const payload = savedFromBody(view.getBody(), displays, view.getFacing(), Date.now())
    if (payload !== null) {
      try {
        void window.mingyue.pet.savePosition(payload)
      } catch {
        /* 页面卸载时 IPC 可能已经不可用。 */
      }
    }
    try {
      window.mingyue.pet.perchUnsubscribe()
    } catch {
      /* ignore */
    }
    delete (window as unknown as { __mingyuePet?: PetDebugApi }).__mingyuePet
    for (const unsubscribe of unsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch {
        /* ignore */
      }
    }
    panel?.destroy()
    interaction.destroy()
    perch.destroy()
    director.destroy()
    cuaOverlay.destroy()
    petController.destroy()
    overlay.destroy()
  }
  window.addEventListener('beforeunload', cleanup)

  // 桌宠页重载不 abort 主进程里的 turn：用 snapshot 续接流式气泡或刚完成的回复。
  try {
    const snapshot = await window.mingyue.quick.bootstrap()
    director.handleQuickSnapshot(snapshot)
  } catch {
    /* 下一次打开面板会重新取快照。 */
  }

  petController.start()
  pageReady = true
  reportMovementCapability()
  sendPageState()
  window.mingyue.pet.notifyReady()
}
