/**
 * 内容脚本：在页面加载、可见性变化和 DOM 变化时节流触发抽取。
 * 不读取 URL、表单值或用户输入，只把 extract.js 的结果发给后台。
 */
;(function () {
  'use strict'

  const MIN_PUSH_INTERVAL_MS = 1500
  let timer = null
  let lastAttemptAt = 0
  let lastSignature = ''

  function extractSafely() {
    try {
      const extractor = globalThis.__mingyuePageExtract
      if (!extractor || typeof extractor.extract !== 'function') return { suppressed: true }
      return extractor.extract()
    } catch {
      return { suppressed: true }
    }
  }

  function signature(payload) {
    if (payload.suppressed === true) return 'suppressed'
    const excerpt = typeof payload.excerpt === 'string' ? payload.excerpt : ''
    return [
      payload.domain || '',
      payload.title || '',
      (payload.headings || []).join('\u0000'),
      excerpt.length,
      excerpt.slice(0, 96)
    ].join('\u0001')
  }

  function push(reason) {
    if (document.visibilityState === 'hidden') return
    const payload = extractSafely()
    const next = signature(payload)
    if (reason !== 'request' && next === lastSignature) return
    lastSignature = next
    lastAttemptAt = Date.now()
    try {
      chrome.runtime.sendMessage({ type: 'page-snapshot', payload, reason }, () => {
        // 扩展被重载/卸载时会出现 lastError；读取一次避免控制台噪声。
        void chrome.runtime.lastError
      })
    } catch {
      /* 扩展上下文失效，停止发送 */
    }
  }

  function schedule(reason) {
    if (document.visibilityState === 'hidden') return
    if (timer !== null) return
    const delay = Math.max(0, MIN_PUSH_INTERVAL_MS - (Date.now() - lastAttemptAt))
    timer = setTimeout(() => {
      timer = null
      push(reason)
    }, delay)
  }

  function startObserver() {
    if (!document.body) return
    try {
      const observer = new MutationObserver(() => schedule('mutation'))
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true
      })
    } catch {
      /* 页面禁止观察时忽略 */
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'mingyue-extract') {
      if (document.visibilityState === 'hidden') {
        sendResponse(null)
        return false
      }
      const payload = extractSafely()
      lastSignature = signature(payload)
      lastAttemptAt = Date.now()
      sendResponse(payload)
      return false
    }
    return false
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule('visible')
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      startObserver()
      schedule('load')
    })
  } else {
    startObserver()
    schedule('load')
  }
})()
