import { useSettings } from '../context'
import { Button, Empty, Pill } from '../ui'

/** 审批授权记录：本会话/始终允许；红区不会出现在这里。 */
export function ApprovalGrantsPanel(): React.JSX.Element {
  const s = useSettings()
  return (
    <section className="section" aria-labelledby="activity-approvals">
      <header className="section-head">
        <h2 id="activity-approvals">审批授权</h2>
        <div className="section-actions">
          <Button onClick={() => void s.loadApprovalGrants()}>刷新</Button>
          <Button
            variant="danger"
            disabled={s.approvalGrants.length === 0}
            onClick={() => void s.clearApprovalGrants()}
          >
            全部清除
          </Button>
        </div>
      </header>
      <div className="section-body">
        {s.approvalGrants.length === 0 ? (
          <Empty>没有生效中的“本会话”或“始终允许”授权。</Empty>
        ) : (
          <ul className="undo-list">
            {s.approvalGrants.map((grant, index) => (
              <li key={`${grant.tool}-${grant.scope}-${index}`}>
                <Pill tone={grant.scope === 'always' ? 'warn' : 'info'}>
                  {grant.scope === 'always' ? '始终允许' : '本会话'}
                </Pill>
                <span className="mono grow">{grant.tool}</span>
                <span className="muted small">
                  {grant.expiresAt === null
                    ? '不自动过期'
                    : `到期 ${new Date(grant.expiresAt).toLocaleString()}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** 文件撤销记录与撤销动作。 */
export function UndoPanel(): React.JSX.Element {
  const s = useSettings()
  return (
    <section className="section" aria-labelledby="activity-undo">
      <header className="section-head">
        <h2 id="activity-undo">文件撤销</h2>
        <div className="section-actions">
          <Button onClick={() => void s.loadUndo()}>刷新</Button>
        </div>
      </header>
      <div className="section-body">
        {s.undoEntries.length === 0 ? (
          <Empty>暂无可撤销记录。</Empty>
        ) : (
          <>
            <ul className="undo-list">
              {s.undoEntries.slice(0, 30).map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  <Pill tone="info">{entry.kind}</Pill>
                  <span className="mono dim">{entry.path}</span>
                  <span className="muted small">{new Date(entry.at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
            <div className="row-gap">
              <Button variant="primary" onClick={() => void s.undoNow(1)}>
                撤销最近一次
              </Button>
              <Button onClick={() => void s.undoNow(5)}>撤销最近五次</Button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

/** 系统操作记录：目标只在本机显示，不写日志、不进入模型。 */
export function SystemRecentPanel(): React.JSX.Element {
  const s = useSettings()
  return (
    <section className="section" aria-labelledby="activity-system">
      <header className="section-head">
        <h2 id="activity-system">系统操作</h2>
        <div className="section-actions">
          <Button onClick={() => void s.loadSystemRecent()}>刷新</Button>
          <Button
            variant="danger"
            disabled={s.systemRecent.length === 0}
            onClick={() => void s.clearSystemRecent()}
          >
            清除记录
          </Button>
        </div>
      </header>
      <div className="section-body">
        {s.systemRecent.length === 0 ? (
          <Empty>还没有系统操作记录。</Empty>
        ) : (
          <div className="raw-table-wrap">
            <table className="raw-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>工具</th>
                  <th>目标（仅本机）</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {s.systemRecent
                  .slice()
                  .reverse()
                  .map((entry, index) => (
                    <tr key={`${entry.at}-${index}`}>
                      <td>{new Date(entry.at).toLocaleTimeString()}</td>
                      <td className="mono">{entry.tool}</td>
                      <td className="mono small">{entry.target}</td>
                      <td>{entry.ok ? '成功' : '失败'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
