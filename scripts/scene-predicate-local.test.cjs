const assert = require('node:assert/strict')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const frozen = require('./fixtures/scene-predicate-local-r3.json')
const root = path.resolve(__dirname, '..')
const hash = text => createHash('sha256').update(text).digest('hex')
let api
before(async () => {
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    export {buildSceneContractPlan,sceneContractValid,evaluateSceneContract,buildSceneCompletionDecision,isOpaqueSceneBeatRequirement} from './src/main/narrative/sceneContract';
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent', plugins: [{ name: 'predicate-local-source', setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (!args.path.startsWith('.')) return { path: args.path, external: true }
      const target = path.resolve(args.resolveDir, args.path)
      const source = ['', '.ts', '.js', '/index.ts'].map(suffix => target + suffix).find(existsSync)
      if (!source || !source.startsWith(root + path.sep)) throw new Error('Source outside workspace')
      return { path: source, namespace: 'source' }
    })
    build.onLoad({ filter: /.*/, namespace: 'source' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }))
  } }] })
  const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports); api = loaded.exports
})
function contractFor(beat) {
  const outline = { title: '已确认短句', premise: beat, targetChars: 1600, sections: [{ id: 's1', title: '现场', purpose: beat, targetChars: 1600, beats: [beat], sourceSlotIds: [] }] }
  return api.buildSceneContractPlan({ outline, answers: [], characterNames: [] }).contracts[0]
}
function evaluate(contract, candidate) { return api.evaluateSceneContract(contract, candidate, { completed: true, sceneChars: Array.from(candidate).length, scenePrefix: '' }) }
function status(beat, candidate) { return evaluate(contractFor(beat), candidate).beatEvidence[0].status }
test('original R3 frozen packet is permanently failed and replayable, even literal frozen beat prose cannot self-certify it', () => {
  assert.equal(hash(frozen.candidate), frozen.candidateHash)
  assert.equal(Array.from(frozen.candidate).length, frozen.candidateCodePoints)
  assert.equal(api.sceneContractValid(frozen.contract), true)
  const evaluation = evaluate(frozen.contract, frozen.candidate)
  const missing = evaluation.beatEvidence.filter(item => item.status === 'missing').map(item => item.beatId)
  // Preserve the immutable original packet/expectation bytes. The current
  // evaluator is stricter: beat 2's empty agent and pseudo-time cannot grant
  // a local “它” patient merely because its full name occurs later.
  assert.ok(frozen.expectedOldMissingBeatIds.every(id => missing.includes(id)))
  assert.deepEqual(missing, frozen.contract.requiredBeatIds)
  const decision = api.buildSceneCompletionDecision(frozen.contract, frozen.candidate, { candidateSegmentId: frozen.contract.sceneId === 'scene:S1' ? frozen.runId + ':e5f55966-f890-4f66-b3dd-0c3812cb4a44' : 'invalid', evaluation, scenePrefix: '', at: frozen.originalDecidedAt })
  assert.equal(decision.status, 'defer'); assert.equal(decision.contractHash, frozen.contract.frozenHash)
  // The old persisted packet remains immutable. A new evaluator may emit
  // additional event diagnostics, so its derived evidence hash is not the old
  // packet hash and must never be written back as historical evidence.
  assert.deepEqual(decision.missingBeatIds, frozen.contract.requiredBeatIds)
  assert.deepEqual(evaluate(frozen.contract, frozen.contract.mustHappen.join('\n')).beatEvidence.filter(item => item.status === 'missing').map(item => item.beatId), frozen.contract.requiredBeatIds)
})
test('new contract from unchanged actual R3 outline recognises real actions 1/3/4, but shared window gaze is not mutual gaze 5', () => {
  const contract = api.buildSceneContractPlan({ outline: frozen.outline, outlineHash: frozen.contract.outlineHash, outlineRevision: frozen.contract.revision, answers: [], characterNames: [] }).contracts[0]
  assert.deepEqual(contract.mustHappen, frozen.contract.mustHappen)
  assert.deepEqual(contract.targetChars, frozen.contract.targetChars)
  assert.deepEqual(contract.activeCharacterIds, [])
  assert.notEqual(contract.frozenHash, frozen.contract.frozenHash)
  const evaluation = evaluate(contract, frozen.candidate)
  assert.deepEqual(evaluation.beatEvidence.map(item => item.status), ['satisfied', 'missing', 'satisfied', 'satisfied', 'missing'])
  const extraction = evaluation.beatEvidence[1].eventGroups.find(group => group.action === 'discover' && group.source.includes('把它取出来'))
  assert.ok(extraction)
  assert.equal(extraction.patient.includes('灯塔关停流程单'), false, 'unbound 它 cannot borrow a qualified artifact name from later prose')
  assert.deepEqual(contract.requiredBeatEvidence[0].agent, ['林舟'])
  assert.deepEqual(contract.requiredBeatEvidence[0].time, ['23:00'])
  assert.deepEqual(contract.requiredBeatEvidence[2].agent, ['林舟'])
  assert.deepEqual(contract.requiredBeatEvidence[3].agent, ['顾岚'])
  assert.deepEqual(contract.requiredBeatEvidence[4].time, [])
  const decision = api.buildSceneCompletionDecision(contract, frozen.candidate, { candidateSegmentId: 'original-candidate', evaluation, scenePrefix: '' })
  assert.equal(decision.status, 'defer'); assert.deepEqual(decision.missingBeatIds, ['scene:S1:beat:2', 'scene:S1:beat:5'])
  assert.equal(evaluation.beatEvidence.some(item => item.status === 'contradicted'), false)
  assert.equal(hash(frozen.candidate), frozen.candidateHash)
})
test('explicit short-clause subjects do not require typed character IDs or the fixture names', () => {
  for (const [first, second] of [['沈遥', '卫川'], ['陆沉', '许澈']]) {
    assert.equal(status(`${first}在库房打开探照灯。`, `${first}走进库房。他拧开探照灯。`), 'satisfied')
    assert.equal(status(`${first}走近桌边，用镇纸压住卷宗一角。`, `${first}走过去。他把镇纸压在卷宗的一角。`), 'satisfied')
    assert.equal(status(`${second}把钥匙收回口袋，转身检查门锁。`, `${second}把钥匙收进口袋。然后她转身走向门口，伸手去检查门锁。`), 'satisfied')
  }
})
test('predicate-local agent and patient cannot be borrowed from unrelated mentions or a different actor', () => {
  for (const [beat, candidate] of [
    ['陆沉打开探照灯。', '陆沉站在门口。许澈打开探照灯。'],
    ['陆沉打开探照灯。', '陆沉打开窗户。许澈拿着探照灯。'],
    ['陆沉用镇纸压住卷宗一角。', '陆沉在门口看着卷宗。许澈用镇纸压住卷宗一角。'],
    ['陆沉检查门锁。', '陆沉检查窗户。许澈拿着门锁。'],
    ['陆沉把钥匙收回口袋。', '陆沉把戒指收回口袋。许澈拿着钥匙。'],
    ['陆沉在库房打开探照灯。', '陆沉在走廊打开探照灯，许澈站在库房。'],
    ['陆沉在库房检查门锁。', '陆沉走进走廊。许澈走进库房。陆沉检查门锁。'],
    ['陆沉用镇纸压住卷宗一角。', '陆沉用手掌压住卷宗一角。']
  ]) assert.notEqual(status(beat, candidate), 'satisfied', candidate)
})
test('compound clauses require every local action and preserve explicit subject switches', () => {
  const beat = '许澈把钥匙收回口袋，转身检查门锁。'
  assert.equal(status(beat, '许澈把钥匙收进口袋，然后检查门锁。'), 'satisfied')
  for (const candidate of ['许澈把钥匙收进口袋。', '许澈检查门锁。', '许澈把钥匙收进口袋，陆沉检查门锁。']) assert.notEqual(status(beat, candidate), 'satisfied', candidate)
})
test('new local predicates retain negation, speech, quote, hypothetical and planned actuality boundaries', () => {
  for (const verb of ['打开探照灯', '用镇纸压住卷宗一角', '把钥匙收回口袋', '检查门锁']) {
    const beat = '陆沉' + verb + '。'
    assert.equal(status(beat, beat), 'satisfied', beat)
    for (const candidate of ['陆沉没有' + verb + '。', '“陆沉' + verb + '。”许澈说。', '如果陆沉' + verb + '，许澈就离开。', '陆沉计划' + verb + '。']) assert.notEqual(status(beat, candidate), 'satisfied', candidate)
  }
})
test('mutual gaze requires the local group subject and location, never joint observation of a window', () => {
  const beat = '两人在值班室窗前短暂对望。'
  assert.equal(status(beat, '两个人在值班室窗前短暂对视。'), 'satisfied')
  for (const candidate of ['两人在值班室窗前看窗外。', '两人在值班室窗前站着。陆沉在门口与许澈对视。', '两人在走廊窗前对望。', '两人没有在值班室窗前对望。']) assert.notEqual(status(beat, candidate), 'satisfied', candidate)
})
test('clock anchors survive natural Chinese time and CRLF; local spatial 在 is never time', () => {
  const contract = contractFor('23:00，陆沉在库房打开探照灯。')
  assert.deepEqual(contract.requiredBeatEvidence[0].time, ['23:00'])
  const text = '二十三点整，陆沉走进库房。\r\n他拧开探照灯，光柱落在门上。'
  const evidence = evaluate(contract, text).beatEvidence[0]
  assert.equal(evidence.status, 'satisfied')
  for (const group of evidence.eventGroups) assert.equal(text.slice(group.predicateSpan.start, group.predicateSpan.end), group.predicateSpan.text)
  for (const beat of ['陆沉在库房打开探照灯。', '陆沉把卷宗放下，在桌上检查门锁。', '两人在值班室窗前对望。']) assert.deepEqual(contractFor(beat).requiredBeatEvidence[0].time, [], beat)
})
test('legacy directional and passive transfer roles remain strict, and truly opaque beats remain missing', () => {
  const beat = '陆沉把钥匙交给许澈。'
  assert.equal(status(beat, '钥匙被陆沉交给许澈。'), 'satisfied')
  assert.notEqual(status(beat, '钥匙被许澈交给陆沉。'), 'satisfied')
  assert.notEqual(status(beat, '陆沉没有把钥匙交给许澈。'), 'satisfied')
  const opaque = contractFor('窗外海面漆黑。')
  assert.equal(api.isOpaqueSceneBeatRequirement(opaque.requiredBeatEvidence[0]), true)
  assert.equal(evaluate(opaque, '窗外海面漆黑。').beatEvidence[0].status, 'missing')
  assert.deepEqual(opaque.requiredBeatEvidence[0].agent, [])
})
test('physical actions with unbound actor/patient never become vacuously complete', () => {
  for (const beat of ['打开探照灯。', '陆沉打开。', '用镇纸压住卷宗一角。', '检查门锁。', '陆沉对望。']) {
    assert.notEqual(status(beat, beat), 'satisfied', beat)
  }
  assert.equal(status('陆沉与许澈对视。', '陆沉和许澈对望。'), 'satisfied')
  assert.notEqual(status('陆沉与许澈对视。', '陆沉和沈遥对望。许澈站在门口。'), 'satisfied')
})
test('local sentence boundaries do not let global dream or hypothetical frames certify physical events', () => {
  for (const candidate of ['梦中，陆沉站在门口。他打开探照灯。', '如果陆沉站在门口。他打开探照灯。']) assert.notEqual(status('陆沉打开探照灯。', candidate), 'satisfied', candidate)
  assert.equal(status('陆沉打开探照灯。', '许澈没有说话。陆沉打开探照灯。'), 'satisfied')
  assert.notEqual(status('陆沉打开探照灯。', '许澈说陆沉打开探照灯。'), 'satisfied')
})
test('new physical passive clauses bind the visible agent; another actor cannot fulfil a denied action', () => {
  for (const [beat, passive] of [
    ['陆沉打开探照灯。', '探照灯被陆沉打开。'],
    ['陆沉用镇纸压住卷宗一角。', '卷宗一角被陆沉用镇纸压住。'],
    ['陆沉把钥匙收进口袋。', '钥匙被陆沉收进口袋。'],
    ['陆沉检查门锁。', '门锁被陆沉检查。']
  ]) {
    assert.equal(status(beat, passive), 'satisfied', passive)
    assert.notEqual(status(beat, passive.replaceAll('陆沉', '许澈') + '陆沉站在门口。'), 'satisfied', passive)
    assert.notEqual(status(beat, beat.replace('陆沉', '陆沉没有') + passive.replaceAll('陆沉', '许澈')), 'satisfied', passive)
  }
  assert.equal(status('陆沉打开探照灯。', '陆沉没有打开探照灯。随后陆沉打开探照灯。'), 'satisfied')
})
test('connective characters inside a name are not two people; explicit typed names win over fallback boundaries', () => {
  const beat = '邵和鸣打开探照灯。', contract = contractFor(beat)
  assert.deepEqual(contract.requiredBeatEvidence[0].agent, ['邵和鸣'])
  assert.equal(evaluate(contract, beat).beatEvidence[0].status, 'satisfied')
  assert.notEqual(evaluate(contract, '邵和辉打开探照灯。邵和鸣站在门口。').beatEvidence[0].status, 'satisfied')
  const outline = { title: '已确认角色', premise: '', targetChars: 1600, sections: [{ id: 's1', title: '现场', purpose: '向志远打开探照灯。', targetChars: 1600, beats: ['向志远打开探照灯。'], sourceSlotIds: [] }] }
  const typed = api.buildSceneContractPlan({ outline, characterNames: ['向志远'], answers: [] }).contracts[0]
  assert.deepEqual(typed.requiredBeatEvidence[0].agent, ['向志远'])
  assert.equal(evaluate(typed, '向志远打开探照灯。').beatEvidence[0].status, 'satisfied')
  assert.notEqual(evaluate(typed, '向志明打开探照灯。向志远站在门口。').beatEvidence[0].status, 'satisfied')
  assert.notEqual(evaluate(typed, '向志远山在库房打开探照灯。向志远站在门口。').beatEvidence[0].status, 'satisfied')
  assert.notEqual(status('陆沉打开探照灯。', '陆沉光打开探照灯。陆沉站在门口。'), 'satisfied')
  assert.equal(status('邵和鸣与陆沉对视。', '邵和鸣和陆沉对望。'), 'satisfied')
})
test('imagining an arrival is not arrival, but independent actual clauses before or after imagination remain real', () => {
  const beat = '林舟抵达灯塔。'
  for (const text of ['林舟想象自己抵达灯塔。', '林舟幻想自己抵达灯塔。', '顾岚设想林舟抵达灯塔。', '顾岚假想林舟抵达灯塔。', '林舟抵达灯塔只是想象。', '“林舟抵达灯塔。”顾岚说。', '如果林舟抵达灯塔，顾岚就离开。']) assert.notEqual(status(beat, text), 'satisfied', text)
  for (const text of ['林舟已经抵达灯塔。他想象明天的海面。', '林舟想象明天的海面。林舟已经抵达灯塔。', '顾岚想象自己抵达灯塔，林舟已经抵达灯塔。', '顾岚幻想明天海面，而林舟抵达灯塔。']) assert.equal(status(beat, text), 'satisfied', text)
  assert.notEqual(status('林舟打开探照灯。', '顾岚想象林舟打开探照灯。'), 'satisfied')
  assert.equal(status('林舟打开探照灯。', '顾岚想象明天的海面，林舟已经打开探照灯。'), 'satisfied')
})
