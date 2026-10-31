import { useSettings } from '../context'
import { Button, Field, Section, Toggle } from '../ui'

function timeLabel(at: number | null): string {
  if (at === null) return '—'
  try {
    return new Date(at).toLocaleString()
  } catch {
    return '—'
  }
}

const SCREEN_STATE_LABELS: Record<string, string> = {
  idle: '待机',
  waiting: '等待新画面',
  generating: '生成中',
  queued: '排队中',
  displayed: '已真实显示',
  skipped: '这次不说',
  cancelled: '已取消',
  failed: '失败'
}

const SCREEN_REASON_LABELS: Record<string, string> = {
  disabled: '未启用或既有授权不完整',
  'event-sharing-off': '事件分享已关闭',
  'muted-category': '当前应用静音',
  'quiet-hours': '安静时段',
  'speech-quiet': '暂时别说话',
  busy: '正在忙碌',
  'post-user-cooldown': '刚聊过，稍等',
  stale: '摘要已过期',
  'target-changed': '前台目标已变化',
  duplicate: '重复画面',
  'low-confidence': '识别置信度低',
  'waiting-fresh-scene': '等待新画面',
  'question-cooldown': '问题冷却中',
  'provider-failed': '模型请求失败',
  'invalid-output': '台词格式无效',
  'sink-unavailable': '桌宠页面不可用',
  'render-failed': '气泡未显示',
  'no-comment': '这次不想说'
}

function screenStatusLine(
  state: string,
  reason: string | null,
  active: boolean
): string {
  const stateLabel = SCREEN_STATE_LABELS[state] ?? state
  const reasonLabel = reason === null ? null : (SCREEN_REASON_LABELS[reason] ?? reason)
  if (!active) {
    return reasonLabel === null ? '未生效' : `未生效：${reasonLabel}`
  }
  return reasonLabel === null ? stateLabel : `${stateLabel}（${reasonLabel}）`
}

/**
 * 主动聊天与探索节奏。
 *
 * “安静”只影响主动开口，“暂停探索”只挂起自主探索；两者都不等于
 * 停止当前电脑操作或撤销授权。
 */
export function CompanionRhythm(): React.JSX.Element {
  const s = useSettings()
  const companion = s.companion
  const screen = companion?.screenFeedback ?? null

  return (
    <div className="stack">
      <Section
        title="聊天与探索节奏"
        actions={
          <Button variant="subtle" onClick={() => void s.loadCompanion()}>
            刷新状态
          </Button>
        }
      >
        <Field label="主动聊天档位">
          <select
            className="input"
            value={s.config.companion.cadence}
            onChange={(event) => s.update(['companion', 'cadence'], event.target.value)}
          >
            <option value="quiet">安静（很少主动开口）</option>
            <option value="natural">自然（偶尔来搭话）</option>
            <option value="lively">活泼（更常开口）</option>
          </select>
        </Field>
        <div className="kv">
          <span>下次考虑</span>
          <span>{timeLabel(companion?.nextCadenceAt ?? null)}</span>
        </div>
        <div className="kv">
          <span>暂时安静截止</span>
          <span>{timeLabel(companion?.speechQuietUntil ?? null)}</span>
        </div>
        <div className="kv">
          <span>探索暂停截止</span>
          <span>{timeLabel(companion?.explorePausedUntil ?? null)}</span>
        </div>
        <div className="kv">
          <span>未回应的开场</span>
          <span>{companion === null ? '—' : companion.unansweredEpisode ? '有' : '无'}</span>
        </div>
        <div className="row-gap">
          <Button
            variant="subtle"
            onClick={() =>
              void s.companionAction(
                companion?.speechQuietUntil != null ? 'resume-speech' : 'quiet-speech'
              )
            }
          >
            {companion?.speechQuietUntil != null ? '恢复主动说话' : '安静 30 分钟'}
          </Button>
          <Button
            variant="subtle"
            onClick={() =>
              void s.companionAction(
                companion?.explorePausedUntil != null ? 'resume-explore' : 'pause-explore'
              )
            }
          >
            {companion?.explorePausedUntil != null ? '恢复探索' : '暂停探索 30 分钟'}
          </Button>
        </div>
      </Section>

      <Section
        title="屏幕感知"
        actions={
          <Button
            variant="subtle"
            onClick={() => void s.screenCompanionTest()}
            disabled={companion === null}
          >
            一次陪伴反馈测试
          </Button>
        }
      >
        <Toggle
          label="屏幕感知"
          checked={s.config.companion.screenFeedback.enabled}
          onChange={(checked) =>
            s.update(['companion', 'screenFeedback', 'enabled'], checked)
          }
        />
        <div className="kv">
          <span>当前状态</span>
          <span>
            {screen === null
              ? '—'
              : screenStatusLine(screen.state, screen.lastReason, screen.active)}
          </span>
        </div>
        <div className="kv">
          <span>最近观察</span>
          <span>{timeLabel(screen?.lastObservationAt ?? null)}</span>
        </div>
        <div className="kv">
          <span>最近生成台词</span>
          <span>{timeLabel(screen?.lastGeneratedAt ?? null)}</span>
        </div>
        <div className="kv">
          <span>最近真实显示</span>
          <span>{timeLabel(screen?.lastDisplayedAt ?? null)}</span>
        </div>
        <div className="kv">
          <span>下次可评估</span>
          <span>{timeLabel(screen?.nextEligibleAt ?? null)}</span>
        </div>
        <div className="kv">
          <span>计数</span>
          <span>
            {screen === null
              ? '—'
              : `候选 ${screen.counts.candidates} · 显示 ${screen.counts.displayed} · 跳过 ${screen.counts.skipped} · 取消 ${screen.counts.cancelled} · 失败 ${screen.counts.failed} · 问题 ${screen.counts.questions}`}
          </span>
        </div>
      </Section>
    </div>
  )
}
