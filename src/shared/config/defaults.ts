import { CONFIG_SCHEMA_VERSION, DSH_PET_DEFAULT_SIZE, AppConfig } from './types'
import { PET_CATALOG } from '../petPresentation'


export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  persona: {
    name: '桌宠',
    language: 'zh-CN',
    tone: 'gentle',
    roleplay: 'high',
    styleNotes: [],
    customPrompt: ''
  },
  provider: {
    id: 'deepseek',
    model: 'deepseek-flash',
    utilityModel: 'deepseek-flash',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    thinking: true,
    visionInput: true,
    requestTimeoutMs: 45_000,
    streamIdleTimeoutMs: 120_000
  },
  context: { maxTokens: 64000, softRatio: 0.85, keepRatio: 0.33 },
  batching: { quietGapMs: 20000, minBatchAgeMs: 30000, maxBatchAgeMs: 120000, maxBatchSize: 8 },
  autonomy: {
    enabled: true,
    mode: 'assist',
    task: {
      maxMinutes: 15,
      maxToolCalls: 40,
      retentionDays: 30,
      autoResume: true
    },
    takeoverCooldownMs: 3_000,
    tickMinMs: 300_000,
    tickMaxMs: 1_800_000,
    backoffFactor: 2,
    wakeGapMs: 30_000,
    postUserCooldownMs: 45_000,
    respectQuietHours: true,
    idlePauseTicks: true,
    ambientContext: true,
    alarmMinDelayMs: 30_000,
    maxActiveAlarms: 20,
    approvalMode: 'model',
    trustedRoots: [],
    sessionGrantMinutes: 480,
    terminalAllowlist: [],
    maxAutoOpsPerHour: 60,
    autoWriteBackupCount: 20
  },
  exploration: {
    // P0：默认关闭。用户必须在设置里集中开启一次，绝不由迁移或旧同意推导。
    enabled: false,
    scope: 'session',
    grantedAt: null,
    sessionExpiresAt: null,
    web: true,
    browserTabs: true,
    apps: true,
    windows: true,
    // 整屏观察与用户原始文件编辑是两份额外决定，默认不开。
    fullScreen: false,
    fileRead: true,
    // 本次需求明确选择“全部已挂载磁盘”。升级迁移不会把旧布尔值扩大到这个模式。
    volumeScope: 'all',
    artifacts: true,
    edits: false,
    // “全部已挂载磁盘”本身已包含个人目录；其他磁盘模式下这个开关是独立
    // 可见的只读来源，默认关闭且不会由旧授权自动推导。
    includeProfile: false,
    includeNewApps: true,
    excludedDomains: [],
    excludedApps: [],
    readRoots: [],
    artifactRoot: ''
  },
  companion: {
    cadence: 'natural',
    interests: { maxActive: 4, ttlDays: 14, maxFocusCount: 12 },
    experiences: { retentionDays: 14, maxRecords: 50 },
    unanswered: { backoffFactor: 2, maxBackoffMs: 3_600_000 },
    reaction: {
      enabled: true,
      eventTtlMs: 60_000,
      dedupeMs: 30_000
    },
    screenFeedback: {
      enabled: true,
      minIntervalMs: 180_000,
      quietPresenceMs: 600_000,
      questionMinIntervalMs: 1_200_000,
      postUserCooldownMs: 60_000
    }
  },
  chatUi: {
    window: { width: 640, height: 720 },
    quickInput: {
      enabled: true,
      width: 380,
      maxReplyChars: 400,
      closeOnEscape: true,
      allowTools: true,
      deniedTools: []
    },
    petClickAction: 'quick-input',
    allowModelOpen: true
  },
  worlds: {
    chat: { enabled: true },
    pet: {
      enabled: true,
      reactions: 'medium',
      appearance: {
        packId: 'main',
        size: DSH_PET_DEFAULT_SIZE,
        reducedMotion: false,
        home: { corner: 'top-right', marginX: 24, marginY: 100 }
      },
      animation: {
        policy: 'hybrid',
        idleActions: {
          enabled: true,
          minIdleMs: 120_000,
          minIntervalMs: 600_000,
          sameActionIntervalMs: 1_800_000,
          lookAroundIntervalMs: 900_000
        },
        randomIdle: {
          enabled: true,
          minIntervalMs: 120_000,
          maxIntervalMs: 300_000
        },
        semantic: {
          enabled: true,
          minGapMs: 20_000
        }
      },
      physics: { ...PET_CATALOG.physics },
      confineToScreen: false,
      movement: {
        enabled: true,
        pauseWithPanel: true,
        minIdleMs: 30_000,
        autonomousMinIntervalMs: 120_000,
        randomRoam: {
          enabled: true,
          minIntervalMs: 180_000,
          maxIntervalMs: 360_000
        }
      }
    },
    activity: {
      enabled: false,
      sampleMs: 2000,
      idleMinutes: 5,
      quietHours: ['23:30', '08:00'],
      muteCategories: ['meeting', 'game'],
      exclude: [],
      retainStatsDays: 0,
      vision: {
        enabled: false,
        consentAt: null,
        // 默认不向模型发送任何画面；整屏共享必须由用户在设置页单独确认。
        screenShareConsentAt: null,
        screenShareConsentVersion: 0,
        desktopSampleMs: 60_000,
        staticSampleMs: 120_000,
        ocrMinGapMs: 3000,
        language: 'auto',
        keepSamples: 20,
        showOcrSnippet: false,
        // 模型看图是主路径；本地 OCR 只是可选的离线兜底。
        ocrFallback: false,
        semantic: {
          timeoutMs: 20_000
        }
      },
      shareEventsToModel: true,
      shareAppName: true,
      shareWindowTitle: true,
      titleMaxChars: 80,
      appSwitchCoalesceMs: 2_500,
      appSwitchMaxHoldMs: 6_000,
      timelineMinutes: 90,
      timelineMaxEntries: 200
    },
    files: {
      roots: [],
      exclude: []
    },
    system: {
      enabled: false,
      apps: [],
      allowUrls: true,
      allowPaths: true
    },
    workspace: { root: '', notesRoot: '' },
    web: { enabled: true, provider: 'deepseek', askBefore: false },
    terminal: { enabled: true, shell: 'cmd.exe' },
    browserPage: {
      enabled: false,
      consentAt: null,
      shareTitle: true,
      shareExcerpt: true,
      includeHeadings: true,
      excerptMaxChars: 1200,
      coalesceMs: 3_000,
      maxPerMinute: 6,
      maxPerHour: 60,
      allowlistOnly: false,
      allowlist: [],
      denylist: [],
      sensitiveDomains: [
        '*.icbc.com.cn',
        '*.ccb.com',
        '*.abchina.com',
        '*.bankofchina.com',
        '*.cmbchina.com',
        '*.bankofamerica.com',
        '*.chase.com',
        '*.wellsfargo.com',
        '*.citi.com',
        '*.paypal.com',
        '*.stripe.com',
        '*.alipay.com',
        '*.1password.com',
        '*.bitwarden.com',
        '*.lastpass.com',
        '*.dashlane.com',
        '*.keepersecurity.com',
        'mail.google.com',
        'outlook.live.com',
        'outlook.office.com',
        'mail.qq.com',
        'mail.163.com',
        'mail.126.com',
        '*.protonmail.com',
        '*.proton.me',
        'drive.google.com',
        '*.dropbox.com',
        '*.onedrive.live.com',
        '*.id.me',
        'login.gov',
        '*.okta.com'
      ]
    },
    browserControl: {
      enabled: false,
      consentAt: null,
      searchUrl: 'https://www.bing.com/search?q={query}',
      maxTabs: 8,
      waitTimeoutMs: 15_000,
      allowDownloads: true,
      sessionMaxMs: 300_000,
      sessionMaxToolCalls: 20,
      discoveries: { retentionDays: 30, maxRecords: 200 }
    },
    bilibili: {
      enabled: false,
      consentAt: null,
      maxCandidatesPerBatch: 20,
      maxDetailsPerSession: 5,
      sessionMaxMs: 300_000,
      sessionMaxToolCalls: 20,
      keywords: [],
      excludeKeywords: [],
      vision: { enabled: true, defaultFrames: 3, maxFrames: 6 },
      asr: {
        enabled: true,
        model: 'small',
        maxMediaMinutes: 30,
        maxDownloadMb: 300,
        maxRunMinutes: 20,
        maxCacheMb: 1024
      },
      report: { enabled: true, retentionDays: 30 }
    },
    cua: {
      enabled: false,
      consentAt: null,
      screenConsentAt: null,
      permission: 'ask-once',
      grantMinutes: 30,
      afterActionScreenshot: true,
      actionOverlay: true,
      maxActionsPerTurn: 30,
      screenshotMaxWidth: 1280,
      jpegQuality: 72,
      settleMs: 350,
      blockedApps: []
    },
    // P1：默认不观察任何应用。用户必须在设置里逐应用显式加入。
    desktop: {
      apps: [],
      structuredText: true,
      windowCapture: false,
      maxWindows: 8,
      maxTextChars: 8_000,
      maxObservePerHour: 30,
      inventoryPollMs: 30_000
    }
  },
  memory: { enabled: true, habits: false, dream: false },
  approval: { ttlMs: 600000, sessionAllowExactCommand: true }
}


/** 深拷贝默认配置，避免调用方改到模块常量。 */
export function defaultConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig
}
