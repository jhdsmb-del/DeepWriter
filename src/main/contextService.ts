import { createHash } from 'node:crypto'
import { withoutCanonicalUser } from './liveUserContext'
import { workSteeringTurnPrefix } from '../shared/workSteering'
import { SCENE_WORKING_SET_CURRENT_TAIL_CHARS, type AcceptedNarrativePrefixSnapshot, type Repository } from './db/repository'
import { assembleContext, type ContextManifest } from './contextAssembler'
import { buildFrozenPrefixCandidates, contextHash, ContextV2Service, selectContextCandidates, type ContextCandidate } from './contextV2'
import type { ContextManifestV2, FrozenContextSnapshotV2 } from '../shared/contextV2'
import type { LiveToolProjection } from './liveToolProjection'
import type { FrozenExecutableProfile, FrozenStageProfileSnapshots } from '../shared/providerRegistry'
import type { DsMessage, SceneContract, SceneContractPlan, SceneContextCompileResult, SceneContextManifest, SceneRecallCorpusSnapshot, SceneRecallIndexResult, SceneRecallQuery, SceneRecallRequiredFact, SceneWorkingSet } from '../shared/types'
import { estimateTokens } from '../shared/types'
import { codePointLength } from '../shared/textMetrics'
import { buildSceneContractPrompt, sceneContractPlanValid } from './narrative/sceneContract'
import { buildDeterministicRecallIndex, SCENE_RECALL_BM25_VERSION, SCENE_RECALL_TOKENIZER_VERSION } from './narrative/recallIndex'
import { compileSceneWorkingSet, sceneWorkingSetHash } from './narrative/sceneContextCompiler'
import { stableSceneMemoryJson } from './narrative/sceneMemoryCard'
import { buildNarrativeContextManifest, renderNarrativeContextManifest, type NarrativeContextRecentProse } from './narrative/narrativeContext'
import { buildNarrativeFactsFromGrill } from './narrative/factRegistry'
import { factMatchesRequiredId, validateNarrativeFact } from './narrative/factRegistry'
import type { NarrativeFact } from '../shared/types'
import { buildStrongConstraintSystemPrompt } from './strongConstraints'
import { providerEnvelopeHash } from './providerEnvelope'
import { storyLedgerGenesisHeadHash } from './narrative/storyLedger'
import { projectLongformWorkflowRecallAudit, type LongformWorkflowRecallResult } from '../shared/longformWorkflow'
import { authorAgreementPrompt, frozenWritingForm, isEditorialWriting, writerPrefixForForm } from './writingContext'

const MEMORY_PREFIX_RE = /^## (项目记忆|用户记忆)/
const NARRATIVE_CONTEXT_DEFAULT_MAX_TOKENS = 12_000
const NARRATIVE_CONTEXT_DEFAULT_MAX_CHARS = 48_000
const NARRATIVE_CONTEXT_RECENT_PROSE_CHARS = 12_000

export interface AssembleRunContextResult {
  messages: DsMessage[]
  manifest: ContextManifest
  userContent: string | null
  /** Optional to keep the pre-R45 contextService return contract source-compatible. */
  contextV2?: ContextManifestV2 | null
  /** R61 diagnostics: accepted-prefix cursor work performed for this request. */
  narrativePrefix?: Pick<AcceptedNarrativePrefixSnapshot, 'acceptedCharCount' | 'acceptedSegmentCount' | 'readBytes' | 'cacheHit' | 'cacheRevision'>
  /** Production longwrite_v2 fence.  The adapter calls it with the exact
   * final messages immediately before every provider attempt. */
  sceneWorkingSetFence?: (messages: DsMessage[], phase?: 'prebind' | 'postbind') => void
  /** v2 has already consumed the complete live input while constructing its
   * canonical envelope.  The adapter must not append historical user,
   * summary, recent-tail, or current-scene messages a second time. */
  suppressLive?: boolean
  /** Persist an auditable hash of the exact final envelope for low-level/test
   * adapters that do not expose ContextV2 manifests. */
  persistSceneEnvelope?: (messages: DsMessage[]) => void
}

/** Authenticated recall evidence handed to the durable WP6 workflow authority.
 * This callback runs only after the repository Scene Working Set and its
 * deterministic index have both been validated and persisted. */
export interface LongformRecallAuditProjection {
  runId: string
  sessionId: string
  storyId: string
  projectId: string
  branchId: string
  sceneId: string
  validityEpoch: number
  storyRevision: number
  workingSetHash: string
  manifestHash: string
  sourceSnapshotHash: string
  sourceCardSetHash: string
  queryHash: string
  indexHash: string
  audit: LongformWorkflowRecallResult
}

interface SceneWorkingSetRuntime {
  result: SceneContextCompileResult
  snapshot: SceneRecallCorpusSnapshot
  query: SceneRecallQuery
  recall: SceneRecallIndexResult
  requiredFacts: readonly SceneRecallRequiredFact[]
  workingSetHash: string
  expectedFence: {
    runId: string
    expectedRevision: number
    expectedEpoch: number
    expectedHeadRevision: number
    expectedHeadHash: string | null
  }
}

function source(sourceType: ContextCandidate['source']['sourceType'], canonicalId: string, content: string, displayLabel: string): ContextCandidate['source'] {
  return { sourceType, canonicalId, revision: null, contentHash: contextHash(content), span: null, displayLabel }
}

function sourceIdentity(entry: { source: { sourceType: string; canonicalId: string; revision: number | null; contentHash: string; span: { start: number; end: number } | null } }): string {
  return [entry.source.sourceType, entry.source.canonicalId, entry.source.revision ?? '', entry.source.contentHash, entry.source.span?.start ?? '', entry.source.span?.end ?? ''].join('\u0000')
}

function selectedStage(config: Record<string, unknown>, purpose: 'writer' | 'critic' | 'editor'): FrozenExecutableProfile | null {
  const frozen = config.providerProfileSnapshots as FrozenStageProfileSnapshots | undefined
  if (!frozen) return null
  if (purpose === 'critic') return frozen.review
  if (purpose === 'editor') return frozen.polish
  return config.planMode === true ? frozen.planning : frozen.draft
}

function isLongWriteConfig(config: Record<string, unknown>): boolean {
  return config.runMode === 'longwrite' && config.longMode === true
}

/** The v1.2.5 path is opt-in at the durable scene boundary.  Confirmed Grill
 * runs carry SceneContracts; old snapshots (including frozenContext=legacy_v1)
 * and quick-bypass longwrite continue through the pre-WP4 path. */
function isLongwriteV2Config(config: Record<string, unknown>): boolean {
  if (isEditorialWriting(config)) return false
  if (!isLongWriteConfig(config)) return false
  if (config.longwrite_v2 === true || config.longwriteV2 === true || config.narrativeContextVersion === 2 || config.contextVersion === 2) return true
  const frozen = config.frozenContext as { schemaVersion?: unknown; mode?: unknown } | undefined
  return frozen?.schemaVersion === 2 && frozen.mode !== 'legacy_v1' && config.sceneContracts !== undefined && config.sceneContracts !== null
}

function messageEnvelopeHash(messages: DsMessage[]): string {
  return providerEnvelopeHash(messages)
}

function sourceSetHash(messages: DsMessage[]): string {
  return createHash('sha256').update(stableSceneMemoryJson(messages.map((message, index) => ({ index, role: message.role, contentHash: contextHash(message.content ?? '') }))), 'utf8').digest('hex')
}

function finiteConfigInt(config: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = config[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function resolveSceneRequiredFacts(repo: Repository, config: Record<string, unknown>, contract: SceneContract): SceneRecallRequiredFact[] {
  const requiredIds = [...new Set(contract.requiredFactIds ?? [])]
  if (requiredIds.length === 0) return []
  const sessionId = typeof config.sessionId === 'string' && config.sessionId.trim().length > 0 ? config.sessionId : null
  if (!sessionId || typeof repo.getNarrativeFacts !== 'function') throw new Error('scene_working_set_required_fact_missing')
  let facts: NarrativeFact[]
  try {
    facts = repo.getNarrativeFacts(sessionId, false).map((fact) => validateNarrativeFact(fact)).filter((fact) => fact.status === 'active')
  } catch (error) {
    throw new Error(`scene_working_set_required_fact_invalid:${error instanceof Error ? error.message : String(error)}`)
  }
  return requiredIds.sort().map((requiredId) => {
    const matches = facts.filter((fact) => factMatchesRequiredId(fact, requiredId)).sort((left, right) => right.version - left.version || left.factId.localeCompare(right.factId))
    if (matches.length !== 1) throw new Error(`scene_working_set_required_fact_missing:${requiredId}`)
    const fact = matches[0]!
    return {
      requiredId,
      factId: fact.factId,
      version: fact.version,
      canonicalStatement: fact.canonicalStatement,
      canonicalHash: fact.canonicalHash,
      provenanceHash: fact.provenanceHash,
      sourceSlotIds: [...fact.sourceSlotIds].sort()
    }
  })
}

/** Confirmed intake is shared by the legacy and V2 projections. V2 must
 * materialize the durable run's facts before its first required-fact lookup;
 * caller edits or a later fact retraction must never silently restore canon. */
export function materializeConfirmedGrillFacts(repo: Repository, config: Record<string, unknown>, runId: string): void {
  const grill = config.grillMe as { approvedOutline?: unknown; originalTask?: string; answers?: Array<{ slotId: string; value: string; source?: string }> } | undefined
  if (!grill?.approvedOutline) return
  const sessionId = typeof config.sessionId === 'string' ? config.sessionId : ''
  const run = repo.getRun(runId)
  const durable = run ? JSON.parse(run.config_json) as Record<string, unknown> : null
  const confirmed = durable?.grillMe as typeof grill
  if (!run || run.session_id !== sessionId || !confirmed?.approvedOutline || stableSceneMemoryJson(confirmed) !== stableSceneMemoryJson(grill)) throw new Error('scene_working_set_confirmed_grill_drift')
  const generated = buildNarrativeFactsFromGrill({ sessionId, runId, answers: confirmed.answers ?? [],
    ...(frozenWritingForm(config) && confirmed.originalTask ? { originalTask: confirmed.originalTask } : {}) })
  for (const fact of generated) {
    const existing = repo.getNarrativeFact(fact.factId)
    if (existing?.status === 'retracted' || existing?.runId === runId && (existing.canonicalHash !== fact.canonicalHash || stableSceneMemoryJson(existing.sources) !== stableSceneMemoryJson(fact.sources))) throw new Error(`scene_working_set_confirmed_fact_drift:${fact.factId}`)
    repo.upsertNarrativeFact(fact)
  }
}

function sceneContractQuery(contract: SceneContract, scope: SceneRecallQuery['scope'], config: Record<string, unknown>, requiredFacts: readonly SceneRecallRequiredFact[]): SceneRecallQuery {
  const activeEntityIds = [...new Set([...(contract.activeCharacterIds ?? []), ...(contract.characterIds ?? [])])].filter(Boolean)
  const threadActions = contract.threadActions ?? []
  const threadIds = [...new Set(threadActions.map((item) => item.threadId).filter(Boolean))]
  const openedHere = new Set(threadActions.filter((item) => item.action === 'open').map((item) => item.threadId).filter(Boolean))
  // The current contract itself is authoritative for its characters/location
  // and for a newly opened thread.  Only requirements that explicitly refer
  // to prior canon may block recall; active entities and locations remain soft
  // ranking hints so the first scene can run with an empty corpus.
  // A thread opened and closed in the same contract is still a current-scene
  // construct; requiring a historical card for it would make a valid first
  // scene impossible.  A standalone close remains a historical authority
  // requirement, as do advance/delay actions.
  const historicalThreadActions = threadActions.filter((item) => item.action === 'advance' || item.action === 'delay' || item.action === 'close' && !openedHere.has(item.threadId))
  const openThreadIds = [...new Set(historicalThreadActions.map((item) => item.threadId).filter(Boolean))]
  const payoffThreadIds = [...new Set(threadActions.filter((item) => item.action === 'advance' || item.action === 'delay' || item.action === 'close').map((item) => item.threadId).filter(Boolean))]
  const queryText = [contract.title, contract.objective, contract.desire, contract.obstacle, contract.conflict, contract.expectedTurn, contract.reveal].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join('\n')
  return {
    scope,
    requiredFactIds: [...new Set(requiredFacts.map((fact) => fact.factId))],
    requiredFacts: requiredFacts.map((fact) => ({ ...fact, sourceSlotIds: [...fact.sourceSlotIds] })),
    // requiredBeatIds describe this scene's own contract beats; no durable
    // historical card authority exists for them at recall time.
    requiredBeatIds: [],
    activeEntityIds: [],
    entityIds: activeEntityIds,
    threadIds,
    openThreadIds,
    payoffThreadIds,
    queryText,
    queryTerms: [...activeEntityIds, ...(contract.locationId ? [contract.locationId] : []), ...threadIds],
    povCharacterId: contract.povCharacterId ?? null,
    tokenizerVersion: SCENE_RECALL_TOKENIZER_VERSION,
    bm25Version: SCENE_RECALL_BM25_VERSION,
    topK: finiteConfigInt(config, 'sceneRecallTopK', 6, 1, 200),
    budget: finiteConfigInt(config, 'sceneRecallBudget', 6, 0, 200)
  }
}

function hardConstraintText(config: Record<string, unknown>): string {
  const snapshot = config.strongConstraints as Parameters<typeof buildStrongConstraintSystemPrompt>[0] | undefined
  if (snapshot && typeof snapshot === 'object' && snapshot.enabled === true) return [authorAgreementPrompt(config), buildStrongConstraintSystemPrompt(snapshot, frozenWritingForm(config))].filter(Boolean).join('\n\n')
  if (frozenWritingForm(config)) return authorAgreementPrompt(config)
  return '（未提供硬约束；不得自行补写。）'
}

function workingSetMessageContent(result: SceneContextCompileResult): string {
  return result.workingSetMessage.messages[0]?.content ?? ''
}

/** v2 currently has no auditable tool/assistant continuation in the writer
 * Working Set envelope.  Keep the role/content hash complete by rejecting
 * every optional DsMessage wire field at this boundary; a future tool-aware
 * v2 envelope must deliberately add a canonical wire serializer instead of
 * silently allowing fields that providerEnvelopeHash does not cover. */
function assertSceneWorkingSetEnvelopeShape(messages: readonly DsMessage[]): void {
  if (!Array.isArray(messages) || messages.length === 0 || messages.some((message) => {
    if (!message || typeof message !== 'object' || !['system', 'user'].includes(message.role) || typeof message.content !== 'string') return true
    return Object.keys(message).some((key) => key !== 'role' && key !== 'content')
  })) throw new Error('scene_working_set_provider_envelope_invalid')
}

function auxSourceType(role: DsMessage['role']): ContextCandidate['source']['sourceType'] {
  if (role === 'system') return 'frozen_system'
  if (role === 'tool') return 'active_tool_pair'
  if (role === 'assistant') return 'recent_turn'
  return 'current_input'
}

function legacyPromptHash(messages: DsMessage[]): string {
  // R42's writer manifest hashes the exact wire content sequence. Keep this
  // content-only hash for the compatibility manifest; the v2 envelope hash
  // additionally binds role/byte lengths for provenance.
  return contextHash(messages.map((message) => message.content ?? '').join(''))
}

function numericConfig(config: Record<string, unknown>, key: string): number | null {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function acceptedSegmentOrder(a: { chunk_index: number; revision: number; created_at: number; segment_id: string }, b: { chunk_index: number; revision: number; created_at: number; segment_id: string }): number {
  return a.chunk_index - b.chunk_index || a.revision - b.revision || a.created_at - b.created_at || a.segment_id.localeCompare(b.segment_id)
}

/**
 * Build the exact accepted prefix hash without concatenating the manuscript.
 * The content itself is bounded to a recent tail below; the hash remains a
 * hash of all accepted prose so a manifest cannot be reused after acceptance
 * changed elsewhere in the run.
 */
function acceptedPrefixSnapshot(repo: Repository, runId: string, currentContract: SceneContract, recentChars: number, ledger: ReturnType<Repository['getNarrativeLedger']>): AcceptedNarrativePrefixSnapshot {
  const accepted = repo.getManuscriptSegmentsByRun(runId)
    .filter((segment) => segment.status === 'accepted' && segment.kind === 'prose')
    .sort(acceptedSegmentOrder)
  const hash = createHash('sha256')
  let acceptedCharCount = 0
  let readBytes = 0
  const contractBySegment = new Map<string, string>()
  // Empty deltas are valid and do not provide a contract hash for a segment;
  // only use a ledger binding when one is durably present.  The current scene
  // state supplies the frozen contract identity for its own accepted tail.
  for (const entry of ledger) {
    if (!contractBySegment.has(entry.acceptedSegmentId)) contractBySegment.set(entry.acceptedSegmentId, entry.contractHash)
  }
  for (const segment of accepted) {
    if (segment.content_hash !== contextHash(segment.content) || segment.char_count !== codePointLength(segment.content)) throw new Error('narrative_context_accepted_segment_invalid')
    hash.update(segment.content, 'utf8')
    acceptedCharCount += segment.char_count
    readBytes += Buffer.byteLength(segment.content, 'utf8')
  }
  const recent: NarrativeContextRecentProse[] = []
  let selectedChars = 0
  for (let index = accepted.length - 1; index >= 0; index--) {
    const segment = accepted[index]!
    // An accepted segment without scene identity cannot be truthfully placed
    // in a scene-scoped manifest.  It still participates in the prefix hash.
    if (!segment.scene_id) continue
    const contractHash = contractBySegment.get(segment.segment_id)
    // A legacy accepted row with no ledger binding is safe to expose only
    // while it belongs to the currently frozen scene.  Older/unscoped rows
    // remain covered by the prefix hash, but never cross the manifest
    // boundary as recent prose without durable contract provenance.
    if (!contractHash && segment.scene_id !== currentContract.sceneId) continue
    const candidateChars = segment.char_count
    if (recent.length > 0 && selectedChars + candidateChars > recentChars) continue
    recent.push({
      segmentId: segment.segment_id,
      runId: segment.run_id,
      sceneId: segment.scene_id,
      content: segment.content,
      contentHash: segment.content_hash,
      contractHash: contractHash ?? currentContract.frozenHash,
      revision: segment.revision
    })
    selectedChars += candidateChars
    if (selectedChars >= recentChars) break
  }
  recent.reverse()
  return { schemaVersion: 1, hash: hash.digest('hex'), acceptedCharCount, acceptedSegmentCount: accepted.length, recentProse: recent, readBytes, cacheHit: false, cacheRevision: 0 }
}

function currentNarrativeContract(repo: Repository, runId: string, config: Record<string, unknown>): SceneContract | null {
  if (config.sceneContracts === undefined || config.sceneContracts === null) return null
  const plan = config.sceneContracts as SceneContractPlan
  if (!sceneContractPlanValid(plan)) throw new Error('narrative_context_contract_invalid')
  const states = repo.getSceneStates(runId)
  const state = states.find((item) => item.lifecycle !== 'committed')
  // All scene commits can precede the global target/natural-ending boundary.
  // Keep the last frozen identity for the same Working Set source fence; the
  // repository marks its tail as closing and the compiler does not reissue
  // this completed scene's beats as an active writing assignment.
  if (!state) {
    if (states.length !== plan.contracts.length || !states.every(item => item.lifecycle === 'committed')) throw new Error('narrative_context_scene_unavailable')
    const last = [...plan.contracts].sort((a, b) => a.order - b.order).at(-1)
    const committed = states.find(item => item.sceneId === last?.sceneId)
    if (!last || committed?.contractHash !== last.frozenHash || committed.contractId !== last.contractId) throw new Error('narrative_context_scene_identity_mismatch')
    return last
  }
  const contract = plan.contracts.find((item) => item.sceneId === state.sceneId)
  if (!contract || contract.contractId !== state.contractId || contract.frozenHash !== state.contractHash) throw new Error('narrative_context_scene_identity_mismatch')
  return contract
}

/** Read the repository-authoritative corpus, deterministically select it, and
 * compile/persist one immutable Scene Working Set.  The returned fence repeats
 * every read-side check immediately before the provider boundary. */
function buildSceneWorkingSetRuntime(repo: Repository, config: Record<string, unknown>, runId: string, requestId: string, budgetTokens: number): SceneWorkingSetRuntime {
  const freshness = repo.getStoryLedgerFreshness(runId)
  const genesis = freshness && freshness.runRevision === 0 && freshness.headRevision === 0 && freshness.headHash === null
    ? storyLedgerGenesisHeadHash(freshness.scope, freshness.validityEpoch)
    : null
  if (!freshness || !freshness.fresh || freshness.runRevision < 0 || freshness.headRevision < freshness.runRevision || freshness.headHash === null && genesis === null) throw new Error('scene_working_set_head_mismatch')
  // Repository freshness keeps the real DB value (NULL at genesis) so the
  // story-ledger freshness assertion remains an exact null check.  Recall and
  // compiler scopes receive the unique content-addressed genesis sentinel.
  const recallHeadHash = freshness.headHash ?? genesis
  if (!recallHeadHash) throw new Error('scene_working_set_head_mismatch')
  const contract = currentNarrativeContract(repo, runId, config)
  if (!contract) throw new Error('scene_working_set_contract_missing')
  const requiredFacts = resolveSceneRequiredFacts(repo, config, contract)
  const expectedFence = {
    runId,
    expectedRevision: freshness.runRevision,
    expectedEpoch: freshness.validityEpoch,
    expectedHeadRevision: freshness.headRevision,
    expectedHeadHash: freshness.headHash
  }
  const branchLineage = [...(freshness.branchLineage ?? [freshness.scope.branchId])]
  const fence = {
    storyId: freshness.scope.storyId,
    projectId: freshness.scope.projectId,
    branchId: freshness.scope.branchId,
    branchLineage,
    validityEpoch: freshness.validityEpoch,
    storyRevision: freshness.runRevision,
    headRevision: freshness.headRevision,
    headHash: recallHeadHash
  }
  let snapshot: SceneRecallCorpusSnapshot
  try {
    snapshot = repo.getSceneRecallCorpusSnapshot({ runId, sceneId: contract.sceneId, povCharacterId: contract.povCharacterId ?? null, currentSceneTail: { contractHash: contract.frozenHash, recentChars: SCENE_WORKING_SET_CURRENT_TAIL_CHARS }, expectedFence: fence })
  } catch (error) {
    throw new Error(`scene_working_set_snapshot_mismatch:${error instanceof Error ? error.message : String(error)}`)
  }
  const scope: SceneRecallQuery['scope'] = { ...snapshot.scope, expectedSourceCardSetHash: snapshot.sourceCardSetHash }
  const query = sceneContractQuery(contract, scope, config, requiredFacts)
  let recall: SceneRecallIndexResult
  try {
    recall = buildDeterministicRecallIndex({ corpus: snapshot.corpus, query })
  } catch (error) {
    throw new Error(`scene_working_set_recall_mismatch:${error instanceof Error ? error.message : String(error)}`)
  }
  if (recall.status === 'blocked_required_sources' || recall.blockedHardDependencies.length > 0) throw new Error('scene_working_set_recall_blocked')
  let result: SceneContextCompileResult
  try {
    result = compileSceneWorkingSet({
      snapshot,
      recall,
      recallQuery: query,
      contract,
      hardConstraints: hardConstraintText(config),
      requiredFacts,
      budgetTokens,
      workingSetId: `ws_${contextHash(`${runId}\u0000${contract.sceneId}\u0000${requestId}`).slice(0, 24)}`,
      requiredCardIds: recall.candidates.filter((candidate) => candidate.sortTuple[0] === 1).map((candidate) => candidate.cardId)
    })
  } catch (error) {
    throw new Error(`scene_working_set_compile_failed:${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    repo.saveSceneWorkingSet({
      workingSet: result.workingSet,
      manifest: result.manifest,
      workingSetMessage: result.workingSetMessage,
      branchLineage,
      branchCutoffs: {}
    })
    repo.saveRunEvidence(runId, `scene_working_set:${requestId}`, JSON.stringify({ schemaVersion: 1, requestId, workingSetId: result.workingSet.workingSetId, workingSetHash: result.workingSet.workingSetHash, manifestHash: result.manifest.manifestHash, messageHash: result.workingSetMessage.messageHash, sourceSnapshotHash: snapshot.sourceSnapshotHash, sourceCardSetHash: snapshot.sourceCardSetHash, queryHash: recall.queryHash, indexHash: recall.indexHash, recallStatus: recall.status, candidateIds: recall.candidates.map((candidate) => candidate.cardId), omitted: recall.omitted, requiredFacts, requestedRequiredFactIds: [...new Set(contract.requiredFactIds ?? [])], validityEpoch: freshness.validityEpoch, storyRevision: freshness.runRevision, headRevision: freshness.headRevision, headHash: freshness.headHash }))
  } catch (error) {
    throw new Error(`scene_working_set_persist_failed:${error instanceof Error ? error.message : String(error)}`)
  }
  const runtime: SceneWorkingSetRuntime = { result, snapshot, query, recall, requiredFacts, workingSetHash: result.workingSet.workingSetHash, expectedFence }
  return runtime
}

function assertSceneWorkingSetRuntime(repo: Repository, runtime: SceneWorkingSetRuntime, config: Record<string, unknown>, runId: string, messages: DsMessage[], phase: 'prebind' | 'postbind' = 'postbind'): void {
  assertSceneWorkingSetEnvelopeShape(messages)
  const expectedEnvelopeHash = messageEnvelopeHash(messages)
  try {
    repo.assertStoryLedgerFresh(runtime.expectedFence)
  } catch (error) {
    throw new Error(`scene_working_set_head_mismatch:${error instanceof Error ? error.message : String(error)}`)
  }
  const persisted = repo.getSceneWorkingSet(runtime.result.workingSet.workingSetId)
  if (!persisted || persisted.status !== 'active' || persisted.workingSetHash !== runtime.workingSetHash || persisted.manifestHash !== runtime.result.manifest.manifestHash || persisted.workingSetMessageHash !== runtime.result.workingSetMessage.messageHash) throw new Error('scene_working_set_manifest_mismatch')
  const persistedEnvelopeHash = persisted.finalEnvelopeHash ?? null
  if (phase === 'prebind') {
    // A fresh compiler record must not carry an unverified envelope.  A
    // restart may already have the same immutable binding; accepting it is
    // safe only when it proves the exact messages about to be sent.
    if (persistedEnvelopeHash !== null && persistedEnvelopeHash !== expectedEnvelopeHash) throw new Error('scene_working_set_final_envelope_mismatch')
  } else if (persistedEnvelopeHash !== expectedEnvelopeHash) {
    throw new Error('scene_working_set_final_envelope_mismatch')
  }
  let currentSnapshot: SceneRecallCorpusSnapshot
  try {
    const fence = {
      storyId: runtime.snapshot.scope.storyId,
      projectId: runtime.snapshot.scope.projectId,
      branchId: runtime.snapshot.scope.branchId,
      branchLineage: [...runtime.snapshot.scope.branchLineage],
      validityEpoch: runtime.snapshot.scope.validityEpoch,
      storyRevision: runtime.snapshot.scope.storyRevision,
      headRevision: runtime.snapshot.scope.headRevision,
      headHash: runtime.snapshot.scope.headHash,
      expectedSourceCardSetHash: runtime.snapshot.sourceCardSetHash
    }
    currentSnapshot = repo.getSceneRecallCorpusSnapshot({ runId, sceneId: runtime.snapshot.sceneId, povCharacterId: runtime.query.povCharacterId ?? null, currentSceneTail: { contractHash: runtime.result.workingSet.contractHash, recentChars: SCENE_WORKING_SET_CURRENT_TAIL_CHARS, expectedTailHash: runtime.snapshot.currentSceneTail?.tailHash }, expectedFence: fence })
  } catch (error) {
    throw new Error(`scene_working_set_source_mismatch:${error instanceof Error ? error.message : String(error)}`)
  }
  if (currentSnapshot.sourceSnapshotHash !== runtime.snapshot.sourceSnapshotHash || currentSnapshot.sourceCardSetHash !== runtime.snapshot.sourceCardSetHash) throw new Error('scene_working_set_source_mismatch')
  const query: SceneRecallQuery = { ...runtime.query, scope: { ...runtime.query.scope, expectedSourceCardSetHash: currentSnapshot.sourceCardSetHash } }
  let recall: SceneRecallIndexResult
  try { recall = buildDeterministicRecallIndex({ corpus: currentSnapshot.corpus, query }) } catch (error) { throw new Error(`scene_working_set_index_mismatch:${error instanceof Error ? error.message : String(error)}`) }
  if (stableSceneMemoryJson(recall) !== stableSceneMemoryJson(runtime.recall)) throw new Error('scene_working_set_index_mismatch')
  let recompiled: SceneContextCompileResult
  try {
    const contract = currentNarrativeContract(repo, runId, config)
    if (!contract) throw new Error('scene_working_set_contract_missing')
    const requiredFacts = resolveSceneRequiredFacts(repo, config, contract)
    const expectedQuery = sceneContractQuery(contract, query.scope, config, requiredFacts)
    if (stableSceneMemoryJson(expectedQuery) !== stableSceneMemoryJson(runtime.query)) throw new Error('scene_working_set_required_fact_mismatch')
    recompiled = compileSceneWorkingSet({ snapshot: currentSnapshot, recall, recallQuery: expectedQuery, contract, hardConstraints: hardConstraintText(config), requiredFacts, budgetTokens: runtime.result.workingSet.budgetTokens, workingSetId: runtime.result.workingSet.workingSetId, requiredCardIds: recall.candidates.filter((candidate) => candidate.sortTuple[0] === 1).map((candidate) => candidate.cardId) })
  } catch (error) {
    throw new Error(`scene_working_set_manifest_mismatch:${error instanceof Error ? error.message : String(error)}`)
  }
  if (recompiled.manifest.manifestHash !== runtime.result.manifest.manifestHash || recompiled.workingSet.workingSetHash !== runtime.result.workingSet.workingSetHash || recompiled.workingSetMessage.messageHash !== runtime.result.workingSetMessage.messageHash) throw new Error('scene_working_set_manifest_mismatch')
  const content = workingSetMessageContent(runtime.result)
  const messageCount = messages.filter((message) => message.role === 'system' && message.content === content).length
  const userCount = messages.filter((message) => message.role === 'user').length
  if (messageCount !== 1 || userCount !== 1 || sceneWorkingSetHash([{ role: 'system', content }]) !== runtime.result.workingSetMessage.messageHash) throw new Error('scene_working_set_message_mismatch')
}

function narrativeCandidate(repo: Repository, config: Record<string, unknown>, runId: string, requestId: string, inputBudgetTokens: number, manifestMode: 'full' | 'optimized' | 'minimal', purpose: 'writer' | 'critic' | 'editor'): { candidate: ContextCandidate; prefixSnapshot: AcceptedNarrativePrefixSnapshot } | null {
  // Durable narrative state is safety context, not an optimization-only
  // feature.  The mode controls optional history/retrieval below; every
  // longwrite writer envelope receives the frozen SceneContract and the
  // registry/ledger facts that can be resolved for it.
  if (purpose !== 'writer' || !isLongWriteConfig(config) || isLongwriteV2Config(config) || isEditorialWriting(config)) return null
  const contract = currentNarrativeContract(repo, runId, config)
  if (!contract) return null
  const sessionId = typeof config.sessionId === 'string' ? config.sessionId : ''
  const grill = config.grillMe as { answers?: Array<{ slotId: string; value: string; source?: string }> } | undefined
  if (grill && sessionId) {
    if ((config.grillMe as { approvedOutline?: unknown }).approvedOutline) materializeConfirmedGrillFacts(repo, config, runId)
    else {
      // Compatibility for pre-confirmation legacy snapshots only.
      const generated = buildNarrativeFactsFromGrill({ sessionId, runId, answers: grill.answers ?? [] })
      for (const fact of generated) repo.upsertNarrativeFact(fact)
    }
  }
  const facts: NarrativeFact[] = sessionId ? repo.getNarrativeFacts(sessionId) : []
  const requireFactRegistry = Boolean(grill && Array.isArray(grill.answers))
  const configuredTokens = numericConfig(config, 'narrativeContextBudgetTokens')
  const configuredChars = numericConfig(config, 'narrativeContextBudgetChars')
  const maxTokens = Math.max(256, Math.min(configuredTokens ?? NARRATIVE_CONTEXT_DEFAULT_MAX_TOKENS, Math.max(256, inputBudgetTokens)))
  const maxChars = Math.max(1, Math.min(configuredChars ?? NARRATIVE_CONTEXT_DEFAULT_MAX_CHARS, maxTokens * 4))
  const storyScopeInfo = repo.getNarrativeLedgerScope?.(runId) ?? null
  if (storyScopeInfo && storyScopeInfo.epochValid === false) throw new Error('story_ledger_epoch_invalidated')
  const ledger = repo.getNarrativeLedger(runId)
  const storyScope = storyScopeInfo
    ? { schemaVersion: storyScopeInfo.schemaVersion, storyId: storyScopeInfo.storyId, projectId: storyScopeInfo.projectId, branchId: storyScopeInfo.branchId }
    : undefined
  // Production repositories maintain an invalidation-aware durable prefix
  // cursor.  It reads only the bounded recent tail here; legacy test doubles
  // retain the old scan as an explicit compatibility fallback.
  const prefix = repo.getAcceptedNarrativePrefixSnapshot
    ? repo.getAcceptedNarrativePrefixSnapshot({
        runId,
        recentChars: Math.min(NARRATIVE_CONTEXT_RECENT_PROSE_CHARS, maxChars),
        currentSceneId: contract.sceneId,
        currentContractHash: contract.frozenHash,
        ledger: ledger.map((entry) => ({ acceptedSegmentId: entry.acceptedSegmentId, contractHash: entry.contractHash }))
      })
    : acceptedPrefixSnapshot(repo, runId, contract, Math.min(NARRATIVE_CONTEXT_RECENT_PROSE_CHARS, maxChars), ledger)
  const manifest = buildNarrativeContextManifest({
    runId,
    sessionId,
    contract,
    ledger,
    facts,
    requireFactRegistry,
    mode: manifestMode,
    recentProse: prefix.recentProse,
    acceptedPrefixHash: prefix.hash,
    ...(storyScopeInfo ? { storyScope, storyRevision: storyScopeInfo.currentRevision, storyHighWatermark: storyScopeInfo.highWatermark, storyValidityEpoch: storyScopeInfo.validityEpoch } : {}),
    budget: { maxChars, maxTokens }
  })
  const wire = renderNarrativeContextManifest(manifest)
  // Evidence is saved before the ContextV2 manifest and before provider send;
  // requestId makes each attempt immutable while the embedded hash binds the
  // structured selector output to the exact accepted prefix/contract.
  repo.saveRunEvidence(runId, `narrative_context_manifest:${requestId}`, JSON.stringify({ schemaVersion: 1, requestId, manifest }))
  return {
    candidate: {
      source: {
        sourceType: 'narrative_manifest',
        canonicalId: manifest.manifestId,
        revision: manifest.materializedRevision,
        contentHash: manifest.manifestHash,
        span: null,
        displayLabel: `叙事状态清单 · ${manifest.manifestHash.slice(0, 12)}`
      },
      role: 'system',
      content: `## 已接受叙事状态（结构化清单 ${manifest.manifestHash}）\n${wire}`,
      required: true,
      order: 25
    },
    prefixSnapshot: prefix
  }
}

export function createContextService(repo: Repository, v2?: ContextV2Service | null, onLongformRecallAudit?: (projection: LongformRecallAuditProjection) => Promise<void> | void) {
  return {
    async assembleRunContext(config: Record<string, unknown>, round: number, live: DsMessage[], prefix: DsMessage[], purpose: 'writer' | 'critic' | 'editor' = 'writer', requestId = `${String(config.clientRequestId ?? 'run')}:${purpose}:${round}`, stageId: string = purpose): Promise<AssembleRunContextResult> {
      if (purpose === 'writer') prefix = writerPrefixForForm(config, prefix, isLongwriteV2Config(config))
      const runId = typeof config.clientRequestId === 'string' ? config.clientRequestId : 'run'
      const sessionId = typeof config.sessionId === 'string' ? config.sessionId : ''
      const policy = (config.contextPolicy ?? {}) as { contextWindowTokens?: number; outputReserveTokens?: number }
      const windowTokens = policy.contextWindowTokens ?? 1_048_576
      const reserve = policy.outputReserveTokens ?? 8192
      // The longwrite engine already supplies a bounded working set containing
      // frozen constraints, chapter summaries and the recent durable tail.
      // Re-selecting the complete session history here would silently put the
      // manuscript back into every provider envelope, defeating compaction.
      // Keep pins/immutable prefixes available, but never rehydrate canonical
      // user/assistant history for a longwrite writer call.
      const longwrite = isLongWriteConfig(config)
      const frozenContext = config.frozenContext as FrozenContextSnapshotV2 | undefined
        // Ordinary work keeps its original task in the canonical prefix;
        // steering stays after the completed assistant/tool chain in live.
        const user = config.runMode === 'agent' && config.longMode !== true
          ? live.find(message => message.role === 'user')
          : [...live].reverse().find((message) => message.role === 'user')

      // v1.2.5 production longwrite: the repository-authenticated Working Set
      // is the only narrative projection.  Do not let the generic selector
      // re-add chapter summaries, recent prose, rolling summaries or the
      // current SceneContract a second time.
      if (purpose === 'writer' && isLongwriteV2Config(config)) {
        materializeConfirmedGrillFacts(repo, config, runId)
        const profile = selectedStage(config, purpose)
        const inputBudgetTokens = (profile?.contextBudget?.contextWindowTokens ?? profile?.model.contextWindow ?? windowTokens) - (profile?.contextBudget?.outputReserveTokens ?? profile?.generation.maxOutputTokens ?? reserve)
        const configuredWorkingSetBudget = numericConfig(config, 'sceneWorkingSetBudgetTokens')
        const workingSetBudget = Math.max(3072, Math.min(8192, configuredWorkingSetBudget ?? 4096))
        const runtime = buildSceneWorkingSetRuntime(repo, config, runId, requestId, Math.min(workingSetBudget, Math.max(3072, inputBudgetTokens)))
        if (onLongformRecallAudit) {
          await onLongformRecallAudit({
            runId,
            sessionId,
            storyId: runtime.snapshot.scope.storyId,
            projectId: runtime.snapshot.scope.projectId,
            branchId: runtime.snapshot.scope.branchId,
            sceneId: runtime.snapshot.scope.sceneId,
            validityEpoch: runtime.snapshot.scope.validityEpoch,
            storyRevision: runtime.snapshot.scope.storyRevision,
            workingSetHash: runtime.result.workingSet.workingSetHash,
            manifestHash: runtime.result.manifest.manifestHash,
            sourceSnapshotHash: runtime.snapshot.sourceSnapshotHash,
            sourceCardSetHash: runtime.snapshot.sourceCardSetHash,
            queryHash: runtime.recall.queryHash,
            indexHash: runtime.recall.indexHash,
            audit: projectLongformWorkflowRecallAudit({ recall: runtime.recall, corpus: runtime.snapshot.corpus })
          })
        }
        const workingSetMessage = runtime.result.workingSetMessage.messages[0]
        if (!workingSetMessage) throw new Error('scene_working_set_message_missing')
        if (!user) throw new Error('scene_working_set_current_user_missing')
        const messages: DsMessage[] = [
          ...prefix,
          workingSetMessage,
          ...(user ? [{ role: 'user' as const, content: user.content ?? '' }] : [])
        ]
        if (messages.filter((message) => message.role === 'user').length !== 1) throw new Error('scene_working_set_user_envelope_invalid')
        const totalTokens = messages.reduce((sum, message) => sum + estimateTokens(message.content ?? ''), 0)
        const legacyManifest: ContextManifest = {
          schemaVersion: 1,
          runId,
          round,
          createdAt: Date.now(),
          contextWindowTokens: profile?.contextBudget?.contextWindowTokens ?? profile?.model.contextWindow ?? windowTokens,
          outputReserveTokens: profile?.contextBudget?.outputReserveTokens ?? profile?.generation.maxOutputTokens ?? reserve,
          budgetTokens: inputBudgetTokens,
          totalTokens,
          overBudget: totalTokens > inputBudgetTokens,
          cacheablePrefixHash: contextHash(prefix.filter((message) => message.role === 'system').map((message) => message.content ?? '').join('\n')),
          promptHash: legacyPromptHash(messages),
          segments: [{ id: `scene-working-set-${requestId}`, kind: 'history', sourceIds: [runtime.result.workingSet.workingSetId], estimatedTokens: totalTokens, actualTokens: totalTokens, droppedReason: null, summaryVersion: null, hash: runtime.result.manifest.manifestHash, cacheable: false }]
        }
        if (legacyManifest.overBudget) throw new Error('scene_working_set_required_overflow')
        const contextV2: ContextManifestV2 | null = v2 && frozenContext?.schemaVersion === 2 && frozenContext.mode !== 'legacy_v1' && frozenContext.policy
          ? {
            schemaVersion: 2,
            manifestId: `ctx_${contextHash(requestId).slice(0, 24)}`,
            runId,
            stageId,
            requestId,
            roundIndex: round,
            createdAt: new Date().toISOString(),
            mode: frozenContext.mode,
            policySnapshot: frozenContext.policy,
            policyRevision: frozenContext.policyRevision,
            providerId: profile?.provider.id ?? 'legacy',
            modelId: profile?.model.remoteModelId ?? String(config.model ?? 'unknown'),
            capabilityFingerprint: frozenContext.capabilityFingerprint,
            inputBudgetTokens,
            outputReserveTokens: profile?.contextBudget?.outputReserveTokens ?? profile?.generation.maxOutputTokens ?? reserve,
            selectedEstimate: { value: totalTokens, kind: 'local_estimate', sourceId: runtime.result.manifest.manifestHash, estimatorVersion: runtime.result.manifest.estimatorVersion },
            fullBaselineEstimate: { value: totalTokens, kind: 'local_estimate', sourceId: runtime.result.manifest.manifestHash, estimatorVersion: runtime.result.manifest.estimatorVersion },
            estimatedSavedTokens: 0,
            estimatedSavingsRatio: 0,
            summaryRef: null,
            retrieval: null,
            pinRevision: frozenContext.pinRevision,
            sourceSetHash: sourceSetHash(messages),
            envelopeHash: '',
            decisions: messages.map((message, index) => ({
              itemId: contextHash(`${requestId}:scene:${index}:${message.role}`).slice(0, 24),
              source: source(message.role === 'user' ? 'current_input' : 'frozen_system', `${requestId}:scene:${index}`, message.content ?? '', message === workingSetMessage ? 'Scene Working Set' : message.role === 'user' ? '当前输入' : '冻结系统'),
              required: true,
              included: true,
              selectionReason: 'required' as const,
              rankScore: null,
              selectedEstimatedTokens: estimateTokens(message.content ?? ''),
              providerActualTokens: null
            })),
            persistedBeforeProviderSend: true,
            narrativeWorkingSet: {
              workingSetId: runtime.result.workingSet.workingSetId,
              workingSetHash: runtime.result.workingSet.workingSetHash,
              manifestHash: runtime.result.manifest.manifestHash,
              messageHash: runtime.result.workingSetMessage.messageHash,
              sourceSnapshotHash: runtime.snapshot.sourceSnapshotHash,
              sourceCardSetHash: runtime.snapshot.sourceCardSetHash,
              queryHash: runtime.recall.queryHash,
              indexHash: runtime.recall.indexHash,
              validityEpoch: runtime.snapshot.scope.validityEpoch,
              storyRevision: runtime.snapshot.scope.storyRevision,
              headRevision: runtime.snapshot.scope.headRevision,
              headHash: runtime.snapshot.scope.headHash
            }
          }
          : null
        const fence = (finalMessages: DsMessage[], phase: 'prebind' | 'postbind' = 'postbind'): void => assertSceneWorkingSetRuntime(repo, runtime, config, runId, finalMessages, phase)
        const persistSceneEnvelope = (finalMessages: DsMessage[]): void => {
          const envelopeHash = messageEnvelopeHash(finalMessages)
          repo.bindSceneWorkingSetFinalEnvelope({ workingSetId: runtime.result.workingSet.workingSetId, finalEnvelope: finalMessages })
          repo.saveRunEvidence(runId, `scene_working_set_envelope:${requestId}`, JSON.stringify({ schemaVersion: 1, requestId, workingSetId: runtime.result.workingSet.workingSetId, workingSetHash: runtime.result.workingSet.workingSetHash, manifestHash: runtime.result.manifest.manifestHash, messageHash: runtime.result.workingSetMessage.messageHash, envelopeHash, messageCount: finalMessages.length, contentHash: sourceSetHash(finalMessages), persistedAt: Date.now() }))
        }
        return { messages, manifest: legacyManifest, userContent: user.content ?? null, contextV2, sceneWorkingSetFence: fence, persistSceneEnvelope, suppressLive: true }
      }

      if (v2 && frozenContext?.schemaVersion === 2 && frozenContext.mode !== 'legacy_v1' && frozenContext.policy) {
        const profile = selectedStage(config, purpose)
        const inputBudgetTokens = (profile?.contextBudget?.contextWindowTokens ?? profile?.model.contextWindow ?? windowTokens) - (profile?.contextBudget?.outputReserveTokens ?? profile?.generation.maxOutputTokens ?? reserve)
        const manifestMode = frozenContext.mode
        const frozenPolicy = frozenContext.policy
        const makeManifest = (selection: ReturnType<typeof selectContextCandidates>, messages: DsMessage[]): { legacy: ContextManifest; v2: ContextManifestV2 } => {
          const totalTokens = messages.reduce((sum, message) => sum + estimateTokens(message.content ?? ''), 0)
          const legacyManifest: ContextManifest = {
            schemaVersion: 1, runId, round, createdAt: Date.now(), contextWindowTokens: profile?.contextBudget?.contextWindowTokens ?? profile?.model.contextWindow ?? windowTokens,
            outputReserveTokens: profile?.contextBudget?.outputReserveTokens ?? profile?.generation.maxOutputTokens ?? reserve, budgetTokens: inputBudgetTokens, totalTokens, overBudget: false,
            cacheablePrefixHash: contextHash(prefix.filter((message) => message.role === 'system').map((message) => message.content ?? '').join('\n')),
            promptHash: legacyPromptHash(messages),
            segments: [{ id: `r45-${requestId}`, kind: 'history', sourceIds: selection.decisions.filter((entry) => entry.included).map((entry) => entry.source.canonicalId), estimatedTokens: totalTokens, actualTokens: totalTokens, droppedReason: null, summaryVersion: frozenContext.summary?.version ?? null, hash: contextHash(selection.decisions.filter((entry) => entry.included).map((entry) => entry.itemId).join('|')), cacheable: false }]
          }
          const manifestV2: ContextManifestV2 = {
            schemaVersion: 2, manifestId: `ctx_${contextHash(requestId).slice(0, 24)}`, runId, stageId, requestId, roundIndex: round, createdAt: new Date().toISOString(), mode: manifestMode,
            policySnapshot: frozenPolicy, policyRevision: frozenContext.policyRevision, providerId: profile?.provider.id ?? 'legacy', modelId: profile?.model.remoteModelId ?? String(config.model ?? 'unknown'),
            capabilityFingerprint: frozenContext.capabilityFingerprint, inputBudgetTokens, outputReserveTokens: profile?.contextBudget?.outputReserveTokens ?? profile?.generation.maxOutputTokens ?? reserve,
            selectedEstimate: { value: selection.selectedEstimate, kind: 'local_estimate', sourceId: null, estimatorVersion: frozenContext.estimatorVersion },
            fullBaselineEstimate: { value: selection.fullBaselineEstimate, kind: 'local_estimate', sourceId: null, estimatorVersion: frozenContext.estimatorVersion },
            estimatedSavedTokens: Math.max(0, selection.fullBaselineEstimate - selection.selectedEstimate), estimatedSavingsRatio: selection.fullBaselineEstimate > 0 ? Math.max(0, selection.fullBaselineEstimate - selection.selectedEstimate) / selection.fullBaselineEstimate : 0,
            summaryRef: frozenContext.summary, retrieval: manifestMode === 'optimized' && purpose === 'writer' ? { retrieverVersion: frozenContext.retrieverVersion ?? 'bm25-local-v1', indexVersion: frozenContext.retrievalIndexVersion ?? 'canonical-session-v1', queryHash: contextHash(user?.content ?? '') } : null,
            pinRevision: frozenContext.pinRevision, sourceSetHash: contextHash(selection.decisions.filter((entry) => entry.included).map(sourceIdentity).sort().join('\u0001')), envelopeHash: '', decisions: selection.decisions, persistedBeforeProviderSend: true
          }
          return { legacy: legacyManifest, v2: manifestV2 }
        }

        // Critic/editor payloads are already complete, purpose-specific
        // envelopes.  Keep every byte and its order; injecting writer memory,
        // Story Bible, or session history here changes the R42 contract.
        if (purpose !== 'writer') {
          const auxCandidates = live.map((message, index) => ({
            source: source(auxSourceType(message.role), `${runId}:${purpose}:${index}`, message.content ?? '', `${purpose} ${message.role}`),
            role: message.role, content: message.content ?? '', required: true, order: index
          }))
          const selection = selectContextCandidates({ mode: 'full', policy: { ...frozenPolicy, mode: 'full' }, budgetTokens: inputBudgetTokens, query: '', base: auxCandidates, history: [], summary: null })
          const messages = selection.selected.filter((candidate) => !candidate.virtual).sort((a, b) => a.order - b.order).map((candidate) => ({ role: candidate.role, content: candidate.content } as DsMessage))
          const packed = makeManifest(selection, messages)
          return { messages, manifest: packed.legacy, userContent: user?.content ?? null, contextV2: packed.v2 }
        }

        // The run prefix is the canonical wire source.  These virtual required
        // aliases preserve provenance for Story Bible/plan/constraints without
        // sending their JSON a second time (and therefore cannot double count).
        const strong = config.strongConstraints as { sourceTask?: string; task?: string } | undefined
        const storyValue = config.story
        const requiredAliases: Array<{ sourceType: ContextCandidate['source']['sourceType']; label: string; content: string }> = [
          { sourceType: 'current_task', label: '当前任务', content: String(strong?.sourceTask ?? strong?.task ?? config.task ?? user?.content ?? '') },
          { sourceType: 'approved_plan', label: '已批准计划', content: String(config.planText ?? '') },
          { sourceType: 'story_bible', label: 'Story Bible', content: storyValue == null ? '' : JSON.stringify(storyValue) },
          { sourceType: 'hard_constraint', label: '主题与写作强约束', content: config.strongConstraints == null ? '' : JSON.stringify(config.strongConstraints) }
        ]
        const candidates: ContextCandidate[] = buildFrozenPrefixCandidates(runId, prefix, requiredAliases)
        const structuredNarrative = narrativeCandidate(repo, config, runId, requestId, inputBudgetTokens, manifestMode, purpose)
        if (structuredNarrative) candidates.push(structuredNarrative.candidate)

        const currentId = `m_${runId}_user`
        const pinned = sessionId ? v2.resolveFrozenPins(sessionId, frozenContext) : []
        const pinnedMessageIds = new Set(pinned.filter((candidate) => candidate.source.sourceType === 'pinned_message').map((candidate) => candidate.source.canonicalId))
        const pinByMessageId = new Map(pinned.filter((candidate) => candidate.source.sourceType === 'pinned_message').map((candidate) => [candidate.source.canonicalId, candidate]))
        const allHistory = !longwrite && sessionId ? v2.historyCandidates(sessionId, new Set([currentId]), frozenPolicy.management === 'model_auto_v1', frozenContext.historyHighWatermark) : []
        const historyCandidates = allHistory.map((candidate, index) => {
          const pin = pinByMessageId.get(candidate.source.canonicalId)
          return { ...(pin ?? candidate), order: 60 + index, required: Boolean(pin) }
        })
        const historyIds = new Set(historyCandidates.map((candidate) => candidate.source.canonicalId))
        const pinCandidates = pinned.filter((candidate) => candidate.source.sourceType !== 'pinned_message' || !historyIds.has(candidate.source.canonicalId)).map((candidate, index) => ({ ...candidate, order: 35 + index }))
        const selectedHistory = frozenContext.mode === 'full' ? historyCandidates : historyCandidates.filter((candidate) => !pinnedMessageIds.has(candidate.source.canonicalId))
        if (frozenContext.mode !== 'full') candidates.push(...pinned.map((candidate, index) => ({ ...candidate, order: 35 + index })))
        else candidates.push(...pinCandidates)
        if (!longwrite && frozenContext.mode === 'optimized' && frozenContext.summary) {
          const summary = v2.resolveFrozenSummary(sessionId, frozenContext.summary)
          if (summary) candidates.push({ ...v2.summaryCandidate(summary), order: 50 })
        }
        if (user) candidates.push({ source: source('current_input', currentId, user.content ?? '', '当前输入'), role: 'user', content: user.content ?? '', required: true, order: 100 })
        const baseCandidates = candidates.filter((candidate) => candidate.source.sourceType !== 'rolling_summary')
        const summaryCandidate = candidates.find((candidate) => candidate.source.sourceType === 'rolling_summary') ?? null
        const automatic = frozenPolicy.management === 'model_auto_v1'
        // The adapter appends this run's assistant/tool chain after selected
        // canonical history. Reserve it before selection, not after filling
        // the whole model window with history.
        const liveReserve = automatic ? withoutCanonicalUser(live, user?.content).reduce((sum, message) => sum + estimateTokens(JSON.stringify(message)), 0) : 0
        const wireReserve = automatic ? numericConfig(config, 'contextAssemblyReserveTokens') ?? 0 : 0
        // Search backfill is soft headroom: it may trim optional history, but
        // must never reject a current input or frozen pin that otherwise fits.
        const requiredTokens = automatic ? baseCandidates.filter(candidate => candidate.required && !candidate.virtual).reduce((sum, candidate) => sum + estimateTokens(JSON.stringify({ role: candidate.role, content: candidate.content })), 0) : 0
        const readHeadroom = automatic ? Math.max(0, Math.min(numericConfig(config, 'contextOptionalReadReserveTokens') ?? 0, inputBudgetTokens - liveReserve - wireReserve - requiredTokens)) : 0
        // A frozen checkpoint should not lose/reorder quotes merely because
        // another short tool result arrived. Anchor its soft allocation to the
        // same frozen model/prefix. Selection admits it only from unused space,
        // preserving the baseline history/quotes and this request's hard budget.
        const memoryBudgetTokens = automatic && config.runMode === 'agent' && !longwrite
          ? Math.floor(Math.max(0, inputBudgetTokens - wireReserve - (numericConfig(config, 'contextOptionalReadReserveTokens') ?? 0) - requiredTokens) * 0.4)
          : undefined
        const selection = selectContextCandidates({ mode: frozenContext.mode, policy: frozenPolicy, budgetTokens: inputBudgetTokens - liveReserve - wireReserve - readHeadroom, memoryBudgetTokens, query: user?.content ?? '', base: baseCandidates, history: selectedHistory, summary: summaryCandidate })
        // `selected` is insertion-ordered (required items are admitted first);
        // the provider wire must follow canonical source order, as R42 did.
        const messages = selection.messages
        const packed = makeManifest(selection, messages)
        return {
          messages,
          manifest: packed.legacy,
          userContent: user?.content ?? null,
          contextV2: packed.v2,
          ...(structuredNarrative ? { narrativePrefix: {
            acceptedCharCount: structuredNarrative.prefixSnapshot.acceptedCharCount,
            acceptedSegmentCount: structuredNarrative.prefixSnapshot.acceptedSegmentCount,
            readBytes: structuredNarrative.prefixSnapshot.readBytes,
            cacheHit: structuredNarrative.prefixSnapshot.cacheHit,
            cacheRevision: structuredNarrative.prefixSnapshot.cacheRevision
          } } : {})
        }
      }

      const history = purpose === 'writer' && !longwrite && sessionId ? repo.getSessionMessages(sessionId).filter((m) =>
        (m.role === 'user' || m.role === 'assistant') && m.msg_id !== `m_${runId}_user` && !m.msg_id.startsWith('m_' + workSteeringTurnPrefix(runId)) &&
        !(m.msg_id.startsWith('m_steer_') && m.status !== 'done')
      ).map((m) => ({ msgId: m.msg_id, role: m.role as 'user' | 'assistant', content: m.content })) : []
      const memory = purpose === 'writer' ? prefix.filter((m) => m.role === 'system' && MEMORY_PREFIX_RE.test(m.content ?? '')) : []
      const staticSystem = purpose === 'writer' ? prefix.filter((m) => m.role === 'system' && !MEMORY_PREFIX_RE.test(m.content ?? '')) : live.filter((m) => m.role === 'system')
      const attachments = purpose === 'writer' ? prefix.filter((m) => m.role === 'user') : []
      const { messages, manifest } = assembleContext({ runId, round, contextWindowTokens: windowTokens, outputReserveTokens: reserve, staticSystem, memory, attachments, user: user ? { msgId: purpose === 'writer' ? `m_${runId}_user` : `internal:${purpose}:${Math.abs(round)}`, content: user.content ?? '' } : null, history, toolResults: [], assetSummaries: [] })
      repo.saveContextManifest(runId, round, JSON.stringify(manifest))
      return { messages, manifest, userContent: user?.content ?? null, contextV2: null }
    },

    persistContext(manifest: ContextManifestV2, fullMessages: DsMessage[], live: DsMessage[], projection?: LiveToolProjection): ContextManifestV2 {
      if (!v2) throw new Error('上下文账本服务不可用，未发送')
      // The assembler selects canonical sources first; the adapter then adds
      // live tool/assistant items immediately before the provider call.  Record
      // every such item in the immutable manifest so the final envelope can be
      // reconstructed, not just tool rows.
      const liveDecisions = live.map((message, index) => {
        const kind = message.role === 'tool' ? 'active_tool_pair' : message.role === 'user' ? 'current_input' : 'recent_turn'
        const sourceId = message.role === 'user' ? `m_${manifest.runId}_user` : `${manifest.requestId}:live:${index}`
        const label = message.role === 'tool'
          ? `本轮工具结果 ${index + 1}${projection?.excerpts.has(message) ? '（摘录）' : ''}`
          : message.role === 'user' ? '当前输入' : `本轮实时消息 ${index + 1}`
        return {
          itemId: contextHash(`${manifest.requestId}:live:${index}:${message.role}`).slice(0, 24),
          source: source(kind, sourceId, message.content ?? '', label),
          required: true,
          included: true,
          selectionReason: 'required' as const,
          rankScore: null,
          selectedEstimatedTokens: estimateTokens(message.content ?? ''),
          providerActualTokens: null
        }
      })
      const omittedDecisions = (projection?.dropped ?? []).map((message, index) => ({
        itemId: contextHash(`${manifest.requestId}:omitted:${index}`).slice(0, 24),
        source: source('active_tool_pair', message.tool_call_id ?? `${manifest.requestId}:omitted:${index}`, message.content ?? '', '较早的只读工具记录（本轮省略）'),
        required: false, included: false, selectionReason: 'budget' as const, rankScore: null, selectedEstimatedTokens: null, providerActualTokens: null
      }))
      const decisions = [...manifest.decisions, ...liveDecisions, ...omittedDecisions]
      const finalEstimate = manifest.policySnapshot?.management === 'model_auto_v1'
        ? fullMessages.reduce((sum, message) => sum + estimateTokens(JSON.stringify(message)), manifest.wireReserveTokens ?? 0)
        : fullMessages.reduce((sum, message) => sum + estimateTokens(message.content ?? ''), 0)
      const liveEstimate = live.reduce((sum, message) => sum + estimateTokens(message.content ?? ''), 0)
      const fullBaseline = (manifest.fullBaselineEstimate.value ?? (finalEstimate - liveEstimate)) + liveEstimate + (projection?.estimatedSavedTokens ?? 0)
      const finalized: ContextManifestV2 = {
        ...manifest, decisions, selectedEstimate: { ...manifest.selectedEstimate, value: finalEstimate }, fullBaselineEstimate: { ...manifest.fullBaselineEstimate, value: fullBaseline },
        estimatedSavedTokens: Math.max(0, fullBaseline - finalEstimate), estimatedSavingsRatio: fullBaseline > 0 ? Math.max(0, fullBaseline - finalEstimate) / fullBaseline : 0,
        sourceSetHash: contextHash(decisions.filter((entry) => entry.included).map(sourceIdentity).sort().join('\u0001')),
        envelopeHash: providerEnvelopeHash(fullMessages)
      }
      v2.appendManifest(finalized)
      return finalized
    }
  }
}
