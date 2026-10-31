# 桌宠 · 只读前台进程采样辅助脚本
#
# 契约（见 src/worlds/activity/foreground.ts）：
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File foreground-helper.ps1 -IntervalMs 2000
#
# 每个采样周期向 stdout 写一行紧凑 JSON：
#   {"processName":"code","title":"...","bounds":{"x":0,"y":0,"width":1920,"height":1080},"minimized":false,"windowId":"123456"}
#   或 {"processName":null,"title":null,"bounds":null,"minimized":false,"windowId":null}
# 只读取前台窗口所属进程的可执行名、窗口标题、窗口矩形与 HWND；不读取
# URL、路径、剪贴板或输入内容，不读取页面正文，不做任何窗口/进程操作，
# 不需要管理员权限。windowId 只在本机内存里用于区分同应用的不同窗口，
# 主进程会再哈希，不写日志、不进事件或模型上下文。
# 标题最多 300 个字符，脱敏与是否共享由主进程 ActivityWorld 决定；本脚本不落盘。
#
# 所有异常都被吞掉并输出 null，让主进程的看门狗负责重启/降级，脚本自身不退出。

param(
  [int]$IntervalMs = 2000
)

$ErrorActionPreference = 'Stop'

# 主进程按 UTF-8 解析 stdout；Windows PowerShell 5.1 重定向时默认不是 UTF-8。
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
  # 极老系统上设置失败也不影响 ASCII 进程名。
}

if ($IntervalMs -lt 500) { $IntervalMs = 500 }
if ($IntervalMs -gt 60000) { $IntervalMs = 60000 }

if (-not ('MingYue.ForegroundWindow' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace MingYue {
    [StructLayout(LayoutKind.Sequential)]
    public struct WindowRect {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static class ForegroundWindow {
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern int GetWindowTextLength(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out WindowRect rect);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4；旧系统不存在时忽略。
        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    }
}
'@
}

# 让 GetWindowRect 返回真实屏幕像素；否则在不同缩放的多显示器上会拿到
# 被系统虚拟化的坐标，观察目标可能选错屏幕。失败时继续用默认行为。
try {
  if (-not [MingYue.ForegroundWindow]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
    [void][MingYue.ForegroundWindow]::SetProcessDPIAware()
  }
} catch {
  try { [void][MingYue.ForegroundWindow]::SetProcessDPIAware() } catch { }
}

# 注意：$PID 是 PowerShell 自动变量，不能复用。
function Get-ForegroundWindowInfo {
  $handle = [MingYue.ForegroundWindow]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) { return $null }

  [uint32]$targetPid = 0
  [void][MingYue.ForegroundWindow]::GetWindowThreadProcessId($handle, [ref]$targetPid)
  if ($targetPid -eq 0) { return $null }

  $process = Get-Process -Id $targetPid -ErrorAction Stop
  if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.ProcessName)) {
    return $null
  }

  $title = $null
  try {
    $length = [MingYue.ForegroundWindow]::GetWindowTextLength($handle)
    if ($length -gt 0) {
      $buffer = New-Object System.Text.StringBuilder ($length + 1)
      [void][MingYue.ForegroundWindow]::GetWindowText($handle, $buffer, $buffer.Capacity)
      $title = $buffer.ToString().Trim()
      if ($title -eq '') { $title = $null }
      elseif ($title.Length -gt 300) { $title = $title.Substring(0, 300) }
    }
  } catch {
    # UWP/提权窗口可能读不到标题；按 null 处理，不重试、不记录。
    $title = $null
  }

  $bounds = $null
  $minimized = $false
  try {
    $minimized = [MingYue.ForegroundWindow]::IsIconic($handle)
    $rect = New-Object MingYue.WindowRect
    if ([MingYue.ForegroundWindow]::GetWindowRect($handle, [ref]$rect)) {
      $width = $rect.Right - $rect.Left
      $height = $rect.Bottom - $rect.Top
      if ($width -gt 0 -and $height -gt 0) {
        $bounds = [ordered]@{
          x = [int]$rect.Left
          y = [int]$rect.Top
          width = [int]$width
          height = [int]$height
        }
      }
    }
  } catch {
    # 最小化/提权/UWP 窗口可能拿不到矩形；保留 null，不猜测。
    $bounds = $null
  }

  # ProcessName 本身不含路径。
  return [ordered]@{
    processName = [string]$process.ProcessName
    title = $title
    bounds = $bounds
    minimized = [bool]$minimized
    # HWND 是十进制指针值；只在主进程内存里做不透明标识，不进入日志。
    windowId = [string]$handle.ToInt64()
  }
}

while ($true) {
  $info = $null
  try {
    $info = Get-ForegroundWindowInfo
  } catch {
    $info = $null
  }

  try {
    if ($null -eq $info) {
      $payload = [ordered]@{ processName = $null; title = $null; bounds = $null; minimized = $false; windowId = $null }
    } else {
      $payload = $info
    }
    $line = ConvertTo-Json -Compress -InputObject $payload
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  } catch {
    # stdout 被关闭（应用退出）时结束循环。
    break
  }

  try {
    Start-Sleep -Milliseconds $IntervalMs
  } catch {
    break
  }
}
