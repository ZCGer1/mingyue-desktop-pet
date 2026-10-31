import type { PetActivity, PetAgentStatusView, PetSayEvent } from '../shared/ipc'
import type {
  PetBiliReportEvent,
  PetBiliReportVideoView
} from '../shared/bilibili'
import type { PetAnchor } from '../shared/dshPet/layout'
import type { ApprovalOrigin } from '../core/types'

/**
 * 气泡与状态条（PLAN.md §5.7）。
 *
 * 桌宠身体只报告「头顶在哪」（layout.bubble）和「身体占多大」（layout.box），
 * 这里负责把 DOM 气泡放到头顶上方、空间不够时换到身体下方；每 100ms 跟随一次。
 *
 * 整个 overlay 容器 pointer-events:none；状态条和气泡是 `data-agent-ui`，
 * 由 pointerRouter 让它们参与命中测试。
 */

interface BubbleState {
  text: string
  expiresAt: number
  timer: number
  /** 快捷回复流式进行中：不吃 TTL，也不能被普通 say 覆盖。 */
  sticky: boolean
  /** 主动开场对应的 ConversationEpisode；点击气泡时带进快捷输入。 */
  episodeId?: string
}

/** 审批气泡只展示请求句和打开入口，不持有任何审批决定。 */
interface ApprovalBubbleState {
  id: string
  ask: string
  origin: ApprovalOrigin
}

/** B 站本轮阅读迷你卡：只展示前几条视频，完整内容在聊天记录里。 */
interface BiliCardState {
  event: PetBiliReportEvent
  expiresAt: number
  timer: number
}

const POSITION_INTERVAL_MS = 100
const STREAM_RENDER_INTERVAL_MS = 80
const BILI_CARD_TTL_MS = 25_000
const BILI_CARD_LIMIT = 3
const VIEWPORT_MARGIN = 8
const BUBBLE_GAP = 8

/** 真实运行时动作的短标签；与模型自报无关。 */
const ACTIVITY_LABELS: Record<PetActivity, string> = {
  idle: '待机中',
  exploring: '在探索…',
  reading: '在看东西…',
  writing: '在写笔记…',
  revisiting: '在回看…',
  'wanting-talk': '想说话',
  resting: '休息中',
  degraded: '桌面观察不可用',
  'speech-quiet': '暂时安静',
  'explore-paused': '探索已暂停'
}

const TASK_STATE_LABELS: Record<string, string> = {
  queued: '排队中',
  observing: '观察中',
  planning: '计划中',
  running: '执行中',
  waiting_approval: '等审批',
  waiting_user: '等你处理',
  paused: '已暂停',
  blocked: '受阻',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

export type AnchorProvider = () => PetAnchor | null

export interface PetOverlayOptions {
  /** 点击说话气泡：按当前 `petClickAction` 打开快捷输入，并带上主动开场 id。 */
  onBubbleActivate?: (episodeId?: string) => void
  /** 点击审批气泡：打开对应来源的完整审批卡；不得在此产生审批决定。 */
  onApprovalActivate?: (origin: ApprovalOrigin) => void
  /** 点击状态条按钮；按 approvalOrigin 进入快捷或完整入口。 */
  onStatusActivate?: (status: PetAgentStatusView) => void
}

export class PetOverlay {
  private readonly anchorProvider: AnchorProvider
  private readonly options: PetOverlayOptions
  private readonly root: HTMLDivElement
  private readonly status: HTMLDivElement
  private readonly statusLabel: HTMLSpanElement
  private readonly statusRound: HTMLSpanElement
  private readonly statusButton: HTMLButtonElement

  private readonly bubble: HTMLDivElement
  private readonly bubbleAsk: HTMLSpanElement
  private readonly bubbleVideos: HTMLDivElement
  private readonly bubbleHint: HTMLSpanElement
  private say: BubbleState | null = null
  private approval: ApprovalBubbleState | null = null
  private biliCard: BiliCardState | null = null
  /** 只在卡片对象变化时重建行，避免状态广播重建正在点击的按钮。 */
  private renderedBiliCard: BiliCardState | null = null
  private statusView: PetAgentStatusView | null = null
  private positionTimer = 0
  private streamTimer = 0
  private streamPending: string | null = null
  private destroyed = false

  constructor(anchorProvider: AnchorProvider, options: PetOverlayOptions = {}) {
    this.anchorProvider = anchorProvider
    this.options = options
    this.root = document.createElement('div')
    this.root.id = 'mingyue-overlay'
    this.root.setAttribute('data-pet-overlay', '')

    this.status = document.createElement('div')
    this.status.className = 'my-status'
    this.status.setAttribute('data-agent-ui', '')
    this.status.setAttribute('role', 'status')

    this.statusLabel = document.createElement('span')
    this.statusLabel.className = 'my-status-label'
    this.statusRound = document.createElement('span')
    this.statusRound.className = 'my-status-round'
    this.statusButton = document.createElement('button')
    this.statusButton.type = 'button'
    this.statusButton.textContent = '查看'
    this.statusButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const status = this.statusView
      if (status !== null && this.options.onStatusActivate !== undefined) {
        this.options.onStatusActivate(status)
      } else {
        window.mingyue?.pet.openChat()
      }
    })

    this.status.append(this.statusLabel, this.statusRound, this.statusButton)
    this.status.hidden = true

    this.bubble = document.createElement('div')
    this.bubble.className = 'my-bubble'
    this.bubble.setAttribute('data-agent-ui', '')
    this.bubble.setAttribute('role', 'status')
    this.bubbleAsk = document.createElement('span')
    this.bubbleVideos = document.createElement('div')
    this.bubbleVideos.className = 'my-bubble-videos'
    this.bubbleVideos.hidden = true
    this.bubbleHint = document.createElement('span')
    this.bubbleHint.className = 'my-bubble-hint'
    this.bubbleHint.textContent = '点开查看详情'
    this.bubbleHint.hidden = true
    this.bubble.append(this.bubbleAsk, this.bubbleVideos, this.bubbleHint)
    this.bubble.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      // 审批气泡只负责打开完整审批卡，不在这里批准/拒绝；气泡保留到
      // 主进程广播审批结束。普通气泡仍按 petClickAction 进入短对话。
      if (this.approval !== null) {
        const origin = this.approval.origin
        if (this.options.onApprovalActivate !== undefined) {
          this.options.onApprovalActivate(origin)
        } else {
          window.mingyue?.pet.openChat()
        }
        return
      }
      // 迷你卡只有视频行可点；背景点击不打开面板，也不打开聊天窗。
      if (this.biliCard !== null) return
      // 参考 Coopanion：点气泡先收起她，再进入短对话。流式中只打开面板，
      // 不打断正在显示的文字。
      const episodeId = this.say?.episodeId
      if (this.say?.sticky !== true) this.clearSay()
      if (this.options.onBubbleActivate !== undefined) {
        this.options.onBubbleActivate(episodeId)
      } else {
        window.mingyue?.pet.openChat()
      }
    })
    this.bubble.hidden = true

    this.root.append(this.status, this.bubble)
    const host = document.getElementById('overlay-host') ?? document.body
    host.appendChild(this.root)
    this.positionTimer = window.setInterval(() => this.position(), POSITION_INTERVAL_MS)
  }

  setStatus(status: PetAgentStatusView): void {
    if (this.destroyed) return
    this.statusView = status
    // 审批状态先于 visible 早退同步：审批结束时状态可能不可见，若不在这里
    // 清掉，气泡会残留。旧的手工载荷可能缺字段，统一按 null 归一。
    const approvalId = status.approvalId ?? null
    const approvalAsk = status.approvalAsk ?? null
    const approvalOrigin = status.approvalOrigin ?? null
    const nextApproval =
      status.approvalPending &&
      approvalId !== null &&
      approvalAsk !== null &&
      approvalAsk.trim() !== '' &&
      approvalOrigin !== null
        ? { id: approvalId, ask: approvalAsk.trim(), origin: approvalOrigin }
        : null
    if (nextApproval === null) {
      if (this.approval !== null) {
        this.approval = null
        this.renderBubble()
      }
    } else if (
      this.approval === null ||
      this.approval.id !== nextApproval.id ||
      this.approval.ask !== nextApproval.ask ||
      this.approval.origin !== nextApproval.origin
    ) {
      const entering = this.approval === null
      this.approval = nextApproval
      // 审批首次出现时收起旧的定时气泡与迷你卡；流式快捷回复保留在内存里，
      // 审批结束后若未过期再显示。迷你卡不恢复，完整报告仍在聊天记录。
      if (entering) this.dropBiliCard()
      if (entering && this.say !== null && this.say.sticky !== true) {
        this.clearSay()
      } else {
        this.renderBubble()
      }
    }
    const visible =
      status.phase !== 'idle' ||
      status.busy ||
      status.paused ||
      status.approvalPending ||
      status.cuaActive ||
      status.failure !== null ||
      status.task !== null ||
      status.activity !== 'idle'
    this.status.hidden = !visible
    if (!visible) {
      this.position()
      return
    }
    const showTask = status.task !== null && !status.approvalPending && !status.cuaActive
    // 有真实活动时优先显示动作短标签（例如“在探索…”），任务标题退到右侧状态；
    // 没有活动时才回退到任务标题。这样状态条不会因为任务存在而掩盖真实动作。
    const showActivity =
      status.activity !== 'idle' && !status.approvalPending && !status.paused && !status.cuaActive
    const showIdle =
      !showTask &&
      !showActivity &&
      !status.approvalPending &&
      !status.paused &&
      !status.cuaActive &&
      !status.busy &&
      status.petPhase === 'idle'
    // 失败提示优先于普通动作/任务标签：它需要用户看到并点“诊断”。
    const showFailure = status.failure !== null && !status.approvalPending && !status.cuaActive && !status.paused
    this.statusLabel.textContent = showFailure
      ? status.label
      : showActivity
        ? ACTIVITY_LABELS[status.activity]
        : showTask
          ? `任务：${status.task?.title ?? ''}`
          : showIdle
            ? ACTIVITY_LABELS.idle
            : status.label
    const taskState = status.task === null ? '' : (TASK_STATE_LABELS[status.task.state] ?? status.task.state)
    this.statusRound.textContent = showTask
      ? taskState
      : status.busy && status.round > 0
        ? `第 ${status.round} 轮`
        : ''
    this.status.dataset['phase'] = status.phase
    this.status.dataset['activity'] = status.activity
    this.status.dataset['approval'] = status.approvalPending ? '1' : '0'
    this.status.dataset['paused'] = status.paused ? '1' : '0'
    this.statusButton.textContent = status.approvalPending
      ? '去确认'
      : status.cuaActive
        ? '停止'
        : showFailure
          ? '诊断'
          : '查看'
    this.status.dataset['cua'] = status.cuaActive ? '1' : '0'
    this.status.dataset['task'] = status.task === null ? '0' : '1'
    this.status.dataset['failure'] = status.failure === null ? '0' : '1'
    this.position()
  }

  /**
   * 显示一条气泡。返回值只表示“这条气泡是否真的进入页面显示位置”：
   * 审批、流式回复、迷你卡、销毁与空文本都必须返回 false，主进程据此
   * 决定这次主动发言是否算数。
   */
  showSay(event: PetSayEvent): boolean {
    if (this.destroyed) return false
    if (typeof event.text !== 'string' || event.text.trim() === '') return false
    // 审批气泡优先；审批期间的主动说话丢弃，避免审批结束后才冒出过期闲聊。
    if (this.approval !== null) return false
    // 主 Agent 的主动说话不能覆盖正在流式的快捷回复；结束后自然恢复。
    if (this.say?.sticky === true) return false
    // 迷你卡显示期间普通闲聊丢弃，不排队；报告本身仍在聊天记录。
    if (this.biliCard !== null) return false
    this.clearSay()
    this.say = this.makeBubble(event.text, event.ttlMs, event.episodeId)
    if (this.say === null || this.say.text === '') return false
    this.renderBubble()
    return this.bubble.hidden !== true && this.bubble.dataset['kind'] === 'say'
  }

  /**
   * B 站一轮阅读的迷你卡。审批/流式回复优先；同优先级下新报告覆盖旧报告
   * 并重置 TTL。载荷来自主进程的窄视图，这里仍做一次防御性过滤。
   */
  showBiliReport(event: PetBiliReportEvent): void {
    if (this.destroyed) return
    if (this.approval !== null || this.say?.sticky === true) return
    const videos = Array.isArray(event.videos)
      ? event.videos
          .filter(
            (video): video is PetBiliReportVideoView =>
              video !== null &&
              typeof video === 'object' &&
              typeof video.bvid === 'string' &&
              Number.isSafeInteger(video.partIndex) &&
              typeof video.title === 'string' &&
              typeof video.author === 'string' &&
              Number.isSafeInteger(video.part)
          )
          .slice(0, BILI_CARD_LIMIT)
      : []
    if (videos.length === 0) return
    const total =
      Number.isSafeInteger(event.total) && event.total >= videos.length
        ? event.total
        : videos.length
    this.dropBiliCard()
    this.clearSay()
    const card: BiliCardState = {
      event: { total, videos },
      expiresAt: performance.now() + BILI_CARD_TTL_MS,
      timer: 0
    }
    card.timer = window.setTimeout(() => {
      if (this.biliCard !== card) return
      this.biliCard = null
      this.renderedBiliCard = null
      this.renderBubble()
    }, BILI_CARD_TTL_MS)
    this.biliCard = card
    this.renderBubble()
  }

  /** 快捷回复开始：立即清掉旧气泡并进入流式状态（空文本时保持隐藏）。 */
  beginStreamingSay(): void {
    if (this.destroyed) return
    this.dropBiliCard()
    this.clearSay()
    this.say = {
      text: '',
      expiresAt: Number.POSITIVE_INFINITY,
      timer: 0,
      sticky: true
    }
    this.renderBubble()
  }

  /** 更新流式文本；DOM 最多每 80ms 刷新一次，避免逐 token 触发布局测量。 */
  updateStreamingSay(text: string): void {
    if (this.destroyed || this.say?.sticky !== true) return
    if (this.streamTimer !== 0) {
      this.streamPending = text
      return
    }
    this.applyStreamingText(text)
    this.streamTimer = window.setTimeout(() => {
      this.streamTimer = 0
      const pending = this.streamPending
      this.streamPending = null
      if (pending !== null) this.updateStreamingSay(pending)
    }, STREAM_RENDER_INTERVAL_MS)
  }

  /** 流式结束：写入最终文本并启动普通 TTL；空文本直接清掉。 */
  endStreamingSay(text: string, ttlMs: number): void {
    if (this.destroyed) return
    this.clearStreamTimer()
    if (this.say !== null && this.say.timer !== 0) window.clearTimeout(this.say.timer)
    this.say = null
    const trimmed = text.trim()
    if (trimmed !== '') this.say = this.makeBubble(trimmed, ttlMs)
    this.renderBubble()
  }

  clearSay(): void {
    this.clearStreamTimer()
    if (this.say !== null) {
      if (this.say.timer !== 0) window.clearTimeout(this.say.timer)
      this.say = null
    }
    this.renderBubble()
  }

  clearAll(): void {
    this.dropBiliCard()
    this.clearSay()
  }

  destroy(): void {
    this.destroyed = true
    window.clearInterval(this.positionTimer)
    this.clearStreamTimer()
    if (this.say !== null && this.say.timer !== 0) window.clearTimeout(this.say.timer)
    this.say = null
    this.approval = null
    this.dropBiliCard()
    this.root.remove()
  }

  // -------------------------------------------------------------------------

  private applyStreamingText(text: string): void {
    if (this.say === null || !this.say.sticky) return
    this.say.text = text.trim()
    this.renderBubble()
  }

  private clearStreamTimer(): void {
    if (this.streamTimer !== 0) {
      window.clearTimeout(this.streamTimer)
      this.streamTimer = 0
    }
    this.streamPending = null
  }

  private makeBubble(text: string, ttlMs: number, episodeId?: string): BubbleState {
    const trimmed = text.trim()
    const lifetime = Math.max(1000, Math.min(30_000, Math.round(ttlMs)))
    const timer = window.setTimeout(() => {
      this.say = null
      this.renderBubble()
    }, lifetime)
    return {
      text: trimmed,
      expiresAt: performance.now() + lifetime,
      timer,
      sticky: false,
      ...(episodeId === undefined ? {} : { episodeId })
    }
  }

  private renderBubble(): void {
    if (this.destroyed) return
    const now = performance.now()
    if (this.say !== null && this.say.expiresAt <= now) this.say = null
    if (this.biliCard !== null && this.biliCard.expiresAt <= now) this.dropBiliCard()

    // 审批优先于迷你卡与任何普通/流式 say；没有 TTL，清除只由状态广播驱动。
    if (this.approval !== null) {
      this.renderApprovalBubble()
      return
    }

    if (this.biliCard !== null) {
      this.renderBiliBubble(this.biliCard)
      return
    }

    const active = this.say
    if (active === null || active.text === '') {
      this.hideBubble()
      return
    }
    this.bubble.hidden = false
    this.bubble.dataset['kind'] = 'say'
    delete this.bubble.dataset['origin']
    this.bubbleAsk.textContent = active.text
    this.bubbleVideos.hidden = true
    this.bubbleVideos.replaceChildren()
    this.renderedBiliCard = null
    this.bubbleHint.hidden = true
    this.bubble.removeAttribute('aria-label')
    this.bubble.setAttribute('role', 'status')
    this.position()
  }

  private renderApprovalBubble(): void {
    if (this.approval === null) return
    this.bubble.hidden = false
    this.bubble.dataset['kind'] = 'approval'
    this.bubble.dataset['origin'] = this.approval.origin
    this.bubbleAsk.textContent = this.approval.ask
    this.bubbleVideos.hidden = true
    this.bubbleVideos.replaceChildren()
    this.renderedBiliCard = null
    // 迷你卡会改 hint；审批分支必须显式恢复，避免残留“点标题打开视频”。
    this.bubbleHint.textContent = '点开查看详情'
    this.bubbleHint.hidden = false
    this.bubble.setAttribute('role', 'status')
    this.bubble.setAttribute(
      'aria-label',
      `审批请求：${this.approval.ask}。点击打开审批卡`
    )
    this.position()
  }

  private renderBiliBubble(card: BiliCardState): void {
    this.bubble.hidden = false
    this.bubble.dataset['kind'] = 'bili-report'
    delete this.bubble.dataset['origin']
    this.bubbleAsk.textContent = `B 站 · 本轮阅读 · ${card.event.total} 个视频`
    this.bubbleVideos.hidden = false
    const remaining = Math.max(0, card.event.total - card.event.videos.length)
    this.bubbleHint.textContent =
      remaining > 0 ? `点标题打开视频 · 还有 ${remaining} 个在聊天记录` : '点标题在浏览器打开'
    this.bubbleHint.hidden = false
    this.bubble.setAttribute(
      'aria-label',
      `B 站本轮阅读，共 ${card.event.total} 个视频。点标题可在浏览器打开。`
    )
    this.bubble.setAttribute('role', 'group')

    if (this.renderedBiliCard !== card) {
      const rows = card.event.videos.map((video) => {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'my-bubble-video'
        row.title = video.title
        row.setAttribute(
          'aria-label',
          `${video.title}，${video.author}，第 ${video.part} P。点击在浏览器打开。`
        )
        const title = document.createElement('span')
        title.className = 'my-bubble-video-title'
        title.textContent = video.title
        const meta = document.createElement('span')
        meta.className = 'my-bubble-video-meta'
        meta.textContent = `${video.author} · 第 ${video.part} P`
        row.append(title, meta)
        row.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          void this.openBiliVideo(video, row)
        })
        return row
      })
      this.bubbleVideos.replaceChildren(...rows)
      this.renderedBiliCard = card
    }
    this.position()
  }

  private hideBubble(): void {
    // 隐藏时一并摘掉 kind/origin 与无障碍标签，避免已结束的审批/卡片仍被
    // `[data-kind=...]` 选中（元素常驻 DOM，只靠 hidden 不够）。
    this.bubble.hidden = true
    delete this.bubble.dataset['kind']
    delete this.bubble.dataset['origin']
    this.bubbleAsk.textContent = ''
    this.bubbleVideos.hidden = true
    this.bubbleVideos.replaceChildren()
    this.renderedBiliCard = null
    this.bubbleHint.hidden = true
    this.bubble.removeAttribute('aria-label')
    this.bubble.setAttribute('role', 'status')
    this.position()
  }

  private dropBiliCard(): void {
    if (this.biliCard !== null && this.biliCard.timer !== 0) {
      window.clearTimeout(this.biliCard.timer)
    }
    this.biliCard = null
    this.renderedBiliCard = null
  }

  private async openBiliVideo(
    video: PetBiliReportVideoView,
    row: HTMLButtonElement
  ): Promise<void> {
    if (row.disabled) return
    row.disabled = true
    try {
      const result = await window.mingyue.pet.openBiliVideo(video.bvid, video.partIndex)
      if (!result.ok && this.biliCard !== null) {
        this.bubbleHint.textContent = result.message ?? '打开浏览器失败。'
      }
    } catch {
      if (this.biliCard !== null) this.bubbleHint.textContent = '打开浏览器失败。'
    } finally {
      if (row.isConnected) row.disabled = false
    }
  }

  private position(): void {
    if (this.destroyed) return
    const anchor = this.anchorProvider()
    if (anchor === null) {
      this.status.style.visibility = 'hidden'
      this.bubble.style.visibility = 'hidden'
      return
    }
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight
    const bubblePoint = anchor.bubble
    const box = anchor.box

    // 气泡：优先头顶上方，空间不够就放到身体下方。
    let bubbleTop = 0
    let bubbleVisible = false
    if (!this.bubble.hidden) {
      this.bubble.style.visibility = 'visible'
      const width = this.bubble.offsetWidth
      const height = this.bubble.offsetHeight
      const center = clamp(
        bubblePoint.x,
        width / 2 + VIEWPORT_MARGIN,
        viewportW - width / 2 - VIEWPORT_MARGIN
      )
      let top = bubblePoint.y - BUBBLE_GAP - height
      let below = false
      if (top < VIEWPORT_MARGIN) {
        top = Math.min(viewportH - height - VIEWPORT_MARGIN, box.y + box.h + BUBBLE_GAP)
        below = true
      }
      bubbleTop = top
      bubbleVisible = true
      this.bubble.dataset['below'] = below ? '1' : '0'
      this.bubble.style.left = `${Math.round(center)}px`
      this.bubble.style.top = `${Math.round(top)}px`
    } else {
      this.bubble.style.visibility = 'hidden'
    }

    if (!this.status.hidden) {
      this.status.style.visibility = 'visible'
      const width = this.status.offsetWidth
      const height = this.status.offsetHeight
      const center = clamp(
        bubblePoint.x,
        width / 2 + VIEWPORT_MARGIN,
        viewportW - width / 2 - VIEWPORT_MARGIN
      )
      let top = bubbleVisible ? bubbleTop - 6 - height : bubblePoint.y - BUBBLE_GAP - height
      if (top < VIEWPORT_MARGIN) top = bubblePoint.y + BUBBLE_GAP
      top = clamp(top, VIEWPORT_MARGIN, viewportH - height - VIEWPORT_MARGIN)
      this.status.style.left = `${Math.round(center)}px`
      this.status.style.top = `${Math.round(top)}px`
    } else {
      this.status.style.visibility = 'hidden'
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}
