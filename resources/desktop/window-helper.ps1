param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('list', 'read', 'focus', 'capture', 'list-apps', 'elements', 'act')]
  [string]$Action,
  [string]$AllowProcesses = '',
  [string]$WindowId = '',
  [string]$Salt = '',
  [int]$MaxChars = 8000,
  [int]$MaxElements = 120,
  [string]$ElementId = '',
  [ValidateSet('', 'invoke', 'set_value', 'select', 'toggle', 'expand', 'collapse', 'scroll', 'focus')]
  [string]$ElementAction = '',
  [string]$Value = ''
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {
  # 旧版 PowerShell 可能不支持；JSON 仍然是 ASCII 安全输出。
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ('MingyueWindowNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class MingyueWindowNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  // 先申请 Per-Monitor V2，再退回系统级 DPI 感知。这样 GetWindowRect 与
  // PrintWindow 都使用物理像素，主进程才能可靠地换算到 Electron DIP。
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
'@
}

# 必须在任何窗口/绘图 API 之前设置；否则高 DPI 下窗口边界会被系统虚拟化。
try {
  [MingyueWindowNative]::EnableDpiAwareness()
} catch {
  # 旧系统缺少 API 时继续使用默认感知；坐标换算仍失败关闭。
}

# 固定敏感名单：密码管理器、终端、系统安全、远程管理。与 CUA guard 保持一致。
$SensitiveProcesses = @(
  'consent', 'logonui', 'lockapp', 'winlogon', 'credentialuibroker',
  'useraccountcontrolsettings', 'securityhealthsystray',
  'keepass', 'keepassxc', '1password', 'bitwarden', 'keeper', 'dashlane',
  'lastpass', 'enpass', 'roboform',
  'cmd', 'powershell', 'pwsh', 'windowsterminal', 'wt', 'conhost',
  'openconsole', 'bash', 'wsl', 'ssh', 'mintty', 'putty', 'wezterm',
  'alacritty', 'mstsc', 'taskmgr', 'regedit', 'mmc', 'gpedit'
)
$SensitiveTitleTerms = @(
  '银行', '支付', '付款', '转账', '密码', '验证码', '双重验证',
  'bank', 'payment', 'password', 'passcode', '2fa', 'authenticator',
  'verification code'
)

function Get-ProcessKey([uint32]$ProcessId) {
  try {
    $process = [System.Diagnostics.Process]::GetProcessById([int]$ProcessId)
    $name = $process.ProcessName.ToLowerInvariant()
    return ($name -replace '\.exe$', '')
  } catch {
    return $null
  }
}

function Get-WindowTitle([IntPtr]$Handle) {
  try {
    $length = [MingyueWindowNative]::GetWindowTextLengthW($Handle)
    if ($length -le 0) { return '' }
    $builder = New-Object System.Text.StringBuilder ($length + 2)
    [void][MingyueWindowNative]::GetWindowTextW($Handle, $builder, $builder.Capacity)
    return $builder.ToString()
  } catch {
    return ''
  }
}

function Test-SensitiveTitle([string]$Title) {
  if ([string]::IsNullOrWhiteSpace($Title)) { return $false }
  $lower = $Title.ToLowerInvariant()
  foreach ($term in $SensitiveTitleTerms) {
    if ($lower.Contains($term)) { return $true }
  }
  return $false
}

function Get-WindowBounds([IntPtr]$Handle) {
  try {
    $rect = New-Object MingyueWindowNative+RECT
    if (-not [MingyueWindowNative]::GetWindowRect($Handle, [ref]$rect)) { return $null }
    return [pscustomobject]@{
      x = $rect.Left
      y = $rect.Top
      width = $rect.Right - $rect.Left
      height = $rect.Bottom - $rect.Top
    }
  } catch {
    return $null
  }
}

function Get-WindowId([IntPtr]$Handle, [string]$SaltValue) {
  $input = "$SaltValue`:$($Handle.ToInt64())"
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($input))
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant().Substring(0, 24)
  } finally {
    $sha.Dispose()
  }
}

function Get-AllowedProcesses {
  $set = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($raw in ($AllowProcesses -split ',')) {
    $key = $raw.Trim().ToLowerInvariant()
    $key = $key -replace '^.*[\\/]', ''
    $key = $key -replace '\.exe$', ''
    if ($key -ne '') { [void]$set.Add($key) }
  }
  return $set
}

function Get-VisibleWindows {
  $result = New-Object System.Collections.Generic.List[object]
  $foreground = [MingyueWindowNative]::GetForegroundWindow()
  $callback = {
    param([IntPtr]$hwnd, [IntPtr]$lparam)
    try {
      if (-not [MingyueWindowNative]::IsWindowVisible($hwnd)) { return $true }
      $title = Get-WindowTitle $hwnd
      if ([string]::IsNullOrWhiteSpace($title)) { return $true }
      $pidValue = [uint32]0
      [void][MingyueWindowNative]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
      if ($pidValue -eq 0) { return $true }
      $process = Get-ProcessKey $pidValue
      if ([string]::IsNullOrWhiteSpace($process)) { return $true }
      $result.Add([pscustomobject]@{
        handle = $hwnd
        title = $title
        process = $process
        foreground = ($hwnd -eq $foreground)
      })
    } catch {
      # 单个窗口枚举失败不能中止整次清单。
    }
    return $true
  }
  [void][MingyueWindowNative]::EnumWindows($callback, [IntPtr]::Zero)
  return $result
}

function Find-TargetWindow([string]$Id, $Allowed) {
  if ([string]::IsNullOrWhiteSpace($Id) -or [string]::IsNullOrWhiteSpace($Salt)) {
    return $null
  }
  $windows = Get-VisibleWindows
  foreach ($window in $windows) {
    if ((Get-WindowId $window.handle $Salt) -ne $Id) { continue }
    if ([string]::IsNullOrWhiteSpace($window.process)) { return $null }
    if ($SensitiveProcesses -contains $window.process) {
      return [pscustomobject]@{ error = 'window-not-allowed'; window = $null }
    }
    if (-not $Allowed.Contains($window.process)) {
      return [pscustomobject]@{ error = 'window-not-allowed'; window = $null }
    }
    if (Test-SensitiveTitle $window.title) {
      return [pscustomobject]@{ error = 'window-sensitive'; window = $null }
    }
    return [pscustomobject]@{ error = $null; window = $window }
  }
  return $null
}

function Truncate-Text([string]$Text, [int]$Limit) {
  if ([string]::IsNullOrEmpty($Text)) { return $Text }
  if ($Text.Length -le $Limit) { return $Text }
  return $Text.Substring(0, $Limit) + '...'
}

function Get-ElementDigest([string]$InputText) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($InputText))
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant().Substring(0, 16)
  } finally {
    $sha.Dispose()
  }
}

function Get-ElementKey($Element, [string]$PathKey) {
  try {
    $runtime = $Element.GetRuntimeId()
    if ($null -ne $runtime -and $runtime.Length -gt 0) {
      return ($runtime -join '.')
    }
  } catch {
  }
  return $PathKey
}

function Get-ElementActions($Element) {
  $actions = New-Object System.Collections.Generic.List[string]
  try {
    [void]$Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    [void]$actions.Add('invoke')
  } catch {
  }
  try {
    $valuePattern = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if (-not $valuePattern.Current.IsReadOnly) { [void]$actions.Add('set_value') }
  } catch {
  }
  try {
    [void]$Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    [void]$actions.Add('select')
  } catch {
  }
  try {
    [void]$Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    [void]$actions.Add('toggle')
  } catch {
  }
  try {
    $expand = $Element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    $state = $expand.Current.ExpandCollapseState
    if ($state -ne [System.Windows.Automation.ExpandCollapseState]::LeafNode) {
      [void]$actions.Add('expand')
      [void]$actions.Add('collapse')
    }
  } catch {
  }
  try {
    [void]$Element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    [void]$actions.Add('scroll')
  } catch {
  }
  [void]$actions.Add('focus')
  return $actions
}

function Get-ElementBounds($Current) {
  try {
    $rect = $Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { return $null }
    return [pscustomobject]@{
      x = [int]$rect.X
      y = [int]$rect.Y
      width = [int]$rect.Width
      height = [int]$rect.Height
    }
  } catch {
    return $null
  }
}

function Collect-Elements([IntPtr]$Handle, [string]$SaltValue, [int]$Limit) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
  if ($null -eq $root) { return $null }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $items = New-Object System.Collections.Generic.List[object]
  $state = @{
    truncated = $false
    sensitive = (Test-SensitiveTitle (Get-WindowTitle $Handle))
  }
  function Walk($element, [int]$depth, [string]$pathKey) {
    if ($state.truncated) { return }
    if ($items.Count -ge $Limit) {
      $state.truncated = $true
      return
    }
    try {
      $current = $element.Current
      if (-not $current.IsOffscreen -and -not $current.IsPassword) {
        $name = [string]$current.Name
        $role = ([string]$current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
        $value = $null
        try {
          $valuePattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          $value = [string]$valuePattern.Current.Value
        } catch {
          $value = $null
        }
        if (Test-SensitiveTitle ($name + ' ' + [string]$value)) { $state.sensitive = $true }
        $runtimeKey = Get-ElementKey $element $pathKey
        $id = Get-ElementDigest "$SaltValue`:$($Handle.ToInt64()):$runtimeKey"
        $items.Add([pscustomobject]@{
          id = $id
          role = $role
          name = (Truncate-Text $name 120)
          value = $(if ($null -eq $value) { $null } else { Truncate-Text $value 200 })
          enabled = [bool]$current.IsEnabled
          actions = (Get-ElementActions $element)
          bounds = (Get-ElementBounds $current)
        })
      }
    } catch {
      # 单个元素不可访问时继续遍历。
    }
    if ($depth -ge 8) { return }
    $index = 0
    try {
      $child = $walker.GetFirstChild($element)
      while ($null -ne $child) {
        Walk $child ($depth + 1) "$pathKey.$index"
        if ($state.truncated) { return }
        $child = $walker.GetNextSibling($child)
        $index += 1
      }
    } catch {
      # 子树遍历失败时保留已收集内容。
    }
  }
  Walk $root 0 'r'
  return @{ items = $items; truncated = $state.truncated; sensitive = $state.sensitive }
}

function Find-ElementById([IntPtr]$Handle, [string]$SaltValue, [string]$TargetId) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
  if ($null -eq $root) { return $null }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $script:matchedElement = $null
  $script:visitedElements = 0
  function Search($element, [int]$depth, [string]$pathKey) {
    if ($null -ne $script:matchedElement) { return }
    $script:visitedElements += 1
    if ($script:visitedElements -gt 4000) { return }
    try {
      $current = $element.Current
      if (-not $current.IsPassword) {
        $runtimeKey = Get-ElementKey $element $pathKey
        $id = Get-ElementDigest "$SaltValue`:$($Handle.ToInt64()):$runtimeKey"
        if ($id -eq $TargetId) {
          $script:matchedElement = $element
          return
        }
      }
    } catch {
    }
    if ($depth -ge 10) { return }
    $index = 0
    try {
      $child = $walker.GetFirstChild($element)
      while ($null -ne $child) {
        Search $child ($depth + 1) "$pathKey.$index"
        if ($null -ne $script:matchedElement) { return }
        $child = $walker.GetNextSibling($child)
        $index += 1
      }
    } catch {
    }
  }
  Search $root 0 'r'
  return $script:matchedElement
}

function Get-ElementValue($Element) {
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return [string]$pattern.Current.Value
  } catch {
    return $null
  }
}

function Get-ElementToggleState($Element) {
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    return [string]$pattern.Current.ToggleState
  } catch {
    return $null
  }
}

function Get-ElementExpandedState($Element) {
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    return [string]$pattern.Current.ExpandCollapseState
  } catch {
    return $null
  }
}

function Get-ElementSelected($Element) {
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    return [bool]$pattern.Current.IsSelected
  } catch {
    return $null
  }
}

function Get-ElementScrollPercent($Element) {
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    return [double]$pattern.Current.VerticalScrollPercent
  } catch {
    return $null
  }
}

function Write-Json($Value) {
  $Value | ConvertTo-Json -Compress -Depth 8
  exit 0
}

function Write-Failure([string]$Code, [string]$Message) {
  Write-Json ([pscustomobject]@{ ok = $false; code = $Code; error = $Message })
}

if ($Action -eq 'list-apps') {
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  $apps = New-Object System.Collections.Generic.List[string]
  foreach ($window in (Get-VisibleWindows)) {
    if ($SensitiveProcesses -contains $window.process) { continue }
    if (Test-SensitiveTitle $window.title) { continue }
    if ($seen.Add($window.process)) { $apps.Add($window.process) }
  }
  Write-Json ([pscustomobject]@{ ok = $true; apps = $apps })
  exit 0
}

$allowed = Get-AllowedProcesses
if ($allowed.Count -eq 0) {
  Write-Failure 'scope-empty' '没有允许观察的进程'
  exit 0
}

if ($Action -eq 'list') {
  $foreground = [MingyueWindowNative]::GetForegroundWindow()
  $items = New-Object System.Collections.Generic.List[object]
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($window in (Get-VisibleWindows)) {
    if ($SensitiveProcesses -contains $window.process) { continue }
    if (-not $allowed.Contains($window.process)) { continue }
    if (Test-SensitiveTitle $window.title) { continue }
    $id = Get-WindowId $window.handle $Salt
    if (-not $seen.Add($id)) { continue }
    $items.Add([pscustomobject]@{
      id = $id
      process = $window.process
      title = $window.title
      foreground = ($window.handle -eq $foreground)
      bounds = (Get-WindowBounds $window.handle)
    })
  }
  Write-Json ([pscustomobject]@{ ok = $true; windows = $items })
  exit 0
}

$target = Find-TargetWindow $WindowId $allowed
if ($null -eq $target) {
  Write-Failure 'window-not-found' '窗口不存在、已关闭或窗口 id 已失效'
  exit 0
}
if ($target.error -ne $null) {
  Write-Failure $target.error '目标窗口不在当前观察范围，或属于敏感类别'
  exit 0
}
$window = $target.window

if ($Action -eq 'focus') {
  try {
    [void][MingyueWindowNative]::ShowWindow($window.handle, 9)
    $ok = [MingyueWindowNative]::SetForegroundWindow($window.handle)
    Write-Json ([pscustomobject]@{ ok = [bool]$ok; focused = [bool]$ok })
  } catch {
    Write-Failure 'focus-failed' '无法把窗口切换到前台'
  }
  exit 0
}

if ($Action -eq 'elements') {
  $limit = [Math]::Max(1, [Math]::Min(200, $MaxElements))
  try {
    $collected = Collect-Elements $window.handle $Salt $limit
    if ($null -eq $collected) {
      Write-Failure 'uia-unavailable' '无法读取该窗口的界面元素'
      exit 0
    }
    Write-Json ([pscustomobject]@{
      ok = $true
      elements = $collected.items
      truncated = [bool]$collected.truncated
      sensitive = [bool]$collected.sensitive
    })
  } catch {
    Write-Failure 'uia-unavailable' 'UI Automation 不可用或该窗口拒绝访问'
  }
  exit 0
}

if ($Action -eq 'act') {
  if ([string]::IsNullOrWhiteSpace($ElementId)) {
    Write-Failure 'element-missing' '缺少 elementId'
    exit 0
  }
  if ([string]::IsNullOrWhiteSpace($ElementAction)) {
    Write-Failure 'action-missing' '缺少控件动作'
    exit 0
  }
  $element = Find-ElementById $window.handle $Salt $ElementId
  if ($null -eq $element) {
    Write-Failure 'element-not-found' '控件不存在或控件树已变化；请重新 win_elements 定位'
    exit 0
  }
  try {
    if ($element.Current.IsPassword) {
      Write-Failure 'element-not-allowed' '密码框不能操作'
      exit 0
    }
  } catch {
    Write-Failure 'element-not-found' '控件已失效；请重新 win_elements 定位'
    exit 0
  }

  $beforeValue = Get-ElementValue $element
  $beforeToggle = Get-ElementToggleState $element
  $beforeExpanded = Get-ElementExpandedState $element
  $beforeSelected = Get-ElementSelected $element
  $beforeScroll = Get-ElementScrollPercent $element
  $verification = 'not-observable'

  try {
    switch ($ElementAction) {
      'invoke' {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        if ($null -eq $pattern) { Write-Failure 'pattern-unavailable' '该控件没有 Invoke 模式'; exit 0 }
        $pattern.Invoke()
      }
      'set_value' {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($null -eq $pattern) { Write-Failure 'pattern-unavailable' '该控件不支持设置值'; exit 0 }
        if ($pattern.Current.IsReadOnly) { Write-Failure 'pattern-unavailable' '该控件是只读的'; exit 0 }
        $pattern.SetValue($Value)
        $verification = 'value'
      }
      'select' {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($null -eq $pattern) { Write-Failure 'pattern-unavailable' '该控件不支持选择'; exit 0 }
        $pattern.Select()
        $verification = 'selected'
      }
      'toggle' {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if ($null -eq $pattern) { Write-Failure 'pattern-unavailable' '该控件不支持切换'; exit 0 }
        $pattern.Toggle()
        $verification = 'toggled'
      }
      'expand' {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($null -eq $pattern) { Write-Failure 'pattern-unavailable' '该控件不支持展开'; exit 0 }
        $pattern.Expand()
        $verification = 'expanded'
      }
      'collapse' {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($null -eq $pattern) { Write-Failure 'pattern-unavailable' '该控件不支持折叠'; exit 0 }
        $pattern.Collapse()
        $verification = 'collapsed'
      }
      'scroll' {
        $direction = $Value.Trim().ToLowerInvariant()
        if ($direction -eq '') { $direction = 'down' }
        $scrollPattern = $null
        try {
          $scrollPattern = $element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
        } catch {
          $scrollPattern = $null
        }
        if ($null -ne $scrollPattern) {
          $noAmount = [System.Windows.Automation.ScrollAmount]::NoAmount
          $large = [System.Windows.Automation.ScrollAmount]::LargeIncrement
          $back = [System.Windows.Automation.ScrollAmount]::LargeDecrement
          switch ($direction) {
            'up' { $scrollPattern.Scroll($back, $noAmount) }
            'down' { $scrollPattern.Scroll($large, $noAmount) }
            'left' { $scrollPattern.Scroll($noAmount, $back) }
            'right' { $scrollPattern.Scroll($noAmount, $large) }
            default { Write-Failure 'value-invalid' 'scroll 只接受 up/down/left/right'; exit 0 }
          }
          $verification = 'scrolled'
        } else {
          try {
            $itemPattern = $element.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
            $itemPattern.ScrollIntoView()
            $verification = 'not-observable'
          } catch {
            Write-Failure 'pattern-unavailable' '该控件不支持滚动'
            exit 0
          }
        }
      }
      'focus' {
        $element.SetFocus()
        $verification = 'focused'
      }
      default {
        Write-Failure 'action-invalid' '不支持的控件动作'
        exit 0
      }
    }
  } catch {
    Write-Failure 'action-failed' '控件动作执行失败'
    exit 0
  }

  Start-Sleep -Milliseconds 180
  $valueAfter = Get-ElementValue $element
  $verified = $false
  try {
    switch ($verification) {
      'value' { $verified = ($null -ne $valueAfter -and $valueAfter -eq $Value) }
      'selected' {
        $afterSelected = Get-ElementSelected $element
        $verified = ($afterSelected -eq $true)
      }
      'toggled' {
        $afterToggle = Get-ElementToggleState $element
        $verified = ($null -ne $beforeToggle -and $null -ne $afterToggle -and $beforeToggle -ne $afterToggle)
      }
      'expanded' {
        $afterExpanded = Get-ElementExpandedState $element
        $verified = ($afterExpanded -eq 'Expanded' -or $afterExpanded -eq 'PartiallyExpanded')
      }
      'collapsed' {
        $afterExpanded = Get-ElementExpandedState $element
        $verified = ($afterExpanded -eq 'Collapsed')
      }
      'scrolled' {
        $afterScroll = Get-ElementScrollPercent $element
        $verified = ($null -ne $beforeScroll -and $null -ne $afterScroll -and [Math]::Abs($afterScroll - $beforeScroll) -gt 0.01)
      }
      'focused' {
        try { $verified = [bool]$element.Current.HasKeyboardFocus } catch { $verified = $false }
      }
      default { $verified = $false }
    }
  } catch {
    $verified = $false
  }

  Write-Json ([pscustomobject]@{
    ok = $true
    executed = $true
    verified = [bool]$verified
    verification = $verification
    valueAfter = $(if ($null -eq $valueAfter) { $null } else { Truncate-Text ([string]$valueAfter) 200 })
  })
  exit 0
}

if ($Action -eq 'capture') {
  if ([MingyueWindowNative]::IsIconic($window.handle)) {
    Write-Failure 'window-minimized' '窗口已最小化；请先 win_focus 再重新截图'
    exit 0
  }
  $windowBounds = Get-WindowBounds $window.handle
  if ($null -eq $windowBounds) {
    Write-Failure 'capture-failed' '无法读取窗口边界'
    exit 0
  }
  $width = [int]$windowBounds.width
  $height = [int]$windowBounds.height
  if ($width -le 0 -or $height -le 0 -or $width -gt 10000 -or $height -gt 10000) {
    Write-Failure 'capture-failed' '窗口尺寸无效'
    exit 0
  }
  try {
    $bitmap = New-Object System.Drawing.Bitmap ($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    try {
      # PW_RENDERFULLCONTENT：只渲染目标窗口自身，不包含屏幕其他区域。
      $ok = [MingyueWindowNative]::PrintWindow($window.handle, $hdc, 2)
    } finally {
      $graphics.ReleaseHdc($hdc)
      $graphics.Dispose()
    }
    if (-not $ok) {
      $bitmap.Dispose()
      Write-Failure 'capture-unavailable' '该窗口不支持按窗口截图；请让用户把窗口切到前台后手动查看'
      exit 0
    }
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    $base64 = [Convert]::ToBase64String($stream.ToArray())
    $stream.Dispose()
    Write-Json ([pscustomobject]@{
      ok = $true
      mimeType = 'image/png'
      width = $width
      height = $height
      bounds = $windowBounds
      base64 = $base64
    })
  } catch {
    Write-Failure 'capture-failed' '按窗口截图失败'
  }
  exit 0
}

if ($Action -eq 'read') {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window.handle)
    if ($null -eq $root) {
      Write-Failure 'uia-unavailable' '无法读取该窗口的界面元素'
      exit 0
    }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $lines = New-Object System.Collections.Generic.List[string]
    $state = @{ count = 0; length = 0; truncated = $false; sensitive = (Test-SensitiveTitle $window.title) }

    function Walk-Element($element, [int]$depth) {
      if ($state.truncated -or $state.count -ge 400) { return }
      $state.count += 1
      try {
        $current = $element.Current
        $isOffscreen = $current.IsOffscreen
        $isPassword = $current.IsPassword
        if (-not $isOffscreen -and -not $isPassword) {
          $name = [string]$current.Name
          $type = ([string]$current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
          $value = ''
          try {
            $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $value = [string]$pattern.Current.Value
          } catch {
            $value = ''
          }
          $line = ''
          if (-not [string]::IsNullOrWhiteSpace($name)) { $line += "$name" }
          if (-not [string]::IsNullOrWhiteSpace($type)) {
            $line += $(if ($line -eq '') { "[$type]" } else { " [$type]" })
          }
          if (-not [string]::IsNullOrWhiteSpace($value)) { $line += ": $value" }
          $line = $line.Trim()
          if ($line -ne '') {
            if (Test-SensitiveTitle $line) { $state.sensitive = $true }
            $lines.Add($line)
            $state.length += $line.Length + 1
            if ($state.length -ge $MaxChars) {
              $state.truncated = $true
              return
            }
          }
        }
      } catch {
        # 单个元素读取失败不影响其余内容。
      }
      if ($depth -ge 6) { return }
      try {
        $child = $walker.GetFirstChild($element)
        while ($null -ne $child) {
          Walk-Element $child ($depth + 1)
          if ($state.truncated) { return }
          $child = $walker.GetNextSibling($child)
        }
      } catch {
        # 子树遍历失败时保留已读取内容。
      }
    }

    Walk-Element $root 0
    $text = ($lines -join "`n")
    if ($text.Length -gt $MaxChars) {
      $text = $text.Substring(0, $MaxChars)
      $state.truncated = $true
    }
    Write-Json ([pscustomobject]@{
      ok = $true
      text = $text
      truncated = [bool]$state.truncated
      uiaAvailable = $true
      sensitive = [bool]$state.sensitive
    })
  } catch {
    Write-Failure 'uia-unavailable' 'UI Automation 不可用或该窗口拒绝访问'
  }
  exit 0
}

Write-Failure 'bad-action' '未知操作'
