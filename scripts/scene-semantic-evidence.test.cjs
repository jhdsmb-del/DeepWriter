const assert = require('node:assert/strict')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
before(async () => {
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    export {buildSceneContractPlan,evaluateSceneContract,buildSceneCompletionDecision,bindSceneBeatCriticEvidence,validateSceneBeatSemanticEvidence,deriveSceneBeatRequiredParts} from './src/main/narrative/sceneContract';
    export {sceneBeatRepairEligible,makeSceneBeatRepairRequest,SCENE_BEAT_REPAIR_MAX_ATTEMPTS} from './src/main/narrative/sceneBeatRepair';
    export {extractNarrativeStateDelta} from './src/main/narrative/stateExtractor';
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent', plugins: [{ name: 'semantic-source-only', setup(build) {
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
const hash = text => createHash('sha256').update(text).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
function contractFor(beats, characterNames = ['岑霁', '何照']) {
  return api.buildSceneContractPlan({ outline: { title: '语义锚点', premise: '', targetChars: 1400, sections: [{ id: 's1', title: '当前场', purpose: '局部真实行动', targetChars: 1400, beats: Array.isArray(beats) ? beats : [beats], sourceSlotIds: [] }] }, characterNames, answers: [] }).contracts[0]
}
function packet(contract, text, predicate = '扣住', patient = ['铜片'], prefix = '') {
  return { semanticVersion: 1, contractHash: contract.frozenHash, candidateHash: hash(text), scenePrefixHash: hash(prefix),
    beats: [{ beatId: contract.requiredBeatIds[0], status: 'satisfied', quote: text,
      semanticEvents: [{ spanIndex: 0, predicate, agent: ['岑霁'], patient, actuality: 'asserted_actual', assertion: 'asserted', negation: false }] }] }
}
function evaluate(contract, candidate, raw, prefix = '') {
  const evidence = api.bindSceneBeatCriticEvidence(contract, candidate, prefix, raw)
  const evaluation = api.evaluateSceneContract(contract, candidate, { completed: true, scenePrefix: prefix, modelEvidence: evidence, semanticReview: true })
  const decision = api.buildSceneCompletionDecision(contract, candidate, { candidateSegmentId: 'candidate', scenePrefix: prefix, evaluation, at: 1 })
  return { evidence, evaluation, decision }
}

test('typed local semantic evidence supports unseen predicates, not empty lexical beats', () => {
  const contract = contractFor('岑霁扣住铜片。')
  const candidate = '岑霁把铜片扣住。'
  assert.equal(api.evaluateSceneContract(contract, candidate).beatEvidence[0].status, 'missing')
  const result = evaluate(contract, candidate, packet(contract, candidate))
  assert.equal(result.decision.status, 'complete')
  assert.equal(result.evaluation.beatEvidence[0].eventGroups[0].surface, '扣住')
  assert.equal(result.decision.beatEvidence[0].requiredSource, contract.requiredBeatEvidence[0].source)
  const partial = contractFor(['岑霁扣住铜片。', '何照掩严房门。'])
  assert.equal(evaluate(partial, candidate, packet(partial, candidate)).decision.status, 'defer', 'one supported event never grants another required beat')
})

test('raw negative propositions and nominal planned words do not negate a real local predicate', () => {
  for (const [required, text, predicate, patient] of [
    ['岑霁扣住铜片，没有立刻插锁。', '岑霁扣住铜片，没有立刻插锁。', '扣住', ['铜片']],
    ['岑霁把旋钮旋至关闭预备位。', '岑霁将旋钮旋至关闭预备位。', '旋至', ['旋钮']]
  ]) {
    const contract = contractFor(required)
    assert.equal(evaluate(contract, text, packet(contract, text, predicate, patient)).decision.status, 'complete')
  }
})

test('quotes, unknown-verb negation, plans, questions and global hypothetical frames cannot grant an actual event', () => {
  const contract = contractFor('岑霁扣住铜片。')
  for (const text of ['岑霁说：“岑霁扣住铜片。”', '岑霁没有扣住铜片。', '岑霁不扣住铜片。', '岑霁想扣住铜片。', '岑霁计划扣住铜片。', '如果灯灭，岑霁扣住铜片。', '岑霁扣住铜片吗？', '岑霁扣住铜片只是计划。']) {
    const result = evaluate(contract, text, packet(contract, text))
    assert.equal(result.decision.status, 'defer', text)
    assert.equal(result.evaluation.violations.some(item => item.code === 'beat_evidence_invalid'), true, text)
  }
})

test('role evidence is predicate-local, including patient and transfer direction', () => {
  const contract = contractFor('岑霁扣住铜片。')
  for (const text of ['何照扣住铜片。岑霁在门边。', '岑霁扣住册页，铜片在门边。', '岑霁和何照站着。她扣住铜片。']) {
    assert.equal(evaluate(contract, text, packet(contract, text)).decision.status, 'defer', text)
  }
  const transfer = contractFor('岑霁把铜片交给何照。')
  const reversed = '何照把铜片交给岑霁。'
  const raw = packet(transfer, reversed, '交给')
  raw.beats[0].semanticEvents[0].agent = ['何照']
  raw.beats[0].semanticEvents[0].recipient = ['岑霁']
  assert.equal(evaluate(transfer, reversed, raw).decision.status, 'defer')
  const wrongPatient = '岑霁把册页交给何照。'
  const bad = packet(transfer, wrongPatient, '交给', ['册页'])
  bad.beats[0].semanticEvents[0].recipient = ['何照']
  assert.equal(evaluate(transfer, wrongPatient, bad).decision.status, 'defer')
  const explicitDenial = '岑霁没有把铜片交给何照。'
  const denied = packet(transfer, explicitDenial, '交给')
  denied.beats[0].semanticEvents[0].recipient = ['何照']
  const denial = evaluate(transfer, explicitDenial, denied)
  assert.equal(denial.decision.status, 'defer')
  assert.equal(api.sceneBeatRepairEligible(transfer, denial.evaluation, true), false, 'true bound negative remains a blocker')
})

test('hash, source, beat, span and duplicate guards survive compact host expansion', () => {
  const contract = contractFor('岑霁扣住铜片。')
  const text = '岑霁扣住铜片。'
  for (const key of ['contractHash', 'candidateHash', 'scenePrefixHash']) {
    const raw = packet(contract, text)
    raw[key] = '0'.repeat(64)
    assert.equal(evaluate(contract, text, raw).decision.status, 'defer', key)
  }
  const raw = packet(contract, text)
  const expanded = api.bindSceneBeatCriticEvidence(contract, text, '', raw)
  const badSource = clone(expanded)
  badSource[0].requiredSource = '另一个原始 beat'
  assert.deepEqual(api.validateSceneBeatSemanticEvidence(contract, text, '', badSource).invalidBeatIds, contract.requiredBeatIds)
  const badBeat = clone(raw)
  badBeat.beats[0].beatId = 'other-scene:beat:1'
  assert.equal(evaluate(contract, text, badBeat).decision.status, 'defer')
  const noEvents = clone(raw)
  noEvents.beats[0].semanticEvents = []
  assert.equal(evaluate(contract, text, noEvents).decision.status, 'defer')
  const dup = clone(raw)
  dup.beats.push({ ...clone(dup.beats[0]), status: 'missing' })
  const duplicate = evaluate(contract, text, dup)
  assert.equal(duplicate.decision.status, 'defer')
  assert.equal(duplicate.evaluation.beatEvidence[0].status, 'missing')
  const repeated = text + text
  const ambiguous = packet(contract, repeated)
  ambiguous.beats[0].quote = text
  assert.equal(evaluate(contract, repeated, ambiguous).decision.status, 'defer')
  const unversioned = { ...expanded[0] }
  delete unversioned.semanticVersion
  assert.equal(evaluate(contract, text, [unversioned]).decision.status, 'defer', 'legacy does not inherit dictionary-free semantic authority')
})

test('code-point offsets normalize exactly and surrogate splits or wrong aliases cannot grant', () => {
  const contract = contractFor('岑霁扣住铜片。')
  const quote = '岑霁扣住铜片。'
  const text = '🧭。' + quote
  const raw = packet(contract, text)
  raw.beats[0].quote = undefined
  raw.beats[0].spans = [{ startCp: 2, endCp: Array.from(text).length, text: quote }]
  const good = evaluate(contract, text, raw)
  assert.equal(good.decision.status, 'complete')
  assert.equal(good.evidence[0].spans[0].startCp, 2)
  assert.equal(good.evaluation.beatEvidence[0].spans[0].start, 3)
  for (const span of [{ start: 1, end: text.length, text: text.slice(1) }, { start: 3, end: text.length, startCp: 3, endCp: Array.from(text).length, text: quote }]) {
    const bad = clone(raw)
    bad.beats[0].spans = [span]
    assert.equal(evaluate(contract, text, bad).decision.status, 'defer')
  }
})

test('missing or invalid semantic evidence stays defer and consumes only the original bounded rewrite path', () => {
  const contract = contractFor('岑霁扣住铜片。')
  const text = '岑霁站在窗边。'
  const missing = packet(contract, text)
  missing.beats[0] = { beatId: contract.requiredBeatIds[0], status: 'missing' }
  for (const raw of [missing, packet(contract, text)]) {
    const result = evaluate(contract, text, raw)
    assert.equal(result.decision.status, 'defer')
    assert.equal(api.sceneBeatRepairEligible(contract, result.evaluation, true), true)
    const candidate = { runId: 'run', sceneId: contract.sceneId, status: 'candidate', segmentId: 'candidate', revision: 1, content: text, contentHash: hash(text) }
    assert.deepEqual(api.makeSceneBeatRepairRequest(contract, candidate, '', result.evaluation).missingBeatIds, contract.requiredBeatIds)
    assert.throws(() => api.makeSceneBeatRepairRequest(contract, { ...candidate, contentHash: '0'.repeat(64) }, '', result.evaluation), /binding_invalid/)
  }
  assert.equal(api.SCENE_BEAT_REPAIR_MAX_ATTEMPTS, 2)
  const forbidden = { ...contract, mustNotHappen: ['禁行事实'] }
  const violating = evaluate(forbidden, text + '禁行事实', packet(forbidden, text + '禁行事实'))
  assert.equal(api.sceneBeatRepairEligible(forbidden, violating.evaluation, true), false)
})

test('fresh prefix-domain evidence is revalidated at completion and state projection; stale domains fail', () => {
  const contract = contractFor('岑霁扣住铜片。')
  const prefix = '岑霁扣住铜片。'
  const text = '何照站在门边。'
  const raw = packet(contract, text, '扣住', ['铜片'], prefix)
  raw.beats[0].quote = prefix
  raw.beats[0].quoteSource = 'scene_prefix'
  const result = evaluate(contract, text, raw, prefix)
  assert.equal(result.decision.status, 'complete')
  const segment = (content, id, chunkIndex) => ({ segmentId: id, content, contentHash: hash(content), charCount: Array.from(content).length, chunkIndex, revision: 1 })
  const input = { runId: 'run', sceneId: contract.sceneId, contract, decision: result.decision, candidateSegmentId: 'candidate', candidateContentHash: hash(text), acceptedSegments: [segment(prefix, 'prefix', 0), segment(text, 'candidate', 1)], now: 1 }
  assert.equal(api.extractNarrativeStateDelta(input).status, 'ready')
  const corrupt = clone(input)
  corrupt.decision.beatEvidence[0].patient = ['册页']
  assert.equal(api.extractNarrativeStateDelta(corrupt).status, 'pending_review')
  assert.equal(evaluate(contract, text, raw, prefix + '何照走远。').decision.status, 'defer')
  assert.equal(evaluate(contract, text, { ...raw, candidateHash: hash(text + '变更') }, prefix).decision.status, 'defer')
})

test('offset-free compact multi-spans bind unique exact text in its domain without correcting explicit coordinates', () => {
  const contract = contractFor('岑霁扣住铜片，理顺流苏。')
  const prefix = '岑霁扣住铜片。'
  const quote = '岑霁理顺流苏。'
  const candidate = '🧭。' + quote
  const raw = packet(contract, candidate, '扣住', ['铜片'], prefix)
  delete raw.beats[0].quote
  raw.beats[0].spans = [{ text: prefix, source: 'scene_prefix' }, { text: quote, source: 'candidate' }]
  raw.beats[0].semanticEvents.push({ spanIndex: 1, predicate: '理顺', agent: ['岑霁'], patient: ['流苏'], actuality: 'asserted_actual', assertion: 'asserted', negation: false })
  const good = evaluate(contract, candidate, raw, prefix)
  assert.equal(good.decision.status, 'complete')
  assert.deepEqual(good.evidence[0].spans.map(span => [span.source, span.start, span.end]), [['scene_prefix', 0, prefix.length], ['candidate', 3, candidate.length]])
  assert.equal(good.evaluation.beatEvidence[0].eventGroups.length, 2)
  for (const badSpan of [
    { text: prefix, source: 'candidate' },
    { text: quote, source: 'scene_prefix' },
    { text: '不存在的原文', source: 'candidate' },
    { text: quote, source: 'other_scene' },
    { text: quote, source: 'candidate', start: 0, end: 1 },
    { text: quote, source: 'candidate', startCp: 0, endCp: 1 },
    { text: quote, source: 'candidate', start: 3 }
  ]) {
    const bad = clone(raw)
    bad.beats[0].spans[1] = badSpan
    const bound = api.bindSceneBeatCriticEvidence(contract, candidate, prefix, bad)
    assert.deepEqual(bound[0].spans[1], badSpan, 'wrong domains and explicit coordinates are not repaired')
    assert.equal(evaluate(contract, candidate, bad, prefix).decision.status, 'defer')
  }
  const repeated = candidate + quote
  const ambiguous = { ...raw, candidateHash: hash(repeated) }
  assert.equal(evaluate(contract, repeated, ambiguous, prefix).decision.status, 'defer', 'a repeated quote needs caller-supplied correct coordinates')
})

test('R12 continuous anchored frames retain local actors and patients without granting true invalid evidence', () => {
  // Verbatim R12 clauses; no model-supplied summary patient is substituted
  // for their actual words. All transport is the existing compact envelope.
  const samples = [
    { required: '林舟试了一下开关。', actor: '林舟', predicate: '试了一下', patient: ['开关'],
      text: '二十三点差四分的时候，林舟把手电筒从帆布包里抽出来，试了一下开关。' },
    { required: '顾岚把钥匙拔出来。', actor: '顾岚', predicate: '拔出来', patient: ['钥匙'],
      text: '顾岚合上日志。她合得不重，但纸页之间那点空气被挤出去，发出很轻的一声。她把手伸向柜门，钥匙还插在锁孔里，她捏住钥匙柄，转了半圈，拔出来。' },
    { required: '岑霁扣住铜片。', actor: '岑霁', predicate: '扣住', patient: ['铜片'],
      text: '岑霁拿起铜片，翻了半圈，她把它扣住。' }
  ]
  const review = (sample, text = sample.text, quote = text, predicate = sample.predicate, patient = sample.patient) => {
    const contract = contractFor(sample.required, ['林舟', '顾岚', '岑霁', '何照'])
    const raw = packet(contract, text, predicate, patient)
    raw.beats[0].quote = quote
    raw.beats[0].semanticEvents[0].agent = [sample.actor]
    return { contract, raw, checked: api.validateSceneBeatSemanticEvidence(contract, text, '', raw), result: evaluate(contract, text, raw) }
  }
  for (const sample of samples) {
    const { checked, result } = review(sample)
    assert.deepEqual(checked.issues, [], sample.predicate)
    assert.equal(result.decision.status, 'complete', sample.predicate)
    const group = result.evaluation.beatEvidence[0].eventGroups[0]
    assert.equal(sample.text.slice(group.start, group.end), group.source)
    assert.equal(group.source.includes(sample.actor), true, 'inherited actor is inside the quoted frame')
    assert.equal(group.source.includes(sample.patient[0]), true, 'inherited patient is inside the quoted frame')
  }
  const base = samples[2]
  for (const [text, quote, reason] of [
    ['岑霁拿起铜片，何照拿起册页，她把它扣住。', undefined, 'agent_unbound'],
    ['岑霁拿起铜片，章雨把册页拿起，她把它扣住。', undefined, 'agent_unbound'],
    ['岑霁拿起铜片，拿起册页，她把它扣住。', undefined, 'role_unanchored'],
    ['岑霁没有拿起铜片，翻了半圈，她把它扣住。', undefined, 'agent_unbound'],
    ['岑霁想拿起铜片，翻了半圈，她把它扣住。', undefined, 'agent_unbound'],
    ['岑霁拿起铜片。\n她把它扣住。', undefined, 'agent_unbound'],
    ['岑霁说：“她拿起铜片，扣住。”', undefined, 'agent_unbound'],
    ['岑霁拿起铜片，翻了半圈，她把它扣住。', '翻了半圈，她把它扣住。', 'agent_unbound'],
    ['岑霁与何照拿起铜片，她把它扣住。', undefined, 'agent_unbound']
  ]) {
    const { checked, result } = review(base, text, quote ?? text)
    assert.equal(result.decision.status, 'defer', text)
    assert.equal(checked.issues[0].reason, reason, text)
    assert.equal(checked.issues[0].predicate, '扣住')
  }
  const missingPredicate = review(samples[0], '林舟说：“海难附页在哪里？”', undefined, '问起', ['附页'])
  assert.equal(missingPredicate.checked.issues[0].reason, 'predicate_missing')
  assert.equal(missingPredicate.result.decision.status, 'defer')
  const summaryPatient = review(samples[0], undefined, undefined, undefined, ['手电筒开关'])
  assert.equal(summaryPatient.checked.issues[0].reason, 'role_unanchored')
  assert.equal(summaryPatient.checked.issues[0].role, 'patient')
  const outsideQuote = review(base, '岑霁扣住铜片。', '岑霁扣住')
  assert.equal(outsideQuote.checked.issues[0].reason, 'role_unanchored', 'the rest of the same clause is not part of the citation')
  const badHash = review(base)
  badHash.raw.candidateHash = '0'.repeat(64)
  assert.equal(api.validateSceneBeatSemanticEvidence(badHash.contract, base.text, '', badHash.raw).issues[0].reason, 'binding_invalid')
})

test('R13 immediately owned body subject is bound inside one exact citation, not across a handover', () => {
  const contract = contractFor('林舟伸手按住申请副本。', ['林舟', '顾岚'])
  const review = text => {
    const raw = packet(contract, text, '压住', ['那份副本'])
    raw.beats[0].semanticEvents[0].agent = ['林舟']
    return { raw, checked: api.validateSceneBeatSemanticEvidence(contract, text, '', raw), result: evaluate(contract, text, raw) }
  }
  const actualR13 = '林舟伸手，手掌压住那份副本。'
  const good = review(actualR13)
  assert.deepEqual(good.checked.issues, [])
  assert.equal(good.result.decision.status, 'complete')
  assert.equal(good.result.evaluation.beatEvidence[0].eventGroups[0].source, '林舟伸手，手掌压住那份副本')
  for (const text of [
    '林舟伸手，顾岚的手掌压住那份副本。',
    '林舟伸手，顾岚接过副本，手掌压住那份副本。',
    '林舟伸手。\n手掌压住那份副本。',
    '林舟没有伸手，手掌压住那份副本。',
    '林舟伸手，手册压住那份副本。'
  ]) {
    const bad = review(text)
    assert.equal(bad.result.decision.status, 'defer', text)
    assert.equal(bad.checked.issues[0].reason, 'agent_unbound', text)
  }
  const omittedOwner = review(actualR13)
  omittedOwner.raw.beats[0].quote = '手掌压住那份副本。'
  assert.equal(api.validateSceneBeatSemanticEvidence(contract, actualR13, '', omittedOwner.raw).issues[0].reason, 'agent_unbound')
})

function typedPacket(contract, text, predicate, mention = '林舟', antecedent) {
  const parts = api.deriveSceneBeatRequiredParts(contract)[0].parts
  return { semanticVersion: 2, contractHash: contract.frozenHash, candidateHash: hash(text), scenePrefixHash: hash(''),
    beats: [{ beatId: contract.requiredBeatIds[0], status: 'satisfied', spans: [{ text, source: 'candidate' }],
      partEvidence: parts.map(part => ({ partId: part.partId, status: 'satisfied', spanIndexes: [0] })),
      semanticEvents: [{ spanIndex: 0, partIds: parts.map(part => part.partId), predicate, agent: ['林舟'], patient: predicate === '说' ? [] : ['铜片'],
        agentBindings: [{ name: '林舟', relation: antecedent ? 'pronoun' : 'explicit', mention: { spanIndex: 0, text: mention },
          ...(antecedent ? { antecedent: { spanIndex: 0, text: antecedent } } : {}) }],
        actuality: 'asserted_actual', assertion: 'asserted', negation: false }] }] }
}

test('v2 typed names and pronouns bind after connectives and dialogue, without treating objects or hypothetical subjects as agents', () => {
  for (const [required, text, predicate, mention, antecedent] of [
    ['林舟扣住铜片。', '随后林舟扣住铜片。', '扣住'],
    ['林舟扣住铜片。', '随后林舟拿起铜片，接着他扣住铜片。', '扣住', '他', '林舟'],
    ['林舟说。', '“知道了。”林舟说。', '说'],
    ['林舟说。', '林舟说。', '说']
  ]) {
    const contract = contractFor(required, ['林舟', '何照'])
    const raw = typedPacket(contract, text, predicate, mention, antecedent)
    assert.deepEqual(api.validateSceneBeatSemanticEvidence(contract, text, '', raw).issues, [], text)
    assert.equal(evaluate(contract, text, raw).decision.status, 'complete', text)
  }
  const contract = contractFor('林舟扣住铜片。', ['林舟', '何照'])
  for (const text of ['何照等林舟扣住铜片。', '何照替林舟扣住铜片。', '如果林舟扣住铜片。', '林舟没有扣住铜片。', '“随后林舟扣住铜片。”']) {
    const raw = typedPacket(contract, text, '扣住')
    assert.notEqual(api.validateSceneBeatSemanticEvidence(contract, text, '', raw).issues.length, 0, text)
    assert.equal(evaluate(contract, text, raw).decision.status, 'defer', text)
  }
  const speech = contractFor('林舟说。', ['林舟', '何照'])
  for (const text of ['林舟没有说。', '林舟想说。', '如果林舟说。', '“林舟说。”']) {
    assert.notEqual(api.validateSceneBeatSemanticEvidence(speech, text, '', typedPacket(speech, text, '说')).issues.length, 0, text)
  }
  const embedded = '林舟说他扣住铜片。'
  assert.notEqual(api.validateSceneBeatSemanticEvidence(contract, embedded, '', typedPacket(contract, embedded, '扣住')).issues.length, 0)
})
