/**
 * 主动控制内容脚本。
 *
 * 只在扩展端口收到 /v1/command 转发的消息时工作；不自动读取页面内容，
 * 不发送任何东西，也不接触 cookie/localStorage。
 *
 * 元素句柄（ref）只存在于当前 document 的 Map 里；导航或重新快照后旧 ref
 * 必须失效。所有动作都先校验元素仍连接、可见且未禁用，再执行并回读状态。
 */
;(function () {
  'use strict'

  if (globalThis.__mingyueControlLoaded === true) return
  globalThis.__mingyueControlLoaded = true

  const PAGE_ID =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  const MAX_REFS = 600
  const SENSITIVE_AUTOCOMPLETE = /(?:^|[\s-])(cc-|current-password|new-password|one-time-code)/i
  const EXTERNAL_ACTION =
    /(?:发送|发布|提交订单|付款|支付|购买|下单|转账|确认支付|发送消息|发布动态|寄送|订阅|send|publish|post|pay|buy|purchase|order|subscribe|transfer|submit payment)/i
  const ORDINARY_SUBMIT =
    /(?:搜索|查找|查询|筛选|seek|search|find|filter|go|继续|下一页|next)/i

  const refs = new Map()
  let refCounter = 0
  let pageVersion = 1
  let dirty = false
  /** 页面 DOM 实际变化计数；用于验证点击/按键是否产生了可观察结果。 */
  let mutationVersion = 0

  function settle(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function isTopFrame() {
    try {
      return window.top === window
    } catch {
      return false
    }
  }

  function connected(el) {
    return el instanceof Element && el.isConnected
  }

  function isHiddenByStyle(el) {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return true
    }
    return Number(style.opacity) === 0
  }

  function isVisible(el) {
    if (!connected(el) || isHiddenByStyle(el)) return false
    if (el.closest('[aria-hidden="true"]') !== null) return false
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    // 允许部分在视口外的元素，但完全在文档外的隐藏容器不算。
    return rect.bottom > -2000 && rect.right > -2000
  }

  function isSensitiveValueField(el) {
    if (!(el instanceof HTMLInputElement)) return false
    if (el.type === 'password' || el.type === 'hidden' || el.type === 'file') return true
    const autocomplete = String(el.getAttribute('autocomplete') || '')
    if (SENSITIVE_AUTOCOMPLETE.test(autocomplete)) return true
    const name = String(el.getAttribute('name') || '').toLowerCase()
    return /pass(word|wd)?|token|otp|credit|card|cvv|cvc|secret/.test(name)
  }

  function isTextEntry(el) {
    if (el instanceof HTMLTextAreaElement) return !isSensitiveValueField(el)
    if (el instanceof HTMLInputElement) {
      return (
        !isSensitiveValueField(el) &&
        !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'].includes(
          el.type
        )
      )
    }
    return el instanceof HTMLElement && el.isContentEditable
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role')
    if (explicit !== null && explicit.trim() !== '') return explicit.trim().toLowerCase()
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'summary') return 'button'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
      if (type === 'search') return 'searchbox'
      return 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    return ''
  }

  function labelText(el) {
    try {
      const id = el.getAttribute('id')
      if (id !== null && id !== '') {
        const label = document.querySelector('label[for="' + CSS.escape(id) + '"]')
        if (label !== null) return String(label.innerText || label.textContent || '').trim()
      }
      const wrapping = el.closest('label')
      if (wrapping !== null) {
        return String(wrapping.innerText || wrapping.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
      }
    } catch {
      /* 页面 CSS 异常时退回其它名称来源 */
    }
    return ''
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label')
    if (aria !== null && aria.trim() !== '') return aria.trim().slice(0, 200)
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy !== null && labelledBy.trim() !== '') {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => {
          const node = document.getElementById(id)
          return node === null ? '' : String(node.textContent || '').trim()
        })
        .filter((part) => part !== '')
        .join(' ')
      if (text !== '') return text.slice(0, 200)
    }
    if (el instanceof HTMLInputElement) {
      const placeholder = el.getAttribute('placeholder')
      if (placeholder !== null && placeholder.trim() !== '') return placeholder.trim().slice(0, 200)
      const value = el.value
      if (value !== '' && el.type !== 'password') return value.slice(0, 200)
    }
    const label = labelText(el)
    if (label !== '') return label.slice(0, 200)
    const alt = el.getAttribute('alt')
    if (alt !== null && alt.trim() !== '') return alt.trim().slice(0, 200)
    const title = el.getAttribute('title')
    if (title !== null && title.trim() !== '') return title.trim().slice(0, 200)
    const text = String(el.innerText || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
    return text.slice(0, 200)
  }

  function safeHref(el) {
    if (!(el instanceof HTMLAnchorElement)) return undefined
    const href = el.href
    if (typeof href !== 'string' || href.length > 2000) return undefined
    return href
  }

  function elementInfo(el, ref) {
    const info = {
      ref,
      role: roleOf(el) || el.tagName.toLowerCase(),
      name: nameOf(el),
      tag: el.tagName.toLowerCase()
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        info.checked = el.checked
      } else if (!isSensitiveValueField(el)) {
        info.value = String(el.value || '').slice(0, 300)
      }
      if (el.disabled) info.disabled = true
    } else if (el instanceof HTMLButtonElement && el.disabled) {
      info.disabled = true
    }
    if (el.getAttribute('aria-disabled') === 'true') info.disabled = true
    const href = safeHref(el)
    if (href !== undefined) info.href = href
    return info
  }

  function remember(el) {
    if (refs.size > MAX_REFS) {
      refs.clear()
      refCounter = 0
    }
    refCounter += 1
    const ref = 'e' + refCounter
    refs.set(ref, el)
    return ref
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase()
    if (['a', 'button', 'input', 'textarea', 'select', 'summary'].includes(tag)) return true
    const role = (el.getAttribute('role') || '').toLowerCase()
    if (['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab', 'option', 'switch'].includes(role)) {
      return true
    }
    return el.isContentEditable
  }

  function candidateElements(root) {
    const out = []
    const nodes = (root || document).querySelectorAll(
      'a[href], button, input, textarea, select, summary, [role], [contenteditable=""], [contenteditable="true"], [tabindex]'
    )
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue
      if (el instanceof HTMLInputElement && (el.type === 'hidden' || el.type === 'password')) continue
      if (!isVisible(el)) continue
      if (!isInteractive(el)) continue
      out.push(el)
      if (out.length >= 240) break
    }
    return out
  }

  function textOfPage(maxChars) {
    const body = document.body
    if (body === null) return ''
    const text = String(body.innerText || body.textContent || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return text.slice(0, Math.max(0, maxChars))
  }

  function headings() {
    return Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((el) => String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((text) => text !== '')
      .slice(0, 20)
      .map((text) => text.slice(0, 300))
  }

  function snapshot(opts) {
    const options = opts !== null && typeof opts === 'object' ? opts : {}
    const maxElements = Math.min(160, Math.max(10, Number(options.maxElements) || 80))
    const maxChars = Math.min(20_000, Math.max(500, Number(options.maxChars) || 6000))
    pageVersion += 1
    dirty = false
    refs.clear()
    refCounter = 0
    const elements = []
    for (const el of candidateElements()) {
      const ref = remember(el)
      elements.push(elementInfo(el, ref))
      if (elements.length >= maxElements) break
    }
    return {
      pageId: PAGE_ID,
      pageVersion,
      url: safeLocation(),
      title: String(document.title || '').slice(0, 300),
      readyState: document.readyState,
      capturedAt: Date.now(),
      elements,
      text: textOfPage(maxChars),
      headings: headings(),
      truncated: elements.length >= maxElements,
      topFrame: isTopFrame()
    }
  }

  function safeLocation() {
    try {
      const url = new URL(window.location.href)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
      return url.href.slice(0, 2000)
    } catch {
      return ''
    }
  }

  function resolveLocator(locator) {
    if (locator === null || typeof locator !== 'object') return { error: 'INVALID_LOCATOR' }
    const role = typeof locator.role === 'string' ? locator.role.trim().toLowerCase() : ''
    const name = typeof locator.name === 'string' ? locator.name.trim() : ''
    const text = typeof locator.text === 'string' ? locator.text.trim() : ''
    const tag = typeof locator.tag === 'string' ? locator.tag.trim().toLowerCase() : ''
    const exact = locator.exact === true
    const index = Number.isInteger(locator.index) ? locator.index : null
    const max = Math.min(20, Math.max(1, Number(locator.max) || 8))
    const matches = []
    for (const el of candidateElements()) {
      if (role !== '' && roleOf(el) !== role) continue
      if (tag !== '' && el.tagName.toLowerCase() !== tag) continue
      const elName = nameOf(el)
      if (name !== '') {
        const ok = exact ? elName === name : elName.toLowerCase().includes(name.toLowerCase())
        if (!ok) continue
      }
      if (text !== '') {
        const haystack = (elName + ' ' + String(el.innerText || el.textContent || '')).toLowerCase()
        const ok = exact ? haystack.trim() === text.toLowerCase() : haystack.includes(text.toLowerCase())
        if (!ok) continue
      }
      const ref = remember(el)
      matches.push(elementInfo(el, ref))
      if (matches.length >= max) break
    }
    if (matches.length === 0) return { error: 'TARGET_NOT_FOUND', matches: [] }
    if (index !== null && index >= 0 && index < matches.length) {
      return { match: matches[index], matches }
    }
    if (matches.length === 1) return { match: matches[0], matches }
    return { error: 'AMBIGUOUS_TARGET', matches }
  }

  function resolveTarget(payload) {
    const pageVersionGiven = Number(payload.pageVersion)
    if (
      Number.isFinite(pageVersionGiven) &&
      pageVersionGiven > 0 &&
      pageVersionGiven !== pageVersion
    ) {
      return { error: 'STALE_OBSERVATION', matches: [], currentVersion: pageVersion }
    }
    const ref = typeof payload.ref === 'string' ? payload.ref.trim() : ''
    if (ref !== '') {
      const el = refs.get(ref)
      if (!connected(el)) return { error: 'STALE_REF', matches: [], currentVersion: pageVersion }
      return { el, info: elementInfo(el, ref) }
    }
    const resolved = resolveLocator(payload.locator)
    if (resolved.error !== undefined) {
      return { ...resolved, currentVersion: pageVersion }
    }
    const info = resolved.match
    let el = null
    for (const [key, value] of refs.entries()) {
      if (key === info.ref) {
        el = value
        break
      }
    }
    if (!connected(el)) return { error: 'STALE_REF', matches: resolved.matches, currentVersion: pageVersion }
    return { el, info, matches: resolved.matches }
  }

  function externalReason(el, info) {
    const explicit = info.name || ''
    if (EXTERNAL_ACTION.test(explicit)) return explicit.slice(0, 60)
    if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
      const type = el instanceof HTMLButtonElement ? 'submit' : String(el.type || '').toLowerCase()
      if (type === 'submit') {
        const form = el.form
        if (form !== null) {
          const formText = (String(form.innerText || '') + ' ' + String(form.getAttribute('action') || '')).slice(0, 2000)
          if (EXTERNAL_ACTION.test(formText)) return explicit || 'form-submit'
          if (form.querySelector('input[type="password"]') !== null) return 'credential-form'
          if (ORDINARY_SUBMIT.test(formText + ' ' + explicit)) return ''
          // 普通表单提交也可能是发消息——名称没有搜索语义时按外部动作处理。
          if (form.querySelector('textarea') !== null) return explicit || 'message-form'
        }
      }
    }
    if (el instanceof HTMLAnchorElement) {
      const href = el.href
      if (/^(?:mailto:|tel:)/i.test(href)) return 'external-link'
      if (EXTERNAL_ACTION.test(href + ' ' + explicit)) return explicit.slice(0, 60)
    }
    return ''
  }

  function observeNow(extra) {
    const active = document.activeElement
    const focused =
      active instanceof HTMLElement && isTextEntry(active) === true
        ? { value: String(active.value || active.textContent || '').slice(0, 300) }
        : {}
    return {
      pageId: PAGE_ID,
      pageVersion,
      url: safeLocation(),
      title: String(document.title || '').slice(0, 300),
      readyState: document.readyState,
      capturedAt: Date.now(),
      ...focused,
      ...(extra === undefined ? {} : extra)
    }
  }

  function enterExternalReason(el) {
    if (!(el instanceof HTMLInputElement) || el.form === null) return ''
    const form = el.form
    const text = String(el.value || '')
    if (EXTERNAL_ACTION.test(text)) return text.slice(0, 80)
    const formText = (
      String(form.innerText || '') +
      ' ' +
      String(form.getAttribute('action') || '') +
      ' ' +
      String(el.getAttribute('placeholder') || '') +
      ' ' +
      String(el.getAttribute('name') || '')
    ).slice(0, 3000)
    if (form.querySelector('input[type="password"]') !== null) return 'credential-form'
    const submit =
      form.querySelector('button[type="submit"]') ||
      form.querySelector('input[type="submit"]') ||
      form.querySelector('button:not([type])')
    if (submit !== null) {
      const info = elementInfo(submit, 'probe')
      const reason = externalReason(submit, info)
      if (reason !== '') return reason
    }
    if (form.querySelector('textarea') !== null) return 'message-form'
    if (EXTERNAL_ACTION.test(formText)) return 'form-submit'
    if (!ORDINARY_SUBMIT.test(formText)) {
      // 没有搜索语义的普通表单也可能把文字发出去；先按外部动作确认。
      return 'form-submit'
    }
    return ''
  }

  function pressEnterOn(el) {
    const eventInit = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }
    el.dispatchEvent(new KeyboardEvent('keydown', eventInit))
    el.dispatchEvent(new KeyboardEvent('keypress', eventInit))
    el.dispatchEvent(new KeyboardEvent('keyup', eventInit))
    if (el instanceof HTMLInputElement && el.form !== null && !isSensitiveValueField(el)) {
      try {
        el.form.requestSubmit()
      } catch {
        /* 页面阻止提交时保持普通按键结果 */
      }
    }
    return true
  }

  function setNativeValue(el, value) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto =
        el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')
      if (setter !== undefined && typeof setter.set === 'function') setter.set.call(el, value)
      else el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return String(el.value)
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      el.focus()
      const selection = window.getSelection()
      if (selection !== null) {
        const range = document.createRange()
        range.selectNodeContents(el)
        selection.removeAllRanges()
        selection.addRange(range)
      }
      const inserted = document.execCommand('insertText', false, value)
      if (inserted === false) el.textContent = value
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      return String(el.textContent || '')
    }
    return ''
  }

  function stateFingerprint(el) {
    const active = document.activeElement
    return {
      url: safeLocation(),
      text: String(document.body ? document.body.innerText : '').slice(0, 800),
      mutations: mutationVersion,
      readyState: document.readyState,
      active: active instanceof HTMLElement ? nameOf(active) : '',
      checked: el instanceof HTMLInputElement ? String(el.checked) : '',
      expanded: String(el.getAttribute('aria-expanded') || ''),
      pressed: String(el.getAttribute('aria-pressed') || ''),
      selected: String(el.getAttribute('aria-selected') || ''),
      value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? String(el.value) : ''
    }
  }

  function fingerprintChanged(before, after) {
    return (
      before.url !== after.url ||
      before.text !== after.text ||
      before.mutations !== after.mutations ||
      before.readyState !== after.readyState ||
      before.active !== after.active ||
      before.checked !== after.checked ||
      before.expanded !== after.expanded ||
      before.pressed !== after.pressed ||
      before.selected !== after.selected ||
      before.value !== after.value
    )
  }

  async function performClick(payload) {
    const target = resolveTarget(payload)
    if (target.error !== undefined) return { ok: false, ...target, executed: false, verified: false }
    const el = target.el
    const info = target.info
    if (!isVisible(el)) return { ok: false, code: 'TARGET_NOT_VISIBLE', executed: false, verified: false }
    if (info.disabled === true || el.getAttribute('aria-disabled') === 'true') {
      return { ok: false, code: 'TARGET_DISABLED', executed: false, verified: false }
    }
    const external = externalReason(el, info)
    if (payload.confirmExternal !== true && external !== '') {
      return {
        ok: true,
        executed: false,
        verified: false,
        outcome: 'pending-confirmation',
        requiresConfirmation: true,
        externalAction: external,
        target: info,
        observation: observeNow()
      }
    }
    if (payload.dryRun === true) {
      return {
        ok: true,
        executed: false,
        verified: false,
        outcome: 'dry-run',
        target: info,
        observation: observeNow()
      }
    }
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' })
    } catch {
      /* 滚动失败不阻止点击 */
    }
    const before = stateFingerprint(el)
    try {
      el.click()
    } catch (error) {
      return {
        ok: false,
        code: 'CLICK_FAILED',
        error: String(error instanceof Error ? error.message : error).slice(0, 200),
        executed: false,
        verified: false
      }
    }
    // 给同步/微任务更新与 SPA 路由一点时间；导航由扩展后台再确认。
    await settle(120)
    const after = stateFingerprint(el)
    const changed = fingerprintChanged(before, after)
    return {
      ok: true,
      executed: true,
      verified: changed,
      outcome: changed ? 'completed' : 'committed-unconfirmed',
      ...(changed
        ? {}
        : {
            code: 'NO_OBSERVED_CHANGE',
            detail: '点击事件已发出，但没有观察到 URL、页面文字、焦点或控件状态变化；不要盲目重复有副作用的点击。'
          }),
      target: info,
      beforeUrl: before.url,
      observation: observeNow({ changed })
    }
  }

  function performType(payload) {
    const target = resolveTarget(payload)
    if (target.error !== undefined) return { ok: false, ...target, executed: false, verified: false }
    const el = target.el
    if (!isTextEntry(el)) {
      return { ok: false, code: 'NOT_A_TEXT_FIELD', executed: false, verified: false }
    }
    if (!isVisible(el)) return { ok: false, code: 'TARGET_NOT_VISIBLE', executed: false, verified: false }
    const text = typeof payload.text === 'string' ? payload.text.slice(0, 4000) : ''
    try {
      el.focus()
    } catch {
      /* 聚焦失败时仍尝试写入，验证会暴露问题 */
    }
    const intended =
      payload.clearFirst === false && el.value !== '' ? String(el.value) + text : text
    const value = setNativeValue(el, intended)
    const valueVerified = value === intended
    if (typeof payload.expected === 'string' && value !== payload.expected) {
      return {
        ok: false,
        code: 'VALUE_MISMATCH',
        executed: true,
        verified: false,
        outcome: 'failed-verification',
        value,
        expected: payload.expected.slice(0, 300),
        observation: observeNow()
      }
    }
    let submitted = false
    let external = ''
    if (payload.pressEnter === true) {
      external = enterExternalReason(el)
      if (external !== '' && payload.confirmExternal !== true) {
        return {
          ok: true,
          executed: true,
          verified: valueVerified,
          outcome: 'pending-confirmation',
          value: value.slice(0, 300),
          submitted: false,
          requiresConfirmation: true,
          externalAction: external,
          target: target.info,
          observation: observeNow()
        }
      }
      submitted = pressEnterOn(el)
    }
    return {
      ok: true,
      executed: true,
      verified: valueVerified,
      outcome: submitted ? 'submitted-unconfirmed' : valueVerified ? 'completed' : 'failed-verification',
      value: value.slice(0, 300),
      submitted,
      ...(submitted
        ? {
            submitVerified: false,
            detail: '文字已写入并回读核对；提交已发出，提交后的页面结果由浏览器通道继续确认。'
          }
        : {}),
      ...(external !== '' ? { externalAction: external } : {}),
      target: target.info,
      observation: observeNow()
    }
  }

  function performSelect(payload) {
    const target = resolveTarget(payload)
    if (target.error !== undefined) return { ok: false, ...target, executed: false, verified: false }
    const el = target.el
    if (!(el instanceof HTMLSelectElement)) {
      return { ok: false, code: 'NOT_A_SELECT', executed: false, verified: false }
    }
    if (el.disabled) return { ok: false, code: 'TARGET_DISABLED', executed: false, verified: false }
    const wantValue = typeof payload.value === 'string' ? payload.value : ''
    const wantLabel = typeof payload.label === 'string' ? payload.label.trim() : ''
    let option = null
    for (const candidate of el.options) {
      if (wantValue !== '' && candidate.value === wantValue) {
        option = candidate
        break
      }
      if (wantLabel !== '' && String(candidate.textContent || '').trim() === wantLabel) {
        option = candidate
        break
      }
    }
    if (option === null) return { ok: false, code: 'OPTION_NOT_FOUND', executed: false, verified: false }
    el.value = option.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    const verified = el.value === option.value
    return {
      ok: true,
      executed: true,
      verified,
      outcome: verified ? 'completed' : 'failed-verification',
      ...(verified ? {} : { code: 'SELECT_MISMATCH', detail: '下拉框没有保持所选值。' }),
      value: el.value,
      label: String(option.textContent || '').trim().slice(0, 200),
      target: target.info,
      observation: observeNow()
    }
  }

  function keyIdentity(value) {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed === '') return null
    const lower = trimmed.toLowerCase()
    const named = {
      esc: { key: 'Escape', code: 'Escape' },
      escape: { key: 'Escape', code: 'Escape' },
      tab: { key: 'Tab', code: 'Tab' },
      backspace: { key: 'Backspace', code: 'Backspace' },
      delete: { key: 'Delete', code: 'Delete' },
      del: { key: 'Delete', code: 'Delete' },
      home: { key: 'Home', code: 'Home' },
      end: { key: 'End', code: 'End' },
      pageup: { key: 'PageUp', code: 'PageUp' },
      pagedown: { key: 'PageDown', code: 'PageDown' },
      enter: { key: 'Enter', code: 'Enter' },
      return: { key: 'Enter', code: 'Enter' },
      space: { key: ' ', code: 'Space', label: 'Space' },
      spacebar: { key: ' ', code: 'Space', label: 'Space' },
      arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
      arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
      arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
      arrowright: { key: 'ArrowRight', code: 'ArrowRight' }
    }
    if (Object.prototype.hasOwnProperty.call(named, lower)) return named[lower]
    if (/^f(?:[1-9]|1[0-2])$/i.test(trimmed)) {
      const key = 'F' + trimmed.slice(1)
      return { key, code: key }
    }
    if (trimmed.length === 1 && !/[\u0000-\u001f\u007f]/.test(trimmed)) {
      return { key: trimmed, code: 'Key' + trimmed.toUpperCase() }
    }
    return null
  }

  function modifierState(list) {
    return {
      ctrl: list.some((m) => /ctrl|control/i.test(m)),
      alt: list.some((m) => /^alt$/i.test(m)),
      shift: list.some((m) => /shift/i.test(m)),
      meta: list.some((m) => /meta|win|cmd/i.test(m))
    }
  }

  function editableValue(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return String(el.value)
    if (el instanceof HTMLElement && el.isContentEditable) {
      return String(el.innerText || el.textContent || '')
    }
    return null
  }

  function inputSelection(el) {
    const length = String(el.value).length
    let start = typeof el.selectionStart === 'number' ? el.selectionStart : length
    let end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start
    if (start > end) {
      const swap = start
      start = end
      end = swap
    }
    return { start, end }
  }

  function writeInputValue(el, value, caret) {
    const proto =
      el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')
    if (setter !== undefined && typeof setter.set === 'function') setter.set.call(el, value)
    else el.value = value
    try {
      el.setSelectionRange(caret, caret)
    } catch {
      /* 某些 input 类型不支持 selection API */
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return String(el.value)
  }

  function replaceInputRange(el, start, end, text) {
    const value = String(el.value)
    const safeStart = Math.max(0, Math.min(value.length, start))
    const safeEnd = Math.max(safeStart, Math.min(value.length, end))
    const next = value.slice(0, safeStart) + text + value.slice(safeEnd)
    return writeInputValue(el, next, safeStart + text.length)
  }

  function ensureContentEditableSelection(el) {
    el.focus()
    const selection = window.getSelection()
    if (selection === null) return null
    if (selection.rangeCount === 0 || !el.contains(selection.anchorNode)) {
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    return selection
  }

  function insertIntoContentEditable(el, text) {
    const selection = ensureContentEditableSelection(el)
    if (selection === null || selection.rangeCount === 0) return false
    try {
      if (document.execCommand('insertText', false, text) === true) {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
        return true
      }
    } catch {
      /* 回退到 Range 插入 */
    }
    const range = selection.getRangeAt(0)
    range.deleteContents()
    const node = document.createTextNode(text)
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    return true
  }

  function deleteContentEditable() {
    const selection = window.getSelection()
    if (selection === null || selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    try {
      if (document.execCommand('delete', false) === true) return true
    } catch {
      /* 回退到 Range 删除 */
    }
    if (!range.collapsed) {
      range.deleteContents()
      return true
    }
    return false
  }

  function selectionState() {
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const sel = inputSelection(active)
      return { kind: 'input', start: sel.start, end: sel.end }
    }
    const selection = window.getSelection()
    if (selection === null || selection.rangeCount === 0) return { kind: 'none' }
    const range = selection.getRangeAt(0)
    return {
      kind: 'dom',
      node: range.startContainer,
      offset: range.startOffset,
      endNode: range.endContainer,
      endOffset: range.endOffset
    }
  }

  function selectionChanged(before, after) {
    if (before.kind !== after.kind) return true
    if (before.kind === 'input') return before.start !== after.start || before.end !== after.end
    if (before.kind === 'dom') {
      return (
        before.node !== after.node ||
        before.offset !== after.offset ||
        before.endNode !== after.endNode ||
        before.endOffset !== after.endOffset
      )
    }
    return false
  }

  function selectedText() {
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const sel = inputSelection(active)
      return String(active.value).slice(sel.start, sel.end)
    }
    const selection = window.getSelection()
    return selection === null ? '' : String(selection.toString())
  }

  function isDisabledControl(el) {
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLButtonElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      return el.disabled
    }
    return el.getAttribute('aria-disabled') === 'true'
  }

  function focusableElements() {
    const nodes = document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), textarea, select, summary, ' +
        '[tabindex], [contenteditable=""], [contenteditable="true"]'
    )
    const out = []
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue
      if (!isVisible(el) || isDisabledControl(el)) continue
      const tabindex = el.getAttribute('tabindex')
      if (tabindex !== null && Number(tabindex) < 0) continue
      out.push(el)
    }
    return out
  }

  function scrollPageFor(key) {
    const before = window.scrollY
    if (key === 'Home') window.scrollTo({ top: 0 })
    else if (key === 'End') window.scrollTo({ top: document.documentElement.scrollHeight })
    else if (key === 'PageUp') window.scrollBy({ top: -window.innerHeight * 0.9 })
    else if (key === 'PageDown') window.scrollBy({ top: window.innerHeight * 0.9 })
    else if (key === 'ArrowUp') window.scrollBy({ top: -80 })
    else if (key === 'ArrowDown') window.scrollBy({ top: 80 })
    return Math.abs(window.scrollY - before) > 0
  }

  async function performKey(payload) {
    const identity = keyIdentity(payload.key)
    if (identity === null) {
      return {
        ok: false,
        code: 'KEY_NOT_ALLOWED',
        error: '这个按键名不受支持。',
        executed: false,
        verified: false,
        outcome: 'unsupported'
      }
    }
    const modifiers = Array.isArray(payload.modifiers)
      ? payload.modifiers.filter((m) => typeof m === 'string').slice(0, 4)
      : []
    const mods = modifierState(modifiers)
    const active =
      document.activeElement instanceof HTMLElement ? document.activeElement : document.body
    if (active === null) {
      return { ok: false, code: 'NO_FOCUS_TARGET', executed: false, verified: false }
    }
    const key = identity.key
    const label = identity.label || key
    const init = {
      key,
      code: identity.code,
      bubbles: true,
      cancelable: true,
      ctrlKey: mods.ctrl,
      altKey: mods.alt,
      shiftKey: mods.shift,
      metaKey: mods.meta
    }
    const notify = () => {
      active.dispatchEvent(new KeyboardEvent('keydown', init))
      active.dispatchEvent(new KeyboardEvent('keyup', init))
    }
    const response = (fields) => ({ ok: true, key: label, modifiers, ...fields })
    const unsupported = (detail) => ({
      ok: false,
      code: 'KEY_NOT_SUPPORTED',
      error: detail,
      executed: false,
      verified: false,
      outcome: 'unsupported',
      observation: observeNow()
    })
    const noEffect = (detail) =>
      response({
        executed: false,
        verified: false,
        outcome: 'no-effect',
        code: 'NO_EFFECT',
        detail,
        observation: observeNow()
      })
    const notifyUnverified = (detail) =>
      response({
        executed: true,
        verified: false,
        outcome: 'notified-unverified',
        code: 'UNVERIFIED_KEY',
        detail,
        observation: observeNow()
      })
    const editable = isTextEntry(active)
    const command = mods.ctrl || mods.meta

    if (command) {
      if (isSensitiveValueField(active)) {
        return unsupported('敏感字段不支持键盘编辑或剪贴板操作。')
      }
      if (mods.alt) return unsupported('Alt 组合键依赖浏览器或系统原生行为，扩展无法确认执行结果。')
      const lowerKey = key.toLowerCase()
      if (lowerKey === 'a') {
        let executed = false
        let verified = false
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
          try {
            active.select()
            executed = true
            verified =
              active.selectionStart === 0 &&
              active.selectionEnd === String(active.value).length
          } catch {
            executed = false
          }
        } else if (active instanceof HTMLElement && active.isContentEditable) {
          try {
            const range = document.createRange()
            range.selectNodeContents(active)
            const selection = window.getSelection()
            selection.removeAllRanges()
            selection.addRange(range)
            executed = true
            verified = selection.toString().length > 0
          } catch {
            executed = false
          }
        } else {
          try {
            executed = document.execCommand('selectAll') === true
          } catch {
            executed = false
          }
          // execCommand 返回 true 不等于真的选中了任何内容；读取真实选区。
          if (executed) {
            const selection = window.getSelection()
            verified =
              selection !== null &&
              selection.rangeCount > 0 &&
              !selection.isCollapsed &&
              selection.toString().length > 0
          }
        }
        if (!executed) return noEffect('页面没有可全选的内容，或浏览器拒绝了全选命令。')
        return response({
          executed: true,
          verified,
          outcome: verified ? 'completed' : 'committed-unconfirmed',
          ...(verified ? {} : { code: 'SELECT_ALL_UNVERIFIED', detail: '全选命令已发出，但没有观察到非空选区。' }),
          observation: observeNow()
        })
      }
      if (lowerKey === 'c') {
        if (selectedText() === '') return noEffect('没有选中文字，复制没有可复制的内容。')
        let copied = false
        try {
          copied = document.execCommand('copy') === true
        } catch {
          copied = false
        }
        if (!copied) return unsupported('页面拒绝复制命令。')
        return response({
          executed: true,
          verified: false,
          outcome: 'committed-unconfirmed',
          code: 'CLIPBOARD_WRITE_UNVERIFIABLE',
          detail: '复制命令已执行；网页无法读取剪贴板来确认内容，不要声称已经核对复制结果。',
          observation: observeNow()
        })
      }
      if (lowerKey === 'x') {
        if (selectedText() === '') return noEffect('没有选中文字，剪切没有可剪切的内容。')
        const before = document.body ? String(document.body.innerText).slice(0, 500) : ''
        const beforeValue = editable ? editableValue(active) : null
        let cut = false
        try {
          cut = document.execCommand('cut') === true
        } catch {
          cut = false
        }
        if (!cut) return unsupported('页面拒绝剪切命令。')
        await settle(30)
        const changed =
          beforeValue !== null
            ? editableValue(active) !== beforeValue
            : (document.body ? String(document.body.innerText).slice(0, 500) : '') !== before
        return response({
          executed: true,
          verified: changed,
          outcome: changed ? 'completed' : 'committed-unconfirmed',
          ...(changed ? {} : { code: 'CUT_UNVERIFIED' }),
          observation: observeNow()
        })
      }
      if (lowerKey === 'v') {
        return unsupported('网页不能可靠读取剪贴板；请用 browser_type 填入文字。')
      }
      if (lowerKey === 'z') {
        const beforeValue = editable ? editableValue(active) : null
        const beforeMutation = mutationVersion
        let undone = false
        try {
          undone = document.execCommand(mods.shift ? 'redo' : 'undo') === true
        } catch {
          undone = false
        }
        if (!undone) {
          return response({
            executed: false,
            verified: false,
            outcome: 'no-effect',
            code: 'NO_HISTORY',
            detail: '没有可撤销/重做的历史；命令没有被执行。',
            observation: observeNow()
          })
        }
        await settle(30)
        const changed =
          beforeValue !== null
            ? editableValue(active) !== beforeValue
            : mutationVersion !== beforeMutation
        return response({
          executed: true,
          verified: changed,
          outcome: changed ? 'completed' : 'committed-unconfirmed',
          ...(changed ? {} : { code: 'HISTORY_UNVERIFIED' }),
          observation: observeNow()
        })
      }
      return unsupported('不支持的组合键；可用 Ctrl+A/C/X/Z，或改用 browser_type。')
    }

    if (mods.alt) {
      return unsupported('Alt 组合键依赖系统或浏览器原生行为，扩展无法确认执行结果。')
    }

    if (key === 'Tab') {
      const focusables = focusableElements()
      if (focusables.length === 0) return noEffect('页面没有可聚焦元素。')
      const index = focusables.indexOf(active)
      let next = null
      if (index >= 0) {
        next = focusables[index + (mods.shift ? -1 : 1)] ?? null
      } else {
        next = mods.shift ? focusables[focusables.length - 1] : focusables[0]
      }
      if (next === null || next === undefined) {
        return noEffect('焦点已经在页面可聚焦元素的边界，再按 Tab 会离开页面。')
      }
      try {
        next.focus()
      } catch {
        /* 验证会暴露失败 */
      }
      const verified = document.activeElement === next && document.activeElement !== active
      return response({
        executed: true,
        verified,
        outcome: verified ? 'completed' : 'committed-unconfirmed',
        ...(verified ? {} : { code: 'FOCUS_UNCHANGED', detail: '焦点没有移动；页面可能拦截了聚焦。' }),
        observation: observeNow()
      })
    }

    if (/^F(?:[1-9]|1[0-2])$/.test(key)) {
      return unsupported('功能键的浏览器原生行为不能由页面脚本触发；请改用浏览器工具。')
    }

    if (key === 'Escape') {
      const beforeActive = document.activeElement
      const beforeMutation = mutationVersion
      const beforeText = document.body ? String(document.body.innerText).slice(0, 500) : ''
      notify()
      await settle(120)
      const changed =
        document.activeElement !== beforeActive ||
        mutationVersion !== beforeMutation ||
        (document.body ? String(document.body.innerText).slice(0, 500) : '') !== beforeText
      return response({
        executed: true,
        verified: changed,
        outcome: changed ? 'completed' : 'notified-unverified',
        ...(changed
          ? {}
          : {
              code: 'UNVERIFIED_KEY',
              detail: 'Escape 事件已发送；页面没有出现可观察变化，无法确认弹窗或菜单是否关闭。'
            }),
        observation: observeNow()
      })
    }

    if (key === 'Backspace' || key === 'Delete') {
      if (!editable) return unsupported('当前焦点不在可编辑文本中，删除键不会作用于页面内容。')
      const beforeValue = editableValue(active)
      if (beforeValue === null) return unsupported('当前焦点不支持文本删除。')
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        const sel = inputSelection(active)
        let start = sel.start
        let end = sel.end
        if (start === end) {
          if (key === 'Backspace') {
            if (start === 0) return noEffect('光标已在开头，没有可删除的内容。')
            start -= 1
          } else {
            if (end >= String(active.value).length) {
              return noEffect('光标已在末尾，没有可删除的内容。')
            }
            end += 1
          }
        }
        replaceInputRange(active, start, end, '')
      } else {
        const deleted = deleteContentEditable()
        if (!deleted) return noEffect('浏览器没有执行这个删除操作。')
      }
      await settle(0)
      const afterValue = editableValue(active)
      const changed = afterValue !== beforeValue
      return response({
        executed: true,
        verified: changed,
        outcome: changed ? 'completed' : 'no-effect',
        ...(changed
          ? {}
          : { code: 'NO_EFFECT', detail: '删除命令没有改变可编辑内容。' }),
        before: String(beforeValue).slice(0, 120),
        after: String(afterValue ?? '').slice(0, 120),
        observation: observeNow()
      })
    }

    if (key === 'Enter') {
      if (active instanceof HTMLTextAreaElement) {
        const beforeValue = String(active.value)
        const sel = inputSelection(active)
        replaceInputRange(active, sel.start, sel.end, '\n')
        const changed = String(active.value) !== beforeValue
        return response({
          executed: true,
          verified: changed,
          outcome: changed ? 'completed' : 'no-effect',
          observation: observeNow()
        })
      }
      if (active instanceof HTMLElement && active.isContentEditable) {
        const beforeValue = editableValue(active)
        insertIntoContentEditable(active, '\n')
        const changed = editableValue(active) !== beforeValue
        return response({
          executed: true,
          verified: changed,
          outcome: changed ? 'completed' : 'committed-unconfirmed',
          observation: observeNow()
        })
      }
      if (
        active instanceof HTMLButtonElement ||
        active instanceof HTMLAnchorElement ||
        (active instanceof HTMLElement && (active.getAttribute('role') || '') === 'button')
      ) {
        const before = stateFingerprint(active)
        try {
          active.click()
        } catch {
          return { ok: false, code: 'ACTIVATION_FAILED', executed: false, verified: false }
        }
        await settle(120)
        const changed = fingerprintChanged(before, stateFingerprint(active))
        return response({
          executed: true,
          verified: changed,
          outcome: changed ? 'completed' : 'committed-unconfirmed',
          ...(changed ? {} : { code: 'NO_OBSERVED_CHANGE' }),
          observation: observeNow()
        })
      }
      if (!(active instanceof HTMLInputElement)) {
        return unsupported('当前焦点没有可提交的输入框或按钮。')
      }
      if (active.form === null) {
        notify()
        await settle(80)
        return notifyUnverified('输入框不在表单中；Enter 事件已发送，但没有可验证的提交行为。')
      }
      if (isSensitiveValueField(active)) {
        return unsupported('密码或敏感字段不能提交。')
      }
      const external = enterExternalReason(active)
      if (external !== '' && payload.confirmExternal !== true) {
        return response({
          executed: false,
          verified: false,
          outcome: 'pending-confirmation',
          requiresConfirmation: true,
          externalAction: external,
          observation: observeNow()
        })
      }
      try {
        if (active.form.checkValidity() === false) {
          return noEffect('表单校验未通过，提交没有发生。')
        }
      } catch {
        /* 没有校验 API 时继续尝试提交 */
      }
      try {
        active.form.requestSubmit()
      } catch {
        return noEffect('页面阻止了表单提交。')
      }
      return response({
        executed: true,
        verified: false,
        outcome: 'submitted-unconfirmed',
        submitted: true,
        submitVerified: false,
        detail: '表单已提交；提交后的导航或结果由浏览器通道继续确认。',
        observation: observeNow()
      })
    }

    if (key === ' ') {
      if (editable) {
        const beforeValue = editableValue(active)
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
          const sel = inputSelection(active)
          replaceInputRange(active, sel.start, sel.end, ' ')
        } else {
          insertIntoContentEditable(active, ' ')
        }
        await settle(0)
        const changed = editableValue(active) !== beforeValue
        return response({
          executed: true,
          verified: changed,
          outcome: changed ? 'completed' : 'no-effect',
          observation: observeNow()
        })
      }
      if (
        active instanceof HTMLButtonElement ||
        active instanceof HTMLInputElement ||
        active instanceof HTMLElement &&
          (active.getAttribute('role') === 'button' || active.getAttribute('role') === 'checkbox')
      ) {
        const before = stateFingerprint(active)
        try {
          active.click()
        } catch {
          return { ok: false, code: 'ACTIVATION_FAILED', executed: false, verified: false }
        }
        await settle(80)
        const changed = fingerprintChanged(before, stateFingerprint(active))
        return response({
          executed: true,
          verified: changed,
          outcome: changed ? 'completed' : 'committed-unconfirmed',
          ...(changed ? {} : { code: 'NO_OBSERVED_CHANGE' }),
          observation: observeNow()
        })
      }
      const scrolled = scrollPageFor('PageDown')
      return response({
        executed: true,
        verified: scrolled,
        outcome: scrolled ? 'completed' : 'no-effect',
        ...(scrolled ? {} : { code: 'NO_SCROLL_CHANGE' }),
        observation: observeNow()
      })
    }

    if (key === 'Home' || key === 'End') {
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        const target = key === 'Home' ? 0 : String(active.value).length
        try {
          active.setSelectionRange(target, target)
        } catch {
          return unsupported('这个输入框不支持光标定位。')
        }
        const verified = active.selectionStart === target && active.selectionEnd === target
        return response({
          executed: true,
          verified,
          outcome: verified ? 'completed' : 'committed-unconfirmed',
          observation: observeNow()
        })
      }
      if (active instanceof HTMLElement && active.isContentEditable) {
        ensureContentEditableSelection(active)
        const before = selectionState()
        try {
          window.getSelection().modify('move', key === 'Home' ? 'backward' : 'forward', 'lineboundary')
        } catch {
          return unsupported('浏览器不支持可编辑区域的光标定位。')
        }
        const verified = selectionChanged(before, selectionState())
        return response({
          executed: true,
          verified,
          outcome: verified ? 'completed' : 'no-effect',
          observation: observeNow()
        })
      }
      const scrolled = scrollPageFor(key)
      return response({
        executed: true,
        verified: scrolled,
        outcome: scrolled ? 'completed' : 'no-effect',
        ...(scrolled ? {} : { code: 'NO_SCROLL_CHANGE', detail: '页面已在该位置。' }),
        observation: observeNow()
      })
    }

    if (key.startsWith('Arrow')) {
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        if (active instanceof HTMLTextAreaElement && (key === 'ArrowUp' || key === 'ArrowDown')) {
          return unsupported('多行输入框的上下移动无法可靠模拟；请改用 locator 或直接设置文本。')
        }
        if (key !== 'ArrowLeft' && key !== 'ArrowRight') {
          return unsupported('上下方向键在输入框中没有可验证的单步行为。')
        }
        const sel = inputSelection(active)
        const collapsed = sel.start === sel.end
        const current = key === 'ArrowLeft' ? sel.start : sel.end
        const target = collapsed
          ? Math.max(
              0,
              Math.min(
                String(active.value).length,
                current + (key === 'ArrowLeft' ? -1 : 1)
              )
            )
          : current
        // 有选区时方向键的真实语义是“折叠到选区一端”，即使光标位置数值
        // 没变，selectionEnd 也发生了变化，不能误报 no-effect。
        if (collapsed && target === current) return noEffect('光标已经在该方向的边界。')
        try {
          active.setSelectionRange(target, target)
        } catch {
          return unsupported('这个输入框不支持光标定位。')
        }
        const verified =
          active.selectionStart === target && active.selectionEnd === target
        return response({
          executed: true,
          verified,
          outcome: verified ? 'completed' : 'committed-unconfirmed',
          observation: observeNow()
        })
      }
      if (active instanceof HTMLElement && active.isContentEditable) {
        ensureContentEditableSelection(active)
        const before = selectionState()
        try {
          window.getSelection().modify('move', key.replace('Arrow', '').toLowerCase(), 'character')
        } catch {
          return unsupported('浏览器不支持可编辑区域的光标移动。')
        }
        const verified = selectionChanged(before, selectionState())
        return response({
          executed: true,
          verified,
          outcome: verified ? 'completed' : 'no-effect',
          observation: observeNow()
        })
      }
      const scrolled = scrollPageFor(key)
      return response({
        executed: true,
        verified: scrolled,
        outcome: scrolled ? 'completed' : 'no-effect',
        ...(scrolled ? {} : { code: 'NO_SCROLL_CHANGE' }),
        observation: observeNow()
      })
    }

    if (key === 'PageUp' || key === 'PageDown') {
      if (editable) {
        return unsupported('翻页键在输入框中的行为无法可靠模拟；请直接滚动或设置文本。')
      }
      const scrolled = scrollPageFor(key)
      return response({
        executed: true,
        verified: scrolled,
        outcome: scrolled ? 'completed' : 'no-effect',
        ...(scrolled ? {} : { code: 'NO_SCROLL_CHANGE', detail: '页面已在该位置。' }),
        observation: observeNow()
      })
    }

    if (key.length === 1) {
      if (!editable) return unsupported('当前焦点不在可编辑文本中，字符不会被输入。')
      const text = mods.shift ? key.toUpperCase() : key
      const beforeValue = editableValue(active)
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        const sel = inputSelection(active)
        replaceInputRange(active, sel.start, sel.end, text)
      } else {
        insertIntoContentEditable(active, text)
      }
      await settle(0)
      const afterValue = editableValue(active)
      const verified = afterValue !== beforeValue
      return response({
        executed: true,
        verified,
        outcome: verified ? 'completed' : 'committed-unconfirmed',
        ...(verified ? {} : { code: 'INPUT_UNVERIFIED', detail: '字符没有出现在可编辑区域。' }),
        before: String(beforeValue ?? '').slice(0, 120),
        after: String(afterValue ?? '').slice(0, 120),
        observation: observeNow()
      })
    }

    return unsupported('这个按键没有可验证的页面行为。')
  }

  function performScroll(payload) {
    const direction = String(payload.direction || 'down')
    const amount = Math.min(5000, Math.max(100, Number(payload.amount) || 600))
    const target = payload.ref !== undefined || payload.locator !== undefined ? resolveTarget(payload) : null
    if (target !== null && target.error !== undefined) {
      return { ok: false, ...target, executed: false, verified: false }
    }
    const before = window.scrollY
    let targetVisible = null
    if (target !== null && target.el instanceof HTMLElement) {
      target.el.scrollIntoView({ block: direction === 'up' ? 'start' : 'center' })
      const rect = target.el.getBoundingClientRect()
      targetVisible = rect.bottom > 0 && rect.top < window.innerHeight + 1
    } else if (direction === 'top') {
      window.scrollTo({ top: 0 })
    } else if (direction === 'bottom') {
      window.scrollTo({ top: document.documentElement.scrollHeight })
    } else {
      window.scrollBy({ top: direction === 'up' ? -amount : amount })
    }
    const scrolled = Math.abs(window.scrollY - before) > 0
    const verified = target !== null ? targetVisible === true : scrolled
    return {
      ok: true,
      executed: true,
      verified,
      outcome: verified ? 'completed' : 'no-effect',
      ...(verified ? {} : { code: 'NO_SCROLL_CHANGE', detail: '页面已经位于该位置，滚动没有产生变化。' }),
      scrollY: window.scrollY,
      observation: observeNow()
    }
  }

  function waitForText(payload) {
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    const timeout = Math.min(20_000, Math.max(500, Number(payload.timeoutMs) || 5000))
    const started = Date.now()
    const check = () => {
      const bodyText = String(document.body ? document.body.innerText : '')
      return text === '' || bodyText.includes(text)
    }
    if (check()) return Promise.resolve({ ok: true, found: true, elapsedMs: 0, observation: observeNow() })
    return new Promise((resolve) => {
      let done = false
      const finish = (found) => {
        if (done) return
        done = true
        observer.disconnect()
        clearTimeout(timer)
        resolve({
          ok: true,
          found,
          elapsedMs: Date.now() - started,
          observation: observeNow()
        })
      }
      const observer = new MutationObserver(() => {
        if (check()) finish(true)
      })
      try {
        observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true })
      } catch {
        /* 页面禁止观察时只依赖超时轮询 */
      }
      const timer = setTimeout(() => finish(check()), timeout)
    })
  }

  function respondAsync(promise, sendResponse) {
    Promise.resolve(promise).then(
      (result) => sendResponse(result),
      (error) =>
        sendResponse({
          ok: false,
          code: 'CONTENT_ERROR',
          error: String(error instanceof Error ? error.message : error).slice(0, 300),
          executed: false,
          verified: false
        })
    )
    return true
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message === null || typeof message !== 'object' || message.type !== 'mingyue-control') {
      return false
    }
    const op = message.op
    try {
      if (op === 'snapshot') {
        sendResponse(snapshot(message.options))
        return false
      }
      if (op === 'find') {
        const result = resolveLocator(message.locator)
        sendResponse({ ...result, pageId: PAGE_ID, pageVersion, url: safeLocation(), title: String(document.title || '').slice(0, 300) })
        return false
      }
      if (op === 'click') {
        return respondAsync(performClick(message), sendResponse)
      }
      if (op === 'type') {
        sendResponse(performType(message))
        return false
      }
      if (op === 'select') {
        sendResponse(performSelect(message))
        return false
      }
      if (op === 'key') {
        return respondAsync(performKey(message), sendResponse)
      }
      if (op === 'scroll') {
        sendResponse(performScroll(message))
        return false
      }
      if (op === 'wait') {
        void waitForText(message).then((result) => sendResponse(result))
        return true
      }
      if (op === 'ping') {
        sendResponse({ ok: true, pageId: PAGE_ID, pageVersion, url: safeLocation(), readyState: document.readyState })
        return false
      }
      if (op === 'inspect') {
        const target = resolveTarget(message)
        sendResponse({
          ok: target.error === undefined,
          ...(target.error === undefined ? { target: target.info } : target),
          observation: observeNow()
        })
        return false
      }
      sendResponse({ ok: false, code: 'UNKNOWN_OP', error: '未知的页面动作' })
      return false
    } catch (error) {
      sendResponse({
        ok: false,
        code: 'CONTENT_ERROR',
        error: String(error instanceof Error ? error.message : error).slice(0, 300)
      })
      return false
    }
  })

  try {
    const observer = new MutationObserver(() => {
      dirty = true
      mutationVersion += 1
    })
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true })
  } catch {
    /* 页面禁止观察时忽略 */
  }
})()
