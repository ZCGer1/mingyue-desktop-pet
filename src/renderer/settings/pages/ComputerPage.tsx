import { CapabilityStatusStrip } from '../components/CapabilityCards'
import { COMPUTER_SECTIONS, useSettings } from '../context'
import { SubNav } from '../ui'
import { AppsSection } from './computer/AppsSection'
import { ArtifactsSection } from './computer/ArtifactsSection'
import { AutonomySection } from './computer/AutonomySection'
import { BilibiliSection } from './computer/BilibiliSection'
import { FilesSection } from './computer/FilesSection'
import { ScreenSection } from './computer/ScreenSection'
import { WebSection } from './computer/WebSection'

/**
 * 电脑能力：六个能力子页 + 顶部共用的「自主与授权」。
 *
 * 一次只挂载当前子页，只有当前子页建立轮询；切换不丢草稿（草稿在全局上下文）。
 */
export function ComputerPage(): React.JSX.Element {
  const s = useSettings()
  const section = s.computerSection

  return (
    <div className="stack computer-page">
      <CapabilityStatusStrip />

      <details id="exploration" className="advanced-block autonomy-group page-anchor-block">
        <summary>自主与授权</summary>
        <div className="section-body">
          <AutonomySection />
        </div>
      </details>

      <SubNav
        label="电脑能力"
        items={COMPUTER_SECTIONS.map((item) => ({ id: item.id, label: item.label }))}
        active={section}
        onSelect={(id) => s.navigate('computer', id)}
      />

      <div className="subpage">
        {section === 'web' && (
          <div id="web" className="page-anchor-block">
            <WebSection />
          </div>
        )}
        {section === 'bilibili' && (
          <div id="bilibili" className="page-anchor-block">
            <BilibiliSection />
          </div>
        )}
        {section === 'apps' && (
          <div id="apps" className="page-anchor-block">
            <AppsSection />
          </div>
        )}
        {section === 'screen' && (
          <div id="screen" className="page-anchor-block">
            <ScreenSection />
          </div>
        )}
        {section === 'files' && (
          <div id="files" className="page-anchor-block">
            <FilesSection />
          </div>
        )}
        {section === 'artifacts' && (
          <div id="artifacts" className="page-anchor-block">
            <ArtifactsSection />
          </div>
        )}
      </div>
    </div>
  )
}
