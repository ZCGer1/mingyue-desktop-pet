import { CONFIG_SCHEMA_VERSION, DSH_PET_DEFAULT_SIZE, SCREEN_SHARE_CONSENT_VERSION, isVolumeAccessMode } from './types'
import { DEFAULT_CONFIG } from './defaults'
import { isRecord } from './utils'
import { PET_CATALOG } from '../petPresentation'


/**
 * 旧配置迁移：补字段、做等价映射，并移除已确认没有运行时消费者的开关。
 * 不删除用户目录/记忆等数据，也不授予任何新权限。在 mergeConfig 之前运行，
 * 因此可以区分“字段缺失”和“字段等于默认值”。
 */
export function migrateConfig(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  let out: Record<string, unknown>
  try {
    out = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
  } catch {
    return raw
  }

  const fromVersion =
    typeof out.schemaVersion === 'number' && Number.isFinite(out.schemaVersion) ? out.schemaVersion : 0
  out.schemaVersion = CONFIG_SCHEMA_VERSION
  // v27 删除旧站点表前，需要知道用户文件里是否真的有站点上限。v22 迁移会
  // 为所有旧配置补出 site.maxTabs=2，不能用迁移产物反推用户原本的限制。
  const inputControlRecord =
    isRecord(out.worlds) && isRecord(out.worlds.browserControl) ? out.worlds.browserControl : null
  const inputSitesRecord =
    inputControlRecord !== null && isRecord(inputControlRecord.sites) ? inputControlRecord.sites : null
  const inputSiteMaxTabs =
    inputSitesRecord !== null &&
    isRecord(inputSitesRecord.bilibili) &&
    typeof inputSitesRecord.bilibili.maxTabs === 'number' &&
    Number.isFinite(inputSitesRecord.bilibili.maxTabs)
      ? Math.max(1, Math.round(inputSitesRecord.bilibili.maxTabs))
      : null

  const worlds = isRecord(out.worlds) ? out.worlds : null
  const pet = worlds !== null && isRecord(worlds.pet) ? worlds.pet : null
  if (pet !== null) {
    // 旧字段 roam -> movement.enabled；新字段存在时以新字段为准。
    if (!isRecord(pet.movement) && typeof pet.roam === 'boolean') {
      pet.movement = { enabled: pet.roam }
    }
    // v4 起桌宠只沿当前屏幕底边水平移动。老配置里的全屏/纵向设置一次性关掉；
    // normalize 还会再强制一次，防止手改新配置重新开启。
    if (fromVersion < 4 && isRecord(pet.movement)) {
      pet.movement.mode = 'bottom'
      pet.movement.vertical = false
    }
  }

  // 旧 persona.heartbeatMinutes 映射为自主 tick 的起始间隔。
  const persona = isRecord(out.persona) ? out.persona : null
  const autonomy = isRecord(out.autonomy) ? out.autonomy : (out.autonomy = {})
  if (typeof autonomy.tickMinMs !== 'number' && persona !== null) {
    const legacy = persona.heartbeatMinutes
    if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0) {
      autonomy.tickMinMs = Math.round(Math.min(60, Math.max(1, legacy)) * 60_000)
    }
  }
  // v6：只做等价映射。原本开启自主行为的用户进入 assist；关闭的保持 assigned。
  // 迁移不写 consentAt、不铸造授权、不改变任何审批记录。
  if (fromVersion < 6 && typeof autonomy.mode !== 'string') {
    autonomy.mode = autonomy.enabled === true ? 'assist' : 'assigned'
  }

  // 旧内嵌聊天面板 -> 快捷输入配置；尺寸/embedded 不再使用。
  const chatUi = isRecord(out.chatUi) ? out.chatUi : (out.chatUi = {})
  const panel = pet !== null && isRecord(pet.chatPanel) ? pet.chatPanel : null
  if (panel !== null) {
    if (chatUi.petClickAction === undefined && typeof panel.openOnPetClick === 'boolean') {
      chatUi.petClickAction = panel.openOnPetClick ? 'quick-input' : 'none'
    }
    const quick = isRecord(chatUi.quickInput) ? chatUi.quickInput : (chatUi.quickInput = {})
    if (quick.enabled === undefined && typeof panel.openOnPetClick === 'boolean') {
      quick.enabled = panel.openOnPetClick
    }
    if (quick.closeOnEscape === undefined && typeof panel.closeOnEscape === 'boolean') {
      quick.closeOnEscape = panel.closeOnEscape
    }
  }

  // v17：Coopanion figure 运行时被 dsh-pet 替换。外观字段一次性迁移：
  //  - figure.scale（0.5–2.5）按 462 × scale 校准为新画布宽度（可见身体高度接近）；
  //  - figure.packId/scheme/outfit、roam、chatPanel 与旧漫游节奏退出运行配置；
  //  - movement.enabled 保留用户选择（显式关闭不会被重置）；
  //  - 已存在的新字段保持不变，因此重复迁移不会覆盖用户后来保存的设置。
  if (pet !== null) {
    const legacyFigure = isRecord(pet.figure) ? pet.figure : null
    const appearance = isRecord(pet.appearance) ? pet.appearance : (pet.appearance = {})
    const home = isRecord(appearance.home) ? appearance.home : (appearance.home = {})
    if (appearance.engine !== 'dsh-pet') appearance.engine = 'dsh-pet'
    if (appearance.packId !== 'main') appearance.packId = 'main'
    if (typeof appearance.size !== 'number' || !Number.isFinite(appearance.size)) {
      const scale = legacyFigure !== null ? legacyFigure.scale : undefined
      appearance.size =
        typeof scale === 'number' && Number.isFinite(scale) && scale > 0
          ? Math.round(DSH_PET_DEFAULT_SIZE * Math.min(2.5, Math.max(0.5, scale)))
          : DSH_PET_DEFAULT_SIZE
    }
    if (typeof appearance.reducedMotion !== 'boolean') appearance.reducedMotion = false
    if (typeof home.corner !== 'string') home.corner = 'top-right'
    if (typeof home.marginX !== 'number') home.marginX = 24
    if (typeof home.marginY !== 'number') home.marginY = 100

    const animation = isRecord(pet.animation) ? pet.animation : (pet.animation = {})
    if (!isRecord(animation.idleActions)) animation.idleActions = {}

    if (!isRecord(pet.physics)) pet.physics = { ...PET_CATALOG.physics }
    if (typeof pet.confineToScreen !== 'boolean') pet.confineToScreen = false

    const movement = isRecord(pet.movement) ? pet.movement : (pet.movement = {})
    if (typeof movement.enabled !== 'boolean') {
      movement.enabled = typeof pet.roam === 'boolean' ? pet.roam : true
    }
    if (typeof movement.pauseWithPanel !== 'boolean') movement.pauseWithPanel = true

    delete pet.figure
    delete pet.roam
    delete pet.chatPanel
    delete movement.mode
    delete movement.vertical
    delete movement.minDelayMs
    delete movement.maxDelayMs
  }

  // v18：旧的权重随机链退出运行配置；v20 又用独立的本地随机通道替换它。
  // randomEnabled / weights / autoWalk 即使为 true 也失效；
  // movement.enabled 的显式选择（尤其 false）保留。
  // 这里只写新默认值，已存在的 idleActions/间隔字段不被覆盖。
  if (pet !== null) {
    const animation = isRecord(pet.animation) ? pet.animation : (pet.animation = {})
    animation.policy = 'hybrid'
    delete animation.randomEnabled
    delete animation.weights
    const idle = isRecord(animation.idleActions)
      ? animation.idleActions
      : (animation.idleActions = {})
    if (typeof idle.enabled !== 'boolean') idle.enabled = true
    if (typeof idle.minIdleMs !== 'number' || !Number.isFinite(idle.minIdleMs)) {
      idle.minIdleMs = 120_000
    }
    if (typeof idle.minIntervalMs !== 'number' || !Number.isFinite(idle.minIntervalMs)) {
      idle.minIntervalMs = 600_000
    }
    if (
      typeof idle.sameActionIntervalMs !== 'number' ||
      !Number.isFinite(idle.sameActionIntervalMs)
    ) {
      idle.sameActionIntervalMs = 1_800_000
    }

    const movement = isRecord(pet.movement) ? pet.movement : (pet.movement = {})
    delete movement.autoWalk
    if (
      typeof movement.autonomousMinIntervalMs !== 'number' ||
      !Number.isFinite(movement.autonomousMinIntervalMs)
    ) {
      movement.autonomousMinIntervalMs = 120_000
    }
  }

  // v20：hybrid 策略。v18 的 model-driven 用户也要获得新的本地随机通道；
  // 旧配置没有这些字段时补默认值，已保存的显式 false（用户关掉）不被覆盖。
  // randomIdle/semantic/randomRoam 与旧的 idleActions.enabled 相互独立：
  // 旧开关只属于 model-decorative 通道，不会顺带关掉新的随机通道。
  if (pet !== null) {
    const animation = isRecord(pet.animation) ? pet.animation : (pet.animation = {})
    const randomIdle = isRecord(animation.randomIdle)
      ? animation.randomIdle
      : (animation.randomIdle = {})
    if (typeof randomIdle.enabled !== 'boolean') randomIdle.enabled = true
    if (typeof randomIdle.minIntervalMs !== 'number' || !Number.isFinite(randomIdle.minIntervalMs)) {
      randomIdle.minIntervalMs = 120_000
    }
    if (typeof randomIdle.maxIntervalMs !== 'number' || !Number.isFinite(randomIdle.maxIntervalMs)) {
      randomIdle.maxIntervalMs = 300_000
    }

    const semantic = isRecord(animation.semantic) ? animation.semantic : (animation.semantic = {})
    if (typeof semantic.enabled !== 'boolean') semantic.enabled = true
    if (typeof semantic.minGapMs !== 'number' || !Number.isFinite(semantic.minGapMs)) {
      semantic.minGapMs = 20_000
    }

    const movement = isRecord(pet.movement) ? pet.movement : (pet.movement = {})
    const randomRoam = isRecord(movement.randomRoam)
      ? movement.randomRoam
      : (movement.randomRoam = {})
    if (typeof randomRoam.enabled !== 'boolean') randomRoam.enabled = true
    if (typeof randomRoam.minIntervalMs !== 'number' || !Number.isFinite(randomRoam.minIntervalMs)) {
      randomRoam.minIntervalMs = 180_000
    }
    if (typeof randomRoam.maxIntervalMs !== 'number' || !Number.isFinite(randomRoam.maxIntervalMs)) {
      randomRoam.maxIntervalMs = 360_000
    }
  }

  // 视觉感知从未同意过的旧配置不得因迁移而开启。
  const activity = worlds !== null && isRecord(worlds.activity) ? worlds.activity : null
  const vision = activity !== null && isRecord(activity.vision) ? activity.vision : null
  if (vision !== null && vision.enabled === true && typeof vision.consentAt !== 'number') {
    vision.enabled = false
  }

  // v10：移除没有运行时消费者的开关。安静时段仍然只影响“主动唤醒”，
  // 安静结束后的补上下文从未实现；活动事件是否进入模型由 autonomy 调度与
  // shareEventsToModel 决定，旧 llmProactive 不再保留，避免设置页假装可调。
  if (autonomy !== null) delete autonomy.quietCatchUp
  if (activity !== null) delete activity.llmProactive

  // v11：取消所有每日唤醒次数上限。旧字段必须从持久化配置中删除，
  // 不能让 mergeConfig 的向前兼容把它们悄悄带回来；小时上限、
  // 最小间隔、事件合并与安静时段仍然保留。
  delete autonomy.maxWakesPerDay
  const companion = isRecord(out.companion) ? out.companion : null
  const reaction =
    companion !== null && isRecord(companion.reaction) ? companion.reaction : null
  if (reaction !== null) delete reaction.maxPerDay
  // 旧文件 peek 曾是一条唤醒通道；该链路已整条退役。这里仍删除其旧每日
  // 上限，避免回退旧版本再升级时被合并回来。主动文件探索沿用现有唤醒规则。
  const files = worlds !== null && isRecord(worlds.files) ? worlds.files : null
  if (files !== null) delete files.maxPeeksPerDay

  // v12：取消所有小时唤醒次数上限。计数保留为诊断统计，但不再有任何
  // 「本小时用完就等下一小时」的预算；旧字段必须从持久化配置中删除。
  // reaction.minGapMs 也不再参与任何判断——重复事件由证据去重与短合并
  // 处理，留着它会让设置页看起来还有一条隐藏的禁言上限。
  delete autonomy.maxWakesPerHour
  if (reaction !== null) {
    delete reaction.maxPerHour
    delete reaction.minGapMs
    // v13 一并移除：本地即时动作不再有 8 秒冷却。展示协调交给 figure
    // 动作层（合并/优先级/替换），不能用固定等待把有效反馈丢掉。
    delete reaction.localActionCooldownMs
  }

  // v13：旧配置的 includeProfile 默认是 true，会把整个系统盘用户目录
  // 自动并入新范围，因此一次性关闭（只缩小权限）。已有笔记/作品目录作为
  // 显式例外保留，不删除、不迁移；readRoots 与编辑范围也不因新范围自动扩大。
  const exploration = isRecord(out.exploration) ? out.exploration : null
  if (exploration !== null && fromVersion < 13 && exploration.includeProfile === true) {
    exploration.includeProfile = false
  }

  // v14：连续场景理解取代“每 30 秒一帧 + 每小时 20 次”。旧字段必须从
  // 持久化配置中删除，不能因为 mergeConfig 的向前兼容又悄悄恢复成隐藏
  // 额度；这里不新增任何等价计数器。关键帧共享是新同意，默认永远关闭，
  // 绝不从旧的 OCR 同意或 CUA 截图同意推导。
  if (vision !== null) {
    delete vision.intervalMs
    delete vision.minGapMs
    delete vision.maxPerMinute
    delete vision.maxPerHour
    if (typeof vision.desktopSampleMs !== 'number') vision.desktopSampleMs = 30_000
    if (typeof vision.gameSampleMs !== 'number') vision.gameSampleMs = 30_000
    if (typeof vision.frameBufferSeconds !== 'number') vision.frameBufferSeconds = 15
    if (typeof vision.maxFrames !== 'number') vision.maxFrames = 30
    if (typeof vision.ocrMinGapMs !== 'number') vision.ocrMinGapMs = 3_000
    if (typeof vision.pinnedDisplayId !== 'string') vision.pinnedDisplayId = ''
    const semantic = isRecord(vision.semantic) ? vision.semantic : (vision.semantic = {})
    if (typeof semantic.enabled !== 'boolean') semantic.enabled = true
    if (semantic.shareFrames !== true) semantic.shareFrames = false
    if (typeof semantic.model !== 'string') semantic.model = ''
    if (typeof semantic.baseUrl !== 'string') semantic.baseUrl = ''
    if (typeof semantic.maxKeyframes !== 'number') semantic.maxKeyframes = 3
    if (typeof semantic.minIntervalMs !== 'number') semantic.minIntervalMs = 6_000
    if (typeof semantic.timeoutMs !== 'number') semantic.timeoutMs = 20_000
  }

  // v5 快捷聊天默认接工具；旧配置缺省时补齐，显式 false 保持不变。
  const quick = isRecord(chatUi.quickInput) ? chatUi.quickInput : null
  if (quick !== null) {
    if (typeof quick.allowTools !== 'boolean') quick.allowTools = true
    if (!Array.isArray(quick.deniedTools)) quick.deniedTools = []
  }

  // v8 桌面观察范围：迁移只补一个空范围，绝不自动加入任何应用。
  if (worlds !== null && !isRecord(worlds.desktop)) {
    worlds.desktop = { apps: [] }
  }

  // CUA 是 v5 新增能力：迁移绝不凭空授予键鼠或截图权限。
  const cua = worlds !== null && isRecord(worlds.cua) ? worlds.cua : null
  if (cua !== null) {
    if (fromVersion < 5) {
      cua.enabled = false
      cua.consentAt = null
      cua.screenConsentAt = null
    } else if (
      typeof cua.consentAt !== 'number' ||
      typeof cua.screenConsentAt !== 'number'
    ) {
      cua.enabled = false
    }
  }

  // v9「自由探索」与主动浏览器控制：只补结构，绝不从旧 CUA/窗口/页面
  // 同意推导新授权。缺失的 grantedAt/consentAt 让 enabled 保持无效；用户
  // 必须在设置里重新做一次集中的范围选择。
  if (!isRecord(out.exploration)) {
    out.exploration = {}
  } else if (
    out.exploration.enabled === true &&
    typeof out.exploration.grantedAt !== 'number'
  ) {
    out.exploration.enabled = false
  }
  if (worlds !== null) {
    if (!isRecord(worlds.browserControl)) {
      worlds.browserControl = {}
    } else if (
      worlds.browserControl.enabled === true &&
      typeof worlds.browserControl.consentAt !== 'number'
    ) {
      worlds.browserControl.enabled = false
    }
  }

  // v16：磁盘范围从布尔值收敛为显式模式。旧 `includeNonSystemVolumes`
  // 只做等价映射（true 或历史缺省 -> non-system，false -> explicit），绝不把
  // 非系统盘授权静默扩大成“全部已挂载磁盘”；全盘模式是新的独立选择。
  // 迁移可重复执行：已有合法 volumeScope 时保持不变，旧键随后删除。
  const explorationRecord = isRecord(out.exploration) ? out.exploration : null
  if (explorationRecord !== null) {
    if (!isVolumeAccessMode(explorationRecord['volumeScope'])) {
      const legacy = explorationRecord['includeNonSystemVolumes']
      explorationRecord['volumeScope'] =
        legacy === false
          ? 'explicit'
          : legacy === true
            ? 'non-system'
            : fromVersion < 16
              ? 'non-system'
              : 'explicit'
    }
    delete explorationRecord['includeNonSystemVolumes']
  }

  // v22：主动浏览网页与主动逛 B 站合并为唯一主配置。旧 companion.bilibili
  // 只作为一次性迁移来源保留在文件里（兼容旧版本回读），运行逻辑不再消费。
  // 迁移只做等价/收窄：B 站 enabled 原样搬入站点配置，不会因为合并而替用户
  // 开启原先关闭的站点；标签上限取旧全局与旧站点中的更严格值。重复执行时
  // 已有统一配置保持不变。
  if (worlds !== null || companion !== null) {
    // 旧版本可能只有 companion.bilibili、完全没有 worlds 段；不能因此漏掉迁移。
    const worldsRecord = isRecord(out.worlds) ? out.worlds : (out.worlds = {})
    const control = isRecord(worldsRecord.browserControl)
      ? worldsRecord.browserControl
      : (worldsRecord.browserControl = {})
    const legacy =
      companion !== null && isRecord(companion.bilibili) ? companion.bilibili : null
    const legacyNumber = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback

    const sites = isRecord(control.sites) ? control.sites : (control.sites = {})
    if (!isRecord(sites.bilibili)) {
      const globalMaxTabs = legacyNumber(control.maxTabs, 8)
      const siteMaxTabs = legacyNumber(legacy?.maxTabs, 2)
      sites.bilibili = {
        enabled: legacy?.enabled === true,
        maxDetailsPerSession: legacyNumber(legacy?.maxDetailsPerSession, 5),
        maxCandidatesPerBatch: legacyNumber(legacy?.maxCandidatesPerBatch, 20),
        // 合并后不得放宽旧限制：旧全局上限更小时采用它。
        maxTabs: Math.min(2, Math.max(1, Math.round(siteMaxTabs)), Math.max(1, Math.round(globalMaxTabs)))
      }
    }
    if (typeof control.sessionMaxMs !== 'number') {
      control.sessionMaxMs = legacyNumber(legacy?.sessionMaxMs, 300_000)
    }
    if (typeof control.sessionMaxToolCalls !== 'number') {
      control.sessionMaxToolCalls = legacyNumber(legacy?.sessionMaxToolCalls, 20)
    }
    if (!isRecord(control.discoveries)) {
      control.discoveries = {
        retentionDays: legacyNumber(legacy?.retentionDays, 30),
        maxRecords: legacyNumber(legacy?.maxRecords, 200)
      }
    }
  }

  // v23：B 站从浏览器标签页适配器拆成独立扫码登录 + Python API 配置。
  // 只搬“开关意图”和预算；旧浏览器同意绝不搬成新 API/音频下载的同意，
  // 因此 consentAt 固定为 null，必须由用户重新确认一次。已有 bilibili 段时
  // 不覆盖，保证重复执行幂等，也保证已有关闭状态保持关闭。
  if (isRecord(out.worlds) || out.worlds === undefined) {
    const worldsRecord = isRecord(out.worlds) ? out.worlds : (out.worlds = {})
    if (!isRecord(worldsRecord.bilibili)) {
      const control = isRecord(worldsRecord.browserControl) ? worldsRecord.browserControl : {}
      const sites = isRecord(control.sites) ? control.sites : {}
      const legacySite = isRecord(sites.bilibili) ? sites.bilibili : {}
      const legacyCompanion =
        isRecord(out.companion) && isRecord(out.companion.bilibili)
          ? out.companion.bilibili
          : {}
      // v22 的统一站点开关已经表达了用户意图；存在时以它为准，绝不把旧的
      // companion.bilibili 再 OR 回来。否则用户关掉站点后仍会被旧开关重新打开。
      const hasSiteSwitch = isRecord(sites.bilibili)
      const legacy = hasSiteSwitch ? legacySite : legacyCompanion
      const numberOr = (value: unknown, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback
      const defaults = DEFAULT_CONFIG.worlds.bilibili
      worldsRecord.bilibili = {
        enabled: legacy.enabled === true,
        consentAt: null,
        maxCandidatesPerBatch: numberOr(
          legacy.maxCandidatesPerBatch,
          defaults.maxCandidatesPerBatch
        ),
        maxDetailsPerSession: numberOr(
          legacy.maxDetailsPerSession,
          defaults.maxDetailsPerSession
        ),
        // 沿用原统一会话限额，避免拆分后预算翻倍。
        sessionMaxMs: numberOr(
          control.sessionMaxMs,
          numberOr(legacy.sessionMaxMs, defaults.sessionMaxMs)
        ),
        sessionMaxToolCalls: numberOr(
          control.sessionMaxToolCalls,
          numberOr(legacy.sessionMaxToolCalls, defaults.sessionMaxToolCalls)
        ),
        keywords: [],
        excludeKeywords: [],
        vision: { ...defaults.vision },
        asr: { ...defaults.asr },
        report: { ...defaults.report }
      }
    }
  }

  // v24：统一显式应用授权来源为 worlds.system.apps，并取消系统动作分组配置。
  // 旧 appOpenAllowlist 里的文本不能被自动转换成 appId 或可执行路径，因此
  // 直接删除；应用表本身（id、名称、路径、参数）原样保留。旧 actions 无论
  // 为空、只含部分分组还是缺失，都统一视为固定七种动作可用，总开关 enabled
  // 保持原值。这里无条件删除而非只处理旧版本：否则用户回退旧版本再升级时，
  // mergeConfig 的未知键兼容会把废弃字段重新带回持久化配置。重复执行幂等。
  delete (autonomy as Record<string, unknown>)['appOpenAllowlist']
  if (worlds !== null) {
    const system = isRecord(worlds.system) ? worlds.system : null
    if (system !== null) delete system['actions']
  }

  // v25：屏幕感知改为“跟随前台窗口所在显示器、整屏、60/120 秒自适应”。
  // 旧的 gameSampleMs / 帧环 / 固定显示器配置不再有任何运行时消费者，必须
  // 从持久化配置中删除；旧 `semantic.shareFrames` 只同意过 2–4 张前台窗口
  // 关键帧，不能自动扩大成整屏共享，因此新同意记录一律从空开始。旧独立
  // 视觉模型/地址保留为只读迁移提示，运行时不再使用。
  if (vision !== null) {
    const legacySemantic = isRecord(vision.semantic) ? vision.semantic : null
    if (fromVersion < 25) {
      vision.screenShareConsentAt = null
      vision.screenShareConsentVersion = 0
      vision.desktopSampleMs = 60_000
      vision.staticSampleMs = 120_000
      vision.ocrFallback = false
    }
    delete vision.gameSampleMs
    delete vision.frameBufferSeconds
    delete vision.maxFrames
    delete vision.pinnedDisplayId
    if (legacySemantic !== null) {
      // 旧开关与关键帧参数退出运行配置；model/baseUrl/timeoutMs 保留给设置页
      // 显示迁移提示，但任何代码都不会再用它们构造请求。
      delete legacySemantic.enabled
      delete legacySemantic.shareFrames
      delete legacySemantic.maxKeyframes
      delete legacySemantic.minIntervalMs
    }
    // 范围版本不一致（例如未来再次扩大共享范围）时，旧同意一律失效。
    const consentVersion =
      typeof vision.screenShareConsentVersion === 'number' &&
      Number.isFinite(vision.screenShareConsentVersion)
        ? Math.trunc(vision.screenShareConsentVersion)
        : 0
    if (consentVersion !== SCREEN_SHARE_CONSENT_VERSION) {
      vision.screenShareConsentAt = null
      vision.screenShareConsentVersion = 0
    }
  }

  // v26：新增“根据屏幕主动陪伴”偏好。只补默认字段，不改动任何既有授权；
  // 实际生效仍要求用户已经授权屏幕共享并开启活动事件共享。旧配置若已关闭
  // autonomy/reaction，会继续关闭，不会被这次迁移重新打开。
  const companionRecord = isRecord(out.companion) ? out.companion : null
  if (companionRecord !== null && !isRecord(companionRecord.screenFeedback)) {
    companionRecord.screenFeedback = {
      enabled: DEFAULT_CONFIG.companion.screenFeedback.enabled,
      minIntervalMs: DEFAULT_CONFIG.companion.screenFeedback.minIntervalMs,
      quietPresenceMs: DEFAULT_CONFIG.companion.screenFeedback.quietPresenceMs,
      questionMinIntervalMs:
        DEFAULT_CONFIG.companion.screenFeedback.questionMinIntervalMs,
      postUserCooldownMs: DEFAULT_CONFIG.companion.screenFeedback.postUserCooldownMs
    }
  }

  // v27：项目整合清理。下列字段已确认没有运行时消费者，或已由新实现取代。
  // 只删除持久化键：不把旧“被动文件抽样已开”转换成任何自由探索授权，
  // 也不删除用户数据、发现、任务、记忆或既有授权。必须在 v22/v23（读取旧
  // B 站站点/companion 配置）与 v25（旧视觉模型提示）之后执行。
  if (persona !== null) {
    delete persona.greeting
    delete persona.proactive
    delete persona.heartbeatMinutes
  }
  const quickRecord = isRecord(chatUi.quickInput) ? chatUi.quickInput : null
  if (quickRecord !== null) delete quickRecord.showApprovals

  const worldsRecordV27 = isRecord(out.worlds) ? out.worlds : null
  if (worldsRecordV27 !== null) {
    const filesRecord = isRecord(worldsRecordV27.files) ? worldsRecordV27.files : null
    if (filesRecord !== null) {
      // 后台随机抽样整条链路退役；roots/exclude 仍属于统一文件范围。
      delete filesRecord.enabled
      delete filesRecord.includeFixedDrives
      delete filesRecord.peekIntervalMinutes
      delete filesRecord.maxReadBytes
      delete filesRecord.allowContent
      delete filesRecord.shareExcerptWithModel
      delete filesRecord.shareFileNameWithModel
      delete filesRecord.rememberDays
    }
    const systemRecord = isRecord(worldsRecordV27.system) ? worldsRecordV27.system : null
    if (systemRecord !== null) delete systemRecord.autoApproveWhitelisted
    const workspaceRecord = isRecord(worldsRecordV27.workspace)
      ? worldsRecordV27.workspace
      : null
    if (workspaceRecord !== null) {
      // 敏感文件的“额外审批”开关从未被运行时消费；读取只保留普通范围
      // 授权与通用审批规则。
      delete workspaceRecord.sensitiveApproval
    }
    const controlRecord = isRecord(worldsRecordV27.browserControl)
      ? worldsRecordV27.browserControl
      : null
    if (controlRecord !== null) {
      // 后台标签偏好从未被扩展/运行时消费；浏览行为保持原样。
      delete controlRecord.backgroundTabs
      // B 站浏览器适配器退役；独立 B 站读取已迁到 worlds.bilibili。
      // 普通浏览仍然由 browseLimits 限制在最多 2 个后台标签；若用户原来的
      // 站点上限更严格（1），把它并入全局上限，不能借拆分静默放宽。
      if (inputSiteMaxTabs !== null && inputSiteMaxTabs < 2) {
        const globalMaxTabs =
          typeof controlRecord.maxTabs === 'number' && Number.isFinite(controlRecord.maxTabs)
            ? controlRecord.maxTabs
            : 8
        controlRecord.maxTabs = Math.min(Math.max(1, Math.round(globalMaxTabs)), inputSiteMaxTabs)
      }
      delete controlRecord.sites
    }
    const petRecord = isRecord(worldsRecordV27.pet) ? worldsRecordV27.pet : null
    const appearanceRecord =
      petRecord !== null && isRecord(petRecord.appearance) ? petRecord.appearance : null
    if (appearanceRecord !== null) {
      // 引擎是已打包能力的身份，不是可切换设置；运行时用固定常量。
      delete appearanceRecord.engine
    }
    const visionRecord =
      isRecord(worldsRecordV27.activity) && isRecord(worldsRecordV27.activity.vision)
        ? worldsRecordV27.activity.vision
        : null
    const semanticRecord =
      visionRecord !== null && isRecord(visionRecord.semantic) ? visionRecord.semantic : null
    if (semanticRecord !== null) {
      // 旧独立视觉模型/地址不再被读取；整屏共享同意仍由版本号与
      // screenShareConsentAt 强制重新确认，提示文案保留在隐私页。
      delete semanticRecord.model
      delete semanticRecord.baseUrl
    }
  }
  if (companionRecord !== null) delete companionRecord.bilibili
  // 遥测从未有上报通路，也不提供可开启功能；移出用户配置，隐私说明保留。
  delete out.privacy

  // v28：产品内置角色名从「溟月」统一为「桌宠」。只迁移旧版本配置里恰好
  // 等于旧默认值的名字；用户自定义名字原样保留。迁移按 schemaVersion 执行
  // 一次，升级后用户主动把名字改回「溟月」时不会被再次覆盖。
  if (fromVersion < 28 && persona !== null && persona.name === '溟月') {
    persona.name = '桌宠'
  }

  return out
}
