import type { AppConfig } from './config'
import type { BiliLoginState, BiliPhase } from './bilibili'
import {
  effectiveCapabilities,
  type EffectiveCapabilities
} from './effectiveCapabilities'
import { isExplorationDomainExcluded } from './exploration'

/**
 * 统一的电脑能力快照。
 *
 * 它把「已保存的授权」「World 的配置前置条件」和「主进程刚刚观察到的运行时
 * 事实」放在同一份只读视图里，供设置页、探索调度、诊断与提示词共同使用。
 * 快照不是授权：真正执行时 CapabilityStore 仍会按当前配置逐次复验。
 *
 * 这里只放状态、计数和可操作的原因，不放目录、进程名、窗口标题、URL 或
 * 页面内容，因此可以安全地进入诊断包。
 */
export type CapabilityState =
  | 'unauthorized'
  | 'disabled'
  | 'pending-connection'
  | 'missing-consent'
  | 'directory-unavailable'
  | 'expired'
  | 'ready'
  | 'fault'
  /** 部分路径可用、部分仍被阻塞；比 ready 更诚实。 */
  | 'limited'

export type SettingsPageId =
  | 'overview'
  | 'companion'
  | 'computer'
  | 'activity'
  | 'model'
  | 'privacy'
  | 'advanced'

export interface CapabilityFixView {
  page: SettingsPageId
  anchor: string
}

export interface CapabilityCheckView {
  id: string
  label: string
  state: CapabilityState
  /** 面向用户的具体原因；ready 时为 null。 */
  reason: string | null
  /** 一键跳转到能修复这一项的控件。 */
  fix: CapabilityFixView
}

export type CapabilityCardId = 'web' | 'bilibili' | 'apps' | 'screen' | 'files' | 'artifacts'

export interface CapabilityCardView {
  id: CapabilityCardId
  title: string
  summary: string
  /** 已保存的授权范围，来自配置而不是未保存的草稿。 */
  access: string[]
  state: CapabilityState
  checks: CapabilityCheckView[]
  fix: CapabilityFixView
}

export interface CapabilitySnapshotView {
  generatedAt: number
  /** 生成快照时主进程的配置版本；设置页用它判断外部修改。 */
  configRevision: number
  exploration: {
    enabled: boolean
    active: boolean
    scope: 'session' | 'always'
    expiresAt: number | null
  }
  cards: CapabilityCardView[]
}

/**
 * 运行时事实。所有字段都可缺省：设置页/单元测试只有配置时仍能生成快照，
 * 但会把未检查的项标成 ready 之外的保守状态由调用方决定。主进程应尽量填全。
 */
export interface CapabilityRuntimeFacts {
  notesRootAvailable?: boolean
  workspaceRootAvailable?: boolean
  artifactRootAvailable?: boolean
  readRootsConfigured?: number
  readRootsAvailable?: number
  /**
   * 统一文件范围解析结果（脱敏计数）。它同时覆盖工作区、笔记、信任目录、
   * 显式目录与磁盘模式；提供时文件卡片不再自己拼开关。
   */
  fileScope?: {
    active: boolean
    mode: 'all' | 'non-system' | 'explicit'
    readRoots: number
    unavailableRoots: number
    volumeStatus: string
    volumeTotal: number
    volumeReadable: number
    volumeAuthorized: number
    volumeUnavailable: number
    volumeSystem: number
    version: number
  }
  /** 主进程卷快照的脱敏计数；未提供表示尚未检查。 */
  volumes?: {
    status: string
    total: number
    /** 当前可读卷数（含系统卷）。 */
    readable: number
    unavailable: number
    /** 包含系统目录的卷数；兼容旧字段 systemExcluded。 */
    system?: number
    systemExcluded?: number
    /** 卷快照版本；旧调用方可以缺省。 */
    version?: number
  }
  browser?: {
    running: boolean
    extensionConnected: boolean
    controlConnected: boolean
    extensionControlConsent: boolean | null
  }
  cua?: {
    helperHealthy: boolean
    available: boolean
  }
  /**
   * B 站独立服务的真实阶段。缺省时只按配置与 worlds.bilibili 判断；
   * 主进程填入后，登录/安装/停止不会继续被显示成 ready。
   */
  bilibili?: {
    phase: BiliPhase
    loginState: BiliLoginState
  }
  worlds?: Record<string, { enabled: boolean; available: boolean; reason: string | null }>
}

const STATE_RANK: Record<CapabilityState, number> = {
  ready: 0,
  limited: 1,
  disabled: 2,
  'pending-connection': 3,
  'missing-consent': 4,
  expired: 5,
  unauthorized: 6,
  'directory-unavailable': 7,
  fault: 8
}

function worst(states: CapabilityState[]): CapabilityState {
  let result: CapabilityState = 'ready'
  for (const state of states) {
    if (STATE_RANK[state] > STATE_RANK[result]) result = state
  }
  return result
}

function aggregate(states: CapabilityState[]): CapabilityState {
  if (states.length === 0) return 'disabled'
  const ready = states.filter((state) => state === 'ready').length
  if (ready === states.length) return 'ready'
  if (ready > 0) return 'limited'
  return worst(states)
}

function check(
  id: string,
  label: string,
  state: CapabilityState,
  reason: string | null,
  page: SettingsPageId,
  anchor: string
): CapabilityCheckView {
  return {
    id,
    label,
    state,
    reason: state === 'ready' ? null : reason ?? '当前不可用。',
    fix: { page, anchor }
  }
}

function worldFault(
  runtime: CapabilityRuntimeFacts,
  id: string
): string | null {
  const world = runtime.worlds?.[id]
  if (world === undefined || world.available) return null
  return world.reason ?? '运行时组件不可用。'
}

function safeCount(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null
}

/**
 * 生成能力快照。不要在这里读取草稿；调用方传入的必须是已保存配置。
 */
export function buildCapabilitySnapshot(
  config: AppConfig,
  runtime: CapabilityRuntimeFacts = {},
  options: { now?: number; configRevision?: number } = {}
): CapabilitySnapshotView {
  const now = options.now ?? Date.now()
  const caps: EffectiveCapabilities = effectiveCapabilities(config, {
    now,
    ...(runtime.notesRootAvailable === undefined
      ? {}
      : { notesRootAvailable: runtime.notesRootAvailable })
  })
  const exploration = caps.exploration
  const browser = runtime.browser
  const cuaRuntime = runtime.cua
  const readConfigured = safeCount(runtime.readRootsConfigured)
  const readAvailable = safeCount(runtime.readRootsAvailable)
  const artifactAvailable = runtime.artifactRootAvailable

  const webChecks: CapabilityCheckView[] = []
  webChecks.push(
    check(
      'web-search',
      '搜索并读取公开网页',
      config.worlds.web.enabled
        ? worldFault(runtime, 'web') === null
          ? 'ready'
          : 'fault'
        : 'disabled',
      worldFault(runtime, 'web') ?? '联网读取已关闭。',
      'computer',
      'web'
    )
  )
  if (config.worlds.browserPage.consentAt === null) {
    webChecks.push(
      check(
        'browser-page',
        '读取当前浏览器页面',
        'missing-consent',
        '尚未同意浏览器扩展读取当前页面。',
        'computer',
        'browser'
      )
    )
  } else if (!config.worlds.browserPage.enabled) {
    webChecks.push(
      check(
        'browser-page',
        '读取当前浏览器页面',
        'disabled',
        '浏览器页面感知已关闭。',
        'computer',
        'browser'
      )
    )
  } else if (browser !== undefined && !browser.extensionConnected) {
    webChecks.push(
      check(
        'browser-page',
        '读取当前浏览器页面',
        'pending-connection',
        '浏览器扩展还没有连接本机。',
        'computer',
        'browser'
      )
    )
  } else {
    webChecks.push(
      check(
        'browser-page',
        '读取当前浏览器页面',
        worldFault(runtime, 'browser') === null ? 'ready' : 'fault',
        worldFault(runtime, 'browser'),
        'computer',
        'browser'
      )
    )
  }
  webChecks.push(
    check(
      'own-tabs',
      '操作她自己的浏览器标签页',
      (() => {
        if (!exploration.enabled) return 'unauthorized' as const
        if (!exploration.active) return 'expired' as const
        if (!exploration.browserTabs) return 'unauthorized' as const
        if (config.worlds.browserControl.consentAt === null) return 'missing-consent' as const
        if (!config.worlds.browserControl.enabled) return 'disabled' as const
        if (browser === undefined) {
          return worldFault(runtime, 'browserControl') === null ? ('ready' as const) : ('fault' as const)
        }
        if (!browser.running) return 'fault' as const
        if (!browser.extensionConnected) return 'pending-connection' as const
        if (browser.extensionControlConsent === false) return 'missing-consent' as const
        if (!browser.controlConnected) return 'pending-connection' as const
        return worldFault(runtime, 'browserControl') === null
          ? ('ready' as const)
          : ('fault' as const)
      })(),
      !exploration.enabled
        ? '自由探索尚未开启，所以不能主动浏览。'
        : !exploration.active
          ? '自由探索授权已到期。'
          : !exploration.browserTabs
            ? '没有授权她自己的浏览器标签页。'
            : config.worlds.browserControl.consentAt === null
              ? '尚未同意扩展接受主动控制指令。'
              : !config.worlds.browserControl.enabled
                ? '主动浏览器控制已关闭。'
                : browser === undefined
                  ? worldFault(runtime, 'browserControl')
                  : !browser.running
                    ? '浏览器桥没有运行。'
                    : !browser.extensionConnected
                      ? '浏览器扩展还没有连接本机。'
                      : browser.extensionControlConsent === false
                        ? '扩展弹窗里还没有允许主动浏览。'
                        : !browser.controlConnected
                          ? '扩展控制通道未连接。'
                          : (worldFault(runtime, 'browserControl') ?? null),
      'computer',
      'browser'
    )
  )
  const biliChecks: CapabilityCheckView[] = [
    check(
      'bilibili-read',
      '只读浏览 B 站（独立 API）',
      (() => {
        if (!exploration.enabled) return 'unauthorized' as const
        if (!exploration.active) return 'expired' as const
        if (isExplorationDomainExcluded(exploration, 'bilibili.com')) {
          return 'unauthorized' as const
        }
        if (config.worlds.bilibili.consentAt === null) return 'missing-consent' as const
        if (!config.worlds.bilibili.enabled) return 'disabled' as const
        const bili = runtime.bilibili
        if (bili !== undefined) {
          if (bili.phase === 'login-expired') return 'expired' as const
          if (bili.phase === 'login-required') return 'pending-connection' as const
          if (bili.phase === 'stopped') return 'expired' as const
          if (bili.phase === 'fault') return 'fault' as const
          if (bili.phase !== 'ready') return 'pending-connection' as const
          return 'ready' as const
        }
        return worldFault(runtime, 'bilibili') === null
          ? ('ready' as const)
          : ('fault' as const)
      })(),
      !exploration.enabled
        ? '自由探索尚未开启，所以不能自主阅读 B 站。'
        : !exploration.active
          ? '自由探索授权已到期。'
          : isExplorationDomainExcluded(exploration, 'bilibili.com')
            ? 'bilibili.com 在自由探索排除列表中。'
            : config.worlds.bilibili.consentAt === null
              ? '尚未同意通过独立 API 读取 B 站并下载本地转写音频。'
              : !config.worlds.bilibili.enabled
                ? 'B 站独立阅读已关闭。'
                : (() => {
                    const bili = runtime.bilibili
                    if (bili === undefined) return worldFault(runtime, 'bilibili')
                    switch (bili.phase) {
                      case 'login-expired':
                        return 'B 站登录已失效，需要重新扫码。'
                      case 'login-required':
                        return '需要扫码登录 B 站后才能自主阅读。'
                      case 'stopped':
                        return 'B 站阅读已停止，可手动恢复。'
                      case 'fault':
                        return 'B 站服务故障，可在设置中重试。'
                      case 'env-missing':
                        return 'B 站服务依赖尚未安装或不可用。'
                      case 'installing':
                        return 'B 站服务依赖正在安装。'
                      case 'starting':
                        return 'B 站服务正在启动。'
                      default:
                        return worldFault(runtime, 'bilibili')
                    }
                  })(),
      'computer',
      'bilibili'
    )
  ]

  const configuredSystemApps = config.worlds.system.apps.length
  const invalidSystemApps = config.worlds.system.enabled
    ? Math.max(0, configuredSystemApps - caps.launchableApps.length)
    : 0
  const appWhitelistState: CapabilityState = !config.worlds.system.enabled
    ? 'disabled'
    : configuredSystemApps === 0
      ? 'unauthorized'
      : caps.launchableApps.length === 0 || invalidSystemApps > 0
        ? 'limited'
        : worldFault(runtime, 'system') === null
          ? 'ready'
          : 'fault'
  const appWhitelistReason = !config.worlds.system.enabled
    ? '应用与系统操作已关闭。'
    : configuredSystemApps === 0
      ? '还没有添加应用；扫描开始菜单或手动添加后保存。'
      : caps.launchableApps.length === 0
        ? `已添加 ${configuredSystemApps} 个应用，但没有可验证的可执行目标；请检查路径。`
        : invalidSystemApps > 0
          ? `已添加 ${configuredSystemApps} 个应用，其中 ${invalidSystemApps} 个启动路径无法验证；其余 ${caps.launchableApps.length} 个可用。`
          : (worldFault(runtime, 'system') ?? null)

  const appChecks: CapabilityCheckView[] = [
    check(
      'ordinary-apps',
      '发现、启动并切换普通应用',
      !exploration.enabled
        ? 'unauthorized'
        : !exploration.active
          ? 'expired'
          : !exploration.apps
            ? 'unauthorized'
            : worldFault(runtime, 'apps') === null
              ? 'ready'
              : 'fault',
      !exploration.enabled
        ? '自由探索尚未开启，不能自动发现普通应用。'
        : !exploration.active
          ? '自由探索授权已到期。'
          : !exploration.apps
            ? '普通应用类别授权已关闭。'
            : (worldFault(runtime, 'apps') ?? null),
      'computer',
      'apps'
    ),
    check(
      'app-whitelist',
      '启动已授权应用',
      appWhitelistState,
      appWhitelistReason,
      'computer',
      'apps'
    )
  ]

  const screenChecks: CapabilityCheckView[] = [
    check(
      'window-observe',
      '观察应用窗口',
      caps.observeApps.length > 0 || caps.windowsCategory
        ? worldFault(runtime, 'desktop') === null
          ? 'ready'
          : 'fault'
        : 'unauthorized',
      caps.observeApps.length > 0 || caps.windowsCategory
        ? (worldFault(runtime, 'desktop') ?? null)
        : '没有加入逐应用观察，也没有窗口类别授权。',
      'computer',
      'screen'
    ),
    check(
      'window-input',
      '在窗口里输入',
      caps.inputApps.length === 0
        ? 'unauthorized'
        : !config.worlds.desktop.windowCapture
          ? 'missing-consent'
          : !caps.cua
            ? 'missing-consent'
            : worldFault(runtime, 'desktop') === null
              ? 'ready'
              : 'fault',
      caps.inputApps.length === 0
        ? '没有逐应用输入授权。'
        : !config.worlds.desktop.windowCapture
          ? '未开启窗口截图，无法安全定位输入。'
          : !caps.cua
            ? '键鼠同意、截图同意或模型图片输入尚未齐备。'
            : (worldFault(runtime, 'desktop') ?? null),
      'computer',
      'screen'
    ),
    check(
      'full-screen',
      '整屏 / 多显示器观察',
      !exploration.enabled
        ? 'unauthorized'
        : !exploration.active
          ? 'expired'
          : !exploration.fullScreen
            ? 'unauthorized'
            : config.worlds.cua.consentAt === null || config.worlds.cua.screenConsentAt === null
              ? 'missing-consent'
              : !config.provider.visionInput
                ? 'missing-consent'
                : !config.worlds.cua.enabled
                  ? 'disabled'
                  : cuaRuntime !== undefined && !cuaRuntime.helperHealthy
                    ? 'fault'
                    : worldFault(runtime, 'cua') === null
                      ? 'ready'
                      : 'fault',
      !exploration.enabled
        ? '自由探索尚未开启。'
        : !exploration.active
          ? '自由探索授权已到期。'
          : !exploration.fullScreen
            ? '整屏观察是额外授权，当前未开启。'
            : config.worlds.cua.consentAt === null || config.worlds.cua.screenConsentAt === null
              ? '缺少键鼠或截图同意。'
              : !config.provider.visionInput
                ? '模型图片输入未开启。'
                : !config.worlds.cua.enabled
                  ? '屏幕与键鼠 World 已关闭。'
                  : cuaRuntime !== undefined && !cuaRuntime.helperHealthy
                    ? '输入辅助程序不健康。'
                    : (worldFault(runtime, 'cua') ?? null),
      'computer',
      'screen'
    )
  ]

  const fileScope = runtime.fileScope
  const diskMode = fileScope?.mode ?? exploration.volumeScope
  const diskActive = exploration.active && exploration.fileRead && diskMode !== 'explicit'
  const volumeStatus = fileScope?.volumeStatus ?? runtime.volumes?.status
  const volumeTotal = fileScope?.volumeTotal ?? runtime.volumes?.total
  const volumeReadable = fileScope?.volumeReadable ?? runtime.volumes?.readable
  const volumeUnavailable = fileScope?.volumeUnavailable ?? runtime.volumes?.unavailable
  const volumeAuthorized = fileScope?.volumeAuthorized
  const fileRoots =
    fileScope !== undefined
      ? fileScope.readRoots > 0 || fileScope.unavailableRoots > 0
      : config.worlds.workspace.root.trim() !== '' ||
        config.worlds.workspace.notesRoot.trim() !== '' ||
        config.autonomy.trustedRoots.some((root) => root.trim() !== '') ||
        config.worlds.files.roots.some((root) => root.trim() !== '') ||
        (exploration.active &&
          (exploration.readRoots.length > 0 ||
            exploration.includeProfile ||
            (exploration.fileRead && exploration.volumeScope !== 'explicit')))
  const diskModeLabel =
    diskMode === 'all'
      ? '全部已挂载磁盘'
      : diskMode === 'non-system'
        ? '全部非系统磁盘'
        : '仅指定目录'
  const filesChecks: CapabilityCheckView[] = [
    check(
      'read-roots',
      '读取授权目录',
      !fileRoots
        ? exploration.active && fileScope !== undefined
          ? 'directory-unavailable'
          : 'disabled'
        : fileScope !== undefined
          ? fileScope.readRoots === 0
            ? 'directory-unavailable'
            : fileScope.unavailableRoots > 0
              ? 'limited'
              : worldFault(runtime, 'files') === null
                ? 'ready'
                : 'fault'
          : readConfigured !== null && readConfigured === 0
            ? 'directory-unavailable'
            : readAvailable !== null && readAvailable === 0
              ? 'directory-unavailable'
              : worldFault(runtime, 'files') === null
                ? 'ready'
                : 'fault',
      !fileRoots
        ? exploration.active
          ? '统一文件范围当前为空。'
          : '还没有可读取的目录。'
        : fileScope !== undefined && fileScope.readRoots === 0
          ? '配置的目录当前不存在或不可读。'
          : fileScope !== undefined && fileScope.unavailableRoots > 0
            ? `有 ${fileScope.unavailableRoots} 个显式目录当前不可访问；其余范围仍可使用。`
            : readConfigured === 0 || readAvailable === 0
              ? '配置的目录当前不存在或不可读。'
              : (worldFault(runtime, 'files') ?? null),
      'computer',
      'files'
    ),
    check(
      'disk-scope',
      diskModeLabel,
      !exploration.active
        ? 'unauthorized'
        : !exploration.fileRead
          ? 'unauthorized'
          : diskMode === 'explicit'
            ? 'ready'
            : volumeStatus === undefined
              ? 'ready'
              : volumeStatus === 'pending'
                ? 'pending-connection'
                : volumeStatus !== 'ok'
                  ? 'fault'
                  : volumeReadable === 0
                    ? volumeTotal === 0
                      ? 'disabled'
                      : 'directory-unavailable'
                    : (volumeAuthorized ?? volumeReadable) === 0
                      ? 'disabled'
                      : volumeUnavailable !== undefined && volumeUnavailable > 0
                        ? 'limited'
                        : 'ready',
      !exploration.active
        ? '自由探索未开启或已到期。'
        : !exploration.fileRead
          ? '文件读取范围未开启。'
          : diskMode === 'explicit'
            ? null
            : volumeStatus === undefined
              ? null
              : volumeStatus === 'pending'
                ? '正在检测已挂载的卷；显式目录仍可用。'
                : volumeStatus !== 'ok'
                  ? '卷枚举失败；显式目录仍可用，不回退到系统盘。'
                  : volumeReadable === 0
                    ? volumeTotal === 0
                      ? '没有检测到已挂载的卷。'
                      : '检测到卷，但当前都离线或没有读取权限。'
                    : (volumeAuthorized ?? volumeReadable) === 0
                      ? '当前模式没有自动授权的可读卷。'
                      : volumeUnavailable !== undefined && volumeUnavailable > 0
                        ? `有 ${volumeUnavailable} 个卷离线或不可读；其余卷与显式目录仍可探索。`
                        : null,
      'computer',
      'files'
    ),
    check(
      'file-edits',
      '编辑用户原始文件',
      !exploration.active ? 'unauthorized' : !exploration.edits ? 'unauthorized' : 'ready',
      !exploration.active
        ? '自由探索未开启或已到期。'
        : !exploration.edits
          ? '原始文件编辑是额外授权，当前只读。'
          : null,
      'computer',
      'files'
    )
  ]

  const artifactChecks: CapabilityCheckView[] = [
    check(
      'artifact-root',
      '她自己的作品空间',
      !exploration.enabled
        ? 'unauthorized'
        : !exploration.active
          ? 'expired'
          : !exploration.artifacts
            ? 'unauthorized'
            : exploration.artifactRoot === null
              ? 'disabled'
              : artifactAvailable === false
                ? 'directory-unavailable'
                : worldFault(runtime, 'files') === null
                  ? 'ready'
                  : 'fault',
      !exploration.enabled
        ? '自由探索尚未开启。'
        : !exploration.active
          ? '自由探索授权已到期。'
          : !exploration.artifacts
            ? '作品空间写入未授权。'
            : exploration.artifactRoot === null
              ? '还没有设置作品目录、笔记目录或工作区。'
              : artifactAvailable === false
                ? '作品目录当前不存在或不可写。'
                : (worldFault(runtime, 'files') ?? null),
      'computer',
      'artifacts'
    )
  ]

  const cards: CapabilityCardView[] = [
    {
      id: 'web',
      title: '浏览网页',
      summary: '搜索与阅读公开网页、读取当前页面，或在她自己的标签页里主动浏览。',
      access: [
        config.worlds.web.enabled ? '公开网页搜索/读取' : '公开网页未开启',
        config.worlds.browserPage.enabled && config.worlds.browserPage.consentAt !== null
          ? '读取当前浏览器页面'
          : '当前页面读取未授权',
        exploration.active && exploration.browserTabs
          ? '她自己的浏览器标签页'
          : '她自己的标签页未授权'
      ],
      state: aggregate(webChecks.map((item) => item.state)),
      checks: webChecks,
      fix: { page: 'computer', anchor: 'web' }
    },
    {
      id: 'bilibili',
      title: 'bilibili浏览',
      summary:
        '通过独立扫码登录与 Python API 只读推荐、搜索、字幕与本地转写；不依赖浏览器扩展。',
      access: [
        config.worlds.bilibili.enabled && config.worlds.bilibili.consentAt !== null
          ? '独立 API 阅读已启用'
          : '独立 API 阅读未启用',
        config.worlds.bilibili.asr.enabled ? '本地转写已开启' : '本地转写已关闭',
        runtime.bilibili === undefined
          ? '登录状态未知'
          : runtime.bilibili.phase === 'ready'
            ? '服务与登录就绪'
            : '服务/登录尚未就绪'
      ],
      state: aggregate(biliChecks.map((item) => item.state)),
      checks: biliChecks,
      fix: { page: 'computer', anchor: 'bilibili' }
    },
    {
      id: 'apps',
      title: '使用应用',
      summary:
        '发现与启动普通应用、切换窗口；系统应用白名单加入并保存后即可在任务授权内自动打开，例外仍可单独排除。',
      access: [
        exploration.active && exploration.apps ? '普通应用类别授权' : '普通应用类别未授权',
        !config.worlds.system.enabled
          ? '应用与系统操作已关闭'
          : configuredSystemApps === 0
            ? '尚未添加应用'
            : `已授权应用 ${caps.launchableApps.length} 个${
                invalidSystemApps > 0 ? `（${invalidSystemApps} 个目标无效）` : ''
              }`
      ],
      state: aggregate(appChecks.map((item) => item.state)),
      checks: appChecks,
      fix: { page: 'computer', anchor: 'apps' }
    },
    {
      id: 'screen',
      title: '观察与操作屏幕',
      summary: '窗口文本、按窗口截图、整屏观察与受控输入；截图和输入同意始终分开。',
      access: [
        caps.observeApps.length > 0
          ? `逐应用观察 ${caps.observeApps.length} 个`
          : caps.windowsCategory
            ? '窗口类别观察'
            : '没有观察范围',
        caps.inputApps.length > 0 ? `逐应用输入 ${caps.inputApps.length} 个` : '没有逐应用输入',
        exploration.active && exploration.fullScreen ? '整屏观察已授权' : '整屏观察未授权'
      ],
      state: aggregate(screenChecks.map((item) => item.state)),
      checks: screenChecks,
      fix: { page: 'computer', anchor: 'screen' }
    },
    {
      id: 'files',
      title: '探索文件',
      summary:
        '在统一磁盘与目录范围内持续只读探索；原始文件编辑是需要单独开启的额外授权。',
      access: [
        fileScope !== undefined
          ? `可读取根 ${fileScope.readRoots} 个`
          : readConfigured === null
            ? fileRoots
              ? '已配置只读目录'
              : '没有只读目录'
            : `可读取目录 ${readConfigured} 个`,
        exploration.active && exploration.fileRead ? '自由探索文件范围' : '自由探索文件范围未开启',
        diskMode === 'explicit'
          ? '磁盘范围：仅指定目录（不自动纳入卷）'
          : diskActive
            ? volumeStatus === undefined
              ? `${diskModeLabel}（只读，不授予整盘写入）`
              : `${diskModeLabel}：${volumeAuthorized ?? volumeReadable ?? 0}/${volumeTotal ?? 0} 个卷已授权且可读（快照 v${fileScope?.version ?? runtime.volumes?.version ?? 0}；只读，不授予整盘写入）`
            : '磁盘范围未开启',
        exploration.active && exploration.edits ? '原始文件编辑已授权' : '原始文件只读'
      ],
      state: aggregate(filesChecks.map((item) => item.state)),
      checks: filesChecks,
      fix: { page: 'computer', anchor: 'files' }
    },
    {
      id: 'artifacts',
      title: '她的作品空间',
      summary: '她可以持续整理自己的草稿、数据和下载，不会静默写进用户原始文件。',
      access: [
        exploration.active && exploration.artifacts ? '作品空间写入已授权' : '作品空间写入未授权',
        exploration.artifactRoot === null ? '未配置目录' : '已配置作品目录'
      ],
      state: aggregate(artifactChecks.map((item) => item.state)),
      checks: artifactChecks,
      fix: { page: 'computer', anchor: 'artifacts' }
    }
  ]

  return {
    generatedAt: now,
    configRevision: options.configRevision ?? 0,
    exploration: {
      enabled: exploration.enabled,
      active: exploration.active,
      scope: config.exploration.scope,
      expiresAt: config.exploration.scope === 'session' ? config.exploration.sessionExpiresAt : null
    },
    cards
  }
}

/** 快照中至少有一张卡可执行；用于概览与诊断，不代替逐次授权校验。 */
export function capabilitySnapshotReady(snapshot: CapabilitySnapshotView): boolean {
  return snapshot.cards.some((card) => card.state === 'ready' || card.state === 'limited')
}

/** 诊断用的脱敏摘要。 */
export function capabilitySnapshotSummary(
  snapshot: CapabilitySnapshotView
): Record<string, unknown> {
  return {
    configRevision: snapshot.configRevision,
    explorationActive: snapshot.exploration.active,
    cards: snapshot.cards.map((card) => ({
      id: card.id,
      state: card.state,
      checks: card.checks.map((item) => ({ id: item.id, state: item.state }))
    }))
  }
}
