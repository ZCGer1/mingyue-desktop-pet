import { contextBridge, ipcRenderer } from 'electron'
import type { BiliSessionReportView, PetBiliReportEvent } from '../shared/bilibili'
import {
  IPC,
  type ActivityRawSampleView,
  type ActivityStatsView,
  type AppBridge,
  type ApprovalGrantView,
  type BiliActionView,
  type BiliSettingsAction,
  type BrowserBridgeStatusView,
  type BrowserExtensionOpenResultView,
  type CapabilityGrantView,
  type CapabilitySnapshotView,
  type ChatActionResult,
  type ChatApprovalClearedEvent,
  type ChatApprovalEvent,
  type ChatBootstrap,
  type ChatSendResult,
  type CompanionActionResultView,
  type CompanionActionView,
  type CompanionSnapshotView,
  type ChatBridge,
  type ChatOpenEvent,
  type ChatTapEvent,
  type ChatTerminalEvent,
  type ChatUserMessageEvent,
  type ChatWebEvent,
  type DiagnosticsExportResultView,
  type DiagnosticsView,
  type DiscoveryBridge,
  type DiscoverySettingsView,
  type FileScopeView,
  type KeyActionResult,
  type KeyVerifyResult,
  type LocalDataClearResultView,
  type MemoryFileName,
  type MemorySnapshotView,
  type MemoryWriteResultView,
  type MingyueBridge,
  type ModelListResult,
  type PetAgentStatusView,
  type PetAnimationEvent,
  type PetAnimationReceipt,
  type PetBootstrap,
  type PetBridge,
  type PetChatUiEvent,
  type PetCommand,
  type PetCuaActionEvent,
  type PetDisplaysEvent,
  type PetInteractionKind,
  type PetOpenQuickEvent,
  type PetPointerSample,
  type PerchGeometryView,
  type PetPowerEvent,
  type PetQuietEvent,
  type PetSavedPositionView,
  type PetSayEvent,
  type PetSayReceipt,
  type PetSettingsEvent,
  type PetMovementEvent,
  type PetMovementReceipt,
  type PetActivityEvent,
  type QuickChatEvent,
  type QuickChatSnapshot,
  type QuickBridge,
  type QuickSendResult,
  type RevokeExplorationResult,
  type RunningAppView,
  type SaveConfigResult,
  type CuaStatusView,
  type SettingsBootstrap,
  type SettingsBridge,
  type SystemAppCandidateView,
  type SystemRecentActionView,
  type TaskActionView,
  type TaskView,
  type UiPhaseSnapshot,
  type UndoEntryView,
  type UndoResultView,
  type VisionObserveResultView,
  type VisionSceneEventView,
  type VisionSceneView,
  type VisionStatusView,
  type VolumeScopeView,
  type WorkspaceChoiceResult,
  type WorldHealthView
} from '../shared/ipc'
import type { AppConfig } from '../shared/config'
import type { ScreenCompanionTestResultView } from '../shared/screenCompanion'
import type { DiscoveryFeedbackKind } from '../shared/discovery'

/**
 * Renderer 只能看到这个白名单（PLAN.md §6）。
 * 不暴露 ipcRenderer / fs / shell / process；每条参数在主进程还会再次校验。
 */

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

/** 订阅一个主进程事件；返回的函数通过 contextBridge 代理给 renderer 清理。 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const app: AppBridge = {
  openChat: () => invoke<void>(IPC.appOpenChat),
  openSettings: () => invoke<void>(IPC.appOpenSettings),
  openDiagnostics: () => invoke<void>(IPC.appOpenDiagnostics),
  quit: () => invoke<void>(IPC.appQuit),
  setAutoLaunch: (enabled) => invoke<boolean>(IPC.appSetAutoLaunch, enabled)
}

const chat: ChatBridge = {
  bootstrap: () => invoke<ChatBootstrap>(IPC.appBootstrap),
  send: (text) => invoke<ChatSendResult>(IPC.chatSend, text),
  stop: () => invoke<void>(IPC.chatStop),
  refresh: () => invoke<ChatBootstrap>(IPC.chatRefresh),
  resolveApproval: (id, approved, scope = 'once') =>
    invoke<ChatActionResult>(IPC.chatResolveApproval, id, approved, scope),
  undo: (count = 1) => invoke<UndoResultView>(IPC.chatUndo, count),
  markCleared: () => invoke<void>(IPC.chatMarkCleared),
  openBiliVideo: (bvid, partIndex) =>
    invoke<ChatActionResult>(IPC.chatOpenBiliVideo, bvid, partIndex),
  setPaused: (paused) => invoke<void>(IPC.chatSetPaused, paused),
  hideWindow: () => ipcRenderer.send(IPC.chatHideWindow),
  openSettings: () => invoke<void>(IPC.appOpenSettings),
  openDiagnostics: () => invoke<void>(IPC.appOpenDiagnostics),
  quit: () => invoke<void>(IPC.appQuit),
  taskList: () => invoke<TaskView[]>(IPC.chatTask),
  cancelTask: (id) => invoke<ChatActionResult>(IPC.chatTaskCancel, id),
  onTap: (cb) => subscribe<ChatTapEvent>(IPC.chatTap, cb),
  onUserMessage: (cb) => subscribe<ChatUserMessageEvent>(IPC.chatUserMessage, cb),
  onApproval: (cb) => subscribe<ChatApprovalEvent>(IPC.chatApproval, cb),
  onApprovalCleared: (cb) => subscribe<ChatApprovalClearedEvent>(IPC.chatApprovalCleared, cb),
  onPhase: (cb) => subscribe<UiPhaseSnapshot>(IPC.chatPhase, cb),
  onStatus: (cb) => subscribe<UiPhaseSnapshot>(IPC.chatStatus, cb),
  onTerminal: (cb) => subscribe<ChatTerminalEvent>(IPC.chatTerminal, cb),
  onWeb: (cb) => subscribe<ChatWebEvent>(IPC.chatWeb, cb),
  onOpen: (cb) => subscribe<ChatOpenEvent>(IPC.chatOpen, cb),
  onCleared: (cb) => subscribe<void>(IPC.chatCleared, cb),
  onBiliReport: (cb) => subscribe<BiliSessionReportView>(IPC.chatBiliReport, cb)
}

const pet: PetBridge = {
  bootstrap: () => invoke<PetBootstrap>(IPC.petBootstrap),
  setInteractive: (interactive) => ipcRenderer.send(IPC.petSetInteractive, interactive),
  setPanelOpen: (open) => ipcRenderer.send(IPC.petSetPanelOpen, open),
  openChat: () => ipcRenderer.send(IPC.petOpenChat),
  openSettings: () => ipcRenderer.send(IPC.petOpenSettings),
  openBiliVideo: (bvid, partIndex) =>
    invoke<ChatActionResult>(IPC.petOpenBiliVideo, bvid, partIndex),
  openDiagnostics: () => invoke<void>(IPC.appOpenDiagnostics),
  resetPosition: () => ipcRenderer.send(IPC.petResetPosition),
  savePosition: (position: PetSavedPositionView) =>
    invoke<boolean>(IPC.petSavePosition, position),
  reportAnimation: (receipt: PetAnimationReceipt) =>
    ipcRenderer.send(IPC.petAnimationReceipt, receipt),
  reportMovement: (receipt: PetMovementReceipt) =>
    ipcRenderer.send(IPC.petMovementReceipt, receipt),
  reportSayReceipt: (receipt: PetSayReceipt) =>
    ipcRenderer.send(IPC.petSayReceipt, receipt),
  reportActivity: (kind: PetActivityEvent['kind'], movement) =>
    ipcRenderer.send(IPC.petActivity, kind, movement),
  reportPageState: (state) => ipcRenderer.send(IPC.petPageState, state),
  notifyReady: () => ipcRenderer.send(IPC.petNotifyReady),
  notifyInteraction: (kind: PetInteractionKind) => ipcRenderer.send(IPC.petInteraction, kind),
  stopCua: () => ipcRenderer.send(IPC.petStopCua),
  perchSubscribe: () => ipcRenderer.send(IPC.petPerchSubscribe),
  perchUnsubscribe: () => ipcRenderer.send(IPC.petPerchUnsubscribe),
  perchRefresh: () => ipcRenderer.send(IPC.petPerchRefresh),
  currentTask: () => invoke<TaskView | null>(IPC.petTask),
  onSay: (cb) => subscribe<PetSayEvent>(IPC.petSay, cb),
  onAnimation: (cb) => subscribe<PetAnimationEvent>(IPC.petAnimation, cb),
  onMovement: (cb) => subscribe<PetMovementEvent>(IPC.petMovement, cb),
  onQuiet: (cb) => subscribe<PetQuietEvent>(IPC.petQuiet, cb),
  onAgentStatus: (cb) => subscribe<PetAgentStatusView>(IPC.petAgentStatus, cb),
  onBiliReport: (cb) => subscribe<PetBiliReportEvent>(IPC.petBiliReport, cb),
  onCommand: (cb) => subscribe<PetCommand>(IPC.petCommand, cb),
  onPower: (cb) => subscribe<PetPowerEvent>(IPC.petPower, cb),
  onSettings: (cb) => subscribe<PetSettingsEvent>(IPC.petSettings, cb),
  onDisplays: (cb) => subscribe<PetDisplaysEvent>(IPC.petDisplays, cb),
  onChatUi: (cb) => subscribe<PetChatUiEvent>(IPC.petChatUi, cb),
  onCuaAction: (cb) => subscribe<PetCuaActionEvent>(IPC.petCuaAction, cb),
  onPerchGeometry: (cb) => subscribe<PerchGeometryView>(IPC.petPerchGeometry, cb),
  onPointerSample: (cb) => subscribe<PetPointerSample>(IPC.petPointerSample, cb),
  onOpenQuick: (cb) => subscribe<PetOpenQuickEvent>(IPC.petOpenQuick, cb),
  onTaskChanged: (cb) => subscribe<TaskView[]>(IPC.petTaskChanged, cb)
}

const quick: QuickBridge = {
  bootstrap: () => invoke<QuickChatSnapshot>(IPC.quickBootstrap),
  send: (text, episodeId) => invoke<QuickSendResult>(IPC.quickSend, text, episodeId),
  feedback: (kind, episodeId) =>
    invoke<ChatActionResult>(IPC.petFeedback, kind, episodeId),
  stop: () => invoke<void>(IPC.quickStop),
  end: () => invoke<void>(IPC.quickEnd, 'close'),
  reset: (confirmed) => invoke<void>(IPC.quickReset, confirmed),
  resolveApproval: (id, approved, scope = 'once') =>
    invoke<ChatActionResult>(IPC.quickResolveApproval, id, approved, scope),
  onEvent: (cb) => subscribe<QuickChatEvent>(IPC.quickEvent, cb)
}

const settings: SettingsBridge = {
  bootstrap: () => invoke<SettingsBootstrap>(IPC.settingsBootstrap),
  saveConfig: (config: AppConfig, baseRevision: number) =>
    invoke<SaveConfigResult>(IPC.settingsSaveConfig, config, baseRevision),
  capabilitySnapshot: () =>
    invoke<CapabilitySnapshotView>(IPC.settingsCapabilitySnapshot),
  volumeScope: (refresh = false) =>
    invoke<VolumeScopeView>(IPC.settingsVolumeScope, refresh),
  fileScope: (refresh = false) =>
    invoke<FileScopeView>(IPC.settingsFileScope, refresh),
  revokeExploration: () =>
    invoke<RevokeExplorationResult>(IPC.settingsRevokeExploration),
  setApiKey: (key) => invoke<KeyActionResult>(IPC.settingsSetApiKey, key),
  clearApiKey: () => invoke<KeyActionResult>(IPC.settingsClearApiKey),
  verifyApiKey: (key) => invoke<KeyVerifyResult>(IPC.settingsVerifyApiKey, key ?? null),
  listModels: () => invoke<ModelListResult>(IPC.settingsListModels),
  chooseWorkspace: () => invoke<WorkspaceChoiceResult>(IPC.settingsChooseWorkspace),
  chooseNotesRoot: () => invoke<WorkspaceChoiceResult>(IPC.settingsChooseNotesRoot),
  chooseTrustedRoot: () => invoke<WorkspaceChoiceResult>(IPC.settingsChooseTrustedRoot),
  chooseExplorationRoot: () =>
    invoke<WorkspaceChoiceResult>(IPC.settingsChooseExplorationRoot),
  chooseArtifactRoot: () => invoke<WorkspaceChoiceResult>(IPC.settingsChooseArtifactRoot),
  listApprovalGrants: () => invoke<ApprovalGrantView[]>(IPC.settingsApprovalGrants),
  clearApprovalGrants: () => invoke<void>(IPC.settingsClearApprovalGrants),
  getActivityRaw: () => invoke<ActivityRawSampleView[]>(IPC.settingsActivityRaw),
  clearActivityRaw: () => invoke<void>(IPC.settingsActivityClearRaw),
  getActivityStats: () => invoke<ActivityStatsView>(IPC.settingsActivityStats),
  clearActivityStats: () => invoke<void>(IPC.settingsClearActivityStats),
  getVisionStatus: () => invoke<VisionStatusView | null>(IPC.settingsVisionStatus),
  getVisionScenes: () => invoke<VisionSceneView[]>(IPC.settingsVisionScenes),
  getVisionEvents: () => invoke<VisionSceneEventView[]>(IPC.settingsVisionEvents),
  clearVision: () => invoke<void>(IPC.settingsVisionClear),
  pauseVision: () => invoke<void>(IPC.settingsVisionPause),
  resumeVision: () => invoke<void>(IPC.settingsVisionResume),
  observeVisionNow: () => invoke<VisionObserveResultView>(IPC.settingsVisionObserveNow),
  getCuaStatus: () => invoke<CuaStatusView>(IPC.settingsCuaStatus),
  runningApps: () => invoke<RunningAppView[]>(IPC.settingsRunningApps),
  stopCua: () => invoke<void>(IPC.settingsCuaStop),
  clearCuaGrants: () => invoke<void>(IPC.settingsCuaClearGrants),
  getBrowserStatus: () => invoke<BrowserBridgeStatusView>(IPC.settingsBrowserStatus),
  getDiscovery: () => invoke<DiscoverySettingsView>(IPC.settingsDiscovery),
  biliAction: (action: BiliSettingsAction) =>
    invoke<BiliActionView>(IPC.settingsBiliAction, action),
  rotateBrowserToken: () => invoke<string | null>(IPC.settingsBrowserRotateToken),
  openBrowserExtensionFolder: () =>
    invoke<BrowserExtensionOpenResultView>(IPC.settingsBrowserOpenExtension),
  getSystemRecent: () => invoke<SystemRecentActionView[]>(IPC.settingsSystemRecent),
  clearSystemRecent: () => invoke<void>(IPC.settingsSystemClearRecent),
  scanSystemApps: () => invoke<SystemAppCandidateView[]>(IPC.settingsSystemScanApps),
  clearLocalData: () => invoke<LocalDataClearResultView>(IPC.settingsClearLocalData),
  setActivityPaused: (paused) => invoke<void>(IPC.settingsActivityPaused, paused),
  setAgentPaused: (paused) => invoke<void>(IPC.settingsAgentPaused, paused),
  setRoam: (enabled) => invoke<void>(IPC.settingsSetRoam, enabled),
  memorySnapshot: () => invoke<MemorySnapshotView>(IPC.settingsMemorySnapshot),
  memoryWrite: (name: MemoryFileName, content: string, mode: 'replace' | 'append') =>
    invoke<MemoryWriteResultView>(IPC.settingsMemoryWrite, name, content, mode),
  memoryForget: (target) => invoke<MemoryWriteResultView>(IPC.settingsMemoryForget, target),
  companionSnapshot: () => invoke<CompanionSnapshotView>(IPC.settingsCompanion),
  companionAction: (target: { action: CompanionActionView; interestId?: string }) =>
    invoke<CompanionActionResultView>(IPC.settingsCompanionAction, target),
  screenCompanionTest: () =>
    invoke<ScreenCompanionTestResultView>(IPC.settingsScreenCompanionTest),
  diagnostics: () => invoke<DiagnosticsView>(IPC.settingsDiagnostics),
  exportDiagnostics: () =>
    invoke<DiagnosticsExportResultView>(IPC.settingsExportDiagnostics),
  worlds: () => invoke<WorldHealthView[]>(IPC.settingsWorlds),
  petCommand: (command: PetCommand) => invoke<void>(IPC.settingsPetCommand, command),
  undoList: () => invoke<UndoEntryView[]>(IPC.settingsUndoList),
  undo: (count = 1) => invoke<UndoResultView>(IPC.settingsUndo, count),
  resetPetSettings: () => invoke<ChatActionResult>(IPC.settingsResetPetSettings),
  tasks: () => invoke<TaskView[]>(IPC.settingsTasks),
  taskAction: (id: string, action: TaskActionView) =>
    invoke<ChatActionResult>(IPC.settingsTaskAction, id, action),
  capabilityGrants: () => invoke<CapabilityGrantView[]>(IPC.settingsCapabilityGrants),
  revokeCapability: (id: string) => invoke<ChatActionResult>(IPC.settingsRevokeCapability, id),
  setAutoLaunch: (enabled) => invoke<boolean>(IPC.appSetAutoLaunch, enabled),
  openChat: () => invoke<void>(IPC.appOpenChat),
  quit: () => invoke<void>(IPC.appQuit),
  onNotice: (cb) => subscribe<string>(IPC.settingsNotice, cb),
  onActivityChanged: (cb) => subscribe<void>(IPC.settingsActivityChanged, cb),
  onTaskChanged: (cb) => subscribe<TaskView[]>(IPC.settingsTaskChanged, cb)
}

const discovery: DiscoveryBridge = {
  open: (id) => invoke<ChatActionResult>(IPC.discoveryAction, { action: 'open', id }),
  feedback: (id, kind: DiscoveryFeedbackKind) =>
    invoke<ChatActionResult>(IPC.discoveryAction, { action: 'feedback', id, kind }),
  remove: (id) => invoke<ChatActionResult>(IPC.discoveryAction, { action: 'delete', id }),
  clear: () => invoke<ChatActionResult>(IPC.discoveryAction, { action: 'clear' })
}

const bridge: MingyueBridge = { app, chat, pet, quick, settings, discovery }

try {
  contextBridge.exposeInMainWorld('mingyue', bridge)
} catch (error) {
  // preload 失败时至少把原因留在控制台，渲染进程会显示不可用提示。
  console.error('[preload] exposeInMainWorld failed', error)
}
