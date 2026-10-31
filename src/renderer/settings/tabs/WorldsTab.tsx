import { useSettings } from '../context'
import type { WorldHealthView } from '../../../shared/ipc'
import { Button, Empty, Pill, Section } from '../ui'

const META: Record<string, string> = {
  chat: 'chat · 对话',
  pet: 'pet · 桌宠',
  activity: 'activity · 只读感知',
  files: 'files · 电脑文件',
  apps: 'apps · 普通应用',
  system: 'system · 应用与系统',
  desktop: 'desktop · 窗口与桌面',
  cua: 'cua · 屏幕与键鼠',
  browser: 'browser · 当前页面',
  browserControl: 'browserControl · 主动浏览',
  bilibili: 'bilibili · B 站阅读',
  tasks: 'tasks · 目标与任务',
  workspace: 'workspace · 文件',
  web: 'web · 网页',
  terminal: 'terminal · 终端'
}

/** Worlds 健康：只读状态与跳转入口，不在这里重复业务开关。 */
export function WorldsTab(): React.JSX.Element {
  const s = useSettings()

  return (
    <div className="stack">
      <Section
        title="Worlds"
        actions={<Button onClick={() => void s.loadWorlds()}>刷新健康状态</Button>}
      >
        {s.worlds.length === 0 ? (
          <Empty>正在读取 Worlds…</Empty>
        ) : (
          <div className="world-list">
            {s.worlds.map((world) => (
              <WorldCard key={world.id} world={world} />
            ))}
          </div>
        )}
      </Section>

      <Section title="配置入口">
        <div className="row-gap">
          <Button variant="subtle" onClick={() => s.navigate('computer', 'web')}>
            网页
          </Button>
          <Button variant="subtle" onClick={() => s.navigate('computer', 'apps')}>
            应用
          </Button>
          <Button variant="subtle" onClick={() => s.navigate('computer', 'screen')}>
            屏幕
          </Button>
          <Button variant="subtle" onClick={() => s.navigate('computer', 'files')}>
            文件
          </Button>
          <Button variant="subtle" onClick={() => s.navigate('privacy', 'perception')}>
            行为感知
          </Button>
          <Button variant="subtle" onClick={() => s.navigate('companion', 'rhythm')}>
            聊天节奏
          </Button>
          <Button variant="subtle" onClick={() => s.navigate('advanced', 'system')}>
            终端
          </Button>
        </div>
      </Section>
    </div>
  )
}

function WorldCard({ world }: { world: WorldHealthView }): React.JSX.Element {
  const label = META[world.id] ?? world.id
  return (
    <article className={`world-card ${world.enabled ? '' : 'is-off'}`}>
      <header>
        <div>
          <h3>{label}</h3>
        </div>
        <div className="world-badges">
          <Pill tone={world.enabled ? 'info' : 'neutral'}>{world.enabled ? '已启用' : '已关闭'}</Pill>
          {world.enabled && (
            <Pill tone={world.available ? 'ok' : 'bad'}>
              {world.available ? '运行中' : '不可用'}
            </Pill>
          )}
        </div>
      </header>
      {world.reason !== null && <p className="inline-warn">{world.reason}</p>}
      <details className="world-details">
        <summary>
          工具 {world.tools.length} 个 · 事件 {world.events.length} 个
        </summary>
        <div className="world-columns">
          <div>
            <h4>工具</h4>
            {world.tools.length === 0 ? (
              <p className="muted small">无工具。</p>
            ) : (
              <ul className="tool-list">
                {world.tools.map((tool) => (
                  <li key={tool.name}>
                    <code>{tool.name}</code>
                    <span className={`tag tag-${tool.approval === 'required' ? 'approval' : 'auto'}`}>
                      {tool.approval === 'required' ? '需审批' : '自动'}
                    </span>
                    <span className="tag">{tool.tags.join('/') || '无标签'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4>事件</h4>
            {world.events.length === 0 ? (
              <p className="muted small">无事件。</p>
            ) : (
              <ul className="event-list">
                {world.events.map((event) => (
                  <li key={event.type}>
                    <code>{event.type}</code>
                    <p>{event.description}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </details>
    </article>
  )
}
