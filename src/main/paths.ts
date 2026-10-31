import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 所有可写路径的唯一解析点（PLAN.md §7.1）。
 *
 * 生产环境：
 *  - 便携 exe 同级有 `portable.flag` 或 `data/` → `<exe>/data`
 *  - 否则 `%APPDATA%/桌宠`
 * 便携构建的真实 exe 目录来自 `PORTABLE_EXECUTABLE_DIR`，因为启动器会把应用
 * 解包到临时目录后再运行，`process.execPath` 的目录不是用户摆放 exe 的位置。
 *
 * 开发环境（`app.isPackaged === false`）用工程根下的 `.dev-data`，避免把测试
 * 数据写进真实的 APPDATA；同时在文档里写清楚，方便手动检查。
 */
export interface AppPaths {
  rootDir: string
  configFile: string
  configBackupFile: string
  secretFile: string
  memoryDir: string
  dataDir: string
  logsDir: string
  undoDir: string
  portable: boolean
}

export interface ResolvePathsOptions {
  packaged: boolean
  exePath: string
  appDataDir: string
  projectRoot: string
  productName?: string
  /** 仅未打包时可用：E2E/调试把开发数据放到独立目录，避免污染 `.dev-data`。 */
  devDataDir?: string
  /**
   * electron-builder 便携启动器把应用解包到临时目录后重新启动，`process.execPath`
   * 指向那里；这个环境变量（`PORTABLE_EXECUTABLE_DIR`）才是便携 exe 的真实目录。
   */
  portableExecutableDir?: string
}

export function resolveAppPaths(options: ResolvePathsOptions): AppPaths {
  const product = options.productName?.trim() === '' || options.productName === undefined
    ? '桌宠'
    : options.productName

  let rootDir: string
  let portable = false
  if (!options.packaged) {
    const override = options.devDataDir?.trim()
    rootDir = override === undefined || override === '' ? join(options.projectRoot, '.dev-data') : override
  } else {
    const portableDir = options.portableExecutableDir?.trim()
    const exeDir =
      portableDir === undefined || portableDir === '' ? dirname(options.exePath) : portableDir
    portable = existsSync(join(exeDir, 'portable.flag')) || existsSync(join(exeDir, 'data'))
    rootDir = portable ? join(exeDir, 'data') : join(options.appDataDir, product)
  }

  return {
    rootDir,
    configFile: join(rootDir, 'config.json'),
    configBackupFile: join(rootDir, 'config.bad.json'),
    secretFile: join(rootDir, 'secrets', 'deepseek.key'),
    memoryDir: join(rootDir, 'memory'),
    dataDir: join(rootDir, 'data'),
    logsDir: join(rootDir, 'logs'),
    undoDir: join(rootDir, 'undo'),
    portable
  }
}
