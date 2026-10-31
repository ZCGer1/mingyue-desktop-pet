/**
 * 进程名规范化（不依赖 Electron）。
 *
 * 配置、能力约束与窗口端口必须使用同一套键：小写、去路径、去 .exe，
 * 保留中文等 Unicode 名称。无法安全规范化的值返回 null，调用方 fail closed。
 */
export function normalizeProcessKey(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const base = raw
    .normalize('NFKC')
    .trim()
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase()
  if (base === '' || base.length > 120) return null
  if (!/^[\p{L}\p{N} ._-]{1,120}$/u.test(base)) return null
  return base
}
