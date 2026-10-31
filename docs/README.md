# 文档索引

本目录区分“当前要求”“当前实现”“操作说明”“历史报告”和“验收证据”。日期均为本地时间（UTC+8）；历史报告保留当时的构建与测试数据，不随当前结果改写。

## 当前目标与边界

- [PLAN-REVIEW-CONSOLIDATION-2026-10-30.md](../PLAN-REVIEW-CONSOLIDATION-2026-10-30.md)：本轮整体 review 的定点修复与渐进收敛计划（A 上下文/交接、B 统一内核、C 人格与主动交流、D 工具契约与任务验证、E 装配与文档）；当前交付状态见 [REVIEW-CONSOLIDATION-ACCEPTANCE-2026-10-30.md](reports/REVIEW-CONSOLIDATION-ACCEPTANCE-2026-10-30.md)。
- [PLAN-MODEL-TOOL-SIMPLIFICATION-2026-10-30.md](../PLAN-MODEL-TOOL-SIMPLIFICATION-2026-10-30.md)：模型可见工具分级暴露的目标、旧名隐藏与规范入口映射、请求快照、工具组生命周期、兼容/授权边界和验收矩阵。
- [PLAN-SETTINGS-REORGANIZATION-2026-10-30.md](../PLAN-SETTINGS-REORGANIZATION-2026-10-30.md)：设置页整理的目标、七页信息架构、六个能力子页、分步配置与保存边界、文案规范和验收标准。
- [PLAN-PROJECT-CONSOLIDATION-2026-10-29.md](../PLAN-PROJECT-CONSOLIDATION-2026-10-29.md)：本轮项目合并、能力状态、共享原语与兼容边界的目标、执行步骤和验收表。
- [PLAN-BILIBILI-REFACTOR-DSH-SCROLL.md](../PLAN-BILIBILI-REFACTOR-DSH-SCROLL.md)：B 站独立扫码登录、Python 只读 API、字幕/本地转写/视觉辅助与当天日报的执行范围。
- [PLAN-APP-AUTOLAUNCH-AND-SYSTEM-ACTIONS-2026-10-29.md](../PLAN-APP-AUTOLAUNCH-AND-SYSTEM-ACTIONS-2026-10-29.md)：应用启动校验、窗口等待与系统动作回执的边界和目标。
- [PLAN-SCREEN-COMPANION-FEEDBACK.md](../PLAN-SCREEN-COMPANION-FEEDBACK.md)：屏幕陪伴反馈的静默断点、节奏与台词边界。
- [PLAN-UNIFIED-SCREEN-PERCEPTION.md](../PLAN-UNIFIED-SCREEN-PERCEPTION.md)：统一屏幕感知与 CUA 截图基础设施的目标、授权、调度、性能门槛与验收表。
- [README.md](../README.md)：项目概述、安装、常用命令、数据目录与故障排查。

## 当前架构与操作说明

- [ARCHITECTURE.md](ARCHITECTURE.md)：进程、内核、World、工具执行、能力授权与主进程边界。
- [TOOL-CONTRACT.md](TOOL-CONTRACT.md)：由 `npm run docs:tool-contract` 从 `TOOL_GROUPS`/`toolMetaFor` 生成的静态工具契约目录；组归属与能力标记不要手改。
- [DSH-PET-COMPATIBILITY.md](DSH-PET-COMPATIBILITY.md)：dsh-pet 0.3.8 的固定版本、106 个动画池、旧动作/表情兼容映射、菜单与移除的语义。
- [SETTINGS-GUIDE.md](SETTINGS-GUIDE.md)：七个设置页、六个能力子页、分步配置流程、保存/撤销语义、键盘与搜索入口，以及截图。
- [SETTINGS-FIELD-MIGRATION.md](SETTINGS-FIELD-MIGRATION.md)：设置整理的字段迁移清单（配置路径、原入口、新入口、常用/高级、保存方式），由 `tests/unit/settingsFieldCoverage.test.ts` 持续校验零遗漏。
- [reports/SETTINGS-REORGANIZATION-ACCEPTANCE-2026-10-30.md](reports/SETTINGS-REORGANIZATION-ACCEPTANCE-2026-10-30.md)：设置整理的七页结构、六个能力子页、分步配置与保存边界、字段迁移、自动化/截图/打包结果与未验证项。
- [reports/PROJECT-CONSOLIDATION-ACCEPTANCE-2026-10-30.md](reports/PROJECT-CONSOLIDATION-ACCEPTANCE-2026-10-30.md)：本轮项目整合的 P0–P5 交付、v27 配置迁移、保留能力、类型/单元/E2E/打包/扩展实机结果、最终 portable SHA-256 和未验证项。
- [reports/TOOL-SIMPLIFICATION-ACCEPTANCE-2026-10-30.md](reports/TOOL-SIMPLIFICATION-ACCEPTANCE-2026-10-30.md)：模型可见工具分级暴露的 128 注册名/9 隐藏旧入口/117 规范业务入口、操作身份与授权映射、请求快照、工具组生命周期、schema 字节基线、自动化与打包结果、真实模型未验证项。
- [reports/REVIEW-CONSOLIDATION-ACCEPTANCE-2026-10-30.md](reports/REVIEW-CONSOLIDATION-ACCEPTANCE-2026-10-30.md)：本轮 review 收敛的 A–E 交付、工作状态、统一循环/上下文/会话路由、主动候选闸门、工具契约、阶段 E 第一批物理拆分、全量测试/打包证据，以及真实模型与桌面/E2E 未验证边界。
- [reports/BILIBILI-REFACTOR-ACCEPTANCE-2026-10-29.md](reports/BILIBILI-REFACTOR-ACCEPTANCE-2026-10-29.md)：B 站独立阅读重构的 P0–P5 交付、参考 SHA/依赖锁/默认限制、自动测试与打包结果、真实未验证项和已知限制。
- [reports/UNIFIED-SCREEN-PERCEPTION-ACCEPTANCE-2026-10-29.md](reports/UNIFIED-SCREEN-PERCEPTION-ACCEPTANCE-2026-10-29.md)：统一屏幕感知的交付、§9 验收映射、真实截图性能实测（未达主进程停顿门槛、30 秒档关闭）、迁移说明与打包结果。
- [reports/SCREEN-COMPANION-FEEDBACK-ACCEPTANCE-2026-10-29.md](reports/SCREEN-COMPANION-FEEDBACK-ACCEPTANCE-2026-10-29.md)：屏幕陪伴反馈的静默断点、实现范围、验收矩阵映射、自动化/回执证据、节奏与未验证项。
- [reports/DSH-PET-REPLACEMENT-ACCEPTANCE-2026-10-23.md](reports/DSH-PET-REPLACEMENT-ACCEPTANCE-2026-10-23.md)：dsh-pet 表现层替换的 R01–R12 验收、删除清单、真实桌面/打包证据、安装包哈希与已知限制。
- [reports/CURRENT-VERIFICATION-2026-10-20.md](reports/CURRENT-VERIFICATION-2026-10-20.md)：本轮类型检查、单元/集成、构建、E2E 和真实/模拟边界的当前证据。
- [reports/CONTINUOUS-PERCEPTION-ACCEPTANCE-2026-10-22.md](reports/CONTINUOUS-PERCEPTION-ACCEPTANCE-2026-10-22.md)：连续场景理解与自主活动的实现、自动化结果、真实桌面采集数据及尚未完成的验收项。
- [reports/CLEANUP-MANIFEST.md](reports/CLEANUP-MANIFEST.md)：删除、合并、保留项及原因和验证方式。
- [reports/UNIFIED-PROACTIVE-BROWSING-AND-BILI-OPEN-FIX-2026-10-28.md](reports/UNIFIED-PROACTIVE-BROWSING-AND-BILI-OPEN-FIX-2026-10-28.md)：统一主动浏览/发现与 B 站首页打开失败的已证实缺陷、历史推断、真实扩展验收和未验证边界。

## 历史报告与验收

以下文档描述当时的实现与测试，不应被当作当前构建的通过证明：

- [reports/P1-P4-REPORT.md](reports/P1-P4-REPORT.md)
- [reports/P5-REAL-USE-REPORT.md](reports/P5-REAL-USE-REPORT.md)
- [acceptance/P1-P4-ACCEPTANCE.md](acceptance/P1-P4-ACCEPTANCE.md)
- [acceptance/P5-ACCEPTANCE.md](acceptance/P5-ACCEPTANCE.md)
- [HARNESS-REPORT.md](../HARNESS-REPORT.md)：保留历史 harness 结论；顶部已增加当前状态说明。

## 归档参考

- [archive/PLAN.before-autonomy-2026-10-19.md](archive/PLAN.before-autonomy-2026-10-19.md)：自治改版前的历史计划。
- [archive/reference/README.md](archive/reference/README.md)：从 `.tmpdocs` 归档的 Coopanion 参考资料，仅作实现溯源，不属于当前构建输入。

## 证据与截图

- [assets/settings/](assets/settings/)：当前七页设置、六个能力子页与分步配置流程截图（880×700 与 720×560 两种窗口）。
- [assets/dsh-pet/](assets/dsh-pet/)：dsh-pet 透明素材、点击/菜单/拖拽/甩抛、工作状态、10 分钟连续运行、真实窗口停靠与最终便携版离线截图；`12-action-switches.mp4` 为动作切换录屏。
- `npm test`、`npm run test:e2e` 的当前结果记录在 [PROJECT-CONSOLIDATION-ACCEPTANCE-2026-10-30.md](reports/PROJECT-CONSOLIDATION-ACCEPTANCE-2026-10-30.md) 的 §5；本轮工具分级暴露的类型/单元/集成/打包结果见 [TOOL-SIMPLIFICATION-ACCEPTANCE-2026-10-30.md](reports/TOOL-SIMPLIFICATION-ACCEPTANCE-2026-10-30.md) 的 §7；本轮 review 收敛的结果见 [REVIEW-CONSOLIDATION-ACCEPTANCE-2026-10-30.md](reports/REVIEW-CONSOLIDATION-ACCEPTANCE-2026-10-30.md) 的 §4–§5；测试运行时生成的临时目录不进入文档。

## 关于失效链接

原根目录 `PLAN-HARNESS-COMPUTER-CONTROL.md` 与 `PLAN-PROJECT-CLEANUP-AND-SETTINGS.md` 已不在仓库中，本索引不再保留指向它们的链接，也不伪造历史文件；其中仍适用的电脑控制边界并入 [ARCHITECTURE.md](ARCHITECTURE.md) 与当前计划。已移除的清理计划 §2.1 曾链接 `test-results/review-*.log/json/mjs`；这些文件同样未随仓库保留，当前目录只有 Playwright 的 `.last-run.json`。本轮可复现命令与结果见 [CURRENT-VERIFICATION-2026-10-20.md](reports/CURRENT-VERIFICATION-2026-10-20.md)。
