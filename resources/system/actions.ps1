param(
  [Parameter(Mandatory = $true)]
  [ValidateSet(
    'volume_up',
    'volume_down',
    'mute_toggle',
    'media_play_pause',
    'media_next',
    'media_prev',
    'lock'
  )]
  [string]$Action
)

$ErrorActionPreference = 'Stop'

Add-Type -Language CSharp @"
using System;
using System.Runtime.InteropServices;

public static class MingyueAudio
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorComObject { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int NotImpl1();
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        int NotImpl1();
        int NotImpl2();
        int GetChannelCount(out int pnChannelCount);
        int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
        int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
        int GetMasterVolumeLevel(out float pfLevelDB);
        int GetMasterVolumeLevelScalar(out float pfLevel);
        int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
        int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
        int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
        int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    }

    private static IAudioEndpointVolume Endpoint()
    {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice device;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
        var iid = typeof(IAudioEndpointVolume).GUID;
        object obj;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out obj));
        return (IAudioEndpointVolume)obj;
    }

    public static void Change(float delta)
    {
        var endpoint = Endpoint();
        float current;
        Marshal.ThrowExceptionForHR(endpoint.GetMasterVolumeLevelScalar(out current));
        if (delta > 0f)
        {
            bool muted;
            Marshal.ThrowExceptionForHR(endpoint.GetMute(out muted));
            if (muted)
            {
                Marshal.ThrowExceptionForHR(endpoint.SetMute(false, Guid.Empty));
            }
        }
        float next = Math.Min(1f, Math.Max(0f, current + delta));
        Marshal.ThrowExceptionForHR(endpoint.SetMasterVolumeLevelScalar(next, Guid.Empty));
    }

    public static void ToggleMute()
    {
        var endpoint = Endpoint();
        bool muted;
        Marshal.ThrowExceptionForHR(endpoint.GetMute(out muted));
        Marshal.ThrowExceptionForHR(endpoint.SetMute(!muted, Guid.Empty));
    }
}

public static class MingyueLock
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool LockWorkStation();

    public static void Lock()
    {
        if (!LockWorkStation())
        {
            throw new InvalidOperationException("LockWorkStation failed");
        }
    }
}
"@

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await-Operation($operation, [Type]$resultType, [int]$timeoutMs = 10000) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  if (-not $task.Wait($timeoutMs)) {
    throw 'operation timed out'
  }
  if ($task.IsFaulted) {
    throw $task.Exception.GetBaseException()
  }
  return $task.Result
}

function Invoke-MediaCommand([string]$command) {
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $managerOperation = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
  $manager = Await-Operation $managerOperation ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $session = $manager.GetCurrentSession()
  if ($null -eq $session) {
    throw 'no active media session'
  }

  if ($command -eq 'media_play_pause') {
    $playing = $session.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing'
    if ($playing) {
      $operation = $session.TryPauseAsync()
    } else {
      $operation = $session.TryPlayAsync()
    }
  } elseif ($command -eq 'media_next') {
    $operation = $session.TrySkipNextAsync()
  } else {
    $operation = $session.TrySkipPreviousAsync()
  }

  $accepted = Await-Operation $operation ([bool])
  if (-not $accepted) {
    throw 'media command was not accepted'
  }
}

try {
  switch ($Action) {
    'volume_up' { [MingyueAudio]::Change(0.05) }
    'volume_down' { [MingyueAudio]::Change(-0.05) }
    'mute_toggle' { [MingyueAudio]::ToggleMute() }
    'lock' { [MingyueLock]::Lock() }
    default { Invoke-MediaCommand $Action }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
