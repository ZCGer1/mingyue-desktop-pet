import { z } from 'zod'
import type { ToolDef, ToolOutcome } from '../../core/types'
import type { MemoryStore } from './memory'

/** Memory 工具（Persona 所有，不走工作区审批）。 */
export function createMemoryTools(store: MemoryStore): ToolDef[] {
  return [
    {
      name: 'mem_read',
      description:
        '读取一个记忆文件。path 只能是 profile.md / boundaries.md / projects.md / recent.md / habits.md。回执包含文件全文。',
      parameters: z.object({
        path: z.string().min(1).max(64).describe('记忆文件名，例如 profile.md')
      }),
      tags: ['memory', 'read'],
      approval: 'auto',
      handler: async (args): Promise<ToolOutcome> => {
        const { path } = args as { path: string }
        const result = store.read(path)
        if (!result.ok) return { text: `[MEMORY_READ_FAILED] ${result.message}`, failed: true }
        return { text: `# ${result.name}\n\n${result.text}` }
      }
    },
    {
      name: 'mem_search',
      description: '在记忆文件中按关键词搜索，返回文件名、行号与匹配行。',
      parameters: z.object({
        query: z.string().min(1).max(100),
        limit: z.number().int().min(1).max(50).optional().describe('最多返回多少行，默认 20')
      }),
      tags: ['memory', 'read'],
      approval: 'auto',
      handler: async (args): Promise<ToolOutcome> => {
        const { query, limit } = args as { query: string; limit?: number }
        if (!store.isEnabled()) return { text: '[MEMORY_DISABLED] 记忆功能已关闭', failed: true }
        const hits = store.search(query, limit ?? 20)
        if (hits.length === 0) return { text: '没有找到匹配的记忆。' }
        return { text: hits.map((hit) => `${hit.name}:${hit.line}: ${hit.text}`).join('\n') }
      }
    },
    {
      name: 'mem_write',
      description:
        '写入一个记忆文件。mode=replace 覆盖，mode=append 追加。单次写入不超过 16KB；禁止保存密钥、token、密码。',
      parameters: z.object({
        path: z.enum(['profile.md', 'boundaries.md', 'projects.md', 'recent.md', 'habits.md']),
        content: z.string().min(1).max(20000),
        mode: z.enum(['replace', 'append']).optional().describe('默认 replace')
      }),
      tags: ['memory', 'write'],
      approval: 'auto',
      handler: async (args): Promise<ToolOutcome> => {
        const { path, content, mode } = args as {
          path: string
          content: string
          mode?: 'replace' | 'append'
        }
        const result = store.write(path, content, mode ?? 'replace')
        return { text: result.message, ...(result.ok ? {} : { failed: true }) }
      }
    },
    {
      name: 'mem_forget',
      description:
        '删除记忆：传 path 清空指定文件；传 query 删除所有包含该关键词的行。两者只填一个。',
      parameters: z.object({
        path: z.string().max(64).optional(),
        query: z.string().max(100).optional()
      }),
      tags: ['memory', 'delete'],
      approval: 'auto',
      handler: async (args): Promise<ToolOutcome> => {
        const { path, query } = args as { path?: string; query?: string }
        if ((path === undefined) === (query === undefined)) {
          return { text: '[MEMORY_FORGET_BAD_ARGS] 需要且只能提供 path 或 query 之一', failed: true }
        }
        const result = store.forget({ ...(path === undefined ? {} : { path }), ...(query === undefined ? {} : { query }) })
        return { text: result.message, ...(result.ok ? {} : { failed: true }) }
      }
    }
  ]
}
