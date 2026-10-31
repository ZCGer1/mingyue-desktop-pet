import { CAPABILITY_ACTIONS, type CapabilityId } from './capabilityTypes'
import {
  CATALOG_TOOL_NAMES,
  HIDDEN_TOOL_REPLACEMENTS,
  TOOL_GROUPS,
  isCanonicalToolName,
  isHiddenLegacyTool,
  toolGroupsFor,
  type ToolGroupId
} from './toolExposure'
import { toolMetaFor } from './toolMeta'
import type { RegisteredTool } from './tools'

/**
 * 工具契约的只读审计视图。
 *
 * 它不是第四套注册表：规范名、schema、分组与运行时 handler 仍分别归
 * ToolDef / ToolRegistry / toolExposure 所有。这里只把现有来源合成一份
 * 可核对的目录，指出“注册了却永远不会可见”“组里写了却没人实现”和
 * “隐藏旧入口仍被当成规范入口”这类映射漂移。
 *
 * 审计默认不要求所有组工具都已注册：某个 World 因配置关闭或启动失败时，
 * 它的工具本来就不会进入注册表。需要校验完整静态目录的测试可以打开
 * `requireAllGroupTools`。
 */

export type ToolContractIssueCode =
  | 'ungrouped-tool'
  | 'hidden-tool-visible'
  | 'catalog-tool-visible'
  | 'missing-group-tool'
  | 'missing-capability-action'
  | 'missing-hidden-canonical'

export interface ToolContractIssue {
  code: ToolContractIssueCode
  tool: string
  detail: string
}

export interface ToolContractEntry {
  name: string
  source: string
  groups: ToolGroupId[]
  hidden: boolean
  catalog: boolean
  capability: CapabilityId | null
  desktop: 'observe' | 'input' | 'launch' | null
  sideEffect: boolean
  verify: boolean
}

export interface ToolContractReport {
  tools: ToolContractEntry[]
  issues: ToolContractIssue[]
}

const CATALOG_NAMES = new Set<string>(CATALOG_TOOL_NAMES)
const STATIC_GROUP_TOOLS = new Set<string>(TOOL_GROUPS.flatMap((group) => group.tools))
const CAPABILITY_ACTION_NAMES = new Set<string>(
  Object.values(CAPABILITY_ACTIONS).flatMap((actions) => [...actions])
)

export function auditToolContracts(
  registered: readonly Pick<RegisteredTool, 'def' | 'source'>[],
  options: { requireAllGroupTools?: boolean } = {}
): ToolContractReport {
  const issues: ToolContractIssue[] = []
  const seen = new Set<string>()
  const tools: ToolContractEntry[] = []

  for (const tool of registered) {
    const name = tool.def.name
    if (seen.has(name)) continue
    seen.add(name)
    const groups = toolGroupsFor(name)
    const hidden = isHiddenLegacyTool(name)
    const catalog = CATALOG_NAMES.has(name)
    const meta = toolMetaFor(name)
    tools.push({
      name,
      source: tool.source,
      groups,
      hidden,
      catalog,
      capability: meta.capability ?? null,
      desktop: meta.desktop ?? null,
      sideEffect: meta.sideEffect,
      verify: meta.verify === true
    })

    if (hidden && groups.length > 0) {
      issues.push({
        code: 'hidden-tool-visible',
        tool: name,
        detail: `隐藏旧入口仍出现在工具组 ${groups.join('/')}，新模型请求不会发送它`
      })
    }
    if (catalog && groups.length > 0) {
      issues.push({
        code: 'catalog-tool-visible',
        tool: name,
        detail: `目录工具不应同时属于业务组 ${groups.join('/')}`
      })
    }
    if (!hidden && !catalog && groups.length === 0) {
      issues.push({
        code: 'ungrouped-tool',
        tool: name,
        detail: '工具已注册但不在任何可见组，也没有隐藏替代提示'
      })
    }
    if (hidden) {
      const canonical = HIDDEN_TOOL_REPLACEMENTS[name]?.canonical ?? null
      if (canonical !== null && !isCanonicalToolName(canonical)) {
        issues.push({
          code: 'missing-hidden-canonical',
          tool: name,
          detail: `隐藏入口指向不存在的规范工具 ${canonical}`
        })
      }
    }
  }

  if (options.requireAllGroupTools === true) {
    for (const name of STATIC_GROUP_TOOLS) {
      if (!seen.has(name)) {
        issues.push({
          code: 'missing-group-tool',
          tool: name,
          detail: '工具组声明了该入口，但本次注册表没有实现'
        })
      }
    }
    for (const name of CAPABILITY_ACTION_NAMES) {
      if (!seen.has(name)) {
        issues.push({
          code: 'missing-capability-action',
          tool: name,
          detail: '能力动作没有对应的已注册工具'
        })
      }
    }
  }

  return { tools, issues }
}

/**
 * 静态目录的稳定文本，供 `npm run docs:tool-contract` 生成开发文档。
 * 只包含工具名、组与本地安全元数据，不包含 schema、示例或用户内容。
 */
export function toolContractCatalogText(): string {
  const lines = [
    '# 工具契约目录',
    '',
    '> 由 `npm run docs:tool-contract` 从 `TOOL_GROUPS` 与 `toolMetaFor` 生成；',
    '> 不要手改文件名、组归属或能力标记。运行边界仍由 ToolExecutor 判定。',
    ''
  ]
  for (const group of TOOL_GROUPS) {
    lines.push(`## ${group.title}（\`${group.id}\`）`, '', group.purpose, '')
    if (group.dependsOn.length > 0) {
      lines.push(`依赖组：${group.dependsOn.map((id) => `\`${id}\``).join('、')}`, '')
    }
    lines.push('| 工具 | 能力 | 副作用 | 可验证 |')
    lines.push('| --- | --- | --- | --- |')
    for (const name of [...new Set(group.tools)].sort()) {
      const meta = toolMetaFor(name)
      lines.push(
        `| \`${name}\` | ${meta.capability === undefined ? '—' : `\`${meta.capability}\``} | ${
          meta.sideEffect ? '是' : '否'
        } | ${meta.verify === true ? '是' : '否'} |`
      )
    }
    lines.push('')
  }
  lines.push('## 隐藏旧入口', '')
  lines.push('| 旧入口 | 规范替代 |')
  lines.push('| --- | --- |')
  for (const name of Object.keys(HIDDEN_TOOL_REPLACEMENTS).sort()) {
    const canonical = HIDDEN_TOOL_REPLACEMENTS[name]?.canonical ?? null
    lines.push(`| \`${name}\` | ${canonical === null ? '无（仅保留历史回执）' : `\`${canonical}\``} |`)
  }
  lines.push('', `目录工具：${CATALOG_TOOL_NAMES.map((name) => `\`${name}\``).join('、')}`, '')
  return lines.join('\n')
}
