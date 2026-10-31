import { nativeImage, screen, type BrowserWindow, type Display } from 'electron'
import type { Logger } from '../../core/types'
import type {
  CuaCapture,
  CuaCaptureOptions,
  CuaForeground,
  CuaInputOp,
  CuaPort,
  CuaTakeoverKind,
  CuaView,
  CuaZoomOptions
} from '../../worlds/cua/port'
import { captureScreen } from '../vision/capture'
import { CuaInputClient } from './inputClient'

export interface ElectronCuaPortOptions {
  getPetWindow: () => BrowserWindow | null
  logger: Logger
  /** `resources/cua/input.ps1` 的绝对路径。 */
  inputScriptPath: string
  inputClient?: CuaInputClient
  now?: () => number
}

interface StoredCapture {
  buffer: Buffer
  view: CuaView
}

const MAX_WIDTH = 2560
const MIN_QUALITY = 40
const MAX_QUALITY = 95

/**
 * 主进程 CUA 端口：Electron 截图 + 常驻输入助手。
 *
 * 约束：
 *  - 截图只保存在本对象内存中（最近一张），不写临时文件；`stop()` 立即清空；
 *  - 坐标从全局 DIP 转成物理像素后再交给 helper；
 *  - 不聚焦或强制切换前台窗口；切换应用只能靠用户点击或 Alt+Tab。
 */
export class ElectronCuaPort implements CuaPort {
  private readonly options: ElectronCuaPortOptions
  private readonly logger: Logger
  private readonly client: CuaInputClient
  private readonly now: () => number
  private last: StoredCapture | null = null

  constructor(options: ElectronCuaPortOptions) {
    this.options = options
    this.logger = options.logger
    this.now = options.now ?? Date.now
    this.client =
      options.inputClient ??
      new CuaInputClient({
        scriptPath: options.inputScriptPath,
        logger: options.logger
      })
  }

  async capture(options: CuaCaptureOptions): Promise<CuaCapture> {
    const display = this.resolveDisplay(options)
    const maxWidth = Math.max(640, Math.min(MAX_WIDTH, Math.round(options.maxWidth)))
    const quality = Math.max(MIN_QUALITY, Math.min(MAX_QUALITY, Math.round(options.quality)))
    const shot = await captureScreen({
      displayId: String(display.id),
      maxWidth,
      format: 'jpeg',
      jpegQuality: quality,
      getPetWindow: this.options.getPetWindow,
      // 与被动感知共用采集器，但用途和本机目标身份必须分开记录。
      purpose: 'cua',
      targetKey: `cua:display:${String(display.id)}`
    })
    if (shot.jpeg === null) throw new Error('截图未返回 JPEG')
    const view: CuaView = {
      displayId: shot.display.id,
      imageWidth: shot.width,
      imageHeight: shot.height,
      dipX: shot.display.x,
      dipY: shot.display.y,
      dipWidth: shot.display.width,
      dipHeight: shot.display.height,
      scaleFactor: shot.display.scaleFactor
    }
    this.last = { buffer: shot.jpeg, view }
    return {
      base64: shot.jpeg.toString('base64'),
      view,
      capturedAt: shot.capturedAt
    }
  }

  async zoom(options: CuaZoomOptions): Promise<CuaCapture | null> {
    const source = this.last
    if (source === null) return null
    const image = nativeImage.createFromBuffer(source.buffer)
    if (image.isEmpty()) return null
    const sourceSize = image.getSize()
    const x = Math.max(0, Math.min(sourceSize.width - 1, Math.round(options.x)))
    const y = Math.max(0, Math.min(sourceSize.height - 1, Math.round(options.y)))
    const width = Math.max(1, Math.min(sourceSize.width - x, Math.round(options.width)))
    const height = Math.max(1, Math.min(sourceSize.height - y, Math.round(options.height)))
    if (
      options.x < 0 ||
      options.y < 0 ||
      x !== options.x ||
      y !== options.y ||
      width !== options.width ||
      height !== options.height
    ) {
      throw new Error('裁剪区域无效')
    }

    const cropped = image.crop({ x, y, width, height })
    if (cropped.isEmpty()) throw new Error('裁剪截图失败')
    const croppedSize = cropped.getSize()
    const maxWidth = Math.max(320, Math.min(MAX_WIDTH, Math.round(options.maxWidth)))
    const targetWidth = Math.min(croppedSize.width, maxWidth)
    const targetHeight = Math.max(
      1,
      Math.min(4096, Math.round((croppedSize.height * targetWidth) / croppedSize.width))
    )
    const resized =
      targetWidth === croppedSize.width && targetHeight === croppedSize.height
        ? cropped
        : cropped.resize({ width: targetWidth, height: targetHeight, quality: 'good' })
    const quality = Math.max(MIN_QUALITY, Math.min(MAX_QUALITY, Math.round(options.quality)))
    const buffer = resized.toJPEG(quality)
    const size = resized.getSize()

    // 裁剪区域的 DIP 范围由原 view 线性换算；resize 不改变这个映射。
    const view: CuaView = {
      displayId: source.view.displayId,
      imageWidth: size.width,
      imageHeight: size.height,
      dipX: source.view.dipX + (x * source.view.dipWidth) / source.view.imageWidth,
      dipY: source.view.dipY + (y * source.view.dipHeight) / source.view.imageHeight,
      dipWidth: (width * source.view.dipWidth) / source.view.imageWidth,
      dipHeight: (height * source.view.dipHeight) / source.view.imageHeight,
      scaleFactor: source.view.scaleFactor
    }
    const capturedAt = this.now()
    this.last = { buffer, view }
    return {
      base64: buffer.toString('base64'),
      view,
      capturedAt
    }
  }

  async inspect(): Promise<CuaForeground> {
    return this.client.inspect()
  }

  async input(op: CuaInputOp): Promise<void> {
    switch (op.op) {
      case 'click': {
        const point = this.toPhysical(op.x, op.y)
        await this.client.click(point.x, point.y, op.button, op.count)
        return
      }
      case 'scroll': {
        const point = this.toPhysical(op.x, op.y)
        await this.client.scroll(point.x, point.y, op.deltaY, op.deltaX)
        return
      }
      case 'drag': {
        const from = this.toPhysical(op.fromX, op.fromY)
        const to = this.toPhysical(op.toX, op.toY)
        await this.client.drag(from.x, from.y, to.x, to.y)
        return
      }
      case 'type':
        await this.client.type(op.text)
        return
      case 'key':
        await this.client.key(op.combo)
        return
    }
  }

  async releaseAll(): Promise<void> {
    await this.client.releaseAll()
  }

  async stop(): Promise<void> {
    this.last = null
    await this.client.stop()
  }

  health(): { healthy: boolean } {
    return this.client.health()
  }

  onTakeover(listener: (kind: CuaTakeoverKind) => void): () => void {
    return this.client.onTakeover(listener)
  }

  // -------------------------------------------------------------------------

  private resolveDisplay(options: CuaCaptureOptions): Display {
    if (options.display === 'specific') {
      const id = options.displayId ?? ''
      const display = screen.getAllDisplays().find((item) => String(item.id) === id)
      if (display === undefined) throw new Error('指定的显示器已断开')
      return display
    }
    if (options.display === 'primary') return screen.getPrimaryDisplay()
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  }

  private toPhysical(x: number, y: number): { x: number; y: number } {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('坐标无效')
    }
    const point = screen.dipToScreenPoint({ x, y })
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error('坐标无法转换到屏幕像素')
    }
    return point
  }
}
