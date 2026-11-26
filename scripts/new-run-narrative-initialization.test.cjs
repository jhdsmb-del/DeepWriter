const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { before, test } = require('node:test')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const hash = text => createHash('sha256').update(text).digest('hex')
const cp = text => [...text].length
let api
before(async () => {
  const { desktopSourceExternals } = await import('./desktop-source-boundary.mjs')
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    export {startChatRun} from './src/main/chatStart';
    export {buildExecutionSnapshot} from './src/main/executionSnapshot';
    export {createRepository} from './src/main/db/repository';
    export {createRunStorePort,createModelCallAdapter} from './src/main/runKernelAdapter';
    export {createContextService} from './src/main/contextService';
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {buildCriticMessages,parseCriticReport,prepareCriticFormatRepair,prepareCriticSemanticRepair,parseCorrectedCriticReport} from './src/main/writingPipeline';
    export {grillMeOutlineHash} from './src/shared/grillMe';
    export {publishCliManuscript} from './src/cli/manuscript';
    export {buildNarrativeFactsFromGrill,narrativeFactProvenanceHash} from './src/main/narrative/factRegistry';
    export {readSceneBeatRepairLedger} from './src/main/narrative/sceneBeatRepair';
    export {deriveSceneBeatRequiredParts,isOpaqueSceneBeatRequirement,sceneContractPlanValid,evaluateSceneContract} from './src/main/narrative/sceneContract';
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent',
    external: desktopSourceExternals(root, ['node:sqlite']),
    plugins: [{ name: 'isolated-source', setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'isolated-electron' }))
      build.onLoad({ filter: /.*/, namespace: 'isolated-electron' }, () => ({ loader: 'js', contents: `
        export const app={getPath:name=>name,isPackaged:false};
        export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]}),showSaveDialog:async()=>({canceled:true})};
        export const safeStorage={isEncryptionAvailable:()=>false,encryptString:()=>null,decryptString:()=>''};
        export const ipcMain={handle:()=>{},on:()=>{}};
        export const shell={openExternal:()=>{},openPath:async()=>''};
        export const clipboard={writeText:()=>{}};
        export const Menu={buildFromTemplate:()=>({popup:()=>{}})};
      ` }))
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

const tail = [
  '值班室的灯罩上结着薄薄一层盐霜。林舟把围巾留在椅背，站在桌旁听了一会儿，楼梯那边没有脚步声，只有风从门缝里低低地穿过。墙上的钟慢了两分钟，他没有伸手去拨。',
  '桌上放着一本翻开的记录本，纸边已经起毛。他把那一页压平，又将窗边的椅子拉近半步；椅脚摩擦地板的声音显得很响。他停下来，等声音落下，才说了一句：“还没有人回来。”',
  '窗外的海看不清岸线，灯塔的光绕过一圈，玻璃上短暂浮出他的倒影。他没有再看钟。门仍留着一条窄缝，冷风吹动椅背上的围巾，布角一下一下碰着木板。'
].join('\n\n')
const original = `林舟在灯塔值班室的桌边停住，外套的下摆滴着水。\n\n${tail}`
const revised = `林舟抵达灯塔，走进值班室，在桌边停住，外套的下摆滴着水。\n\n${tail}`

function defaultSceneCriticFixture(body) {
  const review = body.sceneBeatReview
  if (!review) return undefined
  const quote = '林舟抵达灯塔', satisfied = body.candidate.includes(quote)
  return { semanticVersion: 2, contractHash: review.contractHash, candidateHash: body.candidateHash,
    scenePrefixHash: review.scenePrefixHash, beats: review.requiredBeats.map(beat => ({
      beatId: beat.beatId, status: satisfied ? 'satisfied' : 'missing',
      partEvidence: beat.parts.map(part => ({ partId: part.partId, status: satisfied ? 'satisfied' : 'missing', spanIndexes: satisfied ? [0] : [] })),
      ...(satisfied ? { quote, quoteSource: 'candidate', semanticEvents: [{ spanIndex: 0,
        partIds: beat.parts.map(part => part.partId), predicate: '抵达', agent: ['林舟'], patient: ['灯塔'],
        agentBindings: [{ name: '林舟', relation: 'explicit', mention: { spanIndex: 0, text: '林舟' } }],
        actuality: 'asserted_actual', assertion: 'asserted', negation: false }] } : {})
    })) }
}

async function fixture(name, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-new-run-narrative-'))
  const workDir = path.join(temp, 'work'), docDir = path.join(temp, 'documents')
  await Promise.all([fs.mkdir(workDir), fs.mkdir(docDir)])
  const runId = `new-run-${name}`, sessionId = `${runId}-session`, target = options.target ?? cp(revised)
  const outline = options.outline ?? { title: '值班室', premise: '林舟独自到灯塔守夜。', targetChars: target,
    sections: [{ id: 's1', title: '灯塔值班室', purpose: '通过具体行动建立守夜起点。', targetChars: target,
      beats: ['林舟抵达灯塔。'], sourceSlotIds: ['goal'] }] }
  const answers = [{ slotId: 'goal', value: '林舟抵达灯塔，在值班室守夜。', source: 'user' },
    { slotId: 'setting', value: '海边灯塔的值班室，同一晚。', source: 'user' }]
  const payload = { id: runId, sessionId, mode: 'longwrite', workspace: 'novel', phase: 'execute', longMode: true,
    targetChars: target, text: options.task ?? '请按确认的大纲写林舟在灯塔守夜的小说。',
    grillMe: { stateId: `${runId}-grill`, originalTask: options.task ?? '写灯塔守夜小说。', targetChars: target, answers,
      assumptions: [], approvedOutline: outline, outlineRevision: 1, outlineHash: api.grillMeOutlineHash(outline) },
    strongConstraints: { enabled: true, level: 'balanced', themeLockMode: 'off', expressionFreedom: 'high', antiMoralizingEnabled: true, perspective: 'auto', genre: '小说' } }
  const config = api.buildExecutionSnapshot({ payload, sessionId,
    settings: { model: 'fake-new-run', baseUrl: 'http://127.0.0.1:9', maxTokens: 4096, temperature: 0.7, topP: 1,
      thinkingEnabled: false, reasoningEffort: 'high', workDir, docDir, novelMode: false,
      galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000,
      completionTokenBudget: 100000, completionWallClockMs: 300000, strongConstraintEnabled: true,
      themeLockMode: 'off', expressionFreedom: 'high', antiMoralizingEnabled: true, strongConstraintPerspective: 'auto',
      strongConstraintGenre: '小说', strongConstraintMustKeep: '', strongConstraintAvoid: '' },
    memory: { projectPath: '', projectContent: '', userContent: '' } })
  const repo = api.createRepository(path.join(temp, 'run.db')); repo.open()
  const store = api.createRunStorePort(repo, path.join(temp, 'artifacts'))
  const policyKind = `scene_beat_repair:${config.sceneContracts.contracts[0].sceneId}`
  const calls = [], starts = [], boundaries = []
  let writerCount = 0, stepPromise = null
  const engine = api.createAgentRunEngine({ store, getConfig: () => config, toolExecutor: async () => '',
    publishLongwriteArtifact: api.publishCliManuscript, onEvent: () => {}, onRunUpdate: () => {},
    modelCall: async request => {
      const purpose = request.purpose || 'writer'; calls.push(purpose)
      const facts = repo.getNarrativeFacts(sessionId), policy = repo.getRunEvidence(runId, policyKind)
      assert.equal(facts.filter(fact => fact.status === 'active').length, answers.length, 'confirmed durable facts must precede the first Provider call even without structured context')
      assert(policy, 'scene repair policy must precede the first Provider call')
      boundaries.push({ purpose, facts: facts.map(fact => fact.canonicalHash), policy: policy.json,
        accepted: repo.getManuscriptSegmentsByRun(runId).filter(row => row.status === 'accepted').length })
      if (options.modelCall) return options.modelCall(request, { repo, config })
      let text
      if (purpose === 'writer') text = ++writerCount === 1 ? original : revised
      else {
        assert.equal(purpose, 'critic')
        const body = JSON.parse(request.messages.find(message => message.role === 'user').content)
        text = JSON.stringify({ schemaVersion: 1, anchorMode: 'exact_quote', candidateHash: body.candidateHash, issues: [], sceneBeatEvidence: defaultSceneCriticFixture(body) })
      }
      return { async *[Symbol.asyncIterator]() { yield { type: 'text', delta: text }; yield { type: 'finish', finishReason: 'stop' } } }
    } })
  const deps = { repository: options.repository ? options.repository(repo) : repo,
    loadSettings: async () => ({ model: 'fake-new-run' }), buildConfig: async () => config,
    runKernel: { start: async args => { starts.push(args); if (options.beforeStart) await options.beforeStart({ args, repo, store, config, policyKind }); return engine.start(args) },
      step: id => { stepPromise = options.noStep ? Promise.resolve() : engine.step(id); return stepPromise } } }
  return { temp, repo, store, engine, deps, payload, config, runId, sessionId, answers, policyKind, calls, starts, boundaries,
    run: () => repo.getRun(runId), policy: () => repo.getRunEvidence(runId, policyKind), wait: () => stepPromise }
}

test('actual shared accepted-new-run materializes original facts and bounded repair policy before Provider; only reviewed revision is published', async () => {
  const f = await fixture('shared-path')
  try {
    const ack = await api.startChatRun(f.deps, f.payload); await f.wait()
    assert.equal(ack.idempotent, false); assert.equal(f.starts[0].alreadyCreated, true); assert.equal(f.starts[0].newlyAccepted, true)
    assert.deepEqual(f.calls, ['writer', 'critic', 'writer', 'critic'])
    assert.equal(f.run().status, 'completed')
    const facts = f.repo.getNarrativeFacts(f.sessionId)
    assert.deepEqual(facts.map(fact => [fact.sourceSlotIds[0], fact.canonicalStatement]).sort(), f.answers.map(answer => [answer.slotId, answer.value]).sort())
    assert(facts.every(fact => fact.runId === f.runId && fact.version === 1 && fact.status === 'active' && fact.canonicalHash === hash(fact.canonicalStatement)))
    assert(f.boundaries.every(boundary => boundary.accepted === 0))
    const rows = f.repo.getManuscriptSegmentsByRun(f.runId), accepted = rows.filter(row => row.status === 'accepted')
    assert.equal(accepted.length, 1); assert.equal(accepted[0].content, revised)
    assert(rows.some(row => row.status === 'rejected' && row.content === original))
    const artifacts = f.repo.getArtifactsByRun(f.runId)
    assert.equal(artifacts.length, 1); assert.equal(await fs.readFile(artifacts[0].relative_path, 'utf8'), revised)
    assert.equal(artifacts[0].hash, hash(revised)); assert.equal(artifacts[0].char_count, cp(revised))
    const beforePolicy = f.policy().json, beforeFacts = JSON.stringify(facts)
    assert.equal(JSON.parse(beforePolicy).attempts.length, 1, 'actual bounded repair reservation is retained')
    await assert.rejects(api.startChatRun(f.deps, f.payload), /请求已结束/)
    assert.equal(f.policy().json, beforePolicy); assert.equal(JSON.stringify(f.repo.getNarrativeFacts(f.sessionId)), beforeFacts)
    assert.equal(f.starts.length, 1); assert.equal(f.calls.length, 4)
  } finally { f.repo.close() }
})

test('first writer scope keeps the full task as background and automatically advances to the next scene', async () => {
  const task = '写一篇 8000 字灯塔小说，按已确认的两场大纲完成全篇。'
  const firstTarget = cp(revised)
  const outline = { title: '值班室', premise: '林舟独自到灯塔守夜。', targetChars: 8000, sections: [
    { id: 's1', title: '抵达值班室', purpose: '通过具体行动建立守夜起点。', targetChars: firstTarget, beats: ['林舟抵达灯塔。'], sourceSlotIds: ['goal'] },
    { id: 's2', title: '查看记录本', purpose: '展开下一场守夜。', targetChars: 8000 - firstTarget, beats: ['林舟打开记录本。'], sourceSlotIds: ['setting'] }
  ] }
  const wire = []
  let adapter, activePurpose, writers = 0
  const f = await fixture('first-writer-scope', { target: 8000, task, outline, modelCall: async (request, { repo, config }) => {
    activePurpose = request.purpose || 'writer'
    if (!adapter) {
      const context = api.createContextService(repo)
      adapter = api.createModelCallAdapter({ getConfig: () => config, getSignal: () => undefined,
        getApi: () => ({ apiKey: '', baseUrl: 'http://127.0.0.1:9', model: 'fake-new-run', maxTokens: 4096,
          thinking: { enabled: false, effort: 'high' }, temperature: 0.7, topP: 1 }),
        buildPrefix: async () => config.frozenSystemMessages,
        assembleContext: (...args) => context.assembleRunContext(...args),
        streamChatImpl: async (input, onEvent) => {
          wire.push({ purpose: activePurpose, messages: structuredClone(input.messages) })
          let text
          if (activePurpose === 'writer') {
            if (++writers > 1) throw new Error('focused_scene_spy_stop') // stop after observing real automatic advancement
            text = revised
          } else {
            const body = JSON.parse(input.messages.find(message => message.role === 'user').content)
            text = JSON.stringify({ schemaVersion: 1, anchorMode: 'exact_quote', candidateHash: body.candidateHash, issues: [], sceneBeatEvidence: defaultSceneCriticFixture(body) })
          }
          onEvent({ type: 'text', delta: text }); onEvent({ type: 'done', finishReason: 'stop' })
        }
      })
    }
    return adapter(request)
  } })
  try {
    const originalOutlineHash = f.config.grillMe.outlineHash
    assert(f.config.writingPipeline && f.config.strongConstraints.enabled, 'default review and strong constraints remain enabled')
    await api.startChatRun(f.deps, f.payload); await f.wait()
    assert.deepEqual(wire.map(item => item.purpose), ['writer', 'critic', 'writer'])
    const writerCalls = wire.filter(item => item.purpose === 'writer')
    for (const [index, call] of writerCalls.entries()) {
      const contract = f.config.sceneContracts.contracts[index]
      const users = call.messages.filter(message => message.role === 'user')
      assert.equal(users.length, 1, 'the actual adapter wire must not re-append the full-task user after the scoped user')
      const content = users[0].content
      assert(content.startsWith('【全稿任务背景'))
      assert.equal(content.split('【全稿任务背景').length - 1, 1, 'scope must not be persisted and nested again on continuation')
      assert.equal(content.split('【本轮唯一正文执行范围】').length - 1, 1)
      assert(content.includes(task)); assert(content.includes('全稿目标仍为 8000 个 Unicode code point'))
      assert(content.indexOf('【本轮唯一正文执行范围】') > content.indexOf(task))
      assert(content.includes(`本轮只写 ${contract.sceneId} · ${contract.title}`))
      assert(content.includes(`本场累计范围 ${contract.targetChars.min}–${contract.targetChars.max}，理想 ${contract.targetChars.ideal}`))
      assert(content.includes(`本轮新增正文范围 ${contract.targetChars.min}–${contract.targetChars.max} 个 Unicode code point，理想 ${contract.targetChars.ideal}`))
      assert(content.includes('本场已接受 0'))
      assert(content.includes('只依赖已确认事实与已接受正文作为既成状态'))
      assert(call.messages.some(message => message.role === 'system' && message.content.includes(`场景：${contract.sceneId}`) && message.content.includes('不要解释契约')))
    }
    assert(writerCalls[0].messages.find(message => message.role === 'user').content.includes('不要提前写全篇结尾'))
    assert(writerCalls[1].messages.find(message => message.role === 'user').content.includes('这是最后一场，可在本场完成后自然收束全篇'))
    assert(writerCalls[1].messages.find(message => message.role === 'user').content.includes(`全稿已接受 ${firstTarget} 个 Unicode code point`))
    assert(f.repo.getSceneStates(f.runId).find(scene => scene.sceneId === f.config.sceneContracts.contracts[0].sceneId).lifecycle === 'committed')
    assert.equal(f.config.deepWrite.targetChars, 8000); assert.equal(f.config.completionContract.targetChars.min, 8000)
    assert.equal(f.config.grillMe.outlineHash, originalOutlineHash)
    assert.equal(f.repo.getTurnsByRun(f.runId).find(turn => turn.role === 'user').content, task, 'durable original task is unchanged')
  } finally { f.repo.close() }
})

test('semantic scene beats repair invalid packets inside the existing critic allowance without rewriting valid prose', async t => {
  const beats = ['林舟掸落记录本边缘的灰尘。', '林舟理顺围巾上的流苏。']
  const complete = `林舟抵达灯塔，走进值班室，在桌边停住。${beats.join('')}\n\n${tail}`
  const incomplete = `林舟抵达灯塔，走进值班室，在桌边停住。${beats[0]}\n\n${tail}`
  for (const mode of ['invalid-then-corrected', 'missing-then-rewrite', 'invalid-exhausted']) await t.test(mode, async () => {
    const task = '写一篇 8000 字灯塔小说，完整遵守确认事实与两场大纲。'
    const firstTarget = cp(complete)
    const outline = { title: '值班室', premise: '林舟独自到灯塔守夜。', targetChars: 8000, sections: [
      { id: 's1', title: '整理值班室', purpose: '具体完成两个整理动作。', targetChars: firstTarget, beats, sourceSlotIds: ['goal'] },
      { id: 's2', title: '查看记录本', purpose: '继续守夜。', targetChars: 8000 - firstTarget, beats: ['林舟打开记录本。'], sourceSlotIds: ['setting'] }
    ] }
    const wire = []
    let adapter, activePurpose, writers = 0
    const f = await fixture(`semantic-${mode}`, { target: 8000, task, outline, modelCall: async (request, { repo, config }) => {
      activePurpose = request.purpose || 'writer'
      if (!adapter) {
        const context = api.createContextService(repo)
        adapter = api.createModelCallAdapter({ getConfig: () => config, getSignal: () => undefined,
          getApi: () => ({ apiKey: '', baseUrl: 'http://127.0.0.1:9', model: 'fake-new-run', maxTokens: 4096,
            thinking: { enabled: false, effort: 'high' }, temperature: 0.7, topP: 1 }),
          buildPrefix: async () => config.frozenSystemMessages,
          assembleContext: (...args) => context.assembleRunContext(...args),
          streamChatImpl: async (input, onEvent) => {
            wire.push({ purpose: activePurpose, messages: structuredClone(input.messages) })
            let text
            if (activePurpose === 'writer') {
              const allowance = mode === 'missing-then-rewrite' ? 2 : 1
              if (++writers > allowance) throw new Error('focused_semantic_next_scene_stop')
              text = mode === 'missing-then-rewrite' && writers === 1 ? incomplete : complete
            } else {
              assert.equal(activePurpose, 'critic', 'semantic review adds no separate model-call purpose')
              const body = JSON.parse(input.messages.find(message => message.role === 'user').content)
              const review = body.sceneBeatReview
              assert(review, 'the real materialized critic request includes the frozen scene contract')
              assert.equal(review.requiredBeats.length, 2)
              assert.equal(review.candidateHash, body.candidateHash)
              assert.equal(review.candidateHash, hash(body.candidate))
              assert.equal(review.scenePrefixHash, hash(review.scenePrefix))
              assert.deepEqual(review.requiredBeats.map(beat => beat.requiredSource), beats)
              const criticNumber = wire.filter(item => item.purpose === 'critic').length
              const styleIssues = [{ issueId: 'q1', code: 'cliche_language', severity: 'advisory', basis: 'quality',
                quote: body.candidate, reason: 'synthetic whole-candidate style advisory', repairIntent: 'retain this advisory without broad automatic editing' }]
              if (body.formatCorrection) {
                assert.notEqual(mode, 'missing-then-rewrite', 'validated missing must not spend a critic protocol-correction slot')
                assert.equal(criticNumber, 2)
                const originalReport = JSON.parse(body.formatCorrection.invalidReport)
                assert.deepEqual(originalReport.issues, styleIssues, 'legal style findings are frozen during protocol correction')
                assert(body.formatCorrection.semanticErrors.length > 0)
                assert(body.formatCorrection.semanticErrors.some(issue => mode === 'invalid-exhausted' ? issue.reason === 'binding_invalid' : issue.reason === 'role_unanchored'))
                const firstBody = JSON.parse(wire.find(item => item.purpose === 'critic').messages.find(message => message.role === 'user').content)
                assert.equal(body.candidate, firstBody.candidate)
                assert.deepEqual(review, firstBody.sceneBeatReview, 'candidate, prefix and all three hashes stay frozen')
              } else if (mode !== 'missing-then-rewrite') assert.equal(criticNumber, 1)
              const evidence = { semanticVersion: 2, contractHash: review.contractHash,
                candidateHash: mode === 'invalid-exhausted' ? hash('wrong candidate') : body.candidateHash,
                scenePrefixHash: review.scenePrefixHash, beats: review.requiredBeats.map((beat, index) => {
                  const quote = beats[index]
                  if (!body.candidate.includes(quote)) return { beatId: beat.beatId, status: 'missing',
                    partEvidence: beat.parts.map(part => ({ partId: part.partId, status: 'missing', spanIndexes: [] })) }
                  return { beatId: beat.beatId, status: 'satisfied', quote, quoteSource: 'candidate',
                    partEvidence: beat.parts.map(part => ({ partId: part.partId, status: 'satisfied', spanIndexes: [0] })), semanticEvents: [{
                    spanIndex: 0, partIds: beat.parts.map(part => part.partId), predicate: index === 0 ? '掸落' : '理顺', agent: ['林舟'],
                    agentBindings: [{ name: '林舟', relation: 'explicit', mention: { spanIndex: 0, text: '林舟' } }],
                    patient: [mode === 'invalid-then-corrected' && criticNumber === 1 && index === 0 ? '原文不存在的灰尘条目' : index === 0 ? '灰尘' : '流苏'],
                    actuality: 'asserted_actual', assertion: 'asserted', negation: false
                  }] }
                }) }
              const returnedStyle = body.formatCorrection
                ? mode === 'invalid-then-corrected'
                  ? [{ ...styleIssues[0], severity: 'hard', code: 'explicit_forbidden', quote: 'unanchored slot-two style' },
                    { ...styleIssues[0], issueId: 'q2', code: 'invented-style-code' }]
                  : []
                : styleIssues
              text = JSON.stringify({ schemaVersion: 1, anchorMode: 'exact_quote', candidateHash: body.candidateHash,
                issues: returnedStyle, sceneBeatEvidence: evidence })
            }
            onEvent({ type: 'text', delta: text }); onEvent({ type: 'done', finishReason: 'stop' })
          }
        })
      }
      return adapter(request)
    } })
    try {
      const contract = f.config.sceneContracts.contracts[0], originalOutlineHash = f.config.grillMe.outlineHash
      assert(contract.requiredBeatEvidence.every(api.isOpaqueSceneBeatRequirement), 'fixture must exercise unknown lexical actions')
      await api.startChatRun(f.deps, f.payload)
      await f.wait()
      const accepted = f.repo.getManuscriptSegmentsByRun(f.runId).filter(row => row.status === 'accepted')
      const attempts = JSON.parse(f.policy().json).attempts
      if (mode === 'invalid-exhausted') {
        assert.deepEqual(wire.map(item => item.purpose), ['writer', 'critic', 'critic'])
        assert.equal(attempts.length, 0, 'an invalid packet exhausts only two critic slots, never the prose rewrite budget')
        assert.equal(accepted.length, 0, 'legal style findings never grant semantic completion')
        assert.equal(f.run().status, 'waiting_user')
        assert.equal(f.run().error_code, 'writing_critic_invalid')
        assert(f.repo.getManuscriptSegmentsByRun(f.runId).some(row => row.status === 'candidate' && row.content === complete), 'the exact original prose remains an unaccepted candidate')
        assert.equal(JSON.parse(f.repo.getRunEvidence(f.runId, 'writing_pipeline_latest').json).criticCallAttempts, 2)
        assert.notEqual(f.repo.getSceneStates(f.runId).find(scene => scene.sceneId === contract.sceneId).lifecycle, 'committed')
      } else {
        assert.deepEqual(wire.map(item => item.purpose), mode === 'invalid-then-corrected' ? ['writer', 'critic', 'critic', 'writer'] : ['writer', 'critic', 'writer', 'critic', 'writer'])
        assert.equal(attempts.length, mode === 'invalid-then-corrected' ? 0 : 1)
        assert.equal(accepted.length, 1); assert.equal(accepted[0].content, complete)
        assert.equal(f.repo.getSceneStates(f.runId).find(scene => scene.sceneId === contract.sceneId).lifecycle, 'committed')
        const segmentId = accepted[0].segment_id
        const commit = JSON.parse(f.repo.getRunEvidence(f.runId, `scene_completion_decision:${segmentId}`).json)
        const candidate = JSON.parse(f.repo.getRunEvidence(f.runId, `scene_contract_segment:${segmentId}:candidate`).json)
        const acceptedEvaluation = JSON.parse(f.repo.getRunEvidence(f.runId, `scene_contract_segment:${segmentId}:accepted`).json)
        for (const evaluation of [candidate, acceptedEvaluation, commit.evaluation]) {
          assert.equal(evaluation.beatEvidence.length, 2)
          assert(evaluation.beatEvidence.every(beat => beat.status === 'satisfied' && beat.semanticVersion === 2))
          assert.equal(evaluation.semanticReview.candidateHash, hash(complete))
          assert.equal(evaluation.sceneChars, cp(complete), 'replaying acceptance must not count the candidate twice')
        }
        assert.equal(commit.decision.status, 'complete')
        const reviewed = JSON.parse(f.repo.getRunEvidence(f.runId, 'writing_pipeline_cycle_000001').json)
        assert.equal(reviewed.issues.length, 1)
        assert.equal(reviewed.issues[0].issueId, 'q1'); assert.equal(reviewed.issues[0].code, 'cliche_language')
        assert.equal(reviewed.issues[0].severity, 'advisory', 'slot-two style cannot upgrade the first validated advisory')
        assert.equal(reviewed.issues[0].quote, mode === 'missing-then-rewrite' ? incomplete : complete)
      }
      const receiptFor = candidate => f.repo.getRunEvidence(f.runId, `scene_beat_critic:${contract.frozenHash}:${hash(candidate)}:${hash('')}`)
      const receipt = JSON.parse(receiptFor(complete).json)
      assert.equal(receipt.candidateHash, hash(complete)); assert.equal(receipt.rawHash, hash(JSON.stringify(receipt.raw)))
      assert.equal(receipt.raw.beats.length, 2)
      assert.equal(receipt.invalidBeatIds.length, mode === 'invalid-exhausted' ? 2 : 0)
      const criticCalls = wire.filter(item => item.purpose === 'critic')
      assert.equal(criticCalls.length, 2, 'all subcases use exactly the existing two critic slots/candidate-review calls')
      if (mode === 'invalid-then-corrected') {
        const first = JSON.parse(criticCalls[0].messages.find(message => message.role === 'user').content)
        const second = JSON.parse(criticCalls[1].messages.find(message => message.role === 'user').content)
        const originalReport = JSON.parse(second.formatCorrection.invalidReport)
        const semanticRepair = api.prepareCriticSemanticRepair(second.formatCorrection.invalidReport, first.candidate, first.candidateHash, second.formatCorrection.semanticErrors)
        const drifted = { ...originalReport, issues: [], sceneBeatEvidence: receipt.raw }
        assert.equal(api.parseCorrectedCriticReport(JSON.stringify(drifted), first.candidate, semanticRepair).issues.length, 1, 'slot-two deletion cannot remove a frozen style finding')
        assert.throws(() => api.parseCorrectedCriticReport(JSON.stringify({ ...drifted, candidateHash: hash('wrong literal hash') }), first.candidate, semanticRepair), /critic_semantic_report_identity_invalid/)
        const ordinaryRaw = JSON.stringify({ ...originalReport, issues: originalReport.issues.map(issue => ({ ...issue, code: 'invented-style-code' })) })
        const ordinaryRepair = api.prepareCriticFormatRepair(ordinaryRaw, 'critic_issue_code_invalid:0', first.candidate, first.candidateHash)
        assert(ordinaryRepair)
        assert.throws(() => api.parseCorrectedCriticReport(JSON.stringify({ ...originalReport, issues: originalReport.issues.map(issue => ({ ...issue, severity: 'hard' })) }), first.candidate, ordinaryRepair), /critic_format_repair_findings_changed/, 'ordinary code-format correction remains strict')
      }
      if (mode === 'missing-then-rewrite') {
        assert.notEqual(hash(incomplete), hash(complete))
        assert.equal(JSON.parse(receiptFor(incomplete).json).raw.beats[1].status, 'missing', 'old candidate receipt is retained and never rebound to the revision')
      }
      assert.equal(f.config.deepWrite.targetChars, 8000); assert.equal(f.config.completionContract.targetChars.min, 8000)
      assert.equal(f.config.grillMe.outlineHash, originalOutlineHash)
      assert.equal(f.repo.getTurnsByRun(f.runId).find(turn => turn.role === 'user').content, task)
      assert(f.config.writingPipeline && f.config.strongConstraints.enabled)
    } finally { f.repo.close() }
  })
})

test('critic root-object protocol preserves semantic evidence and strictly rejects the actual premature-root-close shape', async () => {
  const f = await fixture('critic-root-object', { noStep: true })
  try {
    const candidate = '23:00，林舟从铁盒里取出钥匙。林舟把钥匙递给顾岚。顾岚将钥匙握在掌心。'
    const candidateHash = hash(candidate), contract = f.config.sceneContracts.contracts[0]
    const messages = api.buildCriticMessages({ policy: f.config.writingPipeline, snapshot: f.config.strongConstraints,
      candidate, candidateHash, sceneBeatReview: { semanticVersion: 2, contractHash: contract.frozenHash, scenePrefixHash: hash(''), scenePrefix: '',
        requiredBeats: api.deriveSceneBeatRequiredParts(contract) } })
    const prompt = messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
    assert(prompt.includes('schemaVersion、anchorMode、candidateHash、issues、sceneBeatEvidence 必须全部属于同一对象'))
    assert(prompt.includes('禁止先在 issues 后闭合根对象再追加 sceneBeatEvidence'))
    assert(prompt.includes('恰好一项')); assert(prompt.includes('完整必要动作链'))
    assert(prompt.includes('一律为字符串数组')); assert(prompt.includes('实际姓名'))
    assert(prompt.includes('predicate 必须是该段中的唯一逐字原文自然谓词'))
    assert(prompt.includes('原文没有“问起”就不能输出'))
    assert(prompt.includes('agent 须为原文可锚定的人物或实体'))
    assert(prompt.includes('施事只能是光柱，不能改填林舟'))
    assert(prompt.includes('只填原文实际出现的实体短语，不扩写、不换名'))
    assert(prompt.includes('连续动作省略的角色可从原文近域明确承接'))
    assert(prompt.includes('missing 不得生成未发生动作的 semanticEvents'))
    const exampleLine = prompt.split('\n').find(line => line.startsWith('完整合并示例：'))
    const combined = JSON.parse(exampleLine.slice('完整合并示例：'.length))
    assert.deepEqual(Object.keys(combined), ['schemaVersion', 'anchorMode', 'candidateHash', 'issues', 'sceneBeatEvidence'])
    const beat = combined.sceneBeatEvidence.beats[0]
    assert.equal(beat.spans.length, 3); assert.equal(beat.semanticEvents.length, 3)
    assert(beat.spans.every(span => span.source === 'candidate' && candidate.includes(span.text) && !('start' in span) && !('startCp' in span)))
    assert(beat.semanticEvents.every(event => ['agent', 'patient', 'sourceRole', 'recipient', 'beneficiary'].every(role => event[role] === undefined || Array.isArray(event[role]))))
    combined.candidateHash = candidateHash; combined.sceneBeatEvidence.candidateHash = candidateHash
    const parsed = api.parseCriticReport(JSON.stringify(combined), candidate, candidateHash)
    assert.deepEqual(parsed.sceneBeatEvidence, combined.sceneBeatEvidence, 'one-root parser retains the entire untrusted semantic packet')
    const { sceneBeatEvidence, ...styleRoot } = combined
    // Exact structural anomaly observed in R11: root closes after issues,
    // then the semantic property is emitted outside it. Never extract first JSON.
    const malformed = `${JSON.stringify(styleRoot)},"sceneBeatEvidence":${JSON.stringify(sceneBeatEvidence)}}`
    assert.throws(() => api.parseCriticReport(malformed, candidate, candidateHash), SyntaxError)
    assert.equal(f.calls.length, 0, 'this protocol regression makes no Provider or Engine execution calls')
  } finally { f.repo.close() }
})

test('duplicate legacy queued run and old alreadyCreated loader cannot acquire facts or a new repair policy from user payload', async () => {
  const f = await fixture('old-unknown', { noStep: true })
  try {
    f.repo.createSession(f.sessionId, '旧未知任务', 'fake-new-run')
    const at = Date.now()
    f.repo.createRun({ run_id: f.runId, session_id: f.sessionId, status: 'queued', phase: 'queued', started_at: at,
      updated_at: at, config_json: JSON.stringify(f.config), parent_run_id: null, error_code: null, error_message: null, client_request_id: f.runId })
    f.repo.appendTurn({ turn_id: `${f.runId}_user`, run_id: f.runId, turn_seq: 1, role: 'user', content: f.payload.text,
      reasoning_content: null, tool_calls_json: null, tool_result_json: null, plan_state: null, created_at: at })
    const ack = await api.startChatRun(f.deps, { ...f.payload, newlyAccepted: true })
    assert.equal(ack.idempotent, true); assert.equal(f.starts.length, 0)
    await f.engine.start({ runId: f.runId, sessionId: f.sessionId, config: f.config, alreadyCreated: true })
    assert.equal(f.policy(), null); assert.deepEqual(f.repo.getNarrativeFacts(f.sessionId, true), [])
    assert.equal(f.calls.length, 0); assert.equal(f.repo.getArtifactsByRun(f.runId).length, 0)
  } finally { f.repo.close() }
})

test('materialization failure makes the accepted run failed without starting Engine or Provider', async () => {
  let writes = 0
  const f = await fixture('facts-fail', { repository: repo => new Proxy(repo, { get(target, key) {
    if (key === 'upsertNarrativeFact') return fact => {
      if (++writes === 2) throw new Error('fixture_fact_write_failed')
      return target.upsertNarrativeFact(fact)
    }
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
  } }) })
  try {
    await assert.rejects(api.startChatRun(f.deps, f.payload), /fixture_fact_write_failed/)
    assert.equal(f.run().status, 'failed'); assert.equal(f.run().error_code, 'run_engine_start_failed')
    assert.equal(f.starts.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.policy(), null)
    assert.equal(f.repo.getNarrativeFacts(f.sessionId, true).length, 1, 'a partial write is still legitimate confirmed input, but the run must not execute')
    assert.deepEqual(JSON.parse(f.run().config_json).grillMe.answers, f.config.grillMe.answers)
  } finally { f.repo.close() }
})

test('new confirmed run never resurrects a retracted fact', async () => {
  const f = await fixture('retracted', { noStep: true })
  try {
    const fact = api.buildNarrativeFactsFromGrill({ sessionId: f.sessionId, answers: f.answers })[0]
    const retracted = { ...fact, status: 'retracted' }
    retracted.provenanceHash = api.narrativeFactProvenanceHash(retracted)
    f.repo.upsertNarrativeFact(retracted)
    await assert.rejects(api.startChatRun(f.deps, f.payload), /confirmed_fact_drift/)
    assert.equal(f.run().status, 'failed'); assert.equal(f.calls.length, 0); assert.equal(f.starts.length, 0)
    assert.equal(f.repo.getNarrativeFact(fact.factId).status, 'retracted'); assert.equal(f.policy(), null)
  } finally { f.repo.close() }
})

test('initialization CAS rejects a preexisting consumed policy without overwriting its bytes or allowing execution', async () => {
  let frozen
  const f = await fixture('policy-spent', { beforeStart: ({ repo, config, policyKind }) => {
    const initial = api.readSceneBeatRepairLedger(null, config.clientRequestId, config.sceneContracts.contracts[0])
    // Explicit offline adversarial-row injection, not a completed/provider receipt.
    const { hash: _hash, ...body } = initial
    body.attempts = [{ requestHash: hash('old-request'), candidateHash: hash(original), scenePrefixHash: hash(''), logicalCallId: 'old-consumed-reservation', reservedAt: 1 }]
    frozen = JSON.stringify({ ...body, hash: hash(JSON.stringify(body)) })
    repo.saveRunEvidence(config.clientRequestId, policyKind, frozen)
  } })
  try {
    await assert.rejects(api.startChatRun(f.deps, f.payload), /new_run_policy_conflict/)
    assert.equal(f.run().status, 'failed'); assert.equal(f.policy().json, frozen); assert.equal(f.calls.length, 0)
    assert.equal(f.repo.getArtifactsByRun(f.runId).length, 0)
  } finally { f.repo.close() }
})

test('accepted-new-run identity drift is rejected before any policy grant or Provider call', async () => {
  const f = await fixture('identity-drift', { beforeStart: ({ repo, args }) => {
    const changed = { ...args.config, maxTurns: Number(args.config.maxTurns || 0) + 1 }
    repo.updateRun(args.runId, { config_json: JSON.stringify(changed) })
  } })
  try {
    await assert.rejects(api.startChatRun(f.deps, f.payload), /new_run_identity_invalid/)
    assert.equal(f.run().status, 'failed'); assert.equal(f.policy(), null); assert.equal(f.calls.length, 0)
    assert.equal(f.repo.getArtifactsByRun(f.runId).length, 0)
  } finally { f.repo.close() }
})

test('R10 later conditional speech keeps the frozen scene plan valid; invalid plans fail before any Provider', async () => {
  const beat = '林舟翻到附页应在的位置，发现只剩装订线孔；他把手电筒照向顾岚，顾岚说附页可能早被归入其他卷。'
  const outline = { title: '附页', premise: '在场行动与另一人的推测分开。', targetChars: 8000,
    sections: [{ id: 'sec2', title: '档案室', purpose: '原 R10 已确认动作。', targetChars: 8000, beats: [beat], sourceSlotIds: ['goal'] }] }
  const valid = await fixture('r10-local-scope', { outline, target: 8000, noStep: true })
  try {
    assert.equal(api.sceneContractPlanValid(valid.config.sceneContracts), true, 'the unchanged R10 authored beat must survive production derive/freeze')
    const groups = valid.config.sceneContracts.contracts[0].requiredBeatEvidence[0].eventGroups
    assert.equal(groups.length, 3)
    for (const group of groups) {
      assert.equal(group.actuality, 'asserted_actual')
      assert(group.cueSpans.every(cue => cue.scopeStart <= cue.scopeEnd))
      assert.equal(group.cueSpans.find(cue => cue.text === '可能').relation, 'outside')
    }
    const candidate = '林舟发现密信。顾岚说密信可能来自旧档案。'
    const positive = await fixture('r10-scope-positive', { target: 8000, noStep: true, outline: { ...outline, sections: [{ ...outline.sections[0], beats: ['林舟发现密信。'] }] } })
    try {
      const contract = positive.config.sceneContracts.contracts[0]
      assert.equal(api.evaluateSceneContract(contract, candidate).beatEvidence[0].status, 'satisfied')
      assert.notEqual(api.evaluateSceneContract(contract, '也许林舟发现密信。').beatEvidence[0].status, 'satisfied', 'a preceding conditional cue still blocks actuality')
      assert.notEqual(api.evaluateSceneContract(contract, '林舟发现密信只是梦境。').beatEvidence[0].status, 'satisfied', 'retrospective non-actuality remains conservative')
    } finally { positive.repo.close() }
  } finally { valid.repo.close() }
  for (const restored of [false, true]) {
    const f = await fixture(`r10-invalid-plan-${restored}`, { noStep: true })
    try {
      f.config.sceneContracts.planHash = '0'.repeat(64)
      if (restored) {
        f.repo.createSession(f.sessionId, '旧非法计划', 'fake-new-run')
        const at = Date.now()
        f.repo.createRun({ run_id: f.runId, session_id: f.sessionId, status: 'queued', phase: 'queued', started_at: at,
          updated_at: at, config_json: JSON.stringify(f.config), parent_run_id: null, error_code: null, error_message: null, client_request_id: f.runId })
        f.repo.appendTurn({ turn_id: `${f.runId}_user`, run_id: f.runId, turn_seq: 1, role: 'user', content: f.payload.text,
          reasoning_content: null, tool_calls_json: null, tool_result_json: null, plan_state: null, created_at: at })
        await f.engine.start({ runId: f.runId, sessionId: f.sessionId, config: f.config, alreadyCreated: true })
        await f.engine.step(f.runId)
        assert.equal(f.run().error_code, 'scene_contract_plan_invalid')
      } else {
        await assert.rejects(api.startChatRun(f.deps, f.payload), /scene_contract_plan_invalid/)
        assert.match(f.run().error_message, /scene_contract_plan_invalid/)
      }
      assert.equal(f.run().status, 'failed')
      assert.equal(f.calls.length, 0)
      assert.equal(f.policy(), null)
      assert.equal(f.repo.getManuscriptSegmentsByRun(f.runId).length, 0)
      assert.equal(f.repo.getArtifactsByRun(f.runId).length, 0)
    } finally { f.repo.close() }
  }
})
