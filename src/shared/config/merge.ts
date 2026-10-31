import { AppConfig } from './types'
import { defaultConfig } from './defaults'


/**
 * 合并用户配置与默认值。未知键保留（向前兼容），缺省键补默认值。
 * 坏类型一律回退默认值，配置读取层会单独备份损坏文件。
 */
export function mergeConfig(raw: unknown): AppConfig {
  if (raw === null || typeof raw !== 'object') return defaultConfig()
  return deepMerge(defaultConfig(), raw) as AppConfig
}


function deepMerge(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base)) return Array.isArray(patch) ? patch : base
  if (base !== null && typeof base === 'object') {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      // 配置来自渲染进程/磁盘，拒绝原型链相关键，避免 Object prototype pollution。
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      out[key] = key in out ? deepMerge(out[key], value) : value
    }
    return out
  }
  if (typeof base === 'number') return typeof patch === 'number' && Number.isFinite(patch) ? patch : base
  if (typeof base === 'boolean') return typeof patch === 'boolean' ? patch : base
  if (typeof base === 'string') return typeof patch === 'string' ? patch : base
  return patch === undefined ? base : patch
}
