import { useCallback, useEffect, useState } from 'react'
import type {
  VisionSceneEventView,
  VisionSceneView,
  VisionStatusView
} from '../../../shared/ipc'
import { useSettings } from '../context'
import { Button, Empty, StatusLine } from '../ui'

const PHASE_LABELS: Record<string, string> = {
  unknown: '未确认',
  menu: '菜单',
  loading: '加载',
  playing: '游玩中',
  paused: '已暂停',
  results: '结算'
}

const QUALITY_LABELS: Record<string, string> = {
  good: '正常',
  low: '分辨率偏低',
  static: '画面静止',
  black: '黑屏/受保护',
  frozen: '画面冻结',
  blocked: '已暂停采集',
  unavailable: '不可用'
}

const SCENE_EVENT_LABELS: Record<string, string> = {
  scene_enter: '进入场景',
  scene_phase: '阶段变化',
  scene_change: '场景变化',
  scene_stay: '场景持续'
}

const BLOCKED_LABELS: Record<string, string> = {
  'user-paused': '你暂停了观察',
  paused: '已暂停',
  locked: '锁屏中',
  suspended: '系统挂起',
  'sensitive-app': '当前是敏感应用',
  'activity-disabled': '行为感知总开关关闭',
  'observation-disabled': '屏幕感知未开启或未授权',
  meeting: '会议应用（隐私保护）',
  'cua-busy': '电脑操作进行中',
  'self-foreground': '前台是桌宠自己的窗口',
  'foreground-unknown': '无法确认前台窗口所在显示器',
  'vision-unavailable': '屏幕感知未启动',
  'capture-failed': '截图失败',
  'black-frame': '黑屏或受保护画面',
  'stale-frame': '采集帧过旧',
  'target-mismatch': '截图没有绑定前台显示器'
}

const SOURCE_LABELS: Record<string, string> = {
  vision_model: '视觉模型',
  local_ocr: '本地 OCR 兜底',
  foreground: '仅前台应用类别',
  none: '无'
}

function phaseLabel(phase: string | null): string {
  return phase === null ? '未确认' : (PHASE_LABELS[phase] ?? phase)
}

function qualityLabel(quality: string | null): string {
  return quality === null ? '未知' : (QUALITY_LABELS[quality] ?? quality)
}

function blockedLabel(reason: string | null): string {
  return reason === null ? '正在观察' : (BLOCKED_LABELS[reason] ?? reason)
}

function sourceLabel(source: string | null): string {
  return source === null ? '无' : (SOURCE_LABELS[source] ?? source)
}

function agoLabel(at: number | null): string {
  if (at === null) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`
}

function msLabel(ms: number | null): string {
  return ms === null ? '—' : `${Math.round(ms)}ms`
}

/**
 * 屏幕感知的诊断详情：状态、节奏、最近场景与事件链。
 *
 * 配置在「电脑能力 → 屏幕」；这里只读取运行事实。
 */
export function VisionDiagnostics(): React.JSX.Element {
  const s = useSettings()
  const vision = s.config.worlds.activity.vision
  const activity = s.config.worlds.activity
  const [status, setStatus] = useState<VisionStatusView | null>(null)
  const [scenes, setScenes] = useState<VisionSceneView[]>([])
  const [events, setEvents] = useState<VisionSceneEventView[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextStatus, nextScenes, nextEvents] = await Promise.all([
        window.mingyue.settings.getVisionStatus(),
        window.mingyue.settings.getVisionScenes(),
        window.mingyue.settings.getVisionEvents()
      ])
      setStatus(nextStatus)
      setScenes(nextScenes)
      setEvents(nextEvents)
    } catch {
      /* 诊断读取失败不影响其他面板 */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const clear = async (): Promise<void> => {
    try {
      await window.mingyue.settings.clearVision()
      setScenes([])
      setEvents([])
    } catch {
      s.notify('清除场景失败。', 'error')
    }
  }

  return (
    <div className="stack">
      <div className="section-body">
        <StatusLine label="观察目标">
          {status === null
            ? '—'
            : status.targetKind === 'foreground-window'
              ? '前台窗口所在显示器（整屏）'
              : '尚未确定'}
        </StatusLine>
        <StatusLine label="状态">
          {status === null
            ? activity.enabled && vision.enabled
              ? '等待主进程响应'
              : '未运行'
            : `${status.paused ? '已暂停' : blockedLabel(status.blockedReason)} · ${qualityLabel(status.quality)}`}
        </StatusLine>
        <StatusLine label="节律">
          {status === null
            ? '—'
            : `${status.intervalMs === null ? '—' : `${Math.round(status.intervalMs / 1000)} 秒`} · 采集 ${status.framesLastMinute}/分钟 · 累计 ${status.framesCaptured} 帧 · 发送 ${status.requestsSent} 次`}
        </StatusLine>
        <StatusLine label="时间">
          {status === null
            ? '—'
            : `采集 ${agoLabel(status.lastFrameAt)} · 发送 ${agoLabel(status.lastSentAt)} · 理解 ${agoLabel(status.lastInterpretedAt)}`}
        </StatusLine>
        <StatusLine label="耗时">
          {status === null
            ? '—'
            : `采集 ${msLabel(status.timings?.captureMs ?? null)} · 模型 ${msLabel(status.timings?.semanticMs ?? null)} · 总计 ${msLabel(status.timings?.totalMs ?? null)}`}
        </StatusLine>
        <StatusLine label="最近场景">
          {status === null
            ? '—'
            : `${status.lastActivity ?? '暂无'} · ${phaseLabel(status.phase)} · 来源 ${sourceLabel(status.evidenceSource)}`}
        </StatusLine>
        <StatusLine label="能力">
          {status === null
            ? '—'
            : `${status.semantic.shareFrames ? (status.semantic.available ? '整屏画面会发送给模型' : '整屏共享不可用') : '整屏画面不发送给模型'} · OCR 兜底 ${status.ocrFallback ? (status.ocrAvailable === true ? '可用' : status.ocrAvailable === false ? '不可用' : '未探测') : '未开启'}`}
        </StatusLine>
        {status?.lastError === null || status?.lastError === undefined ? null : (
          <StatusLine label="最近错误">
            <span className="text-bad">{status.lastError}</span>
          </StatusLine>
        )}
        {status?.semantic.lastError === null || status?.semantic.lastError === undefined ? null : (
          <StatusLine label="视觉模型错误">
            <span className="text-bad">{status.semantic.lastError}</span>
          </StatusLine>
        )}
        <div className="row-gap">
          <Button onClick={() => void refresh()}>刷新</Button>
          <Button variant="danger" onClick={() => void clear()} disabled={scenes.length === 0}>
            清除最近场景
          </Button>
        </div>
      </div>

      {scenes.length === 0 ? (
        <Empty>还没有场景记录。</Empty>
      ) : (
        <div className="raw-table-wrap">
          <table className="raw-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>场景</th>
                <th>阶段</th>
                <th>来源</th>
                <th>画质</th>
                <th>可信度</th>
              </tr>
            </thead>
            <tbody>
              {scenes
                .slice()
                .reverse()
                .slice(0, 30)
                .map((scene, index) => (
                  <tr key={scene.observationId ?? `${scene.at}-${index}`}>
                    <td>{new Date(scene.at).toLocaleTimeString()}</td>
                    <td>
                      {scene.activity}
                      {scene.stale ? '（已过期）' : ''}
                    </td>
                    <td>{phaseLabel(scene.phase)}</td>
                    <td>{sourceLabel(scene.source)}</td>
                    <td>{qualityLabel(scene.quality)}</td>
                    <td>{Math.round(scene.confidence * 100)}%</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {events.length === 0 ? null : (
        <div className="raw-table-wrap">
          <table className="raw-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>事件</th>
                <th>阶段</th>
                <th>观察 ID</th>
              </tr>
            </thead>
            <tbody>
              {events
                .slice()
                .reverse()
                .slice(0, 20)
                .map((event) => (
                  <tr key={event.eventId}>
                    <td>{new Date(event.at).toLocaleTimeString()}</td>
                    <td>{SCENE_EVENT_LABELS[event.kind] ?? event.kind}</td>
                    <td>
                      {event.previousPhase === null
                        ? phaseLabel(event.phase)
                        : `${phaseLabel(event.previousPhase)} → ${phaseLabel(event.phase)}`}
                    </td>
                    <td className="mono">
                      {event.observationId === null ? '—' : event.observationId.slice(0, 12)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
