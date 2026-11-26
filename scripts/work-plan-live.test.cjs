const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { DatabaseSync } = require('node:sqlite'), { buildSync } = require('esbuild'), { EventEmitter } = require('node:events')
const root = path.resolve(__dirname, '..')
const bundle = entry => buildSync({ entryPoints: [path.join(root, entry)], bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
function load(code, window, customRequire = require) { const mod = { exports: {} }; new Function('require', 'module', 'exports', 'window', code)(customRequire, mod, mod.exports, window); return mod.exports }
const { createRepository } = load(bundle('src/main/db/repository.ts'))
const { getRunWorkPlan } = load(bundle('src/main/workPlan.ts'))
const plan = label => ({ version: 1, steps: [{ text: label, status: 'in_progress' }] })
const tick = () => new Promise(resolve => setImmediate(resolve))

test('actual preload -> narrow main handler -> SQLite reads no unrelated prose; legacy runs:get previews stay exact', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-live-work-plan-'))
  let repo, db; const prepare = DatabaseSync.prototype.prepare, selects = []
  try {
    repo = createRepository(path.join(home, 'test.db')); repo.open(); db = new DatabaseSync(path.join(home, 'test.db'))
    const now = Date.now(), large = '无关长正文。'.repeat(300000), config = JSON.stringify({ longUnrelatedConfig: large })
    for (const id of ['task', 'foreign']) {
      db.prepare('INSERT INTO sessions(session_id,title,created_at,updated_at) VALUES(?,?,?,?)').run(id, '同名任务', now, now)
      db.prepare('INSERT INTO runs(run_id,session_id,status,phase,started_at,updated_at,config_json) VALUES(?,?,?,?,?,?,?)').run(id, id, 'running', 'running', now, now, config)
    }
    const texts = ['𠮷'.repeat(199) + large, 'a'.repeat(199) + '𠮷' + large, large, 'ab\0cd', 'a'.repeat(798) + '𠮷' + large, '\0' + large, '']
    for (let index = 0; index < texts.length; index++) db.prepare('INSERT INTO turns(turn_id,run_id,turn_seq,role,content,reasoning_content,tool_calls_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run('t' + index, 'task', index, 'assistant', texts[index], large, JSON.stringify({ unrelated: large }), now)
    const receipt = (id, runId, turnId, value, status = 'completed') => db.prepare('INSERT INTO toolcalls(tool_call_id,turn_id,run_id,name,args_json,args_hash,status,result_json,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, turnId, runId, 'update_work_plan', '{}', id, status, JSON.stringify(value), now, now)
    receipt('old', 'task', 't0', { content: JSON.stringify({ ok: true, workPlan: plan('原清单') }) })
    // A foreign/mismatched turn and failed/malformed newer receipts cannot win.
    receipt('foreign', 'foreign', 't2', { ok: true, workPlan: plan('不可串入') })
    receipt('failed', 'task', 't2', { ok: true, workPlan: plan('失败不得覆盖') }, 'failed')
    receipt('invalid', 'task', 't2', { ok: false, workPlan: plan('拒绝不得覆盖') })
    let handler, bridge
    const main = await fs.readFile(path.join(root, 'src/main/index.ts'), 'utf8')
    const registration = main.match(/^registerIpc\('runs:getWorkPlan'.*$/m)?.[0]; assert(registration)
    const narrowOnly = new Proxy(repo, { get(target, key) { if (key !== 'workPlanReceipts') throw Error(`narrow checklist must not read ${String(key)}`); return target[key].bind(target) } })
    new Function('registerIpc', 'schemas', 'repository', 'getRunWorkPlan', registration)((channel, options, fn) => { assert.equal(channel, 'runs:getWorkPlan'); assert(options.schema); handler = fn }, { runsGetSchema: {} }, narrowOnly, getRunWorkPlan)
    const ipc = new EventEmitter(); ipc.invoke = (channel, input) => { assert.equal(channel, 'runs:getWorkPlan'); return handler({}, input) }
    load(bundle('src/preload/index.ts'), {}, name => name === 'electron' ? { contextBridge: { exposeInMainWorld: (name, api) => { if (name === 'ds') bridge = api } }, ipcRenderer: ipc } : require(name))
    DatabaseSync.prototype.prepare = function(sql) { if (/^\s*(SELECT|WITH)/i.test(sql)) selects.push(sql); return prepare.call(this, sql) }
    assert.deepEqual(await bridge.runsGetWorkPlan('task'), plan('原清单'))
    assert.equal(await bridge.runsGetWorkPlan('foreign'), null)
    assert.equal(await bridge.runsGetWorkPlan('missing'), null)
    assert(selects.length === 3 && selects.every(sql => /SELECT tc\.result_json/.test(sql) && !/config_json|\bcontent\b|manuscript/i.test(sql)), 'checklist refresh only materializes receipt JSON, never bodies/config/manuscript')
    receipt('new', 'task', 't2', { ok: true, workPlan: plan('新清单') })
    assert.deepEqual(await bridge.runsGetWorkPlan('task'), plan('新清单'))
    receipt('clear', 'task', 't2', { ok: true, workPlan: { version: 1, steps: [] } })
    assert.equal(await bridge.runsGetWorkPlan('task'), null, 'an accepted empty snapshot clears instead of reviving an older list')
    const full = repo.getTurnsByRun('task'), previews = repo.getRunTurnPreviews('task')
    assert.deepEqual(previews, full.map(turn => ({ role: turn.role, content: turn.content.slice(0, 200) })))
    assert.equal(previews[1].content.charCodeAt(199), 0xD842, 'keep the original JS UTF-16 boundary, not 200 Unicode characters')
    assert.equal(previews[3].content, full[3].content.slice(0, 200), 'embedded NUL follows the same legacy TEXT binding on this Node runtime')
    assert.equal(previews[4].content, 'a'.repeat(200), 'an incomplete UTF-8 character at the byte-prefix edge cannot corrupt the first 200 units')
    assert.equal(previews[6].content, '', 'empty assistant/tool-call turns stay empty on both Node and Electron SQLite')
    assert.equal(full[0].content, texts[0], 'full repository callers retain their original API')
    assert(selects.some(sql => /CAST\(substr\(CAST\(content AS BLOB\),1,800\) AS TEXT\)/.test(sql)), 'bounded bytes are decoded by the native TEXT binding, not a different JS decoder')
    assert.match(main, /turns: repository\.getRunTurnPreviews\(r\.run_id\)/)
    const result = { unrelatedProseUtf16Units: texts.reduce((sum, text) => sum + text.length, 0), legacyMaterializedTurnUtf16Units: full.reduce((sum, turn) => sum + turn.content.length + turn.reasoning_content.length + turn.tool_calls_json.length, 0), previewSqlByteCapPerTurn: 800, returnedPreviewUtf16Units: previews.reduce((sum, turn) => sum + turn.content.length, 0), checklistJsonUtf16Units: JSON.stringify(plan('新清单')).length, narrowSelect: selects[0] }
    console.log(JSON.stringify(result)); await fs.mkdir(path.join(root, 'out/work-plan-live'), { recursive: true }); await fs.writeFile(path.join(root, 'out/work-plan-live/sqlite-evidence.json'), JSON.stringify(result, null, 2))
    DatabaseSync.prototype.prepare = prepare
    db.close(); db = null; repo.close(); repo = createRepository(path.join(home, 'test.db')); repo.open()
    assert.equal(getRunWorkPlan(repo, 'task'), null, 'clear remains durable after reopening the database')
  } finally {
    DatabaseSync.prototype.prepare = prepare; db?.close(); repo?.close()
    assert.equal(path.dirname(home), os.tmpdir()); assert(path.basename(home).startsWith('dw-live-work-plan-')); await fs.rm(home, { recursive: true, force: true })
  }
})

function subscriptions() {
  const reads = [], listeners = new Set()
  const ds = { runsGetWorkPlan: runId => new Promise((resolve, reject) => reads.push({ runId, resolve, reject })), onRunWorkPlanUpdated: cb => { listeners.add(cb); return () => listeners.delete(cb) } }
  const api = load(bundle('src/renderer/src/workPlanSubscriptions.ts'), { ds })
  return { api, reads, listeners, update: runId => { for (const listener of listeners) listener({ runId }) } }
}

test('inline/detail subscriptions coalesce update bursts, never publish stale responses, and clear empty plans', async () => {
  const { api, reads, listeners, update } = subscriptions(); let renders = 0
  const first = api.subscribeWorkPlan('a', () => renders++), second = api.subscribeWorkPlan('a', () => renders++)
  assert.equal(reads.length, 1); assert.equal(listeners.size, 1)
  for (let index = 0; index < 100; index++) update('a')
  update('unrelated'); assert.equal(reads.length, 1, 'one request in flight per run')
  reads[0].resolve(plan('过期')); await tick()
  assert.equal(api.getWorkPlan('a'), null); assert.equal(renders, 0); assert.equal(reads.length, 2)
  reads[1].resolve(plan('当前')); await tick(); assert.deepEqual(api.getWorkPlan('a'), plan('当前')); assert.equal(renders, 2)
  update('a'); reads[2].resolve(null); await tick(); assert.equal(api.getWorkPlan('a'), null); assert.equal(renders, 4)
  first(); second(); assert.equal(listeners.size, 0)
})

test('session changes/reopen discard late callbacks; failed reads retain the last accepted plan and retry on update', async () => {
  const { api, reads, update } = subscriptions()
  const stopOld = api.subscribeWorkPlan('a', () => {}); stopOld()
  const stopB = api.subscribeWorkPlan('b', () => {}), stopNew = api.subscribeWorkPlan('a', () => {})
  reads[0].resolve(plan('旧会话')); reads[1].resolve(plan('另一个任务')); reads[2].resolve(plan('重开')); await tick()
  assert.deepEqual(api.getWorkPlan('a'), plan('重开')); assert.deepEqual(api.getWorkPlan('b'), plan('另一个任务'))
  update('a'); reads[3].reject(new Error('fixture read failure')); await tick(); assert.deepEqual(api.getWorkPlan('a'), plan('重开'))
  update('a'); reads[4].resolve(null); await tick(); assert.equal(api.getWorkPlan('a'), null)
  stopB(); stopNew(); assert.equal(api.getWorkPlan('b'), null)
})
