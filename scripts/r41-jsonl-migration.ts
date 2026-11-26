// ==================== R4.1 PERSIST-MIGRATE-01：旧 JSONL 会话一次性迁移 ====================
// 覆盖：v6 迁移导入（消息+标题）/ 幂等（二次 openDb 不重复导入）/ 备份目录 / 原文件保留 /
//       损坏行跳过 / safeId 反推 / DW_JSONL_SESSIONS_DIR 覆盖 / 空目录新库
// 运行：npx esbuild scripts/r41-jsonl-migration.ts --bundle --format=esm --platform=node --outfile=out/r41j.mjs && node out/r41j.mjs

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const ELECTRON_SHIM = {
  name: 'electron-shim',
  setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
    build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
      contents: [
        'export const app = { getPath: (n) => String(n), isPackaged: false };',
        'export const dialog = { showMessageBox: async () => ({ response: 1 }) };',
        'export const ipcMain = { handle: () => undefined, on: () => undefined };',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => null, decryptString: () => "" };',
        'export const shell = { openExternal: () => undefined, openPath: async () => "" };',
        'export const clipboard = { writeText: () => undefined };',
        'export const Menu = { buildFromTemplate: (t) => ({ popup: () => undefined, template: t }) };'
      ].join('\n'),
      loader: 'js'
    }))
  }
}

const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(__dirname, '..', rel)
  const outfile = path.resolve(__dirname, '..', 'out', `r41jmod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: true,
      outfile,
      external: ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite'],
      logLevel: 'silent',
      plugins: [ELECTRON_SHIM]
    })
    const mod = await import(url.pathToFileURL(outfile).href)
    return mod as Record<string, unknown>
  } finally {
    try {
      await fsp.unlink(outfile)
    } catch {
      /* 清理失败忽略 */
    }
  }
}

const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_')

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r41j-'))
  const sessionsDir = path.join(tmp, 'sessions')
  const dbPath = path.join(tmp, 'deepwriter.db')
  const migrations = await loadTsModule('src/main/db/migrations.ts')
  const openDb = migrations.openDb as (p: string) => import('node:sqlite').DatabaseSync
  const currentSchemaVersion = migrations.CURRENT_SCHEMA_VERSION as number

  // ---- 构造旧 JSONL 数据（与 sessionStore.ts 格式一致：文件名=safeId(id)，事件流 message/meta） ----
  await fsp.mkdir(sessionsDir, { recursive: true })
  const indexMetas = [
    { id: 'sess-a', title: '标题甲', createdAt: 1000, updatedAt: 5000, messageCount: 2, model: 'deepseek-v4' },
    { id: 'sess-b', title: '标题乙', createdAt: 2000, updatedAt: 6000, messageCount: 1, model: '' },
    { id: 'sess/乙', title: '特殊字符会话', createdAt: 3000, updatedAt: 7000, messageCount: 1, model: 'm2' }
  ]
  await fsp.writeFile(path.join(sessionsDir, 'index.json'), JSON.stringify(indexMetas, null, 2), 'utf-8')

  // sess-a：user + 富字段 assistant + 损坏行 + meta 标题事件（宽容跳过/读取）
  await fsp.writeFile(
    path.join(sessionsDir, 'sess-a.jsonl'),
    [
      JSON.stringify({ ts: 1100, type: 'message', message: { id: 'm_u1', role: 'user', content: '你好', reasoning: '', status: 'done', usage: null, rounds: 0, toolNames: [], createdAt: 1100 } }),
      JSON.stringify({ ts: 1300, type: 'meta', title: 'meta事件标题' }),
      'this is a corrupted line {',
      JSON.stringify({
        ts: 1500,
        type: 'message',
        message: { id: 'm_a1', role: 'assistant', content: '回复内容', reasoning: '思考过程', status: 'done', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, rounds: 1, toolNames: ['read_file', 'write_file'], plan: 'approved', createdAt: 1500 }
      })
    ].join('\n') + '\n',
    'utf-8'
  )
  // sess-b：仅 1 条 user
  await fsp.writeFile(
    path.join(sessionsDir, 'sess-b.jsonl'),
    JSON.stringify({ ts: 2100, type: 'message', message: { id: 'm_u2', role: 'user', content: '第二会话', reasoning: '', status: 'done', usage: null, rounds: 0, toolNames: [], createdAt: 2100 } }) + '\n',
    'utf-8'
  )
  // sess/乙 → 文件名 sess__.jsonl（safeId 有损编码，index.json 的原始 id 应被反推）
  await fsp.writeFile(
    path.join(sessionsDir, `${safeId('sess/乙')}.jsonl`),
    JSON.stringify({ ts: 3100, type: 'message', message: { id: 'm_u3', role: 'user', content: '特殊会话', reasoning: '', status: 'done', usage: null, rounds: 0, toolNames: [], createdAt: 3100 } }) + '\n',
    'utf-8'
  )

  console.log('\n[R41J-1] v6 一次性导入（消息 + 标题）')
  const db = openDb(dbPath)
  const ver = db.prepare('PRAGMA user_version').get() as { user_version: number }
  check(`迁移后 user_version=${currentSchemaVersion}（当前迁移版本）`, ver.user_version === currentSchemaVersion, `user_version=${ver.user_version}`)
  const flag = db.prepare("SELECT value FROM meta WHERE key = 'jsonl_migrated'").get() as { value: string } | undefined
  check('jsonl_migrated 标记已写入', flag !== undefined, JSON.stringify(flag))
  const flagObj = flag ? (JSON.parse(flag.value) as { sessions: number; messages: number; backupDir: string }) : null
  check('标记记录 3 会话 / 4 消息（损坏行与 meta 事件不计）', flagObj !== null && flagObj.sessions === 3 && flagObj.messages === 4, JSON.stringify(flagObj))

  const sessions = db.prepare('SELECT * FROM sessions ORDER BY created_at').all() as Array<{ session_id: string; title: string; model: string }>
  check('sessions 表 3 行', sessions.length === 3, JSON.stringify(sessions))
  const sA = sessions.find((s) => s.session_id === 'sess-a')
  check('sess-a 标题来自 index.json（meta 事件标题不覆盖）', sA?.title === '标题甲', JSON.stringify(sA))
  check('sess-a model 来自 index.json', sA?.model === 'deepseek-v4', JSON.stringify(sA))
  check('sess/乙 反推原始 id（safeId 有损编码可逆回 index）', sessions.some((s) => s.session_id === 'sess/乙'), JSON.stringify(sessions.map((s) => s.session_id)))

  const msgsA = db.prepare("SELECT * FROM session_messages WHERE session_id = 'sess-a' ORDER BY seq").all() as Array<{
    msg_id: string; seq: number; role: string; content: string; reasoning: string; status: string; usage_json: string; rounds: number; tool_names_json: string; plan: string | null; created_at: number
  }>
  check('sess-a 2 条消息（损坏行跳过）', msgsA.length === 2, JSON.stringify(msgsA))
  check('seq 从 1 连续编号', msgsA[0].seq === 1 && msgsA[1].seq === 2, JSON.stringify(msgsA.map((m) => m.seq)))
  check('user 消息内容/角色正确', msgsA[0].role === 'user' && msgsA[0].content === '你好', JSON.stringify(msgsA[0]))
  const a1 = msgsA[1]
  check(
    'assistant 富字段完整映射（reasoning/status/usage/rounds/toolNames/plan）',
    a1.content === '回复内容' && a1.reasoning === '思考过程' && a1.status === 'done' &&
      (JSON.parse(a1.usage_json) as { input_tokens: number }).input_tokens === 10 &&
      a1.rounds === 1 &&
      JSON.stringify(JSON.parse(a1.tool_names_json)) === JSON.stringify(['read_file', 'write_file']) &&
      a1.plan === 'approved',
    JSON.stringify(a1)
  )
  const countB = (db.prepare("SELECT COUNT(*) AS n FROM session_messages WHERE session_id = 'sess-b'").get() as { n: number }).n
  const countC = (db.prepare("SELECT COUNT(*) AS n FROM session_messages WHERE session_id = 'sess/乙'").get() as { n: number }).n
  check('sess-b / sess/乙 各 1 条消息', countB === 1 && countC === 1, `b=${countB} c=${countC}`)
  const sessATimes = db.prepare("SELECT created_at, updated_at FROM sessions WHERE session_id = 'sess-a'").get() as { created_at: number; updated_at: number }
  check('会话时间取自 index.json（createdAt/updatedAt）', sessATimes.created_at === 1000 && sessATimes.updated_at === 5000, JSON.stringify(sessATimes))
  db.close()

  console.log('\n[R41J-2] 备份目录 + 原 JSONL 保留')
  const backups = fs.readdirSync(tmp).filter((f) => f.startsWith('sessions-jsonl-backup-'))
  check('备份目录存在（sessions-jsonl-backup-<ts>）', backups.length === 1, JSON.stringify(backups))
  if (backups.length === 1) {
    const bakFiles = fs.readdirSync(path.join(tmp, backups[0]))
    check('备份含全部 jsonl + index.json', bakFiles.includes('sess-a.jsonl') && bakFiles.includes('sess-b.jsonl') && bakFiles.includes('sess__.jsonl') && bakFiles.includes('index.json'), JSON.stringify(bakFiles))
  }
  check('原 sessions 目录未被删除（仍存在）', fs.existsSync(sessionsDir))
  check('原 jsonl 文件未被删除', fs.existsSync(path.join(sessionsDir, 'sess-a.jsonl')) && fs.existsSync(path.join(sessionsDir, 'sess-b.jsonl')) && fs.existsSync(path.join(sessionsDir, 'sess__.jsonl')))
  check('原 index.json 未被删除', fs.existsSync(path.join(sessionsDir, 'index.json')))

  console.log('\n[R41J-3] 幂等：二次 openDb 不重复导入')
  const db2 = openDb(dbPath)
  const n2 = (db2.prepare('SELECT COUNT(*) AS n FROM session_messages').get() as { n: number }).n
  const s2 = (db2.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
  check('二次打开消息数不变（4）', n2 === 4, `n=${n2}`)
  check('二次打开会话数不变（3）', s2 === 3, `n=${s2}`)
  const flag2 = db2.prepare("SELECT value FROM meta WHERE key = 'jsonl_migrated'").get() as { value: string } | undefined
  check('jsonl_migrated 值不变', flag2?.value === flag?.value, JSON.stringify(flag2))
  const backups2 = fs.readdirSync(tmp).filter((f) => f.startsWith('sessions-jsonl-backup-'))
  check('二次打开不再复制备份目录（仍 1 个）', backups2.length === 1, JSON.stringify(backups2))
  db2.close()

  console.log('\n[R41J-4] 空目录新库 + DW_JSONL_SESSIONS_DIR 覆盖')
  const freshRoot = path.join(tmp, 'fresh-root')
  await fsp.mkdir(freshRoot, { recursive: true })
  const freshDb = openDb(path.join(freshRoot, 'fresh.db'))
  const vFresh = freshDb.prepare('PRAGMA user_version').get() as { user_version: number }
  const flagFresh = freshDb.prepare("SELECT value FROM meta WHERE key = 'jsonl_migrated'").get()
  check(`无 sessions 目录的新库迁移成功（当前 schema=${currentSchemaVersion}，v6 空导入不炸）`, vFresh.user_version === currentSchemaVersion && flagFresh !== undefined, JSON.stringify({ vFresh: vFresh.user_version, flagFresh }))
  freshDb.close()

  const envSessions = path.join(tmp, 'env-sessions')
  await fsp.mkdir(envSessions, { recursive: true })
  await fsp.writeFile(
    path.join(envSessions, 'env-s.jsonl'),
    JSON.stringify({ ts: 4100, type: 'message', message: { id: 'm_env', role: 'user', content: 'env覆盖', reasoning: '', status: 'done', usage: null, rounds: 0, toolNames: [], createdAt: 4100 } }) + '\n',
    'utf-8'
  )
  process.env.DW_JSONL_SESSIONS_DIR = envSessions
  try {
    const envDb = openDb(path.join(tmp, 'env.db'))
    const envMsgs = (envDb.prepare("SELECT COUNT(*) AS n FROM session_messages WHERE session_id = 'env-s'").get() as { n: number }).n
    check('DW_JSONL_SESSIONS_DIR 覆盖目录生效（env-s 导入 1 条）', envMsgs === 1, `n=${envMsgs}`)
    envDb.close()
  } finally {
    delete process.env.DW_JSONL_SESSIONS_DIR
  }

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.1 JSONL 迁移测试：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('失败明细：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.1 JSONL 迁移测试执行异常：', e)
  process.exit(2)
})
