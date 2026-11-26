const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { build } = require('esbuild')

async function resource() {
  const reads = []
  const surface = new EventTarget()
  surface.ds = { providerSnapshot: () => new Promise((resolve, reject) => reads.push({ resolve, reject })) }
  const output = await build({ entryPoints: [path.resolve(__dirname, '../src/renderer/src/providerRegistryResource.ts')], bundle: true, platform: 'browser', format: 'cjs', write: false })
  const module = { exports: {} }
  new Function('module', 'exports', 'window', output.outputFiles[0].text)(module, module.exports, surface)
  return { api: module.exports, reads, surface }
}
const snapshot = id => ({ providers: [{ id }], models: [], profiles: [], credentials: [], bindings: null })

test('composer/settings/advanced share one in-flight read and populated metadata across unmount/reopen', async () => {
  const { api, reads } = await resource()
  let notices = 0
  const unsubscribe = api.subscribeProviderRegistry(() => notices++)
  const first = api.ensureProviderRegistry(), second = api.ensureProviderRegistry()
  assert.equal(first, second); assert.equal(reads.length, 1)
  const value = snapshot('provider-a'); reads[0].resolve({ ok: true, data: value })
  assert.equal(await first, value); assert.equal(notices, 1)
  unsubscribe()
  assert.equal(await api.ensureProviderRegistry(), value)
  assert.equal(reads.length, 1, 'reopening is not a fresh IPC read or an empty catalog')
})

test('mutation invalidation cannot be overwritten by an older read, including its awaiting consumers', async () => {
  const { api, reads, surface } = await resource()
  api.subscribeProviderRegistry(() => {})
  const old = api.ensureProviderRegistry()
  surface.dispatchEvent(new Event('deepwriter:provider-registry-changed'))
  const current = api.refreshProviderRegistry()
  assert.equal(reads.length, 2)
  reads[0].resolve({ ok: true, data: snapshot('obsolete') })
  await Promise.resolve()
  const value = snapshot('current'); reads[1].resolve({ ok: true, data: value })
  assert.equal(await old, value); assert.equal(await current, value)
  assert.equal(api.getProviderRegistrySnapshot(), value)
})

test('failed refresh retains last usable data and a later explicit refresh retries; focus updates after unmount', async () => {
  const { api, reads, surface } = await resource()
  const unsubscribe = api.subscribeProviderRegistry(() => {})
  const first = api.ensureProviderRegistry(), value = snapshot('saved')
  reads[0].resolve({ ok: true, data: value }); await first
  const failed = api.refreshProviderRegistry(); reads[1].reject(new Error('fixture failure'))
  assert.equal(await failed, value)
  unsubscribe()
  surface.dispatchEvent(new Event('focus'))
  assert.equal(reads.length, 3)
  const next = snapshot('changed-while-panel-closed'); reads[2].resolve({ ok: true, data: next })
  assert.equal(await api.ensureProviderRegistry(), next)
})
