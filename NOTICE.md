# 版权与许可 / Copyright and License

桌宠（MingYue Desktop Pet）包含**不同许可**的内容，请分别遵守。
桌面角色来自 dsh-pet 上游：运行时代码是 MIT，动画素材则只允许开源使用、禁止商用。

This project contains material under **different licenses**. The dsh-pet runtime
code is MIT, while its animation assets are allowed for open-source use with
commercial use prohibited.

---

## 1. 本项目源码 —— MIT

适用于 `src/`、`scripts/`、`resources/` 中由本项目编写的代码与资源。

```
MIT License — Copyright (c) 2026 桌宠 contributors
```

完整文本见 [LICENSE](LICENSE)。

---

## 2. dsh-pet 桌宠运行时、角色与动画素材

### 2.1 代码 —— MIT

桌宠表现层是 **PC2005-cloud/dsh-pet** 的源码移植（单一 `PetController`、
双缓冲 WebM 播放、动画链、拖拽/抛掷物理、右键菜单与工作状态映射）：

- 仓库：<https://github.com/PC2005-cloud/dsh-pet>
- 版本：v0.3.8
- 锁定 commit：`2fa04a5133988a1ca901558e9a18f55845128b41`
- 许可：MIT，版权归 PC2005-cloud
- 完整文本见 `vendor/dsh-pet/LICENSE`
- 来源、采用文件与 SHA-256 见 `vendor/dsh-pet/UPSTREAM.json`

本项目没有打包或启动上游的独立桌面应用、插件、提示词、源视频与素材生成链，
也没有并行运行第二套动画引擎。移植与适配代码位于 `src/shared/dshPet/`、
`src/pet-page/dshPet/` 与 `src/main/petHost/`。

### 2.2 角色与动画素材 —— 允许开源使用，禁止商用

`vendor/dsh-pet/assets/webm/` 中的 106 个 VP9 + Alpha 透明 WebM 来自同一上游
仓库与版本，角色为上游默认的“蓝毛小女仆”。上游 README「许可」一节写明：

> 代码：MIT
> 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**

因此：

- 动画素材**不是 MIT 授权**，不得声称素材采用 MIT；
- 可在开源、非商业语境下随本应用内置与分发；
- 不得单独售卖素材、用于商业产品，或移除上游署名与限制；
- 本项目没有修改素材文件名或内容，完整性由 `UPSTREAM.json`、
  `assets/SHA256SUMS` 与 `npm run verify:dsh-pet` 校验。

### 2.3 你必须

- 保留本文件、`vendor/dsh-pet/LICENSE`、`vendor/dsh-pet/NOTICE-assets.md`
  与 `vendor/dsh-pet/UPSTREAM.json`；
- 若需商业分发，必须自行替换为拥有相应授权的素材，或另行取得上游素材
  权利人的许可；
- 不得暗示上游对本项目背书。

本说明不构成法律意见；发布前请按实际分发场景自行复核。

---

## 3. 架构参考 —— MIT（未复制代码）

本项目的 Core / Persona / Memory / World / Bot 分层、事件流与交接思想参考：

- **Pal-AI-Lab/Cortico**（MIT，Event-stream AI Agent framework）
  <https://github.com/Pal-AI-Lab/Cortico>

本项目**没有复制** Cortico 的源代码；若后续实现中改编了具体代码，应在对应
源文件头与本节注明来源及 MIT 许可。

---

## 4. 其余第三方依赖

Electron、React、Vite、zod、diff、electron-builder 等依赖的许可随
`node_modules` / 安装包中的各自 LICENSE 文件提供。本项目源码以 MIT 发布，
不改变这些依赖的许可。

---

## 5. B 站阅读：dsh-bili-scroll 参考与 Python 运行时依赖

### 5.1 产品与实现参考 —— MIT（未整体复制代码）

独立扫码登录、Python stdio MCP、字幕/故事板/本地转写路线参考：

- 仓库：<https://github.com/c1overzz/dsh-bili-scroll>
- 版本：`2.3.1`
- 固定 commit：`2c7b3f14f525360f8657b102ec453fd8f02baf3a`（2026-10-28）
- 许可：MIT，Copyright (c) 2026 c1overzz
- 本项目资源目录的说明与完整 MIT 文本：`resources/bilibili/README.md`

本项目没有把该仓库作为运行时依赖，也没有整体复制其代码；实现改为
Electron/TypeScript 主进程 + 原始 newline-delimited JSON-RPC 2.0（不使用
`mcp` SDK）+ npm `qrcode`。若后续补充了具体改编代码，必须在此注明来源与
MIT 许可。

### 5.2 Python 依赖 —— 独立 venv，运行时安装

`resources/bilibili/requirements*.txt` 精确锁定以下版本；用户在设置页点击
安装后，应用在应用数据目录创建独立 venv 并用 pip 安装，**不随安装包内置**，
也不修改系统 Python：

| 依赖 | 版本 | 许可（以实际 wheel 内 LICENSE 为准） |
| --- | --- | --- |
| `bilibili-api-python` | 17.4.2 | **GPL-3.0-or-later** |
| `aiohttp` | 3.14.5 | Apache-2.0 |
| `Pillow` | 12.3.0 | HPND |
| `faster-whisper` | 1.2.1 | MIT |
| `yt-dlp` | 2026.10.26 | Unlicense |
| 传递依赖 | pip 解析 | 各自 LICENSE |

`bilibili-api-python` 是 GPL-3.0-or-later，不是 MIT；它只在用户机器的独立
venv 中运行，不属于本应用源码。分发/商用前请自行复核 GPL 义务。本说明不
构成法律意见。

---

## 一句话总结

**本项目代码 MIT；dsh-pet 运行时代码 MIT；dsh-pet 动画素材允许开源使用、
禁止商用，不是 MIT；B 站阅读参考 dsh-bili-scroll（MIT），运行时安装的
`bilibili-api-python` 为 GPL-3.0-or-later。** 再分发请署名 PC2005-cloud、
c1overzz，并保留素材的非商业限制与各依赖许可。
