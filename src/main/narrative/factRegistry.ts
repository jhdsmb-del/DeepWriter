import { createHash } from 'node:crypto'
import type { NarrativeFact, NarrativeFactReference, NarrativeFactSource, NarrativeFactStatus, NarrativeFactVisibility } from '../../shared/types'
import { stableNarrativeJson } from './stateDelta'

const HASH_RE = /^[0-9a-f]{64}$/u
const MAX_STATEMENT = 8000
const MAX_ALIASES = 32
const MAX_ENTITIES = 64
const MAX_SOURCES = 32

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function requiredText(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new Error(`narrative_fact_${field}_invalid`)
  return value.trim()
}

function optionalTime(value: unknown, field: string): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0 && value.length <= 128) return value.trim()
  throw new Error(`narrative_fact_${field}_invalid`)
}

function probability(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`narrative_fact_${field}_invalid`)
  return value
}

function idList(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`narrative_fact_${field}_invalid`)
  const output = value.map((item) => requiredText(item, field, 512))
  if (new Set(output).size !== output.length) throw new Error(`narrative_fact_${field}_duplicate`)
  return output
}

function source(value: unknown): NarrativeFactSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('narrative_fact_source_invalid')
  const item = value as Record<string, unknown>
  if (!['answer', 'scene', 'segment', 'user'].includes(String(item.sourceType))) throw new Error('narrative_fact_source_invalid')
  const sourceRevision = item.sourceRevision === null || item.sourceRevision === undefined
    ? null
    : (Number.isInteger(item.sourceRevision) && Number(item.sourceRevision) >= 1 ? Number(item.sourceRevision) : (() => { throw new Error('narrative_fact_source_revision_invalid') })())
  const sourceSlotId = item.sourceSlotId === null || item.sourceSlotId === undefined ? null : requiredText(item.sourceSlotId, 'source_slot_id', 240)
  const sourceHash = requiredText(item.sourceHash, 'source_hash', 64)
  if (!HASH_RE.test(sourceHash)) throw new Error('narrative_fact_source_hash_invalid')
  return {
    sourceType: item.sourceType as NarrativeFactSource['sourceType'],
    sourceId: requiredText(item.sourceId, 'source_id', 512),
    ...(sourceSlotId ? { sourceSlotId } : { sourceSlotId: null }),
    ...(sourceRevision === null ? { sourceRevision: null } : { sourceRevision }),
    sourceHash
  }
}

function provenancePayload(fact: Omit<NarrativeFact, 'provenanceHash' | 'createdAt' | 'updatedAt' | 'runId'> & { runId?: string | null }): Record<string, unknown> {
  return {
    schemaVersion: fact.schemaVersion,
    factId: fact.factId,
    version: fact.version,
    sessionId: fact.sessionId,
    canonicalStatement: fact.canonicalStatement,
    canonicalHash: fact.canonicalHash,
    aliases: fact.aliases,
    entities: fact.entities,
    sourceSlotIds: fact.sourceSlotIds,
    sources: fact.sources,
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    confidence: fact.confidence,
    visibility: fact.visibility,
    knowers: fact.knowers
  }
}

export function narrativeFactProvenanceHash(fact: Omit<NarrativeFact, 'provenanceHash' | 'createdAt' | 'updatedAt'>): string {
  return hashText(stableNarrativeJson(provenancePayload(fact)))
}

/** Validate a fact at every DB/context boundary; malformed facts are never injected. */
export function validateNarrativeFact(value: unknown): NarrativeFact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('narrative_fact_invalid')
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1 || !Number.isInteger(input.version) || Number(input.version) < 1) throw new Error('narrative_fact_header_invalid')
  const factId = requiredText(input.factId, 'fact_id', 240)
  const sessionId = requiredText(input.sessionId, 'session_id', 240)
  const runId = input.runId === null || input.runId === undefined ? null : requiredText(input.runId, 'run_id', 240)
  const canonicalStatement = requiredText(input.canonicalStatement, 'canonical_statement', MAX_STATEMENT)
  const canonicalHash = requiredText(input.canonicalHash, 'canonical_hash', 64)
  if (!HASH_RE.test(canonicalHash) || canonicalHash !== hashText(canonicalStatement)) throw new Error('narrative_fact_canonical_hash_mismatch')
  const aliases = idList(input.aliases, 'aliases', MAX_ALIASES)
  const entities = idList(input.entities, 'entities', MAX_ENTITIES)
  const sourceSlotIds = idList(input.sourceSlotIds, 'source_slot_ids', MAX_SOURCES)
  if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > MAX_SOURCES) throw new Error('narrative_fact_sources_invalid')
  const sources = input.sources.map(source)
  const sourceIds = new Set<string>()
  for (const item of sources) {
    if (sourceIds.has(item.sourceId)) throw new Error('narrative_fact_source_duplicate')
    sourceIds.add(item.sourceId)
  }
  const validFrom = optionalTime(input.validFrom, 'valid_from')
  const validUntil = optionalTime(input.validUntil, 'valid_until')
  const status = input.status as NarrativeFactStatus
  const visibility = input.visibility as NarrativeFactVisibility
  if (!['active', 'superseded', 'retracted', 'pending_review'].includes(status)) throw new Error('narrative_fact_status_invalid')
  if (!['public', 'restricted', 'private'].includes(visibility)) throw new Error('narrative_fact_visibility_invalid')
  const knowers = idList(input.knowers, 'knowers', MAX_ENTITIES)
  const fact: NarrativeFact = {
    schemaVersion: 1,
    factId,
    version: Number(input.version),
    sessionId,
    runId,
    canonicalStatement,
    canonicalHash,
    aliases,
    entities,
    sourceSlotIds,
    sources,
    validFrom,
    validUntil,
    confidence: probability(input.confidence, 'confidence'),
    status,
    visibility,
    knowers,
    provenanceHash: requiredText(input.provenanceHash, 'provenance_hash', 64),
    createdAt: typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) ? input.createdAt : (() => { throw new Error('narrative_fact_created_at_invalid') })(),
    updatedAt: typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? input.updatedAt : (() => { throw new Error('narrative_fact_updated_at_invalid') })()
  }
  if (!HASH_RE.test(fact.provenanceHash) || fact.provenanceHash !== narrativeFactProvenanceHash(fact)) throw new Error('narrative_fact_provenance_mismatch')
  return fact
}

export function narrativeFactReference(fact: NarrativeFact): NarrativeFactReference {
  const valid = validateNarrativeFact(fact)
  return {
    factId: valid.factId,
    version: valid.version,
    canonicalStatement: valid.canonicalStatement,
    canonicalHash: valid.canonicalHash,
    provenanceHash: valid.provenanceHash
  }
}

export function validateNarrativeFactReference(value: unknown): NarrativeFactReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('narrative_fact_reference_invalid')
  const input = value as Record<string, unknown>
  const factId = requiredText(input.factId, 'reference_fact_id', 240)
  const canonicalStatement = requiredText(input.canonicalStatement, 'reference_statement', MAX_STATEMENT)
  const canonicalHash = requiredText(input.canonicalHash, 'reference_hash', 64)
  const provenanceHash = requiredText(input.provenanceHash, 'reference_provenance_hash', 64)
  if (!HASH_RE.test(canonicalHash) || canonicalHash !== hashText(canonicalStatement) || !HASH_RE.test(provenanceHash) || !Number.isInteger(input.version) || Number(input.version) < 1) throw new Error('narrative_fact_reference_invalid')
  return { factId, version: Number(input.version), canonicalStatement, canonicalHash, provenanceHash }
}

export function factReferenceMatches(fact: NarrativeFact, reference: NarrativeFactReference): boolean {
  try {
    const ref = validateNarrativeFactReference(reference)
    return fact.factId === ref.factId && fact.version === ref.version && fact.canonicalHash === ref.canonicalHash && fact.canonicalStatement === ref.canonicalStatement && fact.provenanceHash === ref.provenanceHash
  } catch {
    return false
  }
}

export function narrativeFactRegistryHash(facts: readonly NarrativeFact[]): string {
  return hashText(stableNarrativeJson([...facts].sort((a, b) => a.factId.localeCompare(b.factId) || a.version - b.version).map((fact) => ({
    factId: fact.factId,
    version: fact.version,
    canonicalHash: fact.canonicalHash,
    provenanceHash: fact.provenanceHash,
    status: fact.status
  }))))
}

export interface GrillAnswerForFact {
  slotId: string
  value: string
  source?: string | null
}

/**
 * Compile confirmed Grill Me answers into stable facts.  The identity is
 * session+slot based, while the canonical/provenance hashes make edits a new
 * version instead of silently changing an old fact.  No model inference is
 * performed here; empty answers and unconfirmed assumptions are excluded or
 * marked pending_review by the caller's source value.
 */
export function buildNarrativeFactsFromGrill(input: { sessionId: string; runId?: string | null; answers: readonly GrillAnswerForFact[]; originalTask?: string; now?: number }): NarrativeFact[] {
  const sessionId = requiredText(input.sessionId, 'session_id', 240)
  const now = input.now ?? Date.now()
  if (!Number.isFinite(now)) throw new Error('narrative_fact_timestamp_invalid')
  const latest = new Map<string, GrillAnswerForFact>()
  for (const answer of input.answers) {
    const slotId = requiredText(answer.slotId, 'source_slot_id', 240)
    const value = typeof answer.value === 'string' ? answer.value.trim() : ''
    if (!value) continue
    if (value.length > MAX_STATEMENT) throw new Error('narrative_fact_canonical_statement_invalid')
    latest.set(slotId, { slotId, value, source: answer.source ?? 'user' })
  }
  // New marked intakes may cite the frozen author request itself. This is a
  // source reference, not a model-inferred event or an in-story knowledge edge.
  // Old callers opt into nothing and retain their existing registry identity.
  if (input.originalTask?.trim()) {
    const value = requiredText(input.originalTask, 'canonical_statement', MAX_STATEMENT)
    latest.set('original_task', { slotId: 'original_task', value, source: 'task' })
  }
  return [...latest.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([slotId, answer]) => {
    const canonicalStatement = answer.value
    const canonicalHash = hashText(canonicalStatement)
    const factId = `fact_${hashText(`${sessionId}\u0000${slotId}`).slice(0, 32)}`
    const taskSource = slotId === 'original_task' && Boolean(input.originalTask?.trim())
    const sourceId = taskSource ? `grill-task:${sessionId}:original_task` : `grill-answer:${sessionId}:${slotId}`
    const sources: NarrativeFactSource[] = [{ sourceType: taskSource ? 'user' : 'answer', sourceId, sourceSlotId: slotId, sourceRevision: 1, sourceHash: canonicalHash }]
    const source = String(answer.source ?? 'user')
    // Grill Me's canonical state has a small, closed source vocabulary.  An
    // old/foreign payload may still carry `unknown`; never promote that value
    // into authoritative story state merely because it has text.
    const trustedSource = ['user', 'option', 'task', 'final_check', 'not_applicable'].includes(source)
    const status: NarrativeFactStatus = source === 'assumption' || !trustedSource ? 'pending_review' : 'active'
    const base: Omit<NarrativeFact, 'provenanceHash' | 'createdAt' | 'updatedAt'> = {
      schemaVersion: 1,
      factId,
      version: 1,
      sessionId,
      runId: input.runId ?? null,
      canonicalStatement,
      canonicalHash,
      aliases: [],
      entities: [],
      sourceSlotIds: [slotId],
      sources,
      validFrom: null,
      validUntil: null,
      confidence: source === 'user' || source === 'option' ? 1 : source === 'task' ? 0.9 : 0.7,
      status,
      visibility: 'public',
      knowers: []
    }
    const fact = { ...base, provenanceHash: narrativeFactProvenanceHash(base), createdAt: now, updatedAt: now }
    return validateNarrativeFact(fact)
  })
}

/** A required SceneContract id may be either a fact id or its Grill source slot. */
export function factMatchesRequiredId(fact: NarrativeFact, requiredId: string): boolean {
  return fact.factId === requiredId || fact.sourceSlotIds.includes(requiredId) || fact.sources.some((source) => source.sourceSlotId === requiredId)
}
