import { z } from 'zod'
import type { ToolDef } from './types'

/**
 * 模型自主选择工具组的两个小入口（PLAN §7.1）。
 *
 * 它们只读写“当前活动回合的可见集合”，不执行任何业务动作、不授予权限、
 * 不启动应用/联网/下载。加载结果从下一轮模型请求生效；当前响应中尚未
 * 暴露的动作会被执行器按旧快照拒绝，不会提前执行。
 */
export function createToolCatalogTools(): ToolDef[] {
  return [
    {
      name: 'tool_groups',
      description:
        '查看可按需加载的工具组目录：组 id、用途、是否已加载、当前可用性。' +
        '只列产品能力，不返回用户文件/窗口/网页内容。需要其他领域能力时先看这里。',
      parameters: z.object({}),
      tags: ['read'],
      approval: 'auto',
      enabled: () => true,
      handler: async (_args, ctx) => {
        const exposure = ctx.toolExposure
        if (exposure === undefined) {
          return {
            text:
              '[TOOL_GROUPS_UNAVAILABLE] 当前执行路径没有工具组状态；' +
              '这是宿主兼容入口，不代表权限缺失。',
            failed: true
          }
        }
        return { text: exposure.catalog() }
      }
    },
    {
      name: 'tools_load',
      description:
        '为当前活动回合加载工具组（参数 groups 为组 id 数组）。只让 schema 在下一轮模型请求可见，' +
        '不执行组内动作、不授予权限、不自动启动应用或联网；当前响应后面的未加载动作不会提前执行。',
      parameters: z.object({
        groups: z.array(z.string().min(1).max(40)).min(1).max(8)
      }),
      tags: ['read'],
      approval: 'auto',
      enabled: () => true,
      handler: async (args, ctx) => {
        const exposure = ctx.toolExposure
        if (exposure === undefined) {
          return {
            text:
              '[TOOLS_LOAD_UNAVAILABLE] 当前执行路径没有工具组状态；' +
              '不能在此处加载 schema。',
            failed: true
          }
        }
        const groups = (args as { groups?: unknown }).groups
        if (!Array.isArray(groups) || groups.length === 0) {
          return { text: '[TOOLS_LOAD_FAILED] groups 必须是非空字符串数组。', failed: true }
        }
        const result = exposure.load(
          groups.filter((group): group is string => typeof group === 'string')
        )
        return {
          text: result.text,
          ...(result.failed === true ? { failed: true } : {})
        }
      }
    }
  ]
}
