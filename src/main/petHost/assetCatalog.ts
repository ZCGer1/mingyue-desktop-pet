import { realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { DSH_PET_ANIMATION_ID_SET } from '../../shared/dshPet/catalog.generated'

/**
 * 桌宠动画素材目录（vendor/dsh-pet/assets/webm）。
 *
 * 唯一可请求的名字来自生成的目录 `catalog.generated.ts`；任何路径片段、
 * 百分号编码、大小写变体都必须先精确命中这个集合，之后才做文件系统校验。
 * 这里返回的是真实路径，供宿主做受控流式读取。
 */

const EXTENSION = '.webm'

export interface ResolvedAnimationAsset {
  file: string
  size: number
  mtimeMs: number
}

export class DshPetAssetCatalog {
  readonly root: string
  private readonly realRoot: string | null

  constructor(root: string) {
    this.root = root
    try {
      this.realRoot = realpathSync(root)
    } catch {
      this.realRoot = null
    }
  }

  get available(): boolean {
    return this.realRoot !== null
  }

  /** 目录里是否有该动画；未知 id 一律 null，不尝试拼路径。 */
  resolve(animationId: string): ResolvedAnimationAsset | null {
    if (!DSH_PET_ANIMATION_ID_SET.has(animationId)) return null
    const root = this.realRoot
    if (root === null) return null
    const file = join(root, `${animationId}${EXTENSION}`)
    try {
      const real = realpathSync(file)
      if (!real.startsWith(root + sep)) return null
      const stat = statSync(real)
      if (!stat.isFile()) return null
      return { file: real, size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return null
    }
  }
}
