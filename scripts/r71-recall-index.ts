import { createHash } from 'node:crypto'
import {
  buildDeterministicRecallIndex,
  SCENE_RECALL_BM25_VERSION,
  SCENE_RECALL_TOKENIZER_VERSION,
  sceneRecallAuthorityHash,
  sceneRecallSourceCardSetHash,
  sceneRecallSourceSnapshotHash,
  type SceneRecallCorpusItem,
  type SceneRecallEmbeddingInput,
  type SceneRecallKnowledgeBoundary,
  type SceneRecallPayoffUrgency,
  type SceneRecallQuery
} from '../src/main/narrative/recallIndex'
import { sceneMemoryCardHash, stableSceneMemoryJson } from '../src/main/narrative/sceneMemoryCard'
import type { SceneMemoryCard, SceneMemorySourceSegment, SceneMemorySourceSpan } from '../src/shared/types'

let passed = 0
let failed = 0
const HEAD_REVISION = 21
const HEAD_HASH = sha('r71-head')

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1
  else {
    failed += 1
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function sourceMismatch(action: () => unknown): boolean {
  try { action(); return false } catch (error) { return error instanceof Error && (error as Error & { code?: string }).code === 'scene_recall_source_set_mismatch' }
}

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function makeCard(input: {
  id: string
  revision: number
  sceneId?: string
  text: string
  branchId?: string
  branchLineage?: string[]
  epoch?: number
  status?: SceneMemoryCard['status']
}): RecallItem {
  const branchId = input.branchId ?? 'main'
  const branchLineage = input.branchLineage ?? [branchId]
  const epoch = input.epoch ?? 1
  const sceneId = input.sceneId ?? `scene-${input.revision}`
  const contentHash = sha(input.text)
  const segment: SceneMemorySourceSegment = {
    segmentId: `${input.id}-segment`,
    content: input.text,
    contentHash,
    segmentRevision: 1,
    status: 'accepted',
    sceneId,
    commitId: `${input.id}-commit`,
    commitManifestHash: sha(`${input.id}-manifest`),
    chunkIndex: 0
  }
  const span: SceneMemorySourceSpan = {
    spanId: `${input.id}-span`,
    segmentId: segment.segmentId,
    segmentHash: segment.contentHash,
    segmentRevision: segment.segmentRevision,
    manifestHash: segment.commitManifestHash,
    startUtf16: 0,
    endUtf16: input.text.length,
    text: input.text,
    spanHash: contentHash
  }
  const card: SceneMemoryCard = {
    schemaVersion: 1,
    status: input.status ?? 'canonical',
    cardId: input.id,
    storyId: 'story-r71',
    projectId: 'project-r71',
    branchId,
    validityEpoch: epoch,
    storyRevision: input.revision,
    runId: `${input.id}-run`,
    sceneId,
    sceneOrder: input.revision,
    contractId: 'contract-r71',
    contractHash: sha('contract-r71'),
    sceneContentHash: contentHash,
    commitManifestHash: segment.commitManifestHash,
    stateDeltaHash: sha(`${input.id}-delta`),
    povCharacterId: null,
    participants: [],
    locations: [],
    objects: [],
    dramaticQuestion: null,
    valueShift: null,
    decisiveAction: null,
    turn: null,
    cost: null,
    factsEstablished: [],
    beliefChanges: [],
    relationshipChanges: [],
    threads: [],
    motifs: [],
    distinctivePhrases: [],
    sourceSegmentIds: [segment.segmentId],
    sourceSpans: [span],
    embedding: { status: 'unavailable', version: null, modelId: null, dimensions: null, vectorHash: null },
    fieldEvidence: {},
    cardHash: '',
    createdAt: input.revision
  }
  card.cardHash = sceneMemoryCardHash(card)
  const authority = {
    storyId: card.storyId,
    projectId: card.projectId,
    branchId: card.branchId,
    branchLineage,
    validityEpoch: card.validityEpoch,
    storyRevision: card.storyRevision,
    headRevision: HEAD_REVISION,
    headHash: HEAD_HASH,
    sourceSnapshotHash: '',
    cardHash: card.cardHash,
    authorityHash: ''
  }
  authority.sourceSnapshotHash = sceneRecallSourceSnapshotHash(card, [segment])
  authority.authorityHash = sceneRecallAuthorityHash(authority)
  return { card, sourceSegments: [segment], sourceValidated: true, authority }
}

function query(overrides: Partial<SceneRecallQuery> = {}): SceneRecallQuery {
  return {
    scope: { storyId: 'story-r71', projectId: 'project-r71', branchId: 'main', branchLineage: ['main'], validityEpoch: 1, storyRevision: HEAD_REVISION, sceneId: 'scene-current', headRevision: HEAD_REVISION, headHash: HEAD_HASH, expectedSourceCardSetHash: sha('missing-source-set') },
    tokenizerVersion: SCENE_RECALL_TOKENIZER_VERSION,
    bm25Version: SCENE_RECALL_BM25_VERSION,
    topK: 6,
    ...overrides
  }
}

type RecallItem = SceneRecallCorpusItem & { stale?: boolean; retracted?: boolean }

function build(corpus: readonly RecallItem[], overrides: Partial<SceneRecallQuery> = {}) {
  const base = query(overrides)
  return buildDeterministicRecallIndex({ corpus, query: { ...base, scope: { ...base.scope, expectedSourceCardSetHash: sceneRecallSourceCardSetHash(corpus) } } })
}

function authorityMetadata(item: RecallItem, fields: Record<string, unknown>): Record<string, unknown> {
  const value = {
    ...fields,
    sourceCardHash: item.card.cardHash,
    evidenceHash: item.card.sourceSpans[0]!.spanHash,
    storyId: item.card.storyId,
    projectId: item.card.projectId,
    branchId: item.card.branchId,
    validityEpoch: item.card.validityEpoch,
    storyRevision: item.card.storyRevision,
    headRevision: HEAD_REVISION,
    headHash: HEAD_HASH,
    authorityHash: ''
  }
  value.authorityHash = sceneRecallAuthorityHash(value)
  return value
}

function payoffUrgency(item: RecallItem, value: number): SceneRecallPayoffUrgency {
  const base = authorityMetadata(item, { value })
  return base as unknown as SceneRecallPayoffUrgency
}

function embeddingSignal(input: {
  item: RecallItem
  status: SceneRecallEmbeddingInput['status']
  version: string | null
  similarity?: number
  vector?: readonly number[]
  dimensions: number | null
}): SceneRecallEmbeddingInput {
  const vectorHash = input.vector ? sha(stableSceneMemoryJson(input.vector)) : null
  const base = {
    status: input.status,
    version: input.version,
    ...(input.similarity === undefined ? {} : { similarity: input.similarity }),
    ...(input.vector === undefined ? {} : { vector: input.vector }),
    dimensions: input.dimensions,
    vectorHash,
    sourceCardHash: input.item.card.cardHash,
    storyId: input.item.card.storyId,
    projectId: input.item.card.projectId,
    branchId: input.item.card.branchId,
    validityEpoch: input.item.card.validityEpoch,
    storyRevision: input.item.card.storyRevision,
    headRevision: HEAD_REVISION,
    headHash: HEAD_HASH
  }
  return { ...base, authorityHash: sceneRecallAuthorityHash(base) }
}

function knowledge(item: RecallItem, status: SceneRecallKnowledgeBoundary['status'], povCharacterId: string | null, unknownEntityIds: string[] = []): SceneRecallKnowledgeBoundary {
  return authorityMetadata(item, { status, povCharacterId, unknownEntityIds }) as unknown as SceneRecallKnowledgeBoundary
}

function refreshAuthority(item: RecallItem, patch: Record<string, unknown> = {}): void {
  item.authority = { ...item.authority, ...patch, authorityHash: '' }
  item.authority.authorityHash = sceneRecallAuthorityHash(item.authority)
}

function run(): void {
  const corpus: RecallItem[] = []
  for (let revision = 1; revision <= 20; revision += 1) {
    corpus.push(makeCard({ id: `card-${String(revision).padStart(2, '0')}`, revision, text: `第${revision}场近期事件与普通动作。` }))
  }
  const remote = makeCard({ id: 'card-remote-callback', revision: 1, text: '很久以前埋下的回调：北门钥匙仍在约定地点。' })
  remote.hardDependencies = [authorityMetadata(remote, { key: 'callback:key-return', kind: 'callback' }) as never]
  remote.payoffUrgency = payoffUrgency(remote, 1)
  corpus.push(remote)
  const noisyRecent = corpus[19]!
  noisyRecent.embedding = embeddingSignal({ item: noisyRecent, status: 'ready', version: 'embed-v1', similarity: 1, dimensions: null })

  const first = build(corpus, { hardDependencyKeys: ['callback:key-return'], queryText: '钥匙回调' })
  const second = build([...corpus].reverse(), { hardDependencyKeys: ['callback:key-return'], queryText: '钥匙回调' })
  check('remote hard callback enters top six', first.candidates.some((candidate) => candidate.cardId === remote.card.cardId))
  check('hard dependency outranks recent semantic match', first.candidates[0]?.cardId === remote.card.cardId)
  const tamperedPayoff = { ...remote, payoffUrgency: { ...remote.payoffUrgency!, value: 999 } }
  const tamperedPayoffResult = build([tamperedPayoff])
  check('tampered payoff urgency is reduced to zero', tamperedPayoffResult.candidates[0]?.sortTuple[1] === 0)
  const tamperedDependency = { ...(remote.hardDependencies![0] as unknown as Record<string, unknown>), storyRevision: 2, authorityHash: '' }
  tamperedDependency.authorityHash = sceneRecallAuthorityHash(tamperedDependency)
  const tamperedRevisionResult = build([{ ...remote, hardDependencies: [tamperedDependency] as never }])
  check('metadata revision tamper is rejected', tamperedRevisionResult.candidates.length === 0 && tamperedRevisionResult.omitted[0]?.reason === 'invalid_source')
  check('same corpus/query has byte-identical result', stableSceneMemoryJson(first) === stableSceneMemoryJson(second))
  check('same corpus/query has identical query/index hashes', first.queryHash === second.queryHash && first.indexHash === second.indexHash)
  check('tuple is integer-valued and deterministic', first.candidates.every((candidate) => candidate.sortTuple.slice(0, 9).every(Number.isInteger)))
  check('result is capped at six candidates', first.candidates.length === 6)
  check('result is ready when required hard sources are present', first.status === 'ready')
  const sourceTampered = { ...corpus[0]!, card: { ...corpus[0]!.card, cardHash: sha('tampered-source-card') } }
  const originalSourceSetHash = sceneRecallSourceCardSetHash([corpus[0]!])
  check('source-card mutation is rejected before selection', sourceMismatch(() => buildDeterministicRecallIndex({ corpus: [sourceTampered], query: query({ scope: { ...query().scope, expectedSourceCardSetHash: originalSourceSetHash } }) })))
  const sourceOriginalResult = build([corpus[0]!])
  check('query hash is content-addressed', sourceOriginalResult.queryHash === build([corpus[0]!]).queryHash)
  const originalCorpusHash = sceneRecallSourceCardSetHash(corpus)
  check('source-set deletion is rejected before selection', sourceMismatch(() => buildDeterministicRecallIndex({ corpus: corpus.slice(0, -1), query: query({ scope: { ...query().scope, expectedSourceCardSetHash: originalCorpusHash } }) })))
  check('source-set addition is rejected before selection', sourceMismatch(() => buildDeterministicRecallIndex({ corpus: [...corpus, makeCard({ id: 'card-added', revision: 7, text: '新增来源。' })], query: query({ scope: { ...query().scope, expectedSourceCardSetHash: originalCorpusHash } }) })))
  const staleSource = { ...corpus[0]!, stale: true }
  check('source-set stale mutation is rejected before selection', sourceMismatch(() => buildDeterministicRecallIndex({ corpus: [staleSource, ...corpus.slice(1)], query: query({ scope: { ...query().scope, expectedSourceCardSetHash: originalCorpusHash } }) })))
  const unicodeCard = makeCard({ id: 'card-unicode', revision: 8, text: 'ＡＢＣ İSTANBUL 的线索。' })
  const unicodeResult = build([unicodeCard], { queryText: 'abc i\u0307stanbul' })
  check('NFKC and stable Unicode lower make fullwidth/Turkish text searchable', (unicodeResult.candidates[0]?.sortTuple[6] ?? 0) > 0)
  const composedQuery = build([unicodeCard], { queryText: 'é' })
  const decomposedQuery = build([unicodeCard], { queryText: 'e\u0301' })
  check('Unicode composed/decomposed query hashes are stable', composedQuery.queryHash === decomposedQuery.queryHash)

  const stale = makeCard({ id: 'card-stale', revision: 8, text: '失效的旧信息。' })
  stale.stale = true
  const retracted = makeCard({ id: 'card-retracted', revision: 9, text: '已撤回的信息。' })
  retracted.retracted = true
  const oldEpoch = makeCard({ id: 'card-old-epoch', revision: 10, text: '旧 epoch 信息。', epoch: 2 })
  const current = makeCard({ id: 'card-current', revision: 21, text: '当前场景信息。', sceneId: 'scene-current' })
  const injected = makeCard({ id: 'card-injected', revision: 11, text: '已经注入的信息。' })
  const wrongBranch = makeCard({ id: 'card-wrong-branch', revision: 12, text: '无关分支信息。', branchId: 'other' })
  const unknownPov = makeCard({ id: 'card-unknown-pov', revision: 13, text: '角色未知的信息。' })
  unknownPov.povKnowledge = knowledge(unknownPov, 'unknown', 'pov', ['secret-entity'])
  const unknownHard = makeCard({ id: 'card-unknown-hard', revision: 14, text: '来源不明的硬事实。' })
  unknownHard.hardDependencies = [authorityMetadata(unknownHard, { key: 'hard:unknown', kind: 'fact' }) as never]
  unknownHard.unknownHardSource = true
  const filtered = build([stale, retracted, oldEpoch, current, injected, wrongBranch, unknownPov, unknownHard], { alreadyInjectedCardIds: [injected.card.cardId], povCharacterId: 'pov', hardDependencyKeys: ['hard:unknown'] })
  check('stale/retracted/old epoch/current/injected/branch-invalid cards leak zero', filtered.candidates.length === 0, stableSceneMemoryJson(filtered))
  check('unknown hard source is fail-closed', filtered.omitted.some((item) => item.cardId === unknownHard.card.cardId && item.reason === 'unknown_hard_source'), stableSceneMemoryJson(filtered.omitted))
  check('POV-unknown card is omitted', filtered.omitted.some((item) => item.cardId === unknownPov.card.cardId && item.reason === 'knowledge_boundary'))
  check('all filtered cards have explicit omission reasons', filtered.omitted.length === 8 && filtered.omitted.every((item) => item.reason.length > 0), stableSceneMemoryJson(filtered.omitted))
  const legacy = makeCard({ id: 'card-legacy', revision: 15, text: '没有可验证来源的旧卡。', status: 'legacy_unverified' })
  const legacyResult = build([legacy])
  check('legacy cards retain an explicit legacy omission reason', legacyResult.omitted[0]?.reason === 'legacy_unverified')

  const ancestor = makeCard({ id: 'card-ancestor', revision: 4, text: '祖先分支的因果前置。', branchId: 'main' })
  const branchResult = build([ancestor], { scope: { ...query().scope, branchId: 'branch-a', branchLineage: ['main', 'branch-a'] } })
  check('explicit branch lineage permits ancestor candidate', branchResult.candidates.some((candidate) => candidate.cardId === ancestor.card.cardId))
  const noLineage = build([ancestor], { scope: { ...query().scope, branchId: 'branch-a', branchLineage: ['branch-a'] } })
  check('missing branch lineage fails closed', noLineage.candidates.length === 0)
  const sibling = makeCard({ id: 'card-sibling', revision: 4, text: '兄弟分支信息。', branchId: 'branch-sibling', branchLineage: ['main', 'branch-sibling'] })
  const siblingResult = build([sibling], { scope: { ...query().scope, branchId: 'branch-b', branchLineage: ['main', 'branch-a', 'branch-b'] } })
  check('sibling branch is not admitted by includes-only matching', siblingResult.candidates.length === 0)

  const causalSeed = makeCard({ id: 'card-causal-seed', revision: 2, text: '因果起点。' })
  const causalParent = makeCard({ id: 'card-causal-parent', revision: 3, text: '直接因果前置。' })
  causalParent.causalEdges = [authorityMetadata(causalParent, { fromCardId: causalParent.card.cardId, toCardId: causalSeed.card.cardId, relationType: 'causes' }) as never]
  const causalGrand = makeCard({ id: 'card-causal-grand', revision: 4, text: '两跳因果前置。' })
  causalGrand.causalEdges = [authorityMetadata(causalGrand, { fromCardId: causalGrand.card.cardId, toCardId: causalParent.card.cardId, relationType: 'pays_off' }) as never]
  const causalDepends = makeCard({ id: 'card-causal-depends', revision: 5, text: '依赖关系前置。' })
  causalDepends.causalEdges = [authorityMetadata(causalDepends, { fromCardId: causalDepends.card.cardId, toCardId: causalSeed.card.cardId, relationType: 'depends_on' }) as never]
  const causalResult = build([causalSeed, causalParent, causalGrand, causalDepends], { causalSeedCardIds: [causalSeed.card.cardId] })
  check('all causal relations traverse predecessor direction', causalResult.candidates.find((candidate) => candidate.cardId === causalParent.card.cardId)?.sortTuple[2] === 2 && causalResult.candidates.find((candidate) => candidate.cardId === causalGrand.card.cardId)?.sortTuple[2] === 1 && causalResult.candidates.find((candidate) => candidate.cardId === causalDepends.card.cardId)?.sortTuple[2] === 2)
  const proseOnly = makeCard({ id: 'card-prose-only', revision: 5, text: '这段文字声称它导致了因果起点，但没有权威边。' })
  const proseResult = build([proseOnly], { causalSeedCardIds: [causalSeed.card.cardId] })
  check('free text cannot create causal score', proseResult.candidates[0]?.sortTuple[2] === 0)
  const proseHard = makeCard({ id: 'card-prose-hard', revision: 6, text: '文字声称必须回调钥匙，但没有权威依赖。' })
  const proseHardResult = build([proseHard], { hardDependencyKeys: ['callback:key-return'] })
  check('free text cannot create hard dependency', proseHardResult.status === 'blocked_required_sources' && proseHardResult.candidates.length === 0 && proseHardResult.blockedHardDependencies.includes('callback:key-return'))

  const embeddingFallback = makeCard({ id: 'card-embedding', revision: 5, text: '相似内容但不是硬事实。' })
  embeddingFallback.embedding = embeddingSignal({ item: embeddingFallback, status: 'ready', version: 'old-version', similarity: 1, dimensions: null })
  const unavailable = makeCard({ id: 'card-unavailable', revision: 6, text: '不可用向量。' })
  unavailable.embedding = embeddingSignal({ item: unavailable, status: 'unavailable', version: null, similarity: 1, dimensions: null })
  const embeddingResult = build([embeddingFallback, unavailable], { embedding: { version: 'embed-v1' }, queryText: '相似内容' })
  check('embedding version mismatch/unavailable score zero', embeddingResult.candidates.every((candidate) => candidate.sortTuple[7] === 0))
  check('index hash changes when candidate metadata changes', embeddingResult.indexHash !== first.indexHash)
  const vectorCard = makeCard({ id: 'card-vector', revision: 7, text: '向量候选。' })
  const vector = [0.5, 0.5]
  vectorCard.embedding = embeddingSignal({ item: vectorCard, status: 'ready', version: 'embed-v1', vector, dimensions: 2 })
  const vectorResult = build([vectorCard], { embedding: { version: 'embed-v1', vector: [0.5, 0.5] } })
  check('valid embedding contributes a bounded integer score', vectorResult.candidates[0]?.sortTuple[7] === 1000)
  const badVector = { ...vectorCard, embedding: { ...vectorCard.embedding, vectorHash: sha('tampered') } }
  const badVectorResult = build([badVector], { embedding: { version: 'embed-v1', vector: [0.5, 0.5] } })
  check('tampered embedding hash contributes zero', badVectorResult.candidates[0]?.sortTuple[7] === 0)
  const badEmbeddingScope = { ...vectorCard, embedding: { ...vectorCard.embedding, headHash: sha('wrong-head') } }
  const badEmbeddingScopeResult = build([badEmbeddingScope], { embedding: { version: 'embed-v1', vector: [0.5, 0.5] } })
  check('embedding scope tamper contributes zero', badEmbeddingScopeResult.candidates[0]?.sortTuple[7] === 0)

  const emoji = makeCard({ id: 'card-emoji', revision: 8, text: '前置😀后置。' })
  const emojiResult = build([emoji])
  check('UTF-16 span containing a surrogate pair is accepted', emojiResult.candidates[0]?.cardId === emoji.card.cardId)
  const brokenEmoji = { ...emoji, card: { ...emoji.card, sourceSpans: [{ ...emoji.card.sourceSpans[0]!, startUtf16: 3, endUtf16: 4 }] } }
  const brokenEmojiResult = build([brokenEmoji])
  check('UTF-16 span splitting a surrogate pair is rejected', brokenEmojiResult.candidates.length === 0 && brokenEmojiResult.omitted[0]?.reason === 'invalid_source')

  const duplicate = makeCard({ id: 'card-duplicate', revision: 7, text: '重复。' })
  const duplicateCopy = { ...duplicate, card: { ...duplicate.card, createdAt: 99 } }
  let duplicateRejected = false
  try { build([duplicate, duplicateCopy]) } catch { duplicateRejected = true }
  check('duplicate card identity is rejected', duplicateRejected)
}

run()
console.log(`R71 RecallIndex: ${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exitCode = 1
