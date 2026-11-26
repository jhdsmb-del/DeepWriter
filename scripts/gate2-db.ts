// ==================== Gate 2：DB 迁移与约束（外键/唯一/版本化迁移） ====================
// 运行：npx esbuild scripts/gate2-db.ts --bundle --format=esm --platform=node --outfile=out/gate2.mjs && node out/gate2.mjs

import * as path from 'node:path'
import * as url from 'node:url'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(__dirname, '..', rel)
  const outfile = path.resolve(__dirname, '..', 'out', `g2mod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({ entryPoints: [abs], bundle: true, format: 'esm', platform: 'node', target: 'node22', write: true, outfile, external: ['node:sqlite'], logLevel: 'silent' })
    return (await import(url.pathToFileURL(outfile).href)) as Record<string, unknown>
  } finally {
    try {
      await fsp.unlink(outfile)
    } catch {
      /* ignore */
    }
  }
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-g2-'))
  const migrations = await loadTsModule('src/main/db/migrations.ts')
  const openDb = migrations.openDb as (p: string) => import('node:sqlite').DatabaseSync
  const currentSchemaVersion = migrations.CURRENT_SCHEMA_VERSION as number
  const SCHEMA_V1 = (await loadTsModule('src/main/db/schema.ts')).SCHEMA_V1 as string

  console.log('\n[G2-1] 新库：迁移到最新版本 + 外键生效')
  const db = openDb(path.join(tmp, 'fresh.db'))
  const ver = db.prepare('PRAGMA user_version').get() as { user_version: number }
  check(`新库 user_version=${currentSchemaVersion}（当前迁移版本）`, ver.user_version === currentSchemaVersion, `user_version=${ver.user_version}`)
  // 外键：插入不存在 run 的 turn 应被拒绝
  let fkRejected = false
  try {
    db.prepare("INSERT INTO turns (turn_id, run_id, turn_seq, role, content, created_at) VALUES ('t1','no-such-run',1,'assistant','x',0)").run()
  } catch {
    fkRejected = true
  }
  check('孤儿 turn（run 不存在）被外键拒绝', fkRejected)
  // 外键正常路径
  db.prepare("INSERT INTO runs (run_id, session_id, status, phase, started_at, updated_at) VALUES ('r1','s1','completed','completed',0,0)").run()
  db.prepare("INSERT INTO turns (turn_id, run_id, turn_seq, role, content, created_at) VALUES ('t1','r1',1,'assistant','x',0)").run()
  check('合法 turn 插入成功', true)
  // 唯一约束：同 run_id+turn_seq 重复
  let dupRejected = false
  try {
    db.prepare("INSERT INTO turns (turn_id, run_id, turn_seq, role, content, created_at) VALUES ('t2','r1',1,'assistant','y',0)").run()
  } catch {
    dupRejected = true
  }
  check('同 run 同 turn_seq 重复被唯一约束拒绝', dupRejected)
  db.close()

  console.log('\n[G2-2] 旧库（v1 无外键 + 脏数据）：迁移到 v3，孤儿/重复进 quarantine，业务表干净')
  // 模拟旧库：v1 schema + user_version=1 + 脏数据（孤儿 turn、重复 turn、孤儿 toolcall）
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const legacy = new DatabaseSync(path.join(tmp, 'legacy.db'))
  legacy.exec('PRAGMA journal_mode = WAL')
  legacy.exec('PRAGMA foreign_keys = ON')
  legacy.exec(SCHEMA_V1)
  legacy.exec('PRAGMA user_version = 1')
  legacy.prepare("INSERT INTO runs (run_id, session_id, status, phase, started_at, updated_at) VALUES ('r-old','s-old','completed','completed',1,1)").run()
  legacy.prepare("INSERT INTO turns (turn_id, run_id, turn_seq, role, content, created_at) VALUES ('t-old','r-old',1,'assistant','旧内容',1)").run()
  legacy.prepare("INSERT INTO turns (turn_id, run_id, turn_seq, role, content, created_at) VALUES ('t-orphan','no-such-run',1,'assistant','孤儿',1)").run()
  legacy.prepare("INSERT INTO turns (turn_id, run_id, turn_seq, role, content, created_at) VALUES ('t-dup','r-old',1,'assistant','重复副本',1)").run()
  legacy.prepare("INSERT INTO toolcalls (tool_call_id, turn_id, run_id, name, args_json, args_hash, status) VALUES ('tc-orphan','t-old','no-such-run','read_file','{}','h','requested')").run()
  legacy.close()

  // 迁移（v2 重建 + v3 保全）
  const legacy2 = openDb(path.join(tmp, 'legacy.db'))
  const ver2 = legacy2.prepare('PRAGMA user_version').get() as { user_version: number }
  check(`旧库迁移后 user_version=${currentSchemaVersion}`, ver2.user_version === currentSchemaVersion, `user_version=${ver2.user_version}`)
  const turn = legacy2.prepare("SELECT content FROM turns WHERE turn_id = 't-old'").get() as { content: string } | undefined
  check('合法旧数据保留（r-old/t-old）', turn?.content === '旧内容', JSON.stringify(turn))
  // 孤儿与重复不再留在业务表
  const orphan = legacy2.prepare("SELECT content FROM turns WHERE turn_id = 't-orphan'").get() as { content: string } | undefined
  check('孤儿 turn 移出业务表', orphan === undefined)
  const dup = legacy2.prepare("SELECT content FROM turns WHERE turn_id = 't-dup'").get() as { content: string } | undefined
  check('重复 turn（同 run 同 seq）移出业务表', dup === undefined)
  const tcOrphan = legacy2.prepare("SELECT tool_call_id FROM toolcalls WHERE tool_call_id = 'tc-orphan'").get()
  check('孤儿 toolcall 移出业务表', tcOrphan === undefined)
  // quarantine 保留完整原始记录
  const q = legacy2.prepare('SELECT table_name, row_json, reason FROM migration_quarantine').all() as Array<{ table_name: string; row_json: string; reason: string }>
  check('quarantine 含孤儿 turn（完整 JSON 可恢复）', q.some((r) => r.table_name === 'turns' && r.row_json.includes('t-orphan') && r.row_json.includes('孤儿')), JSON.stringify(q))
  check('quarantine 含重复 turn', q.some((r) => r.table_name === 'turns' && r.row_json.includes('t-dup')), JSON.stringify(q))
  check('quarantine 含孤儿 toolcall', q.some((r) => r.table_name === 'toolcalls' && r.row_json.includes('tc-orphan')), JSON.stringify(q))
  // 完整性核对通过
  const v3 = legacy2.prepare("SELECT value FROM meta WHERE key='migration_v3_report'").get() as { value: string } | undefined
  const report = v3 ? (JSON.parse(v3.value) as { foreignKeyCheckOk: boolean; integrityCheckOk: boolean; quarantinedTotal: number }) : null
  check('v3 报告存在且 foreign_key_check 通过', report !== null && report.foreignKeyCheckOk === true, JSON.stringify(report))
  check('v3 报告 integrity_check 通过', report !== null && report.integrityCheckOk === true, JSON.stringify(report))
  check('v3 阶段 quarantine 计数（孤儿 2 条）', report !== null && report.quarantinedTotal === 2, JSON.stringify(report))
  const qTotal = legacy2.prepare('SELECT COUNT(*) AS n FROM migration_quarantine').get() as { n: number }
  check('quarantine 总行数 3（v2 重复 1 + v3 孤儿 2，全部可恢复）', qTotal.n === 3, `n=${qTotal.n}`)
  // 迁移后外键生效
  let fk2 = false
  try {
    legacy2.prepare("INSERT INTO turns (turn_id, run_id, turn_seq, role, content, created_at) VALUES ('t-new-orphan','no-run',1,'assistant','x',1)").run()
  } catch {
    fk2 = true
  }
  check('迁移后新孤儿写入被拒', fk2)
  legacy2.close()

  console.log('\n[G2-3] 幂等 + 迁移前备份')
  const db3 = openDb(path.join(tmp, 'fresh.db'))
  const ver3 = db3.prepare('PRAGMA user_version').get() as { user_version: number }
  check(`重复打开 user_version 仍=${currentSchemaVersion}（幂等）`, ver3.user_version === currentSchemaVersion)
  db3.close()
  const bak = legacy2 ? null : null
  void bak
  check('迁移前备份文件存在（.pre-v1.bak）', fs.existsSync(path.join(tmp, 'legacy.db.pre-v1.bak')), '')

  console.log('\n[G2-4] v4 持久幂等键（R4-4）：client_request_id 唯一 + 查询既有 run')
  const repo = await loadTsModule('src/main/db/repository.ts')
  const createRepository = repo.createRepository as (p: string) => {
    open(): void
    createRun(r: Record<string, unknown>): void
    findRunByClientRequestId(s: string, c: string): { run_id: string; status: string } | null
    close(): void
  }
  const rp = createRepository(path.join(tmp, 'idem.db'))
  rp.open()
  try {
    rp.createRun({ run_id: 'run-1', session_id: 'sess-1', status: 'running', phase: 'queued', started_at: 1, updated_at: 1, config_json: '{}', parent_run_id: null, error_code: null, error_message: null, client_request_id: 'req-abc' })
    const found = rp.findRunByClientRequestId('sess-1', 'req-abc')
    check('v4 findRunByClientRequestId 命中既有 run', found !== null && found.run_id === 'run-1', JSON.stringify(found))
    check('v4 跨 session 查不到', rp.findRunByClientRequestId('sess-other', 'req-abc') === null)
    // 重复创建同 (session, clientRequestId) 应被唯一索引拒绝（不产生第二个 run）
    let dupRejected = false
    try {
      rp.createRun({ run_id: 'run-2', session_id: 'sess-1', status: 'running', phase: 'queued', started_at: 2, updated_at: 2, config_json: '{}', parent_run_id: null, error_code: null, error_message: null, client_request_id: 'req-abc' })
    } catch {
      dupRejected = true
    }
    check('v4 同 (session, clientRequestId) 重复创建被唯一约束拒绝', dupRejected, dupRejected ? '' : '未拒绝（INSERT OR REPLACE 覆盖）')
  } finally {
    rp.close()
  }

  console.log('\n[G2-5] deleteSession 级联删除（R15 红灯测试）：直属 jobs/attachments + runs 级联对象 + 失败回滚')
  const rp2 = createRepository(path.join(tmp, 'cascade.db'))
  rp2.open()
  const db5 = openDb(path.join(tmp, 'cascade.db')) // 同一库的裸句柄（断言用）
  try {
    const seed = (sid: string): void => {
      rp2.createSession(sid, '测试会话', 'deepseek-v4-flash')
      rp2.appendSessionMessage({ msg_id: 'm-' + sid, session_id: sid, seq: 1, role: 'user', content: 'hi', created_at: 1 })
      rp2.saveJob('j-' + sid, 'novel', sid, null, '{}', '{}')
      rp2.saveAttachment({ att_id: 'a-' + sid, session_id: sid, turn_id: null, file_hash: 'h1', display_name: 'f.txt', size: 10, source_type: 'file', content_ref: null, created_at: 1 })
      rp2.createRun({ run_id: 'r-' + sid, session_id: sid, status: 'completed', phase: 'completed', started_at: 1, updated_at: 1, config_json: '{}', parent_run_id: null, error_code: null, error_message: null, client_request_id: null })
      rp2.appendTurn({ turn_id: 't-' + sid, run_id: 'r-' + sid, turn_seq: 1, role: 'assistant', content: 'x', reasoning_content: null, tool_calls_json: null, tool_result_json: null, plan_state: null, created_at: 1 })
      rp2.upsertToolCall({ tool_call_id: 'tc-' + sid, turn_id: 't-' + sid, run_id: 'r-' + sid, name: 'mock_tool', args_json: '{}', args_hash: 'h', status: 'success', result_json: '{}', started_at: 1, completed_at: 1 })
      rp2.saveArtifact({ artifact_id: 'art-' + sid, run_id: 'r-' + sid, session_id: sid, artifact_type: 'file', display_name: 'x', relative_path: null, hash: null, char_count: 0, status: 'done', created_at: 1 })
      // runs 级联对象（repository 无写接口的表）：run_evidence / completion_contracts / usage_log（SET NULL）
      db5.prepare('INSERT INTO run_evidence (run_id, kind, json, created_at) VALUES (?, ?, ?, ?)').run('r-' + sid, 'renpy_lint', '{}', 1)
      db5.prepare('INSERT INTO completion_contracts (run_id, version, json, created_at) VALUES (?, ?, ?, ?)').run('r-' + sid, 1, '{}', 1)
      db5.prepare('INSERT INTO usage_log (run_id, call_type, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?)').run('r-' + sid, 'chat', 1, 1, 1)
    }
    seed('s-1')
    rp2.deleteSession('s-1')
    const counts: Array<[string, string]> = [
      ['sessions', 'session_id'], ['session_messages', 'session_id'], ['jobs', 'session_id'], ['attachments', 'session_id'],
      ['runs', 'session_id'], ['turns', 'run_id'], ['toolcalls', 'run_id'], ['artifacts', 'run_id'],
      ['run_evidence', 'run_id'], ['completion_contracts', 'run_id']
    ]
    for (const [table] of counts) {
      const n = (db5.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
      check(`G2-5 删除会话后 ${table} 清零（无孤儿）`, n === 0, `count=${n}`)
    }
    const usageRow = db5.prepare('SELECT run_id FROM usage_log LIMIT 1').get() as { run_id: string | null } | undefined
    check('G2-5 usage_log.run_id 置 NULL（FK SET NULL，保留审计行）', usageRow !== undefined && usageRow.run_id === null, JSON.stringify(usageRow))

    // 失败回滚：BEFORE DELETE 触发器注入失败——deleteSession 必须整体回滚，数据完整保留
    seed('s-2')
    db5.exec("CREATE TRIGGER inj_g25 BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'injected'); END")
    let threw = false
    try {
      rp2.deleteSession('s-2')
    } catch {
      threw = true
    }
    check('G2-5 注入失败时 deleteSession 抛出', threw, threw ? '' : '未抛出（触发器未生效？）')
    const afterRollback: Array<[string, string]> = [
      ['sessions', 's-2'], ['session_messages', 's-2'], ['jobs', 's-2'], ['attachments', 's-2'],
      ['runs', 's-2'], ['turns', 'r-s-2'], ['toolcalls', 'r-s-2'], ['artifacts', 'r-s-2']
    ]
    for (const [table, key] of afterRollback) {
      const col = table === 'turns' || table === 'toolcalls' ? 'run_id' : table === 'artifacts' ? 'run_id' : 'session_id'
      const n = (db5.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`).get(key) as { c: number }).c
      check(`G2-5 回滚后 ${table} 数据保留`, n === 1, `count=${n}`)
    }
    db5.exec('DROP TRIGGER inj_g25')
  } finally {
    db5.close()
    rp2.close()
  }

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== Gate 2 DB 测试结果：${passed} PASS / ${failed} FAIL =====`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Gate 2 DB 执行异常：', e)
  process.exit(2)
})
