import { VisionDiagnostics } from '../components/VisionDiagnostics'
import { AboutTab } from '../tabs/AboutTab'
import { DiagnosticsTab } from '../tabs/DiagnosticsTab'
import { SystemSettingsTab } from '../tabs/SystemSettingsTab'
import { WorldsTab } from '../tabs/WorldsTab'

/**
 * 高级与诊断：健康状态、诊断、日志、终端、自启动、维护与关于。
 *
 * 能力专属参数在各能力子页；这里不重复业务开关。
 */
export function AdvancedPage(): React.JSX.Element {
  return (
    <div className="stack">
      <details id="worlds" className="advanced-block page-anchor-block">
        <summary>Worlds 健康</summary>
        <WorldsTab />
      </details>
      <details id="diagnostics" className="advanced-block page-anchor-block" open>
        <summary>运行诊断</summary>
        <DiagnosticsTab />
      </details>
      <details id="vision-diagnostics" className="advanced-block page-anchor-block">
        <summary>屏幕诊断</summary>
        <VisionDiagnostics />
      </details>
      <details id="system" className="advanced-block page-anchor-block">
        <summary>终端与启动</summary>
        <SystemSettingsTab />
      </details>
      <details id="about" className="advanced-block page-anchor-block">
        <summary>关于与许可</summary>
        <AboutTab />
      </details>
    </div>
  )
}
