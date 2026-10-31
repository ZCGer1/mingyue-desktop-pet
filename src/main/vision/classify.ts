import type { ActivityCategory } from '../../worlds/activity/types'
import { CATEGORY_LABELS } from '../../worlds/activity/types'
import { SCENE_LABELS, type SceneCategory, type SceneDescriptor } from '../../worlds/activity/scene'

/**
 * OCR 文本 → 抽象场景。纯函数、无 I/O，便于单测。
 *
 * 隐私原则（PLAN.md §4.1）：
 * - URL、邮箱、长数字、令牌样式在归一化阶段被替换；
 * - `keywords` 只包含命中的规范词，不是 OCR 原文片段；
 * - `title` 只用于本机设置页预览，调用方不得把它放进模型上下文。
 */

const MAX_INPUT = 12_000

const KEYWORDS: Array<{ category: SceneCategory; words: string[] }> = [
  {
    category: 'watching_video',
    words: [
      'bilibili',
      '哔哩哔哩',
      'youtube',
      'netflix',
      '爱奇艺',
      '腾讯视频',
      '优酷',
      '西瓜视频',
      '播放',
      '弹幕',
      '视频',
      '直播',
      'watch',
      'episode'
    ]
  },
  {
    category: 'gaming',
    words: [
      'steam',
      'epic games',
      '原神',
      '崩坏',
      '星穹铁道',
      '英雄联盟',
      'league of legends',
      'valorant',
      'minecraft',
      '我的世界',
      '对局',
      '排位',
      '段位',
      '游戏',
      'game'
    ]
  },
  {
    category: 'meeting',
    words: [
      'zoom',
      'teams',
      '腾讯会议',
      '钉钉会议',
      '飞书会议',
      'webex',
      '会议',
      '麦克风',
      '摄像头',
      'meeting',
      '参会'
    ]
  },
  {
    category: 'coding',
    words: [
      'visual studio',
      'vscode',
      'github',
      'gitlab',
      'stack overflow',
      'terminal',
      'powershell',
      'npm',
      'pnpm',
      'node_modules',
      'python',
      'typescript',
      'javascript',
      'rust',
      'java',
      '编译',
      '报错',
      '函数',
      '代码',
      '调试',
      '堆栈',
      'commit',
      'merge'
    ]
  },
  {
    category: 'writing',
    words: [
      'microsoft word',
      'winword',
      'excel',
      'powerpoint',
      'wps',
      '文档',
      '表格',
      '演示文稿',
      '幻灯片',
      '字数',
      'word',
      'sheet'
    ]
  },
  {
    category: 'designing',
    words: [
      'figma',
      'photoshop',
      'illustrator',
      'blender',
      'krita',
      '画布',
      '图层',
      '蒙版',
      '设计',
      '调色',
      'canvas'
    ]
  },
  {
    category: 'shopping',
    words: ['淘宝', '天猫', '京东', '拼多多', '购物车', '下单', '优惠券', '价格', 'amazon', 'ebay', 'cart']
  },
  {
    category: 'social',
    words: ['微博', '知乎', '小红书', '朋友圈', '微信', 'discord', 'reddit', 'twitter', 'instagram', '动态']
  },
  {
    category: 'reading',
    words: ['阅读', '小说', '章节', '正文', '文章', 'kindle', 'read', 'chapter', 'blog']
  },
  {
    category: 'browsing',
    words: ['搜索', '百度', 'google', 'bing', '浏览器', '网页', 'search', 'chrome', 'edge', 'firefox']
  }
]

const PRIOR_CATEGORY: Partial<Record<ActivityCategory, SceneCategory>> = {
  editor: 'coding',
  terminal: 'coding',
  browser: 'browsing',
  media: 'watching_video',
  office: 'writing',
  design: 'designing',
  game: 'gaming',
  meeting: 'meeting'
}

/** URL、邮箱、长数字、密钥样式与连续空白。 */
export function normalizeOcrText(raw: string): string {
  return raw
    .slice(0, MAX_INPUT)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
    .replace(/\b[A-Za-z0-9_-]{28,}\b/g, ' ')
    .replace(/\b\d{6,}\b/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    // Windows.Media.Ocr 常在汉字之间插入空格（“设 置”），中文词表与
    // 阶段关键词必须按无空格形式匹配，否则真实 OCR 永远命中不了。
    // 只折叠行内空白，保留换行用于标题/分行。
    .replace(/([㐀-鿿：；，。！？、（）【】「」《》〈〉])[ \t　]+(?=[㐀-鿿：；，。！？、（）【】「」《》〈〉])/g, '$1')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function matchesWord(haystack: string, word: string): boolean {
  if (/^[a-z0-9 .+#-]+$/i.test(word)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack)
  }
  return haystack.includes(word)
}

function pickTitle(normalized: string): string | null {
  for (const line of normalized.split('\n')) {
    const text = line.replace(/\s+/g, ' ').trim()
    if (text.length < 3) continue
    if (/^[\d\s.,:;|/\\-]+$/.test(text)) continue
    return text.slice(0, 80)
  }
  return null
}

export interface ClassifyInput {
  /** OCR 文本；为空时只按类别先验判断。 */
  text: string
  /** 前台进程所属类别（本地抽象，不含进程名）。 */
  category: ActivityCategory | null
  at?: number
}

export function classifyScene(input: ClassifyInput): SceneDescriptor {
  const normalized = normalizeOcrText(input.text)
  const haystack = normalized.toLowerCase()
  const hits = new Map<SceneCategory, string[]>()
  for (const group of KEYWORDS) {
    const matched: string[] = []
    for (const word of group.words) {
      if (matchesWord(haystack, word.toLowerCase())) matched.push(word)
      if (matched.length >= 4) break
    }
    if (matched.length > 0) hits.set(group.category, matched)
  }

  const prior = input.category === null ? undefined : PRIOR_CATEGORY[input.category]
  const count = (category: SceneCategory): number => hits.get(category)?.length ?? 0

  let category: SceneCategory
  if (count('meeting') > 0 || prior === 'meeting') category = 'meeting'
  else if (count('gaming') > 0 || prior === 'gaming') category = 'gaming'
  else if (count('watching_video') > 0 || prior === 'watching_video') category = 'watching_video'
  else if (count('coding') > 0 || prior === 'coding') category = 'coding'
  else if (count('designing') > 0 || prior === 'designing') category = 'designing'
  else if (count('reading') > 0) category = 'reading'
  else if (count('shopping') > 0) category = 'shopping'
  else if (count('social') > 0) category = 'social'
  else if (count('writing') > 0 || prior === 'writing') category = 'writing'
  else if (count('browsing') > 0 || prior === 'browsing') category = 'browsing'
  else category = 'unknown'

  const keywords = [...(hits.get(category) ?? [])].slice(0, 6)
  const priorMatched = prior === category
  const confidence =
    category === 'unknown'
      ? 0.25
      : Math.min(
          0.95,
          0.35 +
            Math.min(3, keywords.length) * 0.15 +
            (priorMatched ? 0.2 : 0) +
            (input.category === null ? 0 : 0.05)
        )

  return {
    category,
    // unknown 的标签本身已含「在」，避免出现「在在用电脑」。
    activity: category === 'unknown' ? '在用电脑' : `在${SCENE_LABELS[category]}`,
    appLabel:
      input.category === null ? '桌面应用' : CATEGORY_LABELS[input.category],
    title: pickTitle(normalized),
    keywords,
    confidence,
    at: input.at ?? Date.now()
  }
}
