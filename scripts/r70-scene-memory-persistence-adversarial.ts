/**
 * R70/WP2 independent attack corpus.
 *
 * This is intentionally a stand-alone adversarial harness.  It does not use
 * the WP2 production test script, does not edit package scripts, and leaves
 * each temporary database behind for post-mortem inspection.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { CURRENT_SCHEMA_VERSION, closeDb, openDb, runMigrations } from '../src/main/db/migrations'
import {
  createRepository,
  type Repository,
  type SceneMemoryBackfillState,
  type SceneMemoryProjectionInput
} from '../src/main/db/repository'
import {
  buildSceneMemoryCard,
  ledgerEvidence,
  sceneMemoryCardHash,
  sceneMemoryLedgerClaimHash,
  sceneContentHashForSegments,
  sourceSpanEvidence,
  stableSceneMemoryJson
} from '../src/main/narrative/sceneMemoryCard'
import { storyLedgerRevisionHashV2 } from '../src/main/narrative/storyLedger'
import type {
  SceneMemoryCard,
  SceneMemoryCardBuildInput,
  SceneMemoryCardValidationContext,
  SceneMemoryRelationshipLedgerClaim,
  SceneMemorySourceSegment,
  SceneMemorySourceSpan,
  SceneCommitManifest
} from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else {
    failed += 1
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableHash(value: unknown): string {
  return sha(stableSceneMemoryJson(value))
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function throws(name: string, fn: () => unknown): void {
  try {
    fn()
    check(name, false, 'accepted adversarial input')
  } catch {
    check(name, true)
  }
}

function dbVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0)
}

function tempDb(label: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `deepwriter-r70-${label}-`)), 'deepwriter.db')
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name))
}

function seedOldDb(dbPath: string, version: number, withData: boolean): void {
  const db = new DatabaseSync(dbPath)
  runMigrations(db, version)
  if (withData) {
    db.prepare('INSERT INTO sessions (session_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run(`session-r70-${version}`, 'R70 seed', 'test', 1, 1)
  }
  db.close()
}

function migrationAttacks(): void {
  const emptyPath = tempDb('empty')
  const empty = openDb(emptyPath)
  check('empty database reaches v27', dbVersion(empty as unknown as DatabaseSync) === CURRENT_SCHEMA_VERSION)
  check('v27 scene-memory tables exist', ['scene_memory_cards', 'scene_memory_card_spans', 'scene_recall_entities', 'scene_recall_threads', 'scene_recall_edges', 'scene_recall_terms', 'scene_recall_embeddings', 'scene_working_sets', 'scene_recall_index_meta', 'longform_workflow_snapshots', 'scene_memory_backfills'].every((name) => tableExists(empty as unknown as DatabaseSync, name)))
  const backfillColumns = new Set((empty.prepare('PRAGMA table_info(scene_memory_backfills)').all() as Array<{ name?: string }>).map((row) => String(row.name ?? '')))
  check('backfill stores nullable story/epoch/revision/scene authority', ['story_id', 'project_id', 'branch_id', 'validity_epoch', 'story_revision', 'scene_id'].every((name) => backfillColumns.has(name)))
  closeDb(empty)
  check('empty database gets no fake migration backup', !fs.existsSync(`${emptyPath}.pre-v0.bak`))

  const emptyAgain = openDb(emptyPath)
  check('empty v27 reopen is idempotent', dbVersion(emptyAgain as unknown as DatabaseSync) === CURRENT_SCHEMA_VERSION)
  closeDb(emptyAgain)

  for (const oldVersion of [CURRENT_SCHEMA_VERSION - 2, CURRENT_SCHEMA_VERSION - 1]) {
    const oldPath = tempDb(`v${oldVersion}`)
    seedOldDb(oldPath, oldVersion, true)
    const migrated = openDb(oldPath)
    const backupPath = `${oldPath}.pre-v${oldVersion}.bak`
    const backup = new DatabaseSync(backupPath)
    check(`v${oldVersion}->v27 migration completes`, dbVersion(migrated as unknown as DatabaseSync) === CURRENT_SCHEMA_VERSION)
    check(`v${oldVersion} migration creates readable backup`, fs.statSync(backupPath).size > 0 && dbVersion(backup) === oldVersion && Boolean(backup.prepare('SELECT 1 FROM sessions LIMIT 1').get()))
    const before = fs.statSync(backupPath)
    backup.close()
    closeDb(migrated)
    const reopened = openDb(oldPath)
    closeDb(reopened)
    const after = fs.statSync(backupPath)
    check(`v${oldVersion} second open does not rewrite backup`, before.size === after.size && before.mtimeMs === after.mtimeMs)
  }

  const failedPath = tempDb('rollback')
  // The injected failure belongs to v27, so start before v27 regardless of
  // the latest unrelated additive migration.
  const rollbackVersion = 26
  seedOldDb(failedPath, rollbackVersion, true)
  const oldInject = process.env.DW_R70_INJECT_V27_FAILURE
  process.env.DW_R70_INJECT_V27_FAILURE = '1'
  let migrationFailed = false
  try { openDb(failedPath) } catch { migrationFailed = true }
  if (oldInject === undefined) delete process.env.DW_R70_INJECT_V27_FAILURE
  else process.env.DW_R70_INJECT_V27_FAILURE = oldInject
  const afterFailure = new DatabaseSync(failedPath)
  const rollbackBackup = new DatabaseSync(`${failedPath}.pre-v${rollbackVersion}.bak`)
  check('injected v27 migration failure is surfaced', migrationFailed)
  check('failed v27 migration rolls back version and schema', dbVersion(afterFailure) === rollbackVersion && !tableExists(afterFailure, 'scene_memory_cards'))
  check('failed migration leaves an old readable backup', dbVersion(rollbackBackup) === rollbackVersion && Boolean(rollbackBackup.prepare('SELECT 1 FROM sessions LIMIT 1').get()))
  afterFailure.close()
  rollbackBackup.close()
  const recovered = openDb(failedPath)
  check('same database can recover after injected failure', dbVersion(recovered as unknown as DatabaseSync) === CURRENT_SCHEMA_VERSION && tableExists(recovered as unknown as DatabaseSync, 'scene_memory_cards'))
  closeDb(recovered)
}

type Fixture = {
  dbPath: string
  repo: Repository
  input: SceneMemoryProjectionInput
  card: SceneMemoryCard
  context: SceneMemoryCardValidationContext
  scope: { storyId: string; projectId: string; branchId: string; validityEpoch: number; storyRevision: number; sceneId: string }
  runId: string
  sessionId: string
  segmentId: string
  ledgerChangeId: string
}

function makeFixture(label: string, mutate?: (db: DatabaseSync, ids: { segmentId: string; ledgerChangeId: string }) => void): Fixture {
  const dbPath = tempDb(label)
  const storyId = 'story-r70'
  const projectId = 'project-r70'
  const branchId = 'main'
  const runId = `run-r70-${label.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const sessionId = `session-r70-${label.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const sceneId = 'scene-r70'
  const segmentId = 'segment-r70'
  const ledgerChangeId = 'ledger-r70-relationship'
  const contractId = 'contract-r70'
  const contractHash = sha(contractId)
  const stateDeltaHash = sha('delta-r70')
  const content = 'ava在雨夜把钥匙交给li。问题：钥匙能否安全交接？变化：不信任到合作。行动：交接钥匙。转折：li取得钥匙。代价：暴露行踪。关系维度：trust。'
  const contentHash = sha(content)
  const charCount = Array.from(content).length
  const completionDecisionHash = sha('decision-r70')
  const manifestBase = {
    schemaVersion: 1 as const,
    runId,
    sceneId,
    contractId,
    contractHash,
    acceptedSegments: [{ segmentId, contentHash, charCount, chunkIndex: 0, revision: 1 }],
    sceneContentHash: contentHash,
    sceneCharCount: charCount,
    completionDecisionHash,
    stateDeltaHash
  }
  const commitManifestHash = sha(stableSceneMemoryJson(manifestBase))
  const segment: SceneMemorySourceSegment = {
    segmentId,
    content,
    contentHash,
    segmentRevision: 1,
    status: 'accepted',
    sceneId,
    commitId: `${runId}:${sceneId}`,
    commitManifestHash,
    chunkIndex: 0
  }
  const span: SceneMemorySourceSpan = {
    spanId: 'span-r70-all',
    segmentId,
    segmentHash: contentHash,
    segmentRevision: 1,
    manifestHash: commitManifestHash,
    startUtf16: 0,
    endUtf16: content.length,
    text: content,
    spanHash: contentHash
  }
  const source = sourceSpanEvidence(span)
  const claimPayload = {
    kind: 'relationship' as const,
    id: ledgerChangeId,
    revision: 1,
    validityEpoch: 1,
    storyId,
    projectId,
    branchId,
    stateDeltaHash,
    commitManifestHash,
    fromCharacterId: 'ava',
    toCharacterId: 'li',
    dimension: 'trust'
  }
  const claim = { ...claimPayload, hash: sceneMemoryLedgerClaimHash(claimPayload) }
  const relationshipLedgerRef = ledgerEvidence(claim.id, claim.hash)
  const fieldEvidence = {
    povCharacterId: [source],
    'locations:雨夜': [source],
    'objects:钥匙': [source],
    dramaticQuestion: [source],
    'valueShift.from': [source],
    'valueShift.to': [source],
    decisiveAction: [source],
    turn: [source],
    cost: [source]
  }
  const buildInput: SceneMemoryCardBuildInput = {
    schemaVersion: 1,
    status: 'canonical',
    cardId: 'card-r70',
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
    sceneContentHash: sceneContentHashForSegments([segment]),
    commitManifestHash,
    stateDeltaHash,
    povCharacterId: 'ava',
    participants: [],
    locations: ['雨夜'],
    objects: ['钥匙'],
    dramaticQuestion: '钥匙能否安全交接？',
    valueShift: { from: '不信任', to: '合作' },
    decisiveAction: '交接钥匙',
    turn: 'li取得钥匙',
    cost: '暴露行踪',
    factsEstablished: [],
    beliefChanges: [],
    relationshipChanges: [{ fromCharacterId: 'ava', toCharacterId: 'li', dimension: 'trust', from: '不信任', to: '合作', evidence: [source, relationshipLedgerRef] }],
    threads: [],
    motifs: [],
    distinctivePhrases: [],
    sourceSegments: [segment],
    sourceSpans: [span],
    fieldEvidence,
    expectedScope: { storyId, projectId, branchId },
    expectedValidityEpoch: 1,
    expectedStoryRevision: 1,
    expectedContract: { contractId, contractHash },
    expectedBindings: { sceneContentHash: contentHash, commitManifestHash, stateDeltaHash },
    ledgerClaims: [claim],
    createdAt: 1000
  }
  const card = buildSceneMemoryCard(buildInput)
  const context: SceneMemoryCardValidationContext = {
    sourceSegments: [segment],
    expectedScope: { storyId, projectId, branchId },
    expectedValidityEpoch: 1,
    expectedStoryRevision: 1,
    expectedContract: { contractId, contractHash },
    expectedBindings: { sceneContentHash: contentHash, commitManifestHash, stateDeltaHash },
    ledgerClaims: [claim]
  }

  const repo = createRepository(dbPath)
  repo.open()
  repo.createRun({
    run_id: runId,
    session_id: sessionId,
    status: 'running',
    phase: 'writing',
    started_at: 1,
    updated_at: 1,
    config_json: JSON.stringify({ storyScope: { schemaVersion: 1, storyId, projectId, branchId } }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  })
  repo.close()

  const db = openDb(dbPath) as unknown as DatabaseSync
  db.exec('PRAGMA foreign_keys = ON')
  db.prepare(`INSERT INTO manuscript_segments
    (segment_id,run_id,session_id,source_turn_id,section_id,scene_id,chunk_index,revision,status,kind,content,content_hash,char_count,supersedes_segment_id,created_at,updated_at,accepted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(segmentId, runId, sessionId, null, 'section-r70', sceneId, 0, 1, 'accepted', 'prose', content, contentHash, charCount, null, 1, 1, 1)
  db.prepare(`INSERT INTO scene_states
    (run_id,scene_id,section_id,contract_id,contract_hash,scene_order,lifecycle,revision,candidate_segment_id,candidate_hash,accepted_segment_id,accepted_hash,completion_decision_json,completion_evidence_hash,created_at,updated_at,completed_at,committed_at)
    VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?)`).run(runId, sceneId, 'section-r70', contractId, contractHash, 1, 'committed', 1, segmentId, contentHash, segmentId, contentHash, '{}', completionDecisionHash, 1, 1, 1, 1)
  db.prepare(`INSERT INTO narrative_commits
    (run_id,scene_id,accepted_segment_id,accepted_content_hash,contract_hash,delta_hash,delta_json,revision,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(runId, sceneId, segmentId, contentHash, contractHash, stateDeltaHash, '{}', 1, 1)
  db.prepare(`INSERT INTO scene_commit_manifests (run_id,scene_id,revision,manifest_json,manifest_hash,created_at)
    VALUES (?,?,?,?,?,?)`).run(runId, sceneId, 1, stableSceneMemoryJson(manifestBase), commitManifestHash, 1)
  db.prepare(`INSERT INTO narrative_ledger
    (run_id,scene_id,change_id,change_revision,accepted_segment_id,accepted_content_hash,contract_hash,change_kind,entity_id,payload_json,delta_hash,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, sceneId, ledgerChangeId, 1, segmentId, contentHash, contractHash, 'relationship', 'ava->li', stableSceneMemoryJson({ fromCharacterId: 'ava', toCharacterId: 'li', dimension: 'trust', from: '不信任', to: '合作' }), stateDeltaHash, 1)
  const revisionHash = storyLedgerRevisionHashV2({ storyId, projectId, branchId, revision: 1, parentRevision: 0, parentHash: null, runId, sceneId, deltaHash: stateDeltaHash, manifestHash: commitManifestHash, nodeType: 'revision', hashSchemaVersion: 2 })
  db.prepare('UPDATE story_ledger_heads SET high_watermark=1,head_hash=?,validity_epoch=1,hash_schema_version=2,updated_at=1 WHERE story_id=? AND project_id=? AND branch_id=?').run(revisionHash, storyId, projectId, branchId)
  db.prepare('UPDATE story_ledger_runs SET current_revision=1,validity_epoch=1,updated_at=1 WHERE run_id=?').run(runId)
  db.prepare(`INSERT INTO story_ledger_revisions
    (story_id,project_id,branch_id,revision,parent_story_id,parent_project_id,parent_branch_id,parent_revision,run_id,scene_id,accepted_segment_id,accepted_content_hash,contract_hash,delta_hash,delta_json,manifest_json,manifest_hash,parent_hash,node_type,hash_schema_version,revision_hash,validity_epoch,rebase_parent_revision,rebase_parent_hash,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(storyId, projectId, branchId, 1, null, null, null, 0, runId, sceneId, segmentId, contentHash, contractHash, stateDeltaHash, '{}', stableSceneMemoryJson(manifestBase), commitManifestHash, null, 'revision', 2, revisionHash, 1, null, null, 1)
  mutate?.(db, { segmentId, ledgerChangeId })
  closeDb(db as never)
  const reopened = createRepository(dbPath)
  reopened.open()
  const input: SceneMemoryProjectionInput = { card, context }
  return { dbPath, repo: reopened, input, card, context, scope: { storyId, projectId, branchId, validityEpoch: 1, storyRevision: 1, sceneId }, runId, sessionId, segmentId, ledgerChangeId }
}

function repositoryAttacks(): void {
  const f = makeFixture('core')
  const first = f.repo.upsertSceneMemoryCard(f.input)
  check('canonical source-bound card publishes', first.inserted && first.card.cardHash === f.card.cardHash)
  check('default get returns published card', f.repo.getSceneMemoryCard({ cardId: f.card.cardId })?.cardHash === f.card.cardHash)
  check('default list returns only active card', f.repo.listSceneMemoryCards(f.scope).length === 1)

  const second = f.repo.upsertSceneMemoryCard(f.input)
  check('same identity and payload is idempotent', !second.inserted && second.card.cardHash === f.card.cardHash)
  const timestampReplay = f.repo.upsertSceneMemoryCard({ card: { ...f.card, createdAt: 2000 }, context: f.context })
  check('same semantic card with a fresh createdAt is idempotent', !timestampReplay.inserted && timestampReplay.card.cardHash === f.card.cardHash)
  const rebuild1 = f.repo.rebuildSceneMemoryProjection(f.scope, [f.input])
  const rebuild2 = f.repo.rebuildSceneMemoryProjection(f.scope, [f.input])
  check('projection rebuild is deterministic', JSON.stringify(rebuild1) === JSON.stringify(rebuild2) && rebuild1.cardCount === 1)
  throws('rebuild rejects duplicate card inputs', () => f.repo.rebuildSceneMemoryProjection(f.scope, [f.input, f.input]))

  const workingPayload = { purpose: 'r70', cardIds: [f.card.cardId] }
  const workingScope = { ...f.scope, storyRevision: f.scope.storyRevision + 1, sceneId: `${f.scope.sceneId}-current` }
  const workingSetHash = stableHash({ ...workingScope, queryHash: sha('query-r70'), cardIds: [f.card.cardId], omitted: [], payload: workingPayload })
  f.repo.saveSceneWorkingSet({ workingSetId: 'working-r70', ...workingScope, queryHash: sha('query-r70'), cardIds: [f.card.cardId], omitted: [], payload: workingPayload, workingSetHash, createdAt: 1 })
  check('working set round-trips by hash', f.repo.getSceneWorkingSet('working-r70')?.workingSetHash === workingSetHash)
  throws('working set rejects duplicate card ids', () => f.repo.saveSceneWorkingSet({ workingSetId: 'working-r70-dup', ...f.scope, queryHash: sha('query-r70-dup'), cardIds: [f.card.cardId, f.card.cardId], omitted: [], payload: {}, workingSetHash: stableHash({}), createdAt: 1 }))
  throws('working set rejects an unknown status', () => f.repo.saveSceneWorkingSet({ workingSetId: 'working-r70-status', ...workingScope, queryHash: sha('query-r70-status'), cardIds: [f.card.cardId], omitted: [], payload: {}, workingSetHash: stableHash({}), status: '???', createdAt: 1 }))
  throws('working set rejects a non-finite createdAt', () => f.repo.saveSceneWorkingSet({ workingSetId: 'working-r70-time', ...workingScope, queryHash: sha('query-r70-time'), cardIds: [f.card.cardId], omitted: [], payload: {}, workingSetHash: stableHash({}), createdAt: Number.POSITIVE_INFINITY }))

  const historical = makeFixture('working-history')
  const secondHistorical = addHistoricalSceneCard(historical, 'history-2', 'scene-r70-history-2', 2)
  historical.repo.upsertSceneMemoryCard(historical.input)
  historical.repo.upsertSceneMemoryCard(secondHistorical)
  const historicalWorkingScope = { ...historical.scope, storyRevision: 2, sceneId: 'scene-r70-current' }
  const historicalCardIds = [historical.card.cardId, secondHistorical.card.cardId]
  const historicalPayload = { purpose: 'two-historical-scenes', cardIds: historicalCardIds }
  const historicalHash = stableHash({ ...historicalWorkingScope, queryHash: sha('query-r70-history'), cardIds: historicalCardIds, omitted: [], payload: historicalPayload })
  historical.repo.saveSceneWorkingSet({ workingSetId: 'working-r70-history', ...historicalWorkingScope, queryHash: sha('query-r70-history'), cardIds: historicalCardIds, omitted: [], payload: historicalPayload, workingSetHash: historicalHash, createdAt: 1 })
  check('working set recalls two historical scene cards into current scene', historical.repo.getSceneWorkingSet('working-r70-history')?.cardIds.length === 2)
  throws('working set rejects a future revision card', () => historical.repo.saveSceneWorkingSet({ workingSetId: 'working-r70-future', ...historicalWorkingScope, storyRevision: 1, queryHash: sha('query-r70-future'), cardIds: [secondHistorical.card.cardId], omitted: [], payload: {}, workingSetHash: stableHash({ ...historicalWorkingScope, storyRevision: 1, queryHash: sha('query-r70-future'), cardIds: [secondHistorical.card.cardId], omitted: [], payload: {} }), createdAt: 1 }))
  const currentSceneScope = { ...historicalWorkingScope, sceneId: historical.card.sceneId }
  throws('working set rejects the current scene card', () => historical.repo.saveSceneWorkingSet({ workingSetId: 'working-r70-current', ...currentSceneScope, queryHash: sha('query-r70-current'), cardIds: [historical.card.cardId], omitted: [], payload: {}, workingSetHash: stableHash({ ...currentSceneScope, queryHash: sha('query-r70-current'), cardIds: [historical.card.cardId], omitted: [], payload: {} }), createdAt: 1 }))
  historical.repo.close()

  const snapshotPayload = { phase: 'recall', cards: [f.card.cardId] }
  const snapshotHash = stableHash(snapshotPayload)
  f.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70', ...f.scope, runId: f.runId, workflowKey: 'recall', workflowRevision: 1, status: 'ready', payload: snapshotPayload, payloadHash: snapshotHash, createdAt: 1 })
  check('workflow snapshot round-trips by content hash', f.repo.getLongformWorkflowSnapshot(f.runId, 'recall')?.payloadHash === snapshotHash)
  throws('workflow snapshot rejects same identity with a different hash', () => f.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-conflict', ...f.scope, runId: f.runId, workflowKey: 'recall', workflowRevision: 1, status: 'ready', payload: { phase: 'tampered' }, payloadHash: stableHash({ phase: 'tampered' }), createdAt: 2 }))
  throws('workflow snapshot rejects NaN payloads instead of normalizing them', () => f.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-nan', ...f.scope, runId: f.runId, workflowKey: 'nan', workflowRevision: 1, status: 'ready', payload: { value: Number.NaN }, payloadHash: stableHash({ value: Number.NaN }), createdAt: 1 }))
  const sparsePayload: unknown[] = []
  sparsePayload.length = 1
  throws('workflow snapshot rejects sparse arrays instead of normalizing holes', () => f.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-sparse', ...f.scope, runId: f.runId, workflowKey: 'sparse', workflowRevision: 1, status: 'ready', payload: sparsePayload, payloadHash: stableHash(sparsePayload), createdAt: 1 }))
  const datePayload = new Date(0)
  throws('workflow snapshot rejects Date instances instead of normalizing them to objects', () => f.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-date', ...f.scope, runId: f.runId, workflowKey: 'date', workflowRevision: 1, status: 'ready', payload: datePayload, payloadHash: stableHash(datePayload), createdAt: 1 }))
  throws('workflow snapshot rejects an unknown status', () => f.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-status', ...f.scope, runId: f.runId, workflowKey: 'bad-status', workflowRevision: 1, status: '???', payload: {}, payloadHash: stableHash({}), createdAt: 1 }))
  throws('workflow snapshot rejects a non-finite createdAt', () => f.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-time', ...f.scope, runId: f.runId, workflowKey: 'bad-time', workflowRevision: 1, status: 'ready', payload: {}, payloadHash: stableHash({}), createdAt: Number.POSITIVE_INFINITY }))

  const snapshotReadAuthority = makeFixture('snapshot-read-authority')
  snapshotReadAuthority.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-read-authority', ...snapshotReadAuthority.scope, runId: snapshotReadAuthority.runId, workflowKey: 'read', workflowRevision: 1, status: 'ready', payload: { phase: 'read' }, payloadHash: stableHash({ phase: 'read' }), createdAt: 1 })
  const snapshotReadAuthorityDb = openDb(snapshotReadAuthority.dbPath) as unknown as DatabaseSync
  snapshotReadAuthorityDb.prepare('UPDATE longform_workflow_snapshots SET story_id=? WHERE snapshot_id=?').run('', 'snapshot-r70-read-authority')
  snapshotReadAuthorityDb.close()
  throws('workflow snapshot read rejects authority-column tampering', () => snapshotReadAuthority.repo.getLongformWorkflowSnapshot(snapshotReadAuthority.runId, 'read'))
  snapshotReadAuthority.repo.close()

  const snapshotReadHash = makeFixture('snapshot-read-hash')
  snapshotReadHash.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-read-hash', ...snapshotReadHash.scope, runId: snapshotReadHash.runId, workflowKey: 'read', workflowRevision: 1, status: 'ready', payload: { phase: 'read' }, payloadHash: stableHash({ phase: 'read' }), createdAt: 1 })
  const snapshotReadHashDb = openDb(snapshotReadHash.dbPath) as unknown as DatabaseSync
  snapshotReadHashDb.prepare('UPDATE longform_workflow_snapshots SET payload_hash=? WHERE snapshot_id=?').run(sha('tampered-snapshot'), 'snapshot-r70-read-hash')
  snapshotReadHashDb.close()
  throws('workflow snapshot read rejects payload-hash tampering', () => snapshotReadHash.repo.getLongformWorkflowSnapshot(snapshotReadHash.runId, 'read'))
  snapshotReadHash.repo.close()

  const snapshotReadJson = makeFixture('snapshot-read-json')
  snapshotReadJson.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-read-json', ...snapshotReadJson.scope, runId: snapshotReadJson.runId, workflowKey: 'read', workflowRevision: 1, status: 'ready', payload: { phase: 'read' }, payloadHash: stableHash({ phase: 'read' }), createdAt: 1 })
  const snapshotReadJsonDb = openDb(snapshotReadJson.dbPath) as unknown as DatabaseSync
  snapshotReadJsonDb.prepare("UPDATE longform_workflow_snapshots SET payload_json='not-json' WHERE snapshot_id=?").run('snapshot-r70-read-json')
  snapshotReadJsonDb.close()
  throws('workflow snapshot read rejects non-JSON payloads', () => snapshotReadJson.repo.getLongformWorkflowSnapshot(snapshotReadJson.runId, 'read'))
  snapshotReadJson.repo.close()

  const snapshotEpoch = makeFixture('snapshot-head-epoch')
  const oldSnapshotPayload = { phase: 'old-epoch' }
  snapshotEpoch.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-old-epoch', ...snapshotEpoch.scope, runId: snapshotEpoch.runId, workflowKey: 'old-epoch', workflowRevision: 1, status: 'ready', payload: oldSnapshotPayload, payloadHash: stableHash(oldSnapshotPayload), createdAt: 1 })
  const sameScopeRunId = `${snapshotEpoch.runId}-same-scope`
  snapshotEpoch.repo.createRun({
    run_id: sameScopeRunId,
    session_id: `${sameScopeRunId}-session`,
    status: 'running',
    phase: 'writing',
    started_at: 2,
    updated_at: 2,
    config_json: JSON.stringify({ storyScope: { schemaVersion: 1, storyId: snapshotEpoch.scope.storyId, projectId: snapshotEpoch.scope.projectId, branchId: snapshotEpoch.scope.branchId } }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  })
  const sameScopePayload = { phase: 'same-scope-run' }
  snapshotEpoch.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-same-scope', ...snapshotEpoch.scope, runId: sameScopeRunId, workflowKey: 'same-scope', workflowRevision: 1, status: 'ready', payload: sameScopePayload, payloadHash: stableHash(sameScopePayload), createdAt: 2 })
  check('workflow snapshots accept multiple runs in one live scope', snapshotEpoch.repo.getLongformWorkflowSnapshot(sameScopeRunId, 'same-scope')?.payloadHash === stableHash(sameScopePayload))
  const epochDb = openDb(snapshotEpoch.dbPath) as unknown as DatabaseSync
  const epochHead = epochDb.prepare('SELECT head_hash FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(snapshotEpoch.scope.storyId, snapshotEpoch.scope.projectId, snapshotEpoch.scope.branchId) as { head_hash?: string | null } | undefined
  const nextDeltaHash = sha('r70-head-epoch-delta')
  const nextSceneId = 'scene-r70-head-epoch'
  const nextRevisionHash = storyLedgerRevisionHashV2({ storyId: snapshotEpoch.scope.storyId, projectId: snapshotEpoch.scope.projectId, branchId: snapshotEpoch.scope.branchId, revision: 2, parentRevision: 1, parentHash: epochHead?.head_hash ?? null, runId: sameScopeRunId, sceneId: nextSceneId, deltaHash: nextDeltaHash, manifestHash: null, nodeType: 'revision', hashSchemaVersion: 2 })
  epochDb.prepare(`INSERT INTO story_ledger_revisions
    (story_id,project_id,branch_id,revision,parent_story_id,parent_project_id,parent_branch_id,parent_revision,run_id,scene_id,accepted_segment_id,accepted_content_hash,contract_hash,delta_hash,delta_json,manifest_json,manifest_hash,parent_hash,node_type,hash_schema_version,revision_hash,validity_epoch,rebase_parent_revision,rebase_parent_hash,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(snapshotEpoch.scope.storyId, snapshotEpoch.scope.projectId, snapshotEpoch.scope.branchId, 2, null, null, null, 1, sameScopeRunId, nextSceneId, snapshotEpoch.segmentId, snapshotEpoch.card.sceneContentHash, snapshotEpoch.card.contractHash, nextDeltaHash, '{}', null, null, epochHead?.head_hash ?? null, 'revision', 2, nextRevisionHash, 1, null, null, 2)
  epochDb.prepare('UPDATE story_ledger_heads SET high_watermark=2,head_hash=?,updated_at=? WHERE story_id=? AND project_id=? AND branch_id=?').run(nextRevisionHash, 2, snapshotEpoch.scope.storyId, snapshotEpoch.scope.projectId, snapshotEpoch.scope.branchId)
  epochDb.prepare('UPDATE story_ledger_runs SET current_revision=2,validity_epoch=1,updated_at=? WHERE run_id=?').run(2, sameScopeRunId)
  epochDb.close()
  snapshotEpoch.repo.deleteRun(sameScopeRunId, 'retract')
  const epochHeadAfter = openDb(snapshotEpoch.dbPath) as unknown as DatabaseSync
  const updatedEpoch = epochHeadAfter.prepare('SELECT validity_epoch, high_watermark FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(snapshotEpoch.scope.storyId, snapshotEpoch.scope.projectId, snapshotEpoch.scope.branchId) as { validity_epoch?: number; high_watermark?: number } | undefined
  check('retraction advances the scope validity epoch', updatedEpoch?.validity_epoch === 2 && Number(updatedEpoch.high_watermark) === 3)
  epochHeadAfter.close()
  throws('old-epoch snapshot read rejects after head epoch advances', () => snapshotEpoch.repo.getLongformWorkflowSnapshot(snapshotEpoch.runId, 'old-epoch'))
  throws('old-epoch snapshot save rejects after head epoch advances', () => snapshotEpoch.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-old-epoch-new', ...snapshotEpoch.scope, runId: snapshotEpoch.runId, workflowKey: 'old-epoch-new', workflowRevision: 1, status: 'ready', payload: oldSnapshotPayload, payloadHash: stableHash(oldSnapshotPayload), createdAt: 3 }))
  snapshotEpoch.repo.close()

  f.repo.markSceneMemoryCardVisibility(f.card.cardId, 'stale')
  check('stale card is hidden by default', f.repo.getSceneMemoryCard({ cardId: f.card.cardId }) === null && f.repo.listSceneMemoryCards(f.scope).length === 0)
  check('stale card remains available to audit read', f.repo.getSceneMemoryCard({ cardId: f.card.cardId, includeHidden: true })?.cardHash === f.card.cardHash)
  throws('stale card cannot be publicly reactivated', () => f.repo.markSceneMemoryCardVisibility(f.card.cardId, 'active'))
  f.repo.close()

  const retractCase = makeFixture('retracted')
  retractCase.repo.upsertSceneMemoryCard(retractCase.input)
  const raw = openDb(retractCase.dbPath) as unknown as DatabaseSync
  raw.prepare(`INSERT INTO story_ledger_tombstones (story_id,project_id,branch_id,revision,parent_revision,target_revision,target_revision_hash,target_run_id,target_scene_id,reason,tombstone_hash,committed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(retractCase.scope.storyId, retractCase.scope.projectId, retractCase.scope.branchId, 2, 1, 1, sha('revision-r70'), retractCase.runId, retractCase.scope.sceneId, 'r70 test retraction', sha('tombstone-r70'), 2)
  closeDb(raw as never)
  check('active card with retracted ledger is hidden even from includeHidden', retractCase.repo.getSceneMemoryCard({ cardId: retractCase.card.cardId }) === null && retractCase.repo.getSceneMemoryCard({ cardId: retractCase.card.cardId, includeHidden: true }) === null)
  retractCase.repo.close()

  const idConflict = makeFixture('identity-conflict')
  idConflict.repo.upsertSceneMemoryCard(idConflict.input)
  const changedInput = clone(idConflict.input)
  changedInput.card = buildSceneMemoryCard({ ...getBuildInput(idConflict.input), cardId: idConflict.card.cardId, cost: '交接钥匙', createdAt: 2000 })
  throws('same scope identity with a different card hash is rejected', () => idConflict.repo.upsertSceneMemoryCard(changedInput))
  idConflict.repo.close()

  const bad = makeFixture('authority')
  const badCard = clone(bad.card)
  badCard.stateDeltaHash = sha('tampered-delta')
  badCard.cardHash = sceneMemoryCardHash(badCard)
  throws('state-delta authority tampering is rejected', () => bad.repo.upsertSceneMemoryCard({ card: badCard, context: bad.context }))
  const badContract = clone(bad.card)
  badContract.contractHash = sha('tampered-contract')
  badContract.cardHash = sceneMemoryCardHash(badContract)
  throws('contract authority tampering is rejected', () => bad.repo.upsertSceneMemoryCard({ card: badContract, context: bad.context }))
  const badScope = clone(bad.card)
  badScope.branchId = 'other-branch'
  badScope.cardHash = sceneMemoryCardHash(badScope)
  throws('cross-scope card is rejected', () => bad.repo.upsertSceneMemoryCard({ card: badScope, context: bad.context }))
  const badEpoch = clone(bad.card)
  badEpoch.validityEpoch = 9
  badEpoch.cardHash = sceneMemoryCardHash(badEpoch)
  throws('cross-epoch card is rejected', () => bad.repo.upsertSceneMemoryCard({ card: badEpoch, context: bad.context }))
  const badRevision = clone(bad.card)
  badRevision.storyRevision = 9
  badRevision.cardHash = sceneMemoryCardHash(badRevision)
  throws('cross-revision card is rejected', () => bad.repo.upsertSceneMemoryCard({ card: badRevision, context: bad.context }))
  bad.repo.close()

  const ledgerTamper = makeFixture('ledger-tamper', (db, ids) => {
    db.prepare('UPDATE narrative_ledger SET payload_json=? WHERE change_id=?').run(stableSceneMemoryJson({ fromCharacterId: 'ava', toCharacterId: 'li', dimension: 'respect', from: '不信任', to: '合作' }), ids.ledgerChangeId)
  })
  throws('ledger endpoint/dimension tampering is rejected before publish', () => ledgerTamper.repo.upsertSceneMemoryCard(ledgerTamper.input))
  ledgerTamper.repo.close()

  const arbitraryLedgerHash = makeFixture('ledger-hash-arbitrary')
  const arbitraryBase = arbitraryLedgerHash.context.ledgerClaims[0]!
  const arbitraryClaim = { ...arbitraryBase, hash: sha('r70-arbitrary-ledger-hash') }
  const arbitraryBuild = getBuildInput(arbitraryLedgerHash.input)
  arbitraryBuild.ledgerClaims = [arbitraryClaim]
  arbitraryBuild.relationshipChanges = arbitraryBuild.relationshipChanges.map((edge) => ({
    ...edge,
    evidence: edge.evidence.map((ref) => ref.kind === 'ledger' ? ledgerEvidence(arbitraryClaim.id, arbitraryClaim.hash) : ref)
  }))
  throws('arbitrary ledger claim hash is rejected', () => {
    const card = buildSceneMemoryCard(arbitraryBuild)
    arbitraryLedgerHash.repo.upsertSceneMemoryCard({ card, context: { ...arbitraryLedgerHash.context, ledgerClaims: [arbitraryClaim] } })
  })
  arbitraryLedgerHash.repo.close()

  const recomputedLedgerTamper = makeFixture('ledger-hash-recomputed')
  const recomputedBase = recomputedLedgerTamper.context.ledgerClaims[0]!
  const { hash: _oldHash, ...recomputedPayload } = recomputedBase
  const recomputedClaimPayload = { ...recomputedPayload, fromCharacterId: 'li', toCharacterId: 'ava' }
  const recomputedClaim = { ...recomputedClaimPayload, hash: sceneMemoryLedgerClaimHash(recomputedClaimPayload) }
  const recomputedBuild = getBuildInput(recomputedLedgerTamper.input)
  recomputedBuild.ledgerClaims = [recomputedClaim]
  recomputedBuild.relationshipChanges = recomputedBuild.relationshipChanges.map((edge) => ({
    ...edge,
    fromCharacterId: 'li',
    toCharacterId: 'ava',
    evidence: edge.evidence.map((ref) => ref.kind === 'ledger' ? ledgerEvidence(recomputedClaim.id, recomputedClaim.hash) : ref)
  }))
  throws('recomputed ledger claim tampering is rejected', () => {
    const card = buildSceneMemoryCard(recomputedBuild)
    recomputedLedgerTamper.repo.upsertSceneMemoryCard({ card, context: { ...recomputedLedgerTamper.context, ledgerClaims: [recomputedClaim] } })
  })
  recomputedLedgerTamper.repo.close()

  const sourceTamper = makeFixture('source-tamper', (db, ids) => {
    db.prepare('UPDATE manuscript_segments SET content=? WHERE segment_id=?').run('forged source', ids.segmentId)
  })
  throws('accepted source content tampering is rejected before publish', () => sourceTamper.repo.upsertSceneMemoryCard(sourceTamper.input))
  sourceTamper.repo.close()

  const backfill = makeFixture('backfill')
  backfill.repo.upsertSceneMemoryCard(backfill.input)
  const initial: SceneMemoryBackfillState = { backfillId: 'backfill-r70', storyId: backfill.scope.storyId, projectId: backfill.scope.projectId, branchId: backfill.scope.branchId, validityEpoch: null, storyRevision: null, sceneId: null, inputSnapshotHash: sha('backfill-input-r70'), cursor: null, processedIds: [], totalCount: 2, processedCount: 0, status: 'pending', errorCode: null, createdAt: 1, updatedAt: 1, completedAt: null }
  backfill.repo.startSceneMemoryBackfill(initial)
  backfill.repo.startSceneMemoryBackfill(initial)
  throws('backfill identity conflict is rejected', () => backfill.repo.startSceneMemoryBackfill({ ...initial, inputSnapshotHash: sha('other-input') }))
  backfill.repo.pauseSceneMemoryBackfill(initial.backfillId)
  backfill.repo.saveSceneMemoryBackfillStep({ state: { ...initial, cursor: 'one', processedIds: ['one'], processedCount: 1, status: 'in_progress', updatedAt: 2 } })
  backfill.repo.close()
  const recovered = createRepository(backfill.dbPath)
  recovered.open()
  check('backfill cursor survives close/reopen', recovered.getSceneMemoryBackfill(initial.backfillId)?.processedIds.join(',') === 'one')
  const runtimeBackfill = recovered.getSceneMemoryBackfill(initial.backfillId)
  check('backfill runtime returns the complete resumable shape', runtimeBackfill !== null && [
    'backfillId', 'storyId', 'projectId', 'branchId', 'validityEpoch', 'storyRevision', 'sceneId', 'inputSnapshotHash', 'cursor', 'processedIds',
    'totalCount', 'processedCount', 'status', 'errorCode', 'createdAt', 'updatedAt', 'completedAt'
  ].every((key) => Object.prototype.hasOwnProperty.call(runtimeBackfill, key)) && Array.isArray(runtimeBackfill?.processedIds))
  throws('backfill progress cannot regress', () => recovered.saveSceneMemoryBackfillStep({ state: { ...initial, cursor: null, processedIds: [], processedCount: 0, status: 'in_progress', updatedAt: 3 } }))
  recovered.saveSceneMemoryBackfillStep({ state: { ...initial, cursor: 'two', processedIds: ['one', 'two'], processedCount: 2, status: 'complete', updatedAt: 4, completedAt: 4 } })
  check('backfill resumes and completes exactly once', recovered.getSceneMemoryBackfill(initial.backfillId)?.status === 'complete' && recovered.getSceneMemoryBackfill(initial.backfillId)?.processedCount === 2)
  throws('legacy backfill cannot publish a canonical projection', () => recovered.saveSceneMemoryBackfillStep({ state: { ...initial, backfillId: 'legacy-r70', status: 'legacy_unverified', updatedAt: 5 }, projection: backfill.input }))
  check('legacy/no-exact-evidence backfill created no card', recovered.getSceneMemoryCard({ cardId: 'legacy-r70' }) === null)
  recovered.close()

  const backfillReadCount = makeFixture('backfill-read-count')
  const backfillReadCountState = makeBackfillState(backfillReadCount, 'backfill-r70-read-count')
  backfillReadCount.repo.startSceneMemoryBackfill(backfillReadCountState)
  const backfillReadCountDb = openDb(backfillReadCount.dbPath) as unknown as DatabaseSync
  backfillReadCountDb.prepare('UPDATE scene_memory_backfills SET processed_count=1 WHERE backfill_id=?').run(backfillReadCountState.backfillId)
  backfillReadCountDb.close()
  throws('backfill read rejects processed-count/list mismatch', () => backfillReadCount.repo.getSceneMemoryBackfill(backfillReadCountState.backfillId))
  backfillReadCount.repo.close()

  const backfillReadIds = makeFixture('backfill-read-ids')
  const backfillReadIdsState = makeBackfillState(backfillReadIds, 'backfill-r70-read-ids')
  backfillReadIds.repo.startSceneMemoryBackfill(backfillReadIdsState)
  const backfillReadIdsDb = openDb(backfillReadIds.dbPath) as unknown as DatabaseSync
  backfillReadIdsDb.prepare('UPDATE scene_memory_backfills SET processed_ids_json=? WHERE backfill_id=?').run(stableSceneMemoryJson(['same', 'same']), backfillReadIdsState.backfillId)
  backfillReadIdsDb.close()
  throws('backfill read rejects duplicate processed ids', () => backfillReadIds.repo.getSceneMemoryBackfill(backfillReadIdsState.backfillId))
  backfillReadIds.repo.close()

  const backfillReadStatus = makeFixture('backfill-read-status')
  const backfillReadStatusState = makeBackfillState(backfillReadStatus, 'backfill-r70-read-status')
  backfillReadStatus.repo.startSceneMemoryBackfill(backfillReadStatusState)
  const backfillReadStatusDb = openDb(backfillReadStatus.dbPath) as unknown as DatabaseSync
  backfillReadStatusDb.prepare("UPDATE scene_memory_backfills SET status='complete' WHERE backfill_id=?").run(backfillReadStatusState.backfillId)
  backfillReadStatusDb.close()
  throws('backfill read rejects incomplete complete status', () => backfillReadStatus.repo.getSceneMemoryBackfill(backfillReadStatusState.backfillId))
  backfillReadStatus.repo.close()

  const backfillReadHash = makeFixture('backfill-read-hash')
  const backfillReadHashState = makeBackfillState(backfillReadHash, 'backfill-r70-read-hash')
  backfillReadHash.repo.startSceneMemoryBackfill(backfillReadHashState)
  const backfillReadHashDb = openDb(backfillReadHash.dbPath) as unknown as DatabaseSync
  backfillReadHashDb.prepare('UPDATE scene_memory_backfills SET input_snapshot_hash=? WHERE backfill_id=?').run('not-a-sha256', backfillReadHashState.backfillId)
  backfillReadHashDb.close()
  throws('backfill read rejects invalid input snapshot hash', () => backfillReadHash.repo.getSceneMemoryBackfill(backfillReadHashState.backfillId))
  backfillReadHash.repo.close()

  const backfillReadTime = makeFixture('backfill-read-time')
  const backfillReadTimeState = makeBackfillState(backfillReadTime, 'backfill-r70-read-time')
  backfillReadTime.repo.startSceneMemoryBackfill(backfillReadTimeState)
  const backfillReadTimeDb = openDb(backfillReadTime.dbPath) as unknown as DatabaseSync
  backfillReadTimeDb.prepare('UPDATE scene_memory_backfills SET updated_at=? WHERE backfill_id=?').run('not-a-number', backfillReadTimeState.backfillId)
  backfillReadTimeDb.close()
  throws('backfill read rejects non-finite timestamps', () => backfillReadTime.repo.getSceneMemoryBackfill(backfillReadTimeState.backfillId))
  backfillReadTime.repo.close()

  const backfillProjectionScope = makeFixture('backfill-projection-scope')
  const backfillProjectionScopeState = makeBackfillState(backfillProjectionScope, 'backfill-r70-projection-scope')
  backfillProjectionScope.repo.startSceneMemoryBackfill(backfillProjectionScopeState)
  throws('backfill projection rejects a mismatched story scope', () => backfillProjectionScope.repo.saveSceneMemoryBackfillStep({ state: { ...backfillProjectionScopeState, storyId: 'other-story', processedIds: [backfillProjectionScope.card.cardId], processedCount: 1, status: 'in_progress', updatedAt: 2 }, projection: backfillProjectionScope.input }))
  backfillProjectionScope.repo.close()

  const backfillProjectionAuthority = makeFixture('backfill-projection-authority')
  const authorityState: SceneMemoryBackfillState = { ...makeBackfillState(backfillProjectionAuthority, 'backfill-r70-projection-authority'), validityEpoch: 1, storyRevision: 1, sceneId: backfillProjectionAuthority.scope.sceneId }
  backfillProjectionAuthority.repo.startSceneMemoryBackfill(authorityState)
  const authorityMismatches: Array<[string, Partial<SceneMemoryBackfillState>]> = [
    ['story', { storyId: 'other-story' }],
    ['project', { projectId: 'other-project' }],
    ['branch', { branchId: 'other-branch' }],
    ['epoch', { validityEpoch: 2 }],
    ['revision', { storyRevision: 2 }],
    ['scene', { sceneId: 'other-scene' }]
  ]
  for (const [label, mismatch] of authorityMismatches) {
    throws(`backfill projection rejects mismatched ${label} authority`, () => backfillProjectionAuthority.repo.saveSceneMemoryBackfillStep({
      state: { ...authorityState, ...mismatch, processedIds: [backfillProjectionAuthority.card.cardId], processedCount: 1, status: 'complete', updatedAt: 2, completedAt: 2 },
      projection: backfillProjectionAuthority.input
    }))
  }
  backfillProjectionAuthority.repo.saveSceneMemoryBackfillStep({ state: { ...authorityState, processedIds: [backfillProjectionAuthority.card.cardId], processedCount: 1, status: 'complete', updatedAt: 2, completedAt: 2 }, projection: backfillProjectionAuthority.input })
  check('canonical backfill projection persists only with complete authority tuple', backfillProjectionAuthority.repo.getSceneMemoryBackfill(authorityState.backfillId)?.validityEpoch === 1 && backfillProjectionAuthority.repo.getSceneMemoryCard({ cardId: backfillProjectionAuthority.card.cardId })?.cardHash === backfillProjectionAuthority.card.cardHash)
  backfillProjectionAuthority.repo.close()

  const termFallback = makeFixture('term-evidence-fallback')
  const fallbackBuild = getBuildInput(termFallback.input)
  const fallbackEvidence = { ...fallbackBuild.fieldEvidence }
  const objectRefs = fallbackEvidence['objects:钥匙']
  const locationRefs = fallbackEvidence['locations:雨夜']
  delete fallbackEvidence['objects:钥匙']
  delete fallbackEvidence['locations:雨夜']
  // Deliberately exercise both fallback forms accepted by the card validator:
  // a field-level key for objects and an indexed key for locations.
  fallbackEvidence.objects = objectRefs
  fallbackEvidence['locations[0]'] = locationRefs
  fallbackBuild.fieldEvidence = fallbackEvidence
  fallbackBuild.cardId = 'card-r70-term-fallback'
  const fallbackCard = buildSceneMemoryCard(fallbackBuild)
  termFallback.repo.upsertSceneMemoryCard({ card: fallbackCard, context: termFallback.context })
  const termDb = openDb(termFallback.dbPath) as unknown as DatabaseSync
  const termRows = termDb.prepare('SELECT term_kind,term,evidence_json FROM scene_recall_terms WHERE card_id=? AND term_kind IN (\'object\',\'location\') ORDER BY term_kind,term').all(fallbackCard.cardId) as Array<{ term_kind?: string; term?: string; evidence_json?: string }>
  check('object/location fallback evidence is persisted non-empty', termRows.length === 2 && termRows.every((row) => {
    try { const evidence = JSON.parse(String(row.evidence_json ?? '')) as unknown; return Array.isArray(evidence) && evidence.length > 0 } catch { return false }
  }))
  termDb.close()
  termFallback.repo.close()

  const outboxCase = makeFixture('outbox-cross-run')
  outboxCase.repo.upsertSceneMemoryCard(outboxCase.input)
  const secondRunId = `${outboxCase.runId}-second`
  outboxCase.repo.createRun({
    run_id: secondRunId,
    session_id: `${secondRunId}-session`,
    status: 'running',
    phase: 'writing',
    started_at: 2,
    updated_at: 2,
    config_json: JSON.stringify({ storyScope: { schemaVersion: 1, storyId: outboxCase.scope.storyId, projectId: outboxCase.scope.projectId, branchId: outboxCase.scope.branchId } }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  })
  const outboxDb = openDb(outboxCase.dbPath) as unknown as DatabaseSync
  const secondCardHash = sha('r70-outbox-second-card')
  // Give the second pending outbox row a surviving card owner.  The payload is
  // also run-labelled so implementations that use payload extraction instead
  // of a schema column remain testable.
  outboxDb.prepare(`INSERT INTO scene_memory_cards (
    card_id,schema_version,status,visibility,story_id,project_id,branch_id,validity_epoch,story_revision,run_id,scene_id,scene_order,
    contract_id,contract_hash,scene_content_hash,commit_manifest_hash,state_delta_hash,card_hash,card_json,created_at,updated_at
  ) SELECT ?,schema_version,status,'active',story_id,project_id,branch_id,validity_epoch,story_revision+1,?, 'scene-r70-outbox-2',scene_order,
    contract_id,contract_hash,scene_content_hash,commit_manifest_hash,state_delta_hash,?,card_json,created_at,updated_at
    FROM scene_memory_cards WHERE card_id=?`).run('card-r70-outbox-2', secondRunId, secondCardHash, outboxCase.card.cardId)
  outboxDb.prepare('UPDATE scene_memory_card_outbox SET status=\'pending\',error_code=NULL WHERE card_hash=?').run(outboxCase.card.cardHash)
  const outboxColumns = new Set((outboxDb.prepare('PRAGMA table_info(scene_memory_card_outbox)').all() as Array<{ name?: string }>).map((row) => String(row.name ?? '')))
  const insertPendingOutbox = (row: { outboxId: string; runId: string; sceneId: string; revision: number; cardHash: string }): void => {
    const values: Record<string, string | number | null> = {
      outbox_id: row.outboxId,
      story_id: outboxCase.scope.storyId,
      project_id: outboxCase.scope.projectId,
      branch_id: outboxCase.scope.branchId,
      validity_epoch: 1,
      story_revision: row.revision,
      scene_id: row.sceneId,
      commit_manifest_hash: outboxCase.card.commitManifestHash,
      card_hash: row.cardHash,
      payload_json: stableSceneMemoryJson({ cardId: row.cardHash, runId: row.runId, storyId: outboxCase.scope.storyId }),
      status: 'pending',
      error_code: null,
      created_at: 2,
      updated_at: 2
    }
    if (outboxColumns.has('run_id')) values.run_id = row.runId
    const names = Object.keys(values).filter((name) => outboxColumns.has(name))
    outboxDb.prepare(`INSERT INTO scene_memory_card_outbox (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((name) => values[name]))
  }
  // The first row was created by upsert; only create the second distinct row.
  insertPendingOutbox({ outboxId: 'outbox-r70-second', runId: secondRunId, sceneId: 'scene-r70-outbox-2', revision: 2, cardHash: secondCardHash })
  outboxDb.close()
  outboxCase.repo.deleteRun(outboxCase.runId, 'preserve')
  const outboxAfter = openDb(outboxCase.dbPath) as unknown as DatabaseSync
  const firstOutbox = outboxAfter.prepare('SELECT status,error_code FROM scene_memory_card_outbox WHERE card_hash=?').get(outboxCase.card.cardHash) as { status?: string; error_code?: string } | undefined
  const secondOutbox = outboxAfter.prepare('SELECT status,error_code FROM scene_memory_card_outbox WHERE card_hash=?').get(secondCardHash) as { status?: string; error_code?: string } | undefined
  check('deleteRun rejects only the deleted run outbox row', firstOutbox?.status === 'rejected' && firstOutbox.error_code === 'run_deleted')
  check('same-story second run pending outbox survives deletion', secondOutbox?.status === 'pending' && secondOutbox.error_code === null)
  outboxAfter.close()
  outboxCase.repo.close()

  const workingHashTamper = makeFixture('working-read-hash')
  workingHashTamper.repo.upsertSceneMemoryCard(workingHashTamper.input)
  const hashWorking = saveWorkingSetFixture(workingHashTamper, 'working-r70-read-hash')
  const hashWorkingDb = openDb(workingHashTamper.dbPath) as unknown as DatabaseSync
  hashWorkingDb.prepare('UPDATE scene_working_sets SET working_set_hash=? WHERE working_set_id=?').run(sha('forged-working-set-hash'), hashWorking.workingSetId)
  hashWorkingDb.close()
  throws('working-set read rejects stored hash tampering', () => workingHashTamper.repo.getSceneWorkingSet(hashWorking.workingSetId))
  workingHashTamper.repo.close()

  const workingJsonTamper = makeFixture('working-read-json')
  workingJsonTamper.repo.upsertSceneMemoryCard(workingJsonTamper.input)
  const jsonWorking = saveWorkingSetFixture(workingJsonTamper, 'working-r70-read-json')
  const jsonWorkingDb = openDb(workingJsonTamper.dbPath) as unknown as DatabaseSync
  jsonWorkingDb.prepare("UPDATE scene_working_sets SET payload_json='not-json' WHERE working_set_id=?").run(jsonWorking.workingSetId)
  jsonWorkingDb.close()
  throws('working-set read rejects malformed strict JSON', () => workingJsonTamper.repo.getSceneWorkingSet(jsonWorking.workingSetId))
  workingJsonTamper.repo.close()

  const workingIdsTamper = makeFixture('working-read-ids')
  workingIdsTamper.repo.upsertSceneMemoryCard(workingIdsTamper.input)
  const idsWorking = saveWorkingSetFixture(workingIdsTamper, 'working-r70-read-ids')
  const idsWorkingDb = openDb(workingIdsTamper.dbPath) as unknown as DatabaseSync
  const duplicateIds = [workingIdsTamper.card.cardId, workingIdsTamper.card.cardId]
  const duplicateHash = stableHash({ ...idsWorking.workingScope, queryHash: idsWorking.queryHash, cardIds: duplicateIds, omitted: idsWorking.omitted, payload: idsWorking.payload })
  idsWorkingDb.prepare('UPDATE scene_working_sets SET card_ids_json=?,working_set_hash=? WHERE working_set_id=?').run(stableSceneMemoryJson(duplicateIds), duplicateHash, idsWorking.workingSetId)
  idsWorkingDb.close()
  throws('working-set read rejects duplicate card references even with recomputed hash', () => workingIdsTamper.repo.getSceneWorkingSet(idsWorking.workingSetId))
  workingIdsTamper.repo.close()

  const workingVisibilityTamper = makeFixture('working-read-visibility')
  workingVisibilityTamper.repo.upsertSceneMemoryCard(workingVisibilityTamper.input)
  const visibilityWorking = saveWorkingSetFixture(workingVisibilityTamper, 'working-r70-read-visibility')
  workingVisibilityTamper.repo.markSceneMemoryCardVisibility(workingVisibilityTamper.card.cardId, 'stale')
  let hiddenWorking: unknown = null
  let hiddenWorkingFailed = false
  try { hiddenWorking = workingVisibilityTamper.repo.getSceneWorkingSet(visibilityWorking.workingSetId) } catch { hiddenWorkingFailed = true }
  check('working-set read fails closed when a referenced card is hidden', hiddenWorkingFailed || hiddenWorking === null)
  workingVisibilityTamper.repo.close()

  const rebuildRetracted = makeFixture('rebuild-retracted')
  rebuildRetracted.repo.upsertSceneMemoryCard(rebuildRetracted.input)
  const retractedDb = openDb(rebuildRetracted.dbPath) as unknown as DatabaseSync
  retractedDb.prepare(`INSERT INTO story_ledger_tombstones (story_id,project_id,branch_id,revision,parent_revision,target_revision,target_revision_hash,target_run_id,target_scene_id,reason,tombstone_hash,committed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(rebuildRetracted.scope.storyId, rebuildRetracted.scope.projectId, rebuildRetracted.scope.branchId, 2, 1, 1, sha('rebuild-retracted-revision'), rebuildRetracted.runId, rebuildRetracted.scope.sceneId, 'r70 rebuild retraction', sha('rebuild-retracted-tombstone'), 2)
  retractedDb.close()
  throws('rebuild cannot revive a retracted ledger projection', () => rebuildRetracted.repo.rebuildSceneMemoryProjection(rebuildRetracted.scope, [rebuildRetracted.input]))
  rebuildRetracted.repo.close()

  const rebuildOrphan = makeFixture('rebuild-orphan')
  rebuildOrphan.repo.upsertSceneMemoryCard(rebuildOrphan.input)
  rebuildOrphan.repo.deleteRun(rebuildOrphan.runId, 'preserve')
  throws('rebuild cannot revive an orphaned run projection', () => rebuildOrphan.repo.rebuildSceneMemoryProjection(rebuildOrphan.scope, [rebuildOrphan.input]))
  rebuildOrphan.repo.close()

  const rebuildOutbox = makeFixture('rebuild-outbox-mismatch')
  rebuildOutbox.repo.upsertSceneMemoryCard(rebuildOutbox.input)
  const rebuildOutboxDb = openDb(rebuildOutbox.dbPath) as unknown as DatabaseSync
  rebuildOutboxDb.prepare("UPDATE scene_memory_cards SET visibility='stale' WHERE card_id=?").run(rebuildOutbox.card.cardId)
  rebuildOutboxDb.prepare("UPDATE scene_memory_card_outbox SET status='rejected',error_code='r70_inconsistent' WHERE card_hash=?").run(rebuildOutbox.card.cardHash)
  rebuildOutboxDb.close()
  throws('rebuild cannot revive a card with rejected outbox state', () => rebuildOutbox.repo.rebuildSceneMemoryProjection(rebuildOutbox.scope, [rebuildOutbox.input]))
  rebuildOutbox.repo.close()

  const rebuildActiveOutbox = makeFixture('rebuild-active-outbox')
  rebuildActiveOutbox.repo.upsertSceneMemoryCard(rebuildActiveOutbox.input)
  const rebuildActiveOutboxDb = openDb(rebuildActiveOutbox.dbPath) as unknown as DatabaseSync
  rebuildActiveOutboxDb.prepare("UPDATE scene_memory_card_outbox SET payload_json=? WHERE card_hash=?").run(stableSceneMemoryJson({ tampered: true }), rebuildActiveOutbox.card.cardHash)
  rebuildActiveOutboxDb.close()
  throws('rebuild rejects an active card whose published outbox payload was tampered', () => rebuildActiveOutbox.repo.rebuildSceneMemoryProjection(rebuildActiveOutbox.scope, [rebuildActiveOutbox.input]))
  const rebuildActiveIndexDb = openDb(rebuildActiveOutbox.dbPath) as unknown as DatabaseSync
  const rebuildActiveIndex = rebuildActiveIndexDb.prepare('SELECT status FROM scene_recall_index_meta WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=? AND story_revision=?').get(rebuildActiveOutbox.scope.storyId, rebuildActiveOutbox.scope.projectId, rebuildActiveOutbox.scope.branchId, rebuildActiveOutbox.scope.validityEpoch, rebuildActiveOutbox.scope.storyRevision) as { status?: string } | undefined
  check('tampered active outbox does not publish a ready index', !rebuildActiveIndex || rebuildActiveIndex.status !== 'ready')
  rebuildActiveIndexDb.close()
  rebuildActiveOutbox.repo.close()

  const deleteCase = makeFixture('delete-cascade')
  deleteCase.repo.upsertSceneMemoryCard(deleteCase.input)
  const deleteWorking = saveWorkingSetFixture(deleteCase, 'working-r70-delete-run')
  const deleteSnapshotPayload = { phase: 'delete-run', cardId: deleteCase.card.cardId }
  deleteCase.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-delete-run', ...deleteCase.scope, runId: deleteCase.runId, workflowKey: 'delete-run', workflowRevision: 1, status: 'ready', payload: deleteSnapshotPayload, payloadHash: stableHash(deleteSnapshotPayload), createdAt: 1 })
  deleteCase.repo.rebuildSceneMemoryProjection(deleteCase.scope, [deleteCase.input])
  const deleteDbBefore = openDb(deleteCase.dbPath) as unknown as DatabaseSync
  deleteDbBefore.prepare("UPDATE scene_memory_card_outbox SET status='pending',error_code=NULL WHERE card_hash=?").run(deleteCase.card.cardHash)
  deleteDbBefore.close()
  // Exercise the public deletion path rather than bypassing Repository with
  // raw SQL: every derived projection must become non-default-readable.
  deleteCase.repo.deleteRun(deleteCase.runId, 'preserve')
  const deleteDb = openDb(deleteCase.dbPath) as unknown as DatabaseSync
  const orphan = deleteDb.prepare('SELECT visibility FROM scene_memory_cards WHERE card_id=?').get(deleteCase.card.cardId) as { visibility?: string } | undefined
  const deleteOutbox = deleteDb.prepare('SELECT status FROM scene_memory_card_outbox WHERE card_hash=?').get(deleteCase.card.cardHash) as { status?: string } | undefined
  const deleteWorkingRow = deleteDb.prepare('SELECT status FROM scene_working_sets WHERE working_set_id=?').get(deleteWorking.workingSetId) as { status?: string } | undefined
  const deleteIndexRow = deleteDb.prepare('SELECT status FROM scene_recall_index_meta WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=? AND story_revision=?').get(deleteCase.scope.storyId, deleteCase.scope.projectId, deleteCase.scope.branchId, deleteCase.scope.validityEpoch, deleteCase.scope.storyRevision) as { status?: string } | undefined
  const deleteSnapshotRow = deleteDb.prepare('SELECT 1 AS present FROM longform_workflow_snapshots WHERE snapshot_id=?').get('snapshot-r70-delete-run') as { present?: number } | undefined
  check('deleting canonical run does not leave a visible orphan projection', !orphan || orphan.visibility !== 'active')
  check('deleteRun rejects its pending outbox', deleteOutbox?.status === 'rejected')
  check('deleteRun hides its working set', !deleteWorkingRow || deleteWorkingRow.status !== 'active')
  check('deleteRun hides its recall index meta', !deleteIndexRow || deleteIndexRow.status !== 'ready')
  check('deleteRun blocks default working-set read', (() => { try { return deleteCase.repo.getSceneWorkingSet(deleteWorking.workingSetId) === null } catch { return true } })())
  check('deleteRun blocks default workflow snapshot read', (() => { try { return deleteCase.repo.getLongformWorkflowSnapshot(deleteCase.runId, 'delete-run') === null } catch { return true } })())
  check('deleteRun leaves no default-readable snapshot row', !deleteSnapshotRow || deleteSnapshotRow.present !== 1 || (() => { try { return deleteCase.repo.getLongformWorkflowSnapshot(deleteCase.runId, 'delete-run') === null } catch { return true } })())
  deleteDb.close()
  deleteCase.repo.close()

  const deleteSessionCase = makeFixture('delete-session-projections')
  deleteSessionCase.repo.upsertSceneMemoryCard(deleteSessionCase.input)
  const deleteSessionWorking = saveWorkingSetFixture(deleteSessionCase, 'working-r70-delete-session')
  const deleteSessionSnapshotPayload = { phase: 'recall', cardId: deleteSessionCase.card.cardId }
  deleteSessionCase.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-delete-session', ...deleteSessionCase.scope, runId: deleteSessionCase.runId, workflowKey: 'recall', workflowRevision: 1, status: 'ready', payload: deleteSessionSnapshotPayload, payloadHash: stableHash(deleteSessionSnapshotPayload), createdAt: 1 })
  deleteSessionCase.repo.rebuildSceneMemoryProjection(deleteSessionCase.scope, [deleteSessionCase.input])
  deleteSessionCase.repo.deleteSession(deleteSessionCase.sessionId)
  const deleteSessionDb = openDb(deleteSessionCase.dbPath) as unknown as DatabaseSync
  const deleteSessionCard = deleteSessionDb.prepare('SELECT visibility FROM scene_memory_cards WHERE card_id=?').get(deleteSessionCase.card.cardId) as { visibility?: string } | undefined
  const deleteSessionOutbox = deleteSessionDb.prepare('SELECT status FROM scene_memory_card_outbox WHERE card_hash=?').get(deleteSessionCase.card.cardHash) as { status?: string } | undefined
  const deleteSessionWorkingRow = deleteSessionDb.prepare('SELECT status FROM scene_working_sets WHERE working_set_id=?').get(deleteSessionWorking.workingSetId) as { status?: string } | undefined
  const deleteSessionIndex = deleteSessionDb.prepare('SELECT status FROM scene_recall_index_meta WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=? AND story_revision=?').get(deleteSessionCase.scope.storyId, deleteSessionCase.scope.projectId, deleteSessionCase.scope.branchId, deleteSessionCase.scope.validityEpoch, deleteSessionCase.scope.storyRevision) as { status?: string } | undefined
  const deleteSessionSnapshot = deleteSessionDb.prepare('SELECT status FROM longform_workflow_snapshots WHERE run_id=?').get(deleteSessionCase.runId) as { status?: string } | undefined
  check('deleteSession hides its run-owned card and rejects outbox', deleteSessionCard?.visibility === 'stale' && deleteSessionOutbox?.status === 'rejected', JSON.stringify({ card: deleteSessionCard, outbox: deleteSessionOutbox }))
  check('deleteSession invalidates working set/index/snapshot', deleteSessionWorkingRow?.status === 'stale' && deleteSessionIndex?.status === 'stale' && deleteSessionSnapshot?.status === 'stale')
  deleteSessionDb.close()
  check('deleteSession default reads hide all projections', deleteSessionCase.repo.getSceneMemoryCard({ cardId: deleteSessionCase.card.cardId }) === null && deleteSessionCase.repo.getSceneWorkingSet(deleteSessionWorking.workingSetId) === null && deleteSessionCase.repo.getLongformWorkflowSnapshot(deleteSessionCase.runId, 'recall') === null)
  check('deleteSession keeps only audit-hidden card access', deleteSessionCase.repo.getSceneMemoryCard({ cardId: deleteSessionCase.card.cardId, includeHidden: true })?.cardHash === deleteSessionCase.card.cardHash)
  deleteSessionCase.repo.close()

  const sessionDelete = makeFixture('delete-session')
  sessionDelete.repo.upsertSceneMemoryCard(sessionDelete.input)
  const sessionWorking = saveWorkingSetFixture(sessionDelete, 'working-r70-delete-session')
  const sessionSnapshotPayload = { phase: 'delete-session', cardId: sessionDelete.card.cardId }
  sessionDelete.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-delete-session', ...sessionDelete.scope, runId: sessionDelete.runId, workflowKey: 'delete-session', workflowRevision: 1, status: 'ready', payload: sessionSnapshotPayload, payloadHash: stableHash(sessionSnapshotPayload), createdAt: 1 })
  sessionDelete.repo.rebuildSceneMemoryProjection(sessionDelete.scope, [sessionDelete.input])
  const sessionDbBefore = openDb(sessionDelete.dbPath) as unknown as DatabaseSync
  sessionDbBefore.prepare("UPDATE scene_memory_card_outbox SET status='pending',error_code=NULL WHERE card_hash=?").run(sessionDelete.card.cardHash)
  sessionDbBefore.close()
  sessionDelete.repo.deleteSession(sessionDelete.sessionId)
  const sessionDb = openDb(sessionDelete.dbPath) as unknown as DatabaseSync
  const sessionCard = sessionDb.prepare('SELECT visibility FROM scene_memory_cards WHERE card_id=?').get(sessionDelete.card.cardId) as { visibility?: string } | undefined
  const sessionOutbox = sessionDb.prepare('SELECT status FROM scene_memory_card_outbox WHERE card_hash=?').get(sessionDelete.card.cardHash) as { status?: string } | undefined
  const sessionIndex = sessionDb.prepare('SELECT status FROM scene_recall_index_meta WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=? AND story_revision=?').get(sessionDelete.scope.storyId, sessionDelete.scope.projectId, sessionDelete.scope.branchId, sessionDelete.scope.validityEpoch, sessionDelete.scope.storyRevision) as { status?: string } | undefined
  check('deleteSession blocks default card read', (() => { try { return sessionDelete.repo.getSceneMemoryCard({ cardId: sessionDelete.card.cardId }) === null } catch { return true } })())
  check('deleteSession hides the card row', !sessionCard || sessionCard.visibility !== 'active')
  check('deleteSession rejects the pending outbox', !sessionOutbox || sessionOutbox.status === 'rejected')
  check('deleteSession hides the working set', (() => { try { return sessionDelete.repo.getSceneWorkingSet(sessionWorking.workingSetId) === null } catch { return true } })())
  check('deleteSession hides the recall index meta', !sessionIndex || sessionIndex.status !== 'ready')
  check('deleteSession blocks the workflow snapshot', (() => { try { return sessionDelete.repo.getLongformWorkflowSnapshot(sessionDelete.runId, 'delete-session') === null } catch { return true } })())
  sessionDb.close()
  sessionDelete.repo.close()

  const retractState = makeFixture('delete-retract-state')
  retractState.repo.upsertSceneMemoryCard(retractState.input)
  const retractWorking = saveWorkingSetFixture(retractState, 'working-r70-retract-state')
  const retractSnapshotPayload = { phase: 'retract-state', cardId: retractState.card.cardId }
  retractState.repo.saveLongformWorkflowSnapshot({ snapshotId: 'snapshot-r70-retract-state', ...retractState.scope, runId: retractState.runId, workflowKey: 'retract-state', workflowRevision: 1, status: 'ready', payload: retractSnapshotPayload, payloadHash: stableHash(retractSnapshotPayload), createdAt: 1 })
  retractState.repo.rebuildSceneMemoryProjection(retractState.scope, [retractState.input])
  const retractDbBefore = openDb(retractState.dbPath) as unknown as DatabaseSync
  retractDbBefore.prepare("UPDATE scene_memory_card_outbox SET status='pending',error_code=NULL WHERE card_hash=?").run(retractState.card.cardHash)
  retractDbBefore.close()
  retractState.repo.deleteRun(retractState.runId, 'retract')
  const retractDb = openDb(retractState.dbPath) as unknown as DatabaseSync
  const retractCard = retractDb.prepare('SELECT visibility FROM scene_memory_cards WHERE card_id=?').get(retractState.card.cardId) as { visibility?: string } | undefined
  const retractWorkingRow = retractDb.prepare('SELECT status FROM scene_working_sets WHERE working_set_id=?').get(retractWorking.workingSetId) as { status?: string } | undefined
  const retractIndexRow = retractDb.prepare('SELECT status FROM scene_recall_index_meta WHERE story_id=? AND project_id=? AND branch_id=? AND validity_epoch=? AND story_revision=?').get(retractState.scope.storyId, retractState.scope.projectId, retractState.scope.branchId, retractState.scope.validityEpoch, retractState.scope.storyRevision) as { status?: string } | undefined
  check('retract blocks the card by default', (() => { try { return retractState.repo.getSceneMemoryCard({ cardId: retractState.card.cardId }) === null } catch { return true } })())
  check('retract marks the card non-active', !retractCard || retractCard.visibility !== 'active')
  check('retract hides the working set', !retractWorkingRow || retractWorkingRow.status !== 'active')
  check('retract hides the recall index meta', !retractIndexRow || retractIndexRow.status !== 'ready')
  check('retract blocks the workflow snapshot', (() => { try { return retractState.repo.getLongformWorkflowSnapshot(retractState.runId, 'retract-state') === null } catch { return true } })())
  retractDb.close()
  retractState.repo.close()

  const fkCase = makeFixture('foreign-key')
  fkCase.repo.upsertSceneMemoryCard(fkCase.input)
  const fkDb = openDb(fkCase.dbPath) as unknown as DatabaseSync
  let fkRejected = false
  try { fkDb.prepare('INSERT INTO scene_memory_card_spans (card_id,span_id,segment_id,segment_hash,segment_revision,manifest_hash,start_utf16,end_utf16,span_text,span_hash) VALUES (?,?,?,?,?,?,?,?,?,?)').run('missing-card', 'span', 'segment', sha('segment'), 1, sha('manifest'), 0, 1, 'x', sha('x')) } catch { fkRejected = true }
  fkDb.prepare('DELETE FROM scene_memory_cards WHERE card_id=?').run(fkCase.card.cardId)
  const dependents = Number((fkDb.prepare('SELECT COUNT(*) AS n FROM scene_memory_card_spans WHERE card_id=?').get(fkCase.card.cardId) as { n?: number }).n ?? -1)
  check('projection foreign key rejects dangling spans', fkRejected)
  check('projection delete cascades its derived rows', dependents === 0)
  fkDb.close()
  fkCase.repo.close()
}

/** Add a second committed historical scene to one fixture.  This keeps the
 * working-set test honest: recall must accept multiple earlier scenes without
 * accepting the current scene or a future revision. */
function addHistoricalSceneCard(base: Fixture, label: string, sceneId: string, storyRevision: number): SceneMemoryProjectionInput {
  const baseSegment = base.context.sourceSegments[0]
  if (!baseSegment) throw new Error('historical_fixture_segment_missing')
  const content = baseSegment.content
  const contentHash = baseSegment.contentHash
  const segmentId = `${baseSegment.segmentId}-${label}`
  const stateDeltaHash = sha(`${label}:delta`)
  const contractId = base.card.contractId
  const contractHash = base.card.contractHash
  const manifest: SceneCommitManifest = {
    schemaVersion: 1,
    runId: base.runId,
    sceneId,
    contractId,
    contractHash,
    acceptedSegments: [{ segmentId, contentHash, charCount: Array.from(content).length, chunkIndex: storyRevision, revision: 1 }],
    sceneContentHash: contentHash,
    sceneCharCount: Array.from(content).length,
    completionDecisionHash: sha(`${label}:decision`),
    stateDeltaHash
  }
  const commitManifestHash = stableHash(manifest)
  const segment: SceneMemorySourceSegment = { ...baseSegment, segmentId, sceneId, chunkIndex: storyRevision, commitId: `${base.runId}:${sceneId}`, commitManifestHash, contentHash, content }
  const span: SceneMemorySourceSpan = { ...base.card.sourceSpans[0], spanId: `${base.card.sourceSpans[0]?.spanId ?? 'span'}-${label}`, segmentId, segmentHash: contentHash, segmentRevision: 1, manifestHash: commitManifestHash, startUtf16: 0, endUtf16: content.length, text: content, spanHash: contentHash }
  const source = sourceSpanEvidence(span)
  const relationship = base.context.ledgerClaims.find((claim): claim is SceneMemoryRelationshipLedgerClaim => claim.kind === 'relationship')
  if (!relationship) throw new Error('historical_fixture_relationship_missing')
  const { hash: _relationshipHash, ...relationshipPayload } = relationship
  const claimPayload = { ...relationshipPayload, id: `${relationship.id}-${label}`, revision: storyRevision, stateDeltaHash, commitManifestHash }
  const claim: SceneMemoryRelationshipLedgerClaim = { ...claimPayload, hash: sceneMemoryLedgerClaimHash(claimPayload) }
  const fieldEvidence = Object.fromEntries(Object.keys(base.card.fieldEvidence).map((key) => [key, [source]]))
  const relationshipChanges = base.card.relationshipChanges.map((item) => ({ ...item, evidence: [source, ledgerEvidence(claim.id, claim.hash)] }))
  const buildInput: SceneMemoryCardBuildInput = {
    ...base.card,
    cardId: `${base.card.cardId}-${label}`,
    storyRevision,
    sceneId,
    sceneOrder: base.card.sceneOrder + storyRevision,
    sceneContentHash: sceneContentHashForSegments([segment]),
    commitManifestHash,
    stateDeltaHash,
    relationshipChanges,
    fieldEvidence,
    sourceSegments: [segment],
    sourceSpans: [span],
    sourceSegmentIds: [segmentId],
    expectedScope: { storyId: base.card.storyId, projectId: base.card.projectId, branchId: base.card.branchId },
    expectedValidityEpoch: base.card.validityEpoch,
    expectedStoryRevision: storyRevision,
    expectedContract: { contractId, contractHash },
    expectedBindings: { sceneContentHash: contentHash, commitManifestHash, stateDeltaHash },
    ledgerClaims: [claim],
    createdAt: base.card.createdAt + storyRevision
  }
  const card = buildSceneMemoryCard(buildInput)
  const context: SceneMemoryCardValidationContext = {
    sourceSegments: [segment],
    expectedScope: { storyId: base.card.storyId, projectId: base.card.projectId, branchId: base.card.branchId },
    expectedValidityEpoch: base.card.validityEpoch,
    expectedStoryRevision: storyRevision,
    expectedContract: { contractId, contractHash },
    expectedBindings: { sceneContentHash: contentHash, commitManifestHash, stateDeltaHash },
    ledgerClaims: [claim]
  }
  const db = openDb(base.dbPath) as unknown as DatabaseSync
  db.exec('BEGIN')
  db.prepare(`INSERT INTO manuscript_segments
    (segment_id,run_id,session_id,source_turn_id,section_id,scene_id,chunk_index,revision,status,kind,content,content_hash,char_count,supersedes_segment_id,created_at,updated_at,accepted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(segmentId, base.runId, base.sessionId, null, `section-${label}`, sceneId, storyRevision, 1, 'accepted', 'prose', content, contentHash, Array.from(content).length, null, 1, 1, 1)
  db.prepare(`INSERT INTO scene_states
    (run_id,scene_id,section_id,contract_id,contract_hash,scene_order,lifecycle,revision,candidate_segment_id,candidate_hash,accepted_segment_id,accepted_hash,completion_decision_json,completion_evidence_hash,created_at,updated_at,completed_at,committed_at)
    VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?)`).run(base.runId, sceneId, `section-${label}`, contractId, contractHash, buildInput.sceneOrder, 'committed', 1, segmentId, contentHash, segmentId, contentHash, '{}', sha(`${label}:evidence`), 1, 1, 1, 1)
  const delta = { schemaVersion: 1, runId: base.runId, sceneId, acceptedSegmentId: segmentId, acceptedContentHash: contentHash, contractHash, changes: [{ changeId: claim.id, revision: storyRevision, kind: 'relationship', entityId: `${relationship.fromCharacterId}:${relationship.toCharacterId}:${relationship.dimension}`, runId: base.runId, sceneId, acceptedSegmentId: segmentId, acceptedContentHash: contentHash, contractHash, fromCharacterId: relationship.fromCharacterId, toCharacterId: relationship.toCharacterId, dimension: relationship.dimension, from: base.card.relationshipChanges[0]?.from ?? null, to: base.card.relationshipChanges[0]?.to ?? null }], deltaHash: stateDeltaHash }
  db.prepare(`INSERT INTO narrative_commits
    (run_id,scene_id,accepted_segment_id,accepted_content_hash,contract_hash,delta_hash,delta_json,revision,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(base.runId, sceneId, segmentId, contentHash, contractHash, stateDeltaHash, stableSceneMemoryJson(delta), 1, 1)
  db.prepare('INSERT INTO scene_commit_manifests (run_id,scene_id,revision,manifest_json,manifest_hash,created_at) VALUES (?,?,?,?,?,?)').run(base.runId, sceneId, 1, stableSceneMemoryJson(manifest), commitManifestHash, 1)
  db.prepare(`INSERT INTO narrative_ledger
    (run_id,scene_id,change_id,change_revision,accepted_segment_id,accepted_content_hash,contract_hash,change_kind,entity_id,payload_json,delta_hash,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(base.runId, sceneId, claim.id, storyRevision, segmentId, contentHash, contractHash, 'relationship', `${relationship.fromCharacterId}:${relationship.toCharacterId}:${relationship.dimension}`, stableSceneMemoryJson(delta.changes[0]), stateDeltaHash, 1)
  const parentHash = (db.prepare('SELECT head_hash FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(base.card.storyId, base.card.projectId, base.card.branchId) as { head_hash?: string | null } | undefined)?.head_hash ?? null
  const revisionHash = storyLedgerRevisionHashV2({ storyId: base.card.storyId, projectId: base.card.projectId, branchId: base.card.branchId, revision: storyRevision, parentRevision: storyRevision - 1, parentHash, runId: base.runId, sceneId, deltaHash: stateDeltaHash, manifestHash: commitManifestHash, nodeType: 'revision', hashSchemaVersion: 2 })
  db.prepare(`INSERT INTO story_ledger_revisions
    (story_id,project_id,branch_id,revision,parent_story_id,parent_project_id,parent_branch_id,parent_revision,run_id,scene_id,accepted_segment_id,accepted_content_hash,contract_hash,delta_hash,delta_json,manifest_json,manifest_hash,parent_hash,node_type,hash_schema_version,revision_hash,validity_epoch,rebase_parent_revision,rebase_parent_hash,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(base.card.storyId, base.card.projectId, base.card.branchId, storyRevision, null, null, null, storyRevision - 1, base.runId, sceneId, segmentId, contentHash, contractHash, stateDeltaHash, stableSceneMemoryJson(delta), stableSceneMemoryJson(manifest), commitManifestHash, parentHash, 'revision', 2, revisionHash, base.card.validityEpoch, null, null, 1)
  db.prepare('UPDATE story_ledger_heads SET high_watermark=?,head_hash=?,updated_at=? WHERE story_id=? AND project_id=? AND branch_id=?').run(storyRevision, revisionHash, 1, base.card.storyId, base.card.projectId, base.card.branchId)
  db.prepare('UPDATE story_ledger_runs SET current_revision=?,validity_epoch=1,updated_at=? WHERE run_id=?').run(storyRevision, 1, base.runId)
  db.exec('COMMIT')
  db.close()
  return { card, context }
}

function getBuildInput(input: SceneMemoryProjectionInput): SceneMemoryCardBuildInput {
  const card = input.card
  return {
    ...card,
    sourceSegments: input.context.sourceSegments.slice(),
    sourceSpans: card.sourceSpans.slice(),
    fieldEvidence: card.fieldEvidence,
    expectedScope: input.context.expectedScope,
    expectedValidityEpoch: input.context.expectedValidityEpoch,
    expectedStoryRevision: input.context.expectedStoryRevision,
    expectedContract: input.context.expectedContract,
    expectedBindings: input.context.expectedBindings,
    ledgerClaims: input.context.ledgerClaims
  }
}

function saveWorkingSetFixture(fixture: Fixture, workingSetId: string): { workingSetId: string; queryHash: string; payload: unknown; omitted: unknown[]; workingSetHash: string; workingScope: { storyId: string; projectId: string; branchId: string; validityEpoch: number; storyRevision: number; sceneId: string } } {
  const queryHash = sha(`${workingSetId}:query`)
  const payload = { purpose: workingSetId, cardIds: [fixture.card.cardId] }
  const omitted: unknown[] = []
  const workingScope = { ...fixture.scope, storyRevision: fixture.scope.storyRevision + 1, sceneId: `${fixture.scope.sceneId}-current` }
  const workingSetHash = stableHash({ ...workingScope, queryHash, cardIds: [fixture.card.cardId], omitted, payload })
  fixture.repo.saveSceneWorkingSet({ workingSetId, ...workingScope, queryHash, cardIds: [fixture.card.cardId], omitted, payload, workingSetHash, createdAt: 1 })
  return { workingSetId, queryHash, payload, omitted, workingSetHash, workingScope }
}

function makeBackfillState(fixture: Fixture, backfillId: string): SceneMemoryBackfillState {
  return { backfillId, storyId: fixture.scope.storyId, projectId: fixture.scope.projectId, branchId: fixture.scope.branchId, validityEpoch: null, storyRevision: null, sceneId: null, inputSnapshotHash: sha(`${backfillId}:input`), cursor: null, processedIds: [], totalCount: 1, processedCount: 0, status: 'pending', errorCode: null, createdAt: 1, updatedAt: 1, completedAt: null }
}

function main(): void {
  try {
    migrationAttacks()
    repositoryAttacks()
  } catch (error) {
    failed += 1
    console.error(`R70 harness exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
  console.log(`R70 scene-memory persistence adversarial: ${passed} PASS / ${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
}

main()
