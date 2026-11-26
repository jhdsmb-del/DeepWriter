const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { readFileSync } = require('node:fs')
const path = require('node:path'), os = require('node:os'), http = require('node:http')
const { performance } = require('node:perf_hooks')
const { before, test } = require('node:test')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..'), baselineRef = '72c189913ba04899c55464d95d65013eb3f71178'
const sources = new Map()
let candidate, baseline

function previousSelector(source) {
  // Reproduce the two pre-optimization expressions from 72c1899, not a
  // second selector implementation. No Git/history dependency in ordinary CI.
  const start = source.indexOf('  // Candidates are immutable during this synchronous selection.')
  const end = source.indexOf('  const base = uniqueCandidates(input.base)', start)
  assert(start >= 0 && end > start)
  let before = source.slice(0, start) + "  const tokensFor = (candidate: ContextCandidate): number => candidate.virtual ? 0 : input.policy.management === 'model_auto_v1' ? estimateTokens(JSON.stringify({ role: candidate.role, content: candidate.content })) : candidateTokens(candidate)\n" + source.slice(end)
  assert(before.includes('const projected = selectedTokens + tokensFor(candidate)'))
  before = before.replace('const projected = selectedTokens + tokensFor(candidate)', 'const projected = [...selected.values()].reduce((sum, item) => sum + tokensFor(item), 0) + tokensFor(candidate)')
    .replace(/^  let selectedTokens = 0\r?\n/m, '')
    .replace(/^    selectedTokens = projected\r?\n/m, '')
    .replace(/^          selectedTokens = usedWithoutMemory \+ tokensFor\(stableMemory\)\r?\n/m, '')
  assert(!before.includes('selectedTokens'))
  return before
}

async function production(before = false) {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
    export {createCliRuntime} from './src/cli/runtime'; export {loadCliConfig} from './src/cli/config';
    export {createRepository} from './src/main/db/repository'; export {ContextV2Service,selectContextCandidates} from './src/main/contextV2';
  ` }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, write: false, logLevel: 'silent', plugins: [{ name: 'measured-start-source', setup(builder) {
    builder.onLoad({ filter: /\.ts$/ }, args => {
      if (!sources.has(args.path)) sources.set(args.path, readFileSync(args.path, 'utf8'))
      let text = sources.get(args.path)
      if (before && /[\\/]main[\\/]contextV2\.ts$/.test(args.path)) text = previousSelector(text)
      // Instrument only the in-memory test bundle, at the real returned ACK
      // and the final validated HTTP request call. Never send a probe request.
      if (/[\\/]main[\\/]chatStart\.ts$/.test(args.path)) {
        assert(text.includes('export async function startChatRun('))
        text = text.replace('export async function startChatRun(', 'async function observedStartChatRun(') + `
          export async function startChatRun(...args: Parameters<typeof observedStartChatRun>) {
            const result = await observedStartChatRun(...args); (globalThis as any).__agentStartProbe?.('ack'); return result;
          }`
      }
      if (/[\\/]main[\\/]providerSecurity\.ts$/.test(args.path)) {
        assert(text.includes('const request = requestFn({'))
        text = text.replace('const request = requestFn({', `(globalThis as any).__agentStartProbe?.('fetch'); const request = requestFn({`)
      }
      if (/[\\/]main[\\/]contextV2\.ts$/.test(args.path)) {
        assert(text.includes('export function selectContextCandidates(input:'))
        text = text.replace('export function selectContextCandidates(input:', 'function observedSelectContextCandidates(input:') + `
          export function selectContextCandidates(input: Parameters<typeof observedSelectContextCandidates>[0]) {
            const started = performance.now(); try { return observedSelectContextCandidates(input) }
            finally { (globalThis as any).__agentStartProbe?.('selection', performance.now() - started) }
          }`
      }
      return { contents: text, loader: 'ts', resolveDir: path.dirname(args.path) }
    })
  } }] })
  const module = { exports: {} }; new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports)
  return module.exports
}
before(async () => { candidate = await production(); baseline = await production(true) })

function selectionInput(mode, budget, automatic, memory) {
  const history = Array.from({ length: 400 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `历史${index}。` + '明确的旧约定和可查来源。'.repeat(14),
    required: false, order: index + 20, timestamp: index, bundleId: 'bundle-' + Math.floor(index / 2),
    source: { sourceType: 'recent_turn', canonicalId: 'history-' + index, revision: index, contentHash: 'synthetic-' + index, span: null, displayLabel: '原文' + index }
  }))
  return { mode, budgetTokens: budget, policy: { management: automatic ? 'model_auto_v1' : undefined, recentBundles: { optimized: 6, minimal: 2 }, retrieval: { enabled: true, algorithm: 'bm25-local-v1', maxItems: 6, maxEstimatedTokens: 12000, minScore: .05 } }, query: '旧约定',
    base: [{ ...history[0], required: true, role: 'system', content: '固定的安全边界。', source: { ...history[0].source, canonicalId: 'policy', sourceType: 'static_system' } }], history,
    summary: memory ? { ...history[0], role: 'user', content: '固定摘要。', memoryItems: Array.from({ length: 12 }, (_, index) => ({ itemId: 'quote-' + index, section: 'goal', sourceRole: 'user', confirmation: 'extractive_source', contentHash: 'quote', text: '旧约定摘录' + index, sources: [{ kind: 'message', id: 'history-' + index, revision: index, hash: 'synthetic-' + index, spanStart: 0, spanEnd: 8 }] })), source: { ...history[0].source, sourceType: 'rolling_summary', canonicalId: 'summary' } } : null,
    ...(memory ? { memoryBudgetTokens: 2048 } : {}) }
}

test('same selection, estimates, source decisions and overflow errors with fitting/pressured history, memory and legacy modes', () => {
  for (const automatic of [true, false]) for (const mode of ['full', 'minimal', 'optimized']) for (const budget of [1, 4096, 131072]) for (const memory of [true, false]) {
    const input = selectionInput(mode, budget, automatic, memory)
    let before, after, beforeError, afterError
    try { before = baseline.selectContextCandidates(input) } catch (error) { beforeError = { name: error.name, code: error.code, message: error.message, details: error.details } }
    try { after = candidate.selectContextCandidates(input) } catch (error) { afterError = { name: error.name, code: error.code, message: error.message, details: error.details } }
    assert.deepEqual(afterError, beforeError); assert.deepEqual(after, before)
  }
})

test('a subsequent selection recalculates changed content on the same object rather than retaining a stale budget result', () => {
  const input = selectionInput('optimized', 4096, true, false)
  input.history = []
  const initial = candidate.selectContextCandidates(input)
  input.base[0].content = '新增且必须保留的用户边界。'.repeat(600)
  assert(initial.selectedEstimate < 4096)
  assert.throws(() => candidate.selectContextCandidates(input), error => error.code === 'context_required_overflow')
})

async function run(api, home, variant, baseUrl, requests, serverTimes, historyMessages = 400) {
  const dataDir = path.join(home, variant); await fs.mkdir(dataDir)
  const repo = api.createRepository(path.join(dataDir, 'deepwriter.sqlite')); repo.open()
  for (const session of ['cold', 'warm']) {
    repo.createSession(session, 'Identical long history', 'start-fixture')
    for (let seq = 1; seq <= historyMessages; seq++) repo.appendSessionMessage({ msg_id: session + '-history-' + seq, session_id: session, seq, role: seq % 2 ? 'user' : 'assistant', status: 'done', created_at: seq, content: `历史 ${seq}：` + '具体原文与用户边界必须保留。'.repeat(14) })
  }
  repo.close()
  const options = { 'base-url': baseUrl, protocol: 'openai-chat', model: 'start-fixture', loopback: true, context: '131072', 'max-tokens': '256', 'work-dir': home, 'doc-dir': home, 'no-web': true, 'tool-support': true, 'key-env': 'DW_AGENT_START_NO_KEY' }
  const { config } = await api.loadCliConfig(dataDir, options)
  let started = 0, metrics
  const initializationStarted = performance.now()
  const runtime = await api.createCliRuntime({ dataDir, config, secret: '', options, emit: (kind, value) => {
    if (!metrics || kind !== 'event') return
    if (value.type === 'phase' && value.phase === 'executing_tool') metrics.firstToolMs ??= performance.now() - started
  } })
  const initializationMs = performance.now() - initializationStarted, result = []
  try {
    for (const session of ['cold', 'warm']) {
      const offset = requests.length
      metrics = { variant, temperature: session === 'cold' ? 'first request on newly initialized runtime' : 'second request on already initialized runtime', historyMessages, initializationMs: Number(initializationMs.toFixed(2)), ackMs: null, fetchMs: null, firstToolMs: null, selectionMs: 0, selectionCalls: 0 }
      started = performance.now()
      globalThis.__agentStartProbe = (phase, duration) => {
        if (phase === 'selection') { metrics.selectionMs += duration; metrics.selectionCalls++ }
        else if (phase === 'fetch') metrics.fetchMs ??= performance.now() - started
        else if (phase === 'ack') metrics.ackMs ??= performance.now() - started
      }
      await runtime.agent('读取 fixture.md 并核对已提供的会话原文。', session)
      delete globalThis.__agentStartProbe
      assert.equal(runtime.repo.listRecentRuns(1)[0].status, 'completed')
      assert.equal(requests.length - offset, 2)
      const bodies = requests.slice(offset).map(raw => JSON.parse(raw))
      assert.equal(bodies[0].tools.length, bodies[1].tools.length)
      assert(bodies[0].tools.some(tool => tool.function.name === 'read_file'))
      assert(bodies[0].tools.some(tool => tool.function.name === 'write_file'))
      assert(bodies[0].tools.some(tool => tool.function.name === 'update_work_plan'))
      assert(bodies[0].tools.some(tool => tool.function.name === 'search_conversation'))
      assert.equal(runtime.repo.getUsageTotals(runtime.repo.listRecentRuns(1)[0].run_id).output_tokens, 20)
      metrics.httpReceivedMs = serverTimes[offset].received - started
      metrics.fixtureOutputStartedMs = serverTimes[offset].output - started
      metrics.totalMs = performance.now() - started
      assert(metrics.fetchMs >= metrics.ackMs, 'durable ACK precedes actual HTTP; no speculative paid request')
      result.push({ metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, typeof value === 'number' ? Number(value.toFixed(2)) : value])), raw: requests.slice(offset) })
    }
    return result
  } finally { delete globalThis.__agentStartProbe; await runtime.close() }
}

test('real CLI start separates durable ACK, first validated HTTP request, provider fixture output and durable tool-start; cold/warm input is identical', { timeout: 60000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-agent-start-'))
  const requests = [], times = [], errors = []
  const server = http.createServer((req, res) => { let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
    try {
      const body = JSON.parse(raw), index = requests.length; requests.push(raw); times.push({ received: performance.now() })
      const tool = body.messages.some(message => message.role === 'tool')
      setTimeout(() => {
        times[index].output = performance.now(); res.writeHead(200, { 'content-type': 'text/event-stream' })
        const delta = tool ? { content: '已核对本地文件与会话。' } : { tool_calls: [{ index: 0, id: 'read-first', type: 'function', function: { name: 'read_file', arguments: '{"path":"fixture.md"}' } }] }
        res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: tool ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n')
      }, 20)
    } catch (error) { errors.push(error); res.writeHead(500); res.end() }
  }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await fs.writeFile(path.join(home, 'fixture.md'), '只读、本地、同一文件内容。\n')
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const before = await run(baseline, home, 'before', baseUrl, requests, times)
    const after = await run(candidate, home, 'after', baseUrl, requests, times)
    const shortBefore = await run(baseline, home, 'short-before', baseUrl, requests, times, 0)
    const shortAfter = await run(candidate, home, 'short-after', baseUrl, requests, times, 0)
    for (const [oldRequests, newRequests] of [[before, after], [shortBefore, shortAfter]]) {
      assert.equal(oldRequests[0].raw[0] === oldRequests[1].raw[0], true, 'cold and warm use identical first-provider input bytes')
      for (let i = 0; i < oldRequests.length; i++) {
        assert.equal(newRequests[i].raw.length, oldRequests[i].raw.length)
        for (let request = 0; request < oldRequests[i].raw.length; request++) {
          const left = oldRequests[i].raw[request], right = newRequests[i].raw[request]
          let common = 0; while (common < Math.min(left.length, right.length) && left[common] === right[common]) common++
          assert.equal(right === left, true, `actual HTTP body ${request + 1} changed at ${common}: before=${JSON.stringify(left.slice(common, common + 120))}; after=${JSON.stringify(right.slice(common, common + 120))}`)
        }
        t.diagnostic(JSON.stringify({ before: oldRequests[i].metrics, after: newRequests[i].metrics }))
      }
    }
    assert.deepEqual(errors, [])
    const evidenceDir = path.join(root, 'out/agent-start-latency'); await fs.mkdir(evidenceDir, { recursive: true })
    await fs.writeFile(path.join(evidenceDir, 'comparison.json'), JSON.stringify({ baselineRef, baselineMethod: 'same source snapshot with only per-selection token memoization and incremental selected sum reverted to 72c1899 expressions', units: 'local monotonic milliseconds; fetch is the validated Node HTTP request call; firstTool is durable executing_tool phase, not provider output throughput', providerFixtureDelayMs: 20, before, after, shortBefore, shortAfter, outboundBodiesByteIdentical: true }, null, 2))
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(home), os.tmpdir()); assert.match(path.basename(home), /^dw-agent-start-/); await fs.rm(home, { recursive: true, force: true }) }
})
