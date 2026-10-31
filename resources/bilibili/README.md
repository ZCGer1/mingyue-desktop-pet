# B 站只读 Python 资源

本目录是桌宠独立 B 站阅读路线的 Python 侧入口、依赖锁和本地转写脚本。
它们由主进程按需复制/调用，**不随桌面应用直接执行**，也不修改系统 Python。

## 上游参考（MIT）

产品流程、stdio MCP 生命周期、二维码登录、字幕/故事板与转写思路参考：

- 仓库：<https://github.com/c1overzz/dsh-bili-scroll>
- 版本：`2.3.1`
- 固定 commit：`2c7b3f14f525360f8657b102ec453fd8f02baf3a`（2026-10-28）
- 许可：MIT，Copyright (c) 2026 c1overzz
- 查阅日期：2026-10-29

本项目没有把该仓库作为运行时依赖，也没有整体复制其代码；实现改为
Electron/TypeScript 主进程 + 原始 newline-delimited JSON-RPC 2.0（不使用
`mcp` SDK）+ npm `qrcode`，依赖集合与上游不同。若后续补充了具体改编代码，
必须在 `NOTICE.md` 和本文件注明来源与 MIT 许可。

上游 MIT 全文：

```text
MIT License

Copyright (c) 2026 c1overzz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `mcp_server.py` | stdio JSON-RPC 服务；固定 7 个只读工具白名单：推荐、搜索、视频信息、字幕、故事板抽帧、封面、账号。 |
| `asr_worker.py` | 单任务本地转写：受控下载音频、尺寸/时长检查、faster-whisper 本地模型、退出清理；不接云端。 |
| `prepare_model.py` | 仅在用户点击「下载转写模型」时把固定模型下载到应用数据目录。 |
| `requirements.txt` | B 站服务依赖锁定（2026-10-29）。 |
| `requirements-asr.txt` | 本地转写依赖锁定（2026-10-29）；CPU int8，无 CUDA。 |

## 安装方式

- 优先使用系统已有的 Python **3.10 或更高版本**（探测 `py -3` / `python`
  等入口）。若缺失，用户可在设置页显式安装应用专用 Python：
  Windows 官方安装包 `python-3.12.10-amd64.exe`，固定来源
  `https://www.python.org/ftp/python/3.12.10/`，固定 SHA-256
  `67b5635e80ea51072b87941312d00ec8927c4db9ba18938f7ad2d27b328b95fb`；
  下载后先校验哈希，再以 `InstallAllUsers=0`、`PrependPath=0`、
  `Shortcuts=0`、`AssociateFiles=0` 安装到应用数据目录。不会静默安装，
  不改系统 PATH、文件关联或全局 Python。
- 「安装/修复服务」会在应用数据目录创建独立 venv 并执行
  `python -m venv` + `pip install -r requirements*.txt`；不改系统 Python，
  不写全局 site-packages。
- 转写模型只在用户点击「下载模型」后由 `prepare_model.py` 下载；运行期
  `local_files_only=True`，不会隐式联网拉模型。
- 依赖和模型均放在 `<appData>/bilibili/`；卸载应用或手动删除该目录即可
  清理，用户运行数据不会被安装流程覆盖。

## 第三方依赖许可

以下版本在 `requirements*.txt` 中精确锁定，由 pip 在用户机器上安装到独立
venv；应用安装包不内置这些 Python 包。

| 依赖 | 版本 | 许可（以实际 wheel 内 LICENSE 为准） |
| --- | --- | --- |
| `bilibili-api-python` | 17.4.2 | **GPL-3.0-or-later**（PyPI 元数据与 trove classifier；以 wheel 内许可证为准） |
| `aiohttp` | 3.14.5 | Apache-2.0 |
| `Pillow` | 12.3.0 | HPND |
| `faster-whisper` | 1.2.1 | MIT |
| `yt-dlp` | 2026.10.26 | Unlicense |
| 上述包的传递依赖 | 由 pip 解析 | 各自 LICENSE；安装后可在 venv 的 `.dist-info` 中查看 |

注意：`bilibili-api-python` 是 GPL-3.0-or-later，不是 MIT。它只在用户机器
的独立 venv 中运行，不属于本应用源码；分发/商用前请自行复核 GPL 义务。
本说明不构成法律意见。

## 安全不变量

- Python 工具白名单显式且 fail-closed；未配置白名单时不暴露任何工具。
- 登录凭据只经主进程的 stdio initialize `_meta` 传入 Python 内存；不写
  argv、环境变量、渲染进程、提示词或日志，不落盘明文。
- Cookie 只发送给 B 站域；校验二维码跳转域名与下载 URL 允许列表；本地转写下载逐跳校验重定向，且从不携带 Cookie。
- 只读：不点赞、投币、收藏、关注、评论、发弹幕、私信、购买、分享或发布。
- 本地转写只用 faster-whisper，不调用云端 ASR；取消/退出会终止子进程树
  并清理临时音频。
- 字幕、转写、画面只用于当轮上下文，不写入发现列表摘要或每日日报全文。
