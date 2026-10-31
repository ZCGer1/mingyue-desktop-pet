import type { DiscoveryFeedbackKind, DiscoveryShareState } from '../../../shared/discovery'
import { DISCOVERY_FEEDBACK_LABELS } from '../../../shared/discovery'
import { useSettings } from '../context'
import { Button, Empty } from '../ui'

const DISCOVERY_STATE_LABELS: Record<DiscoveryShareState, string> = {
  discovered: '还没分享',
  'pending-share': '等你回应',
  shared: '分享过',
  opened: '你打开过'
}

/** 设置页最多展示最近这么多条；更多记录仍保留在本地。 */
const DISCOVERY_LIST_LIMIT = 20

/**
 * 发现列表：普通网页与 B 站共用。
 *
 * 只在本机保存标题、规范链接、站点、短理由与短摘要；不含字幕全文或正文。
 */
export function DiscoveryList(): React.JSX.Element {
  const s = useSettings()
  const list = s.discovery?.list ?? null

  const open = async (id: string): Promise<void> => {
    try {
      const result = await window.mingyue.discovery.open(id)
      s.notify(result.message ?? (result.ok ? '已打开。' : '打开失败。'), result.ok ? 'ok' : 'error')
      await s.loadDiscovery()
    } catch {
      s.notify('打开失败，请稍后再试。', 'error')
    }
  }

  const feedback = async (id: string, kind: DiscoveryFeedbackKind): Promise<void> => {
    try {
      const result = await window.mingyue.discovery.feedback(id, kind)
      s.notify(result.message ?? (result.ok ? '已记下。' : '没有记下。'), result.ok ? 'ok' : 'error')
      await s.loadDiscovery()
    } catch {
      s.notify('暂时不能记录反馈。', 'error')
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm('删除这条发现？相关的主动分享引用也会失效。')) return
    try {
      const result = await window.mingyue.discovery.remove(id)
      s.notify(result.message ?? (result.ok ? '已删除。' : '删除失败。'), result.ok ? 'ok' : 'error')
      await s.loadDiscovery()
    } catch {
      s.notify('删除失败，请稍后再试。', 'error')
    }
  }

  const clear = async (): Promise<void> => {
    if (!window.confirm('清空全部发现？这不会影响你的浏览记录，但会删除本地保存的标题、理由与摘要。')) {
      return
    }
    try {
      const result = await window.mingyue.discovery.clear()
      s.notify(result.message ?? (result.ok ? '已清空。' : '清空失败。'), result.ok ? 'ok' : 'error')
      await s.loadDiscovery()
    } catch {
      s.notify('清空失败，请稍后再试。', 'error')
    }
  }

  return (
    <section className="section" aria-labelledby="activity-discoveries">
      <header className="section-head">
        <h2 id="activity-discoveries">发现</h2>
        <div className="section-actions">
          <Button variant="subtle" onClick={() => void s.loadDiscovery()}>
            刷新
          </Button>
          <Button
            variant="danger"
            disabled={list === null || list.total === 0}
            onClick={() => void clear()}
          >
            清空全部
          </Button>
        </div>
      </header>
      <div className="section-body">
        {list === null ? (
          <Empty>正在读取…</Empty>
        ) : list.items.length === 0 ? (
          <Empty>还没有保存的发现。</Empty>
        ) : (
          <>
            <ul className="discovery-list">
              {list.items.slice(0, DISCOVERY_LIST_LIMIT).map((item) => (
                <li className="discovery-item" key={item.id}>
                  <div className="discovery-item-head">
                    <div>
                      <div className="discovery-item-title">{item.title}</div>
                      <div className="discovery-item-meta">
                        <span>
                          {item.site === 'bilibili'
                            ? `B站${item.author.trim() === '' ? '' : ` · ${item.author}`}`
                            : item.domain}
                        </span>
                        <span>{item.kind === 'video' ? '视频' : '网页'}</span>
                        <span>{item.evidenceLabel}</span>
                        <span>{DISCOVERY_STATE_LABELS[item.shareState]}</span>
                      </div>
                    </div>
                    <Button variant="ghost" onClick={() => void remove(item.id)}>
                      删除
                    </Button>
                  </div>
                  {item.reason.trim() === '' ? null : (
                    <p className="discovery-item-reason">{item.reason}</p>
                  )}
                  {item.summary.trim() === '' ? null : (
                    <p className="discovery-item-reason">{item.summary}</p>
                  )}
                  <div className="discovery-item-actions">
                    <button
                      type="button"
                      className="discovery-chip"
                      onClick={() => void open(item.id)}
                    >
                      {item.kind === 'video' ? '打开视频' : '打开网页'}
                    </button>
                    {(['like', 'less', 'drop-topic'] as const).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        className={`discovery-chip${item.feedback === kind ? ' is-active' : ''}`}
                        aria-pressed={item.feedback === kind}
                        onClick={() => void feedback(item.id, kind)}
                      >
                        {DISCOVERY_FEEDBACK_LABELS[kind]}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            {list.items.length > DISCOVERY_LIST_LIMIT && (
              <p className="muted small">只显示最近 {DISCOVERY_LIST_LIMIT} 条，本地共 {list.total} 条。</p>
            )}
          </>
        )}
      </div>
    </section>
  )
}
