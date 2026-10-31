/**
 * CUA 的固定安全名单与纯函数守卫。
 *
 * 这里只做进程名/标题敏感词/快捷键的本地判断：
 *  - 不读取窗口内容、剪贴板、表单或网页正文；
 *  - 不返回窗口标题原文；
 *  - 固定名单不可由配置移除，用户只能追加 blockedApps。
 */

export type CuaActionKind =
  | 'screenshot'
  | 'zoom'
  | 'click'
  | 'drag'
  | 'type'
  | 'key'
  | 'scroll'
  | 'wait'
  | 'stop'

export type CuaBlockedCategory =
  | 'terminal'
  | 'password-manager'
  | 'system-security'
  | 'remote-admin'
  | 'self'
  | 'user-blocked'
  | 'sensitive-title'

export interface CuaGuardResult {
  blocked: boolean
  category: CuaBlockedCategory | null
  /** 只用于本地 UI/模型提示，不包含进程路径或窗口标题。 */
  label: string | null
}

interface ProcessRule {
  category: Exclude<CuaBlockedCategory, 'self' | 'user-blocked' | 'sensitive-title'>
  label: string
  names: readonly string[]
}

const PROCESS_RULES: readonly ProcessRule[] = [
  {
    category: 'system-security',
    label: '系统安全界面（UAC/锁屏/登录）',
    names: [
      'consent.exe',
      'logonui.exe',
      'lockapp.exe',
      'winlogon.exe',
      'credentialuibroker.exe',
      'useraccountcontrolsettings.exe',
      'securityhealthsystray.exe'
    ]
  },
  {
    category: 'password-manager',
    label: '密码管理器',
    names: [
      'keepass.exe',
      'keepassxc.exe',
      '1password.exe',
      'bitwarden.exe',
      'keeper.exe',
      'dashlane.exe',
      'lastpass.exe',
      'enpass.exe',
      'roboform.exe'
    ]
  },
  {
    category: 'terminal',
    label: '终端/命令行',
    names: [
      'cmd.exe',
      'powershell.exe',
      'pwsh.exe',
      'windowsterminal.exe',
      'wt.exe',
      'conhost.exe',
      'openconsole.exe',
      'bash.exe',
      'wsl.exe',
      'ssh.exe',
      'mintty.exe',
      'putty.exe',
      'wezterm.exe',
      'alacritty.exe'
    ]
  },
  {
    category: 'remote-admin',
    label: '远程桌面/任务管理/注册表工具',
    names: ['mstsc.exe', 'taskmgr.exe', 'regedit.exe', 'mmc.exe', 'gpedit.msc']
  }
]

/** 标题敏感词；大小写不敏感，只做布尔判断，从不保存或发送标题。 */
const SENSITIVE_TITLE_TERMS: readonly string[] = [
  '银行',
  '支付',
  '付款',
  '转账',
  '密码',
  '验证码',
  '双重验证',
  'bank',
  'payment',
  'password',
  'passcode',
  '2fa',
  'authenticator',
  'verification code'
]

export function normalizeProcessName(value: string): string {
  const name = value.trim().toLowerCase().replace(/^.*[\\/]/, '')
  // 不带扩展名时按 exe 处理；gpedit.msc 这类保留原样。
  return name.includes('.') ? name : `${name}.exe`
}

/** 配置/工具里使用的进程键：小写、去路径、去 .exe。 */
export function processKey(value: string): string {
  return normalizeProcessName(value).replace(/\.exe$/, '')
}

/**
 * 固定敏感类别判断（不含用户 blockedApps 与自身进程）。
 * 桌面观察范围、设置页候选列表都复用它，避免另造一份名单。
 */
export function fixedProcessCategory(value: string): CuaBlockedCategory | null {
  const process = normalizeProcessName(value)
  for (const rule of PROCESS_RULES) {
    if (rule.names.some((name) => name.toLowerCase() === process)) return rule.category
  }
  return null
}

export function isFixedSensitiveProcess(value: string): boolean {
  return fixedProcessCategory(value) !== null
}

/** 与端口返回的 titleSensitive 合并；端口已做一次同名单匹配，这里再兜底。 */
export function titleIsSensitive(title: string | null | undefined): boolean {
  if (typeof title !== 'string' || title.trim() === '') return false
  const lowered = title.toLowerCase()
  return SENSITIVE_TITLE_TERMS.some((term) => lowered.includes(term))
}

export function guardCuaForeground(input: {
  processName: string
  titleSensitive: boolean
  blockedApps?: readonly string[]
  selfNames?: readonly string[]
}): CuaGuardResult {
  const process = normalizeProcessName(input.processName)
  const blocked = new Set((input.blockedApps ?? []).map(normalizeProcessName))

  if (blocked.has(process)) {
    return { blocked: true, category: 'user-blocked', label: '用户阻止的应用' }
  }
  const self = new Set((input.selfNames ?? []).map(normalizeProcessName))
  if (self.has(process)) {
    return { blocked: true, category: 'self', label: '桌宠自己' }
  }
  for (const rule of PROCESS_RULES) {
    if (rule.names.some((name) => name.toLowerCase() === process)) {
      return { blocked: true, category: rule.category, label: rule.label }
    }
  }
  if (input.titleSensitive) {
    return {
      blocked: true,
      category: 'sensitive-title',
      label: '敏感窗口（登录/支付/密码/验证码等）'
    }
  }
  return { blocked: false, category: null, label: null }
}

const MODIFIERS = new Set(['ctrl', 'control', 'alt', 'shift'])
const DANGEROUS_MODIFIERS = new Set(['win', 'meta', 'super', 'cmd', 'windows', 'command'])

/** 参数中允许的按键名；helper 端有同样的白名单，两边都 fail closed。 */
const KEY_NAMES = new Set([
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  ...'0123456789'.split(''),
  ...Array.from({ length: 12 }, (_value, index) => `f${index + 1}`),
  'enter',
  'return',
  'tab',
  'esc',
  'escape',
  'space',
  'backspace',
  'delete',
  'del',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
  'minus',
  'plus',
  'comma',
  'period',
  'slash',
  'semicolon',
  'quote',
  'backtick',
  'bracketleft',
  'bracketright',
  'backslash',
  'equal'
])

export interface ParsedKeyCombo {
  modifiers: string[]
  key: string
}

/**
 * 解析 `Ctrl+Shift+S` 一类的组合。只允许已知修饰键与一个普通键；
 * 拒绝 Win、Ctrl+Alt+Del、Alt+F4、Ctrl+Shift+Esc。
 */
export function parseKeyCombo(raw: string): ParsedKeyCombo | null {
  const parts = raw
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '')
  if (parts.length === 0 || parts.length > 4) return null
  if (parts.some((part) => DANGEROUS_MODIFIERS.has(part))) return null

  const modifiers: string[] = []
  let key: string | null = null
  for (const part of parts) {
    if (MODIFIERS.has(part)) {
      const normalized =
        part === 'control' ? 'ctrl' : part
      if (!modifiers.includes(normalized)) modifiers.push(normalized)
      continue
    }
    if (!KEY_NAMES.has(part) || key !== null) return null
    key = part
  }
  if (key === null) return null
  const hasCtrl = modifiers.includes('ctrl')
  const hasAlt = modifiers.includes('alt')
  const hasShift = modifiers.includes('shift')
  if (hasAlt && !hasCtrl && !hasShift && key === 'f4') return null
  if (hasCtrl && hasAlt && (key === 'del' || key === 'delete')) return null
  if (hasCtrl && hasShift && (key === 'esc' || key === 'escape')) return null
  return { modifiers, key }
}

/** 危险组合不因审批通过而执行；RiskPolicy 与 World 都拒绝。 */
export function isForbiddenKeyCombo(raw: string): boolean {
  return parseKeyCombo(raw) === null
}
