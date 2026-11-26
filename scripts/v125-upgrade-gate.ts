// v1.2.5 Beta：独立数据库升级 / 备份 / 回滚门禁。
//
// 该门禁只使用临时目录和本地 node:sqlite，不启动 Electron、不配置 provider，
// 也不读取项目 userData/saves。升级路径必须经过真实 openDb/runMigrations。
// 运行：
//   npx esbuild scripts/v125-upgrade-gate.ts --bundle --format=esm --platform=node --outfile=<temp>/v125-upgrade-gate.mjs --external:node:sqlite
//   node <temp>/v125-upgrade-gate.mjs

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import * as fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as os from 'node:os'
import * as path from 'node:path'
import { CURRENT_SCHEMA_VERSION, closeDb, openDb, runMigrations } from '../src/main/db/migrations'

type SqlRow = Record<string, unknown>

interface StagedFixture {
  label: string
  targetVersion: number
  dbPath: string
  runId: string
  turnId: string
  sessionId: string
  segmentId: string
  segmentContent: string
}

interface KeyRowsSnapshot {
  run: SqlRow | undefined
  turn: SqlRow | undefined
  segment: SqlRow | undefined
  sessionMessages: SqlRow[]
}

const EXPECTED_CHECKS_BEFORE_COUNT_ASSERTION = 88

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
    return
  }
  failed += 1
  const message = `${name}${detail ? ` — ${detail}` : ''}`
  failures.push(message)
  console.error(`  FAIL  ${message}`)
}

function identifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === 'bigint') return current.toString()
    if (current instanceof Uint8Array) return Buffer.from(current).toString('hex')
    return current
  })
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function fileHash(filePath: string): string {
  return sha256(fs.readFileSync(filePath))
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right))
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name?: unknown }>)
    .map((row) => typeof row.name === 'string' ? row.name : '')
    .filter((name) => name.length > 0)
    .sort()
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name))
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown }
  return Number(row.user_version ?? -1)
}

function rowCount(db: DatabaseSync, table: string, where = '', params: Array<string | number | bigint | null | Uint8Array> = []): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${identifier(table)}${where}`).get(...params) as { n?: unknown }
  return Number(row.n ?? -1)
}

/**
 * Stable identity of the user database, intentionally excluding `meta`.
 * openDb records migration_backup in meta after making the copy; business
 * tables, schemas, user_version and their rows are the recoverable identity.
 */
function semanticIdentity(dbPath: string): string {
  const db = new DatabaseSync(dbPath)
  try {
    const tables = tableNames(db).filter((name) => name !== 'meta')
    const state = tables.map((name) => {
      const schema = db.prepare('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?').get(name) as { sql?: unknown } | undefined
      const columns = db.prepare(`PRAGMA table_info(${identifier(name)})`).all() as SqlRow[]
      let rows: SqlRow[]
      try {
        rows = db.prepare(`SELECT * FROM ${identifier(name)}`).all() as SqlRow[]
      } catch {
        rows = []
      }
      const normalizedRows = rows.map((row) => JSON.parse(stableJson(row)) as SqlRow).sort((a, b) => stableJson(a).localeCompare(stableJson(b)))
      return {
        name,
        sql: typeof schema?.sql === 'string' ? schema.sql : null,
        columns: JSON.parse(stableJson(columns)),
        rows: normalizedRows
      }
    })
    return sha256(stableJson({ userVersion: readUserVersion(db), tables: state }))
  } finally {
    db.close()
  }
}

function captureKeyRows(dbPath: string, fixture: StagedFixture): KeyRowsSnapshot {
  const db = new DatabaseSync(dbPath)
  try {
    const run = db.prepare('SELECT * FROM runs WHERE run_id=?').get(fixture.runId) as SqlRow | undefined
    const turn = db.prepare('SELECT * FROM turns WHERE turn_id=?').get(fixture.turnId) as SqlRow | undefined
    const segment = db.prepare('SELECT * FROM manuscript_segments WHERE segment_id=?').get(fixture.segmentId) as SqlRow | undefined
    const sessionMessages = db.prepare('SELECT * FROM session_messages WHERE session_id=? ORDER BY seq,msg_id').all(fixture.sessionId) as SqlRow[]
    return {
      run: run === undefined ? undefined : JSON.parse(stableJson(run)) as SqlRow,
      turn: turn === undefined ? undefined : JSON.parse(stableJson(turn)) as SqlRow,
      segment: segment === undefined ? undefined : JSON.parse(stableJson(segment)) as SqlRow,
      sessionMessages: JSON.parse(stableJson(sessionMessages)) as SqlRow[]
    }
  } finally {
    db.close()
  }
}

function keyRowsEqual(actual: KeyRowsSnapshot, expected: KeyRowsSnapshot): boolean {
  return stableJson(actual) === stableJson(expected)
}

function integrityCheckOk(db: DatabaseSync): boolean {
  const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: unknown }>
  return rows.length === 1 && rows[0]?.integrity_check === 'ok'
}

function closeStagedDb(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    /* checkpoint is best effort; close still flushes the temporary fixture */
  }
  db.close()
}

function insertSharedFixtureRows(db: DatabaseSync, label: string, targetVersion: number): StagedFixture {
  const safe = label.replace(/[^a-zA-Z0-9_-]/g, '-')
  const runId = `${safe}-run`
  const sessionId = `${safe}-session`
  const turnId = `${safe}-turn`
  const segmentId = `${safe}-segment`
  const segmentContent = `v1.2.4/v${targetVersion} legacy prose retained for ${label}`
  const now = 1_725_000_000_000 + targetVersion
  db.prepare(`INSERT INTO runs (
    run_id,session_id,status,phase,started_at,updated_at,config_json,parent_run_id,error_code,error_message
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(runId, sessionId, 'completed', 'completed', now, now, '{}', null, null, null)
  db.prepare(`INSERT INTO turns (
    turn_id,run_id,turn_seq,role,content,reasoning_content,tool_calls_json,tool_result_json,plan_state,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(turnId, runId, 1, 'assistant', segmentContent, null, null, null, null, now)
  db.prepare(`INSERT INTO sessions (session_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?)`).run(sessionId, `旧库 ${label}`, 'fixture-model', now, now)
  db.prepare(`INSERT INTO session_messages (
    msg_id,session_id,seq,role,content,reasoning,status,usage_json,rounds,tool_names_json,plan,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(`${safe}-message`, sessionId, 1, 'assistant', segmentContent, '', 'done', 'null', 0, '[]', null, now)
  db.prepare(`INSERT INTO manuscript_segments (
    segment_id,run_id,session_id,source_turn_id,section_id,scene_id,chunk_index,revision,status,kind,
    content,content_hash,char_count,supersedes_segment_id,created_at,updated_at,accepted_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    segmentId,
    runId,
    sessionId,
    turnId,
    `${safe}-section`,
    `${safe}-scene`,
    0,
    1,
    'accepted',
    'prose',
    segmentContent,
    sha256(segmentContent),
    segmentContent.length,
    null,
    now,
    now,
    now
  )
  if (targetVersion >= 28) insertWorkingSetV28(db, `${safe}-working-set`)
  return { label, targetVersion, dbPath: '', runId, turnId, sessionId, segmentId, segmentContent }
}

function insertWorkingSetV28(db: DatabaseSync, workingSetId: string, scopeKey = workingSetId): void {
  const storyId = `${scopeKey}-story`
  const projectId = `${scopeKey}-project`
  const branchId = 'main'
  const sceneId = `${scopeKey}-scene`
  const queryHash = sha256(`${scopeKey}:query`)
  const payload = stableJson({ fixture: workingSetId })
  db.prepare(`INSERT INTO scene_working_sets (
    working_set_id,story_id,project_id,branch_id,validity_epoch,story_revision,scene_id,query_hash,
    card_ids_json,omitted_json,payload_json,working_set_hash,status,created_at,updated_at,
    schema_version,run_id,branch_lineage_json,branch_cutoffs_json,canonical_json,canonical_hash,final_envelope_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    workingSetId,
    storyId,
    projectId,
    branchId,
    1,
    1,
    sceneId,
    queryHash,
    '[]',
    '[]',
    payload,
    sha256(payload),
    'active',
    1,
    1,
    1,
    null,
    '["main"]',
    '{}',
    null,
    null,
    null
  )
}

async function stageDatabase(root: string, label: string, targetVersion: number): Promise<StagedFixture> {
  const dbPath = path.join(root, `${label}.sqlite`)
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    runMigrations(db, targetVersion)
    const fixture = insertSharedFixtureRows(db, label, targetVersion)
    fixture.dbPath = dbPath
    return fixture
  } finally {
    closeStagedDb(db)
  }
}

function backupPathFor(fixture: StagedFixture): string {
  return `${fixture.dbPath}.pre-v${fixture.targetVersion}.bak`
}

function assertRetainedRows(db: DatabaseSync, fixture: StagedFixture, prefix: string): void {
  const run = db.prepare('SELECT run_id, session_id FROM runs WHERE run_id=?').get(fixture.runId) as { run_id?: string; session_id?: string } | undefined
  check(`${prefix} runs/会话身份保留`, run?.run_id === fixture.runId && run.session_id === fixture.sessionId, stableJson(run))
  const turn = db.prepare('SELECT content FROM turns WHERE turn_id=?').get(fixture.turnId) as { content?: string } | undefined
  check(`${prefix} turn 正文保留`, turn?.content === fixture.segmentContent, stableJson(turn))
  const segment = db.prepare('SELECT content,content_hash FROM manuscript_segments WHERE segment_id=?').get(fixture.segmentId) as { content?: string; content_hash?: string } | undefined
  check(`${prefix} accepted prose 与 hash 保留`, segment?.content === fixture.segmentContent && segment.content_hash === sha256(fixture.segmentContent), stableJson(segment))
  check(`${prefix} session_messages 保留`, rowCount(db, 'session_messages', ' WHERE session_id=?', [fixture.sessionId]) === 1)
}

function exerciseProjectionTables(db: DatabaseSync, fixture: StagedFixture): void {
  const cardId = `${fixture.label}-scene-card`
  const cardJson = stableJson({ schemaVersion: 1, cardId, source: 'v125-upgrade-gate' })
  db.prepare(`INSERT INTO scene_memory_cards (
    card_id,schema_version,status,visibility,story_id,project_id,branch_id,validity_epoch,story_revision,
    run_id,scene_id,scene_order,contract_id,contract_hash,scene_content_hash,commit_manifest_hash,
    state_delta_hash,card_hash,card_json,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    cardId,
    1,
    'canonical',
    'active',
    `${fixture.label}-story`,
    `${fixture.label}-project`,
    'main',
    1,
    1,
    fixture.runId,
    `${fixture.label}-scene`,
    1,
    `${fixture.label}-contract`,
    sha256('contract'),
    sha256(fixture.segmentContent),
    sha256('manifest'),
    sha256('delta'),
    sha256(cardJson),
    cardJson,
    1,
    1
  )
  const card = db.prepare('SELECT card_id,card_json FROM scene_memory_cards WHERE card_id=?').get(cardId) as { card_id?: string; card_json?: string } | undefined
  check('SceneMemoryCard 表可写可读', card?.card_id === cardId && card.card_json === cardJson, stableJson(card))

  const workingSetBase = `${fixture.label}-working-set`
  insertWorkingSetV28(db, workingSetBase, workingSetBase)
  insertWorkingSetV28(db, `${workingSetBase}-attempt-2`, workingSetBase)
  const workingSets = db.prepare(`SELECT working_set_id FROM scene_working_sets WHERE story_id=? AND project_id=? AND branch_id=? AND scene_id=? ORDER BY working_set_id`).all(
    `${workingSetBase}-story`,
    `${workingSetBase}-project`,
    'main',
    `${workingSetBase}-scene`
  ) as Array<{ working_set_id?: string }>
  check('WorkingSet 表可写可读且允许 v29 attempt 维度', workingSets.length === 2, stableJson(workingSets))
}

async function verifySuccessfulUpgrade(fixture: StagedFixture): Promise<void> {
  console.log(`\n[UPGRADE ${fixture.label}] v${fixture.targetVersion} → v${CURRENT_SCHEMA_VERSION}`)
  const beforeIdentity = semanticIdentity(fixture.dbPath)
  const beforeSourceSha = fileHash(fixture.dbPath)
  const beforeKeyRows = captureKeyRows(fixture.dbPath, fixture)
  const backupPath = backupPathFor(fixture)
  let postUpgradeIdentityBeforeProjection = ''

  const db = openDb(fixture.dbPath)
  try {
    check('升级后 user_version=29', readUserVersion(db) === 29, `实际=${readUserVersion(db)}`)
    assertRetainedRows(db, fixture, '升级后')
    check('SceneMemoryCard/WorkingSet 表存在', hasTable(db, 'scene_memory_cards') && hasTable(db, 'scene_working_sets'))
    postUpgradeIdentityBeforeProjection = semanticIdentity(fixture.dbPath)
    exerciseProjectionTables(db, fixture)
  } finally {
    closeDb(db)
  }

  check('迁移前备份文件存在且非空', fs.existsSync(backupPath) && fs.statSync(backupPath).size > 0, backupPath)
  if (fs.existsSync(backupPath)) {
    const backupHash = fileHash(backupPath)
    check('备份 SHA 与升级前源库 SHA 分别冻结记录', backupHash.length === 64 && beforeSourceSha.length === 64, `source=${beforeSourceSha} backup=${backupHash}`)
    check('备份 user_version 等于来源版本', (() => {
      const backupDb = new DatabaseSync(backupPath)
      try { return readUserVersion(backupDb) === fixture.targetVersion } finally { backupDb.close() }
    })(), `预期=${fixture.targetVersion}`)
    check('备份可复算原库业务身份', semanticIdentity(backupPath) === beforeIdentity, `${beforeIdentity} != ${semanticIdentity(backupPath)}`)
    check('备份关键行精确等于升级前快照', keyRowsEqual(captureKeyRows(backupPath, fixture), beforeKeyRows))
    const restorePath = path.join(path.dirname(backupPath), `${fixture.label}-backup-restore.sqlite`)
    await fsp.copyFile(backupPath, restorePath)
    check('备份独立副本在打开前 SHA 等于冻结值', fileHash(restorePath) === backupHash)
    const restoreBeforeOpen = new DatabaseSync(restorePath)
    try {
      check('备份独立副本打开前版本/语义/关键行一致', readUserVersion(restoreBeforeOpen) === fixture.targetVersion && semanticIdentity(restorePath) === beforeIdentity && keyRowsEqual(captureKeyRows(restorePath, fixture), beforeKeyRows))
    } finally {
      restoreBeforeOpen.close()
    }
    const restored = openDb(restorePath)
    try {
      check('备份独立副本恢复后完整性与版本正确', integrityCheckOk(restored) && readUserVersion(restored) === 29)
      check('备份独立副本恢复后语义身份一致', semanticIdentity(restorePath) === postUpgradeIdentityBeforeProjection)
      check('备份独立副本恢复后关键行一致', keyRowsEqual(captureKeyRows(restorePath, fixture), beforeKeyRows))
    } finally {
      closeDb(restored)
    }
  }

  const dbAgain = openDb(fixture.dbPath)
  try {
    check('重复 open 幂等保持 v29', readUserVersion(dbAgain) === 29)
    assertRetainedRows(dbAgain, fixture, '重复 open 后')
    check('重复 open 不重复 projection 行', rowCount(dbAgain, 'scene_memory_cards', ' WHERE card_id=?', [`${fixture.label}-scene-card`]) === 1 && rowCount(dbAgain, 'scene_working_sets', ' WHERE working_set_id LIKE ?', [`${fixture.label}-working-set%`]) === 2)
  } finally {
    closeDb(dbAgain)
  }

  check('升级前业务身份与 bytes SHA 仅在预期迁移后改变', semanticIdentity(fixture.dbPath) !== beforeIdentity && beforeSourceSha !== fileHash(fixture.dbPath))
}

async function verifyV27Failure(root: string): Promise<void> {
  const fixture = await stageDatabase(root, 'v27-injected-failure', 26)
  console.log('\n[ROLLBACK v27] 注入 v27 中途失败')
  const beforeIdentity = semanticIdentity(fixture.dbPath)
  const beforeSourceSha = fileHash(fixture.dbPath)
  const beforeKeyRows = captureKeyRows(fixture.dbPath, fixture)
  const backupPath = backupPathFor(fixture)
  const expectedPath = path.join(root, 'v27-expected-upgrade.sqlite')
  await fsp.copyFile(fixture.dbPath, expectedPath)
  const expectedDb = openDb(expectedPath)
  const expectedPostMigrationIdentity = semanticIdentity(expectedPath)
  closeDb(expectedDb)
  let threw = false
  process.env.DW_R70_INJECT_V27_FAILURE = '1'
  try {
    openDb(fixture.dbPath)
  } catch (error) {
    threw = true
    check('v27 注入失败被 openDb 抛出', String(error).includes('scene_memory_v27_injected_failure'), String(error))
  } finally {
    delete process.env.DW_R70_INJECT_V27_FAILURE
  }
  check('v27 注入确实拒绝打开', threw)

  const afterIdentity = semanticIdentity(fixture.dbPath)
  check('v27 失败后原库语义快照与注入前一致', beforeIdentity === afterIdentity)
  const afterDbIntegrity = new DatabaseSync(fixture.dbPath)
  let afterIntegrityOk = false
  try { afterIntegrityOk = integrityCheckOk(afterDbIntegrity) } finally { afterDbIntegrity.close() }
  check('v27 失败后原库 integrity_check=ok', afterIntegrityOk)
  check('v27 失败后原库关键行与注入前一致', keyRowsEqual(captureKeyRows(fixture.dbPath, fixture), beforeKeyRows))
  const afterDb = new DatabaseSync(fixture.dbPath)
  try {
    check('v27 回滚后 user_version 仍为 26', readUserVersion(afterDb) === 26)
    check('v27 回滚后首张 projection 表不存在', !hasTable(afterDb, 'scene_memory_cards'))
    assertRetainedRows(afterDb, fixture, 'v27 回滚后')
  } finally {
    afterDb.close()
  }
  const v27BackupExists = fs.existsSync(backupPath) && fs.statSync(backupPath).size > 0
  const backupHash = v27BackupExists ? fileHash(backupPath) : ''
  check('v27 失败仍生成来源版本备份且 SHA 可冻结', v27BackupExists && backupHash.length === 64 && beforeSourceSha.length === 64, `source=${beforeSourceSha}${v27BackupExists ? ` backup=${backupHash}` : ''}`)
  if (v27BackupExists) {
    check('v27 备份 user_version 等于 26', (() => {
      const backupDb = new DatabaseSync(backupPath)
      try { return readUserVersion(backupDb) === 26 } finally { backupDb.close() }
    })())
    check('v27 备份身份与失败前原库一致', semanticIdentity(backupPath) === beforeIdentity)
    check('v27 备份关键行精确等于注入前快照', keyRowsEqual(captureKeyRows(backupPath, fixture), beforeKeyRows))
    const restorePath = path.join(root, 'v27-restored-from-backup.sqlite')
    await fsp.copyFile(backupPath, restorePath)
    check('v27 备份独立副本在打开前 SHA 等于冻结值', fileHash(restorePath) === backupHash)
    const restoreBeforeOpen = new DatabaseSync(restorePath)
    try {
      check('v27 备份独立副本打开前版本/语义/关键行一致', readUserVersion(restoreBeforeOpen) === 26 && semanticIdentity(restorePath) === beforeIdentity && keyRowsEqual(captureKeyRows(restorePath, fixture), beforeKeyRows))
    } finally {
      restoreBeforeOpen.close()
    }
    const restored = openDb(restorePath)
    try {
      check('v27 备份副本恢复后完整性/版本/新表正确', integrityCheckOk(restored) && readUserVersion(restored) === 29 && hasTable(restored, 'scene_memory_cards') && hasTable(restored, 'scene_working_sets'))
      check('v27 备份副本恢复后语义身份一致', semanticIdentity(restorePath) === expectedPostMigrationIdentity)
      check('v27 备份副本恢复后关键行一致', keyRowsEqual(captureKeyRows(restorePath, fixture), beforeKeyRows))
    } finally {
      closeDb(restored)
    }
  }
}

async function verifyV29Failure(root: string): Promise<void> {
  const fixture = await stageDatabase(root, 'v29-injected-failure', 28)
  console.log('\n[ROLLBACK v29] 注入 v29 table rebuild 中途失败')
  const beforeIdentity = semanticIdentity(fixture.dbPath)
  const beforeSourceSha = fileHash(fixture.dbPath)
  const beforeKeyRows = captureKeyRows(fixture.dbPath, fixture)
  const backupPath = backupPathFor(fixture)
  const expectedPath = path.join(root, 'v29-expected-upgrade.sqlite')
  await fsp.copyFile(fixture.dbPath, expectedPath)
  const expectedDb = openDb(expectedPath)
  const expectedPostMigrationIdentity = semanticIdentity(expectedPath)
  closeDb(expectedDb)
  let threw = false
  process.env.DW_R72_INJECT_V29_FAILURE = '1'
  try {
    openDb(fixture.dbPath)
  } catch (error) {
    threw = true
    check('v29 注入失败被 openDb 抛出', String(error).includes('scene_working_set_v29_injected_failure'), String(error))
  } finally {
    delete process.env.DW_R72_INJECT_V29_FAILURE
  }
  check('v29 注入确实拒绝打开', threw)

  const afterIdentity = semanticIdentity(fixture.dbPath)
  const afterDbIntegrity = new DatabaseSync(fixture.dbPath)
  let afterIntegrityOk = false
  try { afterIntegrityOk = integrityCheckOk(afterDbIntegrity) } finally { afterDbIntegrity.close() }
  check('v29 失败后原库语义/integrity/关键行与注入前一致', beforeIdentity === afterIdentity && afterIntegrityOk && keyRowsEqual(captureKeyRows(fixture.dbPath, fixture), beforeKeyRows))
  const afterDb = new DatabaseSync(fixture.dbPath)
  try {
    check('v29 回滚后 user_version 仍为 28', readUserVersion(afterDb) === 28)
    check('v29 回滚后旧 WorkingSet 表与行仍在', hasTable(afterDb, 'scene_working_sets') && !hasTable(afterDb, 'scene_working_sets_v29_old') && rowCount(afterDb, 'scene_working_sets', ' WHERE working_set_id=?', ['v29-injected-failure-working-set']) === 1)
  } finally {
    afterDb.close()
  }
  const v29BackupExists = fs.existsSync(backupPath) && fs.statSync(backupPath).size > 0
  check('v29 失败仍生成来源版本备份且 SHA 可冻结', v29BackupExists && fileHash(backupPath).length === 64 && beforeSourceSha.length === 64, `source=${beforeSourceSha}${v29BackupExists ? ` backup=${fileHash(backupPath)}` : ''}`)
  if (fs.existsSync(backupPath)) {
    const backupHash = fileHash(backupPath)
    check('v29 备份 user_version 与身份正确', (() => {
      const backupDb = new DatabaseSync(backupPath)
      try { return readUserVersion(backupDb) === 28 && semanticIdentity(backupPath) === beforeIdentity } finally { backupDb.close() }
    })())
    check('v29 备份关键行精确等于注入前快照', keyRowsEqual(captureKeyRows(backupPath, fixture), beforeKeyRows))
    const restorePath = path.join(root, 'v29-restored-from-backup.sqlite')
    await fsp.copyFile(backupPath, restorePath)
    check('v29 备份独立副本在打开前 SHA 等于冻结值', fileHash(restorePath) === backupHash)
    const restoreBeforeOpen = new DatabaseSync(restorePath)
    try {
      check('v29 备份独立副本打开前版本/语义/关键行一致', readUserVersion(restoreBeforeOpen) === 28 && semanticIdentity(restorePath) === beforeIdentity && keyRowsEqual(captureKeyRows(restorePath, fixture), beforeKeyRows))
    } finally {
      restoreBeforeOpen.close()
    }
    const restored = openDb(restorePath)
    try {
      check('v29 备份副本恢复后完整性/版本/WorkingSet 正确', integrityCheckOk(restored) && readUserVersion(restored) === 29 && rowCount(restored, 'scene_working_sets', ' WHERE working_set_id=?', ['v29-injected-failure-working-set']) === 1)
      check('v29 备份副本恢复后语义身份/关键行一致', semanticIdentity(restorePath) === expectedPostMigrationIdentity && keyRowsEqual(captureKeyRows(restorePath, fixture), beforeKeyRows))
    } finally {
      closeDb(restored)
    }
  }
}

async function verifyMalformedFailClosed(root: string): Promise<void> {
  console.log('\n[MALFORMED] 非 SQLite 文件 fail-closed')
  const malformedPath = path.join(root, 'malformed.sqlite')
  const original = Buffer.from('this is intentionally not a sqlite database\u0000v125-gate', 'utf8')
  await fsp.writeFile(malformedPath, original)
  let threw = false
  try {
    openDb(malformedPath)
  } catch {
    threw = true
  }
  check('malformed 库打开失败', threw)
  const after = fs.readFileSync(malformedPath)
  check('malformed 原文件字节未被替换', bytesEqual(original, after))
  const siblingBackups = fs.readdirSync(root).filter((name) => name.startsWith('malformed.sqlite.pre-v'))
  check('malformed 库不伪造迁移备份', siblingBackups.length === 0, siblingBackups.join(','))
}

async function main(): Promise<void> {
  if (CURRENT_SCHEMA_VERSION !== 29) throw new Error(`v1.2.5 gate 预期当前 schema=29，实际=${CURRENT_SCHEMA_VERSION}`)
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepwriter-v125-upgrade-'))
  const previousJsonlSessionsDir = process.env.DW_JSONL_SESSIONS_DIR
  const controlledJsonlSessionsDir = path.join(root, 'legacy-sessions-empty')
  await fsp.mkdir(controlledJsonlSessionsDir, { recursive: true })
  process.env.DW_JSONL_SESSIONS_DIR = controlledJsonlSessionsDir
  try {
    console.log(`[SETUP] 临时目录：${root}`)
    check('当前真实 migration 版本为 v29', CURRENT_SCHEMA_VERSION === 29, String(CURRENT_SCHEMA_VERSION))
    check('旧 JSONL 源路径强制隔离在本轮临时目录', path.resolve(process.env.DW_JSONL_SESSIONS_DIR) === path.resolve(controlledJsonlSessionsDir), process.env.DW_JSONL_SESSIONS_DIR)
    const v25 = await stageDatabase(root, 'v1-2-4-v25', 25)
    const v26 = await stageDatabase(root, 'v26-intermediate', 26)
    await verifySuccessfulUpgrade(v25)
    await verifySuccessfulUpgrade(v26)
    await verifyV27Failure(root)
    await verifyV29Failure(root)
    await verifyMalformedFailClosed(root)
    check('受控旧 JSONL 目录未产生外部迁移副作用', (await fsp.readdir(controlledJsonlSessionsDir)).length === 0)
  } finally {
    if (previousJsonlSessionsDir === undefined) delete process.env.DW_JSONL_SESSIONS_DIR
    else process.env.DW_JSONL_SESSIONS_DIR = previousJsonlSessionsDir
    await fsp.rm(root, { recursive: true, force: true })
  }
  const actualChecksBeforeCountAssertion = passed + failed
  if (actualChecksBeforeCountAssertion !== EXPECTED_CHECKS_BEFORE_COUNT_ASSERTION) {
    failed += 1
    failures.push(`固定检查数不符：预期 ${EXPECTED_CHECKS_BEFORE_COUNT_ASSERTION}，实际 ${actualChecksBeforeCountAssertion}`)
    console.error(`  FAIL  固定检查数不符：预期 ${EXPECTED_CHECKS_BEFORE_COUNT_ASSERTION}，实际 ${actualChecksBeforeCountAssertion}`)
  } else {
    console.log(`  PASS  固定检查数断言：${actualChecksBeforeCountAssertion}/${EXPECTED_CHECKS_BEFORE_COUNT_ASSERTION}`)
  }
  console.log(`\n===== v1.2.5 Beta 数据库升级门禁：${passed} PASS / ${failed} FAIL =====`)
  if (failures.length > 0) {
    console.log('失败明细：')
    for (const failure of failures) console.log(`  - ${failure}`)
  }
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('v1.2.5 Beta 数据库升级门禁异常：', error)
  process.exitCode = 2
})
