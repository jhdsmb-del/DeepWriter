const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { readFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { once } = require('node:events')
const { performance } = require('node:perf_hooks')
const { before, test } = require('node:test')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..')
// Reuse one source snapshot for a controlled comparison, even while another
// owner is editing provider code. Only these two stream hot paths may differ.
const sources = new Map()
async function loadApi(baseline) {
  if (baseline) assert.match(baseline, /^[a-f0-9]{40}$/)
  const replacements = new Map(baseline ? ['src/main/jobs/AgentRunEngine.ts', 'src/main/runKernelAdapter.ts'].map(file => [path.join(root, file), execFileSync('git', ['show', baseline + ':' + file], { cwd: root, encoding: 'utf8', maxBuffer: 4000000 })]) : [])
  const built = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
  export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
  export {streamText,appendStreamText} from './src/main/jobs/streamText';
  export {createRepository} from './src/main/db/repository';
  export {createRunStorePort,createModelCallAdapter,createChunkTranslator} from './src/main/runKernelAdapter';
  export {createStreamBatcher} from './src/renderer/src/streamBatcher';
` }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', plugins: [{ name: 'stable-stream-source', setup(build) {
    build.onLoad({ filter: /\.ts$/ }, args => {
      if (!sources.has(args.path)) sources.set(args.path, readFileSync(args.path, 'utf8'))
      return { contents: replacements.get(args.path) ?? sources.get(args.path), loader: 'ts', resolveDir: path.dirname(args.path) }
    })
  } }] })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
  return loaded.exports
}
let api
before(async () => { api = await loadApi() })
const immediate = () => new Promise(resolve => setImmediate(resolve))
// Fixed Unicode code points and UTF-16 sizes, never inferred model tokens.
const body = '中文😀𠀀正文。\n'.repeat(8192)
const reasoning = '推理😀𠀀证据。\n'.repeat(8192)
const split = (value, size) => { const parts = []; for (let i = 0; i < value.length; i += size) parts.push(value.slice(i, i + size)); return parts }

async function runStream({ loopback = false, chunkUnits = 8 } = {}, runtime = api) {
  const api = runtime
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-stream-throughput-'))
  const repo = api.createRepository(path.join(dir, 'run.db')); repo.open()
  const store = api.createRunStorePort(repo, path.join(dir, 'artifacts'))
  let writes = 0, writtenUnits = 0, snapshots = 0, snapshotUnits = 0, modelDeltas = 0, requests = 0
  let firstVisibleMs = null, firstVisibleBeforeFinish = false, producerFinished = false, engine, server
  const append = store.appendTurn.bind(store)
  store.appendTurn = async turn => { if (turn.role === 'assistant') { writes++; writtenUnits += turn.content.length + (turn.reasoningContent?.length ?? 0) }; await append(turn) }
  const translate = api.createChunkTranslator(), projected = [], rendered = []
  const batcher = api.createStreamBatcher(event => rendered.push(event.ev))
  const runId = 'stream-throughput', sessionId = 'stream-session'
  const config = { runMode: 'agent', model: 'local-stream', maxTurns: null, maxTokens: 4096, workBudgetPolicy: 'explicit_v1', providerCallBudget: { maxCalls: null, maxTokens: null, maxWallClockMs: null, maxCost: null, maxCostCny: null } }
  const fragments = [...split(reasoning, chunkUnits).map(delta => ({ type: 'reasoning', delta })), ...split(body, chunkUnits).map(delta => ({ type: 'text', delta }))]
  let modelCall
  if (loopback) {
    server = http.createServer(async (request, response) => {
      request.resume(); await once(request, 'end'); requests++
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of fragments) {
        const delta = event.type === 'text' ? { content: event.delta } : { reasoning_content: event.delta }
        if (!response.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n')) await once(response, 'drain')
        await immediate()
      }
      producerFinished = true
      response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 37, completion_tokens: 101, total_tokens: 138 } }) + '\n\ndata: [DONE]\n\n')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    config.baseUrl = baseUrl
    const adapter = api.createModelCallAdapter({ getApi: () => ({ apiKey: '', baseUrl, model: config.model, maxTokens: 4096, temperature: 1, topP: 1, thinking: { enabled: true, effort: 'default' }, supportsTools: false, adapterId: 'builtin.deepseek', protocol: 'deepseek-chat', chatPath: '/chat/completions', authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } }), getConfig: () => config, getSignal: () => engine.abortSignal(runId), buildPrefix: async () => [] })
    modelCall = async input => { const stream = await adapter(input); return (async function* () { for await (const event of stream) { if (event.type === 'text' || event.type === 'reasoning') modelDeltas++; yield event } })() }
  } else modelCall = async () => (async function* () { for (const event of fragments) { modelDeltas++; yield event }; producerFinished = true; yield { type: 'usage', usage: { inputTokens: 37, outputTokens: 101 } }; yield { type: 'finish', finishReason: 'stop' } })()
  const started = performance.now()
  engine = api.createAgentRunEngine({ store, modelCall, getConfig: () => config, toolExecutor: async () => '', onRunUpdate: () => {}, onEvent: (id, event) => {
    if (event.type === 'turn') { snapshots++; snapshotUnits += event.turn.content.length + (event.turn.reasoningContent?.length ?? 0) }
    for (const chunk of translate(event, id)) {
      projected.push(chunk); batcher.push({ id, ev: chunk })
      if (firstVisibleMs === null && (chunk.type === 'text' || chunk.type === 'reasoning')) { firstVisibleMs = performance.now() - started; firstVisibleBeforeFinish = !producerFinished }
    }
  } })
  try {
    await engine.start({ runId, sessionId, config }); await engine.step(runId); batcher.flush()
    const elapsedMs = performance.now() - started
    const turns = await store.getTurns(runId), assistant = turns.find(turn => turn.role === 'assistant')
    assert.equal((await engine.getState(runId)).run.status, 'completed')
    assert.equal(assistant.content, body); assert.equal(assistant.reasoningContent, reasoning)
    assert.equal(projected.filter(event => event.type === 'text').map(event => event.delta).join(''), body)
    assert.equal(projected.filter(event => event.type === 'reasoning').map(event => event.delta).join(''), reasoning)
    assert.equal(rendered.filter(event => event.type === 'text').map(event => event.delta).join(''), body)
    assert.equal(rendered.filter(event => event.type === 'reasoning').map(event => event.delta).join(''), reasoning)
    assert.equal(rendered.filter(event => event.type === 'done' && event.finishReason === 'stop').length, 1)
    assert.equal(firstVisibleBeforeFinish, true)
    const usage = JSON.parse(repo.getRunEvidence(runId, 'run_provider_budget_v1').json)
    assert.equal(usage.totalCalls, 1)
    assert.equal(await store.getUsageTotalTokens(runId), 138, 'only the actual supplied usage counts as tokens')
    return { path: loopback ? 'loopback SSE → adapter → engine → SQLite → translator → renderer batcher' : 'AsyncIterable → engine → SQLite → translator → renderer batcher', chunkUtf16Units: chunkUnits, bodyCodePoints: Array.from(body).length, reasoningCodePoints: Array.from(reasoning).length, inputFragments: fragments.length, modelDeltas, requests, elapsedMs: Number(elapsedMs.toFixed(2)), firstVisibleMs: Number(firstVisibleMs.toFixed(2)), writes, writtenUtf16Units: writtenUnits, snapshots, snapshotUtf16Units: snapshotUnits, projectedEvents: projected.length, renderedEvents: rendered.length }
  } finally {
    batcher.cancel(); repo.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    assert.equal(path.dirname(dir), os.tmpdir()); assert.match(path.basename(dir), /^dw-stream-throughput-/); await fs.rm(dir, { recursive: true, force: true })
  }
}

test('same long Unicode body/reasoning survives small streaming chunks on the production engine and real local SSE path', { timeout: 120000 }, async t => {
  const candidates = process.env.DW_STREAM_COMPARE ? [['baseline', await loadApi(process.env.DW_STREAM_COMPARE)], ['candidate', api]] : [['candidate', api]]
  for (const [candidate, runtime] of candidates) for (const loopback of [false, true]) {
    const metrics = await runStream({ loopback }, runtime)
    t.diagnostic(JSON.stringify({ candidate, ...metrics }))
  }
})

test('incremental writing limits match full code-point slicing, including pairs split at the limit', () => {
  for (const initial of ['', '旧😀稿', '\ud83d']) for (const source of ['甲😀𠀀乙\r\n丙。', '\ud83d\ude00\ud83d甲\udc00乙', '   正文。']) for (let size = 1; size <= 7; size++) for (let limit = 0; limit <= source.length + 1; limit++) {
    let current = api.streamText(initial), expected = initial
    for (const delta of split(source, size)) {
      const before = expected + delta
      expected = Array.from(before).slice(0, limit).join('')
      current = api.appendStreamText(current, delta, limit)
      assert.equal(current.text, expected); assert.equal(current.codePoints, Array.from(expected).length)
      assert.equal(current.clipped, before !== expected)
    }
  }
})

test('checkpoint projection preserves split surrogates, duplicate/shrinking snapshots, tools, replacement and terminal order', () => {
  const translate = api.createChunkTranslator(), events = []
  const turn = (content, reasoningContent) => events.push(...translate({ type: 'turn', turn: { role: 'assistant', turnId: 'one', content, reasoningContent } }, 'run'))
  turn('首\ud83d', '思\ud840'); turn('首😀', '思𠀀'); turn('首😀', '思𠀀'); turn('首', '')
  assert.equal(events.filter(e => e.type === 'text').map(e => e.delta).join(''), '首😀')
  assert.equal(events.filter(e => e.type === 'reasoning').map(e => e.delta).join(''), '思𠀀')
  events.push(...translate({ type: 'tool', toolCall: { toolCallId: 'tool', name: 'read_file', argsJson: '{}', status: 'requested' } }, 'run'))
  events.push(...translate({ type: 'content_replace', content: '修订。', revision: 2 }, 'run'))
  events.push(...translate({ type: 'terminal', run: { status: 'completed' } }, 'run'))
  assert.deepEqual(events.slice(-3).map(e => e.type), ['tool_call', 'text_replace', 'done'])
  assert.equal(translate({ type: 'turn', turn: { role: 'assistant', content: '迟到' } }, 'run').length, 0)
})

test('first reasoning/text is durable immediately and pause/cancel drains the exact received tail; cold resume retains it', async () => {
  for (const action of ['pause', 'cancel']) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-stream-boundary-'))
    const repo = api.createRepository(path.join(dir, 'run.db')); repo.open()
    const store = api.createRunStorePort(repo), runId = 'boundary-' + action
    const config = { runMode: 'agent', model: 'fixture', maxTurns: null, workBudgetPolicy: 'explicit_v1', cancelFallbackMs: 1, providerCallBudget: { maxCalls: null, maxTokens: null, maxCost: null, maxWallClockMs: null } }
    let engine, release, reached, firstText = false, firstReasoning = false
    const parked = new Promise(resolve => { reached = resolve })
    const options = { store, getConfig: () => config, toolExecutor: async () => '', onRunUpdate: () => {}, onEvent: (_id, event) => {
      if (event.type !== 'turn') return
      if (event.turn.reasoningContent === '思') firstReasoning = true
      if (event.turn.content === '首') firstText = true
    }, modelCall: async () => (async function* () {
      yield { type: 'reasoning', delta: '思' }; yield { type: 'text', delta: '首' }
      assert.equal(firstReasoning, true); assert.equal(firstText, true, 'first text must not wait for another 4K or 250ms')
      yield { type: 'reasoning', delta: '😀尾' }; yield { type: 'text', delta: '𠀀尾' }
      reached()
      await new Promise(resolve => { release = resolve; engine.abortSignal(runId).addEventListener('abort', resolve, { once: true }) })
    })() }
    engine = api.createAgentRunEngine(options)
    try {
      await engine.start({ runId, sessionId: 'session', config })
      const running = engine.step(runId)
      await parked
      await engine[action](runId); await running
      const turn = (await store.getTurns(runId)).find(t => t.role === 'assistant')
      assert.equal(turn.content, '首𠀀尾'); assert.equal(turn.reasoningContent, '思😀尾')
      assert.equal((await engine.getState(runId)).run.status, action === 'pause' ? 'waiting_user' : 'cancelled')
      if (action === 'pause') {
        const cold = api.createAgentRunEngine({ ...options, modelCall: async () => (async function* () { yield { type: 'text', delta: '续。' }; yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 9 } }; yield { type: 'finish', finishReason: 'stop' } })() })
        await cold.restore(runId); await cold.step(runId)
        const resumed = (await store.getTurns(runId)).filter(t => t.role === 'assistant').map(t => t.content).join('')
        assert.equal(resumed, '首𠀀尾续。'); assert.equal((await cold.getState(runId)).run.status, 'completed')
        assert.equal(await store.getUsageTotalTokens(runId), 16)
      }
    } finally { release?.(); repo.close(); assert.equal(path.dirname(dir), os.tmpdir()); assert.match(path.basename(dir), /^dw-stream-boundary-/); await fs.rm(dir, { recursive: true, force: true }) }
  }
})
