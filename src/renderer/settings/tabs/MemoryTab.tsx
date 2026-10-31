import { useEffect } from 'react'
import { useSettings } from '../context'
import type { MemoryFileName } from '../../../shared/ipc'
import { Button, Empty, Section, Toggle } from '../ui'

const FILE_LABELS: Record<MemoryFileName, string> = {
  'profile.md': '用户画像',
  'boundaries.md': '边界与禁区',
  'projects.md': '进行中的项目',
  'recent.md': '近期交接',
  'habits.md': '作息习惯'
}

const FILE_ORDER: MemoryFileName[] = [
  'profile.md',
  'boundaries.md',
  'projects.md',
  'recent.md',
  'habits.md'
]

export function MemoryTab(): React.JSX.Element {
  const s = useSettings()
  const memory = s.memory
  const loadMemory = s.loadMemory

  // 配置流程也会挂载本表单；记忆快照尚未读取时补一次加载。
  useEffect(() => {
    if (memory === null) void loadMemory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="stack">
      <Section title="记忆开关">
        <Toggle
          label="启用长期记忆"
          checked={s.config.memory.enabled}
          onChange={(checked) => s.update(['memory', 'enabled'], checked)}
        />
        <Toggle
          label="允许记录作息习惯"
          checked={s.config.memory.habits}
          onChange={(checked) => s.update(['memory', 'habits'], checked)}
        />
        <Toggle
          label="允许自动整理近期记忆"
          checked={s.config.memory.dream}
          onChange={(checked) => s.update(['memory', 'dream'], checked)}
        />
      </Section>

      <Section
        title="她记得什么"
        actions={
          <Button onClick={() => void s.loadMemory(s.memFile)}>重新载入</Button>
        }
      >
        {memory === null ? (
          <Empty>正在读取记忆…</Empty>
        ) : (
          <>
            <div className="status-row">
              <span className="mono dim">{memory.dir}</span>
            </div>
            <div className="memory-layout">
              <div className="memory-files">
                {FILE_ORDER.map((name) => {
                  const entry = memory.entries.find((item) => item.name === name)
                  return (
                    <button
                      type="button"
                      key={name}
                      className={`memory-file ${s.memFile === name ? 'is-active' : ''}`}
                      onClick={() => s.setMemFile(name)}
                    >
                      <span className="memory-name">{FILE_LABELS[name]}</span>
                      <span className="memory-meta">
                        {entry === undefined
                          ? '未创建'
                          : `${formatBytes(entry.bytes)} · ${formatDate(entry.modifiedAt)}`}
                      </span>
                      <code>{name}</code>
                    </button>
                  )
                })}
              </div>
              <div className="memory-editor">
                <textarea
                  className="input textarea memory-text"
                  value={s.memText}
                  spellCheck={false}
                  placeholder="这个文件还没有内容。"
                  onChange={(event) => s.setMemText(event.target.value)}
                />
                <div className="memory-actions">
                  <select
                    className="input"
                    value={s.memMode}
                    onChange={(event) =>
                      s.setMemMode(event.target.value === 'append' ? 'append' : 'replace')
                    }
                  >
                    <option value="replace">替换整个文件</option>
                    <option value="append">追加到末尾</option>
                  </select>
                  <Button variant="primary" onClick={() => void s.saveMemory()}>
                    保存
                  </Button>
                  <Button variant="danger" onClick={() => void s.forgetFile()}>
                    清空该文件
                  </Button>
                </div>
                <div className="row-gap">
                  <input
                    className="input grow"
                    placeholder="从所有记忆里删除包含…的行"
                    value={s.memQuery}
                    maxLength={100}
                    onChange={(event) => s.setMemQuery(event.target.value)}
                  />
                  <Button onClick={() => void s.forgetQuery()}>忘记关键词</Button>
                </div>
              </div>
            </div>
            {memory.enabled ? null : (
              <p className="inline-warn">记忆功能当前已关闭；写入请求会被拒绝。</p>
            )}
          </>
        )}
      </Section>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function formatDate(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString()
  } catch {
    return ''
  }
}
