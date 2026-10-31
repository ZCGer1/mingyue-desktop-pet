import { useCallback, useEffect, useState } from 'react'
import type {
  ApprovalGrantView,
  CapabilityGrantView,
  CompanionActionView,
  CompanionSnapshotView,
  CuaStatusView,
  DiagnosticsView,
  DiscoverySettingsView,
  SystemRecentActionView,
  TaskActionView,
  TaskView,
  UndoEntryView,
  WorldHealthView
} from '../../../shared/ipc'
import type { NoticeKind, SettingsPageId } from '../context'

type Notify = (text: string, kind?: NoticeKind) => void

export interface SettingsDataState {
  worlds: WorldHealthView[]
  diagnostics: DiagnosticsView | null
  undoEntries: UndoEntryView[]
  approvalGrants: ApprovalGrantView[]
  cuaStatus: CuaStatusView | null
  tasks: TaskView[]
  capabilityGrants: CapabilityGrantView[]
  discovery: DiscoverySettingsView | null
  systemRecent: SystemRecentActionView[]
  companion: CompanionSnapshotView | null
  loadWorlds: () => Promise<void>
  loadDiagnostics: () => Promise<void>
  exportDiagnostics: () => Promise<void>
  loadUndo: () => Promise<void>
  undoNow: (count?: number) => Promise<void>
  loadApprovalGrants: () => Promise<void>
  clearApprovalGrants: () => Promise<void>
  loadCuaStatus: () => Promise<void>
  stopCua: () => Promise<void>
  clearCuaGrants: () => Promise<void>
  loadTasks: () => Promise<void>
  taskAction: (id: string, action: TaskActionView) => Promise<void>
  loadCapabilityGrants: () => Promise<void>
  revokeCapability: (id: string) => Promise<void>
  loadDiscovery: () => Promise<void>
  loadSystemRecent: () => Promise<void>
  clearSystemRecent: () => Promise<void>
  loadCompanion: () => Promise<void>
  companionAction: (action: CompanionActionView, interestId?: string) => Promise<void>
  screenCompanionTest: () => Promise<void>
}

/**
 * 设置页的任务、授权、诊断与电脑操作查询。
 *
 * 状态与动作集中在这里，页面组件仍通过同一个 SettingsContext 使用；
 * 配置草稿保存和权限判断没有搬进来，避免把“查询”与“授权”混成一层。
 */
export function useSettingsData(page: SettingsPageId, notify: Notify): SettingsDataState {
  const [worlds, setWorlds] = useState<WorldHealthView[]>([])
  const [diagnostics, setDiagnostics] = useState<DiagnosticsView | null>(null)
  const [undoEntries, setUndoEntries] = useState<UndoEntryView[]>([])
  const [approvalGrants, setApprovalGrants] = useState<ApprovalGrantView[]>([])
  const [cuaStatus, setCuaStatus] = useState<CuaStatusView | null>(null)
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [capabilityGrants, setCapabilityGrants] = useState<CapabilityGrantView[]>([])
  const [discovery, setDiscovery] = useState<DiscoverySettingsView | null>(null)
  const [systemRecent, setSystemRecent] = useState<SystemRecentActionView[]>([])
  const [companion, setCompanion] = useState<CompanionSnapshotView | null>(null)

  useEffect(
    () =>
      window.mingyue.settings.onTaskChanged((next) => {
        setTasks(next)
      }),
    []
  )

  const loadWorlds = useCallback(async (): Promise<void> => {
    try {
      setWorlds(await window.mingyue.settings.worlds())
    } catch {
      notify('读取 Worlds 状态失败。', 'error')
    }
  }, [notify])

  const loadDiagnostics = useCallback(async (): Promise<void> => {
    try {
      setDiagnostics(await window.mingyue.settings.diagnostics())
    } catch {
      notify('读取诊断信息失败。', 'error')
    }
  }, [notify])

  const exportDiagnostics = useCallback(async (): Promise<void> => {
    try {
      const result = await window.mingyue.settings.exportDiagnostics()
      notify(result.message, result.ok ? 'ok' : 'info')
    } catch {
      notify('导出诊断包失败。', 'error')
    }
  }, [notify])

  const loadUndo = useCallback(async (): Promise<void> => {
    try {
      setUndoEntries(await window.mingyue.settings.undoList())
    } catch {
      notify('读取撤销记录失败。', 'error')
    }
  }, [notify])

  const undoNow = useCallback(
    async (count = 1): Promise<void> => {
      try {
        const result = await window.mingyue.settings.undo(count)
        notify(result.message, result.ok ? 'ok' : 'error')
        await loadUndo()
      } catch {
        notify('撤销失败。', 'error')
      }
    },
    [notify, loadUndo]
  )

  const loadApprovalGrants = useCallback(async (): Promise<void> => {
    try {
      setApprovalGrants(await window.mingyue.settings.listApprovalGrants())
    } catch {
      notify('读取授权记录失败。', 'error')
    }
  }, [notify])

  const clearApprovalGrants = useCallback(async (): Promise<void> => {
    if (!window.confirm('清除全部“本会话”和“始终允许”授权？之后的同类操作会重新询问。')) return
    try {
      await window.mingyue.settings.clearApprovalGrants()
      setApprovalGrants([])
      notify('授权已全部清除。', 'ok')
    } catch {
      notify('清除授权失败。', 'error')
    }
  }, [notify])

  const loadCuaStatus = useCallback(async (): Promise<void> => {
    try {
      setCuaStatus(await window.mingyue.settings.getCuaStatus())
    } catch {
      notify('读取电脑操作状态失败。', 'error')
    }
  }, [notify])

  const stopCua = useCallback(async (): Promise<void> => {
    try {
      await window.mingyue.settings.stopCua()
      notify('已停止电脑操作并释放按键/鼠标。', 'ok')
      await loadCuaStatus()
    } catch {
      notify('停止电脑操作失败。', 'error')
    }
  }, [notify, loadCuaStatus])

  const clearCuaGrants = useCallback(async (): Promise<void> => {
    if (!window.confirm('清除电脑操作的“30 分钟内免问”授权？下次输入会重新询问。')) return
    try {
      await window.mingyue.settings.clearCuaGrants()
      notify('电脑操作授权已清除。', 'ok')
      await loadCuaStatus()
    } catch {
      notify('清除电脑操作授权失败。', 'error')
    }
  }, [notify, loadCuaStatus])

  const loadTasks = useCallback(async (): Promise<void> => {
    try {
      setTasks(await window.mingyue.settings.tasks())
    } catch {
      notify('读取任务列表失败。', 'error')
    }
  }, [notify])

  const loadCapabilityGrants = useCallback(async (): Promise<void> => {
    try {
      setCapabilityGrants(await window.mingyue.settings.capabilityGrants())
    } catch {
      notify('读取任务授权失败。', 'error')
    }
  }, [notify])

  const taskAction = useCallback(
    async (id: string, action: TaskActionView): Promise<void> => {
      try {
        const result = await window.mingyue.settings.taskAction(id, action)
        notify(result.message ?? '任务操作已提交。', result.ok ? 'ok' : 'warn')
        await Promise.all([loadTasks(), loadCapabilityGrants()])
      } catch {
        notify('任务操作失败。', 'error')
      }
    },
    [notify, loadTasks, loadCapabilityGrants]
  )

  const revokeCapability = useCallback(
    async (id: string): Promise<void> => {
      try {
        const result = await window.mingyue.settings.revokeCapability(id)
        notify(result.message ?? '撤销请求已提交。', result.ok ? 'ok' : 'warn')
        await Promise.all([loadTasks(), loadCapabilityGrants()])
      } catch {
        notify('撤销授权失败。', 'error')
      }
    },
    [notify, loadTasks, loadCapabilityGrants]
  )

  const loadDiscovery = useCallback(async (): Promise<void> => {
    try {
      setDiscovery(await window.mingyue.settings.getDiscovery())
    } catch {
      notify('读取发现列表失败。', 'error')
    }
  }, [notify])

  const loadSystemRecent = useCallback(async (): Promise<void> => {
    try {
      setSystemRecent(await window.mingyue.settings.getSystemRecent())
    } catch {
      notify('读取系统操作记录失败。', 'error')
    }
  }, [notify])

  const clearSystemRecent = useCallback(async (): Promise<void> => {
    try {
      await window.mingyue.settings.clearSystemRecent()
      setSystemRecent([])
      notify('系统操作记录已清除。', 'ok')
    } catch {
      notify('清除系统操作记录失败。', 'error')
    }
  }, [notify])

  const loadCompanion = useCallback(async (): Promise<void> => {
    try {
      setCompanion(await window.mingyue.settings.companionSnapshot())
    } catch {
      notify('读取兴趣与经历失败。', 'error')
    }
  }, [notify])

  const companionAction = useCallback(
    async (action: CompanionActionView, interestId?: string): Promise<void> => {
      try {
        const result = await window.mingyue.settings.companionAction({
          action,
          ...(interestId === undefined ? {} : { interestId })
        })
        notify(result.message, result.ok ? 'ok' : 'warn')
        await loadCompanion()
      } catch {
        notify('操作兴趣与经历失败。', 'error')
      }
    },
    [notify, loadCompanion]
  )

  const screenCompanionTest = useCallback(async (): Promise<void> => {
    try {
      const result = await window.mingyue.settings.screenCompanionTest()
      notify(result.message, result.ok ? 'ok' : 'warn')
      await loadCompanion()
    } catch {
      notify('屏幕陪伴测试失败。', 'error')
    }
  }, [notify, loadCompanion])

  useEffect(() => {
    if (page === 'advanced') {
      void loadWorlds()
      void loadDiagnostics()
    }
    if (page === 'overview' || page === 'activity' || page === 'companion') {
      void loadTasks()
      void loadCapabilityGrants()
      void loadCompanion()
    }
    if (page === 'activity') {
      void loadDiscovery()
      void loadSystemRecent()
      void loadUndo()
      void loadApprovalGrants()
    }
  }, [
    page,
    loadWorlds,
    loadDiagnostics,
    loadTasks,
    loadCapabilityGrants,
    loadDiscovery,
    loadSystemRecent,
    loadUndo,
    loadApprovalGrants,
    loadCompanion
  ])

  // 活动页的发现列表每 5 秒刷新一次；离开页面即停止，不再有隐藏轮询。
  useEffect(() => {
    if (page !== 'activity') return
    const timer = window.setInterval(() => {
      void window.mingyue.settings
        .getDiscovery()
        .then(setDiscovery)
        .catch(() => undefined)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [page])

  return {
    worlds,
    diagnostics,
    undoEntries,
    approvalGrants,
    cuaStatus,
    tasks,
    capabilityGrants,
    discovery,
    systemRecent,
    companion,
    loadWorlds,
    loadDiagnostics,
    exportDiagnostics,
    loadUndo,
    undoNow,
    loadApprovalGrants,
    clearApprovalGrants,
    loadCuaStatus,
    stopCua,
    clearCuaGrants,
    loadTasks,
    taskAction,
    loadCapabilityGrants,
    revokeCapability,
    loadDiscovery,
    loadSystemRecent,
    clearSystemRecent,
    loadCompanion,
    companionAction,
    screenCompanionTest
  }
}
