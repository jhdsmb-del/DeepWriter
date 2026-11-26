import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CURRENT_SCHEMA_VERSION, closeDb, openDb, runMigrations } from '../src/main/db/migrations'
import { createRepository, type Repository, type RunRow } from '../src/main/db/repository'
import { compileSceneWorkingSet } from '../src/main/narrative/sceneContextCompiler'
import { buildDeterministicRecallIndex, SCENE_RECALL_BM25_VERSION, SCENE_RECALL_TOKENIZER_VERSION, sceneRecallSourceCardSetHash } from '../src/main/narrative/recallIndex'
import { sceneRecallSourceSnapshotSetHash } from '../src/main/narrative/sceneContextCompiler'
import { stableSceneMemoryJson } from '../src/main/narrative/sceneMemoryCard'
import { storyLedgerGenesisHeadHash, storyLedgerRevisionHashV2 } from '../src/main/narrative/storyLedger'
import { providerEnvelopeHash } from '../src/main/providerEnvelope'
import type { SceneContract, SceneContextCompilerInput, SceneRecallCorpusSnapshot, SceneRecallQuery } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1
  else {
    failed += 1
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function sha(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableSceneMemoryJson(value), 'utf8').digest('hex')
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-r72-ws-'))
const dbPath = path.join(root, 'deepwriter.sqlite')
const runId = 'r72-persistence-run'
const sessionId = 'r72-persistence-session'
const storyId = 'r72-persistence-story'
const projectId = 'r72-persistence-project'
const branchId = 'main'
const sceneId = 'r72-persistence-scene'
const headRevision = 1
const emptySourceCardSetHash = sceneRecallSourceCardSetHash([])
const emptySourceSnapshotHash = sceneRecallSourceSnapshotSetHash([])
const contractHash = sha('r72-contract')

function makeRun(): RunRow {
  return {
    run_id: runId,
    session_id: sessionId,
    status: 'completed',
    phase: 'writing',
    started_at: 1,
    updated_at: 1,
    config_json: JSON.stringify({ storyScope: { schemaVersion: 1, storyId, projectId, branchId } }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  }
}

function seedHead(): string {
  const revisionHash = storyLedgerRevisionHashV2({ storyId, projectId, branchId, revision: 1, parentRevision: 0, parentHash: null, runId, sceneId, deltaHash: sha('r72-delta'), manifestHash: sha('r72-manifest'), nodeType: 'revision', hashSchemaVersion: 2 })
  const db = openDb(dbPath)
  db.prepare(`INSERT INTO story_ledger_revisions (
    story_id,project_id,branch_id,revision,parent_story_id,parent_project_id,parent_branch_id,parent_revision,
    run_id,scene_id,accepted_segment_id,accepted_content_hash,contract_hash,delta_hash,delta_json,manifest_json,
    manifest_hash,parent_hash,node_type,hash_schema_version,revision_hash,validity_epoch,rebase_parent_revision,
    rebase_parent_hash,committed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    storyId, projectId, branchId, 1, null, null, null, 0, runId, sceneId, 'segment', sha('segment'), contractHash,
    sha('r72-delta'), '{}', '{}', sha('r72-manifest'), null, 'revision', 2, revisionHash, 1, null, null, 1
  )
  db.prepare('UPDATE story_ledger_heads SET high_watermark=1,head_hash=?,validity_epoch=1,updated_at=? WHERE story_id=? AND project_id=? AND branch_id=?').run(revisionHash, 1, storyId, projectId, branchId)
  db.prepare('UPDATE story_ledger_runs SET current_revision=1,validity_epoch=1,updated_at=? WHERE run_id=?').run(1, runId)
  closeDb(db)
  return revisionHash
}

function makeContract(): SceneContract {
  const base: Omit<SceneContract, 'frozenHash'> = {
    schemaVersion: 1,
    contractId: 'r72-contract-current',
    sceneId,
    sectionId: 'section-1',
    revision: 1,
    order: 1,
    title: '持久化测试场景',
    objective: '验证工作集持久化',
    activeCharacterIds: ['hero'],
    characterIds: ['hero'],
    desire: '保持一致',
    obstacle: '重启与并发',
    conflict: '必须拒绝过期数据',
    requiredBeatIds: [],
    requiredFactIds: [],
    forbiddenFactIds: [],
    mustHappen: [],
    mustNotHappen: [],
    handoff: '继续',
    threadActions: [],
    expectedStateChanges: [],
    targetChars: { min: 1, ideal: 10, max: 100 },
    acceptanceCriteria: ['可恢复'],
    sourceIds: ['r72'],
    outlineHash: sha('r72-outline')
  }
  return { ...base, frozenHash: sha(JSON.stringify(base)) }
}

function makeSnapshot(): { snapshot: SceneRecallCorpusSnapshot; query: SceneRecallQuery } {
  const scope = { storyId, projectId, branchId, branchLineage: [branchId], validityEpoch: 1, storyRevision: 1, sceneId, headRevision, headHash: seedHash, expectedSourceCardSetHash: emptySourceCardSetHash }
  const snapshot: SceneRecallCorpusSnapshot = { schemaVersion: 1, runId, sceneId, scope, sourceSnapshotHash: emptySourceSnapshotHash, sourceCardSetHash: emptySourceCardSetHash, corpus: [] }
  const query: SceneRecallQuery = { scope, tokenizerVersion: SCENE_RECALL_TOKENIZER_VERSION, bm25Version: SCENE_RECALL_BM25_VERSION, topK: 20 }
  return { snapshot, query }
}

function migrationV29Evidence(): void {
  const migrationPath = path.join(root, 'v29-populated-v28.sqlite')
  // This fixture exercises the actual v29 migration and its injected failure,
  // not whichever unrelated additive migration happens to be latest.
  const oldVersion = 28
  const oldPayload = stableSceneMemoryJson({ source: 'v28', canonical: null })
  const insertLegacyRow = (db: DatabaseSync, workingSetId: string, payloadJson = oldPayload): void => {
    db.prepare(`INSERT INTO scene_working_sets (
      working_set_id,story_id,project_id,branch_id,validity_epoch,story_revision,scene_id,query_hash,
      card_ids_json,omitted_json,payload_json,working_set_hash,status,created_at,updated_at,
      schema_version,run_id,branch_lineage_json,branch_cutoffs_json,canonical_json,canonical_hash,final_envelope_hash
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      workingSetId, storyId, projectId, branchId, 1, 1, 'v28-migration-scene', sha('v28-query'), '[]', '[]', payloadJson,
      sha({ workingSetId, payloadJson }), 'stale', 11, 12, null, null, null, null, null, null, null
    )
  }
  const db = new DatabaseSync(migrationPath)
  runMigrations(db, oldVersion)
  insertLegacyRow(db, 'v28-row-1')
  const before = db.prepare('SELECT payload_json, canonical_json, status FROM scene_working_sets WHERE working_set_id=?').get('v28-row-1') as { payload_json?: string; canonical_json?: string | null; status?: string } | undefined
  const beforeVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version)
  runMigrations(db, CURRENT_SCHEMA_VERSION)
  const after = db.prepare('SELECT payload_json, canonical_json, status FROM scene_working_sets WHERE working_set_id=?').get('v28-row-1') as { payload_json?: string; canonical_json?: string | null; status?: string } | undefined
  check('v29 populated v28 row preserves bytes/status/nullability', beforeVersion === oldVersion && after?.payload_json === before?.payload_json && after?.canonical_json === before?.canonical_json && after?.status === before?.status)
  insertLegacyRow(db, 'v29-row-2', stableSceneMemoryJson({ source: 'v29', canonical: null }))
  check('v29 allows a second same-scope/query row by distinct working_set_id', Number((db.prepare('SELECT COUNT(*) AS count FROM scene_working_sets WHERE scene_id=? AND query_hash=?').get('v28-migration-scene', sha('v28-query')) as { count?: number }).count ?? 0) === 2)
  closeDb(db)

  const migratedRepo = createRepository(migrationPath)
  migratedRepo.open()
  let sameIdConflict = false
  const changedPayload = { changed: true }
  try {
    migratedRepo.saveSceneWorkingSet({ workingSetId: 'v28-row-1', storyId, projectId, branchId, validityEpoch: 1, storyRevision: 1, sceneId: 'v28-migration-scene', queryHash: sha('v28-query'), cardIds: [], omitted: [], payload: changedPayload, workingSetHash: sha({ storyId, projectId, branchId, validityEpoch: 1, storyRevision: 1, sceneId: 'v28-migration-scene', queryHash: sha('v28-query'), cardIds: [], omitted: [], payload: changedPayload }), status: 'stale' })
  } catch { sameIdConflict = true }
  check('v29 same working_set_id with different authority conflicts', sameIdConflict)
  migratedRepo.close()

  const failurePath = path.join(root, 'v29-injected-failure.sqlite')
  const failureDb = new DatabaseSync(failurePath)
  runMigrations(failureDb, oldVersion)
  insertLegacyRow(failureDb, 'v28-failure-row')
  const failureBeforeColumns = (failureDb.prepare('PRAGMA table_info(scene_working_sets)').all() as Array<{ name?: string }>).map((row) => row.name).join(',')
  let injected = false
  process.env.DW_R72_INJECT_V29_FAILURE = '1'
  try { runMigrations(failureDb, CURRENT_SCHEMA_VERSION) } catch { injected = true }
  delete process.env.DW_R72_INJECT_V29_FAILURE
  const failureAfterColumns = (failureDb.prepare('PRAGMA table_info(scene_working_sets)').all() as Array<{ name?: string }>).map((row) => row.name).join(',')
  const failureVersion = Number((failureDb.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version)
  const failureRows = Number((failureDb.prepare('SELECT COUNT(*) AS count FROM scene_working_sets').get() as { count?: number }).count ?? 0)
  check('injected v29 migration failure rolls back table and user_version', injected && failureVersion === oldVersion && failureAfterColumns === failureBeforeColumns && failureRows === 1)
  closeDb(failureDb)
}

const repo: Repository = createRepository(dbPath)
repo.open()
repo.createRun(makeRun())
repo.close()
const seedHash = seedHead()
const { snapshot, query } = makeSnapshot()
const recall = buildDeterministicRecallIndex({ corpus: snapshot.corpus, query })
const compilerInput: SceneContextCompilerInput = {
  snapshot,
  recall,
  recallQuery: query,
  contract: makeContract(),
  hardConstraints: '仅用于持久化测试。',
  budgetTokens: 3072
}
const compiled = compileSceneWorkingSet(compilerInput)
repo.open()

try {
  check('schema has WP4 canonical columns', (() => {
    const db = openDb(dbPath)
    const columns = (db.prepare('PRAGMA table_info(scene_working_sets)').all() as Array<{ name?: string }>).map((row) => row.name)
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    closeDb(db)
    return version === CURRENT_SCHEMA_VERSION && ['schema_version', 'run_id', 'branch_lineage_json', 'branch_cutoffs_json', 'canonical_json', 'canonical_hash', 'final_envelope_hash'].every((name) => columns.includes(name))
  })())
  migrationV29Evidence()
  repo.close()
  const head = seedHash
  repo.open()
  repo.saveSceneWorkingSet({ workingSet: compiled.workingSet, manifest: compiled.manifest, workingSetMessage: compiled.workingSetMessage, branchLineage: [branchId], branchCutoffs: { [branchId]: headRevision }, finalEnvelopeHash: null, storageStatus: 'active', createdAt: 10 })
  const first = repo.getSceneWorkingSet(compiled.workingSet.workingSetId)
  check('full record round-trips all authority fields', Boolean(first?.runId === runId && first.branchLineage?.join() === branchId && first.sourceSnapshotHash === emptySourceSnapshotHash && first.sourceCardSetHash === emptySourceCardSetHash && first.queryHash === compiled.workingSet.queryHash && first.indexHash === compiled.workingSet.indexHash && first.manifest?.manifestHash === compiled.manifest.manifestHash && first.workingSetMessage?.messageHash === compiled.workingSetMessage.messageHash && first.finalEnvelopeHash === null))
  const firstBytes = first ? stableSceneMemoryJson(first.payload) : ''
  repo.close()
  repo.open()
  const afterRestart = repo.getSceneWorkingSet(compiled.workingSet.workingSetId)
  check('restart preserves canonical bytes and hashes', Boolean(afterRestart?.canonicalHash === first?.canonicalHash && stableSceneMemoryJson(afterRestart?.payload) === firstBytes && afterRestart?.workingSetHash === compiled.workingSet.workingSetHash))
   const finalMessages = [{ role: 'system' as const, content: 'final' }]
   repo.bindSceneWorkingSetFinalEnvelope({ workingSetId: compiled.workingSet.workingSetId, finalEnvelope: finalMessages })
   const bound = repo.assertSceneWorkingSetFresh(compiled.workingSet.workingSetId)
   check('final envelope binding uses provider wire hash', bound.workingSetHash === compiled.workingSet.workingSetHash && bound.finalEnvelopeHash === providerEnvelopeHash(finalMessages))
   let resaveAfterBind = true
   try { repo.saveSceneWorkingSet({ workingSet: compiled.workingSet, manifest: compiled.manifest, workingSetMessage: compiled.workingSetMessage, branchLineage: [branchId], branchCutoffs: { [branchId]: headRevision }, finalEnvelopeHash: null, storageStatus: 'active', createdAt: 10 }) } catch { resaveAfterBind = false }
   check('compiler record remains idempotent after final bind', resaveAfterBind && repo.getSceneWorkingSet(compiled.workingSet.workingSetId)?.finalEnvelopeHash === providerEnvelopeHash(finalMessages))
   check('freshness assertion accepts the durable record fence', repo.assertSceneWorkingSetFresh(compiled.workingSet.workingSetId, { workingSetHash: bound.workingSetHash, canonicalHash: bound.canonicalHash, finalEnvelopeHash: bound.finalEnvelopeHash }).canonicalHash === bound.canonicalHash)
   let freshnessHashRejected = false
   try { repo.assertSceneWorkingSetFresh(compiled.workingSet.workingSetId, { workingSetHash: sha('wrong-working-set') }) } catch { freshnessHashRejected = true }
   check('freshness assertion rejects a different record hash', freshnessHashRejected)
   let hashOnlyRejected = false
   try { repo.bindSceneWorkingSetFinalEnvelope({ workingSetId: compiled.workingSet.workingSetId, finalEnvelopeHash: providerEnvelopeHash(finalMessages) } as unknown as Parameters<Repository['bindSceneWorkingSetFinalEnvelope']>[0]) } catch { hashOnlyRejected = true }
   check('hash-only final envelope binding fails closed', hashOnlyRejected)
   let callerHashTamperRejected = false
   try { repo.bindSceneWorkingSetFinalEnvelope({ workingSetId: compiled.workingSet.workingSetId, finalEnvelope: finalMessages, finalEnvelopeHash: sha('caller-lied') }) } catch { callerHashTamperRejected = true }
   check('caller hash mismatch is rejected against actual messages', callerHashTamperRejected)
   let providerMetadataRejected = false
   try { repo.bindSceneWorkingSetFinalEnvelope({ workingSetId: compiled.workingSet.workingSetId, finalEnvelope: [{ role: 'tool', content: 'final', tool_call_id: 'unhashed-metadata' }] }) } catch { providerMetadataRejected = true }
   check('unhashed provider metadata is rejected at the binding boundary', providerMetadataRejected)
   repo.close()

  const staleDb = openDb(dbPath)
  staleDb.prepare("UPDATE scene_working_sets SET status='stale' WHERE working_set_id=?").run(compiled.workingSet.workingSetId)
  closeDb(staleDb)
  repo.open()
  check('stale working set is hidden by default', repo.getSceneWorkingSet(compiled.workingSet.workingSetId) === null)
  repo.close()

  const headDb = openDb(dbPath)
  headDb.prepare("UPDATE scene_working_sets SET status='active' WHERE working_set_id=?").run(compiled.workingSet.workingSetId)
  headDb.prepare('UPDATE story_ledger_heads SET high_watermark=2 WHERE story_id=? AND project_id=? AND branch_id=?').run(storyId, projectId, branchId)
  closeDb(headDb)
  repo.open()
  let headRejected = false
  try { repo.assertSceneWorkingSetFresh(compiled.workingSet.workingSetId) } catch { headRejected = true }
  check('changed story head fails closed before provider', headRejected)
  repo.close()
  const restoreHeadDb = openDb(dbPath)
  restoreHeadDb.prepare('UPDATE story_ledger_heads SET high_watermark=1,head_hash=? WHERE story_id=? AND project_id=? AND branch_id=?').run(seedHash, storyId, projectId, branchId)
  closeDb(restoreHeadDb)

  const tamperDb = openDb(dbPath)
  tamperDb.prepare('UPDATE scene_working_sets SET canonical_json=? WHERE working_set_id=?').run('{}', compiled.workingSet.workingSetId)
  closeDb(tamperDb)
  repo.open()
  let tamperRejected = false
  try { repo.getSceneWorkingSet(compiled.workingSet.workingSetId) } catch { tamperRejected = true }
  check('canonical payload tampering fails closed', tamperRejected)
  repo.close()

  const legacyDb = openDb(dbPath)
  const legacyPayload = { legacy: true }
  const legacyHash = sha({ storyId, projectId, branchId, validityEpoch: 1, storyRevision: 1, sceneId: 'legacy-scene', queryHash: sha('legacy-query'), cardIds: [], omitted: [], payload: legacyPayload })
  legacyDb.prepare(`INSERT INTO scene_working_sets (working_set_id,story_id,project_id,branch_id,validity_epoch,story_revision,scene_id,query_hash,card_ids_json,omitted_json,payload_json,working_set_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-r72', storyId, projectId, branchId, 1, 1, 'legacy-scene', sha('legacy-query'), '[]', '[]', stableSceneMemoryJson(legacyPayload), legacyHash, 'stale', 1, 1)
  closeDb(legacyDb)
  repo.open()
  check('old v27 row remains explicitly legacy/audit-only', repo.getSceneWorkingSet('legacy-r72', true)?.legacy === true && repo.getSceneWorkingSet('legacy-r72') === null)
  repo.close()

  // Genesis is represented by a scope/epoch-bound sentinel in the durable
  // WorkingSet while story_ledger_heads.head_hash remains SQL NULL.  Keep a
  // separate empty DB so this path cannot accidentally inherit revision-1
  // state from the restart/tamper checks above.
  const genesisDbPath = path.join(root, 'genesis.sqlite')
  const genesisRunId = 'r72-persistence-genesis-run'
  const genesisSessionId = 'r72-persistence-genesis-session'
  const genesisStoryId = 'r72-persistence-genesis-story'
  const genesisProjectId = 'r72-persistence-genesis-project'
  const genesisSceneId = 'r72-persistence-genesis-scene'
  const genesisScope = { schemaVersion: 1 as const, storyId: genesisStoryId, projectId: genesisProjectId, branchId }
  const genesisHeadHash = storyLedgerGenesisHeadHash(genesisScope, 1)
  const genesisRepo = createRepository(genesisDbPath)
  genesisRepo.open()
  genesisRepo.createRun({
    run_id: genesisRunId,
    session_id: genesisSessionId,
    status: 'completed',
    phase: 'writing',
    started_at: 1,
    updated_at: 1,
    config_json: JSON.stringify({ storyScope: genesisScope }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  })
  const genesisScopeFence = { storyId: genesisStoryId, projectId: genesisProjectId, branchId, branchLineage: [branchId], validityEpoch: 1, storyRevision: 0, sceneId: genesisSceneId, headRevision: 0, headHash: genesisHeadHash, expectedSourceCardSetHash: emptySourceCardSetHash }
  const genesisSnapshot: SceneRecallCorpusSnapshot = { schemaVersion: 1, runId: genesisRunId, sceneId: genesisSceneId, scope: genesisScopeFence, sourceSnapshotHash: emptySourceSnapshotHash, sourceCardSetHash: emptySourceCardSetHash, corpus: [] }
  const genesisQuery: SceneRecallQuery = { scope: genesisScopeFence, tokenizerVersion: SCENE_RECALL_TOKENIZER_VERSION, bm25Version: SCENE_RECALL_BM25_VERSION, topK: 20 }
  const genesisRecall = buildDeterministicRecallIndex({ corpus: [], query: genesisQuery })
  const genesisContractBase = { ...makeContract(), contractId: 'r72-genesis-contract', sceneId: genesisSceneId }
  const { frozenHash: _genesisFrozenHash, ...genesisContractWithoutHash } = genesisContractBase
  const genesisContract = { ...genesisContractBase, frozenHash: sha(JSON.stringify(genesisContractWithoutHash)) }
  const genesisCompiled = compileSceneWorkingSet({ snapshot: genesisSnapshot, recall: genesisRecall, recallQuery: genesisQuery, contract: genesisContract, hardConstraints: '仅用于 genesis 持久化测试。', budgetTokens: 3072 })
  genesisRepo.saveSceneWorkingSet({ workingSet: genesisCompiled.workingSet, manifest: genesisCompiled.manifest, workingSetMessage: genesisCompiled.workingSetMessage, branchLineage: [branchId], branchCutoffs: {}, storageStatus: 'active', createdAt: 10 })
  const genesisPersisted = genesisRepo.getSceneWorkingSet(genesisCompiled.workingSet.workingSetId)
  check('revision-zero empty corpus persists with genesis sentinel', Boolean(genesisPersisted?.storyRevision === 0 && genesisPersisted.headRevision === 0 && genesisPersisted.headHash === genesisHeadHash && genesisPersisted.sourceCardSetHash === emptySourceCardSetHash && genesisPersisted.cardIds.length === 0))
  const genesisDb = openDb(genesisDbPath)
  const genesisHeadRow = genesisDb.prepare('SELECT high_watermark, head_hash FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(genesisStoryId, genesisProjectId, branchId) as { high_watermark?: number; head_hash?: string | null }
  closeDb(genesisDb)
  check('genesis sentinel maps only to SQL NULL head', genesisHeadRow.high_watermark === 0 && genesisHeadRow.head_hash === null)
  let badGenesisRejected = false
  try {
    genesisRepo.getSceneRecallCorpusSnapshot({ runId: genesisRunId, sceneId: genesisSceneId, expectedFence: { ...genesisScopeFence, headHash: sha('arbitrary-revision-zero-hash') } })
  } catch { badGenesisRejected = true }
  check('arbitrary revision-zero head hash fails closed', badGenesisRejected)
  genesisRepo.close()
  const genesisRestart = createRepository(genesisDbPath)
  genesisRestart.open()
  const genesisAfterRestart = genesisRestart.getSceneWorkingSet(genesisCompiled.workingSet.workingSetId)
  check('revision-zero sentinel survives restart byte-for-byte', Boolean(genesisAfterRestart?.canonicalHash === genesisPersisted?.canonicalHash && stableSceneMemoryJson(genesisAfterRestart?.payload) === stableSceneMemoryJson(genesisPersisted?.payload)))
  genesisRestart.close()

} catch (error) {
  failed += 1
  console.error('R72 persistence execution error:', error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  try { repo.close() } catch { /* best effort */ }
}

console.log(`R72 scene-working-set persistence: ${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exitCode = 1
