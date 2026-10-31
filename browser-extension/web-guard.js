/**
 * 普通网页的自主浏览媒体守卫。
 *
 * 只在主动控制 service worker 明确发消息时动作；普通用户浏览不经过这里，
 * 因此不会替用户暂停/静音页面媒体。守卫只处理当前文档的 video/audio，
 * 不读取页面文字、cookie 或表单内容。
 */
'use strict'

function webGuardMedia() {
  const nodes = Array.from(document.querySelectorAll('video, audio'))
  let playingCount = 0
  for (const node of nodes) {
    try {
      if (!node.paused && !node.ended) playingCount += 1
    } catch {
      /* 访问媒体状态失败时按未播放处理，由回读的 audible 再兜底 */
    }
  }
  return { playingCount, mediaCount: nodes.length }
}

function webGuardPause() {
  const nodes = Array.from(document.querySelectorAll('video, audio'))
  for (const node of nodes) {
    try {
      node.muted = true
      node.pause()
    } catch {
      /* 单个媒体失败不阻塞其它媒体 */
    }
  }
}

function webGuardMute() {
  const nodes = Array.from(document.querySelectorAll('video, audio'))
  for (const node of nodes) {
    try {
      node.muted = true
    } catch {
      /* 忽略 */
    }
  }
}

// 提前注入后，manifest 的 document_idle 脚本仍可能执行，避免重复注册。
if (globalThis.__mingyueWebGuardLoaded !== true) {
  globalThis.__mingyueWebGuardLoaded = true
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message === null || typeof message !== 'object') return false
    if (message.type !== 'mingyue-web-guard') return false
    const op = typeof message.op === 'string' ? message.op : ''
    if (op === 'pause') webGuardPause()
    else if (op === 'mute') webGuardMute()
    if (op !== 'status' && op !== 'pause' && op !== 'mute') {
      sendResponse({ ok: false, allowed: false })
      return false
    }
    sendResponse({ ok: true, allowed: true, status: webGuardMedia() })
    return false
  })
}
