import type { CapabilityCardId } from '../../shared/capabilityStatus'
import type { ConfigPath } from './configTree'

/**
 * 配置归属表。
 *
 * 每个配置路径只有一个标准编辑位置；向导步骤按这里的所有权分步保存，
 * 未列出的路径不会被别的步骤夹带提交。这里同时是字段迁移清单的代码来源，
 * 改动配置结构时应同步本文件。
 */

/** 六项能力各自拥有的路径；能力卡“未保存”标记与向导分步保存共用。 */
export const CAPABILITY_PATHS: Record<CapabilityCardId, readonly ConfigPath[]> = {
  web: [
    ['worlds', 'web', 'enabled'],
    ['worlds', 'web', 'askBefore'],
    ['worlds', 'browserPage', 'enabled'],
    ['worlds', 'browserPage', 'consentAt'],
    ['worlds', 'browserPage', 'shareTitle'],
    ['worlds', 'browserPage', 'shareExcerpt'],
    ['worlds', 'browserPage', 'includeHeadings'],
    ['worlds', 'browserPage', 'excerptMaxChars'],
    ['worlds', 'browserPage', 'coalesceMs'],
    ['worlds', 'browserPage', 'maxPerMinute'],
    ['worlds', 'browserPage', 'maxPerHour'],
    ['worlds', 'browserPage', 'allowlistOnly'],
    ['worlds', 'browserPage', 'allowlist'],
    ['worlds', 'browserPage', 'denylist'],
    ['worlds', 'browserPage', 'sensitiveDomains'],
    ['worlds', 'browserControl', 'enabled'],
    ['worlds', 'browserControl', 'consentAt'],
    ['worlds', 'browserControl', 'searchUrl'],
    ['worlds', 'browserControl', 'maxTabs'],
    ['worlds', 'browserControl', 'waitTimeoutMs'],
    ['worlds', 'browserControl', 'sessionMaxMs'],
    ['worlds', 'browserControl', 'sessionMaxToolCalls'],
    ['worlds', 'browserControl', 'discoveries', 'retentionDays'],
    ['worlds', 'browserControl', 'discoveries', 'maxRecords'],
    ['exploration', 'web'],
    ['exploration', 'browserTabs'],
    ['exploration', 'excludedDomains']
  ],
  bilibili: [
    ['worlds', 'bilibili', 'enabled'],
    ['worlds', 'bilibili', 'consentAt'],
    ['worlds', 'bilibili', 'maxCandidatesPerBatch'],
    ['worlds', 'bilibili', 'maxDetailsPerSession'],
    ['worlds', 'bilibili', 'sessionMaxMs'],
    ['worlds', 'bilibili', 'sessionMaxToolCalls'],
    ['worlds', 'bilibili', 'keywords'],
    ['worlds', 'bilibili', 'excludeKeywords'],
    ['worlds', 'bilibili', 'vision', 'enabled'],
    ['worlds', 'bilibili', 'vision', 'defaultFrames'],
    ['worlds', 'bilibili', 'vision', 'maxFrames'],
    ['worlds', 'bilibili', 'asr', 'enabled'],
    ['worlds', 'bilibili', 'asr', 'model'],
    ['worlds', 'bilibili', 'asr', 'maxMediaMinutes'],
    ['worlds', 'bilibili', 'asr', 'maxDownloadMb'],
    ['worlds', 'bilibili', 'asr', 'maxRunMinutes'],
    ['worlds', 'bilibili', 'asr', 'maxCacheMb'],
    ['worlds', 'bilibili', 'report', 'enabled'],
    ['worlds', 'bilibili', 'report', 'retentionDays']
  ],
  apps: [
    ['worlds', 'system', 'enabled'],
    ['worlds', 'system', 'apps'],
    ['worlds', 'system', 'allowUrls'],
    ['worlds', 'system', 'allowPaths'],
    ['exploration', 'apps'],
    ['exploration', 'includeNewApps'],
    ['exploration', 'excludedApps']
  ],
  screen: [
    ['worlds', 'cua', 'enabled'],
    ['worlds', 'cua', 'consentAt'],
    ['worlds', 'cua', 'screenConsentAt'],
    ['worlds', 'cua', 'permission'],
    ['worlds', 'cua', 'grantMinutes'],
    ['worlds', 'cua', 'afterActionScreenshot'],
    ['worlds', 'cua', 'actionOverlay'],
    ['worlds', 'cua', 'maxActionsPerTurn'],
    ['worlds', 'cua', 'screenshotMaxWidth'],
    ['worlds', 'cua', 'jpegQuality'],
    ['worlds', 'cua', 'settleMs'],
    ['worlds', 'cua', 'blockedApps'],
    ['worlds', 'desktop', 'apps'],
    ['worlds', 'desktop', 'structuredText'],
    ['worlds', 'desktop', 'windowCapture'],
    ['worlds', 'desktop', 'maxWindows'],
    ['worlds', 'desktop', 'maxTextChars'],
    ['worlds', 'desktop', 'maxObservePerHour'],
    ['worlds', 'desktop', 'inventoryPollMs'],
    ['worlds', 'activity', 'vision', 'enabled'],
    ['worlds', 'activity', 'vision', 'consentAt'],
    ['worlds', 'activity', 'vision', 'screenShareConsentAt'],
    ['worlds', 'activity', 'vision', 'screenShareConsentVersion'],
    ['worlds', 'activity', 'vision', 'desktopSampleMs'],
    ['worlds', 'activity', 'vision', 'staticSampleMs'],
    ['worlds', 'activity', 'vision', 'ocrMinGapMs'],
    ['worlds', 'activity', 'vision', 'language'],
    ['worlds', 'activity', 'vision', 'keepSamples'],
    ['worlds', 'activity', 'vision', 'showOcrSnippet'],
    ['worlds', 'activity', 'vision', 'ocrFallback'],
    ['worlds', 'activity', 'vision', 'semantic', 'timeoutMs'],
    ['exploration', 'windows'],
    ['exploration', 'fullScreen']
  ],
  files: [
    ['worlds', 'files', 'roots'],
    ['worlds', 'files', 'exclude'],
    ['worlds', 'workspace', 'root'],
    ['autonomy', 'trustedRoots'],
    ['exploration', 'fileRead'],
    ['exploration', 'volumeScope'],
    ['exploration', 'includeProfile'],
    ['exploration', 'readRoots'],
    ['exploration', 'edits']
  ],
  artifacts: [
    ['exploration', 'artifacts'],
    ['exploration', 'artifactRoot'],
    ['worlds', 'workspace', 'notesRoot'],
    ['worlds', 'browserControl', 'allowDownloads']
  ]
}

/**
 * 立即撤销会整体改写的授权字段。
 *
 * 撤销由主进程直接写已保存配置；向导草稿必须同步这些字段，否则后续步骤
 * 保存会把刚撤销的授权又写回去。
 */
export const EXPLORATION_AUTH_PATHS: readonly ConfigPath[] = [
  ['exploration', 'enabled'],
  ['exploration', 'grantedAt'],
  ['exploration', 'sessionExpiresAt'],
  ['exploration', 'web'],
  ['exploration', 'browserTabs'],
  ['exploration', 'apps'],
  ['exploration', 'windows'],
  ['exploration', 'fullScreen'],
  ['exploration', 'fileRead'],
  ['exploration', 'artifacts'],
  ['exploration', 'edits'],
  ['exploration', 'includeProfile']
]

/** 自主与授权组：运行授权、审批策略、预算与重启恢复。 */
export const AUTHORIZATION_PATHS: readonly ConfigPath[] = [
  ['autonomy', 'enabled'],
  ['autonomy', 'mode'],
  ['autonomy', 'task', 'maxMinutes'],
  ['autonomy', 'task', 'maxToolCalls'],
  ['autonomy', 'task', 'retentionDays'],
  ['autonomy', 'task', 'autoResume'],
  ['autonomy', 'takeoverCooldownMs'],
  ['autonomy', 'approvalMode'],
  ['autonomy', 'sessionGrantMinutes'],
  ['autonomy', 'maxAutoOpsPerHour'],
  ['autonomy', 'autoWriteBackupCount'],
  ['exploration', 'enabled'],
  ['exploration', 'grantedAt'],
  ['exploration', 'scope'],
  ['exploration', 'sessionExpiresAt']
]

/** 终端与审批细节：只出现在高级与诊断/完成步骤的“其他设置”。 */
export const OTHER_SETTINGS_PATHS: readonly ConfigPath[] = [
  ['worlds', 'terminal', 'enabled'],
  ['worlds', 'terminal', 'shell'],
  ['autonomy', 'terminalAllowlist'],
  ['approval', 'ttlMs'],
  ['approval', 'sessionAllowExactCommand']
]

/** 模型与用量。 */
export const MODEL_PATHS: readonly ConfigPath[] = [
  ['provider', 'model'],
  ['provider', 'utilityModel'],
  ['provider', 'contextWindow'],
  ['provider', 'maxOutputTokens'],
  ['provider', 'thinking'],
  ['provider', 'visionInput'],
  ['provider', 'baseUrl'],
  ['provider', 'requestTimeoutMs'],
  ['provider', 'streamIdleTimeoutMs'],
  ['context', 'maxTokens'],
  ['context', 'softRatio'],
  ['context', 'keepRatio'],
  ['batching', 'quietGapMs'],
  ['batching', 'minBatchAgeMs'],
  ['batching', 'maxBatchAgeMs'],
  ['batching', 'maxBatchSize']
]

/** 陪伴与外观：人格、桌宠、聊天窗口、节奏、安静时段。 */
export const COMPANION_PATHS: readonly ConfigPath[] = [
  ['persona', 'name'],
  ['persona', 'language'],
  ['persona', 'tone'],
  ['persona', 'roleplay'],
  ['persona', 'styleNotes'],
  ['persona', 'customPrompt'],
  ['worlds', 'chat', 'enabled'],
  ['worlds', 'pet', 'enabled'],
  ['worlds', 'pet', 'reactions'],
  ['worlds', 'pet', 'appearance'],
  ['worlds', 'pet', 'animation'],
  ['worlds', 'pet', 'physics'],
  ['worlds', 'pet', 'confineToScreen'],
  ['worlds', 'pet', 'movement'],
  ['chatUi', 'window'],
  ['chatUi', 'quickInput'],
  ['chatUi', 'petClickAction'],
  ['chatUi', 'allowModelOpen'],
  ['companion', 'cadence'],
  ['companion', 'interests'],
  ['companion', 'experiences'],
  ['companion', 'unanswered'],
  ['companion', 'reaction'],
  ['companion', 'screenFeedback'],
  ['autonomy', 'tickMinMs'],
  ['autonomy', 'tickMaxMs'],
  ['autonomy', 'backoffFactor'],
  ['autonomy', 'wakeGapMs'],
  ['autonomy', 'postUserCooldownMs'],
  ['autonomy', 'respectQuietHours'],
  ['autonomy', 'idlePauseTicks'],
  ['autonomy', 'ambientContext'],
  ['worlds', 'activity', 'quietHours']
]

/** 记忆与隐私：记忆、行为感知、共享字段、保留规则。 */
export const MEMORY_PATHS: readonly ConfigPath[] = [
  ['memory', 'enabled'],
  ['memory', 'habits'],
  ['memory', 'dream'],
  ['worlds', 'activity', 'enabled'],
  ['worlds', 'activity', 'sampleMs'],
  ['worlds', 'activity', 'idleMinutes'],
  ['worlds', 'activity', 'muteCategories'],
  ['worlds', 'activity', 'exclude'],
  ['worlds', 'activity', 'retainStatsDays'],
  ['worlds', 'activity', 'shareEventsToModel'],
  ['worlds', 'activity', 'shareAppName'],
  ['worlds', 'activity', 'shareWindowTitle'],
  ['worlds', 'activity', 'titleMaxChars'],
  ['worlds', 'activity', 'appSwitchCoalesceMs'],
  ['worlds', 'activity', 'appSwitchMaxHoldMs'],
  ['worlds', 'activity', 'timelineMinutes'],
  ['worlds', 'activity', 'timelineMaxEntries']
]

export type WizardStepId =
  | 'api'
  | 'web'
  | 'bilibili'
  | 'apps'
  | 'screen'
  | 'files'
  | 'artifacts'
  | 'companion'
  | 'memory'
  | 'finish'

/** 向导每个步骤拥有的配置路径。 */
export const WIZARD_STEP_PATHS: Record<WizardStepId, readonly ConfigPath[]> = {
  api: MODEL_PATHS,
  web: CAPABILITY_PATHS.web,
  bilibili: CAPABILITY_PATHS.bilibili,
  apps: CAPABILITY_PATHS.apps,
  screen: CAPABILITY_PATHS.screen,
  files: CAPABILITY_PATHS.files,
  artifacts: CAPABILITY_PATHS.artifacts,
  companion: COMPANION_PATHS,
  memory: MEMORY_PATHS,
  finish: [...AUTHORIZATION_PATHS, ...OTHER_SETTINGS_PATHS]
}

/**
 * 没有设置页编辑入口、只由默认值/迁移维护的配置键。
 * 保留在这里是为了让迁移清单可以核查“没有遗漏”，而不是把它们当成已开放功能。
 */
export const INTERNAL_ONLY_PATHS: readonly ConfigPath[] = [
  ['schemaVersion'],
  ['autonomy', 'alarmMinDelayMs'],
  ['autonomy', 'maxActiveAlarms'],
  ['provider', 'id'],
  ['worlds', 'web', 'provider']
]
