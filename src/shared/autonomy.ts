/**
 * 自主休息的结构化语义。
 *
 * `quiet` 只表示「先不抢表达/前台动作」，后台探索仍可继续；
 * `waiting` 表示在某个可验证条件或复查时间前不开始新步骤；
 * `rest` 才是真正暂停新的探索机会（仍受用户控制约束）。
 */
export type AutonomyRestMode = 'quiet' | 'waiting' | 'rest'

export interface AutonomyRestRequest {
  mode: AutonomyRestMode
  reason: string
  /** 仅 rest 使用：真正暂停探索的分钟数（1–120）。 */
  minutes: number
  /** 仅 waiting 使用：在等待什么条件；可以为空。 */
  waitFor: string | null
  /** 仅 waiting 使用：多少分钟后复查。 */
  recheckMinutes: number
}
