'use strict'

// Exclusively fake keys and newly created loopback servers. Real launcher entry
// denials are exercised with trapped I/O; no encrypted settings, live desktop
// profile, remote API, or private source file is read.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const Module = require('node:module')
const { pathToFileURL } = require('node:url')
const { test, before, after } = require('node:test')
const subject = require('./authorized-cli-quality.cjs')
let suite, helpers, profile
const FAKE = 'synthetic-upstream-key-never-persist'
const authorization = { ownerCapCny: 5, internalCumulativeRequestGuard: 80, previousSpentUpperCny: 0.361243, previousRequests: 30, maxCostCny: 4.638757, maxRequests: 50, previousManifests: [{ path: 'synthetic-prior-ledger', sha256: 'a'.repeat(64) }] }
const body = extra => JSON.stringify({ model: subject.MODEL, stream: true, max_tokens: 4096, messages: [{ role: 'user', content: '虚构灯塔，林舟持手电筒，顾岚持档案柜钥匙。😀\\\n' }], thinking: { type: 'disabled' }, ...extra })
function priceEvidence(at, mutate = () => undefined, assessment = 'r2') {
  // Deliberately synthetic evidence; this cannot create the later real receipt.
  const source = Buffer.from('<html>SYNTHETIC official-price test body, never a real verification</html>')
  const directory = assessment === 'r4' ? subject.FOURTH_DIRECTORY : assessment === 'r3' ? subject.THIRD_DIRECTORY : subject.SECOND_DIRECTORY
  const receipt = { schemaVersion: 1, purpose: 'equivalent_price_window_only', assessment, canonicalOrigin: subject.ORIGIN, model: subject.MODEL, currency: 'CNY', unit: 'per-1M-tokens', priceProfileHash: subject.PRICE_HASH, priceBand: 'off_peak', schedule: 'utc_weekdays_peak_01-04_06-10_else_off_peak_no_holiday_override', sourceFetchedAt: new Date(at).toISOString(), verifiedAt: new Date(at).toISOString(), expiresAt: new Date(at + 30 * 60 * 1000).toISOString(), sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', sourceSha256: subject.sha(source), entry: { model: subject.MODEL, inputPer1M: 1, outputPer1M: 4, cacheHitPer1M: 0.02 } }
  mutate(receipt)
  const bytes = Buffer.from(JSON.stringify(receipt))
  const verification = { expectedSha256: subject.sha(bytes), read: file => {
    if (file === path.join(directory, 'price-verification.json')) return bytes
    if (file === path.join(directory, 'price-verification-source.html')) return source
    throw new Error('Synthetic verification refuses every other file')
  } }
  return { receipt, bytes, source, verification }
}
function fixture(id, overrides = {}, now = Date.now) {
  const directory = path.join(suite, id); fs.mkdirSync(directory)
  const file = path.join(directory, 'ledger.json')
  return { directory, file, ledger: subject.createLedger({ file, authorization: { ...authorization, ...overrides }, profile, helpers, phase: id, now }) }
}
async function upstream(callback) {
  const server = http.createServer(callback)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
function send(relay, value = body(), overrides = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(relay.baseUrl + (overrides.path || '/chat/completions'), { method: overrides.method || 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + relay.localToken, ...overrides.headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk }); res.on('end', () => resolve({ status: res.statusCode, text })); res.on('aborted', () => resolve({ status: res.statusCode, aborted: true, text }))
    })
    req.on('error', reject); req.end(value)
  })
}
function sse(res, usage = { prompt_tokens: 100, completion_tokens: 200, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80 }) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '林舟把手电筒照向档案柜，顾岚握着钥匙。' }, finish_reason: null }] }) + '\n\n')
  if (usage) res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n')
  res.end('data: [DONE]\n\n')
}
function sendResponseBytes(relay) {
  return new Promise((resolve, reject) => {
    const req = http.request(relay.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + relay.localToken } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk))
      const finish = () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks) })
      res.on('end', finish); res.on('aborted', finish); res.on('error', finish)
    })
    req.on('error', reject); req.end(body())
  })
}
const evidenceFile = directory => path.join(directory, 'attempt-000001.json')
const responseBytes = text => Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 200 } }) + '\n\ndata: [DONE]\n\n')
before(async () => {
  suite = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-cli-quality-preflight-'))
  helpers = await subject.accountingHelpers(path.join(suite, 'helpers'))
  profile = JSON.parse(fs.readFileSync(path.join(subject.ROOT, 'scripts/eval-prices-deepseek-flash-20261003.json'), 'utf8'))
})
after(() => {
  if (process.env.DEEPWRITER_CLI_QUALITY_KEEP === '1') process.stdout.write('# isolated synthetic evidence: ' + suite + '\n')
  else { assert.equal(path.dirname(suite), os.tmpdir()); assert.ok(path.basename(suite).startsWith('deepwriter-cli-quality-preflight-')); fs.rmSync(suite, { recursive: true, force: true }) }
})
test('three settled paid ledgers inherit ¥0.361243/30 attempts; ¥5 and internal 80 leave ¥4.638757/50', () => {
  const paid = [0.119039, 0.099443, 0.142761].map((spent, index) => ({ model: subject.MODEL, endpointOrigin: subject.ORIGIN, priceProfileHash: subject.PRICE_HASH, hardCapProtected: true, spentUpperCny: spent, inflightReservedCny: 0, budget: { requestsUsed: [12, 5, 13][index], spentUpperCny: spent, inflightReservedCny: 0, hardCapProtected: true } }))
  const inherited = subject.inheritedAuthorization(['first', 'second', 'third'], file => paid[['first', 'second', 'third'].indexOf(file)])
  assert.equal(inherited.previousSpentUpperCny, 0.361243); assert.equal(inherited.previousRequests, 30)
  assert.equal(inherited.maxCostCny, 4.638757); assert.equal(inherited.maxRequests, 50)
  const corrupt = structuredClone(paid[0]); corrupt.inflightReservedCny = 0.1
  assert.throws(() => subject.inheritedAuthorization(['first'], () => corrupt))
  assert.equal(helpers.priceProfileHash(profile), subject.PRICE_HASH)
  assert.equal(subject.verifyPrice(helpers, profile).outputPer1M, 4)
})
test('response evidence is disabled by default and real capture permits only exact fixed R3/R4 leaves', async () => {
  const f = fixture('response-default'); const beforeFiles = fs.readdirSync(f.directory)
  const endpoint = await upstream((req, res) => { req.resume(); req.on('end', () => sse(res)) })
  const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
  try { assert.equal((await send(relay)).status, 200); assert.deepEqual(fs.readdirSync(f.directory), beforeFiles) }
  finally { await relay.close(); await endpoint.close() }
  let disallowedRelay
  try { await assert.rejects(async () => { disallowedRelay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, responseEvidenceDirectory: path.join(subject.SECOND_DIRECTORY, 'response-evidence') }) }, /fixed r3/) }
  finally { if (disallowedRelay) await disallowedRelay.close() }
  for (const assessment of [subject.THIRD_DIRECTORY, subject.FOURTH_DIRECTORY]) {
    const evidence = path.join(assessment, 'response-evidence'), existed = fs.existsSync(evidence)
    // No native request is issued. Merely admitting this explicit capture path
    // cannot read a credential or create a paid output directory.
    const allowed = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, responseEvidenceDirectory: evidence })
    await allowed.close(); assert.equal(fs.existsSync(evidence), existed)
    await assert.rejects(subject.createRelay({ ledger: f.ledger, apiKey: FAKE, responseEvidenceDirectory: evidence + '-other' }))
  }
})
test('response evidence captures byte-identical fragmented UTF-8 SSE with only bound attempt identity', async () => {
  const f = fixture('response-fragments'), directory = path.join(f.directory, 'private-responses')
  const expected = responseBytes('逐字引用😀🧭\r\n灯塔原文。'); const split = expected.indexOf(Buffer.from('😀')) + 1
  const endpoint = await upstream((req, res) => { req.resume(); req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(expected.subarray(0, split))
    setImmediate(() => { res.write(expected.subarray(split, split + 2)); setImmediate(() => res.end(expected.subarray(split + 2))) })
  }) })
  const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true, responseEvidenceDirectory: directory })
  try {
    const forwarded = await sendResponseBytes(relay); assert.equal(forwarded.status, 200); assert.deepEqual(forwarded.bytes, expected)
    const captured = JSON.parse(fs.readFileSync(evidenceFile(directory), 'utf8')), attempt = f.ledger.snapshot().attempts[0]
    assert.deepEqual(Buffer.from(captured.payloadBase64, 'base64'), expected); assert.equal(captured.rawSha256, subject.sha(expected)); assert.equal(captured.capturedSha256, subject.sha(expected))
    assert.equal(captured.attemptId, attempt.id); assert.equal(captured.phase, attempt.phase); assert.equal(captured.requestHash, attempt.requestHash); assert.equal(captured.outcome, attempt.outcome)
    assert.equal(captured.completed, true); assert.equal(captured.truncated, false); assert.equal(captured.redacted, false); assert.equal(captured.observedSseBytes, expected.length); assert.equal(captured.payloadEncoding, 'base64')
    assert.deepEqual(Object.keys(captured).sort(), ['attemptId', 'capturedSha256', 'capturedSseBytes', 'completed', 'encodedPayloadBytes', 'maxCapturedSseBytes', 'observedSseBytes', 'outcome', 'payloadBase64', 'payloadEncoding', 'phase', 'rawSha256', 'redacted', 'requestHash', 'schemaVersion', 'truncated'].sort())
    assert.equal(attempt.chargedUpperMicros, 900); assert.equal(attempt.actualMicros, 900)
    const firstFile = fs.readFileSync(evidenceFile(directory))
    assert.deepEqual((await sendResponseBytes(relay)).bytes, expected)
    assert.deepEqual(fs.readFileSync(evidenceFile(directory)), firstFile)
    const second = JSON.parse(fs.readFileSync(path.join(directory, 'attempt-000002.json'), 'utf8'))
    assert.equal(second.attemptId, 2); assert.equal(second.requestHash, f.ledger.snapshot().attempts[1].requestHash); assert.equal(second.rawSha256, subject.sha(expected))
    assert.deepEqual(fs.readdirSync(directory).sort(), ['attempt-000001.json', 'attempt-000002.json'])
  } finally { await relay.close(); await endpoint.close() }
})
test('response evidence marks unfinished 200 SSE without raw proof and does not capture HTTP error bodies', async () => {
  for (const mode of ['truncated', 'http', 'aborted']) {
    const f = fixture('response-failure-' + mode), directory = path.join(f.directory, 'private-responses')
    const endpoint = await upstream((req, res) => { req.resume(); req.on('end', () => {
      res.writeHead(mode === 'http' ? 503 : 200, { 'content-type': 'text/event-stream' })
      if (mode === 'aborted') { res.write('data: {"choices":[{"delta":{"content":"部分原文"}}]}\n\n'); setTimeout(() => res.destroy(), 10) }
      else res.end(mode === 'http' ? FAKE : 'data: {"usage":{"prompt_tokens":100,"completion_tokens":200}}\n\n')
    }) })
    const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true, responseEvidenceDirectory: directory })
    try {
      await send(relay); const attempt = f.ledger.snapshot().attempts[0]
      assert.equal(attempt.chargedUpperMicros, attempt.reservedMicros); assert.equal(attempt.outcome, mode === 'http' ? 'http_error' : mode === 'aborted' ? 'aborted' : 'truncated_response')
      if (mode === 'http') assert.equal(fs.existsSync(directory), false)
      else { const captured = JSON.parse(fs.readFileSync(evidenceFile(directory), 'utf8')); assert.equal(captured.completed, false); assert.equal(captured.rawSha256, null); assert.equal(captured.outcome, attempt.outcome) }
    } finally { await relay.close(); await endpoint.close() }
  }
})
test('response evidence records client abort and relay close without changing full reservation settlement', async () => {
  for (const mode of ['client', 'relay']) {
    const f = fixture('response-abort-' + mode), directory = path.join(f.directory, 'private-responses'); let firstBytes
    const received = new Promise(resolve => { firstBytes = resolve })
    const endpoint = await upstream((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"原文😀"}}]}\n\n') }) })
    const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true, responseEvidenceDirectory: directory })
    const req = http.request(relay.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + relay.localToken } }, res => { res.on('data', firstBytes); res.on('error', () => undefined) })
    req.on('error', () => undefined); req.end(body()); await received
    try {
      if (mode === 'client') { req.destroy(); await new Promise(resolve => setTimeout(resolve, 25)) }
      await relay.close()
      const attempt = f.ledger.snapshot().attempts[0], captured = JSON.parse(fs.readFileSync(evidenceFile(directory), 'utf8'))
      assert.equal(captured.completed, false); assert.equal(captured.rawSha256, null); assert.equal(captured.outcome, attempt.outcome); assert.equal(attempt.outcome, mode === 'client' ? 'client_cancelled' : 'relay_closed_without_trusted_usage')
      assert.equal(attempt.chargedUpperMicros, attempt.reservedMicros); assert.equal(attempt.actualMicros, null); assert.equal(f.ledger.snapshot().inflightReservedMicros, 0)
    } finally { await relay.close(); await endpoint.close() }
  }
})
test('response evidence never persists exact key or local-token echoes across chunks and cannot claim raw SHA', async () => {
  const f = fixture('response-secret'), directory = path.join(f.directory, 'private-responses'); let echoed
  const endpoint = await upstream((req, res) => { req.resume(); req.on('end', () => {
    const expected = responseBytes('echo=' + FAKE + '/' + echoed), split = expected.indexOf(Buffer.from(FAKE)) + 8
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(expected.subarray(0, split)); setImmediate(() => res.end(expected.subarray(split)))
  }) })
  const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true, responseEvidenceDirectory: directory }); echoed = relay.localToken
  try {
    const forwarded = await sendResponseBytes(relay); assert.ok(forwarded.bytes.includes(Buffer.from(FAKE))); assert.ok(forwarded.bytes.includes(Buffer.from(echoed)))
    const raw = fs.readFileSync(evidenceFile(directory), 'utf8'), captured = JSON.parse(raw), payload = Buffer.from(captured.payloadBase64, 'base64')
    assert.equal(captured.redacted, true); assert.equal(captured.rawSha256, null); assert.equal(captured.capturedSha256, subject.sha(payload)); assert.match(payload.toString('utf8'), /REDACTED_SECRET_ECHO/)
    for (const secret of [FAKE, echoed]) { assert.equal(raw.includes(secret), false); assert.equal(payload.includes(Buffer.from(secret)), false) }
    assert.equal(f.ledger.snapshot().attempts[0].outcome, 'success'); assert.equal(f.ledger.snapshot().attempts[0].chargedUpperMicros, 900)
  } finally { await relay.close(); await endpoint.close() }
})
test('response evidence retains at most 2MiB SSE while forwarding the whole stream and marks truncation', async () => {
  const f = fixture('response-bound'), directory = path.join(f.directory, 'private-responses')
  const limit = 2 * 1024 * 1024, expected = Buffer.concat([Buffer.from((': ' + 'x'.repeat(4093) + '\n').repeat(520)), responseBytes('末尾。')])
  const endpoint = await upstream((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(expected) }) })
  const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true, responseEvidenceDirectory: directory })
  try {
    const forwarded = await sendResponseBytes(relay); assert.deepEqual(forwarded.bytes, expected)
    const captured = JSON.parse(fs.readFileSync(evidenceFile(directory), 'utf8')), payload = Buffer.from(captured.payloadBase64, 'base64')
    assert.equal(captured.maxCapturedSseBytes, limit); assert.equal(captured.observedSseBytes, expected.length); assert.equal(captured.capturedSseBytes, limit); assert.deepEqual(payload, expected.subarray(0, limit))
    assert.equal(captured.truncated, true); assert.equal(captured.completed, false); assert.equal(captured.rawSha256, null); assert.equal(captured.capturedSha256, subject.sha(payload)); assert.equal(captured.encodedPayloadBytes, 4 * Math.ceil(limit / 3))
    assert.equal(f.ledger.snapshot().attempts[0].outcome, 'success'); assert.equal(f.ledger.snapshot().attempts[0].chargedUpperMicros, 900)
  } finally { await relay.close(); await endpoint.close() }
})
test('response evidence never overwrites an attempt and diagnostic write failure cannot mask stream or ledger outcomes', async t => {
  for (const mode of ['exists', 'write-failure']) {
    const f = fixture('response-write-' + mode), directory = path.join(f.directory, 'private-responses'), file = evidenceFile(directory)
    if (mode === 'exists') { fs.mkdirSync(directory); fs.writeFileSync(file, 'existing private diagnostic') }
    const originalWrite = fs.writeFileSync
    const writeMock = t.mock.method(fs, 'writeFileSync', (target, ...args) => { if (mode === 'write-failure' && target === file) throw new Error('synthetic private evidence disk failure'); return originalWrite(target, ...args) })
    const endpoint = await upstream((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"usage":{"prompt_tokens":100,"completion_tokens":200}}\n\n') }) })
    const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true, responseEvidenceDirectory: directory })
    try {
      assert.equal((await send(relay)).status, 200); const attempt = f.ledger.snapshot().attempts[0]
      assert.equal(attempt.outcome, 'truncated_response'); assert.equal(attempt.chargedUpperMicros, attempt.reservedMicros); assert.equal(f.ledger.snapshot().inflightReservedMicros, 0)
      if (mode === 'exists') assert.equal(fs.readFileSync(file, 'utf8'), 'existing private diagnostic')
      else assert.equal(fs.existsSync(file), false)
    } finally { await relay.close(); await endpoint.close(); writeMock.mock.restore() }
  }
})
test('r2/r3/r4 fixed source assessments have distinct data but exactly the original lock and financial ledger', () => {
  const first = subject.assessmentPaths()
  const second = subject.assessmentPaths(subject.SECOND_DIRECTORY)
  const third = subject.assessmentPaths(subject.THIRD_DIRECTORY)
  const fourth = subject.assessmentPaths(subject.FOURTH_DIRECTORY)
  assert.notEqual(first.directory, second.directory)
  assert.notEqual(first.directory, third.directory); assert.notEqual(second.directory, third.directory)
  assert.equal(first.budgetFile, second.budgetFile)
  assert.equal(first.lockFile, second.lockFile)
  assert.equal(first.budgetFile, third.budgetFile); assert.equal(first.lockFile, third.lockFile)
  assert.equal(third.directory, path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r3'))
  assert.equal(fourth.directory, path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r4'))
  assert.equal(fourth.budgetFile, first.budgetFile); assert.equal(fourth.lockFile, first.lockFile)
  assert.equal(new Set([first.directory, second.directory, third.directory, fourth.directory]).size, 4)
  assert.throws(() => subject.assessmentPaths(path.join(subject.ROOT, 'arbitrary-assessment')))
  assert.throws(() => subject.assessmentPaths(third.directory + '-other'))
  assert.throws(() => subject.assessmentPaths(fourth.directory + '-other'))
})

test('fixed r3/r4 launcher validates one assessment/pin, equivalent receipt and original ledger before build/key/network', async t => {
  for (const assessment of ['r3', 'r4']) {
  const directory = assessment === 'r4' ? subject.FOURTH_DIRECTORY : subject.THIRD_DIRECTORY
  const at = Date.parse('2026-10-04T01:25:00Z'); const valid = priceEvidence(at, undefined, assessment)
  const args = evidence => ['--real', '--assessment=' + assessment, '--phase=outline', '--price-verification-sha256=' + evidence.verification.expectedSha256]
  const cases = [
    { argv: ['--real', '--assessment=r3', '--phase=outline'], reads: 0 },
    { argv: [...args(valid), '--price-verification-sha256=' + valid.verification.expectedSha256], reads: 0 },
    { argv: [...args(valid), '--assessment=r2'], reads: 0 },
    { argv: [...args(valid), '--assessment=r3'], reads: 0 },
    { argv: [...args(valid), '--assessment=r4'], reads: 0 },
    { argv: ['--real', '--assessment=../r3', '--phase=outline'], reads: 0 },
    { argv: ['--real', '--assessment=r4', '--phase=outline'], reads: 0 },
    { argv: args(valid), reads: 1 }, // Receipt absent, not a preparation fallback.
    ...[
      r => { r.assessment = 'r2' }, r => { r.purpose = 'new_financial_authorization' },
      r => { r.canonicalOrigin = 'https://other.invalid' }, r => { r.model = 'deepseek-pro' },
      r => { r.currency = 'USD' }, r => { r.priceProfileHash = '0'.repeat(64) },
      r => { r.entry.inputPer1M = 2 }, r => { r.entry.cacheHitPer1M = 0.04 }, r => { r.entry.outputPer1M = 8 },
      r => { r.sourceUrl = 'https://other.invalid/pricing/' }, r => { r.verifiedAt = new Date(at + 1).toISOString() },
      r => { r.expiresAt = new Date(at).toISOString() }, r => { r.expiresAt = new Date(at + subject.PRICE_WINDOW_MS + 1).toISOString() }
    ].map(mutate => { const evidence = priceEvidence(at, mutate, assessment); return { argv: args(evidence), evidence, reads: 1 } }),
    { argv: args(valid).map(item => item.startsWith('--price-verification-sha256=') ? '--price-verification-sha256=' + '0'.repeat(64) : item), evidence: valid, reads: 1 },
    { argv: args(valid), evidence: valid, sourceChanged: true, reads: 2 },
    { argv: args(valid), evidence: valid, reads: 2, ledgerMissing: true },
    { argv: args(valid), evidence: valid, reads: 3, ledgerExists: true }
  ]
  for (const item of cases) {
    const reads = []; const probes = []; let writes = 0; let sensitiveLoads = 0; let network = 0
    const load = Module._load
    try {
      t.mock.method(Date, 'now', () => at)
      t.mock.method(console, 'error', () => undefined)
      t.mock.method(fs, 'readFileSync', file => {
        reads.push(file)
        if (item.sourceChanged && file === path.join(directory, 'price-verification-source.html')) return Buffer.from('tampered synthetic source')
        if (item.evidence) return item.evidence.verification.read(file)
        throw new Error('No synthetic receipt; refuse every real file read')
      })
      t.mock.method(fs, 'existsSync', file => { probes.push(file); return file === subject.assessmentPaths().budgetFile && item.ledgerExists === true })
      for (const name of ['openSync', 'mkdirSync', 'mkdtempSync', 'writeFileSync', 'renameSync', 'unlinkSync']) t.mock.method(fs, name, () => { writes++; throw new Error('Launcher denial must be write-free') })
      t.mock.method(Module, '_load', function (name, ...rest) { if (['electron', 'esbuild', './build-cli.cjs'].includes(name)) { sensitiveLoads++; throw new Error('No build/runtime/key lookup permitted') } return load.call(this, name, ...rest) })
      for (const transport of [http, https]) t.mock.method(transport, 'request', () => { network++; throw new Error('No network permitted') })
      assert.equal(await subject.main(item.argv), 2)
      assert.equal(reads.length, item.reads, JSON.stringify(item.argv))
      if (item.ledgerMissing) assert.deepEqual(probes, [subject.assessmentPaths().budgetFile])
      if (item.ledgerExists) assert.equal(reads.at(-1), path.join(directory, 'preflight.json'))
      assert.equal(writes, 0); assert.equal(sensitiveLoads, 0); assert.equal(network, 0)
    } finally { t.mock.restoreAll() }
  }
  }
})

test('a fresh phase on the original ledger preserves failed spend and charges any crashed reservation rather than resetting it', () => {
  const f = fixture('source-rerun-shared-budget')
  const first = f.ledger.reserve(body())
  f.ledger.settle(first, null, 'invalid_critic_response')
  const second = f.ledger.reserve(body())
  const beforeRestart = f.ledger.snapshot()
  const resumed = subject.createLedger({ file: f.file, authorization, profile, helpers, phase: 'new-source-outline' })
  const afterRestart = resumed.snapshot()
  assert.equal(afterRestart.requestsUsed, 2)
  assert.equal(afterRestart.spentUpperMicros, beforeRestart.spentUpperMicros + beforeRestart.inflightReservedMicros)
  assert.equal(afterRestart.inflightReservedMicros, 0)
  assert.equal(afterRestart.attempts.find(item => item.id === second).outcome, 'previous_process_unsettled')
  assert.equal(resumed.reserve(body()), 3)
  assert.equal(resumed.snapshot().cumulativeRequests, 33)
})
test('price renewal accepts only explicit hash-pinned equivalent official evidence for fixed r2 during fresh off-peak time', () => {
  const at = Date.parse('2026-10-04T01:25:00.000Z'); const evidence = priceEvidence(at)
  const result = subject.verifyPriceVerification({ directory: subject.SECOND_DIRECTORY, ...evidence.verification, at })
  assert.equal(result.receiptSha256, evidence.verification.expectedSha256); assert.equal(result.priceProfileHash, subject.PRICE_HASH)
  assert.equal(result.sourceFetchedAt, at); assert.equal(result.expiresAt, at + 30 * 60 * 1000)
  // Weekday peak transitions are UTC and conservative: no guessed holidays.
  for (const hour of ['00:59:59.999', '04:00:00.000', '05:59:59.999', '10:00:00.000']) assert.equal(subject.isOffPeak(Date.parse('2026-10-05T' + hour + 'Z')), true)
  for (const hour of ['01:00:00.000', '03:59:59.999', '06:00:00.000', '09:59:59.999']) assert.equal(subject.isOffPeak(Date.parse('2026-10-05T' + hour + 'Z')), false)
})
test('price renewal missing/bad evidence, wrong price/identity, future/stale times and peak windows refuse without financial mutation', () => {
  const at = Date.parse('2026-10-04T01:25:00.000Z')
  const cases = [
    r => { r.schemaVersion = 2 }, r => { r.assessment = 'r3' }, r => { r.purpose = 'new_financial_authorization' },
    r => { r.canonicalOrigin = 'https://other.invalid' }, r => { r.model = 'deepseek-v4-pro' }, r => { r.currency = 'USD' }, r => { r.unit = 'per-token' },
    r => { r.priceProfileHash = '0'.repeat(64) }, r => { r.entry.inputPer1M = 2 }, r => { r.entry.outputPer1M = 8 }, r => { r.entry.cacheHitPer1M = 0.04 }, r => { r.entry.model = 'another-model' },
    r => { r.sourceUrl = 'https://other.invalid/pricing/' }, r => { r.sourceSha256 = '0'.repeat(64) }, r => { r.priceBand = 'peak' }, r => { r.schedule = 'all_hours_off_peak' },
    r => { r.verifiedAt = new Date(at + 1).toISOString() }, r => { r.sourceFetchedAt = new Date(at + 1).toISOString() },
    r => { r.expiresAt = new Date(at).toISOString() }, r => { r.expiresAt = new Date(at + 30 * 60 * 1000 + 1).toISOString() },
    r => { r.sourceFetchedAt = new Date(at - 31 * 60 * 1000).toISOString() }, r => { r.verifiedAt = '2026-10-04T01:25:00+00:00' }, r => { r.verifiedAt = '2026-02-30T01:25:00Z' }
  ]
  const f = fixture('renewal-denials'); const seed = f.ledger.reserve(body()); f.ledger.settle(seed, null, 'failed_previous_critic')
  const rawBefore = fs.readFileSync(f.file, 'utf8')
  for (const mutate of cases) {
    const evidence = priceEvidence(at, mutate)
    const ledger = subject.createLedger({ file: f.file, authorization, profile, helpers, phase: 'r2', directory: subject.SECOND_DIRECTORY, priceVerification: evidence.verification, now: () => at })
    assert.throws(() => ledger.reserve(body())); assert.equal(fs.readFileSync(f.file, 'utf8'), rawBefore)
  }
  const valid = priceEvidence(at)
  for (const override of [{ expectedSha256: undefined }, { expectedSha256: '0'.repeat(64) }, { read: () => { throw new Error('Missing receipt') } }, { expectedSha256: subject.sha('{broken'), read: () => Buffer.from('{broken') }]) {
    assert.throws(() => subject.verifyPriceVerification({ directory: subject.SECOND_DIRECTORY, ...valid.verification, ...override, at }))
  }
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.DIRECTORY, ...valid.verification, at }))
  const peakAt = Date.parse('2026-10-05T02:00:00Z'); const peak = priceEvidence(peakAt)
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SECOND_DIRECTORY, ...peak.verification, at: peakAt }))
  assert.equal(fs.readFileSync(f.file, 'utf8'), rawBefore)
})
test('price renewal preserves original startedAt, authorization hash, all 13 prior attempts and cumulative guard across UTC dates', () => {
  let at = Date.parse('2026-10-03T11:26:40.106Z'); const directory = path.join(suite, 'renewal-preserves-ledger'); fs.mkdirSync(directory); const file = path.join(directory, 'ledger.json')
  const first = subject.createLedger({ file, authorization, profile, helpers, phase: 'old-source', now: () => at })
  for (let index = 0; index < 13; index++) { const id = first.reserve(body()); first.settle(id, index === 2 ? null : { prompt_tokens: 100, completion_tokens: 200 }, index === 2 ? 'invalid_critic_response' : 'success') }
  const original = first.snapshot(); const rawBefore = fs.readFileSync(file, 'utf8')
  at = Date.parse('2026-10-04T01:25:00Z')
  const expired = subject.createLedger({ file, authorization, profile, helpers, phase: 'r2', directory: subject.SECOND_DIRECTORY, now: () => at })
  assert.throws(() => expired.reserve(body())); assert.equal(fs.readFileSync(file, 'utf8'), rawBefore)
  const evidence = priceEvidence(at)
  const renewed = subject.createLedger({ file, authorization, profile, helpers, phase: 'r2', directory: subject.SECOND_DIRECTORY, priceVerification: evidence.verification, now: () => at })
  assert.deepEqual(renewed.snapshot(), original); assert.equal(fs.readFileSync(file, 'utf8'), rawBefore)
  const id = renewed.reserve(body()); const next = renewed.snapshot()
  assert.equal(id, 14); assert.equal(next.cumulativeRequests, 44); assert.equal(next.startedAt, original.startedAt); assert.equal(next.authorizationHash, original.authorizationHash)
  assert.deepEqual(next.attempts.slice(0, 13), original.attempts); assert.equal(next.spentUpperMicros, original.spentUpperMicros)
  assert.equal(next.attempts[13].priceVerificationSha256, evidence.verification.expectedSha256)
  renewed.settlePending(); const beforeExpiry = fs.readFileSync(file, 'utf8')
  at += 30 * 60 * 1000; assert.throws(() => renewed.reserve(body())); assert.equal(fs.readFileSync(file, 'utf8'), beforeExpiry)
})
test('price renewal cannot create a missing original ledger, apply to first assessment, free pending charges or expand 80 attempts', () => {
  let at = Date.parse('2026-10-03T11:26:40.106Z'); const f = fixture('renewal-pending-and-guard'); const evidenceAt = Date.parse('2026-10-04T01:25:00Z'); const evidence = priceEvidence(evidenceAt)
  const absent = path.join(f.directory, 'absent.json')
  assert.throws(() => subject.createLedger({ file: absent, authorization, profile, helpers, phase: 'r2', directory: subject.SECOND_DIRECTORY, priceVerification: evidence.verification, now: () => evidenceAt }))
  assert.equal(fs.existsSync(absent), false)
  assert.throws(() => subject.createLedger({ file: f.file, authorization, profile, helpers, phase: 'first', directory: subject.DIRECTORY, priceVerification: evidence.verification, now: () => evidenceAt }))
  const file = path.join(f.directory, 'old-ledger.json'); const old = subject.createLedger({ file, authorization, profile, helpers, phase: 'old-source', now: () => at }); old.reserve(body())
  const before = old.snapshot(); at = evidenceAt
  const resumed = subject.createLedger({ file, authorization, profile, helpers, phase: 'r2', directory: subject.SECOND_DIRECTORY, priceVerification: evidence.verification, now: () => at })
  assert.equal(resumed.snapshot().startedAt, before.startedAt); assert.equal(resumed.snapshot().spentUpperMicros, before.inflightReservedMicros); assert.equal(resumed.snapshot().inflightReservedMicros, 0)
  assert.equal(resumed.snapshot().attempts[0].outcome, 'previous_process_unsettled')
  for (let index = 1; index < 50; index++) { const id = resumed.reserve(body()); resumed.settle(id, { prompt_tokens: 100, completion_tokens: 200 }, 'success') }
  const full = fs.readFileSync(file, 'utf8'); assert.equal(resumed.snapshot().cumulativeRequests, 80); assert.throws(() => resumed.reserve(body())); assert.equal(fs.readFileSync(file, 'utf8'), full)
})

test('r3 receipt cannot replace r2, create a ledger, or omit its explicit pin even inside the original window', () => {
  const at = Date.parse('2026-10-04T01:25:00Z'); const evidence = priceEvidence(at, undefined, 'r3')
  assert.equal(subject.verifyPriceVerification({ directory: subject.THIRD_DIRECTORY, ...evidence.verification, at }).receiptSha256, evidence.verification.expectedSha256)
  const transplanted = { ...evidence.verification, read: file => file.endsWith('price-verification.json') ? evidence.bytes : evidence.source }
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SECOND_DIRECTORY, ...transplanted, at }), /identity/)
  const r2 = priceEvidence(at)
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.THIRD_DIRECTORY, ...r2.verification, read: file => file.endsWith('price-verification.json') ? r2.bytes : r2.source, at }), /identity/)
  const f = fixture('r3-no-new-ledger'); const absent = path.join(f.directory, 'absent.json')
  assert.throws(() => subject.createLedger({ file: absent, authorization, profile, helpers, phase: 'r3', directory: subject.THIRD_DIRECTORY, priceVerification: evidence.verification, now: () => at }), /cannot create/)
  assert.equal(fs.existsSync(absent), false)
  const rawBefore = fs.readFileSync(f.file, 'utf8')
  assert.throws(() => subject.createLedger({ file: f.file, authorization, profile, helpers, phase: 'r3', directory: subject.THIRD_DIRECTORY }), /hash-pinned/)
  assert.throws(() => subject.createLedger({ file: f.file, authorization, profile, helpers, phase: 'r3', directory: subject.THIRD_DIRECTORY, priceVerification: { expectedSha256: '0'.repeat(64), read: evidence.verification.read }, now: () => at }), /missing or changed/)
  assert.equal(fs.readFileSync(f.file, 'utf8'), rawBefore)
})

test('r3 rechecks price/receipt/source/time/ledger/default request before every egress; 46 prior requests leave only 34 of 80', async () => {
  let at = 1791026800106; const directory = path.join(suite, 'r3-shared-46'); fs.mkdirSync(directory); const file = path.join(directory, 'ledger.json')
  const old = subject.createLedger({ file, authorization, profile, helpers, phase: 'original-r1-r2', now: () => at })
  for (let index = 0; index < 16; index++) {
    const id = old.reserve(body())
    old.settle(id, index < 15 ? { prompt_tokens: 100, completion_tokens: 1700 } : { prompt_tokens: 171, completion_tokens: 1300 }, 'success')
  }
  const original = old.snapshot()
  assert.equal(original.cumulativeRequests, 46); assert.equal(original.cumulativeSpentUpperCny, 0.470114)
  assert.equal(authorization.maxRequests - original.requestsUsed, 34)
  assert.equal(5 - original.cumulativeSpentUpperCny, 4.529886)
  at = Date.parse('2026-10-04T01:25:00Z'); const evidence = priceEvidence(at, undefined, 'r3'); let tamper = ''
  const verification = { ...evidence.verification, read: name => {
    const value = evidence.verification.read(name)
    return tamper === 'receipt' && name.endsWith('price-verification.json') || tamper === 'source' && name.endsWith('price-verification-source.html') ? Buffer.concat([value, Buffer.from(' ')]) : value
  } }
  const localProfile = structuredClone(profile)
  const ledger = subject.createLedger({ file, authorization, profile: localProfile, helpers, phase: 'r3', directory: subject.THIRD_DIRECTORY, priceVerification: verification, now: () => at })
  assert.deepEqual(ledger.snapshot(), original)
  let received = 0
  const endpoint = await upstream((req, res) => { received++; req.resume(); req.on('end', () => sse(res)) })
  const relay = await subject.createRelay({ ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
  try {
    assert.equal((await send(relay)).status, 200); const rawBefore = fs.readFileSync(file, 'utf8')
    for (tamper of ['receipt', 'source']) { assert.equal((await send(relay)).status, 429); assert.equal(fs.readFileSync(file, 'utf8'), rawBefore) }
    tamper = ''; at += subject.PRICE_WINDOW_MS
    assert.equal((await send(relay)).status, 429); at -= subject.PRICE_WINDOW_MS
    localProfile.updatedAt = '2026-10-04'; assert.equal((await send(relay)).status, 429); localProfile.updatedAt = subject.DATE
    const disk = JSON.parse(rawBefore); disk.requestsUsed = 0; fs.writeFileSync(file, JSON.stringify(disk))
    assert.equal((await send(relay)).status, 429); fs.writeFileSync(file, rawBefore)
    const moved = file + '.synthetic-held'; fs.renameSync(file, moved)
    try { assert.equal((await send(relay)).status, 429) } finally { fs.renameSync(moved, file) }
    assert.equal((await send(relay, body({ max_tokens: 4097 }))).status, 429)
    assert.equal(received, 1); assert.equal(fs.readFileSync(file, 'utf8'), rawBefore)
    for (let index = 1; index < 34; index++) assert.equal((await send(relay)).status, 200)
    const full = fs.readFileSync(file, 'utf8'); assert.equal((await send(relay)).status, 429)
    assert.equal(received, 34); assert.equal(fs.readFileSync(file, 'utf8'), full)
    const final = ledger.snapshot()
    assert.equal(final.cumulativeRequests, 80); assert.equal(final.startedAt, 1791026800106); assert.equal(final.authorizationHash, original.authorizationHash)
    assert.deepEqual(final.authorization, original.authorization); assert.deepEqual(final.attempts.slice(0, 16), original.attempts)
    assert.ok(final.cumulativeSpentUpperCny <= 5); assert.equal(final.inflightReservedMicros, 0)
    assert.ok(final.attempts.slice(16).every(item => item.priceVerificationSha256 === evidence.verification.expectedSha256))
  } finally { await relay.close(); await endpoint.close() }
})

test('r3 equivalent price renewal cannot expand the cumulative owner ¥5 cap', async () => {
  const limits = { ...authorization, previousSpentUpperCny: 4.999999, maxCostCny: 0.000001 }
  const f = fixture('r3-owner-5-cap', limits); const at = Date.parse('2026-10-04T01:25:00Z'); const evidence = priceEvidence(at, undefined, 'r3')
  const ledger = subject.createLedger({ file: f.file, authorization: limits, profile, helpers, phase: 'r3', directory: subject.THIRD_DIRECTORY, priceVerification: evidence.verification, now: () => at })
  let received = 0; const rawBefore = fs.readFileSync(f.file, 'utf8')
  const endpoint = await upstream((req, res) => { received++; req.resume(); req.on('end', () => sse(res)) })
  const relay = await subject.createRelay({ ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
  try { assert.equal((await send(relay)).status, 429); assert.equal(received, 0); assert.equal(fs.readFileSync(f.file, 'utf8'), rawBefore); assert.equal(ledger.snapshot().cumulativeSpentUpperCny, 4.999999) }
  finally { await relay.close(); await endpoint.close() }
})

test('R4 requires its fresh exact receipt and cannot transplant R3, create a ledger or free pending charges', () => {
  const at = Date.parse('2026-10-04T02:25:00Z'), evidence = priceEvidence(at, undefined, 'r4'), r3 = priceEvidence(at, undefined, 'r3')
  assert.equal(subject.verifyPriceVerification({ directory: subject.FOURTH_DIRECTORY, ...evidence.verification, at }).receiptSha256, evidence.verification.expectedSha256)
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.FOURTH_DIRECTORY, ...r3.verification, read: file => file.endsWith('price-verification.json') ? r3.bytes : r3.source, at }), /identity/)
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.THIRD_DIRECTORY, ...evidence.verification, read: file => file.endsWith('price-verification.json') ? evidence.bytes : evidence.source, at }), /identity/)
  const f = fixture('r4-fresh-pin'), absent = path.join(f.directory, 'absent.json'), before = fs.readFileSync(f.file, 'utf8')
  assert.throws(() => subject.createLedger({ file: f.file, authorization, profile, helpers, phase: 'r4', directory: subject.FOURTH_DIRECTORY }), /hash-pinned/)
  assert.throws(() => subject.createLedger({ file: absent, authorization, profile, helpers, phase: 'r4', directory: subject.FOURTH_DIRECTORY, priceVerification: evidence.verification, now: () => at }), /cannot create/)
  assert.equal(fs.existsSync(absent), false); assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  const pending = f.ledger.reserve(body()), pendingState = f.ledger.snapshot()
  const renewed = subject.createLedger({ file: f.file, authorization, profile, helpers, phase: 'r4', directory: subject.FOURTH_DIRECTORY, priceVerification: evidence.verification, now: () => at })
  assert.equal(renewed.snapshot().startedAt, pendingState.startedAt); assert.equal(renewed.snapshot().authorizationHash, pendingState.authorizationHash)
  assert.equal(renewed.snapshot().requestsUsed, 1); assert.equal(renewed.snapshot().spentUpperMicros, pendingState.inflightReservedMicros)
  assert.equal(renewed.snapshot().attempts.find(item => item.id === pending).outcome, 'previous_process_unsettled')
})

test('R4 retains the original 51 cumulative attempts/¥0.498829, rechecks every egress and stops at the original 80/¥5 guards', async () => {
  let at = 1791026800106; const directory = path.join(suite, 'r4-shared-51'); fs.mkdirSync(directory); const file = path.join(directory, 'ledger.json')
  const old = subject.createLedger({ file, authorization, profile, helpers, phase: 'original-r1-r2-r3', now: () => at })
  for (let index = 0; index < 16; index++) { const id = old.reserve(body()); old.settle(id, index < 15 ? { prompt_tokens: 100, completion_tokens: 1700 } : { prompt_tokens: 171, completion_tokens: 1300 }, 'success') }
  for (let index = 0; index < 5; index++) {
    const id = old.reserve(body({ messages: [{ role: 'user', content: 'SYNTHETIC R3 seed only '.repeat(250) }] }))
    old.settle(id, { prompt_tokens: index < 4 ? 1000 : 715, completion_tokens: 1200 }, 'success')
  }
  const original = old.snapshot(); assert.equal(original.cumulativeRequests, 51); assert.equal(original.cumulativeSpentUpperCny, 0.498829)
  assert.equal(authorization.maxRequests - original.requestsUsed, 29)
  at = Date.parse('2026-10-04T02:25:00Z'); const evidence = priceEvidence(at, undefined, 'r4'); let tamper = ''
  const verification = { ...evidence.verification, read: name => { const value = evidence.verification.read(name); return tamper && name.endsWith(tamper) ? Buffer.concat([value, Buffer.from(' ')]) : value } }
  const localProfile = structuredClone(profile)
  const ledger = subject.createLedger({ file, authorization, profile: localProfile, helpers, phase: 'r4', directory: subject.FOURTH_DIRECTORY, priceVerification: verification, now: () => at })
  assert.deepEqual(ledger.snapshot(), original)
  let received = 0; const endpoint = await upstream((req, res) => { received++; req.resume(); req.on('end', () => sse(res)) })
  const relay = await subject.createRelay({ ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
  try {
    assert.equal((await send(relay)).status, 200); const before = fs.readFileSync(file, 'utf8')
    for (tamper of ['price-verification.json', 'price-verification-source.html']) { assert.equal((await send(relay)).status, 429); assert.equal(fs.readFileSync(file, 'utf8'), before) }
    tamper = ''; at += subject.PRICE_WINDOW_MS; assert.equal((await send(relay)).status, 429); at -= subject.PRICE_WINDOW_MS
    localProfile.updatedAt = '2026-10-04'; assert.equal((await send(relay)).status, 429); localProfile.updatedAt = subject.DATE
    const changed = JSON.parse(before); changed.requestsUsed = 0; fs.writeFileSync(file, JSON.stringify(changed)); assert.equal((await send(relay)).status, 429); fs.writeFileSync(file, before)
    assert.equal((await send(relay, body({ max_tokens: 4097 }))).status, 429); assert.equal(received, 1)
    for (let index = 1; index < 29; index++) assert.equal((await send(relay)).status, 200)
    const full = fs.readFileSync(file, 'utf8'); assert.equal((await send(relay)).status, 429); assert.equal(fs.readFileSync(file, 'utf8'), full)
    const final = ledger.snapshot(); assert.equal(received, 29); assert.equal(final.cumulativeRequests, 80); assert.ok(final.cumulativeSpentUpperCny <= 5)
    assert.equal(final.startedAt, original.startedAt); assert.equal(final.authorizationHash, original.authorizationHash); assert.deepEqual(final.authorization, original.authorization)
    assert.deepEqual(final.attempts.slice(0, 21), original.attempts); assert.ok(final.attempts.slice(21).every(item => item.priceVerificationSha256 === evidence.verification.expectedSha256))
  } finally { await relay.close(); await endpoint.close() }
  const limits = { ...authorization, previousSpentUpperCny: 4.999999, maxCostCny: 0.000001 }, capped = fixture('r4-owner-cap', limits)
  const capLedger = subject.createLedger({ file: capped.file, authorization: limits, profile, helpers, phase: 'r4', directory: subject.FOURTH_DIRECTORY, priceVerification: evidence.verification, now: () => at })
  const bytes = fs.readFileSync(capped.file, 'utf8'); assert.throws(() => capLedger.reserve(body()), /financial cap/); assert.equal(fs.readFileSync(capped.file, 'utf8'), bytes)
})

test('fixed R4 key-free preflight refuses each paid-state sentinel before writes, build/runtime or credential lookup', async t => {
  for (const sentinel of ['outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json']) {
    const probes = []; let writes = 0, loads = 0, requests = 0; const load = Module._load
    try {
      t.mock.method(console, 'error', () => undefined)
      t.mock.method(fs, 'existsSync', file => { probes.push(file); return file === path.join(subject.FOURTH_DIRECTORY, sentinel) })
      t.mock.method(fs, 'readFileSync', () => { throw new Error('Paid state refusal must not read any file') })
      for (const name of ['openSync', 'mkdirSync', 'mkdtempSync', 'writeFileSync', 'renameSync', 'unlinkSync']) t.mock.method(fs, name, () => { writes++; throw new Error('No preparation permitted') })
      t.mock.method(Module, '_load', function(name, ...rest) { if (['electron', 'esbuild', './build-cli.cjs'].includes(name)) { loads++; throw new Error('No runtime/key/build') } return load.call(this, name, ...rest) })
      for (const transport of [http, https]) t.mock.method(transport, 'request', () => { requests++; throw new Error('No network') })
      assert.equal(await subject.main(['--preflight', '--assessment=r4']), 2)
      assert.equal(probes.at(-1), path.join(subject.FOURTH_DIRECTORY, sentinel)); assert.equal(writes, 0); assert.equal(loads, 0); assert.equal(requests, 0)
    } finally { t.mock.restoreAll() }
  }
})

test('fixed R4 write cannot repeat a previously confirmed/completed durable outline or bypass explicit approval', async () => {
  const f = revisionFixture('r4-duplicate-write'), bundle = f.bundle
  for (const durableStatus of ['confirmed', 'completed', 'waiting_user']) {
    const commands = [], command = async (_, args) => { commands.push(args); return { code: 0, stderr: '', events: [{ type: 'state', data: { ...f.state, status: durableStatus } }] } }
    await assert.rejects(subject.writePhase({ bundle, relay: {}, directory: f.directory, approvedOutlineHash: f.state.outlineHash, command }), /already approved/)
    assert.deepEqual(commands.map(args => args[0]), ['status']); assert.equal(fs.existsSync(path.join(f.directory, 'explicit-outline-approval.json')), false)
  }
})

test('exact serialized UTF8 body, tools and framing are durably reserved before forwarding; known usage remains all-miss upper', async () => {
  const f = fixture('exact-body'); let received = 0
  const requestBody = body({ tools: [{ type: 'function', function: { name: 'synthetic_schema', parameters: { description: '界限😀\\\n' } } }] })
  const endpoint = await upstream((req, res) => {
    received++
    const disk = JSON.parse(fs.readFileSync(f.file, 'utf8'))
    assert.equal(disk.attempts[0].status, 'pending'); assert.equal(disk.requestsUsed, 1); assert.ok(disk.inflightReservedMicros > 0)
    assert.equal(req.headers.authorization, 'Bearer ' + FAKE)
    let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => { assert.equal(raw, requestBody); sse(res) })
  })
  const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
  try {
    assert.equal((await send(relay, requestBody)).status, 200)
    const state = f.ledger.snapshot(); const bound = helpers.utf8BodyTokenCeiling(requestBody)
    assert.equal(received, 1); assert.equal(state.attempts[0].requestHash, subject.sha(requestBody)); assert.equal(state.attempts[0].requestBytes, Buffer.byteLength(requestBody)); assert.equal(state.attempts[0].inputTokenCeiling, bound.ceiling)
    assert.equal(state.requestsUsed, 1); assert.equal(state.inflightReservedCny, 0); assert.equal(state.spentUpperCny, 0.0009)
    assert.equal(state.attempts[0].actualMicros, 880); assert.equal(state.attempts[0].chargedUpperMicros, 900)
    assert.ok(!fs.readFileSync(f.file, 'utf8').includes(FAKE)); assert.ok(!fs.readFileSync(f.file, 'utf8').includes(relay.localToken))
  } finally { await relay.close(); await endpoint.close() }
})
test('outline/writer/critic/repair-shaped requests share one financial/attempt ledger; 51st new attempt cannot egress', async () => {
  const f = fixture('all-routes'); let received = 0
  const endpoint = await upstream((req, res) => { received++; req.resume(); req.on('end', () => sse(res)) })
  const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
  try {
    for (let index = 0; index < 50; index++) assert.equal((await send(relay, body({ messages: [{ role: 'user', content: ['规划师', '正文', '文字审校员', '定点修订', '内部重试'][index % 5] }] }))).status, 200)
    assert.equal((await send(relay)).status, 429); assert.equal(received, 50)
    assert.equal(f.ledger.snapshot().cumulativeRequests, 80); assert.equal(f.ledger.snapshot().inflightReservedCny, 0)
  } finally { await relay.close(); await endpoint.close() }
})
test('money, wrong model/thinking/default envelope/path/auth/redirect and untrusted price fail closed before unauthorized egress', async () => {
  const f = fixture('financial-denials', { maxCostCny: 0.000001 }); let received = 0
  const endpoint = await upstream((req, res) => { received++; req.resume(); req.on('end', () => sse(res)) })
  const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
  try {
    for (const request of [body(), body({ model: 'deepseek-pro' }), body({ thinking: { type: 'enabled' } }), body({ max_tokens: 4097 }), '{broken']) assert.equal((await send(relay, request)).status, 429)
    assert.equal((await send(relay, body(), { path: '/chat/completions?redirect=1' })).status, 403)
    assert.equal((await send(relay, body(), { headers: { authorization: 'Bearer invalid' } })).status, 403)
    assert.equal((await send(relay, body({ messages: [{ role: 'user', content: FAKE }] }))).status, 400)
    assert.equal(received, 0); assert.equal(f.ledger.snapshot().requestsUsed, 0)
    assert.throws(() => subject.verifyPrice(helpers, { ...profile, updatedAt: '2026-10-04' }))
    await assert.rejects(subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: 'https://other.invalid' }))
  } finally { await relay.close(); await endpoint.close() }
  const redirected = fixture('redirect'); let destinationCalls = 0
  const destination = await upstream((req, res) => { destinationCalls++; res.end() })
  const redirector = await upstream((req, res) => { req.resume(); req.on('end', () => { res.writeHead(302, { location: destination.origin }); res.end() }) })
  const redirectRelay = await subject.createRelay({ ledger: redirected.ledger, apiKey: FAKE, target: redirector.origin, synthetic: true })
  try {
    assert.equal((await send(redirectRelay)).status, 502); assert.equal(destinationCalls, 0)
    const attempt = redirected.ledger.snapshot().attempts[0]; assert.equal(attempt.outcome, 'redirect_refused'); assert.equal(attempt.chargedUpperMicros, attempt.reservedMicros)
  } finally { await redirectRelay.close(); await redirector.close(); await destination.close() }
})
test('missing/contradictory/negative usage, HTTP failure and stream truncation consume full reserved upper, never zero', async () => {
  for (const mode of ['missing', 'contradictory', 'negative', 'http', 'truncated']) {
    const f = fixture('unknown-' + mode)
    const endpoint = await upstream((req, res) => { req.resume(); req.on('end', () => {
      if (mode === 'http') { res.writeHead(503); res.end('no echo'); return }
      if (mode === 'truncated') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"usage":{"prompt_tokens":10,"completion_tokens":10}}\n\n'); return }
      sse(res, mode === 'missing' ? null : mode === 'negative' ? { prompt_tokens: -1, completion_tokens: 10 } : { prompt_tokens: 10, completion_tokens: 10, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 0 })
    }) })
    const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
    try { await send(relay); const state = f.ledger.snapshot(); const attempt = state.attempts[0]; assert.equal(attempt.actualMicros, null, mode); assert.equal(attempt.chargedUpperMicros, attempt.reservedMicros, mode); assert.ok(state.spentUpperCny > 0); assert.equal(state.inflightReservedCny, 0) }
    finally { await relay.close(); await endpoint.close() }
  }
})
test('client cancellation and relay close settle pending full upper on disk; restart cannot free abandoned pending authorization', async () => {
  for (const mode of ['client', 'close']) {
    const f = fixture('cancel-' + mode); let arrived
    const arrival = new Promise(resolve => { arrived = resolve })
    const endpoint = await upstream((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"林舟"}}]}\n\n'); arrived() }) })
    const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
    const req = http.request(relay.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + relay.localToken } }, res => { res.resume(); res.on('error', () => undefined) })
    req.on('error', () => undefined); req.end(body()); await arrival
    if (mode === 'client') { req.destroy(); await new Promise(resolve => setTimeout(resolve, 25)) }
    await relay.close(); await endpoint.close()
    const disk = JSON.parse(fs.readFileSync(f.file, 'utf8')); assert.equal(disk.inflightReservedMicros, 0); assert.equal(disk.attempts[0].chargedUpperMicros, disk.attempts[0].reservedMicros); assert.equal(disk.attempts[0].actualMicros, null)
  }
  const f = fixture('crash-recovery'); f.ledger.reserve(body())
  const reopened = subject.createLedger({ file: f.file, authorization, profile, helpers, phase: 'next-phase' })
  const before = reopened.snapshot(); assert.equal(before.requestsUsed, 1); assert.equal(before.inflightReservedCny, 0); assert.ok(before.spentUpperCny > 0); assert.equal(before.attempts[0].outcome, 'previous_process_unsettled')
  reopened.reserve(body()); assert.equal(reopened.snapshot().requestsUsed, 2); assert.ok(reopened.snapshot().cumulativeSpentUpperCny > authorization.previousSpentUpperCny)
  reopened.settlePending()
})
test('provider token contract breach marks protection false and prevents every later route', async () => {
  const f = fixture('provider-breach')
  const id = f.ledger.reserve(body()); f.ledger.settle(id, { prompt_tokens: 10000000, completion_tokens: 10 }, 'success')
  assert.equal(f.ledger.snapshot().hardCapProtected, false); assert.throws(() => f.ledger.reserve(body()))
  assert.throws(() => subject.createLedger({ file: f.file, authorization, profile, helpers, phase: 'next' }))
})
test('concurrent requests count in-flight money; expired reference window and corrupted restart ledger cannot send', async () => {
  const ceiling = helpers.utf8BodyTokenCeiling(body()).ceiling
  const f = fixture('concurrent-bound', { maxCostCny: (ceiling + 4096 * 4) / 1e6 }); let arrived; let release
  const arrival = new Promise(resolve => { arrived = resolve })
  const endpoint = await upstream((req, res) => { req.resume(); req.on('end', () => { release = () => sse(res); arrived() }) })
  const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
  try {
    const first = send(relay); await arrival
    assert.equal((await send(relay)).status, 429); assert.equal(f.ledger.snapshot().requestsUsed, 1)
    release(); await first
  } finally { await relay.close(); await endpoint.close() }
  let time = 1000000000
  const dir = path.join(suite, 'expired'); fs.mkdirSync(dir)
  const expired = subject.createLedger({ file: path.join(dir, 'ledger.json'), authorization, profile, helpers, phase: 'expired', now: () => time })
  time += 30 * 60 * 1000 + 1; assert.throws(() => expired.reserve(body()))
  const corrupted = JSON.parse(fs.readFileSync(f.file, 'utf8')); corrupted.requestsUsed = 0
  fs.writeFileSync(f.file, JSON.stringify(corrupted)); assert.throws(() => subject.createLedger({ file: f.file, authorization: { ...authorization, maxCostCny: (ceiling + 4096 * 4) / 1e6 }, profile, helpers, phase: 'next' }))
})
function revisionFixture(id, now = Date.now) {
  const f = fixture(id, {}, now), bundle = path.join(f.directory, 'synthetic-bundle.cjs')
  fs.writeFileSync(bundle, '// synthetic identity only; never executed')
  const state = { stateId: 'synthetic-state', sessionId: 'synthetic-session', originalTask: subject.TASK, targetChars: 8000, status: 'awaiting_outline_confirmation', outlineRevision: 1, outlineHash: '1'.repeat(16), approvedOutline: null,
    slots: [{ id: 'setting', label: '场景', required: true, answer: '原设定', source: 'task' }], answers: [{ questionId: 'q1', value: '原答案', decision: 'answer', createdAt: 1 }], assumptions: [], outline: { title: '原合成大纲', targetChars: 8000, sections: [] }, planning: { updatedAt: 1 } }
  const original = { schemaVersion: 1, taskHash: subject.sha(subject.TASK), bundleSha256: subject.sha(fs.readFileSync(bundle)), sessionId: state.sessionId, outlineHash: state.outlineHash, state, approval: 'pending_explicit_root_confirmation' }
  const file = path.join(f.directory, 'outline.json'); fs.writeFileSync(file, JSON.stringify(original) + '\n')
  const commands = []; let durable = structuredClone(state)
  const context = { ...f, bundle, state, original, file, commands, get durable() { return durable }, set durable(value) { durable = value } }
  context.command = async (_, args, relay) => {
    commands.push(args)
    if (args[0] === 'list') return { code: 0, stderr: '', events: [{ type: 'list', data: { runs: [], sessions: [{ session_id: state.sessionId }] } }] }
    if (args[0] === 'outline') {
      if (relay?.baseUrl) assert.equal((await send(relay)).status, 200)
      durable = { ...durable, outlineRevision: 2, outlineHash: '2'.repeat(16), outline: { ...durable.outline, title: '第二份合成大纲' }, planning: { updatedAt: 999 } }
    }
    if (args[0] === 'confirm') return { code: 2, stderr: 'synthetic body deliberately not invoked', events: [] }
    return { code: 0, stderr: '', events: [{ type: 'state', data: structuredClone(durable) }] }
  }
  return context
}
test('explicit reoutline preserves original bytes/facts and one ledger; only revision2 exact approval can confirm', async t => {
  // Fixture financial time is independent of a peak-hour host clock. The same
  // fresh receipt and original ledger remain valid across UTC midnight.
  t.mock.method(Date, 'now', () => Date.parse('2026-11-26T02:25:00Z'))
  let at = Date.parse('2026-10-04T23:50:00Z'); const now = () => at
  const f = revisionFixture('reoutline-positive', now); const previousFailure = f.ledger.reserve(body()); f.ledger.settle(previousFailure, null, 'prior_failed_quality_attempt')
  const originalLedger = f.ledger.snapshot(), price = priceEvidence(now(), undefined, 'r4')
  assert.equal(originalLedger.startedAt, at)
  at = Date.parse('2026-10-05T00:05:00Z')
  f.ledger = subject.createLedger({ file: path.join(f.directory, 'ledger.json'), authorization, profile, helpers, phase: 'reoutline', directory: subject.FOURTH_DIRECTORY, priceVerification: price.verification, now })
  const oldBytes = fs.readFileSync(f.file); let received = 0
  const endpoint = await upstream((req, res) => { received++; req.resume(); req.on('end', () => sse(res)) })
  const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
  try {
    const result = await subject.reoutlinePhase({ ...f, relay })
    assert.equal(result.outlineRevision, 2); assert.equal(result.status, 'awaiting_outline_confirmation')
    assert.deepEqual(f.commands.map(args => args[0]), ['status', 'list', 'outline', 'status', 'list'])
    assert.deepEqual(f.commands[2], ['outline', f.state.sessionId]); assert.equal(received, 1)
    assert.deepEqual(fs.readFileSync(f.file), oldBytes)
    const revision = JSON.parse(fs.readFileSync(path.join(f.directory, 'outline-revision-2.json')))
    assert.equal(revision.originalOutlineSha256, subject.sha(oldBytes)); assert.equal(revision.outlineHash, f.durable.outlineHash)
    assert.equal(revision.state.planning.updatedAt, 999); assert.equal(fs.existsSync(path.join(f.directory, 'explicit-outline-approval.json')), false)
    assert.equal(f.ledger.snapshot().requestsUsed, originalLedger.requestsUsed + 1); assert.equal(f.ledger.snapshot().startedAt, originalLedger.startedAt)
    assert.equal(f.ledger.snapshot().authorizationHash, originalLedger.authorizationHash)
    assert.deepEqual(f.ledger.snapshot().attempts[0], originalLedger.attempts[0]); assert.equal(f.ledger.snapshot().attempts[1].phase, 'reoutline')
    assert.equal(f.ledger.snapshot().attempts[1].reservedAt, at)
    assert.equal(f.ledger.snapshot().attempts[1].priceVerificationSha256, price.verification.expectedSha256)
    assert.ok(f.ledger.snapshot().cumulativeRequests <= 80); assert.ok(f.ledger.snapshot().cumulativeSpentUpperCny <= 5)
    const before = f.commands.length
    await assert.rejects(subject.reoutlinePhase({ ...f, relay }), /once|Existing/)
    await assert.rejects(subject.writePhase({ ...f, relay, approvedOutlineHash: result.outlineHash }), /explicit|approval/)
    await assert.rejects(subject.writePhase({ ...f, relay, outlineRevision: 2, approvedOutlineHash: f.state.outlineHash }), /approval/)
    assert.equal(f.commands.length, before); assert.equal(received, 1)
    const written = await subject.writePhase({ ...f, relay, outlineRevision: 2, approvedOutlineHash: result.outlineHash })
    assert.equal(written.status, 'incomplete'); assert.deepEqual(f.commands.slice(before).map(args => args[0]), ['status', 'list', 'confirm'])
    const approval = JSON.parse(fs.readFileSync(path.join(f.directory, 'explicit-outline-approval.json')))
    assert.equal(approval.outlineRevision, 2); assert.equal(approval.outlineHash, result.outlineHash)
    await assert.rejects(subject.writePhase({ ...f, relay, outlineRevision: 2, approvedOutlineHash: result.outlineHash }), /Existing/)
    assert.deepEqual(fs.readFileSync(f.file), oldBytes); assert.equal(received, 1)
  } finally { await relay.close(); await endpoint.close() }
})
test('reoutline rejects prior revision/approval/result and changed original/durable identity before planning', async () => {
  for (const [index, change] of [
    f => { fs.writeFileSync(path.join(f.directory, 'reoutline-attempt.json'), '{}') },
    f => { fs.writeFileSync(path.join(f.directory, 'outline-revision-2.json'), '{}') },
    f => { fs.writeFileSync(path.join(f.directory, 'outline-revision-3.json'), '{}') },
    f => { fs.writeFileSync(path.join(f.directory, 'explicit-outline-approval.json'), '{}') },
    f => { fs.writeFileSync(path.join(f.directory, 'write-result.json'), '{}') },
    f => { f.durable.status = 'confirmed' }, f => { f.durable.approvedOutline = f.durable.outline },
    f => { f.durable.outlineHash = 'wrong' }, f => { f.durable.outlineRevision = 2 },
    f => { f.durable.sessionId = 'wrong' }, f => { f.durable.stateId = 'wrong' },
    f => { f.durable.originalTask = 'changed task' }, f => { f.durable.targetChars = 9000 },
    f => { f.durable.slots[0].answer = 'injected fact' }, f => { f.durable.answers[0].value = 'injected answer' },
    f => { f.durable.assumptions.push('fake fact') },
    f => { const old = JSON.parse(fs.readFileSync(f.file)); old.bundleSha256 = 'changed'; fs.writeFileSync(f.file, JSON.stringify(old)) }
  ].entries()) {
    const f = revisionFixture('reoutline-denial-' + index); change(f); const oldBytes = fs.readFileSync(f.file)
    await assert.rejects(subject.reoutlinePhase({ ...f, relay: {} }))
    assert.ok(!f.commands.some(args => ['outline', 'confirm', 'write', 'answer'].includes(args[0])))
    assert.deepEqual(fs.readFileSync(f.file), oldBytes)
  }
  for (const runs of [[{ runId: 'prior-body', sessionId: 'synthetic-session', status: 'completed' }], Array.from({ length: 100 }, (_, i) => ({ runId: 'other-' + i, sessionId: 'other-session' }))]) {
    const f = revisionFixture('reoutline-body-' + runs.length), command = f.command
    f.command = async (...args) => args[1][0] === 'list' ? { code: 0, events: [{ type: 'list', data: { runs, sessions: [{ session_id: f.state.sessionId }] } }] } : command(...args)
    await assert.rejects(subject.reoutlinePhase({ ...f, relay: {} }), /body|run/)
    assert.ok(!f.commands.some(args => args[0] === 'outline'))
  }
})
test('failed/interrupted/changed reoutline consumes the one marker, never replaces original or permits retry', async () => {
  for (const [index, failure] of [
    async () => { throw new Error('synthetic interrupted planning') },
    async f => ({ code: 1, stderr: 'synthetic failed planning', events: [] }),
    async f => ({ code: 0, events: [{ type: 'state', data: { ...f.durable, outlineRevision: 3 } }] }),
    async f => ({ code: 0, events: [{ type: 'state', data: { ...f.durable, outlineRevision: 2 } }] }),
    async f => ({ code: 0, events: [{ type: 'state', data: { ...f.durable, outlineRevision: 2, outlineHash: '2'.repeat(16), originalTask: 'fake fact' } }] }),
    async f => ({ code: 0, events: [{ type: 'state', data: { ...f.durable, outlineRevision: 2, outlineHash: '2'.repeat(16) } }] })
  ].entries()) {
    const f = revisionFixture('reoutline-failed-' + index), originalCommand = f.command, old = fs.readFileSync(f.file)
    f.command = async (...args) => { if (args[1][0] === 'outline') { f.commands.push(args[1]); return failure(f) } return originalCommand(...args) }
    await assert.rejects(subject.reoutlinePhase({ ...f, relay: {} }))
    assert.equal(fs.existsSync(path.join(f.directory, 'reoutline-attempt.json')), true)
    assert.equal(fs.existsSync(path.join(f.directory, 'outline-revision-2.json')), false)
    const count = f.commands.length; await assert.rejects(subject.reoutlinePhase({ ...f, relay: {} }), /once|Existing/)
    assert.equal(f.commands.length, count); assert.deepEqual(fs.readFileSync(f.file), old)
  }
})
test('reoutline/write revision flags fail closed before IO/key/network outside explicit fixed R4 syntax', async t => {
  const base = ['--real', '--assessment=r4', '--phase=reoutline', '--price-verification-sha256=' + 'a'.repeat(64)]
  const cases = [
    [...base, '--unknown=1'], [...base, '--phase=reoutline'], [...base, '--approved-outline-hash=' + '1'.repeat(16)], [...base, '--outline-revision=2'],
    base.map(arg => arg === '--assessment=r4' ? '--assessment=r3' : arg),
    [...base, '--price-verification-sha256=' + 'a'.repeat(64)],
    ['--real', '--assessment=r4', '--phase=write', '--outline-revision=3', '--approved-outline-hash=' + '2'.repeat(16)],
    ['--real', '--assessment=r3', '--phase=write', '--outline-revision=2', '--approved-outline-hash=' + '2'.repeat(16)],
    ['--real', '--assessment=r4', '--phase=write', '--outline-revision=2', '--outline-revision=2', '--approved-outline-hash=' + '2'.repeat(16)],
    ['--real', '--assessment=r4', '--phase=write', '--approved-outline-hash=' + '2'.repeat(16), '--approved-outline-hash=' + '2'.repeat(16)]
  ]
  const load = Module._load; let io = 0
  try {
    t.mock.method(console, 'error', () => undefined)
    for (const name of ['readFileSync', 'existsSync', 'openSync', 'writeFileSync', 'linkSync']) t.mock.method(fs, name, () => { io++; throw new Error('No real file IO permitted') })
    t.mock.method(Module, '_load', function (name, ...rest) { if (name === 'electron') { io++; throw new Error('No key/runtime') } return load.call(this, name, ...rest) })
    for (const transport of [http, https]) t.mock.method(transport, 'request', () => { io++; throw new Error('No network') })
    for (const args of cases) assert.equal(await subject.main(args), 2)
    assert.equal(io, 0)
  } finally { t.mock.restoreAll() }
})
test('reoutline verifies fresh fixed R4 price and requires original ledger before runtime/key/writes/network', async t => {
  const at = Date.parse('2026-10-04T01:25:00Z'), evidence = priceEvidence(at, undefined, 'r4')
  const load = Module._load; let sensitive = 0, writes = 0, network = 0
  const reads = []
  try {
    t.mock.method(Date, 'now', () => at); t.mock.method(console, 'error', () => undefined)
    t.mock.method(fs, 'readFileSync', file => { reads.push(file); return evidence.verification.read(file) })
    t.mock.method(fs, 'existsSync', () => false)
    for (const name of ['openSync', 'writeFileSync', 'mkdirSync', 'mkdtempSync', 'linkSync']) t.mock.method(fs, name, () => { writes++; throw new Error('No writes') })
    t.mock.method(Module, '_load', function (name, ...rest) { if (name === 'electron') { sensitive++; throw new Error('No key/runtime') } return load.call(this, name, ...rest) })
    for (const transport of [http, https]) t.mock.method(transport, 'request', () => { network++; throw new Error('No network') })
    assert.equal(await subject.main(['--real', '--assessment=r4', '--phase=reoutline', '--price-verification-sha256=' + evidence.verification.expectedSha256]), 2)
    assert.deepEqual(reads, [path.join(subject.FOURTH_DIRECTORY, 'price-verification.json'), path.join(subject.FOURTH_DIRECTORY, 'price-verification-source.html')])
    assert.equal(writes, 0); assert.equal(sensitive, 0); assert.equal(network, 0)
  } finally { t.mock.restoreAll() }
})
test('legacy exact CLI bundle records the native reoutline red without claiming current-source success', async t => {
  const f = fixture('native-reoutline-syntax'), bundle = path.join(subject.ROOT, 'out/cli/deepwriter.cjs')
  const legacyHash = 'cef3c61f1dfb1b244b42bec8e9dd5cf525949323c7ede5772305501c25915ee4'
  if (!fs.existsSync(bundle)) { t.skip('Legacy bundle absent; mandatory TEMP current-source regression is separate'); return }
  const bundleBytes = fs.readFileSync(bundle)
  if (subject.sha(bundleBytes) !== legacyHash) { t.skip('Existing bundle is not the exact known legacy SHA; mandatory TEMP regression remains required'); return }
  let outlines = 0
  const endpoint = await upstream((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
      const prompt = JSON.parse(raw).messages.map(message => message.content).join('\n')
      assert.ok(prompt.includes('你是文章规划师'), 'native syntax test must never request prose/review')
      const sources = JSON.parse(prompt.match(/必须覆盖的来源 id：([^\n]+)/u)[1]); outlines++
      const content = JSON.stringify({ title: '纯合成命令大纲' + outlines, premise: '仅验证命令，不作文学质量证明。', sections: ['林舟照向档案柜。', '顾岚打开档案柜。', '林舟取回附页。', '顾岚保护档案。'].map((beat, index) => ({ id: 's' + index, title: '合成节' + index, purpose: beat, beats: [beat], targetChars: 2000, sourceSlotIds: sources })) })
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 200 } }) + '\n\n'); res.end('data: [DONE]\n\n')
    })
  })
  const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
  const commands = [], nativeStates = [], command = async (...args) => {
    commands.push(args[1]); const result = await subject.cliCommand(...args)
    const state = result.events.find(event => event.type === 'state')?.data
    if (state && ['outline', 'status'].includes(args[1][0])) nativeStates.push({ command: args[1][0], code: result.code, status: state.status, outlineRevision: state.outlineRevision, outlineHash: state.outlineHash, hasOutline: Boolean(state.outline), planningStatus: state.planning?.status, planningError: state.planning?.error })
    return result
  }
  try {
    const outline = await subject.outlinePhase({ bundle, relay, directory: f.directory, command })
    const old = fs.readFileSync(path.join(f.directory, 'outline.json')); const index = commands.length
    await assert.rejects(subject.reoutlinePhase({ bundle, relay, directory: f.directory, command }), /Reoutline did not produce/)
    assert.equal(outlines, 2)
    assert.deepEqual(commands.slice(index).map(args => args[0]), ['status', 'list', 'outline'])
    const failed = nativeStates.findLast(state => state.command === 'outline')
    assert.equal(failed.code, 0, 'known legacy falsely exits zero')
    assert.equal(failed.status, 'awaiting_outline_confirmation'); assert.equal(failed.outlineRevision, 1)
    assert.equal(failed.outlineHash, ''); assert.equal(failed.hasOutline, false); assert.equal(failed.planningStatus, 'failed')
    assert.match(failed.planningError, /采访尚未完成/)
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'outline.json')), old); assert.deepEqual(fs.readFileSync(bundle), bundleBytes)
    assert.equal(fs.existsSync(path.join(f.directory, 'explicit-outline-approval.json')), false)
    assert.equal(fs.existsSync(path.join(f.directory, 'outline-revision-2.json')), false)
    assert.equal(fs.existsSync(path.join(f.directory, 'reoutline-attempt.json')), true)
    console.log('# legacy-native-reoutline-red ' + JSON.stringify({ bundleSha256: legacyHash, commands: commands.slice(index), originalOutlineHash: outline.outlineHash, fakeLoopbackPlannerCalls: outlines, bodyCalls: 0, sourceBuildPerformed: false, expectedLegacyBug: true, qualityAccepted: false }))
  } finally {
    console.log('# native-existing-cli-reoutline-observations ' + JSON.stringify({ bundleSha256: subject.sha(bundleBytes), outlines, nativeStates, sourceBuildPerformed: false, qualityAccepted: false }))
    await relay.close(); await endpoint.close()
  }
})

let currentBundlePromise
function currentSourceBundle() {
  currentBundlePromise ??= (async () => {
    const bundle = path.join(suite, 'mandatory-current-source.cjs')
    const { buildCli } = await import(pathToFileURL(path.join(subject.ROOT, 'src/cli/build.mjs')).href)
    await buildCli({ outfile: bundle }) // TEMP only; never out/cli or a paid fixed bundle.
    return bundle
  })()
  return currentBundlePromise
}
function sharedGrill() {
  const file = path.join(subject.ROOT, 'src/shared/grillMe.ts'), module = { exports: {} }
  // Grill Me now imports shared form helpers. Load its real dependency graph,
  // not a single transformed file with an undefined/incorrect relative require.
  const built = require('esbuild').buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports)
  return module.exports
}
function factProjection(state) {
  return { stateId: state.stateId, sessionId: state.sessionId, originalTask: state.originalTask, targetChars: state.targetChars, slots: state.slots, answers: state.answers, assumptions: state.assumptions }
}
function candidateProjection(state) {
  return { status: state.status, outline: state.outline, outlineHash: state.outlineHash, outlineRevision: state.outlineRevision, approvedOutline: state.approvedOutline }
}
function syntheticDatabase(directory, callback) {
  assert.equal(path.dirname(directory), suite, 'Only isolated synthetic fixture DBs may be accessed')
  const db = new (require('node:sqlite').DatabaseSync)(path.join(directory, 'data/deepwriter.sqlite'))
  try { return callback(db) } finally { db.close() }
}
function setSyntheticState(directory, state) {
  syntheticDatabase(directory, db => db.prepare('UPDATE grill_me_sessions SET state_json=?, updated_at=? WHERE session_id=?').run(JSON.stringify(state), state.updatedAt, state.sessionId))
}

test('mandatory TEMP current-source native reoutline preserves facts/candidates, rejects unsafe states before egress, and permits unrelated history', async () => {
  const bundle = await currentSourceBundle(), f = fixture('native-current-source'), grill = sharedGrill()
  let mode = 'good', plannerCalls = 0, otherCalls = 0, repairCalls = 0
  const relayDenials = [], reserve = f.ledger.reserve.bind(f.ledger)
  f.ledger.reserve = value => {
    try { return reserve(value) }
    catch (error) {
      const request = JSON.parse(value)
      relayDenials.push({ reason: error.message, maxTokens: request.max_tokens ?? null, thinking: request.thinking ?? null })
      throw error
    }
  }
  const endpoint = await upstream((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
      const prompt = JSON.parse(raw).messages.map(message => message.content).join('\n')
      const planning = prompt.includes('你是文章规划师')
      if (planning) plannerCalls++; else otherCalls++
      if (mode === 'http') { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"synthetic HTTP planning failure"}}'); return }
      let content = '这是一条普通历史聊天回复。'
      if (planning) {
        let sources = JSON.parse(prompt.match(/必须覆盖的来源 id：([^\n]+)/u)[1])
        if (mode === 'missing' || mode === 'repair' && ++repairCalls === 1) sources = sources.slice(1)
        if (mode === 'empty-source') sources = []
        content = mode === 'bad-json' ? '{invalid JSON' : JSON.stringify({ title: '当前源码合成大纲' + plannerCalls, premise: '仅验证真实CLI状态契约，不作文学质量证明。', sections: ['林舟照向档案柜。', '顾岚打开档案柜。', '林舟取回附页。', '顾岚保护档案。'].map((beat, index) => ({ id: 's' + index, title: '合成节' + index, purpose: beat, beats: [beat], targetChars: 2000, sourceSlotIds: sources })) })
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(responseBytes(content))
    })
  })
  const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
  const commands = [], command = async (bundle, args, relay, directory) => {
    // This accounting fixture authorizes bounded requests, while ordinary
    // product chat now defaults to omitting the provider output parameter.
    const boundedArgs = [...args, '--max-tokens', '4096']
    commands.push(boundedArgs)
    const result = await subject.cliCommand(bundle, boundedArgs, relay, directory)
    if (result.code !== 0) result.stderr += `\nSynthetic fixture: mode=${mode}, plannerCalls=${plannerCalls}, otherCalls=${otherCalls}, reservedRequests=${f.ledger.snapshot().requestsUsed}\nRelay denials: ${JSON.stringify(relayDenials.slice(-4))}\nCLI JSON: ${JSON.stringify(result.events.filter(event => ['result', 'error'].includes(event.type)))}`
    return result
  }
  const invoke = args => command(bundle, args, relay, f.directory)
  const stateFrom = result => { assert.equal(result.code, 0, result.stderr); const state = result.events.find(event => event.type === 'state')?.data; assert.ok(state); return state }
  const status = session => invoke(['status', session]).then(stateFrom)
  try {
    const first = await subject.outlinePhase({ bundle, relay, directory: f.directory, command })
    let previous = await status(first.sessionId), facts = factProjection(previous)
    const original = fs.readFileSync(path.join(f.directory, 'outline.json'))
    let next = stateFrom(await invoke(['outline', first.sessionId]))
    assert.equal(next.planning.status, 'success'); assert.equal(next.outlineRevision, 2); assert.notEqual(next.outlineHash, previous.outlineHash)
    assert.equal(next.outlineHash, grill.grillMeOutlineHash(next.outline)); assert.deepEqual(factProjection(next), facts)
    assert.deepEqual(candidateProjection(await status(first.sessionId)), candidateProjection(next))
    previous = next
    const chat = await invoke(['chat', '独立的普通历史聊天。', '--session', first.sessionId])
    assert.equal(chat.code, 0, chat.stderr)
    const chatRun = chat.events.find(event => event.type === 'result')?.data
    assert.ok(chatRun?.runId); assert.equal(chatRun.status, 'completed')
    const chatConfig = syntheticDatabase(f.directory, db => JSON.parse(db.prepare('SELECT config_json FROM runs WHERE run_id=?').get(chatRun.runId).config_json))
    assert.equal(chatConfig.runMode, 'agent')
    assert.equal(chatConfig.outputTokenLimit, 4096)
    assert.equal(grill.grillMeHasBodyRun(previous, [{ config_json: JSON.stringify(chatConfig) }]), false)
    next = stateFrom(await invoke(['outline', first.sessionId]))
    assert.equal(next.outlineRevision, 3, 'same-session historical ordinary chat must not block planning'); assert.deepEqual(factProjection(next), facts)
    previous = next
    // The accounting relay maps upstream HTTP failure to 502; the production
    // transport's existing one retry means exactly two failed HTTP attempts.
    for (const [failure, expectedCalls] of [['bad-json', 1], ['http', 2], ['missing', 2], ['empty-source', 1]]) {
      mode = failure; const before = plannerCalls
      const result = await invoke(['outline', first.sessionId])
      assert.notEqual(result.code, 0, failure + ' must never fake exit0 from awaiting status')
      const failed = await status(first.sessionId)
      assert.equal(failed.planning.status, 'failed'); assert.deepEqual(candidateProjection(failed), candidateProjection(previous))
      assert.deepEqual(factProjection(failed), facts); assert.equal(plannerCalls - before, expectedCalls, failure + ' retry policy')
    }
    mode = 'repair'; const beforeRepair = plannerCalls
    next = stateFrom(await invoke(['outline', first.sessionId]))
    assert.equal(plannerCalls - beforeRepair, 2); assert.equal(next.outlineRevision, 4); assert.equal(next.planning.status, 'success')
    assert.deepEqual(factProjection(next), facts); previous = next
    for (const mutation of [
      state => { state.answers.pop() },
      state => { state.answers.at(-1).questionId = 'forged_not_final'; state.questions = state.questions.filter(question => question.kind !== 'final_check') },
      state => { state.slots.find(slot => slot.required).answer = '' },
      state => { state.status = 'confirmed'; state.approvedOutline = structuredClone(state.outline) },
      state => { state.approvedOutline = structuredClone(state.outline) },
      state => { state.outlineHash = 'invalid-candidate-hash' },
      state => { state.outline = null }
    ]) {
      const invalid = structuredClone(previous); mutation(invalid); setSyntheticState(f.directory, invalid)
      const before = plannerCalls + otherCalls, result = await invoke(['outline', first.sessionId])
      assert.notEqual(result.code, 0); assert.equal(plannerCalls + otherCalls, before, 'unsafe state refused before provider egress')
      assert.deepEqual(factProjection(await status(first.sessionId)), factProjection(invalid))
      setSyntheticState(f.directory, previous)
    }
    mode = 'http'
    // Create an authentic approved execute run via CLI; only this new synthetic
    // fixture's state is restored afterwards to exercise the durable body guard.
    await invoke(['confirm', first.sessionId, '--hash', previous.outlineHash])
    const bodyRun = syntheticDatabase(f.directory, db => db.prepare('SELECT run_id,config_json FROM runs WHERE session_id=? ORDER BY started_at DESC').all(first.sessionId).find(row => JSON.parse(row.config_json).runMode === 'longwrite'))
    assert.ok(bodyRun, 'real CLI confirm must persist a real approved longwrite run')
    const bodyConfig = JSON.parse(bodyRun.config_json)
    assert.equal(bodyConfig.grillMe.stateId, previous.stateId); assert.ok(bodyConfig.grillMe.approvedOutline)
    assert.equal(bodyConfig.longMode, true); assert.equal(bodyConfig.planMode, false)
    assert.equal(bodyConfig.strongConstraints.enabled, true, 'review safety was not bypassed')
    setSyntheticState(f.directory, previous)
    const beforeBodyGuard = plannerCalls + otherCalls, refused = await invoke(['outline', first.sessionId])
    assert.notEqual(refused.code, 0); assert.match(refused.stderr, /正文/); assert.equal(plannerCalls + otherCalls, beforeBodyGuard)
    assert.deepEqual(candidateProjection(await status(first.sessionId)), candidateProjection(previous))
    bodyConfig.grillMe.stateId = 'different-synthetic-interview'
    syntheticDatabase(f.directory, db => db.prepare('UPDATE runs SET config_json=? WHERE run_id=?').run(JSON.stringify(bodyConfig), bodyRun.run_id))
    mode = 'good'; next = stateFrom(await invoke(['outline', first.sessionId]))
    assert.equal(next.outlineRevision, 5, 'another interview stateId historical body must not block current planning')
    assert.deepEqual(factProjection(next), facts)
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'outline.json')), original)
    assert.equal(fs.existsSync(path.join(f.directory, 'explicit-outline-approval.json')), false)
    assert.deepEqual(relayDenials, [], 'Every native request must satisfy the unchanged accounting envelope')
    const sources = ['src/shared/grillMe.ts', 'src/cli/runtime.ts', 'src/main/index.ts'].map(name => ({ name, sha256: subject.sha(fs.readFileSync(path.join(subject.ROOT, name))) }))
    console.log('# mandatory-current-source-native-reoutline ' + JSON.stringify({ tempBundle: bundle, bundleSha256: subject.sha(fs.readFileSync(bundle)), sources, plannerCalls, otherCalls, revision: next.outlineRevision, nativeCommands: commands, fakeLoopbackOnly: true, paidStateTouched: false, qualityAccepted: false }))
  } finally { await relay.close(); await endpoint.close() }
})

test('shared/Desktop planning uses same-state frozen-body guard before model resolution without weakening completion or success', () => {
  const grill = sharedGrill(), state = { stateId: 'current' }
  const config = { runMode: 'longwrite', longMode: true, planMode: false, grillMe: { stateId: 'current', approvedOutline: { sections: [{}] } } }
  assert.equal(grill.grillMeHasBodyRun(state, [{ config_json: JSON.stringify(config) }]), true)
  for (const changed of [
    { ...config, runMode: 'agent' }, { ...config, planMode: true }, { ...config, longMode: false },
    { ...config, grillMe: { ...config.grillMe, stateId: 'old' } }, { ...config, grillMe: { ...config.grillMe, approvedOutline: null } }
  ]) assert.equal(grill.grillMeHasBodyRun(state, [{ config_json: JSON.stringify(changed) }]), false)
  const desktop = fs.readFileSync(path.join(subject.ROOT, 'src/main/index.ts'), 'utf8').split('async function runGrillPlanning(')[1].split('function publishGrillActivity')[0]
  const desktopGuard = desktop.indexOf('grillMeHasBodyRun(state, repo.listRunsBySession(state.sessionId))')
  assert.ok(desktopGuard >= 0 && desktopGuard < desktop.indexOf('resolveGrillModel()'))
  assert.ok(desktop.includes("next.planning.status === 'success'")); assert.ok(desktop.includes('if (!grillMeInterviewReadyForOutline(state))'))
  const cli = fs.readFileSync(path.join(subject.ROOT, 'src/cli/runtime.ts'), 'utf8').split('async outline(state: GrillMeState)')[1].split('async resume(')[0]
  const cliGuard = cli.indexOf('grillMeHasBodyRun(state, repo.listRunsBySession(state.sessionId))')
  assert.ok(cliGuard >= 0 && cliGuard < cli.indexOf('await ensureProvider()'))
})
test('outline-only phase cannot approve or start prose; a different/missing root hash cannot issue any CLI command', async () => {
  const f = fixture('approval-fence'); const bundle = path.join(f.directory, 'fake-bundle.cjs'); fs.writeFileSync(bundle, '// only hash identity, never executed')
  const commands = []; const state = { sessionId: 'synthetic-session', targetChars: 8000, status: 'outline_ready' }
  const command = async (bundle, args) => { commands.push(args); return { code: 0, stderr: '', events: [{ type: 'state', data: args[0] === 'write' ? state : { ...state, status: 'awaiting_outline_confirmation', outlineHash: 'synthetic-real-cli-hash', approvedOutline: null, outline: { sections: [] } } }] } }
  const result = await subject.outlinePhase({ bundle, relay: {}, directory: f.directory, command })
  assert.equal(result.status, 'awaiting_outline_confirmation'); assert.deepEqual(commands.map(args => args[0]), ['write', 'outline'])
  for (const approvedOutlineHash of [undefined, 'wrong']) await assert.rejects(subject.writePhase({ bundle, relay: {}, directory: f.directory, approvedOutlineHash, command }))
  assert.equal(commands.length, 2)
})
test('prepared package/lock/builder/source identity is checked without Electron, settings or credentials', () => {
  const f = fixture('prepared-identity'); const root = path.join(f.directory, 'source'); const directory = path.join(f.directory, 'assessment')
  fs.mkdirSync(path.join(root, 'src/cli'), { recursive: true }); fs.mkdirSync(path.join(directory, 'build'), { recursive: true })
  const files = new Map([
    ['package.json', JSON.stringify({ name: 'synthetic', version: '1.3.1', scripts: { test: 'synthetic' } })],
    ['package-lock.json', JSON.stringify({ version: '1.3.1', packages: { '': { version: '1.3.1' } } })],
    ['src/cli/build.mjs', '// synthetic builder identity only'],
    ['src/cli/main.ts', '// synthetic source identity only']
  ])
  for (const [name, content] of files) fs.writeFileSync(path.join(root, name), content)
  const bundle = '// synthetic bundle identity only, never executed'; fs.writeFileSync(path.join(directory, 'build/deepwriter.cjs'), bundle)
  const receipt = { application: { name: 'deepwriter-cli', version: '1.3.1' }, source: { packageSha256: subject.sha(files.get('package.json')), lockSha256: subject.sha(files.get('package-lock.json')) }, buildPolicy: { entrypoint: 'src/cli/main.ts', implementation: 'src/cli/build.mjs', implementationSha256: subject.sha(files.get('src/cli/build.mjs')), platform: 'node', format: 'cjs', target: 'node22' }, inputs: [{ name: 'src/cli/main.ts', sha256: subject.sha(files.get('src/cli/main.ts')) }] }
  const receiptText = JSON.stringify(receipt); fs.writeFileSync(path.join(directory, 'build/cli-build.json'), receiptText)
  fs.writeFileSync(path.join(directory, 'preflight.json'), JSON.stringify({ bundleSha256: subject.sha(bundle), buildReceiptSha256: subject.sha(receiptText) }))
  assert.equal(subject.verifyPreparedBuild({ root, directory }).receipt.application.version, '1.3.1')
  for (const [name, changed, expected] of [
    ['package.json', JSON.stringify({ name: 'synthetic', version: '1.3.1', scripts: { test: 'script-only-drift' } }), /Package\/lock identity/],
    ['package-lock.json', JSON.stringify({ version: '1.3.2', packages: { '': { version: '1.3.2' } } }), /Package\/lock identity/],
    ['src/cli/build.mjs', '// changed builder', /builder identity/],
    ['src/cli/main.ts', '// changed source', /CLI source changed/]
  ]) {
    fs.writeFileSync(path.join(root, name), changed)
    assert.throws(() => subject.verifyPreparedBuild({ root, directory }), expected)
    fs.writeFileSync(path.join(root, name), files.get(name))
  }
  fs.writeFileSync(path.join(directory, 'build/cli-build.json'), receiptText + ' ')
  assert.throws(() => subject.verifyPreparedBuild({ root, directory }), /receipt is absent or changed/)
  fs.writeFileSync(path.join(directory, 'build/cli-build.json'), receiptText)
  fs.writeFileSync(path.join(directory, 'build/deepwriter.cjs'), bundle + ' ')
  assert.throws(() => subject.verifyPreparedBuild({ root, directory }), /audited coherent CLI/)
})
test('optional final actual CLI preflight uses the genuine default entry/host/SQLite/publisher, 8000 chars and review on', { skip: process.env.DEEPWRITER_CLI_QUALITY_BUILD !== '1' }, async () => {
  // Root enables this only after the final production source wave is coherent.
  // It still uses fake credentials and a loopback provider, never a real API.
  const f = fixture('actual-cli-default'); const build = await require('./build-cli.cjs').buildCliArtifact({ root: subject.ROOT, output: path.join(subject.ROOT, 'out', 'cli-quality-local-build-' + process.pid) })
  const bundle = path.join(build.output, 'deepwriter.cjs'); let writers = 0; let reviews = 0; let editors = 0
  const requests = []
  const beats = ['林舟见到顾岚。', '顾岚看见档案柜钥匙。', '林舟进入档案室。', '林舟找到旧海难档案附页。', '顾岚透露错误开闸记录。', '林舟取走档案附页。', '林舟进入塔顶。', '顾岚决定保护档案。']
  const paragraph = index => {
    const prefix = (index === 0 ? '23:00，林舟持手电筒，顾岚持档案柜钥匙。' : '') + beats[index]
    const ending = index === 7 ? '至次日破晓，附页仍在。林舟与顾岚共同作出保护档案的决定，关系仍旧疏离。' : '。'
    const fill = 1000 - Array.from(prefix + ending).length
    // Non-Chinese deterministic Cuneiform noise exercises Unicode counting
    // without accidentally generating unrelated names/negation/role grammar.
    // This deliberately has NO literary-quality evidentiary value.
    let seed = ((index + 1) * 2654435761) >>> 0
    const noise = Array.from({ length: fill }, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return String.fromCodePoint(0x12000 + ((seed >>> 0) % 900)) }).join('')
    return prefix + noise + ending
  }
  const endpoint = await upstream((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
      const request = JSON.parse(raw); requests.push(request)
      fs.writeFileSync(path.join(f.directory, 'synthetic-wire-requests.json'), JSON.stringify(requests))
      const prompt = request.messages.map(message => message.content).join('\n'); let content
      if (prompt.includes('你是文章规划师')) {
        const sources = JSON.parse(prompt.match(/必须覆盖的来源 id：([^\n]+)/u)[1])
        content = JSON.stringify({ title: '虚构旧灯塔', premise: '林舟取回档案附页，顾岚的错误开闸记录被揭示，两人保护档案但不和解。', sections: beats.map((beat, index) => ({ id: 's' + (index + 1), title: '连续场景' + (index + 1), purpose: beat, beats: [beat], targetChars: 1000, sourceSlotIds: sources })) })
      } else {
        let review; try { review = JSON.parse([...request.messages].reverse().find(message => message.role === 'user').content) } catch {}
        if (review?.candidateHash && prompt.includes('你是文字审校员')) { reviews++; content = JSON.stringify({ schemaVersion: 1, candidateHash: review.candidateHash, issues: [] }) }
        else if (review?.candidateHash && review.issue && prompt.includes('你是定点文字编辑')) { editors++; const issue = review.issue; const quote = Array.from(issue.quote); const replacement = quote.slice(0, -1).join('') + '。'; content = JSON.stringify({ schemaVersion: 1, candidateHash: review.candidateHash, patches: [{ issueId: issue.issueId, startCp: issue.startCp, endCp: issue.endCp, quote: issue.quote, replacement }] }) }
        else if (writers < 8) content = paragraph(writers++)
        else { res.writeHead(500); res.end('Unexpected additional provider phase; inspect saved synthetic request contract'); return }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) + '\n\n'); res.end('data: [DONE]\n\n')
    })
  })
  const relay = await subject.createRelay({ ledger: f.ledger, apiKey: FAKE, target: endpoint.origin, synthetic: true })
  try {
    const outline = await subject.outlinePhase({ bundle, relay, directory: f.directory })
    assert.equal(writers, 0); assert.equal(reviews, 0)
    // Explicit test-user decision, separate from the outline function. This
    // cannot auto-approve the unrelated later real model's outline.
    const proof = await subject.writePhase({ bundle, relay, directory: f.directory, approvedOutlineHash: outline.outlineHash })
    assert.equal(proof.status, 'completed', JSON.stringify(proof)); assert.ok(proof.chars >= 8000); assert.equal(proof.reviewEnabled, true); assert.ok(writers >= 8); assert.ok(reviews >= 8)
    assert.equal(subject.sha(fs.readFileSync(proof.manuscript)), proof.sha256)
    const scan = directory => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, item.name); if (item.isDirectory()) scan(file); else { const bytes = fs.readFileSync(file); assert.ok(!bytes.includes(Buffer.from(FAKE)), 'Fake upstream key must never persist'); assert.ok(!bytes.includes(Buffer.from(relay.localToken)), 'Raw local capability must never persist') } } }
    scan(f.directory)
    process.stdout.write('# actual-default-CLI synthetic-control-flow ' + JSON.stringify({ version: build.receipt.application.version, sourceDirty: build.receipt.sourceDirty, bundleSha256: build.receipt.bundle.sha256, buildOutput: build.output, chars: proof.chars, sha256: proof.sha256, writers, reviews, editors, requests: f.ledger.snapshot().requestsUsed, qualityAccepted: false }) + '\n')
  } finally { await relay.close(); await endpoint.close() }
})
