import type { SystemPort } from '../system/port'
import type { DesktopPort, DesktopWindowRef } from '../desktop/types'

/**
 * 应用启动与窗口验证的共用底层。
 *
 * 授权判断仍留在各自 World：系统白名单是 `sys_open_app` 的唯一来源，
 * 普通应用发现范围属于 `apps_launch`；这里只统一路径校验后的启动执行与
 * accepted / executed / verified 事实，避免两套回执对“已启动”说法不一。
 */
export interface AppLaunchFacts {
  real: string
  accepted: boolean
  executed: boolean
  verified: boolean
  window: DesktopWindowRef | null
  message: string | null
}

export async function executeAppLaunch(
  port: SystemPort,
  request: {
    /** 已通过 validateAppPath 的真实路径。 */
    real: string
    args: string[]
    /** 用于窗口匹配的进程键；省略时不等待窗口。 */
    process?: string | null
    desktopPort?: DesktopPort | null
    waitMs?: number
    now?: () => number
    pollMs?: number
  }
): Promise<AppLaunchFacts> {
  const executed = await port.launch(request.real, [...request.args])
  if (!executed.ok) {
    return {
      real: request.real,
      accepted: false,
      executed: false,
      verified: false,
      window: null,
      message: executed.message ?? null
    }
  }
  const waitMs = Math.max(0, request.waitMs ?? 0)
  const window =
    waitMs > 0 && request.process != null && request.desktopPort != null
      ? await waitForProcessWindow(
          request.desktopPort,
          request.process,
          waitMs,
          request.now ?? Date.now,
          request.pollMs
        )
      : null
  return {
    real: request.real,
    accepted: true,
    executed: true,
    verified: window !== null,
    window,
    message: null
  }
}

/**
 * 聚焦请求成功后，用同一份窗口清单确认目标确实在前台。
 * 只读取普通应用窗口；普通聚焦与 apps_focus 共用这套验证，避免“请求
 * 已发出”被写成“已经切到前台”。
 */
export async function confirmWindowForeground(
  desktopPort: DesktopPort,
  process: string,
  windowId: string,
  timeoutMs = 1500,
  now: () => number = Date.now,
  pollMs = 200
): Promise<boolean> {
  const deadline = now() + Math.max(0, timeoutMs)
  // 同时按次数兜底：测试里的假时钟可能不前进，不能让等待变成死循环。
  const attempts = Math.max(1, Math.ceil(Math.max(0, timeoutMs) / Math.max(1, pollMs)) + 1)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let foreground = false
    try {
      const windows = await desktopPort.listWindows([process])
      foreground = windows.some((window) => window.id === windowId && window.foreground)
    } catch {
      foreground = false
    }
    if (foreground) return true
    if (now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
  }
  return false
}

/** 轮询窗口列表直到出现该进程的窗口；失败（接口不可用）按未验证处理。 */
export async function waitForProcessWindow(
  desktopPort: DesktopPort,
  process: string,
  timeoutMs: number,
  now: () => number = Date.now,
  pollMs = 400
): Promise<DesktopWindowRef | null> {
  if (timeoutMs <= 0) return null
  const deadline = now() + timeoutMs
  // 与 confirmWindowForeground 一样，避免注入的假时钟不前进时无限轮询。
  const attempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollMs)) + 1)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let windows: DesktopWindowRef[] = []
    try {
      windows = await desktopPort.listWindows([process])
    } catch {
      windows = []
    }
    if (windows.length > 0) return windows[0] ?? null
    if (now() >= deadline) return null
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
  }
  return null
}
