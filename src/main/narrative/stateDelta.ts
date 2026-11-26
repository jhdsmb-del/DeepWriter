import { createHash } from 'node:crypto'
import type {
  NarrativeCharacterStateChange,
  NarrativeForeshadowChange,
  NarrativeKnowledgeChange,
  NarrativeFactReference,
  NarrativeLedgerChangeKind,
  NarrativeObjectStateChange,
  NarrativeRelationshipChange,
  NarrativeStateChange,
  NarrativeStateDelta,
  NarrativeSemanticRole,
  SceneBeatActuality,
  SceneBeatAssertion,
  NarrativeTimelineEventChange
} from '../../shared/types'

const HASH_RE = /^[0-9a-f]{64}$/u
const MAX_CHANGES = 256
const MAX_TEXT = 4000
const CHANGE_KINDS: readonly NarrativeLedgerChangeKind[] = [
  'timeline_event',
  'character_state',
  'object_state',
  'relationship',
  'knowledge',
  'foreshadow'
]
const SEMANTIC_ROLES: readonly NarrativeSemanticRole[] = ['agent', 'patient', 'source', 'recipient', 'beneficiary']
const SCENE_BEAT_ACTUALITIES: readonly SceneBeatActuality[] = [
  'asserted_actual', 'negated', 'planned', 'reported', 'remembered', 'dreamed',
  'conditional', 'imperative', 'requested', 'attempted', 'near_miss', 'pretended',
  'quoted', 'refused', 'proposed', 'questioned', 'threatened', 'unknown'
]
const SCENE_BEAT_ASSERTIONS: readonly SceneBeatAssertion[] = ['asserted', 'negated', 'non_asserted', 'unknown']

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, stableValue(object[key])]))
  }
  return value
}

export function stableNarrativeJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function orderedChanges(changes: readonly NarrativeStateChange[]): NarrativeStateChange[] {
  return [...changes].sort((a, b) => a.revision - b.revision || a.changeId.localeCompare(b.changeId))
}

function deltaHashInput(delta: Omit<NarrativeStateDelta, 'deltaHash'> | NarrativeStateDelta): Omit<NarrativeStateDelta, 'deltaHash'> {
  const { deltaHash: _ignored, changes, ...base } = delta as NarrativeStateDelta
  return { ...base, changes: orderedChanges(changes) }
}

export function narrativeStateDeltaHash(delta: Omit<NarrativeStateDelta, 'deltaHash'> | NarrativeStateDelta): string {
  return createHash('sha256').update(stableNarrativeJson(deltaHashInput(delta)), 'utf8').digest('hex')
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0) || value.length > MAX_TEXT) throw new Error(`narrative_state_delta_${field}_invalid`)
  return value
}

function id(value: unknown, field: string): string {
  const result = text(value, field, false)
  if (result.length > 240) throw new Error(`narrative_state_delta_${field}_invalid`)
  return result
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  return text(value, field)
}

function stringList(value: unknown, field: string, max = 64): string[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value) || value.length > max) throw new Error(`narrative_state_delta_${field}_invalid`)
  return value.map((entry) => id(entry, field))
}

function timeValue(value: unknown, field: string): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return text(value, field)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error(`narrative_state_delta_${field}_invalid`)
}

function probability(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`narrative_state_delta_${field}_invalid`)
  return value
}

function numberOrText(value: unknown, field: string): number | string {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return text(value, field)
}

function parseFactReference(value: unknown): NarrativeFactReference | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('narrative_state_delta_fact_reference_invalid')
  const input = value as Record<string, unknown>
  if (typeof input.factId !== 'string' || input.factId.trim().length === 0 || input.factId.length > 240 ||
    typeof input.version !== 'number' || !Number.isInteger(input.version) || input.version < 1 ||
    typeof input.canonicalStatement !== 'string' || input.canonicalStatement.trim().length === 0 || input.canonicalStatement.length > 8000 ||
    typeof input.canonicalHash !== 'string' || !HASH_RE.test(input.canonicalHash) ||
    typeof input.provenanceHash !== 'string' || !HASH_RE.test(input.provenanceHash)) {
    throw new Error('narrative_state_delta_fact_reference_invalid')
  }
  const canonicalStatement = input.canonicalStatement.trim()
  const canonicalHash = createHash('sha256').update(canonicalStatement, 'utf8').digest('hex')
  if (canonicalHash !== input.canonicalHash) throw new Error('narrative_state_delta_fact_reference_hash_mismatch')
  return {
    factId: input.factId.trim(),
    version: input.version,
    canonicalStatement,
    canonicalHash: input.canonicalHash,
    provenanceHash: input.provenanceHash
  }
}

function baseChange(value: unknown, delta: NarrativeStateDelta): NarrativeStateChangeBaseLike {
  if (!value || typeof value !== 'object') throw new Error('narrative_state_delta_change_invalid')
  const change = value as Record<string, unknown>
  const kind = change.kind
  if (!CHANGE_KINDS.includes(kind as NarrativeLedgerChangeKind)) throw new Error('narrative_state_delta_kind_invalid')
  const result = {
    changeId: id(change.changeId, 'change_id'),
    revision: change.revision as number,
    kind: kind as NarrativeLedgerChangeKind,
    entityId: id(change.entityId, 'entity_id'),
    runId: id(change.runId, 'run_id'),
    sceneId: id(change.sceneId, 'scene_id'),
    acceptedSegmentId: id(change.acceptedSegmentId, 'accepted_segment_id'),
    acceptedContentHash: id(change.acceptedContentHash, 'accepted_content_hash'),
    contractHash: id(change.contractHash, 'contract_hash')
  }
  if (!Number.isInteger(result.revision) || (result.revision as number) < 1) throw new Error('narrative_state_delta_revision_invalid')
  if (!HASH_RE.test(result.acceptedContentHash) || !HASH_RE.test(result.contractHash)) throw new Error('narrative_state_delta_binding_invalid')
  if (result.runId !== delta.runId || result.sceneId !== delta.sceneId || result.acceptedSegmentId !== delta.acceptedSegmentId || result.acceptedContentHash !== delta.acceptedContentHash || result.contractHash !== delta.contractHash) {
    throw new Error('narrative_state_delta_binding_mismatch')
  }
  return result
}

interface NarrativeStateChangeBaseLike {
  changeId: string
  revision: number
  kind: NarrativeLedgerChangeKind
  entityId: string
  runId: string
  sceneId: string
  acceptedSegmentId: string
  acceptedContentHash: string
  contractHash: string
}

function parseChange(value: unknown, delta: NarrativeStateDelta): NarrativeStateChange {
  const base = baseChange(value, delta)
  const change = value as Record<string, unknown>
  if (base.kind === 'timeline_event') {
    const result: NarrativeTimelineEventChange = {
      ...base,
      kind: 'timeline_event',
      eventType: text(change.eventType, 'event_type'),
      actorIds: stringList(change.actorIds, 'actor_ids'),
      objectIds: stringList(change.objectIds, 'object_ids'),
      locationId: nullableText(change.locationId, 'location_id'),
      storyTime: timeValue(change.storyTime, 'story_time'),
      causeEventIds: stringList(change.causeEventIds, 'cause_event_ids'),
      consequenceEventIds: stringList(change.consequenceEventIds, 'consequence_event_ids'),
      summary: text(change.summary, 'summary'),
      ...(change.actuality === undefined ? {} : { actuality: change.actuality as SceneBeatActuality }),
      ...(change.assertion === undefined ? {} : { assertion: change.assertion as SceneBeatAssertion }),
      ...(change.unknownRoles === undefined ? {} : { unknownRoles: stringList(change.unknownRoles, 'unknown_roles', 5) as NarrativeSemanticRole[] })
    }
    if (result.actuality !== undefined && !SCENE_BEAT_ACTUALITIES.includes(result.actuality)) throw new Error('narrative_state_delta_actuality_invalid')
    if (result.assertion !== undefined && !SCENE_BEAT_ASSERTIONS.includes(result.assertion)) throw new Error('narrative_state_delta_assertion_invalid')
    if (result.unknownRoles?.some((role) => !SEMANTIC_ROLES.includes(role))) throw new Error('narrative_state_delta_unknown_role_invalid')
    return result
  }
  if (base.kind === 'character_state') {
    const result: NarrativeCharacterStateChange = {
      ...base,
      kind: 'character_state',
      characterId: id(change.characterId, 'character_id'),
      status: nullableText(change.status, 'status'),
      locationId: nullableText(change.locationId, 'location_id'),
      goals: stringList(change.goals, 'goals'),
      physicalState: nullableText(change.physicalState, 'physical_state'),
      emotionalBaseline: nullableText(change.emotionalBaseline, 'emotional_baseline')
    }
    return result
  }
  if (base.kind === 'object_state') {
    const result: NarrativeObjectStateChange = {
      ...base,
      kind: 'object_state',
      objectId: id(change.objectId, 'object_id'),
      ownerId: nullableText(change.ownerId, 'owner_id'),
      holderId: nullableText(change.holderId, 'holder_id'),
      holderStatus: change.holderStatus === undefined ? undefined : change.holderStatus as NarrativeObjectStateChange['holderStatus'],
      locationId: nullableText(change.locationId, 'location_id'),
      condition: nullableText(change.condition, 'condition')
    }
    if (result.holderStatus !== undefined && !['known', 'unknown', 'pending_review'].includes(result.holderStatus)) throw new Error('narrative_state_delta_holder_status_invalid')
    return result
  }
  if (base.kind === 'relationship') {
    const result: NarrativeRelationshipChange = {
      ...base,
      kind: 'relationship',
      fromCharacterId: id(change.fromCharacterId, 'from_character_id'),
      toCharacterId: id(change.toCharacterId, 'to_character_id'),
      dimension: text(change.dimension, 'dimension'),
      value: numberOrText(change.value, 'value'),
      reason: text(change.reason, 'reason')
    }
    return result
  }
  if (base.kind === 'knowledge') {
    const factRef = parseFactReference(change.factRef)
    const result: NarrativeKnowledgeChange = {
      ...base,
      kind: 'knowledge',
      factId: id(change.factId, 'fact_id'),
      knowerId: id(change.knowerId, 'knower_id'),
      stance: change.stance as NarrativeKnowledgeChange['stance'],
      certainty: probability(change.certainty, 'certainty'),
      sourceSceneId: id(change.sourceSceneId, 'source_scene_id'),
      effectiveTime: timeValue(change.effectiveTime, 'effective_time'),
      confidence: probability(change.confidence, 'confidence'),
      ...(factRef ? { factRef } : {})
    }
    if (factRef && factRef.factId !== result.factId) throw new Error('narrative_state_delta_fact_reference_mismatch')
    if (!['knows', 'believes', 'disbelieves', 'unknown'].includes(result.stance)) throw new Error('narrative_state_delta_stance_invalid')
    if (result.sourceSceneId !== delta.sceneId) throw new Error('narrative_state_delta_source_scene_mismatch')
    return result
  }
  const result: NarrativeForeshadowChange = {
    ...base,
    kind: 'foreshadow',
    threadId: id(change.threadId, 'thread_id'),
    lifecycle: change.lifecycle as NarrativeForeshadowChange['lifecycle'],
    reason: nullableText(change.reason, 'reason'),
    setupChangeId: nullableText(change.setupChangeId, 'setup_change_id'),
    payoffChangeId: nullableText(change.payoffChangeId, 'payoff_change_id')
  }
  if (!['open', 'advanced', 'delayed', 'resolved', 'abandoned'].includes(result.lifecycle)) throw new Error('narrative_state_delta_lifecycle_invalid')
  return result
}

export function normalizeNarrativeStateDelta(value: unknown): NarrativeStateDelta {
  if (!value || typeof value !== 'object') throw new Error('narrative_state_delta_invalid')
  const input = value as Record<string, unknown>
  const delta = {
    schemaVersion: input.schemaVersion,
    runId: id(input.runId, 'run_id'),
    sceneId: id(input.sceneId, 'scene_id'),
    acceptedSegmentId: id(input.acceptedSegmentId, 'accepted_segment_id'),
    acceptedContentHash: id(input.acceptedContentHash, 'accepted_content_hash'),
    contractHash: id(input.contractHash, 'contract_hash'),
    changes: input.changes,
    deltaHash: id(input.deltaHash, 'delta_hash')
  } as unknown as NarrativeStateDelta
  if (delta.schemaVersion !== 1 || !HASH_RE.test(delta.acceptedContentHash) || !HASH_RE.test(delta.contractHash) || !HASH_RE.test(delta.deltaHash)) throw new Error('narrative_state_delta_header_invalid')
  if (!Array.isArray(delta.changes) || delta.changes.length > MAX_CHANGES) throw new Error('narrative_state_delta_changes_invalid')
  const changes = delta.changes.map((change) => parseChange(change, delta))
  const ids = new Set<string>()
  for (const change of changes) {
    if (ids.has(change.changeId)) throw new Error('narrative_state_delta_duplicate_change')
    ids.add(change.changeId)
  }
  const normalized = { ...delta, changes: orderedChanges(changes) }
  if (narrativeStateDeltaHash(normalized) !== normalized.deltaHash) throw new Error('narrative_state_delta_hash_mismatch')
  return normalized
}

export function buildNarrativeStateDelta(input: Omit<NarrativeStateDelta, 'deltaHash'>): NarrativeStateDelta {
  const delta = { ...input, changes: orderedChanges(input.changes) }
  return { ...delta, deltaHash: narrativeStateDeltaHash(delta) }
}

export function buildEmptyNarrativeStateDelta(input: {
  runId: string
  sceneId: string
  acceptedSegmentId: string
  acceptedContentHash: string
  contractHash: string
}): NarrativeStateDelta {
  return buildNarrativeStateDelta({ schemaVersion: 1, ...input, changes: [] })
}
