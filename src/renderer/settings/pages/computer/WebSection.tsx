import { useCallback, useEffect, useState } from 'react'
import type { BrowserBridgeStatusView } from '../../../../shared/ipc'
import { useSettings } from '../../context'
import { Anchor, Button, Empty, Field, Pill, StatusLine, Toggle } from '../../ui'

const REFRESH_MS = 5000

function splitLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * 网页：公开网页读取、当前页面感知、主动浏览、扩展连接与域名规则。
 *
 * 只挂载本子页时建立状态轮询；发现列表在活动页。
 */
export function WebSection(): React.JSX.Element {
  const s = useSettings()
  const page = s.config.worlds.browserPage
  const control = s.config.worlds.browserControl
  const exploration = s.config.exploration
  const [status, setStatus] = useState<BrowserBridgeStatusView | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.mingyue.settings.getBrowserStatus())
    } catch {
      /* 状态刷新失败不打断设置编辑 */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const toggleEnabled = (checked: boolean): void => {
    if (checked) {
      const agreed = window.confirm(
        [
          '开启浏览器页面感知？',
          '',
          '她将通过 Chrome/Edge 扩展读取当前活跃标签页的标题、域名、正文摘要和小标题，',
          '用于理解你正在看什么。',
          '',
          '· 只读取当前活跃标签页；不读取完整 URL、路径参数、cookie、localStorage、',
          '  表单值、密码字段、历史或书签；',
          '· 无痕窗口、密码输入页和敏感域名会被跳过；',
          '· 页面正文只在当轮对话中使用，不写日志、事件库、会话、记忆或诊断；',
          '· 扩展需要较宽的站点访问权限，可随时在扩展里暂停或卸载；',
          '· 还需安装扩展并粘贴配对码，未连接时她不会猜测页面内容。'
        ].join('\n')
      )
      if (!agreed) return
      s.update(['worlds', 'browserPage', 'enabled'], true)
      if (page.consentAt === null) {
        s.update(['worlds', 'browserPage', 'consentAt'], Date.now())
      }
    } else {
      s.update(['worlds', 'browserPage', 'enabled'], false)
    }
    window.setTimeout(() => void refresh(), 800)
  }

  const toggleActiveControl = (checked: boolean): void => {
    if (checked) {
      const agreed = window.confirm(
        [
          '开启主动浏览？',
          '',
          '她会使用 Chrome/Edge 扩展新建并操作自己的后台标签页：打开公开网页、站内搜索、',
          '读取页面结构与正文，并把值得记住的网页条目存进本地发现列表。',
          '',
          '· 只操作由她创建/接管的标签页；不会改动你正在使用的标签页，除非你允许接管；',
          '· 不读取 cookie、localStorage、密码字段或登录凭据；密码输入框永远不可填写；',
          '· 不自动“发送/发布/支付/下单”，这类外部动作仍会单独询问；',
          '· 不会自动播放或发声；确认不了静音/暂停时会停下并说明；',
          '· 页面内容只在当轮使用，不写日志、事件库、记忆或诊断；',
          '· 还需要在扩展弹窗勾选「允许主动浏览」，并且自由探索的标签页范围处于生效状态；',
          '· 可随时关闭本开关、点「停止浏览」或关闭扩展里的主动浏览。'
        ].join('\n')
      )
      if (!agreed) return
      s.update(['worlds', 'browserControl', 'enabled'], true)
      if (control.consentAt === null) {
        s.update(['worlds', 'browserControl', 'consentAt'], Date.now())
      }
    } else {
      s.update(['worlds', 'browserControl', 'enabled'], false)
    }
    window.setTimeout(() => void refresh(), 800)
  }

  const copyPairing = async (): Promise<void> => {
    const code = status?.bridge.pairingCode ?? null
    if (code === null) {
      s.notify('配对码尚未生成；先开启页面感知并保存。', 'warn')
      return
    }
    try {
      await navigator.clipboard.writeText(code)
      s.notify('配对码已复制。', 'ok')
    } catch {
      s.notify('复制失败，请手动选择配对码。', 'error')
    }
  }

  const rotate = async (): Promise<void> => {
    if (
      !window.confirm(
        '轮换配对 token？旧配对码会立即失效，必须到扩展选项里重新粘贴新配对码。'
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const code = await window.mingyue.settings.rotateBrowserToken()
      await refresh()
      s.notify(code === null ? 'token 已轮换，但桥未运行。' : 'token 已轮换；请到扩展中重新配对。', 'ok')
    } catch {
      s.notify('轮换 token 失败。', 'error')
    } finally {
      setBusy(false)
    }
  }

  const openExtensionFolder = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.mingyue.settings.openBrowserExtensionFolder()
      await refresh()
      s.notify(result.message, result.ok ? 'ok' : 'error')
    } catch {
      s.notify('无法打开扩展目录。', 'error')
    } finally {
      setBusy(false)
    }
  }

  const extension = status?.extension ?? null
  const bridge = status?.bridge
  const controlActive =
    control.enabled &&
    control.consentAt !== null &&
    exploration.enabled &&
    exploration.browserTabs &&
    status?.control.active === true

  return (
    <div className="stack section-stack">
      <Anchor id="browser" />
      <section className="section" aria-labelledby="web-status">
        <header className="section-head">
          <h2 id="web-status">网页</h2>
          <div className="section-actions">
            <Pill tone={status?.bridge.running ? 'ok' : 'neutral'}>
              {status?.bridge.running ? `本机桥 · ${status.bridge.port ?? '—'}` : '本机桥未运行'}
            </Pill>
            <Pill tone={status?.bridge.extensionConnected ? 'ok' : 'warn'}>
              {status?.bridge.extensionConnected ? '扩展已连接' : '扩展未连接'}
            </Pill>
            <Pill tone={controlActive ? 'ok' : 'neutral'}>
              {controlActive ? '主动浏览生效' : '主动浏览未生效'}
            </Pill>
          </div>
        </header>
        <div className="section-body">
          <StatusLine label="当前页">
            {status === null
              ? '—'
              : status.page.hasPage
                ? '有一页可用'
                : '没有页面'}
          </StatusLine>
          <StatusLine label="最近接收">
            {status?.bridge.lastPageAt == null
              ? '—'
              : new Date(status.bridge.lastPageAt).toLocaleTimeString()}
          </StatusLine>
          <StatusLine label="近一分钟">
            {status === null
              ? '—'
              : `接收 ${status.bridge.pagesLastMinute} · 拒绝 ${status.bridge.rejectedLastMinute}`}
          </StatusLine>

          <Toggle
            label="启用联网搜索与公开网页读取"
            checked={s.config.worlds.web.enabled}
            onChange={(checked) => s.update(['worlds', 'web', 'enabled'], checked)}
          />
          <Toggle
            label="每次搜索或抓取前询问"
            checked={s.config.worlds.web.askBefore}
            disabled={!s.config.worlds.web.enabled}
            onChange={(checked) => s.update(['worlds', 'web', 'askBefore'], checked)}
          />
          <Toggle
            label="开启浏览器页面感知"
            hint={
              page.consentAt === null
                ? undefined
                : `同意于 ${new Date(page.consentAt).toLocaleDateString()}`
            }
            checked={page.enabled}
            onChange={toggleEnabled}
          />
          <Toggle
            label="允许自主使用网页"
            checked={exploration.web}
            disabled={!exploration.enabled}
            onChange={(checked) => s.update(['exploration', 'web'], checked)}
          />
          <Toggle
            label="允许自主使用她自己的标签页"
            checked={exploration.browserTabs}
            disabled={!exploration.enabled}
            onChange={(checked) => s.update(['exploration', 'browserTabs'], checked)}
          />
          <Toggle
            label="允许主动浏览"
            checked={control.enabled}
            onChange={toggleActiveControl}
          />
          {control.enabled && !controlActive ? (
            <p className="inline-warn">
              主动浏览尚未生效：
              {exploration.enabled ? '' : '自由探索未开启；'}
              {exploration.browserTabs ? '' : '标签页范围未授权；'}
              {status?.control.active === false ? '扩展控制通道未连接。' : ''}
            </p>
          ) : null}
          <Toggle
            label="仅允许白名单域名"
            checked={page.allowlistOnly}
            disabled={!page.enabled}
            onChange={(checked) => s.update(['worlds', 'browserPage', 'allowlistOnly'], checked)}
          />
        </div>
      </section>

      <section className="section" aria-labelledby="web-pairing">
        <header className="section-head">
          <h2 id="web-pairing">扩展连接</h2>
        </header>
        <div className="section-body">
          {status === null ? (
            <Empty>正在读取桥状态…</Empty>
          ) : (
            <>
              {bridge?.portChangedFrom !== null && bridge?.portChangedFrom !== undefined ? (
                <p className="inline-warn">
                  配对地址已变化：原端口 {bridge.portChangedFrom} 不可用，改用 {bridge.port ?? '—'}；
                  请把新配对码粘贴到扩展选项。
                </p>
              ) : null}
              {extension !== null && !extension.ready ? (
                <p className="inline-warn">
                  扩展目录未准备好：{extension.error ?? extension.path}
                  {extension.retryable ? ' 关闭占用后重试。' : ''}
                </p>
              ) : null}
              <div className="pairing-box">
                <span className="mono pairing-code">
                  {bridge?.pairingCode ?? '桥未运行（先开启并保存页面感知）'}
                </span>
                <div className="row-gap">
                  <Button onClick={() => void copyPairing()} disabled={bridge?.pairingCode == null}>
                    复制配对码
                  </Button>
                  <Button variant="danger" onClick={() => void rotate()} disabled={busy}>
                    轮换 token
                  </Button>
                  <Button onClick={() => void openExtensionFolder()} disabled={busy}>
                    打开扩展文件夹
                  </Button>
                </div>
              </div>
              <dl className="status-grid">
                <dt>扩展目录</dt>
                <dd>
                  {extension === null
                    ? '尚未准备'
                    : `${extension.ready ? '已就绪' : '未就绪'} · ${extension.version === null || extension.version === undefined ? '版本未知' : `v${extension.version}`}`}
                  {extension === null ? null : (
                    <>
                      <br />
                      <code>{extension.path}</code>
                    </>
                  )}
                </dd>
                <dt>扩展连接</dt>
                <dd>
                  {bridge?.extensionConnected
                    ? '已联系本机'
                    : bridge?.running
                      ? '未联系本机'
                      : '本机桥未运行'}
                  {bridge?.extensionConnected && !bridge.controlConnected
                    ? ' · 主动控制未连接'
                    : ''}
                </dd>
                <dt>近一小时</dt>
                <dd>
                  页面 {bridge?.pagesLastHour ?? 0} · 事件 {status.page.eventsLastHour} · 超频丢弃{' '}
                  {status.page.droppedLastHour}
                </dd>
                <dt>最近错误</dt>
                <dd className={bridge?.lastError == null ? '' : 'text-bad'}>
                  {bridge?.lastError ?? '无'}
                </dd>
              </dl>
              <details className="advanced">
                <summary>安装扩展</summary>
                <ol className="steps small">
                  <li>先开启页面感知或主动浏览并保存，让本机桥启动。</li>
                  <li>点「打开扩展文件夹」，加载上方显示的稳定目录。</li>
                  <li>
                    Chrome 打开 <code>chrome://extensions</code>；Edge 打开{' '}
                    <code>edge://extensions</code>，开启开发者模式并「加载已解压的扩展程序」。
                  </li>
                  <li>打开扩展选项，粘贴配对码并保存；主动浏览还要在扩展弹窗单独勾选。</li>
                </ol>
              </details>
            </>
          )}
        </div>
      </section>

      <section className="section" aria-labelledby="web-domains">
        <header className="section-head">
          <h2 id="web-domains">域名规则</h2>
        </header>
        <div className="section-body">
          <Field label="允许的域名" hint="每行一个；仅白名单模式使用，支持 *.example.com。">
            <textarea
              className="input textarea"
              rows={3}
              value={page.allowlist.join('\n')}
              disabled={!page.enabled}
              onChange={(event) =>
                s.update(['worlds', 'browserPage', 'allowlist'], splitLines(event.target.value))
              }
            />
          </Field>
          <Field label="排除的域名" hint="每行一个；支持 *.example.com。">
            <textarea
              className="input textarea"
              rows={3}
              value={page.denylist.join('\n')}
              disabled={!page.enabled}
              onChange={(event) =>
                s.update(['worlds', 'browserPage', 'denylist'], splitLines(event.target.value))
              }
            />
          </Field>
          <Field label="敏感域名" hint="内置银行、支付、密码管理器、邮箱与网盘；清空会削弱保护。">
            <textarea
              className="input textarea"
              rows={6}
              value={page.sensitiveDomains.join('\n')}
              disabled={!page.enabled}
              onChange={(event) =>
                s.update(
                  ['worlds', 'browserPage', 'sensitiveDomains'],
                  splitLines(event.target.value)
                )
              }
            />
          </Field>
          <Field label="排除的站点（自由探索）" hint="每行一个；命中后不会自动浏览或导航。">
            <textarea
              className="input textarea"
              rows={3}
              value={exploration.excludedDomains.join('\n')}
              onChange={(event) =>
                s.update(['exploration', 'excludedDomains'], splitLines(event.target.value))
              }
            />
          </Field>
        </div>
      </section>

      <details id="web-advanced" className="advanced-block page-anchor-block">
        <summary>高级</summary>
        <div className="section-body">
          <Toggle
            label="共享页面标题"
            checked={page.shareTitle}
            disabled={!page.enabled}
            onChange={(checked) => s.update(['worlds', 'browserPage', 'shareTitle'], checked)}
          />
          <Toggle
            label="共享正文摘要"
            checked={page.shareExcerpt}
            disabled={!page.enabled}
            onChange={(checked) => s.update(['worlds', 'browserPage', 'shareExcerpt'], checked)}
          />
          <Toggle
            label="共享小标题"
            checked={page.includeHeadings}
            disabled={!page.enabled}
            onChange={(checked) =>
              s.update(['worlds', 'browserPage', 'includeHeadings'], checked)
            }
          />
          <div className="grid-2">
            <Field label="摘要长度上限（字）">
              <select
                className="input"
                value={page.excerptMaxChars}
                disabled={!page.enabled || !page.shareExcerpt}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'browserPage', 'excerptMaxChars'],
                    Number(event.target.value)
                  )
                }
              >
                <option value={600}>600</option>
                <option value={1200}>1200</option>
                <option value={2000}>2000</option>
                <option value={4000}>4000</option>
              </select>
            </Field>
            <Field label="页面合并窗口（秒）">
              <select
                className="input"
                value={page.coalesceMs}
                disabled={!page.enabled}
                onChange={(event) =>
                  s.update(['worlds', 'browserPage', 'coalesceMs'], Number(event.target.value))
                }
              >
                <option value={2000}>2</option>
                <option value={3000}>3</option>
                <option value={5000}>5</option>
                <option value={10000}>10</option>
              </select>
            </Field>
            <Field label="每分钟最多事件">
              <select
                className="input"
                value={page.maxPerMinute}
                disabled={!page.enabled}
                onChange={(event) =>
                  s.update(['worlds', 'browserPage', 'maxPerMinute'], Number(event.target.value))
                }
              >
                <option value={3}>3</option>
                <option value={6}>6</option>
                <option value={10}>10</option>
              </select>
            </Field>
            <Field label="每小时最多事件">
              <select
                className="input"
                value={page.maxPerHour}
                disabled={!page.enabled}
                onChange={(event) =>
                  s.update(['worlds', 'browserPage', 'maxPerHour'], Number(event.target.value))
                }
              >
                <option value={30}>30</option>
                <option value={60}>60</option>
                <option value={120}>120</option>
              </select>
            </Field>
            <Field label="她自己的标签页上限">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={12}
                value={control.maxTabs}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'browserControl', 'maxTabs'],
                    Math.max(1, Math.min(12, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="页面等待上限（秒）">
              <input
                className="input input-num"
                type="number"
                min={5}
                max={60}
                value={Math.round(control.waitTimeoutMs / 1000)}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'browserControl', 'waitTimeoutMs'],
                    Math.max(5, Math.min(60, Number(event.target.value))) * 1000
                  )
                }
              />
            </Field>
            <Field label="搜索地址模板">
              <input
                className="input"
                value={control.searchUrl}
                onChange={(event) =>
                  s.update(['worlds', 'browserControl', 'searchUrl'], event.target.value)
                }
              />
            </Field>
            <Field label="单次浏览时长（分钟）">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={15}
                value={Math.round(control.sessionMaxMs / 60_000)}
                disabled={!control.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'browserControl', 'sessionMaxMs'],
                    Math.max(1, Math.min(15, Number(event.target.value))) * 60_000
                  )
                }
              />
            </Field>
            <Field label="单次工具调用上限">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={60}
                value={control.sessionMaxToolCalls}
                disabled={!control.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'browserControl', 'sessionMaxToolCalls'],
                    Math.max(1, Math.min(60, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="发现保留（天）">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={90}
                value={control.discoveries.retentionDays}
                disabled={!control.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'browserControl', 'discoveries', 'retentionDays'],
                    Math.max(1, Math.min(90, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="发现条数上限">
              <input
                className="input input-num"
                type="number"
                min={10}
                max={500}
                value={control.discoveries.maxRecords}
                disabled={!control.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'browserControl', 'discoveries', 'maxRecords'],
                    Math.max(10, Math.min(500, Number(event.target.value)))
                  )
                }
              />
            </Field>
          </div>
          {control.searchUrl.includes('{query}') ? null : (
            <p className="inline-warn">搜索模板缺少 {'{query}'}，搜索动作会被拒绝。</p>
          )}
        </div>
      </details>
    </div>
  )
}
