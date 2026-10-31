import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { validateAppPath } from '../../worlds/system/guard'

export interface StartMenuAppCandidate {
  label: string
  path: string
  args: string[]
  /** 快捷方式创建时间（Unix ms）；用于「新应用是否继承类别授权」。 */
  installedAt?: number
}

interface ScanOptions {
  /** 默认使用 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`。 */
  powershellPath?: string
  timeoutMs?: number
}

const SCAN_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$dirs = @(
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)
$shell = New-Object -ComObject WScript.Shell
$seen = @{}
$out = @()
foreach ($dir in $dirs) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  Get-ChildItem -LiteralPath $dir -Filter *.lnk -Recurse -File |
    ForEach-Object {
      try {
        $shortcut = $shell.CreateShortcut($_.FullName)
        $target = $shortcut.TargetPath
        if ([string]::IsNullOrWhiteSpace($target)) { return }
        if (-not $target.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)) { return }
        $key = $target.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { return }
        $seen[$key] = $true
        $created = 0
        try {
          $created = [long]([DateTimeOffset]$_.CreationTimeUtc).ToUnixTimeMilliseconds()
        } catch { $created = 0 }
        $out += [pscustomobject]@{
          label = $_.BaseName
          path = $target
          args = [string]$shortcut.Arguments
          installedAt = $created
        }
      } catch { }
    }
}
ConvertTo-Json -InputObject $out -Depth 3 -Compress
`

function powershellExe(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows'
  const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(full) ? full : 'powershell.exe'
}

/**
 * 解析 Windows 命令行参数字符串。只用于给设置页生成可编辑的建议；
 * 加不加入白名单仍由用户决定。
 */
export function splitWindowsArgs(input: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  let hasToken = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (char === '\\') {
      let count = 1
      while (input[index + count] === '\\') count += 1
      if (input[index + count] === '"') {
        current += '\\'.repeat(Math.floor(count / 2))
        if (count % 2 === 1) {
          current += '"'
          index += count
          hasToken = true
          continue
        }
        index += count - 1
        continue
      }
      current += '\\'.repeat(count)
      index += count - 1
      hasToken = true
      continue
    }
    if (char === '"') {
      quoted = !quoted
      hasToken = true
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (hasToken) {
        out.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += char
    hasToken = true
  }
  if (hasToken) out.push(current)
  return out.filter((value) => value !== '')
}

/**
 * 扫描开始菜单快捷方式，返回可加入白名单的 .exe 候选。
 * 只读取快捷方式目标，不启动任何东西。
 */
export function scanStartMenuApps(opts: ScanOptions = {}): Promise<StartMenuAppCandidate[]> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  return new Promise((resolve) => {
    execFile(
      opts.powershellPath ?? powershellExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCAN_SCRIPT],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null || stdout.trim() === '') {
          resolve([])
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(stdout)
        } catch {
          resolve([])
          return
        }
        const rows = Array.isArray(parsed) ? parsed : [parsed]
        const out: StartMenuAppCandidate[] = []
        const seen = new Set<string>()
        for (const row of rows) {
          if (row === null || typeof row !== 'object') continue
          const record = row as Record<string, unknown>
          const label = typeof record['label'] === 'string' ? record['label'].trim() : ''
          const path = typeof record['path'] === 'string' ? record['path'].trim() : ''
          const argsText = typeof record['args'] === 'string' ? record['args'] : ''
          const installedAtRaw =
            typeof record['installedAt'] === 'number' && Number.isFinite(record['installedAt'])
              ? record['installedAt']
              : 0
          if (label === '' || path === '') continue
          let real: string
          try {
            real = validateAppPath(path).real
          } catch {
            continue
          }
          const key = real.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          out.push({
            label: label.slice(0, 80),
            path: real,
            args: splitWindowsArgs(argsText).map((value) => value.slice(0, 200)).slice(0, 20),
            ...(installedAtRaw > 0 ? { installedAt: installedAtRaw } : {})
          })
          if (out.length >= 200) break
        }
        resolve(out)
      }
    )
  })
}
