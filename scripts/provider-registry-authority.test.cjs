const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const { before, test } = require('node:test')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..')
let Registry
before(async () => {
  const result = await build({ entryPoints: [path.join(root, 'src/main/providerRegistry.ts')], bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
  Registry = module.exports.ProviderRegistryService
})
const vault = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value.split('').reverse().join('')), decryptString: value => value.toString().split('').reverse().join('') }
const initial = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: '', thinkingEnabled: false, reasoningEffort: 'high', temperature: 1, topP: 1, maxTokens: 128 }
const defaults = { maxTokens: 128, temperature: 1, topP: 1, thinking: { enabled: false, effort: 'high' } }
const saveBuiltin = (service, changes = {}) => service.updateProviderSetup({ providerId: 'provider.deepseek.builtin', baseUrl: initial.baseUrl, protocol: 'openai-chat', ...changes })
async function fixture(body, storage = vault) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-registry-authority-'))
  const database = path.join(directory, 'registry.db')
  let service = new Registry(database, storage)
  const reopen = async () => { service.close(); service = new Registry(database, storage); await service.bootstrapDeepSeek(initial); return service }
  try { await body(() => service, reopen, database) }
  finally { service.close(); assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('dw-registry-authority-')); await fs.rm(directory, { recursive: true, force: true }) }
}
function currentFrozen(service) {
  // Same authority decision used by chat:start. No test calls setBindings or
  // selects a model, and no request is sent to the official or any remote host.
  assert.equal(service.shouldUseRegistry(), true)
  return service.freezeStageProfiles(service.snapshot().bindings, defaults, ['draft']).draft
}

test('fresh official key-only save becomes the current request authority without selecting a model, including after reopen', async () => fixture(async (get, reopen) => {
  let service = get(); await service.bootstrapDeepSeek(initial)
  const bindings = service.snapshot().bindings
  assert.equal(service.isExplicitlyEnabled(), false); assert.equal(service.shouldUseRegistry(), false)
  const provider = await saveBuiltin(service, { apiKey: 'synthetic-fresh-key' })
  assert.deepEqual(service.snapshot().bindings, bindings); assert.equal(service.isExplicitlyEnabled(), false)
  let frozen = currentFrozen(service)
  assert.equal(frozen.provider.id, provider.id); assert.equal(frozen.provider.baseUrl, initial.baseUrl)
  assert.equal(frozen.provider.chatPath, '/chat/completions')
  assert.equal(service.resolveFrozenCredential(frozen.credential), 'synthetic-fresh-key')
  service = await reopen()
  frozen = currentFrozen(service)
  assert.deepEqual(service.snapshot().bindings, bindings); assert.equal(service.isExplicitlyEnabled(), false)
  assert.equal(service.resolveFrozenCredential(frozen.credential), 'synthetic-fresh-key')
}))

test('already-saved old UI credentials work after upgrade without a new marker, selection, or key re-entry', async () => fixture(async (get, reopen, database) => {
  const service = get(); await service.bootstrapDeepSeek(initial)
  const provider = await saveBuiltin(service, { apiKey: 'synthetic-previous-ui-key' })
  // Reproduce the existing encrypted database shape from the affected build,
  // which had a default ref but neither authority nor explicit-selection flag.
  const db = new DatabaseSync(database)
  try { db.prepare('DELETE FROM provider_registry_state WHERE key=?').run(`credential_authority:${provider.id}`) } finally { db.close() }
  const upgraded = await reopen()
  assert.equal(upgraded.isExplicitlyEnabled(), false)
  assert.equal(upgraded.resolveFrozenCredential(currentFrozen(upgraded).credential), 'synthetic-previous-ui-key')
}))

test('clearing current managed credentials retains authority and blocks legacy-key fallback immediately and after reopen', async () => fixture(async (get, reopen) => {
  let service = get(); await service.bootstrapDeepSeek(initial)
  await saveBuiltin(service, { apiKey: 'synthetic-to-clear' })
  const accepted = currentFrozen(service)
  await saveBuiltin(service, { clearApiKey: true })
  assert.equal(service.shouldUseRegistry(), true)
  assert.throws(() => currentFrozen(service), error => error.code === 'credential_missing')
  service = await reopen()
  assert.equal(service.shouldUseRegistry(), true)
  assert.throws(() => currentFrozen(service), error => error.code === 'credential_missing')
  assert.equal(service.resolveFrozenCredential(accepted.credential), 'synthetic-to-clear')
  // Even a stale nonempty legacy settings key must not revive this tombstone.
  await service.bootstrapDeepSeek({ ...initial, apiKey: 'synthetic-stale-legacy' })
  assert.throws(() => currentFrozen(service), error => error.code === 'credential_missing')
}))

test('adding or configuring an unbound supplier never selects its model or opts an untouched current model into registry auth', async () => fixture(async (get, reopen) => {
  let service = get(); await service.bootstrapDeepSeek(initial)
  const bindings = service.snapshot().bindings
  const other = await service.createProviderSetup({ displayName: 'Unbound local fixture', baseUrl: 'http://127.0.0.1:17361/v1', apiKey: 'synthetic-other-provider', protocol: 'openai-chat', modelIds: ['other-model'] })
  await service.updateProviderSetup({ providerId: other.id, baseUrl: 'http://127.0.0.1:17361/v1', protocol: 'openai-chat', apiKey: 'synthetic-other-updated' })
  assert.deepEqual(service.snapshot().bindings, bindings); assert.equal(service.shouldUseRegistry(), false)
  service = await reopen()
  assert.deepEqual(service.snapshot().bindings, bindings); assert.equal(service.shouldUseRegistry(), false)
  assert.equal(service.snapshot().providers.find(row => row.id === 'provider.deepseek.builtin').defaultCredentialRefId, null)
}))

test('legacy-only/untouched setup retains its route, and encryption failure does not half-enable managed authority', async () => {
  let fail = false
  await fixture(async (get, reopen) => {
    let service = get()
    assert.equal(service.shouldUseRegistry(), false)
    await service.bootstrapDeepSeek(initial)
    assert.equal(service.shouldUseRegistry(), false)
    fail = true
    await assert.rejects(saveBuiltin(service, { apiKey: 'synthetic-must-not-save' }), error => error.code === 'safe_storage_failed')
    assert.equal(service.shouldUseRegistry(), false)
    assert.equal(service.snapshot().credentials.length, 0)
    service = await reopen(); assert.equal(service.shouldUseRegistry(), false)
  }, { ...vault, encryptString: value => { if (fail) throw new Error('synthetic storage failure'); return vault.encryptString(value) } })
})
