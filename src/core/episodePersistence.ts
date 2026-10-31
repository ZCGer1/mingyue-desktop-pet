import { readFileSync } from 'node:fs'
import type { ConversationEpisodeStore } from './conversationEpisode'
import type { Logger } from './types'
import { atomicWrite, safeJsonParse } from './util'

export interface EpisodePersistenceOptions {
  file: string
  store: ConversationEpisodeStore
  logger: Pick<Logger, 'warn'>
}

/**
 * Episode 交接的落盘与过期 ticker。
 *
 * 这里只负责文件、防抖与定时器；什么算“已回答/应替代”仍由
 * ConversationEpisodeStore 决定，Bot 保留业务回调与状态广播。
 */
export class EpisodePersistence {
  private readonly file: string
  private readonly store: ConversationEpisodeStore
  private readonly logger: Pick<Logger, 'warn'>
  private saveTimer: NodeJS.Timeout | null = null
  private tickTimer: NodeJS.Timeout | null = null

  constructor(options: EpisodePersistenceOptions) {
    this.file = options.file
    this.store = options.store
    this.logger = options.logger
  }

  /** 启动恢复 Episode；已过期条目只清理，不触发“未回答”回调。 */
  restore(): void {
    try {
      const parsed = safeJsonParse<unknown>(readFileSync(this.file, 'utf8'))
      if (parsed === null || parsed === undefined || typeof parsed !== 'object') return
      this.store.restore((parsed as { episodes?: unknown }).episodes)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('Episode 恢复失败，已忽略', { error: String(error).slice(0, 200) })
      }
    }
  }

  scheduleSave(): void {
    if (this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 500)
    this.saveTimer.unref?.()
  }

  flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      atomicWrite(
        this.file,
        `${JSON.stringify({ version: 1, episodes: this.store.snapshot() }, null, 2)}\n`
      )
    } catch (error) {
      this.logger.warn('Episode 保存失败', { error: String(error).slice(0, 200) })
    }
  }

  /**
   * 无人访问时也要让过期 Episode 触发“未回答”回调并落盘。
   * `onTick` 只做业务通知（如状态广播），不改变存储规则。
   */
  startTicking(onTick: () => void, intervalMs = 60_000): void {
    if (this.tickTimer !== null) return
    this.tickTimer = setInterval(() => {
      this.store.tick()
      this.scheduleSave()
      onTick()
    }, intervalMs)
    this.tickTimer.unref?.()
  }

  stopTicking(): void {
    if (this.tickTimer !== null) clearInterval(this.tickTimer)
    this.tickTimer = null
  }
}
