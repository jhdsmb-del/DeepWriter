'use strict'

// R6–R14 are fixed namespaces; R11/R12/R13/R14 reuse the original explicit supplemental request authorization.
// Accounting ports below are explicit synthetic TEMP-only mocks; no builds.
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
function priceEvidence(assessment = 'r6', at = AT, mutate = () => undefined) {
  const directory = assessment === 'r4' ? subject.FOURTH_DIRECTORY : assessment === 'r5' ? subject.FIFTH_DIRECTORY : assessment === 'r7' ? subject.SEVENTH_DIRECTORY : assessment === 'r8' ? subject.EIGHTH_DIRECTORY : assessment === 'r9' ? subject.NINTH_DIRECTORY : assessment === 'r10' ? subject.TENTH_DIRECTORY : assessment === 'r11' ? subject.ELEVENTH_DIRECTORY : assessment === 'r12' ? subject.TWELFTH_DIRECTORY : assessment === 'r13' ? subject.THIRTEENTH_DIRECTORY : assessment === 'r14' ? subject.FOURTEENTH_DIRECTORY : subject.SIXTH_DIRECTORY
  const source = Buffer.from('<html>SYNTHETIC R6 equivalent price only, not official evidence</html>')
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
function fixture(id, overrides = {}, assessment = 'r6') {
  const directory = path.join(suite, id), r6 = path.join(directory, assessment), file = path.join(directory, 'ledger.json'), lock = path.join(directory, 'shared.lock')
  fs.mkdirSync(r6, { recursive: true })
  const auth = { ...authorization, ...overrides }
  const old = subject.createLedger({ file, authorization: auth, profile, helpers, phase: 'SYNTHETIC existing original ledger', now: () => AT })
  const evidence = priceEvidence(assessment)
  const ledger = subject.createLedger({ file, authorization: auth, profile, helpers, phase: 'outline', directory: evidence.directory, priceVerification: evidence.verification, now: () => AT })
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, phase: 'outline' }))
  const prepared = { authorization: auth, bundleSha256: 'b'.repeat(64), buildReceiptSha256: 'c'.repeat(64) }
  return { directory, r6, file, lock, old, ledger, evidence, auth, prepared }
}
function redirectPaidPaths(t, f, assessmentDirectory = subject.SIXTH_DIRECTORY) {
  const paths = subject.assessmentPaths(assessmentDirectory)
  const redirect = file => {
    if (typeof file !== 'string') return file
    if (file === paths.budgetFile) return f.file
    if (file === paths.lockFile) return f.lock
    if (file === assessmentDirectory || file.startsWith(assessmentDirectory + path.sep)) return path.join(f.r6, path.relative(assessmentDirectory, file))
    if ([subject.DIRECTORY, subject.SECOND_DIRECTORY, subject.THIRD_DIRECTORY, subject.FOURTH_DIRECTORY, subject.FIFTH_DIRECTORY, subject.SIXTH_DIRECTORY, subject.SEVENTH_DIRECTORY, subject.EIGHTH_DIRECTORY, subject.NINTH_DIRECTORY, subject.TENTH_DIRECTORY, subject.ELEVENTH_DIRECTORY, subject.TWELFTH_DIRECTORY, subject.THIRTEENTH_DIRECTORY, subject.FOURTEENTH_DIRECTORY].some(root => file === root || file.startsWith(root + path.sep))) throw new Error('Existing paid namespace I/O is forbidden')
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
before(() => {
  suite = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-r6-preflight-'))
  // Explicit TEMP-only accounting mocks. No esbuild/accounting bundle, real
  // price receipt, paid authorization or remote request is produced here.
  profile = { updatedAt: subject.DATE, providerId: 'deepseek', currency: 'CNY', unit: 'per-1M-tokens', syntheticFixture: true }
  helpers = {
    priceProfileValidate: candidate => ({ ok: candidate === profile }),
    priceProfileHash: candidate => candidate === profile ? subject.PRICE_HASH : 'SYNTHETIC_INVALID',
    matchPriceEntry: (candidate, model, origin, currency) => ({ ok: candidate === profile && model === subject.MODEL && origin === subject.ORIGIN && currency === 'CNY', entry: { inputPer1M: 1, outputPer1M: 4, cacheHitPer1M: 0.02 } }),
    utf8BodyTokenCeiling: value => ({ bytes: Buffer.byteLength(value), ceiling: Buffer.byteLength(value) + 64 }),
    computeSampleCost: usage => { const upper = (usage.prompt_tokens + usage.completion_tokens * 4) / 1e6; return { actualKnown: true, upper, total: upper } }
  }
})
after(() => {
  assert.equal(path.dirname(suite), os.tmpdir())
  assert.ok(path.basename(suite).startsWith('deepwriter-r6-preflight-'))
  fs.rmSync(suite, { recursive: true, force: true })
})

test('R6 exact namespace keeps the original task/13 answers and original shared lock/¥5/80 ledger', () => {
  assert.equal(subject.SIXTH_DIRECTORY, path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r6'))
  const first = subject.assessmentPaths(), fifth = subject.assessmentPaths(subject.SIXTH_DIRECTORY)
  assert.equal(fifth.budgetFile, first.budgetFile); assert.equal(fifth.lockFile, first.lockFile)
  assert.notEqual(fifth.directory, subject.FIFTH_DIRECTORY)
  assert.throws(() => subject.assessmentPaths(subject.SIXTH_DIRECTORY + '-other'))
  assert.throws(() => subject.assessmentPaths(path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r15')))
  assert.equal(subject.sha(subject.TASK), '1fa1c33430cf728f39b816e5598720fd047ae8f0ccdb65610f3c3c14b676fd37')
  assert.equal(subject.sha(JSON.stringify(subject.ANSWERS)), 'f020acdcfb63463e608b5ae2024bf7333aaad42c3ecdda44f656dd31050f8070')
  assert.equal(Object.keys(subject.ANSWERS).length, 13); assert.equal(Object.isFrozen(subject.ANSWERS), true)
})

test('R6 fresh independent receipt cannot transplant R5, change prices or extend stale/peak/source/hash validity', () => {
  const valid = priceEvidence()
  assert.equal(subject.verifyPriceVerification({ directory: subject.SIXTH_DIRECTORY, ...valid.verification, at: AT }).receiptSha256, valid.verification.expectedSha256)
  const r4 = priceEvidence('r5')
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SIXTH_DIRECTORY, expectedSha256: r4.verification.expectedSha256, at: AT, read: file => file.endsWith('price-verification.json') ? r4.bytes : r4.source }), /identity/)
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.FIFTH_DIRECTORY, expectedSha256: valid.verification.expectedSha256, at: AT, read: file => file.endsWith('price-verification.json') ? valid.bytes : valid.source }), /identity/)
  for (const change of [r => { r.assessment = 'r7' }, r => { r.purpose = 'new_money' }, r => { r.entry.outputPer1M = 8 }, r => { r.entry.inputPer1M = 2 }, r => { r.entry.cacheHitPer1M = 0.04 }, r => { r.expiresAt = new Date(AT).toISOString() }]) {
    const bad = priceEvidence('r6', AT, change)
    assert.throws(() => subject.verifyPriceVerification({ directory: subject.SIXTH_DIRECTORY, ...bad.verification, at: AT }))
  }
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SIXTH_DIRECTORY, ...valid.verification, expectedSha256: '0'.repeat(64), at: AT }))
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SIXTH_DIRECTORY, ...valid.verification, at: AT + subject.PRICE_WINDOW_MS }))
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SIXTH_DIRECTORY, ...valid.verification, read: file => file.endsWith('price-verification-source.html') ? Buffer.from('changed') : valid.bytes, at: AT }))
})

test('R6 requires original ledger and explicit pin; failed/pending attempts remain charged with unchanged start/auth', () => {
  const f = fixture('prior-failed-pending')
  const failed = f.old.reserve(body()); f.old.settle(failed, null, 'http_error')
  const pending = f.old.reserve(body()), prior = f.old.snapshot()
  const ledger = subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers, phase: 'outline', directory: subject.SIXTH_DIRECTORY, priceVerification: f.evidence.verification, now: () => AT })
  const state = ledger.snapshot()
  assert.equal(state.startedAt, prior.startedAt); assert.equal(state.authorizationHash, prior.authorizationHash)
  assert.deepEqual(state.authorization, prior.authorization); assert.equal(state.requestsUsed, 2); assert.equal(state.cumulativeRequests, 32)
  assert.deepEqual(state.attempts[0], prior.attempts[0]); assert.equal(state.attempts[1].id, pending)
  assert.equal(state.attempts[1].outcome, 'previous_process_unsettled'); assert.equal(state.attempts[1].chargedUpperMicros, prior.attempts[1].reservedMicros)
  assert.equal(state.inflightReservedMicros, 0); assert.equal(state.spentUpperMicros, prior.spentUpperMicros + prior.inflightReservedMicros)
  const absent = path.join(f.directory, 'absent-ledger.json')
  assert.throws(() => subject.createLedger({ file: absent, authorization: f.auth, profile, helpers, phase: 'outline', directory: subject.SIXTH_DIRECTORY, priceVerification: f.evidence.verification, now: () => AT }), /cannot create/)
  assert.equal(fs.existsSync(absent), false)
  assert.throws(() => subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers, phase: 'outline', directory: subject.SIXTH_DIRECTORY, now: () => AT }), /hash-pinned/)
})

test('R6 per-attempt pin/source/time/ledger checks and unchanged ¥5/80 caps deny before any egress', () => {
  const f = fixture('egress-fences'), before = fs.readFileSync(f.file, 'utf8')
  let at = AT, changed = ''
  const read = file => changed && file.endsWith(changed) ? Buffer.from('changed') : f.evidence.verification.read(file)
  const ledger = subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers, phase: 'write', directory: subject.SIXTH_DIRECTORY, priceVerification: { ...f.evidence.verification, read }, now: () => at })
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

test('R6 exclusive marker follows original shared-lock/price/prepared/ledger validation and survives failure without retry', async t => {
  const f = fixture('one-shot'), before = fs.readFileSync(f.file, 'utf8')
  redirectPaidPaths(t, f)
  try {
    const attempt = subject.claimR6OutlineAttempt({ directory: subject.SIXTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger, now: () => AT })
    assert.equal(attempt.assessment, 'r6'); assert.equal(attempt.outlineRevision, 1); assert.equal(attempt.taskHash, subject.sha(subject.TASK))
    assert.equal(attempt.bundleSha256, f.prepared.bundleSha256); assert.equal(attempt.buildReceiptSha256, f.prepared.buildReceiptSha256)
    assert.equal(attempt.authorizationHash, f.ledger.snapshot().authorizationHash); assert.equal(attempt.financialStartedAt, f.ledger.snapshot().startedAt)
    const marker = fs.readFileSync(path.join(subject.SIXTH_DIRECTORY, 'outline-attempt.json'))
    // Model failure/interruption after the claim cannot turn this into an
    // unrecorded new outline, even if no DB or outline record was produced.
    assert.throws(() => subject.claimR6OutlineAttempt({ directory: subject.SIXTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger, now: () => AT }), /already exists/)
    await assert.rejects(subject.prepare({ directory: subject.SIXTH_DIRECTORY }), /already exists/)
    assert.deepEqual(fs.readFileSync(path.join(subject.SIXTH_DIRECTORY, 'outline-attempt.json')), marker)
    assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(f.ledger.snapshot().requestsUsed, 0)
  } finally { t.mock.restoreAll() }
})

test('R6 marker rejects wrong lock, unpinned prepared identity, stale price and changed original ledger without creating evidence', t => {
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
      assert.throws(() => subject.claimR6OutlineAttempt({ directory: subject.SIXTH_DIRECTORY, prepared, ledger, now: () => AT }))
      assert.equal(fs.existsSync(path.join(subject.SIXTH_DIRECTORY, 'outline-attempt.json')), false)
      assert.equal(f.ledger.snapshot().requestsUsed, 0)
    } finally { t.mock.restoreAll() }
  }
})

test('R6 preflight refuses every paid-state/marker/revision sentinel before reads, writes, builds, credentials or network', async t => {
  for (const sentinel of ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json', 'outline-revision-3.json']) {
    try {
      t.mock.method(fs, 'existsSync', file => sentinel === 'outline-revision-3.json' ? file === subject.SIXTH_DIRECTORY : file === path.join(subject.SIXTH_DIRECTORY, sentinel))
      t.mock.method(fs, 'readdirSync', file => { assert.equal(file, subject.SIXTH_DIRECTORY); return [sentinel] })
      t.mock.method(fs, 'readFileSync', () => { throw new Error('Paid-state refusal must precede every read') })
      const counts = denySensitiveOperations(t)
      assert.equal(await subject.main(['--preflight', '--assessment=r6']), 2)
      assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
    } finally { t.mock.restoreAll() }
  }
})

test('R6 reoutline/revision flags, duplicate or foreign flags fail before any paid IO or egress', async t => {
  const pin = '--price-verification-sha256=' + 'a'.repeat(64), base = ['--real', '--assessment=r6', '--phase=outline', pin]
  const cases = [
    base.map(arg => arg === '--phase=outline' ? '--phase=reoutline' : arg),
    [...base, '--outline-revision=2'], [...base, '--approved-outline-hash=' + '1'.repeat(16)],
    [...base, '--phase=outline'], [...base, '--assessment=r6'], [...base, pin], [...base, '--unknown=1'], [...base, '--real'],
    [...base, '--continue'], [...base, '--resume'], [...base, '--replay'], [...base, '--outline-revision=3'],
    ['--real', '--assessment=r6', '--phase=write', pin],
    ['--real', '--assessment=r6', '--phase=write', '--outline-revision=2', '--approved-outline-hash=' + '1'.repeat(16), pin],
    ['--real', '--assessment=r6-other', '--phase=outline', pin],
    ['--preflight', '--preflight', '--assessment=r6'], ['--preflight', '--build-cli', '--build-cli', '--assessment=r6']
  ]
  try {
    t.mock.method(fs, 'existsSync', () => { throw new Error('Invalid flags must precede IO') })
    t.mock.method(fs, 'readFileSync', () => { throw new Error('Invalid flags must precede IO') })
    const counts = denySensitiveOperations(t)
    for (const args of cases) assert.equal(await subject.main(args), 2)
    await assert.rejects(subject.reoutlinePhase({ directory: subject.SIXTH_DIRECTORY, bundle: 'unused', relay: {}, command: async () => { throw new Error('No CLI') } }), /never permits/)
    await assert.rejects(subject.writePhase({ directory: subject.SIXTH_DIRECTORY, bundle: 'unused', outlineRevision: 2, relay: {}, command: async () => { throw new Error('No CLI') } }), /revision1/)
    assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
  } finally { t.mock.restoreAll() }
})

test('R6 real launcher requires its fresh pin and original ledger before prepared build/runtime/key/CLI', async t => {
  const evidence = priceEvidence(), args = ['--real', '--assessment=r6', '--phase=outline', '--price-verification-sha256=' + evidence.verification.expectedSha256]
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

test('R6 real outline rejects existing marker/DB/approval/result/revision before build/key/CLI', async t => {
  const evidence = priceEvidence()
  for (const sentinel of ['outline-attempt.json', 'data/deepwriter.sqlite', 'explicit-outline-approval.json', 'write-result.json', 'reoutline-attempt.json', 'outline-revision-2.json']) {
    try {
      const reads = []
      t.mock.method(Date, 'now', () => AT)
      t.mock.method(fs, 'existsSync', file => file === subject.assessmentPaths().budgetFile || file === path.join(subject.SIXTH_DIRECTORY, sentinel))
      t.mock.method(fs, 'readFileSync', file => { reads.push(file); return evidence.verification.read(file) })
      const counts = denySensitiveOperations(t)
      assert.equal(await subject.main(['--real', '--assessment=r6', '--phase=outline', '--price-verification-sha256=' + evidence.verification.expectedSha256]), 2)
      assert.equal(reads.length, 2); assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
    } finally { t.mock.restoreAll() }
  }
})

test('R6 write requires exact original root hash/durable identity, permits no replay and never consumes outline marker again', async t => {
  const f = fixture('ordinary-write'), bundle = path.join(f.directory, 'synthetic-unbuilt-bundle.cjs'), calls = []
  fs.writeFileSync(bundle, 'SYNTHETIC bundle bytes, never executable')
  const state = { stateId: 'synthetic-state', sessionId: 'synthetic-session', originalTask: subject.TASK, targetChars: 8000, status: 'awaiting_outline_confirmation', outlineRevision: 1, outlineHash: '1'.repeat(16), approvedOutline: null, assumptions: [],
    slots: Object.entries(subject.ANSWERS).map(([id, answer]) => ({ id, label: id, required: true, answer, source: 'user' })), answers: Object.values(subject.ANSWERS).map((value, index) => ({ questionId: 'q' + index, value, source: 'user', decision: 'answer' })), outline: { title: 'SYNTHETIC original outline', targetChars: 8000, sections: [] } }
  const outline = { schemaVersion: 1, taskHash: subject.sha(subject.TASK), bundleSha256: subject.sha(fs.readFileSync(bundle)), sessionId: state.sessionId, outlineHash: state.outlineHash, state, approval: 'pending_explicit_root_confirmation' }
  fs.writeFileSync(path.join(f.r6, 'outline.json'), JSON.stringify(outline))
  fs.writeFileSync(path.join(f.r6, 'outline-attempt.json'), 'SYNTHETIC consumed original marker')
  const command = async (_, args) => {
    calls.push(args)
    if (args[0] === 'status') return { code: 0, events: [{ type: 'state', data: state }] }
    if (args[0] === 'list') return { code: 0, events: [{ type: 'list', data: { runs: [], sessions: [{ session_id: state.sessionId }] } }] }
    assert.equal(args[0], 'confirm'); assert.equal(args[3], state.outlineHash)
    return { code: 2, stderr: 'SYNTHETIC interruption: no prose or completed artifact', events: [] }
  }
  redirectPaidPaths(t, f)
  try {
    await assert.rejects(subject.writePhase({ directory: subject.SIXTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: '2'.repeat(16) }), /exact saved/)
    assert.equal(calls.length, 0)
    const marker = fs.readFileSync(path.join(subject.SIXTH_DIRECTORY, 'outline-attempt.json'))
    const result = await subject.writePhase({ directory: subject.SIXTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: state.outlineHash })
    assert.equal(result.status, 'incomplete'); assert.deepEqual(calls.map(args => args[0]), ['status', 'list', 'confirm'])
    assert.deepEqual(fs.readFileSync(path.join(subject.SIXTH_DIRECTORY, 'outline-attempt.json')), marker)
    const approval = JSON.parse(fs.readFileSync(path.join(subject.SIXTH_DIRECTORY, 'explicit-outline-approval.json')))
    assert.equal(approval.outlineRevision, 1); assert.equal(approval.actor, 'root_explicit_hash_command')
    const count = calls.length
    await assert.rejects(subject.writePhase({ directory: subject.SIXTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: state.outlineHash }), /replay/)
    assert.equal(calls.length, count); assert.equal(f.ledger.snapshot().requestsUsed, 0)
  } finally { t.mock.restoreAll() }
})

test('prepared source/receipt identity remains mandatory before R6 and marker hook precedes credentials/CLI', () => {
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
  const start = source.indexOf('async function realPhase('), claim = source.indexOf('claimR6OutlineAttempt({ directory, prepared, ledger })', start)
  assert.ok(claim > source.indexOf('const ledger = createLedger(', start))
  assert.ok(claim < source.indexOf('const settings = json(sourceSettings)', start))
  assert.ok(claim < source.indexOf("phase === 'outline' ? await outlinePhase", start))
})

test('R5 original one-shot behavior and shared financial identity remain unchanged in TEMP', async t => {
  const f = fixture('legacy-r5-compatibility'), evidence = priceEvidence('r5')
  const originalBytes = fs.readFileSync(f.file)
  const original = f.old.snapshot()
  const ledger = subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers, phase: 'outline', directory: subject.FIFTH_DIRECTORY, priceVerification: evidence.verification, now: () => AT })
  assert.equal(ledger.snapshot().startedAt, original.startedAt)
  assert.equal(ledger.snapshot().authorizationHash, original.authorizationHash)
  assert.equal(ledger.snapshot().requestsUsed, original.requestsUsed)
  assert.equal(ledger.snapshot().spentUpperMicros, original.spentUpperMicros)
  redirectPaidPaths(t, f, subject.FIFTH_DIRECTORY)
  try {
    const marker = subject.claimR5OutlineAttempt({ directory: subject.FIFTH_DIRECTORY, prepared: f.prepared, ledger, now: () => AT })
    assert.equal(marker.assessment, 'r5'); assert.equal(marker.outlineRevision, 1)
    assert.equal(marker.financialStartedAt, original.startedAt)
    assert.throws(() => subject.claimR5OutlineAttempt({ directory: subject.FIFTH_DIRECTORY, prepared: f.prepared, ledger, now: () => AT }), /already exists/)
    await assert.rejects(subject.prepare({ directory: subject.FIFTH_DIRECTORY }), /already exists/)
    assert.throws(() => subject.claimR6OutlineAttempt({ directory: subject.FIFTH_DIRECTORY, prepared: f.prepared, ledger, now: () => AT }), /restricted/)
    assert.deepEqual(fs.readFileSync(f.file), originalBytes)
  } finally { t.mock.restoreAll() }
  const source = fs.readFileSync(path.join(subject.ROOT, 'scripts/authorized-cli-quality.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const definition = name => source.match(new RegExp(`function ${name}\\([\\s\\S]+?\\n}\\n`))[0]
  for (const name of ['assertFresh', 'claim']) {
    const suffix = name === 'assertFresh' ? 'Outline' : 'OutlineAttempt'
    const current = definition(`${name}R6${suffix}`).replaceAll('R6', 'R5').replaceAll("'r6'", "'r5'").replaceAll('SIXTH_DIRECTORY', 'FIFTH_DIRECTORY')
    assert.equal(current, definition(`${name}R5${suffix}`))
  }
})

test('R6 requires a clean-commit original receipt and rejects bundle/receipt/source hash drift without builds', t => {
  const f = fixture('clean-commit-receipt'), root = path.join(f.directory, 'source'), directory = f.r6
  const sourceFiles = new Map([['package.json', JSON.stringify({ version: '1.3.1' })], ['package-lock.json', JSON.stringify({ version: '1.3.1', packages: { '': { version: '1.3.1' } } })], ['src/cli/build.mjs', 'SYNTHETIC builder'], ['src/cli/main.ts', 'SYNTHETIC source']])
  for (const [name, content] of sourceFiles) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content) }
  fs.mkdirSync(path.join(directory, 'build'), { recursive: true })
  const bundle = 'SYNTHETIC unbuilt bytes, never executable'
  const baseline = { sourceCommit: 'e'.repeat(40), sourceDirty: false, application: { name: 'deepwriter-cli', version: '1.3.1' },
    source: { packageSha256: subject.sha(sourceFiles.get('package.json')), lockSha256: subject.sha(sourceFiles.get('package-lock.json')) },
    buildPolicy: { entrypoint: 'src/cli/main.ts', implementation: 'src/cli/build.mjs', implementationSha256: subject.sha(sourceFiles.get('src/cli/build.mjs')), platform: 'node', format: 'cjs', target: 'node22' },
    inputs: [{ name: 'src/cli/main.ts', sha256: subject.sha(sourceFiles.get('src/cli/main.ts')) }] }
  const save = (overrides = {}) => {
    const receipt = JSON.stringify({ ...baseline, ...overrides })
    fs.writeFileSync(path.join(directory, 'build/deepwriter.cjs'), bundle)
    fs.writeFileSync(path.join(directory, 'build/cli-build.json'), receipt)
    fs.writeFileSync(path.join(directory, 'preflight.json'), JSON.stringify({ bundleSha256: subject.sha(bundle), buildReceiptSha256: subject.sha(receipt) }))
  }
  save()
  redirectPaidPaths(t, f)
  try {
    const verify = () => subject.verifyPreparedBuild({ root, directory: subject.SIXTH_DIRECTORY })
    assert.equal(verify().receipt.sourceCommit, baseline.sourceCommit)
    for (const overrides of [{ sourceDirty: true }, { sourceDirty: undefined }, { sourceCommit: 'unknown' }, { sourceCommit: undefined }]) {
      save(overrides)
      assert.throws(verify, /frozen clean commit/)
    }
    save(); fs.writeFileSync(path.join(directory, 'build/deepwriter.cjs'), bundle + ' changed')
    assert.throws(verify, /coherent CLI/)
    save(); fs.writeFileSync(path.join(directory, 'build/cli-build.json'), JSON.stringify({ ...baseline, sourceCommit: 'f'.repeat(40) }))
    assert.throws(verify, /receipt is absent or changed/)
    save(); fs.writeFileSync(path.join(root, 'src/cli/main.ts'), 'SYNTHETIC changed source')
    assert.throws(verify, /source changed/)
    fs.writeFileSync(path.join(root, 'src/cli/main.ts'), sourceFiles.get('src/cli/main.ts'))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.3.2' }))
    assert.throws(verify, /Package\/lock identity changed/)
  } finally { t.mock.restoreAll() }
})

test('R6 outline result itself must be revision1 before any original outline record is published', async t => {
  const f = fixture('outline-revision-fence'), calls = []
  const command = async (_, args) => {
    calls.push(args)
    if (args[0] === 'write') return { code: 0, events: [{ type: 'state', data: { status: 'outline_ready', sessionId: 'SYNTHETIC-session', targetChars: 8000 } }] }
    assert.equal(args[0], 'outline')
    return { code: 0, events: [{ type: 'state', data: { status: 'awaiting_outline_confirmation', sessionId: 'SYNTHETIC-session', targetChars: 8000, outlineRevision: 2, outlineHash: '1'.repeat(16), approvedOutline: null } }] }
  }
  redirectPaidPaths(t, f)
  try {
    await assert.rejects(subject.outlinePhase({ directory: subject.SIXTH_DIRECTORY, bundle: 'SYNTHETIC never executed', relay: {}, command }), /original revision1/)
    assert.deepEqual(calls.map(args => args[0]), ['write', 'outline'])
    assert.equal(fs.existsSync(path.join(subject.SIXTH_DIRECTORY, 'outline.json')), false)
    assert.equal(f.ledger.snapshot().requestsUsed, 0)
  } finally { t.mock.restoreAll() }
})


test('R7 exact fixed leaf preserves the original task, answers, default review and original shared financial paths', () => {
  assert.equal(subject.SEVENTH_DIRECTORY, path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r7'))
  const first = subject.assessmentPaths(), seventh = subject.assessmentPaths(subject.SEVENTH_DIRECTORY)
  assert.equal(seventh.budgetFile, first.budgetFile); assert.equal(seventh.lockFile, first.lockFile)
  assert.notEqual(seventh.directory, subject.SIXTH_DIRECTORY)
  assert.throws(() => subject.assessmentPaths(subject.SEVENTH_DIRECTORY + '-other'))
  assert.throws(() => subject.assessmentPaths(path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r15')))
  assert.equal(subject.sha(subject.TASK), '1fa1c33430cf728f39b816e5598720fd047ae8f0ccdb65610f3c3c14b676fd37')
  assert.equal(subject.sha(JSON.stringify(subject.ANSWERS)), 'f020acdcfb63463e608b5ae2024bf7333aaad42c3ecdda44f656dd31050f8070')
  assert.equal(Object.keys(subject.ANSWERS).length, 13); assert.equal(Object.isFrozen(subject.ANSWERS), true)
})

test('R7 fresh price receipt cannot reuse R6 identity or change pinned original price/source/time', () => {
  const valid = priceEvidence('r7'), prior = priceEvidence('r6')
  assert.equal(subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, ...valid.verification, at: AT }).receiptSha256, valid.verification.expectedSha256)
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, expectedSha256: prior.verification.expectedSha256, at: AT, read: file => file.endsWith('price-verification.json') ? prior.bytes : prior.source }), /identity/)
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SIXTH_DIRECTORY, expectedSha256: valid.verification.expectedSha256, at: AT, read: file => file.endsWith('price-verification.json') ? valid.bytes : valid.source }), /identity/)
  for (const change of [r => { r.assessment = 'r6' }, r => { r.purpose = 'new_money' }, r => { r.entry.inputPer1M = 2 }, r => { r.entry.outputPer1M = 8 }, r => { r.entry.cacheHitPer1M = 0.04 }, r => { r.expiresAt = new Date(AT).toISOString() }]) {
    const bad = priceEvidence('r7', AT, change)
    assert.throws(() => subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, ...bad.verification, at: AT }))
  }
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, ...valid.verification, expectedSha256: '0'.repeat(64), at: AT }))
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, ...valid.verification, at: AT + subject.PRICE_WINDOW_MS }))
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, ...valid.verification, read: file => file.endsWith('.html') ? Buffer.from('changed') : valid.bytes, at: AT }))
})

test('R7 keeps failed/pending reservations charged and cannot refresh financial start/auth/caps or create a new ledger', () => {
  const f = fixture('r7-finance', {}, 'r7')
  const id = f.old.reserve(body()); f.old.settle(id, null, 'http_error')
  const pending = f.old.reserve(body()), original = f.old.snapshot()
  const ledger = subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers, phase: 'outline', directory: subject.SEVENTH_DIRECTORY, priceVerification: f.evidence.verification, now: () => AT })
  const state = ledger.snapshot()
  assert.equal(state.startedAt, original.startedAt); assert.equal(state.authorizationHash, original.authorizationHash)
  assert.deepEqual(state.authorization, original.authorization); assert.equal(state.requestsUsed, 2); assert.equal(state.cumulativeRequests, 32)
  assert.deepEqual(state.attempts[0], original.attempts[0]); assert.equal(state.attempts[1].id, pending)
  assert.equal(state.attempts[1].outcome, 'previous_process_unsettled'); assert.equal(state.attempts[1].chargedUpperMicros, original.attempts[1].reservedMicros)
  assert.equal(state.inflightReservedMicros, 0); assert.equal(state.spentUpperMicros, original.spentUpperMicros + original.inflightReservedMicros)
  const absent = path.join(f.directory, 'absent.json')
  assert.throws(() => subject.createLedger({ file: absent, authorization: f.auth, profile, helpers, phase: 'outline', directory: subject.SEVENTH_DIRECTORY, priceVerification: f.evidence.verification, now: () => AT }), /cannot create/)
  assert.equal(fs.existsSync(absent), false)
  assert.throws(() => subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers, phase: 'outline', directory: subject.SEVENTH_DIRECTORY, now: () => AT }), /hash-pinned/)
  const cap = fixture('r7-cap', { previousSpentUpperCny: 4.999999, maxCostCny: 0.000001 }, 'r7')
  assert.throws(() => cap.ledger.reserve(body()), /financial cap/)
  const guard = fixture('r7-request-guard', { previousRequests: 79, maxRequests: 1 }, 'r7')
  const last = guard.ledger.reserve(body()); guard.ledger.settle(last, { prompt_tokens: 100, completion_tokens: 100 }, 'success')
  assert.throws(() => guard.ledger.reserve(body()), /request guard/); assert.equal(guard.ledger.snapshot().cumulativeRequests, 80)
  const before = fs.readFileSync(f.file, 'utf8')
  fs.writeFileSync(f.file, JSON.stringify({ ...JSON.parse(before), requestsUsed: 999 }))
  assert.throws(() => ledger.reserve(body()), /ledger changed/)
  fs.writeFileSync(f.file, before)
})

test('R7 exclusive original-outline marker consumes only its own TEMP leaf after original lock/ledger validation and cannot retry or prepare', async t => {
  const f = fixture('r7-marker', {}, 'r7'), financialBytes = fs.readFileSync(f.file)
  redirectPaidPaths(t, f, subject.SEVENTH_DIRECTORY)
  try {
    assert.throws(() => subject.claimR6OutlineAttempt({ directory: subject.SEVENTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger }), /restricted/)
    fs.writeFileSync(f.lock, JSON.stringify({ pid: -1, phase: 'outline' }))
    assert.throws(() => subject.claimR7OutlineAttempt({ directory: subject.SEVENTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger }), /ownership/)
    fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid, phase: 'outline' }))
    for (const prepared of [{ ...f.prepared, bundleSha256: '' }, { ...f.prepared, buildReceiptSha256: '' }, { ...f.prepared, authorization: { ...f.auth, maxRequests: 80 } }]) {
      assert.throws(() => subject.claimR7OutlineAttempt({ directory: subject.SEVENTH_DIRECTORY, prepared, ledger: f.ledger }), /identity/)
      assert.equal(fs.existsSync(path.join(subject.SEVENTH_DIRECTORY, 'outline-attempt.json')), false)
    }
    const marker = subject.claimR7OutlineAttempt({ directory: subject.SEVENTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger, now: () => AT })
    assert.equal(marker.assessment, 'r7'); assert.equal(marker.outlineRevision, 1); assert.equal(marker.taskHash, subject.sha(subject.TASK))
    assert.equal(marker.authorizationHash, f.ledger.snapshot().authorizationHash); assert.equal(marker.financialStartedAt, f.ledger.snapshot().startedAt)
    assert.equal(marker.bundleSha256, f.prepared.bundleSha256); assert.equal(marker.buildReceiptSha256, f.prepared.buildReceiptSha256)
    const markerBytes = fs.readFileSync(path.join(subject.SEVENTH_DIRECTORY, 'outline-attempt.json'))
    assert.throws(() => subject.claimR7OutlineAttempt({ directory: subject.SEVENTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger }), /already exists/)
    await assert.rejects(subject.prepare({ directory: subject.SEVENTH_DIRECTORY }), /already exists/)
    assert.deepEqual(fs.readFileSync(path.join(subject.SEVENTH_DIRECTORY, 'outline-attempt.json')), markerBytes)
    assert.deepEqual(fs.readFileSync(f.file), financialBytes); assert.equal(f.ledger.snapshot().requestsUsed, 0)
  } finally { t.mock.restoreAll() }
})

test('R7 paid-state/outline2/foreign/duplicate/replay flags refuse before writes, runtime, credentials and egress', async t => {
  const pin = '--price-verification-sha256=' + 'a'.repeat(64), base = ['--real', '--assessment=r7', '--phase=outline', pin]
  const cases = [
    base.map(arg => arg === '--phase=outline' ? '--phase=reoutline' : arg),
    [...base, '--outline-revision=2'], [...base, '--approved-outline-hash=' + '1'.repeat(16)],
    [...base, '--phase=outline'], [...base, '--assessment=r7'], [...base, pin], [...base, '--unknown=1'], [...base, '--real'],
    [...base, '--continue'], [...base, '--resume'], [...base, '--replay'], [...base, '--outline-revision=3'],
    ['--real', '--assessment=r7', '--phase=write', pin],
    ['--real', '--assessment=r7', '--phase=write', '--outline-revision=2', '--approved-outline-hash=' + '1'.repeat(16), pin],
    ['--real', '--assessment=r7-other', '--phase=outline', pin],
    ['--preflight', '--preflight', '--assessment=r7'], ['--preflight', '--build-cli', '--build-cli', '--assessment=r7']
  ]
  try {
    t.mock.method(fs, 'existsSync', () => { throw new Error('Invalid flags precede IO') })
    t.mock.method(fs, 'readFileSync', () => { throw new Error('Invalid flags precede IO') })
    const counts = denySensitiveOperations(t)
    for (const args of cases) assert.equal(await subject.main(args), 2)
    await assert.rejects(subject.reoutlinePhase({ directory: subject.SEVENTH_DIRECTORY, bundle: 'unused', relay: {}, command: async () => { throw new Error('No CLI') } }), /never permits/)
    await assert.rejects(subject.writePhase({ directory: subject.SEVENTH_DIRECTORY, bundle: 'unused', outlineRevision: 2, relay: {}, command: async () => { throw new Error('No CLI') } }), /revision1/)
    assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
  } finally { t.mock.restoreAll() }
  for (const sentinel of ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json', 'outline-revision-3.json']) {
    try {
      t.mock.method(fs, 'existsSync', file => sentinel === 'outline-revision-3.json' ? file === subject.SEVENTH_DIRECTORY : file === path.join(subject.SEVENTH_DIRECTORY, sentinel))
      t.mock.method(fs, 'readdirSync', file => { assert.equal(file, subject.SEVENTH_DIRECTORY); return [sentinel] })
      t.mock.method(fs, 'readFileSync', () => { throw new Error('Existing paid state precedes every read') })
      const counts = denySensitiveOperations(t)
      assert.equal(await subject.main(['--preflight', '--assessment=r7']), 2)
      assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
    } finally { t.mock.restoreAll() }
  }
})

test('R7 real entry requires independent fresh pin/original ledger before build/key and does not touch R6 state', async t => {
  const evidence = priceEvidence('r7'), args = ['--real', '--assessment=r7', '--phase=outline', '--price-verification-sha256=' + evidence.verification.expectedSha256]
  for (const [index, command] of [args.filter(arg => !arg.startsWith('--price-verification')), args].entries()) {
    try {
      const reads = [], probes = []
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

test('R7 write uses only exact original durable root-approved hash, cannot replay and outline2 cannot publish', async t => {
  const f = fixture('r7-write', {}, 'r7'), bundle = path.join(f.directory, 'synthetic-unbuilt-bundle.cjs'), calls = []
  fs.writeFileSync(bundle, 'SYNTHETIC unbuilt bytes, never executable')
  const state = { stateId: 'synthetic-state', sessionId: 'synthetic-session', originalTask: subject.TASK, targetChars: 8000, status: 'awaiting_outline_confirmation', outlineRevision: 1, outlineHash: '1'.repeat(16), approvedOutline: null, assumptions: [],
    slots: Object.entries(subject.ANSWERS).map(([id, answer]) => ({ id, label: id, required: true, answer, source: 'user' })), answers: Object.values(subject.ANSWERS).map((value, index) => ({ questionId: 'q' + index, value, source: 'user', decision: 'answer' })), outline: { title: 'SYNTHETIC original outline', targetChars: 8000, sections: [] } }
  const outline = { schemaVersion: 1, taskHash: subject.sha(subject.TASK), bundleSha256: subject.sha(fs.readFileSync(bundle)), sessionId: state.sessionId, outlineHash: state.outlineHash, state, approval: 'pending_explicit_root_confirmation' }
  fs.writeFileSync(path.join(f.r6, 'outline.json'), JSON.stringify(outline))
  fs.writeFileSync(path.join(f.r6, 'outline-attempt.json'), 'SYNTHETIC consumed R7 marker')
  const command = async (_, args) => {
    calls.push(args)
    if (args[0] === 'status') return { code: 0, events: [{ type: 'state', data: state }] }
    if (args[0] === 'list') return { code: 0, events: [{ type: 'list', data: { runs: [], sessions: [{ session_id: state.sessionId }] } }] }
    assert.equal(args[0], 'confirm'); assert.equal(args[3], state.outlineHash)
    return { code: 2, stderr: 'SYNTHETIC interruption: no prose or completed artifact', events: [] }
  }
  redirectPaidPaths(t, f, subject.SEVENTH_DIRECTORY)
  try {
    await assert.rejects(subject.writePhase({ directory: subject.SEVENTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: '2'.repeat(16) }), /exact saved/)
    assert.equal(calls.length, 0)
    const marker = fs.readFileSync(path.join(subject.SEVENTH_DIRECTORY, 'outline-attempt.json'))
    const result = await subject.writePhase({ directory: subject.SEVENTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: state.outlineHash })
    assert.equal(result.status, 'incomplete'); assert.deepEqual(calls.map(args => args[0]), ['status', 'list', 'confirm'])
    assert.deepEqual(fs.readFileSync(path.join(subject.SEVENTH_DIRECTORY, 'outline-attempt.json')), marker)
    assert.equal(JSON.parse(fs.readFileSync(path.join(subject.SEVENTH_DIRECTORY, 'explicit-outline-approval.json'))).outlineRevision, 1)
    const count = calls.length
    await assert.rejects(subject.writePhase({ directory: subject.SEVENTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: state.outlineHash }), /replay/)
    assert.equal(calls.length, count); assert.equal(f.ledger.snapshot().requestsUsed, 0)
  } finally { t.mock.restoreAll() }
  const revision = fixture('r7-result-revision', {}, 'r7')
  const outlineCommand = async (_, args) => ({ code: 0, events: [{ type: 'state', data: args[0] === 'write' ? { status: 'outline_ready', sessionId: 'SYNTHETIC-session' } : { status: 'awaiting_outline_confirmation', sessionId: 'SYNTHETIC-session', targetChars: 8000, outlineRevision: 2, outlineHash: '1'.repeat(16), approvedOutline: null } }] })
  redirectPaidPaths(t, revision, subject.SEVENTH_DIRECTORY)
  try {
    await assert.rejects(subject.outlinePhase({ directory: subject.SEVENTH_DIRECTORY, bundle: 'SYNTHETIC never executed', relay: {}, command: outlineCommand }), /original revision1/)
    assert.equal(fs.existsSync(path.join(subject.SEVENTH_DIRECTORY, 'outline.json')), false)
  } finally { t.mock.restoreAll() }
})

test('R7 original clean-commit receipt denies source/bundle/hash/dirty drift without actual build', t => {
  const f = fixture('r7-build-receipt', {}, 'r7'), root = path.join(f.directory, 'source'), directory = f.r6
  const sourceFiles = new Map([['package.json', JSON.stringify({ version: '1.3.1' })], ['package-lock.json', JSON.stringify({ version: '1.3.1', packages: { '': { version: '1.3.1' } } })], ['src/cli/build.mjs', 'SYNTHETIC builder'], ['src/cli/main.ts', 'SYNTHETIC source']])
  for (const [name, content] of sourceFiles) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content) }
  fs.mkdirSync(path.join(directory, 'build'), { recursive: true })
  const bundle = 'SYNTHETIC never executable'
  const baseline = { sourceCommit: 'e'.repeat(40), sourceDirty: false, application: { name: 'deepwriter-cli', version: '1.3.1' }, source: { packageSha256: subject.sha(sourceFiles.get('package.json')), lockSha256: subject.sha(sourceFiles.get('package-lock.json')) },
    buildPolicy: { entrypoint: 'src/cli/main.ts', implementation: 'src/cli/build.mjs', implementationSha256: subject.sha(sourceFiles.get('src/cli/build.mjs')), platform: 'node', format: 'cjs', target: 'node22' }, inputs: [{ name: 'src/cli/main.ts', sha256: subject.sha(sourceFiles.get('src/cli/main.ts')) }] }
  const save = (overrides = {}) => {
    const receipt = JSON.stringify({ ...baseline, ...overrides })
    fs.writeFileSync(path.join(directory, 'build/deepwriter.cjs'), bundle); fs.writeFileSync(path.join(directory, 'build/cli-build.json'), receipt)
    fs.writeFileSync(path.join(directory, 'preflight.json'), JSON.stringify({ bundleSha256: subject.sha(bundle), buildReceiptSha256: subject.sha(receipt) }))
  }
  save(); redirectPaidPaths(t, f, subject.SEVENTH_DIRECTORY)
  try {
    const verify = () => subject.verifyPreparedBuild({ root, directory: subject.SEVENTH_DIRECTORY })
    assert.equal(verify().receipt.sourceCommit, baseline.sourceCommit)
    for (const overrides of [{ sourceDirty: true }, { sourceDirty: undefined }, { sourceCommit: 'unknown' }, { sourceCommit: undefined }]) { save(overrides); assert.throws(verify, /frozen clean commit/) }
    save(); fs.writeFileSync(path.join(directory, 'build/deepwriter.cjs'), bundle + ' changed'); assert.throws(verify, /coherent CLI/)
    save(); fs.writeFileSync(path.join(directory, 'build/cli-build.json'), JSON.stringify({ ...baseline, sourceCommit: 'f'.repeat(40) })); assert.throws(verify, /receipt is absent or changed/)
    save(); fs.writeFileSync(path.join(root, 'src/cli/main.ts'), 'SYNTHETIC changed'); assert.throws(verify, /source changed/)
  } finally { t.mock.restoreAll() }
})

test('R7 marker hooks precede credentials/CLI, original R5/R6 markers and response/accounting bodies remain frozen', async () => {
  const source = fs.readFileSync(path.join(subject.ROOT, 'scripts/authorized-cli-quality.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const definition = name => source.match(new RegExp('(?:async )?function ' + name + '\\([\\s\\S]+?\\n}\\n'))[0]
  assert.equal(definition('assertFreshR7Outline').replaceAll('R7', 'R6').replaceAll('SEVENTH_DIRECTORY', 'SIXTH_DIRECTORY'), definition('assertFreshR6Outline'))
  assert.equal(definition('claimR7OutlineAttempt').replaceAll('R7', 'R6').replaceAll("'r7'", "'r6'").replaceAll('SEVENTH_DIRECTORY', 'SIXTH_DIRECTORY'), definition('claimR6OutlineAttempt'))
  const start = source.indexOf('async function realPhase('), claim = source.indexOf('claimR7OutlineAttempt({ directory, prepared, ledger })', start)
  assert.ok(claim > source.indexOf('const ledger = createLedger(', start))
  assert.ok(claim < source.indexOf('const settings = json(sourceSettings)', start))
  assert.ok(claim < source.indexOf("phase === 'outline' ? await outlinePhase", start))
  await assert.rejects(subject.createRelay({ ledger: {}, apiKey: '', responseEvidenceDirectory: path.join(subject.SEVENTH_DIRECTORY, 'response-evidence') }), /credential/)
  await assert.rejects(subject.createRelay({ ledger: {}, apiKey: '', responseEvidenceDirectory: path.join(subject.SEVENTH_DIRECTORY + '-other', 'response-evidence') }), /restricted/)
})


const PEAK_AT = Date.parse('2026-10-05T01:05:00Z')
function peakEvidence(mutate = () => undefined, assessment = 'r7') {
  return priceEvidence(assessment, PEAK_AT, receipt => {
    receipt.purpose = 'r7_peak_price_upper_bound_only'; receipt.priceBand = 'peak'
    receipt.effectivePriceBound = { model: subject.MODEL, inputPer1M: 2, cacheHitPer1M: 0.04, outputPer1M: 8, sourceUrl: subject.PRICE_SOURCE_URL, sourceSha256: receipt.sourceSha256 }
    mutate(receipt)
  })
}
function peakFixture(id, overrides = {}, options = {}) {
  const f = fixture(id, overrides, 'r7'), evidence = peakEvidence()
  const ledger = subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers: options.helpers || helpers, phase: 'write', directory: subject.SEVENTH_DIRECTORY, priceVerification: options.verification || evidence.verification, now: options.now || (() => PEAK_AT) })
  return { ...f, peak: ledger, peakEvidence: evidence }
}

test('R7 peak bound requires an independent root pin, exact peak fields and source while R5/R6 and ordinary R7 still reject peak time', () => {
  assert.equal(subject.isOffPeak(PEAK_AT), false)
  const evidence = peakEvidence()
  const verification = subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, ...evidence.verification, at: PEAK_AT })
  assert.equal(verification.priceProfileHash, subject.PRICE_HASH)
  assert.equal(verification.pricingMode, 'r7_peak_price_upper_bound_only')
  assert.deepEqual(verification.effectivePriceBound, evidence.receipt.effectivePriceBound)
  assert.deepEqual(evidence.receipt.entry, { model: subject.MODEL, inputPer1M: 1, outputPer1M: 4, cacheHitPer1M: 0.02 })
  for (const assessment of ['r5', 'r6']) {
    const legacy = priceEvidence(assessment, AT, receipt => { receipt.effectivePriceBound = evidence.receipt.effectivePriceBound })
    const unchanged = subject.verifyPriceVerification({ directory: legacy.directory, ...legacy.verification, at: AT })
    assert.equal(unchanged.pricingMode, undefined); assert.equal(unchanged.effectivePriceBound, undefined)
  }
  const mixedR7 = priceEvidence('r7', AT, receipt => { receipt.effectivePriceBound = evidence.receipt.effectivePriceBound })
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, ...mixedR7.verification, at: AT }), /restricted/)
  for (const assessment of ['r5', 'r6', 'r7']) {
    const ordinary = priceEvidence(assessment, PEAK_AT)
    assert.throws(() => subject.verifyPriceVerification({ directory: ordinary.directory, ...ordinary.verification, at: PEAK_AT }), /off-peak/)
    if (assessment !== 'r7') {
      const denied = peakEvidence(() => undefined, assessment)
      assert.throws(() => subject.verifyPriceVerification({ directory: denied.directory, ...denied.verification, at: PEAK_AT }), /identity/)
    }
  }
  for (const mutate of [
    receipt => { delete receipt.effectivePriceBound },
    receipt => { receipt.effectivePriceBound.inputPer1M = 1 },
    receipt => { receipt.effectivePriceBound.cacheHitPer1M = 0.02 },
    receipt => { receipt.effectivePriceBound.outputPer1M = 4 },
    receipt => { receipt.effectivePriceBound.sourceUrl = 'https://not-official.invalid/' },
    receipt => { receipt.effectivePriceBound.sourceSha256 = '0'.repeat(64) },
    receipt => { receipt.effectivePriceBound.actualKnown = true },
    receipt => { receipt.entry.inputPer1M = 2 },
    receipt => { receipt.priceProfileHash = '0'.repeat(64) },
    receipt => { receipt.expiresAt = new Date(PEAK_AT).toISOString() }
  ]) {
    const denied = peakEvidence(mutate)
    assert.throws(() => subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, ...denied.verification, at: PEAK_AT }))
  }
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, ...evidence.verification, expectedSha256: '0'.repeat(64), at: PEAK_AT }))
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, ...evidence.verification, at: PEAK_AT + subject.PRICE_WINDOW_MS }))
})

test('R7 peak reserve/settle use the same all-miss 2/8 upper only, preserve old charges and never confirm an actual bill from usage', () => {
  const f = fixture('r7-peak-usage', {}, 'r7')
  const oldId = f.old.reserve(body()); f.old.settle(oldId, { prompt_tokens: 100, completion_tokens: 100 }, 'success')
  const old = f.old.snapshot(), evidence = peakEvidence()
  let at = PEAK_AT
  const noLowPriceCost = { ...helpers, computeSampleCost: () => { throw new Error('Peak mode cannot apply reference off-peak cost/actualKnown') } }
  const ledger = subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers: noLowPriceCost, phase: 'write', directory: subject.SEVENTH_DIRECTORY, priceVerification: evidence.verification, now: () => at })
  const id = ledger.reserve(body()), pending = ledger.snapshot()
  const attempt = pending.attempts.at(-1), input = helpers.utf8BodyTokenCeiling(body()).ceiling
  assert.equal(attempt.reservedMicros, Math.ceil(input * 2 + 4096 * 8))
  assert.equal(attempt.priceVerificationSha256, evidence.verification.expectedSha256)
  assert.deepEqual(attempt.effectivePriceBound, evidence.receipt.effectivePriceBound)
  assert.equal(attempt.actualAmountConfirmed, false)
  // The request was valid at its reservation time. Expiry now prohibits any
  // next request, but does not replace the already pinned peak settlement.
  at += subject.PRICE_WINDOW_MS
  ledger.settle(id, { prompt_tokens: 100, completion_tokens: 100, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 0 }, 'success')
  const settled = ledger.snapshot(), last = settled.attempts.at(-1)
  assert.equal(last.chargedUpperMicros, 1000)
  assert.equal(last.actualMicros, null); assert.equal(last.actualAmountConfirmed, false)
  assert.equal(last.upperBoundBasis, 'reported_usage_all_miss_at_pinned_peak_not_actual_billed')
  assert.deepEqual(settled.attempts[0], old.attempts[0])
  assert.equal(settled.startedAt, old.startedAt); assert.equal(settled.authorizationHash, old.authorizationHash)
  assert.deepEqual(settled.authorization, old.authorization); assert.equal(settled.priceProfileHash, old.priceProfileHash)
  assert.equal(settled.spentUpperMicros, old.spentUpperMicros + 1000)
  assert.equal(settled.inflightReservedMicros, 0); assert.equal(settled.requestsUsed, old.requestsUsed + 1)
  assert.throws(() => ledger.reserve(body()), /expired/)
})

test('R7 peak budget red blocks a request affordable only at old rates before any persistence/runtime/egress', t => {
  const input = helpers.utf8BodyTokenCeiling(body()).ceiling
  const base = (input + 4096 * 4) / 1e6, peak = (input * 2 + 4096 * 8) / 1e6
  const remaining = (base + peak) / 2
  const affordable = fixture('r7-peak-base-control', { maxCostCny: remaining }, 'r7')
  assert.doesNotThrow(() => affordable.old.reserve(body()))
  const f = peakFixture('r7-peak-budget-red', { maxCostCny: remaining }), before = fs.readFileSync(f.file, 'utf8')
  try {
    const counts = denySensitiveOperations(t)
    assert.throws(() => f.peak.reserve(body()), /financial cap/)
    assert.equal(fs.readFileSync(f.file, 'utf8'), before)
    assert.equal(f.peak.snapshot().requestsUsed, 0); assert.equal(f.peak.snapshot().inflightReservedMicros, 0)
    assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
  } finally { t.mock.restoreAll() }
})

test('R7 peak pin/source/bound drift and concurrent ledger changes cannot release a reserved upper', () => {
  let changed = ''
  const evidence = peakEvidence(), read = file => changed && file.endsWith(changed) ? Buffer.from('SYNTHETIC drift') : evidence.verification.read(file)
  const f = peakFixture('r7-peak-settlement-fences', {}, { verification: { ...evidence.verification, read } })
  const id = f.peak.reserve(body()), before = fs.readFileSync(f.file, 'utf8'), held = f.peak.snapshot().inflightReservedMicros
  for (changed of ['price-verification.json', 'price-verification-source.html']) {
    assert.throws(() => f.peak.settle(id, { prompt_tokens: 1, completion_tokens: 1 }, 'success'))
    assert.throws(() => f.peak.reserve(body()))
    assert.equal(f.peak.snapshot().inflightReservedMicros, held)
    assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  }
  changed = ''
  for (const mutate of [
    state => { state.attempts.at(-1).effectivePriceBound.inputPer1M = 1 },
    state => { state.attempts.at(-1).priceVerificationSha256 = '0'.repeat(64) },
    state => { state.attempts.at(-1).pricingMode = 'equivalent_price_window_only' },
    state => { state.requestsUsed++ }
  ]) {
    const drift = JSON.parse(before); mutate(drift); fs.writeFileSync(f.file, JSON.stringify(drift))
    assert.throws(() => f.peak.settle(id, { prompt_tokens: 1, completion_tokens: 1 }, 'success'), /reserved pin|ledger/)
    assert.equal(f.peak.snapshot().inflightReservedMicros, held)
    fs.writeFileSync(f.file, before)
  }
  f.peak.settle(id, null, 'http_error')
  const last = f.peak.snapshot().attempts.at(-1)
  assert.equal(last.chargedUpperMicros, held); assert.equal(last.actualMicros, null)
  assert.equal(last.upperBoundBasis, 'full_pinned_peak_pre_egress_reservation')
})

test('R7 peak failed/unknown/pending reservations remain fully charged without repricing prior attempts or refreshing start/auth', () => {
  const f = fixture('r7-peak-pending', {}, 'r7')
  const priorId = f.old.reserve(body()); f.old.settle(priorId, null, 'http_error')
  const old = f.old.snapshot(), evidence = peakEvidence()
  const make = () => subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers, phase: 'write', directory: subject.SEVENTH_DIRECTORY, priceVerification: evidence.verification, now: () => PEAK_AT })
  const ledger = make(), failed = ledger.reserve(body())
  const bound = ledger.snapshot().attempts.at(-1).reservedMicros
  ledger.settle(failed, { prompt_tokens: 'invalid', completion_tokens: 1 }, 'success')
  assert.equal(ledger.snapshot().attempts.at(-1).chargedUpperMicros, bound)
  const pending = ledger.reserve(body()), restarted = make().snapshot()
  assert.equal(restarted.attempts.at(-1).id, pending); assert.equal(restarted.attempts.at(-1).outcome, 'previous_process_unsettled')
  assert.equal(restarted.attempts.at(-1).chargedUpperMicros, bound); assert.equal(restarted.attempts.at(-1).actualMicros, null)
  assert.deepEqual(restarted.attempts[0], old.attempts[0])
  assert.equal(restarted.startedAt, old.startedAt); assert.equal(restarted.authorizationHash, old.authorizationHash)
  assert.deepEqual(restarted.authorization, old.authorization); assert.equal(restarted.spentUpperMicros, old.spentUpperMicros + bound * 2)
  assert.equal(restarted.inflightReservedMicros, 0)
})

test('R7 peak over-usage fails the original hard-cap proof and cannot refund the full reservation or enable another request', () => {
  const f = peakFixture('r7-peak-overusage'), id = f.peak.reserve(body()), pending = f.peak.snapshot().attempts.at(-1)
  f.peak.settle(id, { prompt_tokens: pending.inputTokenCeiling + 1, completion_tokens: pending.outputTokenCeiling + 1 }, 'success')
  const state = f.peak.snapshot(), last = state.attempts.at(-1)
  assert.equal(state.hardCapProtected, false)
  assert.ok(last.chargedUpperMicros >= pending.reservedMicros)
  assert.equal(last.actualMicros, null); assert.equal(last.actualAmountConfirmed, false)
  assert.throws(() => f.peak.reserve(body()), /financial cap/i)
})

function r8PeakEvidence(mutate = () => undefined) {
  return peakEvidence(receipt => { receipt.purpose = 'r8_peak_price_upper_bound_only'; mutate(receipt) }, 'r8')
}
function r8PeakFixture(id, overrides = {}, options = {}) {
  const f = fixture(id, overrides, 'r8'), evidence = r8PeakEvidence()
  const ledger = subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers: options.helpers || helpers, phase: 'write', directory: subject.EIGHTH_DIRECTORY, priceVerification: options.verification || evidence.verification, now: options.now || (() => PEAK_AT) })
  return { ...f, peak: ledger, peakEvidence: evidence }
}

test('R8 fixed leaf preserves 8000/13/default review, original lock/ledger and byte-identical one-shot R7 guards before credentials', async () => {
  assert.equal(subject.EIGHTH_DIRECTORY, path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r8'))
  const original = subject.assessmentPaths(), paths = subject.assessmentPaths(subject.EIGHTH_DIRECTORY)
  assert.equal(paths.budgetFile, original.budgetFile); assert.equal(paths.lockFile, original.lockFile)
  assert.throws(() => subject.assessmentPaths(subject.EIGHTH_DIRECTORY + '-other'))
  assert.throws(() => subject.assessmentPaths(path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r15')))
  assert.equal(subject.sha(subject.TASK), '1fa1c33430cf728f39b816e5598720fd047ae8f0ccdb65610f3c3c14b676fd37')
  assert.equal(subject.sha(JSON.stringify(subject.ANSWERS)), 'f020acdcfb63463e608b5ae2024bf7333aaad42c3ecdda44f656dd31050f8070')
  assert.equal(Object.keys(subject.ANSWERS).length, 13); assert.equal(Object.isFrozen(subject.ANSWERS), true)
  const source = fs.readFileSync(path.join(subject.ROOT, 'scripts/authorized-cli-quality.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const definition = name => source.match(new RegExp('(?:async )?function ' + name + '\\([\\s\\S]+?\\n}\\n'))[0]
  for (const name of ['assertFresh', 'claim']) {
    const suffix = name === 'assertFresh' ? 'Outline' : 'OutlineAttempt'
    assert.equal(definition(name + 'R8' + suffix).replaceAll('R8', 'R7').replaceAll("'r8'", "'r7'").replaceAll('EIGHTH_DIRECTORY', 'SEVENTH_DIRECTORY'), definition(name + 'R7' + suffix))
  }
  const start = source.indexOf('async function realPhase('), claim = source.indexOf('claimR8OutlineAttempt({ directory, prepared, ledger })', start)
  assert.ok(claim > source.indexOf('const ledger = createLedger(', start))
  assert.ok(claim < source.indexOf('const settings = json(sourceSettings)', start))
  assert.ok(claim < source.indexOf("phase === 'outline' ? await outlinePhase", start))
  assert.ok(source.includes("['write', TASK, '--target', '8000']"))
  assert.ok(source.includes('targetChars: 8000, reviewEnabled: true'))
  await assert.rejects(subject.createRelay({ ledger: {}, apiKey: '', responseEvidenceDirectory: path.join(subject.EIGHTH_DIRECTORY, 'response-evidence') }), /credential/)
  await assert.rejects(subject.createRelay({ ledger: {}, apiKey: '', responseEvidenceDirectory: path.join(subject.EIGHTH_DIRECTORY + '-other', 'response-evidence') }), /restricted/)
})

test('R8 missing pin, stale receipt, original-ledger absence or unprepared identity reject before runtime/key/paid IO/egress', async t => {
  const evidence = priceEvidence('r8')
  const base = ['--real', '--assessment=r8', '--phase=outline', '--price-verification-sha256=' + evidence.verification.expectedSha256]
  for (const scenario of ['missing-pin', 'stale', 'wrong-pin', 'no-original-ledger', 'no-prepared-build']) {
    try {
      const reads = [], probes = []
      t.mock.method(Date, 'now', () => scenario === 'stale' ? AT + subject.PRICE_WINDOW_MS : AT)
      t.mock.method(fs, 'readFileSync', file => {
        reads.push(file)
        if (scenario === 'no-prepared-build' && file === path.join(subject.EIGHTH_DIRECTORY, 'preflight.json')) return '{}'
        return evidence.verification.read(file)
      })
      t.mock.method(fs, 'existsSync', file => { probes.push(file); return scenario === 'no-prepared-build' && file === subject.assessmentPaths().budgetFile })
      const counts = denySensitiveOperations(t)
      const args = scenario === 'missing-pin' ? base.filter(arg => !arg.startsWith('--price-verification')) : scenario === 'wrong-pin' ? base.map(arg => arg.startsWith('--price-verification') ? '--price-verification-sha256=' + '0'.repeat(64) : arg) : base
      assert.equal(await subject.main(args), 2)
      assert.equal(reads.length, scenario === 'missing-pin' ? 0 : scenario === 'stale' || scenario === 'wrong-pin' ? 1 : scenario === 'no-prepared-build' ? 3 : 2)
      assert.ok(reads.every(file => file.startsWith(subject.EIGHTH_DIRECTORY + path.sep)))
      assert.ok(probes.every(file => file === subject.assessmentPaths().budgetFile || file === subject.EIGHTH_DIRECTORY || file.startsWith(subject.EIGHTH_DIRECTORY + path.sep)))
      assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
    } finally { t.mock.restoreAll() }
  }
})

test('R8 peak receipt is independently pinned to exact 2/.04/8 upper, cannot transplant R7 purpose or drift source/rates/freshness', () => {
  const evidence = r8PeakEvidence(), verification = subject.verifyPriceVerification({ directory: subject.EIGHTH_DIRECTORY, ...evidence.verification, at: PEAK_AT })
  assert.equal(verification.pricingMode, 'r8_peak_price_upper_bound_only')
  assert.equal(verification.priceProfileHash, subject.PRICE_HASH)
  assert.deepEqual(verification.effectivePriceBound, evidence.receipt.effectivePriceBound)
  assert.deepEqual(evidence.receipt.entry, { model: subject.MODEL, inputPer1M: 1, outputPer1M: 4, cacheHitPer1M: 0.02 })
  const r7 = peakEvidence()
  assert.equal(subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, ...r7.verification, at: PEAK_AT }).pricingMode, 'r7_peak_price_upper_bound_only')
  for (const mutate of [
    receipt => { receipt.purpose = 'r7_peak_price_upper_bound_only' }, receipt => { receipt.assessment = 'r7' },
    receipt => { delete receipt.effectivePriceBound }, receipt => { receipt.effectivePriceBound.inputPer1M = 1 },
    receipt => { receipt.effectivePriceBound.cacheHitPer1M = 0.02 }, receipt => { receipt.effectivePriceBound.outputPer1M = 4 },
    receipt => { receipt.effectivePriceBound.actualKnown = true }, receipt => { receipt.effectivePriceBound.sourceSha256 = '0'.repeat(64) },
    receipt => { receipt.effectivePriceBound.sourceUrl = 'https://not-official.invalid/' }, receipt => { receipt.entry.outputPer1M = 8 },
    receipt => { receipt.expiresAt = new Date(PEAK_AT).toISOString() }
  ]) {
    const denied = r8PeakEvidence(mutate)
    assert.throws(() => subject.verifyPriceVerification({ directory: subject.EIGHTH_DIRECTORY, ...denied.verification, at: PEAK_AT }))
  }
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.EIGHTH_DIRECTORY, ...evidence.verification, expectedSha256: '0'.repeat(64), at: PEAK_AT }))
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.EIGHTH_DIRECTORY, ...evidence.verification, at: PEAK_AT + subject.PRICE_WINDOW_MS }))
  const sourceDrift = { ...evidence.verification, read: file => file.endsWith('source.html') ? Buffer.from('SYNTHETIC changed source') : evidence.verification.read(file) }
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.EIGHTH_DIRECTORY, ...sourceDrift, at: PEAK_AT }))
  const mixed = priceEvidence('r8', AT, receipt => { receipt.effectivePriceBound = evidence.receipt.effectivePriceBound })
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.EIGHTH_DIRECTORY, ...mixed.verification, at: AT }), /restricted/)
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.EIGHTH_DIRECTORY, ...priceEvidence('r8', PEAK_AT).verification, at: PEAK_AT }), /off-peak/)
})

test('R8 appends to immutable synthetic R1-R7 history with only original 17 requests/4.416048 remaining, peak null-actual and failed/pending/overusage guards', t => {
  const seedHistory = f => {
    const { spentUpperCny, inflightReservedCny, cumulativeSpentUpperCny, cumulativeRequests, ...prior } = f.old.snapshot()
    prior.attempts = Array.from({ length: 33 }, (_, index) => ({ id: index + 1, phase: 'SYNTHETIC immutable prior R1-R7', requestHash: 'd'.repeat(64), reservedMicros: 10000, status: 'settled', reservedAt: AT - 1000 + index, settledAt: AT - 900 + index, outcome: 'success', chargedUpperMicros: index === 32 ? 8309 : 6700, actualMicros: null }))
    Object.assign(prior.attempts.at(-1), { pricingMode: 'r7_peak_price_upper_bound_only', effectivePriceBound: peakEvidence().receipt.effectivePriceBound, priceVerificationSha256: 'e'.repeat(64), actualAmountConfirmed: false })
    prior.requestsUsed = 33; prior.spentUpperMicros = 222709
    fs.writeFileSync(f.file, JSON.stringify(prior))
    return prior
  }
  const f = fixture('r8-original-history', {}, 'r8'), prior = seedHistory(f), evidence = r8PeakEvidence()
  const noDiscount = { ...helpers, computeSampleCost: () => { throw new Error('R8 cannot use reference discount or claim actual billing') } }
  const make = () => subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers: noDiscount, phase: 'write', directory: subject.EIGHTH_DIRECTORY, priceVerification: evidence.verification, now: () => PEAK_AT })
  const ledger = make()
  assert.equal(f.auth.maxRequests - ledger.snapshot().requestsUsed, 17)
  assert.equal(Math.round((f.auth.maxCostCny - ledger.snapshot().spentUpperCny) * 1e6), 4416048)
  const id = ledger.reserve(body()), pending = ledger.snapshot().attempts.at(-1)
  assert.equal(pending.reservedMicros, Math.ceil(helpers.utf8BodyTokenCeiling(body()).ceiling * 2 + 4096 * 8))
  assert.equal(pending.pricingMode, 'r8_peak_price_upper_bound_only'); assert.equal(pending.priceVerificationSha256, evidence.verification.expectedSha256)
  ledger.settle(id, { prompt_tokens: 100, completion_tokens: 100, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 0 }, 'success')
  const last = ledger.snapshot().attempts.at(-1)
  assert.equal(last.chargedUpperMicros, 1000); assert.equal(last.actualMicros, null); assert.equal(last.actualAmountConfirmed, false)
  assert.deepEqual(ledger.snapshot().attempts.slice(0, 33), prior.attempts)
  assert.equal(ledger.snapshot().startedAt, prior.startedAt); assert.equal(ledger.snapshot().authorizationHash, prior.authorizationHash)
  assert.deepEqual(ledger.snapshot().authorization, prior.authorization); assert.equal(ledger.snapshot().priceProfileHash, prior.priceProfileHash)
  const failed = ledger.reserve(body()), full = ledger.snapshot().attempts.at(-1).reservedMicros
  ledger.settle(failed, { prompt_tokens: 'invalid', completion_tokens: 1 }, 'success')
  assert.equal(ledger.snapshot().attempts.at(-1).chargedUpperMicros, full)
  const abandoned = ledger.reserve(body()), restarted = make()
  assert.equal(restarted.snapshot().attempts.at(-1).id, abandoned)
  assert.equal(restarted.snapshot().attempts.at(-1).outcome, 'previous_process_unsettled')
  assert.equal(restarted.snapshot().attempts.at(-1).chargedUpperMicros, full)
  assert.equal(restarted.snapshot().attempts.at(-1).actualMicros, null)
  assert.deepEqual(restarted.snapshot().attempts.slice(0, 33), prior.attempts)
  const overflow = restarted.reserve(body()), bound = restarted.snapshot().attempts.at(-1)
  restarted.settle(overflow, { prompt_tokens: bound.inputTokenCeiling + 1, completion_tokens: bound.outputTokenCeiling + 1 }, 'success')
  assert.equal(restarted.snapshot().hardCapProtected, false); assert.ok(restarted.snapshot().attempts.at(-1).chargedUpperMicros >= bound.reservedMicros)
  assert.throws(() => restarted.reserve(body()), /financial cap/i)
  const guard = fixture('r8-original-17-guard', {}, 'r8'); seedHistory(guard)
  const guarded = subject.createLedger({ file: guard.file, authorization: guard.auth, profile, helpers, phase: 'outline', directory: subject.EIGHTH_DIRECTORY, priceVerification: evidence.verification, now: () => PEAK_AT })
  for (let count = 0; count < 17; count++) guarded.settle(guarded.reserve(body()), null, 'SYNTHETIC failed attempt retains full reservation')
  assert.equal(guarded.snapshot().requestsUsed, 50)
  const before = fs.readFileSync(guard.file, 'utf8')
  try {
    const counts = denySensitiveOperations(t)
    assert.throws(() => guarded.reserve(body()), /request guard/)
    assert.equal(fs.readFileSync(guard.file, 'utf8'), before)
    assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
  } finally { t.mock.restoreAll() }
})

test('R8 exclusive original-outline marker consumes only its own TEMP leaf after original lock/ledger validation and cannot retry or prepare', async t => {
  const f = fixture('r8-marker', {}, 'r8'), financialBytes = fs.readFileSync(f.file)
  redirectPaidPaths(t, f, subject.EIGHTH_DIRECTORY)
  try {
    assert.throws(() => subject.claimR6OutlineAttempt({ directory: subject.EIGHTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger }), /restricted/)
    fs.writeFileSync(f.lock, JSON.stringify({ pid: -1, phase: 'outline' }))
    assert.throws(() => subject.claimR8OutlineAttempt({ directory: subject.EIGHTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger }), /ownership/)
    fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid, phase: 'outline' }))
    for (const prepared of [{ ...f.prepared, bundleSha256: '' }, { ...f.prepared, buildReceiptSha256: '' }, { ...f.prepared, authorization: { ...f.auth, maxRequests: 80 } }]) {
      assert.throws(() => subject.claimR8OutlineAttempt({ directory: subject.EIGHTH_DIRECTORY, prepared, ledger: f.ledger }), /identity/)
      assert.equal(fs.existsSync(path.join(subject.EIGHTH_DIRECTORY, 'outline-attempt.json')), false)
    }
    const marker = subject.claimR8OutlineAttempt({ directory: subject.EIGHTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger, now: () => AT })
    assert.equal(marker.assessment, 'r8'); assert.equal(marker.outlineRevision, 1); assert.equal(marker.taskHash, subject.sha(subject.TASK))
    assert.equal(marker.authorizationHash, f.ledger.snapshot().authorizationHash); assert.equal(marker.financialStartedAt, f.ledger.snapshot().startedAt)
    assert.equal(marker.bundleSha256, f.prepared.bundleSha256); assert.equal(marker.buildReceiptSha256, f.prepared.buildReceiptSha256)
    const markerBytes = fs.readFileSync(path.join(subject.EIGHTH_DIRECTORY, 'outline-attempt.json'))
    assert.throws(() => subject.claimR8OutlineAttempt({ directory: subject.EIGHTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger }), /already exists/)
    await assert.rejects(subject.prepare({ directory: subject.EIGHTH_DIRECTORY }), /already exists/)
    assert.deepEqual(fs.readFileSync(path.join(subject.EIGHTH_DIRECTORY, 'outline-attempt.json')), markerBytes)
    assert.deepEqual(fs.readFileSync(f.file), financialBytes); assert.equal(f.ledger.snapshot().requestsUsed, 0)
  } finally { t.mock.restoreAll() }
})

test('R8 paid-state/outline2/foreign/duplicate/replay flags refuse before writes, runtime, credentials and egress', async t => {
  const pin = '--price-verification-sha256=' + 'a'.repeat(64), base = ['--real', '--assessment=r8', '--phase=outline', pin]
  const cases = [
    base.map(arg => arg === '--phase=outline' ? '--phase=reoutline' : arg),
    [...base, '--outline-revision=2'], [...base, '--approved-outline-hash=' + '1'.repeat(16)],
    [...base, '--phase=outline'], [...base, '--assessment=r8'], [...base, pin], [...base, '--unknown=1'], [...base, '--real'],
    [...base, '--continue'], [...base, '--resume'], [...base, '--replay'], [...base, '--outline-revision=3'],
    ['--real', '--assessment=r8', '--phase=write', pin],
    ['--real', '--assessment=r8', '--phase=write', '--outline-revision=2', '--approved-outline-hash=' + '1'.repeat(16), pin],
    ['--real', '--assessment=r8-other', '--phase=outline', pin],
    ['--preflight', '--preflight', '--assessment=r8'], ['--preflight', '--build-cli', '--build-cli', '--assessment=r8']
  ]
  try {
    t.mock.method(fs, 'existsSync', () => { throw new Error('Invalid flags precede IO') })
    t.mock.method(fs, 'readFileSync', () => { throw new Error('Invalid flags precede IO') })
    const counts = denySensitiveOperations(t)
    for (const args of cases) assert.equal(await subject.main(args), 2)
    await assert.rejects(subject.reoutlinePhase({ directory: subject.EIGHTH_DIRECTORY, bundle: 'unused', relay: {}, command: async () => { throw new Error('No CLI') } }), /never permits/)
    await assert.rejects(subject.writePhase({ directory: subject.EIGHTH_DIRECTORY, bundle: 'unused', outlineRevision: 2, relay: {}, command: async () => { throw new Error('No CLI') } }), /revision1/)
    assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
  } finally { t.mock.restoreAll() }
  for (const sentinel of ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json', 'outline-revision-3.json']) {
    try {
      t.mock.method(fs, 'existsSync', file => sentinel === 'outline-revision-3.json' ? file === subject.EIGHTH_DIRECTORY : file === path.join(subject.EIGHTH_DIRECTORY, sentinel))
      t.mock.method(fs, 'readdirSync', file => { assert.equal(file, subject.EIGHTH_DIRECTORY); return [sentinel] })
      t.mock.method(fs, 'readFileSync', () => { throw new Error('Existing paid state precedes every read') })
      const counts = denySensitiveOperations(t)
      assert.equal(await subject.main(['--preflight', '--assessment=r8']), 2)
      assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
    } finally { t.mock.restoreAll() }
  }
})

test('R8 write uses only exact original durable root-approved hash, cannot replay and outline2 cannot publish', async t => {
  const f = fixture('r8-write', {}, 'r8'), bundle = path.join(f.directory, 'synthetic-unbuilt-bundle.cjs'), calls = []
  fs.writeFileSync(bundle, 'SYNTHETIC unbuilt bytes, never executable')
  const state = { stateId: 'synthetic-state', sessionId: 'synthetic-session', originalTask: subject.TASK, targetChars: 8000, status: 'awaiting_outline_confirmation', outlineRevision: 1, outlineHash: '1'.repeat(16), approvedOutline: null, assumptions: [],
    slots: Object.entries(subject.ANSWERS).map(([id, answer]) => ({ id, label: id, required: true, answer, source: 'user' })), answers: Object.values(subject.ANSWERS).map((value, index) => ({ questionId: 'q' + index, value, source: 'user', decision: 'answer' })), outline: { title: 'SYNTHETIC original outline', targetChars: 8000, sections: [] } }
  const outline = { schemaVersion: 1, taskHash: subject.sha(subject.TASK), bundleSha256: subject.sha(fs.readFileSync(bundle)), sessionId: state.sessionId, outlineHash: state.outlineHash, state, approval: 'pending_explicit_root_confirmation' }
  fs.writeFileSync(path.join(f.r6, 'outline.json'), JSON.stringify(outline))
  fs.writeFileSync(path.join(f.r6, 'outline-attempt.json'), 'SYNTHETIC consumed R8 marker')
  const command = async (_, args) => {
    calls.push(args)
    if (args[0] === 'status') return { code: 0, events: [{ type: 'state', data: state }] }
    if (args[0] === 'list') return { code: 0, events: [{ type: 'list', data: { runs: [], sessions: [{ session_id: state.sessionId }] } }] }
    assert.equal(args[0], 'confirm'); assert.equal(args[3], state.outlineHash)
    return { code: 2, stderr: 'SYNTHETIC interruption: no prose or completed artifact', events: [] }
  }
  redirectPaidPaths(t, f, subject.EIGHTH_DIRECTORY)
  try {
    await assert.rejects(subject.writePhase({ directory: subject.EIGHTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: '2'.repeat(16) }), /exact saved/)
    assert.equal(calls.length, 0)
    const marker = fs.readFileSync(path.join(subject.EIGHTH_DIRECTORY, 'outline-attempt.json'))
    const result = await subject.writePhase({ directory: subject.EIGHTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: state.outlineHash })
    assert.equal(result.status, 'incomplete'); assert.deepEqual(calls.map(args => args[0]), ['status', 'list', 'confirm'])
    assert.deepEqual(fs.readFileSync(path.join(subject.EIGHTH_DIRECTORY, 'outline-attempt.json')), marker)
    assert.equal(JSON.parse(fs.readFileSync(path.join(subject.EIGHTH_DIRECTORY, 'explicit-outline-approval.json'))).outlineRevision, 1)
    const count = calls.length
    await assert.rejects(subject.writePhase({ directory: subject.EIGHTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: state.outlineHash }), /replay/)
    assert.equal(calls.length, count); assert.equal(f.ledger.snapshot().requestsUsed, 0)
  } finally { t.mock.restoreAll() }
  const revision = fixture('r8-result-revision', {}, 'r8')
  const outlineCommand = async (_, args) => ({ code: 0, events: [{ type: 'state', data: args[0] === 'write' ? { status: 'outline_ready', sessionId: 'SYNTHETIC-session' } : { status: 'awaiting_outline_confirmation', sessionId: 'SYNTHETIC-session', targetChars: 8000, outlineRevision: 2, outlineHash: '1'.repeat(16), approvedOutline: null } }] })
  redirectPaidPaths(t, revision, subject.EIGHTH_DIRECTORY)
  try {
    await assert.rejects(subject.outlinePhase({ directory: subject.EIGHTH_DIRECTORY, bundle: 'SYNTHETIC never executed', relay: {}, command: outlineCommand }), /original revision1/)
    assert.equal(fs.existsSync(path.join(subject.EIGHTH_DIRECTORY, 'outline.json')), false)
  } finally { t.mock.restoreAll() }
})

test('R8 original clean-commit receipt denies source/bundle/hash/dirty drift without actual build', t => {
  const f = fixture('r8-build-receipt', {}, 'r8'), root = path.join(f.directory, 'source'), directory = f.r6
  const sourceFiles = new Map([['package.json', JSON.stringify({ version: '1.3.1' })], ['package-lock.json', JSON.stringify({ version: '1.3.1', packages: { '': { version: '1.3.1' } } })], ['src/cli/build.mjs', 'SYNTHETIC builder'], ['src/cli/main.ts', 'SYNTHETIC source']])
  for (const [name, content] of sourceFiles) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content) }
  fs.mkdirSync(path.join(directory, 'build'), { recursive: true })
  const bundle = 'SYNTHETIC never executable'
  const baseline = { sourceCommit: 'e'.repeat(40), sourceDirty: false, application: { name: 'deepwriter-cli', version: '1.3.1' }, source: { packageSha256: subject.sha(sourceFiles.get('package.json')), lockSha256: subject.sha(sourceFiles.get('package-lock.json')) },
    buildPolicy: { entrypoint: 'src/cli/main.ts', implementation: 'src/cli/build.mjs', implementationSha256: subject.sha(sourceFiles.get('src/cli/build.mjs')), platform: 'node', format: 'cjs', target: 'node22' }, inputs: [{ name: 'src/cli/main.ts', sha256: subject.sha(sourceFiles.get('src/cli/main.ts')) }] }
  const save = (overrides = {}) => {
    const receipt = JSON.stringify({ ...baseline, ...overrides })
    fs.writeFileSync(path.join(directory, 'build/deepwriter.cjs'), bundle); fs.writeFileSync(path.join(directory, 'build/cli-build.json'), receipt)
    fs.writeFileSync(path.join(directory, 'preflight.json'), JSON.stringify({ bundleSha256: subject.sha(bundle), buildReceiptSha256: subject.sha(receipt) }))
  }
  save(); redirectPaidPaths(t, f, subject.EIGHTH_DIRECTORY)
  try {
    const verify = () => subject.verifyPreparedBuild({ root, directory: subject.EIGHTH_DIRECTORY })
    assert.equal(verify().receipt.sourceCommit, baseline.sourceCommit)
    for (const overrides of [{ sourceDirty: true }, { sourceDirty: undefined }, { sourceCommit: 'unknown' }, { sourceCommit: undefined }]) { save(overrides); assert.throws(verify, /frozen clean commit/) }
    save(); fs.writeFileSync(path.join(directory, 'build/deepwriter.cjs'), bundle + ' changed'); assert.throws(verify, /coherent CLI/)
    save(); fs.writeFileSync(path.join(directory, 'build/cli-build.json'), JSON.stringify({ ...baseline, sourceCommit: 'f'.repeat(40) })); assert.throws(verify, /receipt is absent or changed/)
    save(); fs.writeFileSync(path.join(root, 'src/cli/main.ts'), 'SYNTHETIC changed'); assert.throws(verify, /source changed/)
  } finally { t.mock.restoreAll() }
})

test('R8 peak budget red blocks a request affordable only at old rates before any persistence/runtime/egress', t => {
  const input = helpers.utf8BodyTokenCeiling(body()).ceiling
  const base = (input + 4096 * 4) / 1e6, peak = (input * 2 + 4096 * 8) / 1e6
  const remaining = (base + peak) / 2
  const affordable = fixture('r8-peak-base-control', { maxCostCny: remaining }, 'r8')
  assert.doesNotThrow(() => affordable.old.reserve(body()))
  const f = r8PeakFixture('r8-peak-budget-red', { maxCostCny: remaining }), before = fs.readFileSync(f.file, 'utf8')
  try {
    const counts = denySensitiveOperations(t)
    assert.throws(() => f.peak.reserve(body()), /financial cap/)
    assert.equal(fs.readFileSync(f.file, 'utf8'), before)
    assert.equal(f.peak.snapshot().requestsUsed, 0); assert.equal(f.peak.snapshot().inflightReservedMicros, 0)
    assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
  } finally { t.mock.restoreAll() }
})

test('R8 peak pin/source/bound drift and concurrent ledger changes cannot release a reserved upper', () => {
  let changed = ''
  const evidence = r8PeakEvidence(), read = file => changed && file.endsWith(changed) ? Buffer.from('SYNTHETIC drift') : evidence.verification.read(file)
  const f = r8PeakFixture('r8-peak-settlement-fences', {}, { verification: { ...evidence.verification, read } })
  const id = f.peak.reserve(body()), before = fs.readFileSync(f.file, 'utf8'), held = f.peak.snapshot().inflightReservedMicros
  for (changed of ['price-verification.json', 'price-verification-source.html']) {
    assert.throws(() => f.peak.settle(id, { prompt_tokens: 1, completion_tokens: 1 }, 'success'))
    assert.throws(() => f.peak.reserve(body()))
    assert.equal(f.peak.snapshot().inflightReservedMicros, held)
    assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  }
  changed = ''
  for (const mutate of [
    state => { state.attempts.at(-1).effectivePriceBound.inputPer1M = 1 },
    state => { state.attempts.at(-1).priceVerificationSha256 = '0'.repeat(64) },
    state => { state.attempts.at(-1).pricingMode = 'equivalent_price_window_only' },
    state => { state.requestsUsed++ }
  ]) {
    const drift = JSON.parse(before); mutate(drift); fs.writeFileSync(f.file, JSON.stringify(drift))
    assert.throws(() => f.peak.settle(id, { prompt_tokens: 1, completion_tokens: 1 }, 'success'), /reserved pin|ledger/)
    assert.equal(f.peak.snapshot().inflightReservedMicros, held)
    fs.writeFileSync(f.file, before)
  }
  f.peak.settle(id, null, 'http_error')
  const last = f.peak.snapshot().attempts.at(-1)
  assert.equal(last.chargedUpperMicros, held); assert.equal(last.actualMicros, null)
  assert.equal(last.upperBoundBasis, 'full_pinned_peak_pre_egress_reservation')
})


function r9PeakEvidence(mutate = () => undefined) {
  return peakEvidence(receipt => { receipt.purpose = 'r9_peak_price_upper_bound_only'; mutate(receipt) }, 'r9')
}
function r9PeakFixture(id, overrides = {}, options = {}) {
  const f = fixture(id, overrides, 'r9'), evidence = r9PeakEvidence()
  const ledger = subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers: options.helpers || helpers, phase: 'write', directory: subject.NINTH_DIRECTORY, priceVerification: options.verification || evidence.verification, now: options.now || (() => PEAK_AT) })
  return { ...f, peak: ledger, peakEvidence: evidence }
}

test('R9 only appends to TEMP original R1-R8 history, retains original 12calls/4.328998 remaining and same all-miss pin/null-actual/atomic bounds', t => {
  const f = fixture('r9-original-history', {}, 'r9'), evidence = r9PeakEvidence()
  const { spentUpperCny, inflightReservedCny, cumulativeSpentUpperCny, cumulativeRequests, ...prior } = f.old.snapshot()
  prior.attempts = Array.from({ length: 38 }, (_, index) => ({ id: index + 1, phase: 'SYNTHETIC immutable original R1-R8 history', requestHash: 'd'.repeat(64), reservedMicros: 20000, status: 'settled', reservedAt: AT - 1000 + index, settledAt: AT - 900 + index, outcome: 'success', chargedUpperMicros: index === 37 ? 13759 : 8000, actualMicros: null }))
  Object.assign(prior.attempts.at(-1), { pricingMode: 'r8_peak_price_upper_bound_only', effectivePriceBound: r8PeakEvidence().receipt.effectivePriceBound, priceVerificationSha256: 'e'.repeat(64), actualAmountConfirmed: false })
  prior.requestsUsed = 38; prior.spentUpperMicros = 309759
  fs.writeFileSync(f.file, JSON.stringify(prior))
  let changed = false
  const read = file => changed && file.endsWith('source.html') ? Buffer.from('SYNTHETIC source drift') : evidence.verification.read(file)
  const noDiscount = { ...helpers, computeSampleCost: () => { throw new Error('R9 may not apply old discount or claim actual billing') } }
  const ledger = subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers: noDiscount, phase: 'write', directory: subject.NINTH_DIRECTORY, priceVerification: { ...evidence.verification, read }, now: () => PEAK_AT })
  assert.equal(f.auth.maxRequests - ledger.snapshot().requestsUsed, 12)
  assert.equal(Math.round((f.auth.maxCostCny - ledger.snapshot().spentUpperCny) * 1e6), 4328998)
  const id = ledger.reserve(body()), pending = ledger.snapshot().attempts.at(-1), held = ledger.snapshot().inflightReservedMicros
  assert.equal(pending.id, 39); assert.equal(pending.pricingMode, 'r9_peak_price_upper_bound_only')
  assert.equal(pending.reservedMicros, Math.ceil(helpers.utf8BodyTokenCeiling(body()).ceiling * 2 + 4096 * 8))
  assert.equal(pending.priceVerificationSha256, evidence.verification.expectedSha256)
  assert.deepEqual(pending.effectivePriceBound, evidence.receipt.effectivePriceBound)
  const durable = fs.readFileSync(f.file, 'utf8')
  changed = true
  assert.throws(() => ledger.reserve(body())); assert.throws(() => ledger.settle(id, { prompt_tokens: 100, completion_tokens: 100 }, 'success'))
  assert.equal(ledger.snapshot().inflightReservedMicros, held); assert.equal(fs.readFileSync(f.file, 'utf8'), durable)
  changed = false
  const drift = JSON.parse(durable); drift.attempts.at(-1).pricingMode = 'r8_peak_price_upper_bound_only'
  fs.writeFileSync(f.file, JSON.stringify(drift))
  assert.throws(() => ledger.settle(id, { prompt_tokens: 100, completion_tokens: 100 }, 'success'), /reserved pin|ledger/)
  assert.equal(ledger.snapshot().inflightReservedMicros, held); fs.writeFileSync(f.file, durable)
  ledger.settle(id, { prompt_tokens: 100, completion_tokens: 100, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 0 }, 'success')
  const last = ledger.snapshot().attempts.at(-1)
  assert.equal(last.chargedUpperMicros, 1000); assert.equal(last.actualMicros, null); assert.equal(last.actualAmountConfirmed, false)
  assert.deepEqual(ledger.snapshot().attempts.slice(0, 38), prior.attempts)
  assert.equal(ledger.snapshot().startedAt, prior.startedAt); assert.equal(ledger.snapshot().authorizationHash, prior.authorizationHash)
  assert.deepEqual(ledger.snapshot().authorization, prior.authorization); assert.equal(ledger.snapshot().priceProfileHash, prior.priceProfileHash)
  for (let count = 0; count < 11; count++) {
    const failed = ledger.reserve(body()), full = ledger.snapshot().attempts.at(-1).reservedMicros
    ledger.settle(failed, null, 'SYNTHETIC failed attempt keeps original full reservation')
    assert.equal(ledger.snapshot().attempts.at(-1).chargedUpperMicros, full); assert.equal(ledger.snapshot().attempts.at(-1).actualMicros, null)
  }
  assert.equal(ledger.snapshot().requestsUsed, 50); assert.equal(ledger.snapshot().cumulativeRequests, 80)
  const before = fs.readFileSync(f.file, 'utf8')
  try {
    const counts = denySensitiveOperations(t)
    assert.throws(() => ledger.reserve(body()), /request guard/)
    assert.equal(fs.readFileSync(f.file, 'utf8'), before)
    assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
  } finally { t.mock.restoreAll() }
  assert.deepEqual(ledger.snapshot().attempts.slice(0, 38), prior.attempts)
})

test('R9 fixed leaf preserves 8000/13/default review, original lock/ledger and byte-identical one-shot R8 guards before credentials', async () => {
  assert.equal(subject.NINTH_DIRECTORY, path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r9'))
  const original = subject.assessmentPaths(), paths = subject.assessmentPaths(subject.NINTH_DIRECTORY)
  assert.equal(paths.budgetFile, original.budgetFile); assert.equal(paths.lockFile, original.lockFile)
  assert.throws(() => subject.assessmentPaths(subject.NINTH_DIRECTORY + '-other'))
  assert.throws(() => subject.assessmentPaths(path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r15')))
  assert.equal(subject.sha(subject.TASK), '1fa1c33430cf728f39b816e5598720fd047ae8f0ccdb65610f3c3c14b676fd37')
  assert.equal(subject.sha(JSON.stringify(subject.ANSWERS)), 'f020acdcfb63463e608b5ae2024bf7333aaad42c3ecdda44f656dd31050f8070')
  assert.equal(Object.keys(subject.ANSWERS).length, 13); assert.equal(Object.isFrozen(subject.ANSWERS), true)
  const source = fs.readFileSync(path.join(subject.ROOT, 'scripts/authorized-cli-quality.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const definition = name => source.match(new RegExp('(?:async )?function ' + name + '\\([\\s\\S]+?\\n}\\n'))[0]
  for (const name of ['assertFresh', 'claim']) {
    const suffix = name === 'assertFresh' ? 'Outline' : 'OutlineAttempt'
    assert.equal(definition(name + 'R9' + suffix).replaceAll('R9', 'R8').replaceAll("'r9'", "'r8'").replaceAll('NINTH_DIRECTORY', 'EIGHTH_DIRECTORY'), definition(name + 'R8' + suffix))
  }
  const start = source.indexOf('async function realPhase('), claim = source.indexOf('claimR9OutlineAttempt({ directory, prepared, ledger })', start)
  assert.ok(claim > source.indexOf('const ledger = createLedger(', start))
  assert.ok(claim < source.indexOf('const settings = json(sourceSettings)', start))
  assert.ok(claim < source.indexOf("phase === 'outline' ? await outlinePhase", start))
  assert.ok(source.includes("['write', TASK, '--target', '8000']"))
  assert.ok(source.includes('targetChars: 8000, reviewEnabled: true'))
  await assert.rejects(subject.createRelay({ ledger: {}, apiKey: '', responseEvidenceDirectory: path.join(subject.NINTH_DIRECTORY, 'response-evidence') }), /credential/)
  await assert.rejects(subject.createRelay({ ledger: {}, apiKey: '', responseEvidenceDirectory: path.join(subject.NINTH_DIRECTORY + '-other', 'response-evidence') }), /restricted/)
})

test('R9 missing pin, stale receipt, original-ledger absence or unprepared identity reject before runtime/key/paid IO/egress', async t => {
  const evidence = priceEvidence('r9')
  const base = ['--real', '--assessment=r9', '--phase=outline', '--price-verification-sha256=' + evidence.verification.expectedSha256]
  for (const scenario of ['missing-pin', 'stale', 'wrong-pin', 'no-original-ledger', 'no-prepared-build']) {
    try {
      const reads = [], probes = []
      t.mock.method(Date, 'now', () => scenario === 'stale' ? AT + subject.PRICE_WINDOW_MS : AT)
      t.mock.method(fs, 'readFileSync', file => {
        reads.push(file)
        if (scenario === 'no-prepared-build' && file === path.join(subject.NINTH_DIRECTORY, 'preflight.json')) return '{}'
        return evidence.verification.read(file)
      })
      t.mock.method(fs, 'existsSync', file => { probes.push(file); return scenario === 'no-prepared-build' && file === subject.assessmentPaths().budgetFile })
      const counts = denySensitiveOperations(t)
      const args = scenario === 'missing-pin' ? base.filter(arg => !arg.startsWith('--price-verification')) : scenario === 'wrong-pin' ? base.map(arg => arg.startsWith('--price-verification') ? '--price-verification-sha256=' + '0'.repeat(64) : arg) : base
      assert.equal(await subject.main(args), 2)
      assert.equal(reads.length, scenario === 'missing-pin' ? 0 : scenario === 'stale' || scenario === 'wrong-pin' ? 1 : scenario === 'no-prepared-build' ? 3 : 2)
      assert.ok(reads.every(file => file.startsWith(subject.NINTH_DIRECTORY + path.sep)))
      assert.ok(probes.every(file => file === subject.assessmentPaths().budgetFile || file === subject.NINTH_DIRECTORY || file.startsWith(subject.NINTH_DIRECTORY + path.sep)))
      assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
    } finally { t.mock.restoreAll() }
  }
})

test('R9 peak receipt is independently pinned to exact 2/.04/8 upper, cannot transplant R7/R8 purposes or drift source/rates/freshness', () => {
  const evidence = r9PeakEvidence(), verification = subject.verifyPriceVerification({ directory: subject.NINTH_DIRECTORY, ...evidence.verification, at: PEAK_AT })
  assert.equal(verification.pricingMode, 'r9_peak_price_upper_bound_only')
  assert.equal(verification.priceProfileHash, subject.PRICE_HASH)
  assert.deepEqual(verification.effectivePriceBound, evidence.receipt.effectivePriceBound)
  assert.deepEqual(evidence.receipt.entry, { model: subject.MODEL, inputPer1M: 1, outputPer1M: 4, cacheHitPer1M: 0.02 })
  const r8 = r8PeakEvidence()
  assert.equal(subject.verifyPriceVerification({ directory: subject.EIGHTH_DIRECTORY, ...r8.verification, at: PEAK_AT }).pricingMode, 'r8_peak_price_upper_bound_only')
  const r7 = peakEvidence()
  assert.equal(subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, ...r7.verification, at: PEAK_AT }).pricingMode, 'r7_peak_price_upper_bound_only')
  for (const mutate of [
    receipt => { receipt.purpose = 'r7_peak_price_upper_bound_only' }, receipt => { receipt.purpose = 'r8_peak_price_upper_bound_only' }, receipt => { receipt.assessment = 'r7' },
    receipt => { delete receipt.effectivePriceBound }, receipt => { receipt.effectivePriceBound.inputPer1M = 1 },
    receipt => { receipt.effectivePriceBound.cacheHitPer1M = 0.02 }, receipt => { receipt.effectivePriceBound.outputPer1M = 4 },
    receipt => { receipt.effectivePriceBound.actualKnown = true }, receipt => { receipt.effectivePriceBound.sourceSha256 = '0'.repeat(64) },
    receipt => { receipt.effectivePriceBound.sourceUrl = 'https://not-official.invalid/' }, receipt => { receipt.entry.outputPer1M = 8 },
    receipt => { receipt.expiresAt = new Date(PEAK_AT).toISOString() }
  ]) {
    const denied = r9PeakEvidence(mutate)
    assert.throws(() => subject.verifyPriceVerification({ directory: subject.NINTH_DIRECTORY, ...denied.verification, at: PEAK_AT }))
  }
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.NINTH_DIRECTORY, ...evidence.verification, expectedSha256: '0'.repeat(64), at: PEAK_AT }))
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.NINTH_DIRECTORY, ...evidence.verification, at: PEAK_AT + subject.PRICE_WINDOW_MS }))
  const sourceDrift = { ...evidence.verification, read: file => file.endsWith('source.html') ? Buffer.from('SYNTHETIC changed source') : evidence.verification.read(file) }
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.NINTH_DIRECTORY, ...sourceDrift, at: PEAK_AT }))
  const mixed = priceEvidence('r9', AT, receipt => { receipt.effectivePriceBound = evidence.receipt.effectivePriceBound })
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.NINTH_DIRECTORY, ...mixed.verification, at: AT }), /restricted/)
  assert.throws(() => subject.verifyPriceVerification({ directory: subject.NINTH_DIRECTORY, ...priceEvidence('r9', PEAK_AT).verification, at: PEAK_AT }), /off-peak/)
})

test('R9 exclusive original-outline marker consumes only its own TEMP leaf after original lock/ledger validation and cannot retry or prepare', async t => {
  const f = fixture('r9-marker', {}, 'r9'), financialBytes = fs.readFileSync(f.file)
  redirectPaidPaths(t, f, subject.NINTH_DIRECTORY)
  try {
    assert.throws(() => subject.claimR6OutlineAttempt({ directory: subject.NINTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger }), /restricted/)
    fs.writeFileSync(f.lock, JSON.stringify({ pid: -1, phase: 'outline' }))
    assert.throws(() => subject.claimR9OutlineAttempt({ directory: subject.NINTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger }), /ownership/)
    fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid, phase: 'outline' }))
    for (const prepared of [{ ...f.prepared, bundleSha256: '' }, { ...f.prepared, buildReceiptSha256: '' }, { ...f.prepared, authorization: { ...f.auth, maxRequests: 80 } }]) {
      assert.throws(() => subject.claimR9OutlineAttempt({ directory: subject.NINTH_DIRECTORY, prepared, ledger: f.ledger }), /identity/)
      assert.equal(fs.existsSync(path.join(subject.NINTH_DIRECTORY, 'outline-attempt.json')), false)
    }
    const marker = subject.claimR9OutlineAttempt({ directory: subject.NINTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger, now: () => AT })
    assert.equal(marker.assessment, 'r9'); assert.equal(marker.outlineRevision, 1); assert.equal(marker.taskHash, subject.sha(subject.TASK))
    assert.equal(marker.authorizationHash, f.ledger.snapshot().authorizationHash); assert.equal(marker.financialStartedAt, f.ledger.snapshot().startedAt)
    assert.equal(marker.bundleSha256, f.prepared.bundleSha256); assert.equal(marker.buildReceiptSha256, f.prepared.buildReceiptSha256)
    const markerBytes = fs.readFileSync(path.join(subject.NINTH_DIRECTORY, 'outline-attempt.json'))
    assert.throws(() => subject.claimR9OutlineAttempt({ directory: subject.NINTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger }), /already exists/)
    await assert.rejects(subject.prepare({ directory: subject.NINTH_DIRECTORY }), /already exists/)
    assert.deepEqual(fs.readFileSync(path.join(subject.NINTH_DIRECTORY, 'outline-attempt.json')), markerBytes)
    assert.deepEqual(fs.readFileSync(f.file), financialBytes); assert.equal(f.ledger.snapshot().requestsUsed, 0)
  } finally { t.mock.restoreAll() }
})

test('R9 paid-state/outline2/foreign/duplicate/replay flags refuse before writes, runtime, credentials and egress', async t => {
  const pin = '--price-verification-sha256=' + 'a'.repeat(64), base = ['--real', '--assessment=r9', '--phase=outline', pin]
  const cases = [
    base.map(arg => arg === '--phase=outline' ? '--phase=reoutline' : arg),
    [...base, '--outline-revision=2'], [...base, '--approved-outline-hash=' + '1'.repeat(16)],
    [...base, '--phase=outline'], [...base, '--assessment=r9'], [...base, pin], [...base, '--unknown=1'], [...base, '--real'],
    [...base, '--continue'], [...base, '--resume'], [...base, '--replay'], [...base, '--outline-revision=3'],
    ['--real', '--assessment=r9', '--phase=write', pin],
    ['--real', '--assessment=r9', '--phase=write', '--outline-revision=2', '--approved-outline-hash=' + '1'.repeat(16), pin],
    ['--real', '--assessment=r9-other', '--phase=outline', pin], ['--real', '--assessment=r15', '--phase=outline', pin],
    ['--preflight', '--preflight', '--assessment=r9'], ['--preflight', '--build-cli', '--build-cli', '--assessment=r9']
  ]
  try {
    t.mock.method(fs, 'existsSync', () => { throw new Error('Invalid flags precede IO') })
    t.mock.method(fs, 'readFileSync', () => { throw new Error('Invalid flags precede IO') })
    const counts = denySensitiveOperations(t)
    for (const args of cases) assert.equal(await subject.main(args), 2)
    await assert.rejects(subject.reoutlinePhase({ directory: subject.NINTH_DIRECTORY, bundle: 'unused', relay: {}, command: async () => { throw new Error('No CLI') } }), /never permits/)
    await assert.rejects(subject.writePhase({ directory: subject.NINTH_DIRECTORY, bundle: 'unused', outlineRevision: 2, relay: {}, command: async () => { throw new Error('No CLI') } }), /revision1/)
    assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
  } finally { t.mock.restoreAll() }
  for (const sentinel of ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json', 'outline-revision-3.json']) {
    try {
      t.mock.method(fs, 'existsSync', file => sentinel === 'outline-revision-3.json' ? file === subject.NINTH_DIRECTORY : file === path.join(subject.NINTH_DIRECTORY, sentinel))
      t.mock.method(fs, 'readdirSync', file => { assert.equal(file, subject.NINTH_DIRECTORY); return [sentinel] })
      t.mock.method(fs, 'readFileSync', () => { throw new Error('Existing paid state precedes every read') })
      const counts = denySensitiveOperations(t)
      assert.equal(await subject.main(['--preflight', '--assessment=r9']), 2)
      assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
    } finally { t.mock.restoreAll() }
  }
})

test('R9 write uses only exact original durable root-approved hash, cannot replay and outline2 cannot publish', async t => {
  const f = fixture('r9-write', {}, 'r9'), bundle = path.join(f.directory, 'synthetic-unbuilt-bundle.cjs'), calls = []
  fs.writeFileSync(bundle, 'SYNTHETIC unbuilt bytes, never executable')
  const state = { stateId: 'synthetic-state', sessionId: 'synthetic-session', originalTask: subject.TASK, targetChars: 8000, status: 'awaiting_outline_confirmation', outlineRevision: 1, outlineHash: '1'.repeat(16), approvedOutline: null, assumptions: [],
    slots: Object.entries(subject.ANSWERS).map(([id, answer]) => ({ id, label: id, required: true, answer, source: 'user' })), answers: Object.values(subject.ANSWERS).map((value, index) => ({ questionId: 'q' + index, value, source: 'user', decision: 'answer' })), outline: { title: 'SYNTHETIC original outline', targetChars: 8000, sections: [] } }
  const outline = { schemaVersion: 1, taskHash: subject.sha(subject.TASK), bundleSha256: subject.sha(fs.readFileSync(bundle)), sessionId: state.sessionId, outlineHash: state.outlineHash, state, approval: 'pending_explicit_root_confirmation' }
  fs.writeFileSync(path.join(f.r6, 'outline.json'), JSON.stringify(outline))
  fs.writeFileSync(path.join(f.r6, 'outline-attempt.json'), 'SYNTHETIC consumed R9 marker')
  const command = async (_, args) => {
    calls.push(args)
    if (args[0] === 'status') return { code: 0, events: [{ type: 'state', data: state }] }
    if (args[0] === 'list') return { code: 0, events: [{ type: 'list', data: { runs: [], sessions: [{ session_id: state.sessionId }] } }] }
    assert.equal(args[0], 'confirm'); assert.equal(args[3], state.outlineHash)
    return { code: 2, stderr: 'SYNTHETIC interruption: no prose or completed artifact', events: [] }
  }
  redirectPaidPaths(t, f, subject.NINTH_DIRECTORY)
  try {
    await assert.rejects(subject.writePhase({ directory: subject.NINTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: '2'.repeat(16) }), /exact saved/)
    assert.equal(calls.length, 0)
    const marker = fs.readFileSync(path.join(subject.NINTH_DIRECTORY, 'outline-attempt.json'))
    const result = await subject.writePhase({ directory: subject.NINTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: state.outlineHash })
    assert.equal(result.status, 'incomplete'); assert.deepEqual(calls.map(args => args[0]), ['status', 'list', 'confirm'])
    assert.deepEqual(fs.readFileSync(path.join(subject.NINTH_DIRECTORY, 'outline-attempt.json')), marker)
    assert.equal(JSON.parse(fs.readFileSync(path.join(subject.NINTH_DIRECTORY, 'explicit-outline-approval.json'))).outlineRevision, 1)
    const count = calls.length
    await assert.rejects(subject.writePhase({ directory: subject.NINTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: state.outlineHash }), /replay/)
    assert.equal(calls.length, count); assert.equal(f.ledger.snapshot().requestsUsed, 0)
  } finally { t.mock.restoreAll() }
  const revision = fixture('r9-result-revision', {}, 'r9')
  const outlineCommand = async (_, args) => ({ code: 0, events: [{ type: 'state', data: args[0] === 'write' ? { status: 'outline_ready', sessionId: 'SYNTHETIC-session' } : { status: 'awaiting_outline_confirmation', sessionId: 'SYNTHETIC-session', targetChars: 8000, outlineRevision: 2, outlineHash: '1'.repeat(16), approvedOutline: null } }] })
  redirectPaidPaths(t, revision, subject.NINTH_DIRECTORY)
  try {
    await assert.rejects(subject.outlinePhase({ directory: subject.NINTH_DIRECTORY, bundle: 'SYNTHETIC never executed', relay: {}, command: outlineCommand }), /original revision1/)
    assert.equal(fs.existsSync(path.join(subject.NINTH_DIRECTORY, 'outline.json')), false)
  } finally { t.mock.restoreAll() }
})

test('R9 original clean-commit receipt denies source/bundle/hash/dirty drift without actual build', t => {
  const f = fixture('r9-build-receipt', {}, 'r9'), root = path.join(f.directory, 'source'), directory = f.r6
  const sourceFiles = new Map([['package.json', JSON.stringify({ version: '1.3.1' })], ['package-lock.json', JSON.stringify({ version: '1.3.1', packages: { '': { version: '1.3.1' } } })], ['src/cli/build.mjs', 'SYNTHETIC builder'], ['src/cli/main.ts', 'SYNTHETIC source']])
  for (const [name, content] of sourceFiles) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content) }
  fs.mkdirSync(path.join(directory, 'build'), { recursive: true })
  const bundle = 'SYNTHETIC never executable'
  const baseline = { sourceCommit: 'e'.repeat(40), sourceDirty: false, application: { name: 'deepwriter-cli', version: '1.3.1' }, source: { packageSha256: subject.sha(sourceFiles.get('package.json')), lockSha256: subject.sha(sourceFiles.get('package-lock.json')) },
    buildPolicy: { entrypoint: 'src/cli/main.ts', implementation: 'src/cli/build.mjs', implementationSha256: subject.sha(sourceFiles.get('src/cli/build.mjs')), platform: 'node', format: 'cjs', target: 'node22' }, inputs: [{ name: 'src/cli/main.ts', sha256: subject.sha(sourceFiles.get('src/cli/main.ts')) }] }
  const save = (overrides = {}) => {
    const receipt = JSON.stringify({ ...baseline, ...overrides })
    fs.writeFileSync(path.join(directory, 'build/deepwriter.cjs'), bundle); fs.writeFileSync(path.join(directory, 'build/cli-build.json'), receipt)
    fs.writeFileSync(path.join(directory, 'preflight.json'), JSON.stringify({ bundleSha256: subject.sha(bundle), buildReceiptSha256: subject.sha(receipt) }))
  }
  save(); redirectPaidPaths(t, f, subject.NINTH_DIRECTORY)
  try {
    const verify = () => subject.verifyPreparedBuild({ root, directory: subject.NINTH_DIRECTORY })
    assert.equal(verify().receipt.sourceCommit, baseline.sourceCommit)
    for (const overrides of [{ sourceDirty: true }, { sourceDirty: undefined }, { sourceCommit: 'unknown' }, { sourceCommit: undefined }]) { save(overrides); assert.throws(verify, /frozen clean commit/) }
    save(); fs.writeFileSync(path.join(directory, 'build/deepwriter.cjs'), bundle + ' changed'); assert.throws(verify, /coherent CLI/)
    save(); fs.writeFileSync(path.join(directory, 'build/cli-build.json'), JSON.stringify({ ...baseline, sourceCommit: 'f'.repeat(40) })); assert.throws(verify, /receipt is absent or changed/)
    save(); fs.writeFileSync(path.join(root, 'src/cli/main.ts'), 'SYNTHETIC changed'); assert.throws(verify, /source changed/)
  } finally { t.mock.restoreAll() }
})

test('R9 peak budget red blocks a request affordable only at old rates before any persistence/runtime/egress', t => {
  const input = helpers.utf8BodyTokenCeiling(body()).ceiling
  const base = (input + 4096 * 4) / 1e6, peak = (input * 2 + 4096 * 8) / 1e6
  const remaining = (base + peak) / 2
  const affordable = fixture('r9-peak-base-control', { maxCostCny: remaining }, 'r9')
  assert.doesNotThrow(() => affordable.old.reserve(body()))
  const f = r9PeakFixture('r9-peak-budget-red', { maxCostCny: remaining }), before = fs.readFileSync(f.file, 'utf8')
  try {
    const counts = denySensitiveOperations(t)
    assert.throws(() => f.peak.reserve(body()), /financial cap/)
    assert.equal(fs.readFileSync(f.file, 'utf8'), before)
    assert.equal(f.peak.snapshot().requestsUsed, 0); assert.equal(f.peak.snapshot().inflightReservedMicros, 0)
    assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
  } finally { t.mock.restoreAll() }
})


function r10PeakEvidence(mutate = () => undefined) {
  return peakEvidence(receipt => { receipt.purpose = 'r10_peak_price_upper_bound_only'; mutate(receipt) }, 'r10')
}
function r10PeakFixture(id, overrides = {}, options = {}) {
  const f = fixture(id, overrides, 'r10'), evidence = r10PeakEvidence()
  const ledger = subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers: options.helpers || helpers, phase: 'write', directory: subject.TENTH_DIRECTORY, priceVerification: options.verification || evidence.verification, now: options.now || (() => PEAK_AT) })
  return { ...f, peak: ledger, peakEvidence: evidence }
}

test('R10 fixed leaf preserves 8000/13/default review, original lock/ledger and byte-identical one-shot R9 guards before credentials', async () => {
  assert.equal(subject.TENTH_DIRECTORY, path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r10'))
  const original = subject.assessmentPaths(), paths = subject.assessmentPaths(subject.TENTH_DIRECTORY)
  assert.equal(paths.budgetFile, original.budgetFile); assert.equal(paths.lockFile, original.lockFile)
  assert.throws(() => subject.assessmentPaths(subject.TENTH_DIRECTORY + '-other'))
  assert.throws(() => subject.assessmentPaths(path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r15')))
  assert.equal(subject.sha(subject.TASK), '1fa1c33430cf728f39b816e5598720fd047ae8f0ccdb65610f3c3c14b676fd37')
  assert.equal(subject.sha(JSON.stringify(subject.ANSWERS)), 'f020acdcfb63463e608b5ae2024bf7333aaad42c3ecdda44f656dd31050f8070')
  assert.equal(Object.keys(subject.ANSWERS).length, 13); assert.equal(Object.isFrozen(subject.ANSWERS), true)
  const source = fs.readFileSync(path.join(subject.ROOT, 'scripts/authorized-cli-quality.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const definition = name => source.match(new RegExp('(?:async )?function ' + name + '\\([\\s\\S]+?\\n}\\n'))[0]
  for (const name of ['assertFresh', 'claim']) {
    const suffix = name === 'assertFresh' ? 'Outline' : 'OutlineAttempt'
    assert.equal(definition(name + 'R10' + suffix).replaceAll('R10', 'R9').replaceAll("'r10'", "'r9'").replaceAll('TENTH_DIRECTORY', 'NINTH_DIRECTORY'), definition(name + 'R9' + suffix))
  }
  const start = source.indexOf('async function realPhase('), claim = source.indexOf('claimR10OutlineAttempt({ directory, prepared, ledger })', start)
  assert.ok(claim > source.indexOf('const ledger = createLedger(', start))
  assert.ok(claim < source.indexOf('const settings = json(sourceSettings)', start))
  assert.ok(claim < source.indexOf("phase === 'outline' ? await outlinePhase", start))
  assert.ok(source.includes("['write', TASK, '--target', '8000']"))
  assert.ok(source.includes('targetChars: 8000, reviewEnabled: true'))
  await assert.rejects(subject.createRelay({ ledger: {}, apiKey: '', responseEvidenceDirectory: path.join(subject.TENTH_DIRECTORY, 'response-evidence') }), /credential/)
  await assert.rejects(subject.createRelay({ ledger: {}, apiKey: '', responseEvidenceDirectory: path.join(subject.TENTH_DIRECTORY + '-other', 'response-evidence') }), /restricted/)
})

test('R10 exclusive original-outline marker consumes only its own TEMP leaf after original lock/ledger validation and cannot retry or prepare', async t => {
  const f = fixture('r10-marker', {}, 'r10'), financialBytes = fs.readFileSync(f.file)
  redirectPaidPaths(t, f, subject.TENTH_DIRECTORY)
  try {
    assert.throws(() => subject.claimR6OutlineAttempt({ directory: subject.TENTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger }), /restricted/)
    fs.writeFileSync(f.lock, JSON.stringify({ pid: -1, phase: 'outline' }))
    assert.throws(() => subject.claimR10OutlineAttempt({ directory: subject.TENTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger }), /ownership/)
    fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid, phase: 'outline' }))
    for (const prepared of [{ ...f.prepared, bundleSha256: '' }, { ...f.prepared, buildReceiptSha256: '' }, { ...f.prepared, authorization: { ...f.auth, maxRequests: 80 } }]) {
      assert.throws(() => subject.claimR10OutlineAttempt({ directory: subject.TENTH_DIRECTORY, prepared, ledger: f.ledger }), /identity/)
      assert.equal(fs.existsSync(path.join(subject.TENTH_DIRECTORY, 'outline-attempt.json')), false)
    }
    const marker = subject.claimR10OutlineAttempt({ directory: subject.TENTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger, now: () => AT })
    assert.equal(marker.assessment, 'r10'); assert.equal(marker.outlineRevision, 1); assert.equal(marker.taskHash, subject.sha(subject.TASK))
    assert.equal(marker.authorizationHash, f.ledger.snapshot().authorizationHash); assert.equal(marker.financialStartedAt, f.ledger.snapshot().startedAt)
    assert.equal(marker.bundleSha256, f.prepared.bundleSha256); assert.equal(marker.buildReceiptSha256, f.prepared.buildReceiptSha256)
    const markerBytes = fs.readFileSync(path.join(subject.TENTH_DIRECTORY, 'outline-attempt.json'))
    assert.throws(() => subject.claimR10OutlineAttempt({ directory: subject.TENTH_DIRECTORY, prepared: f.prepared, ledger: f.ledger }), /already exists/)
    await assert.rejects(subject.prepare({ directory: subject.TENTH_DIRECTORY }), /already exists/)
    assert.deepEqual(fs.readFileSync(path.join(subject.TENTH_DIRECTORY, 'outline-attempt.json')), markerBytes)
    assert.deepEqual(fs.readFileSync(f.file), financialBytes); assert.equal(f.ledger.snapshot().requestsUsed, 0)
  } finally { t.mock.restoreAll() }
})

test('R10 paid-state/outline2/foreign/duplicate/replay flags refuse before writes, runtime, credentials and egress', async t => {
  const pin = '--price-verification-sha256=' + 'a'.repeat(64), base = ['--real', '--assessment=r10', '--phase=outline', pin]
  const cases = [
    base.map(arg => arg === '--phase=outline' ? '--phase=reoutline' : arg),
    [...base, '--outline-revision=2'], [...base, '--approved-outline-hash=' + '1'.repeat(16)],
    [...base, '--phase=outline'], [...base, '--assessment=r10'], [...base, pin], [...base, '--unknown=1'], [...base, '--real'],
    [...base, '--continue'], [...base, '--resume'], [...base, '--replay'], [...base, '--outline-revision=3'],
    ['--real', '--assessment=r10', '--phase=write', pin],
    ['--real', '--assessment=r10', '--phase=write', '--outline-revision=2', '--approved-outline-hash=' + '1'.repeat(16), pin],
    ['--real', '--assessment=r10-other', '--phase=outline', pin], ['--real', '--assessment=r15', '--phase=outline', pin],
    ['--preflight', '--preflight', '--assessment=r10'], ['--preflight', '--build-cli', '--build-cli', '--assessment=r10']
  ]
  try {
    t.mock.method(fs, 'existsSync', () => { throw new Error('Invalid flags precede IO') })
    t.mock.method(fs, 'readFileSync', () => { throw new Error('Invalid flags precede IO') })
    const counts = denySensitiveOperations(t)
    for (const args of cases) assert.equal(await subject.main(args), 2)
    await assert.rejects(subject.reoutlinePhase({ directory: subject.TENTH_DIRECTORY, bundle: 'unused', relay: {}, command: async () => { throw new Error('No CLI') } }), /never permits/)
    await assert.rejects(subject.writePhase({ directory: subject.TENTH_DIRECTORY, bundle: 'unused', outlineRevision: 2, relay: {}, command: async () => { throw new Error('No CLI') } }), /revision1/)
    assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
  } finally { t.mock.restoreAll() }
  for (const sentinel of ['outline-attempt.json', 'outline.json', 'explicit-outline-approval.json', 'write-result.json', 'data/deepwriter.sqlite', 'reoutline-attempt.json', 'outline-revision-2.json', 'outline-revision-3.json']) {
    try {
      t.mock.method(fs, 'existsSync', file => sentinel === 'outline-revision-3.json' ? file === subject.TENTH_DIRECTORY : file === path.join(subject.TENTH_DIRECTORY, sentinel))
      t.mock.method(fs, 'readdirSync', file => { assert.equal(file, subject.TENTH_DIRECTORY); return [sentinel] })
      t.mock.method(fs, 'readFileSync', () => { throw new Error('Existing paid state precedes every read') })
      const counts = denySensitiveOperations(t)
      assert.equal(await subject.main(['--preflight', '--assessment=r10']), 2)
      assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
    } finally { t.mock.restoreAll() }
  }
})

test('R10 price pin/source/bound/freshness and original ledger/build guards precede runtime/key/paid IO with legacy R7-R9 unchanged', async t => {
  {
  const evidence = r10PeakEvidence(), verification = subject.verifyPriceVerification({ directory: subject.TENTH_DIRECTORY, ...evidence.verification, at: PEAK_AT })
    assert.equal(verification.pricingMode, 'r10_peak_price_upper_bound_only')
    assert.equal(verification.priceProfileHash, subject.PRICE_HASH)
    assert.deepEqual(verification.effectivePriceBound, evidence.receipt.effectivePriceBound)
    assert.deepEqual(evidence.receipt.entry, { model: subject.MODEL, inputPer1M: 1, outputPer1M: 4, cacheHitPer1M: 0.02 })
    const r9 = r9PeakEvidence()
    assert.equal(subject.verifyPriceVerification({ directory: subject.NINTH_DIRECTORY, ...r9.verification, at: PEAK_AT }).pricingMode, 'r9_peak_price_upper_bound_only')
    const r8 = r8PeakEvidence()
    assert.equal(subject.verifyPriceVerification({ directory: subject.EIGHTH_DIRECTORY, ...r8.verification, at: PEAK_AT }).pricingMode, 'r8_peak_price_upper_bound_only')
    const r7 = peakEvidence()
    assert.equal(subject.verifyPriceVerification({ directory: subject.SEVENTH_DIRECTORY, ...r7.verification, at: PEAK_AT }).pricingMode, 'r7_peak_price_upper_bound_only')
    for (const mutate of [
      receipt => { receipt.purpose = 'r7_peak_price_upper_bound_only' }, receipt => { receipt.purpose = 'r8_peak_price_upper_bound_only' }, receipt => { receipt.purpose = 'r9_peak_price_upper_bound_only' }, receipt => { receipt.assessment = 'r7' },
      receipt => { delete receipt.effectivePriceBound }, receipt => { receipt.effectivePriceBound.inputPer1M = 1 },
      receipt => { receipt.effectivePriceBound.cacheHitPer1M = 0.02 }, receipt => { receipt.effectivePriceBound.outputPer1M = 4 },
      receipt => { receipt.effectivePriceBound.actualKnown = true }, receipt => { receipt.effectivePriceBound.sourceSha256 = '0'.repeat(64) },
      receipt => { receipt.effectivePriceBound.sourceUrl = 'https://not-official.invalid/' }, receipt => { receipt.entry.outputPer1M = 8 },
      receipt => { receipt.expiresAt = new Date(PEAK_AT).toISOString() }
    ]) {
      const denied = r10PeakEvidence(mutate)
      assert.throws(() => subject.verifyPriceVerification({ directory: subject.TENTH_DIRECTORY, ...denied.verification, at: PEAK_AT }))
    }
    assert.throws(() => subject.verifyPriceVerification({ directory: subject.TENTH_DIRECTORY, ...evidence.verification, expectedSha256: '0'.repeat(64), at: PEAK_AT }))
    assert.throws(() => subject.verifyPriceVerification({ directory: subject.TENTH_DIRECTORY, ...evidence.verification, at: PEAK_AT + subject.PRICE_WINDOW_MS }))
    const sourceDrift = { ...evidence.verification, read: file => file.endsWith('source.html') ? Buffer.from('SYNTHETIC changed source') : evidence.verification.read(file) }
    assert.throws(() => subject.verifyPriceVerification({ directory: subject.TENTH_DIRECTORY, ...sourceDrift, at: PEAK_AT }))
    const mixed = priceEvidence('r10', AT, receipt => { receipt.effectivePriceBound = evidence.receipt.effectivePriceBound })
    assert.throws(() => subject.verifyPriceVerification({ directory: subject.TENTH_DIRECTORY, ...mixed.verification, at: AT }), /restricted/)
    assert.throws(() => subject.verifyPriceVerification({ directory: subject.TENTH_DIRECTORY, ...priceEvidence('r10', PEAK_AT).verification, at: PEAK_AT }), /off-peak/)
  }
  {
  const evidence = priceEvidence('r10')
    const base = ['--real', '--assessment=r10', '--phase=outline', '--price-verification-sha256=' + evidence.verification.expectedSha256]
    for (const scenario of ['missing-pin', 'stale', 'wrong-pin', 'no-original-ledger', 'no-prepared-build']) {
      try {
        const reads = [], probes = []
        t.mock.method(Date, 'now', () => scenario === 'stale' ? AT + subject.PRICE_WINDOW_MS : AT)
        t.mock.method(fs, 'readFileSync', file => {
          reads.push(file)
          if (scenario === 'no-prepared-build' && file === path.join(subject.TENTH_DIRECTORY, 'preflight.json')) return '{}'
          return evidence.verification.read(file)
        })
        t.mock.method(fs, 'existsSync', file => { probes.push(file); return scenario === 'no-prepared-build' && file === subject.assessmentPaths().budgetFile })
        const counts = denySensitiveOperations(t)
        const args = scenario === 'missing-pin' ? base.filter(arg => !arg.startsWith('--price-verification')) : scenario === 'wrong-pin' ? base.map(arg => arg.startsWith('--price-verification') ? '--price-verification-sha256=' + '0'.repeat(64) : arg) : base
        assert.equal(await subject.main(args), 2)
        assert.equal(reads.length, scenario === 'missing-pin' ? 0 : scenario === 'stale' || scenario === 'wrong-pin' ? 1 : scenario === 'no-prepared-build' ? 3 : 2)
        assert.ok(reads.every(file => file.startsWith(subject.TENTH_DIRECTORY + path.sep)))
        assert.ok(probes.every(file => file === subject.assessmentPaths().budgetFile || file === subject.TENTH_DIRECTORY || file.startsWith(subject.TENTH_DIRECTORY + path.sep)))
        assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
      } finally { t.mock.restoreAll() }
    }
  }
})

test('R10 exact original durable outline approval, no replay/revision2 and clean prepared source/bundle receipts remain mandatory', async t => {
  {
  const f = fixture('r10-write', {}, 'r10'), bundle = path.join(f.directory, 'synthetic-unbuilt-bundle.cjs'), calls = []
    fs.writeFileSync(bundle, 'SYNTHETIC unbuilt bytes, never executable')
    const state = { stateId: 'synthetic-state', sessionId: 'synthetic-session', originalTask: subject.TASK, targetChars: 8000, status: 'awaiting_outline_confirmation', outlineRevision: 1, outlineHash: '1'.repeat(16), approvedOutline: null, assumptions: [],
      slots: Object.entries(subject.ANSWERS).map(([id, answer]) => ({ id, label: id, required: true, answer, source: 'user' })), answers: Object.values(subject.ANSWERS).map((value, index) => ({ questionId: 'q' + index, value, source: 'user', decision: 'answer' })), outline: { title: 'SYNTHETIC original outline', targetChars: 8000, sections: [] } }
    const outline = { schemaVersion: 1, taskHash: subject.sha(subject.TASK), bundleSha256: subject.sha(fs.readFileSync(bundle)), sessionId: state.sessionId, outlineHash: state.outlineHash, state, approval: 'pending_explicit_root_confirmation' }
    fs.writeFileSync(path.join(f.r6, 'outline.json'), JSON.stringify(outline))
    fs.writeFileSync(path.join(f.r6, 'outline-attempt.json'), 'SYNTHETIC consumed R10 marker')
    const command = async (_, args) => {
      calls.push(args)
      if (args[0] === 'status') return { code: 0, events: [{ type: 'state', data: state }] }
      if (args[0] === 'list') return { code: 0, events: [{ type: 'list', data: { runs: [], sessions: [{ session_id: state.sessionId }] } }] }
      assert.equal(args[0], 'confirm'); assert.equal(args[3], state.outlineHash)
      return { code: 2, stderr: 'SYNTHETIC interruption: no prose or completed artifact', events: [] }
    }
    redirectPaidPaths(t, f, subject.TENTH_DIRECTORY)
    try {
      await assert.rejects(subject.writePhase({ directory: subject.TENTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: '2'.repeat(16) }), /exact saved/)
      assert.equal(calls.length, 0)
      const marker = fs.readFileSync(path.join(subject.TENTH_DIRECTORY, 'outline-attempt.json'))
      const result = await subject.writePhase({ directory: subject.TENTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: state.outlineHash })
      assert.equal(result.status, 'incomplete'); assert.deepEqual(calls.map(args => args[0]), ['status', 'list', 'confirm'])
      assert.deepEqual(fs.readFileSync(path.join(subject.TENTH_DIRECTORY, 'outline-attempt.json')), marker)
      assert.equal(JSON.parse(fs.readFileSync(path.join(subject.TENTH_DIRECTORY, 'explicit-outline-approval.json'))).outlineRevision, 1)
      const count = calls.length
      await assert.rejects(subject.writePhase({ directory: subject.TENTH_DIRECTORY, bundle, relay: {}, command, approvedOutlineHash: state.outlineHash }), /replay/)
      assert.equal(calls.length, count); assert.equal(f.ledger.snapshot().requestsUsed, 0)
    } finally { t.mock.restoreAll() }
    const revision = fixture('r10-result-revision', {}, 'r10')
    const outlineCommand = async (_, args) => ({ code: 0, events: [{ type: 'state', data: args[0] === 'write' ? { status: 'outline_ready', sessionId: 'SYNTHETIC-session' } : { status: 'awaiting_outline_confirmation', sessionId: 'SYNTHETIC-session', targetChars: 8000, outlineRevision: 2, outlineHash: '1'.repeat(16), approvedOutline: null } }] })
    redirectPaidPaths(t, revision, subject.TENTH_DIRECTORY)
    try {
      await assert.rejects(subject.outlinePhase({ directory: subject.TENTH_DIRECTORY, bundle: 'SYNTHETIC never executed', relay: {}, command: outlineCommand }), /original revision1/)
      assert.equal(fs.existsSync(path.join(subject.TENTH_DIRECTORY, 'outline.json')), false)
    } finally { t.mock.restoreAll() }
  }
  {
  const f = fixture('r10-build-receipt', {}, 'r10'), root = path.join(f.directory, 'source'), directory = f.r6
    const sourceFiles = new Map([['package.json', JSON.stringify({ version: '1.3.1' })], ['package-lock.json', JSON.stringify({ version: '1.3.1', packages: { '': { version: '1.3.1' } } })], ['src/cli/build.mjs', 'SYNTHETIC builder'], ['src/cli/main.ts', 'SYNTHETIC source']])
    for (const [name, content] of sourceFiles) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content) }
    fs.mkdirSync(path.join(directory, 'build'), { recursive: true })
    const bundle = 'SYNTHETIC never executable'
    const baseline = { sourceCommit: 'e'.repeat(40), sourceDirty: false, application: { name: 'deepwriter-cli', version: '1.3.1' }, source: { packageSha256: subject.sha(sourceFiles.get('package.json')), lockSha256: subject.sha(sourceFiles.get('package-lock.json')) },
      buildPolicy: { entrypoint: 'src/cli/main.ts', implementation: 'src/cli/build.mjs', implementationSha256: subject.sha(sourceFiles.get('src/cli/build.mjs')), platform: 'node', format: 'cjs', target: 'node22' }, inputs: [{ name: 'src/cli/main.ts', sha256: subject.sha(sourceFiles.get('src/cli/main.ts')) }] }
    const save = (overrides = {}) => {
      const receipt = JSON.stringify({ ...baseline, ...overrides })
      fs.writeFileSync(path.join(directory, 'build/deepwriter.cjs'), bundle); fs.writeFileSync(path.join(directory, 'build/cli-build.json'), receipt)
      fs.writeFileSync(path.join(directory, 'preflight.json'), JSON.stringify({ bundleSha256: subject.sha(bundle), buildReceiptSha256: subject.sha(receipt) }))
    }
    save(); redirectPaidPaths(t, f, subject.TENTH_DIRECTORY)
    try {
      const verify = () => subject.verifyPreparedBuild({ root, directory: subject.TENTH_DIRECTORY })
      assert.equal(verify().receipt.sourceCommit, baseline.sourceCommit)
      for (const overrides of [{ sourceDirty: true }, { sourceDirty: undefined }, { sourceCommit: 'unknown' }, { sourceCommit: undefined }]) { save(overrides); assert.throws(verify, /frozen clean commit/) }
      save(); fs.writeFileSync(path.join(directory, 'build/deepwriter.cjs'), bundle + ' changed'); assert.throws(verify, /coherent CLI/)
      save(); fs.writeFileSync(path.join(directory, 'build/cli-build.json'), JSON.stringify({ ...baseline, sourceCommit: 'f'.repeat(40) })); assert.throws(verify, /receipt is absent or changed/)
      save(); fs.writeFileSync(path.join(root, 'src/cli/main.ts'), 'SYNTHETIC changed'); assert.throws(verify, /source changed/)
    } finally { t.mock.restoreAll() }
  }
})

test('R10 original 11calls/4.318414 TEMP history retains auth/start/caps, same all-miss null-actual accounting, atomic pin and budget red', async t => {
  {
  const f = fixture('r10-original-history', {}, 'r10'), evidence = r10PeakEvidence()
    const { spentUpperCny, inflightReservedCny, cumulativeSpentUpperCny, cumulativeRequests, ...prior } = f.old.snapshot()
    prior.attempts = Array.from({ length: 39 }, (_, index) => ({ id: index + 1, phase: 'SYNTHETIC immutable original R1-R9 history', requestHash: 'd'.repeat(64), reservedMicros: 20000, status: 'settled', reservedAt: AT - 1000 + index, settledAt: AT - 900 + index, outcome: 'success', chargedUpperMicros: index === 38 ? 16343 : 8000, actualMicros: null }))
    Object.assign(prior.attempts.at(-1), { pricingMode: 'r9_peak_price_upper_bound_only', effectivePriceBound: r9PeakEvidence().receipt.effectivePriceBound, priceVerificationSha256: 'e'.repeat(64), actualAmountConfirmed: false })
    prior.requestsUsed = 39; prior.spentUpperMicros = 320343
    fs.writeFileSync(f.file, JSON.stringify(prior))
    let changed = false
    const read = file => changed && file.endsWith('source.html') ? Buffer.from('SYNTHETIC source drift') : evidence.verification.read(file)
    const noDiscount = { ...helpers, computeSampleCost: () => { throw new Error('R10 may not apply old discount or claim actual billing') } }
    const ledger = subject.createLedger({ file: f.file, authorization: f.auth, profile, helpers: noDiscount, phase: 'write', directory: subject.TENTH_DIRECTORY, priceVerification: { ...evidence.verification, read }, now: () => PEAK_AT })
    assert.equal(f.auth.maxRequests - ledger.snapshot().requestsUsed, 11)
    assert.equal(Math.round((f.auth.maxCostCny - ledger.snapshot().spentUpperCny) * 1e6), 4318414)
    const id = ledger.reserve(body()), pending = ledger.snapshot().attempts.at(-1), held = ledger.snapshot().inflightReservedMicros
    assert.equal(pending.id, 40); assert.equal(pending.pricingMode, 'r10_peak_price_upper_bound_only')
    assert.equal(pending.reservedMicros, Math.ceil(helpers.utf8BodyTokenCeiling(body()).ceiling * 2 + 4096 * 8))
    assert.equal(pending.priceVerificationSha256, evidence.verification.expectedSha256)
    assert.deepEqual(pending.effectivePriceBound, evidence.receipt.effectivePriceBound)
    const durable = fs.readFileSync(f.file, 'utf8')
    changed = true
    assert.throws(() => ledger.reserve(body())); assert.throws(() => ledger.settle(id, { prompt_tokens: 100, completion_tokens: 100 }, 'success'))
    assert.equal(ledger.snapshot().inflightReservedMicros, held); assert.equal(fs.readFileSync(f.file, 'utf8'), durable)
    changed = false
    const drift = JSON.parse(durable); drift.attempts.at(-1).pricingMode = 'r9_peak_price_upper_bound_only'
    fs.writeFileSync(f.file, JSON.stringify(drift))
    assert.throws(() => ledger.settle(id, { prompt_tokens: 100, completion_tokens: 100 }, 'success'), /reserved pin|ledger/)
    assert.equal(ledger.snapshot().inflightReservedMicros, held); fs.writeFileSync(f.file, durable)
    ledger.settle(id, { prompt_tokens: 100, completion_tokens: 100, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 0 }, 'success')
    const last = ledger.snapshot().attempts.at(-1)
    assert.equal(last.chargedUpperMicros, 1000); assert.equal(last.actualMicros, null); assert.equal(last.actualAmountConfirmed, false)
    assert.deepEqual(ledger.snapshot().attempts.slice(0, 39), prior.attempts)
    assert.equal(ledger.snapshot().startedAt, prior.startedAt); assert.equal(ledger.snapshot().authorizationHash, prior.authorizationHash)
    assert.deepEqual(ledger.snapshot().authorization, prior.authorization); assert.equal(ledger.snapshot().priceProfileHash, prior.priceProfileHash)
    for (let count = 0; count < 10; count++) {
      const failed = ledger.reserve(body()), full = ledger.snapshot().attempts.at(-1).reservedMicros
      ledger.settle(failed, null, 'SYNTHETIC failed attempt keeps original full reservation')
      assert.equal(ledger.snapshot().attempts.at(-1).chargedUpperMicros, full); assert.equal(ledger.snapshot().attempts.at(-1).actualMicros, null)
    }
    assert.equal(ledger.snapshot().requestsUsed, 50); assert.equal(ledger.snapshot().cumulativeRequests, 80)
    const before = fs.readFileSync(f.file, 'utf8')
    try {
      const counts = denySensitiveOperations(t)
      assert.throws(() => ledger.reserve(body()), /request guard/)
      assert.equal(fs.readFileSync(f.file, 'utf8'), before)
      assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
    } finally { t.mock.restoreAll() }
    assert.deepEqual(ledger.snapshot().attempts.slice(0, 39), prior.attempts)
  }
  {
  const input = helpers.utf8BodyTokenCeiling(body()).ceiling
    const base = (input + 4096 * 4) / 1e6, peak = (input * 2 + 4096 * 8) / 1e6
    const remaining = (base + peak) / 2
    const affordable = fixture('r10-peak-base-control', { maxCostCny: remaining }, 'r10')
    assert.doesNotThrow(() => affordable.old.reserve(body()))
    const f = r10PeakFixture('r10-peak-budget-red', { maxCostCny: remaining }), before = fs.readFileSync(f.file, 'utf8')
    try {
      const counts = denySensitiveOperations(t)
      assert.throws(() => f.peak.reserve(body()), /financial cap/)
      assert.equal(fs.readFileSync(f.file, 'utf8'), before)
      assert.equal(f.peak.snapshot().requestsUsed, 0); assert.equal(f.peak.snapshot().inflightReservedMicros, 0)
      assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
    } finally { t.mock.restoreAll() }
  }
})
test('R11 explicit supplemental owner pin alone grants 40 requests, rejects drift, and preserves original financial history', async t => {
  // Synthetic TEMP history at the ORIGINAL 80-request boundary. No actual
  // owner receipt, paid ledger, CLI/key/runtime or remote request is accessed.
  const directory = path.join(suite, 'r11-owner-extension'), r6 = path.join(directory, 'r11')
  const file = path.join(directory, 'ledger.json'), lock = path.join(directory, 'shared.lock')
  fs.mkdirSync(r6, { recursive: true })
  subject.createLedger({ file, authorization, profile, helpers, phase: 'SYNTHETIC prior history', now: () => AT })
  const original = JSON.parse(fs.readFileSync(file, 'utf8'))
  original.requestsUsed = 50; original.spentUpperMicros = 456779
  original.attempts = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, phase: 'SYNTHETIC prior history', reservedMicros: 20000, chargedUpperMicros: index === 49 ? 15779 : 9000, status: 'settled', outcome: 'SYNTHETIC preserved original outcome', actualMicros: null, reservedAt: AT, settledAt: AT }))
  fs.writeFileSync(file, JSON.stringify(original, null, 2) + '\n')
  const originalBytes = fs.readFileSync(file, 'utf8')
  const receipt = { schemaVersion: 1, purpose: 'r11_owner_request_guard_extension_only', assessment: 'r11', ownerApproval: 'explicit_user_approval', originalAuthorizationHash: original.authorizationHash, financialStartedAt: original.startedAt, originalCumulativeRequestGuard: 80, additionalRequests: 40, effectiveCumulativeRequestGuard: 120, ownerCapCny: 5, approvedAt: new Date(PEAK_AT).toISOString() }
  const validBytes = Buffer.from(JSON.stringify(receipt))
  let receiptBytes = validBytes
  const extension = { expectedSha256: subject.sha(validBytes), read: candidate => {
    assert.equal(candidate, path.join(subject.ELEVENTH_DIRECTORY, 'owner-request-extension.json'))
    return receiptBytes
  } }
  const verify = extra => subject.verifyRequestExtension({ directory: subject.ELEVENTH_DIRECTORY, authorization, originalAuthorizationHash: original.authorizationHash, financialStartedAt: original.startedAt, at: PEAK_AT, ...extension, ...extra })
  const evidence = peakEvidence(price => { price.purpose = 'r11_peak_price_upper_bound_only' }, 'r11')
  const args = { file, authorization, profile, helpers, phase: 'outline', directory: subject.ELEVENTH_DIRECTORY, priceVerification: evidence.verification, now: () => PEAK_AT }
  assert.equal(subject.assessmentPaths(subject.ELEVENTH_DIRECTORY).budgetFile, subject.assessmentPaths().budgetFile)
  assert.equal(subject.assessmentPaths(subject.ELEVENTH_DIRECTORY).lockFile, subject.assessmentPaths().lockFile)
  assert.throws(() => subject.assessmentPaths(path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r15')))
  assert.equal(verify().effectiveLedgerRequestGuard, 90)
  assert.equal(verify().effectiveCumulativeRequestGuard, 120)
  assert.throws(() => subject.createLedger(args), /supplemental/)
  assert.throws(() => subject.createLedger({ ...args, directory: subject.TENTH_DIRECTORY, requestExtension: extension }), /restricted/)
  assert.equal(fs.readFileSync(file, 'utf8'), originalBytes)

  // A new pin cannot authorize a different original identity, fee or scope.
  for (const mutation of [r => { r.additionalRequests = 41 }, r => { r.effectiveCumulativeRequestGuard = 121 }, r => { r.ownerCapCny = 6 }, r => { r.originalAuthorizationHash = '0'.repeat(64) }, r => { r.financialStartedAt++ }, r => { r.assessment = 'r10' }, r => { r.approvedAt = new Date(PEAK_AT + 1).toISOString() }]) {
    const changed = structuredClone(receipt); mutation(changed)
    const bytes = Buffer.from(JSON.stringify(changed))
    assert.throws(() => verify({ expectedSha256: subject.sha(bytes), read: () => bytes }))
  }
  assert.throws(() => verify({ expectedSha256: '0'.repeat(64) }), /missing or changed/)
  assert.equal(fs.readFileSync(file, 'utf8'), originalBytes)

  const ledger = subject.createLedger({ ...args, requestExtension: extension })
  assert.equal(fs.readFileSync(file, 'utf8'), originalBytes)
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, phase: 'outline' }))
  const prepared = { authorization, bundleSha256: 'b'.repeat(64), buildReceiptSha256: 'c'.repeat(64) }
  redirectPaidPaths(t, { r6, file, lock }, subject.ELEVENTH_DIRECTORY)
  try {
    const marker = subject.claimR11OutlineAttempt({ directory: subject.ELEVENTH_DIRECTORY, prepared, ledger, now: () => PEAK_AT })
    assert.equal(marker.assessment, 'r11'); assert.equal(marker.outlineRevision, 1)
    assert.equal(marker.authorizationHash, original.authorizationHash); assert.equal(marker.financialStartedAt, original.startedAt)
    assert.throws(() => subject.claimR11OutlineAttempt({ directory: subject.ELEVENTH_DIRECTORY, prepared, ledger, now: () => PEAK_AT }), /already exists/)
    await assert.rejects(subject.prepare({ directory: subject.ELEVENTH_DIRECTORY }), /already exists/)
    await assert.rejects(subject.reoutlinePhase({ directory: subject.ELEVENTH_DIRECTORY }), /never permits/)
    assert.equal(fs.readFileSync(file, 'utf8'), originalBytes)
  } finally { t.mock.restoreAll() }

  receiptBytes = Buffer.from('SYNTHETIC owner-pin drift')
  assert.throws(() => ledger.reserve(body()), /missing or changed/)
  assert.equal(fs.readFileSync(file, 'utf8'), originalBytes)
  receiptBytes = validBytes
  const id = ledger.reserve(body()), reserved = ledger.snapshot(), pendingBytes = fs.readFileSync(file, 'utf8')
  assert.equal(id, 51); assert.equal(reserved.authorization.maxRequests, 50)
  const attempt = reserved.attempts.at(-1)
  assert.equal(attempt.requestExtensionReceiptSha256, extension.expectedSha256)
  assert.equal(attempt.effectiveCumulativeRequestGuard, 120); assert.equal(attempt.effectiveLedgerRequestGuard, 90)
  assert.equal(attempt.reservedMicros, helpers.utf8BodyTokenCeiling(body()).ceiling * 2 + 4096 * 8)
  receiptBytes = Buffer.from('SYNTHETIC settlement owner-pin drift')
  assert.throws(() => ledger.settle(id, { prompt_tokens: 100, completion_tokens: 100 }, 'success'), /missing or changed/)
  assert.equal(fs.readFileSync(file, 'utf8'), pendingBytes)
  assert.equal(ledger.snapshot().inflightReservedMicros, attempt.reservedMicros)
  receiptBytes = validBytes
  ledger.settle(id, { prompt_tokens: 100, completion_tokens: 100, prompt_cache_hit_tokens: 100 }, 'success')
  assert.equal(ledger.snapshot().attempts.at(-1).chargedUpperMicros, 1000)
  assert.equal(ledger.snapshot().attempts.at(-1).actualMicros, null)
  assert.equal(ledger.snapshot().attempts.at(-1).actualAmountConfirmed, false)
  for (let count = 1; count < 40; count++) {
    const next = ledger.reserve(body())
    ledger.settle(next, { prompt_tokens: 1, completion_tokens: 1 }, 'success')
  }
  const final = ledger.snapshot(), capBytes = fs.readFileSync(file, 'utf8')
  assert.equal(final.requestsUsed, 90); assert.equal(final.cumulativeRequests, 120)
  assert.throws(() => ledger.reserve(body()), /request guard/)
  assert.equal(fs.readFileSync(file, 'utf8'), capBytes)
  assert.deepEqual(final.attempts.slice(0, 50), original.attempts)
  assert.deepEqual(final.authorization, original.authorization)
  assert.equal(final.authorizationHash, original.authorizationHash); assert.equal(final.startedAt, original.startedAt)
  assert.equal(final.authorization.ownerCapCny, 5); assert.equal(final.authorization.internalCumulativeRequestGuard, 80)
  assert.equal(final.authorization.maxCostCny, original.authorization.maxCostCny); assert.equal(final.authorization.maxRequests, 50)
  assert.equal(final.inflightReservedMicros, 0); assert.equal(final.hardCapProtected, true)

  // Missing/duplicate/foreign explicit pins and unknown leaves never reach IO.
  const price = '--price-verification-sha256=' + evidence.verification.expectedSha256
  const owner = '--request-extension-sha256=' + extension.expectedSha256
  const base = ['--real', '--assessment=r11', '--phase=outline', price]
  try {
    t.mock.method(fs, 'existsSync', () => { throw new Error('Invalid flags must precede IO') })
    t.mock.method(fs, 'readFileSync', () => { throw new Error('Invalid flags must precede IO') })
    const counts = denySensitiveOperations(t)
    for (const flags of [base, [...base, owner, owner], [...base, owner, '--outline-revision=2'], [...base, owner, '--continue'], [...base, owner, '--phase=reoutline'], ['--real', '--assessment=r10', '--phase=outline', price, owner], ['--real', '--assessment=r15', '--phase=outline', price, owner]]) assert.equal(await subject.main(flags), 2)
    assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
  } finally { t.mock.restoreAll() }
})



function r12OwnerFixture(id) {
  const directory = path.join(suite, id), r6 = path.join(directory, 'r12'), file = path.join(directory, 'ledger.json'), lock = path.join(directory, 'shared.lock')
  fs.mkdirSync(r6, { recursive: true })
  subject.createLedger({ file, authorization, profile, helpers, phase: 'SYNTHETIC original history', now: () => AT })
  const original = JSON.parse(fs.readFileSync(file, 'utf8'))
  original.requestsUsed = 62; original.spentUpperMicros = 654671
  original.attempts = Array.from({ length: 62 }, (_, index) => ({ id: index + 1, phase: 'SYNTHETIC preserved history including R11', reservedMicros: 50000, chargedUpperMicros: index === 61 ? 44671 : 10000, status: 'settled', outcome: 'SYNTHETIC original outcome', actualMicros: null, reservedAt: AT, settledAt: AT }))
  fs.writeFileSync(file, JSON.stringify(original, null, 2) + '\n')
  const receipt = { schemaVersion: 1, purpose: 'r11_owner_request_guard_extension_only', assessment: 'r11', ownerApproval: 'explicit_user_approval', originalAuthorizationHash: original.authorizationHash, financialStartedAt: original.startedAt, originalCumulativeRequestGuard: 80, additionalRequests: 40, effectiveCumulativeRequestGuard: 120, ownerCapCny: 5, approvedAt: new Date(PEAK_AT).toISOString() }
  const validBytes = Buffer.from(JSON.stringify(receipt)), state = { bytes: validBytes }
  const extension = { expectedSha256: subject.sha(validBytes), read: candidate => {
    assert.equal(candidate, path.join(subject.ELEVENTH_DIRECTORY, 'owner-request-extension.json'))
    return state.bytes
  } }
  const evidence = peakEvidence(price => { price.purpose = 'r12_peak_price_upper_bound_only' }, 'r12')
  const args = { file, authorization, profile, helpers, phase: 'outline', directory: subject.TWELFTH_DIRECTORY, priceVerification: evidence.verification, requestExtension: extension, now: () => PEAK_AT }
  return { directory, r6, file, lock, original, receipt, validBytes, state, extension, evidence, args }
}
test('R12 exact fresh leaf reuses the unchanged R11 owner receipt/pin and original ¥5/120 ledger identity only', () => {
  const f = r12OwnerFixture('r12-fixed-original-receipt'), before = fs.readFileSync(f.file, 'utf8')
  const verify = extra => subject.verifyRequestExtension({ directory: subject.TWELFTH_DIRECTORY, authorization, originalAuthorizationHash: f.original.authorizationHash, financialStartedAt: f.original.startedAt, at: PEAK_AT, ...f.extension, ...extra })
  assert.equal(subject.TWELFTH_DIRECTORY, path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r12'))
  assert.equal(subject.assessmentPaths(subject.TWELFTH_DIRECTORY).budgetFile, subject.assessmentPaths().budgetFile)
  assert.equal(subject.assessmentPaths(subject.TWELFTH_DIRECTORY).lockFile, subject.assessmentPaths().lockFile)
  assert.throws(() => subject.assessmentPaths(path.join(subject.ROOT, 'out/commercial-quality/actual-cli-quality-20261003-r15')))
  assert.equal(verify().effectiveLedgerRequestGuard, 90); assert.equal(verify().effectiveCumulativeRequestGuard, 120)
  assert.deepEqual(verify({ directory: subject.ELEVENTH_DIRECTORY }), verify())
  assert.equal(subject.verifyPriceVerification({ directory: subject.TWELFTH_DIRECTORY, ...f.evidence.verification, at: PEAK_AT }).pricingMode, 'r12_peak_price_upper_bound_only')
  for (const mutate of [r => { r.assessment = 'r12' }, r => { r.purpose = 'r12_owner_request_guard_extension_only' }, r => { r.additionalRequests = 41 }, r => { r.ownerCapCny = 6 }, r => { r.originalAuthorizationHash = '0'.repeat(64) }]) {
    const changed = structuredClone(f.receipt); mutate(changed)
    const bytes = Buffer.from(JSON.stringify(changed))
    assert.throws(() => verify({ expectedSha256: subject.sha(bytes), read: () => bytes }))
  }
  assert.throws(() => verify({ expectedSha256: '0'.repeat(64) }), /missing or changed/)
  assert.equal(fs.readFileSync(f.file, 'utf8'), before)
})
test('R12 same owner pin is rechecked on reserve/settle, retains prior R11 history and refuses beyond cumulative120', () => {
  const f = r12OwnerFixture('r12-financial-preservation'), before = fs.readFileSync(f.file, 'utf8')
  const ledger = subject.createLedger(f.args)
  assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  f.state.bytes = Buffer.from('SYNTHETIC original owner receipt drift')
  assert.throws(() => ledger.reserve(body()), /missing or changed/)
  assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  f.state.bytes = f.validBytes
  const id = ledger.reserve(body()), pending = ledger.snapshot(), pendingBytes = fs.readFileSync(f.file, 'utf8')
  assert.equal(id, 63); assert.equal(pending.attempts.at(-1).requestExtensionReceiptSha256, f.extension.expectedSha256)
  f.state.bytes = Buffer.from('SYNTHETIC settlement owner receipt drift')
  assert.throws(() => ledger.settle(id, { prompt_tokens: 1, completion_tokens: 1 }, 'success'), /missing or changed/)
  assert.equal(fs.readFileSync(f.file, 'utf8'), pendingBytes)
  assert.equal(ledger.snapshot().inflightReservedMicros, pending.inflightReservedMicros)
  f.state.bytes = f.validBytes
  ledger.settle(id, { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 1 }, 'success')
  for (let count = 1; count < 28; count++) { const next = ledger.reserve(body()); ledger.settle(next, { prompt_tokens: 1, completion_tokens: 1 }, 'success') }
  const final = ledger.snapshot(), capBytes = fs.readFileSync(f.file, 'utf8')
  assert.equal(final.requestsUsed, 90); assert.equal(final.cumulativeRequests, 120)
  assert.throws(() => ledger.reserve(body()), /request guard/); assert.equal(fs.readFileSync(f.file, 'utf8'), capBytes)
  assert.deepEqual(final.attempts.slice(0, 62), f.original.attempts)
  assert.deepEqual(final.authorization, f.original.authorization)
  assert.equal(final.authorizationHash, f.original.authorizationHash); assert.equal(final.startedAt, f.original.startedAt)
  assert.equal(final.authorization.ownerCapCny, 5); assert.equal(final.authorization.maxRequests, 50)
  assert.equal(final.authorization.internalCumulativeRequestGuard, 80); assert.equal(final.authorization.maxCostCny, f.original.authorization.maxCostCny)
  assert.equal(final.attempts.at(-1).actualMicros, null); assert.equal(final.attempts.at(-1).actualAmountConfirmed, false)
  assert.equal(final.attempts.at(-1).chargedUpperMicros, 10); assert.equal(final.inflightReservedMicros, 0)
})
test('R12 independent source/one-shot marker rejects preparation replay, revision2, absent or duplicate owner pin before key/egress', async t => {
  const f = r12OwnerFixture('r12-exclusive-marker'), before = fs.readFileSync(f.file, 'utf8'), ledger = subject.createLedger(f.args)
  fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid, phase: 'outline' }))
  const prepared = { authorization, bundleSha256: 'd'.repeat(64), buildReceiptSha256: 'e'.repeat(64) }
  redirectPaidPaths(t, f, subject.TWELFTH_DIRECTORY)
  try {
    const marker = subject.claimR12OutlineAttempt({ directory: subject.TWELFTH_DIRECTORY, prepared, ledger, now: () => PEAK_AT })
    assert.equal(marker.assessment, 'r12'); assert.equal(marker.outlineRevision, 1)
    assert.equal(marker.bundleSha256, prepared.bundleSha256); assert.equal(marker.authorizationHash, f.original.authorizationHash)
    assert.equal(marker.financialStartedAt, f.original.startedAt)
    assert.throws(() => subject.claimR12OutlineAttempt({ directory: subject.TWELFTH_DIRECTORY, prepared, ledger, now: () => PEAK_AT }), /already exists/)
    await assert.rejects(subject.prepare({ directory: subject.TWELFTH_DIRECTORY }), /already exists/)
    await assert.rejects(subject.reoutlinePhase({ directory: subject.TWELFTH_DIRECTORY }), /never permits/)
    await assert.rejects(subject.writePhase({ directory: subject.TWELFTH_DIRECTORY, outlineRevision: 2 }), /revision1/)
    assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  } finally { t.mock.restoreAll() }
  const price = '--price-verification-sha256=' + f.evidence.verification.expectedSha256, owner = '--request-extension-sha256=' + f.extension.expectedSha256
  const base = ['--real', '--assessment=r12', '--phase=outline', price]
  try {
    t.mock.method(fs, 'existsSync', () => { throw new Error('Invalid flags precede IO') })
    t.mock.method(fs, 'readFileSync', () => { throw new Error('Invalid flags precede IO') })
    const counts = denySensitiveOperations(t)
    for (const flags of [base, [...base, owner, owner], [...base, owner, '--outline-revision=2'], [...base, owner, '--continue'], [...base, owner, '--phase=reoutline'], ['--real', '--assessment=r15', '--phase=outline', price, owner]]) assert.equal(await subject.main(flags), 2)
    assert.deepEqual(counts, { writes: 0, loads: 0, network: 0 })
  } finally { t.mock.restoreAll() }
})
