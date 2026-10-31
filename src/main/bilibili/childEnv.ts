/**
 * B 站相关子进程的环境。
 *
 * 应用自身只通过 initialize `_meta` 传 Cookie，从不写入环境变量；这里再剥掉
 * 用户 shell 里可能残留的 B 站登录变量，避免子进程意外读到一份“环境里的
 * 凭据”。Windows 环境变量名大小写不敏感，因此按小写集合匹配。
 */
const CREDENTIAL_ENV_KEYS = new Set([
  'sessdata',
  'bili_jct',
  'buvid3',
  'dedeuserid',
  'dedeuserid__ckmd5',
  'sid',
  'bili_ticket',
  'bili_ticket_expires',
  'ac_time_value'
])

export function biliChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_ENV_KEYS.has(key.toLowerCase())) delete env[key]
  }
  return env
}
