const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const esbuild = require('esbuild')

// Exercise the isolated production policy without Electron, SQLite, adapters,
// network, or a real clock. Public engine-boundary coverage remains in
// p0-1-provider-budget.ts and p1-token-budget.ts.
const built = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/main/jobs/providerBudgetPolicy.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent'
})
const loaded = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
const policy = loaded.exports
const NOW = 10_000
const clone = value => structuredClone(value)
const state = (budget = {}) => policy.makeRunBudgetState('fixture', { providerCallBudget: budget }, NOW, NOW)
const errorCode = code => error => error instanceof policy.RunBudgetExceededError && error.code === code
const request = { bodyJson: '{"content":"中文😀"}', maxTokens: 7 }
const quote = (amount, currency = 'USD') => ({ status: 'estimated', amount, currency, priceSnapshotId: 'fixture-price' })

test('configuration keeps legacy defaults, frozen-contract precedence and absolute ceilings', () => {
  assert.equal(policy.RUN_PROVIDER_CALL_ABSOLUTE_CAP, 512)
  assert.deepEqual(state().limits, { maxCalls: 16, maxTokens: 2_000_000, maxCost: null, maxCostCny: null, maxWallClockMs: 1_800_000 })
  assert.deepEqual(state({ maxCalls: 999, maxTokens: 1e12, maxCostCny: 1e12, maxWallClockMs: 1e12 }).limits, {
    maxCalls: 512, maxTokens: 20_000_000, maxCost: { amount: 100_000, currency: 'CNY', unknownPolicy: 'deny' }, maxCostCny: 100_000, maxWallClockMs: 86_400_000
  })
  assert.equal(policy.runBudgetLimits({ providerCallBudget: { maxCalls: 50 }, completionContract: { providerCallBudget: { maxCalls: 3 }, tokenBudget: 400 } }).maxCalls, 3)
  assert.equal(policy.runBudgetLimits({ completionContract: { tokenBudget: 400, wallClockBudgetMs: 500 } }).maxTokens, 400)
  assert.deepEqual(state({ maxCost: { amount: -1, currency: 'USD' } }).limits.maxCost, { amount: 0, currency: null, unknownPolicy: 'deny' })
})

test('legacy v1 snapshots retain counters and CNY policy while restore only tightens limits', () => {
  const legacy = clone(state({ maxCalls: 999, maxTokens: 1e12, maxCostCny: 12 }))
  delete legacy.limits.maxCost
  for (const field of ['spentTokenUpper', 'tokenReservations', 'settledTokenReservations', 'tokenReservationCorrupt']) delete legacy[field]
  legacy.totalCalls = 600
  legacy.startedAt = NOW + 60_000
  assert.equal(policy.validBudgetState(legacy, 'fixture'), true)
  assert.equal(policy.validBudgetState(legacy, 'another-run'), false)
  const restored = policy.normalizeBudgetState(legacy, NOW)
  assert.equal(restored.totalCalls, 600)
  assert.equal(restored.startedAt, NOW)
  assert.equal(restored.tokenReservationCorrupt, false)
  assert.deepEqual(restored.limits.maxCost, { amount: 12, currency: 'CNY', unknownPolicy: 'deny' })
  const tighter = policy.tighterRunBudgetLimits(restored.limits, state({ maxCalls: 5, maxTokens: 1_000 }).limits)
  assert.equal(tighter.maxCalls, 5)
  assert.equal(tighter.maxTokens, 1_000)
  assert.deepEqual(tighter.maxCost, restored.limits.maxCost)
  assert.deepEqual(policy.tighterRunBudgetLimits(restored.limits, state({ maxCost: { amount: 5, currency: 'USD' } }).limits).maxCost, { amount: 0, currency: null, unknownPolicy: 'deny' })
})

test('restored duplicate and contradictory token ledgers remain hard denies', () => {
  const original = state()
  policy.reserveProviderTokenBudget(original, 'logical', 1, request, NOW)
  const duplicate = clone(original)
  duplicate.tokenReservations.push(clone(duplicate.tokenReservations[0]))
  const restored = policy.normalizeBudgetState(duplicate, NOW)
  assert.equal(restored.tokenReservationCorrupt, true)
  assert.equal(restored.tokenReservations.length, 1)
  assert.throws(() => policy.reserveProviderAttemptBudget(restored, 'writer', 1, false, NOW), errorCode('run_token_budget'))
  const contradiction = clone(original)
  contradiction.settledTokenReservations.push({ reservationId: 'logical\0' + '1', chargedTokens: 3, settledAt: NOW })
  assert.equal(policy.normalizeBudgetState(contradiction, NOW).tokenReservationCorrupt, true)
  const malformed = clone(original)
  malformed.tokenReservations[0].totalTokens++
  assert.equal(policy.normalizeBudgetState(malformed, NOW).tokenReservationCorrupt, true)
})

test('cost reservations admit an exact currency-bound cap and reject unknown/mixed quotes without changes', () => {
  const ledger = state({ maxCost: { amount: 10, currency: 'USD' } })
  policy.assertCostReservation(ledger, quote(4, ' usd '))
  policy.assertCostReservation(ledger, quote(6))
  assert.equal(ledger.reservedCost, 10)
  assert.equal(ledger.reservedCostAttempts, 2)
  const before = clone(ledger)
  assert.throws(() => policy.assertCostReservation(ledger, quote(0.01)), errorCode('run_cost_budget'))
  assert.throws(() => policy.assertCostReservation(ledger, quote(0, 'CNY')), errorCode('run_cost_currency_mismatch'))
  assert.throws(() => policy.assertCostReservation(ledger, undefined), errorCode('run_cost_unknown_price'))
  assert.deepEqual(ledger, before)
  const denied = state({ maxCost: { amount: 0, currency: null } })
  policy.reserveProviderAttemptBudget(denied, 'writer', 1, false, NOW)
  assert.throws(() => policy.assertCostReservation(denied, quote(1)), errorCode('run_cost_budget'))
})

test('call, retry, wall-clock and bounded-repair gates run before counter mutations', () => {
  const ledger = state({ maxCalls: 2, maxWallClockMs: 100 })
  policy.reserveProviderAttemptBudget(ledger, 'critic', 1, false, NOW)
  policy.reserveProviderAttemptBudget(ledger, 'critic', 2, false, NOW)
  assert.equal(ledger.totalCalls, 2)
  assert.deepEqual(ledger.callsByActor, { writer: 0, critic: 2, editor: 0 })
  assert.deepEqual(ledger.retriesByActor, { writer: 0, critic: 1, editor: 0 })
  const before = clone(ledger)
  assert.throws(() => policy.reserveProviderAttemptBudget(ledger, 'writer', 1, true, NOW), errorCode('run_provider_call_cap'))
  assert.deepEqual(ledger, before)
  assert.throws(() => policy.reserveProviderAttemptBudget(ledger, 'writer', 1, false, NOW + 100), errorCode('run_wall_clock_budget'))
  const repairs = state()
  policy.reserveProviderAttemptBudget(repairs, 'writer', 1, true, NOW)
  policy.reserveProviderAttemptBudget(repairs, 'writer', 1, true, NOW)
  assert.throws(() => policy.reserveProviderAttemptBudget(repairs, 'writer', 1, true, NOW), errorCode('run_target_window_repair_exhausted'))
  assert.equal(repairs.targetWindowRepairAttempts, 2)
  assert.equal(repairs.totalCalls, 2)
})

test('token bounds retain exact-cap, monotonic top-up and settlement tombstone semantics', () => {
  const bound = policy.estimateProviderTokenUpperBound(request)
  assert.ok(bound.inputTokens >= Buffer.byteLength(request.bodyJson))
  assert.equal(policy.estimateProviderTokenUpperBound({ maxTokens: 1 }), null)
  assert.equal(policy.estimateProviderTokenUpperBound({ bodyJson: '{}', maxTokens: NaN }), null)
  const ledger = state({ maxTokens: bound.totalTokens })
  assert.equal(policy.reserveProviderTokenBudget(ledger, 'logical', 1, request, NOW), 'changed')
  assert.equal(ledger.reservedInputTokens + ledger.reservedOutputTokens, bound.totalTokens)
  assert.equal(ledger.tokenReservations[0].reservationId, 'logical\0' + '1')
  assert.equal(policy.reserveProviderTokenBudget(ledger, 'logical', 1, request, NOW), 'unchanged')
  const small = state({ maxTokens: bound.totalTokens - 1 })
  assert.throws(() => policy.reserveProviderTokenBudget(small, 'logical', 1, request, NOW), errorCode('run_token_budget'))
  assert.equal(small.reservedTokenAttempts, 0)
  ledger.limits.maxTokens += 100
  assert.equal(policy.reserveProviderTokenBudget(ledger, 'logical', 1, { ...request, bodyJson: 'x'.repeat(50), maxTokens: 1 }, NOW), 'changed')
  assert.equal(ledger.reservedOutputTokens, 7)
  const ids = ledger.tokenReservations.map(({ reservationId, innerAttempt }) => ({ reservationId, innerAttempt }))
  assert.deepEqual(policy.settleProviderTokenBudget(ledger, ids, { inputTokens: 2, outputTokens: 1 }, NOW), { changed: true, overrun: false })
  assert.equal(ledger.spentTokenUpper, 3)
  assert.equal(ledger.reservedTokenAttempts, 0)
  assert.equal(policy.reserveProviderTokenBudget(ledger, 'logical', 1, {}, NOW), 'unchanged')
  assert.deepEqual(policy.settleProviderTokenBudget(ledger, ids, null, NOW), { changed: false, overrun: false })
})

test('restart charges terminal unknown usage once and leaves in-flight attempts reserved', () => {
  const ledger = state()
  policy.reserveProviderTokenBudget(ledger, 'logical', 1, request, NOW)
  policy.reserveProviderTokenBudget(ledger, 'logical', 2, request, NOW)
  const bound = ledger.tokenReservations[0].totalTokens
  const base = { actor: 'writer', logicalCallId: 'logical', inputTokens: null, outputTokens: null, costStatus: 'unknown', costAmount: null, startedAt: NOW }
  const attempts = [{ ...base, attemptNo: 1, outcome: 'error' }, { ...base, attemptNo: 2, outcome: 'in_flight' }]
  const restored = policy.reconcileTokenReservationsFromProviderAttempts(policy.deriveBudgetFromProviderAttempts(ledger, attempts, NOW), attempts, NOW)
  assert.equal(restored.spentTokenUpper, bound)
  assert.equal(restored.reservedTokenAttempts, 1)
  assert.equal(restored.retryCalls, 1)
  assert.equal(restored.unknownTokenCalls, 4)
  assert.equal(restored.unknownCostCalls, 2)
  assert.deepEqual(policy.reconcileTokenReservationsFromProviderAttempts(restored, attempts, NOW), restored)
  const finished = policy.reconcileTokenReservationsFromProviderAttempts(restored, [{ ...base, attemptNo: 2, outcome: 'completed', inputTokens: 2, outputTokens: 1 }], NOW)
  assert.equal(finished.spentTokenUpper, bound + 3)
  assert.equal(finished.reservedTokenAttempts, 0)
  assert.equal(finished.settledTokenReservations.length, 2)
})

test('invalid reservation identity and terminal token overrun retain durable-denial signals', () => {
  const invalid = state()
  assert.equal(policy.reserveProviderTokenBudget(invalid, '', 1, request, NOW), 'corrupt')
  assert.equal(invalid.tokenReservationCorrupt, true)
  const overrun = state()
  policy.reserveProviderTokenBudget(overrun, 'logical', 1, request, NOW)
  const ids = overrun.tokenReservations.map(({ reservationId, innerAttempt }) => ({ reservationId, innerAttempt }))
  assert.deepEqual(policy.settleProviderTokenBudget(overrun, ids, { inputTokens: 1, outputTokens: 10_000 }, NOW), { changed: true, overrun: true })
  assert.equal(overrun.spentTokenUpper, 10_001)
  assert.equal(overrun.tokenReservationCorrupt, true)
  assert.equal(overrun.reservedTokenAttempts, 0)
  assert.throws(() => policy.reserveProviderAttemptBudget(overrun, 'writer', 1, false, NOW), errorCode('run_token_budget'))
})

const unknownAttempt = (logicalCallId, overrides = {}) => ({ actor: 'writer', logicalCallId, attemptNo: 1, outcome: 'success', inputTokens: 10, outputTokens: 5,
  costStatus: 'unknown', costAmount: null, costCurrency: null, startedAt: NOW, ...overrides })
const restoredCost = (ledger, attempts) => policy.deriveBudgetFromProviderAttempts(policy.normalizeBudgetState(JSON.parse(JSON.stringify(ledger)), NOW), attempts, NOW)

test('missing cache billing detail uses each fully charged upper bound across persisted multi-round reservations', () => {
  let ledger = state({ maxCost: { amount: 0.684196, currency: 'USD' } })
  const attempts = []
  for (let round = 1; round <= 4; round++) {
    policy.reserveProviderAttemptBudget(ledger, 'writer', 1, false, NOW)
    const logical = 'missing-cache-' + round
    policy.reserveProviderCostBudget(ledger, logical, 1, quote(0.000194), NOW)
    attempts.push(unknownAttempt(logical))
    policy.settleProviderCostBudget(ledger, [logical + '\0' + '1'], NOW)
    ledger = restoredCost(ledger, attempts)
    assert.equal(ledger.unknownCostCalls, 0)
    assert.equal(ledger.reservedCostAttempts, 0)
    assert.ok(Math.abs(ledger.spentCostUpper - round * 0.000194) < 1e-12)
    assert.deepEqual(restoredCost(ledger, attempts), ledger)
  }
  assert.equal(ledger.costReservations.length, 4)
})

test('real cumulative over-limit and known actual over-reservation cannot hide under another bound', () => {
  const ledger = state({ maxCost: { amount: 1, currency: 'USD' } })
  policy.reserveProviderCostBudget(ledger, 'first', 1, quote(0.4), NOW)
  policy.settleProviderCostBudget(ledger, ['first\0' + '1'], NOW)
  const restored = restoredCost(ledger, [unknownAttempt('first')])
  const before = clone(restored)
  assert.throws(() => policy.reserveProviderCostBudget(restored, 'second', 1, quote(0.7), NOW), errorCode('run_cost_budget'))
  assert.deepEqual(restored, before)
  policy.reserveProviderCostBudget(restored, 'second', 1, quote(0.5), NOW)
  policy.settleProviderCostBudget(restored, ['second\0' + '1'], NOW)
  const actual = restoredCost(restored, [unknownAttempt('first', { costStatus: 'actual', costAmount: 0.8, costCurrency: 'USD' }), unknownAttempt('second')])
  assert.ok(Math.abs(actual.spentCostUpper - 1.3) < 1e-12)
  assert.throws(() => policy.reserveProviderAttemptBudget(actual, 'writer', 1, false, NOW), errorCode('run_cost_budget'))
})

test('an unrelated bound, a legacy scalar or an active reservation cannot cover unbounded unknown costs', () => {
  const ledger = state({ maxCost: { amount: 1, currency: 'USD' } })
  policy.reserveProviderCostBudget(ledger, 'bounded', 1, quote(0.000194), NOW)
  const unresolved = restoredCost(ledger, [unknownAttempt('bounded', { outcome: 'in_flight' }), unknownAttempt('no-bound')])
  assert.equal(unresolved.unknownCostCalls, 1)
  assert.throws(() => policy.reserveProviderAttemptBudget(unresolved, 'writer', 1, false, NOW), errorCode('run_cost_unknown_price'))
  assert.throws(() => policy.assertCostReservation(unresolved, quote(0.1)), errorCode('run_cost_unknown_price'))
  const legacy = state({ maxCost: { amount: 1, currency: 'USD' } })
  legacy.spentCostUpper = 0.000194; legacy.spentCostCurrency = 'USD'
  assert.equal(restoredCost(legacy, [unknownAttempt('no-bound')]).unknownCostCalls, 1)
  const wrongCurrency = restoredCost(ledger, [unknownAttempt('bounded', { costCurrency: 'CNY' })])
  assert.throws(() => policy.reserveProviderAttemptBudget(wrongCurrency, 'writer', 1, false, NOW), errorCode('run_cost_unknown_price'))
})

test('cost reservations retain per-attempt concurrency, top-up and settlement idempotency', () => {
  const ledger = state({ maxCost: { amount: 1, currency: 'USD' } })
  assert.equal(policy.reserveProviderCostBudget(ledger, 'a', 1, quote(0.2), NOW), true)
  assert.equal(policy.reserveProviderCostBudget(ledger, 'a', 1, quote(0.2), NOW), false)
  assert.equal(policy.reserveProviderCostBudget(ledger, 'a', 1, quote(0.3), NOW), true)
  policy.reserveProviderCostBudget(ledger, 'b', 1, quote(0.4), NOW)
  assert.equal(ledger.reservedCostAttempts, 2)
  policy.settleProviderCostBudget(ledger, ['a\0' + '1'], NOW)
  assert.equal(ledger.reservedCostAttempts, 1); assert.ok(Math.abs(ledger.reservedCost - 0.4) < 1e-12)
  const once = clone(ledger)
  assert.equal(policy.settleProviderCostBudget(ledger, ['a\0' + '1'], NOW), false)
  assert.equal(policy.reserveProviderCostBudget(ledger, 'a', 1, quote(0.3), NOW), false)
  assert.deepEqual(ledger, once)
  const reloaded = restoredCost(ledger, [unknownAttempt('a'), unknownAttempt('b', { outcome: 'in_flight' })])
  assert.equal(reloaded.reservedCostAttempts, 1); assert.equal(reloaded.unknownCostCalls, 0)
  assert.throws(() => policy.reserveProviderCostBudget(reloaded, 'c', 1, quote(0.4), NOW), errorCode('run_cost_budget'))
})

test('terminal recovery settles the exact held bound once, and malformed monetary evidence fails closed', () => {
  const ledger = state({ maxCost: { amount: 1, currency: 'USD' } })
  policy.reserveProviderCostBudget(ledger, 'crashed', 1, quote(0.000194), NOW)
  const restored = restoredCost(ledger, [unknownAttempt('crashed')])
  assert.equal(restored.spentCostUpper, 0.000194); assert.equal(restored.reservedCostAttempts, 0)
  assert.equal(restored.unknownCostCalls, 0); assert.deepEqual(restoredCost(restored, [unknownAttempt('crashed')]), restored)
  const malformed = clone(restored)
  malformed.costReservations[0].amount = 0.5
  const denied = restoredCost(malformed, [unknownAttempt('crashed')])
  assert.equal(denied.costReservationCorrupt, true)
  assert.throws(() => policy.reserveProviderAttemptBudget(denied, 'writer', 1, false, NOW), errorCode('run_cost_unknown_price'))
})
