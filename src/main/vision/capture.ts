import { desktopCapturer, screen, type BrowserWindow, type Display } from 'electron'

export interface CaptureDisplay {
  id: string
  /** Electron DIP 坐标（虚拟桌面可能为负）。 */
  x: number
  y: number
  width: number
  height: number
  scaleFactor: number
}

/** 截图用途：被动感知、CUA 操作或旧的手动截图。 */
export type CapturePurpose = 'ambient' | 'cua' | 'manual'

export interface ScreenCapture {
  /** 同一帧只生成一种格式，另一种为 null。 */
  png: Buffer | null
  jpeg: Buffer | null
  /**
   * 采样用的 BGRA 位图（与缩略图同尺寸）。只在调用方内存里用于画质/
   * 结构签名；不落盘、不进日志。
   */
  bitmap: Buffer | null
  displayId: string
  display: CaptureDisplay
  sourceId: string
  targetKind: 'foreground-window' | 'cursor-display' | 'explicit-display'
  purpose: CapturePurpose
  /** 本机目标身份（不透明哈希）；只用于拒绝跨目标结果，不进入日志。 */
  targetKey: string | null
  width: number
  height: number
  capturedAt: number
  /**
   * 传入 cropToTargetWindow 且成功裁剪时，记录裁剪区域在原始缩略图中的位置。
   * 此时 width/height 是裁剪后尺寸。
   */
  cropRegion?: { x: number; y: number; width: number; height: number } | null
}

export interface ScreenBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureOptions {
  /** 桌宠窗口在截图时临时隐藏，避免把角色/气泡/快捷输入截进去。 */
  getPetWindow?: () => BrowserWindow | null
  maxWidth?: number
  format?: 'png' | 'jpeg'
  jpegQuality?: number
  /**
   * 精确指定的显示器（Electron `Display.id` 的字符串形式）。
   * CUA 用它做坐标映射；找不到时直接失败，绝不猜主屏。
   */
  displayId?: string
  /**
   * 前台窗口的屏幕物理像素矩形。自动观察用它跟随用户实际活动的窗口
   * 所在显示器；显式 displayId 优先级更高。
   */
  targetBounds?: ScreenBounds | null
  /**
   * 无法从 targetBounds 确定显示器时直接失败，而不是回退光标屏。
   * 被动屏幕感知必须开启；CUA 使用显式 displayId，不走这条路径。
   */
  requireTarget?: boolean
  /**
   * 只保留前台窗口落在目标显示器内的区域。被动感知要求整屏，因此新调用
   * 不再设置它；保留给旧的手动截图路径。
   */
  cropToTargetWindow?: boolean
  /** 是否生成 BGRA 位图；被动感知签名比较需要，CUA 通常不需要。 */
  includeBitmap?: boolean
  /** 截图用途元数据；被动感知必须为 ambient。 */
  purpose?: CapturePurpose
  /** 本机目标身份（不透明哈希）；只随截图元数据传递。 */
  targetKey?: string | null
}

/**
 * 串行化截图：桌面采集 + 内容保护切换不是并发安全的；同一时刻只允许一帧。
 * 失败的锁不会毒化后续调用。
 */
let captureChain: Promise<unknown> = Promise.resolve()

export function captureScreen(options: CaptureOptions = {}): Promise<ScreenCapture> {
  const run = captureChain.then(
    () => captureOnce(options),
    () => captureOnce(options)
  )
  captureChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function captureOnce(options: CaptureOptions): Promise<ScreenCapture> {
  const resolved = resolveDisplay(options)
  const display = resolved.display
  const format = options.format ?? 'png'
  const maxWidth = Math.max(320, Math.min(2560, options.maxWidth ?? 2200))
  const physicalWidth = Math.max(1, Math.round(display.size.width * display.scaleFactor))
  const physicalHeight = Math.max(1, Math.round(display.size.height * display.scaleFactor))
  // 窗口化游戏只占屏幕一部分；如果仍按整屏 1280 缩略图再裁剪，OCR
  // 可能只剩 640px 宽，汉字会被截断。按目标窗口占比提高整屏缩略图
  // 分辨率，保证裁剪后仍有 maxWidth 的细节；上限 2560，内存仍可控。
  const targetCrop =
    options.cropToTargetWindow === true && options.targetBounds != null
      ? cropRegionForBounds(
          display,
          physicalWidth,
          physicalHeight,
          options.targetBounds
        )
      : null
  const captureWidth = captureThumbnailWidth(
    physicalWidth,
    maxWidth,
    targetCrop?.width ?? null
  )
  const scale = Math.min(1, captureWidth / physicalWidth)
  const thumbnailSize = {
    width: Math.max(320, Math.round(physicalWidth * scale)),
    height: Math.max(200, Math.round(physicalHeight * scale))
  }

  const pet = options.getPetWindow?.() ?? null
  let restore: (() => void) | null = null
  if (pet !== null && !pet.isDestroyed() && pet.isVisible()) {
    try {
      pet.setContentProtection(true)
      restore = () => {
        try {
          pet.setContentProtection(false)
        } catch {
          /* ignore */
        }
      }
    } catch {
      // 极少数显卡/远程桌面组合不支持内容保护；短暂透明是退路。
      try {
        pet.setOpacity(0)
        restore = () => {
          try {
            pet.setOpacity(1)
          } catch {
            /* ignore */
          }
        }
        await delay(80)
      } catch {
        restore = null
      }
    }
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
      fetchWindowIcons: false
    })
    const exact = sources.find((item) => item.display_id === String(display.id)) ?? null
    // 显式指定显示器/跟随前台窗口时绝不回退到另一块屏幕；只有旧的
    // 光标跟随路径保留“拿第一块屏”的兜底。
    const source = exact ?? (resolved.fallbackAllowed ? sources[0] ?? null : null)
    if (source === null) {
      throw new Error(
        resolved.fallbackAllowed ? '没有可用的屏幕采集源' : '找不到目标显示器的采集源'
      )
    }
    const image = source.thumbnail
    if (image.isEmpty()) throw new Error('屏幕采集返回了空图像')
    const imageSize = image.getSize()
    const crop =
      options.cropToTargetWindow === true && options.targetBounds != null
        ? cropRegionForBounds(
            display,
            imageSize.width,
            imageSize.height,
            options.targetBounds
          )
        : null
    let output = image
    let appliedCrop: { x: number; y: number; width: number; height: number } | null = null
    if (crop !== null) {
      try {
        const cropped = image.crop(crop)
        if (!cropped.isEmpty()) {
          output = cropped
          appliedCrop = crop
        }
      } catch {
        // 裁剪失败时退回整屏帧；调用方的来源/有效区域元数据仍表明它是前台窗口。
      }
    }
    const size = output.getSize()
    const quality = Math.max(40, Math.min(95, Math.round(options.jpegQuality ?? 72)))
    return {
      png: format === 'png' ? output.toPNG() : null,
      jpeg: format === 'jpeg' ? output.toJPEG(quality) : null,
      bitmap: options.includeBitmap === true ? output.toBitmap() : null,
      displayId: source.display_id || String(display.id),
      display: {
        id: String(display.id),
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        scaleFactor: display.scaleFactor
      },
      sourceId: source.id,
      targetKind: resolved.kind,
      purpose: options.purpose ?? 'manual',
      targetKey: options.targetKey ?? null,
      width: size.width,
      height: size.height,
      capturedAt: Date.now(),
      cropRegion: appliedCrop
    }
  } finally {
    restore?.()
  }
}

interface ResolvedDisplay {
  display: Display
  kind: ScreenCapture['targetKind']
  /** 只有默认光标路径允许把找不到的源换成第一块屏。 */
  fallbackAllowed: boolean
}

/**
 * 观察目标选择：显式显示器 > 前台窗口所在显示器 > 光标所在显示器（仅旧路径）。
 *
 * 前台窗口 bounds 来自 Windows helper 的屏幕物理像素；先转换为 DIP，再按
 * 相交面积选择显示器（平局取列表顺序靠前者）。无法确定时：`requireTarget`
 * 直接失败，否则退回光标屏。被动感知永远开启 `requireTarget`，绝不悄悄改拍
 * 光标所在地屏幕。
 */
export function resolveDisplay(
  options: Pick<CaptureOptions, 'displayId' | 'targetBounds' | 'requireTarget'>
): ResolvedDisplay {
  if (options.displayId !== undefined && options.displayId !== '') {
    const display = screen.getAllDisplays().find((item) => String(item.id) === options.displayId)
    if (display === undefined) throw new Error('指定的显示器已断开')
    return { display, kind: 'explicit-display', fallbackAllowed: false }
  }
  const bounds = options.targetBounds
  if (bounds !== null && bounds !== undefined && bounds.width > 0 && bounds.height > 0) {
    let dipRect: ScreenBounds
    try {
      dipRect = screen.screenToDipRect(null, {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height)
      })
    } catch {
      if (options.requireTarget === true) throw new Error('无法确定前台窗口所在显示器')
      dipRect = bounds
    }
    const display = pickDisplayForBounds(screen.getAllDisplays(), dipRect, true)
    if (display === null) throw new Error('前台窗口没有落在任何显示器上')
    return { display, kind: 'foreground-window', fallbackAllowed: false }
  }
  if (options.requireTarget === true) throw new Error('无法确定前台窗口所在显示器')
  return {
    display: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
    kind: 'cursor-display',
    fallbackAllowed: true
  }
}

/**
 * 以整屏物理宽度为基准，算出窗口化裁剪时需要的缩略图宽度。
 *
 * 目标窗口占屏幕一半时，整屏缩略图也要放大一倍，裁剪后才不会损失
 * OCR 细节；整屏观察仍使用调用方请求的宽度。上限 2560，避免极小窗口
 * 把采集位图放大到不可控。
 */
export function captureThumbnailWidth(
  physicalWidth: number,
  requestedWidth: number,
  croppedWidthPhysical: number | null
): number {
  const requested = Math.max(320, Math.min(2560, Math.round(requestedWidth)))
  const fullWidth = Math.max(1, Math.round(physicalWidth))
  if (croppedWidthPhysical === null || croppedWidthPhysical <= 0) return requested
  const fraction = Math.min(1, croppedWidthPhysical / fullWidth)
  if (fraction <= 0) return requested
  return Math.min(2560, Math.max(requested, Math.ceil(requested / fraction)))
}

/**
 * 把前台窗口的物理像素矩形换算成采集缩略图里的裁剪区域。
 *
 * 窗口可能跨屏或超出边界；只保留落在该显示器内的部分。坐标先按显示器
 * `scaleFactor` 换成物理像素，再按缩略图缩放比换算。无法形成有效区域时
 * 返回 null，调用方保留整屏帧。
 */
export function cropRegionForBounds(
  display: Pick<Display, 'bounds' | 'scaleFactor'>,
  imageWidth: number,
  imageHeight: number,
  bounds: ScreenBounds
): { x: number; y: number; width: number; height: number } | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null
  const width = Math.max(1, Math.round(imageWidth))
  const height = Math.max(1, Math.round(imageHeight))
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1
  const displayLeft = display.bounds.x * scale
  const displayTop = display.bounds.y * scale
  const displayWidth = Math.max(1, display.bounds.width * scale)
  const displayHeight = Math.max(1, display.bounds.height * scale)
  const left = Math.max(bounds.x, displayLeft)
  const top = Math.max(bounds.y, displayTop)
  const right = Math.min(bounds.x + bounds.width, displayLeft + displayWidth)
  const bottom = Math.min(bounds.y + bounds.height, displayTop + displayHeight)
  if (right <= left || bottom <= top) return null
  const scaleX = width / displayWidth
  const scaleY = height / displayHeight
  const x = Math.max(0, Math.min(width - 1, Math.round((left - displayLeft) * scaleX)))
  const y = Math.max(0, Math.min(height - 1, Math.round((top - displayTop) * scaleY)))
  const cropWidth = Math.max(1, Math.min(width - x, Math.round((right - left) * scaleX)))
  const cropHeight = Math.max(1, Math.min(height - y, Math.round((bottom - top) * scaleY)))
  return { x, y, width: cropWidth, height: cropHeight }
}

/** 纯函数版本，供单元测试验证多显示器选择；坐标均为 DIP。 */
export function pickDisplayForBounds<T extends { id: number | string; bounds: ScreenBounds }>(
  displays: readonly T[],
  bounds: ScreenBounds,
  requireOverlap = false
): T | null {
  if (displays.length === 0) return null
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  }
  let best: T | null = null
  let bestArea = 0
  for (const display of displays) {
    const left = Math.max(bounds.x, display.bounds.x)
    const right = Math.min(bounds.x + bounds.width, display.bounds.x + display.bounds.width)
    const top = Math.max(bounds.y, display.bounds.y)
    const bottom = Math.min(bounds.y + bounds.height, display.bounds.y + display.bounds.height)
    if (right <= left || bottom <= top) continue
    const area = (right - left) * (bottom - top)
    // 平局取列表顺序靠前者：规则固定且可测，不依赖 Map/系统枚举抖动。
    if (area > bestArea) {
      best = display
      bestArea = area
    }
  }
  if (best !== null || requireOverlap) return best
  // 旧的手动截图路径：没有重叠时用中心点距离最近的一块屏。
  let nearest: T | null = null
  let nearestDistance = Infinity
  for (const display of displays) {
    const dx = center.x - (display.bounds.x + display.bounds.width / 2)
    const dy = center.y - (display.bounds.y + display.bounds.height / 2)
    const distance = dx * dx + dy * dy
    if (distance < nearestDistance) {
      nearest = display
      nearestDistance = distance
    }
  }
  return nearest
}

export interface CaptureDisplayInfo {
  id: string
  label: string
  width: number
  height: number
  primary: boolean
}

/** 设置页固定观察目标用；只返回显示器 id/尺寸，不含窗口内容。 */
export function listCaptureDisplays(): CaptureDisplayInfo[] {
  try {
    const primaryId = String(screen.getPrimaryDisplay().id)
    return screen.getAllDisplays().map((display, index) => ({
      id: String(display.id),
      label: `显示器 ${index + 1}（${display.bounds.width}×${display.bounds.height}）${
        String(display.id) === primaryId ? ' · 主屏' : ''
      }`,
      width: display.bounds.width,
      height: display.bounds.height,
      primary: String(display.id) === primaryId
    }))
  } catch {
    return []
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
