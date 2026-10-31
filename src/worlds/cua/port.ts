import type { CuaActionKind } from './guard'

/**
 * 电脑操作（CUA）的平台端口。World 只负责策略、限频与提示词，
 * 真正的截图/输入由主进程注入的实现完成；测试使用 fake port。
 *
 * 坐标约定：
 *  - `CuaInputOp` 的坐标是**全局 DIP**（Electron 的 screen 坐标系）；
 *  - 截图返回的 `CuaView` 记录图像与同一显示器 DIP 范围的映射；
 *  - World 把“截图像素”换算为 DIP 后再交给端口，端口再换算成物理像素。
 */

export type CuaDisplayChoice = 'primary' | 'cursor'

export interface CuaView {
  displayId: string
  /** 截图图像尺寸（发送给模型的像素）。 */
  imageWidth: number
  imageHeight: number
  /** 该显示器在 Electron DIP 坐标系中的范围。 */
  dipX: number
  dipY: number
  dipWidth: number
  dipHeight: number
  scaleFactor: number
}

export interface CuaCapture {
  /** 纯 base64 JPEG；只存在于内存与当前 turn。 */
  base64: string
  view: CuaView
  capturedAt: number
}

export interface CuaCaptureOptions {
  display: CuaDisplayChoice | 'specific'
  /** `display='specific'` 时必填；找不到就失败，不猜主屏。 */
  displayId?: string
  maxWidth: number
  quality: number
}

export interface CuaZoomOptions {
  /** 以最近一次截图的像素为基准。 */
  x: number
  y: number
  width: number
  height: number
  maxWidth: number
  quality: number
}

export interface CuaForeground {
  /** 前台窗口所属进程名（不含路径）。 */
  processName: string
  /** 标题是否命中密码/支付/验证码等敏感词；**不返回标题原文**。 */
  titleSensitive: boolean
  /** 用于识别桌宠自身进程；可为空。 */
  pid?: number
}

export type CuaPointerButton = 'left' | 'right' | 'middle'

/** 输入操作的坐标都是全局 DIP。 */
export type CuaInputOp =
  | {
      op: 'click'
      x: number
      y: number
      button: CuaPointerButton
      count: 1 | 2
    }
  | {
      op: 'scroll'
      x: number
      y: number
      deltaY: number
      deltaX: number
    }
  | {
      op: 'drag'
      fromX: number
      fromY: number
      toX: number
      toY: number
    }
  | { op: 'type'; text: string }
  | { op: 'key'; combo: string }

/** `input` 是低层钩子不可用时的保守回退（无法区分鼠标/键盘）。 */
export type CuaTakeoverKind = 'mouse' | 'keyboard' | 'input'

/**
 * 主进程实现。任何不确定情况都应抛错或返回失败，由 World 转成可读拒绝；
 * 不允许“猜一个显示器/坐标继续执行”。
 */
export interface CuaPort {
  capture(options: CuaCaptureOptions): Promise<CuaCapture>
  /** 裁剪最近一次截图并放大；没有可裁剪的截图时返回 null。 */
  zoom(options: CuaZoomOptions): Promise<CuaCapture | null>
  inspect(): Promise<CuaForeground>
  input(op: CuaInputOp): Promise<void>
  /** 释放 Ctrl/Alt/Shift 与鼠标按钮；停止、abort、锁屏、退出时必发。 */
  releaseAll(): Promise<void>
  /** 释放并终止输入助手；之后的下一次 input 会重新懒启动。 */
  stop(): Promise<void>
  /** 本地诊断；不包含截图/坐标/窗口标题。 */
  health?(): { healthy: boolean }
  onTakeover(listener: (kind: CuaTakeoverKind) => void): () => void
}

export interface CuaActionEvent {
  kind: CuaActionKind
  /** 全局 DIP 坐标；运行时再转成桌宠页本地 CSS 像素。 */
  x: number
  y: number
  toX?: number
  toY?: number
}

/** 动作标记与状态反馈；不包含截图、窗口标题或输入文字。 */
export interface CuaSink {
  onAction(event: CuaActionEvent): void
  onState(active: boolean): void
}

export interface CuaStatus {
  enabled: boolean
  available: boolean
  permission: 'ask-once' | 'ask-each-action'
  helperHealthy: boolean
  actionsThisTurn: number
  maxActionsPerTurn: number
  lastAction: CuaActionKind | null
  lastActionAt: number | null
}

export function joinCuaError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
