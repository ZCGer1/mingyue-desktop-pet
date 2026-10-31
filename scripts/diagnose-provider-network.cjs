// Unauthenticated connectivity comparison; no keys, model calls or user profile access.
// Run with Electron, not Node. Output contains only transport/status/timing fields.
const { app, session } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { createServer } = require('node:http')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const root = join(__dirname, '..', 'test-results', 'provider-network')
mkdirSync(root, { recursive: true })
app.setPath('userData', join(root, 'chromium'))
app.disableHardwareAcceleration()
const adapterFile = join(root, 'providerFetch.cjs')
buildSync({ entryPoints: [join(__dirname, '..', 'src', 'main', 'providerFetch.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: adapterFile })
const { providerFetch } = require(adapterFile)
const target = 'https://api.deepseek.com/models'
async function verifyLocal() {
  let explicitAuthForwarded = false
  const server = createServer((req, res) => {
    if (req.url === '/stream') explicitAuthForwarded = req.headers.authorization === 'Bearer local-test-only'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
    if (req.url === '/stream') res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  // The production defaultSession denies external renderer requests. Verify isolation.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => cb({ cancel: true }))
  try {
    await assert.rejects(session.defaultSession.fetch(`${url}/stream`))
    const response = await providerFetch(`${url}/stream`, { headers: { authorization: 'Bearer local-test-only' } })
    assert.match(await response.text(), /\[DONE\]/)
    assert.equal(explicitAuthForwarded, true)
    const controller = new AbortController()
    const pending = await providerFetch(`${url}/wait`, { signal: controller.signal })
    const reader = pending.body.getReader()
    await reader.read()
    const read = reader.read()
    controller.abort()
    await assert.rejects(read)
    return { defaultSessionBlocked: true, isolatedStreamComplete: true, streamAbortWorks: true, explicitAuthForwarded }
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
async function probe(label, fetchImpl, method = 'GET') {
  const started = Date.now()
  try {
    const response = await fetchImpl(method === 'GET' ? target : 'https://api.deepseek.com/chat/completions', {
      signal: AbortSignal.timeout(20000), credentials: 'omit', cache: 'no-store', method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'ping' }], stream: true }) } : {})
    })
    await response.body?.cancel()
    return { transport: label, method, status: response.status, elapsedMs: Date.now() - started }
  } catch (error) {
    return { transport: label, method, name: error.name, message: error.message, code: error.cause?.code, cause: error.cause?.message, elapsedMs: Date.now() - started }
  }
}
app.whenReady().then(async () => {
  const ses = session.fromPartition('provider-connectivity-probe', { cache: false })
  const proxy = await ses.resolveProxy(target)
  const results = await Promise.all([
    probe('electron-node-fetch', fetch),
    probe('providerFetch-system-proxy', providerFetch),
    probe('electron-node-fetch', fetch, 'POST'),
    probe('providerFetch-system-proxy', providerFetch, 'POST')
  ])
  const local = await verifyLocal()
  const report = { at: new Date().toISOString(), electron: process.versions.electron, node: process.versions.node, systemProxySelected: proxy !== 'DIRECT', results, local }
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2))
  app.exit(0)
}).catch(error => {
  writeFileSync(join(root, 'result.json'), JSON.stringify({ error: error.message }))
  app.exit(1)
})
setTimeout(() => app.exit(2), 30000).unref()
