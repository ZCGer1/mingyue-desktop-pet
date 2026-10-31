import { createHash } from 'node:crypto'
import type { TaskStep } from './taskTypes'

import type { EvidenceFields, EvidenceLevel } from '../shared/taskEvidence'
export type { EvidenceFields, EvidenceLevel } from '../shared/taskEvidence'
export const stateHash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
export function pageRef(page: { tabId: number; frameId: number; pageId: string } | null): string | null {
  return page && Number.isInteger(page.tabId) && Number.isInteger(page.frameId) && page.pageId
    ? `page:${page.tabId}:${page.frameId}:${stateHash(page.pageId).slice(0, 16)}` : null
}
export function windowRef(process: string, id: string): string {
  return `win:${stateHash(`window:${process}:${id}`).slice(0, 16)}`
}
export function bindable(ref: unknown): ref is string {
  return typeof ref === 'string' && /^(?:path:[a-f0-9]{8,64}|win:[a-f0-9]{8,64}|display:[\w-]{1,64}|page:\d+:\d+:[a-f0-9]{16}|tab:\d+|tabs:[a-f0-9]{16})$/.test(ref)
}
export function related(a: string, b: string): boolean {
  if (!bindable(a) || !bindable(b)) return false
  if (a === b) return true
  const x = /^(?:page|tab):(\d+)(?::(\d+):)?/.exec(a)
  const y = /^(?:page|tab):(\d+)(?::(\d+):)?/.exec(b)
  return x !== null && y !== null && x[1] === y[1] && (x[2] === undefined || y[2] === undefined || x[2] === y[2])
}
export function safeEvidence(raw: unknown): EvidenceFields {
  const r = (raw ?? {}) as Record<string, unknown>
  const hash = (v: unknown): string | null => typeof v === 'string' && /^[a-f0-9]{8,64}$/.test(v) ? v : null
  return {
    postRef: bindable(r.postRef) ? r.postRef : null,
    stateRef: hash(r.stateRef), preStateRef: hash(r.preStateRef), expectedStateRef: hash(r.expectedStateRef),
    stateModality: r.stateModality === 'value' || r.stateModality === 'image' || r.stateModality === 'none' ? r.stateModality : 'text',
    elementRef: typeof r.elementRef === 'string' && /^win:[a-f0-9]{8,64}:element:[a-f0-9]{8,64}$/.test(r.elementRef) ? r.elementRef : null,
    visual: r.visual === true
  }
}
export function verificationLevel(effect: TaskStep, observation: TaskStep): EvidenceLevel {
  const e = safeEvidence(effect), o = safeEvidence(observation)
  if (e.visual || o.visual || e.stateModality === 'image' || o.stateModality === 'image') return 'visual'
  if (e.stateModality !== o.stateModality || e.stateModality === 'none') return 'observed'
  if (e.stateModality === 'value' && (!e.elementRef || e.elementRef !== o.elementRef)) return 'observed'
  if (e.preStateRef && o.stateRef === e.preStateRef) return 'observed'
  const post = e.postRef && observation.targetRef === e.postRef
  const expected = e.expectedStateRef && o.stateRef === e.expectedStateRef
  const readback = e.preStateRef && e.stateRef && e.preStateRef !== e.stateRef && o.stateRef === e.stateRef
  return post || expected || readback ? 'deterministic' : 'observed'
}
