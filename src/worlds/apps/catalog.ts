import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { normalizeProcessKey } from '../../shared/processName'

/** 扫描器返回的应用候选；路径只在本地使用，不进入模型上下文或日志。 */
export interface AppScanEntry {
  label: string
  path: string
  args: string[]
  /** 开始菜单快捷方式的创建时间（Unix ms）；用于判断授权后是否新安装。 */
  installedAt?: number
}

/** 应用目录里的一项。`id` 是稳定、不可逆的短标识。 */
export interface AppCatalogEntry {
  id: string
  label: string
  path: string
  args: string[]
  process: string
  source: 'start-menu' | 'system'
  installedAt: number | null
}

/** 同一路径对应同一个 id；不包含用户名或路径原文。 */
export function appIdFor(path: string): string {
  const digest = createHash('sha1').update(path.toLowerCase()).digest('hex')
  return `app-${digest.slice(0, 12)}`
}

export function toCatalogEntry(
  entry: AppScanEntry,
  source: AppCatalogEntry['source']
): AppCatalogEntry | null {
  const process = normalizeProcessKey(entry.path)
  if (process === null) return null
  const label = entry.label.trim().slice(0, 80)
  if (label === '') return null
  return {
    id: appIdFor(entry.path),
    label,
    path: entry.path,
    args: [...entry.args],
    process,
    source,
    installedAt:
      typeof entry.installedAt === 'number' && Number.isFinite(entry.installedAt)
        ? entry.installedAt
        : null
  }
}

/**
 * 按模型给出的名字匹配应用。先精确匹配标签/进程/id，再做包含匹配；
 * 返回多个命中时由调用方把候选交回模型，不能替用户猜。
 */
export function matchApps(
  entries: readonly AppCatalogEntry[],
  query: string,
  limit: number
): AppCatalogEntry[] {
  const needle = query.normalize('NFKC').trim().toLowerCase()
  if (needle === '') return []
  const exact: AppCatalogEntry[] = []
  const partial: AppCatalogEntry[] = []
  for (const entry of entries) {
    const label = entry.label.normalize('NFKC').toLowerCase()
    const process = entry.process.normalize('NFKC').toLowerCase()
    if (label === needle || process === needle || entry.id === needle || basename(entry.path).toLowerCase() === needle) {
      exact.push(entry)
      continue
    }
    if (label.includes(needle) || process.includes(needle)) partial.push(entry)
  }
  return [...exact, ...partial].slice(0, limit)
}

/** 扫描结果去重：同一 exe 只保留第一个（通常是开始菜单里的显示名）。 */
export function dedupeScan(entries: readonly AppScanEntry[]): AppScanEntry[] {
  const out: AppScanEntry[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = entry.path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
    if (out.length >= 400) break
  }
  return out
}
