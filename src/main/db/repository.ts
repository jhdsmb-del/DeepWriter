import { openDb, closeDb } from './migrations'
import { COMPOSER_DRAFT_MAX_BYTES, COMPOSER_DRAFT_MAX_CHARS, COMPOSER_DRAFT_MAX_COUNT, type PersistedComposerDraft, type ComposerDraftWrite, type ComposerDraftWriteResult } from '../../shared/composerDraft'
import { createHash } from 'node:crypto'
import type { SqliteDb } from './migrations'
import type { ActivityEvent } from '../../shared/activity'
import { buildRunBillingView, type ProviderAttemptRecord, type RunBillingView } from '../../shared/billing'
import type { ContextManifestV2 } from '../../shared/contextV2'
import { hydrateGrillMeState, type GrillMeState } from '../../shared/grillMe'
import type { AssistantOutputKind, DsMessage, LegacyManuscriptBackfillState, ManuscriptAcceptanceInput, ManuscriptSegmentStatus, NarrativeCommitRecord, NarrativeFact, NarrativeFactReference, NarrativeLedgerEntry, NarrativeLedgerScope, NarrativeLedgerScopeInfo, NarrativeLedgerScopeInput, NarrativeStateDelta, SceneCommitInput, SceneCommitManifest, SceneCompletionDecision, SceneContractPlan, SceneLifecycle, SceneStateRecord, SceneStateTransitionInput, SceneMemoryCard, SceneMemoryCardValidationContext, SceneMemorySourceSegment, SceneRecallAuthorityTag, SceneRecallCorpusItem, SceneRecallCorpusSnapshot, SceneRecallCurrentSceneTail, SceneRecallHardDependency, SceneRecallKnowledgeBoundary, SceneRecallPayoffUrgency, SceneRecallScope, SceneContextManifest, SceneContextSectionDecision, SceneWorkingSet, SceneWorkingSetMessage, SceneWorkingSetStatus } from '../../shared/types'
import { codePointLength } from '../../shared/textMetrics'
import { classifyAssistantOutput, hasNaturalProseEnding, legacyBackfillCompletionMarker, legacyBackfillSourceSummaryHash, manuscriptAcceptanceEvidenceIdentity, manuscriptAcceptanceEvidenceMatches, manuscriptSegmentHash, validateLegacyBackfillState, validateManuscriptPartialGraph } from '../manuscript'
import { normalizeNarrativeStateDelta, stableNarrativeJson } from '../narrative/stateDelta'
import { factReferenceMatches, narrativeFactProvenanceHash, validateNarrativeFact, validateNarrativeFactReference } from '../narrative/factRegistry'
import { narrativeLedgerScopeFromConfig, narrativeLedgerScopeKey, narrativeLedgerScopeInfo, storyLedgerGenesisHeadHash, storyLedgerRevisionHashV2, storyLedgerTombstoneHashV2, validateNarrativeLedgerScope, type StoryLedgerFreshness, type StoryLedgerFreshnessExpectation } from '../narrative/storyLedger'
import { sceneMemoryCardHash, sceneMemoryLedgerClaimHash, stableSceneMemoryCardJson, stableSceneMemoryJson, validateSceneMemoryCard } from '../narrative/sceneMemoryCard'
import { sceneRecallAuthorityHash, sceneRecallSourceCardSetHash, sceneRecallSourceSnapshotHash } from '../narrative/recallIndex'
import { sceneRecallSourceSnapshotSetHash } from '../narrative/sceneContextCompiler'
import { providerEnvelopeHash } from '../providerEnvelope'

export interface RunRow {
  run_id: string
  session_id: string
  status: string
  phase: string
  started_at: number
  updated_at: number
  config_json: string
  parent_run_id: string | null
  error_code: string | null
  error_message: string | null
  /** 持久幂等键（R4-4）：客户端请求 id，(session_id, client_request_id) 唯一 */
  client_request_id?: string | null
}

export interface TurnRow {
  turn_id: string
  run_id: string
  turn_seq: number
  role: string
  content: string
  reasoning_content: string | null
  tool_calls_json: string | null
  tool_result_json: string | null
  plan_state: string | null
  created_at: number
}

/** Bounded stored source, never a read capability exposed to the renderer. */
export interface FileEvidenceRow {
  run_id: string
  tool_call_id: string
  name: string
  source_index: number
  source_json: string
  roots_json: string
}

const FILE_EVIDENCE_PAYLOAD_SQL = `WITH raw AS (
  SELECT tc.*, r.session_id, r.config_json,
    CASE WHEN json_valid(tc.result_json) THEN tc.result_json ELSE '{}' END AS o
  FROM toolcalls tc JOIN runs r ON r.run_id=tc.run_id
  JOIN turns t ON t.turn_id=tc.turn_id AND t.run_id=tc.run_id
  WHERE tc.status='completed' AND tc.name IN ('read_file','read_files','search_files') AND $SCOPE
), payload AS (
  SELECT *, CASE WHEN json_type(o,'$.error') IS NOT 'text'
    AND json_type(o,'$.content')='text' AND json_valid(json_extract(o,'$.content'))
    THEN json_extract(o,'$.content') ELSE o END AS p FROM raw
), sources AS (
  SELECT payload.*, CAST(j.key AS INTEGER) AS source_index, j.value AS source_json
  FROM payload, json_each(CASE WHEN json_type(p,'$.sources')='array' THEN json_extract(p,'$.sources') ELSE '[]' END) j
  WHERE json_extract(p,'$.ok')=1 AND json_type(p,'$.error') IS NOT 'text'
    AND j.type='object' AND j.key < 64 AND json_extract(j.value,'$.version')=1
    AND json_type(j.value,'$.path')='text' AND json_type(j.value,'$.excerpt')='text'
)`

export interface ToolCallRow {
  tool_call_id: string
  turn_id: string
  run_id: string
  name: string
  args_json: string
  args_hash: string
  status: string
  result_json: string | null
  started_at: number | null
  completed_at: number | null
}

export interface ArtifactRow {
  artifact_id: string
  run_id: string
  session_id: string
  artifact_type: string
  display_name: string
  relative_path: string | null
  hash: string | null
  char_count: number
  status: string
  created_at: number
}

export interface ManuscriptSegmentRow {
  segment_id: string
  run_id: string
  session_id: string
  source_turn_id: string | null
  section_id: string | null
  scene_id: string | null
  chunk_index: number
  revision: number
  status: ManuscriptSegmentStatus
  kind: AssistantOutputKind
  content: string
  content_hash: string
  char_count: number
  supersedes_segment_id: string | null
  created_at: number
  updated_at: number
  accepted_at: number | null
}

export type ManuscriptReaderSegment = Pick<ManuscriptSegmentRow, 'segment_id' | 'section_id' | 'scene_id' | 'status' | 'char_count'>
export interface ManuscriptReaderSlice { segmentId: string; start: number; length: number }

/**
 * Metadata returned by the R61 accepted-prefix cursor.  The content itself is
 * read only for the bounded recent tail; the full accepted manuscript is
 * represented by a durable provenance chain in narrative_prefix_cache.
 */
export interface AcceptedNarrativePrefixRecentProse {
  segmentId: string
  runId: string
  sceneId: string
  content: string
  contentHash: string
  contractHash: string
  revision?: number | null
}

export interface AcceptedNarrativePrefixLedgerBinding {
  acceptedSegmentId: string
  contractHash: string
}

export interface AcceptedNarrativePrefixSnapshot {
  schemaVersion: 1
  hash: string
  acceptedCharCount: number
  acceptedSegmentCount: number
  recentProse: AcceptedNarrativePrefixRecentProse[]
  /** Bytes read from accepted segment bodies during this snapshot. */
  readBytes: number
  /** true when no full-prefix rebuild was needed. */
  cacheHit: boolean
  cacheRevision: number
}

interface SceneStateRow {
  run_id: string
  scene_id: string
  section_id: string
  contract_id: string
  contract_hash: string
  scene_order: number
  lifecycle: SceneLifecycle
  revision: number
  candidate_segment_id: string | null
  candidate_hash: string | null
  accepted_segment_id: string | null
  accepted_hash: string | null
  completion_decision_json: string | null
  completion_evidence_hash: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
  committed_at: number | null
}

export interface NarrativeCommitRow {
  run_id: string
  scene_id: string
  accepted_segment_id: string
  accepted_content_hash: string
  contract_hash: string
  delta_hash: string
  delta_json: string
  revision: number
  committed_at: number
}

interface StoryLedgerHeadRow {
  story_id: string
  project_id: string
  branch_id: string
  parent_story_id: string | null
  parent_project_id: string | null
  parent_branch_id: string | null
  parent_revision: number
  high_watermark: number
  head_hash: string | null
  hash_schema_version: number
  validity_epoch: number
  parent_validity_epoch: number
  updated_at: number
}

interface StoryLedgerRunRow {
  run_id: string
  story_id: string
  project_id: string
  branch_id: string
  parent_story_id: string | null
  parent_project_id: string | null
  parent_branch_id: string | null
  parent_revision: number
  current_revision: number
  validity_epoch: number
  parent_validity_epoch: number
  created_at: number
  updated_at: number
}

interface StoryLedgerRevisionRow {
  story_id: string
  project_id: string
  branch_id: string
  revision: number
  parent_story_id: string | null
  parent_project_id: string | null
  parent_branch_id: string | null
  parent_revision: number
  run_id: string | null
  scene_id: string | null
  accepted_segment_id: string
  accepted_content_hash: string
  contract_hash: string
  delta_hash: string
  delta_json: string
  manifest_json: string | null
  manifest_hash: string | null
  revision_hash: string
  parent_hash: string | null
  node_type: string
  hash_schema_version: number
  validity_epoch: number
  rebase_parent_revision: number | null
  rebase_parent_hash: string | null
  committed_at: number
}

interface StoryLedgerTombstoneRow {
  story_id: string
  project_id: string
  branch_id: string
  revision: number
  parent_revision: number
  target_revision: number
  target_revision_hash: string
  target_run_id: string | null
  target_scene_id: string | null
  reason: string
  tombstone_hash: string
  parent_hash: string | null
  node_type: string
  hash_schema_version: number
  validity_epoch: number
  next_validity_epoch: number
  committed_at: number
}

export type StoryLedgerDeleteAction = 'preserve' | 'retract'

export interface StoryLedgerRetractionResult {
  action: StoryLedgerDeleteAction
  retractedRevisions: number
  headRevision: number | null
}

export interface StoryLedgerRebaseResult {
  storyScope: NarrativeLedgerScopeInput
  sessionId: string
  sourceRevision: number
  sourceEpoch: number
}

export interface NarrativeFactRow {
  fact_id: string
  version: number
  session_id: string
  run_id: string | null
  canonical_statement: string
  canonical_hash: string
  aliases_json: string
  entities_json: string
  source_slot_ids_json: string
  sources_json: string
  valid_from: string | null
  valid_until: string | null
  confidence: number
  status: NarrativeFact['status']
  visibility: NarrativeFact['visibility']
  knowers_json: string
  provenance_hash: string
  created_at: number
  updated_at: number
}

export interface SceneCommitManifestRow {
  run_id: string
  scene_id: string
  revision: number
  manifest_json: string
  manifest_hash: string
  created_at: number
}

/** WP2: a source-bound card may only be published with the exact validation
 * context used by the WP1 builder.  The repository rechecks that context
 * against canonical accepted prose, scene manifest and story ledger rows. */
export interface SceneMemoryProjectionInput {
  card: SceneMemoryCard
  context: SceneMemoryCardValidationContext
}

/** Result envelope produced by an independent embedding worker.  The worker
 * owns no canonical card fields: it may only fill the vector sidecar for the
 * exact card hash/epoch captured when the job was queued. */
export interface SceneMemoryEmbeddingResultInput {
  cardId: string
  sourceCardHash: string
  validityEpoch: number
  status: 'ready' | 'failed'
  version: string
  modelId: string
  vector?: readonly number[] | null
  vectorHash?: string | null
  completedAt: number
  expiresAt?: number | null
  now?: number
}

export interface SceneMemoryEmbeddingApplyResult {
  applied: boolean
  reason: 'applied' | 'already_applied' | 'result_stale' | 'worker_failed' | 'result_expired' | 'card_missing' | 'card_not_active' | 'authority_mismatch' | 'vector_invalid' | 'embedding_not_expected'
}

export interface SceneMemoryCardOutboxReplayOptions {
  limit?: number
  now?: number
}

export interface SceneMemoryCardOutboxReplayResult {
  scanned: number
  published: number
  rejected: number
  pending: number
}

export interface SceneMemoryBackfillReplayInput {
  backfillId: string
  resume?: boolean
  now?: number
}

export interface SceneMemoryBackfillReplayResult {
  state: SceneMemoryBackfillState
  resumed: boolean
  projectionPublished: false
}

export interface SceneMemoryCardScope {
  storyId: string
  projectId: string
  branchId: string
  validityEpoch: number
  storyRevision?: number
  sceneId?: string
}

export interface SceneMemoryCardQuery extends Partial<SceneMemoryCardScope> {
  cardId?: string
  commitManifestHash?: string
  cardHash?: string
  /** Internal rebuild/audit only. Public recall callers should omit it. */
  includeHidden?: boolean
}

/** The expected head fence captured before a provider request.  A snapshot
 * is scoped to one run cursor, but its head fields are the live story
 * authority and therefore must match again at read time. */
export interface SceneRecallCorpusSnapshotFence {
  storyId: string
  projectId: string
  branchId: string
  branchLineage: readonly string[]
  validityEpoch: number
  storyRevision: number
  headRevision: number
  headHash: string
  expectedSourceCardSetHash?: string
}

export interface SceneRecallCorpusSnapshotInput {
  runId: string
  sceneId: string
  expectedFence: SceneRecallCorpusSnapshotFence
  /** When present, repository derives a fail-closed POV boundary from the
   * canonical narrative_facts rows rather than trusting card prose. */
  povCharacterId?: string | null
  /** Read the bounded current-scene accepted/partial continuation in the same
   * Repository transaction as the immutable recall corpus. */
  currentSceneTail?: {
    contractHash: string
    recentChars: number
    expectedTailHash?: string
  }
}

/** Keep the current-scene continuation bounded and identical across build,
 * persistence, and every pre-provider recheck. */
// Keep this below the smallest WP4 input budget even for one-token-per-CJK
// text.  The full segment remains durably hash-bound; only this suffix is
// exposed to the provider for continuation.
export const SCENE_WORKING_SET_CURRENT_TAIL_CHARS = 2_048

/**
 * Durable WP4 working-set write port.
 *
 * The first group of fields is retained for the v1.2.4 projection API.  A
 * v1.2.5 writer should pass `workingSet`, `manifest`, and
 * `workingSetMessage` together (plus the captured lineage).  The repository
 * canonicalizes and hashes that complete tuple; caller supplied hashes are
 * only accepted as assertions and are never used as the source of truth.
 */
export interface SceneMemoryWorkingSetInput {
  workingSetId?: string
  storyId?: string
  projectId?: string
  branchId?: string
  validityEpoch?: number
  storyRevision?: number
  sceneId?: string
  runId?: string
  branchLineage?: readonly string[]
  branchCutoffs?: Readonly<Record<string, number>>
  headRevision?: number
  headHash?: string
  sourceSnapshotHash?: string
  sourceCardSetHash?: string
  queryHash?: string
  indexHash?: string
  contractId?: string
  contractHash?: string
  contractContentHash?: string
  budgetTokens?: number
  estimatedTokens?: number
  estimatorVersion?: string
  sections?: readonly SceneContextSectionDecision[]
  cardIds?: string[]
  omitted?: unknown[]
  payload?: unknown
  workingSetHash?: string
  manifestHash?: string
  workingSetMessageHash?: string
  workingSet?: SceneWorkingSet
  manifest?: SceneContextManifest
  workingSetMessage?: SceneWorkingSetMessage
  /** Optional exact final provider envelope; only its canonical wire hash is persisted. */
  finalEnvelope?: unknown
  finalEnvelopeHash?: string | null
  /** Storage lifecycle. `status` remains accepted for legacy flat writes. */
  storageStatus?: 'active' | 'stale' | 'retracted'
  status?: 'active' | 'stale' | 'retracted' | SceneWorkingSetStatus
  createdAt?: number
}

export interface SceneWorkingSetPersistenceRecord {
  schemaVersion: 1
  workingSet: SceneWorkingSet
  manifest: SceneContextManifest
  workingSetMessage: SceneWorkingSetMessage
  branchLineage: string[]
  branchCutoffs: Record<string, number>
  finalEnvelopeHash: string | null
}

export interface SceneWorkingSetReadResult {
  workingSetId: string
  storyId: string
  projectId: string
  branchId: string
  branchLineage?: string[]
  branchCutoffs?: Record<string, number>
  validityEpoch: number
  storyRevision: number
  headRevision?: number
  headHash?: string
  runId?: string
  sceneId: string
  sourceSnapshotHash?: string
  sourceCardSetHash?: string
  queryHash: string
  indexHash?: string
  contractId?: string
  contractHash?: string
  contractContentHash?: string
  budgetTokens?: number
  estimatedTokens?: number
  estimatorVersion?: string
  sections?: SceneContextSectionDecision[]
  cardIds: string[]
  omitted: unknown[]
  payload: unknown
  workingSetHash: string
  manifestHash?: string
  workingSetMessageHash?: string
  workingSet?: SceneWorkingSet
  manifest?: SceneContextManifest
  workingSetMessage?: SceneWorkingSetMessage
  finalEnvelopeHash?: string | null
  canonicalHash?: string
  legacy?: boolean
  status: string
  createdAt: number
  updatedAt: number
}

export interface SceneWorkingSetFinalEnvelopeInput {
  workingSetId: string
  /** Prefer the exact final provider envelope.  The repository hashes it. */
  finalEnvelope: unknown
  /** Optional assertion checked against the repository's re-computed hash. */
  finalEnvelopeHash?: string | null
}

export interface SceneWorkingSetFreshnessExpectation {
  workingSetHash?: string
  canonicalHash?: string
  finalEnvelopeHash?: string | null
}

export type SceneMemoryWorkflowSnapshotStatus = 'pending' | 'in_progress' | 'paused' | 'ready' | 'complete' | 'completed' | 'failed' | 'cancelled' | 'stale' | 'retracted'

export interface SceneMemoryBackfillState {
  backfillId: string
  storyId: string | null
  projectId: string | null
  branchId: string | null
  /** Nullable only for a legacy/unverified scan. Canonical projection steps
   * must provide the complete story/epoch/revision/scene authority tuple. */
  validityEpoch: number | null
  storyRevision: number | null
  sceneId: string | null
  inputSnapshotHash: string
  cursor: string | null
  processedIds: string[]
  totalCount: number
  processedCount: number
  status: 'pending' | 'in_progress' | 'paused' | 'complete' | 'failed' | 'legacy_unverified'
  errorCode: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface SceneMemoryBackfillStepInput {
  state: SceneMemoryBackfillState
  /** Optional projection to publish atomically with this progress step. */
  projection?: SceneMemoryProjectionInput
}

const SCENE_COMMIT_HASH = /^[0-9a-f]{64}$/u

const SCENE_MEMORY_HASH = /^[0-9a-f]{64}$/u

/**
 * Recall scopes use a content-addressed head even when the durable ledger is
 * still at revision zero.  The database intentionally keeps that empty head
 * as NULL; these helpers are the only boundary where NULL is mapped to the
 * scope/epoch-bound genesis sentinel.  A caller may not provide an arbitrary
 * hash for revision zero, and a non-zero head may never be normalized to the
 * sentinel.
 */
function normalizedRecallFenceHeadHash(scope: NarrativeLedgerScope, validityEpoch: number, storyRevision: number, headRevision: number, headHash: string): string {
  const genesis = storyLedgerGenesisHeadHash(scope, validityEpoch)
  if (storyRevision === 0 || headRevision === 0) {
    if (storyRevision !== 0 || headRevision !== 0 || headHash !== genesis) throw new Error('scene_recall_snapshot_genesis_fence_mismatch')
    return genesis
  }
  if (!SCENE_MEMORY_HASH.test(headHash)) throw new Error('scene_recall_snapshot_head_hash_invalid')
  return headHash
}

function normalizedStoredRecallHeadHash(scope: NarrativeLedgerScope, validityEpoch: number, head: Pick<StoryLedgerHeadRow, 'high_watermark' | 'head_hash'>): string {
  if (head.high_watermark === 0) {
    if (head.head_hash !== null) throw new Error('scene_recall_snapshot_genesis_head_corrupt')
    return storyLedgerGenesisHeadHash(scope, validityEpoch)
  }
  const headHash = head.head_hash
  if (typeof headHash !== 'string' || !SCENE_MEMORY_HASH.test(headHash)) throw new Error('scene_recall_snapshot_head_hash_corrupt')
  return headHash
}

const SCENE_MEMORY_SNAPSHOT_STATUSES = new Set<SceneMemoryWorkflowSnapshotStatus>(['pending', 'in_progress', 'paused', 'ready', 'complete', 'completed', 'failed', 'cancelled', 'stale', 'retracted'])

const isSceneMemorySnapshotStatus = (value: unknown): value is SceneMemoryWorkflowSnapshotStatus => typeof value === 'string' && SCENE_MEMORY_SNAPSHOT_STATUSES.has(value as SceneMemoryWorkflowSnapshotStatus)

function sceneMemoryStableHash(value: unknown): string {
  return createHash('sha256').update(stableSceneMemoryJson(value)).digest('hex')
}

function assertSceneMemoryJsonValue(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label}_non_finite`)
    return
  }
  if (typeof value !== 'object') throw new Error(`${label}_non_json`)
  if (seen.has(value)) throw new Error(`${label}_cycle`)
  seen.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${label}[${index}]_sparse`)
      assertSceneMemoryJsonValue(value[index], `${label}[${index}]`, seen)
    }
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label}_non_plain_object`)
    for (const [key, item] of Object.entries(value)) {
    if (item === undefined) throw new Error(`${label}.${key}_undefined`)
    assertSceneMemoryJsonValue(item, `${label}.${key}`, seen)
    }
  }
  seen.delete(value)
}

function assertPersistedSceneMemoryCardShape(value: unknown): asserts value is SceneMemoryCard {
  const object = (candidate: unknown): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === 'object' && !Array.isArray(candidate))
  const nonEmpty = (candidate: unknown): candidate is string => typeof candidate === 'string' && candidate.length > 0
  const nullableText = (candidate: unknown): boolean => candidate === null || nonEmpty(candidate)
  const hash = (candidate: unknown): candidate is string => typeof candidate === 'string' && SCENE_MEMORY_HASH.test(candidate)
  const refs = (candidate: unknown): boolean => Array.isArray(candidate) && candidate.every((ref) => object(ref) && ['source_span', 'contract', 'ledger'].includes(String(ref.kind)) && nonEmpty(ref.id) && hash(ref.hash) && (ref.kind !== 'source_span' ? ref.spanId === undefined : nonEmpty(ref.spanId)))
  const list = (candidate: unknown, item: (value: unknown) => boolean): boolean => Array.isArray(candidate) && candidate.every(item)
  if (!object(value)) throw new Error('scene_memory_card_shape_invalid')
  const card = value as Record<string, unknown>
  if (card.schemaVersion !== 1 || !['canonical', 'partial', 'pending_review', 'legacy_unverified'].includes(String(card.status))) throw new Error('scene_memory_card_shape_invalid')
  for (const field of ['cardId', 'storyId', 'projectId', 'branchId', 'runId', 'sceneId', 'contractId'] as const) if (!nonEmpty(card[field])) throw new Error(`scene_memory_card_${field}_invalid`)
  for (const field of ['contractHash', 'sceneContentHash', 'commitManifestHash', 'stateDeltaHash', 'cardHash'] as const) if (!hash(card[field])) throw new Error(`scene_memory_card_${field}_invalid`)
  for (const field of ['validityEpoch', 'storyRevision', 'sceneOrder', 'createdAt'] as const) if (!Number.isInteger(card[field]) || Number(card[field]) < 0 || !Number.isFinite(Number(card[field]))) throw new Error(`scene_memory_card_${field}_invalid`)
  if (Number(card.validityEpoch) < 1 || Number(card.storyRevision) < 1 || Number(card.sceneOrder) < 1) throw new Error('scene_memory_card_authority_invalid')
  if (card.povCharacterId !== null && !nonEmpty(card.povCharacterId)) throw new Error('scene_memory_card_pov_invalid')
  if (!list(card.participants, (item) => object(item) && nonEmpty(item.id) && nonEmpty(item.role) && refs(item.evidence))) throw new Error('scene_memory_card_participants_invalid')
  if (!list(card.locations, nonEmpty) || !list(card.objects, nonEmpty)) throw new Error('scene_memory_card_terms_invalid')
  if (!nullableText(card.dramaticQuestion) || !nullableText(card.decisiveAction) || !nullableText(card.turn) || !nullableText(card.cost)) throw new Error('scene_memory_card_scalar_invalid')
  if (card.valueShift !== null && (!object(card.valueShift) || !nonEmpty(card.valueShift.from) || !nonEmpty(card.valueShift.to))) throw new Error('scene_memory_card_value_shift_invalid')
  if (!list(card.factsEstablished, (item) => object(item) && nonEmpty(item.factId) && nonEmpty(item.statement) && refs(item.evidence))) throw new Error('scene_memory_card_facts_invalid')
  if (!list(card.beliefChanges, (item) => object(item) && nonEmpty(item.characterId) && nullableText(item.from) && nullableText(item.to) && refs(item.evidence))) throw new Error('scene_memory_card_beliefs_invalid')
  if (!list(card.relationshipChanges, (item) => object(item) && nonEmpty(item.fromCharacterId) && nonEmpty(item.toCharacterId) && nonEmpty(item.dimension) && nullableText(item.from) && nullableText(item.to) && refs(item.evidence))) throw new Error('scene_memory_card_relationships_invalid')
  if (!list(card.threads, (item) => object(item) && nonEmpty(item.threadId) && ['open', 'advanced', 'delayed', 'resolved', 'abandoned'].includes(String(item.lifecycle)) && nullableText(item.summary) && refs(item.evidence))) throw new Error('scene_memory_card_threads_invalid')
  if (!list(card.motifs, (item) => object(item) && nonEmpty(item.text) && refs(item.evidence)) || !list(card.distinctivePhrases, (item) => object(item) && nonEmpty(item.text) && refs(item.evidence))) throw new Error('scene_memory_card_text_claims_invalid')
  if (!list(card.sourceSegmentIds, nonEmpty) || new Set(card.sourceSegmentIds as string[]).size !== (card.sourceSegmentIds as string[]).length) throw new Error('scene_memory_card_source_segments_invalid')
  if (!list(card.sourceSpans, (item) => object(item) && nonEmpty(item.spanId) && nonEmpty(item.segmentId) && hash(item.segmentHash) && Number.isInteger(item.segmentRevision) && Number(item.segmentRevision) >= 1 && hash(item.manifestHash) && Number.isInteger(item.startUtf16) && Number(item.startUtf16) >= 0 && Number.isInteger(item.endUtf16) && Number(item.endUtf16) > Number(item.startUtf16) && typeof item.text === 'string' && hash(item.spanHash))) throw new Error('scene_memory_card_source_spans_invalid')
  const spanIds = (card.sourceSpans as Array<Record<string, unknown>>).map((span) => String(span.spanId))
  if (new Set(spanIds).size !== spanIds.length) throw new Error('scene_memory_card_duplicate_span')
  if (!object(card.embedding) || !['ready', 'unavailable', 'stale'].includes(String(card.embedding.status)) || (card.embedding.version !== null && !nonEmpty(card.embedding.version)) || (card.embedding.modelId !== null && !nonEmpty(card.embedding.modelId)) || (card.embedding.dimensions !== null && (!Number.isInteger(card.embedding.dimensions) || Number(card.embedding.dimensions) <= 0)) || (card.embedding.vectorHash !== null && !hash(card.embedding.vectorHash))) throw new Error('scene_memory_card_embedding_invalid')
  if (card.embedding.status === 'ready' && (!nonEmpty(card.embedding.version) || !nonEmpty(card.embedding.modelId) || !Number.isInteger(card.embedding.dimensions) || !hash(card.embedding.vectorHash))) throw new Error('scene_memory_card_embedding_incomplete')
  if (!object(card.fieldEvidence) || Object.values(card.fieldEvidence).some((refsValue) => !refs(refsValue))) throw new Error('scene_memory_card_field_evidence_invalid')
}

function sceneMemoryCardFromRow(row: { [key: string]: unknown }): SceneMemoryCard {
  const visibility = row.visibility
  if (typeof visibility !== 'string' || !['active', 'stale', 'retracted', 'legacy_unverified', 'pending'].includes(visibility)) throw new Error('scene_memory_card_visibility_corrupt')
  if (typeof row.card_json !== 'string' || typeof row.card_hash !== 'string' || !SCENE_MEMORY_HASH.test(row.card_hash)) throw new Error('scene_memory_card_corrupt')
  let card: unknown
  try { card = JSON.parse(row.card_json) } catch { throw new Error('scene_memory_card_corrupt') }
  if (!card || typeof card !== 'object') throw new Error('scene_memory_card_corrupt')
  assertPersistedSceneMemoryCardShape(card)
  const candidate = card as SceneMemoryCard
  const authority: Array<[string, unknown, unknown]> = [
    ['schema_version', row.schema_version, candidate.schemaVersion],
    ['card_id', row.card_id, candidate.cardId],
    ['status', row.status, candidate.status],
    ['story_id', row.story_id, candidate.storyId],
    ['project_id', row.project_id, candidate.projectId],
    ['branch_id', row.branch_id, candidate.branchId],
    ['validity_epoch', row.validity_epoch, candidate.validityEpoch],
    ['story_revision', row.story_revision, candidate.storyRevision],
    ['run_id', row.run_id, candidate.runId],
    ['scene_id', row.scene_id, candidate.sceneId],
    ['scene_order', row.scene_order, candidate.sceneOrder],
    ['contract_id', row.contract_id, candidate.contractId],
    ['contract_hash', row.contract_hash, candidate.contractHash],
    ['scene_content_hash', row.scene_content_hash, candidate.sceneContentHash],
    ['commit_manifest_hash', row.commit_manifest_hash, candidate.commitManifestHash],
    ['state_delta_hash', row.state_delta_hash, candidate.stateDeltaHash],
    ['card_hash', row.card_hash, candidate.cardHash],
    ['created_at', row.created_at, candidate.createdAt]
  ]
  if (authority.some(([, actual, expected]) => actual !== expected)) throw new Error('scene_memory_card_column_mismatch')
  if (candidate.cardHash !== row.card_hash || sceneMemoryCardHash(candidate) !== row.card_hash) throw new Error('scene_memory_card_hash_mismatch')
  if (!Number.isFinite(Number(row.updated_at))) throw new Error('scene_memory_card_timestamp_corrupt')
  return candidate
}

function sceneMemoryScopeIdentity(card: Pick<SceneMemoryCard, 'storyId' | 'projectId' | 'branchId' | 'sceneId' | 'storyRevision' | 'validityEpoch' | 'commitManifestHash'>): string {
  return stableSceneMemoryJson({ storyId: card.storyId, projectId: card.projectId, branchId: card.branchId, sceneId: card.sceneId, storyRevision: card.storyRevision, validityEpoch: card.validityEpoch, commitManifestHash: card.commitManifestHash })
}

function sourceSegmentFromRow(row: ManuscriptSegmentRow, manifestHash: string): SceneMemorySourceSegment {
  if (!row.scene_id || row.status !== 'accepted' || row.kind !== 'prose') throw new Error('scene_memory_source_segment_not_accepted')
  return {
    segmentId: row.segment_id,
    content: row.content,
    contentHash: row.content_hash,
    segmentRevision: row.revision,
    status: row.status,
    sceneId: row.scene_id,
    commitId: `${row.run_id}:${row.scene_id}`,
    commitManifestHash: manifestHash,
    chunkIndex: row.chunk_index
  }
}

const ACCEPTED_PREFIX_CACHE_SCHEMA_VERSION = 1
const ACCEPTED_PREFIX_DOMAIN = 'deepwriter:accepted-prefix:v1'

interface AcceptedPrefixCacheRow {
  run_id: string
  schema_version: number
  state: 'valid' | 'invalid'
  prefix_hash: string
  accepted_char_count: number
  accepted_segment_count: number
  last_chunk_index: number | null
  last_revision: number | null
  last_created_at: number | null
  last_segment_id: string | null
  cache_revision: number
  updated_at: number
}

interface AcceptedPrefixSegmentIdentity {
  segment_id: string
  content_hash: string
  char_count: number
  chunk_index: number
  revision: number
  created_at: number
}

function acceptedPrefixIdentityValid(segment: AcceptedPrefixSegmentIdentity): boolean {
  return typeof segment.segment_id === 'string' && segment.segment_id.length > 0 &&
    typeof segment.content_hash === 'string' && /^[0-9a-f]{64}$/u.test(segment.content_hash) &&
    Number.isSafeInteger(segment.char_count) && segment.char_count >= 0 &&
    Number.isSafeInteger(segment.chunk_index) && segment.chunk_index >= 0 &&
    Number.isSafeInteger(segment.revision) && segment.revision >= 1 &&
    Number.isFinite(segment.created_at)
}

function acceptedPrefixSeedHash(): string {
  return manuscriptSegmentHash(`${ACCEPTED_PREFIX_DOMAIN}\u0000empty`)
}

/**
 * A chained, length/identity-bound digest is intentionally used here rather
 * than re-hashing the entire concatenated manuscript.  content_hash is the
 * SHA-256 of the exact segment body and every ordering field participates in
 * the chain, so a changed body, boundary, identity, or order cannot reuse the
 * previous manifest.  The chain is persisted and advances in O(1) for an
 * append; a replacement/reorder rebuilds once at the write boundary.
 */
function acceptedPrefixStepHash(previous: string, segment: AcceptedPrefixSegmentIdentity): string {
  return manuscriptSegmentHash([
    ACCEPTED_PREFIX_DOMAIN,
    previous,
    segment.segment_id,
    segment.content_hash,
    String(segment.char_count),
    String(segment.chunk_index),
    String(segment.revision),
    String(segment.created_at)
  ].join('\u0000'))
}

function acceptedPrefixOrderCompare(a: AcceptedPrefixSegmentIdentity, b: AcceptedPrefixSegmentIdentity): number {
  return a.chunk_index - b.chunk_index || a.revision - b.revision || a.created_at - b.created_at || a.segment_id.localeCompare(b.segment_id)
}

function acceptedPrefixOrderAfter(a: AcceptedPrefixSegmentIdentity, b: AcceptedPrefixCacheRow): boolean {
  if (b.last_chunk_index === null || b.last_revision === null || b.last_created_at === null || b.last_segment_id === null) return true
  return a.chunk_index > b.last_chunk_index ||
    (a.chunk_index === b.last_chunk_index && (a.revision > b.last_revision ||
      (a.revision === b.last_revision && (a.created_at > b.last_created_at ||
        (a.created_at === b.last_created_at && a.segment_id > b.last_segment_id)))))
}

function sceneCommitManifestHash(manifest: SceneCommitManifest): string {
  return manuscriptSegmentHash(stableNarrativeJson(manifest))
}

function parseSceneCommitManifest(value: unknown): SceneCommitManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('scene_commit_manifest_corrupt')
  const input = value as Record<string, unknown>
  const acceptedSegments = input.acceptedSegments
  if (input.schemaVersion !== 1 || typeof input.runId !== 'string' || typeof input.sceneId !== 'string' ||
    typeof input.contractId !== 'string' || typeof input.contractHash !== 'string' || !SCENE_COMMIT_HASH.test(input.contractHash) ||
    !Array.isArray(acceptedSegments) || typeof input.sceneContentHash !== 'string' || !SCENE_COMMIT_HASH.test(input.sceneContentHash) ||
    !Number.isInteger(input.sceneCharCount) || (input.sceneCharCount as number) < 0 || typeof input.completionDecisionHash !== 'string' ||
    !SCENE_COMMIT_HASH.test(input.completionDecisionHash) || typeof input.stateDeltaHash !== 'string' || !SCENE_COMMIT_HASH.test(input.stateDeltaHash)) {
    throw new Error('scene_commit_manifest_corrupt')
  }
  const ids = new Set<string>()
  let previousOrder: [number, number, string] | null = null
  const normalized = acceptedSegments.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('scene_commit_manifest_corrupt')
    const segment = item as Record<string, unknown>
    if (typeof segment.segmentId !== 'string' || !segment.segmentId || ids.has(segment.segmentId) || typeof segment.contentHash !== 'string' ||
      !SCENE_COMMIT_HASH.test(segment.contentHash) || !Number.isInteger(segment.charCount) || (segment.charCount as number) < 0 ||
      !Number.isInteger(segment.chunkIndex) || (segment.chunkIndex as number) < 0 || !Number.isInteger(segment.revision) || (segment.revision as number) < 1) {
      throw new Error('scene_commit_manifest_corrupt')
    }
    const order: [number, number, string] = [segment.chunkIndex as number, segment.revision as number, segment.segmentId as string]
    if (previousOrder && (order[0] < previousOrder[0] || (order[0] === previousOrder[0] && (order[1] < previousOrder[1] || (order[1] === previousOrder[1] && order[2] <= previousOrder[2]))))) {
      throw new Error('scene_commit_manifest_order_invalid')
    }
    previousOrder = order
    ids.add(segment.segmentId as string)
    return {
      segmentId: segment.segmentId as string,
      contentHash: segment.contentHash as string,
      charCount: segment.charCount as number,
      chunkIndex: segment.chunkIndex as number,
      revision: segment.revision as number
    }
  })
  return {
    schemaVersion: 1,
    runId: input.runId as string,
    sceneId: input.sceneId as string,
    contractId: input.contractId as string,
    contractHash: input.contractHash as string,
    acceptedSegments: normalized,
    sceneContentHash: input.sceneContentHash as string,
    sceneCharCount: input.sceneCharCount as number,
    completionDecisionHash: input.completionDecisionHash as string,
    stateDeltaHash: input.stateDeltaHash as string
  }
}

function buildSceneCommitManifest(input: {
  runId: string
  sceneId: string
  contractId: string
  contractHash: string
  acceptedSegments: readonly Pick<ManuscriptSegmentRow, 'segment_id' | 'content_hash' | 'char_count' | 'chunk_index' | 'revision' | 'content'>[]
  decision: SceneCompletionDecision
  stateDeltaHash: string
}): SceneCommitManifest {
  const acceptedSegments = [...input.acceptedSegments]
    .sort((a, b) => a.chunk_index - b.chunk_index || a.revision - b.revision || a.segment_id.localeCompare(b.segment_id))
    .map((segment) => ({
      segmentId: segment.segment_id,
      contentHash: segment.content_hash,
      charCount: segment.char_count,
      chunkIndex: segment.chunk_index,
      revision: segment.revision
    }))
  const content = [...input.acceptedSegments]
    .sort((a, b) => a.chunk_index - b.chunk_index || a.revision - b.revision || a.segment_id.localeCompare(b.segment_id))
    .map((segment) => segment.content)
    .join('')
  const manifest: SceneCommitManifest = {
    schemaVersion: 1,
    runId: input.runId,
    sceneId: input.sceneId,
    contractId: input.contractId,
    contractHash: input.contractHash,
    acceptedSegments,
    sceneContentHash: manuscriptSegmentHash(content),
    sceneCharCount: codePointLength(content),
    completionDecisionHash: manuscriptSegmentHash(stableNarrativeJson(input.decision)),
    stateDeltaHash: input.stateDeltaHash
  }
  return manifest
}

function sameSceneCommitManifest(a: SceneCommitManifest, b: SceneCommitManifest): boolean {
  return sceneCommitManifestHash(a) === sceneCommitManifestHash(b) && stableNarrativeJson(a) === stableNarrativeJson(b)
}

function sameSceneManifestSegments(a: readonly SceneCommitManifest['acceptedSegments'][number][], b: readonly SceneCommitManifest['acceptedSegments'][number][]): boolean {
  return stableNarrativeJson(a) === stableNarrativeJson(b)
}

function readAcceptedSceneRows(db: SqliteDb, runId: string, sceneId: string): ManuscriptSegmentRow[] {
  return db.prepare(`SELECT * FROM manuscript_segments
    WHERE run_id = ? AND scene_id = ? AND status = 'accepted' AND kind = 'prose'
    ORDER BY chunk_index ASC, revision ASC, created_at ASC, segment_id ASC`).all(runId, sceneId) as unknown as ManuscriptSegmentRow[]
}

function acceptedSceneContentHash(rows: readonly ManuscriptSegmentRow[], excludeSegmentId?: string): string {
  return manuscriptSegmentHash(rows
    .filter((row) => row.segment_id !== excludeSegmentId)
    .sort((a, b) => a.chunk_index - b.chunk_index || a.revision - b.revision || a.created_at - b.created_at || a.segment_id.localeCompare(b.segment_id))
    .map((row) => row.content)
    .join(''))
}

export interface NarrativeLedgerRow {
  run_id: string
  scene_id: string
  change_id: string
  change_revision: number
  accepted_segment_id: string
  accepted_content_hash: string
  contract_hash: string
  change_kind: NarrativeLedgerEntry['kind']
  entity_id: string
  payload_json: string
  delta_hash: string
  committed_at: number
}

export interface RepositoryTestHooks {
  beforeNarrativeLedgerInsert?: () => void
  afterNarrativeLedgerInsert?: () => void
  /** Fault seams for proving the WP5 card/index writes participate in the
   * same commit transaction as canonical prose and ledger rows. */
  beforeSceneMemoryCardInsert?: () => void
  afterSceneMemoryCardInsert?: () => void
  beforeSceneRecallIndexMetaWrite?: () => void
  afterSceneRecallIndexMetaWrite?: () => void
  /** Fault seam for proving evidence-mirror publication is all-or-nothing. */
  beforeRunEvidenceBundleEntry?: (kind: string) => void
}

export interface ManuscriptBackfillWriteHooks {
  afterSegmentWrite?: () => void
}

export interface UsageRow {
  id: number
  run_id: string
  call_type: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_hit: number
  cache_miss: number
  cost: number
  pricing_version: string
  created_at: number
}

export interface UsageTotals {
  input_tokens: number
  output_tokens: number
  cache_hit: number
  cache_miss: number
  cost: number
  calls: number
}

export interface ProviderAttemptRow {
  attempt_id: string
  run_id: string
  logical_call_id: string
  attempt_no: number
  stage_id: string | null
  actor: 'writer' | 'critic' | 'editor'
  subtype: string | null
  provider_id: string
  provider_endpoint_origin: string
  model_id: string
  provider_request_id: string | null
  outcome: ProviderAttemptRecord['outcome']
  http_status: number | null
  started_at: number
  first_token_at: number | null
  ended_at: number | null
  input_tokens: number | null
  output_tokens: number | null
  cache_hit_tokens: number | null
  cache_miss_tokens: number | null
  reasoning_tokens: number | null
  cost_status: ProviderAttemptRecord['costStatus']
  cost_amount: number | null
  cost_currency: string | null
  price_snapshot_id: string | null
  adapter_id?: string | null
  profile_id?: string | null
  credential_ref_id?: string | null
  applied_mappings_json?: string | null
  omitted_controls_json?: string | null
  context_manifest_id?: string | null
  context_mode?: 'full' | 'optimized' | 'minimal' | null
}

function safeJsonArray(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function storyLedgerNodeHash(db: SqliteDb, scopeInput: NarrativeLedgerScope, revision: number, visited = new Set<string>()): string | null {
  const scope = validateNarrativeLedgerScope(scopeInput)
  const key = narrativeLedgerScopeKey(scope)
  if (visited.has(key)) throw new Error('story_ledger_branch_cycle')
  visited.add(key)
  try {
    const head = db.prepare('SELECT high_watermark, parent_branch_id, parent_revision FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as { high_watermark?: number; parent_branch_id?: string | null; parent_revision?: number } | undefined
    if (!head) return null
    if (!Number.isInteger(revision) || revision < 0 || revision > Number(head.high_watermark ?? 0)) return null
    const revisionRow = db.prepare(`SELECT revision_hash FROM story_ledger_revisions
      WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?`).get(scope.storyId, scope.projectId, scope.branchId, revision) as { revision_hash?: unknown } | undefined
    const tombstoneRow = db.prepare(`SELECT tombstone_hash FROM story_ledger_tombstones
      WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?`).get(scope.storyId, scope.projectId, scope.branchId, revision) as { tombstone_hash?: unknown } | undefined
    if (revisionRow && tombstoneRow) throw new Error('story_ledger_duplicate_node_revision')
    if (revisionRow) {
      if (typeof revisionRow.revision_hash !== 'string' || revisionRow.revision_hash.length === 0) throw new Error('story_ledger_revision_hash_missing')
      return revisionRow.revision_hash
    }
    if (tombstoneRow) {
      if (typeof tombstoneRow.tombstone_hash !== 'string' || tombstoneRow.tombstone_hash.length === 0) throw new Error('story_ledger_tombstone_hash_missing')
      return tombstoneRow.tombstone_hash
    }
    if (head.parent_branch_id !== null && head.parent_branch_id !== undefined && revision <= Number(head.parent_revision ?? 0)) {
      return storyLedgerNodeHash(db, { schemaVersion: 1, storyId: scope.storyId, projectId: scope.projectId, branchId: head.parent_branch_id }, revision, visited)
    }
    return null
  } finally {
    visited.delete(key)
  }
}

/** Return the epoch visible immediately after a revision in a scope. */
function storyLedgerEpochAt(db: SqliteDb, scopeInput: NarrativeLedgerScope, revision: number, visited = new Set<string>()): number {
  const scope = validateNarrativeLedgerScope(scopeInput)
  const key = narrativeLedgerScopeKey(scope)
  if (visited.has(key)) throw new Error('story_ledger_branch_cycle')
  visited.add(key)
  try {
    const head = db.prepare('SELECT * FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as StoryLedgerHeadRow | undefined
    if (!head) throw new Error('story_ledger_scope_missing')
    if (!Number.isInteger(revision) || revision < 0 || revision > head.high_watermark) throw new Error('story_ledger_revision_unavailable')
    const parentEpoch = Number.isInteger(head.parent_validity_epoch) && head.parent_validity_epoch >= 1 ? head.parent_validity_epoch : 1
    if (head.parent_branch_id !== null && revision <= head.parent_revision) {
      return storyLedgerEpochAt(db, { schemaVersion: 1, storyId: scope.storyId, projectId: scope.projectId, branchId: head.parent_branch_id }, revision, visited)
    }
    if (revision === 0 || revision === head.parent_revision) return parentEpoch
    const revisionRow = db.prepare('SELECT node_type, validity_epoch FROM story_ledger_revisions WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?').get(scope.storyId, scope.projectId, scope.branchId, revision) as { node_type?: string; validity_epoch?: number } | undefined
    const tombstoneRow = db.prepare('SELECT validity_epoch, next_validity_epoch FROM story_ledger_tombstones WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?').get(scope.storyId, scope.projectId, scope.branchId, revision) as { validity_epoch?: number; next_validity_epoch?: number } | undefined
    if (revisionRow && tombstoneRow) throw new Error('story_ledger_duplicate_node_revision')
    if (revisionRow) return Number.isInteger(revisionRow.validity_epoch) && Number(revisionRow.validity_epoch) >= 1 ? Number(revisionRow.validity_epoch) : parentEpoch
    if (tombstoneRow) {
      const next = Number(tombstoneRow.next_validity_epoch ?? (Number(tombstoneRow.validity_epoch ?? parentEpoch) + 1))
      if (!Number.isInteger(next) || next < 1) throw new Error('story_ledger_epoch_invalid')
      return next
    }
    throw new Error('story_ledger_revision_unavailable')
  } finally {
    visited.delete(key)
  }
}

/** Resolve the semantic node type at an inherited or local revision. */
function storyLedgerNodeType(db: SqliteDb, scopeInput: NarrativeLedgerScope, revision: number, visited = new Set<string>()): 'revision' | 'rebase' | 'retraction' | null {
  const scope = validateNarrativeLedgerScope(scopeInput)
  const key = narrativeLedgerScopeKey(scope)
  if (visited.has(key)) throw new Error('story_ledger_branch_cycle')
  visited.add(key)
  try {
    const localRevision = db.prepare('SELECT node_type FROM story_ledger_revisions WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?').get(scope.storyId, scope.projectId, scope.branchId, revision) as { node_type?: string } | undefined
    const localTombstone = db.prepare('SELECT node_type FROM story_ledger_tombstones WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?').get(scope.storyId, scope.projectId, scope.branchId, revision) as { node_type?: string } | undefined
    if (localRevision && localTombstone) throw new Error('story_ledger_duplicate_node_revision')
    if (localRevision?.node_type === 'revision' || localRevision?.node_type === 'rebase') return localRevision.node_type
    if (localTombstone?.node_type === 'retraction') return 'retraction'
    const head = db.prepare('SELECT parent_branch_id, parent_revision FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as { parent_branch_id?: string | null; parent_revision?: number } | undefined
    if (head?.parent_branch_id !== null && head?.parent_branch_id !== undefined && revision <= Number(head.parent_revision ?? 0)) {
      return storyLedgerNodeType(db, { schemaVersion: 1, storyId: scope.storyId, projectId: scope.projectId, branchId: head.parent_branch_id }, revision, visited)
    }
    return null
  } finally {
    visited.delete(key)
  }
}

/** Return the immutable root-to-current branch lineage used by the recall
 * snapshot fence.  This is deliberately read from ledger heads rather than
 * inferred from cards, so an empty/new projection cannot weaken the scope. */
function readStoryLedgerBranchLineage(db: SqliteDb, scope: NarrativeLedgerScope): string[] {
  const lineage: string[] = []
  const visited = new Set<string>()
  let branchId = scope.branchId
  for (;;) {
    if (visited.has(branchId)) throw new Error('story_ledger_branch_cycle')
    visited.add(branchId)
    lineage.unshift(branchId)
    const head = db.prepare('SELECT parent_branch_id FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, branchId) as { parent_branch_id?: string | null } | undefined
    if (!head) throw new Error('story_ledger_scope_missing')
    if (!head.parent_branch_id) break
    branchId = head.parent_branch_id
  }
  return lineage
}

function readStoryLedgerFreshness(db: SqliteDb, runId: string): StoryLedgerFreshness | null {
  const run = db.prepare('SELECT * FROM story_ledger_runs WHERE run_id=?').get(runId) as StoryLedgerRunRow | undefined
  if (!run) return null
  const scope: NarrativeLedgerScope = { schemaVersion: 1, storyId: run.story_id, projectId: run.project_id, branchId: run.branch_id }
  const head = db.prepare('SELECT * FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(run.story_id, run.project_id, run.branch_id) as StoryLedgerHeadRow | undefined
  if (!head) throw new Error('story_ledger_scope_missing')
  const runRevision = Number(run.current_revision)
  const runParentRevision = Number(run.parent_revision)
  const headRevision = Number(head.high_watermark)
  const validityEpoch = Number(run.validity_epoch)
  const headValidityEpoch = Number(head.validity_epoch)
  const runParentEpoch = Number(run.parent_validity_epoch)
  const headParentEpoch = Number(head.parent_validity_epoch)
  const headParentRevision = Number(head.parent_revision)
  if (!Number.isInteger(runRevision) || runRevision < 0 || !Number.isInteger(runParentRevision) || runParentRevision < 0 || !Number.isInteger(headRevision) || headRevision < 0 || !Number.isInteger(headParentRevision) || headParentRevision < 0 || headParentRevision > headRevision || !Number.isInteger(validityEpoch) || validityEpoch < 1 || !Number.isInteger(headValidityEpoch) || headValidityEpoch < 1 || !Number.isInteger(runParentEpoch) || runParentEpoch < 1 || !Number.isInteger(headParentEpoch) || headParentEpoch < 1 || runRevision < runParentRevision || runRevision > headRevision || runParentEpoch !== headParentEpoch) {
    throw new Error('story_ledger_scope_corrupt')
  }
  const runHash = storyLedgerNodeHash(db, scope, runRevision)
  const headHash = head.head_hash ?? null
  const headMatchesCursor = runRevision === headRevision && runHash === headHash
  const epochValid = validityEpoch === headValidityEpoch
  const branchLineage = readStoryLedgerBranchLineage(db, scope)
  return {
    runId,
    scope,
    branchLineage,
    runRevision,
    runHash,
    validityEpoch,
    headRevision,
    headHash,
    headValidityEpoch,
    epochValid,
    headMatchesCursor,
    fresh: epochValid && headMatchesCursor
  }
}

function assertStoryLedgerFreshness(db: SqliteDb, input: StoryLedgerFreshnessExpectation): StoryLedgerFreshness {
  if (!input || typeof input.runId !== 'string' || input.runId.length === 0 || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || !Number.isInteger(input.expectedEpoch) || input.expectedEpoch < 1 || !Number.isInteger(input.expectedHeadRevision) || input.expectedHeadRevision < 0 || (input.expectedHeadHash !== null && typeof input.expectedHeadHash !== 'string')) {
    throw new Error('story_ledger_freshness_input_invalid')
  }
  const current = readStoryLedgerFreshness(db, input.runId)
  if (!current) throw new Error('run_not_found')
  if (!current.epochValid || current.validityEpoch !== input.expectedEpoch || current.headValidityEpoch !== input.expectedEpoch) throw new Error('story_ledger_epoch_invalidated')
  if (!current.headMatchesCursor || current.runRevision !== input.expectedRevision || current.headRevision !== input.expectedHeadRevision || current.headHash !== input.expectedHeadHash) throw new Error('story_ledger_concurrent_head_conflict')
  return current
}

// ---- R4.2 A1：真正原子的 chat accept（PERSIST-ATOMIC-02） ----

/** 原子接受一次 chat 启动所需的全部写点（session + run + 历史 turns + user turn + user message + 幂等键） */
export interface AcceptChatStartInput {
  sessionId: string
  title: string
  model: string
  run: RunRow
  /** canonical 历史按预算裁剪后的 turns（A1 阶段保留旧行为；A5 改为 manifest 引用、不再复制正文） */
  historyTurns?: TurnRow[]
  /** R4.4 Gate 2（S-02）：completion contract 与 run 同事务落库（版本化权威；不保留双真相） */
  completionContract?: { version: number; json: string } | null
  userTurn: TurnRow
  userMsg?: { msg_id: string; role: 'user'; content: string; created_at: number }
}

/** 故障注入钩子（测试专用；生产不传）——逐个写点注入失败验证回滚 */
export interface AcceptChatStartHooks {
  beforeInsertSession?: () => void
  beforeInsertRun?: () => void
  beforeInsertTurn?: () => void
  beforeInsertMessage?: () => void
}

export type AcceptChatStartResult =
  | { ok: true }
  | { ok: false; reason: 'duplicate' | 'busy'; runId: string }

export interface Repository {
  open(): void
  close(): void
  tx(fn: () => void, mode?: 'deferred' | 'immediate'): void
  createRun(r: RunRow): void
  getRun(runId: string): RunRow | null
  /** 持久幂等键（R4-4）：按 (session_id, client_request_id) 查找既有 run */
  findRunByClientRequestId(sessionId: string, clientRequestId: string): RunRow | null
  updateRun(runId: string, patch: Partial<Omit<RunRow, 'run_id'>>): void
  listActiveRuns(): RunRow[]
  listRunsBySession(sessionId: string): RunRow[]
  listRecentRuns(limit: number): RunRow[]
  /** Delete execution rows; optionally append story-ledger tombstones first. */
  deleteRun(runId: string, storyAction?: StoryLedgerDeleteAction): StoryLedgerRetractionResult
  appendTurn(t: TurnRow): void
  getTurnsByRun(runId: string): TurnRow[]
  getRunTurnPreviews(runId: string): Array<{ role: TurnRow['role']; content: string }>
  deleteTurnsByRun(runId: string): void
  saveManuscriptSegment(segment: ManuscriptSegmentRow): void
  getManuscriptSegmentsByRun(runId: string): ManuscriptSegmentRow[]
  getManuscriptReaderSegments(runId: string): ManuscriptReaderSegment[]
  getManuscriptReaderSlices(runId: string, slices: ManuscriptReaderSlice[]): Array<{ content: string }>
  /**
   * R61/P2-4: get the exact accepted-prefix provenance chain plus a bounded
   * recent tail. Production context assembly uses this instead of loading all
   * accepted prose on every provider round. Optional for old test doubles.
   */
  getAcceptedNarrativePrefixSnapshot?(input: {
    runId: string
    recentChars: number
    currentSceneId: string
    currentContractHash: string
    ledger: AcceptedNarrativePrefixLedgerBinding[]
  }): AcceptedNarrativePrefixSnapshot
  /** Test/migration-only compatibility port. Production has no batch accept path. */
  acceptManuscriptSegmentsForTest(runId: string, segmentIds: string[], acceptedAt: number): void
  acceptManuscriptSegment(input: ManuscriptAcceptanceInput): void
  ensureSceneStates(runId: string, plan: SceneContractPlan, at: number): void
  getSceneStates(runId: string): SceneStateRecord[]
  transitionSceneState(input: SceneStateTransitionInput): SceneStateRecord
  commitScene(input: SceneCommitInput): void
  getSceneCommitManifest(runId: string, sceneId: string): SceneCommitManifest | null
  // ---- v1.2.5 WP2：source-bound SceneMemoryCard projection ----
  upsertSceneMemoryCard(input: SceneMemoryProjectionInput): { inserted: boolean; card: SceneMemoryCard }
  /** Fill only the vector sidecar for an already-published, exact card. */
  applySceneMemoryEmbeddingResult(input: SceneMemoryEmbeddingResultInput): SceneMemoryEmbeddingApplyResult
  /** Resume pending projection outbox rows without network or card invention. */
  replaySceneMemoryCardOutbox(options?: SceneMemoryCardOutboxReplayOptions): SceneMemoryCardOutboxReplayResult
  getSceneMemoryCard(query: SceneMemoryCardQuery): SceneMemoryCard | null
  listSceneMemoryCards(scope: SceneMemoryCardScope & { includeHidden?: boolean }): SceneMemoryCard[]
  markSceneMemoryCardVisibility(cardId: string, visibility: 'stale' | 'retracted' | 'legacy_unverified' | 'pending'): void
  rebuildSceneMemoryProjection(scope: SceneMemoryCardScope, cards: readonly SceneMemoryProjectionInput[]): { cardCount: number; cardSetHash: string; indexHash: string }
  getSceneRecallCorpusSnapshot(input: SceneRecallCorpusSnapshotInput): SceneRecallCorpusSnapshot
  saveSceneWorkingSet(input: SceneMemoryWorkingSetInput): void
  getSceneWorkingSet(workingSetId: string, includeHidden?: boolean): SceneWorkingSetReadResult | null
  /** Bind the exact final provider envelope without changing compiler workingSetHash. */
  bindSceneWorkingSetFinalEnvelope(input: SceneWorkingSetFinalEnvelopeInput): void
  /** Re-read the complete working-set + live story fence immediately before a provider attempt. */
  assertSceneWorkingSetFresh(workingSetId: string, expected?: string | null | SceneWorkingSetFreshnessExpectation): SceneWorkingSetReadResult
  saveLongformWorkflowSnapshot(input: { snapshotId: string; storyId: string; projectId: string; branchId: string; validityEpoch: number; storyRevision: number; runId: string; workflowKey: string; workflowRevision: number; status: SceneMemoryWorkflowSnapshotStatus; payload: unknown; payloadHash: string; createdAt?: number }): void
  getLongformWorkflowSnapshot(runId: string, workflowKey: string, workflowRevision?: number): { snapshotId: string; storyId: string; projectId: string; branchId: string; validityEpoch: number; storyRevision: number; runId: string; workflowKey: string; workflowRevision: number; status: SceneMemoryWorkflowSnapshotStatus; payload: unknown; payloadHash: string; createdAt: number; updatedAt: number } | null
  /** Read all revisions for a workflow key so a restart can recover the run
   * binding from the existing authoritative snapshot table. */
  listLongformWorkflowSnapshots?(workflowKey: string): Array<{ snapshotId: string; storyId: string; projectId: string; branchId: string; validityEpoch: number; storyRevision: number; runId: string; workflowKey: string; workflowRevision: number; status: SceneMemoryWorkflowSnapshotStatus; payload: unknown; payloadHash: string; createdAt: number; updatedAt: number }>
  startSceneMemoryBackfill(state: SceneMemoryBackfillState): void
  getSceneMemoryBackfill(backfillId: string): SceneMemoryBackfillState | null
  saveSceneMemoryBackfillStep(input: SceneMemoryBackfillStepInput): void
  /** Re-open a durable cursor; no projection is fabricated without a step. */
  replaySceneMemoryBackfill(input: SceneMemoryBackfillReplayInput): SceneMemoryBackfillReplayResult
  pauseSceneMemoryBackfill(backfillId: string): void
  getNarrativeCommits(runId: string, sceneId?: string): NarrativeCommitRecord[]
  getNarrativeLedger(runId: string, sceneId?: string): NarrativeLedgerEntry[]
  /** Stable story/project/branch scope selected when the run was opened. */
  getNarrativeLedgerScope(runId: string): NarrativeLedgerScopeInfo | null
  /** Read the cursor/head/epoch fence captured around a provider call. */
  getStoryLedgerFreshness(runId: string): StoryLedgerFreshness | null
  /** Fail closed when a provider result was produced from a changed story head. */
  assertStoryLedgerFresh(input: StoryLedgerFreshnessExpectation): StoryLedgerFreshness
  /** Prepare an explicit child branch rooted at the current authoritative head. */
  prepareStoryLedgerRebase(runId: string, branchId?: string): StoryLedgerRebaseResult
  /** Read only the committed parent chain visible to this scope. */
  getNarrativeLedgerByScope(scope: NarrativeLedgerScope, throughRevision?: number): NarrativeLedgerEntry[]
  getStoryLedgerScope(runId: string): NarrativeLedgerScopeInfo | null
  getStoryLedger(scope: NarrativeLedgerScope, throughRevision?: number): NarrativeLedgerEntry[]
  /** Versioned, session-scoped facts used by narrative knowledge edges/context. */
  upsertNarrativeFact(fact: NarrativeFact): NarrativeFact
  getNarrativeFact(factId: string, version?: number): NarrativeFact | null
  getNarrativeFacts(sessionId: string, includeInactive?: boolean): NarrativeFact[]
  resolveNarrativeFactReference(reference: NarrativeFactReference): NarrativeFact | null
  getManuscriptBackfill(runId: string): LegacyManuscriptBackfillState | null
  saveManuscriptBackfillStep(state: LegacyManuscriptBackfillState, segment?: ManuscriptSegmentRow, hooks?: ManuscriptBackfillWriteHooks): void
  upsertToolCall(tc: ToolCallRow): void
  getSessionEditMessageIds(sessionId: string): string[]
  /** Same-session canonical assistant message only; bounded fields, 40 edits per page. */
  getSessionEditTools(sessionId: string, messageId: string, offset: number): ToolCallRow[]
  getSessionFileEvidenceCounts(sessionId: string): Array<{ messageId: string; count: number }>
  getSessionFileEvidenceRunId(sessionId: string, messageId: string): string | null
  chatFileMessageMentions(sessionId: string, runId: string, candidate: string): boolean
  chatFileMessageCandidates(sessionId: string, runId: string, candidates: string[]): string[]
  getRunWrittenFiles(runId: string): Array<{ name: string; args_path: string | null; filename: string | null; result_path: string | null; canonical_path: string | null }>
  getRunFileEvidenceRows(runId: string, offset: number): FileEvidenceRow[]
  workPlanReceipts(runId: string): Iterable<{ result_json: string }>
  getToolCallsByRun(runId: string): ToolCallRow[]
  /** A durable edit identity is valid only when its turn belongs to the same run. */
  getToolCallById(toolCallId: string): ToolCallRow | null
  getCompletedToolCall(runId: string, argsHash: string): ToolCallRow | null
  saveArtifact(a: ArtifactRow): void
  getArtifactsByRun(runId: string): ArtifactRow[]
  getArtifactsBySession(sessionId: string): ArtifactRow[]
  getArtifactsByHash(hash: string): ArtifactRow[]
  saveJob(jobId: string, jobType: string, sessionId: string, runId: string | null, stateJson: string, usageJson: string): void
  getJob(jobId: string): { job_id: string; job_type: string; session_id: string; run_id: string | null; state_json: string; usage_json: string; updated_at: number } | null
  listJobs(sessionId?: string): { job_id: string; job_type: string; state_json: string; updated_at: number }[]
  deleteJob(jobId: string): void
  appendUsage(u: Omit<UsageRow, 'id'>): void
  getUsageByRun(runId: string): UsageRow[]
  getUsageTotals(runId?: string): UsageTotals
  startProviderAttempt(attempt: ProviderAttemptRow): void
  markProviderAttemptFirstToken(attemptId: string, firstTokenAt: number): void
  finishProviderAttempt(attemptId: string, patch: Pick<ProviderAttemptRow, 'outcome' | 'http_status' | 'provider_request_id' | 'ended_at' | 'input_tokens' | 'output_tokens' | 'cache_hit_tokens' | 'cache_miss_tokens' | 'reasoning_tokens' | 'cost_status' | 'cost_amount' | 'cost_currency' | 'price_snapshot_id'>): void
  getProviderAttempts(runId: string): ProviderAttemptRow[]
  getRunBilling(runId: string): RunBillingView | null
  finalizeRunBilling(runId: string): RunBillingView | null
  markDanglingProviderAttemptsInterrupted(): string[]
  appendWorkflowEvent(event: ActivityEvent): void
  getWorkflowEvents(runId: string, afterSeq?: number, limit?: number): ActivityEvent[]
  saveAttachment(a: { att_id: string; session_id: string; turn_id: string | null; file_hash: string; display_name: string; size: number; source_type: string; content_ref: string | null; created_at: number }): void
  getAttachmentsBySession(sessionId: string): { att_id: string; display_name: string; size: number; source_type: string; created_at: number }[]
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  getMeta(key: string): string | null
  setMeta(key: string, value: string): void
  // ---- canonical session（R4.1 / B-04） ----
  listComposerDrafts(): PersistedComposerDraft[]
  saveComposerDraft(input: ComposerDraftWrite): ComposerDraftWriteResult
  createSession(sessionId: string, title: string, model: string): void
  repairGrillSessionIndex(): void
  listSessions(): { session_id: string; title: string; model: string; created_at: number; updated_at: number }[]
  touchSession(sessionId: string, title?: string): void
  deleteSession(sessionId: string): void
  appendSessionMessage(m: { msg_id: string; session_id: string; seq: number; role: string; content: string; reasoning?: string; status?: string; usage_json?: string; rounds?: number; tool_names_json?: string; plan?: string | null; created_at: number }): void
  getSessionMessages(sessionId: string): { msg_id: string; session_id: string; seq: number; role: string; content: string; reasoning: string; status: string; usage_json: string; rounds: number; tool_names_json: string; plan: string | null; created_at: number }[]
  // ---- R4.2 A1：真正原子的 chat accept（单事务提交，PERSIST-ATOMIC-02） ----
  acceptChatStart(input: AcceptChatStartInput, hooks?: AcceptChatStartHooks): AcceptChatStartResult
  // ---- R4.2 A5：context manifest（不可变，每 run 每轮） ----
  saveContextManifest(runId: string, round: number, manifestJson: string): void
  getContextManifests(runId: string): { run_id: string; round: number; manifest_json: string; created_at: number }[]
  // ---- R4.2 A4：recovery decision durable 事件 ----
  appendRecoveryDecision(d: { decision_id: string; run_id: string; tool_call_id: string; decision: string; actor: string; note: string; checkpoint_id: string | null; created_at: number }): void
  getRecoveryDecisions(runId: string): { decision_id: string; run_id: string; tool_call_id: string; decision: string; actor: string; note: string; checkpoint_id: string | null; created_at: number }[]
  // ---- R4.3 Gate 4：CompletionController durable 存储 ----
  saveCompletionContract(runId: string, version: number, json: string): void
  getCompletionContract(runId: string): { run_id: string; version: number; json: string; created_at: number } | null
  saveCompletionEvaluation(runId: string, revision: number, state: string, json: string): void
  getLatestCompletionEvaluation(runId: string): { run_id: string; revision: number; state: string; json: string; created_at: number } | null
  appendCompletionAttempt(runId: string, attempt: number, json: string): void
  getCompletionAttempts(runId: string): Array<{ run_id: string; attempt: number; json: string; created_at: number }>
  // ---- R4.4 Gate 1：run-scoped durable evidence（renpy_lint 等） ----
  saveRunEvidence(runId: string, kind: string, json: string): void
  /** Append-only evidence claim used by revisioned user decisions. */
  saveRunEvidenceIfAbsent(runId: string, kind: string, json: string): boolean
  /** Atomically publish a canonical evidence row and its rebuildable mirrors. */
  saveRunEvidenceBundle(runId: string, entries: Array<{ kind: string; json: string }>): void
  getRunEvidence(runId: string, kind: string): { run_id: string; kind: string; json: string; created_at: number } | null
  getRunSteeringRows(runId: string): Array<{ kind: string; json: string }>
  nextSessionMessageSeq(sessionId: string): number
  getSteeringAdmission(runId: string, turnId: string): { busy: boolean; duplicate: boolean; nextSeq: number }
  acceptSteeringMessage(sessionId: string, msgId: string, text: string): boolean
  moveActiveAssistantAfterSteering(runId: string, sessionId: string): void
  // ---- R4.6 Grill Me：跨重启采访/大纲工作台 ----
  saveGrillMeState(state: GrillMeState): void
  getGrillMeState(sessionId: string): GrillMeState | null
  /** 只读恢复最近一条尚未被任何 run 消费的 Grill 状态。 */
  getLatestUnconsumedGrillMeState(preferredSessionId?: string): GrillMeState | null
  deleteGrillMeState(sessionId: string): void
  /** 一次性 JSONL 迁移标记（meta 键） */
}

export function createRepository(dbPath: string, testHooks: RepositoryTestHooks = {}): Repository {
  let db: SqliteDb | null = null
  // Repository methods are also called from larger atomic adapters (for
  // example turn+segment and legacy backfill writes).  SQLite does not allow
  // nested BEGIN statements, so keep one connection-local depth counter and
  // let inner calls participate in the outer transaction.
  let transactionDepth = 0

  const requireDb = (): SqliteDb => {
    if (!db) throw new Error('repository not open')
    return db
  }

  const ensureStoryHead = (d: SqliteDb, scope: NarrativeLedgerScope, parentBranchId: string | null, parentRevision: number, at: number): StoryLedgerHeadRow => {
    validateNarrativeLedgerScope(scope)
    const existing = d.prepare('SELECT * FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as StoryLedgerHeadRow | undefined
    if (existing) {
      if (existing.parent_branch_id !== parentBranchId || (existing.parent_revision !== parentRevision && existing.high_watermark === 0)) throw new Error('story_ledger_branch_identity_mismatch')
      return existing
    }
    let parentHash: string | null = null
    if (parentBranchId !== null && parentRevision > 0) {
      parentHash = storyLedgerNodeHash(d, { schemaVersion: 1, storyId: scope.storyId, projectId: scope.projectId, branchId: parentBranchId }, parentRevision)
      if (!parentHash) throw new Error('story_ledger_parent_revision_missing')
    }
    const parentValidityEpoch = parentBranchId !== null && parentRevision > 0
      ? storyLedgerEpochAt(d, { schemaVersion: 1, storyId: scope.storyId, projectId: scope.projectId, branchId: parentBranchId }, parentRevision)
      : 1
    d.prepare(`INSERT INTO story_ledger_heads (
      story_id, project_id, branch_id, parent_story_id, parent_project_id, parent_branch_id,
      parent_revision, high_watermark, head_hash, hash_schema_version, validity_epoch, parent_validity_epoch, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      scope.storyId, scope.projectId, scope.branchId,
      parentBranchId !== null ? scope.storyId : null,
      parentBranchId !== null ? scope.projectId : null,
      parentBranchId, parentRevision, parentRevision, parentHash, 2, parentValidityEpoch, parentValidityEpoch, at
    )
    const created = d.prepare('SELECT * FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as StoryLedgerHeadRow | undefined
    if (!created) throw new Error('story_ledger_head_missing')
    return created
  }

  const ensureStoryRunScope = (d: SqliteDb, runId: string, sessionId: string, configJson: string, at: number): StoryLedgerRunRow => {
    const parsed = narrativeLedgerScopeFromConfig(sessionId, configJson)
    const scope = parsed.scope
    const existing = d.prepare('SELECT * FROM story_ledger_runs WHERE run_id=?').get(runId) as StoryLedgerRunRow | undefined
    if (existing) {
      if (existing.story_id !== scope.storyId || existing.project_id !== scope.projectId || existing.branch_id !== scope.branchId || (parsed.parentBranchId !== null && existing.parent_branch_id !== parsed.parentBranchId) || (parsed.parentRevision !== null && existing.parent_revision !== parsed.parentRevision)) throw new Error('story_ledger_run_scope_mismatch')
      return existing
    }
    const branchHead = d.prepare('SELECT * FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as StoryLedgerHeadRow | undefined
    let parentBranchId = parsed.parentBranchId
    let parentRevision = parsed.parentRevision
    if (!branchHead) {
      if (parentBranchId !== null) {
        if (parentRevision === null) throw new Error('story_ledger_parent_revision_required')
        const parentHead = d.prepare('SELECT high_watermark FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, parentBranchId) as { high_watermark?: number } | undefined
        if (!parentHead) throw new Error('story_ledger_parent_revision_missing')
        // The generated `rebase_` branch is the product recovery path and must
        // be rooted at the current authoritative head.  Explicitly named
        // historical branches remain supported for authoring old revisions.
        if (scope.branchId.startsWith('rebase_') && Number(parentHead.high_watermark ?? 0) !== parentRevision) throw new Error('story_ledger_parent_stale')
      }
      if (parentRevision === null) parentRevision = 0
      ensureStoryHead(d, scope, parentBranchId, parentRevision, at)
    } else {
      if (parentBranchId !== null && parentBranchId !== branchHead.parent_branch_id) throw new Error('story_ledger_branch_identity_mismatch')
      // A pending recovery action carries the branch root (the tombstone
      // head) in its config.  Once that branch has accepted a scene, the
      // root revision is intentionally behind the durable branch head; it
      // must still be reusable for the next run on the same safe branch.
      // Ordinary explicit historical scopes keep the stricter stale-parent
      // check used before the epoch/rebase flow existed.
      const generatedRebaseRoot = scope.branchId.startsWith('rebase_') && parentRevision !== null && parentRevision === branchHead.parent_revision && (parentBranchId === null || parentBranchId === branchHead.parent_branch_id)
      if (parentRevision !== null && parentRevision !== branchHead.high_watermark && !generatedRebaseRoot) throw new Error('story_ledger_parent_stale')
      parentBranchId = branchHead.parent_branch_id
      parentRevision = branchHead.high_watermark
    }
    const revision = parentRevision ?? 0
    const validityEpoch = Number(branchHead?.validity_epoch ?? 0) >= 1
      ? Number(branchHead?.validity_epoch)
      : parentBranchId !== null && revision > 0
        ? storyLedgerEpochAt(d, { schemaVersion: 1, storyId: scope.storyId, projectId: scope.projectId, branchId: parentBranchId }, revision)
        : 1
    const parentValidityEpoch = Number(branchHead?.parent_validity_epoch ?? 0) >= 1
      ? Number(branchHead?.parent_validity_epoch)
      : parentBranchId !== null && revision > 0
        ? storyLedgerEpochAt(d, { schemaVersion: 1, storyId: scope.storyId, projectId: scope.projectId, branchId: parentBranchId }, revision)
        : 1
    d.prepare(`INSERT INTO story_ledger_runs (
      run_id, story_id, project_id, branch_id, parent_story_id, parent_project_id, parent_branch_id,
      parent_revision, current_revision, validity_epoch, parent_validity_epoch, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      runId, scope.storyId, scope.projectId, scope.branchId,
      parentBranchId !== null ? scope.storyId : null,
      parentBranchId !== null ? scope.projectId : null,
      parentBranchId, revision, revision, validityEpoch, parentValidityEpoch, at, at
    )
    const created = d.prepare('SELECT * FROM story_ledger_runs WHERE run_id=?').get(runId) as StoryLedgerRunRow | undefined
    if (!created) throw new Error('story_ledger_run_missing')
    return created
  }

  const decodeStoryRevision = (row: StoryLedgerRevisionRow): NarrativeLedgerEntry[] => {
    if (row.hash_schema_version !== 2 || (row.node_type !== 'revision' && row.node_type !== 'rebase') || typeof row.parent_hash !== 'string' && row.parent_hash !== null || !Number.isInteger(row.validity_epoch) || row.validity_epoch < 1) throw new Error('story_ledger_legacy_hash_schema')
    if (row.node_type === 'rebase' && (row.rebase_parent_revision !== row.parent_revision || row.rebase_parent_hash !== row.parent_hash)) throw new Error('story_ledger_rebase_parent_mismatch')
    if (row.node_type === 'revision' && (row.rebase_parent_revision !== null || row.rebase_parent_hash !== null)) throw new Error('story_ledger_rebase_parent_mismatch')
    let delta: NarrativeStateDelta
    try { delta = normalizeNarrativeStateDelta(JSON.parse(row.delta_json)) } catch { throw new Error('story_ledger_delta_corrupt') }
    if (delta.deltaHash !== row.delta_hash || delta.acceptedSegmentId !== row.accepted_segment_id || delta.acceptedContentHash !== row.accepted_content_hash || delta.contractHash !== row.contract_hash || delta.runId !== row.run_id || delta.sceneId !== row.scene_id) throw new Error('story_ledger_binding_mismatch')
    if (row.manifest_json !== null) {
      if (!row.manifest_hash) throw new Error('story_ledger_manifest_corrupt')
      let manifest: SceneCommitManifest
      try { manifest = parseSceneCommitManifest(JSON.parse(row.manifest_json)) } catch { throw new Error('story_ledger_manifest_corrupt') }
      if (manifest.runId !== row.run_id || manifest.sceneId !== row.scene_id || sceneCommitManifestHash(manifest) !== row.manifest_hash) throw new Error('story_ledger_manifest_binding_mismatch')
    } else if (row.manifest_hash !== null) {
      throw new Error('story_ledger_manifest_binding_mismatch')
    }
    const expectedRevisionHash = storyLedgerRevisionHashV2({
      storyId: row.story_id,
      projectId: row.project_id,
      branchId: row.branch_id,
      revision: row.revision,
      parentRevision: row.parent_revision,
      parentHash: row.parent_hash,
      runId: row.run_id,
      sceneId: row.scene_id,
      deltaHash: row.delta_hash,
      manifestHash: row.manifest_hash,
      nodeType: row.node_type,
      hashSchemaVersion: 2
    })
    if (row.revision_hash !== expectedRevisionHash) throw new Error('story_ledger_revision_hash_mismatch')
    return delta.changes.map((change) => ({ ...change, deltaHash: row.delta_hash, committedAt: row.committed_at, storyId: row.story_id, projectId: row.project_id, branchId: row.branch_id, storyRevision: row.revision, storyValidityEpoch: row.validity_epoch }))
  }

  type StoryLedgerNode = {
    revision: number
    hash: string
    parentRevision: number
    parentHash: string | null
    nodeType: 'revision' | 'rebase' | 'retraction'
    hashSchemaVersion: number
    validityEpoch: number
    rebaseParentRevision: number | null
    rebaseParentHash: string | null
    entries: NarrativeLedgerEntry[]
    tombstone: StoryLedgerTombstoneRow | null
  }

  const readStoryLedgerNodes = (d: SqliteDb, scopeInput: NarrativeLedgerScope, throughRevision?: number, visited = new Set<string>()): StoryLedgerNode[] => {
    const scope = validateNarrativeLedgerScope(scopeInput)
    const key = narrativeLedgerScopeKey(scope)
    if (visited.has(key)) throw new Error('story_ledger_branch_cycle')
    visited.add(key)
    try {
      const head = d.prepare('SELECT * FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as StoryLedgerHeadRow | undefined
      if (!head) throw new Error('story_ledger_scope_missing')
      if (head.hash_schema_version !== 2) throw new Error('story_ledger_legacy_hash_schema')
      const requestedRevision = throughRevision === undefined ? head.high_watermark : throughRevision
      const maxRevision = requestedRevision
      if (!Number.isInteger(maxRevision) || maxRevision < 0 || maxRevision > head.high_watermark) throw new Error('story_ledger_revision_unavailable')
      const inheritedNodes: StoryLedgerNode[] = []
      if (head.parent_branch_id !== null && head.parent_revision > 0) {
        inheritedNodes.push(...readStoryLedgerNodes(d, { schemaVersion: 1, storyId: scope.storyId, projectId: scope.projectId, branchId: head.parent_branch_id }, head.parent_revision, visited))
      }
      const localNodes: StoryLedgerNode[] = []
      const rows = d.prepare(`SELECT * FROM story_ledger_revisions
        WHERE story_id=? AND project_id=? AND branch_id=? ORDER BY revision ASC, committed_at ASC, COALESCE(scene_id,'') ASC`).all(scope.storyId, scope.projectId, scope.branchId) as unknown as StoryLedgerRevisionRow[]
      for (const row of rows) {
        if (row.hash_schema_version !== 2 || (row.node_type !== 'revision' && row.node_type !== 'rebase') || !Number.isInteger(row.validity_epoch) || row.validity_epoch < 1) throw new Error('story_ledger_legacy_hash_schema')
        if (row.revision < 1 || row.revision > head.high_watermark) throw new Error('story_ledger_revision_out_of_head_range')
        const rebaseParentRevision = row.rebase_parent_revision ?? null
        const rebaseParentHash = row.rebase_parent_hash ?? null
        if (row.node_type === 'rebase' && (rebaseParentRevision !== row.parent_revision || rebaseParentHash !== row.parent_hash)) throw new Error('story_ledger_rebase_parent_mismatch')
        if (row.node_type === 'revision' && (rebaseParentRevision !== null || rebaseParentHash !== null)) throw new Error('story_ledger_rebase_parent_mismatch')
        localNodes.push({ revision: row.revision, hash: row.revision_hash, parentRevision: row.parent_revision, parentHash: row.parent_hash, nodeType: row.node_type, hashSchemaVersion: row.hash_schema_version, validityEpoch: row.validity_epoch, rebaseParentRevision, rebaseParentHash, entries: decodeStoryRevision(row), tombstone: null })
      }

      const tombstones = d.prepare(`SELECT * FROM story_ledger_tombstones
        WHERE story_id=? AND project_id=? AND branch_id=? ORDER BY revision ASC`).all(scope.storyId, scope.projectId, scope.branchId) as unknown as StoryLedgerTombstoneRow[]
      for (const tombstone of tombstones) {
        if (tombstone.hash_schema_version !== 2 || tombstone.node_type !== 'retraction' || !Number.isInteger(tombstone.validity_epoch) || tombstone.validity_epoch < 1 || !Number.isInteger(tombstone.next_validity_epoch) || tombstone.next_validity_epoch <= tombstone.validity_epoch) throw new Error('story_ledger_legacy_hash_schema')
        if (tombstone.revision < 1 || tombstone.revision > head.high_watermark) throw new Error('story_ledger_revision_out_of_head_range')
        const expectedHash = storyLedgerTombstoneHashV2({
          storyId: tombstone.story_id,
          projectId: tombstone.project_id,
          branchId: tombstone.branch_id,
          revision: tombstone.revision,
          parentRevision: tombstone.parent_revision,
          parentHash: tombstone.parent_hash,
          targetRevision: tombstone.target_revision,
          targetRevisionHash: tombstone.target_revision_hash,
          targetRunId: tombstone.target_run_id,
          targetSceneId: tombstone.target_scene_id,
          reason: tombstone.reason,
          nodeType: 'retraction',
          hashSchemaVersion: 2
        })
        if (tombstone.tombstone_hash !== expectedHash) throw new Error('story_ledger_tombstone_hash_mismatch')
        localNodes.push({ revision: tombstone.revision, hash: tombstone.tombstone_hash, parentRevision: tombstone.parent_revision, parentHash: tombstone.parent_hash, nodeType: 'retraction', hashSchemaVersion: tombstone.hash_schema_version, validityEpoch: tombstone.validity_epoch, rebaseParentRevision: null, rebaseParentHash: null, entries: [], tombstone })
      }
      localNodes.sort((a, b) => a.revision - b.revision || (a.tombstone ? 1 : -1))
      const localRevisionSet = new Set<number>()
      for (const node of localNodes) {
        if (localRevisionSet.has(node.revision)) throw new Error('story_ledger_duplicate_node_revision')
        localRevisionSet.add(node.revision)
      }
      const localStart = head.parent_branch_id !== null ? head.parent_revision + 1 : 1
      const expectedLocalCount = head.high_watermark - (head.parent_branch_id !== null ? head.parent_revision : 0)
      if (expectedLocalCount < 0 || localNodes.length !== expectedLocalCount) throw new Error('story_ledger_revision_gap')
      if (localNodes.some((node) => node.revision < localStart || node.revision > head.high_watermark)) throw new Error('story_ledger_revision_out_of_scope')
      const nodes = [...inheritedNodes, ...localNodes]
      nodes.sort((a, b) => a.revision - b.revision || (a.tombstone ? 1 : -1))
      const allByRevision = new Map<number, StoryLedgerNode>()
      let expectedRevision = 1
      let previousHash: string | null = null
      for (const node of nodes) {
        if (allByRevision.has(node.revision)) throw new Error('story_ledger_duplicate_node_revision')
        if (node.revision !== expectedRevision) throw new Error('story_ledger_revision_gap')
        if (node.parentRevision !== expectedRevision - 1 || node.parentHash !== previousHash) throw new Error('story_ledger_parent_hash_mismatch')
        if (node.hashSchemaVersion !== 2) throw new Error('story_ledger_legacy_hash_schema')
        allByRevision.set(node.revision, node)
        expectedRevision += 1
        previousHash = node.hash
      }
      if (expectedRevision - 1 !== head.high_watermark) throw new Error('story_ledger_head_watermark_mismatch')
      if (head.high_watermark === 0 ? head.head_hash !== null : head.head_hash !== previousHash) throw new Error('story_ledger_head_hash_mismatch')
      for (const node of nodes) {
        const tombstone = node.tombstone
        if (!tombstone) continue
        const target = allByRevision.get(tombstone.target_revision)
        if (!target || target.tombstone || target.hash !== tombstone.target_revision_hash) {
          throw new Error('story_ledger_tombstone_target_mismatch')
        }
      }
      // Return the validated chain (including tombstones) to a child branch.
      // The active/stale projection is applied by readStoryLedger after all
      // inherited nodes have been joined; otherwise a child would validate
      // against a parent chain with its tombstone node silently removed.
      return nodes.filter((node) => node.revision <= maxRevision)
    } finally {
      visited.delete(key)
    }
  }

  const readStoryLedger = (d: SqliteDb, scopeInput: NarrativeLedgerScope, throughRevision?: number): NarrativeLedgerEntry[] => {
    const nodes = readStoryLedgerNodes(d, scopeInput, throughRevision)
    const retracted = new Set<number>()
    for (const node of nodes) {
      if (!node.tombstone) continue
      const target = nodes.find((candidate) => candidate.revision === node.tombstone?.target_revision)
      if (!target || target.tombstone || target.hash !== node.tombstone.target_revision_hash) throw new Error('story_ledger_tombstone_target_mismatch')
      retracted.add(node.tombstone.target_revision)
    }
    // Retraction policy: only the causal interval between a target and its
    // tombstone is stale.  Nodes appended after the tombstone belong to the
    // new validity epoch and are authoritative once they are explicitly
    // rebased; otherwise every later node (including a safe r5) would remain
    // hidden forever.
    const staleDueToRetraction = new Set<number>()
    for (const node of nodes) {
      if (!node.tombstone) continue
      const targetRevision = node.tombstone.target_revision
      for (const candidate of nodes) {
        if (!candidate.tombstone && candidate.revision > targetRevision && candidate.revision < node.revision) staleDueToRetraction.add(candidate.revision)
      }
    }
    return nodes
      .filter((node) => !node.tombstone && !retracted.has(node.revision) && !staleDueToRetraction.has(node.revision))
      .flatMap((node) => node.entries)
  }

  const appendStoryRetractions = (d: SqliteDb, runId: string, reason: string, committedAt: number): StoryLedgerRetractionResult => {
    const storyRun = d.prepare('SELECT * FROM story_ledger_runs WHERE run_id=?').get(runId) as StoryLedgerRunRow | undefined
    if (!storyRun) return { action: 'retract', retractedRevisions: 0, headRevision: null }
    const scope = { schemaVersion: 1 as const, storyId: storyRun.story_id, projectId: storyRun.project_id, branchId: storyRun.branch_id }
    const head = d.prepare('SELECT * FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as StoryLedgerHeadRow | undefined
    if (!head) throw new Error('story_ledger_scope_missing')
    if (head.hash_schema_version !== 2) throw new Error('story_ledger_legacy_hash_schema')
    const targets = d.prepare(`SELECT revision, revision_hash, run_id, scene_id
      FROM story_ledger_revisions
      WHERE story_id=? AND project_id=? AND branch_id=? AND run_id=?
      ORDER BY revision ASC`).all(scope.storyId, scope.projectId, scope.branchId, runId) as Array<{ revision: number; revision_hash: string; run_id: string; scene_id: string | null }>
    const existing = new Set((d.prepare(`SELECT target_revision FROM story_ledger_tombstones
      WHERE story_id=? AND project_id=? AND branch_id=?`).all(scope.storyId, scope.projectId, scope.branchId) as Array<{ target_revision: number }>).map((row) => row.target_revision))
    let nextRevision = head.high_watermark
    let parentHash = head.head_hash
    let nextValidityEpoch = Number(head.validity_epoch ?? 1)
    if (!Number.isInteger(nextValidityEpoch) || nextValidityEpoch < 1) throw new Error('story_ledger_epoch_invalid')
    let retractedRevisions = 0
    for (const target of targets) {
      if (existing.has(target.revision)) continue
      if (target.revision > nextRevision) throw new Error('story_ledger_target_revision_unavailable')
      const parentRevision = nextRevision
      nextRevision += 1
      const tombstoneHash = storyLedgerTombstoneHashV2({
        storyId: scope.storyId,
        projectId: scope.projectId,
        branchId: scope.branchId,
        revision: nextRevision,
        parentRevision,
        parentHash,
        targetRevision: target.revision,
        targetRevisionHash: target.revision_hash,
        targetRunId: target.run_id,
        targetSceneId: target.scene_id,
        reason,
        nodeType: 'retraction',
        hashSchemaVersion: 2
      })
      d.prepare(`INSERT INTO story_ledger_tombstones (
        story_id, project_id, branch_id, revision, parent_revision, target_revision,
        target_revision_hash, target_run_id, target_scene_id, reason, parent_hash, node_type,
        hash_schema_version, tombstone_hash, validity_epoch, next_validity_epoch, committed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        scope.storyId, scope.projectId, scope.branchId, nextRevision, parentRevision, target.revision,
        target.revision_hash, target.run_id, target.scene_id, reason, parentHash, 'retraction', 2, tombstoneHash, nextValidityEpoch, nextValidityEpoch + 1, committedAt
      )
      d.prepare('UPDATE story_ledger_heads SET high_watermark=?, head_hash=?, validity_epoch=?, updated_at=? WHERE story_id=? AND project_id=? AND branch_id=?').run(
        nextRevision, tombstoneHash, nextValidityEpoch + 1, committedAt, scope.storyId, scope.projectId, scope.branchId
      )
      parentHash = tombstoneHash
      nextValidityEpoch += 1
      existing.add(target.revision)
      retractedRevisions += 1
    }
    if (retractedRevisions > 0) {
      // Never move a run cursor across a retraction. Active runs that still
      // observe the old epoch are explicitly paused for recovery; this is the
      // durable boundary which prevents a late provider result from committing
      // into a now-invalid story head.
      d.prepare(`UPDATE runs SET status='recovery_required', phase='recovery_required',
          error_code='story_ledger_epoch_invalidated',
          error_message='故事线撤回使当前运行所在的旧有效期失效；请基于当前安全故事线新建分支',
          updated_at=?
        WHERE run_id IN (
          SELECT r.run_id FROM runs r
          JOIN story_ledger_runs sr ON sr.run_id=r.run_id
          WHERE sr.story_id=? AND sr.project_id=? AND sr.branch_id=?
            AND sr.validity_epoch < ?
            AND r.status IN ('queued','running','recoverable','cancelling','cancel_requested','recovery_required','waiting_user')
        )`).run(committedAt, scope.storyId, scope.projectId, scope.branchId, nextValidityEpoch)
    }
    return { action: 'retract', retractedRevisions, headRevision: nextRevision }
  }

  type PartialGraphRow = Pick<ManuscriptSegmentRow, 'segment_id' | 'run_id' | 'scene_id' | 'chunk_index' | 'status' | 'supersedes_segment_id'>

  const partialScopeMatches = (a: PartialGraphRow, b: PartialGraphRow): boolean =>
    a.run_id === b.run_id && a.chunk_index === b.chunk_index && (a.scene_id ?? null) === (b.scene_id ?? null)

  /** Load and validate the complete supersession chain before mutating it. */
  const loadSupersedesChain = (d: SqliteDb, root: PartialGraphRow): ManuscriptSegmentRow[] => {
    const chain: ManuscriptSegmentRow[] = []
    const visited = new Set<string>([root.segment_id])
    let nextId = root.supersedes_segment_id
    while (nextId) {
      if (visited.has(nextId)) throw new Error('manuscript_partial_chain_cycle')
      const parent = d.prepare('SELECT * FROM manuscript_segments WHERE segment_id = ?').get(nextId) as ManuscriptSegmentRow | undefined
      if (!parent) throw new Error('manuscript_partial_chain_broken')
      if (parent.run_id !== root.run_id) throw new Error('manuscript_partial_chain_cross_run')
      if (!partialScopeMatches(parent, root)) throw new Error('manuscript_partial_chain_scope_mismatch')
      if (parent.status === 'accepted') throw new Error('manuscript_segment_accepted_cannot_supersede')
      chain.push(parent)
      visited.add(parent.segment_id)
      nextId = parent.supersedes_segment_id
    }
    return chain
  }

  const supersedePartialAncestors = (d: SqliteDb, chain: readonly ManuscriptSegmentRow[], updatedAt: number): void => {
    for (const parent of chain) {
      if (parent.status !== 'partial') continue
      d.prepare("UPDATE manuscript_segments SET status='superseded', updated_at=? WHERE segment_id=? AND status='partial'").run(updatedAt, parent.segment_id)
    }
  }

  const assertNoActivePartialAncestor = (d: SqliteDb, chain: readonly ManuscriptSegmentRow[]): void => {
    for (const parent of chain) {
      const current = d.prepare('SELECT status FROM manuscript_segments WHERE segment_id = ?').get(parent.segment_id) as { status?: string } | undefined
      if (current?.status === 'partial') throw new Error('manuscript_partial_active_ancestor')
    }
  }

  const validatePartialGraphForRun = (d: SqliteDb, runId: string): void => {
    const rows = d.prepare(`SELECT segment_id, run_id, scene_id, chunk_index, status, supersedes_segment_id
      FROM manuscript_segments WHERE run_id = ?`).all(runId) as unknown as Array<{
        segment_id: string
        run_id: string
        scene_id: string | null
        chunk_index: number
        status: ManuscriptSegmentStatus
        supersedes_segment_id: string | null
      }>
    validateManuscriptPartialGraph(rows.map((row) => ({
      segmentId: row.segment_id,
      runId: row.run_id,
      sceneId: row.scene_id,
      chunkIndex: row.chunk_index,
      status: row.status,
      supersedesSegmentId: row.supersedes_segment_id
    })))
  }

  type AcceptedPrefixDbRow = AcceptedPrefixSegmentIdentity & {
    run_id: string
    scene_id: string | null
    content: string
  }

  const readAcceptedPrefixCache = (d: SqliteDb, runId: string): AcceptedPrefixCacheRow | null => {
    const row = d.prepare('SELECT * FROM narrative_prefix_cache WHERE run_id = ?').get(runId) as AcceptedPrefixCacheRow | undefined
    return row ?? null
  }

  const acceptedPrefixIdentity = (row: Pick<AcceptedPrefixDbRow, 'segment_id' | 'content_hash' | 'char_count' | 'chunk_index' | 'revision' | 'created_at'>): AcceptedPrefixSegmentIdentity => ({
    segment_id: row.segment_id,
    content_hash: row.content_hash,
    char_count: row.char_count,
    chunk_index: row.chunk_index,
    revision: row.revision,
    created_at: row.created_at
  })

  const writeAcceptedPrefixCache = (d: SqliteDb, runId: string, state: {
    prefixHash: string
    acceptedCharCount: number
    acceptedSegmentCount: number
    last: AcceptedPrefixSegmentIdentity | null
    previousRevision?: number
  }): AcceptedPrefixCacheRow => {
    if (!/^[0-9a-f]{64}$/u.test(state.prefixHash) || !Number.isInteger(state.acceptedCharCount) || state.acceptedCharCount < 0 || !Number.isInteger(state.acceptedSegmentCount) || state.acceptedSegmentCount < 0) {
      throw new Error('narrative_prefix_cache_state_invalid')
    }
    const revision = Math.max(0, Number(state.previousRevision ?? 0)) + 1
    const now = Date.now()
    d.prepare(`INSERT INTO narrative_prefix_cache (
      run_id, schema_version, state, prefix_hash, accepted_char_count,
      accepted_segment_count, last_chunk_index, last_revision, last_created_at,
      last_segment_id, cache_revision, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET
      schema_version=excluded.schema_version,
      state=excluded.state,
      prefix_hash=excluded.prefix_hash,
      accepted_char_count=excluded.accepted_char_count,
      accepted_segment_count=excluded.accepted_segment_count,
      last_chunk_index=excluded.last_chunk_index,
      last_revision=excluded.last_revision,
      last_created_at=excluded.last_created_at,
      last_segment_id=excluded.last_segment_id,
      cache_revision=excluded.cache_revision,
      updated_at=excluded.updated_at`).run(
      runId,
      ACCEPTED_PREFIX_CACHE_SCHEMA_VERSION,
      'valid',
      state.prefixHash,
      state.acceptedCharCount,
      state.acceptedSegmentCount,
      state.last?.chunk_index ?? null,
      state.last?.revision ?? null,
      state.last?.created_at ?? null,
      state.last?.segment_id ?? null,
      revision,
      now
    )
    const stored = readAcceptedPrefixCache(d, runId)
    if (!stored || stored.state !== 'valid' || stored.schema_version !== ACCEPTED_PREFIX_CACHE_SCHEMA_VERSION || stored.prefix_hash !== state.prefixHash || stored.cache_revision !== revision) throw new Error('narrative_prefix_cache_write_failed')
    return stored
  }

  const rebuildAcceptedPrefixCache = (d: SqliteDb, runId: string, previous?: AcceptedPrefixCacheRow | null): { cache: AcceptedPrefixCacheRow; readBytes: number } => {
    const rows = d.prepare(`SELECT segment_id, run_id, scene_id, content, content_hash, char_count,
      chunk_index, revision, created_at
      FROM manuscript_segments
      WHERE run_id = ? AND status = 'accepted' AND kind = 'prose'
      ORDER BY chunk_index ASC, revision ASC, created_at ASC, segment_id ASC`).all(runId) as unknown as AcceptedPrefixDbRow[]
    let hash = acceptedPrefixSeedHash()
    let acceptedCharCount = 0
    let readBytes = 0
    for (const row of rows) {
      if (row.run_id !== runId || !acceptedPrefixIdentityValid(row) || row.content_hash !== manuscriptSegmentHash(row.content) || row.char_count !== codePointLength(row.content)) throw new Error('narrative_context_accepted_segment_invalid')
      hash = acceptedPrefixStepHash(hash, acceptedPrefixIdentity(row))
      acceptedCharCount += row.char_count
      readBytes += Buffer.byteLength(row.content, 'utf8')
    }
    const stored = writeAcceptedPrefixCache(d, runId, {
      prefixHash: hash,
      acceptedCharCount,
      acceptedSegmentCount: rows.length,
      last: rows.length > 0 ? acceptedPrefixIdentity(rows[rows.length - 1]!) : null,
      previousRevision: previous?.cache_revision ?? 0
    })
    return { cache: stored, readBytes }
  }

  const readAcceptedPrefixTail = (d: SqliteDb, runId: string, recentChars: number, currentSceneId: string, currentContractHash: string, ledger: AcceptedNarrativePrefixLedgerBinding[]): { recentProse: AcceptedNarrativePrefixRecentProse[]; readBytes: number } => {
    const contractBySegment = new Map<string, string>()
    for (const entry of ledger) {
      if (!contractBySegment.has(entry.acceptedSegmentId)) contractBySegment.set(entry.acceptedSegmentId, entry.contractHash)
    }
    const recent: AcceptedNarrativePrefixRecentProse[] = []
    let selectedChars = 0
    let readBytes = 0
    let cursor: AcceptedPrefixSegmentIdentity | null = null
    const safeRecentChars = Math.max(1, Math.floor(recentChars))
    // Keyset pagination means a long manuscript with tiny segments reads only
    // as much of the tail as the context budget needs; it never OFFSET-scans
    // the full prefix or selects bodies outside the bounded tail.
    for (let page = 0; page < 100000 && selectedChars < safeRecentChars; page += 1) {
      const sql = cursor
        ? `SELECT segment_id, run_id, scene_id, content, content_hash, char_count, chunk_index, revision, created_at
           FROM manuscript_segments WHERE run_id = ? AND status='accepted' AND kind='prose'
           AND (chunk_index < ? OR (chunk_index = ? AND (revision < ? OR (revision = ? AND (created_at < ? OR (created_at = ? AND segment_id < ?))))))
           ORDER BY chunk_index DESC, revision DESC, created_at DESC, segment_id DESC LIMIT 16`
        : `SELECT segment_id, run_id, scene_id, content, content_hash, char_count, chunk_index, revision, created_at
           FROM manuscript_segments WHERE run_id = ? AND status='accepted' AND kind='prose'
           ORDER BY chunk_index DESC, revision DESC, created_at DESC, segment_id DESC LIMIT 16`
      const rows = (cursor
        ? d.prepare(sql).all(runId, cursor.chunk_index, cursor.chunk_index, cursor.revision, cursor.revision, cursor.created_at, cursor.created_at, cursor.segment_id)
        : d.prepare(sql).all(runId)) as unknown as AcceptedPrefixDbRow[]
      if (rows.length === 0) break
      for (const row of rows) {
        if (row.run_id !== runId || row.content_hash !== manuscriptSegmentHash(row.content) || row.char_count !== codePointLength(row.content)) throw new Error('narrative_context_accepted_segment_invalid')
        readBytes += Buffer.byteLength(row.content, 'utf8')
        cursor = acceptedPrefixIdentity(row)
        if (!row.scene_id) continue
        const contractHash = contractBySegment.get(row.segment_id)
        if (!contractHash && row.scene_id !== currentSceneId) continue
        if (recent.length > 0 && selectedChars + row.char_count > safeRecentChars) continue
        recent.push({
          segmentId: row.segment_id,
          runId: row.run_id,
          sceneId: row.scene_id,
          content: row.content,
          contentHash: row.content_hash,
          contractHash: contractHash ?? currentContractHash,
          revision: row.revision
        })
        selectedChars += row.char_count
        if (selectedChars >= safeRecentChars) break
      }
      if (selectedChars >= safeRecentChars || rows.length < 16) break
    }
    recent.reverse()
    return { recentProse: recent, readBytes }
  }

  const refreshAcceptedPrefixCache = (d: SqliteDb, runId: string, before: AcceptedPrefixCacheRow | null, changedSegmentId?: string): AcceptedPrefixCacheRow => {
    // A cache that was already invalid before this Repository transaction may
    // have an unknown external mutation.  Rebuild it rather than treating an
    // append as safe.  Normal Repository writes enter with a valid cache and
    // can therefore advance the chain in O(1).
    if (!before || before.state !== 'valid' || before.schema_version !== ACCEPTED_PREFIX_CACHE_SCHEMA_VERSION || !changedSegmentId) return rebuildAcceptedPrefixCache(d, runId, before).cache
    const changed = d.prepare(`SELECT segment_id, run_id, scene_id, content, content_hash, char_count,
      chunk_index, revision, created_at FROM manuscript_segments
      WHERE run_id = ? AND segment_id = ? AND status='accepted' AND kind='prose'`).get(runId, changedSegmentId) as AcceptedPrefixDbRow | undefined
    if (!changed || !acceptedPrefixIdentityValid(changed) || changed.content_hash !== manuscriptSegmentHash(changed.content) || changed.char_count !== codePointLength(changed.content)) return rebuildAcceptedPrefixCache(d, runId, before).cache
    const latest = d.prepare(`SELECT segment_id, content_hash, char_count, chunk_index, revision, created_at
      FROM manuscript_segments WHERE run_id=? AND status='accepted' AND kind='prose'
      ORDER BY chunk_index DESC, revision DESC, created_at DESC, segment_id DESC LIMIT 1`).get(runId) as AcceptedPrefixSegmentIdentity | undefined
    const oldLast = before.last_segment_id
      ? d.prepare(`SELECT segment_id FROM manuscript_segments WHERE run_id=? AND segment_id=? AND status='accepted' AND kind='prose'`).get(runId, before.last_segment_id)
      : null
    const changedIdentity = acceptedPrefixIdentity(changed)
    if (!latest || latest.segment_id !== changed.segment_id || !acceptedPrefixOrderAfter(changedIdentity, before) || (before.accepted_segment_count > 0 && !oldLast)) {
      return rebuildAcceptedPrefixCache(d, runId, before).cache
    }
    // A single accepted append is the only path that reaches this branch.
    // Replacement, reorder, batch acceptance, deletion, or an external
    // mutation all fail the checks above and rebuild from the canonical rows.
    return writeAcceptedPrefixCache(d, runId, {
      prefixHash: acceptedPrefixStepHash(before.prefix_hash, changedIdentity),
      acceptedCharCount: before.accepted_char_count + changed.char_count,
      acceptedSegmentCount: before.accepted_segment_count + 1,
      last: changedIdentity,
      previousRevision: before.cache_revision
    })
  }

  const getAcceptedNarrativePrefixSnapshot = (input: {
    runId: string
    recentChars: number
    currentSceneId: string
    currentContractHash: string
    ledger: AcceptedNarrativePrefixLedgerBinding[]
  }): AcceptedNarrativePrefixSnapshot => {
    const d = requireDb()
    let cache = readAcceptedPrefixCache(d, input.runId)
    let cacheHit = true
    let readBytes = 0
    if (!cache) {
      const rebuilt = rebuildAcceptedPrefixCache(d, input.runId, null)
      cache = rebuilt.cache
      cacheHit = false
      // Rebuild validates every accepted body.  Measure it without persisting
      // body bytes in the cache; this is diagnostic data for the benchmark.
      readBytes = rebuilt.readBytes
    } else if (cache.schema_version !== ACCEPTED_PREFIX_CACHE_SCHEMA_VERSION || cache.state !== 'valid' || !/^[0-9a-f]{64}$/u.test(cache.prefix_hash)) {
      throw new Error('narrative_prefix_cache_invalid')
    }
    const tail = readAcceptedPrefixTail(d, input.runId, input.recentChars, input.currentSceneId, input.currentContractHash, input.ledger)
    readBytes += tail.readBytes
    return {
      schemaVersion: 1,
      hash: cache.prefix_hash,
      acceptedCharCount: cache.accepted_char_count,
      acceptedSegmentCount: cache.accepted_segment_count,
      recentProse: tail.recentProse,
      readBytes,
      cacheHit,
      cacheRevision: cache.cache_revision
    }
  }

  const acceptedScopeConflict = (d: SqliteDb, segment: Pick<ManuscriptSegmentRow, 'run_id' | 'scene_id' | 'chunk_index' | 'segment_id'>): ManuscriptSegmentRow | null => {
    return (d.prepare(`SELECT * FROM manuscript_segments
      WHERE run_id = ? AND kind = 'prose' AND status = 'accepted' AND chunk_index = ?
        AND COALESCE(scene_id, '') = COALESCE(?, '') AND segment_id <> ?
      ORDER BY revision DESC, accepted_at DESC, updated_at DESC, segment_id ASC LIMIT 1`)
      .get(segment.run_id, segment.chunk_index, segment.scene_id, segment.segment_id) as ManuscriptSegmentRow | undefined) ?? null
  }

  const toAttempt = (row: ProviderAttemptRow): ProviderAttemptRecord => ({
    attemptId: row.attempt_id,
    runId: row.run_id,
    logicalCallId: row.logical_call_id,
    attemptNo: row.attempt_no,
    stageId: row.stage_id,
    actor: row.actor,
    subtype: row.subtype,
    providerId: row.provider_id,
    endpointOrigin: row.provider_endpoint_origin,
    modelId: row.model_id,
    providerRequestId: row.provider_request_id,
    outcome: row.outcome,
    httpStatus: row.http_status,
    startedAt: row.started_at,
    firstTokenAt: row.first_token_at,
    endedAt: row.ended_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheHitTokens: row.cache_hit_tokens,
    cacheMissTokens: row.cache_miss_tokens,
    reasoningTokens: row.reasoning_tokens,
    costStatus: row.cost_status,
    costAmount: row.cost_amount,
    costCurrency: row.cost_currency,
    priceSnapshotId: row.price_snapshot_id,
    adapterId: row.adapter_id ?? null,
    profileId: row.profile_id ?? null,
    credentialRefId: row.credential_ref_id ?? null,
    appliedMappings: safeJsonArray(row.applied_mappings_json),
    omittedControls: safeJsonArray(row.omitted_controls_json),
    contextManifestId: row.context_manifest_id ?? null,
    contextMode: row.context_mode ?? null
  })

  const refreshBilling = (runId: string, finalized?: boolean): RunBillingView | null => {
    const d = requireDb()
    const run = d.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as RunRow | undefined
    if (!run) return null
    const attempts = (d.prepare('SELECT * FROM provider_call_attempts WHERE run_id = ? ORDER BY started_at, attempt_no').all(runId) as unknown as ProviderAttemptRow[]).map(toAttempt)
    const workflowEvents = (d.prepare('SELECT event_json FROM workflow_events WHERE run_id = ? ORDER BY seq ASC').all(runId) as Array<{ event_json: string }>).flatMap((row) => {
      try { return [JSON.parse(row.event_json) as ActivityEvent] } catch { return [] }
    })
    const contextManifests = (d.prepare('SELECT manifest_json FROM context_manifests_v2 WHERE run_id = ? ORDER BY created_at').all(runId) as Array<{ manifest_json: string }>).flatMap((row) => {
      try { return [JSON.parse(row.manifest_json) as ContextManifestV2] } catch { return [] }
    })
    const startedEvent = workflowEvents.find((event) => event.type === 'run.started')
    const terminalEvent = [...workflowEvents].reverse().find((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))
    const tools = d.prepare('SELECT COUNT(*) AS n FROM toolcalls WHERE run_id = ?').get(runId) as { n: number }
    const attemptSource = d.prepare('SELECT COALESCE(SUM(row_revision),0) AS revision FROM provider_call_attempts WHERE run_id = ?').get(runId) as { revision: number }
    const eventSource = d.prepare('SELECT COALESCE(MAX(seq),-1) AS seq FROM workflow_events WHERE run_id = ?').get(runId) as { seq: number }
    const previous = d.prepare('SELECT revision, finalized FROM run_billing_snapshots WHERE run_id = ?').get(runId) as { revision: number; finalized: number } | undefined
    const terminal = ['completed', 'failed', 'cancelled'].includes(run.status)
    const view = buildRunBillingView({
      runId,
      revision: Number(previous?.revision ?? 0) + 1,
      finalized: finalized ?? (terminal || previous?.finalized === 1),
      status: run.status,
      startedAt: startedEvent?.timestamp ?? run.started_at,
      endedAt: terminalEvent?.timestamp ?? ((finalized ?? terminal) ? run.updated_at : null),
      toolCalls: Number(tools.n ?? 0),
      attempts,
      workflowEvents,
      contextManifests
    })
    d.prepare(`INSERT INTO run_billing_snapshots (run_id, revision, snapshot_json, finalized, source_attempt_revision, source_event_seq, source_tool_count, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET revision=excluded.revision, snapshot_json=excluded.snapshot_json, finalized=excluded.finalized, source_attempt_revision=excluded.source_attempt_revision, source_event_seq=excluded.source_event_seq, source_tool_count=excluded.source_tool_count, updated_at=excluded.updated_at`)
      .run(runId, view.revision, JSON.stringify(view), view.finalized ? 1 : 0, Number(attemptSource.revision ?? 0), Number(eventSource.seq ?? -1), Number(tools.n ?? 0), Date.now())
    return view
  }

  const sceneDecisionFromJson = (value: string | null): SceneCompletionDecision | null => {
    if (!value) return null
    try {
      const parsed = JSON.parse(value) as SceneCompletionDecision
      if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.decisionId !== 'string' || typeof parsed.sceneId !== 'string' ||
        typeof parsed.contractId !== 'string' || typeof parsed.contractHash !== 'string' || typeof parsed.candidateSegmentId !== 'string' ||
        typeof parsed.candidateHash !== 'string' || !Number.isInteger(parsed.candidateCharCount) ||
        (parsed.status !== 'complete' && parsed.status !== 'defer') || !Array.isArray(parsed.requiredBeatIds) ||
        !Array.isArray(parsed.satisfiedBeatIds) || !Array.isArray(parsed.missingBeatIds) || typeof parsed.evidenceHash !== 'string' ||
        !Number.isFinite(parsed.decidedAt)) throw new Error('scene_state_completion_decision_corrupt')
      return parsed
    } catch (error) {
      if (error instanceof Error && error.message === 'scene_state_completion_decision_corrupt') throw error
      throw new Error('scene_state_completion_decision_corrupt')
    }
  }

  const sceneStateFromRow = (row: SceneStateRow): SceneStateRecord => ({
    schemaVersion: 1,
    runId: row.run_id,
    sceneId: row.scene_id,
    sectionId: row.section_id,
    contractId: row.contract_id,
    contractHash: row.contract_hash,
    order: row.scene_order,
    lifecycle: row.lifecycle,
    revision: row.revision,
    candidateSegmentId: row.candidate_segment_id,
    candidateHash: row.candidate_hash,
    acceptedSegmentId: row.accepted_segment_id,
    acceptedHash: row.accepted_hash,
    completionDecision: sceneDecisionFromJson(row.completion_decision_json),
    completionEvidenceHash: row.completion_evidence_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    committedAt: row.committed_at
  })

  const narrativeCommitFromRow = (row: NarrativeCommitRow): NarrativeCommitRecord => {
    let stateDelta: NarrativeStateDelta
    try {
      stateDelta = normalizeNarrativeStateDelta(JSON.parse(row.delta_json))
    } catch {
      throw new Error('narrative_commit_corrupt')
    }
    if (stateDelta.runId !== row.run_id || stateDelta.sceneId !== row.scene_id || stateDelta.acceptedSegmentId !== row.accepted_segment_id || stateDelta.acceptedContentHash !== row.accepted_content_hash || stateDelta.contractHash !== row.contract_hash || stateDelta.deltaHash !== row.delta_hash) {
      throw new Error('narrative_commit_binding_mismatch')
    }
    return {
      schemaVersion: 1,
      runId: row.run_id,
      sceneId: row.scene_id,
      acceptedSegmentId: row.accepted_segment_id,
      acceptedContentHash: row.accepted_content_hash,
      contractHash: row.contract_hash,
      deltaHash: row.delta_hash,
      stateDelta,
      revision: row.revision,
      committedAt: row.committed_at
    }
  }

  const narrativeLedgerFromRow = (row: NarrativeLedgerRow, delta: NarrativeStateDelta): NarrativeLedgerEntry => {
    const change = delta.changes.find((candidate) => candidate.changeId === row.change_id)
    if (!change || change.revision !== row.change_revision || change.kind !== row.change_kind || change.entityId !== row.entity_id || stableNarrativeJson(change) !== row.payload_json) throw new Error('narrative_ledger_binding_mismatch')
    return { ...change, deltaHash: row.delta_hash, committedAt: row.committed_at }
  }

  const decodeFactJson = (value: string, field: string): unknown => {
    try { return JSON.parse(value) } catch { throw new Error(`narrative_fact_${field}_corrupt`) }
  }

  const decodeNullableFactTime = (value: string | null, field: string): string | number | null => {
    if (value === null) return null
    const parsed = decodeFactJson(value, field)
    if (parsed === null || typeof parsed === 'string' || (typeof parsed === 'number' && Number.isFinite(parsed))) return parsed
    throw new Error(`narrative_fact_${field}_corrupt`)
  }

  const narrativeFactFromRow = (row: NarrativeFactRow): NarrativeFact => {
    try {
      return validateNarrativeFact({
        schemaVersion: 1,
        factId: row.fact_id,
        version: row.version,
        sessionId: row.session_id,
        runId: row.run_id,
        canonicalStatement: row.canonical_statement,
        canonicalHash: row.canonical_hash,
        aliases: decodeFactJson(row.aliases_json, 'aliases'),
        entities: decodeFactJson(row.entities_json, 'entities'),
        sourceSlotIds: decodeFactJson(row.source_slot_ids_json, 'source_slot_ids'),
        sources: decodeFactJson(row.sources_json, 'sources'),
        validFrom: decodeNullableFactTime(row.valid_from, 'valid_from'),
        validUntil: decodeNullableFactTime(row.valid_until, 'valid_until'),
        confidence: row.confidence,
        status: row.status,
        visibility: row.visibility,
        knowers: decodeFactJson(row.knowers_json, 'knowers'),
        provenanceHash: row.provenance_hash,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('narrative_fact_')) throw error
      throw new Error('narrative_fact_corrupt')
    }
  }

  const withImmediateTransaction = (fn: () => void): void => {
    const d = requireDb()
    if (transactionDepth > 0) {
      transactionDepth += 1
      try { fn() } finally { transactionDepth -= 1 }
      return
    }
    d.exec('BEGIN IMMEDIATE')
    transactionDepth = 1
    try {
      fn()
      d.exec('COMMIT')
    } catch (error) {
      try { d.exec('ROLLBACK') } catch { /* preserve original error */ }
      throw error
    } finally {
      transactionDepth = 0
    }
  }

  const sceneMemoryCardRowVisible = (d: SqliteDb, row: { visibility?: string; status?: string; card_id?: string; run_id?: string; story_id?: string; project_id?: string; branch_id?: string; validity_epoch?: number; story_revision?: number; scene_id?: string; commit_manifest_hash?: string; state_delta_hash?: string; card_hash?: string; card_json?: string }): boolean => {
    if (row.visibility !== 'active' || row.status === 'legacy_unverified') return false
    if (!row.card_id || !row.run_id || !row.story_id || !row.project_id || !row.branch_id || !row.scene_id || !row.commit_manifest_hash || !row.state_delta_hash || !Number.isInteger(row.validity_epoch) || !Number.isInteger(row.story_revision)) return false
    // Keep every active-read caller behind the same SQL-authority and
    // persisted-payload fence.  In particular, a row with a valid payload
    // hash but tampered authority columns must not be treated as visible by
    // working-set/rebuild code that calls this helper before hydration.
    try { sceneMemoryCardFromRow(row) } catch { return false }
    const run = d.prepare('SELECT 1 AS present FROM runs WHERE run_id=? LIMIT 1').get(row.run_id) as { present?: number } | undefined
    if (run?.present !== 1) return false
    const storyId = row.story_id
    const projectId = row.project_id
    const branchId = row.branch_id
    const epoch = Number(row.validity_epoch)
    const revision = Number(row.story_revision)
    const head = d.prepare('SELECT high_watermark, validity_epoch, hash_schema_version FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(storyId, projectId, branchId) as { high_watermark?: number; validity_epoch?: number; hash_schema_version?: number } | undefined
    if (!head || head.hash_schema_version !== 2 || head.validity_epoch !== epoch || Number(head.high_watermark ?? 0) < revision) return false
    const retracted = d.prepare(`SELECT 1 AS present FROM story_ledger_tombstones WHERE story_id=? AND project_id=? AND branch_id=? AND (target_revision=? OR revision=?) LIMIT 1`).get(storyId, projectId, branchId, revision, revision) as { present?: number } | undefined
    if (retracted?.present === 1) return false
    const ledger = d.prepare('SELECT node_type, validity_epoch FROM story_ledger_revisions WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?').get(storyId, projectId, branchId, revision) as { node_type?: string; validity_epoch?: number } | undefined
    if (!ledger || (ledger.node_type !== 'revision' && ledger.node_type !== 'rebase') || ledger.validity_epoch !== epoch) return false
    const commit = d.prepare('SELECT 1 AS present FROM narrative_commits WHERE run_id=? AND scene_id=? AND delta_hash=? LIMIT 1').get(row.run_id, row.scene_id, row.state_delta_hash) as { present?: number } | undefined
    const manifest = d.prepare('SELECT 1 AS present FROM scene_commit_manifests WHERE run_id=? AND scene_id=? AND manifest_hash=? LIMIT 1').get(row.run_id, row.scene_id, row.commit_manifest_hash) as { present?: number } | undefined
    if (commit?.present !== 1 || manifest?.present !== 1 || typeof row.card_hash !== 'string' || typeof row.card_json !== 'string') return false
    const outbox = d.prepare(`SELECT status, card_hash, payload_json FROM scene_memory_card_outbox
      WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=? AND story_revision=? AND scene_id=? AND commit_manifest_hash=? AND card_hash=?
      ORDER BY updated_at DESC LIMIT 1`).get(storyId, projectId, branchId, epoch, revision, row.scene_id, row.commit_manifest_hash, row.card_hash) as { status?: string; card_hash?: string; payload_json?: string } | undefined
    if (!outbox || outbox.status !== 'published' || outbox.card_hash !== row.card_hash || outbox.payload_json !== row.card_json) return false
    let payload: unknown
    try { payload = JSON.parse(row.card_json) } catch { return false }
    try {
      assertPersistedSceneMemoryCardShape(payload)
      if (stableSceneMemoryCardJson(payload) !== row.card_json || sceneMemoryCardHash(payload) !== row.card_hash) return false
    } catch { return false }
    return true
  }

  const assertSceneMemoryProjection = (d: SqliteDb, input: SceneMemoryProjectionInput): { manifest: SceneCommitManifest; sourceRows: ManuscriptSegmentRow[] } => {
    const { card, context } = input
    const validation = validateSceneMemoryCard(card, context)
    if (!validation.ok) throw new Error(`scene_memory_card_invalid:${validation.errors.join(',')}`)
    if (card.status === 'legacy_unverified') throw new Error('scene_memory_legacy_card_not_publishable')
    if (!SCENE_MEMORY_HASH.test(card.cardHash) || sceneMemoryCardHash(card) !== card.cardHash) throw new Error('scene_memory_card_hash_mismatch')
    const state = d.prepare('SELECT lifecycle, contract_id, contract_hash, scene_order FROM scene_states WHERE run_id=? AND scene_id=?').get(card.runId, card.sceneId) as { lifecycle?: string; contract_id?: string; contract_hash?: string; scene_order?: number } | undefined
    if (!state || state.lifecycle !== 'committed' || state.contract_id !== card.contractId || state.contract_hash !== card.contractHash || state.scene_order !== card.sceneOrder) throw new Error('scene_memory_scene_not_committed')
    const commit = d.prepare('SELECT accepted_segment_id, accepted_content_hash, contract_hash, delta_hash, revision FROM narrative_commits WHERE run_id=? AND scene_id=?').get(card.runId, card.sceneId) as { accepted_segment_id?: string; accepted_content_hash?: string; contract_hash?: string; delta_hash?: string; revision?: number } | undefined
    if (!commit || commit.contract_hash !== card.contractHash || commit.delta_hash !== card.stateDeltaHash) throw new Error('scene_memory_narrative_commit_missing')
    const manifestRow = d.prepare('SELECT manifest_json, manifest_hash, revision FROM scene_commit_manifests WHERE run_id=? AND scene_id=?').get(card.runId, card.sceneId) as { manifest_json?: string; manifest_hash?: string; revision?: number } | undefined
    if (!manifestRow?.manifest_json || !manifestRow.manifest_hash || manifestRow.manifest_hash !== card.commitManifestHash) throw new Error('scene_memory_manifest_missing')
    let manifest: SceneCommitManifest
    try { manifest = parseSceneCommitManifest(JSON.parse(manifestRow.manifest_json)) } catch { throw new Error('scene_memory_manifest_corrupt') }
    if (manifest.runId !== card.runId || manifest.sceneId !== card.sceneId || manifest.contractId !== card.contractId || manifest.contractHash !== card.contractHash || manifest.sceneContentHash !== card.sceneContentHash || manifest.stateDeltaHash !== card.stateDeltaHash || sceneCommitManifestHash(manifest) !== manifestRow.manifest_hash) throw new Error('scene_memory_manifest_binding_mismatch')
    const ledgerRow = d.prepare(`SELECT revision, validity_epoch, run_id, scene_id, delta_hash, manifest_hash, node_type
      FROM story_ledger_revisions WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?`).get(card.storyId, card.projectId, card.branchId, card.storyRevision) as { revision?: number; validity_epoch?: number; run_id?: string | null; scene_id?: string | null; delta_hash?: string; manifest_hash?: string | null; node_type?: string } | undefined
    if (!ledgerRow || ledgerRow.run_id !== card.runId || ledgerRow.scene_id !== card.sceneId || ledgerRow.delta_hash !== card.stateDeltaHash || ledgerRow.manifest_hash !== card.commitManifestHash || ledgerRow.validity_epoch !== card.validityEpoch || (ledgerRow.node_type !== 'revision' && ledgerRow.node_type !== 'rebase')) throw new Error('scene_memory_ledger_binding_mismatch')
    if (d.prepare('SELECT 1 AS present FROM story_ledger_tombstones WHERE story_id=? AND project_id=? AND branch_id=? AND (target_revision=? OR revision=?) LIMIT 1').get(card.storyId, card.projectId, card.branchId, card.storyRevision, card.storyRevision)) throw new Error('scene_memory_ledger_retracted')
    const sourceRows = d.prepare(`SELECT * FROM manuscript_segments WHERE run_id=? AND scene_id=? AND status='accepted' AND kind='prose' ORDER BY chunk_index ASC, revision ASC, segment_id ASC`).all(card.runId, card.sceneId) as unknown as ManuscriptSegmentRow[]
    const manifestSegments = manifest.acceptedSegments.map((item) => `${item.segmentId}\u0000${item.contentHash}\u0000${item.charCount}\u0000${item.chunkIndex}\u0000${item.revision}`).join('\u0001')
    const actualSegments = sourceRows.map((item) => `${item.segment_id}\u0000${item.content_hash}\u0000${item.char_count}\u0000${item.chunk_index}\u0000${item.revision}`).join('\u0001')
    if (manifestSegments !== actualSegments || sourceRows.length !== card.sourceSegmentIds.length || sourceRows.some((row) => !card.sourceSegmentIds.includes(row.segment_id))) throw new Error('scene_memory_source_manifest_mismatch')
    for (const segment of context.sourceSegments) {
      if (segment.status !== 'accepted' || segment.sceneId !== card.sceneId || segment.commitManifestHash !== card.commitManifestHash) throw new Error('scene_memory_source_context_invalid')
      const row = sourceRows.find((candidate) => candidate.segment_id === segment.segmentId)
      if (!row || row.content_hash !== segment.contentHash || row.revision !== segment.segmentRevision || row.content !== segment.content) throw new Error('scene_memory_source_context_mismatch')
    }
    if (context.sourceSegments.length !== sourceRows.length) throw new Error('scene_memory_source_context_incomplete')
    // The validator checks ledger authority fields.  Repository additionally
    // requires each ledger-backed claim to name a committed ledger change;
    // otherwise a caller cannot turn an untrusted model claim into a card.
    for (const claim of context.ledgerClaims) {
      const { hash: _claimHash, ...claimPayload } = claim
      if (sceneMemoryLedgerClaimHash(claimPayload) !== claim.hash) throw new Error('scene_memory_ledger_claim_hash_mismatch')
      const row = d.prepare('SELECT change_kind, payload_json, delta_hash, accepted_content_hash, contract_hash FROM narrative_ledger WHERE run_id=? AND scene_id=? AND change_id=?').get(card.runId, card.sceneId, claim.id) as { change_kind?: string; payload_json?: string; delta_hash?: string; accepted_content_hash?: string; contract_hash?: string } | undefined
      if (!row || row.delta_hash !== card.stateDeltaHash || row.contract_hash !== card.contractHash || row.accepted_content_hash !== manifest.acceptedSegments[manifest.acceptedSegments.length - 1]?.contentHash) throw new Error('scene_memory_ledger_claim_untrusted')
      if ((claim.kind === 'relationship' && row.change_kind !== 'relationship') || (claim.kind === 'foreshadow' && row.change_kind !== 'foreshadow')) throw new Error('scene_memory_ledger_claim_kind_mismatch')
      let payload: unknown
      try { payload = JSON.parse(row.payload_json ?? '') } catch { throw new Error('scene_memory_ledger_claim_corrupt') }
      if (!payload || typeof payload !== 'object') throw new Error('scene_memory_ledger_claim_corrupt')
      const value = payload as Record<string, unknown>
      if (claim.kind === 'relationship' && (value.fromCharacterId !== claim.fromCharacterId || value.toCharacterId !== claim.toCharacterId || value.dimension !== claim.dimension)) throw new Error('scene_memory_ledger_claim_mismatch')
      if (claim.kind === 'foreshadow' && (value.threadId !== claim.threadId || value.lifecycle !== claim.lifecycle)) throw new Error('scene_memory_ledger_claim_mismatch')
    }
    return { manifest, sourceRows }
  }

  const persistSceneMemoryCard = (d: SqliteDb, input: SceneMemoryProjectionInput): { inserted: boolean; card: SceneMemoryCard } => {
    assertSceneMemoryProjection(d, input)
    const card = input.card
    const identity = d.prepare(`SELECT * FROM scene_memory_cards
      WHERE story_id=? AND project_id=? AND branch_id=? AND scene_id=? AND story_revision=? AND validity_epoch=? AND commit_manifest_hash=?`).get(card.storyId, card.projectId, card.branchId, card.sceneId, card.storyRevision, card.validityEpoch, card.commitManifestHash) as { [key: string]: unknown } | undefined
    if (identity) {
      if (identity.card_hash !== card.cardHash) throw new Error('scene_memory_card_identity_conflict')
      const existing = sceneMemoryCardFromRow(identity)
      // cardHash intentionally excludes only createdAt.  It therefore is the
      // canonical semantic payload identity: a rebuild with the same source
      // evidence but a fresh timestamp is idempotent, while any meaningful
      // field change has already taken the conflict branch above.
      return { inserted: false, card: existing }
    }
    const byId = d.prepare('SELECT card_hash FROM scene_memory_cards WHERE card_id=?').get(card.cardId) as { card_hash?: string } | undefined
    if (byId) throw new Error('scene_memory_card_id_conflict')
    const now = Number.isFinite(card.createdAt) ? card.createdAt : Date.now()
    const cardJson = stableSceneMemoryCardJson(card)
    const outboxId = sceneMemoryStableHash({ identity: sceneMemoryScopeIdentity(card), cardHash: card.cardHash })
    d.prepare(`INSERT INTO scene_memory_card_outbox (outbox_id,story_id,project_id,branch_id,validity_epoch,story_revision,scene_id,commit_manifest_hash,card_hash,payload_json,status,error_code,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'pending',NULL,?,?) ON CONFLICT(outbox_id) DO NOTHING`).run(outboxId, card.storyId, card.projectId, card.branchId, card.validityEpoch, card.storyRevision, card.sceneId, card.commitManifestHash, card.cardHash, cardJson, now, now)
    d.prepare(`INSERT INTO scene_memory_cards (card_id,schema_version,status,visibility,story_id,project_id,branch_id,validity_epoch,story_revision,run_id,scene_id,scene_order,contract_id,contract_hash,scene_content_hash,commit_manifest_hash,state_delta_hash,card_hash,card_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(card.cardId, card.schemaVersion, card.status, 'pending', card.storyId, card.projectId, card.branchId, card.validityEpoch, card.storyRevision, card.runId, card.sceneId, card.sceneOrder, card.contractId, card.contractHash, card.sceneContentHash, card.commitManifestHash, card.stateDeltaHash, card.cardHash, cardJson, now, now)
    const spanInsert = d.prepare(`INSERT INTO scene_memory_card_spans (card_id,span_id,segment_id,segment_hash,segment_revision,manifest_hash,start_utf16,end_utf16,span_text,span_hash) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    for (const span of card.sourceSpans) spanInsert.run(card.cardId, span.spanId, span.segmentId, span.segmentHash, span.segmentRevision, span.manifestHash, span.startUtf16, span.endUtf16, span.text, span.spanHash)
    const entityInsert = d.prepare(`INSERT INTO scene_recall_entities (card_id,entity_id,entity_kind,display_name,role,evidence_json,card_hash) VALUES (?,?,?,?,?,?,?)`)
    for (const participant of card.participants) entityInsert.run(card.cardId, participant.id, 'participant', participant.id, participant.role, stableSceneMemoryJson(participant.evidence), card.cardHash)
    for (const fact of card.factsEstablished) entityInsert.run(card.cardId, fact.factId, 'fact', fact.statement, null, stableSceneMemoryJson(fact.evidence), card.cardHash)
    const threadInsert = d.prepare(`INSERT INTO scene_recall_threads (card_id,thread_id,lifecycle,summary,evidence_json,card_hash) VALUES (?,?,?,?,?,?)`)
    for (const thread of card.threads) threadInsert.run(card.cardId, thread.threadId, thread.lifecycle, thread.summary, stableSceneMemoryJson(thread.evidence), card.cardHash)
    const edgeInsert = d.prepare(`INSERT INTO scene_recall_edges (card_id,from_character_id,to_character_id,dimension,from_value,to_value,evidence_json,card_hash) VALUES (?,?,?,?,?,?,?,?)`)
    for (const edge of card.relationshipChanges) edgeInsert.run(card.cardId, edge.fromCharacterId, edge.toCharacterId, edge.dimension, edge.from, edge.to, stableSceneMemoryJson(edge.evidence), card.cardHash)
    const termInsert = d.prepare(`INSERT INTO scene_recall_terms (card_id,term_kind,term,normalized_term,weight,evidence_json,card_hash) VALUES (?,?,?,?,?,?,?)`)
    const terms: Array<{ kind: string; term: string; evidence: unknown[] }> = []
    for (const item of card.motifs) terms.push({ kind: 'motif', term: item.text, evidence: item.evidence })
    for (const item of card.distinctivePhrases) terms.push({ kind: 'phrase', term: item.text, evidence: item.evidence })
    card.objects.forEach((item, index) => terms.push({ kind: 'object', term: item, evidence: card.fieldEvidence[`objects:${item}`] ?? card.fieldEvidence[`objects[${index}]`] ?? card.fieldEvidence.objects ?? [] }))
    card.locations.forEach((item, index) => terms.push({ kind: 'location', term: item, evidence: card.fieldEvidence[`locations:${item}`] ?? card.fieldEvidence[`locations[${index}]`] ?? card.fieldEvidence.locations ?? [] }))
    for (const item of terms) termInsert.run(card.cardId, item.kind, item.term, item.term.normalize('NFKC').toLocaleLowerCase(), 1, stableSceneMemoryJson(item.evidence), card.cardHash)
    d.prepare(`INSERT INTO scene_recall_embeddings (card_id,status,version,model_id,dimensions,vector_hash,vector_json,source_card_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(card.cardId, card.embedding.status, card.embedding.version, card.embedding.modelId, card.embedding.dimensions, card.embedding.vectorHash, null, card.cardHash, now)
    d.prepare('UPDATE scene_memory_cards SET visibility=\'active\', updated_at=? WHERE card_id=?').run(now, card.cardId)
    d.prepare('UPDATE scene_memory_card_outbox SET status=\'published\', updated_at=? WHERE outbox_id=?').run(now, outboxId)
    return { inserted: true, card }
  }

  type SceneRecallIndexMetaScope = Pick<SceneMemoryCard, 'storyId' | 'projectId' | 'branchId' | 'validityEpoch'>
  type SceneRecallIndexMetaResult = { cardCount: number; cardSetHash: string; indexHash: string; storyRevision: number }

  /** Compute the index identity for the cumulative active canonical cards up
   * through one story revision.  Both the live commit and rebuild path call
   * this exact helper; the revision is part of the hash and scene filtering
   * is deliberately absent because index-meta is a story-scope fence. */
  const computeSceneRecallIndexMeta = (d: SqliteDb, scope: SceneRecallIndexMetaScope, storyRevision: number): SceneRecallIndexMetaResult => {
    if (!Number.isInteger(storyRevision) || storyRevision < 0) throw new Error('scene_recall_index_revision_invalid')
    const rows = d.prepare(`SELECT * FROM scene_memory_cards
      WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=? AND story_revision<=? AND visibility='active'
      ORDER BY card_id ASC`).all(scope.storyId, scope.projectId, scope.branchId, scope.validityEpoch, storyRevision) as Array<{ [key: string]: unknown }>
    const cards = rows.map((row) => {
      if (!sceneMemoryCardRowVisible(d, row)) throw new Error('scene_recall_index_corrupt')
      const card = sceneMemoryCardFromRow(row)
      return { cardId: card.cardId, cardHash: card.cardHash }
    }).sort((left, right) => left.cardId.localeCompare(right.cardId))
    const cardSetHash = sceneMemoryStableHash(cards.map((card) => card.cardHash).sort())
    const indexHash = sceneMemoryStableHash({
      scope: { storyId: scope.storyId, projectId: scope.projectId, branchId: scope.branchId, validityEpoch: scope.validityEpoch, storyRevision, sceneId: null },
      cardSetHash,
      cards
    })
    return { cardCount: cards.length, cardSetHash, indexHash, storyRevision }
  }

  /** Publish the deterministic index fence while participating in the
   * caller's outer transaction.  `storyRevision` means cumulative-through-N,
   * never just the cards introduced by revision N. */
  const writeSceneRecallIndexMeta = (d: SqliteDb, scope: SceneRecallIndexMetaScope, storyRevision: number, at: number): SceneRecallIndexMetaResult => {
    const result = computeSceneRecallIndexMeta(d, scope, storyRevision)
    testHooks.beforeSceneRecallIndexMetaWrite?.()
    d.prepare(`INSERT INTO scene_recall_index_meta (story_id,project_id,branch_id,validity_epoch,story_revision,index_version,source_card_set_hash,index_hash,status,built_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(story_id,project_id,branch_id,validity_epoch,story_revision) DO UPDATE SET source_card_set_hash=excluded.source_card_set_hash,index_hash=excluded.index_hash,status=excluded.status,built_at=excluded.built_at`).run(
      scope.storyId, scope.projectId, scope.branchId, scope.validityEpoch, storyRevision, 1, result.cardSetHash, result.indexHash, 'ready', at
    )
    testHooks.afterSceneRecallIndexMetaWrite?.()
    return result
  }

  /** Invalidate every rebuildable projection before its canonical run is
   * removed.  The scope rows are captured from both the ledger run and cards
   * because either side may be absent during recovery. */
  const invalidateSceneMemoryProjectionsForRun = (d: SqliteDb, runId: string, action: 'preserve' | 'retract'): void => {
    const now = Date.now()
    const cardVisibility = action === 'retract' ? 'retracted' : 'stale'
    const dependentStatus = action === 'retract' ? 'retracted' : 'stale'
    const scopes = d.prepare(`
      SELECT DISTINCT story_id, project_id, branch_id
      FROM story_ledger_runs WHERE run_id=?
      UNION
      SELECT DISTINCT story_id, project_id, branch_id
      FROM scene_memory_cards WHERE run_id=?
    `).all(runId, runId) as Array<{ story_id?: string; project_id?: string; branch_id?: string }>
    d.prepare("UPDATE scene_memory_cards SET visibility=?, updated_at=? WHERE run_id=? AND visibility NOT IN ('legacy_unverified', 'retracted')").run(cardVisibility, now, runId)
    d.prepare(`UPDATE scene_memory_card_outbox SET status='rejected', error_code='run_deleted', updated_at=?
      WHERE status <> 'rejected' AND card_hash IN (SELECT card_hash FROM scene_memory_cards WHERE run_id=?)`).run(now, runId)
    for (const scope of scopes) {
      if (!scope.story_id || !scope.project_id || !scope.branch_id) continue
      d.prepare(`UPDATE scene_working_sets SET status=?, updated_at=?
        WHERE story_id=? AND project_id=? AND branch_id=? AND status='active'`).run(dependentStatus, now, scope.story_id, scope.project_id, scope.branch_id)
      d.prepare(`UPDATE scene_recall_index_meta SET status='stale', built_at=?
        WHERE story_id=? AND project_id=? AND branch_id=? AND status <> 'stale'`).run(now, scope.story_id, scope.project_id, scope.branch_id)
    }
    d.prepare("UPDATE longform_workflow_snapshots SET status=?, updated_at=? WHERE run_id=? AND status NOT IN ('stale','retracted')").run(dependentStatus, now, runId)
  }

  const parseStrictSceneMemoryJson = (raw: unknown, label: string): unknown => {
    if (typeof raw !== 'string') throw new Error(`${label}_corrupt`)
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error(`${label}_corrupt`) }
    try { assertSceneMemoryJsonValue(parsed, label) } catch { throw new Error(`${label}_corrupt`) }
    return parsed
  }

  const assertSceneMemoryBackfillState = (state: SceneMemoryBackfillState, requireCanonicalAuthority = false): void => {
    const statuses = new Set<SceneMemoryBackfillState['status']>(['pending', 'in_progress', 'paused', 'complete', 'failed', 'legacy_unverified'])
    const scopeParts = [state.storyId, state.projectId, state.branchId]
    const scopeAllNull = scopeParts.every((part) => part === null)
    const scopeAllPresent = scopeParts.every((part) => typeof part === 'string' && part.length > 0)
    const authorityAllNull = state.validityEpoch === null && state.storyRevision === null && state.sceneId === null
    const authorityAllPresent = typeof state.validityEpoch === 'number' && Number.isInteger(state.validityEpoch) && state.validityEpoch >= 1 && typeof state.storyRevision === 'number' && Number.isInteger(state.storyRevision) && state.storyRevision >= 0 && typeof state.sceneId === 'string' && state.sceneId.length > 0
    if (!state.backfillId || !SCENE_MEMORY_HASH.test(state.inputSnapshotHash) || !scopeAllNull && !scopeAllPresent || !authorityAllNull && !authorityAllPresent || requireCanonicalAuthority && (!scopeAllPresent || !authorityAllPresent) || !Number.isFinite(state.createdAt) || !Number.isFinite(state.updatedAt) || state.completedAt !== null && !Number.isFinite(state.completedAt) || !Array.isArray(state.processedIds) || state.processedIds.some((id) => typeof id !== 'string' || id.length === 0) || new Set(state.processedIds).size !== state.processedIds.length || !Number.isInteger(state.totalCount) || state.totalCount < 0 || !Number.isInteger(state.processedCount) || state.processedCount < 0 || state.processedCount > state.totalCount || state.processedCount !== state.processedIds.length || !statuses.has(state.status) || state.status === 'complete' && state.processedCount !== state.totalCount) throw new Error('scene_memory_backfill_invalid')
  }

  const sceneMemoryWorkingSetCardAllowed = (card: SceneMemoryCard, scope: { storyId: string; projectId: string; branchId: string; validityEpoch: number; storyRevision: number; sceneId: string }, lineage?: readonly string[], cutoffs?: ReadonlyMap<string, number>): boolean => {
    if (card.storyId !== scope.storyId || card.projectId !== scope.projectId || card.validityEpoch !== scope.validityEpoch || card.sceneId === scope.sceneId) return false
    const allowedLineage = lineage ?? [scope.branchId]
    if (!allowedLineage.includes(card.branchId)) return false
    const cutoff = cutoffs?.get(card.branchId) ?? scope.storyRevision
    return Number.isInteger(cutoff) && cutoff >= 0 && card.storyRevision <= cutoff
  }

  const assertSceneMemorySnapshotAuthority = (d: SqliteDb, values: { runId: string; storyId: string; projectId: string; branchId: string; validityEpoch: number; storyRevision: number }): void => {
    const run = d.prepare('SELECT 1 AS present FROM runs WHERE run_id=?').get(values.runId) as { present?: number } | undefined
    const ledgerRun = d.prepare('SELECT story_id, project_id, branch_id, validity_epoch, current_revision FROM story_ledger_runs WHERE run_id=?').get(values.runId) as { story_id?: string; project_id?: string; branch_id?: string; validity_epoch?: number; current_revision?: number } | undefined
    const head = d.prepare('SELECT high_watermark, validity_epoch, hash_schema_version FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(values.storyId, values.projectId, values.branchId) as { high_watermark?: number; validity_epoch?: number; hash_schema_version?: number } | undefined
    if (run?.present !== 1 || !ledgerRun || ledgerRun.story_id !== values.storyId || ledgerRun.project_id !== values.projectId || ledgerRun.branch_id !== values.branchId || ledgerRun.validity_epoch !== values.validityEpoch || Number(ledgerRun.current_revision ?? 0) < values.storyRevision || !head || head.hash_schema_version !== 2 || head.validity_epoch !== values.validityEpoch || !Number.isInteger(head.high_watermark) || Number(head.high_watermark) < values.storyRevision) throw new Error('longform_workflow_snapshot_authority_mismatch')
  }

  const WORKING_SET_SECTION_ORDER = ['hard_constraints', 'scene_contract', 'pov_state', 'world_state', 'causal_memories', 'payoff', 'exact_anchors', 'recent_tail', 'anti_repetition', 'omitted'] as const
  const WORKING_SET_SECTION_IDS = new Set<string>(WORKING_SET_SECTION_ORDER)
  const WORKING_SET_STATUS = new Set<SceneWorkingSetStatus>(['ready', 'required_overflow', 'blocked_required_sources'])
  const WORKING_SET_OMISSION_REASONS = new Set(['invalid_scope', 'invalid_source', 'stale', 'retracted', 'old_epoch', 'future_revision', 'current_scene', 'already_injected', 'knowledge_boundary', 'unknown_hard_source', 'legacy_unverified', 'budget_omitted', 'blocked_required_sources'])

  const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  }
  const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
    const allowed = new Set(keys)
    return Object.keys(value).every((key) => allowed.has(key))
  }
  const nonEmptyWorkingSetText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  const isWorkingSetHash = (value: unknown): value is string => typeof value === 'string' && SCENE_MEMORY_HASH.test(value)
  const workingSetInteger = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isInteger(value) && value >= minimum
  const sameWorkingSetJson = (left: unknown, right: unknown): boolean => stableSceneMemoryJson(left) === stableSceneMemoryJson(right)

  const workingSetIdentity = (workingSet: SceneWorkingSet): Record<string, unknown> => ({
    runId: workingSet.runId,
    sceneId: workingSet.sceneId,
    storyId: workingSet.storyId,
    projectId: workingSet.projectId,
    branchId: workingSet.branchId,
    validityEpoch: workingSet.validityEpoch,
    storyRevision: workingSet.storyRevision,
    headRevision: workingSet.headRevision,
    headHash: workingSet.headHash,
    sourceSnapshotHash: workingSet.sourceSnapshotHash,
    sourceCardSetHash: workingSet.sourceCardSetHash,
    ...(workingSet.currentSceneTailHash !== undefined ? { currentSceneTailHash: workingSet.currentSceneTailHash } : {}),
    queryHash: workingSet.queryHash,
    indexHash: workingSet.indexHash,
    contractId: workingSet.contractId,
    contractHash: workingSet.contractHash,
    contractContentHash: workingSet.contractContentHash,
    budgetTokens: workingSet.budgetTokens,
    estimatorVersion: workingSet.estimatorVersion
  })

  const expectedWorkingSetHash = (workingSet: SceneWorkingSet): string => sceneMemoryStableHash({
    identity: workingSetIdentity(workingSet),
    sections: workingSet.sections.map(({ id, required, included, contentHash, sourceCardIds, omissionReason }) => ({ id, required, included, contentHash, sourceCardIds, omissionReason })),
    omitted: workingSet.omitted
  })

  const assertWorkingSetSection: (value: unknown, label: string) => asserts value is SceneContextSectionDecision = (value: unknown, label: string): asserts value is SceneContextSectionDecision => {
    if (!isPlainRecord(value) || !hasOnlyKeys(value, ['id', 'required', 'included', 'estimatedTokens', 'contentHash', 'sourceCardIds', 'omissionReason']) || !WORKING_SET_SECTION_IDS.has(value.id as string) || typeof value.required !== 'boolean' || typeof value.included !== 'boolean' || !workingSetInteger(value.estimatedTokens) || !isWorkingSetHash(value.contentHash) || !Array.isArray(value.sourceCardIds) || value.sourceCardIds.some((id) => !nonEmptyWorkingSetText(id)) || new Set(value.sourceCardIds as string[]).size !== value.sourceCardIds.length || value.omissionReason !== null && (typeof value.omissionReason !== 'string' || !WORKING_SET_OMISSION_REASONS.has(value.omissionReason))) throw new Error(`${label}_corrupt`)
  }

  const workingSetSectionsOrdered = (value: unknown): value is readonly unknown[] => Array.isArray(value) && value.length === WORKING_SET_SECTION_ORDER.length && value.every((section, index) => isPlainRecord(section) && section.id === WORKING_SET_SECTION_ORDER[index])

  const assertWorkingSetOmission: (value: unknown, label: string) => asserts value is { cardId: string; reason: string } = (value: unknown, label: string): asserts value is { cardId: string; reason: string } => {
    if (!isPlainRecord(value) || !hasOnlyKeys(value, ['cardId', 'reason']) || !nonEmptyWorkingSetText(value.cardId) || typeof value.reason !== 'string' || !WORKING_SET_OMISSION_REASONS.has(value.reason)) throw new Error(`${label}_corrupt`)
  }

  const assertWorkingSetParts = (record: SceneWorkingSetPersistenceRecord): void => {
    if (!isPlainRecord(record) || record.schemaVersion !== 1 || !isPlainRecord(record.workingSet) || !isPlainRecord(record.manifest) || !isPlainRecord(record.workingSetMessage) || !Array.isArray(record.branchLineage) || record.branchLineage.length === 0 || record.branchLineage.some((id) => !nonEmptyWorkingSetText(id)) || new Set(record.branchLineage).size !== record.branchLineage.length || !isPlainRecord(record.branchCutoffs) || (record.finalEnvelopeHash !== null && !isWorkingSetHash(record.finalEnvelopeHash))) throw new Error('scene_working_set_record_corrupt')
    const workingSet = record.workingSet as unknown as Record<string, unknown>
    const manifest = record.manifest as unknown as Record<string, unknown>
    const message = record.workingSetMessage as unknown as Record<string, unknown>
    if (!hasOnlyKeys(workingSet, ['schemaVersion', 'workingSetId', 'runId', 'sceneId', 'storyId', 'projectId', 'branchId', 'validityEpoch', 'storyRevision', 'headRevision', 'headHash', 'sourceSnapshotHash', 'sourceCardSetHash', 'currentSceneTailHash', 'queryHash', 'indexHash', 'contractId', 'contractHash', 'contractContentHash', 'budgetTokens', 'estimatedTokens', 'estimatorVersion', 'sections', 'omitted', 'workingSetHash', 'manifestHash', 'workingSetMessageHash', 'status']) || workingSet.schemaVersion !== 1 || !nonEmptyWorkingSetText(workingSet.workingSetId) || !nonEmptyWorkingSetText(workingSet.runId) || !nonEmptyWorkingSetText(workingSet.sceneId) || !nonEmptyWorkingSetText(workingSet.storyId) || !nonEmptyWorkingSetText(workingSet.projectId) || !nonEmptyWorkingSetText(workingSet.branchId) || !workingSetInteger(workingSet.validityEpoch, 1) || !workingSetInteger(workingSet.storyRevision) || !workingSetInteger(workingSet.headRevision) || workingSet.headRevision < workingSet.storyRevision || !isWorkingSetHash(workingSet.headHash) || !isWorkingSetHash(workingSet.sourceSnapshotHash) || !isWorkingSetHash(workingSet.sourceCardSetHash) || workingSet.currentSceneTailHash !== undefined && !isWorkingSetHash(workingSet.currentSceneTailHash) || !isWorkingSetHash(workingSet.queryHash) || !isWorkingSetHash(workingSet.indexHash) || !nonEmptyWorkingSetText(workingSet.contractId) || !isWorkingSetHash(workingSet.contractHash) || !isWorkingSetHash(workingSet.contractContentHash) || !workingSetInteger(workingSet.budgetTokens, 1) || !workingSetInteger(workingSet.estimatedTokens) || workingSet.estimatedTokens > workingSet.budgetTokens || !nonEmptyWorkingSetText(workingSet.estimatorVersion) || !workingSetSectionsOrdered(workingSet.sections) || !Array.isArray(workingSet.sections) || workingSet.sections.some((section, index) => { try { assertWorkingSetSection(section, `scene_working_set_section_${index}`); return false } catch { return true } }) || !Array.isArray(workingSet.omitted) || workingSet.omitted.some((item, index) => { try { assertWorkingSetOmission(item, `scene_working_set_omitted_${index}`); return false } catch { return true } }) || new Set((workingSet.omitted as Array<{ cardId: string }>).map((item) => item.cardId)).size !== (workingSet.omitted as Array<{ cardId: string }>).length || !isWorkingSetHash(workingSet.workingSetHash) || !isWorkingSetHash(workingSet.manifestHash) || !isWorkingSetHash(workingSet.workingSetMessageHash) || typeof workingSet.status !== 'string' || !WORKING_SET_STATUS.has(workingSet.status as SceneWorkingSetStatus)) throw new Error('scene_working_set_authority_corrupt')
    if (!hasOnlyKeys(manifest, ['schemaVersion', 'runId', 'sceneId', 'storyId', 'projectId', 'branchId', 'validityEpoch', 'storyRevision', 'headRevision', 'headHash', 'sourceSnapshotHash', 'sourceCardSetHash', 'currentSceneTailHash', 'queryHash', 'indexHash', 'contractId', 'contractHash', 'contractContentHash', 'budgetTokens', 'estimatedTokens', 'estimatorVersion', 'sections', 'omitted', 'workingSetHash', 'manifestHash', 'workingSetMessageHash']) || manifest.schemaVersion !== 1 || !nonEmptyWorkingSetText(manifest.runId) || !nonEmptyWorkingSetText(manifest.sceneId) || !nonEmptyWorkingSetText(manifest.storyId) || !nonEmptyWorkingSetText(manifest.projectId) || !nonEmptyWorkingSetText(manifest.branchId) || !workingSetInteger(manifest.validityEpoch, 1) || !workingSetInteger(manifest.storyRevision) || !workingSetInteger(manifest.headRevision) || !isWorkingSetHash(manifest.headHash) || !isWorkingSetHash(manifest.sourceSnapshotHash) || !isWorkingSetHash(manifest.sourceCardSetHash) || manifest.currentSceneTailHash !== undefined && !isWorkingSetHash(manifest.currentSceneTailHash) || !isWorkingSetHash(manifest.queryHash) || !isWorkingSetHash(manifest.indexHash) || !nonEmptyWorkingSetText(manifest.contractId) || !isWorkingSetHash(manifest.contractHash) || !isWorkingSetHash(manifest.contractContentHash) || !workingSetInteger(manifest.budgetTokens, 1) || !workingSetInteger(manifest.estimatedTokens) || !nonEmptyWorkingSetText(manifest.estimatorVersion) || !workingSetSectionsOrdered(manifest.sections) || !Array.isArray(manifest.sections) || manifest.sections.some((section, index) => { try { assertWorkingSetSection(section, `scene_manifest_section_${index}`); return false } catch { return true } }) || !Array.isArray(manifest.omitted) || manifest.omitted.some((item, index) => { try { assertWorkingSetOmission(item, `scene_manifest_omitted_${index}`); return false } catch { return true } }) || !isWorkingSetHash(manifest.workingSetHash) || !isWorkingSetHash(manifest.manifestHash) || !isWorkingSetHash(manifest.workingSetMessageHash)) throw new Error('scene_working_set_manifest_corrupt')
    if (!hasOnlyKeys(message, ['schemaVersion', 'runId', 'sceneId', 'manifestHash', 'messages', 'messageHash']) || message.schemaVersion !== 1 || !nonEmptyWorkingSetText(message.runId) || !nonEmptyWorkingSetText(message.sceneId) || !isWorkingSetHash(message.manifestHash) || !Array.isArray(message.messages) || message.messages.length !== 1 || message.messages.some((item) => !isPlainRecord(item) || !hasOnlyKeys(item, ['role', 'content']) || item.role !== 'system' || typeof item.content !== 'string') || !isWorkingSetHash(message.messageHash)) throw new Error('scene_working_set_message_corrupt')
    const ws = record.workingSet
    const mf = record.manifest
    const msg = record.workingSetMessage
    const identityKeys = ['runId', 'sceneId', 'storyId', 'projectId', 'branchId', 'validityEpoch', 'storyRevision', 'headRevision', 'headHash', 'sourceSnapshotHash', 'sourceCardSetHash', 'currentSceneTailHash', 'queryHash', 'indexHash', 'contractId', 'contractHash', 'contractContentHash', 'budgetTokens', 'estimatedTokens', 'estimatorVersion'] as const
    for (const key of identityKeys) if (ws[key] !== mf[key]) throw new Error(`scene_working_set_manifest_binding_${key}`)
    if (!sameWorkingSetJson(ws.sections, mf.sections) || !sameWorkingSetJson(ws.omitted, mf.omitted) || ws.workingSetHash !== mf.workingSetHash || ws.manifestHash !== mf.manifestHash || ws.workingSetMessageHash !== mf.workingSetMessageHash || msg.runId !== ws.runId || msg.sceneId !== ws.sceneId || msg.manifestHash !== mf.manifestHash || mf.workingSetMessageHash !== msg.messageHash || expectedWorkingSetHash(ws) !== ws.workingSetHash) throw new Error('scene_working_set_binding_mismatch')
    const { manifestHash: _manifestHash, ...manifestCore } = mf
    if (sceneMemoryStableHash(manifestCore) !== mf.manifestHash) throw new Error('scene_working_set_manifest_hash_mismatch')
    if (sceneMemoryStableHash(msg.messages) !== msg.messageHash) throw new Error('scene_working_set_message_hash_mismatch')
    const cutoffs = record.branchCutoffs as Record<string, unknown>
    for (const [branch, cutoff] of Object.entries(cutoffs)) if (!record.branchLineage.includes(branch) || !workingSetInteger(cutoff)) throw new Error('scene_working_set_cutoff_corrupt')
  }

  const canonicalWorkingSetHash = (record: SceneWorkingSetPersistenceRecord): string => sceneMemoryStableHash(record)

  // Binding the final provider envelope is intentionally a second-phase
  // mutation.  Re-saving the same compiler record after that bind must remain
  // idempotent; compare the immutable authority tuple separately from the
  // mutable final-envelope hash.
  const sameWorkingSetAuthorityRecord = (left: SceneWorkingSetPersistenceRecord, right: SceneWorkingSetPersistenceRecord): boolean => {
    const { finalEnvelopeHash: _leftFinalEnvelopeHash, ...leftAuthority } = left
    const { finalEnvelopeHash: _rightFinalEnvelopeHash, ...rightAuthority } = right
    return sameWorkingSetJson(leftAuthority, rightAuthority)
  }

  /**
   * Validate the exact provider envelope at the repository boundary.  The
   * durable row stores only its canonical wire hash, so accepting a caller
   * supplied hash without the bytes would create an unverifiable second
   * authority.  Keep this shape deliberately aligned with DsMessage: the
   * hash helper intentionally covers ordered role/content bytes and ignores
   * non-wire metadata such as tool-call bookkeeping.
   */
  const canonicalProviderMessages = (value: unknown): readonly DsMessage[] => {
    if (!Array.isArray(value) || value.length === 0 || value.some((message) => {
      if (!isPlainRecord(message)) return true
      const candidate = message as Record<string, unknown>
      // v2 currently emits only a system Working Set plus the current user.
      // Reject assistant/tool/optional DsMessage wire fields here until a
      // dedicated canonical serializer covers those provider shapes.
      return Object.keys(candidate).some((key) => key !== 'role' && key !== 'content') || !['system', 'user'].includes(String(candidate.role)) || typeof candidate.content !== 'string'
    })) throw new Error('scene_working_set_final_envelope_invalid')
    return value as DsMessage[]
  }

  const fullWorkingSetRecordFromInput = (input: SceneMemoryWorkingSetInput): { record: SceneWorkingSetPersistenceRecord; cardIds: string[]; canonicalJson: string; canonicalHash: string; storageStatus: 'active' | 'stale' | 'retracted'; createdAt: number } | null => {
    const looksComplete = input.workingSet !== undefined || input.manifest !== undefined || input.workingSetMessage !== undefined || input.runId !== undefined
    if (!looksComplete) return null
    const ws = input.workingSet ?? {
      schemaVersion: 1 as const,
      workingSetId: input.workingSetId,
      runId: input.runId,
      sceneId: input.sceneId,
      storyId: input.storyId,
      projectId: input.projectId,
      branchId: input.branchId,
      validityEpoch: input.validityEpoch,
      storyRevision: input.storyRevision,
      headRevision: input.headRevision,
      headHash: input.headHash,
      sourceSnapshotHash: input.sourceSnapshotHash,
      sourceCardSetHash: input.sourceCardSetHash,
      queryHash: input.queryHash,
      indexHash: input.indexHash,
      contractId: input.contractId,
      contractHash: input.contractHash,
      contractContentHash: input.contractContentHash,
      budgetTokens: input.budgetTokens,
      estimatedTokens: input.estimatedTokens,
      estimatorVersion: input.estimatorVersion,
      sections: input.sections ?? [],
      omitted: input.omitted ?? [],
      workingSetHash: input.workingSetHash,
      manifestHash: input.manifestHash,
      workingSetMessageHash: input.workingSetMessageHash,
      status: typeof input.status === 'string' && WORKING_SET_STATUS.has(input.status as SceneWorkingSetStatus) ? input.status as SceneWorkingSetStatus : 'ready'
    } as unknown as SceneWorkingSet
    const manifest = input.manifest ?? {
      schemaVersion: 1 as const,
      runId: ws.runId,
      sceneId: ws.sceneId,
      storyId: ws.storyId,
      projectId: ws.projectId,
      branchId: ws.branchId,
      validityEpoch: ws.validityEpoch,
      storyRevision: ws.storyRevision,
      headRevision: ws.headRevision,
      headHash: ws.headHash,
      sourceSnapshotHash: ws.sourceSnapshotHash,
      sourceCardSetHash: ws.sourceCardSetHash,
      queryHash: ws.queryHash,
      indexHash: ws.indexHash,
      contractId: ws.contractId,
      contractHash: ws.contractHash,
      contractContentHash: ws.contractContentHash,
      budgetTokens: ws.budgetTokens,
      estimatedTokens: ws.estimatedTokens,
      estimatorVersion: ws.estimatorVersion,
      sections: ws.sections,
      omitted: ws.omitted,
      workingSetHash: ws.workingSetHash,
      manifestHash: input.manifestHash,
      workingSetMessageHash: ws.workingSetMessageHash
    } as unknown as SceneContextManifest
    const message = input.workingSetMessage
    if (!message) throw new Error('scene_working_set_message_required')
    const branchLineage = [...(input.branchLineage ?? [ws.branchId])]
    const branchCutoffs = Object.fromEntries(Object.entries(input.branchCutoffs ?? {}).map(([key, value]) => [key, value]))
    const finalEnvelopeHash = input.finalEnvelope !== undefined
      ? providerEnvelopeHash(canonicalProviderMessages(input.finalEnvelope))
      : null
    // A final envelope is a second-phase binding.  Hash-only writes are
    // intentionally rejected: there is no way for this repository to prove
    // that the caller's hash corresponds to the actual provider messages.
    if (input.finalEnvelope === undefined && input.finalEnvelopeHash !== undefined && input.finalEnvelopeHash !== null) throw new Error('scene_working_set_final_envelope_required')
    if (input.finalEnvelope !== undefined && input.finalEnvelopeHash !== undefined && input.finalEnvelopeHash !== null && input.finalEnvelopeHash !== finalEnvelopeHash) throw new Error('scene_working_set_final_envelope_hash_mismatch')
    const record: SceneWorkingSetPersistenceRecord = { schemaVersion: 1, workingSet: ws, manifest, workingSetMessage: message, branchLineage, branchCutoffs, finalEnvelopeHash }
    assertWorkingSetParts(record)
    const derivedCardIds = [...new Set(ws.sections.flatMap((section) => section.sourceCardIds))]
    const cardIds = [...(input.cardIds ?? derivedCardIds)]
    if (input.sections !== undefined && !sameWorkingSetJson(input.sections, ws.sections) || input.omitted !== undefined && !sameWorkingSetJson(input.omitted, ws.omitted) || !sameWorkingSetJson(cardIds, derivedCardIds) || cardIds.some((id) => !nonEmptyWorkingSetText(id)) || new Set(cardIds).size !== cardIds.length) throw new Error('scene_working_set_card_ids_corrupt')
    const storageStatus = input.storageStatus ?? (input.status === 'stale' || input.status === 'retracted' || input.status === 'active' ? input.status : 'active')
    const createdAt = input.createdAt ?? Date.now()
    if (!Number.isFinite(createdAt)) throw new Error('scene_working_set_time_invalid')
    const canonicalJson = stableSceneMemoryJson(record)
    const canonicalHash = canonicalWorkingSetHash(record)
    return { record, cardIds, canonicalJson, canonicalHash, storageStatus, createdAt }
  }

  const assertSceneWorkingSetLiveAuthority = (d: SqliteDb, record: SceneWorkingSetPersistenceRecord, cardIds: readonly string[]): { snapshot: SceneRecallCorpusSnapshot; cutoffs: Map<string, number> } => {
    const workingSet = record.workingSet
    const fence: SceneRecallCorpusSnapshotFence = {
      storyId: workingSet.storyId,
      projectId: workingSet.projectId,
      branchId: workingSet.branchId,
      branchLineage: record.branchLineage,
      validityEpoch: workingSet.validityEpoch,
      storyRevision: workingSet.storyRevision,
      headRevision: workingSet.headRevision,
      headHash: workingSet.headHash,
      expectedSourceCardSetHash: workingSet.sourceCardSetHash
    }
    const run = d.prepare('SELECT 1 AS present FROM runs WHERE run_id=?').get(workingSet.runId) as { present?: number } | undefined
    const ledgerRun = d.prepare('SELECT story_id, project_id, branch_id, validity_epoch, current_revision FROM story_ledger_runs WHERE run_id=?').get(workingSet.runId) as { story_id?: string; project_id?: string; branch_id?: string; validity_epoch?: number; current_revision?: number } | undefined
    if (run?.present !== 1 || !ledgerRun || ledgerRun.story_id !== workingSet.storyId || ledgerRun.project_id !== workingSet.projectId || ledgerRun.branch_id !== workingSet.branchId || ledgerRun.validity_epoch !== workingSet.validityEpoch || ledgerRun.current_revision !== workingSet.storyRevision) throw new Error('scene_working_set_run_fence_mismatch')
    const { lineage, heads, cutoffs } = readSceneRecallBranchLineage(d, fence)
    const targetHead = heads.get(workingSet.branchId)
    const targetHeadHash = targetHead
      ? normalizedStoredRecallHeadHash({ schemaVersion: 1, storyId: workingSet.storyId, projectId: workingSet.projectId, branchId: workingSet.branchId }, workingSet.validityEpoch, targetHead)
      : null
    if (!targetHead || targetHead.high_watermark !== workingSet.headRevision || targetHeadHash !== workingSet.headHash || targetHead.validity_epoch !== workingSet.validityEpoch || targetHead.hash_schema_version !== 2 || lineage.length !== record.branchLineage.length || lineage.some((branch, index) => branch !== record.branchLineage[index])) throw new Error('scene_working_set_head_fence_mismatch')
    if (Object.keys(record.branchCutoffs).length > 0) {
      const expectedCutoffs = Object.fromEntries([...cutoffs.entries()])
      if (!sameWorkingSetJson(record.branchCutoffs, expectedCutoffs)) throw new Error('scene_working_set_cutoff_mismatch')
    }
    const snapshot = getSceneRecallCorpusSnapshot({ runId: workingSet.runId, sceneId: workingSet.sceneId, ...(workingSet.currentSceneTailHash !== undefined ? { currentSceneTail: { contractHash: workingSet.contractHash, recentChars: SCENE_WORKING_SET_CURRENT_TAIL_CHARS, expectedTailHash: workingSet.currentSceneTailHash } } : {}), expectedFence: fence })
    if (snapshot.sourceSnapshotHash !== workingSet.sourceSnapshotHash || snapshot.sourceCardSetHash !== workingSet.sourceCardSetHash || workingSet.currentSceneTailHash !== undefined && snapshot.currentSceneTail?.tailHash !== workingSet.currentSceneTailHash || snapshot.scope.headRevision !== workingSet.headRevision || snapshot.scope.headHash !== workingSet.headHash || !sameWorkingSetJson(snapshot.scope.branchLineage, record.branchLineage)) throw new Error('scene_working_set_source_fence_mismatch')
    const byId = new Map(snapshot.corpus.map((item) => [item.card.cardId, item]))
    for (const cardId of cardIds) {
      const item = byId.get(cardId)
      if (!item || item.card.status !== 'canonical' || item.stale === true || item.retracted === true || !sceneMemoryWorkingSetCardAllowed(item.card, { storyId: workingSet.storyId, projectId: workingSet.projectId, branchId: workingSet.branchId, validityEpoch: workingSet.validityEpoch, storyRevision: workingSet.storyRevision, sceneId: workingSet.sceneId }, lineage, cutoffs)) throw new Error('scene_working_set_card_not_visible')
    }
    return { snapshot, cutoffs }
  }

  const readSceneWorkingSet = (d: SqliteDb, row: { [key: string]: unknown }, includeHidden: boolean): SceneWorkingSetReadResult | null => {
    const status = row.status
    if (typeof status !== 'string' || !['active', 'stale', 'retracted'].includes(status)) throw new Error('scene_working_set_status_corrupt')
    const workingSetId = row.working_set_id
    const storyId = row.story_id
    const projectId = row.project_id
    const branchId = row.branch_id
    const sceneId = row.scene_id
    const queryHash = row.query_hash
    const workingSetHash = row.working_set_hash
    const validityEpoch = Number(row.validity_epoch)
    const storyRevision = Number(row.story_revision)
    const createdAt = Number(row.created_at)
    const updatedAt = Number(row.updated_at)
    if (typeof workingSetId !== 'string' || !workingSetId || typeof storyId !== 'string' || !storyId || typeof projectId !== 'string' || !projectId || typeof branchId !== 'string' || !branchId || typeof sceneId !== 'string' || !sceneId || typeof queryHash !== 'string' || !queryHash || typeof workingSetHash !== 'string' || !SCENE_MEMORY_HASH.test(workingSetHash) || !Number.isInteger(validityEpoch) || validityEpoch < 1 || !Number.isInteger(storyRevision) || storyRevision < 0 || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) throw new Error('scene_working_set_authority_corrupt')
    const canonicalJson = row.canonical_json
    const canonicalHash = row.canonical_hash
    if (Number(row.schema_version) === 1 || canonicalJson !== null && canonicalJson !== undefined || canonicalHash !== null && canonicalHash !== undefined) {
      if (Number(row.schema_version) !== 1 || typeof canonicalJson !== 'string' || !isWorkingSetHash(canonicalHash)) throw new Error('scene_working_set_canonical_missing')
      const canonical = parseStrictSceneMemoryJson(canonicalJson, 'scene_working_set_canonical')
      if (!isPlainRecord(canonical)) throw new Error('scene_working_set_canonical_corrupt')
      if (stableSceneMemoryJson(canonical) !== canonicalJson) throw new Error('scene_working_set_canonical_encoding_mismatch')
      if (canonicalHash !== sceneMemoryStableHash(canonical)) throw new Error('scene_working_set_canonical_hash_mismatch')
      const record = canonical as unknown as SceneWorkingSetPersistenceRecord
      assertWorkingSetParts(record)
      const ws = record.workingSet
      const branchLineageJson = parseStrictSceneMemoryJson(row.branch_lineage_json, 'scene_working_set_branch_lineage')
      const branchCutoffsJson = parseStrictSceneMemoryJson(row.branch_cutoffs_json, 'scene_working_set_branch_cutoffs')
      if (typeof row.branch_lineage_json !== 'string' || stableSceneMemoryJson(branchLineageJson) !== row.branch_lineage_json || typeof row.branch_cutoffs_json !== 'string' || stableSceneMemoryJson(branchCutoffsJson) !== row.branch_cutoffs_json || !sameWorkingSetJson(ws, record.workingSet) || !sameWorkingSetJson(branchLineageJson, record.branchLineage) || !sameWorkingSetJson(branchCutoffsJson, record.branchCutoffs) || row.payload_json !== canonicalJson || row.working_set_id !== ws.workingSetId || row.story_id !== ws.storyId || row.project_id !== ws.projectId || row.branch_id !== ws.branchId || row.validity_epoch !== ws.validityEpoch || row.story_revision !== ws.storyRevision || row.scene_id !== ws.sceneId || row.query_hash !== ws.queryHash || row.working_set_hash !== ws.workingSetHash || row.run_id !== ws.runId || row.final_envelope_hash !== record.finalEnvelopeHash) throw new Error('scene_working_set_column_mismatch')
      const cardIdsValue = parseStrictSceneMemoryJson(row.card_ids_json, 'scene_working_set_card_ids')
      const omittedValue = parseStrictSceneMemoryJson(row.omitted_json, 'scene_working_set_omitted')
      const cardIds = cardIdsValue as unknown
      if (typeof row.card_ids_json !== 'string' || stableSceneMemoryJson(cardIdsValue) !== row.card_ids_json || typeof row.omitted_json !== 'string' || stableSceneMemoryJson(omittedValue) !== row.omitted_json || !Array.isArray(cardIds) || cardIds.some((cardId) => typeof cardId !== 'string' || cardId.length === 0) || new Set(cardIds as string[]).size !== cardIds.length || !sameWorkingSetJson(omittedValue, ws.omitted) || !sameWorkingSetJson(cardIds, [...new Set(ws.sections.flatMap((section) => section.sourceCardIds))])) throw new Error('scene_working_set_shape_corrupt')
      if (!includeHidden && status !== 'active') return null
      if (status === 'active') assertSceneWorkingSetLiveAuthority(d, record, cardIds as string[])
      return {
        workingSetId: ws.workingSetId,
        storyId: ws.storyId,
        projectId: ws.projectId,
        branchId: ws.branchId,
        branchLineage: [...record.branchLineage],
        branchCutoffs: { ...record.branchCutoffs },
        validityEpoch: ws.validityEpoch,
        storyRevision: ws.storyRevision,
        headRevision: ws.headRevision,
        headHash: ws.headHash,
        runId: ws.runId,
        sceneId: ws.sceneId,
        sourceSnapshotHash: ws.sourceSnapshotHash,
        sourceCardSetHash: ws.sourceCardSetHash,
        queryHash: ws.queryHash,
        indexHash: ws.indexHash,
        contractId: ws.contractId,
        contractHash: ws.contractHash,
        contractContentHash: ws.contractContentHash,
        budgetTokens: ws.budgetTokens,
        estimatedTokens: ws.estimatedTokens,
        estimatorVersion: ws.estimatorVersion,
        sections: ws.sections.map((section) => ({ ...section, sourceCardIds: [...section.sourceCardIds] })),
        cardIds: [...(cardIds as string[])],
        omitted: ws.omitted.map((item) => ({ ...item })),
        payload: record,
        workingSetHash: ws.workingSetHash,
        manifestHash: ws.manifestHash,
        workingSetMessageHash: ws.workingSetMessageHash,
        workingSet: ws,
        manifest: record.manifest,
        workingSetMessage: record.workingSetMessage,
        finalEnvelopeHash: record.finalEnvelopeHash,
        canonicalHash,
        status,
        createdAt,
        updatedAt
      }
    }
    if (!includeHidden && status !== 'active') return null
    const cardIdsValue = parseStrictSceneMemoryJson(row.card_ids_json, 'scene_working_set_card_ids')
    const omittedValue = parseStrictSceneMemoryJson(row.omitted_json, 'scene_working_set_omitted')
    const payload = parseStrictSceneMemoryJson(row.payload_json, 'scene_working_set_payload')
    if (!Array.isArray(cardIdsValue) || cardIdsValue.some((cardId) => typeof cardId !== 'string' || cardId.length === 0) || new Set(cardIdsValue).size !== cardIdsValue.length || !Array.isArray(omittedValue)) throw new Error('scene_working_set_shape_corrupt')
    const cardIds = cardIdsValue as string[]
    const omitted = omittedValue as unknown[]
    const expectedHash = sceneMemoryStableHash({ storyId, projectId, branchId, validityEpoch, storyRevision, sceneId, queryHash, cardIds, omitted, payload })
    if (expectedHash !== workingSetHash) throw new Error('scene_working_set_hash_mismatch')
    if (status === 'active') {
      for (const cardId of cardIds) {
        const cardRow = d.prepare('SELECT * FROM scene_memory_cards WHERE card_id=?').get(cardId) as { [key: string]: unknown } | undefined
        if (!cardRow || cardRow.visibility !== 'active' || !sceneMemoryCardRowVisible(d, cardRow)) throw new Error('scene_working_set_card_not_visible')
        const card = sceneMemoryCardFromRow(cardRow)
        if (!sceneMemoryWorkingSetCardAllowed(card, { storyId, projectId, branchId, validityEpoch, storyRevision, sceneId })) throw new Error('scene_working_set_card_scope_mismatch')
      }
    }
    return { workingSetId, storyId, projectId, branchId, validityEpoch, storyRevision, sceneId, queryHash, cardIds, omitted, payload, workingSetHash, status, createdAt, updatedAt, legacy: true }
  }

  const readSceneRecallBranchLineage = (d: SqliteDb, fence: SceneRecallCorpusSnapshotFence): { lineage: string[]; heads: Map<string, StoryLedgerHeadRow>; cutoffs: Map<string, number> } => {
    const heads = new Map<string, StoryLedgerHeadRow>()
    const reverse: string[] = []
    const visited = new Set<string>()
    let branchId = fence.branchId
    while (true) {
      if (visited.has(branchId)) throw new Error('scene_recall_snapshot_branch_cycle')
      visited.add(branchId)
      const head = d.prepare('SELECT * FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(fence.storyId, fence.projectId, branchId) as StoryLedgerHeadRow | undefined
      if (!head || !Number.isInteger(head.high_watermark) || head.high_watermark < 0 || !Number.isInteger(head.parent_revision) || head.parent_revision < 0 || head.parent_revision > head.high_watermark || !Number.isInteger(head.validity_epoch) || head.validity_epoch < 1 || head.validity_epoch !== fence.validityEpoch || head.hash_schema_version !== 2 || head.high_watermark > 0 && (typeof head.head_hash !== 'string' || !SCENE_MEMORY_HASH.test(head.head_hash)) || head.high_watermark === 0 && head.head_hash !== null) throw new Error('scene_recall_snapshot_scope_missing')
      if (head.high_watermark > 0) {
        const terminal = d.prepare(`SELECT revision_hash, validity_epoch, hash_schema_version
          FROM story_ledger_revisions WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?`).get(fence.storyId, fence.projectId, branchId, head.high_watermark) as { revision_hash?: unknown; validity_epoch?: unknown; hash_schema_version?: unknown } | undefined
        if (!terminal || terminal.revision_hash !== head.head_hash || terminal.validity_epoch !== head.validity_epoch || terminal.hash_schema_version !== 2) throw new Error('scene_recall_snapshot_scope_missing')
      }
      heads.set(branchId, head)
      reverse.push(branchId)
      if (head.parent_branch_id === null) break
      if (!head.parent_branch_id || head.parent_branch_id === branchId) throw new Error('scene_recall_snapshot_branch_identity_invalid')
      branchId = head.parent_branch_id
    }
    const lineage = reverse.reverse()
    if (fence.branchLineage.length !== lineage.length || fence.branchLineage.some((value, index) => value !== lineage[index])) throw new Error('scene_recall_snapshot_branch_lineage_mismatch')
    const cutoffs = new Map<string, number>()
    let cutoff = fence.storyRevision
    for (let index = lineage.length - 1; index >= 0; index -= 1) {
      const current = lineage[index]!
      cutoffs.set(current, cutoff)
      if (index > 0) cutoff = Math.min(cutoff, Number(heads.get(current)?.parent_revision ?? 0))
    }
    return { lineage, heads, cutoffs }
  }

  const readSceneRecallLedgerClaims = (d: SqliteDb, card: SceneMemoryCard, acceptedContentHash: string): SceneMemoryCardValidationContext['ledgerClaims'][number][] => {
    const rows = d.prepare(`SELECT change_id, change_kind, payload_json, delta_hash, contract_hash, accepted_content_hash
      FROM narrative_ledger WHERE run_id=? AND scene_id=? ORDER BY change_revision ASC, change_id ASC`).all(card.runId, card.sceneId) as Array<{ change_id?: unknown; change_kind?: unknown; payload_json?: unknown; delta_hash?: unknown; contract_hash?: unknown; accepted_content_hash?: unknown }>
    const claims: SceneMemoryCardValidationContext['ledgerClaims'][number][] = []
    for (const row of rows) {
      if (row.change_kind !== 'relationship' && row.change_kind !== 'foreshadow') continue
      if (row.delta_hash !== card.stateDeltaHash || row.contract_hash !== card.contractHash || row.accepted_content_hash !== acceptedContentHash) throw new Error('scene_recall_snapshot_ledger_binding_mismatch')
      if (typeof row.change_id !== 'string' || !row.change_id || typeof row.payload_json !== 'string') throw new Error('scene_recall_snapshot_ledger_corrupt')
      const payload = parseStrictSceneMemoryJson(row.payload_json, 'scene_recall_snapshot_ledger_payload')
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('scene_recall_snapshot_ledger_corrupt')
      const value = payload as Record<string, unknown>
      const base = {
        id: row.change_id,
        revision: card.storyRevision,
        validityEpoch: card.validityEpoch,
        storyId: card.storyId,
        projectId: card.projectId,
        branchId: card.branchId,
        stateDeltaHash: card.stateDeltaHash,
        commitManifestHash: card.commitManifestHash
      }
      if (row.change_kind === 'relationship') {
        if (typeof value.fromCharacterId !== 'string' || !value.fromCharacterId || typeof value.toCharacterId !== 'string' || !value.toCharacterId || typeof value.dimension !== 'string' || !value.dimension) throw new Error('scene_recall_snapshot_ledger_corrupt')
        const claimWithoutHash = { ...base, kind: 'relationship' as const, fromCharacterId: value.fromCharacterId, toCharacterId: value.toCharacterId, dimension: value.dimension }
        claims.push({ ...claimWithoutHash, hash: sceneMemoryLedgerClaimHash(claimWithoutHash) })
      } else {
        if (typeof value.threadId !== 'string' || !value.threadId || !['open', 'advanced', 'delayed', 'resolved', 'abandoned'].includes(String(value.lifecycle))) throw new Error('scene_recall_snapshot_ledger_corrupt')
        const claimWithoutHash = { ...base, kind: 'foreshadow' as const, threadId: value.threadId, lifecycle: value.lifecycle as 'open' | 'advanced' | 'delayed' | 'resolved' | 'abandoned' }
        claims.push({ ...claimWithoutHash, hash: sceneMemoryLedgerClaimHash(claimWithoutHash) })
      }
    }
    return claims
  }

  const sceneRecallEvidenceHash = (card: SceneMemoryCard, refs: readonly { kind: string; hash: string }[] | undefined): string => {
    const evidence = (refs ?? []).find((ref) => ref.kind === 'source_span')
    if (!evidence || !SCENE_MEMORY_HASH.test(evidence.hash) || !card.sourceSpans.some((span) => span.spanHash === evidence.hash)) throw new Error('scene_recall_snapshot_evidence_missing')
    return evidence.hash
  }

  const readSceneRecallCorpusItem = (d: SqliteDb, row: { [key: string]: unknown }, input: SceneRecallCorpusSnapshotInput, fence: SceneRecallCorpusSnapshotFence, lineage: readonly string[], cutoffs: ReadonlyMap<string, number>): SceneRecallCorpusItem => {
    if (!sceneMemoryCardRowVisible(d, row)) throw new Error('scene_recall_snapshot_card_not_visible')
    const card = sceneMemoryCardFromRow(row)
    if (card.status !== 'canonical' || card.storyId !== fence.storyId || card.projectId !== fence.projectId || card.validityEpoch !== fence.validityEpoch || !lineage.includes(card.branchId) || card.storyRevision > Number(cutoffs.get(card.branchId) ?? -1) || card.sceneId === input.sceneId) throw new Error('scene_recall_snapshot_card_scope_invalid')
    const manifestRow = d.prepare('SELECT revision, manifest_json, manifest_hash FROM scene_commit_manifests WHERE run_id=? AND scene_id=?').get(card.runId, card.sceneId) as { revision?: unknown; manifest_json?: unknown; manifest_hash?: unknown } | undefined
    if (typeof manifestRow?.manifest_json !== 'string' || typeof manifestRow.manifest_hash !== 'string' || manifestRow.manifest_hash !== card.commitManifestHash) throw new Error('scene_recall_snapshot_manifest_missing')
    let manifest: SceneCommitManifest
    try { manifest = parseSceneCommitManifest(JSON.parse(manifestRow.manifest_json)) } catch { throw new Error('scene_recall_snapshot_manifest_corrupt') }
    // Manifest/scene/commit revisions are scene-mutation revisions; the card
    // carries a story-ledger revision. Bind each to its own authority below.
    if (typeof manifestRow.revision !== 'number' || !Number.isSafeInteger(manifestRow.revision) || manifestRow.revision < 1 || manifest.runId !== card.runId || manifest.sceneId !== card.sceneId || manifest.contractId !== card.contractId || manifest.contractHash !== card.contractHash || manifest.sceneContentHash !== card.sceneContentHash || manifest.stateDeltaHash !== card.stateDeltaHash || sceneCommitManifestHash(manifest) !== manifestRow.manifest_hash) throw new Error('scene_recall_snapshot_manifest_binding_mismatch')
    const sourceRows = readAcceptedSceneRows(d, card.runId, card.sceneId)
    const manifestIds = manifest.acceptedSegments.map((item) => `${item.segmentId}\u0000${item.contentHash}\u0000${item.charCount}\u0000${item.chunkIndex}\u0000${item.revision}`).join('\u0001')
    const sourceIds = sourceRows.map((item) => `${item.segment_id}\u0000${item.content_hash}\u0000${item.char_count}\u0000${item.chunk_index}\u0000${item.revision}`).join('\u0001')
    if (manifestIds !== sourceIds || manifest.acceptedSegments.length !== card.sourceSegmentIds.length || manifest.acceptedSegments.some((item) => !card.sourceSegmentIds.includes(item.segmentId)) || sourceRows.some((item) => !card.sourceSegmentIds.includes(item.segment_id)) || sourceRows.some((item) => manuscriptSegmentHash(item.content) !== item.content_hash || item.char_count !== codePointLength(item.content)) || manifest.sceneCharCount !== codePointLength(sourceRows.map((item) => item.content).join(''))) throw new Error('scene_recall_snapshot_source_manifest_mismatch')
    const sourceSegments = sourceRows.map((item) => sourceSegmentFromRow(item, card.commitManifestHash))
    const sceneState = d.prepare('SELECT revision, lifecycle, contract_id, contract_hash, accepted_segment_id, accepted_hash FROM scene_states WHERE run_id=? AND scene_id=?').get(card.runId, card.sceneId) as { revision?: unknown; lifecycle?: unknown; contract_id?: unknown; contract_hash?: unknown; accepted_segment_id?: unknown; accepted_hash?: unknown } | undefined
    const finalManifestSegment = manifest.acceptedSegments[manifest.acceptedSegments.length - 1]
    if (!finalManifestSegment || !sceneState || sceneState.revision !== manifestRow.revision || sceneState.lifecycle !== 'committed' || sceneState.contract_id !== card.contractId || sceneState.contract_hash !== card.contractHash || sceneState.accepted_segment_id !== finalManifestSegment.segmentId || sceneState.accepted_hash !== finalManifestSegment.contentHash || !sourceRows.some((item) => item.segment_id === sceneState.accepted_segment_id && item.content_hash === sceneState.accepted_hash)) throw new Error('scene_recall_snapshot_scene_state_missing')
    const commit = d.prepare('SELECT revision, accepted_segment_id, accepted_content_hash, contract_hash, delta_hash FROM narrative_commits WHERE run_id=? AND scene_id=?').get(card.runId, card.sceneId) as { revision?: unknown; accepted_segment_id?: unknown; accepted_content_hash?: unknown; contract_hash?: unknown; delta_hash?: unknown } | undefined
    const acceptedContentHash = finalManifestSegment.contentHash
    if (!commit || commit.revision !== manifestRow.revision || commit.contract_hash !== card.contractHash || commit.delta_hash !== card.stateDeltaHash || commit.accepted_segment_id !== finalManifestSegment.segmentId || commit.accepted_content_hash !== acceptedContentHash || !sourceRows.some((item) => item.segment_id === commit.accepted_segment_id && item.content_hash === commit.accepted_content_hash)) throw new Error('scene_recall_snapshot_commit_missing')
    const ledger = d.prepare(`SELECT run_id, scene_id, accepted_segment_id, accepted_content_hash, delta_hash, manifest_hash, validity_epoch, node_type,
      parent_revision, parent_hash, revision_hash, hash_schema_version
      FROM story_ledger_revisions WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?`).get(card.storyId, card.projectId, card.branchId, card.storyRevision) as { run_id?: unknown; scene_id?: unknown; accepted_segment_id?: unknown; accepted_content_hash?: unknown; delta_hash?: unknown; manifest_hash?: unknown; validity_epoch?: unknown; node_type?: 'revision' | 'rebase' | unknown; parent_revision?: unknown; parent_hash?: unknown; revision_hash?: unknown; hash_schema_version?: unknown } | undefined
    if (!ledger || ledger.run_id !== card.runId || ledger.scene_id !== card.sceneId || ledger.accepted_segment_id !== finalManifestSegment.segmentId || ledger.accepted_content_hash !== acceptedContentHash || ledger.delta_hash !== card.stateDeltaHash || ledger.manifest_hash !== card.commitManifestHash || ledger.validity_epoch !== card.validityEpoch || (ledger.node_type !== 'revision' && ledger.node_type !== 'rebase') || ledger.hash_schema_version !== 2 || typeof ledger.parent_revision !== 'number' || !Number.isInteger(ledger.parent_revision) || ledger.parent_revision < 0 || (ledger.parent_revision > 0 && (typeof ledger.parent_hash !== 'string' || !SCENE_MEMORY_HASH.test(ledger.parent_hash))) || typeof ledger.revision_hash !== 'string') throw new Error('scene_recall_snapshot_ledger_binding_mismatch')
    const ledgerParentRevision = ledger.parent_revision as number
    const ledgerParentHash = typeof ledger.parent_hash === 'string' ? ledger.parent_hash : null
    const expectedLedgerHash = storyLedgerRevisionHashV2({ storyId: card.storyId, projectId: card.projectId, branchId: card.branchId, revision: card.storyRevision, parentRevision: ledgerParentRevision, parentHash: ledgerParentHash, runId: card.runId, sceneId: card.sceneId, deltaHash: card.stateDeltaHash, manifestHash: card.commitManifestHash, nodeType: ledger.node_type, hashSchemaVersion: 2 })
    if (ledger.revision_hash !== expectedLedgerHash) throw new Error('scene_recall_snapshot_ledger_binding_mismatch')
    const claims = readSceneRecallLedgerClaims(d, card, acceptedContentHash)
    const validation = validateSceneMemoryCard(card, {
      sourceSegments,
      expectedScope: { storyId: card.storyId, projectId: card.projectId, branchId: card.branchId },
      expectedValidityEpoch: card.validityEpoch,
      expectedStoryRevision: card.storyRevision,
      expectedContract: { contractId: card.contractId, contractHash: card.contractHash },
      expectedBindings: { sceneContentHash: card.sceneContentHash, commitManifestHash: card.commitManifestHash, stateDeltaHash: card.stateDeltaHash },
      ledgerClaims: claims
    })
    if (!validation.ok) throw new Error(`scene_recall_snapshot_source_invalid:${validation.errors.join(',')}`)
    const sourceSnapshotHash = sceneRecallSourceSnapshotHash(card, sourceSegments)
    const authorityBase = {
      storyId: fence.storyId,
      projectId: fence.projectId,
      branchId: card.branchId,
      branchLineage: lineage.slice(0, lineage.indexOf(card.branchId) + 1),
      validityEpoch: fence.validityEpoch,
      storyRevision: card.storyRevision,
      headRevision: fence.headRevision,
      headHash: fence.headHash,
      sourceSnapshotHash,
      cardHash: card.cardHash
    }
    const metadata = <T extends { key: string; kind: 'entity' | 'thread' | 'location' | 'object' | 'payoff' }>(value: T, evidenceHash: string): SceneRecallAuthorityTag => {
      const base = { ...value, sourceCardHash: card.cardHash, evidenceHash, storyId: fence.storyId, projectId: fence.projectId, branchId: card.branchId, validityEpoch: fence.validityEpoch, storyRevision: card.storyRevision, headRevision: fence.headRevision, headHash: fence.headHash }
      return { ...base, authorityHash: sceneRecallAuthorityHash(base) }
    }
    const dependency = (key: string, kind: SceneRecallHardDependency['kind'], evidenceHash: string): SceneRecallHardDependency => {
      const base = { key, kind, sourceCardHash: card.cardHash, evidenceHash, storyId: fence.storyId, projectId: fence.projectId, branchId: card.branchId, validityEpoch: fence.validityEpoch, storyRevision: card.storyRevision, headRevision: fence.headRevision, headHash: fence.headHash }
      return { ...base, authorityHash: sceneRecallAuthorityHash(base) }
    }
    const hardDependencies: SceneRecallHardDependency[] = []
    const entityTags: SceneRecallAuthorityTag[] = []
    const threadTags: SceneRecallAuthorityTag[] = []
    for (const fact of card.factsEstablished) hardDependencies.push(dependency(`fact:${fact.factId}`, 'fact', sceneRecallEvidenceHash(card, fact.evidence)))
    for (const participant of card.participants) entityTags.push(metadata({ key: participant.id, kind: 'entity' }, sceneRecallEvidenceHash(card, participant.evidence)))
    for (const thread of card.threads) {
      const evidenceHash = sceneRecallEvidenceHash(card, thread.evidence)
      hardDependencies.push(dependency(`thread:${thread.threadId}`, 'thread', evidenceHash))
      threadTags.push(metadata({ key: thread.threadId, kind: 'thread' }, evidenceHash))
    }
    for (const [index, location] of card.locations.entries()) entityTags.push(metadata({ key: location, kind: 'location' }, sceneRecallEvidenceHash(card, card.fieldEvidence[`locations:${location}`] ?? card.fieldEvidence[`locations[${index}]`] ?? card.fieldEvidence.locations)))
    for (const [index, object] of card.objects.entries()) entityTags.push(metadata({ key: object, kind: 'object' }, sceneRecallEvidenceHash(card, card.fieldEvidence[`objects:${object}`] ?? card.fieldEvidence[`objects[${index}]`] ?? card.fieldEvidence.objects)))
    let povKnowledge: SceneRecallKnowledgeBoundary | undefined
    if (input.povCharacterId !== undefined && input.povCharacterId !== null) {
      // A card is whole-card knowledge only when it was authored for this
      // exact POV.  In particular, a public/null-POV card is not a safe
      // substitute for a POV-specific projection: the compiler may inject
      // source spans and would otherwise leak private thoughts or facts.
      let knowledgeKnown = card.povCharacterId === input.povCharacterId
      for (const fact of card.factsEstablished) {
        const rows = d.prepare('SELECT * FROM narrative_facts WHERE fact_id=? ORDER BY version DESC').all(fact.factId) as unknown as NarrativeFactRow[]
        if (rows.length === 0) {
          knowledgeKnown = false
          continue
        }
        let facts: NarrativeFact[]
        try { facts = rows.map((row) => narrativeFactFromRow(row)) } catch { throw new Error('scene_recall_snapshot_fact_corrupt') }
        const latest = facts[0]
        const newestVersion = Math.max(...facts.map((candidate) => candidate.version))
        // narrativeFactFromRow verifies canonical/provenance hashes and the
        // source list.  The latest version/status check prevents a stale or
        // retracted fact from becoming an authority through an older row.
        if (!latest || latest.version !== newestVersion || latest.status !== 'active' || latest.sources.length === 0) {
          knowledgeKnown = false
          continue
        }
        const knowers = latest.knowers
        if (!latest.visibility || (latest.visibility !== 'public' && latest.visibility !== 'restricted' && latest.visibility !== 'private') || latest.visibility !== 'public' && !knowers.includes(input.povCharacterId)) knowledgeKnown = false
      }
      const evidenceHash = card.factsEstablished.length > 0
        ? sceneRecallEvidenceHash(card, card.factsEstablished[0]?.evidence)
        : card.sourceSpans[0]?.spanHash
      if (!evidenceHash || !SCENE_MEMORY_HASH.test(evidenceHash)) throw new Error('scene_recall_snapshot_evidence_missing')
      // The shared contract's `unknownEntityIds` is deliberately left empty:
      // fact IDs are not entities and must never be mislabeled as such.  The
      // fail-closed bit is the authority for the compiler to omit the item.
      const knowledgeBase = { status: knowledgeKnown ? 'known' as const : 'unknown' as const, povCharacterId: input.povCharacterId, sourceCardHash: card.cardHash, evidenceHash, storyId: fence.storyId, projectId: fence.projectId, branchId: card.branchId, validityEpoch: fence.validityEpoch, storyRevision: card.storyRevision, headRevision: fence.headRevision, headHash: fence.headHash, unknownEntityIds: [] as readonly string[], unknownHardSource: !knowledgeKnown }
      povKnowledge = { ...knowledgeBase, authorityHash: sceneRecallAuthorityHash(knowledgeBase) }
    }
    const payoffTags: SceneRecallAuthorityTag[] = []
    let payoffUrgency: SceneRecallPayoffUrgency | undefined
    const payoffScore: Record<'open' | 'advanced' | 'delayed', number> = { open: 700, advanced: 850, delayed: 500 }
    for (const thread of card.threads) {
      if (!(thread.lifecycle in payoffScore)) continue
      const evidenceHash = sceneRecallEvidenceHash(card, thread.evidence)
      payoffTags.push(metadata({ key: thread.threadId, kind: 'payoff' }, evidenceHash))
      const candidate = payoffScore[thread.lifecycle as 'open' | 'advanced' | 'delayed']
      if (!payoffUrgency || candidate > payoffUrgency.value) {
        const urgencyBase = { value: candidate, sourceCardHash: card.cardHash, evidenceHash, storyId: fence.storyId, projectId: fence.projectId, branchId: card.branchId, validityEpoch: fence.validityEpoch, storyRevision: card.storyRevision, headRevision: fence.headRevision, headHash: fence.headHash }
        payoffUrgency = { ...urgencyBase, authorityHash: sceneRecallAuthorityHash(urgencyBase) }
      }
    }
    const embeddingRow = d.prepare('SELECT status, version, dimensions, vector_hash, vector_json, source_card_hash FROM scene_recall_embeddings WHERE card_id=?').get(card.cardId) as { status?: unknown; version?: unknown; dimensions?: unknown; vector_hash?: unknown; vector_json?: unknown; source_card_hash?: unknown } | undefined
    if (!embeddingRow || embeddingRow.source_card_hash !== card.cardHash || !['ready', 'unavailable', 'stale'].includes(String(embeddingRow.status))) throw new Error('scene_recall_snapshot_embedding_binding_mismatch')
    let vector: number[] | undefined
    if (typeof embeddingRow.vector_json === 'string') {
      const parsed = parseStrictSceneMemoryJson(embeddingRow.vector_json, 'scene_recall_snapshot_embedding_vector')
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8192 || parsed.some((value) => typeof value !== 'number' || !Number.isFinite(value)) || embeddingRow.status !== 'ready') throw new Error('scene_recall_snapshot_embedding_corrupt')
      vector = parsed as number[]
    }
    if (embeddingRow.status === 'ready' && (typeof embeddingRow.version !== 'string' || embeddingRow.version.length === 0 || !Number.isInteger(embeddingRow.dimensions) || Number(embeddingRow.dimensions) !== vector?.length || typeof embeddingRow.vector_hash !== 'string' || !SCENE_MEMORY_HASH.test(embeddingRow.vector_hash) || sceneMemoryStableHash(vector) !== embeddingRow.vector_hash)) throw new Error('scene_recall_snapshot_embedding_corrupt')
    if (embeddingRow.status !== 'ready' && (embeddingRow.vector_json !== null || embeddingRow.vector_hash !== null || embeddingRow.dimensions !== null)) throw new Error('scene_recall_snapshot_embedding_corrupt')
    const embeddingBase = { status: embeddingRow.status as 'ready' | 'unavailable' | 'stale', version: typeof embeddingRow.version === 'string' ? embeddingRow.version : null, similarity: undefined as number | undefined, vector, dimensions: typeof embeddingRow.dimensions === 'number' ? embeddingRow.dimensions : null, vectorHash: typeof embeddingRow.vector_hash === 'string' ? embeddingRow.vector_hash : null, sourceCardHash: card.cardHash, storyId: fence.storyId, projectId: fence.projectId, branchId: card.branchId, validityEpoch: fence.validityEpoch, storyRevision: card.storyRevision, headRevision: fence.headRevision, headHash: fence.headHash }
    const item: SceneRecallCorpusItem = {
      card,
      sourceSegments,
      sourceValidated: true,
      authority: { ...authorityBase, authorityHash: sceneRecallAuthorityHash(authorityBase) },
      hardDependencies,
      entityTags,
      threadTags,
      payoffTags,
      payoffUrgency,
      povKnowledge,
      causalEdges: [],
      embedding: { ...embeddingBase, authorityHash: sceneRecallAuthorityHash(embeddingBase) }
    }
    return item
  }

  const getSceneRecallCorpusSnapshot = (input: SceneRecallCorpusSnapshotInput): SceneRecallCorpusSnapshot => {
    if (!input || typeof input.runId !== 'string' || input.runId.length === 0 || typeof input.sceneId !== 'string' || input.sceneId.length === 0 || !input.expectedFence || !Array.isArray(input.expectedFence.branchLineage) || input.expectedFence.branchLineage.length === 0 || new Set(input.expectedFence.branchLineage).size !== input.expectedFence.branchLineage.length || input.expectedFence.branchLineage.some((value) => typeof value !== 'string' || value.length === 0) || !Number.isInteger(input.expectedFence.validityEpoch) || input.expectedFence.validityEpoch < 1 || !Number.isInteger(input.expectedFence.storyRevision) || input.expectedFence.storyRevision < 0 || !Number.isInteger(input.expectedFence.headRevision) || input.expectedFence.headRevision < input.expectedFence.storyRevision || typeof input.expectedFence.headHash !== 'string') throw new Error('scene_recall_snapshot_input_invalid')
    try {
      normalizedRecallFenceHeadHash({ schemaVersion: 1, storyId: input.expectedFence.storyId, projectId: input.expectedFence.projectId, branchId: input.expectedFence.branchId }, input.expectedFence.validityEpoch, input.expectedFence.storyRevision, input.expectedFence.headRevision, input.expectedFence.headHash)
    } catch {
      throw new Error('scene_recall_snapshot_input_invalid')
    }
    let snapshot: SceneRecallCorpusSnapshot | null = null
    withImmediateTransaction(() => {
      const d = requireDb()
      const fence = input.expectedFence
      const run = d.prepare('SELECT 1 AS present FROM runs WHERE run_id=?').get(input.runId) as { present?: number } | undefined
      const ledgerRun = d.prepare('SELECT story_id, project_id, branch_id, validity_epoch, current_revision FROM story_ledger_runs WHERE run_id=?').get(input.runId) as { story_id?: string; project_id?: string; branch_id?: string; validity_epoch?: number; current_revision?: number } | undefined
      if (run?.present !== 1 || !ledgerRun || ledgerRun.story_id !== fence.storyId || ledgerRun.project_id !== fence.projectId || ledgerRun.branch_id !== fence.branchId || ledgerRun.validity_epoch !== fence.validityEpoch || ledgerRun.current_revision !== fence.storyRevision) throw new Error('scene_recall_snapshot_fence_mismatch')
      const { lineage, heads, cutoffs } = readSceneRecallBranchLineage(d, fence)
      const targetHead = heads.get(fence.branchId)!
      const targetHeadHash = normalizedStoredRecallHeadHash({ schemaVersion: 1, storyId: fence.storyId, projectId: fence.projectId, branchId: fence.branchId }, fence.validityEpoch, targetHead)
      if (targetHead.high_watermark !== fence.headRevision || targetHead.validity_epoch !== fence.validityEpoch || targetHeadHash !== fence.headHash || targetHead.hash_schema_version !== 2) throw new Error('scene_recall_snapshot_fence_mismatch')
      const rows = d.prepare(`SELECT * FROM scene_memory_cards WHERE story_id=? AND project_id=? AND validity_epoch=? AND visibility='active' AND status='canonical' AND branch_id IN (${lineage.map(() => '?').join(',')}) ORDER BY story_revision ASC, scene_order ASC, card_id ASC`).all(fence.storyId, fence.projectId, fence.validityEpoch, ...lineage) as Array<{ [key: string]: unknown }>
      const corpus: SceneRecallCorpusItem[] = []
      for (const row of rows) {
        const branch = typeof row.branch_id === 'string' ? row.branch_id : ''
        if (!lineage.includes(branch) || Number(row.story_revision) > Number(cutoffs.get(branch) ?? -1) || row.scene_id === input.sceneId) continue
        corpus.push(readSceneRecallCorpusItem(d, row, input, fence, lineage, cutoffs))
      }
      const sourceCardSetHash = sceneRecallSourceCardSetHash(corpus)
      if (fence.expectedSourceCardSetHash !== undefined && fence.expectedSourceCardSetHash !== sourceCardSetHash) throw new Error('scene_recall_snapshot_source_set_mismatch')
      const sourceSnapshotHash = sceneRecallSourceSnapshotSetHash(corpus)
      const scope: SceneRecallScope = { storyId: fence.storyId, projectId: fence.projectId, branchId: fence.branchId, branchLineage: lineage, validityEpoch: fence.validityEpoch, storyRevision: fence.storyRevision, sceneId: input.sceneId, headRevision: fence.headRevision, headHash: fence.headHash, expectedSourceCardSetHash: sourceCardSetHash }
      let currentSceneTail: SceneRecallCurrentSceneTail | undefined
      if (input.currentSceneTail) {
        const tailInput = input.currentSceneTail
        if (typeof tailInput.contractHash !== 'string' || !SCENE_MEMORY_HASH.test(tailInput.contractHash) || !Number.isFinite(tailInput.recentChars) || tailInput.recentChars < 1) throw new Error('scene_recall_snapshot_current_tail_input_invalid')
        const state = d.prepare('SELECT contract_hash, lifecycle, scene_order FROM scene_states WHERE run_id=? AND scene_id=?').get(input.runId, input.sceneId) as { contract_hash?: unknown; lifecycle?: unknown; scene_order?: unknown } | undefined
        if (!state || state.contract_hash !== tailInput.contractHash) throw new Error('scene_recall_snapshot_current_tail_contract_mismatch')
        const closing = state.lifecycle === 'committed' && !d.prepare("SELECT 1 FROM scene_states WHERE run_id=? AND (lifecycle<>'committed' OR scene_order>?) LIMIT 1").get(input.runId, state.scene_order as number)
        const lastSceneChunk = closing ? (d.prepare("SELECT MAX(chunk_index) AS last FROM manuscript_segments WHERE run_id=? AND scene_id=? AND status='accepted' AND kind='prose'").get(input.runId, input.sceneId) as { last: number | null }).last : null
        if (closing && (!Number.isSafeInteger(lastSceneChunk) || Number(lastSceneChunk) < 0)) throw new Error('scene_recall_snapshot_closing_source_missing')
        // Preserve actual source scopes. Old unscoped retries are not a
        // closing tail: only chunks after the committed last-scene boundary
        // may join that scene's accepted ending, inside this same snapshot.
        const tailScope = closing ? '(scene_id=? OR (scene_id IS NULL AND chunk_index>?))' : 'scene_id=?'
        const tailArgs: Array<string | number> = [input.runId, input.sceneId, ...(closing ? [lastSceneChunk as number] : [])]
        const prefixCache = readAcceptedPrefixCache(d, input.runId) ?? rebuildAcceptedPrefixCache(d, input.runId, null).cache
        if (prefixCache.schema_version !== ACCEPTED_PREFIX_CACHE_SCHEMA_VERSION || prefixCache.state !== 'valid' || !SCENE_MEMORY_HASH.test(prefixCache.prefix_hash)) throw new Error('scene_recall_snapshot_current_tail_prefix_invalid')
        // Accepted-prefix rebuilds verify every body and ordering identity;
        // SQLite triggers invalidate that authority on ANY accepted-row change.
        // Keep the full-scene metadata check even for older schema-1 caches,
        // but let SQLite find invalid rows instead of copying the entire long
        // scene into JS twice per request just to select a bounded tail.
        const invalidMetadata = d.prepare(`SELECT 1 AS invalid FROM manuscript_segments
          WHERE run_id=? AND ${tailScope} AND kind='prose' AND status IN ('accepted','partial') AND (
            typeof(segment_id)<>'text' OR length(segment_id)=0 OR
            typeof(content_hash)<>'text' OR length(content_hash)<>64 OR content_hash GLOB '*[^0-9a-f]*' OR
            typeof(char_count)<>'integer' OR char_count<0 OR char_count>9007199254740991 OR
            typeof(chunk_index)<>'integer' OR chunk_index<0 OR chunk_index>9007199254740991 OR
            typeof(revision)<>'integer' OR revision<1 OR revision>9007199254740991 OR
            typeof(created_at) NOT IN ('integer','real') OR abs(created_at)>1.7976931348623157e308 OR
            (typeof(created_at)='integer' AND abs(created_at)>9007199254740991)
          ) LIMIT 1`).get(...tailArgs)
        if (invalidMetadata) throw new Error('scene_recall_snapshot_current_tail_segment_invalid')
        type TailRow = { segment_id?: unknown; run_id?: unknown; scene_id?: unknown; status?: unknown; content_hash?: unknown; char_count?: unknown; chunk_index?: unknown; revision?: unknown; created_at?: unknown }
        const identityFromRow = (row: TailRow) => {
          if (typeof row.segment_id !== 'string' || !row.segment_id || row.run_id !== input.runId || !(row.scene_id === input.sceneId || closing && row.scene_id === null && Number(row.chunk_index) > Number(lastSceneChunk)) || !['accepted', 'partial'].includes(String(row.status)) || typeof row.content_hash !== 'string' || !SCENE_MEMORY_HASH.test(row.content_hash) || !Number.isSafeInteger(row.char_count) || (row.char_count as number) < 0 || !Number.isSafeInteger(row.chunk_index) || (row.chunk_index as number) < 0 || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1 || !Number.isFinite(row.created_at)) throw new Error('scene_recall_snapshot_current_tail_segment_invalid')
          return { segmentId: row.segment_id, runId: input.runId, sceneId: row.scene_id as string | null, contractHash: tailInput.contractHash, status: row.status as 'accepted' | 'partial', contentHash: row.content_hash, fullContentHash: row.content_hash, sourceStartCp: 0, sourceEndCp: row.char_count as number, charCount: row.char_count as number, chunkIndex: row.chunk_index as number, revision: row.revision as number }
        }
        const tailRows = d.prepare(`SELECT segment_id, run_id, scene_id, status, content_hash, char_count, chunk_index, revision, created_at
          FROM manuscript_segments WHERE run_id=? AND ${tailScope} AND kind='prose' AND status IN ('accepted','partial')
          ORDER BY chunk_index DESC, revision DESC, created_at DESC, segment_id DESC`).iterate(...tailArgs) as Iterable<TailRow>
        const bodyStatement = d.prepare('SELECT content FROM manuscript_segments WHERE run_id=? AND segment_id=?')
        const readBody = (identity: ReturnType<typeof identityFromRow>): string => {
          const row = bodyStatement.get(input.runId, identity.segmentId) as { content?: unknown } | undefined
          if (typeof row?.content !== 'string' || manuscriptSegmentHash(row.content) !== identity.contentHash || codePointLength(row.content) !== identity.charCount) throw new Error('scene_recall_snapshot_current_tail_segment_invalid')
          return row.content
        }
        // Partial bodies have no accepted-prefix authority. Continue validating
        // all of them, including ones outside the selected continuation tail.
        const partialRows = d.prepare(`SELECT segment_id, run_id, scene_id, status, content_hash, char_count, chunk_index, revision, created_at
          FROM manuscript_segments WHERE run_id=? AND ${tailScope} AND kind='prose' AND status='partial'`).all(...tailArgs) as TailRow[]
        const partialBodies = new Map(partialRows.map((row) => {
          const identity = identityFromRow(row)
          return [identity.segmentId, readBody(identity)] as const
        }))
        const selected: Array<SceneRecallCurrentSceneTail['segments'][number]> = []
        let selectedChars = 0
        const safeChars = Math.max(1, Math.floor(tailInput.recentChars))
        for (const row of tailRows) {
          const identity = identityFromRow(row)
          if (selected.length > 0 && selectedChars + identity.charCount > safeChars) break
          const candidate = { ...identity, content: partialBodies.get(identity.segmentId) ?? readBody(identity) }
          if (selected.length === 0 && candidate.charCount > safeChars) {
            const points = Array.from(candidate.content)
            const sourceStartCp = points.length - safeChars
            const content = points.slice(sourceStartCp).join('')
            selected.unshift({ ...candidate, content, contentHash: manuscriptSegmentHash(content), fullContentHash: candidate.contentHash, sourceStartCp, sourceEndCp: points.length })
            selectedChars = safeChars
            break
          }
          selected.unshift({ ...candidate, fullContentHash: candidate.contentHash, sourceStartCp: 0, sourceEndCp: candidate.charCount })
          selectedChars += candidate.charCount
        }
        currentSceneTail = {
          schemaVersion: 1,
          sceneId: input.sceneId,
          contractHash: tailInput.contractHash,
          ...(closing ? { closing: true as const } : {}),
          acceptedPrefixHash: prefixCache.prefix_hash,
          tailHash: sceneMemoryStableHash({ schemaVersion: 1, sceneId: input.sceneId, contractHash: tailInput.contractHash, ...(closing ? { closing: true } : {}), acceptedPrefixHash: prefixCache.prefix_hash, segments: selected }),
          segments: selected
        }
        if (tailInput.expectedTailHash !== undefined && tailInput.expectedTailHash !== currentSceneTail.tailHash) throw new Error('scene_recall_snapshot_current_tail_hash_mismatch')
      }
      snapshot = { schemaVersion: 1, runId: input.runId, sceneId: input.sceneId, scope, sourceSnapshotHash, sourceCardSetHash, corpus, ...(currentSceneTail ? { currentSceneTail } : {}) }
    })
    if (!snapshot) throw new Error('scene_recall_snapshot_missing')
    return snapshot
  }

  const allowedSceneTransition = (from: SceneLifecycle, to: SceneLifecycle): boolean =>
    (from === 'planned' && to === 'writing') ||
    (from === 'writing' && (to === 'writing' || to === 'candidate')) ||
    (from === 'candidate' && (to === 'candidate' || to === 'writing' || to === 'accepted')) ||
    (from === 'accepted' && (to === 'accepted' || to === 'writing')) ||
    (from === 'committed' && to === 'committed')

  return {
    open() {
      if (!db) db = openDb(dbPath)
    },
    close() {
      if (db) {
        closeDb(db)
        db = null
      }
    },
    tx(fn, mode = 'deferred') {
      const d = requireDb()
      if (transactionDepth > 0) {
        transactionDepth += 1
        try {
          fn()
        } finally {
          transactionDepth -= 1
        }
        return
      }
      // R4.2 A1：BEGIN IMMEDIATE 先取写锁——同 session 并发启动在事务入口串行化，
      // 后到者在锁内读到先到者已提交的 run，走 busy/duplicate 分支（并发单胜，无孤儿）
      d.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN')
      transactionDepth = 1
      try {
        fn()
        d.exec('COMMIT')
      } catch (e) {
        try {
          d.exec('ROLLBACK')
        } catch {
          /* ignore */
        }
        throw e
      } finally {
        transactionDepth = 0
      }
    },
    createRun(r) {
      // R4-4：纯 INSERT（不再 OR REPLACE）——同 run_id 或同 (session, client_request_id) 重复必须报错，
      // 禁止模糊覆盖（A-05 原则）；幂等由 findRunByClientRequestId 先行判断
      const d = requireDb()
      this.tx(() => {
        d
          .prepare('INSERT INTO runs (run_id, session_id, status, phase, started_at, updated_at, config_json, parent_run_id, error_code, error_message, client_request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(r.run_id, r.session_id, r.status, r.phase, r.started_at, r.updated_at, r.config_json, r.parent_run_id, r.error_code, r.error_message, r.client_request_id ?? null)
        ensureStoryRunScope(d, r.run_id, r.session_id, r.config_json, r.started_at)
      }, 'immediate')
    },
    getRun(runId) {
      return (requireDb().prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as RunRow | undefined) ?? null
    },
    findRunByClientRequestId(sessionId, clientRequestId) {
      return (
        (requireDb()
          .prepare('SELECT * FROM runs WHERE session_id = ? AND client_request_id = ? ORDER BY started_at DESC LIMIT 1')
          .get(sessionId, clientRequestId) as RunRow | undefined) ?? null
      )
    },
    updateRun(runId, patch) {
      const d = requireDb()
      const cols = Object.keys(patch)
      if (cols.length === 0) return
      const set = cols.map((c) => `${c} = ?`).join(', ')
      // Preserve SQL NULL for explicit error clearing.  Coercing null to an
      // empty string makes a successful semantic-review decision look as if
      // the run still carries an error and breaks restart/audit consumers.
      const vals = cols.map((c) => {
        const value = (patch as Record<string, unknown>)[c]
        return value === null ? null : String(value ?? '')
      })
      d.prepare(`UPDATE runs SET ${set}, updated_at = ? WHERE run_id = ?`).run(...vals, Date.now(), runId)
    },
    listActiveRuns() {
      // R4.1 S-04：cancelling/cancel_requested/recovery_required 也属可恢复运行
      return requireDb()
        .prepare("SELECT * FROM runs WHERE status IN ('queued','running','recoverable','cancelling','cancel_requested','recovery_required','waiting_user') ORDER BY updated_at DESC")
        .all() as unknown as RunRow[]
    },
    listRunsBySession(sessionId) {
      return requireDb().prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC').all(sessionId) as unknown as RunRow[]
    },
    listRecentRuns(limit) {
      const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
      return requireDb().prepare('SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?').all(safeLimit) as unknown as RunRow[]
    },
    deleteRun(runId, storyAction = 'preserve') {
      const d = requireDb()
      let retraction: StoryLedgerRetractionResult = { action: storyAction, retractedRevisions: 0, headRevision: null }
      this.tx(() => {
        if (storyAction === 'retract') retraction = appendStoryRetractions(d, runId, 'workflow_deleted_and_story_retracted', Date.now())
        // SceneMemoryCard and every derived projection are rebuildable, not
        // surviving sources.  Hide/invalidate them before source rows vanish.
        invalidateSceneMemoryProjectionsForRun(d, runId, storyAction)
        d.prepare('DELETE FROM turns WHERE run_id = ?').run(runId)
        d.prepare('DELETE FROM manuscript_segments WHERE run_id = ?').run(runId)
        d.prepare('DELETE FROM manuscript_backfills WHERE run_id = ?').run(runId)
        d.prepare('DELETE FROM scene_states WHERE run_id = ?').run(runId)
        d.prepare('DELETE FROM toolcalls WHERE run_id = ?').run(runId)
        d.prepare('DELETE FROM artifacts WHERE run_id = ?').run(runId)
        d.prepare('DELETE FROM usage_log WHERE run_id = ?').run(runId)
        d.prepare('DELETE FROM runs WHERE run_id = ?').run(runId)
      }, 'immediate')
      return retraction
    },
    appendTurn(t) {
      // R4.1 S-03：同 run 内 turn 更新（引擎 checkpoint 语义），跨 run 绝不覆盖；
      // 用 ON CONFLICT(run_id, turn_seq) 限定作用域，禁止 INSERT OR REPLACE（删除再插可级联删 tool/artifact）
      requireDb()
        .prepare(
          `INSERT INTO turns (turn_id, run_id, turn_seq, role, content, reasoning_content, tool_calls_json, tool_result_json, plan_state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(run_id, turn_seq) DO UPDATE SET content=excluded.content, reasoning_content=excluded.reasoning_content, tool_calls_json=excluded.tool_calls_json, tool_result_json=excluded.tool_result_json, plan_state=excluded.plan_state`
        )
        .run(t.turn_id, t.run_id, t.turn_seq, t.role, t.content, t.reasoning_content, t.tool_calls_json, t.tool_result_json, t.plan_state, t.created_at)
    },
    getTurnsByRun(runId) {
      return requireDb().prepare('SELECT * FROM turns WHERE run_id = ? ORDER BY turn_seq ASC').all(runId) as unknown as TurnRow[]
    },
    getRunTurnPreviews(runId) {
      // Text substr stops at NUL in SQLite. A bounded byte prefix preserves it;
      // 800 UTF-8 bytes include the first 200 UTF-16 units even if decoding the
      // suffix ends in an incomplete character. Keep the original JS slice.
      const rows = requireDb().prepare('SELECT role,substr(CAST(content AS BLOB),1,800) AS content FROM turns WHERE run_id = ? ORDER BY turn_seq ASC').all(runId) as Array<{ role: TurnRow['role']; content: Uint8Array | null }>
      // SQLite returns NULL for a zero-byte BLOB substring. The source
      // content is NOT NULL: this is an empty turn.
      return rows.map(row => ({ role: row.role, content: row.content === null ? '' : Buffer.from(row.content).toString('utf8').slice(0, 200) }))
    },
    deleteTurnsByRun(runId) {
      requireDb().prepare('DELETE FROM turns WHERE run_id = ?').run(runId)
    },
    saveManuscriptSegment(segment) {
      this.tx(() => {
        const d = requireDb()
        const prefixCacheBefore = segment.status === 'accepted' ? readAcceptedPrefixCache(d, segment.run_id) : null
        if (segment.content_hash !== manuscriptSegmentHash(segment.content) || segment.char_count !== codePointLength(segment.content)) {
          throw new Error('manuscript_segment_integrity_mismatch')
        }
        if (segment.status === 'accepted' && (segment.kind !== 'prose' || !hasNaturalProseEnding(segment.content))) {
          throw new Error('manuscript_segment_not_complete')
        }
        if (segment.status === 'accepted') {
          const conflict = acceptedScopeConflict(d, segment)
          if (conflict) throw new Error('manuscript_scope_accepted_conflict')
        }
        const existing = d.prepare('SELECT * FROM manuscript_segments WHERE segment_id = ?').get(segment.segment_id) as ManuscriptSegmentRow | undefined
        if (existing) {
          if (existing.run_id !== segment.run_id || existing.session_id !== segment.session_id) throw new Error('manuscript_segment_identity_mismatch')
          if (existing.status === 'accepted' || existing.status === 'rejected' || existing.status === 'superseded') {
            const same = existing.status === segment.status && existing.kind === segment.kind && existing.content === segment.content &&
              existing.content_hash === segment.content_hash && existing.char_count === segment.char_count && existing.revision === segment.revision
            if (!same) throw new Error('manuscript_segment_immutable')
            // An idempotent replay must still fail closed if an earlier crash
            // left an active ancestor attached to an accepted row.
            if (existing.supersedes_segment_id) {
              const chain = loadSupersedesChain(d, existing)
              if (existing.status === 'accepted') assertNoActivePartialAncestor(d, chain)
            }
            validatePartialGraphForRun(d, segment.run_id)
            return
          }
        }
        const chain = segment.supersedes_segment_id
          ? loadSupersedesChain(d, segment)
          : []
        if ((segment.status === 'partial' || segment.status === 'accepted') && chain.some((parent) => parent.status === 'candidate')) {
          throw new Error('manuscript_partial_candidate_ancestor')
        }
        // Persisting a partial replaces its active partial ancestors in the
        // same transaction.  A candidate intentionally leaves the chain
        // untouched until the evidence-bound acceptance operation below.
        if (segment.status === 'partial' || segment.status === 'accepted') supersedePartialAncestors(d, chain, segment.updated_at)
        if (existing) {
          d.prepare(
            `UPDATE manuscript_segments SET
              source_turn_id=?, section_id=?, scene_id=?, chunk_index=?, revision=?, status=?, kind=?, content=?,
              content_hash=?, char_count=?, supersedes_segment_id=?, updated_at=?, accepted_at=?
             WHERE segment_id=?`
          ).run(
            segment.source_turn_id,
            segment.section_id,
            segment.scene_id,
            segment.chunk_index,
            segment.revision,
            segment.status,
            segment.kind,
            segment.content,
            segment.content_hash,
            segment.char_count,
            segment.supersedes_segment_id,
            segment.updated_at,
            segment.accepted_at,
            segment.segment_id
          )
        } else {
          d.prepare(
            `INSERT INTO manuscript_segments (
              segment_id, run_id, session_id, source_turn_id, section_id, scene_id, chunk_index, revision,
              status, kind, content, content_hash, char_count, supersedes_segment_id, created_at, updated_at, accepted_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
            segment.segment_id,
            segment.run_id,
            segment.session_id,
            segment.source_turn_id,
            segment.section_id,
            segment.scene_id,
            segment.chunk_index,
            segment.revision,
            segment.status,
            segment.kind,
            segment.content,
            segment.content_hash,
            segment.char_count,
            segment.supersedes_segment_id,
            segment.created_at,
            segment.updated_at,
            segment.accepted_at
          )
        }
        validatePartialGraphForRun(d, segment.run_id)
        if (segment.status === 'accepted') assertNoActivePartialAncestor(d, chain)
        if (segment.status === 'accepted') refreshAcceptedPrefixCache(d, segment.run_id, prefixCacheBefore, segment.segment_id)
      }, 'immediate')
    },
    getManuscriptSegmentsByRun(runId) {
      const d = requireDb()
      validatePartialGraphForRun(d, runId)
      return d.prepare('SELECT * FROM manuscript_segments WHERE run_id = ? ORDER BY chunk_index ASC, revision ASC, created_at ASC').all(runId) as unknown as ManuscriptSegmentRow[]
    },
    getManuscriptReaderSegments(runId) {
      return requireDb().prepare(`SELECT segment_id, section_id, scene_id, status, char_count FROM manuscript_segments
        WHERE run_id = ? AND kind = 'prose' AND status IN ('accepted', 'partial', 'candidate')
        ORDER BY chunk_index ASC, revision ASC, created_at ASC, segment_id ASC`).all(runId) as unknown as ManuscriptReaderSegment[]
    },
    getManuscriptReaderSlices(runId, slices) {
      if (slices.length === 0) return []
      return requireDb().prepare(`SELECT substr(segment.content, json_extract(slice.value, '$.start') + 1,
          json_extract(slice.value, '$.length')) AS content
        FROM json_each(?) AS slice JOIN manuscript_segments AS segment
          ON segment.segment_id = json_extract(slice.value, '$.segmentId')
        WHERE segment.run_id = ? AND segment.kind = 'prose' AND segment.status = 'accepted'
        ORDER BY CAST(slice.key AS INTEGER)`).all(JSON.stringify(slices), runId) as Array<{ content: string }>
    },
    getAcceptedNarrativePrefixSnapshot(input) {
      if (!input || !input.runId || !Number.isFinite(input.recentChars) || input.recentChars < 1 || !input.currentSceneId || !/^[0-9a-f]{64}$/u.test(input.currentContractHash) || !Array.isArray(input.ledger)) {
        throw new Error('narrative_prefix_snapshot_input_invalid')
      }
      return getAcceptedNarrativePrefixSnapshot(input)
    },
    ensureSceneStates(runId, plan, at) {
      if (!plan || plan.contracts.length === 0 || !Number.isFinite(at)) throw new Error('scene_state_plan_invalid')
      this.tx(() => {
        const d = requireDb()
        for (const contract of plan.contracts) {
          const existing = d.prepare('SELECT * FROM scene_states WHERE run_id = ? AND scene_id = ?').get(runId, contract.sceneId) as SceneStateRow | undefined
          if (existing) {
            if (existing.contract_id !== contract.contractId || existing.contract_hash !== contract.frozenHash || existing.section_id !== contract.sectionId || existing.scene_order !== contract.order) {
              throw new Error('scene_state_contract_mismatch')
            }
            continue
          }
          d.prepare(`INSERT INTO scene_states (
            run_id, scene_id, section_id, contract_id, contract_hash, scene_order, lifecycle, revision,
            candidate_segment_id, candidate_hash, accepted_segment_id, accepted_hash,
            completion_decision_json, completion_evidence_hash, created_at, updated_at, completed_at, committed_at
          ) VALUES (?,?,?,?,?,?, 'planned', 1, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`).run(
            runId, contract.sceneId, contract.sectionId, contract.contractId, contract.frozenHash, contract.order, at, at
          )
        }
      }, 'immediate')
    },
    getSceneStates(runId) {
      return (requireDb().prepare('SELECT * FROM scene_states WHERE run_id = ? ORDER BY scene_order ASC').all(runId) as unknown as SceneStateRow[]).map(sceneStateFromRow)
    },
    transitionSceneState(input) {
      if (!input.runId || !input.sceneId || !input.contractId || !input.contractHash || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1 || !Number.isFinite(input.at)) {
        throw new Error('scene_state_transition_invalid')
      }
      let result: SceneStateRecord | null = null
      this.tx(() => {
        const d = requireDb()
        const row = d.prepare('SELECT * FROM scene_states WHERE run_id = ? AND scene_id = ?').get(input.runId, input.sceneId) as SceneStateRow | undefined
        if (!row) throw new Error('scene_state_missing')
        if (row.contract_id !== input.contractId || row.contract_hash !== input.contractHash) throw new Error('scene_state_contract_mismatch')
        if (row.revision !== input.expectedRevision) throw new Error('scene_state_revision_mismatch')
        const expectedFrom = Array.isArray(input.from) ? input.from : [input.from]
        if (!expectedFrom.includes(row.lifecycle)) throw new Error('scene_state_lifecycle_mismatch')
        if (!allowedSceneTransition(row.lifecycle, input.to)) throw new Error('scene_state_transition_invalid')
        if (input.completionDecision) {
          const decision = input.completionDecision
          if (decision.schemaVersion !== 1 || decision.sceneId !== input.sceneId || decision.contractId !== input.contractId || decision.contractHash !== input.contractHash) throw new Error('scene_state_completion_identity_mismatch')
        }
        const sameLifecycle = row.lifecycle === input.to
        const nextRevision = sameLifecycle ? row.revision : row.revision + 1
        const candidateSegmentId = input.candidateSegmentId !== undefined ? input.candidateSegmentId : row.candidate_segment_id
        const candidateHash = input.candidateHash !== undefined ? input.candidateHash : row.candidate_hash
        if (input.candidateSegmentId !== undefined || input.candidateHash !== undefined) {
          if (!candidateSegmentId || !candidateHash) throw new Error('scene_state_candidate_identity_mismatch')
          const candidate = d.prepare('SELECT status, kind, scene_id, content_hash FROM manuscript_segments WHERE run_id = ? AND segment_id = ?').get(input.runId, candidateSegmentId) as { status?: string; kind?: string; scene_id?: string | null; content_hash?: string } | undefined
          if (!candidate || candidate.scene_id !== input.sceneId || candidate.content_hash !== candidateHash || candidate.kind !== 'prose' || (input.to === 'candidate' && candidate.status !== 'candidate') || (input.to === 'accepted' && candidate.status !== 'accepted')) throw new Error('scene_state_candidate_identity_mismatch')
        }
        const acceptedSegmentId = input.acceptedSegmentId !== undefined
          ? input.acceptedSegmentId
          : input.to === 'accepted' || input.to === 'committed' ? candidateSegmentId : row.accepted_segment_id
        const acceptedHash = input.acceptedHash !== undefined
          ? input.acceptedHash
          : input.to === 'accepted' || input.to === 'committed' ? candidateHash : row.accepted_hash
        if (input.acceptedSegmentId !== undefined || input.acceptedHash !== undefined) {
          if (!acceptedSegmentId || !acceptedHash) throw new Error('scene_state_accepted_identity_mismatch')
          const accepted = d.prepare("SELECT status, kind, scene_id, content_hash FROM manuscript_segments WHERE run_id = ? AND segment_id = ?").get(input.runId, acceptedSegmentId) as { status?: string; kind?: string; scene_id?: string | null; content_hash?: string } | undefined
          if (!accepted || accepted.status !== 'accepted' || accepted.kind !== 'prose' || accepted.scene_id !== input.sceneId || accepted.content_hash !== acceptedHash) throw new Error('scene_state_accepted_identity_mismatch')
        }
        const decisionJson = input.completionDecision !== undefined ? (input.completionDecision ? JSON.stringify(input.completionDecision) : null) : row.completion_decision_json
        const evidenceHash = input.completionEvidenceHash !== undefined ? input.completionEvidenceHash : row.completion_evidence_hash
        const completedAt = input.to === 'committed' ? (row.completed_at ?? input.at) : row.completed_at
        const committedAt = input.to === 'committed' ? (row.committed_at ?? input.at) : row.committed_at
        d.prepare(`UPDATE scene_states SET lifecycle=?, revision=?, candidate_segment_id=?, candidate_hash=?, accepted_segment_id=?, accepted_hash=?, completion_decision_json=?, completion_evidence_hash=?, updated_at=?, completed_at=?, committed_at=? WHERE run_id=? AND scene_id=? AND revision=?`).run(
          input.to, nextRevision, candidateSegmentId, candidateHash, acceptedSegmentId, acceptedHash, decisionJson, evidenceHash, input.at, completedAt, committedAt, input.runId, input.sceneId, row.revision
        )
        const updated = d.prepare('SELECT * FROM scene_states WHERE run_id = ? AND scene_id = ?').get(input.runId, input.sceneId) as SceneStateRow | undefined
        if (!updated) throw new Error('scene_state_missing')
        result = sceneStateFromRow(updated)
      }, 'immediate')
      if (!result) throw new Error('scene_state_missing')
      return result
    },
    commitScene(input) {
      if (!input.contractId || !input.contractHash || !input.decision || input.decision.status !== 'complete' || input.decision.contractId !== input.contractId || input.decision.contractHash !== input.contractHash || typeof input.acceptance.sceneId !== 'string' || input.decision.sceneId !== input.acceptance.sceneId || input.completionEvidenceHash !== input.decision.evidenceHash || !Number.isInteger(input.expectedSceneRevision) || input.expectedSceneRevision < 1 || !Number.isFinite(input.committedAt)) {
        throw new Error('scene_commit_input_invalid')
      }
      const sceneId = input.acceptance.sceneId as string
      if (input.decision.scenePrefixHash !== undefined && (typeof input.decision.scenePrefixHash !== 'string' || !SCENE_COMMIT_HASH.test(input.decision.scenePrefixHash))) {
        throw new Error('scene_commit_manifest_binding_mismatch')
      }
      const suppliedManifest = input.manifest ? parseSceneCommitManifest(input.manifest) : null
      if (suppliedManifest && (suppliedManifest.runId !== input.acceptance.runId || suppliedManifest.sceneId !== input.acceptance.sceneId ||
        suppliedManifest.contractId !== input.contractId || suppliedManifest.contractHash !== input.contractHash || suppliedManifest.stateDeltaHash !== input.stateDelta.deltaHash ||
        suppliedManifest.completionDecisionHash !== manuscriptSegmentHash(stableNarrativeJson(input.decision)))) {
        throw new Error('scene_commit_manifest_binding_mismatch')
      }
      if (input.expectedLedgerFence && (!Number.isInteger(input.expectedLedgerFence.expectedRevision) || input.expectedLedgerFence.expectedRevision < 0 ||
        !Number.isInteger(input.expectedLedgerFence.expectedEpoch) || input.expectedLedgerFence.expectedEpoch < 1 ||
        !Number.isInteger(input.expectedLedgerFence.expectedHeadRevision) || input.expectedLedgerFence.expectedHeadRevision < 0 ||
        (input.expectedLedgerFence.expectedHeadHash !== null && (typeof input.expectedLedgerFence.expectedHeadHash !== 'string' || !SCENE_COMMIT_HASH.test(input.expectedLedgerFence.expectedHeadHash))))) {
        throw new Error('scene_commit_input_invalid')
      }
      let stateDelta: NarrativeStateDelta
      try {
        stateDelta = normalizeNarrativeStateDelta(input.stateDelta)
      } catch {
        throw new Error('scene_commit_state_delta_invalid')
      }
      if (stateDelta.runId !== input.acceptance.runId || stateDelta.sceneId !== input.acceptance.sceneId || stateDelta.acceptedSegmentId !== input.acceptance.segmentId || stateDelta.acceptedContentHash !== input.decision.candidateHash || stateDelta.contractHash !== input.contractHash || input.acceptance.expectedContentHash !== stateDelta.acceptedContentHash || input.acceptance.expectedCharCount !== input.decision.candidateCharCount) {
        throw new Error('scene_commit_state_delta_binding_mismatch')
      }
      this.tx(() => {
        const d = requireDb()
        const row = d.prepare('SELECT * FROM scene_states WHERE run_id = ? AND scene_id = ?').get(input.acceptance.runId, input.acceptance.sceneId) as SceneStateRow | undefined
        if (!row) throw new Error('scene_state_missing')
        if (row.contract_id !== input.contractId || row.contract_hash !== input.contractHash) throw new Error('scene_state_contract_mismatch')
        // Read and validate the story head before accepting any manuscript or
        // narrative rows. A provider response created in an old epoch must
        // fail closed even if its scene evidence is otherwise valid.
        const storyRunMeta = d.prepare('SELECT session_id, config_json, status, error_code FROM runs WHERE run_id=?').get(input.acceptance.runId) as { session_id?: string; config_json?: string; status?: string; error_code?: string | null } | undefined
        const storyRun = ensureStoryRunScope(d, input.acceptance.runId, String(storyRunMeta?.session_id ?? input.acceptance.runId), storyRunMeta?.config_json ?? '{}', input.committedAt)
        const storyHead = d.prepare('SELECT * FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(storyRun.story_id, storyRun.project_id, storyRun.branch_id) as StoryLedgerHeadRow | undefined
        if (!storyHead) throw new Error('story_ledger_scope_missing')
        if (storyHead.hash_schema_version !== 2) throw new Error('story_ledger_legacy_hash_schema')
        const freshness = readStoryLedgerFreshness(d, input.acceptance.runId)
        if (!freshness || !freshness.epochValid || storyRunMeta?.error_code === 'story_ledger_epoch_invalidated') throw new Error('story_ledger_epoch_invalidated')
        if (!freshness.headMatchesCursor) throw new Error('story_ledger_concurrent_head_conflict')
        if (input.expectedLedgerFence && row.lifecycle !== 'committed') {
          assertStoryLedgerFreshness(d, {
            runId: input.acceptance.runId,
            expectedRevision: input.expectedLedgerFence.expectedRevision,
            expectedEpoch: input.expectedLedgerFence.expectedEpoch,
            expectedHeadRevision: input.expectedLedgerFence.expectedHeadRevision,
            expectedHeadHash: input.expectedLedgerFence.expectedHeadHash
          })
        }
        if (input.projection) {
          const card = input.projection.card
          // The canonical commit path owns only source-bound canonical card
          // bytes.  Partial/provider drafts and ready embeddings belong to
          // later explicit workflows and must never enter this transaction.
          if (card.status !== 'canonical') throw new Error('scene_card_status_invalid')
          if (card.embedding.status !== 'unavailable' || card.embedding.version !== null || card.embedding.modelId !== null || card.embedding.dimensions !== null || card.embedding.vectorHash !== null) throw new Error('scene_card_embedding_unavailable_required')
          if (card.runId !== input.acceptance.runId || card.sceneId !== sceneId || card.contractId !== input.contractId || card.contractHash !== input.contractHash) throw new Error('scene_card_contract_mismatch')
          if (card.validityEpoch !== storyHead.validity_epoch) throw new Error('scene_card_epoch_mismatch')
          if (row.lifecycle !== 'committed' && card.storyRevision !== storyHead.high_watermark + 1) throw new Error('story_ledger_concurrent_head_conflict')
          if (input.projection.context.expectedValidityEpoch !== card.validityEpoch || input.projection.context.expectedStoryRevision !== card.storyRevision || input.projection.context.expectedContract.contractId !== card.contractId || input.projection.context.expectedContract.contractHash !== card.contractHash) throw new Error('scene_card_source_changed')
        }
        // Once a run has a fact registry, every knowledge edge must resolve to
        // the exact immutable fact version it describes.  Empty/pre-registry
        // historical fixtures remain readable, but a new factRef is always
        // checked even when the registry is otherwise empty.
        const runMeta = d.prepare('SELECT session_id FROM runs WHERE run_id = ?').get(input.acceptance.runId) as { session_id?: string } | undefined
        const factCount = runMeta?.session_id
          ? Number((d.prepare("SELECT COUNT(*) AS count FROM narrative_facts WHERE session_id = ? AND status IN ('active','pending_review')").get(runMeta.session_id) as { count?: number } | undefined)?.count ?? 0)
          : 0
        for (const change of stateDelta.changes) {
          if (change.kind !== 'knowledge') continue
          const factRow = runMeta?.session_id
            ? d.prepare('SELECT * FROM narrative_facts WHERE fact_id = ? AND session_id = ? ORDER BY version DESC LIMIT 1').get(change.factId, runMeta.session_id) as NarrativeFactRow | undefined
            : undefined
          if (!factRow) {
            if (factCount > 0 || change.factRef) throw new Error('narrative_knowledge_fact_missing')
            continue
          }
          const fact = narrativeFactFromRow(factRow)
          if (fact.status !== 'active' || !change.factRef || !factReferenceMatches(fact, change.factRef)) throw new Error('narrative_knowledge_fact_reference_mismatch')
        }
        if (row.lifecycle === 'committed') {
          const existingCommit = d.prepare('SELECT * FROM narrative_commits WHERE run_id = ? AND scene_id = ?').get(input.acceptance.runId, input.acceptance.sceneId) as NarrativeCommitRow | undefined
          if (!existingCommit) throw new Error('narrative_commit_missing')
          const stored = narrativeCommitFromRow(existingCommit)
          const storedDecision = sceneDecisionFromJson(row.completion_decision_json)
          // A committed scene is immutable evidence, not merely an
          // idempotent marker.  Rebuild the manifest from the rows currently
          // accepted for this scene and compare every bound field.  This
          // catches a tampered/de-synchronised manifest even when the caller
          // does not supply a retry manifest.
          if (!storedDecision) throw new Error('scene_commit_manifest_binding_mismatch')
          const storedManifestRow = d.prepare('SELECT manifest_json, manifest_hash FROM scene_commit_manifests WHERE run_id = ? AND scene_id = ?').get(input.acceptance.runId, input.acceptance.sceneId) as { manifest_json?: string; manifest_hash?: string } | undefined
          let storedManifest: SceneCommitManifest
          try {
            storedManifest = storedManifestRow?.manifest_json
              ? parseSceneCommitManifest(JSON.parse(storedManifestRow.manifest_json))
              : buildSceneCommitManifest({
                  runId: input.acceptance.runId,
                  sceneId,
                  contractId: row.contract_id,
                  contractHash: row.contract_hash,
                  acceptedSegments: readAcceptedSceneRows(d, input.acceptance.runId, sceneId),
                  decision: storedDecision,
                  stateDeltaHash: stored.deltaHash
                })
          } catch {
            throw new Error('scene_commit_manifest_corrupt')
          }
          if (storedManifestRow && (!storedManifestRow.manifest_hash || sceneCommitManifestHash(storedManifest) !== storedManifestRow.manifest_hash)) throw new Error('scene_commit_manifest_binding_mismatch')
          const canonicalStoredManifest = buildSceneCommitManifest({
            runId: input.acceptance.runId,
            sceneId,
            contractId: row.contract_id,
            contractHash: row.contract_hash,
            acceptedSegments: readAcceptedSceneRows(d, input.acceptance.runId, sceneId),
            decision: storedDecision,
            stateDeltaHash: stored.deltaHash
          })
          if (!sameSceneCommitManifest(storedManifest, canonicalStoredManifest) ||
            storedManifest.runId !== stored.runId || storedManifest.sceneId !== stored.sceneId ||
            storedManifest.contractId !== row.contract_id || storedManifest.contractHash !== row.contract_hash ||
            storedManifest.completionDecisionHash !== manuscriptSegmentHash(stableNarrativeJson(storedDecision)) ||
            storedManifest.stateDeltaHash !== stored.deltaHash) {
            throw new Error('scene_commit_manifest_binding_mismatch')
          }
          if (!storedManifestRow) {
            d.prepare(`INSERT INTO scene_commit_manifests (run_id,scene_id,revision,manifest_json,manifest_hash,created_at) VALUES (?,?,?,?,?,?)`).run(
              storedManifest.runId, storedManifest.sceneId, existingCommit.revision, stableNarrativeJson(storedManifest), sceneCommitManifestHash(storedManifest), stored.committedAt
            )
          }
          if (suppliedManifest && !sameSceneCommitManifest(suppliedManifest, storedManifest)) throw new Error('scene_commit_manifest_stale')
          if (row.accepted_segment_id === input.decision.candidateSegmentId && row.accepted_hash === input.decision.candidateHash && row.completion_evidence_hash === input.completionEvidenceHash && stableNarrativeJson(storedDecision) === stableNarrativeJson(input.decision) && stored.acceptedSegmentId === stateDelta.acceptedSegmentId && stored.acceptedContentHash === stateDelta.acceptedContentHash && stored.contractHash === stateDelta.contractHash && stored.deltaHash === stateDelta.deltaHash && stableNarrativeJson(stored.stateDelta) === stableNarrativeJson(stateDelta)) {
            if (input.projection) {
              testHooks.beforeSceneMemoryCardInsert?.()
              persistSceneMemoryCard(d, input.projection)
              testHooks.afterSceneMemoryCardInsert?.()
              writeSceneRecallIndexMeta(d, input.projection.card, input.projection.card.storyRevision, input.committedAt)
            }
            return
          }
          throw new Error('scene_state_already_committed')
        }
        if (row.revision !== input.expectedSceneRevision || (row.lifecycle !== 'candidate' && row.lifecycle !== 'accepted')) throw new Error('scene_state_commit_not_ready')
        if (input.acceptance.segmentId !== input.decision.candidateSegmentId || input.acceptance.expectedContentHash !== input.decision.candidateHash || input.acceptance.expectedCharCount !== input.decision.candidateCharCount || input.acceptance.sceneId !== row.scene_id) throw new Error('scene_commit_candidate_mismatch')
        const completionEvidence = d.prepare('SELECT json FROM run_evidence WHERE run_id = ? AND kind = ?').get(input.acceptance.runId, `scene_completion_decision:${input.decision.candidateSegmentId}`) as { json?: string } | undefined
        if (!completionEvidence?.json) throw new Error('scene_commit_evidence_missing')
        try {
          const parsed = JSON.parse(completionEvidence.json) as { decision?: SceneCompletionDecision; sceneId?: string; contractHash?: string; candidateHash?: string; manifestHash?: string }
          const evidenceStateDeltaHash = (parsed as { stateDeltaHash?: unknown }).stateDeltaHash
          if (!parsed.decision || stableNarrativeJson(parsed.decision) !== stableNarrativeJson(input.decision) || parsed.sceneId !== row.scene_id || parsed.contractHash !== row.contract_hash || parsed.candidateHash !== input.decision.candidateHash || evidenceStateDeltaHash !== stateDelta.deltaHash || (suppliedManifest && parsed.manifestHash !== undefined && parsed.manifestHash !== sceneCommitManifestHash(suppliedManifest))) throw new Error('scene_commit_evidence_mismatch')
        } catch (error) {
          if (error instanceof Error && error.message === 'scene_commit_evidence_mismatch') throw error
          throw new Error('scene_commit_evidence_corrupt')
        }
        const segment = d.prepare('SELECT * FROM manuscript_segments WHERE run_id = ? AND segment_id = ?').get(input.acceptance.runId, input.acceptance.segmentId) as ManuscriptSegmentRow | undefined
        if (!segment || segment.scene_id !== row.scene_id || segment.content_hash !== input.decision.candidateHash || segment.char_count !== input.decision.candidateCharCount || segment.kind !== 'prose' || (segment.status !== 'candidate' && segment.status !== 'accepted')) throw new Error('scene_commit_candidate_mismatch')
        // Production scene decisions carry the hash of the accepted prefix
        // that was actually evaluated.  Recompute it from the current DB
        // rows while the write transaction is open, before accepting the
        // candidate.  This closes the no-manifest path: a late/stale
        // accepted segment cannot be hidden by omitting the manifest.
        // Legacy hand-authored decisions may omit this optional field and
        // retain the pre-R60 compatibility path.
        if (input.decision.scenePrefixHash !== undefined) {
          const currentPrefixHash = acceptedSceneContentHash(readAcceptedSceneRows(d, input.acceptance.runId, input.acceptance.sceneId), input.acceptance.segmentId)
          if (currentPrefixHash !== input.decision.scenePrefixHash) throw new Error('scene_commit_manifest_stale')
        }
        if (suppliedManifest) {
          const prefixRows = readAcceptedSceneRows(d, input.acceptance.runId, input.acceptance.sceneId)
          const expectedPrefix = suppliedManifest.acceptedSegments.filter((item) => item.segmentId !== input.acceptance.segmentId)
          const actualPrefix = prefixRows.filter((item) => item.segment_id !== input.acceptance.segmentId).map((item) => ({
            segmentId: item.segment_id,
            contentHash: item.content_hash,
            charCount: item.char_count,
            chunkIndex: item.chunk_index,
            revision: item.revision
          }))
          if (!sameSceneManifestSegments(expectedPrefix, actualPrefix)) throw new Error('scene_commit_manifest_stale')
        }
        // The acceptance port participates in this outer transaction.  It
        // re-checks classifier, evidence and partial ancestry before the scene
        // row is advanced, so a crash cannot leave a committed scene without
        // its accepted segment (or vice versa).
        this.acceptManuscriptSegment(input.acceptance)
        const accepted = d.prepare('SELECT status, content_hash, char_count FROM manuscript_segments WHERE run_id = ? AND segment_id = ?').get(input.acceptance.runId, input.acceptance.segmentId) as { status?: string; content_hash?: string; char_count?: number } | undefined
        if (!accepted || accepted.status !== 'accepted' || accepted.content_hash !== input.decision.candidateHash || accepted.char_count !== input.decision.candidateCharCount) throw new Error('scene_commit_acceptance_failed')
        const actualManifest = buildSceneCommitManifest({
          runId: input.acceptance.runId,
          sceneId: input.acceptance.sceneId,
          contractId: input.contractId,
          contractHash: input.contractHash,
          acceptedSegments: readAcceptedSceneRows(d, input.acceptance.runId, input.acceptance.sceneId),
          decision: input.decision,
          stateDeltaHash: stateDelta.deltaHash
        })
        if (suppliedManifest && !sameSceneCommitManifest(suppliedManifest, actualManifest)) throw new Error('scene_commit_manifest_mismatch')
        const existingCommit = d.prepare('SELECT * FROM narrative_commits WHERE run_id = ? AND scene_id = ?').get(input.acceptance.runId, input.acceptance.sceneId) as NarrativeCommitRow | undefined
        if (existingCommit) {
          const stored = narrativeCommitFromRow(existingCommit)
          if (stored.acceptedSegmentId !== stateDelta.acceptedSegmentId || stored.acceptedContentHash !== stateDelta.acceptedContentHash || stored.contractHash !== stateDelta.contractHash || stored.deltaHash !== stateDelta.deltaHash || stableNarrativeJson(stored.stateDelta) !== stableNarrativeJson(stateDelta)) throw new Error('narrative_commit_conflict')
          throw new Error('narrative_commit_existing_uncommitted')
        }
        const decisionJson = JSON.stringify(input.decision)
        const deltaJson = stableNarrativeJson(stateDelta)
        const commitRevision = row.revision + 1
        d.prepare(`INSERT INTO narrative_commits (
          run_id, scene_id, accepted_segment_id, accepted_content_hash, contract_hash,
          delta_hash, delta_json, revision, committed_at
        ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
          input.acceptance.runId, input.acceptance.sceneId, stateDelta.acceptedSegmentId, stateDelta.acceptedContentHash,
          stateDelta.contractHash, stateDelta.deltaHash, deltaJson, commitRevision, input.committedAt
        )
        d.prepare(`INSERT INTO scene_commit_manifests (run_id,scene_id,revision,manifest_json,manifest_hash,created_at) VALUES (?,?,?,?,?,?)`).run(
          actualManifest.runId, actualManifest.sceneId, commitRevision, stableNarrativeJson(actualManifest), sceneCommitManifestHash(actualManifest), input.committedAt
        )
        testHooks.beforeNarrativeLedgerInsert?.()
        for (const change of stateDelta.changes) {
          d.prepare(`INSERT INTO narrative_ledger (
            run_id, scene_id, change_id, change_revision, accepted_segment_id,
            accepted_content_hash, contract_hash, change_kind, entity_id, payload_json,
            delta_hash, committed_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            input.acceptance.runId, input.acceptance.sceneId, change.changeId, change.revision,
            stateDelta.acceptedSegmentId, stateDelta.acceptedContentHash, stateDelta.contractHash,
            change.kind, change.entityId, stableNarrativeJson(change), stateDelta.deltaHash, input.committedAt
          )
        }
        testHooks.afterNarrativeLedgerInsert?.()
        if (storyRun.current_revision !== storyHead.high_watermark) throw new Error('story_ledger_concurrent_head_conflict')
        const storyRevision = storyHead.high_watermark + 1
        const inheritedParent = storyHead.parent_branch_id !== null && storyHead.high_watermark === storyHead.parent_revision
        const parentBranchId = inheritedParent ? storyHead.parent_branch_id : storyRun.branch_id
        const manifestJson = stableNarrativeJson(actualManifest)
        const manifestHash = sceneCommitManifestHash(actualManifest)
        const nodeType = storyLedgerNodeType(d, { schemaVersion: 1, storyId: storyRun.story_id, projectId: storyRun.project_id, branchId: storyRun.branch_id }, storyHead.high_watermark) === 'retraction' ? 'rebase' as const : 'revision' as const
        const revisionHash = storyLedgerRevisionHashV2({
          storyId: storyRun.story_id,
          projectId: storyRun.project_id,
          branchId: storyRun.branch_id,
          revision: storyRevision,
          parentRevision: storyHead.high_watermark,
          parentHash: storyHead.head_hash,
          runId: input.acceptance.runId,
          sceneId: input.acceptance.sceneId,
          deltaHash: stateDelta.deltaHash,
          manifestHash,
          nodeType,
          hashSchemaVersion: 2
        })
        d.prepare(`INSERT INTO story_ledger_revisions (
          story_id, project_id, branch_id, revision, parent_story_id, parent_project_id, parent_branch_id,
          parent_revision, run_id, scene_id, accepted_segment_id, accepted_content_hash, contract_hash,
          delta_hash, delta_json, manifest_json, manifest_hash, parent_hash, node_type, hash_schema_version,
          revision_hash, validity_epoch, rebase_parent_revision, rebase_parent_hash, committed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          storyRun.story_id, storyRun.project_id, storyRun.branch_id, storyRevision,
          storyHead.parent_branch_id !== null ? storyRun.story_id : null,
          storyHead.parent_branch_id !== null ? storyRun.project_id : null,
          parentBranchId,
          storyHead.high_watermark, input.acceptance.runId, input.acceptance.sceneId,
          stateDelta.acceptedSegmentId, stateDelta.acceptedContentHash, stateDelta.contractHash,
          stateDelta.deltaHash, deltaJson, manifestJson, manifestHash, storyHead.head_hash, nodeType, 2, revisionHash,
          storyHead.validity_epoch, nodeType === 'rebase' ? storyHead.high_watermark : null, nodeType === 'rebase' ? storyHead.head_hash : null, input.committedAt
        )
        d.prepare('UPDATE story_ledger_heads SET high_watermark=?, head_hash=?, validity_epoch=?, updated_at=? WHERE story_id=? AND project_id=? AND branch_id=?').run(
          storyRevision, revisionHash, storyHead.validity_epoch, input.committedAt, storyRun.story_id, storyRun.project_id, storyRun.branch_id
        )
        d.prepare('UPDATE story_ledger_runs SET current_revision=?, validity_epoch=?, updated_at=? WHERE run_id=? AND current_revision=? AND validity_epoch=?').run(
          storyRevision, storyHead.validity_epoch, input.committedAt, input.acceptance.runId, storyRun.current_revision, storyRun.validity_epoch
        )
        const scopeRun = d.prepare('SELECT current_revision FROM story_ledger_runs WHERE run_id=?').get(input.acceptance.runId) as { current_revision?: number } | undefined
        if (!scopeRun || scopeRun.current_revision !== storyRevision) throw new Error('story_ledger_cursor_update_failed')
        d.prepare(`UPDATE scene_states SET lifecycle='committed', revision=revision+1, candidate_segment_id=?, candidate_hash=?, accepted_segment_id=?, accepted_hash=?, completion_decision_json=?, completion_evidence_hash=?, updated_at=?, completed_at=COALESCE(completed_at,?), committed_at=COALESCE(committed_at,?) WHERE run_id=? AND scene_id=? AND revision=?`).run(
          input.decision.candidateSegmentId, input.decision.candidateHash, input.decision.candidateSegmentId, input.decision.candidateHash, decisionJson, input.completionEvidenceHash, input.committedAt, input.committedAt, input.committedAt, input.acceptance.runId, input.acceptance.sceneId, input.expectedSceneRevision
        )
        const changed = d.prepare('SELECT lifecycle FROM scene_states WHERE run_id = ? AND scene_id = ? AND lifecycle = \'committed\'').get(input.acceptance.runId, input.acceptance.sceneId)
        if (!changed) throw new Error('scene_commit_state_failed')
        if (input.projection) {
          if (input.projection.card.storyRevision !== storyRevision || input.projection.card.validityEpoch !== storyHead.validity_epoch || input.projection.card.commitManifestHash !== manifestHash || input.projection.card.stateDeltaHash !== stateDelta.deltaHash) throw new Error('scene_card_source_changed')
          testHooks.beforeSceneMemoryCardInsert?.()
          persistSceneMemoryCard(d, input.projection)
          testHooks.afterSceneMemoryCardInsert?.()
          writeSceneRecallIndexMeta(d, input.projection.card, input.projection.card.storyRevision, input.committedAt)
        }
      }, 'immediate')
    },
    getSceneCommitManifest(runId, sceneId) {
      const row = requireDb().prepare('SELECT manifest_json, manifest_hash FROM scene_commit_manifests WHERE run_id = ? AND scene_id = ?').get(runId, sceneId) as { manifest_json?: string; manifest_hash?: string } | undefined
      if (!row?.manifest_json || !row.manifest_hash) return null
      let manifest: SceneCommitManifest
      try { manifest = parseSceneCommitManifest(JSON.parse(row.manifest_json)) } catch { throw new Error('scene_commit_manifest_corrupt') }
      if (manifest.runId !== runId || manifest.sceneId !== sceneId || sceneCommitManifestHash(manifest) !== row.manifest_hash) throw new Error('scene_commit_manifest_binding_mismatch')
      return manifest
    },
    upsertSceneMemoryCard(input) {
      let result: { inserted: boolean; card: SceneMemoryCard } | null = null
      withImmediateTransaction(() => { result = persistSceneMemoryCard(requireDb(), input) })
      if (!result) throw new Error('scene_memory_projection_missing')
      return result
    },
    applySceneMemoryEmbeddingResult(input) {
      if (!input || typeof input.cardId !== 'string' || input.cardId.length === 0 ||
        !SCENE_MEMORY_HASH.test(input.sourceCardHash) || !Number.isInteger(input.validityEpoch) || input.validityEpoch < 1 ||
        (input.status !== 'ready' && input.status !== 'failed') || !Number.isInteger(input.completedAt) || input.completedAt < 0 ||
        typeof input.version !== 'string' || input.version.length === 0 || typeof input.modelId !== 'string' || input.modelId.length === 0 ||
        input.expiresAt !== undefined && input.expiresAt !== null && !Number.isFinite(input.expiresAt) ||
        input.now !== undefined && !Number.isFinite(input.now)) throw new Error('scene_memory_embedding_input_invalid')
      const now = input.now ?? Date.now()
      let result: SceneMemoryEmbeddingApplyResult | null = null
      withImmediateTransaction(() => {
        const d = requireDb()
        const row = d.prepare('SELECT * FROM scene_memory_cards WHERE card_id=?').get(input.cardId) as { [key: string]: unknown } | undefined
        if (!row) {
          result = { applied: false, reason: 'card_missing' }
          return
        }
        let card: SceneMemoryCard
        try { card = sceneMemoryCardFromRow(row) } catch {
          result = { applied: false, reason: 'authority_mismatch' }
          return
        }
        if (row.visibility !== 'active' || card.status !== 'canonical' || !sceneMemoryCardRowVisible(d, row)) {
          result = { applied: false, reason: 'card_not_active' }
          return
        }
        if (card.cardId !== input.cardId || card.cardHash !== input.sourceCardHash || card.validityEpoch !== input.validityEpoch) {
          result = { applied: false, reason: 'authority_mismatch' }
          return
        }
        if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt <= now) {
          result = { applied: false, reason: 'result_expired' }
          return
        }
        if (input.status === 'failed') {
          result = { applied: false, reason: 'worker_failed' }
          return
        }
        const vector = input.vector
        if (!Array.isArray(vector) || vector.length === 0 || vector.length > 8192 || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
          result = { applied: false, reason: 'vector_invalid' }
          return
        }
        const vectorJson = stableSceneMemoryJson(vector)
        const vectorHash = sceneMemoryStableHash(vector)
        if (input.vectorHash !== undefined && input.vectorHash !== null && (!SCENE_MEMORY_HASH.test(input.vectorHash) || input.vectorHash !== vectorHash)) {
          result = { applied: false, reason: 'vector_invalid' }
          return
        }
        const embedding = d.prepare('SELECT status, version, model_id, dimensions, vector_hash, vector_json, source_card_hash, updated_at FROM scene_recall_embeddings WHERE card_id=?').get(input.cardId) as { status?: unknown; version?: unknown; model_id?: unknown; dimensions?: unknown; vector_hash?: unknown; vector_json?: unknown; source_card_hash?: unknown; updated_at?: unknown } | undefined
        if (!embedding || embedding.source_card_hash !== card.cardHash) {
          result = { applied: false, reason: 'embedding_not_expected' }
          return
        }
        const sameValue = embedding.status === 'ready' && embedding.version === input.version && embedding.model_id === input.modelId && embedding.dimensions === vector.length && embedding.vector_hash === vectorHash && embedding.vector_json === vectorJson
        if (sameValue) {
          result = { applied: false, reason: 'already_applied' }
          return
        }
        if (typeof embedding.updated_at === 'number' && (input.completedAt < embedding.updated_at || embedding.status === 'ready' && input.completedAt === embedding.updated_at)) {
          result = { applied: false, reason: 'result_stale' }
          return
        }
        d.prepare(`UPDATE scene_recall_embeddings
          SET status='ready', version=?, model_id=?, dimensions=?, vector_hash=?, vector_json=?, source_card_hash=?, updated_at=?
          WHERE card_id=? AND source_card_hash=?`).run(
          input.version,
          input.modelId,
          vector.length,
          vectorHash,
          vectorJson,
          card.cardHash,
          input.completedAt,
          input.cardId,
          card.cardHash
        )
        result = { applied: true, reason: 'applied' }
      })
      if (!result) throw new Error('scene_memory_embedding_result_missing')
      return result
    },
    replaySceneMemoryCardOutbox(options) {
      const requestedLimit = options?.limit ?? 100
      if (!Number.isFinite(requestedLimit) || !Number.isInteger(requestedLimit) || requestedLimit < 0) throw new Error('scene_memory_outbox_limit_invalid')
      if (options?.now !== undefined && !Number.isFinite(options.now)) throw new Error('scene_memory_outbox_time_invalid')
      const limit = Math.min(1000, requestedLimit)
      const now = options?.now ?? Date.now()
      const result: SceneMemoryCardOutboxReplayResult = { scanned: 0, published: 0, rejected: 0, pending: 0 }
      withImmediateTransaction(() => {
        const d = requireDb()
        const rows = d.prepare(`SELECT * FROM scene_memory_card_outbox
          WHERE status='pending'
          ORDER BY updated_at ASC, outbox_id ASC
          LIMIT ?`).all(limit) as Array<{ [key: string]: unknown }>
        for (const row of rows) {
          result.scanned += 1
          let nextStatus: 'published' | 'rejected' | 'pending' = 'pending'
          let errorCode = 'retriable'
          let publicationInProgress = false
          try {
            const outboxId = row.outbox_id
            const storyId = row.story_id
            const projectId = row.project_id
            const branchId = row.branch_id
            const validityEpoch = row.validity_epoch
            const storyRevision = row.story_revision
            const sceneId = row.scene_id
            const commitManifestHash = row.commit_manifest_hash
            const cardHash = row.card_hash
            const payloadJson = row.payload_json
            if (typeof outboxId !== 'string' || outboxId.length === 0 || typeof storyId !== 'string' || storyId.length === 0 ||
              typeof projectId !== 'string' || projectId.length === 0 || typeof branchId !== 'string' || branchId.length === 0 ||
              !Number.isInteger(validityEpoch) || Number(validityEpoch) < 1 || !Number.isInteger(storyRevision) || Number(storyRevision) < 1 ||
              typeof sceneId !== 'string' || sceneId.length === 0 || !SCENE_MEMORY_HASH.test(String(commitManifestHash)) || !SCENE_MEMORY_HASH.test(String(cardHash)) ||
              typeof payloadJson !== 'string') {
              nextStatus = 'rejected'
              errorCode = 'outbox_row_invalid'
            } else {
              const payload = parseStrictSceneMemoryJson(payloadJson, 'scene_memory_outbox_payload')
              assertPersistedSceneMemoryCardShape(payload)
              const card = payload
              if (card.status !== 'canonical' || card.storyId !== storyId || card.projectId !== projectId || card.branchId !== branchId ||
                card.validityEpoch !== validityEpoch || card.storyRevision !== storyRevision || card.sceneId !== sceneId ||
                card.commitManifestHash !== commitManifestHash || card.cardHash !== cardHash || sceneMemoryCardHash(card) !== cardHash ||
                stableSceneMemoryCardJson(card) !== payloadJson || sceneMemoryStableHash({ identity: sceneMemoryScopeIdentity(card), cardHash: card.cardHash }) !== outboxId) {
                nextStatus = 'rejected'
                errorCode = 'outbox_payload_authority_mismatch'
              } else {
                const cardRow = d.prepare('SELECT * FROM scene_memory_cards WHERE card_id=?').get(card.cardId) as { [key: string]: unknown } | undefined
                if (!cardRow) {
                  nextStatus = 'pending'
                  errorCode = 'card_missing'
                } else {
                  let persisted: SceneMemoryCard
                  try { persisted = sceneMemoryCardFromRow(cardRow) } catch {
                    nextStatus = 'rejected'
                    errorCode = 'card_corrupt'
                    persisted = card
                  }
                  if (nextStatus !== 'rejected' && (persisted.cardId !== card.cardId || persisted.cardHash !== card.cardHash ||
                    cardRow.card_json !== payloadJson || cardRow.card_hash !== cardHash || cardRow.story_id !== storyId || cardRow.project_id !== projectId ||
                    cardRow.branch_id !== branchId || cardRow.validity_epoch !== validityEpoch || cardRow.story_revision !== storyRevision || cardRow.scene_id !== sceneId ||
                    cardRow.commit_manifest_hash !== commitManifestHash || cardRow.visibility !== 'pending' && cardRow.visibility !== 'active' || cardRow.visibility === 'active' && cardRow.status !== 'canonical')) {
                    nextStatus = 'rejected'
                    errorCode = 'card_authority_mismatch'
                  }
                  if (nextStatus !== 'rejected') {
                    const sourcePlaceholders = card.sourceSegmentIds.map(() => '?').join(',')
                    const sourceRows = d.prepare(`SELECT * FROM manuscript_segments
                      WHERE run_id=? AND scene_id=? AND status='accepted' AND kind='prose' AND segment_id IN (${sourcePlaceholders})
                      ORDER BY chunk_index ASC, revision ASC, segment_id ASC`).all(card.runId, card.sceneId, ...card.sourceSegmentIds) as unknown as ManuscriptSegmentRow[]
                    const allAccepted = d.prepare(`SELECT segment_id FROM manuscript_segments
                      WHERE run_id=? AND scene_id=? AND status='accepted' AND kind='prose'
                      ORDER BY chunk_index ASC, revision ASC, segment_id ASC`).all(card.runId, card.sceneId) as Array<{ segment_id?: unknown }>
                    const expectedSourceIds = [...card.sourceSegmentIds].sort((left, right) => left.localeCompare(right))
                    const actualSourceIds = sourceRows.map((source) => source.segment_id).sort((left, right) => left.localeCompare(right))
                    const state = d.prepare('SELECT lifecycle FROM scene_states WHERE run_id=? AND scene_id=?').get(card.runId, card.sceneId) as { lifecycle?: string } | undefined
                    const commit = d.prepare('SELECT accepted_content_hash, accepted_segment_id, contract_hash, delta_hash FROM narrative_commits WHERE run_id=? AND scene_id=?').get(card.runId, card.sceneId) as { accepted_content_hash?: unknown; accepted_segment_id?: unknown; contract_hash?: unknown; delta_hash?: unknown } | undefined
                    const manifest = d.prepare('SELECT 1 AS present FROM scene_commit_manifests WHERE run_id=? AND scene_id=? AND manifest_hash=?').get(card.runId, card.sceneId, card.commitManifestHash) as { present?: number } | undefined
                    const ledger = d.prepare(`SELECT 1 AS present FROM story_ledger_revisions
                      WHERE story_id=? AND project_id=? AND branch_id=? AND revision=? AND run_id=? AND scene_id=? AND delta_hash=? AND manifest_hash=? AND validity_epoch=?`).get(
                      card.storyId, card.projectId, card.branchId, card.storyRevision, card.runId, card.sceneId, card.stateDeltaHash, card.commitManifestHash, card.validityEpoch
                    ) as { present?: number } | undefined
                    const tombstone = d.prepare(`SELECT 1 AS present FROM story_ledger_tombstones
                      WHERE story_id=? AND project_id=? AND branch_id=? AND (target_revision=? OR revision=?) LIMIT 1`).get(card.storyId, card.projectId, card.branchId, card.storyRevision, card.storyRevision) as { present?: number } | undefined
                    if (sourceRows.length === 0 || allAccepted.length !== expectedSourceIds.length || stableSceneMemoryJson(actualSourceIds) !== stableSceneMemoryJson(expectedSourceIds) || state?.lifecycle !== 'committed' || !commit || commit.contract_hash !== card.contractHash || commit.delta_hash !== card.stateDeltaHash || typeof commit.accepted_content_hash !== 'string' || manifest?.present !== 1 || ledger?.present !== 1) {
                      nextStatus = 'pending'
                      errorCode = 'source_authority_pending'
                    } else if (tombstone?.present === 1) {
                      nextStatus = 'rejected'
                      errorCode = 'source_retracted'
                    } else {
                      let validated = false
                      try {
                        const sourceSegments = sourceRows.map((source) => sourceSegmentFromRow(source, card.commitManifestHash))
                        const claims = readSceneRecallLedgerClaims(d, card, commit.accepted_content_hash)
                        assertSceneMemoryProjection(d, {
                          card,
                          context: {
                            sourceSegments,
                            expectedScope: { storyId: card.storyId, projectId: card.projectId, branchId: card.branchId },
                            expectedValidityEpoch: card.validityEpoch,
                            expectedStoryRevision: card.storyRevision,
                            expectedContract: { contractId: card.contractId, contractHash: card.contractHash },
                            expectedBindings: { sceneContentHash: card.sceneContentHash, commitManifestHash: card.commitManifestHash, stateDeltaHash: card.stateDeltaHash },
                            ledgerClaims: claims
                          }
                        })
                        const embedding = d.prepare('SELECT source_card_hash FROM scene_recall_embeddings WHERE card_id=?').get(card.cardId) as { source_card_hash?: unknown } | undefined
                        if (!embedding || embedding.source_card_hash !== card.cardHash) {
                          throw new Error('embedding_sidecar_missing')
                        }
                        validated = true
                      } catch {
                        nextStatus = 'rejected'
                        errorCode = 'source_authority_mismatch'
                      }
                      if (validated) {
                        if (cardRow.visibility === 'pending') d.prepare("UPDATE scene_memory_cards SET visibility='active', updated_at=? WHERE card_id=? AND visibility='pending'").run(now, card.cardId)
                        const activated = d.prepare("SELECT visibility FROM scene_memory_cards WHERE card_id=?").get(card.cardId) as { visibility?: unknown } | undefined
                        if (activated?.visibility !== 'active') throw new Error('card_activation_failed')
                        // Publish the outbox record before deriving the index
                        // fence; sceneMemoryCardRowVisible intentionally
                        // requires a published outbox row.
                        publicationInProgress = true
                        d.prepare("UPDATE scene_memory_card_outbox SET status='published', error_code=NULL, updated_at=? WHERE outbox_id=? AND status='pending'").run(now, outboxId)
                        writeSceneRecallIndexMeta(d, card, card.storyRevision, now)
                        nextStatus = 'published'
                        errorCode = ''
                      }
                    }
                  }
                }
              }
            }
          } catch (error) {
            if (publicationInProgress) throw error
            nextStatus = 'rejected'
            errorCode = 'outbox_payload_corrupt'
          }
          const scannedOutboxId = typeof row.outbox_id === 'string' ? row.outbox_id : ''
          if (nextStatus === 'published') {
            d.prepare("UPDATE scene_memory_card_outbox SET status='published', error_code=NULL, updated_at=? WHERE outbox_id=? AND status='pending'").run(now, scannedOutboxId)
            result.published += 1
          } else if (nextStatus === 'rejected') {
            d.prepare("UPDATE scene_memory_card_outbox SET status='rejected', error_code=?, updated_at=? WHERE outbox_id=? AND status='pending'").run(errorCode || 'rejected', now, scannedOutboxId)
            result.rejected += 1
          } else {
            d.prepare("UPDATE scene_memory_card_outbox SET status='pending', error_code=?, updated_at=? WHERE outbox_id=? AND status='pending'").run(errorCode || 'retriable', now, scannedOutboxId)
            result.pending += 1
          }
        }
      })
      return result
    },
    getSceneMemoryCard(query) {
      const d = requireDb()
      const clauses: string[] = []
      const values: Array<string | number> = []
      if (query.cardId !== undefined) { clauses.push('card_id=?'); values.push(query.cardId) }
      if (query.storyId !== undefined) { clauses.push('story_id=?'); values.push(query.storyId) }
      if (query.projectId !== undefined) { clauses.push('project_id=?'); values.push(query.projectId) }
      if (query.branchId !== undefined) { clauses.push('branch_id=?'); values.push(query.branchId) }
      if (query.validityEpoch !== undefined) { clauses.push('validity_epoch=?'); values.push(query.validityEpoch) }
      if (query.storyRevision !== undefined) { clauses.push('story_revision=?'); values.push(query.storyRevision) }
      if (query.sceneId !== undefined) { clauses.push('scene_id=?'); values.push(query.sceneId) }
      if (query.commitManifestHash !== undefined) { clauses.push('commit_manifest_hash=?'); values.push(query.commitManifestHash) }
      if (query.cardHash !== undefined) { clauses.push('card_hash=?'); values.push(query.cardHash) }
      if (clauses.length === 0) throw new Error('scene_memory_card_query_scope_required')
      const row = d.prepare(`SELECT * FROM scene_memory_cards WHERE ${clauses.join(' AND ')} ORDER BY story_revision DESC, scene_order ASC, card_id ASC LIMIT 1`).get(...values) as { [key: string]: unknown } | undefined
      if (!row) return null
      const card = sceneMemoryCardFromRow(row)
      // Hidden reads are an audit escape hatch, not a way to turn an orphan
      // or a tampered active row into usable recall data.  Active rows must
      // still pass the full live-source fence even when includeHidden=true.
      if (row.visibility === 'active' && !sceneMemoryCardRowVisible(d, row)) return null
      if (!query.includeHidden && row.visibility !== 'active') return null
      return card
    },
    listSceneMemoryCards(scope) {
      if (!scope.storyId || !scope.projectId || !scope.branchId || !Number.isInteger(scope.validityEpoch) || scope.validityEpoch < 1) throw new Error('scene_memory_scope_invalid')
      const d = requireDb()
      const clauses = ['story_id=?', 'project_id=?', 'branch_id=?', 'validity_epoch=?']
      const values: Array<string | number> = [scope.storyId, scope.projectId, scope.branchId, scope.validityEpoch]
      if (scope.storyRevision !== undefined) { clauses.push('story_revision=?'); values.push(scope.storyRevision) }
      if (scope.sceneId !== undefined) { clauses.push('scene_id=?'); values.push(scope.sceneId) }
      if (!scope.includeHidden) clauses.push("visibility='active'", "status <> 'legacy_unverified'")
      const rows = d.prepare(`SELECT * FROM scene_memory_cards WHERE ${clauses.join(' AND ')} ORDER BY story_revision ASC, scene_order ASC, card_id ASC`).all(...values) as Array<{ [key: string]: unknown }>
      const out: SceneMemoryCard[] = []
      for (const row of rows) {
        const card = sceneMemoryCardFromRow(row)
        if (row.visibility === 'active' && !sceneMemoryCardRowVisible(d, row)) continue
        if (!scope.includeHidden && row.visibility !== 'active') continue
        out.push(card)
      }
      return out
    },
    markSceneMemoryCardVisibility(cardId, visibility) {
      if (!cardId || !['stale', 'retracted', 'legacy_unverified', 'pending'].includes(visibility)) throw new Error('scene_memory_visibility_invalid')
      const d = requireDb()
      const result = d.prepare('UPDATE scene_memory_cards SET visibility=?, updated_at=? WHERE card_id=?').run(visibility, Date.now(), cardId) as { changes?: number }
      if (Number(result.changes ?? 0) !== 1) throw new Error('scene_memory_card_missing')
    },
    rebuildSceneMemoryProjection(scope, cards) {
      if (!scope.storyId || !scope.projectId || !scope.branchId || !Number.isInteger(scope.validityEpoch) || scope.validityEpoch < 1) throw new Error('scene_memory_scope_invalid')
      const ordered = [...cards].sort((a, b) => a.card.cardHash.localeCompare(b.card.cardHash) || a.card.cardId.localeCompare(b.card.cardId))
      const inputIds = new Set<string>()
      const inputIdentities = new Set<string>()
      for (const input of ordered) {
        const identity = sceneMemoryScopeIdentity(input.card)
        if (inputIds.has(input.card.cardId)) throw new Error('scene_memory_rebuild_duplicate_card_id')
        if (inputIdentities.has(identity)) throw new Error('scene_memory_rebuild_duplicate_identity')
        inputIds.add(input.card.cardId)
        inputIdentities.add(identity)
      }
      let result: { cardCount: number; cardSetHash: string; indexHash: string } | null = null
      withImmediateTransaction(() => {
        const d = requireDb()
        for (const input of ordered) {
          const card = input.card
          if (card.storyId !== scope.storyId || card.projectId !== scope.projectId || card.branchId !== scope.branchId || card.validityEpoch !== scope.validityEpoch || (scope.storyRevision !== undefined && card.storyRevision !== scope.storyRevision) || (scope.sceneId !== undefined && card.sceneId !== scope.sceneId)) throw new Error('scene_memory_rebuild_scope_mismatch')
          const existing = d.prepare('SELECT * FROM scene_memory_cards WHERE card_id=?').get(card.cardId) as { [key: string]: unknown } | undefined
          if (existing?.visibility === 'active' && !sceneMemoryCardRowVisible(d, existing)) throw new Error('scene_memory_rebuild_active_card_not_visible')
          const persisted = persistSceneMemoryCard(d, input)
          if (existing && existing.visibility !== 'active') {
            // A hidden row may only be reactivated after the same full source
            // validation used for a fresh publish and a published outbox
            // record for this exact identity/hash.  Retractions/tombstones,
            // pending writes and legacy rows are never resurrectable.
            if (existing.visibility !== 'stale') throw new Error('scene_memory_rebuild_hidden_card_not_reactivatable')
            const outbox = d.prepare(`SELECT status, payload_json FROM scene_memory_card_outbox
              WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=? AND story_revision=? AND scene_id=? AND commit_manifest_hash=? AND card_hash=?
              ORDER BY updated_at DESC LIMIT 1`).get(card.storyId, card.projectId, card.branchId, card.validityEpoch, card.storyRevision, card.sceneId, card.commitManifestHash, card.cardHash) as { status?: string; payload_json?: string } | undefined
            if (outbox?.status !== 'published' || typeof outbox.payload_json !== 'string') throw new Error('scene_memory_rebuild_outbox_not_published')
            const refreshed = d.prepare('SELECT * FROM scene_memory_cards WHERE card_id=?').get(card.cardId) as { [key: string]: unknown } | undefined
            if (!refreshed || !sceneMemoryCardRowVisible(d, { ...refreshed, visibility: 'active' })) throw new Error('scene_memory_rebuild_source_not_visible')
            d.prepare("UPDATE scene_memory_cards SET visibility='active', updated_at=? WHERE card_id=? AND visibility='stale'").run(Date.now(), card.cardId)
          } else if (!existing && !persisted.inserted) {
            throw new Error('scene_memory_rebuild_existing_identity_unresolved')
          }
        }
        const revision = scope.storyRevision ?? Number((d.prepare('SELECT MAX(story_revision) AS revision FROM scene_memory_cards WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=?').get(scope.storyId, scope.projectId, scope.branchId, scope.validityEpoch) as { revision?: number } | undefined)?.revision ?? 0)
        const keep = new Set(ordered.map((item) => item.card.cardId))
        // A revision-scoped rebuild must preserve older active cards because
        // they remain in the cumulative index.  An unscoped full rebuild is
        // authoritative for the whole branch and may stale omitted cards
        // across revisions, retaining the pre-WP5 rebuild contract.
        const oldRows = d.prepare(`SELECT card_id FROM scene_memory_cards WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=?${scope.storyRevision === undefined ? '' : ' AND story_revision=?'}${scope.sceneId === undefined ? '' : ' AND scene_id=?'}`).all(...([scope.storyId, scope.projectId, scope.branchId, scope.validityEpoch, ...(scope.storyRevision === undefined ? [] : [revision]), ...(scope.sceneId === undefined ? [] : [scope.sceneId])] as Array<string | number>)) as Array<{ card_id?: string }>
        for (const row of oldRows) if (row.card_id && !keep.has(row.card_id)) d.prepare("UPDATE scene_memory_cards SET visibility='stale', updated_at=? WHERE card_id=? AND visibility='active'").run(Date.now(), row.card_id)
        const meta = writeSceneRecallIndexMeta(d, scope, revision, Date.now())
        result = { cardCount: meta.cardCount, cardSetHash: meta.cardSetHash, indexHash: meta.indexHash }
      })
      if (!result) throw new Error('scene_memory_rebuild_missing')
      return result
    },
    getSceneRecallCorpusSnapshot(input) {
      return getSceneRecallCorpusSnapshot(input)
    },
    saveSceneWorkingSet(input) {
      const complete = fullWorkingSetRecordFromInput(input)
      if (complete) {
        const d = requireDb()
        const workingSet = complete.record.workingSet
        withImmediateTransaction(() => {
          if (complete.storageStatus === 'active') {
            const authority = assertSceneWorkingSetLiveAuthority(d, complete.record, complete.cardIds)
            if (Object.keys(complete.record.branchCutoffs).length === 0) {
              complete.record.branchCutoffs = Object.fromEntries([...authority.cutoffs.entries()])
              complete.canonicalJson = stableSceneMemoryJson(complete.record)
              complete.canonicalHash = canonicalWorkingSetHash(complete.record)
            }
          }
          // working_set_id is the explicit immutable outer-call/attempt
          // dimension.  Multiple rounds may share one story head and recall
          // query, while a changed current-scene tail must remain a distinct
          // auditable row; never collapse those rows by query hash.
          const existing = d.prepare('SELECT working_set_hash, canonical_hash, canonical_json, final_envelope_hash FROM scene_working_sets WHERE working_set_id=?').get(workingSet.workingSetId) as { working_set_hash?: string; canonical_hash?: string | null; canonical_json?: string | null; final_envelope_hash?: string | null } | undefined
          if (existing) {
            if (existing.working_set_hash !== workingSet.workingSetHash || typeof existing.canonical_json !== 'string' || !isWorkingSetHash(existing.canonical_hash)) throw new Error('scene_working_set_identity_conflict')
            let existingRecord: SceneWorkingSetPersistenceRecord
            try {
              const parsed = parseStrictSceneMemoryJson(existing.canonical_json, 'scene_working_set_canonical')
              if (!isPlainRecord(parsed) || stableSceneMemoryJson(parsed) !== existing.canonical_json || existing.canonical_hash !== sceneMemoryStableHash(parsed)) throw new Error('canonical hash mismatch')
              existingRecord = parsed as unknown as SceneWorkingSetPersistenceRecord
              assertWorkingSetParts(existingRecord)
            } catch {
              throw new Error('scene_working_set_identity_conflict')
            }
            if ((existing.final_envelope_hash ?? null) !== existingRecord.finalEnvelopeHash) throw new Error('scene_working_set_identity_conflict')
            if (!sameWorkingSetAuthorityRecord(existingRecord, complete.record)) throw new Error('scene_working_set_identity_conflict')
            if ((existingRecord.finalEnvelopeHash ?? null) !== (complete.record.finalEnvelopeHash ?? null) && complete.record.finalEnvelopeHash !== null) throw new Error('scene_working_set_identity_conflict')
            return
          }
          d.prepare(`INSERT INTO scene_working_sets (working_set_id,story_id,project_id,branch_id,validity_epoch,story_revision,scene_id,query_hash,card_ids_json,omitted_json,payload_json,working_set_hash,status,created_at,updated_at,schema_version,run_id,branch_lineage_json,branch_cutoffs_json,canonical_json,canonical_hash,final_envelope_hash)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            workingSet.workingSetId, workingSet.storyId, workingSet.projectId, workingSet.branchId, workingSet.validityEpoch, workingSet.storyRevision, workingSet.sceneId, workingSet.queryHash,
            stableSceneMemoryJson(complete.cardIds), stableSceneMemoryJson(workingSet.omitted), complete.canonicalJson, workingSet.workingSetHash, complete.storageStatus, complete.createdAt, complete.createdAt,
            1, workingSet.runId, stableSceneMemoryJson(complete.record.branchLineage), stableSceneMemoryJson(complete.record.branchCutoffs), complete.canonicalJson, complete.canonicalHash, complete.record.finalEnvelopeHash
          )
        })
        return
      }
      const status = input.status ?? 'active'
      if (!input.workingSetId || !input.storyId || !input.projectId || !input.branchId || !Number.isInteger(input.validityEpoch) || input.validityEpoch! < 1 || !Number.isInteger(input.storyRevision) || input.storyRevision! < 0 || !input.sceneId || !input.queryHash || !SCENE_MEMORY_HASH.test(input.workingSetHash ?? '') || !['active', 'stale', 'retracted'].includes(status) || input.createdAt !== undefined && !Number.isFinite(input.createdAt) || !Array.isArray(input.cardIds) || input.cardIds.some((cardId) => typeof cardId !== 'string' || cardId.length === 0) || (input.omitted !== undefined && !Array.isArray(input.omitted))) throw new Error('scene_working_set_invalid')
      assertSceneMemoryJsonValue(input.payload, 'scene_working_set_payload')
      assertSceneMemoryJsonValue(input.omitted ?? [], 'scene_working_set_omitted')
      const legacyStoryId = input.storyId
      const legacyProjectId = input.projectId
      const legacyBranchId = input.branchId
      const legacyValidityEpoch = input.validityEpoch
      const legacyStoryRevision = input.storyRevision
      const legacySceneId = input.sceneId
      const legacyQueryHash = input.queryHash
      const legacyWorkingSetHash = input.workingSetHash
      const legacyWorkingSetId = input.workingSetId
      if (!legacyStoryId || !legacyProjectId || !legacyBranchId || !legacySceneId || !legacyQueryHash || !legacyWorkingSetId || legacyValidityEpoch === undefined || legacyStoryRevision === undefined || !legacyWorkingSetHash || !Array.isArray(input.cardIds)) throw new Error('scene_working_set_invalid')
      const ids = [...input.cardIds]
      if (new Set(ids).size !== ids.length) throw new Error('scene_working_set_duplicate_card')
      const omitted = input.omitted ?? []
      const now = input.createdAt ?? Date.now()
      const d = requireDb()
      withImmediateTransaction(() => {
        if (status === 'active') {
          for (const cardId of ids) {
            const cardRow = d.prepare('SELECT * FROM scene_memory_cards WHERE card_id=?').get(cardId) as { [key: string]: unknown } | undefined
            if (!cardRow || cardRow.visibility !== 'active' || !sceneMemoryCardRowVisible(d, cardRow)) throw new Error('scene_working_set_card_not_visible')
            const card = sceneMemoryCardFromRow(cardRow)
            if (!sceneMemoryWorkingSetCardAllowed(card, { storyId: legacyStoryId, projectId: legacyProjectId, branchId: legacyBranchId, validityEpoch: legacyValidityEpoch, storyRevision: legacyStoryRevision, sceneId: legacySceneId })) throw new Error('scene_working_set_card_scope_mismatch')
          }
        }
        const expectedHash = sceneMemoryStableHash({ storyId: legacyStoryId, projectId: legacyProjectId, branchId: legacyBranchId, validityEpoch: legacyValidityEpoch, storyRevision: legacyStoryRevision, sceneId: legacySceneId, queryHash: legacyQueryHash, cardIds: ids, omitted, payload: input.payload })
        if (expectedHash !== legacyWorkingSetHash) throw new Error('scene_working_set_hash_mismatch')
        const existing = d.prepare('SELECT story_id,project_id,branch_id,validity_epoch,story_revision,scene_id,query_hash,card_ids_json,omitted_json,payload_json,working_set_hash,status FROM scene_working_sets WHERE working_set_id=?').get(legacyWorkingSetId) as { story_id?: unknown; project_id?: unknown; branch_id?: unknown; validity_epoch?: unknown; story_revision?: unknown; scene_id?: unknown; query_hash?: unknown; card_ids_json?: unknown; omitted_json?: unknown; payload_json?: unknown; working_set_hash?: unknown; status?: unknown } | undefined
        if (existing && (existing.story_id !== legacyStoryId || existing.project_id !== legacyProjectId || existing.branch_id !== legacyBranchId || existing.validity_epoch !== legacyValidityEpoch || existing.story_revision !== legacyStoryRevision || existing.scene_id !== legacySceneId || existing.query_hash !== legacyQueryHash || existing.card_ids_json !== stableSceneMemoryJson(ids) || existing.omitted_json !== stableSceneMemoryJson(omitted) || existing.payload_json !== stableSceneMemoryJson(input.payload) || existing.working_set_hash !== legacyWorkingSetHash || existing.status !== status)) throw new Error('scene_working_set_identity_conflict')
        if (existing) return
        d.prepare(`INSERT INTO scene_working_sets (working_set_id,story_id,project_id,branch_id,validity_epoch,story_revision,scene_id,query_hash,card_ids_json,omitted_json,payload_json,working_set_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(legacyWorkingSetId, legacyStoryId, legacyProjectId, legacyBranchId, legacyValidityEpoch, legacyStoryRevision, legacySceneId, legacyQueryHash, stableSceneMemoryJson(ids), stableSceneMemoryJson(omitted), stableSceneMemoryJson(input.payload), legacyWorkingSetHash, status, now, now)
      })
    },
    getSceneWorkingSet(workingSetId, includeHidden = false) {
      if (!workingSetId) throw new Error('scene_working_set_id_invalid')
      const d = requireDb()
      let result: SceneWorkingSetReadResult | null = null
      withImmediateTransaction(() => {
        const row = d.prepare('SELECT * FROM scene_working_sets WHERE working_set_id=?').get(workingSetId) as { [key: string]: unknown } | undefined
        if (row) result = readSceneWorkingSet(d, row, includeHidden)
      })
      return result
    },
    bindSceneWorkingSetFinalEnvelope(input) {
      if (!input || !input.workingSetId) throw new Error('scene_working_set_id_invalid')
      // A hash-only bind is deliberately fail-closed.  The provider attempt
      // must pass the exact final message array so this boundary can derive
      // the same role/UTF-8-length wire hash used by providerEnvelopeHash.
      if (input.finalEnvelope === undefined) throw new Error('scene_working_set_final_envelope_required')
      const derivedHash = providerEnvelopeHash(canonicalProviderMessages(input.finalEnvelope))
      if (input.finalEnvelopeHash !== undefined && input.finalEnvelopeHash !== null && input.finalEnvelopeHash !== derivedHash) throw new Error('scene_working_set_final_envelope_hash_mismatch')
      const suppliedHash = derivedHash
      if (!SCENE_MEMORY_HASH.test(suppliedHash)) throw new Error('scene_working_set_final_envelope_hash_invalid')
      const d = requireDb()
      withImmediateTransaction(() => {
        const row = d.prepare('SELECT * FROM scene_working_sets WHERE working_set_id=?').get(input.workingSetId) as { [key: string]: unknown } | undefined
        if (!row) throw new Error('scene_working_set_missing')
        if (row.status !== 'active') throw new Error('scene_working_set_not_active')
        const current = readSceneWorkingSet(d, row, true)
        if (!current || current.legacy || !current.workingSet || !current.manifest || !current.workingSetMessage || current.canonicalHash === undefined) throw new Error('scene_working_set_canonical_missing')
        const currentHash = current.finalEnvelopeHash ?? null
        if (currentHash !== null && currentHash !== suppliedHash) throw new Error('scene_working_set_final_envelope_conflict')
        if (currentHash === suppliedHash) return
        const canonical = parseStrictSceneMemoryJson(row.canonical_json, 'scene_working_set_canonical') as unknown as SceneWorkingSetPersistenceRecord
        const next: SceneWorkingSetPersistenceRecord = { ...canonical, finalEnvelopeHash: suppliedHash }
        assertWorkingSetParts(next)
        const canonicalJson = stableSceneMemoryJson(next)
        const canonicalHash = canonicalWorkingSetHash(next)
        d.prepare(`UPDATE scene_working_sets SET payload_json=?,canonical_json=?,canonical_hash=?,final_envelope_hash=?,updated_at=? WHERE working_set_id=? AND canonical_hash=? AND status='active'`).run(canonicalJson, canonicalJson, canonicalHash, suppliedHash, Date.now(), input.workingSetId, current.canonicalHash)
        const refreshed = d.prepare('SELECT canonical_hash FROM scene_working_sets WHERE working_set_id=?').get(input.workingSetId) as { canonical_hash?: string } | undefined
        if (refreshed?.canonical_hash !== canonicalHash) throw new Error('scene_working_set_final_envelope_bind_failed')
      })
    },
    assertSceneWorkingSetFresh(workingSetId, expected) {
      const result = this.getSceneWorkingSet(workingSetId)
      if (!result || result.legacy || !result.runId || !result.branchLineage) throw new Error('scene_working_set_not_fresh')
      const expectation: SceneWorkingSetFreshnessExpectation = typeof expected === 'string' || expected === null
        ? { finalEnvelopeHash: expected }
        : expected ?? {}
      if (expectation.workingSetHash !== undefined && result.workingSetHash !== expectation.workingSetHash) throw new Error('scene_working_set_hash_mismatch')
      if (expectation.canonicalHash !== undefined && result.canonicalHash !== expectation.canonicalHash) throw new Error('scene_working_set_canonical_mismatch')
      if (Object.prototype.hasOwnProperty.call(expectation, 'finalEnvelopeHash') && result.finalEnvelopeHash !== (expectation.finalEnvelopeHash ?? null)) throw new Error('scene_working_set_final_envelope_mismatch')
      return result
    },
    saveLongformWorkflowSnapshot(input) {
      try { assertSceneMemoryJsonValue(input.payload, 'longform_workflow_snapshot_payload') } catch { throw new Error('longform_workflow_snapshot_invalid') }
      const createdAt = input.createdAt ?? Date.now()
      if (!input.snapshotId || !input.storyId || !input.projectId || !input.branchId || !input.runId || !input.workflowKey || !isSceneMemorySnapshotStatus(input.status) || !Number.isInteger(input.validityEpoch) || input.validityEpoch < 1 || !Number.isInteger(input.storyRevision) || input.storyRevision < 0 || !Number.isInteger(input.workflowRevision) || input.workflowRevision < 0 || !Number.isFinite(createdAt) || !SCENE_MEMORY_HASH.test(input.payloadHash) || sceneMemoryStableHash(input.payload) !== input.payloadHash) throw new Error('longform_workflow_snapshot_invalid')
      const d = requireDb()
      assertSceneMemorySnapshotAuthority(d, input)
      const now = createdAt
      withImmediateTransaction(() => {
        const existing = d.prepare('SELECT payload_hash, payload_json FROM longform_workflow_snapshots WHERE run_id=? AND workflow_key=? AND workflow_revision=?').get(input.runId, input.workflowKey, input.workflowRevision) as { payload_hash?: string; payload_json?: string } | undefined
        if (existing && existing.payload_hash !== input.payloadHash) throw new Error('longform_workflow_snapshot_conflict')
        if (existing) return
        d.prepare(`INSERT INTO longform_workflow_snapshots (snapshot_id,story_id,project_id,branch_id,validity_epoch,story_revision,run_id,workflow_key,workflow_revision,status,payload_json,payload_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.snapshotId, input.storyId, input.projectId, input.branchId, input.validityEpoch, input.storyRevision, input.runId, input.workflowKey, input.workflowRevision, input.status, stableSceneMemoryJson(input.payload), input.payloadHash, now, now)
      })
    },
    getLongformWorkflowSnapshot(runId, workflowKey, workflowRevision) {
      const row = workflowRevision === undefined
        ? requireDb().prepare('SELECT * FROM longform_workflow_snapshots WHERE run_id=? AND workflow_key=? ORDER BY workflow_revision DESC LIMIT 1').get(runId, workflowKey) as { [key: string]: unknown } | undefined
        : requireDb().prepare('SELECT * FROM longform_workflow_snapshots WHERE run_id=? AND workflow_key=? AND workflow_revision=?').get(runId, workflowKey, workflowRevision) as { [key: string]: unknown } | undefined
      if (!row) return null
      if (row.status === 'stale' || row.status === 'retracted') return null
      const snapshotId = row.snapshot_id
      const storyId = row.story_id
      const projectId = row.project_id
      const branchId = row.branch_id
      const storedRunId = row.run_id
      const storedWorkflowKey = row.workflow_key
      const status = row.status
      const validityEpoch = Number(row.validity_epoch)
      const storyRevision = Number(row.story_revision)
      const storedWorkflowRevision = Number(row.workflow_revision)
      const createdAt = Number(row.created_at)
      const updatedAt = Number(row.updated_at)
      const payloadHash = row.payload_hash
      if (typeof snapshotId !== 'string' || !snapshotId || typeof storyId !== 'string' || !storyId || typeof projectId !== 'string' || !projectId || typeof branchId !== 'string' || !branchId || typeof storedRunId !== 'string' || !storedRunId || storedRunId !== runId || typeof storedWorkflowKey !== 'string' || !storedWorkflowKey || storedWorkflowKey !== workflowKey || !isSceneMemorySnapshotStatus(status) || !Number.isInteger(validityEpoch) || validityEpoch < 1 || !Number.isInteger(storyRevision) || storyRevision < 0 || !Number.isInteger(storedWorkflowRevision) || storedWorkflowRevision < 0 || workflowRevision !== undefined && storedWorkflowRevision !== workflowRevision || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || typeof payloadHash !== 'string' || !SCENE_MEMORY_HASH.test(payloadHash)) throw new Error('longform_workflow_snapshot_corrupt')
      assertSceneMemorySnapshotAuthority(requireDb(), { runId: storedRunId, storyId, projectId, branchId, validityEpoch, storyRevision })
      const payload = parseStrictSceneMemoryJson(row.payload_json, 'longform_workflow_snapshot_payload')
      if (sceneMemoryStableHash(payload) !== payloadHash) throw new Error('longform_workflow_snapshot_hash_mismatch')
      return { snapshotId, storyId, projectId, branchId, validityEpoch, storyRevision, runId: storedRunId, workflowKey: storedWorkflowKey, workflowRevision: storedWorkflowRevision, status, payload, payloadHash, createdAt, updatedAt }
    },
    listLongformWorkflowSnapshots(workflowKey) {
      if (typeof workflowKey !== 'string' || workflowKey.length === 0) throw new Error('longform_workflow_snapshot_corrupt')
      const rows = requireDb().prepare('SELECT run_id, workflow_revision FROM longform_workflow_snapshots WHERE workflow_key=? ORDER BY workflow_revision DESC, updated_at DESC').all(workflowKey) as Array<{ run_id?: unknown; workflow_revision?: unknown }>
      const result: Array<ReturnType<NonNullable<Repository['getLongformWorkflowSnapshot']>>> = []
      for (const row of rows) {
        if (typeof row.run_id !== 'string' || !Number.isInteger(Number(row.workflow_revision))) throw new Error('longform_workflow_snapshot_corrupt')
        const item = this.getLongformWorkflowSnapshot(row.run_id, workflowKey, Number(row.workflow_revision))
        if (item) result.push(item)
      }
      return result as Array<{ snapshotId: string; storyId: string; projectId: string; branchId: string; validityEpoch: number; storyRevision: number; runId: string; workflowKey: string; workflowRevision: number; status: SceneMemoryWorkflowSnapshotStatus; payload: unknown; payloadHash: string; createdAt: number; updatedAt: number }>
    },
    startSceneMemoryBackfill(state) {
      assertSceneMemoryBackfillState(state)
      const d = requireDb()
      withImmediateTransaction(() => {
        const existing = d.prepare('SELECT input_snapshot_hash, processed_count, processed_ids_json, status, story_id, project_id, branch_id, validity_epoch, story_revision, scene_id FROM scene_memory_backfills WHERE backfill_id=?').get(state.backfillId) as { input_snapshot_hash?: string; processed_count?: number; processed_ids_json?: string; status?: string; story_id?: string | null; project_id?: string | null; branch_id?: string | null; validity_epoch?: number | null; story_revision?: number | null; scene_id?: string | null } | undefined
        if (existing) {
          if (existing.input_snapshot_hash !== state.inputSnapshotHash) throw new Error('scene_memory_backfill_identity_conflict')
          if ((existing.story_id ?? null) !== state.storyId || (existing.project_id ?? null) !== state.projectId || (existing.branch_id ?? null) !== state.branchId || (existing.validity_epoch ?? null) !== state.validityEpoch || (existing.story_revision ?? null) !== state.storyRevision || (existing.scene_id ?? null) !== state.sceneId) throw new Error('scene_memory_backfill_authority_conflict')
          return
        }
        d.prepare(`INSERT INTO scene_memory_backfills (backfill_id,story_id,project_id,branch_id,validity_epoch,story_revision,scene_id,input_snapshot_hash,cursor,processed_ids_json,total_count,processed_count,status,error_code,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(state.backfillId, state.storyId, state.projectId, state.branchId, state.validityEpoch, state.storyRevision, state.sceneId, state.inputSnapshotHash, state.cursor, stableSceneMemoryJson(state.processedIds), state.totalCount, state.processedCount, state.status, state.errorCode, state.createdAt, state.updatedAt, state.completedAt)
      })
    },
    getSceneMemoryBackfill(backfillId) {
      const row = requireDb().prepare('SELECT * FROM scene_memory_backfills WHERE backfill_id=?').get(backfillId) as { [key: string]: unknown } | undefined
      if (!row) return null
      try {
        const processedIds = parseStrictSceneMemoryJson(row.processed_ids_json, 'scene_memory_backfill_processed_ids')
        if (!Array.isArray(processedIds)) throw new Error('bad ids')
        const state: SceneMemoryBackfillState = { backfillId: String(row.backfill_id), storyId: row.story_id === null || row.story_id === undefined ? null : String(row.story_id), projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id), branchId: row.branch_id === null || row.branch_id === undefined ? null : String(row.branch_id), validityEpoch: row.validity_epoch === null || row.validity_epoch === undefined ? null : Number(row.validity_epoch), storyRevision: row.story_revision === null || row.story_revision === undefined ? null : Number(row.story_revision), sceneId: row.scene_id === null || row.scene_id === undefined ? null : String(row.scene_id), inputSnapshotHash: String(row.input_snapshot_hash), cursor: row.cursor === null || row.cursor === undefined ? null : String(row.cursor), processedIds: processedIds as string[], totalCount: Number(row.total_count), processedCount: Number(row.processed_count), status: String(row.status) as SceneMemoryBackfillState['status'], errorCode: row.error_code === null || row.error_code === undefined ? null : String(row.error_code), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), completedAt: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at) }
        assertSceneMemoryBackfillState(state)
        return state
      } catch { throw new Error('scene_memory_backfill_corrupt') }
    },
    saveSceneMemoryBackfillStep(input) {
      const state = input.state
      assertSceneMemoryBackfillState(state, Boolean(input.projection))
      if (state.status === 'legacy_unverified' && input.projection) throw new Error('scene_memory_legacy_projection_forbidden')
      if (input.projection) {
        const card = input.projection.card
        if (card.storyId !== state.storyId || card.projectId !== state.projectId || card.branchId !== state.branchId || card.validityEpoch !== state.validityEpoch || card.storyRevision !== state.storyRevision || card.sceneId !== state.sceneId) throw new Error('scene_memory_backfill_projection_authority_mismatch')
      }
      withImmediateTransaction(() => {
        const d = requireDb()
        const existing = d.prepare('SELECT * FROM scene_memory_backfills WHERE backfill_id=?').get(state.backfillId) as { input_snapshot_hash?: string; processed_count?: number; processed_ids_json?: string; status?: string; story_id?: string | null; project_id?: string | null; branch_id?: string | null; validity_epoch?: number | null; story_revision?: number | null; scene_id?: string | null } | undefined
        if (!existing) throw new Error('scene_memory_backfill_missing')
        if (existing.input_snapshot_hash !== state.inputSnapshotHash) throw new Error('scene_memory_backfill_identity_conflict')
        if ((existing.story_id ?? null) !== state.storyId || (existing.project_id ?? null) !== state.projectId || (existing.branch_id ?? null) !== state.branchId) throw new Error('scene_memory_backfill_scope_conflict')
        const existingAuthority = { validityEpoch: existing.validity_epoch ?? null, storyRevision: existing.story_revision ?? null, sceneId: existing.scene_id ?? null }
        if ((existingAuthority.validityEpoch !== null || existingAuthority.storyRevision !== null || existingAuthority.sceneId !== null) && (existingAuthority.validityEpoch !== state.validityEpoch || existingAuthority.storyRevision !== state.storyRevision || existingAuthority.sceneId !== state.sceneId)) throw new Error('scene_memory_backfill_authority_conflict')
        if (existing.status === 'complete' || existing.status === 'failed' || existing.status === 'legacy_unverified') throw new Error('scene_memory_backfill_terminal')
        const previousValue = parseStrictSceneMemoryJson(existing.processed_ids_json ?? '[]', 'scene_memory_backfill_processed_ids')
        if (!Array.isArray(previousValue) || previousValue.some((id) => typeof id !== 'string' || id.length === 0) || new Set(previousValue).size !== previousValue.length) throw new Error('scene_memory_backfill_corrupt')
        const previous = previousValue as string[]
        if (Number(state.processedCount) < Number(existing.processed_count ?? 0) || previous.some((id) => !state.processedIds.includes(id))) throw new Error('scene_memory_backfill_progress_regressed')
        if (input.projection) persistSceneMemoryCard(d, input.projection)
        d.prepare(`UPDATE scene_memory_backfills SET story_id=?,project_id=?,branch_id=?,validity_epoch=?,story_revision=?,scene_id=?,cursor=?,processed_ids_json=?,total_count=?,processed_count=?,status=?,error_code=?,updated_at=?,completed_at=? WHERE backfill_id=?`).run(state.storyId, state.projectId, state.branchId, state.validityEpoch, state.storyRevision, state.sceneId, state.cursor, stableSceneMemoryJson(state.processedIds), state.totalCount, state.processedCount, state.status, state.errorCode, state.updatedAt, state.completedAt, state.backfillId)
      })
    },
    replaySceneMemoryBackfill(input) {
      if (!input || typeof input.backfillId !== 'string' || input.backfillId.length === 0 || input.resume !== undefined && typeof input.resume !== 'boolean' || input.now !== undefined && !Number.isFinite(input.now)) throw new Error('scene_memory_backfill_replay_input_invalid')
      let state = this.getSceneMemoryBackfill(input.backfillId)
      if (!state) throw new Error('scene_memory_backfill_missing')
      const resumable = state.status === 'in_progress' || state.status === 'paused'
      let resumed = false
      if (input.resume === true && resumable) {
        const now = input.now ?? Date.now()
        withImmediateTransaction(() => {
          const d = requireDb()
          const updated = d.prepare("UPDATE scene_memory_backfills SET status='in_progress', updated_at=? WHERE backfill_id=? AND status='paused'").run(now, input.backfillId) as { changes?: number }
          resumed = Number(updated.changes ?? 0) === 1
        })
        state = this.getSceneMemoryBackfill(input.backfillId)
        if (!state) throw new Error('scene_memory_backfill_missing')
      }
      return { state, resumed, projectionPublished: false }
    },
    pauseSceneMemoryBackfill(backfillId) {
      const result = requireDb().prepare("UPDATE scene_memory_backfills SET status='paused', updated_at=? WHERE backfill_id=? AND status IN ('pending','in_progress','paused')").run(Date.now(), backfillId) as { changes?: number }
      if (Number(result.changes ?? 0) !== 1) throw new Error('scene_memory_backfill_missing_or_terminal')
    },
    getNarrativeCommits(runId, sceneId) {
      const d = requireDb()
      const rows = sceneId
        ? d.prepare('SELECT * FROM narrative_commits WHERE run_id = ? AND scene_id = ? ORDER BY revision ASC, committed_at ASC').all(runId, sceneId) as unknown as NarrativeCommitRow[]
        : d.prepare('SELECT * FROM narrative_commits WHERE run_id = ? ORDER BY revision ASC, scene_id ASC, committed_at ASC').all(runId) as unknown as NarrativeCommitRow[]
      return rows.map(narrativeCommitFromRow)
    },
    getNarrativeLedger(runId, sceneId) {
      const d = requireDb()
      const scopeRun = d.prepare('SELECT * FROM story_ledger_runs WHERE run_id=?').get(runId) as StoryLedgerRunRow | undefined
      if (scopeRun) {
        const scope = { schemaVersion: 1 as const, storyId: scopeRun.story_id, projectId: scopeRun.project_id, branchId: scopeRun.branch_id }
        const head = d.prepare('SELECT * FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as StoryLedgerHeadRow | undefined
        if (!head || scopeRun.current_revision > head.high_watermark) throw new Error('story_ledger_scope_corrupt')
        const runMeta = d.prepare('SELECT status, error_code FROM runs WHERE run_id=?').get(runId) as { status?: string; error_code?: string | null } | undefined
        const runEpoch = Number(scopeRun.validity_epoch ?? 1)
        const headEpoch = Number(head.validity_epoch ?? 1)
        const epochValid = runEpoch === headEpoch
        const activeStatuses = new Set(['queued', 'running', 'recoverable', 'cancelling', 'cancel_requested', 'recovery_required', 'waiting_user'])
        if (!epochValid && (activeStatuses.has(runMeta?.status ?? '') || runMeta?.error_code === 'story_ledger_epoch_invalidated')) throw new Error('story_ledger_epoch_invalidated')
        // Terminal historical runs remain inspectable, but their context must
        // resolve against the current authoritative projection after a
        // retraction rather than exposing a stale pre-tombstone cursor.
        const throughRevision = epochValid ? scopeRun.current_revision : head.high_watermark
        const entries = readStoryLedger(d, scope, throughRevision)
        return sceneId ? entries.filter((entry) => entry.sceneId === sceneId) : entries
      }
      const commitRows = sceneId
        ? d.prepare('SELECT * FROM narrative_commits WHERE run_id = ? AND scene_id = ?').all(runId, sceneId) as unknown as NarrativeCommitRow[]
        : d.prepare('SELECT * FROM narrative_commits WHERE run_id = ? ORDER BY revision ASC, scene_id ASC, committed_at ASC').all(runId) as unknown as NarrativeCommitRow[]
      const out: NarrativeLedgerEntry[] = []
      for (const commitRow of commitRows) {
        const commit = narrativeCommitFromRow(commitRow)
        const rows = d.prepare('SELECT * FROM narrative_ledger WHERE run_id = ? AND scene_id = ? ORDER BY change_revision ASC, change_id ASC').all(runId, commitRow.scene_id) as unknown as NarrativeLedgerRow[]
        if (rows.length !== commit.stateDelta.changes.length) throw new Error('narrative_ledger_incomplete')
        for (const row of rows) {
          if (row.delta_hash !== commit.deltaHash || row.accepted_segment_id !== commit.acceptedSegmentId || row.accepted_content_hash !== commit.acceptedContentHash || row.contract_hash !== commit.contractHash) throw new Error('narrative_ledger_binding_mismatch')
          out.push(narrativeLedgerFromRow(row, commit.stateDelta))
        }
      }
      return out
    },
    getNarrativeLedgerScope(runId) {
      const d = requireDb()
      const run = d.prepare('SELECT * FROM story_ledger_runs WHERE run_id=?').get(runId) as StoryLedgerRunRow | undefined
      if (!run) return null
      const head = d.prepare('SELECT * FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(run.story_id, run.project_id, run.branch_id) as StoryLedgerHeadRow | undefined
      if (!head || run.current_revision > head.high_watermark) throw new Error('story_ledger_scope_corrupt')
      const validityEpoch = Number(run.validity_epoch ?? 1)
      const headValidityEpoch = Number(head.validity_epoch ?? 1)
      return narrativeLedgerScopeInfo({ schemaVersion: 1, storyId: run.story_id, projectId: run.project_id, branchId: run.branch_id }, {
        parentRevision: run.parent_revision,
        parentBranchId: run.parent_branch_id,
        currentRevision: run.current_revision,
        // The run cursor may intentionally lag a branch opened concurrently.
        // Expose the durable head separately so manifests reveal drift and a
        // later write can fail closed instead of silently merging.
        highWatermark: head.high_watermark,
        validityEpoch,
        headValidityEpoch,
        epochValid: validityEpoch === headValidityEpoch
      })
    },
    getStoryLedgerFreshness(runId) {
      return readStoryLedgerFreshness(requireDb(), runId)
    },
    assertStoryLedgerFresh(input) {
      return assertStoryLedgerFreshness(requireDb(), input)
    },
    prepareStoryLedgerRebase(runId, branchId) {
      const d = requireDb()
      const run = d.prepare('SELECT * FROM story_ledger_runs WHERE run_id=?').get(runId) as StoryLedgerRunRow | undefined
      if (!run) throw new Error('run_not_found')
      const runMeta = d.prepare('SELECT session_id FROM runs WHERE run_id=?').get(runId) as { session_id?: string } | undefined
      const head = d.prepare('SELECT * FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(run.story_id, run.project_id, run.branch_id) as StoryLedgerHeadRow | undefined
      if (!head) throw new Error('story_ledger_scope_missing')
      const safeBranchId = branchId ?? `rebase_${createHash('sha256').update(`${runId}\u0000${run.story_id}\u0000${run.project_id}\u0000${run.branch_id}\u0000${head.high_watermark}\u0000${head.head_hash ?? ''}`, 'utf8').digest('hex').slice(0, 24)}`
      const candidate = { schemaVersion: 1 as const, storyId: run.story_id, projectId: run.project_id, branchId: safeBranchId }
      validateNarrativeLedgerScope(candidate)
      if (safeBranchId === run.branch_id) throw new Error('story_ledger_rebase_branch_invalid')
      const existing = d.prepare('SELECT parent_branch_id, parent_revision FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(run.story_id, run.project_id, safeBranchId) as { parent_branch_id?: string | null; parent_revision?: number } | undefined
      if (existing && (existing.parent_branch_id !== run.branch_id || Number(existing.parent_revision ?? -1) !== head.high_watermark)) throw new Error('story_ledger_rebase_branch_identity_mismatch')
      return {
        storyScope: { ...candidate, parentBranchId: run.branch_id, parentRevision: head.high_watermark },
        sessionId: runMeta?.session_id ?? runId,
        sourceRevision: head.high_watermark,
        sourceEpoch: Number(head.validity_epoch ?? 1)
      }
    },
    getNarrativeLedgerByScope(scope, throughRevision) {
      return readStoryLedger(requireDb(), scope, throughRevision)
    },
    getStoryLedgerScope(runId) {
      return this.getNarrativeLedgerScope(runId)
    },
    getStoryLedger(scope, throughRevision) {
      return this.getNarrativeLedgerByScope(scope, throughRevision)
    },
    upsertNarrativeFact(fact) {
      const d = requireDb()
      const candidate = validateNarrativeFact(fact)
      let result: NarrativeFact = candidate
      withImmediateTransaction(() => {
        const latestRow = d.prepare('SELECT * FROM narrative_facts WHERE fact_id = ? AND session_id = ? ORDER BY version DESC LIMIT 1').get(candidate.factId, candidate.sessionId) as NarrativeFactRow | undefined
        if (latestRow) {
          const latest = narrativeFactFromRow(latestRow)
          const sameMeaning = stableNarrativeJson({
            factId: latest.factId,
            sessionId: latest.sessionId,
            canonicalStatement: latest.canonicalStatement,
            canonicalHash: latest.canonicalHash,
            aliases: latest.aliases,
            entities: latest.entities,
            sourceSlotIds: latest.sourceSlotIds,
            sources: latest.sources,
            validFrom: latest.validFrom,
            validUntil: latest.validUntil,
            confidence: latest.confidence,
            status: latest.status,
            visibility: latest.visibility,
            knowers: latest.knowers,
            provenanceHash: latest.provenanceHash
          }) === stableNarrativeJson({
            factId: candidate.factId,
            sessionId: candidate.sessionId,
            canonicalStatement: candidate.canonicalStatement,
            canonicalHash: candidate.canonicalHash,
            aliases: candidate.aliases,
            entities: candidate.entities,
            sourceSlotIds: candidate.sourceSlotIds,
            sources: candidate.sources,
            validFrom: candidate.validFrom,
            validUntil: candidate.validUntil,
            confidence: candidate.confidence,
            status: candidate.status,
            visibility: candidate.visibility,
            knowers: candidate.knowers,
            provenanceHash: candidate.provenanceHash
          })
          if (sameMeaning) {
            result = latest
            return
          }
          const nextVersion = latest.version + 1
          const nextBase: Omit<NarrativeFact, 'provenanceHash' | 'createdAt' | 'updatedAt'> = { ...candidate, version: nextVersion }
          const now = Math.max(candidate.updatedAt, Date.now())
          result = validateNarrativeFact({ ...nextBase, provenanceHash: narrativeFactProvenanceHash(nextBase), createdAt: latest.createdAt, updatedAt: now })
          d.prepare("UPDATE narrative_facts SET status='superseded',updated_at=? WHERE fact_id=? AND session_id=? AND version=? AND status IN ('active','pending_review')").run(now, candidate.factId, candidate.sessionId, latest.version)
        } else {
          const base: Omit<NarrativeFact, 'provenanceHash' | 'createdAt' | 'updatedAt'> = { ...candidate, version: 1 }
          result = validateNarrativeFact({ ...base, provenanceHash: narrativeFactProvenanceHash(base), createdAt: candidate.createdAt, updatedAt: candidate.updatedAt })
        }
        const row = result
        d.prepare(`INSERT INTO narrative_facts (
          fact_id,version,session_id,run_id,canonical_statement,canonical_hash,
          aliases_json,entities_json,source_slot_ids_json,sources_json,valid_from,
          valid_until,confidence,status,visibility,knowers_json,provenance_hash,
          created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          row.factId, row.version, row.sessionId, row.runId, row.canonicalStatement, row.canonicalHash,
          JSON.stringify(row.aliases), JSON.stringify(row.entities), JSON.stringify(row.sourceSlotIds), JSON.stringify(row.sources), JSON.stringify(row.validFrom),
          JSON.stringify(row.validUntil), row.confidence, row.status, row.visibility, JSON.stringify(row.knowers), row.provenanceHash,
          row.createdAt, row.updatedAt
        )
      })
      return result
    },
    getNarrativeFact(factId, version) {
      const d = requireDb()
      const row = version === undefined
        ? d.prepare('SELECT * FROM narrative_facts WHERE fact_id = ? ORDER BY version DESC LIMIT 1').get(factId) as NarrativeFactRow | undefined
        : d.prepare('SELECT * FROM narrative_facts WHERE fact_id = ? AND version = ?').get(factId, version) as NarrativeFactRow | undefined
      return row ? narrativeFactFromRow(row) : null
    },
    getNarrativeFacts(sessionId, includeInactive = false) {
      const d = requireDb()
      const rows = d.prepare('SELECT * FROM narrative_facts WHERE session_id = ? ORDER BY fact_id ASC, version DESC').all(sessionId) as unknown as NarrativeFactRow[]
      const latest = new Map<string, NarrativeFact>()
      for (const row of rows) {
        if (latest.has(row.fact_id)) continue
        const fact = narrativeFactFromRow(row)
        if (!includeInactive && (fact.status === 'superseded' || fact.status === 'retracted')) continue
        latest.set(fact.factId, fact)
      }
      return [...latest.values()].sort((a, b) => a.factId.localeCompare(b.factId))
    },
    resolveNarrativeFactReference(reference) {
      const ref = validateNarrativeFactReference(reference)
      const row = requireDb().prepare('SELECT * FROM narrative_facts WHERE fact_id = ? AND version = ?').get(ref.factId, ref.version) as NarrativeFactRow | undefined
      if (!row) return null
      const fact = narrativeFactFromRow(row)
      return factReferenceMatches(fact, ref) ? fact : null
    },
    getManuscriptBackfill(runId) {
      const row = requireDb().prepare('SELECT * FROM manuscript_backfills WHERE run_id = ?').get(runId) as {
        run_id: string
        schema_version: number
        status: LegacyManuscriptBackfillState['status']
        verification: LegacyManuscriptBackfillState['verification']
        source_turns_json: string
        source_summary_hash: string
        expected_source_count: number
        expected_segment_count: number
        expected_accepted_char_count: number
        expected_accepted_content_hash: string | null
        expected_artifact_id: string | null
        expected_artifact_hash: string | null
        expected_artifact_char_count: number | null
        processed_source_turn_ids_json: string
        accepted_segment_ids_json: string
        completion_marker: string | null
        created_at: number
        updated_at: number
        completed_at: number | null
      } | undefined
      if (!row) return null
      let sourceTurns: LegacyManuscriptBackfillState['sourceTurns']
      let processedSourceTurnIds: string[]
      let acceptedSegmentIds: string[]
      try {
        sourceTurns = JSON.parse(row.source_turns_json) as LegacyManuscriptBackfillState['sourceTurns']
        processedSourceTurnIds = JSON.parse(row.processed_source_turn_ids_json) as string[]
        acceptedSegmentIds = JSON.parse(row.accepted_segment_ids_json) as string[]
      } catch {
        throw new Error('manuscript_backfill_corrupt')
      }
      if (!Array.isArray(sourceTurns) || !Array.isArray(processedSourceTurnIds) || !Array.isArray(acceptedSegmentIds) ||
        sourceTurns.some((source) => !source || typeof source.sourceTurnId !== 'string' || typeof source.sourceTurnSeq !== 'number' || typeof source.sourceContentHash !== 'string' || typeof source.sourceCharCount !== 'number') ||
        processedSourceTurnIds.some((id) => typeof id !== 'string') || acceptedSegmentIds.some((id) => typeof id !== 'string') ||
        row.schema_version !== 1 || legacyBackfillSourceSummaryHash(sourceTurns) !== row.source_summary_hash) {
        throw new Error('manuscript_backfill_corrupt')
      }
      const state: LegacyManuscriptBackfillState = {
        schemaVersion: 1,
        runId: row.run_id,
        status: row.status,
        verification: row.verification,
        sourceTurns,
        sourceSummaryHash: row.source_summary_hash,
        expectedSourceCount: row.expected_source_count,
        expectedSegmentCount: row.expected_segment_count,
        expectedAcceptedCharCount: row.expected_accepted_char_count,
        expectedAcceptedContentHash: row.expected_accepted_content_hash,
        expectedArtifactId: row.expected_artifact_id,
        expectedArtifactHash: row.expected_artifact_hash,
        expectedArtifactCharCount: row.expected_artifact_char_count,
        processedSourceTurnIds,
        acceptedSegmentIds,
        completionMarker: row.completion_marker,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at
      }
      if (state.completionMarker && legacyBackfillCompletionMarker(state) !== state.completionMarker) throw new Error('manuscript_backfill_corrupt')
      const segmentRows = requireDb().prepare(`SELECT segment_id, run_id, source_turn_id, status, kind
        FROM manuscript_segments WHERE run_id = ?`).all(row.run_id) as Array<{
          segment_id: string
          run_id: string
          source_turn_id: string | null
          status: string
          kind: string
        }>
      validateLegacyBackfillState(state, segmentRows.map((segment) => ({
        segmentId: segment.segment_id,
        runId: segment.run_id,
        sourceTurnId: segment.source_turn_id,
        status: segment.status,
        kind: segment.kind
      })))
      return state
    },
    saveManuscriptBackfillStep(state, segment, hooks) {
      try { validateLegacyBackfillState(state) } catch { throw new Error('manuscript_backfill_invalid_state') }
      if (legacyBackfillSourceSummaryHash(state.sourceTurns) !== state.sourceSummaryHash) throw new Error('manuscript_backfill_invalid_state')
      if (state.completionMarker && legacyBackfillCompletionMarker(state) !== state.completionMarker) throw new Error('manuscript_backfill_invalid_marker')
      const d = requireDb()
      this.tx(() => {
        const existing = d.prepare('SELECT * FROM manuscript_backfills WHERE run_id = ?').get(state.runId) as { source_turns_json: string; source_summary_hash: string; expected_source_count: number; expected_segment_count: number; processed_source_turn_ids_json: string; accepted_segment_ids_json: string; status: string } | undefined
        if (existing) {
          if (existing.source_turns_json !== JSON.stringify(state.sourceTurns) || existing.source_summary_hash !== state.sourceSummaryHash || existing.expected_source_count !== state.expectedSourceCount || existing.expected_segment_count !== state.expectedSegmentCount) {
            throw new Error('manuscript_backfill_identity_mismatch')
          }
          let oldProcessed: string[]
          let oldAccepted: string[]
          try {
            oldProcessed = JSON.parse(existing.processed_source_turn_ids_json) as string[]
            oldAccepted = JSON.parse(existing.accepted_segment_ids_json) as string[]
          } catch {
            throw new Error('manuscript_backfill_corrupt')
          }
          const nextProcessed = new Set(state.processedSourceTurnIds)
          const nextAccepted = new Set(state.acceptedSegmentIds)
          if (oldProcessed.some((id) => !nextProcessed.has(id)) || oldAccepted.some((id) => !nextAccepted.has(id))) throw new Error('manuscript_backfill_progress_regressed')
        } else {
          d.prepare(`INSERT INTO manuscript_backfills (
            run_id, schema_version, status, verification, source_turns_json, source_summary_hash,
            expected_source_count, expected_segment_count, expected_accepted_char_count, expected_accepted_content_hash,
            expected_artifact_id, expected_artifact_hash, expected_artifact_char_count,
            processed_source_turn_ids_json, accepted_segment_ids_json, completion_marker,
            created_at, updated_at, completed_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            state.runId,
            state.schemaVersion,
            state.status,
            state.verification,
            JSON.stringify(state.sourceTurns),
            state.sourceSummaryHash,
            state.expectedSourceCount,
            state.expectedSegmentCount,
            state.expectedAcceptedCharCount,
            state.expectedAcceptedContentHash,
            state.expectedArtifactId,
            state.expectedArtifactHash,
            state.expectedArtifactCharCount,
            JSON.stringify(state.processedSourceTurnIds),
            JSON.stringify(state.acceptedSegmentIds),
            state.completionMarker,
            state.createdAt,
            state.updatedAt,
            state.completedAt
          )
        }
        if (segment) {
          const source = state.sourceTurns.find((item) => item.sourceTurnId === segment.source_turn_id)
          if (!source || !state.processedSourceTurnIds.includes(source.sourceTurnId)) throw new Error('manuscript_backfill_source_mismatch')
          if (segment.run_id !== state.runId || segment.content_hash !== manuscriptSegmentHash(segment.content) || segment.char_count !== codePointLength(segment.content)) {
            throw new Error('manuscript_backfill_segment_integrity_mismatch')
          }
          const existingSegment = d.prepare('SELECT * FROM manuscript_segments WHERE segment_id = ?').get(segment.segment_id) as ManuscriptSegmentRow | undefined
          const prefixCacheBefore = readAcceptedPrefixCache(d, state.runId)
          // Legacy lazy migration could have marked a punctuation-terminated
          // active turn as accepted before this backfill state existed.  The
          // migration is the one narrow place allowed to demote that stale
          // acceptance; ordinary save/accept paths keep accepted rows immutable.
          if (existingSegment?.status === 'accepted' && segment.status !== 'accepted') {
            if (state.verification === 'artifact_exact') throw new Error('manuscript_backfill_exact_segment_mismatch')
            d.prepare(`UPDATE manuscript_segments SET
              source_turn_id=?, section_id=?, scene_id=?, chunk_index=?, revision=?, status=?, kind=?, content=?,
              content_hash=?, char_count=?, supersedes_segment_id=?, updated_at=?, accepted_at=? WHERE segment_id=?`).run(
              segment.source_turn_id,
              segment.section_id,
              segment.scene_id,
              segment.chunk_index,
              segment.revision,
              segment.status,
              segment.kind,
              segment.content,
              segment.content_hash,
              segment.char_count,
              segment.supersedes_segment_id,
              segment.updated_at,
              segment.accepted_at,
              segment.segment_id
            )
            refreshAcceptedPrefixCache(d, state.runId, prefixCacheBefore, undefined)
          } else {
            this.saveManuscriptSegment(segment)
          }
          hooks?.afterSegmentWrite?.()
        }
        validatePartialGraphForRun(d, state.runId)
        const persistedSegments = d.prepare(`SELECT segment_id, run_id, source_turn_id, status, kind
          FROM manuscript_segments WHERE run_id = ?`).all(state.runId) as Array<{
            segment_id: string
            run_id: string
            source_turn_id: string | null
            status: string
          kind: string
        }>
        validateLegacyBackfillState(state, persistedSegments.map((item) => ({
          segmentId: item.segment_id,
          runId: item.run_id,
          sourceTurnId: item.source_turn_id,
          status: item.status,
          kind: item.kind
        })))
        d.prepare(`UPDATE manuscript_backfills SET
          schema_version=?, status=?, verification=?, source_turns_json=?, source_summary_hash=?,
          expected_source_count=?, expected_segment_count=?, expected_accepted_char_count=?, expected_accepted_content_hash=?,
          expected_artifact_id=?, expected_artifact_hash=?, expected_artifact_char_count=?,
          processed_source_turn_ids_json=?, accepted_segment_ids_json=?, completion_marker=?,
          updated_at=?, completed_at=? WHERE run_id=?`).run(
          state.schemaVersion,
          state.status,
          state.verification,
          JSON.stringify(state.sourceTurns),
          state.sourceSummaryHash,
          state.expectedSourceCount,
          state.expectedSegmentCount,
          state.expectedAcceptedCharCount,
          state.expectedAcceptedContentHash,
          state.expectedArtifactId,
          state.expectedArtifactHash,
          state.expectedArtifactCharCount,
          JSON.stringify(state.processedSourceTurnIds),
          JSON.stringify(state.acceptedSegmentIds),
          state.completionMarker,
          state.updatedAt,
          state.completedAt,
          state.runId
        )
      }, 'immediate')
    },
    /**
     * Compatibility helper for old migration fixtures only.  It is
     * deliberately not part of RunStorePort or the production kernel adapter;
     * all user-facing acceptance must use evidence-bound acceptManuscriptSegment.
     */
    acceptManuscriptSegmentsForTest(runId, segmentIds, acceptedAt) {
      if (segmentIds.length === 0) return
      const d = requireDb()
      const prefixCacheBefore = readAcceptedPrefixCache(d, runId)
      const uniqueIds = [...new Set(segmentIds)]
      if (uniqueIds.length === 0) return
      const placeholders = uniqueIds.map(() => '?').join(',')
      d.exec('BEGIN IMMEDIATE')
      try {
        const eligible = d.prepare(
          `SELECT * FROM manuscript_segments
           WHERE run_id = ? AND segment_id IN (${placeholders})`
        ).all(runId, ...uniqueIds) as unknown as Array<ManuscriptSegmentRow>
        if (eligible.length !== uniqueIds.length) throw new Error('manuscript_segment_acceptance_mismatch')
        const toAccept: string[] = []
        const chains = new Map<string, ManuscriptSegmentRow[]>()
        for (const row of eligible) {
          const classified = classifyAssistantOutput(row.content)
          const boundaryValid = classified.kind === 'prose' && classified.complete && classified.content === row.content &&
            row.content_hash === manuscriptSegmentHash(row.content) && row.char_count === codePointLength(row.content)
          if (row.status === 'accepted' && row.kind === 'prose') {
            if (!boundaryValid) throw new Error('manuscript_segment_boundary_mismatch')
            const chain = row.supersedes_segment_id ? loadSupersedesChain(d, row) : []
            assertNoActivePartialAncestor(d, chain)
            continue
          }
          if (row.status !== 'candidate' || row.kind !== 'prose') throw new Error(row.status === 'partial' ? 'manuscript_segment_incomplete' : 'manuscript_segment_acceptance_mismatch')
          if (!boundaryValid) throw new Error(classified.kind === 'prose' && !classified.complete ? 'manuscript_segment_incomplete' : 'manuscript_segment_boundary_mismatch')
          const chain = row.supersedes_segment_id ? loadSupersedesChain(d, row) : []
          if (chain.some((parent) => parent.status === 'candidate')) throw new Error('manuscript_partial_candidate_ancestor')
          chains.set(row.segment_id, chain)
          toAccept.push(row.segment_id)
        }
        if (toAccept.length > 0) {
          // Replace the carried partial only after every candidate in the
          // batch has passed validation.  This keeps the candidate/partial
          // boundary atomic and leaves a rejected candidate recoverable.
          for (const segmentId of toAccept) {
            supersedePartialAncestors(d, chains.get(segmentId) ?? [], acceptedAt)
          }
          const acceptedPlaceholders = toAccept.map(() => '?').join(',')
          d.prepare(
            `UPDATE manuscript_segments SET status='accepted', accepted_at=?, updated_at=?
             WHERE run_id = ? AND segment_id IN (${acceptedPlaceholders}) AND status='candidate' AND kind='prose'`
          ).run(acceptedAt, acceptedAt, runId, ...toAccept)
        }
        validatePartialGraphForRun(d, runId)
        for (const segmentId of toAccept) assertNoActivePartialAncestor(d, chains.get(segmentId) ?? [])
        if (toAccept.length > 0) refreshAcceptedPrefixCache(d, runId, prefixCacheBefore, undefined)
        d.exec('COMMIT')
      } catch (error) {
        d.exec('ROLLBACK')
        throw error
      }
    },
    acceptManuscriptSegment(input: ManuscriptAcceptanceInput) {
      if (!input.runId || !input.segmentId || !input.expectedContentHash || !Number.isInteger(input.expectedCharCount) || input.expectedCharCount < 0 ||
        !Number.isInteger(input.evidenceRevision) || input.evidenceRevision < 1 || !input.evidenceIdentity || !Number.isFinite(input.acceptedAt) ||
        (input.sceneId !== null && typeof input.sceneId !== 'string') ||
        (input.supersedesAcceptedSegmentId !== undefined && (!input.supersedesAcceptedSegmentId || typeof input.supersedesAcceptedSegmentId !== 'string'))) {
        throw new Error('manuscript_acceptance_input_invalid')
      }
      const d = requireDb()
      const nested = transactionDepth > 0
      if (!nested) {
        d.exec('BEGIN IMMEDIATE')
        transactionDepth = 1
      }
      try {
        const row = d.prepare('SELECT * FROM manuscript_segments WHERE run_id = ? AND segment_id = ?').get(input.runId, input.segmentId) as ManuscriptSegmentRow | undefined
        if (!row) throw new Error('manuscript_segment_acceptance_mismatch')
        const rawEvidence = d.prepare("SELECT json FROM run_evidence WHERE run_id = ? AND kind = 'manuscript_acceptance_ready'").get(input.runId) as { json: string } | undefined
        if (!rawEvidence) throw new Error('manuscript_acceptance_evidence_missing')
        let evidence: {
          schemaVersion?: number
          runId?: string
          segmentId?: string
          candidateHash?: string
          candidateCharCount?: number
          evidenceRevision?: number
          evidenceIdentity?: string
          sceneId?: string | null
          supersedesAcceptedSegmentId?: string
          evidenceRefs?: Record<string, string | null>
        }
        try {
          evidence = JSON.parse(rawEvidence.json) as typeof evidence
        } catch {
          throw new Error('manuscript_acceptance_evidence_corrupt')
        }
        const refs = evidence.evidenceRefs
        const refsValid = Boolean(refs) && typeof refs === 'object' && !Array.isArray(refs) && Object.entries(refs ?? {}).every(([kind, hash]) => kind.length > 0 && (hash === null || typeof hash === 'string'))
        if (evidence.schemaVersion !== 1 || evidence.runId !== input.runId || evidence.segmentId !== input.segmentId || evidence.candidateHash !== input.expectedContentHash ||
          evidence.candidateCharCount !== input.expectedCharCount || evidence.evidenceRevision !== input.evidenceRevision || evidence.evidenceIdentity !== input.evidenceIdentity ||
          (evidence.sceneId ?? null) !== input.sceneId || (evidence.supersedesAcceptedSegmentId ?? undefined) !== input.supersedesAcceptedSegmentId || !refsValid) {
          throw new Error('manuscript_acceptance_evidence_mismatch')
        }
        const evidenceIdentity = manuscriptAcceptanceEvidenceIdentity({
          runId: input.runId,
          segmentId: input.segmentId,
          candidateHash: input.expectedContentHash,
          candidateCharCount: input.expectedCharCount,
          evidenceRevision: input.evidenceRevision,
          sceneId: input.sceneId,
          supersedesAcceptedSegmentId: input.supersedesAcceptedSegmentId,
          evidenceRefs: refs ?? {}
        })
        if (evidenceIdentity !== input.evidenceIdentity) throw new Error('manuscript_acceptance_evidence_mismatch')
        for (const [kind, expectedHash] of Object.entries(refs ?? {})) {
          const current = d.prepare('SELECT json FROM run_evidence WHERE run_id = ? AND kind = ?').get(input.runId, kind) as { json: string } | undefined
          const actualHash = current ? manuscriptSegmentHash(current.json) : null
          if (actualHash !== expectedHash) throw new Error('manuscript_acceptance_evidence_stale')
          if (current && !manuscriptAcceptanceEvidenceMatches({ kind, json: current.json, segmentId: input.segmentId, contentHash: input.expectedContentHash })) {
            throw new Error('manuscript_acceptance_evidence_unbound')
          }
        }
        const classified = classifyAssistantOutput(row.content)
        const boundaryValid = row.kind === 'prose' && classified.kind === 'prose' && classified.complete && classified.content === row.content &&
          row.content_hash === manuscriptSegmentHash(row.content) && row.char_count === codePointLength(row.content) && row.content_hash === input.expectedContentHash &&
          row.char_count === input.expectedCharCount && (row.scene_id ?? null) === input.sceneId
        if (!boundaryValid) throw new Error('manuscript_segment_boundary_mismatch')
        const chain = row.supersedes_segment_id ? loadSupersedesChain(d, row) : []
        if (row.status === 'accepted') {
          if (input.supersedesAcceptedSegmentId) throw new Error('manuscript_scope_replacement_target_invalid')
          assertNoActivePartialAncestor(d, chain)
          validatePartialGraphForRun(d, input.runId)
          if (!nested) {
            d.exec('COMMIT')
            transactionDepth = 0
          }
          return
        }
        if (row.status !== 'candidate') throw new Error(row.status === 'partial' ? 'manuscript_segment_incomplete' : 'manuscript_segment_acceptance_mismatch')
        const prefixCacheBefore = readAcceptedPrefixCache(d, input.runId)
        if (chain.some((parent) => parent.status === 'candidate')) throw new Error('manuscript_partial_candidate_ancestor')
        const conflict = acceptedScopeConflict(d, row)
        if (conflict) {
          if (!input.supersedesAcceptedSegmentId) throw new Error('manuscript_scope_accepted_conflict')
          if (input.supersedesAcceptedSegmentId !== conflict.segment_id) throw new Error('manuscript_scope_replacement_target_mismatch')
          if (row.revision <= conflict.revision) throw new Error('manuscript_scope_replacement_revision_invalid')
          if (conflict.scene_id !== row.scene_id || conflict.chunk_index !== row.chunk_index) throw new Error('manuscript_scope_replacement_scope_mismatch')
          const committedReference = d.prepare(`SELECT 1 FROM scene_states
            WHERE run_id = ? AND scene_id = ? AND lifecycle = 'committed' AND accepted_segment_id = ? LIMIT 1`)
            .get(row.run_id, row.scene_id, conflict.segment_id)
          const narrativeReference = d.prepare('SELECT 1 FROM narrative_commits WHERE run_id = ? AND scene_id = ? AND accepted_segment_id = ? LIMIT 1')
            .get(row.run_id, row.scene_id, conflict.segment_id)
          if (committedReference || narrativeReference) throw new Error('manuscript_scope_replacement_committed')
          const superseded = d.prepare("UPDATE manuscript_segments SET status='superseded', updated_at=? WHERE run_id=? AND segment_id=? AND status='accepted'")
            .run(input.acceptedAt, row.run_id, conflict.segment_id) as { changes?: number }
          if ((superseded.changes ?? 0) !== 1) throw new Error('manuscript_scope_replacement_stale')
        } else if (input.supersedesAcceptedSegmentId) {
          throw new Error('manuscript_scope_replacement_target_missing')
        }
        supersedePartialAncestors(d, chain, input.acceptedAt)
        d.prepare("UPDATE manuscript_segments SET status='accepted', accepted_at=?, updated_at=? WHERE run_id=? AND segment_id=? AND status='candidate' AND kind='prose'").run(input.acceptedAt, input.acceptedAt, input.runId, input.segmentId)
        validatePartialGraphForRun(d, input.runId)
        assertNoActivePartialAncestor(d, chain)
        refreshAcceptedPrefixCache(d, input.runId, prefixCacheBefore, input.segmentId)
        if (!nested) {
          d.exec('COMMIT')
          transactionDepth = 0
        }
      } catch (error) {
        if (!nested) {
          try { d.exec('ROLLBACK') } catch { /* ignore */ }
          transactionDepth = 0
        }
        throw error
      }
    },
    upsertToolCall(tc) {
      requireDb()
        .prepare(
          'INSERT INTO toolcalls (tool_call_id, turn_id, run_id, name, args_json, args_hash, status, result_json, started_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tool_call_id) DO UPDATE SET turn_id=excluded.turn_id, status=excluded.status, result_json=excluded.result_json, started_at=excluded.started_at, completed_at=excluded.completed_at'
        )
        .run(tc.tool_call_id, tc.turn_id, tc.run_id, tc.name, tc.args_json, tc.args_hash, tc.status, tc.result_json, tc.started_at, tc.completed_at)
    },
    getSessionEditMessageIds(sessionId) {
      return (requireDb().prepare(`SELECT sm.msg_id FROM session_messages sm
        JOIN runs r ON r.session_id=sm.session_id AND (sm.msg_id='m_'||r.run_id||'_assistant' OR sm.msg_id=r.run_id)
        WHERE sm.session_id=? AND sm.role='assistant'
        AND EXISTS(SELECT 1 FROM toolcalls tc WHERE tc.run_id=r.run_id AND tc.name='edit_file')`)
        .all(sessionId) as Array<{msg_id: string}>).map(row => row.msg_id)
    },
    getSessionEditTools(sessionId, messageId, offset) {
      // Project inside SQLite: never materialize whole-file replacement arguments
      // or unrelated read/search/tool payloads in JS or across the IPC boundary.
      return requireDb().prepare(`WITH scoped AS (
        SELECT tc.*, CASE WHEN json_valid(tc.args_json) THEN tc.args_json ELSE '{}' END AS a,
          CASE WHEN json_valid(tc.result_json) THEN tc.result_json ELSE '{}' END AS outer_result
        FROM session_messages sm JOIN runs r ON r.session_id=sm.session_id
          AND (sm.msg_id='m_'||r.run_id||'_assistant' OR sm.msg_id=r.run_id)
        JOIN toolcalls tc ON tc.run_id=r.run_id
        WHERE sm.session_id=? AND sm.msg_id=? AND sm.role='assistant' AND tc.name='edit_file'
        ORDER BY tc.started_at, tc.tool_call_id LIMIT 41 OFFSET ?
      ), payload AS (
        SELECT *, CASE WHEN json_type(outer_result,'$.error') IS NOT 'text'
          AND json_type(outer_result,'$.content')='text' AND json_valid(json_extract(outer_result,'$.content'))
          THEN json_extract(outer_result,'$.content') ELSE outer_result END AS p FROM scoped
      ) SELECT tool_call_id, turn_id, run_id, name, args_hash, status, started_at, completed_at,
        json_object('path',CASE WHEN json_type(a,'$.path')='text' THEN substr(json_extract(a,'$.path'),1,1024) END,
          'old_text',CASE WHEN json_type(a,'$.old_text')='text' THEN substr(json_extract(a,'$.old_text'),1,322) END,
          'new_text',CASE WHEN json_type(a,'$.new_text')='text' THEN substr(json_extract(a,'$.new_text'),1,322) END) AS args_json,
        json_object('ok',json(CASE json_type(p,'$.ok') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE 'null' END),
          'message',CASE WHEN json_type(p,'$.message')='text' THEN substr(json_extract(p,'$.message'),1,2000) END,
          'error',substr(json_extract(p,'$.error'),1,240),
          'backupId',CASE WHEN json_type(p,'$.backupId')='text' THEN substr(json_extract(p,'$.backupId'),1,65536) END,
          'editUndo',json(CASE WHEN json_type(p,'$.editUndo')='object' AND length(json_extract(p,'$.editUndo'))<=196608 THEN json_extract(p,'$.editUndo') ELSE 'null' END),
          'edit',json_object('count',json_extract(p,'$.edit.count'))) AS result_json
        FROM payload`).all(sessionId, messageId, Math.max(0, Math.trunc(offset))) as unknown as ToolCallRow[]
    },
    getSessionFileEvidenceCounts(sessionId) {
      return requireDb().prepare(`${FILE_EVIDENCE_PAYLOAD_SQL.replace('$SCOPE', 'r.session_id=?')}
        SELECT sm.msg_id AS messageId, COUNT(*) AS count FROM sources
        JOIN session_messages sm ON sm.session_id=sources.session_id AND sm.role='assistant'
          AND (sm.msg_id='m_'||sources.run_id||'_assistant' OR sm.msg_id=sources.run_id)
        WHERE sm.session_id=? GROUP BY sm.msg_id`).all(sessionId, sessionId) as Array<{ messageId: string; count: number }>
    },
    getSessionFileEvidenceRunId(sessionId, messageId) {
      const row = requireDb().prepare(`SELECT r.run_id FROM session_messages sm
        JOIN runs r ON r.session_id=sm.session_id
          AND (sm.msg_id='m_'||r.run_id||'_assistant' OR sm.msg_id=r.run_id)
        WHERE sm.session_id=? AND (sm.msg_id=? OR r.run_id=?) AND sm.role='assistant' LIMIT 1`).get(sessionId, messageId, messageId) as { run_id: string } | undefined
      return row?.run_id ?? null
    },
    chatFileMessageMentions(sessionId, runId, candidate) {
      return !!requireDb().prepare(`SELECT 1 FROM runs r WHERE r.run_id=? AND r.session_id=? AND (
        EXISTS(SELECT 1 FROM session_messages sm WHERE sm.session_id=r.session_id AND sm.role='assistant'
          AND (sm.msg_id='m_'||r.run_id||'_assistant' OR sm.msg_id=r.run_id) AND instr(sm.content,?)>0)
        OR EXISTS(SELECT 1 FROM turns t WHERE t.run_id=r.run_id AND t.role='assistant' AND instr(t.content,?)>0))`).get(runId, sessionId, candidate, candidate)
    },
    chatFileMessageCandidates(sessionId, runId, candidates) {
      return (requireDb().prepare(`WITH candidates AS (SELECT DISTINCT value AS candidate FROM json_each(?) WHERE type='text')
        SELECT c.candidate FROM candidates c WHERE EXISTS(SELECT 1 FROM runs r WHERE r.run_id=? AND r.session_id=? AND (
          EXISTS(SELECT 1 FROM session_messages sm WHERE sm.session_id=r.session_id AND sm.role='assistant'
            AND (sm.msg_id='m_'||r.run_id||'_assistant' OR sm.msg_id=r.run_id) AND instr(sm.content,c.candidate)>0)
          OR EXISTS(SELECT 1 FROM turns t WHERE t.run_id=r.run_id AND t.role='assistant' AND instr(t.content,c.candidate)>0)))`)
        .all(JSON.stringify(candidates), runId, sessionId) as Array<{ candidate: string }>).map(row => row.candidate)
    },
    getRunWrittenFiles(runId) {
      // Keep file bodies/replacement text in SQLite; only path facts cross this boundary.
      return requireDb().prepare(`WITH raw AS (
        SELECT tc.name, CASE WHEN json_valid(tc.args_json) THEN tc.args_json ELSE '{}' END AS a,
          CASE WHEN json_valid(tc.result_json) THEN tc.result_json ELSE '{}' END AS o
        FROM toolcalls tc JOIN turns t ON t.run_id=tc.run_id AND t.turn_id=tc.turn_id
        WHERE tc.run_id=? AND tc.status='completed' AND tc.name IN
          ('write_file','edit_file','generate_markdown_doc','generate_docx_doc','generate_xlsx_doc','generate_pdf_doc')
      ), payload AS (SELECT *, CASE WHEN json_type(o,'$.error') IS NULL
        AND json_type(o,'$.content')='text' AND json_valid(json_extract(o,'$.content'))
        THEN json_extract(o,'$.content') ELSE o END AS p FROM raw)
      SELECT name, substr(json_extract(a,'$.path'),1,2048) AS args_path,
        substr(json_extract(a,'$.filename'),1,2048) AS filename,
        substr(json_extract(p,'$.path'),1,2048) AS result_path,
        substr(json_extract(p,'$.canonicalPath'),1,2048) AS canonical_path FROM payload
      WHERE json_type(p,'$.ok')='true' AND json_type(o,'$.error') IS NULL
        AND NOT (name='edit_file' AND coalesce(json_extract(p,'$.edit.count'),-1)=0)`)
        .all(runId) as Array<{ name: string; args_path: string | null; filename: string | null; result_path: string | null; canonical_path: string | null }>
    },
    getRunFileEvidenceRows(runId, offset) {
      return requireDb().prepare(`${FILE_EVIDENCE_PAYLOAD_SQL.replace('$SCOPE', 'tc.run_id=?')}
        SELECT run_id,tool_call_id,name,source_index,substr(source_json,1,65536) AS source_json,
          json_object('workDir',json_extract(config_json,'$.workDir'),'docDir',json_extract(config_json,'$.docDir')) AS roots_json
        FROM sources WHERE run_id=? ORDER BY started_at,tool_call_id,source_index LIMIT 9 OFFSET ?`)
        .all(runId, runId, Math.max(0, Math.trunc(offset))) as unknown as FileEvidenceRow[]
    },
    *workPlanReceipts(runId) {
      const rows = requireDb().prepare(`SELECT tc.result_json FROM toolcalls tc
        JOIN turns t ON t.run_id=tc.run_id AND t.turn_id=tc.turn_id
        WHERE tc.run_id=? AND tc.name='update_work_plan' AND tc.status='completed'
        ORDER BY t.turn_seq DESC, tc.rowid DESC`).iterate(runId)
      for (const row of rows) if (typeof row.result_json === 'string') yield { result_json: row.result_json }
    },
    getToolCallsByRun(runId) {
      return requireDb().prepare('SELECT * FROM toolcalls WHERE run_id = ? ORDER BY started_at ASC').all(runId) as unknown as ToolCallRow[]
    },
    getToolCallById(toolCallId) {
      return (requireDb().prepare('SELECT tc.* FROM toolcalls tc JOIN turns t ON t.turn_id=tc.turn_id AND t.run_id=tc.run_id WHERE tc.tool_call_id=?').get(toolCallId) as ToolCallRow | undefined) ?? null
    },
    getCompletedToolCall(runId, argsHash) {
      return (
        (requireDb().prepare("SELECT * FROM toolcalls WHERE run_id = ? AND args_hash = ? AND status = 'completed' LIMIT 1").get(runId, argsHash) as ToolCallRow | undefined) ?? null
      )
    },
    saveArtifact(a) {
      requireDb()
        .prepare(
          'INSERT INTO artifacts (artifact_id, run_id, session_id, artifact_type, display_name, relative_path, hash, char_count, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET status=excluded.status, hash=excluded.hash, char_count=excluded.char_count, relative_path=excluded.relative_path'
        )
        .run(a.artifact_id, a.run_id, a.session_id, a.artifact_type, a.display_name, a.relative_path, a.hash, a.char_count, a.status, a.created_at)
    },
    getArtifactsByRun(runId) {
      return requireDb().prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC').all(runId) as unknown as ArtifactRow[]
    },
    getArtifactsBySession(sessionId) {
      return requireDb().prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as unknown as ArtifactRow[]
    },
    getArtifactsByHash(hash) {
      return requireDb().prepare('SELECT * FROM artifacts WHERE hash = ? ORDER BY created_at ASC').all(hash) as unknown as ArtifactRow[]
    },
    saveJob(jobId, jobType, sessionId, runId, stateJson, usageJson) {
      const now = Date.now()
      requireDb()
        .prepare('INSERT INTO jobs (job_id, job_type, session_id, run_id, state_json, usage_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET state_json=excluded.state_json, usage_json=excluded.usage_json, updated_at=excluded.updated_at')
        .run(jobId, jobType, sessionId, runId, stateJson, usageJson, now, now)
    },
    getJob(jobId) {
      return (
        (requireDb().prepare('SELECT job_id, job_type, session_id, run_id, state_json, usage_json, updated_at FROM jobs WHERE job_id = ?').get(jobId) as
          | { job_id: string; job_type: string; session_id: string; run_id: string | null; state_json: string; usage_json: string; updated_at: number }
          | undefined) ?? null
      )
    },
    listJobs(sessionId) {
      const d = requireDb()
      if (sessionId) {
        return d.prepare('SELECT job_id, job_type, state_json, updated_at FROM jobs WHERE session_id = ? ORDER BY updated_at DESC').all(sessionId) as {
          job_id: string
          job_type: string
          state_json: string
          updated_at: number
        }[]
      }
      return d.prepare('SELECT job_id, job_type, state_json, updated_at FROM jobs ORDER BY updated_at DESC').all() as {
        job_id: string
        job_type: string
        state_json: string
        updated_at: number
      }[]
    },
    deleteJob(jobId) {
      requireDb().prepare('DELETE FROM jobs WHERE job_id = ?').run(jobId)
    },
    appendUsage(u) {
      requireDb()
        .prepare('INSERT INTO usage_log (run_id, call_type, model, input_tokens, output_tokens, cache_hit, cache_miss, cost, pricing_version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(u.run_id, u.call_type, u.model, u.input_tokens, u.output_tokens, u.cache_hit, u.cache_miss, u.cost, u.pricing_version, u.created_at)
    },
    getUsageByRun(runId) {
      return requireDb().prepare('SELECT * FROM usage_log WHERE run_id = ? ORDER BY created_at ASC').all(runId) as unknown as UsageRow[]
    },
    getUsageTotals(runId) {
      const d = requireDb()
      const row = runId
        ? (d
            .prepare(
              'SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cache_hit),0) AS cache_hit, COALESCE(SUM(cache_miss),0) AS cache_miss, COALESCE(SUM(cost),0) AS cost FROM usage_log WHERE run_id = ?'
            )
            .get(runId) as unknown as UsageTotals)
        : (d
            .prepare(
              'SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cache_hit),0) AS cache_hit, COALESCE(SUM(cache_miss),0) AS cache_miss, COALESCE(SUM(cost),0) AS cost FROM usage_log'
            )
            .get() as unknown as UsageTotals)
      return { ...row, calls: Number(row.calls ?? 0) }
    },
    startProviderAttempt(attempt) {
      requireDb().prepare(`INSERT INTO provider_call_attempts (
        attempt_id,run_id,logical_call_id,attempt_no,stage_id,actor,subtype,provider_id,provider_endpoint_origin,model_id,provider_request_id,outcome,http_status,started_at,first_token_at,ended_at,input_tokens,output_tokens,cache_hit_tokens,cache_miss_tokens,reasoning_tokens,cost_status,cost_amount,cost_currency,price_snapshot_id,adapter_id,profile_id,credential_ref_id,applied_mappings_json,omitted_controls_json,context_manifest_id,context_mode
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO NOTHING`).run(
        attempt.attempt_id, attempt.run_id, attempt.logical_call_id, attempt.attempt_no, attempt.stage_id, attempt.actor, attempt.subtype,
        attempt.provider_id, attempt.provider_endpoint_origin, attempt.model_id, attempt.provider_request_id, attempt.outcome, attempt.http_status,
        attempt.started_at, attempt.first_token_at, attempt.ended_at, attempt.input_tokens, attempt.output_tokens, attempt.cache_hit_tokens,
        attempt.cache_miss_tokens, attempt.reasoning_tokens, attempt.cost_status, attempt.cost_amount, attempt.cost_currency, attempt.price_snapshot_id,
        attempt.adapter_id ?? null, attempt.profile_id ?? null, attempt.credential_ref_id ?? null,
        attempt.applied_mappings_json ?? '[]', attempt.omitted_controls_json ?? '[]', attempt.context_manifest_id ?? null, attempt.context_mode ?? null
      )
      refreshBilling(attempt.run_id)
    },
    markProviderAttemptFirstToken(attemptId, firstTokenAt) {
      const d = requireDb()
      const row = d.prepare('SELECT run_id FROM provider_call_attempts WHERE attempt_id = ?').get(attemptId) as { run_id: string } | undefined
      if (!row) return
      const result = d.prepare("UPDATE provider_call_attempts SET first_token_at = ?, row_revision = row_revision + 1 WHERE attempt_id = ? AND first_token_at IS NULL AND outcome = 'in_flight'").run(firstTokenAt, attemptId) as { changes?: number }
      if ((result.changes ?? 0) > 0) refreshBilling(row.run_id)
    },
    finishProviderAttempt(attemptId, patch) {
      const d = requireDb()
      const row = d.prepare('SELECT run_id FROM provider_call_attempts WHERE attempt_id = ?').get(attemptId) as { run_id: string } | undefined
      if (!row) return
      const result = d.prepare(`UPDATE provider_call_attempts SET outcome=?,http_status=?,provider_request_id=?,ended_at=?,input_tokens=?,output_tokens=?,cache_hit_tokens=?,cache_miss_tokens=?,reasoning_tokens=?,cost_status=?,cost_amount=?,cost_currency=?,price_snapshot_id=?,row_revision=row_revision+1 WHERE attempt_id=? AND outcome='in_flight'`).run(
        patch.outcome, patch.http_status, patch.provider_request_id, patch.ended_at, patch.input_tokens, patch.output_tokens,
        patch.cache_hit_tokens, patch.cache_miss_tokens, patch.reasoning_tokens, patch.cost_status, patch.cost_amount,
        patch.cost_currency, patch.price_snapshot_id, attemptId
      ) as { changes?: number }
      if ((result.changes ?? 0) > 0) refreshBilling(row.run_id)
    },
    getProviderAttempts(runId) {
      return requireDb().prepare('SELECT * FROM provider_call_attempts WHERE run_id = ? ORDER BY started_at, attempt_no').all(runId) as unknown as ProviderAttemptRow[]
    },
    getRunBilling(runId) {
      const d = requireDb()
      const row = d.prepare('SELECT snapshot_json,source_attempt_revision,source_event_seq,source_tool_count FROM run_billing_snapshots WHERE run_id = ?').get(runId) as { snapshot_json: string; source_attempt_revision: number; source_event_seq: number; source_tool_count: number } | undefined
      if (row) {
        const attemptSource = d.prepare('SELECT COALESCE(SUM(row_revision),0) AS revision FROM provider_call_attempts WHERE run_id = ?').get(runId) as { revision: number }
        const eventSource = d.prepare('SELECT COALESCE(MAX(seq),-1) AS seq FROM workflow_events WHERE run_id = ?').get(runId) as { seq: number }
        const tools = d.prepare('SELECT COUNT(*) AS n FROM toolcalls WHERE run_id = ?').get(runId) as { n: number }
        if (Number(row.source_attempt_revision) === Number(attemptSource.revision ?? 0) && Number(row.source_event_seq) === Number(eventSource.seq ?? -1) && Number(row.source_tool_count) === Number(tools.n ?? 0)) {
          try { return JSON.parse(row.snapshot_json) as RunBillingView } catch { return refreshBilling(runId) }
        }
      }
      return refreshBilling(runId)
    },
    finalizeRunBilling(runId) {
      return refreshBilling(runId, true)
    },
    markDanglingProviderAttemptsInterrupted() {
      const d = requireDb()
      const rows = d.prepare("SELECT DISTINCT run_id FROM provider_call_attempts WHERE outcome = 'in_flight'").all() as Array<{ run_id: string }>
      d.prepare("UPDATE provider_call_attempts SET outcome = 'interrupted', row_revision = row_revision + 1 WHERE outcome = 'in_flight'").run()
      for (const row of rows) refreshBilling(row.run_id)
      return rows.map((row) => row.run_id)
    },
    appendWorkflowEvent(event) {
      const result = requireDb().prepare('INSERT INTO workflow_events (run_id,seq,event_id,event_json,created_at) VALUES (?,?,?,?,?) ON CONFLICT(run_id,seq) DO NOTHING')
        .run(event.runId, event.seq, `${event.runId}:${event.seq}`, JSON.stringify(event), event.timestamp) as { changes?: number }
      if ((result.changes ?? 0) > 0) refreshBilling(event.runId, ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))
    },
    getWorkflowEvents(runId, afterSeq = -1, limit = 10000) {
      // IPC pagination asks for limit + 1 to prove hasMore; public schema still caps at 10k.
      const safeLimit = Math.max(1, Math.min(10001, Math.trunc(limit)))
      const rows = requireDb().prepare('SELECT event_json FROM workflow_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(runId, afterSeq, safeLimit) as Array<{ event_json: string }>
      return rows.flatMap((row) => { try { return [JSON.parse(row.event_json) as ActivityEvent] } catch { return [] } })
    },
    saveAttachment(a) {
      requireDb()
        .prepare('INSERT INTO attachments (att_id, session_id, turn_id, file_hash, display_name, size, source_type, content_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(att_id) DO UPDATE SET size=excluded.size, source_type=excluded.source_type, content_ref=excluded.content_ref')
        .run(a.att_id, a.session_id, a.turn_id, a.file_hash, a.display_name, a.size, a.source_type, a.content_ref, a.created_at)
    },
    getAttachmentsBySession(sessionId) {
      return requireDb().prepare('SELECT att_id, display_name, size, source_type, created_at FROM attachments WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as {
        att_id: string
        display_name: string
        size: number
        source_type: string
        created_at: number
      }[]
    },
    getSetting(key) {
      return (requireDb().prepare('SELECT value_json FROM settings_kv WHERE key = ?').get(key) as { value_json?: string } | undefined)?.value_json ?? null
    },
    setSetting(key, value) {
      requireDb().prepare('INSERT OR REPLACE INTO settings_kv (key, value_json, updated_at) VALUES (?,?,?)').run(key, value, Date.now())
    },
    getMeta(key) {
      return (requireDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined)?.value ?? null
    },
    setMeta(key, value) {
      requireDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
    },
    // ---- canonical session（R4.1 / B-04） ----
    listComposerDrafts() {
      const rows = requireDb().prepare("SELECT session_id AS sessionId, text, revision, updated_at AS updatedAt FROM composer_drafts WHERE text <> '' ORDER BY updated_at DESC").all() as unknown as PersistedComposerDraft[]
      return rows.map((row) => ({ ...row }))
    },
    saveComposerDraft(input) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId) || typeof input.text !== 'string' || input.text.length > COMPOSER_DRAFT_MAX_CHARS || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('composer_draft_input_invalid')
      let result: ComposerDraftWriteResult | undefined
      withImmediateTransaction(() => {
        const d = requireDb()
        const previous = d.prepare('SELECT session_id AS sessionId, text, revision, updated_at AS updatedAt FROM composer_drafts WHERE session_id=?').get(input.sessionId) as PersistedComposerDraft | undefined
        const current = previous ? { ...previous } : { sessionId: input.sessionId, text: '', revision: 0, updatedAt: 0 }
        if (current.text === input.text) { result = { ok: true, draft: current }; return }
        if (current.revision !== input.expectedRevision) { result = { ok: false, reason: 'conflict', draft: current }; return }
        const bytes = Buffer.byteLength(input.text, 'utf8')
        const totals = d.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_count), 0) AS bytes FROM composer_drafts WHERE session_id <> ? AND text <> ''").get(input.sessionId) as { count: number; bytes: number }
        if (input.text && (totals.count >= COMPOSER_DRAFT_MAX_COUNT || totals.bytes + bytes > COMPOSER_DRAFT_MAX_BYTES)) throw new Error('composer_draft_storage_limit')
        const draft = { sessionId: input.sessionId, text: input.text, revision: current.revision + 1, updatedAt: Date.now() }
        d.prepare('INSERT INTO composer_drafts (session_id,text,byte_count,revision,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET text=excluded.text,byte_count=excluded.byte_count,revision=excluded.revision,updated_at=excluded.updated_at').run(draft.sessionId, draft.text, bytes, draft.revision, draft.updatedAt)
        result = { ok: true, draft }
      })
      return result!
    },
    createSession(sessionId, title, model) {
      const d = requireDb()
      const now = Date.now()
      d.prepare('INSERT OR IGNORE INTO sessions (session_id, title, model, created_at, updated_at) VALUES (?,?,?,?,?)').run(sessionId, title, model, now, now)
    },
    repairGrillSessionIndex() {
      // Backfill interviews created before canonical sessions were indexed.
      // INSERT OR IGNORE never renames an author's existing session.
      requireDb().prepare(`INSERT OR IGNORE INTO sessions(session_id,title,model,created_at,updated_at)
        SELECT g.session_id, substr(trim(json_extract(CASE WHEN json_valid(g.state_json) THEN g.state_json ELSE '{}' END,'$.originalTask')),1,80), '', g.updated_at, g.updated_at
        FROM grill_me_sessions g LEFT JOIN sessions s ON s.session_id=g.session_id
        WHERE s.session_id IS NULL
          AND json_extract(CASE WHEN json_valid(g.state_json) THEN g.state_json ELSE '{}' END,'$.status') != 'cancelled'
          AND json_type(CASE WHEN json_valid(g.state_json) THEN g.state_json ELSE '{}' END,'$.originalTask')='text'
          AND length(trim(json_extract(CASE WHEN json_valid(g.state_json) THEN g.state_json ELSE '{}' END,'$.originalTask'))) > 0`).run()
    },
    listSessions() {
      return requireDb()
        .prepare('SELECT session_id, title, model, created_at, updated_at FROM sessions ORDER BY updated_at DESC')
        .all() as { session_id: string; title: string; model: string; created_at: number; updated_at: number }[]
    },
    touchSession(sessionId, title) {
      const d = requireDb()
      if (title !== undefined) {
        d.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE session_id = ?').run(title, Date.now(), sessionId)
      } else {
        d.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(Date.now(), sessionId)
      }
    },
    deleteSession(sessionId) {
      const d = requireDb()
      // 用户语义是删除会话，不只是删侧栏投影。runs 及其 turns/toolcalls/artifacts/evidence
      // 由 FK 级联清理；session 直属 jobs/attachments 先显式删除。事务失败必须完整回滚。
      withImmediateTransaction(() => {
        const runIds = (d.prepare('SELECT run_id FROM runs WHERE session_id=?').all(sessionId) as Array<{ run_id?: string }>).map((row) => row.run_id).filter((runId): runId is string => typeof runId === 'string' && runId.length > 0)
        for (const runId of runIds) invalidateSceneMemoryProjectionsForRun(d, runId, 'preserve')
        d.prepare('DELETE FROM jobs WHERE session_id = ?').run(sessionId)
        d.prepare('DELETE FROM attachments WHERE session_id = ?').run(sessionId)
        d.prepare('DELETE FROM runs WHERE session_id = ?').run(sessionId)
        d.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId)
        d.prepare('DELETE FROM grill_me_sessions WHERE session_id = ?').run(sessionId)
        d.prepare('DELETE FROM composer_drafts WHERE session_id = ?').run(sessionId)
        d.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId)
      })
    },
    appendSessionMessage(m) {
      // session_messages 是会话最终状态投影：同 msg_id 覆盖（非 append-only 事件日志）
      requireDb()
        .prepare(
          'INSERT INTO session_messages (msg_id, session_id, seq, role, content, reasoning, status, usage_json, rounds, tool_names_json, plan, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(msg_id) DO UPDATE SET content=excluded.content, reasoning=excluded.reasoning, status=excluded.status, usage_json=excluded.usage_json, rounds=excluded.rounds, tool_names_json=excluded.tool_names_json, plan=excluded.plan'
        )
        .run(m.msg_id, m.session_id, m.seq, m.role, m.content, m.reasoning ?? '', m.status ?? 'done', m.usage_json ?? 'null', m.rounds ?? 0, m.tool_names_json ?? '[]', m.plan ?? null, m.created_at)
    },
    getSessionMessages(sessionId) {
      return requireDb()
        .prepare('SELECT msg_id, session_id, seq, role, content, reasoning, status, usage_json, rounds, tool_names_json, plan, created_at FROM session_messages WHERE session_id = ? ORDER BY seq')
        .all(sessionId) as { msg_id: string; session_id: string; seq: number; role: string; content: string; reasoning: string; status: string; usage_json: string; rounds: number; tool_names_json: string; plan: string | null; created_at: number }[]
    },
    // ---- R4.2 A1：真正原子的 chat accept（PERSIST-ATOMIC-02） ----
    // 单一 BEGIN IMMEDIATE 事务内完成全部写点；任一写点失败整个事务回滚，
    // 数据库业务状态与调用前逐行一致（绝不"先建 run 失败后 cancel"）。
    // 事务提交前绝不调用模型/工具（编排方保证；本方法无任何副作用外调用）。
    acceptChatStart(input, hooks) {
      const d = requireDb()
      let result: AcceptChatStartResult = { ok: true }
      this.tx(
        () => {
          // 1) 幂等：同 (session_id, client_request_id) 已存在 → 返回既有 run（跨重启成立）
          if (input.run.client_request_id) {
            const existing = d
              .prepare('SELECT run_id FROM runs WHERE session_id = ? AND client_request_id = ? LIMIT 1')
              .get(input.run.session_id, input.run.client_request_id) as { run_id: string } | undefined
            if (existing) {
              result = { ok: false, reason: 'duplicate', runId: existing.run_id }
              return
            }
          }
          // 2) busy：同 session 已有非终态 run → 拒绝（并发启动只有一个成功，不留孤儿）
          const busy = d
            .prepare(
              "SELECT run_id FROM runs WHERE session_id = ? AND status IN ('queued','running','recoverable','cancelling','cancel_requested','recovery_required') LIMIT 1"
            )
            .get(input.run.session_id) as { run_id: string } | undefined
          if (busy) {
            result = { ok: false, reason: 'busy', runId: busy.run_id }
            return
          }
          // 3) session 行（幂等创建，不覆盖既有标题/时间）
          hooks?.beforeInsertSession?.()
          const now = Date.now()
          d.prepare('INSERT OR IGNORE INTO sessions (session_id, title, model, created_at, updated_at) VALUES (?,?,?,?,?)').run(input.sessionId, input.title, input.model, now, now)
          // 4) run 行（纯 INSERT；幂等键唯一索引兜底）
          hooks?.beforeInsertRun?.()
           d.prepare('INSERT INTO runs (run_id, session_id, status, phase, started_at, updated_at, config_json, parent_run_id, error_code, error_message, client_request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
            input.run.run_id,
            input.run.session_id,
            input.run.status,
            input.run.phase,
            input.run.started_at,
            input.run.updated_at,
            input.run.config_json,
            input.run.parent_run_id,
            input.run.error_code,
            input.run.error_message,
             input.run.client_request_id ?? null
           )
           ensureStoryRunScope(d, input.run.run_id, input.run.session_id, input.run.config_json, input.run.started_at)
          // 4.5) completion contract（与 run 同事务；契约权威落库，审计可证明 evaluation 对应哪版契约）
          if (input.completionContract) {
            d.prepare('INSERT INTO completion_contracts (run_id, version, json, created_at) VALUES (?,?,?,?) ON CONFLICT(run_id, version) DO UPDATE SET json=excluded.json').run(
              input.run.run_id,
              input.completionContract.version,
              input.completionContract.json,
              Date.now()
            )
          }
          // 5) canonical 历史 turns（预算裁剪后；与 user turn 同事务，失败一并回滚）
          let turnSeq = 1
          for (const h of input.historyTurns ?? []) {
            hooks?.beforeInsertTurn?.()
            d.prepare('INSERT INTO turns (turn_id, run_id, turn_seq, role, content, reasoning_content, tool_calls_json, tool_result_json, plan_state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
              h.turn_id,
              h.run_id,
              turnSeq++,
              h.role,
              h.content,
              h.reasoning_content,
              h.tool_calls_json,
              h.tool_result_json,
              h.plan_state,
              h.created_at
            )
          }
          // 6) 首个 user turn（run 内事件日志；turn_seq 紧跟历史）
          hooks?.beforeInsertTurn?.()
          d.prepare('INSERT INTO turns (turn_id, run_id, turn_seq, role, content, reasoning_content, tool_calls_json, tool_result_json, plan_state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
            input.userTurn.turn_id,
            input.userTurn.run_id,
            turnSeq,
            input.userTurn.role,
            input.userTurn.content,
            input.userTurn.reasoning_content,
            input.userTurn.tool_calls_json,
            input.userTurn.tool_result_json,
            input.userTurn.plan_state,
            input.userTurn.created_at
          )
          // 7) canonical user message（seq 在事务内计算，防并发/重放错序）
          if (input.userMsg && input.userMsg.content.trim()) {
            hooks?.beforeInsertMessage?.()
            const seqRow = d.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM session_messages WHERE session_id = ?').get(input.sessionId) as { seq: number }
            d.prepare(
              'INSERT INTO session_messages (msg_id, session_id, seq, role, content, reasoning, status, usage_json, rounds, tool_names_json, plan, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
            ).run(input.userMsg.msg_id, input.sessionId, (seqRow.seq ?? 0) + 1, input.userMsg.role, input.userMsg.content, '', 'done', 'null', 0, '[]', null, input.userMsg.created_at)
            // Clear only the accepted text, in the same transaction. An edit
            // made while acceptance is pending belongs to the next request.
            const draft = d.prepare('SELECT text FROM composer_drafts WHERE session_id=?').get(input.sessionId) as { text: string } | undefined
            if (draft?.text.trim() === input.userMsg.content.trim()) d.prepare("UPDATE composer_drafts SET text='',byte_count=0,revision=revision+1,updated_at=? WHERE session_id=?").run(now, input.sessionId)
          }
        },
        'immediate'
      )
      return result
    },
    saveContextManifest(runId, round, manifestJson) {
      requireDb()
        .prepare('INSERT INTO context_manifests (run_id, round, manifest_json, created_at) VALUES (?,?,?,?) ON CONFLICT(run_id, round) DO UPDATE SET manifest_json=excluded.manifest_json')
        .run(runId, round, manifestJson, Date.now())
    },
    getContextManifests(runId) {
      return requireDb()
        .prepare('SELECT run_id, round, manifest_json, created_at FROM context_manifests WHERE run_id = ? ORDER BY round ASC')
        .all(runId) as { run_id: string; round: number; manifest_json: string; created_at: number }[]
    },
    appendRecoveryDecision(d) {
      requireDb()
        .prepare('INSERT INTO recovery_decisions (decision_id, run_id, tool_call_id, decision, actor, note, checkpoint_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(d.decision_id, d.run_id, d.tool_call_id, d.decision, d.actor, d.note, d.checkpoint_id, d.created_at)
    },
    getRecoveryDecisions(runId) {
      return requireDb()
        .prepare('SELECT decision_id, run_id, tool_call_id, decision, actor, note, checkpoint_id, created_at FROM recovery_decisions WHERE run_id = ? ORDER BY created_at ASC')
        .all(runId) as { decision_id: string; run_id: string; tool_call_id: string; decision: string; actor: string; note: string; checkpoint_id: string | null; created_at: number }[]
    },
    saveCompletionContract(runId, version, json) {
      requireDb()
        .prepare('INSERT INTO completion_contracts (run_id, version, json, created_at) VALUES (?,?,?,?) ON CONFLICT(run_id, version) DO UPDATE SET json=excluded.json')
        .run(runId, version, json, Date.now())
    },
    getCompletionContract(runId) {
      return (
        (requireDb().prepare('SELECT run_id, version, json, created_at FROM completion_contracts WHERE run_id = ? ORDER BY version DESC LIMIT 1').get(runId) as
          | { run_id: string; version: number; json: string; created_at: number }
          | undefined) ?? null
      )
    },
    saveCompletionEvaluation(runId, revision, state, json) {
      requireDb()
        .prepare('INSERT INTO completion_evaluations (run_id, revision, state, json, created_at) VALUES (?,?,?,?,?) ON CONFLICT(run_id, revision) DO UPDATE SET state=excluded.state, json=excluded.json')
        .run(runId, revision, state, json, Date.now())
    },
    getLatestCompletionEvaluation(runId) {
      return (
        (requireDb().prepare('SELECT run_id, revision, state, json, created_at FROM completion_evaluations WHERE run_id = ? ORDER BY revision DESC LIMIT 1').get(runId) as
          | { run_id: string; revision: number; state: string; json: string; created_at: number }
          | undefined) ?? null
      )
    },
    appendCompletionAttempt(runId, attempt, json) {
      requireDb()
        .prepare('INSERT INTO completion_attempts (run_id, attempt, json, created_at) VALUES (?,?,?,?) ON CONFLICT(run_id, attempt) DO UPDATE SET json=excluded.json')
        .run(runId, attempt, json, Date.now())
    },
    getCompletionAttempts(runId) {
      return requireDb().prepare('SELECT run_id, attempt, json, created_at FROM completion_attempts WHERE run_id = ? ORDER BY attempt ASC').all(runId) as Array<{ run_id: string; attempt: number; json: string; created_at: number }>
    },
    saveRunEvidence(runId, kind, json) {
      requireDb()
        .prepare('INSERT INTO run_evidence (run_id, kind, json, created_at) VALUES (?,?,?,?) ON CONFLICT(run_id, kind) DO UPDATE SET json=excluded.json')
        .run(runId, kind, json, Date.now())
    },
    saveRunEvidenceIfAbsent(runId, kind, json) {
      const result = requireDb()
        .prepare('INSERT INTO run_evidence (run_id, kind, json, created_at) VALUES (?,?,?,?) ON CONFLICT(run_id, kind) DO NOTHING')
        .run(runId, kind, json, Date.now()) as { changes?: number }
      return Number(result.changes ?? 0) === 1
    },
    saveRunEvidenceBundle(runId, entries) {
      if (!runId || !Array.isArray(entries) || entries.length === 0 || entries.some((entry) => !entry || typeof entry.kind !== 'string' || !entry.kind || typeof entry.json !== 'string')) throw new Error('run_evidence_bundle_invalid')
      const kinds = new Set<string>()
      if (entries.some((entry) => kinds.has(entry.kind) || !kinds.add(entry.kind))) throw new Error('run_evidence_bundle_duplicate_kind')
      withImmediateTransaction(() => {
        const d = requireDb()
        const statement = d.prepare('INSERT INTO run_evidence (run_id, kind, json, created_at) VALUES (?,?,?,?) ON CONFLICT(run_id, kind) DO UPDATE SET json=excluded.json, created_at=excluded.created_at')
        const createdAt = Date.now()
        for (const entry of entries) {
          testHooks.beforeRunEvidenceBundleEntry?.(entry.kind)
          statement.run(runId, entry.kind, entry.json, createdAt)
        }
      })
    },
    getRunEvidence(runId, kind) {
      return (
        (requireDb().prepare('SELECT run_id, kind, json, created_at FROM run_evidence WHERE run_id = ? AND kind = ?').get(runId, kind) as
          | { run_id: string; kind: string; json: string; created_at: number }
          | undefined) ?? null
      )
    },
    getRunSteeringRows(runId) {
      return requireDb().prepare("SELECT kind, json FROM run_evidence WHERE run_id = ? AND kind GLOB 'work_steering_v1:*'").all(runId) as Array<{ kind: string; json: string }>
    },
    nextSessionMessageSeq(sessionId) {
      return (requireDb().prepare('SELECT MAX(0,COALESCE(MAX(seq),0))+1 AS n FROM session_messages WHERE session_id=?').get(sessionId) as { n: number }).n
    },
    getSteeringAdmission(runId, turnId) {
      // The owning transaction already holds the writer lock. Only inspect the
      // effect fence and sequence keys, never load tool results or old prose.
      const row = requireDb().prepare(`SELECT EXISTS(SELECT 1 FROM toolcalls WHERE run_id=? AND status IN ('requested','running','side_effect_unknown')) AS busy,
        EXISTS(SELECT 1 FROM turns WHERE run_id=? AND turn_id=?) AS duplicate,
        (SELECT MAX(0,COALESCE(MAX(turn_seq),0))+1 FROM turns WHERE run_id=?) AS nextSeq`).get(runId, runId, turnId, runId) as {busy: number; duplicate: number; nextSeq: number}
      return { busy: Boolean(row.busy), duplicate: Boolean(row.duplicate), nextSeq: row.nextSeq }
    },
    acceptSteeringMessage(sessionId, msgId, text) {
      return requireDb().prepare("UPDATE session_messages SET status='done' WHERE session_id=? AND msg_id=? AND role='user' AND status='thinking' AND content=?")
        .run(sessionId, msgId, text).changes === 1
    },
    moveActiveAssistantAfterSteering(runId, sessionId) {
      const d = requireDb()
      // Only this still-active run's unfinished projection can move. Accepted
      // history and summary source identities retain their original sequence.
      d.prepare(`UPDATE session_messages SET seq=(SELECT COALESCE(MAX(seq),0)+1 FROM session_messages WHERE session_id=?)
        WHERE msg_id=? AND session_id=? AND status NOT IN ('done','completed')
        AND EXISTS(SELECT 1 FROM runs WHERE run_id=? AND session_id=? AND status IN ('queued','running','recoverable','waiting_user','recovery_required','cancelling','cancel_requested'))`)
        .run(sessionId, 'm_' + runId + '_assistant', sessionId, runId, sessionId)
    },
    saveGrillMeState(state) {
      requireDb().prepare('INSERT INTO grill_me_sessions (session_id,state_json,updated_at) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at').run(state.sessionId, JSON.stringify(state), state.updatedAt)
    },
    getGrillMeState(sessionId) {
      const row = requireDb().prepare('SELECT state_json FROM grill_me_sessions WHERE session_id = ?').get(sessionId) as { state_json?: string } | undefined
      if (!row?.state_json) return null
      try {
        const parsed = JSON.parse(row.state_json) as GrillMeState
        const now = Date.now()
        const state = hydrateGrillMeState(parsed, now)
        if (!state) return null
        // Manual-cap questions are deliberately ephemeral. The public
        // hydrator materializes an orphan currentQuestion so the UI can
        // resume it, but do not persist that question into the automatic
        // question history or the cap can be bypassed after a restart.
        if (parsed.status === 'manual_completion' && parsed.currentQuestion) {
          state.questions = state.questions.filter((question) => question.id !== state.currentQuestion?.id)
        }
        let persistMigration = parsed.schemaVersion !== 2 || JSON.stringify(state) !== row.state_json
        if (!state.planning) state.planning = { status: 'not_run', providerId: null, modelId: null, durationMs: null, usage: null, error: null, updatedAt: state.updatedAt ?? now }
        if (!state.interview) state.interview = { status: 'not_run', providerId: null, modelId: null, durationMs: 0, usage: { inputTokens: null, outputTokens: null, reasoningTokens: null }, usageKnown: { inputTokens: false, outputTokens: false, reasoningTokens: false }, callCount: 0, error: null, updatedAt: state.updatedAt ?? now }
        const hasLegacyProvenance = [state.outline, state.approvedOutline].some((outline) => outline?.sections?.some((section) => !Array.isArray(section.sourceSlotIds)))
        if (hasLegacyProvenance) {
          // R46.4：旧 confirmed 大纲没有 provenance，不能补空数组继续沿用 hash。
          // 清空旧规划但保留采访事实/答案/用量，要求重新规划并二次确认。
          state.schemaVersion = 2
          state.status = 'outline_ready'
          state.currentQuestion = null
          state.outline = null
          state.approvedOutline = null
          state.outlineRevision = 0
          state.outlineHash = ''
          state.planning = { status: 'not_run', providerId: null, modelId: null, durationMs: null, usage: null, error: null, updatedAt: now }
          state.updatedAt = now
          persistMigration = true
        } else {
          state.schemaVersion = 2
          if (state.outline) state.outline.sections = state.outline.sections.map((section) => ({ ...section, sourceSlotIds: section.sourceSlotIds }))
          if (state.approvedOutline) state.approvedOutline.sections = state.approvedOutline.sections.map((section) => ({ ...section, sourceSlotIds: section.sourceSlotIds }))
        }
        if (persistMigration) requireDb().prepare('INSERT INTO grill_me_sessions (session_id,state_json,updated_at) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at').run(state.sessionId, JSON.stringify(state), state.updatedAt)
        return state
      } catch { return null }
    },
    getLatestUnconsumedGrillMeState(preferredSessionId) {
      const rows = requireDb().prepare('SELECT state_json, updated_at FROM grill_me_sessions ORDER BY updated_at DESC').all() as Array<{ state_json?: string; updated_at?: number }>
      const eligible = new Set<GrillMeState['status']>(['confirmed', 'awaiting_outline_confirmation', 'outline_ready', 'assumption_review', 'interviewing', 'manual_completion'])
      let latest: GrillMeState | null = null
      for (const row of rows) {
        if (!row.state_json) continue
        let parsed: unknown
        try { parsed = JSON.parse(row.state_json) } catch { continue }
        const state = hydrateGrillMeState(parsed, Date.now())
        if (!state || !eligible.has(state.status)) continue
        // A confirmed state is consumed once any accepted run stores its
        // canonical Grill snapshot in runs.config_json. Query by stateId,
        // rather than session, so stale/orphaned renderer sessions cannot
        // make a completed Grill state appear recoverable again.
        const consumed = requireDb()
          .prepare("SELECT 1 AS present FROM runs WHERE json_extract(config_json, '$.grillMe.stateId') = ? LIMIT 1")
          .get(state.stateId) as { present?: number } | undefined
        if (consumed?.present === 1) continue
        if (preferredSessionId && state.sessionId === preferredSessionId) return state
        latest ??= state
      }
      return latest
    },
    deleteGrillMeState(sessionId) {
      requireDb().prepare('DELETE FROM grill_me_sessions WHERE session_id = ?').run(sessionId)
    }
  }
}
