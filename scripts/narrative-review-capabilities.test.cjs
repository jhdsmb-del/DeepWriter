const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
// Compile the exact private production functions for their two-sided unit
// cases; the durable packet tests below drive the public engine/SQLite API.
function localConst(name) {
  const source = readFileSync(path.join(root, 'src/main/jobs/AgentRunEngine.ts'), 'utf8')
  const start = source.indexOf('  const ' + name + ' = ')
  assert.ok(start >= 0)
  const next = /\n  const [A-Za-z]/u.exec(source.slice(start + 1))
  assert.ok(next)
  return source.slice(start, start + 1 + next.index)
}
before(async () => {
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    import {createHash} from 'node:crypto';
    import {stableNarrativeJson} from './src/main/narrative/stateDelta';
    import {isRoleBindingAmbiguityOnly} from './src/main/narrative/stateExtractor';
    import {isOpaqueSceneBeatRequirement} from './src/main/narrative/sceneContract';
    ${localConst('opaqueBeatIds')}
    ${localConst('isOpaqueReviewPacket')}
    ${localConst('reviewDecisionCapabilities')}
    ${localConst('reviewPacketHashInput')}
    ${localConst('reviewPacketHash')}
    export {reviewDecisionCapabilities,reviewPacketHash,stableNarrativeJson};
    export {buildExecutionSnapshot} from './src/main/executionSnapshot';
    export {createRepository} from './src/main/db/repository';
    export {createRunStorePort,createModelCallAdapter} from './src/main/runKernelAdapter';
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {grillMeOutlineHash} from './src/shared/grillMe';
    export {publishCliManuscript} from './src/cli/manuscript';
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent', plugins: [{ name: 'actual-review-capability-source', setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (!args.path.startsWith('.') && args.path !== 'electron') return { path: args.path, external: true }
      const target = args.path === 'electron' ? path.join(root, 'src/cli/host.ts') : path.resolve(args.resolveDir, args.path)
      const source = ['', '.ts', '.js', '/index.ts'].map(suffix => target + suffix).find(existsSync)
      if (!source || !source.startsWith(root + path.sep)) throw new Error('Source outside workspace')
      return { path: source, namespace: 'source' }
    })
    build.onLoad({ filter: /.*/, namespace: 'source' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }))
  } }] })
  const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports); api = loaded.exports
})
test('actual capability predicate advertises accept_unknown only for role-binding ambiguity, never opaque/missing beat or mixed reasons', () => {
  const base = { reason: 'narrative_state_pending_review', status: 'pending_review', missingBeatIds: [], contract: { requiredBeatEvidence: [] } }
  for (const reasons of [['narrative_state_directional_agent_pending'], ['narrative_state_directional_recipient_pending:b1']]) {
    assert.equal(api.reviewDecisionCapabilities({ ...base, reasons: reasons.map(code => ({ code })) }).accept_unknown.allowed, true)
  }
  for (const reasons of [[], ['missing_required_beat'], ['beat_uncertain'], ['narrative_state_directional_agent_pending', 'confirmed_fact_json_invalid']]) {
    assert.equal(api.reviewDecisionCapabilities({ ...base, reasons: reasons.map(code => ({ code })) }).accept_unknown.allowed, false)
  }
  assert.equal(api.reviewDecisionCapabilities({ ...base, status: 'accepted', reasons: [{ code: 'narrative_state_directional_agent_pending' }] }).accept_unknown.allowed, false)
})
async function opaqueFixture(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-review-capability-'))
  const repo = api.createRepository(path.join(dir, 'run.db')); repo.open()
  const runId = 'review-capability', sessionId = 'isolated-review-session'
  let calls = 0
  const output = '雾里没有人开口。' + Array.from({ length: 111 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join('') + '。'
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk }); request.on('end', () => {
      assert.ok(JSON.parse(raw).messages.length > 0); calls++
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\n'); response.end('data: [DONE]\n\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const outline = { title: '灯塔', premise: '语义边界', targetChars: 120, sections: [{ id: 's1', title: '灯塔', purpose: '文学场景', targetChars: 120, beats: ['产生一个可验证的现场变化'], sourceSlotIds: [] }] }
  const config = api.buildExecutionSnapshot({ payload: { id: runId, mode: 'longwrite', phase: 'execute', longMode: true, targetChars: 120, text: '写作', strongConstraints: { enabled: false }, grillMe: { stateId: 'frozen-grill', originalTask: '灯塔故事', targetChars: 120, answers: [], assumptions: [], approvedOutline: outline, outlineRevision: 1, outlineHash: api.grillMeOutlineHash(outline) } }, settings: { model: 'synthetic', baseUrl, maxTokens: 4096, temperature: .7, topP: 1, thinkingEnabled: false, reasoningEffort: 'high', workDir: dir, docDir: dir, novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000, strongConstraintEnabled: false }, sessionId, memory: { projectPath: '', projectContent: '', userContent: '' } })
  // Freeze explicit sufficient local-fixture limits; no real API/price or
  // production cap is altered to make this provider/fence test complete.
  config.providerCallBudget = { maxCalls: 8, maxTokens: 200000, maxCost: null, maxCostCny: null, maxWallClockMs: 15000 }
  config.completionContract.providerCallBudget = config.providerCallBudget
  const store = api.createRunStorePort(repo, path.join(dir, 'artifacts'))
  const configs = new Map([[runId, config]])
  const makeEngine = () => {
    let instance
    const adapter = api.createModelCallAdapter({ getApi: () => ({ apiKey: '', baseUrl, model: 'synthetic', maxTokens: 4096, temperature: .7, topP: 1, thinking: { enabled: false, effort: 'high' }, supportsTools: false, protocol: 'deepseek-chat', adapterId: 'builtin.deepseek', chatPath: '/chat/completions', authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } }), getConfig: id => configs.get(id), getSignal: id => instance.abortSignal(id), buildPrefix: async rc => rc.frozenSystemMessages })
    instance = api.createAgentRunEngine({ store, getConfig: id => configs.get(id), modelCall: adapter, toolExecutor: async () => '', onEvent: () => {}, onRunUpdate: () => {}, publishLongwriteArtifact: api.publishCliManuscript })
    return instance
  }
  let engine = makeEngine()
  try {
    assert.equal((await engine.start({ runId, sessionId, config })).ok, true)
    try { await engine.step(runId) } catch { assert.equal(repo.getRun(runId).status, 'waiting_user') }
    assert.equal(repo.getRun(runId).error_code, 'narrative_state_pending_review', repo.getRun(runId).error_message)
    await body({ dir, repo, engine, makeEngine, runId, sessionId, config, configs, get calls() { return calls } })
  } finally { repo.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(dir), os.tmpdir()); assert.match(path.basename(dir), /^dw-review-capability-/); await fs.rm(dir, { recursive: true, force: true }) }
}
test('actual SQLite old permissive packet keeps hash/revision/operation identity; effective opaque capability is closed and direct submit still refuses', async () => opaqueFixture(async f => {
    const { repo, runId, makeEngine } = f; let engine = f.engine
    const original = await engine.getNarrativeReview(runId)
    assert.equal(original.allowedDecisions.accept_unknown.allowed, false)
    // Model a valid historical packet, not a corrupt hash or a fake gate.
    const old = JSON.parse(repo.getRunEvidence(runId, 'narrative_semantic_review').json)
    old.allowedDecisions.accept_unknown = { allowed: true, disabledReason: null }
    old.packetHash = api.reviewPacketHash(old)
    repo.saveRunEvidence(runId, 'narrative_semantic_review', JSON.stringify(old))
    const activeEngine = engine
    engine = makeEngine(); await assert.rejects(engine.restore(runId), /story_ledger_fence_missing/)
    const view = await engine.getNarrativeReview(runId)
    assert.equal(view.allowedDecisions.accept_unknown.allowed, true)
    assert.equal(view.effectiveAllowedDecisions.accept_unknown.allowed, false)
    assert.equal(view.packetHash, old.packetHash); assert.equal(view.revision, old.revision)
    assert.equal(api.reviewPacketHash(view), old.packetHash)
    assert.equal(JSON.parse(repo.getRunEvidence(runId, 'narrative_semantic_review').json).effectiveAllowedDecisions, undefined)
    const operation = view.pendingOperation
    const refused = await engine.applyNarrativeReviewDecision({ runId, expectedRevision: view.revision, decision: 'accept_unknown', decisionId: 'invalid-unknown' }, { actor: 'test-user' })
    assert.equal(refused.ok, false); assert.match(refused.error, /accept_unknown|显式 unknown/)
    assert.equal(repo.getRunEvidence(runId, `narrative_semantic_review:claim:${view.revision}`), null)
    assert.equal(repo.getManuscriptSegmentsByRun(runId).filter(segment => segment.status === 'accepted' && segment.kind === 'prose').length, 0)
    const unchanged = await engine.getNarrativeReview(runId)
    assert.equal(unchanged.packetHash, old.packetHash); assert.deepEqual(unchanged.pendingOperation, operation); assert.equal(f.calls, 1)
    // The same unclaimed packet remains usable for the legitimate no-state
    // choice; neither old permission advertisement nor the rejected call owns it.
    // The active writer has the actual provider/ledger fence. Restart read and
    // rejection above do not assert a new engine may fabricate that fence.
    const accepted = await activeEngine.applyNarrativeReviewDecision({ runId, expectedRevision: view.revision, decision: 'accept_prose_no_state', decisionId: 'valid-no-state' }, { actor: 'test-user' })
    assert.equal(accepted.ok, true, accepted.error)
    const final = await engine.getNarrativeReview(runId)
    assert.equal(final.status, 'accepted'); assert.equal(final.effectiveAllowedDecisions.accept_unknown.allowed, false)
    assert.equal(JSON.parse(repo.getRunEvidence(runId, 'narrative_semantic_review').json).effectiveAllowedDecisions, undefined)
}))

test('real SQLite/provider SSE/restore retains the original fence; valid no-state approval completes with zero extra HTTP', async () => opaqueFixture(async f => {
  const original = await f.engine.getNarrativeReview(f.runId)
  const kind = 'narrative_review_story_fence:' + original.packetHash
  const bound = JSON.parse(f.repo.getRunEvidence(f.runId, kind).json)
  assert.equal(bound.packetHash, original.packetHash); assert.equal(bound.candidateHash, original.candidate.contentHash)
  const snapshotJson = f.repo.getRun(f.runId).config_json
  const restarted = f.makeEngine(); await restarted.restore(f.runId)
  const view = await restarted.getNarrativeReview(f.runId)
  assert.equal(view.packetHash, original.packetHash); assert.equal(view.revision, original.revision); assert.equal(f.calls, 1)
  const stale = await restarted.applyNarrativeReviewDecision({ runId: f.runId, expectedRevision: view.revision + 1, decision: 'accept_prose_no_state', decisionId: 'stale-review-input' }, { actor: 'test-user' })
  assert.equal(stale.ok, false); assert.equal(f.repo.getRunEvidence(f.runId, 'narrative_semantic_review:claim:' + view.revision), null)
  const approved = await restarted.applyNarrativeReviewDecision({ runId: f.runId, expectedRevision: view.revision, decision: 'accept_prose_no_state', decisionId: 'restored-valid-no-state' }, { actor: 'test-user' })
  assert.equal(approved.ok, true, approved.error); assert.equal(f.repo.getRun(f.runId).status, 'completed'); assert.equal(f.calls, 1)
  assert.equal(f.repo.getRun(f.runId).config_json, snapshotJson)
  assert.deepEqual(JSON.parse(f.repo.getRunEvidence(f.runId, kind).json), bound)
  const artifact = f.repo.getArtifactsByRun(f.runId).find(row => row.artifact_type === 'manuscript')
  assert.ok(artifact); const file = await fs.readFile(artifact.relative_path, 'utf8'); assert.equal(Array.from(file).length, 120)
  assert.equal(createHash('sha256').update(file).digest('hex'), artifact.hash)
}))

test('restored review rejects corrupt hash, different candidate/revision/scope and a new head; never blesses another tuple', async () => {
  for (const variant of ['hash', 'candidate', 'revision', 'scope', 'head']) await opaqueFixture(async f => {
    const packet = await f.engine.getNarrativeReview(f.runId)
    const kind = 'narrative_review_story_fence:' + packet.packetHash
    const record = JSON.parse(f.repo.getRunEvidence(f.runId, kind).json)
    if (variant === 'hash') record.hash = '0'.repeat(64)
    else {
      if (variant === 'candidate') record.candidateHash = '0'.repeat(64)
      if (variant === 'revision') record.revision++
      if (variant === 'scope') record.fence.scope.storyId = 'another-story'
      if (variant === 'head') { record.fence.expectedHeadRevision = 1; record.fence.expectedHeadHash = '1'.repeat(64) }
      const { hash, ...body } = record; record.hash = createHash('sha256').update(api.stableNarrativeJson(body)).digest('hex')
    }
    f.repo.saveRunEvidence(f.runId, kind, JSON.stringify(record))
    await assert.rejects(f.makeEngine().restore(f.runId), /narrative_review_story_fence_corrupt|story_ledger_concurrent_head_conflict/)
    assert.equal(f.calls, 1); assert.equal(f.repo.getRunEvidence(f.runId, 'narrative_semantic_review:claim:' + packet.revision), null)
    assert.equal(f.repo.getManuscriptSegmentsByRun(f.runId).filter(row => row.status === 'accepted' && row.kind === 'prose').length, 0)
  })
})

test('another actual scene commit advances the authority; restored old provider fence refuses without any new request', async () => opaqueFixture(async f => {
  const packet = await f.engine.getNarrativeReview(f.runId)
  const bound = f.repo.getRunEvidence(f.runId, 'narrative_review_story_fence:' + packet.packetHash).json
  const otherId = 'other-story-run'; const otherConfig = structuredClone(f.config)
  otherConfig.allowParallel = true
  otherConfig.clientRequestId = otherId
  f.configs.set(otherId, otherConfig)
  const other = f.makeEngine(); assert.equal((await other.start({ runId: otherId, sessionId: f.sessionId, config: otherConfig })).ok, true)
  try { await other.step(otherId) } catch { assert.equal(f.repo.getRun(otherId).status, 'waiting_user') }
  const otherPacket = await other.getNarrativeReview(otherId)
  const accepted = await other.applyNarrativeReviewDecision({ runId: otherId, expectedRevision: otherPacket.revision, decision: 'accept_prose_no_state', decisionId: 'concurrent-other-scene' }, { actor: 'test-user' })
  assert.equal(accepted.ok, true, accepted.error)
  assert.equal(f.repo.getStoryLedgerFreshness(f.runId).fresh, false)
  const count = f.calls
  await assert.rejects(f.makeEngine().restore(f.runId), /story_ledger_concurrent_head_conflict/)
  assert.equal(f.calls, count); assert.equal(f.repo.getRun(f.runId).status, 'recovery_required')
  assert.equal(f.repo.getRunEvidence(f.runId, 'narrative_review_story_fence:' + packet.packetHash).json, bound)
  assert.equal(f.repo.getRunEvidence(f.runId, 'narrative_semantic_review:claim:' + packet.revision), null)
}))

async function committedBeforeFinalPacket(f) {
  const packet = await f.engine.getNarrativeReview(f.runId)
  const original = f.repo.saveRunEvidenceBundle
  let injected = false
  f.repo.saveRunEvidenceBundle = function (runId, entries) {
    if (!injected && entries.some(entry => entry.kind === 'narrative_semantic_review')) { injected = true; throw new Error('post-commit-final-packet-failure') }
    return original.call(f.repo, runId, entries)
  }
  const input = { runId: f.runId, expectedRevision: packet.revision, decision: 'accept_prose_no_state', decisionId: 'own-commit-review', note: 'original decision' }
  try { await assert.rejects(f.engine.applyNarrativeReviewDecision(input, { actor: 'test-user' }), /post-commit-final-packet-failure/) }
  finally { f.repo.saveRunEvidenceBundle = original }
  assert.equal(injected, true)
  assert.equal(f.repo.getSceneStates(f.runId)[0].lifecycle, 'committed')
  assert.equal(f.repo.getManuscriptSegmentsByRun(f.runId).filter(row => row.status === 'accepted' && row.kind === 'prose').length, 1)
  assert.equal(JSON.parse(f.repo.getRunEvidence(f.runId, 'narrative_semantic_review').json).status, 'pending_review')
  return { packet, input, kind: 'narrative_review_story_fence:' + packet.packetHash }
}
test('real SQLite post-commit/final-packet failure restores only exact own +1 ledger hash; same decision repairs without HTTP or fence replacement', async () => opaqueFixture(async f => {
  const { packet, input, kind } = await committedBeforeFinalPacket(f)
  const originalFence = f.repo.getRunEvidence(f.runId, kind).json
  const restarted = f.makeEngine(); await restarted.restore(f.runId)
  const accepted = await restarted.applyNarrativeReviewDecision(input, { actor: 'test-user' })
  assert.equal(accepted.ok, true, accepted.error); assert.equal(accepted.terminal, true)
  assert.equal(f.repo.getRun(f.runId).status, 'completed'); assert.equal(f.calls, 1)
  assert.equal(f.repo.getRunEvidence(f.runId, kind).json, originalFence)
  const final = await restarted.getNarrativeReview(f.runId)
  assert.equal(final.status, 'accepted'); assert.equal(final.revision, packet.revision + 1)
  assert.equal((await restarted.applyNarrativeReviewDecision({ ...input, note: 'different payload' }, { actor: 'test-user' })).ok, false)
  const artifact = f.repo.getArtifactsByRun(f.runId).find(row => row.artifact_type === 'manuscript')
  const text = await fs.readFile(artifact.relative_path, 'utf8')
  assert.equal(createHash('sha256').update(text).digest('hex'), artifact.hash)
}))
test('own-commit forward repair rejects missing/corrupt original binding and exact-head/manifest drift, not just unrelated run cursor movement', async () => {
  for (const variant of ['missing', 'hash', 'scope', 'candidate', 'head', 'manifest']) await opaqueFixture(async f => {
    const { kind } = await committedBeforeFinalPacket(f)
    const record = JSON.parse(f.repo.getRunEvidence(f.runId, kind).json)
    if (variant === 'missing') f.repo.getRunEvidence = ((original) => function (id, wanted) { return wanted === kind ? null : original.call(f.repo, id, wanted) })(f.repo.getRunEvidence)
    else if (variant === 'manifest') f.repo.getSceneCommitManifest = ((original) => function (...args) { return { ...original.apply(f.repo, args), contractHash: '0'.repeat(64) } })(f.repo.getSceneCommitManifest)
    else {
      if (variant === 'hash') record.hash = '0'.repeat(64)
      else {
        if (variant === 'scope') record.fence.scope.storyId = 'another-story'
        if (variant === 'candidate') record.candidateHash = '0'.repeat(64)
        if (variant === 'head') record.fence.expectedHeadHash = '1'.repeat(64)
        const { hash, ...body } = record; record.hash = createHash('sha256').update(api.stableNarrativeJson(body)).digest('hex')
      }
      f.repo.saveRunEvidence(f.runId, kind, JSON.stringify(record))
    }
    await assert.rejects(f.makeEngine().restore(f.runId), /story_ledger_fence_missing|narrative_review_story_fence_corrupt|story_ledger_concurrent_head_conflict/)
    assert.equal(f.calls, 1)
    assert.equal(JSON.parse(f.repo.getRunEvidence(f.runId, 'narrative_semantic_review').json).status, 'pending_review')
    assert.equal(f.repo.getArtifactsByRun(f.runId).filter(row => row.artifact_type === 'manuscript').length, 0)
  })
})
