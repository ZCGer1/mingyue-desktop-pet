import { useCallback, useEffect, useState } from 'react'
import type { DesktopScopeApp } from '../../../../shared/config'
import { SCREEN_SHARE_CONSENT_VERSION } from '../../../../shared/config'
import type { RunningAppView, VisionStatusView } from '../../../../shared/ipc'
import { normalizeProcessKey } from '../../../../shared/processName'
import { useSettings } from '../../context'
import { Button, Empty, Field, FieldRow, Pill, StatusLine, Toggle } from '../../ui'

const FIXED_BLOCKED = [
  '终端/命令行（cmd、PowerShell、Windows Terminal、WSL、SSH 等）',
  'UAC、安全桌面、锁屏与登录界面',
  '密码管理器（KeePass、1Password、Bitwarden 等）',
  '任务管理器、注册表、组策略、远程桌面',
  '标题命中银行/支付/密码/验证码等敏感词的窗口',
  '桌宠自己（桌宠/聊天/设置窗口）'
]

const ACTION_LABELS: Record<string, string> = {
  screenshot: '截图',
  zoom: '放大截图',
  click: '点击',
  scroll: '滚动',
  drag: '拖拽',
  type: '输入文字',
  key: '按键',
  wait: '等待',
  stop: '停止'
}

const QUALITY_LABELS: Record<string, string> = {
  good: '正常',
  low: '分辨率偏低',
  static: '画面静止',
  black: '黑屏/受保护',
  frozen: '画面冻结',
  blocked: '已暂停采集',
  unavailable: '不可用'
}

const BLOCKED_LABELS: Record<string, string> = {
  'user-paused': '你暂停了观察',
  paused: '已暂停',
  locked: '锁屏中',
  suspended: '系统挂起',
  'sensitive-app': '当前是敏感应用',
  'activity-disabled': '行为感知总开关关闭',
  'observation-disabled': '屏幕感知未开启或未授权',
  meeting: '会议应用（隐私保护）',
  'cua-busy': '电脑操作进行中，暂时让出截屏',
  'self-foreground': '前台是桌宠自己的窗口',
  'foreground-unknown': '无法确认前台窗口所在显示器',
  'vision-unavailable': '屏幕感知未启动'
}

function observeReasonLabel(reason: string | null): string {
  return reason === null ? '未知原因' : (BLOCKED_LABELS[reason] ?? reason)
}

function agoLabel(at: number | null): string {
  if (at === null) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`
}

/**
 * 屏幕：屏幕感知、整屏共享、窗口观察、逐应用观察/输入与键鼠控制。
 *
 * 截图共享、整屏共享与键鼠输入是三次独立决定，不会互相代勾。
 */
export function ScreenSection(): React.JSX.Element {
  const s = useSettings()
  const vision = s.config.worlds.activity.vision
  const cua = s.config.worlds.cua
  const desktop = s.config.worlds.desktop
  const exploration = s.config.exploration
  const activity = s.config.worlds.activity
  const provider = s.config.provider
  const [status, setStatus] = useState<VisionStatusView | null>(null)
  const [running, setRunning] = useState<RunningAppView[]>([])
  const [scanBusy, setScanBusy] = useState(false)
  const [manualProcess, setManualProcess] = useState('')
  const [blockedText, setBlockedText] = useState(cua.blockedApps.join('\n'))
  const [busy, setBusy] = useState(false)

  const consented = cua.consentAt !== null && cua.screenConsentAt !== null
  const shareConsented =
    vision.screenShareConsentAt !== null &&
    vision.screenShareConsentVersion === SCREEN_SHARE_CONSENT_VERSION
  const cuaReady =
    cua.enabled && typeof cua.consentAt === 'number' && provider.visionInput === true

  const refreshVision = useCallback(async (): Promise<void> => {
    if (!activity.enabled || !vision.enabled) {
      setStatus(null)
      return
    }
    try {
      setStatus(await window.mingyue.settings.getVisionStatus())
    } catch {
      setStatus(null)
    }
  }, [activity.enabled, vision.enabled])

  useEffect(() => {
    void refreshVision()
    if (!activity.enabled || !vision.enabled) return
    const timer = window.setInterval(() => void refreshVision(), 5000)
    return () => window.clearInterval(timer)
  }, [refreshVision, activity.enabled, vision.enabled])

  const refreshRunning = async (): Promise<void> => {
    setScanBusy(true)
    try {
      setRunning(await window.mingyue.settings.runningApps())
    } catch {
      setRunning([])
    } finally {
      setScanBusy(false)
    }
  }

  useEffect(() => {
    void refreshRunning()
  }, [])

  // 键鼠状态只在本子页挂载期间轮询；隐藏子页不再产生重复请求。
  const loadCuaStatus = s.loadCuaStatus
  useEffect(() => {
    void loadCuaStatus()
    const timer = window.setInterval(() => void loadCuaStatus(), 2000)
    return () => window.clearInterval(timer)
  }, [loadCuaStatus])

  const addApp = (process: string, label: string): void => {
    const key = normalizeProcessKey(process)
    if (key === null || desktop.apps.some((app) => app.process === key)) return
    s.update(['worlds', 'desktop', 'apps'], [
      ...desktop.apps,
      { process: key, label: label.slice(0, 40), observe: true, input: false }
    ])
    setManualProcess('')
  }

  const updateApp = (index: number, patch: Partial<DesktopScopeApp>): void => {
    const next = desktop.apps.map((app, itemIndex) => {
      if (itemIndex !== index) return app
      const merged = { ...app, ...patch }
      return merged.observe ? merged : { ...merged, input: false }
    })
    s.update(['worlds', 'desktop', 'apps'], next)
  }

  const toggleVision = (checked: boolean): void => {
    if (checked) {
      const agreed = window.confirm(
        [
          '开启屏幕感知？',
          '',
          '她会定期观察“前台窗口所在显示器”的整屏画面，用来判断你正在做什么。',
          '',
          '· 默认每 60 秒一次；同一画面连续静止后自动降为 120 秒；',
          '· 原始截图只在本机内存里用于画质/变化比较，不写盘、不进日志；',
          '· 开启观察不等于把画面发给模型：模型共享必须另在下方单独确认；',
          '· 本地 OCR 默认关闭，只有模型不可用时才可选用作兜底；',
          '· 锁屏、挂起、敏感应用、会议、电脑操作进行中或你手动暂停时停止采集；',
          '· 观察不会抢走前台焦点，也不会伪造事件；可随时暂停或关闭。'
        ].join('\n')
      )
      if (!agreed) return
      s.update(['worlds', 'activity', 'vision', 'enabled'], true)
      s.update(['worlds', 'activity', 'vision', 'consentAt'], vision.consentAt ?? Date.now())
    } else {
      s.update(['worlds', 'activity', 'vision', 'enabled'], false)
      s.update(['worlds', 'activity', 'vision', 'screenShareConsentAt'], null)
      s.update(['worlds', 'activity', 'vision', 'screenShareConsentVersion'], 0)
    }
  }

  const toggleShare = (checked: boolean): void => {
    if (checked) {
      const agreed = window.confirm(
        [
          '确认把整屏画面发送给当前聊天模型？',
          '',
          '· 范围：前台窗口所在显示器的整个屏幕，不是只裁剪前台窗口。',
          '  同屏的其他窗口、通知、聊天与密码管理器画面都可能被拍入。',
          `· 模型：${provider.model}`,
          `· 接口：${provider.baseUrl || 'https://api.deepseek.com'}`,
          '· 使用与聊天相同的 API Key；每次最多发送 1 张压缩 JPEG。',
          '· 请求独立且无工具，结果只作为观察数据，约 90 秒后过期。',
          '· 不承诺自动遮盖密码、私密聊天或浏览器隐私模式。',
          '· 暂停、锁屏、挂起、敏感应用、会议或电脑操作期间不采集。'
        ].join('\n')
      )
      if (!agreed) return
      s.update(['worlds', 'activity', 'vision', 'screenShareConsentAt'], Date.now())
      s.update(
        ['worlds', 'activity', 'vision', 'screenShareConsentVersion'],
        SCREEN_SHARE_CONSENT_VERSION
      )
    } else {
      s.update(['worlds', 'activity', 'vision', 'screenShareConsentAt'], null)
      s.update(['worlds', 'activity', 'vision', 'screenShareConsentVersion'], 0)
    }
  }

  const changeCuaEnabled = (enabled: boolean): void => {
    if (!enabled) {
      s.update(['worlds', 'cua', 'enabled'], false)
      s.notify('电脑操作已关闭；保存后停止。', 'warn')
      return
    }
    if (!provider.visionInput) {
      s.notify('模型设置关闭了图片输入；电脑操作需要视觉能力。', 'warn')
      return
    }
    if (consented) {
      s.update(['worlds', 'cua', 'enabled'], true)
      return
    }
    const keyboardOk = window.confirm(
      [
        '允许桌宠模拟鼠标与键盘、操作任意可见应用？',
        '',
        '• 首次输入会请求确认；选择“30 分钟内允许”后，在这段时间内不再逐次询问。',
        '• 可随时按 Ctrl+Alt+Shift+Esc、点桌宠“停止”或在设置页停止。',
        '• 终端/shell、UAC/锁屏、密码管理器、银行/支付/验证码界面永远禁止。',
        '• 她不会切换窗口焦点；切换应用只能靠点击任务栏或 Alt+Tab。'
      ].join('\n')
    )
    if (!keyboardOk) return
    const screenOk = window.confirm(
      [
        '允许桌宠截取屏幕并发送给 DeepSeek？',
        '',
        '• 截图只存在于当前对话轮次的内存中：不写磁盘、不写会话记录、不写事件库/日志/审计。',
        '• 交接摘要、快捷摘要和诊断导出都不包含截图。',
        '• 敏感前台应用会被拒绝截图；关闭电脑操作后不再截图。',
        '',
        '按“确定”表示同意以上两项；按“取消”则保持关闭。'
      ].join('\n')
    )
    if (!screenOk) return
    const now = Date.now()
    if (cua.consentAt === null) s.update(['worlds', 'cua', 'consentAt'], now)
    if (cua.screenConsentAt === null) s.update(['worlds', 'cua', 'screenConsentAt'], now)
    s.update(['worlds', 'cua', 'enabled'], true)
    s.notify('已记录双重同意；保存后生效。', 'warn')
  }

  const pauseOrResume = async (pause: boolean): Promise<void> => {
    try {
      if (pause) await window.mingyue.settings.pauseVision()
      else await window.mingyue.settings.resumeVision()
      s.notify(pause ? '屏幕感知已暂停。' : '屏幕感知已恢复。', 'ok')
      await refreshVision()
    } catch {
      s.notify(pause ? '暂停屏幕感知失败。' : '恢复屏幕感知失败。', 'error')
    }
  }

  const observeNow = async (): Promise<void> => {
    setBusy(true)
    try {
      if (s.dirty) {
        s.notify('请先保存当前修改，再立即观察。', 'warn')
        return
      }
      const result = await window.mingyue.settings.observeVisionNow()
      s.notify(
        result.ok ? '已完成一次观察。' : `本次未观察：${observeReasonLabel(result.reason)}`,
        result.ok ? 'ok' : 'warn'
      )
      await refreshVision()
    } catch {
      s.notify('立即观察失败。', 'error')
    } finally {
      setBusy(false)
    }
  }

  const cuaStatus = s.cuaStatus

  return (
    <div className="stack section-stack">
      <section className="section" aria-labelledby="screen-status">
        <header className="section-head">
          <h2 id="screen-status">屏幕</h2>
          <div className="section-actions">
            <Pill tone={vision.enabled ? 'ok' : 'neutral'}>
              {vision.enabled ? '屏幕感知已开启' : '屏幕感知关闭'}
            </Pill>
            <Pill tone={shareConsented ? 'warn' : 'neutral'}>
              {shareConsented ? '整屏共享已同意' : '整屏不发送'}
            </Pill>
            <Pill tone={consented ? 'ok' : 'neutral'}>
              {consented ? '键鼠 + 截图已同意' : '尚未完成双重同意'}
            </Pill>
          </div>
        </header>
        <div className="section-body">
          <Toggle label="开启屏幕感知" checked={vision.enabled} onChange={toggleVision} />
          <Toggle
            label="我同意把整屏画面发送给当前聊天模型"
            checked={shareConsented}
            disabled={!vision.enabled}
            onChange={toggleShare}
          />
          <Toggle label="允许电脑操作（键鼠与截图）" checked={cua.enabled} onChange={changeCuaEnabled} />
          <StatusLine label="图片输入">
            {provider.visionInput ? (
              '已开启'
            ) : (
              <>
                未开启
                <Button variant="subtle" onClick={() => s.navigate('model', 'model')}>
                  去模型设置
                </Button>
              </>
            )}
          </StatusLine>
          <StatusLine label="观察状态">
            {!activity.enabled
              ? '行为感知总开关未开启'
              : !vision.enabled
                ? '屏幕感知未开启'
                : status === null
                  ? '—'
                  : `${status.paused ? '已暂停' : (BLOCKED_LABELS[status.blockedReason ?? ''] ?? '正在观察')} · ${QUALITY_LABELS[status.quality ?? ''] ?? '质量未知'} · 最近采集 ${agoLabel(status.lastFrameAt)}`}
          </StatusLine>
          <StatusLine label="键鼠">
            {cuaStatus === null
              ? '—'
              : `${cuaStatus.enabled ? '运行中' : '未启用'} · 本轮 ${cuaStatus.actionsThisTurn}/${cuaStatus.maxActionsPerTurn}${cuaStatus.lastAction === null || cuaStatus.lastAction === undefined ? '' : ` · 最近 ${ACTION_LABELS[cuaStatus.lastAction] ?? cuaStatus.lastAction}`}`}
          </StatusLine>
          <div className="row-gap">
            <Button
              onClick={() => void pauseOrResume(true)}
              disabled={!vision.enabled || status?.paused === true}
            >
              暂停观察
            </Button>
            <Button
              onClick={() => void pauseOrResume(false)}
              disabled={!vision.enabled || status?.paused !== true}
            >
              恢复观察
            </Button>
            <Button onClick={() => void observeNow()} disabled={busy || !vision.enabled}>
              立即观察一次
            </Button>
            <Button variant="danger" onClick={() => void s.stopCua()} disabled={!cua.enabled}>
              立即停止键鼠
            </Button>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="screen-windows">
        <header className="section-head">
          <h2 id="screen-windows">窗口观察</h2>
        </header>
        <div className="section-body">
          <Toggle
            label="授权窗口观察"
            checked={exploration.windows}
            disabled={!exploration.enabled}
            onChange={(checked) => s.update(['exploration', 'windows'], checked)}
          />
          <Toggle
            label="整屏 / 多显示器观察"
            checked={exploration.fullScreen}
            disabled={!exploration.enabled}
            onChange={(checked) => s.update(['exploration', 'fullScreen'], checked)}
          />
          {exploration.fullScreen && !cuaReady ? (
            <p className="inline-warn">
              整屏范围已勾选，但还缺少：
              {cua.enabled ? '' : '电脑操作开关、'}
              {typeof cua.consentAt === 'number' ? '' : '键鼠同意、'}
              {typeof cua.screenConsentAt === 'number' ? '' : '截图同意、'}
              {provider.visionInput ? '' : '模型图片输入、'}
              补齐后才真正生效。
            </p>
          ) : null}
          <Toggle
            label="读取结构化文本（UI Automation）"
            checked={desktop.structuredText}
            onChange={(checked) => s.update(['worlds', 'desktop', 'structuredText'], checked)}
          />
          <Toggle
            label="允许按窗口截图"
            checked={desktop.windowCapture}
            onChange={(checked) => s.update(['worlds', 'desktop', 'windowCapture'], checked)}
          />
        </div>
      </section>

      <section className="section" aria-labelledby="screen-apps">
        <header className="section-head">
          <h2 id="screen-apps">应用观察与输入范围</h2>
          <div className="section-actions">
            <Button onClick={() => void refreshRunning()} disabled={scanBusy}>
              {scanBusy ? '扫描中…' : '刷新运行中应用'}
            </Button>
          </div>
        </header>
        <div className="section-body">
          {desktop.apps.length === 0 ? (
            <Empty>没有应用级覆盖。</Empty>
          ) : (
            <ul className="undo-list">
              {desktop.apps.map((app, index) => (
                <li key={app.process} className="stack">
                  <div className="row-gap">
                    <Pill tone={app.observe ? 'info' : 'neutral'}>
                      {app.observe ? '观察' : '未观察'}
                    </Pill>
                    <strong>{app.label}</strong>
                    <span className="mono dim grow">{app.process}</span>
                    <Button
                      variant="subtle"
                      onClick={() =>
                        s.update(
                          ['worlds', 'desktop', 'apps'],
                          desktop.apps.filter((_, itemIndex) => itemIndex !== index)
                        )
                      }
                    >
                      移除
                    </Button>
                  </div>
                  <Toggle
                    label="允许观察这个应用"
                    checked={app.observe}
                    onChange={(checked) => updateApp(index, { observe: checked })}
                  />
                  <Toggle
                    label="允许任务在这个应用里输入"
                    checked={app.input}
                    disabled={!app.observe}
                    onChange={(checked) => updateApp(index, { input: checked })}
                  />
                </li>
              ))}
            </ul>
          )}

          <div className="grid-2">
            <Field label="手动添加进程名" hint="不含路径与 .exe。">
              <div className="row-gap">
                <input
                  className="input"
                  value={manualProcess}
                  maxLength={120}
                  placeholder="chrome"
                  onChange={(event) => setManualProcess(event.target.value)}
                />
                <Button
                  onClick={() => {
                    const key = normalizeProcessKey(manualProcess)
                    if (key === null) {
                      s.notify('进程名格式无效。', 'warn')
                      return
                    }
                    addApp(key, key)
                  }}
                >
                  添加
                </Button>
              </div>
            </Field>
            <FieldRow label="运行中的候选">
              {running.filter((app) => !desktop.apps.some((item) => item.process === app.process))
                .length === 0 ? (
                <span className="muted small">没有新的候选应用。</span>
              ) : (
                <div className="row-gap">
                  {running
                    .filter((app) => !desktop.apps.some((item) => item.process === app.process))
                    .slice(0, 12)
                    .map((app) => (
                      <Button
                        key={app.process}
                        variant="subtle"
                        onClick={() => addApp(app.process, app.label)}
                      >
                        + {app.label}
                      </Button>
                    ))}
                </div>
              )}
            </FieldRow>
          </div>
        </div>
      </section>

      <details id="screen-advanced" className="advanced-block page-anchor-block">
        <summary>高级</summary>
        <div className="section-body">
          <div className="grid-2">
            <Field label="基础观察周期">
              <select
                className="input"
                value={vision.desktopSampleMs}
                disabled={!vision.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'activity', 'vision', 'desktopSampleMs'],
                    Number(event.target.value)
                  )
                }
              >
                <option value={60000}>60 秒</option>
                <option value={120000}>120 秒</option>
              </select>
            </Field>
            <Field label="静止画面周期（秒）">
              <span className="muted small">{Math.max(120_000, vision.staticSampleMs) / 1000}</span>
            </Field>
            <Field label="OCR 语言">
              <select
                className="input"
                value={vision.language}
                disabled={!vision.enabled || !vision.ocrFallback}
                onChange={(event) =>
                  s.update(['worlds', 'activity', 'vision', 'language'], event.target.value)
                }
              >
                <option value="auto">自动（中文优先）</option>
                <option value="zh-Hans">中文</option>
                <option value="en-US">English</option>
              </select>
            </Field>
            <Field label="OCR 最短间隔（秒）">
              <select
                className="input"
                value={vision.ocrMinGapMs}
                disabled={!vision.enabled || !vision.ocrFallback}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'activity', 'vision', 'ocrMinGapMs'],
                    Number(event.target.value)
                  )
                }
              >
                <option value={2000}>2</option>
                <option value={3000}>3</option>
                <option value={5000}>5</option>
              </select>
            </Field>
            <Field label="保存最近场景">
              <input
                className="input input-num"
                type="number"
                min={0}
                max={100}
                value={vision.keepSamples}
                disabled={!vision.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'activity', 'vision', 'keepSamples'],
                    Number(event.target.value)
                  )
                }
              />
            </Field>
            <Field label="每小时观察上限">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={200}
                value={desktop.maxObservePerHour}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'desktop', 'maxObservePerHour'],
                    Math.max(1, Math.min(200, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="单次读取字符上限">
              <input
                className="input input-num"
                type="number"
                min={500}
                max={20000}
                value={desktop.maxTextChars}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'desktop', 'maxTextChars'],
                    Math.max(500, Math.min(20000, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="窗口清单上限">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={50}
                value={desktop.maxWindows}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'desktop', 'maxWindows'],
                    Math.max(1, Math.min(50, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="窗口清单轮询（秒，0 关闭）">
              <input
                className="input input-num"
                type="number"
                min={0}
                max={600}
                value={Math.round(desktop.inventoryPollMs / 1000)}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'desktop', 'inventoryPollMs'],
                    Math.max(0, Math.min(600, Number(event.target.value))) * 1000
                  )
                }
              />
            </Field>
            <Field label="输入确认">
              <select
                className="input"
                value={cua.permission}
                disabled={!cua.enabled}
                onChange={(event) =>
                  s.update(['worlds', 'cua', 'permission'], event.target.value)
                }
              >
                <option value="ask-once">首次确认后，一段时间内免问</option>
                <option value="ask-each-action">每次输入都询问</option>
              </select>
            </Field>
            <Field label="免问时长（分钟）">
              <input
                className="input input-num"
                type="number"
                min={5}
                max={120}
                disabled={!cua.enabled || cua.permission !== 'ask-once'}
                value={cua.grantMinutes}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'cua', 'grantMinutes'],
                    Math.min(120, Math.max(5, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <div className="row-actions">
              <span className="muted small">免问授权</span>
              <Button
                variant="subtle"
                onClick={() => void s.clearCuaGrants()}
                disabled={!consented}
              >
                清除免问授权
              </Button>
            </div>
            <Field label="每轮最多动作">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={60}
                disabled={!cua.enabled}
                value={cua.maxActionsPerTurn}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'cua', 'maxActionsPerTurn'],
                    Math.min(60, Math.max(1, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="截图最大宽度（像素）">
              <input
                className="input input-num"
                type="number"
                min={960}
                max={1920}
                step={64}
                disabled={!cua.enabled}
                value={cua.screenshotMaxWidth}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'cua', 'screenshotMaxWidth'],
                    Math.min(1920, Math.max(960, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="JPEG 质量">
              <input
                className="input input-num"
                type="number"
                min={50}
                max={90}
                disabled={!cua.enabled}
                value={cua.jpegQuality}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'cua', 'jpegQuality'],
                    Math.min(90, Math.max(50, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="动作后等待（毫秒）">
              <input
                className="input input-num"
                type="number"
                min={100}
                max={2000}
                step={50}
                disabled={!cua.enabled}
                value={cua.settleMs}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'cua', 'settleMs'],
                    Math.min(2000, Math.max(100, Number(event.target.value)))
                  )
                }
              />
            </Field>
          </div>
          <Toggle
            label="模型不可用时用本地 OCR 兜底"
            checked={vision.ocrFallback}
            disabled={!vision.enabled}
            onChange={(checked) =>
              s.update(['worlds', 'activity', 'vision', 'ocrFallback'], checked)
            }
          />
          <Toggle
            label="显示最近一次 OCR 原文（高风险）"
            checked={vision.showOcrSnippet}
            disabled={!vision.enabled || !vision.ocrFallback}
            onChange={(checked) =>
              s.update(['worlds', 'activity', 'vision', 'showOcrSnippet'], checked)
            }
          />
          <Toggle
            label="操作后自动截图"
            checked={cua.afterActionScreenshot}
            disabled={!cua.enabled}
            onChange={(checked) => s.update(['worlds', 'cua', 'afterActionScreenshot'], checked)}
          />
          <Toggle
            label="在桌宠上显示动作标记"
            checked={cua.actionOverlay}
            disabled={!cua.enabled}
            onChange={(checked) => s.update(['worlds', 'cua', 'actionOverlay'], checked)}
          />
          <Field label="追加阻止的应用" hint="每行一个进程名；固定敏感名单不可移除。">
            <textarea
              className="input textarea"
              rows={3}
              value={blockedText}
              placeholder={'notepad.exe\nexample.exe'}
              onChange={(event) => {
                const text = event.target.value
                setBlockedText(text)
                s.update(
                  ['worlds', 'cua', 'blockedApps'],
                  text
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line !== '')
                )
              }}
            />
          </Field>
          <details className="advanced">
            <summary>固定禁止</summary>
            <ul className="plain-list">
              {FIXED_BLOCKED.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </details>
        </div>
      </details>
    </div>
  )
}
