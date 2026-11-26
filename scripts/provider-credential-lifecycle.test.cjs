const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { before, test } = require('node:test')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
before(async () => {
  const built = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `export * from './src/main/providerRegistry'; export {streamChat} from './src/main/deepseek'; export {buildProviderAuthHeaders,providerHttpErrorMessage} from './src/main/providerAuth';` }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports); api = module.exports
})
const vault = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text.split('').reverse().join('')), decryptString: blob => blob.toString().split('').reverse().join('') }
const legacy = overrides => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'synthetic-official', thinkingEnabled: false, reasoningEffort: 'high', temperature: 1, topP: 1, maxTokens: 128, ...overrides })
const defaults = { maxTokens: 128, temperature: 1, topP: 1, thinking: { enabled: false, effort: 'high' } }
async function fixture(body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-key-lifecycle-'))
  const database = path.join(directory, 'registry.db')
  let service = new api.ProviderRegistryService(database, vault)
  const reopen = () => { service.close(); service = new api.ProviderRegistryService(database, vault); return service }
  try { await body(() => service, reopen) } finally { service.close(); assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('dw-key-lifecycle-')); await fs.rm(directory, { recursive: true, force: true }) }
}
async function server(body) {
  const receipts = []
  const instance = http.createServer((req, res) => {
    let text = ''; req.on('data', chunk => { text += chunk }); req.on('end', () => {
      const request = { path: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: text ? JSON.parse(text) : null }; receipts.push(request)
      const anthropic = req.url.endsWith('/messages'), responses = req.url.endsWith('/responses')
      if (req.headers.accept !== 'text/event-stream') {
        res.writeHead(req.headers['content-type'] === 'application/json' ? 200 : 415, { 'content-type': 'application/json' })
        res.end(JSON.stringify(anthropic ? { content: [{ type: 'text', text: 'OK' }] } : responses ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] } : { choices: [{ message: { content: 'OK' } }] }))
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(anthropic ? 'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"OK"}}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {}\n\n'
          : responses ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
            : 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      }
    })
  })
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve))
  try { await body(`http://127.0.0.1:${instance.address().port}`, receipts) } finally { await new Promise(resolve => instance.close(resolve)) }
}
const freeze = (service, modelId) => service.freezeStageProfiles({ defaultProfileId: service.ensureModelProfile(modelId).id }, defaults, ['draft']).draft
async function chat(service, frozen) {
  const p = frozen.provider
  return api.streamChat({ model: frozen.model.remoteModelId, apiKey: frozen.credential ? service.resolveFrozenCredential(frozen.credential) : '', baseUrl: p.baseUrl,
    messages: [{ role: 'user', content: '合成凭据本地测试' }], maxTokens: 128, thinking: { enabled: false, effort: 'high' },
    provider: { adapterId: p.adapterId, protocol: p.transportPolicy.protocol, chatPath: p.chatPath, authStyle: p.authStyle, transportPolicy: p.transportPolicy,
      reasoning: { mode: 'default', effort: null }, compatibilityMappingId: null } }, () => {})
}
const setup = (origin, overrides = {}) => ({ displayName: 'Local fixture', baseUrl: origin + '/tenant/v2', apiKey: 'synthetic-first', protocol: 'openai-chat', modelIds: ['fixture-model'], ...overrides })

test('three protocols preserve exact encrypted credentials across save, switch, reopen, replace and explicit clear; chat and connection agree', async () => fixture(async (get, reopen) => server(async (origin, receipts) => {
  for (const [protocol, authHeaderName] of [['openai-chat', 'Authorization'], ['openai-responses', 'api-key'], ['anthropic-messages', 'x-api-key']]) {
    let service = get()
    const path = '/tenant/' + protocol + (protocol === 'anthropic-messages' ? '/messages' : protocol === 'openai-responses' ? '/responses' : '/chat/completions')
    const provider = await service.createCustomProvider({ displayName: protocol, baseUrl: origin, chatPath: path, modelsPath: null, authStyle: 'bearer', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true, protocol, authHeaderName, ...(protocol === 'anthropic-messages' ? { fixedHeaders: { 'anthropic-version': '2023-06-01' } } : {}) } })
    const credential = service.createCredential(provider.id, 'API Key', 'synthetic-first')
    const model = service.addManualModel({ providerId: provider.id, remoteModelId: 'fixture-model', displayName: 'Fixture' })
    service.setBindings({ defaultProfileId: service.ensureModelProfile(model.id).id })
    const old = freeze(service, model.id)
    service = reopen()
    await chat(service, freeze(service, model.id)); await service.testModelConnection(model.id, credential.id, true)
    for (const receipt of receipts.slice(-2)) {
      assert.equal(receipt.headers[authHeaderName.toLowerCase()], authHeaderName === 'Authorization' ? 'Bearer synthetic-first' : 'synthetic-first')
      assert.equal(receipt.rawHeaders.filter((name, i) => i % 2 === 0 && name.toLowerCase() === authHeaderName.toLowerCase()).length, 1)
      assert.ok(!receipt.path.includes('synthetic-')); assert.ok(!JSON.stringify(receipt.body).includes('synthetic-'))
    }
    const prefix = origin + path.replace(/\/(chat\/completions|responses|messages)$/, '')
    await service.updateProviderSetup({ providerId: provider.id, baseUrl: prefix, protocol, apiKey: 'synthetic-second' })
    await chat(service, freeze(service, model.id)); await service.testModelConnection(model.id, credential.id, true)
    assert.ok(receipts.slice(-2).every(receipt => receipt.headers[authHeaderName.toLowerCase()].includes('synthetic-second')))
    await chat(service, old); assert.ok(receipts.at(-1).headers[authHeaderName.toLowerCase()].includes('synthetic-first'))
    await service.updateProviderSetup({ providerId: provider.id, baseUrl: prefix, protocol, clearApiKey: true })
    service = reopen()
    assert.equal(service.snapshot().providers.find(row => row.id === provider.id).defaultCredentialRefId, null)
    const count = receipts.length
    assert.throws(() => freeze(service, model.id), error => error.code === 'credential_missing')
    await assert.rejects(service.testModelConnection(model.id, null, true), error => error.code === 'credential_missing')
    assert.equal(receipts.length, count); assert.equal(service.resolveFrozenCredential(old.credential), 'synthetic-first')
    assert.ok(!JSON.stringify(service.snapshot()).includes('synthetic-'))
  }
})))

test('legacy private/root endpoints migrate to their own provider, not the official vendor, and clearing never resurrects the legacy key', async () => fixture(async (get, reopen) => server(async (origin, receipts) => {
  let service = get()
  const input = legacy({ baseUrl: origin, model: 'private-model', apiKey: 'synthetic-private' })
  await service.bootstrapDeepSeek(input)
  const saved = service.snapshot(), profile = saved.profiles.find(row => row.id === saved.bindings.defaultProfileId)
  assert.notEqual(profile.providerId, 'provider.deepseek.builtin')
  const provider = saved.providers.find(row => row.id === profile.providerId)
  assert.equal(provider.baseUrl, origin); assert.equal(provider.chatPath, '/chat/completions')
  assert.equal(saved.credentials.filter(row => row.providerId === 'provider.deepseek.builtin').length, 0)
  await chat(service, freeze(service, profile.modelId)); await service.testModelConnection(profile.modelId, provider.defaultCredentialRefId, true)
  assert.ok(receipts.every(receipt => receipt.path === '/chat/completions' && receipt.headers.authorization === 'Bearer synthetic-private'))
  await service.updateProviderSetup({ providerId: provider.id, baseUrl: origin, protocol: 'openai-chat', clearApiKey: true })
  service = reopen(); await service.bootstrapDeepSeek(input)
  assert.equal(service.shouldUseRegistry(), true)
  assert.throws(() => freeze(service, profile.modelId), error => error.code === 'credential_missing')
  assert.equal(service.snapshot().providers.filter(row => row.baseUrl === origin).length, 1)
})))

test('builtin migration inherits its provider default and explicit local no-key never borrows another provider key', async () => fixture(async get => server(async (origin, receipts) => {
  const service = get(); await service.bootstrapDeepSeek(legacy({}))
  const other = service.createCredential('provider.deepseek.builtin', 'Explicit official replacement', 'synthetic-official-new')
  service.setDefaultCredential('provider.deepseek.builtin', other.id)
  assert.equal(service.resolveForRequest('profile.deepseek.default').secret, 'synthetic-official-new')
  const provider = await service.createProviderSetup(setup(origin, { apiKey: '', authStyle: 'none' }))
  const model = service.snapshot().models.find(row => row.providerId === provider.id)
  await chat(service, freeze(service, model.id)); await service.testModelConnection(model.id, null, true)
  assert.ok(receipts.every(receipt => !receipt.headers.authorization && !receipt.headers['x-api-key']))
  await assert.rejects(service.createProviderSetup(setup('https://fixture.invalid', { apiKey: '', authStyle: 'none' })), error => error.code === 'auth_mode_invalid')
})))

test('changing origin retires every old current reference, keeps accepted frozen versions, and never changes another supplier', async () => fixture(async get => server(async (first, receipts1) => server(async (second, receipts2) => {
  const service = get(), provider = await service.createProviderSetup(setup(first))
  const model = service.snapshot().models.find(row => row.providerId === provider.id)
  const old = freeze(service, model.id)
  const alternate = service.createCredential(provider.id, 'Alternate old endpoint', 'synthetic-alternate')
  const foreign = await service.createProviderSetup(setup(second, { apiKey: 'synthetic-foreign' }))
  await assert.rejects(service.updateProviderSetup({ providerId: provider.id, baseUrl: second + '/tenant/v2', protocol: 'openai-chat' }), error => error.code === 'credential_new_origin_required')
  await service.updateProviderSetup({ providerId: provider.id, baseUrl: second + '/tenant/v2', protocol: 'openai-chat', apiKey: 'synthetic-new-origin' })
  assert.throws(() => service.setDefaultCredential(provider.id, alternate.id), error => error.code === 'credential_missing')
  await chat(service, old); await chat(service, freeze(service, model.id))
  assert.equal(receipts1.at(-1).headers.authorization, 'Bearer synthetic-first'); assert.equal(receipts2.at(-1).headers.authorization, 'Bearer synthetic-new-origin')
  assert.equal(service.resolveFrozenCredential({ credentialRefId: foreign.defaultCredentialRefId, providerId: foreign.id, version: 1 }), 'synthetic-foreign')
  await assert.rejects(service.testModelConnection(model.id, foreign.defaultCredentialRefId, true), error => error.code === 'credential_missing')
}))))

test('native DeepSeek auth honors explicit local none and avoids double Bearer; public none is rejected before HTTP', async () => server(async (origin, receipts) => {
  const params = { model: 'deepseek-v4-flash', apiKey: 'Bearer synthetic-native', baseUrl: origin, messages: [{ role: 'user', content: 'Fixture' }], maxTokens: 32, thinking: { enabled: false, effort: 'high' },
    provider: { adapterId: 'builtin.deepseek', protocol: 'deepseek-chat', chatPath: '/chat/completions', authStyle: 'bearer', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true }, reasoning: { mode: 'default', effort: null }, compatibilityMappingId: null } }
  await api.streamChat(params, () => {}); assert.equal(receipts.at(-1).headers.authorization, 'Bearer synthetic-native')
  await api.streamChat({ ...params, apiKey: '', provider: { ...params.provider, authStyle: 'none' } }, () => {}); assert.equal(receipts.at(-1).headers.authorization, undefined)
  assert.throws(() => api.buildProviderAuthHeaders({ baseUrl: 'https://fixture.invalid', authStyle: 'none', transportPolicy: { scope: 'public_https', allowNonDefaultPort: false } }, null, { targetUrl: 'https://fixture.invalid/chat/completions' }), /本机/)
}))

test('HTTP status guidance distinguishes credential, model permission, balance, throttling and service failures', () => {
  for (const [status, expected] of [[401, /凭据.*API Key/], [403, /模型.*权限/], [402, /余额或配额/], [429, /限流/], [503, /暂时不可用/], [400, /HTTP 400.*API 格式/]]) {
    const message = api.providerHttpErrorMessage(status)
    assert.match(message, expected)
    if (status !== 401) assert.ok(!message.includes('API Key'))
  }
})

test('resource-host edits keep the selected api-key dialect while retiring old-origin credentials', async () => fixture(async get => server(async first => server(async (second, receipts) => {
  const service = get()
  const provider = await service.createCustomProvider({ displayName: 'Resource fixture', baseUrl: first, chatPath: '/openai/v1/responses', modelsPath: null, authStyle: 'bearer', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true, protocol: 'openai-responses', authHeaderName: 'api-key' } })
  service.createCredential(provider.id, 'API Key', 'synthetic-resource-old')
  const model = service.addManualModel({ providerId: provider.id, remoteModelId: 'fixture-deployment', displayName: 'Fixture deployment' })
  const updated = await service.updateProviderSetup({ providerId: provider.id, baseUrl: second + '/openai/v1', protocol: 'openai-responses', apiKey: 'synthetic-resource-new' })
  assert.equal(updated.transportPolicy.authHeaderName, 'api-key')
  await chat(service, freeze(service, model.id)); await service.testModelConnection(model.id, updated.defaultCredentialRefId, true)
  assert.ok(receipts.every(receipt => receipt.headers['api-key'] === 'synthetic-resource-new' && !receipt.headers.authorization))
}))))

test('ambiguous historical auto-migration is not reused for the official vendor; private prefixes and accepted frozen versions stay exact', async () => fixture(async (get, reopen) => server(async (origin, receipts) => {
  let service = get()
  // Reproduce an old release's misplaced automatic credential, using only a synthetic value.
  await service.bootstrapDeepSeek(legacy({ apiKey: 'synthetic-ambiguous' }))
  const accepted = freeze(service, service.snapshot().profiles.find(row => row.id === 'profile.deepseek.default').modelId)
  service = reopen()
  await service.bootstrapDeepSeek(legacy({ baseUrl: origin + '/private/api', model: 'private-model', apiKey: 'synthetic-private' }))
  const snapshot = service.snapshot(), profile = snapshot.profiles.find(row => row.id === snapshot.bindings.defaultProfileId)
  assert.equal(snapshot.providers.find(row => row.id === 'provider.deepseek.builtin').defaultCredentialRefId, null)
  assert.throws(() => service.resolveForRequest('profile.deepseek.default'), error => error.code === 'credential_missing')
  assert.equal(service.resolveFrozenCredential(accepted.credential), 'synthetic-ambiguous')
  await chat(service, freeze(service, profile.modelId))
  assert.equal(receipts.at(-1).path, '/private/api/chat/completions'); assert.equal(receipts.at(-1).headers.authorization, 'Bearer synthetic-private')
})))

test('clear is explicit and atomic, and an intentionally replaced retired reference has a usable new encrypted version', async () => fixture(async get => server(async origin => {
  const service = get(), provider = await service.createProviderSetup(setup(origin))
  const before = service.snapshot()
  await assert.rejects(service.updateProviderSetup({ providerId: provider.id, baseUrl: origin + '/tenant/v2', protocol: 'openai-chat', apiKey: 'synthetic-conflict', clearApiKey: true }), error => error.code === 'credential_action_conflict')
  assert.deepEqual(service.snapshot(), before)
  await service.updateProviderSetup({ providerId: provider.id, baseUrl: origin + '/tenant/v2', protocol: 'openai-chat', apiKey: '' })
  assert.equal(service.resolveFrozenCredential({ credentialRefId: provider.defaultCredentialRefId, providerId: provider.id, version: 1 }), 'synthetic-first')
  await service.updateProviderSetup({ providerId: provider.id, baseUrl: origin + '/tenant/v2', protocol: 'openai-chat', clearApiKey: true, authStyle: 'none' })
  const cleared = service.snapshot().providers.find(row => row.id === provider.id)
  assert.equal(cleared.authStyle, 'none'); assert.equal(cleared.defaultCredentialRefId, null)
  service.replaceCredential(provider.defaultCredentialRefId, 'synthetic-explicit-restore')
  service.setDefaultCredential(provider.id, provider.defaultCredentialRefId)
  await service.updateProviderSetup({ providerId: provider.id, baseUrl: origin + '/tenant/v2', protocol: 'openai-chat', authStyle: 'bearer' })
  assert.equal(service.resolveForRequest(service.ensureModelProfile(service.snapshot().models.find(row => row.providerId === provider.id).id).id).secret, 'synthetic-explicit-restore')
})))
