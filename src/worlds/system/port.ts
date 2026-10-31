/**
 * 固定支持的系统动作。这是输入校验与执行边界的白名单，不是用户可配置的
 * 分组授权：没有关机、重启、结束进程或任意命令。未知动作在 schema/执行
 * 边界一律拒绝。
 */
export type SystemAction =
  | 'volume_up'
  | 'volume_down'
  | 'mute_toggle'
  | 'media_play_pause'
  | 'media_next'
  | 'media_prev'
  | 'lock'

export const SYSTEM_ACTIONS: SystemAction[] = [
  'volume_up',
  'volume_down',
  'mute_toggle',
  'media_play_pause',
  'media_next',
  'media_prev',
  'lock'
]

export const SYSTEM_ACTION_LABELS: Record<SystemAction, string> = {
  volume_up: '调高音量',
  volume_down: '调低音量',
  mute_toggle: '切换静音',
  media_play_pause: '播放 / 暂停',
  media_next: '下一首',
  media_prev: '上一首',
  lock: '锁定屏幕'
}

export interface SystemPortResult {
  ok: boolean
  message?: string
}

/**
 * 平台能力端口。SystemWorld 本身不 import Electron，也不直接启动进程；
 * 真正的 `shell.openPath` / `spawn` / PowerShell 只在主进程实现。
 */
export interface SystemPort {
  openPath(path: string): Promise<SystemPortResult>
  openUrl(url: string): Promise<SystemPortResult>
  /** 启动白名单应用；file 已经过 guard 校验，args 来自本地配置。 */
  launch(file: string, args: string[]): Promise<SystemPortResult>
  action(action: SystemAction): Promise<SystemPortResult>
}
