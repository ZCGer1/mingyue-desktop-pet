'use strict'

const statusList = document.getElementById('status')
const pausedInput = document.getElementById('paused')
const controlInput = document.getElementById('controlConsent')

function row(label, value, tone) {
  const dt = document.createElement('dt')
  dt.textContent = label
  const dd = document.createElement('dd')
  dd.textContent = value
  if (tone) dd.className = tone
  return [dt, dd]
}

function render(status) {
  statusList.replaceChildren()
  if (!status) {
    statusList.append(...row('状态', '后台未响应', 'bad'))
    return
  }
  pausedInput.checked = status.paused
  const control = status.control !== undefined && status.control !== null ? status.control : {}
  controlInput.checked = control.consent === true
  let stateText = '未配对'
  let tone = 'warn'
  if (!status.paired) {
    stateText = '未配对'
  } else if (status.paused) {
    stateText = '已暂停'
  } else if (status.filtersOk) {
    stateText = '已连接'
    tone = 'ok'
  } else if (status.disabledByApp) {
    stateText = '应用内页面感知未开启'
  } else if (status.lastError) {
    stateText = status.lastError
    tone = 'bad'
  }
  let controlText = '未开启（需勾选）'
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
    ...row('页面感知', stateText, tone),
    ...row(
      '最近发送',
      status.lastSendAt === null ? '—' : new Date(status.lastSendAt).toLocaleTimeString(),
      'muted'
    ),
    ...row('主动浏览', controlText, controlTone)
  )
}

async function refresh() {
  try {
    render(await chrome.runtime.sendMessage({ type: 'status' }))
  } catch {
    render(null)
  }
}

pausedInput.addEventListener('change', () => {
  void (async () => {
    try {
      render(
        await chrome.runtime.sendMessage({ type: 'set-paused', paused: pausedInput.checked })
      )
    } catch {
      render(null)
    }
  })()
})

controlInput.addEventListener('change', () => {
  void (async () => {
    try {
      render(
        await chrome.runtime.sendMessage({
          type: 'set-control-consent',
          consent: controlInput.checked
        })
      )
    } catch {
      render(null)
    }
  })()
})

document.getElementById('options').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

document.getElementById('refresh').addEventListener('click', () => void refresh())

void refresh()
