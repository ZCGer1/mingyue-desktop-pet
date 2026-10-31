import { Anchor } from '../ui'
import { AutonomyTab } from '../tabs/AutonomyTab'

/** 活动与任务：任务、发现、兴趣、经历与各类记录。 */
export function ActivityPage(): React.JSX.Element {
  return (
    <div id="activity" className="stack page-anchor-block">
      <Anchor id="tasks" />
      <Anchor id="discoveries" />
      <AutonomyTab />
    </div>
  )
}
