import { createHash } from 'node:crypto'
import type {
  SceneConstraintV2,
  SceneContractV2,
  SceneContractV2Draft,
  SceneContractV2Validation,
  SceneDirectorInputV2,
  SceneFunctionV2,
  SceneSoftIntentV2
} from '../../shared/narrativeV2'
import { SCENE_CONTRACT_V2_SCHEMA_VERSION } from '../../shared/narrativeV2'

const SCENE_FUNCTIONS: readonly SceneFunctionV2[] = [
  'reaction', 'discovery', 'decision', 'confrontation', 'aftermath', 'setup', 'payoff', 'reversal', 'transition', 'other'
]

const HARD_KINDS = new Set<SceneConstraintV2['kind']>(['fact', 'knowledge_boundary', 'timeline', 'forbidden', 'required', 'must_preserve'])
const SOFT_KINDS = new Set<SceneSoftIntentV2['kind']>(['structure', 'pacing', 'tone', 'voice', 'imagery', 'distance', 'advisory'])

function clean(value: unknown, fallback = ''): string {
  const text = String(value ?? fallback).replace(/\s+/gu, ' ').trim()
  return text
}

function optional(value: unknown): string | null {
  const text = clean(value)
  return text || null
}

function list(values: unknown, max = 64): string[] {
  if (!Array.isArray(values)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = clean(raw)
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
    if (result.length >= max) break
  }
  return result
}

function numberOr(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.keys(record).sort().reduce<Record<string, unknown>>((out, key) => {
      const current = record[key]
      if (current !== undefined) out[key] = stableValue(current)
      return out
    }, {})
  }
  return value
}

export function stableNarrativeV2Json(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

export function sha256NarrativeV2(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function sceneContractV2Hash(contract: Omit<SceneContractV2, 'frozenHash'>): string {
  return sha256NarrativeV2(stableNarrativeV2Json(contract))
}

function normalizeConstraint(raw: SceneConstraintV2 | undefined, index: number): SceneConstraintV2 {
  const candidate = raw ?? { id: '', kind: 'required', statement: '' }
  const kind = HARD_KINDS.has(candidate.kind) ? candidate.kind : 'required'
  return {
    id: clean(candidate.id) || `hard-${index + 1}`,
    kind,
    statement: clean(candidate.statement),
    source: candidate.source === undefined ? null : optional(candidate.source)
  }
}

function normalizeSoftIntent(raw: SceneSoftIntentV2 | undefined, index: number): SceneSoftIntentV2 {
  const candidate = raw ?? { id: '', kind: 'advisory', statement: '' }
  const kind = SOFT_KINDS.has(candidate.kind) ? candidate.kind : 'advisory'
  return {
    id: clean(candidate.id) || `soft-${index + 1}`,
    kind,
    statement: clean(candidate.statement),
    ...(Number.isFinite(candidate.priority) ? { priority: Math.max(0, Math.min(100, Number(candidate.priority))) } : {})
  }
}

function draftWithoutHash(contract: SceneContractV2): Omit<SceneContractV2, 'frozenHash'> {
  const { frozenHash: _frozenHash, ...withoutHash } = contract
  return withoutHash
}

function exposeContractAliases(contract: SceneContractV2): SceneContractV2 {
  Object.defineProperties(contract, {
    povWant: { enumerable: false, configurable: false, get: () => contract.desires.pov },
    oppositionWant: { enumerable: false, configurable: false, get: () => contract.desires.opposition },
    tacticsAlreadyFailed: { enumerable: false, configurable: false, get: () => contract.failureStrategies.pov },
    pressureEscalation: { enumerable: false, configurable: false, get: () => contract.escalation.pressure },
    choiceCost: { enumerable: false, configurable: false, get: () => contract.cost.immediate },
    readerCharacterKnowledge: { enumerable: false, configurable: false, get: () => ({ reader: contract.readerStateDelta, characters: contract.characterKnowledgeDelta }) }
  })
  return contract
}

function normalizeInput(input: SceneDirectorInputV2): Omit<SceneContractV2, 'frozenHash'> {
  const desires = input.desires ?? {}
  const failure = input.failureStrategies ?? {}
  const escalation = input.escalation ?? {}
  const choice = input.choice ?? {}
  const cost = input.cost ?? {}
  const turn = input.turn ?? {}
  const shift = input.valueShift ?? {}
  const reader = input.readerStateDelta ?? {}
  const exit = input.exitVector ?? {}
  const functionName = input.sceneFunction && SCENE_FUNCTIONS.includes(input.sceneFunction) ? input.sceneFunction : 'other'
  const hardConstraints = (input.hardConstraints ?? []).map(normalizeConstraint)
  const softIntent = (input.softIntent ?? []).map(normalizeSoftIntent)
  const characterKnowledgeDelta = (input.characterKnowledgeDelta ?? []).map((entry) => ({
    characterId: clean(entry.characterId),
    learns: list(entry.learns),
    ...(Array.isArray(entry.forgets) ? { forgets: list(entry.forgets) } : {}),
    ...(Array.isArray(entry.remainsUnknown) ? { remainsUnknown: list(entry.remainsUnknown) } : {})
  }))
  return {
    schemaVersion: SCENE_CONTRACT_V2_SCHEMA_VERSION,
    contractId: clean(input.contractId) || `contract:${clean(input.sceneId)}`,
    sceneId: clean(input.sceneId),
    revision: numberOr(input.revision, 1),
    sceneFunction: functionName,
    povCharacterId: input.povCharacterId === undefined ? null : optional(input.povCharacterId),
    entrySituation: clean(input.entrySituation),
    dramaticQuestion: clean(input.dramaticQuestion),
    desires: {
      pov: clean(input.povDesire ?? input.povWant ?? desires.pov),
      opposition: clean(input.oppositionDesire ?? input.oppositionWant ?? desires.opposition),
      hiddenNeed: desires.hiddenNeed === undefined ? null : optional(desires.hiddenNeed)
    },
    failureStrategies: {
      pov: list(input.tacticsAlreadyFailed ?? failure.pov),
      opposition: list(failure.opposition)
    },
    escalation: {
      pressure: clean(input.pressureEscalation ?? escalation.pressure),
      stakes: escalation.stakes === undefined ? null : optional(escalation.stakes),
      irreversibleIfIgnored: escalation.irreversibleIfIgnored === undefined ? null : optional(escalation.irreversibleIfIgnored)
    },
    choice: {
      actor: clean(choice.actor),
      action: clean(choice.action),
      alternatives: Array.isArray(choice.alternatives) ? list(choice.alternatives) : [],
      irreversible: choice.irreversible === true
    },
    cost: {
      payer: clean(cost.payer),
      immediate: clean(input.choiceCost ?? cost.immediate),
      lasting: cost.lasting === undefined ? null : optional(cost.lasting)
    },
    turn: {
      from: clean(turn.from),
      to: clean(turn.to),
      trigger: turn.trigger === undefined ? null : optional(turn.trigger)
    },
    valueShift: { from: clean(shift.from), to: clean(shift.to) },
    revelationAndInterpretation: clean(input.revelationAndInterpretation),
    readerStateDelta: {
      before: list(reader.before ?? input.readerCharacterKnowledge?.reader.before),
      after: list(reader.after ?? input.readerCharacterKnowledge?.reader.after)
    },
    characterKnowledgeDelta: input.readerCharacterKnowledge?.characters ?? characterKnowledgeDelta,
    relationshipDelta: (input.relationshipDelta ?? []).map((entry) => ({
      relationship: clean(entry.relationship),
      from: clean(entry.from),
      to: clean(entry.to)
    })),
    threadsToAdvance: list(input.threadsToAdvance),
    threadsNotToResolve: list(input.threadsNotToResolve),
    exitVector: {
      unresolvedQuestion: clean(exit.unresolvedQuestion),
      nextPressure: clean(exit.nextPressure),
      requiredDirection: exit.requiredDirection === undefined ? null : optional(exit.requiredDirection),
      forbiddenResolution: exit.forbiddenResolution === undefined ? null : optional(exit.forbiddenResolution)
    },
    hardConstraints,
    softIntent,
    sourceHash: input.sourceHash === undefined ? null : optional(input.sourceHash)
  }
}

export function buildSceneContractV2(input: SceneDirectorInputV2): SceneContractV2 {
  const withoutHash = normalizeInput(input)
  return exposeContractAliases({ ...withoutHash, frozenHash: sceneContractV2Hash(withoutHash) })
}

export const buildDeterministicSceneContractV2 = buildSceneContractV2
export const buildSceneDirectorContractV2 = buildSceneContractV2
export const buildDeterministicDirector = buildSceneContractV2

export function validateSceneContractV2(contract: unknown): SceneContractV2Validation {
  const errors: string[] = []
  if (!contract || typeof contract !== 'object') {
    return { ok: false, errors: ['contract_not_object'], hardCount: 0, softCount: 0, hashValid: false }
  }
  const candidate = contract as Partial<SceneContractV2>
  if (candidate.schemaVersion !== SCENE_CONTRACT_V2_SCHEMA_VERSION) errors.push('schema_version_invalid')
  if (typeof candidate.contractId !== 'string' || !candidate.contractId.trim()) errors.push('contract_id_missing')
  if (typeof candidate.sceneId !== 'string' || !candidate.sceneId.trim()) errors.push('scene_id_missing')
  if (!Number.isInteger(candidate.revision) || Number(candidate.revision) < 1) errors.push('revision_invalid')
  if (!candidate.sceneFunction || !SCENE_FUNCTIONS.includes(candidate.sceneFunction)) errors.push('scene_function_invalid')
  const requiredStrings: Array<keyof SceneContractV2> = [
    'entrySituation', 'dramaticQuestion', 'revelationAndInterpretation'
  ]
  for (const key of requiredStrings) if (typeof candidate[key] !== 'string' || !candidate[key]?.trim()) errors.push(`${key}_missing`)
  const objectFields: Array<keyof SceneContractV2> = ['desires', 'failureStrategies', 'escalation', 'choice', 'cost', 'turn', 'valueShift', 'readerStateDelta', 'exitVector']
  for (const key of objectFields) if (!candidate[key] || typeof candidate[key] !== 'object') errors.push(`${key}_missing`)
  const hard = Array.isArray(candidate.hardConstraints) ? candidate.hardConstraints : []
  const soft = Array.isArray(candidate.softIntent) ? candidate.softIntent : []
  if (!Array.isArray(candidate.hardConstraints)) errors.push('hard_constraints_missing')
  if (!Array.isArray(candidate.softIntent)) errors.push('soft_intent_missing')
  const hardIds = new Set<string>()
  const hardStatements = new Set<string>()
  for (const item of hard) {
    if (!item || typeof item !== 'object') {
      errors.push('hard_constraint_invalid')
      continue
    }
    const row = item as SceneConstraintV2
    if (!row.id || typeof row.id !== 'string' || hardIds.has(row.id)) errors.push('hard_constraint_id_invalid')
    hardIds.add(row.id)
    if (!HARD_KINDS.has(row.kind)) errors.push('hard_constraint_kind_invalid')
    if (!row.statement || typeof row.statement !== 'string') errors.push('hard_constraint_statement_missing')
    hardStatements.add(clean(row.statement).toLocaleLowerCase())
  }
  const softIds = new Set<string>()
  for (const item of soft) {
    if (!item || typeof item !== 'object') {
      errors.push('soft_intent_invalid')
      continue
    }
    const row = item as SceneSoftIntentV2
    if (!row.id || typeof row.id !== 'string' || softIds.has(row.id) || hardIds.has(row.id)) errors.push('hard_soft_id_overlap')
    softIds.add(row.id)
    if (!SOFT_KINDS.has(row.kind)) errors.push('soft_intent_kind_invalid')
    if (!row.statement || typeof row.statement !== 'string') errors.push('soft_intent_statement_missing')
    if (hardStatements.has(clean(row.statement).toLocaleLowerCase())) errors.push('hard_soft_statement_overlap')
  }
  const hashValid = typeof candidate.frozenHash === 'string' && candidate.frozenHash === sceneContractV2Hash(draftWithoutHash(candidate as SceneContractV2))
  if (!hashValid) errors.push('contract_hash_mismatch')
  return { ok: errors.length === 0, errors: [...new Set(errors)], hardCount: hard.length, softCount: soft.length, hashValid }
}

export const sceneContractV2Valid = (contract: unknown): boolean => validateSceneContractV2(contract).ok
export const validateSceneDirectorContractV2 = validateSceneContractV2
export const sceneDirectorContractV2Valid = sceneContractV2Valid

export function assertSceneContractV2(contract: unknown): asserts contract is SceneContractV2 {
  const result = validateSceneContractV2(contract)
  if (!result.ok) throw new Error(`scene_contract_v2_invalid:${result.errors.join(',')}`)
}

export function contractV2WithoutHash(contract: SceneContractV2): Omit<SceneContractV2, 'frozenHash'> {
  return draftWithoutHash(contract)
}

export function buildSceneContractV2FromDraft(draft: SceneContractV2Draft): SceneContractV2 {
  const base = draft as SceneDirectorInputV2
  return buildSceneContractV2(base)
}
