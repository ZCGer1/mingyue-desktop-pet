import { Session } from './session'
import { TurnEngine } from './turnEngine'
import { TurnWorkState } from './turnWorkState'

/** Owns the current user topic and serializes its views. Backgrounds never borrow it. */
export class ConversationRuntime {
  readonly engine = new TurnEngine()
  readonly userWorkState = new TurnWorkState()
  private readonly invalidation = new Set<() => void>()
  onClear(listener: () => void): () => void { this.invalidation.add(listener); return () => this.invalidation.delete(listener) }
  private tail: Promise<void> = Promise.resolve()
  private generation = 0
  private readonly backgrounds = new Map<string, Session>()
  constructor(readonly session: Session) {}

  async acquire(): Promise<{ generation: number; release(): void }> {
    const generation = this.generation
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    return { generation, release }
  }

  current(generation: number): boolean { return generation === this.generation }
  clear(): void { this.userWorkState.reset(); this.generation++; this.session.replaceAll([]); for (const listener of this.invalidation) listener() }

  clearBackgrounds(): void { this.backgrounds.clear() }

  background(key: string): Session {
    const existing = this.backgrounds.get(key)
    if (existing) { this.backgrounds.delete(key); this.backgrounds.set(key, existing); return existing }
    const session = new Session({ id: `background:${key}`, label: key, persistent: false, rounds: { ...this.session.rounds }, hardTokens: this.session.hardTokens })
    this.backgrounds.set(key, session)
    while (this.backgrounds.size > 32) this.backgrounds.delete(this.backgrounds.keys().next().value!)
    return session
  }
}
