'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const { buildSync } = require('esbuild'), path = require('node:path')
const root = path.resolve(__dirname, '..')
function subscriptions() {
  const reads = [], listeners = new Set()
  const window = { ds: { runsGetGoal: runId => new Promise((resolve, reject) => reads.push({runId,resolve,reject})), onRunGoalUpdated: fn => { listeners.add(fn); return () => listeners.delete(fn) } } }
  const code = buildSync({ entryPoints: [path.join(root,'src/renderer/src/goalSubscriptions.ts')], bundle:true, packages:'external', platform:'node', format:'cjs', write:false }).outputFiles[0].text
  const mod = {exports:{}}
  new Function('require','module','exports','window',code)(require, mod, mod.exports, window)
  return { api:mod.exports, reads, listeners, update:id => { for(const fn of listeners) fn({runId:id}) } }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
test('goal transcript/detail share narrow reads, reject stale responses and rehydrate after reopen', async () => {
  const {api,reads,listeners,update} = subscriptions()
  const a = api.subscribeGoal('goal',()=>{}), b=api.subscribeGoal('goal',()=>{})
  assert.equal(reads.length,1); assert.equal(listeners.size,1)
  update('unrelated'); for(let i=0;i<30;i++) update('goal')
  reads[0].resolve({revision:0,progress:'stale'}); await tick()
  assert.equal(api.getGoal('goal'),null); assert.equal(reads.length,2)
  const current={revision:1,progress:'已保存的验收状态'}
  reads[1].resolve(current); await tick(); assert.deepEqual(api.getGoal('goal'),current)
  update('goal');reads[2].reject(Error('transient'));await tick();assert.deepEqual(api.getGoal('goal'),current)
  a();b();assert.equal(listeners.size,0)
  const c=api.subscribeGoal('goal',()=>{});assert.equal(reads.length,4)
  reads[3].resolve({...current,revision:2});await tick();assert.equal(api.getGoal('goal').revision,2)
  c()
})
