const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const moduleView = { exports: {} }
new Function('require', 'module', 'exports', buildSync({ stdin: { contents: `export {streamChat} from './src/main/deepseek'; export {providerRequestBody} from './src/main/providerAdapters'; export {creativeApiFromFrozenProfile} from './src/main/creativeModel'; export {ProviderRegistryService} from './src/main/providerRegistry'; export {catalogReasoning} from './src/shared/modelCatalog'; export {loadCliConfig,kernelApi} from './src/cli/config'`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text)(require, moduleView, moduleView.exports)
const api = moduleView.exports
const params = (protocol, mode = 'default', effort = null, budgetTokens = null, mapping = null) => ({ model: 'local-model', messages: [{ role: 'user', content: 'fixture' }], apiKey: '', maxTokens: 8192, thinking: { enabled: mode !== 'disabled', effort: effort ?? 'default' }, provider: { adapterId: 'custom.openai-compatible-chat', protocol, chatPath: '/v1/messages', authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true }, reasoning: { mode, effort, budgetTokens }, compatibilityMappingId: mapping } })

test('provider default emits no reasoning toggle, effort or hidden budget in each native protocol', () => {
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
    const body = api.providerRequestBody(params(protocol), protocol)
    for (const key of ['thinking', 'enable_thinking', 'reasoning', 'reasoning_effort', 'output_config', 'thinking_budget']) assert.equal(body[key], undefined, `${protocol}: ${key}`)
  }
  assert.deepEqual(api.providerRequestBody(params('openai-responses', 'enabled', 'medium'), 'openai-responses').reasoning, { effort: 'medium' })
  assert.deepEqual(api.providerRequestBody(params('anthropic-messages', 'adaptive', null, null, 'anthropic.adaptive'), 'anthropic-messages').thinking, { type: 'adaptive' })
})

test('Anthropic new explicit budget is exact, not synthesized/clamped, while historical envelopes remain executable', () => {
  const explicit = params('anthropic-messages', 'enabled', null, 4096, 'anthropic.thinking')
  const body = api.providerRequestBody(explicit, 'anthropic-messages')
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 4096 }); assert.equal(body.max_tokens, 8192)
  assert.equal(body.output_config, undefined)
  assert.throws(() => api.providerRequestBody(params('anthropic-messages', 'enabled', null, null, 'anthropic.thinking'), 'anthropic-messages'), /显式|预算/)
  assert.throws(() => api.providerRequestBody(params('anthropic-messages', 'enabled', null, 8192, 'anthropic.thinking'), 'anthropic-messages'), /低于最大输出/)
  const old = params('anthropic-messages', 'enabled', 'high', null, 'anthropic.thinking'); delete old.provider.reasoning.budgetTokens
  assert.equal(api.providerRequestBody(old, 'anthropic-messages').thinking.budget_tokens, 8191)
})

test('budget-only model metadata exposes a numeric budget, never fictional low/medium/high effort', () => {
  const cap = api.catalogReasoning({ baseUrl: 'https://api.anthropic.com', transportPolicy: { protocol: 'anthropic-messages' } }, { providerId: 'anthropic', id: 'claude-older-budget', canonicalId: 'anthropic/claude-older-budget', reasoning: true, efforts: [], budget: true, toggle: true, maxOutputTokens: 64000 })
  assert.deepEqual(cap.efforts, []); assert.deepEqual(cap.budget, { min: 1024, max: 63999, step: 1 }); assert.equal(cap.mappingId, 'anthropic.thinking')
})

test('new and reset builtin profiles freeze model default; stale default effort is not an explicit override', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-default-reasoning-'))
  const registry = new api.ProviderRegistryService(path.join(home, 'db.sqlite'), { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
  const legacy = { maxTokens: 8192, temperature: 1, topP: 1, thinking: { enabled: true, effort: 'high' } }
  try {
    await registry.bootstrapDeepSeek({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'synthetic-default-only', thinkingEnabled: true, reasoningEffort: 'default', temperature: 1, topP: 1, maxTokens: 8192 })
    const snapshot = registry.snapshot(), profile = snapshot.profiles.find(item => item.id === snapshot.bindings.defaultProfileId)
    const freeze = () => registry.freezeStageProfiles(snapshot.bindings, legacy).draft
    assert.equal(freeze().wireReasoning.mode, 'default'); assert.equal(freeze().wireReasoning.thinking.effort, 'default'); assert.equal(freeze().wireReasoning.budgetTokens, null)
    registry.upsertProfile({ ...profile, reasoning: { mode: 'enabled', effort: 'max', budgetTokens: null } })
    assert.equal(freeze().wireReasoning.thinking.effort, 'max')
    registry.upsertProfile({ ...profile, reasoning: { mode: 'default', effort: null, budgetTokens: null } })
    assert.equal(freeze().wireReasoning.mode, 'default')
    registry.upsertProfile({ ...profile, reasoning: { mode: 'default', effort: 'high', budgetTokens: null } })
    assert.equal(freeze().wireReasoning.mode, 'default'); assert.equal(freeze().wireReasoning.thinking.effort, 'default')
    const provider = await registry.createProviderSetup({ displayName: '本机预算模型', baseUrl: 'http://127.0.0.1:48321/v1', apiKey: '', protocol: 'anthropic-messages', modelIds: ['claude-sonnet-4-5'] })
    const model = registry.snapshot().models.find(item => item.providerId === provider.id)
    assert.ok(model.capabilities.reasoning.budget)
    assert.deepEqual(model.capabilities.reasoning.efforts, [])
    const base = registry.ensureModelProfile(model.id)
    assert.throws(() => registry.upsertProfile({ ...base, reasoning: { mode: 'enabled', effort: null, budgetTokens: null }, compatibilityMappingId: 'anthropic.thinking' }), /显式填写/)
    const explicit = registry.upsertProfile({ ...base, generation: { ...base.generation, maxOutputTokens: 8192 }, reasoning: { mode: 'enabled', effort: null, budgetTokens: 4096 }, compatibilityMappingId: 'anthropic.thinking' })
    const frozenBudget = registry.freezeStageProfiles({ defaultProfileId: explicit.id }, legacy).draft
    assert.equal(frozenBudget.wireReasoning.budgetTokens, 4096)
    const request = api.providerRequestBody({ ...api.creativeApiFromFrozenProfile(frozenBudget, ''), messages: [{ role: 'user', content: '本机校验' }] }, 'anthropic-messages')
    assert.deepEqual(request.thinking, { type: 'enabled', budget_tokens: 4096 })

  } finally { registry.close(); assert.equal(path.dirname(home), os.tmpdir()); await fs.rm(home, { recursive: true, force: true }) }
})

test('CLI default follows the model; explicit off, effort, reset and Anthropic numeric budget stay distinct', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-cli-default-reasoning-'))
  try {
    const load = options => api.loadCliConfig(home, options ?? {}).then(result => result.config)
    const config = await load()
    assert.equal(config.thinking, null); assert.equal(config.effort, 'default'); assert.equal(api.kernelApi(config, '').reasoningMode, 'default')
    assert.equal(api.kernelApi(await load({ 'no-thinking': true }), '').reasoningMode, 'disabled')
    assert.equal(api.kernelApi(await load({ effort: 'max' }), '').thinking.effort, 'max')
    const responseConfig = await load({ protocol: 'openai-responses', model: 'local-reasoner', thinking: true, effort: 'medium' })
    assert.equal(api.kernelApi(responseConfig, '').thinking.effort, 'medium')
    await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ thinking: true, effort: 'high' }))
    assert.equal(api.kernelApi(await load(), '').reasoningMode, 'enabled')
    assert.equal(api.kernelApi(await load({ effort: 'default' }), '').reasoningMode, 'default')
    const budget = await load({ protocol: 'anthropic-messages', model: 'local-budget', 'thinking-budget': '2048', 'max-tokens': '6144' })
    assert.equal(api.kernelApi(budget, '').reasoningBudgetTokens, 2048)
  } finally { assert.equal(path.dirname(home), os.tmpdir()); await fs.rm(home, { recursive: true, force: true }) }
})

test('actual local native DeepSeek HTTP preserves omission versus explicit enable/off/effort', async () => {
  const bodies = []
  const server = http.createServer((req, res) => { let raw = ''; req.on('data', part => { raw += part }); req.on('end', () => { bodies.push(JSON.parse(raw)); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const [mode, effort] of [['default', 'default'], ['disabled', 'default'], ['enabled', 'default'], ['enabled', 'max']]) {
      const input = params('deepseek-chat', mode, effort)
      input.provider.adapterId = 'builtin.deepseek'; input.baseUrl = `http://127.0.0.1:${server.address().port}`; input.model = 'deepseek-flash'
      await api.streamChat(input, () => {})
    }
    assert.equal(bodies[0].thinking, undefined); assert.equal(bodies[0].reasoning_effort, undefined); assert.equal(bodies[0].temperature, undefined)
    assert.deepEqual(bodies[1].thinking, { type: 'disabled' }); assert.equal(bodies[1].reasoning_effort, undefined)
    assert.deepEqual(bodies[2].thinking, { type: 'enabled' }); assert.equal(bodies[2].reasoning_effort, undefined)
    assert.equal(bodies[3].reasoning_effort, 'max')
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
