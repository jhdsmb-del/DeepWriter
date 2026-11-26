import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ProviderRegistryError, ProviderRegistryService, type SafeStoragePort } from '../src/main/providerRegistry'
import { canonicalJoin, classifyAddress, validateProviderEndpoint, validateProviderEndpointSyntax } from '../src/main/providerSecurity'
import { streamChat } from '../src/main/deepseek'
import { resolveProviderCapability, resolveRegistryContextCapability } from '../src/main/providerCapability'
import { MODELS } from '../src/shared/types'

let passed = 0
async function check(name: string, test: () => void | Promise<void>): Promise<void> {
  await test()
  passed += 1
  console.log(`  PASS  ${name}`)
}

const vault: SafeStoragePort = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${[...value].reverse().join('')}`),
  decryptString: (value) => [...value.toString().replace(/^encrypted:/, '')].reverse().join('')
}

const lockedVault: SafeStoragePort = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('unavailable') },
  decryptString: () => { throw new Error('unavailable') }
}

const publicResolver = async (): Promise<Array<{ address: string; family: number }>> => [{ address: '93.184.216.34', family: 4 }]
const privateResolver = async (): Promise<Array<{ address: string; family: number }>> => [{ address: '169.254.169.254', family: 4 }]

const temp = await mkdtemp(path.join(tmpdir(), 'deepwriter-r44-'))
const dbPath = path.join(temp, 'r44.db')
const service = new ProviderRegistryService(dbPath, vault)

try {
  console.log('\n[R44] Provider Registry / 安全边界 / adapter 定向验证')
  await check('当前 migration 保留 v13 registry 与 append-only credential versions', () => {
    const db = new DatabaseSync(dbPath)
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name)
    for (const name of ['provider_registry', 'provider_models', 'provider_profiles', 'provider_credential_refs', 'provider_credential_secrets', 'provider_credential_versions', 'provider_pricing', 'provider_probes']) assert.ok(names.includes(name), name)
    assert.ok((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= 13)
    db.close()
  })

  await service.bootstrapDeepSeek({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'sk-r44-secret-1234', thinkingEnabled: true, reasoningEffort: 'high', temperature: 1, topP: 1, maxTokens: 8192 })
  await service.bootstrapDeepSeek({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'sk-r44-secret-1234', thinkingEnabled: true, reasoningEffort: 'high', temperature: 1, topP: 1, maxTokens: 8192 })

  await check('DeepSeek bootstrap 幂等且默认兼容 Profile/凭据存在', () => {
    const snapshot = service.snapshot()
    assert.equal(snapshot.providers.filter((item) => item.id === 'provider.deepseek.builtin').length, 1)
    assert.equal(snapshot.models.filter((item) => item.remoteModelId === 'deepseek-v4-flash').length, 1)
    assert.equal(snapshot.profiles.filter((item) => item.id === 'profile.deepseek.default').length, 1)
    assert.equal(snapshot.credentials.filter((item) => item.providerId === 'provider.deepseek.builtin').length, 1)
    assert.equal(service.isExplicitlyEnabled(), false)
    assert.equal(service.shouldUseRegistry(), true)
  })

  await check('2026-10-03 官方 CNY 快照覆盖正式 Flash、旧别名和 Pro 精确身份', async () => {
    const priced = new ProviderRegistryService(path.join(temp, 'current-pricing.db'), vault)
    try {
      for (const model of ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']) {
        await priced.bootstrapDeepSeek({ baseUrl: 'https://api.deepseek.com', model, apiKey: 'fixture-only', thinkingEnabled: true, reasoningEffort: 'high', temperature: 1, topP: 1, maxTokens: 8192 })
        const snapshot = priced.snapshot()
        const selected = snapshot.models.find((entry) => entry.id === snapshot.profiles.find((entry) => entry.id === 'profile.deepseek.default')!.modelId)!
        const isPro = model === 'deepseek-v4-pro'
        assert.equal(selected.remoteModelId, model, '不得偷偷重写用户选中的旧模型字符串')
        assert.ok(selected.displayName.includes(isPro ? '0813' : 'V4.1-Flash'))
        assert.equal(selected.pricing?.currency, 'CNY')
        assert.equal(selected.pricing?.id, `price.deepseek.${model}.peak.2026-10-03`)
        assert.equal(selected.pricing?.cacheHitPerMillion, isPro ? 0.30 : 0.04)
        assert.equal(selected.pricing?.inputMissPerMillion, isPro ? 9 : 2)
        assert.equal(selected.pricing?.outputPerMillion, isPro ? 27 : 8)
        assert.equal(selected.pricing?.sourceUrl, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/')
        const frozen = priced.freezeStageProfiles(snapshot.bindings!, { maxTokens: 8192, temperature: 1, topP: 1, thinking: { enabled: true, effort: 'high' } })
        assert.deepEqual(frozen.default.model.pricing, selected.pricing)
        const offPeak = priced.estimateCost({ providerId: 'provider.deepseek.builtin', canonicalOrigin: 'https://api.deepseek.com', remoteModelId: model, startedAt: Date.UTC(2026, 9, 3, 2), cacheHitTokens: 1000, cacheMissTokens: 1000, outputTokens: 1000 })
        assert.equal(offPeak.currency, 'CNY')
        assert.equal(offPeak.priceSnapshotId, `price.deepseek.${model}.off_peak.2026-10-03`)
        assert.equal(offPeak.amount, isPro ? 0.01815 : 0.00502)
        const peak = priced.estimateCost({ providerId: 'provider.deepseek.builtin', canonicalOrigin: 'https://api.deepseek.com', remoteModelId: model, startedAt: Date.UTC(2026, 9, 12, 2), cacheHitTokens: 1000, cacheMissTokens: 1000, outputTokens: 1000 })
        assert.equal(peak.priceSnapshotId, `price.deepseek.${model}.peak.2026-10-03`)
        assert.equal(peak.amount, isPro ? 0.0363 : 0.01004)
      }
    } finally { priced.close() }
  })

  await check('新初始化不重写历史 USD 行或已接受运行的冻结价格与指纹', async () => {
    const historyPath = path.join(temp, 'pricing-history.db')
    const history = new ProviderRegistryService(historyPath, vault)
    try {
      const input = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'fixture-only', thinkingEnabled: true, reasoningEffort: 'high', temperature: 1, topP: 1, maxTokens: 8192 }
      await history.bootstrapDeepSeek(input)
      const base = {
        providerId: 'provider.deepseek.builtin', remoteModelId: input.model, canonicalOrigin: 'https://api.deepseek.com', currency: 'USD', unit: 'per_1m_tokens' as const,
        pricingTier: 'peak' as const, contextBucket: 'default' as const, inputMissPerMillion: 0.44, cacheHitPerMillion: 0.014,
        cacheWritePerMillion: null, outputPerMillion: 1.32, reasoningPerMillion: null, reasoningBillingRule: 'included_in_output' as const,
        source: 'official_provider' as const, sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/', effectiveAt: null, retrievedAt: '2026-08-24T00:00:00.000Z'
      }
      history.upsertPricing({ id: 'price.deepseek.deepseek-v4-flash.peak.2026-08-24', ...base, priceProfileHash: createHash('sha256').update(JSON.stringify(base)).digest('hex') })
      const frozen = history.freezeStageProfiles(history.snapshot().bindings!, { maxTokens: 8192, temperature: 1, topP: 1, thinking: { enabled: true, effort: 'high' } })
      const persistedRun = JSON.stringify(frozen)
      const db = new DatabaseSync(historyPath)
      try {
        const oldRow = db.prepare('SELECT * FROM provider_pricing WHERE id=?').get('price.deepseek.deepseek-v4-flash.peak.2026-08-24')
        await history.bootstrapDeepSeek(input)
        assert.deepEqual(db.prepare('SELECT * FROM provider_pricing WHERE id=?').get('price.deepseek.deepseek-v4-flash.peak.2026-08-24'), oldRow)
        assert.equal(JSON.stringify(frozen), persistedRun)
        assert.equal(frozen.default.model.pricing?.currency, 'USD')
        assert.equal(JSON.parse(persistedRun).default.model.pricing.priceProfileHash, frozen.default.model.pricing?.priceProfileHash)
        const newRun = history.freezeStageProfiles(history.snapshot().bindings!, { maxTokens: 8192, temperature: 1, topP: 1, thinking: { enabled: true, effort: 'high' } })
        assert.equal(newRun.default.model.pricing?.currency, 'CNY')
        assert.notEqual(newRun.default.fingerprint, frozen.default.fingerprint)
      } finally { db.close() }
    } finally { history.close() }
  })

  await check('模型目录事实和官方别名能力正确，未知及自定义同名仍拒绝未知 context', () => {
    assert.equal(MODELS[0].id, 'deepseek-v4-flash', '目录排序不改变旧默认偏好')
    for (const id of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']) {
      const entry = MODELS.find((item) => item.id === id)!
      assert.ok(entry)
      assert.equal(entry.out, id === 'deepseek-v4-pro' ? 13.5 : 4)
      const known = resolveProviderCapability(id)
      assert.equal(known.contextWindowTokens, 1_048_576)
      assert.equal(known.maxOutputTokens, 393_216)
      assert.equal(resolveRegistryContextCapability({ providerKind: 'builtin', adapterId: 'builtin.deepseek', remoteModelId: id }).contextSource, 'trusted_builtin')
      const custom = resolveRegistryContextCapability({ providerKind: 'custom', adapterId: 'custom.openai-compatible-chat', remoteModelId: id })
      assert.equal(custom.maxContextTokens, null)
      assert.equal(custom.contextSource, 'unknown')
    }
    assert.equal(resolveRegistryContextCapability({ providerKind: 'builtin', adapterId: 'builtin.deepseek', remoteModelId: 'unknown-model' }).maxContextTokens, null)
  })

  await check('DeepSeek 旧 model 原子迁移到新 model，显式自定义 binding 不被覆盖', async () => {
    const migrationPath = path.join(temp, 'model-migration.db')
    const migrated = new ProviderRegistryService(migrationPath, vault, publicResolver)
    await migrated.bootstrapDeepSeek({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'sk-old', thinkingEnabled: true, reasoningEffort: 'high', temperature: 1, topP: 1, maxTokens: 8192 })
    await migrated.bootstrapDeepSeek({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', apiKey: 'sk-old', thinkingEnabled: false, reasoningEffort: 'low', temperature: 0.4, topP: 0.6, maxTokens: 4096 })
    let snapshot = migrated.snapshot()
    let builtinProfile = snapshot.profiles.find((item) => item.id === 'profile.deepseek.default')!
    assert.equal(snapshot.models.find((item) => item.id === builtinProfile.modelId)?.remoteModelId, 'deepseek-v4-pro')
    assert.deepEqual(builtinProfile.generation, { temperature: 0.4, topP: 0.6, maxOutputTokens: 4096, stream: true })
    const custom = await migrated.createCustomProvider({ displayName: 'Explicit', baseUrl: 'https://example.com', chatPath: '/v1/chat/completions', modelsPath: null, authStyle: 'none', transportPolicy: { scope: 'public_https', allowNonDefaultPort: false } })
    const customModel = migrated.addManualModel({ providerId: custom.id, remoteModelId: 'explicit-model', displayName: 'Explicit' })
    const customProfile = migrated.upsertProfile({ id: 'profile.explicit', name: 'Explicit', providerId: custom.id, modelId: customModel.id, credentialRefId: null, generation: { temperature: 1, topP: 1, maxOutputTokens: 1024, stream: true }, reasoning: { mode: 'default', effort: null, budgetTokens: null }, compatibilityMappingId: null })
    migrated.setBindings({ defaultProfileId: customProfile.id })
    await migrated.bootstrapDeepSeek({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'sk-old', thinkingEnabled: true, reasoningEffort: 'high', temperature: 1, topP: 1, maxTokens: 8192 })
    snapshot = migrated.snapshot()
    builtinProfile = snapshot.profiles.find((item) => item.id === 'profile.deepseek.default')!
    assert.equal(snapshot.models.find((item) => item.id === builtinProfile.modelId)?.remoteModelId, 'deepseek-v4-flash')
    assert.equal(snapshot.bindings?.defaultProfileId, customProfile.id)
    migrated.close()
  })

  await check('凭据 blob 与可见 metadata 分表，导出不含 secret/ref/hint', () => {
    const db = new DatabaseSync(dbPath)
    const blob = db.prepare('SELECT encrypted_blob FROM provider_credential_secrets LIMIT 1').get() as { encrypted_blob: Uint8Array }
    assert.equal(Buffer.from(blob.encrypted_blob).toString().includes('sk-r44-secret-1234'), false)
    const bundle = service.exportBundle()
    const text = JSON.stringify(bundle)
    assert.equal(/sk-r44|credentialRef|maskedHint|encrypted|authorization/i.test(text), false)
    db.close()
  })

  await check('safeStorage 不可用时 credential fail-closed 且不写 metadata', async () => {
    const lockedPath = path.join(temp, 'locked.db')
    const locked = new ProviderRegistryService(lockedPath, lockedVault)
    await locked.bootstrapDeepSeek({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: '', thinkingEnabled: true, reasoningEffort: 'high', temperature: 1, topP: 1, maxTokens: 8192 })
    assert.throws(() => locked.createCredential('provider.deepseek.builtin', 'x', 'secret'), (error: unknown) => error instanceof ProviderRegistryError && error.code === 'safe_storage_unavailable')
    assert.equal(locked.snapshot().credentials.length, 0)
    locked.close()
  })

  await check('URL policy 拒绝 scheme/userinfo/query/path/私网/metadata/mapped IPv6', async () => {
    await assert.rejects(validateProviderEndpoint('http://example.com', { scope: 'public_https', allowNonDefaultPort: false }, publicResolver))
    await assert.rejects(validateProviderEndpoint('https://u:p@example.com', { scope: 'public_https', allowNonDefaultPort: false }, publicResolver))
    await assert.rejects(validateProviderEndpoint('https://example.com?x=1', { scope: 'public_https', allowNonDefaultPort: false }, publicResolver))
    await assert.rejects(validateProviderEndpoint('https://example.com/v1', { scope: 'public_https', allowNonDefaultPort: false }, publicResolver))
    await assert.rejects(validateProviderEndpoint('https://example.com', { scope: 'public_https', allowNonDefaultPort: false }, privateResolver))
    assert.equal(classifyAddress('::ffff:127.0.0.1'), 'blocked')
    assert.equal(classifyAddress('10.0.0.1'), 'blocked')
    assert.equal(classifyAddress('93.184.216.34'), 'public')
  })

  await check('loopback HTTP 仅允许显式本地 scope，canonical join 拒绝穿越', async () => {
    const local = await validateProviderEndpoint('http://127.0.0.1:18789', { scope: 'loopback_http', allowNonDefaultPort: true })
    assert.equal(local.origin, 'http://127.0.0.1:18789')
    assert.equal(canonicalJoin(local.baseUrl, '/v1/models'), 'http://127.0.0.1:18789/v1/models')
    assert.throws(() => canonicalJoin(local.baseUrl, '/v1/%252e%252e/secret'))
    assert.throws(() => validateProviderEndpointSyntax('http://192.168.1.2', { scope: 'loopback_http', allowNonDefaultPort: true }))
  })

  await check('DNS 每次重验：首次公网、二次 metadata 的 rebinding 被拒绝', async () => {
    let calls = 0
    const rebinding = async (): Promise<Array<{ address: string; family: number }>> => {
      calls += 1
      return [{ address: calls === 1 ? '93.184.216.34' : '169.254.169.254', family: 4 }]
    }
    await validateProviderEndpoint('https://example.com', { scope: 'public_https', allowNonDefaultPort: false }, rebinding)
    await assert.rejects(validateProviderEndpoint('https://example.com', { scope: 'public_https', allowNonDefaultPort: false }, rebinding))
  })

  const bodies: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-reasoner', name: 'Mock Reasoner' }] }))
      return
    }
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      bodies.push(body)
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 5, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 1 } } }))
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: {"id":"mock","choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":1}}}\n\ndata: [DONE]\n\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    const customProvider = await service.createCustomProvider({ displayName: 'Mock OpenAI-compatible', baseUrl, chatPath: '/v1/chat/completions', modelsPath: '/v1/models', authStyle: 'bearer', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } })
    const customCredential = service.createCredential(customProvider.id, 'Mock key', 'sk-mock-secret')
    service.setDefaultCredential(customProvider.id, customCredential.id)

    await check('discover 是 preview→accept，/models 不伪造 reasoning 能力', async () => {
      const preview = await service.discoverPreview(customProvider.id, customCredential.id)
      assert.deepEqual(preview.models.map((item) => item.remoteModelId), ['mock-reasoner'])
      const accepted = service.acceptDiscovered(preview.discoveryId, ['mock-reasoner'])
      assert.equal(accepted[0].capabilities.reasoning.state, 'unknown')
      assert.equal(accepted[0].capabilities.text.source, 'models_endpoint')
    })

    const model = service.snapshot().models.find((item) => item.providerId === customProvider.id)!
    await check('手动声明未验证，reasoning Profile 不能发送高级参数', () => {
      const declared = service.addManualModel({ providerId: customProvider.id, remoteModelId: 'manual-reasoner', displayName: 'Manual', capabilities: { ...model.capabilities, reasoning: { state: 'supported', source: 'manual_declaration', verifiedAt: null, probeId: null, detailCode: 'user', modes: ['default', 'enabled'], efforts: ['high'], budget: null } } })
      assert.throws(() => service.upsertProfile({ id: 'profile.manual.test', name: 'Manual', providerId: customProvider.id, modelId: declared.id, credentialRefId: customCredential.id, generation: { temperature: 1, topP: 1, maxOutputTokens: 10, stream: true }, reasoning: { mode: 'enabled', effort: 'high', budgetTokens: null }, compatibilityMappingId: 'openai_chat.reasoning_effort_top_level' }), (error: unknown) => error instanceof ProviderRegistryError && error.code === 'reasoning_unsupported')
    })

    await check('显式 probe 才产生 verified evidence，usage 缺失保持 null', async () => {
      const probe = await service.probeModel(model.id, customCredential.id, true)
      assert.equal(probe.outcome, 'supported')
      assert.deepEqual(probe.usage, { inputTokens: 5, outputTokens: 1, reasoningTokens: 1 })
      const updated = service.snapshot().models.find((item) => item.id === model.id)!
      assert.equal(updated.capabilities.reasoning.source, 'protocol_probe')
      const saved = service.upsertProfile({ id: 'profile.mock.verified', name: 'Verified', providerId: customProvider.id, modelId: model.id, credentialRefId: customCredential.id, generation: { temperature: 1, topP: 1, maxOutputTokens: 10, stream: true }, reasoning: { mode: 'enabled', effort: 'high', budgetTokens: null }, compatibilityMappingId: 'openai_chat.reasoning_effort_top_level' })
      service.setBindings({ defaultProfileId: saved.id })
      assert.equal(service.isExplicitlyEnabled(), true)
    })

    await check('run 冻结后改 endpoint/model/default/replace key 不漂移，恢复仍解密原 version', () => {
      const verified = service.snapshot().profiles.find((item) => item.id === 'profile.mock.verified')!
      const frozen = service.freezeStageProfiles({ defaultProfileId: verified.id }, {
        maxTokens: 8192, temperature: 0.7, topP: 0.8, thinking: { enabled: false, effort: 'high' }
      })
      const oldCredential = frozen.draft.credential!
      const oldFingerprint = frozen.draft.fingerprint
      const alternateModel = service.addManualModel({ providerId: customProvider.id, remoteModelId: 'replacement-model', displayName: 'Replacement' })
      service.upsertProfile({
        id: verified.id, name: verified.name, providerId: customProvider.id, modelId: alternateModel.id, credentialRefId: customCredential.id,
        generation: { temperature: 0.1, topP: 0.2, maxOutputTokens: 99, stream: true },
        reasoning: { mode: 'default', effort: null, budgetTokens: null }, compatibilityMappingId: null
      })
      const alternateProfile = service.upsertProfile({
        id: 'profile.replacement', name: 'Replacement', providerId: customProvider.id, modelId: alternateModel.id, credentialRefId: customCredential.id,
        generation: { temperature: 0.1, topP: 0.2, maxOutputTokens: 99, stream: true },
        reasoning: { mode: 'default', effort: null, budgetTokens: null }, compatibilityMappingId: null
      })
      service.setBindings({ defaultProfileId: alternateProfile.id })
      service.replaceCredential(customCredential.id, 'sk-mock-replaced')
      const db = new DatabaseSync(dbPath)
      db.prepare('UPDATE provider_registry SET base_url=? WHERE id=?').run('http://127.0.0.1:65534', customProvider.id)
      db.close()
      assert.equal(frozen.default.profileId, verified.id)
      assert.equal(frozen.draft.provider.baseUrl, baseUrl)
      assert.equal(frozen.draft.model.remoteModelId, 'mock-reasoner')
      assert.equal(frozen.draft.generation.maxOutputTokens, 10)
      assert.equal(frozen.review.fingerprint, oldFingerprint)
      assert.equal(service.resolveFrozenCredential(oldCredential), 'sk-mock-secret')
      const resumedRegistry = new ProviderRegistryService(dbPath, vault)
      const restored = JSON.parse(JSON.stringify(frozen)) as typeof frozen
      assert.equal(resumedRegistry.resolveFrozenCredential(restored.draft.credential!), 'sk-mock-secret')
      resumedRegistry.close()
      assert.equal(service.resolveForRequest(verified.id).secret, 'sk-mock-replaced')
      assert.equal(JSON.stringify(frozen).includes('sk-mock-secret'), false)
      assert.equal(JSON.stringify(frozen).includes('sk-mock-replaced'), false)
    })

    await check('删除当前引用后，已冻结 credential version 仍可恢复且新解析拒绝 tombstone', () => {
      const disposable = service.createCredential(customProvider.id, 'Disposable', 'sk-disposable-old')
      const currentModel = service.snapshot().models.find((item) => item.remoteModelId === 'replacement-model')!
      const disposableProfile = service.upsertProfile({
        id: 'profile.disposable', name: 'Disposable', providerId: customProvider.id, modelId: currentModel.id, credentialRefId: disposable.id,
        generation: { temperature: 1, topP: 1, maxOutputTokens: 20, stream: true },
        reasoning: { mode: 'default', effort: null, budgetTokens: null }, compatibilityMappingId: null
      })
      const frozen = service.freezeStageProfiles({ defaultProfileId: disposableProfile.id }, { maxTokens: 20, temperature: 1, topP: 1, thinking: { enabled: false, effort: 'high' } })
      service.upsertProfile({ ...disposableProfile, credentialRefId: customCredential.id })
      service.deleteCredential(disposable.id)
      assert.equal(service.resolveFrozenCredential(frozen.default.credential!), 'sk-disposable-old')
      assert.throws(() => service.setDefaultCredential(customProvider.id, disposable.id), (error: unknown) => error instanceof ProviderRegistryError && error.code === 'credential_missing')
    })

    const baseParams = { apiKey: 'sk-mock-secret', baseUrl, model: 'mock-reasoner', messages: [{ role: 'user' as const, content: 'hello' }], thinking: { enabled: false, effort: 'high' as const }, maxTokens: 8, temperature: 0.7, topP: 0.8 }
    await streamChat(baseParams, () => undefined)
    const goldenBody = structuredClone(bodies.at(-1)!)
    await check('builtin DeepSeek golden body 保持 thinking/stream_options/sampling 形状', () => {
      const body = goldenBody
      assert.deepEqual(body.thinking, { type: 'disabled' })
      assert.deepEqual(body.stream_options, { include_usage: true })
      assert.equal(body.temperature, 0.7)
      assert.equal(body.top_p, 0.8)
    })

    await streamChat({ ...baseParams, provider: { adapterId: 'builtin.deepseek', chatPath: '/chat/completions', authStyle: 'bearer', transportPolicy: { scope: 'public_https', allowNonDefaultPort: false }, reasoning: { mode: 'default', effort: 'high' }, compatibilityMappingId: null } }, () => undefined)
    await check('迁移后的 builtin resolver wire payload 与 legacy golden 完全一致', () => {
      assert.deepEqual(bodies.at(-1), goldenBody)
    })

    await streamChat({ ...baseParams, provider: { adapterId: 'custom.openai-compatible-chat', chatPath: '/v1/chat/completions', authStyle: 'bearer', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true }, reasoning: { mode: 'default', effort: null }, compatibilityMappingId: null } }, () => undefined)
    await check('custom unknown/default 不发送 thinking/reasoning 字段', () => {
      const body = bodies.at(-1)!
      assert.equal('thinking' in body, false)
      assert.equal('reasoning_effort' in body, false)
    })

    await streamChat({ ...baseParams, provider: { adapterId: 'custom.openai-compatible-chat', chatPath: '/v1/chat/completions', authStyle: 'bearer', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true }, reasoning: { mode: 'enabled', effort: 'high' }, compatibilityMappingId: 'openai_chat.reasoning_effort_top_level' } }, () => undefined)
    await check('custom verified allowlist 只映射顶层 reasoning_effort', () => {
      const body = bodies.at(-1)!
      assert.equal(body.reasoning_effort, 'high')
      assert.equal('thinking' in body, false)
    })

    await check('DeepSeek 精确 tier 快照可估算，自定义端点默认 unknown', () => {
      const peak = service.estimateCost({ providerId: 'provider.deepseek.builtin', canonicalOrigin: 'https://api.deepseek.com', remoteModelId: 'deepseek-v4-flash', startedAt: Date.UTC(2026, 7, 24, 2), cacheHitTokens: 1000, cacheMissTokens: 1000, outputTokens: 1000 })
      assert.equal(peak.status, 'estimated')
      assert.ok((peak.amount ?? 0) > 0)
      assert.ok(peak.priceSnapshotId?.includes('.peak.'))
      const unknown = service.estimateCost({ providerId: customProvider.id, canonicalOrigin: baseUrl, remoteModelId: model.remoteModelId, startedAt: Date.now(), cacheHitTokens: 1, cacheMissTokens: 1, outputTokens: 1 })
      assert.deepEqual(unknown, { status: 'unknown', amount: null, currency: null, priceSnapshotId: null })
    })

    await check('probe ledger 持久记录 attempt/usage，cost unknown 不伪 0', () => {
      const db = new DatabaseSync(dbPath)
      const row = db.prepare('SELECT outcome,usage_json,cost_status,cost_amount FROM provider_probes ORDER BY started_at DESC LIMIT 1').get() as { outcome: string; usage_json: string; cost_status: string; cost_amount: number | null }
      assert.equal(row.outcome, 'supported')
      assert.equal(JSON.parse(row.usage_json).reasoningTokens, 1)
      assert.equal(row.cost_status, 'unknown')
      assert.equal(row.cost_amount, null)
      db.close()
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  await check('导入 preview 不联网，secret-like key 整体拒绝', async () => {
    let dnsCalls = 0
    const importPath = path.join(temp, 'import.db')
    const imported = new ProviderRegistryService(importPath, vault, async () => { dnsCalls += 1; return [{ address: '93.184.216.34', family: 4 }] })
    const bundle = {
      kind: 'deepwriter.provider-bundle', version: 1, exportedAt: new Date().toISOString(),
      providers: [{ externalId: 'external.safe', displayName: 'Safe', adapterId: 'custom.openai-compatible-chat', baseUrl: 'https://example.com', chatPath: '/v1/chat/completions', modelsPath: '/v1/models', authStyle: 'bearer', transportPolicy: { scope: 'public_https', allowNonDefaultPort: false } }],
      models: [], profiles: []
    }
    const preview = await imported.importPreview(bundle)
    assert.equal(preview.bundle.providers.length, 1)
    assert.equal(dnsCalls, 0)
    await assert.rejects(imported.importPreview({ ...bundle, apiKey: 'secret' }), (error: unknown) => error instanceof ProviderRegistryError && error.code === 'bundle_contains_secret')
    await assert.rejects(imported.importPreview({ ...bundle, providers: [{ ...bundle.providers[0], headers: { 'X-Unsafe': 'x' } }] }), (error: unknown) => error instanceof ProviderRegistryError && error.code === 'bundle_unknown_field')
    imported.close()
  })

  console.log(`\n[R44] ${passed}/${passed} PASS`)
} finally {
  service.close()
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
