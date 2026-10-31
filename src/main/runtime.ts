import {
  app,
  globalShortcut,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  safeStorage,
  shell,
  Tray,
  type BrowserWindow
} from 'electron'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AppConfig } from '../shared/config'
import {
  IPC,
  type ChatApprovalClearedEvent,
  type ChatApprovalEvent,
  type ChatOpenEvent,
  type ChatTapEvent,
  type ChatTerminalEvent,
  type ChatUserMessageEvent,
  type ChatWebEvent,
  type PetAgentStatusView,
  type PetChatUiEvent,
  type PetCuaActionEvent,
  type PetCommand,
  type PetMovementView,
  type PetPageStateSnapshot,
  type PetSayEvent,
  type PetSettingsEvent,
  type RevokeExplorationResult,
  type SaveConfigResult,
  type UiPhaseSnapshot
} from '../shared/ipc'
import { turnFailureView } from '../shared/turnFailureView'
import type { BiliSessionReportView } from '../shared/bilibili'
import type { PetAnimationOutcome } from '../shared/petPresentation'
import { deliverBiliReport } from './biliReport'
import { Bot } from '../bot'
import { providerFetch } from './providerFetch'
import { ElectronCuaPort } from './cua/port'
import { E2EFakeCuaPort } from './cua/fake'
import type { CuaActionEvent, CuaPort } from '../worlds/cua/port'
import { ElectronDesktopPort, defaultSelfProcessNames } from './desktop/electronPort'
import { E2EFakeDesktopPort } from './desktop/fakePort'
import type { DesktopPort } from '../worlds/desktop/types'
import { BrowserBridge } from './browserBridge'
import {
  BrowserExtensionManager,
  type BrowserExtensionInstallInfo
} from './browserExtensionManager'
import type { ApprovalDecision, ApprovalRequest, TapEvent } from '../core/types'
import type { SystemActivityProvider } from '../worlds/activity/foreground'
import type { SceneProvider, SceneStatus } from '../worlds/activity/scene'
import { normalizeProcessName } from '../worlds/activity/appIdentity'
import type { PetPresentationSink } from '../worlds/pet/petWorld'
import { PetAnimationBroker } from './petHost/animationBroker'
import { AmbientScheduler } from './petHost/ambientScheduler'
import { PetMovementBroker } from './petHost/movementBroker'
import { PetPositionStore } from './petHost/positionStore'
import { PetSayBroker } from './petHost/sayBroker'
import type { TerminalSink } from '../worlds/terminal/terminalWorld'
import type { WebObserver } from '../worlds/web/world'
import type { ConfigStore, ConfigLoadResult } from './config/store'
import { normalizeConfig } from './config/store'
import type { SecretStore } from './config/secrets'
import { registerIpc, type IpcContext } from './ipc'
import type { AppPaths } from './paths'
import { PetHostServer } from './petHost/server'
import {
  resolveResourcePaths,
  type ResourcePaths
} from './resources'
import { PerchService } from './perch/perchService'
import { canShowPetBubble, phaseSnapshot, petStatus } from './status'
import { ElectronSystemPort } from './system/port'
import { scanStartMenuApps } from './system/startMenu'
import { E2EFakeSceneProvider } from './vision/fake'
import { WindowsOcr } from './vision/ocr'
import { VisionService } from './vision/service'
import { petWorkAreaUnion, WindowManager } from './windows'

/**
 * 应用运行实例：把 Bot、桌宠宿主服务器、窗口、托盘和系统信号接在一起。
 * Electron 生命周期只留在 index.ts；这里完成“启动后怎么运转”。
 */

export interface RuntimeOptions {
  paths: AppPaths
  configStore: ConfigStore
  loaded: ConfigLoadResult
  secrets: SecretStore
  firstRun: boolean
}

const PRELOAD_PATH = require('node:path').join(__dirname, '..', 'preload', 'index.js')

export class Runtime {
  private readonly opts: RuntimeOptions
  private readonly resources: ResourcePaths
  private readonly warning: string | null
  private readonly bot: Bot
  private readonly petHost: PetHostServer
  private readonly petPositions: PetPositionStore
  private readonly petAnimations: PetAnimationBroker
  private readonly petMovement: PetMovementBroker
  private readonly petSay: PetSayBroker
  /** 唯一本地随机活动调度器；页面状态/配置/回执都汇入这里。 */
  private ambientScheduler: AmbientScheduler | null = null
  private readonly browserBridge: BrowserBridge
  private readonly browserExtension: BrowserExtensionManager
  private extensionInfo: BrowserExtensionInstallInfo
  private readonly cuaPort: CuaPort
  private readonly desktopPort: DesktopPort
  readonly windows: WindowManager
  private readonly perch: PerchService
  private vision: VisionService | null = null
  private fakeVision: E2EFakeSceneProvider | null = null

  /** E2E 假场景优先；真实用户路径永远只有 VisionService。 */
  private get sceneSource(): SceneProvider | null {
    return this.fakeVision ?? this.vision
  }

  /**
   * 在 Bot 构造前先给出一个稳定代理：ActivityWorld 只依赖窄接口，
   * VisionService 需要 Bot 的配置与当前类别，构造顺序因此先 Bot 后 vision。
   */
  private readonly sceneProxy: SceneProvider = {
    start: (onScene, onError) => this.sceneSource?.start(onScene, onError),
    stop: () => this.sceneSource?.stop(),
    refresh: () => this.sceneSource?.refresh?.(),
    status: (): SceneStatus =>
      this.sceneSource?.status?.() ?? {
        enabled: false,
        available: false,
        reason: '屏幕感知未启动',
        lastAt: null,
        lastFrameAt: null,
        lastSentAt: null,
        lastInterpretedAt: null,
        lastCategory: null,
        lastActivity: null,
        lastConfidence: null,
        lastDurationMs: null,
        lastError: null,
        framesCaptured: 0,
        framesLastMinute: 0,
        requestsSent: 0,
        bufferFrames: 0,
        frameBufferSeconds: 0,
        targetDisplayId: null,
        targetKind: null,
        quality: null,
        blockedReason: 'vision-unavailable',
        paused: false,
        intervalMs: null,
        nextCheckAt: null,
        ocrAvailable: null,
        ocrFallback: false,
        phase: null,
        game: null,
        evidenceSource: null,
        revision: 0,
        timings: null,
        lastFrame: null,
        semantic: {
          enabled: false,
          available: false,
          model: null,
          lastAt: null,
          lastSentAt: null,
          lastInterpretedAt: null,
          lastLatencyMs: null,
          lastError: null,
          imageSupported: null,
          shareFrames: false,
          inFlight: false,
          usage: null,
          reason: '屏幕感知未启动'
        }
      },
    clear: () => this.sceneSource?.clear?.(),
    pause: () => this.sceneSource?.pause?.(),
    resume: () => this.sceneSource?.resume?.(),
    observeNow: async () =>
      this.sceneSource?.observeNow?.() ?? { ok: false, reason: 'vision-unavailable' },
    targetChanged: (kind) => this.sceneSource?.targetChanged?.(kind),
    preview: () =>
      this.fakeVision !== null ? null : (this.vision?.previewSnippet() ?? null)
  }
  private readonly configWarning: string | null
  private tray: Tray | null = null
  private trayKey = ''
  private trayPaused: boolean | null = null
  private lastTooltip = ''
  private stopping = false
  private started = false
  private degradedReason: string | null = null
  /**
   * 已保存配置的单调版本。内存版本从 0 开始；设置页只在本进程生命周期内
   * 比较，磁盘损坏恢复/托盘修改也会令其递增，避免旧草稿静默覆盖新配置。
   */
  private configRevision = 0
  private unsubscribeQuickChat: (() => void) | null = null
  private unsubscribeTasks: (() => void) | null = null
  private unsubscribeStatus: (() => void) | null = null

  private readonly systemProvider: SystemActivityProvider = {
    getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    onLock: (listener) => this.onPower('lock-screen', listener),
    onUnlock: (listener) => this.onPower('unlock-screen', listener),
    onSuspend: (listener) => this.onPower('suspend', listener),
    onResume: (listener) => this.onPower('resume', listener)
  }

  constructor(options: RuntimeOptions) {
    this.opts = options
    this.resources = resolveResourcePaths({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath
    })
    this.warning = options.loaded.warning
    this.configWarning = options.loaded.warning

    const hasForegroundScript = (() => {
      try {
        return require('node:fs').existsSync(this.resources.activityScript)
      } catch {
        return false
      }
    })()
    const hasOcrScript = (() => {
      try {
        return require('node:fs').existsSync(this.resources.ocrScript)
      } catch {
        return false
      }
    })()

    // 仅未打包的 E2E 使用：注入固定场景，避免真实截图/OCR 依赖。
    // 额外的 SOURCE/DELAY 环境变量只服务屏幕陪伴的表现层用例：等设置页
    // 保存好 API Key 后再注入一条“模型已理解”的固定摘要。
    if (!app.isPackaged && process.env['MINGYUE_E2E_VISION_FAKE'] === '1') {
      const delayRaw = Number(process.env['MINGYUE_E2E_VISION_FAKE_DELAY_MS'])
      const fakeDelay = Number.isFinite(delayRaw) && delayRaw >= 0 ? delayRaw : null
      this.fakeVision = new E2EFakeSceneProvider({
        ...(fakeDelay === null ? {} : { delayMs: fakeDelay }),
        ...(process.env['MINGYUE_E2E_VISION_FAKE_SOURCE'] === 'vision_model'
          ? { scene: { evidenceSource: 'vision_model' as const } }
          : {})
      })
    }

    // SystemWorld 在 Bot 构造时就需要端口；日志桥接在 Bot 赋值后才可能被调用。
    const systemPort = new ElectronSystemPort({
      scriptPath: this.resources.systemActionsScript,
      dryRun: !app.isPackaged && process.env['MINGYUE_E2E_SYSTEM_FAKE'] === '1',
      logger: {
        log: (level, message, data) => this.bot.logger.log(level, message, data),
        debug: (message, data) => this.bot.logger.debug(message, data),
        info: (message, data) => this.bot.logger.info(message, data),
        warn: (message, data) => this.bot.logger.warn(message, data),
        error: (message, data) => this.bot.logger.error(message, data)
      }
    })

    // CUA 端口在 Bot 之前创建，但截图时才通过闭包取桌宠窗口；
    // 构造顺序不会让端口在窗口出现前访问 Electron 窗口对象。
    // E2E 假端口不截图、不注入键鼠，只用于验证图片通道/审批/动作标记。
    this.cuaPort =
      !app.isPackaged && process.env['MINGYUE_E2E_CUA_FAKE'] === '1'
        ? new E2EFakeCuaPort()
        : new ElectronCuaPort({
            getPetWindow: () => this.windows?.petWindow ?? null,
            inputScriptPath: this.resources.cuaInputScript,
            logger: {
              log: (level, message, data) => this.bot.logger.log(level, message, data),
              debug: (message, data) => this.bot.logger.debug(message, data),
              info: (message, data) => this.bot.logger.info(message, data),
              warn: (message, data) => this.bot.logger.warn(message, data),
              error: (message, data) => this.bot.logger.error(message, data)
            }
          })
    const cuaSelfNames = Array.from(
      new Set(
        [
          basename(process.execPath),
          `${app.getName()}.exe`,
          // CUA 绝不能操作桌宠自己的窗口；开发态主进程就是 electron.exe。
          process.versions['electron'] === undefined ? '' : 'electron.exe'
        ].filter((name) => name !== '')
      )
    )

    // 窗口观察端口同样在 Bot 之前创建；E2E 只使用固定假窗口，不触碰真实桌面。
    this.desktopPort =
      !app.isPackaged && process.env['MINGYUE_E2E_DESKTOP_FAKE'] === '1'
        ? new E2EFakeDesktopPort()
        : new ElectronDesktopPort({
            scriptPath: this.resources.desktopWindowScript,
            selfProcessNames: defaultSelfProcessNames(process.execPath, app.getName()),
            ...(process.platform === 'win32' ? {} : { powershellPath: 'powershell.exe' })
          })

    this.bot = new Bot({
      rootDir: options.paths.rootDir,
      fetchImpl: providerFetch,

      config: options.loaded.config,
      getApiKey: () => options.secrets.get(),
      appVersion: app.getVersion(),
      system: this.systemProvider,
      scene: this.sceneProxy,
      systemPort,
      cuaPort: this.cuaPort,
      desktopPort: this.desktopPort,
      scanApps: () => scanStartMenuApps(),
      cuaSelfNames,
      // B 站服务只在 Electron 装配中启用：资源和 DPAPI 安全存储缺一不可。
      bilibiliResourcesDir: this.resources.bilibiliDir,
      biliCrypto: {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (value) => safeStorage.decryptString(value)
      },
      biliOpenPath: (path) => shell.openPath(path),
      ...(hasForegroundScript ? { foregroundScriptPath: this.resources.activityScript } : {}),
      isOnBattery: () => powerMonitor.isOnBatteryPower(),
      onDegraded: (reason) => this.handleDegraded(reason),
      // 只汇总 Electron 自身进程的 CPU/内存；不返回进程名或窗口信息。
      processSampler: () => {
        try {
          let cpuPercent = 0
          let memoryMB = 0
          for (const metric of app.getAppMetrics()) {
            cpuPercent += metric.cpu?.percentCPUUsage ?? 0
            // workingSetSize 单位是 KB。
            memoryMB += (metric.memory?.workingSetSize ?? 0) / 1024
          }
          return {
            cpuPercent: Math.round(cpuPercent * 10) / 10,
            memoryMB: Math.round(memoryMB * 10) / 10
          }
        } catch {
          return null
        }
      }
    })

    // 扩展模板在安装包内是只读的（portable 还可能位于临时解压目录），
    // 启动时把发布文件同步到稳定的应用数据目录；浏览器扩展页只加载后者。
    this.browserExtension = new BrowserExtensionManager({
      sourceDir: this.resources.browserExtensionDir,
      targetDir: join(options.paths.rootDir, 'browser-extension'),
      dataDir: options.paths.dataDir,
      logger: {
        warn: (message, data) => this.bot.logger.warn(message, data)
      }
    })
    this.extensionInfo = this.prepareBrowserExtension()

    // 本机回环桥在 Bot 之后创建：页面只交给 BrowserWorld，绝不经日志/文件。
    this.browserBridge = new BrowserBridge({
      dataDir: join(options.paths.rootDir, 'data'),
      getConfig: () => this.bot.getConfig(),
      onPage: (payload) => {
        this.bot.ingestBrowserPage(payload)
      },
      logger: {
        log: (level, message, data) => this.bot.logger.log(level, message, data),
        debug: (message, data) => this.bot.logger.debug(message, data),
        info: (message, data) => this.bot.logger.info(message, data),
        warn: (message, data) => this.bot.logger.warn(message, data),
        error: (message, data) => this.bot.logger.error(message, data)
      }
    })
    // 主动浏览 World 与被动页面感知共享同一个回环桥，但授权/工具完全独立。
    this.bot.setBrowserControlPort(this.browserBridge)

    this.wirePresentation()

    this.petHost = new PetHostServer({
      webmDir: this.resources.dshPetWebmDir,
      petPageDir: this.resources.petPageDir,
      logger: {
        info: (message, data) => this.bot.logger.info(message, data),
        warn: (message, data) => this.bot.logger.warn(message, data),
        error: (message, data) => this.bot.logger.error(message, data)
      }
    })

    this.windows = new WindowManager({
      preloadPath: PRELOAD_PATH,
      petUrl: '',
      rendererUrl: process.env['ELECTRON_RENDERER_URL'],
      isPackaged: app.isPackaged,
      onPetGone: (reason) => {
        this.bot.logger.warn('桌宠页面退出，准备重建', { reason })
        // 页面没了，等待中的动作/移动必须立即得到真实失败结果。
        this.petAnimations.cancelAll('page-gone')
        this.petMovement.cancelAll('page-gone')
        this.petSay.cancelAll('page-gone')
        // 停靠/拖拽/菜单等占用随页面一起消失，不能留给模型过期事实。
        this.bot.petWorld.resetPresence()
        this.broadcastNotice('桌宠页面异常退出，正在尝试恢复。')
      },
      onPetWindowCreated: (win) => {
        // 自己的窗口既不能当支撑面，也不该遮住下面的上沿。
        this.perch.setExcludeHandles([nativeHandleHex(win)])
        this.perch.refresh()
      }
    })
    this.windows.setChatSize(options.loaded.config.chatUi.window)

    this.petPositions = new PetPositionStore(join(options.paths.dataDir, 'pet-position.json'))
    this.petSay = new PetSayBroker()
    this.petAnimations = new PetAnimationBroker({
      send: (request) => {
        if (!this.bot.getConfig().worlds.pet.enabled) return false
        if (!this.windows.isPetVisible || !this.windows.isPetReady) return false
        return this.windows.sendToPet(IPC.petAnimation, { request })
      },
      onReceipt: (receipt, meta) => {
        this.ambientScheduler?.noteAnimationReceipt(receipt, meta)
        // 排队后迟到的 started/rejected 也要同步张望品类时钟与语义诊断。
        this.bot.petWorld.noteAnimationReceipt(
          receipt,
          meta === null
            ? null
            : { source: meta.source, requestClass: meta.requestClass }
        )
      }
    })
    this.petMovement = new PetMovementBroker({
      send: (request) => {
        if (!this.bot.getConfig().worlds.pet.enabled) return false
        if (!this.bot.getConfig().worlds.pet.movement.enabled) return false
        if (!this.windows.isPetVisible || !this.windows.isPetReady) return false
        return this.windows.sendToPet(IPC.petMovement, { request })
      },
      onReceipt: (receipt, meta) => {
        // 只保留位置比例/朝向/固定原因枚举，供下一次模型决策参考。
        this.bot.petWorld.noteMovementReceipt(receipt)
        this.ambientScheduler?.noteMovementReceipt(receipt, meta)
      }
    })
    this.ambientScheduler = new AmbientScheduler({
      getConfig: () => {
        const pet = this.bot.getConfig().worlds.pet
        return {
          petEnabled: pet.enabled,
          reducedMotion: pet.appearance.reducedMotion,
          movementEnabled: pet.movement.enabled,
          randomIdle: { ...pet.animation.randomIdle },
          randomRoam: { ...pet.movement.randomRoam }
        }
      },
      requestAction: (request) =>
        this.petAnimations.request({
          ...request,
          // 本地随机通道永远不是用户点播；requestClass 已显式标记，模型无法伪造。
          autonomous: false,
          label: 'ambient-random'
        }),
      requestRoam: (request) =>
        this.petMovement.request({
          target: request.target,
          animationId: request.animationId,
          autonomous: true,
          requestClass: 'ambient-roam'
        }),
      logger: (event, data) => this.bot.logger.debug(`[ambient] ${event}`, data)
    })

    this.perch = new PerchService({
      scriptPath: this.resources.perchScript,
      push: (geometry) => this.windows.sendToPet(IPC.petPerchGeometry, geometry)
    })

    // 视觉模型是主通路；本地 OCR 只是可选兜底，脚本缺失也照常启动感知。
    if (!hasOcrScript) {
      this.bot.logger.warn('OCR 辅助脚本缺失，本地 OCR 兜底不可用', {
        script: this.resources.ocrScript
      })
    }
    const selfProcessNames = new Set(
      cuaSelfNames
        .map((name) => normalizeProcessName(name))
        .filter((name): name is string => name !== null)
    )
    this.vision = new VisionService({
      getConfig: () => this.bot.getConfig(),
      fetchImpl: providerFetch,
      logger: this.bot.logger,
      ocr: hasOcrScript ? new WindowsOcr({ scriptPath: this.resources.ocrScript }) : null,
      getPetWindow: () => this.windows.petWindow,
      // 空闲时仍返回最后确认的前台类别，手柄游戏/看视频不会被当成“没人”。
      currentCategory: () => this.bot.activityWorld.currentCategoryForVision(),
      foregroundContext: () => ({
        bounds: this.bot.activityWorld.foregroundBounds(),
        game: this.bot.activityWorld.currentGameName(),
        windowKey: this.bot.activityWorld.foregroundWindowKey()
      }),
      // 只有用户暂停观察、锁屏、挂起、敏感应用会停止采集；Core 忙、
      // 审批待处理、静音或空闲都不再中断观察。
      captureBlockedReason: () => this.bot.activityWorld.captureBlockedReason(),
      getApiKey: () => options.secrets.get(),
      isSensitive: () => this.bot.activityWorld.currentProcessIsSensitive(),
      // CUA 正在操作时让出截屏；桌宠自己的窗口在前台时也不观察，避免把
      // 角色/气泡/设置页当成用户的内容。
      isCuaBusy: () => this.bot.cuaWorld.isActing(),
      isSelfForeground: () => {
        const foreground = this.bot.activityWorld.foregroundProcessName()
        return foreground !== null && selfProcessNames.has(foreground)
      },
      onSceneInvalidated: (reason) => this.bot.activityWorld.invalidateScene(reason),
      onDegraded: (reason) => this.handleDegraded(reason)
    })
  }

  get botInstance(): Bot {
    return this.bot
  }

  openChatForUser(): void {
    void this.windows.openChat({ activate: true, reason: 'user' })
  }

  showPetForUser(): void {
    this.windows.showPet()
    this.ambientScheduler?.setExternalPaused('pet-hidden', false)
    this.ambientScheduler?.refresh('pet-shown')
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.bot.start()
    if (this.bot.state.get('activityPaused') === true) {
      this.bot.setActivityPaused(true)
    }
    // 只有用户开启页面感知并同意后才真正监听回环端口。
    this.browserBridge.refresh()

    const started = await this.petHost.start()
    // 宿主服务器启动后才知道实际端口。
    this.windows.setPetUrl(started.url)

    this.registerIpc()
    this.installPowerSignals()
    this.createTray()
    this.registerShortcuts()

    this.windows.createPetWindow()
    const visible = this.bot.state.get('petVisible') !== false
    if (!visible || !this.bot.getConfig().worlds.pet.enabled) this.windows.hidePet()
    this.ambientScheduler?.start()
    this.ambientScheduler?.setExternalPaused('pet-hidden', !this.windows.isPetVisible)
    this.petHost.setPhase(this.bot.petWorld.currentPresentation().phase)

    this.bot.logger.info('界面已就绪', { petPort: started.port, resumable: !this.opts.firstRun })

    if (this.opts.firstRun) {
      setTimeout(() => {
        if (!this.stopping) this.windows.openSettings()
      }, 900).unref?.()
    } else if (this.warning !== null) {
      this.broadcastNotice(this.warning)
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.ambientScheduler?.dispose()
    try {
      await this.bot.stopCua('quit')
    } catch {
      /* 退出流程不因 CUA 停止失败而卡住 */
    }
    try {
      this.bot.gate.rejectAll('应用退出')
    } catch {
      /* ignore */
    }
    try {
      this.browserBridge.stop()
    } catch {
      /* ignore */
    }
    this.unsubscribeQuickChat?.()
    this.unsubscribeQuickChat = null
    this.unsubscribeTasks?.()
    this.unsubscribeTasks = null
    this.unsubscribeStatus?.()
    this.unsubscribeStatus = null
    try {
      await this.bot.stop()
    } catch {
      /* 退出流程不因单个组件失败而卡住 */
    }
    try {
      await this.petHost.stop()
    } catch {
      /* ignore */
    }
    for (const accelerator of [
      'CommandOrControl+Shift+D',
      'CommandOrControl+Alt+Shift+Esc'
    ]) {
      try {
        globalShortcut.unregister(accelerator)
      } catch {
        /* ignore */
      }
    }
    if (this.tray !== null) {
      this.tray.destroy()
      this.tray = null
    }
    try {
      this.perch.dispose()
    } catch {
      /* 退出流程不因窗口支撑停止失败而卡住 */
    }
    this.windows.destroyAll()
  }

  // ------------------------------------------------------------------ 扩展目录

  /**
   * 幂等准备扩展目录；失败时保留上一完整版本并返回可重试错误。
   * 打开文件夹前再调用一次，用户修复文件占用后无需重启应用。
   */
  private prepareBrowserExtension(): BrowserExtensionInstallInfo {
    try {
      const info = this.browserExtension.prepare()
      this.extensionInfo = info
      if (info.error !== null) {
        this.bot.logger.warn('浏览器扩展目录未完全更新', {
          path: info.path,
          retryable: info.retryable,
          error: info.error
        })
      }
      return info
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.bot.logger.warn('浏览器扩展目录准备异常', { error: message })
      const fallback: BrowserExtensionInstallInfo =
        this.extensionInfo ?? {
          ready: false,
          path: join(this.opts.paths.rootDir, 'browser-extension'),
          version: null,
          hash: null,
          changed: false,
          created: false,
          retryable: true,
          error: message
        }
      const failed = { ...fallback, error: message }
      this.extensionInfo = failed
      return failed
    }
  }

  // ------------------------------------------------------------------ IPC 上下文

  private registerIpc(): void {
    const context: IpcContext = {
      paths: this.opts.paths,
      bot: this.bot,
      configStore: this.opts.configStore,
      secrets: this.opts.secrets,
      petHost: this.petHost,
      petPositions: this.petPositions,
      petAnimations: this.petAnimations,
      petMovement: this.petMovement,
      petSay: this.petSay,
      windows: this.windows,
      perch: this.perch,
      getConfigWarning: () => this.configWarning,
      getConfigRevision: () => this.configRevision,
      applyConfig: (next, baseRevision) => this.applyConfig(next, baseRevision),
      reportPetPageState: (state: PetPageStateSnapshot) => {
        // 等待/菜单等页面内部张望不经过 broker，也要进入主进程共享品类冷却。
        this.bot.petWorld.notePageLookAround(state.lookAround)
        this.ambientScheduler?.updatePageState(state)
      },
      getAmbientDiagnostics: () => this.ambientScheduler?.diagnostics() ?? {},
      revokeExploration: () => this.revokeExploration(),
      broadcastNotice: (message) => this.broadcastNotice(message),
      broadcastStatus: () => this.broadcastStatus(),
      refreshTray: () => this.refreshTray(),
      reloadPetPage: () => this.windows.reloadPetPage(),
      getAutoLaunch: () => this.getAutoLaunch(),
      setAutoLaunch: (enabled) => this.setAutoLaunch(enabled),
      getBrowserBridgeStatus: () => {
        const page = this.bot.browserPageStatus()
        const control = this.bot.browserControlStatus()
        return {
          enabled: page.enabled,
          consentAt: this.bot.getConfig().worlds.browserPage.consentAt,
          bridge: this.browserBridge.status(),
          page: {
            hasPage: page.hasPage,
            updatedAt: page.updatedAt,
            eventsLastHour: page.eventsLastHour,
            droppedLastHour: page.droppedLastHour
          },
          control: {
            active: control.active,
            configEnabled: control.configEnabled,
            consented: control.consented,
            explorationTabs: control.explorationTabs,
            controlConnected:
              control.bridge !== null && control.bridge.controlConnected,
            observedTabs: control.observedTabs,
            lastObservationAt: control.lastObservationAt
          },
          extension: this.extensionInfo
        }
      },
      rotateBrowserToken: () => this.browserBridge.rotateToken(),
      openBrowserExtensionFolder: async () => {
        // 打开的是持久化后的最终目录，而非可能位于临时解压区的模板。
        const info = this.prepareBrowserExtension()
        const base = {
          path: info.path,
          ready: info.ready,
          version: info.version,
          hash: info.hash,
          changed: info.changed,
          created: info.created,
          retryable: info.retryable,
          error: info.error
        }
        if (!info.ready) {
          return {
            ...base,
            ok: false,
            message: `扩展目录尚未准备好：${info.error ?? info.path}${
              info.retryable ? ' 关闭占用后可再次点击重试。' : ''
            }`
          }
        }
        const error = await shell.openPath(info.path)
        const versionText = info.version === null ? '' : ` v${info.version}`
        if (error !== '') {
          return {
            ...base,
            ok: false,
            message: `无法打开扩展目录（${error}）。可复制此路径手动打开：${info.path}`
          }
        }
        const updateNote =
          info.error === null
            ? ''
            : `扩展更新失败，当前仍使用上一完整版本：${info.error} `
        return {
          ...base,
          ok: true,
          message:
            `${updateNote}已打开扩展${versionText}：${info.path}。` +
            '在 Chrome/Edge 扩展页选择「加载已解压的扩展程序」并选中此目录；' +
            '首次安装或版本更新后需要重新载入，之后重启电脑无需再次选择。'
        }
      },
      quit: () => app.quit()
    }
    registerIpc(context)
  }

  // ------------------------------------------------------------------ 表现桥

  private wirePresentation(): void {
    this.bot.petWorld.setSink(this.petSink())
    this.bot.setTerminalSink(this.terminalSink())
    this.bot.setWebObserver(this.webObserver())
    this.bot.setCuaSink({
      // 动作标记只带全局 DIP 坐标与动作类型，不含截图/文字/标题。
      onAction: (event) => {
        const view = cuaActionView(event)
        if (view !== null) this.windows.sendToPet(IPC.petCuaAction, view)
      },
      onState: () => this.broadcastStatus()
    })

    this.bot.onTap((event) => this.windows.sendToChat(IPC.chatTap, tapView(event)))
    this.bot.onUserMessage((event) => {
      const at = Date.parse(event.ts)
      const view: ChatUserMessageEvent = {
        cursor: event.cursor,
        text: event.text,
        at: Number.isFinite(at) ? at : Date.now()
      }
      this.windows.sendToChat(IPC.chatUserMessage, view)
    })
    this.bot.onApprovalRequest((request) => this.onApprovalRequest(request))
    this.bot.onApprovalResolved((request, decision) => this.onApprovalResolved(request, decision))
    this.bot.onApprovalPendingChange(() => this.broadcastStatus())
    this.bot.onBiliReport((report) => this.onBiliReport(report))
    this.bot.core.onPhase(() => this.broadcastStatus())
    // 快捷聊天事件只送到桌宠页；它不经过 chat 通道，也不进入主会话。
    this.unsubscribeQuickChat = this.bot.quickChat.onEvent((event) => {
      this.windows.sendToPet(IPC.quickEvent, event)
      // 工具/CUA 相位会改变状态条与桌宠表情；文本 delta 不需要重广播。
      if (event.type === 'phase' || event.type === 'tool' || event.type === 'notice') {
        this.broadcastStatus()
      }
    })
    // 任务状态（脱敏视图）同时推给设置页与桌宠页；不触发聊天窗口聚焦。
    this.unsubscribeTasks = this.bot.onTasksChanged((tasks) => {
      this.windows.sendToSettings(IPC.settingsTaskChanged, tasks)
      this.windows.sendToPet(IPC.petTaskChanged, tasks)
      this.broadcastStatus()
    })
    // Episode/节奏/安静/探索暂停等真实状态变化：不依赖下一条无关事件才刷新。
    this.unsubscribeStatus = this.bot.onStatusChanged(() => this.broadcastStatus())
  }

  private petSink(): PetPresentationSink {
    const canDeliver = (): boolean =>
      this.bot.getConfig().worlds.pet.enabled &&
      this.windows.isPetVisible &&
      this.windows.isPetReady
    return {
      onPhase: (presentation) => {
        this.petHost.setPhase(presentation.phase)
        this.windows.sendToPet(IPC.petAgentStatus, this.petStatusView())
      },
      onSay: (say) => {
        const event: PetSayEvent = {
          text: say.text,
          preset: say.preset,
          ttlMs: say.ttlMs,
          ...(say.episodeId === undefined ? {} : { episodeId: say.episodeId }),
          ...(say.animationNotice === undefined
            ? {}
            : { animationNotice: say.animationNotice })
        }
        if (say.animation === undefined) {
          // IPC 发送成功不等于气泡显示；必须等页面针对 sayId 回执。
          return this.petSay
            .request((sayId) => {
              if (!canDeliver()) return false
              return this.windows.sendToPet(IPC.petSay, { ...event, sayId })
            })
            .then((display) => ({
              displayed: display.displayed,
              animation: null,
              ...(display.reason === undefined ? {} : { reason: display.reason })
            }))
        }
        // 气泡与动作同一条事件发送；文字是否显示仍由页面回执决定，
        // 动作失败不影响文字成功。
        const animationIntent = say.animation
        let bubbleSent = false
        let animationPromise: Promise<PetAnimationOutcome> = Promise.resolve({
          status: 'failed',
          animationId: animationIntent.animationId,
          reason: 'page-unavailable'
        })
        const displayPromise = this.petSay.request((sayId) => {
          animationPromise = this.petAnimations.request(animationIntent, (request) => {
            if (!canDeliver()) return false
            const sent = this.windows.sendToPet(IPC.petSay, {
              ...event,
              sayId,
              animation: request
            })
            if (sent) bubbleSent = true
            return sent
          })
          // 动画请求没有真正发出气泡时立即让等待方失败，不必等超时。
          if (!bubbleSent) this.petSay.cancel(sayId, 'page-unavailable')
          return bubbleSent
        })
        return Promise.all([displayPromise, animationPromise]).then(
          ([display, animation]) => ({
            displayed: display.displayed,
            animation,
            ...(display.reason === undefined ? {} : { reason: display.reason })
          })
        )
      },
      onAnimate: (intent) => this.petAnimations.request(intent),
      onWalkTo: (walk) => {
        if (!canDeliver()) {
          return {
            status: 'failed' as const,
            animationId: walk.animationId,
            target: walk.target,
            reason: 'page-unavailable'
          }
        }
        return this.petMovement.request({
          target: walk.target,
          animationId: walk.animationId,
          autonomous: walk.autonomous === true,
          ...(walk.requestClass === undefined ? {} : { requestClass: walk.requestClass }),
          ...(walk.dedupeKey === undefined ? {} : { dedupeKey: walk.dedupeKey }),
          ...(walk.expiresAt === undefined ? {} : { expiresAt: walk.expiresAt })
        })
      },
      onQuiet: (quiet) => {
        this.windows.sendToPet(IPC.petQuiet, quiet)
      },
      onOpenChat: (reason) => {
        void this.windows.openChat({ activate: true, reason: reason.slice(0, 200) })
      }
    }
  }

  private terminalSink(): TerminalSink {
    return {
      onStarted: (info) => {
        const event: ChatTerminalEvent = {
          stream: 'started',
          text: '',
          command: info.command,
          cwd: info.cwd
        }
        this.windows.sendToChat(IPC.chatTerminal, event)
      },
      onOutput: (output) => {
        const event: ChatTerminalEvent = {
          stream: output.stream,
          text: truncate(output.text, 64_000),
          command: output.command
        }
        this.windows.sendToChat(IPC.chatTerminal, event)
      }
    }
  }

  private webObserver(): WebObserver {
    return {
      onSearch: (query) => {
        const event: ChatWebEvent = { kind: 'search', target: truncate(query, 500) }
        this.windows.sendToChat(IPC.chatWeb, event)
      },
      onFetch: (url) => {
        const event: ChatWebEvent = { kind: 'fetch', target: truncate(url, 1000) }
        this.windows.sendToChat(IPC.chatWeb, event)
      }
    }
  }

  // ------------------------------------------------------------------ 审批

  /**
   * B 站一轮阅读结束：完整报告只写入聊天记录，桌宠可见时另发一条迷你卡。
   * 这里不打开聊天窗、不闪任务栏——分享不是审批，不应打断用户。
   */
  private onBiliReport(report: BiliSessionReportView): void {
    deliverBiliReport(
      report,
      {
        petEnabled: this.bot.getConfig().worlds.pet.enabled,
        petVisible: this.windows.isPetVisible,
        petReady: this.windows.isPetReady
      },
      {
        sendToChat: (next) => this.windows.sendToChatWindow(IPC.chatBiliReport, next),
        sendToPet: (event) => this.windows.sendToPet(IPC.petBiliReport, event)
      }
    )
  }

  private onApprovalRequest(request: ApprovalRequest): void {
    // 桌宠可见且就绪时只弹角色气泡；用户点气泡后才打开完整审批卡。
    // 桌宠不可用时保留原有自动打开行为，机械审批入口始终可达。
    const bubbleAvailable = canShowPetBubble({
      petEnabled: this.bot.getConfig().worlds.pet.enabled,
      petVisible: this.windows.isPetVisible,
      petReady: this.windows.isPetReady
    })
    if (request.origin === 'quick') {
      // 快捷审批事件仍要送到桌宠页；面板只在气泡不可用时自动展开。
      this.windows.sendToPet(IPC.quickEvent, {
        type: 'approval',
        id: this.bot.quickChat.snapshot().turnId ?? request.id,
        approval: request
      })
      if (!bubbleAvailable) {
        this.windows.sendToPet(IPC.petOpenQuick, { approvalId: request.id })
      }
      this.broadcastStatus()
      return
    }
    const event: ChatApprovalEvent = {
      approval: request,
      all: this.bot.listApprovals('chat')
    }
    this.windows.sendToChat(IPC.chatApproval, event)
    if (!bubbleAvailable) {
      void this.windows.openChat({ activate: false, reason: 'approval', flash: true })
    }

    if (Notification.isSupported()) {
      try {
        const notification = new Notification({
          title: '桌宠需要你的确认',
          body: `${request.toolName}：${truncate(request.summary, 120)}`,
          silent: false
        })
        notification.on('click', () => {
          void this.windows.openChat({ activate: true, reason: 'approval' })
        })
        notification.show()
      } catch {
        /* 系统通知不可用不影响审批卡片 */
      }
    }
    this.broadcastStatus()
  }

  private onApprovalResolved(request: ApprovalRequest, decision: ApprovalDecision): void {
    if (request.origin === 'quick') {
      this.windows.sendToPet(IPC.quickEvent, {
        type: 'approval-cleared',
        id: this.bot.quickChat.snapshot().turnId ?? request.id,
        approvalId: request.id,
        approved: decision.approved
      })
      this.broadcastStatus()
      return
    }
    const event: ChatApprovalClearedEvent = {
      id: request.id,
      approved: decision.approved,
      all: this.bot.listApprovals('chat')
    }
    this.windows.sendToChat(IPC.chatApprovalCleared, event)
    this.broadcastStatus()
  }

  // ------------------------------------------------------------------ 状态广播

  broadcastStatus(): void {
    const snapshot: UiPhaseSnapshot = phaseSnapshot(this.bot)
    this.windows.sendToChat(IPC.chatPhase, snapshot)
    this.windows.sendToChat(IPC.chatStatus, snapshot)
    this.windows.sendToPet(IPC.petAgentStatus, this.petStatusView())
    this.refreshTray()
  }

  private petStatusView(): PetAgentStatusView {
    return petStatus(this.bot, this.bot.isPaused())
  }

  broadcastNotice(message: string): void {
    const text = message.trim()
    if (text === '') return
    this.windows.sendToSettings(IPC.settingsNotice, text)
    if (this.tray !== null) {
      try {
        this.tray.setToolTip(`桌宠 · ${truncate(text, 100)}`)
      } catch {
        /* ignore */
      }
    }
  }

  private handleDegraded(reason: string): void {
    this.degradedReason = reason
    this.broadcastNotice(`行为感知已降级：${reason}。可在设置 → 行为感知中关闭。`)
  }

  // ------------------------------------------------------------------ 配置

  private applyConfig(raw: AppConfig, baseRevision?: number): SaveConfigResult {
    const previous = this.bot.getConfig()
    if (baseRevision !== undefined && baseRevision !== this.configRevision) {
      return {
        ok: false,
        config: previous,
        revision: this.configRevision,
        conflict: true,
        message: '配置已在别处更新。你的草稿仍保留；请先查看新配置再决定是否覆盖。'
      }
    }
    const next = normalizeConfig(raw)
    try {
      this.opts.configStore.save(next)
    } catch {
      return {
        ok: false,
        config: previous,
        revision: this.configRevision,
        message: '配置保存失败，请检查磁盘权限。'
      }
    }
    this.configRevision += 1
    this.bot.updateConfig(next)
    this.windows.setChatSize(next.chatUi.window)
    // 页面感知开关/同意变化时启停回环桥；关闭后不会再接收页面。
    this.browserBridge.refresh()
    // 桌宠页只在启动时 bootstrap 一次；保存后热更新表现层与快捷输入配置。
    const previousPet = previous.worlds.pet
    const nextPet = next.worlds.pet
    if (!next.worlds.pet.enabled) {
      this.petHost.setPhase('idle')
      this.petAnimations.cancelAll('pet-disabled')
      this.petMovement.cancelAll('pet-disabled')
      this.petSay.cancelAll('pet-disabled')
      this.windows.hidePet()
    } else if (!previous.worlds.pet.enabled) {
      this.windows.showPet()
    }
    const petHiddenNow = !this.windows.isPetVisible
    this.ambientScheduler?.setExternalPaused('pet-hidden', petHiddenNow)
    this.ambientScheduler?.refresh('config')
    if (previousPet.movement.enabled && !nextPet.movement.enabled) {
      this.petMovement.cancelAll('movement-disabled')
    }
    const presentationChanged =
      JSON.stringify({
        appearance: previousPet.appearance,
        animation: previousPet.animation,
        physics: previousPet.physics,
        confineToScreen: previousPet.confineToScreen,
        movement: previousPet.movement
      }) !==
      JSON.stringify({
        appearance: nextPet.appearance,
        animation: nextPet.animation,
        physics: nextPet.physics,
        confineToScreen: nextPet.confineToScreen,
        movement: nextPet.movement
      })
    if (presentationChanged) {
      this.windows.sendToPet(IPC.petSettings, {
        appearance: { ...nextPet.appearance, home: { ...nextPet.appearance.home } },
        animation: {
          ...nextPet.animation,
          idleActions: { ...nextPet.animation.idleActions }
        },
        physics: { ...nextPet.physics },
        confineToScreen: nextPet.confineToScreen,
        movement: {
          enabled: nextPet.movement.enabled,
          pauseWithPanel: nextPet.movement.pauseWithPanel,
          autonomousMinIntervalMs: nextPet.movement.autonomousMinIntervalMs,
          randomRoam: { ...nextPet.movement.randomRoam }
        } satisfies PetMovementView,
        lookAroundCooldownUntil: this.bot.petWorld.lookAroundCooldownUntil()
      } satisfies PetSettingsEvent)
    }
    if (JSON.stringify(previous.chatUi) !== JSON.stringify(next.chatUi)) {
      this.windows.sendToPet(IPC.petChatUi, {
        quickInput: { ...next.chatUi.quickInput },
        petClickAction: next.chatUi.petClickAction
      } satisfies PetChatUiEvent)
    }
    this.broadcastStatus()
    return { ok: true, config: next, revision: this.configRevision }
  }

  /**
   * 立即撤销自由探索。只修改已保存配置里的授权字段，不读取也不提交设置页
   * 草稿；Bot.updateConfig 会让排队/运行中的自主任务与旧 grant 立即失效。
   */
  private revokeExploration(): RevokeExplorationResult {
    const current = this.bot.getConfig()
    const next = normalizeConfig({
      ...current,
      exploration: {
        ...current.exploration,
        enabled: false,
        grantedAt: null,
        sessionExpiresAt: null,
        web: false,
        browserTabs: false,
        apps: false,
        windows: false,
        fullScreen: false,
        fileRead: false,
        artifacts: false,
        edits: false,
        includeProfile: false
      }
    })
    const applied = this.applyConfig(next)
    return {
      ok: applied.ok,
      message: applied.ok
        ? '自由探索授权已立即撤销；相关任务、标签页与文件范围随之失效。'
        : applied.message ?? '撤销自由探索失败。',
      config: applied.config,
      revision: applied.revision,
      capabilitySnapshot: {
        ...this.bot.capabilitySnapshot(),
        configRevision: applied.revision
      }
    }
  }

  private getAutoLaunch(): boolean {
    if (!app.isPackaged) return false
    try {
      return app.getLoginItemSettings().openAtLogin
    } catch {
      return false
    }
  }

  private setAutoLaunch(enabled: boolean): boolean {
    if (!app.isPackaged) {
      this.broadcastNotice('开发模式下不写入开机启动项；打包后可用。')
      return false
    }
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
      return app.getLoginItemSettings().openAtLogin
    } catch {
      this.broadcastNotice('设置开机启动失败。')
      return false
    }
  }

  // ------------------------------------------------------------------ 托盘

  private createTray(): void {
    if (this.tray !== null) return
    let image = nativeImage.createFromPath(this.resources.trayIcon)
    if (image.isEmpty()) {
      image = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAk0lEQVR4nK1T2w2AIAxkQEdwBUZwhRuGGegwxAH8MlW0JD4K0RSSSwjpXY8+nFMOiAcQexBPgnwftFiNCBBHEKedvAqSvKEqBOIRxEEIXMEqMaOWOTSIT4SbE7HWyqw5wTV7/EEuiIcLqXDSgublREUgc7yTNr3sF3JDJHOmLgLmL9iKaG5jl0Eyj3KXZVKEPq3zBtSVma9B+6ocAAAAAElFTkSuQmCC'
      )
    }
    this.tray = new Tray(image)
    this.tray.setToolTip('桌宠 · 在线')
    this.tray.on('click', () => {
      void this.windows.openChat({ activate: true, reason: 'user' })
    })
    this.tray.on('double-click', () => {
      void this.windows.openChat({ activate: true, reason: 'user' })
    })
    this.refreshTray(true)
  }

  private refreshTray(force = false): void {
    if (this.tray === null) return
    const config = this.bot.getConfig()
    const paused = this.bot.isPaused()
    if (this.trayPaused !== paused) {
      this.trayPaused = paused
      // 暂停时托盘图标叠加橙色圆点（PLAN.md §7.4）。
      const iconPath = paused ? this.resources.trayPausedIcon : this.resources.trayIcon
      let image = nativeImage.createFromPath(iconPath)
      if (image.isEmpty()) image = nativeImage.createFromPath(this.resources.trayIcon)
      if (!image.isEmpty()) this.tray.setImage(image)
    }
    const tooltip = `桌宠 · ${
      paused ? '已暂停' : this.bot.isBusy() ? '处理中' : '在线'
    }`
    if (tooltip !== this.lastTooltip) {
      this.lastTooltip = tooltip
      try {
        this.tray.setToolTip(tooltip)
      } catch {
        /* ignore */
      }
    }
    const key = [
      String(this.windows.isPetVisible),
      String(config.worlds.pet.movement.enabled),
      String(paused),
      String(this.bot.isActivityPaused()),
      String(config.worlds.activity.enabled)
    ].join('|')
    if (!force && key === this.trayKey) return
    this.trayKey = key
    const menu = Menu.buildFromTemplate([
      {
        label: this.windows.isPetVisible ? '隐藏桌宠' : '显示桌宠',
        click: () => {
          this.windows.togglePet()
          const visible = this.windows.isPetVisible
          this.bot.state.set('petVisible', visible)
          this.ambientScheduler?.setExternalPaused('pet-hidden', !visible)
          if (visible) this.ambientScheduler?.refresh('pet-shown')
          this.refreshTray()
        }
      },
      {
        label: '和桌宠聊聊',
        click: () => {
          void this.windows.openChat({ activate: true, reason: 'user' })
        }
      },
      {
        label: '设置…',
        click: () => this.windows.openSettings()
      },
      { type: 'separator' },
      {
        label: '归位',
        click: () => {
          this.bot.notifyUserInteraction()
          this.windows.sendToPet(IPC.petCommand, 'reset' satisfies PetCommand)
        }
      },
      {
        label: '允许走动',
        type: 'checkbox',
        checked: config.worlds.pet.movement.enabled,
        click: (item) => {
          const current = this.bot.getConfig()
          const next = normalizeConfig({
            ...current,
            worlds: {
              ...current.worlds,
              pet: {
                ...current.worlds.pet,
                movement: { ...current.worlds.pet.movement, enabled: item.checked }
              }
            }
          })
          const result = this.applyConfig(next)
          if (!result.ok) this.broadcastNotice(result.message ?? '保存走动设置失败。')
          else this.refreshTray()
        }
      },
      {
        label: '刷新桌宠页面',
        click: () => this.windows.reloadPetPage()
      },
      { type: 'separator' },
      {
        label: '暂停对话',
        type: 'checkbox',
        checked: this.bot.isPaused(),
        click: (item) => {
          if (item.checked) this.bot.pause('tray')
          else this.bot.resume()
          this.broadcastStatus()
        }
      },
      {
        label: '暂停行为感知',
        type: 'checkbox',
        checked: this.bot.isActivityPaused(),
        enabled: config.worlds.activity.enabled,
        click: (item) => {
          this.bot.setActivityPaused(item.checked)
          this.bot.state.set('activityPaused', item.checked)
          this.windows.sendToSettings(IPC.settingsActivityChanged)
          this.refreshTray()
        }
      },
      { type: 'separator' },
      {
        label: this.degradedReason === null ? '退出' : '退出（行为感知已降级）',
        click: () => app.quit()
      }
    ])
    this.tray.setContextMenu(menu)
  }

  /** 打开聊天窗：双击角色、托盘、全局快捷键（PLAN.md §7.5）。 */
  private registerShortcuts(): void {
    this.registerShortcut('CommandOrControl+Shift+D', () => {
      if (!this.stopping) this.openChatForUser()
    })
    // CUA 的物理停止入口：即使焦点在别的应用，也能立即释放键盘/鼠标。
    this.registerShortcut('CommandOrControl+Alt+Shift+Esc', () => {
      if (this.stopping) return
      void this.bot
        .stopCua('hotkey')
        .catch(() => undefined)
        .finally(() => this.broadcastStatus())
    })
  }

  private registerShortcut(accelerator: string, handler: () => void): void {
    try {
      const ok = globalShortcut.register(accelerator, handler)
      if (!ok) {
        this.bot.logger.warn('全局快捷键注册失败，可能已被其他程序占用', { accelerator })
      }
    } catch (error) {
      this.bot.logger.warn('全局快捷键注册异常', {
        accelerator,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private installPowerSignals(): void {
    const send = (suspended: boolean): void => {
      this.windows.sendToPet(IPC.petPower, { suspended })
      this.broadcastStatus()
    }
    const stopCua = (reason: string): void => {
      void this.bot
        .stopCua(reason)
        .catch(() => undefined)
        .finally(() => this.broadcastStatus())
    }
    powerMonitor.on('suspend', () => {
      this.bot.coordinator.lock('系统挂起')
      this.ambientScheduler?.setExternalPaused('suspend', true)
      stopCua('suspend')
      send(true)
    })
    powerMonitor.on('resume', () => {
      this.bot.coordinator.unlock()
      this.ambientScheduler?.setExternalPaused('suspend', false)
      send(false)
    })
    // 锁屏意味着用户可能离开电脑或正在输入密码；CUA 与任务必须立刻停下。
    powerMonitor.on('lock-screen', () => {
      this.bot.coordinator.lock('锁屏')
      this.ambientScheduler?.setExternalPaused('lock', true)
      stopCua('lock')
    })
    powerMonitor.on('unlock-screen', () => {
      // 解锁只释放系统锁；用户接管保持期仍要等新的用户输入或显式恢复。
      this.bot.coordinator.unlock()
      this.ambientScheduler?.setExternalPaused('lock', false)
      this.broadcastStatus()
    })
    powerMonitor.once('shutdown', () => app.quit())
  }

  private onPower(
    event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume',
    listener: () => void
  ): () => void {
    const handler = (): void => listener()
    const emitter = powerMonitor as unknown as {
      on(name: string, fn: () => void): void
      removeListener(name: string, fn: () => void): void
    }
    emitter.on(event, handler)
    return () => {
      emitter.removeListener(event, handler)
    }
  }
}

// ---------------------------------------------------------------------------
// Tap 转换
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（截断）`
}

/** CUA 世界动作 → 桌宠页本地 CSS 像素；不支持的类型不画标记。 */
function cuaActionView(event: CuaActionEvent): PetCuaActionEvent | null {
  let kind: PetCuaActionEvent['kind']
  switch (event.kind) {
    case 'screenshot':
    case 'zoom':
      kind = 'screenshot'
      break
    case 'click':
    case 'drag':
    case 'type':
    case 'key':
    case 'scroll':
      kind = event.kind
      break
    case 'wait':
    case 'stop':
      return null
  }
  const union = petWorkAreaUnion()
  return {
    kind,
    x: Math.round(event.x - union.x),
    y: Math.round(event.y - union.y),
    ...(event.toX === undefined ? {} : { toX: Math.round(event.toX - union.x) }),
    ...(event.toY === undefined ? {} : { toY: Math.round(event.toY - union.y) })
  }
}

function tapView(event: TapEvent): ChatTapEvent {
  switch (event.type) {
    case 'batch_start':
      return { type: 'batch_start', count: event.events.length, proactive: event.proactive }
    case 'assistant_start':
      return { type: 'assistant_start' }
    case 'text_delta':
      return { type: 'text_delta', text: truncate(event.text, 64_000) }
    case 'reasoning_delta':
      return { type: 'reasoning_delta', text: truncate(event.text, 32_000) }
    case 'tool_call_start':
      return { type: 'tool_call_start', id: event.id, name: event.name }
    case 'tool_call_args':
      return { type: 'tool_call_args', id: event.id, delta: truncate(event.delta, 32_000) }
    case 'tool_result':
      return {
        type: 'tool_result',
        id: event.id,
        name: event.name,
        text: truncate(event.text, 64_000),
        failed: event.failed
      }
    case 'conversation_append':
      return { type: 'conversation_append', history: event.history }
    case 'conversation_reset':
      return { type: 'conversation_reset' }
    case 'assistant_end':
      return {
        type: 'assistant_end',
        text: truncate(event.text, 128_000),
        aborted: event.aborted
      }
    case 'usage':
      return { type: 'usage', usage: event.usage }
    case 'turn_end':
      return {
        type: 'turn_end',
        outcome: event.outcome,
        failure: turnFailureView(event.report)
      }
    case 'batch_end':
      return {
        type: 'batch_end',
        outcome: event.outcome,
        failure: turnFailureView(event.report)
      }
  }
}

/** 原生窗口句柄 → 小写十六进制（与常驻几何助手的排除列表一致）。 */
function nativeHandleHex(win: BrowserWindow): string {
  const buffer = win.getNativeWindowHandle()
  if (buffer.length >= 8) return buffer.readBigUInt64LE(0).toString(16)
  return buffer.readUInt32LE(0).toString(16)
}
