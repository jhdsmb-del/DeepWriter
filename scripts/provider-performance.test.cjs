const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')
const { before, test } = require('node:test')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
before(async () => {
  const built = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
    export {streamChat} from './src/main/deepseek';
    export {providerRequestBody} from './src/main/providerAdapters';
    export * from './src/main/providerPerformance';
    export {createModelCallAdapter,createChunkTranslator,createRunStorePort} from './src/main/runKernelAdapter';
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {createRepository} from './src/main/db/repository';
    export {configureTerminalHost} from './src/cli/host';` },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent',
    alias: { electron: path.join(root, 'src/cli/host.ts') } })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports)
  api = module.exports
})

test('DeepSeek ordinary writer preserves the exact outbound messages/tools prefix over two real local requests', async t => {
  const captured = []
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    captured.push(JSON.parse(raw))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    sse(res, { choices: [{ delta: { content: '本地答复。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } })
    sse(res, '[DONE]'); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const input = params(baseUrl)
    const config = { sessionId: 'prefix-session', runMode: 'agent', frozenSystemMessages: [{ role: 'system', content: '不执行未授权操作；保持事实准确。'.repeat(100) }],
      memory: { projectContent: '冻结项目记忆', userContent: '冻结用户记忆' }, toolPolicy: { allowList: ['read_file'] } }
    const adapter = api.createModelCallAdapter({
      getApi: () => ({ ...input, profileId: 'prefix-profile', providerId: 'prefix-provider', adapterId: input.provider.adapterId,
        protocol: input.provider.protocol, chatPath: input.provider.chatPath, authStyle: input.provider.authStyle, transportPolicy: input.provider.transportPolicy,
        supportsTools: true, temperature: 1, topP: 1 }),
      // The production buildRunPrefix frozen branch emits these immutable
      // system/memory bytes; no attachments or mutable legacy fallback here.
      buildPrefix: async config => [...config.frozenSystemMessages, { role: 'system', content: `## 用户记忆\n${config.memory.userContent}` }],
      getConfig: () => config, getSignal: () => undefined
    })
    const initial = [{ role: 'user', content: '读取指定文件并回答。' }]
    for (const round of [1, 2]) {
      const messages = round === 1 ? initial : [...initial,
        { role: 'assistant', content: '', tool_calls: [{ id: 'frozen-call-1', name: 'read_file', arguments: '{"path":"C:/fixture.txt"}' }] },
        { role: 'tool', tool_call_id: 'frozen-call-1', content: '合成文件正文' }]
      for await (const _ of await adapter({ runId: 'prefix-run', phase: 'thinking', turnSeq: round * 2, round, messages })) { /* drain real wire */ }
    }
    assert.equal(captured.length, 2)
    const [first, second] = captured
    const frozenPrefix = JSON.stringify(first.messages)
    assert.equal(JSON.stringify(second.messages.slice(0, first.messages.length)), frozenPrefix)
    assert.equal(JSON.stringify(first.tools), JSON.stringify(second.tools))
    assert.ok(first.tools.length > 0)
    assert.equal(second.messages.at(-2).tool_calls[0].function.name, 'read_file')
    assert.equal(second.messages.at(-1).tool_call_id, 'frozen-call-1')
    assert.ok(!JSON.stringify(second.messages).includes('prefix-run'))
    assert.equal(first.prompt_cache_key, undefined); assert.equal(second.prompt_cache_key, undefined)
    t.diagnostic(`DeepSeek two requests: ${Buffer.byteLength(frozenPrefix)} byte identical messages prefix; ${Buffer.byteLength(JSON.stringify(first.tools))} byte identical tools; no vendor cache directives added`)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const key = 'synthetic-performance-key'
const params = (baseUrl, protocol = 'deepseek-chat', chatPath = '/chat/completions') => ({
  apiKey: key, baseUrl, model: 'fixture-model', messages: [{ role: 'system', content: '稳定系统前缀。' }, { role: 'user', content: '本地测试' }],
  thinking: { enabled: false, effort: 'high' }, maxTokens: 128,
  provider: { adapterId: 'custom.openai-compatible-chat', protocol, chatPath, authStyle: 'bearer',
    transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true }, reasoning: { mode: 'default', effort: null }, compatibilityMappingId: null }
})
const sse = (res, data, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)

test('estimates count visible characters, not SSE chunks; rolling window and retry reset are reproducible', () => {
  const result = fragments => {
    let at = 0
    const samples = []
    const sampler = api.createProviderPerformance(s => samples.push(s), () => at, 'fixture-request')
    sampler.lifecycle({ type: 'started', innerAttempt: 1, startedAt: 1000 })
    at = 100
    for (const delta of fragments) sampler.chunk({ type: 'text', delta })
    // Identical cumulative tool snapshots must not count twice.
    sampler.chunk({ type: 'tool_call', tool: { index: 0, name: 'read', arguments: '{}', id: 'tool1' } })
    sampler.chunk({ type: 'tool_call', tool: { index: 0, name: 'read', arguments: '{}', id: 'tool1' } })
    at = 500
    sampler.lifecycle({ type: 'terminal', innerAttempt: 1, outcome: 'success', performanceUsage: api.readPerformanceUsage('openai-chat', { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } } }) })
    const terminal = samples.at(-1)
    assert.equal(terminal.ttftMs, 100)
    assert.equal(terminal.estimatedTokensPerSecond, terminal.windowOutputTokens * 1000 / terminal.windowMs)
    assert.equal(terminal.actualTokensPerSecond, 40)
    assert.equal(terminal.cache.hitRate, 0)
    at = 700
    sampler.lifecycle({ type: 'started', innerAttempt: 2, startedAt: 1700 })
    assert.equal(samples.at(-1).estimatedOutputTokens, 0)
    assert.equal(samples.at(-1).ttftMs, null)
    assert.equal(samples.at(-1).cache.status, 'unknown')
    assert.ok(samples.at(-1).revision > terminal.revision)
    sampler.close()
    return terminal.estimatedOutputTokens
  }
  assert.equal(result(['缓存abcd😀']), result(['缓', '存', 'a', 'b', 'c', 'd', '😀']))
})

test('cache facts distinguish unknown/zero, OpenAI inclusive input and Anthropic sparse uncached+write+read', () => {
  const read = api.readPerformanceUsage
  assert.equal(read('openai-chat', { usage: { prompt_tokens: 100, completion_tokens: 20 } }).cache.hitRate, null)
  const zero = read('openai-chat', { usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } } })
  assert.equal(zero.cache.status, 'reported'); assert.equal(zero.cache.hitRate, 0); assert.equal(zero.cache.missTokens, 100)
  const hit = read('openai-responses', { response: { usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 } } } })
  assert.equal(hit.cache.hitRate, 0.6); assert.equal(hit.cache.missTokens, 40); assert.equal(hit.cache.writeTokens, 20)
  const empty = read('deepseek-chat', { usage: { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 } })
  assert.equal(empty.cache.status, 'reported'); assert.equal(empty.cache.hitRate, null)
  assert.equal(read('openai-chat', { usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } } }).cache.status, 'unknown')
  const start = read('anthropic-messages', { message: { usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 60, cache_creation_input_tokens: 30 } } })
  const end = read('anthropic-messages', { usage: { output_tokens: 12 } }, start)
  assert.equal(end.inputTokens, 110); assert.equal(end.outputTokens, 12)
  assert.equal(end.cache.hitTokens, 60); assert.equal(end.cache.missTokens, 50); assert.equal(end.cache.writeTokens, 30)
  assert.equal(end.cache.hitRate, 60 / 110)
})

test('official older OpenAI uses a stable prefix key across turns; no proxy/new-model/TTL/prewarm assumptions', () => {
  for (const protocol of ['openai-chat', 'openai-responses']) {
    const input = params('https://api.openai.com', protocol, protocol === 'openai-chat' ? '/v1/chat/completions' : '/v1/responses')
    input.model = 'gpt-5.4'
    const first = api.providerRequestBody(input, protocol)
    const second = api.providerRequestBody({ ...input, apiKey: 'replaced-synthetic-key', messages: [...input.messages, { role: 'assistant', content: '已有回复' }, { role: 'user', content: '继续' }] }, protocol)
    assert.match(first.prompt_cache_key, /^dw-prefix-[a-f0-9]{48}$/)
    assert.equal(first.prompt_cache_key, second.prompt_cache_key)
    assert.equal(first.prompt_cache_retention, undefined); assert.equal(first.prompt_cache_options, undefined)
    assert.deepEqual(protocol === 'openai-chat' ? first.messages : first.input, input.messages)
    assert.equal(api.providerRequestBody({ ...input, baseUrl: 'https://proxy.example.org' }, protocol).prompt_cache_key, undefined)
    assert.equal(api.providerRequestBody({ ...input, model: 'gpt-6.2-astra' }, protocol).prompt_cache_key, undefined)
    assert.equal(api.providerRequestBody({ ...input, model: 'arbitrary-alias' }, protocol).prompt_cache_key, undefined)
    assert.notEqual(api.providerRequestBody({ ...input, messages: [{ role: 'system', content: '另一个前缀' }, ...input.messages.slice(1)] }, protocol).prompt_cache_key, first.prompt_cache_key)
  }
})

test('real delayed loopback SSE across four protocols streams before terminal and reports actual cache/TPS separately', async t => {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    requests.push({ path: req.url, body: JSON.parse(raw), authorization: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders()
    await sleep(110)
    if (req.url === '/messages') {
      sse(res, { type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 60, cache_creation_input_tokens: 30 } } }, 'message_start')
      sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '思' } }, 'content_block_delta')
    } else if (req.url === '/responses') sse(res, { type: 'response.reasoning_summary_text.delta', delta: '思' }, 'response.reasoning_summary_text.delta')
    else sse(res, { choices: [{ delta: { reasoning_content: '思' } }] })
    await sleep(230)
    if (req.url === '/messages') sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '真实流式abcd😀' } }, 'content_block_delta')
    else if (req.url === '/responses') sse(res, { type: 'response.output_text.delta', delta: '真实流式abcd😀' }, 'response.output_text.delta')
    else sse(res, { choices: [{ delta: { content: '真实流式abcd😀' } }] })
    await sleep(220)
    if (req.url === '/messages') {
      sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }, 'message_delta')
      sse(res, { type: 'message_stop' }, 'message_stop')
    } else if (req.url === '/responses') sse(res, { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 12, input_tokens_details: { cached_tokens: 60 } } } }, 'response.completed')
    else {
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: req.url === '/deepseek' ? { prompt_tokens: 100, completion_tokens: 12, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } : { prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 60 } } })
      sse(res, '[DONE]')
    }
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    for (const [protocol, pathname] of [['deepseek-chat', '/deepseek'], ['openai-chat', '/chat'], ['openai-responses', '/responses'], ['anthropic-messages', '/messages']]) {
      const events = []
      const lifecycle = []
      const reply = await api.streamChat(params(baseUrl, protocol, pathname), event => events.push({ ...event, observedAt: performance.now() }), undefined, undefined, undefined, e => lifecycle.push(e))
      if (protocol.startsWith('openai-')) {
        assert.equal(reply.usage.cache_tokens_known, true)
        assert.equal(reply.usage.prompt_cache_hit_tokens, 60)
        assert.equal(reply.usage.prompt_cache_miss_tokens, 40)
        assert.equal(lifecycle.at(-1).usage.prompt_cache_hit_tokens, 60)
        assert.equal(lifecycle.at(-1).usage.prompt_cache_miss_tokens, 40)
      }
      const samples = events.filter(e => e.type === 'performance').map(e => e.performance)
      const done = samples.at(-1)
      assert.equal(samples[0].status, 'waiting'); assert.equal(samples[0].estimatedTokensPerSecond, null)
      assert.equal(done.status, 'completed'); assert.equal(done.outputTokens, 12)
      assert.ok(done.ttftMs >= 80 && done.ttftMs < done.elapsedMs)
      assert.equal(done.actualTokensPerSecond, 12000 / done.elapsedMs)
      assert.equal(done.estimatedTokensPerSecond, done.windowOutputTokens * 1000 / done.windowMs)
      assert.equal(done.cache.hitTokens, 60); assert.equal(done.cache.status, 'reported')
      assert.equal(done.cache.hitRate, protocol === 'anthropic-messages' ? 60 / 110 : 0.6)
      assert.ok(samples.some(s => s.status === 'streaming' && s.outputTokens === null && s.estimatedTokensPerSecond !== null))
      assert.ok(events.findIndex(e => e.type === 'text') < events.findIndex(e => e.type === 'done'))
      assert.equal(events.filter(e => e.type === 'text').map(e => e.delta).join(''), '真实流式abcd😀')
      assert.ok(!JSON.stringify(samples).includes(key))
      assert.equal(samples.filter(s => ['completed', 'failed', 'cancelled'].includes(s.status)).length, 1)
      t.diagnostic(`${protocol}: local TTFT ${done.ttftMs.toFixed(1)}ms, elapsed ${done.elapsedMs.toFixed(1)}ms; ${done.estimatedOutputTokens} estimated vs ${done.outputTokens} reported output tokens`)
    }
    assert.equal(requests.length, 4); assert.ok(requests.every(request => request.authorization === `Bearer ${key}`))
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('cancel/error/preflight-rejection end sampling without inventing tokens or extra requests', async () => {
  let requests = 0
  const server = http.createServer(async (req, res) => {
    requests++
    if (req.url === '/error') { res.writeHead(401); res.end('synthetic denied'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders()
    sse(res, { choices: [{ delta: { content: '首字' } }] })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    for (const protocol of ['deepseek-chat', 'openai-chat']) {
      const samples = []; const controller = new AbortController()
      await assert.rejects(api.streamChat(params(url, protocol), event => {
        if (event.type === 'performance') samples.push(event.performance)
        if (event.type === 'text') controller.abort()
      }, controller.signal))
      assert.equal(samples.at(-1).status, 'cancelled'); assert.equal(samples.at(-1).outputTokens, null)
      const count = samples.length; await sleep(300); assert.equal(samples.length, count)
    }
    const failed = []
    await assert.rejects(api.streamChat(params(url, 'openai-chat', '/error'), e => { if (e.performance) failed.push(e.performance) }))
    assert.equal(failed.at(-1).status, 'failed'); assert.equal(failed.at(-1).ttftMs, null)
    assert.equal(failed.at(-1).actualTokensPerSecond, null)
    const count = requests; const rejected = []
    await assert.rejects(api.streamChat(params(url, 'openai-chat'), e => rejected.push(e), undefined, undefined, undefined, undefined, async () => { await sleep(25); throw new Error('fixture budget denial') }))
    assert.equal(requests, count); assert.equal(rejected.length, 0)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('kernel queue coalesces only adjacent pending deltas, preserves first/tail/finish and scope through engine → desktop translator', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-performance-'))
  api.configureTerminalHost({ dataDir: dir, docDir: dir })
  const repo = api.createRepository(path.join(dir, 'fixture.db')); repo.open()
  const runId = 'performance-run'
  const config = { sessionId: 'performance-session', runMode: 'agent', model: 'fixture-model', maxTokens: 128, maxTurns: 2, providerCallBudget: { maxTokens: 100000, maxWallClockMs: 300000 } }
  const scopeEvents = []; const chunks = []; const translate = api.createChunkTranslator()
  let deltaEvents = 0; let engine; let firstObserved = false
  const modelCall = api.createModelCallAdapter({
    getApi: () => ({ profileId: 'fixture-profile', apiKey: key, baseUrl: 'https://fixture.invalid', model: 'fixture-model', maxTokens: 128, thinking: { enabled: false, effort: 'high' }, temperature: 1, topP: 1 }),
    buildPrefix: async () => [{ role: 'system', content: 'stable' }], getConfig: () => config, getSignal: () => engine?.abortSignal(runId),
    streamChatImpl: async (_params, emit, _signal, _retry, _attempt, lifecycle, before) => {
      await before(1, { bodyJson: '{}', model: 'fixture-model', maxTokens: 128 })
      const perf = api.createProviderPerformance(performance => emit({ type: 'performance', performance }))
      perf.lifecycle({ type: 'started', innerAttempt: 1, startedAt: Date.now() })
      const output = delta => { const event = { type: 'text', delta }; perf.chunk(event); emit(event) }
      output('首')
      await sleep(20)
      assert.ok(firstObserved, 'first output must not wait for stream completion')
      for (let i = 0; i < 2000; i++) output('续')
      output('尾。')
      perf.lifecycle({ type: 'terminal', innerAttempt: 1, outcome: 'success' }); perf.close()
      emit({ type: 'done', finishReason: 'stop', usage: null })
    }
  })
  const counted = async input => {
    const iter = await modelCall(input)
    return (async function* () { for await (const event of iter) { if (event.type === 'text') { deltaEvents++; firstObserved = true }; yield event } })()
  }
  engine = api.createAgentRunEngine({ store: api.createRunStorePort(repo), modelCall: counted, toolExecutor: async () => '', getConfig: () => config,
    onEvent: (id, event) => { if (event.type === 'performance') scopeEvents.push(event.performance); chunks.push(...translate(event, id)) }, onRunUpdate: () => {} })
  try {
    await engine.start({ runId, sessionId: config.sessionId, config }); await engine.step(runId)
    assert.equal((await engine.getState(runId)).run.status, 'completed')
    assert.equal(chunks.filter(c => c.type === 'text').map(c => c.delta).join(''), `首${'续'.repeat(2000)}尾。`)
    assert.ok(deltaEvents <= 3, `2002 wire deltas should coalesce, got ${deltaEvents}`)
    assert.ok(scopeEvents.length >= 3)
    assert.ok(scopeEvents.every(p => p.scope.runId === runId && p.scope.actor === 'writer' && p.scope.turnSeq > 0 && p.scope.round === 1))
    assert.equal(chunks.filter(c => c.type === 'performance').at(-1).performance.status, 'completed')
    assert.equal(translate({ type: 'performance', performance: scopeEvents.at(-1) }, runId).length, 0, 'ignore telemetry after run terminal')
    t.diagnostic(`2002 provider text deltas → ${deltaEvents} kernel text events; first byte forwarded before tail`)
  } finally {
    repo.close()
    assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('dw-performance-'))
    await fs.rm(dir, { recursive: true, force: true })
  }
})
