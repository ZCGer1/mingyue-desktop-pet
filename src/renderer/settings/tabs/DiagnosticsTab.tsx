import { useEffect, useState } from 'react'
import type { BrowserBridgeStatusView } from '../../../shared/ipc'
import { turnFailureDiagnosticLine } from '../../../shared/turnFailureText'
import { useSettings } from '../context'
import { Button, Empty, Pill, Section } from '../ui'

const PHASE_LABEL: Record<string, string> = {
  idle: '待机',
  delivering: '投递事件',
  model: '模型轮',
  tools: '工具轮',
  backoff: '重试等待',
  handoff: '上下文交接'
}

const AMBIENT_PAUSE_LABEL: Record<string, string> = {
  'pet-disabled': '桌宠已关闭',
  'reduced-motion': '减少动态效果',
  'page-hidden': '宠物页隐藏',
  suspended: '系统挂起',
  suspend: '系统挂起',
  lock: '锁屏',
  'pet-hidden': '宠物窗口隐藏'
}

export function DiagnosticsTab(): React.JSX.Element {
  const s = useSettings()
  const d = s.diagnostics
  const boot = s.boot
  const runtime = d?.runtime
  const [browser, setBrowser] = useState<BrowserBridgeStatusView | null>(null)

  // 只读取连接/计数；诊断页不会展示页面标题、域名或摘要。
  useEffect(() => {
    let cancelled = false
    void window.mingyue.settings
      .getBrowserStatus()
      .then((status) => {
        if (!cancelled) setBrowser(status)
      })
      .catch(() => {
        if (!cancelled) setBrowser(null)
      })
    return () => {
      cancelled = true
    }
  }, [d?.generatedAt])

  const diag = record(d?.diagnostics)
  const persona = record(diag['persona'])
  const core = record(diag['core'])
  const wake = record(core['wake'])
  const approvals = record(core['approvals'])
  const activity = record(diag['activity'])
  const ambient = record(diag['ambient'])
  const ambientState = record(ambient['pageState'])
  const ambientLook = record(ambient['lookAround'])
  const companion = record(diag['companion'])
  const cadence = record(companion['cadence'])
  const decisions = Array.isArray(cadence['decisions']) ? cadence['decisions'] : []
  const metrics = record(companion['metrics'])
  const metricConsiderations = record(metrics['considerations'])
  const metricSpoke = record(metrics['spoke'])
  const metricTasks = record(metrics['tasks'])
  const metricTools = record(metrics['tools'])
  const metricActions = record(metrics['actions'])
  const metricExploration = record(metrics['exploration'])
  const metricReactions = record(metrics['reactions'])
  const metricCost = record(metrics['cost'])
  const metricProcess = record(metrics['process'])
  const metricFile = record(metrics['file'])
  const experiences = s.companion?.experiences.slice(0, 8) ?? []

  return (
    <div className="stack">
      <Section
        title="运行状态"
        
        actions={
          <div className="row-gap">
            <Button
              variant="primary"
              onClick={() => {
                void s.loadDiagnostics()
                void s.loadCompanion()
              }}
            >
              刷新诊断
            </Button>
            <Button onClick={() => void s.exportDiagnostics()}>导出脱敏诊断包</Button>
            <Button onClick={() => void s.loadUndo()}>刷新撤销列表</Button>
          </div>
        }
      >
        <div className="stat-grid">
          <Stat label="版本" value={boot.version} />
          <Stat label="平台" value={boot.platform} />
          <Stat label="运行相位" value={runtime === undefined ? '—' : PHASE_LABEL[runtime.phase] ?? runtime.phase} />
          <Stat label="事件队列" value={runtime === undefined ? '—' : String(runtime.queue)} />
          <Stat
            label="下一批到期"
            value={
              runtime?.nextDueAt === null || runtime?.nextDueAt === undefined
                ? '无'
                : new Date(runtime.nextDueAt).toLocaleTimeString()
            }
          />
          <Stat
            label="已投递游标"
            value={runtime === undefined ? '—' : String(runtime.lastDeliveredCursor)}
          />
          <Stat
            label="暂停总线"
            value={boot.agentPaused ? '是' : runtime?.paused === true ? '是' : '否'}
          />
          <Stat
            label="待审批"
            value={runtime === undefined ? '—' : String(runtime.approvalsPending)}
          />
          <Stat label="对话暂停" value={boot.agentPaused ? '是' : '否'} />
          <Stat label="行为感知暂停" value={boot.activityPaused ? '是' : '否'} />
          <Stat label="桌宠页面" value={boot.petUrl === null ? '未启动' : '已启动'} />
          {d !== null && (
            <Stat label="诊断生成时间" value={new Date(d.generatedAt).toLocaleTimeString()} />
          )}
        </div>
        {runtime !== undefined && (
          <div className="stat-grid">
            <Stat label="本会话轮数" value={String(runtime.session.rounds)} />
            <Stat label="估算上下文 token" value={String(runtime.session.estTokens)} />
            <Stat
              label="上下文硬上限"
              value={runtime.session.hardTokens === null ? '未设置' : String(runtime.session.hardTokens)}
            />
            <Stat label="消息条数" value={String(runtime.session.messageCount)} />
            <Stat label="模型调用" value={String(runtime.usage.calls)} />
            <Stat label="输入 token" value={String(runtime.usage.promptTokens)} />
            <Stat label="输出 token" value={String(runtime.usage.completionTokens)} />
            <Stat label="估算费用" value={`¥${runtime.usage.estimatedCny.toFixed(4)}`} />
          </div>
        )}
        {boot.petUrl !== null && <div className="path-box">桌宠页面：{boot.petUrl}</div>}
      </Section>

      <Section
        title="自主与感知"
        
      >
        <div className="stat-grid">
          <Stat
            label="自主 tick"
            value={
              persona['enabled'] === false
                ? '已关闭'
                : persona['started'] === true
                  ? '运行中'
                  : '未启动'
            }
          />
          <Stat label="下次 tick" value={timeOrDash(persona['nextAt'])} />
          <Stat label="连续沉默" value={String(numberOrDash(persona['silentStreak']))} />
          <Stat
            label="暂停跳过"
            value={String(numberOrDash(persona['pauseSkipped']))}
          />
          <Stat label="最近 tick" value={timeOrDash(persona['lastTickAt'])} />
          <Stat
            label="探索暂停截止"
            value={timeOrDash(persona['explorePausedUntil'])}
          />
          <Stat label="待唤醒事件" value={String(numberOrDash(core['pendingWake']))} />
          <Stat label="时间线条数" value={String(numberOrDash(activity['timelineEntries']))} />
          <Stat
            label="感知取样"
            value={
              activity['enabled'] === false
                ? '关闭'
                : activity['sampling'] === true
                  ? '进行中'
                  : activity['userPaused'] === true
                    ? '已暂停'
                    : '等待'
            }
          />
          <Stat
            label="当前类别"
            value={stringOrDash(activity['currentCategory'])}
          />
        </div>
        <div className="stat-grid">
          <Stat label="最近自主唤醒" value={timeOrDash(wake['lastWakeAt'])} />
          <Stat
            label="本小时唤醒（统计）"
            value={numberOrDash(wake['wakesThisHour'])}
          />
          <Stat label="唤醒上限" value="不设上限" />
          <Stat
            label="今日唤醒（统计）"
            value={numberOrDash(wake['wakesToday'])}
          />
          <Stat label="唤醒间隔" value={secondsOrDash(wake['wakeGapMs'])} />
          <Stat
            label="说话安静截止"
            value={timeOrDash(wake['speechQuietUntil'])}
          />
          <Stat
            label="陪伴唤醒本小时（统计）"
            value={numberOrDash(record(wake['companion'])['wakesThisHour'])}
          />
          <Stat
            label="浏览器桥"
            value={
              browser === null
                ? '—'
                : browser.bridge.running
                  ? `已连接:${browser.bridge.port ?? '—'}`
                  : '未运行'
            }
          />
          <Stat
            label="页面事件/小时"
            value={browser === null ? '—' : String(browser.page.eventsLastHour)}
          />
          <Stat
            label="当前页"
            value={browser === null ? '—' : browser.page.hasPage ? '有（不显示内容）' : '无'}
          />
        </div>
        <div className="stat-grid">
          <Stat label="绿区自动/询问" value={`${numberOrDash(approvals['autoGreen'])} / ${numberOrDash(approvals['askGreen'])}`} />
          <Stat label="黄区自动/询问" value={`${numberOrDash(approvals['autoYellow'])} / ${numberOrDash(approvals['askYellow'])}`} />
          <Stat label="红区询问" value={String(numberOrDash(approvals['askRed']))} />
          <Stat label="批准/拒绝" value={`${numberOrDash(approvals['approved'])} / ${numberOrDash(approvals['denied'])}`} />
          <Stat label="生效授权" value={String(numberOrDash(approvals['grants']))} />
          <Stat
            label="本小时自动操作"
            value={`${numberOrDash(approvals['autoOpsLastHour'])} / ${numberOrDash(approvals['maxAutoOpsPerHour'])}`}
          />
        </div>
        <p className="muted small">
          “询问”统计的是风险判定为需要人工确认的工具调用；若命中已有会话授权，会直接放行，不产生审批卡。
        </p>
      </Section>

      <Section
        title="桌宠本地节奏"
        hint="主进程计时的小动作与随机走动；只显示截止时间、占用和固定原因，不包含坐标、聊天正文或内部请求 ID。"
      >
        <div className="stat-grid">
          <Stat
            label="调度状态"
            value={
              ambient['started'] !== true
                ? '未启动'
                : typeof ambient['pauseReason'] === 'string' && ambient['pauseReason'] !== ''
                  ? `暂停：${AMBIENT_PAUSE_LABEL[ambient['pauseReason']] ?? ambient['pauseReason']}`
                  : ambient['timerScheduled'] === true
                    ? '运行中'
                    : '等待新快照'
            }
          />
          <Stat label="下次小动作" value={timeOrDash(ambient['nextActionAt'])} />
          <Stat label="下次随机走动" value={timeOrDash(ambient['nextRoamAt'])} />
          <Stat label="保留的到期机会" value={ambientDueText(ambient)} />
          <Stat label="最近小动作" value={ambientResultText(ambient['lastAction'])} />
          <Stat label="最近随机走动" value={ambientResultText(ambient['lastRoam'])} />
          <Stat label="连续失败" value={String(numberOrDash(ambient['failureStreak']))} />
          <Stat
            label="隔离的坏素材"
            value={
              Array.isArray(ambient['quarantined'])
                ? `${ambient['quarantined'].length} 个`
                : '0 个'
            }
          />
          <Stat label="页面快照年龄" value={secondsOrDash(ambient['pageStateAgeMs'])} />
          <Stat label="页面占用" value={ambientOccupancyText(ambientState)} />
          <Stat label="上次张望开始" value={timeOrDash(ambientLook['lastStartedAt'])} />
          <Stat label="上次张望来源" value={stringOrDash(ambientLook['lastSource'])} />
          <Stat label="上次张望尝试" value={timeOrDash(ambientLook['lastAttemptAt'])} />
          <Stat label="上次张望拒绝" value={lookAroundRejectionText(ambientLook)} />
          <Stat label="张望冷却截止" value={timeOrDash(ambientLook['cooldownUntil'])} />
        </div>
        <p className="muted small">
          本地随机活动不调用模型，也不产生气泡；面板、工作、拖拽、菜单、停靠、挂起或页面快照陈旧时会保留到期机会并等待，不会补播积压。
        </p>
      </Section>

      <Section
        title="陪伴节奏"
        hint="每次考虑只记录枚举原因与时间，不包含气泡正文、兴趣摘要、窗口标题或路径。"
      >
        <div className="stat-grid">
          <Stat label="聊天档位" value={stringOrDash(cadence['cadence'])} />
          <Stat label="下次考虑" value={timeOrDash(cadence['nextAt'])} />
          <Stat label="最近考虑" value={timeOrDash(cadence['lastConsiderAt'])} />
          <Stat label="上次开口" value={timeOrDash(cadence['lastSpokeAt'])} />
          <Stat label="最近决策" value={stringOrDash(cadence['lastReason'])} />
          <Stat
            label="未回应退避"
            value={String(numberOrDash(cadence['unansweredCount']))}
          />
          <Stat
            label="反馈缩放"
            value={
              typeof cadence['feedbackScale'] === 'number'
                ? cadence['feedbackScale'].toFixed(2)
                : '—'
            }
          />
          <Stat
            label="话题冷却截止"
            value={timeOrDash(cadence['topicCooldownUntil'])}
          />
          <Stat label="唤醒上限" value="不设上限" />
          <Stat
            label="探索暂停任务"
            value={String(numberOrDash(companion['explorePausedTaskCount']))}
          />
          <Stat
            label="未回应开场"
            value={companion['unansweredEpisode'] === true ? '有' : '无'}
          />
          <Stat
            label="活跃兴趣"
            value={String(numberOrDash(record(companion['interests'])['active']))}
          />
        </div>
        {decisions.length === 0 ? (
          <Empty>还没有聊天节奏决策。</Empty>
        ) : (
          <ul className="undo-list">
            {decisions.slice(-20).map((entry, index) => {
              const item = record(entry)
              return (
                <li key={`${numberOrDash(item['at'])}-${index}`}>
                  <Pill tone={item['reason'] === 'eligible' ? 'ok' : 'neutral'}>
                    {stringOrDash(item['reason'])}
                  </Pill>
                  <span className="muted small">{timeOrDash(item['at'])}</span>
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <Section
        title="今天她做了什么"
        hint="来自本地指标与真实工具回执；只有计数、枚举和数值，不含气泡正文、兴趣摘要、窗口标题或路径。"
      >
        <div className="stat-grid">
          <Stat label="指标日期" value={stringOrDash(metrics['day'])} />
          <Stat
            label="自主考虑"
            value={String(numberOrDash(metricConsiderations['autonomy']))}
          />
          <Stat
            label="陪伴考虑"
            value={String(numberOrDash(metricConsiderations['companion']))}
          />
          <Stat label="她开口" value={String(numberOrDash(metricSpoke['total']))} />
          <Stat
            label="未回答开场"
            value={String(numberOrDash(record(metrics['episodes'])['unanswered']))}
          />
          <Stat
            label="已回答开场"
            value={String(numberOrDash(record(metrics['episodes'])['answered']))}
          />
        </div>
        <div className="stat-grid">
          <Stat label="探索任务开始" value={String(numberOrDash(metricTasks['autonomyStarted']))} />
          <Stat
            label="探索任务完成"
            value={String(numberOrDash(metricTasks['autonomyCompleted']))}
          />
          <Stat label="任务取消/失败" value={`${numberOrDash(metricTasks['cancelled'])} / ${numberOrDash(metricTasks['failed'])}`} />
          <Stat label="工具调用" value={String(numberOrDash(metricTools['calls']))} />
          <Stat
            label="读取/观察"
            value={`${numberOrDash(metricTools['reads'])} / ${numberOrDash(metricTools['observes'])}`}
          />
          <Stat label="写笔记" value={String(numberOrDash(metricTools['noteWrites']))} />
          <Stat
            label="重复内容"
            value={String(numberOrDash(metricTools['duplicateReads']))}
          />
        </div>
        <div className="stat-grid">
          <Stat
            label="CUA / 视觉调用"
            value={`${numberOrDash(metricActions['cua'])} / ${numberOrDash(metricActions['vision'])}`}
          />
          <Stat label="模型调用" value={String(numberOrDash(metricCost['modelCalls']))} />
          <Stat
            label="输入/输出 token"
            value={`${numberOrDash(metricCost['promptTokens'])} / ${numberOrDash(metricCost['completionTokens'])}`}
          />
          <Stat
            label="今日估算费用"
            value={
              typeof metricCost['estimatedCny'] === 'number'
                ? `¥${metricCost['estimatedCny'].toFixed(4)}`
                : '—'
            }
          />
          <Stat
            label="CPU"
            value={
              typeof metricProcess['cpuPercent'] === 'number'
                ? `${metricProcess['cpuPercent'].toFixed(1)}%`
                : '—'
            }
          />
          <Stat
            label="内存 / 峰值"
            value={
              typeof metricProcess['memoryMB'] === 'number'
                ? `${metricProcess['memoryMB'].toFixed(0)} / ${numberOrDash(metricProcess['maxMemoryMB'])} MB`
                : '—'
            }
          />
          <Stat
            label="采样次数"
            value={String(numberOrDash(metricProcess['samples']))}
          />
        </div>
        <div className="stat-grid">
          <Stat
            label="探索观察/动作/产物"
            value={`${numberOrDash(metricExploration['observation'])} / ${numberOrDash(metricExploration['action'])} / ${numberOrDash(metricExploration['artifact'])}`}
          />
          <Stat
            label="探索规划/休息/无进展"
            value={`${numberOrDash(metricExploration['planning'])} / ${numberOrDash(metricExploration['rest'])} / ${numberOrDash(metricExploration['noProgress'])}`}
          />
          <Stat
            label="本地反应时延 P50/P95"
            value={latencyPair(metricReactions['latencyP50Ms'], metricReactions['latencyP95Ms'])}
          />
          <Stat
            label="观察→本地动作 P50/P95"
            value={latencyPair(metricReactions['eventAgeP50Ms'], metricReactions['eventAgeP95Ms'])}
          />
          <Stat
            label="观察→模型反馈 P50/P95"
            value={latencyPair(
              metricReactions['modelLatencyP50Ms'],
              metricReactions['modelLatencyP95Ms']
            )}
          />
          <Stat
            label="反应候选/播放/丢弃"
            value={`${numberOrDash(metricReactions['candidates'])} / ${numberOrDash(metricReactions['localActions'])} / ${numberOrDash(metricReactions['cancelled'])}`}
          />
        </div>
        <p className="muted small">
          这些是本地观测计数与时延分位数，只用于解释“是否看到、是否及时”，不参与任何唤醒或截图额度。
        </p>
        {metricFile['truncated'] === true && (
          <p className="inline-warn">
            今日指标文件已达到单日上限，后续计数只在内存中保留，直到下一次日期轮转。
          </p>
        )}
        {experiences.length === 0 ? (
          <Empty>还没有真实经历记录。只有实际读取、观察或写下笔记后才会出现。</Empty>
        ) : (
          <ul className="undo-list">
            {experiences.map((entry) => (
              <li key={entry.id}>
                <Pill tone="info">{entry.kind}</Pill>
                <span>{entry.summary}</span>
                {entry.targetRef !== null && (
                  <span className="mono dim small">{entry.targetRef}</span>
                )}
                <span className="muted small">{new Date(entry.at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="最近工具调用"
        hint="来自本地审计日志，只保留工具名、结果与耗时；摘要可能含路径或命令。"
      >
        {d === null ? (
          <Empty>正在读取诊断…</Empty>
        ) : d.recentToolCalls.length === 0 ? (
          <Empty>还没有工具调用记录。</Empty>
        ) : (
          <ul className="undo-list">
            {d.recentToolCalls.map((call, index) => (
              <li key={`${call.at}-${call.tool}-${index}`}>
                <Pill tone={call.result === 'ok' ? 'ok' : call.result === 'failed' ? 'bad' : 'info'}>
                  {call.result}
                </Pill>
                <strong>{call.tool}</strong>
                {call.approval !== null && <span className="muted small">审批：{call.approval}</span>}
                {call.durationMs !== null && <span className="muted small">{call.durationMs}ms</span>}
                <span className="muted small">{formatTime(call.at)}</span>
                {call.summary !== null && <span className="mono dim small">{call.summary}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="最近失败"
        hint="按 turnId 关联状态条与聊天提示；只含工具名/阶段/错误码/恢复状态，不含正文、参数或路径。"
      >
        {d === null ? (
          <Empty>正在读取诊断…</Empty>
        ) : d.recentTurnFailures.length === 0 ? (
          <Empty>还没有模型请求、工具或授权失败记录。</Empty>
        ) : (
          <ul className="undo-list">
            {d.recentTurnFailures.map((failure, index) => (
              <li key={`${failure.turnId}-${index}`}>
                <Pill
                  tone={
                    failure.kind === 'provider' ||
                    failure.kind === 'protocol' ||
                    failure.kind === 'internal'
                      ? 'bad'
                      : failure.kind === 'cancelled'
                        ? 'neutral'
                        : 'warn'
                  }
                >
                  {failure.kind}
                </Pill>
                <strong>{turnFailureDiagnosticLine(failure)}</strong>
                <span className="muted small">
                  {failure.source} · 第 {failure.round} 轮 ·{" "}
                  {new Date(failure.at).toLocaleString()}
                </span>
                <span className="mono dim small">{failure.turnId}</span>
                {failure.completed.length > 0 && (
                  <span className="muted small">已完成：{failure.completed.join('、')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="错误与警告"
        hint="来自本地应用日志；日志在写入磁盘前已经做过密钥形态脱敏。"
      >
        {d === null ? (
          <Empty>正在读取诊断…</Empty>
        ) : d.recentErrors.length === 0 ? (
          <Empty>没有最近的错误或警告。</Empty>
        ) : (
          <ul className="undo-list">
            {d.recentErrors.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <Pill tone={entry.level === 'error' ? 'bad' : 'warn'}>{entry.level}</Pill>
                <span>{entry.message}</span>
                <span className="muted small">{formatTime(entry.at)}</span>
                {entry.data !== null && (
                  <details className="advanced">
                    <summary>详情</summary>
                    <pre className="json-view">{safeJson(entry.data)}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Worlds 健康"
        hint="不可用的原因会显示在这里；单个 World 失败不会阻止其他功能。"
      >
        {d === null ? (
          <Empty>正在读取诊断…</Empty>
        ) : (
          <div className="diag-world-list">
            {d.worlds.map((world) => (
              <div className="diag-world" key={world.id}>
                <div>
                  <strong>{world.id}</strong>
                  <span className="muted small">
                    {world.tools.length} 工具 · {world.events.length} 事件
                  </span>
                </div>
                <div className="row-gap">
                  <Pill tone={world.enabled ? 'info' : 'neutral'}>
                    {world.enabled ? '已启用' : '关闭'}
                  </Pill>
                  <Pill tone={world.available ? 'ok' : 'bad'}>
                    {world.available ? '可用' : '不可用'}
                  </Pill>
                </div>
                {world.reason !== null && <p className="inline-warn">{world.reason}</p>}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="路径" hint="这些路径都在应用数据目录内；工作区工具无法访问。">
        <div className="kv-list">
          {Object.entries(d?.paths ?? boot.paths).map(([key, value]) => (
            <div className="kv" key={key}>
              <span>{key}</span>
              <code>{value}</code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="撤销记录" hint="最近的文件改动快照；只展示路径与类型。">
        {s.undoEntries.length === 0 ? (
          <Empty>没有可撤销的记录。</Empty>
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
            <Button variant="primary" onClick={() => void s.undoNow(1)}>
              撤销最近一次
            </Button>
          </>
        )}
      </Section>

      <Section
        title="原始诊断数据"
        hint="供排查问题使用。导出诊断包会替换路径、URL 细节并移除工具参数摘要；这里的原始视图仍可能含个人信息。"
      >
        {d === null ? (
          <Empty>暂无数据。</Empty>
        ) : (
          <>
            <details className="advanced">
              <summary>运行诊断对象</summary>
              <pre className="json-view">{safeJson(d.diagnostics)}</pre>
            </details>
            <details className="advanced">
              <summary>当前配置（不含 API Key）</summary>
              <pre className="json-view">{safeJson(d.config)}</pre>
            </details>
            <details className="advanced">
              <summary>Worlds 描述</summary>
              <pre className="json-view">{safeJson(d.worlds)}</pre>
            </details>
          </>
        )}
      </Section>
    </div>
  )
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function numberOrDash(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
}

function stringOrDash(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : '—'
}

function timeOrDash(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
  return new Date(value).toLocaleTimeString()
}

/** 张望拒绝只显示来源与固定原因码；不含用户正文。 */
function lookAroundRejectionText(look: Record<string, unknown>): string {
  const source = stringOrDash(look['lastRejectedSource'])
  const reason = stringOrDash(look['lastRejectedReason'])
  if (source === '—' && reason === '—') return '—'
  return `${source} · ${reason}`
}

function secondsOrDash(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${Math.round(value / 1000)} 秒`
}

function ambientDueText(ambient: Record<string, unknown>): string {
  const due = [
    ambient['actionDue'] === true ? '小动作' : '',
    ambient['roamDue'] === true ? '随机走动' : ''
  ].filter((item) => item !== '')
  return due.length === 0 ? '无' : due.join('、')
}

function ambientResultText(value: unknown): string {
  const result = record(value)
  if (typeof result['status'] !== 'string' || result['status'] === '') return '—'
  const name =
    typeof result['animationId'] === 'string' && result['animationId'] !== ''
      ? `${result['animationId']} · `
      : ''
  const reason =
    typeof result['reason'] === 'string' && result['reason'] !== ''
      ? `（${result['reason']}）`
      : ''
  // 延迟与等待原因是固定枚举/毫秒数，不含正文；用来解释互斥或占用
  // 导致的“超过设定间隔才出现”，不把内部 requestId 暴露到设置页。
  const delayMs =
    typeof result['delayMs'] === 'number' && Number.isFinite(result['delayMs'])
      ? Math.max(0, result['delayMs'])
      : 0
  const waitReason =
    typeof result['waitReason'] === 'string' && result['waitReason'] !== ''
      ? `，等待 ${result['waitReason']}`
      : ''
  const delay = delayMs >= 1_000 ? ` · 延迟 ${Math.round(delayMs / 1_000)} 秒${waitReason}` : ''
  return `${name}${result['status']}${reason}${delay}`
}

function ambientOccupancyText(state: Record<string, unknown>): string {
  if (Object.keys(state).length === 0) return '—'
  const occupied: Array<[string, string]> = [
    ['ready', '未就绪'],
    ['visible', '隐藏'],
    ['dragging', '拖拽'],
    ['throwing', '甩抛'],
    ['panelOpen', '面板'],
    ['menuOpen', '菜单'],
    ['working', '工作'],
    ['moving', '移动'],
    ['perched', '停靠'],
    ['suspended', '挂起']
  ]
  const labels = occupied
    .filter(([key]) => state[key] === false || (key !== 'ready' && key !== 'visible' && state[key] === true))
    .map(([, label]) => label)
  return labels.length === 0 ? '空闲' : labels.join('、')
}

/** 时延分位数：没有样本时明确显示 —，不把 0 当成“很快”。 */
function latencyPair(p50: unknown, p95: unknown): string {
  const format = (value: unknown): string =>
    typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}ms` : '—'
  return `${format(p50)} / ${format(p95)}`
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function formatTime(value: string): string {
  const at = Date.parse(value)
  return Number.isNaN(at) ? value : new Date(at).toLocaleString()
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '（无法序列化）'
  }
}
