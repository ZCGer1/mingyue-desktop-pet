import type { AppConfig } from '../../shared/config'

/**
 * 应用身份与窗口标题的本地脱敏。
 *
 * 原始进程名/窗口标题只允许出现在采样进程与设置页本地预览里；进入事件、
 * 会话、日志、诊断之前必须先经过这里。这里不做任何 I/O，也不记录原始值。
 */

/** 常见应用的显示名。键是 normalizeProcessName() 之后的进程名。 */
export const APP_DISPLAY_NAMES: Record<string, string> = {
  code: 'VS Code',
  'code - insiders': 'VS Code Insiders',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  idea64: 'IntelliJ IDEA',
  webstorm64: 'WebStorm',
  pycharm64: 'PyCharm',
  devenv: 'Visual Studio',
  sublime_text: 'Sublime Text',
  notepad: '记事本',
  notepadpp: 'Notepad++',
  vim: 'Vim',
  nvim: 'Neovim',
  emacs: 'Emacs',

  windowsterminal: 'Windows Terminal',
  'windows-terminal': 'Windows Terminal',
  cmd: '命令提示符',
  conhost: '控制台',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  wt: 'Windows Terminal',
  alacritty: 'Alacritty',
  wezterm: 'WezTerm',
  mintty: 'Mintty',

  chrome: 'Chrome',
  msedge: 'Edge',
  firefox: 'Firefox',
  brave: 'Brave',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
  arc: 'Arc',
  thunderbird: 'Thunderbird',

  spotify: 'Spotify',
  vlc: 'VLC',
  mpv: 'mpv',
  potplayermini64: 'PotPlayer',
  potplayer: 'PotPlayer',
  musicbee: 'MusicBee',
  foobar2000: 'foobar2000',
  bilibili: '哔哩哔哩',
  '哔哩哔哩': '哔哩哔哩',

  winword: 'Word',
  excel: 'Excel',
  powerpnt: 'PowerPoint',
  onenote: 'OneNote',
  outlook: 'Outlook',
  wps: 'WPS',
  et: 'WPS 表格',
  wpp: 'WPS 演示',
  notion: 'Notion',
  obsidian: 'Obsidian',
  typora: 'Typora',

  photoshop: 'Photoshop',
  illustrator: 'Illustrator',
  figma: 'Figma',
  inkscape: 'Inkscape',
  blender: 'Blender',
  krita: 'Krita',
  aftereffects: 'After Effects',
  premiere: 'Premiere Pro',
  'adobe premiere pro': 'Premiere Pro',

  steam: 'Steam',
  epicgameslauncher: 'Epic Games',
  'battle.net': '战网',
  riotclientservices: 'Riot Client',
  leagueclient: '英雄联盟',
  'league of legends': '英雄联盟',
  genshinimpact: '原神',
  yuanshen: '原神',
  'star rail': '崩坏：星穹铁道',
  minecraft: 'Minecraft',
  javaw: 'Java 应用',

  zoom: 'Zoom',
  teams: 'Teams',
  'ms-teams': 'Teams',
  dingtalk: '钉钉',
  wemeetapp: '腾讯会议',
  tencentmeeting: '腾讯会议',
  webexmta: 'Webex',
  discord: 'Discord',
  slack: 'Slack',
  wechat: '微信',
  wxwork: '企业微信',
  qq: 'QQ',
  feishu: '飞书',
  lark: 'Lark',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  explorer: '文件资源管理器'
}

/** 只保留进程名本体：去路径、.exe、控制字符；支持中文等 Unicode 名称。 */
export function normalizeProcessName(raw: string | null): string | null {
  if (raw === null) return null
  const base = raw
    .normalize('NFKC')
    .trim()
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase()
  if (base === '' || base.length > 120) return null
  if (!/^[\p{L}\p{N} ._-]{1,120}$/u.test(base)) return null
  return base
}

/**
 * 应用显示名：内置表 → 用户配置的 system.apps.label → null。
 * 绝不回退到原始进程名。
 */
export function resolveAppLabel(processKey: string | null, config: AppConfig): string | null {
  if (processKey === null) return null
  const builtin = APP_DISPLAY_NAMES[processKey]
  if (builtin !== undefined) return builtin
  for (const app of config.worlds.system.apps) {
    const id = app.id.trim().toLowerCase()
    const fromPath = normalizeProcessName(app.path)
    if (id !== processKey && fromPath !== processKey) continue
    const label = app.label.trim()
    if (label !== '') return label.slice(0, 80)
  }
  return null
}

export interface SanitizeTitleOptions {
  appLabel: string | null
  maxChars: number
  /** 可选：类别显示名，用于剔除「标题就是类别」的情况。 */
  categoryLabel?: string | null
}

export interface SanitizedTitle {
  text: string | null
  /** 整条标题因敏感词被丢弃。 */
  suppressed: boolean
}

const URL_PATTERN = /(?:\b(?:https?|ftp|file):\/\/|\bwww\.)[^\s<>"']+/gi
const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu
const WINDOWS_PATH_PATTERN = /[A-Za-z]:[\\/][^\s<>"'|]*/g
const UNC_PATH_PATTERN = /\\\\[^\s<>"'|\\]+(?:\\[^\s<>"'|\\]*)+/g
const POSIX_PATH_PATTERN = /(?:^|(?<=\s))(?:\/[A-Za-z0-9._-]+){2,}\/?/g
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
// 12 位以上的编号/卡号，以及中国大陆 11 位手机号。
const LONG_DIGITS_PATTERN = /\b(?:\d{12,}|1[3-9]\d{9})\b/g
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_\-+=]{24,}\b/g
const SENSITIVE_WORDS =
  /(密码|口令|验证码|银行|支付|私钥|恢复码|身份证|护照|银行卡|password|passwd|secret|recovery code|verification code|paypal|payment|credit card|bank(?:ing)?\b)/i
const EDGE_SEPARATORS = /^[\s\-–—|·•:：,，;；]+|[\s\-–—|·•:：,，;；]+$/g

/**
 * 脱敏窗口标题。顺序固定，避免路径/URL 被后续规则重新拼回。
 * 返回 null 表示「不共享标题」，suppressed 表示命中了敏感词。
 */
export function sanitizeWindowTitle(raw: string | null, opts: SanitizeTitleOptions): SanitizedTitle {
  if (raw === null) return { text: null, suppressed: false }
  const maxChars = Math.max(1, Math.round(opts.maxChars))
  let text = raw
    .normalize('NFKC')
    // 控制字符与零宽/双向格式字符不进入任何下游。
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')

  text = text
    .replace(URL_PATTERN, ' [链接] ')
    .replace(EMAIL_PATTERN, ' [邮箱] ')
    .replace(WINDOWS_PATH_PATTERN, ' [路径] ')
    .replace(UNC_PATH_PATTERN, ' [路径] ')
    .replace(POSIX_PATH_PATTERN, ' [路径] ')
    .replace(UUID_PATTERN, ' [标识] ')
    .replace(LONG_DIGITS_PATTERN, ' [标识] ')
    .replace(LONG_TOKEN_PATTERN, ' [标识] ')

  if (SENSITIVE_WORDS.test(text)) return { text: null, suppressed: true }

  text = text
    .replace(/\s+/g, ' ')
    .replace(EDGE_SEPARATORS, '')
    .trim()
  if (text === '') return { text: null, suppressed: false }

  const visible = Array.from(text.replace(/\s/g, ''))
  if (visible.length < 2) return { text: null, suppressed: false }

  const app = opts.appLabel?.normalize('NFKC').trim().toLowerCase()
  const category = opts.categoryLabel?.normalize('NFKC').trim().toLowerCase()
  const lowered = text.toLowerCase()
  if ((app !== undefined && app !== '' && lowered === app) || (category !== undefined && category !== '' && lowered === category)) {
    return { text: null, suppressed: false }
  }

  const chars = Array.from(text)
  if (chars.length > maxChars) {
    text = `${chars.slice(0, maxChars).join('')}…`
  }
  return { text, suppressed: false }
}
