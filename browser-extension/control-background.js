/**
 * 主动控制的 service worker 部分（由 background.js 通过 importScripts 加载）。
 *
 * 与被动感知的区别：
 * - 只有应用通过 /v1/command 下发的指令才会执行，网页不能触发；
 * - 只操作她自己的标签页（open/restore/popup），用户标签页需显式 adopt；
 * - 不读取 cookie/localStorage，不填写密码/支付字段；
 * - 页面文本只作为指令结果回传，不写入 storage；
 * - 标签页 URL 为了重启后恢复会保存在本地 storage，但不会被记录到日志。
 */
'use strict'

const CONTROL_POLL_WAIT_MS = 25000
const CONTROL_MAX_OWNED_TABS = 12
const CONTROL_MAX_SAVED_TABS = 20
const CONTROL_PROTOCOL_VERSION = 1
/** 本文件发布时的构建标记；只用于诊断运行时版本，不参与权限判断。 */
const CONTROL_BUILD_ID = 'site-neutral-web-2026-10-30.1'
/**
 * 通过轮询参数向应用声明运行时能力。应用据此在投递前拒绝旧扩展
 * 不认识的指令，而不是发出后得到 UNKNOWN_COMMAND。
 */
const CONTROL_SUPPORTED_OPS = Object.freeze([
  'tabs',
  'open',
  'navigate',
  'snapshot',
  'find',
  'click',
  'type',
  'select',
  'key',
  'scroll',
  'wait',
  'tab_switch',
  'tab_close',
  'restore_tabs',
  'back',
  'forward',
  'download',
  'web_open',
  'web_navigate',
  'web_media',
  'web_close'
])
/** 旧版应用仍可能发来的 B 站专用指令；明确拒绝并提示更新，绝不静默转换。 */
const CONTROL_RETIRED_OPS = new Set([
  'bili_open',
  'bili_listing',
  'bili_search',
  'bili_detail',
  'bili_media',
  'bili_pause',
  'bili_stop',
  'bili_close'
])
const CONTROL_INSTANCE_ID = /^[A-Za-z0-9._:-]{1,80}$/
const CONTROL_BLOCKED_HINT = '该页面属于受保护/被排除的站点，主动控制不会读取或操作'
const CONTROL_AUTONOMOUS_OPS = new Set([
  'tabs',
  'snapshot',
  'find',
  'scroll',
  'wait',
  'web_open',
  'web_navigate',
  'web_media',
  'web_close'
])

const controlState = {
  polling: false,
  abort: null,
  lastError: null,
  lastPollAt: 0,
  lastCommandAt: 0,
  lastResultAt: 0,
  connectedAt: 0,
  blockedDomains: [],
  owned: [],
  saved: [],
  ownedLoaded: false,
  expectPopupFromTab: null,
  /** 仅内存的媒体状态回读；不写 storage。 */
  mediaByTab: new Map(),
  /** 浏览器会话标识；storage.session 在浏览器重启后清空。 */
  sessionId: null
}

function controlSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const CONTROL_MIN_WAIT_MS = 2_000
const CONTROL_MAX_WAIT_MS = 30_000

function controlWaitBudget(timeoutMs) {
  return Math.min(CONTROL_MAX_WAIT_MS, Math.max(CONTROL_MIN_WAIT_MS, Number(timeoutMs) || 15_000))
}

/** 一条指令的总等待预算；导航、守卫、候选共用同一个 deadline。 */
function controlDeadline(timeoutMs) {
  return Date.now() + controlWaitBudget(timeoutMs)
}

/** 剩余时间；至少保留一个很小的轮询窗口，避免各阶段重新获得完整超时。 */
function controlRemaining(deadline, maxMs) {
  const limit = Number.isFinite(maxMs) ? maxMs : 10_000
  return Math.max(250, Math.min(limit, deadline - Date.now()))
}

function controlString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * 应用的长轮询响应是 { ok, command } 信封；也接受裸指令对象，
 * 兼容直接返回 { id, op, params } 的旧实现。
 */
function readControlEnvelope(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const nested = payload.command
  if (nested !== null && typeof nested === 'object' && typeof nested.id === 'string') {
    return nested
  }
  if (typeof payload.id === 'string') return payload
  return null
}

function controlOk(result) {
  return { ok: true, result }
}

function controlFail(code, message, extra) {
  return {
    ok: false,
    code,
    error: typeof message === 'string' ? message.slice(0, 300) : String(code),
    ...(extra !== null && typeof extra === 'object' ? { result: extra } : {})
  }
}

/**
 * 失败码到失败阶段。应用和模型据此区分“标签没建”“页面没加载”“解析失败”，
 * 只使用固定枚举。
 */
const CONTROL_FAILURE_STAGES = Object.freeze({
  UNKNOWN_COMMAND: 'dispatch',
  REMOVED_COMMAND: 'dispatch',
  INVALID_COMMAND: 'dispatch',
  COMMAND_ERROR: 'dispatch',
  INVALID_URL: 'preflight',
  INVALID_QUERY: 'preflight',
  INVALID_VIDEO_ID: 'preflight',
  INVALID_PART_ID: 'preflight',
  INVALID_ACTION: 'preflight',
  AUTONOMOUS_RESTRICTED: 'preflight',
  BLOCKED_DESTINATION: 'preflight',
  BLOCKED_DOMAIN: 'preflight',
  INCOGNITO_BLOCKED: 'preflight',
  LOGIN_REQUIRED: 'preflight',
  TAB_LIMIT: 'tab-create',
  TAB_NOT_FOUND: 'preflight',
  TAB_NOT_OWNED: 'preflight',
  TAB_TAKEN_OVER: 'preflight',
  TAB_CLOSED: 'preflight',
  NO_ACTIVE_TAB: 'preflight',
  OPEN_FAILED: 'tab-create',
  CLOSE_FAILED: 'tab-create',
  NAVIGATE_FAILED: 'navigation',
  LOAD_TIMEOUT: 'content-ready',
  CONTENT_UNREACHABLE: 'content-ready',
  UNSUPPORTED_PAGE: 'content-ready',
  SNAPSHOT_FAILED: 'extraction',
  FIND_FAILED: 'extraction',
  PAGE_ACTION_FAILED: 'extraction',
  GUARD_UNAVAILABLE: 'media-guard',
  MUTE_UNAVAILABLE: 'media-guard',
  PLAYBACK_UNCONTROLLED: 'media-guard',
  DOWNLOAD_FAILED: 'dispatch'
})

const CONTROL_RETRYABLE_CODES = new Set(['LOAD_TIMEOUT', 'CONTENT_UNREACHABLE'])

function controlFailureStage(code) {
  return CONTROL_FAILURE_STAGES[code] || 'dispatch'
}

let controlInstanceId = ''

/**
 * 当前浏览器里这个扩展实例的标识。`storage.session` 在 service worker
 * 重启后仍保留；浏览器重启或扩展重载后重新生成。应用据此把指令绑定到
 * 真正接收它的实例，避免多浏览器/多版本时投递给错误的扩展。
 */
async function controlInstance() {
  if (controlInstanceId !== '') return controlInstanceId
  try {
    const stored = await chrome.storage.session.get('controlInstanceId')
    if (
      typeof stored.controlInstanceId === 'string' &&
      CONTROL_INSTANCE_ID.test(stored.controlInstanceId)
    ) {
      controlInstanceId = stored.controlInstanceId
      return controlInstanceId
    }
  } catch {
    /* storage.session 不可用时退化为进程内标识 */
  }
  let generated = ''
  try {
    generated = crypto.randomUUID()
  } catch {
    generated = ''
  }
  if (!CONTROL_INSTANCE_ID.test(generated)) {
    generated = 'sw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  }
  controlInstanceId = generated
  try {
    await chrome.storage.session.set({ controlInstanceId: generated })
  } catch {
    /* 仅内存可用也能继续工作 */
  }
  return controlInstanceId
}

/** 在线握手用的运行期能力事实；不包含任何页面内容。 */
async function controlHelloFacts() {
  return {
    instanceId: await controlInstance(),
    version: chrome.runtime.getManifest().version,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    buildId: CONTROL_BUILD_ID,
    supportedOps: CONTROL_SUPPORTED_OPS
  }
}

function isPrivateControlHost(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map((part) => Number(part))
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
    if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
    if (parts[0] >= 224) return true
    return false
  }
  // 单标签主机名通常是内网地址；主动浏览只针对公开网页。
  if (!host.includes('.')) return true
  return false
}

function controlUrlError(raw, blockedDomains) {
  let url
  try {
    url = new URL(String(raw || ''))
  } catch {
    return '不是有效的网址'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return '只允许 http/https 网页'
  }
  if (isPrivateControlHost(url.hostname)) {
    return '主动浏览只访问公开网页，不访问本机/内网地址'
  }
  const domain = url.hostname.replace(/\.$/, '').toLowerCase()
  const blocked = Array.isArray(blockedDomains) ? blockedDomains : controlState.blockedDomains
  if (matchesAny(domain, blocked)) return CONTROL_BLOCKED_HINT
  return null
}

function readBlockedDomains(params) {
  if (params !== null && typeof params === 'object' && Array.isArray(params.blockedDomains)) {
    controlState.blockedDomains = stringList(params.blockedDomains)
  }
  return controlState.blockedDomains
}

async function ensureControlSessionId() {
  if (controlState.sessionId !== null) return controlState.sessionId
  try {
    const data = await chrome.storage.session.get({ controlSessionId: '' })
    if (typeof data.controlSessionId === 'string' && data.controlSessionId !== '') {
      controlState.sessionId = data.controlSessionId
    } else {
      const id = crypto.randomUUID()
      await chrome.storage.session.set({ controlSessionId: id })
      controlState.sessionId = id
    }
  } catch {
    controlState.sessionId = ''
  }
  return controlState.sessionId
}

async function loadOwnedTabs() {
  if (controlState.ownedLoaded) return
  const data = await chrome.storage.local.get({
    controlOwnedTabs: [],
    controlSavedTabs: []
  })
  controlState.owned = Array.isArray(data.controlOwnedTabs)
    ? data.controlOwnedTabs.filter((entry) => entry !== null && typeof entry === 'object')
    : []
  controlState.saved = Array.isArray(data.controlSavedTabs)
    ? data.controlSavedTabs.filter((entry) => typeof entry === 'string').slice(-CONTROL_MAX_SAVED_TABS)
    : []
  controlState.ownedLoaded = true
}

async function saveOwnedTabs() {
  controlState.owned = controlState.owned
    .filter((entry) => Number.isInteger(entry.tabId))
    .slice(-CONTROL_MAX_OWNED_TABS)
  await chrome.storage.local.set({
    controlOwnedTabs: controlState.owned,
    controlSavedTabs: controlState.saved.slice(-CONTROL_MAX_SAVED_TABS)
  })
}

function isOwned(tabId) {
  return controlState.owned.some((entry) => entry.tabId === tabId)
}

function ownedRecord(tabId) {
  return controlState.owned.find((entry) => entry.tabId === tabId)
}

function isAutonomousTab(tabId) {
  const record = ownedRecord(tabId)
  return record !== undefined && record.autonomous === true
}

function tabIsTakenOver(tabId) {
  const record = ownedRecord(tabId)
  return record !== undefined && record.takenOver === true
}

async function ownTab(tabId, tab, options) {
  if (!Number.isInteger(tabId)) return
  const opts = options !== null && typeof options === 'object' ? options : {}
  if (isOwned(tabId)) {
    const record = ownedRecord(tabId)
    if (tab !== undefined && tab !== null) {
      record.windowId = tab.windowId
      record.url = controlString(tab.url, 2000)
      record.title = controlString(tab.title, 300)
    }
    if (opts.autonomous === true) record.autonomous = true
    if (opts.featureTab === true) record.featureTab = true
    record.guardReady = false
  } else {
    controlState.owned.push({
      tabId,
      windowId: tab !== undefined && tab !== null ? tab.windowId : null,
      url: tab !== undefined && tab !== null ? controlString(tab.url, 2000) : '',
      title: tab !== undefined && tab !== null ? controlString(tab.title, 300) : '',
      createdAt: Date.now(),
      autonomous: opts.autonomous === true,
      featureTab: opts.featureTab === true,
      sessionId: opts.autonomous === true ? await ensureControlSessionId() : null,
      takenOver: false,
      takenOverAt: null,
      guardReady: false,
      guardAt: null,
      mutedByFeature: false
    })
  }
  await saveOwnedTabs()
}

/** 用户接管：停止一切自动操作，撤下守卫并恢复被本功能改过的标签静音。 */
async function handleTabTakeover(tabId, reason) {
  await loadOwnedTabs()
  const record = ownedRecord(tabId)
  if (record === undefined || record.autonomous !== true) return false
  if (record.takenOver !== true) {
    record.takenOver = true
    record.takenOverAt = Date.now()
    record.guardReady = false
    await saveOwnedTabs()
  }
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: 'mingyue-web-guard', op: 'standdown' },
      { frameId: 0 }
    )
  } catch {
    /* 内容脚本可能已不存在 */
  }
  await unmuteIfMutedByFeature(tabId)
  controlState.mediaByTab.delete(tabId)
  void reason
  return true
}

async function unmuteIfMutedByFeature(tabId) {
  const record = ownedRecord(tabId)
  if (record === undefined || record.mutedByFeature !== true) return false
  try {
    await chrome.tabs.update(tabId, { muted: false })
  } catch {
    return false
  }
  record.mutedByFeature = false
  await saveOwnedTabs()
  return true
}

/**
 * 撤销授权、浏览器启动或扩展更新后，不再信任旧的自主标签页。
 * 不关闭页面（可能是用户正在看的内容），只解除归属、撤下守卫并恢复静音。
 */
async function releaseAutonomousTabs(reason) {
  await loadOwnedTabs()
  const targets = controlState.owned.filter((entry) => entry.autonomous === true)
  for (const record of targets) {
    try {
      await chrome.tabs.sendMessage(
        record.tabId,
        { type: 'mingyue-web-guard', op: 'standdown' },
        { frameId: 0 }
      )
    } catch {
      /* ignore */
    }
    await unmuteIfMutedByFeature(record.tabId)
    controlState.mediaByTab.delete(record.tabId)
  }
  if (targets.length === 0) return 0
  const ids = new Set(targets.map((entry) => entry.tabId))
  controlState.owned = controlState.owned.filter((entry) => ids.has(entry.tabId) === false)
  await saveOwnedTabs()
  void reason
  return targets.length
}

async function releaseAutonomousTabsOnStartup() {
  return releaseAutonomousTabs('startup')
}

function isAutonomousTabAllowedOp(op) {
  return CONTROL_AUTONOMOUS_OPS.has(op)
}

/**
 * 自主来源只允许受限只读动作；自主标签页也拒绝通用导航、点击、切换与关闭。
 * 这是实现端约束，不依赖模型自觉。
 */
async function enforceAutonomousCommand(op, params) {
  if (params !== null && params.autonomous === true && !isAutonomousTabAllowedOp(op)) {
    return controlFail(
      'AUTONOMOUS_RESTRICTED',
      '自主浏览只允许读取、滚动、页面观察和停止播放，不能执行该动作'
    )
  }
  const tabId = Number(params === null || params === undefined ? NaN : params.tabId)
  if (!Number.isInteger(tabId) || tabId < 0) return null
  await loadOwnedTabs()
  const record = ownedRecord(tabId)
  if (record === undefined) return null
  if (record.takenOver === true) {
    return controlFail('TAB_TAKEN_OVER', '你已接管这个标签页，她不会继续操作它')
  }
  if (record.autonomous === true && !isAutonomousTabAllowedOp(op)) {
    return controlFail(
      'AUTONOMOUS_RESTRICTED',
      '这是她的自主浏览标签页，只能读取和停止，不能导航、点击、切换或关闭'
    )
  }
  return null
}

async function forgetTab(tabId, saveUrl) {
  const record = controlState.owned.find((entry) => entry.tabId === tabId)
  // 自主浏览标签不进入“可恢复标签”列表；它只属于一次受限会话。
  if (record !== undefined && record.autonomous === true) saveUrl = false
  if (record !== undefined && saveUrl === true && record.url !== '') {
    controlState.saved.push(record.url)
    controlState.saved = controlState.saved.slice(-CONTROL_MAX_SAVED_TABS)
  }
  controlState.owned = controlState.owned.filter((entry) => entry.tabId !== tabId)
  await saveOwnedTabs()
}

/**
 * 浏览器重启后 tabId 会变。优先按原 id 匹配，失败时用保存的 URL 重新认领，
 * 仍找不到的记录转入可恢复列表，而不是静默丢失。
 */
async function reconcileOwnedTabs() {
  await loadOwnedTabs()
  let tabs = []
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return
  }
  const byId = new Map(tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => [tab.id, tab]))
  const taken = new Set()
  const next = []
  const sessionId = await ensureControlSessionId()
  for (const record of controlState.owned) {
    // 浏览器重启后 tabId/storage.session 都会变。自主标签必须按本次浏览器会话
    // 重新验证，不能只凭旧 tabId 或 URL 重新获得所有权。
    if (record.autonomous === true && (sessionId === '' || record.sessionId !== sessionId)) {
      continue
    }
    if (Number.isInteger(record.tabId) && byId.has(record.tabId)) {
      const tab = byId.get(record.tabId)
      taken.add(record.tabId)
      next.push({
        ...record,
        windowId: tab.windowId,
        url: controlString(tab.url, 2000),
        title: controlString(tab.title, 300)
      })
      continue
    }
    const wanted = controlString(record.url, 2000)
    if (wanted !== '') {
      const match = tabs.find(
        (tab) =>
          Number.isInteger(tab.id) &&
          !taken.has(tab.id) &&
          tab.incognito !== true &&
          tab.url === wanted
      )
      if (match !== undefined) {
        taken.add(match.id)
        next.push({
          ...record,
          tabId: match.id,
          windowId: match.windowId,
          url: controlString(match.url, 2000),
          title: controlString(match.title, 300)
        })
        continue
      }
      controlState.saved.push(wanted)
    }
  }
  controlState.owned = next.slice(-CONTROL_MAX_OWNED_TABS)
  controlState.saved = controlState.saved.slice(-CONTROL_MAX_SAVED_TABS)
  await saveOwnedTabs()
}

function tabSummary(tab) {
  const blocked =
    tab.url !== undefined && controlUrlError(tab.url, controlState.blockedDomains) !== null
  const record = ownedRecord(tab.id)
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    active: tab.active === true,
    owned: record !== undefined,
    ...(record === undefined
      ? {}
      : {
          autonomous: record.autonomous === true,
          takenOver: record.takenOver === true,
          guardReady: record.guardReady === true
        }),
    status: controlString(tab.status, 20),
    ...(blocked
      ? { title: '(受保护页面)', protected: true }
      : {
          title: controlString(tab.title, 300),
          url: controlString(tab.url, 2000)
        })
  }
}

async function getTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return null
  try {
    const tab = await chrome.tabs.get(tabId)
    return tab === undefined ? null : tab
  } catch {
    return null
  }
}

async function resolveTabForCommand(params, ownedOnly) {
  await loadOwnedTabs()
  const requested = Number(params.tabId)
  let tab = null
  if (Number.isInteger(requested) && requested >= 0) {
    tab = await getTab(requested)
    if (tab === null) return { error: controlFail('TAB_NOT_FOUND', '标签页不存在或已关闭') }
    if (ownedOnly === true && !isOwned(tab.id)) {
      return {
        error: controlFail('TAB_NOT_OWNED', '这不是她的浏览标签页；需要用户标签页时请显式采用')
      }
    }
  } else {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    tab = tabs[0]
    if (tab === undefined) return { error: controlFail('NO_ACTIVE_TAB', '当前没有可用标签页') }
    if (ownedOnly === true && !isOwned(tab.id) && params.adopt !== true) {
      return { error: controlFail('TAB_NOT_OWNED', '当前标签页不是她的浏览标签页') }
    }
    if (params.adopt === true) await ownTab(tab.id, tab)
  }
  if (tab.incognito === true) {
    return { error: controlFail('INCOGNITO_BLOCKED', '无痕窗口不参与主动浏览') }
  }
  const urlError = controlUrlError(tab.url, readBlockedDomains(params))
  if (urlError !== null) {
    return { error: controlFail('BLOCKED_DOMAIN', urlError, { tabId: tab.id }) }
  }
  return { tab }
}

function frameIdOf(params) {
  const value = Number(params.frameId)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

async function sendControl(tabId, frameId, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId })
}

async function readContentState(tabId, frameId) {
  try {
    const result = await sendControl(tabId, frameId, { type: 'mingyue-control', op: 'ping' })
    return result !== null && typeof result === 'object' && result.ok === true ? result : null
  } catch {
    return null
  }
}

async function pingContent(tabId, frameId) {
  return (await readContentState(tabId, frameId)) !== null
}

async function ensureContent(tabId, frameId) {
  if (await pingContent(tabId, frameId)) return true
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      injectImmediately: true,
      files: ['control.js']
    })
  } catch {
    return false
  }
  await controlSleep(80)
  return pingContent(tabId, frameId)
}

async function waitForTabReady(tabId, timeoutMs) {
  const timeout = Math.min(30_000, Math.max(1000, Number(timeoutMs) || 15_000))
  const started = Date.now()
  let tab = null
  while (Date.now() - started < timeout) {
    tab = await getTab(tabId)
    if (tab === null) return { ready: false, code: 'TAB_CLOSED', tab: null }
    if (tab.status === 'complete') {
      if (await ensureContent(tabId, 0)) {
        return { ready: true, tab }
      }
      return { ready: false, code: 'UNSUPPORTED_PAGE', tab }
    }
    await controlSleep(200)
  }
  return { ready: false, code: 'LOAD_TIMEOUT', tab }
}

/** 只探测顶层文档身份和解析状态，不读取正文，也不等待 document_idle。 */
async function readWebDocument(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      injectImmediately: true,
      func: () => ({
        url: location.href,
        timeOrigin: performance.timeOrigin,
        readyState: document.readyState
      })
    })
    return results[0]?.result ?? null
  } catch {
    return null
  }
}

/**
 * 主动网页读取等 DOM 可观察，不等图片/广告等所有资源完成。
 * 先确认新文档已提交；同文档锚点跳转必须与请求目标完全一致。
 * 旧文档探测失败时保守要求地址已改变，避免将旧页当成同址刷新结果。
 */
async function waitForWebTabReady(tabId, timeoutMs, navigation) {
  const timeout = Math.min(30_000, Math.max(1000, Number(timeoutMs) || 15_000))
  const started = Date.now()
  let tab = null
  let contentUnavailable = false
  while (Date.now() - started < timeout) {
    tab = await getTab(tabId)
    if (tab === null) return { ready: false, code: 'TAB_CLOSED', tab: null }
    const blocked = autonomousWebUrlError(tab.url, navigation.blocked)
    if (!tab.pendingUrl && blocked === null) {
      const doc = await readWebDocument(tabId)
      const previous = navigation.previous
      const sameDocumentTarget = navigation.target !== navigation.previousUrl &&
        navigation.target.split('#')[0] === navigation.previousUrl.split('#')[0]
      const committed = doc !== null && doc.url === tab.url && (
        previous !== null
          ? doc.timeOrigin !== previous.timeOrigin ||
            (sameDocumentTarget && doc.url === navigation.target)
          : doc.url !== navigation.previousUrl
      )
      if (committed && (doc.readyState === 'interactive' || doc.readyState === 'complete')) {
        if (await ensureContent(tabId, 0)) {
          const content = await readContentState(tabId, 0)
          const confirmed = await readWebDocument(tabId)
          if (content !== null && typeof content.pageId === 'string' &&
              content.url === doc.url && confirmed?.timeOrigin === doc.timeOrigin &&
              confirmed?.url === doc.url) {
            return { ready: true, tab, pageId: content.pageId, url: doc.url }
          }
        }
        contentUnavailable = true
      }
    } else if (!tab.pendingUrl && tab.url !== navigation.previousUrl && blocked !== null) {
      // 由调用方按最终地址报告登录/敏感目标，不能注入内容脚本。
      return { ready: false, code: 'BLOCKED_DESTINATION', tab }
    }
    await controlSleep(200)
  }
  return { ready: false, code: contentUnavailable ? 'CONTENT_UNREACHABLE' : 'LOAD_TIMEOUT', tab }
}

async function listControlFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId })
    if (!Array.isArray(frames)) return []
    return frames
      .filter((frame) => typeof frame.url === 'string' && /^https?:/i.test(frame.url))
      .slice(0, 30)
      .map((frame) => ({
        frameId: frame.frameId,
        url: frame.url.slice(0, 2000)
      }))
  } catch {
    return []
  }
}

function sanitizeElements(raw, frameId) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw.slice(0, 160)) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.ref !== 'string' || item.ref === '') continue
    const role = controlString(item.role, 40)
    const name = controlString(item.name, 300)
    // 双保险：内容脚本已过滤密码字段，这里再拦截明显的凭据类目标。
    if (/password|passwd|otp|one-time-code/i.test(role + ' ' + name)) continue
    out.push({
      ref: item.ref,
      role,
      name,
      tag: controlString(item.tag, 20),
      ...(typeof item.value === 'string' ? { value: item.value.slice(0, 300) } : {}),
      ...(typeof item.checked === 'boolean' ? { checked: item.checked } : {}),
      ...(item.disabled === true ? { disabled: true } : {}),
      ...(typeof item.href === 'string' ? { href: item.href.slice(0, 2000) } : {}),
      frameId
    })
  }
  return out
}

function sanitizeObservation(raw, tabId, frameId) {
  if (raw === null || typeof raw !== 'object') return null
  if (raw.ok === false) return null
  return {
    tabId,
    frameId,
    pageId: controlString(raw.pageId, 80),
    pageVersion: Number.isInteger(raw.pageVersion) ? raw.pageVersion : 0,
    url: controlString(raw.url, 2000),
    title: controlString(raw.title, 300),
    readyState: controlString(raw.readyState, 30),
    capturedAt: Number.isFinite(Number(raw.capturedAt)) ? Number(raw.capturedAt) : Date.now(),
    ...(typeof raw.changed === 'boolean' ? { changed: raw.changed } : {}),
    ...(typeof raw.value === 'string' ? { value: raw.value.slice(0, 300) } : {})
  }
}

async function takeSnapshot(tab, frameId, params) {
  if (!(await ensureContent(tab.id, frameId))) {
    return {
      error: controlFail('UNSUPPORTED_PAGE', '该页面不能读取（可能是浏览器内置页面或 PDF）')
    }
  }
  let raw = null
  try {
    raw = await sendControl(tab.id, frameId, {
      type: 'mingyue-control',
      op: 'snapshot',
      options: {
        maxElements: Math.min(160, Math.max(10, Number(params.maxElements) || 80)),
        maxChars: Math.min(20_000, Math.max(500, Number(params.maxChars) || 6000))
      }
    })
  } catch {
    return { error: controlFail('CONTENT_UNREACHABLE', '页面没有响应，可能仍在加载或已关闭') }
  }
  if (raw === null || typeof raw !== 'object' || raw.ok === false) {
    return { error: controlFail('SNAPSHOT_FAILED', '页面结构读取失败') }
  }
  const url = controlString(raw.url, 2000)
  const urlError = controlUrlError(url !== '' ? url : tab.url, controlState.blockedDomains)
  if (urlError !== null) {
    return { error: controlFail('BLOCKED_DOMAIN', urlError, { tabId: tab.id }) }
  }
  const frames = await listControlFrames(tab.id)
  return {
    snapshot: {
      tabId: tab.id,
      frameId,
      pageId: controlString(raw.pageId, 80),
      pageVersion: Number.isInteger(raw.pageVersion) ? raw.pageVersion : 0,
      url,
      title: controlString(raw.title, 300),
      readyState: controlString(raw.readyState, 30),
      capturedAt: Date.now(),
      elements: sanitizeElements(raw.elements, frameId),
      text: controlString(raw.text, 20_000),
      headings: Array.isArray(raw.headings)
        ? raw.headings
            .filter((item) => typeof item === 'string')
            .slice(0, 20)
            .map((item) => item.slice(0, 300))
        : [],
      truncated: raw.truncated === true,
      hasMore: raw.truncated === true,
      frames
    }
  }
}

async function postControlResult(pairing, commandId, result) {
  const ok = result.ok === true
  const code = typeof result.code === 'string' ? result.code.slice(0, 60) : ''
  const body = {
    id: commandId,
    ok,
    instance: await controlInstance(),
    ...(code !== '' ? { code } : {}),
    // 失败时保留阶段与是否值得重试；成功时不伪造 stage。
    ...(ok
      ? {}
      : {
          stage: controlFailureStage(code),
          retryable: CONTROL_RETRYABLE_CODES.has(code)
        }),
    ...(typeof result.error === 'string' ? { error: result.error.slice(0, 300) } : {}),
    ...(result.result !== undefined ? { result: result.result } : {})
  }
  try {
    const response = await fetch(pairing.base + '/v1/result', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + pairing.token
      },
      body: JSON.stringify(body),
      cache: 'no-store'
    })
    if (response.status === 401) {
      controlState.lastError = '配对码无效，请在设置页重新配对'
    } else if (!response.ok) {
      controlState.lastError = '控制结果回传失败（' + response.status + '）'
    } else {
      controlState.lastResultAt = Date.now()
      controlState.lastError = null
    }
  } catch {
    controlState.lastError = '无法把控制结果传回桌宠'
  }
}

// ---------------------------------------------------------------------------
// 自主浏览的通用守卫、静音与媒体回读
// ---------------------------------------------------------------------------

async function readWebGuardStatus(tabId) {
  let response = null
  try {
    response = await chrome.tabs.sendMessage(
      tabId,
      { type: 'mingyue-web-guard', op: 'status' },
      { frameId: 0 }
    )
  } catch {
    return null
  }
  if (response === null || typeof response !== 'object' || response.ok !== true) return null
  return {
    allowed: response.allowed === true,
    status: response.status !== null && typeof response.status === 'object' ? response.status : null
  }
}

async function ensureWebGuard(tabId) {
  const existing = await readWebGuardStatus(tabId)
  if (existing !== null && existing.allowed === true) return existing
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      injectImmediately: true,
      files: ['web-guard.js']
    })
  } catch {
    return existing
  }
  await controlSleep(200)
  return readWebGuardStatus(tabId)
}

async function readWebMedia(tabId) {
  const tab = await getTab(tabId)
  if (tab === null) return null
  const record = ownedRecord(tabId)
  const guard = await readWebGuardStatus(tabId)
  const media = {
    tabId,
    tabMuted: tab.mutedInfo !== undefined && tab.mutedInfo.muted === true,
    audible: tab.audible === true,
    mutedByFeature: record !== undefined && record.mutedByFeature === true,
    takenOver: record !== undefined && record.takenOver === true,
    guardReady: guard !== null && guard.allowed === true,
    guard: guard === null ? null : guard.status
  }
  controlState.mediaByTab.set(tabId, media)
  return media
}

async function pauseWebMedia(tabId) {
  const guard = await ensureWebGuard(tabId)
  if (guard === null || guard.allowed !== true) {
    return { ok: false, code: 'GUARD_UNAVAILABLE', media: await readWebMedia(tabId) }
  }
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: 'mingyue-web-guard', op: 'pause' },
      { frameId: 0 }
    )
  } catch {
    /* 回读会暴露失败 */
  }
  await controlSleep(250)
  const media = await readWebMedia(tabId)
  const playingCount =
    media !== null && media.guard !== null && Number.isFinite(Number(media.guard.playingCount))
      ? Number(media.guard.playingCount)
      : 0
  if (playingCount > 0) {
    return { ok: false, code: 'PLAYBACK_UNCONTROLLED', media }
  }
  if (media !== null && media.audible === true && media.tabMuted !== true) {
    return { ok: false, code: 'PLAYBACK_UNCONTROLLED', media }
  }
  return { ok: true, media }
}

/** 普通网页的自主标签页必须同时满足：已静音、守卫在线、媒体已暂停。 */
async function ensureWebAutonomousReady(tabId) {
  const muted = await setFeatureMuted(tabId, true)
  if (!muted.ok) {
    return { ok: false, code: 'MUTE_UNAVAILABLE', media: await readWebMedia(tabId) }
  }
  const paused = await pauseWebMedia(tabId)
  if (!paused.ok) return paused
  return { ok: true, media: paused.media }
}

/**
 * 自主浏览统一使用通用 web-guard；守卫失败时宁可停止，
 * 也不在无法确认不播放的页面上继续读取。
 */
async function ensureAutonomousPageReady(tabId) {
  return ensureWebAutonomousReady(tabId)
}

const AUTONOMOUS_PRIVATE_PATH =
  /(?:^|\/)(?:login|log-in|signin|sign-in|signup|register|auth|oauth|account|accounts|profile|settings|messages|message|chat|inbox|mail|dm|notifications|orders|purchase|wallet|billing|admin|wp-admin|user|users)(?:\/|$)/i

function autonomousWebUrlError(raw, blockedDomains) {
  const basic = controlUrlError(raw, blockedDomains)
  if (basic !== null) return basic
  let url
  try {
    url = new URL(String(raw || ''))
  } catch {
    return '不是有效的网址'
  }
  if (url.protocol !== 'https:') return '自主浏览只打开 https 网页'
  if (url.username !== '' || url.password !== '' || url.port !== '') {
    return '网址不能包含账号、密码或端口'
  }
  if (AUTONOMOUS_PRIVATE_PATH.test(url.pathname)) {
    return '自主浏览不打开登录、账号或私信页面'
  }
  return null
}

async function setWebMediaAction(tabId, action) {
  if (action === 'mute') {
    const muted = await setFeatureMuted(tabId, true)
    if (!muted.ok) return { ok: false, code: 'MUTE_UNAVAILABLE', media: await readWebMedia(tabId) }
    const guard = await ensureWebGuard(tabId)
    if (guard !== null && guard.allowed === true) {
      try {
        await chrome.tabs.sendMessage(
          tabId,
          { type: 'mingyue-web-guard', op: 'mute' },
          { frameId: 0 }
        )
      } catch {
        /* 忽略；回读兜底 */
      }
    }
    await controlSleep(150)
    const media = await readWebMedia(tabId)
    if (media === null || media.tabMuted !== true) {
      return { ok: false, code: 'MUTE_UNAVAILABLE', media }
    }
    if (media.audible === true) {
      return { ok: false, code: 'PLAYBACK_UNCONTROLLED', media }
    }
    return { ok: true, media }
  }
  if (action === 'pause') {
    const muted = await setFeatureMuted(tabId, true)
    if (!muted.ok) return { ok: false, code: 'MUTE_UNAVAILABLE', media: await readWebMedia(tabId) }
    return pauseWebMedia(tabId)
  }
  const media = await readWebMedia(tabId)
  if (media === null) return { ok: false, code: 'GUARD_UNAVAILABLE', media: null }
  if (media.takenOver === true) return { ok: false, code: 'TAB_TAKEN_OVER', media }
  if (media.guardReady !== true) return { ok: false, code: 'GUARD_UNAVAILABLE', media }
  if (media.tabMuted !== true) return { ok: false, code: 'MUTE_UNAVAILABLE', media }
  if (media.audible === true) return { ok: false, code: 'PLAYBACK_UNCONTROLLED', media }
  return { ok: true, media }
}

async function setFeatureMuted(tabId, muted) {
  const before = await getTab(tabId)
  const wasMuted = before !== null && before.mutedInfo !== undefined && before.mutedInfo.muted === true
  try {
    await chrome.tabs.update(tabId, { muted: muted === true })
  } catch {
    return { ok: false, actual: wasMuted }
  }
  const after = await getTab(tabId)
  const actual = after !== null && after.mutedInfo !== undefined && after.mutedInfo.muted === true
  const record = ownedRecord(tabId)
  if (record !== undefined) {
    if (muted === true && actual === true && wasMuted === false) {
      record.mutedByFeature = true
      await saveOwnedTabs()
    } else if (muted !== true && actual === false) {
      record.mutedByFeature = false
      await saveOwnedTabs()
    }
  }
  return { ok: actual === (muted === true), actual }
}

/** 导航前/后都要满足：她的标签已静音，守卫在线，媒体已暂停。 */


// ---------------------------------------------------------------------------
// 具体指令
// ---------------------------------------------------------------------------

async function commandTabs(params) {
  await reconcileOwnedTabs()
  const tabs = await chrome.tabs.query({})
  const visible = tabs
    .filter((tab) => Number.isInteger(tab.id) && tab.incognito !== true)
    .slice(0, 60)
    .map(tabSummary)
  void params
  return controlOk({ tabs: visible, ownedCount: controlState.owned.length })
}

async function commandOpen(params) {
  const blocked = readBlockedDomains(params)
  let target = controlString(params.url, 4000)
  if (target === '' && typeof params.query === 'string') {
    const template =
      controlString(params.searchUrl, 1000) || 'https://www.bing.com/search?q={query}'
    target = template.replace('{query}', encodeURIComponent(params.query.slice(0, 500)))
  }
  const urlError = controlUrlError(target, blocked)
  if (urlError !== null) return controlFail('INVALID_URL', urlError)
  await loadOwnedTabs()
  const maxTabs = Math.min(12, Math.max(1, Number(params.maxTabs) || 12))
  if (controlState.owned.length >= maxTabs) {
    return controlFail(
      'TAB_LIMIT',
      '她已经打开较多标签页了；先关闭不用的，再打开新的。'
    )
  }
  const tab = await chrome.tabs.create({
    url: target,
    active: params.active === true
  })
  if (tab === null || !Number.isInteger(tab.id)) {
    return controlFail('OPEN_FAILED', '浏览器没有创建标签页')
  }
  await ownTab(tab.id, tab)
  const ready = await waitForTabReady(tab.id, params.timeoutMs)
  const current = await getTab(tab.id)
  if (current === null) return controlFail('TAB_CLOSED', '标签页刚打开就被关闭')
  const afterUrlError = controlUrlError(current.url, blocked)
  if (afterUrlError !== null) {
    try {
      await chrome.tabs.remove(tab.id)
    } catch {
      /* 关闭失败时至少不再操作 */
    }
    await forgetTab(tab.id, false)
    return controlFail('BLOCKED_DESTINATION', afterUrlError, { tabId: tab.id })
  }
  let snapshot = null
  if (params.includeSnapshot !== false) {
    const observed = await takeSnapshot(current, frameIdOf(params), {
      maxElements: params.maxElements,
      maxChars: params.maxChars
    })
    if (observed.snapshot !== undefined) snapshot = observed.snapshot
  }
  return controlOk({
    tab: tabSummary(current),
    ready: ready.ready === true,
    ...(ready.ready === true ? {} : { code: ready.code }),
    ...(snapshot !== null ? { observation: snapshot } : {})
  })
}

async function commandNavigate(params) {
  const resolved = await resolveTabForCommand(params, params.adopt !== true)
  if (resolved.error !== undefined) return resolved.error
  const tab = resolved.tab
  if (params.adopt === true) await ownTab(tab.id, tab)
  const blocked = readBlockedDomains(params)
  let target = controlString(params.url, 4000)
  if (target === '' && typeof params.query === 'string') {
    const template =
      controlString(params.searchUrl, 1000) || 'https://www.bing.com/search?q={query}'
    target = template.replace('{query}', encodeURIComponent(params.query.slice(0, 500)))
  }
  const urlError = controlUrlError(target, blocked)
  if (urlError !== null) return controlFail('INVALID_URL', urlError)
  try {
    await chrome.tabs.update(tab.id, { url: target })
  } catch {
    return controlFail('NAVIGATE_FAILED', '浏览器拒绝跳转到该网址')
  }
  const ready = await waitForTabReady(tab.id, params.timeoutMs)
  const current = await getTab(tab.id)
  if (current === null) return controlFail('TAB_CLOSED', '标签页在跳转时被关闭')
  const afterUrlError = controlUrlError(current.url, blocked)
  if (afterUrlError !== null) {
    return controlFail('BLOCKED_DESTINATION', afterUrlError, { tabId: tab.id })
  }
  if (isOwned(tab.id)) await ownTab(tab.id, current)
  let snapshot = null
  if (params.includeSnapshot !== false) {
    const observed = await takeSnapshot(current, frameIdOf(params), {
      maxElements: params.maxElements,
      maxChars: params.maxChars
    })
    if (observed.snapshot !== undefined) snapshot = observed.snapshot
  }
  return controlOk({
    tab: tabSummary(current),
    ready: ready.ready === true,
    ...(ready.ready === true ? {} : { code: ready.code }),
    ...(snapshot !== null ? { observation: snapshot } : {})
  })
}

async function commandWebOpen(params) {
  const blocked = readBlockedDomains(params)
  const target = controlString(params.url, 2000)
  const urlError = autonomousWebUrlError(target, blocked)
  if (urlError !== null) return controlFail('INVALID_URL', urlError)
  await loadOwnedTabs()
  const maxTabs = Math.min(2, Math.max(1, Number(params.maxTabs) || 2))
  const autonomousCount = controlState.owned.filter((entry) => entry.autonomous === true).length
  if (autonomousCount >= maxTabs) {
    return controlFail('TAB_LIMIT', '这次的主动浏览标签页已经达到上限；先结束当前浏览。')
  }
  let tab = null
  try {
    // chrome.tabs.create 不接受 muted 属性（会直接抛参数错误）；先建后台标签，
    // 用 tabs.update 静音成功后再导航，避免页面在守卫就绪前出声。
    tab = await chrome.tabs.create({ url: 'about:blank', active: false })
  } catch {
    return controlFail('OPEN_FAILED', '浏览器没有创建主动浏览标签页')
  }
  if (tab === null || !Number.isInteger(tab.id)) {
    return controlFail('OPEN_FAILED', '浏览器没有创建主动浏览标签页')
  }
  const tabId = tab.id
  await ownTab(tabId, tab, { autonomous: true })
  const muted = await setFeatureMuted(tabId, true)
  if (!muted.ok) {
    await closeAutonomousTabQuietly(tabId)
    return controlFail('MUTE_UNAVAILABLE', '无法先静音主动浏览标签页，已停止')
  }
  try {
    await chrome.tabs.update(tabId, { url: target, active: false })
  } catch {
    await closeAutonomousTabQuietly(tabId)
    return controlFail('NAVIGATE_FAILED', '浏览器拒绝跳转到该网址')
  }
  const ready = await waitForWebTabReady(tabId, params.timeoutMs, {
    previous: null, previousUrl: 'about:blank', target, blocked
  })
  const current = await getTab(tabId)
  if (current === null) return controlFail('TAB_CLOSED', '标签页刚打开就被关闭')
  const afterUrlError = autonomousWebUrlError(current.url, blocked)
  if (afterUrlError !== null) {
    await closeAutonomousTabQuietly(tabId)
    return controlFail('BLOCKED_DESTINATION', afterUrlError, { tabId })
  }
  if (ready.ready !== true) {
    await closeAutonomousTabQuietly(tabId)
    return controlFail(ready.code || 'LOAD_TIMEOUT', '页面没有在等待时间内变为可读取状态')
  }
  const guard = await ensureAutonomousPageReady(tabId)
  if (!guard.ok) {
    await closeAutonomousTabQuietly(tabId)
    return controlFail(guard.code || 'GUARD_UNAVAILABLE', '无法确认静音和不播放，已停止', {
      tabId
    })
  }
  const observed = await takeSnapshot(current, frameIdOf(params), {
    maxElements: params.maxElements,
    maxChars: params.maxChars
  })
  if (observed.snapshot?.pageId !== ready.pageId || observed.snapshot?.url !== ready.url) {
    await closeAutonomousTabQuietly(tabId)
    return controlFail('CONTENT_UNREACHABLE', '页面读取失败或已跳转，请重新观察')
  }
  return controlOk({
    tab: tabSummary(current),
    ready: true,
    media: guard.media,
    ...(observed.snapshot !== undefined ? { observation: observed.snapshot } : {})
  })
}

async function commandWebNavigate(params) {
  const resolved = await resolveTabForCommand(params, true)
  if (resolved.error !== undefined) return resolved.error
  const tab = resolved.tab
  const record = ownedRecord(tab.id)
  if (record === undefined || record.autonomous !== true) {
    return controlFail('AUTONOMOUS_RESTRICTED', '只能在她自己的主动浏览标签页内跳转')
  }
  const blocked = readBlockedDomains(params)
  const target = controlString(params.url, 2000)
  const urlError = autonomousWebUrlError(target, blocked)
  if (urlError !== null) return controlFail('INVALID_URL', urlError)
  const muted = await setFeatureMuted(tab.id, true)
  if (!muted.ok) {
    return controlFail('MUTE_UNAVAILABLE', '无法静音她的标签页，已停止跳转', {
      tabId: tab.id
    })
  }
  const previous = await readWebDocument(tab.id)
  try {
    await chrome.tabs.update(tab.id, { url: target, active: false })
  } catch {
    return controlFail('NAVIGATE_FAILED', '浏览器拒绝跳转到该网址', { tabId: tab.id })
  }
  const ready = await waitForWebTabReady(tab.id, params.timeoutMs, {
    previous, previousUrl: tab.url, target, blocked
  })
  const current = await getTab(tab.id)
  if (current === null) return controlFail('TAB_CLOSED', '标签页在跳转时被关闭')
  const afterUrlError = autonomousWebUrlError(current.url, blocked)
  if (afterUrlError !== null) {
    return controlFail('BLOCKED_DESTINATION', afterUrlError, { tab: tabSummary(current) })
  }
  if (ready.ready !== true) {
    return controlFail(ready.code || 'LOAD_TIMEOUT', '页面没有在等待时间内变为可读取状态', {
      tab: tabSummary(current)
    })
  }
  const guard = await ensureAutonomousPageReady(tab.id)
  if (!guard.ok) {
    return controlFail(guard.code || 'GUARD_UNAVAILABLE', '无法确认静音和不播放，已停止', {
      tab: tabSummary(current)
    })
  }
  await ownTab(tab.id, current, { autonomous: true })
  const observed = await takeSnapshot(current, frameIdOf(params), {
    maxElements: params.maxElements,
    maxChars: params.maxChars
  })
  if (observed.snapshot?.pageId !== ready.pageId || observed.snapshot?.url !== ready.url) {
    return controlFail('CONTENT_UNREACHABLE', '页面读取失败或已跳转，请重新观察', {
      tab: tabSummary(current)
    })
  }
  return controlOk({
    tab: tabSummary(current),
    ready: true,
    media: guard.media,
    ...(observed.snapshot !== undefined ? { observation: observed.snapshot } : {})
  })
}

async function commandWebClose(params) {
  await loadOwnedTabs()
  const tabId = Number(params.tabId)
  const record = Number.isInteger(tabId) && tabId >= 0 ? ownedRecord(tabId) : undefined
  if (record === undefined || record.autonomous !== true) {
    return controlFail('TAB_NOT_OWNED', '这不是她的主动浏览标签页')
  }
  if (record.takenOver === true) {
    return controlFail('TAB_TAKEN_OVER', '你已接管这个标签页，她不会关闭它')
  }
  const tab = await getTab(tabId)
  if (tab === null) {
    await forgetTab(tabId, false)
    return controlOk({ closed: false, missing: true, tabId })
  }
  try {
    await chrome.tabs.remove(tabId)
  } catch {
    return controlFail('CLOSE_FAILED', '浏览器拒绝关闭她的浏览标签页')
  }
  await forgetTab(tabId, false)
  return controlOk({ closed: true, tabId })
}

async function commandWebMedia(params) {
  const resolved = await resolveTabForCommand(params, true)
  if (resolved.error !== undefined) return resolved.error
  const record = ownedRecord(resolved.tab.id)
  if (record === undefined || record.autonomous !== true) {
    return controlFail('AUTONOMOUS_RESTRICTED', '这不是她的主动浏览标签页')
  }
  const action = controlString(params.action, 10) || 'status'
  if (action !== 'status' && action !== 'pause' && action !== 'mute') {
    return controlFail('INVALID_COMMAND', '未知的媒体动作')
  }
  const result = await setWebMediaAction(resolved.tab.id, action)
  if (!result.ok) {
    return controlFail(result.code || 'GUARD_UNAVAILABLE', '媒体状态无法确认', {
      media: result.media
    })
  }
  return controlOk({ media: result.media })
}

async function commandSnapshot(params) {
  const resolved = await resolveTabForCommand(params, true)
  if (resolved.error !== undefined) return resolved.error
  const record = ownedRecord(resolved.tab.id)
  if (record !== undefined && record.autonomous === true) {
    // 自主标签页的任何读取前都复核：已静音、守卫在线、媒体已暂停。
    const guard = await ensureAutonomousPageReady(resolved.tab.id)
    if (!guard.ok) {
      return controlFail(guard.code || 'GUARD_UNAVAILABLE', '无法确认静音和不播放，已停止读取', {
        media: guard.media
      })
    }
  }
  const observed = await takeSnapshot(resolved.tab, frameIdOf(params), params)
  if (observed.error !== undefined) return observed.error
  return controlOk(observed.snapshot)
}

async function commandFind(params) {
  const resolved = await resolveTabForCommand(params, true)
  if (resolved.error !== undefined) return resolved.error
  const tab = resolved.tab
  const frameId = frameIdOf(params)
  if (!(await ensureContent(tab.id, frameId))) {
    return controlFail('UNSUPPORTED_PAGE', '该页面不能查询元素')
  }
  let raw
  try {
    raw = await sendControl(tab.id, frameId, {
      type: 'mingyue-control',
      op: 'find',
      locator:
        params.locator !== null && typeof params.locator === 'object' ? params.locator : {},
      pageVersion: params.pageVersion
    })
  } catch {
    return controlFail('CONTENT_UNREACHABLE', '页面没有响应')
  }
  if (raw === null || typeof raw !== 'object') {
    return controlFail('FIND_FAILED', '页面返回了无效结果')
  }
  if (raw.error !== undefined) {
    return controlFail(String(raw.error), String(raw.error), {
      matches: sanitizeElements(raw.matches, frameId),
      pageVersion: raw.pageVersion
    })
  }
  return controlOk({
    match: sanitizeElements([raw.match], frameId)[0],
    matches: sanitizeElements(raw.matches, frameId),
    pageId: controlString(raw.pageId, 80),
    pageVersion: Number.isInteger(raw.pageVersion) ? raw.pageVersion : 0,
    url: controlString(raw.url, 2000),
    title: controlString(raw.title, 300)
  })
}

async function runPageAction(params, op) {
  const resolved = await resolveTabForCommand(params, true)
  if (resolved.error !== undefined) return resolved.error
  const tab = resolved.tab
  const frameId = frameIdOf(params)
  if (!(await ensureContent(tab.id, frameId))) {
    return controlFail('UNSUPPORTED_PAGE', '该页面不能执行动作')
  }
  const payload = {
    type: 'mingyue-control',
    op,
    ...(typeof params.ref === 'string' ? { ref: params.ref } : {}),
    ...(params.locator !== null && typeof params.locator === 'object'
      ? { locator: params.locator }
      : {}),
    ...(Number.isInteger(params.pageVersion) ? { pageVersion: params.pageVersion } : {}),
    ...(typeof params.text === 'string' ? { text: params.text.slice(0, 4000) } : {}),
    ...(typeof params.value === 'string' ? { value: params.value.slice(0, 4000) } : {}),
    ...(typeof params.label === 'string' ? { label: params.label.slice(0, 300) } : {}),
    ...(typeof params.key === 'string' ? { key: params.key.slice(0, 40) } : {}),
    ...(Array.isArray(params.modifiers) ? { modifiers: params.modifiers.slice(0, 4) } : {}),
    ...(typeof params.direction === 'string' ? { direction: params.direction.slice(0, 20) } : {}),
    ...(Number.isFinite(Number(params.amount)) ? { amount: Number(params.amount) } : {}),
    ...(params.confirmExternal === true ? { confirmExternal: true } : {}),
    ...(params.dryRun === true ? { dryRun: true } : {}),
    ...(params.clearFirst === false ? { clearFirst: false } : {}),
    ...(params.pressEnter === true ? { pressEnter: true } : {})
  }
  const beforeTab = await getTab(tab.id)
  const beforeUrl = beforeTab !== null ? controlString(beforeTab.url, 2000) : ''
  if (op === 'click') {
    controlState.expectPopupFromTab = tab.id
    setTimeout(() => {
      if (controlState.expectPopupFromTab === tab.id) controlState.expectPopupFromTab = null
    }, 5000)
  }
  let raw
  try {
    raw = await sendControl(tab.id, frameId, payload)
  } catch {
    return controlFail('CONTENT_UNREACHABLE', '页面没有响应，动作可能未执行')
  }
  if (raw === null || typeof raw !== 'object') {
    return controlFail('PAGE_ACTION_FAILED', '页面返回了无效结果')
  }
  if (raw.ok === false) {
    return controlFail(
      typeof raw.code === 'string' ? raw.code : 'PAGE_ACTION_FAILED',
      typeof raw.error === 'string' ? raw.error : String(raw.code || '动作未完成'),
      {
        matches: sanitizeElements(raw.matches, frameId),
        pageVersion: raw.pageVersion,
        currentVersion: raw.currentVersion,
        executed: raw.executed === true,
        verified: false,
        ...(typeof raw.outcome === 'string' ? { outcome: raw.outcome } : {}),
        ...(typeof raw.detail === 'string' ? { detail: raw.detail.slice(0, 300) } : {})
      }
    )
  }
  const outcome = [
    'completed',
    'committed-unconfirmed',
    'submitted-unconfirmed',
    'notified-unverified',
    'unsupported',
    'no-effect',
    'failed-verification',
    'pending-confirmation'
  ]
  const result = {
    executed: raw.executed === true,
    verified: raw.verified === true,
    ...(outcome.includes(raw.outcome) ? { outcome: raw.outcome } : {}),
    ...(typeof raw.detail === 'string' ? { detail: raw.detail.slice(0, 300) } : {}),
    ...(typeof raw.submitVerified === 'boolean' ? { submitVerified: raw.submitVerified } : {}),
    ...(raw.requiresConfirmation === true ? { requiresConfirmation: true } : {}),
    ...(typeof raw.externalAction === 'string'
      ? { externalAction: raw.externalAction.slice(0, 120) }
      : {}),
    ...(raw.target !== undefined
      ? { target: sanitizeElements([raw.target], frameId)[0] }
      : {}),
    ...(typeof raw.value === 'string' ? { value: raw.value.slice(0, 300) } : {}),
    ...(typeof raw.submitted === 'boolean' ? { submitted: raw.submitted } : {}),
    ...(Number.isFinite(Number(raw.scrollY)) ? { scrollY: Number(raw.scrollY) } : {}),
    observation: sanitizeObservation(raw.observation, tab.id, frameId)
  }
  if (result.executed !== true) return controlOk(result)
  await controlSleep(op === 'click' ? 450 : 250)
  let afterTab = await getTab(tab.id)
  if (afterTab === null) return controlOk({ ...result, verified: result.verified === true })
  const afterUrl = controlString(afterTab.url, 2000)
  if (afterUrl !== '' && afterUrl !== beforeUrl) {
    const destinationError = controlUrlError(afterUrl, controlState.blockedDomains)
    if (destinationError !== null) {
      try {
        if (op === 'click' || op === 'type') await chrome.tabs.goBack(tab.id)
      } catch {
        /* 回退失败时至少停止后续动作 */
      }
      return controlFail('BLOCKED_DESTINATION', destinationError, {
        executed: true,
        verified: false,
        tabId: tab.id
      })
    }
  }
  if (afterTab.status !== 'complete') {
    await waitForTabReady(tab.id, Math.min(10_000, Number(params.timeoutMs) || 8000))
    afterTab = await getTab(tab.id)
    if (afterTab === null) return controlOk({ ...result, verified: result.verified === true })
  }
  if (isOwned(tab.id)) await ownTab(tab.id, afterTab)
  if (params.includeObservation !== false) {
    const observed = await takeSnapshot(afterTab, frameId, {
      maxElements: params.maxElements,
      maxChars: params.maxChars
    })
    if (observed.snapshot !== undefined) result.observation = observed.snapshot
  }
  if (afterUrl !== '' && afterUrl !== beforeUrl) {
    result.verified = true
    result.outcome = 'completed'
  }
  return controlOk(result)
}

async function commandWait(params) {
  const resolved = await resolveTabForCommand(params, true)
  if (resolved.error !== undefined) return resolved.error
  const tab = resolved.tab
  const frameId = frameIdOf(params)
  const timeoutMs = Math.min(20_000, Math.max(500, Number(params.timeoutMs) || 8000))
  let contentResult = null
  if (typeof params.text === 'string' && params.text !== '') {
    if (!(await ensureContent(tab.id, frameId))) {
      return controlFail('UNSUPPORTED_PAGE', '该页面不能等待文本')
    }
    try {
      contentResult = await sendControl(tab.id, frameId, {
        type: 'mingyue-control',
        op: 'wait',
        text: params.text.slice(0, 300),
        timeoutMs
      })
    } catch {
      return controlFail('CONTENT_UNREACHABLE', '页面没有响应')
    }
  }
  const ready = await waitForTabReady(tab.id, timeoutMs)
  const current = await getTab(tab.id)
  if (current === null) return controlFail('TAB_CLOSED', '标签页已关闭')
  return controlOk({
    found:
      contentResult !== null && contentResult !== undefined
        ? contentResult.found === true
        : true,
    ready: ready.ready === true,
    ...(ready.ready === true ? {} : { code: ready.code }),
    tab: tabSummary(current),
    ...(contentResult !== null && contentResult !== undefined
      ? {
          observation: sanitizeObservation(
            contentResult.observation,
            tab.id,
            frameId
          )
        }
      : {})
  })
}

async function commandTabSwitch(params) {
  const resolved = await resolveTabForCommand(params, params.adopt !== true)
  if (resolved.error !== undefined) return resolved.error
  const tab = resolved.tab
  if (params.adopt === true) await ownTab(tab.id, tab)
  await chrome.tabs.update(tab.id, { active: true })
  try {
    await chrome.windows.update(tab.windowId, { focused: true })
  } catch {
    /* 窗口聚焦失败不影响标签激活 */
  }
  const current = await getTab(tab.id)
  let snapshot = null
  if (params.includeSnapshot === true && current !== null) {
    const observed = await takeSnapshot(current, frameIdOf(params), params)
    if (observed.snapshot !== undefined) snapshot = observed.snapshot
  }
  return controlOk({
    tab: current === null ? null : tabSummary(current),
    ...(snapshot !== null ? { observation: snapshot } : {})
  })
}

async function commandTabClose(params) {
  const resolved = await resolveTabForCommand(params, true)
  if (resolved.error !== undefined) return resolved.error
  const tab = resolved.tab
  await forgetTab(tab.id, true)
  await chrome.tabs.remove(tab.id)
  return controlOk({ closed: true, tabId: tab.id, savedCount: controlState.saved.length })
}

async function commandRestoreTabs(params) {
  await loadOwnedTabs()
  const requested = Array.isArray(params.urls)
    ? params.urls.filter((url) => typeof url === 'string').slice(0, 8)
    : controlState.saved.slice(-8)
  const reopened = []
  for (const raw of requested) {
    const urlError = controlUrlError(raw, controlState.blockedDomains)
    if (urlError !== null) continue
    try {
      const tab = await chrome.tabs.create({ url: raw, active: params.active === true })
      if (tab !== null && Number.isInteger(tab.id)) {
        await ownTab(tab.id, tab)
        reopened.push(tabSummary(tab))
      }
    } catch {
      /* 单个恢复失败不影响其它标签 */
    }
  }
  if (requested.length > 0) {
    controlState.saved = controlState.saved.filter((url) => requested.includes(url) === false)
    await saveOwnedTabs()
  }
  return controlOk({ restored: reopened.length, tabs: reopened })
}

async function commandHistory(params, direction) {
  const resolved = await resolveTabForCommand(params, true)
  if (resolved.error !== undefined) return resolved.error
  const tab = resolved.tab
  try {
    if (direction === 'back') await chrome.tabs.goBack(tab.id)
    else await chrome.tabs.goForward(tab.id)
  } catch {
    return controlFail(
      direction === 'back' ? 'NO_BACK_HISTORY' : 'NO_FORWARD_HISTORY',
      '没有可用的浏览历史'
    )
  }
  const ready = await waitForTabReady(tab.id, params.timeoutMs)
  const current = await getTab(tab.id)
  if (current === null) return controlFail('TAB_CLOSED', '标签页已关闭')
  const urlError = controlUrlError(current.url, controlState.blockedDomains)
  if (urlError !== null) {
    return controlFail('BLOCKED_DOMAIN', urlError, { tabId: tab.id })
  }
  if (isOwned(tab.id)) await ownTab(tab.id, current)
  let snapshot = null
  if (params.includeSnapshot !== false) {
    const observed = await takeSnapshot(current, frameIdOf(params), params)
    if (observed.snapshot !== undefined) snapshot = observed.snapshot
  }
  return controlOk({
    tab: tabSummary(current),
    ready: ready.ready === true,
    ...(snapshot !== null ? { observation: snapshot } : {})
  })
}

async function commandDownload(params) {
  const blocked = readBlockedDomains(params)
  const url = controlString(params.url, 4000)
  const urlError = controlUrlError(url, blocked)
  if (urlError !== null) return controlFail('INVALID_URL', urlError)
  let filename = controlString(params.filename, 180).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  filename = filename.replace(/\.{2,}/g, '.').trim()
  if (filename === '') {
    try {
      const parsed = new URL(url)
      const last = parsed.pathname.split('/').filter((part) => part !== '').pop()
      filename =
        typeof last === 'string' && last !== ''
          ? decodeURIComponent(last).slice(0, 120)
          : 'download'
    } catch {
      filename = 'download'
    }
  }
  if (!filename.includes('.')) filename += '.bin'
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: 'Mingyue/' + filename,
      saveAs: false,
      conflictAction: 'uniquify'
    })
    return controlOk({ downloadId, filename: 'Downloads/Mingyue/' + filename })
  } catch {
    return controlFail('DOWNLOAD_FAILED', '下载没有启动（链接可能需要登录或格式不受支持）')
  }
}


async function closeAutonomousTabQuietly(tabId) {
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: 'mingyue-web-guard', op: 'standdown' },
      { frameId: 0 }
    )
  } catch {
    /* ignore */
  }
  await unmuteIfMutedByFeature(tabId)
  try {
    await chrome.tabs.remove(tabId)
  } catch {
    /* ignore */
  }
  await forgetTab(tabId, false)
}

async function runControlCommand(command) {
  const op = controlString(command.op, 40)
  const params =
    command.params !== null && typeof command.params === 'object' ? command.params : {}
  if (op === '') return controlFail('INVALID_COMMAND', '缺少指令类型')
  // 旧版应用可能仍发送 bili_*。这里明确拒绝并提示更新，绝不静默改写成
  // web_*，否则调用方会误以为自己仍在操作原来的 B 站专用标签页。
  if (CONTROL_RETIRED_OPS.has(op)) {
    return controlFail(
      'REMOVED_COMMAND',
      '扩展已更新，B 站专用指令 ' + op + ' 已移除；请更新桌宠应用后使用通用网页指令'
    )
  }
  const restricted = await enforceAutonomousCommand(op, params)
  if (restricted !== null) return restricted
  if (op === 'tabs') return commandTabs(params)
  if (op === 'open') return commandOpen(params)
  if (op === 'navigate') return commandNavigate(params)
  if (op === 'web_open') return commandWebOpen(params)
  if (op === 'web_navigate') return commandWebNavigate(params)
  if (op === 'web_media') return commandWebMedia(params)
  if (op === 'web_close') return commandWebClose(params)
  if (op === 'snapshot') return commandSnapshot(params)
  if (op === 'find') return commandFind(params)
  if (op === 'click') return runPageAction(params, 'click')
  if (op === 'type') return runPageAction(params, 'type')
  if (op === 'select') return runPageAction(params, 'select')
  if (op === 'key') return runPageAction(params, 'key')
  if (op === 'scroll') return runPageAction(params, 'scroll')
  if (op === 'wait') return commandWait(params)
  if (op === 'tab_switch') return commandTabSwitch(params)
  if (op === 'tab_close') return commandTabClose(params)
  if (op === 'restore_tabs') return commandRestoreTabs(params)
  if (op === 'back') return commandHistory(params, 'back')
  if (op === 'forward') return commandHistory(params, 'forward')
  if (op === 'download') return commandDownload(params)
  return controlFail('UNKNOWN_COMMAND', '不支持的浏览指令：' + op)
}

// ---------------------------------------------------------------------------
// 控制长轮询
// ---------------------------------------------------------------------------

function stopControlPolling() {
  if (controlState.abort !== null) {
    try {
      controlState.abort.abort()
    } catch {
      /* 已结束 */
    }
  }
  controlState.abort = null
  controlState.polling = false
}

async function controlLoop() {
  if (controlState.polling) return
  controlState.polling = true
  try {
    while (true) {
      const settings = await readSettings()
      if (!settings.controlConsent) break
      const pairing = parsePairing(settings.pairing)
      if (pairing === null) {
        controlState.lastError = '尚未配置配对码'
        break
      }
      const controller = new AbortController()
      controlState.abort = controller
      const timer = setTimeout(() => controller.abort(), CONTROL_POLL_WAIT_MS + 10_000)
      let response = null
      try {
        // 每次轮询都声明实际运行版本与能力。应用只有在看到这些声明后才会
        // 投递对应的指令；旧扩展没有这些参数，只会收到通用浏览指令。
        const query = new URLSearchParams({
          wait: String(CONTROL_POLL_WAIT_MS),
          instance: await controlInstance(),
          protocol: String(CONTROL_PROTOCOL_VERSION),
          version: chrome.runtime.getManifest().version,
          build: CONTROL_BUILD_ID,
          ops: CONTROL_SUPPORTED_OPS.join(',')
        })
        response = await fetch(pairing.base + '/v1/command?' + query.toString(), {
          method: 'GET',
          headers: { authorization: 'Bearer ' + pairing.token },
          cache: 'no-store',
          signal: controller.signal
        })
      } catch {
        clearTimeout(timer)
        if (controller.signal.aborted && controlState.abort !== controller) break
        controlState.lastError = '无法连接桌宠，请确认应用正在运行'
        break
      } finally {
        clearTimeout(timer)
        controlState.abort = null
      }
      if (response.status === 204) {
        controlState.lastPollAt = Date.now()
        controlState.connectedAt = controlState.lastPollAt
        controlState.lastError = null
        continue
      }
      if (response.status === 401) {
        controlState.lastError = '配对码无效，请在设置页重新配对'
        break
      }
      if (response.status === 403) {
        controlState.lastError = '应用内“主动浏览”未开启或已撤销'
        break
      }
      if (!response.ok) {
        controlState.lastError = '控制通道返回 ' + response.status
        break
      }
      let command = null
      try {
        command = readControlEnvelope(await response.json())
      } catch {
        controlState.lastError = '控制指令格式无效'
        continue
      }
      if (command === null) {
        controlState.lastError = '控制指令缺少编号'
        continue
      }
      controlState.lastPollAt = Date.now()
      controlState.connectedAt = Date.now()
      controlState.lastCommandAt = Date.now()
      let result
      try {
        result = await runControlCommand(command)
      } catch (error) {
        result = controlFail(
          'COMMAND_ERROR',
          String(error instanceof Error ? error.message : error)
        )
      }
      await postControlResult(pairing, command.id, result)
    }
  } finally {
    controlState.abort = null
    controlState.polling = false
  }
}

async function ensureControlPolling() {
  const settings = await readSettings()
  if (!settings.controlConsent) return
  if (controlState.polling) return
  if (parsePairing(settings.pairing) === null) return
  if (!controlState.ownedLoaded) {
    try {
      await reconcileOwnedTabs()
    } catch {
      /* 标签页恢复失败不阻塞控制通道 */
    }
  }
  void controlLoop()
}
