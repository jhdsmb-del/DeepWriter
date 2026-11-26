import { createHash } from 'node:crypto'
import { compileSceneWorkingSet, estimateSceneWorkingSetTokens, SceneContextCompilerError, sceneRecallSourceSnapshotSetHash } from '../src/main/narrative/sceneContextCompiler'
import { buildDeterministicRecallIndex, SCENE_RECALL_BM25_VERSION, SCENE_RECALL_TOKENIZER_VERSION, sceneRecallAuthorityHash, sceneRecallSourceCardSetHash, sceneRecallSourceSnapshotHash } from '../src/main/narrative/recallIndex'
import { sceneMemoryCardHash } from '../src/main/narrative/sceneMemoryCard'
import { buildSceneContractPlan } from '../src/main/narrative/sceneContract'
import type { GrillMeOutline } from '../src/shared/grillMe'
import type { SceneMemoryCard, SceneMemorySourceSegment, SceneRecallCorpusItem, SceneRecallCorpusSnapshot, SceneRecallIndexResult, SceneRecallQuery, SceneRecallScope } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1
  else {
    failed += 1
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

const headHash = sha('r72-head')
const scope: SceneRecallScope = {
  storyId: 'r72-story',
  projectId: 'r72-project',
  branchId: 'main',
  branchLineage: ['main'],
  validityEpoch: 1,
  storyRevision: 12,
  sceneId: 'scene-12',
  headRevision: 12,
  headHash,
  expectedSourceCardSetHash: sha('r72-card-set-placeholder')
}

function makeCard(cardId: string, text: string): { card: SceneMemoryCard; segment: SceneMemorySourceSegment } {
  const contentHash = sha(text)
  const segment: SceneMemorySourceSegment = {
    segmentId: `${cardId}-segment`, content: text, contentHash, segmentRevision: 1, status: 'accepted', sceneId: 'scene-11', commitId: `${cardId}-commit`, commitManifestHash: sha(`${cardId}-manifest`), chunkIndex: 0
  }
  const card: SceneMemoryCard = {
    schemaVersion: 1,
    status: 'canonical',
    cardId,
    storyId: scope.storyId,
    projectId: scope.projectId,
    branchId: scope.branchId,
    validityEpoch: scope.validityEpoch,
    storyRevision: 11,
    runId: 'r72-run',
    sceneId: 'scene-11',
    sceneOrder: 11,
    contractId: 'contract-11',
    contractHash: sha('contract-11'),
    sceneContentHash: contentHash,
    commitManifestHash: sha(`${cardId}-manifest`),
    stateDeltaHash: sha(`${cardId}-delta`),
    povCharacterId: null,
    participants: [],
    locations: [],
    objects: [],
    dramaticQuestion: null,
    valueShift: null,
    decisiveAction: text,
    turn: null,
    cost: null,
    factsEstablished: [],
    beliefChanges: [],
    relationshipChanges: [],
    threads: [],
    motifs: [],
    distinctivePhrases: [],
    sourceSegmentIds: [`${cardId}-segment`],
    sourceSpans: [{ spanId: `${cardId}-span`, segmentId: `${cardId}-segment`, segmentHash: contentHash, segmentRevision: 1, manifestHash: sha(`${cardId}-manifest`), startUtf16: 0, endUtf16: text.length, text, spanHash: contentHash }],
    embedding: { status: 'unavailable', version: null, modelId: null, dimensions: null, vectorHash: null },
    fieldEvidence: {},
    cardHash: '',
    createdAt: 1
  }
  card.cardHash = sceneMemoryCardHash(card)
  return { card, segment }
}

const made = makeCard('card-hard', '上一场林舟把钥匙藏进雨夜的旧钟。')
const card = made.card
const corpusItem = {
  card,
  sourceSegments: [made.segment],
  sourceValidated: true,
  authority: {
    storyId: scope.storyId,
    projectId: scope.projectId,
    branchId: scope.branchId,
    branchLineage: scope.branchLineage,
    validityEpoch: scope.validityEpoch,
    storyRevision: card.storyRevision,
    headRevision: scope.headRevision,
    headHash: scope.headHash,
    sourceSnapshotHash: sceneRecallSourceSnapshotHash(card, [made.segment]),
    cardHash: card.cardHash,
    authorityHash: ''
  }
} satisfies Omit<SceneRecallCorpusItem, 'authority'> & { authority: SceneRecallCorpusItem['authority'] }
corpusItem.authority.authorityHash = sceneRecallAuthorityHash(corpusItem.authority as unknown as Record<string, unknown>)
const canonicalCardSetHash = sceneRecallSourceCardSetHash([corpusItem])
const canonicalSourceSnapshotHash = sceneRecallSourceSnapshotSetHash([corpusItem])
scope.expectedSourceCardSetHash = canonicalCardSetHash
const snapshot: SceneRecallCorpusSnapshot = { schemaVersion: 1, runId: 'r72-run', sceneId: scope.sceneId, scope, sourceSnapshotHash: canonicalSourceSnapshotHash, sourceCardSetHash: canonicalCardSetHash, corpus: [corpusItem] }
const recallQuery: SceneRecallQuery = { scope, hardDependencyKeys: [`card:${card.cardId}`], tokenizerVersion: SCENE_RECALL_TOKENIZER_VERSION, bm25Version: SCENE_RECALL_BM25_VERSION, topK: 6 }
const recall: SceneRecallIndexResult = buildDeterministicRecallIndex({ corpus: snapshot.corpus, query: recallQuery })
const outline: GrillMeOutline = { title: 'R72 测试', premise: '钥匙的归属', targetChars: 4000, sections: [{ id: 'section-12', title: '钥匙', purpose: '围绕钥匙的归属推进', targetChars: 4000, beats: ['推进钥匙归属'], sourceSlotIds: [] }] }
const sceneContract = buildSceneContractPlan({ outline }).contracts[0]!

function compile(overrides: Partial<Parameters<typeof compileSceneWorkingSet>[0]> = {}) {
  return compileSceneWorkingSet({
    snapshot,
    recall,
    recallQuery,
    contract: sceneContract,
    hardConstraints: ['只写正文，不解释过程。', '不得把未证实信息写成事实。'],
    sections: { anti_repetition: '不要重复上一场的钟声意象。' },
    ...overrides
  })
}

const first = compile()
check('fixed section order', first.manifest.sections.map((item) => item.id).join(',') === 'hard_constraints,scene_contract,pov_state,world_state,causal_memories,payoff,exact_anchors,recent_tail,anti_repetition,omitted')
check('hard and contract are required and included first', first.manifest.sections[0]?.required === true && first.manifest.sections[1]?.required === true && first.workingSetMessage.messages[0]?.content.indexOf('## hard_constraints') < first.workingSetMessage.messages[0]?.content.indexOf('## scene_contract'))
check('working set is within budget', first.workingSet.estimatedTokens <= first.workingSet.budgetTokens && first.workingSet.status === 'ready')
check('manifest estimate equals complete joined message', first.manifest.estimatedTokens === estimateSceneWorkingSetTokens(first.workingSetMessage.messages.map((message) => message.content).join('\n\n')))
check('manifest and working-set message carry the same identity', first.manifest.workingSetHash === first.workingSet.workingSetHash && first.manifest.manifestHash === first.workingSetMessage.manifestHash && first.manifest.workingSetMessageHash === first.workingSetMessage.messageHash)
check('exact anchors expose actual source cards', first.manifest.sections.find((item) => item.id === 'exact_anchors')?.sourceCardIds.includes('card-hard') === true)
const second = compile()
check('same input is byte deterministic', JSON.stringify(first) === JSON.stringify(second))
try {
  compile({ recall: { ...recall, candidates: [] } })
  check('caller-supplied recall tamper is rejected', false)
} catch (error) {
  check('caller-supplied recall tamper is rejected', error instanceof SceneContextCompilerError && error.code === 'scene_working_set_recall_mismatch')
}
try {
  compile({ requiredSections: [{ id: 'world_state', text: '模型猜测的事实', required: true }] })
  check('free text cannot become required world canon', false)
} catch (error) {
  check('free text cannot become required world canon', error instanceof SceneContextCompilerError && error.code === 'scene_working_set_snapshot_mismatch')
}
try {
  compile({ sections: { exact_anchors: '伪造的原文锚点' } })
  check('fake exact anchor is rejected', false)
} catch (error) {
  check('fake exact anchor is rejected', error instanceof SceneContextCompilerError && error.code === 'scene_working_set_snapshot_mismatch')
}
try {
  compile({ sections: { world_state: '未经绑定的模型总结' } })
  check('unbound world hint is rejected', false)
} catch (error) {
  check('unbound world hint is rejected', error instanceof SceneContextCompilerError && error.code === 'scene_working_set_snapshot_mismatch')
}
const optionalMade = makeCard('card-optional', '上一场的普通背景记忆。'.repeat(20_000))
const optionalItem = {
  card: optionalMade.card,
  sourceSegments: [optionalMade.segment],
  sourceValidated: true,
  authority: {
    storyId: scope.storyId,
    projectId: scope.projectId,
    branchId: scope.branchId,
    branchLineage: scope.branchLineage,
    validityEpoch: scope.validityEpoch,
    storyRevision: optionalMade.card.storyRevision,
    headRevision: scope.headRevision,
    headHash: scope.headHash,
    sourceSnapshotHash: sceneRecallSourceSnapshotHash(optionalMade.card, [optionalMade.segment]),
    cardHash: optionalMade.card.cardHash,
    authorityHash: ''
  }
} satisfies SceneRecallCorpusItem
optionalItem.authority.authorityHash = sceneRecallAuthorityHash(optionalItem.authority as unknown as Record<string, unknown>)
const twoCorpus = [corpusItem, optionalItem]
const twoCardSetHash = sceneRecallSourceCardSetHash(twoCorpus)
const twoScope = { ...scope, expectedSourceCardSetHash: twoCardSetHash }
const twoSnapshot: SceneRecallCorpusSnapshot = { schemaVersion: 1, runId: 'r72-run', sceneId: twoScope.sceneId, scope: twoScope, sourceSnapshotHash: sceneRecallSourceSnapshotSetHash(twoCorpus), sourceCardSetHash: twoCardSetHash, corpus: twoCorpus }
const twoQuery: SceneRecallQuery = { ...recallQuery, scope: twoScope, hardDependencyKeys: ['card:card-hard', 'card:card-optional'] }
const twoRecall = buildDeterministicRecallIndex({ corpus: twoCorpus, query: twoQuery })
const requiredOnly = compile({ snapshot: twoSnapshot, recall: twoRecall, recallQuery: twoQuery, requiredCardIds: ['card-hard'], budgetTokens: 3072 })
check('required card is retained independently of optional same-section card', requiredOnly.workingSetMessage.messages[0]?.content.includes('[card-hard]') && !requiredOnly.workingSetMessage.messages[0]?.content.includes('[card-optional]') && requiredOnly.manifest.omitted.some((item) => item.cardId === 'card-optional'), JSON.stringify({ candidates: twoRecall.candidates.map((item) => item.cardId), omitted: twoRecall.omitted, sections: requiredOnly.manifest.sections, hasHard: requiredOnly.workingSetMessage.messages[0]?.content.includes('[card-hard]'), hasOptional: requiredOnly.workingSetMessage.messages[0]?.content.includes('[card-optional]') }))
const compact = compile({ budgetTokens: 3072, sections: { anti_repetition: 'R'.repeat(30_000) } })
check('optional sections are audibly omitted under budget', compact.manifest.sections.some((item) => item.omissionReason === 'budget_omitted'), JSON.stringify({ sections: compact.manifest.sections, omitted: compact.manifest.omitted }))
try {
  compile({ budgetTokens: 3072, hardConstraints: 'H'.repeat(50_000) })
  check('required overflow fails before provider', false)
} catch (error) {
  check('required overflow fails before provider', error instanceof SceneContextCompilerError && error.code === 'scene_working_set_required_overflow')
}
try {
  const blockedQuery = { ...recallQuery, hardDependencyKeys: ['card:missing-required-card'] }
  const blockedRecall = buildDeterministicRecallIndex({ corpus: snapshot.corpus, query: blockedQuery })
  compile({ recall: blockedRecall, recallQuery: blockedQuery })
  check('blocked recall fails closed', false)
} catch (error) {
  check('blocked recall fails closed', error instanceof SceneContextCompilerError && error.code === 'scene_working_set_recall_blocked')
}
try {
  compile({ requiredCardIds: ['missing-card'] })
  check('missing required card fails closed', false)
} catch (error) {
  check('missing required card fails closed', error instanceof SceneContextCompilerError && error.code === 'scene_working_set_required_source')
}
const tamperedSnapshot = { ...snapshot, sourceCardSetHash: sha('tampered') }
try {
  compile({ snapshot: tamperedSnapshot })
  check('source snapshot binding fails closed', false)
} catch (error) {
  check('source snapshot binding fails closed', error instanceof SceneContextCompilerError && error.code === 'scene_working_set_snapshot_mismatch')
}

console.log(`R72 scene working set: ${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exitCode = 1
