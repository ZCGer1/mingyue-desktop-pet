import { parse, resolve, sep } from 'node:path'

/** 比较路径时统一绝对化、去掉末尾分隔符，Windows 下忽略大小写。 */
export function normalizedForCompare(input: string): string {
  let out = resolve(input)
  if (out.length > parse(out).root.length) out = out.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? out.toLowerCase() : out
}

/** parent 等于 child 或 child 位于 parent 之内。两边都按规范化后的绝对路径比较。 */
export function isPathInside(parent: string, child: string): boolean {
  const base = normalizedForCompare(parent)
  const target = normalizedForCompare(child)
  if (base === target) return true
  const withSep = base.endsWith(sep) ? base : base + sep
  return target.startsWith(withSep)
}
