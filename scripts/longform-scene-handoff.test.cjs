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
    export {createContextService} from './src/main/contextService'; export {makeManuscriptSegment} from './src/main/manuscript';
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

const cp = value => Array.from(value).length
const actions = [['掸落', '袖口灰尘'], ['抵达', '灯塔'], ['抹净', '窗沿水迹'], ['拢齐', '桌边纸页'],
  ['掩严', '值班室门缝'], ['拂去', '椅背水珠'], ['展平', '旧报纸'], ['按住', '窗台木尺']]
const ending = index => `23:${String(10 + index).padStart(2, '0')}，林舟停在北窗旁，右手捏着铜钥匙；墙上的挂钟仍慢两分钟。`
const beat = index => `林舟${actions[index].join('')}。`
function sceneProse(index) {
  const paragraphs = specimen.candidate.split('\n\n')
  const rotated = [...paragraphs.slice(index * 2), ...paragraphs.slice(0, index * 2)]
  const selected = [`随后${beat(index)}`]
  for (const paragraph of rotated) {
    selected.push(paragraph)
    if (cp(selected.join('\n\n')) >= 1540) break
  }
  if (index === 1) selected.push('林舟打开记录本。')
  selected.push(ending(index))
  return selected.join('\n\n')
}
const prose = actions.map((_, index) => sceneProse(index))
// Independent final-scene mock prose: the completion gate must not be made
// green by weakening repetition detection on recycled fixture background.
prose[7] = `随后林舟按住窗台木尺。

尺子的缺口卡着一粒细小的石子。他用指甲拨了两下，石子滚到玻璃旁，留下一个发白的小坑。窗外已经能看清防波堤的末端，那根斜着的系船柱露出半截，柱脚被退下的海水围出一圈泡沫。

隔壁传来杯底碰碟子的脆响。顾岚把剩下的茶水倒进盆里，盆沿挂着一片没有洗净的茶叶。她没有叫他过去，只把一张折好的纸放在过道的凳子上，纸角伸出凳面，正对着窗边吹来的风。

林舟看见纸张动了，却没有立刻松手。木尺下压着窗框里松出来的一块铁皮，手一抬，那块铁皮就会翘起来，刮在窗扇的底边。他用另一只手把石子推回去，垫进尺子和窗框之间，试着抽出两根手指。

铁皮稳住了。他站了一会儿，等下一阵风真正推到玻璃上。窗扇向里晃了晃，没有再响。他这才走到凳子旁，捏住纸张的短边，避开一道还湿着的铅笔线，将整张纸转了半圈。

纸背留着一个圆形杯印。圈内有三行小字，笔画沿着旧折痕断开，最末一行的年份被擦过，留下几根细长的纸纤维。他沿折痕轻轻展开，不去揉平杯印，先把已经卷起的右下角压在掌心里。

顾岚从门边经过，脚上的布鞋换成了一双褪色的胶靴。鞋帮没有提好，她走到铁梯上才停下来，弯腰扯了扯。林舟隔着栏杆看见她的肩膀抬起又落下，楼下有人拖动一只空桶，桶沿撞着台阶。

他没有追着问。纸上的墨迹有一处散开了，像被水指头按过。旁边空着一格，格子下面的横线画得太重，纸背也能摸到凹下去的一条。他把拇指移到白边，只让食指托住那块薄纸，免得把它戳穿。

塔外的汽笛响过一声。声音先压进右耳，又从背后的门洞里折回来，低了一截。他听出那不是远处的大船，声尾没有拖长，近岸的小艇正离开堤头。他朝窗外看了看，玻璃上的盐霜被晨光照成浅黄色。

顾岚回到门口时，手里多了一卷干布。她把布卷放在地板上，用鞋尖抵住它，撕开外层的纸封。纸封裂得很长，响声一停，过道里就只剩两个人的呼吸。她从布卷上剪下一段，搁在凳子的另一端。

林舟没有把纸交还。他用那段干布包住纸的折口，先折进去短边，再把较长的一角压在外面。这样纸张就不直接碰他的外套内衬。衣袋的扣子很紧，他拇指顶了两次才扣好，指腹上留下一条白印。

北窗又动了一下。木尺仍压在原处，石子没有滚出来。他和顾岚同时转头看了过去，谁也没有伸手。堤上的人开始解缆，粗绳在石面上拖出一条深色水迹，水迹慢慢变窄，最后停在窗框投下的影子外面。

“走吧。”顾岚说。她侧身让出窄窄的一道门缝，没有再往他的衣袋上看。林舟把空着的右手从兜边移开，扶住铁栏杆，脚掌在第一层台阶上压实，才往下走。两人的脚步没有踩在同一个拍子上。

${ending(7)}`
const paragraphs = prose[1].split('\n\n'), cut = Math.floor(paragraphs.length / 2)
const firstHalf = paragraphs.slice(0, cut).join('\n\n')
const secondHalf = paragraphs.slice(cut).join('\n\n')
// Each provider fragment is boundary-normalized before acceptance. Use that
// exact canonical manuscript, not a separator that the provider never emits.
prose[1] = firstHalf + secondHalf
const target = prose.reduce((sum, text) => sum + cp(text), 0)

function semanticEvidence(body) {
  const review = body.sceneBeatReview
  assert.equal(body.candidateHash, hash(body.candidate))
  if (!review) return undefined // Post-scene closure retains style review, not a fabricated scene proof.
  return { semanticVersion: 2, contractHash: review.contractHash, candidateHash: body.candidateHash, scenePrefixHash: review.scenePrefixHash,
    beats: review.requiredBeats.map(required => {
      const index = actions.findIndex((_, index) => required.requiredSource === beat(index))
      const predicate = index < 0 ? '打开' : actions[index][0], patient = index < 0 ? '记录本' : actions[index][1]
      const quote = index < 0 ? '林舟打开记录本。' : `随后${beat(index)}`
      const source = body.candidate.includes(quote) ? 'candidate' : review.scenePrefix.includes(quote) ? 'scene_prefix' : null
      return { beatId: required.beatId, status: source ? 'satisfied' : 'missing',
        partEvidence: required.parts.map(part => ({ partId: part.partId, status: source ? 'satisfied' : 'missing', spanIndexes: source ? [0] : [] })),
        ...(source ? { spans: [{ source, text: quote }], semanticEvents: [{ spanIndex: 0, partIds: required.parts.map(part => part.partId), predicate,
          agent: ['林舟'], patient: [patient], agentBindings: [{ name: '林舟', relation: 'explicit', mention: { spanIndex: 0, text: '林舟' } }],
          actuality: 'asserted_actual', assertion: 'asserted', negation: false }] } : {}) }
    }) }
}

async function runScenario(shortClosing) {
  assert(target > 12000)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-scene-handoff-'))
  const dbPath = path.join(dir, 'run.db'), workDir = path.join(dir, 'work'), docDir = path.join(dir, 'documents')
  await Promise.all([fs.mkdir(workDir), fs.mkdir(docDir)])
  let repo = api.createRepository(dbPath); repo.open()
  const count = shortClosing ? 2 : 8
  const requested = shortClosing ? prose.slice(0, count).reduce((sum, value) => sum + cp(value), 0) + 7 : target
  const runId = shortClosing ? 'scene-closing-production' : 'scene-handoff-production', sessionId = runId + '-session'
  let config, store, engine, failed, heldWire, resumedWire, held = false, writers = 0
  const wireSets = [], scopes = []
  let signalHeld
  const reached = new Promise(resolve => { signalHeld = resolve })
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      try {
        const wire = JSON.parse(raw)
        const user = wire.messages.find(message => message.role === 'user' && message.content.startsWith('{"candidateHash"'))
        let text, finish = 'stop'
        if (user) {
          const body = JSON.parse(user.content)
          text = JSON.stringify({ schemaVersion: 1, anchorMode: 'exact_quote', candidateHash: body.candidateHash, issues: [], sceneBeatEvidence: semanticEvidence(body) })
        } else {
          writers++
          for (const forbidden of ['废弃重试绝不可作为正文', '旧任务改写成科幻飞船', '旧的无场景残句不能接入补尾']) assert(!JSON.stringify(wire.messages).includes(forbidden))
          const scope = wire.messages.find(message => message.content.includes('## scene_contract'))?.content.match(/场景：(scene:s\d+)/u)?.[1]
          if (!scope) {
            assert(shortClosing, 'the fixed longform sample should complete at its original exact boundary')
            assert(repo.getSceneStates(runId).every(state => state.lifecycle === 'committed'))
            const prompt = wire.messages.find(message => message.content.includes('## scene_contract')).content
            assert(prompt.includes('所有已确认场景均已提交'))
            assert(prompt.includes('[manuscript-tail:')); assert(prompt.includes(ending(count - 1)))
            scopes.push('closing')
            text = '潮声从门洞里退下去，林舟捏了捏已经暖起来的指尖。'
          } else {
            const index = config.sceneContracts.contracts.findIndex(contract => contract.sceneId === scope)
            assert(index >= 0)
            const currentAccepted = repo.getManuscriptSegmentsByRun(runId).filter(row => row.status === 'accepted' && row.scene_id === scope)
            const workingSet = wire.messages.find(message => message.content.includes('## recent_tail'))?.content ?? ''
            assert(!wire.messages.some(message => message.content.includes('## 最近正文尾部') || message.content.includes('durable 章节摘要')))
            const recent = workingSet.split('## recent_tail\n')[1]?.split('\n\n## ')[0] ?? ''
            if (index > 0 && !currentAccepted.length) {
              assert(recent.includes(ending(index - 1)), 'new scene must see the exact immediately preceding ending')
              assert(recent.includes('[previous-scene:scene:s' + index))
              assert(recent.includes('commit:')); assert(recent.includes('segment:')); assert(recent.includes('source:'))
              assert(cp(recent) < 1200, 'new-scene continuity excerpt stays bounded as manuscript grows')
            }
            if (index === 1 && currentAccepted.length) {
              assert(recent.includes('[current-scene:'))
              assert(recent.includes(currentAccepted[0].content.slice(-200)))
              assert(!recent.includes('[previous-scene:'))
              if (!held) {
                held = true; heldWire = wire.messages; signalHeld()
                return // Pause before any response text; the aborted request is not an accepted draft.
              }
              resumedWire = wire.messages
              assert.deepEqual(resumedWire, heldWire, 'same source/candidate boundary after cold engine/repository recovery')
            }
            wireSets.push({ scope, recentChars: cp(recent), inputChars: cp(JSON.stringify(wire.messages)) })
            scopes.push(scope)
            text = index === 1 ? currentAccepted.length ? secondHalf : firstHalf : prose[index]
            if (index === 1 && !currentAccepted.length) finish = 'length'
          }
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) + '\n\ndata: [DONE]\n\n')
      } catch (error) { failed = error; signalHeld(); response.writeHead(500); response.end('local fixture failed') }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const outline = { title: '北窗守夜', premise: '林舟在灯塔守夜，接续已经发生的现场行动。', targetChars: requested,
    sections: actions.slice(0, count).map((_, index) => ({ id: 's' + (index + 1), title: '第' + (index + 1) + '场', purpose: '承接上一场现场行动，继续守夜。',
      targetChars: cp(prose[index]), beats: [beat(index), ...(index === 1 ? ['林舟打开记录本。'] : [])], sourceSlotIds: [] })) }
  config = api.buildExecutionSnapshot({ payload: { id: runId, mode: 'longwrite', phase: 'execute', longMode: true, targetChars: requested,
    text: `按已确认${count}场大纲完成守夜小说。`,
    strongConstraints: { enabled: true, level: 'balanced', themeLockMode: 'off', expressionFreedom: 'high', antiMoralizingEnabled: true, perspective: 'auto', genre: '小说' },
    grillMe: { stateId: runId + '-grill', originalTask: '写灯塔守夜小说。', targetChars: requested, answers: [], assumptions: [], approvedOutline: outline, outlineRevision: 1, outlineHash: api.grillMeOutlineHash(outline) } }, sessionId,
    settings: { model: 'local-handoff', baseUrl, maxTokens: 4096, temperature: .7, topP: 1, thinkingEnabled: false, reasoningEffort: 'high', workDir, docDir,
      novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000, completionTokenBudget: 1000000,
      completionWallClockMs: 60000, strongConstraintEnabled: true, themeLockMode: 'off', expressionFreedom: 'high', antiMoralizingEnabled: true },
    memory: { projectPath: '', projectContent: '', userContent: '' } })
  config.longwrite_v2 = true
  config.sceneRecallTopK = 1
  config.providerCallBudget = { maxCalls: 30, maxTokens: 1000000, maxCost: null, maxCostCny: null, maxWallClockMs: 60000 }
  config.completionContract.providerCallBudget = config.providerCallBudget
  const setup = () => {
    store = api.createRunStorePort(repo, path.join(dir, 'artifacts'))
    const context = api.createContextService(repo)
    const adapter = api.createModelCallAdapter({ getConfig: () => config, getSignal: id => engine.abortSignal(id), buildPrefix: async rc => rc.frozenSystemMessages,
      assembleContext: (...args) => context.assembleRunContext(...args),
      getApi: () => ({ apiKey: '', baseUrl, model: 'local-handoff', maxTokens: 4096, temperature: .7, topP: 1, thinking: { enabled: false, effort: 'high' },
        pricing: null, supportsTools: false, protocol: 'deepseek-chat', adapterId: 'builtin.deepseek', chatPath: '/chat/completions', authStyle: 'none',
        transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } }) })
    engine = api.createAgentRunEngine({ store, getConfig: () => config, modelCall: adapter, toolExecutor: async () => '',
      publishLongwriteArtifact: api.publishCliManuscript, onEvent: () => {}, onRunUpdate: () => {} })
  }
  setup()
  try {
    assert.equal((await engine.start({ runId, sessionId, config })).ok, true)
    await store.appendTurn({ turnId: 'old-user', runId, turnSeq: 1, role: 'user', content: '旧任务改写成科幻飞船', createdAt: 1 })
    const rejected = '废弃重试绝不可作为正文。'
    await store.saveAssistantTurnWithSegment({ turnId: 'rejected-draft', runId, turnSeq: 2, role: 'assistant', content: rejected, createdAt: 2 },
      api.makeManuscriptSegment({ runId, sessionId, turnId: 'rejected-draft', chunkIndex: 2, content: rejected, status: 'rejected', kind: 'prose', createdAt: 2 }))
    await store.saveAssistantTurnWithSegment({ turnId: 'old-unscoped-partial', runId, turnSeq: 3, role: 'assistant', content: '旧的无场景残句不能接入补尾', createdAt: 3 },
      api.makeManuscriptSegment({ runId, sessionId, turnId: 'old-unscoped-partial', chunkIndex: 3, content: '旧的无场景残句不能接入补尾', status: 'partial', kind: 'prose', createdAt: 3 }))
    await store.appendTurn({ turnId: 'actual-user', runId, turnSeq: 4, role: 'user', content: `按确认的${count}场大纲写完守夜小说。`, createdAt: 4 })
    const first = engine.step(runId)
    let timer
    await Promise.race([reached, first.then(() => { throw new Error('run stopped before the recovery boundary: ' + JSON.stringify(repo.getRun(runId))) }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('recovery boundary timeout')), 15000) })]).finally(() => clearTimeout(timer))
    if (failed) throw failed
    await engine.pause(runId); await first
    assert.equal(repo.getRun(runId).status, 'waiting_user')
    const beforeAccepted = repo.getManuscriptSegmentsByRun(runId).filter(row => row.status === 'accepted').map(row => [row.segment_id, row.content_hash])
    repo.close(); repo = api.createRepository(dbPath); repo.open(); setup()
    await engine.restore(runId)
    await engine.step(runId)
    if (failed) throw failed
    const run = repo.getRun(runId)
    assert.equal(run.status, 'completed', JSON.stringify({ code: run.error_code, message: run.error_message, scopes }))
    assert(resumedWire)
    const rows = repo.getManuscriptSegmentsByRun(runId), accepted = rows.filter(row => row.status === 'accepted' && row.kind === 'prose')
    for (const [id, contentHash] of beforeAccepted) assert(accepted.some(row => row.segment_id === id && row.content_hash === contentHash), 'cold resume keeps the exact accepted prefix')
    assert.equal(repo.getSceneStates(runId).filter(state => state.lifecycle === 'committed').length, count)
    const manuscript = accepted.sort((a, b) => a.chunk_index - b.chunk_index).map(row => row.content).join('')
    assert(!manuscript.includes('旧的无场景残句不能接入补尾'))
    if (shortClosing) {
      assert(manuscript.startsWith(prose.slice(0, count).join('')))
      assert(cp(manuscript) >= requested && cp(manuscript) <= requested + 1024)
      assert(scopes.filter(scope => scope === 'closing').length <= 3, 'natural closing stays within ordinary bounded retries')
    } else {
      assert.equal(accepted.length, 9); assert.equal(writers, 10)
      assert.equal(manuscript, prose.join('')); assert.equal(cp(manuscript), target)
    }
    const artifacts = repo.getArtifactsByRun(runId)
    assert.equal(artifacts.length, 1); assert.equal(await fs.readFile(artifacts[0].relative_path, 'utf8'), manuscript)
    assert.equal(artifacts[0].char_count, cp(manuscript))
    assert(wireSets.every(item => item.inputChars < 30000), 'writer inputs stay bounded instead of appending the full manuscript')
    const calls = writers
    await assert.rejects(engine.step(runId), /终态/u)
    assert.equal(writers, calls); assert.equal(repo.getArtifactsByRun(runId).length, 1)
    console.log(`V2_HANDOFF completed=${cp(manuscript)}/${requested} chars; scenes=${count}; accepted=${accepted.length}; writer HTTP=${writers} (one aborted then cold-resumed); max writer input=${Math.max(...wireSets.map(item => item.inputChars))} chars; export=${artifacts[0].relative_path}`)
  } finally { repo.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}

test('v2 delivers 12K+ with eight source-bound scene handoffs and byte-identical live/cold-resume input', () => runScenario(false))
test('v2 preserves confirmed commits and original target when only seven characters remain, naturally closes and exports once', () => runScenario(true))

