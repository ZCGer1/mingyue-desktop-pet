import { effectiveExploration } from '../../../../shared/exploration'
import { useSettings } from '../../context'
import { Button, Field, Pill, StatusLine, Toggle } from '../../ui'

const MODE_LABELS: Record<string, string> = {
  model: '模型判断',
  strict: '全部询问',
  auto: '自动执行可逆操作'
}

/**
 * 自主与授权：六项能力共用的运行授权、审批策略、预算与恢复设置。
 *
 * 各能力是否可自主使用在对应子页编辑；这里只汇总范围，避免重复编辑同一字段。
 */
export function AutonomySection(): React.JSX.Element {
  const s = useSettings()
  const autonomy = s.config.autonomy
  const exploration = s.config.exploration
  const view = effectiveExploration(s.config)

  const grantExploration = (): void => {
    const now = Date.now()
    s.update(['exploration', 'enabled'], true)
    s.update(['exploration', 'grantedAt'], now)
    s.update(
      ['exploration', 'sessionExpiresAt'],
      exploration.scope === 'session' ? now + autonomy.sessionGrantMinutes * 60_000 : null
    )
  }

  const setExplorationEnabled = (checked: boolean): void => {
    if (checked) {
      grantExploration()
      return
    }
    // 撤销是立即动作：只写已保存的授权，不提交其他草稿。
    void s.revokeExplorationNow()
  }

  const setExplorationScope = (scope: 'session' | 'always'): void => {
    const now = Date.now()
    s.update(['exploration', 'scope'], scope)
    if (exploration.enabled) {
      s.update(['exploration', 'grantedAt'], now)
      s.update(
        ['exploration', 'sessionExpiresAt'],
        scope === 'session' ? now + autonomy.sessionGrantMinutes * 60_000 : null
      )
    }
  }

  const scopes = [
    view.web ? '网页' : null,
    view.browserTabs ? '标签页' : null,
    view.apps ? '应用' : null,
    view.windows ? '窗口' : null,
    view.fullScreen ? '整屏' : null,
    view.fileRead ? '文件只读' : null,
    view.artifacts ? '作品' : null,
    view.edits ? '连续编辑' : null
  ].filter((item): item is string => item !== null)

  return (
    <div className="stack">
      <div className="row-gap">
        <Toggle
          label="允许自由探索"
          checked={exploration.enabled}
          onChange={setExplorationEnabled}
        />
        <Toggle
          label="允许自主 tick"
          checked={autonomy.enabled}
          onChange={(checked) => s.update(['autonomy', 'enabled'], checked)}
        />
      </div>
      <StatusLine label="授权状态">
        <Pill tone={view.active ? 'ok' : exploration.enabled ? 'warn' : 'neutral'}>
          {view.active ? '生效中' : exploration.enabled ? '未生效' : '未授权'}
        </Pill>
        {exploration.scope === 'session' && exploration.sessionExpiresAt !== null ? (
          <span className="muted small">
            {' '}
            到期 {new Date(exploration.sessionExpiresAt).toLocaleString()}
          </span>
        ) : null}
        {exploration.enabled && !view.active ? (
          <span className="muted small">
            {' '}
            {exploration.grantedAt === null ? '缺少授权时间' : '本会话授权已到期'}
          </span>
        ) : null}
      </StatusLine>
      <StatusLine label="生效范围">
        {scopes.length === 0 ? '没有可用范围' : scopes.join('、')}
      </StatusLine>

      <div className="grid-2">
        <Field label="自主模式">
          <select
            className="input"
            value={autonomy.mode}
            onChange={(event) => s.update(['autonomy', 'mode'], event.target.value)}
          >
            <option value="assigned">仅指定任务</option>
            <option value="assist">主动帮忙</option>
            <option value="explore">自主探索</option>
          </select>
        </Field>
        <Field label="授权有效期">
          <select
            className="input"
            value={exploration.scope}
            onChange={(event) =>
              setExplorationScope(event.target.value === 'always' ? 'always' : 'session')
            }
          >
            <option value="session">仅本会话</option>
            <option value="always">长期有效</option>
          </select>
        </Field>
        <Field label="审批策略">
          <select
            className="input"
            value={autonomy.approvalMode}
            onChange={(event) => s.update(['autonomy', 'approvalMode'], event.target.value)}
          >
            <option value="model">模型判断</option>
            <option value="strict">全部询问</option>
            <option value="auto">自动执行绿区/黄区</option>
          </select>
        </Field>
        <Field label="接管冷却（秒）">
          <input
            className="input input-num"
            type="number"
            min={0}
            max={30}
            value={Math.round(autonomy.takeoverCooldownMs / 1000)}
            onChange={(event) =>
              s.update(
                ['autonomy', 'takeoverCooldownMs'],
                Math.min(30, Math.max(0, Number(event.target.value))) * 1000
              )
            }
          />
        </Field>
      </div>
      <p className="muted small">
        当前：{MODE_LABELS[autonomy.approvalMode] ?? autonomy.approvalMode}。红区始终必须人工确认。
      </p>
      <div className="row-gap">
        <Button variant="danger" onClick={() => void s.revokeExplorationNow()}>
          立即撤销授权
        </Button>
        {exploration.enabled && exploration.grantedAt === null ? (
          <Button onClick={grantExploration}>重新授权</Button>
        ) : null}
        <span className="muted small">撤销立即生效，不需要保存</span>
      </div>

      <details className="advanced">
        <summary>任务预算与配额</summary>
        <div className="grid-2">
          <Field label="单任务最长（分钟）">
            <input
              className="input input-num"
              type="number"
              min={1}
              max={120}
              value={autonomy.task.maxMinutes}
              onChange={(event) =>
                s.update(
                  ['autonomy', 'task', 'maxMinutes'],
                  Math.min(120, Math.max(1, Number(event.target.value)))
                )
              }
            />
          </Field>
          <Field label="单任务最多工具调用">
            <input
              className="input input-num"
              type="number"
              min={1}
              max={200}
              value={autonomy.task.maxToolCalls}
              onChange={(event) =>
                s.update(
                  ['autonomy', 'task', 'maxToolCalls'],
                  Math.min(200, Math.max(1, Number(event.target.value)))
                )
              }
            />
          </Field>
          <Field label="已完成任务保留（天）">
            <input
              className="input input-num"
              type="number"
              min={1}
              max={365}
              value={autonomy.task.retentionDays}
              onChange={(event) =>
                s.update(
                  ['autonomy', 'task', 'retentionDays'],
                  Math.min(365, Math.max(1, Number(event.target.value)))
                )
              }
            />
          </Field>
          <Field label="会话授权有效期（分钟）">
            <input
              className="input input-num"
              type="number"
              min={5}
              max={1440}
              value={autonomy.sessionGrantMinutes}
              onChange={(event) =>
                s.update(
                  ['autonomy', 'sessionGrantMinutes'],
                  Math.min(1440, Math.max(5, Number(event.target.value)))
                )
              }
            />
          </Field>
          <Field label="每小时自动操作上限">
            <input
              className="input input-num"
              type="number"
              min={1}
              max={300}
              value={autonomy.maxAutoOpsPerHour}
              onChange={(event) =>
                s.update(
                  ['autonomy', 'maxAutoOpsPerHour'],
                  Math.min(300, Math.max(1, Number(event.target.value)))
                )
              }
            />
          </Field>
          <Field label="自动写入备份数量">
            <input
              className="input input-num"
              type="number"
              min={0}
              max={100}
              value={autonomy.autoWriteBackupCount}
              onChange={(event) =>
                s.update(
                  ['autonomy', 'autoWriteBackupCount'],
                  Math.min(100, Math.max(0, Number(event.target.value)))
                )
              }
            />
          </Field>
          <Field label="审批超时（秒）">
            <input
              className="input input-num"
              type="number"
              min={30}
              max={3600}
              value={Math.round(s.config.approval.ttlMs / 1000)}
              onChange={(event) =>
                s.update(
                  ['approval', 'ttlMs'],
                  Math.max(30, Math.min(3600, Number(event.target.value))) * 1000
                )
              }
            />
          </Field>
        </div>
        <Toggle
          label="重启后自动恢复安全任务"
          checked={autonomy.task.autoResume}
          onChange={(checked) => s.update(['autonomy', 'task', 'autoResume'], checked)}
        />
        <Toggle
          label="允许本会话/始终允许授权"
          checked={s.config.approval.sessionAllowExactCommand}
          onChange={(checked) =>
            s.update(['approval', 'sessionAllowExactCommand'], checked)
          }
        />
      </details>
    </div>
  )
}
