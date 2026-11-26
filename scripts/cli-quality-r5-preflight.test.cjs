'use strict'

// R5 is a fixed new data namespace, not new money or retry authorization.
// All ledger/marker fixtures live under our newly created temporary suite.
// Fixed paid paths are trapped or redirected there; no credential, remote
// request, actual CLI build, or existing assessment file is read or written.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const Module = require('node:module')
const { test, before, after } = require('node:test')
const subject = require('./authorized-cli-quality.cjs')

const AT = Date.parse('2026-10-04T02:25:00Z')
const authorization = { ownerCapCny: 5, internalCumulativeRequestGuard: 80, previousSpentUpperCny: 0.361243, previousRequests: 30, maxCostCny: 4.638757, maxRequests: 50, previousManifests: [{ path: 'SYNTHETIC prior authorization', sha256: 'a'.repeat(64) }] }
const body = () => JSON.stringify({ model: subject.MODEL, stream: true, max_tokens: 4096, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'SYNTHETIC 林舟与顾岚，固定灯塔任务。' }] })
let suite, profile, helpers
function priceEvidence(assessment = 'r5', at = AT, mutate = () => undefined) {
  const directory = assessment === 'r4' ? subject.FOURTH_DIRECTORY : subject.FIFTH_DIRECTORY
  const source = Buffer.from('<html>SYNTHETIC R5 equivalent price only, not official evidence</html>')
  const receipt = { schemaVersion: 1, purpose: 'equivalent_price_window_only', assessment, canonicalOrigin: subject.ORIGIN, model: subject.MODEL, currency: 'CNY', unit: 'per-1M-tokens', priceProfileHash: subject.PRICE_HASH, priceBand: 'off_peak', schedule: subject.OFF_PEAK_SCHEDULE, sourceFetchedAt: new Date(at).toISOString(), verifiedAt: new Date(at).toISOString(), expiresAt: new Date(at + subject.PRICE_WINDOW_MS).toISOString(), sourceUrl: subject.PRICE_SOURCE_URL, sourceSha256: subject.sha(source), entry: { model: subject.MODEL, inputPer1M: 1, outputPer1M: 4, cacheHitPer1M: 0.02 } }
  mutate(receipt)
  const bytes = Buffer.from(JSON.stringify(receipt))
  const read = file => {
    if (file === path.join(directory, 'price-verification.json')) return bytes
    if (file === path.join(directory, 'price-verification-source.html')) return source
    throw new Error('Synthetic receipt denies every other file')
  }
  return { directory, receipt, source, bytes, verification: { expectedSha256: subject.sha(bytes), read } }
}
function fixture(id, overrides = {}) {
  const directory = path.join(suite, id), r5 = path.join(directory, 'r5'), file = path.join(directory, 'ledger.json'), lock = path.join(directory, 'shared.lock')
  fs.mkdirSync(r5, { recursive: true })
  const auth = { ...authorization, ...overrides }
  const old = subject.createLedger({ file, authorization: auth, profile, helpers, phase: 'SYNTHETIC existing original ledger', now: () => AT })
  const evidence = priceEvidence()
  const ledger = subject.createLedger({ file, authorization: auth, profile, helpers, phase: 'outline', directory: subject.FIFTH_DIRECTORY, priceVerification: evidence.verification, now: () => AT })
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, phase: 'outline' }))
  const prepared = { authorization: auth, bundleSha256: 'b'.repeat(64), buildReceiptSha256: 'c'.repeat(64) }
  return { directory, r5, file, lock, old, ledger, evidence, auth, prepared }
}
function redirectPaidPaths(t, f) {
  const paths = subject.assessmentPaths(subject.FIFTH_DIRECTORY)
  const redirect = file => {
    if (typeof file !== 'string') return file
    if (file === paths.budgetFile) return f.file
    if (file === paths.lockFile) return f.lock
    if (file === subject.FIFTH_DIRECTORY || file.startsWith(subject.FIFTH_DIRECTORY + path.sep)) return path.join(f.r5, path.relative(subject.FIFTH_DIRECTORY, file))
    if ([subject.DIRECTORY, subject.SECOND_DIRECTORY, subject.THIRD_DIRECTORY, subject.FOURTH_DIRECTORY].some(root => file === root || file.startsWith(root + path.sep))) throw new Error('Existing paid namespace I/O is forbidden')
    return file
  }
  for (const name of ['existsSync', 'readdirSync', 'readFileSync', 'openSync', 'writeFileSync', 'unlinkSync']) {
    const original = fs[name]
    t.mock.method(fs, name, (file, ...args) => original.call(fs, redirect(file), ...args))
  }
  for (const name of ['linkSync', 'renameSync']) {
    const original = fs[name]
    t.mock.method(fs, name, (a, b, ...args) => original.call(fs, redirect(a), redirect(b), ...args))
  }
}
function denySensitiveOperations(t) {
  const counts = { writes: 0, loads: 0, network: 0 }
  const load = Module._load
  for (const name of ['openSync', 'mkdirSync', 'mkdtempSync', 'writeFileSync', 'renameSync', 'linkSync', 'unlinkSync']) t.mock.method(fs, name, () => { counts.writes++; throw new Error('No writes on denial') })
  t.mock.method(Module, '_load', function (name, ...rest) {
    if (['electron', 'esbuild', './build-cli.cjs'].includes(name)) { counts.loads++; throw new Error('No runtime, build or credentials on denial') }
    return load.call(this, name, ...rest)
  })
  for (const transport of [http, https]) t.mock.method(transport, 'request', () => { counts.network++; throw new Error('No egress') })
  t.mock.method(console, 'error', () => undefined)
  return counts
}
before(async () => {
  suite = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-r5-preflight-'))
  helpers = await subject.accountingHelpers(path.join(suite, 'accounting'))
  profile = JSON.parse(fs.readFileSync(path.join(subject.ROOT, 'scripts/eval-prices-deepseek-flash-20261003.json'), 'utf8'))
})
after(() => {
  assert.equal(path.dirname(suite), os.tmpdir())
  assert.ok(path.basename(suite).startsWith('deepwriter-r5-preflight-'))
  fs.rmSync(suite, { recursive: true, force: true })
})

test('R5 exact namespace keeps the original task/13 answers and original shared lock/¥5/80 ledger', () => {
  assert.equal(subject.FIFTH_DIRECTORY, path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r5'))
  const first = subject.assessmentPaths(), fifth = subject.assessmentPaths(subject.FIFTH_DIRECTORY)
  assert.equal(fifth.budgetFile, first.budgetFile); assert.equal(fifth.lockFile, first.lockFile)
  assert.notEqual(fifth.directory, subject.FOURTH_DIRECTORY)
  assert.throws(() => subject.assessmentPaths(subject.FIFTH_DIRECTORY + '-other'))
  assert.throws(() => subject.assessmentPaths(path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r15')))
  assert.equal(subject.sha(subject.TASK), '1fa1c33430cf728f39b816e5598720fd047ae8f0ccdb65610f3c3c14b676fd37')
  assert.equal(subject.sha(JSON.stringify(subject.ANSWERS)), 'f020acdcfb63463e608b5ae2024bf7333aaad42c3ecdda44f656dd31050f8070')
  assert.equal(Object.keys(subject.ANSWERS).length, 13); assert.equal(Object.isFrozen(subject.ANSWERS), true)
})

test('R5 fresh independent receipt cannot transplant R4, change prices or extend stale/peak/source/hash validity', () => {
  const valid = priceEvidence()
  assert.equal(subject.verifyPriceVerification({ directory: subject.FIFTH_DIRECTORY, ...valid.verification, at: AT }).receiptSha256, valid.verification.expectedSha256)
  const r4 = priceEvidence('r4')
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.FIFTH_DIRECTORY, expectedSha256: r4.verification.expectedSha256, at: AT, read: file => file.endsWith('price-verification.json') ? r4.bytes : r4.source }), /identity/)
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.FOURTH_DIRECTORY, expectedSha256: valid.verification.expectedSha256, at: AT, read: file => file.endsWith('price-verification.json') ? valid.bytes : valid.source }), /identity/)
  for (const change of [r => { r.assessment = 'r6' }, r => { r.purpose = 'new_money' }, r => { r.entry.outputPer1M = 8 }, r => { r.entry.inputPer1M = 2 }, r => { r.entry.cacheHitPer1M = 0.04 }, r => { r.expiresAt = new Date(AT).toISOString() }]) {
    const bad = priceEvidence('r5', AT, change)
    assert.throws(() => subject.verifyPriceVerification({ directory: subject.FIFTH_DIRECTORY, ...bad.verification, at: AT }))
  }
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.FIFTH_DIRECTORY, ...valid.verification, expectedSha256: '0'.repeat(64), at: AT }))
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.FIFTH_DIRECTORY, ...valid.verification, at: AT + subject.PRICE_WINDOW_MS }))
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.FIFTH_DIRECTORY, ...valid.verification, read: file => file.endsWith('price-verification-source.html') ? Buffer.from('changed') : valid.bytes, at: AT }))
})

test('R5 requires original ledger and explicit pin; failed/pending attempts remain charged with unchanged start/auth', () => {
  const f = fixture('prior-failed-pending')
  const failed = f.old.reserve(body()); f.old.settle(failed, null, 'http_error')
  const pending = f.old.reserve(body()), prior = f.old.snapshot()
  const ledger = subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers, phase: 'outline', directory: subject.FIFTH_DIRECTORY, priceVerification: f.evidence.verification, now: () => AT })
  const state = ledger.snapshot()
  assert.equal(state.startedAt, prior.startedAt); assert.equal(state.authorizationHash, prior.authorizationHash)
  assert.deepEqual(state.authorization, prior.authorization); assert.equal(state.requestsUsed, 2); assert.equal(state.cumulativeRequests, 32)
  assert.deepEqual(state.attempts[0], prior.attempts[0]); assert.equal(state.attempts[1].id, pending)
  assert.equal(state.attempts[1].outcome, 'previous_process_unsettled'); assert.equal(state.attempts[1].chargedUpperMicros, prior.attempts[1].reservedMicros)
  assert.equal(state.inflightReservedMicros, 0); assert.equal(state.spentUpperMicros, prior.spentUpperMicros + prior.inflightReservedMicros)
  const absent = path.join(f.directory, 'absent-ledger.json')
  assert.throws(() => subject.createLedger({ file: absent, authorization: f.auth, profile, helpers, phase: 'outline', directory: subject.FIFTH_DIRECTORY, priceVerification: f.evidence.verification, now: () => AT }), /cannot create/)
  assert.equal(fs.existsSync(absent), false)
  assert.throws(() => subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers, phase: 'outline', directory: subject.FIFTH_DIRECTORY, now: () => AT }), /hash-pinned/)
})

test('R5 per-attempt pin/source/time/ledger checks and unchanged ¥5/80 caps deny before any egress', () => {
  const f = fixture('egress-fences'), before = fs.readFileSync(f.file, 'utf8')
  let at = AT, changed = ''
  const read = file => changed && file.endsWith(changed) ? Buffer.from('changed') : f.evidence.verification.read(file)
  const ledger = subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers, phase: 'write', directory: subject.FIFTH_DIRECTORY, priceVerification: { ...f.evidence.verification, read }, now: () => at })
  for (changed of ['price-verification.json', 'price-verification-source.html']) assert.throws(() => ledger.reserve(body()))
  changed = ''; at += subject.PRICE_WINDOW_MS; assert.throws(() => ledger.reserve(body())); at = AT
  fs.writeFileSync(f.file, JSON.stringify({ ...JSON.parse(before), requestsUsed: 999 })); assert.throws(() => ledger.reserve(body()), /ledger changed/); fs.writeFileSync(f.file, before)
  assert.equal(ledger.snapshot().requestsUsed, 0); assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  const cap = fixture('owner-cap', { previousSpentUpperCny: 4.999999, maxCostCny: 0.000001 })
  assert.throws(() => cap.ledger.reserve(body()), /financial cap/); assert.equal(cap.ledger.snapshot().cumulativeSpentUpperCny, 4.999999)
  const guard = fixture('request-cap', { previousRequests: 79, maxRequests: 1 })
  const id = guard.ledger.reserve(body()); guard.ledger.settle(id, { prompt_tokens: 100, completion_tokens: 100 }, 'success')
  assert.throws(() => guard.ledger.reserve(body()), /request guard/); assert.equal(guard.ledger.snapshot().cumulativeRequests, 80)
})

test('R5 exclusive marker follows original shared-lock/price/prepared/ledger validation and survives failure without retry', async t => {
  const f = fixture('one-shot'), before = fs.readFileSync(f.file, 'utf8')
  redirectPaidPaths(t, f)
  try {
    const attempt = subject.claimR5OutlineAttempt({ directory: subject.FIFTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger, now: () => AT })
    assert.equal(attempt.assessment, 'r5'); assert.equal(attempt.outlineRevision, 1); assert.equal(attempt.taskHash, subject.sha(subject.TASK))
    assert.equal(attempt.bundleSha256, f.prepared.bundleSha256); assert.equal(attempt.buildReceiptSha256, f.prepared.buildReceiptSha256)
    assert.equal(attempt.authorizationHash, f.ledger.snapshot().authorizationHash); assert.equal(attempt.financialStartedAt, f.ledger.snapshot().startedAt)
    const marker = fs.readFileSync(path.join(subject.FIFTH_DIRECTORY, 'outline-attempt.json'))
    // Model failure/interruption after the claim cannot turn this into an
    // unrecorded new outline, even if no DB or outline record was produced.
    assert.throws(() => subject.claimR5OutlineAttempt({ directory: subject.FIFTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger, now: () => AT }), /already exists/)
    await assert.rejects(subject.prepare({ directory: subject.FIFTH_DIRECTORY }), /already exists/)
    assert.deepEqual(fs.readFileSync(path.join(subject.FIFTH_DIRECTORY, 'outline-attempt.json')), marker)
    assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(f.ledger.snapshot().requestsUsed, 0)
  } finally { t.mock.restoreAll() }
})

test('R5 marker rejects wrong lock, unpinned prepared identity, stale price and changed original ledger without creating evidence', t => {
  for (const [index, kind] of ['pid', 'phase', 'bundle', 'receipt', 'authorization', 'ledger', 'price'].entries()) {
    const f = fixture('marker-denial-' + index), original = fs.readFileSync(f.file, 'utf8')
    let prepared = f.prepared, ledger = f.ledger
    if (kind === 'pid') fs.writeFileSync(f.lock, JSON.stringify({ pid: -1, phase: 'outline' }))
    if (kind === 'phase') fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid, phase: 'write' }))
    if (kind === 'bundle') prepared = { ...prepared, bundleSha256: '' }
    if (kind === 'receipt') prepared = { ...prepared, buildReceiptSha256: '' }
    if (kind === 'authorization') prepared = { ...prepared, authorization: { ...f.auth, maxRequests: 80 } }
    if (kind === 'ledger') fs.writeFileSync(f.file, JSON.stringify({ ...JSON.parse(original), requestsUsed: 999 }))
    if (kind === 'price') ledger = { snapshot: () => f.ledger.snapshot(), assertWindow: () => { throw new Error('Synthetic fresh price expired') } }
    redirectPaidPaths(t, f)
    try {
      assert.throws(() => subject.claimR5OutlineAttempt({ directory: subject.FIFTH_DIRECTORY, prepared, ledger, now: () => AT }))
      assert.equal(fs.existsSync(path.join(subject.FIFTH_DIRECTORY, 'outline-attempt.json')), false)
      assert.equal(f.ledger.snapshot().requestsUsed, 0)
    } finally { t.mock.restoreAll() }
  }
})

test('R5 preflight refuses every paid-state/marker/revision sentinel before reads, writes, builds, credentials or network', async t => {
  for (const sentinel of ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json', 'outline-revision-3.json']) {
    try {
      t.mock.method(fs, 'existsSync', file => sentinel === 'outline-revision-3.json' ? file === subject.FIFTH_DIRECTORY : file === path.join(subject.FIFTH_DIRECTORY, sentinel))
      t.mock.method(fs, 'readdirSync', file => { assert.equal(file, subject.FIFTH_DIRECTORY); return [sentinel] })
      t.mock.method(fs, 'readFileSync', () => { throw new Error('Paid-state refusal must precede every read') })
      const counts = denySensitiveOperations(t)
      assert.equal(await subject.main(['--preflight', '--assessment=r5']), 2)
      assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
    } finally { t.mock.restoreAll() }
  }
})

test('R5 reoutline/revision flags, duplicate or foreign flags fail before any paid IO or egress', async t => {
  const pin = '--price-verification-sha256=' + 'a'.repeat(64), base = ['--real', '--assessment=r5', '--phase=outline', pin]
  const cases = [
    base.map(arg => arg === '--phase=outline' ? '--phase=reoutline' : arg),
    [...base, '--outline-revision=2'], [...base, '--approved-outline-hash=' + '1'.repeat(16)],
    [...base, '--phase=outline'], [...base, '--assessment=r5'], [...base, pin], [...base, '--unknown=1'], [...base, '--real'],
    ['--real', '--assessment=r5', '--phase=write', pin],
    ['--real', '--assessment=r5', '--phase=write', '--outline-revision=2', '--approved-outline-hash=' + '1'.repeat(16), pin],
    ['--real', '--assessment=r5-other', '--phase=outline', pin],
    ['--preflight', '--preflight', '--assessment=r5'], ['--preflight', '--build-cli', '--build-cli', '--assessment=r5']
  ]
  try {
    t.mock.method(fs, 'existsSync', () => { throw new Error('Invalid flags must precede IO') })
    t.mock.method(fs, 'readFileSync', () => { throw new Error('Invalid flags must precede IO') })
    const counts = denySensitiveOperations(t)
    for (const args of cases) assert.equal(await subject.main(args), 2)
    await assert.rejects(subject.reoutlinePhase({ directory: subject.FIFTH_DIRECTORY, bundle: 'unused', relay: {}, command: async () => { throw new Error('No CLI') } }), /never permits/)
    await assert.rejects(subject.writePhase({ directory: subject.FIFTH_DIRECTORY, bundle: 'unused', outlineRevision: 2, relay: {}, command: async () => { throw new Error('No CLI') } }), /revision1/)
    assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
  } finally { t.mock.restoreAll() }
})

test('R5 real launcher requires its fresh pin and original ledger before prepared build/runtime/key/CLI', async t => {
  const evidence = priceEvidence(), args = ['--real', '--assessment=r5', '--phase=outline', '--price-verification-sha256=' + evidence.verification.expectedSha256]
  for (const [index, command] of [args.filter(arg => !arg.startsWith('--price-verification')), args].entries()) {
    const reads = [], probes = []
    try {
      t.mock.method(Date, 'now', () => AT)
      t.mock.method(fs, 'readFileSync', file => { reads.push(file); return evidence.verification.read(file) })
      t.mock.method(fs, 'existsSync', file => { probes.push(file); return false })
      const counts = denySensitiveOperations(t)
      assert.equal(await subject.main(command), 2)
      assert.equal(reads.length, index === 0 ? 0 : 2)
      assert.deepEqual(probes, index === 0 ? [] : [subject.assessmentPaths().budgetFile])
      assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
    } finally { t.mock.restoreAll() }
  }
})

test('R5 real outline rejects existing marker/DB/approval/result/revision before build/key/CLI', async t => {
  const evidence = priceEvidence()
  for (const sentinel of ['outline-attempt.json', 'data/deepwriter.sqlite', 'explicit-outline-approval.json', 'write-result.json', 'reoutline-attempt.json', 'outline-revision-2.json']) {
    try {
      const reads = []
      t.mock.method(Date, 'now', () => AT)
      t.mock.method(fs, 'existsSync', file => file === subject.assessmentPaths().budgetFile || file === path.join(subject.FIFTH_DIRECTORY, sentinel))
      t.mock.method(fs, 'readFileSync', file => { reads.push(file); return evidence.verification.read(file) })
      const counts = denySensitiveOperations(t)
      assert.equal(await subject.main(['--real', '--assessment=r5', '--phase=outline', '--price-verification-sha256=' + evidence.verification.expectedSha256]), 2)
      assert.equal(reads.length, 2); assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
    } finally { t.mock.restoreAll() }
  }
})

test('R5 write requires exact original root hash/durable identity, permits no replay and never consumes outline marker again', async t => {
  const f = fixture('ordinary-write'), bundle = path.join(f.directory, 'synthetic-unbuilt-bundle.cjs'), calls = []
  fs.writeFileSync(bundle, 'SYNTHETIC bundle bytes, never executable')
  const state = { stateId: 'synthetic-state', sessionId: 'synthetic-session', originalTask: subject.TASK, targetChars: 8000, status: 'awaiting_outline_confirmation', outlineRevision: 1, outlineHash: '1'.repeat(16), approvedOutline: null, assumptions: [],
    slots: Object.entries(subject.ANSWERS).map(([id, answer]) => ({ id, label: id, required: true, answer, source: 'user' })), answers: Object.values(subject.ANSWERS).map((value, index) => ({ questionId: 'q' + index, value, source: 'user', decision: 'answer' })), outline: { title: 'SYNTHETIC original outline', targetChars: 8000, sections: [] } }
  const outline = { schemaVersion: 1, taskHash: subject.sha(subject.TASK), bundleSha256: subject.sha(fs.readFileSync(bundle)), sessionId: state.sessionId, outlineHash: state.outlineHash, state, approval: 'pending_explicit_root_confirmation' }
  fs.writeFileSync(path.join(f.r5, 'outline.json'), JSON.stringify(outline))
  fs.writeFileSync(path.join(f.r5, 'outline-attempt.json'), 'SYNTHETIC consumed original marker')
  const command = async (_, args) => {
    calls.push(args)
    if (args[0] === 'status') return { code: 0, events: [{ type: 'state', data: state }] }
    if (args[0] === 'list') return { code: 0, events: [{ type: 'list', data: { runs: [], sessions: [{ session_id: state.sessionId }] } }] }
    assert.equal(args[0], 'confirm'); assert.equal(args[3], state.outlineHash)
    return { code: 2, stderr: 'SYNTHETIC interruption: no prose or completed artifact', events: [] }
  }
  redirectPaidPaths(t, f)
  try {
    await assert.rejects(subject.writePhase({ directory: subject.FIFTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: '2'.repeat(16) }), /exact saved/)
    assert.equal(calls.length, 0)
    const marker = fs.readFileSync(path.join(subject.FIFTH_DIRECTORY, 'outline-attempt.json'))
    const result = await subject.writePhase({ directory: subject.FIFTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: state.outlineHash })
    assert.equal(result.status, 'incomplete'); assert.deepEqual(calls.map(args => args[0]), ['status', 'list', 'confirm'])
    assert.deepEqual(fs.readFileSync(path.join(subject.FIFTH_DIRECTORY, 'outline-attempt.json')), marker)
    const approval = JSON.parse(fs.readFileSync(path.join(subject.FIFTH_DIRECTORY, 'explicit-outline-approval.json')))
    assert.equal(approval.outlineRevision, 1); assert.equal(approval.actor, 'root_explicit_hash_command')
    const count = calls.length
    await assert.rejects(subject.writePhase({ directory: subject.FIFTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: state.outlineHash }), /replay/)
    assert.equal(calls.length, count); assert.equal(f.ledger.snapshot().requestsUsed, 0)
  } finally { t.mock.restoreAll() }
})

test('prepared source/receipt identity remains mandatory before R5 and marker hook precedes credentials/CLI', () => {
  const f = fixture('prepared-source'), root = path.join(f.directory, 'source'), directory = path.join(f.directory, 'prepared')
  const files = new Map([['package.json', JSON.stringify({ version: '1.3.1' })], ['package-lock.json', JSON.stringify({ version: '1.3.1', packages: { '': { version: '1.3.1' } } })], ['src/cli/build.mjs', 'SYNTHETIC builder'], ['src/cli/main.ts', 'SYNTHETIC source']])
  for (const [name, content] of files) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content) }
  fs.mkdirSync(path.join(directory, 'build'), { recursive: true })
  const bundle = 'SYNTHETIC unbuilt bytes', receipt = { application: { name: 'deepwriter-cli', version: '1.3.1' }, source: { packageSha256: subject.sha(files.get('package.json')), lockSha256: subject.sha(files.get('package-lock.json')) }, buildPolicy: { entrypoint: 'src/cli/main.ts', implementation: 'src/cli/build.mjs', implementationSha256: subject.sha(files.get('src/cli/build.mjs')), platform: 'node', format: 'cjs', target: 'node22' }, inputs: [{ name: 'src/cli/main.ts', sha256: subject.sha(files.get('src/cli/main.ts')) }] }
  const bytes = JSON.stringify(receipt)
  fs.writeFileSync(path.join(directory, 'build/deepwriter.cjs'), bundle); fs.writeFileSync(path.join(directory, 'build/cli-build.json'), bytes)
  fs.writeFileSync(path.join(directory, 'preflight.json'), JSON.stringify({ bundleSha256: subject.sha(bundle), buildReceiptSha256: subject.sha(bytes) }))
  assert.equal(subject.verifyPreparedBuild({ root, directory }).receipt.inputs.length, 1)
  fs.writeFileSync(path.join(root, 'src/cli/main.ts'), 'SYNTHETIC source changed')
  assert.throws(() => subject.verifyPreparedBuild({ root, directory }), /source changed/)
  const source = fs.readFileSync(path.join(subject.ROOT, 'scripts/authorized-cli-quality.cjs'), 'utf8')
  const start = source.indexOf('async function realPhase('), claim = source.indexOf('claimR5OutlineAttempt({ directory, prepared, ledger })', start)
  assert.ok(claim > source.indexOf('const ledger = createLedger(', start))
  assert.ok(claim < source.indexOf('const settings = json(sourceSettings)', start))
  assert.ok(claim < source.indexOf("phase === 'outline' ? await outlinePhase", start))
})
