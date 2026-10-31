#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桌宠 · 本地语音转写 worker。

由主进程用独立 ASR venv 启动，**只接受一个主进程生成的 job JSON**：

    asr_worker.py --job <job.json>            # 执行转写
    asr_worker.py --check                     # 自检依赖版本

安全边界：

* job 里只有 bvid / 分 P / 模型目录 / 工作目录 / 结果路径与限制；URL 由本文件
  按 BV 号重建，不接受模型传入的任意 URL、本地媒体路径或命令。
* 不读取、不接收任何 B 站 Cookie。yt-dlp 只带固定 UA/Referer。
* 音频只写进主进程给定的工作目录，转写结束（成功、失败、取消）都会清理。
* 模型必须已经在应用目录里（local_files_only=True），不会静默联网下载。
* 不启用云端转写，不安装 CUDA。

stdout 只输出单行 JSON 进度事件；stderr 只写已净化的诊断信息。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

BVID_RE = re.compile(r"^BV[0-9A-Za-z]{10}$")
MEDIA_SUFFIXES = ("bilivideo.com", "bilivideo.cn", "bilibili.com", "akamaized.net")
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
MAX_CHARS = 200_000

_CANCELLED = False


class JobError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _log(message: str) -> None:
    try:
        sys.stderr.write("[bili-asr] " + " ".join(str(message).split())[:300] + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def _emit(event: dict[str, Any]) -> None:
    try:
        sys.stdout.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def _handle_signal(_signum: int, _frame: Any) -> None:
    global _CANCELLED
    _CANCELLED = True
    _log("cancellation requested")


def _check_cancelled() -> None:
    if _CANCELLED:
        raise JobError("cancelled", "转写已取消")


def _safe_url(url: str) -> str:
    parts = urlsplit(str(url or ""))
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host:
        raise JobError("asr-failed", "音频地址不是 HTTPS")
    if not any(host == suffix or host.endswith("." + suffix) for suffix in MEDIA_SUFFIXES):
        raise JobError("asr-failed", "音频域名不在 B 站媒体白名单内")
    if parts.username or parts.password:
        raise JobError("asr-failed", "音频地址包含用户信息")
    return url


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """每次重定向都必须仍落在 B 站媒体域名内。"""

    max_redirections = 5

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> Optional[urllib.request.Request]:
        _safe_url(newurl)
        request = super().redirect_request(req, fp, code, msg, headers, newurl)
        if request is not None:
            request.headers.pop("Cookie", None)
            request.headers.pop("cookie", None)
        return request

    # Python 3.12 已有 308；保留别名兼容更旧的运行时。
    http_error_308 = urllib.request.HTTPRedirectHandler.http_error_302


def _open_media(url: str) -> Any:
    _safe_url(url)
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    request = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Referer": "https://www.bilibili.com", "Accept": "*/*"},
    )
    return opener.open(request, timeout=20)


def _download_to_file(
    url: str,
    target: str,
    max_bytes: int,
    on_progress: Any,
) -> int:
    _safe_url(url)
    written = 0
    try:
        with _open_media(url) as response:
            # 即使某次重定向没有被处理器拦截，也再校验一次最终地址。
            _safe_url(response.geturl())
            expected = 0
            length = response.headers.get("Content-Length")
            if length:
                try:
                    expected = int(length)
                except (TypeError, ValueError):
                    expected = 0
                if expected > max_bytes:
                    raise JobError("asr-limit", "音频体积超过本地转写上限")
            with open(target, "wb") as handle:
                while True:
                    _check_cancelled()
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > max_bytes:
                        raise JobError("asr-limit", "音频体积超过本地转写上限")
                    handle.write(chunk)
                    on_progress(written, expected)
    except JobError:
        raise
    except urllib.error.HTTPError as exc:
        raise JobError("asr-failed", f"下载视频音频失败（HTTP {exc.code}）") from exc
    except urllib.error.URLError as exc:
        raise JobError("asr-failed", "下载视频音频失败（网络不可用）") from exc
    except Exception as exc:
        raise JobError("asr-failed", "下载视频音频失败") from exc
    return written


def _load_job(path: str) -> dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            job = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise JobError("asr-failed", "任务文件无法读取") from exc
    if not isinstance(job, dict):
        raise JobError("asr-failed", "任务文件格式不正确")
    bvid = str(job.get("bvid") or "").strip()
    if not BVID_RE.match(bvid):
        raise JobError("asr-failed", "任务 BV 号不合法")
    page = job.get("page")
    if not isinstance(page, int) or page < 1 or page > 200:
        raise JobError("asr-failed", "任务分 P 不合法")
    for key in ("workDir", "output", "modelDir"):
        value = job.get(key)
        if not isinstance(value, str) or not os.path.isabs(value):
            raise JobError("asr-failed", f"任务缺少绝对路径字段 {key}")
    model = str(job.get("model") or "small")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,32}", model):
        raise JobError("asr-failed", "模型名不合法")
    job["bvid"] = bvid
    job["page"] = page
    job["model"] = model
    return job


def _build_url(bvid: str, page: int) -> str:
    # 由已验证的 BV/分 P 重建，绝不使用 job 内的任意 URL。
    if page <= 1:
        return f"https://www.bilibili.com/video/{bvid}"
    return f"https://www.bilibili.com/video/{bvid}?p={page}"


def _pick_audio_format(info: dict[str, Any]) -> Optional[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for fmt in info.get("formats") or []:
        if not isinstance(fmt, dict):
            continue
        if fmt.get("vcodec") not in (None, "none"):
            continue
        if fmt.get("acodec") == "none":
            continue
        url = fmt.get("url")
        if not url:
            continue
        try:
            _safe_url(str(url))
        except JobError:
            continue
        candidates.append(fmt)
    if not candidates:
        return None
    candidates.sort(
        key=lambda fmt: (
            float(fmt.get("abr") or 0),
            float(fmt.get("tbr") or 0),
            float(fmt.get("filesize") or fmt.get("filesize_approx") or 0),
        ),
        reverse=True,
    )
    return candidates[0]


def _download_audio(job: dict[str, Any]) -> tuple[str, float, int]:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError

    url = _build_url(job["bvid"], job["page"])
    work_dir = job["workDir"]
    os.makedirs(work_dir, exist_ok=True)
    max_bytes = int(job.get("maxDownloadMb") or 300) * 1024 * 1024
    max_seconds = float(job.get("maxMediaMinutes") or 30) * 60
    base: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "cachedir": False,
        "socket_timeout": 20,
        "retries": 1,
        "fragment_retries": 1,
        "http_headers": {"Referer": "https://www.bilibili.com", "User-Agent": UA},
    }

    _emit({"type": "stage", "stage": "metadata", "pct": None})
    try:
        with YoutubeDL({**base, "skip_download": True}) as ydl:
            info = ydl.extract_info(url, download=False)
    except DownloadError as exc:
        raise JobError("asr-failed", "无法解析视频音频信息") from exc
    except Exception as exc:
        raise JobError("asr-failed", "无法解析视频音频信息") from exc
    if not isinstance(info, dict):
        raise JobError("asr-failed", "视频音频信息为空")
    if info.get("_type") == "playlist":
        entries = info.get("entries") or []
        if not entries:
            raise JobError("asr-failed", "视频没有可转写的音频")
        info = entries[0]
    duration = info.get("duration")
    try:
        duration_sec = float(duration or 0)
    except (TypeError, ValueError):
        duration_sec = 0.0
    if duration_sec > max_seconds > 0:
        raise JobError("asr-limit", "视频时长超过本地转写上限")
    selected = _pick_audio_format(info)
    if selected is None:
        raise JobError("asr-failed", "没有可用的音频流")
    expected = float(selected.get("filesize") or selected.get("filesize_approx") or 0)
    if expected > max_bytes:
        raise JobError("asr-limit", "音频体积超过本地转写上限")

    ext = str(selected.get("ext") or "m4a").lower()
    if not re.fullmatch(r"[a-z0-9]{1,8}", ext):
        ext = "m4a"
    path = os.path.join(work_dir, f"audio.{ext}")

    def progress(current: int, total: int) -> None:
        pct = None
        if total > 0:
            pct = min(0.99, current / float(total))
        _emit({"type": "stage", "stage": "download", "pct": pct})

    _emit({"type": "stage", "stage": "download", "pct": 0.0})
    # 元数据仍由 yt-dlp 解析，但实际下载由本文件控制：不跟随任意重定向，
    # 不携带 Cookie，并持续检查取消与体积上限。
    asr_url = _safe_url(str(selected["url"]))
    actual = _download_to_file(asr_url, path, max_bytes, progress)
    if actual > max_bytes:
        raise JobError("asr-limit", "音频体积超过本地转写上限")
    if actual <= 0:
        raise JobError("asr-failed", "下载到的音频为空")
    _emit({"type": "stage", "stage": "download", "pct": 1.0})
    return path, duration_sec, actual


def _transcribe(job: dict[str, Any], audio: str, duration_sec: float) -> dict[str, Any]:
    model_dir = job["modelDir"]
    if not os.path.isdir(model_dir) or not os.path.exists(os.path.join(model_dir, "model.bin")):
        raise JobError("asr-model-missing", "本地转写模型尚未准备")

    from faster_whisper import WhisperModel

    _emit({"type": "stage", "stage": "model", "pct": 0.0})
    try:
        model = WhisperModel(
            model_dir,
            device="cpu",
            compute_type="int8",
            local_files_only=True,
        )
    except Exception as exc:
        raise JobError("asr-model-missing", "本地转写模型无法加载") from exc
    _emit({"type": "stage", "stage": "model", "pct": 1.0})
    _check_cancelled()
    _emit({"type": "stage", "stage": "transcribe", "pct": 0.0})
    language = str(job.get("language") or "zh")
    try:
        segments, info = model.transcribe(
            audio,
            language=None if language == "auto" else language,
            vad_filter=True,
            condition_on_previous_text=False,
        )
    except Exception as exc:
        raise JobError("asr-failed", "本地转写初始化失败") from exc

    lines: list[str] = []
    chars = 0
    last_emit = 0.0
    try:
        for segment in segments:
            _check_cancelled()
            text = " ".join(str(segment.text or "").split())
            if text:
                start = max(0.0, float(segment.start or 0.0))
                end = max(start, float(segment.end or start))
                lines.append(f"[{_clock(start)}-{_clock(end)}] {text}")
                chars += len(text)
                if chars > MAX_CHARS:
                    raise JobError("asr-limit", "转写文字超过本地缓存上限")
            now = time.monotonic()
            if now - last_emit >= 1.0:
                last_emit = now
                pct = None
                if duration_sec > 0:
                    pct = min(0.99, max(0.0, float(segment.end or 0.0) / duration_sec))
                _emit({"type": "stage", "stage": "transcribe", "pct": pct})
    except JobError:
        raise
    except Exception as exc:
        raise JobError("asr-failed", "本地转写失败") from exc

    text = "\n".join(lines).strip()
    observed = getattr(info, "language", None) if info is not None else None
    if not text:
        raise JobError("asr-empty", "没有识别出可用文字")
    _emit({"type": "stage", "stage": "transcribe", "pct": 1.0})
    return {
        "text": text,
        "chars": chars,
        "language": observed or language,
        "durationSec": duration_sec,
    }


def _clock(value: float) -> str:
    total = max(0, int(value))
    hours, rest = divmod(total, 3600)
    minutes, seconds = divmod(rest, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def _write_result(path: str, payload: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".tmp")
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, target)


def _cleanup(work_dir: Optional[str], keep: set[str]) -> None:
    if not work_dir:
        return
    try:
        base = os.path.abspath(work_dir)
        if not os.path.isdir(base):
            return
        for name in os.listdir(base):
            path = os.path.join(base, name)
            if path in keep:
                continue
            if os.path.isdir(path) and not os.path.islink(path):
                shutil.rmtree(path, ignore_errors=True)
            else:
                try:
                    os.remove(path)
                except OSError:
                    pass
    except Exception:
        pass


def run(job_path: str) -> int:
    job: Optional[dict[str, Any]] = None
    work_dir: Optional[str] = None
    started = time.monotonic()
    try:
        job = _load_job(job_path)
        work_dir = job["workDir"]
        os.makedirs(work_dir, exist_ok=True)
        _emit({"type": "state", "state": "running"})
        audio, duration_sec, audio_bytes = _download_audio(job)
        _check_cancelled()
        transcript = _transcribe(job, audio, duration_sec)
        elapsed = round(time.monotonic() - started, 1)
        result = {
            "ok": True,
            "bvid": job["bvid"],
            "page": job["page"],
            "model": job["model"],
            "chars": transcript["chars"],
            "language": transcript["language"],
            "durationSec": transcript["durationSec"] or duration_sec,
            "elapsedSec": elapsed,
            "audioBytes": audio_bytes,
            "text": transcript["text"],
        }
        _write_result(job["output"], result)
        _emit({"type": "done", "ok": True, "chars": result["chars"]})
        return 0
    except JobError as exc:
        payload = {
            "ok": False,
            "code": exc.code,
            "message": exc.message,
            "bvid": job.get("bvid") if job else None,
            "page": job.get("page") if job else None,
        }
        if job:
            try:
                _write_result(job["output"], payload)
            except Exception:
                pass
        _emit({"type": "done", "ok": False, "code": exc.code})
        _log(f"{exc.code}: {exc.message}")
        return 0 if exc.code == "cancelled" else 1
    except Exception:
        _log("unexpected: " + traceback.format_exc().splitlines()[-1])
        payload = {
            "ok": False,
            "code": "asr-failed",
            "message": "本地转写遇到未预期错误",
            "bvid": job.get("bvid") if job else None,
            "page": job.get("page") if job else None,
        }
        if job:
            try:
                _write_result(job["output"], payload)
            except Exception:
                pass
        _emit({"type": "done", "ok": False, "code": "asr-failed"})
        return 1
    finally:
        keep = {os.path.abspath(job["output"])} if job else set()
        _cleanup(work_dir, keep)


def self_check() -> int:
    payload: dict[str, Any] = {"ok": True}
    try:
        import faster_whisper  # noqa: F401

        payload["fasterWhisper"] = getattr(faster_whisper, "__version__", "unknown")
    except Exception as exc:
        payload = {"ok": False, "code": "asr-not-installed", "message": "faster-whisper 未安装"}
        _log(str(exc))
    try:
        import yt_dlp

        payload["ytDlp"] = getattr(yt_dlp.version, "__version__", "unknown")
    except Exception as exc:
        payload = {"ok": False, "code": "asr-not-installed", "message": "yt-dlp 未安装"}
        _log(str(exc))
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return 0 if payload.get("ok") else 1


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--job", help="job JSON path")
    parser.add_argument("--check", action="store_true")
    args, _rest = parser.parse_known_args()
    if args.check:
        return self_check()
    if not args.job:
        _log("missing --job")
        return 2

    for name in ("SIGTERM", "SIGINT", "SIGBREAK"):
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), _handle_signal)
            except Exception:
                pass

    model_dir = None
    try:
        with open(args.job, "r", encoding="utf-8") as handle:
            peek = json.load(handle)
        model_dir = peek.get("modelDir") if isinstance(peek, dict) else None
    except Exception:
        pass
    if isinstance(model_dir, str) and os.path.isdir(model_dir):
        os.environ.setdefault("HF_HOME", model_dir)
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    return run(args.job)


if __name__ == "__main__":
    raise SystemExit(main())
