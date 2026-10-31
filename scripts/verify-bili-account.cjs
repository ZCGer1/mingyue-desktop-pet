/** Read-only login probe. Never prints credentials, account identity or raw responses. */
const { app, safeStorage } = require('electron')
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawn } = require('node:child_process')
const root = resolve(__dirname, '..')
const data = resolve(process.argv[2] || join(root, 'release', 'data'))
// Chromium's Windows encryption key belongs to this application's profile.
// Run only with the desktop pet closed; no BrowserWindow or page is created.
app.setPath('userData', join(data, 'chromium'))
app.setPath('sessionData', join(data, 'chromium'))
app.whenReady().then(() => {
  let credentials
  let storageStage = 'read'
  try {
    const stored = JSON.parse(readFileSync(join(data, 'bilibili', 'credentials.enc'), 'utf8'))
    storageStage = 'decrypt'
    const plaintext = safeStorage.decryptString(Buffer.from(stored.enc, 'base64'))
    storageStage = 'decode'
    credentials = JSON.parse(plaintext).credentials
  } catch {
    console.log(JSON.stringify({ ok: false, stage: 'encrypted-storage', storageStage, available: safeStorage.isEncryptionAvailable() }))
    app.exit(1)
    return
  }
  const child = spawn(join(data, 'bilibili', 'venv-service', 'Scripts', 'python.exe'),
    ['-I', '-B', join(root, 'resources', 'bilibili', 'mcp_server.py')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BILI_MCP_TOOLS: 'bili_account', PYTHONIOENCODING: 'utf-8' }
    })
  let buffer = ''
  let finished = false
  const timer = setTimeout(() => finish({ ok: false, stage: 'timeout' }), 45000)
  function finish(result) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    console.log(JSON.stringify(result))
    child.kill()
    app.exit(result.ok ? 0 : 1)
  }
  const send = (value) => child.stdin.write(JSON.stringify(value) + '\n')
  child.on('error', () => finish({ ok: false, stage: 'spawn' }))
  child.on('exit', () => finish({ ok: false, stage: 'service-exit' }))
  child.stderr.on('data', () => {})
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id === 1) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bili_account', arguments: {} } })
      }
      if (msg.id === 2) {
        try {
          const value = JSON.parse(msg.result.content.find((c) => c.type === 'text').text)
          finish({ ok: value.ok === true, stage: 'account', identityPresent: typeof value.uid === 'string' && value.uid.length > 0,
            ...(value.ok ? {} : { code: /^[a-z-]{1,40}$/.test(value.code) ? value.code : 'unknown' }) })
        } catch { finish({ ok: false, stage: 'protocol' }) }
      }
    }
  })
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'account-probe', version: '1' },
    _meta: { bilibili_credentials: { sessdata: credentials.sessdata, bili_jct: credentials.biliJct,
      buvid3: credentials.buvid3, dedeuserid: credentials.dedeuserid } }
  } })
  credentials = null
}).catch(() => { console.log('{"ok":false,"stage":"electron"}'); app.exit(1) })
