import { app, session, type Session } from 'electron'

let providerSession: Session | undefined

/**
 * 主进程模型请求使用 Chromium 的系统代理解析。
 * 独立的内存会话避免命中 defaultSession 的渲染器外网拦截，
 * 也不共享用户浏览器的 cookie、缓存或登录态。
 */
export const providerFetch: typeof fetch = async (input, init) => {
  await app.whenReady()
  providerSession ??= session.fromPartition('mingyue-provider', { cache: false })
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('模型接口只支持 HTTP/HTTPS')
  }
  return providerSession.fetch(input instanceof URL ? input.href : input, {
    ...init,
    credentials: 'omit',
    cache: 'no-store',
    bypassCustomProtocolHandlers: true
  })
}
