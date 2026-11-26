import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createRepository, type Repository, type RunRow } from '../src/main/db/repository'
import { CURRENT_SCHEMA_VERSION, openDb, runMigrations } from '../src/main/db/migrations'
import { buildNarrativeStateDelta } from '../src/main/narrative/stateDelta'
import { storyLedgerRevisionHashV2, storyLedgerTombstoneHashV2 } from '../src/main/narrative/storyLedger'
import type { NarrativeLedgerScopeInput, NarrativeObjectStateChange } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const scope: NarrativeLedgerScopeInput = { schemaVersion: 1, storyId: 'p2-integrity-story', projectId: 'p2-integrity-project', branchId: 'main' }

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function runRow(runId: string): RunRow {
  const now = Date.now()
  return {
    run_id: runId,
    session_id: `session-${runId}`,
    status: 'completed',
    phase: 'completed',
    started_at: now,
    updated_at: now,
    config_json: JSON.stringify({ storyScope: scope }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  }
}

function appendRevision(db: DatabaseSync, runId: string, sequence: number): string {
  const acceptedContentHash = hash(`accepted-content-${runId}`)
  const contractHash = hash(`contract-${runId}`)
  const change: NarrativeObjectStateChange = {
    changeId: `change-${runId}`,
    revision: 1,
    kind: 'object_state',
    entityId: `object-${sequence}`,
    runId,
    sceneId: `scene-${runId}`,
    acceptedSegmentId: `segment-${runId}`,
    acceptedContentHash,
    contractHash,
    objectId: `object-${sequence}`,
    ownerId: null,
    holderId: `holder-${sequence}`,
    holderStatus: 'known',
    locationId: 'location-main',
    condition: 'intact'
  }
  const delta = buildNarrativeStateDelta({
    schemaVersion: 1,
    runId,
    sceneId: `scene-${runId}`,
    acceptedSegmentId: `segment-${runId}`,
    acceptedContentHash,
    contractHash,
    changes: [change]
  })
  const head = db.prepare('SELECT high_watermark, head_hash FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as { high_watermark: number; head_hash: string | null }
  const revision = head.high_watermark + 1
  const revisionHash = storyLedgerRevisionHashV2({
    storyId: scope.storyId,
    projectId: scope.projectId,
    branchId: scope.branchId,
    revision,
    parentRevision: head.high_watermark,
    parentHash: head.head_hash,
    runId,
    sceneId: `scene-${runId}`,
    deltaHash: delta.deltaHash,
    manifestHash: null,
    nodeType: 'revision',
    hashSchemaVersion: 2
  })
  db.prepare(`INSERT INTO story_ledger_revisions (
    story_id, project_id, branch_id, revision, parent_story_id, parent_project_id, parent_branch_id,
    parent_revision, run_id, scene_id, accepted_segment_id, accepted_content_hash, contract_hash,
    delta_hash, delta_json, manifest_json, manifest_hash, parent_hash, node_type, hash_schema_version,
    revision_hash, committed_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    scope.storyId, scope.projectId, scope.branchId, revision, null, null, null,
    head.high_watermark, runId, `scene-${runId}`, `segment-${runId}`, acceptedContentHash, contractHash,
    delta.deltaHash, JSON.stringify(delta), null, null, head.head_hash, 'revision', 2, revisionHash, Date.now()
  )
  db.prepare('UPDATE story_ledger_heads SET high_watermark=?, head_hash=?, updated_at=? WHERE story_id=? AND project_id=? AND branch_id=?').run(
    revision, revisionHash, Date.now(), scope.storyId, scope.projectId, scope.branchId
  )
  db.prepare('UPDATE story_ledger_runs SET current_revision=?, updated_at=? WHERE run_id=?').run(revision, Date.now(), runId)
  return revisionHash
}

function seedThree(dbPath: string): { repository: Repository; hashes: string[] } {
  const repository = createRepository(dbPath)
  repository.open()
  for (const runId of ['p2-run-1', 'p2-run-2', 'p2-run-3']) repository.createRun(runRow(runId))
  const db = new DatabaseSync(dbPath)
  try {
    const hashes = [appendRevision(db, 'p2-run-1', 1), appendRevision(db, 'p2-run-2', 2), appendRevision(db, 'p2-run-3', 3)]
    return { repository, hashes }
  } finally {
    db.close()
  }
}

async function expectReadFailure(mutator: (db: DatabaseSync) => void, expected: string): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p2-ledger-corrupt-'))
  const dbPath = path.join(root, 'story.db')
  let repository: Repository | null = null
  try {
    const seeded = seedThree(dbPath)
    repository = seeded.repository
    repository.close()
    const db = new DatabaseSync(dbPath)
    try { mutator(db) } finally { db.close() }
    repository = createRepository(dbPath)
    repository.open()
    let error = ''
    try { repository.getNarrativeLedger('p2-run-3') } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
    check(`损坏链读取 fail-closed：${expected}`, error.length > 0, error)
  } finally {
    repository?.close()
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function migrationFixture(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p2-ledger-migration-'))
  const dbPath = path.join(root, 'v23.db')
  let db: DatabaseSync | null = null
  let repository: Repository | null = null
  const migrationScope: NarrativeLedgerScopeInput = { schemaVersion: 1, storyId: 'migration-story', projectId: 'migration-project', branchId: 'main' }
  const runId = 'migration-run'
  const runAt = Date.now()
  const contentHash = hash('migration-content')
  const contractHash = hash('migration-contract')
  try {
    db = new DatabaseSync(dbPath)
    runMigrations(db, 22)
    db.prepare(`INSERT INTO runs (run_id,session_id,status,phase,started_at,updated_at,config_json,parent_run_id,error_code,error_message)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(runId, 'migration-session', 'completed', 'completed', runAt, runAt, JSON.stringify({ storyScope: migrationScope }), null, null, null)
    db.prepare(`INSERT INTO scene_states (
      run_id,scene_id,section_id,contract_id,contract_hash,scene_order,lifecycle,revision,candidate_segment_id,candidate_hash,
      accepted_segment_id,accepted_hash,completion_decision_json,completion_evidence_hash,created_at,updated_at,completed_at,committed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      runId, 'migration-scene', 'migration-section', 'migration-contract', contractHash, 1, 'committed', 1, null, null,
      'migration-segment', contentHash, null, null, runAt, runAt, runAt, runAt
    )
    const change: NarrativeObjectStateChange = {
      changeId: 'migration-change', revision: 1, kind: 'object_state', entityId: 'migration-object', runId,
      sceneId: 'migration-scene', acceptedSegmentId: 'migration-segment', acceptedContentHash: contentHash, contractHash,
      objectId: 'migration-object', ownerId: null, holderId: 'migration-holder', holderStatus: 'known', locationId: 'migration-location', condition: 'intact'
    }
    const delta = buildNarrativeStateDelta({ schemaVersion: 1, runId, sceneId: 'migration-scene', acceptedSegmentId: 'migration-segment', acceptedContentHash: contentHash, contractHash, changes: [change] })
    db.prepare(`INSERT INTO narrative_commits (
      run_id,scene_id,accepted_segment_id,accepted_content_hash,contract_hash,delta_hash,delta_json,revision,committed_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`).run(runId, 'migration-scene', 'migration-segment', contentHash, contractHash, delta.deltaHash, JSON.stringify(delta), 1, runAt)
    runMigrations(db, 24)
    const beforeColumns = db.prepare('PRAGMA table_info(story_ledger_revisions)').all() as Array<{ name?: string }>
    check('真实 v23→v24 中间快照仍是旧 hash schema', !beforeColumns.some((row) => row.name === 'parent_hash'))
    db.close()
    db = null
    const upgraded = openDb(dbPath)
    const version = (upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    const revision = upgraded.prepare('SELECT revision,parent_hash,node_type,hash_schema_version,revision_hash FROM story_ledger_revisions').get() as { revision: number; parent_hash: string | null; node_type: string; hash_schema_version: number; revision_hash: string }
    const head = upgraded.prepare('SELECT high_watermark,head_hash,hash_schema_version FROM story_ledger_heads').get() as { high_watermark: number; head_hash: string; hash_schema_version: number }
    const meta = upgraded.prepare("SELECT value FROM meta WHERE key='story_ledger_hash_migration'").get() as { value?: string } | undefined
    check('v23→v24→v25 迁移推进到当前 schema', version === CURRENT_SCHEMA_VERSION)
    check('迁移后节点具有 v2 parent/node/version 元数据', revision.revision === 1 && revision.parent_hash === null && revision.node_type === 'revision' && revision.hash_schema_version === 2 && head.hash_schema_version === 2 && head.head_hash === revision.revision_hash)
    check('迁移策略以 durable meta 明确记录，未静默混用', Boolean(meta?.value && JSON.parse(meta.value).fromHashSchemaVersion === 1 && JSON.parse(meta.value).toHashSchemaVersion === 2 && JSON.parse(meta.value).legacyRowsAreNotMixedWithV2 === true))
    upgraded.close()
    repository = createRepository(dbPath)
    repository.open()
    check('迁移后历史 ledger 可通过 Repository 读回', repository.getNarrativeLedger(runId).length === 1)
  } finally {
    try { db?.close() } catch { /* already closed */ }
    repository?.close()
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function main(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p2-ledger-main-'))
  const dbPath = path.join(root, 'story.db')
  let repository: Repository | null = null
  try {
    const seeded = seedThree(dbPath)
    repository = seeded.repository
    const initial = repository.getNarrativeLedger('p2-run-3')
    check('严格链正常读取三条连续 revision', initial.length === 3 && initial.map((entry) => entry.storyRevision).join(',') === '1,2,3')
    const db = new DatabaseSync(dbPath)
    try {
      const rows = db.prepare('SELECT revision,parent_revision,parent_hash,node_type,hash_schema_version,revision_hash FROM story_ledger_revisions ORDER BY revision').all() as Array<{ revision: number; parent_revision: number; parent_hash: string | null; node_type: string; hash_schema_version: number; revision_hash: string }>
      const head = db.prepare('SELECT high_watermark,head_hash FROM story_ledger_heads').get() as { high_watermark: number; head_hash: string }
      check('每节点承诺前驱 hash，head 与最后节点一致', rows.length === 3 && rows[0]?.parent_hash === null && rows.every((row, index) => row.hash_schema_version === 2 && row.node_type === 'revision' && row.parent_revision === index && (index === 0 ? row.parent_hash === null : row.parent_hash === rows[index - 1]?.revision_hash)) && head.high_watermark === 3 && head.head_hash === rows[2]?.revision_hash)
    } finally { db.close() }
    repository.close()
    repository = null

    const retractionPath = path.join(root, 'retraction.db')
    const seededRetraction = seedThree(retractionPath)
    repository = seededRetraction.repository
    const retracted = repository.deleteRun('p2-run-2', 'retract')
    const activeAfter = repository.getNarrativeLedger('p2-run-3')
    check('撤回中间 revision 后代标 stale 且不进入权威 context', retracted.retractedRevisions === 1 && activeAfter.length === 1 && activeAfter[0]?.storyRevision === 1)
    const auditDb = new DatabaseSync(retractionPath)
    try {
      const tombstone = auditDb.prepare('SELECT target_revision,parent_revision,parent_hash,node_type,hash_schema_version FROM story_ledger_tombstones').get() as { target_revision: number; parent_revision: number; parent_hash: string; node_type: string; hash_schema_version: number }
      check('撤回以 parent-bound tombstone 追加且保留 append-only 历史', tombstone.target_revision === 2 && tombstone.parent_revision === 3 && typeof tombstone.parent_hash === 'string' && tombstone.node_type === 'retraction' && tombstone.hash_schema_version === 2)
    } finally { auditDb.close() }
    repository.close()
    repository = null

    await expectReadFailure((db) => { db.prepare('DELETE FROM story_ledger_revisions WHERE revision=1').run() }, '缺 revision')
    await expectReadFailure((db) => { db.prepare("UPDATE story_ledger_revisions SET parent_hash='0' WHERE revision=3").run() }, '错 parent hash')
    await expectReadFailure((db) => { db.prepare("UPDATE story_ledger_heads SET head_hash='0'").run() }, '错 head hash')
    await expectReadFailure((db) => { db.prepare('UPDATE story_ledger_revisions SET hash_schema_version=1 WHERE revision=3').run() }, '拒绝 v1/v2 混用')
    await expectReadFailure((db) => {
      const row1 = db.prepare('SELECT revision_hash FROM story_ledger_revisions WHERE revision=1').get() as { revision_hash: string }
      const tombHash = storyLedgerTombstoneHashV2({ storyId: scope.storyId, projectId: scope.projectId, branchId: scope.branchId, revision: 2, parentRevision: 1, parentHash: row1.revision_hash, targetRevision: 1, targetRevisionHash: row1.revision_hash, targetRunId: 'p2-run-1', targetSceneId: 'scene-p2-run-1', reason: 'dual-node', nodeType: 'retraction', hashSchemaVersion: 2 })
      db.prepare(`INSERT INTO story_ledger_tombstones (
        story_id,project_id,branch_id,revision,parent_revision,target_revision,target_revision_hash,target_run_id,target_scene_id,reason,parent_hash,node_type,hash_schema_version,tombstone_hash,committed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(scope.storyId, scope.projectId, scope.branchId, 2, 1, 1, row1.revision_hash, 'p2-run-1', 'scene-p2-run-1', 'dual-node', row1.revision_hash, 'retraction', 2, tombHash, Date.now())
    }, '双节点')
    await migrationFixture()
  } finally {
    repository?.close()
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nP2 story ledger integrity: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('P2 story ledger integrity 执行异常：', error)
  process.exitCode = 2
})
