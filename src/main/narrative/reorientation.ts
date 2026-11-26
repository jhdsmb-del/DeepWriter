import type {
  ReorientationInputV2,
  ReorientationIntentV2,
  ReorientationPlanV2,
  Wp7FeatureFlags
} from '../../shared/narrativeV2'
import { REORIENTATION_SCHEMA_VERSION, resolveWp7FeatureFlags } from '../../shared/narrativeV2'
import { sha256NarrativeV2, stableNarrativeV2Json } from './sceneContractV2'

export const REORIENTATION_MIN_SCENES = 3
export const REORIENTATION_MAX_SCENES = 5
export const REORIENTATION_FUTURE_WINDOW = Object.freeze({
  minScenes: REORIENTATION_MIN_SCENES,
  maxScenes: REORIENTATION_MAX_SCENES
})

function boundedCount(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

function strings(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = clean(raw)
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function hasIntentContent(intent: Partial<ReorientationIntentV2> | null | undefined): boolean {
  if (!intent) return false
  return Boolean(
    clean(intent.sceneFunction) ||
    clean(intent.chapterObjective) ||
    clean(intent.agencyFocus) ||
    clean(intent.pressureToEscalate) ||
    clean(intent.payoffToAdvance) ||
    clean(intent.nextIrreversibleChoice) ||
    strings(intent.avoidRepeating).length > 0
  )
}

function futureIntent(input: ReorientationInputV2): ReorientationIntentV2 | null {
  const chapterObjective = clean(input.chapterObjective)
  const agencyFocus = clean(input.agencyFocus)
  const pressureToEscalate = clean(input.pressureToEscalate)
  const nextIrreversibleChoice = clean(input.nextIrreversibleChoice)
  if (!chapterObjective && !agencyFocus && !pressureToEscalate && !nextIrreversibleChoice && !hasIntentContent(input.priorIntent)) return null
  const previous: Partial<ReorientationIntentV2> = input.priorIntent ?? {}
  return {
    ...(previous.sceneFunction ? { sceneFunction: previous.sceneFunction } : {}),
    chapterObjective: chapterObjective || previous.chapterObjective || '',
    agencyFocus: agencyFocus || previous.agencyFocus || '',
    pressureToEscalate: pressureToEscalate || previous.pressureToEscalate || '',
    payoffToAdvance: input.payoffToAdvance === undefined ? previous.payoffToAdvance ?? null : clean(input.payoffToAdvance) || null,
    nextIrreversibleChoice: nextIrreversibleChoice || previous.nextIrreversibleChoice || '',
    avoidRepeating: input.avoidRepeating === undefined ? strings(previous.avoidRepeating) : strings(input.avoidRepeating)
  }
}

function planWithoutHash(plan: ReorientationPlanV2): Omit<ReorientationPlanV2, 'planHash'> {
  const { planHash: _planHash, ...withoutHash } = plan
  return withoutHash
}

export function reorientationDue(completedSceneCount: number, lastReorientationScene = 0): boolean {
  const completed = boundedCount(completedSceneCount)
  const last = boundedCount(lastReorientationScene)
  return completed - last >= REORIENTATION_MIN_SCENES
}

export function buildReorientationPlan(input: ReorientationInputV2): ReorientationPlanV2 {
  const completed = boundedCount(input.completedSceneCount)
  const last = boundedCount(input.lastReorientationScene)
  const elapsed = Math.max(0, completed - last)
  const scheduled = elapsed >= REORIENTATION_MIN_SCENES
  const sourceSceneIds = Array.isArray(input.sceneIds) ? input.sceneIds.slice(0, completed).map(clean).filter(Boolean) : []
  const sourceSceneHashes = Array.isArray(input.acceptedSceneHashes) ? input.acceptedSceneHashes.slice(0, completed).map(clean).filter(Boolean) : []
  const future = scheduled ? futureIntent(input) : null
  const due = scheduled && future !== null
  const overdue = due && elapsed >= REORIENTATION_MAX_SCENES
  const base = {
    schemaVersion: REORIENTATION_SCHEMA_VERSION,
    due,
    overdue,
    afterScene: completed,
    sourceSceneIds,
    sourceSceneHashes,
    futureWindow: REORIENTATION_FUTURE_WINDOW,
    futureIntent: future,
    inputHash: sha256NarrativeV2(stableNarrativeV2Json({
      storyId: clean(input.storyId),
      chapterId: clean(input.chapterId),
      completedSceneCount: completed,
      lastReorientationScene: last,
      sceneIds: sourceSceneIds,
      acceptedSceneHashes: sourceSceneHashes,
      priorIntent: input.priorIntent ?? null,
      chapterObjective: clean(input.chapterObjective),
      agencyFocus: clean(input.agencyFocus),
      pressureToEscalate: clean(input.pressureToEscalate),
      payoffToAdvance: input.payoffToAdvance === undefined ? null : clean(input.payoffToAdvance),
      nextIrreversibleChoice: clean(input.nextIrreversibleChoice),
      avoidRepeating: strings(input.avoidRepeating)
    }))
  }
  return { ...base, planHash: sha256NarrativeV2(stableNarrativeV2Json(base)) }
}

export const buildDeterministicReorientation = buildReorientationPlan
export const createReorientationPlan = buildReorientationPlan

export function runReorientation(input: ReorientationInputV2, flags?: Partial<Wp7FeatureFlags> | null): ReorientationPlanV2 {
  const resolved = resolveWp7FeatureFlags(flags)
  const plan = buildReorientationPlan(input)
  if (resolved.reorientation) return plan
  const disabled = { ...plan, due: false, overdue: false, futureIntent: null }
  return { ...disabled, planHash: sha256NarrativeV2(stableNarrativeV2Json(planWithoutHash(disabled))) }
}

export interface ReorientationValidation {
  ok: boolean
  errors: string[]
}

export function validateReorientationPlan(plan: unknown): ReorientationValidation {
  const errors: string[] = []
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['reorientation_not_object'] }
  const candidate = plan as Partial<ReorientationPlanV2>
  if (candidate.schemaVersion !== REORIENTATION_SCHEMA_VERSION) errors.push('schema_version_invalid')
  if (!Number.isInteger(candidate.afterScene) || Number(candidate.afterScene) < 0) errors.push('after_scene_invalid')
  if (!Array.isArray(candidate.sourceSceneIds) || !Array.isArray(candidate.sourceSceneHashes)) errors.push('source_snapshot_invalid')
  const futureWindow = candidate.futureWindow
  if (!futureWindow || typeof futureWindow !== 'object' || futureWindow.minScenes !== REORIENTATION_MIN_SCENES || futureWindow.maxScenes !== REORIENTATION_MAX_SCENES) errors.push('future_window_invalid')
  if (candidate.due !== true && candidate.futureIntent !== null) errors.push('future_intent_when_not_due')
  if (candidate.due === true && !candidate.futureIntent) errors.push('future_intent_missing')
  if (candidate.due === true && candidate.futureIntent && !hasIntentContent(candidate.futureIntent)) errors.push('future_intent_empty')
  if (typeof candidate.planHash !== 'string' || candidate.planHash !== sha256NarrativeV2(stableNarrativeV2Json(planWithoutHash(candidate as ReorientationPlanV2)))) errors.push('plan_hash_mismatch')
  return { ok: errors.length === 0, errors: [...new Set(errors)] }
}

export const reorientationPlanValid = (plan: unknown): boolean => validateReorientationPlan(plan).ok
