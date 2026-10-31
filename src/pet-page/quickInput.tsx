import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ApprovalRequest, ApprovalScope } from '../core/types'
import type { TaskState, TaskView } from '../core/taskTypes'
import type { QuickInputConfig } from '../shared/config'
import type { DiscoveryCardView } from '../shared/discovery'
import type { PetFeedbackKind } from '../shared/ipc'
import type { PetAnchor } from '../shared/dshPet/layout'
import { computeAnchorPosition } from './anchorPosition'
import { DiscoveryCard } from '../renderer/chat/DiscoveryCard'

/**
 * 点击桌宠后出现的快捷输入。
 *
 * 它只连 `window.mingyue.quick`：独立于完整聊天的主会话，但通过共享
 * ToolExecutor 使用同一套风险分级与审批。她的回复显示在头顶气泡
 * （PetOverlay），这里显示工具状态与内联审批卡。
 */

type CloseReason = 'user' | 'blur' | 'open-chat' | 'config'

export interface QuickInputOptions {
  config: QuickInputConfig
  getAnchor: () => PetAnchor | null
  onOpen: (reason: string) => void
  onClose: () => void
}

const POSITION_INTERVAL_MS = 100
const BLUR_CLOSE_DELAY_MS = 150
const MAX_INPUT_CHARS = 32_000
const NOTICE_TTL_MS = 5000
const ERROR_TTL_MS = 8000

type QuickPhase = 'idle' | 'thinking' | 'tool' | 'waiting' | 'speaking'

const RISK_LABEL: Record<string, string> = {
  low: '低风险',
  medium: '需留意',
  high: '高风险'
}

const TASK_STATE_LABELS: Record<TaskState, string> = {
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

const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'cancelled'])

const TOOL_LABEL: Record<string, string> = {
  ws_list: '查看目录',
  ws_read: '读取文件',
  ws_write: '写入文件',
  ws_mkdir: '新建目录',
  ws_move: '移动文件',
  ws_delete: '删除文件',
  term_run: '运行命令',
  sys_open: '打开应用',
  sys_media: '控制媒体',
  sys_volume: '调整音量',
  sys_lock: '锁屏',
  web_fetch: '联网查询',
  page_current: '读取网页',
  mem_search: '查找记忆',
  mem_read: '读取记忆',
  mem_write: '写入记忆',
  timer_set: '设置提醒',
  cua_screenshot: '看屏幕',
  cua_zoom: '放大屏幕',
  cua_click: '点击',
  cua_scroll: '滚动',
  cua_drag: '拖拽',
  cua_type: '输入文字',
  cua_key: '按键',
  cua_wait: '等待界面',
  cua_stop: '结束电脑操作'
}

function isCuaTool(name: string | null): boolean {
  return name !== null && name.startsWith('cua_')
}

function toolLabel(name: string | null): string {
  if (name === null || name === '') return '工具'
  return TOOL_LABEL[name] ?? name
}

function sessionScopeText(request: ApprovalRequest): string {
  const label = request.sessionScopeLabel
  if (label === undefined) return '本会话允许'
  return label.endsWith('内') ? `${label}允许` : label
}

export class QuickInput {
  private readonly options: QuickInputOptions
  private readonly element: HTMLDivElement
  private readonly root: Root
  private readonly unsubscribers: Array<() => void> = []
  private positionTimer = 0
  private blurTimer = 0
  private openState = false
  private openReason = 'user'
  private openEpisodeId: string | undefined
  private openToken = 0
  private destroyed = false

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.options.config.closeOnEscape) return
    if (!this.openState) return
    event.preventDefault()
    event.stopPropagation()
    this.close('user')
  }

  private readonly onWindowBlur = (): void => {
    if (!this.openState) return
    if (this.blurTimer !== 0) window.clearTimeout(this.blurTimer)
    this.blurTimer = window.setTimeout(() => {
      this.blurTimer = 0
      if (this.destroyed || !this.openState) return
      // 失焦只收起面板，不结束快捷上下文、也不生成摘要。
      if (!document.hasFocus()) this.close('blur')
    }, BLUR_CLOSE_DELAY_MS)
  }

  private readonly onResize = (): void => {
    this.reposition()
  }

  constructor(options: QuickInputOptions) {
    this.options = options
    this.element = document.createElement('div')
    this.element.id = 'mingyue-quick-input'
    this.element.className = 'quick-input-host'
    this.element.setAttribute('data-agent-ui', '')
    this.element.setAttribute('data-quick-input', '')
    this.element.hidden = true
    this.element.style.setProperty('--quick-input-w', `${options.config.width}px`)
    this.element.style.width = `${options.config.width}px`
    const host = document.getElementById('chat-host') ?? document.body
    host.appendChild(this.element)

    this.root = createRoot(this.element)
    this.render()

    // 完整聊天主动打开时收起快捷面板；上下文由服务端按显式结束/idle 管理。
    this.unsubscribers.push(window.mingyue.chat.onOpen(() => this.close('open-chat')))

    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('blur', this.onWindowBlur)
    window.addEventListener('resize', this.onResize)
    this.positionTimer = window.setInterval(() => this.reposition(), POSITION_INTERVAL_MS)
  }

  get isOpen(): boolean {
    return this.openState
  }

  open(reason = 'user', episodeId?: string): void {
    if (this.destroyed || !this.options.config.enabled) return
    const wasOpen = this.openState
    this.openState = true
    this.openReason = reason
    this.openEpisodeId = episodeId
    this.openToken += 1
    this.element.hidden = false
    this.render()
    // 用户主动打开才让桌宠窗口获得键盘焦点；AI/审批触发的展开不打断用户。
    window.mingyue.pet.setPanelOpen({ open: true, focus: reason === 'user' })
    window.requestAnimationFrame(() => this.reposition())
    if (!wasOpen) this.options.onOpen(reason)
  }

  /**
   * 面板已经打开时，只把新的主动开场 id 接到当前输入上。
   * 不改焦点、不重置草稿，也不把窗口带到前台。
   */
  attachEpisode(episodeId: string): void {
    if (this.destroyed || !this.openState) return
    this.openEpisodeId = episodeId
    this.openToken += 1
    this.render()
  }

  close(reason: CloseReason = 'user'): void {
    if (this.destroyed || !this.openState) return
    // ×/Esc 只隐藏视图；旧 quick.end IPC 兼容映射为 hideView。
    if (reason === 'user') {
      void window.mingyue.quick.end().catch(() => undefined)
    }
    this.openState = false
    if (this.blurTimer !== 0) {
      window.clearTimeout(this.blurTimer)
      this.blurTimer = 0
    }
    this.element.hidden = true
    this.render()
    window.mingyue.pet.setPanelOpen({ open: false })
    this.options.onClose()
  }

  toggle(): void {
    if (this.openState) this.close('user')
    else this.open()
  }

  /** 设置保存后热更新宽度/开关；关闭快捷输入时立即收起，但不结束上下文。 */
  setConfig(config: QuickInputConfig): void {
    if (this.destroyed) return
    this.options.config = config
    if (!config.enabled) {
      this.close('config')
    } else {
      this.element.style.setProperty('--quick-input-w', `${config.width}px`)
      this.element.style.width = `${config.width}px`
      this.render()
      this.reposition()
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.openState = false
    window.clearInterval(this.positionTimer)
    window.clearTimeout(this.blurTimer)
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('blur', this.onWindowBlur)
    window.removeEventListener('resize', this.onResize)
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch {
        /* ignore */
      }
    }
    this.root.unmount()
    this.element.remove()
  }

  // -------------------------------------------------------------------------

  private render(): void {
    this.root.render(
      <QuickInputView
        visible={this.openState}
        reason={this.openReason}
        token={this.openToken}
        episodeId={this.openEpisodeId}
        onClose={() => this.close('user')}
      />
    )
  }

  private reposition(): void {
    if (this.destroyed || !this.openState) return
    const width = this.options.config.width
    const rect = this.element.getBoundingClientRect()
    const height = rect.height > 0 ? rect.height : 156
    const position = computeAnchorPosition(
      this.options.getAnchor(),
      { width, height },
      { width: window.innerWidth, height: window.innerHeight }
    )
    this.element.style.width = `${width}px`
    this.element.style.left = `${position.left}px`
    this.element.style.top = `${position.top}px`
  }
}

function QuickInputView({
  visible,
  reason,
  token,
  episodeId,
  onClose
}: {
  visible: boolean
  reason: string
  token: number
  episodeId?: string
  onClose: () => void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [phase, setPhase] = useState<QuickPhase>('idle')
  const [toolName, setToolName] = useState<string | null>(null)
  const [cuaActive, setCuaActive] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null)
  const [task, setTask] = useState<TaskView | null>(null)
  const [hasKey, setHasKey] = useState(true)
  const [personaName, setPersonaName] = useState('她')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [feedbackBusy, setFeedbackBusy] = useState(false)
  // 这次快捷回复要衔接的主动开场；只保存不透明 id，不保存任何摘要。
  const [activeEpisodeId, setActiveEpisodeId] = useState<string | undefined>(episodeId)
  // 回应主动分享后由主进程返回的发现卡片；只在当前这次回复里显示。
  const [discoveryCard, setDiscoveryCard] = useState<DiscoveryCardView | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 只用于丢弃过期/重复的快捷事件；与头顶气泡的 director 状态各自独立。
  const turnRef = useRef<{ id: string | null; seq: number }>({ id: null, seq: -1 })

  // 任务事件与快捷对话事件互不干扰；只展示进行中的任务，结束态自动消失。
  useEffect(() => {
    return window.mingyue.pet.onTaskChanged((tasks) => {
      setTask(tasks.find((item) => !TERMINAL_TASK_STATES.has(item.state)) ?? null)
    })
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void window.mingyue.pet
      .currentTask()
      .then((current) => {
        if (!cancelled) setTask(current)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [visible, token])

  useEffect(() => {
    return window.mingyue.quick.onEvent((event) => {
      switch (event.type) {
        case 'start':
          turnRef.current = { id: event.id, seq: -1 }
          setBusy(true)
          setSpeaking(false)
          setPhase('thinking')
          setToolName(null)
          setCuaActive(false)
          setPendingApproval(null)
          setError(null)
          setNotice(null)
          return
        case 'delta': {
          const turn = turnRef.current
          if (event.id !== turn.id || event.seq <= turn.seq) return
          turnRef.current = { id: event.id, seq: event.seq }
          setBusy(true)
          setSpeaking(event.text.trim() !== '')
          setPhase('speaking')
          return
        }
        case 'phase':
          if (event.phase === 'waiting') setBusy(true)
          setPhase(event.phase)
          if (event.tool !== undefined) setToolName(event.tool)
          else if (event.phase === 'thinking' || event.phase === 'speaking') setToolName(null)
          if (event.cua !== undefined) setCuaActive(event.cua)
          return
        case 'tool':
          if (event.state === 'start') {
            setToolName(event.name)
            setCuaActive(isCuaTool(event.name))
            setPhase('tool')
          } else {
            setToolName((current) => (current === event.name ? null : current))
            setCuaActive(false)
            setPhase((current) => (current === 'tool' ? 'thinking' : current))
          }
          return
        case 'approval':
          setPendingApproval(event.approval)
          setToolName(event.approval.toolName)
          setCuaActive(isCuaTool(event.approval.toolName))
          setPhase('waiting')
          setBusy(true)
          setSpeaking(false)
          setError(null)
          return
        case 'approval-cleared':
          setPendingApproval((current) =>
            current !== null && current.id === event.approvalId ? null : current
          )
          setPhase((current) => (current === 'waiting' ? 'thinking' : current))
          return
        case 'notice':
          setNotice(event.text)
          return
        case 'done':
          if (turnRef.current.id !== null && event.id !== turnRef.current.id) return
          turnRef.current = { id: event.id, seq: event.seq }
          setBusy(false)
          setSpeaking(false)
          setPhase('idle')
          setToolName(null)
          setCuaActive(false)
          setPendingApproval(null)
          setNotice(event.aborted ? '已停下' : event.truncated ? '先说到这儿' : null)
          return
        case 'error':
          if (turnRef.current.id !== null && event.id !== turnRef.current.id) return
          turnRef.current = { id: event.id, seq: event.seq ?? turnRef.current.seq }
          setBusy(false)
          setSpeaking(false)
          setPhase('idle')
          setToolName(null)
          setCuaActive(false)
          setPendingApproval(null)
          setNotice(null)
          setError(event.message)
          return
        case 'ended':
          setBusy(false)
          setSpeaking(false)
          setPhase('idle')
          setToolName(null)
          setCuaActive(false)
          setPendingApproval(null)
          return
        case 'reset':
          turnRef.current = { id: null, seq: -1 }
          setBusy(false)
          setSpeaking(false)
          setPhase('idle')
          setToolName(null)
          setCuaActive(false)
          setPendingApproval(null)
          setError(null)
          setNotice(null)
          setInput('')
          return
      }
    })
  }, [])

  // 打开时对齐主进程状态（流式续接、API Key、人格名、上次错误）。
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void window.mingyue.quick
      .bootstrap()
      .then((snapshot) => {
        if (cancelled) return
        setHasKey(snapshot.hasKey)
        setPersonaName(snapshot.personaName)
        setPendingApproval(snapshot.pendingApproval)
        setToolName(snapshot.toolName)
        setCuaActive(snapshot.cuaActive)
        // 没有点气泡直接打开面板时，也从主进程接上仍未被回应的开场。
        if (snapshot.episodeId !== null) {
          setActiveEpisodeId((current) => current ?? snapshot.episodeId ?? undefined)
        }
        const turn = turnRef.current
        if (snapshot.phase === 'streaming' && snapshot.turnId !== null) {
          // 已经有更新的本地 turn 时忽略较旧快照。
          if (turn.id !== null && turn.id !== snapshot.turnId) return
          if (snapshot.seq > turn.seq) {
            turnRef.current = { id: snapshot.turnId, seq: snapshot.seq }
          }
          setBusy(true)
          setSpeaking(snapshot.text.trim() !== '')
          setPhase(
            snapshot.pendingApproval !== null
              ? 'waiting'
              : snapshot.toolName !== null
                ? 'tool'
                : 'thinking'
          )
        } else if (turn.id === null) {
          setBusy(false)
          setSpeaking(false)
          setPhase('idle')
          setError(snapshot.lastError)
        }
      })
      .catch(() => undefined)
    if (reason === 'user') {
      window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    }
    // token 每次打开都会变化，保证重新打开时也刷新一次状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reason, token])

  // 每次打开/重新打开面板都从 prop 重置衔接 id；发送成功后单独清空，
  // 让同一段快捷上下文里后续消息不再重复挂同一开场。
  useEffect(() => {
    setActiveEpisodeId(episodeId)
    setDiscoveryCard(null)
  }, [visible, token, episodeId])

  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_TTL_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (error === null) return
    const timer = window.setTimeout(() => setError(null), ERROR_TTL_MS)
    return () => window.clearTimeout(timer)
  }, [error])

  async function send(): Promise<void> {
    const text = input
    if (text.trim() === '' || busy || submitting || !hasKey) return
    setSubmitting(true)
    setDiscoveryCard(null)
    try {
      const result = await window.mingyue.quick.send(text, activeEpisodeId)
      if (result.ok) {
        setInput('')
        setActiveEpisodeId(undefined)
        setDiscoveryCard(result.discovery ?? null)
        setError(null)
        setNotice(null)
        setBusy(true)
        setSpeaking(false)
        setPhase('thinking')
        setToolName(null)
        setCuaActive(false)
        setPendingApproval(null)
        window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
      } else {
        setError(result.error ?? '发送失败。')
      }
    } catch {
      setError('发送失败，再试一次吧。')
    } finally {
      setSubmitting(false)
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  async function sendFeedback(kind: PetFeedbackKind): Promise<void> {
    if (feedbackBusy) return
    setFeedbackBusy(true)
    try {
      const result = await window.mingyue.quick.feedback(kind, activeEpisodeId)
      if (result.ok) {
        setNotice(result.message ?? null)
        setError(null)
        if (kind !== 'quiet') setActiveEpisodeId(undefined)
      } else {
        setError(result.message ?? '暂时不能调整。')
      }
    } catch {
      setError('暂时不能调整。')
    } finally {
      setFeedbackBusy(false)
    }
  }

  function startNewConversation(): void {
    if (!window.confirm('新对话会清空气泡与完整聊天中的当前话题。继续吗？')) return
    setActiveEpisodeId(undefined)
    setDiscoveryCard(null)
    setError(null)
    setNotice(null)
    setBusy(false)
    setSpeaking(false)
    setPhase('idle')
    setToolName(null)
    setCuaActive(false)
    setPendingApproval(null)
    turnRef.current = { id: null, seq: -1 }
    // reset 事件会清空气泡；失败时本地回到待机，等下一次 bootstrap 再对齐。
    void window.mingyue.quick.reset(true).catch(() => undefined)
  }

  async function expandChat(): Promise<void> {
    // 先显式结束这段快捷上下文，再打开完整聊天。
    try {
      await window.mingyue.quick.end()
    } catch {
      /* 主进程不可用时仍然尝试打开聊天 */
    }
    window.mingyue.pet.openChat()
  }

  const waiting = pendingApproval !== null || phase === 'waiting'
  const toolBusy = busy && pendingApproval === null && phase === 'tool'
  const statusDetail = toolBusy
    ? cuaActive || isCuaTool(toolName)
      ? toolName === 'cua_screenshot' || toolName === 'cua_zoom'
        ? '正在看屏幕…'
        : '正在操作…'
      : `正在使用${toolLabel(toolName)}…`
    : speaking
      ? '正在说…'
      : '思考中…'
  const statusText = waiting
    ? '等你确认'
    : toolBusy
      ? statusDetail
      : busy
        ? speaking
          ? '正在说…'
          : '思考中…'
        : '待机'
  const bodyVisible =
    !hasKey ||
    busy ||
    notice !== null ||
    (error !== null && hasKey) ||
    pendingApproval !== null ||
    task !== null ||
    discoveryCard !== null

  return (
    <div className="quick-input" data-agent-ui="" data-quick-input="">
      <header className="qi-head">
        <span className={`status-dot ${busy ? 'dot-busy' : 'dot-idle'}`} />
        <span className="qi-phase">{statusText}</span>
        <button
          type="button"
          className="qi-icon"
          title="新对话"
          aria-label="新对话"
          onClick={startNewConversation}
        >
          ↺
        </button>
        <button
          type="button"
          className="qi-icon"
          title="展开完整聊天"
          aria-label="展开完整聊天"
          onClick={() => void expandChat()}
        >
          ⤢
        </button>
        <button type="button" className="qi-icon" title="收起" aria-label="收起" onClick={onClose}>
          ×
        </button>
      </header>

      {activeEpisodeId !== undefined && pendingApproval === null && !busy && (
        <div className="qi-feedback" role="group" aria-label="刚才的话题">
          <span className="qi-feedback-label">刚才的话题</span>
          <button
            type="button"
            className="qi-feedback-btn"
            disabled={feedbackBusy}
            onClick={() => void sendFeedback('more')}
          >
            继续这个话题
          </button>
          <button
            type="button"
            className="qi-feedback-btn"
            disabled={feedbackBusy}
            onClick={() => void sendFeedback('stop')}
          >
            换个话题
          </button>
          <button
            type="button"
            className="qi-feedback-btn"
            disabled={feedbackBusy}
            onClick={() => void sendFeedback('quiet')}
          >
            安静一会
          </button>
        </div>
      )}

      {bodyVisible && (
        <div className="qi-body">
          {!hasKey && (
            <div className="qi-hint">
              <span>还没有配置 API Key。</span>
              <button
                type="button"
                className="qi-link"
                onClick={() => window.mingyue.pet.openSettings()}
              >
                去设置
              </button>
            </div>
          )}

          {busy && pendingApproval === null && (
            <div className="qi-status">
              <span className="thinking-dots">
                <i />
                <i />
                <i />
              </span>
              <span>{statusDetail}</span>
            </div>
          )}

          {task !== null && pendingApproval === null && (
            <div className="qi-task">
              <div className="qi-task-main">
                <span className="qi-task-title">任务：{task.title}</span>
                <span className="qi-task-state">
                  {TASK_STATE_LABELS[task.state]}
                  {task.checkpoint === null ? '' : ` · ${task.checkpoint}`}
                </span>
              </div>
              <button
                type="button"
                className="qi-link"
                title="停止当前任务并释放鼠标/键盘"
                onClick={() => window.mingyue.pet.stopCua()}
              >
                停止
              </button>
            </div>
          )}

          {pendingApproval !== null && (
            <QuickApprovalCard
              request={pendingApproval}
              onResolved={(approved) => {
                setPendingApproval(null)
                setPhase('thinking')
                setNotice(approved ? '已允许。' : '已拒绝。')
              }}
            />
          )}

          {discoveryCard !== null && pendingApproval === null && (
            <DiscoveryCard card={discoveryCard} compact />
          )}

          {notice !== null && pendingApproval === null && (
            <div className="qi-status">{notice}</div>
          )}

          {error !== null && hasKey && <div className="qi-error">{error}</div>}
        </div>
      )}

      <div className="input-row qi-composer">
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          placeholder={hasKey ? `和${personaName}说点什么…（Enter 发送）` : '先配置 API Key'}
          onChange={(event) => setInput(event.target.value.slice(0, MAX_INPUT_CHARS))}
          onKeyDown={onKeyDown}
          aria-label="快捷消息"
        />
        {busy ? (
          <button
            type="button"
            className="send-btn send-stop"
            onClick={() => void window.mingyue.quick.stop()}
            title="停止"
            aria-label="停止"
          >
            ■
          </button>
        ) : (
          <button
            type="button"
            className="send-btn"
            disabled={input.trim() === '' || submitting || !hasKey}
            onClick={() => void send()}
            title="发送"
            aria-label="发送"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  )
}

/** 快捷面板内联审批：只把摘要/预览渲染成等宽文本，不做 Markdown。 */
function QuickApprovalCard({
  request,
  onResolved
}: {
  request: ApprovalRequest
  onResolved: (approved: boolean) => void
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const remaining = Math.max(0, request.expiresAt - now)
  const minutes = Math.floor(remaining / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1000)
  const preview = request.preview
  const body =
    preview.kind === 'command'
      ? preview.command ?? preview.body
      : preview.kind === 'diff'
        ? preview.diff ?? preview.body
        : preview.body

  async function resolve(approved: boolean, scope: ApprovalScope): Promise<void> {
    if (busy || remaining === 0) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.mingyue.quick.resolveApproval(
        request.id,
        approved,
        approved ? scope : 'once'
      )
      if (!result.ok) setError(result.message ?? '审批提交失败。')
      else onResolved(approved)
    } catch {
      setError('审批提交失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className={`approval-card qi-approval risk-${request.risk}`}>
      <header className="approval-head">
        <div>
          <span className={`risk-badge risk-${request.risk}`}>
            {RISK_LABEL[request.risk] ?? '需确认'}
          </span>
          <span className="approval-tool">{request.toolName}</span>
        </div>
        <span className="approval-expiry">
          {remaining === 0 ? '已超时' : `${minutes}:${String(seconds).padStart(2, '0')} 后失效`}
        </span>
      </header>

      {request.approvalAsk !== undefined && request.approvalAsk.trim() !== '' && (
        <p className="approval-ask" role="note">
          {request.approvalAsk}
        </p>
      )}

      <h3 className="approval-title">{preview.title}</h3>
      <p className="approval-summary">{request.summary}</p>

      {body !== undefined && body !== '' && (
        <div className="approval-preview qi-approval-preview">
          {preview.path !== undefined && <div className="approval-path">{preview.path}</div>}
          {preview.kind === 'command' && preview.cwd !== undefined && (
            <div className="approval-cwd">工作目录：{preview.cwd}</div>
          )}
          <pre
            className={`qi-approval-pre${preview.kind === 'command' ? ' qi-approval-command' : ''}`}
          >
            {body}
          </pre>
        </div>
      )}

      {error !== null && <p className="approval-error">{error}</p>}

      <footer className="approval-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy || remaining === 0}
          onClick={() => void resolve(false, 'once')}
        >
          拒绝
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || remaining === 0}
          onClick={() => void resolve(true, 'once')}
        >
          {busy ? '提交中…' : '仅本次'}
        </button>
        {request.sessionScoped && (
          <button
            type="button"
            className="btn btn-primary"
            title={request.grantLabel}
            disabled={busy || remaining === 0}
            onClick={() => void resolve(true, 'session')}
          >
            {sessionScopeText(request)}
          </button>
        )}
        {request.alwaysScoped && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || remaining === 0}
            onClick={() => void resolve(true, 'always')}
          >
            始终允许此类
          </button>
        )}
      </footer>
    </article>
  )
}
