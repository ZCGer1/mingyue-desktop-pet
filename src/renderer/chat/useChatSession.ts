import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatApprovalClearedEvent,
  ChatApprovalEvent,
  ChatBootstrap,
  ChatTapEvent,
  ChatTerminalEvent,
  ChatUserMessageEvent,
  ChatWebEvent,
  TurnFailureView,
  UiPhaseSnapshot
} from '../../shared/ipc'
import { turnFailureNote } from '../../shared/turnFailureText'
import type { DiscoveryCardView } from '../../shared/discovery'
import type { BiliSessionReportView } from '../../shared/bilibili'
import type { ApprovalRequest, Usage } from '../../core/types'
import { mergeApprovals } from './approvalMerge'

/**
 * 完整聊天窗与桌宠快捷输入共享的会话状态。
 *
 * 两边都从主进程拿同一份 bootstrap / 事件流，因此历史、流式文本、审批与
 * 暂停状态始终一致。UI 只负责布局与输入框。
 */

let sequence = 0
const nextId = (): string => `m${Date.now().toString(36)}-${(sequence++).toString(36)}`

const MAX_ITEMS = 320
const MAX_TEXT = 200_000

export type ChatItem =
  | {
      kind: 'user'
      id: string
      text: string
      at: number
    }
  | {
      kind: 'assistant'
      id: string
      text: string
      reasoning: string
      streaming: boolean
      aborted: boolean
      /** 仅 bootstrap 恢复的历史项带时间；流式项没有。 */
      at?: number
    }
  | {
      kind: 'tool'
      id: string
      callId: string
      name: string
      args: string
      result: string | null
      failed: boolean
      done: boolean
    }
  | {
      kind: 'terminal'
      id: string
      command: string
      cwd: string | null
      text: string
    }
  | {
      kind: 'note'
      id: string
      tone: 'info' | 'warn' | 'error' | 'web'
      text: string
      /** 结构化失败；note 右侧显示“查看诊断”。 */
      failure?: TurnFailureView
    }
  | {
      kind: 'discovery'
      id: string
      /** 已保存的发现；只在用户接住主动开场后出现。 */
      card: DiscoveryCardView
    }
  | {
      kind: 'bili-report'
      id: string
      /** 一轮 B 站阅读结束后由宿主生成的快照。 */
      report: BiliSessionReportView
    }

export interface UsageTotals {
  prompt: number
  completion: number
  total: number
}

export interface ChatSessionOptions {
  /** 主进程请求打开聊天（用户/审批/模型）；完整聊天用它聚焦输入框。 */
  onOpen?: (reason: string) => void
}

export interface ChatSession {
  items: ChatItem[]
  approvals: ApprovalRequest[]
  phase: UiPhaseSnapshot | null
  hasKey: boolean
  undoCount: number
  petRunning: boolean
  usage: UsageTotals | null
  error: string | null
  stick: boolean
  /** 供滚动 effect 读取的即时值，避免 state 提交前被旧值影响。 */
  stickRef: { current: boolean }
  version: string
  /** 有效角色名（persona.name），用于标题、空态和输入提示。 */
  personaName: string
  sending: boolean
  setStick(stick: boolean): void
  setError(error: string | null): void
  pushNote(tone: Extract<ChatItem, { kind: 'note' }>['tone'], text: string): void
  refresh(): Promise<ChatBootstrap | null>
  sendText(text: string): Promise<boolean>
  stop(): Promise<void>
  togglePause(): Promise<void>
  clearConversation(): Promise<void>
  undo(): Promise<void>
}

function trimItems(items: ChatItem[]): ChatItem[] {
  return items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items
}

function capText(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…（已截断）` : text
}

function historyItem(entry: ChatBootstrap['history'][number]): ChatItem {
  if (entry.kind === 'user') {
    return { kind: 'user', id: nextId(), text: entry.text, at: entry.at }
  }
  return {
    kind: 'assistant',
    id: nextId(),
    text: entry.text,
    reasoning: '',
    streaming: false,
    aborted: entry.aborted === true,
    at: entry.at
  }
}

function reportItem(report: BiliSessionReportView): ChatItem {
  return { kind: 'bili-report', id: `bili-report-${report.id}`, report }
}

/** 实时事件和 bootstrap 可能带来同一份报告；按 report.id 去重。 */
function mergeReports(items: ChatItem[], reports: BiliSessionReportView[]): ChatItem[] {
  if (reports.length === 0) return items
  const seen = new Set(
    items
      .filter(
        (item): item is Extract<ChatItem, { kind: 'bili-report' }> =>
          item.kind === 'bili-report'
      )
      .map((item) => item.report.id)
  )
  const missing = reports.filter((report) => !seen.has(report.id))
  if (missing.length === 0) return items
  return trimItems([
    ...items,
    ...missing.sort((a, b) => a.at - b.at).map(reportItem)
  ])
}

function itemAt(item: ChatItem): number {
  if (item.kind === 'user') return item.at
  if (item.kind === 'assistant') return item.at ?? 0
  if (item.kind === 'bili-report') return item.report.at
  return 0
}

export function useChatSession(options: ChatSessionOptions = {}): ChatSession {
  const [items, setItems] = useState<ChatItem[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [phase, setPhase] = useState<UiPhaseSnapshot | null>(null)
  const [hasKey, setHasKey] = useState(true)
  const [undoCount, setUndoCount] = useState(0)
  const [petRunning, setPetRunning] = useState(true)
  const [usage, setUsage] = useState<UsageTotals | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stick, setStickState] = useState(true)
  const stickRef = useRef(true)
  const [version, setVersion] = useState('')
  const [personaName, setPersonaName] = useState('桌宠')
  const [sending, setSending] = useState(false)

  /** 同步写 ref、异步写 state：滚动事件能立即生效，UI 仍可渲染跳底按钮。 */
  const setStick = useCallback((next: boolean): void => {
    stickRef.current = next
    setStickState(next)
  }, [])

  const activeAssistant = useRef<string | null>(null)
  const activeTool = useRef<Map<string, string>>(new Map())
  const activeTerminal = useRef<string | null>(null)
  /** 纯自主批次的正文不显示；工具与审批仍照常显示。 */
  const suppressAssistant = useRef(false)
  const optsRef = useRef(options)
  optsRef.current = options
  const phaseRef = useRef<UiPhaseSnapshot | null>(null)
  phaseRef.current = phase

  const pushItem = useCallback((item: ChatItem) => {
    setItems((previous) => trimItems([...previous, item]))
  }, [])

  const patchItem = useCallback((id: string, update: (item: ChatItem) => ChatItem) => {
    setItems((previous) => previous.map((item) => (item.id === id ? update(item) : item)))
  }, [])

  const refresh = useCallback(async (): Promise<ChatBootstrap | null> => {
    try {
      const boot = await window.mingyue.chat.bootstrap()
      setHasKey(boot.hasApiKey)
      setPhase(boot.phase)
      setUndoCount(boot.undoCount)
      setPetRunning(boot.petRunning)
      setVersion(boot.version)
      setPersonaName(boot.config.persona.name || '桌宠')
      setApprovals((previous) => mergeApprovals(boot.approvals, previous))
      // 报告每次都合并（实时事件可能在订阅前丢失）；历史只在本地无消息时播种。
      setItems((previous) => {
        if (previous.length === 0 && boot.history.length > 0) {
          return trimItems(
            [...boot.history.map(historyItem), ...boot.biliReports.map(reportItem)].sort(
              (a, b) => itemAt(a) - itemAt(b)
            )
          )
        }
        return mergeReports(previous, boot.biliReports)
      })
      return boot
    } catch {
      setError('无法读取对话状态。')
      return null
    }
  }, [])

  const appendAssistant = useCallback(
    (field: 'text' | 'reasoning', delta: string): void => {
      if (delta === '' || suppressAssistant.current) return
      let id = activeAssistant.current
      if (id === null) {
        id = nextId()
        activeAssistant.current = id
        pushItem({
          kind: 'assistant',
          id,
          text: field === 'text' ? delta : '',
          reasoning: field === 'reasoning' ? delta : '',
          streaming: true,
          aborted: false
        })
        return
      }
      patchItem(id, (item) =>
        item.kind === 'assistant'
          ? { ...item, [field]: capText(item[field] + delta) }
          : item
      )
    },
    [patchItem, pushItem]
  )

  const finishStreaming = useCallback((): void => {
    activeAssistant.current = null
    activeTerminal.current = null
    activeTool.current.clear()
    setItems((previous) =>
      previous.map((item) =>
        item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item
      )
    )
  }, [])

  const addUsage = useCallback((usageEvent: Usage): void => {
    setUsage((previous) => {
      const base = previous ?? { prompt: 0, completion: 0, total: 0 }
      return {
        prompt: base.prompt + (usageEvent.promptTokens || 0),
        completion: base.completion + (usageEvent.completionTokens || 0),
        total: base.total + (usageEvent.totalTokens || 0)
      }
    })
  }, [])

  const handleTap = useCallback(
    (event: ChatTapEvent): void => {
      switch (event.type) {
        case 'conversation_append':
          setItems(previous => {
            const incoming = event.history.map(historyItem)
            const firstAt = event.history[0]?.at ?? Number.POSITIVE_INFINITY
            const pending = previous.findIndex(item => item.kind === 'user' && item.at > firstAt)
            return trimItems(pending < 0 ? [...previous, ...incoming] : [...previous.slice(0, pending), ...incoming, ...previous.slice(pending)])
          })
          return
        case 'conversation_reset':
          activeAssistant.current = null
          activeTool.current.clear()
          setItems([])
          return
        case 'batch_start':
          suppressAssistant.current = event.proactive
          if (event.proactive) activeAssistant.current = null
          return
        case 'assistant_start': {
          if (suppressAssistant.current) return
          const id = nextId()
          activeAssistant.current = id
          pushItem({
            kind: 'assistant',
            id,
            text: '',
            reasoning: '',
            streaming: true,
            aborted: false
          })
          return
        }
        case 'text_delta':
          appendAssistant('text', event.text)
          return
        case 'reasoning_delta':
          appendAssistant('reasoning', event.text)
          return
        case 'tool_call_start': {
          const id = nextId()
          activeTool.current.set(event.id, id)
          pushItem({
            kind: 'tool',
            id,
            callId: event.id,
            name: event.name,
            args: '',
            result: null,
            failed: false,
            done: false
          })
          return
        }
        case 'tool_call_args': {
          const id = activeTool.current.get(event.id)
          if (id === undefined) return
          patchItem(id, (item) =>
            item.kind === 'tool' ? { ...item, args: capText(item.args + event.delta) } : item
          )
          return
        }
        case 'tool_result': {
          const id = activeTool.current.get(event.id)
          const apply = (item: ChatItem): ChatItem =>
            item.kind === 'tool'
              ? {
                  ...item,
                  name: event.name,
                  result: event.text,
                  failed: event.failed,
                  done: true
                }
              : item
          if (id !== undefined) {
            patchItem(id, apply)
          } else {
            pushItem({
              kind: 'tool',
              id: nextId(),
              callId: event.id,
              name: event.name,
              args: '',
              result: event.text,
              failed: event.failed,
              done: true
            })
          }
          return
        }
        case 'assistant_end': {
          if (suppressAssistant.current) return
          const id = activeAssistant.current
          activeAssistant.current = null
          if (id !== null) {
            patchItem(id, (item) =>
              item.kind === 'assistant'
                ? {
                    ...item,
                    text: event.text.trim() === '' ? item.text : event.text,
                    streaming: false,
                    aborted: event.aborted
                  }
                : item
            )
          } else if (event.text.trim() !== '') {
            pushItem({
              kind: 'assistant',
              id: nextId(),
              text: event.text,
              reasoning: '',
              streaming: false,
              aborted: event.aborted
            })
          }
          if (event.aborted) {
            pushItem({ kind: 'note', id: nextId(), tone: 'warn', text: '本轮生成已中止。' })
          }
          return
        }
        case 'usage':
          addUsage(event.usage)
          return
        case 'turn_end': {
          const failure = event.failure
          if (failure !== null) {
            // 结构化的失败/上限/取消：说清楚类型、已完成步骤与恢复方式，
            // 不再用笼统的“这一轮没有成功完成”覆盖真实原因。
            pushItem({
              kind: 'note',
              id: nextId(),
              tone:
                failure.kind === 'provider' ||
                failure.kind === 'protocol' ||
                failure.kind === 'internal' ||
                failure.kind === 'config'
                  ? 'error'
                  : 'warn',
              text: turnFailureNote(failure),
              failure
            })
          } else if (event.outcome !== 'done') {
            pushItem({
              kind: 'note',
              id: nextId(),
              tone: event.outcome === 'failed' ? 'error' : 'warn',
              text:
                event.outcome === 'failed'
                  ? '这一轮没有成功完成，可以看看诊断页或稍后重试。'
                  : '这一轮达到了上下文/轮次上限，已停止。'
            })
          }
          return
        }
        case 'batch_end':
          finishStreaming()
          suppressAssistant.current = false
          return
      }
    },
    [addUsage, appendAssistant, finishStreaming, patchItem, pushItem]
  )

  const handleTerminal = useCallback(
    (event: ChatTerminalEvent): void => {
      if (event.stream === 'started') {
        const id = nextId()
        activeTerminal.current = id
        pushItem({
          kind: 'terminal',
          id,
          command: event.command ?? '',
          cwd: event.cwd ?? null,
          text: ''
        })
        return
      }
      let id = activeTerminal.current
      if (id === null) {
        id = nextId()
        activeTerminal.current = id
        pushItem({
          kind: 'terminal',
          id,
          command: event.command ?? '',
          cwd: null,
          text: event.text
        })
        return
      }
      patchItem(id, (item) =>
        item.kind === 'terminal' ? { ...item, text: capText(item.text + event.text) } : item
      )
    },
    [patchItem, pushItem]
  )

  const handleWeb = useCallback(
    (event: ChatWebEvent): void => {
      pushItem({
        kind: 'note',
        id: nextId(),
        tone: 'web',
        text:
          event.kind === 'search'
            ? `正在搜索：${event.target}`
            : `正在读取网页：${event.target}`
      })
    },
    [pushItem]
  )

  useEffect(() => {
    void refresh()
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)

    const unsubscribers = [
      window.mingyue.chat.onUserMessage((event: ChatUserMessageEvent) => {
        setItems((previous) =>
          trimItems([
            ...previous,
            { kind: 'user', id: `u-${event.cursor}-${nextId()}`, text: event.text, at: event.at }
          ])
        )
        setStick(true)
      }),
      window.mingyue.chat.onTap((event) => handleTap(event)),
      window.mingyue.chat.onTerminal((event) => handleTerminal(event)),
      window.mingyue.chat.onWeb((event) => handleWeb(event)),
      window.mingyue.chat.onApproval((event: ChatApprovalEvent) => {
        setApprovals(event.all)
        setStick(true)
      }),
      window.mingyue.chat.onApprovalCleared((event: ChatApprovalClearedEvent) => {
        setApprovals(event.all)
        pushItem({
          kind: 'note',
          id: nextId(),
          tone: event.approved ? 'info' : 'warn',
          text: event.approved ? '操作已批准。' : '操作已拒绝。'
        })
      }),
      window.mingyue.chat.onPhase((snapshot) => setPhase(snapshot)),
      window.mingyue.chat.onStatus((snapshot) => setPhase(snapshot)),
      window.mingyue.chat.onOpen((event) => {
        optsRef.current.onOpen?.(event.reason)
        setStick(true)
      }),
      window.mingyue.chat.onCleared(() => {
        activeAssistant.current = null
        activeTool.current.clear()
        suppressAssistant.current = false
        setItems([])
        setApprovals([])
        setUsage(null)
        setUndoCount(0)
        setError(null)
        setStick(true)
      }),
      window.mingyue.chat.onBiliReport((report: BiliSessionReportView) => {
        // 分享卡是被动通知：正在翻历史时不把用户拉回底部。
        setItems((previous) => mergeReports(previous, [report]))
      })
    ]

    return () => {
      window.removeEventListener('focus', onFocus)
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
    // 订阅只建立一次；handler 都是稳定引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sendText = useCallback(async (text: string): Promise<boolean> => {
    const trimmed = text.trim()
    if (trimmed === '' || sending) return false
    if (phaseRef.current?.paused === true) {
      setError('对话已暂停，先点“继续对话”。')
      return false
    }
    // 在发送前恢复吸底；即使发送失败，用户也回到最新位置看到错误提示。
    setStick(true)
    setSending(true)
    setError(null)
    try {
      const result = await window.mingyue.chat.send(trimmed)
      if (!result.ok) {
        setError(result.message ?? '消息没有发出去。')
        return false
      }
      if (result.discovery !== undefined) {
        const card = result.discovery
        // 同一条发现只放一张卡；重复回应同一话题不叠卡。
        setItems((previous) =>
          previous.some((item) => item.kind === 'discovery' && item.card.id === card.id)
            ? previous
            : trimItems([...previous, { kind: 'discovery', id: nextId(), card }])
        )
      }
      return true
    } catch {
      setError('消息发送失败，请稍后再试。')
      return false
    } finally {
      setSending(false)
    }
  }, [sending])

  const stop = useCallback(async (): Promise<void> => {
    try {
      await window.mingyue.chat.stop()
    } catch {
      setError('停止失败。')
    }
  }, [])

  const togglePause = useCallback(async (): Promise<void> => {
    const next = !(phaseRef.current?.paused ?? false)
    try {
      await window.mingyue.chat.setPaused(next)
      setPhase((previous) =>
        previous === null ? previous : { ...previous, paused: next, busy: next ? false : previous.busy }
      )
    } catch {
      setError('切换暂停状态失败。')
    }
  }, [])

  const clearConversation = useCallback(async (): Promise<void> => {
    if (!window.confirm('清空当前聊天记录？她将不再记得这段上下文。')) return
    try {
      await window.mingyue.chat.markCleared()
      setItems([])
      setUsage(null)
      setError(null)
    } catch {
      setError('清空失败。')
    }
  }, [])

  const undo = useCallback(async (): Promise<void> => {
    try {
      const result = await window.mingyue.chat.undo(1)
      pushItem({
        kind: 'note',
        id: nextId(),
        tone: result.ok ? 'info' : 'warn',
        text: result.message
      })
      if (result.ok) setUndoCount((count) => Math.max(0, count - 1))
    } catch {
      setError('撤销失败。')
    }
  }, [pushItem])

  const pushNote = useCallback(
    (tone: Extract<ChatItem, { kind: 'note' }>['tone'], text: string): void => {
      pushItem({ kind: 'note', id: nextId(), tone, text })
    },
    [pushItem]
  )

  return {
    items,
    approvals,
    phase,
    hasKey,
    undoCount,
    petRunning,
    usage,
    error,
    stick,
    stickRef,
    version,
    personaName,
    sending,
    setStick,
    setError,
    pushNote,
    refresh,
    sendText,
    stop,
    togglePause,
    clearConversation,
    undo
  }
}
