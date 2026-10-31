import { Anchor } from '../ui'
import { MemoryTab } from '../tabs/MemoryTab'
import { PrivacyTab } from '../tabs/PrivacyTab'

/** 记忆与隐私：记忆文件、行为感知、共享字段、保留规则与数据清理。 */
export function PrivacyPage(): React.JSX.Element {
  return (
    <div className="stack">
      <div id="memory" className="page-anchor-block">
        <MemoryTab />
      </div>
      <div id="perception" className="page-anchor-block">
        <Anchor id="privacy" />
        <PrivacyTab />
      </div>
    </div>
  )
}
