import { useState, type Dispatch, type SetStateAction } from 'react'
import {
  BILI_VERDICT_LABELS,
  type BiliSessionReportView,
  type BiliSessionReportVideoView
} from '../../shared/bilibili'
import { DISCOVERY_EVIDENCE_LABELS } from '../../shared/discovery'

const REASON_LABELS: Record<BiliSessionReportView['reason'], string> = {
  turn: '本轮结束',
  stop: '已停下',
  budget: '额度用完',
  timeout: '超时'
}

function videoKey(video: BiliSessionReportVideoView): string {
  return `${video.bvid}#${video.partIndex}`
}

function evidenceLine(video: BiliSessionReportVideoView): string {
  const parts: string[] = [
    video.evidenceLevel === null ? '只读了简介' : DISCOVERY_EVIDENCE_LABELS[video.evidenceLevel]
  ]
  if (video.subtitleCoverage !== null) {
    parts.push(`字幕覆盖 ${Math.round(video.subtitleCoverage * 100)}%`)
  }
  if (video.frameCount > 0) parts.push(`画面 ${video.frameCount} 帧`)
  if (video.transcriptChars > 0) parts.push(`转写 ${video.transcriptChars} 字`)
  return parts.join(' · ')
}

/**
 * 一轮 B 站阅读结束后的「本轮阅读」快照。
 *
 * 只列真正打开过详情的视频；标题、作者、评价与证据都来自宿主的阅读记录，
 * 链接由主进程按 bvid + partIndex 重建。这里不放模型临时生成的文本。
 */
export function BiliSessionReportCard({
  report
}: {
  report: BiliSessionReportView
}): React.JSX.Element {
  const [busy, setBusy] = useState<Record<string, 'open' | 'copy' | null>>({})
  const [notices, setNotices] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  function setEntry(
    setter: Dispatch<SetStateAction<Record<string, string>>>,
    key: string,
    value: string | null
  ): void {
    setter((previous) => {
      const next = { ...previous }
      if (value === null) delete next[key]
      else next[key] = value
      return next
    })
  }

  async function open(video: BiliSessionReportVideoView): Promise<void> {
    const key = videoKey(video)
    if ((busy[key] ?? null) !== null) return
    setBusy((previous) => ({ ...previous, [key]: 'open' }))
    setEntry(setErrors, key, null)
    setEntry(setNotices, key, null)
    try {
      const result = await window.mingyue.chat.openBiliVideo(video.bvid, video.partIndex)
      if (result.ok) setEntry(setNotices, key, result.message ?? '已打开。')
      else setEntry(setErrors, key, result.message ?? '暂时打不开这个视频。')
    } catch {
      setEntry(setErrors, key, '暂时打不开这个视频。')
    } finally {
      setBusy((previous) => ({ ...previous, [key]: null }))
    }
  }

  async function copy(video: BiliSessionReportVideoView): Promise<void> {
    const key = videoKey(video)
    if ((busy[key] ?? null) !== null) return
    setBusy((previous) => ({ ...previous, [key]: 'copy' }))
    setEntry(setErrors, key, null)
    setEntry(setNotices, key, null)
    try {
      await navigator.clipboard.writeText(video.url)
      setEntry(setNotices, key, '链接已复制。')
    } catch {
      setEntry(setErrors, key, '复制失败，可以手动选中链接。')
    } finally {
      setBusy((previous) => ({ ...previous, [key]: null }))
    }
  }

  if (report.videos.length === 0) return <></>

  return (
    <article className="bili-report-card" aria-label="这轮在 B 站打开过的视频">
      <header className="bili-report-head">
        <span className="bili-report-badge">B 站 · 本轮阅读</span>
        <span className="bili-report-count">{report.videos.length} 个视频</span>
        <span className="bili-report-reason">{REASON_LABELS[report.reason]}</span>
      </header>

      <ul className="bili-report-list">
        {report.videos.map((video) => {
          const key = videoKey(video)
          const current = busy[key] ?? null
          const title = video.title.trim() === '' ? video.bvid : video.title
          return (
            <li className="bili-report-item" key={key}>
              <div className="bili-report-item-head">
                <h4 className="bili-report-title">{title}</h4>
                <span
                  className={`bili-report-verdict bili-report-verdict-${video.verdict ?? 'none'}`}
                >
                  {video.verdict === null ? '未评价' : BILI_VERDICT_LABELS[video.verdict]}
                </span>
              </div>
              <p className="bili-report-meta">
                {video.author.trim() === '' ? '未知 UP 主' : video.author} · 第 {video.part} P
              </p>
              {video.reason !== null && video.reason.trim() !== '' && (
                <p className="bili-report-note">她的判断：{video.reason}</p>
              )}
              <p className="bili-report-evidence">{evidenceLine(video)}</p>
              <code className="bili-report-url">{video.url}</code>
              <div className="bili-report-actions">
                <button
                  type="button"
                  className="bili-report-open"
                  disabled={current !== null}
                  onClick={() => void open(video)}
                >
                  {current === 'open' ? '打开中…' : '打开视频'}
                </button>
                <button
                  type="button"
                  className="bili-report-copy"
                  disabled={current !== null}
                  onClick={() => void copy(video)}
                >
                  {current === 'copy' ? '复制中…' : '复制链接'}
                </button>
              </div>
              {notices[key] !== undefined && (
                <p className="bili-report-notice">{notices[key]}</p>
              )}
              {errors[key] !== undefined && <p className="bili-report-error">{errors[key]}</p>}
            </li>
          )
        })}
      </ul>
    </article>
  )
}
