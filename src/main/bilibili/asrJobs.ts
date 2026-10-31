import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../../core/types'
import type { BiliReadFailureCode } from '../../shared/bilibili'
import { atomicWrite } from '../../core/util'
import type { BiliAsrJobView, BiliAsrState } from '../../shared/bilibili'
import { biliModelDir, type BiliPaths } from './paths'
import { biliChildEnv } from './childEnv'
import { killProcessTree } from './kill'

/**
 * 本地转写后台队列。
 *
 * - 全局同时只运行 1 条；模型/音频全部在应用目录，禁止云端兜底。
 * - 只接受主进程校验后的 BV/分 P；worker 自己重建 URL，不接受任意 URL。
 * - 转写文本只在内存短期保留；状态文件、阅读记录、日报都不落全文。
 * - 重启后残留 running/queued 标记为 interrupted，不自动无限重跑。
 * - 停止/撤权/退出登录会终止进程树并清理临时音频。
 */

export interface BiliAsrLimits {
  model: string
  maxMediaMinutes: number
  maxDownloadMb: number
  maxRunMinutes: number
  maxCacheMb: number
}

export interface BiliAsrSubmitInput {
  bvid: string
  page: number
  title: string
  durationSec: number | null
  limits: BiliAsrLimits
}

export interface BiliAsrRead {
  job: BiliAsrJobView
  text: string
  offset: number
  totalChars: number
  nextOffset: number | null
  complete: boolean
}

export interface BiliAsrJobManagerOptions {
  paths: BiliPaths
  resourcesDir: string
  asrPython: () => string | null
  logger: Logger
  onFinished?: (job: BiliAsrJobView) => void
  spawnImpl?: typeof spawn
  now?: () => number
}

interface RuntimeJob {
  view: BiliAsrJobView
  text: string | null
  /** 运行/排队时的取消原因；进程退出后据此落状态。 */
  cancelReason: 'cancelled' | 'interrupted' | null
  timedOut: boolean
  jobDir: string
  /** 提交时的限制快照；运行中改配置不影响已排队任务。 */
  limits: BiliAsrLimits
}

interface PersistedState {
  v: 1
  jobs: BiliAsrJobView[]
}

const MAX_JOBS = 40
const KEEP_FINISHED_MS = 24 * 60 * 60_000
const MAX_QUEUE = 10
const MAX_TEXT_CHARS = 200_000
const MAX_READ_CHARS = 12_000

export class BiliAsrJobs {
  private readonly opts: BiliAsrJobManagerOptions
  private readonly jobs = new Map<string, RuntimeJob>()
  private running: RuntimeJob | null = null
  private child: ReturnType<typeof spawn> | null = null
  private runTimer: NodeJS.Timeout | null = null
  private disposed = false
  private pumpScheduled = false

  constructor(options: BiliAsrJobManagerOptions) {
    this.opts = options
    this.load()
  }

  view(jobId: string): BiliAsrJobView | null {
    return this.jobs.get(jobId)?.view ?? null
  }

  recent(limit = 5): BiliAsrJobView[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.view.queuedAt - a.view.queuedAt)
      .slice(0, Math.max(0, Math.min(limit, MAX_JOBS)))
      .map((job) => ({ ...job.view }))
  }

  get runningCount(): number {
    return this.running === null ? 0 : 1
  }

  get queuedCount(): number {
    return [...this.jobs.values()].filter((job) => job.view.state === 'queued').length
  }

  /** 提交任务并立即返回 jobId；队列满/环境缺失/超限都明确失败。 */
  submit(input: BiliAsrSubmitInput): BiliAsrJobView {
    if (this.disposed) throw new AsrError('asr-failed', '应用正在退出，无法提交转写。')
    if (!/^BV[0-9A-Za-z]{10}$/.test(input.bvid)) {
      throw new AsrError('internal', '转写任务的 BV 号不合法。')
    }
    if (!Number.isInteger(input.page) || input.page < 1 || input.page > 200) {
      throw new AsrError('internal', '转写任务的分 P 不合法。')
    }
    const model = normalizeModel(input.limits.model)
    const key = asrKey(input.bvid, input.page, model)
    const existing = [...this.jobs.values()]
      .reverse()
      .find((job) => asrKey(job.view.bvid, job.view.partIndex, job.view.model) === key)
    if (existing !== undefined) {
      const state = existing.view.state
      if (state === 'queued' || state === 'running') return { ...existing.view }
      if (state === 'succeeded' && existing.text !== null) return { ...existing.view }
      if (state === 'empty') return { ...existing.view }
      if (state === 'failed' && existing.view.attempts >= 2) return { ...existing.view }
    }
    if (this.queuedCount >= MAX_QUEUE) {
      throw new AsrError('asr-limit', '转写队列已满，请稍后再试。')
    }
    const python = this.opts.asrPython()
    if (python === null) throw new AsrError('asr-not-installed', '本地转写依赖尚未安装。')
    const modelDir = biliModelDir(this.opts.paths, model)
    if (!existsSync(join(modelDir, 'model.bin'))) {
      throw new AsrError('asr-model-missing', '本地转写模型尚未准备。')
    }
    if (this.cacheBytes() > Math.max(1, input.limits.maxCacheMb) * 1024 * 1024) {
      throw new AsrError('asr-limit', '本地转写缓存超过上限，请清理模型或等待旧任务过期。')
    }
    const id = randomUUID()
    const job: RuntimeJob = {
      view: {
        id,
        bvid: input.bvid,
        partIndex: input.page,
        title: input.title.slice(0, 120),
        state: 'queued',
        queuedAt: this.now(),
        startedAt: null,
        finishedAt: null,
        durationSec: input.durationSec,
        model,
        attempts: (existing?.view.attempts ?? 0) + 1,
        errorCode: null,
        errorMessage: null,
        chars: null
      },
      text: null,
      cancelReason: null,
      timedOut: false,
      jobDir: join(this.opts.paths.jobsDir, id),
      limits: { ...input.limits, model }
    }
    this.jobs.set(id, job)
    this.trim()
    this.persist()
    this.schedulePump()
    return { ...job.view }
  }

  /** 读取内存中的转写文本；按字符分段，避免一次塞满上下文。 */
  read(jobId: string, offset = 0, limit = MAX_READ_CHARS): BiliAsrRead {
    const job = this.jobs.get(jobId)
    if (job === undefined) throw new AsrError('not-found', '找不到这个转写任务。')
    const view = job.view
    if (view.state === 'queued' || view.state === 'running') {
      return {
        job: { ...view },
        text: '',
        offset: 0,
        totalChars: 0,
        nextOffset: null,
        complete: false
      }
    }
    if (job.text === null) {
      throw new AsrError(
        view.state === 'succeeded' ? 'asr-failed' : failureForState(view.state),
        view.state === 'succeeded'
          ? '转写结果只在短期缓存中，已过期；如仍需要请重新提交。'
          : view.errorMessage ?? '转写没有可用文本。',
        view.state === 'succeeded'
      )
    }
    const total = job.text.length
    const start = Math.min(Math.max(0, Math.floor(offset)), total)
    const size = Math.min(MAX_READ_CHARS, Math.max(1, Math.floor(limit)))
    const end = Math.min(total, start + size)
    return {
      job: { ...view },
      text: job.text.slice(start, end),
      offset: start,
      totalChars: total,
      nextOffset: end < total ? end : null,
      complete: end >= total
    }
  }

  /** 取消单个任务；排队中的立即取消，运行中的终止进程树。 */
  cancel(jobId: string): BiliAsrJobView {
    const job = this.jobs.get(jobId)
    if (job === undefined) throw new AsrError('not-found', '找不到这个转写任务。')
    if (job.view.state === 'queued') {
      job.view.state = 'cancelled'
      job.view.finishedAt = this.now()
      job.view.errorCode = 'cancelled'
      job.view.errorMessage = '转写已取消。'
      this.persist()
      return { ...job.view }
    }
    if (job.view.state === 'running') {
      job.cancelReason = 'cancelled'
      if (this.child !== null) killProcessTree(this.child.pid)
    }
    return { ...job.view }
  }

  /**
   * 停止全部任务。`interrupted` 用于应用正常退出/重启，`cancelled` 用于
   * 撤权、退出登录或账号切换；两者都不写入任何新发现。
   */
  cancelAll(mode: 'cancelled' | 'interrupted'): void {
    for (const job of this.jobs.values()) {
      if (job.view.state === 'queued') {
        job.view.state = mode
        job.view.finishedAt = this.now()
        job.view.errorCode = mode === 'cancelled' ? 'cancelled' : null
        job.view.errorMessage = mode === 'cancelled' ? '转写已取消。' : '应用重启导致转写中断。'
      } else if (job.view.state === 'running') {
        job.cancelReason = mode
        if (this.child !== null) killProcessTree(this.child.pid)
      }
    }
    this.persist()
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
    if (this.child !== null) killProcessTree(this.child.pid)
    this.persist()
  }

  // ------------------------------------------------------------------ 执行

  private schedulePump(): void {
    if (this.pumpScheduled || this.disposed) return
    this.pumpScheduled = true
    const timer = setTimeout(() => {
      this.pumpScheduled = false
      this.pump()
    }, 0)
    timer.unref?.()
  }

  private pump(): void {
    if (this.disposed || this.running !== null) return
    const next = [...this.jobs.values()]
      .filter((job) => job.view.state === 'queued')
      .sort((a, b) => a.view.queuedAt - b.view.queuedAt)[0]
    if (next === undefined) return
    void this.run(next)
  }

  private async run(job: RuntimeJob): Promise<void> {
    const python = this.opts.asrPython()
    if (python === null) {
      this.finish(job, 'failed', 'asr-not-installed', '本地转写依赖尚未安装。')
      return
    }
    this.running = job
    job.view.state = 'running'
    job.view.startedAt = this.now()
    job.view.errorCode = null
    job.view.errorMessage = null
    this.persist()
    const modelDir = biliModelDir(this.opts.paths, job.view.model)
    mkdirSync(job.jobDir, { recursive: true })
    const jobFile = join(job.jobDir, 'job.json')
    const output = join(job.jobDir, 'result.json')
    const payload = {
      bvid: job.view.bvid,
      page: job.view.partIndex,
      model: job.view.model,
      modelDir,
      workDir: join(job.jobDir, 'work'),
      output,
      maxMediaMinutes: job.limits.maxMediaMinutes,
      maxDownloadMb: job.limits.maxDownloadMb,
      language: 'zh'
    }
    atomicWrite(jobFile, JSON.stringify(payload))
    const script = join(this.opts.resourcesDir, 'asr_worker.py')
    this.child = (this.opts.spawnImpl ?? spawn)(python, [script, '--job', jobFile], {
      windowsHide: true,
      cwd: this.opts.paths.rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: biliChildEnv({
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1',
        HF_HOME: this.opts.paths.modelsDir,
        HF_ENDPOINT: 'https://hf-mirror.com',
        HF_HUB_DISABLE_XET: '1',
        HF_HUB_OFFLINE: '1'
      })
    })
    const child = this.child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    let stderrTail = ''
    child.stdout?.on('data', () => undefined)
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000)
    })
    this.runTimer = setTimeout(() => {
      job.timedOut = true
      killProcessTree(child.pid)
    }, Math.max(1, job.limits.maxRunMinutes) * 60_000)
    this.runTimer.unref?.()
    await new Promise<void>((resolve) => {
      child.on('error', () => resolve())
      child.on('close', () => resolve())
    })
    this.clearTimer()
    this.child = null
    this.running = null

    if (job.cancelReason !== null) {
      this.finish(
        job,
        job.cancelReason,
        job.cancelReason === 'cancelled' ? 'cancelled' : null,
        job.cancelReason === 'cancelled' ? '转写已取消。' : '应用重启导致转写中断。'
      )
      return
    }
    if (job.timedOut) {
      this.finish(job, 'failed', 'asr-limit', '转写超过运行时间上限。')
      return
    }
    const result = parseResult(output)
    if (result === null) {
      this.finish(
        job,
        'failed',
        'asr-failed',
        stderrTail.trim() === '' ? '本地转写进程没有返回结果。' : '本地转写失败。'
      )
      return
    }
    if (result.ok === true) {
      const text = typeof result.text === 'string' ? result.text.slice(0, MAX_TEXT_CHARS) : ''
      if (text.trim() === '') {
        this.finish(job, 'empty', 'asr-empty', '没有识别出可用文字。')
        return
      }
      job.text = text
      job.view.state = 'succeeded'
      job.view.finishedAt = this.now()
      job.view.chars = text.length
      job.view.durationSec =
        typeof result.durationSec === 'number' ? result.durationSec : job.view.durationSec
      this.persist()
      this.emit(job)
      this.cleanupDir(job)
      this.schedulePump()
      return
    }
    const code = asFailureCode(typeof result.code === 'string' ? result.code : 'asr-failed')
    const message =
      typeof result.message === 'string' && result.message.trim() !== ''
        ? result.message.slice(0, 160)
        : '本地转写失败。'
    this.finish(job, code === 'asr-empty' ? 'empty' : code === 'cancelled' ? 'cancelled' : 'failed', code, message)
  }

  private finish(
    job: RuntimeJob,
    state: BiliAsrState,
    code: BiliReadFailureCode | null,
    message: string
  ): void {
    if (job.view.state === state) return
    job.view.state = state
    job.view.finishedAt = this.now()
    job.view.errorCode = code
    job.view.errorMessage = code === null && state === 'interrupted' ? message : message
    this.persist()
    this.emit(job)
    this.cleanupDir(job)
    this.schedulePump()
  }

  private emit(job: RuntimeJob): void {
    try {
      this.opts.onFinished?.({ ...job.view })
    } catch {
      /* 事件回调不能影响队列 */
    }
  }

  private cleanupDir(job: RuntimeJob): void {
    try {
      rmSync(job.jobDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败不影响业务状态 */
    }
  }

  private clearTimer(): void {
    if (this.runTimer !== null) {
      clearTimeout(this.runTimer)
      this.runTimer = null
    }
  }

  // ------------------------------------------------------------------ 持久化

  private load(): void {
    let raw: PersistedState | null = null
    try {
      const parsed = JSON.parse(readFileSync(this.opts.paths.asrStateFile, 'utf8')) as Partial<PersistedState>
      if (parsed.v === 1 && Array.isArray(parsed.jobs)) {
        raw = { v: 1, jobs: parsed.jobs.filter((job): job is BiliAsrJobView => isJobView(job)) }
      }
    } catch {
      raw = null
    }
    if (raw === null) return
    const now = this.now()
    for (const view of raw.jobs.slice(-MAX_JOBS)) {
      const job: RuntimeJob = {
        view: { ...view },
        text: null,
        cancelReason: null,
        timedOut: false,
        jobDir: join(this.opts.paths.jobsDir, view.id),
        limits: {
          model: view.model,
          maxMediaMinutes: 30,
          maxDownloadMb: 300,
          maxRunMinutes: 20,
          maxCacheMb: 1024
        }
      }
      if (view.state === 'running' || view.state === 'queued') {
        job.view.state = 'interrupted'
        job.view.finishedAt = now
        job.view.errorCode = null
        job.view.errorMessage = '应用重启导致转写中断。'
      } else if (view.state === 'succeeded') {
        // 文本只在内存中；重启后不能假装还能读取。
        job.view.state = 'interrupted'
        job.view.errorMessage = '转写结果只在短期缓存中，重启后需要重新转写。'
      }
      this.jobs.set(job.view.id, job)
    }
    this.trim()
    this.persist()
  }

  private trim(): void {
    const cutoff = this.now() - KEEP_FINISHED_MS
    const ordered = [...this.jobs.values()].sort((a, b) => a.view.queuedAt - b.view.queuedAt)
    for (const job of ordered) {
      if (this.jobs.size <= MAX_JOBS) break
      if (job.view.state === 'queued' || job.view.state === 'running') continue
      if (job.view.queuedAt >= cutoff) continue
      this.jobs.delete(job.view.id)
    }
    while (this.jobs.size > MAX_JOBS) {
      const candidate = ordered.find(
        (job) => job.view.state !== 'queued' && job.view.state !== 'running'
      )
      if (candidate === undefined) break
      this.jobs.delete(candidate.view.id)
      ordered.splice(ordered.indexOf(candidate), 1)
    }
  }

  private persist(): void {
    try {
      const jobs = this.recent(MAX_JOBS)
      atomicWrite(this.opts.paths.asrStateFile, `${JSON.stringify({ v: 1, jobs } satisfies PersistedState)}\n`)
    } catch {
      this.opts.logger.warn('B 站转写状态写入失败')
    }
  }

  private cacheBytes(): number {
    return dirSize(this.opts.paths.modelsDir) + dirSize(this.opts.paths.jobsDir)
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}

export class AsrError extends Error {
  readonly code: BiliReadFailureCode
  readonly retryable: boolean

  constructor(code: BiliReadFailureCode, message: string, retryable = false) {
    super(message)
    this.name = 'AsrError'
    this.code = code
    this.retryable = retryable
  }
}

function asrKey(bvid: string, page: number, model: string): string {
  return `${bvid}:${page}:${model}`
}

function normalizeModel(value: string): string {
  return ['tiny', 'base', 'small', 'medium'].includes(value) ? value : 'small'
}

function failureForState(state: BiliAsrState): BiliReadFailureCode {
  if (state === 'empty') return 'asr-empty'
  if (state === 'cancelled') return 'cancelled'
  if (state === 'interrupted') return 'cancelled'
  if (state === 'failed') return 'asr-failed'
  return 'asr-failed'
}

function isJobView(value: unknown): value is BiliAsrJobView {
  if (value === null || typeof value !== 'object') return false
  const view = value as Partial<BiliAsrJobView>
  return (
    typeof view.id === 'string' &&
    /^[A-Za-z0-9-]{1,64}$/.test(view.id) &&
    typeof view.bvid === 'string' &&
    typeof view.partIndex === 'number' &&
    typeof view.title === 'string' &&
    typeof view.state === 'string' &&
    typeof view.queuedAt === 'number'
  )
}

function parseResult(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function asFailureCode(code: string): BiliReadFailureCode {
  return [
    'asr-not-installed',
    'asr-model-missing',
    'asr-limit',
    'asr-failed',
    'asr-empty',
    'cancelled'
  ].includes(code)
    ? (code as BiliReadFailureCode)
    : 'asr-failed'
}

function dirSize(dir: string): number {
  let total = 0
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      try {
        const info = statSync(path)
        total += info.isDirectory() ? dirSize(path) : info.size
      } catch {
        /* 文件可能在扫描时被清理 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return total
}

