const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { before, test } = require('node:test')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..')
const http = require('node:http')
let api
before(async () => {
  const built = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
    export {createRepository} from './src/main/db/repository'; export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {createRunStorePort,createModelCallAdapter,createToolExecutor,allowListFromConfig} from './src/main/runKernelAdapter';
    export {createProviderWebClient} from './src/main/providerWeb'; export {freezeRunWebAccess,frozenRunWebAccess,selectedWebProfile} from './src/main/runWebAccess'; export {createRunProviderWeb} from './src/main/providerWebRuntime';
    export {unknownModelCapabilities} from './src/shared/providerRegistry'; export {buildExecutionSnapshot} from './src/main/executionSnapshot';
    export {createPublicWebTools,parsePublicWebUrl} from './src/main/publicWebTools';
    export {removeRunCallLimit} from './src/main/runCallLimitAuthorization'; export {secureProviderFetch} from './src/main/providerSecurity'; export {loadCliConfig} from './src/cli/config';
  ` }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', alias: { electron: path.join(root, 'src/cli/host.ts') }, write: false, logLevel: 'silent' })
  const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports); api = module.exports
})
const price = { id: 'synthetic-zero-model-price', currency: 'CNY', unit: 'per_1m_tokens', inputMissPerMillion: 0, cacheHitPerMillion: 0, outputPerMillion: 0, reasoningBillingRule: 'included' }
const nativeProfile = () => ({ version: 1, profileId: 'fixture-profile', profileName: 'Synthetic official profile', fingerprint: 'f'.repeat(64),
  provider: { id: 'fixture-deepseek', adapterId: 'builtin.deepseek', baseUrl: 'https://api.deepseek.com', chatPath: '/chat/completions', authStyle: 'bearer', transportPolicy: { scope: 'public_https', allowNonDefaultPort: false, protocol: 'deepseek-chat' } },
  model: { id: 'fixture-model', remoteModelId: 'deepseek-v4-flash', contextWindow: 128000, maxOutputTokens: 256, capabilityProof: api.unknownModelCapabilities(), pricing: price },
  credential: { credentialRefId: 'fixture-credential-v1', providerId: 'fixture-deepseek', version: 1 }, generation: { temperature: .7, topP: .9, maxOutputTokens: 256, stream: true },
  reasoning: { mode: 'disabled', effort: null, budgetTokens: null }, wireReasoning: { mode: 'disabled', thinking: { enabled: false, effort: 'high' }, compatibilityMappingId: null }, appliedMappings: [], omittedControls: [], supportsTools: true })

async function fixture({ host = 'desktop', cap = .02, maxCalls = 8, enabled = true, unsupported = false, pauseAtReply = false, sequentialRounds = 0, maxTurns = 6, useDefaultSnapshot = false, legacyMissingCount = false, serviceFamily = 'deepseek', realTransport, fullDefaultBudget = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-paid-web-run-')), database = path.join(dir, 'run.db'), runId = 'web-' + host
  let repo = api.createRepository(database); repo.open()
  let store = api.createRunStorePort(repo, path.join(dir, 'artifacts')), engine, modelCalls = 0, resolveHeld, heldOnce = false
  const held = new Promise(resolve => { resolveHeld = resolve }), requests = [], envelopes = [], events = []
  const config = { clientRequestId: runId, sessionId: runId + '-session', runMode: 'agent', planMode: false, longMode: false, maxTurns,
    baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', maxTokens: 256, thinking: { enabled: false, effort: 'high' },
    workDir: dir, docDir: dir, frozenSystemMessages: [{ role: 'system', content: '按已授权工具核对来源。' }],
    toolPolicy: { allowList: ['web_search', 'read_web_page'] }, providerCallBudget: { maxCalls, maxTokens: 1000000, maxCost: cap === null ? null : { amount: cap, currency: 'CNY', unknownPolicy: 'deny' }, maxWallClockMs: 30000 } }
  if (useDefaultSnapshot) {
    const snapshot = newSnapshot(runId, dir)
    config.maxTurns = snapshot.maxTurns
    config.providerCallBudget.maxCalls = snapshot.providerCallBudget.maxCalls
  }
  if (fullDefaultBudget) { const snapshot = newSnapshot(runId, dir); config.workBudgetPolicy = snapshot.workBudgetPolicy; config.providerCallBudget = snapshot.providerCallBudget; config.maxTurns = snapshot.maxTurns }
  if (legacyMissingCount) delete config.providerCallBudget.maxCalls
  const profile = nativeProfile()
  if (serviceFamily !== 'deepseek') {
    const anthropic = serviceFamily === 'anthropic'
    profile.provider.baseUrl = anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com'
    profile.provider.chatPath = anthropic ? '/v1/messages' : '/v1/responses'
    profile.provider.transportPolicy.protocol = anthropic ? 'anthropic-messages' : 'openai-responses'
    profile.provider.transportPolicy.authHeaderName = anthropic ? 'x-api-key' : 'Authorization'
    profile.provider.adapterId = 'custom.openai-compatible-chat'
    profile.model.remoteModelId = anthropic ? 'claude-sonnet-4-6' : 'gpt-5.4'
    delete profile.model.pricing; profile.generation.maxOutputTokens = 6000
  }
  if (fullDefaultBudget) { profile.generation.outputTokenLimit = null; profile.generation.maxOutputTokens = 1024; profile.model.maxOutputTokens = 16000 }
  if (unsupported) profile.provider.baseUrl = 'https://proxy.invalid'
  if (host === 'desktop') config.providerProfileSnapshots = { version: 1, frozenAt: 'fixture', default: profile, planning: null, draft: profile, review: null, polish: null }
  else config.cliProvider = { fingerprint: 'synthetic-cli-credential-fingerprint', tools: true, config: { schemaVersion: 1, ...(Object.hasOwn(profile.generation, 'outputTokenLimit') ? { outputTokenLimit: profile.generation.outputTokenLimit, modelMaxOutputTokens: profile.model.maxOutputTokens } : {}), baseUrl: unsupported ? 'https://proxy.invalid' : profile.provider.baseUrl, chatPath: profile.provider.chatPath, model: profile.model.remoteModelId, protocol: profile.provider.transportPolicy.protocol, maxTokens: profile.generation.maxOutputTokens, contextWindow: 128000, supportsTools: true, authHeaderName: profile.provider.transportPolicy.authHeaderName ?? 'Authorization', loopback: false, thinking: false, effort: 'high' } }
  api.freezeRunWebAccess(config, enabled)
  const getConfig = () => JSON.parse(repo.getRun(runId).config_json)
  const getApi = () => ({ profileId: 'fixture', providerId: 'fixture-deepseek', apiKey: 'synthetic-frozen-A', baseUrl: config.baseUrl, model: config.model, maxTokens: 256, thinking: config.thinking,
    temperature: .7, topP: .9, supportsTools: true, pricing: price, adapterId: 'builtin.deepseek', protocol: 'deepseek-chat', chatPath: '/chat/completions', authStyle: 'bearer', transportPolicy: profile.provider.transportPolicy })
  const makeEngine = () => {
    const adapter = api.createModelCallAdapter({ getConfig, getSignal: () => engine.abortSignal(runId), getApi, buildPrefix: async cfg => cfg.frozenSystemMessages,
      streamChatImpl: async (params, emit, signal, _retry, _attempt, _lifecycle, beforeRequest) => {
        modelCalls++; envelopes.push(params)
        await beforeRequest?.(1, { bodyJson: JSON.stringify(params.messages), model: params.model, maxTokens: 256 })
        const toolReplies = params.messages.filter(message => message.role === 'tool')
        if (sequentialRounds > 0 && toolReplies.length < sequentialRounds) {
          if (toolReplies.length) assert(toolReplies.at(-1).content.includes('source summary'))
          const number = toolReplies.length + 1
          emit({ type: 'tool_call', tool: { index: 0, id: `search-${number}`, name: 'web_search', arguments: JSON.stringify({query: `source ${number}`}) } })
          emit({ type: 'done', finishReason: 'tool_calls' }); return { finishReason: 'tool_calls', usage: null }
        }
        if (!sequentialRounds && modelCalls === 1) {
          emit({ type: 'tool_call', tool: { index: 0, id: 'search-1', name: 'web_search', arguments: '{"query":"first edition evidence"}' } })
          emit({ type: 'tool_call', tool: { index: 1, id: 'fetch-1', name: 'read_web_page', arguments: '{"url":"https://example.com/source"}' } })
          emit({ type: 'done', finishReason: 'tool_calls' }); return { finishReason: 'tool_calls', usage: null }
        }
        if (pauseAtReply && !heldOnce) {
          heldOnce = true; resolveHeld()
          await new Promise((_, reject) => { const stop = () => { const error = new Error('fixture pause'); error.name = 'AbortError'; reject(error) }; signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop() })
        }
        emit({ type: 'text', delta: '已依据工具返回的来源完成答复。' }); emit({ type: 'done', finishReason: 'stop' })
        return { finishReason: 'stop', usage: null }
      } })
    const executor = api.createToolExecutor({ getAllowList: () => api.allowListFromConfig(getConfig()), getSignal: () => engine.abortSignal(runId),
      getEnv: () => ({ workDir: dir, docDir: dir, sessionId: config.sessionId }),
      getProviderWeb: (_runId, toolCallId, hooks) => api.createRunProviderWeb({ repository: repo, runId, toolCallId, config: getConfig(), hooks,
        resolveCredential: reference => { assert.equal(reference.version, 1); return 'synthetic-frozen-A' },
        dependencies: { lookup: async () => [{ address: '93.184.215.14', family: 4 }], transport: async (url, init) => {
          assert.equal(new URL(url).origin, profile.provider.baseUrl); assert.equal(new Headers(init.headers).get(serviceFamily === 'anthropic' ? 'x-api-key' : 'authorization'), serviceFamily === 'anthropic' ? 'synthetic-frozen-A' : 'Bearer synthetic-frozen-A')
          assert(!String(init.body).includes('synthetic-frozen-A')); requests.push({ url, body: JSON.parse(init.body) })
          if (realTransport) return realTransport(url, init)
          return new Response(JSON.stringify(url.endsWith('/search') ? { results: [{ url: 'https://example.com/source', title: '本地假服务返回的来源', snippet: 'source snippet', summary: 'source summary' }] } : { title: '本地假服务返回的来源', content: 'source page body available to the model' }), { status: 200 })
        } } }) })
    return api.createAgentRunEngine({ store, getConfig, modelCall: adapter, toolExecutor: executor, onEvent: (_id, event) => events.push(event), onRunUpdate: () => {} })
  }
  engine = makeEngine()
  await engine.start({ runId, sessionId: config.sessionId, config }); await store.appendTurn({ turnId: 'user', runId, turnSeq: 1, role: 'user', content: '请联网核对来源。', createdAt: Date.now() })
  let running = engine.step(runId)
  return { get repo() { return repo }, get engine() { return engine }, config, runId, requests, envelopes, events, held, get running() { return running },
    restore: async () => { await engine.pause(runId); await running; repo.close(); repo = api.createRepository(database); repo.open(); store = api.createRunStorePort(repo, path.join(dir, 'artifacts')); engine = makeEngine(); await engine.restore(runId); running = engine.step(runId); await running },
    coldResume: async (authorize = false) => {
      await running; repo.close(); repo = api.createRepository(database); repo.open()
      store = api.createRunStorePort(repo, path.join(dir, 'artifacts')); engine = makeEngine()
      if (authorize) api.removeRunCallLimit(repo, runId)
      await Promise.all([engine.restore(runId), engine.restore(runId)])
      running = Promise.all([engine.step(runId), engine.step(runId)]); await running
    },
    close: async () => { await engine.pause(runId); await running; repo.close(); assert.equal(path.dirname(dir), os.tmpdir()); assert(path.basename(dir).startsWith('dw-paid-web-run-')); await fs.rm(dir, { recursive: true, force: true }) } }
}

for (const host of ['desktop', 'cli']) test(`${host} frozen config → actual shared adapter/engine/executor → paid provider transport → source tool turns and persisted run receipt`, async () => {
  const f = await fixture({ host })
  try {
    await f.running
    assert.equal(f.repo.getRun(f.runId).status, 'completed')
    assert.deepEqual(f.envelopes[0].tools.map(tool => tool.function.name).sort(), ['read_web_page', 'web_search'])
    assert.deepEqual(f.requests.map(request => new URL(request.url).pathname), ['/v1/tools/search', '/v1/tools/fetch'], JSON.stringify(f.repo.getToolCallsByRun(f.runId).map(row => row.result_json)))
    const tools = f.envelopes.at(-1).messages.filter(message => message.role === 'tool')
    assert.equal(tools.length, 2); assert(tools[0].content.includes('source summary')); assert(tools[1].content.includes('source page body'))
    const attempts = f.repo.getProviderAttempts(f.runId)
    assert.equal(attempts.length, 2); assert(attempts.every(row => row.run_id === f.runId && row.profile_id && row.outcome === 'success' && row.cost_status === 'estimated' && row.cost_amount === .005 && row.cost_currency === 'CNY'))
    assert.deepEqual(attempts.map(row => row.stage_id), ['web:search', 'web:fetch'])
    assert(!JSON.stringify(attempts).includes('synthetic-frozen-A'))
    assert.equal(JSON.parse(f.repo.getRunEvidence(f.runId, 'run_provider_budget_v1').json).totalCalls, 4)
  } finally { await f.close() }
})

test('strict run cost cap reserves before transport and cannot overspend across two requested web operations', async () => {
  for (const [cap, calls] of [[.0049, 0], [.005, 1]]) {
    const f = await fixture({ cap, maxCalls: null, maxTurns: null })
    try { await f.running; assert.equal(f.requests.length, calls); const row = f.repo.getRun(f.runId); assert.equal(row.status, 'waiting_user', JSON.stringify({ cap, tools: f.repo.getToolCallsByRun(f.runId).map(tool => tool.result_json), phases: f.events.filter(event => event.type === 'phase') })); assert.equal(row.error_code, 'run_cost_budget'); assert.equal(f.repo.getProviderAttempts(f.runId).length, calls)
      assert.equal(JSON.parse(f.repo.getRunEvidence(f.runId, 'run_provider_budget_v1').json).totalCalls, 1 + calls, 'denied request is not recorded as a dispatched call')
      const responses = f.repo.getTurnsByRun(f.runId).filter(turn => turn.role === 'tool').map(turn => JSON.parse(turn.tool_result_json).toolCallId)
      assert.deepEqual(responses, ['search-1', 'fetch-1'], 'budget pause still completes all declared tool response slots for recovery') }
    finally { await f.close() }
  }
})

test('the run provider-call ceiling also covers paid web operations', async () => {
  const f = await fixture({ maxCalls: 2 })
  try { await f.running; assert.equal(f.requests.length, 1); assert.equal(f.repo.getRun(f.runId).error_code, 'run_provider_call_cap') } finally { await f.close() }
})

test('only the correct frozen stage/credential grants operations; hosted services receive search only', () => {
  for (const change of ['no-key', 'wrong-provider', 'tool-off', 'wrong-stage']) {
    const profile = nativeProfile()
    if (change === 'no-key') profile.credential = null
    if (change === 'wrong-provider') profile.credential.providerId = 'unrelated-account'
    if (change === 'tool-off') profile.supportsTools = false
    const config = { runMode: 'agent', planMode: change === 'wrong-stage', toolPolicy: { allowList: ['web_search', 'read_web_page'] }, providerProfileSnapshots: { version: 1, draft: profile, planning: null } }
    api.freezeRunWebAccess(config, true); assert.equal(config.webAccess, undefined); assert.deepEqual(api.allowListFromConfig(config), [])
  }
  const profile = nativeProfile(); profile.provider = { ...profile.provider, id: 'official-openai', adapterId: 'custom.openai-compatible-chat', baseUrl: 'https://api.openai.com', chatPath: '/v1/responses', transportPolicy: { scope: 'public_https', allowNonDefaultPort: false, protocol: 'openai-responses' } }
  profile.model.remoteModelId = 'gpt-5.2'; profile.credential.providerId = profile.provider.id
  const config = { runMode: 'agent', toolPolicy: { allowList: ['web_search', 'read_web_page'] }, providerProfileSnapshots: { version: 1, draft: profile } }
  api.freezeRunWebAccess(config, true); assert.deepEqual(api.allowListFromConfig(config), ['web_search'])
})

test('disabled, unsupported and old free-web/wildcard contracts never acquire or execute web tools', async () => {
  for (const options of [{ enabled: false }, { unsupported: true }]) {
    const f = await fixture(options)
    try { await f.running; assert.equal(f.requests.length, 0); assert.equal(f.envelopes[0].tools, undefined); assert.equal(f.config.webAccess, undefined) } finally { await f.close() }
  }
  for (const allowList of [['*'], ['web_search', 'read_web_page']]) assert.deepEqual(api.allowListFromConfig({ runMode: 'agent', toolPolicy: { allowList } }).filter(name => ['web_search', 'read_web_page'].includes(name)), [])
  const bare = await api.createPublicWebTools()[0].execute({ query: 'public evidence' }, root)
  assert.equal(bare.ok, false)
})

test('cold restore retains frozen authorization and already delivered tool receipts without reissuing paid calls', async () => {
  const f = await fixture({ host: 'cli', pauseAtReply: true })
  try {
    let timer
    await Promise.race([f.held, f.running.then(() => { throw new Error('no recovery boundary') }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('restore boundary timeout')), 5000) })]).finally(() => clearTimeout(timer))
    await f.restore()
    assert.equal(f.repo.getRun(f.runId).status, 'completed'); assert.equal(f.requests.length, 2); assert.equal(f.repo.getProviderAttempts(f.runId).length, 2)
    assert.equal(f.envelopes.at(-1).messages.filter(message => message.role === 'tool').length, 2)
  } finally { await f.close() }
})

function newSnapshot(id, dir, longMode = false) {
  return api.buildExecutionSnapshot({ payload: { id, text: '按来源完成任务', mode: longMode ? 'longwrite' : 'agent', longMode, targetChars: longMode ? 20000 : 0 },
    sessionId: id + '-session', settings: { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', maxTokens: 4096, temperature: .7, topP: .9, thinkingEnabled: false, reasoningEffort: 'high', workDir: dir, docDir: dir, novelMode: false, toolsEnabled: true, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 64000, completionTokenBudget: 1000000 }, memory: { projectPath: '', projectContent: '', userContent: '' } })
}

for (const host of ['desktop', 'cli']) test(`${host} default snapshot has JSON unlimited calls and real shared tool cycle completes after 16`, async () => {
  const f = await fixture({ host, cap: null, sequentialRounds: 20, useDefaultSnapshot: true })
  try {
    assert.equal(JSON.parse(JSON.stringify(f.config)).providerCallBudget.maxCalls, null)
    assert.equal(f.config.maxTurns, null)
    assert.equal(newSnapshot('longform', root, true).providerCallBudget.maxCalls, null)
    await f.running
    assert.equal(f.repo.getRun(f.runId).status, 'completed', JSON.stringify(f.events.filter(e => e.type === 'phase').slice(-3)))
    assert.equal(f.requests.length, 20); assert.equal(f.envelopes.length, 21)
    const ledger = JSON.parse(f.repo.getRunEvidence(f.runId, 'run_provider_budget_v1').json)
    assert.equal(ledger.totalCalls, 41); assert.equal(ledger.limits.maxCalls, null)
    assert.equal(f.repo.getProviderAttempts(f.runId).length, 20)
    assert.equal(f.envelopes.at(-1).messages.filter(m => m.role === 'tool').length, 20)
    assert.equal(new Set(f.requests.map(r => r.body.query)).size, 20)
  } finally { await f.close() }
})

test('explicit 16 remains hard; a cold old/default-16 run requires per-task authorization, keeps bills/key and resumes once', async () => {
  for (const legacyMissingCount of [false, true]) {
    const f = await fixture({ host: 'cli', cap: null, maxCalls: 16, maxTurns: 12, sequentialRounds: 20, legacyMissingCount })
    try {
      await f.running
      assert.equal(f.repo.getRun(f.runId).error_code, 'run_provider_call_cap')
      assert.equal(f.requests.length, 8); assert.equal(f.envelopes.length, 8)
      const frozenBefore = JSON.parse(f.repo.getRun(f.runId).config_json).cliProvider
      const previousBills = f.repo.getProviderAttempts(f.runId)
      const before = JSON.parse(f.repo.getRunEvidence(f.runId, 'run_provider_budget_v1').json)
      await f.engine.listRecoverable()
      await f.coldResume()
      assert.equal(f.requests.length, 8); assert.equal(f.envelopes.length, 8, 'ordinary restore cannot silently lift old authorization')
      assert.equal(f.repo.getRun(f.runId).error_code, 'run_provider_call_cap')
      const authorized = api.removeRunCallLimit(f.repo, f.runId)
      const amended = JSON.parse(f.repo.getRunEvidence(f.runId, 'run_provider_budget_v1').json)
      assert.equal(amended.totalCalls, before.totalCalls)
      assert.deepEqual(amended.limits, { ...before.limits, maxCalls: null })
      assert.deepEqual(authorized.config.cliProvider, frozenBefore)
      assert.equal(f.requests.length, 8, 'authorization itself must never dispatch')
      await f.coldResume(true)
      assert.equal(f.repo.getRun(f.runId).status, 'completed')
      assert.equal(f.requests.length, 20); assert.equal(f.envelopes.length, 21)
      assert.equal(new Set(f.requests.map(r => r.body.query)).size, 20, 'already paid searches are never reissued')
      const bills = f.repo.getProviderAttempts(f.runId)
      assert.deepEqual(bills.slice(0, previousBills.length), previousBills)
      assert.deepEqual(JSON.parse(f.repo.getRun(f.runId).config_json).cliProvider, frozenBefore)
      assert.equal(JSON.parse(f.repo.getRunEvidence(f.runId, 'run_provider_budget_v1').json).totalCalls, 41)
      assert.equal(api.removeRunCallLimit(f.repo, f.runId).resume, false, 'repeat authorization on terminal task never restarts it')
      assert.equal(f.requests.length, 20)
    } finally { await f.close() }
  }
})

for (const host of ['desktop', 'cli']) for (const family of ['openai', 'anthropic']) test(`${host} fresh production default permits unknown-priced ${family} multi-search through a real loopback provider, offline and explicit budgets still deny`, async () => {
  const wire = []
  const source = { url: 'https://example.com/source', title: '本地供应商协议夹具' }
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', part => { raw += part }); req.on('end', () => {
      const body = JSON.parse(raw); wire.push({ path: req.url, body, credentialMatched: (req.headers.authorization === 'Bearer synthetic-frozen-A' || req.headers['x-api-key'] === 'synthetic-frozen-A') })
      const result = family === 'openai' ? { status: 'completed', output: [
        { type: 'web_search_call', id: 'ws_first', status: 'completed', action: { type: 'search', sources: [source] } },
        { type: 'web_search_call', id: 'ws_second', status: 'completed', action: { type: 'search', sources: [source] } },
        { type: 'web_search_call', id: 'ws_open', status: 'completed', action: { type: 'open_page' } },
        { type: 'web_search_call', id: 'ws_find', status: 'completed', action: { type: 'find_in_page' } },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'source summary from multiple actual native web operations', annotations: [{ type: 'url_citation', ...source }] }] }
      ], usage: { input_tokens: 200, output_tokens: 100 } } : { stop_reason: 'end_turn', content: [
        { type: 'server_tool_use', id: 'srvtoolu_first', name: 'web_search' }, { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_first', content: [{ type: 'web_search_result', ...source }] },
        { type: 'server_tool_use', id: 'srvtoolu_second', name: 'web_search' }, { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_second', content: [{ type: 'web_search_result', ...source }] },
        { type: 'text', text: 'source summary from two real native searches', citations: [{ type: 'web_search_result_location', ...source }] }
      ], usage: { input_tokens: 200, output_tokens: 100, server_tool_use: { web_search_requests: 2 } } }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const transport = (url, init) => api.secureProviderFetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init, { scope: 'loopback_http', allowNonDefaultPort: true })
  try {
    const normal = await fixture({ host, serviceFamily: family, realTransport: transport, sequentialRounds: 1, fullDefaultBudget: true })
    try {
      await normal.running
      assert.equal(normal.config.providerCallBudget.maxCost, null); assert.equal(normal.config.providerCallBudget.maxCalls, null)
      assert.equal(normal.repo.getRun(normal.runId).status, 'completed'); assert.equal(wire.length, 1)
      assert.equal(wire[0].credentialMatched, true); assert.equal(wire[0].body.max_tool_calls, undefined); assert.equal(wire[0].body.tools[0].max_uses, undefined)
      assert.equal(wire[0].body[family === 'openai' ? 'max_output_tokens' : 'max_tokens'], family === 'openai' ? undefined : 16000)
      const attempts = normal.repo.getProviderAttempts(normal.runId); assert.equal(attempts.length, 1); assert.equal(attempts[0].cost_status, 'unknown'); assert.equal(attempts[0].cost_amount, null)
      const ledger = JSON.parse(normal.repo.getRunEvidence(normal.runId, 'run_provider_budget_v1').json); assert.equal(ledger.totalCalls, 3); assert(ledger.unknownCostCalls > 0)
      const records = normal.repo.getRunEvidence(normal.runId, `provider_web:search-1:${attempts[0].logical_call_id}`)
      const receipt = JSON.parse(records.json); assert.equal(receipt.usage.searchRequests, 2)
      assert(normal.envelopes.at(-1).messages.some(message => message.role === 'tool' && message.content.includes('source summary')))
      await fs.mkdir(path.join(root, 'out/harness-50'), { recursive: true }); await fs.writeFile(path.join(root, `out/harness-50/provider-web-default-${host}-${family}.json`), JSON.stringify({ synthetic: true, wire, receipt, ledger, finalEnvelope: { messages: normal.envelopes.at(-1).messages, tools: normal.envelopes.at(-1).tools, maxTokens: normal.envelopes.at(-1).maxTokens } }, null, 2))
    } finally { await normal.close() }
    for (const options of [{ enabled: false }, { cap: .02 }, { maxCalls: 1, cap: null }]) {
      const denied = await fixture({ host, serviceFamily: family, realTransport: transport, sequentialRounds: 1, ...options })
      try {
        await denied.running; assert.equal(wire.length, 1, 'disabled web, explicit unknown-price cap and explicit call cap must deny before transport')
        if (options.enabled === false) assert(!denied.envelopes[0].tools?.some(tool => tool.function.name === 'web_search'))
        else assert.equal(denied.repo.getRun(denied.runId).status, 'waiting_user')
      } finally { await denied.close() }
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('CLI web preference defaults on, persists explicit offline and requires an explicit re-enable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-web-preference-'))
  try {
    const load = options => api.loadCliConfig(dir, { 'key-env': 'DW_SYNTHETIC_UNUSED_WEB_KEY', ...options })
    assert.equal((await load({})).config.webAccessEnabled, true)
    const offline = (await load({ 'no-web': true })).config; assert.equal(offline.webAccessEnabled, false)
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(offline)); assert.equal((await load({})).config.webAccessEnabled, false)
    assert.equal((await load({ web: true })).config.webAccessEnabled, true)
    await assert.rejects(load({ web: true, 'no-web': true }), /不能同时/)
  } finally { assert.equal(path.dirname(dir), os.tmpdir()); assert(path.basename(dir).startsWith('dw-web-preference-')); await fs.rm(dir, { recursive: true, force: true }) }
})

test('CLI web projection preserves null/default reasoning and explicit Anthropic budget on one real outbound request', async () => {
  const base = { schemaVersion: 1, baseUrl: 'https://api.anthropic.com', chatPath: '/v1/messages', model: 'claude-sonnet-4-5', protocol: 'anthropic-messages',
    maxTokens: 8192, contextWindow: 64000, modelMaxOutputTokens: 16000, outputTokenLimit: null, outputLimitSource: 'model_declaration',
    supportsTools: true, authHeaderName: 'x-api-key', loopback: false, effort: 'default', thinkingBudget: null }
  const scope = thinking => ({ runMode: 'agent', cliProvider: { fingerprint: 'synthetic-reasoning-web', tools: true, config: { ...base, thinking } } })
  for (const [thinking, mode] of [[null, 'default'], [true, 'enabled'], [false, 'disabled']]) {
    const profile = api.selectedWebProfile(scope(thinking))
    assert.equal(profile.reasoning.mode, mode); assert.equal(profile.wireReasoning.mode, mode)
    assert.equal(profile.reasoning.effort, null); assert.equal(profile.wireReasoning.thinking.effort, 'default')
    assert.equal(profile.generation.outputTokenLimit, null)
  }
  const legacy = scope(false); delete legacy.cliProvider.config.outputTokenLimit
  assert.equal(api.selectedWebProfile(legacy).generation.outputTokenLimit, undefined, 'old missing field must retain the old output wire contract')
  const config = scope(true); config.cliProvider.config.thinkingBudget = 2048
  const before = JSON.stringify(config), profile = api.selectedWebProfile(config)
  assert.equal(profile.reasoning.budgetTokens, 2048); assert.equal(profile.wireReasoning.budgetTokens, 2048)
  assert.equal(profile.wireReasoning.compatibilityMappingId, 'anthropic.thinking')
  let calls = 0
  const server = http.createServer((req, res) => { let raw = ''; req.on('data', part => raw += part); req.on('end', () => {
    calls++; const body = JSON.parse(raw)
    assert.equal(req.url, '/v1/messages'); assert.equal(req.headers['x-api-key'], 'synthetic-web-reasoning-key')
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2048 }); assert.equal(body.output_config, undefined)
    assert.equal(body.max_tokens, 16000, 'native bound, not the local 8192 reserve')
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ stop_reason: 'end_turn', content: [
      { type: 'server_tool_use', id: 'srvtoolu_reasoning', name: 'web_search' },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_reasoning', content: [{ type: 'web_search_result', url: 'https://example.com/article', title: 'Protocol fixture' }] },
      { type: 'text', text: 'Grounded result.' }
    ], usage: { input_tokens: 30, output_tokens: 20, server_tool_use: { web_search_requests: 1 } } }))
  }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = api.createProviderWebClient({ resolveCredential: () => 'synthetic-web-reasoning-key', beforeRequest: () => {}, onAttempt: () => {},
      transport: (url, init) => { assert.equal(new URL(url).origin, 'https://api.anthropic.com'); return api.secureProviderFetch(`http://127.0.0.1:${server.address().port}/v1/messages`, init, { scope: 'loopback_http', allowNonDefaultPort: true }) } })
    const result = await client.execute({ profile, operation: 'search', args: { query: 'public source' }, billingCurrency: 'USD' })
    assert(result.text.includes('Grounded')); assert.equal(calls, 1); assert.equal(JSON.stringify(config), before)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
