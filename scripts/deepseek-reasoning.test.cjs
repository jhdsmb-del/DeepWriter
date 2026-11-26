const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { DatabaseSync } = require('node:sqlite')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let production
before(async () => {
  const result = await esbuild.build({ absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', tsconfigRaw: {},
    stdin: { loader: 'ts', resolveDir: root, contents: `export {streamChat} from './src/main/deepseek';export {ProviderRegistryService} from './src/main/providerRegistry';export {normalizeDeepSeekReasoningEffort,DEEPSEEK_REASONING_EFFORTS} from './src/shared/deepseekReasoning';` },
    plugins: [{ name: 'workspace-source', setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (!args.path.startsWith('.')) return { path: args.path, external: true }
        const target = path.resolve(args.resolveDir, args.path)
        const resolved = ['', '.ts', '/index.ts'].map(extension => target + extension).find(fs.existsSync)
        if (!resolved || !resolved.startsWith(root + path.sep)) throw new Error('Unexpected source boundary')
        return { path: resolved, namespace: 'source' }
      })
      build.onLoad({ filter: /.*/, namespace: 'source' }, args => ({ loader: args.path.endsWith('.json') ? 'json' : 'ts', resolveDir: path.dirname(args.path), contents: fs.readFileSync(args.path, 'utf8') }))
    } }] })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
  production = module.exports
})
const vault = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() }
const settings = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'synthetic-only', thinkingEnabled: true, reasoningEffort: 'high', temperature: 1, topP: 1, maxTokens: 8192 }
const defaults = { thinking: { enabled: true, effort: 'high' }, temperature: 1, topP: 1, maxTokens: 8192 }
async function fixture(body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-reasoning-'))
  const database = path.join(directory, 'test.db')
  let service = new production.ProviderRegistryService(database, vault)
  await service.bootstrapDeepSeek(settings)
  try { await body({ database, get service() { return service }, reopen: () => { service.close(); service = new production.ProviderRegistryService(database, vault); return service } }) }
  finally { service.close(); fs.rmSync(directory, { recursive: true, force: true }) }
}
const canonical = { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max', ultra: 'max', none: 'none' }
test('non-JSON HTTP error keeps its status without copying an upstream credential echo', async () => {
  const originalFetch = globalThis.fetch
  const dummy = 'fixture-only-never-transmitted'
  const response = new Response('offline request limit reached for bearer ' + dummy, { status: 403, headers: { 'content-type': 'text/plain' } })
  const attempts = []
  let fetches = 0, reads = 0
  const readText = response.text.bind(response)
  response.text = async () => { reads++; return readText() }
  globalThis.fetch = async () => { fetches++; return response }
  try {
    await assert.rejects(production.streamChat({ apiKey: dummy, baseUrl: 'http://127.0.0.1:9', model: 'offline-test',
      messages: [{ role: 'user', content: 'isolated response regression' }], thinking: { enabled: false, effort: 'high' }, maxTokens: 64 }, () => {}, undefined,
      () => assert.fail('a 403 must not be retried'), attempt => attempts.push(attempt)), error => {
      assert.equal(error.name, 'ApiStatusError')
      assert.equal(error.status, 403)
      assert.match(error.message, /403/)
      assert.equal(error.message.includes(dummy), false)
      return true
    })
    assert.equal(fetches, 1); assert.equal(reads, 1); assert.equal(response.bodyUsed, true)
    assert.equal(attempts.length, 1); assert.equal(attempts[0].outcome, 'http_error'); assert.equal(attempts[0].httpStatus, 403)
    assert.equal(JSON.stringify(attempts).includes(dummy), false)
  } finally { globalThis.fetch = originalFetch }
})
test('one shared official mapping preserves native low/high/max, removes fake medium stop and refuses unknown', () => {
  assert.deepEqual(production.DEEPSEEK_REASONING_EFFORTS, ['low', 'high', 'max'])
  for (const [input, expected] of Object.entries(canonical)) assert.equal(production.normalizeDeepSeekReasoningEffort(input), expected)
  assert.equal(production.normalizeDeepSeekReasoningEffort('invented-ultra-plus'), null)
})
test('actual SQLite compatibility upgrade touches only trusted official builtin metadata, not manual/unknown or old frozen bytes', async () => fixture(async f => {
  const original = f.service.snapshot()
  const model = original.models.find(model => model.remoteModelId === settings.model)
  const builtin = original.providers.find(provider => provider.id === model.providerId)
  const frozen = f.service.freezeStageProfiles({ defaultProfileId: original.bindings.defaultProfileId }, defaults)
  const frozenBytes = JSON.stringify(frozen)
  const manual = f.service.addManualModel({ providerId: builtin.id, remoteModelId: 'unknown-manual', displayName: '手动未知' })
  const sqlite = new DatabaseSync(f.database)
  try {
    const old = structuredClone(model.capabilities); old.reasoning.efforts = ['low', 'medium', 'high', 'max']; old.reasoning.detailCode = 'deepseek-golden-v1'
    sqlite.prepare('UPDATE provider_models SET capabilities_json=? WHERE id=?').run(JSON.stringify(old), model.id)
    sqlite.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('commercial-old-frozen', frozenBytes)
  } finally { sqlite.close() }
  f.reopen()
  const current = f.service.snapshot()
  assert.deepEqual(current.models.find(item => item.id === model.id).capabilities.reasoning.efforts, ['low', 'high', 'max'])
  assert.equal(current.models.find(item => item.id === model.id).capabilities.reasoning.detailCode, 'deepseek-thinking-mode-2026-10-03')
  assert.deepEqual(current.models.find(item => item.id === manual.id).capabilities, manual.capabilities)
  const reread = new DatabaseSync(f.database, { readOnly: true })
  try { assert.equal(reread.prepare('SELECT value FROM meta WHERE key=?').get('commercial-old-frozen').value, frozenBytes) } finally { reread.close() }
  const custom = await f.service.createCustomProvider({ displayName: '未知兼容提供方', baseUrl: 'http://127.0.0.1:43891', chatPath: '/v1/chat/completions', modelsPath: null, authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } })
  const customModel = f.service.addManualModel({ providerId: custom.id, remoteModelId: 'deepseek-flash', displayName: '名字不构成能力证据' })
  f.reopen()
  assert.deepEqual(f.service.snapshot().models.find(item => item.id === customModel.id).capabilities, customModel.capabilities)
}))
test('normal Profile freeze canonicalizes legacy aliases for new runs, while unverified model cannot gain reasoning', async () => fixture(async f => {
  const snapshot = f.service.snapshot(), base = snapshot.profiles.find(profile => profile.id === snapshot.bindings.defaultProfileId)
  for (const [input, expected] of Object.entries(canonical).filter(([input]) => input !== 'none')) {
    const profile = f.service.upsertProfile({ ...base, reasoning: { mode: 'enabled', effort: input, budgetTokens: null } })
    const frozen = f.service.freezeStageProfiles({ defaultProfileId: profile.id }, defaults).draft
    assert.equal(frozen.wireReasoning.thinking.enabled, true)
    assert.equal(frozen.wireReasoning.thinking.effort, expected)
    assert.equal(frozen.model.id, base.modelId)
  }
  const manual = f.service.addManualModel({ providerId: base.providerId, remoteModelId: 'manual-unknown-reasoning', displayName: '未知思考' })
  assert.throws(() => f.service.upsertProfile({ ...base, id: 'unknown-reasoning-profile', modelId: manual.id, reasoning: { mode: 'enabled', effort: 'high', budgetTokens: null } }), error => error.code === 'reasoning_effort_unsupported')
  f.service.upsertProfile({ ...base, reasoning: { mode: 'default', effort: 'high', budgetTokens: null } })
  for (const input of Object.keys(canonical)) {
    const frozen = f.service.freezeStageProfiles({ defaultProfileId: base.id }, { ...defaults, thinking: { enabled: true, effort: input } }).draft
    assert.equal(frozen.wireReasoning.mode, 'default')
    assert.equal(frozen.wireReasoning.thinking.effort, 'default')
  }
}))
test('production DeepSeek native HTTP bodies obey the shared alias map in explicit and legacy paths; none emits disabled', async () => {
  const bodies = []
  const server = http.createServer((request, response) => { let bytes = ''; request.on('data', part => { bytes += part }); request.on('end', () => { bodies.push(JSON.parse(bytes)); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n') }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  try {
    for (const mode of ['enabled', 'default']) for (const [input, expected] of Object.entries(canonical)) {
      const result = await production.streamChat({ apiKey: '', baseUrl: origin, model: 'deepseek-flash', messages: [{ role: 'user', content: '隔离强度回归' }], thinking: { enabled: true, effort: input }, maxTokens: 64, temperature: 1, topP: 1, provider: { providerId: 'provider.deepseek.builtin', adapterId: 'builtin.deepseek', protocol: 'deepseek-chat', chatPath: '/chat/completions', authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true, protocol: 'deepseek-chat' }, reasoning: { mode, effort: input }, compatibilityMappingId: null } }, () => {})
      assert.equal(result.finishReason, 'stop')
      const body = bodies.at(-1)
      assert.equal(body.thinking.type, expected === 'none' ? 'disabled' : 'enabled')
      assert.equal(body.reasoning_effort, expected === 'none' ? undefined : expected)
      assert.equal(body.model, 'deepseek-flash')
    }
  } finally { await new Promise(resolve => server.close(resolve)) }
})
