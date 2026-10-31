import { useSettings } from '../context'
import { Section } from '../ui'

export function AboutTab(): React.JSX.Element {
  const s = useSettings()

  return (
    <div className="stack">
      <Section title="桌宠" hint={`版本 ${s.boot.version} · ${s.boot.platform}`}>
        <div className="about-hero">
          <span className="about-mark">🐋</span>
          <div>
            <h3>一只 DeepSeek 鲸鱼娘</h3>
            <p>本地优先，无遥测；能力边界由配置、审批与执行校验共同决定。</p>
          </div>
        </div>
      </Section>

      <Section title="许可证与署名">
        <div className="about-list">
          <div>
            <strong>本应用</strong>
            <span>MIT License。可自由修改、分发与自建。</span>
          </div>
          <div>
            <strong>桌宠运行时与角色</strong>
            <span>
              PC2005-cloud/dsh-pet v0.3.8（commit 2fa04a5）。运行时为源码移植，
              代码按上游 MIT License 使用；默认角色“蓝毛小女仆”与 106 个动画素材来自同一上游。
            </span>
          </div>
          <div>
            <strong>动画素材许可</strong>
            <span>
              上游素材允许开源使用、禁止商用，<strong>不是 MIT 授权</strong>。
              内置素材未修改，仅用于非商业开源分发；不得单独售卖或用于商业产品。
              详见随包的 NOTICE-assets.md、LICENSE 与 UPSTREAM.json。
            </span>
          </div>
          <div>
            <strong>DeepSeek API</strong>
            <span>对话与网页能力由你自行配置的 API Key 提供；费用由 DeepSeek 账户结算。</span>
          </div>
        </div>
      </Section>

      <Section title="隐私">
        <ul className="promise-list">
          <li>默认不联网、不遥测；出网只发生在你配置的模型调用与主动请求的网页抓取。</li>
          <li>API Key 只存在主进程并经 Windows DPAPI 加密；渲染进程和子进程拿不到。</li>
          <li>行为感知、浏览器页面、屏幕观察与电脑操作都需要分别授权，默认关闭。</li>
          <li>记忆是普通 Markdown；关闭后不注入、不写入。红区操作始终需要你确认。</li>
        </ul>
      </Section>
    </div>
  )
}
