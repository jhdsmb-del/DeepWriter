import { createHash } from 'node:crypto'
import * as RecallIndex from '../src/main/narrative/recallIndex'
import { sceneMemoryCardHash, stableSceneMemoryJson } from '../src/main/narrative/sceneMemoryCard'
import type {
  SceneMemoryCard,
  SceneMemorySourceSegment,
  SceneMemorySourceSpan,
  SceneRecallCorpusItem,
  SceneRecallEmbeddingInput,
  SceneRecallQuery
} from '../src/shared/types'

type Item = SceneRecallCorpusItem & { stale?: boolean; retracted?: boolean }
type SourceSetHasher = (corpus: readonly SceneRecallCorpusItem[]) => string

let passed = 0
let failed = 0
const HEAD_REVISION = 20
const HEAD_HASH = sha('r71-adversarial-head')

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1
  else {
    failed += 1
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function authorityHash(value: Record<string, unknown>): string {
  return RecallIndex.sceneRecallAuthorityHash(value)
}

function makeItem(id: string, revision: number, branchId = 'main', branchLineage = [branchId]): Item {
  const text = `${id} source text with callback and stable evidence.`
  const contentHash = sha(text)
  const segment: SceneMemorySourceSegment = {
    segmentId: `${id}-segment`, content: text, contentHash, segmentRevision: 1, status: 'accepted',
    sceneId: `scene-${revision}`, commitId: `${id}-commit`, commitManifestHash: sha(`${id}-manifest`), chunkIndex: 0
  }
  const span: SceneMemorySourceSpan = {
    spanId: `${id}-span`, segmentId: segment.segmentId, segmentHash: contentHash, segmentRevision: 1,
    manifestHash: segment.commitManifestHash, startUtf16: 0, endUtf16: text.length, text, spanHash: contentHash
  }
  const card: SceneMemoryCard = {
    schemaVersion: 1, status: 'canonical', cardId: id, storyId: 'story-r71-adv', projectId: 'project-r71-adv', branchId,
    validityEpoch: 1, storyRevision: revision, runId: `${id}-run`, sceneId: `scene-${revision}`, sceneOrder: revision,
    contractId: 'contract-r71-adv', contractHash: sha('contract-r71-adv'), sceneContentHash: contentHash,
    commitManifestHash: segment.commitManifestHash, stateDeltaHash: sha(`${id}-delta`), povCharacterId: null,
    participants: [], locations: [], objects: [], dramaticQuestion: null, valueShift: null, decisiveAction: null,
    turn: null, cost: null, factsEstablished: [], beliefChanges: [], relationshipChanges: [], threads: [], motifs: [],
    distinctivePhrases: [], sourceSegmentIds: [segment.segmentId], sourceSpans: [span],
    embedding: { status: 'unavailable', version: null, modelId: null, dimensions: null, vectorHash: null },
    fieldEvidence: {}, cardHash: '', createdAt: revision
  }
  card.cardHash = sceneMemoryCardHash(card)
  const authority = {
    storyId: card.storyId, projectId: card.projectId, branchId, branchLineage, validityEpoch: 1,
    storyRevision: revision, headRevision: HEAD_REVISION, headHash: HEAD_HASH, sourceSnapshotHash: '',
    cardHash: card.cardHash, authorityHash: ''
  }
  authority.sourceSnapshotHash = RecallIndex.sceneRecallSourceSnapshotHash(card, [segment])
  authority.authorityHash = authorityHash(authority)
  return { card, sourceSegments: [segment], sourceValidated: true, authority }
}

function metadata(item: Item, fields: Record<string, unknown>): Record<string, unknown> {
  const value = {
    ...fields, sourceCardHash: item.card.cardHash, evidenceHash: item.card.sourceSpans[0]!.spanHash,
    storyId: item.card.storyId, projectId: item.card.projectId, branchId: item.card.branchId,
    validityEpoch: 1, storyRevision: item.card.storyRevision, headRevision: HEAD_REVISION, headHash: HEAD_HASH, authorityHash: ''
  }
  value.authorityHash = authorityHash(value)
  return value
}

function embedding(item: Item, patch: Partial<SceneRecallEmbeddingInput> = {}): SceneRecallEmbeddingInput {
  const value: Record<string, unknown> = {
    status: 'ready', version: 'embed-v1', similarity: 1, dimensions: 2, vector: [0.5, 0.5],
    vectorHash: sha(stableSceneMemoryJson([0.5, 0.5])), sourceCardHash: item.card.cardHash,
    storyId: item.card.storyId, projectId: item.card.projectId, branchId: item.card.branchId,
    validityEpoch: 1, storyRevision: item.card.storyRevision, headRevision: HEAD_REVISION, headHash: HEAD_HASH,
    ...patch, authorityHash: ''
  }
  value.authorityHash = authorityHash(value)
  return value as unknown as SceneRecallEmbeddingInput
}

const sourceHasher = (RecallIndex as unknown as { sceneRecallSourceCardSetHash?: SourceSetHasher }).sceneRecallSourceCardSetHash

function query(corpus: readonly Item[], overrides: Partial<SceneRecallQuery> = {}): SceneRecallQuery {
  const scope: SceneRecallQuery['scope'] = {
    storyId: 'story-r71-adv', projectId: 'project-r71-adv', branchId: 'main', branchLineage: ['main'],
    validityEpoch: 1, storyRevision: HEAD_REVISION, sceneId: 'scene-current', headRevision: HEAD_REVISION,
    headHash: HEAD_HASH,
    expectedSourceCardSetHash: sourceHasher ? sourceHasher(corpus) : sha('missing-source-set-helper')
  }
  const base: SceneRecallQuery = {
    scope, tokenizerVersion: RecallIndex.SCENE_RECALL_TOKENIZER_VERSION,
    bm25Version: RecallIndex.SCENE_RECALL_BM25_VERSION, topK: 6
  }
  return { ...base, ...overrides, scope: { ...scope, ...(overrides.scope ?? {}) } }
}

function build(corpus: readonly Item[], overrides: Partial<SceneRecallQuery> = {}) {
  return RecallIndex.buildDeterministicRecallIndex({ corpus, query: query(corpus, overrides) })
}

function throwsCode(action: () => unknown, code: string): boolean {
  try { action(); return false } catch (error) { return error instanceof Error && (error as Error & { code?: string }).code === code }
}

function run(): void {
  check('source-card-set authority helper is exported', typeof sourceHasher === 'function')

  const base = makeItem('base', 1)
  const baseResult = build([base])
  const staleTamper = { ...base, stale: true }
  check('source-set tamper is rejected before selection', throwsCode(() => RecallIndex.buildDeterministicRecallIndex({ corpus: [staleTamper], query: query([base]) }), 'scene_recall_source_set_mismatch'))

  const first = makeItem('first', 1)
  const second = makeItem('second', 2)
  const ordered = build([first, second])
  const reversed = build([second, first])
  check('input order does not change source/query/index hashes', ordered.queryHash === reversed.queryHash && ordered.indexHash === reversed.indexHash)
  const termsA = build([base], { queryTerms: ['B', 'a'] })
  const termsB = build([base], { queryTerms: ['a', 'B'] })
  check('query-term order is canonicalized', termsA.queryHash === termsB.queryHash)

  const ancestor = makeItem('ancestor', 2, 'main')
  const ancestorResult = build([ancestor], { scope: { ...query([ancestor]).scope, branchId: 'branch-a', branchLineage: ['main', 'branch-a'] } })
  check('legal ancestor lineage is admitted', ancestorResult.candidates.some((candidate) => candidate.cardId === ancestor.card.cardId))
  const sibling = makeItem('sibling', 2, 'branch-b', ['main', 'branch-b'])
  const siblingResult = build([sibling], { scope: { ...query([sibling]).scope, branchId: 'branch-a', branchLineage: ['main', 'branch-a'] } })
  check('branch sibling injection is rejected', siblingResult.candidates.length === 0)

  const causalSeed = makeItem('seed', 1)
  const causalCandidate = makeItem('candidate', 2)
  const forger = makeItem('forger', 3)
  forger.causalEdges = [metadata(forger, { fromCardId: causalCandidate.card.cardId, toCardId: causalSeed.card.cardId, relationType: 'depends_on' }) as never]
  const forgedCausal = build([causalSeed, causalCandidate, forger], { causalSeedCardIds: [causalSeed.card.cardId] })
  check('third-party causal endpoint claim cannot create A-to-B score', forgedCausal.candidates.find((candidate) => candidate.cardId === causalCandidate.card.cardId)?.sortTuple[2] === 0)

  const hard = makeItem('hard', 2)
  hard.hardDependencies = [metadata(hard, { key: 'known:key', kind: 'callback' }) as never]
  const missingHard = build([hard], { hardDependencyKeys: ['missing:key'] })
  check('missing hard dependency blocks all candidates', missingHard.candidates.length === 0 && missingHard.blockedHardDependencies.includes('missing:key'))
  const metadataTampered = { ...hard, hardDependencies: [{ ...hard.hardDependencies![0]!, evidenceHash: sha('wrong-evidence') }] }
  const metadataResult = build([metadataTampered], { hardDependencyKeys: ['known:key'] })
  check('metadata evidence tamper cannot remain eligible', metadataResult.candidates.length === 0 && metadataResult.omitted.some((entry) => entry.reason === 'invalid_source'))

  const signal = makeItem('signal', 2)
  signal.embedding = embedding(signal)
  signal.payoffUrgency = metadata(signal, { value: 7 }) as never
  const signalResult = build([signal], { embedding: { version: 'embed-v1', vector: [0.5, 0.5] } })
  check('valid embedding and payoff authority contribute scores', signalResult.candidates[0]?.sortTuple[1] === 7 && signalResult.candidates[0]?.sortTuple[7] === 1000)
  const headTampered = { ...signal, embedding: { ...signal.embedding!, headHash: sha('wrong-head') } }
  const headResult = build([headTampered], { embedding: { version: 'embed-v1', vector: [0.5, 0.5] } })
  check('embedding head tamper degrades soft score', headResult.candidates[0]?.sortTuple[7] === 0)
  const payoffTampered = { ...signal, payoffUrgency: { ...signal.payoffUrgency!, value: 999 } }
  const payoffResult = build([payoffTampered], { embedding: { version: 'embed-v1', vector: [0.5, 0.5] } })
  check('payoff value tamper degrades soft score', payoffResult.candidates[0]?.sortTuple[1] === 0)

  const legacy = makeItem('legacy', 2)
  legacy.card = { ...legacy.card, status: 'legacy_unverified' }
  const legacyResult = build([legacy])
  check('legacy source has explicit legacy omission', legacyResult.omitted[0]?.reason === 'legacy_unverified')

  const callbackCorpus: Item[] = []
  for (let revision = 1; revision <= 20; revision += 1) callbackCorpus.push(makeItem(`scene-${revision}`, revision))
  const callback = makeItem('remote-callback', 1)
  callback.hardDependencies = [metadata(callback, { key: 'callback:key', kind: 'callback' }) as never]
  callbackCorpus.push(callback)
  const callbackResult = build(callbackCorpus, { hardDependencyKeys: ['callback:key'] })
  check('20-scene callback remains in capped top-six', callbackResult.candidates.length === 6 && callbackResult.candidates.some((candidate) => candidate.cardId === 'remote-callback'))
}

run()
console.log(`R71 RecallIndex adversarial: ${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exitCode = 1
