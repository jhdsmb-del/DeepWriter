'use strict'
// Only synthetic keys and loopback HTTP. Never reads owner settings.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { pathToFileURL } = require('node:url')
const { before, after, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const generated = []
let Registry, endpoint, catalog, adapter
before(async () => {
  for (const [name, source] of [['registry', 'src/main/providerRegistry.ts'], ['setup', 'src/shared/providerSetup.ts'], ['catalog', 'src/shared/modelCatalog.ts'], ['adapter', 'src/main/providerAdapters.ts']]) {
    const outfile = path.join(root, 'out', `model-import-${name}-${process.pid}.mjs`)
    generated.push(outfile)
    await esbuild.build({ entryPoints: [path.join(root, source)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
    const module = await import(pathToFileURL(outfile).href)
    if (name === 'registry') Registry = module.ProviderRegistryService
    else if (name === 'setup') endpoint = module.providerSetupEndpoint
    else if (name === 'catalog') catalog = module
    else adapter = module
  }
})
after(() => { for (const filename of generated) if (fs.existsSync(filename)) fs.unlinkSync(filename) })
const vault = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value.split('').reverse().join('')), decryptString: value => value.toString().split('').reverse().join('') }
async function fixture(action, storage = vault) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-model-import-'))
  const filename = path.join(directory, 'fixture.db')
  const service = new Registry(filename, storage)
  try { await action(service, filename) }
  finally {
    service.close()
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(filename + suffix)) fs.unlinkSync(filename + suffix)
    fs.rmdirSync(directory)
  }
}
const setup = (overrides = {}) => ({ displayName: 'Local fixture', baseUrl: 'http://127.0.0.1:12345/v1', apiKey: 'synthetic-fixture-key', protocol: 'openai-chat', modelIds: ['fixture-model'], ...overrides })

test('unknown custom model has a bounded frozen chat budget without invented metadata', async () => fixture(async service => {
  const provider = await service.createProviderSetup(setup())
  const model = service.snapshot().models.find(row => row.providerId === provider.id)
  const profile = service.ensureModelProfile(model.id)
  const frozen = service.freezeStageProfiles({ defaultProfileId: profile.id }, { maxTokens: 32768, temperature: 1, topP: 1, thinking: { enabled: false, effort: 'high' } })
  for (const name of ['default', 'planning', 'draft', 'review', 'polish']) {
    const stage = frozen[name]
    assert.equal(stage.model.contextWindow, null)
    assert.equal(stage.model.maxOutputTokens, null)
    assert.equal(stage.generation.maxOutputTokens, 2048)
    assert.deepEqual(stage.contextBudget, { contextWindowTokens: 8192, outputReserveTokens: 2048, source: 'conservative_default' })
  }
}))

test('conventional Base URL accepts /v1, custom prefix and full protocol endpoint without duplicating paths', () => {
  for (const [base, protocol, chatPath, modelsPath] of [
    ['https://example.com', 'openai-chat', '/v1/chat/completions', '/v1/models'],
    ['https://example.com/v1/', 'openai-chat', '/v1/chat/completions', '/v1/models'],
    ['https://example.com/api/v1', 'openai-chat', '/api/v1/chat/completions', '/api/v1/models'],
    ['https://example.com/v1/chat/completions', 'openai-chat', '/v1/chat/completions', '/v1/models'],
    ['https://example.com/chat/completions', 'openai-chat', '/chat/completions', '/models'],
    ['https://example.com/v1/messages', 'anthropic-messages', '/v1/messages', '/v1/models'],
    ['https://example.com/openai/v1/responses', 'openai-responses', '/openai/v1/responses', '/openai/v1/models']
  ]) {
    const parsed = endpoint(base, protocol)
    assert.equal(parsed.baseUrl, 'https://example.com'); assert.equal(parsed.chatPath, chatPath); assert.equal(parsed.modelsPath, modelsPath)
  }
  for (const base of ['https://secret@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#secret', 'https://example.com/a/../v1', 'https://example.com/a/%2e%2e/v1', 'https://example.com/v1/messages', 'https://example.com/\\v1']) assert.throws(() => endpoint(base, 'openai-chat'))
})

test('one save atomically creates encrypted key, provider, deduplicated models and immediately usable internal profiles', async () => fixture(async service => {
  const before = service.snapshot()
  const provider = await service.createProviderSetup(setup({ modelIds: ['first', 'second', 'first'] }))
  const saved = service.snapshot()
  assert.equal(provider.chatPath, '/v1/chat/completions'); assert.equal(provider.modelsPath, '/v1/models')
  assert.ok(provider.defaultCredentialRefId)
  const models = saved.models.filter(model => model.providerId === provider.id)
  assert.equal(models.length, 2)
  assert.equal(service.addManualModel({ providerId: provider.id, remoteModelId: 'first', displayName: 'first' }).id, models.find(model => model.remoteModelId === 'first').id)
  for (const model of models) {
    const profiles = saved.profiles.filter(profile => profile.modelId === model.id)
    assert.equal(profiles.length, 1); assert.equal(profiles[0].reasoning.mode, 'default')
    assert.equal(service.ensureModelProfile(model.id).id, profiles[0].id)
  }
  assert.equal(JSON.stringify(saved).includes('synthetic-fixture-key'), false)
  assert.deepEqual(saved.bindings, before.bindings)
  assert.equal(service.resolveFrozenCredential({ credentialRefId: provider.defaultCredentialRefId, providerId: provider.id, version: 1 }), 'synthetic-fixture-key')
}))

test('a failed model insert rolls back provider, credential secrets and every preceding model/profile', async () => fixture(async service => {
  const before = service.snapshot()
  service.db.exec("CREATE TRIGGER import_fail BEFORE INSERT ON provider_models WHEN NEW.remote_model_id='fail-fixture' BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
  await assert.rejects(service.createProviderSetup(setup({ modelIds: ['first', 'fail-fixture'] })))
  assert.deepEqual(service.snapshot(), before)
  assert.equal(service.db.prepare('SELECT COUNT(*) AS count FROM provider_credential_secrets').get().count, 0)
}))

test('unavailable safe storage and public HTTP cannot leave a partial supplier', async () => {
  await fixture(async service => {
    const before = service.snapshot()
    await assert.rejects(service.createProviderSetup(setup()), error => error.code === 'safe_storage_unavailable')
    assert.deepEqual(service.snapshot(), before)
  }, { ...vault, isEncryptionAvailable: () => false })
  await fixture(async service => {
    const before = service.snapshot()
    await assert.rejects(service.createProviderSetup(setup({ baseUrl: 'http://example.com/v1' })))
    await assert.rejects(service.createProviderSetup(setup({ baseUrl: 'https://example.com/v1', apiKey: '' })), error => error.code === 'credential_missing')
    assert.deepEqual(service.snapshot(), before)
  })
})

test('Anthropic format automatically supplies x-api-key and version; discovery imports only checked models', async () => fixture(async service => {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'chosen-model' }, { id: 'unselected-model' }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const provider = await service.createProviderSetup(setup({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'anthropic-messages' }))
    assert.equal(provider.chatPath, '/v1/messages')
    const preview = await service.discoverPreview(provider.id, provider.defaultCredentialRefId)
    assert.equal(service.snapshot().models.some(model => model.remoteModelId === 'chosen-model'), false)
    const accepted = service.acceptDiscovered(preview.discoveryId, ['chosen-model'])
    assert.equal(accepted.length, 1)
    assert.equal(service.snapshot().models.some(model => model.remoteModelId === 'unselected-model'), false)
    assert.ok(service.snapshot().profiles.some(profile => profile.modelId === accepted[0].id))
    assert.equal(requests.length, 1); assert.equal(requests[0].path, '/v1/models')
    assert.equal(requests[0].headers['x-api-key'], 'synthetic-fixture-key')
    assert.equal(requests[0].headers['anthropic-version'], '2023-06-01')
    assert.equal(requests[0].headers.authorization, undefined)
  } finally { await new Promise(resolve => server.close(resolve)) }
}))

test('offline catalog fills existing manual models and freezes actual controls without copying prices', async () => fixture(async service => {
  const provider = await service.createProviderSetup(setup({ modelIds: ['deepseek-flash', 'gpt-5.4', 'glm-4.5', 'unknown-local-model'] }))
  const models = service.snapshot().models.filter(row => row.providerId === provider.id)
  const deepseek = models.find(row => row.remoteModelId === 'deepseek-flash')
  assert.ok(deepseek.contextWindow > 100000); assert.ok(deepseek.maxOutputTokens > 10000)
  assert.deepEqual(deepseek.capabilities.reasoning.efforts, ['low', 'high', 'max'])
  assert.equal(deepseek.capabilities.reasoning.mappingId, 'openai_chat.thinking')
  assert.equal(deepseek.catalog.sourceUrl, 'https://models.dev/api.json'); assert.equal(deepseek.pricing, null)
  const profile = service.ensureModelProfile(deepseek.id)
  service.upsertProfile({ ...profile, reasoning: { mode: 'enabled', effort: 'max', budgetTokens: null }, compatibilityMappingId: 'openai_chat.thinking' })
  const frozen = service.freezeStageProfiles({ defaultProfileId: profile.id }, { maxTokens: 4096, temperature: 1, topP: 1, thinking: { enabled: false, effort: 'high' } }).default
  assert.equal(frozen.wireReasoning.thinking.effort, 'max'); assert.equal(frozen.wireReasoning.compatibilityMappingId, 'openai_chat.thinking')
  assert.equal(frozen.supportsTools, true)
  const gpt = models.find(row => row.remoteModelId === 'gpt-5.4')
  const gptProfile = service.ensureModelProfile(gpt.id)
  const defaultGpt = service.freezeStageProfiles({ defaultProfileId: gptProfile.id }, { maxTokens: 1000000, temperature: 1, topP: 1, thinking: { enabled: false, effort: 'high' } }).default
  assert.equal(defaultGpt.generation.maxOutputTokens, gpt.maxOutputTokens, 'existing writing consumers retain their frozen generation envelope')
  assert.equal(defaultGpt.contextBudget.outputReserveTokens, 8192, 'local reserve must not consume the model native output maximum from input space')
  assert.equal(defaultGpt.generation.outputTokenLimit, null)
  assert.equal(defaultGpt.model.maxOutputTokens, gpt.maxOutputTokens)
  assert.equal(defaultGpt.wireReasoning.mode, 'default'); assert.equal(defaultGpt.wireReasoning.compatibilityMappingId, 'openai_chat.reasoning_effort_top_level')
  assert.throws(() => service.upsertProfile({ ...profile, reasoning: { mode: 'enabled', effort: 'medium', budgetTokens: null }, compatibilityMappingId: 'openai_chat.thinking' }), /强度/)
  assert.throws(() => service.upsertProfile({ ...profile, reasoning: { mode: 'enabled', effort: 'high', budgetTokens: null }, compatibilityMappingId: 'openai_chat.enable_thinking' }), /思考方式/)
  assert.ok(models.find(row => row.remoteModelId === 'gpt-5.4').capabilities.reasoning.efforts.includes('xhigh'))
  assert.deepEqual(models.find(row => row.remoteModelId === 'glm-4.5').capabilities.reasoning.efforts, ['enabled'])
  const unknown = models.find(row => row.remoteModelId === 'unknown-local-model')
  assert.equal(unknown.contextWindow, null); assert.equal(unknown.catalog, undefined); assert.deepEqual(unknown.capabilities.reasoning.efforts, [])
}))

test('saved supplier URL/protocol/key edits preserve models and profiles; old frozen keys remain valid', async () => fixture(async service => {
  const provider = await service.createProviderSetup(setup())
  const before = service.snapshot()
  const model = before.models.find(model => model.providerId === provider.id)
  const profile = service.ensureModelProfile(model.id)
  const updated = await service.updateProviderSetup({ providerId: provider.id, baseUrl: 'http://127.0.0.1:12345/api/v1', protocol: 'openai-chat', apiKey: 'synthetic-replacement-key' })
  assert.equal(updated.id, provider.id); assert.equal(updated.chatPath, '/api/v1/chat/completions')
  assert.equal(updated.defaultCredentialRefId, provider.defaultCredentialRefId)
  assert.equal(service.snapshot().models.find(row => row.id === model.id).id, model.id)
  assert.equal(service.ensureModelProfile(model.id).id, profile.id)
  assert.equal(service.resolveFrozenCredential({ credentialRefId: provider.defaultCredentialRefId, providerId: provider.id, version: 1 }), 'synthetic-fixture-key')
  assert.equal(service.resolveFrozenCredential({ credentialRefId: provider.defaultCredentialRefId, providerId: provider.id, version: 2 }), 'synthetic-replacement-key')
  const changedProtocol = await service.updateProviderSetup({ providerId: provider.id, baseUrl: 'http://127.0.0.1:12345/api/v1', protocol: 'anthropic-messages' })
  assert.equal(changedProtocol.chatPath, '/api/v1/messages'); assert.equal(changedProtocol.transportPolicy.authHeaderName, 'x-api-key')
  assert.equal(changedProtocol.transportPolicy.fixedHeaders['anthropic-version'], '2023-06-01')
  assert.equal(JSON.stringify(service.snapshot()).includes('synthetic-replacement-key'), false)
}))

test('new-origin edits require a new key; failed encryption cannot save only half the configuration', async () => {
  let fail = false
  await fixture(async service => {
    const provider = await service.createProviderSetup(setup())
    const before = service.snapshot()
    await assert.rejects(() => service.updateProviderSetup({ providerId: provider.id, baseUrl: 'http://localhost:12345/v1', protocol: 'openai-chat' }), /重新填写 API Key/)
    assert.deepEqual(service.snapshot(), before)
    fail = true
    await assert.rejects(() => service.updateProviderSetup({ providerId: provider.id, baseUrl: 'http://127.0.0.1:12345/api/v1', protocol: 'openai-chat', apiKey: 'synthetic-new' }), /加密失败/)
    assert.deepEqual(service.snapshot(), before)
    fail = false
    const updated = await service.updateProviderSetup({ providerId: provider.id, baseUrl: 'http://localhost:12345/v1', protocol: 'openai-chat', apiKey: 'synthetic-new-origin' })
    assert.equal(updated.baseUrl, 'http://localhost:12345')
  }, { ...vault, encryptString: value => { if (fail) throw new Error('synthetic encryption failure'); return vault.encryptString(value) } })
})

test('adding first key to a keyless local provider activates authentication instead of ignoring it', async () => fixture(async service => {
  const provider = await service.createProviderSetup(setup({ apiKey: '' }))
  assert.equal(provider.authStyle, 'none')
  const updated = await service.updateProviderSetup({ providerId: provider.id, baseUrl: 'http://127.0.0.1:12345/v1', protocol: 'openai-chat', apiKey: 'synthetic-first-key' })
  assert.equal(updated.authStyle, 'bearer'); assert.ok(updated.defaultCredentialRefId)
}))

test('refreshing a manually added model preserves identity/profile and fills actual directory metadata', async () => fixture(async service => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 65536, max_output_tokens: 8192 }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const provider = await service.createProviderSetup(setup({ baseUrl: `http://127.0.0.1:${server.address().port}/v1` }))
    const before = service.snapshot().models.find(model => model.providerId === provider.id)
    const profile = service.ensureModelProfile(before.id)
    const preview = await service.discoverPreview(provider.id, provider.defaultCredentialRefId)
    const accepted = service.acceptDiscovered(preview.discoveryId, ['fixture-model'])
    assert.equal(accepted[0].id, before.id); assert.equal(accepted[0].contextWindow, 65536); assert.equal(accepted[0].maxOutputTokens, 8192)
    assert.equal(service.ensureModelProfile(before.id).id, profile.id)
    assert.equal(service.snapshot().models.filter(model => model.providerId === provider.id).length, 1)
  } finally { await new Promise(resolve => server.close(resolve)) }
}))

test('model connection tests generate a real short reply across three protocols and reject fake HTTP 200', async () => {
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) await fixture(async service => {
    const requests = []; let invalid = false
    const server = http.createServer((req, res) => {
      let text = ''
      req.on('data', chunk => { text += chunk })
      req.on('end', () => {
        requests.push({ url: req.url, body: JSON.parse(text), headers: req.headers })
        res.writeHead(200, { 'content-type': 'application/json' })
        const payload = protocol === 'openai-chat' ? { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }
          : protocol === 'anthropic-messages' ? { content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 5, output_tokens: 2 } }
          : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 5, output_tokens: 2 } }
        res.end(JSON.stringify(invalid ? { data: [] } : payload))
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const provider = await service.createProviderSetup(setup({ protocol, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }))
      const model = service.snapshot().models.find(row => row.providerId === provider.id)
      await assert.rejects(() => service.testModelConnection(model.id, provider.defaultCredentialRefId, false), /确认/)
      assert.equal(requests.length, 0)
      const result = await service.testModelConnection(model.id, provider.defaultCredentialRefId, true)
      assert.equal(result.status, 'connected'); assert.equal(result.usage.inputTokens, 5); assert.equal(result.usage.outputTokens, 2)
      assert.ok(result.durationMs >= 0); assert.equal(requests[0].body.stream, false); assert.equal(requests[0].body.model, 'fixture-model')
      assert.equal(JSON.stringify(result).includes('synthetic-fixture-key'), false)
      invalid = true
      await assert.rejects(() => service.testModelConnection(model.id, provider.defaultCredentialRefId, true), /有效模型回复/)
    } finally { await new Promise(resolve => server.close(resolve)) }
  })
})

function toolProbeReply(protocol, request) {
  const tool = request.tools[0]
  const name = tool.function?.name ?? tool.name
  const schema = tool.function?.parameters ?? tool.parameters ?? tool.input_schema
  const input = { nonce: schema.properties.nonce.enum[0] }
  if (protocol === 'anthropic-messages') return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call.fixture', name, input }], usage: { input_tokens: 12, output_tokens: 8 } }
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'function_call', id: 'fc.fixture', call_id: 'call.fixture', status: 'completed', name, arguments: JSON.stringify(input) }], usage: { input_tokens: 12, output_tokens: 8 } }
  return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ type: 'function', id: 'call.fixture', function: { name, arguments: JSON.stringify(input) } }] } }], usage: { prompt_tokens: 12, completion_tokens: 8 } }
}

const freezeTools = (service, model) => service.freezeStageProfiles({ defaultProfileId: service.ensureModelProfile(model.id).id }, { maxTokens: 512, temperature: 1, topP: 1, thinking: { enabled: false, effort: 'high' } }, ['default']).default

test('optional tool probe sends one harmless request to the exact model and freezes trusted evidence only for new runs across three protocols', async () => {
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) await fixture(async service => {
    const requests = []
    let alter = value => value
    const server = http.createServer((req, res) => {
      let text = ''
      req.on('data', chunk => { text += chunk })
      req.on('end', () => {
        const body = JSON.parse(text)
        requests.push({ url: req.url, body, headers: req.headers })
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(alter(toolProbeReply(protocol, body))))
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const provider = await service.createProviderSetup(setup({ protocol, baseUrl: `http://127.0.0.1:${server.address().port}/tenant/v2` }))
      const model = service.snapshot().models.find(row => row.providerId === provider.id)
      const frozenBefore = freezeTools(service, model)
      assert.equal(frozenBefore.supportsTools, false); assert.equal(requests.length, 0)
      await assert.rejects(() => service.probeModelTools(model.id, provider.defaultCredentialRefId, false), /确认/)
      assert.equal(requests.length, 0)
      const result = await service.probeModelTools(model.id, provider.defaultCredentialRefId, true)
      assert.equal(requests.length, 1); assert.equal(requests[0].url, provider.chatPath)
      assert.equal(requests[0].headers['content-type'], 'application/json')
      assert.equal(requests[0].body.model, model.remoteModelId); assert.equal(requests[0].body.stream, false)
      assert.equal(requests[0].body.tools.length, 1); assert.ok(requests[0].body.tool_choice)
      assert.ok(!JSON.stringify(requests[0].body).includes('synthetic-fixture-key'))
      assert.equal(result.outcome, 'supported'); assert.equal(result.capabilities.toolUse.source, 'protocol_probe')
      assert.equal(result.capabilities.toolUse.probeId, result.probeId)
      assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8, reasoningTokens: null })
      assert.equal(freezeTools(service, model).supportsTools, true); assert.equal(frozenBefore.supportsTools, false)
      assert.equal(result.capabilities.reasoning.state, 'unknown'); assert.equal(result.capabilities.streaming.state, 'unknown')
      alter = () => ({ error: { message: 'synthetic-fixture-key' } })
      const failed = await service.probeModelTools(model.id, provider.defaultCredentialRefId, true)
      assert.equal(failed.outcome, 'inconclusive'); assert.ok(!JSON.stringify(failed).includes('synthetic-fixture-key'))
      assert.equal(failed.capabilities.toolUse.probeId, result.probeId) // A failed retest does not replace valid earlier evidence.
    } finally { await new Promise(resolve => server.close(resolve)) }
  })
})

test('tool probe rejects filtered, partial, wrong-name, malformed and wrong-argument replies without inventing support', async () => {
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) await fixture(async (service, filename) => {
    let mutate = payload => payload
    let requests = 0
    const server = http.createServer((req, res) => {
      let text = ''
      req.on('data', chunk => { text += chunk })
      req.on('end', () => { requests++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(mutate(toolProbeReply(protocol, JSON.parse(text))))) })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const provider = await service.createProviderSetup(setup({ protocol, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }))
      const model = service.snapshot().models.find(row => row.providerId === provider.id)
      const call = payload => protocol === 'anthropic-messages' ? payload.content[0] : protocol === 'openai-responses' ? payload.output[0] : payload.choices[0].message.tool_calls[0].function
      const alterations = [
        payload => { call(payload).name = 'not_the_requested_function'; return payload },
        payload => { if (protocol === 'anthropic-messages') call(payload).input.nonce = 'wrong'; else call(payload).arguments = '{"nonce":"wrong"}'; return payload },
        payload => { if (protocol === 'anthropic-messages') call(payload).input.extra = true; else call(payload).arguments = '{"nonce":null,"extra":true}'; return payload },
        payload => { if (protocol === 'anthropic-messages') call(payload).input = JSON.stringify(call(payload).input); else call(payload).arguments = JSON.parse(call(payload).arguments); return payload },
        payload => { if (protocol === 'anthropic-messages') payload.stop_reason = 'refusal'; else if (protocol === 'openai-responses') payload.status = 'incomplete'; else payload.choices[0].finish_reason = 'content_filter'; return payload },
        payload => { if (protocol === 'anthropic-messages') payload.content.push({ type: 'refusal' }); else if (protocol === 'openai-responses') payload.output.push({ type: 'message', content: [{ type: 'refusal', refusal: 'filtered' }] }); else payload.choices[0].message.refusal = 'filtered'; return payload },
        payload => { payload.prompt_filter_results = [{ content_filter_results: { violence: { filtered: true } } }]; return payload },
        payload => { if (protocol === 'anthropic-messages') payload.content.push(structuredClone(call(payload))); else if (protocol === 'openai-responses') payload.output.push(structuredClone(call(payload))); else payload.choices[0].message.tool_calls.push(structuredClone(payload.choices[0].message.tool_calls[0])); return payload },
        () => ({ content: 'deepwriter_tool_probe({"nonce":"not-a-call"})' }),
        () => ({ error: { message: 'synthetic-fixture-key' } })
      ]
      if (protocol !== 'anthropic-messages') alterations.push(payload => { call(payload).arguments = 'not-json'; return payload })
      for (const change of alterations) {
        mutate = change
        const result = await service.probeModelTools(model.id, provider.defaultCredentialRefId, true)
        assert.equal(result.outcome, 'inconclusive'); assert.equal(result.capabilities.toolUse.state, 'unknown')
        assert.equal(freezeTools(service, model).supportsTools, false)
        assert.ok(!JSON.stringify(result).includes('synthetic-fixture-key'))
      }
      assert.equal(requests, alterations.length)
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(filename)
      try {
        const rows = db.prepare('SELECT outcome,ended_at,usage_json FROM provider_probes').all()
        assert.equal(rows.length, alterations.length); assert.ok(rows.every(row => row.outcome === 'inconclusive' && row.ended_at))
        assert.ok(!JSON.stringify(rows).includes('synthetic-fixture-key'))
      } finally { db.close() }
    } finally { await new Promise(resolve => server.close(resolve)) }
  })
})

test('tool probe preserves provider credential authority and rejects stale endpoint evidence', async () => fixture(async service => {
  let requests = 0
  let changeEndpoint = async () => {}
  const server = http.createServer((req, res) => {
    let text = ''
    req.on('data', chunk => { text += chunk })
    req.on('end', async () => { requests++; await changeEndpoint(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(toolProbeReply('openai-chat', JSON.parse(text)))) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const provider = await service.createProviderSetup(setup({ baseUrl: baseUrl + '/v1' }))
    const other = await service.createProviderSetup(setup({ baseUrl: baseUrl + '/other' }))
    const model = service.snapshot().models.find(row => row.providerId === provider.id)
    await assert.rejects(service.probeModelTools(model.id, other.defaultCredentialRefId, true), /凭据/)
    assert.equal(requests, 0)
    changeEndpoint = () => service.updateProviderSetup({ providerId: provider.id, baseUrl: baseUrl + '/new', protocol: 'openai-chat' })
    const result = await service.probeModelTools(model.id, provider.defaultCredentialRefId, true)
    assert.equal(requests, 1); assert.equal(result.outcome, 'inconclusive'); assert.equal(freezeTools(service, model).supportsTools, false)
  } finally { await new Promise(resolve => server.close(resolve)) }
}))

test('catalog matching is exact, handles manufacturer IDs and never guesses an ambiguous name or imports prices', () => {
  const directory = catalog.normalizeModelCatalog({ openai: { api: 'https://api.openai.com/v1', models: { 'named-model': { reasoning: true, limit: { context: 200000, output: 64000 }, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'xhigh'] }], cost: { input: 123 } } } }, proxy: { models: { 'named-model': { limit: { context: 1000 } } } } })
  const provider = { id: 'custom', baseUrl: 'https://example.com', chatPath: '/v1/chat/completions', transportPolicy: { protocol: 'openai-chat' } }
  assert.equal(catalog.findCatalogModel(provider, 'NAMED-MODEL', directory).providerId, 'openai')
  assert.equal(catalog.findCatalogModel(provider, 'named', directory), null)
  assert.equal(JSON.stringify(directory).includes('cost'), false)
  const ambiguous = catalog.normalizeModelCatalog({ p1: { models: { same: {} } }, p2: { models: { same: {} } } })
  assert.equal(catalog.findCatalogModel(provider, 'same', ambiguous), null)
  const proof = catalog.catalogReasoning(provider, directory.models[0])
  assert.deepEqual(proof.efforts, ['low', 'xhigh']); assert.ok(proof.modes.includes('disabled'))
})

test('selected reasoning controls reach real request bodies; default omits them and toggles are not fake strength levels', () => {
  const body = (protocol, mapping, effort, mode = 'enabled', maxTokens = 32000) => adapter.providerRequestBody({
    model: 'fixture', messages: [{ role: 'user', content: 'Hello' }], apiKey: 'synthetic', maxTokens,
    thinking: { enabled: mode === 'enabled', effort }, provider: { reasoning: { mode, effort }, compatibilityMappingId: mapping }
  }, protocol)
  assert.deepEqual(body('openai-chat', 'openai_chat.thinking', 'max').thinking, { type: 'enabled' })
  assert.equal(body('openai-chat', 'openai_chat.thinking', 'max').reasoning_effort, 'max')
  assert.deepEqual(body('openai-chat', 'openai_chat.thinking', 'enabled', 'disabled').thinking, { type: 'disabled' })
  assert.equal(body('openai-chat', 'openai_chat.enable_thinking', 'enabled').enable_thinking, true)
  assert.equal(body('openai-chat', 'openai_chat.enable_thinking', 'enabled').reasoning_effort, undefined)
  assert.deepEqual(body('openai-chat', 'openai_chat.reasoning', 'high').reasoning, { enabled: true, effort: 'high' })
  const gptDefault = body('openai-chat', 'openai_chat.reasoning_effort_top_level', 'high', 'default')
  assert.equal(gptDefault.max_tokens, undefined); assert.equal(gptDefault.max_completion_tokens, 32000)
  assert.equal(gptDefault.temperature, undefined); assert.equal(gptDefault.reasoning_effort, undefined)
  assert.deepEqual(body('openai-responses', 'openai_responses.reasoning_effort', 'xhigh').reasoning, { effort: 'xhigh' })
  assert.deepEqual(body('openai-responses', 'openai_responses.reasoning_effort', 'high', 'disabled').reasoning, { effort: 'none' })
  assert.deepEqual(body('anthropic-messages', 'anthropic.adaptive', 'max').thinking, { type: 'adaptive' })
  assert.deepEqual(body('anthropic-messages', 'anthropic.adaptive', 'max').output_config, { effort: 'max' })
  assert.deepEqual(body('anthropic-messages', 'anthropic.thinking_effort', 'high').output_config, { effort: 'high' })
  const claude = { id: 'claude-opus-4-6', providerId: 'anthropic', reasoning: true, efforts: ['low', 'medium', 'high', 'max'], budget: true, toggle: false }
  assert.equal(catalog.catalogReasoning({ baseUrl: 'https://api.anthropic.com', transportPolicy: { protocol: 'anthropic-messages' } }, claude).mappingId, 'anthropic.adaptive')
  assert.equal(catalog.catalogReasoning({ baseUrl: 'https://api.anthropic.com', transportPolicy: { protocol: 'anthropic-messages' } }, { ...claude, id: 'claude-opus-4-5', efforts: ['low', 'medium', 'high'] }).mappingId, 'anthropic.thinking_effort')
  assert.equal(body('anthropic-messages', 'anthropic.thinking', 'low').thinking.budget_tokens, 2048)
  assert.equal(body('anthropic-messages', 'anthropic.thinking', 'high').thinking.budget_tokens, 16384)
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
    const request = body(protocol, null, 'high', 'default')
    assert.equal(request.reasoning, undefined); assert.equal(request.thinking, undefined); assert.equal(request.reasoning_effort, undefined)
  }
})

test('explicit built-in profile output cap survives bootstrap instead of becoming a factory default on reopen', async () => fixture(async service => {
  const initial={baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'',thinkingEnabled:false,reasoningEffort:'default',temperature:1,topP:1,maxTokens:8192,outputTokenLimit:null}
  await service.bootstrapDeepSeek(initial)
  let profile=service.snapshot().profiles.find(item=>item.id==='profile.deepseek.default')
  assert.equal(profile.generation.maxOutputTokens,null)
  service.upsertProfile({...profile,generation:{...profile.generation,maxOutputTokens:12345}})
  await service.bootstrapDeepSeek(initial)
  profile=service.snapshot().profiles.find(item=>item.id==='profile.deepseek.default');assert.equal(profile.generation.maxOutputTokens,12345)
  service.upsertProfile({...profile,generation:{...profile.generation,maxOutputTokens:null}})
  await service.bootstrapDeepSeek(initial)
  assert.equal(service.snapshot().profiles.find(item=>item.id==='profile.deepseek.default').generation.maxOutputTokens,null)
}))
