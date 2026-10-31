import { app, dialog, screen, session } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigStore } from './config/store'
import { SecretStore } from './config/secrets'
import { resolveAppPaths } from './paths'
import { Runtime } from './runtime'

/**
 * Electron 主进程入口（PLAN.md §5）。
 *
 * 顺序很重要：
 *  1. 单实例锁与路径设置必须在 ready 之前完成；
 *  2. 权限、网络与导航策略在创建任何窗口之前收紧；
 *  3. Runtime 先启动 Bot 与本地桌宠服务器，再创建窗口、注册 IPC、起托盘；
 *  4. 退出时先停 Bot（终结合子进程/活动采样），再停服务器与窗口。
 */

app.setAppUserModelId('io.github.mingyue.pet')
app.enableSandbox()

const gotLock = app.requestSingleInstanceLock()
let runtime: Runtime | null = null
let finalizing = false

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    runtime?.openChatForUser()
  })
  void main()
}

async function main(): Promise<void> {
  const paths = resolveAppPaths({
    packaged: app.isPackaged,
    exePath: process.execPath,
    appDataDir: app.getPath('appData'),
    projectRoot: app.getAppPath(),
    // PLAN.md §7.1 固定使用 `%APPDATA%/桌宠`；产品名只用于窗口/安装包显示。
    productName: '桌宠',
    // 只影响未打包运行；打包后永远走 APPDATA / 便携目录。
    ...(!app.isPackaged && process.env['MINGYUE_DEV_DATA_DIR'] !== undefined
      ? { devDataDir: process.env['MINGYUE_DEV_DATA_DIR'] }
      : {}),
    // 便携启动器会把真实 exe 目录传给解包后的进程；普通安装版没有这个变量。
    ...(app.isPackaged && process.env['PORTABLE_EXECUTABLE_DIR'] !== undefined
      ? { portableExecutableDir: process.env['PORTABLE_EXECUTABLE_DIR'] }
      : {})
  })

  // Chromium 缓存/本地存储留在应用数据目录，避免散落到 APPDATA 其它位置，
  // 也让工作区工具的拒绝根覆盖这些文件。
  try {
    const chromiumDir = join(paths.rootDir, 'chromium')
    mkdirSync(chromiumDir, { recursive: true })
    app.setPath('userData', chromiumDir)
    app.setPath('sessionData', chromiumDir)
  } catch {
    /* 设置失败不阻止启动；Electron 会退回默认 userData */
  }

  const configStore = new ConfigStore(paths.configFile, paths.configBackupFile)
  const loaded = configStore.load()
  const secrets = new SecretStore(paths.secretFile)

  app.on('before-quit', (event) => {
    if (runtime === null || finalizing) return
    event.preventDefault()
    finalizing = true
    void runtime
      .shutdown()
      .catch((error: unknown) => {
        console.error('[main] shutdown failed', error)
      })
      .finally(() => {
        app.exit(0)
      })
  })

  app.on('window-all-closed', () => {
    // 托盘常驻：聊天/设置关闭不退出应用；桌宠窗口异常时由 WindowManager 重建。
  })

  app.on('activate', () => {
    // activate 是 macOS 的 Dock 行为；Windows 上可能由焦点变化触发，
    // 不能用来打开快捷输入或完整聊天，否则桌宠页会在启动/切换窗口时莫名展开。
    if (process.platform === 'darwin') runtime?.openChatForUser()
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })

  await app.whenReady()

  applySessionPolicy()

  try {
    runtime = new Runtime({
      paths,
      configStore,
      loaded,
      secrets,
      firstRun: loaded.created
    })
    await runtime.start()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[main] 启动失败', error)
    dialog.showErrorBox('桌宠无法启动', message)
    app.exit(1)
    return
  }

  const activeRuntime = runtime
  runtime.botInstance.logger.info('应用启动', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    portable: paths.portable,
    firstRun: loaded.created,
    configWarning: loaded.warning !== null
  })

  const relayout = (): void => activeRuntime.windows.syncPetBounds()
  screen.on('display-metrics-changed', relayout)
  screen.on('display-added', relayout)
  screen.on('display-removed', relayout)

  process.on('unhandledRejection', (reason) => {
    activeRuntime.botInstance.logger.error('未处理的 Promise 拒绝', {
      error: reason instanceof Error ? reason.message : String(reason)
    })
  })

  if (process.env['MINGYUE_OPEN_DEVTOOLS'] === '1' && !app.isPackaged) {
    activeRuntime.windows.petWebContents?.openDevTools({ mode: 'detach' })
  }
}

/**
 * 渲染进程不需要任何设备/媒体/通知权限，也不需要直接联网。
 * 所有外部请求（DeepSeek、网页抓取）都只允许在 Node 主进程里发生。
 * 这里按 URL 主机收紧，而不是依赖页面 CSP —— 页面被替换时仍然有效。
 */
function applySessionPolicy(): void {
  const ses = session.defaultSession

  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.on('will-download', (event) => {
    event.preventDefault()
  })

  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      let allowed = false
      try {
        const host = new URL(details.url).hostname.toLowerCase()
        allowed = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
      } catch {
        allowed = false
      }
      callback(allowed ? {} : { cancel: true })
    }
  )

  ses.setCertificateVerifyProc((_request, callback) => callback(-3))
}
