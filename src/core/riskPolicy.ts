import { existsSync, realpathSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { AppConfig } from '../shared/config'
import { effectiveExploration, type EffectiveExploration } from '../shared/exploration'
import { normalizeProcessKey } from '../shared/processName'
import type { ApprovalRisk } from './types'
import {
  isGitInternal,
  isPathInside,
  isSensitivePath,
  isUncPath,
  normalizedForCompare
} from '../worlds/workspace/guard'
import { isBlockedAddress, isBlockedHostname } from '../worlds/web/ssrf'

/**
 * 工具风险分级（PLAN.md Phase 3 / §1.6）。
 *
 * 这是「底线」而不是提示词建议：绿区可自动，黄区允许模型自判断或会话授权，
 * 红区永远需要人工确认。所有路径都按当前配置重新解析；相对路径以工作区为
 * 基准，符号链接/junction 会先 realpath 再判断，因此改名、相对路径或拆分
 * 命令都不能把红区降级。
 */

export type RiskLevel = 'green' | 'yellow' | 'red'

export interface RiskAssessment {
  level: RiskLevel
  /** 面向模型/审批卡的简短原因。 */
  reason: string
  approvalRisk: ApprovalRisk
  /** 是否产生持久副作用；strict 模式下这类绿区操作也要确认。 */
  sideEffect: boolean
  /** 黄区可授权时使用的稳定键；红区不提供。 */
  grantKey?: string
  grantLabel?: string
  /**
   * 覆盖模型/模式的默认决定：
   * - always：每次都问，且不提供任何 grant；
   * - until-grant：没有有效授权时强制问，有授权时按常规自动执行。
   */
  forceAsk?: 'always' | 'until-grant'
  /** 覆盖本次授权的有效期（毫秒）；CUA 用配置的 grantMinutes。 */
  grantTtlMs?: number
  /** grant 键由完整聊天与快捷聊天共享（CUA 输入）；普通工具按入口隔离。 */
  sharedGrant?: boolean
}

export interface RiskPolicyOptions {
  getConfig: () => AppConfig
  /** 应用数据目录永远不属于工作区。 */
  dataDir: string
}

const GREEN_PREFIXES = ['pet_', 'mem_', 'act_', 'alarm_', 'remind_']
const GREEN_TOOLS = new Set([
  'tool_groups',
  'tools_load',
  'files_roots',
  'files_list',
  'files_tree',
  'files_search',
  'files_read',
  'files_info',
  'files_artifact_list',
  'files_artifact_read',
  'web_search',
  'page_current',
  'browser_status',
  'browser_tabs',
  'browser_snapshot',
  'browser_read',
  'browser_find',
  'browser_wait',
  'apps_list',
  'apps_find',
  'apps_wait',
  'win_elements',
  'end_turn',
  'ws_list',
  'ws_read',
  'ws_search'
])

const OPEN_PATH_EXECUTABLE =
  /\.(?:exe|com|bat|cmd|msi|msp|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|scr|lnk|reg|jar|hta|dll|sys|drv|cpl|scf|url)$/i

/** shell 链式/重定向/替换/环境变量展开；命中即红区，不做“猜意图”。 */
const UNSAFE_COMMAND = /[|&;<>`^\r\n]|\$\(|%[A-Za-z_][A-Za-z0-9_]*%/

const MEDIA_ACTIONS = new Set(['volume_up', 'volume_down', 'mute_toggle', 'media_play_pause', 'media_next', 'media_prev'])

/** 与 WorkspaceGuard 一致：notes / notes/... / notes\...（大小写不敏感）。 */
const NOTES_ALIAS = /^notes(?:[\\/]|$)/i

interface ResolvedRoot {
  real: string
  compare: string
}

export class RiskPolicy {
  private readonly getConfig: () => AppConfig
  private readonly dataDir: string

  constructor(opts: RiskPolicyOptions) {
    this.getConfig = opts.getConfig
    this.dataDir = opts.dataDir
  }

  assess(
    toolName: string,
    args: unknown,
    tool?: { tags?: string[]; approval?: 'auto' | 'required' }
  ): RiskAssessment {
    const record = args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {}
    const config = this.getConfig()

    if (GREEN_PREFIXES.some((prefix) => toolName.startsWith(prefix))) {
      // 记忆/日程会写入本地状态；桌宠表现类不持久化。
      const sideEffect =
        toolName.startsWith('mem_') ||
        toolName.startsWith('alarm_') ||
        toolName.startsWith('remind_')
      return green('只读或表现类工具', sideEffect)
    }
    if (GREEN_TOOLS.has(toolName)) return green('只读或表现类工具', false)
    // 任务控制面：task_create 的权限预授权由工具内部向用户单独确认；
    // 其余 task_* 只改本地任务记录，真正的桌面/文件动作仍走各自风险等级。
    if (toolName.startsWith('task_')) {
      return green('任务管理（创建任务时会单独请求用户确认）', false)
    }

    switch (toolName) {
      case 'ws_write':
        return this.writeRisk(record, config)
      case 'ws_replace':
        return this.existingFileRisk('ws_replace', record, config, '本会话允许替换工作区内的文件')
      case 'ws_delete':
        return this.existingFileRisk('ws_delete', record, config, '本会话允许删除工作区内的文件')
      case 'ws_move':
        return this.moveRisk(record, config)
      case 'term_run':
        return this.terminalRisk(record, config)
      case 'sys_open_app':
        return this.openAppRisk(record, config)
      case 'sys_open_path':
        return this.openPathRisk(record, config)
      case 'sys_open_url':
        return this.openUrlRisk(record, config)
      case 'sys_action':
        return this.actionRisk(record)
      case 'web_fetch':
        return this.webFetchRisk(record)
      case 'cua_screenshot':
      case 'cua_zoom': {
        const view = effectiveExploration(config)
        if (view.fullScreen && config.worlds.cua.enabled && config.provider.visionInput) {
          return green('自由探索整屏观察授权内的截图', false)
        }
        return yellowNoGrant(
          toolName === 'cua_screenshot' ? '截取屏幕并发送给模型' : '裁剪并放大截图发送给模型',
          'medium'
        )
      }
      case 'screen_observe':
        return this.screenObserveRisk(config)
      case 'cua_click':
      case 'cua_scroll':
      case 'cua_drag':
      case 'cua_type':
        return this.cuaInputRisk(config)
      case 'cua_key': {
        const combo = typeof record['combo'] === 'string' ? record['combo'].trim() : ''
        if (isDangerousCombo(combo)) return red('该快捷键会打开安全界面、关闭窗口或切换会话')
        return this.cuaInputRisk(config)
      }
      case 'cua_wait':
      case 'cua_stop':
        return green('等待或停止电脑操作', false)
      case 'win_list':
      case 'win_read':
      case 'computer_observe':
      case 'computer_find':
        return green('只读窗口清单/结构化文本', false)
      case 'win_elements':
        return green('只读窗口控件树', false)
      case 'win_capture':
        return this.windowCaptureRisk(config)
      case 'win_focus':
        return this.winFocusRisk(config)
      case 'win_act':
      case 'computer_act':
        return this.uiaActRisk(config)
      case 'apps_launch':
      case 'apps_focus':
        return this.appCategoryRisk(config)
      case 'browser_open':
      case 'browser_navigate':
      case 'browser_click':
      case 'browser_type':
      case 'browser_select':
      case 'browser_key':
      case 'browser_scroll':
      case 'browser_back':
      case 'browser_forward':
      case 'browser_tab_switch':
      case 'browser_tab_close':
      case 'browser_restore_tabs':
      case 'browser_download':
        return this.browserControlRisk(config, toolName)
      case 'bili_open':
      case 'bili_listing':
      case 'bili_search':
      case 'bili_detail':
      case 'bili_subtitle':
      case 'bili_frames':
      case 'bili_cover':
      case 'bili_transcribe':
      case 'bili_transcribe_status':
      case 'bili_assess':
      case 'bili_media':
        // B 站 API 只读公开内容；真正的开关/同意由 World.enabled 与
        // CapabilityStore 的 bilibili.read 前置条件逐次复验。这里不再借用
        // 浏览器标签页授权，也不会把 API 读取当成“操作浏览器”。
        return green('通过 B 站 API 只读公开视频与本地转写', false)
      case 'web_open':
      case 'web_navigate':
        return this.browserControlRisk(config, toolName)
      case 'web_media':
        return green('检查/暂停/静音她自己的后台标签页媒体', false)
      case 'bili_status':
      case 'bili_stop':
        // 安全阀：无论预算/功能状态如何都必须可用。
        return green('查看或停止主动浏览', false)
      case 'files_artifact_write':
      case 'files_artifact_edit':
      case 'files_artifact_mkdir':
      case 'files_artifact_move':
        return this.artifactRisk(config)
      case 'files_artifact_delete':
        return yellow(
          '删除她的作品文件（移入应用回收站）',
          'medium',
          'file:artifact-delete',
          '本会话允许删除作品目录内的文件'
        )
      default:
        // 未知工具只允许纯读/表现类自动执行；写、终端、网络一律走审批。
        if (
          tool !== undefined &&
          (tool.approval ?? 'auto') === 'auto' &&
          (tool.tags ?? []).every((tag) => tag === 'read' || tag === 'presentation' || tag === 'memory')
        ) {
          return green(
            '未知但仅只读/表现的自定义工具',
            (tool.tags ?? []).includes('memory')
          )
        }
        return red('未知工具或带有副作用的自定义工具，必须人工确认')
    }
  }

  // ------------------------------------------------------------------ 工作区

  private writeRisk(record: Record<string, unknown>, config: AppConfig): RiskAssessment {
    const target = this.resolveInRoots(record['path'], config)
    if (target === null) return red('写入目标不在允许的工作区内')
    if (target.sensitive) return red('目标是敏感文件（密钥/凭据/环境变量等）')
    if (target.git) return red('不允许修改 .git 内部文件')
    if (target.exists && target.isDirectory) return red('目标是目录，不是文件')
    if (!target.exists) return green('在工作区内新建文件', true)
    return yellow(
      '覆盖工作区内已有文件',
      'medium',
      `ws_write:${target.root}`,
      '本会话允许覆盖此目录内的文件'
    )
  }

  private existingFileRisk(
    toolName: 'ws_replace' | 'ws_delete',
    record: Record<string, unknown>,
    config: AppConfig,
    label: string
  ): RiskAssessment {
    const target = this.resolveInRoots(record['path'], config)
    if (target === null) return red('目标不在允许的工作区内')
    if (target.sensitive) return red('目标是敏感文件（密钥/凭据/环境变量等）')
    if (target.git) return red('不允许操作 .git 内部文件')
    if (toolName === 'ws_replace' && !target.exists) return red('替换目标不存在')
    return yellow(
      toolName === 'ws_delete' ? '删除工作区内文件（移入应用回收站）' : '替换工作区内已有文件',
      toolName === 'ws_delete' ? 'medium' : 'medium',
      `${toolName}:${target.root}`,
      label
    )
  }

  private moveRisk(record: Record<string, unknown>, config: AppConfig): RiskAssessment {
    const from = this.resolveInRoots(record['from'], config)
    const to = this.resolveInRoots(record['to'], config)
    if (from === null || to === null) return red('移动的源或目标不在允许的工作区内')
    if (from.sensitive || to.sensitive) return red('移动目标涉及敏感文件')
    if (from.git || to.git) return red('不允许操作 .git 内部文件')
    if (!from.exists) return red('移动源不存在')
    return yellow(
      '移动/重命名工作区内路径',
      'medium',
      `ws_move:${from.root}->${to.root}`,
      '本会话允许在工作区内移动/重命名'
    )
  }

  // ------------------------------------------------------------------ 终端

  private terminalRisk(record: Record<string, unknown>, config: AppConfig): RiskAssessment {
    const command = typeof record['command'] === 'string' ? record['command'].trim() : ''
    if (command === '') return red('终端命令为空')
    const cwdRaw = typeof record['cwd'] === 'string' && record['cwd'].trim() !== '' ? record['cwd'] : '.'
    const cwd = this.resolveInRoots(cwdRaw, config)
    if (cwd === null) return red('终端工作目录不在允许的工作区内')
    if (cwd.sensitive) return red('终端工作目录位于敏感路径')
    if (UNSAFE_COMMAND.test(command)) return red('命令包含管道、重定向、链式或命令替换，必须人工确认')
    const allowlist = config.autonomy.terminalAllowlist
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== '')
    const lowered = command.toLowerCase()
    const prefix = allowlist.find(
      (entry) => lowered === entry || lowered.startsWith(`${entry} `)
    )
    if (prefix === undefined) return red('命令不在用户配置的白名单前缀内')
    return yellow(
      `命中终端白名单前缀：${prefix}`,
      'medium',
      `term:${prefix}`,
      `本会话允许以「${prefix}」开头的命令`
    )
  }

  // ------------------------------------------------------------------ 系统

  private openAppRisk(record: Record<string, unknown>, config: AppConfig): RiskAssessment {
    // 自由探索的应用类别授权优先：普通应用不再逐个加入白名单。
    if (effectiveExploration(config).apps) {
      return green('自由探索类别授权内启动普通应用', true)
    }
    const appId = typeof record['appId'] === 'string' ? record['appId'].trim().toLowerCase() : ''
    if (appId === '') return red('缺少应用 id')
    const system = config.worlds.system
    if (!system.enabled) return red('应用与系统操作已关闭')
    // 统一显式应用来源：worlds.system.apps。appId 大小写不敏感匹配，
    // 但授权键使用配置里保存的 id；路径无法规范化时 fail closed。
    const app = system.apps.find((entry) => entry.id.trim().toLowerCase() === appId)
    if (app === undefined) return red('应用不在系统应用白名单内')
    if (normalizeProcessKey(app.path) === null) {
      return red('应用的启动路径无法验证')
    }
    return yellow('启动系统应用白名单内的应用', 'low', `app:${app.id}`, `本会话允许启动「${app.label}」`)
  }

  private openPathRisk(record: Record<string, unknown>, config: AppConfig): RiskAssessment {
    const raw = record['target']
    if (typeof raw !== 'string' || !isAbsolute(raw) || isUncPath(raw)) {
      return red('打开文件必须使用允许目录内的绝对路径')
    }
    const target = this.resolveInRoots(raw, config)
    if (target === null) return red('目标不在允许的工作区或信任目录内')
    if (target.sensitive) return red('目标是敏感文件')
    if (target.git) return red('不允许打开 .git 内部文件')
    if (OPEN_PATH_EXECUTABLE.test(raw)) return red('不允许通过文件工具启动可执行文件或脚本')
    return yellow(
      '用系统默认程序打开工作区内文件',
      'low',
      `open_path:${target.root}`,
      '本会话允许打开此目录内的普通文件'
    )
  }

  private openUrlRisk(record: Record<string, unknown>, _config: AppConfig): RiskAssessment {
    const url = parseUrl(record['target'])
    if (url === null) return red('链接无效或协议不允许')
    if (!isPublicUrl(url)) return red('链接指向本机、内网或云元数据地址')
    return yellow('在默认浏览器打开公网链接', 'low', `url:${url.hostname}`, `本会话允许打开 ${url.hostname}`)
  }

  private actionRisk(record: Record<string, unknown>): RiskAssessment {
    const action = typeof record['action'] === 'string' ? record['action'] : ''
    if (action === 'lock') return red('锁屏会中断用户当前操作')
    if (!MEDIA_ACTIONS.has(action)) return red('未知系统动作')
    const group = action.startsWith('media_') ? 'media' : 'volume'
    return yellow('可逆的音量/媒体操作', 'low', `action:${group}`, `本会话允许${group === 'media' ? '媒体控制' : '音量控制'}`)
  }

  private webFetchRisk(record: Record<string, unknown>): RiskAssessment {
    const url = parseUrl(record['url'])
    if (url === null) return red('抓取链接无效')
    if (!isPublicUrl(url)) return red('抓取目标指向本机、内网或云元数据地址')
    return green('抓取公网只读页面', false)
  }

  // ------------------------------------------------------------------ CUA

  /** 聚焦授权窗口本身不注入键鼠，但会改变用户当前前台；按输入级风险处理。 */
  private winFocusRisk(config: AppConfig): RiskAssessment {
    if (effectiveExploration(config).apps) {
      return green('自由探索类别授权内切换普通应用窗口', true)
    }
    const cua = config.worlds.cua
    if (cua.permission === 'ask-each-action') {
      return {
        level: 'yellow',
        reason: '每次切换窗口都需要确认',
        approvalRisk: 'high',
        sideEffect: true,
        forceAsk: 'always'
      }
    }
    return {
      level: 'yellow',
      reason: '把授权窗口切换到前台',
      approvalRisk: 'high',
      sideEffect: true,
      grantKey: 'desktop:focus',
      grantLabel: '允许桌宠切换授权窗口',
      forceAsk: 'until-grant',
      grantTtlMs: cua.grantMinutes * 60_000,
      sharedGrant: true
    }
  }

  private cuaInputRisk(config: AppConfig): RiskAssessment {
    if (effectiveExploration(config).apps) {
      return green('自由探索类别授权内的普通键鼠操作', true)
    }
    const cua = config.worlds.cua
    if (cua.permission === 'ask-each-action') {
      // 每次都问：不提供 grant，连“仅本次”之外的范围选项都没有。
      return {
        level: 'yellow',
        reason: '每次电脑操作都需要确认',
        approvalRisk: 'high',
        sideEffect: true,
        forceAsk: 'always'
      }
    }
    return {
      level: 'yellow',
      reason: '模拟鼠标/键盘操作',
      approvalRisk: 'high',
      sideEffect: true,
      grantKey: 'cua:input',
      grantLabel: '允许桌宠操作鼠标键盘',
      forceAsk: 'until-grant',
      grantTtlMs: cua.grantMinutes * 60_000,
      sharedGrant: true
    }
  }

  private windowCaptureRisk(config: AppConfig): RiskAssessment {
    const view = effectiveExploration(config)
    if (
      view.active &&
      (view.windows || view.fullScreen) &&
      config.worlds.desktop.windowCapture &&
      config.provider.visionInput
    ) {
      return green('自由探索窗口观察授权内的截图', false)
    }
    return yellowNoGrant('按窗口截图并发送给模型', 'medium')
  }

  private screenObserveRisk(config: AppConfig): RiskAssessment {
    const view = effectiveExploration(config)
    if (view.fullScreen && config.worlds.cua.enabled && config.provider.visionInput) {
      return green('自由探索整屏观察授权内的截图', false)
    }
    return yellowNoGrant('整屏观察并发送给模型', 'medium')
  }

  private uiaActRisk(config: AppConfig): RiskAssessment {
    if (effectiveExploration(config).apps) {
      return green('自由探索类别授权内的结构化控件操作', true)
    }
    return {
      level: 'yellow',
      reason: '使用 UI Automation 操作窗口控件',
      approvalRisk: 'high',
      sideEffect: true,
      grantKey: 'desktop:uia',
      grantLabel: '本会话允许结构化操作授权窗口',
      forceAsk: 'until-grant',
      grantTtlMs: config.worlds.cua.grantMinutes * 60_000,
      sharedGrant: true
    }
  }

  private appCategoryRisk(config: AppConfig): RiskAssessment {
    if (effectiveExploration(config).apps) {
      return green('自由探索类别授权内的普通应用操作', true)
    }
    return {
      level: 'yellow',
      reason: '启动或切换普通应用',
      approvalRisk: 'low',
      sideEffect: true,
      grantKey: 'app:category',
      grantLabel: '本会话允许启动/切换普通应用',
      forceAsk: 'until-grant',
      grantTtlMs: config.autonomy.sessionGrantMinutes * 60_000,
      sharedGrant: true
    }
  }

  private browserControlRisk(config: AppConfig, toolName: string): RiskAssessment {
    const view = effectiveExploration(config)
    if (!view.browserTabs) {
      return {
        level: 'yellow',
        reason: '主动操作浏览器',
        approvalRisk: 'medium',
        sideEffect: true,
        grantKey: 'browser:control',
        grantLabel: '本会话允许她主动浏览和操作网页',
        forceAsk: 'until-grant',
        grantTtlMs: config.autonomy.sessionGrantMinutes * 60_000,
        sharedGrant: true
      }
    }
    if (toolName === 'browser_download' && !view.artifacts) {
      return {
        level: 'yellow',
        reason: '下载资料到她自己的目录',
        approvalRisk: 'medium',
        sideEffect: true,
        grantKey: 'browser:download',
        grantLabel: '本会话允许下载普通资料',
        forceAsk: 'until-grant',
        grantTtlMs: config.autonomy.sessionGrantMinutes * 60_000,
        sharedGrant: true
      }
    }
    return green('自由探索内的普通浏览操作', true)
  }

  private artifactRisk(config: AppConfig): RiskAssessment {
    const view = effectiveExploration(config)
    if (view.artifacts || view.edits) {
      return green('自由探索内的作品/受权文件写入', true)
    }
    return {
      level: 'yellow',
      reason: '写入她的作品目录',
      approvalRisk: 'medium',
      sideEffect: true,
      grantKey: 'file:artifact',
      grantLabel: '本会话允许写入作品目录',
      forceAsk: 'until-grant',
      grantTtlMs: config.autonomy.sessionGrantMinutes * 60_000,
      sharedGrant: true
    }
  }

  // ------------------------------------------------------------------ 路径

  private resolveInRoots(
    raw: unknown,
    config: AppConfig
  ): {
    root: string
    target: string
    exists: boolean
    isDirectory: boolean
    sensitive: boolean
    git: boolean
  } | null {
    if (typeof raw !== 'string' || raw.trim() === '' || raw.includes('\0')) return null
    const value = raw.trim()
    if (isUncPath(value)) return null

    let root: ResolvedRoot
    let real: string
    if (!isAbsolute(value) && NOTES_ALIAS.test(value)) {
      const notesRoot = config.worlds.workspace.notesRoot.trim()
      if (notesRoot === '' || isUncPath(notesRoot)) return null
      let notesReal: string
      try {
        notesReal = realpathSync.native(notesRoot)
        if (!statSync(notesReal).isDirectory()) return null
      } catch {
        return null
      }
      if (isPathInside(this.dataDir, notesReal)) return null
      const rest = value.replace(NOTES_ALIAS, '')
      const abs = resolve(notesReal, rest)
      if (!isPathInside(notesReal, abs)) return null
      real = realpathForMissing(abs)
      if (!isPathInside(notesReal, real)) return null
      root = { real: notesReal, compare: normalizedForCompare(notesReal) }
    } else {
      const roots = this.allowedRoots(config)
      if (roots.length === 0) return null
      const base = roots[0]!.real
      const abs = resolve(isAbsolute(value) ? value : join(base, value))
      if (isUncPath(abs)) return null
      real = realpathForMissing(abs)
      const found = roots.find((entry) => isPathInside(entry.real, real))
      if (found === undefined) return null
      root = found
    }
    if (isPathInside(this.dataDir, real)) return null

    const exists = existsSync(real)
    let isDirectory = false
    if (exists) {
      try {
        isDirectory = statSync(real).isDirectory()
      } catch {
        return null
      }
    }
    const rel = real.slice(root.real.length).replace(/^[\\/]+/, '')
    return {
      root: root.compare,
      target: real,
      exists,
      isDirectory,
      sensitive: isSensitivePath(rel === '' ? real : rel),
      git: isGitInternal(rel)
    }
  }

  private allowedRoots(config: AppConfig): ResolvedRoot[] {
    const configured = [config.worlds.workspace.root, ...config.autonomy.trustedRoots]
    const seen = new Set<string>()
    const out: ResolvedRoot[] = []
    for (const raw of configured) {
      const value = raw.trim()
      if (value === '' || isUncPath(value)) continue
      let real: string
      try {
        real = realpathSync.native(value)
        if (!statSync(real).isDirectory()) continue
      } catch {
        continue
      }
      if (isPathInside(this.dataDir, real)) continue
      const compare = normalizedForCompare(real)
      if (seen.has(compare)) continue
      seen.add(compare)
      out.push({ real, compare })
    }
    return out
  }
}

function green(reason: string, sideEffect: boolean): RiskAssessment {
  return { level: 'green', reason, approvalRisk: 'low', sideEffect }
}

function yellow(reason: string, approvalRisk: ApprovalRisk, grantKey: string, grantLabel: string): RiskAssessment {
  return { level: 'yellow', reason, approvalRisk, sideEffect: true, grantKey, grantLabel }
}

function yellowNoGrant(reason: string, approvalRisk: ApprovalRisk): RiskAssessment {
  return { level: 'yellow', reason, approvalRisk, sideEffect: true }
}

/** CUA 键名组合的硬红线；无论权限模式如何都直接拒绝。 */
function isDangerousCombo(combo: string): boolean {
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return true
  const has = (...names: string[]): boolean => names.some((name) => parts.includes(name))
  if (has('win', 'meta', 'super', 'cmd', 'windows')) return true
  if (has('ctrl', 'control') && has('alt') && has('del', 'delete')) return true
  if (has('alt') && has('f4')) return true
  if (has('ctrl', 'control') && has('shift') && has('esc', 'escape')) return true
  return false
}

function red(reason: string): RiskAssessment {
  return { level: 'red', reason, approvalRisk: 'high', sideEffect: true }
}

function parseUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}

/** 与 Web World 的 SSRF 守卫保持一致的保守判断。 */
function isPublicUrl(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === '') return false
  if (isIP(host) !== 0) return !isBlockedAddress(host)
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (isBlockedHostname(host)) return false
  return true
}

/**
 * 存在的路径用 realpath；不存在的路径解析最近存在祖先。
 * 符号链接在祖先链中同样会被消除，避免 `ws_write("link/../x")` 之类逃逸。
 */
function realpathForMissing(abs: string): string {
  let current = abs
  const tail: string[] = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = realpathSync.native(current)
      return resolve(real, ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return abs
      tail.push(current.slice(parent.length).replace(/^[\\/]+/, ''))
      current = parent
    }
  }
  return abs
}
