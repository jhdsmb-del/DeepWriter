const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { before, test } = require('node:test')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const hash = value => createHash('sha256').update(value).digest('hex')
const cp = value => Array.from(value).length
let api
before(async () => {
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    export {buildExecutionSnapshot} from './src/main/executionSnapshot';
    export {createRepository} from './src/main/db/repository';
    export {createRunStorePort} from './src/main/runKernelAdapter';
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {evaluateSceneContract} from './src/main/narrative/sceneContract';
    export {grillMeOutlineHash} from './src/shared/grillMe';
    export * from './src/main/narrative/sceneBeatRepair';
    export {publishCliManuscript} from './src/cli/manuscript';
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent',
    external: ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite'],
    plugins: [{ name: 'isolated-electron', setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'isolated-electron' }))
      build.onLoad({ filter: /.*/, namespace: 'isolated-electron' }, () => ({ contents: `
        export const app={getPath:name=>name,isPackaged:false};
        export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]}),showSaveDialog:async()=>({canceled:true})};
        export const safeStorage={isEncryptionAvailable:()=>false,encryptString:()=>null,decryptString:()=>''};
        export const ipcMain={handle:()=>{},on:()=>{}};
        export const shell={openExternal:()=>{},openPath:async()=>''};
        export const clipboard={writeText:()=>{}};
        export const Menu={buildFromTemplate:()=>({popup:()=>{}})};
      `, loader: 'js' }))
      build.onResolve({ filter: /.*/ }, args => {
        if (!args.path.startsWith('.')) return { path: args.path, external: true }
        const target = path.resolve(args.resolveDir, args.path)
        const source = ['', '.ts', '.js', '/index.ts'].map(suffix => target + suffix).find(existsSync)
        if (!source || !source.startsWith(root + path.sep)) throw new Error('Source outside workspace')
        return { path: source, namespace: 'source' }
      })
      build.onLoad({ filter: /.*/, namespace: 'source' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }))
    } }] })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
  api = loaded.exports
})

// Ordinary prose, not a literal contract pasted into padding. The first draft
// omits the arrival; the revision supplies that action and keeps its other facts.
const tail = [
  '值班室的灯罩上结着薄薄一层盐霜。林舟把围巾留在椅背，站在桌旁听了一会儿，楼梯那边没有脚步声，只有风从门缝里低低地穿过。墙上的钟慢了两分钟，他没有伸手去拨。',
  '桌上放着一本翻开的记录本，纸边已经起毛。他把那一页压平，又将窗边的椅子拉近半步；椅脚摩擦地板的声音显得很响。他停下来，等声音落下，才说了一句：“还没有人回来。”',
  '窗外的海看不清岸线，灯塔的光绕过一圈，玻璃上短暂浮出他的倒影。他没有再看钟。门仍留着一条窄缝，冷风吹动椅背上的围巾，布角一下一下碰着木板。'
].join('\n\n')
const original = `林舟在灯塔值班室的桌边停住，外套的下摆滴着水。\n\n${tail}`
const revised = `林舟抵达灯塔，走进值班室，在桌边停住，外套的下摆滴着水。\n\n${tail}`

function arrivalReview(body) {
  const review = body.sceneBeatReview
  if (!review) return undefined
  assert.equal(review.semanticVersion, 2)
  const quote = '林舟抵达灯塔'
  return {
    semanticVersion: review.semanticVersion, contractHash: review.contractHash,
    candidateHash: body.candidateHash, scenePrefixHash: review.scenePrefixHash,
    beats: review.requiredBeats.map(beat => {
      const satisfied = /^林舟抵达灯塔。?$/.test(beat.requiredSource) &&
        body.candidate.indexOf(quote) >= 0 && body.candidate.indexOf(quote) === body.candidate.lastIndexOf(quote)
      const status = satisfied ? 'satisfied' : 'missing'
      return {
        beatId: beat.beatId, status,
        partEvidence: beat.parts.map(part => ({ partId: part.partId, status, spanIndexes: satisfied ? [0] : [] })),
        ...(satisfied ? {
          spans: [{ text: quote, source: 'candidate' }],
          semanticEvents: [{
            spanIndex: 0, partIds: beat.parts.map(part => part.partId), predicate: '抵达',
            agent: ['林舟'], agentBindings: [{ name: '林舟', relation: 'explicit', mention: { spanIndex: 0, text: '林舟' } }],
            patient: ['灯塔'], actuality: 'asserted_actual', assertion: 'asserted', negation: false
          }]
        } : {})
      }
    })
  }
}

async function fixture(name, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-scene-beat-repair-'))
  const workDir = path.join(temp, 'work')
  const docDir = path.join(temp, 'documents')
  await Promise.all([fs.mkdir(workDir), fs.mkdir(docDir)])
  const runId = `scene-repair-${name}`
  const target = options.target || cp(revised)
  const beat = options.beat || '林舟抵达灯塔。'
  const outline = { title: '值班室', premise: '林舟独自来到灯塔值班室，等待值班的人回来。', targetChars: target,
    sections: [{ id: 's1', title: '灯塔值班室', purpose: '通过具体行动建立守夜的起点。', targetChars: target, beats: [beat], sourceSlotIds: options.sourceSlotIds || [] }] }
  const config = api.buildExecutionSnapshot({ payload: {
    id: runId, mode: 'longwrite', workspace: 'novel', phase: 'execute', longMode: true, targetChars: target,
    text: '写林舟在灯塔值班室守夜的小说。',
    grillMe: { stateId: `${runId}-grill`, originalTask: '写灯塔守夜小说。', targetChars: target, answers: [], assumptions: [], approvedOutline: outline, outlineRevision: 1, outlineHash: api.grillMeOutlineHash(outline) },
    strongConstraints: { enabled: true, level: 'balanced', themeLockMode: 'off', expressionFreedom: 'high', antiMoralizingEnabled: true, perspective: 'auto', genre: '小说' }
  }, settings: { model: 'fake-scene-repair', baseUrl: 'http://127.0.0.1:9', maxTokens: 4096, temperature: 0.7, topP: 1,
    thinkingEnabled: false, reasoningEffort: 'high', workDir, docDir, novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000,
    completionTokenBudget: 100000, completionWallClockMs: 300000,
    strongConstraintEnabled: true, themeLockMode: 'off', expressionFreedom: 'high', antiMoralizingEnabled: true,
    strongConstraintPerspective: 'auto', strongConstraintGenre: '小说', strongConstraintMustKeep: '', strongConstraintAvoid: '' },
    sessionId: `${runId}-session`, memory: { projectPath: '', projectContent: '', userContent: '' } })
  if (options.maxCalls !== undefined) config.providerCallBudget.maxCalls = options.maxCalls
  if (options.maxTokens !== undefined) config.providerCallBudget.maxTokens = options.maxTokens
  if (options.nativeBoundary) config.providerCallBudget.maxCost = options.costCap || null
  config.cancelFallbackMs = 10
  const repo = api.createRepository(path.join(temp, 'run.db')); repo.open()
  const store = api.createRunStorePort(repo, path.join(temp, 'artifacts'))
  const readEvidence = store.getRunEvidence.bind(store)
  store.getRunEvidence = async (id, kind) => {
    const row = await readEvidence(id, kind)
    if (!kind.startsWith('scene_beat_repair:')) return row
    if (options.hideFrozenBudget) return null
    if (options.corruptFrozenBudget && row) {
      const invalid = JSON.parse(row.json); invalid.maxAttempts = 200
      return { ...row, json: JSON.stringify(invalid) }
    }
    return row
  }
  const calls = []; const http = []; const events = []; const boundary = []; const tokenBoundaries = []
  let writers = 0; let engine
  const makeEngine = () => api.createAgentRunEngine({ store, getConfig: () => config, toolExecutor: async () => '',
    publishLongwriteArtifact: api.publishCliManuscript, onEvent: (_id, event) => {
      events.push(event)
      if (options.cancelScheduled && event.title === '正在补足场景推进点') void engine.cancel(runId)
    }, onRunUpdate: () => {},
    modelCall: async request => {
      const purpose = request.purpose || 'writer'; calls.push(purpose)
      tokenBoundaries.push({ purpose, tokens: JSON.parse(repo.getRunEvidence(runId, 'run_provider_budget_v1').json).tokenReservations.map(item => item.totalTokens) })
      let output
      if (purpose === 'writer') {
        writers++
        boundary.push({ writers, accepted: repo.getManuscriptSegmentsByRun(runId).filter(row => row.status === 'accepted'), messages: request.messages })
        output = options.writer ? options.writer(writers) : writers === 1 ? original : revised
      } else {
        assert.equal(purpose, 'critic', 'no extra semantic judge or editor needed for this fixture')
        const body = JSON.parse(request.messages.find(message => message.role === 'user').content)
        output = JSON.stringify({ schemaVersion: 1, anchorMode: 'exact_quote', candidateHash: body.candidateHash, issues: [],
          sceneBeatEvidence: arrivalReview(body) })
      }
      if (options.nativeBoundary) {
        if (options.corruptBeforeRepairFetch && purpose === 'writer' && writers > 1) {
          const kind = `scene_beat_repair:${config.sceneContracts.contracts[0].sceneId}`
          const invalid = JSON.parse(repo.getRunEvidence(runId, kind).json)
          invalid.pending.candidateHash = '1'.repeat(64)
          await store.saveRunEvidence(runId, kind, JSON.stringify(invalid))
        }
        const costQuote = options.denyRepairPrice && purpose === 'writer' && writers > 1
          ? { status: 'unknown', amount: null, currency: null }
          : { status: 'estimated', amount: 0.001, currency: 'CNY' }
        const callback = { innerAttempt: 1, logicalCallId: request.logicalCallId, request: { messages: request.messages, maxTokens: 4096 }, costQuote }
        await request.beforeProviderAttempt(callback)
        if (options.duplicateBoundary) await request.beforeProviderAttempt(callback)
      }
      http.push(purpose) // fake transport: never creates a socket or reads a key
      if (options.cancelReserved && purpose === 'writer' && writers > 1) await engine.cancel(runId)
      return { async *[Symbol.asyncIterator]() {
        yield { type: 'text', delta: output }
        if (options.knownUsage) yield { type: 'usage', usage: { inputTokens: purpose === 'critic' && options.criticUsageTokens ? options.criticUsageTokens / 2 : 10, outputTokens: purpose === 'critic' && options.criticUsageTokens ? options.criticUsageTokens / 2 : 10, cost: 0.001 } }
        yield { type: 'finish', finishReason: purpose === 'writer' && options.finishReason ? options.finishReason(writers) : 'stop' }
      } }
    }
  })
  engine = makeEngine()
  await engine.start({ runId, sessionId: `${runId}-session`, config })
  await store.appendTurn({ turnId: `${runId}-user`, runId, turnSeq: 1, role: 'user', content: '请按已确认场景写灯塔小说。', createdAt: Date.now() })
  try { await engine.step(runId) } catch (error) { events.push({ failure: error.message }) }
  return { temp, docDir, repo, store, config, runId, engine, makeEngine, calls, http, boundary, events, tokenBoundaries,
    repair: () => JSON.parse(repo.getRunEvidence(runId, `scene_beat_repair:${config.sceneContracts.contracts[0].sceneId}`)?.json || 'null'),
    rows: () => repo.getManuscriptSegmentsByRun(runId), run: () => repo.getRun(runId), evidence: kind => JSON.parse(repo.getRunEvidence(runId, kind)?.json || 'null') }
}

test('complete missing beat is rewritten through writer+critic without UI approval; only revised prose reaches a real file', async () => {
  const result = await fixture('natural-arrival')
  try {
    assert(result.config.writingPipeline && result.config.strongConstraints.enabled, 'fixture must keep real review ON')
    const evaluation = api.evaluateSceneContract(result.config.sceneContracts.contracts[0], original, { completed: true, scenePrefix: '', sceneChars: cp(original) })
    assert.equal(evaluation.beatEvidence[0].status, 'missing')
    assert.equal(result.boundary[1].accepted.length, 0, 'missing first candidate must never become an accepted continuation prefix')
    assert.deepEqual(result.calls, ['writer', 'critic', 'writer', 'critic'])
    assert.equal(result.run().status, 'completed', JSON.stringify({ run: result.run(), events: result.events }))
    const accepted = result.rows().filter(row => row.kind === 'prose' && row.status === 'accepted')
    assert.equal(accepted.map(row => row.content).join(''), revised)
    assert(result.rows().some(row => row.status === 'rejected' && row.content === original))
    const artifacts = result.repo.getArtifactsByRun(result.runId)
    assert.equal(artifacts.length, 1)
    const delivered = await fs.readFile(artifacts[0].relative_path, 'utf8')
    assert.equal(delivered, revised); assert.equal(hash(delivered), artifacts[0].hash)
    assert.equal(path.dirname(artifacts[0].relative_path), await fs.realpath(result.docDir))
    assert(result.repo.getSceneStates(result.runId).every(scene => scene.lifecycle === 'committed'))
    assert.equal(result.repair().maxAttempts, 2); assert.equal(result.repair().attempts.length, 1)
    assert.equal(result.repair().pending, null)
    assert.equal(result.repair().attempts[0].candidateHash, hash(original))
    const injected = result.boundary[1].messages.find(message => message.content.startsWith('[SceneContract 缺失推进点定向修订]'))
    const binding = JSON.parse(injected.content.split('\n').at(-1))
    assert.equal(binding.candidateHash, hash(original)); assert.equal(binding.scenePrefixHash, hash(''))
    assert.equal(binding.originalCandidate, original); assert.deepEqual(binding.missingBeats.map(item => item.beatId), result.config.sceneContracts.contracts[0].requiredBeatIds)
    console.log(`isolated artifact: ${artifacts[0].relative_path}`)
  } finally { result.repo.close() }
})

test('second permitted repair can succeed, and duplicate provider boundary hooks do not double charge', async () => {
  const result = await fixture('second-repair', { nativeBoundary: true, duplicateBoundary: true, writer: number => number < 3 ? original : revised })
  try {
    assert.deepEqual(result.http, ['writer', 'critic', 'writer', 'critic', 'writer', 'critic'])
    assert.equal(result.run().status, 'completed')
    assert.equal(result.repair().attempts.length, 2)
    assert.equal(new Set(result.repair().attempts.map(item => item.logicalCallId)).size, 2)
    assert(result.boundary.every(item => item.accepted.length === 0))
    const artifacts = result.repo.getArtifactsByRun(result.runId)
    assert.equal(artifacts.length, 1); assert.equal(await fs.readFile(artifacts[0].relative_path, 'utf8'), revised)
  } finally { result.repo.close() }
})

test('per-scene cap exhausts at exactly two actual repairs; a fresh engine preserves count and pending packet without more calls', async () => {
  const result = await fixture('exhausted', { nativeBoundary: true, writer: () => original })
  try {
    assert.equal(result.run().status, 'waiting_user')
    assert.equal(result.run().error_code, 'narrative_state_pending_review')
    assert.equal(result.run().error_message, 'scene_beat_repair_exhausted:2')
    assert.equal(result.repair().attempts.length, 2)
    assert.equal(result.http.length, 6)
    assert(!result.rows().some(row => row.status === 'accepted'))
    assert.equal(result.repo.getArtifactsByRun(result.runId).length, 0)
    const packet = result.repo.getRunEvidence(result.runId, 'narrative_semantic_review').json
    const ledger = JSON.stringify(result.repair())
    const restarted = result.makeEngine()
    await restarted.restore(result.runId)
    await restarted.step(result.runId)
    assert.equal(result.http.length, 6); assert.equal(JSON.stringify(result.repair()), ledger)
    assert.equal(result.repo.getRunEvidence(result.runId, 'narrative_semantic_review').json, packet)
    assert.equal((await restarted.getState(result.runId)).run.status, 'waiting_user')
  } finally { result.repo.close() }
})

test('call budget denial before the rewrite does not consume a per-scene repair attempt', async () => {
  const result = await fixture('call-deny', { nativeBoundary: true, maxCalls: 2 })
  try {
    assert.equal(result.run().status, 'waiting_user'); assert.equal(result.run().error_code, 'run_provider_call_cap')
    assert.deepEqual(result.http, ['writer', 'critic']); assert.equal(result.repair().attempts.length, 0)
    assert(result.repair().pending); assert(!result.rows().some(row => row.status === 'accepted'))
    assert.equal(result.repo.getArtifactsByRun(result.runId).length, 0)
  } finally { result.repo.close() }
})

test('price refusal at the actual native pre-fetch boundary does not charge a scene repair or send transport', async () => {
  const result = await fixture('price-deny', { nativeBoundary: true, costCap: { amount: 1, currency: 'CNY', unknownPolicy: 'deny' }, denyRepairPrice: true })
  try {
    assert.equal(result.run().status, 'waiting_user'); assert.equal(result.run().error_code, 'run_cost_unknown_price')
    assert.deepEqual(result.http, ['writer', 'critic']); assert.equal(result.repair().attempts.length, 0)
    assert(!result.rows().some(row => row.status === 'accepted')); assert.equal(result.repo.getArtifactsByRun(result.runId).length, 0)
  } finally { result.repo.close() }
})

test('token denial at the rewrite reservation leaves scene attempts zero and sends no fake transport', async () => {
  // The v2 scene protocol itself reserves ~18k here; permit that review but
  // leave less than the bound rewrite request after its known usage settles.
  const result = await fixture('token-deny', { nativeBoundary: true, knownUsage: true, criticUsageTokens: 12000, maxTokens: 20000 })
  try {
    assert.equal(result.run().status, 'waiting_user', JSON.stringify({ status: result.run().status, code: result.run().error_code, calls: result.http, tokens: result.tokenBoundaries }))
    assert.equal(result.run().error_code, 'run_token_budget')
    assert.deepEqual(result.http, ['writer', 'critic']); assert.equal(result.repair().attempts.length, 0)
    assert(!result.rows().some(row => row.status === 'accepted')); assert.equal(result.repo.getArtifactsByRun(result.runId).length, 0)
  } finally { result.repo.close() }
})

test('missing or corrupted frozen per-scene budget cannot create a fresh allowance on a legacy/restored run', async () => {
  for (const guard of ['hideFrozenBudget', 'corruptFrozenBudget']) {
    const result = await fixture(`frozen-${guard}`, { nativeBoundary: true, [guard]: true })
    try {
      assert.equal(result.run().status, 'waiting_user')
      assert.equal(result.repair().attempts.length, 0)
      assert.deepEqual(result.http, guard === 'hideFrozenBudget' ? ['writer', 'critic'] : [])
      assert(!result.rows().some(row => row.status === 'accepted')); assert.equal(result.repo.getArtifactsByRun(result.runId).length, 0)
    } finally { result.repo.close() }
  }
})

test('native pre-fetch rechecks the bound repair evidence, so a changed candidate cannot obtain a reservation', async () => {
  const result = await fixture('native-binding-changed', { nativeBoundary: true, corruptBeforeRepairFetch: true })
  try {
    assert.equal(result.run().status, 'waiting_user'); assert.equal(result.run().error_code, 'run_budget_persistence')
    assert.deepEqual(result.http, ['writer', 'critic']); assert.equal(result.repair().attempts.length, 0)
    assert(!result.rows().some(row => row.status === 'accepted')); assert.equal(result.repo.getArtifactsByRun(result.runId).length, 0)
  } finally { result.repo.close() }
})

test('cancel between scheduling and next reserve spends no repair; cancel after reserve cannot accept the late revision', async () => {
  for (const mode of ['Scheduled', 'Reserved']) {
    const result = await fixture(`cancel-${mode}`, { nativeBoundary: true, [`cancel${mode}`]: true })
    try {
      assert.equal(result.run().status, 'cancelled', JSON.stringify({ mode, code: result.run().error_code, message: result.run().error_message, phases: result.events.filter(event => event.type === 'phase' || event.failure) }))
      assert.equal(result.repair().attempts.length, mode === 'Scheduled' ? 0 : 1)
      assert(!result.rows().some(row => row.status === 'accepted')); assert.equal(result.repo.getArtifactsByRun(result.runId).length, 0)
    } finally { result.repo.close() }
  }
})

test('opaque beats and unknown actor bindings remain semantic pending after bounded rewrites, not automatic fact grants', async () => {
  for (const beat of ['气氛变得压抑。', '有人把钥匙交给林舟。']) {
    const result = await fixture(`unsupported-${hash(beat).slice(0, 8)}`, { beat, nativeBoundary: true })
    try {
      assert.equal(result.run().status, 'waiting_user')
      assert.deepEqual(result.http, ['writer', 'critic', 'writer', 'critic', 'writer', 'critic'])
      assert.equal(result.repair().attempts.length, 2)
      assert(!result.rows().some(row => row.status === 'accepted')); assert.equal(result.repo.getArtifactsByRun(result.runId).length, 0)
    } finally { result.repo.close() }
  }
})

test('missing confirmed fact registry blocks repair without inventing the required base fact', async () => {
  const result = await fixture('fact-missing', { sourceSlotIds: ['initial-key-owner'], nativeBoundary: true })
  try {
    assert.equal(result.run().status, 'waiting_user'); assert.equal(result.run().error_message, 'scene_beat_repair_required_fact_missing')
    assert.equal(result.http.length, 2); assert.equal(result.repair().attempts.length, 0)
    assert(!result.rows().some(row => row.status === 'accepted')); assert.equal(result.repo.getArtifactsByRun(result.runId).length, 0)
  } finally { result.repo.close() }
})

test('negation and counterfactual event evidence never enters automatic missing-beat repair', async () => {
  for (const text of [`林舟没有抵达灯塔。\n\n${tail}`, `林舟想象自己抵达灯塔。\n\n${tail}`]) {
    const result = await fixture(`counterfactual-${hash(text).slice(0, 8)}`, { writer: () => text, nativeBoundary: true, maxCalls: 2 })
    try {
      assert.notEqual(result.run().status, 'completed')
      assert.equal(result.repair().attempts.length, 0)
      assert(!result.rows().some(row => row.status === 'accepted'), JSON.stringify({ text: text.slice(0, 30), calls: result.calls, evaluation: api.evaluateSceneContract(result.config.sceneContracts.contracts[0], text, { completed: true, scenePrefix: '', sceneChars: cp(text) }), rows: result.rows().map(row => ({ status: row.status, content: row.content.slice(0, 30) })) })); assert.equal(result.repo.getArtifactsByRun(result.runId).length, 0)
      assert(result.http.length <= 2)
    } finally { result.repo.close() }
  }
})

test('request/candidate/prefix bindings are exact and prefix changes cannot reset the total scene allowance', async () => {
  const result = await fixture('bound-ledger')
  try {
    const contract = result.config.sceneContracts.contracts[0]
    let ledger = api.readSceneBeatRepairLedger(JSON.stringify(result.repair()), result.runId, contract)
    assert.equal(ledger.attempts.length, 1)
    const pending = { ...result.evidence(`scene_beat_repair:${contract.sceneId}`) }
    pending.attempts = []; assert.throws(() => api.readSceneBeatRepairLedger(JSON.stringify(pending), result.runId, contract), /ledger_invalid/)
    assert.throws(() => api.readSceneBeatRepairLedger(JSON.stringify(ledger), 'another-run', contract), /ledger_invalid/)
    assert.throws(() => api.readSceneBeatRepairLedger(JSON.stringify(ledger), result.runId, { ...contract, frozenHash: '1'.repeat(64) }), /ledger_invalid/)
    const prefix = '已接受的灯塔前文。'
    const candidate = { runId: result.runId, sceneId: contract.sceneId, segmentId: 'next-repair', revision: 1, status: 'candidate', content: original, contentHash: hash(original) }
    const evaluation = api.evaluateSceneContract(contract, original, { completed: true, scenePrefix: prefix, sceneChars: cp(prefix + original) })
    const request = api.makeSceneBeatRepairRequest(contract, candidate, prefix, evaluation)
    ledger = api.scheduleSceneBeatRepair(ledger, request)
    assert.equal(ledger.attempts.length, 1)
    ledger = api.reserveSceneBeatRepair(ledger, request.requestHash, 'second-logical-call', Date.now())
    assert.equal(ledger.attempts.length, 2); assert.equal(ledger.attempts[1].scenePrefixHash, hash(prefix))
    assert.throws(() => api.scheduleSceneBeatRepair(ledger, { ...request, scenePrefixHash: hash('different prefix') }), /exhausted/)
    assert.throws(() => api.makeSceneBeatRepairRequest(contract, { ...candidate, contentHash: '1'.repeat(64) }, prefix, evaluation), /binding_invalid/)
    assert.throws(() => api.makeSceneBeatRepairRequest(contract, candidate, prefix + '漂移', evaluation), /binding_invalid/)
  } finally { result.repo.close() }
})

test('finish=length may continue a valid incomplete scene, but final stop requires all beats and a committed delta', async () => {
  const continuation = '林舟抵达灯塔时留下的水迹还在门口。他沿着那条深色的水线回到窗前，把围巾拢紧，没有再去碰那只慢了两分钟的钟。'
  const result = await fixture('length-continuation', { target: cp(original + continuation), nativeBoundary: true,
    writer: number => number === 1 ? original : continuation, finishReason: number => number === 1 ? 'length' : 'stop' })
  try {
    assert.equal(result.run().status, 'completed', JSON.stringify({ code: result.run().error_code, message: result.run().error_message, calls: result.http }))
    assert.deepEqual(result.http, ['writer', 'critic', 'writer', 'critic'])
    assert.equal(result.boundary[1].accepted.length, 1, 'length fragment retains the existing accepted/defer continuation semantics')
    assert.equal(result.repair().attempts.length, 0)
    assert.equal(result.repo.getSceneStates(result.runId)[0].lifecycle, 'committed')
    const artifacts = result.repo.getArtifactsByRun(result.runId)
    assert.equal(artifacts.length, 1); assert.equal(await fs.readFile(artifacts[0].relative_path, 'utf8'), original + continuation)
  } finally { result.repo.close() }
})

test('length continuation never bypasses opaque, negated or imagined event evidence', async () => {
  for (const item of [{ beat: '气氛变得压抑。', text: original }, { text: `林舟没有抵达灯塔。\n\n${tail}` }, { text: `林舟想象自己抵达灯塔。\n\n${tail}` }]) {
    const result = await fixture(`length-guard-${hash(item.text).slice(0, 8)}`, { beat: item.beat, writer: () => item.text, finishReason: () => 'length', nativeBoundary: true, maxCalls: 2 })
    try {
      assert.notEqual(result.run().status, 'completed')
      assert.equal(result.repair().attempts.length, 0)
      assert(!result.rows().some(row => row.status === 'accepted'), item.text.slice(0, 40))
      assert.equal(result.repo.getArtifactsByRun(result.runId).length, 0)
    } finally { result.repo.close() }
  }
})
