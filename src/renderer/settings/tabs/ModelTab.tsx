import { ModelFields } from '../components/ModelFields'
import { useSettings } from '../context'
import { Empty } from '../ui'

/** 模型与用量：模型连接、图片输入、上下文与用量。 */
export function ModelTab(): React.JSX.Element {
  const s = useSettings()
  const usage = s.boot.usage
  const session = s.boot.session

  return (
    <div className="stack">
      <ModelFields />
      <section className="section" aria-labelledby="model-usage">
        <header className="section-head">
          <h2 id="model-usage">用量与费用</h2>
        </header>
        <div className="section-body">
          {usage === undefined ? (
            <Empty>暂无用量。</Empty>
          ) : (
            <div className="stat-grid">
              <Stat label="调用次数" value={usage.calls.toLocaleString()} />
              <Stat label="输入 tokens" value={usage.promptTokens.toLocaleString()} />
              <Stat label="输出 tokens" value={usage.completionTokens.toLocaleString()} />
              <Stat label="缓存命中 tokens" value={usage.cacheHitTokens.toLocaleString()} />
              <Stat label="估算费用" value={`¥ ${usage.estimatedCny.toFixed(4)}`} />
              <Stat label="会话轮次" value={String(session.rounds)} />
              <Stat label="会话 token" value={session.estTokens.toLocaleString()} />
              <Stat label="上下文上限" value={session.contextTokens.toLocaleString()} />
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
