import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CURRENT_SCHEMA_VERSION, closeDb, openDb, runMigrations } from '../src/main/db/migrations'
import { createRepository, type ManuscriptSegmentRow, type Repository, type RunRow } from '../src/main/db/repository'
import { buildSceneMemoryCard, ledgerEvidence, sceneMemoryLedgerClaimHash, sourceSpanEvidence, stableSceneMemoryJson, validateSceneMemoryCard } from '../src/main/narrative/sceneMemoryCard'
import { manuscriptSegmentHash } from '../src/main/manuscript'
import { storyLedgerRevisionHashV2 } from '../src/main/narrative/storyLedger'
import type { SceneCommitManifest, SceneMemoryCard, SceneMemoryCardBuildInput, SceneMemoryCardValidationContext, SceneMemoryForeshadowLedgerClaim, SceneMemoryRelationshipLedgerClaim, SceneMemorySourceSegment, SceneMemorySourceSpan } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function sha(value: unknown): string {
  return manuscriptSegmentHash(typeof value === 'string' ? value : stableSceneMemoryJson(value))
}

interface Fixture {
  root: string
  dbPath: string
  runId: string
  sessionId: string
  sceneId: string
  card: SceneMemoryCard
  context: SceneMemoryCardValidationContext
  segment: SceneMemorySourceSegment
  row: ManuscriptSegmentRow
  manifest: SceneCommitManifest
  manifestHash: string
  relationship: SceneMemoryRelationshipLedgerClaim
  thread: SceneMemoryForeshadowLedgerClaim
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-r70-'))
  const dbPath = path.join(root, 'deepwriter.sqlite')
  const runId = 'r70-run-1'
  const sessionId = 'r70-session-1'
  const sceneId = 'r70-scene-1'
  const contractId = 'r70-contract-1'
  const contractHash = sha(contractId)
  const stateDeltaHash = sha('r70-delta-1')
  const content = 'linzhou/林舟（agent）在雨夜把钥匙交给 shen-yao/沈遥（recipient）。钥匙能否安全交接？不信任到暂时合作，交接钥匙，沈遥取得钥匙，林舟暴露行踪。钥匙已交给沈遥。不信任到暂时相信林舟。关系维度：trust。钥匙交接线推进。雨夜。把钥匙交给沈遥。'
  const contentHash = sha(content)
  const segmentId = 'r70-segment-1'
  const row: ManuscriptSegmentRow = {
    segment_id: segmentId,
    run_id: runId,
    session_id: sessionId,
    source_turn_id: null,
    section_id: 'r70-section-1',
    scene_id: sceneId,
    chunk_index: 0,
    revision: 1,
    status: 'accepted',
    kind: 'prose',
    content,
    content_hash: contentHash,
    char_count: content.length,
    supersedes_segment_id: null,
    created_at: 100,
    updated_at: 100,
    accepted_at: 100
  }
  const manifest: SceneCommitManifest = {
    schemaVersion: 1,
    runId,
    sceneId,
    contractId,
    contractHash,
    acceptedSegments: [{ segmentId, contentHash, charCount: row.char_count, chunkIndex: 0, revision: 1 }],
    sceneContentHash: contentHash,
    sceneCharCount: row.char_count,
    completionDecisionHash: sha('r70-decision-1'),
    stateDeltaHash
  }
  const manifestHash = sha(stableSceneMemoryJson(manifest))
  const segment: SceneMemorySourceSegment = {
    segmentId,
    content,
    contentHash,
    segmentRevision: 1,
    status: 'accepted',
    sceneId,
    commitId: `${runId}:${sceneId}`,
    commitManifestHash: manifestHash,
    chunkIndex: 0
  }
  const span: SceneMemorySourceSpan = {
    spanId: 'r70-span-1',
    segmentId,
    segmentHash: contentHash,
    segmentRevision: 1,
    manifestHash,
    startUtf16: 0,
    endUtf16: content.length,
    text: content,
    spanHash: contentHash
  }
  const relationshipPayload = {
    kind: 'relationship' as const, id: 'r70-rel-1', revision: 1, validityEpoch: 1,
    storyId: 'r70-story-1', projectId: 'r70-project-1', branchId: 'main', stateDeltaHash, commitManifestHash: manifestHash,
    fromCharacterId: 'linzhou', toCharacterId: 'shen-yao', dimension: 'trust'
  }
  const relationship: SceneMemoryRelationshipLedgerClaim = { ...relationshipPayload, hash: sceneMemoryLedgerClaimHash(relationshipPayload) }
  const threadPayload = {
    kind: 'foreshadow' as const, id: 'r70-thread-1', revision: 1, validityEpoch: 1,
    storyId: 'r70-story-1', projectId: 'r70-project-1', branchId: 'main', stateDeltaHash, commitManifestHash: manifestHash,
    threadId: 'r70-thread-key', lifecycle: 'advanced'
  }
  const thread: SceneMemoryForeshadowLedgerClaim = { ...threadPayload, hash: sceneMemoryLedgerClaimHash(threadPayload) }
  const evidence = sourceSpanEvidence(span)
  const input: SceneMemoryCardBuildInput = {
    schemaVersion: 1,
    status: 'canonical',
    cardId: 'r70-card-1',
    storyId: 'r70-story-1',
    projectId: 'r70-project-1',
    branchId: 'main',
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
    povCharacterId: 'linzhou',
    participants: [
      { id: 'linzhou', role: 'agent', evidence: [evidence] },
      { id: 'shen-yao', role: 'recipient', evidence: [evidence] }
    ],
    locations: ['雨夜'],
    objects: ['钥匙'],
    dramaticQuestion: '钥匙能否安全交接？',
    valueShift: { from: '不信任', to: '暂时合作' },
    decisiveAction: '交接钥匙',
    turn: '沈遥取得钥匙',
    cost: '林舟暴露行踪',
    factsEstablished: [{ factId: 'r70-fact-1', statement: '钥匙已交给沈遥', evidence: [evidence] }],
    beliefChanges: [{ characterId: 'shen-yao', from: '不信任', to: '暂时相信林舟', evidence: [evidence] }],
    relationshipChanges: [{ fromCharacterId: 'linzhou', toCharacterId: 'shen-yao', dimension: 'trust', from: '不信任', to: '暂时合作', evidence: [evidence, ledgerEvidence(relationship.id, relationship.hash)] }],
    threads: [{ threadId: thread.threadId, lifecycle: thread.lifecycle, summary: '钥匙交接线推进', evidence: [evidence, ledgerEvidence(thread.id, thread.hash)] }],
    motifs: [{ text: '雨夜', evidence: [evidence] }],
    distinctivePhrases: [{ text: '把钥匙交给沈遥', evidence: [evidence] }],
    sourceSegments: [segment],
    sourceSpans: [span],
    fieldEvidence: {
      povCharacterId: [evidence],
      'locations:雨夜': [evidence],
      'objects:钥匙': [evidence],
      dramaticQuestion: [evidence],
      'valueShift.from': [evidence],
      'valueShift.to': [evidence],
      decisiveAction: [evidence],
      turn: [evidence],
      cost: [evidence]
    },
    expectedScope: { storyId: 'r70-story-1', projectId: 'r70-project-1', branchId: 'main' },
    expectedValidityEpoch: 1,
    expectedStoryRevision: 1,
    expectedContract: { contractId, contractHash },
    expectedBindings: { sceneContentHash: contentHash, commitManifestHash: manifestHash, stateDeltaHash },
    ledgerClaims: [relationship, thread],
    createdAt: 100
  }
  const card = buildSceneMemoryCard(input)
  const context: SceneMemoryCardValidationContext = {
    sourceSegments: [segment],
    expectedScope: input.expectedScope,
    expectedValidityEpoch: 1,
    expectedStoryRevision: 1,
    expectedContract: input.expectedContract,
    expectedBindings: input.expectedBindings,
    ledgerClaims: [relationship, thread]
  }
  return { root, dbPath, runId, sessionId, sceneId, card, context, segment, row, manifest, manifestHash, relationship, thread }
}

function seedCanonical(fixture: Fixture): void {
  const db = new DatabaseSync(fixture.dbPath)
  const delta = {
    schemaVersion: 1,
    runId: fixture.runId,
    sceneId: fixture.sceneId,
    acceptedSegmentId: fixture.row.segment_id,
    acceptedContentHash: fixture.row.content_hash,
    contractHash: fixture.card.contractHash,
    changes: [
      { changeId: fixture.relationship.id, revision: 1, kind: 'relationship', entityId: 'linzhou:shen-yao:trust', runId: fixture.runId, sceneId: fixture.sceneId, acceptedSegmentId: fixture.row.segment_id, acceptedContentHash: fixture.row.content_hash, contractHash: fixture.card.contractHash, fromCharacterId: 'linzhou', toCharacterId: 'shen-yao', dimension: 'trust', from: '不信任', to: '暂时合作' },
      { changeId: fixture.thread.id, revision: 1, kind: 'foreshadow', entityId: fixture.thread.threadId, runId: fixture.runId, sceneId: fixture.sceneId, acceptedSegmentId: fixture.row.segment_id, acceptedContentHash: fixture.row.content_hash, contractHash: fixture.card.contractHash, threadId: fixture.thread.threadId, lifecycle: fixture.thread.lifecycle, summary: '钥匙交接线推进' }
    ],
    deltaHash: fixture.card.stateDeltaHash
  }
  db.exec('BEGIN')
  db.prepare(`INSERT INTO manuscript_segments (segment_id,run_id,session_id,source_turn_id,section_id,scene_id,chunk_index,revision,status,kind,content,content_hash,char_count,supersedes_segment_id,created_at,updated_at,accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fixture.row.segment_id, fixture.row.run_id, fixture.row.session_id, null, fixture.row.section_id, fixture.row.scene_id, fixture.row.chunk_index, fixture.row.revision, fixture.row.status, fixture.row.kind, fixture.row.content, fixture.row.content_hash, fixture.row.char_count, null, fixture.row.created_at, fixture.row.updated_at, fixture.row.accepted_at
  )
  db.prepare(`INSERT INTO scene_states (run_id,scene_id,section_id,contract_id,contract_hash,scene_order,lifecycle,revision,candidate_segment_id,candidate_hash,accepted_segment_id,accepted_hash,completion_decision_json,completion_evidence_hash,created_at,updated_at,completed_at,committed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fixture.runId, fixture.sceneId, fixture.row.section_id, fixture.card.contractId, fixture.card.contractHash, fixture.card.sceneOrder, 'committed', 2, fixture.row.segment_id, fixture.row.content_hash, fixture.row.segment_id, fixture.row.content_hash, '{}', sha('evidence'), 100, 100, 100, 100
  )
  db.prepare(`INSERT INTO narrative_commits (run_id,scene_id,accepted_segment_id,accepted_content_hash,contract_hash,delta_hash,delta_json,revision,committed_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(fixture.runId, fixture.sceneId, fixture.row.segment_id, fixture.row.content_hash, fixture.card.contractHash, fixture.card.stateDeltaHash, stableSceneMemoryJson(delta), 1, 100)
  db.prepare(`INSERT INTO scene_commit_manifests (run_id,scene_id,revision,manifest_json,manifest_hash,created_at) VALUES (?,?,?,?,?,?)`).run(fixture.runId, fixture.sceneId, 1, stableSceneMemoryJson(fixture.manifest), fixture.manifestHash, 100)
  for (const change of delta.changes) db.prepare(`INSERT INTO narrative_ledger (run_id,scene_id,change_id,change_revision,accepted_segment_id,accepted_content_hash,contract_hash,change_kind,entity_id,payload_json,delta_hash,committed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(fixture.runId, fixture.sceneId, change.changeId, change.revision, fixture.row.segment_id, fixture.row.content_hash, fixture.card.contractHash, change.kind, change.entityId, stableSceneMemoryJson(change), fixture.card.stateDeltaHash, 100)
  const revisionHash = storyLedgerRevisionHashV2({ storyId: fixture.card.storyId, projectId: fixture.card.projectId, branchId: fixture.card.branchId, revision: 1, parentRevision: 0, parentHash: null, runId: fixture.runId, sceneId: fixture.sceneId, deltaHash: fixture.card.stateDeltaHash, manifestHash: fixture.manifestHash, nodeType: 'revision', hashSchemaVersion: 2 })
  db.prepare(`INSERT INTO story_ledger_revisions (story_id,project_id,branch_id,revision,parent_story_id,parent_project_id,parent_branch_id,parent_revision,run_id,scene_id,accepted_segment_id,accepted_content_hash,contract_hash,delta_hash,delta_json,manifest_json,manifest_hash,parent_hash,node_type,hash_schema_version,revision_hash,validity_epoch,rebase_parent_revision,rebase_parent_hash,committed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fixture.card.storyId, fixture.card.projectId, fixture.card.branchId, 1, null, null, null, 0, fixture.runId, fixture.sceneId, fixture.row.segment_id, fixture.row.content_hash, fixture.card.contractHash, fixture.card.stateDeltaHash, stableSceneMemoryJson(delta), stableSceneMemoryJson(fixture.manifest), fixture.manifestHash, null, 'revision', 2, revisionHash, 1, null, null, 100
  )
  db.prepare('UPDATE story_ledger_heads SET high_watermark=1, head_hash=?, validity_epoch=1, updated_at=100 WHERE story_id=? AND project_id=? AND branch_id=?').run(revisionHash, fixture.card.storyId, fixture.card.projectId, fixture.card.branchId)
  db.prepare('UPDATE story_ledger_runs SET current_revision=1, validity_epoch=1, updated_at=100 WHERE run_id=?').run(fixture.runId)
  db.exec('COMMIT')
  db.close()
}

function makeRun(fixture: Fixture): RunRow {
  return {
    run_id: fixture.runId,
    session_id: fixture.sessionId,
    status: 'completed',
    phase: 'writing',
    started_at: 1,
    updated_at: 1,
    config_json: JSON.stringify({ storyScope: { schemaVersion: 1, storyId: 'r70-story-1', projectId: 'r70-project-1', branchId: 'main' } }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  }
}

function migrationChecks(): void {
  const fixture = makeFixture()
  const db = openDb(fixture.dbPath)
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'scene_%' OR name='longform_workflow_snapshots'").all() as Array<{ name: string }>).map((row) => row.name)
  check('v27 creates all projection tables', ['scene_memory_cards', 'scene_memory_card_spans', 'scene_recall_entities', 'scene_recall_threads', 'scene_recall_edges', 'scene_recall_terms', 'scene_recall_embeddings', 'scene_working_sets', 'scene_recall_index_meta', 'longform_workflow_snapshots'].every((name) => tables.includes(name)), tables.join(','))
  check('empty database reaches current schema', Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) === CURRENT_SCHEMA_VERSION)
  runMigrations(db)
  check('rerunning v27 is idempotent', Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) === CURRENT_SCHEMA_VERSION)
  closeDb(db)

  for (const target of [25, 26]) {
    const oldPath = path.join(fixture.root, `v${target}.sqlite`)
    const old = new DatabaseSync(oldPath)
    runMigrations(old, target)
    closeDb(old)
    const upgraded = openDb(oldPath)
    check(`v${target} database upgrades to v27`, Number((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) === CURRENT_SCHEMA_VERSION && Boolean(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scene_memory_cards'").get()))
    closeDb(upgraded)
  }

  const failedPath = path.join(fixture.root, 'injected.sqlite')
  const failedDb = new DatabaseSync(failedPath)
  runMigrations(failedDb, 26)
  failedDb.prepare("INSERT INTO runs (run_id,session_id,status,phase,started_at,updated_at,config_json,parent_run_id,error_code,error_message,client_request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run('r70-marker-run', 'r70-marker-session', 'completed', 'idle', 1, 1, '{}', null, null, null, null)
  failedDb.prepare("INSERT INTO meta (key,value) VALUES ('r70_marker','before')").run()
  closeDb(failedDb)
  process.env.DW_R70_INJECT_V27_FAILURE = '1'
  let threw = false
  try { openDb(failedPath) } catch (error) { threw = error instanceof Error && error.message === 'scene_memory_v27_injected_failure' }
  delete process.env.DW_R70_INJECT_V27_FAILURE
  const after = new DatabaseSync(failedPath)
  const versionAfter = Number((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  const hasPartial = Boolean(after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scene_memory_cards'").get())
  const marker = (after.prepare("SELECT value FROM meta WHERE key='r70_marker'").get() as { value?: string } | undefined)?.value
  after.close()
  check('partial v27 migration fails closed and rolls back', threw && versionAfter === 26 && !hasPartial && marker === 'before')
  check('failed migration creates pre-v26 backup', fs.existsSync(`${failedPath}.pre-v26.bak`))
  const recovered = openDb(failedPath)
  check('same database recovers after fault is removed', Number((recovered.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) === CURRENT_SCHEMA_VERSION)
  closeDb(recovered)
}

function repositoryChecks(): void {
  const fixture = makeFixture()
  const repo: Repository = createRepository(fixture.dbPath)
  repo.open()
  repo.createRun(makeRun(fixture))
  repo.close()
  seedCanonical(fixture)
  repo.open()
  check('WP1 context remains valid before persistence', validateSceneMemoryCard(fixture.card, fixture.context).ok)
  let first = repo.upsertSceneMemoryCard({ card: fixture.card, context: fixture.context })
  check('committed source-bound card is published', first.inserted && repo.getSceneMemoryCard({ cardId: fixture.card.cardId })?.cardHash === fixture.card.cardHash)
  const second = repo.upsertSceneMemoryCard({ card: fixture.card, context: fixture.context })
  check('same identity and hash is idempotent', !second.inserted)
  const replayWithFreshTimestamp = { ...fixture.card, createdAt: 2000 }
  const timestampReplay = repo.upsertSceneMemoryCard({ card: replayWithFreshTimestamp, context: fixture.context })
  check('same semantic card with a fresh createdAt is idempotent', !timestampReplay.inserted && timestampReplay.card.cardHash === fixture.card.cardHash)
  const conflicting = { ...fixture.card, cardHash: sha('tampered-card') }
  let conflict = false
  try { repo.upsertSceneMemoryCard({ card: conflicting, context: fixture.context }) } catch (error) { conflict = error instanceof Error && error.message.includes('hash') }
  check('same identity with a different hash conflicts', conflict)
  const rebuilt = repo.rebuildSceneMemoryProjection({ storyId: fixture.card.storyId, projectId: fixture.card.projectId, branchId: fixture.card.branchId, validityEpoch: 1, storyRevision: 1, sceneId: fixture.card.sceneId }, [{ card: fixture.card, context: fixture.context }])
  check('projection rebuild has one deterministic card set', rebuilt.cardCount === 1 && rebuilt.cardSetHash.length === 64, JSON.stringify(rebuilt))
  const rebuiltAgain = repo.rebuildSceneMemoryProjection({ storyId: fixture.card.storyId, projectId: fixture.card.projectId, branchId: fixture.card.branchId, validityEpoch: 1, storyRevision: 1, sceneId: fixture.card.sceneId }, [{ card: fixture.card, context: fixture.context }])
  check('rebuild index hash is stable', rebuilt.indexHash === rebuiltAgain.indexHash && rebuilt.cardSetHash === rebuiltAgain.cardSetHash)
  const workingPayload = { required: ['r70-card-1'], omitted: [] }
  const workingScope = { storyId: fixture.card.storyId, projectId: fixture.card.projectId, branchId: fixture.card.branchId, validityEpoch: 1, storyRevision: 2, sceneId: 'r70-current-scene' }
  const workingHash = sha({ ...workingScope, queryHash: 'r70-query', cardIds: [fixture.card.cardId], omitted: [], payload: workingPayload })
  repo.saveSceneWorkingSet({ workingSetId: 'r70-working-set', ...workingScope, queryHash: 'r70-query', cardIds: [fixture.card.cardId], omitted: [], payload: workingPayload, workingSetHash: workingHash })
  check('working set round-trips with separated hash', repo.getSceneWorkingSet('r70-working-set')?.workingSetHash === workingHash)
  const snapshotPayload = { chapter: 1, cursor: 'r70-card-1' }
  const snapshotHash = sha(snapshotPayload)
  repo.saveLongformWorkflowSnapshot({ snapshotId: 'r70-snapshot-1', storyId: fixture.card.storyId, projectId: fixture.card.projectId, branchId: fixture.card.branchId, validityEpoch: 1, storyRevision: 1, runId: fixture.runId, workflowKey: 'longform', workflowRevision: 1, status: 'paused', payload: snapshotPayload, payloadHash: snapshotHash })
  check('workflow snapshot round-trips by run/key/revision', repo.getLongformWorkflowSnapshot(fixture.runId, 'longform')?.payloadHash === snapshotHash)
  const inputSnapshotHash = sha('r70-backfill-input')
  repo.startSceneMemoryBackfill({ backfillId: 'r70-backfill', storyId: fixture.card.storyId, projectId: fixture.card.projectId, branchId: fixture.card.branchId, validityEpoch: null, storyRevision: null, sceneId: null, inputSnapshotHash, cursor: null, processedIds: [], totalCount: 2, processedCount: 0, status: 'in_progress', errorCode: null, createdAt: 100, updatedAt: 100, completedAt: null })
  repo.saveSceneMemoryBackfillStep({ state: { backfillId: 'r70-backfill', storyId: fixture.card.storyId, projectId: fixture.card.projectId, branchId: fixture.card.branchId, validityEpoch: null, storyRevision: null, sceneId: null, inputSnapshotHash, cursor: 'r70-card-1', processedIds: [fixture.card.cardId], totalCount: 2, processedCount: 1, status: 'paused', errorCode: null, createdAt: 100, updatedAt: 101, completedAt: null } })
  check('backfill cursor/status/progress resumes monotonically', repo.getSceneMemoryBackfill('r70-backfill')?.processedCount === 1 && repo.getSceneMemoryBackfill('r70-backfill')?.status === 'paused')
  repo.markSceneMemoryCardVisibility(fixture.card.cardId, 'stale')
  check('stale card is hidden by default', repo.getSceneMemoryCard({ cardId: fixture.card.cardId }) === null && repo.listSceneMemoryCards({ storyId: fixture.card.storyId, projectId: fixture.card.projectId, branchId: fixture.card.branchId, validityEpoch: 1 }).length === 0)
  check('hidden card remains available to audit', repo.getSceneMemoryCard({ cardId: fixture.card.cardId, includeHidden: true })?.cardHash === fixture.card.cardHash)
  repo.close()
}

try {
  migrationChecks()
  repositoryChecks()
} catch (error) {
  failed += 1
  console.error('R70 execution error:', error)
}

console.log(`\nR70 SceneMemory persistence: ${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exitCode = 1
