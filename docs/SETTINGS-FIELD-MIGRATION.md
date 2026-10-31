# 设置字段迁移清单（2026-10-30 整理）

本清单对应 `PLAN-SETTINGS-REORGANIZATION-2026-10-30.md`。目标：每个配置路径只有一个标准编辑位置，
配置流程的每一步只保存自己拥有的字段，原有能力一个不少。

- 代码中的归属表：`src/renderer/settings/settingsPaths.ts`。
- 完整性由 `tests/unit/settingsFieldCoverage.test.ts` 持续校验：每个可编辑配置叶子必须恰好属于一个流程步骤。
- “保存方式”一栏：**表单**＝进入全局草稿，点“保存设置”或流程里的“保存并继续”才写入；
  **即时**＝点击后直接通过主进程动作生效，不经草稿；**只读**＝只展示状态与记录。

## 1. 模型与用量 / 流程 API 步骤

| 配置路径 | 原入口 | 新入口 | 常用/高级 | 保存方式 |
| --- | --- | --- | --- | --- |
| API Key（主进程加密） | 概览、模型与用量 | 模型与用量；流程 API | 常用 | 即时 |
| `provider.model` | 模型与用量 | 同上 | 常用 | 表单 |
| `provider.utilityModel` | 模型与用量 | 同上 | 常用 | 表单 |
| `provider.contextWindow` | 模型与用量 | 同上 | 高级 | 表单 |
| `provider.maxOutputTokens` | 模型与用量 | 同上 | 高级 | 表单 |
| `provider.thinking` | 模型与用量 | 同上 | 常用 | 表单 |
| `provider.visionInput` | 无独立入口（屏幕页只提示） | 模型与用量；流程 API | 常用 | 表单 |
| `provider.baseUrl` | 无 | 模型与用量 → 高级 | 高级 | 表单 |
| `provider.requestTimeoutMs` | 模型与用量 → 网络超时 | 模型与用量 → 高级 | 高级 | 表单 |
| `provider.streamIdleTimeoutMs` | 模型与用量 → 网络超时 | 模型与用量 → 高级 | 高级 | 表单 |
| `context.maxTokens` / `softRatio` / `keepRatio` | 模型与用量 | 模型与用量 → 高级 | 高级 | 表单 |
| `batching.*`（4 项） | 模型与用量 → 合批参数 | 模型与用量 → 高级 | 高级 | 表单 |
| 用量、会话 token | 模型与用量 | 模型与用量 | 只读 | — |

## 2. 网页

| 配置路径 | 原入口 | 新入口 | 常用/高级 | 保存方式 |
| --- | --- | --- | --- | --- |
| `worlds.web.enabled` | 电脑能力 → 浏览网页 | 电脑能力 → 网页 | 常用 | 表单 |
| `worlds.web.askBefore` | 同上 | 同上 | 常用 | 表单 |
| `exploration.web` | 权限与授权 → 日常范围 | 电脑能力 → 网页（自主使用） | 常用 | 表单 |
| `worlds.browserPage.enabled` | 浏览网页 → 浏览器页面感知 | 电脑能力 → 网页 | 常用 | 表单＋同意确认 |
| `worlds.browserPage.consentAt` | 同上 | 同上 | 权限 | 表单（计时写入） |
| `worlds.browserPage.shareTitle` / `shareExcerpt` / `includeHeadings` | 同上 | 网页 → 高级 | 高级 | 表单 |
| `worlds.browserPage.excerptMaxChars` / `coalesceMs` / `maxPerMinute` / `maxPerHour` | 同上 | 网页 → 高级 | 高级 | 表单 |
| `worlds.browserPage.allowlistOnly` / `allowlist` / `denylist` / `sensitiveDomains` | 浏览网页 → 域名过滤 | 网页 → 域名规则 | 常用 | 表单 |
| `exploration.browserTabs` | 权限与授权 → 日常范围 | 网页（自主使用） | 常用 | 表单 |
| `exploration.excludedDomains` | 权限与授权 → 排除的站点 | 网页 → 域名规则 | 常用 | 表单 |
| `worlds.browserControl.enabled` / `consentAt` | 浏览网页 → 主动浏览 | 网页 | 常用 | 表单＋同意确认 |
| `worlds.browserControl.searchUrl` / `maxTabs` / `waitTimeoutMs` / `sessionMaxMs` / `sessionMaxToolCalls` | 浏览网页 → 主动浏览 | 网页 → 高级 | 高级 | 表单 |
| `worlds.browserControl.discoveries.retentionDays` / `maxRecords` | 浏览网页 → 发现与浏览预算 | 网页 → 高级 | 高级 | 表单 |
| `worlds.browserControl.allowDownloads` | 浏览网页 → 主动浏览 | **作品空间** | 常用 | 表单 |
| 扩展配对码 / 桥 / 扩展状态 | 浏览网页 → 扩展配对 | 网页 → 扩展连接 | 只读＋即时 | 即时（复制/轮换/打开目录） |
| 发现列表（记录） | 浏览网页 → 发现列表 | **活动与任务 → 发现** | 记录 | 即时（打开/反馈/删除/清空） |

## 3. B 站

| 配置路径 | 原入口 | 新入口 | 常用/高级 | 保存方式 |
| --- | --- | --- | --- | --- |
| `worlds.bilibili.enabled` / `consentAt` | 浏览网页 → B 站独立阅读 | 电脑能力 → B 站 | 常用 | 表单＋同意确认 |
| `worlds.bilibili.keywords` / `excludeKeywords` | 同上 | B 站 → 阅读偏好 | 常用 | 表单 |
| `worlds.bilibili.vision.enabled` / `report.enabled` | 同上 | B 站 → 阅读偏好 | 常用 | 表单 |
| `worlds.bilibili.asr.enabled` | 同上 | B 站 → 阅读偏好 | 常用 | 表单 |
| `worlds.bilibili.maxCandidatesPerBatch` / `maxDetailsPerSession` | 同上 | B 站 → 高级 | 高级 | 表单 |
| `worlds.bilibili.sessionMaxMs` / `sessionMaxToolCalls` | 同上 | B 站 → 高级 | 高级 | 表单 |
| `worlds.bilibili.vision.defaultFrames` / `maxFrames` | 同上 | B 站 → 高级 | 高级 | 表单 |
| `worlds.bilibili.asr.model` / `maxMediaMinutes` / `maxDownloadMb` / `maxRunMinutes` / `maxCacheMb` | 同上 | B 站 → 高级 | 高级 | 表单 |
| `worlds.bilibili.report.retentionDays` | 同上 | B 站 → 高级 | 高级 | 表单 |
| 扫码登录 / 停止 / 恢复 / 重启 / 安装 | 同上 | B 站（状态区） | 即时 | 即时 |
| 今日阅读 / 日报 | 同上 | B 站（状态区） | 只读 | 即时（查看日报） |

## 4. 应用

| 配置路径 | 原入口 | 新入口 | 常用/高级 | 保存方式 |
| --- | --- | --- | --- | --- |
| `worlds.system.enabled` | 电脑能力 → 应用与系统 | 电脑能力 → 应用 | 常用 | 表单＋同意确认 |
| `worlds.system.apps`（白名单） | 应用与系统 → 应用白名单 | 应用 → 应用白名单 | 常用 | 表单 |
| `worlds.system.allowPaths` / `allowUrls` | 应用与系统 | 应用 | 常用 | 表单 |
| `exploration.apps` | 权限与授权 → 普通应用 | 应用（自主使用） | 常用 | 表单 |
| `exploration.includeNewApps` | 权限与授权 → 新安装应用 | 应用 → 高级 | 高级 | 表单 |
| `exploration.excludedApps` | 权限与授权 → 排除的应用 | 应用 → 高级 | 高级 | 表单 |
| 最近系统操作（记录） | 应用与系统 → 她最近做了什么 | **活动与任务 → 系统操作** | 记录 | 即时（清除） |

## 5. 屏幕

| 配置路径 | 原入口 | 新入口 | 常用/高级 | 保存方式 |
| --- | --- | --- | --- | --- |
| `worlds.activity.vision.enabled` / `consentAt` | 记忆与隐私 → 屏幕感知 | 电脑能力 → 屏幕 | 常用 | 表单＋同意确认 |
| `worlds.activity.vision.screenShareConsentAt` / `screenShareConsentVersion` | 同上（整屏共享） | 屏幕（整屏共享同意） | 常用 | 表单＋同意确认 |
| `worlds.cua.enabled` / `consentAt` / `screenConsentAt` | 屏幕与键鼠 → CUA | 屏幕 | 常用 | 表单＋双重同意 |
| `exploration.windows` | 权限与授权 → 授权窗口观察 | 屏幕 → 窗口观察 | 常用 | 表单 |
| `exploration.fullScreen` | 权限与授权 → 整屏观察 | 屏幕 → 窗口观察 | 常用 | 表单 |
| `worlds.desktop.structuredText` / `windowCapture` | 权限与授权 | 屏幕 → 窗口观察 | 常用 | 表单 |
| `worlds.desktop.apps`（观察/输入） | 权限与授权 → 应用级覆盖 | 屏幕 → 应用观察与输入范围 | 常用 | 表单 |
| `worlds.activity.vision.desktopSampleMs` / `ocrMinGapMs` / `language` / `keepSamples` / `ocrFallback` / `showOcrSnippet` | 记忆与隐私 → 屏幕感知 | 屏幕 → 高级 | 高级 | 表单 |
| `worlds.desktop.maxObservePerHour` / `maxTextChars` / `maxWindows` / `inventoryPollMs` | 权限与授权 | 屏幕 → 高级 | 高级 | 表单 |
| `worlds.cua.permission` / `grantMinutes` / `maxActionsPerTurn` / `screenshotMaxWidth` / `jpegQuality` / `settleMs` / `afterActionScreenshot` / `actionOverlay` / `blockedApps` | 屏幕与键鼠 | 屏幕 → 高级 | 高级 | 表单 |
| 暂停/恢复观察、立即观察、立即停止键鼠、清除免问授权 | 记忆与隐私 / 屏幕与键鼠 | 屏幕 | 即时 | 即时 |
| 屏幕场景与事件诊断 | 记忆与隐私 | **高级与诊断 → 屏幕诊断** | 记录 | 只读＋清除 |

## 6. 文件

| 配置路径 | 原入口 | 新入口 | 常用/高级 | 保存方式 |
| --- | --- | --- | --- | --- |
| `exploration.fileRead` | 权限与授权 → 文件读取 | 电脑能力 → 文件 | 常用 | 表单 |
| `exploration.volumeScope` | 权限与授权 → 磁盘范围 | 文件 | 常用 | 表单 |
| `exploration.includeProfile` | 权限与授权 → 包含个人资料目录 | 文件 | 常用 | 表单 |
| `exploration.edits` | 权限与授权 → 连续编辑 | 文件 | 常用 | 表单 |
| `worlds.workspace.root` | 权限与授权 → 工作区 | 文件 | 常用 | 表单＋目录选择 |
| `worlds.workspace.notesRoot` | 权限与授权 → 笔记目录 | **作品空间** | 常用 | 表单＋目录选择/清空 |
| `exploration.readRoots` | 权限与授权 → 额外只读目录 | 文件 → 目录范围 | 常用 | 表单＋目录选择 |
| `worlds.files.roots` | 权限与授权 → 文件工具额外目录 | 文件 → 目录范围 | 常用 | 表单 |
| `worlds.files.exclude` | 权限与授权 → 用户排除项 | 文件 → 目录范围 | 常用 | 表单 |
| `autonomy.trustedRoots` | 权限与授权 → 工作区与信任目录 | 文件 → 目录范围 | 常用 | 表单＋目录选择 |
| 统一文件范围 / 卷清单（状态） | 权限与授权 | 文件（状态区）与「范围详情（只读）」 | 只读 | — |

## 7. 作品空间

| 配置路径 | 原入口 | 新入口 | 常用/高级 | 保存方式 |
| --- | --- | --- | --- | --- |
| `exploration.artifacts` | 权限与授权 → 作品/下载空间 | 电脑能力 → 作品空间 | 常用 | 表单 |
| `exploration.artifactRoot` | 权限与授权 → 作品目录 | 作品空间 | 常用 | 表单＋目录选择/清空 |
| `worlds.browserControl.allowDownloads` | 浏览网页 → 主动浏览 | 作品空间 | 常用 | 表单 |
| 作品目录 → 笔记目录 → 工作区的回退关系 | 权限与授权 | 作品空间（状态行提示） | 只读 | — |

## 8. 陪伴与外观

| 配置路径 | 原入口 | 新入口 | 常用/高级 | 保存方式 |
| --- | --- | --- | --- | --- |
| `persona.name` / `language` / `tone` | 陪伴与外观 → 身份 | 陪伴与外观 → 身份 | 常用 | 表单 |
| `persona.customPrompt` | 人格提示词 | 人格提示词 | 常用 | 表单 |
| `persona.roleplay` / `styleNotes` | 无 UI | 无 UI（沿用默认） | — | — |
| `companion.cadence` | 聊天节奏 | 聊天节奏 | 常用 | 表单 |
| `companion.screenFeedback.*` | 屏幕感知 | 聊天节奏 → 屏幕感知 | 常用 | 表单 |
| `autonomy.tickMinMs` / `tickMaxMs` / `backoffFactor` / `wakeGapMs` / `postUserCooldownMs` | 陪伴与外观 → 自主行为 | 聊天节奏 | 常用 | 表单 |
| `autonomy.respectQuietHours` / `idlePauseTicks` / `ambientContext` | 同上 | 聊天节奏 | 常用 | 表单 |
| `worlds.activity.quietHours` | 陪伴与外观 → 安静时段；记忆与隐私 → 静音 | 陪伴与外观 → 安静时段 | 常用 | 表单 |
| `worlds.chat.enabled` | 聊天与桌宠窗口 | 聊天 | 常用 | 表单 |
| `chatUi.window.*` / `allowModelOpen` | 同上 | 聊天 | 常用 | 表单 |
| `chatUi.quickInput.*` | 快捷输入 | 聊天 | 常用 | 表单 |
| `chatUi.petClickAction` | 点击桌宠 | 聊天 → 点击桌宠 | 常用 | 表单 |
| `worlds.pet.enabled` / `appearance.*` / `animation.*` / `movement.*` / `confineToScreen` | 桌宠表现 | 桌宠表现 | 常用 | 表单＋即时（归位/参数面板） |
| `worlds.pet.reactions` / `physics` | 无 UI | 无 UI（沿用默认） | — | — |
| `companion.interests` / `experiences` / `unanswered` / `reaction` | 无 UI | 无 UI（沿用默认） | — | — |

## 9. 记忆与隐私

| 配置路径 | 原入口 | 新入口 | 常用/高级 | 保存方式 |
| --- | --- | --- | --- | --- |
| `memory.enabled` / `habits` / `dream` | 记忆开关 | 记忆与隐私 → 记忆开关 | 常用 | 表单 |
| 记忆文件编辑 / 忘记关键词 / 清空文件 | 她记得什么 | 她记得什么 | 即时 | 即时 |
| `worlds.activity.enabled` / `sampleMs` / `idleMinutes` | 只读行为感知 | 记忆与隐私 → 只读行为感知 | 常用 | 表单 |
| 暂停采样 | 同上 | 同上 | 即时 | 即时 |
| `worlds.activity.shareEventsToModel` / `shareAppName` / `shareWindowTitle` / `titleMaxChars` | 进入模型的脱敏事件 | 共享给模型的脱敏事件 | 常用 | 表单 |
| `worlds.activity.retainStatsDays` | 进入模型的脱敏事件 | 共享给模型的脱敏事件 | 常用 | 表单 |
| `worlds.activity.muteCategories` / `exclude` | 静音与排除 | 静音与排除 | 常用 | 表单 |
| `worlds.activity.appSwitchCoalesceMs` / `appSwitchMaxHoldMs` / `timelineMinutes` / `timelineMaxEntries` | 无 UI | 无 UI（沿用默认） | — | — |
| `worlds.activity.vision.staticSampleMs` / `semantic.timeoutMs` | 无 UI（运行时固定/默认） | 无 UI（静止画面固定 120 秒；识图超时默认 20 秒） | — | — |
| 原始采样 / 类别统计 | 她看到了什么 / 类别统计 | 同上 | 记录 | 只读＋清除 |
| 清空本地数据 | 清空本地数据 | 清空本地数据 | 即时 | 即时（二次确认） |

## 10. 自主与授权（电脑能力顶部共用组）

| 配置路径 | 原入口 | 新入口 | 常用/高级 | 保存方式 |
| --- | --- | --- | --- | --- |
| `exploration.enabled` / `grantedAt` / `scope` / `sessionExpiresAt` | 权限与授权 → 自由探索 | 电脑能力 → 自主与授权 | 常用 | 表单；撤销为即时 |
| `autonomy.enabled` | 陪伴与外观 → 自主行为；活动与任务 | 自主与授权 | 常用 | 表单 |
| `autonomy.mode` | 活动与任务 → 自主模式 | 自主与授权 | 常用 | 表单 |
| `autonomy.takeoverCooldownMs` | 同上 | 自主与授权 | 常用 | 表单 |
| `autonomy.approvalMode` | 电脑能力 → 展开审批策略 | 自主与授权 | 常用 | 表单 |
| `autonomy.task.maxMinutes` / `maxToolCalls` / `retentionDays` / `autoResume` | 活动与任务 → 任务预算 | 自主与授权 → 任务预算与配额 | 高级 | 表单 |
| `autonomy.sessionGrantMinutes` / `maxAutoOpsPerHour` / `autoWriteBackupCount` | 展开审批策略 → 自动执行配额 | 自主与授权 → 任务预算与配额 | 高级 | 表单 |
| `approval.ttlMs` / `sessionAllowExactCommand` | 展开审批策略 → 审批细节 | 自主与授权 → 任务预算与配额 | 高级 | 表单 |
| 立即撤销授权 | 权限与授权 | 自主与授权 | 即时 | 即时 |

## 11. 高级与诊断

| 配置路径 | 原入口 | 新入口 | 常用/高级 | 保存方式 |
| --- | --- | --- | --- | --- |
| `worlds.terminal.enabled` / `shell` | 展开审批策略 → 终端白名单 | 高级与诊断 → 终端与启动 → 终端 | 高级 | 表单 |
| `autonomy.terminalAllowlist` | 同上 | 同上 | 高级 | 表单 |
| 开机自动启动 | 展开审批策略 → 暂停与启动 | 终端与启动 | 即时 | 即时 |
| 暂停对话总线 | 同上 | 终端与启动 | 即时 | 即时 |
| 桌宠归位 / 刷新 / 参数 / 重置 | 展开审批策略 → 桌宠页面维护 | 终端与启动 → 桌宠页面维护 | 即时 | 即时 |
| Worlds 健康 | 高级与诊断 → Worlds | 高级与诊断 → Worlds 健康 | 只读 | — |
| 运行诊断 / 导出 / 撤销列表 | 高级与诊断 → 诊断 | 运行诊断（默认展开） | 只读＋即时 | 即时（导出） |
| 屏幕诊断（场景/事件） | 记忆与隐私 → 屏幕感知 | 屏幕诊断 | 只读＋即时 | 即时（清除） |
| 版本 / 许可 / 隐私承诺 | 关于 | 关于与许可 | 只读 | — |

## 12. 活动与任务（只保留记录与即时操作）

| 内容 | 原入口 | 新入口 | 保存方式 |
| --- | --- | --- | --- |
| 任务列表、暂停/恢复/取消 | 活动与任务；概览 | 活动与任务 → 进行中的任务 / 最近结束的任务 | 即时 |
| 任务授权、撤销 | 活动与任务 → 任务授权 | 活动与任务 → 任务授权 | 即时 |
| 审批授权（本会话/始终允许） | 展开审批策略 → 当前授权 | 活动与任务 → 审批授权 | 即时 |
| 文件撤销记录与撤销 | 展开审批策略 → 文件操作撤销 | 活动与任务 → 文件撤销 | 即时 |
| 系统操作记录 | 应用与系统 → 她最近做了什么 | 活动与任务 → 系统操作 | 即时 |
| 发现列表 | 浏览网页 → 发现列表 | 活动与任务 → 发现 | 即时 |
| 兴趣与经历 | 活动与任务 | 活动与任务 → 兴趣与经历 | 即时 |
| 自主状态（能力/调度/上一轮） | 活动与任务；概览 | 活动与任务 → 自主状态 | 只读 |

## 13. 无设置页入口的内部字段

这些字段仍由默认值、迁移和运行时代码维护；整理没有为它们新增编辑入口，也没有删除。

| 配置路径 | 说明 |
| --- | --- |
| `schemaVersion` | 迁移版本，保存时由主进程维护 |
| `provider.id` | 固定 `deepseek` |
| `worlds.web.provider` | 固定 `deepseek` |
| `autonomy.alarmMinDelayMs` / `maxActiveAlarms` | 提醒的调度上限 |
| `persona.roleplay` / `styleNotes` | 内置人格层 |
| `companion.interests` / `experiences` / `unanswered` / `reaction` | 兴趣、经历、未回应退避与事件反馈的默认参数 |
| `worlds.pet.reactions` / `physics` | 表现层默认参数 |
| `worlds.activity.appSwitchCoalesceMs` / `appSwitchMaxHoldMs` / `timelineMinutes` / `timelineMaxEntries` | 事件合并与时间线容量 |

## 14. 旧路由与搜索

| 旧入口 | 新落点 |
| --- | --- |
| `#computer/files`、`#files` | 电脑能力 → 文件 |
| `#computer/bilibili`、`#bilibili` | 电脑能力 → B 站 |
| `#computer/apps`、`#system` | 电脑能力 → 应用 |
| `#computer/screen`、`#cua`、`#privacy/perception` | 电脑能力 → 屏幕 |
| `#computer/exploration`、`#security` | 电脑能力 → 自主与授权（自动展开） |
| `#computer/artifacts` | 电脑能力 → 作品空间 |
| `#computer/web`、`#browser` | 电脑能力 → 网页 |
| `#privacy`、`#privacy/privacy` | 记忆与隐私 → 行为感知 |
| `#autonomy`、`#start` | 活动与任务 / 概览 |
| `#worlds`、`#diagnostics`、`#about` | 高级与诊断对应折叠区 |

锚点定位会先切换到对应子页并展开所有必需祖先折叠，再滚动并聚焦目标，不再只滚动隐藏 DOM。
