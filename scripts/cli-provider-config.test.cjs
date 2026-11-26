const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { test, before, after } = require('node:test')
const esbuild = require('esbuild')
const http = require('node:http')
let api, dir
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-cli-provider-'))
  const result = await esbuild.build({ stdin: { contents: `export * from './src/cli/config'; export { createCliRuntime } from './src/cli/runtime'`, resolveDir: path.resolve(__dirname, '..'), loader: 'ts' }, bundle: true, packages: 'external', alias: { electron: path.resolve(__dirname, '../src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
  api = module.exports
})
after(async () => {
  assert.equal(path.dirname(dir), os.tmpdir())
  assert.ok(path.basename(dir).startsWith('deepwriter-cli-provider-'))
  await fs.rm(dir, { recursive: true, force: true })
})
const load = (options) => api.loadCliConfig(dir, { 'key-env': 'DEEPWRITER_SYNTHETIC_TEST_UNUSED_KEY', ...options })
test('conventional Base URL and full endpoints resolve for each protocol', async () => {
  for (const [protocol, suffix] of [['openai-chat', '/chat/completions'], ['openai-responses', '/responses'], ['anthropic-messages', '/messages']]) {
    for (const prefix of ['', '/v1', '/proxy/v2']) {
      const base = 'http://127.0.0.1:48321'
      for (const raw of [base + prefix, base + (prefix || '/v1') + suffix]) {
        const { config, secret } = await load({ protocol, 'base-url': raw, loopback: true })
        assert.equal(config.baseUrl, base)
        assert.equal(config.chatPath, (prefix || '/v1') + suffix)
        assert.equal(secret, '')
      }
    }
  }
  assert.equal((await load({ 'base-url': 'http://127.0.0.1:48321', loopback: true })).config.chatPath, '/chat/completions')
})
test('legacy saved paths survive reload but new Base URL overrides stale path', async () => {
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:48321', chatPath: '/legacy/chat', loopback: true }))
  try {
    assert.equal((await load({})).config.chatPath, '/legacy/chat')
    assert.equal((await load({ 'base-url': 'http://127.0.0.1:48321/v1' })).config.chatPath, '/v1/chat/completions')
    assert.equal((await load({ 'base-url': 'http://127.0.0.1:48321/v1', 'chat-path': '/explicit' })).config.chatPath, '/explicit')
  } finally { await fs.unlink(path.join(dir, 'config.json')) }
})
test('unsafe or mismatched full endpoints still fail before credentials', async () => {
  for (const raw of ['http://127.0.0.1:48321/v1/responses', 'http://127.0.0.1:48321/v1?key=secret', 'http://127.0.0.1:48321/a/../v1', 'http://user:pass@127.0.0.1:48321']) {
    await assert.rejects(load({ protocol: 'openai-chat', 'base-url': raw, loopback: true }))
  }
})

test('legacy explicit environment names remain bound to their saved endpoint and old frozen readers remain usable', async () => {
  const name = 'DW_CLI_ORIGIN_UNIT_SYNTHETIC_ONLY', key = 'synthetic-origin-unit-key'
  process.env[name] = key
  const base = 'http://127.0.0.1:48321'
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ baseUrl: base, loopback: true, protocol: 'openai-chat', keyEnv: name }))
  try {
    const prior = await api.loadCliConfig(dir, {})
    assert.equal(prior.config.keyEnvOrigin, base); assert.equal(prior.secret, key)
    const moved = await api.loadCliConfig(dir, { 'base-url': 'http://127.0.0.1:48322' })
    assert.equal(moved.config.keyEnvOrigin, base); assert.equal(moved.secret, '')
    assert.equal(api.cliEnvironmentSecret({ baseUrl: base, keyEnv: name }), key)
    await assert.rejects(load({ loopback: true, 'no-loopback': true }), /不能同时指定/)
  } finally { delete process.env[name]; await fs.unlink(path.join(dir, 'config.json')) }
})

test('explicit key values never silently fall back on a type error and default preferences cannot carry an apiKey field', async () => {
  const file = path.join(dir, 'explicit-credential.json')
  try {
    await fs.writeFile(file, JSON.stringify({ apiKey: 12345 }))
    await assert.rejects(load({ config: file }), /必须为字符串/)
    await fs.writeFile(file, JSON.stringify({ apiKey: '' }))
    assert.equal((await load({ config: file })).secret, '')
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ apiKey: '' }))
    await assert.rejects(load({}), /默认 CLI 配置不允许存储密钥/)
  } finally { await fs.unlink(file); await fs.unlink(path.join(dir, 'config.json')).catch(() => {}) }
})
test('explicit protocol changes reset stale saved paths and auth headers but keep explicit overrides', async () => {
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:48321', chatPath: '/legacy/chat', authHeaderName: 'Authorization', loopback: true }))
  try {
    const unchanged = (await load({ protocol: 'openai-chat' })).config
    assert.equal(unchanged.chatPath, '/legacy/chat'); assert.equal(unchanged.authHeaderName, 'authorization')
    for (const extra of [{}, { 'base-url': 'http://127.0.0.1:48321/v1' }]) {
      const changed = (await load({ protocol: 'anthropic-messages', ...extra })).config
      assert.equal(changed.chatPath, '/v1/messages'); assert.equal(changed.authHeaderName, 'x-api-key')
      const explicit = (await load({ protocol: 'anthropic-messages', ...extra, 'chat-path': '/custom/messages', 'auth-header': 'Authorization' })).config
      assert.equal(explicit.chatPath, '/custom/messages'); assert.equal(explicit.authHeaderName, 'authorization')
    }
  } finally { await fs.unlink(path.join(dir, 'config.json')) }
})
test('native reasoning reuses protocol controls; generic chat never guesses mapping', async () => {
  for (const protocol of ['openai-responses', 'anthropic-messages']) {
    const { config } = await load({ protocol, thinking: true, model: 'synthetic', 'base-url': 'http://127.0.0.1:48321/v1', loopback: true })
    assert.equal(api.kernelApi(config, '').reasoningMode, 'enabled')
  }
  await assert.rejects(load({ protocol: 'openai-chat', thinking: true }), /mapping/)
  assert.throws(() => api.validateCliModel({ protocol: 'openai-chat', thinking: false, model: 'bad\nmodel' }), /模型名称/)
})
test('model switching changes only subsequent runs while session and frozen provider survive', async () => {
  const requests = [], results = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', data => { body += data })
    req.on('end', () => {
      requests.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '本机合成回复。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let runtime
  try {
    const { config, secret } = await load({ protocol: 'openai-chat', model: 'synthetic-first', 'base-url': `http://127.0.0.1:${server.address().port}/v1`, loopback: true })
    const dataDir = path.join(dir, 'model-switch')
    await fs.mkdir(dataDir)
    runtime = await api.createCliRuntime({ dataDir, config, secret, options: {}, emit: (type, data) => { if (type === 'result') results.push(data) } })
    await runtime.chat('第一条消息')
    const first = results.at(-1)
    const before = runtime.repo.getRun(first.runId).config_json
    assert.equal(runtime.setModel('synthetic-second'), 'synthetic-second')
    assert.throws(() => runtime.setModel(''), /模型名称/)
    await runtime.chat('第二条消息', first.sessionId)
    assert.equal(results.at(-1).sessionId, first.sessionId)
    assert.deepEqual(requests.map(request => request.model), ['synthetic-first', 'synthetic-second'])
    assert.equal(runtime.repo.getRun(first.runId).config_json, before)
    assert.equal(config.model, 'synthetic-first')
    assert.ok(requests.at(-1).messages.some(message => message.content === '本机合成回复。'))
    assert.equal(results.at(-1).amount, null)
    assert.equal(JSON.parse(before).cliProvider.unknownCostAccepted, true)
  } finally {
    await runtime?.close()
    await new Promise(resolve => server.close(resolve))
  }
})


test('default call limit is JSON null; saved historical finite limits require explicit unlimited override', async () => {
  const file = path.join(dir, 'config.json')
  assert.equal((await load({})).config.maxCalls, null)
  await fs.writeFile(file, JSON.stringify({ maxCalls: 64 }))
  try {
    assert.equal((await load({})).config.maxCalls, 64)
    const {config} = await load({'max-calls': 'unlimited'})
    assert.equal(config.maxCalls, null)
    await fs.writeFile(file, JSON.stringify(config))
    assert.equal((await load({})).config.maxCalls, null)
    assert.equal((await load({'max-calls': '16'})).config.maxCalls, 16)
    assert.equal((await load({'max-calls': '513'})).config.maxCalls, 513)
    for (const value of ['Infinity', 'NaN', '0', '-1', '9007199254740992']) await assert.rejects(load({'max-calls':value}), /max-calls/)
  } finally { await fs.unlink(file) }
})

test('Agent work limits default off; persisted numeric values survive and explicit unlimited stays off after save', async () => {
  const file = path.join(dir, 'config.json')
  const defaults = (await load({})).config
  assert.deepEqual(api.cliAgentRunBudget(defaults), {maxCalls:null,maxTurns:null,maxTokens:null,maxWallClockMs:null,maxCost:null})
  await fs.writeFile(file, JSON.stringify({ tokenBudget: 200000 }))
  assert.equal((await load({})).config.tokenBudget, null)
  const explicitDefaultAmount = (await load({'token-budget':'200000'})).config
  await fs.writeFile(file,JSON.stringify(explicitDefaultAmount));assert.equal((await load({})).config.tokenBudget,200000)
  await fs.writeFile(file, JSON.stringify({ maxCalls: 700, maxTurns: 22, tokenBudget: 30000000, timeBudgetMs: 90000001, costBudget: 12.5, costCurrency: 'EUR' }))
  try {
    const loaded = (await load({})).config
    assert.deepEqual(api.cliAgentRunBudget(loaded),{maxCalls:700,maxTurns:22,maxTokens:30000000,maxWallClockMs:90000001,maxCost:{amount:12.5,currency:'EUR',unknownPolicy:'deny'}})
    const off = (await load({'max-calls':'unlimited','max-turns':'unlimited','token-budget':'unlimited','time-budget-ms':'unlimited','cost-budget':'unlimited'})).config
    await fs.writeFile(file, JSON.stringify(off))
    assert.deepEqual(api.cliAgentRunBudget((await load({})).config),api.cliAgentRunBudget(defaults))
    for(const options of [{'token-budget':'0'},{'max-turns':'1.5'},{'time-budget-ms':'Infinity'},{'cost-budget':'NaN'},{'cost-budget':'1','cost-currency':'bad currency'}]) await assert.rejects(load(options))
  } finally { await fs.unlink(file) }
})

test('single-output wire intent survives reload independently of local reserve and known old factory defaults', async () => {
  const file=path.join(dir,'config.json')
  assert.equal((await load({})).config.outputTokenLimit,null)
  try {
    await fs.writeFile(file,JSON.stringify({maxTokens:2048,contextSource:'conservative_default'}));assert.equal((await load({})).config.outputTokenLimit,null)
    await fs.writeFile(file,JSON.stringify({maxTokens:7777}));assert.equal((await load({})).config.outputTokenLimit,7777)
    const explicit=(await load({'max-tokens':'12345',context:'65536'})).config;assert.equal(explicit.outputTokenLimit,12345);assert.ok(explicit.maxTokens<=8192)
    await fs.writeFile(file,JSON.stringify(explicit));assert.equal((await load({})).config.outputTokenLimit,12345)
    await fs.writeFile(file,JSON.stringify({...explicit,outputTokenLimit:null}));assert.equal((await load({})).config.outputTokenLimit,null)
  } finally {await fs.unlink(file)}
})
