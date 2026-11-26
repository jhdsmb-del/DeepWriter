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
const hash = text => createHash('sha256').update(text).digest('hex')
let api
before(async () => {
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    export {BEAT_ACTIONS,sceneBeatActionForms,buildSceneContractPlan,evaluateSceneContract,buildSceneCompletionDecision} from './src/main/narrative/sceneContract';
    export {beatTermPresent,extractNarrativeStateDelta} from './src/main/narrative/stateExtractor';
    export {buildExecutionSnapshot} from './src/main/executionSnapshot';
    export {createRepository} from './src/main/db/repository';
    export {createRunStorePort,createModelCallAdapter} from './src/main/runKernelAdapter';
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {grillMeOutlineHash} from './src/shared/grillMe';
    export {publishCliManuscript} from './src/cli/manuscript';
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent', plugins: [{ name: 'exact-action-source', setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (!args.path.startsWith('.') && args.path !== 'electron') return { path: args.path, external: true }
      const target = args.path === 'electron' ? path.join(root, 'src/cli/host.ts') : path.resolve(args.resolveDir, args.path)
      const source = ['', '.ts', '.js', '/index.ts'].map(suffix => target + suffix).find(existsSync)
      if (!source || !source.startsWith(root + path.sep)) throw new Error('Source outside workspace')
      return { path: source, namespace: 'source' }
    })
    build.onLoad({ filter: /.*/, namespace: 'source' }, args => ({ contents: readFileSync(args.path, 'utf8')
      + (args.path.endsWith(path.join('narrative', 'sceneContract.ts')) ? '\nexport {BEAT_ACTIONS};' : '')
      + (args.path.endsWith(path.join('narrative', 'stateExtractor.ts')) ? '\nexport {beatTermPresent};' : ''), loader: 'ts', resolveDir: path.dirname(args.path) }))
  } }] })
  const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports); api = loaded.exports
})
function outlineFor(text, targetChars = Array.from(text).length) {
  return { title: '已确认行动', premise: text, targetChars, sections: [{ id: 's1', title: '现场', purpose: text, targetChars, beats: [text], sourceSlotIds: [] }] }
}
function contractFor(text) {
  const outline = outlineFor(text)
  return api.buildSceneContractPlan({ outline, outlineHash: api.grillMeOutlineHash(outline), outlineRevision: 1, answers: [], characterNames: ['林舟'], strongConstraints: { forbiddenTerms: [], mustKeep: [] } }).contracts[0]
}
function extractFor(contract, decision, text) {
  return api.extractNarrativeStateDelta({ runId: 'action-parity', sceneId: contract.sceneId, contract, decision, candidateSegmentId: 'segment', candidateContentHash: hash(text), acceptedSegments: [{ segmentId: 'segment', content: text, contentHash: hash(text), charCount: Array.from(text).length, chunkIndex: 1, revision: 1 }] })
}
test('every actual compiler action/form binds in state extraction; read-only forms and legacy-only actions remain supported', () => {
  let forms = 0
  for (const action of api.BEAT_ACTIONS) {
    const shared = api.sceneBeatActionForms(action.canonical)
    assert.deepEqual(shared, action.forms); assert.equal(Object.isFrozen(shared), true)
    for (const form of action.forms) { assert.equal(api.beatTermPresent('林舟' + form + '现场。', action.canonical), true, action.canonical + ':' + form); forms++ }
  }
  assert.ok(forms >= 100)
  assert.equal(api.beatTermPresent('林舟启程。', 'depart'), true)
  assert.equal(api.beatTermPresent('林舟照亮现场。', 'illuminate'), true)
  assert.equal(api.beatTermPresent('林舟停在门外。', 'arrive'), false)
  assert.deepEqual(api.sceneBeatActionForms('unknown-action'), [])
})
test('natural entered/revealed/started/decided prose compiles actual evidence and projects without canonical-label false negative', () => {
  for (const text of ['林舟进入档案室。', '林舟透露线索。', '林舟启动探照灯。', '林舟敲定方案。']) {
    const contract = contractFor(text)
    const evaluation = api.evaluateSceneContract(contract, text, { completed: true })
    const decision = api.buildSceneCompletionDecision(contract, text, { candidateSegmentId: 'segment', evaluation })
    assert.equal(decision.status, 'complete', text + ':' + JSON.stringify(evaluation))
    const result = extractFor(contract, decision, text)
    assert.equal(result.status, 'ready', text + ':' + JSON.stringify(result.report))
    assert.ok(result.delta.changes.some(change => change.kind === 'timeline_event'))
  }
})
test('shared action vocabulary never bypasses prefix, predicate span, actor or non-actual contract gates', () => {
  const text = '林舟进入档案室。', contract = contractFor(text)
  const evaluation = api.evaluateSceneContract(contract, text, { completed: true })
  const original = api.buildSceneCompletionDecision(contract, text, { candidateSegmentId: 'segment', evaluation })
  for (const variant of ['prefix', 'span', 'actor']) {
    const decision = structuredClone(original)
    if (variant === 'prefix') decision.beatEvidence[0].scenePrefixHash = '0'.repeat(64)
    if (variant === 'span') decision.beatEvidence[0].eventGroups[0].predicateSpan.start++
    if (variant === 'actor') decision.beatEvidence[0].actor = ['从未出现的角色']
    assert.equal(extractFor(contract, decision, text).status, 'pending_review', variant)
  }
  for (const nonActual of ['林舟没有进入档案室。', '林舟计划进入档案室。']) {
    const ev = api.evaluateSceneContract(contract, nonActual, { completed: true })
    const decision = api.buildSceneCompletionDecision(contract, nonActual, { candidateSegmentId: 'segment', evaluation: ev })
    assert.notEqual(decision.status, 'complete', nonActual)
  }
})
test('actual local SSE/AgentRunEngine/SQLite entered-scene reaches file/hash completion without review or new provider repair', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-action-parity-'))
  const repo = api.createRepository(path.join(dir, 'run.db')); repo.open()
  const prefix = '林舟进入档案室。'
  const output = prefix + Array.from({ length: 120 - Array.from(prefix).length - 1 }, (_, index) => String.fromCodePoint(0x12000 + index)).join('') + '。'
  let requests = 0
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk }); request.on('end', () => {
      assert.ok(JSON.parse(raw).messages.length); requests++
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\n'); response.end('data: [DONE]\n\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port, runId = 'action-parity', sessionId = 'action-parity-session'
  const outline = outlineFor(prefix, 120)
  const config = api.buildExecutionSnapshot({ payload: { id: runId, mode: 'longwrite', phase: 'execute', longMode: true, targetChars: 120, text: '围绕已确认行动写作。', strongConstraints: { enabled: false }, grillMe: { stateId: 'confirmed-grill', originalTask: '档案室故事', targetChars: 120, answers: [], assumptions: [], approvedOutline: outline, outlineRevision: 1, outlineHash: api.grillMeOutlineHash(outline) } }, settings: { model: 'synthetic', baseUrl, maxTokens: 4096, temperature: .7, topP: 1, thinkingEnabled: false, reasoningEffort: 'high', workDir: dir, docDir: dir, novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000, strongConstraintEnabled: false }, sessionId, memory: { projectPath: '', projectContent: '', userContent: '' } })
  config.providerCallBudget = { maxCalls: 8, maxTokens: 200000, maxCost: null, maxCostCny: null, maxWallClockMs: 15000 }; config.completionContract.providerCallBudget = config.providerCallBudget
  let engine
  const adapter = api.createModelCallAdapter({ getApi: () => ({ apiKey: '', baseUrl, model: 'synthetic', maxTokens: 4096, temperature: .7, topP: 1, thinking: { enabled: false, effort: 'high' }, supportsTools: false, protocol: 'deepseek-chat', adapterId: 'builtin.deepseek', chatPath: '/chat/completions', authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } }), getConfig: () => config, getSignal: id => engine.abortSignal(id), buildPrefix: async cfg => cfg.frozenSystemMessages })
  engine = api.createAgentRunEngine({ store: api.createRunStorePort(repo, path.join(dir, 'artifacts')), getConfig: () => config, modelCall: adapter, toolExecutor: async () => '', onEvent: () => {}, onRunUpdate: () => {}, publishLongwriteArtifact: api.publishCliManuscript })
  try {
    assert.equal((await engine.start({ runId, sessionId, config })).ok, true); await engine.step(runId)
    assert.equal(repo.getRun(runId).status, 'completed', repo.getRun(runId).error_message)
    assert.equal(await engine.getNarrativeReview(runId), null); assert.equal(requests, 1)
    assert.equal(repo.getSceneStates(runId)[0].lifecycle, 'committed')
    const artifact = repo.getArtifactsByRun(runId).find(row => row.artifact_type === 'manuscript')
    const text = await fs.readFile(artifact.relative_path, 'utf8'); assert.equal(text, output); assert.equal(hash(text), artifact.hash)
  } finally { repo.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(dir), os.tmpdir()); assert.match(path.basename(dir), /^dw-action-parity-/); await fs.rm(dir, { recursive: true, force: true }) }
})
