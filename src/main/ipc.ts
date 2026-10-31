import type { IpcContext } from './ipcSupport'
export type { IpcContext } from './ipcSupport'
import { registerPetIpc } from './ipcPet'
import { registerChatIpc } from './ipcChat'
import { registerSettingsCoreIpc } from './ipcSettingsCore'
import { registerSettingsTasksIpc } from './ipcSettingsTasks'
import { registerSettingsActivityIpc } from './ipcSettingsActivity'
import { registerSettingsBrowserIpc, registerSettingsSystemIpc } from './ipcSettingsSystem'
import { registerSettingsBiliIpc } from './ipcSettingsBili'

/** Register domains in the original order; sender/schema checks remain in ipcSupport. */
export function registerIpc(ctx: IpcContext): void {
  registerChatIpc(ctx)
  registerPetIpc(ctx)
  registerSettingsCoreIpc(ctx)
  registerSettingsTasksIpc(ctx)
  registerSettingsActivityIpc(ctx)
  registerSettingsBrowserIpc(ctx)
  registerSettingsBiliIpc(ctx)
  registerSettingsSystemIpc(ctx)
}
