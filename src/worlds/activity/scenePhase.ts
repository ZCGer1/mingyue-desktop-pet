import type { SceneCategory, ScenePhase } from './scene'

/**
 * 通用游戏阶段推断（菜单/加载/游玩/暂停/结算）。
 *
 * 只使用本机 OCR 文本与画面变化，不把像素运动当成语义事件。阶段切换需要
 * 连续证据或非常明确的结算文本；只有进程名时保持 unknown，绝不猜。
 */

export interface PhaseEvidence {
  text: string
  category: SceneCategory
  at: number
  /** 与上一关键帧相比是否有明显结构变化。 */
  frameChanged: boolean
  /** 已脱敏的游戏显示名；仅在允许共享应用名时传入。 */
  game?: string | null
}

export interface PhaseObservation {
  phase: ScenePhase
  previousPhase: ScenePhase
  game: string | null
  /** 通用、无 OCR 原文的变化描述；null 表示没有阶段变化。 */
  change: string | null
  detail: string | null
  confidence: number
  /** 是否已通过稳定性确认（false 时不要发布阶段事件）。 */
  stable: boolean
}

interface PhaseScore {
  phase: ScenePhase
  score: number
  strong: boolean
}

const STRONG_RESULTS = [
  /胜利结算/,
  /对局结束/,
  /游戏结束/,
  /战斗结束/,
  /任务完成/,
  /关卡完成/,
  /最终得分/,
  /victory/i,
  /defeat/i,
  /game\s*over/i,
  /mission\s*(?:complete|accomplished)/i,
  /level\s*(?:complete|clear)/i,
  /results?\s*screen/i
]

const RESULTS = [
  /结算/,
  /战败/,
  /失败/,
  /胜利/,
  /排名/,
  /再来一局/,
  /返回大厅/,
  /继续下一关/,
  /defeat(?:ed)?/i,
  /victory/i,
  /scoreboard/i,
  /replay/i
]

const PAUSED = [
  /已暂停/,
  /暂停/,
  // “继续游戏”在主菜单里表示读档继续，不能当成暂停证据；
  // 暂停菜单本身通常还会显示“已暂停/暂停/返回游戏”。
  /返回游戏/,
  /恢复游戏/,
  // 没有“暂停”字样的游戏内菜单：暂停浮层通常同时提供返回地图/
  // 重新开始/回主菜单，和标题菜单的选项组合不同。
  /返回到大地图/,
  /回到主菜单/,
  /返回主菜单/,
  /放弃本关/,
  /paused/i,
  /resume\s*(?:game|play)?/i
]

const LOADING = [
  /加载中/,
  /载入中/,
  /正在加载/,
  /正在载入/,
  /正在连接/,
  /匹配中/,
  /正在匹配/,
  /正在进入/,
  /进入游戏/,
  /loading/i,
  /connecting/i,
  /matchmaking/i,
  /loading\s*screen/i
]

const MENU = [
  /开始游戏/,
  /新游戏/,
  /主菜单/,
  /游戏菜单/,
  /载入存档/,
  /选择关卡/,
  /关卡编辑器/,
  /自定义关卡/,
  /作者名单/,
  /制作人员/,
  /存档位/,
  /版本\s*\d/,
  /设置/,
  /设定/,
  /退出游戏/,
  /结束游戏/,
  /按任意键/,
  /main\s*menu/i,
  /start\s*game/i,
  /new\s*game/i,
  /options/i,
  /press\s*any\s*key/i,
  /\bplay\b/i
]

const PLAYING = [
  /得分/,
  /比分/,
  /击杀/,
  /助攻/,
  /连杀/,
  /生命值/,
  /血量/,
  /护甲/,
  /弹药/,
  /技能/,
  /冷却/,
  /任务目标/,
  /剩余/,
  /金币/,
  /经验值/,
  /装备/,
  /背包/,
  /队伍/,
  /关卡/,
  /排名/,
  /\bhp\b/i,
  /\bmp\b/i,
  /\bscore\b/i,
  /\bkills?\b/i,
  /\bammo\b/i,
  /\bobjective\b/i
]

function countMatches(text: string, patterns: RegExp[], weight: number): { score: number; hits: number } {
  let score = 0
  let hits = 0
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      score += weight
      hits += 1
    }
  }
  return { score, hits }
}

/**
 * 游戏内暂停浮层的选项组合。单独一个“继续游戏”可能是主菜单的读档
 * 入口，所以必须在已知处于游玩状态时，至少要同时命中两个选项才算
 * 暂停。OCR 对小字常有漏读（“继续游戏”只剩“续游戏”），所以模式
 * 容忍前缀缺失和“回主”这类截断。
 */
const PAUSE_OVERLAY = [
  /(?:继)?续游戏/,
  /重新开始/,
  /设定|设置/,
  /返回到?大地图|返回地图/,
  /(?:返回|回到|回)主(?:菜单)?/,
  /退出游戏|离开游戏/
]

function hasPauseOverlay(text: string): boolean {
  const normalized = normalizePhaseText(text)
  let hits = 0
  for (const pattern of PAUSE_OVERLAY) {
    if (pattern.test(normalized)) hits += 1
    if (hits >= 2) return true
  }
  return false
}

/**
 * 主菜单独有、暂停浮层不会出现的选项。OCR 只读到局部选项时，用它们
 * 区分“真的回了主菜单”与“暂停菜单被漏读了一部分”。
 */
const MAIN_MENU_MARKERS = [
  /开始游戏/,
  /新游戏/,
  /关卡编辑器/,
  /作者名单/,
  /制作人员/,
  /存档位/,
  /版本\s*\d/,
  /载入存档/,
  /选择关卡/,
  /自定义关卡/,
  /结束游戏/,
  /按任意键/
]

function hasMainMenuMarker(text: string): boolean {
  const normalized = normalizePhaseText(text)
  return MAIN_MENU_MARKERS.some((pattern) => pattern.test(normalized))
}

/**
 * Windows OCR 常把汉字拆成“设 置”；阶段匹配前去掉汉字间空格。
 * 英文单词之间的空格保留，避免把 “game over” 拼成一个词。
 */
function normalizePhaseText(text: string): string {
  return text
    .replace(/([㐀-鿿：；，。！？、（）【】「」《》〈〉])[ \t　]+(?=[㐀-鿿：；，。！？、（）【】「」《》〈〉])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 仅用于单元测试与本地诊断；返回的 matched 只含阶段名，不含 OCR 原文。 */
export function inferGamePhase(text: string): { phase: ScenePhase; confidence: number } {
  const normalized = normalizePhaseText(text)
  if (normalized === '') return { phase: 'unknown', confidence: 0 }

  const scores: PhaseScore[] = []
  const strongResults = countMatches(normalized, STRONG_RESULTS, 2)
  const results = countMatches(normalized, RESULTS, 1)
  if (strongResults.hits > 0 || results.hits >= 2) {
    scores.push({
      phase: 'results',
      score: strongResults.score + results.score,
      strong: strongResults.hits > 0
    })
  }
  const paused = countMatches(normalized, PAUSED, 2)
  if (paused.hits > 0) scores.push({ phase: 'paused', score: paused.score, strong: false })
  const loading = countMatches(normalized, LOADING, 2)
  if (loading.hits > 0) scores.push({ phase: 'loading', score: loading.score, strong: false })
  const menu = countMatches(normalized, MENU, 1)
  if (menu.hits > 0) scores.push({ phase: 'menu', score: menu.score, strong: false })
  const playing = countMatches(normalized, PLAYING, 1)
  if (playing.hits >= 2 || (playing.hits >= 1 && playing.score >= 1)) {
    scores.push({ phase: 'playing', score: playing.score, strong: false })
  }

  if (scores.length === 0) return { phase: 'unknown', confidence: 0 }
  scores.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    // 同等分数时结算/暂停优先于菜单；菜单优先于游玩，避免把“开始游戏”
    // 当成已经在游玩。
    const order: Record<string, number> = {
      results: 5,
      paused: 4,
      loading: 3,
      menu: 2,
      playing: 1,
      unknown: 0
    }
    return (order[right.phase] ?? 0) - (order[left.phase] ?? 0)
  })
  const top = scores[0]!
  const confidence = Math.min(0.95, 0.45 + top.score * 0.1)
  return { phase: top.phase, confidence: Math.round(confidence * 100) / 100 }
}

function changeText(previous: ScenePhase, next: ScenePhase, game: string | null): string {
  const prefix = game === null ? '' : `《${game}》`
  if (previous === 'unknown') {
    const label: Record<ScenePhase, string> = {
      unknown: '',
      menu: '出现游戏菜单',
      loading: '进入加载',
      playing: '进入游玩',
      paused: '进入暂停',
      results: '出现结算画面'
    }
    return `${prefix}${label[next]}`
  }
  if (next === 'results') return `${prefix}进入结算`
  if (next === 'paused') return `${prefix}游戏暂停`
  if (next === 'playing') {
    if (previous === 'loading') return `${prefix}加载完成，进入游玩`
    if (previous === 'menu') return `${prefix}开始游玩`
    return `${prefix}继续游玩`
  }
  if (next === 'menu') return previous === 'results' ? `${prefix}返回菜单` : `${prefix}回到菜单`
  if (next === 'loading') return `${prefix}进入加载`
  return `${prefix}阶段变化`
}

const PHASE_ORDER: ScenePhase[] = ['unknown', 'menu', 'loading', 'playing', 'paused', 'results']

/**
 * 阶段稳定性跟踪。普通切换需要连续两次相同判断；强结算证据可以立即
 * 切换，以满足可辨识事件的语义反馈延迟目标。
 */
export class PhaseTracker {
  private phase: ScenePhase = 'unknown'
  private game: string | null = null
  private candidate: ScenePhase | null = null
  private candidateHits = 0
  private candidateConfidence = 0
  private lastEvidenceAt = 0

  current(): { phase: ScenePhase; game: string | null } {
    return { phase: this.phase, game: this.game }
  }

  reset(): void {
    this.phase = 'unknown'
    this.game = null
    this.candidate = null
    this.candidateHits = 0
    this.candidateConfidence = 0
    this.lastEvidenceAt = 0
  }

  /**
   * 采用视觉模型确认的阶段（例如画面中的结算字样无法被本地 OCR 读出）。
   * 只更新当前阶段，不伪造 change；之后的本地证据仍可在连续确认后改写它。
   */
  adopt(phase: ScenePhase, at: number): void {
    this.phase = phase
    this.candidate = null
    this.candidateHits = 0
    this.candidateConfidence = 0
    this.lastEvidenceAt = at
  }

  update(evidence: PhaseEvidence): PhaseObservation {
    this.lastEvidenceAt = evidence.at
    if (evidence.game !== undefined && evidence.game !== null && evidence.game.trim() !== '') {
      this.game = evidence.game.trim().slice(0, 40)
    }
    const previous = this.phase
    const base: PhaseObservation = {
      phase: previous,
      previousPhase: previous,
      game: this.game,
      change: null,
      detail: null,
      confidence: 0,
      stable: true
    }
    if (evidence.category !== 'gaming') {
      this.reset()
      return { ...base, phase: 'unknown', previousPhase: previous }
    }

    const inferred = inferGamePhase(evidence.text)
    let target = inferred.phase
    let confidence = inferred.confidence

    // 已经进入游玩后，出现“继续游戏/重新开始/设定/回主菜单”这类
    // 组合，是叠在关卡画面上的暂停浮层；即使 OCR 漏掉“暂停”二字、
    // 或者只读到局部选项，也能按上下文识别。主菜单独有的选项存在时
    // 不按暂停处理，避免把“回到主菜单”误当成暂停。
    const pauseText = normalizePhaseText(evidence.text)
    const pauseOverlay =
      target !== 'results' &&
      !hasMainMenuMarker(evidence.text) &&
      (hasPauseOverlay(evidence.text) ||
        (previous === 'playing' && /(?:继)?续游戏/.test(pauseText)))
    if (previous === 'playing' && pauseOverlay) {
      target = 'paused'
      confidence = Math.max(confidence, 0.65)
    }
    // 暂停浮层被 OCR 漏读成普通菜单文字时保持暂停；只有出现主菜单
    // 独有的选项，才允许从暂停回到主菜单。
    if (previous === 'paused' && target === 'menu' && !hasMainMenuMarker(evidence.text)) {
      target = 'paused'
      confidence = Math.max(confidence, 0.6)
    }

    // 没有新的文字信号时：不把画面运动当成阶段变化；如果已经在游玩，
    // 保持游玩（无 HUD 的游戏也能延续上下文），否则保持当前阶段。
    if (target === 'unknown') {
      if (previous === 'playing' && evidence.frameChanged) {
        return { ...base, confidence: 0.5 }
      }
      // 许多游戏离开菜单/加载/暂停后只剩关卡标题，没有任何 HUD 词
      // （Baba Is You 的“Baba 没有回应”就是一例）。菜单文字消失、
      // 新文字又连续两帧不含任何阶段词，说明已经回到游戏画面；
      // 这是文字层面的过渡证据，不是单凭像素运动猜阶段。
      const text = normalizePhaseText(evidence.text)
      if (
        (previous === 'menu' || previous === 'loading' || previous === 'paused') &&
        text.length >= 2
      ) {
        target = 'playing'
        confidence = 0.55
      } else {
        return { ...base, confidence: previous === 'unknown' ? 0 : 0.4 }
      }
    }
    if (target === previous) {
      this.candidate = null
      this.candidateHits = 0
      return { ...base, confidence }
    }

    const strongResults = target === 'results' && confidence >= 0.85
    if (strongResults) {
      this.candidate = null
      this.candidateHits = 0
      this.phase = target
      return {
        phase: target,
        previousPhase: previous,
        game: this.game,
        change: changeText(previous, target, this.game),
        detail: '画面出现明确的结算文字',
        confidence,
        stable: true
      }
    }

    if (this.candidate === target) {
      this.candidateHits += 1
      this.candidateConfidence = Math.max(this.candidateConfidence, confidence)
    } else {
      this.candidate = target
      this.candidateHits = 1
      this.candidateConfidence = confidence
    }
    if (this.candidateHits < 2) {
      return { ...base, confidence: Math.min(0.5, confidence) }
    }

    this.candidate = null
    this.candidateHits = 0
    this.phase = target
    return {
      phase: target,
      previousPhase: previous,
      game: this.game,
      change: changeText(previous, target, this.game),
      detail:
        target === 'menu'
          ? '画面出现菜单类文字'
          : target === 'playing'
            ? '画面出现持续的游戏 HUD/文字'
            : target === 'loading'
              ? '画面出现加载提示'
              : target === 'paused'
                ? '画面出现暂停提示'
                : target === 'results'
                  ? '画面出现结算文字'
                  : null,
      confidence: Math.max(this.candidateConfidence, confidence),
      stable: true
    }
  }

  /** 用于诊断：是否已经观察到候选阶段但尚未稳定。 */
  pending(): ScenePhase | null {
    return this.candidate
  }

  lastEvidence(): number {
    return this.lastEvidenceAt
  }

  /** 只用于测试/诊断，确认阶段顺序稳定。 */
  static order(): readonly ScenePhase[] {
    return PHASE_ORDER
  }
}
