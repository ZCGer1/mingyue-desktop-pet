/**
 * 页面提取器（运行在隔离世界，只读 DOM）。
 *
 * 只取标题、域名、正文摘要和少量小标题；不读取 URL 路径、cookie、
 * localStorage、表单值、选中文本、历史/书签或密码字段内容。
 */
;(function () {
  'use strict'

  // 扩展侧的最小敏感域名表；应用侧还有一份更完整的过滤规则。
  const LOCAL_SENSITIVE = [
    '*.icbc.com.cn',
    '*.ccb.com',
    '*.abchina.com',
    '*.bankofchina.com',
    '*.cmbchina.com',
    '*.bankofamerica.com',
    '*.chase.com',
    '*.wellsfargo.com',
    '*.citi.com',
    '*.paypal.com',
    '*.stripe.com',
    '*.alipay.com',
    '*.1password.com',
    '*.bitwarden.com',
    '*.lastpass.com',
    '*.dashlane.com',
    '*.keepersecurity.com',
    'mail.google.com',
    'outlook.live.com',
    'outlook.office.com',
    'mail.qq.com',
    'mail.163.com',
    'mail.126.com',
    '*.protonmail.com',
    '*.proton.me',
    'drive.google.com',
    '*.dropbox.com',
    '*.onedrive.live.com',
    '*.id.me',
    'login.gov',
    '*.okta.com'
  ]

  const DROP_SELECTOR = [
    'script',
    'style',
    'noscript',
    'iframe',
    'svg',
    'canvas',
    'form',
    'input',
    'textarea',
    'select',
    'button',
    'template',
    '[contenteditable]',
    '[contenteditable="true"]',
    '[hidden]',
    '[aria-hidden="true"]'
  ].join(',')

  function normalizeDomain(raw) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '')
  }

  function domainMatches(domain, pattern) {
    const p = String(pattern || '').trim().toLowerCase()
    if (p === '') return false
    if (p.startsWith('*.')) {
      const base = p.slice(2)
      return base !== '' && (domain === base || domain.endsWith('.' + base))
    }
    return domain === p
  }

  function matchesAny(domain, patterns) {
    for (const pattern of patterns) {
      if (domainMatches(domain, pattern)) return true
    }
    return false
  }

  function hasPasswordField() {
    try {
      if (document.querySelector('input[type="password" i]') !== null) return true
      for (const input of document.querySelectorAll('input')) {
        if (String(input.type || '').toLowerCase() === 'password') return true
      }
    } catch {
      /* DOM 不可用时按敏感处理 */
    }
    return false
  }

  function readTitle() {
    try {
      const text = String(document.title || '')
        .replace(/\s+/g, ' ')
        .trim()
      return text === '' ? null : Array.from(text).slice(0, 300).join('')
    } catch {
      return null
    }
  }

  function readExcerpt() {
    try {
      const root =
        document.querySelector('article, main, [role="main"]') || document.body || null
      if (root === null) return null
      const clone = root.cloneNode(true)
      clone.querySelectorAll(DROP_SELECTOR).forEach((node) => node.remove())
      clone.querySelectorAll('[style]').forEach((node) => {
        const style = String(node.getAttribute('style') || '').toLowerCase()
        if (
          style.includes('display:none') ||
          style.includes('display: none') ||
          style.includes('visibility:hidden') ||
          style.includes('visibility: hidden')
        ) {
          node.remove()
        }
      })
      const text = String(clone.innerText || clone.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
      if (text === '') return null
      return Array.from(text).slice(0, 4000).join('')
    } catch {
      return null
    }
  }

  function readHeadings() {
    try {
      const out = []
      for (const node of document.querySelectorAll('h1, h2, h3')) {
        const text = String(node.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
        if (text === '' || text.length < 2) continue
        const clipped = Array.from(text).slice(0, 200).join('')
        if (out.includes(clipped)) continue
        out.push(clipped)
        if (out.length >= 8) break
      }
      return out
    } catch {
      return []
    }
  }

  function extract() {
    let domain = ''
    try {
      domain = normalizeDomain(location.hostname)
    } catch {
      /* 无法读取页面来源时保守跳过 */
    }
    if (domain === '' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) {
      return { suppressed: true }
    }
    if (hasPasswordField() || matchesAny(domain, LOCAL_SENSITIVE)) {
      return { suppressed: true }
    }
    return {
      domain,
      title: readTitle(),
      excerpt: readExcerpt(),
      headings: readHeadings()
    }
  }

  globalThis.__mingyuePageExtract = { extract }
})()
