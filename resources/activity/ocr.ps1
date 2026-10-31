# 桌宠 OCR helper (Windows.Media.Ocr)
# 从 stdin 读取 { "imageBase64": "...", "lang": "auto|zh-Hans-CN|en-US", "maxChars": 4000 }
# BitmapDecoder 自动识别 PNG/JPEG；pngBase64 仅为旧版调用兼容。
# 只向 stdout 写一行 JSON；不落盘、不联网。
param([switch]$Probe)

$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
} catch {
  # 某些宿主不允许改编码；继续用默认值。
}

function Write-Result($value) {
  $json = $value | ConvertTo-Json -Compress -Depth 8
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

  if ($Probe) {
    $languages = @()
    try {
      $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
    } catch {
      $languages = @()
    }
    Write-Result @{ ok = $true; probe = $true; languages = $languages }
    exit 0
  }

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

  if ($null -eq $asTaskGeneric) {
    throw 'WinRT AsTask 不可用'
  }

  function Await($operation, $resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    if ($task.IsFaulted) {
      throw $task.Exception.GetBaseException()
    }
    return $task.Result
  }

  $rawInput = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($rawInput)) {
    throw 'stdin 为空'
  }
  $request = $rawInput | ConvertFrom-Json
  $encoded = [string]$request.imageBase64
  if ([string]::IsNullOrWhiteSpace($encoded)) { $encoded = [string]$request.pngBase64 }
  if ([string]::IsNullOrWhiteSpace($encoded)) {
    throw '缺少 imageBase64'
  }

  $bytes = [Convert]::FromBase64String($encoded)
  if ($bytes.Length -eq 0) {
    throw '图片数据为空'
  }

  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  try {
    $writer = New-Object Windows.Storage.Streams.DataWriter($stream)
    try {
      $writer.WriteBytes($bytes)
      $storeOp = $writer.StoreAsync()
      $null = Await $storeOp ([uint32])
      $writer.DetachStream() | Out-Null
    } finally {
      $writer.Dispose()
    }

    $stream.Seek(0) | Out-Null
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
      $engine = $null
      $requested = ([string]$request.lang).Trim()
      if ($requested -ne '' -and $requested -ne 'auto') {
        try {
          $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($requested))
        } catch {
          $engine = $null
        }
      }
      if ($null -eq $engine) {
        foreach ($tag in @('zh-Hans-CN', 'zh-CN', 'en-US')) {
          try {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($tag))
          } catch {
            $engine = $null
          }
          if ($null -ne $engine) { break }
        }
      }
      if ($null -eq $engine) {
        try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { $engine = $null }
      }
      if ($null -eq $engine) {
        throw '没有可用的 OCR 语言包（请在 Windows 设置中安装中文或英文 OCR）'
      }

      $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $lines = @()
      foreach ($line in $ocr.Lines) {
        if (-not [string]::IsNullOrWhiteSpace($line.Text)) { $lines += $line.Text }
      }
      $text = ($lines -join "`n")
      $maxChars = 4000
      if ($null -ne $request.maxChars) {
        try {
          $maxChars = [Math]::Max(100, [Math]::Min(20000, [int]$request.maxChars))
        } catch {
          $maxChars = 4000
        }
      }
      if ($text.Length -gt $maxChars) {
        $text = $text.Substring(0, $maxChars)
      }

      Write-Result @{
        ok = $true
        text = $text
        lines = $lines.Count
        lang = $engine.RecognizerLanguage.LanguageTag
      }
    } finally {
      $bitmap.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
} catch {
  Write-Result @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
