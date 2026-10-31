import { useState } from 'react'
import {
  DISCOVERY_FEEDBACK_LABELS,
  type DiscoveryCardView,
  type DiscoveryFeedbackKind
} from '../../shared/discovery'

/**
 * 主动分享的发现卡片（普通网页或 B 站视频）。
 *
 * 只在用户回应主动开场后出现：标题/站点/理由/摘要都来自已保存的发现记录，
 * 不是渲染进程或模型临时拼的文本。打开按钮只传不透明 id，真正的 URL
 * 由主进程重新校验后才交给系统浏览器。
 */
export function DiscoveryCard({
  card,
  compact = false
}: {
  card: DiscoveryCardView
  compact?: boolean
}): React.JSX.Element {
  const [busy, setBusy] = useState<'open' | DiscoveryFeedbackKind | null>(null)
  const [feedback, setFeedback] = useState<DiscoveryFeedbackKind | null>(card.feedback)
  const [opened, setOpened] = useState(card.shareState === 'opened')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function open(): Promise<void> {
    if (busy !== null) return
    setBusy('open')
    setError(null)
    setNotice(null)
    try {
      const result = await window.mingyue.discovery.open(card.id)
      if (result.ok) {
        setOpened(true)
        setNotice(result.message ?? '已打开。')
      } else {
        setError(result.message ?? '暂时打不开这条内容。')
      }
    } catch {
      setError('暂时打不开这条内容。')
    } finally {
      setBusy(null)
    }
  }

  async function sendFeedback(kind: DiscoveryFeedbackKind): Promise<void> {
    if (busy !== null) return
    setBusy(kind)
    setError(null)
    setNotice(null)
    try {
      const result = await window.mingyue.discovery.feedback(card.id, kind)
      if (result.ok) {
        setFeedback(kind)
        setNotice(result.message ?? '已记下。')
      } else {
        setError(result.message ?? '暂时不能记录反馈。')
      }
    } catch {
      setError('暂时不能记录反馈。')
    } finally {
      setBusy(null)
    }
  }

  const feedbackKinds: DiscoveryFeedbackKind[] = ['like', 'less', 'drop-topic']
  const isVideo = card.kind === 'video'

  return (
    <article
      className={`discovery-card${compact ? ' discovery-card-compact' : ''}`}
      aria-label="她的主动浏览发现"
    >
      <header className="discovery-head">
        <span className="discovery-badge">{isVideo ? 'B 站发现' : '网页发现'}</span>
        <span className="discovery-evidence" title="她这次实际读到的内容">
          {card.evidenceLabel}
        </span>
        {card.memoryOnly && (
          <span className="discovery-memory" title="记忆已关闭，重启后不会保留">
            本次运行
          </span>
        )}
      </header>

      <h3 className="discovery-title">{card.title}</h3>
      <p className="discovery-author">
        {isVideo
          ? card.author.trim() === ''
            ? '未知 UP 主'
            : card.author
          : card.domain}
      </p>

      {card.reason.trim() !== '' && (
        <p className="discovery-reason">
          <span className="discovery-reason-label">她为什么分享：</span>
          {card.reason}
        </p>
      )}

      {!compact && card.summary.trim() !== '' && (
        <p className="discovery-summary">{card.summary}</p>
      )}

      {card.topicTags.length > 0 && (
        <div className="discovery-tags">
          {card.topicTags.map((tag) => (
            <span className="discovery-tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      )}

      <footer className="discovery-actions">
        <button
          type="button"
          className="discovery-open"
          disabled={busy !== null}
          onClick={() => void open()}
        >
          {busy === 'open'
            ? '打开中…'
            : opened
              ? isVideo
                ? '再次打开视频'
                : '再次打开网页'
              : isVideo
                ? '打开视频'
                : '打开网页'}
        </button>
        <div className="discovery-feedback" role="group" aria-label="对这类发现的反馈">
          {feedbackKinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`discovery-feedback-btn${feedback === kind ? ' is-active' : ''}`}
              title={DISCOVERY_FEEDBACK_LABELS[kind]}
              aria-pressed={feedback === kind}
              disabled={busy !== null}
              onClick={() => void sendFeedback(kind)}
            >
              {compact
                ? kind === 'like'
                  ? '喜欢'
                  : kind === 'less'
                    ? '少些'
                    : '别研究'
                : DISCOVERY_FEEDBACK_LABELS[kind]}
            </button>
          ))}
        </div>
      </footer>

      {notice !== null && <p className="discovery-notice">{notice}</p>}
      {error !== null && <p className="discovery-error">{error}</p>}
    </article>
  )
}
