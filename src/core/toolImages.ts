import type { ToolImage } from './types'

/**
 * 工具图片的共享分组规则。
 *
 * 屏幕截图最多保留 2 张：它们是坐标定位依据，过多只会膨胀上下文。
 * B 站故事板抽帧最多 6 张：抽样画面本身就是评价证据，数量不足以覆盖
 * 视频时才需要按序号查看。两类图片的标签和上限互不挤占。
 */

export const MAX_SCREENSHOT_IMAGES = 2
export const MAX_VIDEO_FRAME_IMAGES = 6

export function toolImageKind(image: ToolImage): 'screenshot' | 'video-frame' {
  return image.kind === 'video-frame' ? 'video-frame' : 'screenshot'
}

/** 按来源分别保留最近 N 张，同时保持工具返回的原始顺序。 */
export function selectToolImages(
  images: readonly ToolImage[],
  caps: { screenshots?: number; frames?: number } = {}
): ToolImage[] {
  const maxScreens = Math.max(0, caps.screenshots ?? MAX_SCREENSHOT_IMAGES)
  const maxFrames = Math.max(0, caps.frames ?? MAX_VIDEO_FRAME_IMAGES)
  const keep = new Set<ToolImage>()
  images
    .filter((image) => toolImageKind(image) === 'screenshot')
    .slice(-maxScreens)
    .forEach((image) => keep.add(image))
  images
    .filter((image) => toolImageKind(image) === 'video-frame')
    .slice(-maxFrames)
    .forEach((image) => keep.add(image))
  return images.filter((image) => keep.has(image))
}

/** 生成给模型的图片说明；序号按各自类别计算，不把封面/抽帧伪装成截图。 */
export function describeToolImages(images: readonly ToolImage[]): string {
  const screenshots = images.filter((image) => toolImageKind(image) === 'screenshot')
  const frames = images.filter((image) => toolImageKind(image) === 'video-frame')
  let screenIndex = 0
  let frameIndex = 0
  return images
    .map((image) => {
      const label = image.label === undefined ? '' : `（${image.label}）`
      const base = `${image.width}×${image.height}`
      if (toolImageKind(image) === 'video-frame') {
        frameIndex += 1
        return `[视频画面 ${frameIndex}/${frames.length}]${label} ${base}；这是抽样画面，不是完整播放。`
      }
      screenIndex += 1
      return `[屏幕截图 ${screenIndex}/${screenshots.length}]${label} ${base}；坐标原点在截图左上角。`
    })
    .join('\n')
}
