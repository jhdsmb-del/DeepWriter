import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SCHEMA_V1 } from './schema'
import { narrativeLedgerScopeFromConfig, storyLedgerRevisionHash, storyLedgerRevisionHashV2, storyLedgerTombstoneHash, storyLedgerTombstoneHashV2 } from '../narrative/storyLedger'

export type SqliteDb = DatabaseSync

// ==================== 版本化迁移（Gate 2 / P0-04） ====================
// 使用 PRAGMA user_version 作为唯一版本标记；每个迁移在事务内执行，失败回滚。
// 迁移只增不改：已发布的迁移不可修改，新变更必须追加新迁移。

const FK_TABLES: Array<{ name: string; ddl: string }> = [
  {
    name: 'runs',
    ddl: `CREATE TABLE runs_v2 (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'queued',
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      parent_run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
      error_code TEXT,
      error_message TEXT
    )`
  },
  {
    name: 'turns',
    ddl: `CREATE TABLE turns_v2 (
      turn_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      turn_seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      reasoning_content TEXT,
      tool_calls_json TEXT,
      tool_result_json TEXT,
      plan_state TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(run_id, turn_seq)
    )`
  },
  {
    name: 'toolcalls',
    ddl: `CREATE TABLE toolcalls_v2 (
      tool_call_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '{}',
      args_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested',
      result_json TEXT,
      started_at INTEGER,
      completed_at INTEGER
    )`
  },
  {
    name: 'artifacts',
    ddl: `CREATE TABLE artifacts_v2 (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      relative_path TEXT,
      hash TEXT,
      char_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'started',
      created_at INTEGER NOT NULL
    )`
  },
  {
    name: 'jobs',
    ddl: `CREATE TABLE jobs_v2 (
      job_id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
      state_json TEXT NOT NULL DEFAULT '{}',
      usage_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  },
  {
    name: 'usage_log',
    ddl: `CREATE TABLE usage_log_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
      call_type TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_hit INTEGER NOT NULL DEFAULT 0,
      cache_miss INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      pricing_version TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    )`
  },
  {
    name: 'attachments',
    ddl: `CREATE TABLE attachments_v2 (
      att_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT REFERENCES turns(turn_id) ON DELETE SET NULL,
      file_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      source_type TEXT NOT NULL DEFAULT '',
      content_ref TEXT,
      created_at INTEGER NOT NULL
    )`
  }
]

/** 各表主键列（v2 冲突预检用） */
const TABLE_PKS: Record<string, string> = {
  runs: 'run_id',
  turns: 'turn_id',
  toolcalls: 'tool_call_id',
  artifacts: 'artifact_id',
  jobs: 'job_id',
  usage_log: 'id',
  attachments: 'att_id'
}

/**
 * 迁移 v2：重建带外键与唯一约束的表。
 * 数据保全：不再用 OR IGNORE 静默丢行——重建前将主键重复行（保留 rowid 最小者）写入 quarantine；
 * FK 孤儿（旧数据无父行）在 v3 清扫；任何原始记录均可从 quarantine/备份恢复。
 */
function migrateV2ForeignKeys(db: SqliteDb): void {
  const now = Date.now()
  db.exec(`CREATE TABLE IF NOT EXISTS migration_quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    row_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    migrated_at INTEGER NOT NULL
  )`)
  const quarantine = (table: string, row: Record<string, unknown>, reason: string): void => {
    db.prepare('INSERT INTO migration_quarantine (table_name, row_json, reason, migrated_at) VALUES (?, ?, ?, ?)').run(table, JSON.stringify(row), reason, now)
  }
  for (const t of FK_TABLES) {
    // 旧表可能不存在（新库直接建 v2）
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t.name)
    if (!exists) {
      db.exec(t.ddl.replace(`_v2`, ''))
      continue
    }
    // 冲突预检：主键重复（保留 rowid 最小者，其余进 quarantine），不再静默 OR IGNORE
    const pk = TABLE_PKS[t.name]
    if (pk) {
      const dups = db.prepare(`SELECT t2.rowid AS rid, t2.* FROM ${t.name} t2 JOIN ${t.name} t1 ON t1.${pk} = t2.${pk} AND t1.rowid < t2.rowid`).all() as Array<Record<string, unknown> & { rid: number }>
      for (const d of dups) {
        const { rid, ...row } = d
        quarantine(t.name, row, 'duplicate primary key')
        db.prepare(`DELETE FROM ${t.name} WHERE rowid = ?`).run(rid)
      }
    }
    // turns 的 (run_id, turn_seq) 唯一约束冲突同样预检（v3 会再兜底清扫）
    if (t.name === 'turns') {
      const seqDups = db.prepare(`SELECT t2.rowid AS rid, t2.* FROM turns t2 JOIN turns t1 ON t1.run_id = t2.run_id AND t1.turn_seq = t2.turn_seq AND t1.rowid < t2.rowid`).all() as Array<Record<string, unknown> & { rid: number }>
      for (const d of seqDups) {
        const { rid, ...row } = d
        quarantine('turns', row, 'duplicate (run_id, turn_seq)')
        db.prepare('DELETE FROM turns WHERE rowid = ?').run(rid)
      }
    }
    db.exec(t.ddl)
    // 剩余数据（此时已无主键/唯一冲突）直接搬入；FK 孤儿允许进入（v3 清扫）
    db.exec(`INSERT INTO ${t.name}_v2 SELECT * FROM ${t.name}`)
    db.exec(`DROP TABLE ${t.name}`)
    db.exec(`ALTER TABLE ${t.name}_v2 RENAME TO ${t.name}`)
  }
  // 重建索引（原索引随 DROP 消失）
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_turns_run ON turns(run_id, turn_seq)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_toolcalls_run ON toolcalls(run_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_toolcalls_hash ON toolcalls(args_hash, status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_run ON usage_log(run_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id)')
}

const MIGRATIONS: Array<(db: SqliteDb) => void> = [
  (db) => {
    db.exec(SCHEMA_V1)
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1')
  },
  migrateV2ForeignKeys,
  migrateV3DataIntegrity,
  migrateV4DurableIdempotency,
  migrateV5Sessions,
  // v6（R4.1 / PERSIST-MIGRATE-01）：旧 JSONL 会话一次性导入。目录由 openDb 在跑迁移前注入
  // （migrations.ts 是纯 node，无 electron；db 与 sessions 同在 userData，从 dbPath 推导最稳）。
  (db) => migrateV6JsonlImport(db, jsonlSessionsDirForV6),
  // v7（R4.2 / A5+A4）：context manifest 与 recovery decision 持久化
  migrateV7ContextManifestAndRecovery,
  // v8（R4.3 / Gate 4）：CompletionController 的 durable 契约/评估/尝试
  migrateV8Completion,
  // v9（R4.4 / Gate 1）：run-scoped durable evidence（Ren'Py lint 等完成校验证据源）
  migrateV9RunEvidence,
  // v10（R4.5 / Gate 3）：CompletionEvaluation 精确恢复字段（repairAttempts/startedAt/
  // finding keys/delta）——JSON 内字段由 CompletionController.fromStore 按明确迁移规则处理
  // （旧格式：attempts 从零算、起点用 contract.createdAt，绝不静默猜；迁移后重写落库）。
  // 本迁移只推进 user_version 并建立一致性表（跨版本读取由 controller 运行时规则承担）。
  migrateV10CompletionStatePrecision,
  migrateV11WorkflowAndBilling,
  migrateV12ProviderRegistry,
  migrateV13CredentialVersions,
  migrateV14ContextOptimization,
  // v15（R4.6）：Grill Me 长文采访/大纲状态；按 session 持久化，跨重启恢复
  migrateV15GrillMe,
  migrateV16ManuscriptSegments,
  migrateV17ManuscriptBackfill,
  migrateV18SceneState,
  migrateV19NarrativeLedger,
  migrateV20ManuscriptAcceptanceAndSceneManifests,
  // v21（R61/P1-7）：versioned fact registry used by Grill Me and narrative knowledge edges
  migrateV21NarrativeFactRegistry,
  // v22（R61/P2-4）：accepted manuscript prefix 的 durable 增量快照。
  // 正文内容仍在 manuscript_segments 中作为唯一真源；本表只缓存可复算的
  // provenance chain 和游标。任意绕过 Repository 的 accepted 行变更都会先
  // 将 cache 标记 invalid，读取侧 fail-closed。
  migrateV22NarrativePrefixCache,
  // v23（v1.2.2）：story/project/branch 归属与跨 run revision ledger。
  migrateV23StoryLedgerScope,
  // v24：故事账本撤回以 append-only tombstone 表示；旧 revision/hash 永不改写。
  migrateV24StoryLedgerRetractions,
  // v25（v1.2.4）：故事账本节点改为 parent-bound hash chain；v1 节点在
  // 明确迁移中重算为 v2，绝不让旧 hash 与新 hash 静默混用。
  migrateV25StoryLedgerHashChain,
  // v26（P1-03）：撤回后的故事账本显式进入新的 validity epoch；首个
  // 新 epoch 节点以 rebase 标记，运行游标不再被撤回操作静默推进。
  migrateV26StoryLedgerValidityEpoch,
  // v27（v1.2.5 WP2）：SceneMemoryCard 与可重建 Recall projection。
  // 这些表只保存由 accepted prose/manifest/ledger/contract 验证后的投影，
  // 不反向改变任何 canonical 表。DDL 保持 additive + IF NOT EXISTS，便于
  // 空库、v25/v26 库和被中断后重跑的库幂等升级。
  migrateV27SceneMemoryProjection,
  // v28（v1.2.5 WP4）：working-set 的完整 SceneWorkingSet/manifest/message
  // 记录与 lineage/head fence。旧 v27 行没有可凭空恢复的 authority，保留
  // 为 legacy 形态，由 repository 读取侧显式标记。
  migrateV28SceneWorkingSetDurability,
  // v29（v1.2.5 WP4）：outer writer rounds are explicit immutable attempts.
  // The old scope/query UNIQUE rejected a second auditable Working Set at the
  // same story head.  Keep queryHash authoritative, but let the already
  // content-addressed working_set_id provide the attempt dimension.
  migrateV29SceneWorkingSetAttemptIdentity,
  migrateV30ComposerDrafts,
  // v31 (R61): read every continuation identity without scanning large prose
  // payload pages. Non-unique and metadata-only; canonical rows stay unchanged.
  migrateV31SceneTailMetadataIndex
]

/** Single source of truth for first-party migration assertions. */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS.length

function migrateV31SceneTailMetadataIndex(db: SqliteDb): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_manuscript_scene_tail_metadata
    ON manuscript_segments(run_id, scene_id, kind, chunk_index, revision,
      created_at, segment_id, status, content_hash, char_count)`)
}

function migrateV30ComposerDrafts(db: SqliteDb): void {
  // Unsent sessions have no canonical session row yet. Drafts cannot create
  // messages, runs or attachment capabilities by themselves.
  db.exec(`CREATE TABLE IF NOT EXISTS composer_drafts (
    session_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    byte_count INTEGER NOT NULL CHECK(byte_count >= 0),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    updated_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_composer_drafts_updated ON composer_drafts(updated_at DESC)')
}

function migrateV15GrillMe(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS grill_me_sessions (
    session_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_grill_me_updated ON grill_me_sessions(updated_at)')
}

function migrateV16ManuscriptSegments(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS manuscript_segments (
    segment_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    source_turn_id TEXT REFERENCES turns(turn_id) ON DELETE SET NULL,
    section_id TEXT,
    scene_id TEXT,
    chunk_index INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK(status IN ('candidate','accepted','rejected','superseded','partial')),
    kind TEXT NOT NULL CHECK(kind IN ('prose','meta','refusal','plan','critic','repair')),
    content TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL,
    char_count INTEGER NOT NULL DEFAULT 0,
    supersedes_segment_id TEXT REFERENCES manuscript_segments(segment_id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    accepted_at INTEGER,
    UNIQUE(run_id, chunk_index, revision)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_manuscript_segments_run_order ON manuscript_segments(run_id, chunk_index, revision)')
  db.exec("CREATE INDEX IF NOT EXISTS idx_manuscript_segments_accepted ON manuscript_segments(run_id, status, kind) WHERE status='accepted' AND kind='prose'")
}

function migrateV17ManuscriptBackfill(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS manuscript_backfills (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    status TEXT NOT NULL CHECK(status IN ('pending','in_progress','complete','unverified')),
    verification TEXT NOT NULL CHECK(verification IN ('artifact_exact','legacy_unverified','active_run','artifact_missing','source_mismatch')),
    source_turns_json TEXT NOT NULL,
    source_summary_hash TEXT NOT NULL,
    expected_source_count INTEGER NOT NULL CHECK(expected_source_count >= 0),
    expected_segment_count INTEGER NOT NULL CHECK(expected_segment_count >= 0),
    expected_accepted_char_count INTEGER NOT NULL CHECK(expected_accepted_char_count >= 0),
    expected_accepted_content_hash TEXT,
    expected_artifact_id TEXT,
    expected_artifact_hash TEXT,
    expected_artifact_char_count INTEGER,
    processed_source_turn_ids_json TEXT NOT NULL,
    accepted_segment_ids_json TEXT NOT NULL,
    completion_marker TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_manuscript_backfills_status ON manuscript_backfills(status, updated_at)')
}

/** P2：SceneContract 的 durable 身份与生命周期；字数只作预算信号。 */
function migrateV18SceneState(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scene_states (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    scene_id TEXT NOT NULL,
    section_id TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    contract_hash TEXT NOT NULL,
    scene_order INTEGER NOT NULL CHECK(scene_order >= 1),
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('planned','writing','candidate','accepted','committed')),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    candidate_segment_id TEXT,
    candidate_hash TEXT,
    accepted_segment_id TEXT,
    accepted_hash TEXT,
    completion_decision_json TEXT,
    completion_evidence_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    committed_at INTEGER,
    PRIMARY KEY(run_id, scene_id),
    UNIQUE(run_id, scene_order)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_scene_states_run_order ON scene_states(run_id, scene_order)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_scene_states_run_lifecycle ON scene_states(run_id, lifecycle)')
}

function migrateV19NarrativeLedger(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS narrative_commits (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    scene_id TEXT NOT NULL,
    accepted_segment_id TEXT NOT NULL,
    accepted_content_hash TEXT NOT NULL,
    contract_hash TEXT NOT NULL,
    delta_hash TEXT NOT NULL,
    delta_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    committed_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, scene_id),
    UNIQUE(run_id, accepted_segment_id, accepted_content_hash),
    FOREIGN KEY(run_id, scene_id) REFERENCES scene_states(run_id, scene_id) ON DELETE CASCADE
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS narrative_ledger (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    scene_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    change_revision INTEGER NOT NULL CHECK(change_revision >= 1),
    accepted_segment_id TEXT NOT NULL,
    accepted_content_hash TEXT NOT NULL,
    contract_hash TEXT NOT NULL,
    change_kind TEXT NOT NULL CHECK(change_kind IN ('timeline_event','character_state','object_state','relationship','knowledge','foreshadow')),
    entity_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    delta_hash TEXT NOT NULL,
    committed_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, change_id),
    UNIQUE(run_id, scene_id, change_revision, change_id),
    FOREIGN KEY(run_id, scene_id) REFERENCES narrative_commits(run_id, scene_id) ON DELETE CASCADE
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_narrative_commits_run_scene ON narrative_commits(run_id, scene_id, revision)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_narrative_ledger_run_scene ON narrative_ledger(run_id, scene_id, change_revision, change_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_narrative_ledger_kind ON narrative_ledger(run_id, change_kind, committed_at)')
}

/**
 * R57/P1: one accepted prose row per durable manuscript slot, plus an
 * immutable whole-scene commit manifest.  Existing databases can contain
 * duplicate accepted candidates because v16 only made revision unique.  The
 * migration keeps the deterministic winner (newest accepted revision/time,
 * then lexical id), marks the losers superseded, and records every decision
 * before installing the partial unique index.  No row is silently deleted.
 */
function migrateV20ManuscriptAcceptanceAndSceneManifests(db: SqliteDb): void {
  const now = Date.now()
  db.exec(`CREATE TABLE IF NOT EXISTS manuscript_scope_conflicts (
    conflict_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    scene_id TEXT,
    chunk_index INTEGER NOT NULL,
    winner_segment_id TEXT NOT NULL,
    loser_segment_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    migrated_at INTEGER NOT NULL
  )`)
  const duplicateScopes = db.prepare(`
    SELECT run_id, scene_id, chunk_index, COUNT(*) AS n
    FROM manuscript_segments
    WHERE status='accepted' AND kind='prose'
    GROUP BY run_id, COALESCE(scene_id, ''), chunk_index
    HAVING COUNT(*) > 1
  `).all() as Array<{ run_id: string; scene_id: string | null; chunk_index: number; n: number }>
  for (const scope of duplicateScopes) {
    const rows = db.prepare(`
      SELECT segment_id, accepted_at, revision, updated_at, created_at
      FROM manuscript_segments
      WHERE run_id = ? AND status='accepted' AND kind='prose' AND chunk_index = ?
        AND COALESCE(scene_id, '') = COALESCE(?, '')
      ORDER BY COALESCE(accepted_at, 0) DESC, revision DESC, updated_at DESC, created_at DESC, segment_id ASC
    `).all(scope.run_id, scope.chunk_index, scope.scene_id) as Array<{
      segment_id: string
      accepted_at: number | null
      revision: number
      updated_at: number
      created_at: number
    }>
    const winner = rows[0]
    if (!winner) throw new Error('manuscript_scope_migration_missing_winner')
    for (const loser of rows.slice(1)) {
      db.prepare(`INSERT INTO manuscript_scope_conflicts
        (run_id,scene_id,chunk_index,winner_segment_id,loser_segment_id,reason,migrated_at)
        VALUES (?,?,?,?,?,?,?)`).run(
        scope.run_id,
        scope.scene_id,
        scope.chunk_index,
        winner.segment_id,
        loser.segment_id,
        'duplicate accepted scope: deterministic winner retained; loser superseded',
        now
      )
      db.prepare("UPDATE manuscript_segments SET status='superseded', updated_at=? WHERE segment_id=? AND status='accepted'")
        .run(now, loser.segment_id)
    }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_manuscript_segments_accepted_scope
    ON manuscript_segments(run_id, COALESCE(scene_id, ''), chunk_index)
    WHERE status='accepted' AND kind='prose'`)
  db.exec(`CREATE TABLE IF NOT EXISTS scene_commit_manifests (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    scene_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    manifest_json TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, scene_id),
    FOREIGN KEY(run_id, scene_id) REFERENCES scene_states(run_id, scene_id) ON DELETE CASCADE
  )`)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_scene_commit_manifests_hash ON scene_commit_manifests(run_id, scene_id, manifest_hash)')
}

/**
 * Durable, append-only story facts.  Facts are session scoped so a later run
 * can read the confirmed Grill Me contract without copying prose history;
 * run_id is provenance only and is deliberately not a foreign key so deleting
 * a run cannot erase the user's story bible.  A new canonical answer is a new
 * version of the same fact_id and never mutates an earlier row.
 */
function migrateV21NarrativeFactRegistry(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS narrative_facts (
    fact_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    session_id TEXT NOT NULL,
    run_id TEXT,
    canonical_statement TEXT NOT NULL,
    canonical_hash TEXT NOT NULL,
    aliases_json TEXT NOT NULL,
    entities_json TEXT NOT NULL,
    source_slot_ids_json TEXT NOT NULL,
    sources_json TEXT NOT NULL,
    valid_from TEXT,
    valid_until TEXT,
    confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
    status TEXT NOT NULL CHECK(status IN ('active','superseded','retracted','pending_review')),
    visibility TEXT NOT NULL CHECK(visibility IN ('public','restricted','private')),
    knowers_json TEXT NOT NULL,
    provenance_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(fact_id, version),
    UNIQUE(fact_id, version, provenance_hash)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_narrative_facts_session ON narrative_facts(session_id, fact_id, version DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_narrative_facts_run ON narrative_facts(run_id, fact_id, version DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_narrative_facts_source_slot ON narrative_facts(session_id, status, fact_id, version DESC)')
}

/**
 * R61/P2-4: accepted prose 的增量 prefix cache。
 *
 * The cache is deliberately metadata-only: segment content/hash remains in
 * manuscript_segments and is validated on write/rebuild.  Triggers invalidate
 * the cache when a caller mutates accepted prose outside the Repository; a
 * stale cache is never silently served to a provider.
 */
function migrateV22NarrativePrefixCache(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS narrative_prefix_cache (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    state TEXT NOT NULL CHECK(state IN ('valid','invalid')),
    prefix_hash TEXT NOT NULL,
    accepted_char_count INTEGER NOT NULL CHECK(accepted_char_count >= 0),
    accepted_segment_count INTEGER NOT NULL CHECK(accepted_segment_count >= 0),
    last_chunk_index INTEGER,
    last_revision INTEGER,
    last_created_at INTEGER,
    last_segment_id TEXT,
    cache_revision INTEGER NOT NULL CHECK(cache_revision >= 0),
    updated_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_narrative_prefix_cache_state ON narrative_prefix_cache(state, updated_at)')
  db.exec(`CREATE TRIGGER IF NOT EXISTS narrative_prefix_cache_invalidate_insert
    AFTER INSERT ON manuscript_segments
    WHEN NEW.status = 'accepted' AND NEW.kind = 'prose'
    BEGIN
      UPDATE narrative_prefix_cache SET state='invalid', updated_at=strftime('%s','now')*1000 WHERE run_id=NEW.run_id;
    END`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS narrative_prefix_cache_invalidate_update
    AFTER UPDATE ON manuscript_segments
    WHEN (OLD.status = 'accepted' AND OLD.kind = 'prose') OR (NEW.status = 'accepted' AND NEW.kind = 'prose')
    BEGIN
      UPDATE narrative_prefix_cache SET state='invalid', updated_at=strftime('%s','now')*1000 WHERE run_id IN (OLD.run_id, NEW.run_id);
    END`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS narrative_prefix_cache_invalidate_delete
    AFTER DELETE ON manuscript_segments
    WHEN OLD.status = 'accepted' AND OLD.kind = 'prose'
    BEGIN
      UPDATE narrative_prefix_cache SET state='invalid', updated_at=strftime('%s','now')*1000 WHERE run_id=OLD.run_id;
    END`)
}

function migrateV23StoryLedgerScope(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS story_ledger_heads (
    story_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    parent_story_id TEXT,
    parent_project_id TEXT,
    parent_branch_id TEXT,
    parent_revision INTEGER NOT NULL DEFAULT 0 CHECK(parent_revision >= 0),
    high_watermark INTEGER NOT NULL DEFAULT 0 CHECK(high_watermark >= 0),
    head_hash TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(story_id, project_id, branch_id)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS story_ledger_runs (
    run_id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    parent_story_id TEXT,
    parent_project_id TEXT,
    parent_branch_id TEXT,
    parent_revision INTEGER NOT NULL CHECK(parent_revision >= 0),
    current_revision INTEGER NOT NULL CHECK(current_revision >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS story_ledger_revisions (
    story_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    parent_story_id TEXT,
    parent_project_id TEXT,
    parent_branch_id TEXT,
    parent_revision INTEGER NOT NULL CHECK(parent_revision >= 0),
    run_id TEXT,
    scene_id TEXT,
    accepted_segment_id TEXT NOT NULL,
    accepted_content_hash TEXT NOT NULL,
    contract_hash TEXT NOT NULL,
    delta_hash TEXT NOT NULL,
    delta_json TEXT NOT NULL,
    manifest_json TEXT,
    manifest_hash TEXT,
    revision_hash TEXT NOT NULL,
    committed_at INTEGER NOT NULL,
    PRIMARY KEY(story_id, project_id, branch_id, revision),
    UNIQUE(story_id, project_id, branch_id, run_id, scene_id)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_story_ledger_runs_scope ON story_ledger_runs(story_id, project_id, branch_id, current_revision)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_story_ledger_revisions_scope ON story_ledger_revisions(story_id, project_id, branch_id, revision)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_story_ledger_revisions_run ON story_ledger_revisions(run_id, committed_at)')

  const runs = db.prepare('SELECT run_id, session_id, config_json, started_at FROM runs ORDER BY started_at ASC, run_id ASC').all() as Array<{ run_id: string; session_id: string; config_json: string; started_at: number }>
  const scopeByRun = new Map<string, ReturnType<typeof narrativeLedgerScopeFromConfig>>()
  for (const run of runs) {
    let parsed: ReturnType<typeof narrativeLedgerScopeFromConfig>
    try {
      parsed = narrativeLedgerScopeFromConfig(run.session_id, run.config_json)
    } catch {
      parsed = narrativeLedgerScopeFromConfig(run.session_id, '{}')
    }
    scopeByRun.set(run.run_id, parsed)
    const scope = parsed.scope
    db.prepare(`INSERT OR IGNORE INTO story_ledger_heads (
      story_id, project_id, branch_id, parent_story_id, parent_project_id, parent_branch_id,
      parent_revision, high_watermark, head_hash, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      scope.storyId, scope.projectId, scope.branchId, null, null, parsed.parentBranchId,
      0, 0, null, run.started_at
    )
    db.prepare(`INSERT OR IGNORE INTO story_ledger_runs (
      run_id, story_id, project_id, branch_id, parent_story_id, parent_project_id, parent_branch_id,
      parent_revision, current_revision, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      run.run_id, scope.storyId, scope.projectId, scope.branchId, parsed.parentBranchId !== null ? scope.storyId : null, parsed.parentBranchId !== null ? scope.projectId : null,
      parsed.parentBranchId, 0, 0, run.started_at, run.started_at
    )
  }

  const oldCommits = db.prepare(`SELECT run_id, scene_id, accepted_segment_id, accepted_content_hash, contract_hash,
      delta_hash, delta_json, revision, committed_at
    FROM narrative_commits ORDER BY committed_at ASC, run_id ASC, scene_id ASC`).all() as Array<{
      run_id: string
      scene_id: string
      accepted_segment_id: string
      accepted_content_hash: string
      contract_hash: string
      delta_hash: string
      delta_json: string
      revision: number
      committed_at: number
    }>
  for (const commit of oldCommits) {
    const parsed = scopeByRun.get(commit.run_id)
    const run = db.prepare('SELECT session_id FROM runs WHERE run_id = ?').get(commit.run_id) as { session_id?: string } | undefined
    const fallback = parsed ?? narrativeLedgerScopeFromConfig(run?.session_id ?? commit.run_id, '{}')
    const scope = fallback.scope
    const head = db.prepare('SELECT high_watermark, head_hash FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as { high_watermark?: number; head_hash?: string | null } | undefined
    const parentRevision = Number(head?.high_watermark ?? 0)
    const revision = parentRevision + 1
    const manifest = db.prepare('SELECT manifest_json, manifest_hash FROM scene_commit_manifests WHERE run_id=? AND scene_id=?').get(commit.run_id, commit.scene_id) as { manifest_json?: string; manifest_hash?: string } | undefined
    const revisionHash = storyLedgerRevisionHash({ storyId: scope.storyId, projectId: scope.projectId, branchId: scope.branchId, revision, parentRevision, runId: commit.run_id, sceneId: commit.scene_id, deltaHash: commit.delta_hash, manifestHash: manifest?.manifest_hash ?? null })
    db.prepare(`INSERT OR IGNORE INTO story_ledger_revisions (
      story_id, project_id, branch_id, revision, parent_story_id, parent_project_id, parent_branch_id,
      parent_revision, run_id, scene_id, accepted_segment_id, accepted_content_hash, contract_hash,
      delta_hash, delta_json, manifest_json, manifest_hash, revision_hash, committed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      scope.storyId, scope.projectId, scope.branchId, revision, scope.storyId, scope.projectId, null,
      parentRevision, commit.run_id, commit.scene_id, commit.accepted_segment_id, commit.accepted_content_hash,
      commit.contract_hash, commit.delta_hash, commit.delta_json, manifest?.manifest_json ?? null,
      manifest?.manifest_hash ?? null, revisionHash, commit.committed_at
    )
    db.prepare('UPDATE story_ledger_heads SET high_watermark=?, head_hash=?, updated_at=? WHERE story_id=? AND project_id=? AND branch_id=?').run(revision, revisionHash, commit.committed_at, scope.storyId, scope.projectId, scope.branchId)
    db.prepare('UPDATE story_ledger_runs SET current_revision=?, updated_at=? WHERE run_id=?').run(revision, commit.committed_at, commit.run_id)
  }
  for (const run of runs) {
    const scope = scopeByRun.get(run.run_id)?.scope
    if (!scope) continue
    const head = db.prepare('SELECT high_watermark FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(scope.storyId, scope.projectId, scope.branchId) as { high_watermark?: number } | undefined
    const current = Number((db.prepare('SELECT current_revision FROM story_ledger_runs WHERE run_id=?').get(run.run_id) as { current_revision?: number } | undefined)?.current_revision ?? 0)
    if (current === 0 && Number(head?.high_watermark ?? 0) > 0) db.prepare('UPDATE story_ledger_runs SET parent_revision=?, current_revision=?, updated_at=? WHERE run_id=?').run(Number(head?.high_watermark ?? 0), Number(head?.high_watermark ?? 0), run.started_at, run.run_id)
  }
}

function migrateV24StoryLedgerRetractions(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS story_ledger_tombstones (
    story_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    parent_revision INTEGER NOT NULL CHECK(parent_revision >= 0),
    target_revision INTEGER NOT NULL CHECK(target_revision >= 1),
    target_revision_hash TEXT NOT NULL,
    target_run_id TEXT,
    target_scene_id TEXT,
    reason TEXT NOT NULL DEFAULT '',
    tombstone_hash TEXT NOT NULL,
    committed_at INTEGER NOT NULL,
    PRIMARY KEY(story_id, project_id, branch_id, revision),
    UNIQUE(story_id, project_id, branch_id, target_revision)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_story_ledger_tombstones_scope ON story_ledger_tombstones(story_id, project_id, branch_id, revision)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_story_ledger_tombstones_target ON story_ledger_tombstones(story_id, project_id, branch_id, target_revision)')
}

/**
 * v25: upgrade the story ledger from the original content hash to a strict
 * parent-bound node hash chain.  The v23/v24 tables deliberately remain
 * append-only, so this migration adds metadata columns and rewrites each
 * legacy node exactly once inside the migration transaction.  A corrupt or
 * incomplete legacy chain aborts the migration instead of being "repaired"
 * by guessing missing history.
 */
function migrateV25StoryLedgerHashChain(db: SqliteDb): void {
  const addColumnIfMissing = (table: string, column: string, ddl: string): void => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
    if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
  addColumnIfMissing('story_ledger_heads', 'hash_schema_version', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing('story_ledger_revisions', 'parent_hash', 'TEXT')
  addColumnIfMissing('story_ledger_revisions', 'node_type', "TEXT NOT NULL DEFAULT 'revision'")
  addColumnIfMissing('story_ledger_revisions', 'hash_schema_version', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing('story_ledger_tombstones', 'parent_hash', 'TEXT')
  addColumnIfMissing('story_ledger_tombstones', 'node_type', "TEXT NOT NULL DEFAULT 'retraction'")
  addColumnIfMissing('story_ledger_tombstones', 'hash_schema_version', 'INTEGER NOT NULL DEFAULT 1')

  type ScopeHead = {
    story_id: string
    project_id: string
    branch_id: string
    parent_branch_id: string | null
    parent_revision: number
    high_watermark: number
    head_hash: string | null
    hash_schema_version: number
  }
  type Revision = {
    story_id: string
    project_id: string
    branch_id: string
    revision: number
    parent_revision: number
    run_id: string | null
    scene_id: string | null
    delta_hash: string
    manifest_hash: string | null
    revision_hash: string
    parent_hash: string | null
    node_type: string
    hash_schema_version: number
  }
  type Tombstone = {
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
  }
  type LegacyNode = { kind: 'revision'; row: Revision } | { kind: 'retraction'; row: Tombstone }
  const key = (storyId: string, projectId: string, branchId: string): string => `${storyId}\u0000${projectId}\u0000${branchId}`
  const nodeKey = (scopeKey: string, revision: number): string => `${scopeKey}\u0000${revision}`
  const heads = new Map<string, ScopeHead>()
  for (const row of db.prepare('SELECT * FROM story_ledger_heads').all() as unknown as ScopeHead[]) {
    heads.set(key(row.story_id, row.project_id, row.branch_id), row)
  }
  const nodesByScope = new Map<string, LegacyNode[]>()
  const oldHashByNode = new Map<string, string>()
  const addNode = (scopeKey: string, node: LegacyNode, hash: string): void => {
    if (oldHashByNode.has(nodeKey(scopeKey, node.row.revision))) throw new Error('story_ledger_duplicate_node_revision')
    oldHashByNode.set(nodeKey(scopeKey, node.row.revision), hash)
    const list = nodesByScope.get(scopeKey) ?? []
    list.push(node)
    nodesByScope.set(scopeKey, list)
  }
  const revisionRows = db.prepare('SELECT * FROM story_ledger_revisions').all() as unknown as Revision[]
  for (const row of revisionRows) {
    if (row.hash_schema_version !== 1) throw new Error('story_ledger_hash_schema_mixed_during_migration')
    const scopeKey = key(row.story_id, row.project_id, row.branch_id)
    const legacyHash = storyLedgerRevisionHash({
      storyId: row.story_id,
      projectId: row.project_id,
      branchId: row.branch_id,
      revision: row.revision,
      parentRevision: row.parent_revision,
      runId: row.run_id,
      sceneId: row.scene_id,
      deltaHash: row.delta_hash,
      manifestHash: row.manifest_hash
    })
    if (row.revision_hash !== legacyHash) throw new Error('story_ledger_legacy_revision_hash_mismatch')
    addNode(scopeKey, { kind: 'revision', row }, legacyHash)
  }
  const tombstoneRows = db.prepare('SELECT * FROM story_ledger_tombstones').all() as unknown as Tombstone[]
  for (const row of tombstoneRows) {
    if (row.hash_schema_version !== 1) throw new Error('story_ledger_hash_schema_mixed_during_migration')
    const scopeKey = key(row.story_id, row.project_id, row.branch_id)
    const legacyHash = storyLedgerTombstoneHash({
      storyId: row.story_id,
      projectId: row.project_id,
      branchId: row.branch_id,
      revision: row.revision,
      parentRevision: row.parent_revision,
      targetRevision: row.target_revision,
      targetRevisionHash: row.target_revision_hash,
      targetRunId: row.target_run_id,
      targetSceneId: row.target_scene_id,
      reason: row.reason
    })
    if (row.tombstone_hash !== legacyHash) throw new Error('story_ledger_legacy_tombstone_hash_mismatch')
    addNode(scopeKey, { kind: 'retraction', row }, legacyHash)
  }
  for (const scopeKey of nodesByScope.keys()) {
    if (!heads.has(scopeKey)) throw new Error('story_ledger_head_missing_during_migration')
  }
  for (const head of heads.values()) {
    if (head.hash_schema_version !== 1) throw new Error('story_ledger_hash_schema_mixed_during_migration')
  }

  const newHashByNode = new Map<string, string>()
  const visiting = new Set<string>()
  const processed = new Set<string>()
  let migratedNodes = 0
  const migrateScope = (scopeKey: string): void => {
    if (processed.has(scopeKey)) return
    if (visiting.has(scopeKey)) throw new Error('story_ledger_branch_cycle_during_migration')
    const head = heads.get(scopeKey)
    if (!head) throw new Error('story_ledger_scope_missing_during_migration')
    visiting.add(scopeKey)
    const parentScopeKey = head.parent_branch_id === null
      ? null
      : key(head.story_id, head.project_id, head.parent_branch_id)
    if (parentScopeKey !== null && head.parent_revision > 0) migrateScope(parentScopeKey)
    const localNodes = [...(nodesByScope.get(scopeKey) ?? [])].sort((a, b) => a.row.revision - b.row.revision)
    const expectedStart = head.parent_branch_id !== null ? head.parent_revision + 1 : 1
    if (head.high_watermark < (head.parent_branch_id !== null ? head.parent_revision : 0)) throw new Error('story_ledger_head_watermark_invalid')
    const expectedLocalCount = head.high_watermark - (head.parent_branch_id !== null ? head.parent_revision : 0)
    if (localNodes.length !== expectedLocalCount) throw new Error('story_ledger_revision_gap_during_migration')
    let previousRevision = head.parent_branch_id !== null ? head.parent_revision : 0
    let previousLegacyHash: string | null = previousRevision > 0 && parentScopeKey !== null
      ? oldHashByNode.get(nodeKey(parentScopeKey, previousRevision)) ?? null
      : null
    let previousNewHash: string | null = previousRevision > 0 && parentScopeKey !== null
      ? newHashByNode.get(nodeKey(parentScopeKey, previousRevision)) ?? null
      : null
    if (previousRevision > 0 && (!previousLegacyHash || !previousNewHash)) throw new Error('story_ledger_parent_revision_missing_during_migration')
    for (const node of localNodes) {
      const row = node.row as Revision & Tombstone
      if (row.revision !== previousRevision + 1 || row.revision < expectedStart || row.revision > head.high_watermark) throw new Error('story_ledger_revision_gap_during_migration')
      if (row.parent_revision !== previousRevision) throw new Error('story_ledger_parent_revision_mismatch_during_migration')
      const scopeNodeKey = nodeKey(scopeKey, row.revision)
      if (node.kind === 'revision') {
        const nextHash = storyLedgerRevisionHashV2({
          storyId: row.story_id,
          projectId: row.project_id,
          branchId: row.branch_id,
          revision: row.revision,
          parentRevision: row.parent_revision,
          parentHash: previousNewHash,
          runId: row.run_id,
          sceneId: row.scene_id,
          deltaHash: row.delta_hash,
          manifestHash: row.manifest_hash,
          nodeType: 'revision',
          hashSchemaVersion: 2
        })
        db.prepare(`UPDATE story_ledger_revisions SET parent_hash=?, node_type='revision', hash_schema_version=2, revision_hash=?
          WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?`).run(
          previousNewHash, nextHash, row.story_id, row.project_id, row.branch_id, row.revision
        )
        newHashByNode.set(scopeNodeKey, nextHash)
        previousNewHash = nextHash
      } else {
        const targetKey = nodeKey(scopeKey, row.target_revision)
        const targetLegacyHash = oldHashByNode.get(targetKey)
        const targetNewHash = newHashByNode.get(targetKey)
        if (!targetLegacyHash || !targetNewHash || targetLegacyHash !== row.target_revision_hash) throw new Error('story_ledger_tombstone_target_mismatch_during_migration')
        const nextHash = storyLedgerTombstoneHashV2({
          storyId: row.story_id,
          projectId: row.project_id,
          branchId: row.branch_id,
          revision: row.revision,
          parentRevision: row.parent_revision,
          parentHash: previousNewHash,
          targetRevision: row.target_revision,
          targetRevisionHash: targetNewHash,
          targetRunId: row.target_run_id,
          targetSceneId: row.target_scene_id,
          reason: row.reason,
          nodeType: 'retraction',
          hashSchemaVersion: 2
        })
        db.prepare(`UPDATE story_ledger_tombstones SET parent_hash=?, node_type='retraction', hash_schema_version=2,
          target_revision_hash=?, tombstone_hash=? WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?`).run(
          previousNewHash, targetNewHash, nextHash, row.story_id, row.project_id, row.branch_id, row.revision
        )
        newHashByNode.set(scopeNodeKey, nextHash)
        previousNewHash = nextHash
      }
      previousRevision = row.revision
      previousLegacyHash = oldHashByNode.get(scopeNodeKey) ?? null
      if (!previousLegacyHash) throw new Error('story_ledger_node_missing_during_migration')
      migratedNodes += 1
    }
    const expectedHeadHash = head.high_watermark === 0
      ? null
      : newHashByNode.get(nodeKey(scopeKey, head.high_watermark)) ?? (parentScopeKey !== null ? newHashByNode.get(nodeKey(parentScopeKey, head.high_watermark)) ?? null : null)
    const expectedLegacyHeadHash = head.high_watermark === 0
      ? null
      : oldHashByNode.get(nodeKey(scopeKey, head.high_watermark)) ?? (parentScopeKey !== null ? oldHashByNode.get(nodeKey(parentScopeKey, head.high_watermark)) ?? null : null)
    if (head.head_hash !== expectedLegacyHeadHash) throw new Error('story_ledger_legacy_head_hash_mismatch')
    if (head.high_watermark > 0 && !expectedHeadHash) throw new Error('story_ledger_head_hash_missing_during_migration')
    db.prepare(`UPDATE story_ledger_heads SET hash_schema_version=2, head_hash=?
      WHERE story_id=? AND project_id=? AND branch_id=?`).run(expectedHeadHash, head.story_id, head.project_id, head.branch_id)
    processed.add(scopeKey)
    visiting.delete(scopeKey)
  }
  for (const scopeKey of heads.keys()) migrateScope(scopeKey)
  const migration = {
    fromHashSchemaVersion: 1,
    toHashSchemaVersion: 2,
    migratedNodes,
    migratedScopes: heads.size,
    strategy: 'rewrite_legacy_nodes_in_transaction',
    legacyRowsAreNotMixedWithV2: true,
    migratedAt: Date.now()
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('story_ledger_hash_migration', JSON.stringify(migration))
}

/**
 * v26 keeps the append-only hash chain intact while adding the semantic
 * validity boundary that the hash alone cannot express.  Epochs are derived
 * from tombstone order, including inherited parent nodes, rather than from
 * whatever cursor a run happened to store.  A cursor before a tombstone thus
 * remains in the old epoch and is rejected by the production repository until
 * the user explicitly starts a new safe branch.
 */
function migrateV26StoryLedgerValidityEpoch(db: SqliteDb): void {
  const addColumnIfMissing = (table: string, column: string, ddl: string): void => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
    if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
  addColumnIfMissing('story_ledger_heads', 'validity_epoch', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing('story_ledger_heads', 'parent_validity_epoch', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing('story_ledger_runs', 'validity_epoch', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing('story_ledger_runs', 'parent_validity_epoch', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing('story_ledger_revisions', 'validity_epoch', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing('story_ledger_revisions', 'rebase_parent_revision', 'INTEGER')
  addColumnIfMissing('story_ledger_revisions', 'rebase_parent_hash', 'TEXT')
  addColumnIfMissing('story_ledger_tombstones', 'validity_epoch', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing('story_ledger_tombstones', 'next_validity_epoch', 'INTEGER NOT NULL DEFAULT 2')

  type Head = {
    story_id: string
    project_id: string
    branch_id: string
    parent_branch_id: string | null
    parent_revision: number
    high_watermark: number
    hash_schema_version: number
  }
  type LocalNode = { kind: 'revision' | 'retraction'; revision: number }
  const scopeKey = (storyId: string, projectId: string, branchId: string): string => `${storyId}\u0000${projectId}\u0000${branchId}`
  const parseKey = (value: string): { storyId: string; projectId: string; branchId: string } => {
    const [storyId, projectId, branchId] = value.split('\u0000')
    return { storyId, projectId, branchId }
  }
  const heads = db.prepare('SELECT story_id, project_id, branch_id, parent_branch_id, parent_revision, high_watermark, hash_schema_version FROM story_ledger_heads').all() as unknown as Head[]
  const headByScope = new Map(heads.map((head) => [scopeKey(head.story_id, head.project_id, head.branch_id), head]))
  const localByScope = new Map<string, LocalNode[]>()
  for (const head of heads) {
    if (head.hash_schema_version !== 2 || !Number.isInteger(head.parent_revision) || head.parent_revision < 0 || !Number.isInteger(head.high_watermark) || head.high_watermark < 0 || (head.parent_branch_id === null && head.parent_revision !== 0) || (head.parent_branch_id !== null && head.parent_revision > head.high_watermark)) throw new Error('story_ledger_scope_corrupt_during_epoch_migration')
  }
  for (const row of db.prepare('SELECT story_id, project_id, branch_id, revision, node_type, hash_schema_version FROM story_ledger_revisions').all() as Array<{ story_id: string; project_id: string; branch_id: string; revision: number; node_type?: string; hash_schema_version?: number }>) {
    if (row.node_type !== 'revision' && row.node_type !== 'rebase') throw new Error('story_ledger_node_type_invalid_during_epoch_migration')
    if (row.hash_schema_version !== 2 || !Number.isInteger(row.revision) || row.revision < 1) throw new Error('story_ledger_hash_schema_invalid_during_epoch_migration')
    const key = scopeKey(row.story_id, row.project_id, row.branch_id)
    const list = localByScope.get(key) ?? []
    list.push({ kind: 'revision', revision: row.revision })
    localByScope.set(key, list)
  }
  for (const row of db.prepare('SELECT story_id, project_id, branch_id, revision, node_type, hash_schema_version FROM story_ledger_tombstones').all() as Array<{ story_id: string; project_id: string; branch_id: string; revision: number; node_type?: string; hash_schema_version?: number }>) {
    if (row.node_type !== 'retraction') throw new Error('story_ledger_node_type_invalid_during_epoch_migration')
    if (row.hash_schema_version !== 2 || !Number.isInteger(row.revision) || row.revision < 1) throw new Error('story_ledger_hash_schema_invalid_during_epoch_migration')
    const key = scopeKey(row.story_id, row.project_id, row.branch_id)
    const list = localByScope.get(key) ?? []
    list.push({ kind: 'retraction', revision: row.revision })
    localByScope.set(key, list)
  }
  for (const key of localByScope.keys()) {
    if (!headByScope.has(key)) throw new Error('story_ledger_head_missing_during_epoch_migration')
  }

  type EpochMap = { parentRevision: number; parentEpoch: number; postByRevision: Map<number, number>; endEpoch: number }
  const epochMaps = new Map<string, EpochMap>()
  const processing = new Set<string>()

  const epochAt = (key: string, revision: number): number => {
    const head = headByScope.get(key)
    if (!head) throw new Error('story_ledger_scope_missing_during_epoch_migration')
    if (!Number.isInteger(revision) || revision < 0 || revision > head.high_watermark) throw new Error('story_ledger_revision_unavailable_during_epoch_migration')
    if (!epochMaps.has(key)) migrateScope(key)
    const map = epochMaps.get(key)!
    if (head.parent_branch_id !== null && revision <= head.parent_revision) {
      const parentKey = scopeKey(head.story_id, head.project_id, head.parent_branch_id)
      return epochAt(parentKey, revision)
    }
    if (revision === 0 || revision === head.parent_revision) return map.parentEpoch
    const value = map.postByRevision.get(revision)
    if (value === undefined) throw new Error('story_ledger_revision_gap_during_epoch_migration')
    return value
  }

  const migrateScope = (key: string): void => {
    if (epochMaps.has(key)) return
    if (processing.has(key)) throw new Error('story_ledger_branch_cycle_during_epoch_migration')
    const head = headByScope.get(key)
    if (!head) throw new Error('story_ledger_scope_missing_during_epoch_migration')
    processing.add(key)
    try {
      let parentEpoch = 1
      if (head.parent_branch_id !== null && head.parent_revision > 0) {
        const parentKey = scopeKey(head.story_id, head.project_id, head.parent_branch_id)
        migrateScope(parentKey)
        parentEpoch = epochAt(parentKey, head.parent_revision)
      }
      const local = [...(localByScope.get(key) ?? [])].sort((a, b) => a.revision - b.revision || (a.kind === 'retraction' ? 1 : -1))
      const expectedCount = head.high_watermark - (head.parent_branch_id !== null ? head.parent_revision : 0)
      if (expectedCount < 0 || local.length !== expectedCount) throw new Error('story_ledger_revision_gap_during_epoch_migration')
      let previousRevision = head.parent_branch_id !== null ? head.parent_revision : 0
      let currentEpoch = parentEpoch
      const postByRevision = new Map<number, number>()
      for (const node of local) {
        if (node.revision !== previousRevision + 1) throw new Error('story_ledger_revision_gap_during_epoch_migration')
        const nodeEpoch = currentEpoch
        const ids = parseKey(key)
        if (node.kind === 'revision') {
          db.prepare(`UPDATE story_ledger_revisions SET validity_epoch=?, rebase_parent_revision=NULL, rebase_parent_hash=NULL
            WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?`).run(nodeEpoch, ids.storyId, ids.projectId, ids.branchId, node.revision)
        } else {
          db.prepare(`UPDATE story_ledger_tombstones SET validity_epoch=?, next_validity_epoch=?
            WHERE story_id=? AND project_id=? AND branch_id=? AND revision=?`).run(nodeEpoch, nodeEpoch + 1, ids.storyId, ids.projectId, ids.branchId, node.revision)
          currentEpoch = nodeEpoch + 1
        }
        postByRevision.set(node.revision, currentEpoch)
        previousRevision = node.revision
      }
      if (previousRevision !== head.high_watermark) throw new Error('story_ledger_head_watermark_mismatch_during_epoch_migration')
      epochMaps.set(key, { parentRevision: head.parent_revision, parentEpoch, postByRevision, endEpoch: currentEpoch })
      const ids = parseKey(key)
      db.prepare('UPDATE story_ledger_heads SET validity_epoch=?, parent_validity_epoch=? WHERE story_id=? AND project_id=? AND branch_id=?').run(currentEpoch, parentEpoch, ids.storyId, ids.projectId, ids.branchId)
      const runs = db.prepare('SELECT run_id, current_revision FROM story_ledger_runs WHERE story_id=? AND project_id=? AND branch_id=?').all(ids.storyId, ids.projectId, ids.branchId) as Array<{ run_id: string; current_revision: number }>
      for (const run of runs) {
        if (run.current_revision > head.high_watermark) throw new Error('story_ledger_run_cursor_invalid_during_epoch_migration')
        db.prepare('UPDATE story_ledger_runs SET validity_epoch=?, parent_validity_epoch=? WHERE run_id=?').run(epochAt(key, run.current_revision), parentEpoch, run.run_id)
      }
    } finally {
      processing.delete(key)
    }
  }

  for (const head of heads) migrateScope(scopeKey(head.story_id, head.project_id, head.branch_id))
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('story_ledger_validity_epoch_migration', JSON.stringify({ fromVersion: 25, toVersion: 26, migratedScopes: heads.length, migratedAt: Date.now() }))
}

/**
 * v27 / v1.2.5 WP2.  Scene memory is a rebuildable projection.  The
 * canonical prose, scene manifest, contract and story ledger remain in the
 * v16-v26 tables; this migration intentionally does not add a foreign key to
 * any one of them because a card can be rebuilt after a source row is
 * retracted.  Repository writes still perform the stronger source-bound
 * validation before a projection becomes visible.
 */
function migrateV27SceneMemoryProjection(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scene_memory_cards (
      card_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      status TEXT NOT NULL CHECK(status IN ('canonical','partial','pending_review','legacy_unverified')),
      visibility TEXT NOT NULL DEFAULT 'active' CHECK(visibility IN ('active','stale','retracted','legacy_unverified','pending')),
      story_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      validity_epoch INTEGER NOT NULL CHECK(validity_epoch >= 1),
      story_revision INTEGER NOT NULL CHECK(story_revision >= 1),
      run_id TEXT NOT NULL,
      scene_id TEXT NOT NULL,
      scene_order INTEGER NOT NULL CHECK(scene_order >= 1),
      contract_id TEXT NOT NULL,
      contract_hash TEXT NOT NULL,
      scene_content_hash TEXT NOT NULL,
      commit_manifest_hash TEXT NOT NULL,
      state_delta_hash TEXT NOT NULL,
      card_hash TEXT NOT NULL,
      card_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(story_id, project_id, branch_id, scene_id, story_revision, validity_epoch, commit_manifest_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_scene_memory_cards_visible
      ON scene_memory_cards(story_id, project_id, branch_id, validity_epoch, story_revision, visibility, scene_order);
    CREATE INDEX IF NOT EXISTS idx_scene_memory_cards_identity
      ON scene_memory_cards(story_id, project_id, branch_id, scene_id, story_revision, validity_epoch);
    CREATE INDEX IF NOT EXISTS idx_scene_memory_cards_run_scene
      ON scene_memory_cards(run_id, scene_id, visibility);
  `)

  // Test-only fault injection deliberately occurs after the first v27 table
  // has been created.  runMigrations wraps the whole migration in one SQLite
  // transaction, so R70 can prove a partial DDL failure leaves neither the
  // new table nor user_version behind.  The application never sets this env.
  if (process.env.DW_R70_INJECT_V27_FAILURE === '1') throw new Error('scene_memory_v27_injected_failure')

  db.exec(`

    CREATE TABLE IF NOT EXISTS scene_memory_card_spans (
      card_id TEXT NOT NULL REFERENCES scene_memory_cards(card_id) ON DELETE CASCADE,
      span_id TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      segment_hash TEXT NOT NULL,
      segment_revision INTEGER NOT NULL CHECK(segment_revision >= 1),
      manifest_hash TEXT NOT NULL,
      start_utf16 INTEGER NOT NULL CHECK(start_utf16 >= 0),
      end_utf16 INTEGER NOT NULL CHECK(end_utf16 > start_utf16),
      span_text TEXT NOT NULL,
      span_hash TEXT NOT NULL,
      PRIMARY KEY(card_id, span_id)
    );
    CREATE INDEX IF NOT EXISTS idx_scene_memory_card_spans_segment
      ON scene_memory_card_spans(segment_id, segment_hash, segment_revision, manifest_hash);

    CREATE TABLE IF NOT EXISTS scene_recall_entities (
      card_id TEXT NOT NULL REFERENCES scene_memory_cards(card_id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT,
      evidence_json TEXT NOT NULL,
      card_hash TEXT NOT NULL,
      PRIMARY KEY(card_id, entity_kind, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_scene_recall_entities_lookup
      ON scene_recall_entities(entity_id, entity_kind, card_id);

    CREATE TABLE IF NOT EXISTS scene_recall_threads (
      card_id TEXT NOT NULL REFERENCES scene_memory_cards(card_id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      summary TEXT,
      evidence_json TEXT NOT NULL,
      card_hash TEXT NOT NULL,
      PRIMARY KEY(card_id, thread_id)
    );
    CREATE INDEX IF NOT EXISTS idx_scene_recall_threads_lookup
      ON scene_recall_threads(thread_id, lifecycle, card_id);

    CREATE TABLE IF NOT EXISTS scene_recall_edges (
      card_id TEXT NOT NULL REFERENCES scene_memory_cards(card_id) ON DELETE CASCADE,
      from_character_id TEXT NOT NULL,
      to_character_id TEXT NOT NULL,
      dimension TEXT NOT NULL,
      from_value TEXT,
      to_value TEXT,
      evidence_json TEXT NOT NULL,
      card_hash TEXT NOT NULL,
      PRIMARY KEY(card_id, from_character_id, to_character_id, dimension)
    );
    CREATE INDEX IF NOT EXISTS idx_scene_recall_edges_lookup
      ON scene_recall_edges(from_character_id, to_character_id, dimension, card_id);

    CREATE TABLE IF NOT EXISTS scene_recall_terms (
      card_id TEXT NOT NULL REFERENCES scene_memory_cards(card_id) ON DELETE CASCADE,
      term_kind TEXT NOT NULL,
      term TEXT NOT NULL,
      normalized_term TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1 CHECK(weight >= 0),
      evidence_json TEXT NOT NULL,
      card_hash TEXT NOT NULL,
      PRIMARY KEY(card_id, term_kind, normalized_term, term)
    );
    CREATE INDEX IF NOT EXISTS idx_scene_recall_terms_lookup
      ON scene_recall_terms(normalized_term, term_kind, card_id);

    CREATE TABLE IF NOT EXISTS scene_recall_embeddings (
      card_id TEXT PRIMARY KEY REFERENCES scene_memory_cards(card_id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('ready','unavailable','stale')),
      version TEXT,
      model_id TEXT,
      dimensions INTEGER,
      vector_hash TEXT,
      vector_json TEXT,
      source_card_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scene_working_sets (
      working_set_id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      validity_epoch INTEGER NOT NULL CHECK(validity_epoch >= 1),
      story_revision INTEGER NOT NULL CHECK(story_revision >= 0),
      scene_id TEXT NOT NULL,
      query_hash TEXT NOT NULL,
      card_ids_json TEXT NOT NULL,
      omitted_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      working_set_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','stale','retracted')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(story_id, project_id, branch_id, scene_id, validity_epoch, story_revision, query_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_scene_working_sets_scope
      ON scene_working_sets(story_id, project_id, branch_id, validity_epoch, story_revision, status, updated_at);

    CREATE TABLE IF NOT EXISTS scene_recall_index_meta (
      story_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      validity_epoch INTEGER NOT NULL CHECK(validity_epoch >= 1),
      story_revision INTEGER NOT NULL CHECK(story_revision >= 0),
      index_version INTEGER NOT NULL CHECK(index_version >= 1),
      source_card_set_hash TEXT NOT NULL,
      index_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ready','stale','rebuilding','failed')),
      built_at INTEGER NOT NULL,
      PRIMARY KEY(story_id, project_id, branch_id, validity_epoch, story_revision)
    );

    CREATE TABLE IF NOT EXISTS longform_workflow_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      validity_epoch INTEGER NOT NULL CHECK(validity_epoch >= 1),
      story_revision INTEGER NOT NULL CHECK(story_revision >= 0),
      run_id TEXT NOT NULL,
      workflow_key TEXT NOT NULL,
      workflow_revision INTEGER NOT NULL CHECK(workflow_revision >= 0),
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(run_id, workflow_key, workflow_revision)
    );
    CREATE INDEX IF NOT EXISTS idx_longform_workflow_snapshots_scope
      ON longform_workflow_snapshots(story_id, project_id, branch_id, validity_epoch, story_revision, workflow_key, workflow_revision);

    -- A card is never visible while an asynchronous writer is between source
    -- commit and projection commit.  The outbox is append-only by commit key;
    -- Repository may drain it synchronously today and a future worker can
    -- safely resume it after a crash.
    CREATE TABLE IF NOT EXISTS scene_memory_card_outbox (
      outbox_id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      validity_epoch INTEGER NOT NULL CHECK(validity_epoch >= 1),
      story_revision INTEGER NOT NULL CHECK(story_revision >= 1),
      scene_id TEXT NOT NULL,
      commit_manifest_hash TEXT NOT NULL,
      card_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','published','rejected')),
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(story_id, project_id, branch_id, scene_id, story_revision, validity_epoch, commit_manifest_hash, card_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_scene_memory_card_outbox_status
      ON scene_memory_card_outbox(status, updated_at);

    CREATE TABLE IF NOT EXISTS scene_memory_backfills (
      backfill_id TEXT PRIMARY KEY,
      story_id TEXT,
      project_id TEXT,
      branch_id TEXT,
      -- Nullable while a legacy/unverified scan is being resumed.  A step
      -- which publishes a canonical projection must fill all three fields and
      -- the repository rechecks them against the card.
      validity_epoch INTEGER CHECK(validity_epoch IS NULL OR validity_epoch >= 1),
      story_revision INTEGER CHECK(story_revision IS NULL OR story_revision >= 0),
      scene_id TEXT,
      input_snapshot_hash TEXT NOT NULL,
      cursor TEXT,
      processed_ids_json TEXT NOT NULL,
      total_count INTEGER NOT NULL CHECK(total_count >= 0),
      processed_count INTEGER NOT NULL CHECK(processed_count >= 0 AND processed_count <= total_count),
      status TEXT NOT NULL CHECK(status IN ('pending','in_progress','paused','complete','failed','legacy_unverified')),
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_scene_memory_backfills_status
      ON scene_memory_backfills(status, updated_at);
  `)
}

/**
 * v28 (v1.2.5 WP4): durable SceneWorkingSet authority.
 *
 * v27 rows remain readable through the legacy projection shape.  New rows
 * carry the complete canonical record in `canonical_json`; nullable columns
 * are intentional so an interrupted/old database can be upgraded without
 * inventing run or lineage authority for historical rows.
 */
function migrateV28SceneWorkingSetDurability(db: SqliteDb): void {
  const addColumnIfMissing = (name: string, ddl: string): void => {
    const columns = db.prepare('PRAGMA table_info(scene_working_sets)').all() as Array<{ name?: string }>
    if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE scene_working_sets ADD COLUMN ${name} ${ddl}`)
  }
  addColumnIfMissing('schema_version', 'INTEGER')
  addColumnIfMissing('run_id', 'TEXT')
  addColumnIfMissing('branch_lineage_json', 'TEXT')
  addColumnIfMissing('branch_cutoffs_json', 'TEXT')
  addColumnIfMissing('canonical_json', 'TEXT')
  addColumnIfMissing('canonical_hash', 'TEXT')
  addColumnIfMissing('final_envelope_hash', 'TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_scene_working_sets_run ON scene_working_sets(run_id, status, updated_at)')
}

/** Replace the v27 scope/query UNIQUE with the explicit working_set_id
 * attempt dimension.  This is a transactional table rebuild so old rows and
 * nullable v28 authority columns are copied byte-for-byte. */
function migrateV29SceneWorkingSetAttemptIdentity(db: SqliteDb): void {
  db.exec('DROP INDEX IF EXISTS idx_scene_working_sets_scope')
  db.exec('DROP INDEX IF EXISTS idx_scene_working_sets_run')
  db.exec('ALTER TABLE scene_working_sets RENAME TO scene_working_sets_v29_old')
  db.exec(`CREATE TABLE scene_working_sets (
    working_set_id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    validity_epoch INTEGER NOT NULL CHECK(validity_epoch >= 1),
    story_revision INTEGER NOT NULL CHECK(story_revision >= 0),
    scene_id TEXT NOT NULL,
    query_hash TEXT NOT NULL,
    card_ids_json TEXT NOT NULL,
    omitted_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    working_set_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','stale','retracted')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    schema_version INTEGER,
    run_id TEXT,
    branch_lineage_json TEXT,
    branch_cutoffs_json TEXT,
    canonical_json TEXT,
    canonical_hash TEXT,
    final_envelope_hash TEXT
  )`)
  db.exec(`INSERT INTO scene_working_sets (
    working_set_id,story_id,project_id,branch_id,validity_epoch,story_revision,scene_id,query_hash,
    card_ids_json,omitted_json,payload_json,working_set_hash,status,created_at,updated_at,
    schema_version,run_id,branch_lineage_json,branch_cutoffs_json,canonical_json,canonical_hash,final_envelope_hash
  ) SELECT working_set_id,story_id,project_id,branch_id,validity_epoch,story_revision,scene_id,query_hash,
    card_ids_json,omitted_json,payload_json,working_set_hash,status,created_at,updated_at,
    schema_version,run_id,branch_lineage_json,branch_cutoffs_json,canonical_json,canonical_hash,final_envelope_hash
    FROM scene_working_sets_v29_old`)
  if (process.env.DW_R72_INJECT_V29_FAILURE === '1') throw new Error('scene_working_set_v29_injected_failure')
  db.exec('DROP TABLE scene_working_sets_v29_old')
  db.exec('CREATE INDEX IF NOT EXISTS idx_scene_working_sets_scope ON scene_working_sets(story_id, project_id, branch_id, validity_epoch, story_revision, status, updated_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_scene_working_sets_run ON scene_working_sets(run_id, status, updated_at)')
}

/** R45: additive preferences/pins/summary + append-only request manifests. */
function migrateV14ContextOptimization(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS context_preferences (
    scope_type TEXT NOT NULL CHECK(scope_type IN ('session')),
    scope_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('full','optimized','minimal')),
    policy_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 0),
    pin_revision INTEGER NOT NULL DEFAULT 0 CHECK(pin_revision >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(scope_type,scope_id)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS context_pins (
    pin_id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('session')),
    scope_id TEXT NOT NULL,
    pin_kind TEXT NOT NULL CHECK(pin_kind IN ('message','fact')),
    source_type TEXT,
    source_id TEXT,
    source_revision INTEGER,
    source_hash TEXT NOT NULL,
    fact_text TEXT,
    confirmation_scope TEXT,
    actor TEXT NOT NULL CHECK(actor='user'),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    status TEXT NOT NULL CHECK(status IN ('active','revoked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS context_summaries (
    summary_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    previous_summary_hash TEXT,
    source_high_watermark INTEGER NOT NULL,
    source_set_hash TEXT NOT NULL,
    summary_hash TEXT NOT NULL,
    generator TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('building','active','superseded','draft_unconfirmed','failed')),
    summary_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    activated_at TEXT,
    UNIQUE(session_id,version)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS context_manifests_v2 (
    manifest_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    stage_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    round_index INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('full','optimized','minimal')),
    manifest_json TEXT NOT NULL,
    envelope_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_context_pins_scope ON context_pins(scope_type,scope_id,status,created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_context_summaries_session ON context_summaries(session_id,status,version)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_context_manifests_run ON context_manifests_v2(run_id,created_at)')
  const attemptColumns = db.prepare('PRAGMA table_info(provider_call_attempts)').all() as Array<{ name: string }>
  if (!attemptColumns.some((column) => column.name === 'context_manifest_id')) db.exec('ALTER TABLE provider_call_attempts ADD COLUMN context_manifest_id TEXT')
  if (!attemptColumns.some((column) => column.name === 'context_mode')) db.exec('ALTER TABLE provider_call_attempts ADD COLUMN context_mode TEXT')
}

/**
 * R44 RETURN: credential replacement is append-only. A run stores (ref,version)
 * and can therefore resume with exactly the encrypted value accepted at start.
 * The v12 current-secret table remains as a compatibility mirror for non-run UI
 * operations; execution snapshots only resolve provider_credential_versions.
 */
function migrateV13CredentialVersions(db: SqliteDb): void {
  const columns = db.prepare('PRAGMA table_info(provider_credential_refs)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'current_version')) {
    db.exec('ALTER TABLE provider_credential_refs ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1')
  }
  db.exec(`CREATE TABLE IF NOT EXISTS provider_credential_versions (
    credential_ref_id TEXT NOT NULL REFERENCES provider_credential_refs(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL CHECK(version >= 1),
    encrypted_blob BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (credential_ref_id, version)
  )`)
  // Existing v12 credentials become immutable version 1. INSERT OR IGNORE keeps
  // this migration idempotent if a failed open is retried.
  db.exec(`INSERT OR IGNORE INTO provider_credential_versions (credential_ref_id,version,encrypted_blob,created_at)
    SELECT r.id,1,s.encrypted_blob,s.created_at
    FROM provider_credential_refs r
    JOIN provider_credential_secrets s ON s.encrypted_blob_key=r.encrypted_blob_key`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_provider_credential_versions_ref ON provider_credential_versions(credential_ref_id,version)')
}

function migrateV12ProviderRegistry(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS provider_registry (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('builtin','custom')),
    adapter_id TEXT NOT NULL CHECK(adapter_id IN ('builtin.deepseek','custom.openai-compatible-chat')),
    display_name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    chat_path TEXT NOT NULL,
    models_path TEXT,
    auth_style TEXT NOT NULL CHECK(auth_style IN ('bearer','none')),
    default_credential_ref_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    builtin_locked INTEGER NOT NULL DEFAULT 0,
    transport_policy_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS provider_credential_refs (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES provider_registry(id) ON DELETE RESTRICT,
    label TEXT NOT NULL,
    encrypted_blob_key TEXT NOT NULL UNIQUE,
    masked_hint TEXT,
    status TEXT NOT NULL CHECK(status IN ('ready','locked','invalid','missing')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS provider_credential_secrets (
    encrypted_blob_key TEXT PRIMARY KEY,
    encrypted_blob BLOB NOT NULL,
    created_at TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS provider_models (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES provider_registry(id) ON DELETE RESTRICT,
    remote_model_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('builtin','discovered','manual','imported')),
    enabled INTEGER NOT NULL DEFAULT 1,
    context_window INTEGER,
    max_output_tokens INTEGER,
    capabilities_json TEXT NOT NULL,
    pricing_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(provider_id,remote_model_id)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS provider_pricing (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES provider_registry(id) ON DELETE RESTRICT,
    remote_model_id TEXT NOT NULL,
    canonical_origin TEXT NOT NULL,
    currency TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'per_1m_tokens',
    pricing_tier TEXT NOT NULL DEFAULT 'standard',
    context_bucket TEXT NOT NULL DEFAULT 'default',
    input_per_million REAL,
    cached_input_per_million REAL,
    cache_write_per_million REAL,
    output_per_million REAL,
    reasoning_per_million REAL,
    reasoning_billing_rule TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('official_provider','user_supplied')),
    source_url TEXT,
    effective_at TEXT,
    retrieved_at TEXT NOT NULL,
    profile_hash TEXT NOT NULL,
    UNIQUE(provider_id,canonical_origin,remote_model_id,pricing_tier,context_bucket,effective_at)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider_id TEXT NOT NULL REFERENCES provider_registry(id) ON DELETE RESTRICT,
    model_id TEXT NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
    credential_ref_id TEXT REFERENCES provider_credential_refs(id) ON DELETE RESTRICT,
    generation_json TEXT NOT NULL,
    reasoning_json TEXT NOT NULL,
    compatibility_mapping_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS provider_registry_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS provider_probes (
    probe_id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES provider_registry(id) ON DELETE RESTRICT,
    model_id TEXT NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
    credential_ref_id TEXT REFERENCES provider_credential_refs(id) ON DELETE RESTRICT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('in_flight','supported','unsupported','inconclusive')),
    http_status INTEGER,
    usage_json TEXT NOT NULL DEFAULT '{}',
    cost_status TEXT NOT NULL DEFAULT 'unknown',
    cost_amount REAL,
    cost_currency TEXT
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_provider_credentials_provider ON provider_credential_refs(provider_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_provider_models_provider ON provider_models(provider_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_provider_profiles_provider ON provider_profiles(provider_id)')
  const attemptColumns = db.prepare('PRAGMA table_info(provider_call_attempts)').all() as Array<{ name: string }>
  if (!attemptColumns.some((column) => column.name === 'adapter_id')) db.exec('ALTER TABLE provider_call_attempts ADD COLUMN adapter_id TEXT')
  if (!attemptColumns.some((column) => column.name === 'profile_id')) db.exec('ALTER TABLE provider_call_attempts ADD COLUMN profile_id TEXT')
  if (!attemptColumns.some((column) => column.name === 'credential_ref_id')) db.exec('ALTER TABLE provider_call_attempts ADD COLUMN credential_ref_id TEXT')
  if (!attemptColumns.some((column) => column.name === 'applied_mappings_json')) db.exec("ALTER TABLE provider_call_attempts ADD COLUMN applied_mappings_json TEXT NOT NULL DEFAULT '[]'")
  if (!attemptColumns.some((column) => column.name === 'omitted_controls_json')) db.exec("ALTER TABLE provider_call_attempts ADD COLUMN omitted_controls_json TEXT NOT NULL DEFAULT '[]'")
}

function migrateV11WorkflowAndBilling(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS provider_call_attempts (
    attempt_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    logical_call_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL CHECK(attempt_no >= 1),
    stage_id TEXT,
    actor TEXT NOT NULL CHECK(actor IN ('writer','critic','editor')),
    subtype TEXT,
    provider_id TEXT NOT NULL,
    provider_endpoint_origin TEXT NOT NULL,
    model_id TEXT NOT NULL,
    provider_request_id TEXT,
    outcome TEXT NOT NULL DEFAULT 'in_flight' CHECK(outcome IN ('in_flight','success','http_error','transport_error','timeout','cancelled','interrupted')),
    http_status INTEGER,
    started_at INTEGER NOT NULL,
    first_token_at INTEGER,
    ended_at INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_hit_tokens INTEGER,
    cache_miss_tokens INTEGER,
    reasoning_tokens INTEGER,
    cost_status TEXT NOT NULL DEFAULT 'unknown' CHECK(cost_status IN ('actual','estimated','unknown')),
    cost_amount REAL,
    cost_currency TEXT,
    price_snapshot_id TEXT,
    row_revision INTEGER NOT NULL DEFAULT 1,
    UNIQUE(logical_call_id, attempt_no)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS run_billing_snapshots (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    finalized INTEGER NOT NULL DEFAULT 0,
    source_attempt_revision INTEGER NOT NULL DEFAULT 0,
    source_event_seq INTEGER NOT NULL DEFAULT -1,
    source_tool_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_events (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    event_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, seq)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_provider_attempts_run_started ON provider_call_attempts(run_id, started_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_provider_attempts_logical ON provider_call_attempts(logical_call_id, attempt_no)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_events_run_seq ON workflow_events(run_id, seq)')
}

/**
 * 迁移 v10（R4.5 / Gate 3）：Completion 恢复状态精确化的版本推进。
 * - evaluation 的新字段（repairAttempts/startedAt/previousFindingKeys/currentFindingKeys/
 *   latestMeasuredChars/lastDeltaChars）存于 json 列内，无 DDL 变化；
 * - 存量旧格式 evaluation 的迁移由 CompletionController.fromStore 运行时按明确规则执行
 *   （attempts=0、startedAt=contract.createdAt、keys 从 hardFailures 重算），迁移后同 revision
 *   重写落库——SQL 层不做 JSON 猜测性改写（fail-closed：规则集中在控制器单一实现）。
 * - 此处建索引：按 run 取最新评估的常规查询路径。
 */
function migrateV10CompletionStatePrecision(db: SqliteDb): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_completion_evaluations_run_rev ON completion_evaluations(run_id, revision)')
}

/**
 * 迁移 v9（R4.4 / Gate 1）：run-scoped durable evidence。
 * - run_evidence：kind 唯一（renpy_lint 等）；JSON 含 project/file hash——源码变化后 hash 不匹配即失效；
 * - 完成校验从同一 evidence source 读取（B-02：lint 结果必须作为 run-scoped durable evidence）。
 */
function migrateV9RunEvidence(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS run_evidence (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, kind)
  )`)
}

/**
 * 迁移 v8（R4.3 / Gate 4）：完成契约与评估的 durable 存储。
 * - completion_contracts：每 run 的完成契约（targetChars/requiredArtifacts/validators/预算）；
 * - completion_evaluations：每次评估（先落库再对外；revision 单调）；
 * - completion_attempts：续作尝试记录（单调性/上限审计）。
 */
function migrateV8Completion(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS completion_contracts (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, version)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS completion_evaluations (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, revision)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS completion_attempts (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, attempt)
  )`)
}

/**
 * 迁移 v7（R4.2 / A5-A4）：不可变 context manifest 与恢复决策的 durable 事件存储。
 * - context_manifests：每 run 每轮的上下文清单（引用 message IDs/asset hashes，不复制历史正文）；
 * - recovery_decisions：side_effect_unknown 工具的人工决策记录（决策/actor/时间/checkpoint）。
 * 两者均为 append-only 性质（manifest 按 round 唯一，decision 按 decision_id 唯一）。
 */
function migrateV7ContextManifestAndRecovery(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS context_manifests (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, round)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS recovery_decisions (
    decision_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    tool_call_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT,
    created_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_recovery_decisions_run ON recovery_decisions(run_id, created_at)')
}

/** openDb 在 runMigrations 前注入的旧 JSONL sessions 目录（v6 用；空则跳过导入） */
let jsonlSessionsDirForV6 = ''

/**
 * 迁移 v6（R4.1 / PERSIST-MIGRATE-01）：旧 JSONL 会话一次性导入 canonical SQLite。
 * - 只执行一次：meta 键 jsonl_migrated 已存在即跳过（幂等，二次 openDb 不再重复导入）；
 * - 数据源：sessions 目录下的 *.jsonl（事件流，文件名 = safeId(sessionId)）+ index.json（权威元数据）；
 * - 导入前把整个 sessions 目录复制为 sessions-jsonl-backup-<timestamp>（原文件只读不动，可随时恢复）；
 * - 失败抛错：runMigrations 外层事务回滚，本批次 DB 写入全部撤销；
 * - 损坏行宽容跳过（与旧 loadEvents 语义一致），meta 事件宽容读取标题（旧版本类型支持但无写入路径）。
 */
export function migrateV6JsonlImport(db: SqliteDb, sessionsDir: string): void {
  const JSONL_MIGRATED_KEY = 'jsonl_migrated'
  if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(JSONL_MIGRATED_KEY)) return

  const isDir = sessionsDir !== '' && fs.existsSync(sessionsDir) && fs.statSync(sessionsDir).isDirectory()
  const jsonlFiles = isDir
    ? fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl')).sort()
    : []
  const indexMetas = ((): Array<{ id: string; title?: string; createdAt?: number; updatedAt?: number; model?: string }> => {
    if (!isDir) return []
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'index.json'), 'utf-8'))
      return Array.isArray(raw) ? raw : []
    } catch {
      return [] // index.json 缺失/损坏：退化为文件名推断（title 用 '会话'）
    }
  })()

  // 备份：仅当确有 jsonl 内容时复制整个 sessions 目录（保留原文件不动，只读导入）
  let backupDir = ''
  if (isDir && jsonlFiles.length > 0) {
    backupDir = path.join(path.dirname(sessionsDir), `sessions-jsonl-backup-${Date.now()}`)
    fs.cpSync(sessionsDir, backupDir, { recursive: true })
  }

  // safeId 与 sessionStore.ts 一致（旧 JSONL 文件名 = safeId(id)，有损编码）
  const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_')
  const metaByFile = new Map(indexMetas.map((m) => [safeId(m.id), m]))

  const insertSession = db.prepare(
    'INSERT OR IGNORE INTO sessions (session_id, title, model, created_at, updated_at) VALUES (?,?,?,?,?)'
  )
  const insertMessage = db.prepare(
    `INSERT INTO session_messages (msg_id, session_id, seq, role, content, reasoning, status, usage_json, rounds, tool_names_json, plan, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(msg_id) DO UPDATE SET content=excluded.content, reasoning=excluded.reasoning, status=excluded.status, usage_json=excluded.usage_json, rounds=excluded.rounds, tool_names_json=excluded.tool_names_json, plan=excluded.plan`
  )

  let sessions = 0
  let messages = 0
  for (const file of jsonlFiles) {
    const fileId = file.replace(/\.jsonl$/, '')
    const meta = metaByFile.get(fileId)
    // index.json 的原始 id 优先（safeId 有损，文件名无法反推特殊字符 id）；否则用文件名（幂等编码）
    const sessionId = meta ? meta.id : fileId
    // 标题优先级：index.json（权威，renameSession 只写 index.json）> meta 事件标题 > '会话'
    let title = meta?.title ?? ''
    let createdAt = meta?.createdAt ?? Number.MAX_SAFE_INTEGER
    let updatedAt = meta?.updatedAt ?? 0
    let seq = 0
    let firstTs = createdAt
    let lastTs = updatedAt

    const lines = fs.readFileSync(path.join(sessionsDir, file), 'utf-8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      let ev: { ts?: number; type?: string; message?: Record<string, unknown>; title?: string }
      try {
        ev = JSON.parse(line)
      } catch {
        continue // 损坏行跳过（与旧 loadEvents 一致）
      }
      if (ev.type === 'meta') {
        // 旧版本类型支持 meta 事件（无写入路径），宽容读取标题；仅当 index.json 无标题时兜底
        if (!title && typeof ev.title === 'string' && ev.title) title = ev.title
        continue
      }
      if (ev.type !== 'message' || !ev.message || typeof ev.message.id !== 'string') continue
      const m = ev.message
      seq++
      const ts = typeof ev.ts === 'number' ? ev.ts : (typeof m.createdAt === 'number' ? m.createdAt : Date.now())
      if (ts < firstTs) firstTs = ts
      if (ts > lastTs) lastTs = ts
      insertMessage.run(
        String(m.id),
        sessionId,
        seq,
        typeof m.role === 'string' && (m.role === 'user' || m.role === 'assistant') ? m.role : 'user',
        typeof m.content === 'string' ? m.content : '',
        typeof m.reasoning === 'string' ? m.reasoning : '',
        typeof m.status === 'string' ? m.status : 'done',
        JSON.stringify(m.usage ?? null),
        typeof m.rounds === 'number' ? m.rounds : 0,
        JSON.stringify(Array.isArray(m.toolNames) ? m.toolNames : []),
        typeof m.plan === 'string' ? m.plan : null,
        ts
      )
      messages++
    }
    if (seq === 0) continue // 空文件/无有效消息：不建 sessions 行
    insertSession.run(
      sessionId,
      title || '会话',
      typeof meta?.model === 'string' ? meta.model : '',
      firstTs === Number.MAX_SAFE_INTEGER ? Date.now() : firstTs,
      lastTs === 0 ? Date.now() : lastTs
    )
    sessions++
  }

  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    JSONL_MIGRATED_KEY,
    JSON.stringify({ at: Date.now(), sessions, messages, backupDir })
  )
}

/**
 * 迁移 v5（R4.1 / B-04）：canonical session 持久化。
 * sessions + session_messages 成为会话唯一真相源；旧 JSONL 不再承担会话列表/加载。
 */
function migrateV5Sessions(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '新会话',
    model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS session_messages (
    msg_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    reasoning TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'done',
    usage_json TEXT NOT NULL DEFAULT 'null',
    rounds INTEGER NOT NULL DEFAULT 0,
    tool_names_json TEXT NOT NULL DEFAULT '[]',
    plan TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, seq)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id, seq)')
}

/**
 * 迁移 v4（R4-4 / B-08）：持久幂等键。
 * runs 增加 client_request_id；唯一索引 (session_id, client_request_id)——
 * 双击/重试/reload 重复提交同一请求 ID 时返回既有 run，不重复创建（跨重启成立）。
 * 旧 run 的 client_request_id 为 NULL，不受约束影响。
 */
function migrateV4DurableIdempotency(db: SqliteDb): void {
  const cols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'client_request_id')) {
    db.exec('ALTER TABLE runs ADD COLUMN client_request_id TEXT')
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency ON runs(session_id, client_request_id) WHERE client_request_id IS NOT NULL')
}

/**
 * 迁移 v3（A-05/B-09）：数据保全——冲突/孤儿行不再静默丢弃，
 * 全部进入 quarantine 表（保留完整原始字段），业务表通过完整性核对。
 */
function migrateV3DataIntegrity(db: SqliteDb): void {
  const now = Date.now()
  db.exec(`CREATE TABLE IF NOT EXISTS migration_quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    row_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    migrated_at INTEGER NOT NULL
  )`)

  const quarantine = (table: string, row: Record<string, unknown>, reason: string): void => {
    db.prepare('INSERT INTO migration_quarantine (table_name, row_json, reason, migrated_at) VALUES (?, ?, ?, ?)').run(table, JSON.stringify(row), reason, now)
  }

  // 1) turns：(run_id, turn_seq) 重复 → 保留 rowid 最小者，其余进 quarantine 后删除
  const dupTurns = db
    .prepare(
      `SELECT t2.rowid AS rid, t2.* FROM turns t2
       JOIN turns t1 ON t1.run_id = t2.run_id AND t1.turn_seq = t2.turn_seq AND t1.rowid < t2.rowid`
    )
    .all() as Array<Record<string, unknown> & { rid: number }>
  for (const t of dupTurns) {
    const { rid, ...row } = t
    quarantine('turns', row, 'duplicate (run_id, turn_seq)')
    db.prepare('DELETE FROM turns WHERE rowid = ?').run(rid)
  }

  // 2) 外键孤儿（旧数据违反新约束）：进 quarantine 后删除，业务表保持干净
  let orphanCount = 0
  const orphanChecks: Array<{ table: string; sql: string; reason: string }> = [
    { table: 'turns', sql: `SELECT t.rowid AS rid, t.* FROM turns t LEFT JOIN runs r ON r.run_id = t.run_id WHERE r.run_id IS NULL`, reason: 'orphan run_id' },
    { table: 'toolcalls', sql: `SELECT t.rowid AS rid, t.* FROM toolcalls t LEFT JOIN runs r ON r.run_id = t.run_id WHERE r.run_id IS NULL`, reason: 'orphan run_id' },
    { table: 'toolcalls', sql: `SELECT t.rowid AS rid, t.* FROM toolcalls t LEFT JOIN turns tn ON tn.turn_id = t.turn_id WHERE tn.turn_id IS NULL`, reason: 'orphan turn_id' },
    { table: 'artifacts', sql: `SELECT t.rowid AS rid, t.* FROM artifacts t LEFT JOIN runs r ON r.run_id = t.run_id WHERE r.run_id IS NULL`, reason: 'orphan run_id' },
    { table: 'jobs', sql: `SELECT t.rowid AS rid, t.* FROM jobs t LEFT JOIN runs r ON r.run_id = t.run_id WHERE t.run_id IS NOT NULL AND r.run_id IS NULL`, reason: 'orphan run_id' },
    { table: 'usage_log', sql: `SELECT t.rowid AS rid, t.* FROM usage_log t LEFT JOIN runs r ON r.run_id = t.run_id WHERE t.run_id IS NOT NULL AND r.run_id IS NULL`, reason: 'orphan run_id' },
    { table: 'attachments', sql: `SELECT t.rowid AS rid, t.* FROM attachments t LEFT JOIN turns tn ON tn.turn_id = t.turn_id WHERE t.turn_id IS NOT NULL AND tn.turn_id IS NULL`, reason: 'orphan turn_id' }
  ]
  for (const c of orphanChecks) {
    const rows = db.prepare(c.sql).all() as Array<Record<string, unknown> & { rid: number }>
    orphanCount += rows.length
    for (const r of rows) {
      const { rid, ...row } = r
      quarantine(c.table, row, c.reason)
      db.prepare(`DELETE FROM ${c.table} WHERE rowid = ?`).run(rid)
    }
  }

  // 3) 完整性核对（结果写入 meta 供审计/机器读取）；失败必须 throw 触发事务回滚（DB-02）
  const fkIssues = db.prepare('PRAGMA foreign_key_check').all()
  const integrity = db.prepare('PRAGMA integrity_check').all()
  const fkOk = Array.isArray(fkIssues) && fkIssues.length === 0
  const integOk = Array.isArray(integrity) && integrity.every((r: unknown) => String((r as { integrity_check: string }).integrity_check ?? r) === 'ok')
  if (!fkOk || !integOk) {
    throw new Error(`数据库完整性核对失败（foreign_key_check=${fkOk}，integrity_check=${integOk}）；迁移已回滚，版本保持不变`)
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'migration_v3_report',
    JSON.stringify({ quarantinedTotal: dupTurns.length + orphanCount, duplicateTurns: dupTurns.length, orphanRows: orphanCount, foreignKeyCheckOk: fkOk, integrityCheckOk: integOk, at: now })
  )
}

export function openDb(dbPath: string): SqliteDb {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    backupBeforeMigration(db, dbPath)
    // v6 需要旧 JSONL sessions 目录：优先环境变量覆盖，默认与 db 同目录（db 与 sessions 同在 userData）
    jsonlSessionsDirForV6 = process.env.DW_JSONL_SESSIONS_DIR || path.join(path.dirname(dbPath), 'sessions')
    runMigrations(db)
    return db
  } catch (e) {
    // R4-3：失败必须关闭 handle 并抛出（"数据库需要恢复"状态由调用方处理），绝不静默建新库
    try {
      db.close()
    } catch {
      /* 已关闭 */
    }
    throw e
  }
}

/**
 * 迁移前自动备份（R4-3 fail closed）：
 * - 仅当有业务数据且存在未执行迁移时执行（新空库直接迁移）；
 * - 固定名 `.pre-vN.bak`，每次迁移前删除旧备份重新生成（防陈旧副本被误当当前备份）；
 * - VACUUM INTO 失败直接抛错 → openDb 拒绝继续（绝不 warn 后继续破坏性迁移）；
 * - 生成后校验备份文件存在且可读。
 */
function backupBeforeMigration(db: SqliteDb, dbPath: string): void {
  const hasData = ((): boolean => {
    try {
      // Do not use runs/turns as a proxy for user data.  v26 changes the
      // story_ledger_* tables, and a valid legacy database may contain only
      // those rows (for example after an imported ledger is detached from a
      // run).  Count every first-party table except migration metadata;
      // sqlite_* internals and the schema marker do not make an empty DB
      // deserving of a backup.
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'meta'").all() as Array<{ name?: string }>
      for (const entry of tables) {
        if (typeof entry.name !== 'string' || entry.name.length === 0) continue
        const identifier = `"${entry.name.replace(/"/g, '""')}"`
        const row = db.prepare(`SELECT 1 AS present FROM ${identifier} LIMIT 1`).get()
        if (row) return true
      }
      return false
    } catch {
      return false
    }
  })()
  if (!hasData) return // 空库/新库无需备份
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (row.user_version >= MIGRATIONS.length) return
  const backupPath = `${dbPath}.pre-v${row.user_version}.bak`
  try {
    fs.unlinkSync(backupPath) // 删除陈旧备份，重新生成
  } catch {
    /* 不存在 */
  }
  // 失败直接抛错（fail closed）：有数据的库不允许在无备份的情况下被破坏性迁移
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
  const st = fs.statSync(backupPath)
  if (!st.isFile() || st.size === 0) throw new Error(`迁移前备份生成后校验失败：${backupPath}`)
  try {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('migration_backup', JSON.stringify({ path: backupPath, fromVersion: row.user_version, at: Date.now() }))
  } catch {
    /* meta 未就绪（v1 前），备份文件已生成 */
  }
}

export function runMigrations(db: SqliteDb, targetVersion = MIGRATIONS.length): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  let v = row.user_version
  const target = Math.max(0, Math.min(MIGRATIONS.length, Math.trunc(targetVersion)))
  while (v < target) {
    // PRAGMA foreign_keys 在事务内不生效：必须在 BEGIN 之前关闭、COMMIT 之后恢复
    // （重建表期间允许旧孤儿数据搬入，迁移后新写入受外键约束）
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN')
    try {
      MIGRATIONS[v](db)
      v++
      db.exec(`PRAGMA user_version = ${v}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }
  }
}

export function closeDb(db: SqliteDb): void {
  try {
    db.close()
  } catch {
    /* already closed */
  }
}
