#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桌宠 · 显式准备本地 Whisper 模型。

只有在用户点击「安装/准备转写模型」时才会运行。默认使用 hf-mirror.com，
把模型写进应用数据目录；不做隐式下载。ASR worker 运行时强制
``local_files_only=True`` + ``HF_HUB_OFFLINE=1``，模型缺失会明确报
``asr-model-missing``，不会偷偷联网。

用法：
    prepare_model.py --model small --dir <modelsRoot>
    prepare_model.py --model small --dir <modelsRoot> --check
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ALLOWED = {"tiny", "base", "small", "medium"}


def fail(code: str, message: str) -> int:
    sys.stdout.write(
        json.dumps({"ok": False, "code": code, "message": message}, ensure_ascii=False) + "\n"
    )
    sys.stdout.flush()
    return 1


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model", required=True)
    parser.add_argument("--dir", required=True)
    parser.add_argument("--check", action="store_true")
    args, _rest = parser.parse_known_args()

    model = args.model.strip()
    if model not in ALLOWED:
        return fail("asr-failed", "不支持的转写模型")
    root = Path(args.dir).expanduser().resolve()
    target = root / model
    ready = (target / "model.bin").is_file()
    if args.check:
        payload = {
            "ok": ready,
            "model": model,
            "state": "ready" if ready else "missing",
            "bytes": _dir_size(target) if ready else 0,
        }
        if not ready:
            payload.update({"code": "asr-model-missing", "message": "模型尚未准备"})
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return 0 if ready else 1
    if ready:
        sys.stdout.write(
            json.dumps(
                {"ok": True, "model": model, "state": "ready", "bytes": _dir_size(target)},
                ensure_ascii=False,
            )
            + "\n"
        )
        sys.stdout.flush()
        return 0

    endpoint = os.environ.get("BILI_HF_ENDPOINT", "https://hf-mirror.com").strip()
    if endpoint:
        os.environ["HF_ENDPOINT"] = endpoint
    os.environ["HF_HOME"] = str(root)
    os.environ["HF_HUB_DISABLE_XET"] = "1"
    os.environ.pop("HF_HUB_OFFLINE", None)
    root.mkdir(parents=True, exist_ok=True)

    try:
        from faster_whisper.utils import download_model
    except Exception:
        return fail("asr-not-installed", "转写依赖尚未安装")

    try:
        download_model(model, output_dir=str(target))
    except Exception as exc:
        name = type(exc).__name__
        message = "模型下载失败"
        if "Connection" in name or "Timeout" in name or "HTTP" in name:
            message = "模型下载网络失败，可稍后重试"
        elif "No space" in str(exc):
            message = "磁盘空间不足"
        sys.stderr.write(f"[bili-model] {name}: {message}\n")
        sys.stderr.flush()
        return fail("asr-model-missing", message)

    if not (target / "model.bin").is_file():
        return fail("asr-model-missing", "模型下载完成但文件不完整")
    sys.stdout.write(
        json.dumps(
            {"ok": True, "model": model, "state": "ready", "bytes": _dir_size(target)},
            ensure_ascii=False,
        )
        + "\n"
    )
    sys.stdout.flush()
    return 0


def _dir_size(path: Path) -> int:
    total = 0
    try:
        for item in path.rglob("*"):
            if item.is_file():
                total += item.stat().st_size
    except OSError:
        pass
    return total


if __name__ == "__main__":
    raise SystemExit(main())
