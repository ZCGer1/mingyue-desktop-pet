import { useState } from 'react'
import type { SystemAppEntry } from '../../../../shared/config'
import type { SystemAppCandidateView } from '../../../../shared/ipc'
import { useSettings } from '../../context'
import { Button, Empty, Field, Pill, Toggle } from '../../ui'

function slugify(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base === '' ? 'app' : base
}

function uniqueId(base: string, apps: SystemAppEntry[]): string {
  const used = new Set(apps.map((app) => app.id))
  if (!used.has(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const next = `${base}-${index}`
    if (!used.has(next)) return next
  }
  return `${base}-${Date.now()}`
}

function splitLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * 应用：普通应用的发现/启动/切换授权、系统应用白名单与系统动作。
 *
 * 逐应用的观察与输入权限在「屏幕」子页编辑；这里只负责启动列表。
 */
export function AppsSection(): React.JSX.Element {
  const s = useSettings()
  const system = s.config.worlds.system
  const exploration = s.config.exploration
  const [candidates, setCandidates] = useState<SystemAppCandidateView[]>([])
  const [scanning, setScanning] = useState(false)
  const [customLabel, setCustomLabel] = useState('')
  const [customPath, setCustomPath] = useState('')
  const [customArgs, setCustomArgs] = useState('')

  const setApps = (apps: SystemAppEntry[]): void => {
    s.update(['worlds', 'system', 'apps'], apps)
  }

  const updateApp = (id: string, patch: Partial<SystemAppEntry>): void => {
    setApps(system.apps.map((app) => (app.id === id ? { ...app, ...patch } : app)))
  }

  const addCandidate = (candidate: SystemAppCandidateView): void => {
    if (system.apps.some((app) => app.path.toLowerCase() === candidate.path.toLowerCase())) {
      s.notify('这个应用已经在白名单里了。', 'info')
      return
    }
    setApps([
      ...system.apps,
      {
        id: uniqueId(slugify(candidate.label), system.apps),
        label: candidate.label,
        path: candidate.path,
        args: [...candidate.args]
      }
    ])
  }

  const addCustom = (): void => {
    const label = customLabel.trim()
    const path = customPath.trim()
    if (label === '' || path === '') {
      s.notify('自定义应用需要名称和可执行文件路径。', 'warn')
      return
    }
    const args = customArgs
      .split(/\s+/)
      .map((value) => value.trim())
      .filter((value) => value !== '')
    setApps([
      ...system.apps,
      { id: uniqueId(slugify(label), system.apps), label: label.slice(0, 80), path, args }
    ])
    setCustomLabel('')
    setCustomPath('')
    setCustomArgs('')
  }

  const scan = async (): Promise<void> => {
    setScanning(true)
    try {
      setCandidates(await window.mingyue.settings.scanSystemApps())
    } catch {
      s.notify('扫描开始菜单失败。', 'error')
    } finally {
      setScanning(false)
    }
  }

  const toggleEnabled = (checked: boolean): void => {
    if (checked) {
      const agreed = window.confirm(
        [
          '开启应用与系统操作能力？',
          '',
          'sys_* 工具可以（红区仍会强制询问；黄区由模型按当前审批模式判断）：',
          '· 启动你在白名单里添加的应用，只按 appId 选择，不能传路径或命令；',
          '· 用系统默认程序打开文件/文件夹，禁止可执行文件、脚本、系统目录与 AppData；',
          '· 在默认浏览器打开 http/https 链接；',
          '· 调音量、控制媒体播放与锁屏。',
          '',
          '本能力仍然不能：模拟鼠标键盘、聚焦/切换/移动窗口、关机/重启/结束进程、执行任意命令。',
          '键鼠与屏幕能力在「屏幕」子页，需要两次明确同意；即使开启，终端/UAC/锁屏/密码管理器也永远禁止。'
        ].join('\n')
      )
      if (!agreed) return
    }
    s.update(['worlds', 'system', 'enabled'], checked)
  }

  return (
    <div className="stack section-stack">
      <section className="section" aria-labelledby="apps-status">
        <header className="section-head">
          <h2 id="apps-status">应用</h2>
          <div className="section-actions">
            <Pill tone={system.enabled ? 'ok' : 'neutral'}>
              {system.enabled ? '已启用' : '已关闭'}
            </Pill>
            <Pill tone={exploration.apps ? 'info' : 'neutral'}>
              {exploration.apps ? '普通应用已授权' : '普通应用未授权'}
            </Pill>
            <Pill tone="neutral">白名单 {system.apps.length} 个</Pill>
          </div>
        </header>
        <div className="section-body">
          <Toggle label="启用应用与系统操作" checked={system.enabled} onChange={toggleEnabled} />
          <Toggle
            label="允许普通应用：发现、启动、切换窗口"
            checked={exploration.apps}
            disabled={!exploration.enabled}
            onChange={(checked) => s.update(['exploration', 'apps'], checked)}
          />
          <Toggle
            label="允许打开文件/文件夹"
            checked={system.allowPaths}
            disabled={!system.enabled}
            onChange={(checked) => s.update(['worlds', 'system', 'allowPaths'], checked)}
          />
          <Toggle
            label="允许打开 http/https 链接"
            checked={system.allowUrls}
            disabled={!system.enabled}
            onChange={(checked) => s.update(['worlds', 'system', 'allowUrls'], checked)}
          />
        </div>
      </section>

      <section className="section" aria-labelledby="apps-whitelist">
        <header className="section-head">
          <h2 id="apps-whitelist">应用白名单</h2>
          <div className="section-actions">
            <Button onClick={() => void scan()} disabled={!system.enabled || scanning}>
              {scanning ? '扫描中…' : '扫描开始菜单'}
            </Button>
          </div>
        </header>
        <div className="section-body">
          {system.apps.length === 0 ? (
            <Empty>白名单为空。</Empty>
          ) : (
            <div className="raw-table-wrap">
              <table className="raw-table">
                <thead>
                  <tr>
                    <th>显示名</th>
                    <th>appId</th>
                    <th>可执行文件</th>
                    <th>参数</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {system.apps.map((app) => (
                    <tr key={app.id}>
                      <td>
                        <input
                          className="input"
                          aria-label={`显示名 ${app.id}`}
                          value={app.label}
                          maxLength={80}
                          onChange={(event) => updateApp(app.id, { label: event.target.value })}
                        />
                      </td>
                      <td className="mono">{app.id}</td>
                      <td className="mono small">{app.path}</td>
                      <td>
                        <input
                          className="input"
                          aria-label={`启动参数 ${app.id}`}
                          value={app.args.join(' ')}
                          placeholder="无参数"
                          onChange={(event) =>
                            updateApp(app.id, { args: splitSpaces(event.target.value) })
                          }
                        />
                      </td>
                      <td>
                        <Button
                          variant="danger"
                          onClick={() =>
                            setApps(system.apps.filter((entry) => entry.id !== app.id))
                          }
                        >
                          移除
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {candidates.length > 0 && (
            <details className="advanced" open>
              <summary>开始菜单候选</summary>
              <ul className="peek-list">
                {candidates.map((candidate) => {
                  const added = system.apps.some(
                    (app) => app.path.toLowerCase() === candidate.path.toLowerCase()
                  )
                  return (
                    <li key={candidate.path}>
                      <span>
                        {candidate.label}
                        <span className="muted small mono"> {candidate.path}</span>
                      </span>
                      <Button
                        disabled={added || !system.enabled}
                        onClick={() => addCandidate(candidate)}
                      >
                        {added ? '已在白名单' : '加入'}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </details>
          )}

          <div className="grid-2">
            <Field label="自定义应用名称">
              <input
                className="input"
                value={customLabel}
                maxLength={80}
                onChange={(event) => setCustomLabel(event.target.value)}
                placeholder="例如：OBS Studio"
              />
            </Field>
            <Field label="可执行文件路径">
              <input
                className="input"
                value={customPath}
                onChange={(event) => setCustomPath(event.target.value)}
                placeholder={'C:\\Program Files\\...\\app.exe'}
              />
            </Field>
          </div>
          <Field label="启动参数">
            <input
              className="input"
              value={customArgs}
              onChange={(event) => setCustomArgs(event.target.value)}
            />
          </Field>
          <Button onClick={addCustom} disabled={!system.enabled}>
            添加自定义应用
          </Button>
        </div>
      </section>

      <section className="section" aria-labelledby="apps-system-actions">
        <header className="section-head">
          <h2 id="apps-system-actions">系统动作</h2>
        </header>
        <div className="section-body">
          <p className="muted small">固定七种：调高/调低音量、切换静音、播放/暂停、上一首、下一首与锁屏。没有关机、重启、结束进程或任意命令。</p>
        </div>
      </section>

      <details id="apps-advanced" className="advanced-block page-anchor-block">
        <summary>高级</summary>
        <div className="section-body">
          <Toggle
            label="新安装的普通应用继承类别授权"
            checked={exploration.includeNewApps}
            onChange={(checked) => s.update(['exploration', 'includeNewApps'], checked)}
          />
          <Field label="排除的应用" hint="每行一个进程名或显示名；不会被启动、聚焦或操作。">
            <textarea
              className="input textarea"
              rows={3}
              value={exploration.excludedApps.join('\n')}
              onChange={(event) =>
                s.update(['exploration', 'excludedApps'], splitLines(event.target.value))
              }
            />
          </Field>
        </div>
      </details>
    </div>
  )
}

function splitSpaces(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value !== '')
}
