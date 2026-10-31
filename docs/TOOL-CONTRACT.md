# 工具契约目录

> 由 `npm run docs:tool-contract` 从 `TOOL_GROUPS` 与 `toolMetaFor` 生成；
> 不要手改文件名、组归属或能力标记。运行边界仍由 ToolExecutor 判定。

## 表现与陪伴（`companion`）

说话、表情动作、安静/暂停探索、打开聊天、结束当前回复

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `end_turn` | — | 否 | 否 |
| `pet_act` | — | 否 | 否 |
| `pet_open_chat` | — | 否 | 否 |
| `pet_pause_explore` | — | 是 | 否 |
| `pet_quiet` | — | 否 | 否 |
| `pet_say` | — | 否 | 否 |
| `pet_walk_to` | — | 否 | 否 |
| `reaction_respond` | — | 是 | 否 |

## 活动感知（`activity`）

查看前台应用、场景、活动摘要与时间线（不含截图）

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `act_current` | — | 否 | 是 |
| `act_scene` | — | 否 | 是 |
| `act_summary` | — | 否 | 是 |
| `act_timeline` | — | 否 | 是 |

## 记忆与兴趣（`memory`）

记忆检索/写入、兴趣管理、对陪伴方式的反馈

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `companion_feedback` | — | 是 | 否 |
| `interest_create` | — | 是 | 否 |
| `interest_list` | — | 是 | 否 |
| `interest_update` | — | 是 | 否 |
| `mem_forget` | `memory.write` | 是 | 否 |
| `mem_read` | — | 否 | 是 |
| `mem_search` | — | 否 | 是 |
| `mem_write` | `memory.write` | 是 | 否 |

## 用户提醒（`reminders`）

设置、查看、取消用户要求的提醒

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `remind_cancel` | — | 是 | 否 |
| `remind_list` | — | 是 | 否 |
| `remind_set` | — | 是 | 否 |

## 桌宠自唤醒（`alarms`）

设置、查看、取消桌宠自己安排的唤醒

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `alarm_cancel` | — | 是 | 否 |
| `alarm_list` | — | 是 | 否 |
| `alarm_set` | — | 是 | 否 |

## 任务管理（`tasks`）

持久任务的创建、检查点、完成/取消/放弃与休息

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `autonomy_rest` | — | 是 | 否 |
| `task_abandon` | — | 是 | 否 |
| `task_cancel` | — | 是 | 否 |
| `task_checkpoint` | — | 是 | 否 |
| `task_complete` | — | 是 | 否 |
| `task_create` | — | 是 | 否 |
| `task_list` | — | 否 | 是 |
| `task_status` | — | 否 | 是 |

## 文件探索（`files`）

只读查看可用范围、目录树、搜索与文件正文

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `files_info` | `file.read` | 否 | 是 |
| `files_list` | `file.read` | 否 | 是 |
| `files_read` | `file.read` | 否 | 是 |
| `files_roots` | `file.read` | 否 | 是 |
| `files_search` | `file.read` | 否 | 是 |
| `files_tree` | `file.read` | 否 | 是 |

## 作品写入（`artifacts`）

在作品目录内写入、编辑、移动、删除文件（含所需读取入口）

依赖组：`files`

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `files_artifact_delete` | `workspace.delete` | 是 | 否 |
| `files_artifact_edit` | `file.write` | 是 | 否 |
| `files_artifact_list` | `file.read` | 否 | 是 |
| `files_artifact_mkdir` | `file.write` | 是 | 否 |
| `files_artifact_move` | `file.write` | 是 | 否 |
| `files_artifact_read` | `file.read` | 否 | 是 |
| `files_artifact_write` | `file.write` | 是 | 否 |

## 工作区编辑（`workspace`）

工作区完整读写；写入前先读取并保留 hash/mtime 校验

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `ws_delete` | `workspace.delete` | 是 | 否 |
| `ws_list` | — | 否 | 是 |
| `ws_move` | `workspace.write` | 是 | 否 |
| `ws_read` | — | 否 | 是 |
| `ws_replace` | `workspace.write` | 是 | 否 |
| `ws_search` | — | 否 | 是 |
| `ws_write` | `workspace.write` | 是 | 否 |

## 应用与系统（`apps`）

发现/启动/切换应用，打开系统白名单路径与 URL，系统动作

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `apps_focus` | `app.launch` | 是 | 否 |
| `apps_launch` | `app.launch` | 是 | 否 |
| `apps_list` | `app.launch` | 否 | 是 |
| `apps_wait` | `app.launch` | 否 | 是 |
| `sys_action` | — | 是 | 否 |
| `sys_open_app` | `app.launch` | 是 | 否 |
| `sys_open_path` | `app.launch` | 是 | 否 |
| `sys_open_url` | `app.launch` | 是 | 否 |
| `win_focus` | `desktop.input` | 是 | 否 |

## 窗口语义操作（`window`）

观察窗口/元素/文本、跨窗口查找、按 elementId 或语义控件操作、单窗口截图

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `computer_act` | `desktop.input` | 是 | 否 |
| `computer_find` | `desktop.observe` | 否 | 是 |
| `computer_observe` | `desktop.observe` | 否 | 是 |
| `win_capture` | `desktop.observe` | 否 | 是 |
| `win_focus` | `desktop.input` | 是 | 否 |

## 屏幕与键鼠（`screen`）

整屏观察、缩放、点击/滚动/拖动/输入/按键、等待与停止

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `cua_click` | `desktop.input` | 是 | 否 |
| `cua_drag` | `desktop.input` | 是 | 否 |
| `cua_key` | `desktop.input` | 是 | 否 |
| `cua_scroll` | `desktop.input` | 是 | 否 |
| `cua_stop` | — | 是 | 否 |
| `cua_type` | `desktop.input` | 是 | 否 |
| `cua_wait` | — | 是 | 否 |
| `cua_zoom` | `desktop.observe` | 否 | 是 |
| `screen_observe` | `desktop.observe` | 否 | 是 |

## 公开网页（`web`）

搜索与抓取公开网页，不依赖浏览器扩展

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `web_fetch` | `web.read` | 否 | 是 |
| `web_search` | `web.read` | 否 | 是 |

## 当前页面（`page`）

只读用户当前浏览器标签页的脱敏标题与摘要

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `page_current` | `web.read` | 否 | 是 |

## 浏览器操作（`browser`）

扩展连接的标签页状态、结构观察、点击/输入/导航/下载

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `browser_back` | `browser.control` | 是 | 否 |
| `browser_click` | `browser.control` | 是 | 否 |
| `browser_download` | `browser.control` | 是 | 否 |
| `browser_find` | `browser.control` | 否 | 是 |
| `browser_forward` | `browser.control` | 是 | 否 |
| `browser_key` | `browser.control` | 是 | 否 |
| `browser_navigate` | `browser.control` | 是 | 否 |
| `browser_open` | `browser.control` | 是 | 否 |
| `browser_restore_tabs` | `browser.control` | 是 | 否 |
| `browser_scroll` | `browser.control` | 是 | 否 |
| `browser_select` | `browser.control` | 是 | 否 |
| `browser_snapshot` | `browser.control` | 否 | 是 |
| `browser_status` | `browser.control` | 否 | 是 |
| `browser_tab_close` | `browser.control` | 是 | 否 |
| `browser_tab_switch` | `browser.control` | 是 | 否 |
| `browser_tabs` | `browser.control` | 否 | 是 |
| `browser_type` | `browser.control` | 是 | 否 |
| `browser_wait` | `browser.control` | 否 | 是 |

## 自主网页阅读（`autoweb`）

受限主动浏览会话与媒体控制；带观察、等待与发现证据入口

依赖组：`discovery`

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `browser_find` | `browser.control` | 否 | 是 |
| `browser_snapshot` | `browser.control` | 否 | 是 |
| `browser_status` | `browser.control` | 否 | 是 |
| `browser_tabs` | `browser.control` | 否 | 是 |
| `browser_wait` | `browser.control` | 否 | 是 |
| `web_media` | `browser.control` | 否 | 是 |
| `web_navigate` | `browser.control` | 是 | 否 |
| `web_open` | `browser.control` | 是 | 否 |

## B 站阅读（`bilibili`）

推荐/搜索/详情/字幕/封面/抽帧/转写与状态（不含播放器控制）

依赖组：`discovery`

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `bili_assess` | `bilibili.read` | 是 | 否 |
| `bili_cover` | `bilibili.read` | 否 | 是 |
| `bili_detail` | `bilibili.read` | 否 | 是 |
| `bili_frames` | `bilibili.read` | 否 | 是 |
| `bili_listing` | `bilibili.read` | 否 | 是 |
| `bili_open` | `bilibili.read` | 否 | 是 |
| `bili_search` | `bilibili.read` | 否 | 是 |
| `bili_status` | — | 否 | 否 |
| `bili_stop` | — | 否 | 否 |
| `bili_subtitle` | `bilibili.read` | 否 | 是 |
| `bili_transcribe` | `bilibili.read` | 是 | 否 |
| `bili_transcribe_status` | `bilibili.read` | 否 | 是 |

## 发现管理（`discovery`）

保存经浏览校验的发现、查看/分享与偏好反馈

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `discovery_feedback` | — | 是 | 否 |
| `discovery_list` | — | 是 | 否 |
| `discovery_save` | — | 是 | 否 |
| `discovery_show` | — | 是 | 否 |

## 终端（`terminal`）

在允许范围内运行白名单终端命令

| 工具 | 能力 | 副作用 | 可验证 |
| --- | --- | --- | --- |
| `term_run` | `terminal.run` | 是 | 否 |

## 隐藏旧入口

| 旧入口 | 规范替代 |
| --- | --- |
| `apps_find` | `apps_list` |
| `bili_media` | 无（仅保留历史回执） |
| `browser_read` | `browser_snapshot` |
| `cua_screenshot` | `screen_observe` |
| `pet_emote` | `pet_act` |
| `win_act` | `computer_act` |
| `win_elements` | `computer_observe` |
| `win_list` | `computer_observe` |
| `win_read` | `computer_observe` |

目录工具：`tool_groups`、`tools_load`
