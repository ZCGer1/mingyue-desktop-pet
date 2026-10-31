import type { ChatActionResult } from '../shared/ipc'
import { biliVideoUrl, isBvid } from '../shared/bilibili'

/**
 * 聊天卡与桌宠迷你卡共用的打开逻辑。
 *
 * 渲染进程只传 bvid + partIndex；URL 永远由主进程用固定站点函数重建，
 * 不接受任何模型/页面传入的完整链接。参数在这里统一校验。
 */
export interface BiliVideoOpenDeps {
  openExternal(url: string): Promise<void>
}

export async function openBiliVideo(
  deps: BiliVideoOpenDeps,
  bvidRaw: unknown,
  partIndexRaw: unknown
): Promise<ChatActionResult> {
  if (
    typeof bvidRaw !== 'string' ||
    bvidRaw.length > 20 ||
    !isBvid(bvidRaw) ||
    typeof partIndexRaw !== 'number' ||
    !Number.isSafeInteger(partIndexRaw) ||
    partIndexRaw < 0 ||
    partIndexRaw > 199
  ) {
    return { ok: false, message: '视频参数无效。' }
  }
  try {
    await deps.openExternal(biliVideoUrl(bvidRaw, partIndexRaw))
    return { ok: true, message: '已在你的浏览器中打开。' }
  } catch {
    return { ok: false, message: '打开浏览器失败。' }
  }
}
