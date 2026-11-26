const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
function declaration(file, name) {
  const source = readFileSync(path.join(root, file), 'utf8')
  const start = new RegExp(`^(?:export )?(?:(?:async )?function|class|const) ${name}(?=[\\s(<:=])`, 'm').exec(source)
  assert.ok(start, name)
  const end = /^}\r?$/m.exec(source.slice(start.index)); assert.ok(end)
  return source.slice(start.index, start.index + end.index + 1)
}
before(async () => {
  const index = 'src/main/index.ts'
  const functions = ['queueGrillWorkflowProjection', 'requireLongformWorkflowAuthority', 'bindLongformWorkflowRun', 'semanticReviewHash', 'semanticReviewFenceFromPacket', 'syncLongformSemanticReviewAuthority', 'syncLongformSemanticReviewProjection'].map(name => declaration(index, name)).join('\n')
  const queue = readFileSync(path.join(root, index), 'utf8').split(/\r?\n/).find(line => line.startsWith('const grillWorkflowSyncQueues ='))
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    import {createHash} from 'node:crypto';
    import {createRepository} from './src/main/db/repository';
    import {createRunStorePort} from './src/main/runKernelAdapter';
    import {createAgentRunEngine,provisionalNarrativeReviewOperationId} from './src/main/jobs/AgentRunEngine';
    import {buildExecutionSnapshot} from './src/main/executionSnapshot';
    import {createLongformWorkflowAuthority,createHybridLongformWorkflowSnapshotStore} from './src/main/longformWorkflow';
    import {longformWorkflowHash,nextLongformWorkflowStage} from './src/shared/longformWorkflow';
    import {grillMeOutlineHash} from './src/shared/grillMe';
    import {sceneContractPlanValid} from './src/main/narrative/sceneContract';
    ${declaration('src/main/ipcGuard.ts', 'IpcError')}
    let repository,longformWorkflowAuthority;
    ${queue}
    ${functions}
    export function ports(repo,authority){repository=repo;longformWorkflowAuthority=authority}
    export {createRepository,createRunStorePort,createAgentRunEngine,buildExecutionSnapshot,grillMeOutlineHash,createLongformWorkflowAuthority,createHybridLongformWorkflowSnapshotStore,provisionalNarrativeReviewOperationId,syncLongformSemanticReviewAuthority};
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent', plugins: [{ name: 'actual-longform-review-source', setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (!args.path.startsWith('.') && args.path !== 'electron') return { path: args.path, external: true }
      const target = args.path === 'electron' ? path.join(root, 'src/cli/host.ts') : path.resolve(args.resolveDir, args.path)
      const source = ['', '.ts', '.tsx', '.js', '/index.ts'].map(suffix => target + suffix).find(existsSync)
      if (!source || !source.startsWith(root + path.sep)) throw new Error('source outside workspace')
      return { path: source, namespace: 'source' }
    })
    build.onLoad({ filter: /.*/, namespace: 'source' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }))
  } }] })
  const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports); api = loaded.exports
})
async function fixture(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-review-projection-'))
  const repo = api.createRepository(path.join(dir, 'run.db')); repo.open()
  const runId = 'review-two-scenes', sessionId = 'review-session'
  const outline = { title: '灯塔', premise: '场景边界', targetChars: 240, sections: [1, 2].map(index => ({ id: 's' + index, title: '第' + index + '场', purpose: '文学推进', targetChars: 120, beats: ['产生一个可验证的现场变化'], sourceSlotIds: [] })) }
  const config = api.buildExecutionSnapshot({ payload: { id: runId, mode: 'longwrite', phase: 'execute', longMode: true, targetChars: 240, text: '写作', strongConstraints: { enabled: false }, grillMe: { stateId: 'confirmed', originalTask: '灯塔故事', targetChars: 240, answers: [], assumptions: [], approvedOutline: outline, outlineRevision: 1, outlineHash: api.grillMeOutlineHash(outline) } }, settings: { model: 'synthetic', baseUrl: 'http://127.0.0.1:9', maxTokens: 4096, temperature: .7, topP: 1, thinkingEnabled: false, reasoningEffort: 'high', workDir: dir, docDir: dir, novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000, strongConstraintEnabled: false }, sessionId, memory: { projectPath: '', projectContent: '', userContent: '' } })
  let calls = 0, publishHook = null
  const engine = api.createAgentRunEngine({ store: api.createRunStorePort(repo, path.join(dir, 'artifacts')), getConfig: () => config, modelCall: async () => { calls++; const text = '雾里没有人开口。' + Array.from({ length: 111 }, (_, index) => String.fromCodePoint(0x4e00 + index + calls * 200)).join('') + '。'; return { async *[Symbol.asyncIterator]() { yield { type: 'text', delta: text }; yield { type: 'finish', finishReason: 'stop' } } } }, toolExecutor: async () => '', onEvent: () => {}, onRunUpdate: () => {}, publishLongwriteArtifact: async ({ content, contentHash }) => { if (publishHook) await publishHook(); await fs.writeFile(path.join(dir, 'result.md'), content); return { displayName: 'result.md', relativePath: 'result.md', contentHash } } })
  let authority
  const reloadAuthority = () => { authority = api.createLongformWorkflowAuthority({ store: api.createHybridLongformWorkflowSnapshotStore({ repository: repo, baseDir: path.join(dir, 'workflows') }) }); api.ports(repo, authority) }
  reloadAuthority()
  try {
    assert.equal((await engine.start({ runId, sessionId, config })).ok, true)
    await authority.create({ workflowId: sessionId, sessionId, activeRunId: runId, ...config.storyScope })
    const step = async () => { try { await engine.step(runId) } catch { assert.equal(repo.getRun(runId).status, 'waiting_user') } }
    const decide = packet => engine.applyNarrativeReviewDecision({ runId, decision: 'accept_prose_no_state', expectedRevision: packet.revision, decisionId: api.provisionalNarrativeReviewOperationId(packet) }, { actor: 'test-user' })
    await body({ repo, engine, config, runId, sessionId, step, decide, reloadAuthority, setPublishHook(hook) { publishHook = hook }, get authority() { return authority } })
  } finally { repo.close(); assert.equal(path.dirname(dir), os.tmpdir()); assert.match(path.basename(dir), /^dw-review-projection-/); await fs.rm(dir, { recursive: true, force: true }) }
}
test('actual SQLite main review bridge handles final vs origin hashes, serial duplicate reads, next scene and rejects stale decision projection', async () => fixture(async f => {
  await f.step(); const first = await f.engine.getNarrativeReview(f.runId)
  await Promise.all(Array.from({ length: 6 }, () => api.syncLongformSemanticReviewAuthority(first)))
  const pending = await f.authority.get(f.sessionId); assert.equal(pending.semanticReviewFence.packetHash, first.packetHash)
  assert.equal((await f.decide(first)).ok, true)
  const final = await f.engine.getNarrativeReview(f.runId); assert.notEqual(final.packetHash, first.packetHash)
  assert.equal(final.decision.packetHash, first.packetHash)
  await assert.rejects(api.syncLongformSemanticReviewAuthority({ ...final, decision: { ...final.decision, packetHash: '0'.repeat(64) } }), /复核|决定/)
  await api.syncLongformSemanticReviewAuthority(final)
  f.reloadAuthority(); await api.syncLongformSemanticReviewAuthority(final)
  const committed = await f.authority.get(f.sessionId); assert.equal(committed.stage, 'reorientation'); assert.equal(committed.semanticReviewFence.status, 'accepted')
  await assert.rejects(api.syncLongformSemanticReviewAuthority(first), /陈旧|复核/)
  assert.equal((await f.authority.get(f.sessionId)).authoritativeRevision, committed.authoritativeRevision)
  await f.step(); const second = await f.engine.getNarrativeReview(f.runId)
  await api.syncLongformSemanticReviewAuthority(second)
  const next = await f.authority.get(f.sessionId); assert.equal(next.semanticReviewFence.sceneId, second.sceneId); assert.equal(next.stage, 'semantic_review'); assert.equal(next.reviewDecisionFence, null)
  await assert.rejects(api.syncLongformSemanticReviewAuthority(final), /决定|复核/)
  assert.equal((await f.authority.get(f.sessionId)).authoritativeRevision, next.authoritativeRevision)
  assert.equal((await f.decide(second)).ok, true)
  await api.syncLongformSemanticReviewAuthority(await f.engine.getNarrativeReview(f.runId))
  const done = await f.authority.get(f.sessionId); assert.equal(done.stage, 'export'); assert.equal(done.status, 'completed'); assert.equal(f.repo.getRun(f.runId).status, 'completed')
}))
test('actual SQLite static scope/outline drift and uncommitted/out-of-order scene cannot replace the pending workflow fence', async () => fixture(async f => {
  await f.step(); const first = await f.engine.getNarrativeReview(f.runId)
  await api.syncLongformSemanticReviewAuthority(first)
  const before = await f.authority.get(f.sessionId)
  for (const patch of [{ storyScope: { ...f.config.storyScope, branchId: 'other' } }, { grillMe: { ...f.config.grillMe, outlineHash: 'drift' } }]) {
    f.repo.updateRun(f.runId, { config_json: JSON.stringify({ ...f.config, ...patch }) })
    await assert.rejects(api.syncLongformSemanticReviewAuthority(first), /故事|大纲/)
    f.repo.updateRun(f.runId, { config_json: JSON.stringify(f.config) })
  }
  const contract = f.config.sceneContracts.contracts[1]
  await assert.rejects(api.syncLongformSemanticReviewAuthority({ ...first, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, contract, revision: first.revision + 10 }), /上一场|复核/)
  assert.equal((await f.authority.get(f.sessionId)).authoritativeRevision, before.authoritativeRevision)
}))
test('actual engine publication delay leaves reorientation until exact final packet is read after durable run completion, then exports only once', async () => fixture(async f => {
  await f.step(); const first = await f.engine.getNarrativeReview(f.runId)
  await api.syncLongformSemanticReviewAuthority(first); assert.equal((await f.decide(first)).ok, true)
  await api.syncLongformSemanticReviewAuthority(await f.engine.getNarrativeReview(f.runId))
  await f.step(); const second = await f.engine.getNarrativeReview(f.runId)
  await api.syncLongformSemanticReviewAuthority(second)
  let signalPublished, releasePublication
  const entered = new Promise(resolve => { signalPublished = resolve })
  const released = new Promise(resolve => { releasePublication = resolve })
  f.setPublishHook(async () => { signalPublished(); await released })
  const decision = f.decide(second)
  try {
    await entered
    assert.notEqual(f.repo.getRun(f.runId).status, 'completed')
    const final = JSON.parse(f.repo.getRunEvidence(f.runId, 'narrative_semantic_review').json)
    assert.equal(final.status, 'accepted'); assert.equal(final.decision.decision, 'accept_prose_no_state')
    await api.syncLongformSemanticReviewAuthority(final)
    const waiting = await f.authority.get(f.sessionId); assert.equal(waiting.stage, 'reorientation'); assert.equal(waiting.status, 'ready')
    await api.syncLongformSemanticReviewAuthority(final)
    assert.equal((await f.authority.get(f.sessionId)).authoritativeRevision, waiting.authoritativeRevision)
    await assert.rejects(api.syncLongformSemanticReviewAuthority({ ...final, packetHash: '0'.repeat(64) }), /复核|决定|证据/)
    releasePublication(); assert.equal((await decision).ok, true)
    assert.equal(f.repo.getRun(f.runId).status, 'completed')
    f.reloadAuthority(); await api.syncLongformSemanticReviewAuthority(final)
    const done = await f.authority.get(f.sessionId); assert.equal(done.stage, 'export'); assert.equal(done.status, 'completed')
    assert.equal(done.authoritativeRevision, waiting.authoritativeRevision + 1)
    await Promise.all(Array.from({ length: 4 }, () => api.syncLongformSemanticReviewAuthority(final)))
    assert.equal((await f.authority.get(f.sessionId)).authoritativeRevision, done.authoritativeRevision)
  } finally { releasePublication(); await decision }
}))
