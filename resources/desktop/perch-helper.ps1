param(
  [string]$Salt = '',
  [string]$ExcludeHandles = '',
  [int]$SlowMs = 450,
  [int]$FastMs = 130
)

# 常驻窗口几何助手：只输出矩形、Z 序、前台标记与加盐 id。
# 不读取窗口标题/文本、不截图、不枚举进程名；stdin 关闭（父进程退出）即结束。
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {
}

if (-not ('MingyuePerchNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MingyuePerchNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")]
  public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassNameW(IntPtr hWnd, StringBuilder name, int count);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentProcessId();

  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT value, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
  public static extern int DwmGetWindowAttributeInt(IntPtr hWnd, int attr, out int value, int size);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  // 先申请 Per-Monitor V2；失败再退回系统级 DPI 感知。矩形始终是物理像素。
  public static void EnableDpiAwareness() {
    try {
      if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
    } catch {
    }
    try {
      SetProcessDPIAware();
    } catch {
    }
  }
}

// stdin 的异步读取必须由 .NET 线程完成；PowerShell 脚本块在别的线程上没有 runspace。
public static class MingyuePerchInput {
  private static readonly ConcurrentQueue<string> Queue = new ConcurrentQueue<string>();
  private static Thread Worker;

  public static void Start() {
    if (Worker != null) return;
    Worker = new Thread(() => {
      try {
        using (var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8)) {
          string line;
          while ((line = reader.ReadLine()) != null) Queue.Enqueue(line);
        }
      } catch {
      }
      Queue.Enqueue("__eof__");
    });
    Worker.IsBackground = true;
    Worker.Start();
  }

  public static string Next() {
    string value;
    return Queue.TryDequeue(out value) ? value : null;
  }
}
'@
}

try {
  [MingyuePerchNative]::EnableDpiAwareness()
} catch {
}

$script:excludeSet = New-Object 'System.Collections.Generic.HashSet[UInt64]'
$script:processCache = @{}
$script:idSalt = $Salt
$script:selfPid = [MingyuePerchNative]::GetCurrentProcessId()

$SensitiveProcesses = @(
  'consent', 'logonui', 'lockapp', 'winlogon', 'credentialuibroker',
  'useraccountcontrolsettings', 'securityhealthsystray',
  'keepass', 'keepassxc', '1password', 'bitwarden', 'keeper', 'dashlane',
  'lastpass', 'enpass', 'roboform',
  'cmd', 'powershell', 'pwsh', 'windowsterminal', 'wt', 'conhost',
  'openconsole', 'bash', 'wsl', 'ssh', 'mintty', 'putty', 'wezterm',
  'alacritty', 'mstsc', 'taskmgr', 'regedit', 'mmc', 'gpedit'
)
$ShellClasses = @(
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'TopLevelWindowForOverflowXamlIsland', 'IME', 'MSCTFIME UI'
)

function Set-ExcludeHandles([string]$Raw) {
  $script:excludeSet.Clear()
  foreach ($part in ($Raw -split ',')) {
    $hex = ($part.Trim() -replace '^0[xX]', '')
    if ($hex -eq '') { continue }
    try {
      [void]$script:excludeSet.Add(
        [UInt64]::Parse($hex, [System.Globalization.NumberStyles]::HexNumber)
      )
    } catch {
    }
  }
}

Set-ExcludeHandles $ExcludeHandles

function Get-ProcessKey([uint32]$ProcessId) {
  if ($script:processCache.ContainsKey($ProcessId)) {
    return $script:processCache[$ProcessId]
  }
  $name = ''
  try {
    $name = ([System.Diagnostics.Process]::GetProcessById([int]$ProcessId)).ProcessName
    if ($null -eq $name) { $name = '' }
    $name = $name.ToLowerInvariant() -replace '\.exe$', ''
  } catch {
    $name = ''
  }
  if ($script:processCache.Count -gt 512) { $script:processCache.Clear() }
  $script:processCache[$ProcessId] = $name
  return $name
}

function Get-WindowClass([IntPtr]$Handle) {
  try {
    $builder = New-Object System.Text.StringBuilder 256
    $length = [MingyuePerchNative]::GetClassNameW($Handle, $builder, 256)
    if ($length -le 0) { return '' }
    return $builder.ToString()
  } catch {
    return ''
  }
}

function Test-Cloaked([IntPtr]$Handle) {
  try {
    $cloaked = 0
    $hr = [MingyuePerchNative]::DwmGetWindowAttributeInt($Handle, 14, [ref]$cloaked, 4)
    return ($hr -eq 0 -and $cloaked -ne 0)
  } catch {
    return $false
  }
}

function Get-VisibleBounds([IntPtr]$Handle) {
  try {
    $rect = New-Object MingyuePerchNative+RECT
    $hr = [MingyuePerchNative]::DwmGetWindowAttribute($Handle, 9, [ref]$rect, 16)
    if ($hr -ne 0 -or ($rect.Right - $rect.Left) -le 0 -or ($rect.Bottom - $rect.Top) -le 0) {
      if (-not [MingyuePerchNative]::GetWindowRect($Handle, [ref]$rect)) { return $null }
    }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { return $null }
    if ($width -gt 20000 -or $height -gt 20000) { return $null }
    return [pscustomobject]@{ x = $rect.Left; y = $rect.Top; width = $width; height = $height }
  } catch {
    return $null
  }
}

function Get-HandleKey([IntPtr]$Handle) {
  # 与主进程 Buffer.readBigUInt64LE 一致：负数按二进制补码解释为 UInt64。
  return [BitConverter]::ToUInt64([BitConverter]::GetBytes($Handle.ToInt64()), 0)
}

function Get-WindowId([IntPtr]$Handle) {
  $seed = "$($script:idSalt):$($Handle.ToInt64())"
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($seed))
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant().Substring(0, 24)
  } finally {
    $sha.Dispose()
  }
}

function Get-WindowSnapshots {
  $list = New-Object System.Collections.Generic.List[object]
  $foreground = [MingyuePerchNative]::GetForegroundWindow()
  $callback = {
    param([IntPtr]$hwnd, [IntPtr]$lparam)
    try {
      if ($list.Count -ge 80) { return $false }
      if (-not [MingyuePerchNative]::IsWindowVisible($hwnd)) { return $true }
      if ([MingyuePerchNative]::IsIconic($hwnd)) { return $true }
      if (Test-Cloaked $hwnd) { return $true }

      $class = Get-WindowClass $hwnd
      if ([string]::IsNullOrWhiteSpace($class)) { return $true }
      if ($ShellClasses -contains $class) { return $true }

      $processId = [uint32]0
      [void][MingyuePerchNative]::GetWindowThreadProcessId($hwnd, [ref]$processId)
      if ($processId -eq 0 -or $processId -eq $script:selfPid) { return $true }
      $process = Get-ProcessKey $processId
      if ([string]::IsNullOrWhiteSpace($process)) { return $true }
      $sensitive = $SensitiveProcesses -contains $process

      $exStyle = [MingyuePerchNative]::GetWindowLong($hwnd, -20)
      $toolWindow = (($exStyle -band 0x80) -ne 0)
      $noActivate = (($exStyle -band 0x08000000) -ne 0)
      $transparent = (($exStyle -band 0x20) -ne 0)
      # 点击穿透的覆盖层通常不可见；既不支撑也不遮挡。
      if ($transparent) { return $true }

      $bounds = Get-VisibleBounds $hwnd
      if ($null -eq $bounds) { return $true }
      # 本应用自己的覆盖窗口完全退出几何：它既不是支撑面，也不能遮挡下面
      # 真实的窗口上沿。否则宠物页一旦变为可交互（临时关闭点击穿透），
      # 覆盖整个工作区的窗口就会把所有候选上沿“吃”掉，拖拽永远无法停靠。
      if ($script:excludeSet.Contains((Get-HandleKey $hwnd))) { return $true }
      $support = -not $sensitive -and -not $toolWindow -and -not $noActivate `
        -and $bounds.width -ge 120 -and $bounds.height -ge 80

      $list.Add([pscustomobject]@{
        id = $(if ($support) { Get-WindowId $hwnd } else { '' })
        x = $bounds.x
        y = $bounds.y
        width = $bounds.width
        height = $bounds.height
        support = [bool]$support
        foreground = ($hwnd -eq $foreground)
      })
    } catch {
      # 单个窗口失败不影响整份几何。
    }
    return $true
  }
  [void][MingyuePerchNative]::EnumWindows($callback, [IntPtr]::Zero)
  return $list
}

[MingyuePerchInput]::Start()

$slow = [Math]::Max(200, [Math]::Min(5000, $SlowMs))
$fast = [Math]::Max(60, [Math]::Min($slow, $FastMs))
$lastPayload = ''
$lastChangeAt = 0
$lastEmitAt = 0
$nextPollAt = 0
$seq = 0
$running = $true

while ($running) {
  $command = [MingyuePerchInput]::Next()
  while ($null -ne $command) {
    $trim = $command.Trim()
    if ($trim -eq '__eof__' -or $trim -eq 'quit' -or $trim -eq 'stop') {
      $running = $false
      break
    }
    if ($trim -eq 'refresh') {
      $nextPollAt = 0
    } elseif ($trim -like 'rate *') {
      $match = [regex]::Match($trim, '^rate\s+(\d+)$')
      if ($match.Success) {
        $slow = [Math]::Max(200, [Math]::Min(5000, [int]$match.Groups[1].Value))
        if ($fast -gt $slow) { $fast = $slow }
        $nextPollAt = 0
      }
    } elseif ($trim -like 'exclude *') {
      Set-ExcludeHandles ($trim.Substring(7))
      $nextPollAt = 0
    }
    $command = [MingyuePerchInput]::Next()
  }
  if (-not $running) { break }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($now -ge $nextPollAt) {
    try {
      $windows = Get-WindowSnapshots
      $payload = ConvertTo-Json -InputObject @($windows) -Compress -Depth 4
      $changed = ($payload -ne $lastPayload)
      if ($changed) {
        $lastPayload = $payload
        $lastChangeAt = $now
        $seq += 1
      }
      # 变化时立即发；稳定时每 2 秒发一次心跳，便于主进程确认助手仍活着。
      if ($changed -or ($now - $lastEmitAt) -ge 2000) {
        $line = ConvertTo-Json -InputObject ([pscustomobject]@{
          ok = $true
          seq = $seq
          at = $now
          windows = @($windows)
        }) -Compress -Depth 4
        [Console]::Out.WriteLine($line)
        [Console]::Out.Flush()
        $lastEmitAt = $now
      }
      $interval = $(if (($now - $lastChangeAt) -lt 1200) { $fast } else { $slow })
      $nextPollAt = $now + $interval
    } catch {
      # 单次轮询失败后按慢速重试；stdout 只写成功快照。
      $nextPollAt = $now + $slow
    }
  }

  Start-Sleep -Milliseconds 20
}
