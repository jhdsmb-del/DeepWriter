const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const frozen = require('./fixtures/writing-opaque-scene.json')
const root = path.resolve(__dirname, '..')
const hash = text => createHash('sha256').update(text).digest('hex')
let api
before(async () => {
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    export * from './src/main/writingPipeline';
    export {buildSceneContractPlan,sceneContractValid,evaluateSceneContract,buildSceneCompletionDecision} from './src/main/narrative/sceneContract';
    export {buildExecutionSnapshot} from './src/main/executionSnapshot';
    export {createRepository} from './src/main/db/repository';
    export {createRunStorePort,createModelCallAdapter} from './src/main/runKernelAdapter';
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {grillMeOutlineHash,buildGrillMePlanningPrompt} from './src/shared/grillMe';
    export {previewGrillOutlineApplicability} from './src/main/grillOutlineApplicability';
    export {publishCliManuscript} from './src/cli/manuscript';
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent', plugins: [{ name: 'production-boundary-source', setup(build) {
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
test('critic prompt enumerates the actual strict parser contract and its natural-text example parses', () => {
  assert.ok(api.WRITING_CRITIC_ENUMS)
  assert.equal(Object.isFrozen(api.WRITING_CRITIC_ENUMS), true)
  for (const values of Object.values(api.WRITING_CRITIC_ENUMS)) {
    assert.equal(Object.isFrozen(values), true)
    for (const value of values) assert.ok(api.WRITING_CRITIC_PROMPT.includes('"' + value + '"'), value)
  }
  const exampleLine = api.WRITING_CRITIC_PROMPT.split('\n').find(line => line.startsWith('示例输入：'))
  const outputLine = api.WRITING_CRITIC_PROMPT.split('\n').find(line => line.startsWith('示例输出：'))
  const input = JSON.parse(exampleLine.slice('示例输入：'.length))
  assert.equal(input.candidateHash, hash(input.candidate))
  assert.equal(input.candidateCodePoints, Array.from(input.candidate).length)
  const wire = JSON.parse(outputLine.slice('示例输出：'.length))
  assert.equal(wire.anchorMode, 'exact_quote'); assert.equal(Object.hasOwn(wire.issues[0], 'startCp'), false); assert.equal(Object.hasOwn(wire.issues[0], 'endCp'), false)
  const report = api.parseCriticReport(outputLine.slice('示例输出：'.length), input.candidate, input.candidateHash)
  assert.equal(report.issues.length, 1); assert.equal(report.issues[0].basis, 'quality'); assert.equal(report.issues[0].severity, 'advisory')
})
test('critic enum diagnostics identify only field and index; hash, spans, quote and explicit hard gates remain strict', () => {
  const candidate = '灯塔仍然亮着。', candidateHash = hash(candidate)
  const issue = { issueId: 'q1', code: 'explicit_forbidden', basis: 'explicit', severity: 'hard', startCp: 0, endCp: 2, quote: '灯塔', reason: '命中用户禁项', repairIntent: '局部修改' }
  const report = (patch = {}) => JSON.stringify({ schemaVersion: 1, candidateHash, issues: [{ ...issue, ...patch }] })
  assert.equal(api.parseCriticReport(report(), candidate).issues[0].severity, 'hard')
  for (const field of ['code', 'basis', 'severity']) {
    const secret = 'synthetic-secret-' + field
    assert.throws(() => api.parseCriticReport(report({ [field]: secret }), candidate), error => error.message === 'critic_issue_' + field + '_invalid:1' && !error.message.includes(secret) && !error.message.includes(candidate))
  }
  assert.throws(() => api.parseCriticReport(report(), candidate, '0'.repeat(64)), /critic_schema_invalid/)
  assert.throws(() => api.parseCriticReport(report({ endCp: 200 }), candidate), /critic_issue_span_invalid/)
  assert.throws(() => api.parseCriticReport(report({ quote: '错字' }), candidate), /critic_issue_quote_mismatch/)
  assert.equal(api.parseCriticReport(report({ basis: 'quality' }), candidate).issues[0].severity, 'advisory')
})

test('one Markdown JSON envelope is presentation only; strict findings, identity, roots and surrounding prose stay unchanged', () => {
  const candidate = '灯塔仍然亮着。'
  const raw = JSON.stringify({ schemaVersion: 1, anchorMode: 'exact_quote', candidateHash: hash(candidate), issues: [] })
  for (const wrap of [body => '```json\n' + body + '\n```', body => '```\r\n' + body + '\r\n```']) {
    assert.equal(api.criticJsonPayload(wrap(raw)), raw)
    assert.deepEqual(api.parseCriticReport(api.criticJsonPayload(wrap(raw)), candidate).issues, [])
    assert.throws(() => api.parseCriticReport(api.criticJsonPayload(wrap(raw.replace(hash(candidate), '0'.repeat(64)))), candidate), /critic_schema_invalid/)
    assert.throws(() => api.parseCriticReport(api.criticJsonPayload(wrap(raw + '\n' + raw)), candidate))
  }
  for (const value of ['说明\n```json\n' + raw + '\n```', '```json\n' + raw + '\n```\n已完成', '```json\n' + raw + '\n```\n```json\n' + raw + '\n```']) {
    assert.equal(api.criticJsonPayload(value), value)
    assert.throws(() => api.parseCriticReport(api.criticJsonPayload(value), candidate))
  }
})
const literalIssue = { issueId: 'q1', code: 'emotion_explained', basis: 'quality', severity: 'advisory', quote: '唯一🧭锚点。', reason: '局部情绪解释', repairIntent: '保留其余原文' }
const literalReport = (candidate, issue = {}, envelope = {}) => JSON.stringify({ schemaVersion: 1, candidateHash: hash(candidate), issues: [{ ...literalIssue, ...issue }], ...envelope })
test('unique exact quote corrects only valid legacy numeric offsets and preserves model span diagnostics', () => {
  const candidate = '前😀\r\n唯一🧭锚点。\r\n后'
  const report = api.parseCriticReport(literalReport(candidate, { startCp: 1, endCp: 3 }), candidate)
  assert.deepEqual(report.issues[0], { ...literalIssue, startCp: 4, endCp: 10, modelReportedSpan: { startCp: 1, endCp: 3 } })
  assert.equal(Array.from(candidate).slice(report.issues[0].startCp, report.issues[0].endCp).join(''), literalIssue.quote)
  assert.equal(report.candidateHash, hash(candidate))
})
test('explicit quote-first protocol uses complete raw candidate code points, including emoji and CRLF', () => {
  const candidate = '前😀\r\n唯一🧭锚点。\r\n后'
  const report = api.parseCriticReport(literalReport(candidate, {}, { anchorMode: 'exact_quote' }), candidate)
  assert.deepEqual(report.issues[0], { ...literalIssue, startCp: 4, endCp: 10 })
  const quote = '😀\r\n唯一🧭'
  const rawNewline = api.parseCriticReport(literalReport(candidate, { quote }, { anchorMode: 'exact_quote' }), candidate)
  assert.equal(rawNewline.issues[0].startCp, 1); assert.equal(rawNewline.issues[0].endCp, 7)
  assert.throws(() => api.parseCriticReport(literalReport(candidate, { quote: quote.replace('\r\n', '\n') }, { anchorMode: 'exact_quote' }), candidate), /critic_issue_quote_mismatch/)
  assert.throws(() => api.parseCriticReport(literalReport(candidate, { quote: '\ud83d' }, { anchorMode: 'exact_quote' }), candidate), /critic_issue_quote_mismatch/)
  assert.throws(() => api.parseCriticReport(literalReport(candidate, { quote: '\ude00' }, { anchorMode: 'exact_quote' }), candidate), /critic_issue_quote_mismatch/)
})
test('correct legacy spans are unchanged and still disambiguate repeated exact quotes', () => {
  const candidate = '灯亮。灯亮。'
  const issue = { ...literalIssue, quote: '灯亮', startCp: 3, endCp: 5 }
  const report = api.parseCriticReport(literalReport(candidate, issue), candidate)
  assert.deepEqual(report.issues[0], issue)
  assert.equal(Object.hasOwn(report.issues[0], 'modelReportedSpan'), false)
  const forgedDiagnostic = api.parseCriticReport(literalReport(candidate, { ...issue, modelReportedSpan: { startCp: 1000, endCp: 2000 } }), candidate)
  assert.deepEqual(forgedDiagnostic.issues[0], issue)
})
test('ambiguous repeated and overlapping quotes cannot rescue a wrong span or a quote-first report', () => {
  const candidate = '灯亮。灯亮。'
  assert.throws(() => api.parseCriticReport(literalReport(candidate, { quote: '灯亮', startCp: 0, endCp: 1 }), candidate), /critic_issue_quote_ambiguous/)
  assert.throws(() => api.parseCriticReport(literalReport(candidate, { quote: '灯亮' }, { anchorMode: 'exact_quote' }), candidate), /critic_issue_quote_ambiguous/)
  assert.throws(() => api.parseCriticReport(literalReport('aaa', { quote: 'aa', startCp: 1, endCp: 2 }), 'aaa'), /critic_issue_quote_ambiguous/)
})
test('quote anchoring remains bound to the actual full candidate hash, not a caller-supplied stale hash', () => {
  const candidate = '前😀\r\n唯一🧭锚点。\r\n后'
  for (const candidateHash of [undefined, '', '0'.repeat(64), hash(candidate + '旧')]) {
    assert.throws(() => api.parseCriticReport(literalReport(candidate, {}, { anchorMode: 'exact_quote', candidateHash }), candidate), /critic_schema_invalid/)
  }
  const staleHash = hash(candidate)
  assert.throws(() => api.parseCriticReport(literalReport(candidate, { startCp: 4, endCp: 10 }), candidate + '新', staleHash), /critic_schema_invalid/)
  assert.throws(() => api.parseCriticReport(literalReport(candidate + '新', {}, { anchorMode: 'exact_quote', candidateHash: staleHash }), candidate + '新', staleHash), /critic_schema_invalid/)
})
test('malformed or out-of-bounds legacy spans remain invalid even with a unique exact quote', () => {
  const candidate = '前😀\r\n唯一🧭锚点。\r\n后'
  for (const span of [{}, { startCp: 0 }, { endCp: 1 }, { startCp: '0', endCp: 1 }, { startCp: 0.5, endCp: 1 }, { startCp: -1, endCp: 1 }, { startCp: 1, endCp: 1 }, { startCp: 2, endCp: 1 }, { startCp: 0, endCp: 1000 }, { startCp: null, endCp: 1 }]) {
    assert.throws(() => api.parseCriticReport(literalReport(candidate, span), candidate), /critic_issue_span_invalid/)
  }
  assert.throws(() => api.parseCriticReport(literalReport(candidate, { startCp: 4, endCp: 10 }, { anchorMode: 'exact_quote' }), candidate), /critic_issue_span_invalid/)
  assert.throws(() => api.parseCriticReport(literalReport(candidate, { startCp: 4, endCp: 10 }, { anchorMode: 'loose' }), candidate), /critic_schema_invalid/)
})
test('empty, fabricated and cross-candidate quotes never become a pass; unknown enums and framing stay strict', () => {
  const candidate = '前😀\r\n唯一🧭锚点。\r\n后'
  for (const quote of [undefined, null, '', 1, '另一个候选的原文', '唯一🧭锚点!']) {
    assert.throws(() => api.parseCriticReport(literalReport(candidate, { quote }, { anchorMode: 'exact_quote' }), candidate), /critic_issue_quote_mismatch/)
  }
  for (const field of ['code', 'basis', 'severity']) {
    assert.throws(() => api.parseCriticReport(literalReport(candidate, { [field]: 'unknown' }, { anchorMode: 'exact_quote' }), candidate), new RegExp('critic_issue_' + field + '_invalid:1'))
  }
  const valid = literalReport(candidate, {}, { anchorMode: 'exact_quote' })
  assert.throws(() => api.parseCriticReport('```json\n' + valid + '\n```', candidate), /quality_json_not_object/)
  assert.throws(() => api.parseCriticReport(valid + '\nPASS', candidate), /quality_json_not_object/)
})
test('new planning instructions separate observable actions from background without mutating approved outline or adding a schema', () => {
  const state = { originalTask: '灯塔场景', genre: '悬疑', kind: 'fiction', targetChars: 8000, slots: [], assumptions: [], outline: { title: frozen.title, sections: [{ beats: frozen.mustHappen }] } }
  const before = JSON.stringify(state)
  const prompt = api.buildGrillMePlanningPrompt(state)
  assert.ok(prompt.includes('每条 beat 聚焦一项主体明确、可观察的动作。'))
  assert.ok(prompt.includes('否定背景与静态状态单独描述'))
  assert.ok(prompt.includes('不要求僵硬句式'))
  assert.ok(prompt.includes('"beats":string[]'))
  assert.equal(JSON.stringify(state), before)
})
test('outline preview uses the same opaque predicate even when compound prose leaves incidental time or location hints', () => {
  const outline = { title: frozen.title, premise: frozen.objective, targetChars: 1200, sections: [{ id: frozen.sectionId, title: frozen.title, purpose: frozen.objective, targetChars: 1200, beats: [...frozen.mustHappen], sourceSlotIds: [] }] }
  const before = JSON.stringify(outline)
  const preview = api.previewGrillOutlineApplicability({ outlineRevision: 1, slots: [] }, outline)
  assert.equal(preview.outlineHash, api.grillMeOutlineHash(outline))
  assert.equal(preview.scenes.length, 1)
  const contract = api.buildSceneContractPlan({ outline, outlineRevision: 1, answers: [], characterNames: [] }).contracts[0]
  assert.deepEqual(contract.requiredBeatEvidence[0].action, ['open'])
  assert.equal(contract.requiredBeatEvidence[0].eventGroups.length, 1)
  assert.deepEqual(contract.requiredBeatEvidence.slice(1).map(beat => beat.beatId), frozen.requiredBeatIds.slice(1))
  assert.equal(preview.scenes[0].sceneId, contract.sceneId)
  assert.deepEqual(preview.scenes[0].beats, frozen.mustHappen.slice(1))
  assert.equal(JSON.stringify(outline), before)
})

test('the original frozen compound outline verbatim is unresolved, never self-contradicted or automatically completed', () => {
  assert.equal(api.sceneContractValid(frozen), true)
  const before = JSON.stringify(frozen), prose = frozen.mustHappen.join('\n')
  const evaluation = api.evaluateSceneContract(frozen, prose, { completed: true })
  assert.equal(evaluation.violations.some(v => v.code === 'beat_contradicted'), false)
  assert.deepEqual(evaluation.beatEvidence.map(e => e.status), ['missing', 'missing', 'missing'])
  assert.equal(api.buildSceneCompletionDecision(frozen, prose, { candidateSegmentId: 'original-quote', evaluation }).status, 'defer')
  assert.equal(JSON.stringify(frozen), before); assert.equal(evaluation.frozenHash, frozen.frozenHash)
})
// Exact bounded excerpts of the first rejected candidate; no synthetic claim
// that the unavailable sixth critic response was captured or reproduced.
const capturedProse = '她没有拔出钥匙，只是把身体往档案柜的方向偏了半步，像是无意间用肩膀挡住了锁孔。\n他把手电放在桌上，光柱斜斜地偏向墙角，正好照不到顾岚的脸。\n两人之间大约隔了一步的距离，谁也没有再往前走。'
test('actual first-candidate excerpts do not borrow whole-prose negation as an opaque event contradiction', () => {
  const before = JSON.stringify(frozen)
  const evaluation = api.evaluateSceneContract(frozen, capturedProse, { completed: true })
  assert.equal(evaluation.violations.some(v => v.code === 'beat_contradicted'), false)
  assert.ok(evaluation.violations.some(v => v.code === 'missing_required_beat'))
  assert.equal(api.buildSceneCompletionDecision(frozen, capturedProse, { candidateSegmentId: 'captured-quote', evaluation }).status, 'defer')
  assert.equal(JSON.stringify(frozen), before)
})
test('bound actual events still reject negation, planned substitution, wrong directional roles and explicit forbidden facts', () => {
  const text = '林舟把钥匙交给顾岚。'
  const outline = { title: '交接', premise: text, targetChars: 120, sections: [{ id: 's1', title: '交接', purpose: text, targetChars: 120, beats: [text], sourceSlotIds: [] }] }
  const contract = api.buildSceneContractPlan({ outline, answers: [], characterNames: ['林舟', '顾岚'], strongConstraints: { forbiddenTerms: ['毁掉附页'], mustKeep: [] } }).contracts[0]
  assert.ok(contract.requiredBeatEvidence[0].eventGroups.length > 0)
  for (const prose of ['林舟没有把钥匙交给顾岚。', '林舟计划把钥匙交给顾岚。']) {
    assert.ok(api.evaluateSceneContract(contract, prose).violations.some(v => v.code === 'beat_contradicted' && v.severity === 'blocking'), prose)
  }
  assert.notEqual(api.buildSceneCompletionDecision(contract, '顾岚把钥匙交给林舟。', { candidateSegmentId: 'wrong-roles' }).status, 'complete')
  assert.ok(api.evaluateSceneContract(contract, text + '毁掉附页。').violations.some(v => v.code === 'forbidden_fact' && v.severity === 'blocking'))
})
// This is an opaque scene: the simulated critic reports missing evidence for
// every requested part, rather than omitting the protocol or inventing proof.
function missingSceneEvidence(input) {
  const review = input.sceneBeatReview
  assert.equal(review.semanticVersion, 2)
  assert.ok(review.requiredBeats.length > 0)
  return {
    semanticVersion: review.semanticVersion,
    contractHash: review.contractHash,
    candidateHash: input.candidateHash,
    scenePrefixHash: review.scenePrefixHash,
    beats: review.requiredBeats.map(beat => ({
      beatId: beat.beatId,
      status: 'missing',
      partEvidence: beat.parts.map(part => ({ partId: part.partId, status: 'missing', spanIndexes: [] })),
      spans: [],
      semanticEvents: []
    }))
  }
}
async function withEngine(criticInvalid, body, outputOverride, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-critic-opaque-'))
  const repo = api.createRepository(path.join(dir, 'run.db')); repo.open()
  const runId = 'critic-opaque', sessionId = 'isolated-critic-opaque'
  const output = outputOverride ?? capturedProse + Array.from({ length: 1200 - Array.from(capturedProse).length - 1 }, (_, index) => String.fromCodePoint(0x12000 + index)).join('') + '。'
  const requests = []
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk }); request.on('end', () => {
      const wire = JSON.parse(raw); requests.push(wire)
      const critic = wire.messages.find(message => message.role === 'user' && message.content?.startsWith('{"candidateHash"'))
      let content = output
      if (critic) {
        const input = JSON.parse(critic.content)
        // Inspect the actual HTTP body, not a fixture that ignores prompts.
        if (typeof input.candidateCodePoints === 'number') {
          assert.ok(wire.messages.some(message => message.role === 'system' && message.content.includes('explicit_genre') && message.content.includes('cliche_language')))
          assert.equal(input.candidateCodePoints, Array.from(input.candidate).length)
          const result = typeof criticInvalid === 'function' ? criticInvalid(input) : {
            schemaVersion: 1, candidateHash: input.candidateHash,
            issues: criticInvalid ? [{ issueId: 'bad', code: 'synthetic-unknown-code', basis: 'quality', severity: 'advisory', startCp: 0, endCp: 1, quote: Array.from(input.candidate)[0] }] : [],
            ...(!criticInvalid ? { sceneBeatEvidence: missingSceneEvidence(input) } : {})
          }
          content = typeof result === 'string' ? result : JSON.stringify(result)
        } else content = '{not-json' // No unverified edit is silently applied by the fixture.
      }
      if (critic && options.httpStatus) { response.writeHead(options.httpStatus, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'synthetic permanent HTTP rejection' } })); return }
      const finish = critic && options.criticFinish ? options.criticFinish : 'stop'
      const delta = critic && options.toolCall ? { tool_calls: [{ index: 0, id: 'unexpected', type: 'function', function: { name: 'bad', arguments: '{}' } }] } : { content }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\n'); response.end('data: [DONE]\n\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const targetChars = options.targetChars ?? 1200, sceneTarget = options.sceneTarget ?? targetChars
  const sections = [{ id: 's1', title: frozen.title, purpose: frozen.objective, targetChars: sceneTarget, beats: frozen.mustHappen, sourceSlotIds: [] }]
  if (sceneTarget < targetChars) sections.push({ id: 's2', title: '后续独立场景', purpose: frozen.objective, targetChars: targetChars - sceneTarget, beats: frozen.mustHappen, sourceSlotIds: [] })
  const outline = { title: frozen.title, premise: '灯塔场景', targetChars, sections }
  const config = api.buildExecutionSnapshot({ payload: { id: runId, mode: 'longwrite', phase: 'execute', longMode: true, targetChars, text: '在灯塔写人物现场。', strongConstraints: { enabled: true, level: 'balanced', themeLockMode: 'guided', expressionFreedom: 'high', antiMoralizingEnabled: false, perspective: 'auto', genre: 'auto', mustKeep: '', avoid: '' }, grillMe: { stateId: 'frozen-grill', originalTask: '灯塔场景', targetChars, answers: [], assumptions: [], approvedOutline: outline, outlineRevision: 1, outlineHash: api.grillMeOutlineHash(outline) } }, settings: { model: 'synthetic', baseUrl, maxTokens: 4096, temperature: .7, topP: 1, thinkingEnabled: false, reasoningEffort: 'high', workDir: dir, docDir: dir, novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000, strongConstraintEnabled: true, themeLockMode: 'guided', expressionFreedom: 'high', antiMoralizingEnabled: false }, sessionId, memory: { projectPath: '', projectContent: '', userContent: '' } })
  assert.ok(config.writingPipeline, 'fixture uses the production writer/critic pipeline')
  config.providerCallBudget = { maxCalls: 9, maxTokens: 200000, maxCost: null, maxCostCny: null, maxWallClockMs: 15000, ...options.budget }; config.completionContract.providerCallBudget = config.providerCallBudget
  if (options.legacySnapshot) { delete config.workBudgetPolicy; config.maxTurns = 12 }
  let engine
  const adapter = api.createModelCallAdapter({ getApi: () => ({ apiKey: '', baseUrl, model: 'synthetic', maxTokens: 4096, temperature: .7, topP: 1, thinking: { enabled: false, effort: 'high' }, pricing: options.pricing ?? null, supportsTools: false, protocol: 'deepseek-chat', adapterId: 'builtin.deepseek', chatPath: '/chat/completions', authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } }), getConfig: () => config, getSignal: id => engine.abortSignal(id), buildPrefix: async rc => rc.frozenSystemMessages })
  const store = api.createRunStorePort(repo, path.join(dir, 'artifacts'))
  if (options.onEvidence) {
    const save = store.saveRunEvidence.bind(store)
    store.saveRunEvidence = async (id, kind, json) => {
      if (options.failEvidence && kind.startsWith('writing_pipeline_critic_')) throw new Error('synthetic_evidence_unavailable')
      await save(id, kind, json)
      await options.onEvidence({ id, kind, json, repo, store, config, engine })
    }
  }
  engine = api.createAgentRunEngine({ store, getConfig: () => config, modelCall: adapter, toolExecutor: async () => '', onEvent: () => {}, onRunUpdate: () => {}, publishLongwriteArtifact: api.publishCliManuscript })
  try {
    assert.equal((await engine.start({ runId, sessionId, config })).ok, true)
    try { await engine.step(runId) } catch { assert.equal(repo.getRun(runId).status, 'waiting_user') }
    await body({ repo, engine, runId, config, requests, output, store, adapter })
  } finally { repo.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(dir), os.tmpdir()); assert.match(path.basename(dir), /^dw-critic-opaque-/); await fs.rm(dir, { recursive: true, force: true }) }
}
function assertBoundedOpaqueRecovery(f, criticAttempts) {
  const sceneId = f.config.sceneContracts.contracts[0].sceneId
  const ledger = JSON.parse(f.repo.getRunEvidence(f.runId, 'scene_beat_repair:' + sceneId).json)
  assert.equal(ledger.maxAttempts, 2)
  assert.equal(ledger.attempts.length, 2)
  assert.equal(ledger.pending, null)
  assert.equal(f.requests.length, (1 + criticAttempts) * 3, 'initial writer/critic and two bounded rewrites; no separate editor calls')
  assert.match(f.repo.getRun(f.runId).error_message, /scene_beat_repair_exhausted:2/)
}
test('actual adapter/SSE/SQLite pauses an opaque scene after bounded rewrites, without invented evidence, acceptance or artifact', async () => withEngine(false, async f => {
  assert.equal(f.repo.getRun(f.runId).status, 'waiting_user')
  assert.equal(f.repo.getRun(f.runId).error_code, 'narrative_state_pending_review', f.repo.getRun(f.runId).error_message)
  assertBoundedOpaqueRecovery(f, 1)
  const packet = await f.engine.getNarrativeReview(f.runId)
  assert.ok(packet); assert.equal(packet.reason, 'scene_semantic_ambiguous'); assert.equal(packet.effectiveAllowedDecisions.accept_unknown.allowed, false)
  assert.ok(packet.reasons.some(reason => reason.code === 'missing_required_beat'))
  const segments = f.repo.getManuscriptSegmentsByRun(f.runId)
  assert.equal(segments.filter(s => s.status === 'accepted').length, 0)
  assert.equal(segments.find(s => s.segment_id === packet.candidateSegmentId).content, f.output)
  assert.equal(f.repo.getArtifactsByRun(f.runId).length, 0)
  const frozenBefore = JSON.parse(f.repo.getRun(f.runId).config_json).sceneContracts
  await f.engine.step(f.runId)
  assertBoundedOpaqueRecovery(f, 1); assert.deepEqual(JSON.parse(f.repo.getRun(f.runId).config_json).sceneContracts, frozenBefore)
}))
for (const legacySnapshot of [false, true]) {
  test((legacySnapshot ? 'legacy frozen' : 'uncapped default') + ' opaque scene retains bounded repair and its resumable semantic review, not a generic progress pause', async () => withEngine(false, async f => {
    assertBoundedOpaqueRecovery(f, 1)
    assert.equal(f.repo.getRun(f.runId).error_code, 'narrative_state_pending_review')
    assert.equal(f.repo.getRunEvidence(f.runId, 'rejected_writing_progress_v1'), null)
    const packet = await f.engine.getNarrativeReview(f.runId)
    assert.equal(packet.reason, 'scene_semantic_ambiguous')
    assert.equal(packet.effectiveAllowedDecisions.accept_unknown.allowed, false)
    const requestsBefore = f.requests.length
    await f.engine.step(f.runId)
    assert.equal(f.requests.length, requestsBefore)
    assert.equal(f.repo.getRun(f.runId).error_code, 'narrative_state_pending_review')
    assert.equal(f.repo.getManuscriptSegmentsByRun(f.runId).filter(s => s.status === 'accepted').length, 0)
  }, undefined, { legacySnapshot, ...(!legacySnapshot ? { budget: { maxCalls: null, maxTokens: null, maxWallClockMs: null } } : {}) }))
}

test('actual critic protocol invalidity still pauses with safe exact field error and intact unaccepted SQLite candidate', async () => withEngine(true, async f => {
  const run = f.repo.getRun(f.runId)
  assert.equal(run.error_code, 'writing_critic_invalid')
  assert.match(run.error_message, /critic_issue_code_invalid:1/)
  assert.equal(run.error_message.includes('synthetic-unknown-code'), false)
  assert.equal(f.requests.length, 2); assert.equal(await f.engine.getNarrativeReview(f.runId), null)
  const candidate = f.repo.getManuscriptSegmentsByRun(f.runId).find(s => s.status === 'candidate')
  assert.equal(candidate.content, f.output); assert.equal(candidate.content_hash, hash(f.output))
  assert.equal(f.repo.getManuscriptSegmentsByRun(f.runId).filter(s => s.status === 'accepted').length, 0)
  assert.equal(f.repo.getArtifactsByRun(f.runId).length, 0)
}))
test('a style-only critic reply cannot stand in for an explicit scene review', async () => withEngine(input => ({
  schemaVersion: 1, anchorMode: 'exact_quote', candidateHash: input.candidateHash, issues: []
}), async f => {
  const run = f.repo.getRun(f.runId)
  assert.equal(run.status, 'waiting_user')
  assert.equal(run.error_code, 'writing_critic_invalid')
  assert.equal(await f.engine.getNarrativeReview(f.runId), null)
  assert.equal(f.repo.getManuscriptSegmentsByRun(f.runId).find(s => s.status === 'candidate').content, f.output)
  checkNoAcceptance(f)
}))
const rawCandidatePrefix = '前😀\r\n' + capturedProse.replaceAll('\n', '\r\n')
const rawPipelineCandidate = rawCandidatePrefix + Array.from({ length: 1200 - Array.from(rawCandidatePrefix).length - 1 }, (_, index) => String.fromCodePoint(0x12000 + index)).join('') + '。'
for (const anchorMode of ['legacy-offset-drift', 'exact_quote']) {
  test('source adapter/SSE/SQLite canonicalizes ' + anchorMode + ' without bypassing opaque scene review or editor limits', async () => withEngine(input => ({
    schemaVersion: 1, candidateHash: input.candidateHash,
    ...(anchorMode === 'exact_quote' ? { anchorMode } : {}),
    sceneBeatEvidence: missingSceneEvidence(input),
    issues: [{ ...literalIssue, quote: input.candidate, ...(anchorMode === 'exact_quote' ? {} : { startCp: 0, endCp: 1 }) }]
  }), async f => {
    // The existing writer classifier canonicalizes CRLF before persistence/review.
    // The critic must anchor that complete canonical candidate, not raw SSE bytes.
    const canonicalCandidate = f.output.replaceAll('\r\n', '\n')
    assert.notEqual(canonicalCandidate, f.output)
    const criticInput = JSON.parse(f.requests[1].messages.find(message => message.role === 'user' && message.content?.startsWith('{"candidateHash"')).content)
    assert.equal(criticInput.candidate, canonicalCandidate); assert.equal(criticInput.candidateHash, hash(canonicalCandidate)); assert.equal(criticInput.candidateCodePoints, Array.from(canonicalCandidate).length)
    const run = f.repo.getRun(f.runId)
    assert.equal(run.status, 'waiting_user'); assert.equal(run.error_code, 'narrative_state_pending_review', run.error_message)
    assertBoundedOpaqueRecovery(f, 1)
    const evidence = JSON.parse(f.repo.getRunEvidence(f.runId, 'writing_pipeline_latest').json)
    assert.equal(evidence.stage, 'accepted'); assert.equal(evidence.candidateHash, hash(canonicalCandidate))
    assert.equal(evidence.autoEditSkippedReason, 'span_absolute_limit')
    assert.equal(evidence.issues[0].startCp, 0); assert.equal(evidence.issues[0].endCp, Array.from(canonicalCandidate).length); assert.equal(evidence.issues[0].quote, canonicalCandidate)
    assert.deepEqual(evidence.issues[0].modelReportedSpan, anchorMode === 'exact_quote' ? undefined : { startCp: 0, endCp: 1 })
    const packet = await f.engine.getNarrativeReview(f.runId)
    assert.ok(packet); assert.equal(packet.reason, 'scene_semantic_ambiguous'); assert.equal(packet.effectiveAllowedDecisions.accept_unknown.allowed, false)
    const segments = f.repo.getManuscriptSegmentsByRun(f.runId)
    assert.equal(segments.filter(s => s.status === 'accepted').length, 0); assert.equal(segments.find(s => s.status === 'candidate').content, canonicalCandidate); assert.equal(segments.find(s => s.status === 'candidate').content_hash, hash(canonicalCandidate))
    assert.equal(f.repo.getArtifactsByRun(f.runId).length, 0)
    const frozenBefore = JSON.parse(run.config_json).sceneContracts
    await f.engine.step(f.runId)
    assertBoundedOpaqueRecovery(f, 1); assert.deepEqual(JSON.parse(f.repo.getRun(f.runId).config_json).sceneContracts, frozenBefore)
  }, rawPipelineCandidate))
}

const repairWire = input => ({ schemaVersion: 1, anchorMode: 'exact_quote', candidateHash: input.candidateHash,
  ...(input.sceneBeatReview ? { sceneBeatEvidence: missingSceneEvidence(input) } : {}), issues: [
  { issueId: 'q1', code: 'pov_conflict', basis: 'inferred', severity: 'advisory', quote: input.candidate, reason: '保留原视角意见，不能用空 issues 隐藏。', repairIntent: '只审校原候选。' },
  { issueId: 'q2', code: 'cliche_language', basis: 'quality', severity: 'advisory', quote: capturedProse.split('\n')[0], reason: '具体局部意见。', repairIntent: '保留动作事实。' }
] })
const correctedWire = input => {
  const report = JSON.parse(input.formatCorrection.invalidReport)
  report.issues[0].code = 'explicit_perspective' // A fake provider response, not a production alias.
  return report
}
const checkNoAcceptance = f => {
  assert.equal(f.repo.getManuscriptSegmentsByRun(f.runId).filter(s => s.status === 'accepted').length, 0)
  assert.equal(f.repo.getArtifactsByRun(f.runId).length, 0)
}
const attemptEvidence = (f, attempts) => {
  const latest = JSON.parse(f.repo.getRunEvidence(f.runId, 'writing_pipeline_latest').json)
  return JSON.parse(f.repo.getRunEvidence(f.runId, `writing_pipeline_critic_${latest.turnId}_${latest.criticCandidateHash}_${attempts}`).json)
}

test('format correction never aliases the original, loses a finding or changes verified payload fields', () => {
  const candidate = capturedProse, candidateHash = hash(candidate), original = JSON.stringify(repairWire({ candidate, candidateHash }))
  assert.throws(() => api.parseCriticReport(original, candidate), /critic_issue_code_invalid:1/)
  const repair = api.prepareCriticFormatRepair(original, 'critic_issue_code_invalid:1', candidate, candidateHash)
  assert.ok(repair); assert.equal(repair.raw, original)
  const corrected = correctedWire({ formatCorrection: { invalidReport: original } })
  assert.equal(api.parseCorrectedCriticReport(JSON.stringify(corrected), candidate, repair).issues.length, 2)
  for (const mutate of [x => { x.issues = [] }, x => x.issues.pop(), x => { x.issues[0].quote = '没有这段原文' }, x => { x.issues[0].issueId = 'changed' }, x => { x.issues[0].basis = 'explicit' }, x => { x.issues[0].severity = 'hard' }, x => { x.issues[0].reason = 'changed' }, x => { x.issues[0].repairIntent = 'changed' }, x => { x.issues[1].code = 'emotion_explained' }, x => { x.candidateHash = '0'.repeat(64) }]) {
    const next = structuredClone(corrected); mutate(next)
    assert.throws(() => api.parseCorrectedCriticReport(JSON.stringify(next), candidate, repair))
  }
  for (const mutate of [x => { x.candidateHash = '0'.repeat(64) }, x => { x.issues[0].quote = '' }, x => { x.issues[0].issueId = x.issues[1].issueId }, x => { x.issues[0].basis = 'unknown' }, x => { x.issues[0].severity = 'unknown' }, x => { x.issues[0].startCp = 0 }]) {
    const next = JSON.parse(original); mutate(next)
    assert.equal(api.prepareCriticFormatRepair(JSON.stringify(next), 'critic_issue_code_invalid:1', candidate, candidateHash), null)
  }
  assert.equal(api.prepareCriticFormatRepair('{bad-json', 'critic_issue_code_invalid:1', candidate, candidateHash), null)
  assert.equal(api.prepareCriticFormatRepair(original, 'critic_finish_length', candidate, candidateHash), null)
  const repeated = '灯亮。灯亮。', wire = { ...JSON.parse(original), candidateHash: hash(repeated), issues: [{ ...repair.issues[0], quote: '灯亮' }] }
  assert.equal(api.prepareCriticFormatRepair(JSON.stringify(wire), 'critic_issue_code_invalid:1', repeated, hash(repeated)), null)
})

test('real adapter SSE corrects one complete unknown-code report within two critic calls, but opaque scene remains unaccepted', async () => withEngine(input => input.formatCorrection ? correctedWire(input) : repairWire(input), async f => {
  assertBoundedOpaqueRecovery(f, 2)
  assert.equal(f.repo.getRun(f.runId).error_code, 'narrative_state_pending_review')
  const latest = JSON.parse(f.repo.getRunEvidence(f.runId, 'writing_pipeline_latest').json)
  assert.equal(latest.criticCallAttempts, 2); assert.equal(latest.stage, 'accepted'); assert.equal(latest.issues.length, 2)
  const first = attemptEvidence(f, 1), second = attemptEvidence(f, 2)
  assert.equal(first.error, 'critic_issue_code_invalid:1'); assert.equal(first.rawHash, hash(first.raw)); assert.equal(second.error, null); assert.equal(second.rawHash, hash(second.raw))
  assert.throws(() => api.parseCriticReport(first.raw, f.output), /critic_issue_code_invalid:1/)
  assert.equal(JSON.parse(second.raw).issues[0].quote, JSON.parse(first.raw).issues[0].quote)
  assert.ok(f.requests[2].messages.some(m => m.content.includes('这是一次格式纠正，不是重新审校')))
  const budget = JSON.parse(f.repo.getRunEvidence(f.runId, 'run_provider_budget_v1').json)
  assert.equal(budget.totalCalls, 9); assert.equal(budget.callsByActor.critic, 6)
  const packet = await f.engine.getNarrativeReview(f.runId)
  assert.equal(packet.effectiveAllowedDecisions.accept_unknown.allowed, false)
  checkNoAcceptance(f)
}))

test('longwrite critic binds the durable segment, not a divergent raw source projection', async () => withEngine(input => input.formatCorrection ? correctedWire(input) : repairWire(input), async f => {
  assertBoundedOpaqueRecovery(f, 2); assert.equal(f.repo.getRun(f.runId).error_code, 'narrative_state_pending_review')
  const latest = JSON.parse(f.repo.getRunEvidence(f.runId, 'writing_pipeline_latest').json)
  const turn = (await f.store.getTurns(f.runId)).find(t => t.turnId === latest.turnId)
  assert.notEqual(hash(turn.content), latest.criticCandidateHash)
  const segment = f.repo.getManuscriptSegmentsByRun(f.runId).find(s => s.segment_id === latest.criticSegmentId)
  assert.equal(segment.content_hash, latest.criticCandidateHash); assert.equal(segment.content, f.output)
  checkNoAcceptance(f)
}, undefined, { onEvidence: async f => {
  if (!f.kind.startsWith('writing_pipeline_critic_')) return
  const saved = JSON.parse(f.json)
  if (saved.criticCallAttempts !== 1) return
  const turn = (await f.store.getTurns(f.id)).find(t => t.turnId === saved.turnId)
  await f.store.appendTurn({ ...turn, content: turn.content + '未纳入当前候选的原始尾部。' })
} }))

for (const mode of ['still-unknown', 'empty', 'drop-q1', 'change-quote', 'change-valid-code', 'upgrade-basis', 'upgrade-severity', 'change-reason', 'stale-hash', 'policy-filtered']) {
  test('real adapter refuses unsafe second report: ' + mode, async () => withEngine(input => {
    if (!input.formatCorrection) return repairWire(input)
    const next = mode === 'still-unknown' ? JSON.parse(input.formatCorrection.invalidReport) : correctedWire(input)
    if (mode === 'empty') next.issues = []
    if (mode === 'drop-q1') next.issues.shift()
    if (mode === 'change-quote') next.issues[0].quote = capturedProse.split('\n')[1]
    if (mode === 'change-valid-code') next.issues[1].code = 'emotion_explained'
    if (mode === 'upgrade-basis') next.issues[0].basis = 'explicit'
    if (mode === 'upgrade-severity') next.issues[0].severity = 'hard'
    if (mode === 'change-reason') next.issues[0].reason = '已忽略原意见'
    if (mode === 'stale-hash') next.candidateHash = '0'.repeat(64)
    if (mode === 'policy-filtered') next.issues[0].code = 'preachy_template'
    return next
  }, async f => {
    assert.equal(f.requests.length, 3); assert.equal(f.repo.getRun(f.runId).error_code, 'writing_critic_invalid')
    const latest = JSON.parse(f.repo.getRunEvidence(f.runId, 'writing_pipeline_latest').json)
    assert.equal(latest.stage, 'paused'); assert.equal(latest.criticCallAttempts, 2)
    assert.ok(attemptEvidence(f, 1).error); assert.ok(attemptEvidence(f, 2).error)
    checkNoAcceptance(f)
    // The real SQLite-backed recovery cannot turn a paused allowance into zero.
    f.repo.updateRun(f.runId, { status: 'recoverable', phase: 'paused' })
    let calls = 0
    const restored = api.createAgentRunEngine({ store: f.store, getConfig: () => f.config, modelCall: async () => { calls++; throw new Error('exhausted critic must not replay') }, toolExecutor: async () => '', onEvent: () => {}, onRunUpdate: () => {}, publishLongwriteArtifact: api.publishCliManuscript })
    await restored.restore(f.runId); await restored.step(f.runId)
    assert.equal(calls, 0); assert.equal(f.repo.getRun(f.runId).error_code, 'writing_critic_retry_exhausted')
  }))
}

for (const mode of ['call-cap', 'token-cap', 'cost-cap', 'wall-expired', 'cancelled', 'policy-changed', 'policy-mutated-valid', 'candidate-changed', 'evidence-unavailable', 'nonstop', 'toolcall', 'http-error']) {
  test('format correction sends no extra HTTP request when ' + mode, async t => {
    let clockNow = 1700000000000
    if (mode === 'wall-expired') t.mock.method(Date, 'now', () => clockNow)
    const pricing = { id: 'synthetic-local-price', unit: 'per_1m_tokens', currency: 'CNY', inputMissPerMillion: 1, cacheHitPerMillion: 1, outputPerMillion: 1, reasoningPerMillion: null, reasoningBillingRule: 'included' }
    return withEngine(repairWire, async f => {
    if (mode === 'candidate-changed') {
      const latest = JSON.parse(f.repo.getRunEvidence(f.runId, 'writing_pipeline_latest').json)
      const durable = f.repo.getManuscriptSegmentsByRun(f.runId).find(s => s.segment_id === latest.criticSegmentId)
      assert.equal(durable.content_hash, hash(durable.content))
      assert.notEqual(durable.content_hash, latest.criticCandidateHash)
      console.log('CANDIDATE_GUARD_OBSERVATION requests=' + f.requests.length + ' durableHash=' + durable.content_hash + ' criticBindingHash=' + latest.criticCandidateHash)
    }
    assert.equal(f.requests.length, 2); checkNoAcceptance(f)
    if (mode !== 'cancelled') {
      const budgetCode = { 'call-cap': 'run_provider_call_cap', 'token-cap': 'run_token_budget', 'cost-cap': 'run_cost_budget', 'wall-expired': 'run_wall_clock_budget' }[mode]
      assert.equal(f.repo.getRun(f.runId).error_code, budgetCode ?? 'writing_critic_invalid')
    }
  }, undefined, {
    ...(mode === 'call-cap' ? { budget: { maxCalls: 2 } } : {}),
    ...(mode === 'wall-expired' ? { budget: { maxWallClockMs: 800 } } : {}),
    ...(mode === 'cost-cap' ? { pricing, budget: { maxCost: { amount: 1, currency: 'CNY', unknownPolicy: 'deny' } } } : {}),
    ...(mode === 'nonstop' ? { criticFinish: 'length' } : {}),
    ...(mode === 'toolcall' ? { toolCall: true } : {}),
    ...(mode === 'http-error' ? { httpStatus: 400 } : {}),
    failEvidence: mode === 'evidence-unavailable',
    onEvidence: async f => {
      if (!f.kind.startsWith('writing_pipeline_critic_') || !f.json.includes('critic_issue_code_invalid')) return
      if (mode === 'wall-expired') {
        // Keep actual HTTP latency out of the prerequisite. Expire the
        // engine clock exactly after its first critic evidence is durable.
        const budget = JSON.parse(f.repo.getRunEvidence(f.id, 'run_provider_budget_v1').json)
        assert.equal(clockNow, budget.startedAt)
        assert.equal(budget.limits.maxWallClockMs, 800)
        clockNow = budget.startedAt + budget.limits.maxWallClockMs
      }
      if (mode === 'token-cap') await f.store.appendUsage({ runId: f.id, callType: 'synthetic-budget-fixture', model: 'synthetic', inputTokens: 200000, outputTokens: 0, cacheHit: 0, cacheMiss: 200000, createdAt: 1700000000000 })
      if (mode === 'cost-cap') pricing.outputPerMillion = 1000000
      if (mode === 'cancelled') { f.config.cancelFallbackMs = 1; await f.engine.cancel(f.id) }
      if (mode === 'policy-changed') f.config.writingPipeline = { ...f.config.writingPipeline, hash: '0'.repeat(64) }
      if (mode === 'policy-mutated-valid') {
        f.config.writingPipeline.expressionFreedom = 'controlled'
        const { hash: priorHash, ...changed } = f.config.writingPipeline
        f.config.writingPipeline.hash = hash(JSON.stringify(changed))
        assert.equal(api.writingPipelinePolicyValid(f.config.writingPipeline), true)
      }
      if (mode === 'candidate-changed') {
        const prior = (await f.store.getManuscriptSegments(f.id)).find(s => s.status === 'candidate')
        const before = f.repo.getManuscriptSegmentsByRun(f.id).find(s => s.segment_id === prior.segmentId)
        assert.equal(before.content_hash, hash(prior.content))
        await f.store.saveManuscriptSegment({ ...prior, content: prior.content + '新', contentHash: hash(prior.content + '新'), charCount: prior.charCount + 1 })
        const after = f.repo.getManuscriptSegmentsByRun(f.id).find(s => s.segment_id === prior.segmentId)
        assert.equal(after.content, before.content + '新'); assert.equal(after.content_hash, hash(after.content))
        assert.notEqual(after.content_hash, before.content_hash)
        assert.equal(after.revision, before.revision); assert.equal(after.source_turn_id, before.source_turn_id)
        console.log('CANDIDATE_DURABLE_CHANGE beforeHash=' + before.content_hash + ' afterHash=' + after.content_hash + ' revision=' + after.revision + ' sourceTurnId=' + after.source_turn_id)
      }
    }
  }) })
}

// Explicit private replay is optional for ordinary CI; mandatory synthetic/source
// regressions above have no paid-artifact precondition. Neither path calls a paid host.
if (process.env.DW_CRITIC_CAPTURE_REPLAY === 'r5') {
  test('original R5 writer24/critic25 raw replay: strict old red, bounded format correction, no literary or scene acceptance', async () => {
    const decode = async attempt => {
      const capture = JSON.parse(await fs.readFile(path.join(root, 'out/commercial-quality/actual-cli-quality-20261003-r5/response-evidence/attempt-' + String(attempt).padStart(6, '0') + '.json'), 'utf8'))
      assert.equal(capture.completed, true); assert.equal(capture.truncated, false); assert.equal(capture.redacted, false)
      const bytes = Buffer.from(capture.payloadBase64, 'base64')
      assert.equal(bytes.length, capture.capturedSseBytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), capture.capturedSha256)
      let content = '', finish
      for (const line of bytes.toString('utf8').split(/\r?\n/u)) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
        const event = JSON.parse(line.slice(6)), choice = event.choices?.[0]
        content += choice?.delta?.content ?? ''; if (choice?.finish_reason) finish = choice.finish_reason
      }
      assert.equal(finish, 'stop'); return content
    }
    const candidate = await decode(24), invalid = await decode(25), original = JSON.parse(invalid)
    assert.equal(hash(candidate), '325ed9a3df3455e64ddce7a30c7495120254a6d17dfa7576b85bb59e67307e08')
    assert.throws(() => api.parseCriticReport(invalid, candidate), /critic_issue_code_invalid:1/)
    const repair = api.prepareCriticFormatRepair(invalid, 'critic_issue_code_invalid:1', candidate, hash(candidate))
    assert.ok(repair); assert.equal(repair.issues.length, 3)
    await withEngine(input => input.formatCorrection ? correctedWire(input) : invalid, async f => {
      assert.equal(f.requests.length, 4, 'writer, invalid critic, format correction, bounded editor rejection')
      const first = attemptEvidence(f, 1), second = attemptEvidence(f, 2)
      assert.equal(first.raw, invalid); assert.equal(first.candidateHash, original.candidateHash)
      const corrected = api.parseCorrectedCriticReport(second.raw, candidate, repair)
      assert.equal(corrected.issues.length, 3); assert.equal(corrected.issues[0].quote, original.issues[0].quote)
      assert.equal(f.repo.getRun(f.runId).error_code, 'narrative_state_pending_review')
      checkNoAcceptance(f)
      console.log('R5_RAW_REPLAY writerHash=' + hash(candidate) + ' criticRawHash=' + hash(invalid) + ' criticCalls=2 originalIssues=3 preservedIssues=3 accepted=0 artifacts=0')
      assert.equal(f.config.deepWrite.targetChars, 8000)
      assert.deepEqual(f.config.sceneContracts.contracts[0].targetChars, { min: 1360, ideal: 1600, max: 1840 })
    }, candidate, { targetChars: 8000, sceneTarget: 1600, budget: { maxCalls: 41 } })
  })
}
