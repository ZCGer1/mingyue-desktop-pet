# 一条住你电脑里全自动吃token的大肥鱼

面向 **Windows 11 x64** 的 AI 桌宠，使用 Electron、TypeScript 和 React 构建。支持透明动画、拖拽与窗口停靠、聊天、记忆和可审批的本地工具调用。

桌宠可以按配置主动交流、探索网页和阅读 B 站内容；文件访问、窗口观察、截图与键鼠操作需要单独授权。当前为开发预览版，模型接入使用API，调用费用由使用者承担。

## 安装包

https://github.com/ZCGer1/mingyue-desktop-pet/releases

## 使用方法

### 从源码启动

准备 Windows 11 x64、**Node.js 24** 和 npm，在项目目录运行：

```powershell
npm ci
npm run dev
```

首次安装需要联网下载依赖；角色动画已随源码提供，无需另装角色运行时。

### 首次配置与日常操作

1. 打开设置，在「模型与用量」填写自己的 API Key，保存并验证连接。
2. 在「陪伴与外观」调整名字、人格和聊天节奏；在「活动与任务」调整自主行为与预算。
3. 在「电脑能力」按需授权网页、应用、屏幕、文件和作品空间；只开启自己需要的能力。
4. 点击桌宠使用快捷输入，通过托盘或设置页的「打开聊天」进入完整聊天窗。桌宠支持拖拽、抛掷及窗口上沿停靠。
5. 需要安静时使用静音或暂停探索；操作审批出现时，核对目标和范围后再同意。

### 可选能力

| 能力 | 启用方式 |
| --- | --- |
| 浏览器页面感知与主动浏览 | 在「电脑能力」的网页设置中开启，点击「打开扩展文件夹」，在 Chrome / Edge 扩展页开启开发者模式、加载该目录，再输入配对码并授权。 |
| B 站独立阅读 | 在 B 站设置中安装服务依赖并扫码登录；需要 Python 3.10+，也可在设置中安装应用专用 Python。本地转写需另装依赖和模型。 |
| 文件与作品 | 选择允许读取的目录和作品输出目录；写入、覆盖、移动、删除等操作受权限与审批控制。 |
| 窗口观察、屏幕与键鼠 | 分别开启相应能力并授权目标应用；图片发送和键鼠操作需额外同意，图片能力取决于实际模型支持。 |

浏览器扩展应加载设置页打开的稳定目录；配对码相当于本地访问口令，请勿公开。B 站阅读使用独立 Python 服务，无需浏览器扩展，服务依赖和转写模型只在用户安装后下载。

### 构建与打包

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 检查主进程、预加载与界面类型 |
| `npm run build` | 构建应用 |
| `npm start` | 启动已构建的应用 |
| `npm run verify:dsh-pet` | 校验上游动画、来源与生成目录 |
| `npm run pack` | 构建 Windows x64 便携版 |
| `npm run dist` | 构建 Windows x64 安装版和便携版 |

安装包输出到 `release/`，文件名为 `MingYue-Pet-<版本>-setup.exe` 和 `MingYue-Pet-<版本>-portable.exe`。打包命令会自动校验包内角色素材。

运行数据位置：开发模式为 `.dev-data/`，安装版为 `%APPDATA%/桌宠/`；便携版在 exe 同级存在 `portable.flag` 或 `data/` 时使用同级 `data/`，否则使用应用数据目录。

## 项目模块

| 目录 | 职责 |
| --- | --- |
| `src/main/` | Electron 主进程：窗口、托盘、配置、加密凭据、浏览器桥、B 站服务及系统能力 |
| `src/preload/` | 受限 IPC 桥，连接界面与主进程 |
| `src/renderer/` | 设置、完整聊天和快捷输入界面 |
| `src/pet-page/` | 透明角色页面、动画、拖拽与交互 |
| `src/core/` | 会话与上下文、事件、唤醒调度、工具执行、权限和审批 |
| `src/persona/` | 人格、提示词和记忆相关逻辑 |
| `src/worlds/` | 网页、文件、工作区、桌面、B 站等能力适配器 |
| `src/shared/` | 配置、类型、IPC 和跨模块契约 |
| `browser-extension/` | Chrome / Edge 页面感知与浏览器控制扩展 |
| `resources/` | 图标、Windows 辅助脚本、B 站 Python 服务和本地转写 |
| `vendor/dsh-pet/` | 固定版本的上游代码、动画、校验信息与许可 |
| `scripts/` | 构建、素材校验与开发诊断脚本 |

## 数据与权限

API Key 由主进程使用 Windows DPAPI 加密保存。聊天、记忆和运行数据保存在本地；发送模型请求时，聊天及已授权的上下文会交给 API 服务处理。应用未实现遥测上报。

文件、网页、窗口和屏幕能力按设置授权，工具执行还受范围检查与审批限制，高风险操作需要人工确认。运行数据目录、密钥、Cookie、浏览器配对码、聊天记录和个人截图不应上传到仓库。提交问题时，可从「高级与诊断」导出脱敏诊断包，并在分享前检查内容。

## 版权、来源与依赖

**本项目源码采用 MIT；随附动画素材有独立的非商业限制，不能用 MIT 概括整个项目。** 完整说明见 [LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)。

| 内容 | 来源与许可 |
| --- | --- |
| 本项目原创代码 | Copyright © 2026 桌宠 contributors，MIT |
| 桌宠表现层与动画 | [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) v0.3.8；代码 MIT，动画素材按上游声明允许开源使用、禁止商用。来源版本与哈希见 [UPSTREAM.json](vendor/dsh-pet/UPSTREAM.json)，素材说明见 [NOTICE-assets.md](vendor/dsh-pet/NOTICE-assets.md)。 |
| Agent 分层架构参考 | [Pal-AI-Lab/Cortico](https://github.com/Pal-AI-Lab/Cortico)，MIT；参考架构思想，未复制其源码。 |
| B 站阅读流程参考 | [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) v2.3.1，MIT；参考登录、字幕、故事板与转写流程，未整体复制其代码。 |

主要技术依赖包括 Electron、React、TypeScript、Vite / electron-vite、electron-builder、zod、zod-to-json-schema、diff、qrcode，以及可选的 `@vscode/ripgrep`；版本见 [package.json](package.json) 与 `package-lock.json`，各依赖遵循其自身许可证。

B 站功能按需安装 `bilibili-api-python`、aiohttp、Pillow；本地转写使用 faster-whisper 和 yt-dlp。**`bilibili-api-python` 采用 GPL-3.0-or-later**，其余依赖也有各自许可，详见 [B 站资源与依赖说明](resources/bilibili/README.md)。

再分发请保留上游署名、许可证和素材限制。商业使用随附动画前，需要取得相应授权或替换为有商业使用权的素材。
