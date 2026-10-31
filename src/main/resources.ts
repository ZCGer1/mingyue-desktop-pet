import { join } from 'node:path'

/**
 * 只读资源路径。开发时从工程目录读，打包后从 `process.resourcesPath` 读。
 * `extraResources` 只复制 dsh-pet 许可/审计记录、resources/ 与浏览器扩展，
 * 不把上游源码快照带进安装包。
 *
 * 动画 WebM 是唯一例外：它们带中文文件名，而 Windows 下 electron-builder
 * 生成 portable/NSIS 的 7z 包时会静默丢掉这些条目（安装后 webm 目录为空）。
 * 因此 WebM 通过 `files` 打进 app.asar，由 Node 写入归档，打包后仍从
 * app.asar 内读取；Electron 的 fs 补丁支持 realpath/stat/带 Range 的流式读取。
 */
export interface ResourcePaths {
  vendorDir: string
  /** 锁定版本的 dsh-pet 透明 WebM 素材目录（vendor/dsh-pet/assets/webm）。 */
  dshPetWebmDir: string
  /** 上游素材来源/哈希/许可证记录，仅用于诊断与交付审计。 */
  dshPetVendorDir: string
  petPageDir: string
  activityScript: string
  /** Windows.Media.Ocr 辅助脚本；截图只在内存中经 stdin 传入。 */
  ocrScript: string
  /** 音量/媒体/锁屏等白名单系统动作。 */
  systemActionsScript: string
  /** CUA 常驻输入助手（键鼠注入 + 前台检查）；只在用户开启电脑操作后启动。 */
  cuaInputScript: string
  /** 窗口清单/UIA/按窗口截图的一次性辅助脚本（只处理授权窗口）。 */
  desktopWindowScript: string
  /** 常驻窗口几何助手：只输出矩形/Z 序，用于桌宠停靠在窗口上沿。 */
  perchScript: string
  /** 可加载的 Chrome/Edge 解压扩展目录。 */
  browserExtensionDir: string
  /** 只读 B 站 Python 服务、ASR worker、模型准备脚本与锁定的依赖清单。 */
  bilibiliDir: string
  iconsDir: string
  trayIcon: string
  trayPausedIcon: string
}

export function resolveResourcePaths(opts: {
  packaged: boolean
  appPath: string
  resourcesPath: string
}): ResourcePaths {
  const base = opts.packaged ? opts.resourcesPath : opts.appPath
  const vendorDir = join(base, 'vendor')
  const resourcesDir = join(base, 'resources')
  const dshPetVendorDir = join(vendorDir, 'dsh-pet')
  return {
    vendorDir,
    // 打包后 appPath 指向 `resources/app.asar`，WebM 就在 asar 内。
    dshPetWebmDir: join(opts.appPath, 'vendor', 'dsh-pet', 'assets', 'webm'),
    dshPetVendorDir,
    petPageDir: join(resourcesDir, 'pet-page'),
    activityScript: join(resourcesDir, 'activity', 'foreground-helper.ps1'),
    ocrScript: join(resourcesDir, 'activity', 'ocr.ps1'),
    systemActionsScript: join(resourcesDir, 'system', 'actions.ps1'),
    cuaInputScript: join(resourcesDir, 'cua', 'input.ps1'),
    desktopWindowScript: join(resourcesDir, 'desktop', 'window-helper.ps1'),
    perchScript: join(resourcesDir, 'desktop', 'perch-helper.ps1'),
    browserExtensionDir: join(base, 'browser-extension'),
    bilibiliDir: join(resourcesDir, 'bilibili'),
    iconsDir: join(resourcesDir, 'icons'),
    trayIcon: join(resourcesDir, 'icons', 'tray.png'),
    trayPausedIcon: join(resourcesDir, 'icons', 'tray-paused.png')
  }
}
