const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { before, test } = require('node:test')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
before(async () => {
  const built = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
    export {createRepository} from './src/main/db/repository'; export {ProviderRegistryService} from './src/main/providerRegistry';
    export {ContextV2Service} from './src/main/contextV2'; export {createContextService} from './src/main/contextService';
    export {createModelCallAdapter} from './src/main/runKernelAdapter'; export {buildExecutionSnapshot} from './src/main/executionSnapshot';
    export {loadCliConfig,cliModelContext} from './src/cli/config'; export {estimateTokens} from './src/shared/types';
  ` }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', alias: { electron: path.join(root, 'src/cli/host.ts') }, write: false, logLevel: 'silent' })
  const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports); api = module.exports
})

async function fixture(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-model-auto-')), database = path.join(dir, 'context.db')
  const repo = api.createRepository(database); repo.open()
  const service = new api.ContextV2Service(database), context = Object.assign(api.createContextService(repo, service), {repository:repo})
  const registry = new api.ProviderRegistryService(database, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('no key access') }, decryptString: () => { throw new Error('no key access') } })
  try { await body({ dir, repo, service, context, registry }) } finally { registry.close(); service.close(); repo.close(); await fs.rm(dir, { recursive: true, force: true }) }
}

async function profiles(registry, window = 65536) {
  const provider = await registry.createCustomProvider({ displayName: 'Local specification fixture', baseUrl: 'http://127.0.0.1:48211', chatPath: '/v1/chat/completions', modelsPath: null, authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true, protocol: 'openai-chat' } })
  const draft = registry.addManualModel({ providerId: provider.id, remoteModelId: 'declared-writer', displayName: 'Writer', contextWindow: window, maxOutputTokens: 4096 })
  const review = registry.addManualModel({ providerId: provider.id, remoteModelId: 'declared-review', displayName: 'Review', contextWindow: 32768, maxOutputTokens: 2048 })
  const make = (id, model, output) => registry.upsertProfile({ id, name: id, providerId: provider.id, modelId: model.id, credentialRefId: null,
    generation: { maxOutputTokens: output, stream: true, temperature: .7, topP: .9 }, reasoning: { mode: 'default', effort: null, budgetTokens: null }, compatibilityMappingId: null })
  const writer = make('profile.writer', draft, 1024), critic = make('profile.critic', review, 512)
  const frozen = registry.freezeStageProfiles({ defaultProfileId: writer.id, draftProfileId: writer.id, reviewProfileId: critic.id },
    { maxTokens: 8192, temperature: .7, topP: .9, thinking: { enabled: false, effort: 'high' }, providerCapabilityOverride: { contextWindowTokens: 1000000, maxOutputTokens: 256 } })
  return { frozen, provider, draft }
}
const append = (repo, session, id, seq, role, content, status = 'done') => repo.appendSessionMessage({ msg_id: id, session_id: session, seq, role, content, status, created_at: seq })
const configFor = (service, frozen, session, id, automatic = true) => ({ clientRequestId: id, sessionId: session, runMode: 'agent', longMode: false, maxTokens: 1024, providerProfileSnapshots: frozen,
  toolPolicy: { allowList: ['read_file'] }, contextPolicy: { contextWindowTokens: frozen.draft.contextBudget.contextWindowTokens, outputReserveTokens: 1024, ...(automatic ? { management: 'model_auto_v1' } : {}) },
  frozenContext: service.freezeForRun({ automatic, sessionId: session, draftText: id, attachments: [], outputReserveTokens: 1024, capabilityFingerprint: frozen.draft.fingerprint }) })

async function wire(context, config, prefix, live, purpose = 'writer') {
  let sent, manifest
  if (!context.repository.getRun(config.clientRequestId)) context.repository.createRun({ run_id: config.clientRequestId, session_id: config.sessionId, status: 'running', phase: 'thinking', started_at: Date.now(), updated_at: Date.now(), config_json: JSON.stringify(config), parent_run_id: null, error_code: null, error_message: null })
  const profile = purpose === 'critic' ? config.providerProfileSnapshots.review : config.providerProfileSnapshots.draft
  const adapter = api.createModelCallAdapter({ getConfig: () => config, getSignal: () => undefined, buildPrefix: async () => prefix,
    getApi: () => ({ profileId: profile.profileId, providerId: profile.provider.id, apiKey: '', baseUrl: profile.provider.baseUrl, model: profile.model.remoteModelId, maxTokens: profile.generation.maxOutputTokens,
      thinking: { enabled: false, effort: 'high' }, temperature: .7, topP: .9, supportsTools: true }),
    assembleContext: async (...args) => { const result = await context.assembleRunContext(...args); return { ...result, contextV2: result.contextV2 ?? null } },
    persistContext: (...args) => { manifest = context.persistContext(...args); return manifest }, streamChatImpl: async (params, emit) => { sent = params; emit({ type: 'done', finishReason: 'stop' }) } })
  for await (const _ of await adapter({ runId: config.clientRequestId, phase: purpose === 'critic' ? 'review' : 'generating', turnSeq: 1, round: 1, messages: live, purpose })) {}
  return {...sent, manifest}
}

test('actual registry freezes declared model windows and each stage output, not old global overrides; old frozen metadata stays immutable', async () => fixture(async ({ registry }) => {
  const { frozen, provider, draft } = await profiles(registry)
  assert.deepEqual(frozen.draft.contextBudget, { contextWindowTokens: 65536, outputReserveTokens: 1024, source: 'model_declaration' })
  assert.deepEqual(frozen.review.contextBudget, { contextWindowTokens: 32768, outputReserveTokens: 512, source: 'model_declaration' })
  const before = JSON.stringify(frozen)
  registry.addManualModel({ providerId: provider.id, remoteModelId: draft.remoteModelId, displayName: 'Changed after freeze', contextWindow: 16384, maxOutputTokens: 2048 })
  assert.equal(JSON.stringify(frozen), before)
}))

test('60 canonical messages + many fixed sources keep actual wire order; adjacent tasks share the entire stable prefix without duplicate current input', async () => fixture(async ({ registry, repo, service, context }) => {
  const { frozen } = await profiles(registry)
  const session = 'ordered-session'; repo.createSession(session, session, 'declared-writer')
  service.setMode(session, 'minimal', 0)
  for (let index = 0; index < 60; index++) append(repo, session, 'history-' + index, index + 1, index % 2 ? 'assistant' : 'user', `canonical-${index}`, index === 1 ? 'completed' : 'done')
  for (let index = 0; index < 8; index++) service.pinFact(session, '固定事实-' + index)
  const prefix = Array.from({ length: 55 }, (_, index) => ({ role: 'system', content: 'stable-prefix-' + index }))
  const first = configFor(service, frozen, session, 'new-task-one')
  assert.equal(first.frozenContext.mode, 'optimized'); assert.equal(first.frozenContext.policy.management, 'model_auto_v1')
  assert.equal(service.getPreference(session).mode, 'minimal', 'historical preference is not rewritten')
  const request = await wire(context, first, prefix, [{ role: 'user', content: 'new-task-one' }])
  assert.deepEqual(request.messages.slice(0, prefix.length), prefix)
  assert.deepEqual(request.messages.filter(message => message.content.startsWith('canonical-')).map(message => message.content), Array.from({ length: 60 }, (_, index) => `canonical-${index}`))
  assert.equal(request.messages.at(-1).content, 'new-task-one')
  assert.equal(request.messages.filter(message => message.content === 'new-task-one').length, 1)
  append(repo, session, 'm_new-task-one_user', 61, 'user', 'new-task-one')
  append(repo, session, 'm_new-task-one_assistant', 62, 'assistant', 'accepted-reply-one')
  const second = configFor(service, frozen, session, 'new-task-two')
  const next = await wire(context, second, prefix, [{ role: 'user', content: 'new-task-two' }])
  assert.deepEqual(next.messages.slice(0, request.messages.length), request.messages, 'a new task does not move current input into old history or alter stable prefix bytes')
  assert.equal(next.messages.at(-2).content, 'accepted-reply-one'); assert.equal(next.messages.at(-1).content, 'new-task-two')
}))

test('small-model automatic history clips before live tools, preserves required sources and complete newest pairs; critic uses its own window', async () => fixture(async ({ registry, repo, service, context }) => {
  const { frozen } = await profiles(registry, 8192)
  const session = 'pressure-session'; repo.createSession(session, session, 'declared-writer'); service.setMode(session, 'full', 0)
  for (let index = 0; index < 52; index++) append(repo, session, 'long-' + index, index + 1, index % 2 ? 'assistant' : 'user', `${index}:` + '旧段落资料'.repeat(400))
  service.pinFact(session, '必须保留：资料来自本地合成夹具。')
  const config = configFor(service, frozen, session, 'pressure-run'), live = [{ role: 'user', content: 'pressure-run' }]
  for (let index = 0; index < 7; index++) live.push({ role: 'assistant', content: '', tool_calls: [{ id: 'read-' + index, name: 'read_file', arguments: '{}' }] },
    { role: 'tool', tool_call_id: 'read-' + index, content: JSON.stringify({ ok: true, message: '来源正文'.repeat(350), exitCode: null, backupId: null }) })
  const before = JSON.stringify(live)
  const sent = await wire(context, config, [{ role: 'system', content: '冻结约定：准确整理来源。' }], live)
  assert.equal(JSON.stringify(live), before)
  assert(sent.messages.some(message => message.content.includes('必须保留')))
  assert(sent.messages.some(message => message.content.includes('原记录仍保留')))
  for (const id of ['read-5', 'read-6']) {
    assert(sent.messages.some(message => message.tool_calls?.some(call => call.id === id)))
    assert(sent.messages.some(message => message.tool_call_id === id))
  }
  for (const message of sent.messages.filter(message => message.role === 'tool')) assert(sent.messages.some(assistant => assistant.tool_calls?.some(call => call.id === message.tool_call_id)))
  assert.equal(sent.messages.filter(message => message.content === 'pressure-run').length, 1)
  assert(sent.manifest.decisions.some(item => !item.included && item.selectionReason === 'budget' && item.source.sourceType === 'active_tool_pair'))
  assert(sent.messages.reduce((sum, message) => sum + api.estimateTokens(JSON.stringify(message)), 0) + sent.maxTokens < 8192)
  const reviewed = await wire(context, config, [], [{ role: 'user', content: 'review-candidate' }], 'critic')
  assert.equal(reviewed.maxTokens, 512)
  assert.equal(reviewed.manifest.inputBudgetTokens, 32768 - 512)
  const old = configFor(service, frozen, session, 'old-frozen', false)
  const frozenBefore = JSON.stringify(old.frozenContext)
  await assert.rejects(wire(context, old, [], [{ role: 'user', content: 'old-frozen' }]), /完整上下文/)
  assert.equal(JSON.stringify(old.frozenContext), frozenBefore)
}))

test('new CLI automatically resolves official defaults, honest unknown fallback and model-bound custom declarations', async () => fixture(async ({ dir, service }) => {
  const load = options => api.loadCliConfig(dir, { 'key-env': 'DW_SYNTHETIC_UNUSED_CONTEXT_TEST_KEY', ...options })
  const official = (await load({})).config
  assert.equal(official.contextWindow, 1048576); assert.equal(official.contextSource, 'trusted_builtin')
  const unknown = (await load({ model: 'synthetic-unknown', 'base-url': 'http://127.0.0.1:48211', loopback: true })).config
  assert.equal(unknown.contextWindow, 8192); assert.equal(unknown.contextSource, 'conservative_default'); assert.equal(unknown.maxTokens, 2048)
  const preview = service.preview({ automatic: true, contextSource: unknown.contextSource, sessionId: 'unknown-preview', mode: 'full', draftText: '当前任务', attachments: [], maxContextTokens: unknown.contextWindow, outputReserveTokens: unknown.maxTokens, capabilityFingerprint: 'synthetic-unknown' })
  assert.equal(preview.mode, 'optimized'); assert.equal(preview.modelSpecSource, 'conservative_default')
  assert(preview.warnings.some(warning => warning.code === 'conservative_context_budget'))
  const declared = (await load({ model: 'synthetic-unknown', 'base-url': 'http://127.0.0.1:48211', loopback: true, context: '65536' })).config
  assert.equal(declared.contextWindow, 65536); assert.equal(declared.contextSource, 'model_declaration')
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(declared))
  assert.equal((await load({})).config.contextWindow, 65536)
  assert.equal((await load({model:'another-model'})).config.contextWindow, 8192, 'a previous model declaration is not reused for a newly selected model')
}))

test('ordinary Agent keeps early problem, constraints, accepted decision and later correction after repeated over-window compactions; no pin or mode selection', async () => fixture(async ({ registry, repo, service, context, dir }) => {
  const { frozen } = await profiles(registry, 8192)
  const session = 'long-chat', other = 'same-title-different-session'
  repo.createSession(session, '灯塔迁移', 'declared-writer'); repo.createSession(other, '灯塔迁移', 'declared-writer')
  append(repo, other, 'alien-user', 1, 'user', '同名灯塔迁移只允许 PostgreSQL；口令 ALIEN-SESSION-SENTINEL。')
  append(repo, session, 'origin-user', 1, 'user', '普通 Agent 项目：灯塔迁移。问题是断网后怎样继续查看记录？必须离线可用、不得新增付费服务；保留 CSV 导出。最初目标数据库为 SQLite。')
  append(repo, session, 'origin-assistant', 2, 'assistant', '建议决定：采用本地追加日志；最终交付先提供迁移演练，再执行正式迁移。')
  append(repo, session, 'approve-user', 3, 'user', '确认采用上条回复的本地追加日志与先演练后正式迁移决定；但仍然不允许后台上传。')
  const extend = (from, to) => {
    for (let seq = from; seq <= to; seq++) append(repo, session, 'turn-' + seq, seq, seq % 2 ? 'user' : 'assistant', seq % 2
      ? `第 ${seq} 轮：继续整理刚才的示例记录。`
      : `第 ${seq} 轮整理结果：` + '这里是一般性示例正文，逐项展开并核对记录。'.repeat(150), seq === 16 ? 'completed' : 'done')
  }
  extend(4, 40)
  const first = configFor(service, frozen, session, 'checkpoint-one')
  assert(first.frozenContext.summary)
  extend(41, 80)
  append(repo, session, 'correction-user', 81, 'user', '更正灯塔迁移数据库：从现在起改为 DuckDB，替代最早的 SQLite；离线、无新增付费和 CSV 导出约束保持不变。')
  append(repo, session, 'correction-assistant', 82, 'assistant', '收到更正，后续以 DuckDB 方案继续。')
  extend(83, 120)
  const middle = configFor(service, frozen, session, 'checkpoint-middle')
  assert.equal(service.resolveFrozenSummary(session, middle.frozenContext.summary).previousSummaryHash, first.frozenContext.summary.hash)
  extend(121, 180)
  const next = configFor(service, frozen, session, 'checkpoint-two')
  const summary = service.resolveFrozenSummary(session, next.frozenContext.summary)
  assert.equal(summary.previousSummaryHash, middle.frozenContext.summary.hash)
  assert.equal(summary.sourceHighWatermark, 180)
  assert(summary.items.length <= 192)
  assert(summary.items.some(item => item.sources[0].id === 'origin-user'))
  assert(summary.items.some(item => item.sources[0].id === 'correction-user'))
  assert(summary.items.every(item => item.confirmation === 'extractive_source'))
  const stable = JSON.stringify(next.frozenContext)
  const sent = await wire(context, next, [{ role: 'system', content: '你是普通 Agent，准确承接用户工作。' }], [{ role: 'user', content: '继续。' }])
  const input = sent.messages.map(message => message.content).join('\n')
  for (const expected of ['断网后怎样继续查看记录', '不得新增付费服务', 'CSV 导出', '本地追加日志', '先演练后正式迁移', 'DuckDB', '替代最早的 SQLite']) assert(input.includes(expected), expected)
  assert(!input.includes('ALIEN-SESSION-SENTINEL')); assert(!input.includes('PostgreSQL'))
  const checkpoint = sent.messages.find(message => message.content.startsWith('## 会话历史原文摘录'))
  assert(checkpoint); assert.equal(checkpoint.role, 'user')
  const quotes = checkpoint.content.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  assert(quotes.find(item => item.source === 'correction-user').seq > quotes.find(item => item.source === 'origin-user').seq)
  assert(checkpoint.content.includes('冲突时以较新的用户原话及当前输入为准'))
  assert.equal(sent.messages.at(-1).content, '继续。')
  assert.equal(JSON.stringify(next.frozenContext), stable)
  assert(sent.manifest.selectedEstimate.value + sent.maxTokens < 8192)
  assert(sent.manifest.fullBaselineEstimate.value > 8192 * 10, 'conversation really exceeds the selected model window many times')
  const decision = sent.manifest.decisions.find(item => item.included && item.source.sourceType === 'rolling_summary')
  assert(decision.summaryItemIds.length > 0 && decision.summaryItemIds.length <= summary.items.length)
  service.close(); repo.close()
  const restored = new api.ContextV2Service(path.join(dir, 'context.db'))
  const recoveredRepo = api.createRepository(path.join(dir, 'context.db')); recoveredRepo.open()
  try {
    assert.equal(restored.resolveFrozenSummary(session, next.frozenContext.summary).summaryHash, summary.summaryHash)
    assert.deepEqual(restored.getManifest(sent.manifest.requestId), sent.manifest)
    assert.equal(restored.resolveSourceSnippet(sent.manifest.requestId, decision.itemId).status, 'available')
    const reopened = Object.assign(api.createContextService(recoveredRepo, restored), { repository: recoveredRepo })
    const rerun = await reopened.assembleRunContext(next, 1, [{ role: 'user', content: '继续。' }], [{ role: 'system', content: '你是普通 Agent，准确承接用户工作。' }], 'writer', 'reopened-context-request')
    assert(rerun.messages.some(message => message.content.includes('DuckDB')))
    // Later accepted messages must not leak into a run's frozen history.
    append(recoveredRepo, session, 'future-user', 181, 'user', '未来另一任务 FUTURE-SENTINEL；改用云端。')
    const recovered = await reopened.assembleRunContext(next, 2, [{ role: 'user', content: '恢复原来的运行' }], [], 'writer', 'recovered-context-request')
    assert(!JSON.stringify(recovered.messages).includes('FUTURE-SENTINEL'))
    assert.equal(restored.resolveFrozenSummary(session, first.frozenContext.summary).summaryHash, first.frozenContext.summary.hash)
    await fs.mkdir(path.join(root, 'out/harness-41'), { recursive: true })
    await fs.writeFile(path.join(root, 'out/harness-41/conversation-memory-evidence.json'), JSON.stringify({
      synthetic: true, providerCalls: 1, additionalSummaryModelCalls: 0, modelWindow: 8192,
      sourceHighWatermark: summary.sourceHighWatermark, fullBaseline: sent.manifest.fullBaselineEstimate.value,
      selectedEstimate: sent.manifest.selectedEstimate.value, frozenSummary: next.frozenContext.summary,
      finalMessages: sent.messages, decisions: sent.manifest.decisions,
      reloadVerified: true, crossSessionIsolated: true, frozenHistoryIsolated: true
    }, null, 2))
  } finally { restored.close(); recoveredRepo.close() }
}))

test('small-window checkpoint is adaptive rather than all-or-nothing, with exact supplementary-plane spans and no fabricated facts', async () => fixture(async ({ repo, service, registry, context }) => {
  const { frozen } = await profiles(registry, 4096)
  const session = 'unicode-memory'; repo.createSession(session, session, 'declared-writer')
  const early = '🧭'.repeat(140) + '原问题：怎样在内网部署？必须仅用现有机器；预算为 37 元；保留路径 /data/客户 A。'
  append(repo, session, 'unicode-first', 1, 'user', early)
  for (let seq = 2; seq <= 70; seq++) append(repo, session, 'unicode-' + seq, seq, seq % 2 ? 'user' : 'assistant', seq % 2 ? `第${seq}次继续例子。` : '不重要的历史演示。'.repeat(250))
  const config = configFor(service, frozen, session, 'unicode-run')
  const summary = service.resolveFrozenSummary(session, config.frozenContext.summary)
  for (const item of summary.items.filter(item => item.sources[0].id === 'unicode-first')) assert.equal(early.slice(item.sources[0].spanStart, item.sources[0].spanEnd), item.text)
  const sent = await wire(context, config, [], [{ role: 'user', content: '继续，按当前决定推进。' }])
  assert(sent.messages.some(message => message.content.includes('预算为 37 元')))
  const selected = sent.manifest.decisions.find(item => item.source.sourceType === 'rolling_summary' && item.included)
  assert(selected); assert(selected.summaryItemIds.length < summary.items.length)
  assert(sent.manifest.selectedEstimate.value + sent.maxTokens < 4096)
  assert.equal(service.resolveFrozenSummary(session, config.frozenContext.summary).summaryHash, summary.summaryHash)
}))

test('conversation backfill headroom stays soft when frozen pins and current input need the window', async () => fixture(async ({ registry, repo, service, context }) => {
  const { frozen } = await profiles(registry, 8192)
  const session = 'required-before-backfill'; repo.createSession(session, session, 'declared-writer')
  service.pinFact(session, '甲'.repeat(3000)); service.pinFact(session, '乙'.repeat(3000))
  const config = { ...configFor(service, frozen, session, 'required-before-backfill-run'), contextAssemblyReserveTokens: 100, contextOptionalReadReserveTokens: 1536 }
  const assembled = await context.assembleRunContext(config, 1, [{ role: 'user', content: '当前输入不可裁剪。' }], [], 'writer', 'required-before-backfill-request')
  assert(assembled.messages.some(message => message.content.includes('甲'.repeat(3000))))
  assert(assembled.messages.some(message => message.content.includes('乙'.repeat(3000))))
  assert.equal(assembled.messages.at(-1).content, '当前输入不可裁剪。')
}))
