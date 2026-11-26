import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.2 A1 红灯回归：真正原子的 chat accept（PERSIST-ATOMIC-02） ====================
// 复审 B-01：旧实现"先 createRun，后事务写 session/历史/user，失败再 cancel"——cancel 不是 rollback。
// 本测试证明：
//  1) acceptChatStart 在单一 SQLite 事务内提交 session + run + user turn + user message + 幂等键；
//  2) 任一写点故障注入 → 业务表与调用前逐行一致（不是"run 最终被 cancel"）；
//  3) 事务提交前绝不调用模型/工具（engine.start 0 次）；
//  4) 同 (sessionId, clientRequestId) 幂等返回同一 run；
//  5) 同 session 并发启动只有一个成功，无 queued/busy 孤儿；
//  6) 进程 kill 窗口（BEGIN 后不 COMMIT 直接关库）→ 重开自动回滚，无半成品。
// 运行：npx esbuild scripts/r42-atomic.ts --bundle --format=esm --platform=node --outfile=out/r42-atomic.mjs && node out/r42-atomic.mjs

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

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

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(__dirname, '..', rel)
  const outfile = path.resolve(__dirname, '..', 'out', `r42mod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: true,
      outfile,
      external: desktopSourceExternals(abs, ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite']),
      logLevel: 'silent',
      plugins: [ELECTRON_SHIM]
    })
    const mod = await import(url.pathToFileURL(outfile).href)
    return mod as Record<string, unknown>
  } finally {
    try {
      await fs.promises.unlink(outfile)
    } catch {
      /* 清理失败忽略 */
    }
  }
}

interface TableSnapshot {
  runs: number
  turns: number
  sessions: number
  messages: number
}

interface RawDb {
  prepare(s: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown; run(...a: unknown[]): unknown }
  exec(s: string): unknown
  close(): void
}

function snapshot(db: RawDb): TableSnapshot {
  const n = (sql: string): number => (db.prepare(sql).all() as unknown[]).length
  return {
    runs: n('SELECT 1 FROM runs'),
    turns: n('SELECT 1 FROM turns'),
    sessions: n('SELECT 1 FROM sessions'),
    messages: n('SELECT 1 FROM session_messages')
  }
}

function snapshotEq(a: TableSnapshot, b: TableSnapshot): boolean {
  return a.runs === b.runs && a.turns === b.turns && a.sessions === b.sessions && a.messages === b.messages
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r42-atomic-'))

  console.log('\n[R42-A1] PERSIST-ATOMIC-02：真正原子 chat accept')
  const repoMod = await loadTsModule('src/main/db/repository.ts')
  const createRepository = repoMod.createRepository as (p: string) => {
    open(): void
    close(): void
    acceptChatStart(input: unknown, hooks?: Record<string, () => void>): { ok: boolean; reason?: string; runId?: string }
    listActiveRuns(): Array<{ run_id: string; session_id: string; status: string }>
    getRun(runId: string): { run_id: string; status: string } | null
    prepare(s: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown; run(...a: unknown[]): unknown }
  }

  // 先加载 migrations 拿 openDb（快照/杀窗口共用）
  const migMod = await loadTsModule('src/main/db/migrations.ts')
  const openDb = migMod.openDb as (p: string) => RawDb

  const repo = createRepository(path.join(tmp, 'atomic.db'))
  repo.open()
  // 独立只读连接用于业务表快照（同一 DB 文件，WAL 下可见已提交状态）
  const dbRaw = openDb(path.join(tmp, 'atomic.db'))

  const makeInput = (runId: string, sessionId: string, requestId: string, text = '测试消息'): unknown => {
    const now = Date.now()
    return {
      sessionId,
      title: '新会话',
      model: 'deepseek-v4-flash',
      run: {
        run_id: runId,
        session_id: sessionId,
        status: 'queued',
        phase: 'queued',
        started_at: now,
        updated_at: now,
        config_json: JSON.stringify({ schemaVersion: 1, clientRequestId: requestId, sessionId }),
        parent_run_id: null,
        error_code: null,
        error_message: null,
        client_request_id: requestId
      },
      userTurn: {
        turn_id: `${runId}_user`,
        run_id: runId,
        turn_seq: 1,
        role: 'user',
        content: text,
        reasoning_content: null,
        tool_calls_json: null,
        tool_result_json: null,
        plan_state: null,
        created_at: now
      },
      userMsg: {
        msg_id: `m_${runId}_user`,
        role: 'user',
        content: text,
        created_at: now
      }
    }
  }

  // ---- 1. 逐写点故障注入：失败后业务表与调用前逐行一致（红灯：旧实现会留下 cancelled run） ----
  const before = snapshot(dbRaw)
  const hooksList = ['beforeInsertRun', 'beforeInsertTurn', 'beforeInsertMessage'] as const
  for (const hookName of hooksList) {
    let threw = false
    try {
      repo.acceptChatStart(makeInput(`run-${hookName}`, `sess-${hookName}`, `req-${hookName}`), {
        [hookName]: () => {
          throw new Error(`injected-failure:${hookName}`)
        }
      })
    } catch {
      threw = true
    }
    check(`PERSIST-ATOMIC-02 写点 ${hookName} 故障注入必须抛错（不静默吞）`, threw)
    check(`PERSIST-ATOMIC-02 写点 ${hookName} 失败后业务表与调用前逐行一致（回滚，无半成品）`, snapshotEq(snapshot(dbRaw), before), JSON.stringify(snapshot(dbRaw)))
  }

  // ---- 2. 幂等：同 (sessionId, clientRequestId) 返回同一 run ----
  const idem = makeInput('run-idem', 'sess-idem', 'req-idem', '幂等消息')
  const r1 = repo.acceptChatStart(idem)
  check('PERSIST-ATOMIC-02 首次 acceptChatStart 成功', r1.ok === true, JSON.stringify(r1))
  const beforeIdem = snapshot(dbRaw)
  const r2 = repo.acceptChatStart(makeInput('run-idem-2', 'sess-idem', 'req-idem', '幂等消息'))
  check('PERSIST-ATOMIC-02 同 (session,clientRequestId) 幂等返回既有 run', r2.ok === false && r2.reason === 'duplicate' && r2.runId === 'run-idem', JSON.stringify(r2))
  check('PERSIST-ATOMIC-02 幂等不产生任何新行', snapshotEq(snapshot(dbRaw), beforeIdem))

  // ---- 3. busy：同 session 已有非终态 run → 拒绝 ----
  const r3 = repo.acceptChatStart(makeInput('run-busy', 'sess-idem', 'req-busy'))
  check('PERSIST-ATOMIC-02 同 session 存在非终态 run 时拒绝新启动', r3.ok === false && r3.reason === 'busy' && r3.runId === 'run-idem', JSON.stringify(r3))

  // ---- 4. 并发启动：同一 session 两个请求只有一个成功 ----
  const results = await Promise.all([
    Promise.resolve().then(() => repo.acceptChatStart(makeInput('run-c1', 'sess-conc', 'req-c1'))),
    Promise.resolve().then(() => repo.acceptChatStart(makeInput('run-c2', 'sess-conc', 'req-c2')))
  ])
  const okCount = results.filter((r) => r.ok).length
  check('PERSIST-ATOMIC-02 并发启动恰好一个成功', okCount === 1, JSON.stringify(results))
  check('PERSIST-ATOMIC-02 并发失败方为 busy/duplicate（非异常）', results.some((r) => !r.ok && (r.reason === 'busy' || r.reason === 'duplicate')))
  const concActives = repo.listActiveRuns().filter((r) => r.session_id === 'sess-conc')
  check('PERSIST-ATOMIC-02 并发后 session 只有 1 个非终态 run（无 queued/busy 孤儿）', concActives.length === 1, JSON.stringify(concActives.map((r) => ({ id: r.run_id, s: r.status }))))

  // ---- 5. kill 窗口：BEGIN 后不 COMMIT 直接关库（进程被杀等价）→ 重开自动回滚 ----
  const killDbPath = path.join(tmp, 'kill.db')
  const d1 = openDb(killDbPath)
  d1.exec('BEGIN IMMEDIATE')
  d1.prepare('INSERT INTO runs (run_id, session_id, status, phase, started_at, updated_at, config_json) VALUES (?,?,?,?,?,?,?)').run('run-kill', 'sess-kill', 'queued', 'queued', Date.now(), Date.now(), '{}')
  d1.close() // 不 COMMIT → 模拟进程在事务中途被强杀
  const d2 = openDb(killDbPath) // WAL 恢复：未提交事务自动回滚
  const killed = d2.prepare('SELECT * FROM runs WHERE run_id = ?').get('run-kill')
  check('PERSIST-ATOMIC-02 kill 窗口：未提交事务重开后自动回滚（无半成品 run）', killed === undefined, JSON.stringify(killed ?? null))
  d2.close()

  // ---- 6. 编排 startChatRun：事务失败绝不调用模型/工具；事务提交后才 engine.start ----
  const chatStartMod = await loadTsModule('src/main/chatStart.ts')
  const startChatRun = chatStartMod.startChatRun as (deps: unknown, payload: Record<string, unknown>, hooks?: Record<string, () => void>) => Promise<{ runId: string; status: string; idempotent: boolean }>
  const calls = { engineStart: 0, engineStep: 0 }
  let startSawCommittedRun = false
  const spyEngine = {
    start: async (input: { runId: string }) => {
      calls.engineStart++
      // 证明 start 调用时 run 已事务提交（数据库可见）
      startSawCommittedRun = repo.getRun(input.runId) !== null
      return { ok: true, run: {} }
    },
    step: async () => {
      calls.engineStep++
    }
  }
  const deps = {
    repository: repo,
    runKernel: spyEngine,
    loadSettings: async () => ({ model: 'deepseek-v4-flash', historyBudgetTokens: 60000 }),
    buildConfig: (payload: { id: string }, _settings: unknown, sessionId: string) => ({ schemaVersion: 1, clientRequestId: payload.id, sessionId, runMode: 'agent' })
  }
  // 失败路径：事务内注入故障
  let threw = false
  try {
    await startChatRun(deps, { id: 'chat-fail', sessionId: 'sess-fail', text: '失败请求' }, { beforeInsertRun: () => { throw new Error('injected') } })
  } catch {
    threw = true
  }
  check('PERSIST-ATOMIC-02 事务失败时 startChatRun 抛错', threw)
  check('PERSIST-ATOMIC-02 事务失败时模型/引擎从未被调用（engine.start=0, step=0）', calls.engineStart === 0 && calls.engineStep === 0, `start=${calls.engineStart} step=${calls.engineStep}`)
  // 成功路径
  const okRes = await startChatRun(deps, { id: 'chat-ok', sessionId: 'sess-ok', text: '正常请求' })
  check('PERSIST-ATOMIC-02 成功路径返回 runId', okRes.runId === 'chat-ok', JSON.stringify(okRes))
  check('PERSIST-ATOMIC-02 成功路径 engine.start 在事务提交后才被调用', calls.engineStart >= 1 && startSawCommittedRun)
  check('PERSIST-ATOMIC-02 成功路径 engine.step 被调用（提交后 step）', calls.engineStep >= 1)

  // ---- 7. engine alreadyCreated：run 行已由 acceptChatStart 落库后 start 直接装载 ----
  const engineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => {
    start(input: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>
    getState(runId: string): Promise<{ run: { status: string } | null; turns: Array<{ role: string; content: string }> }>
  }
  const storePortMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createRunStorePort = storePortMod.createRunStorePort as (r: unknown) => Record<string, unknown>
  const storePort = createRunStorePort(repo as never)
  const engine = createAgentRunEngine({
    store: storePort,
    modelCall: async () => ({} as AsyncIterable<unknown>),
    toolExecutor: async () => '',
    getConfig: () => ({}),
    onEvent: () => undefined,
    onRunUpdate: () => undefined
  })
  // 先由 acceptChatStart 落库（含 user turn）
  const pre = makeInput('run-eng', 'sess-eng', 'req-eng', '引擎消息')
  const ar = repo.acceptChatStart(pre)
  check('PERSIST-ATOMIC-02 引擎预置 run 落库成功', ar.ok === true)
  const sr = await engine.start({ sessionId: 'sess-eng', runId: 'run-eng', config: { schemaVersion: 1, clientRequestId: 'req-eng', sessionId: 'sess-eng' }, alreadyCreated: true })
  check('PERSIST-ATOMIC-02 engine.start(alreadyCreated) 装载既有 run 成功', sr.ok === true, JSON.stringify(sr))
  const st = await engine.getState('run-eng')
  check('PERSIST-ATOMIC-02 装载后 user turn 可见（nextTurnSeq 从既有 turns 继续）', st.turns.length === 1 && st.turns[0]?.role === 'user', JSON.stringify(st.turns))
  // alreadyCreated 但 run 不存在 → 必须失败
  let missingThrew = false
  try {
    await engine.start({ sessionId: 'x', runId: 'run-not-exist', config: {}, alreadyCreated: true })
  } catch {
    missingThrew = true
  }
  check('PERSIST-ATOMIC-02 alreadyCreated 且 run 不存在必须失败（禁止伪造 run）', missingThrew)

  repo.close()
  try {
    dbRaw.close()
  } catch {
    /* 已关闭 */
  }
  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.2-A1 红灯回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细（修绿目标）：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.2-A1 红灯回归执行异常：', e)
  process.exit(2)
})
