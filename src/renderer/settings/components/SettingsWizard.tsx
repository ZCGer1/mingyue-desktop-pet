import { useEffect, useMemo, useRef, useState } from 'react'
import type { CapabilityCardId, CapabilityCardView } from '../../../shared/capabilityStatus'
import type { AppConfig } from '../../../shared/config'
import {
  computerSectionForAnchor,
  SettingsContext,
  useSettings,
  type SettingsContextValue,
  type SettingsPageId
} from '../context'
import { applyPath, applyPaths, readPath, sameValueOnPaths } from '../configTree'
import {
  EXPLORATION_AUTH_PATHS,
  WIZARD_STEP_PATHS,
  type WizardStepId
} from '../settingsPaths'
import { Button, Pill } from '../ui'
import { CapabilitySummary } from './CapabilityCards'
import { ModelFields } from './ModelFields'
import { AppsSection } from '../pages/computer/AppsSection'
import { ArtifactsSection } from '../pages/computer/ArtifactsSection'
import { AutonomySection } from '../pages/computer/AutonomySection'
import { BilibiliSection } from '../pages/computer/BilibiliSection'
import { FilesSection } from '../pages/computer/FilesSection'
import { ScreenSection } from '../pages/computer/ScreenSection'
import { WebSection } from '../pages/computer/WebSection'
import { CompanionFields } from '../pages/CompanionPage'
import { MemoryTab } from '../tabs/MemoryTab'
import { PrivacyTab } from '../tabs/PrivacyTab'
import { SystemSettingsTab } from '../tabs/SystemSettingsTab'

export const WIZARD_STORAGE_KEY = 'mingyue.settings.wizard.v1'

export interface WizardProgress {
  completed: boolean
  step: number
  skipped: WizardStepId[]
  /** 已保存过的步骤；只记录步骤名，不保存任何配置值。 */
  saved: WizardStepId[]
}

function readStepIds(value: unknown): WizardStepId[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is WizardStepId =>
    WIZARD_STEPS.some((step) => step.id === item)
  )
}

interface StepMeta {
  id: WizardStepId
  label: string
  card: CapabilityCardId | null
}

export const WIZARD_STEPS: readonly StepMeta[] = [
  { id: 'api', label: 'API', card: null },
  { id: 'web', label: '网页', card: 'web' },
  { id: 'bilibili', label: 'B 站', card: 'bilibili' },
  { id: 'apps', label: '应用', card: 'apps' },
  { id: 'screen', label: '屏幕', card: 'screen' },
  { id: 'files', label: '文件', card: 'files' },
  { id: 'artifacts', label: '作品空间', card: 'artifacts' },
  { id: 'companion', label: '陪伴', card: null },
  { id: 'memory', label: '记忆', card: null },
  { id: 'finish', label: '完成', card: null }
]

export function loadWizardProgress(): WizardProgress {
  try {
    const raw = window.localStorage.getItem(WIZARD_STORAGE_KEY)
    if (raw === null) return { completed: false, step: 0, skipped: [], saved: [] }
    const parsed = JSON.parse(raw) as Partial<WizardProgress>
    return {
      completed: parsed.completed === true,
      step:
        typeof parsed.step === 'number' && parsed.step >= 0 && parsed.step < WIZARD_STEPS.length
          ? Math.floor(parsed.step)
          : 0,
      skipped: readStepIds(parsed.skipped),
      saved: readStepIds(parsed.saved)
    }
  } catch {
    return { completed: false, step: 0, skipped: [], saved: [] }
  }
}

function storeProgress(progress: WizardProgress): void {
  try {
    window.localStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(progress))
  } catch {
    /* 受限环境不能写界面偏好时，流程仍可正常使用。 */
  }
}

/** 向导内部链接：跳到对应步骤，而不是离开流程丢掉未保存草稿。 */
function stepForNavigation(page: SettingsPageId, anchor?: string): WizardStepId | null {
  if (page === 'model') return 'api'
  if (page === 'companion') return 'companion'
  if (page === 'privacy') return 'memory'
  if (page === 'advanced') return 'finish'
  if (page !== 'computer') return null
  if (anchor === 'exploration') return 'finish'
  return computerSectionForAnchor(anchor ?? null) ?? 'web'
}

function stepStatusLabel(
  id: WizardStepId,
  options: {
    saved: boolean
    skipped: boolean
    dirty: boolean
    failed: boolean
    cardState: string | null
  }
): { label: string; tone: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' } {
  if (options.failed) return { label: '失败', tone: 'bad' }
  // 保存后又编辑时，未保存优先于“已保存/已跳过”。
  if (options.dirty) return { label: '未保存', tone: 'info' }
  if (options.skipped) return { label: '已跳过', tone: 'neutral' }
  if (options.saved) {
    if (options.cardState === 'pending-connection') return { label: '待连接', tone: 'warn' }
    return { label: '已保存', tone: 'ok' }
  }
  return { label: id === 'finish' ? '汇总' : '待配置', tone: 'neutral' }
}

function StepBody({
  id,
  onCardAction
}: {
  id: WizardStepId
  onCardAction?: (card: CapabilityCardView) => void
}): React.JSX.Element {
  switch (id) {
    case 'api':
      return <ModelFields />
    case 'web':
      return <WebSection />
    case 'bilibili':
      return <BilibiliSection />
    case 'apps':
      return <AppsSection />
    case 'screen':
      return <ScreenSection />
    case 'files':
      return <FilesSection />
    case 'artifacts':
      return <ArtifactsSection />
    case 'companion':
      return <CompanionFields />
    case 'memory':
      return (
        <div className="stack section-stack">
          <MemoryTab />
          <PrivacyTab />
        </div>
      )
    case 'finish':
      return (
        <div className="stack section-stack">
          <section className="section" aria-labelledby="wizard-summary">
            <header className="section-head">
              <h2 id="wizard-summary">配置结果</h2>
            </header>
            <div className="section-body">
              <CapabilitySummary onAction={onCardAction} />
            </div>
          </section>
          <section className="section" aria-labelledby="wizard-autonomy">
            <header className="section-head">
              <h2 id="wizard-autonomy">自主与授权</h2>
            </header>
            <div className="section-body">
              <AutonomySection />
            </div>
          </section>
          <SystemSettingsTab />
        </div>
      )
  }
}

/**
 * 概览里的分步配置流程。
 *
 * 每步只在点“保存并继续”时提交该步骤拥有的字段；草稿独立于设置页，
 * 跳过不改配置，返回可以继续编辑未提交内容。
 */
export function SettingsWizard({ onCompleted }: { onCompleted: () => void }): React.JSX.Element {
  const s = useSettings()
  const [progress, setProgress] = useState<WizardProgress>(loadWizardProgress)
  const [draft, setDraft] = useState<AppConfig>(() => structuredClone(s.config))
  const [busy, setBusy] = useState(false)
  const [failedAt, setFailedAt] = useState<WizardStepId | null>(null)

  // 立即撤销会直接改写已保存授权；把这类外部变化同步进草稿，避免步骤保存
  // 把刚撤销的范围又写回去。只同步撤销会改写的字段，其他草稿保持不变。
  const savedAuthRef = useRef(
    EXPLORATION_AUTH_PATHS.map((path) => JSON.stringify(readPath(s.boot.config, path)))
  )
  useEffect(() => {
    const next = EXPLORATION_AUTH_PATHS.map((path) =>
      JSON.stringify(readPath(s.boot.config, path))
    )
    if (next.every((value, index) => value === savedAuthRef.current[index])) return
    savedAuthRef.current = next
    setDraft((previous) => applyPaths(previous, s.boot.config, EXPLORATION_AUTH_PATHS))
  }, [s.boot.config])

  const index = Math.min(progress.step, WIZARD_STEPS.length - 1)
  const step = WIZARD_STEPS[index] ?? WIZARD_STEPS[0]!
  const paths = WIZARD_STEP_PATHS[step.id]
  const dirty = !sameValueOnPaths(draft, s.boot.config, paths)

  const updateProgress = (next: WizardProgress): void => {
    setProgress(next)
    storeProgress(next)
  }

  const goTo = (nextIndex: number): void => {
    setFailedAt(null)
    updateProgress({ ...progress, step: Math.max(0, Math.min(WIZARD_STEPS.length - 1, nextIndex)) })
  }

  const scoped = useMemo<SettingsContextValue>(
    () => ({
      ...s,
      config: draft,
      dirty,
      update: (path, value) => setDraft((previous) => applyPath(previous, path, value)),
      save: async (silent?: boolean): Promise<boolean> =>
        s.saveScoped(paths, { source: draft, silent: silent === true }),
      saveScoped: async (scopedPaths, options = {}) =>
        s.saveScoped(scopedPaths, { ...options, source: draft }),
      navigate: (page: SettingsPageId, anchor?: string) => {
        const target = stepForNavigation(page, anchor)
        if (target === null) {
          s.navigate(page, anchor)
          return
        }
        const targetIndex = WIZARD_STEPS.findIndex((item) => item.id === target)
        if (targetIndex >= 0) goTo(targetIndex)
      }
    }),
    [s, draft, dirty, paths, progress]
  )

  const saveAndContinue = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFailedAt(null)
    const ok = await s.saveScoped(paths, { source: draft, silent: true })
    setBusy(false)
    if (!ok) {
      setFailedAt(step.id)
      return
    }
    const saved = progress.saved.includes(step.id)
      ? progress.saved
      : [...progress.saved, step.id]
    s.notify(`${step.label}已保存。`, 'ok')
    if (step.id === 'finish') {
      updateProgress({ ...progress, saved, completed: true, step: WIZARD_STEPS.length - 1 })
      onCompleted()
      return
    }
    setFailedAt(null)
    updateProgress({ ...progress, saved, step: index + 1 })
  }

  const skip = (): void => {
    const skipped = progress.skipped.includes(step.id)
      ? progress.skipped
      : [...progress.skipped, step.id]
    if (step.id === 'finish') {
      updateProgress({ ...progress, skipped, completed: true })
      onCompleted()
      return
    }
    setFailedAt(null)
    updateProgress({ ...progress, skipped, step: index + 1 })
  }

  const card = step.card === null ? null : s.capabilitySnapshot?.cards.find((item) => item.id === step.card)
  const status = stepStatusLabel(step.id, {
    saved: progress.saved.includes(step.id),
    skipped: progress.skipped.includes(step.id),
    dirty,
    failed: failedAt === step.id,
    cardState: card?.state ?? null
  })

  return (
    <SettingsContext.Provider value={scoped}>
      <section className="wizard" aria-labelledby="wizard-title">
        <header className="wizard-head">
          <div>
            <h2 id="wizard-title">配置流程</h2>
            <div className="wizard-progress" aria-label="配置进度">
              {WIZARD_STEPS.map((item, itemIndex) => (
                <button
                  key={item.id}
                  type="button"
                  className={`wizard-step ${itemIndex === index ? 'is-current' : ''} ${itemIndex < index ? 'is-done' : ''}`}
                  aria-current={itemIndex === index ? 'step' : undefined}
                  onClick={() => goTo(itemIndex)}
                >
                  <span className="wizard-step-index">{itemIndex + 1}</span>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <Pill tone={status.tone}>{status.label}</Pill>
        </header>

        <div className="wizard-body">
          <StepBody
            id={step.id}
            onCardAction={(card) => {
              const target = WIZARD_STEPS.findIndex((item) => item.card === card.id)
              if (target >= 0) goTo(target)
            }}
          />
        </div>

        {failedAt === step.id ? (
          <p className="inline-warn" role="alert">
            保存失败，当前步骤仍未保存。
          </p>
        ) : null}

        <footer className="wizard-foot">
          <div className="row-gap">
            <Button onClick={() => goTo(index - 1)} disabled={busy || index === 0}>
              上一步
            </Button>
            <Button onClick={skip} disabled={busy}>
              跳过
            </Button>
            <Button variant="primary" onClick={() => void saveAndContinue()} disabled={busy || s.saving}>
              {busy || s.saving
                ? '保存中…'
                : step.id === 'finish'
                  ? '保存并完成'
                  : '保存并继续'}
            </Button>
          </div>
          <span className="muted small">
            第 {index + 1} / {WIZARD_STEPS.length} 步
          </span>
        </footer>
      </section>
    </SettingsContext.Provider>
  )
}
