'use strict'

const pairingInput = document.getElementById('pairing')
const consentInput = document.getElementById('consent')
const pausedInput = document.getElementById('paused')
const resultText = document.getElementById('save-result')
const statusList = document.getElementById('status')

function parsePairing(raw) {
  const match = /^(\d{1,5})#([a-f0-9]{64})$/i.exec(String(raw || '').trim())
  if (match === null) return null
  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { port, token: match[2].toLowerCase() }
}

function setResult(text, tone) {
  resultText.textContent = text
  resultText.className = 'small ' + (tone || 'muted')
}

function row(label, value, tone) {
  const dt = document.createElement('dt')
  dt.textContent = label
  const dd = document.createElement('dd')
  dd.textContent = value
  if (tone) dd.className = tone
  return [dt, dd]
}

function renderStatus(status) {
  statusList.replaceChildren()
  if (!status) {
    statusList.append(...row('状态', '后台未响应', 'bad'))
    return
  }
  const control = status.control !== undefined && status.control !== null ? status.control : {}
  let controlText = '未开启（在扩展弹窗勾选）'
  let controlTone = 'muted'
  if (control.consent === true) {
    if (control.polling === true) {
      controlText = control.connected === true ? '已连接' : '等待应用'
      controlTone = control.connected === true ? 'ok' : 'warn'
    } else {
      controlText = control.lastError || '未连接'
      controlTone = control.lastError ? 'bad' : 'warn'
    }
  }
  statusList.append(
    ...row('配对', status.paired ? '已配置' : '未配置', status.paired ? 'ok' : 'warn'),
    ...row(
      '页面感知',
      status.filtersOk
        ? '已连接，可发送'
        : status.disabledByApp
          ? '已连接，但应用内页面感知未开启'
          : '未连接',
      status.filtersOk ? 'ok' : 'warn'
    ),
    ...row('主动浏览', controlText, controlTone),
    ...row('暂停', status.paused ? '是' : '否', status.paused ? 'warn' : 'ok'),
    ...row(
      '最近发送',
      status.lastSendAt === null
        ? '—'
        : new Date(status.lastSendAt).toLocaleTimeString(),
      'muted'
    ),
    ...row('错误', status.lastError || '无', status.lastError ? 'bad' : 'muted'),
    ...row('浏览器', status.browser === 'edge' ? 'Edge' : 'Chrome', 'muted')
  )
}

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'status' })
    renderStatus(status)
  } catch {
    renderStatus(null)
  }
}

async function load() {
  const data = await chrome.storage.local.get({ pairing: '', consent: false, paused: false })
  pairingInput.value = data.pairing
  consentInput.checked = data.consent === true
  pausedInput.checked = data.paused === true
  await refreshStatus()
}

async function save() {
  const raw = pairingInput.value.trim()
  if (raw !== '' && parsePairing(raw) === null) {
    setResult('配对码格式不对：应为“端口#64 位十六进制 token”。', 'bad')
    return
  }
  if (raw !== '' && !consentInput.checked) {
    setResult('请先勾选上面的授权说明。', 'warn')
    return
  }
  await chrome.storage.local.set({
    pairing: raw,
    consent: consentInput.checked,
    paused: pausedInput.checked
  })
  setResult('已保存。正在尝试连接…', 'muted')
  try {
    const status = await chrome.runtime.sendMessage({ type: 'refresh' })
    renderStatus(status)
    if (status && status.filtersOk) setResult('已连接，可以开始使用。', 'ok')
    else if (status && status.disabledByApp) {
      setResult('已连接，但请先在桌宠设置里开启“浏览器页面感知”。', 'warn')
    } else {
      setResult('保存成功，但暂时无法连接；请确认桌宠正在运行、配对码正确。', 'warn')
    }
  } catch {
    setResult('保存成功，但后台未响应。', 'warn')
  }
}

async function test() {
  const parsed = parsePairing(pairingInput.value)
  if (parsed === null) {
    setResult('配对码格式不对。', 'bad')
    return
  }
  setResult('正在测试…', 'muted')
  try {
    const health = await fetch('http://127.0.0.1:' + parsed.port + '/v1/health', {
      cache: 'no-store'
    })
    if (!health.ok) {
      setResult('应用有响应，但健康检查失败（HTTP ' + health.status + '）。', 'warn')
      return
    }
    const filters = await fetch('http://127.0.0.1:' + parsed.port + '/v1/filters', {
      headers: { authorization: 'Bearer ' + parsed.token },
      cache: 'no-store'
    })
    if (filters.status === 401) {
      setResult('token 不正确，请重新复制配对码。', 'bad')
    } else if (filters.status === 403) {
      setResult('配对正确，但应用内页面感知未开启。', 'warn')
    } else if (!filters.ok) {
      setResult('应用有响应，但过滤规则读取失败（HTTP ' + filters.status + '）。', 'warn')
    } else {
      setResult('连接正常，配对码有效。', 'ok')
    }
  } catch {
    setResult('无法连接 127.0.0.1。请确认桌宠正在运行。', 'bad')
  }
}

document.getElementById('save').addEventListener('click', () => void save())
document.getElementById('test').addEventListener('click', () => void test())
document.getElementById('refresh').addEventListener('click', () => void refreshStatus())
consentInput.addEventListener('change', () => {
  setResult('修改后请点击“保存并连接”。', 'muted')
})
pausedInput.addEventListener('change', () => {
  setResult('修改后请点击“保存并连接”。', 'muted')
})

void load()
