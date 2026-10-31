import { createContext, useContext } from 'react'
import type { AppConfig } from '../../shared/config'
import type { SettingsPageId } from '../../shared/capabilityStatus'
import type {
  ActivityRawSampleView,
  ActivityStatsView,
  ApprovalGrantView,
  CapabilityGrantView,
  CapabilitySnapshotView,
  CompanionActionView,
  CompanionSnapshotView,
  CuaStatusView,
  DiagnosticsView,
  DiscoverySettingsView,
  MemoryFileName,
  MemorySnapshotView,
  PetCommand,
  SettingsBootstrap,
  SystemRecentActionView,
  TaskActionView,
  TaskView,
  UndoEntryView,
  WorldHealthView
} from '../../shared/ipc'
import type { ConfigPath } from './configTree'

export type { SettingsPageId } from '../../shared/capabilityStatus'

/** 旧设置页的分区 id；只作为组件定位与旧跳转兼容使用，不再是顶层导航。 */
export type TabId =
  | 'start'
  | 'persona'
  | 'autonomy'
  | 'memory'
  | 'files'
  | 'system'
  | 'cua'
  | 'worlds'
  | 'model'
  | 'security'
  | 'privacy'
  | 'browser'
  | 'chat'
  | 'diagnostics'
  | 'about'

export type NoticeKind = 'ok' | 'warn' | 'error' | 'info'

export interface Notice {
  kind: NoticeKind
  text: string
}

/** 电脑能力的六个子页；“自主与授权”是顶部共用组，不是第七项能力。 */
export type ComputerSection = 'web' | 'bilibili' | 'apps' | 'screen' | 'files' | 'artifacts'

export interface ComputerSectionMeta {
  id: ComputerSection
  label: string
  anchors: readonly string[]
}

export const COMPUTER_SECTIONS: readonly ComputerSectionMeta[] = [
  { id: 'web', label: '网页', anchors: ['web', 'browser', 'browserPage', 'browserControl', 'web-advanced'] },
  { id: 'bilibili', label: 'B 站', anchors: ['bilibili', 'bili', 'bilibili-advanced'] },
  { id: 'apps', label: '应用', anchors: ['apps', 'system', 'app-whitelist', 'apps-advanced'] },
  {
    id: 'screen',
    label: '屏幕',
    anchors: ['screen', 'cua', 'vision', 'perception', 'desktop', 'window', 'screen-advanced']
  },
  { id: 'files', label: '文件', anchors: ['files', 'filescope', 'workspace', 'trusted', 'files-advanced'] },
  { id: 'artifacts', label: '作品空间', anchors: ['artifacts', 'artifact', 'artifacts-root'] }
]

/** 锚点定位到电脑能力时，自动切到对应子页。 */
export function computerSectionForAnchor(anchor: string | null): ComputerSection | null {
  if (anchor === null) return null
  const key = anchor.toLowerCase()
  for (const section of COMPUTER_SECTIONS) {
    if (section.anchors.some((item) => item.toLowerCase() === key)) return section.id
  }
  return null
}

export const DEFAULT_COMPUTER_SECTION: ComputerSection = 'web'

export interface SettingsContextValue {
  boot: SettingsBootstrap
  config: AppConfig
  dirty: boolean
  saving: boolean
  notice: Notice | null
  notify(text: string, kind?: NoticeKind): void
  update(path: ReadonlyArray<string>, value: unknown): void
  /** 只提交指定配置字段：以最新已保存配置为基础合并，保留其他页面草稿。 */
  saveScoped(
    paths: readonly ConfigPath[],
    options?: { source?: AppConfig; silent?: boolean; message?: string }
  ): Promise<boolean>
  save(silent?: boolean): Promise<boolean>
  refreshBoot(): Promise<void>
  /** 主进程能力快照（已保存授权 + 运行时事实），不含未保存草稿。 */
  capabilitySnapshot: CapabilitySnapshotView | null
  /** 外部修改或保存冲突；存在时不能直接再次保存。 */
  remoteUpdate: { kind: 'external' | 'conflict'; revision: number } | null
  adoptRemoteConfig(): void
  keepDraftOverRemote(): void
  discardDraft(): void
  /** 立即撤销已保存的自由探索授权；不会保存其他草稿。 */
  revokeExplorationNow(): Promise<void>

  keyInput: string
  setKeyInput(value: string): void
  keyBusy: boolean
  models: string[]
  saveKey(): Promise<void>
  verifyKey(): Promise<void>
  clearKey(): Promise<void>
  listModels(): Promise<void>

  /** 选择目录；取消时返回 null。写入草稿由调用方完成，向导与设置页共用。 */
  chooseWorkspace(): Promise<string | null>
  chooseNotesRoot(): Promise<string | null>
  chooseTrustedRoot(): Promise<string | null>
  chooseExplorationRoot(): Promise<string | null>
  chooseArtifactRoot(): Promise<string | null>
  approvalGrants: ApprovalGrantView[]
  loadApprovalGrants(): Promise<void>
  clearApprovalGrants(): Promise<void>

  cuaStatus: CuaStatusView | null
  loadCuaStatus(): Promise<void>
  stopCua(): Promise<void>
  clearCuaGrants(): Promise<void>

  tasks: TaskView[]
  loadTasks(): Promise<void>
  taskAction(id: string, action: TaskActionView): Promise<void>
  capabilityGrants: CapabilityGrantView[]
  loadCapabilityGrants(): Promise<void>
  revokeCapability(id: string): Promise<void>

  discovery: DiscoverySettingsView | null
  loadDiscovery(): Promise<void>
  systemRecent: SystemRecentActionView[]
  loadSystemRecent(): Promise<void>
  clearSystemRecent(): Promise<void>

  companion: CompanionSnapshotView | null
  loadCompanion(): Promise<void>
  companionAction(action: CompanionActionView, interestId?: string): Promise<void>
  /** 一次陪伴反馈测试；不提高截图频率、不绕过同意/安静。 */
  screenCompanionTest(): Promise<void>

  raw: ActivityRawSampleView[]
  stats: ActivityStatsView | null
  refreshActivity(): Promise<void>
  clearRaw(): Promise<void>
  clearStats(): Promise<void>
  clearLocalData(): Promise<void>
  setActivityPaused(paused: boolean): Promise<void>
  setAgentPaused(paused: boolean): Promise<void>
  setAutoLaunch(enabled: boolean): Promise<void>

  memory: MemorySnapshotView | null
  memFile: MemoryFileName
  memText: string
  memMode: 'replace' | 'append'
  memQuery: string
  setMemFile(file: MemoryFileName): void
  setMemText(text: string): void
  setMemMode(mode: 'replace' | 'append'): void
  setMemQuery(query: string): void
  loadMemory(file?: MemoryFileName): Promise<void>
  saveMemory(): Promise<void>
  forgetFile(): Promise<void>
  forgetQuery(): Promise<void>

  worlds: WorldHealthView[]
  loadWorlds(): Promise<void>
  diagnostics: DiagnosticsView | null
  loadDiagnostics(): Promise<void>
  exportDiagnostics(): Promise<void>
  undoEntries: UndoEntryView[]
  loadUndo(): Promise<void>
  undoNow(count?: number): Promise<void>
  resetPetSettings(): Promise<void>
  petCommand(command: PetCommand): Promise<void>
  openChat(): Promise<void>

  /** 当前 7 个顶层页面之一。 */
  page: SettingsPageId
  /** 电脑能力当前子页；其他页面忽略。 */
  computerSection: ComputerSection
  /** 切到顶层页面，可选定位到该页内的锚点。 */
  navigate(page: SettingsPageId, anchor?: string): void
  /** 兼容旧的页内跳转：映射到新页面与锚点。 */
  setTab(tab: TabId): void
}

export interface SettingsPageMeta {
  id: SettingsPageId
  label: string
  icon: string
  title: string
  keywords: string[]
}

export const SETTINGS_PAGES: readonly SettingsPageMeta[] = [
  {
    id: 'overview',
    label: '概览',
    icon: '◈',
    title: '概览',
    keywords: ['开始', '状态', '停止', '暂停', '模型', '向导', '配置', '重新配置']
  },
  {
    id: 'companion',
    label: '陪伴与外观',
    icon: '◐',
    title: '陪伴与外观',
    keywords: ['人格', '聊天', '桌宠', '主动', '安静', '外观', '快捷输入', '节奏']
  },
  {
    id: 'computer',
    label: '电脑能力',
    icon: '▦',
    title: '电脑能力',
    keywords: ['权限', '浏览器', '扩展', '应用', '屏幕', '键鼠', '文件', '目录', '作品', '审批', '探索', '授权', 'B站']
  },
  {
    id: 'activity',
    label: '活动与任务',
    icon: '◎',
    title: '活动与任务',
    keywords: ['自主', '任务', '兴趣', '经历', '探索', '暂停', '继续', '取消', '发现', '撤销', '记录']
  },
  {
    id: 'model',
    label: '模型与用量',
    icon: '▤',
    title: '模型与用量',
    keywords: ['密钥', 'API Key', '模型', '上下文', '预算', '费用', 'token', '图片']
  },
  {
    id: 'privacy',
    label: '记忆与隐私',
    icon: '◇',
    title: '记忆与隐私',
    keywords: ['记忆', '隐私', '感知', '采集', '排除', '清理', '行为']
  },
  {
    id: 'advanced',
    label: '高级与诊断',
    icon: '⌁',
    title: '高级与诊断',
    keywords: ['Worlds', '诊断', '日志', '导出', '版本', '关于', '许可', '维护', '终端', '自启动']
  }
]

/** 旧分区到新页面（与电脑子页）的重定向。 */
export const TAB_ROUTE: Record<TabId, { page: SettingsPageId; anchor: string }> = {
  start: { page: 'overview', anchor: 'overview' },
  persona: { page: 'companion', anchor: 'persona' },
  chat: { page: 'companion', anchor: 'chat' },
  autonomy: { page: 'activity', anchor: 'activity' },
  memory: { page: 'privacy', anchor: 'memory' },
  privacy: { page: 'privacy', anchor: 'perception' },
  files: { page: 'computer', anchor: 'files' },
  system: { page: 'computer', anchor: 'apps' },
  cua: { page: 'computer', anchor: 'screen' },
  browser: { page: 'computer', anchor: 'web' },
  security: { page: 'computer', anchor: 'exploration' },
  worlds: { page: 'advanced', anchor: 'worlds' },
  model: { page: 'model', anchor: 'model' },
  diagnostics: { page: 'advanced', anchor: 'diagnostics' },
  about: { page: 'advanced', anchor: 'about' }
}

export const DEFAULT_PAGE: SettingsPageId = 'overview'

export const SettingsContext = createContext<SettingsContextValue | null>(null)

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext)
  if (value === null) throw new Error('settings context missing')
  return value
}
