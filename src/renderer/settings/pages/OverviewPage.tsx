import { useMemo, useState } from 'react'
import type { TaskView } from '../../../shared/ipc'
import { CapabilitySummary } from '../components/CapabilityCards'
import {
  loadWizardProgress,
  SettingsWizard,
  WIZARD_STORAGE_KEY,
  type WizardProgress
} from '../components/SettingsWizard'
import { useSettings } from '../context'
import { Button, Pill } from '../ui'

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

const READINESS_LABEL: Record<string, string> = {
  'autonomy-disabled': '自主唤醒已关闭',
  'mode-not-explore': '当前模式不是自主探索',
  'provider-key-missing': '没有可用的模型密钥',
  'no-effective-scope': '没有实际可执行的授权范围',
  'not-started': '运行时尚未就绪',
  'explore-paused': '探索被手动暂停',
  'explicit-rest': '她选择了有界休息',
  paused: '全部对话已暂停',
  busy: '正在处理其他对话或任务',
  'active-autonomy-task': '已有自主目标在继续',
  'wake-quiet': '当前处于安静时段',
  'wake-disabled': '唤醒通道已关闭',
  'wake-paused': '唤醒通道已暂停',
  'notes-unavailable': '笔记目录当前不可访问',
  'cua-not-ready': '键鼠与截图授权未齐',
  'window-capture-off': '未开启按窗口截图'
}

function timeLabel(at: number | null | undefined): string {
  if (at === null || at === undefined) return '—'
  try {
    return new Date(at).toLocaleString()
  } catch {
    return '—'
  }
}

function taskLabel(task: TaskView): string {
  return task.title.trim() === '' ? '未命名任务' : task.title
}

/**
 * 概览：配置流程与精简状态。
 *
 * 流程未完成时直接提供分步配置；完成后只保留能力状态与必要运行控制。
 * 任务与发现在「活动与任务」。
 */
export function OverviewPage(): React.JSX.Element {
  const s = useSettings()
  const [wizard, setWizard] = useState<WizardProgress>(loadWizardProgress)
  const companion = s.companion
  const readiness = companion?.readiness ?? null
  const snapshot = s.capabilitySnapshot
  const activeTasks = useMemo(
    () => s.tasks.filter((task) => !TERMINAL.has(task.state)),
    [s.tasks]
  )
  const currentTask = activeTasks[0] ?? null
  const readyCards =
    snapshot === null
      ? 0
      : snapshot.cards.filter((card) => card.state === 'ready' || card.state === 'limited').length

  const restart = (): void => {
    const next: WizardProgress = { completed: false, step: 0, skipped: [], saved: [] }
    try {
      window.localStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* 受限环境仍可在本次会话继续使用流程。 */
    }
    setWizard(next)
  }

  if (!wizard.completed) {
    return (
      <div className="stack">
        <SettingsWizard onCompleted={() => setWizard(loadWizardProgress())} />
      </div>
    )
  }

  const nowDoing = (() => {
    if (s.boot.agentPaused) return '全部对话已暂停'
    if (currentTask !== null) return `正在处理：${taskLabel(currentTask)}（${currentTask.state}）`
    if (companion?.explorePausedUntil != null) {
      return `探索暂停到 ${timeLabel(companion.explorePausedUntil)}`
    }
    if (readiness?.schedule.state === 'resting') {
      return readiness.schedule.restUntil === null
        ? '有界休息中'
        : `休息到 ${timeLabel(readiness.schedule.restUntil)}`
    }
    if (readiness?.schedule.state === 'active') {
      return readiness.schedule.reason === 'active-autonomy-task'
        ? '自主目标执行中'
        : '处理当前对话中'
    }
    if (readiness?.schedule.state === 'paused') return '探索已暂停'
    if (readiness?.capability.reasons.length) {
      return `能力受限：${readiness.capability.reasons
        .map((code) => READINESS_LABEL[code] ?? code)
        .join('、')}`
    }
    return '空闲'
  })()

  return (
    <div className="stack">
      <section className="hero overview-hero" aria-labelledby="overview-now">
        <div className="hero-mark" aria-hidden="true">
          🐋
        </div>
        <div className="overview-hero-body">
          <h2 id="overview-now">{nowDoing}</h2>
          <div className="status-row">
            <Pill tone={s.boot.keyStatus.configured ? 'ok' : 'bad'}>
              {s.boot.keyStatus.configured ? '模型已配置' : '模型未配置'}
            </Pill>
            <Pill
              tone={
                snapshot === null
                  ? 'neutral'
                  : snapshot.exploration.active
                    ? 'ok'
                    : snapshot.exploration.enabled
                      ? 'warn'
                      : 'neutral'
              }
            >
              {snapshot === null
                ? '能力状态未知'
                : snapshot.exploration.active
                  ? '自由探索生效中'
                  : snapshot.exploration.enabled
                    ? '自由探索未生效'
                    : '自由探索未开启'}
            </Pill>
            <Pill tone={readyCards > 0 ? 'info' : 'neutral'}>
              {snapshot === null ? '—' : `${readyCards}/${snapshot.cards.length} 项能力可用`}
            </Pill>
          </div>
          <div className="row-gap">
            <Button variant="primary" onClick={restart}>
              重新配置
            </Button>
            {s.boot.keyStatus.configured ? null : (
              <Button onClick={restart}>配置 API</Button>
            )}
            <Button onClick={() => void s.openChat()}>打开聊天</Button>
            <Button variant="subtle" onClick={() => void s.refreshBoot()}>
              刷新状态
            </Button>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="overview-capabilities">
        <header className="section-head">
          <h2 id="overview-capabilities">能力状态</h2>
        </header>
        <div className="section-body">
          <CapabilitySummary />
        </div>
      </section>

      <section className="section" aria-labelledby="overview-controls">
        <header className="section-head">
          <h2 id="overview-controls">运行控制</h2>
        </header>
        <div className="section-body">
          <div className="overview-actions">
            <div className="overview-action">
              <strong>停止当前操作</strong>
              <Button
                variant="danger"
                onClick={() => {
                  if (
                    currentTask !== null &&
                    window.confirm(`停止任务“${taskLabel(currentTask)}”？`)
                  ) {
                    void s.taskAction(currentTask.id, 'cancel')
                  }
                  void s.stopCua()
                }}
              >
                立即停止
              </Button>
            </div>
            <div className="overview-action">
              <strong>暂停自主探索</strong>
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
            <div className="overview-action">
              <strong>安静</strong>
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
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
