import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createRepository, type Repository, type RunRow } from '../src/main/db/repository'
import { CURRENT_SCHEMA_VERSION, openDb, runMigrations } from '../src/main/db/migrations'
import { buildNarrativeStateDelta } from '../src/main/narrative/stateDelta'
import { storyLedgerRevisionHashV2 } from '../src/main/narrative/storyLedger'
import type { NarrativeLedgerScopeInput, NarrativeObjectStateChange } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, value: boolean): void {
  if (value) { passed += 1; console.log(`  PASS  ${name}`) }
  else { failed += 1; console.error(`  FAIL  ${name}`) }
}

const scope: NarrativeLedgerScopeInput = { schemaVersion: 1, storyId: 'epoch-story', projectId: 'epoch-project', branchId: 'main' }

async function migrationChecks(): Promise<void> {
  // These fixtures must execute v26 itself, including its failure/rollback.
  const oldVersion = 25
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-p1-3-story-ledger-migration-'))
  const upgradePath = path.join(root, 'upgrade.db')
  const storyOnlyPath = path.join(root, 'story-only.db')
  const emptyPath = path.join(root, 'empty.db')
  const failedUpgradePath = path.join(root, 'failed-upgrade.db')
  const failurePath = path.join(root, 'failure.db')
  try {
    const legacy = new DatabaseSync(upgradePath)
    runMigrations(legacy, oldVersion)
    const now = Date.now()
    legacy.prepare(`INSERT INTO runs (run_id,session_id,status,phase,started_at,updated_at,config_json,parent_run_id,error_code,error_message)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run('migration-run', 'migration-session', 'completed', 'completed', now, now, '{}', null, null, null)
    legacy.close()
    const upgraded = openDb(upgradePath)
    try {
      const version = Number((upgraded.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0)
      const headColumns = (upgraded.prepare('PRAGMA table_info(story_ledger_heads)').all() as Array<{ name?: string }>).map((row) => row.name)
      const runColumns = (upgraded.prepare('PRAGMA table_info(story_ledger_runs)').all() as Array<{ name?: string }>).map((row) => row.name)
      const revisionColumns = (upgraded.prepare('PRAGMA table_info(story_ledger_revisions)').all() as Array<{ name?: string }>).map((row) => row.name)
      const tombstoneColumns = (upgraded.prepare('PRAGMA table_info(story_ledger_tombstones)').all() as Array<{ name?: string }>).map((row) => row.name)
      const legacyRunStillPresent = Boolean(upgraded.prepare('SELECT run_id FROM runs WHERE run_id=?').get('migration-run'))
      const backup = await fs.stat(`${upgradePath}.pre-v${oldVersion}.bak`)
      check('v26 迁移只增列并保留旧数据/备份', version === CURRENT_SCHEMA_VERSION && legacyRunStillPresent && headColumns.includes('validity_epoch') && headColumns.includes('parent_validity_epoch') && runColumns.includes('validity_epoch') && runColumns.includes('parent_validity_epoch') && revisionColumns.includes('validity_epoch') && revisionColumns.includes('rebase_parent_hash') && tombstoneColumns.includes('validity_epoch') && tombstoneColumns.includes('next_validity_epoch') && backup.isFile() && backup.size > 0)
    } finally { upgraded.close() }
    const backupPath = `${upgradePath}.pre-v${oldVersion}.bak`
    const backupBeforeReopen = await fs.stat(backupPath)
    const reopened = openDb(upgradePath)
    try {
      const backupAfterReopen = await fs.stat(backupPath)
      check('v26 重启迁移幂等且版本稳定', Number((reopened.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0) === CURRENT_SCHEMA_VERSION && backupAfterReopen.size === backupBeforeReopen.size && backupAfterReopen.mtimeMs === backupBeforeReopen.mtimeMs)
    } finally { reopened.close() }

    // A v25 database containing only the ledger is still changed by v26. The
    // old runs/turns-only heuristic missed this exact production shape.
    const storyOnly = new DatabaseSync(storyOnlyPath)
    runMigrations(storyOnly, oldVersion)
    storyOnly.prepare(`INSERT INTO story_ledger_heads (
      story_id,project_id,branch_id,parent_story_id,parent_project_id,parent_branch_id,parent_revision,high_watermark,head_hash,hash_schema_version,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('story-only', 'story-only-project', 'main', null, null, null, 0, 0, null, 2, Date.now())
    storyOnly.close()
    const storyOnlyBackupPath = `${storyOnlyPath}.pre-v${oldVersion}.bak`
    const storyOnlyUpgraded = openDb(storyOnlyPath)
    try {
      const storyOnlyBackup = await fs.stat(storyOnlyBackupPath)
      const backupDb = new DatabaseSync(storyOnlyBackupPath)
      try {
        const backupVersion = Number((backupDb.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0)
        const backupHead = backupDb.prepare('SELECT story_id FROM story_ledger_heads WHERE story_id=?').get('story-only')
        check('仅 story_ledger 数据的 v25 库迁移前也生成可打开备份', storyOnlyBackup.isFile() && storyOnlyBackup.size > 0 && backupVersion === oldVersion && Boolean(backupHead))
      } finally { backupDb.close() }
    } finally { storyOnlyUpgraded.close() }

    const empty = new DatabaseSync(emptyPath)
    runMigrations(empty, oldVersion)
    empty.close()
    const emptyUpgraded = openDb(emptyPath)
    emptyUpgraded.close()
    check('无业务数据的旧 schema 不产生伪备份', !(await fs.stat(`${emptyPath}.pre-v${oldVersion}.bak`).catch(() => null)))

    // A malformed v25 ledger must fail before committing v26. The backup is
    // retained and remains independently openable after the failed upgrade.
    const failedUpgrade = new DatabaseSync(failedUpgradePath)
    runMigrations(failedUpgrade, oldVersion)
    failedUpgrade.prepare(`INSERT INTO story_ledger_heads (
      story_id,project_id,branch_id,parent_story_id,parent_project_id,parent_branch_id,parent_revision,high_watermark,head_hash,hash_schema_version,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('failed-story', 'failed-project', 'main', null, null, null, 0, 1, 'broken-head', 2, Date.now())
    failedUpgrade.close()
    let openFailed = false
    try { openDb(failedUpgradePath) } catch { openFailed = true }
    const failedBackupPath = `${failedUpgradePath}.pre-v${oldVersion}.bak`
    const failedBackup = new DatabaseSync(failedBackupPath)
    try {
      const failedVersion = Number((failedBackup.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0)
      check('v26 迁移失败保留可打开 pre-v26 备份', openFailed && failedVersion === oldVersion && Boolean(failedBackup.prepare('SELECT story_id FROM story_ledger_heads WHERE story_id=?').get('failed-story')))
    } finally { failedBackup.close() }

    const broken = new DatabaseSync(failurePath)
    runMigrations(broken, oldVersion)
    broken.prepare(`INSERT INTO story_ledger_heads (
      story_id,project_id,branch_id,parent_story_id,parent_project_id,parent_branch_id,parent_revision,high_watermark,head_hash,hash_schema_version,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('broken-story', 'broken-project', 'main', null, null, null, 0, 1, 'broken-head', 2, Date.now())
    let migrationFailed = false
    try { runMigrations(broken, CURRENT_SCHEMA_VERSION) } catch { migrationFailed = true }
    const versionAfterFailure = Number((broken.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0)
    const columnsAfterFailure = (broken.prepare('PRAGMA table_info(story_ledger_heads)').all() as Array<{ name?: string }>).map((row) => row.name)
    check('v26 中断时事务回滚、版本与旧 schema 保持', migrationFailed && versionAfterFailure === oldVersion && !columnsAfterFailure.includes('validity_epoch'))
    broken.close()
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

function runRow(runId: string, status: RunRow['status'], storyScope: NarrativeLedgerScopeInput): RunRow {
  const at = Date.now()
  return {
    run_id: runId,
    session_id: 'epoch-session',
    status,
    phase: status === 'running' ? 'thinking' : status,
    started_at: at,
    updated_at: at,
    config_json: JSON.stringify({ storyScope }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  }
}

function appendRevision(dbPath: string, runId: string, revision: number, scope: NarrativeLedgerScopeInput, nodeType: 'revision' | 'rebase' = 'revision'): void {
  const db = new DatabaseSync(dbPath)
  try {
    const text = `${runId}:${revision}`
    const contentHash = createHash('sha256').update(text, 'utf8').digest('hex')
    const contractHash = createHash('sha256').update(`contract:${runId}`, 'utf8').digest('hex')
    const change: NarrativeObjectStateChange = {
      changeId: `change-${runId}-${revision}`,
      revision: 1,
      kind: 'object_state',
      entityId: 'key',
      runId,
      sceneId: `scene-${runId}`,
      acceptedSegmentId: `segment-${runId}`,
      acceptedContentHash: contentHash,
      contractHash,
      objectId: 'key',
      ownerId: null,
      holderId: text,
      holderStatus: 'known',
      locationId: 'tower',
      condition: 'held'
    }
    const delta = buildNarrativeStateDelta({ schemaVersion: 1, runId, sceneId: `scene-${runId}`, acceptedSegmentId: `segment-${runId}`, acceptedContentHash: contentHash, contractHash, changes: [change] })
    const head = db.prepare('SELECT head_hash, validity_epoch FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as { head_hash?: string | null; validity_epoch?: number } | undefined
    const parentHash = head?.head_hash ?? null
    const epoch = Number(head?.validity_epoch ?? 1)
    const revisionHash = storyLedgerRevisionHashV2({ storyId: scope.storyId, projectId: scope.projectId, branchId: scope.branchId, revision, parentRevision: revision - 1, parentHash, runId, sceneId: `scene-${runId}`, deltaHash: delta.deltaHash, manifestHash: null, nodeType, hashSchemaVersion: 2 })
    db.prepare(`INSERT INTO story_ledger_revisions (
      story_id, project_id, branch_id, revision, parent_story_id, parent_project_id, parent_branch_id,
      parent_revision, run_id, scene_id, accepted_segment_id, accepted_content_hash, contract_hash,
      delta_hash, delta_json, manifest_json, manifest_hash, revision_hash, committed_at,
      parent_hash, node_type, hash_schema_version, validity_epoch, rebase_parent_revision, rebase_parent_hash
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      scope.storyId, scope.projectId, scope.branchId, revision, null, null, null, revision - 1,
      runId, `scene-${runId}`, `segment-${runId}`, contentHash, contractHash, delta.deltaHash, JSON.stringify(delta), null, null,
      revisionHash, Date.now(), parentHash, nodeType, 2, epoch,
      nodeType === 'rebase' ? revision - 1 : null, nodeType === 'rebase' ? parentHash : null
    )
    db.prepare('UPDATE story_ledger_heads SET high_watermark=?, head_hash=?, updated_at=? WHERE story_id=? AND project_id=? AND branch_id=?').run(revision, revisionHash, Date.now(), scope.storyId, scope.projectId, scope.branchId)
    db.prepare('UPDATE story_ledger_runs SET current_revision=?, validity_epoch=?, updated_at=? WHERE run_id=?').run(revision, epoch, Date.now(), runId)
  } finally { db.close() }
}

async function main(): Promise<void> {
  await migrationChecks()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-p1-3-story-ledger-epoch-'))
  const dbPath = path.join(root, 'story.db')
  let repository: Repository | null = null
  try {
    repository = createRepository(dbPath)
    repository.open()
    repository.createRun(runRow('r1', 'completed', scope))
    appendRevision(dbPath, 'r1', 1, scope)
    repository.createRun(runRow('r2', 'completed', { ...scope, parentRevision: 1 }))
    appendRevision(dbPath, 'r2', 2, scope)
    // Keep a descendant after the target so the test proves the complete
    // causal interval (target rev2 -> old descendant rev3 -> tombstone rev4)
    // is hidden, while the later safe rebase rev5 is visible again.
    repository.createRun(runRow('r3', 'completed', { ...scope, parentRevision: 2 }))
    appendRevision(dbPath, 'r3', 3, scope)
    repository.createRun(runRow('active-old', 'running', { ...scope, parentRevision: 3 }))
    repository.createRun(runRow('terminal-old', 'completed', { ...scope, parentRevision: 3 }))
    const before = repository.getNarrativeLedger('terminal-old')
    check('撤回前旧 epoch run 可见 r1/r2/r3', before.length === 3)
    const beforeFreshness = repository.getStoryLedgerFreshness('active-old')
    check('provider 前可捕获完整 cursor/head/epoch fence', Boolean(beforeFreshness?.fresh && beforeFreshness.runRevision === 3 && beforeFreshness.headRevision === 3 && beforeFreshness.validityEpoch === 1))

    repository.deleteRun('r2', 'retract')
    const active = repository.getRun('active-old')
    const activeScope = repository.getNarrativeLedgerScope('active-old')
    check('撤回不推进旧 run 游标并 durable invalidated', active?.status === 'recovery_required' && active?.error_code === 'story_ledger_epoch_invalidated' && activeScope?.currentRevision === 3 && activeScope?.epochValid === false)
    let blocked = false
    try { repository.getNarrativeLedger('active-old') } catch (error) { blocked = error instanceof Error && error.message === 'story_ledger_epoch_invalidated' }
    check('旧 epoch run 读取被阻断', blocked)
    const staleFreshness = repository.getStoryLedgerFreshness('active-old')
    let providerStaleRejected = false
    try {
      if (beforeFreshness) repository.assertStoryLedgerFresh({
        runId: beforeFreshness.runId,
        expectedRevision: beforeFreshness.runRevision,
        expectedEpoch: beforeFreshness.validityEpoch,
        expectedHeadRevision: beforeFreshness.headRevision,
        expectedHeadHash: beforeFreshness.headHash
      })
    } catch (error) { providerStaleRejected = error instanceof Error && error.message === 'story_ledger_epoch_invalidated' }
    check('provider 返回后旧 epoch fence fail-closed', Boolean(staleFreshness && !staleFreshness.fresh) && providerStaleRejected)
    const terminal = repository.getNarrativeLedger('terminal-old')
    check('撤回后旧 descendant rev3 隐藏且终态 run 解析 authoritative view', terminal.length === 1 && terminal[0]?.runId === 'r1')

    const rebase = repository.prepareStoryLedgerRebase('active-old')
    check('安全分支明确继承当前 tombstone head', rebase.storyScope.parentBranchId === 'main' && rebase.storyScope.parentRevision === 4 && rebase.sourceEpoch === 2)
    repository.createRun(runRow('r5', 'queued', rebase.storyScope))
    appendRevision(dbPath, 'r5', 5, { ...scope, branchId: rebase.storyScope.branchId }, 'rebase')
    const fresh = repository.getNarrativeLedger('r5')
    const freshScope = repository.getNarrativeLedgerScope('r5')
    const freshFence = repository.getStoryLedgerFreshness('r5')
    check('新安全分支 rev5 可见且 epoch 有效', fresh.length === 2 && fresh.some((entry) => entry.runId === 'r5') && freshScope?.epochValid === true && freshScope.validityEpoch === 2 && freshFence?.fresh === true)
    if (!freshFence) throw new Error('fresh story ledger fence missing')
    repository.assertStoryLedgerFresh({
      runId: freshFence.runId,
      expectedRevision: freshFence.runRevision,
      expectedEpoch: freshFence.validityEpoch,
      expectedHeadRevision: freshFence.headRevision,
      expectedHeadHash: freshFence.headHash
    })
    repository.createRun(runRow('r6', 'completed', rebase.storyScope))
    appendRevision(dbPath, 'r6', 6, { ...scope, branchId: rebase.storyScope.branchId })
    let commitStaleRejected = false
    try {
      repository.assertStoryLedgerFresh({
        runId: freshFence.runId,
        expectedRevision: freshFence.runRevision,
        expectedEpoch: freshFence.validityEpoch,
        expectedHeadRevision: freshFence.headRevision,
        expectedHeadHash: freshFence.headHash
      })
    } catch (error) { commitStaleRejected = error instanceof Error && error.message === 'story_ledger_concurrent_head_conflict' }
    check('head 在 provider 后变化时 commit fence fail-closed', commitStaleRejected)

    const nestedRebase = repository.prepareStoryLedgerRebase('r5')
    repository.createRun(runRow('r7', 'queued', nestedRebase.storyScope))
    appendRevision(dbPath, 'r7', 7, { ...scope, branchId: nestedRebase.storyScope.branchId }, 'rebase')
    const nestedLedger = repository.getNarrativeLedger('r7')
    check('第二次安全 rebase 可递归继承 rev5 并继续写', nestedLedger.length === 4 && nestedLedger.some((entry) => entry.runId === 'r6') && nestedLedger.some((entry) => entry.runId === 'r7'))

    repository.close()
    repository = createRepository(dbPath)
    repository.open()
    let restartBlocked = false
    try { repository.getNarrativeLedger('active-old') } catch (error) { restartBlocked = error instanceof Error && error.message === 'story_ledger_epoch_invalidated' }
    const afterRestart = repository.getNarrativeLedger('r7')
    check('重启后旧 epoch 仍阻断且新 epoch 可见', restartBlocked && afterRestart.length === 4 && afterRestart.some((entry) => entry.runId === 'r5') && afterRestart.some((entry) => entry.runId === 'r7'))
    const db = new DatabaseSync(dbPath)
    try {
      const head = db.prepare('SELECT high_watermark, validity_epoch FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as { high_watermark?: number; validity_epoch?: number }
      const tombstone = db.prepare('SELECT validity_epoch, next_validity_epoch FROM story_ledger_tombstones WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as { validity_epoch?: number; next_validity_epoch?: number }
      const r5 = db.prepare('SELECT node_type, validity_epoch, rebase_parent_revision FROM story_ledger_revisions WHERE run_id=?').get('r5') as { node_type?: string; validity_epoch?: number; rebase_parent_revision?: number }
      check('生产表持久化 epoch/rebase 元数据', head.validity_epoch === 2 && tombstone.validity_epoch === 1 && tombstone.next_validity_epoch === 2 && r5.node_type === 'rebase' && r5.validity_epoch === 2 && r5.rebase_parent_revision === 4)
    } finally { db.close() }
  } finally {
    repository?.close()
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nP1-3 story ledger epoch: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => { console.error('P1-3 story ledger epoch 执行异常：', error); process.exitCode = 2 })
