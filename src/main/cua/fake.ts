import { nativeImage, screen } from 'electron'
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

/**
 * 仅 E2E 使用的 CUA 假端口。
 *
 * 它不截图、不注入键鼠、不启动 PowerShell；只返回一张固定的小 JPEG 和固定的
 * 前台应用，方便在真实 Electron 主进程里验证截图图片通道、审批与动作标记。
 * 只有未打包的 `MINGYUE_E2E_CUA_FAKE=1` 才会构造这个类。
 */
export class E2EFakeCuaPort implements CuaPort {
  private readonly base64: string
  private readonly baseView: CuaView
  private readonly takeover = new Set<(kind: CuaTakeoverKind) => void>()
  readonly inputs: CuaInputOp[] = []
  releaseAllCalls = 0
  stopCalls = 0

  constructor() {
    const display = screen.getPrimaryDisplay()
    const width = 64
    const height = 40
    const bitmap = Buffer.alloc(width * height * 4, 0x55)
    const image = nativeImage.createFromBitmap(bitmap, { width, height })
    this.base64 = image.toJPEG(80).toString('base64')
    this.baseView = {
      displayId: String(display.id),
      imageWidth: width,
      imageHeight: height,
      dipX: display.bounds.x,
      dipY: display.bounds.y,
      dipWidth: display.bounds.width,
      dipHeight: display.bounds.height,
      scaleFactor: display.scaleFactor
    }
  }

  async capture(_options: CuaCaptureOptions): Promise<CuaCapture> {
    return {
      base64: this.base64,
      view: { ...this.baseView },
      capturedAt: Date.now()
    }
  }

  async zoom(_options: CuaZoomOptions): Promise<CuaCapture | null> {
    return this.capture({
      display: 'specific',
      displayId: this.baseView.displayId,
      maxWidth: this.baseView.imageWidth,
      quality: 80
    })
  }

  async inspect(): Promise<CuaForeground> {
    return { processName: 'notepad.exe', titleSensitive: false, pid: 4242 }
  }

  async input(op: CuaInputOp): Promise<void> {
    this.inputs.push(op)
  }

  async releaseAll(): Promise<void> {
    this.releaseAllCalls += 1
  }

  async stop(): Promise<void> {
    this.stopCalls += 1
  }

  health(): { healthy: boolean } {
    return { healthy: true }
  }

  onTakeover(listener: (kind: CuaTakeoverKind) => void): () => void {
    this.takeover.add(listener)
    return () => {
      this.takeover.delete(listener)
    }
  }

  emitTakeover(kind: CuaTakeoverKind): void {
    for (const listener of this.takeover) listener(kind)
  }
}
