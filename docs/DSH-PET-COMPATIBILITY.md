# dsh-pet 动作兼容表与迁移语义

本文记录本应用从旧 Coopanion figure 表现层切换到 dsh-pet 运行时后的**真实动作能力**、
旧接口的近似映射、无法兑现的语义，以及配置/位置迁移口径。文中“近似”不是等价：
透明 WebM 素材是一整段身体动画，没有可独立叠加的表情、眨眼、口型或换装层。

## 1. 锁定的上游版本

| 项 | 值 |
| --- | --- |
| 仓库 | <https://github.com/PC2005-cloud/dsh-pet> |
| commit | `2fa04a5133988a1ca901558e9a18f55845128b41` |
| 版本 | `0.3.8` |
| 默认角色 | 蓝毛小女仆（`packId = main`） |
| 素材 | 106 个 VP9 + Alpha WebM，640×360，参考画布宽 462px |
| 代码许可 | MIT（`vendor/dsh-pet/LICENSE`） |
| 素材许可 | 允许开源使用，**禁止商用**；不是 MIT（`vendor/dsh-pet/NOTICE-assets.md`） |

记录文件：`vendor/dsh-pet/UPSTREAM.json`；逐文件哈希：`vendor/dsh-pet/assets/SHA256SUMS`。
本应用只移植运行时代码，不打包/启动上游独立应用、提示词、源视频或截图。

## 2. 真实动画目录与选择规则

目录由 `vendor/dsh-pet/assets/config.jsonc` 生成到
`src/shared/dshPet/catalog.generated.ts`，页面只接受目录内的动画 id。

| 池 | 数量 | 播放语义 |
| --- | ---: | --- |
| 待机 `idle` | 1 | 默认静息基线；没有真实事件或明确动作时持续循环 |
| 转向 `turn` | 1 | 仅在明确需要朝向时 `once`，结束后切换左右朝向并回到待机 |
| 拖拽 `drag` | 1 | 拖拽期间播放；松手后由轻放/甩抛接管 |
| 点击回应 `clicks` | 5 | 单击真正出画，`once` 后回到工作状态或静息待机 |
| 移动 `moves` | 3 | 仅在 `pet_walk_to` 或菜单“移动”项中使用；按上游 `minDist/maxDist/leadSec/tailSec` 计时并驱动真实位移 |
| 分类动作 `categories` | 80 | 小动作 18、玩耍 27、吃什么 12、时节 21、文字 2；只由模型显式选择或右键菜单点播，不自动按权重抽取 |
| 事件 `balance` | 6 | 由余额档位触发；不属于本轮主要交互 |
| 事件 `whisper` | 3 | 由碎碎念触发 |
| 事件 `workStatus` | 6 | 0 思考 / 1 执行 / 2 结果 / 3 等待 / 4 成功 / 5 失败 |

播放规则：

- 普通待机是持续循环的静息基线；转向、分类动作与菜单点播为 `once`，播完回到工作状态或待机。
  不存在 `ended` 后按权重抽取下一段的自动随机链，也没有独立的随机转向/漫游定时器。
- 工作状态的单候选档位循环播放；多候选档位播完自动轮换。成功/失败是终态，只播一次，
  随后回到待机，等待主进程把状态改回 `idle`。
- 工作状态更新只改写**期望状态**，不立即重启动画。当前一次性动作或循环片段先播放到自然
  边界，再直接呈现最新有效状态；途中依次到达的 thinking/tool/idle 不会按顺序补播。等待态
  只播放一次「工作状态-原地踱步张望」，相同等待事件不重播，等待文字与审批状态保持。
- 普通新动作不切断当前片段；至多保留一条最新待播，30 秒未轮到即过期并回执，被替代的待播
  也有明确结果。拖拽/抛掷、停止、系统挂起和显示器变化仍立即中断播放。
- “文字”分类声明 `noMirror`；角色朝右时先强制朝左再播放，避免文字镜像。
- 模型主动选择的装饰动作仍要经过空闲门槛、通用冷却与同动作冷却；冷却到期只代表“可以选”，
  不会自动播放。`东张西望` 与 `工作状态-原地踱步张望` 共用张望品类冷却，实际间隔取
  `lookAroundIntervalMs`（默认 15 分钟）与 `sameActionIntervalMs`（默认 30 分钟）中更严格者；
  旧 look/turn/curious 等入口同样归一，不能换入口绕过。`reducedMotion` 关闭自主装饰动作与
  自主移动、以及点击/落地的 Q 弹缩放，但不关闭点击回应、拖拽、工作状态、用户/模型显式点播
  和右键菜单中的移动项。

## 3. 旧词表 → 真实动画

旧 `expression` / `motion` 只在迁移期解析；解析结果全部标记为**近似**。
两个都提供时优先 `motion`，`expression` 记为 ignored。未知词不会被静默改播待机，
而是返回 `[PET_ANIMATION_UNSUPPORTED]`。

### 3.1 expression

| 旧词 | 动画 |
| --- | --- |
| `neutral` | 待机呼吸休闲 |
| `happy` / `excited` | 点击回应-开心跃动 |
| `wink` / `love` / `shy` / `flustered` | 点击回应-害羞惊讶 |
| `surprised` / `scared` | 被吓一跳 |
| `angry` / `smug` / `pout` | 点击回应-傲娇生气 |
| `sad` / `cry` | 工作状态-垂头叹气冒汗 |
| `sleepy` | 哈欠连天 |
| `thinking` / `confused` | 工作状态-思考冒泡 |
| `worried` | 工作状态-原地踱步张望 |
| `determined` | 轻快记录 |

### 3.2 motion

| 旧词 | 动画 |
| --- | --- |
| `stand` | 待机呼吸休闲 |
| `jump` / `hop` | 点击回应-开心跃动 |
| `look` / `turn` | 东张西望 |
| `nod` / `bow` | 女仆屈膝礼仪 |
| `shake` / `shiver` | 被吓一跳 |
| `spin` | 小幅度原地360度旋转展示 |
| `sit` / `sleep` | 原地小憩沉眠 |
| `dizzy` | 工作状态-垂头叹气冒汗 |
| `walk` | 螃蟹走路 |
| `run` | 原地左转奔跑 |
| `wave` / `flap` | 点击回应-元气挥手 |
| `dance` | 可爱宅舞 |

`walk` / `run`（以及 `原地漂浮踏步`）只在**显式 `pet_walk_to` 或右键菜单的“移动”项**中驱动真实水平位移。
自主轮调用 `pet_walk_to` 需先满足移动自己的静止门槛（默认连续静止 30 秒）与自主移动最小间隔
（默认 120 秒）；这两个条件独立于“自主小动作”的空闲门槛、通用冷却和同动作冷却，关闭自主小动作
不会关闭移动。移动失败使用单独退避，普通思考/工具状态不会中断已开始的移动。用户在聊天中的明确
点播不受自主长冷却限制，但仍不能绕过关闭走动、停靠、拖拽、挂起或非法位置。经 `pet_act`、`pet_emote`
或 `pet_say.animation` 点播移动素材会被拒绝（`[PET_MOVEMENT_REQUIRED]`），不会额外移动身体。

### 3.3 业务预设

| preset | 动画 | 说明 |
| --- | --- | --- |
| `focus` | 轻快记录 | 近似“专注” |
| `rest` | 原地小憩沉眠 | 近似“休息” |
| `late` | 哈欠连天 | 近似“困了/迟到” |
| `welcome-back` | 点击回应-元气挥手 | 近似欢迎 |
| `curious` | 东张西望 | 近似好奇 |
| `quiet` | 待机呼吸休闲 | 安静时只保留待机 |

## 4. 工具接口兼容

| 接口 | 当前行为 |
| --- | --- |
| `pet_say` | 气泡文字总是照常显示；可选 `animation` 精确点播目录动作。`expression`/`motion` 走第 3 节近似映射。动作失败不会吞掉文字。 |
| `pet_emote` | `preset` 映射为近似动作并明确标注；也可用 `animation` 指定目录动作。没有独立“换表情”能力。 |
| `pet_act` | 只播放动作，不显示气泡。`animation` 必须是目录内真实动作；旧词近似映射；无等价素材返回 unsupported。旧参数 `duration_ms` 仍被接受以保持 schema 兼容，但不会裁剪或延长素材，实际时长由完整动作决定。 |
| `reaction_respond` | 决策与台词逻辑不变；只有本地反应词能解析到素材时才点播。没有等价素材时不播，也不伪造成功。 |
| `pet_walk_to` | 在当前显示器工作区内横向移动，并保持当前合法支撑高度（不会再回到屏幕底边）；`position` 支持 `left`/`center`/`right` 或 `0..1`。可选 `animation` 仅限移动分类（`螃蟹走路`/`原地漂浮踏步`/`原地左转奔跑`），默认 `螃蟹走路`。自主移动先过独立静止门槛（默认 30 秒）与自主最小间隔（默认 120 秒），失败退避与装饰动作分开；普通 thinking/tool 状态不打断已开始的移动，拖拽、抛掷、面板、挂起、关闭走动和显示器变化会打断。`{{movementState}}` 向模型提供位置比例、朝向、移动开关、停靠上沿与拖拽/菜单/面板/挂起占用，以及最近移动结果和冷却。 |
| 工作状态 | 由真实 Agent 相位推导：`thinking→0`、工具执行 `tool→1`、`result→2`、`waiting/asking/queued/helper→3`、`done→4`、`failed→5`。`idle` 返回 `null`，不会抢占忙碌动画。每次更新只改期望状态，当前片段播完后再切换；等待事件只播放一次踱步，终态成功/失败只播一次。 |

动画点播回执为 `accepted / started / completed / rejected / interrupted / unsupported / failed`；
移动回执为 `accepted / started / completed / already_at_target / blocked / interrupted / failed`。
只有页面播放器真实 `play()` 兑现后才回 `started`；`accepted` 只表示受理，主进程不会把
“IPC 已发送”当成已播放或已出发。工具回复只描述已确认的阶段。

## 5. 右键动作菜单

右键菜单保留上游“动作 → 分类 → 动画名”的级联结构，并加入本应用真实入口：

- 对话、快捷输入（设置关闭时不显示）、回到初始位置、设置、重新载入桌宠
- 动作：待机 / 转向 / 拖拽 / 点击回应 / 移动 / 目录分类 / 事件档位（余额、碎碎念、工作状态）
- 叶子点播 `once`，播放结束回到工作状态或静息待机；没有自动随机动画链

未移植：上游浏览器/DSH 宿主专属的“显示位置”“更多/第三方插件”菜单。
这些入口在本应用没有对应运行时，因此不展示空壳菜单。

## 6. 已移除的旧语义

| 旧能力 | 现在 |
| --- | --- |
| 独立表情/眨眼/口型/换装叠加 | 不存在。所有反应都是整段身体动画 |
| `figure.packId/scheme/outfit` | 退出运行配置；只保留 `appearance.packId = main` |
| 旧 figure iframe、`/figure-frame`、FigureHost | 已删除；页面只有一套 `<video>` 双缓冲播放循环 |
| 旧 ActionDirector / TravelController / pose/travel 循环 | 已删除；动作调度、位移和物理统一由 `PetController` 管理 |
| 旧 Coopanion 素材与生产依赖 | 已从生产依赖图、构建产物和安装包移除 |
| 旧 `roam` 节奏字段 | 迁移为 `movement.enabled`；旧 `mode/vertical/minDelayMs/maxDelayMs` 删除 |
| 旧 `chatPanel` | 迁移为 `chatUi`/快捷输入；旧内嵌面板不再存在 |

## 7. 配置与位置迁移

- 配置 schema 当前为 18。迁移是**幂等**的：已存在的新字段不覆盖，重复载入结果一致。
- schema 17→18：删除 `animation.randomEnabled`/`weights` 与 `movement.autoWalk`，移除随机动画链与随机漫游；
  新增 `animation.policy = "model-driven"`、`animation.idleActions { enabled, minIdleMs, minIntervalMs,
  sameActionIntervalMs }` 与 `movement.autonomousMinIntervalMs`。用户显式设置的 `movement.enabled=false`
  会保留；迁移不会自动授予任何权限。
- 旧 `figure.scale`（0.5–2.5）映射为 `appearance.size = round(462 × scale)`，保持可见身体高度接近；
  结果与手改配置一样受 160–900px 的归一化上限约束（2.5 倍会落在 900px）。
- `figure`、`roam`、`chatPanel` 及旧漫游节奏字段从持久化配置删除；聊天、记忆、人格、自主节奏、
  授权、审批记录和密钥不因外观迁移改变。
- 位置由主进程保存到 `<data>/data/pet-position.json`（版本 1，稳定显示器 id + 工作区比例），
  不再依赖随端口变化的 localStorage origin。
- 首次载入新运行时仍会读取旧 localStorage 键 `mingyue.figure.position.v1` 和
  `mingyue.roam.position.v1`，换算为屏幕工作区坐标后保存到新文件；旧键不删除，迁移失败则使用安全 home。
- 外观/物理配置：`appearance { engine, packId, size, reducedMotion, home }`、
  `animation { policy, idleActions }`、`physics`、`confineToScreen`、`movement`。
  `idleActions.lookAroundIntervalMs`（默认 15 分钟）与 `sameActionIntervalMs`（默认 30 分钟）
  共同限制张望；`movement.minIdleMs`（默认 30 秒）和 `movement.autonomousMinIntervalMs`
  （默认 120 秒）是移动自己的门槛，与 `idleActions.minIdleMs` 相互独立。
- `reducedMotion` 只关闭自主装饰动作与自主移动，保留点击、拖拽、抛掷和真实工作状态反馈。
- 移动只限当前显示器工作区内的横向目标，不做跨屏寻路；目标与当前支撑高度都受边界归一化约束。

## 8. 素材加载与失败语义

- 页面通过本机回环地址的只读路由 `/dsh-pet/webm/<编码后的动画 id>.webm` 加载素材；
  仅目录白名单内 id 可读，支持 `HEAD`、`Range`（206/416）、`ETag` 和 CSP。
- 双缓冲：两个 `<video>` 交替；下一段 `loadeddata` 且可播放后才切换，切换前保留上一帧，
  避免白屏/黑底。旧缓冲在后台预载，不并发启动第二套动画引擎。
- 加载/解码失败显示可读错误卡（`#dsh-pet-error`），可手动“重试”；不做自动高速重试。
  错误卡与页面 fault 状态不会掩盖气泡、快捷输入或审批等 UI。
- 工作状态素材损坏时同样显示错误并停链，等待用户重试或状态变化。

## 9. 平台事实与限制

- 窗口是覆盖整个工作区的透明窗口，指针命中身体或 `[data-agent-ui]` 时才临时关闭点击穿透。
  OS 级穿透由 Electron `setIgnoreMouseEvents(true)` 完成；穿透期间主进程每 33ms 轮询系统
  光标并通过 `pet:event:pointer-sample` 发送窗口内 CSS 坐标（Windows 上 `forward: true`
  实测不派发指针事件）。页面据采样翻转可交互状态，真实 pointer 事件随后照常到达。
- 多屏使用 Electron `screen.getAllDisplays()` 的工作区，而不是显示器外接大矩形；
  负坐标、任务栏和屏幕空洞按工作区边界处理。混合 DPI 的真实桌面行为仍需人工验收。
- 停靠只使用本应用真实窗口几何助手给出的可见窗口上沿；窗口消失或几何不可用即安全脱离。
  本应用自己的全屏透明覆盖窗口在几何助手里被完全跳过，既不是支撑面也不遮挡下方上沿
  （否则桌宠变为可交互时会盖住整块工作区，把所有候选上沿清空）。
  没有“吸附到任意像素”或“保持任意姿势”的伪造能力。
- 动画素材为非商用授权；商业分发前必须替换素材或另行取得授权。
