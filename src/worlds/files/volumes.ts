import { constants, existsSync, promises as fsp } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { isPathInside, normalizedForCompare } from '../../shared/path'
import {
  effectiveExploration,
  explorationVolumeRootsEnabled,
  type EffectiveExploration
} from '../../shared/exploration'
import { volumeScopeAllowsVolumes } from '../../shared/fileScope'
import type {
  VolumeAuthorizationSource,
  VolumeEntryView,
  VolumeExclusionReason,
  VolumeKind,
  VolumeScopeView
} from '../../shared/volumeScope'
import type { AppConfig, VolumeAccessMode } from '../../shared/config'
import type { Logger } from '../../core/types'

const execFileAsync = promisify(execFile)

/** 卷清单刷新间隔；新挂载的卷最迟在这个窗口内被发现。 */
const DEFAULT_REFRESH_MS = 60_000
/** 单次枚举超时；失败必须明确报告，不能回退到系统盘。 */
const ENUMERATE_TIMEOUT_MS = 8_000
/** 探测单个挂载点的权限/在线状态；离线网络盘不能拖住其他卷。 */
const PROBE_TIMEOUT_MS = 1_500

const WINDOWS_ENUM_SCRIPT = [
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$rows = New-Object System.Collections.ArrayList',
  '$sysRoot = [System.IO.Path]::GetFullPath($env:SystemRoot)',
  '$logical = Get-CimInstance Win32_LogicalDisk',
  'foreach ($d in $logical) {',
  '  $mount = "$($d.DeviceID)\\";',
  '  [void]$rows.Add([pscustomobject]@{',
  '    id = "ld:$($d.DeviceID):$($d.VolumeSerialNumber)";',
  '    kind = [int]$d.DriveType; label = "$($d.VolumeName)"; fs = "$($d.FileSystem)";',
  '    mounts = @($mount); remote = "$($d.ProviderName)"; health = ""; operational = ""',
  '  })',
  '}',
  '$volumes = Get-CimInstance Win32_Volume',
  'foreach ($v in $volumes) {',
  '  $mounts = @();',
  '  if ($v.DriveLetter) { $mounts += "$($v.DriveLetter)\\" }',
  '  [void]$rows.Add([pscustomobject]@{',
  '    id = "$($v.DeviceID)"; kind = [int]$v.DriveType; label = "$($v.Label)";',
  '    fs = "$($v.FileSystem)"; mounts = @($mounts); remote = "";',
  '    health = ""; operational = ""',
  '  })',
  '}',
  '$mountPoints = Get-CimInstance Win32_MountPoint',
  'foreach ($m in $mountPoints) {',
  '  $dir = [string]$m.Directory; $vol = [string]$m.Volume;',
  '  $mountPath = $null; $volId = $null;',
  '  if ($dir -match \'Name="([^"]+)"\') { $mountPath = $matches[1].Replace(\'\\\\\', \'\\\') }',
  '  if ($vol -match \'DeviceID="([^"]+)"\') { $volId = $matches[1].Replace(\'\\\\\', \'\\\') }',
  '  if ($mountPath -and $volId) {',
  '    [void]$rows.Add([pscustomobject]@{',
  '      id = $volId; kind = 0; label = ""; fs = ""; mounts = @($mountPath);',
  '      remote = ""; health = ""; operational = ""',
  '    })',
  '  }',
  '}',
  '@{ systemRoot = $sysRoot; rows = @($rows) } | ConvertTo-Json -Depth 6 -Compress'
].join('\n')

export interface RawVolumeRow {
  id?: unknown
  kind?: unknown
  label?: unknown
  fs?: unknown
  mounts?: unknown
  remote?: unknown
  health?: unknown
  operational?: unknown
}

export interface RawVolumeListing {
  systemRoot: string
  rows: RawVolumeRow[]
}

/** 探测结果；测试可以注入，避免真的访问磁盘。 */
export interface VolumeProbe {
  (mount: string): Promise<{ available: boolean; readable: boolean }>
}

export interface VolumeScopeOptions {
  getConfig?: () => AppConfig
  logger?: Logger | null
  now?: () => number
  /** 测试注入；生产环境使用 Windows CIM 枚举。 */
  enumerate?: () => Promise<RawVolumeListing>
  probe?: VolumeProbe
  /** 可覆盖系统目录，用于验证“系统盘不是 C”。 */
  systemRoot?: string
  refreshMs?: number
}

/**
 * 主进程唯一的卷清单与有效读取范围服务。
 *
 * - 系统卷通过实际系统目录（SystemRoot）与卷挂载点包含关系识别，不写死 C。
 * - 枚举只提供事实：卷身份、挂载点、可用性与当前账户是否可读。系统盘不再
 *   被硬编码成不可读；是否自动纳入由自由探索的 volumeScope 模式决定。
 * - 枚举失败返回 failed，绝不回退到系统盘冒充“已发现范围”。
 * - 盘符只是挂载路径；稳定身份优先使用卷 GUID / 网络共享 UNC。
 * - 离线卷不阻塞其他卷；卷根不可读也不能清空显式工作区（由上层解析器合并）。
 */
export class VolumeScope {
  private readonly getConfig: (() => AppConfig) | null
  private readonly logger: Logger | null
  private readonly now: () => number
  private readonly enumerate: () => Promise<RawVolumeListing>
  private readonly probe: VolumeProbe
  private readonly configuredSystemRoot: string | null
  private readonly refreshMs: number

  private snapshot: VolumeScopeView
  private lastRefreshAt = 0
  private inFlight: Promise<VolumeScopeView> | null = null

  constructor(options: VolumeScopeOptions = {}) {
    this.getConfig = options.getConfig ?? null
    this.logger = options.logger ?? null
    this.now = options.now ?? (() => Date.now())
    this.enumerate = options.enumerate ?? enumerateWindowsVolumes
    this.probe = options.probe ?? probeMount
    this.configuredSystemRoot = options.systemRoot ?? null
    this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS
    this.snapshot = {
      platform: process.platform,
      systemRoot: this.initialSystemRoot(),
      status: 'pending',
      enumeratedAt: 0,
      version: 0,
      error: null,
      entries: [],
      summary: { total: 0, readable: 0, system: 0, unavailable: 0 }
    }
  }

  current(): VolumeScopeView {
    this.maybeRefresh()
    return cloneView(this.snapshot)
  }

  /** 供 FilesGuard 同步读取；过期时在后台刷新，不阻塞当前路径检查。 */
  refreshInBackground(): void {
    this.maybeRefresh()
  }

  async refresh(force = false): Promise<VolumeScopeView> {
    if (!force && this.snapshot.status === 'ok' && this.now() - this.lastRefreshAt < this.refreshMs) {
      return this.current()
    }
    if (this.inFlight !== null) return this.inFlight
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /**
   * 当前模式可自动纳入的挂载根。模式决定授权；`readable`/`exclusion`
   * 只描述事实。`all` 包括系统盘普通目录，`non-system` 排除系统卷，
   * `explicit` 不自动纳入任何卷根。
   */
  rootsForMode(mode: VolumeAccessMode): string[] {
    this.maybeRefresh()
    if (!volumeScopeAllowsVolumes(mode)) return []
    return uniqueRoots(
      this.snapshot.entries
        .filter(
          (entry) =>
            entry.exclusion === null &&
            entry.readable &&
            (mode === 'all' || !entry.system)
        )
        .flatMap((entry) => entry.mounts)
    )
  }

  /** 兼容旧的“全部非系统盘”调用；新代码应显式传入 volumeScope 模式。 */
  readableRoots(): string[] {
    return this.rootsForMode('non-system')
  }

  /** 固定卷枚举只取非系统本地卷；网络/可移动/光盘不自动纳入范围。 */
  fixedRoots(): string[] {
    this.maybeRefresh()
    return uniqueRoots(
      this.snapshot.entries
        .filter(
          (entry) =>
            !entry.system &&
            entry.kind === 'fixed' &&
            entry.exclusion === null &&
            entry.readable
        )
        .flatMap((entry) => entry.mounts)
    )
  }

  /**
   * 已挂载网络卷的 UNC 路径映射到实际盘符/挂载点。
   * 只有卷清单里已挂载且可读的共享才允许；任意陌生 UNC 返回 null。
   */
  mapAuthorizedUnc(input: string): string | null {
    this.maybeRefresh()
    const raw = input.trim()
    if (!/^\\\\[^\\/]+[\\/][^\\/]+/.test(raw)) return null
    if (!this.volumeModeEnabled()) return null
    for (const entry of this.snapshot.entries) {
      if (entry.system || entry.kind !== 'network' || entry.exclusion !== null) continue
      if (entry.remote === null || entry.mounts.length === 0) continue
      if (!isPathInside(entry.remote, raw)) continue
      const rest = relative(entry.remote, raw)
      const mount = entry.mounts[0]
      if (mount === undefined) continue
      return rest === '' ? mount : join(mount, rest)
    }
    return null
  }

  /** 目标是否落在系统卷上；用于诊断与链接排除，不代替根目录白名单。 */
  isSystemVolumePath(target: string): boolean {
    const nonSystem = this.snapshot.entries.filter((entry) => !entry.system)
    for (const entry of nonSystem) {
      if (entry.mounts.some((mount) => isPathInside(mount, target))) return false
    }
    for (const entry of this.snapshot.entries) {
      if (!entry.system) continue
      if (entry.mounts.some((mount) => isPathInside(mount, target))) return true
    }
    return isPathInside(this.snapshot.systemRoot, target)
  }

  view(): VolumeScopeView {
    return this.current()
  }

  private initialSystemRoot(): string {
    if (this.configuredSystemRoot !== null) return resolve(this.configuredSystemRoot)
    return resolve(
      process.env['SystemRoot'] ?? process.env['WINDIR'] ?? (process.platform === 'win32' ? 'C:\\Windows' : '/')
    )
  }

  /**
   * 授权来源只描述“为什么这个卷在范围描述里”，不代替执行时的范围复验。
   * 磁盘模式先看：`all` 可授权包括系统卷在内的可读卷，`non-system` 只授权
   * 非系统卷。没有模式授权时，再看作品目录与显式读取根。系统卷身份不会再
   * 单独造成排除。
   */
  private authorizationSourceFor(
    entry: VolumeEntryView,
    view: EffectiveExploration
  ): VolumeAuthorizationSource | null {
    const mode = view.volumeScope
    if (explorationVolumeRootsEnabled(view) && volumeScopeAllowsVolumes(mode)) {
      if (entry.readable && entry.exclusion === null && (mode === 'all' || !entry.system)) {
        return mode === 'all' ? 'all-volumes' : 'non-system-volume'
      }
    }
    if (this.getConfig === null) return null
    let config: AppConfig
    try {
      config = this.getConfig()
    } catch {
      return null
    }
    const onVolume = (root: string | null | undefined): boolean => {
      if (root === null || root === undefined) return false
      const trimmed = root.trim()
      if (trimmed === '' || !isAbsolute(trimmed)) return false
      return entry.mounts.some((mount) => isPathInside(mount, trimmed))
    }
    if (view.active && view.artifactRoot !== null && onVolume(view.artifactRoot)) {
      return 'artifact-root'
    }
    const explicit: string[] = [
      config.worlds.workspace.root,
      config.worlds.workspace.notesRoot,
      ...config.autonomy.trustedRoots,
      ...config.worlds.files.roots
    ]
    if (view.active) {
      explicit.push(...view.readRoots)
      if (view.includeProfile) explicit.push(homedir())
    }
    return explicit.some(onVolume) ? 'explicit-read-root' : null
  }

  private volumeModeEnabled(): boolean {
    if (this.getConfig === null) return false
    try {
      return explorationVolumeRootsEnabled(
        effectiveExploration(this.getConfig(), this.now())
      )
    } catch {
      return false
    }
  }

  private maybeRefresh(): void {
    if (this.inFlight !== null) return
    if (this.now() - this.lastRefreshAt < this.refreshMs) return
    void this.refresh(true).catch((error) => {
      this.logger?.warn('卷清单刷新失败', { error: String(error).slice(0, 200) })
    })
  }

  private async doRefresh(): Promise<VolumeScopeView> {
    this.lastRefreshAt = this.now()
    try {
      const listing = await this.enumerate()
      const systemRoot = resolve(listing.systemRoot || this.initialSystemRoot())
      const built = buildVolumeSnapshot(listing.rows, systemRoot, this.now())
      const exploration = this.getConfig === null
        ? null
        : effectiveExploration(this.getConfig(), this.now())
      const entries = await Promise.all(
        built.entries.map(async (entry) => {
          const withAuth = (value: VolumeEntryView): VolumeEntryView => ({
            ...value,
            // 授权来源只用于展示；执行范围由 FileScopeResolver 再次按模式
            // 与实际可读性筛选，不会因为这里标了来源就放行。
            authorizationSource:
              exploration === null ? null : this.authorizationSourceFor(value, exploration)
          })
          if (entry.mounts.length === 0) {
            return withAuth({
              ...entry,
              available: false,
              readable: false,
              exclusion: 'no-mount' as VolumeExclusionReason
            })
          }
          if (!entry.available) {
            return withAuth({
              ...entry,
              readable: false,
              exclusion: 'offline' as VolumeExclusionReason
            })
          }
          const probes = await Promise.all(
            entry.mounts.map(async (mount) => {
              try {
                return await withTimeout(this.probe(mount), PROBE_TIMEOUT_MS)
              } catch {
                return { available: false, readable: false }
              }
            })
          )
          const available = probes.some((probe) => probe.available)
          const readableCount = probes.filter((probe) => probe.readable).length
          const readable = readableCount > 0
          return withAuth({
            ...entry,
            available,
            readable,
            partialReadable: readableCount > 0 && readableCount < probes.length,
            exclusion: !available
              ? ('offline' as VolumeExclusionReason)
              : !readable
                ? ('no-permission' as VolumeExclusionReason)
                : null
          })
        })
      )
      this.snapshot = {
        platform: process.platform,
        systemRoot,
        status: 'ok',
        enumeratedAt: this.now(),
        version: this.snapshot.version + 1,
        error: null,
        entries,
        summary: summarize(entries)
      }
      return cloneView(this.snapshot)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.snapshot = {
        platform: process.platform,
        systemRoot: this.initialSystemRoot(),
        status: process.platform === 'win32' ? 'failed' : 'unsupported',
        enumeratedAt: this.now(),
        version: this.snapshot.version + 1,
        error: `卷枚举失败：${message.slice(0, 200)}`,
        entries: [],
        summary: { total: 0, readable: 0, system: 0, unavailable: 0 }
      }
      // 明确故障，不回退到系统盘。调用方必须把它当成“当前没有发现范围”。
      this.logger?.warn('卷枚举失败，不回退系统盘', { error: message.slice(0, 200) })
      return cloneView(this.snapshot)
    }
  }
}

/** 与配置/授权无关的纯函数：把 CIM 行合并成稳定卷条目。 */
export function buildVolumeSnapshot(
  rows: readonly RawVolumeRow[],
  systemRoot: string,
  now = Date.now()
): VolumeScopeView {
  const resolvedRoot = resolve(systemRoot)
  const drafts: DraftVolume[] = []
  for (const row of rows) {
    const draft = rowToDraft(row, resolvedRoot)
    if (draft === null) continue
    const existing = drafts.find(
      (entry) => entry.id === draft.id || sharesMount(entry, draft)
    )
    if (existing === undefined) {
      drafts.push(draft)
    } else {
      mergeDraft(existing, draft)
    }
  }
  // 合并后可能产生新的相同挂载点；反复收敛（卷数量很小）。
  let changed = true
  while (changed) {
    changed = false
    for (let index = 0; index < drafts.length; index += 1) {
      for (let other = index + 1; other < drafts.length; other += 1) {
        const left = drafts[index]!
        const right = drafts[other]!
        if (left.id !== right.id && !sharesMount(left, right)) continue
        mergeDraft(left, right)
        drafts.splice(other, 1)
        changed = true
        break
      }
      if (changed) break
    }
  }

  const entries: VolumeEntryView[] = drafts.map((draft) => {
    const system = draft.mounts.some((mount) => isPathInside(mount, resolvedRoot))
    const mounts = uniqueRoots(draft.mounts)
    const available = draft.available && mounts.length > 0
    return {
      id: draft.id,
      kind: draft.kind,
      label: draft.label,
      fileSystem: draft.fileSystem,
      mounts,
      remote: draft.remote,
      system,
      available,
      // 枚举阶段只描述卷本身；readable 由真实探测补上，授权来源由配置模式补上。
      readable: false,
      exclusion: mounts.length === 0 ? 'no-mount' : available ? null : 'offline',
      authorizationSource: null
    }
  })

  return {
    platform: process.platform,
    systemRoot: resolvedRoot,
    status: 'ok',
    enumeratedAt: now,
    version: 0,
    error: null,
    entries,
    summary: summarize(entries)
  }
}

interface DraftVolume {
  id: string
  kind: VolumeKind
  label: string
  fileSystem: string
  mounts: string[]
  remote: string | null
  available: boolean
}

function rowToDraft(row: RawVolumeRow, systemRoot: string): DraftVolume | null {
  const kind = kindOf(row.kind)
  const mounts = mountsOf(row.mounts)
  const remote = remoteOf(row.remote)
  if (mounts.length === 0 && remote === null && kind === 'network') return null
  const health = typeof row.operational === 'string' ? row.operational.trim().toLowerCase() : ''
  const healthy = health === '' || health === 'ok' || health === 'online'
  const id = identityOf(row.id, mounts, kind, remote)
  return {
    id,
    kind,
    label: stringOf(row.label),
    fileSystem: stringOf(row.fs),
    mounts,
    remote,
    available: healthy
  }
}

function identityOf(
  rawId: unknown,
  mounts: readonly string[],
  kind: VolumeKind,
  remote: string | null
): string {
  const id = stringOf(rawId)
  if (/^\\\\\?\\volume\{/i.test(id)) return id.toLowerCase()
  if (kind === 'network' && remote !== null) return `network:${remote.toLowerCase()}`
  if (id !== '') return id.toLowerCase()
  return `${kind}:${mounts[0] ?? 'no-mount'}`.toLowerCase()
}

function kindOf(value: unknown): VolumeKind {
  if (typeof value === 'number' && Number.isFinite(value)) {
    switch (value) {
      case 2:
        return 'removable'
      case 3:
        return 'fixed'
      case 4:
        return 'network'
      case 5:
        return 'optical'
      default:
        return 'unknown'
    }
  }
  const text = stringOf(value).toLowerCase()
  if (text.includes('fixed')) return 'fixed'
  if (text.includes('removable') || text.includes('removable media')) return 'removable'
  if (text.includes('network')) return 'network'
  if (text.includes('cd') || text.includes('dvd') || text.includes('optical')) return 'optical'
  return 'unknown'
}

function mountsOf(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const out: string[] = []
  for (const item of values) {
    if (typeof item !== 'string') continue
    let mount = item.trim()
    if (mount === '') continue
    if (/^[A-Za-z]:$/.test(mount)) mount += '\\'
    if (!isAbsolute(mount)) continue
    if (!/^[A-Za-z]:[\\/]/.test(mount) && !mount.startsWith('\\\\')) continue
    try {
      mount = resolve(mount)
    } catch {
      continue
    }
    out.push(mount)
  }
  return uniqueRoots(out)
}

function remoteOf(value: unknown): string | null {
  const raw = stringOf(value).trim()
  if (raw === '' || !/^\\\\/.test(raw)) return null
  return raw.replace(/[\\/]+$/, '')
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function sharesMount(left: DraftVolume, right: DraftVolume): boolean {
  return left.mounts.some((mount) =>
    right.mounts.some(
      (other) => normalizedForCompare(mount) === normalizedForCompare(other)
    )
  )
}

function mergeDraft(target: DraftVolume, source: DraftVolume): void {
  // 卷 GUID 比盘符派生 id 更稳定，优先保留。
  if (isGuidId(source.id) && !isGuidId(target.id)) target.id = source.id
  if (target.label === '') target.label = source.label
  if (target.fileSystem === '') target.fileSystem = source.fileSystem
  if (target.remote === null) target.remote = source.remote
  if (target.kind === 'unknown') target.kind = source.kind
  target.available = target.available && source.available
  target.mounts = uniqueRoots([...target.mounts, ...source.mounts])
}

function isGuidId(id: string): boolean {
  return /^\\\\\?\\volume\{/i.test(id)
}

function uniqueRoots(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed === '') continue
    const key = normalizedForCompare(trimmed)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

function summarize(entries: readonly VolumeEntryView[]): VolumeScopeView['summary'] {
  return {
    total: entries.length,
    readable: entries.filter((entry) => entry.exclusion === null && entry.readable).length,
    system: entries.filter((entry) => entry.system).length,
    unavailable: entries.filter((entry) => entry.exclusion !== null).length
  }
}

function cloneView(view: VolumeScopeView): VolumeScopeView {
  return {
    ...view,
    entries: view.entries.map((entry) => ({
      ...entry,
      mounts: [...entry.mounts]
    })),
    summary: { ...view.summary }
  }
}

async function enumerateWindowsVolumes(): Promise<RawVolumeListing> {
  if (process.platform !== 'win32') {
    throw new Error('当前平台没有 Windows 卷拓扑')
  }
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ENUM_SCRIPT],
    {
      timeout: ENUMERATE_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 512 * 1024
    }
  )
  const parsed: unknown = JSON.parse(stdout.trim() === '' ? '{}' : stdout.trim())
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('卷枚举返回了无效结构')
  }
  const record = parsed as { systemRoot?: unknown; rows?: unknown }
  const rows = Array.isArray(record.rows)
    ? record.rows.filter(
        (row): row is RawVolumeRow => row !== null && typeof row === 'object'
      )
    : []
  const systemRoot =
    typeof record.systemRoot === 'string' && record.systemRoot.trim() !== ''
      ? record.systemRoot
      : (process.env['SystemRoot'] ?? 'C:\\Windows')
  return { systemRoot, rows }
}

async function probeMount(
  mount: string
): Promise<{ available: boolean; readable: boolean }> {
  try {
    // 异步 access 既验证挂载点存在，也走当前账户的 Windows ACL；不改 ACL、
    // 不提权。异步调用允许上层超时，离线网络盘不会卡住主进程。
    await fsp.access(mount, constants.R_OK)
    if (!(await fsp.stat(mount)).isDirectory()) return { available: false, readable: false }
    return { available: true, readable: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (code === 'EACCES' || code === 'EPERM') {
      return { available: existsSync(mount), readable: false }
    }
    return { available: false, readable: false }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('probe-timeout')), ms)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* 供 FilesGuard / CapabilityStore 的窄接口                             */
/* ------------------------------------------------------------------ */

export interface VolumeReader {
  current(): VolumeScopeView
  refreshInBackground(): void
  /** 当前模式授权且实际可读的卷根；模式由调用方传入，避免重复解释开关。 */
  rootsForMode(mode: VolumeAccessMode): string[]
  readableRoots(): string[]
  fixedRoots(): string[]
  mapAuthorizedUnc(input: string): string | null
  isSystemVolumePath(target: string): boolean
}
