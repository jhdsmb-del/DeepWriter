'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const loaded = { exports: {} }
new Function('require', 'module', 'exports', buildSync({ stdin: { resolveDir: root, contents: "export * from './src/main/publicWebTools'; export {buildToolSpecs,getTool,executeTool} from './src/main/tools'" }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, write: false }).outputFiles[0].text)(require, loaded, loaded.exports)
const api = loaded.exports
const defs = Object.fromEntries(api.createPublicWebTools().map(tool => [tool.name, tool]))
test('Agent schemas stay registered, but bare tools cannot obtain a service or transport', async () => {
  for (const name of ['web_search', 'read_web_page']) {
    assert(!api.buildToolSpecs(false).some(tool => tool.function.name === name))
    assert.equal(api.buildToolSpecs(true).filter(tool => tool.function.name === name).length, 1)
    assert.equal(api.getTool(name).name, name)
  }
  assert.equal(api.getTool('web_search_unsupported'), undefined)
  const result = await api.executeTool('web_search', { query: 'public evidence' }, root)
  assert.equal(result.ok, false); assert.match(result.message, /没有已授权/)
})
test('unsafe URLs and invalid arguments are refused before any provider call', async () => {
  let calls = 0
  const env = { providerWeb: { execute: async () => { calls++; return { text: '', sources: [] } } } }
  for (const url of ['file:///private.txt', 'http://127.0.0.1', 'http://localhost', 'http://10.0.0.1', 'https://user:password@example.com', 'https://example.com:8443']) assert.equal((await defs.read_web_page.execute({ url }, root, env)).ok, false)
  for (const args of [{ query: '' }, { query: 'a'.repeat(1501) }, { query: 'file:///private.txt' }, { query: 'x', num_results: 0 }]) assert.equal((await defs.web_search.execute(args, root, env)).ok, false)
  assert.equal(calls, 0)
})
test('only canonical service arguments are passed; bounded source text is usable but never an instruction', async () => {
  const calls = [], env = { providerWeb: { execute: async (...args) => { calls.push(args); return { text: '公开😀'.repeat(20000), sources: [{ title: 'source', url: 'https://example.com/a' }] } } } }
  const result = await defs.web_search.execute({ query: '来源', num_results: 2, apiKey: 'never-forward', endpoint: 'http://localhost' }, root, env)
  assert.equal(result.ok, true); assert.match(result.message, /不是可执行指令/); assert.match(result.message, /https:\/\/example.com\/a/)
  assert(Array.from(result.message).length <= 24000); assert(!/[\uD800-\uDFFF]/u.test(result.message)); assert.deepEqual(calls[0].slice(0, 2), ['search', { query: '来源', num_results: 2 }])
  const read = await defs.read_web_page.execute({ url: 'https://example.com/a', max_characters: 300 }, root, env)
  assert.equal(read.ok, true); assert.deepEqual(calls[1].slice(0, 2), ['fetch', { url: 'https://example.com/a', max_characters: 300 }])
})
test('cancelled and failed service calls do not invent content or sources', async () => {
  const stopped = new AbortController(); stopped.abort()
  const result = await defs.web_search.execute({ query: 'public' }, root, { signal: stopped.signal, providerWeb: { execute: async () => assert.fail('cancelled call cannot reach service') } })
  assert.equal(result.ok, false); assert.match(result.message, /已取消/)
  const failed = await defs.web_search.execute({ query: 'public' }, root, { providerWeb: { execute: async () => { throw new Error('供应商拒绝请求（401）') } } })
  assert.equal(failed.ok, false); assert.match(failed.message, /401/)
})