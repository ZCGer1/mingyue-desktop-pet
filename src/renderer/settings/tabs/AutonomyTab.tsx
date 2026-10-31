import type { TaskState, TaskView } from '../../../core/taskTypes'
import type {
  AutonomyScheduleState,
  CapabilityGrantView,
  CompanionExperienceView,
  CompanionInterestView
} from '../../../shared/ipc'
import { DiscoveryList } from '../components/DiscoveryList'
import {
  ApprovalGrantsPanel,
  SystemRecentPanel,
  UndoPanel
} from '../components/RecordPanels'
import { useSettings } from '../context'
import { Button, Empty, Pill } from '../ui'

/**
 * 活动与任务：任务、发现、兴趣、经历与各类记录。
 *
 * 持久化配置（自主模式、预算、审批策略）在「电脑能力 → 自主与授权」；
 * 这里只展示状态与即时动作。
 */

const STATE_LABELS: Record<TaskState, string> = {
  queued: '排队中',
  observing: '观察中',
  planning: '计划中',
  running: '执行中',
  waiting_approval: '等待审批',
  waiting_user: '等你处理',
  paused: '已暂停',
  blocked: '受阻',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info'

const STATE_TONES: Record<TaskState, Tone> = {
  queued: 'neutral',
  observing: 'info',
  planning: 'info',
  running: 'info',
  waiting_approval: 'warn',
  waiting_user: 'warn',
  paused: 'warn',
  blocked: 'bad',
  completed: 'ok',
  failed: 'bad',
  cancelled: 'neutral'
}

const SOURCE_LABELS: Record<TaskView['source'], string> = {
  'user-chat': '完整聊天',
  'quick-chat': '快捷聊天',
  autonomy: '自主探索'
}

const CAPABILITY_LABELS: Record<string, string> = {
  'desktop.observe': '观察屏幕',
  'desktop.input': '键鼠输入',
  'app.launch': '启动应用',
  'workspace.write': '写文件',
  'workspace.delete': '删除文件',
  'terminal.run': '终端命令',
  'web.read': '读取网页',
  'web.open': '打开网页',
  'memory.write': '写入记忆'
}

const SCOPE_LABELS: Record<CapabilityGrantView['scope'], string> = {
  turn: '本轮',
  task: '本任务',
  session: '本会话',
  always: '长期'
}

const GRANT_SOURCE_LABELS: Record<CapabilityGrantView['source'], string> = {
  'user-turn': '用户当轮',
  approval: '用户审批',
  'config-consent': '配置同意',
  'task-preauthorization': '任务预授权'
}

const TERMINAL: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'cancelled'])

const INTEREST_STATUS_LABELS: Record<CompanionInterestView['status'], string> = {
  active: '活跃',
  paused: '暂停',
  done: '已完成',
  abandoned: '已放弃'
}

const INTEREST_STATUS_TONES: Record<CompanionInterestView['status'], Tone> = {
  active: 'ok',
  paused: 'warn',
  done: 'neutral',
  abandoned: 'neutral'
}

const EXPERIENCE_KIND_LABELS: Record<CompanionExperienceView['kind'], string> = {
  observe: '观察',
  read: '读取',
  write: '写下',
  chat: '聊天',
  task: '任务'
}

const SCHEDULE_STATE: Record<
  AutonomyScheduleState,
  { label: string; tone: Tone }
> = {
  ready: { label: '可以开始', tone: 'ok' },
  waiting: { label: '等待下一次机会', tone: 'info' },
  'waiting-condition': { label: '等待条件', tone: 'info' },
  quiet: { label: '静默后台活动', tone: 'info' },
  active: { label: '进行中', tone: 'info' },
  resting: { label: '模型休息', tone: 'neutral' },
  paused: { label: '已暂停', tone: 'warn' },
  disabled: { label: '已关闭', tone: 'neutral' },
  blocked: { label: '运行时未就绪', tone: 'bad' }
}

const READINESS_REASON: Record<string, string> = {
  'autonomy-disabled': '自主唤醒已关闭',
  'mode-not-explore': '当前不是自主探索模式',
  'provider-key-missing': '没有可用的模型密钥',
  'no-effective-scope': '没有任何可读/可写的范围',
  'not-started': '运行时尚未就绪',
  'explore-paused': '探索被手动暂停',
  'explicit-rest': '她选择了有界休息',
  'waiting-condition': '她正在等待一个条件',
  'autonomy-waiting': '等待条件/复查时间',
  'quiet-background': '静默后台活动',
  paused: '全部暂停',
  busy: '正在处理其他对话或任务',
  'active-autonomy-task': '已有自主目标在继续',
  'next-scheduled': '等待下一次探索机会',
  'wake-quiet': '当前处于安静时段',
  'wake-disabled': '唤醒通道已关闭',
  'wake-paused': '唤醒通道已暂停',
  'notes-unavailable': '笔记目录当前不可访问',
  'cua-not-ready': '输入所需的电脑操作授权未齐',
  'window-capture-off': '未开启按窗口截图'
}

const PROGRESS_KIND_LABELS: Record<string, string> = {
  observation: '新观察',
  action: '完成动作',
  artifact: '作品已回读',
  planning: '建立小目标',
  rest: '休息',
  no_progress: '无实际进展'
}

const LAST_STATE_LABELS: Record<'progress' | 'rest' | 'no_progress' | 'unknown', string> = {
  progress: '有进展',
  rest: '休息',
  no_progress: '无进展',
  unknown: '尚无记录'
}

function timeLabel(at: number | null): string {
  if (at === null) return '—'
  try {
    return new Date(at).toLocaleString()
  } catch {
    return '—'
  }
}

function readinessReason(code: string | null): string {
  if (code === null) return '—'
  return READINESS_REASON[code] ?? code
}

function TaskCard({ task }: { task: TaskView }): React.JSX.Element {
  const s = useSettings()
  const active = !TERMINAL.has(task.state)
  const canResume =
    task.state === 'paused' || task.state === 'waiting_user' || task.state === 'blocked'

  return (
    <div className="task-card">
      <div className="task-card-head">
        <strong>{task.title}</strong>
        <Pill tone={STATE_TONES[task.state]}>{STATE_LABELS[task.state]}</Pill>
      </div>
      <div className="muted small">{task.intent}</div>
      <div className="kv">
        <span>来源</span>
        <span>{SOURCE_LABELS[task.source]}</span>
      </div>
      <div className="kv">
        <span>预算</span>
        <span>
          {task.toolCalls} / {task.maxToolCalls} 次工具 · 最长 {task.maxMinutes} 分钟
        </span>
      </div>
      <div className="kv">
        <span>计划时间</span>
        <span>{timeLabel(task.scheduledAt)}</span>
      </div>
      {task.capabilities.length > 0 && (
        <div className="kv">
          <span>任务范围</span>
          <span>
            {task.capabilities
              .map((capability) => CAPABILITY_LABELS[capability] ?? capability)
              .join('、')}
          </span>
        </div>
      )}
      {task.checkpoint !== null && (
        <div className="kv">
          <span>当前步骤</span>
          <span>{task.checkpoint}</span>
        </div>
      )}
      {task.waitReason !== null && <p className="inline-warn">{task.waitReason}</p>}
      {task.lastError !== null && <p className="inline-warn">上次错误：{task.lastError}</p>}
      {task.result !== null && <p className="muted small">结果：{task.result}</p>}
      <div className="row-gap">
        {active && task.state !== 'paused' && (
          <Button variant="subtle" onClick={() => void s.taskAction(task.id, 'pause')}>
            暂停
          </Button>
        )}
        {canResume && (
          <Button variant="primary" onClick={() => void s.taskAction(task.id, 'resume')}>
            恢复
          </Button>
        )}
        {active && (
          <Button
            variant="danger"
            onClick={() => {
              if (window.confirm(`取消任务「${task.title}」并撤销它的任务授权？`)) {
                void s.taskAction(task.id, 'cancel')
              }
            }}
          >
            取消任务
          </Button>
        )}
      </div>
    </div>
  )
}

function InterestCard({ interest }: { interest: CompanionInterestView }): React.JSX.Element {
  const s = useSettings()
  return (
    <div className="task-card">
      <div className="task-card-head">
        <strong>{interest.title}</strong>
        <Pill tone={INTEREST_STATUS_TONES[interest.status]}>
          {INTEREST_STATUS_LABELS[interest.status]}
        </Pill>
      </div>
      <div className="kv">
        <span>结束条件</span>
        <span>{interest.endCondition}</span>
      </div>
      {interest.nextStep !== null && (
        <div className="kv">
          <span>下一步</span>
          <span>{interest.nextStep}</span>
        </div>
      )}
      <div className="kv">
        <span>进展</span>
        <span>
          专注 {interest.focusCount} 次 · 聊过 {interest.talkCount} 次 · 成果{' '}
          {interest.artifacts.length} 个
          {interest.taskCount > 0 ? ` · 关联任务 ${interest.taskCount} 个` : ''}
        </span>
      </div>
      <div className="kv">
        <span>下次回访</span>
        <span>{timeLabel(interest.nextRevisitAt)}</span>
      </div>
      {interest.artifacts.length > 0 && (
        <div className="kv">
          <span>她的作品</span>
          <span className="mono">{interest.artifacts.join('、')}</span>
        </div>
      )}
      <div className="row-gap">
        {interest.status === 'active' && (
          <Button
            variant="subtle"
            onClick={() => void s.companionAction('pause-interest', interest.id)}
          >
            暂停
          </Button>
        )}
        {interest.status === 'paused' && (
          <Button
            variant="primary"
            onClick={() => void s.companionAction('resume-interest', interest.id)}
          >
            继续
          </Button>
        )}
        {interest.status !== 'done' && interest.status !== 'abandoned' && (
          <Button
            variant="subtle"
            onClick={() => {
              if (window.confirm(`结束兴趣「${interest.title}」？`)) {
                void s.companionAction('done-interest', interest.id)
              }
            }}
          >
            结束
          </Button>
        )}
        <Button
          variant="danger"
          onClick={() => {
            if (window.confirm(`删除兴趣「${interest.title}」及关联经历？此操作不可撤销。`)) {
              void s.companionAction('delete-interest', interest.id)
            }
          }}
        >
          删除
        </Button>
      </div>
    </div>
  )
}

function GrantRow({ grant }: { grant: CapabilityGrantView }): React.JSX.Element {
  const s = useSettings()
  return (
    <div className="task-card">
      <div className="task-card-head">
        <strong>{CAPABILITY_LABELS[grant.capability] ?? grant.capability}</strong>
        <Pill tone={grant.autoApproveYellow ? 'warn' : 'neutral'}>
          {SCOPE_LABELS[grant.scope]}
          {grant.autoApproveYellow ? ' · 黄区免问' : ''}
        </Pill>
      </div>
      <div className="kv">
        <span>来源</span>
        <span>{GRANT_SOURCE_LABELS[grant.source]}</span>
      </div>
      <div className="kv">
        <span>到期</span>
        <span>{timeLabel(grant.expiresAt)}</span>
      </div>
      <div className="row-gap">
        <Button
          variant="danger"
          onClick={() => {
            if (window.confirm('撤销这条任务授权？正在执行的该任务会立即停下。')) {
              void s.revokeCapability(grant.id)
            }
          }}
        >
          撤销授权
        </Button>
      </div>
    </div>
  )
}

export function AutonomyTab(): React.JSX.Element {
  const s = useSettings()
  const tasks = s.tasks
  const grants = s.capabilityGrants
  const activeTasks = tasks.filter((task) => !TERMINAL.has(task.state))
  const doneTasks = tasks.filter((task) => TERMINAL.has(task.state))
  const companion = s.companion
  const readiness = companion?.readiness ?? null
  const openInterests =
    companion === null
      ? []
      : companion.interests.filter(
          (interest) => interest.status === 'active' || interest.status === 'paused'
        )

  return (
    <div className="stack">
      <section className="section" aria-labelledby="activity-status">
        <header className="section-head">
          <h2 id="activity-status">自主状态</h2>
          <div className="section-actions">
            <Button variant="subtle" onClick={() => void s.loadCompanion()}>
              刷新
            </Button>
          </div>
        </header>
        <div className="section-body">
          {readiness === null ? (
            <Empty>正在读取…</Empty>
          ) : (
            <>
              <div className="kv">
                <span>能力状态</span>
                <span>
                  <Pill
                    tone={
                      readiness.capability.state === 'ready'
                        ? 'ok'
                        : readiness.capability.state === 'limited'
                          ? 'warn'
                          : 'bad'
                    }
                  >
                    {readiness.capability.state === 'ready'
                      ? '就绪'
                      : readiness.capability.state === 'limited'
                        ? '受限'
                        : '阻塞'}
                  </Pill>
                  {readiness.capability.reasons.length > 0 ? (
                    <span className="muted small">
                      {' '}
                      {readiness.capability.reasons.map(readinessReason).join('、')}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="kv">
                <span>当前调度</span>
                <span>
                  <Pill tone={SCHEDULE_STATE[readiness.schedule.state].tone}>
                    {SCHEDULE_STATE[readiness.schedule.state].label}
                  </Pill>
                  {readiness.schedule.reason === null ? null : (
                    <span className="muted small"> {readinessReason(readiness.schedule.reason)}</span>
                  )}
                </span>
              </div>
              <div className="kv">
                <span>下一次机会</span>
                <span>{timeLabel(readiness.schedule.nextAt)}</span>
              </div>
              <div className="kv">
                <span>上一轮结果</span>
                <span>
                  {readiness.lastRound.at === null
                    ? '还没有'
                    : `${LAST_STATE_LABELS[readiness.lastRound.nextState]} · ${timeLabel(readiness.lastRound.at)}`}
                  {readiness.lastRound.progressKinds.length > 0 ? (
                    <span className="muted small">
                      {' '}
                      ·{' '}
                      {readiness.lastRound.progressKinds
                        .map((kind) => PROGRESS_KIND_LABELS[kind] ?? kind)
                        .join('、')}
                    </span>
                  ) : null}
                </span>
              </div>
              {readiness.scopeReasons.length > 0 ? (
                <div className="inline-warn">
                  <strong>实际范围阻塞：</strong>
                  <ul>
                    {readiness.scopeReasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                  <Button variant="subtle" onClick={() => s.navigate('computer', 'exploration')}>
                    去自主与授权
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>

      <section className="section" aria-labelledby="activity-active">
        <header className="section-head">
          <h2 id="activity-active">进行中的任务</h2>
          <div className="section-actions">
            <Button variant="subtle" onClick={() => void s.loadTasks()}>
              刷新
            </Button>
          </div>
        </header>
        <div className="section-body">
          {activeTasks.length === 0 ? (
            <Empty>当前没有进行中的任务。</Empty>
          ) : (
            <div className="task-list">
              {activeTasks.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          )}
        </div>
      </section>

      <DiscoveryList />

      <section className="section" aria-labelledby="activity-interests">
        <header className="section-head">
          <h2 id="activity-interests">兴趣与经历</h2>
          <div className="section-actions">
            <Button
              variant="subtle"
              onClick={() => {
                if (window.confirm('清空全部兴趣、经历与探索指纹？任务与记忆文件不会被删除。')) {
                  void s.companionAction('clear-all')
                }
              }}
            >
              全部清空
            </Button>
          </div>
        </header>
        <div className="section-body">
          {companion === null ? (
            <Empty>正在读取…</Empty>
          ) : !companion.enabled ? (
            <Empty>记忆功能已关闭；她不会记录兴趣与经历。</Empty>
          ) : (
            <>
              <p className="muted small">
                活跃 {companion.counts.active} · 暂停 {companion.counts.paused} · 完成{' '}
                {companion.counts.done} · 放弃 {companion.counts.abandoned} · 经历{' '}
                {companion.counts.experiences} 条
              </p>
              {companion.revisits.length > 0 && (
                <p className="muted small">
                  到期回访：{companion.revisits.map((interest) => interest.title).join('、')}
                </p>
              )}
              {openInterests.length === 0 ? (
                <Empty>当前没有进行中的兴趣。</Empty>
              ) : (
                <div className="task-list">
                  {openInterests.map((interest) => (
                    <InterestCard key={interest.id} interest={interest} />
                  ))}
                </div>
              )}
              {companion.experiences.length > 0 && (
                <div className="task-list">
                  {companion.experiences.slice(0, 6).map((experience) => (
                    <div className="task-card" key={experience.id}>
                      <div className="task-card-head">
                        <strong>{experience.summary}</strong>
                        <Pill tone="info">{EXPERIENCE_KIND_LABELS[experience.kind]}</Pill>
                      </div>
                      <div className="kv">
                        <span>来源</span>
                        <span>
                          {experience.tool} · {timeLabel(experience.at)}
                          {experience.targetRef === null ? '' : ` · ${experience.targetRef}`}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="row-gap">
                <Button
                  variant="subtle"
                  onClick={() => void s.companionAction('clear-experiences')}
                >
                  清空最近经历
                </Button>
              </div>
            </>
          )}
        </div>
      </section>

      <section id="grants" className="section page-anchor-block" aria-labelledby="activity-task-grants">
        <header className="section-head">
          <h2 id="activity-task-grants">任务授权</h2>
          <div className="section-actions">
            <Button variant="subtle" onClick={() => void s.loadCapabilityGrants()}>
              刷新
            </Button>
          </div>
        </header>
        <div className="section-body">
          {grants.length === 0 ? (
            <Empty>没有仍在生效的任务授权。</Empty>
          ) : (
            <div className="task-list">
              {grants.map((grant) => (
                <GrantRow key={grant.id} grant={grant} />
              ))}
            </div>
          )}
        </div>
      </section>

      <ApprovalGrantsPanel />
      <UndoPanel />
      <SystemRecentPanel />

      {doneTasks.length > 0 && (
        <section className="section" aria-labelledby="activity-done">
          <header className="section-head">
            <h2 id="activity-done">最近结束的任务</h2>
          </header>
          <div className="section-body">
            <div className="task-list">
              {doneTasks.slice(0, 20).map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
