import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRepository } from '../src/main/db/repository'
import { CURRENT_SCHEMA_VERSION } from '../src/main/db/migrations'
import { ContextV2Error, ContextV2Service, contextHash, contextPrefixHash, rankBm25, selectContextCandidates, type ContextCandidate } from '../src/main/contextV2'
import { createContextService } from '../src/main/contextService'
import { assembleContext } from '../src/main/contextAssembler'
import { buildRunBillingView, type ProviderAttemptRecord } from '../src/shared/billing'
import type { ContextManifestV2, ContextMode, ContextPolicyV2 } from '../src/shared/contextV2'
import type { DsMessage } from '../src/shared/types'

let passed = 0
async function check(name: string, test: () => void | Promise<void>): Promise<void> {
  await test()
  passed += 1
  console.log(`  PASS  ${name}`)
}

const temp = await mkdtemp(path.join(tmpdir(), 'deepwriter-r45-context-'))
const dbPath = path.join(temp, 'context.db')
const repo = createRepository(dbPath)
repo.open()
const service = new ContextV2Service(dbPath)
const contextService = createContextService(repo, service)

const policy = (mode: ContextMode): ContextPolicyV2 => ({ schemaVersion: 2, mode, revision: 0, recentBundles: { optimized: 6, minimal: 2 }, retrieval: { enabled: true, algorithm: 'bm25-local-v1', maxItems: 8, maxEstimatedTokens: 4000, minScore: 0.05 }, summary: { enabled: true, schemaVersion: 1, triggerBundles: 12 }, failClosed: true, outputReserveTokens: 1000 })
// v14 is the historical migration that introduced Context V2. The repository
// itself always opens at CURRENT_SCHEMA_VERSION; keep both assertions explicit
// so a later append-only migration does not turn this focused test red.
const CONTEXT_OPTIMIZATION_SCHEMA_VERSION = 14
const candidate = (id: string, content: string, required = false, bundleId?: string, order = 60): ContextCandidate => ({ source: { sourceType: required ? 'pinned_fact' : 'recent_turn', canonicalId: id, revision: null, contentHash: contextHash(content), span: null, displayLabel: id }, role: 'user', content, required, order, bundleId })

try {
  console.log('\n[R45] 可见上下文优化 / durable manifest 定向验证')
  await check('v14 migration 建立 preference/pin/summary/append-only manifest 与 attempt 关联字段', () => {
    const db = new DatabaseSync(dbPath)
    const schemaVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    assert.equal(schemaVersion, CURRENT_SCHEMA_VERSION)
    assert.ok(schemaVersion >= CONTEXT_OPTIMIZATION_SCHEMA_VERSION)
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name)
    for (const name of ['context_preferences', 'context_pins', 'context_summaries', 'context_manifests_v2']) assert.ok(names.includes(name), name)
    const cols = (db.prepare('PRAGMA table_info(provider_call_attempts)').all() as Array<{ name: string }>).map((row) => row.name)
    assert.ok(cols.includes('context_manifest_id'))
    assert.ok(cols.includes('context_mode'))
    db.close()
  })

  await check('新会话默认 optimized；已有会话无偏好时兼容 full', () => {
    assert.equal(service.getPreference('brand-new').mode, 'optimized')
    repo.createSession('existing', '已有会话', 'deepseek-v4-flash')
    assert.equal(service.getPreference('existing').mode, 'full')
  })

  await check('mode revision CAS 拒绝并发覆盖且尊重明确选择', () => {
    const first = service.setMode('brand-new', 'minimal', 0)
    assert.equal(first.mode, 'minimal')
    assert.throws(() => service.setMode('brand-new', 'full', 0), (error: unknown) => error instanceof ContextV2Error && error.code === 'revision_conflict')
  })

  await check('固定消息校验内容 hash；固定事实进入不可裁剪集合', () => {
    repo.createSession('pins', 'Pins', 'deepseek-v4-flash')
    repo.appendSessionMessage({ msg_id: 'm1', session_id: 'pins', seq: 1, role: 'user', content: '女主角的伞是红色，这是已确认事实。', status: 'done', created_at: 1 })
    assert.throws(() => service.pinMessage('pins', 'm1', contextHash('错误内容')), (error: unknown) => error instanceof ContextV2Error && error.code === 'pin_source_mismatch')
    service.pinMessage('pins', 'm1', contextHash('女主角的伞是红色，这是已确认事实。'))
    service.pinFact('pins', '结局不得改成说教式总结。')
    const frozen = service.freezeForRun({ sessionId: 'pins', selection: null, draftText: '续写', attachments: [], outputReserveTokens: 1000, capabilityFingerprint: 'cap' })
    const resolved = service.resolveFrozenPins('pins', frozen)
    assert.equal(resolved.length, 2)
    assert.ok(resolved.every((entry) => entry.required))
  })

  await check('本地 BM25 同时检索中文与 Latin 词，不依赖网络 embedding', () => {
    const docs = [candidate('rain', '雨巷里红伞折断'), candidate('api', 'provider retry budget and cache'), candidate('other', '无关材料')]
    assert.equal(rankBm25('红伞 雨巷', docs)[0]?.candidate.source.canonicalId, 'rain')
    assert.equal(rankBm25('provider retry cache', docs)[0]?.candidate.source.canonicalId, 'api')
  })

  await check('full 超窗 fail-closed，不静默裁剪', () => {
    assert.throws(() => selectContextCandidates({ mode: 'full', policy: policy('full'), budgetTokens: 20, base: [candidate('required', '必须保留'.repeat(20), true)], history: [candidate('old', '旧历史'.repeat(30), false, 'b1')], summary: null, query: '' }), (error: unknown) => error instanceof ContextV2Error && ['context_required_overflow', 'context_full_overflow'].includes(error.code))
  })

  await check('minimal 保留 essential/pinned + 最近两轮并排除摘要和检索', () => {
    const history = [1, 2, 3, 4].flatMap((bundle) => [candidate(`u${bundle}`, `用户${bundle}`, false, `b${bundle}`), candidate(`a${bundle}`, `助手${bundle}`, false, `b${bundle}`)])
    const summary = { ...candidate('summary', '摘要', false, undefined, 40), source: { ...candidate('summary', '摘要').source, sourceType: 'rolling_summary' as const } }
    const result = selectContextCandidates({ mode: 'minimal', policy: policy('minimal'), budgetTokens: 1000, base: [candidate('pin', '固定事实', true)], history, summary, query: '用户1' })
    assert.ok(result.decisions.find((entry) => entry.source.canonicalId === 'pin')?.included)
    assert.ok(result.decisions.filter((entry) => entry.included && entry.source.sourceType === 'recent_turn').every((entry) => ['u3', 'a3', 'u4', 'a4'].includes(entry.source.canonicalId)))
    assert.equal(result.decisions.find((entry) => entry.source.canonicalId === 'summary')?.included, false)
    assert.equal(result.retrievalUsed, false)
  })

  await check('optimized 纳入活动摘要、最近轮次并用 BM25 找回更早相关事实', () => {
    const history = [candidate('old-red', '早先明确红伞只能由女主角持有', false, 'b1'), ...[2, 3, 4, 5, 6, 7, 8].map((bundle) => candidate(`h${bundle}`, `普通对话 ${bundle}`, false, `b${bundle}`))]
    const summary = { ...candidate('summary', '已确认摘要', false, undefined, 40), source: { ...candidate('summary', '已确认摘要').source, sourceType: 'rolling_summary' as const } }
    const result = selectContextCandidates({ mode: 'optimized', policy: policy('optimized'), budgetTokens: 2000, base: [candidate('pin', '固定红伞事实', true)], history, summary, query: '红伞 女主角' })
    assert.ok(result.decisions.find((entry) => entry.source.canonicalId === 'summary')?.included)
    assert.ok(result.decisions.some((entry) => entry.included && entry.source.canonicalId === 'old-red' && entry.source.sourceType === 'retrieved_history'))
    assert.equal(result.retrievalUsed, true)
  })

  await check('结构化摘要只引用 canonical spans；来源被篡改后 fail-closed', () => {
    repo.createSession('summary', 'Summary', 'deepseek-v4-flash')
    for (let index = 1; index <= 14; index++) repo.appendSessionMessage({ msg_id: `s${index}`, session_id: 'summary', seq: index, role: index % 2 ? 'user' : 'assistant', content: `第${index}条已确认内容`, status: 'done', created_at: index })
    const summary = service.rebuildSummary('summary')
    assert.ok(summary && summary.items.every((item) => item.sources.length > 0 && !['draft_unconfirmed', 'disputed'].includes(item.confirmation)))
    const db = new DatabaseSync(dbPath)
    db.prepare("UPDATE session_messages SET content='被篡改' WHERE msg_id=?").run(summary?.items[0]?.sources[0]?.id)
    db.close()
    assert.throws(() => service.getActiveSummary('summary'), (error: unknown) => error instanceof ContextV2Error && error.code === 'summary_source_mismatch')
  })

  await check('critic/editor 保留 R42 system+user envelope 的字节与顺序，不注入 writer 上下文', async () => {
    repo.createSession('wire-aux', 'Aux wire', 'deepseek-v4-flash')
    const frozen = service.freezeForRun({ sessionId: 'wire-aux', selection: null, draftText: 'candidate', attachments: [], outputReserveTokens: 100, capabilityFingerprint: 'cap' })
    const input: DsMessage[] = [
      { role: 'system', content: 'critic/editor system prompt: only review the supplied candidate.' },
      { role: 'user', content: JSON.stringify({ candidateHash: 'abc', candidate: '候选正文', writingIntent: { task: '只审校候选' } }) }
    ]
    for (const purpose of ['critic', 'editor'] as const) {
      const result = await contextService.assembleRunContext({
        clientRequestId: `aux-${purpose}`,
        sessionId: 'wire-aux',
        frozenContext: frozen,
        contextPolicy: { contextWindowTokens: 10000, outputReserveTokens: 100 },
        story: { enabled: true, worldSetting: '不得注入到审校请求' },
        planText: '不得注入到审校请求',
        strongConstraints: { sourceTask: '不得注入到审校请求' }
      }, -1, input, [{ role: 'system', content: 'writer system must not leak' }], purpose, `aux-${purpose}`)
      assert.deepEqual(result.messages, input)
      assert.equal(result.manifest.promptHash, contextHash(input.map((message) => message.content).join('')))
      assert.ok(result.contextV2?.decisions.every((entry) => entry.required && entry.included))
      assert.equal(result.contextV2?.decisions.some((entry) => entry.source.sourceType === 'policy_memory' || entry.source.sourceType === 'story_bible'), false)
    }
  })

  await check('full writer 与 R42 wire envelope 等价，Story/constraint 只保留 provenance alias', async () => {
    repo.createSession('wire-full', 'Full wire', 'deepseek-v4-flash')
    repo.appendSessionMessage({ msg_id: 'wf-u1', session_id: 'wire-full', seq: 1, role: 'user', content: '历史用户消息', status: 'done', created_at: 1 })
    repo.appendSessionMessage({ msg_id: 'wf-a1', session_id: 'wire-full', seq: 2, role: 'assistant', content: '历史助手消息', status: 'done', created_at: 2 })
    const prefix: DsMessage[] = [
      { role: 'system', content: '## static story system\n红伞与灯塔' },
      { role: 'system', content: '## 项目记忆（项目）\n固定记忆' },
      { role: 'user', content: '[附件] notes.md：只此一次' }
    ]
    const current = '当前任务：续写红伞'
    const frozen = service.freezeForRun({ sessionId: 'wire-full', selection: null, draftText: current, attachments: [], outputReserveTokens: 100, capabilityFingerprint: 'cap' })
    const result = await contextService.assembleRunContext({
      clientRequestId: 'wire-full-run', sessionId: 'wire-full', frozenContext: frozen,
      contextPolicy: { contextWindowTokens: 10000, outputReserveTokens: 100 },
      story: { enabled: true, worldSetting: '红伞与灯塔' }, planText: '不可重复发送',
      strongConstraints: { sourceTask: current, mustKeep: '红伞' }
    }, 1, [{ role: 'user', content: current }], prefix, 'writer', 'wire-full-request')
    const legacy = assembleContext({
      runId: 'wire-full-run', round: 1, contextWindowTokens: 10000, outputReserveTokens: 100,
      staticSystem: [prefix[0]], memory: [prefix[1]], attachments: [prefix[2]],
      user: { msgId: 'm_wire-full-run_user', content: current },
      history: [
        { msgId: 'wf-u1', role: 'user', content: '历史用户消息' },
        { msgId: 'wf-a1', role: 'assistant', content: '历史助手消息' }
      ], toolResults: [], assetSummaries: []
    })
    assert.deepEqual(result.messages, legacy.messages)
    assert.equal(result.manifest.promptHash, contextHash(legacy.messages.map((message) => message.content).join('')))
    assert.equal(result.contextV2?.decisions.filter((entry) => entry.source.sourceType === 'story_bible' || entry.source.sourceType === 'hard_constraint').every((entry) => entry.required && entry.included && entry.selectedEstimatedTokens === 0), true)
    assert.equal(result.messages.some((message) => message.content.includes('不可重复发送')), false)
  })

  await check('preview 与 final assembler 对 frozen required prefix 同时 fail-closed，并校验 prefix TOCTOU hash', async () => {
    repo.createSession('wire-overflow', 'Overflow wire', 'deepseek-v4-flash')
    const frozen = service.freezeForRun({ sessionId: 'wire-overflow', selection: null, draftText: 'draft', attachments: [], outputReserveTokens: 100, capabilityFingerprint: 'cap' })
    const requiredPrefix: DsMessage[] = [{ role: 'system', content: '必需冻结系统 '.repeat(4000) }]
    const prefixHash = contextPrefixHash(requiredPrefix)
    const preview = service.preview({ sessionId: 'wire-overflow', mode: 'full', draftText: 'draft', attachments: [], maxContextTokens: 1000, outputReserveTokens: 100, capabilityFingerprint: 'cap', requiredPrefix, prefixHash })
    assert.equal(preview.prefixHash, prefixHash)
    assert.equal(preview.budget.status, 'overflow')
    await assert.rejects(() => contextService.assembleRunContext({ clientRequestId: 'wire-overflow-run', sessionId: 'wire-overflow', frozenContext: frozen, contextPolicy: { contextWindowTokens: 1000, outputReserveTokens: 100 } }, 1, [{ role: 'user', content: 'draft' }], requiredPrefix, 'writer', 'wire-overflow-request'), (error: unknown) => error instanceof ContextV2Error && ['context_required_overflow', 'context_full_overflow'].includes(error.code))
    assert.throws(() => service.freezeForRun({ sessionId: 'wire-overflow', selection: { schemaVersion: 1, previewId: preview.previewId, mode: 'full', policyRevision: preview.policyRevision }, draftText: 'draft', attachments: [], outputReserveTokens: 100, capabilityFingerprint: 'cap', prefixHash: contextPrefixHash([{ role: 'system', content: 'changed' }]) }), (error: unknown) => error instanceof ContextV2Error && error.code === 'context_preview_stale')
  })

  await check('approved execute preview keeps independent sourceTask in the accepted prefix hash', () => {
    repo.createSession('wire-plan-approve', 'Plan approval', 'deepseek-v4-flash')
    const sourceTask = '最后一条用户任务：保留红伞事实并续写灯塔场景'
    const previewPrefix: DsMessage[] = [{ role: 'system', content: `冻结强约束\n用户任务：${sourceTask}` }]
    const finalAcceptedPrefix: DsMessage[] = [{ role: 'system', content: `冻结强约束\n用户任务：${sourceTask}` }]
    const previewPrefixHash = contextPrefixHash(previewPrefix)
    assert.equal(previewPrefixHash, contextPrefixHash(finalAcceptedPrefix))
    const preview = service.preview({
      sessionId: 'wire-plan-approve', mode: 'full', draftText: '', attachments: [], maxContextTokens: 10000,
      outputReserveTokens: 100, capabilityFingerprint: 'cap', requiredPrefix: previewPrefix,
      requiredAliases: [{ sourceType: 'current_task', label: '当前任务', content: sourceTask }], prefixHash: previewPrefixHash
    })
    assert.equal(preview.budget.status, 'ready')
    const frozen = service.freezeForRun({
      sessionId: 'wire-plan-approve',
      selection: { schemaVersion: 1, previewId: preview.previewId, mode: 'full', policyRevision: preview.policyRevision },
      draftText: '', attachments: [], outputReserveTokens: 100, capabilityFingerprint: 'cap', prefixHash: contextPrefixHash(finalAcceptedPrefix)
    })
    assert.equal(frozen.mode, 'full')
  })

  await check('preview 冻结校验 canonical/pin/draft/attachment/capability 指纹', () => {
    const pref = service.getPreference('pins', 1000)
    const preview = service.preview({ sessionId: 'pins', mode: pref.mode, draftText: '续写红伞', attachments: [], maxContextTokens: 10000, outputReserveTokens: 1000, capabilityFingerprint: 'cap-v1' })
    const frozen = service.freezeForRun({ sessionId: 'pins', selection: { schemaVersion: 1, previewId: preview.previewId, mode: pref.mode, policyRevision: pref.revision }, draftText: '续写红伞', attachments: [], outputReserveTokens: 1000, capabilityFingerprint: 'cap-v1' })
    assert.equal(frozen.mode, pref.mode)
    assert.throws(() => service.freezeForRun({ sessionId: 'pins', selection: { schemaVersion: 1, previewId: preview.previewId, mode: pref.mode, policyRevision: pref.revision }, draftText: '已变化', attachments: [], outputReserveTokens: 1000, capabilityFingerprint: 'cap-v1' }), (error: unknown) => error instanceof ContextV2Error && error.code === 'context_preview_stale')
  })

  await check('manifest 以 requestId append-only；相同 envelope 幂等，冲突拒绝覆盖', () => {
    repo.createSession('ledger', 'Ledger', 'deepseek-v4-flash')
    repo.acceptChatStart({ sessionId: 'ledger', title: 'Ledger', model: 'deepseek-v4-flash', run: { run_id: 'run-ledger', session_id: 'ledger', status: 'queued', phase: 'queued', started_at: 1, updated_at: 1, config_json: '{}', parent_run_id: null, error_code: null, error_message: null, client_request_id: 'run-ledger' }, userTurn: { turn_id: 'run-ledger_user', run_id: 'run-ledger', turn_seq: 1, role: 'user', content: 'x', reasoning_content: null, tool_calls_json: null, tool_result_json: null, plan_state: null, created_at: 1 } })
    const manifest: ContextManifestV2 = { schemaVersion: 2, manifestId: 'ctx-ledger', runId: 'run-ledger', stageId: 'draft', requestId: 'request-ledger', roundIndex: 1, createdAt: new Date(1).toISOString(), mode: 'optimized', policySnapshot: policy('optimized'), policyRevision: 0, providerId: 'deepseek', modelId: 'model', capabilityFingerprint: 'cap', inputBudgetTokens: 9000, outputReserveTokens: 1000, selectedEstimate: { value: 100, kind: 'local_estimate', sourceId: null, estimatorVersion: 'local' }, fullBaselineEstimate: { value: 200, kind: 'local_estimate', sourceId: null, estimatorVersion: 'local' }, estimatedSavedTokens: 100, estimatedSavingsRatio: .5, summaryRef: null, retrieval: null, pinRevision: 0, sourceSetHash: 'set', envelopeHash: 'envelope', decisions: [], persistedBeforeProviderSend: true }
    service.appendManifest(manifest)
    service.appendManifest(manifest)
    assert.equal(service.getManifest('request-ledger')?.envelopeHash, 'envelope')
    assert.throws(() => service.appendManifest({ ...manifest, envelopeHash: 'different' }), (error: unknown) => error instanceof ContextV2Error && error.code === 'manifest_idempotency_conflict')
  })

  await check('账单按 manifestId 关联 provider attempt；outer 行不与 inner retry 重复计入', () => {
    const attempt = (patch: Partial<ProviderAttemptRecord>): ProviderAttemptRecord => ({
      attemptId: 'attempt', runId: 'run-ledger', logicalCallId: 'request-ledger', attemptNo: 1, stageId: 'draft', actor: 'writer', subtype: null,
      providerId: 'provider', endpointOrigin: 'http://127.0.0.1', modelId: 'model', providerRequestId: null, outcome: 'success', httpStatus: 200,
      startedAt: 1, firstTokenAt: 2, endedAt: 3, inputTokens: null, outputTokens: null, cacheHitTokens: null, cacheMissTokens: null, reasoningTokens: null,
      costStatus: 'unknown', costAmount: null, costCurrency: null, priceSnapshotId: null, ...patch
    })
    const view = buildRunBillingView({
      runId: 'run-ledger', revision: 1, finalized: true, status: 'completed', startedAt: 1, endedAt: 3, toolCalls: 0,
      attempts: [
        attempt({ attemptId: 'outer', contextManifestId: null, inputTokens: 999 }),
        attempt({ attemptId: 'inner-1', attemptNo: 1, contextManifestId: 'ctx-ledger', inputTokens: 120 }),
        attempt({ attemptId: 'inner-2', attemptNo: 2, contextManifestId: 'ctx-ledger', inputTokens: 80 })
      ],
      contextManifests: [service.getManifest('request-ledger') as ContextManifestV2]
    })
    assert.equal(view.context.requests[0]?.actualInputTokens, 200)
  })

  console.log(`\nR45_CONTEXT_PASS=${passed}`)
} finally {
  service.close()
  repo.close()
  await rm(temp, { recursive: true, force: true })
}
