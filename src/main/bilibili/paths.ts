import { join } from 'node:path'

/**
 * B 站阅读路线的全部可写路径。
 *
 * 只落在 `<rootDir>/bilibili` 下，不碰 `release/data`，也不与配置/密钥目录
 * 混用。Python venv、模型、转写工作目录、阅读记录和日报都各自独立，
 * 便于用户整体删除或备份（凭据文件本身仍是 DPAPI 加密的）。
 */
export interface BiliPaths {
  rootDir: string
  /** 固定来源安装的应用专用 Python（用户点击后才存在）。 */
  pythonDir: string
  /** 只读 MCP 服务的独立 venv。 */
  serviceVenvDir: string
  /** ASR worker 的独立 venv（不含 bilibili-api，减少攻击面）。 */
  asrVenvDir: string
  modelsDir: string
  /** 每个转写任务一个临时目录；完成后只保留结果 JSON。 */
  jobsDir: string
  reportsDir: string
  readingDir: string
  /** DPAPI/safeStorage 加密的登录凭据。 */
  credentialsFile: string
  asrStateFile: string
  serviceMarkerFile: string
  asrMarkerFile: string
}

export function resolveBiliPaths(rootDir: string): BiliPaths {
  const base = join(rootDir, 'bilibili')
  return {
    rootDir: base,
    pythonDir: join(base, 'python'),
    serviceVenvDir: join(base, 'venv-service'),
    asrVenvDir: join(base, 'venv-asr'),
    modelsDir: join(base, 'models'),
    jobsDir: join(base, 'asr-jobs'),
    reportsDir: join(base, 'reports'),
    readingDir: join(base, 'reading'),
    credentialsFile: join(base, 'credentials.enc'),
    asrStateFile: join(base, 'asr-state.json'),
    serviceMarkerFile: join(base, 'service.installed.json'),
    asrMarkerFile: join(base, 'asr.installed.json')
  }
}

/** Whisper 模型目录；目录名只允许固定枚举，不接受任意字符串。 */
export function biliModelDir(paths: BiliPaths, model: string): string {
  const safe = ['tiny', 'base', 'small', 'medium'].includes(model) ? model : 'small'
  return join(paths.modelsDir, safe)
}
