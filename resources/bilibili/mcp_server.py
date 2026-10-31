#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桌宠 · B 站只读 MCP 服务。

设计约束（与 PLAN-BILIBILI-REFACTOR-DSH-SCROLL.md 对齐）：

* 只读。白名单由环境变量 ``BILI_MCP_TOOLS`` 强制下发；缺失、为空或包含未知
  工具名时进程直接退出（fail-closed），绝不"默认全开"。
* 凭据只通过 MCP ``initialize`` 的 ``_meta.bilibili_credentials`` 进入本进程
  内存，不读 argv / 环境变量 / 文件，不写日志，不回显。
* 所有由本文件直接下载的资源（字幕、封面、故事板）都必须落在 B 站图床域名
  白名单内，只发 UA/Referer，绝不附带 Cookie；重定向逐跳校验。
* 错误返回结构化 ``code``，不把账号响应原文、URL 查询串或凭据交给模型。

协议：换行分隔的 JSON-RPC 2.0（MCP stdio），不依赖 mcp SDK。
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import struct
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit, urlunsplit

SERVER_NAME = "mingyue-bilibili"
SERVER_VERSION = "1.0.0"
PROTOCOL_VERSION = "2024-11-05"

# 只读工具全集。任何不在这个集合里的名字都不能出现在白名单里。
TOOL_SPECS: dict[str, dict[str, Any]] = {
    "bili_recommend": {
        "description": "读取当前账号的首页推荐流（只读）。返回 BV、标题、作者、播放、时长等候选。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ps": {"type": "integer", "minimum": 1, "maximum": 40, "default": 20},
            },
            "additionalProperties": False,
        },
    },
    "bili_search": {
        "description": "按关键词搜索 B 站视频（只读）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "keyword": {"type": "string", "minLength": 1, "maxLength": 100},
                "num": {"type": "integer", "minimum": 1, "maximum": 30, "default": 12},
                "order": {
                    "type": "string",
                    "enum": ["totalrank", "click", "pubdate", "dm"],
                    "default": "totalrank",
                },
                "page": {"type": "integer", "minimum": 1, "maximum": 10, "default": 1},
            },
            "required": ["keyword"],
            "additionalProperties": False,
        },
    },
    "bili_video_info": {
        "description": "读取视频详情与全部分 P 元数据（只读）。",
        "inputSchema": {
            "type": "object",
            "properties": {"bvid": {"type": "string"}},
            "required": ["bvid"],
            "additionalProperties": False,
        },
    },
    "bili_subtitle": {
        "description": "读取指定分 P 的字幕原文，分段返回时间范围与覆盖率（只读）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bvid": {"type": "string"},
                "page": {"type": "integer", "minimum": 1, "maximum": 200, "default": 1},
                "offset": {"type": "integer", "minimum": 0, "default": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": 400, "default": 400},
            },
            "required": ["bvid"],
            "additionalProperties": False,
        },
    },
    "bili_frames": {
        "description": "从 B 站故事板裁取指定分 P 的画面帧（只读，默认 3 帧，最多 6 帧）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bvid": {"type": "string"},
                "page": {"type": "integer", "minimum": 1, "maximum": 200, "default": 1},
                "num": {"type": "integer", "minimum": 1, "maximum": 6, "default": 3},
                "at": {
                    "type": "array",
                    "items": {"type": "number", "minimum": 0},
                    "maxItems": 6,
                },
            },
            "required": ["bvid"],
            "additionalProperties": False,
        },
    },
    "bili_cover": {
        "description": "读取视频封面（只读，缩放到 512 像素宽）。",
        "inputSchema": {
            "type": "object",
            "properties": {"bvid": {"type": "string"}},
            "required": ["bvid"],
            "additionalProperties": False,
        },
    },
    "bili_account": {
        "description": "读取当前登录账号的昵称与脱敏身份（只读）。",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
}

# 视频帧 / 封面下载限制。
HTTP_TIMEOUT = 25.0
MAX_IMAGE_BYTES = 1_500_000
MAX_SHEET_BYTES = 8_000_000
MAX_TOTAL_SHEET_BYTES = 24_000_000
COVER_WIDTH = 512
FRAME_MAX = 6
TILE_W_DEFAULT = 480
TILE_H_DEFAULT = 270
WEB_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
ASSET_SUFFIXES = ("hdslb.com", "bilivideo.com")
BVID_RE = re.compile(r"^BV[0-9A-Za-z]{10}$")


class ToolError(Exception):
    """业务失败；code 与 src/shared/bilibili.ts 的 BiliReadFailureCode 对齐。"""

    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def _log(message: str) -> None:
    """诊断日志只写 stderr，不含参数值、URL 或凭据。"""
    line = " ".join(str(message).split())[:300]
    try:
        sys.stderr.write(f"[bili-mcp] {line}\n")
        sys.stderr.flush()
    except Exception:
        pass


def _sanitize(message: str) -> str:
    """去掉查询串与常见凭据片段，再截断。"""
    text = " ".join(str(message or "").split())
    text = re.sub(r"(?i)(SESSDATA|bili_jct|buvid3|dedeuserid)=([^&\s;]+)", r"\1=<redacted>", text)
    text = re.sub(r"\?[^\s)]{8,}", "?<query>", text)
    return text[:240]


def _parse_whitelist() -> list[str]:
    raw = os.environ.get("BILI_MCP_TOOLS", "")
    names = [part.strip() for part in raw.split(",") if part.strip()]
    if not names:
        raise SystemExit(
            "BILI_MCP_TOOLS is required and must list the read-only tools; refusing to start."
        )
    unknown = [name for name in names if name not in TOOL_SPECS]
    if unknown:
        raise SystemExit(
            "BILI_MCP_TOOLS contains unsupported tools: " + ", ".join(sorted(unknown))
        )
    # 去重并保持稳定顺序
    return [name for name in TOOL_SPECS if name in set(names)]


_ALLOWED = _parse_whitelist()


# ---------------------------------------------------------------------------
# 凭据（只存在于本进程内存）
# ---------------------------------------------------------------------------

_CREDENTIALS: dict[str, str] = {}
_INITIALIZED = False


def _accept_credentials(meta: Any) -> None:
    global _CREDENTIALS
    if not isinstance(meta, dict):
        return
    raw = meta.get("bilibili_credentials")
    if raw is None:
        return
    if not isinstance(raw, dict):
        raise ToolError("parse-failed", "凭据格式不正确")
    allowed = ("sessdata", "bili_jct", "buvid3", "dedeuserid")
    clean: dict[str, str] = {}
    for key in allowed:
        value = raw.get(key)
        if value is None:
            continue
        if not isinstance(value, str):
            raise ToolError("parse-failed", "凭据格式不正确")
        value = value.strip()
        if len(value) > 512 or any(ch in value for ch in "\r\n\0"):
            raise ToolError("parse-failed", "凭据格式不正确")
        if value:
            clean[key] = value
    _CREDENTIALS = clean
    _log(
        "credentials updated "
        + ("(logged in)" if clean.get("sessdata") else "(anonymous)")
    )


def _credential() -> Optional[Any]:
    if not _CREDENTIALS:
        return None
    from bilibili_api import Credential

    return Credential(
        sessdata=_CREDENTIALS.get("sessdata", ""),
        bili_jct=_CREDENTIALS.get("bili_jct", ""),
        buvid3=_CREDENTIALS.get("buvid3", ""),
        dedeuserid=_CREDENTIALS.get("dedeuserid", ""),
    )


def _require_credential() -> Any:
    cred = _credential()
    if cred is None or not _CREDENTIALS.get("sessdata"):
        raise ToolError("login-required", "需要先扫码登录 B 站", retryable=True)
    return cred


# ---------------------------------------------------------------------------
# 错误映射
# ---------------------------------------------------------------------------


def _error_code(exc: BaseException) -> tuple[str, bool]:
    if isinstance(exc, ToolError):
        return exc.code, exc.retryable
    if isinstance(exc, asyncio.CancelledError):
        return "cancelled", False
    if isinstance(exc, asyncio.TimeoutError):
        return "timeout", True
    name = type(exc).__name__
    code = getattr(exc, "code", None)
    text = _sanitize(str(exc))
    if name in ("ClientConnectorError", "ClientOSError", "ServerDisconnectedError", "ClientError"):
        return "network", True
    if name in ("ResponseCodeException", "NetworkException", "ApiException", "ArgsException"):
        try:
            code_int = int(code) if code is not None else 0
        except (TypeError, ValueError):
            code_int = 0
        if code_int == -101:
            return "login-required", True
        if code_int in (-352, -412, -509, -799, -351):
            return "risk-control", True
        if code_int in (-404, 62002, 62004, -403):
            return "video-unavailable", False
        if code_int == -0:
            return "network", True
        if name == "NetworkException":
            return "network", True
    if "timed out" in text.lower() or "timeout" in text.lower():
        return "timeout", True
    if "Credential" in text and ("sessdata" in text.lower() or "未提供" in text):
        return "login-required", True
    if "验证码" in text or "captcha" in text.lower():
        return "captcha", False
    if "风控" in text or "412" in text:
        return "risk-control", True
    return "internal", False


def _failure_payload(exc: BaseException) -> dict[str, Any]:
    code, retryable = _error_code(exc)
    return {
        "ok": False,
        "code": code,
        "message": _sanitize(str(exc)) or code,
        "retryable": retryable,
    }


# ---------------------------------------------------------------------------
# 资源 URL 安全
# ---------------------------------------------------------------------------


def _https(url: Any) -> str:
    value = str(url or "").strip()
    if value.startswith("//"):
        return "https:" + value
    if value.startswith("http://"):
        return "https://" + value[len("http://"):]
    return value


def _validate_asset_url(url: Any) -> str:
    value = _https(url)
    if not value:
        raise ToolError("parse-failed", "资源地址为空")
    parts = urlsplit(value)
    if parts.scheme != "https":
        raise ToolError("parse-failed", "资源地址不是 HTTPS")
    if parts.username or parts.password:
        raise ToolError("parse-failed", "资源地址包含用户信息")
    host = (parts.hostname or "").lower()
    if not host or not any(host == s or host.endswith("." + s) for s in ASSET_SUFFIXES):
        raise ToolError("parse-failed", "资源域名不在白名单内")
    try:
        port = parts.port
    except ValueError as exc:
        raise ToolError("parse-failed", "资源端口不合法") from exc
    if port not in (None, 443):
        raise ToolError("parse-failed", "资源端口不在白名单内")
    if re.fullmatch(r"\d+\.\d+\.\d+\.\d+", host):
        raise ToolError("parse-failed", "资源地址不能是 IP")
    return urlunsplit(("https", parts.netloc, parts.path, parts.query, ""))


def _asset_headers() -> dict[str, str]:
    # 明确不带 Cookie：图床只需要 UA 与 Referer。
    return {"User-Agent": WEB_UA, "Referer": "https://www.bilibili.com/"}


async def _fetch_bytes(url: Any, max_bytes: int) -> bytes:
    import aiohttp

    target = _validate_asset_url(url)
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT)
    async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
        for _ in range(4):
            async with session.get(target, headers=_asset_headers(), allow_redirects=False) as resp:
                if resp.status in (301, 302, 303, 307, 308):
                    location = resp.headers.get("Location")
                    if not location:
                        raise ToolError("network", "资源重定向缺少地址", retryable=True)
                    # 逐跳校验，避免被重定向到非图床域名后继续带请求。
                    target = _validate_asset_url(location)
                    continue
                if resp.status != 200:
                    raise ToolError("network", f"图片下载失败（HTTP {resp.status}）", retryable=True)
                length = resp.headers.get("Content-Length")
                if length and length.isdigit() and int(length) > max_bytes:
                    raise ToolError("parse-failed", "资源体积超过限制")
                chunks: list[bytes] = []
                total = 0
                async for chunk in resp.content.iter_chunked(64 * 1024):
                    total += len(chunk)
                    if total > max_bytes:
                        raise ToolError("parse-failed", "资源体积超过限制")
                    chunks.append(chunk)
                return b"".join(chunks)
        raise ToolError("network", "资源重定向次数过多", retryable=True)


# ---------------------------------------------------------------------------
# 元数据辅助
# ---------------------------------------------------------------------------


def _check_bvid(raw: Any) -> str:
    bvid = str(raw or "").strip()
    if not BVID_RE.match(bvid):
        raise ToolError("not-found", "BV 号格式不正确")
    return bvid


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _duration_sec(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        return float(text)
    # 搜索结果的两段式是「分:秒」，分钟可以超过 59（如 2398:14）；详情页是
    # 三段式「时:分:秒」。两种都见过，别把两段式当时分。
    three = re.fullmatch(r"(\d+):(\d{1,2}):(\d{1,2})", text)
    if three:
        hours, minutes, seconds = (int(part) for part in three.groups())
        return float(hours * 3600 + minutes * 60 + seconds)
    two = re.fullmatch(r"(\d+):(\d{1,2})", text)
    if two:
        minutes, seconds = (int(part) for part in two.groups())
        return float(minutes * 60 + seconds)
    return None


def _duration_label(value: Any) -> str:
    sec = _duration_sec(value)
    if sec is None:
        return str(value or "")
    sec = max(0, int(sec))
    hours, rest = divmod(sec, 3600)
    minutes, seconds = divmod(rest, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


def _clock(value: float) -> str:
    sec = max(0, int(value))
    hours, rest = divmod(sec, 3600)
    minutes, seconds = divmod(rest, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def _clean_html(text: Any) -> str:
    value = str(text or "")
    value = re.sub(r"<[^>]{1,40}>", "", value)
    return " ".join(value.split())


def _pages(info: dict[str, Any]) -> list[dict[str, Any]]:
    raw = info.get("pages")
    if not isinstance(raw, list) or not raw:
        cid = _int(info.get("cid"))
        if cid:
            return [
                {
                    "page": 1,
                    "cid": cid,
                    "part": info.get("title") or "",
                    "duration": info.get("duration") or 0,
                }
            ]
        return []
    pages: list[dict[str, Any]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        pages.append(
            {
                "page": _int(item.get("page"), index + 1),
                "cid": _int(item.get("cid")),
                "part": _clean_html(item.get("part") or info.get("title") or f"P{index + 1}"),
                "duration": _duration_sec(item.get("duration")) or 0.0,
            }
        )
    return pages


def _pick_page(info: dict[str, Any], page: int) -> tuple[int, dict[str, Any], int]:
    pages = _pages(info)
    if not pages:
        raise ToolError("parse-failed", "视频没有可用的分 P 信息")
    index = page - 1
    if index < 0 or index >= len(pages):
        raise ToolError("not-found", "指定的分 P 不存在")
    chosen = pages[index]
    if not chosen.get("cid"):
        raise ToolError("parse-failed", "分 P 缺少 cid")
    return index, chosen, len(pages)


async def _video_info(video_obj: Any) -> dict[str, Any]:
    try:
        info = await video_obj.get_info()
    except Exception as exc:
        raise _wrap_api_error(exc)
    if not isinstance(info, dict) or not info.get("bvid"):
        raise ToolError("parse-failed", "视频详情结构异常")
    return info


def _wrap_api_error(exc: Exception) -> Exception:
    if isinstance(exc, ToolError):
        return exc
    code, _ = _error_code(exc)
    message = _sanitize(str(exc)) or "B 站接口请求失败"
    return ToolError(code, message, retryable=_error_code(exc)[1])


def _normalize_video_item(item: dict[str, Any], source: str) -> Optional[dict[str, Any]]:
    bvid = str(item.get("bvid") or "").strip()
    if not BVID_RE.match(bvid):
        return None
    title = _clean_html(item.get("title"))
    if not title:
        return None
    owner = item.get("owner") if isinstance(item.get("owner"), dict) else {}
    stat = item.get("stat") if isinstance(item.get("stat"), dict) else {}
    duration_raw = item.get("duration")
    duration_sec = _duration_sec(duration_raw)
    review = item.get("review")
    return {
        "bvid": bvid,
        "title": title[:200],
        "author": str(owner.get("name") or item.get("author") or "")[:80],
        "play": _int(item.get("play") if item.get("play") is not None else stat.get("view")),
        "danmaku": _int(
            item.get("video_review") if item.get("video_review") is not None else stat.get("danmaku")
        ),
        "review": _int(review if review is not None else stat.get("reply")),
        "duration": _duration_label(duration_raw),
        "durationSec": duration_sec,
        "pubdate": _int(item.get("pubdate")),
        "description": _clean_html(item.get("description") or item.get("desc"))[:200],
        "source": source,
    }


def _text_content(payload: dict[str, Any]) -> dict[str, Any]:
    return {"type": "text", "text": json.dumps(payload, ensure_ascii=False)}


def _image_content(
    raw: bytes, mime: str, width: Optional[int] = None, height: Optional[int] = None
) -> dict[str, Any]:
    # width/height 是主进程构造 ToolImage 的必需字段；模型侧看到的是主进程
    # 重新压缩后的图片，因此尺寸必须在这里如实给出，不能事后猜测。
    payload: dict[str, Any] = {
        "type": "image",
        "data": base64.b64encode(raw).decode("ascii"),
        "mimeType": mime,
    }
    if width is not None and height is not None:
        payload["width"] = int(width)
        payload["height"] = int(height)
    return payload


def _emit_result(request_id: Any, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "result": {
            "content": [_text_content(payload)],
            "isError": payload.get("ok") is False,
        },
    }


def _emit_images_result(
    request_id: Any, payload: dict[str, Any], images: list[dict[str, Any]]
) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "result": {
            "content": [_text_content(payload), *images],
            "isError": payload.get("ok") is False,
        },
    }


# ---------------------------------------------------------------------------
# 工具实现
# ---------------------------------------------------------------------------


async def tool_bili_recommend(args: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    from bilibili_api import homepage

    cred = _require_credential()
    ps = min(max(_int(args.get("ps"), 20), 1), 40)
    try:
        data = await asyncio.wait_for(homepage.get_videos(credential=cred), timeout=HTTP_TIMEOUT)
    except Exception as exc:
        raise _wrap_api_error(exc)
    items: list[Any]
    if isinstance(data, dict):
        items = data.get("item") or data.get("data") or []
    elif isinstance(data, list):
        items = data
    else:
        items = []
    videos: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        goto = item.get("goto")
        if goto and goto != "av":
            continue
        normalized = _normalize_video_item(item, "recommend")
        if normalized:
            videos.append(normalized)
        if len(videos) >= ps:
            break
    return {"ok": True, "tool": "bili_recommend", "count": len(videos), "videos": videos}, []


async def tool_bili_search(args: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    from bilibili_api import search

    keyword = " ".join(str(args.get("keyword") or "").split())
    if not keyword:
        raise ToolError("parse-failed", "搜索关键词为空")
    if len(keyword) > 100:
        keyword = keyword[:100]
    num = min(max(_int(args.get("num"), 12), 1), 30)
    page = min(max(_int(args.get("page"), 1), 1), 10)
    order_map = {
        "totalrank": search.OrderVideo.TOTALRANK,
        "click": search.OrderVideo.CLICK,
        "pubdate": search.OrderVideo.PUBDATE,
        "dm": search.OrderVideo.DM,
    }
    order = order_map.get(str(args.get("order") or "totalrank"), search.OrderVideo.TOTALRANK)
    try:
        result = await asyncio.wait_for(
            search.search_by_type(
                keyword=keyword,
                search_type=search.SearchObjectType.VIDEO,
                page=page,
                order_type=order,
            ),
            timeout=HTTP_TIMEOUT,
        )
    except Exception as exc:
        raise _wrap_api_error(exc)
    videos: list[dict[str, Any]] = []
    for item in (result or {}).get("result") or []:
        if not isinstance(item, dict):
            continue
        normalized = _normalize_video_item(item, "search")
        if normalized:
            videos.append(normalized)
        if len(videos) >= num:
            break
    return {
        "ok": True,
        "tool": "bili_search",
        "keyword": keyword,
        "page": page,
        "count": len(videos),
        "videos": videos,
    }, []


async def tool_bili_video_info(args: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    from bilibili_api import video

    bvid = _check_bvid(args.get("bvid"))
    try:
        v = video.Video(bvid=bvid, credential=_credential())
        info = await asyncio.wait_for(_video_info(v), timeout=HTTP_TIMEOUT)
    except Exception as exc:
        raise _wrap_api_error(exc)
    pages = _pages(info)
    stat = info.get("stat") if isinstance(info.get("stat"), dict) else {}
    tags = [
        _clean_html(tag.get("tag_name"))
        for tag in (info.get("tag") or [])
        if isinstance(tag, dict) and tag.get("tag_name")
    ][:20]
    return {
        "ok": True,
        "tool": "bili_video_info",
        "bvid": info.get("bvid") or bvid,
        "title": _clean_html(info.get("title"))[:200],
        "description": _clean_html(info.get("desc"))[:2000],
        "author": str((info.get("owner") or {}).get("name") or "")[:80],
        "duration": _duration_sec(info.get("duration")),
        "pages": pages,
        "tags": tags,
        "stat": {
            "view": _int(stat.get("view")),
            "reply": _int(stat.get("reply")),
            "danmaku": _int(stat.get("danmaku")),
            "favorite": _int(stat.get("favorite")),
        },
    }, []


async def tool_bili_subtitle(args: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    from bilibili_api import video

    bvid = _check_bvid(args.get("bvid"))
    page = min(max(_int(args.get("page"), 1), 1), 200)
    offset = max(_int(args.get("offset"), 0), 0)
    limit = min(max(_int(args.get("limit"), 400), 1), 400)
    try:
        v = video.Video(bvid=bvid, credential=_credential())
        info = await asyncio.wait_for(_video_info(v), timeout=HTTP_TIMEOUT)
        page_index, part, total_pages = _pick_page(info, page)
        subtitle_meta = await asyncio.wait_for(
            v.get_subtitle(cid=part["cid"]), timeout=HTTP_TIMEOUT
        )
    except Exception as exc:
        raise _wrap_api_error(exc)

    subtitles = subtitle_meta.get("subtitles") if isinstance(subtitle_meta, dict) else None
    if not isinstance(subtitles, list) or not subtitles:
        raise ToolError("no-subtitle", "这个分 P 没有可读取的字幕")

    def score(entry: dict[str, Any]) -> int:
        lan = str(entry.get("lan") or "").lower()
        if lan in ("ai-zh", "zh-cn", "zh-hans", "zh"):
            return 0
        if lan.startswith("zh"):
            return 1
        return 2

    candidates = [entry for entry in subtitles if isinstance(entry, dict)]
    if not candidates:
        raise ToolError("no-subtitle", "这个分 P 没有可读取的字幕")
    target = sorted(candidates, key=score)[0]
    sub_url = target.get("subtitle_url")
    if not sub_url:
        raise ToolError("parse-failed", "字幕地址为空")

    try:
        raw = await _fetch_bytes(sub_url, max_bytes=12_000_000)
        data = json.loads(raw.decode("utf-8"))
    except ToolError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ToolError("parse-failed", "字幕内容无法解析") from exc
    except Exception as exc:
        raise _wrap_api_error(exc)
    body = data.get("body") if isinstance(data, dict) else None
    if not isinstance(body, list):
        raise ToolError("parse-failed", "字幕内容结构异常")

    segments: list[dict[str, Any]] = []
    for item in body:
        if not isinstance(item, dict):
            continue
        text = " ".join(str(item.get("content") or "").split())
        if not text:
            continue
        start = _num(item.get("from"))
        end = _num(item.get("to"), start)
        segments.append({"start": start, "end": end, "text": text})
    if not segments:
        raise ToolError("no-subtitle", "字幕内容为空")

    total = len(segments)
    offset = min(offset, total)
    chunk = segments[offset: offset + limit]
    lines = [f"[{_clock(seg['start'])}-{_clock(seg['end'])}] {seg['text']}" for seg in chunk]
    text = "\n".join(lines)
    total_chars = sum(len(seg["text"]) for seg in segments)
    read_chars = sum(len(seg["text"]) for seg in chunk)
    read_end = offset + len(chunk)
    return {
        "ok": True,
        "tool": "bili_subtitle",
        "bvid": info.get("bvid") or bvid,
        "title": _clean_html(info.get("title"))[:200],
        "page": page,
        "pages": total_pages,
        "partTitle": part.get("part") or "",
        "cid": part["cid"],
        "partDuration": part.get("duration") or 0.0,
        "language": str(target.get("lan") or ""),
        "languageDoc": str(target.get("lan_doc") or ""),
        "segmentsTotal": total,
        "offset": offset,
        "segmentsRead": len(chunk),
        "coverage": round(len(chunk) / total, 4) if total else 0.0,
        "chars": read_chars,
        "totalChars": total_chars,
        "complete": read_end >= total,
        "nextOffset": None if read_end >= total else read_end,
        "text": text,
    }, []


def _snapshot_entries(data: dict[str, Any], duration: float) -> list[tuple[float, int]]:
    raws: list[tuple[float, int]] = []
    for index, item in enumerate(data.get("index") or []):
        if not isinstance(item, (dict, int, float, str)):
            continue
        ts = item.get("timestamp") if isinstance(item, dict) else item
        try:
            raws.append((float(ts), index))
        except (TypeError, ValueError):
            continue
    if not raws:
        return []
    biggest = max(value for value, _ in raws)
    looks_ms = duration > 0 and biggest > duration * 1.5
    scale = 1000.0 if looks_ms else 1.0
    return [(value / scale, index) for value, index in raws]


def _entries_from_pvdata(data: dict[str, Any], raw: bytes) -> list[tuple[float, int]]:
    if not raw or len(raw) % 2:
        return []
    count = len(raw) // 2
    if count > 20000:
        return []
    return [(float(sec), index) for index, sec in enumerate(struct.unpack(f">{count}H", raw))]


def _crop_tile(sheet: bytes, tile_index: int, tile_w: int, tile_h: int) -> bytes:
    from PIL import Image

    image = Image.open(io.BytesIO(sheet))
    cols = max(1, image.width // tile_w)
    rows = max(1, image.height // tile_h)
    if tile_index >= cols * rows:
        raise ToolError("parse-failed", f"故事板块越界（{cols}x{rows}）")
    col, row = tile_index % cols, tile_index // cols
    tile = image.crop(
        (col * tile_w, row * tile_h, (col + 1) * tile_w, (row + 1) * tile_h)
    ).convert("RGB")
    buffer = io.BytesIO()
    tile.save(buffer, format="JPEG", quality=85)
    return buffer.getvalue()


async def tool_bili_frames(args: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    from bilibili_api import video

    bvid = _check_bvid(args.get("bvid"))
    page = min(max(_int(args.get("page"), 1), 1), 200)
    raw_at = args.get("at")
    at: list[float] = []
    if isinstance(raw_at, list):
        for value in raw_at[:FRAME_MAX]:
            if isinstance(value, (int, float)) and value >= 0:
                at.append(float(value))
    num = min(max(_int(args.get("num"), 3), 1), FRAME_MAX)
    try:
        v = video.Video(bvid=bvid, credential=_credential())
        info = await asyncio.wait_for(_video_info(v), timeout=HTTP_TIMEOUT)
        page_index, part, total_pages = _pick_page(info, page)
    except Exception as exc:
        raise _wrap_api_error(exc)

    duration = _duration_sec(info.get("duration")) or 0.0
    covered = float(part.get("duration") or duration or 0.0)
    cid = part["cid"]

    snapshot: dict[str, Any] = {}
    entries: list[tuple[float, int]] = []
    last_error: Optional[str] = None
    for attempt in range(2):
        try:
            snapshot = await asyncio.wait_for(
                v.get_video_snapshot(cid=cid, json_index=True, pvideo=False),
                timeout=HTTP_TIMEOUT,
            )
            last_error = None
        except Exception as exc:
            snapshot, last_error = {}, _sanitize(str(exc))
        if not isinstance(snapshot, dict):
            snapshot = {}
        entries = _snapshot_entries(snapshot, covered)
        if not entries:
            pvdata = snapshot.get("pvdata")
            if pvdata:
                try:
                    raw = await _fetch_bytes(pvdata, max_bytes=2_000_000)
                    entries = _entries_from_pvdata(snapshot, raw)
                except Exception as exc:
                    last_error = _sanitize(str(exc))
        if entries and snapshot.get("image"):
            break
        if attempt == 0:
            await asyncio.sleep(0.8)

    sheets = snapshot.get("image") if isinstance(snapshot.get("image"), list) else []
    if not entries or not sheets:
        raise ToolError(
            "vision-unavailable",
            f"取不到故事板{f'（{last_error}）' if last_error else ''}",
            retryable=True,
        )

    story_max = max(value for value, _ in entries)
    if story_max > 0:
        covered = min(covered, story_max)
    if covered <= 0:
        raise ToolError("vision-unavailable", "故事板没有有效时间信息", retryable=True)

    if at:
        targets = [min(max(0.0, value), max(0.0, covered - 0.1)) for value in at][:FRAME_MAX]
    else:
        targets = [covered * (index + 1) / (num + 1) for index in range(num)]

    picked: list[tuple[float, float, int]] = []
    for target in targets:
        stamp, tile = min(entries, key=lambda entry: abs(entry[0] - target))
        picked.append((round(target, 1), round(stamp, 1), tile))

    tile_w = _int(snapshot.get("img_x_size"), TILE_W_DEFAULT) or TILE_W_DEFAULT
    tile_h = _int(snapshot.get("img_y_size"), TILE_H_DEFAULT) or TILE_H_DEFAULT
    if tile_w < 64 or tile_h < 36 or tile_w > 2000 or tile_h > 2000:
        raise ToolError("parse-failed", "故事板块尺寸异常")

    cache: dict[int, bytes] = {}
    total_downloaded = 0

    async def get_sheet(no: int) -> bytes:
        nonlocal total_downloaded
        if no not in cache:
            if no < 0 or no >= len(sheets):
                raise ToolError("parse-failed", "故事板拼图不存在")
            raw = await _fetch_bytes(sheets[no], max_bytes=MAX_SHEET_BYTES)
            total_downloaded += len(raw)
            if total_downloaded > MAX_TOTAL_SHEET_BYTES:
                raise ToolError("parse-failed", "故事板总体积超过限制")
            cache[no] = raw
        return cache[no]

    images: list[dict[str, Any]] = []
    frames: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    cap: Optional[int] = None
    for index, (want, got, tile) in enumerate(picked):
        try:
            if cap is None:
                from PIL import Image

                first = await get_sheet(0)
                image = Image.open(io.BytesIO(first))
                cap = max(1, (image.width // tile_w) * (image.height // tile_h))
            sheet_no, position = divmod(tile, cap)
            raw = _crop_tile(await get_sheet(sheet_no), position, tile_w, tile_h)
            if len(raw) > MAX_IMAGE_BYTES:
                raise ToolError("parse-failed", "单帧体积超过限制")
            images.append(_image_content(raw, "image/jpeg", tile_w, tile_h))
            frames.append(
                {
                    "index": index,
                    "wantSec": want,
                    "gotSec": got,
                    "kb": round(len(raw) / 1024, 1),
                }
            )
        except Exception as exc:
            failed.append(
                {
                    "index": index,
                    "wantSec": want,
                    "gotSec": got,
                    "reason": _sanitize(str(exc)),
                }
            )

    if not images:
        raise ToolError("vision-unavailable", "一帧都没有取到", retryable=True)

    return {
        "ok": True,
        "tool": "bili_frames",
        "bvid": info.get("bvid") or bvid,
        "title": _clean_html(info.get("title"))[:200],
        "page": page,
        "pages": total_pages,
        "partTitle": part.get("part") or "",
        "duration": duration,
        "coveredSec": round(covered, 1),
        "tile": f"{tile_w}x{tile_h}",
        "frames": frames,
        "failed": failed,
        "delivered": len(images),
        "requested": len(picked),
    }, images


async def tool_bili_cover(args: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    from bilibili_api import video

    bvid = _check_bvid(args.get("bvid"))
    try:
        v = video.Video(bvid=bvid, credential=_credential())
        info = await asyncio.wait_for(_video_info(v), timeout=HTTP_TIMEOUT)
    except Exception as exc:
        raise _wrap_api_error(exc)
    pic = info.get("pic")
    if not pic:
        raise ToolError("parse-failed", "视频没有封面地址")
    url = _https(str(pic).split("@", 1)[0]) + f"@{COVER_WIDTH}w.jpg"
    raw = await _fetch_bytes(url, max_bytes=MAX_IMAGE_BYTES)
    # 统一转成 JPEG：主进程的 ToolImage 只接受 jpeg/png，避免 webp 在某些
    # 模型通道被静默丢弃，也保证 width/height 与最终交付的字节一致。
    try:
        from PIL import Image

        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            width, height = image.size
            if width < 16 or height < 16:
                raise ToolError("parse-failed", "封面尺寸异常")
            buffer = io.BytesIO()
            image.convert("RGB").save(buffer, format="JPEG", quality=85)
            raw = buffer.getvalue()
    except ToolError:
        raise
    except Exception as exc:
        raise ToolError("parse-failed", "封面不是可用图片类型") from exc
    if len(raw) > MAX_IMAGE_BYTES:
        raise ToolError("parse-failed", "封面转换后体积超过限制")
    return {
        "ok": True,
        "tool": "bili_cover",
        "bvid": info.get("bvid") or bvid,
        "title": _clean_html(info.get("title"))[:200],
        "duration": _duration_sec(info.get("duration")),
        "coverKb": round(len(raw) / 1024, 1),
    }, [_image_content(raw, "image/jpeg", width, height)]


async def tool_bili_account(args: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    from bilibili_api import user

    cred = _require_credential()
    try:
        info = await asyncio.wait_for(user.get_self_info(credential=cred), timeout=HTTP_TIMEOUT)
    except Exception as exc:
        raise _wrap_api_error(exc)
    # get_self_info uses /x/space/myinfo, whose fields are mid/name (not uid/uname).
    # An unexpected response shape is not evidence that the saved login expired.
    mid = info.get("mid") if isinstance(info, dict) else None
    if isinstance(mid, bool) or not isinstance(mid, (int, str)) or not re.fullmatch(r"[1-9][0-9]*", str(mid)):
        raise ToolError("parse-failed", "账号信息格式无法识别，请稍后重试", retryable=True)
    vip = info.get("vip") if isinstance(info.get("vip"), dict) else {}
    return {
        "ok": True,
        "tool": "bili_account",
        "uid": str(mid),
        "name": str(info.get("name") or "")[:80],
        "level": _int(info.get("level")),
        "vip": bool(vip.get("status")),
    }, []


TOOL_IMPLS = {
    "bili_recommend": tool_bili_recommend,
    "bili_search": tool_bili_search,
    "bili_video_info": tool_bili_video_info,
    "bili_subtitle": tool_bili_subtitle,
    "bili_frames": tool_bili_frames,
    "bili_cover": tool_bili_cover,
    "bili_account": tool_bili_account,
}


# ---------------------------------------------------------------------------
# JSON-RPC 循环
# ---------------------------------------------------------------------------


class Server:
    def __init__(self) -> None:
        self.write_lock = asyncio.Lock()
        self.tasks: dict[str, asyncio.Task[Any]] = {}
        self.started = time.time()

    async def send(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        async with self.write_lock:
            sys.stdout.write(line)
            sys.stdout.flush()

    async def send_error(self, request_id: Any, code: int, message: str) -> None:
        await self.send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": code, "message": message},
            }
        )

    async def handle_initialize(self, request_id: Any, params: dict[str, Any]) -> None:
        global _INITIALIZED
        try:
            _accept_credentials(params.get("_meta"))
        except ToolError as exc:
            await self.send_error(request_id, -32602, exc.message)
            return
        requested = params.get("protocolVersion")
        version = requested if isinstance(requested, str) and requested else PROTOCOL_VERSION
        _INITIALIZED = True
        _log("initialized")
        await self.send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                },
            }
        )

    async def handle_tools_list(self, request_id: Any) -> None:
        tools = []
        for name in _ALLOWED:
            spec = TOOL_SPECS[name]
            tools.append(
                {
                    "name": name,
                    "description": spec["description"],
                    "inputSchema": spec["inputSchema"],
                    "annotations": {"readOnlyHint": True, "destructiveHint": False},
                }
            )
        await self.send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": tools}})

    async def handle_tools_call(self, request_id: Any, params: dict[str, Any]) -> None:
        name = params.get("name")
        arguments = params.get("arguments")
        if not isinstance(name, str) or name not in TOOL_SPECS:
            await self.send(
                _emit_result(
                    request_id,
                    {
                        "ok": False,
                        "code": "internal",
                        "message": "未知工具",
                        "retryable": False,
                    },
                )
            )
            return
        if name not in _ALLOWED:
            # 白名单外的工具即使被直接点名也不能执行。
            _log(f"denied tool call: {name}")
            await self.send(
                _emit_result(
                    request_id,
                    {
                        "ok": False,
                        "code": "internal",
                        "message": "这个工具没有启用",
                        "retryable": False,
                    },
                )
            )
            return
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            await self.send(
                _emit_result(
                    request_id,
                    {
                        "ok": False,
                        "code": "parse-failed",
                        "message": "工具参数必须是对象",
                        "retryable": False,
                    },
                )
            )
            return
        impl = TOOL_IMPLS[name]
        _log(f"call {name}")
        try:
            payload, images = await impl(arguments)
            await self.send(_emit_images_result(request_id, payload, images))
        except asyncio.CancelledError:
            await self.send_error(request_id, -32800, "Request cancelled")
            raise
        except Exception as exc:
            payload = _failure_payload(exc)
            payload["tool"] = name
            if not isinstance(exc, ToolError):
                _log(f"tool failure {name}: {type(exc).__name__}: {_sanitize(str(exc))}")
            await self.send(_emit_result(request_id, payload))

    async def dispatch(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        request_id = message.get("id")
        is_notification = "id" not in message
        if method == "notifications/initialized":
            return
        if method == "notifications/cancelled":
            params = message.get("params") if isinstance(message.get("params"), dict) else {}
            target = params.get("requestId")
            task = self.tasks.pop(str(target), None)
            if task is not None:
                _log("cancel requested")
                task.cancel()
            return
        if method == "initialize":
            params = message.get("params") if isinstance(message.get("params"), dict) else {}
            await self.handle_initialize(request_id, params)
            return
        if method == "ping":
            if not is_notification:
                await self.send({"jsonrpc": "2.0", "id": request_id, "result": {}})
            return
        if method == "tools/list":
            if not is_notification:
                await self.handle_tools_list(request_id)
            return
        if method == "tools/call":
            params = message.get("params") if isinstance(message.get("params"), dict) else {}
            if is_notification:
                return
            key = str(request_id)
            task = asyncio.create_task(self.handle_tools_call(request_id, params))
            self.tasks[key] = task

            def cleanup(_task: asyncio.Task[Any], key: str = key) -> None:
                self.tasks.pop(key, None)

            task.add_done_callback(cleanup)
            return
        if not is_notification:
            await self.send_error(request_id, -32601, "Method not found")

    async def run(self) -> None:
        _log(f"started pid={os.getpid()} tools={','.join(_ALLOWED)}")
        # Windows 的 Proactor 事件循环不支持 connect_read_pipe(stdin)（管道句柄
        # 会报 WinError 6）。放到线程里阻塞读，简单且跨平台可靠。
        stdin = sys.stdin.buffer if getattr(sys.stdin, "buffer", None) is not None else sys.stdin
        while True:
            line = await asyncio.to_thread(stdin.readline)
            if not line:
                break
            if isinstance(line, bytes):
                text = line.decode("utf-8", errors="replace").strip()
            else:
                text = str(line).strip()
            if not text:
                continue
            try:
                message = json.loads(text)
            except json.JSONDecodeError:
                await self.send_error(None, -32700, "Parse error")
                continue
            if not isinstance(message, dict):
                await self.send_error(None, -32600, "Invalid Request")
                continue
            try:
                await self.dispatch(message)
            except Exception:
                _log("dispatch failure: " + _sanitize(traceback.format_exc().splitlines()[-1]))
        for task in list(self.tasks.values()):
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        _log("stdin closed; exiting")


def main() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(newline="\n")  # type: ignore[attr-defined]
        except Exception:
            pass
    # 业务模块只在需要时导入，保证白名单错误能先于重量级依赖报出来。
    asyncio.run(Server().run())


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except KeyboardInterrupt:
        pass
