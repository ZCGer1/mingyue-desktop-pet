/*
 * 工具暴露基线快照（P0）。
 *
 * 使用真实 Bot 装配（World 启动 + ToolRegistry 注册 + enabled 谓词）生成：
 * - 实际注册表工具数、隐藏旧入口、规范入口数；
 * - 每个配置/入口的请求可见工具名、schema UTF-8 字节数、组目录字节数；
 * - 每个注册工具的原始 schema 与哈希。
 *
 * 输出只含工具名、组名与 schema，不含用户文件、窗口、网页或截图内容。
 * 用法：npx vite-node scripts/snapshot-tool-exposure.ts > baseline.json
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bot } from '../src/bot'
import { quickToolAllowlist } from '../src/core/quickTools'
import {
  ToolExposureController,
  isCanonicalToolName,
  isHiddenLegacyTool,
  toolGroupsFor,
  type ToolGroupId
} from '../src/core/toolExposure'
import { E2EFakeDesktopPort } from '../src/main/desktop/fakePort'
import { mergeConfig, type AppConfig } from '../src/shared/config'
import type {
  CuaCapture,
  CuaCaptureOptions,
  CuaForeground,
  CuaInputOp,
  CuaPort,
  CuaTakeoverKind,
  CuaZoomOptions
} from '../src/worlds/cua/port'

class BaselineCuaPort implements CuaPort {
  private readonly listeners = new Set<(kind: CuaTakeoverKind) => void>()

  async capture(_options: CuaCaptureOptions): Promise<CuaCapture> {
    return {
      base64: '',
      view: {
        displayId: 'baseline',
        imageWidth: 1,
        imageHeight: 1,
        dipX: 0,
        dipY: 0,
        dipWidth: 1,
        dipHeight: 1,
        scaleFactor: 1
      },
      capturedAt: 0
    }
  }

  async zoom(_options: CuaZoomOptions): Promise<CuaCapture | null> {
    return null
  }

  async inspect(): Promise<CuaForeground> {
    return { processName: 'notepad.exe', titleSensitive: false }
  }

  async input(_op: CuaInputOp): Promise<void> {
    /* baseline only */
  }

  async releaseAll(): Promise<void> {
    /* baseline only */
  }

  async stop(): Promise<void> {
    /* baseline only */
  }

  onTakeover(listener: (kind: CuaTakeoverKind) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

interface EntrySpec {
  id: string
  source: 'user-chat' | 'quick-chat' | 'autonomy' | 'task'
  /** 对比基线用；full 返回去重后全部启用规范工具。 */
  mode?: 'groups' | 'full'
  preloadedGroups?: ToolGroupId[]
  allowlist?: string[] | null
  deniedTools?: string[]
}

const ALL_TASK_GROUPS: ToolGroupId[] = [
  'companion',
  'tasks',
  'memory',
  'files',
  'artifacts',
  'workspace',
  'apps',
  'window',
  'screen',
  'web',
  'page',
  'browser',
  'autoweb',
  'bilibili',
  'discovery',
  'terminal'
]

const ENTRIES: EntrySpec[] = [
  { id: 'full-mode', source: 'user-chat', mode: 'full' },
  { id: 'user-chat', source: 'user-chat' },
  // 不显式给 allowlist：按快捷聊天真实白名单（quickToolAllowlist）计算。
  { id: 'quick-chat', source: 'quick-chat' },
  { id: 'autonomy', source: 'autonomy' },
  { id: 'task-base', source: 'task' },
  { id: 'task-all-capabilities', source: 'task', preloadedGroups: ALL_TASK_GROUPS },
  {
    id: 'task-restricted-allowlist',
    source: 'task',
    preloadedGroups: ['window', 'screen'],
    allowlist: [
      'tool_groups',
      'tools_load',
      'computer_observe',
      'computer_act',
      'screen_observe',
      'task_status',
      'task_complete'
    ]
  }
]

interface ConfigVariant {
  id: string
  description: string
  build: (root: string) => AppConfig
  entries?: EntrySpec[]
}

const now = Date.now()

function baseConfig(): AppConfig {
  return mergeConfig({})
}

const VARIANTS: ConfigVariant[] = [
  {
    id: 'default',
    description: '默认配置；未开启自由探索/主动浏览/CUA/B 站，文件与工作区为空。',
    build: () => baseConfig()
  },
  {
    id: 'system-whitelist-only',
    description: '仅系统应用白名单；未开启自由探索。',
    build: () =>
      mergeConfig({
        worlds: {
          system: {
            enabled: true,
            apps: [
              {
                id: 'notepad',
                label: '记事本',
                path: 'C:\\Windows\\notepad.exe',
                args: []
              }
            ]
          }
        }
      })
  },
  {
    id: 'workspace-only',
    description: '仅设置工作区根目录；未开启自由探索与其它 World。',
    build: (root) => {
      const workspace = join(root, 'workspace')
      mkdirSync(workspace, { recursive: true })
      return mergeConfig({ worlds: { workspace: { root: workspace } } })
    }
  },
  {
    id: 'bili-no-extension',
    description: '无浏览器扩展主动控制；B 站独立 API 路线可用。',
    build: () =>
      mergeConfig({
        exploration: {
          enabled: true,
          scope: 'session',
          grantedAt: now,
          sessionExpiresAt: now + 3_600_000,
          web: false,
          browserTabs: false,
          apps: false,
          windows: false,
          fullScreen: false,
          fileRead: false,
          artifacts: false,
          edits: false
        },
        worlds: {
          browserControl: { enabled: false, consentAt: null },
          bilibili: { enabled: true, consentAt: now }
        }
      }),
    entries: [
      { id: 'user-chat', source: 'user-chat' },
      { id: 'user-chat-bili-preload', source: 'user-chat', preloadedGroups: ['bilibili', 'discovery'] },
      { id: 'autonomy', source: 'autonomy' }
    ]
  },
  {
    id: 'all-capabilities',
    description:
      '默认配置上开启自由探索、CUA、普通应用类别、系统白名单、工作区、文件根、主动浏览与 B 站；用于观察上限与单领域对比。',
    build: (root) => {
      const workspace = join(root, 'workspace')
      const artifacts = join(root, 'artifacts')
      mkdirSync(workspace, { recursive: true })
      mkdirSync(artifacts, { recursive: true })
      return mergeConfig({
        exploration: {
          enabled: true,
          scope: 'session',
          grantedAt: now,
          sessionExpiresAt: now + 3_600_000,
          web: true,
          browserTabs: true,
          apps: true,
          windows: true,
          fullScreen: true,
          fileRead: true,
          artifacts: true,
          edits: true,
          readRoots: [root],
          artifactRoot: artifacts
        },
        worlds: {
          cua: { enabled: true, consentAt: now, screenConsentAt: now },
          desktop: {
            apps: [{ process: 'notepad', label: '记事本', observe: true, input: true }],
            structuredText: true,
            windowCapture: true
          },
          system: {
            enabled: true,
            apps: [
              {
                id: 'notepad',
                label: '记事本',
                path: 'C:\\Windows\\notepad.exe',
                args: []
              }
            ]
          },
          workspace: { root: workspace },
          files: { roots: [root] },
          browserControl: { enabled: true, consentAt: now },
          bilibili: { enabled: true, consentAt: now },
          activity: { enabled: true }
        }
      })
    },
    entries: [
      ...ENTRIES,
      {
        id: 'user-chat-bili-preload',
        source: 'user-chat',
        preloadedGroups: ['bilibili', 'discovery']
      },
      {
        id: 'task-workspace',
        source: 'task',
        preloadedGroups: ['companion', 'tasks', 'files', 'artifacts', 'workspace']
      },
      {
        id: 'task-window',
        source: 'task',
        preloadedGroups: ['companion', 'tasks', 'window']
      },
      {
        id: 'task-screen',
        source: 'task',
        preloadedGroups: ['companion', 'tasks', 'screen']
      },
      {
        id: 'task-browser',
        source: 'task',
        preloadedGroups: ['companion', 'tasks', 'browser']
      },
      {
        id: 'task-bili',
        source: 'task',
        preloadedGroups: ['companion', 'tasks', 'bilibili', 'discovery']
      },
      {
        id: 'task-terminal',
        source: 'task',
        preloadedGroups: ['companion', 'tasks', 'terminal']
      },
      {
        id: 'quick-chat-denied',
        source: 'quick-chat',
        deniedTools: ['pet_act', 'computer_act', 'screen_observe', 'browser_snapshot']
      }
    ]
  }
]

interface EntrySnapshot {
  id: string
  source: string
  mode: 'groups' | 'full'
  preloadedGroups: string[]
  allowlist: string[] | null
  deniedTools: string[]
  groups: string[]
  toolCount: number
  schemaBytes: number
  groupCatalogBytes: number
  names: string[]
}

interface RegistryToolSnapshot {
  name: string
  source: string
  groups: string[]
  canonical: boolean
  hidden: boolean
  enabledByConfig: Record<string, boolean>
  schemaBytesRaw: number
  schemaHashRaw: string
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function hash(value: string): string {
  // 不依赖 hash 稳定性做语义判断；仅用于同一基线内比对 schema 漂移。
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

async function snapshotVariant(variant: ConfigVariant): Promise<{
  id: string
  description: string
  registryCount: number
  enabledCount: number
  entries: EntrySnapshot[]
}> {
  const root = mkdtempSync(join(tmpdir(), `mingyue-exposure-${variant.id}-`))
  const config = variant.build(root)
  const bot = new Bot({
    rootDir: root,
    config,
    getApiKey: () => null,
    cuaPort: new BaselineCuaPort(),
    desktopPort: new E2EFakeDesktopPort()
  })
  try {
    await bot.core.start()
    const registry = bot.core.registry
    const enabledNames = registry
      .list()
      .filter((tool) => tool.def.enabled?.() !== false)
      .map((tool) => tool.def.name)
      .filter((name) => !isHiddenLegacyTool(name))
    const entries = (variant.entries ?? ENTRIES).map((entry) => {
      const mode = entry.mode ?? 'groups'
      const deniedTools = entry.deniedTools ?? []
      // 快捷聊天的真实 specs 还受 quickToolAllowlist 与用户 deniedTools 约束；
      // 只按工具组快照会高估实际发送的 schema。
      const effectiveAllowlist =
        entry.allowlist === undefined && entry.source === 'quick-chat'
          ? quickToolAllowlist(config, enabledNames).filter(
              (name) => !deniedTools.includes(name)
            )
          : (entry.allowlist ?? null)
      const controller = new ToolExposureController({ mode, now: () => now })
      controller.beginCycle({
        turnId: null,
        source: entry.source,
        ...(entry.preloadedGroups === undefined
          ? {}
          : { preloadedGroups: entry.preloadedGroups })
      })
      const prepared = controller.prepareRequest({
        registry,
        allowlist: effectiveAllowlist,
        requestId: `baseline-${variant.id}-${entry.id}`,
        turnId: null,
        source: entry.source
      })
      const snapshot = prepared.snapshot
      return {
        id: entry.id,
        source: entry.source,
        mode,
        preloadedGroups: entry.preloadedGroups ?? [],
        allowlist: effectiveAllowlist,
        deniedTools,
        groups: snapshot.groups,
        toolCount: snapshot.names.length,
        schemaBytes: snapshot.schemaBytes,
        groupCatalogBytes: snapshot.groupCatalogBytes,
        names: snapshot.names
      }
    })
    return {
      id: variant.id,
      description: variant.description,
      registryCount: registry.names().length,
      enabledCount: registry.list().filter((tool) => tool.def.enabled?.() !== false).length,
      entries
    }
  } finally {
    await bot.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const first = await snapshotVariant(VARIANTS[0]!)
  const firstRoot = mkdtempSync(join(tmpdir(), 'mingyue-exposure-registry-'))
  const firstConfig = VARIANTS[0]!.build(firstRoot)
  const registryBot = new Bot({
    rootDir: firstRoot,
    config: firstConfig,
    getApiKey: () => null,
    cuaPort: new BaselineCuaPort(),
    desktopPort: new E2EFakeDesktopPort()
  })
  let registryTools: RegistryToolSnapshot[] = []
  try {
    await registryBot.core.start()
    const enabledByConfig: Record<string, Set<string>> = {}
    const variantRoots: string[] = []
    for (const variant of VARIANTS) {
      const root = mkdtempSync(join(tmpdir(), `mingyue-exposure-enabled-${variant.id}-`))
      variantRoots.push(root)
      const config = variant.build(root)
      registryBot.updateConfig(config)
      enabledByConfig[variant.id] = new Set(
        registryBot.core.registry
          .list()
          .filter((tool) => tool.def.enabled?.() !== false)
          .map((tool) => tool.def.name)
      )
    }
    for (const root of variantRoots) rmSync(root, { recursive: true, force: true })
    registryTools = registryBot.core.registry.list().map((tool) => {
      const spec = tool.spec
      const json = JSON.stringify(spec)
      return {
        name: tool.def.name,
        source: tool.source,
        groups: toolGroupsFor(tool.def.name),
        canonical: isCanonicalToolName(tool.def.name),
        hidden: isHiddenLegacyTool(tool.def.name),
        enabledByConfig: Object.fromEntries(
          VARIANTS.map((variant) => [
            variant.id,
            enabledByConfig[variant.id]!.has(tool.def.name)
          ])
        ),
        schemaBytesRaw: bytes(json),
        schemaHashRaw: hash(json)
      }
    })
  } finally {
    await registryBot.stop()
    rmSync(firstRoot, { recursive: true, force: true })
  }

  const configs = [first]
  for (const variant of VARIANTS.slice(1)) configs.push(await snapshotVariant(variant))
  const report = {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    note:
      '实际运行时快照；只含工具名、组名、schema 字节与哈希，不含用户文件/窗口/网页/截图内容。' +
      'schemaBytes 为实际请求发送的 schema（含 approval/approvalAsk）；schemaBytesRaw 为注册表原始 schema。',
    registry: {
      count: first.registryCount,
      canonicalCount: registryTools.filter((tool) => tool.canonical).length,
      hiddenCount: registryTools.filter((tool) => tool.hidden).length,
      catalogCount: registryTools.filter((tool) => tool.name === 'tool_groups' || tool.name === 'tools_load').length,
      explanation:
        '静态 126（本次改造前工具声明） + 2 个工具目录入口 = 128 个运行时注册名；' +
        '其中 9 个旧入口隐藏、117 个规范入口（含 reaction_respond，仅真实反应轮可见）+ 2 个目录入口。'
    },
    configurations: configs,
    tools: registryTools
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

await main()
