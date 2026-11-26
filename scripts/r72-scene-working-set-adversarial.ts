import { createHash } from 'node:crypto'
import { estimateTokens, type SceneContract, type SceneContextCompilerInput, type SceneMemoryCard, type SceneRecallAuthorityTag, type SceneRecallCandidate, type SceneRecallCausalEdge, type SceneRecallCorpusItem, type SceneRecallCorpusSnapshot, type SceneRecallHardDependency, type SceneRecallIndexResult, type SceneRecallKnowledgeBoundary, type SceneRecallQuery, type SceneRecallScope } from '../src/shared/types'
import { compileSceneWorkingSet, SceneContextCompilerError, sceneRecallSourceSnapshotSetHash, sceneWorkingSetHash } from '../src/main/narrative/sceneContextCompiler'
import { sceneMemoryCardHash, stableSceneMemoryJson } from '../src/main/narrative/sceneMemoryCard'
import { buildDeterministicRecallIndex, SCENE_RECALL_BM25_VERSION, SCENE_RECALL_TOKENIZER_VERSION, sceneRecallAuthorityHash, sceneRecallSourceCardSetHash, sceneRecallSourceSnapshotHash } from '../src/main/narrative/recallIndex'
import { buildSceneContractPrompt } from '../src/main/narrative/sceneContract'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1
  else {
    failed += 1
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function sha(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').digest('hex')
}

function stableSha(value: unknown): string {
  return createHash('sha256').update(stableSceneMemoryJson(value), 'utf8').digest('hex')
}

const HEAD_HASH = sha('r72-adversarial-head')
const GLOBAL_SNAPSHOT_HASH = sha('r72-adversarial-global-snapshot')
const STORY_ID = 'r72-adversarial-story'
const PROJECT_ID = 'r72-adversarial-project'
const RUN_ID = 'r72-adversarial-run'
const SCENE_ID = 'scene-current'

const scope: SceneRecallScope = {
  storyId: STORY_ID,
  projectId: PROJECT_ID,
  branchId: 'main',
  branchLineage: ['main'],
  validityEpoch: 1,
  storyRevision: 20,
  sceneId: SCENE_ID,
  headRevision: 20,
  headHash: HEAD_HASH,
  expectedSourceCardSetHash: sha('placeholder-source-set')
}

function makeCard(cardId: string, options: { branchId?: string; branchStoryRevision?: number; text?: string; action?: string } = {}): SceneMemoryCard {
  const branchId = options.branchId ?? 'main'
  const content = options.text ?? `已提交事实：${cardId} 在上一场完成了确认。`
  const contentHash = sha(content)
  const manifestHash = sha(`${cardId}:manifest`)
  const segmentId = `${cardId}:segment`
  const card: SceneMemoryCard = {
    schemaVersion: 1,
    status: 'canonical',
    cardId,
    storyId: STORY_ID,
    projectId: PROJECT_ID,
    branchId,
    validityEpoch: 1,
    storyRevision: options.branchStoryRevision ?? 19,
    runId: RUN_ID,
    sceneId: `scene-${cardId}`,
    sceneOrder: 19,
    contractId: 'contract-19',
    contractHash: sha('contract-19'),
    sceneContentHash: contentHash,
    commitManifestHash: manifestHash,
    stateDeltaHash: sha(`${cardId}:delta`),
    povCharacterId: null,
    participants: [],
    locations: [],
    objects: [],
    dramaticQuestion: null,
    valueShift: null,
    decisiveAction: options.action ?? `确认动作：${cardId}`,
    turn: null,
    cost: null,
    factsEstablished: [],
    beliefChanges: [],
    relationshipChanges: [],
    threads: [],
    motifs: [],
    distinctivePhrases: [],
    sourceSegmentIds: [segmentId],
    sourceSpans: [{
      spanId: `${cardId}:span`,
      segmentId,
      segmentHash: contentHash,
      segmentRevision: 1,
      manifestHash,
      startUtf16: 0,
      endUtf16: content.length,
      text: content,
      spanHash: contentHash
    }],
    embedding: { status: 'unavailable', version: null, modelId: null, dimensions: null, vectorHash: null },
    fieldEvidence: {},
    cardHash: '',
    createdAt: 1
  }
  card.cardHash = sceneMemoryCardHash(card)
  return card
}

function makeItem(card: SceneMemoryCard, options: { sourceSnapshotHash?: string; branchLineage?: readonly string[]; entityTags?: readonly SceneRecallAuthorityTag[]; hardDependencies?: readonly SceneRecallHardDependency[]; povKnowledge?: SceneRecallKnowledgeBoundary; causalEdges?: readonly SceneRecallCausalEdge[] } = {}): SceneRecallCorpusItem {
  const segment = {
    segmentId: card.sourceSegmentIds[0]!,
    content: card.sourceSpans[0]!.text,
    contentHash: card.sourceSpans[0]!.spanHash,
    segmentRevision: 1,
    status: 'accepted' as const,
    sceneId: card.sceneId,
    commitId: `${card.cardId}:commit`,
    commitManifestHash: card.commitManifestHash,
    chunkIndex: 0
  }
  const sourceSnapshotHash = options.sourceSnapshotHash ?? sceneRecallSourceSnapshotHash(card, [segment])
  const authority = {
    storyId: STORY_ID,
    projectId: PROJECT_ID,
    branchId: card.branchId,
    branchLineage: options.branchLineage ?? [card.branchId],
    validityEpoch: 1,
    storyRevision: card.storyRevision,
    headRevision: 20,
    headHash: HEAD_HASH,
    sourceSnapshotHash,
    cardHash: card.cardHash,
    authorityHash: ''
  }
  authority.authorityHash = sceneRecallAuthorityHash(authority)
  return { card, sourceValidated: true, sourceSegments: [segment], authority, entityTags: options.entityTags, hardDependencies: options.hardDependencies, povKnowledge: options.povKnowledge, causalEdges: options.causalEdges }
}

function makeCandidate(item: SceneRecallCorpusItem, reasonCodes: SceneRecallCandidate['reasonCodes'] = ['recent_tail']): SceneRecallCandidate {
  return { cardId: item.card.cardId, card: item.card, sortTuple: [0, 0, 0, 0, 0, 0, 0, 0, 0, item.card.cardId], reasonCodes }
}

function makeRecall(items: readonly SceneRecallCorpusItem[], options: { query?: Partial<SceneRecallQuery>; queryHash?: string; indexHash?: string } = {}): SceneRecallIndexResult {
  const snapshot = makeSnapshot(items)
  const query = makeQuery(snapshot, options.query)
  const actual = buildDeterministicRecallIndex({ corpus: snapshot.corpus, query })
  return { ...actual, queryHash: options.queryHash ?? actual.queryHash, indexHash: options.indexHash ?? actual.indexHash }
}

function locationTag(item: SceneRecallCorpusItem, key = 'room'): SceneRecallAuthorityTag {
  const card = item.card
  const tag = {
    key,
    kind: 'object' as const,
    sourceCardHash: card.cardHash,
    evidenceHash: card.sourceSpans[0]!.spanHash,
    storyId: STORY_ID,
    projectId: PROJECT_ID,
    branchId: card.branchId,
    validityEpoch: 1,
    storyRevision: card.storyRevision,
    headRevision: 20,
    headHash: HEAD_HASH,
    authorityHash: ''
  }
  tag.authorityHash = sceneRecallAuthorityHash(tag)
  return tag
}

function objectDependency(item: SceneRecallCorpusItem, key = 'shared'): SceneRecallHardDependency {
  const card = item.card
  const dependency = {
    key: `object:${key}`,
    kind: 'object' as const,
    sourceCardHash: card.cardHash,
    evidenceHash: card.sourceSpans[0]!.spanHash,
    storyId: STORY_ID,
    projectId: PROJECT_ID,
    branchId: card.branchId,
    validityEpoch: 1,
    storyRevision: card.storyRevision,
    headRevision: 20,
    headHash: HEAD_HASH,
    authorityHash: ''
  }
  dependency.authorityHash = sceneRecallAuthorityHash(dependency)
  return dependency
}

function knownPov(item: SceneRecallCorpusItem, povCharacterId = 'hero'): SceneRecallKnowledgeBoundary {
  const card = item.card
  const boundary = {
    status: 'known' as const,
    povCharacterId,
    sourceCardHash: card.cardHash,
    evidenceHash: card.sourceSpans[0]!.spanHash,
    storyId: STORY_ID,
    projectId: PROJECT_ID,
    branchId: card.branchId,
    validityEpoch: 1,
    storyRevision: card.storyRevision,
    headRevision: 20,
    headHash: HEAD_HASH,
    authorityHash: ''
  }
  boundary.authorityHash = sceneRecallAuthorityHash(boundary)
  return boundary
}

function causalEdge(item: SceneRecallCorpusItem, toCardId: string): SceneRecallCausalEdge {
  const card = item.card
  const edge = {
    fromCardId: card.cardId,
    toCardId,
    relationType: 'depends_on' as const,
    sourceCardHash: card.cardHash,
    evidenceHash: card.sourceSpans[0]!.spanHash,
    storyId: STORY_ID,
    projectId: PROJECT_ID,
    branchId: card.branchId,
    validityEpoch: 1,
    storyRevision: card.storyRevision,
    headRevision: 20,
    headHash: HEAD_HASH,
    authorityHash: ''
  }
  edge.authorityHash = sceneRecallAuthorityHash(edge)
  return edge
}

function makeSnapshot(items: readonly SceneRecallCorpusItem[], options: { sourceSnapshotHash?: string; scopeOverride?: Partial<SceneRecallScope> } = {}): SceneRecallCorpusSnapshot {
  const sourceCardSetHash = sceneRecallSourceCardSetHash(items)
  const nextScope: SceneRecallScope = { ...scope, ...options.scopeOverride, expectedSourceCardSetHash: sourceCardSetHash }
  return { schemaVersion: 1, runId: RUN_ID, sceneId: SCENE_ID, scope: nextScope, sourceSnapshotHash: options.sourceSnapshotHash ?? sceneRecallSourceSnapshotSetHash(items), sourceCardSetHash, corpus: [...items] }
}

function makeQuery(snapshot: SceneRecallCorpusSnapshot, options: Partial<SceneRecallQuery> = {}): SceneRecallQuery {
  return {
    tokenizerVersion: SCENE_RECALL_TOKENIZER_VERSION,
    bm25Version: SCENE_RECALL_BM25_VERSION,
    topK: 20,
    ...options,
    scope: snapshot.scope
  }
}

function makeSceneContract(): SceneContract {
  const base: Omit<SceneContract, 'frozenHash'> = {
    schemaVersion: 1,
    contractId: 'contract-current',
    sceneId: SCENE_ID,
    sectionId: 'section-1',
    revision: 1,
    order: 1,
    title: '当前场景契约',
    objective: '推进已确认目标',
    activeCharacterIds: ['hero'],
    characterIds: ['hero'],
    desire: '知道真相',
    obstacle: '证据不足',
    conflict: '必须在本场做出选择',
    requiredBeatIds: [],
    requiredFactIds: [],
    forbiddenFactIds: [],
    mustHappen: ['必须保持当前视角'],
    mustNotHappen: [],
    handoff: '交给下一场',
    threadActions: [],
    expectedStateChanges: [],
    targetChars: { min: 10, ideal: 20, max: 30 },
    acceptanceCriteria: ['完成选择'],
    sourceIds: ['answer-1'],
    outlineHash: sha('outline')
  }
  return { ...base, frozenHash: sha(JSON.stringify(base)) }
}

function baseInput(options: { items?: readonly SceneRecallCorpusItem[]; snapshot?: SceneRecallCorpusSnapshot; recall?: SceneRecallIndexResult; recallQuery?: SceneRecallQuery; hardConstraints?: string; contract?: SceneContextCompilerInput['contract']; sections?: SceneContextCompilerInput['sections']; requiredSections?: SceneContextCompilerInput['requiredSections']; requiredCardIds?: readonly string[]; budgetTokens?: number } = {}): SceneContextCompilerInput {
  const items = options.items ?? [makeItem(makeCard('card-one'))]
  const snapshot = options.snapshot ?? makeSnapshot(items)
  const recallQuery = options.recallQuery ?? makeQuery(snapshot)
  const recall = options.recall ?? buildDeterministicRecallIndex({ corpus: snapshot.corpus, query: recallQuery })
  return {
    snapshot,
    recall,
    recallQuery,
    contract: options.contract ?? makeSceneContract(),
    hardConstraints: options.hardConstraints ?? '保持当前视角；不得把未证实内容写成事实。',
    sections: options.sections,
    requiredSections: options.requiredSections,
    requiredCardIds: options.requiredCardIds,
    budgetTokens: options.budgetTokens
  }
}

function throwsCode(name: string, code: string, input: SceneContextCompilerInput): void {
  try {
    compileSceneWorkingSet(input)
    check(name, false, `expected ${code}`)
  } catch (error) {
    check(name, error instanceof SceneContextCompilerError && error.code === code, error instanceof Error ? error.message : String(error))
  }
}

const baseline = baseInput()
let providerCalls = 0
throwsCode('3071-token budget is rejected before provider', 'scene_working_set_invalid_budget', { ...baseline, budgetTokens: 3071 })
throwsCode('8193-token budget is rejected before provider', 'scene_working_set_invalid_budget', { ...baseline, budgetTokens: 8193 })
check('required overflow leaves provider seam untouched', providerCalls === 0)

const first = compileSceneWorkingSet(baseline)
const second = compileSceneWorkingSet(baseline)
check('same input is byte deterministic', JSON.stringify(first) === JSON.stringify(second))
check('hard and contract are first-class required sections', first.manifest.sections[0]?.required === true && first.manifest.sections[1]?.required === true)
check('final joined provider content is within declared budget', estimateTokens(first.workingSetMessage.messages[0]?.content ?? '') <= first.workingSet.budgetTokens)
check('compiler message is manifest-bound but not working-set-identical', first.workingSetMessage.manifestHash === first.manifest.manifestHash && first.workingSetMessage.messageHash !== first.workingSet.workingSetHash)
const { manifestHash: _manifestHash, ...manifestCoreForTamper } = first.manifest
check('manifest hash detects a changed budget field', sceneWorkingSetHash({ ...manifestCoreForTamper, budgetTokens: first.manifest.budgetTokens + 1 }) !== first.manifest.manifestHash)
check('working-set hash detects a changed identity field', sceneWorkingSetHash({ ...first.workingSet, storyRevision: first.workingSet.storyRevision + 1 }) !== first.workingSet.workingSetHash)
const changedBudget = compileSceneWorkingSet({ ...baseline, budgetTokens: 3072 })
check('recall topK and compiler token budget are independent', first.manifest.queryHash === changedBudget.manifest.queryHash && first.workingSet.budgetTokens !== changedBudget.workingSet.budgetTokens)

throwsCode('required content overflow blocks before provider', 'scene_working_set_required_overflow', { ...baseline, hardConstraints: 'H'.repeat(50_000), budgetTokens: 3072 })
throwsCode('NaN token budget is rejected before provider', 'scene_working_set_invalid_budget', { ...baseline, budgetTokens: Number.NaN })

try {
  const duplicate = makeItem(makeCard('duplicate-card'))
  makeSnapshot([duplicate, duplicate])
  check('duplicate source cards fail closed', false)
} catch {
  check('duplicate source cards fail closed', true)
}

try {
  const unicodeItem = makeItem(makeCard('unicode-card', { text: '🌧️ 旧钟的指针停在十一点。' }))
  const unicodeResult = compileSceneWorkingSet(baseInput({ items: [unicodeItem] }))
  check('Unicode source spans remain intact', unicodeResult.workingSetMessage.messages[0]!.content.includes('🌧️'))
} catch (error) {
  check('Unicode source spans remain intact', false, error instanceof Error ? error.message : String(error))
}

// An optional section appears before a required section. The compiler must reserve
// space for the later required section instead of admitting the optional section first.
const reserveBudget = 3072
const smallHard = 'H'
const smallContract = makeSceneContract()
const reserveSeedCard = makeItem(makeCard('reserve-seed', { action: '种子事实' }), { povKnowledge: knownPov(makeItem(makeCard('reserve-seed', { action: '种子事实' }))) })
const reserveWorldCard = makeItem(makeCard('reserve-world', { action: '必须事实' }), { entityTags: [locationTag(makeItem(makeCard('reserve-world', { action: '必须事实' })), 'shared')], hardDependencies: [objectDependency(makeItem(makeCard('reserve-world', { action: '必须事实' })))], povKnowledge: knownPov(makeItem(makeCard('reserve-world', { action: '必须事实' }))), causalEdges: [causalEdge(makeItem(makeCard('reserve-world', { action: '必须事实' })), 'reserve-seed')] })
const reservePovCard = makeItem(makeCard('reserve-pov', { text: '视角来源 '.repeat(12_000), action: '视角事实' }), { povKnowledge: knownPov(makeItem(makeCard('reserve-pov', { text: '视角来源 '.repeat(12_000), action: '视角事实' }))) })
const reserveItems = [reserveSeedCard, reserveWorldCard, reservePovCard]
const reserveSnapshot = makeSnapshot(reserveItems)
const reserveQuery = makeQuery(reserveSnapshot, { requiredCardIds: ['reserve-world'], objects: ['shared'], causalSeedCardIds: ['reserve-seed'], povCharacterId: 'hero' })
const reserveRecall = buildDeterministicRecallIndex({ corpus: reserveSnapshot.corpus, query: reserveQuery })
const hardTokens = estimateTokens(`## hard_constraints\n${smallHard}`)
const contractTokens = estimateTokens(`## scene_contract\n${buildSceneContractPrompt(smallContract)}`)
const worldText = 'W'.repeat(800)
const worldTokens = estimateTokens(`## world_state\n[reserve-world] 行动：必须事实`)
const optionalTarget = Math.max(1, reserveBudget - hardTokens - contractTokens - worldTokens + 8)
const optionalText = 'O'.repeat(optionalTarget * 4)
const reserveInput = baseInput({ items: reserveItems, snapshot: reserveSnapshot, recall: reserveRecall, recallQuery: reserveQuery, requiredCardIds: ['reserve-world'], budgetTokens: reserveBudget, hardConstraints: smallHard, contract: smallContract })
try {
  const result = compileSceneWorkingSet(reserveInput)
  const pov = result.manifest.sections.find((section) => section.id === 'pov_state')
  const requiredSection = result.manifest.sections.find((section) => section.sourceCardIds.includes('reserve-world'))
  check('optional section cannot crowd out later required section', requiredSection?.required === true && requiredSection.included === true && pov?.included === false && result.workingSet.estimatedTokens <= reserveBudget && estimateTokens(result.workingSetMessage.messages[0]?.content ?? '') <= reserveBudget, JSON.stringify({ requiredSection, pov, estimated: result.workingSet.estimatedTokens, joined: estimateTokens(result.workingSetMessage.messages[0]?.content ?? '') }))
} catch (error) {
  check('optional section cannot crowd out later required section', false, error instanceof Error ? error.message : String(error))
}

// One required card must not make every card in the same rendered section required.
const requiredCard = makeItem(makeCard('card-required', { action: '必要事实' }))
const optionalCard = makeItem(makeCard('card-optional', { text: '非必要来源 '.repeat(18_000), action: '非必要卡片' }))
const sameSectionItems = [
  { ...requiredCard, entityTags: [locationTag(requiredCard, 'shared')], hardDependencies: [objectDependency(requiredCard)] },
  { ...optionalCard, entityTags: [locationTag(optionalCard, 'shared')], hardDependencies: [objectDependency(optionalCard)] }
]
const sameSectionSnapshot = makeSnapshot(sameSectionItems)
const sameSectionQuery = makeQuery(sameSectionSnapshot, { requiredCardIds: ['card-required'], objects: ['shared'] })
const sameSectionRecall = buildDeterministicRecallIndex({ corpus: sameSectionSnapshot.corpus, query: sameSectionQuery })
try {
  const result = compileSceneWorkingSet(baseInput({ items: sameSectionItems, snapshot: sameSectionSnapshot, recall: sameSectionRecall, recallQuery: sameSectionQuery, requiredCardIds: ['card-required'], budgetTokens: 3072 }))
  const world = result.manifest.sections.find((section) => section.id === 'world_state')
  check('one required card does not promote sibling cards', world?.included === true && world.sourceCardIds.length === 1 && world.sourceCardIds[0] === 'card-required', JSON.stringify({ world, sections: result.manifest.sections }))
} catch (error) {
  check('one required card does not promote sibling cards', false, error instanceof Error ? error.message : String(error))
}

// The source card set hash is an authority fence, not a caller-supplied label.
const tamperedCorpus = makeItem(makeCard('card-one', { action: 'tampered model summary' }))
const originalSnapshot = makeSnapshot([makeItem(makeCard('card-one'))])
const tamperedSnapshot = { ...originalSnapshot, corpus: [tamperedCorpus] }
const originalQuery = makeQuery(originalSnapshot)
const originalRecall = buildDeterministicRecallIndex({ corpus: originalSnapshot.corpus, query: originalQuery })
throwsCode('snapshot source-card-set hash is recomputed', 'scene_working_set_snapshot_mismatch', baseInput({ items: [tamperedCorpus], snapshot: tamperedSnapshot, recall: originalRecall, recallQuery: originalQuery }))

const malformedRecall = makeRecall([makeItem(makeCard('card-one'))], { queryHash: 'forged-query', indexHash: 'forged-index' })
throwsCode('forged recall query/index hashes are rejected', 'scene_working_set_recall_mismatch', baseInput({ recall: malformedRecall }))

// A valid ancestor branch is explicitly allowed by branchLineage; exact branch
// equality would silently erase legitimate inherited scene memory.
const ancestor = makeItem(makeCard('card-ancestor', { branchId: 'base' }), { branchLineage: ['base'] })
const ancestorScopeSnapshot = makeSnapshot([ancestor], { scopeOverride: { branchId: 'main', branchLineage: ['base', 'main'] } })
const ancestorQuery = makeQuery(ancestorScopeSnapshot)
const ancestorRecall = buildDeterministicRecallIndex({ corpus: ancestorScopeSnapshot.corpus, query: ancestorQuery })
try {
  compileSceneWorkingSet(baseInput({ items: [ancestor], snapshot: ancestorScopeSnapshot, recall: ancestorRecall, recallQuery: ancestorQuery }))
  check('legal ancestor branch is accepted', true)
} catch (error) {
  check('legal ancestor branch is accepted', false, error instanceof Error ? error.message : String(error))
}

// Each card may be bound to its own immutable source snapshot; the corpus still
// has one recomputable source-card-set hash.
const itemA = makeItem(makeCard('card-a'))
const itemB = makeItem(makeCard('card-b'))
const perCardSnapshot = makeSnapshot([itemA, itemB])
const perCardQuery = makeQuery(perCardSnapshot)
const perCardRecall = buildDeterministicRecallIndex({ corpus: perCardSnapshot.corpus, query: perCardQuery })
try {
  const result = compileSceneWorkingSet(baseInput({ items: [itemA, itemB], snapshot: perCardSnapshot, recall: perCardRecall, recallQuery: perCardQuery }))
  check('per-card source snapshots remain legal under one global source set', result.workingSet.sourceCardSetHash === sceneRecallSourceCardSetHash([itemA, itemB]))
} catch (error) {
  check('per-card source snapshots remain legal under one global source set', false, error instanceof Error ? error.message : String(error))
}

const validSceneContract = makeSceneContract()
throwsCode('tampered SceneContract frozenHash is rejected', 'scene_working_set_snapshot_mismatch', baseInput({ contract: { ...validSceneContract, frozenHash: sha('tampered-contract') } }))

throwsCode('free-text required POV is not authority', 'scene_working_set_snapshot_mismatch', baseInput({ requiredSections: [{ id: 'pov_state', text: '模型总结：他其实知道凶手是谁。', required: true }] }))

// A model-supplied field without a source-bound evidence reference must not be
// promoted into the provider context as an established fact.
const unboundCard = makeItem(makeCard('card-unbound', { action: 'MODEL_SUMMARY_WITHOUT_EVIDENCE' }))
try {
  const result = compileSceneWorkingSet(baseInput({ items: [unboundCard] }))
  check('unbound model summary is not rendered as fact', !result.workingSetMessage.messages[0]!.content.includes('MODEL_SUMMARY_WITHOUT_EVIDENCE'))
} catch (error) {
  check('unbound model summary is not rendered as fact', error instanceof SceneContextCompilerError && error.code === 'scene_working_set_candidate_invalid')
}

// A new scene needs the adjacent committed ending even when semantic ranking
// spends its only slot on an older dependency. The excerpt, not the full old
// scene, shares the existing required Working Set budget and source fence.
{
  const ending = '23:17，林舟站在北窗旁，铜钥匙仍在右手，窗闩只合上一半。😀'
  const previous = makeItem(makeCard('adjacent-ending', { text: '旧场开头不可回灌。'.repeat(240) + ending }))
  const olderCard = makeCard('older-required', { text: '早先的必要凭据。' })
  olderCard.sceneOrder = 3; olderCard.cardHash = sceneMemoryCardHash(olderCard)
  const older = makeItem(olderCard)
  const contract = makeSceneContract()
  contract.order = 20
  const { frozenHash: _oldHash, ...contractBase } = contract
  contract.frozenHash = sha(JSON.stringify(contractBase))
  const snapshot = makeSnapshot([older, previous])
  const recallQuery = makeQuery(snapshot, { topK: 1, hardDependencyKeys: ['card:older-required'] })
  const recall = buildDeterministicRecallIndex({ corpus: snapshot.corpus, query: recallQuery })
  const input = baseInput({ snapshot, recallQuery, recall, contract, budgetTokens: 3072 })
  const result = compileSceneWorkingSet(input)
  const content = result.workingSetMessage.messages[0]!.content
  check('adjacent ending survives topK omission with exact time/position/object wording', recall.omitted.some(item => item.cardId === 'adjacent-ending' && item.reason === 'budget_omitted') && content.includes(ending) && content.includes('[previous-scene:'))
  check('adjacent ending is required source-bound recent prose, not another history projection', result.manifest.sections.some(section => section.id === 'recent_tail' && section.required && section.sourceCardIds.includes('adjacent-ending')) && content.includes(`commit:${previous.card.commitManifestHash}`) && content.includes('source:') && !content.includes(previous.sourceSegments![0]!.content))
  check('writer receives concise anti-restart instruction inside the same bounded set', content.includes('不重新开场') && result.workingSet.estimatedTokens <= 3072 && JSON.stringify(result) === JSON.stringify(compileSceneWorkingSet(input)))
  const quote = content.match(/\[previous-scene:[^\]]*source:(\d+)-(\d+)\/\d+\] ([^\n]*)/u)
  check('handoff code-point offsets locate the exact unmodified source including emoji', !!quote && Array.from(previous.sourceSegments![0]!.content).slice(Number(quote[1]), Number(quote[2])).join('') === quote[3] && Number(quote[2]) - Number(quote[1]) <= 640)

  const currentContent = '林舟没有离开北窗，接着把铜钥匙贴住窗闩。'
  const segment = { segmentId: 'same-scene-accepted', runId: RUN_ID, sceneId: SCENE_ID, contractHash: contract.frozenHash, status: 'accepted' as const,
    content: currentContent, contentHash: sha(currentContent), fullContentHash: sha(currentContent), sourceStartCp: 0, sourceEndCp: Array.from(currentContent).length,
    charCount: Array.from(currentContent).length, chunkIndex: 20, revision: 1 }
  const tailBase = { schemaVersion: 1 as const, sceneId: SCENE_ID, contractHash: contract.frozenHash, acceptedPrefixHash: sha('prefix'), segments: [segment] }
  const current = compileSceneWorkingSet({ ...input, snapshot: { ...snapshot, currentSceneTail: { ...tailBase, tailHash: stableSha(tailBase) } } }).workingSetMessage.messages[0]!.content
  check('same-scene accepted tail replaces opening handoff rather than growing context forever', current.includes(currentContent) && current.includes('current-scene:same-scene-accepted') && !current.includes('[previous-scene:'))

  const closingBase = { ...tailBase, closing: true as const, segments: [{ ...segment, sceneId: null }] }
  const closingTail = { ...closingBase, tailHash: stableSha(closingBase) }
  const closing = compileSceneWorkingSet({ ...input, snapshot: { ...snapshot, currentSceneTail: closingTail } }).workingSetMessage.messages[0]!.content
  check('authenticated closing tail keeps real unscoped identity without reissuing completed beats', closing.includes('所有已确认场景均已提交') && closing.includes('manuscript-tail:same-scene-accepted scene:unscoped') && !closing.includes('必须发生或推进'))
  throwsCode('closing flag is part of the existing tail source hash', 'scene_working_set_snapshot_mismatch', { ...input, snapshot: { ...snapshot, currentSceneTail: { ...closingTail, closing: undefined } } })

  const unknown = knownPov(previous)
  unknown.status = 'unknown' as typeof unknown.status
  unknown.authorityHash = sceneRecallAuthorityHash(unknown as unknown as Record<string, unknown>)
  const excluded = { ...previous, povKnowledge: unknown }
  const excludedSnapshot = makeSnapshot([excluded])
  const excludedQuery = makeQuery(excludedSnapshot, { povCharacterId: 'hero' })
  const excludedRecall = buildDeterministicRecallIndex({ corpus: excludedSnapshot.corpus, query: excludedQuery })
  const safe = compileSceneWorkingSet(baseInput({ snapshot: excludedSnapshot, recallQuery: excludedQuery, recall: excludedRecall, contract })).workingSetMessage.messages[0]!.content
  check('adjacent handoff cannot bypass knowledge filtering', !safe.includes(ending) && !safe.includes('[previous-scene:'))
}

console.log(`R72 scene working-set adversarial: ${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exitCode = 1
