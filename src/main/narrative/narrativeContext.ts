import { createHash } from 'node:crypto'
import type {
  NarrativeCharacterStateChange,
  NarrativeForeshadowChange,
  NarrativeKnowledgeChange,
  NarrativeLedgerEntry,
  NarrativeLedgerScope,
  NarrativeObjectStateChange,
  NarrativeRelationshipChange,
  NarrativeStateChange,
  NarrativeTimelineEventChange,
  SceneContract,
  NarrativeFact
} from '../../shared/types'
import type { ContextMode } from '../../shared/contextV2'
import { estimateTokens } from '../../shared/types'
import { stableNarrativeJson } from './stateDelta'
import { factMatchesRequiredId, narrativeFactRegistryHash, validateNarrativeFact } from './factRegistry'

/**
 * P3-B is deliberately a small, deterministic projection.  It consumes only
 * committed ledger rows and an already frozen SceneContract.  There is no
 * model extractor and no prose-to-fact inference in this module.
 */

export type NarrativeContextSectionKind =
  | 'recent_prose'
  | 'current_scene'
  | 'active_characters'
  | 'knowledge'
  | 'open_foreshadow'
  | 'recent_events'
  | 'world_state'

export const NARRATIVE_CONTEXT_SECTION_ORDER: readonly NarrativeContextSectionKind[] = [
  'recent_prose',
  'current_scene',
  'active_characters',
  'knowledge',
  'open_foreshadow',
  'recent_events',
  'world_state'
]

export type NarrativeContextProvenance =
  | {
      sourceType: 'ledger'
      runId: string
      sceneId: string
      acceptedSegmentId: string
      acceptedContentHash: string
      contractHash: string
      changeId: string
      revision: number
      deltaHash: string
      storyId?: string
      projectId?: string
      branchId?: string
      storyRevision?: number
    }
  | {
      sourceType: 'scene_contract'
      contractId: string
      sceneId: string
      sectionId: string
      contractHash: string
      outlineHash: string
      revision: number
    }
  | {
    sourceType: 'accepted_segment'
      runId: string
      sceneId: string
      acceptedSegmentId: string
      acceptedContentHash: string
      /** Every prose row admitted to the manifest must carry a durable contract binding. */
      contractHash: string
      revision: number | null
    }
  | {
      sourceType: 'fact_registry'
      sessionId: string
      runId: string | null
      factId: string
      version: number
      revision: number
      canonicalHash: string
      provenanceHash: string
    }

export interface NarrativeContextBudget {
  maxChars: number
  maxTokens: number
  sectionMaxChars?: Partial<Record<NarrativeContextSectionKind, number>>
  sectionMaxTokens?: Partial<Record<NarrativeContextSectionKind, number>>
}

export interface NarrativeContextRecentProse {
  segmentId: string
  runId: string
  sceneId: string
  content: string
  contentHash: string
  /** The frozen contract (or the ledger commit) that authorizes this segment. */
  contractHash: string
  revision?: number | null
}

export interface NarrativeContextItem {
  itemId: string
  section: NarrativeContextSectionKind
  /** JSON-safe structured payload; never a model-generated summary. */
  data: Record<string, unknown>
  provenance: NarrativeContextProvenance[]
  contentHash: string
  charCount: number
  estimatedTokens: number
}

export interface NarrativeContextSectionManifest {
  section: NarrativeContextSectionKind
  candidateCount: number
  includedCount: number
  omittedCount: number
  charBudget: number
  tokenBudget: number
  usedChars: number
  usedTokens: number
  items: NarrativeContextItem[]
}

export interface NarrativeMaterializedState {
  schemaVersion: 1
  runId: string
  latestRevision: number
  characters: NarrativeContextItem[]
  objects: NarrativeContextItem[]
  relationships: NarrativeContextItem[]
  knowledge: NarrativeContextItem[]
  foreshadowing: NarrativeContextItem[]
  timeline: NarrativeContextItem[]
}

export interface NarrativeContextManifest {
  schemaVersion: 1
  manifestId: string
  runId: string
  sceneId: string
  sceneContract: {
    contractId: string
    sectionId: string
    contractHash: string
    revision: number
    order: number
  }
  acceptedPrefixHash: string | null
  /** Context mode is recorded inside the manifest so omitted state is visible. */
  mode?: ContextMode
  /** Hash of the exact fact versions admitted to this manifest. */
  factRegistryHash?: string | null
  budget: NarrativeContextBudget
  materializedRevision: number
  /** Durable story revision cursor read by this run. */
  storyScope?: NarrativeLedgerScope
  storyRevision?: number
  storyHighWatermark?: number
  /** Validity epoch bound to this provider context snapshot. */
  storyValidityEpoch?: number
  sections: NarrativeContextSectionManifest[]
  manifestHash: string
}

export interface BuildNarrativeContextInput {
  runId: string
  sessionId?: string
  contract: SceneContract
  ledger: readonly NarrativeLedgerEntry[]
  budget: NarrativeContextBudget | { maxChars: number; maxTokens?: number; sectionMaxChars?: Partial<Record<NarrativeContextSectionKind, number>>; sectionMaxTokens?: Partial<Record<NarrativeContextSectionKind, number>> }
  acceptedPrefixHash?: string | null
  recentProse?: readonly NarrativeContextRecentProse[]
  recentEventLimit?: number
  /** Durable fact definitions; knowledge edges alone are not sufficient. */
  facts?: readonly NarrativeFact[]
  /** New production longwrite paths fail closed when required facts are absent. */
  requireFactRegistry?: boolean
  mode?: ContextMode
  storyScope?: NarrativeLedgerScope
  storyRevision?: number
  storyHighWatermark?: number
  storyValidityEpoch?: number
}

export interface NarrativeLedgerReader {
  getNarrativeLedger(runId: string, sceneId?: string): NarrativeLedgerEntry[] | Promise<NarrativeLedgerEntry[]>
  getNarrativeFacts?(sessionId: string, includeInactive?: boolean): NarrativeFact[] | Promise<NarrativeFact[]>
}

export interface BuildNarrativeContextFromStoreInput extends Omit<BuildNarrativeContextInput, 'ledger'> {
  store: NarrativeLedgerReader
}

const HASH_RE = /^[0-9a-f]{64}$/u
const SECTION_WEIGHTS: Record<NarrativeContextSectionKind, number> = {
  recent_prose: 0.28,
  current_scene: 0.18,
  active_characters: 0.14,
  knowledge: 0.14,
  open_foreshadow: 0.09,
  recent_events: 0.10,
  world_state: 0.07
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function codePointLength(value: string): number {
  return Array.from(value).length
}

function fail(code: string): never {
  throw new Error(code)
}

function nonNegativeInt(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(code)
  return Math.floor(value)
}

function positiveRevision(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) fail(code)
  return value
}

function normaliseBudget(input: BuildNarrativeContextInput['budget']): NarrativeContextBudget {
  const maxChars = nonNegativeInt(input.maxChars, 'narrative_context_budget_invalid')
  const maxTokens = nonNegativeInt(input.maxTokens ?? Math.ceil(maxChars / 2), 'narrative_context_budget_invalid')
  const normaliseMap = (value: Partial<Record<NarrativeContextSectionKind, number>> | undefined): Partial<Record<NarrativeContextSectionKind, number>> | undefined => {
    if (!value) return undefined
    const out: Partial<Record<NarrativeContextSectionKind, number>> = {}
    for (const section of NARRATIVE_CONTEXT_SECTION_ORDER) {
      if (value[section] !== undefined) out[section] = nonNegativeInt(value[section], 'narrative_context_section_budget_invalid')
    }
    return out
  }
  return {
    maxChars,
    maxTokens,
    sectionMaxChars: normaliseMap(input.sectionMaxChars),
    sectionMaxTokens: normaliseMap(input.sectionMaxTokens)
  }
}

function provenanceKey(provenance: NarrativeContextProvenance): string {
  return stableNarrativeJson(provenance)
}

function itemCanonical(item: Pick<NarrativeContextItem, 'section' | 'data' | 'provenance'>): string {
  return stableNarrativeJson({ section: item.section, data: item.data, provenance: item.provenance })
}

function makeItem(section: NarrativeContextSectionKind, data: Record<string, unknown>, provenance: NarrativeContextProvenance[]): NarrativeContextItem {
  const orderedProvenance = [...provenance].sort((a, b) => provenanceKey(a).localeCompare(provenanceKey(b)))
  const canonical = itemCanonical({ section, data, provenance: orderedProvenance })
  const contentHash = hashText(canonical)
  return {
    itemId: `nci_${contentHash.slice(0, 24)}`,
    section,
    data,
    provenance: orderedProvenance,
    contentHash,
    charCount: codePointLength(canonical),
    estimatedTokens: estimateTokens(canonical)
  }
}

function entryProvenance(entry: NarrativeLedgerEntry): NarrativeContextProvenance {
  return {
    sourceType: 'ledger',
    runId: entry.runId,
    sceneId: entry.sceneId,
    acceptedSegmentId: entry.acceptedSegmentId,
    acceptedContentHash: entry.acceptedContentHash,
    contractHash: entry.contractHash,
    changeId: entry.changeId,
    revision: entry.storyRevision ?? entry.revision,
    deltaHash: entry.deltaHash,
    ...(entry.storyId ? { storyId: entry.storyId } : {}),
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    ...(entry.branchId ? { branchId: entry.branchId } : {}),
    ...(entry.storyRevision !== undefined ? { storyRevision: entry.storyRevision } : {})
  }
}

function entityKey(change: NarrativeStateChange): string {
  switch (change.kind) {
    case 'character_state': return change.characterId
    case 'object_state': return change.objectId
    case 'relationship': return `${change.fromCharacterId}\u0000${change.toCharacterId}\u0000${change.dimension}`
    case 'knowledge': return `${change.knowerId}\u0000${change.factId}`
    case 'foreshadow': return change.threadId
    case 'timeline_event': return change.entityId
  }
}

function changePayload(change: NarrativeStateChange): Record<string, unknown> {
  switch (change.kind) {
    case 'timeline_event': {
      const value: NarrativeTimelineEventChange = change
      return {
        eventId: value.entityId,
        eventType: value.eventType,
        actorIds: [...value.actorIds],
        objectIds: [...value.objectIds],
        locationId: value.locationId,
        storyTime: value.storyTime,
        causeEventIds: [...value.causeEventIds],
        consequenceEventIds: [...value.consequenceEventIds],
        summary: value.summary,
        ...(value.actuality ? { actuality: value.actuality } : {}),
        ...(value.assertion ? { assertion: value.assertion } : {}),
        ...(value.unknownRoles && value.unknownRoles.length > 0 ? { unknownRoles: [...value.unknownRoles] } : {})
      }
    }
    case 'character_state': {
      const value: NarrativeCharacterStateChange = change
      return {
        characterId: value.characterId,
        status: value.status,
        locationId: value.locationId,
        goals: [...value.goals],
        physicalState: value.physicalState,
        emotionalBaseline: value.emotionalBaseline
      }
    }
    case 'object_state': {
      const value: NarrativeObjectStateChange = change
      return {
        objectId: value.objectId,
        ownerId: value.ownerId,
        holderId: value.holderId,
        ...(value.holderStatus ? { holderStatus: value.holderStatus } : {}),
        locationId: value.locationId,
        condition: value.condition
      }
    }
    case 'relationship': {
      const value: NarrativeRelationshipChange = change
      return {
        fromCharacterId: value.fromCharacterId,
        toCharacterId: value.toCharacterId,
        dimension: value.dimension,
        value: value.value,
        reason: value.reason
      }
    }
    case 'knowledge': {
      const value: NarrativeKnowledgeChange = change
      return {
        factId: value.factId,
        ...(value.factRef ? { factRef: { ...value.factRef } } : {}),
        knowerId: value.knowerId,
        stance: value.stance,
        certainty: value.certainty,
        sourceSceneId: value.sourceSceneId,
        effectiveTime: value.effectiveTime,
        confidence: value.confidence
      }
    }
    case 'foreshadow': {
      const value: NarrativeForeshadowChange = change
      return {
        threadId: value.threadId,
        lifecycle: value.lifecycle,
        reason: value.reason,
        setupChangeId: value.setupChangeId,
        payoffChangeId: value.payoffChangeId
      }
    }
  }
}

function validateLedgerEntry(entry: NarrativeLedgerEntry, runId: string): void {
  if (!entry || typeof entry !== 'object' || typeof entry.runId !== 'string' || entry.runId.length === 0 || typeof entry.sceneId !== 'string' || entry.sceneId.length === 0 || typeof entry.changeId !== 'string' || entry.changeId.length === 0 || !Number.isInteger(entry.revision) || entry.revision < 1 || (entry.storyRevision !== undefined && (!Number.isInteger(entry.storyRevision) || entry.storyRevision < 1)) || !HASH_RE.test(entry.acceptedContentHash) || !HASH_RE.test(entry.contractHash) || !HASH_RE.test(entry.deltaHash) || !Number.isFinite(entry.committedAt)) {
    fail('narrative_context_ledger_invalid')
  }
  if (entry.storyId !== undefined && (typeof entry.storyId !== 'string' || entry.storyId.length === 0) || entry.projectId !== undefined && (typeof entry.projectId !== 'string' || entry.projectId.length === 0) || entry.branchId !== undefined && (typeof entry.branchId !== 'string' || entry.branchId.length === 0)) fail('narrative_context_ledger_scope_invalid')
}

function materializedItem(section: NarrativeContextSectionKind, change: NarrativeStateChange, entry: NarrativeLedgerEntry): NarrativeContextItem {
  return makeItem(section, changePayload(change), [entryProvenance(entry)])
}

function factPayload(fact: NarrativeFact, knowledgeEdges: readonly NarrativeContextItem[] = []): Record<string, unknown> {
  return {
    factId: fact.factId,
    factVersion: fact.version,
    canonicalStatement: fact.canonicalStatement,
    canonicalHash: fact.canonicalHash,
    aliases: [...fact.aliases],
    entities: [...fact.entities],
    sourceSlotIds: [...fact.sourceSlotIds],
    sources: fact.sources.map((source) => ({ ...source })),
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    confidence: fact.confidence,
    status: fact.status,
    visibility: fact.visibility,
    knowers: [...fact.knowers],
    knowledgeEdges: knowledgeEdges.map((item) => ({ ...item.data }))
  }
}

function factItem(fact: NarrativeFact, knowledgeEdges: readonly NarrativeContextItem[] = []): NarrativeContextItem {
  return makeItem('knowledge', factPayload(fact, knowledgeEdges), [{
    sourceType: 'fact_registry',
    sessionId: fact.sessionId,
    runId: fact.runId,
    factId: fact.factId,
    version: fact.version,
    revision: fact.version,
    canonicalHash: fact.canonicalHash,
    provenanceHash: fact.provenanceHash
  }])
}

/**
 * Fold committed changes into latest-per-entity state.  Equal revisions for
 * one entity are accepted only when the entire source record is identical;
 * any competing source is an explicit fail-closed conflict.
 */
export function materializeNarrativeState(runId: string, ledger: readonly NarrativeLedgerEntry[]): NarrativeMaterializedState {
  if (typeof runId !== 'string' || runId.length === 0 || !Array.isArray(ledger)) fail('narrative_context_input_invalid')
  const ordered = [...ledger].sort((a, b) => a.revision - b.revision || a.committedAt - b.committedAt || a.sceneId.localeCompare(b.sceneId) || a.changeId.localeCompare(b.changeId))
  const seenChange = new Map<string, string>()
  const seenRevision = new Map<string, string>()
  const latest = new Map<string, NarrativeLedgerEntry>()
  for (const entry of ordered) {
    validateLedgerEntry(entry, runId)
    const complete = stableNarrativeJson(entry)
    const priorChange = seenChange.get(entry.changeId)
    if (priorChange && priorChange !== complete) fail('narrative_context_change_conflict')
    if (priorChange) continue
    seenChange.set(entry.changeId, complete)
    const logicalRevision = entry.storyRevision ?? entry.revision
    // A story revision is an atomic commit, but one delta may legitimately
    // carry more than one state projection for the same entity (for example a
    // beat-derived presence followed by a confirmed fact).  Keep the
    // per-delta revision in the identity so those ordered projections do not
    // look like competing cross-source writes.  A duplicate with the same
    // change revision still fails closed below.
    const stateKey = `${entry.kind}\u0000${entityKey(entry)}\u0000${logicalRevision}\u0000${entry.storyRevision !== undefined ? entry.revision : ''}`
    const priorRevision = seenRevision.get(stateKey)
    if (priorRevision && priorRevision !== complete) fail('narrative_context_revision_conflict')
    if (priorRevision) continue
    seenRevision.set(stateKey, complete)
    const latestKey = `${entry.kind}\u0000${entityKey(entry)}`
    const current = latest.get(latestKey)
    const currentRevision = current ? (current.storyRevision ?? current.revision) : 0
    if (!current || logicalRevision > currentRevision || (logicalRevision === currentRevision && (entry.revision > current.revision || (entry.revision === current.revision && entry.committedAt > current.committedAt)))) latest.set(latestKey, entry)
  }

  const characters: NarrativeContextItem[] = []
  const objects: NarrativeContextItem[] = []
  const relationships: NarrativeContextItem[] = []
  const knowledge: NarrativeContextItem[] = []
  const foreshadowing: NarrativeContextItem[] = []
  const timeline: NarrativeContextItem[] = []
  for (const entry of latest.values()) {
    if (entry.kind === 'character_state') characters.push(materializedItem('active_characters', entry, entry))
    else if (entry.kind === 'object_state') objects.push(materializedItem('world_state', entry, entry))
    else if (entry.kind === 'relationship') relationships.push(materializedItem('world_state', entry, entry))
    else if (entry.kind === 'knowledge') knowledge.push(materializedItem('knowledge', entry, entry))
    else if (entry.kind === 'foreshadow') foreshadowing.push(materializedItem('open_foreshadow', entry, entry))
    else timeline.push(materializedItem('recent_events', entry, entry))
  }
  const itemOrder = (a: NarrativeContextItem, b: NarrativeContextItem): number => a.itemId.localeCompare(b.itemId)
  characters.sort(itemOrder)
  objects.sort(itemOrder)
  relationships.sort(itemOrder)
  knowledge.sort(itemOrder)
  foreshadowing.sort(itemOrder)
  timeline.sort((a, b) => {
    const ar = Number(a.provenance[0]?.revision ?? 0)
    const br = Number(b.provenance[0]?.revision ?? 0)
    return br - ar || a.itemId.localeCompare(b.itemId)
  })
  return {
    schemaVersion: 1,
    runId,
    latestRevision: ordered.reduce((max, entry) => Math.max(max, Number(entry.storyRevision ?? entry.revision)), 0),
    characters,
    objects,
    relationships,
    knowledge,
    foreshadowing,
    timeline
  }
}

function contractData(contract: SceneContract): Record<string, unknown> {
  return {
    contractId: contract.contractId,
    sceneId: contract.sceneId,
    sectionId: contract.sectionId,
    revision: contract.revision,
    order: contract.order,
    title: contract.title,
    objective: contract.objective,
    activeCharacterIds: [...contract.activeCharacterIds],
    characterIds: [...contract.characterIds],
    povCharacterId: contract.povCharacterId ?? null,
    locationId: contract.locationId ?? null,
    storyTime: contract.storyTime ?? null,
    desire: contract.desire,
    obstacle: contract.obstacle,
    conflict: contract.conflict,
    expectedTurn: contract.expectedTurn ?? null,
    reveal: contract.reveal ?? null,
    requiredBeatIds: [...contract.requiredBeatIds],
    requiredBeatEvidence: contract.requiredBeatEvidence?.map((item) => ({
      beatId: item.beatId,
      source: item.source,
      actor: [...item.actor],
      action: [...item.action],
      object: [...item.object],
      location: [...item.location],
      result: [...item.result],
      time: [...item.time],
      negation: item.negation,
      modality: item.modality
    })) ?? null,
    requiredFactIds: [...contract.requiredFactIds],
    forbiddenFactIds: [...contract.forbiddenFactIds],
    mustHappen: [...contract.mustHappen],
    mustNotHappen: [...contract.mustNotHappen],
    handoff: contract.handoff,
    threadActions: contract.threadActions.map((item) => ({ ...item })),
    expectedStateChanges: contract.expectedStateChanges.map((item) => ({ ...item })),
    targetChars: { ...contract.targetChars },
    acceptanceCriteria: [...contract.acceptanceCriteria]
  }
}

function contractProvenance(contract: SceneContract): NarrativeContextProvenance {
  return {
    sourceType: 'scene_contract',
    contractId: contract.contractId,
    sceneId: contract.sceneId,
    sectionId: contract.sectionId,
    contractHash: contract.frozenHash,
    outlineHash: contract.outlineHash,
    revision: contract.revision
  }
}

function validateRecentProse(prose: NarrativeContextRecentProse, _runId: string): void {
  if (!prose || typeof prose.runId !== 'string' || prose.runId.length === 0 || typeof prose.segmentId !== 'string' || prose.segmentId.length === 0 || typeof prose.sceneId !== 'string' || prose.sceneId.length === 0 || typeof prose.content !== 'string' || prose.content.length === 0 || prose.contentHash !== hashText(prose.content) || !HASH_RE.test(prose.contractHash) || (prose.revision !== undefined && prose.revision !== null && (!Number.isInteger(prose.revision) || prose.revision < 1))) fail('narrative_context_recent_prose_invalid')
}

function relevanceScore(item: NarrativeContextItem, contract: SceneContract): number {
  const active = new Set(contract.activeCharacterIds)
  const requiredFacts = new Set(contract.requiredFactIds)
  const forbiddenFacts = new Set(contract.forbiddenFactIds)
  const threadIds = new Set(contract.threadActions.map((thread) => thread.threadId))
  const locationId = contract.locationId ?? null
  let score = 0
  if (item.section === 'knowledge') {
    const factIds = [String(item.data.factId), ...(Array.isArray(item.data.sourceSlotIds) ? item.data.sourceSlotIds.map(String) : [])]
    if (factIds.some((id) => requiredFacts.has(id))) score += 100
    if (factIds.some((id) => forbiddenFacts.has(id))) score += 90
    if (active.has(String(item.data.knowerId))) score += 40
  } else if (item.section === 'active_characters') {
    if (active.has(String(item.data.characterId))) score += 100
  } else if (item.section === 'open_foreshadow') {
    if (threadIds.has(String(item.data.threadId))) score += 80
  } else if (item.section === 'world_state') {
    if (active.has(String(item.data.ownerId)) || active.has(String(item.data.holderId)) || active.has(String(item.data.fromCharacterId)) || active.has(String(item.data.toCharacterId))) score += 50
    if (locationId && item.data.locationId === locationId) score += 30
  } else if (item.section === 'recent_events') {
    const actors = Array.isArray(item.data.actorIds) ? item.data.actorIds.map(String) : []
    if (actors.some((actor) => active.has(actor))) score += 20
    if (locationId && item.data.locationId === locationId) score += 10
  }
  return score
}

function sortRelevant(items: readonly NarrativeContextItem[], contract: SceneContract): NarrativeContextItem[] {
  return [...items].sort((a, b) => relevanceScore(b, contract) - relevanceScore(a, contract) || a.itemId.localeCompare(b.itemId))
}

function sectionBudget(budget: NarrativeContextBudget, section: NarrativeContextSectionKind, axis: 'chars' | 'tokens'): number {
  const explicit = axis === 'chars' ? budget.sectionMaxChars?.[section] : budget.sectionMaxTokens?.[section]
  if (explicit !== undefined) return Math.min(explicit, axis === 'chars' ? budget.maxChars : budget.maxTokens)
  const total = axis === 'chars' ? budget.maxChars : budget.maxTokens
  return Math.floor(total * SECTION_WEIGHTS[section])
}

function buildSection(section: NarrativeContextSectionKind, candidates: readonly NarrativeContextItem[], budget: NarrativeContextBudget, consumed: { chars: number; tokens: number }, required = false): NarrativeContextSectionManifest {
  // The frozen contract is a hard input to a longwrite call.  Its section
  // budget gets a minimum equal to the exact contract item so a normal budget
  // cannot silently omit it.  If the global budget still cannot fit it, the
  // caller receives an explicit fail-closed error below.
  const charBudget = required && candidates[0] ? Math.max(sectionBudget(budget, section, 'chars'), candidates[0].charCount) : sectionBudget(budget, section, 'chars')
  const tokenBudget = required && candidates[0] ? Math.max(sectionBudget(budget, section, 'tokens'), candidates[0].estimatedTokens) : sectionBudget(budget, section, 'tokens')
  const items: NarrativeContextItem[] = []
  let usedChars = 0
  let usedTokens = 0
  for (const candidate of candidates) {
    const fitsSection = usedChars + candidate.charCount <= charBudget && usedTokens + candidate.estimatedTokens <= tokenBudget
    const fitsGlobal = consumed.chars + candidate.charCount <= budget.maxChars && consumed.tokens + candidate.estimatedTokens <= budget.maxTokens
    if (!fitsSection || !fitsGlobal) continue
    items.push(candidate)
    usedChars += candidate.charCount
    usedTokens += candidate.estimatedTokens
    consumed.chars += candidate.charCount
    consumed.tokens += candidate.estimatedTokens
  }
  return {
    section,
    candidateCount: candidates.length,
    includedCount: items.length,
    omittedCount: candidates.length - items.length,
    charBudget,
    tokenBudget,
    usedChars,
    usedTokens,
    items
  }
}

function manifestIdentity(manifest: Pick<NarrativeContextManifest, 'runId' | 'sceneId' | 'sceneContract' | 'acceptedPrefixHash' | 'budget' | 'materializedRevision'> & { factRegistryHash?: string | null; mode?: ContextMode | null; storyScope?: NarrativeLedgerScope | null; storyRevision?: number | null; storyHighWatermark?: number | null; storyValidityEpoch?: number | null }): string {
  return hashText(stableNarrativeJson({
    runId: manifest.runId,
    sceneId: manifest.sceneId,
    sceneContract: manifest.sceneContract,
    acceptedPrefixHash: manifest.acceptedPrefixHash,
    budget: manifest.budget,
    materializedRevision: manifest.materializedRevision,
    factRegistryHash: manifest.factRegistryHash ?? null,
    mode: manifest.mode ?? null,
    storyScope: manifest.storyScope ?? null,
    storyRevision: manifest.storyRevision ?? null,
    storyHighWatermark: manifest.storyHighWatermark ?? null,
    storyValidityEpoch: manifest.storyValidityEpoch ?? null
  }))
}

function withoutManifestHash(manifest: NarrativeContextManifest): Omit<NarrativeContextManifest, 'manifestHash'> {
  const { manifestHash: _ignored, ...rest } = manifest
  return rest
}

function manifestHash(manifest: NarrativeContextManifest): string {
  return hashText(stableNarrativeJson(withoutManifestHash(manifest)))
}

function requireHashOrNull(value: string | null, code: string): void {
  if (value !== null && !HASH_RE.test(value)) fail(code)
}

/** Build the deterministic structured manifest used by an optimized context. */
export function buildNarrativeContextManifest(input: BuildNarrativeContextInput): NarrativeContextManifest {
  if (!input || typeof input.runId !== 'string' || input.runId.length === 0 || !input.contract || input.contract.schemaVersion !== 1 || typeof input.contract.sceneId !== 'string' || input.contract.sceneId.length === 0 || typeof input.contract.frozenHash !== 'string' || input.contract.frozenHash.length === 0) fail('narrative_context_input_invalid')
  const budget = normaliseBudget(input.budget)
  const acceptedPrefixHash = input.acceptedPrefixHash ?? null
  requireHashOrNull(acceptedPrefixHash, 'narrative_context_prefix_hash_invalid')
  const materialized = materializeNarrativeState(input.runId, input.ledger)
  const facts = [...(input.facts ?? [])].map((fact) => validateNarrativeFact(fact))
  const activeFacts = facts.filter((fact) => fact.status === 'active')
  const requireFactRegistry = input.requireFactRegistry === true
  if (requireFactRegistry) {
    for (const requiredId of input.contract.requiredFactIds) {
      if (!activeFacts.some((fact) => factMatchesRequiredId(fact, requiredId))) fail('narrative_context_fact_missing')
    }
    for (const item of materialized.knowledge) {
      const factId = String(item.data.factId ?? '')
      if (!activeFacts.some((fact) => fact.factId === factId)) fail('narrative_context_knowledge_fact_missing')
    }
  }

  const proseCandidates = [...(input.recentProse ?? [])]
    .map((entry) => {
      validateRecentProse(entry, input.runId)
      return makeItem('recent_prose', {
        segmentId: entry.segmentId,
        sceneId: entry.sceneId,
        revision: entry.revision ?? null,
        content: entry.content,
        contentHash: entry.contentHash,
        contractHash: entry.contractHash
      }, [{ sourceType: 'accepted_segment', runId: entry.runId, sceneId: entry.sceneId, acceptedSegmentId: entry.segmentId, acceptedContentHash: entry.contentHash, contractHash: entry.contractHash, revision: entry.revision ?? null }])
    })
    .sort((a, b) => Number(b.provenance[0]?.revision ?? -1) - Number(a.provenance[0]?.revision ?? -1) || a.itemId.localeCompare(b.itemId))

  const currentScene = [makeItem('current_scene', contractData(input.contract), [contractProvenance(input.contract)])]
  const activeCharacterIds = new Set(input.contract.activeCharacterIds)
  const activeCharacters = activeCharacterIds.size === 0
    ? []
    : sortRelevant(materialized.characters.filter((item) => activeCharacterIds.has(String(item.data.characterId))), input.contract)
  const ledgerKnowledgeByFact = new Map<string, NarrativeContextItem[]>()
  for (const item of materialized.knowledge) {
    const factId = String(item.data.factId ?? '')
    const list = ledgerKnowledgeByFact.get(factId) ?? []
    list.push(item)
    ledgerKnowledgeByFact.set(factId, list)
  }
  const factItems = activeFacts.map((fact) => factItem(fact, ledgerKnowledgeByFact.get(fact.factId) ?? []))
  const registeredFactIds = new Set(activeFacts.map((fact) => fact.factId))
  // Keep legacy ledger-only knowledge readable for pre-registry runs, while a
  // production Grill run above has already failed closed on an unresolved id.
  const unregisteredKnowledge = materialized.knowledge.filter((item) => !registeredFactIds.has(String(item.data.factId ?? '')))
  const knowledge = sortRelevant([...factItems, ...unregisteredKnowledge], input.contract)
  const openForeshadow = sortRelevant(materialized.foreshadowing.filter((item) => ['open', 'advanced', 'delayed'].includes(String(item.data.lifecycle))), input.contract)
  const eventLimit = input.recentEventLimit === undefined ? 12 : Math.min(64, nonNegativeInt(input.recentEventLimit, 'narrative_context_event_limit_invalid'))
  const recentEvents = [...materialized.timeline].sort((a, b) => {
    const ar = Number(a.provenance[0]?.revision ?? 0)
    const br = Number(b.provenance[0]?.revision ?? 0)
    return br - ar || relevanceScore(b, input.contract) - relevanceScore(a, input.contract) || a.itemId.localeCompare(b.itemId)
  }).slice(0, eventLimit)
  const worldState = sortRelevant([...materialized.objects, ...materialized.relationships], input.contract)
  const candidates: Record<NarrativeContextSectionKind, NarrativeContextItem[]> = {
    recent_prose: proseCandidates,
    current_scene: currentScene,
    active_characters: activeCharacters,
    knowledge,
    open_foreshadow: openForeshadow,
    recent_events: recentEvents,
    world_state: worldState
  }
  const consumed = { chars: 0, tokens: 0 }
  // Admit the mandatory current scene before optional sections consume the
  // global budget, then restore the public section order for stable manifests.
  const buildOrder = [...NARRATIVE_CONTEXT_SECTION_ORDER].sort((a, b) => (a === 'current_scene' ? -1 : b === 'current_scene' ? 1 : 0))
  const built = new Map<NarrativeContextSectionKind, NarrativeContextSectionManifest>()
  for (const section of buildOrder) built.set(section, buildSection(section, candidates[section], budget, consumed, section === 'current_scene'))
  const sections = NARRATIVE_CONTEXT_SECTION_ORDER.map((section) => built.get(section)!)
  const currentSection = built.get('current_scene')!
  if (currentSection.includedCount !== 1 || currentSection.omittedCount !== 0) fail('narrative_context_current_scene_overflow')
  const sceneContract = {
    contractId: input.contract.contractId,
    sectionId: input.contract.sectionId,
    contractHash: input.contract.frozenHash,
    revision: input.contract.revision,
    order: input.contract.order
  }
  const identityBase = { runId: input.runId, sceneId: input.contract.sceneId, sceneContract, acceptedPrefixHash, budget, materializedRevision: materialized.latestRevision }
  const factRegistryHash = facts.length > 0 ? narrativeFactRegistryHash(facts) : null
  if (input.storyScope !== undefined && (typeof input.storyRevision !== 'number' || !Number.isInteger(input.storyRevision) || input.storyRevision < 0 || typeof input.storyHighWatermark !== 'number' || !Number.isInteger(input.storyHighWatermark) || input.storyHighWatermark < input.storyRevision || input.storyValidityEpoch !== undefined && (!Number.isInteger(input.storyValidityEpoch) || input.storyValidityEpoch < 1))) fail('narrative_context_story_revision_invalid')
  const identityWithFacts = { ...identityBase, factRegistryHash, mode: input.mode ?? null, storyScope: input.storyScope ?? null, storyRevision: input.storyRevision ?? null, storyHighWatermark: input.storyHighWatermark ?? null, storyValidityEpoch: input.storyValidityEpoch ?? null }
  const manifestId = `nctx_${manifestIdentity(identityWithFacts).slice(0, 24)}`
  const base: NarrativeContextManifest = {
    schemaVersion: 1,
    manifestId,
    runId: input.runId,
    sceneId: input.contract.sceneId,
    sceneContract,
    acceptedPrefixHash,
    ...(input.mode ? { mode: input.mode } : {}),
    factRegistryHash,
    budget,
    materializedRevision: materialized.latestRevision,
    ...(input.storyScope ? { storyScope: input.storyScope } : {}),
    ...(input.storyRevision !== undefined ? { storyRevision: input.storyRevision } : {}),
    ...(input.storyHighWatermark !== undefined ? { storyHighWatermark: input.storyHighWatermark } : {}),
    ...(input.storyValidityEpoch !== undefined ? { storyValidityEpoch: input.storyValidityEpoch } : {}),
    sections,
    manifestHash: ''
  }
  const builtManifest = { ...base, manifestHash: manifestHash(base) }
  if (requireFactRegistry) {
    const knowledgeSection = builtManifest.sections.find((section) => section.section === 'knowledge')
    for (const requiredId of input.contract.requiredFactIds) {
      if (!knowledgeSection?.items.some((item) => activeFacts.some((fact) => factMatchesRequiredId(fact, requiredId) && item.data.factId === fact.factId))) fail('narrative_context_required_fact_omitted')
    }
  }
  return builtManifest
}

/** Read committed rows through the existing RunStore/Repository port. */
export async function buildNarrativeContextManifestFromStore(input: BuildNarrativeContextFromStoreInput): Promise<NarrativeContextManifest> {
  const ledger = await input.store.getNarrativeLedger(input.runId)
  const facts = input.facts ?? (input.sessionId && input.store.getNarrativeFacts ? await input.store.getNarrativeFacts(input.sessionId, false) : undefined)
  return buildNarrativeContextManifest({ ...input, ledger, ...(facts ? { facts } : {}) })
}

function validateProvenance(value: NarrativeContextProvenance): void {
  if (!value || typeof value !== 'object' || typeof value.sourceType !== 'string') fail('narrative_context_provenance_invalid')
  if (value.sourceType === 'ledger') {
    if (!value.runId || !value.sceneId || !value.acceptedSegmentId || !HASH_RE.test(value.acceptedContentHash) || !value.contractHash || !value.changeId || !Number.isInteger(value.revision) || value.revision < 1 || !HASH_RE.test(value.deltaHash)) fail('narrative_context_provenance_invalid')
    if (value.storyRevision !== undefined && (!Number.isInteger(value.storyRevision) || value.storyRevision < 1) || value.storyId !== undefined && !value.storyId || value.projectId !== undefined && !value.projectId || value.branchId !== undefined && !value.branchId) fail('narrative_context_provenance_scope_invalid')
  } else if (value.sourceType === 'scene_contract') {
    if (!value.contractId || !value.sceneId || !value.sectionId || !value.contractHash || !value.outlineHash || !Number.isInteger(value.revision) || value.revision < 1) fail('narrative_context_provenance_invalid')
  } else if (value.sourceType === 'accepted_segment') {
    if (!value.runId || !value.sceneId || !value.acceptedSegmentId || !HASH_RE.test(value.acceptedContentHash) || !HASH_RE.test(value.contractHash) || (value.revision !== null && (!Number.isInteger(value.revision) || value.revision < 1))) fail('narrative_context_provenance_invalid')
  } else if (value.sourceType === 'fact_registry') {
    if (!value.sessionId || (value.runId !== null && !value.runId) || !value.factId || !Number.isInteger(value.version) || value.version < 1 || !Number.isInteger(value.revision) || value.revision < 1 || value.revision !== value.version || !HASH_RE.test(value.canonicalHash) || !HASH_RE.test(value.provenanceHash)) fail('narrative_context_provenance_invalid')
  } else fail('narrative_context_provenance_invalid')
}

function validateItem(item: NarrativeContextItem, section: NarrativeContextSectionKind): void {
  if (!item || item.section !== section || typeof item.itemId !== 'string' || item.itemId.length === 0 || !item.data || typeof item.data !== 'object' || Array.isArray(item.data) || !Array.isArray(item.provenance) || item.provenance.length === 0 || !HASH_RE.test(item.contentHash) || !Number.isInteger(item.charCount) || item.charCount < 0 || !Number.isInteger(item.estimatedTokens) || item.estimatedTokens < 0) fail('narrative_context_item_invalid')
  for (const provenance of item.provenance) validateProvenance(provenance)
  const canonical = itemCanonical(item)
  if (item.itemId !== `nci_${hashText(canonical).slice(0, 24)}` || item.contentHash !== hashText(canonical) || item.charCount !== codePointLength(canonical) || item.estimatedTokens !== estimateTokens(canonical)) fail('narrative_context_item_hash_mismatch')
}

/** Verify a persisted/transferred manifest before it is injected into context. */
export function validateNarrativeContextManifest(manifest: NarrativeContextManifest): void {
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.manifestId !== 'string' || !manifest.manifestId.startsWith('nctx_') || typeof manifest.runId !== 'string' || !manifest.runId || typeof manifest.sceneId !== 'string' || !manifest.sceneId || !manifest.sceneContract || typeof manifest.sceneContract.contractId !== 'string' || typeof manifest.sceneContract.sectionId !== 'string' || typeof manifest.sceneContract.contractHash !== 'string' || !manifest.sceneContract.contractHash || !Number.isInteger(manifest.sceneContract.revision) || manifest.sceneContract.revision < 1 || !Number.isInteger(manifest.sceneContract.order) || manifest.sceneContract.order < 1 || !manifest.budget || !Number.isInteger(manifest.budget.maxChars) || manifest.budget.maxChars < 0 || !Number.isInteger(manifest.budget.maxTokens) || manifest.budget.maxTokens < 0 || !Number.isInteger(manifest.materializedRevision) || manifest.materializedRevision < 0 || !Array.isArray(manifest.sections) || !HASH_RE.test(manifest.manifestHash)) fail('narrative_context_manifest_invalid')
  if (manifest.storyScope !== undefined && (!manifest.storyScope || manifest.storyScope.schemaVersion !== 1 || typeof manifest.storyScope.storyId !== 'string' || typeof manifest.storyScope.projectId !== 'string' || typeof manifest.storyScope.branchId !== 'string' || !Number.isInteger(manifest.storyRevision) || (manifest.storyRevision as number) < 0 || !Number.isInteger(manifest.storyHighWatermark) || (manifest.storyHighWatermark as number) < (manifest.storyRevision as number) || manifest.storyValidityEpoch !== undefined && (!Number.isInteger(manifest.storyValidityEpoch) || (manifest.storyValidityEpoch as number) < 1))) fail('narrative_context_story_scope_invalid')
  requireHashOrNull(manifest.acceptedPrefixHash, 'narrative_context_prefix_hash_invalid')
  if (manifest.mode !== undefined && !['full', 'optimized', 'minimal'].includes(manifest.mode)) fail('narrative_context_mode_invalid')
  requireHashOrNull(manifest.factRegistryHash ?? null, 'narrative_context_fact_registry_hash_invalid')
  if (manifest.sections.length !== NARRATIVE_CONTEXT_SECTION_ORDER.length || manifest.sections.some((section, index) => section.section !== NARRATIVE_CONTEXT_SECTION_ORDER[index])) fail('narrative_context_sections_invalid')
  const expectedIdentity = `nctx_${manifestIdentity(manifest).slice(0, 24)}`
  if (manifest.manifestId !== expectedIdentity) fail('narrative_context_manifest_identity_mismatch')
  let totalChars = 0
  let totalTokens = 0
  for (const section of manifest.sections) {
    if (!Number.isInteger(section.candidateCount) || section.candidateCount < 0 || !Number.isInteger(section.includedCount) || section.includedCount < 0 || !Number.isInteger(section.omittedCount) || section.omittedCount < 0 || section.candidateCount !== section.includedCount + section.omittedCount || !Number.isInteger(section.charBudget) || section.charBudget < 0 || !Number.isInteger(section.tokenBudget) || section.tokenBudget < 0 || !Number.isInteger(section.usedChars) || section.usedChars < 0 || !Number.isInteger(section.usedTokens) || section.usedTokens < 0 || !Array.isArray(section.items) || section.items.length !== section.includedCount) fail('narrative_context_section_invalid')
    let chars = 0
    let tokens = 0
    const itemIds = new Set<string>()
    for (const item of section.items) {
      validateItem(item, section.section)
      if (itemIds.has(item.itemId)) fail('narrative_context_duplicate_item')
      itemIds.add(item.itemId)
      chars += item.charCount
      tokens += item.estimatedTokens
    }
    if (section.usedChars !== chars || section.usedTokens !== tokens || chars > section.charBudget || tokens > section.tokenBudget) fail('narrative_context_section_measurement_mismatch')
    if (section.section === 'current_scene' && (section.includedCount !== 1 || section.omittedCount !== 0)) fail('narrative_context_current_scene_missing')
    totalChars += chars
    totalTokens += tokens
  }
  if (totalChars > manifest.budget.maxChars || totalTokens > manifest.budget.maxTokens || manifest.manifestHash !== manifestHash(manifest)) fail('narrative_context_manifest_hash_mismatch')
}

/** Structured JSON wire form for an optimized context; no prose summary is synthesized. */
export function renderNarrativeContextManifest(manifest: NarrativeContextManifest): string {
  validateNarrativeContextManifest(manifest)
  return stableNarrativeJson({ schemaVersion: 1, manifestHash: manifest.manifestHash, runId: manifest.runId, sceneId: manifest.sceneId, mode: manifest.mode ?? null, factRegistryHash: manifest.factRegistryHash ?? null, storyScope: manifest.storyScope ?? null, storyRevision: manifest.storyRevision ?? null, storyHighWatermark: manifest.storyHighWatermark ?? null, storyValidityEpoch: manifest.storyValidityEpoch ?? null, sections: manifest.sections })
}
