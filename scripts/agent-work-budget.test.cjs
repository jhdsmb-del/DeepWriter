const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const built = buildSync({ stdin: { contents: `export * from './src/shared/agentRunBudget'; export * from './src/main/jobs/providerBudgetPolicy'; export { buildExecutionSnapshot,applyFrozenProviderPricing } from './src/main/executionSnapshot'; export {settingsSetSchema} from './src/shared/settingsSchema'; export {removeRunCallLimit} from './src/main/runCallLimitAuthorization'; export {createRepository} from './src/main/db/repository'`, resolveDir: root, loader: 'ts' }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports); const api = loaded.exports
const unlimited = () => api.unlimitedAgentRunBudget()
const state = (budget = unlimited()) => api.makeRunBudgetState('r', { runMode: 'agent', workBudgetPolicy: 'explicit_v1', providerCallBudget: budget }, 1, 1)
const settings = { model: 'fixture', baseUrl: 'http://127.0.0.1:1', maxTokens: 1024, temperature: 1, topP: 1, thinkingEnabled: false, reasoningEffort: 'low', workDir: root, docDir: root, novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 4096, completionTokenBudget: 0, completionWallClockMs: 0 }
const snapshot = overrides => api.buildExecutionSnapshot({ payload: { id: 'r', mode: 'agent', text: 'test', attachments: [] }, sessionId: 's', settings: { ...settings, ...overrides }, memory: { projectPath: '', projectContent: '', userContent: '' }, now: 1 })
const code = expected => error => error.code === expected

test('new Agent snapshots disable every work limit independently from native context/output, prices and longwrite contracts', () => {
  const cfg = snapshot({})
  assert.equal(cfg.workBudgetPolicy, 'explicit_v1'); assert.equal(cfg.maxTurns, null); assert.equal(cfg.maxTokens, 1024); assert.ok(cfg.contextPolicy.contextWindowTokens > 1024)
  assert.deepEqual(cfg.providerCallBudget, { maxCalls: null, maxTokens: null, maxWallClockMs: null, maxCost: null, maxCostCny: null }); assert.equal(cfg.completionContract, null)
  assert.deepEqual(api.applyFrozenProviderPricing(cfg, { version: 1, frozenAt: 'x' }), cfg)
  const frozen = { ...unlimited(), maxCalls: 700, maxTurns: 33, maxTokens: 30_000_000, maxWallClockMs: 200_000_000, maxCost: { amount: 300000, currency: 'EUR', unknownPolicy: 'deny' } }
  const limited = snapshot({ agentRunBudget: frozen }); assert.equal(limited.maxTurns, 33); assert.deepEqual(api.runBudgetLimits(limited), { maxCalls:700,maxTokens:30000000,maxWallClockMs:200000000,maxCost:frozen.maxCost,maxCostCny:null })
  const writing = api.buildExecutionSnapshot({ payload:{id:'w',mode:'longwrite',longMode:true,targetChars:1000,text:'写作',attachments:[]},sessionId:'s',settings:{...settings,agentRunBudget:frozen},memory:{projectPath:'',projectContent:'',userContent:''},now:1 })
  assert.equal(writing.workBudgetPolicy, 'explicit_v1'); assert.equal(writing.maxTurns, null); assert.equal(writing.providerCallBudget.maxCost, null); assert.equal(writing.completionContract.targetChars.min, 1000); assert.equal(writing.completionContract.tokenBudget, undefined)
})

test('migration sees only original disk fields; missing/default/disabled never resurrect limits while real stored numbers survive', () => {
  assert.equal(api.completionTokenBudgetFromStoredSettings({}), 0)
  assert.equal(api.completionTokenBudgetFromStoredSettings({ completionTokenBudget: 200000 }), 0)
  assert.equal(api.completionTokenBudgetFromStoredSettings({ completionTokenBudget: 200000, agentRunBudget: unlimited() }), 200000)
  assert.deepEqual(api.agentRunBudgetFromStoredSettings({}), unlimited())
  assert.deepEqual(api.agentRunBudgetFromStoredSettings({ completionTokenBudget: 200000, completionWallClockMs: 42 }), { ...unlimited(), maxWallClockMs: 42 })
  assert.equal(api.agentRunBudgetFromStoredSettings({ completionTokenBudget: 250000 }).maxTokens, 250000)
  assert.equal(api.agentRunBudgetFromStoredSettings({ agentRunBudget: { ...unlimited(), maxTokens: 200000 } }).maxTokens, 200000)
  const disabled = { completionTokenBudget: 200000, completionWallClockMs: 42, agentRunBudget: unlimited() }
  assert.deepEqual(api.agentRunBudgetFromStoredSettings(JSON.parse(JSON.stringify(disabled))), unlimited())
  assert.equal(api.agentRunBudgetFromStoredSettings({ agentRunBudget: { ...unlimited(), maxTokens: 17 } }).maxTokens, 17)
  assert.equal(api.settingsSetSchema.safeParse({kind:'patch',key:'agentRunBudget',value:unlimited()}).success,true)
  assert.equal(api.settingsSetSchema.safeParse({kind:'patch',key:'agentRunBudget',value:{...unlimited(),maxCalls:0}}).success,false)
})

test('all new production modes keep target/validation contracts but default work budgets stay off; writing opt-in is explicit', () => {
  for (const mode of ['longwrite', 'galgame', 'style']) {
    const cfg = api.buildExecutionSnapshot({ payload:{id:'w',mode,longMode:mode==='longwrite',targetChars:1000,text:'写作',attachments:[]},sessionId:'s',settings,memory:{projectPath:'',projectContent:'',userContent:''},now:1 })
    assert.equal(cfg.workBudgetPolicy,'explicit_v1');assert.equal(cfg.maxTurns,null)
    assert.deepEqual(api.runBudgetLimits(cfg),state().limits)
    assert.equal(cfg.completionContract?.tokenBudget,undefined);assert.equal(cfg.completionContract?.wallClockBudgetMs,undefined)
    if(mode==='longwrite') {assert.equal(cfg.completionContract.targetChars.min,1000);assert.ok(cfg.longWritePlan.maxTurns>0)}
    if(mode==='galgame')assert.ok(cfg.completionContract.validators.some(item=>item.id==='renpyLint'))
  }
  const cfg=api.buildExecutionSnapshot({payload:{id:'w',mode:'longwrite',longMode:true,targetChars:1000,text:'写作',attachments:[]},sessionId:'s',settings:{...settings,completionTokenBudget:200000,completionWallClockMs:60000},memory:{projectPath:'',projectContent:'',userContent:''},now:1})
  assert.equal(cfg.providerCallBudget.maxTokens,200000);assert.equal(cfg.providerCallBudget.maxWallClockMs,60000);assert.equal(cfg.completionContract.tokenBudget,200000);assert.equal(cfg.completionContract.wallClockBudgetMs,60000)
})

test('no default wall clock, token or provider-count ceiling appears after durable normalization or reconciliation', () => {
  let ledger = state(); ledger.knownInputTokens = 40_000_000; ledger.totalCalls = 5000; ledger.callsByActor.writer = 5000
  ledger = api.normalizeBudgetState(JSON.parse(JSON.stringify(ledger)), 200_000_000)
  assert.equal(api.validBudgetState(ledger, 'r'), true); assert.equal(ledger.limits.maxWallClockMs, null)
  api.reserveProviderAttemptBudget(ledger, 'writer', 1, false, 200_000_000); assert.equal(ledger.totalCalls, 5001)
  assert.equal(api.reserveProviderTokenBudget(ledger, 'logical', 1, {bodyJson:'{}',maxTokens:1024},200_000_000),'unchanged')
  const finite = { ...unlimited(), maxCalls:900,maxTokens:30_000_000,maxWallClockMs:200_000_000,maxCost:{amount:300000,currency:'EUR',unknownPolicy:'deny'} }
  assert.deepEqual(api.normalizeBudgetState(state(finite), 2).limits, {maxCalls:900,maxTokens:30000000,maxWallClockMs:200000000,maxCost:finite.maxCost,maxCostCny:null})
  assert.deepEqual(api.tighterRunBudgetLimits(state(finite).limits,state().limits),state(finite).limits)
  assert.equal(api.runBudgetLimits({providerCallBudget:{}}).maxCalls,16);assert.equal(api.runBudgetLimits({providerCallBudget:{}}).maxWallClockMs,1800000)
})

test('each explicit finite cap still refuses before transport; currency and unknown-price refusal remain authoritative', () => {
  let ledger=state({...unlimited(),maxCalls:1});api.reserveProviderAttemptBudget(ledger,'writer',1,false,2);assert.throws(()=>api.reserveProviderAttemptBudget(ledger,'writer',1,false,3),code('run_provider_call_cap'))
  ledger=state({...unlimited(),maxWallClockMs:100});assert.throws(()=>api.reserveProviderAttemptBudget(ledger,'writer',1,false,101),code('run_wall_clock_budget'))
  ledger=state({...unlimited(),maxTokens:10});assert.throws(()=>api.reserveProviderTokenBudget(ledger,'logical',1,{bodyJson:'{}',maxTokens:50},2),code('run_token_budget'))
  ledger=state({...unlimited(),maxCost:{amount:1,currency:'USD',unknownPolicy:'deny'}})
  assert.throws(()=>api.reserveProviderCostBudget(ledger,'logical',1,{status:'unknown',amount:null,currency:null,priceSnapshotId:null},2),code('run_cost_unknown_price'))
  assert.throws(()=>api.reserveProviderCostBudget(ledger,'logical',1,{status:'estimated',amount:.1,currency:'CNY',priceSnapshotId:'p'},2),code('run_cost_currency_mismatch'))
  assert.throws(()=>api.reserveProviderCostBudget(ledger,'logical',1,{status:'estimated',amount:2,currency:'USD',priceSnapshotId:'p'},2),code('run_cost_budget'))
  const quote={status:'estimated',amount:.4,currency:'USD',priceSnapshotId:'p'};api.reserveProviderCostBudget(ledger,'logical',1,quote,2);api.settleProviderCostBudget(ledger,['logical\0'+'1'],3)
  assert.throws(()=>api.reserveProviderCostBudget(ledger,'next',1,{...quote,amount:.7},4),code('run_cost_budget'))
  assert.deepEqual(api.normalizeBudgetState(state({...unlimited(),maxCost:{amount:0,currency:'USD',unknownPolicy:'deny'}}),2).limits.maxCost,{amount:0,currency:'USD',unknownPolicy:'deny'})
})
