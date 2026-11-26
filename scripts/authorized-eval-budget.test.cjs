'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { remainingAuthorization } = require('./authorized-eval-budget.cjs')
function previous() {
  return { model: 'deepseek-flash', hardCapProtected: true, spentUpperCny: 0.119039, inflightReservedCny: 0,
    budget: { requestsUsed: 12, spentUpperCny: 0.119039, inflightReservedCny: 0, hardCapProtected: true } }
}
test('repair assessment gets only the unspent portion of the same owner authorization', () => {
  assert.deepEqual(remainingAuthorization(previous()), { maxCostCny: 4.880961, maxRequests: 28, previousSpentUpperCny: 0.119039, previousRequests: 12 })
})
test('inflight, missing, inconsistent or wrong-model ledger cannot release budget', () => {
  for (const change of [m => { m.inflightReservedCny = 0.01 }, m => { delete m.spentUpperCny }, m => { m.budget.spentUpperCny = 0 }, m => { m.model = 'another-model' }, m => { m.budget.requestsUsed = NaN }, m => { m.hardCapProtected = false }]) {
    const m = previous(); change(m); assert.throws(() => remainingAuthorization(m))
  }
})
test('cost/request exhaustion fails before another batch is authorized', () => {
  assert.throws(() => remainingAuthorization(previous(), 0.1))
  assert.throws(() => remainingAuthorization(previous(), 5, 12))
})
test('a second rejected assessment still consumes its requests and settled upper cost', () => {
  const second = previous()
  second.spentUpperCny = second.budget.spentUpperCny = 0.099443
  second.budget.requestsUsed = 5
  second.actualCostKnown = false
  assert.deepEqual(remainingAuthorization([previous(), second]), { maxCostCny: 4.781518, maxRequests: 23, previousSpentUpperCny: 0.218482, previousRequests: 17 })
  assert.throws(() => remainingAuthorization([previous(), { ...second, inflightReservedCny: 1 }]))
})
