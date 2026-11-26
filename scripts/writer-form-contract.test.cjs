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
    export * from './src/main/writingContext'; export {buildStrongConstraintSnapshot,buildStrongConstraintSystemPrompt,evaluateStrongConstraints} from './src/main/strongConstraints'; export {createContextService} from './src/main/contextService';
    export {buildExecutionSnapshot} from './src/main/executionSnapshot';
    export {createRepository} from './src/main/db/repository';
    export {createRunStorePort,createModelCallAdapter} from './src/main/runKernelAdapter';
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {grillMeOutlineHash} from './src/shared/grillMe';
    export {publishCliManuscript} from './src/cli/manuscript';
    export {projectTerminalAssistant} from './src/main/sessionProjection';
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

const cp = text => Array.from(text).length
const agreements = [
  { slotId: 'audience', value: '读者是第一次遇到地铁停运的上班族，不默认他们懂铁路术语。', source: 'user' },
  { slotId: 'tone', value: '用平静短句，直接称呼“你”，不要客服口吻。', source: 'user' },
  { slotId: 'evidence', value: '材料只有：07:10发布通知，停运区间为北站至江湾，接驳车间隔约15分钟；没有恢复时间。', source: 'user' },
  { slotId: 'sample', value: '样段：“先看站台上的屏幕。没写恢复时间，就别替它猜。”只借写法，不把样段当新消息。', source: 'user' }
]
const firstArticle = '先确认你所在的位置，再看消息的范围。07:10发布的通知说，北站至江湾停运。这句话描述的是一个区间，不是整条线路，也没有说区间外各站的列车是否照常运行。你可以把通知上的站名与你原本的路线对照，但不要从“停运”两个字推出自己所有路段都走不了。\n\n车站屏幕可能还有别的提示。读到新提示时，先看发布时间，再看它是否针对同一个区间。一张没有时间的转发图片，不足以替代刚刚看到的车站通知。你不必抢着从人群里得出答案，先把手上能确认的几句话分开。'
const addition = '还有一条边界要留住：目前没有恢复时间。没有公布，不等于很快恢复，也不等于全天停运。你可以据此调整眼前的安排，但不要替通知填上一个时刻。'
const secondArticle = '接下来比较你能实际选择的路。材料给出的接驳车间隔约15分钟，指的是相邻班次的大致间隔，不是你此刻还要等15分钟。你到站时已经过去多久、上车位置在哪里，这些都没有提供。先向现场工作人员确认候车点，再决定是否等下一班。\n\n如果要改走地面交通，就把步行到站、候车和换乘分别考虑。别把地图上的行驶时间直接当作到达时间，也别假定接驳车一定能一次坐上。你可以向等你的人说明已经确认的停运区间，以及自己正在核对替代路线；还没确认的部分，暂时留空。这样报出的不是一个好听的承诺，而是对方可以据此安排事情的信息。'
const formattedArticle = firstArticle + addition + '\n\n' + secondArticle

async function fixture(form, mode = 'capture', enabled = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-writer-form-'))
  const docDir = path.join(dir, 'documents'); await fs.mkdir(docDir)
  const database = path.join(dir, 'run.db')
  let repo = api.createRepository(database); repo.open()
  let store = api.createRunStorePort(repo, path.join(dir, 'artifacts'))
  const runId = 'writer-form-' + (form ?? 'legacy') + '-' + mode, sessionId = runId + '-session'
  const calls = [], writerMessages = [], events = []
  let engine, config, failure, writers = 0, resolveWriter, resolveHeld
  const arrived = new Promise(resolve => { resolveWriter = resolve })
  const held = new Promise(resolve => { resolveHeld = resolve })
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk }); request.on('end', () => {
      try {
        const body = JSON.parse(raw)
        const criticUser = body.messages.find(message => message.role === 'user' && message.content.startsWith('{"candidateHash"'))
        let text
        if (criticUser) {
          calls.push('critic')
          const input = JSON.parse(criticUser.content), review = input.sectionReview
          assert(review, 'coverage is added to the existing critic only at a section boundary')
          assert(!Object.hasOwn(review, 'acceptedPrefix'), 'full accepted section stays local')
          assert(review.acceptedExcerpts.reduce((n, excerpt) => n + cp(excerpt.text), 0) <= 4000)
          assert(!input.sceneBeatReview, 'an explanation section cannot be forced to prove physical story events')
          const status = input.candidate === firstArticle ? 'needs_attention' : 'covered'
          text = JSON.stringify({ schemaVersion: 1, anchorMode: 'exact_quote', candidateHash: input.candidateHash, issues: [],
            sectionCoverage: { sectionId: review.sectionId, outlineHash: review.outlineHash, candidateHash: input.candidateHash, prefixHash: review.prefixHash,
              status, quote: status === 'covered' ? input.candidate : '', reason: status === 'covered' ? '本节已展开约定目的；引用为本节正文依据，未核验外部事实。' : '区分区间信息后，还需明确没有恢复时间，不替通知猜测。' } })
        } else {
          calls.push('writer'); writers++; writerMessages.push(body.messages); resolveWriter()
          if (mode === 'capture' || mode === 'task-only') return // Caller pauses before receiving any model output.
          if (mode === 'recovery' && writers === 2) { resolveHeld(); return }
          const scope = body.messages.find(message => message.content.startsWith('## 本轮正文节范围'))?.content
          assert(scope)
          const outputIndex = writers - 1 - (mode === 'recovery' && writers > 2 ? 1 : 0)
          assert(scope.includes(outputIndex <= 1 && enabled ? 'sec-known' : outputIndex === 0 ? 'sec-known' : 'sec-action'))
          if (outputIndex === 1 && enabled) assert(scope.includes('审校建议') || scope.includes('已有审校意见'))
          text = enabled ? [firstArticle, addition, secondArticle][outputIndex] : [firstArticle, addition + secondArticle][outputIndex]
          if (mode === 'overflow' && writers === 1) text += '你仍然站在最初的屏幕前，把上面已经知道的几句话重新看了一遍。'.repeat(20)
          assert(text, 'fixture must not keep writing to evade a coverage failure')
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 50 } }) + '\n\ndata: [DONE]\n\n')
      } catch (error) { failure = error; resolveWriter(); response.writeHead(500); response.end('fixture failed') }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const target = cp(firstArticle + addition + secondArticle)
  const outline = { title: '地铁临时停运', premise: '处理同一条停运消息。', targetChars: target, sections: [
    { id: 'sec-known', title: '先区分已知与未知', purpose: '让读者区分通知已经说明的事实和仍然未知的信息。', targetChars: cp(firstArticle),
      beats: form === 'narrative' ? ['林舟抵达北站。'] : ['解释停运范围，不替通知猜恢复时间。'], sourceSlotIds: mode === 'task-only' ? ['original_task'] : ['evidence', 'tone', 'audience', 'sample'] },
    { id: 'sec-action', title: '再决定怎样转乘', purpose: '基于已知材料给出保守、可执行的转乘方法。', targetChars: cp(addition + secondArticle),
      beats: form === 'narrative' ? ['林舟打开手机。'] : ['区分班次间隔与个人等候时间，保留未知条件。'], sourceSlotIds: ['original_task'] }
  ] }
  config = api.buildExecutionSnapshot({ payload: { id: runId, mode: 'longwrite', phase: 'execute', longMode: true, targetChars: target,
    text: '写地铁临时停运时的选择，按作者确认的写法完成。',
    strongConstraints: { enabled, themeLockMode: 'off', expressionFreedom: 'high', antiMoralizingEnabled: true, perspective: 'auto', genre: form === 'narrative' ? '小说' : '说明文章' },
    grillMe: { ...(form ? { writingForm: form } : {}), stateId: runId + '-grill', originalTask: '围绕地铁临时停运写作。', targetChars: target, answers: mode === 'task-only' ? [] : agreements, assumptions: [],
      approvedOutline: outline, outlineRevision: 1, outlineHash: api.grillMeOutlineHash(outline) } }, sessionId,
    settings: { model: 'local-form', baseUrl, maxTokens: 4096, temperature: .7, topP: 1, thinkingEnabled: false, reasoningEffort: 'high', workDir: dir, docDir,
      novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000, completionTokenBudget: 1000000,
      completionWallClockMs: 30000, strongConstraintEnabled: enabled, themeLockMode: 'off', expressionFreedom: 'high', antiMoralizingEnabled: true },
    memory: { projectPath: '', projectContent: '', userContent: '' } })
  config.longwrite_v2 = true // Exercise the production v2 override as well as the standard new-form dispatch.
  config.providerCallBudget = { maxCalls: 20, maxTokens: 1000000, maxCost: null, maxCostCny: null, maxWallClockMs: 30000 }
  config.completionContract.providerCallBudget = config.providerCallBudget
  let context = api.createContextService(repo)
  const adapter = api.createModelCallAdapter({ getConfig: () => config, getSignal: id => engine.abortSignal(id), buildPrefix: async rc => rc.frozenSystemMessages,
    assembleContext: (...args) => context.assembleRunContext(...args), getApi: () => ({ apiKey: '', baseUrl, model: 'local-form', maxTokens: 4096,
      thinking: { enabled: false, effort: 'high' }, temperature: .7, topP: 1, supportsTools: false, protocol: 'deepseek-chat', adapterId: 'builtin.deepseek',
      chatPath: '/chat/completions', authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } }) })
  const makeEngine = () => api.createAgentRunEngine({ store, getConfig: () => config, modelCall: adapter, toolExecutor: async () => '',
    publishLongwriteArtifact: api.publishCliManuscript, onEvent: (_id, event) => events.push(event), onRunUpdate: () => {} })
  engine = makeEngine()
  await engine.start({ runId, sessionId, config })
  await store.appendTurn({ turnId: 'user-' + runId, runId, turnSeq: 1, role: 'user', content: '按已确认的大纲和写作约定完成正文。', createdAt: Date.now() })
  let promise = engine.step(runId)
  return { get repo() { return repo }, get engine() { return engine }, config, runId, calls, writerMessages, events, get promise() { return promise }, arrived, held, failure: () => failure,
    artifactObject: hash => path.join(dir, 'artifacts', hash + '.txt'),
    restart: async () => { await engine.pause(runId); await promise; repo.close(); repo = api.createRepository(database); repo.open(); store = api.createRunStorePort(repo, path.join(dir, 'artifacts')); context = api.createContextService(repo); engine = makeEngine(); await engine.restore(runId); promise = engine.step(runId); await promise },
    close: async () => { await engine.pause(runId); await promise.catch(() => {}); repo.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

function assertAgreements(messages) {
  const wire = JSON.stringify(messages)
  for (const agreement of agreements) assert.equal(wire.split(JSON.stringify(agreement.value).slice(1, -1)).length - 1, 1, 'one frozen author agreement per writer envelope: ' + agreement.slotId)
}

test('same topic reaches real provider as different narrative / explanation / open assignments, while legacy frozen route remains unchanged', async () => {
  for (const form of ['narrative', 'expository', 'open', undefined]) {
    const f = await fixture(form)
    try {
      let timer
      await Promise.race([f.arrived, f.promise.then(() => { throw new Error(JSON.stringify(f.repo.getRun(f.runId))) }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('writer request timeout')), 8000) })]).finally(() => clearTimeout(timer))
      if (f.failure()) throw f.failure()
      const wire = JSON.stringify(f.writerMessages[0])
      if (form) assertAgreements(f.writerMessages[0])
      if (form === 'narrative' || !form) {
        assert(f.config.sceneContracts)
        assert(wire.includes('自然小说内容'))
      } else {
        assert.equal(f.config.sceneContracts, undefined)
        assert(wire.includes('本节目的'))
        assert(!wire.includes('自由间接引语')); assert(!wire.includes('结尾优先用场景'))
        assert(!wire.includes('自然小说内容')); assert(!wire.includes('欲望：'))
      }
    } finally { await f.close() }
  }
})

test('article actually continues an under-covered section, then advances with bound review opinion and delivers without another model purpose', async () => {
  const f = await fixture('expository', 'article')
  try {
    await f.promise
    if (f.failure()) throw f.failure()
    const run = f.repo.getRun(f.runId)
    assert.equal(run.status, 'completed', JSON.stringify({ code: run.error_code, message: run.error_message, calls: f.calls, events: f.events.slice(-8) }))
    assert.deepEqual(f.calls, ['writer', 'critic', 'writer', 'critic', 'writer', 'critic'])
    assert.equal(f.writerMessages.length, 3)
    f.writerMessages.forEach(assertAgreements)
    const accepted = f.repo.getManuscriptSegmentsByRun(f.runId).filter(row => row.status === 'accepted').sort((a, b) => a.chunk_index - b.chunk_index)
    assert.deepEqual(accepted.map(row => row.section_id), ['sec-known', 'sec-known', 'sec-action'])
    const artifacts = f.repo.getArtifactsByRun(f.runId)
    assert.equal(artifacts.length, 1)
    const exported = await fs.readFile(artifacts[0].relative_path, 'utf8')
    assert.equal(exported, formattedArticle)
    assert(exported.includes('填上一个时刻。\n\n接下来比较'))
    assert(exported.includes(firstArticle + addition), 'same-section continuation is still a direct join')
    assert.equal(accepted.map(row => row.content).join(''), firstArticle + addition + secondArticle)
    assert.equal(accepted.reduce((n, row) => n + row.char_count, 0), cp(firstArticle + addition + secondArticle))
    assert(accepted.every(row => row.content_hash === hash(row.content)), 'accepted source identities are unchanged')
    assert.equal(artifacts[0].char_count, cp(formattedArticle))
    const object = readFileSync(f.artifactObject(artifacts[0].hash), 'utf8')
    assert.equal(object, exported, 'existing artifact object and actual file have identical layout')
    let preview
    const projected = api.projectTerminalAssistant({ getTurnsByRun: id => f.repo.getTurnsByRun(id), getSessionMessages: () => [],
      appendSessionMessage: message => { preview = message }, getDeliveredManuscript: () => ({ content: object, hash: artifacts[0].hash, charCount: artifacts[0].char_count }) },
    f.runId, f.config.sessionId, 'completed')
    assert.equal(projected.ok, true)
    assert.equal(preview.content, exported, 'persisted preview uses the delivery object, not another prose concatenation')
    assert.equal(f.events.filter(event => event.type === 'content_replace').at(-1).content, exported)
    assert(f.events.some(event => event.title === '本节覆盖意见' && event.detail.includes('审校建议继续补足')))
    console.log(`ARTICLE_FORM completed; sections=2; accepted=3; provider calls=6; export=${artifacts[0].relative_path}`)
  } finally { await f.close() }
})

test('new narrative can cite original_task without explicit answers, as a bound author source rather than an occurred story event', async () => {
  const f = await fixture('narrative', 'task-only')
  try {
    let timer
    await Promise.race([f.arrived, f.promise.then(() => { throw new Error('writer failed: ' + JSON.stringify(f.repo.getRun(f.runId))) }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('writer request timeout')), 8000) })]).finally(() => clearTimeout(timer))
    if (f.failure()) throw f.failure()
    const facts = f.repo.getNarrativeFacts(f.config.sessionId)
    assert.equal(facts.length, 1)
    assert.equal(facts[0].canonicalStatement, f.config.grillMe.originalTask)
    assert.deepEqual(facts[0].sourceSlotIds, ['original_task'])
    assert.equal(facts[0].sources[0].sourceType, 'user')
    assert.equal(facts[0].sources[0].sourceHash, hash(f.config.grillMe.originalTask))
    assert.deepEqual(facts[0].entities, [])
    assert(f.writerMessages[0].some(message => message.content.includes('source:original_task')))
    assert.equal(f.repo.getManuscriptSegmentsByRun(f.runId).filter(row => row.status === 'accepted').length, 0)
    assert(!f.config.sceneContracts.contracts[0].mustHappen.includes(f.config.grillMe.originalTask))
  } finally { await f.close() }
})

test('a first-section response reaching the whole target cannot skip the later method section in the exported manuscript', async () => {
  const f = await fixture('expository', 'overflow')
  try {
    await f.promise
    if (f.failure()) throw f.failure()
    assert.equal(f.repo.getRun(f.runId).status, 'completed')
    const rows = f.repo.getManuscriptSegmentsByRun(f.runId).filter(row => row.status === 'accepted')
    assert.deepEqual(rows.map(row => row.section_id), ['sec-known', 'sec-known', 'sec-action'])
    const excluded = f.repo.getRunEvidence(f.runId, 'writing_section_overflow:' + rows[0].source_turn_id)
    assert(excluded, 'the oversized current-section draft was isolated before acceptance')
    assert(JSON.parse(excluded.json).excludedContent.includes('最初的屏幕'))
    const artifacts = f.repo.getArtifactsByRun(f.runId)
    assert.equal(artifacts.length, 1)
    const text = await fs.readFile(artifacts[0].relative_path, 'utf8')
    assert.equal(text, formattedArticle)
    assert(text.includes('不是你此刻还要等15分钟'))
    assert(!text.includes('最初的屏幕'))
    assert.deepEqual(f.calls, ['writer', 'critic', 'writer', 'critic', 'writer', 'critic'])
    console.log(`ARTICLE_OVERFLOW completed; ${cp(text)} characters; later method in file; exports=1; export=${artifacts[0].relative_path}`)
  } finally { await f.close() }
})

test('cold recovery keeps the same author agreement, accepted prefix and unresolved purpose without replaying its previous review', async () => {
  const f = await fixture('expository', 'recovery')
  try {
    let timer
    await Promise.race([f.held, f.promise.then(() => { throw new Error('run stopped before recovery') }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('recovery boundary timeout')), 8000) })]).finally(() => clearTimeout(timer))
    await f.restart()
    if (f.failure()) throw f.failure()
    assert.equal(f.repo.getRun(f.runId).status, 'completed')
    f.writerMessages.forEach(assertAgreements)
    const scope = messages => messages.find(message => message.content.startsWith('## 本轮正文节范围')).content
    assert.equal(scope(f.writerMessages[1]), scope(f.writerMessages[2]))
    assert(JSON.stringify(f.writerMessages[2]).includes(firstArticle.split('\n\n')[0]))
    assert.equal(f.calls.filter(type => type === 'critic').length, 3, 'accepted first candidate and coverage receipt are not re-reviewed')
    const artifacts = f.repo.getArtifactsByRun(f.runId)
    assert.equal(artifacts.length, 1)
    assert.equal(await fs.readFile(artifacts[0].relative_path, 'utf8'), formattedArticle)
  } finally { await f.close() }
})

test('disabled critic does not gain a paid review dependency', async () => {
  const f = await fixture('expository', 'no-critic', false)
  try {
    await f.promise
    if (f.failure()) throw f.failure()
    assert.equal(f.repo.getRun(f.runId).status, 'completed')
    assert.deepEqual(f.calls, ['writer', 'writer'])
    f.writerMessages.forEach(assertAgreements)
    assert.equal(f.repo.getArtifactsByRun(f.runId).length, 1)
    assert(!f.events.some(event => event.title === '本节覆盖意见' && event.detail.includes('目的已覆盖')))
    assert(f.events.some(event => event.title === '本节按篇幅推进' && event.detail.includes('未启用审校')))
  } finally { await f.close() }
})

test('coverage source/identity and legacy rhetorical handling stay distinct from fact verification', () => {
  const request = { sectionId: 's1', outlineHash: 'outline', title: '说明', purpose: '解释等待', requirements: ['不要猜恢复时间'], sourceSlotIds: ['original_task'], acceptedPrefix: '已知区间。', prefixHash: hash('已知区间。') }
  const candidate = '没有恢复时间。'
  const raw = { sectionId: 's1', outlineHash: 'outline', candidateHash: hash(candidate), prefixHash: request.prefixHash, status: 'covered', quote: candidate, reason: '覆盖意见' }
  assert.equal(api.validateSectionCoverage(raw, request, candidate).status, 'covered')
  for (const change of [{ quote: '别节的原文。' }, { candidateHash: hash('旧候选') }, { prefixHash: hash('变动前文') }, { sectionId: 'other' }]) assert.equal(api.validateSectionCoverage({ ...raw, ...change }, request, candidate).status, 'unavailable')
  assert.equal(api.validateSectionCoverage(undefined, request, candidate).status, 'unavailable')
  const large = api.sectionReviewForModel({ ...request, acceptedPrefix: '甲'.repeat(2100) + '中间不该回灌'.repeat(3000) + '乙'.repeat(2100) })
  assert.equal(large.prefixTruncated, true)
  assert.equal(large.acceptedExcerpts.reduce((n, excerpt) => n + cp(excerpt.text), 0), 4000)
  assert(!JSON.stringify(large).includes('中间不该回灌'))
  const snapshot = api.buildStrongConstraintSnapshot({ runMode: 'longwrite', phase: 'execute', task: '说明交通信息。', story: null, settings: {}, visible: { enabled: true, themeLockMode: 'off', expressionFreedom: 'controlled', antiMoralizingEnabled: true, genre: '说明文', avoid: '编造恢复时间' } })
  const explanation = '这告诉我们，通知没有给出恢复时间。我们应该把未知条件留在判断里。'
  assert(api.evaluateStrongConstraints(snapshot, explanation, explanation, { atTarget: true }).violations.some(item => item.code === 'preachy_ending'))
  assert(!api.evaluateStrongConstraints(snapshot, explanation, explanation, { atTarget: true, writingForm: 'expository' }).violations.some(item => item.code === 'preachy_ending'))
  assert(api.evaluateStrongConstraints(snapshot, '编造恢复时间。', '编造恢复时间。', { atTarget: true, writingForm: 'expository' }).violations.some(item => item.code === 'forbidden_expression' && item.severity === 'hard'))
})

test('author agreement keeps shared-wording slot provenance, and does not turn task fallback or not-applicable into repeated author quotes', () => {
  const task = '请说明怎样读停运通知。'
  const shared = '保留未知条件，不替通知推断。'
  const config = { grillMe: { writingForm: 'expository', originalTask: task, answers: [
    { slotId: 'audience', value: shared, source: 'user' }, { slotId: 'tone', value: shared, source: 'assumption' },
    { slotId: 'focus', value: task, source: 'task' }, { slotId: 'conflict', value: '不适用', source: 'not_applicable' }
  ] } }
  const prompt = api.authorAgreementPrompt(config)
  assert.equal(prompt.split(shared).length - 1, 1)
  assert.equal(prompt.split(task).length - 1, 1)
  assert(prompt.includes('audience · 作者原话；tone · 已确认假设'))
  assert(!prompt.includes('conflict')); assert(!prompt.includes('focus'))
})

test('editorial delivery adds only missing section paragraph breaks; continuations, existing newlines and legacy prose are preserved', () => {
  const config = { grillMe: { writingForm: 'expository' } }
  const render = pieces => api.editorialManuscriptMarkdown(config, pieces.map(([sectionId, content]) => ({ sectionId, content })))
  assert.equal(render([['a', '句'], ['a', '末。'], ['b', '下节。']]), '句末。\n\n下节。')
  assert.equal(render([['a', '上节。\n'], ['b', '\n下节。']]), '上节。\n\n下节。')
  assert.equal(render([['a', '上节。\n\n'], ['b', '下节。']]), '上节。\n\n下节。')
  assert.equal(render([['a', '上节。'], ['b', '\n\n下节。']]), '上节。\n\n下节。')
  assert.equal(render([['a', '上节。\r\n'], ['b', '\r\n下节。']]), '上节。\r\n\r\n下节。')
  const pieces = [{ sectionId: 'a', content: '旧稿。' }, { sectionId: 'b', content: '续句。' }]
  assert.equal(api.editorialManuscriptMarkdown({}, pieces), '旧稿。续句。')
  assert.equal(api.editorialManuscriptMarkdown({ grillMe: { writingForm: 'narrative' } }, pieces), '旧稿。续句。')
  const bad = api.projectTerminalAssistant({ getTurnsByRun: () => [{ role: 'assistant', content: '原稿。' }], getSessionMessages: () => [],
    appendSessionMessage: () => assert.fail('tampered artifact cannot overwrite a preview'), getDeliveredManuscript: () => ({ content: '变动内容。', hash: hash('原稿。'), charCount: cp('变动内容。') }) }, 'run', 'session', 'completed')
  assert.equal(bad.ok, false)
})

