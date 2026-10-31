/**
 * MV3 后台：判定活跃标签页、拉取本机过滤规则、节流并 POST 到回环桥。
 *
 * 隐私边界：
 * - 不读取/保存/发送完整 URL（连 tabs.url 都不读）；
 * - 只处理当前窗口的活跃标签页，无痕窗口一律跳过；
 * - 未配对、未同意、已暂停或拉取不到过滤规则时，不发送任何页面内容；
 * - 页面正文只在内存中经过，不写入 storage。
 */
'use strict'

importScripts('control-background.js')

const ALARM_NAME = 'mingyue-heartbeat'
const FILTER_TTL_MS = 5 * 60 * 1000
const MAX_EXCERPT_CHARS = 4000
const HELLO_MIN_INTERVAL_MS = 30 * 1000

let helloAt = 0

const state = {
  filters: null,
  filtersAt: 0,
  filtersOk: false,
  disabledByApp: false,
  lastError: null,
  lastSendAt: 0,
  lastClearAt: 0,
  lastSendByTab: new Map(),
  lastActiveTabId: null
}

// ---------------------------------------------------------------------------
// 存储与配对
// ---------------------------------------------------------------------------

async function readSettings() {
  const data = await chrome.storage.local.get({
    pairing: '',
    consent: false,
    paused: false,
    controlConsent: false
  })
  return {
    pairing: typeof data.pairing === 'string' ? data.pairing : '',
    consent: data.consent === true,
    paused: data.paused === true,
    controlConsent: data.controlConsent === true
  }
}

function parsePairing(raw) {
  const text = String(raw || '').trim()
  const match = /^(\d{1,5})#([a-f0-9]{64})$/i.exec(text)
  if (match === null) return null
  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return {
    port,
    token: match[2].toLowerCase(),
    base: 'http://127.0.0.1:' + port
  }
}

// ---------------------------------------------------------------------------
// 域名规则
// ---------------------------------------------------------------------------

function normalizeDomain(raw) {
  if (typeof raw !== 'string') return null
  const domain = raw
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
  if (domain === '' || domain.length > 253) return null
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) return null
  if (domain.includes('..')) return null
  return domain
}

function domainMatches(domain, pattern) {
  const p = String(pattern || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
  if (p === '') return false
  if (p.startsWith('*.')) {
    const base = p.slice(2)
    return base !== '' && (domain === base || domain.endsWith('.' + base))
  }
  return domain === p
}

function matchesAny(domain, patterns) {
  return patterns.some((pattern) => domainMatches(domain, pattern))
}

function domainAllowed(domain) {
  const filters = state.filters
  if (filters === null) return false
  if (matchesAny(domain, filters.denylist)) return false
  if (matchesAny(domain, filters.sensitiveDomains)) return false
  if (filters.allowlistOnly && !matchesAny(domain, filters.allowlist)) return false
  return true
}

// ---------------------------------------------------------------------------
// 过滤规则
// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '' && item.length <= 253)
    .slice(0, 500)
}

function normalizeFilters(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    allowlistOnly: value.allowlistOnly === true,
    allowlist: stringList(value.allowlist),
    denylist: stringList(value.denylist),
    sensitiveDomains: stringList(value.sensitiveDomains),
    shareTitle: value.shareTitle !== false,
    shareExcerpt: value.shareExcerpt !== false,
    includeHeadings: value.includeHeadings !== false,
    excerptMaxChars: clampInt(value.excerptMaxChars, 200, 4000, 1200),
    coalesceMs: clampInt(value.coalesceMs, 1000, 30000, 3000)
  }
}

/**
 * 拉取本机过滤规则。失败时保守暂停发送页面内容；不缓存旧规则用于发送。
 * 仅在应用确认关闭页面感知（403）时标记 disabledByApp，便于界面提示。
 */
async function ensureFilters(force) {
  const settings = await readSettings()
  if (!settings.consent || settings.paused) {
    state.filtersOk = false
    return false
  }
  const pairing = parsePairing(settings.pairing)
  if (pairing === null) {
    state.filtersOk = false
    state.lastError = '尚未配置配对码'
    return false
  }
  const now = Date.now()
  if (!force && state.filtersOk && now - state.filtersAt < FILTER_TTL_MS) return true
  try {
    const response = await fetch(pairing.base + '/v1/filters', {
      method: 'GET',
      headers: { authorization: 'Bearer ' + pairing.token },
      cache: 'no-store'
    })
    if (response.status === 401) {
      state.filtersOk = false
      state.disabledByApp = false
      state.lastError = '配对码无效，请在设置页重新配对'
      return false
    }
    if (response.status === 403) {
      state.filtersOk = false
      state.disabledByApp = true
      state.lastError = '应用内“浏览器页面感知”未开启'
      return false
    }
    if (!response.ok) {
      state.filtersOk = false
      state.lastError = '过滤规则读取失败（' + response.status + '）'
      return false
    }
    state.filters = normalizeFilters(await response.json())
    state.filtersAt = Date.now()
    state.filtersOk = true
    state.disabledByApp = false
    state.lastError = null
    return true
  } catch {
    state.filtersOk = false
    state.lastError = '无法连接桌宠，请确认应用正在运行'
    return false
  }
}

// ---------------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------------

function browserSource() {
  try {
    return navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome'
  } catch {
    return 'chrome'
  }
}

async function postJson(pairing, body) {
  try {
    const response = await fetch(pairing.base + '/v1/page', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + pairing.token
      },
      body: JSON.stringify(body),
      cache: 'no-store'
    })
    if (response.status === 401) {
      state.lastError = '配对码无效，请在设置页重新配对'
      state.filtersOk = false
    } else if (response.status === 403) {
      state.lastError = '应用内“浏览器页面感知”未开启'
      state.filtersOk = false
      state.disabledByApp = true
    } else if (response.status === 429) {
      state.lastError = '发送过快，应用已限流'
    } else if (!response.ok) {
      state.lastError = '应用返回 ' + response.status
    } else {
      state.lastError = null
      state.lastSendAt = Date.now()
    }
  } catch {
    state.lastError = '无法连接桌宠，请确认应用正在运行'
  }
}

/**
 * 在线握手：只报告授权布尔值与扩展版本，不携带任何页面内容。
 * 应用用它区分“页面感知在线”和“扩展弹窗允许主动浏览”，
 * 避免把页面通道的已连接误当成主动控制已就绪。
 */
async function reportHello(force) {
  const settings = await readSettings()
  if (!settings.consent && !settings.controlConsent) return
  const pairing = parsePairing(settings.pairing)
  if (pairing === null) return
  const now = Date.now()
  if (!force && now - helloAt < HELLO_MIN_INTERVAL_MS) return
  helloAt = now
  try {
    await fetch(pairing.base + '/v1/hello', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + pairing.token
      },
      body: JSON.stringify({
        // 运行时实例/版本/能力来自当前 service worker，而不是磁盘安装包。
        ...(await controlHelloFacts()),
        pageConsent: settings.consent,
        controlConsent: settings.controlConsent,
        paused: settings.paused
      }),
      cache: 'no-store'
    })
  } catch {
    // 连接状态由页面/控制通道自己的错误提示负责；握手失败不额外打扰用户。
  }
}

async function sendClear() {
  const settings = await readSettings()
  if (!settings.consent) return
  const pairing = parsePairing(settings.pairing)
  if (pairing === null) return
  const now = Date.now()
  if (now - state.lastClearAt < 3000) return
  state.lastClearAt = now
  await postJson(pairing, { clear: true })
}

async function submitPage(tab, payload, reason) {
  const settings = await readSettings()
  if (!settings.consent || settings.paused) return
  const pairing = parsePairing(settings.pairing)
  if (pairing === null) return
  if (!(await ensureFilters(false))) return
  if (tab === null || typeof tab.id !== 'number') return
  if (tab.incognito === true) {
    await sendClear()
    return
  }
  if (payload === null || typeof payload !== 'object') return

  const now = Date.now()
  const last = state.lastSendByTab.get(tab.id) || 0
  if (now - last < state.filters.coalesceMs) return

  let body
  if (payload.suppressed === true) {
    body = { suppressed: true }
  } else {
    const domain = normalizeDomain(payload.domain)
    if (domain === null || !domainAllowed(domain)) {
      body = { suppressed: true }
    } else {
      body = { domain, source: browserSource() }
      if (state.filters.shareTitle && typeof payload.title === 'string') {
        body.title = payload.title.slice(0, 300)
      }
      if (state.filters.shareExcerpt && typeof payload.excerpt === 'string') {
        body.excerpt = payload.excerpt.slice(0, MAX_EXCERPT_CHARS)
      }
      if (state.filters.includeHeadings && Array.isArray(payload.headings)) {
        body.headings = payload.headings
          .filter((item) => typeof item === 'string' && item !== '')
          .map((item) => item.slice(0, 300))
          .slice(0, 8)
      }
    }
  }

  state.lastSendByTab.set(tab.id, now)
  void reason
  await postJson(pairing, body)
}

// ---------------------------------------------------------------------------
// 活跃标签页
// ---------------------------------------------------------------------------

async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    const tab = tabs[0]
    if (!tab || typeof tab.id !== 'number') return null
    return tab
  } catch {
    return null
  }
}

/**
 * 向当前活跃标签页请求一次抽取。
 * 内容脚本只注入 http/https；发送失败说明当前不是可读网页，按需清除旧页。
 */
async function extractActive(clearIfMissing) {
  const settings = await readSettings()
  if (!settings.consent || settings.paused) return
  const tab = await getActiveTab()
  if (tab === null) {
    if (clearIfMissing) await sendClear()
    return
  }
  if (tab.incognito === true) {
    await sendClear()
    return
  }
  let payload = null
  try {
    payload = await chrome.tabs.sendMessage(tab.id, { type: 'mingyue-extract' })
  } catch {
    payload = null
  }
  if (payload === null || typeof payload !== 'object') {
    if (clearIfMissing) await sendClear()
    return
  }
  state.lastActiveTabId = tab.id
  await submitPage(tab, payload, 'request')
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

async function buildStatus() {
  const settings = await readSettings()
  const pairing = parsePairing(settings.pairing)
  return {
    paired: pairing !== null,
    consent: settings.consent,
    paused: settings.paused,
    port: pairing === null ? null : pairing.port,
    filtersOk: state.filtersOk,
    disabledByApp: state.disabledByApp,
    lastError: state.lastError,
    lastSendAt: state.lastSendAt === 0 ? null : state.lastSendAt,
    browser: browserSource(),
    control: {
      consent: settings.controlConsent,
      polling: controlState.polling,
      connected:
        controlState.lastPollAt > 0 && Date.now() - controlState.lastPollAt < 60_000,
      lastError: controlState.lastError,
      lastCommandAt: controlState.lastCommandAt === 0 ? null : controlState.lastCommandAt,
      lastResultAt: controlState.lastResultAt === 0 ? null : controlState.lastResultAt,
      autonomousTabs: controlState.owned.filter(
        (entry) => entry.autonomous === true && entry.takenOver !== true
      ).length
    }
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

async function heartbeat() {
  // 主动控制独立于被动感知：即使感知暂停/关闭，已同意的控制通道也要保活。
  void ensureControlPolling()
  void reportHello()
  const settings = await readSettings()
  if (!settings.consent || settings.paused) return
  const fresh = state.filtersOk && Date.now() - state.filtersAt < FILTER_TTL_MS - 30_000
  if (!fresh && !(await ensureFilters(true))) return
  await extractActive(false)
}

function createAlarm() {
  void chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 })
}

chrome.runtime.onInstalled.addListener(() => {
  createAlarm()
  void ensureFilters(true)
  // 扩展更新可能更换内容脚本协议；不再信任旧版本的自主标签页。
  void releaseAutonomousTabsOnStartup().then(() => ensureControlPolling())
  void reportHello(true)
})

chrome.runtime.onStartup.addListener(() => {
  createAlarm()
  void ensureFilters(true)
  void releaseAutonomousTabsOnStartup().then(() => ensureControlPolling())
  void reportHello(true)
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void heartbeat()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.pairing || changes.consent) {
    state.filtersOk = false
    state.filtersAt = 0
    state.disabledByApp = false
    state.lastError = null
    void ensureFilters(true)
    void reportHello(true)
  }
  if (changes.paused && changes.paused.newValue === true) {
    void sendClear()
  }
  if (changes.paused !== undefined && changes.paused !== null) {
    void reportHello()
  }
  if (changes.controlConsent) {
    if (changes.controlConsent.newValue === true) {
      controlState.lastError = null
      void ensureControlPolling()
    } else {
      stopControlPolling()
      void releaseAutonomousTabs('consent-off')
    }
    void reportHello(true)
  }
  if (changes.pairing && changes.pairing.newValue !== changes.pairing.oldValue) {
    stopControlPolling()
    void releaseAutonomousTabs('pairing-changed')
    controlState.ownedLoaded = false
    controlState.lastError = null
    setTimeout(() => {
      void ensureControlPolling()
    }, 500)
  }
  if (changes.controlOwnedTabs !== undefined && changes.controlOwnedTabs !== null) {
    controlState.ownedLoaded = false
  }
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message === null || typeof message !== 'object') return false

  if (message.type === 'page-snapshot') {
    // 只有当前活跃标签页的推送才会被接受；后台标签页的 DOM 变化直接忽略。
    if (sender.tab && sender.tab.active === true && sender.tab.incognito !== true) {
      void submitPage(sender.tab, message.payload, 'mutation')
    }
    return false
  }

  if (message.type === 'status') {
    void (async () => {
      void reportHello()
      await ensureFilters(false)
      sendResponse(await buildStatus())
    })()
    return true
  }

  if (message.type === 'refresh') {
    void (async () => {
      state.filtersOk = false
      await ensureFilters(true)
      void reportHello(true)
      sendResponse(await buildStatus())
    })()
    return true
  }

  if (message.type === 'set-paused') {
    void (async () => {
      const paused = message.paused === true
      if (paused) await sendClear()
      await chrome.storage.local.set({ paused })
      sendResponse(await buildStatus())
    })()
    return true
  }

  if (message.type === 'set-control-consent') {
    void (async () => {
      const consent = message.consent === true
      await chrome.storage.local.set({ controlConsent: consent })
      if (!consent) {
        stopControlPolling()
        await releaseAutonomousTabs('consent-off')
      } else {
        void ensureControlPolling()
      }
      sendResponse(await buildStatus())
    })()
    return true
  }

  return false
})

chrome.tabs.onActivated.addListener((activeInfo) => {
  // 用户切到她的自主标签页即视为接管：立刻停手、撤下守卫、恢复静音状态。
  void handleTabTakeover(activeInfo.tabId, 'activated')
  setTimeout(() => {
    void extractActive(true)
  }, 300)
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active === true) {
    setTimeout(() => {
      void extractActive(true)
    }, 600)
  }
})

chrome.tabs.onRemoved.addListener(() => {
  setTimeout(() => {
    void extractActive(true)
  }, 600)
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  setTimeout(() => {
    void extractActive(false)
  }, 300)
})

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return
  setTimeout(() => {
    void extractActive(true)
  }, 1200)
})

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return
  setTimeout(() => {
    void extractActive(false)
  }, 500)
})

// 主动浏览的标签页归属：由她打开的标签、以及从她标签页弹出的新标签自动纳入。
let controlOwnedSaveTimer = null

chrome.tabs.onCreated.addListener((tab) => {
  if (tab === null || tab.incognito === true || !Number.isInteger(tab.id)) return
  void loadOwnedTabs().then(async () => {
    const opener = Number(tab.openerTabId)
    // 自主标签页的新弹窗不自动认领：无法可靠验证目的与内容时停止扩大范围。
    if (Number.isInteger(opener) && isAutonomousTab(opener)) return
    if (Number.isInteger(opener) && isOwned(opener)) {
      await ownTab(tab.id, tab)
      return
    }
    if (controlState.expectPopupFromTab === opener) {
      await ownTab(tab.id, tab)
    }
  })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url === undefined && changeInfo.title === undefined) return
  if (!isOwned(tabId)) return
  const record = controlState.owned.find((entry) => entry.tabId === tabId)
  if (record === undefined) return
  if (typeof changeInfo.url === 'string') record.url = changeInfo.url.slice(0, 2000)
  if (typeof changeInfo.title === 'string') record.title = changeInfo.title.slice(0, 300)
  if (controlOwnedSaveTimer !== null) clearTimeout(controlOwnedSaveTimer)
  controlOwnedSaveTimer = setTimeout(() => {
    controlOwnedSaveTimer = null
    void saveOwnedTabs()
  }, 1200)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!isOwned(tabId)) return
  void forgetTab(tabId, true)
})

// MV3 的 service worker 可能在任意事件后重启；除了安装/启动/心跳之外，
// 每次唤醒都尝试恢复在线握手和控制长轮询，不必等到下一条 alarm。
void ensureControlPolling()
void reportHello()
