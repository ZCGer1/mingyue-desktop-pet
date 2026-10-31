import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { AppConfig } from '../../shared/config'
import type {
  ActivityRawSampleView,
  ActivityStatsView,
  CapabilitySnapshotView,
  PetCommand,
  SettingsBootstrap
} from '../../shared/ipc'
import {
  COMPUTER_SECTIONS,
  computerSectionForAnchor,
  DEFAULT_COMPUTER_SECTION,
  DEFAULT_PAGE,
  SETTINGS_PAGES,
  SettingsContext,
  TAB_ROUTE,
  type ComputerSection,
  type Notice,
  type NoticeKind,
  type SettingsContextValue,
  type SettingsPageId,
  type TabId
} from './context'
import { applyPath, applyPaths, type ConfigPath } from './configTree'
import { OverviewPage } from './pages/OverviewPage'
import { CompanionPage } from './pages/CompanionPage'
import { ComputerPage } from './pages/ComputerPage'
import { ActivityPage } from './pages/ActivityPage'
import { ModelPage } from './pages/ModelPage'
import { PrivacyPage } from './pages/PrivacyPage'
import { AdvancedPage } from './pages/AdvancedPage'
import { useMemoryEditor } from './hooks/useMemoryEditor'
import { useSettingsData } from './hooks/useSettingsData'

interface RouteTarget {
  page: SettingsPageId
  anchor: string | null
}

const PAGE_IDS: ReadonlySet<string> = new Set(SETTINGS_PAGES.map((item) => item.id))

/** 支持 #computer/files 这类直接定位，也兼容旧分区名 #security。 */
function parseRoute(hash: string): RouteTarget | null {
  const raw = decodeURIComponent(hash.replace(/^#\/?/, '')).trim()
  if (raw === '') return null
  const [first, second] = raw.split('/')
  if (first === undefined || first === '') return null
  if (PAGE_IDS.has(first)) {
    return { page: first as SettingsPageId, anchor: second === undefined || second === '' ? null : second }
  }
  const legacy = TAB_ROUTE[first as TabId]
  if (legacy !== undefined) {
    return { page: legacy.page, anchor: second === undefined || second === '' ? legacy.anchor : second }
  }
  return null
}

interface SearchEntry {
  page: SettingsPageId
  anchor: string
  label: string
  detail: string
  keywords: string
}

const SEARCH_ENTRIES: readonly SearchEntry[] = [
  { page: 'overview', anchor: 'overview', label: '概览与配置流程', detail: 'API、六项能力、陪伴、记忆与运行控制', keywords: '状态 停止 暂停 安静 向导 模型 重新配置' },
  { page: 'companion', anchor: 'persona', label: '人格与外观', detail: '名字、语气、桌宠显示与动作', keywords: '人格 称呼 语气 外观 动作 桌宠' },
  { page: 'companion', anchor: 'rhythm', label: '聊天节奏', detail: '主动聊天档位、屏幕感知、探索节奏与安静时段', keywords: '聊天 主动 节奏 安静 时段 自主 屏幕感知 屏幕 陪伴' },
  { page: 'companion', anchor: 'chat', label: '聊天与桌宠窗口', detail: '完整聊天、快捷输入、点击行为', keywords: '聊天 窗口 快捷输入 点击 桌宠' },
  { page: 'computer', anchor: 'web', label: '网页', detail: '公开网页、当前页面、主动浏览、扩展连接与域名规则', keywords: '网页 搜索 浏览器 扩展 Chrome Edge 标签页 网页读取 域名' },
  { page: 'computer', anchor: 'bilibili', label: 'B 站', detail: '扫码登录、Python 服务、字幕/转写、视觉辅助与日报', keywords: 'B站 Bilibili bilibili浏览 扫码 登录 字幕 转写 日报 Python 只读 视觉 阅读' },
  { page: 'computer', anchor: 'apps', label: '应用', detail: '普通应用、系统应用白名单、打开链接与固定系统动作', keywords: '应用 启动 窗口 白名单 自动打开 系统 链接 音量 媒体 锁屏' },
  { page: 'computer', anchor: 'screen', label: '屏幕', detail: '屏幕感知、整屏共享、窗口观察、键鼠与受控输入', keywords: '屏幕 键鼠 截图 观察 输入 CUA 整屏 感知' },
  { page: 'computer', anchor: 'exploration', label: '自主与授权', detail: '自主模式、自由探索总授权、审批策略、预算与撤销', keywords: '授权 探索 撤销 范围 审批 配额 预算 接管' },
  { page: 'computer', anchor: 'artifacts', label: '作品空间', detail: '她的作品目录、下载许可与回退关系', keywords: '作品 目录 下载 笔记 产物 空间' },
  { page: 'computer', anchor: 'files', label: '文件', detail: '工作区、笔记、信任目录、文件目录与磁盘范围', keywords: '文件 目录 读取 编辑 只读 排除 磁盘' },
  { page: 'computer', anchor: 'web-advanced', label: '网页 · 高级', detail: '摘要长度、事件频率、标签页上限、搜索模板、发现保留', keywords: '摘要 长度 频率 标签页 搜索模板 发现 保留 高级' },
  { page: 'computer', anchor: 'bilibili-advanced', label: 'B 站 · 高级', detail: '候选与精读上限、抽帧、转写模型与体积、日报保留', keywords: 'B站 候选 精读 抽帧 转写 模型 缓存 日报 保留' },
  { page: 'computer', anchor: 'apps-advanced', label: '应用 · 高级', detail: '新应用继承、排除的应用', keywords: '新应用 继承 排除 进程名' },
  { page: 'computer', anchor: 'screen-advanced', label: '屏幕 · 高级', detail: '观察周期、OCR、截图参数、免问时长、阻止的应用', keywords: '观察周期 OCR 截图 免问 阻止 窗口上限' },
  { page: 'computer', anchor: 'files-advanced', label: '文件 · 范围详情', detail: '候选根与卷清单（只读）', keywords: '卷 清单 候选根 磁盘 只读 范围' },
  { page: 'activity', anchor: 'activity', label: '活动与任务', detail: '任务、发现、兴趣、经历、授权与操作记录', keywords: '任务 自主 探索 兴趣 经历 暂停 继续 取消 发现 撤销 记录' },
  { page: 'activity', anchor: 'discoveries', label: '发现列表', detail: '她保存的网页与 B 站条目、反馈与删除', keywords: '发现 分享 列表 网页 视频 清空' },
  { page: 'activity', anchor: 'grants', label: '授权与操作记录', detail: '审批授权、任务授权、文件撤销与系统操作记录', keywords: '授权 记录 撤销 审批 操作 历史' },
  { page: 'model', anchor: 'model', label: '模型与用量', detail: 'API Key、模型、图片输入、上下文、预算与费用', keywords: '模型 密钥 API Key token 预算 费用 上下文 图片' },
  { page: 'privacy', anchor: 'memory', label: '记忆', detail: '查看、编辑、遗忘与清空本地记忆', keywords: '记忆 编辑 忘却 清空 文件' },
  { page: 'privacy', anchor: 'perception', label: '行为感知与隐私', detail: '行为感知、共享字段、保留与清空', keywords: '隐私 感知 采集 行为 清除 保留' },
  { page: 'advanced', anchor: 'worlds', label: 'Worlds 健康', detail: '各世界的健康状态、工具与事件', keywords: 'Worlds 世界 健康 工具 事件' },
  { page: 'advanced', anchor: 'diagnostics', label: '诊断与日志', detail: '运行相位、队列、路径、屏幕诊断与导出', keywords: '诊断 日志 导出 队列 路径 屏幕' },
  { page: 'advanced', anchor: 'terminal', label: '终端', detail: '终端白名单、开机启动与维护操作', keywords: '终端 白名单 自启动 开机 维护 重置' },
  { page: 'advanced', anchor: 'about', label: '关于与许可', detail: '版本、许可证、上游署名与安全边界', keywords: '关于 版本 许可 署名 安全' }
]

export function App(): React.JSX.Element {
  const [boot, setBoot] = useState<SettingsBootstrap | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [initialRoute] = useState<RouteTarget | null>(() => parseRoute(window.location.hash))
  const [page, setPage] = useState<SettingsPageId>(initialRoute?.page ?? DEFAULT_PAGE)
  const [computerSection, setComputerSection] = useState<ComputerSection>(
    computerSectionForAnchor(initialRoute?.anchor ?? null) ?? DEFAULT_COMPUTER_SECTION
  )
  const [search, setSearch] = useState('')
  const [anchorRequest, setAnchorRequest] = useState<{
    anchor: string
    token: number
  } | null>(initialRoute?.anchor === null || initialRoute?.anchor === undefined
    ? null
    : { anchor: initialRoute.anchor, token: 0 })
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [capabilitySnapshot, setCapabilitySnapshot] =
    useState<CapabilitySnapshotView | null>(null)
  /** 外部修改/保存冲突：配置内容留在 ref 中，界面只暴露类型与动作。 */
  const [remoteUpdate, setRemoteUpdate] = useState<{
    kind: 'external' | 'conflict'
    revision: number
  } | null>(null)

  const [keyInput, setKeyInput] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [models, setModels] = useState<string[]>([])

  const [raw, setRaw] = useState<ActivityRawSampleView[]>([])
  const [stats, setStats] = useState<ActivityStatsView | null>(null)

  const noticeTimer = useRef<number | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const pageRef = useRef<SettingsPageId>(initialRoute?.page ?? DEFAULT_PAGE)
  /** 当前草稿基于哪个已保存配置版本。 */
  const configRevisionRef = useRef(0)
  /** 每次本地编辑递增；保存响应只确认同一代草稿。 */
  const draftGenerationRef = useRef(0)
  const dirtyRef = useRef(false)
  const bootedRef = useRef(false)
  const savingRef = useRef(false)
  /** 冲突时主进程返回的已保存配置；采用/覆盖都由用户明确选择。 */
  const remoteConfigRef = useRef<{ config: AppConfig; revision: number } | null>(null)

  useEffect(() => {
    pageRef.current = page
  }, [page])
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  const navigate = useCallback((nextPage: SettingsPageId, anchor?: string): void => {
    setPage(nextPage)
    setSearch('')
    if (nextPage === 'computer') {
      // 电脑能力只挂载当前子页；先定位子页，锚点落在已渲染内容里。
      const section = computerSectionForAnchor(anchor ?? null)
      if (section !== null) setComputerSection(section)
    }
    setAnchorRequest((previous) =>
      anchor === undefined
        ? null
        : { anchor, token: (previous?.token ?? 0) + 1 }
    )
    try {
      window.history.replaceState(
        null,
        '',
        `#${nextPage}${anchor === undefined ? '' : `/${anchor}`}`
      )
    } catch {
      // 文件协议或受限环境不允许改 hash 时，页面内导航仍然有效。
    }
  }, [])

  /** 旧的页内跳转统一重定向到新的 7 页结构。 */
  const setTab = useCallback(
    (tab: TabId): void => {
      const route = TAB_ROUTE[tab]
      navigate(route.page, route.anchor)
    },
    [navigate]
  )

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (query === '') return []
    const tokens = query.split(/\s+/).filter((token) => token !== '')
    return SEARCH_ENTRIES.filter((entry) => {
      const haystack = `${entry.label} ${entry.detail} ${entry.keywords}`.toLowerCase()
      return tokens.every((token) => haystack.includes(token))
    }).slice(0, 8)
  }, [search])

  useEffect(() => {
    const onHash = (): void => {
      const route = parseRoute(window.location.hash)
      if (route === null) return
      setPage(route.page)
      if (route.page === 'computer') {
        const section = computerSectionForAnchor(route.anchor)
        if (section !== null) setComputerSection(section)
      }
      if (route.anchor !== null) {
        setAnchorRequest((previous) => ({
          anchor: route.anchor as string,
          token: (previous?.token ?? 0) + 1
        }))
      }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 切页默认回到顶部；带锚点的跳转会在目标渲染后再滚动。折叠的 details
  // 会先展开，否则“修复”链接可能落到一个不可见节点。
  useEffect(() => {
    if (anchorRequest === null) {
      contentRef.current?.scrollTo({ top: 0 })
      return
    }
    let second = 0
    const first = window.requestAnimationFrame(() => {
      const target = document.getElementById(anchorRequest.anchor)
      if (target === null) return
      const details = target.closest('details')
      const scroll = (): void => {
        target.scrollIntoView({ block: 'start', behavior: 'smooth' })
        target.classList.add('is-anchor-flash')
        window.setTimeout(() => target.classList.remove('is-anchor-flash'), 1600)
      }
      if (details !== null && !details.open) {
        details.open = true
        second = window.requestAnimationFrame(scroll)
      } else {
        scroll()
      }
    })
    return () => {
      window.cancelAnimationFrame(first)
      if (second !== 0) window.cancelAnimationFrame(second)
    }
  }, [page, anchorRequest])

  const notify = useCallback((text: string, kind: NoticeKind = 'info'): void => {
    setNotice({ kind, text })
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null
      setNotice(null)
    }, 6500)
  }, [])

  const {
    memory,
    memFile,
    memText,
    memMode,
    memQuery,
    setMemFile,
    setMemText,
    setMemMode,
    setMemQuery,
    loadMemory,
    saveMemory,
    forgetFile,
    forgetQuery
  } = useMemoryEditor(page === 'privacy', notify)

  const {
    worlds,
    diagnostics,
    undoEntries,
    approvalGrants,
    cuaStatus,
    tasks,
    capabilityGrants,
    companion,
    discovery,
    systemRecent,
    loadWorlds,
    loadDiagnostics,
    exportDiagnostics,
    loadUndo,
    undoNow,
    loadApprovalGrants,
    clearApprovalGrants,
    loadCuaStatus,
    stopCua,
    clearCuaGrants,
    loadTasks,
    taskAction,
    loadCapabilityGrants,
    revokeCapability,
    loadDiscovery,
    loadSystemRecent,
    clearSystemRecent,
    loadCompanion,
    companionAction,
    screenCompanionTest
  } = useSettingsData(page, notify)

  const refreshBoot = useCallback(async (): Promise<void> => {
    try {
      const next = await window.mingyue.settings.bootstrap()
      setBoot(next)
      setCapabilitySnapshot(next.capabilitySnapshot)
      bootedRef.current = true
    } catch {
      notify('无法刷新设置状态。', 'error')
    }
  }, [notify])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const next = await window.mingyue.settings.bootstrap()
        if (cancelled) return
        setBoot(next)
        configRevisionRef.current = next.configRevision
        draftGenerationRef.current += 1
        remoteConfigRef.current = null
        setRemoteUpdate(null)
        setCapabilitySnapshot(next.capabilitySnapshot)
        setConfig(structuredClone(next.config))
        setDirty(false)
        bootedRef.current = true
      } catch {
        if (!cancelled) setLoadError('设置页无法启动：预加载桥不可用或主进程未响应。')
      }
    })()

    const unsubscribeNotice = window.mingyue.settings.onNotice((message) => {
      notify(message, 'warn')
    })
    const unsubscribeActivity = window.mingyue.settings.onActivityChanged(() => {
      if (pageRef.current === 'privacy') void refreshActivityRef.current()
    })
    return () => {
      cancelled = true
      unsubscribeNotice()
      unsubscribeActivity()
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    }
  }, [notify])

  const refreshActivity = useCallback(async (): Promise<void> => {
    try {
      const [samples, snapshot] = await Promise.all([
        window.mingyue.settings.getActivityRaw(),
        window.mingyue.settings.getActivityStats()
      ])
      setRaw(samples)
      setStats(snapshot)
      setBoot((previous) =>
        previous === null ? previous : { ...previous, activityPaused: snapshot.userPaused }
      )
    } catch {
      notify('读取行为感知状态失败。', 'error')
    }
  }, [notify])

  const refreshActivityRef = useRef(refreshActivity)
  useEffect(() => {
    refreshActivityRef.current = refreshActivity
  }, [refreshActivity])

  // 隐私页打开时刷新；采样进行中每 5 秒更新本地面板。进程名只留在本渲染进程内。
  useEffect(() => {
    if (page !== 'privacy') return
    void refreshActivity()
    if (boot === null || !boot.config.worlds.activity.enabled) return
    const timer = window.setInterval(() => {
      void refreshActivity()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [page, refreshActivity, boot?.config.worlds.activity.enabled])


  const update = useCallback((path: readonly string[], value: unknown): void => {
    draftGenerationRef.current += 1
    setConfig((previous) => {
      if (previous === null) return previous
      return applyPath(previous, path, value)
    })
    setDirty(true)
  }, [])

  const adoptRemoteConfig = useCallback((): void => {
    const remote = remoteConfigRef.current
    if (remote === null) return
    configRevisionRef.current = remote.revision
    draftGenerationRef.current += 1
    remoteConfigRef.current = null
    setRemoteUpdate(null)
    setConfig(structuredClone(remote.config))
    setDirty(false)
    notify('已载入最新保存的配置，未保存草稿已丢弃。', 'info')
  }, [notify])

  const keepDraftOverRemote = useCallback((): void => {
    const remote = remoteConfigRef.current
    if (remote === null) return
    configRevisionRef.current = remote.revision
    remoteConfigRef.current = null
    setRemoteUpdate(null)
    if (dirtyRef.current) {
      notify('已确认外部修改；再次保存会以当前草稿覆盖它。', 'warn')
    } else {
      setConfig(structuredClone(remote.config))
      setDirty(false)
      notify('已载入最新保存的配置。', 'info')
    }
  }, [notify])

  const discardDraft = useCallback((): void => {
    const remote = remoteConfigRef.current
    const saved = remote?.config ?? boot?.config
    if (saved === undefined) return
    if (remote !== null) configRevisionRef.current = remote.revision
    draftGenerationRef.current += 1
    remoteConfigRef.current = null
    setRemoteUpdate(null)
    setConfig(structuredClone(saved))
    setDirty(false)
    notify('已放弃未保存的修改。', 'info')
  }, [boot, notify])

  const revokeExplorationNow = useCallback(async (): Promise<void> => {
    if (
      !window.confirm(
        '立即撤销自由探索授权？相关任务、标签页和文件范围会马上失效；其他未保存设置不会被保存。'
      )
    ) {
      return
    }
    try {
      const result = await window.mingyue.settings.revokeExploration()
      if (!result.ok) {
        notify(result.message, 'error')
        return
      }
      configRevisionRef.current = result.revision
      draftGenerationRef.current += 1
      setCapabilitySnapshot(result.capabilitySnapshot)
      setBoot((previous) =>
        previous === null
          ? previous
          : {
              ...previous,
              config: structuredClone(result.config),
              configRevision: result.revision,
              capabilitySnapshot: result.capabilitySnapshot
            }
      )
      // 只把授权切片同步进草稿；其他页面的未保存修改不受影响。
      setConfig((previous) =>
        previous === null
          ? previous
          : { ...previous, exploration: structuredClone(result.config.exploration) }
      )
      if (remoteConfigRef.current !== null) {
        remoteConfigRef.current = {
          config: structuredClone(result.config),
          revision: result.revision
        }
        setRemoteUpdate((previous) =>
          previous === null ? null : { ...previous, revision: result.revision }
        )
      }
      notify(result.message, 'ok')
      await Promise.all([loadTasks(), loadCapabilityGrants(), loadCompanion()])
    } catch {
      notify('撤销自由探索失败。', 'error')
    }
  }, [notify, loadTasks, loadCapabilityGrants, loadCompanion])

  const persistConfig = useCallback(
    async (
      snapshot: AppConfig,
      generation: number,
      silent: boolean,
      options: { localDraft?: AppConfig } = {}
    ): Promise<boolean> => {
      if (savingRef.current) return false
      if (remoteUpdate !== null && remoteUpdate.kind === 'conflict') {
        notify('请先处理配置冲突，再保存。', 'warn')
        return false
      }
      const baseRevision = configRevisionRef.current
      savingRef.current = true
      setSaving(true)
      try {
        const result = await window.mingyue.settings.saveConfig(snapshot, baseRevision)
        if (!result.ok) {
          if (result.conflict === true) {
            remoteConfigRef.current = {
              config: structuredClone(result.config),
              revision: result.revision
            }
            setRemoteUpdate({ kind: 'conflict', revision: result.revision })
          }
          notify(result.message ?? '保存失败。', result.conflict === true ? 'warn' : 'error')
          return false
        }
        configRevisionRef.current = result.revision
        remoteConfigRef.current = null
        setRemoteUpdate(null)
        const saved = structuredClone(result.config)
        setBoot((previous) =>
          previous === null
            ? previous
            : { ...previous, config: saved, configRevision: result.revision }
        )
        if (draftGenerationRef.current !== generation) {
          // 保存期间继续编辑：保留新草稿，绝不回退到请求快照。
          setDirty(true)
        } else if (options.localDraft !== undefined) {
          // 向导只保存它确认的字段；其他页面草稿继续留在本地。
          const draft = structuredClone(options.localDraft)
          setConfig(draft)
          setDirty(JSON.stringify(draft) !== JSON.stringify(saved))
        } else {
          // 没有更新的编辑：保存结果就是当前草稿。
          setConfig(saved)
          setDirty(false)
        }
        void window.mingyue.settings
          .capabilitySnapshot()
          .then(setCapabilitySnapshot)
          .catch(() => undefined)
        if (pageRef.current === 'advanced') void loadWorlds()
        if (!silent) {
          notify(
            draftGenerationRef.current === generation
              ? '设置已保存。'
              : '保存前的修改已写入；保存期间的新修改仍未保存。',
            draftGenerationRef.current === generation ? 'ok' : 'info'
          )
        }
        return true
      } catch {
        notify('保存失败，请检查主进程日志。', 'error')
        return false
      } finally {
        savingRef.current = false
        setSaving(false)
      }
    },
    [notify, loadWorlds, remoteUpdate]
  )

  const save = useCallback(
    async (silent = false): Promise<boolean> => {
      if (config === null) return false
      const snapshot = structuredClone(config)
      const generation = draftGenerationRef.current
      return persistConfig(snapshot, generation, silent)
    },
    [config, persistConfig]
  )

  const saveScoped = useCallback(
    async (
      paths: readonly ConfigPath[],
      options: { source?: AppConfig; silent?: boolean; message?: string } = {}
    ): Promise<boolean> => {
      if (config === null || boot === null) return false
      const source = options.source ?? config
      // 请求 = 最新已保存配置 + 本步骤明确拥有的字段；其他页面草稿不提交。
      const request = applyPaths(structuredClone(boot.config), source, paths)
      const localDraft = applyPaths(structuredClone(config), source, paths)
      draftGenerationRef.current += 1
      const generation = draftGenerationRef.current
      setConfig(localDraft)
      setDirty(JSON.stringify(localDraft) !== JSON.stringify(boot.config))
      const ok = await persistConfig(request, generation, true, { localDraft })
      if (ok && options.silent !== true) {
        const remaining = JSON.stringify(localDraft) !== JSON.stringify(request)
        notify(
          options.message ??
            (remaining
              ? '已保存当前步骤；其他未保存的修改仍然保留。'
              : '已保存并生效。'),
          'ok'
        )
      }
      return ok
    },
    [config, boot, persistConfig, notify]
  )

  // 已保存配置可能被托盘、快捷操作或其他窗口修改。定时读取只更新能力快照；
  // 版本变化时：干净草稿自动载入，脏草稿保留并显示冲突条，绝不静默覆盖。
  useEffect(() => {
    let cancelled = false
    const check = async (): Promise<void> => {
      if (!bootedRef.current || savingRef.current) return
      try {
        const snapshot = await window.mingyue.settings.capabilitySnapshot()
        if (cancelled) return
        setCapabilitySnapshot(snapshot)
        if (snapshot.configRevision === configRevisionRef.current) return
        const next = await window.mingyue.settings.bootstrap()
        if (cancelled || next.configRevision === configRevisionRef.current) return
        setBoot(next)
        setCapabilitySnapshot(next.capabilitySnapshot)
        if (dirtyRef.current) {
          remoteConfigRef.current = {
            config: structuredClone(next.config),
            revision: next.configRevision
          }
          setRemoteUpdate({ kind: 'external', revision: next.configRevision })
        } else {
          configRevisionRef.current = next.configRevision
          draftGenerationRef.current += 1
          remoteConfigRef.current = null
          setRemoteUpdate(null)
          setConfig(structuredClone(next.config))
          setDirty(false)
          notify('配置已在别处更新，已载入最新版本。', 'info')
        }
      } catch {
        // 主进程暂时不可达时保留当前草稿与状态，下一轮再试。
      }
    }
    const timer = window.setInterval(() => {
      void check()
    }, 15_000)
    const onFocus = (): void => {
      void check()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [notify])

  const saveKey = useCallback(async (): Promise<void> => {
    const key = keyInput.trim()
    if (key === '') {
      notify('请先粘贴 API Key。', 'warn')
      return
    }
    setKeyBusy(true)
    try {
      const result = await window.mingyue.settings.setApiKey(key)
      setBoot((previous) =>
        previous === null
          ? previous
          : { ...previous, keyStatus: result.status, hasApiKey: result.status.configured }
      )
      if (result.ok) {
        setKeyInput('')
        notify(result.message, 'ok')
      } else notify(result.message, 'error')
    } catch {
      notify('保存 API Key 失败。', 'error')
    } finally {
      setKeyBusy(false)
    }
  }, [keyInput, notify])

  const verifyKey = useCallback(async (): Promise<void> => {
    setKeyBusy(true)
    try {
      const typed = keyInput.trim()
      const result = await window.mingyue.settings.verifyApiKey(typed === '' ? undefined : typed)
      if (result.models !== undefined) setModels(result.models)
      notify(result.message, result.ok ? 'ok' : 'error')
    } catch {
      notify('验证 API Key 失败。', 'error')
    } finally {
      setKeyBusy(false)
    }
  }, [keyInput, notify])

  const clearKey = useCallback(async (): Promise<void> => {
    if (!window.confirm('删除已保存的 API Key？删除后无法聊天，但纯桌宠模式仍然可用。')) return
    setKeyBusy(true)
    try {
      const result = await window.mingyue.settings.clearApiKey()
      setBoot((previous) =>
        previous === null
          ? previous
          : { ...previous, keyStatus: result.status, hasApiKey: result.status.configured }
      )
      notify(result.message, result.ok ? 'ok' : 'error')
    } catch {
      notify('删除 API Key 失败。', 'error')
    } finally {
      setKeyBusy(false)
    }
  }, [notify])

  const listModels = useCallback(async (): Promise<void> => {
    setKeyBusy(true)
    try {
      const result = await window.mingyue.settings.listModels()
      if (result.ok) {
        setModels(result.models.map((model) => model.id))
        notify(`读取到 ${result.models.length} 个模型。`, 'ok')
      } else notify(result.message ?? '无法读取模型列表。', 'error')
    } catch {
      notify('无法读取模型列表。', 'error')
    } finally {
      setKeyBusy(false)
    }
  }, [notify])

  const chooseWorkspace = useCallback(async (): Promise<string | null> => {
    try {
      const result = await window.mingyue.settings.chooseWorkspace()
      if (!result.ok) {
        notify(result.message ?? '没有选择工作区。', 'warn')
        return null
      }
      return result.root
    } catch {
      notify('选择工作区失败。', 'error')
      return null
    }
  }, [notify])

  const chooseNotesRoot = useCallback(async (): Promise<string | null> => {
    try {
      const result = await window.mingyue.settings.chooseNotesRoot()
      if (!result.ok) {
        notify(result.message ?? '没有选择笔记目录。', 'warn')
        return null
      }
      return result.root
    } catch {
      notify('选择笔记目录失败。', 'error')
      return null
    }
  }, [notify])

  const chooseTrustedRoot = useCallback(async (): Promise<string | null> => {
    try {
      const result = await window.mingyue.settings.chooseTrustedRoot()
      if (!result.ok) {
        notify(result.message ?? '没有选择目录。', 'warn')
        return null
      }
      return result.root
    } catch {
      notify('选择信任目录失败。', 'error')
      return null
    }
  }, [notify])

  const chooseExplorationRoot = useCallback(async (): Promise<string | null> => {
    try {
      const result = await window.mingyue.settings.chooseExplorationRoot()
      if (!result.ok) {
        notify(result.message ?? '没有选择目录。', 'warn')
        return null
      }
      return result.root
    } catch {
      notify('选择探索目录失败。', 'error')
      return null
    }
  }, [notify])

  const chooseArtifactRoot = useCallback(async (): Promise<string | null> => {
    try {
      const result = await window.mingyue.settings.chooseArtifactRoot()
      if (!result.ok) {
        notify(result.message ?? '没有选择目录。', 'warn')
        return null
      }
      return result.root
    } catch {
      notify('选择作品目录失败。', 'error')
      return null
    }
  }, [notify])

  const clearRaw = useCallback(async (): Promise<void> => {
    try {
      await window.mingyue.settings.clearActivityRaw()
      setRaw([])
      notify('本地原始采样已清除。', 'ok')
    } catch {
      notify('清除失败。', 'error')
    }
  }, [notify])

  const clearStats = useCallback(async (): Promise<void> => {
    if (!window.confirm('清除本机保存的类别统计？原始采样不会写入磁盘，这一步不可恢复。')) return
    try {
      await window.mingyue.settings.clearActivityStats()
      notify('活动统计已清除。', 'ok')
      await refreshActivity()
    } catch {
      notify('清除统计失败。', 'error')
    }
  }, [notify, refreshActivity])

  const clearLocalData = useCallback(async (): Promise<void> => {
    const confirmed = window.confirm(
      [
        '清空本地数据？此操作不可恢复。',
        '',
        '将删除：聊天上下文、事件库、全部记忆、活动类别统计与原始采样、撤销快照、提醒、用量与日志。',
        '不会删除：设置、API Key、桌宠外观，以及工作区里的任何文件。'
      ].join('\n')
    )
    if (!confirmed) return
    setSaving(true)
    try {
      const result = await window.mingyue.settings.clearLocalData()
      notify(result.message, result.ok ? 'ok' : 'error')
      await Promise.all([refreshBoot(), refreshActivity()])
    } catch {
      notify('清空本地数据失败。', 'error')
    } finally {
      setSaving(false)
    }
  }, [notify, refreshBoot, refreshActivity])

  const setActivityPaused = useCallback(
    async (paused: boolean): Promise<void> => {
      try {
        await window.mingyue.settings.setActivityPaused(paused)
        setBoot((previous) => (previous === null ? previous : { ...previous, activityPaused: paused }))
        notify(paused ? '行为感知已暂停。' : '行为感知已恢复。', 'ok')
      } catch {
        notify('切换感知状态失败。', 'error')
      }
    },
    [notify]
  )

  const setAgentPaused = useCallback(
    async (paused: boolean): Promise<void> => {
      try {
        await window.mingyue.settings.setAgentPaused(paused)
        setBoot((previous) => (previous === null ? previous : { ...previous, agentPaused: paused }))
        notify(paused ? '对话总线已暂停。' : '对话总线已恢复。', 'ok')
      } catch {
        notify('切换暂停状态失败。', 'error')
      }
    },
    [notify]
  )

  const setAutoLaunch = useCallback(
    async (enabled: boolean): Promise<void> => {
      try {
        const actual = await window.mingyue.settings.setAutoLaunch(enabled)
        setBoot((previous) => (previous === null ? previous : { ...previous, autoLaunch: actual }))
        if (actual !== enabled) notify('开机启动没有生效；开发模式下不会写入系统启动项。', 'warn')
        else notify(actual ? '已开启开机启动。' : '已关闭开机启动。', 'ok')
      } catch {
        notify('设置开机启动失败。', 'error')
      }
    },
    [notify]
  )



  const resetPetSettings = useCallback(async (): Promise<void> => {
    if (!window.confirm('重置桌宠页面的本地设置（位置、缩放、装扮等）？')) return
    try {
      const result = await window.mingyue.settings.resetPetSettings()
      notify(result.message ?? '桌宠设置已重置。', result.ok ? 'ok' : 'error')
    } catch {
      notify('重置桌宠设置失败。', 'error')
    }
  }, [notify])

  const petCommand = useCallback(
    async (command: PetCommand): Promise<void> => {
      try {
        await window.mingyue.settings.petCommand(command)
      } catch {
        notify('桌宠命令发送失败。', 'error')
      }
    },
    [notify]
  )

  const openChat = useCallback(async (): Promise<void> => {
    try {
      await window.mingyue.settings.openChat()
    } catch {
      notify('打开聊天窗口失败。', 'error')
    }
  }, [notify])


  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (dirty && !saving && remoteUpdate?.kind !== 'conflict') void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty, saving, remoteUpdate, save])

  const value = useMemo<SettingsContextValue | null>(() => {
    if (boot === null || config === null) return null
    return {
      boot,
      config,
      dirty,
      saving,
      notice,
      notify,
      update,
      saveScoped,
      save,
      page,
      computerSection,
      navigate,
      setTab,
      refreshBoot,
      capabilitySnapshot,
      remoteUpdate,
      adoptRemoteConfig,
      keepDraftOverRemote,
      discardDraft,
      revokeExplorationNow,
      keyInput,
      setKeyInput,
      keyBusy,
      models,
      saveKey,
      verifyKey,
      clearKey,
      listModels,
      chooseWorkspace,
      chooseNotesRoot,
      chooseTrustedRoot,
      chooseExplorationRoot,
      chooseArtifactRoot,
      approvalGrants,
      loadApprovalGrants,
      clearApprovalGrants,
      cuaStatus,
      loadCuaStatus,
      stopCua,
      clearCuaGrants,
      tasks,
      loadTasks,
      taskAction,
      capabilityGrants,
      loadCapabilityGrants,
      revokeCapability,
      discovery,
      loadDiscovery,
      systemRecent,
      loadSystemRecent,
      clearSystemRecent,
      companion,
      loadCompanion,
      companionAction,
      screenCompanionTest,
      raw,
      stats,
      refreshActivity,
      clearRaw,
      clearStats,
      clearLocalData,
      setActivityPaused,
      setAgentPaused,
      setAutoLaunch,
      memory,
      memFile,
      memText,
      memMode,
      memQuery,
      setMemFile,
      setMemText,
      setMemMode,
      setMemQuery,
      loadMemory,
      saveMemory,
      forgetFile,
      forgetQuery,
      worlds,
      loadWorlds,
      diagnostics,
      loadDiagnostics,
      exportDiagnostics,
      undoEntries,
      loadUndo,
      undoNow,
      resetPetSettings,
      petCommand,
      openChat
    }
  }, [
    boot,
    config,
    dirty,
    saving,
    notice,
    notify,
    update,
    saveScoped,
    save,
    page,
    computerSection,
    navigate,
    setTab,
    refreshBoot,
    capabilitySnapshot,
    remoteUpdate,
    adoptRemoteConfig,
    keepDraftOverRemote,
    discardDraft,
    revokeExplorationNow,
    keyInput,
    keyBusy,
    models,
    saveKey,
    verifyKey,
    clearKey,
    listModels,
    chooseWorkspace,
    chooseNotesRoot,
    chooseTrustedRoot,
    chooseExplorationRoot,
    chooseArtifactRoot,
    approvalGrants,
    loadApprovalGrants,
    clearApprovalGrants,
    cuaStatus,
    loadCuaStatus,
    stopCua,
    clearCuaGrants,
    tasks,
    loadTasks,
    taskAction,
    capabilityGrants,
    loadCapabilityGrants,
    revokeCapability,
    discovery,
    loadDiscovery,
    systemRecent,
    loadSystemRecent,
    clearSystemRecent,
    companion,
    loadCompanion,
    companionAction,
    screenCompanionTest,
    raw,
    stats,
    refreshActivity,
    clearRaw,
    clearStats,
    clearLocalData,
    setActivityPaused,
    setAgentPaused,
    setAutoLaunch,
    memory,
    memFile,
    memText,
    memMode,
    memQuery,
    setMemFile,
    loadMemory,
    saveMemory,
    forgetFile,
    forgetQuery,
    worlds,
    loadWorlds,
    diagnostics,
    loadDiagnostics,
    exportDiagnostics,
    undoEntries,
    loadUndo,
    undoNow,
    resetPetSettings,
    petCommand,
    openChat
  ])

  if (loadError !== null) {
    return (
      <div className="boot-error">
        <h1>设置页启动失败</h1>
        <p>{loadError}</p>
      </div>
    )
  }

  if (value === null || boot === null || config === null) {
    return <div className="loading">正在读取设置…</div>
  }

  const meta = SETTINGS_PAGES.find((item) => item.id === page)

  return (
    <SettingsContext.Provider value={value}>
      <div className="settings-shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">❖</span>
            <div>
              <strong>桌宠</strong>
              <span>桌面鲸鱼娘</span>
            </div>
          </div>
          <div className="nav-search" role="search">
            <label className="nav-search-label" htmlFor="settings-search">
              搜索设置
            </label>
            <input
              id="settings-search"
              className="input nav-search-input"
              type="search"
              autoComplete="off"
              spellCheck={false}
              placeholder="例如：浏览器、文件、撤销…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSearch('')
                  return
                }
                if (event.key === 'Enter') {
                  const first = searchResults[0]
                  if (first !== undefined) {
                    event.preventDefault()
                    navigate(first.page, first.anchor)
                  }
                }
              }}
              aria-controls="settings-search-results"
            />
            {search.trim() !== '' && (
              <ul className="search-results" id="settings-search-results">
                {searchResults.length === 0 ? (
                  <li className="search-empty">没有匹配的设置</li>
                ) : (
                  searchResults.map((entry) => (
                    <li key={`${entry.page}-${entry.anchor}-${entry.label}`}>
                      <button
                        type="button"
                        className="search-result"
                        onClick={() => navigate(entry.page, entry.anchor)}
                      >
                        <strong>{entry.label}</strong>
                        <span>{entry.detail}</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
          <nav className="nav" aria-label="设置页面">
            {SETTINGS_PAGES.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`nav-item ${page === item.id ? 'is-active' : ''}`}
                aria-current={page === item.id ? 'page' : undefined}
                onClick={() => navigate(item.id)}
              >
                <span className="nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span>{item.label}</span>
                {item.id === 'overview' && !boot.keyStatus.configured && (
                  <span className="nav-dot" title="待配置 API Key" />
                )}
                {item.id === 'computer' && remoteUpdate !== null && (
                  <span className="nav-dot" title="配置有外部更新或冲突" />
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-foot">
            <span>v{boot.version}</span>
            <span>{boot.platform}</span>
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            <div>
              <h1>{meta?.title ?? '设置'}</h1>
            </div>
            <div className="topbar-actions">
              {dirty && <span className="dirty-chip">未保存</span>}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void openChat()}
              >
                打开聊天
              </button>
              {dirty && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={saving}
                  onClick={() => {
                    if (!window.confirm('放弃所有未保存的修改？其他页面草稿也会被丢弃。')) return
                    discardDraft()
                  }}
                >
                  放弃
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary"
                disabled={!dirty || saving || remoteUpdate?.kind === 'conflict'}
                onClick={() => void save()}
              >
                {saving ? '保存中…' : '保存设置'}
              </button>
            </div>
          </header>

          {notice !== null && (
            <div className={`notice notice-${notice.kind}`} role="status">
              {notice.text}
            </div>
          )}

          {boot.warning !== null && (
            <div className="notice notice-warn">{boot.warning}</div>
          )}

          {remoteUpdate !== null && (
            <div className="notice notice-warn remote-update" role="alert">
              <span>
                {remoteUpdate.kind === 'conflict'
                  ? '保存冲突：磁盘上的配置比你的草稿新，未覆盖它。'
                  : '配置已在别处更新。当前草稿仍保留，不会自动覆盖。'}
              </span>
              <span className="remote-update-actions">
                <button type="button" className="btn btn-ghost" onClick={adoptRemoteConfig}>
                  载入最新配置
                </button>
                <button type="button" className="btn btn-ghost" onClick={keepDraftOverRemote}>
                  {dirty ? '保留草稿并覆盖' : '保留最新配置'}
                </button>
                {dirty && (
                  <button type="button" className="btn btn-ghost" onClick={discardDraft}>
                    放弃草稿
                  </button>
                )}
              </span>
            </div>
          )}

          <div className="content" ref={contentRef}>
            {page === 'overview' && <OverviewPage />}
            {page === 'companion' && <CompanionPage />}
            {page === 'computer' && <ComputerPage />}
            {page === 'activity' && <ActivityPage />}
            {page === 'model' && <ModelPage />}
            {page === 'privacy' && <PrivacyPage />}
            {page === 'advanced' && <AdvancedPage />}
          </div>
        </main>
      </div>
    </SettingsContext.Provider>
  )
}
