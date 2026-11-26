'use strict'

// Only local synthetic providers. No real credential lookup or model requests.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { pathToFileURL } = require('node:url')
const { test, before, after } = require('node:test')
const esbuild = require('esbuild')
const ROOT = path.resolve(__dirname, '..')
let pricing
let runner
const outputs = []
before(async () => {
  for (const name of ['eval-pricing', 'eval-runner', 'benchmark-real']) {
    const outfile = path.join(ROOT, 'out', `${name}-pricing-test-${process.pid}.mjs`)
    outputs.push(outfile)
    await esbuild.build({ absWorkingDir: ROOT, entryPoints: [path.join(ROOT, 'scripts', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
    if (name === 'benchmark-real') continue // Native CLI only; importing would run main.
    const imported = await import(pathToFileURL(outfile).href)
    if (name === 'eval-pricing') pricing = imported
    else runner = imported
  }
})
after(() => { for (const output of outputs) if (fs.existsSync(output)) fs.unlinkSync(output) })
function profile(origin = 'http://127.0.0.1:1234') {
  return { schemaVersion: 1, profileId: 'explicit-local-fixture', providerId: 'eval.local', endpointOrigins: [origin], currency: 'CNY', unit: 'per-1M-tokens', source: 'Explicit synthetic local fixture, not official provider evidence', updatedAt: '2026-10-03', prices: [{ model: 'fixture-model', inputPer1M: 1, outputPer1M: 2, cacheHitPer1M: 0.5 }] }
}
function bridge(p = profile(), overrides = {}) {
  return pricing.freezeEvalPricing({ profile: p, providerId: 'eval.local', model: 'fixture-model', canonicalOrigin: p.endpointOrigins[0], currency: 'CNY', trustedProfileHash: pricing.evalProfileHash(p), ...overrides })
}
test('explicit authorized reference binds provider/origin/model/currency and both hashes without claiming official', () => {
  const p = profile()
  const frozen = bridge(p)
  assert.equal(frozen.record.source, 'user_supplied')
  assert.equal(frozen.record.providerId, 'eval.local')
  assert.equal(frozen.record.canonicalOrigin, p.endpointOrigins[0])
  assert.equal(frozen.record.currency, 'CNY')
  assert.equal(frozen.record.inputMissPerMillion, 1)
  assert.equal(frozen.record.priceProfileHash.length, 64)
  assert.equal(frozen.provenance.profileHash, pricing.evalProfileHash(p))
  assert.equal(frozen.provenance.officialEvidence, false)
  const original = JSON.stringify(frozen)
  p.prices[0].inputPer1M = 9
  assert.equal(JSON.stringify(frozen), original)
})
test('missing, mismatched, changed or untrusted profiles are refused before an adapter can send', () => {
  for (const change of [{ profile: null }, { trustedProfileHash: '' }, { trustedProfileHash: 'a'.repeat(64) }, { providerId: 'another' }, { model: 'another' }, { canonicalOrigin: 'https://other.example' }, { currency: 'USD' }]) assert.throws(() => bridge(profile(), change))
  const p = profile(); p.unit = 'per-token'
  assert.throws(() => bridge(p))
  const malformed = profile(); malformed.source = ''
  assert.throws(() => bridge(malformed))
})
test('frozen adapter selection rejects changed identity or price hash instead of resolving current prices', () => {
  const frozen = bridge()
  const config = { model: 'fixture-model', baseUrl: 'http://127.0.0.1:1234', providerPricingSnapshots: [frozen.record] }
  assert.deepEqual(pricing.pricingForFrozenEvalConfig(config, 'eval.local', 'CNY'), frozen.record)
  assert.equal(pricing.pricingForFrozenEvalConfig({ ...config, model: 'another' }, 'eval.local', 'CNY'), null)
  assert.equal(pricing.pricingForFrozenEvalConfig({ ...config, baseUrl: 'https://another.example' }, 'eval.local', 'CNY'), null)
  assert.equal(pricing.pricingForFrozenEvalConfig(config, 'another', 'CNY'), null)
  assert.equal(pricing.pricingForFrozenEvalConfig(config, 'eval.local', 'USD'), null)
  assert.equal(pricing.pricingForFrozenEvalConfig({ ...config, providerPricingSnapshots: [{ ...frozen.record, outputPerMillion: 0 }] }, 'eval.local', 'CNY'), null)
})
test('synthetic mock reference requires the exact local mock origin and is never an official quote', () => {
  const fixture = pricing.createSyntheticEvalPriceProfile('http://127.0.0.1:1234', 'fixture-model')
  assert.equal(fixture.providerId, 'eval.synthetic.local')
  assert.ok(fixture.source.includes('synthetic'))
  assert.throws(() => pricing.createSyntheticEvalPriceProfile('https://api.deepseek.com', 'fixture-model'))
})
test('waiting_user and recovery_required are immediate failed eval observations, not completion', () => {
  assert.equal(pricing.isEvalDurablePause('waiting_user'), true)
  assert.equal(pricing.isEvalDurablePause('recovery_required'), true)
  assert.equal(pricing.isEvalDurablePause('completed'), false)
})

async function endpoint(task, failures = 0) {
  let received = 0
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      received++
      requests.push(body)
      if (received <= failures) { res.writeHead(503); res.end('synthetic failed provider attempt'); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '这是本地价格桥测试的完整回答。' }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await task(`http://127.0.0.1:${server.address().port}`, () => received, requests) }
  finally { await new Promise(resolve => server.close(resolve)) }
}
function settings(origin) {
  return { model: 'fixture-model', baseUrl: origin, apiKey: 'synthetic-fixture-only', maxTokens: 256, temperature: 1, topP: 1, thinkingEnabled: false, reasoningEffort: 'medium', historyBudgetTokens: 8000, novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, workDir: '', docDir: '' }
}
test('actual eval current/hardened adapter and engine receive one same frozen price and can call only the local server', async () => endpoint(async (origin, received, requests) => {
  const frozen = bridge(profile(origin))
  const localSettings = settings(origin)
  const unified = await runner.createUnifiedOrchestration({ baseUrl: origin, model: localSettings.model, settings: localSettings, sampling: { temperature: 1, topP: 1, maxTokens: 256, thinkingEnabled: false }, pricing: frozen })
  try {
    for (const [id, mode] of [['current', 'agent'], ['hardened', 'style']]) {
      unified.repo.createSession(id, 'local fixture', localSettings.model)
      const result = await unified.runStage({ runId: `price-${id}`, sessionId: id, userText: '请给出简短回答', mode, longMode: false, story: null, settings: localSettings, fairAuth: 'synthetic-fixture-only', targetChars: 0 })
      assert.equal(result.terminalStatus, 'completed')
      const config = unified.kernelConfigs.get(result.runId)
      assert.deepEqual(config.providerPricingSnapshots, [frozen.record])
      assert.equal(config.providerCallBudget.maxCost.currency, 'CNY')
      assert.ok(config.providerCallBudget.maxCost.amount > 0)
      if (mode === 'agent') assert.equal(config.outputTokenLimit, 256)
    }
    assert.equal(received(), 2)
    assert.ok(requests.every(body => JSON.parse(body).max_tokens > 0 && JSON.parse(body).max_tokens <= 256))
  } finally { unified.close() }
}))
test('actual engine missing-price rejection sends zero requests and preserves waiting_user without timeout/cancel', async () => endpoint(async (origin, received) => {
  const localSettings = settings(origin)
  const unified = await runner.createUnifiedOrchestration({ baseUrl: origin, model: localSettings.model, settings: localSettings, sampling: { temperature: 1, topP: 1, maxTokens: 256, thinkingEnabled: false }, pricing: null })
  try {
    unified.repo.createSession('missing-price', 'local fixture', localSettings.model)
    const started = Date.now()
    const result = await unified.runStage({ runId: 'missing-price', sessionId: 'missing-price', userText: 'fixture', mode: 'agent', longMode: false, story: null, settings: localSettings, fairAuth: 'synthetic-fixture-only', targetChars: 0 })
    assert.equal(result.terminalStatus, 'waiting_user')
    assert.equal(result.errorCode, 'run_cost_unknown_price')
    assert.equal(unified.repo.getRun(result.runId).status, 'waiting_user')
    assert.equal(result.projectionOk, false)
    assert.ok(Date.now() - started < 5000)
    assert.equal(received(), 0)
  } finally { unified.close() }
}))

test('independent eval amount authorization survives unlimited product settings in current and longwrite engine paths', async () => endpoint(async (origin, received) => {
  const localSettings = { ...settings(origin), agentRunBudget: { maxCalls: null, maxTurns: null, maxTokens: null, maxWallClockMs: null, maxCost: null } }
  const maxCostCny = 1e-9
  const unified = await runner.createUnifiedOrchestration({ baseUrl: origin, model: localSettings.model, settings: localSettings, sampling: { temperature: 1, topP: 1, maxTokens: 256, thinkingEnabled: false }, pricing: bridge(profile(origin)), maxCostCny })
  try {
    for (const mode of ['agent', 'longwrite']) {
      const id = 'explicit-eval-' + mode
      unified.repo.createSession(id, 'synthetic amount authorization', localSettings.model)
      const result = await unified.runStage({ runId: id, sessionId: id, userText: 'fixture', mode, longMode: mode === 'longwrite', story: null, settings: localSettings, fairAuth: 'synthetic-fixture-only', targetChars: 100 })
      const config = unified.kernelConfigs.get(id)
      assert.deepEqual(config.providerCallBudget.maxCost, { amount: maxCostCny, currency: 'CNY', unknownPolicy: 'deny' })
      assert.ok(config.providerCallBudget.maxTokens > 0)
      if (config.completionContract) assert.deepEqual(config.completionContract.providerCallBudget, config.providerCallBudget)
      assert.equal(result.terminalStatus, 'waiting_user'); assert.equal(result.errorCode, 'run_cost_budget')
      assert.equal(unified.repo.getRun(id).status, 'waiting_user')
    }
    assert.equal(received(), 0)
  } finally { unified.close() }
}))

function nativeScript(script, args, origin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, windowsHide: true, timeout: 30000, env: { ...process.env, DEEPSEEK_BASE_URL: origin, DEEPSEEK_API_KEY: 'synthetic-fixture-only' } })
    let stderr = ''
    child.stdout.resume(); child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject); child.on('close', code => resolve({ code, stderr }))
  })
}

test('native benchmark preserves its no-amount entry and enforces an explicit whole-run money cap at the actual adapter fetch boundary', async () => endpoint(async (origin, received) => {
  const directory = fs.mkdtempSync(path.join(ROOT, 'out', 'benchmark-price-cli-test-'))
  try {
    const declared = profile(origin), filename = path.join(directory, 'price.json')
    fs.writeFileSync(filename, JSON.stringify(declared))
    const base = ['--real', '--task=style-sample', '--model=fixture-model', `--price-profile=${filename}`, `--trust-price-profile-hash=${pricing.evalProfileHash(declared)}`, '--pricing-provider-id=eval.local']
    const legacy = await nativeScript(outputs[2], ['--real', '--task=style-sample', '--model=fixture-model', '--repeats=1', `--out-dir=${path.join(directory, 'legacy')}`], origin)
    assert.equal(legacy.code, 0); assert.equal(received(), 1)
    const absent = await nativeScript(outputs[2], ['--real', '--task=style-sample', '--model=fixture-model', '--max-cost-cny=1'], origin)
    assert.equal(absent.code, 2); assert.match(absent.stderr, /fetch前拒绝/); assert.equal(received(), 1)
    const tinyDir = path.join(directory, 'tiny')
    const tiny = await nativeScript(outputs[2], [...base, '--max-cost-cny=0.000000001', '--repeats=1', `--out-dir=${tinyDir}`], origin)
    assert.equal(tiny.code, 2); assert.equal(received(), 1)
    const denied = JSON.parse(fs.readFileSync(path.join(tinyDir, fs.readdirSync(tinyDir)[0]), 'utf8').split('\n')[0])
    assert.equal(denied.budget.requestsUsed, 0); assert.equal(denied.budget.spentUpperCny, 0); assert.equal(denied.budget.exhausted, true)
    const cappedDir = path.join(directory, 'capped'), cap = 0.02
    const capped = await nativeScript(outputs[2], [...base, `--max-cost-cny=${cap}`, '--repeats=3', `--out-dir=${cappedDir}`], origin)
    assert.equal(capped.code, 2)
    const lines = fs.readFileSync(path.join(cappedDir, fs.readdirSync(cappedDir)[0]), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(lines[0].budget.maxCostCny, cap); assert.equal(lines[0].budget.exhausted, true)
    assert.equal(lines[0].budget.requestsUsed, 1); assert.equal(received(), 2)
    assert.ok(lines[0].budget.spentUpperCny > 0 && lines[0].budget.spentUpperCny <= cap)
    assert.equal(lines[0].budget.actualAmountConfirmed, false)
    assert.deepEqual(lines.slice(1).map(row => row.status), ['ok', 'failed', 'failed'])
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}))

test('native benchmark charges failed inner and outer retries as distinct pre-fetch uppers', async () => endpoint(async (origin, received, requests) => {
  const directory = fs.mkdtempSync(path.join(ROOT, 'out', 'benchmark-retry-price-test-'))
  try {
    const declared = profile(origin), filename = path.join(directory, 'price.json'), output = path.join(directory, 'result')
    fs.writeFileSync(filename, JSON.stringify(declared))
    const result = await nativeScript(outputs[2], ['--real', '--task=style-sample', '--model=fixture-model', '--repeats=1', '--max-cost-cny=0.1', `--price-profile=${filename}`, `--trust-price-profile-hash=${pricing.evalProfileHash(declared)}`, '--pricing-provider-id=eval.local', `--out-dir=${output}`], origin)
    assert.equal(result.code, 0, result.stderr); assert.equal(received(), 3)
    const [header, sample] = fs.readFileSync(path.join(output, fs.readdirSync(output)[0]), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(header.budget.requestsUsed, 3); assert.equal(sample.retries, 1); assert.equal(sample.status, 'ok')
    const fullUppers = requests.reduce((total, body) => total + (Buffer.byteLength(body, 'utf8') + JSON.parse(body).max_tokens * 2) / 1e6, 0)
    assert.equal(header.budget.spentUpperCny, fullUppers)
    assert.ok(header.budget.spentUpperCny <= 0.1)
    assert.equal(header.budget.actualAmountConfirmed, false)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}, 2))

test('eval hardened longwrite publishes an actual SQLite artifact and hash-matching file in its frozen evidence directory', async () => endpoint(async (origin, received) => {
  const fixtureDir = fs.mkdtempSync(path.join(ROOT, 'out', 'eval-delivery-test-'))
  const localSettings = settings(origin)
  const expected = '这是本地价格桥测试的完整回答。'
  const unified = await runner.createUnifiedOrchestration({ baseUrl: origin, model: localSettings.model, settings: localSettings, sampling: { temperature: 1, topP: 1, maxTokens: 256, thinkingEnabled: false }, pricing: bridge(profile(origin)), evidenceDir: fixtureDir })
  try {
    localSettings.docDir = path.join(fixtureDir, 'mutated-user-document-dir')
    unified.repo.createSession('delivery', 'fixture', localSettings.model)
    const result = await unified.runStage({ runId: 'local-delivery', sessionId: 'delivery', userText: '请只写一段正文。', mode: 'longwrite', longMode: true, story: null, settings: localSettings, fairAuth: 'synthetic-fixture-only', targetChars: Array.from(expected).length })
    assert.equal(result.terminalStatus, 'completed')
    assert.ok(received() >= 1)
    const cfg = unified.kernelConfigs.get(result.runId)
    assert.equal(cfg.deliveryContract.manuscriptFile, true)
    assert.equal(cfg.docDir, path.join(fixtureDir, 'docs'))
    const db = new DatabaseSync(unified.evidencePaths.databasePath, { readOnly: true })
    try {
      const artifacts = db.prepare("SELECT artifact_type,status,relative_path,hash,char_count FROM artifacts WHERE run_id=? AND artifact_type='manuscript'").all(result.runId)
      assert.equal(artifacts.length, 1)
      const artifact = artifacts[0]
      assert.equal(artifact.status, 'completed')
      assert.equal(path.dirname(artifact.relative_path), fs.realpathSync(cfg.docDir))
      const content = fs.readFileSync(artifact.relative_path, 'utf8')
      assert.equal(content, result.content)
      assert.equal(artifact.char_count, Array.from(content).length)
      assert.equal(artifact.hash, createHash('sha256').update(content).digest('hex'))
      assert.equal(fs.readFileSync(path.join(unified.evidencePaths.artifactDir, artifact.hash + '.txt'), 'utf8'), content)
      assert.equal(fs.existsSync(localSettings.docDir), false)
    } finally { db.close() }
  } finally { unified.close(); fs.rmSync(fixtureDir, { recursive: true, force: true }) }
}))

test('omitting the eval publisher still fails the production delivery gate and never registers a completed manuscript', async () => endpoint(async (origin) => {
  const localSettings = settings(origin)
  const expected = '这是本地价格桥测试的完整回答。'
  const unified = await runner.createUnifiedOrchestration({ baseUrl: origin, model: localSettings.model, settings: localSettings, sampling: { temperature: 1, topP: 1, maxTokens: 256, thinkingEnabled: false }, pricing: bridge(profile(origin)), publishArtifacts: false })
  try {
    unified.repo.createSession('no-publisher', 'fixture', localSettings.model)
    const result = await unified.runStage({ runId: 'local-no-publisher', sessionId: 'no-publisher', userText: '请只写一段正文。', mode: 'longwrite', longMode: true, story: null, settings: localSettings, fairAuth: 'synthetic-fixture-only', targetChars: Array.from(expected).length })
    assert.equal(result.terminalStatus, 'failed')
    assert.equal(result.errorCode, 'longwrite_delivery_failed')
    assert.equal(unified.kernelConfigs.get(result.runId).deliveryContract.manuscriptFile, true)
    const db = new DatabaseSync(unified.evidencePaths.databasePath, { readOnly: true })
    try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE run_id=? AND artifact_type='manuscript' AND status='completed'").get(result.runId).n, 0) }
    finally { db.close() }
  } finally { unified.close() }
}))

test('actual eval CLI rejects unauthorized, missing, wrong and drifted prices before any local endpoint request', async () => endpoint(async (origin, received) => {
  const fixtureDir = fs.mkdtempSync(path.join(ROOT, 'out', 'eval-price-cli-test-'))
  try {
    const cases = [
      ['no-trust', p => p, []],
      ['wrong-hash', p => p, ['--trust-price-profile-hash=' + 'a'.repeat(64)]],
      ['wrong-provider', p => p, ['--pricing-provider-id=another']],
      ['wrong-model', p => { p.prices[0].model = 'another'; return p }, []],
      ['wrong-origin', p => { p.endpointOrigins = ['https://other.example']; return p }, []],
      ['wrong-currency', p => { p.currency = 'USD'; return p }, []],
      ['untrusted-source', p => { p.source = ''; return p }, []],
      ['price-drift', p => { p.prices[0].outputPer1M = 9; return p }, []],
      ['missing-profile', p => p, []]
    ]
    for (const [id, mutate, overrides] of cases) {
      const p = profile(origin)
      const originalHash = pricing.evalProfileHash(p)
      const changed = mutate(structuredClone(p))
      const filename = path.join(fixtureDir, `${id}.json`)
      fs.writeFileSync(filename, JSON.stringify(changed))
      const trustedHash = id === 'price-drift' ? originalHash : pricing.evalProfileHash(changed)
      const args = [outputs[1], '--real', '--task=style-transfer', '--model=fixture-model', '--max-cost-cny=1', `--out-dir=${path.join(fixtureDir, id)}`, '--pricing-provider-id=eval.local']
      if (id !== 'missing-profile') args.push(`--price-profile=${filename}`)
      if (id !== 'no-trust') args.push(`--trust-price-profile-hash=${trustedHash}`)
      for (const override of overrides) {
        const flag = override.slice(0, override.indexOf('='))
        const existing = args.findIndex(arg => arg.startsWith(flag + '='))
        if (existing >= 0) args.splice(existing, 1)
        args.push(override)
      }
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, timeout: 10000, env: { ...process.env, DEEPSEEK_BASE_URL: origin, DEEPSEEK_API_KEY: 'synthetic-fixture-only' } })
        let stderr = ''
        child.stdout.resume()
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        child.on('error', reject)
        child.on('close', code => resolve({ code, stderr }))
      })
      assert.equal(result.code, 2, id)
      assert.ok(result.stderr.includes('fetch前拒绝'), id)
      assert.equal(received(), 0, id)
    }
  } finally { fs.rmSync(fixtureDir, { recursive: true, force: true }) }
}))
