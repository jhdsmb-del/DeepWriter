'use strict'

// Real local HTTP/SSE, synthetic credentials only. No cloud calls or user credential reads.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { before, after, test } = require('node:test')
const esbuild = require('esbuild')
const ROOT = path.resolve(__dirname, '..')
const generated = []
let auth, discovery, transport, adapters, snapshot, registry
before(async () => {
  const modules = {}
  for (const name of ['providerAuth', 'providerDiscovery', 'providerSecurity', 'providerAdapters', 'executionSnapshot', 'providerRegistry']) {
    const outfile = path.join(ROOT, 'out', `${name}-expansion-test-${process.pid}.mjs`)
    generated.push(outfile)
    await esbuild.build({ absWorkingDir: ROOT, entryPoints: [path.join(ROOT, 'src/main', name + '.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
    modules[name] = await import(pathToFileURL(outfile).href)
  }
  auth = modules.providerAuth; discovery = modules.providerDiscovery; transport = modules.providerSecurity; adapters = modules.providerAdapters; snapshot = modules.executionSnapshot; registry = modules.providerRegistry
})

test('provider hostname connects with Node automatic address selection using the approved answers', async () => {
  const net = require('node:net')
  const previous = net.getDefaultAutoSelectFamily()
  const server = http.createServer((req, res) => res.end(req.headers.host))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let lookups = 0
  try {
    net.setDefaultAutoSelectFamily(true)
    const host = 'localhost:' + server.address().port
    const response = await transport.secureProviderFetch('http://' + host + '/chat/completions',
      {}, { scope: 'loopback_http', allowNonDefaultPort: true }, async hostname => {
        assert.equal(hostname, 'localhost'); lookups++
        return [{ address: '127.0.0.1', family: 4 }]
      })
    assert.equal(await response.text(), host)
    assert.equal(lookups, 1)
  } finally {
    net.setDefaultAutoSelectFamily(previous)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

const syntheticVault = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value.split('').reverse().join('')), decryptString: value => value.toString().split('').reverse().join('') }
async function registryFixture(action) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-provider-expansion-'))
  const database = path.join(directory, 'fixture.db')
  const service = new registry.ProviderRegistryService(database, syntheticVault)
  try { await action(service) }
  finally {
    service.close()
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(database + suffix)) fs.unlinkSync(database + suffix)
    fs.rmdirSync(directory)
  }
}

function providerBundleFixture() {
  const evidence = { state: 'supported', source: 'protocol_probe', verifiedAt: '2026-10-03T00:00:00.000Z', probeId: 'probe.fixture', detailCode: 'fixture.accepted' }
  return {
    kind: 'deepwriter.provider-bundle', version: 1, exportedAt: '2026-10-03T00:00:00.000Z',
    providers: [{ externalId: 'external.fixture', displayName: 'Imported fixture', adapterId: 'custom.openai-compatible-chat', baseUrl: 'https://example.com', chatPath: '/tenant/v2/chat/completions', modelsPath: '/tenant/v2/models', authStyle: 'bearer', transportPolicy: { scope: 'public_https', allowNonDefaultPort: false, protocol: 'openai-chat' } }],
    models: [{ providerExternalId: 'external.fixture', remoteModelId: 'fixture/model-v2', displayName: 'Fixture model', declarations: { contextWindow: 32768, maxOutputTokens: 4096, capabilities: { text: { ...evidence }, streaming: { ...evidence }, reasoning: { ...evidence, modes: ['default', 'disabled', 'enabled'], efforts: ['medium', 'high'], budget: null, mappingId: 'openai_chat.reasoning_effort_top_level' }, toolUse: { ...evidence }, vision: { ...evidence }, structuredOutput: { ...evidence } } } }],
    profiles: [{ name: 'Configured fixture', providerExternalId: 'external.fixture', remoteModelId: 'fixture/model-v2', generation: { temperature: 0.4, topP: 0.8, maxOutputTokens: 2048, stream: true }, reasoning: { mode: 'enabled', effort: 'medium', budgetTokens: null }, compatibilityMappingId: 'openai_chat.reasoning_effort_top_level' }]
  }
}

test('provider bundle preview rejects duplicate and unresolved identities instead of silently dropping configured rows', async () => registryFixture(async service => {
  const initial = service.snapshot()
  const invalid = [
    bundle => { bundle.providers.push(structuredClone(bundle.providers[0])) },
    bundle => { bundle.models.push({ ...structuredClone(bundle.models[0]), remoteModelId: ' fixture/model-v2 ' }) },
    bundle => { bundle.models[0].providerExternalId = 'external.missing' },
    bundle => { bundle.profiles[0].providerExternalId = 'external.missing' },
    bundle => { bundle.profiles[0].remoteModelId = 'missing-model' }
  ]
  for (const alter of invalid) {
    const bundle = providerBundleFixture()
    alter(bundle)
    await assert.rejects(service.importPreview(bundle), error => error instanceof registry.ProviderRegistryError && error.code === 'bundle_invalid')
    assert.deepEqual(service.snapshot(), initial)
  }
}))

test('provider bundle import normalizes model references together and preserves endpoint paths and configured inference settings offline', async () => registryFixture(async service => {
  const bundle = providerBundleFixture()
  bundle.models[0].remoteModelId = ' fixture/model-v2 '
  bundle.profiles[0].remoteModelId = ' fixture/model-v2 '
  let externalCalls = 0
  service.resolver = async () => { externalCalls++; throw new Error('Import must stay offline') }
  service.safeStorage = { isEncryptionAvailable: () => { externalCalls++; throw new Error('Import must not access the vault') } }
  const preview = await service.importPreview(bundle)
  const result = await service.importCommit(preview.previewId)
  assert.deepEqual([result.providerIds.length, result.modelIds.length, result.profileIds.length], [1, 1, 1])
  const saved = service.snapshot()
  const provider = saved.providers.find(row => row.id === result.providerIds[0])
  const model = saved.models.find(row => row.id === result.modelIds[0])
  const profile = saved.profiles.find(row => row.id === result.profileIds[0])
  assert.equal(provider.baseUrl, bundle.providers[0].baseUrl)
  assert.equal(provider.chatPath, bundle.providers[0].chatPath)
  assert.equal(provider.modelsPath, bundle.providers[0].modelsPath)
  assert.equal(model.remoteModelId, 'fixture/model-v2')
  assert.equal(model.contextWindow, 32768); assert.equal(model.maxOutputTokens, 4096)
  assert.equal(model.capabilities.reasoning.source, 'imported_declaration')
  assert.equal(model.capabilities.reasoning.verifiedAt, null); assert.equal(model.capabilities.reasoning.probeId, null)
  assert.deepEqual(profile.generation, bundle.profiles[0].generation)
  assert.deepEqual(profile.reasoning, bundle.profiles[0].reasoning)
  assert.equal(profile.compatibilityMappingId, bundle.profiles[0].compatibilityMappingId)
  assert.equal(saved.credentials.length, 0); assert.equal(externalCalls, 0)
}))

test('five honest preset policies seed idempotently without replacing legacy settings or claiming deployment/model verification', async () => registryFixture(async service => {
  const settings = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: '', thinkingEnabled: true, reasoningEffort: 'high', temperature: 1, topP: 1, maxTokens: 8192 }
  await service.bootstrapDeepSeek(settings); await service.bootstrapDeepSeek(settings)
  const saved = service.snapshot()
  for (const name of ['openrouter', 'moonshot', 'minimax', 'groq', 'azure']) {
    const matches = saved.providers.filter(row => row.id === `provider.preset.${name}`)
    assert.equal(matches.length, 1)
    assert.equal(matches[0].transportPolicy.scope, 'public_https')
    assert.equal(matches[0].defaultCredentialRefId, null)
    assert.equal(saved.models.filter(row => row.providerId === matches[0].id).length, 0)
  }
  const azure = saved.providers.find(row => row.id === 'provider.preset.azure')
  assert.equal(azure.transportPolicy.authHeaderName, 'api-key')
  assert.equal(azure.modelsPath, null) // catalog model != resource deployment
  assert.ok(azure.baseUrl.includes('your-resource'))
  assert.equal(saved.bindings.defaultProfileId, 'profile.deepseek.default')
  assert.ok(saved.models.some(row => row.remoteModelId === 'deepseek-v4-flash'))
}))

test('actual registry discovery uses provider-bound auth, persists unknown facts honestly, and retains exact encrypted credential versions', async () => registryFixture(async service => {
  const receipts = []
  await server((req, res) => {
    receipts.push({ headers: req.headers, path: req.url })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'synthetic-1m-name', name: 'Synthetic', context_window: 4096, max_output_tokens: 128, context_length: 1000000, supports_reasoning: true, pricing: { prompt: '0.000002', completion: '0.000004' } }] }))
  }, async origin => {
    for (const header of ['Authorization', 'api-key', 'x-api-key', 'x-goog-api-key']) {
      const provider = await service.createCustomProvider({ displayName: 'Fixture ' + header, baseUrl: origin, chatPath: '/v1/chat/completions', modelsPath: '/v1/models', authStyle: 'bearer', transportPolicy: { ...LOCAL_POLICY, authHeaderName: header } })
      const credential = service.createCredential(provider.id, 'Synthetic', SECRET)
      assert.equal((await service.checkConnection(provider.id, credential.id)).status, 'protocol_verified')
      const preview = await service.discoverPreview(provider.id, credential.id)
      assert.equal(preview.catalogComplete, true)
      const [model] = service.acceptDiscovered(preview.discoveryId, ['synthetic-1m-name'])
      assert.equal(model.contextWindow, 4096); assert.equal(model.maxOutputTokens, 128)
      assert.equal(model.capabilities.reasoning.state, 'unknown'); assert.equal(model.capabilities.text.source, 'models_endpoint'); assert.equal(model.pricing, null)
      assert.equal(receipts.at(-1).headers[header.toLowerCase()], header === 'Authorization' ? 'Bearer ' + SECRET : SECRET)
      service.replaceCredential(credential.id, SECRET + '-new')
      assert.equal(service.resolveFrozenCredential({ credentialRefId: credential.id, providerId: provider.id, version: 1 }), SECRET)
      assert.equal(service.resolveFrozenCredential({ credentialRefId: credential.id, providerId: provider.id, version: 2 }), SECRET + '-new')
      await assert.rejects(service.discoverPreview('wrong-provider-id', credential.id))
    }
    assert.equal(receipts.length, 8)
  })
}))

test('actual text-only 200 probe remains inconclusive, and a malformed directory is never protocol verified', async () => registryFixture(async service => {
  let requests = 0
  await server((req, res) => {
    requests++
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
  }, async origin => {
    const provider = await service.createCustomProvider({ displayName: 'Text-only fixture', baseUrl: origin, chatPath: '/v1/chat/completions', modelsPath: '/v1/models', authStyle: 'bearer', transportPolicy: LOCAL_POLICY })
    const credential = service.createCredential(provider.id, 'Synthetic', SECRET)
    const model = service.addManualModel({ providerId: provider.id, remoteModelId: 'text-only', displayName: 'Text only' })
    await assert.rejects(service.checkConnection(provider.id, credential.id), error => error.code === 'model_discovery_invalid')
    const probe = await service.probeModel(model.id, credential.id, true)
    assert.equal(probe.outcome, 'inconclusive'); assert.equal(probe.capabilities.reasoning.state, 'unknown')
    assert.equal(probe.usage.reasoningTokens, null)
    assert.equal(requests, 2)
  })
}))

test('wired stream adapter refuses a secret extra-header before the fixture can receive any request', async () => {
  let requests = 0
  await server((_req, res) => { requests++; res.end() }, async origin => {
    const params = { model: 'synthetic', messages: [{ role: 'user', content: 'Fixture' }], thinking: { enabled: false, effort: 'high' }, maxTokens: 128, apiKey: SECRET, baseUrl: origin, provider: { adapterId: 'custom.openai-compatible-chat', protocol: 'openai-chat', chatPath: '/v1/chat/completions', authStyle: 'bearer', transportPolicy: LOCAL_POLICY, reasoning: { mode: 'default', effort: null }, compatibilityMappingId: null, extraHeaders: { 'X-Token': SECRET } } }
    await assert.rejects(adapters.streamWithProviderAdapter(params, () => {}), error => error.code === 'provider_auth_rejected' && !error.message.includes(SECRET))
    assert.equal(requests, 0)
  })
})
after(() => { for (const filename of generated) if (fs.existsSync(filename)) fs.unlinkSync(filename) })
const SECRET = 'synthetic-provider-fixture-only'
const LOCAL_POLICY = { scope: 'loopback_http', allowNonDefaultPort: true }
const official = (name, host, modelsPath = '/v1/models') => ({ id: `provider.preset.${name}`, baseUrl: host, modelsPath })
const OPENROUTER = official('openrouter', 'https://openrouter.ai', '/api/v1/models')
function quotedModel(changes = {}) {
  return { id: 'fixture/known-model', name: 'Known model', context_length: 100000, top_provider: { context_length: 64000, max_completion_tokens: 4000 }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'structured_outputs', 'reasoning'], pricing: { prompt: '0.000002', completion: '0.000004', input_cache_read: '0.0000005', request: '0', image: '0' }, ...changes }
}
async function server(handler, action) {
  const app = http.createServer(handler)
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  try { await action(`http://127.0.0.1:${app.address().port}`) }
  finally { await new Promise(resolve => app.close(resolve)) }
}

test('actual HTTP carries each static credential header exactly once, never as URL/body/extra header', async () => {
  const receipts = []
  await server((req, res) => { let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => { receipts.push({ url: req.url, rawHeaders: req.rawHeaders, headers: req.headers, body }); res.end('{}') }) }, async origin => {
    for (const name of ['Authorization', 'api-key', 'x-api-key', 'x-goog-api-key']) {
      const targetUrl = origin + '/v1/models'
      const headers = auth.buildProviderAuthHeaders({ baseUrl: origin, authStyle: 'bearer', authHeaderName: name, transportPolicy: LOCAL_POLICY }, SECRET, { targetUrl, providerId: 'local', credentialProviderId: 'local' })
      const result = await transport.secureProviderFetch(targetUrl, { headers }, LOCAL_POLICY)
      assert.equal(result.status, 200); await result.text()
      const receipt = receipts.at(-1)
      assert.equal(receipt.headers[name.toLowerCase()], name === 'Authorization' ? 'Bearer ' + SECRET : SECRET)
      assert.equal(receipt.rawHeaders.filter((item, index) => index % 2 === 0 && item.toLowerCase() === name.toLowerCase()).length, 1)
      assert.ok(!receipt.url.includes(SECRET)); assert.ok(!receipt.body.includes(SECRET))
    }
    assert.equal(receipts.length, 4)
  })
})

test('authentication policy rejects header injection, case duplicates, secret extras and provider/origin mismatch before HTTP', async () => {
  let received = 0
  await server((req, res) => { received++; res.end('{}') }, async origin => {
    const base = { baseUrl: origin, authStyle: 'bearer', transportPolicy: LOCAL_POLICY }
    const targetUrl = origin + '/v1/models'
    for (const extraHeaders of [{ Authorization: SECRET }, { 'API-Key': SECRET }, { 'X-Goog-Api-Key': SECRET }, { cookie: SECRET }, { 'X-Title': 'one', 'x-title': 'two' }, { 'X-Title': 'bad\r\nvalue' }]) assert.throws(() => auth.buildProviderAuthHeaders({ ...base, extraHeaders }, SECRET, { targetUrl }))
    for (const authHeaderName of ['Host', 'Content-Length', 'x-bad\nheader']) assert.throws(() => auth.buildProviderAuthHeaders({ ...base, authHeaderName }, SECRET, { targetUrl }))
    assert.throws(() => auth.buildProviderAuthHeaders(base, 'bad\r\ncredential', { targetUrl }))
    assert.throws(() => auth.buildProviderAuthHeaders(base, SECRET, { targetUrl, providerId: 'local', credentialProviderId: 'another' }))
    assert.throws(() => auth.buildProviderAuthHeaders(base, SECRET, { targetUrl: 'http://127.0.0.1:1/v1/models' }))
    assert.throws(() => auth.buildProviderAuthHeaders({ ...base, protocol: 'openai-chat', fixedHeaders: { 'anthropic-version': '2023-06-01' } }, SECRET, { targetUrl }))
    assert.equal(received, 0)
  })
})

test('30x redirect cannot forward a credential to another actual host/port fixture', async () => {
  let targetReceived = 0, sourceReceived = 0
  await server((req, res) => { targetReceived++; res.end('{}') }, async destination => {
    await server((req, res) => { sourceReceived++; res.writeHead(302, { location: destination + '/capture' }); res.end() }, async origin => {
      const targetUrl = origin + '/v1/models'
      const headers = auth.buildProviderAuthHeaders({ baseUrl: origin, authStyle: 'bearer', transportPolicy: LOCAL_POLICY }, SECRET, { targetUrl })
      await assert.rejects(transport.secureProviderFetch(targetUrl, { headers }, LOCAL_POLICY), /重定向/)
      assert.equal(sourceReceived, 1); assert.equal(targetReceived, 0)
    })
  })
})

test('public provider cannot inherit loopback/mixed private DNS or a cross-origin credential policy', async () => {
  const provider = { baseUrl: 'https://api.groq.com', authStyle: 'bearer', transportPolicy: { scope: 'public_https', allowNonDefaultPort: false } }
  assert.throws(() => auth.buildProviderAuthHeaders(provider, SECRET, { targetUrl: 'http://127.0.0.1:1/capture' }))
  await assert.rejects(transport.validateProviderEndpoint(provider.baseUrl, provider.transportPolicy, async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]))
  assert.throws(() => auth.buildProviderAuthHeaders(provider, SECRET, { targetUrl: 'https://other.example/v1/models' }))
})

test('OpenRouter schema consumes actual catalog bounds/capabilities and precise USD token units, but leaves routed cost untrusted', () => {
  const parsed = discovery.parseProviderDiscovery(OPENROUTER, { data: [quotedModel()] }, '2026-10-03T00:00:00.000Z')
  const model = parsed.models[0]
  assert.equal(model.contextWindow, 64000); assert.equal(model.maxOutputTokens, 4000)
  assert.equal(model.capabilities.toolUse.state, 'supported'); assert.equal(model.capabilities.toolUse.source, 'models_endpoint')
  assert.equal(model.capabilities.vision.state, 'supported'); assert.deepEqual(model.capabilities.reasoning.efforts, [])
  assert.equal(model.pricing.currency, 'USD'); assert.equal(model.pricing.inputMissPerMillion, 2); assert.equal(model.pricing.outputPerMillion, 4); assert.equal(model.pricing.cacheHitPerMillion, 0.5)
  assert.equal(model.pricing.canonicalOrigin, 'https://openrouter.ai'); assert.equal(model.pricing.reasoningBillingRule, 'unknown')
  assert.ok(model.pricingReview.includes('openrouter_route_not_frozen'))
  assert.equal(model.pricing.priceProfileHash, createHash('sha256').update(JSON.stringify({ ...model.pricing, id: undefined, priceProfileHash: undefined })).digest('hex'))
  const budget = snapshot.deriveProviderCallBudget({ pricingSnapshots: [model.pricing], maxCalls: 1, maxInputTokens: 1000, maxOutputTokens: 1000 })
  assert.equal(budget.maxCost.amount, 0); assert.equal(budget.maxCost.unknownPolicy, 'deny')
})

test('missing cache/extra charges/negative or malformed quote never becomes a guessed complete price', () => {
  for (const pricing of [{ prompt: '0.000002', completion: '0.000004', request: '0.01' }, { prompt: '-1', completion: '0.000004' }, { prompt: 'NaN', completion: '0' }, { prompt: '0.1', completion: '0.1', web_search: 'unknown' }]) {
    const model = discovery.parseProviderDiscovery(OPENROUTER, { data: [quotedModel({ pricing })] }).models[0]
    assert.equal(model.pricing, null); assert.ok(model.pricingReview.includes('price_upper_bound_unknown'))
  }
  const model = discovery.parseProviderDiscovery(OPENROUTER, { data: [quotedModel({ pricing: { prompt: '0.000002', completion: '0.000004' } })] }).models[0]
  assert.equal(model.pricing.cacheHitPerMillion, null)
  assert.equal(discovery.tokenRatePerMillion('0.000000001'), 0.001)
  assert.equal(discovery.tokenRatePerMillion('1.23456789'), 1234567.89)
  for (const invalid of [undefined, null, '', '1e-6', '-1', Infinity, ' 1', 0]) assert.equal(discovery.tokenRatePerMillion(invalid), null)
})

test('provider endpoint/path changes cannot borrow OpenRouter schema or official pricing even with the same preset id', () => {
  for (const provider of [{ ...OPENROUTER, baseUrl: 'https://other.example' }, { ...OPENROUTER, modelsPath: '/other/models' }]) {
    const parsed = discovery.parseProviderDiscovery(provider, { data: [quotedModel()] })
    assert.equal(parsed.family, 'generic'); assert.equal(parsed.models[0].pricing, null); assert.equal(parsed.models[0].contextWindow, null)
  }
})

test('Moonshot actual context_length/flags are evidence, not a name-based thinking effort declaration', () => {
  const parsed = discovery.parseProviderDiscovery(official('moonshot', 'https://api.moonshot.ai'), { data: [{ id: 'new-unknown-name', context_length: 262144, supports_reasoning: true, supports_image_in: false }] })
  assert.equal(parsed.models[0].contextWindow, 262144)
  assert.equal(parsed.models[0].capabilities.reasoning.source, 'models_endpoint')
  assert.deepEqual(parsed.models[0].capabilities.reasoning.efforts, [])
  assert.equal(parsed.models[0].capabilities.vision.state, 'unsupported')
  assert.equal(parsed.models[0].pricing, null)
})

test('MiniMax/Azure basic directories do not invent context/output/price or confuse catalog ids with deployments', () => {
  for (const provider of [official('minimax', 'https://api.minimax.io'), official('azure', 'https://example-resource.openai.azure.com', '/openai/v1/models')]) {
    const parsed = discovery.parseProviderDiscovery(provider, { data: [{ id: 'fictional-1m-100k-name', context_length: 1000000, max_output_tokens: 100000 }] })
    assert.equal(parsed.models[0].contextWindow, null); assert.equal(parsed.models[0].maxOutputTokens, null); assert.equal(parsed.models[0].pricing, null)
    assert.equal(parsed.models[0].capabilities.reasoning.state, 'unknown')
  }
})

test('Claude model metadata and pagination stay explicit; Mistral capabilities and max_context_length use official shapes', () => {
  const claude = discovery.parseProviderDiscovery(official('anthropic', 'https://api.anthropic.com'), { data: [{ id: 'claude-fixture', max_input_tokens: 100000, max_tokens: 8000, capabilities: { thinking: { supported: true }, image_input: { supported: true } } }], has_more: true, last_id: 'claude-fixture' })
  assert.equal(claude.models[0].contextWindow, 100000); assert.equal(claude.models[0].maxOutputTokens, 8000)
  assert.equal(claude.catalogComplete, false); assert.deepEqual(claude.nextPage, { kind: 'after_id', value: 'claude-fixture' })
  const mistral = discovery.parseProviderDiscovery(official('mistral', 'https://api.mistral.ai'), [{ id: 'mistral-fixture', max_context_length: 32768, capabilities: { completion_chat: true, function_calling: false, vision: false } }])
  assert.equal(mistral.models[0].contextWindow, 32768); assert.equal(mistral.models[0].capabilities.toolUse.state, 'unsupported')
})

test('discovery rejects malformed/oversized/duplicate ids and treats invalid numbers as unknown without guessing names', () => {
  for (const payload of [{}, { data: [{}] }, { data: [{ id: 'one' }, { id: 'one' }] }, { data: [{ id: 'bad\nname' }] }, { data: Array.from({ length: 501 }, (_, i) => ({ id: String(i) })) }]) assert.throws(() => discovery.parseProviderDiscovery(OPENROUTER, payload))
  const row = discovery.parseProviderDiscovery(OPENROUTER, { data: [quotedModel({ context_length: -1, top_provider: { context_length: '1000000', max_completion_tokens: 1.5 } })] }).models[0]
  assert.equal(row.contextWindow, null); assert.equal(row.maxOutputTokens, null)
})

test('existing actual Chat/Responses SSE adapters carry specialized auth and preserve body/usage/terminal semantics', async () => {
  const receipts = []
  await server((req, res) => { let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
    receipts.push({ headers: req.headers, body: JSON.parse(raw), path: req.url })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (req.url.endsWith('/responses')) {
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"fixture正文"}\n\n')
      res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"fixture-response","status":"completed","usage":{"input_tokens":10,"output_tokens":4,"output_tokens_details":{"reasoning_tokens":2}}}}\n\n')
    } else {
      const reasoningField = req.url.startsWith('/openai/') ? 'reasoning' : 'reasoning_content'
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { [reasoningField]: 'fixture思考' }, finish_reason: null }] }) + '\n\n')
      res.write('data: {"choices":[{"index":0,"delta":{"content":"fixture正文"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n')
      res.end('data: [DONE]\n\n')
    }
  }) }, async origin => {
    for (const [protocol, chatPath, authHeaderName] of [['openai-chat', '/v1/chat/completions', 'Authorization'], ['openai-responses', '/openai/v1/responses', 'api-key'], ['openai-chat', '/openai/v1/chat/completions', 'Authorization']]) {
      const events = []
      await adapters.streamWithProviderAdapter({ model: 'local-fixture', messages: [{ role: 'user', content: 'fixture输入' }], thinking: { enabled: false, effort: 'high' }, maxTokens: 128, apiKey: SECRET, baseUrl: origin, provider: { adapterId: 'custom.openai-compatible-chat', protocol, chatPath, authStyle: 'bearer', authHeaderName, transportPolicy: LOCAL_POLICY, reasoning: { mode: 'default', effort: null }, compatibilityMappingId: null } }, event => events.push(event))
      assert.ok(events.some(event => event.type === 'text' && event.delta === 'fixture正文'))
      assert.ok(events.some(event => event.type === 'done'))
      const receipt = receipts.at(-1)
      assert.equal(receipt.headers[authHeaderName.toLowerCase()], authHeaderName === 'Authorization' ? 'Bearer ' + SECRET : SECRET)
      assert.equal(receipt.body.model, 'local-fixture'); assert.equal(receipt.body.stream, true)
      assert.ok(!(JSON.stringify(receipt.body)).includes(SECRET))
      if (protocol === 'openai-responses') { assert.equal(receipt.body.store, false); assert.equal(receipt.body.max_output_tokens, 128); assert.ok(Array.isArray(receipt.body.input)) }
      else { assert.equal(receipt.body.max_tokens, 128); assert.ok(events.some(event => event.type === 'reasoning' && event.delta === 'fixture思考')) }
    }
    assert.equal(receipts.length, 3)
  })
})
