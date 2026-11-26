'use strict'
// Production registry + SQLite + IPC schema, isolated synthetic identity only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let production
before(async () => {
  const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  const start = mainSource.indexOf('getApi: (runId: string, purpose, phase): KernelApi => {')
  const end = mainSource.indexOf('\n      buildPrefix:', start)
  assert.ok(start > 0 && end > start, 'production getApi callback missing')
  const getApi = mainSource.slice(start + 'getApi: '.length, end).trim().replace(/,$/, '')
  const result = await esbuild.build({ absWorkingDir: root, stdin: { contents: `
    export { ProviderRegistryService } from './src/main/providerRegistry';
    export { providerPricingUpsertSchema, providerPricingListSchema, modelManualSchema } from './src/shared/ipcSchemas';
    export { deriveProviderCallBudget } from './src/main/executionSnapshot';
    export { createGrillMeState, buildGrillMePlanningPrompt } from './src/shared/grillMe';
    export { previewGrillOutlineApplicability } from './src/main/grillOutlineApplicability';
    export { buildSceneContractPlan } from './src/main/narrative/sceneContract';
    export { createRepository } from './src/main/db/repository';
    import { CredentialMissingError } from './src/main/credentialRegistry';
    import { ProviderRegistryError } from './src/main/providerRegistry';
    export function productionApi(repo, service, runId, purpose='writer', phase='writing') {
      const configForRun = id => JSON.parse(repo.getRun(id).config_json);
      const providerRegistry = service;
      const credentialRegistry = { resolve() { throw new Error('unexpected legacy credential fallback') } };
      return (${getApi})(runId, purpose, phase);
    }
  `, loader: 'ts', resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', tsconfigRaw: {}, plugins: [{ name: 'workspace-only', setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (!args.path.startsWith('.')) return { path: args.path, external: true }
      const target = path.resolve(args.resolveDir, args.path)
      const resolved = ['', '.ts', '/index.ts'].map(suffix => target + suffix).find(fs.existsSync)
      if (!resolved || !resolved.startsWith(root + path.sep)) throw new Error('Unexpected test source import')
      // All cases share this isolated loader; preserve native JSON handling
      // rather than compiling modelCatalog.generated.json as TypeScript.
      return { path: resolved }
    })
  }}] })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, loaded, loaded.exports)
  production = loaded.exports
})
const vault = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() }
async function fixture(action) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-user-price-'))
  const database = path.join(directory, 'fixture.db')
  const service = new production.ProviderRegistryService(database, vault)
  try {
    const provider = await service.createCustomProvider({ displayName: '本地参考价夹具', baseUrl: 'http://127.0.0.1:43217', chatPath: '/v1/chat/completions', modelsPath: null, authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true, protocol: 'openai-chat' } })
    const model = service.addManualModel({ providerId: provider.id, remoteModelId: 'synthetic-only', displayName: '隔离模型', contextWindow: 131072, maxOutputTokens: 8192 })
    await action(service, provider, model, database)
  } finally {
    service.close()
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(database + suffix)) fs.unlinkSync(database + suffix)
    fs.rmdirSync(directory)
  }
}
const input = modelId => ({ modelId, currency: 'CNY', unit: 'per_1m_tokens', inputPrice: 0.02, outputPrice: 0.04, cacheHitInputPrice: 0.002, reasoningBillingRule: 'included_in_output', validFrom: '2026-01-01T00:00:00.000Z', acknowledgeReferenceOnly: true })

test('strict IPC schema and actual class refuse official/hash/identity spoof, invalid rates, missing acknowledgement, future dates and credential URLs', async () => fixture(async (service, provider, model) => {
  const valid = input(model.id)
  for (const extra of [{ source: 'official_provider' }, { priceProfileHash: 'forged' }, { providerId: provider.id }, { canonicalOrigin: 'https://api.deepseek.com' }, { remoteModelId: 'wrong' }, { inputPrice: -1 }, { outputPrice: Infinity }, { cacheHitInputPrice: NaN }, { acknowledgeReferenceOnly: false }, { currency: 'cny' }, { unit: 'per_token' }]) {
    assert.equal(production.providerPricingUpsertSchema.safeParse({ ...valid, ...extra }).success, false)
    assert.throws(() => service.upsertUserPricing({ ...valid, ...extra }))
  }
  assert.throws(() => service.upsertUserPricing({ ...valid, validFrom: '2999-01-01T00:00:00.000Z' }))
  assert.throws(() => service.upsertUserPricing({ ...valid, sourceUrl: 'https://example.com/?api_key=synthetic' }))
  assert.throws(() => service.upsertUserPricing({ ...valid, modelId: 'not-saved' }))
  assert.equal(service.listUserPricing(model.id).length, 0)
  assert.equal(production.providerPricingListSchema.safeParse({ modelId: model.id, providerId: provider.id }).success, false)
}))

test('real persisted record derives exact origin/provider/model/hash and standard tier quote refuses wrong identity', async () => fixture(async (service, provider, model) => {
  const saved = service.upsertUserPricing(input(model.id))
  assert.equal(saved.source, 'user_supplied'); assert.equal(saved.providerId, provider.id); assert.equal(saved.remoteModelId, model.remoteModelId)
  assert.equal(saved.canonicalOrigin, 'http://127.0.0.1:43217'); assert.equal(saved.cacheWritePerMillion, null); assert.equal(saved.reasoningPerMillion, null)
  assert.equal(saved.priceProfileHash, createHash('sha256').update(JSON.stringify({ ...saved, id: undefined, priceProfileHash: undefined })).digest('hex'))
  assert.deepEqual(service.listUserPricing(model.id), [saved])
  const quote = { providerId: provider.id, canonicalOrigin: saved.canonicalOrigin, remoteModelId: model.remoteModelId, startedAt: Date.now(), cacheMissTokens: 1000000, cacheHitTokens: 1000000, outputTokens: 1000000 }
  assert.equal(service.estimateCost(quote).amount, 0.062)
  for (const mismatch of [{ canonicalOrigin: 'http://127.0.0.1:43218' }, { remoteModelId: 'wrong' }, { providerId: 'wrong' }, { cacheHitTokens: null }]) assert.equal(service.estimateCost({ ...quote, ...mismatch }).status, 'unknown')
}))

test('unknown remains deny, complete positive reference yields bounded policy, actual restarted getApi retains old run price after same-ID correction', async () => fixture(async (service, provider, model, database) => {
  const profile = service.upsertProfile({ id: 'profile.synthetic', name: '本地参考测试', providerId: provider.id, modelId: model.id, credentialRefId: null, generation: { temperature: 1, topP: 1, maxOutputTokens: 8192, stream: true }, reasoning: { mode: 'default', effort: null, budgetTokens: null }, compatibilityMappingId: null })
  const bindings = { defaultProfileId: profile.id }
  service.setBindings(bindings)
  const legacy = { maxTokens: 8192, temperature: 1, topP: 1, thinking: { enabled: false, effort: 'high' } }
  const budget = record => production.deriveProviderCallBudget({ maxCalls: 16, maxInputTokens: 131072, maxOutputTokens: 8192, pricingSnapshots: record ? [record] : [] })
  assert.equal(budget(null).maxCost.amount, 0)
  const unknown = service.upsertUserPricing({ ...input(model.id), cacheHitInputPrice: null })
  assert.equal(unknown.cacheHitPerMillion, null); assert.equal(budget(unknown).maxCost.currency, null)
  const saved = service.upsertUserPricing(input(model.id))
  const frozen = service.freezeStageProfiles(bindings, legacy)
  const frozenBytes = JSON.stringify(frozen)
  let repo = production.createRepository(database)
  repo.open()
  repo.createSession('price-fixture-session', '隔离价格冻结回归', 'fixture')
  try {
    const storeRun = (id, profiles) => repo.createRun({ run_id: id, session_id: 'price-fixture-session', status: 'running', phase: 'writing', started_at: Date.now(), updated_at: Date.now(), config_json: JSON.stringify({ providerProfileSnapshots: profiles }), parent_run_id: null, error_code: null, error_message: null })
    storeRun('old-price-run', frozen)
  assert.equal(frozen.draft.model.pricing.priceProfileHash, saved.priceProfileHash)
  const cap = budget(saved).maxCost
  assert.equal(cap.currency, 'CNY'); assert.equal(cap.unknownPolicy, 'deny'); assert.ok(cap.amount > 0 && cap.amount < 5)
  const changed = service.upsertUserPricing({ ...input(model.id), inputPrice: 0.2, outputPrice: 0.4 })
  assert.equal(changed.id, saved.id); assert.notEqual(changed.priceProfileHash, saved.priceProfileHash)
  assert.equal(JSON.stringify(frozen), frozenBytes)
  assert.equal(service.freezeStageProfiles(bindings, legacy).draft.model.pricing.priceProfileHash, changed.priceProfileHash)
  assert.equal(service.listUserPricing(model.id).length, 1)
    storeRun('new-price-run', service.freezeStageProfiles(bindings, legacy))
    repo.close(); repo = production.createRepository(database); repo.open()
    for (const purpose of ['writer', 'critic', 'editor']) {
      const oldApi = production.productionApi(repo, service, 'old-price-run', purpose)
      assert.equal(oldApi.pricing.priceProfileHash, saved.priceProfileHash)
      assert.equal(oldApi.pricing.inputMissPerMillion, saved.inputMissPerMillion)
      assert.equal(oldApi.pricing.outputPerMillion, saved.outputPerMillion)
      assert.equal(oldApi.providerId, provider.id); assert.equal(oldApi.model, model.remoteModelId)
      assert.equal(budget(oldApi.pricing).maxCost.amount, cap.amount)
    }
    const newApi = production.productionApi(repo, service, 'new-price-run')
    assert.equal(newApi.pricing.priceProfileHash, changed.priceProfileHash)
    assert.equal(newApi.pricing.inputMissPerMillion, changed.inputMissPerMillion)
  } finally { repo.close() }
}))

test('unmodified official origin keeps existing officially sourced CNY reference tariffs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-official-price-'))
  const database = path.join(directory, 'fixture.db')
  const service = new production.ProviderRegistryService(database, vault)
  try {
    await service.bootstrapDeepSeek({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: '', thinkingEnabled: false, reasoningEffort: 'high', temperature: 1, topP: 1, maxTokens: 8192 })
    const saved = service.snapshot(); const model = saved.models.find(row => row.remoteModelId === 'deepseek-v4-flash')
    assert.equal(model.pricing.source, 'official_provider'); assert.equal(model.pricing.canonicalOrigin, 'https://api.deepseek.com')
    assert.equal(service.estimateCost({ providerId: model.providerId, canonicalOrigin: 'https://api.deepseek.com', remoteModelId: model.remoteModelId, startedAt: Date.now(), cacheHitTokens: 0, cacheMissTokens: 1000, outputTokens: 100 }).status, 'estimated')
  } finally {
    service.close()
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(database + suffix)) fs.unlinkSync(database + suffix)
    fs.rmdirSync(directory)
  }
})

test('explicit narrative planner distinguishes observable actions and literary targets without imposing story beats on open/expository forms', () => {
  const state = production.createGrillMeState({ stateId: 'prompt-fixture', sessionId: 'prompt-session', originalTask: '守夜人在灯塔值班', kind: '短篇小说', targetChars: 8000 })
  assert.equal(state.writingForm, 'narrative')
  const prompt = production.buildGrillMePlanningPrompt(state)
  assert.ok(prompt.includes('正文中观察到的具体事件'))
  assert.ok(prompt.includes('作用对象或地点发生的变化'))
  assert.ok(prompt.includes('文学目标') && prompt.includes('不应被假定为结构化世界状态'))
  assert.ok(prompt.includes('不要求僵硬句式') && prompt.includes('不猜测未确认'))
  assert.ok(prompt.includes('必须覆盖的来源 id') && prompt.includes('不能填写 assumption'))
  for (const kind of ['', '说明文']) {
    const other = production.createGrillMeState({ stateId: 'other-prompt', sessionId: 'other-session', originalTask: '守夜人在灯塔值班', kind, targetChars: 8000 })
    assert.equal(other.writingForm, kind ? 'expository' : 'open')
    const otherPrompt = production.buildGrillMePlanningPrompt(other)
    assert.ok(!otherPrompt.includes('场景 beats 应至少包含'))
    assert.ok(otherPrompt.includes('不得补造未提供的事实'))
  }
})

test('real scene compiler preflight warns opaque beats before payment, stays advisory and does not mutate outline', () => {
  const state = production.createGrillMeState({ stateId: 'preview-fixture', sessionId: 'preview-session', originalTask: '林舟、沈遥在灯塔值班', targetChars: 1000 })
  state.slots = [{ id: 'characters', label: '人物', answer: '林舟、沈遥', source: 'user' }, { id: 'setting', label: '地点', answer: '灯塔', source: 'user' }]
  const outline = { title: '灯塔夜班', premise: '两位守夜人在灯塔完成当夜的具体交接。', targetChars: 1000, sections: [{ id: 's1', title: '抵达夜班', purpose: '在灯塔完成交接与照明。', targetChars: 1000, sourceSlotIds: ['characters', 'setting'], beats: ['第1幕出现一个可验证的现场变化', '第1幕留下下一步行动线索'] }] }
  const before = JSON.stringify(outline)
  const preview = production.previewGrillOutlineApplicability(state, outline)
  assert.equal(preview.scenes[0]?.beats.length, 2, JSON.stringify(production.buildSceneContractPlan({ outline, answers: state.slots.map(slot => ({ slotId: slot.id, value: slot.answer, source: slot.source })) }).contracts[0].requiredBeatEvidence))
  assert.equal(JSON.stringify(outline), before)
  outline.sections[0].beats = ['林舟抵达灯塔', '沈遥点亮灯塔']
  assert.equal(production.previewGrillOutlineApplicability(state, outline).scenes.length, 0)
  outline.sections[0].beats = ['林舟在灯塔凝望风雨，保持紧张感']
  assert.doesNotThrow(() => production.previewGrillOutlineApplicability(state, outline))
})
