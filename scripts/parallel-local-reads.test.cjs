const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { before, test } = require('node:test')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
before(async () => {
  const built = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {createRunStorePort,createToolExecutor} from './src/main/runKernelAdapter';
    export {createRepository} from './src/main/db/repository';
    export {getTool} from './src/main/tools';
    export {setPermissionManager} from './src/main/agentTools';
    export {configureTerminalHost} from './src/cli/host';` }, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    write: false, logLevel: 'silent', alias: { electron: path.join(root, 'src/cli/host.ts') } })
  const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports); api = module.exports
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const read = (n, file = `${n}.md`) => call(`read-${n}`, 'read_file', { path: file })
async function fixture(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-parallel-read-'))
  api.configureTerminalHost({ dataDir: dir, docDir: dir })
  const repo = api.createRepository(path.join(dir, 'fixture.db')); repo.open()
  const work = path.join(dir, 'work'), docs = path.join(dir, 'docs'); await fs.mkdir(work); await fs.mkdir(docs)
  for (let i = 0; i < 10; i++) await fs.writeFile(path.join(work, `${i}.md`), `文件${i}的原文。`)
  const store = api.createRunStorePort(repo), config = { sessionId: 'session', runMode: 'agent', workDir: work, docDir: docs, pagedFileReads: true,
    maxTurns: 4, toolPolicy: { allowList: ['read_file', 'write_file', 'list_files'] }, cancelFallbackMs: 30,
    providerCallBudget: { maxTokens: 500000, maxWallClockMs: 300000 } }
  const tool = api.getTool('read_file'), original = tool.execute
  let engine, calls = 0; const modelInputs = [], events = []
  const host = api.createToolExecutor({ getSignal: () => engine.abortSignal('run'), getEnv: () => ({ ...config }), getAllowList: () => config.toolPolicy.allowList })
  const makeEngine = (batch, executor = host) => api.createAgentRunEngine({ store, getConfig: () => config, toolExecutor: executor,
    onEvent: (_run, event) => events.push(event), onRunUpdate: () => {}, modelCall: async ({ messages }) => {
      calls++; modelInputs.push(messages)
      return (async function* () {
        if (calls === 1) {
          for (const [index, item] of batch.entries()) yield { type: 'tool_call', tool: { index, ...item } }
          yield { type: 'finish', finishReason: 'tool_calls', toolReadBudgetChars: 1200 }
        } else { yield { type: 'text', delta: '已按真实工具结果核对。' }; yield { type: 'finish', finishReason: 'stop' } }
      })()
    } })
  const start = async batch => { engine = makeEngine(batch); await engine.start({ runId: 'run', sessionId: 'session', config }); return engine }
  try { await run({ dir, work, docs, repo, store, config, tool, original, start, makeEngine, host, modelInputs, events, get engine() { return engine }, set engine(value) { engine = value }, get calls() { return calls } }) }
  finally { tool.execute = original; api.setPermissionManager(null); repo.close(); assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('dw-parallel-read-')); await fs.rm(dir, { recursive: true, force: true }) }
}

test('bounded real reads overlap four at a time, keep declared history order and budget, de-duplicate call IDs, and drain around a write barrier', async () => fixture(async f => {
  let active = 0, maxActive = 0; const timeline = [], budgets = [], modes = []
  f.tool.execute = async (args, dir, env) => {
    active++; maxActive = Math.max(maxActive, active); timeline.push(`start:${args.path}`); budgets.push(env.readBudgetChars); modes.push(env.nonInteractiveLocalRead)
    try { await sleep(args.path === '0.md' ? 80 : 15); return await f.original(args, dir, env) }
    finally { active--; timeline.push(`end:${args.path}`) }
  }
  const batch = [...Array.from({ length: 8 }, (_, i) => read(i)), call('write-barrier', 'write_file', { path: '0.md', content: '屏障后的新正文。' }), read('after', '0.md')]
  const engine = await f.start([...batch, { ...batch[3] }]); await engine.step('run')
  const state = await engine.getState('run'); assert.equal(state.run.status, 'completed', JSON.stringify(state.run))
  assert.equal(maxActive, 4); assert.equal(active, 0); assert.ok(timeline.indexOf('start:3.md') < timeline.indexOf('end:0.md'))
  assert.ok(timeline.indexOf('start:4.md') > timeline.indexOf('end:0.md')); assert.deepEqual(modes, [...Array(8).fill(true), false])
  assert.deepEqual(budgets, Array(9).fill(120))
  const resultTurns = state.turns.filter(t => t.role === 'tool'); assert.deepEqual(resultTurns.map(t => JSON.parse(t.toolResultJson).toolCallId), batch.map(t => t.id))
  assert.match(resultTurns.at(-1).content, /屏障后的新正文/)
  assert.equal(f.calls, 2); assert.deepEqual(f.modelInputs[1].filter(m => m.role === 'tool').map(m => m.tool_call_id), batch.map(t => t.id))
  assert.equal(state.toolCalls.length, batch.length)
}))

test('same real path, missing/unknown paths and containers are serial barriers; failures do not drop declared results', async () => fixture(async f => {
  let active = 0; const starts = []
  f.tool.execute = async (args, dir, env) => { starts.push({ path: args.path, active: active++, mode: env.nonInteractiveLocalRead }); try { await sleep(12); return await f.original(args, dir, env) } finally { active-- } }
  await fs.writeFile(path.join(f.work, 'opaque.zip'), 'invalid archive')
  const batch = [read(0), read('again', './0.md'), read('missing'), read('archive', 'opaque.zip'), read(1), read(2)]
  await (await f.start(batch)).step('run')
  const state = await f.engine.getState('run'); assert.equal(state.run.status, 'completed')
  assert.deepEqual(starts.map(s => s.mode), [false, false, false, false, true, true])
  assert.ok(starts.slice(0, 5).every(s => s.active === 0)); assert.equal(starts[5].active, 1)
  assert.deepEqual(state.turns.filter(t => t.role === 'tool').map(t => JSON.parse(t.toolResultJson).toolCallId), batch.map(t => t.id))
  assert.match(state.turns.find(t => t.role === 'tool' && t.content.includes('missing')).content, /ENOENT/)
}))

test('host-only noninteractive boundary refuses an outside path without invoking permission UI; model arguments cannot enable it', async () => fixture(async f => {
  let prompts = 0; api.setPermissionManager({ decide: async () => { prompts++; return { action: 'deny' } } })
  const outside = path.join(root, 'README.md'), args = JSON.stringify({ path: outside, nonInteractiveLocalRead: false })
  await f.start([])
  const result = JSON.parse(await f.host('read_file', args, 'outside', 'run', { nonInteractiveLocalRead: true, beforeProviderRequest: async () => {} }))
  assert.equal(result.ok, false); assert.equal(prompts, 0)
  await f.host('read_file', JSON.stringify({ path: outside, nonInteractiveLocalRead: true }), 'serial', 'run')
  assert.equal(prompts, 1)
}))

test('cooperative cancellation drains in-flight reads, refuses pause while active, and never starts the next write/provider', async () => fixture(async f => {
  let began = 0, resolveBegan; const beganAll = new Promise(resolve => { resolveBegan = resolve })
  f.tool.execute = async (_args, _dir, env) => { if (++began === 4) resolveBegan(); await new Promise((_resolve, reject) => env.signal.addEventListener('abort', () => reject(new Error('cancelled fixture')), { once: true })); return { ok: true, message: 'unreachable' } }
  const engine = await f.start([...Array.from({ length: 4 }, (_, i) => read(i)), call('write', 'write_file', { path: 'never.md', content: '不能执行' })])
  const step = engine.step('run'); await beganAll; await assert.rejects(engine.pause('run'), /pause_tool_in_flight/); await engine.cancel('run'); await step
  const state = await engine.getState('run'); assert.equal(state.run.status, 'cancelled'); assert.equal(f.calls, 1)
  assert.equal(state.toolCalls.length, 4); assert.ok(state.toolCalls.every(tc => tc.status === 'cancelled')); assert.equal(state.turns.filter(t => t.role === 'tool').length, 4)
  await assert.rejects(fs.stat(path.join(f.work, 'never.md')), /ENOENT/)
}))

test('uncooperative cancel preserves all unknown intents; cold restore and ordered explicit retry do not replay the unstarted write', async () => fixture(async f => {
  let began = 0, resolveBegan; const beganAll = new Promise(resolve => { resolveBegan = resolve })
  f.tool.execute = async (args, dir, env) => { if (++began === 4) resolveBegan(); await sleep(120); return f.original(args, dir, { ...env, signal: undefined }) }
  const batch = [...Array.from({ length: 4 }, (_, i) => read(i)), call('write', 'write_file', { path: 'never.md', content: '不能重放' })]
  const engine = await f.start(batch), step = engine.step('run'); await beganAll; await engine.cancel('run'); await step
  assert.equal((await engine.getState('run')).run.status, 'recovery_required')
  assert.ok((await engine.getState('run')).toolCalls.every(tc => tc.status === 'side_effect_unknown'))
  f.tool.execute = f.original; f.engine = f.makeEngine([]); await f.engine.restore('run')
  let state = await f.engine.getState('run'); assert.equal(f.calls, 1); assert.equal(state.run.status, 'recovery_required'); assert.equal(state.toolCalls.find(tc => tc.toolCallId === 'write').status, 'failed')
  assert.equal(state.turns.filter(t => t.role === 'tool').length, 0)
  assert.deepEqual(await f.engine.applyRecoveryDecision('run', 'retry_not_applied'), { ok: true })
  state = await f.engine.getState('run'); assert.deepEqual(state.turns.filter(t => t.role === 'tool').map(t => JSON.parse(t.toolResultJson).toolCallId), batch.map(t => t.id)); assert.equal(state.run.status, 'running')
  await assert.rejects(fs.stat(path.join(f.work, 'never.md')), /ENOENT/)
  await f.engine.restore('run'); assert.equal((await f.engine.getState('run')).turns.filter(t => t.role === 'tool').length, batch.length)
}))

test('cold restore repairs a partial ordered commit, including failed results, without replay or duplicate tool history', async () => fixture(async f => {
  const batch = [read(0), read(1), read(2)]
  const engine = await f.start(batch)
  const at = Date.now(); await f.store.appendTurn({ turnId: 'assistant', runId: 'run', turnSeq: 1, role: 'assistant', content: '', toolCallsJson: JSON.stringify(batch), createdAt: at })
  await f.store.saveRunEvidence('run', 'parallel_local_reads:assistant', JSON.stringify({ schemaVersion: 1, turnId: 'assistant' }))
  for (const [i, tool] of batch.entries()) await f.store.upsertToolCall({ toolCallId: tool.id, runId: 'run', turnId: 'assistant', name: tool.name, argsJson: tool.arguments, argsHash: '', status: i === 1 ? 'failed' : 'completed', startedAt: at, completedAt: at, resultJson: JSON.stringify(i === 1 ? { error: '真实失败' } : { content: `完成${i}` }) })
  await f.store.appendTurn({ turnId: 'first', runId: 'run', turnSeq: 2, role: 'tool', content: '完成0', toolResultJson: JSON.stringify({ toolCallId: batch[0].id, content: '完成0' }), createdAt: at })
  f.engine = f.makeEngine([]); await f.engine.restore('run'); await f.engine.restore('run')
  const turns = (await f.engine.getState('run')).turns.filter(t => t.role === 'tool'); assert.deepEqual(turns.map(t => JSON.parse(t.toolResultJson).toolCallId), batch.map(t => t.id)); assert.equal(turns[1].content, '真实失败'); assert.equal(f.calls, 0)
}))

test('a failed explicit retry records its ordered error response before the remaining recovery decisions', async () => fixture(async f => {
  const batch = [read(0), read(1), read(2)]
  await f.start(batch)
  const at = Date.now(); await f.store.appendTurn({ turnId: 'interrupted', runId: 'run', turnSeq: 1, role: 'assistant', content: '', toolCallsJson: JSON.stringify(batch), createdAt: at })
  await f.store.saveRunEvidence('run', 'parallel_local_reads:interrupted', JSON.stringify({ schemaVersion: 1, turnId: 'interrupted' }))
  for (const tool of batch) await f.store.upsertToolCall({ toolCallId: tool.id, runId: 'run', turnId: 'interrupted', name: tool.name, argsJson: tool.arguments, argsHash: '', status: 'running', startedAt: at })
  let fail = true
  f.engine = f.makeEngine([], async (name, args, id, runId, hooks) => { if (id === batch[1].id && fail) { fail = false; throw new Error('第二项真实重试失败') }; return f.host(name, args, id, runId, hooks) })
  await f.engine.restore('run')
  const first = await f.engine.applyRecoveryDecision('run', 'retry_not_applied'); assert.equal(first.ok, false); assert.match(first.error, /第二项真实重试失败/)
  assert.deepEqual((await f.engine.getState('run')).turns.filter(t => t.role === 'tool').map(t => JSON.parse(t.toolResultJson).toolCallId), batch.slice(0, 2).map(t => t.id))
  assert.deepEqual(await f.engine.applyRecoveryDecision('run', 'retry_not_applied'), { ok: true })
  const turns = (await f.engine.getState('run')).turns.filter(t => t.role === 'tool'); assert.deepEqual(turns.map(t => JSON.parse(t.toolResultJson).toolCallId), batch.map(t => t.id)); assert.equal(turns[1].content, '第二项真实重试失败')
}))
