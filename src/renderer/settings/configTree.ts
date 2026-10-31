import type { AppConfig } from '../../shared/config'

/** 配置路径；每个元素是对象键。数组字段整体作为一个叶子。 */
export type ConfigPath = readonly string[]

/** 读取一个配置路径上的值；路径不存在时返回 undefined。 */
export function readPath(config: AppConfig, path: ConfigPath): unknown {
  let node: unknown = config
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** 深拷贝一份配置并把路径写入新副本；原对象不被修改。 */
export function applyPath(
  base: AppConfig,
  path: ConfigPath,
  value: unknown
): AppConfig {
  if (path.length === 0) return base
  const clone = structuredClone(base) as unknown
  let node = clone as Record<string, unknown>
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    if (key === undefined) return base
    const next = node[key]
    if (next === null || typeof next !== 'object') return base
    node = next as Record<string, unknown>
  }
  const last = path[path.length - 1]
  if (last === undefined) return base
  node[last] = value === undefined ? undefined : structuredClone(value)
  return clone as AppConfig
}

/**
 * 只把 source 中 paths 列出的字段写进 base，返回新配置。
 *
 * 分步保存用它构造请求：请求 = 最新已保存配置 + 当前步骤拥有的字段，
 * 其他页面/步骤的草稿不会被夹带提交。
 */
export function applyPaths(
  base: AppConfig,
  source: AppConfig,
  paths: readonly ConfigPath[]
): AppConfig {
  let out = base
  for (const path of paths) {
    out = applyPath(out, path, readPath(source, path))
  }
  return out
}

/** 比较两条路径上的值是否一致；用于未保存标记与步骤状态。 */
export function sameValueOnPaths(
  left: AppConfig,
  right: AppConfig,
  paths: readonly ConfigPath[]
): boolean {
  return paths.every(
    (path) => JSON.stringify(readPath(left, path)) === JSON.stringify(readPath(right, path))
  )
}

/** 在当前草稿里改一个值。 */
export function setPath(config: AppConfig, path: ConfigPath, value: unknown): AppConfig {
  return applyPath(config, path, value)
}
