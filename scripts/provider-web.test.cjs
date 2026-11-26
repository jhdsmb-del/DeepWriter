const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { before, test } = require('node:test')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
before(async () => {
  const built = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `export * from './src/main/providerWeb'; export {getProviderWebCapability} from './src/shared/providerWebCapability'; export {secureProviderFetch} from './src/main/providerSecurity';` }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent' })
  const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports); api = module.exports
})
const KEY = 'synthetic-provider-web-fixture-key'
const SOURCE = { title: 'Fixture article', url: 'https://news.example.org/article' }
const localPolicy = { scope: 'loopback_http', allowNonDefaultPort: true }
function frozen(family = 'deepseek', protocol = 'deepseek-chat', model) {
  const providerId = `provider.fixture.${family}`
  const origin = family === 'deepseek' ? 'https://api.deepseek.com' : family === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com'
  const chatPath = family === 'deepseek' ? protocol === 'anthropic-messages' ? '/anthropic/v1/messages' : protocol === 'openai-responses' ? '/responses' : '/chat/completions'
    : family === 'openai' ? '/v1/responses' : '/v1/messages'
  return { version: 1, profileId: `profile.fixture.${family}`, profileName: family, fingerprint: 'frozen-fixture',
    provider: { id: providerId, adapterId: family === 'deepseek' ? 'builtin.deepseek' : 'custom.openai-compatible-chat', baseUrl: origin, chatPath, authStyle: 'bearer',
      transportPolicy: { scope: 'public_https', allowNonDefaultPort: false, protocol,
        ...(protocol === 'anthropic-messages' ? { authHeaderName: 'x-api-key', fixedHeaders: { 'anthropic-version': '2023-06-01' } } : {}) } },
    model: { id: 'model.fixture', remoteModelId: model ?? (family === 'deepseek' ? 'deepseek-flash' : family === 'openai' ? 'gpt-5.4' : 'claude-sonnet-4-6'), contextWindow: 32768, maxOutputTokens: 2048, capabilityProof: {} },
    credential: { providerId, credentialRefId: 'credential.fixture', version: 3 }, generation: { temperature: 1, topP: 1, maxOutputTokens: 2048, stream: true },
    reasoning: { mode: 'default', effort: null, budgetTokens: null }, wireReasoning: { mode: 'default', thinking: { enabled: false, effort: 'high' }, compatibilityMappingId: null },
    appliedMappings: [], omittedControls: [], supportsTools: true }
}
async function wire(action, reply = request => request.path === '/v1/tools/fetch' ? { title: SOURCE.title, content: '# Fixture\nPublic article.' } : { results: [{ ...SOURCE, snippet: 'Observed snippet', summary: 'Observed summary', content: '' }] }) {
  const receipts = []
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => {
      const request = { path: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: JSON.parse(body) }; receipts.push(request)
      const payload = reply(request)
      res.writeHead(payload.httpStatus ?? 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload.body ?? payload))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const transport = (url, init, _policy, _resolver, limits) => {
      // Only this in-process fixture redirects a synthetic credential to a
      // loopback peer. Production receives no endpoint override or relay.
      const target = new URL(url)
      assert.ok(['https://api.deepseek.com', 'https://api.openai.com', 'https://api.anthropic.com'].includes(target.origin))
      return api.secureProviderFetch(`http://127.0.0.1:${server.address().port}${target.pathname}`, init, localPolicy, undefined, limits)
    }
    await action(transport, receipts)
  } finally { await new Promise(resolve => server.close(resolve)) }
}
function client(transport, overrides = {}) {
  const events = [], boundaries = [], resolved = []
  const instance = api.createProviderWebClient({ transport, resolveCredential: ref => { resolved.push(ref); return KEY }, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    beforeRequest: boundary => { boundaries.push(boundary) }, onAttempt: event => { events.push(event) }, ...overrides })
  return { ...instance, events, boundaries, resolved }
}
const search = (profile = frozen(), extra = {}) => ({ profile, operation: 'search', args: { query: 'Fixture public search', num_results: 2 }, billingCurrency: 'CNY', ...extra })

test('capability verifies official protocol/origin, keeps account APIs model-agnostic and verifies hosted model support', () => {
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']) assert.equal(api.getProviderWebCapability(frozen('deepseek', 'deepseek-chat', model)).mode, 'provider_api')
  assert.equal(api.getProviderWebCapability(frozen('deepseek', 'deepseek-chat', 'new-account-model-alias')).supported, true, 'account Search/Fetch has no model field')
  assert.equal(api.getProviderWebCapability(frozen('openai', 'openai-responses')).mode, 'model_hosted')
  assert.equal(api.getProviderWebCapability(frozen('anthropic', 'anthropic-messages')).mode, 'model_hosted')
  for (const alter of [p => { p.provider.baseUrl = 'https://proxy.example.org' }, p => { p.provider.chatPath = '/unknown' }, p => { p.provider.authStyle = 'none' }]) {
    const profile = frozen(); alter(profile); assert.equal(api.getProviderWebCapability(profile).supported, false)
  }
})

test('DeepSeek Chat/Responses/Messages profiles use the same exact account API and frozen key, not another host or model-hosted wire', async () => wire(async (transport, receipts) => {
  for (const protocol of ['deepseek-chat', 'openai-responses', 'anthropic-messages']) {
    const ctx = client(transport), profile = frozen('deepseek', protocol)
    const result = await ctx.execute(search(profile))
    const request = receipts.at(-1)
    assert.equal(request.path, '/v1/tools/search'); assert.equal(request.headers.authorization, 'Bearer ' + KEY)
    assert.equal(request.headers['x-api-key'], undefined); assert.equal(request.headers['anthropic-version'], undefined)
    assert.deepEqual(request.body, { query: 'Fixture public search', count: 2, need_content: false })
    assert.ok(!JSON.stringify(request.body).includes(KEY))
    assert.deepEqual(ctx.resolved, [profile.credential]); assert.equal(ctx.boundaries.length, 1)
    assert.deepEqual(ctx.events.map(event => event.type), ['started', 'terminal'])
    assert.equal(result.receipt.requestId, ctx.events[0].requestId)
    assert.equal(result.receipt.modelId, profile.model.remoteModelId); assert.equal(result.receipt.credentialVersion, 3)
    assert.equal(result.receipt.billable, true); assert.equal(result.receipt.costAmount, 0.005)
    assert.equal(result.receipt.costSourceUrl, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/')
    assert.equal(result.receipt.proof[0].type, 'provider_search')
    assert.deepEqual(result.sources, [SOURCE]); assert.match(result.text, /Observed summary/)
    assert.ok(!JSON.stringify([ctx.events, ctx.boundaries, result]).includes(KEY))
    assert.ok(!JSON.stringify(ctx.boundaries).includes('Fixture public search'))
  }
}))

test('DeepSeek fetch delegates the public URL to the provider only, and published CNY/USD fees reflect nonempty vs empty results', async () => {
  await wire(async (transport, receipts) => {
    const ctx = client(transport)
    const result = await ctx.execute({ profile: frozen(), operation: 'fetch', args: { url: SOURCE.url, max_characters: 100 }, billingCurrency: 'USD' })
    assert.equal(receipts[0].path, '/v1/tools/fetch'); assert.deepEqual(receipts[0].body, { url: SOURCE.url })
    assert.equal(result.content, '# Fixture\nPublic article.'); assert.deepEqual(result.sources, [SOURCE])
    assert.equal(result.receipt.costAmount, 0.00075); assert.equal(result.receipt.costQuote.currency, 'USD')
  })
  await wire(async transport => {
    const ctx = client(transport), result = await ctx.execute(search())
    assert.deepEqual(result.sources, []); assert.equal(result.receipt.billable, false); assert.equal(result.receipt.costAmount, 0)
  }, () => ({ results: [] }))
  await wire(async transport => {
    const ctx = client(transport), result = await ctx.execute({ profile: frozen(), operation: 'fetch', args: { url: SOURCE.url }, billingCurrency: 'CNY' })
    assert.deepEqual(result.sources, []); assert.equal(result.receipt.billable, false); assert.equal(result.receipt.costAmount, 0)
  }, () => ({ title: '', content: '' }))
})

test('hosted OpenAI and Anthropic use different native tools, preserve real search proof/citations and carry unknown upper costs', async () => {
  for (const family of ['openai', 'anthropic']) await wire(async (transport, receipts) => {
    const ctx = client(transport), profile = frozen(family, family === 'openai' ? 'openai-responses' : 'anthropic-messages')
    const result = await ctx.execute(search(profile, { billingCurrency: 'USD' }))
    assert.equal(receipts[0].path, profile.provider.chatPath)
    assert.equal(receipts[0].body.model, profile.model.remoteModelId)
    assert.equal(receipts[0].body.tools[0].type, family === 'openai' ? 'web_search' : 'web_search_20250305')
    assert.equal(receipts[0].headers[family === 'openai' ? 'authorization' : 'x-api-key'], family === 'openai' ? 'Bearer ' + KEY : KEY)
    assert.deepEqual(result.sources, [SOURCE]); assert.equal(result.receipt.proof[0].status, 'completed')
    assert.equal(result.receipt.usage.searchRequests, 1)
    assert.equal(ctx.boundaries[0].costQuote.status, 'unknown'); assert.equal(ctx.boundaries[0].costQuote.amount, null)
    assert.equal(result.receipt.costAmount, null)
  }, () => family === 'openai' ? { status: 'completed', output: [
    { type: 'web_search_call', id: 'ws_fixture', status: 'completed', action: { type: 'search', sources: [SOURCE] } },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Observed answer', annotations: [{ type: 'url_citation', ...SOURCE }] }] }
  ], usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 5 } } }
    : { stop_reason: 'end_turn', content: [
      { type: 'server_tool_use', id: 'srvtoolu_fixture', name: 'web_search' }, { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_fixture', content: [{ type: 'web_search_result', ...SOURCE }] },
      { type: 'text', text: 'Observed answer', citations: [{ type: 'web_search_result_location', ...SOURCE }] }
    ], usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, server_tool_use: { web_search_requests: 1 } } })
})

test('unsupported, missing/foreign frozen keys, unsafe URLs and unknown cost denial all stop before a real request', async () => {
  let attempts = 0
  const ctx = client(async () => { attempts++; throw new Error('must not send') })
  for (const alter of [p => { p.provider.baseUrl = 'https://proxy.example.org' }, p => { p.credential = null }, p => { p.credential.providerId = 'another-provider' }]) {
    const p = frozen(); alter(p); await assert.rejects(ctx.execute(search(p)))
  }
  for (const url of ['file:///secret', 'http://127.0.0.1', 'http://169.254.169.254/metadata', 'https://user:pass@example.org', 'https://internal.local']) {
    await assert.rejects(ctx.execute({ profile: frozen(), operation: 'fetch', args: { url }, billingCurrency: 'CNY' }))
  }
  const privateDNS = client(async () => { attempts++; throw new Error('must not send') }, { lookup: async () => [{ address: '10.0.0.1', family: 4 }] })
  await assert.rejects(privateDNS.execute({ profile: frozen(), operation: 'fetch', args: { url: SOURCE.url }, billingCurrency: 'CNY' }))
  assert.equal(attempts, 0); assert.equal(ctx.events.length, 0); assert.equal(ctx.boundaries.length, 0)
  const denied = new Error('fixture unknown price budget denial')
  const budget = client(async () => { attempts++; throw new Error('must not send') }, { beforeRequest: boundary => { assert.equal(boundary.costQuote.status, 'unknown'); throw denied } })
  await assert.rejects(budget.execute(search(frozen('openai', 'openai-responses'))), error => error === denied)
  assert.equal(attempts, 0); assert.equal(budget.events.length, 0)
})

test('HTTP failures, malformed 200 and transport interruptions never leak a key, retry or invent free/successful search', async () => {
  for (const status of [401, 402, 403, 429, 500]) await wire(async (transport, receipts) => {
    const ctx = client(transport)
    await assert.rejects(ctx.execute(search()), error => !error.message.includes(KEY))
    assert.equal(receipts.length, 1); assert.equal(ctx.events.at(-1).outcome, 'http_error'); assert.equal(ctx.events.at(-1).billable, false)
  }, () => ({ httpStatus: status, body: { error: { message: KEY } } }))
  await wire(async (transport, receipts) => {
    const ctx = client(transport)
    await assert.rejects(ctx.execute(search()), error => error.code === 'provider_web_invalid_response' && !error.message.includes(KEY))
    assert.equal(receipts.length, 1); assert.equal(ctx.events.at(-1).billable, null); assert.equal(ctx.events.at(-1).costAmount, null)
  }, () => ({ error: { message: KEY } }))
  const ctx = client(async () => { throw new Error('wire echo ' + KEY) })
  await assert.rejects(ctx.execute(search()), error => !error.message.includes(KEY))
  assert.equal(ctx.events.at(-1).outcome, 'transport_error'); assert.equal(ctx.events.at(-1).billable, null)
})

test('cancellation after reservation emits a matching terminal, and response text is redacted without exposing raw bytes to observers', async () => {
  const controller = new AbortController(); let calls = 0
  const ctx = client(async () => { calls++; throw new Error('not sent') }, { beforeRequest: () => { controller.abort() } })
  await assert.rejects(ctx.execute(search(frozen(), { signal: controller.signal })), error => error.code === 'provider_web_cancelled')
  assert.equal(calls, 0); assert.deepEqual(ctx.events.map(event => event.type), ['started', 'terminal'])
  assert.equal(ctx.events.at(-1).billable, false); assert.equal(ctx.events[0].requestId, ctx.events[1].requestId)
  await wire(async transport => {
    const active = client(transport), result = await active.execute(search())
    assert.ok(!JSON.stringify([result, active.events, active.boundaries]).includes(KEY)); assert.match(result.text, /已隐藏凭据/)
  }, () => ({ results: [{ ...SOURCE, summary: 'Echo ' + KEY }] }))
})

test('mutating the caller profile or observer metadata cannot change the frozen credential, authority or endpoint actually sent', async () => wire(async (transport, receipts) => {
  const profile = frozen(), originalId = profile.provider.id
  const ctx = client(transport, { beforeRequest: boundary => { profile.provider.baseUrl = 'https://elsewhere.invalid'; profile.credential.version = 77; boundary.endpointOrigin = 'https://elsewhere.invalid'; boundary.costQuote.amount = 0 } })
  const result = await ctx.execute(search(profile))
  assert.equal(receipts.length, 1); assert.deepEqual(ctx.resolved, [{ providerId: originalId, credentialRefId: 'credential.fixture', version: 3 }])
  assert.equal(result.receipt.endpointOrigin, 'https://api.deepseek.com'); assert.equal(result.receipt.costAmount, 0.005)
}))


test('DeepSeek account search accepts the documented 50 results rather than an app quota of eight', async () => wire(async (transport, receipts) => {
  const ctx = client(transport)
  const result = await ctx.execute(search(frozen('deepseek', 'deepseek-chat', 'new-account-model-alias'), { args: { query: 'published source range', num_results: 50 } }))
  assert.equal(receipts[0].body.count, 50)
  assert.equal(result.results.length, 50)
}, () => ({ results: Array.from({ length: 50 }, (_, index) => ({ title: 'Published source ' + index, url: 'https://news.example.org/' + index, snippet: 'source' })) })))

test('Anthropic pause_turn continues exact opaque blocks on the same frozen account, with one reservation/receipt per actual HTTP request', async () => {
  let phase = 0
  const pausedBlocks = [
    { type: 'server_tool_use', id: 'srvtoolu_paused', name: 'web_search', input: { query: 'public evidence' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_paused', content: [{ type: 'web_search_result', ...SOURCE, encrypted_content: 'opaque-provider-state-do-not-change' }] }
  ]
  await wire(async (transport, receipts) => {
    const profile = frozen('anthropic', 'anthropic-messages'), events = []
    const ctx = client(transport, { onAttempt: event => { events.push(event); if (event.type === 'terminal' && event.stopReason === 'pause_turn') { profile.provider.baseUrl = 'https://unrelated.example.org'; profile.credential.providerId = 'foreign-account' } } })
    const result = await ctx.execute(search(profile, { billingCurrency: 'USD' }))
    assert.equal(receipts.length, 2); assert.equal(ctx.boundaries.length, 2)
    assert.equal(new Set(ctx.boundaries.map(boundary => boundary.requestId)).size, 2)
    assert.deepEqual(receipts[1].body.messages.at(-1), { role: 'assistant', content: pausedBlocks })
    assert.equal(receipts[1].headers['x-api-key'], KEY)
    const terminal = events.filter(event => event.type === 'terminal')
    assert.deepEqual(terminal.map(event => event.stopReason), ['pause_turn', 'end_turn'])
    assert.deepEqual(terminal.map(event => event.usage.searchRequests), [1, 0], 'earlier paid searches are not recounted on continuation')
    assert.equal(result.sources[0].url, SOURCE.url); assert(result.text.includes('final grounded answer'))
    assert(!JSON.stringify([events, result]).includes('opaque-provider-state-do-not-change'))
  }, () => ++phase === 1 ? { stop_reason: 'pause_turn', content: pausedBlocks, usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 1 } } }
    : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'final grounded answer', citations: [{ type: 'web_search_result_location', ...SOURCE }] }], usage: { input_tokens: 150, output_tokens: 60, server_tool_use: { web_search_requests: 0 } } })
})

test('native continuation cannot bypass a later budget denial or revoked credential', async () => {
  for (const deny of ['budget', 'credential']) {
    let phase = 0
    await wire(async (transport, receipts) => {
      const ctx = client(transport, { beforeRequest: () => { if (deny === 'budget' && ++phase === 2) throw new Error('explicit budget denied') },
        resolveCredential: () => { if (deny === 'credential' && ++phase === 2) throw new Error('revoked'); return KEY } })
      await assert.rejects(ctx.execute(search(frozen('anthropic', 'anthropic-messages'))), /explicit budget|冻结.*凭据/)
      assert.equal(receipts.length, 1, 'denied continuation must make no second paid request')
    }, () => ({ stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 'srvtoolu_hold', name: 'web_search', input: { query: 'public' } }], usage: { input_tokens: 10, output_tokens: 5 } }))
  }
})
