/**
 * DeepWriter v1.2.5 WP5 red/contract checks.
 *
 * This file deliberately does not change AgentRunEngine or the projection
 * writer.  It exercises the durable boundaries used by an independent
 * embedding worker and the outbox/backfill restart replayers.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRepository, type Repository } from '../src/main/db/repository'
import { closeDb, openDb, CURRENT_SCHEMA_VERSION } from '../src/main/db/migrations'
import {
  buildDeterministicRecallIndex,
  SCENE_RECALL_BM25_VERSION,
  SCENE_RECALL_TOKENIZER_VERSION,
  sceneRecallAuthorityHash,
  sceneRecallSourceCardSetHash,
  sceneRecallSourceSnapshotHash,
  type SceneRecallCorpusItem,
  type SceneRecallQuery
} from '../src/main/narrative/recallIndex'
import { buildSceneMemoryCard, sceneMemoryCardHash, sourceSpanEvidence, stableSceneMemoryJson } from '../src/main/narrative/sceneMemoryCard'
import { manuscriptSegmentHash } from '../src/main/manuscript'
import { stableNarrativeJson } from '../src/main/narrative/stateDelta'
import { storyLedgerRevisionHashV2 } from '../src/main/narrative/storyLedger'
import type { SceneCommitManifest, SceneMemoryCard, SceneMemoryCardValidationContext, SceneMemorySourceSegment, SceneMemorySourceSpan } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, value: boolean, detail = ''): void {
  if (value) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function sha(value: unknown): string {
  const text = typeof value === 'string' ? value : stableSceneMemoryJson(value)
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

type RecallItem = SceneRecallCorpusItem & { stale?: boolean; retracted?: boolean }

const STORY_ID = 'wp5-story'
const PROJECT_ID = 'wp5-project'
const BRANCH_ID = 'main'
const HEAD_REVISION = 2
const HEAD_HASH = sha('wp5-head-2')

/** Small source-valid card fixture shared by all pure recall assertions. */
function makeRecallItem(input: {
  id: string
  revision: number
  epoch?: number
  text: string
  sceneId?: string
}): RecallItem {
  const epoch = input.epoch ?? 1
  const sceneId = input.sceneId ?? `scene-${input.id}`
  const contentHash = sha(input.text)
  const segment: SceneMemorySourceSegment = {
    segmentId: `${input.id}-segment`,
    content: input.text,
    contentHash,
    segmentRevision: 1,
    status: 'accepted',
    sceneId,
    commitId: `${input.id}-commit`,
    commitManifestHash: sha(`${input.id}-manifest`),
    chunkIndex: 0
  }
  const span: SceneMemorySourceSpan = {
    spanId: `${input.id}-span`,
    segmentId: segment.segmentId,
    segmentHash: contentHash,
    segmentRevision: 1,
    manifestHash: segment.commitManifestHash,
    startUtf16: 0,
    endUtf16: input.text.length,
    text: input.text,
    spanHash: contentHash
  }
  const card: SceneMemoryCard = {
    schemaVersion: 1,
    status: 'canonical',
    cardId: input.id,
    storyId: STORY_ID,
    projectId: PROJECT_ID,
    branchId: BRANCH_ID,
    validityEpoch: epoch,
    storyRevision: input.revision,
    runId: `${input.id}-run`,
    sceneId,
    sceneOrder: input.revision,
    contractId: 'wp5-contract',
    contractHash: sha('wp5-contract'),
    sceneContentHash: contentHash,
    commitManifestHash: segment.commitManifestHash,
    stateDeltaHash: sha(`${input.id}-delta`),
    povCharacterId: null,
    participants: [],
    locations: [],
    objects: [],
    dramaticQuestion: null,
    valueShift: null,
    decisiveAction: null,
    turn: null,
    cost: null,
    factsEstablished: [],
    beliefChanges: [],
    relationshipChanges: [],
    threads: [],
    motifs: [],
    distinctivePhrases: [],
    sourceSegmentIds: [segment.segmentId],
    sourceSpans: [span],
    embedding: { status: 'unavailable', version: null, modelId: null, dimensions: null, vectorHash: null },
    fieldEvidence: {},
    cardHash: '',
    createdAt: input.revision
  }
  card.cardHash = sceneMemoryCardHash(card)
  const authority = {
    storyId: card.storyId,
    projectId: card.projectId,
    branchId: card.branchId,
    branchLineage: [BRANCH_ID],
    validityEpoch: card.validityEpoch,
    storyRevision: card.storyRevision,
    headRevision: HEAD_REVISION,
    headHash: HEAD_HASH,
    sourceSnapshotHash: '',
    cardHash: card.cardHash,
    authorityHash: ''
  }
  authority.sourceSnapshotHash = sceneRecallSourceSnapshotHash(card, [segment])
  authority.authorityHash = sceneRecallAuthorityHash(authority)
  return { card, sourceSegments: [segment], sourceValidated: true, authority }
}

function query(overrides: Partial<SceneRecallQuery> = {}): SceneRecallQuery {
  return {
    scope: {
      storyId: STORY_ID,
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
      branchLineage: [BRANCH_ID],
      validityEpoch: 1,
      storyRevision: HEAD_REVISION,
      sceneId: 'current-scene',
      headRevision: HEAD_REVISION,
      headHash: HEAD_HASH,
      expectedSourceCardSetHash: sha('placeholder')
    },
    tokenizerVersion: SCENE_RECALL_TOKENIZER_VERSION,
    bm25Version: SCENE_RECALL_BM25_VERSION,
    topK: 10,
    ...overrides
  }
}

function build(corpus: readonly RecallItem[], overrides: Partial<SceneRecallQuery> = {}) {
  const base = query(overrides)
  return buildDeterministicRecallIndex({
    corpus,
    query: {
      ...base,
      scope: { ...base.scope, expectedSourceCardSetHash: sceneRecallSourceCardSetHash(corpus) }
    }
  })
}

function recallProjectionChecks(): void {
  const committed = makeRecallItem({ id: 'card-committed', revision: 1, text: '已提交且可回忆的场景。' })
  const visible = build([committed])
  check('提交后 canonical card/index 可见', visible.candidates.some((candidate) => candidate.cardId === committed.card.cardId))

  const stale = { ...makeRecallItem({ id: 'card-stale', revision: 1, text: '过期 stale card。' }), stale: true }
  const retracted = { ...makeRecallItem({ id: 'card-retracted', revision: 1, text: '已撤回 card。' }), retracted: true }
  const oldEpoch = makeRecallItem({ id: 'card-old-epoch', revision: 1, epoch: 0, text: '旧 epoch card。' })
  // Keep the fixture structurally valid while forcing the old-epoch fence.
  oldEpoch.card.validityEpoch = 1
  oldEpoch.card.cardHash = sceneMemoryCardHash(oldEpoch.card)
  oldEpoch.authority = { ...oldEpoch.authority, validityEpoch: 1, cardHash: oldEpoch.card.cardHash, authorityHash: '' }
  oldEpoch.authority.authorityHash = sceneRecallAuthorityHash(oldEpoch.authority)
  const oldEpochForNewHead = makeRecallItem({ id: 'card-old-epoch-2', revision: 1, epoch: 1, text: '新 epoch 查询中的旧 card。' })
  const filtered = build([stale, retracted, oldEpochForNewHead], { scope: { ...query().scope, validityEpoch: 2 } })
  check('撤回后 stale/retracted/old-epoch card 默认 recall 为 0', filtered.candidates.length === 0 && filtered.omitted.length === 3, stableSceneMemoryJson(filtered))
  check('撤回过滤给出显式原因', filtered.omitted.some((item) => item.reason === 'old_epoch'))

  const rebased = makeRecallItem({ id: 'card-rebased-epoch-2', revision: 2, epoch: 2, text: 'rebase 后的新 epoch 场景。' })
  const rebasedResult = build([rebased], { scope: { ...query().scope, validityEpoch: 2, storyRevision: 2 } })
  check('新 epoch/rebase card 可见', rebasedResult.candidates.some((candidate) => candidate.cardId === rebased.card.cardId))
}

interface CanonicalCardState {
  cardId: string
  cardHash: string
  validityEpoch: number
  visibility: 'active' | 'stale' | 'retracted'
  embedding: { status: 'unavailable' | 'ready' | 'stale'; vectorHash: string | null; dimensions: number | null; version: string | null }
  vector: number[] | null
}

interface EmbeddingResult {
  ok: boolean
  cardId: string
  sourceCardHash: string
  validityEpoch: number
  modelVersion: string
  vector: number[] | null
  expiresAt: number
}

/**
 * Executable worker contract.  It models the sidecar write only: card hash,
 * epoch, and visibility are immutable.  The production worker should expose
 * this guard (or an equivalent one) before touching scene_recall_embeddings.
 */
function applyEmbeddingResult(state: CanonicalCardState, result: EmbeddingResult, now: number): { applied: boolean; reason: string } {
  if (!result.ok) return { applied: false, reason: 'worker_failed' }
  if (result.expiresAt < now) return { applied: false, reason: 'result_expired' }
  if (state.visibility !== 'active') return { applied: false, reason: 'card_not_active' }
  if (result.cardId !== state.cardId || result.sourceCardHash !== state.cardHash || result.validityEpoch !== state.validityEpoch) return { applied: false, reason: 'authority_mismatch' }
  if (!Array.isArray(result.vector) || result.vector.length === 0 || result.vector.some((value) => !Number.isFinite(value))) return { applied: false, reason: 'vector_invalid' }
  const vectorHash = sha(result.vector)
  state.embedding = { status: 'ready', version: result.modelVersion, vectorHash, dimensions: result.vector.length }
  state.vector = [...result.vector]
  return { applied: true, reason: 'applied' }
}

function embeddingChecks(): void {
  const state: CanonicalCardState = {
    cardId: 'card-embed',
    cardHash: sha('canonical-card'),
    validityEpoch: 2,
    visibility: 'active',
    embedding: { status: 'unavailable', vectorHash: null, dimensions: null, version: null },
    vector: null
  }
  const canonicalBefore = stableSceneMemoryJson({ cardHash: state.cardHash, validityEpoch: state.validityEpoch, visibility: state.visibility })
  let proseCommitted = false
  // The prose commit does not await embedding; this must remain true even if
  // the asynchronous worker later fails or returns after the epoch changes.
  proseCommitted = true
  const accepted = applyEmbeddingResult(state, { ok: true, cardId: state.cardId, sourceCardHash: state.cardHash, validityEpoch: state.validityEpoch, modelVersion: 'embed-v1', vector: [0.25, -0.5, 1], expiresAt: 100 }, 10)
  check('embedding success 只回填同 card/hash/epoch sidecar', accepted.applied && state.embedding.status === 'ready' && state.vector?.length === 3 && stableSceneMemoryJson({ cardHash: state.cardHash, validityEpoch: state.validityEpoch, visibility: state.visibility }) === canonicalBefore)
  const sidecarBeforeFailure = stableSceneMemoryJson(state.embedding)
  const failed = applyEmbeddingResult(state, { ok: false, cardId: state.cardId, sourceCardHash: state.cardHash, validityEpoch: state.validityEpoch, modelVersion: 'embed-v1', vector: null, expiresAt: 100 }, 10)
  const expired = applyEmbeddingResult(state, { ok: true, cardId: state.cardId, sourceCardHash: state.cardHash, validityEpoch: state.validityEpoch, modelVersion: 'embed-v1', vector: [9, 9, 9], expiresAt: 5 }, 10)
  const oldEpoch = applyEmbeddingResult(state, { ok: true, cardId: state.cardId, sourceCardHash: state.cardHash, validityEpoch: 1, modelVersion: 'embed-v1', vector: [8, 8, 8], expiresAt: 100 }, 10)
  check('失败/过期/旧 epoch embedding 不改变 sidecar/canonical', !failed.applied && !expired.applied && !oldEpoch.applied && stableSceneMemoryJson(state.embedding) === sidecarBeforeFailure && state.cardHash === sha('canonical-card') && state.validityEpoch === 2 && state.visibility === 'active')
  check('embedding 失败不阻塞正文提交', proseCommitted)
}

function repositoryProjectionChecks(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-wp5-projection-'))
  const dbPath = path.join(root, 'projection.sqlite')
  const storyId = 'wp5-db-story'
  const projectId = 'wp5-db-project'
  const branchId = 'main'
  const runId = 'wp5-db-run'
  const sessionId = 'wp5-db-session'
  const sceneId = 'wp5-db-scene'
  const contractId = 'wp5-db-contract'
  const contractHash = sha(contractId)
  const stateDeltaHash = sha('wp5-db-delta')
  const content = '提交场景：钥匙能否安全交接？交接钥匙，沈遥取得钥匙，林舟暴露行踪。'
  const contentHash = sha(content)
  const segmentId = 'wp5-db-segment'
  const decisionHash = sha('wp5-db-decision')
  const segmentDraft: SceneMemorySourceSegment = {
    segmentId,
    content,
    contentHash,
    segmentRevision: 1,
    status: 'accepted',
    sceneId,
    commitId: `${runId}:${sceneId}`,
    commitManifestHash: '',
    chunkIndex: 0
  }
  const spanDraft: SceneMemorySourceSpan = {
    spanId: 'wp5-db-span',
    segmentId,
    segmentHash: contentHash,
    segmentRevision: 1,
    manifestHash: '',
    startUtf16: 0,
    endUtf16: content.length,
    text: content,
    spanHash: contentHash
  }
  const manifestWithoutHash: SceneCommitManifest = {
    schemaVersion: 1,
    runId,
    sceneId,
    contractId,
    contractHash,
    acceptedSegments: [{ segmentId, contentHash, charCount: content.length, chunkIndex: 0, revision: 1 }],
    sceneContentHash: contentHash,
    sceneCharCount: content.length,
    completionDecisionHash: decisionHash,
    stateDeltaHash
  }
  const manifestHash = manuscriptSegmentHash(stableNarrativeJson(manifestWithoutHash))
  const segment: SceneMemorySourceSegment = { ...segmentDraft, commitManifestHash: manifestHash }
  const span: SceneMemorySourceSpan = { ...spanDraft, manifestHash: manifestHash }
  const evidence = sourceSpanEvidence(span)
  const card = buildSceneMemoryCard({
    schemaVersion: 1,
    status: 'canonical',
    cardId: 'wp5-db-card',
    storyId,
    projectId,
    branchId,
    validityEpoch: 1,
    storyRevision: 1,
    runId,
    sceneId,
    sceneOrder: 1,
    contractId,
    contractHash,
    sceneContentHash: contentHash,
    commitManifestHash: manifestHash,
    stateDeltaHash,
    povCharacterId: null,
    participants: [],
    locations: [],
    objects: [],
    dramaticQuestion: '钥匙能否安全交接？',
    valueShift: null,
    decisiveAction: '交接钥匙',
    turn: '沈遥取得钥匙',
    cost: '林舟暴露行踪',
    factsEstablished: [],
    beliefChanges: [],
    relationshipChanges: [],
    threads: [],
    motifs: [],
    distinctivePhrases: [],
    sourceSegments: [segment],
    sourceSpans: [span],
    fieldEvidence: {
      dramaticQuestion: [evidence],
      decisiveAction: [evidence],
      turn: [evidence],
      cost: [evidence]
    },
    expectedScope: { storyId, projectId, branchId },
    expectedValidityEpoch: 1,
    expectedStoryRevision: 1,
    expectedContract: { contractId, contractHash },
    expectedBindings: { sceneContentHash: contentHash, commitManifestHash: manifestHash, stateDeltaHash },
    ledgerClaims: [],
    createdAt: 100
  })
  const context: SceneMemoryCardValidationContext = {
    sourceSegments: [segment],
    expectedScope: { storyId, projectId, branchId },
    expectedValidityEpoch: 1,
    expectedStoryRevision: 1,
    expectedContract: { contractId, contractHash },
    expectedBindings: { sceneContentHash: contentHash, commitManifestHash: manifestHash, stateDeltaHash },
    ledgerClaims: []
  }
  const repo: Repository = createRepository(dbPath)
  repo.open()
  repo.createRun({
    run_id: runId,
    session_id: sessionId,
    status: 'completed',
    phase: 'completed',
    started_at: 1,
    updated_at: 1,
    config_json: JSON.stringify({ storyScope: { schemaVersion: 1, storyId, projectId, branchId } }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  })
  repo.close()

  // Seed only canonical rows; this mirrors the durable commit boundary and
  // keeps the test independent of AgentRunEngine.
  const db = openDb(dbPath)
  try {
    const delta = { schemaVersion: 1, runId, sceneId, acceptedSegmentId: segmentId, acceptedContentHash: contentHash, contractHash, changes: [], deltaHash: stateDeltaHash }
    const revisionHash = storyLedgerRevisionHashV2({ storyId, projectId, branchId, revision: 1, parentRevision: 0, parentHash: null, runId, sceneId, deltaHash: stateDeltaHash, manifestHash, nodeType: 'revision', hashSchemaVersion: 2 })
    db.exec('BEGIN')
    db.prepare(`INSERT INTO manuscript_segments (segment_id,run_id,session_id,source_turn_id,section_id,scene_id,chunk_index,revision,status,kind,content,content_hash,char_count,supersedes_segment_id,created_at,updated_at,accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(segmentId, runId, sessionId, null, 'wp5-db-section', sceneId, 0, 1, 'accepted', 'prose', content, contentHash, content.length, null, 100, 100, 100)
    db.prepare(`INSERT INTO scene_states (run_id,scene_id,section_id,contract_id,contract_hash,scene_order,lifecycle,revision,candidate_segment_id,candidate_hash,accepted_segment_id,accepted_hash,completion_decision_json,completion_evidence_hash,created_at,updated_at,completed_at,committed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, sceneId, 'wp5-db-section', contractId, contractHash, 1, 'committed', 2, segmentId, contentHash, segmentId, contentHash, '{}', decisionHash, 100, 100, 100, 100)
    db.prepare(`INSERT INTO narrative_commits (run_id,scene_id,accepted_segment_id,accepted_content_hash,contract_hash,delta_hash,delta_json,revision,committed_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(runId, sceneId, segmentId, contentHash, contractHash, stateDeltaHash, stableNarrativeJson(delta), 1, 100)
    db.prepare(`INSERT INTO scene_commit_manifests (run_id,scene_id,revision,manifest_json,manifest_hash,created_at) VALUES (?,?,?,?,?,?)`).run(runId, sceneId, 1, stableNarrativeJson(manifestWithoutHash), manifestHash, 100)
    db.prepare(`INSERT OR IGNORE INTO story_ledger_heads (story_id,project_id,branch_id,parent_story_id,parent_project_id,parent_branch_id,parent_revision,high_watermark,head_hash,hash_schema_version,validity_epoch,parent_validity_epoch,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(storyId, projectId, branchId, null, null, null, 0, 0, null, 2, 1, 1, 100)
    db.prepare(`INSERT OR IGNORE INTO story_ledger_runs (run_id,story_id,project_id,branch_id,parent_story_id,parent_project_id,parent_branch_id,parent_revision,current_revision,validity_epoch,parent_validity_epoch,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, storyId, projectId, branchId, null, null, null, 0, 0, 1, 1, 100, 100)
    db.prepare(`INSERT INTO story_ledger_revisions (story_id,project_id,branch_id,revision,parent_story_id,parent_project_id,parent_branch_id,parent_revision,run_id,scene_id,accepted_segment_id,accepted_content_hash,contract_hash,delta_hash,delta_json,manifest_json,manifest_hash,parent_hash,node_type,hash_schema_version,revision_hash,validity_epoch,rebase_parent_revision,rebase_parent_hash,committed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(storyId, projectId, branchId, 1, null, null, null, 0, runId, sceneId, segmentId, contentHash, contractHash, stateDeltaHash, stableNarrativeJson(delta), stableNarrativeJson(manifestWithoutHash), manifestHash, null, 'revision', 2, revisionHash, 1, null, null, 100)
    db.prepare('UPDATE story_ledger_heads SET high_watermark=1,head_hash=?,validity_epoch=1,updated_at=100 WHERE story_id=? AND project_id=? AND branch_id=?').run(revisionHash, storyId, projectId, branchId)
    db.prepare('UPDATE story_ledger_runs SET current_revision=1,validity_epoch=1,updated_at=100 WHERE run_id=?').run(runId)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve seed error */ }
    throw error
  } finally { closeDb(db) }

  repo.open()
  const persisted = repo.upsertSceneMemoryCard({ card, context })
  check('实际 repository commit 后 card/index row 可见', persisted.inserted && repo.getSceneMemoryCard({ cardId: card.cardId })?.cardHash === card.cardHash && repo.listSceneMemoryCards({ storyId, projectId, branchId, validityEpoch: 1 }).length === 1)
  const canonicalBeforeEmbedding = stableSceneMemoryJson(repo.getSceneMemoryCard({ cardId: card.cardId }))
  const vector = [0.125, -0.25, 0.5]
  const vectorHash = sha(vector)
  const embeddingApplied = repo.applySceneMemoryEmbeddingResult({
    cardId: card.cardId,
    sourceCardHash: card.cardHash,
    validityEpoch: card.validityEpoch,
    status: 'ready',
    version: 'embed-v1',
    modelId: 'local-test-model',
    vector,
    vectorHash,
    completedAt: 200,
    expiresAt: 1000,
    now: 210
  })
  check('实际 repository embedding 只写 exact sidecar', embeddingApplied.applied && embeddingApplied.reason === 'applied' && stableSceneMemoryJson(repo.getSceneMemoryCard({ cardId: card.cardId })) === canonicalBeforeEmbedding)
  const sidecarAfterEmbedding = (() => {
    const db = openDb(dbPath)
    try { return db.prepare('SELECT status,version,model_id,dimensions,vector_hash,vector_json,source_card_hash FROM scene_recall_embeddings WHERE card_id=?').get(card.cardId) as Record<string, unknown> } finally { closeDb(db) }
  })()
  check('embedding sidecar 保存有限 vector/hash/version/model', sidecarAfterEmbedding.status === 'ready' && sidecarAfterEmbedding.version === 'embed-v1' && sidecarAfterEmbedding.model_id === 'local-test-model' && sidecarAfterEmbedding.dimensions === vector.length && sidecarAfterEmbedding.vector_hash === vectorHash && sidecarAfterEmbedding.source_card_hash === card.cardHash)
  const olderVector = [0.75, 0.5, -0.25]
  const staleEmbedding = repo.applySceneMemoryEmbeddingResult({
    cardId: card.cardId,
    sourceCardHash: card.cardHash,
    validityEpoch: card.validityEpoch,
    status: 'ready',
    version: 'embed-v2',
    modelId: 'local-test-model',
    vector: olderVector,
    vectorHash: sha(olderVector),
    completedAt: 199,
    expiresAt: 1000,
    now: 210
  })
  const sidecarAfterStale = (() => {
    const db = openDb(dbPath)
    try { return db.prepare('SELECT vector_hash,vector_json,updated_at FROM scene_recall_embeddings WHERE card_id=?').get(card.cardId) as Record<string, unknown> } finally { closeDb(db) }
  })()
  check('旧 worker 结果不覆盖较新的 sidecar', !staleEmbedding.applied && staleEmbedding.reason === 'result_stale' && sidecarAfterStale.vector_hash === vectorHash && sidecarAfterStale.vector_json === stableSceneMemoryJson(vector) && sidecarAfterStale.updated_at === 200)

  // Simulate a crash after the card/outbox write but before the index fence.
  // The replayer must validate the durable source and publish both records in
  // one transaction; it must never invent a card.
  const pendingDb = openDb(dbPath)
  try {
    pendingDb.exec('BEGIN IMMEDIATE')
    pendingDb.prepare("UPDATE scene_memory_cards SET visibility='pending' WHERE card_id=?").run(card.cardId)
    pendingDb.prepare("UPDATE scene_memory_card_outbox SET status='pending',error_code=NULL WHERE card_hash=?").run(card.cardHash)
    pendingDb.prepare('DELETE FROM scene_recall_index_meta WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=? AND story_revision=?').run(storyId, projectId, branchId, card.validityEpoch, card.storyRevision)
    pendingDb.exec('COMMIT')
  } catch (error) {
    try { pendingDb.exec('ROLLBACK') } catch { /* preserve seed error */ }
    throw error
  } finally { closeDb(pendingDb) }
  const replayedOutbox = repo.replaySceneMemoryCardOutbox({ limit: 1, now: 300 })
  const replayedOutboxRow = (() => {
    const db = openDb(dbPath)
    try { return db.prepare('SELECT status,error_code FROM scene_memory_card_outbox WHERE card_hash=?').get(card.cardHash) as Record<string, unknown> } finally { closeDb(db) }
  })()
  const replayedIndexRow = (() => {
    const db = openDb(dbPath)
    try { return db.prepare('SELECT status,index_hash FROM scene_recall_index_meta WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=? AND story_revision=?').get(storyId, projectId, branchId, card.validityEpoch, card.storyRevision) as Record<string, unknown> | undefined } finally { closeDb(db) }
  })()
  check('真实 outbox replay 限量并发布 card', replayedOutbox.scanned === 1 && replayedOutbox.published === 1 && replayedOutbox.rejected === 0 && replayedOutbox.pending === 0 && replayedOutboxRow.status === 'published' && replayedOutboxRow.error_code === null && repo.getSceneMemoryCard({ cardId: card.cardId })?.cardHash === card.cardHash)
  check('outbox replay 同事务恢复 ready index fence', replayedIndexRow?.status === 'ready' && typeof replayedIndexRow.index_hash === 'string')
  const replayedAgain = repo.replaySceneMemoryCardOutbox({ limit: 1, now: 301 })
  check('outbox replay 重入幂等且不重复扫描 published row', replayedAgain.scanned === 0 && replayedAgain.published === 0 && replayedAgain.rejected === 0 && replayedAgain.pending === 0)

  // The index write hook is deliberately failed after the outbox/card writes;
  // the outer transaction must roll all of them back to pending.
  const rollbackDb = openDb(dbPath)
  try {
    rollbackDb.exec('BEGIN IMMEDIATE')
    rollbackDb.prepare("UPDATE scene_memory_cards SET visibility='pending' WHERE card_id=?").run(card.cardId)
    rollbackDb.prepare("UPDATE scene_memory_card_outbox SET status='pending',error_code=NULL WHERE card_hash=?").run(card.cardHash)
    rollbackDb.prepare('DELETE FROM scene_recall_index_meta WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=? AND story_revision=?').run(storyId, projectId, branchId, card.validityEpoch, card.storyRevision)
    rollbackDb.exec('COMMIT')
  } catch (error) {
    try { rollbackDb.exec('ROLLBACK') } catch { /* preserve seed error */ }
    throw error
  } finally { closeDb(rollbackDb) }
  repo.close()
  const failingRepo: Repository = createRepository(dbPath, { beforeSceneRecallIndexMetaWrite: () => { throw new Error('wp5_index_fault') } })
  failingRepo.open()
  let rollbackThrew = false
  try { failingRepo.replaySceneMemoryCardOutbox({ limit: 1, now: 400 }) } catch { rollbackThrew = true }
  failingRepo.close()
  const rollbackState = (() => {
    const db = openDb(dbPath)
    try {
      return {
        card: db.prepare('SELECT visibility FROM scene_memory_cards WHERE card_id=?').get(card.cardId) as Record<string, unknown>,
        outbox: db.prepare('SELECT status FROM scene_memory_card_outbox WHERE card_hash=?').get(card.cardHash) as Record<string, unknown>,
        index: db.prepare('SELECT 1 AS present FROM scene_recall_index_meta WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=? AND story_revision=?').get(storyId, projectId, branchId, card.validityEpoch, card.storyRevision) as Record<string, unknown> | undefined
      }
    } finally { closeDb(db) }
  })()
  check('index fence 故障回滚 card/outbox 不半发布', rollbackThrew && rollbackState.card.visibility === 'pending' && rollbackState.outbox.status === 'pending' && rollbackState.index === undefined)
  const recoveryRepo: Repository = createRepository(dbPath)
  recoveryRepo.open()
  const recoveredAfterFault = recoveryRepo.replaySceneMemoryCardOutbox({ limit: 1, now: 500 })
  check('index 故障后重试可完整恢复', recoveredAfterFault.published === 1 && recoveryRepo.getSceneMemoryCard({ cardId: card.cardId })?.cardHash === card.cardHash)
  const retracted = recoveryRepo.deleteRun(runId, 'retract')
  check('实际 repository retract 后默认 recall/card 为 0', retracted.retractedRevisions === 1 && recoveryRepo.getSceneMemoryCard({ cardId: card.cardId }) === null && recoveryRepo.listSceneMemoryCards({ storyId, projectId, branchId, validityEpoch: 1 }).length === 0)
  check('retract 后旧 card 仍可审计但不可见', recoveryRepo.getSceneMemoryCard({ cardId: card.cardId, includeHidden: true })?.cardHash === card.cardHash)
  recoveryRepo.close()
}

function repositoryReplayChecks(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-wp5-'))
  const dbPath = path.join(root, 'wp5.sqlite')
  const repo: Repository = createRepository(dbPath)
  repo.open()
  check('WP5 v27/v29 schema is current', (() => {
    const db = openDb(dbPath)
    try {
      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0)
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name?: string }>).map((row) => row.name)
      return version === CURRENT_SCHEMA_VERSION && names.includes('scene_memory_card_outbox') && names.includes('scene_memory_backfills') && names.includes('scene_recall_embeddings')
    } finally { closeDb(db) }
  })())
  check('canonical projection upsert port exists', typeof repo.upsertSceneMemoryCard === 'function')
  check('async embedding apply port is callable', typeof repo.applySceneMemoryEmbeddingResult === 'function')
  check('outbox restart replayer is callable', typeof repo.replaySceneMemoryCardOutbox === 'function')
  check('backfill restart replayer is callable', typeof repo.replaySceneMemoryBackfill === 'function')

  const inputSnapshotHash = sha('wp5-backfill-input')
  const initial = {
    backfillId: 'wp5-backfill', storyId: null, projectId: null, branchId: null,
    validityEpoch: null, storyRevision: null, sceneId: null, inputSnapshotHash,
    cursor: null, processedIds: [], totalCount: 1, processedCount: 0,
    status: 'in_progress' as const, errorCode: null, createdAt: 10, updatedAt: 10, completedAt: null
  }
  repo.startSceneMemoryBackfill(initial)
  const step = { ...initial, cursor: 'card-embed', processedIds: ['card-embed'], processedCount: 1, status: 'paused' as const, updatedAt: 11 }
  repo.saveSceneMemoryBackfillStep({ state: step })
  repo.close()
  const reopened: Repository = createRepository(dbPath)
  reopened.open()
  reopened.startSceneMemoryBackfill(initial)
  reopened.saveSceneMemoryBackfillStep({ state: step })
  const pausedReplay = reopened.replaySceneMemoryBackfill({ backfillId: 'wp5-backfill', resume: false, now: 12 })
  const resumedReplay = reopened.replaySceneMemoryBackfill({ backfillId: 'wp5-backfill', resume: true, now: 13 })
  const resumedAgain = reopened.replaySceneMemoryBackfill({ backfillId: 'wp5-backfill', resume: true, now: 14 })
  check('重启后 replay backfill 只恢复 durable cursor', pausedReplay.state.status === 'paused' && resumedReplay.resumed && resumedReplay.state.status === 'in_progress' && resumedReplay.state.cursor === 'card-embed' && resumedReplay.state.processedIds.length === 1 && resumedReplay.projectionPublished === false)
  check('backfill replay resume 幂等且不伪造 projection', !resumedAgain.resumed && resumedAgain.state.status === 'in_progress' && resumedAgain.state.cursor === 'card-embed' && resumedAgain.projectionPublished === false)
  const db = openDb(dbPath)
  try {
    const count = Number((db.prepare('SELECT COUNT(*) AS count FROM scene_memory_backfills WHERE backfill_id=?').get('wp5-backfill') as { count?: number }).count ?? 0)
    check('backfill restart replay 保持单行 identity', count === 1)
  } finally { closeDb(db) }
  reopened.close()
}

try {
  recallProjectionChecks()
  embeddingChecks()
  repositoryProjectionChecks()
  repositoryReplayChecks()
} catch (error) {
  failed += 1
  console.error('WP5 execution error:', error)
}

console.log(`\nWP5 retraction/projection/embedding: ${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exitCode = 1
