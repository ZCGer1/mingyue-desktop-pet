import { spawn } from 'node:child_process'

/**
 * 终止子进程树。Windows 上 Python/yt-dlp 可能再拉起 ffmpeg 等子进程，
 * 只杀父进程会留下仍在下载/解码的孤儿；`taskkill /T /F` 更可靠。
 * 其他平台退回 SIGKILL 进程组。
 */
export function killProcessTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (pid === undefined || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      child.on('error', () => undefined)
      child.unref()
      return
    } catch {
      /* 退回普通 kill */
    }
  }
  try {
    process.kill(pid, signal)
  } catch {
    /* 进程可能已经退出 */
  }
}
