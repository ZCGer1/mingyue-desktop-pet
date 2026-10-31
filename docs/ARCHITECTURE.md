# 架构与能力归属

本文描述当前构建（2026-10-30）的运行时边界。项目整合目标见 [PLAN-PROJECT-CONSOLIDATION-2026-10-29.md](../PLAN-PROJECT-CONSOLIDATION-2026-10-29.md)；本轮上下文/连续性修复见 [PLAN-REVIEW-CONSOLIDATION-2026-10-30.md](../PLAN-REVIEW-CONSOLIDATION-2026-10-30.md)；B 站重构范围见 [PLAN-BILIBILI-REFACTOR-DSH-SCROLL.md](../PLAN-BILIBILI-REFACTOR-DSH-SCROLL.md)；应用启动与系统动作边界见 [PLAN-APP-AUTOLAUNCH-AND-SYSTEM-ACTIONS-2026-10-29.md](../PLAN-APP-AUTOLAUNCH-AND-SYSTEM-ACTIONS-2026-10-29.md)；工具名称与风险矩阵以当前代码和 [SETTINGS-GUIDE.md](SETTINGS-GUIDE.md) 为准。

## 1. 进程与模块边界

| 层 | 主要位置 | 职责 | 不负责 |
| --- | --- | --- | --- |
| Electron 主进程 | `src/main/` | 窗口/托盘生命周期、单实例、IPC 校验、配置落盘、密钥（DPAPI）、浏览器桥、B 站服务/凭据/阅读记录/日报、CUA/桌面端口、诊断导出 | 不把 API Key、B 站 Cookie 或原始凭据交给渲染进程 |
| 预加载桥 | `src/preload/index.ts` | 以白名单方式暴露 `window.mingyue`，按窗口角色限制 IPC | 不提供任意 Node 能力 |
| 设置/聊天/桌宠渲染页 | `src/renderer/`, `src/pet-page/` | 展示、草稿编辑、即时动作、快捷输入、dsh-pet 透明 WebM 动画、拖拽物理与停靠 | 不拥有最终授权判断，不直接执行工具 |
| Electron-free 内核 | `src/core/` | 会话、事件总线、唤醒调度、风险/审批、工具执行、World 注册 | 不依赖 Electron；不读取窗口 API |
| World 适配器 | `src/worlds/` | 网页、文件、桌面、CUA、终端、活动感知等具体能力与观察 | 不自行扩大用户授权 |
| 共享契约 | `src/shared/` | 配置 schema/迁移、能力状态、有效范围、IPC 类型、风险规则 | 无进程副作用 |
| 扩展/辅助进程 | `browser-extension/`, `resources/cua/`, `resources/*.ps1` | 浏览器页面观察/控制、真实键鼠输入、前台采样 | 不持有长期凭据；断连时明确失败 |
| B 站 Python 子进程 | `resources/bilibili/mcp_server.py`, `asr_worker.py` | 由主进程 `BilibiliService` 启动的独立 stdio JSON-RPC 服务与本地转写 worker；固定只读白名单、无云 ASR | 不接触渲染进程；凭据只经 initialize `_meta` 进内存；不写明文 |

## 2. 三层“能力状态”

这三个概念不能混用：

1. **草稿**：设置页内存中的未保存修改。只表示“准备写入什么”，不代表已授权或许可执行。
2. **已保存授权**：`config.json` / 配置存储中的 `exploration`、`worlds.desktop`、`worlds.cua`、`worlds.web` 等字段。由用户显式保存或撤销。
3. **运行时事实**：扩展是否连接、目录是否可读、输入辅助程序是否健康、模型是否具备图片输入等。每次快照重新观察，不能由草稿推断。

统一视图由 `src/shared/capabilityStatus.ts` 构造，状态集合为：

`unauthorized` / `disabled` / `pending-connection` / `missing-consent` / `directory-unavailable` / `expired` / `ready` / `fault`，以及兼容用的 `limited`。

设置页、调度器前置检查、提示词摘要和诊断都消费该快照；**最终执行前仍由 `CapabilityStore` 与风险/审批层重新验证**，快照不是执行许可。

## 3. 能力归属矩阵

| 能力 | 配置/授权事实 | 运行时检查与执行 | 用户可见入口 |
| --- | --- | --- | --- |
| 公开网页搜索/读取 | `worlds.web` + `exploration.web` | Web World；网络失败如实返回 | 电脑能力 → 浏览网页 |
| 用户浏览器页面 | `worlds.browserPage` + 扩展内同意 | 浏览器桥 + 扩展；未连接返回不可用 | 电脑能力 → 浏览网页 |
| 她自己的标签页/主动浏览 | `exploration.enabled/browserTabs` + `worlds.browserControl` | BrowserControl World + 扩展主动浏览同意 | 电脑能力 → 浏览网页 |
| 普通网页主动浏览与本地发现 | `worlds.browserControl.enabled/consentAt` + `exploration.browserTabs` | BrowserControl World + 扩展主动浏览同意；`web_*` 会话、预算与 `DiscoveryStore` 有界记录；自有标签页/媒体守卫 | 电脑能力 → 浏览网页 |
| B 站独立阅读与日报 | `worlds.bilibili.enabled/consentAt` + `exploration.active` 且未排除 `bilibili.com` | BilibiliWorld → `BilibiliService` → Python stdio 只读服务；`bili_*` 会话、预算、阅读记录与当天日报；**不要求扩展、后台标签页或浏览器登录** | 电脑能力 → B 站独立阅读 |
| 网页/B 站共用发现 | 上述任一入口 + 本地保留策略 | 同一个 `DiscoveryStore`；一次性 `observationId` 换取真实标题/规范链接/证据层级；分享、反馈与停止语义共用 | 电脑能力 → 浏览网页/发现列表 |
| 普通应用发现/启动/切换 | `exploration.apps/windows`，`worlds.desktop.apps` 例外 | DesktopActionCoordinator、Desktop World、UIA/前台窗口守卫 | 电脑能力 → 使用应用 |
| 启动白名单应用与系统动作 | `worlds.system.enabled/apps`（唯一显式应用授权来源）、`allowPaths/allowUrls` | SystemWorld；按 appId 从最新配置解析并复验，脚本宿主与路径守卫；批复后经平台端口执行固定七种系统动作 | 电脑能力 → 应用与系统 |
| 屏幕观察/截图/键鼠 | `worlds.cua` 双同意 + `exploration.fullScreen` + 图片输入 | CUA World、`resources/cua/input.ps1`、截图守卫；与屏幕感知共用 `captureScreen`，但授权、用途与目标身份分别记录 | 电脑能力 → 观察与操作屏幕 |
| 文件只读探索 | `exploration.fileRead/includeProfile/readRoots/excluded*` | File World、路径守卫、敏感目录拒绝 | 电脑能力 → 探索文件 |
| 作品/笔记写入 | `exploration.artifacts/artifactRoot`、`worlds.workspace` | Workspace World、快照与撤销 | 电脑能力 → 她的作品空间 |
| 自主探索任务 | `autonomy.*` + 上述集中授权 | TaskRunner、Core 唤醒调度、TaskStore、任务级 grant | 活动与任务 |
| 审批与红区 | `autonomy.approvalMode`、`approval.*`、终端/命令白名单 | `RiskPolicy` + `ApprovalGate`；红区硬底线不可配置；应用白名单只属于 `worlds.system.apps` | 高级与诊断 |
| 记忆与感知 | `memory.*`、`worlds.activity`、`worlds.activity.vision`、整屏共享同意 | Memory/Activity World；原始采样与截图不落盘 | 记忆与隐私 |

### 3.1 B 站独立阅读的数据流

```
BilibiliWorld (src/worlds/bilibili/world.ts)
  ├─ 会话/预算/候选去重/证据分级/停止与冷却
  ├─ BiliReadingPort (src/worlds/bilibili/port.ts)
  │    ├─ BilibiliService (src/main/bilibili/service.ts)
  │    │    ├─ BiliMcpClient ↔ Python mcp_server.py (stdio JSON-RPC 2.0)
  │    │    ├─ BiliLoginManager（二维码状态机，主进程内存）
  │    │    ├─ DPAPI 凭据存储（credentials.enc）
  │    │    ├─ BiliAsrJobs → asr_worker.py（本地 faster-whisper）
  │    │    └─ ReadingStore + DailyReport（按账号分区）
  │    └─ DiscoveryPort → 共用 DiscoveryStore
  └─ Persona：ENV_PROMPT / 主动浏览协议 / 反馈软偏好
```

- 工具白名单固定为 `bili_recommend`、`bili_search`、`bili_video_info`、`bili_subtitle`、`bili_frames`、`bili_cover`、`bili_account`；Python 侧对未列入白名单的工具 fail-closed。没有点赞、投币、收藏、关注、评论、弹幕、私信或发布接口。
- Python 子进程通过 `--request` 文件读取初始化参数，凭据只经 initialize 请求的 `_meta` 传入并在子进程内存中使用；不写 argv、环境变量、stdout 日志或磁盘明文。请求带超时与取消，取消会终止进程树。
- 环境：优先复用系统 Python 3.10+；缺失时只有用户显式点击才从 python.org 固定 URL 下载 Python 3.12.10 安装包，先校验固定 SHA-256，再以 `InstallAllUsers=0 / PrependPath=0 / Shortcuts=0 / AssociateFiles=0` 安装到 `<appData>/bilibili/python`。服务与转写各自使用独立 venv；不修改系统 PATH、文件关联或全局 site-packages。
- 阅读顺序：推荐/搜索候选 → 详情（分 P 与 cid）→ 分段字幕原文（累计覆盖率）→ 覆盖不足时提交本地转写（全局单任务、队列上限 10、最多 2 次尝试，完成后唤醒）→ 仅内容依赖画面时抽故事板帧（最多 6 帧）→ `bili_assess` 记录判断。评价证据必须达到相应等级：`worth` 需完整字幕/转写或画面，`okay` 至少部分原文/画面，否则只能 `unknown`。
- 转写下载只接受由已验证 BV/分 P 解析出的 HTTPS 媒体地址；实际下载由 worker 自己完成，逐跳校验 B 站媒体域名白名单、最终 URL、体积与时延，不携带 Cookie，取消时立即停止读取并清理临时音频。
- 阅读记录按账号分区（匿名或 `SHA-256(uid)` 前 16 位），只保存结构化字段与计数，不保存字幕/转写全文。每次评价或有效转写完成都原子重建当天 Markdown 日报；跨天完成的转写计入实际完成日，不重复标题。日报默认保留 30 天；记忆关闭时全部只存内存。
- 发现流：工具回执里的 `observationId` 是一次性、有时效的观察令牌；`discovery_save` 用它换取经过校验的标题、规范链接、作者和证据层级，模型不能自行填写这些字段。发现以 `discoveryId` 关联主动 Episode，用户回应后由快捷聊天/完整聊天卡片展示；这不是 `mem_*` 记忆。喜欢/少分享/别再研究反馈作为软偏好进入提示词，不作为硬过滤或人格改写。删除/清空发现会同步删除相关阅读记录并重建受影响日报；停止会作废未使用的观察 token、终止在途请求/转写，并拦截迟到的分享。
- 关键词：`keywords` 只作为“优先搜索”的软偏好进入提示词；`excludeKeywords` 在本地对候选与详情的标题/作者/简介/标签做大小写不敏感硬过滤，命中即跳过且不建立阅读记录。过滤发生在本地，不额外请求 B 站。
- 视觉：只有 `worlds.bilibili.vision.enabled` 且模型声明图片输入时，服务才把故事板 JPEG 交给主模型；封面明确不作为观看证据。图片是否真正被模型接收仍取决于提供商实际能力，未做真实模型验收时标记为“未验证”。

### 3.2 普通网页主动浏览与发现

`web_*` 工具只使用扩展创建/接管的她自己的后台标签页，进入页面后回读静音、播放与 audible 状态；普通网页与 B 站共用同一个 `DiscoveryStore`、分享状态、反馈、停止和保留策略，但两条路线的配置与运行时前置条件相互独立：关闭扩展或浏览器不会使 B 站独立阅读失效，反之亦然。网页内容只在当轮使用，不写日志、事件库、记忆或诊断；观察令牌按一次性、有时效处理。

### 3.3 屏幕感知与 CUA 截图的统一基础设施

```
ActivityWorld ── foreground bounds / windowKey(HWND) ──▶ VisionService
                                                         ├─ captureScreen(purpose:'ambient', targetKey)
                                                         │    └─ src/main/vision/capture.ts
                                                         ├─ dHash/质量/变化判断（单帧，不保留帧环）
                                                         ├─ SemanticInterpreter（单张 JPEG、无工具、独立请求）
                                                         └─ SceneDescriptor（observationId/目标/世代/有效期）
                                                              └─▶ ActivityWorld

CUA World ── ElectronCuaPort ── captureScreen(purpose:'cua', displayId) ── 同一采集器
```

- **共用采集器，不共用授权**：`src/main/vision/capture.ts` 同时服务 CUA 和被动感知；
  每次采集都记录用途（`cua`/`ambient`）与目标身份。CUA 的观察/操作双同意、整屏
  共享同意、行为感知开关彼此独立，不能相互推导。
- **目标绑定**：被动感知把前台窗口的物理矩形换算为 DIP，按相交面积选择显示器，
  截取整块屏幕且不做窗口裁剪。目标无法确认时跳过并返回机器可读原因，绝不静默回退
  到鼠标所在屏或主屏；截图返回后再次校验用途、目标、采集时间与目标世代，不符即丢弃。
- **调度**：同一时刻最多一次采集、一次模型请求，另至多保留一个最新候选；默认
  60 秒，连续 3 次无明显变化后 120 秒，窗口身份（进程名 + HWND 哈希）变化时作废旧
  摘要并恢复基础节奏。失败按有界退避，没有隐藏的按小时配额。
- **模型请求**：使用当前聊天 provider 的模型/地址/凭据，但载荷只有一张图片和固定
  提示，不携带工具定义或会话历史；请求绑定 observationId、目标、revision/世代与
  provider 世代。迟到、取消、目标变化或总结过期（约 90 秒）的结果不会回填。
- **生命周期**：暂停、锁屏、挂起、敏感前台、会议、CUA 占用、撤销同意、清除、退出
  都会取消在途请求并释放 JPEG/位图引用；恢复后重新确认目标，不补发旧帧。
- **数据边界**：截图只在主进程内存短期存在，不写磁盘、日志、会话、事件库或诊断
  导出。进入 ActivityWorld 的只有抽象类别、通用阶段、时间、置信度、来源与应用显示
  名；`shareAppName=false` 约束这些字段，但不改变整屏图片本身可能含有的内容。

## 4. 保留的核心执行模块

| 模块 | 位置 | 保留原因 |
| --- | --- | --- |
| `ToolExecutor` | `src/core/toolExecutor.ts` | 工具执行、参数校验、审批结果与实际 outcome 的统一入口；不能用“页面已点击”替代执行结果 |
| `TaskRunner` | `src/core/taskRunner.ts` | 自主任务状态机、任务级 grant、暂停/取消/恢复；不能被聊天循环吞并 |
| `CapabilityStore` | `src/core/capabilityStore.ts` | 运行期授权与范围复核，防止设置快照过期后继续执行 |
| `DesktopActionCoordinator` | `src/core/desktopCoordinator.ts` | 桌面租约、前台输入互斥、接管与紧急停止；网页/应用/CUA 共用 |
| `requestBudget` | `src/core/requestBudget.ts` | 主聊天与快捷聊天共用的整包估算：消息、工具参数、工具 schema、图片、输出预留与安全余量；用真实 usage 平滑校准，不把估算当计费 |
| `TurnWorkState` | `src/core/turnWorkState.ts` | 当前任务的短期目标、用户修正、已成功动作、未解决/未知问题和最近回复；只驻内存，交接后作为 ephemeral system 记录重新注入 |
| `runTurnLoop` | `src/core/turnLoop.ts` | 主聊天与快捷聊天共用的单轮循环骨架：准备、流式/工具批次、结束状态；不持有会话或 UI |
| `ContextAssembler` | `src/core/contextAssembler.ts` | 协议闸门、整包预算和分段诊断的唯一入口；世界提示词可见性归 `worldPrompt.ts` |
| `SessionRouter` | `src/core/sessionRouter.ts` | 话题身份与视图映射；Episode/Handoff 仍分别归各自 store |
| `CompanionCandidateBoard` | `src/core/companionCandidate.ts` | 主动表达候选的统一准入/去重/时效；最终展示闸门只在 `Bot.handleProactiveSay` |
| `ToolContract` | `src/core/toolContract.ts` | 对现有注册表/组/元数据的只读一致性审计与静态目录生成；不是第二套注册表 |
| `contextWindow` | `src/core/contextWindow.ts` | 交接尾部预算裁剪与工具事务配对；纯函数，不读写会话 |
| `ConfigurableDeepSeekProvider` | `src/botProvider.ts` | 按配置/密钥惰性重建 Provider；Bot 只持有实例，不保存密钥 |

### 4.1 上下文连续性与交接

- **工作状态不依赖长期记忆开关**：`TurnWorkState` 由用户消息、成功/失败工具回执和回复更新；`memory.enabled=false` 时仍保留在内存中，但不写入 `recent.md` 或其他长期文件。清除会话会同时 `reset()`。
- **交接按工具事务裁剪**：`buildHandoffTail` 把一组 `assistant.tool_calls` 与其后续 `tool` 回执视为不可分割单元，保留最近 6 个对话单元、8 个工具事务，并额外保护最后一条用户目标；不再分别截取固定条数的对话和回执。
- **过期成功回执不等于 unknown**：`trimTail` 先压缩超长成功回执为 `EXPIRED_TOOL_TEXT`，同时置 `expired:true`；失败/未知回执保持原样。配对修复只处理真正缺失的调用/回执，不能把已成功但正文过期的动作改写成“结果未知”。
- **turn 硬上限不被交接重置**：`Core.turnRoundCount` 在 `beginTurn` 时归零，交接只重置 `session.roundCount`；因此一次 turn 内多次压缩不能增加工具轮预算。
- **请求级预算**：主聊天在每次 `modelRound` 发送前、快捷聊天在初始发送和每轮工具调用前，都用整包估算检查容量；超限先交接/裁剪，仍放不下则明确停止并提示，不发送必然失败的请求。`tools_load` 增大 schema、单条超长回执和超大 system 都计入同一口径。
- **目标引用**：`files_*` 返回 `path:<hash>`，浏览器观察/动作返回同一域名口径，窗口动作/截图返回同一应用标签口径；`TaskRunner` 只接受与最后副作用相同引用的验证步骤，缺失引用时降为观察级证据，不能把无关观察当成确定性验证。

### 4.2 统一会话与主动表达边界

- **统一运行内核**：`ConversationRuntime` 拥有当前用户 Session 和 FIFO 租约；`TurnEngine` 负责轮次、物理重试调度、模型流、工具调用片段累积和串行工具批次。Core 与 QuickChat 提供来源策略及呈现回调，所有真实工具继续走同一个 ToolExecutor。快捷纯文本与工具请求使用同一路径。
- **统一上下文**：两个入口读取 ConversationRuntime.session；快捷只缓存当前在途事务，结束后原子提交 memory 记录并丢弃缓冲。ContextAssembler 负责协议闸门与整包预算。SessionRouter 继续路由 Episode，生产同话题不再消费文本交接桥。
- **气泡只裁剪呈现**：`QuickChat` 的 `maxChars` 只限制气泡显示；完整模型输出继续进入会话历史、交接和 `onAssistantReply`，较长结果在完整聊天可读。
- **主动表达仲裁**：自主探索、任务进展、发现、屏幕观察、兴趣回访和节奏提示先转换为 `CompanionCandidate`（来源/依据/话题/时效/可打断/是否已分享），由 `CompanionCandidateBoard` 统一决定 `admit/defer/drop`；只有收到真实展示回执才标记“已分享”，失败/取消不消耗话题去重。
- **工具契约**：`TOOL_GROUPS` + `ToolDef` + `toolMeta` + `ToolExecutor` 仍是运行边界；`auditToolContracts()` 只读核对映射漂移，`npm run docs:tool-contract` 生成静态目录 [TOOL-CONTRACT.md](TOOL-CONTRACT.md)。`apps_windows` 等旧入口不再作为独立工具暴露。

## 5. 设置页结构

设置页现在是七个一级页面：概览、陪伴与外观、电脑能力、活动与任务、模型与用量、记忆与隐私、高级与诊断。

- `src/renderer/settings/App.tsx`：路由、草稿版本、保存/冲突、通知和跨页数据装配。
- `src/renderer/settings/pages/`：七个页面组件，只组合各自领域的分区。
- `src/renderer/settings/components/CapabilityCards.tsx`：能力卡片只展示已保存快照的状态与原因；集中授权、目录和应用覆盖分别落在 `pages/computer/` 的 Files/Artifacts/Apps/Screen/Web/Bilibili 分区，审批策略与配额在 `pages/computer/AutonomySection.tsx` 和 `tabs/AutonomyTab.tsx`，记录视图在 `components/RecordPanels.tsx` 与 `tabs/DiagnosticsTab.tsx`。
- `src/renderer/settings/components/SettingsWizard.tsx`：只提交向导展示的字段，基于已保存配置构造请求，不提交其他页面草稿。
- 旧 `TabId` 通过 `TAB_ROUTE` 重定向到新页面/锚点；`#computer/files` 这类直接定位仍有效。

保存约定：

- 请求带 `baseRevision`；主进程版本不一致返回 `conflict`，不覆盖磁盘配置。
- 保存期间继续编辑以 `draftGenerationRef` 识别，响应不会回退较新的草稿。
- 撤销自由探索、停止操作等是即时动作，不保存其他页面草稿。
- 外部修改轮询只在设置页需要时运行（聚焦/定时快照），脏草稿显示冲突条，由用户选择载入、保留覆盖或放弃。

## 6. 已知体量与后续拆分

本轮已拆分设置页面、Permissions 的两个职责块，并将浏览器按键语义放入扩展脚本的真实 DOM 测试。阶段 E 的第一批物理拆分已完成：

- `src/bot.ts` → `src/botProvider.ts`（Provider 配置热替换）；Bot 仍保留生命周期装配、陪伴事件接线与诊断视图。
- `src/core/core.ts` → `src/core/contextWindow.ts`（`trimTail`）与 `src/core/worldPrompt.ts`（World 提示词可见性）；Core 仍保留 turn 执行、事件投递与 task 状态接线。
- `src/main/ipc.ts` → `src/main/ipcSupport.ts`（视图组装、参数校验、注册原语）与 `src/main/ipcPet.ts`（桌宠页 + 快捷聊天注册）；`IpcContext` 归 `ipcSupport.ts`，`runtime.ts` 的导入路径保持兼容。

仍未完成：

- IPC 聊天与各设置领域已拆分，config 已拆为类型、默认值、合并与迁移；旧公共导入路径保留。
- `src/bot.ts` 与 `src/core/core.ts` 仍是大型编排类，探索调度、诊断视图和消息协调尚未继续物理拆开。
- `src/renderer/settings/App.tsx` 仍集中承载草稿、保存、密钥、记忆和跨页查询状态；页面展示已拆出，但状态域还可继续提取为独立 hooks/contexts。

这些是结构性后续工作，不应通过复制一套并行实现来“拆分”。当前行为与测试证据见 [REVIEW-CONSOLIDATION-ACCEPTANCE-2026-10-30.md](reports/REVIEW-CONSOLIDATION-ACCEPTANCE-2026-10-30.md)。


## 2026-10-30 补完实施进度

- Bot 拥有一份 `BudgetCalibrator`，Core 与 QuickChat 共用。按 provider baseUrl/model 分桶，只在内存保存系数。usage 使用物理请求对应的 `rawInputTokens` 校准；输出预留不参与校准。
- 快捷用户活跃状态来自流式 phase 和待审批状态；屏幕忙碌判定及最终主动候选闸门都消费该状态。
- `memory.enabled` 决定人格记忆、兴趣和经历可见性；memory 工具组只决定工具协议可见性。
- 生产 `quickEnd` IPC 兼容映射到 `hideView()`，关闭/展开不清历史、不摘要；空闲也不清历史。显式 reset/clear 保持各自摘要/清除语义。内部旧 finish 路径尚待共享运行内核迁移时删除。
- Core 按用户、后台、taskId 分桶保存工作状态（最多 32 桶，只驻内存）；任务恢复沿用同一桶。明确修正保留目标，新目标清旧动作。自然语言意图判定仍是简单规则，尚未完成任务继续意图与共享 topic identity 的完整接线。
- 整份计划尚未完成；最新实施记录见 [补完进度](reports/REVIEW-CONSOLIDATION-PROGRESS-2026-10-30.md)。


### 任务验证与平台拆分续作

任务证据由 `core/taskEvidence.ts` 的纯校验器和 World 生产的对象引用/状态哈希共同决定。TaskStore v3 记录证据字段与等级，迁移旧格式先备份。只有身份关联且动作后置状态精确回读才记 deterministic；缺身份的用户任务须真实审批确认，自动任务拒绝，视觉证据封顶 visual。TaskRunner 不再使用 targetsMatch 的 null 匹配回退。

`main/ipc.ts` 只负责按原顺序调用各领域注册函数，安全校验继续归 ipcSupport。配置实现位于 `shared/config/{types,defaults,merge,migrate,utils}.ts`，`shared/config.ts` 为兼容公共入口，配置 schema 仍为 27。


### 共享用户话题与后台会话（续作后的当前行为）

- 两个入口使用同一个 Session.id，以 runtime generation 区分话题清空前后；同一话题的模型/工具事务按 FIFO 顺序执行。审批仍留在原入口，另一入口等待，不能并发修改同一历史。
- 快捷记录带 source=quick、retention=memory，当前进程内可见，不写 JSONL；工具配对修复也继承这些标记。压缩的长期摘要输入排除 memory 记录，快捷记录仍在内存尾部保留。截图只保留当前 turn。
- 快捷事务提交后，以只含用户/助手文本的 conversation_append 事件更新完整聊天视图；清空事件同时同步两个视图。关闭/展开只隐藏；显式快捷新话题需确认，才清空两个入口。
- 后台 task:<id>、autonomy、reaction 使用各自非持久化 Session；最多保留 32 个，任务恢复沿用 taskId。它们的工具事务和原始模型输出不进入用户记录；用户可见成果仍经 Task/Discovery/Episode/Experience 的既有流程承接。
- 清空会使在途与排队旧 generation 失效；取消当前用户轮、审批及迟到写回。清空本地数据还清理后台会话缓存。源代码和验证记录见 [运行时验收](reports/SHARED-RUNTIME-ACCEPTANCE-2026-10-30.md)。
