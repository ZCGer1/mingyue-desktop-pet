import type { VolumeAccessMode } from './config'

/**
 * 统一文件范围视图。
 *
 * 主进程 `FileScopeResolver` 生成唯一一份有效范围；设置页、能力卡片、
 * 就绪摘要和提示词都读取它，不再各自按开关重新拼接目录列表。
 * 这里包含真实路径（用户自己的配置/磁盘挂载点），只能进入本机设置页与
 * 当前用户的诊断视图，不写日志、不进入会话。
 */

export type FileScopeSourceKind =
  | 'workspace'
  | 'notes'
  | 'artifact'
  | 'trusted'
  | 'files'
  | 'exploration'
  | 'profile'
  | 'volume'

export const FILE_SCOPE_SOURCE_LABELS: Record<FileScopeSourceKind, string> = {
  workspace: '工作区',
  notes: '笔记目录',
  artifact: '作品目录',
  trusted: '信任目录',
  files: '文件显式目录',
  exploration: '自由探索显式目录',
  profile: '个人资料目录',
  volume: '已挂载磁盘'
}

export function fileScopeSourceLabel(kind: FileScopeSourceKind): string {
  return FILE_SCOPE_SOURCE_LABELS[kind]
}

export function fileScopeModeLabel(mode: VolumeAccessMode): string {
  if (mode === 'all') return '全部已挂载磁盘'
  if (mode === 'non-system') return '全部非系统磁盘'
  return '仅指定目录'
}

/** 该模式是否会让已挂载卷自动进入候选读取范围。 */
export function volumeScopeAllowsVolumes(mode: VolumeAccessMode): boolean {
  return mode === 'all' || mode === 'non-system'
}

export interface FileScopeRootView {
  path: string
  /** 这个根为什么在范围里；去重后保留全部来源，不丢工作区等标签。 */
  sources: FileScopeSourceKind[]
  available: boolean
  /** 不可用原因（目录不存在、卷离线、受保护位置）；可用时为 null。 */
  reason: string | null
  /** 由磁盘模式自动加入的挂载根，而不是用户逐条选择的目录。 */
  volume: boolean
  /** 该挂载根包含 Windows 系统目录。 */
  systemVolume: boolean
}

export interface FileScopeVolumeSummary {
  status: string
  total: number
  /** 当前账户实际可读的卷数（与是否授权无关）。 */
  readable: number
  /** 被当前磁盘模式自动纳入的卷数。 */
  authorized: number
  /** 离线、无权限或无挂载点的卷数。 */
  unavailable: number
  /** 包含 Windows 系统目录的卷数。 */
  system: number
  version: number
}

export interface FileScopeView {
  /** 范围版本：配置、授权状态或卷快照变化时递增；两个页面据此判断同源。 */
  version: number
  generatedAt: number
  active: boolean
  mode: VolumeAccessMode
  modeLabel: string
  /** 去重后的候选根；包含当前不可用项，便于解释为什么少了范围。 */
  roots: FileScopeRootView[]
  /** 当前真正可读、并且会被执行路径使用的根。 */
  readRoots: string[]
  /** 连续编辑的显式根；与读取范围分开，永不包含自动发现的卷根。 */
  writeRoots: string[]
  artifactRoot: string | null
  /** 用户排除项（绝对路径或通配片段），执行时仍由守卫逐路径应用。 */
  excluded: string[]
  volumes: FileScopeVolumeSummary
  includesWorkspace: boolean
  includesNotes: boolean
  includesProfile: boolean
  /** 候选根中当前不可用的数量（不含离线的自动卷）。 */
  unavailableRoots: number
}
