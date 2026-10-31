import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryFileName, MemorySnapshotView } from '../../../shared/ipc'
import type { NoticeKind } from '../context'

type Notify = (text: string, kind?: NoticeKind) => void

export interface MemoryEditorState {
  memory: MemorySnapshotView | null
  memFile: MemoryFileName
  memText: string
  memMode: 'replace' | 'append'
  memQuery: string
  setMemFile: (file: MemoryFileName) => void
  setMemText: (text: string) => void
  setMemMode: (mode: 'replace' | 'append') => void
  setMemQuery: (query: string) => void
  loadMemory: (file?: MemoryFileName) => Promise<void>
  saveMemory: () => Promise<void>
  forgetFile: () => Promise<void>
  forgetQuery: () => Promise<void>
}

/**
 * 记忆页的读取与编辑草稿。只在页面激活时载入一次，后台刷新不会覆盖
 * 正在编辑的文本；保存/遗忘仍走设置页原有的 IPC 与确认语义。
 */
export function useMemoryEditor(active: boolean, notify: Notify): MemoryEditorState {
  const [memory, setMemory] = useState<MemorySnapshotView | null>(null)
  const [memFile, setMemFileState] = useState<MemoryFileName>('profile.md')
  const [memText, setMemText] = useState('')
  const [memMode, setMemMode] = useState<'replace' | 'append'>('replace')
  const [memQuery, setMemQuery] = useState('')
  const memFileRef = useRef<MemoryFileName>('profile.md')
  const memoryRef = useRef<MemorySnapshotView | null>(null)

  useEffect(() => {
    memoryRef.current = memory
  }, [memory])

  const loadMemory = useCallback(
    async (file?: MemoryFileName): Promise<void> => {
      try {
        const snapshot = await window.mingyue.settings.memorySnapshot()
        setMemory(snapshot)
        const target = file ?? memFileRef.current
        memFileRef.current = target
        setMemFileState(target)
        const entry = snapshot.contents.find((item) => item.name === target)
        setMemText(entry?.text ?? '')
      } catch {
        notify('读取记忆失败。', 'error')
      }
    },
    [notify]
  )

  useEffect(() => {
    if (!active) return
    void loadMemory()
    // 只在进入页面时载入；编辑中的内容不会被后台刷新覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const setMemFile = useCallback((file: MemoryFileName): void => {
    memFileRef.current = file
    setMemFileState(file)
    const entry = memoryRef.current?.contents.find((item) => item.name === file)
    setMemText(entry?.text ?? '')
  }, [])

  const saveMemory = useCallback(async (): Promise<void> => {
    try {
      const result = await window.mingyue.settings.memoryWrite(
        memFileRef.current,
        memText,
        memMode
      )
      notify(result.message, result.ok ? 'ok' : 'error')
      if (result.ok) await loadMemory(memFileRef.current)
    } catch {
      notify('写入记忆失败。', 'error')
    }
  }, [memText, memMode, notify, loadMemory])

  const forgetFile = useCallback(async (): Promise<void> => {
    if (!window.confirm(`清空 ${memFileRef.current} 并恢复默认内容？`)) return
    try {
      const result = await window.mingyue.settings.memoryForget({ path: memFileRef.current })
      notify(result.message, result.ok ? 'ok' : 'error')
      if (result.ok) await loadMemory(memFileRef.current)
    } catch {
      notify('清空记忆失败。', 'error')
    }
  }, [notify, loadMemory])

  const forgetQuery = useCallback(async (): Promise<void> => {
    const query = memQuery.trim()
    if (query === '') {
      notify('输入要忘掉的关键词。', 'warn')
      return
    }
    if (!window.confirm('从所有记忆文件中删除包含该关键词的行？')) return
    try {
      const result = await window.mingyue.settings.memoryForget({ query })
      notify(result.message, result.ok ? 'ok' : 'error')
      if (result.ok) {
        setMemQuery('')
        await loadMemory(memFileRef.current)
      }
    } catch {
      notify('删除记忆失败。', 'error')
    }
  }, [memQuery, notify, loadMemory])

  return {
    memory,
    memFile,
    memText,
    memMode,
    memQuery,
    setMemFile,
    setMemText,
    setMemMode,
    setMemQuery,
    loadMemory,
    saveMemory,
    forgetFile,
    forgetQuery
  }
}
