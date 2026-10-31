import type {
  CapabilityCardId,
  CapabilityCardView,
  CapabilityState
} from '../../../shared/capabilityStatus'
import { useSettings } from '../context'
import { CAPABILITY_PATHS } from '../settingsPaths'
import { sameValueOnPaths } from '../configTree'
import { Button, Pill } from '../ui'

/**
 * 能力卡片：只展示已保存快照的名称、状态、必要原因与配置动作。
 *
 * 运行状态与草稿严格分开：状态来自主进程快照；未保存的修改只额外标注
 * “未保存”，不会伪装成已经生效的权限。
 */

const STATE_LABEL: Record<CapabilityState, string> = {
  ready: '就绪',
  limited: '部分可用',
  unauthorized: '未授权',
  disabled: '已关闭',
  'pending-connection': '等待连接',
  'missing-consent': '缺少同意',
  'directory-unavailable': '目录不可用',
  expired: '授权已到期',
  fault: '运行异常'
}

const STATE_TONE: Record<CapabilityState, 'neutral' | 'ok' | 'warn' | 'bad' | 'info'> = {
  ready: 'ok',
  limited: 'warn',
  unauthorized: 'neutral',
  disabled: 'neutral',
  'pending-connection': 'warn',
  'missing-consent': 'warn',
  'directory-unavailable': 'bad',
  expired: 'warn',
  fault: 'bad'
}

/** 六项能力各自的未保存标记；包含 B 站。 */
export function useCapabilityPending(): Record<CapabilityCardId, boolean> {
  const s = useSettings()
  const ids: CapabilityCardId[] = ['web', 'bilibili', 'apps', 'screen', 'files', 'artifacts']
  const out = {} as Record<CapabilityCardId, boolean>
  for (const id of ids) {
    out[id] = !sameValueOnPaths(s.config, s.boot.config, CAPABILITY_PATHS[id])
  }
  return out
}

function firstReason(card: CapabilityCardView): string | null {
  if (card.state === 'ready') return null
  const check = card.checks.find((item) => item.state !== 'ready')
  return check?.reason ?? null
}

/** 电脑能力顶部的紧凑状态条。 */
export function CapabilityStatusStrip(): React.JSX.Element {
  const s = useSettings()
  const pending = useCapabilityPending()
  const snapshot = s.capabilitySnapshot
  if (snapshot === null) {
    return (
      <div className="cap-strip">
        <Pill tone="warn">状态不可用</Pill>
        <Button variant="subtle" onClick={() => void s.refreshBoot()}>
          重试
        </Button>
      </div>
    )
  }
  return (
    <div className="cap-strip" aria-label="能力状态">
      {snapshot.cards.map((card) => (
        <button
          key={card.id}
          type="button"
          className="cap-strip-item"
          onClick={() => s.navigate('computer', card.fix.anchor)}
        >
          <span>{card.title}</span>
          <Pill tone={STATE_TONE[card.state]}>{STATE_LABEL[card.state]}</Pill>
          {pending[card.id] ? <Pill tone="info">未保存</Pill> : null}
        </button>
      ))}
    </div>
  )
}

/** 概览与完成页使用的精简能力列表。 */
export function CapabilitySummary({
  onConfigure,
  onAction
}: {
  onConfigure?: () => void
  /** 覆盖“配置”动作；配置流程用它跳回对应步骤而不是离开流程。 */
  onAction?: (card: CapabilityCardView) => void
}): React.JSX.Element {
  const s = useSettings()
  const pending = useCapabilityPending()
  const snapshot = s.capabilitySnapshot
  if (snapshot === null) {
    return (
      <div className="cap-summary">
        <div className="inline-warn" role="status">
          <span>状态不可用</span>
          <Button variant="subtle" onClick={() => void s.refreshBoot()}>
            重试
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="cap-summary">
      {snapshot.cards.map((card) => {
        const reason = firstReason(card)
        return (
          <article
            key={card.id}
            className="cap-mini"
            data-card-id={card.id}
            data-state={card.state}
          >
            <div className="cap-mini-head">
              <strong>{card.title}</strong>
              <span className="cap-mini-badges">
                <Pill tone={STATE_TONE[card.state]}>{STATE_LABEL[card.state]}</Pill>
                {pending[card.id] ? <Pill tone="info">未保存</Pill> : null}
              </span>
            </div>
            {reason === null ? null : <p className="cap-mini-reason">{reason}</p>}
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                onAction === undefined
                  ? s.navigate(card.fix.page, card.fix.anchor)
                  : onAction(card)
              }
            >
              配置
            </button>
          </article>
        )
      })}
      {onConfigure === undefined ? null : (
        <div className="cap-summary-foot">
          <Button variant="subtle" onClick={onConfigure}>
            重新配置
          </Button>
        </div>
      )}
    </div>
  )
}
