import { useState } from 'react'
import type { BiliAsrModel } from '../../../shared/config'
import {
  BILI_LOGIN_LABELS,
  type BiliInstallKind,
  type BiliInstallView,
  type BiliLoginQrView,
  type BiliSettingsAction
} from '../../../shared/bilibili'
import type { DiscoverySettingsView } from '../../../shared/ipc'
import { useSettings } from '../context'
import { Button, Empty, Field, Pill, Toggle } from '../ui'

const ASR_MODELS: BiliAsrModel[] = ['tiny', 'base', 'small', 'medium']

const INSTALL_LABELS: Record<BiliInstallKind, string> = {
  python: 'Python 运行时',
  service: '主服务依赖',
  asr: '本地转写依赖',
  model: '转写模型'
}

const INSTALL_STATE_LABELS: Record<BiliInstallView['state'], string> = {
  unknown: '未检查',
  missing: '未安装',
  installing: '安装中',
  ready: '可用',
  failed: '失败'
}

function splitLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * B 站独立 API 阅读设置。
 *
 * 只展示阶段、账号昵称/脱敏 UID、安装进度和计数；SESSDATA 等凭据永远
 * 不进入渲染进程。轮询由所在子页负责，这里不重复建立。
 */
export function BilibiliSettings({
  discovery,
  onRefresh
}: {
  discovery: DiscoverySettingsView | null
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const s = useSettings()
  const bili = s.config.worlds.bilibili
  const [busy, setBusy] = useState<string | null>(null)
  const [qr, setQr] = useState<BiliLoginQrView | null>(null)

  const run = async (action: BiliSettingsAction): Promise<void> => {
    if (busy !== null) return
    setBusy(action.action)
    try {
      const result = await window.mingyue.settings.biliAction(action)
      if (result.qr !== null) setQr(result.qr)
      s.notify(result.message, result.ok ? 'ok' : 'error')
      await onRefresh()
    } catch {
      s.notify('操作失败，请稍后再试。', 'error')
    } finally {
      setBusy(null)
    }
  }

  const toggleEnabled = (checked: boolean): void => {
    if (checked) {
      const agreed = window.confirm(
        [
          '启用 B 站独立阅读？',
          '',
          '她会通过专用 Python 服务，以你自己的 B 站账号扫码登录后只读公开内容：',
          '推荐、站内搜索、视频详情、字幕原文；没有字幕时可下载该视频音频，',
          '在本机用 Whisper 转写；必要时从故事板抽取少量画面交给当前模型。',
          '',
          '· 只读：不点赞、不投币、不收藏、不关注、不评论、不发送弹幕/私信、不购买、不分享、不发布；',
          '· 登录凭据只保存在主进程并用系统安全存储（DPAPI）加密，不进入提示词、日志或渲染进程；',
          '· 音频与转写只在本机处理，不使用云端转写；临时音频在任务结束后清理；',
          '· 发现列表与日报只保存标题、链接、短理由、要点和证据覆盖度，不保存字幕/转写全文；',
          '· 每天探索结束后更新当天日报；只有值得分享的内容才会在既有人格与安静策略下提醒你；',
          '· 不设固定定时刷视频；关闭记忆时相关记录只存在于本次运行；',
          '· 随时可在下方停止阅读、退出账号或关闭本开关。'
        ].join('\n')
      )
      if (!agreed) return
      s.update(['worlds', 'bilibili', 'enabled'], true)
      if (bili.consentAt === null) {
        s.update(['worlds', 'bilibili', 'consentAt'], Date.now())
      }
    } else {
      s.update(['worlds', 'bilibili', 'enabled'], false)
    }
  }

  const status = discovery?.status ?? null
  const report = discovery?.report ?? null
  const reading = discovery?.reading ?? null
  const currentQr = qr ?? discovery?.qr ?? null
  const enabled = bili.enabled && bili.consentAt !== null
  const installing =
    status?.environment !== undefined &&
    [status.environment.service, status.environment.asr, status.environment.model].some(
      (item) => item.state === 'installing'
    )

  return (
    <div className="stack section-stack">
      <section className="section" aria-labelledby="bili-status">
        <header className="section-head">
          <h2 id="bili-status">B 站</h2>
          <div className="section-actions">
            <Pill tone={enabled ? 'ok' : 'neutral'}>{enabled ? '已启用' : '默认关闭'}</Pill>
            <Pill tone={status?.login.state === 'logged-in' ? 'ok' : 'neutral'}>
              {status === null ? '状态未知' : BILI_LOGIN_LABELS[status.login.state]}
            </Pill>
          </div>
        </header>
        <div className="section-body">
          <Toggle label="启用 B 站独立阅读" checked={enabled} onChange={toggleEnabled} />
          {discovery === null ? (
            <Empty>正在读取 B 站服务状态…</Empty>
          ) : discovery.unavailableReason !== null ? (
            <p className="inline-warn">{discovery.unavailableReason}</p>
          ) : status === null ? (
            <p className="inline-warn">暂时读不到服务状态。</p>
          ) : (
            <>
              <dl className="status-grid">
                <dt>当前阶段</dt>
                <dd>
                  {status.phaseLabel}
                  {status.service.state === 'ready' ? '' : ` · 服务=${status.service.state}`}
                </dd>
                <dt>Python</dt>
                <dd>
                  {status.environment.pythonFound
                    ? `已找到${status.environment.pythonVersion === null ? '' : ` ${status.environment.pythonVersion}`}`
                    : '未找到 Python 3.10+'}
                </dd>
                <dt>登录</dt>
                <dd>
                  {BILI_LOGIN_LABELS[status.login.state]}
                  {status.login.accountName === null ? '' : ` · ${status.login.accountName}`}
                  {status.login.uidMasked === null ? '' : `（UID ${status.login.uidMasked}）`}
                </dd>
                <dt>本次会话</dt>
                <dd>
                  {status.session.active
                    ? `进行中 · 工具 ${status.session.toolCalls}/${status.session.maxToolCalls} · 详情 ${status.session.details}/${status.session.maxDetails}`
                    : '没有打开的阅读会话'}
                </dd>
                <dt>今日阅读</dt>
                <dd>
                  {reading === null
                    ? '—'
                    : `检查 ${reading.counts.checked} · 值得 ${reading.counts.worth} · 跳过 ${reading.counts.skip}`}
                </dd>
                <dt>今日日报</dt>
                <dd>
                  {report === null
                    ? '—'
                    : `${report.date} · ${report.markdown === '' ? '尚未生成' : '已更新'} · ${report.exists ? '已落盘' : '仅在内存'}`}
                </dd>
                <dt>今日失败</dt>
                <dd className={status.recentFailures.length === 0 ? '' : 'text-bad'}>
                  {status.recentFailures.length === 0
                    ? '无'
                    : `${status.recentFailures.length} 条 · ${status.recentFailures[0]?.label ?? ''}`}
                </dd>
              </dl>
              <div className="row-gap">
                <Button variant="danger" disabled={busy !== null} onClick={() => void run({ action: 'stop' })}>
                  停止阅读
                </Button>
                <Button disabled={busy !== null} onClick={() => void run({ action: 'resume' })}>
                  恢复阅读
                </Button>
                <Button disabled={busy !== null} onClick={() => void run({ action: 'retry-service' })}>
                  重启服务
                </Button>
                <Button disabled={busy !== null} onClick={() => void run({ action: 'report-open' })}>
                  查看今日日报
                </Button>
              </div>
            </>
          )}
        </div>
      </section>

      {status === null ? null : (
        <section className="section" aria-labelledby="bili-login">
          <header className="section-head">
            <h2 id="bili-login">扫码登录</h2>
            <div className="section-actions">
              <Pill tone={status.login.state === 'logged-in' ? 'ok' : 'neutral'}>
                {BILI_LOGIN_LABELS[status.login.state]}
              </Pill>
            </div>
          </header>
          <div className="section-body">
            {currentQr !== null && currentQr.imageDataUrl !== null ? (
              <div className="row-gap">
                <img src={currentQr.imageDataUrl} width={180} height={180} alt="B 站登录二维码" />
                <span className="muted small">
                  {currentQr.expiresAt === null
                    ? '请用 B 站手机客户端扫码'
                    : `有效到 ${new Date(currentQr.expiresAt).toLocaleTimeString()}`}
                </span>
              </div>
            ) : null}
            <div className="row-gap">
              <Button
                disabled={busy !== null || !enabled}
                onClick={() => void run({ action: 'login-start' })}
              >
                {status.login.state === 'logged-in' ? '重新扫码' : '扫码登录'}
              </Button>
              <Button
                disabled={busy !== null || currentQr === null}
                onClick={() => {
                  setQr(null)
                  void run({ action: 'login-cancel' })
                }}
              >
                取消扫码
              </Button>
              <Button
                variant="danger"
                disabled={busy !== null || status.login.state === 'unlogged'}
                onClick={() => {
                  setQr(null)
                  void run({ action: 'logout' })
                }}
              >
                退出登录
              </Button>
            </div>
          </div>
        </section>
      )}

      {status === null ? null : (
        <section className="section" aria-labelledby="bili-install">
          <header className="section-head">
            <h2 id="bili-install">依赖</h2>
            {installing ? <Pill tone="warn">正在安装</Pill> : null}
          </header>
          <div className="section-body">
            <ul className="undo-list">
              {(
                [
                  ['python', status.environment.python],
                  ['service', status.environment.service],
                  ['asr', status.environment.asr],
                  ['model', status.environment.model]
                ] as const
              ).map(([kind, view]) => (
                <li key={kind}>
                  <Pill
                    tone={
                      view.state === 'ready' ? 'ok' : view.state === 'installing' ? 'warn' : 'neutral'
                    }
                  >
                    {INSTALL_STATE_LABELS[view.state]}
                  </Pill>
                  <span className="grow">{INSTALL_LABELS[kind]}</span>
                  <span className="muted small">
                    {view.version === null ? '' : `v${view.version}`}
                    {view.progress === null ? '' : ` ${Math.round(view.progress * 100)}%`}
                  </span>
                  <Button
                    disabled={
                      busy !== null ||
                      installing ||
                      !enabled ||
                      (kind === 'python' && view.state === 'ready')
                    }
                    onClick={() => void run({ action: 'install', kind })}
                  >
                    {kind === 'python' && view.state === 'ready'
                      ? '使用现有 Python'
                      : view.state === 'ready'
                        ? '检查/更新'
                        : '安装'}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="section" aria-labelledby="bili-reading">
        <header className="section-head">
          <h2 id="bili-reading">阅读偏好</h2>
        </header>
        <div className="section-body">
          <div className="grid-2">
            <Field label="关注词" hint="每行一个；软偏好，不绕过排除词。">
              <textarea
                className="input textarea"
                rows={3}
                value={bili.keywords.join('\n')}
                disabled={!enabled}
                onChange={(event) =>
                  s.update(['worlds', 'bilibili', 'keywords'], splitLines(event.target.value))
                }
              />
            </Field>
            <Field label="排除词" hint="每行一个；命中后不进入精读。">
              <textarea
                className="input textarea"
                rows={3}
                value={bili.excludeKeywords.join('\n')}
                disabled={!enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'bilibili', 'excludeKeywords'],
                    splitLines(event.target.value)
                  )
                }
              />
            </Field>
          </div>
          <Toggle
            label="需要时抽取故事板画面"
            checked={bili.vision.enabled}
            disabled={!enabled}
            onChange={(checked) =>
              s.update(['worlds', 'bilibili', 'vision', 'enabled'], checked)
            }
          />
          <Toggle
            label="无字幕时允许本地语音转写"
            checked={bili.asr.enabled}
            disabled={!enabled}
            onChange={(checked) => s.update(['worlds', 'bilibili', 'asr', 'enabled'], checked)}
          />
          <Toggle
            label="每轮探索后更新当天日报"
            checked={bili.report.enabled}
            disabled={!enabled}
            onChange={(checked) => s.update(['worlds', 'bilibili', 'report', 'enabled'], checked)}
          />
        </div>
      </section>

      <details id="bilibili-advanced" className="advanced-block page-anchor-block">
        <summary>高级</summary>
        <div className="section-body">
          <div className="grid-2">
            <Field label="单批候选上限">
              <input
                className="input input-num"
                type="number"
                min={5}
                max={20}
                value={bili.maxCandidatesPerBatch}
                disabled={!enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'bilibili', 'maxCandidatesPerBatch'],
                    Math.max(5, Math.min(20, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="单次精读上限">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={10}
                value={bili.maxDetailsPerSession}
                disabled={!enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'bilibili', 'maxDetailsPerSession'],
                    Math.max(1, Math.min(10, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="单次会话时长（分钟）">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={15}
                value={Math.round(bili.sessionMaxMs / 60_000)}
                disabled={!enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'bilibili', 'sessionMaxMs'],
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
                value={bili.sessionMaxToolCalls}
                disabled={!enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'bilibili', 'sessionMaxToolCalls'],
                    Math.max(1, Math.min(60, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="默认抽帧数">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={6}
                value={bili.vision.defaultFrames}
                disabled={!enabled || !bili.vision.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'bilibili', 'vision', 'defaultFrames'],
                    Math.max(1, Math.min(6, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="单次最多帧数">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={6}
                value={bili.vision.maxFrames}
                disabled={!enabled || !bili.vision.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'bilibili', 'vision', 'maxFrames'],
                    Math.max(1, Math.min(6, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="转写模型">
              <select
                className="input"
                value={bili.asr.model}
                disabled={!enabled || !bili.asr.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'bilibili', 'asr', 'model'],
                    event.target.value as BiliAsrModel
                  )
                }
              >
                {ASR_MODELS.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="单条媒体时长上限（分钟）">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={120}
                value={bili.asr.maxMediaMinutes}
                disabled={!enabled || !bili.asr.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'bilibili', 'asr', 'maxMediaMinutes'],
                    Math.max(1, Math.min(120, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="下载体积上限（MB）">
              <input
                className="input input-num"
                type="number"
                min={50}
                max={1000}
                value={bili.asr.maxDownloadMb}
                disabled={!enabled || !bili.asr.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'bilibili', 'asr', 'maxDownloadMb'],
                    Math.max(50, Math.min(1000, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="单次运行上限（分钟）">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={120}
                value={bili.asr.maxRunMinutes}
                disabled={!enabled || !bili.asr.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'bilibili', 'asr', 'maxRunMinutes'],
                    Math.max(1, Math.min(120, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="缓存上限（MB）">
              <input
                className="input input-num"
                type="number"
                min={256}
                max={4096}
                value={bili.asr.maxCacheMb}
                disabled={!enabled || !bili.asr.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'bilibili', 'asr', 'maxCacheMb'],
                    Math.max(256, Math.min(4096, Number(event.target.value)))
                  )
                }
              />
            </Field>
            <Field label="日报保留（天）">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={90}
                value={bili.report.retentionDays}
                disabled={!enabled || !bili.report.enabled}
                onChange={(event) =>
                  s.update(
                    ['worlds', 'bilibili', 'report', 'retentionDays'],
                    Math.max(1, Math.min(90, Number(event.target.value)))
                  )
                }
              />
            </Field>
          </div>
        </div>
      </details>
    </div>
  )
}
