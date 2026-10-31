import type { ToolGroupId } from './toolExposure'

/**
 * World 提示词只在对应工具组可见时注入。组是可见性，不是权限，
 * 但模型不应该读到本轮根本调不到的入口说明。
 */
const WORLD_TOOL_GROUPS: Readonly<Record<string, readonly ToolGroupId[]>> = {
  chat: ['companion'],
  pet: ['companion'],
  activity: ['activity'],
  browser: ['page'],
  browserControl: ['browser', 'autoweb'],
  bilibili: ['bilibili'],
  files: ['files', 'artifacts'],
  apps: ['apps'],
  system: ['apps'],
  workspace: ['workspace'],
  web: ['web'],
  terminal: ['terminal'],
  tasks: ['tasks'],
  cua: ['screen'],
  desktop: ['window']
}

export function worldPromptVisible(id: string, loaded: readonly ToolGroupId[]): boolean {
  const groups = WORLD_TOOL_GROUPS[id]
  if (groups === undefined) return true
  return groups.some((group) => loaded.includes(group))
}
