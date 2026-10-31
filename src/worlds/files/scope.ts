import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, resolve } from 'node:path'
import type { AppConfig, VolumeAccessMode } from '../../shared/config'
import { isVolumeAccessMode } from '../../shared/config'
import {
  effectiveExploration,
  explorationVolumeRootsEnabled,
  type EffectiveExploration
} from '../../shared/exploration'
import {
  fileScopeModeLabel,
  volumeScopeAllowsVolumes,
  type FileScopeRootView,
  type FileScopeSourceKind,
  type FileScopeView
} from '../../shared/fileScope'
import { isPathInside, isUncPath, normalizedForCompare } from '../workspace/guard'
import type { VolumeScopeView } from '../../shared/volumeScope'
import type { VolumeReader } from './volumes'

/**
 * 主进程唯一的有效文件范围解析器。
 *
 * 语义：
 *   候选读取范围 = 工作区 ∪ 笔记目录 ∪ 作品目录 ∪ 信任目录
 *                ∪ 文件显式目录 ∪ 自由探索显式目录 ∪ 已授权个人目录
 *                ∪ 当前模式涵盖的已挂载卷
 *   有效读取范围 = 候选范围中当前可访问的部分 − 用户排除项 − 受保护内容
 *
 * `readRoots` 只包含 realpath 成功且未被用户排除的目录；不可用候选仍保留
 * 在 `roots` 里说明原因，方便 UI 区分“没授权”和“授权了但盘/目录现在不可用”。
 * 这个结果只做授权与展示；逐文件敏感名、符号链接逃逸仍由 FilesGuard 判断。
 */

export interface EffectiveFileScope {
  version: number
  generatedAt: number
  active: boolean
  mode: VolumeAccessMode
  roots: FileScopeRootView[]
  readRoots: string[]
  editRoots: string[]
  artifactRoot: string | null
  volumes: FileScopeView['volumes']
}

interface Candidate {
  raw: string
  kind: FileScopeSourceKind
  volume: boolean
  systemVolume: boolean
}

interface FileScopeResolverOptions {
  getConfig: () => AppConfig
  volumes?: VolumeReader | null
  /** 应用数据目录等必须排除的路径。 */
  deniedRoots?: () => string[]
  now?: () => number
}

const PROTECTED_ROOT_SEGMENTS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  'system volume information',
  '$recycle.bin'
])

export class FileScopeResolver {
  private readonly getConfig: () => AppConfig
  private readonly volumes: VolumeReader | null
  private readonly getDeniedRoots: () => string[]
  private readonly now: () => number
  private cached: EffectiveFileScope | null = null
  private cachedKey = ''
  private version = 0

  constructor(options: FileScopeResolverOptions) {
    this.getConfig = options.getConfig
    this.volumes = options.volumes ?? null
    this.getDeniedRoots = options.deniedRoots ?? (() => [])
    this.now = options.now ?? Date.now
  }

  /** 同步读取；过期卷快照通过 VolumeScope 自己在后台刷新，不阻塞这里。 */
  resolve(): EffectiveFileScope {
    const config = this.getConfig()
    const view = effectiveExploration(config, this.now())
    const volumeSnapshot = this.volumes?.current() ?? null
    const denied = this.getDeniedRoots()
    const key = scopeKey(config, view, volumeSnapshot, denied)
    if (this.cached !== null && key === this.cachedKey) return cloneScope(this.cached)

    const mode = isVolumeAccessMode(config.exploration.volumeScope)
      ? config.exploration.volumeScope
      : 'explicit'
    const candidates = readCandidates(config, view, volumeSnapshot, mode)
    const roots = this.resolveCandidates(candidates, config)
    const readRoots = roots.filter((root) => root.available).map((root) => root.path)
    const editRoots = this.resolveEditRoots(config, view)
    const artifactRoot = this.resolveArtifactRoot(config, view)

    this.version += 1
    this.cachedKey = key
    this.cached = {
      version: this.version,
      generatedAt: this.now(),
      active: view.active,
      mode,
      roots,
      readRoots,
      editRoots,
      artifactRoot,
      volumes: summarizeVolumes(
        volumeSnapshot,
        mode,
        explorationVolumeRootsEnabled(view) && volumeScopeAllowsVolumes(mode)
      )
    }
    return cloneScope(this.cached)
  }

  /** 设置页/诊断使用的公开视图；与执行路径读取同一份解析结果。 */
  view(): FileScopeView {
    const scope = this.resolve()
    const config = this.getConfig()
    return {
      version: scope.version,
      generatedAt: scope.generatedAt,
      active: scope.active,
      mode: scope.mode,
      modeLabel: fileScopeModeLabel(scope.mode),
      roots: scope.roots.map((root) => ({ ...root, sources: [...root.sources] })),
      readRoots: [...scope.readRoots],
      writeRoots: [...scope.editRoots],
      artifactRoot: scope.artifactRoot,
      excluded: [...config.worlds.files.exclude],
      volumes: { ...scope.volumes },
      includesWorkspace: scope.roots.some((root) => root.sources.includes('workspace')),
      includesNotes: scope.roots.some((root) => root.sources.includes('notes')),
      includesProfile: scope.roots.some((root) => root.sources.includes('profile')),
      unavailableRoots: scope.roots.filter((root) => !root.available && !root.volume).length
    }
  }

  private resolveCandidates(
    candidates: readonly Candidate[],
    config: AppConfig
  ): FileScopeRootView[] {
    const merged = new Map<
      string,
      {
        path: string
        sources: Set<FileScopeSourceKind>
        available: boolean
        reason: string | null
        volume: boolean
        systemVolume: boolean
      }
    >()
    for (const candidate of candidates) {
      if (candidate.raw.trim() === '' || isUncPath(candidate.raw)) continue
      const raw = resolve(candidate.raw)
      const excludedReason = this.exclusionReason(raw, config)
      let real: string | null = null
      let reason = excludedReason
      if (reason === null) {
        const resolved = tryRealDir(raw)
        if (resolved.ok) real = resolved.real
        else reason = resolved.reason
      }
      const path = real ?? raw
      const key = normalizedForCompare(real ?? raw)
      const existing = merged.get(key)
      if (existing !== undefined) {
        for (const kind of [candidate.kind]) existing.sources.add(kind)
        existing.available = existing.available && real !== null
        existing.volume = existing.volume || candidate.volume
        existing.systemVolume = existing.systemVolume || candidate.systemVolume
        if (existing.reason === null && reason !== null) existing.reason = reason
        continue
      }
      merged.set(key, {
        path,
        sources: new Set([candidate.kind]),
        available: real !== null,
        reason,
        volume: candidate.volume,
        systemVolume: candidate.systemVolume
      })
    }
    return [...merged.values()].map((entry) => ({
      path: entry.path,
      sources: [...entry.sources],
      available: entry.available,
      reason: entry.reason,
      volume: entry.volume,
      systemVolume: entry.systemVolume
    }))
  }

  private resolveEditRoots(config: AppConfig, view: EffectiveExploration): string[] {
    const candidates = editCandidates(config, view)
    return this.uniqueAvailable(candidates, config)
  }

  private resolveArtifactRoot(config: AppConfig, view: EffectiveExploration): string | null {
    if (!view.active || !view.artifacts) return null
    const raw = view.artifactRoot
    if (raw === null || raw.trim() === '' || isUncPath(raw)) return null
    const path = resolve(raw)
    if (this.exclusionReason(path, config) !== null) return null
    const resolved = tryRealDir(path)
    return resolved.ok ? resolved.real : null
  }

  private uniqueAvailable(rawRoots: readonly string[], config: AppConfig): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of rawRoots) {
      if (raw.trim() === '' || isUncPath(raw)) continue
      const path = resolve(raw)
      if (this.exclusionReason(path, config) !== null) continue
      const resolved = tryRealDir(path)
      if (!resolved.ok) continue
      const key = normalizedForCompare(resolved.real)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(resolved.real)
    }
    return out
  }

  /** 用户排除项与应用数据目录；只作用于候选根本身，子路径仍由守卫逐层拒绝。 */
  private exclusionReason(path: string, config: AppConfig): string | null {
    if (PROTECTED_ROOT_SEGMENTS.has(basename(path).toLowerCase())) {
      return '受保护的系统/凭据位置'
    }
    if (this.getDeniedRoots().some((root) => root !== '' && isPathInside(root, path))) {
      return '应用数据或系统保护位置'
    }
    for (const pattern of config.worlds.files.exclude) {
      const trimmed = pattern.trim()
      if (trimmed === '') continue
      if (isAbsolute(trimmed)) {
        if (isPathInside(trimmed, path)) return '用户排除项'
        continue
      }
      const segments = path.split(/[\\/]+/).filter((part) => part !== '')
      if (segments.some((part) => wildcardSegment(trimmed).test(part))) {
        return '用户排除项'
      }
    }
    return null
  }
}

function readCandidates(
  config: AppConfig,
  view: EffectiveExploration,
  volumeSnapshot: VolumeScopeView | null,
  mode: VolumeAccessMode
): Candidate[] {
  const out: Candidate[] = []
  const push = (raw: string, kind: FileScopeSourceKind): void => {
    if (raw.trim() !== '') out.push({ raw, kind, volume: false, systemVolume: false })
  }
  // 工作区、笔记、信任目录和文件显式目录是基础授权，不依赖自由探索开关。
  push(config.worlds.workspace.root, 'workspace')
  push(config.worlds.workspace.notesRoot, 'notes')
  for (const root of config.autonomy.trustedRoots) push(root, 'trusted')
  for (const root of config.worlds.files.roots) push(root, 'files')

  if (view.active) {
    for (const root of view.readRoots) push(root, 'exploration')
    if (view.includeProfile) push(homedir(), 'profile')
    if (view.artifacts && view.artifactRoot !== null) push(view.artifactRoot, 'artifact')
    if (explorationVolumeRootsEnabled(view) && volumeScopeAllowsVolumes(mode)) {
      for (const entry of volumeSnapshot?.entries ?? []) {
        if (!entry.readable || entry.exclusion !== null) continue
        if (mode === 'non-system' && entry.system) continue
        for (const mount of entry.mounts) {
          out.push({
            raw: mount,
            kind: 'volume',
            volume: true,
            systemVolume: entry.system
          })
        }
      }
    }
  }
  return out
}

function editCandidates(config: AppConfig, view: EffectiveExploration): string[] {
  const raw = [
    config.worlds.workspace.root,
    config.worlds.workspace.notesRoot,
    ...config.autonomy.trustedRoots,
    ...config.worlds.files.roots
  ]
  if (view.active) {
    raw.push(...view.readRoots)
    if (view.includeProfile) raw.push(homedir())
  }
  return raw
}

function summarizeVolumes(
  snapshot: VolumeScopeView | null,
  mode: VolumeAccessMode,
  modeAuthorized: boolean
): FileScopeView['volumes'] {
  if (snapshot === null) {
    return {
      status: 'pending',
      total: 0,
      readable: 0,
      authorized: 0,
      unavailable: 0,
      system: 0,
      version: 0
    }
  }
  const readableEntries = snapshot.entries.filter(
    (entry) => entry.readable && entry.exclusion === null
  )
  const authorized =
    !modeAuthorized || mode === 'explicit'
      ? 0
      : readableEntries.filter((entry) => mode === 'all' || !entry.system).length
  return {
    status: snapshot.status,
    total: snapshot.summary.total,
    readable: readableEntries.length,
    authorized,
    unavailable: snapshot.summary.unavailable,
    system: snapshot.summary.system,
    version: snapshot.version
  }
}

function tryRealDir(
  path: string
): { ok: true; real: string } | { ok: false; reason: string } {
  try {
    const real = realpathSync.native(path)
    if (!statSync(real).isDirectory()) return { ok: false, reason: '不是目录' }
    return { ok: true, real }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, reason: 'Windows 拒绝访问' }
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, reason: '目录不存在、已卸载或所在卷离线' }
    }
    return { ok: false, reason: '目录当前不可访问' }
  }
}

function wildcardSegment(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function scopeKey(
  config: AppConfig,
  view: EffectiveExploration,
  volumes: VolumeScopeView | null,
  denied: readonly string[]
): string {
  return JSON.stringify([
    config.worlds.workspace.root,
    config.worlds.workspace.notesRoot,
    config.autonomy.trustedRoots,
    config.worlds.files.roots,
    config.worlds.files.exclude,
    config.exploration.enabled,
    config.exploration.scope,
    config.exploration.grantedAt,
    config.exploration.sessionExpiresAt,
    config.exploration.fileRead,
    config.exploration.volumeScope,
    config.exploration.includeProfile,
    config.exploration.artifacts,
    config.exploration.artifactRoot,
    view.active,
    view.readRoots,
    view.artifactRoot,
    volumes?.status,
    volumes?.version,
    volumes?.entries.map((entry) => [
      entry.id,
      entry.mounts,
      entry.system,
      entry.readable,
      entry.partialReadable === true,
      entry.exclusion
    ]),
    denied
  ])
}

function cloneScope(scope: EffectiveFileScope): EffectiveFileScope {
  return {
    ...scope,
    roots: scope.roots.map((root) => ({ ...root, sources: [...root.sources] })),
    readRoots: [...scope.readRoots],
    editRoots: [...scope.editRoots],
    volumes: { ...scope.volumes }
  }
}
