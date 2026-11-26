import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createRepository, type Repository, type SceneRecallCorpusSnapshotInput } from '../src/main/db/repository'
import { CURRENT_SCHEMA_VERSION, openDb, runMigrations } from '../src/main/db/migrations'
import { createContextService } from '../src/main/contextService'
import { ContextV2Service } from '../src/main/contextV2'
import { buildSceneContractPlan } from '../src/main/narrative/sceneContract'
import { buildNarrativeFactsFromGrill } from '../src/main/narrative/factRegistry'
import { stableSceneMemoryJson } from '../src/main/narrative/sceneMemoryCard'
import { storyLedgerGenesisHeadHash } from '../src/main/narrative/storyLedger'
import { manuscriptSegmentHash as sha } from '../src/main/manuscript'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import type { SceneRecallCurrentSceneTail } from '../src/shared/types'

const runId = 'r61-tail-run'
const sessionId = 'r61-tail-session'
const answers = [{ slotId: 'goal', value: '林舟继续写作', source: 'user' }]
const outline: GrillMeOutline = { title: 'R61 tail integrity', premise: '林舟继续写作。', targetChars: 2_000_000, sections: [{ id: 'section-r61', title: '连续写作', purpose: '保持连续。', targetChars: 2_000_000, beats: ['林舟继续写作'], sourceSlotIds: ['goal'] }] }
const scenePlan = buildSceneContractPlan({ outline, outlineHash: grillMeOutlineHash(outline), outlineRevision: 1, answers, characterNames: ['林舟'], strongConstraints: { forbiddenTerms: [], mustKeep: [] } })
const contract = scenePlan.contracts[0]!
const columns = 'segment_id,run_id,session_id,source_turn_id,section_id,scene_id,chunk_index,revision,status,kind,content,content_hash,char_count,supersedes_segment_id,created_at,updated_at,accepted_at'

function insert(db: DatabaseSync, id: string, chunk: number, content: string, status = 'accepted', revision = 1): void {
  db.prepare(`INSERT INTO manuscript_segments (${columns}) VALUES (${Array(17).fill('?').join(',')})`).run(id, runId, sessionId, null, contract.sectionId, contract.sceneId, chunk, revision, status, 'prose', content, sha(content), Array.from(content).length, null, 100 + chunk, 100 + chunk, status === 'accepted' ? 100 + chunk : null)
}

function seedLegacyPrefix(db: DatabaseSync): void {
  const rows = db.prepare("SELECT * FROM manuscript_segments WHERE run_id=? AND status='accepted' AND kind='prose' ORDER BY chunk_index,revision,created_at,segment_id").all(runId)
  let hash = sha('deepwriter:accepted-prefix:v1\u0000empty')
  let chars = 0
  for (const row of rows) {
    assert.equal(row.content_hash, sha(String(row.content)))
    assert.equal(row.char_count, Array.from(String(row.content)).length)
    hash = sha(['deepwriter:accepted-prefix:v1', hash, row.segment_id, row.content_hash, row.char_count, row.chunk_index, row.revision, row.created_at].join('\u0000'))
    chars += Number(row.char_count)
  }
  const last = rows.at(-1)
  db.prepare(`INSERT INTO narrative_prefix_cache (run_id,schema_version,state,prefix_hash,accepted_char_count,accepted_segment_count,last_chunk_index,last_revision,last_created_at,last_segment_id,cache_revision,updated_at)
    VALUES (?,1,'valid',?,?,?,?,?,?,?,1,1) ON CONFLICT(run_id) DO UPDATE SET state='valid',prefix_hash=excluded.prefix_hash,accepted_char_count=excluded.accepted_char_count,accepted_segment_count=excluded.accepted_segment_count,last_chunk_index=excluded.last_chunk_index,last_revision=excluded.last_revision,last_created_at=excluded.last_created_at,last_segment_id=excluded.last_segment_id`).run(runId, hash, chars, rows.length, last?.chunk_index ?? null, last?.revision ?? null, last?.created_at ?? null, last?.segment_id ?? null)
}

function fixture(): { db: DatabaseSync; repo: Repository; dbPath: string; input: (recentChars?: number) => SceneRecallCorpusSnapshotInput; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'dw-r61-tail-test-'))
  const dbPath = path.join(root, 'tail.sqlite')
  const repo = createRepository(dbPath)
  repo.open()
  repo.createSession(sessionId, 'R61 tail', 'synthetic')
  repo.createRun({ run_id: runId, session_id: sessionId, status: 'running', phase: 'writing', started_at: 1, updated_at: 1, config_json: '{}', parent_run_id: null, error_code: null, error_message: null })
  repo.ensureSceneStates(runId, scenePlan, 10)
  repo.transitionSceneState({ runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: 1, from: 'planned', to: 'writing', at: 11 })
  const db = new DatabaseSync(dbPath)
  db.exec('BEGIN')
  for (let index = 1; index <= 64; index++) insert(db, `accepted-${index}`, index, `${index}:林舟😀${'景'.repeat(70)}。`)
  insert(db, 'old-partial', 0, '旧的未完成正文😀。', 'partial')
  db.exec('COMMIT')
  for (const fact of buildNarrativeFactsFromGrill({ sessionId, runId, answers })) repo.upsertNarrativeFact(fact)
  const input = (recentChars = 2048): SceneRecallCorpusSnapshotInput => {
    const fresh = repo.getStoryLedgerFreshness(runId)!
    return { runId, sceneId: contract.sceneId, currentSceneTail: { contractHash: contract.frozenHash, recentChars }, expectedFence: { ...fresh.scope, branchLineage: [...(fresh.branchLineage ?? [fresh.scope.branchId])], validityEpoch: fresh.validityEpoch, storyRevision: fresh.runRevision, headRevision: fresh.headRevision, headHash: fresh.headHash ?? storyLedgerGenesisHeadHash(fresh.scope, fresh.validityEpoch) } }
  }
  return { db, repo, dbPath, input, cleanup: () => { db.close(); repo.close(); rmSync(root, { recursive: true, force: true }) } }
}

/** The previous all-rows/reverse-array selector, retained only as an oracle. */
function oldTail(db: DatabaseSync, input: SceneRecallCorpusSnapshotInput): SceneRecallCurrentSceneTail {
  const rows = db.prepare("SELECT * FROM manuscript_segments WHERE run_id=? AND scene_id=? AND kind='prose' AND status IN ('accepted','partial') ORDER BY chunk_index,revision,created_at,segment_id").all(runId, contract.sceneId)
  const safeChars = Math.max(1, Math.floor(input.currentSceneTail!.recentChars))
  const selected: SceneRecallCurrentSceneTail['segments'][number][] = []
  let chars = 0
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!
    if (selected.length > 0 && chars + Number(row.char_count) > safeChars) break
    const candidate = { segmentId: String(row.segment_id), runId, sceneId: contract.sceneId, contractHash: contract.frozenHash, status: row.status as 'accepted' | 'partial', content: String(row.content), contentHash: String(row.content_hash), fullContentHash: String(row.content_hash), sourceStartCp: 0, sourceEndCp: Number(row.char_count), charCount: Number(row.char_count), chunkIndex: Number(row.chunk_index), revision: Number(row.revision) }
    if (selected.length === 0 && candidate.charCount > safeChars) {
      const points = Array.from(candidate.content)
      const sourceStartCp = points.length - safeChars
      const content = points.slice(sourceStartCp).join('')
      selected.unshift({ ...candidate, content, contentHash: sha(content), sourceStartCp, sourceEndCp: points.length })
      break
    }
    selected.unshift(candidate)
    chars += candidate.charCount
  }
  const acceptedPrefixHash = String(db.prepare('SELECT prefix_hash FROM narrative_prefix_cache WHERE run_id=?').get(runId)!.prefix_hash)
  return { schemaVersion: 1, sceneId: contract.sceneId, contractHash: contract.frozenHash, acceptedPrefixHash, segments: selected, tailHash: sha(stableSceneMemoryJson({ schemaVersion: 1, sceneId: contract.sceneId, contractHash: contract.frozenHash, acceptedPrefixHash, segments: selected })) }
}

test('lazy descending tail has byte-identical selection, Unicode slicing and full source identity', async () => {
  const f = fixture()
  let context: ContextV2Service | null = null
  try {
    insert(f.db, 'late-partial', 65, `未完成😀${'景'.repeat(2400)}`, 'partial')
    for (const budget of [1, 65, 128, 2048, 4096, 12000]) {
      const input = f.input(budget)
      const actual = f.repo.getSceneRecallCorpusSnapshot(input)
      assert.equal(stableSceneMemoryJson(actual.currentSceneTail), stableSceneMemoryJson(oldTail(f.db, input)))
    }
    context = new ContextV2Service(f.dbPath)
    context.setMode(sessionId, 'minimal', 0, 128)
    const frozenContext = context.freezeForRun({ sessionId, draftText: '继续写作', attachments: [], outputReserveTokens: 128, capabilityFingerprint: 'r61-byte-equivalence' })
    const config = { clientRequestId: runId, sessionId, runMode: 'longwrite', longMode: true, model: 'synthetic', sceneContracts: scenePlan, frozenContext, contextPolicy: { contextWindowTokens: 100000, outputReserveTokens: 128 }, strongConstraints: { enabled: false } }
    const referenceRepo: Repository = { ...f.repo, getSceneRecallCorpusSnapshot: (input) => ({ ...f.repo.getSceneRecallCorpusSnapshot(input), currentSceneTail: oldTail(f.db, input) }) }
    const live = [{ role: 'user' as const, content: '继续写作' }]
    const prefix = [{ role: 'system' as const, content: '只输出正文。' }]
    const old = await createContextService(referenceRepo, context).assembleRunContext(config, 1, live, prefix, 'writer', 'reference-tail', 'writing')
    const actual = await createContextService(f.repo, context).assembleRunContext(config, 1, live, prefix, 'writer', 'lazy-tail', 'writing')
    assert.equal(JSON.stringify(actual.messages), JSON.stringify(old.messages))
    assert.equal(actual.manifest.promptHash, old.manifest.promptHash)
    for (const key of ['workingSetHash', 'manifestHash', 'messageHash', 'sourceSnapshotHash', 'sourceCardSetHash', 'queryHash', 'indexHash'] as const) assert.equal(actual.contextV2!.narrativeWorkingSet![key], old.contextV2!.narrativeWorkingSet![key])
  } finally { context?.close(); f.cleanup() }
})

test('descending tail preserves the old chunk/revision precedence over timestamps', () => {
  const f = fixture()
  try {
    insert(f.db, 'tied-a', 65, '先出现的同序片段😀。')
    // The unchanged unique(run_id,chunk_index,revision) constraint prevents
    // legal timestamp/ID ties; partial revisions exercise the same descending
    // order without dropping the uniqueness guard to fabricate impossible rows.
    insert(f.db, 'tied-z', 65, '后出现的同序片段😀。', 'partial', 2)
    insert(f.db, 'later-revision', 65, '较高版本片段😀。', 'partial', 3)
    f.db.prepare("UPDATE manuscript_segments SET created_at=200 WHERE segment_id='tied-a'").run()
    f.db.prepare("UPDATE manuscript_segments SET created_at=201 WHERE segment_id='tied-z'").run()
    f.db.prepare("UPDATE manuscript_segments SET created_at=1 WHERE segment_id='later-revision'").run()
    for (const budget of [1, 35, 65, 128, 2048]) {
      const input = f.input(budget)
      const actual = f.repo.getSceneRecallCorpusSnapshot(input)
      assert.equal(stableSceneMemoryJson(actual.currentSceneTail), stableSceneMemoryJson(oldTail(f.db, input)))
    }
  } finally { f.cleanup() }
})

test('fresh schema installs the same non-unique metadata-only covering index', () => {
  const f = fixture()
  try {
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 31)
    const index = f.db.prepare("PRAGMA index_list('manuscript_segments')").all().find((row) => row.name === 'idx_manuscript_scene_tail_metadata')!
    assert.equal(index.unique, 0)
    assert.deepEqual(f.db.prepare("PRAGMA index_info('idx_manuscript_scene_tail_metadata')").all().map((row) => row.name), ['run_id', 'scene_id', 'kind', 'chunk_index', 'revision', 'created_at', 'segment_id', 'status', 'content_hash', 'char_count'])
  } finally { f.cleanup() }
})

for (const [field, value] of [['content', '外部篡改。'], ['content_hash', '0'.repeat(64)], ['char_count', 3], ['chunk_index', 1000], ['revision', 2], ['created_at', 98765], ['segment_id', 'different-id']] as const) {
  test(`accepted ${field} mutation invalidates the whole prefix despite unchanged count / unselected old row`, () => {
    const f = fixture()
    try {
      f.repo.getSceneRecallCorpusSnapshot(f.input())
      f.db.prepare(`UPDATE manuscript_segments SET ${field}=? WHERE segment_id='accepted-1'`).run(value)
      assert.equal(f.db.prepare('SELECT state FROM narrative_prefix_cache WHERE run_id=?').get(runId)!.state, 'invalid')
      assert.throws(() => f.repo.getSceneRecallCorpusSnapshot(f.input()), /scene_recall_snapshot_current_tail_prefix_invalid/)
    } finally { f.cleanup() }
  })
}

for (const [field, value] of [['content', '损坏旧 partial。'], ['content_hash', '0'.repeat(64)], ['char_count', -1], ['chunk_index', -1], ['revision', 0], ['created_at', 'invalid-time'], ['segment_id', '']] as const) {
  test(`unselected partial ${field} is still fully validated every request`, () => {
    const f = fixture()
    try {
      f.repo.getSceneRecallCorpusSnapshot(f.input())
      f.db.prepare(`UPDATE manuscript_segments SET ${field}=? WHERE segment_id='old-partial'`).run(value)
      assert.equal(f.db.prepare('SELECT state FROM narrative_prefix_cache WHERE run_id=?').get(runId)!.state, 'valid')
      assert.throws(() => f.repo.getSceneRecallCorpusSnapshot(f.input()), /scene_recall_snapshot_current_tail_segment_invalid/)
    } finally { f.cleanup() }
  })
}

for (const [field, value] of [['chunk_index', -1], ['revision', 0], ['created_at', 'invalid-time'], ['segment_id', '']] as const) {
  test(`legacy valid schema-1 prefix cannot conceal old accepted ${field} corruption`, () => {
    const f = fixture()
    try {
      f.db.prepare(`UPDATE manuscript_segments SET ${field}=? WHERE segment_id='accepted-1'`).run(value)
      seedLegacyPrefix(f.db)
      assert.throws(() => f.repo.getSceneRecallCorpusSnapshot(f.input()), /scene_recall_snapshot_current_tail_segment_invalid/)
      f.db.prepare('DELETE FROM narrative_prefix_cache WHERE run_id=?').run(runId)
      assert.throws(() => f.repo.getSceneRecallCorpusSnapshot(f.input()), /narrative_context_accepted_segment_invalid/)
    } finally { f.cleanup() }
  })
}

test('external insert/delete and a missing prefix rebuild cannot reuse old authority', () => {
  for (const action of ['insert', 'delete', 'missing-cache-corrupt-body']) {
    const f = fixture()
    try {
      f.repo.getSceneRecallCorpusSnapshot(f.input())
      if (action === 'insert') insert(f.db, 'outside-append', 66, '外部追加。')
      else if (action === 'delete') f.db.prepare("DELETE FROM manuscript_segments WHERE segment_id='accepted-1'").run()
      else {
        f.db.prepare("UPDATE manuscript_segments SET content='损坏旧正文。' WHERE segment_id='accepted-1'").run()
        f.db.prepare('DELETE FROM narrative_prefix_cache WHERE run_id=?').run(runId)
      }
      assert.throws(() => f.repo.getSceneRecallCorpusSnapshot(f.input()), /prefix_invalid|accepted_segment_invalid/)
    } finally { f.cleanup() }
  }
})

test('v30 -> v31 adds only a non-unique covering index and preserves data, credential blobs and prefix bytes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dw-r61-index-upgrade-'))
  const dbPath = path.join(root, 'upgrade.sqlite')
  let db: DatabaseSync | null = new DatabaseSync(dbPath)
  try {
    assert.equal(CURRENT_SCHEMA_VERSION, 31)
    runMigrations(db, 30)
    db.prepare('INSERT INTO sessions (session_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?)').run(sessionId, '保留会话😀', 'synthetic', 1, 1)
    db.prepare('INSERT INTO runs (run_id,session_id,status,phase,started_at,updated_at,config_json) VALUES (?,?,?,?,?,?,?)').run(runId, sessionId, 'running', 'writing', 1, 1, '{}')
    for (let index = 1; index <= 8; index++) insert(db, `accepted-${index}`, index, `第${index}段😀保留正文。`)
    seedLegacyPrefix(db)
    db.prepare("INSERT INTO provider_registry (id,kind,adapter_id,display_name,base_url,chat_path,auth_style,transport_policy_json,created_at,updated_at) VALUES ('synthetic','custom','custom.openai-compatible-chat','offline','https://fixture.invalid','/chat','none','{}','1','1')").run()
    db.prepare("INSERT INTO provider_credential_refs (id,provider_id,label,encrypted_blob_key,status,created_at,updated_at) VALUES ('synthetic-ref','synthetic','offline','synthetic-blob','ready','1','1')").run()
    db.prepare("INSERT INTO provider_credential_secrets (encrypted_blob_key,encrypted_blob,created_at) VALUES ('synthetic-blob',?,'1')").run(Buffer.from([0, 1, 2, 255]))
    db.prepare("INSERT INTO provider_credential_versions (credential_ref_id,version,encrypted_blob,created_at) VALUES ('synthetic-ref',1,?,'1')").run(Buffer.from([255, 2, 1, 0]))
    const tables = ['sessions', 'runs', 'manuscript_segments', 'narrative_prefix_cache', 'provider_registry', 'provider_credential_refs', 'provider_credential_secrets', 'provider_credential_versions']
    const before = tables.map((table) => JSON.stringify(db!.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))
    const indexesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all().map((row) => row.name)
    db.close()
    db = openDb(dbPath)
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 31)
    assert.deepEqual(tables.map((table) => JSON.stringify(db!.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())), before)
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all().map((row) => row.name), [...indexesBefore, 'idx_manuscript_scene_tail_metadata'].sort())
    const index = db.prepare("PRAGMA index_list('manuscript_segments')").all().find((row) => row.name === 'idx_manuscript_scene_tail_metadata')!
    assert.equal(index.unique, 0)
    assert.deepEqual(db.prepare("PRAGMA index_info('idx_manuscript_scene_tail_metadata')").all().map((row) => row.name), ['run_id', 'scene_id', 'kind', 'chunk_index', 'revision', 'created_at', 'segment_id', 'status', 'content_hash', 'char_count'])
    const metadataColumns = 'segment_id,run_id,scene_id,status,content_hash,char_count,chunk_index,revision,created_at'
    const sceneWhere = "FROM manuscript_segments WHERE run_id=? AND scene_id=? AND kind='prose'"
    const validationQuery = `SELECT 1 AS invalid ${sceneWhere} AND status IN ('accepted','partial') AND (
      typeof(segment_id)<>'text' OR length(segment_id)=0 OR
      typeof(content_hash)<>'text' OR length(content_hash)<>64 OR content_hash GLOB '*[^0-9a-f]*' OR
      typeof(char_count)<>'integer' OR char_count<0 OR char_count>9007199254740991 OR
      typeof(chunk_index)<>'integer' OR chunk_index<0 OR chunk_index>9007199254740991 OR
      typeof(revision)<>'integer' OR revision<1 OR revision>9007199254740991 OR
      typeof(created_at) NOT IN ('integer','real') OR abs(created_at)>1.7976931348623157e308 OR
      (typeof(created_at)='integer' AND abs(created_at)>9007199254740991)
    ) LIMIT 1`
    for (const query of [validationQuery, `SELECT ${metadataColumns} ${sceneWhere} AND status='partial'`, `SELECT ${metadataColumns} ${sceneWhere} AND status IN ('accepted','partial') ORDER BY chunk_index DESC,revision DESC,created_at DESC,segment_id DESC`]) {
      const queryPlan: Array<{ detail?: unknown }> = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(runId, contract.sceneId)
      assert.ok(queryPlan.some((row) => String(row.detail).includes('COVERING INDEX idx_manuscript_scene_tail_metadata')), JSON.stringify(queryPlan))
      assert.ok(queryPlan.every((row) => !String(row.detail).includes('TEMP B-TREE')), JSON.stringify(queryPlan))
      console.log('R61_METADATA_QUERY_PLAN', JSON.stringify(queryPlan))
    }
    runMigrations(db)
    assert.deepEqual(tables.map((table) => JSON.stringify(db!.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())), before)
    const backup = new DatabaseSync(`${dbPath}.pre-v30.bak`)
    try { assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 30); assert.deepEqual(tables.map((table) => JSON.stringify(backup.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())), before) } finally { backup.close() }
  } finally { db?.close(); rmSync(root, { recursive: true, force: true }) }
})
