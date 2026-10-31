export type EvidenceLevel = 'observed' | 'visual' | 'deterministic' | 'user-confirmed'
export interface EvidenceFields {
  postRef?: string | null
  stateRef?: string | null
  preStateRef?: string | null
  expectedStateRef?: string | null
  stateModality?: 'text' | 'value' | 'image' | 'none'
  elementRef?: string | null
  visual?: boolean
}
