import { effectiveExploration } from '../../../../shared/exploration'
import { useSettings } from '../../context'
import { Button, FieldRow, Pill, StatusLine, Toggle } from '../../ui'

/**
 * 作品空间：她自己的作品/下载目录、写入许可与回退关系。
 *
 * 作品目录只在这里编辑；文件子页只显示只读摘要。
 */
export function ArtifactsSection(): React.JSX.Element {
  const s = useSettings()
  const exploration = s.config.exploration
  const workspace = s.config.worlds.workspace
  const view = effectiveExploration(s.config)
  const fallback =
    s.config.worlds.workspace.notesRoot !== ''
      ? '笔记目录'
      : s.config.worlds.workspace.root !== ''
        ? '工作区'
        : null

  return (
    <div className="stack section-stack">
      <section className="section" aria-labelledby="artifacts-status">
        <header className="section-head">
          <h2 id="artifacts-status">作品空间</h2>
          <div className="section-actions">
            <Pill tone={view.artifacts ? 'ok' : 'neutral'}>
              {view.artifacts ? '写入已授权' : '写入未授权'}
            </Pill>
          </div>
        </header>
        <div className="section-body">
          <StatusLine label="作品目录">
            {exploration.artifactRoot === '' ? (
              fallback === null ? (
                '未配置'
              ) : (
                `未指定，回退到${fallback}`
              )
            ) : (
              <span className="mono">{exploration.artifactRoot}</span>
            )}
          </StatusLine>
          <Toggle
            label="她自己的作品 / 下载空间"
            checked={exploration.artifacts}
            disabled={!exploration.enabled}
            onChange={(checked) => s.update(['exploration', 'artifacts'], checked)}
          />
          <Toggle
            label="允许把普通资料下载到作品目录"
            hint={
              s.config.worlds.browserControl.enabled
                ? undefined
                : '需要先在「网页」开启主动浏览'
            }
            checked={s.config.worlds.browserControl.allowDownloads}
            disabled={!s.config.worlds.browserControl.enabled}
            onChange={(checked) =>
              s.update(['worlds', 'browserControl', 'allowDownloads'], checked)
            }
          />
          <FieldRow label="作品与下载目录">
            <div className="row-gap">
              <Button
                onClick={async () => {
                  const root = await s.chooseArtifactRoot()
                  if (root !== null) s.update(['exploration', 'artifactRoot'], root)
                }}
              >
                {exploration.artifactRoot === '' ? '选择作品目录' : '更换作品目录'}
              </Button>
              {exploration.artifactRoot === '' ? null : (
                <Button variant="subtle" onClick={() => s.update(['exploration', 'artifactRoot'], '')}>
                  清空
                </Button>
              )}
            </div>
          </FieldRow>
          <FieldRow label="她的笔记目录">
            <div className="row-gap">
              <Button
                onClick={async () => {
                  const root = await s.chooseNotesRoot()
                  if (root !== null) s.update(['worlds', 'workspace', 'notesRoot'], root)
                }}
              >
                {workspace.notesRoot === '' ? '选择笔记目录' : '更换笔记目录'}
              </Button>
              {workspace.notesRoot === '' ? (
                <span className="muted small">未选择</span>
              ) : (
                <>
                  <span className="mono small grow">{workspace.notesRoot}</span>
                  <Button
                    variant="subtle"
                    onClick={() => s.update(['worlds', 'workspace', 'notesRoot'], '')}
                  >
                    清空
                  </Button>
                </>
              )}
            </div>
          </FieldRow>
          {exploration.artifacts && !view.artifacts ? (
            <p className="inline-warn">作品范围已勾选，但没有可用的作品目录，暂不生效。</p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
