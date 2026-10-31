import { CompanionRhythm } from '../components/CompanionRhythm'
import { ChatTab } from '../tabs/ChatTab'
import { PersonaTab } from '../tabs/PersonaTab'

/** 陪伴与外观的表单集合；设置页与配置流程共用。 */
export function CompanionFields(): React.JSX.Element {
  return (
    <div className="stack section-stack">
      <CompanionRhythm />
      <PersonaTab />
      <ChatTab />
    </div>
  )
}

export function CompanionPage(): React.JSX.Element {
  return (
    <div className="stack">
      <div id="persona" className="page-anchor-block">
        <PersonaTab />
      </div>
      <div id="rhythm" className="page-anchor-block">
        <CompanionRhythm />
      </div>
      <div id="chat" className="page-anchor-block">
        <ChatTab />
      </div>
    </div>
  )
}
