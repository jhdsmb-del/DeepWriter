const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const { readFileSync, existsSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let runtime
before(async () => {
  const bundle = await esbuild.build({
    absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
      export { createAgentRunEngine } from './src/main/jobs/AgentRunEngine';
      export { createRepository } from './src/main/db/repository';
      export { createRunStorePort, createModelCallAdapter } from './src/main/runKernelAdapter';
      export { buildExecutionSnapshot } from './src/main/executionSnapshot';
      export { configureTerminalHost } from './src/cli/host';
      export { publishCliManuscript } from './src/cli/manuscript';
      export { grillMeOutlineHash } from './src/shared/grillMe';
    ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent',
    plugins: [{ name: 'node-boundary', setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!args.path.startsWith('.') && args.path !== 'electron') return { path: args.path, external: true }
        const target = args.path === 'electron' ? path.join(root, 'src/cli/host.ts') : path.resolve(args.resolveDir, args.path)
        const found = ['', '.ts', '.js', '/index.ts'].map((ext) => target + ext).find(existsSync)
        if (!found || !found.startsWith(root + path.sep)) throw new Error('Test source outside workspace')
        return { path: found, namespace: 'source' }
      })
      build.onLoad({ filter: /.*/, namespace: 'source' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }))
    } }]
  })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, loaded, loaded.exports)
  runtime = loaded.exports
})
const hash = (text) => createHash('sha256').update(text).digest('hex')
const unique = (n, offset = 0) => Array.from({ length: n }, (_, index) => String.fromCodePoint(0x4e00 + index + offset)).join('')
async function fixture(name, { target = 0, budget = 100000, strong = false, pipeline = false, edit = false, mustKeep = '', prefix = '', sceneSections = 0, evidenceAttack = '', outputs = ['灯塔仍亮着。'] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-cli-boundary-'))
  let calls = 0
  let writerCalls = 0
  const reviewedCandidates = []
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (data) => { body += data }); req.on('end', () => {
      calls++
      const request = JSON.parse(body)
      let review = null
      try { review = JSON.parse([...request.messages].reverse().find((message) => message.role === 'user').content) } catch {}
      let output
      if (review?.candidateHash && typeof review.candidate === 'string') {
        reviewedCandidates.push(review.candidate)
        const quote = Array.from(review.candidate).slice(4, 6).join('')
        output = JSON.stringify({ schemaVersion: 1, candidateHash: review.candidateHash, issues: edit && !review.candidate.includes('晨雾') ? [{ issueId: 'q1', code: 'cliche_language', severity: 'advisory', basis: 'quality', startCp: 4, endCp: 6, quote, reason: '局部文字建议', repairIntent: '保持事件' }] : [] })
      } else if (review?.candidateHash && review.issue) output = JSON.stringify({ schemaVersion: 1, candidateHash: review.candidateHash, patches: [{ ...review.issue, replacement: '晨雾' }] })
      else output = outputs[writerCalls++] ?? outputs.at(-1)
      const inputTokens = target ? 10 : Buffer.byteLength(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: null }] })}\n\n`)
      // Deliberately above the old messages-only fallback, but <= exact body
      // bound. This is valid accounting, not a fake engine/provider seam.
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: 10, total_tokens: inputTokens + 10 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const repo = runtime.createRepository(path.join(dir, 'runs.sqlite')); repo.open()
  const runId = name; const sessionId = `${name}-session`
  repo.createSession(sessionId, '灯塔', 'fixture')
  const outline = sceneSections ? { title: '灯塔', premise: '点亮灯塔并描写夜景。', targetChars: target,
    sections: Array.from({ length: sceneSections }, (_, index) => ({ id: `s${index + 1}`, title: '灯塔夜景', purpose: '点亮灯塔后描写灯塔夜景。', beats: ['点亮灯塔'], targetChars: target / sceneSections, sourceSlotIds: ['goal'] })) } : null
  const config = runtime.buildExecutionSnapshot({
    payload: { id: runId, sessionId, text: '写灯塔的故事，只输出正文。', mode: target ? 'longwrite' : 'agent', longMode: target > 0, targetChars: target, phase: 'execute',
      ...(outline ? { grillMe: { stateId: `grill-${name}`, originalTask: '描写灯塔夜景。', targetChars: target, answers: [{ slotId: 'goal', value: '灯塔夜景', source: 'user' }], assumptions: [], approvedOutline: outline, outlineRevision: 1, outlineHash: runtime.grillMeOutlineHash(outline) } } : {}) },
    sessionId, memory: { projectPath: '', projectContent: '', userContent: '' }, settings: {
      model: 'fixture', baseUrl, maxTokens: 256, temperature: 0.7, topP: 0.9, thinkingEnabled: false, reasoningEffort: 'low',
      workDir: dir, docDir: path.join(dir, 'documents'), novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 8000, strongConstraintEnabled: strong,
      ...(pipeline ? { themeLockMode: 'off' } : {}), strongConstraintMustKeep: mustKeep
    }
  })
  config.providerCallBudget = { maxCalls: 10, maxTokens: budget, maxCost: null, maxCostCny: null, maxWallClockMs: 60000 }
  if (config.completionContract) config.completionContract.providerCallBudget = config.providerCallBudget
  let observer = 0; let engine
  const adapter = runtime.createModelCallAdapter({
    getApi: () => ({ apiKey: '', baseUrl, model: 'fixture', maxTokens: 256, temperature: 0.7, topP: 0.9, thinking: { enabled: false, effort: 'low' }, profileId: 'node-test', protocol: 'deepseek-chat', adapterId: 'builtin.deepseek', chatPath: '/chat/completions', authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } }),
    getConfig: () => config, getSignal: () => engine.abortSignal(runId),
    buildPrefix: async () => [{ role: 'system', content: prefix || '只输出灯塔小说正文。' }],
    beforeProviderAttempt: () => { observer++ }
  })
  runtime.configureTerminalHost({ dataDir: dir, docDir: config.docDir })
  const store = runtime.createRunStorePort(repo, path.join(dir, 'artifacts'))
  let oldAcceptedScene = null
  const saveEvidence = store.saveRunEvidence
  store.saveRunEvidence = async (id, kind, json) => {
    if (kind === 'scene_contract_latest') {
      const data = JSON.parse(json)
      if (data.stage === 'accepted') oldAcceptedScene = json
      if (data.stage === 'candidate' && evidenceAttack === 'old' && oldAcceptedScene && JSON.parse(oldAcceptedScene).segmentId !== data.segmentId) json = oldAcceptedScene
      if (data.stage === 'candidate' && evidenceAttack === 'missing') return
    }
    await saveEvidence(id, kind, json)
  }
  engine = runtime.createAgentRunEngine({ store, modelCall: adapter, getConfig: () => config, toolExecutor: async () => '', onEvent: () => {}, onRunUpdate: () => {}, publishLongwriteArtifact: runtime.publishCliManuscript })
  assert.equal((await engine.start({ runId, sessionId, config })).ok, true)
  await store.appendTurn({ runId, turnId: `${runId}-user`, turnSeq: 1, role: 'user', content: '写灯塔。', createdAt: Date.now() })
  return { repo, engine, runId, calls: () => calls, observer: () => observer, config, reviewedCandidates,
    close: async () => { repo.close(); await new Promise((resolve) => server.close(resolve)); assert.ok(path.basename(dir).startsWith('deepwriter-cli-boundary-')); await fs.rm(dir, { recursive: true, force: true }) } }
}
test('生产 adapter 将真实 HTTP body 交给 engine top-up；合理实际用量不触发假超支', async () => {
  const f = await fixture('exact-topup', { prefix: unique(1200) })
  try {
    await f.engine.step(f.runId)
    assert.equal(f.repo.getRun(f.runId).status, 'completed', f.repo.getRun(f.runId).error_message)
    const ledger = JSON.parse(f.repo.getRunEvidence(f.runId, 'run_provider_budget_v1').json)
    assert.equal(ledger.tokenReservationCorrupt, false); assert.equal(ledger.totalCalls, 1)
    assert.equal(f.calls(), 1); assert.equal(f.observer(), 1)
  } finally { await f.close() }
})
test('SQLite：审校消费已拼接/裁切候选，不能拿新分片审校hash接受整段', async () => {
  const first = `灯塔旁${unique(173)}`
  const second = `灯塔${unique(46, 200)}。${unique(240, 500)}。`
  const f = await fixture('reviewed-projection', { target: 220, strong: true, pipeline: true, outputs: [first, second] })
  try {
    await f.engine.step(f.runId)
    assert.equal(f.repo.getRun(f.runId).status, 'completed', f.repo.getRun(f.runId).error_message)
    const accepted = f.repo.getManuscriptSegmentsByRun(f.runId).filter((row) => row.status === 'accepted').map((row) => row.content).join('')
    assert.ok(f.reviewedCandidates.includes(accepted))
    const pipeline = JSON.parse(f.repo.getRunEvidence(f.runId, 'writing_pipeline_latest').json)
    assert.equal(pipeline.candidateHash, hash(accepted)); assert.equal(pipeline.stage, 'accepted')
    assert.equal(f.calls(), 4)
  } finally { await f.close() }
})
test('SQLite：局部editor验证后交付正文与pipeline/强约束hash均一致', async () => {
  const original = `灯塔${unique(197)}。`
  const f = await fixture('edited-projection', { target: 200, strong: true, pipeline: true, edit: true, outputs: [original] })
  try {
    await f.engine.step(f.runId)
    assert.equal(f.repo.getRun(f.runId).status, 'completed', f.repo.getRun(f.runId).error_message)
    const accepted = f.repo.getManuscriptSegmentsByRun(f.runId).filter((row) => row.status === 'accepted').map((row) => row.content).join('')
    assert.notEqual(accepted, original); assert.ok(accepted.includes('晨雾'))
    assert.equal(JSON.parse(f.repo.getRunEvidence(f.runId, 'writing_pipeline_latest').json).candidateHash, hash(accepted))
    assert.equal(JSON.parse(f.repo.getRunEvidence(f.runId, 'strong_constraint_latest').json).latestSegmentHash, hash(accepted))
    assert.equal(f.calls(), 4)
  } finally { await f.close() }
})
test('SQLite：短新分片合并残句跨目标时，critic按最终候选执行全文必须保持检查', async () => {
  const first = `灯塔旁${unique(173)}`
  const second = `灯塔${unique(46, 200)}。`
  const f = await fixture('merged-target-check', { target: 220, strong: true, pipeline: true, mustKeep: '未出现术语', outputs: [first, second] })
  try {
    await f.engine.step(f.runId)
    assert.equal(f.repo.getRun(f.runId).status, 'waiting_user')
    assert.equal(f.repo.getRun(f.runId).error_code, 'writing_hard_boundary_requires_user')
    assert.ok(f.reviewedCandidates.some((candidate) => Array.from(candidate).length >= 220 && candidate.startsWith(first)))
    assert.equal(f.repo.getManuscriptSegmentsByRun(f.runId).filter((row) => row.status === 'accepted').length, 0)
    assert.equal(f.repo.getArtifactsByRun(f.runId).filter((row) => row.artifact_type === 'manuscript').length, 0)
    assert.equal(f.calls(), 4)
  } finally { await f.close() }
})
test('生产 adapter 在精确 envelope 超预算时 0 HTTP 请求且先拒绝再通知 observer', async () => {
  const f = await fixture('exact-deny', { prefix: unique(1200), budget: 1000 })
  try {
    await f.engine.step(f.runId)
    assert.equal(f.repo.getRun(f.runId).status, 'waiting_user')
    assert.equal(f.repo.getRun(f.runId).error_code, 'run_token_budget')
    assert.equal(f.calls(), 0); assert.equal(f.observer(), 0)
  } finally { await f.close() }
})
test('SQLite：残句拼接与自然句尾截取后重验强约束，证据绑定最终候选而非模型分片', async () => {
  const first = `灯塔旁${unique(173)}`
  const second = `灯塔${unique(46, 200)}。${unique(240, 500)}。`
  const f = await fixture('candidate-projection', { target: 220, strong: true, outputs: [first, second] })
  try {
    await f.engine.step(f.runId)
    assert.equal(f.repo.getRun(f.runId).status, 'completed', f.repo.getRun(f.runId).error_message)
    assert.equal(f.calls(), 2)
    const accepted = f.repo.getManuscriptSegmentsByRun(f.runId).filter((row) => row.status === 'accepted').map((row) => row.content).join('')
    assert.ok(accepted.startsWith(first)); assert.notEqual(accepted, second)
    const strong = JSON.parse(f.repo.getRunEvidence(f.runId, 'strong_constraint_latest').json)
    assert.equal(strong.latestSegmentHash, hash(accepted)); assert.equal(strong.draftHash, hash(accepted)); assert.equal(strong.status, 'passed')
    const artifact = f.repo.getArtifactsByRun(f.runId).find((row) => row.artifact_type === 'manuscript')
    assert.equal(hash(await fs.readFile(artifact.relative_path, 'utf8')), hash(accepted))
  } finally { await f.close() }
})
test('SQLite：场景切换生成当前候选证据，不借上一场景accepted记录', async () => {
  const f = await fixture('scene-transition-fresh', { target: 400, sceneSections: 2, outputs: [`点亮灯塔。${unique(194)}。`, `点亮灯塔。${unique(194, 300)}。`] })
  try {
    await f.engine.step(f.runId)
    assert.equal(f.repo.getRun(f.runId).status, 'completed', f.repo.getRun(f.runId).error_message)
    const accepted = f.repo.getManuscriptSegmentsByRun(f.runId).filter((row) => row.status === 'accepted')
    assert.equal(accepted.length, 2); assert.notEqual(accepted[0].scene_id, accepted[1].scene_id)
    const ready = JSON.parse(f.repo.getRunEvidence(f.runId, 'manuscript_acceptance_ready').json)
    assert.equal(ready.segmentId, accepted[1].segment_id); assert.ok(ready.evidenceRefs.scene_contract_latest)
    const candidate = JSON.parse(f.repo.getRunEvidence(f.runId, `scene_contract_segment:${accepted[1].segment_id}:candidate`).json)
    assert.equal(candidate.stage, 'candidate'); assert.equal(candidate.segmentId, accepted[1].segment_id); assert.equal(candidate.segmentHash, accepted[1].content_hash)
  } finally { await f.close() }
})
test('SQLite：适用场景缺少新latest证据不得接受/发布', async () => {
  const f = await fixture('scene-missing-fresh', { target: 200, sceneSections: 1, evidenceAttack: 'missing', outputs: [`点亮灯塔。${unique(194)}。`] })
  try {
    await assert.rejects(f.engine.step(f.runId), /manuscript_scene_evidence_missing/)
    assert.equal(f.repo.getRun(f.runId).status, 'failed'); assert.match(f.repo.getRun(f.runId).error_message, /manuscript_scene_evidence_missing/)
    assert.equal(f.repo.getManuscriptSegmentsByRun(f.runId).filter((row) => row.status === 'accepted').length, 0)
    assert.equal(f.repo.getArtifactsByRun(f.runId).filter((row) => row.artifact_type === 'manuscript').length, 0)
  } finally { await f.close() }
})
test('SQLite：第二场景被注入旧accepted证据时严格unbound，仅保留第一段不假交付', async () => {
  const f = await fixture('scene-old-evidence', { target: 400, sceneSections: 2, evidenceAttack: 'old', outputs: [`点亮灯塔。${unique(194)}。`, `点亮灯塔。${unique(194, 300)}。`] })
  try {
    await assert.rejects(f.engine.step(f.runId), /manuscript_acceptance_evidence_unbound/)
    assert.equal(f.repo.getRun(f.runId).status, 'failed'); assert.match(f.repo.getRun(f.runId).error_message, /manuscript_acceptance_evidence_unbound/)
    const accepted = f.repo.getManuscriptSegmentsByRun(f.runId).filter((row) => row.status === 'accepted')
    assert.equal(accepted.length, 1); assert.equal(accepted[0].char_count, 200)
    assert.equal(f.repo.getArtifactsByRun(f.runId).filter((row) => row.artifact_type === 'manuscript').length, 0)
  } finally { await f.close() }
})
