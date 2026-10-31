/**
 * 浏览器页面感知的数据类型。
 *
 * 页面内容是不可信输入：只保留当前活跃标签页的标题、域名、摘要与标题列表，
 * 不保存完整 URL/DOM/表单值。所有字段只在内存中停留到下一页或停止。
 */

export interface BrowserPagePayload {
  /** 已由扩展从 location.hostname 取出；只允许域名，不带协议/路径。 */
  domain: string
  title?: string | null
  excerpt?: string | null
  headings?: string[]
  /** 密码字段/无痕/敏感站点：扩展要求清除当前页，不发送内容。 */
  suppressed?: boolean
  /** 明确要求清除（标签页关闭、切到非网页）。 */
  clear?: boolean
  /** 仅用于本地诊断，不落盘。 */
  source?: 'chrome' | 'edge' | string
}

export interface BrowserPageDescriptor {
  domain: string
  title: string | null
  excerpt: string | null
  headings: string[]
  at: number
  source: string | null
  hash: string
}

export interface BrowserPageStatus {
  enabled: boolean
  hasPage: boolean
  domain: string | null
  updatedAt: number | null
  pagesLastHour: number
  eventsLastHour: number
  droppedLastHour: number
}
