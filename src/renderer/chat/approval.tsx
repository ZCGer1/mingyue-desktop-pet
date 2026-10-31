import { useEffect, useState } from 'react'
import type { ApprovalRequest, ApprovalScope } from '../../core/types'
import { DiffView, Markdown } from './markdown'

const RISK_LABEL: Record<string, string> = {
  low: '低风险',
  medium: '需留意',
  high: '高风险'
}

export function ApprovalCard({
  request,
  onResolved
}: {
  request: ApprovalRequest
  onResolved?: (id: string) => void
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [scope, setScope] = useState<ApprovalScope>('once')
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const remaining = Math.max(0, request.expiresAt - now)
  const minutes = Math.floor(remaining / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1000)

  async function resolve(approved: boolean): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.mingyue.chat.resolveApproval(
        request.id,
        approved,
        approved ? scope : 'once'
      )
      if (!result.ok) setError(result.message ?? '审批提交失败。')
      else onResolved?.(request.id)
    } catch {
      setError('审批提交失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  async function cancelTask(): Promise<void> {
    if (request.taskId === undefined || cancelling) return
    setCancelling(true)
    setError(null)
    try {
      const result = await window.mingyue.chat.cancelTask(request.taskId)
      if (!result.ok) setError(result.message ?? '撤销任务失败。')
      else onResolved?.(request.id)
    } catch {
      setError('撤销任务失败，请稍后重试。')
    } finally {
      setCancelling(false)
    }
  }

  const preview = request.preview
  const sourceLabel =
    request.source === 'task'
      ? `任务${request.taskTitle === undefined ? '' : `「${request.taskTitle}」`}`
      : request.source === 'autonomy'
        ? '自主唤醒'
        : request.source === 'quick-chat'
          ? '快捷聊天'
          : '聊天'

  return (
    <article className={`approval-card risk-${request.risk}`}>
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

      <div className="approval-source">来源：{sourceLabel}</div>

      {request.approvalAsk !== undefined && request.approvalAsk.trim() !== '' && (
        <p className="approval-ask" role="note">
          {request.approvalAsk}
        </p>
      )}

      <h3 className="approval-title">{preview.title}</h3>
      <p className="approval-summary">{request.summary}</p>

      {request.toolName === 'task_create' && (
        <p className="approval-scope-note">
          批准后，授权只在这个任务范围内生效；任务结束、取消或撤销后立即失效。红区动作仍会逐次询问。
        </p>
      )}

      {preview.kind === 'diff' && preview.diff !== undefined && (
        <div className="approval-preview">
          {preview.path !== undefined && <div className="approval-path">{preview.path}</div>}
          <DiffView diff={preview.diff} />
        </div>
      )}

      {preview.kind === 'command' && (
        <div className="approval-preview">
          {preview.cwd !== undefined && <div className="approval-cwd">工作目录：{preview.cwd}</div>}
          <pre className="approval-command">{preview.command ?? preview.body ?? ''}</pre>
        </div>
      )}

      {(preview.kind === 'text' || preview.kind === 'list') && preview.body !== undefined && (
        <div className="approval-preview">
          {preview.path !== undefined && <div className="approval-path">{preview.path}</div>}
          <div className="approval-text">
            <Markdown text={preview.body} />
          </div>
        </div>
      )}

      {preview.kind === 'diff' && preview.diff === undefined && preview.body !== undefined && (
        <div className="approval-preview">
          <div className="approval-text">
            <Markdown text={preview.body} />
          </div>
        </div>
      )}

      {(request.sessionScoped || request.alwaysScoped) && (
        <div className="approval-scopes" role="radiogroup" aria-label="批准范围">
          <label className="approval-scope">
            <input
              type="radio"
              name={`approval-scope-${request.id}`}
              checked={scope === 'once'}
              onChange={() => setScope('once')}
            />
            仅本次
          </label>
          {request.sessionScoped && (
            <label className="approval-scope">
              <input
                type="radio"
                name={`approval-scope-${request.id}`}
                checked={scope === 'session'}
                onChange={() => setScope('session')}
              />
              {request.sessionScopeLabel ?? '本会话'}
              {request.grantLabel === undefined ? '' : `（${request.grantLabel}）`}
            </label>
          )}
          {request.alwaysScoped && (
            <label className="approval-scope">
              <input
                type="radio"
                name={`approval-scope-${request.id}`}
                checked={scope === 'always'}
                onChange={() => setScope('always')}
              />
              始终允许此类
            </label>
          )}
        </div>
      )}

      {error !== null && <p className="approval-error">{error}</p>}

      <footer className="approval-actions">
        {request.taskId !== undefined && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || cancelling || remaining === 0}
            onClick={() => void cancelTask()}
          >
            {cancelling ? '撤销中…' : '撤销该任务'}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy || remaining === 0}
          onClick={() => void resolve(false)}
        >
          拒绝
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || remaining === 0}
          onClick={() => void resolve(true)}
        >
          {busy ? '提交中…' : '批准'}
        </button>
      </footer>
    </article>
  )
}
