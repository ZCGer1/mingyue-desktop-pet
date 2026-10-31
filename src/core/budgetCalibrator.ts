import { calibrateFromUsage } from './requestBudget'

/** One in-memory calibration per provider/model, shared by all conversation views. */
export class BudgetCalibrator {
  private readonly factors = new Map<string, number>()

  factor(key: string): number {
    return this.factors.get(key) ?? 1
  }

  observe(key: string, rawInputTokens: number, actualPromptTokens: number): void {
    this.factors.set(key, calibrateFromUsage(this.factor(key), rawInputTokens, actualPromptTokens))
  }
}
