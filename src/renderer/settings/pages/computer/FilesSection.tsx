import { useEffect, useState } from 'react'
import { effectiveExploration } from '../../../../shared/exploration'
import {
  fileScopeModeLabel,
  fileScopeSourceLabel,
  type FileScopeView
} from '../../../../shared/fileScope'
import type { VolumeAuthorizationSource, VolumeScopeView } from '../../../../shared/volumeScope'
import { useSettings } from '../../context'
import { Button, Empty, Field, FieldRow, Pill, StatusLine, Toggle } from '../../ui'

function authorizationLabel(source: VolumeAuthorizationSource | null): string {
  switch (source) {
    case 'all-volumes':
      return '全部已挂载磁盘只读'
    case 'non-system-volume':
      return '全部非系统盘只读'
    case 'explicit-read-root':
      return '显式读取目录'
    case 'artifact-root':
      return '笔记/作品目录'
    default:
      return '未授权'
  }
}

function volumeStatus(entry: VolumeScopeView['entries'][number]): {
  label: string
  tone: 'info' | 'warn' | 'neutral' | 'ok' | 'bad'
} {
  if (entry.exclusion === 'offline') return { label: '离线 / 介质缺失', tone: 'neutral' }
  if (entry.exclusion === 'no-permission') return { label: '无访问权限', tone: 'warn' }
  if (entry.exclusion === 'no-mount') return { label: '无挂载点', tone: 'neutral' }
  if (entry.exclusion !== null) return { label: '不可用', tone: 'warn' }
  if (!entry.readable) return { label: '待检查', tone: 'neutral' }
  if (entry.partialReadable) return { label: '部分可读', tone: 'warn' }
  if (entry.authorizationSource === null) return { label: '未授权', tone: 'neutral' }
  return { label: '可读', tone: 'ok' }
}

function lineList(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * 文件：磁盘与目录范围、工作区/笔记、额外目录与排除项。
 *
 * 读取、写入、作品目录按用途分开；作品目录只在作品空间子页编辑。
 */
export function FilesSection(): React.JSX.Element {
  const s = useSettings()
  const autonomy = s.config.autonomy
  const exploration = s.config.exploration
  const explorationView = effectiveExploration(s.config)
  const [volumes, setVolumes] = useState<VolumeScopeView | null>(null)
  const [fileScope, setFileScope] = useState<FileScopeView | null>(null)
  const [volumeBusy, setVolumeBusy] = useState(false)

  const loadVolumes = async (refresh = false): Promise<void> => {
    setVolumeBusy(true)
    try {
      const [nextVolumes, nextScope] = await Promise.all([
        window.mingyue.settings.volumeScope(refresh),
        window.mingyue.settings.fileScope(refresh)
      ])
      setVolumes(nextVolumes)
      setFileScope(nextScope)
    } catch {
      setVolumes(null)
      setFileScope(null)
    } finally {
      setVolumeBusy(false)
    }
  }

  useEffect(() => {
    void loadVolumes(false)
  }, [])

  const snapshotGeneratedAt = s.capabilitySnapshot?.generatedAt ?? 0
  useEffect(() => {
    void loadVolumes(false)
  }, [snapshotGeneratedAt])

  const pickWorkspace = async (): Promise<void> => {
    const root = await s.chooseWorkspace()
    if (root !== null) s.update(['worlds', 'workspace', 'root'], root)
  }

  const addReadRoot = async (): Promise<void> => {
    const root = await s.chooseExplorationRoot()
    if (root === null) return
    const lower = root.toLowerCase()
    if (exploration.readRoots.some((item) => item.toLowerCase() === lower)) return
    s.update(['exploration', 'readRoots'], [...exploration.readRoots, root])
  }

  const addTrustedRoot = async (): Promise<void> => {
    const root = await s.chooseTrustedRoot()
    if (root === null) return
    if (autonomy.trustedRoots.includes(root)) return
    s.update(['autonomy', 'trustedRoots'], [...autonomy.trustedRoots, root])
  }

  return (
    <div className="stack section-stack">
      <section className="section" aria-labelledby="files-status">
        <header className="section-head">
          <h2 id="files-status">文件</h2>
          <div className="section-actions">
            <Pill tone={fileScope?.active ? 'info' : 'neutral'}>
              {fileScope === null
                ? '正在读取…'
                : `${fileScopeModeLabel(fileScope.mode)} · v${fileScope.version}`}
            </Pill>
            <Button variant="subtle" onClick={() => void loadVolumes(true)} disabled={volumeBusy}>
              {volumeBusy ? '正在检测…' : '刷新卷清单'}
            </Button>
          </div>
        </header>
        <div className="section-body">
          <StatusLine label="可读根">
            {fileScope === null
              ? '—'
              : `${fileScope.readRoots.length} 个${fileScope.unavailableRoots > 0 ? ` · ${fileScope.unavailableRoots} 个不可访问` : ''}`}
          </StatusLine>
          <StatusLine label="写入">
            {explorationView.edits ? '显式目录可连续编辑' : '原始文件只读'}
            <Button variant="subtle" onClick={() => s.navigate('computer', 'artifacts')}>
              作品目录
            </Button>
          </StatusLine>

          <Toggle
            label="文件读取（目录与磁盘）"
            checked={exploration.fileRead}
            disabled={!exploration.enabled}
            onChange={(checked) => s.update(['exploration', 'fileRead'], checked)}
          />
          <Field label="磁盘范围">
            <select
              className="input"
              value={exploration.volumeScope}
              disabled={!exploration.enabled || !exploration.fileRead}
              onChange={(event) => {
                const value = event.target.value
                s.update(
                  ['exploration', 'volumeScope'],
                  value === 'all' || value === 'non-system' ? value : 'explicit'
                )
              }}
            >
              <option value="all">全部已挂载磁盘</option>
              <option value="non-system">全部非系统磁盘</option>
              <option value="explicit">仅指定目录（不自动纳入卷）</option>
            </select>
          </Field>
          <Toggle
            label="包含个人资料目录"
            checked={exploration.includeProfile}
            disabled={!exploration.enabled || !exploration.fileRead}
            onChange={(checked) => s.update(['exploration', 'includeProfile'], checked)}
          />
          <Toggle
            label="授权目录内的连续编辑"
            checked={exploration.edits}
            disabled={!exploration.enabled}
            onChange={(checked) => s.update(['exploration', 'edits'], checked)}
          />

          <div className="grid-2">
            <FieldRow label="工作区">
              <div className="row-gap">
                <Button onClick={() => void pickWorkspace()}>
                  {s.config.worlds.workspace.root === '' ? '选择工作区' : '更换工作区'}
                </Button>
                {s.config.worlds.workspace.root === '' ? (
                  <span className="muted small">未选择</span>
                ) : (
                  <span className="mono small grow">{s.config.worlds.workspace.root}</span>
                )}
              </div>
            </FieldRow>
            <FieldRow label="她的笔记目录">
              <div className="row-gap">
                {s.config.worlds.workspace.notesRoot === '' ? (
                  <span className="muted small">未选择</span>
                ) : (
                  <span className="mono small grow">{s.config.worlds.workspace.notesRoot}</span>
                )}
                <Button variant="subtle" onClick={() => s.navigate('computer', 'artifacts')}>
                  在作品空间编辑
                </Button>
              </div>
            </FieldRow>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="files-roots">
        <header className="section-head">
          <h2 id="files-roots">目录范围</h2>
          <div className="section-actions">
            <Button onClick={() => void addReadRoot()}>添加只读目录</Button>
          </div>
        </header>
        <div className="section-body">
          {exploration.readRoots.length === 0 ? (
            <Empty>没有额外只读目录。</Empty>
          ) : (
            <ul className="undo-list">
              {exploration.readRoots.map((root, index) => (
                <li key={root}>
                  <Pill tone="info">只读</Pill>
                  <span className="mono dim grow">{root}</span>
                  <Button
                    variant="subtle"
                    onClick={() =>
                      s.update(
                        ['exploration', 'readRoots'],
                        exploration.readRoots.filter((_, itemIndex) => itemIndex !== index)
                      )
                    }
                  >
                    移除
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="grid-2">
            <Field label="文件工具额外目录" hint="每行一个绝对路径；只读。">
              <textarea
                className="input textarea"
                rows={3}
                value={s.config.worlds.files.roots.join('\n')}
                onChange={(event) =>
                  s.update(['worlds', 'files', 'roots'], lineList(event.target.value))
                }
                placeholder={'D:\\Projects\nE:\\资料'}
              />
            </Field>
            <Field label="用户排除项" hint="每行一个路径或通配片段，例如 build-*。">
              <textarea
                className="input textarea"
                rows={3}
                value={s.config.worlds.files.exclude.join('\n')}
                onChange={(event) =>
                  s.update(['worlds', 'files', 'exclude'], lineList(event.target.value))
                }
                placeholder={'D:\\Archive\nbuild-*'}
              />
            </Field>
          </div>
          <div className="row-gap">
            <Button onClick={() => void addTrustedRoot()}>添加信任目录</Button>
          </div>
          {autonomy.trustedRoots.length === 0 ? (
            <Empty>没有额外信任目录。</Empty>
          ) : (
            <ul className="undo-list">
              {autonomy.trustedRoots.map((root, index) => (
                <li key={root}>
                  <Pill tone="warn">信任</Pill>
                  <span className="mono dim grow">{root}</span>
                  <Button
                    variant="subtle"
                    onClick={() =>
                      s.update(
                        ['autonomy', 'trustedRoots'],
                        autonomy.trustedRoots.filter((_, itemIndex) => itemIndex !== index)
                      )
                    }
                  >
                    移除
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <details id="files-advanced" className="advanced-block page-anchor-block">
        <summary>范围详情（只读）</summary>
        <div className="section-body">
          {fileScope === null ? (
            <p className="muted small">暂时读不到统一文件范围。</p>
          ) : (
            <>
              <p className="muted small">
                候选根 {fileScope.roots.length} 个 · 用户排除项 {fileScope.excluded.length} 条 ·
                原始文件编辑根 {fileScope.writeRoots.length} 个
              </p>
              <ul className="undo-list">
                {fileScope.roots.map((root) => (
                  <li key={`${root.path}-${root.sources.join('-')}`}>
                    <Pill tone={!root.available ? 'warn' : root.volume ? 'info' : 'ok'}>
                      {!root.available
                        ? '不可用'
                        : root.volume
                          ? root.systemVolume
                            ? '系统卷 · 可读'
                            : '已挂载卷 · 可读'
                          : '可读'}
                    </Pill>
                    <span className="mono dim grow">{root.path}</span>
                    <span className="muted small">
                      {root.sources.map((kind) => fileScopeSourceLabel(kind)).join('、')}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {volumes === null ? null : volumes.status === 'failed' || volumes.status === 'unsupported' ? (
            <p className="inline-warn">{volumes.error ?? '卷枚举不可用'}</p>
          ) : (
            <ul className="undo-list">
              {volumes.entries.map((entry) => {
                const status = volumeStatus(entry)
                return (
                  <li key={entry.id}>
                    <Pill tone={status.tone}>{status.label}</Pill>
                    <span className="mono dim grow">
                      {entry.mounts.length === 0 ? '（无挂载点）' : entry.mounts.join(' / ')}
                    </span>
                    <span className="muted small">
                      {entry.system ? '系统卷 · ' : ''}
                      {authorizationLabel(entry.authorizationSource)}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </details>
    </div>
  )
}
