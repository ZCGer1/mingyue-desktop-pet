import type {
  AppConfig,
  DesktopScopeApp,
  SystemAppEntry
} from './config'
import {
  effectiveExploration,
  isExplorationDomainExcluded,
  type EffectiveExploration
} from './exploration'
import { normalizeProcessKey } from './processName'

/**
 * 用户配置实际允许她去的地方。
 *
 * 这份视图只描述「范围」，不铸造任何授权：任务 grant 仍由 TasksWorld 在
 * 同一份范围上收窄，执行时 CapabilityStore 还会逐次复验。提示词、自主 tick
 * 与诊断共用它，避免一个开关已开、另一个范围仍为空却显示“探索已开启”。
 */
export interface EffectiveCapabilities {
  /** 工作区根目录可用。 */
  workspaceRoot: boolean
  /** 笔记目录已配置；`notesAvailable` 才是当前 realpath 可用的结果。 */
  notesConfigured: boolean
  notesAvailable: boolean
  trustedRoots: number
  /** 用户在「文件显式目录」里加入的根；与自由探索无关的基础读取授权。 */
  fileWorldRoots: number
  /** 至少存在一个文件读取来源（工作区/笔记/信任目录/文件显式目录/自由探索）。 */
  fileReadConfigured: boolean
  observeApps: DesktopScopeApp[]
  inputApps: DesktopScopeApp[]
  /**
   * 系统应用白名单里具有可验证启动目标的应用。这是唯一的显式应用授权
   * 来源：加入并保存后即可进入任务授权范围，执行时仍按最新配置复验。
   */
  launchableApps: SystemAppEntry[]
  web: boolean
  browserPage: boolean
  /** 主动浏览器世界已开启、已同意，且自由探索允许她自己的标签页。 */
  browserControl: boolean
  /**
   * B 站独立 API 阅读已开启并完成新的 API 同意，且自由探索仍在有效期内。
   * 不依赖浏览器标签页、扩展配对或扩展控制同意。
   */
  bilibili: boolean
  terminal: boolean
  /** 完整 CUA 前置条件：开关、键鼠同意、截图同意与图片输入。 */
  cua: boolean
  /** 「自由探索」的当前有效范围（含 session 到期判断）。 */
  exploration: EffectiveExploration
  /** 普通应用类别授权：发现/启动/激活不再要求逐应用白名单。 */
  ordinaryApps: boolean
  /** 窗口类别授权。 */
  windowsCategory: boolean
  /** 整屏/多显示器观察的额外授权。 */
  fullScreenObserve: boolean
  /** 宽范围只读文件探索。 */
  fileReadCategory: boolean
  /** 她自己的作品空间可用（目录已配置）。 */
  artifactsAvailable: boolean
  /** 用户原始文件编辑授权。 */
  editsEnabled: boolean
}

export interface EffectiveCapabilitiesOptions {
  /**
   * 笔记目录 realpath 是否可用。设置页只有配置值时可省略；Bot/任务层
   * 应传入 workspace guard 的结果，避免目录被删除后仍显示可写。
   */
  notesRootAvailable?: boolean
  /** 诊断/测试可注入固定时间，避免 session 授权在边界上抖动。 */
  now?: number
}

export function effectiveCapabilities(
  config: AppConfig,
  options: EffectiveCapabilitiesOptions = {}
): EffectiveCapabilities {
  const desktop = config.worlds.desktop
  const observeApps = desktop.apps.filter((app) => app.observe)
  const inputApps = observeApps.filter((app) => app.input)
  const system = config.worlds.system
  const launchableApps = system.enabled
    ? system.apps.filter((app) => normalizeProcessKey(app.path) !== null)
    : []
  const notesConfigured = config.worlds.workspace.notesRoot.trim() !== ''
  const cua = config.worlds.cua
  const now = options.now ?? Date.now()
  const exploration = effectiveExploration(config, now)
  const browserControlConfig = config.worlds.browserControl
  const bilibiliConfig = config.worlds.bilibili
  return {
    workspaceRoot: config.worlds.workspace.root.trim() !== '',
    notesConfigured,
    notesAvailable: options.notesRootAvailable ?? notesConfigured,
    trustedRoots: config.autonomy.trustedRoots.filter((root) => root.trim() !== '').length,
    fileWorldRoots: config.worlds.files.roots.filter((root) => root.trim() !== '').length,
    fileReadConfigured:
      config.worlds.workspace.root.trim() !== '' ||
      notesConfigured ||
      config.autonomy.trustedRoots.some((root) => root.trim() !== '') ||
      config.worlds.files.roots.some((root) => root.trim() !== '') ||
      exploration.active,
    observeApps,
    inputApps,
    launchableApps,
    web: config.worlds.web.enabled,
    browserPage:
      config.worlds.browserPage.enabled && config.worlds.browserPage.consentAt !== null,
    browserControl:
      browserControlConfig.enabled &&
      browserControlConfig.consentAt !== null &&
      exploration.browserTabs,
    bilibili:
      bilibiliConfig.enabled &&
      bilibiliConfig.consentAt !== null &&
      exploration.active &&
      !isExplorationDomainExcluded(exploration, 'bilibili.com'),
    terminal: config.worlds.terminal.enabled,
    cua:
      cua.enabled &&
      typeof cua.consentAt === 'number' &&
      typeof cua.screenConsentAt === 'number' &&
      config.provider.visionInput === true,
    exploration,
    ordinaryApps: exploration.apps,
    windowsCategory: exploration.windows,
    fullScreenObserve: exploration.fullScreen,
    fileReadCategory: exploration.fileRead,
    artifactsAvailable: exploration.artifacts && exploration.artifactRoot !== null,
    editsEnabled: exploration.edits
  }
}

/**
 * 可选的运行时事实。省略表示「尚未检查」；调用方已知扩展未连接、辅助程序
 * 故障等事实时应传入 false，避免仅凭授权布尔值就判定探索可用。
 */
export interface ExploreScopeRuntime {
  web?: boolean
  browserPage?: boolean
  browserControl?: boolean
  bilibili?: boolean
  apps?: boolean
  windows?: boolean
  cua?: boolean
  files?: boolean
  workspace?: boolean
}

/**
 * 探索是否有任何真实可执行的范围。
 *
 * 每一项都必须同时满足「World 前置条件」和「实际目标」：类别授权只有在
 * 自由探索有效时才算数；整屏观察需要 CUA 开关、同意与图片输入齐备；文件
 * 范围需要真实目录；文件显式目录是基础授权，不依赖自由探索开关。
 * 输入范围（整屏观察）只有在键鼠/截图能力就绪时才计入。
 */
export function hasExploreScope(
  caps: EffectiveCapabilities,
  runtime: ExploreScopeRuntime = {}
): boolean {
  const ex = caps.exploration
  const filesReady = runtime.files !== false
  const workspaceReady = runtime.workspace !== false
  const workspaceRead =
    workspaceReady &&
    (caps.workspaceRoot || caps.notesAvailable || caps.trustedRoots > 0)
  const fileWorldRead = filesReady && caps.fileWorldRoots > 0
  const explorationFileRead =
    ex.active &&
    filesReady &&
    (ex.readRoots.length > 0 ||
      (ex.includeProfile && workspaceReady) ||
      (ex.fileRead && ex.volumeScope !== 'explicit'))
  const webRead = caps.web && runtime.web !== false
  const browserPageRead = caps.browserPage && runtime.browserPage !== false
  const browserTabs =
    ex.browserTabs && caps.browserControl && runtime.browserControl !== false
  const bilibiliRead = caps.bilibili && runtime.bilibili !== false
  const appLaunch = runtime.apps !== false && caps.launchableApps.length > 0
  const appExplore = ex.apps && runtime.apps !== false
  const observeWindows = caps.observeApps.length > 0 && runtime.windows !== false
  const exploreWindows = ex.windows && runtime.windows !== false
  const fullScreen = ex.fullScreen && caps.cua && runtime.cua !== false
  const artifacts = caps.artifactsAvailable && filesReady
  return Boolean(
    workspaceRead ||
      fileWorldRead ||
      explorationFileRead ||
      webRead ||
      browserPageRead ||
      browserTabs ||
      bilibiliRead ||
      appLaunch ||
      appExplore ||
      observeWindows ||
      exploreWindows ||
      fullScreen ||
      artifacts
  )
}

/** 诊断/设置页用的脱敏摘要：只有计数与布尔值，不含路径、进程名或标题。 */
export function effectiveScopeSummary(caps: EffectiveCapabilities): {
  notes: boolean
  workspace: boolean
  trustedRoots: number
  files: number
  observeApps: number
  inputApps: number
  launchApps: number
  web: boolean
  browserPage: boolean
  browserControl: boolean
  bilibili: boolean
  terminal: boolean
  exploration: boolean
  explorationWeb: boolean
  explorationTabs: boolean
  explorationApps: boolean
  explorationWindows: boolean
  explorationFullScreen: boolean
  explorationFiles: boolean
  explorationArtifacts: boolean
  explorationEdits: boolean
  explorationReadRoots: number
  explorationExcludedDomains: number
  explorationExcludedApps: number
} {
  return {
    notes: caps.notesAvailable,
    workspace: caps.workspaceRoot,
    trustedRoots: caps.trustedRoots,
    files: caps.fileWorldRoots,
    observeApps: caps.observeApps.length,
    inputApps: caps.inputApps.length,
    launchApps: caps.launchableApps.length,
    web: caps.web,
    browserPage: caps.browserPage,
    browserControl: caps.browserControl,
    bilibili: caps.bilibili,
    terminal: caps.terminal,
    exploration: caps.exploration.active,
    explorationWeb: caps.exploration.web,
    explorationTabs: caps.exploration.browserTabs,
    explorationApps: caps.exploration.apps,
    explorationWindows: caps.exploration.windows,
    explorationFullScreen: caps.exploration.fullScreen,
    explorationFiles: caps.exploration.fileRead,
    explorationArtifacts: caps.exploration.artifacts,
    explorationEdits: caps.exploration.edits,
    explorationReadRoots: caps.exploration.readRoots.length,
    explorationExcludedDomains: caps.exploration.excludedDomains.length,
    explorationExcludedApps: caps.exploration.excludedApps.length
  }
}
