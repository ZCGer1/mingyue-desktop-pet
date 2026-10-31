import type { AppConfig, ExplorationConfig, VolumeAccessMode } from './config'
import { volumeScopeAllowsVolumes } from './fileScope'
import { domainMatchesAny } from './domain'
import { normalizeProcessKey } from './processName'

/**
 * 「自由探索」的有效视图。
 *
 * 它只描述用户当前授权了什么，不铸造任务 grant，也不检查 World 自己的
 * 开关/同意。设置页、提示词、能力检查与自主就绪诊断共用这一份事实，
 * 避免出现“设置显示已开启，实际范围为空”的分裂。
 */
export interface EffectiveExploration {
  enabled: boolean
  /** 当前时间下授权是否仍然有效（session 可能已到期）。 */
  active: boolean
  web: boolean
  browserTabs: boolean
  apps: boolean
  windows: boolean
  fullScreen: boolean
  fileRead: boolean
  /** 当前生效的磁盘范围模式；实际卷根由统一解析器按可用性加入。 */
  volumeScope: VolumeAccessMode
  artifacts: boolean
  edits: boolean
  includeProfile: boolean
  includeNewApps: boolean
  readRoots: string[]
  artifactRoot: string | null
  excludedDomains: string[]
  excludedApps: string[]
}

/** 只看授权本身；World 的开关/同意仍由 World 自己判断。 */
export function explorationActive(config: AppConfig, now = Date.now()): boolean {
  const exploration = config.exploration
  if (exploration.enabled !== true || typeof exploration.grantedAt !== 'number') return false
  if (exploration.scope === 'always') return true
  return (
    exploration.sessionExpiresAt === null ||
    (typeof exploration.sessionExpiresAt === 'number' && exploration.sessionExpiresAt > now)
  )
}

/**
 * 作品目录：用户指定的目录优先；未指定时回退到笔记目录、工作区根目录。
 * 三者都没有时返回 null，作品写入必须 fail closed，而不是悄悄落到应用数据目录。
 */
export function explorationArtifactRoot(
  config: AppConfig,
  exploration: ExplorationConfig = config.exploration
): string | null {
  const explicit = exploration.artifactRoot.trim()
  if (explicit !== '') return explicit
  const notes = config.worlds.workspace.notesRoot.trim()
  if (notes !== '') return notes
  const workspace = config.worlds.workspace.root.trim()
  return workspace === '' ? null : workspace
}

export function effectiveExploration(
  config: AppConfig,
  now = Date.now()
): EffectiveExploration {
  const exploration = config.exploration
  const active = explorationActive(config, now)
  const artifactRoot = explorationArtifactRoot(config, exploration)
  const readRoots = exploration.readRoots
    .map((root) => root.trim())
    .filter((root) => root !== '')
  return {
    enabled: exploration.enabled === true,
    active,
    web: active && exploration.web,
    browserTabs: active && exploration.browserTabs,
    apps: active && exploration.apps,
    windows: active && exploration.windows,
    fullScreen: active && exploration.fullScreen,
    fileRead: active && exploration.fileRead,
    volumeScope: exploration.volumeScope,
    artifacts: active && exploration.artifacts && artifactRoot !== null,
    edits: active && exploration.edits,
    includeProfile: active && exploration.includeProfile,
    includeNewApps: exploration.includeNewApps === true,
    readRoots,
    artifactRoot: active && exploration.artifacts ? artifactRoot : null,
    excludedDomains: [...exploration.excludedDomains],
    excludedApps: [...exploration.excludedApps]
  }
}

/** 当前是否允许按磁盘模式自动纳入卷根（仍需逐个卷实际可读）。 */
export function explorationVolumeRootsEnabled(
  view: Pick<EffectiveExploration, 'active' | 'fileRead' | 'volumeScope'>
): boolean {
  return view.active && view.fileRead && volumeScopeAllowsVolumes(view.volumeScope)
}

/** 用户在排除列表里的站点不能自动浏览；明确点击外链后由浏览器 World 再判断。 */
export function isExplorationDomainExcluded(
  exploration: Pick<EffectiveExploration, 'excludedDomains'>,
  target: unknown
): boolean {
  return domainMatchesAny(exploration.excludedDomains, target)
}

/**
 * 应用排除匹配：优先规范化进程名；无法规范化时退回大小写不敏感的原文比较，
 * 让“记事本”这类中文显示名也能被用户排除。
 */
export function isExplorationAppExcluded(
  exploration: Pick<EffectiveExploration, 'excludedApps'>,
  app: unknown
): boolean {
  if (typeof app !== 'string') return false
  const raw = app.trim()
  if (raw === '') return false
  const key = normalizeProcessKey(raw)
  for (const entry of exploration.excludedApps) {
    const excludedRaw = entry.trim()
    if (excludedRaw === '') continue
    if (excludedRaw.toLowerCase() === raw.toLowerCase()) return true
    const excludedKey = normalizeProcessKey(excludedRaw)
    if (excludedKey !== null && key !== null && excludedKey === key) return true
  }
  return false
}
