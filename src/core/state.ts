import { existsSync, readFileSync } from 'node:fs'
import { atomicWrite, safeJsonParse } from './util'

export interface PersistedState {
  lastCursor: number
  lastDeliveredCursor: number
  paused: boolean
  statsOptIn: boolean
  lastDay: string
  [key: string]: unknown
}

const DEFAULTS: PersistedState = {
  lastCursor: 0,
  lastDeliveredCursor: 0,
  paused: false,
  statsOptIn: false,
  lastDay: ''
}

/**
 * `data/state.json`：游标、暂停、统计开关等轻量状态。
 * 不保存 API Key，也不保存任何活动原始信息。
 */
export class StateStore {
  private data: PersistedState
  private readonly file: string
  private saveTimer: NodeJS.Timeout | null = null

  constructor(file: string) {
    this.file = file
    this.data = { ...DEFAULTS }
    if (existsSync(file)) {
      try {
        const parsed = safeJsonParse<Partial<PersistedState>>(readFileSync(file, 'utf8'))
        if (parsed !== undefined && parsed !== null) this.data = { ...DEFAULTS, ...parsed }
      } catch {
        /* 损坏的状态文件用默认值；不阻塞启动 */
      }
    }
  }

  get<K extends keyof PersistedState>(key: K): PersistedState[K] {
    return this.data[key]
  }

  set<K extends keyof PersistedState>(key: K, value: PersistedState[K]): void {
    this.data[key] = value
    this.scheduleSave()
  }

  update(patch: Partial<PersistedState>): void {
    Object.assign(this.data, patch)
    this.scheduleSave()
  }

  snapshot(): PersistedState {
    return { ...this.data }
  }

  flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    atomicWrite(this.file, JSON.stringify(this.data, null, 2))
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        atomicWrite(this.file, JSON.stringify(this.data, null, 2))
      } catch {
        /* 状态保存失败不致命 */
      }
    }, 200)
    this.saveTimer.unref?.()
  }
}
