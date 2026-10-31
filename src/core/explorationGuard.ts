import { isAbsolute } from 'node:path'
import type { CapabilityId } from './capabilityTypes'
import { isPathInside } from '../shared/path'
import type { EffectiveExploration } from '../shared/exploration'
import { volumeScopeAllowsVolumes } from '../shared/fileScope'

/**
 * 「自由探索」的路径范围复验。
 *
 * 目标必须是调用方已经 realpath 过的绝对路径；这里不做符号链接解析，
 * 也不读取文件内容。目录不存在、相对路径或目标缺失一律 fail closed。
 * 敏感目录（.ssh、凭据、应用数据等）仍由 FilesGuard / 各 World 拒绝，
 * 这一层只回答“是否落在用户授权的读取/作品范围内”。
 */
export interface ExplorationPathInput {
  capability: CapabilityId
  action: string
  targetPaths: readonly string[] | undefined
  view: EffectiveExploration
  profileRoot: string | null
  /**
   * 当前模式授权且实际可读的卷挂载根，来自主进程唯一的卷快照。
   * 只有 `fileRead && volumeScope !== 'explicit'` 时才参与读取范围。
   */
  volumeRoots?: readonly string[]
  /**
   * 主进程 FileScopeResolver 的统一读取根。传入时直接以它为准，
   * 不再在这里重新拼接工作区/笔记/信任目录/卷，避免执行路径各算一套。
   */
  readRoots?: readonly string[]
  /**
   * 明确允许连续编辑的根。缺省时退回 `view.readRoots`（旧语义），
   * 但绝不会包含因磁盘模式而新增的卷根或个人目录。
   */
  editRoots?: readonly string[]
}

export function explorationReadRoots(
  view: Pick<
    EffectiveExploration,
    'readRoots' | 'artifactRoot' | 'includeProfile' | 'fileRead' | 'volumeScope'
  >,
  profileRoot: string | null,
  volumeRoots: readonly string[] = []
): string[] {
  const roots = [...view.readRoots]
  if (view.includeProfile && profileRoot !== null && profileRoot.trim() !== '') {
    roots.push(profileRoot)
  }
  if (view.fileRead && volumeScopeAllowsVolumes(view.volumeScope)) {
    roots.push(...volumeRoots)
  }
  if (view.artifactRoot !== null) roots.push(view.artifactRoot)
  return uniqueValidRoots(roots)
}

export function isInsideArtifactRoot(
  view: Pick<EffectiveExploration, 'artifactRoot'>,
  target: string
): boolean {
  if (view.artifactRoot === null) return false
  if (!isAbsolute(target)) return false
  return isPathInside(view.artifactRoot, target)
}

export interface ExplorationPathDenial {
  code: 'target-resolution-missing' | 'path-outside-scope' | 'grant-expired'
  message: string
}

export function explorationPathDenial(
  input: ExplorationPathInput
): ExplorationPathDenial | null {
  const { capability, action, view } = input
  // sys_open_path 用系统默认程序打开文件/文件夹，也会把内容暴露给用户和模型
  // 之后的观察；自主来源必须和文件读取一样复验路径边界，不能因为能力归类为
  // app.launch 就跳过范围检查。
  const isOpenPath = capability === 'app.launch' && action === 'sys_open_path'
  const isRead = capability === 'file.read' || isOpenPath
  const isArtifactWrite =
    capability === 'file.write' ||
    capability === 'workspace.write' ||
    (capability === 'browser.control' && action === 'browser_download')

  if (!isRead && !isArtifactWrite) return null
  const unifiedReadRoots =
    input.readRoots === undefined ? null : uniqueValidRoots(input.readRoots)
  if (isRead) {
    if (!view.active) {
      return {
        code: 'grant-expired',
        message: isOpenPath
          ? '自主打开文件/文件夹需要有效的自由探索授权，已拒绝。'
          : '文件读取的自由探索授权已关闭或到期，已拒绝。'
      }
    }
    // 统一根集合已经编码了工作区/信任目录等基础授权；空集合就是没有范围。
    // 旧调用方未传 readRoots 时，仍按旧的子开关判断。
    if (unifiedReadRoots === null && !view.fileRead && !view.artifacts && !view.edits) {
      return {
        code: 'grant-expired',
        message: isOpenPath
          ? '自主打开文件/文件夹需要文件读取范围；当前自由探索授权未包含，已拒绝。'
          : '文件读取的自由探索授权已关闭，已拒绝。'
      }
    }
    if (unifiedReadRoots !== null && unifiedReadRoots.length === 0) {
      return {
        code: 'path-outside-scope',
        message: '当前没有可访问的文件读取范围，已拒绝。'
      }
    }
  }
  if (isArtifactWrite && !view.artifacts && !view.edits) {
    return { code: 'grant-expired', message: '作品写入的自由探索授权已关闭，已拒绝。' }
  }

  const targets = input.targetPaths
  if (targets === undefined || targets.length === 0) {
    return {
      code: 'target-resolution-missing',
      message: '本次动作没有可验证的目标路径，已拒绝。'
    }
  }
  const readRoots =
    unifiedReadRoots ??
    explorationReadRoots(view, input.profileRoot, input.volumeRoots ?? [])
  // 读取范围与编辑范围解耦：新增的非系统卷/个人目录只扩大读取，
  // 写入仍只落在用户此前明确的编辑根或她自己的作品目录。
  const editRoots =
    input.editRoots !== undefined
      ? uniqueValidRoots(input.editRoots)
      : uniqueValidRoots([
          ...view.readRoots,
          ...(view.includeProfile && input.profileRoot !== null ? [input.profileRoot] : [])
        ])
  for (const target of targets) {
    if (typeof target !== 'string' || target.trim() === '' || !isAbsolute(target)) {
      return {
        code: 'target-resolution-missing',
        message: '本次动作的目标路径不是有效的绝对路径，已拒绝。'
      }
    }
    if (isRead) {
      const inArtifact = view.artifacts && isInsideArtifactRoot(view, target)
      const inRead =
        (unifiedReadRoots !== null || view.fileRead) &&
        readRoots.some((root) => isPathInside(root, target))
      const inEditable = view.edits && editRoots.some((root) => isPathInside(root, target))
      if (inArtifact || inRead || inEditable) continue
      return { code: 'path-outside-scope', message: '目标不在用户授权的读取目录内，已拒绝。' }
    }

    // 作品写入：只允许她的作品目录；用户原始文件只有在显式开启 edits 且
    // 位于明确编辑目录内时才可连续修改。
    const inArtifact = view.artifacts && isInsideArtifactRoot(view, target)
    const inEditable =
      view.edits && editRoots.some((root) => isPathInside(root, target))
    if (inArtifact || inEditable) continue
    return {
      code: 'path-outside-scope',
      message: view.artifacts
        ? '目标不在她的作品目录内，且没有该目录的编辑授权，已拒绝。'
        : '作品写入的自由探索授权已关闭，已拒绝。'
    }
  }
  return null
}

/** 兼容旧调用方：只需要可读文案时使用。 */
export function explorationPathError(input: ExplorationPathInput): string | null {
  return explorationPathDenial(input)?.message ?? null
}

function uniqueValidRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of roots) {
    const value = raw.trim()
    if (value === '' || !isAbsolute(value)) continue
    const key = process.platform === 'win32' ? value.toLowerCase() : value
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}
