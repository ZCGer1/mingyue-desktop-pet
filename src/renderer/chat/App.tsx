import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import { ApprovalCard } from './approval'
import { BiliSessionReportCard } from './BiliSessionReportCard'
import { DiscoveryCard } from './DiscoveryCard'
import { Markdown } from './markdown'
import { shouldFollowAfterScroll } from './scrollFollow'
import { useChatSession, type ChatItem } from './useChatSession'

const PHASE_LABEL: Record<string, string> = {
  idle: '待机',
  delivering: '读消息',
  model: '思考中',
  tools: '调用工具',
  backoff: '等待重试',
  handoff: '整理记忆'
}

const PHASE_DOT: Record<string, string> = {
  idle: 'dot-idle',
  delivering: 'dot-busy',
  model: 'dot-busy',
  tools: 'dot-busy',
  backoff: 'dot-warn',
  handoff: 'dot-busy'
}

/**
 * 独立聊天窗。由托盘、快捷键、设置页或模型打开；关闭时主进程只隐藏窗口，
 * 因此历史和流式状态不会因为“关窗”丢失。
 */
export function App(): React.JSX.Element {
  const session = useChatSession({
    onOpen: (reason) => {
      // 只有用户主动打开才抢输入焦点；审批/AI 主动弹出不能打断用户正在做的事。
      if (reason === 'user') {
        window.requestAnimationFrame(() => inputRef.current?.focus())
      }
    }
  })
  const { items, approvals, phase, sending, error, stick, usage, setError, personaName } = session
  const nameInitial = [...personaName][0] ?? '桌'

  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** 上一次 scroll 事件的真实位置；用于区分“用户向上拖”和“内容增长”。 */
  const lastTopRef = useRef(0)

  async function send(): Promise<void> {
    const text = input
    if (text.trim() === '') return
    const ok = await session.sendText(text)
    if (ok) {
      setInput('')
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  // 布局阶段同步吸底，避免流式 delta 先画出旧位置再跳。依赖 stick 是为了让
  // 打开窗口/主动发送时的 setStick(true) 也能立刻回到最新。
  useLayoutEffect(() => {
    if (!session.stickRef.current) return
    const list = listRef.current
    if (list === null) return
    list.scrollTop = list.scrollHeight
    lastTopRef.current = list.scrollTop
  }, [items, approvals, stick, session.stickRef])

  useEffect(() => {
    if (error === null) return
    const timer = window.setTimeout(() => setError(null), 7000)
    return () => window.clearTimeout(timer)
  }, [error, setError])

  const phaseLabel = phase === null ? '连接中' : PHASE_LABEL[phase.phase] ?? phase.phase
  const busy = phase?.busy === true
  const paused = phase?.paused === true
  const approvalPending = approvals.length > 0 || phase?.approvalPending === true

  return (
    <div className="chat-shell" data-chat-window="">
      <header className="titlebar">
        <div className="title-group">
          <span className={`status-dot ${phase === null ? 'dot-idle' : PHASE_DOT[phase.phase] ?? 'dot-idle'}`} />
          <div>
            <h1>{personaName}</h1>
            <p className="title-sub">
              {paused ? '对话已暂停' : phaseLabel}
              {phase !== null && phase.round > 0 && !busy ? ` · 第 ${phase.round} 轮` : ''}
              {!session.petRunning ? ' · 桌宠离线' : ''}
            </p>
          </div>
        </div>
        <div className="title-actions">
          {session.undoCount > 0 && (
            <button
              type="button"
              className="icon-btn"
              title="撤销最近一次文件改动"
              onClick={() => void session.undo()}
            >
              ↶
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title={paused ? '继续对话' : '暂停对话'}
            onClick={() => void session.togglePause()}
          >
            {paused ? '▶' : 'Ⅱ'}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="清空聊天"
            onClick={() => void session.clearConversation()}
          >
            ⌫
          </button>
          <button
            type="button"
            className="icon-btn"
            title="设置"
            onClick={() => void window.mingyue.chat.openSettings()}
          >
            ⚙
          </button>
          <button type="button" className="icon-btn" title="收起" onClick={() => window.mingyue.chat.hideWindow()}>
            ×
          </button>
        </div>
      </header>

      {!session.hasKey && (
        <div className="banner banner-warn">
          还没有配置 DeepSeek API Key。纯桌宠模式可用，但暂时不能聊天。
          <button type="button" className="link-btn" onClick={() => void window.mingyue.chat.openSettings()}>
            去设置
          </button>
        </div>
      )}

      {paused && (
        <div className="banner">
          总线已暂停，新消息会排队而不是立刻处理。
          <button type="button" className="link-btn" onClick={() => void session.togglePause()}>
            继续对话
          </button>
        </div>
      )}

      <div
        className="message-list"
        ref={listRef}
        onScroll={(event) => {
          const element = event.currentTarget
          const scrollTop = element.scrollTop
          const distance = Math.max(
            0,
            element.scrollHeight - scrollTop - element.clientHeight
          )
          session.setStick(
            shouldFollowAfterScroll({
              previousScrollTop: lastTopRef.current,
              scrollTop,
              distanceToBottom: distance
            })
          )
          lastTopRef.current = scrollTop
        }}
      >
        {items.length === 0 && approvals.length === 0 && (
          <div className="empty-state">
            <div className="empty-mark">🐋</div>
            <h2>{personaName}在这里</h2>
            <p>可以聊代码、文件、网页，也可以只是说说话。</p>
            <ul>
              <li>高风险操作（工作区外写入、任意终端命令等）会先问你。</li>
              <li>她不会操作鼠标键盘、切窗口、截屏或读剪贴板。</li>
              <li>记忆和聊天内容都可以在设置里查看、编辑、清除。</li>
            </ul>
          </div>
        )}

        {items.map((item) => {
          switch (item.kind) {
            case 'user':
              return (
                <div className="msg msg-user" key={item.id}>
                  <div className="msg-content">{item.text}</div>
                </div>
              )
            case 'assistant':
              return <AssistantMessage item={item} nameInitial={nameInitial} key={item.id} />
            case 'tool':
              return <ToolCard item={item} key={item.id} />
            case 'terminal':
              return (
                <div className="terminal-card" key={item.id}>
                  <div className="terminal-head">
                    <span>终端</span>
                    {item.cwd !== null && <span className="terminal-cwd">{item.cwd}</span>}
                  </div>
                  {item.command !== '' && <pre className="terminal-command">$ {item.command}</pre>}
                  {item.text !== '' && <pre className="terminal-output">{item.text}</pre>}
                </div>
              )
            case 'note':
              return (
                <div className={`note note-${item.tone}`} key={item.id}>
                  <span className="note-text">{item.text}</span>
                  {item.failure !== undefined && (
                    <button
                      type="button"
                      className="note-action"
                      onClick={() => void window.mingyue.chat.openDiagnostics()}
                    >
                      查看诊断
                    </button>
                  )}
                </div>
              )
            case 'discovery':
              return <DiscoveryCard card={item.card} key={item.id} />
            case 'bili-report':
              return <BiliSessionReportCard report={item.report} key={item.id} />
          }
        })}

        {approvals.map((request) => (
          <ApprovalCard key={request.id} request={request} />
        ))}

        {busy && (
          <div className="thinking-row">
            <span className="thinking-dots">
              <i />
              <i />
              <i />
            </span>
            <span>{phaseLabel}…</span>
            {phase !== null && phase.running.length > 0 && (
              <span className="running-tools">{phase.running.join(' · ')}</span>
            )}
          </div>
        )}
      </div>

      {!stick && (
        <button
          type="button"
          className="jump-bottom"
          onClick={() => {
            session.setStick(true)
            const list = listRef.current
            if (list !== null) list.scrollTop = list.scrollHeight
          }}
        >
          ↓ 回到最新
        </button>
      )}

      {error !== null && <div className="toast-error">{error}</div>}

      <footer className="composer">
        <div className="status-line">
          <span className={`status-dot ${phase === null ? 'dot-idle' : PHASE_DOT[phase.phase] ?? 'dot-idle'}`} />
          <span>{approvalPending ? '等你确认' : paused ? '已暂停' : phaseLabel}</span>
          {phase !== null && phase.queue > 0 && <span>队列 {phase.queue}</span>}
          {usage !== null && <span>{usage.total.toLocaleString()} tokens</span>}
          {session.version !== '' && <span className="status-version">v{session.version}</span>}
          {busy && (
            <button type="button" className="stop-btn" onClick={() => void session.stop()}>
              停止
            </button>
          )}
        </div>
        <div className="input-row">
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            placeholder={
              session.hasKey ? `和${personaName}说点什么…（Enter 发送，Shift+Enter 换行）` : '先配置 API Key 才能聊天'
            }
            onChange={(event) => setInput(event.target.value.slice(0, 32_000))}
            onKeyDown={onKeyDown}
            aria-label="消息"
          />
          <button
            type="button"
            className="send-btn"
            disabled={input.trim() === '' || sending || paused}
            onClick={() => void send()}
            title="发送"
          >
            ↑
          </button>
        </div>
        <p className="composer-note">
          高风险操作会先询问；常规操作按设置里的权限模式执行。她不会操作你的电脑。
        </p>
      </footer>
    </div>
  )
}

const AssistantMessage = memo(function AssistantMessage({
  item,
  nameInitial
}: {
  item: Extract<ChatItem, { kind: 'assistant' }>
  nameInitial: string
}): React.JSX.Element | null {
  if (!item.streaming && item.text.trim() === '' && item.reasoning.trim() === '') return null
  return (
    <div className="msg msg-assistant">
      <div className="assistant-avatar">{nameInitial}</div>
      <div className="assistant-body">
        {item.reasoning.trim() !== '' && (
          <details className="reasoning">
            <summary>思考过程</summary>
            <pre>{item.reasoning}</pre>
          </details>
        )}
        {item.text.trim() === '' && item.streaming ? (
          <p className="assistant-placeholder">正在组织语言…</p>
        ) : (
          <Markdown text={item.text} />
        )}
        {item.streaming && <span className="caret" />}
        {item.aborted && <p className="aborted-note">（已中止）</p>}
      </div>
    </div>
  )
})

const ToolCard = memo(function ToolCard({
  item
}: {
  item: Extract<ChatItem, { kind: 'tool' }>
}): React.JSX.Element {
  const args = prettyJson(item.args)
  return (
    <details className={`tool-card ${item.failed ? 'tool-failed' : ''}`} open={!item.done}>
      <summary>
        <span className="tool-icon">{item.done ? (item.failed ? '!' : '✓') : '⚙'}</span>
        <span className="tool-name">{item.name}</span>
        <span className="tool-state">{item.done ? (item.failed ? '失败' : '完成') : '运行中'}</span>
      </summary>
      <div className="tool-body">
        {args !== '' && (
          <>
            <div className="tool-label">参数</div>
            <pre className="tool-pre">{args}</pre>
          </>
        )}
        {item.result !== null && (
          <>
            <div className="tool-label">结果</div>
            <pre className="tool-pre tool-result">{item.result === '' ? '（空）' : item.result}</pre>
          </>
        )}
      </div>
    </details>
  )
})

function prettyJson(raw: string): string {
  if (raw.trim() === '') return ''
  try {
    return JSON.stringify(JSON.parse(raw) as unknown, null, 2)
  } catch {
    return raw
  }
}
