import { useEffect } from 'react'
import { useSettings } from '../context'
import { Button, Empty, Field, Pill, Section, Toggle } from '../ui'

const CATEGORY_LABELS: Record<string, string> = {
  editor: '代码编辑器',
  terminal: '终端',
  browser: '浏览器',
  media: '影音',
  office: '文档办公',
  design: '设计',
  game: '游戏',
  meeting: '会议',
  other: '其他',
  uwp: '应用'
}

const MUTABLE_CATEGORIES = [
  'editor',
  'terminal',
  'browser',
  'media',
  'office',
  'design',
  'game',
  'meeting'
]

/**
 * 记忆与隐私里的行为感知部分。
 *
 * 屏幕感知与截图配置在「电脑能力 → 屏幕」；这里只保留只读行为采样、
 * 共享字段、保留规则与本机数据。
 */
export function PrivacyTab(): React.JSX.Element {
  const s = useSettings()
  const activity = s.config.worlds.activity
  const refreshActivity = s.refreshActivity

  // 配置流程里也会挂载本表单；进入时补一次本机采样读取。
  useEffect(() => {
    void refreshActivity()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="stack">
      <Section title="只读行为感知">
        <Toggle
          label="开启行为感知"
          checked={activity.enabled}
          onChange={(checked) => s.update(['worlds', 'activity', 'enabled'], checked)}
        />
        <Toggle
          label="暂停采样"
          checked={s.boot.activityPaused}
          disabled={!activity.enabled}
          onChange={(checked) => void s.setActivityPaused(checked)}
        />
        <div className="grid-2">
          <Field label="采样间隔">
            <select
              className="input"
              value={activity.sampleMs}
              onChange={(event) =>
                s.update(['worlds', 'activity', 'sampleMs'], Number(event.target.value))
              }
            >
              <option value={1000}>1 秒</option>
              <option value={2000}>2 秒</option>
              <option value={5000}>5 秒</option>
            </select>
          </Field>
          <Field label="空闲判定（分钟）">
            <input
              className="input input-num"
              type="number"
              min={1}
              max={240}
              value={activity.idleMinutes}
              onChange={(event) =>
                s.update(['worlds', 'activity', 'idleMinutes'], Number(event.target.value))
              }
            />
          </Field>
        </div>
      </Section>

      <Section title="共享给模型的脱敏事件">
        <Toggle
          label="允许行为事件唤醒模型"
          checked={activity.shareEventsToModel}
          disabled={!activity.enabled}
          onChange={(checked) => s.update(['worlds', 'activity', 'shareEventsToModel'], checked)}
        />
        <Toggle
          label="共享应用显示名"
          checked={activity.shareAppName}
          disabled={!activity.enabled || !activity.shareEventsToModel}
          onChange={(checked) => s.update(['worlds', 'activity', 'shareAppName'], checked)}
        />
        <Toggle
          label="共享脱敏窗口标题"
          checked={activity.shareWindowTitle}
          disabled={!activity.enabled || !activity.shareEventsToModel}
          onChange={(checked) => s.update(['worlds', 'activity', 'shareWindowTitle'], checked)}
        />
        <div className="grid-2">
          <Field label="标题最长字符">
            <input
              className="input input-num"
              type="number"
              min={20}
              max={160}
              disabled={!activity.shareWindowTitle}
              value={activity.titleMaxChars}
              onChange={(event) =>
                s.update(
                  ['worlds', 'activity', 'titleMaxChars'],
                  Math.min(160, Math.max(20, Number(event.target.value)))
                )
              }
            />
          </Field>
          <Field label="保留类别统计（天）">
            <select
              className="input"
              value={activity.retainStatsDays}
              onChange={(event) =>
                s.update(['worlds', 'activity', 'retainStatsDays'], Number(event.target.value))
              }
            >
              <option value={0}>不保留</option>
              <option value={7}>7</option>
              <option value={14}>14</option>
              <option value={30}>30</option>
            </select>
          </Field>
        </div>
      </Section>

      <Section title="静音与排除">
        <div className="category-grid">
          {MUTABLE_CATEGORIES.map((category) => {
            const checked = activity.muteCategories.includes(category)
            return (
              <label className="check-row" key={category}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...new Set([...activity.muteCategories, category])]
                      : activity.muteCategories.filter((item) => item !== category)
                    s.update(['worlds', 'activity', 'muteCategories'], next)
                  }}
                />
                {CATEGORY_LABELS[category] ?? category}
              </label>
            )
          })}
        </div>
        <Field label="排除的应用" hint="每行一个进程名；只在本机使用。">
          <textarea
            className="input textarea"
            rows={3}
            value={activity.exclude.join('\n')}
            onChange={(event) =>
              s.update(
                ['worlds', 'activity', 'exclude'],
                event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line !== '')
              )
            }
          />
        </Field>
      </Section>

      <Section
        title="她看到了什么"
        actions={
          <div className="row-gap">
            <Pill tone="warn">仅本机</Pill>
            <Button onClick={() => void s.refreshActivity()}>刷新</Button>
            <Button variant="danger" onClick={() => void s.clearRaw()} disabled={s.raw.length === 0}>
              清除原始采样
            </Button>
          </div>
        }
      >
        {s.raw.length === 0 ? (
          <Empty>
            {activity.enabled ? (s.boot.activityPaused ? '采样已暂停。' : '还没有采样记录。') : '行为感知未开启。'}
          </Empty>
        ) : (
          <div className="raw-table-wrap">
            <table className="raw-table">
              <thead>
                <tr>
                  <th>进程名</th>
                  <th>类别</th>
                  <th>停留</th>
                  <th>本地时间</th>
                </tr>
              </thead>
              <tbody>
                {s.raw.map((sample, index) => (
                  <tr key={`${sample.processName}-${sample.at}-${index}`}>
                    <td className="mono">{sample.processName}</td>
                    <td>{sample.categoryLabel}</td>
                    <td>{sample.durationMinutes} 分钟</td>
                    <td>{new Date(sample.at).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="类别统计"
        actions={
          <div className="row-gap">
            <Button onClick={() => void s.refreshActivity()}>刷新</Button>
            <Button variant="danger" onClick={() => void s.clearStats()}>
              清除统计
            </Button>
          </div>
        }
      >
        {s.stats === null ? (
          <Empty>正在读取统计…</Empty>
        ) : (
          <div className="stats-columns">
            <StatsCard title="今天" stats={s.stats.today} />
            <StatsCard title="本次会话" stats={s.stats.session} />
          </div>
        )}
      </Section>

      <Section
        title="清空本地数据"
        actions={
          <Button variant="danger" disabled={s.saving} onClick={() => void s.clearLocalData()}>
            清空本地数据…
          </Button>
        }
      >
        <p className="muted small">
          删除聊天上下文、事件库、记忆、活动统计、撤销快照、提醒、用量与日志；保留设置、API Key
          与工作区文件。操作不可恢复。
        </p>
      </Section>
    </div>
  )
}

function StatsCard({
  title,
  stats
}: {
  title: string
  stats: import('../../../shared/ipc').ActivityDayStatsView
}): React.JSX.Element {
  const entries = Object.entries(stats.categories)
    .filter(([, minutes]) => minutes > 0)
    .sort((a, b) => b[1] - a[1])
  const max = entries.reduce((value, [, minutes]) => Math.max(value, minutes), 1)
  return (
    <div className="stats-card">
      <header>
        <h3>{title}</h3>
        <span>{stats.date}</span>
      </header>
      {entries.length === 0 ? (
        <Empty>暂无数据。</Empty>
      ) : (
        <div className="bars">
          {entries.map(([category, minutes]) => (
            <div className="bar-row" key={category}>
              <span className="bar-label">{CATEGORY_LABELS[category] ?? category}</span>
              <span className="bar-track">
                <span
                  className="bar-fill"
                  style={{ width: `${Math.max(3, (minutes / max) * 100)}%` }}
                />
              </span>
              <span className="bar-value">{Math.round(minutes)}m</span>
            </div>
          ))}
        </div>
      )}
      <div className="stats-meta">
        <span>切换 {stats.switches} 次</span>
        <span>空闲 {Math.round(stats.idleMinutes)} 分钟</span>
        <span>最长专注 {Math.round(stats.longestFocusMinutes)} 分钟</span>
        {stats.lateNight && <Pill tone="warn">深夜活跃</Pill>}
      </div>
    </div>
  )
}
