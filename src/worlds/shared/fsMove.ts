import { cpSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'

/**
 * 同卷 rename；跨卷或权限不允许 rename 时退化为复制后删除。
 *
 * 只负责搬运，不决定源/目标是否在授权范围内，也不负责备份、回收站命名
 * 或撤销记录；这些语义仍由 Files / Workspace 各自保留。
 */
export function movePath(from: string, to: string): void {
  try {
    renameSync(from, to)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') throw error
  }
  const stat = statSync(from)
  if (stat.isDirectory()) {
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
    rmSync(from, { recursive: true, force: true })
  } else {
    cpSync(from, to, { errorOnExist: true, force: false })
    unlinkSync(from)
  }
}
