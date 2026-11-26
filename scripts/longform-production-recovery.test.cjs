const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const specimen = require('./fixtures/scene-predicate-local-r3.json')
const root = path.resolve(__dirname, '..')
const hash = text => createHash('sha256').update(text).digest('hex')
let api
before(async () => {
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    export {criticJsonPayload} from './src/main/writingPipeline';
    export {buildExecutionSnapshot} from './src/main/executionSnapshot';
    export {createRepository} from './src/main/db/repository';
    export {createRunStorePort,createModelCallAdapter} from './src/main/runKernelAdapter';
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {grillMeOutlineHash} from './src/shared/grillMe';
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

// This is a deterministic transport/state proof, not a literary-quality eval.
// Reuse the repository's ordinary prose specimen as mock scene background.
const actions = [
  ['掸落', '袖口灰尘'], ['理顺', '围巾流苏'], ['抹净', '窗沿水迹'], ['拢齐', '桌边纸页'], ['掩严', '值班室门缝']
]
function sceneProse(index, includeAction = true) {
  const paragraphs = specimen.candidate.split('\n\n')
  const ordered = [...paragraphs.slice(index * 3), ...paragraphs.slice(0, index * 3)]
  const opening = includeAction ? `随后林舟${actions[index].join('')}。` : '灯罩下的灰影停在椅背上。'
  const result = [opening]
  for (const paragraph of ordered) {
    result.push(paragraph)
    if (Array.from(result.join('\n\n')).length >= 1640) break
  }
  assert(Array.from(result.join('\n\n')).length >= 1640)
  return result.join('\n\n')
}
function sceneEvidence(body, invalidPatient = false) {
  const review = body.sceneBeatReview
  if (!review) return undefined // Final natural-ending continuation after all scene commits.
  assert.equal(review.semanticVersion, 2)
  assert.equal(body.candidateHash, hash(body.candidate))
  assert.equal(review.scenePrefixHash, hash(review.scenePrefix))
  return { semanticVersion: 2, contractHash: review.contractHash, candidateHash: body.candidateHash,
    scenePrefixHash: review.scenePrefixHash, beats: review.requiredBeats.map(beat => {
      const index = actions.findIndex(pair => beat.requiredSource === `林舟${pair.join('')}。`)
      assert(index >= 0)
      const quote = `随后林舟${actions[index].join('')}。`, satisfied = body.candidate.includes(quote)
      return { beatId: beat.beatId, status: satisfied ? 'satisfied' : 'missing',
        partEvidence: beat.parts.map(part => ({ partId: part.partId, status: satisfied ? 'satisfied' : 'missing', spanIndexes: satisfied ? [0] : [] })),
        ...(satisfied ? { spans: [{ text: quote, source: 'candidate' }], semanticEvents: [{ spanIndex: 0,
          partIds: beat.parts.map(part => part.partId), predicate: actions[index][0], agent: ['林舟'],
          agentBindings: [{ name: '林舟', relation: 'explicit', mention: { spanIndex: 0, text: '林舟' } }],
          patient: [invalidPatient ? '原文不存在的物品' : actions[index][1]],
          actuality: 'asserted_actual', assertion: 'asserted', negation: false }] } : {}) }
    }) }
}

test('8000-character production adapter/SSE/SQLite run repairs one critic packet and one missing beat, advances all five scenes and exports only accepted prose', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-longform-recovery-'))
  const workDir = path.join(dir, 'work'), docDir = path.join(dir, 'documents')
  await Promise.all([fs.mkdir(workDir), fs.mkdir(docDir)])
  const repo = api.createRepository(path.join(dir, 'run.db')); repo.open()
  const store = api.createRunStorePort(repo, path.join(dir, 'artifacts'))
  const runId = 'longform-production-recovery', sessionId = runId + '-session'
  const requests = [], writerScopes = [], outputs = [], events = []
  let critics = 0, config, engine, serverError
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      try {
        assert(['', 'Bearer'].includes(request.headers.authorization ?? ''), 'loopback fixture has no key')
        const wire = JSON.parse(raw), user = wire.messages.find(message => message.role === 'user' && message.content?.startsWith('{"candidateHash"'))
        requests.push(user ? 'critic' : 'writer')
        let text
        if (user) {
          const body = JSON.parse(user.content)
          critics++
          const correction = body.formatCorrection
          if (correction) {
            assert.equal(critics, 2, 'only the first malformed scene packet needs correction')
            assert(correction.semanticErrors.some(issue => issue.reason === 'role_unanchored'))
            const frozenReport = JSON.parse(api.criticJsonPayload(correction.invalidReport))
            assert.equal(frozenReport.issues.length, 1, 'first-call style advisory remains frozen')
          }
          text = '```json\n' + JSON.stringify({ schemaVersion: 1, anchorMode: 'exact_quote', candidateHash: body.candidateHash,
            issues: critics === 1 ? [{ issueId: 'q1', code: 'cliche_language', severity: 'advisory', basis: 'quality',
              quote: body.candidate, reason: 'synthetic full-span advisory', repairIntent: 'do not broadly rewrite this fixture' }] : [],
            sceneBeatEvidence: sceneEvidence(body, critics === 1) }) + '\n```'
        } else {
          const scope = wire.messages.filter(message => message.role === 'user').at(-1).content.match(/本轮只写 (scene:s\d+)/u)?.[1]
          if (!scope) {
            assert(repo.getSceneStates(runId).every(state => state.lifecycle === 'committed'), 'unscoped continuation only follows every real scene commit')
            const firstClosure = !writerScopes.includes('natural-ending')
            if (firstClosure) assert(wire.messages.some(message => message.content.startsWith('## 待补全残句')))
            writerScopes.push('natural-ending')
            text = firstClosure ? '潮气，衣料贴在手肘，像刚从井底提上来。林舟又把袖口折了一次。' : '台灯响了一声。林舟停下脚步，听见铁阶在墙后吱呀了一声。'
          } else {
            const index = config.sceneContracts.contracts.findIndex(contract => contract.sceneId === scope)
            assert(index >= 0)
            const states = repo.getSceneStates(runId)
            assert(states.filter(state => state.order < index + 1).every(state => state.lifecycle === 'committed'), 'later scenes start only after earlier real commits')
            const repair = wire.messages.some(message => message.content.startsWith('[SceneContract 缺失推进点定向修订]'))
            writerScopes.push(scope)
            if (index === 1 && !repair) {
              assert.equal(repo.getManuscriptSegmentsByRun(runId).filter(row => row.status === 'accepted').length, 1)
              text = sceneProse(index, false)
            } else {
              if (index === 1) {
                assert.equal(repo.getManuscriptSegmentsByRun(runId).filter(row => row.status === 'accepted').length, 1, 'missing candidate must never become a continuation prefix')
                assert(repo.getManuscriptSegmentsByRun(runId).some(row => row.status === 'rejected'))
              }
              text = sceneProse(index)
            }
          }
          outputs.push(text)
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        // Exercise stream assembly as well as the native provider boundary.
        const split = Math.floor(text.length / 2)
        for (const delta of [text.slice(0, split), text.slice(split)]) response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: delta }, finish_reason: null }] }) + '\n\n')
        response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }) + '\n\ndata: [DONE]\n\n')
      } catch (error) { serverError = error; response.writeHead(500); response.end('synthetic fixture failed') }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const outline = { title: '灯塔五场', premise: '林舟在海边灯塔守夜。', targetChars: 8000,
    sections: actions.map((pair, index) => ({ id: 's' + (index + 1), title: '守夜第' + (index + 1) + '场',
      purpose: '用现场行动推进守夜。', targetChars: 1600, beats: [`林舟${pair.join('')}。`], sourceSlotIds: [] })) }
  config = api.buildExecutionSnapshot({ payload: { id: runId, mode: 'longwrite', phase: 'execute', longMode: true, targetChars: 8000,
    text: '按确认的五场大纲写完8000字灯塔小说，不要停在第一场。',
    strongConstraints: { enabled: true, level: 'balanced', themeLockMode: 'off', expressionFreedom: 'high', antiMoralizingEnabled: true, perspective: 'auto', genre: '小说' },
    grillMe: { stateId: runId + '-grill', originalTask: '写灯塔守夜小说。', targetChars: 8000, answers: [], assumptions: [], approvedOutline: outline,
      outlineRevision: 1, outlineHash: api.grillMeOutlineHash(outline) } }, sessionId,
    settings: { model: 'synthetic-longform', baseUrl, maxTokens: 4096, temperature: .7, topP: 1,
      thinkingEnabled: false, reasoningEffort: 'high', workDir, docDir, novelMode: false,
      galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000,
      completionTokenBudget: 1000000, completionWallClockMs: 60000, strongConstraintEnabled: true,
      themeLockMode: 'off', expressionFreedom: 'high', antiMoralizingEnabled: true },
    memory: { projectPath: '', projectContent: '', userContent: '' } })
  config.providerCallBudget = { maxCalls: 20, maxTokens: 1000000, maxCost: null, maxCostCny: null, maxWallClockMs: 60000 }
  config.completionContract.providerCallBudget = config.providerCallBudget
  const adapter = api.createModelCallAdapter({ getConfig: () => config, getSignal: id => engine.abortSignal(id), buildPrefix: async rc => rc.frozenSystemMessages,
    getApi: () => ({ apiKey: '', baseUrl, model: 'synthetic-longform', maxTokens: 4096, temperature: .7, topP: 1,
      thinking: { enabled: false, effort: 'high' }, pricing: null, supportsTools: false, protocol: 'deepseek-chat', adapterId: 'builtin.deepseek',
      chatPath: '/chat/completions', authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } }) })
  engine = api.createAgentRunEngine({ store, getConfig: () => config, modelCall: adapter, toolExecutor: async () => '',
    publishLongwriteArtifact: api.publishCliManuscript, onEvent: (_id, event) => events.push(event), onRunUpdate: () => {} })
  try {
    assert.equal((await engine.start({ runId, sessionId, config })).ok, true)
    await store.appendTurn({ turnId: runId + '-user', runId, turnSeq: 1, role: 'user', content: '按已确认的五场写完8000字灯塔小说。', createdAt: Date.now() })
    await engine.step(runId)
    if (serverError) throw serverError
    const run = repo.getRun(runId)
    assert.equal(run.status, 'completed', JSON.stringify({ code: run.error_code, message: run.error_message, requests, writerScopes, phases: events.filter(event => event.type === 'phase').slice(-8) }))
    assert.deepEqual(writerScopes.slice(0, 6), ['scene:s1', 'scene:s2', 'scene:s2', 'scene:s3', 'scene:s4', 'scene:s5'])
    assert(writerScopes.length >= 7 && writerScopes.length <= 8)
    assert(writerScopes.slice(6).every(scope => scope === 'natural-ending'))
    assert.equal(critics, writerScopes.length + 1); assert(requests.length <= 17)
    const rows = repo.getManuscriptSegmentsByRun(runId), accepted = rows.filter(row => row.status === 'accepted' && row.kind === 'prose')
    assert.equal(accepted.length, writerScopes.length - 1)
    assert.equal(new Set(accepted.map(row => row.chunk_index)).size, accepted.length, 'a carried tail never competes with an accepted chunk')
    const carriedTail = rows.find(row => row.segment_id.endsWith(':partial-tail') && row.content.startsWith('风从下面'))
    assert(carriedTail); assert.equal(carriedTail.scene_id, null); assert.equal(carriedTail.status, 'superseded')
    assert(accepted.some(row => row.supersedes_segment_id === carriedTail.segment_id && row.content.startsWith(carriedTail.content)), 'the original tail is actually carried, not silently discarded')
    assert(rows.some(row => row.status === 'rejected' && row.content === outputs[1]))
    const manuscript = accepted.sort((a, b) => a.chunk_index - b.chunk_index).map(row => row.content).join('')
    assert(Array.from(manuscript).length >= 8000); assert(Array.from(manuscript).length <= 8400)
    assert(repo.getSceneStates(runId).every(state => state.lifecycle === 'committed'))
    for (const contract of config.sceneContracts.contracts) {
      const ledger = JSON.parse(repo.getRunEvidence(runId, 'scene_beat_repair:' + contract.sceneId).json)
      assert.equal(ledger.attempts.length, contract.order === 2 ? 1 : 0)
      assert.equal(ledger.pending, null)
    }
    const firstCycle = JSON.parse(repo.getRunEvidence(runId, 'writing_pipeline_cycle_000001').json)
    assert.equal(firstCycle.criticCallAttempts, 2)
    assert.equal(firstCycle.issues.length, 1, 'second critic cannot delete the validated first style finding')
    const artifacts = repo.getArtifactsByRun(runId)
    assert.equal(artifacts.length, 1)
    assert.equal(path.dirname(artifacts[0].relative_path), await fs.realpath(docDir))
    const exported = await fs.readFile(artifacts[0].relative_path, 'utf8')
    assert.equal(exported, manuscript); assert.equal(artifacts[0].char_count, Array.from(exported).length)
    assert(!exported.includes('```json')); assert(!exported.includes('synthetic full-span advisory'))
    console.log(`PRODUCTION_RECOVERY completed; ${Array.from(exported).length} characters; 5 committed scenes; ${requests.length} loopback requests; export=${artifacts[0].relative_path}`)
    const before = requests.length
    const restored = api.createAgentRunEngine({ store, getConfig: () => config, modelCall: async () => { throw new Error('completed run must not call Provider') },
      toolExecutor: async () => '', publishLongwriteArtifact: api.publishCliManuscript, onEvent: () => {}, onRunUpdate: () => {} })
    await assert.rejects(restored.restore(runId), /终态/u)
    await assert.rejects(engine.step(runId), /终态/u)
    assert.equal(requests.length, before); assert.equal(repo.getArtifactsByRun(runId).length, 1)
  } finally {
    repo.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
})
