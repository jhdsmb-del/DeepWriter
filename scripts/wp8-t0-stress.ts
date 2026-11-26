import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import fixtureManifest from './fixtures/wp8-t0-fixtures.json' with { type: 'json' }
import {
  createRepository,
  type ManuscriptSegmentRow,
  type Repository,
  type RepositoryTestHooks,
  type SceneMemoryProjectionInput,
  type RunRow
} from '../src/main/db/repository'
import {
  buildDeterministicRecallIndex,
  SCENE_RECALL_BM25_VERSION,
  SCENE_RECALL_TOKENIZER_VERSION,
  sceneRecallAuthorityHash,
  sceneRecallSourceCardSetHash,
  sceneRecallSourceSnapshotHash
} from '../src/main/narrative/recallIndex'
import type {
  SceneRecallCorpusItem,
  SceneRecallKnowledgeBoundary,
  SceneRecallQuery,
  SceneContractPlan
} from '../src/shared/types'
import {
  buildSceneMemoryCard,
  makeSceneMemorySourceSpan,
  sceneContentHashForSegments,
  sceneMemoryCardHash,
  sha256Text,
  sourceSpanEvidence,
  stableSceneMemoryJson
} from '../src/main/narrative/sceneMemoryCard'
import {
  compileSceneWorkingSet,
  sceneRecallSourceSnapshotSetHash
} from '../src/main/narrative/sceneContextCompiler'
import {
  buildSceneCompletionDecision,
  buildSceneContractPlan
} from '../src/main/narrative/sceneContract'
import {
  buildEmptyNarrativeStateDelta,
  stableNarrativeJson
} from '../src/main/narrative/stateDelta'
import {
  classifyAssistantOutput,
  manuscriptAcceptanceEvidenceIdentity,
  manuscriptSegmentHash
} from '../src/main/manuscript'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import { codePointLength } from '../src/shared/textMetrics'
import type {
  ManuscriptSegment,
  SceneCommitInput,
  SceneCommitManifest,
  SceneContract,
  SceneMemoryCard,
  SceneMemoryCardValidationContext,
  SceneMemorySourceSegment,
  SceneRecallCorpusSnapshot
} from '../src/shared/types'

type ScaleId = 'P10' | 'P30' | 'P100' | 'L20'
type RecallItem = SceneRecallCorpusItem & { stale?: boolean; retracted?: boolean }
type ScaleSpec = { id: ScaleId; sceneCount: number; targetChars?: number; constraintCount: number; gapCount: number }
type FixtureData = {
  spec: ScaleSpec
  storyId: string
  projectId: string
  branchId: 'main'
  headRevision: number
  headHash: string
  corpus: RecallItem[]
  callbackCardId: string
  staleCardId: string
  retractedCardId: string
  branchCardId: string
  aliasCardId: string
  timeJumpCardId: string
  gapDependencyKeys: string[]
  constraintCount: number
  gapCount: number
  syntheticChars: number
}
type CommitEnvelope = SceneCommitInput & { projection?: SceneMemoryProjectionInput }

const WARM_APPEND_COUNT = 19
const manifest = fixtureManifest as {
  schemaVersion: number
  fixtureId: string
  status: string
  qualityClaims: string
  realRequests: number
  scales: ScaleSpec[]
  coverage: string[]
}

let passed = 0
let failed = 0

function check(name: string, value: boolean, detail = ''): void {
  if (value) {
    passed += 1
    console.log(`  PASS ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function sha(value: unknown): string {
  const text = typeof value === 'string' ? value : stableSceneMemoryJson(value)
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function pad(value: number): string {
  return String(value).padStart(3, '0')
}

function makeContractPlan(scaleId: string): SceneContractPlan {
  const outline: GrillMeOutline = {
    title: `WP8 ${scaleId} 压力故事`,
    premise: '林舟在暴雨前抵达灯塔，必须守住北门钥匙的回调。',
    targetChars: 200,
    sections: [{
      id: 'section-1',
      title: '灯塔夜班',
      purpose: '完成抵达并留下可承接的决定。',
      targetChars: 200,
      beats: ['林舟抵达灯塔'],
      sourceSlotIds: []
    }]
  }
  const plan = buildSceneContractPlan({
    outline,
    outlineHash: grillMeOutlineHash(outline),
    outlineRevision: 1,
    answers: [],
    characterNames: ['林舟'],
    strongConstraints: { forbiddenTerms: [], mustKeep: [] }
  })
  const contract = plan.contracts[0]
  if (!contract) throw new Error(`missing contract for ${scaleId}`)
  return plan
}

function makeContract(scaleId: string): SceneContract {
  const contract = makeContractPlan(scaleId).contracts[0]
  if (!contract) throw new Error(`missing contract for ${scaleId}`)
  return contract
}

function sceneText(spec: ScaleSpec, revision: number, targetChars?: number): string {
  const base = revision === 1
    ? `第1场：林舟抵达灯塔，北门钥匙的回调被留在雨声里。`
    : revision === Math.max(2, Math.floor(spec.sceneCount / 2))
      ? `第${revision}场：三年后，林舟仍记得北门钥匙；舟哥这个别名只在旧信里出现。`
      : revision === spec.sceneCount
        ? `第${revision}场：远处的灯火重新亮起，林舟没有越过未知者的知识边界。`
        : `第${revision}场：林舟沿着旧堤岸观察灯塔，新的压力暂未解决。`
  if (!targetChars || codePointLength(base) >= targetChars) return base
  const filler = '补充压力事实：北门钥匙仍在灯塔，林舟沿旧堤岸记录连续性；此段为 synthetic advisory，不代表写作质量。'
  let expanded = base
  while (codePointLength(expanded) < targetChars) expanded += filler
  return Array.from(expanded).slice(0, targetChars).join('')
}

function sourceFor(input: {
  cardId: string
  sceneId: string
  revision: number
  text: string
  commitManifestHash: string
}): { segment: SceneMemorySourceSegment; span: ReturnType<typeof makeSceneMemorySourceSpan> } {
  const contentHash = sha256Text(input.text)
  const segment: SceneMemorySourceSegment = {
    segmentId: `${input.cardId}:segment`,
    content: input.text,
    contentHash,
    segmentRevision: 1,
    status: 'accepted',
    sceneId: input.sceneId,
    commitId: `${input.cardId}:commit`,
    commitManifestHash: input.commitManifestHash,
    chunkIndex: input.revision - 1
  }
  const span = makeSceneMemorySourceSpan({
    spanId: `${input.cardId}:span`,
    segmentId: segment.segmentId,
    segmentHash: contentHash,
    segmentRevision: segment.segmentRevision,
    manifestHash: input.commitManifestHash,
    content: input.text,
    startUtf16: 0,
    endUtf16: input.text.length
  })
  return { segment, span }
}

function makeCard(input: {
  storyId: string
  projectId: string
  branchId: string
  branchLineage: string[]
  headRevision: number
  headHash: string
  cardId: string
  sceneId: string
  revision: number
  epoch?: number
  text: string
}): RecallItem {
  const epoch = input.epoch ?? 1
  const contractId = `${input.cardId}:contract`
  const contractHash = sha(contractId)
  const commitManifestHash = sha(`${input.cardId}:manifest`)
  const stateDeltaHash = sha(`${input.cardId}:delta`)
  const source = sourceFor({
    cardId: input.cardId,
    sceneId: input.sceneId,
    revision: input.revision,
    text: input.text,
    commitManifestHash
  })
  const evidence = sourceSpanEvidence(source.span)
  const card = buildSceneMemoryCard({
    schemaVersion: 1,
    status: 'canonical',
    cardId: input.cardId,
    storyId: input.storyId,
    projectId: input.projectId,
    branchId: input.branchId,
    validityEpoch: epoch,
    storyRevision: input.revision,
    runId: `${input.cardId}:run`,
    sceneId: input.sceneId,
    sceneOrder: input.revision,
    contractId,
    contractHash,
    sceneContentHash: sceneContentHashForSegments([source.segment]),
    commitManifestHash,
    stateDeltaHash,
    povCharacterId: null,
    participants: [{ id: '林舟', role: '林舟', evidence: [evidence] }],
    locations: [],
    objects: [],
    dramaticQuestion: null,
    valueShift: null,
    decisiveAction: input.text.includes('抵达灯塔') ? '林舟抵达灯塔' : '林舟',
    turn: null,
    cost: null,
    factsEstablished: [{ factId: `${input.cardId}:fact`, statement: input.text, evidence: [evidence] }],
    beliefChanges: [],
    relationshipChanges: [],
    threads: [],
    motifs: [],
    distinctivePhrases: [],
    sourceSegments: [source.segment],
    sourceSpans: [source.span],
    fieldEvidence: { decisiveAction: [evidence] },
    expectedScope: { storyId: input.storyId, projectId: input.projectId, branchId: input.branchId },
    expectedValidityEpoch: epoch,
    expectedStoryRevision: input.revision,
    expectedContract: { contractId, contractHash },
    expectedBindings: { sceneContentHash: sceneContentHashForSegments([source.segment]), commitManifestHash, stateDeltaHash },
    ledgerClaims: [],
    createdAt: input.revision
  })
  const authority = {
    storyId: input.storyId,
    projectId: input.projectId,
    branchId: input.branchId,
    branchLineage: input.branchLineage,
    validityEpoch: epoch,
    storyRevision: input.revision,
    headRevision: input.headRevision,
    headHash: input.headHash,
    sourceSnapshotHash: sceneRecallSourceSnapshotHash(card, [source.segment]),
    cardHash: card.cardHash,
    authorityHash: ''
  }
  authority.authorityHash = sceneRecallAuthorityHash(authority)
  return { card, sourceSegments: [source.segment], sourceValidated: true, authority }
}

function metadata(item: RecallItem, fields: Record<string, unknown>): Record<string, unknown> {
  const value = {
    ...fields,
    sourceCardHash: item.card.cardHash,
    evidenceHash: item.card.sourceSpans[0]!.spanHash,
    storyId: item.card.storyId,
    projectId: item.card.projectId,
    branchId: item.card.branchId,
    validityEpoch: item.card.validityEpoch,
    storyRevision: item.card.storyRevision,
    headRevision: item.authority.headRevision,
    headHash: item.authority.headHash,
    authorityHash: ''
  }
  value.authorityHash = sceneRecallAuthorityHash(value)
  return value
}

function makeFixture(spec: ScaleSpec): FixtureData {
  const storyId = `wp8-${spec.id.toLowerCase()}-story`
  const projectId = `wp8-${spec.id.toLowerCase()}-project`
  const headRevision = spec.sceneCount + WARM_APPEND_COUNT
  const headHash = sha(`${storyId}:head:${headRevision}`)
  const corpus: RecallItem[] = []
  const callbackCardId = `${spec.id.toLowerCase()}:card:callback`
  const staleCardId = `${spec.id.toLowerCase()}:card:stale`
  const retractedCardId = `${spec.id.toLowerCase()}:card:retracted`
  const branchCardId = `${spec.id.toLowerCase()}:card:branch`
  const aliasRevision = Math.max(2, Math.floor(spec.sceneCount / 2))
  const aliasCardId = `${spec.id.toLowerCase()}:card:${pad(aliasRevision)}`
  const timeJumpCardId = aliasCardId
  for (let revision = 1; revision <= spec.sceneCount; revision += 1) {
    const cardId = revision === 1 ? callbackCardId : `${spec.id.toLowerCase()}:card:${pad(revision)}`
    const perSceneTarget = spec.targetChars === undefined ? undefined : Math.floor(spec.targetChars / spec.sceneCount) + (revision <= spec.targetChars % spec.sceneCount ? 1 : 0)
    const item = makeCard({
      storyId,
      projectId,
      branchId: 'main',
      branchLineage: ['main'],
      headRevision,
      headHash,
      cardId,
      sceneId: `scene-${pad(revision)}`,
      revision,
      text: sceneText(spec, revision, perSceneTarget)
    })
    corpus.push(item)
  }
  const callback = corpus.find((item) => item.card.cardId === callbackCardId)
  if (!callback) throw new Error('callback card missing')
  const constraintIds = Array.from({ length: spec.constraintCount }, (_, index) => `constraint:${spec.id}:${pad(index + 1)}`)
  const gapIds = Array.from({ length: spec.gapCount }, (_, index) => `gap:${spec.id}:${pad(index + 1)}`)
  callback.hardDependencies = [
    metadata(callback, { key: `callback:${spec.id}:north-gate`, kind: 'callback' }) as never,
    ...gapIds.map((key) => metadata(callback, { key, kind: 'callback' }) as never)
  ]
  callback.entityTags = constraintIds.map((key) => metadata(callback, { key, kind: 'entity' }) as never)
  callback.threadTags = gapIds.map((key) => metadata(callback, { key, kind: 'thread' }) as never)
  const stale = corpus.find((item) => item.card.storyRevision === Math.max(2, Math.floor(spec.sceneCount / 3))) ?? corpus[1]
  if (!stale) throw new Error('stale card missing')
  stale.stale = true
  const retracted = corpus.find((item) => item.card.storyRevision === Math.max(3, Math.floor(spec.sceneCount * 0.66))) ?? corpus[corpus.length - 1]
  if (!retracted) throw new Error('retracted card missing')
  retracted.retracted = true
  const branch = makeCard({
    storyId,
    projectId,
    branchId: 'branch-alt',
    branchLineage: ['main', 'branch-alt'],
    headRevision,
    headHash,
    cardId: branchCardId,
    sceneId: 'scene-branch-alt',
    revision: Math.max(2, Math.floor(spec.sceneCount / 4)),
    text: '林舟在另一条分支留下了相似但不应混入主线的旧决定。'
  })
  corpus.push(branch)
  return {
    spec,
    storyId,
    projectId,
    branchId: 'main',
    headRevision,
    headHash,
    corpus,
    callbackCardId,
    staleCardId: stale.card.cardId,
    retractedCardId: retracted.card.cardId,
    branchCardId,
    aliasCardId,
    timeJumpCardId,
    gapDependencyKeys: gapIds,
    constraintCount: callback.entityTags.length,
    gapCount: callback.threadTags.length,
    syntheticChars: corpus.filter((item) => item.card.branchId === 'main').reduce((total, item) => total + item.sourceSegments!.reduce((sum, segment) => sum + codePointLength(segment.content), 0), 0)
  }
}

function queryFor(data: FixtureData, corpus: readonly RecallItem[], overrides: Partial<SceneRecallQuery> = {}): SceneRecallQuery {
  return {
    scope: {
      storyId: data.storyId,
      projectId: data.projectId,
      branchId: data.branchId,
      branchLineage: ['main'],
      validityEpoch: 1,
      storyRevision: data.headRevision,
      sceneId: 'current-scene',
      headRevision: data.headRevision,
      headHash: data.headHash,
      expectedSourceCardSetHash: sceneRecallSourceCardSetHash(corpus)
    },
    hardDependencyKeys: [`callback:${data.spec.id}:north-gate`],
    tokenizerVersion: SCENE_RECALL_TOKENIZER_VERSION,
    bm25Version: SCENE_RECALL_BM25_VERSION,
    queryText: '北门钥匙 回调 舟哥',
    queryTerms: ['钥匙'],
    topK: Math.min(8, Math.max(1, corpus.length)),
    ...overrides
  }
}

function recall(data: FixtureData, corpus: readonly RecallItem[], overrides: Partial<SceneRecallQuery> = {}) {
  return buildDeterministicRecallIndex({ corpus, query: queryFor(data, corpus, overrides) })
}

function useSnapshot(data: FixtureData, corpus: readonly RecallItem[], query: SceneRecallQuery): SceneRecallCorpusSnapshot {
  return {
    schemaVersion: 1,
    runId: `wp8-${data.spec.id.toLowerCase()}-use-run`,
    sceneId: 'current-scene',
    scope: query.scope,
    sourceSnapshotHash: sceneRecallSourceSnapshotSetHash(corpus),
    sourceCardSetHash: sceneRecallSourceCardSetHash(corpus),
    corpus
  }
}

function runRecallAndUse(data: FixtureData): {
  recall: Record<string, unknown>
  use: Record<string, unknown>
  latency: { coldRebuildMs: number; warmAppendMs: number[] }
} {
  const baseQuery = queryFor(data, data.corpus)
  const coldStart = performance.now()
  const cold = buildDeterministicRecallIndex({ corpus: data.corpus, query: baseQuery })
  const coldRebuildMs = performance.now() - coldStart
  const reversed = buildDeterministicRecallIndex({ corpus: [...data.corpus].reverse(), query: { ...baseQuery, scope: { ...baseQuery.scope, expectedSourceCardSetHash: sceneRecallSourceCardSetHash([...data.corpus].reverse()) } } })
  check(`${data.spec.id} rebuild is byte deterministic`, stableSceneMemoryJson(cold) === stableSceneMemoryJson(reversed))
  check(`${data.spec.id} hard dependency ranks first`, cold.candidates[0]?.cardId === data.callbackCardId && cold.candidates[0]?.sortTuple[0] === 1, stableSceneMemoryJson(cold.candidates.slice(0, 2)))
  check(`${data.spec.id} stale/retracted/branch sources do not enter candidates`, !cold.candidates.some((candidate) => [data.staleCardId, data.retractedCardId, data.branchCardId].includes(candidate.cardId)))
  check(`${data.spec.id} delayed callback recall reaches topK`, cold.candidates.some((candidate) => candidate.cardId === data.callbackCardId))
  const visibilityQuery = queryFor(data, data.corpus, { hardDependencyKeys: [], queryText: '', queryTerms: [], topK: data.corpus.length })
  const visibilityIndex = buildDeterministicRecallIndex({ corpus: data.corpus, query: visibilityQuery })
  const productionVisibleIds = new Set(visibilityIndex.candidates.map((candidate) => candidate.cardId))
  check(`${data.spec.id} production visibility gate excludes stale/retracted`, visibilityIndex.status === 'ready' && !productionVisibleIds.has(data.staleCardId) && !productionVisibleIds.has(data.retractedCardId) && visibilityIndex.omitted.some((item) => item.cardId === data.staleCardId && item.reason === 'stale') && visibilityIndex.omitted.some((item) => item.cardId === data.retractedCardId && item.reason === 'retracted'))
  const gapQuery = queryFor(data, data.corpus, { hardDependencyKeys: data.gapDependencyKeys, queryText: '', queryTerms: [], topK: data.corpus.length })
  const gapIndex = buildDeterministicRecallIndex({ corpus: data.corpus, query: gapQuery })
  const gapCandidate = gapIndex.candidates.find((candidate) => candidate.cardId === data.callbackCardId)
  const gapItem = data.corpus.find((item) => item.card.cardId === data.callbackCardId)
  const matchedGapKeys = new Set((gapItem?.hardDependencies ?? []).map((dependency) => dependency.key).filter((key) => data.gapDependencyKeys.includes(key)))
  check(`${data.spec.id} remote dependency gaps are included and ranked`, gapIndex.status === 'ready' && gapIndex.candidates[0]?.cardId === data.callbackCardId && matchedGapKeys.size === data.gapDependencyKeys.length && gapCandidate !== undefined && data.headRevision - gapCandidate.card.storyRevision >= data.gapDependencyKeys.length, JSON.stringify({ gapCount: data.gapDependencyKeys.length, matched: matchedGapKeys.size, rank: gapIndex.candidates.findIndex((candidate) => candidate.cardId === data.callbackCardId) + 1 }))
  const aliasResult = recall(data, data.corpus, { hardDependencyKeys: [], queryText: '舟哥' })
  check(`${data.spec.id} alias text has lexical evidence`, aliasResult.candidates.some((candidate) => candidate.cardId === data.aliasCardId && (candidate.sortTuple[6] ?? 0) > 0))
  const timeResult = recall(data, data.corpus, { hardDependencyKeys: [], queryText: '三年后' })
  check(`${data.spec.id} time jump has lexical evidence`, timeResult.candidates.some((candidate) => candidate.cardId === data.timeJumpCardId && (candidate.sortTuple[6] ?? 0) > 0))
  const epochResult = recall(data, data.corpus, { hardDependencyKeys: [], scope: { ...baseQuery.scope, validityEpoch: 2 } })
  check(`${data.spec.id} invalid epoch has zero candidates`, epochResult.candidates.length === 0 && epochResult.omitted.filter((item) => item.reason === 'old_epoch').length === data.corpus.length)
  const known = makeCard({ storyId: data.storyId, projectId: data.projectId, branchId: 'main', branchLineage: ['main'], headRevision: data.headRevision, headHash: data.headHash, cardId: `${data.spec.id.toLowerCase()}:pov:known`, sceneId: 'scene-pov-known', revision: 2, text: '林舟知道灯塔的公开门。' })
  const secret = makeCard({ storyId: data.storyId, projectId: data.projectId, branchId: 'main', branchLineage: ['main'], headRevision: data.headRevision, headHash: data.headHash, cardId: `${data.spec.id.toLowerCase()}:pov:secret`, sceneId: 'scene-pov-secret', revision: 3, text: '林舟不知道的暗门秘密。' })
  const knownBoundary = { ...metadata(known, { status: 'known', povCharacterId: '林舟', unknownEntityIds: [] }) } as unknown as SceneRecallKnowledgeBoundary
  const secretBoundary = { ...metadata(secret, { status: 'unknown', povCharacterId: '林舟', unknownEntityIds: ['暗门'] }) } as unknown as SceneRecallKnowledgeBoundary
  known.povKnowledge = knownBoundary
  secret.povKnowledge = secretBoundary
  const povCorpus = [known, secret]
  const povResult = recall(data, povCorpus, { hardDependencyKeys: [], povCharacterId: '林舟', queryText: '暗门' })
  check(`${data.spec.id} POV leakage is zero`, !povResult.candidates.some((candidate) => candidate.cardId === secret.card.cardId) && povResult.omitted.some((item) => item.cardId === secret.card.cardId && item.reason === 'knowledge_boundary'))
  const warmAppendMs: number[] = []
  let current = [...data.corpus]
  for (let index = 1; index <= WARM_APPEND_COUNT; index += 1) {
    const revision = data.spec.sceneCount + index
    const next = makeCard({ storyId: data.storyId, projectId: data.projectId, branchId: 'main', branchLineage: ['main'], headRevision: data.headRevision, headHash: data.headHash, cardId: `${data.spec.id.toLowerCase()}:warm:${pad(index)}`, sceneId: `scene-warm-${pad(index)}`, revision, text: `热追加第${index}次：林舟保留北门钥匙的连续性。` })
    const nextCorpus = [...current, next]
    const start = performance.now()
    const result = recall(data, nextCorpus)
    warmAppendMs.push(performance.now() - start)
    check(`${data.spec.id} warm append ${index} remains ready`, result.status === 'ready' && result.candidates.some((candidate) => candidate.cardId === data.callbackCardId))
    current = nextCorpus
  }
  const useCorpus = data.corpus.filter((item) => productionVisibleIds.has(item.card.cardId))
  const useQuery = queryFor(data, useCorpus, { requiredCardIds: [data.callbackCardId] })
  const useRecall = buildDeterministicRecallIndex({ corpus: useCorpus, query: useQuery })
  const snapshot = useSnapshot(data, useCorpus, useQuery)
  const contract = makeContract(data.spec.id)
  const useStart = performance.now()
  const compiled = compileSceneWorkingSet({
    snapshot,
    recall: useRecall,
    recallQuery: useQuery,
    contract,
    hardConstraints: ['北门钥匙回调必须保留', '不得泄漏林舟未知信息'],
    requiredCardIds: [data.callbackCardId],
    budgetTokens: 4096,
    workingSetId: `wp8-${data.spec.id.toLowerCase()}-working-set`
  })
  const useMs = performance.now() - useStart
  check(`${data.spec.id} working-set compiler returns ready`, compiled.workingSet.status === 'ready' && compiled.workingSet.manifestHash.length === 64)
  check(`${data.spec.id} working-set contains required callback`, compiled.workingSet.sections.some((section) => section.sourceCardIds.includes(data.callbackCardId)))
  let recallTamperRejected = false
  try {
    compileSceneWorkingSet({ snapshot, recall: { ...useRecall, indexHash: sha('tampered') }, recallQuery: useQuery, contract, hardConstraints: ['北门钥匙回调必须保留', '不得泄漏林舟未知信息'], requiredCardIds: [data.callbackCardId], budgetTokens: 4096 })
  } catch (error) {
    recallTamperRejected = error instanceof Error && (error as Error & { code?: string }).code === 'scene_working_set_recall_mismatch'
  }
  check(`${data.spec.id} working-set rejects recall tamper`, recallTamperRejected)
  return {
      recall: {
        candidates: cold.candidates.length,
        omitted: cold.omitted.length,
        callbackRank: cold.candidates.findIndex((candidate) => candidate.cardId === data.callbackCardId) + 1,
      staleOmitted: cold.omitted.filter((item) => item.cardId === data.staleCardId).map((item) => item.reason),
      retractedOmitted: cold.omitted.filter((item) => item.cardId === data.retractedCardId).map((item) => item.reason),
      branchOmitted: cold.omitted.filter((item) => item.cardId === data.branchCardId).map((item) => item.reason),
        povLeakCandidates: povResult.candidates.filter((candidate) => candidate.cardId === secret.card.cardId).length,
        invalidEpochCandidates: epochResult.candidates.length,
        aliasLexicalHit: aliasResult.candidates.some((candidate) => candidate.cardId === data.aliasCardId),
        timeJumpLexicalHit: timeResult.candidates.some((candidate) => candidate.cardId === data.timeJumpCardId),
        productionVisibleCards: productionVisibleIds.size,
        productionVisibilityExcluded: visibilityIndex.omitted.filter((item) => [data.staleCardId, data.retractedCardId, data.branchCardId].includes(item.cardId)).map((item) => ({ cardId: item.cardId, reason: item.reason })),
        remoteGapCount: data.gapDependencyKeys.length,
        remoteGapMatched: matchedGapKeys.size,
        remoteGapRank: gapIndex.candidates.findIndex((candidate) => candidate.cardId === data.callbackCardId) + 1
      },
    use: {
      status: compiled.workingSet.status,
      estimatedTokens: compiled.workingSet.estimatedTokens,
      latencyMs: useMs,
      recallTamperRejected
    },
    latency: { coldRebuildMs, warmAppendMs }
  }
}

function manuscriptRow(segment: ManuscriptSegment): ManuscriptSegmentRow {
  return {
    segment_id: segment.segmentId,
    run_id: segment.runId,
    session_id: segment.sessionId,
    source_turn_id: segment.sourceTurnId ?? null,
    section_id: segment.sectionId ?? null,
    scene_id: segment.sceneId ?? null,
    chunk_index: segment.chunkIndex,
    revision: segment.revision,
    status: segment.status,
    kind: segment.kind,
    content: segment.content,
    content_hash: segment.contentHash,
    char_count: segment.charCount,
    supersedes_segment_id: segment.supersedesSegmentId ?? null,
    created_at: segment.createdAt,
    updated_at: segment.updatedAt,
    accepted_at: segment.acceptedAt ?? null
  }
}

function commitRunRow(runId: string, sessionId: string, storyId: string, projectId: string): RunRow {
  return {
    run_id: runId,
    session_id: sessionId,
    status: 'running',
    phase: 'writing',
    started_at: 1,
    updated_at: 1,
    config_json: JSON.stringify({ storyScope: { schemaVersion: 1, storyId, projectId, branchId: 'main' } }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  }
}

function commitSegment(runId: string, sessionId: string, sceneId: string): ManuscriptSegment {
  const content = '林舟抵达灯塔。'
  const classified = classifyAssistantOutput(content)
  return {
    schemaVersion: 1,
    segmentId: `${runId}:segment-1`,
    runId,
    sessionId,
    sectionId: 'section-1',
    sceneId,
    chunkIndex: 0,
    revision: 1,
    status: 'candidate',
    kind: classified.kind,
    content,
    contentHash: manuscriptSegmentHash(content),
    charCount: codePointLength(content),
    createdAt: 3,
    updatedAt: 3
  }
}

function commitManifest(contract: SceneContract, runId: string, candidate: ManuscriptSegment, decision: ReturnType<typeof buildSceneCompletionDecision>, deltaHash: string): SceneCommitManifest {
  return {
    schemaVersion: 1,
    runId,
    sceneId: contract.sceneId,
    contractId: contract.contractId,
    contractHash: contract.frozenHash,
    acceptedSegments: [{ segmentId: candidate.segmentId, contentHash: candidate.contentHash, charCount: candidate.charCount, chunkIndex: candidate.chunkIndex, revision: candidate.revision }],
    sceneContentHash: candidate.contentHash,
    sceneCharCount: candidate.charCount,
    completionDecisionHash: manuscriptSegmentHash(stableNarrativeJson(decision)),
    stateDeltaHash: deltaHash
  }
}

function commitProjection(input: { scaleId: string; runId: string; storyId: string; projectId: string; contract: SceneContract; candidate: ManuscriptSegment; manifestHash: string; deltaHash: string }): SceneMemoryProjectionInput {
  const contentHash = input.candidate.contentHash
  const source: SceneMemorySourceSegment = {
    segmentId: input.candidate.segmentId,
    content: input.candidate.content,
    contentHash,
    segmentRevision: input.candidate.revision,
    status: 'accepted',
    sceneId: input.contract.sceneId,
    commitId: `${input.runId}:${input.contract.sceneId}`,
    commitManifestHash: input.manifestHash,
    chunkIndex: input.candidate.chunkIndex
  }
  const span = makeSceneMemorySourceSpan({ spanId: `${input.scaleId}:commit:span`, segmentId: source.segmentId, segmentHash: contentHash, segmentRevision: source.segmentRevision, manifestHash: input.manifestHash, content: source.content, startUtf16: 0, endUtf16: source.content.length })
  const context: SceneMemoryCardValidationContext = {
    sourceSegments: [source],
    expectedScope: { storyId: input.storyId, projectId: input.projectId, branchId: 'main' },
    expectedValidityEpoch: 1,
    expectedStoryRevision: 1,
    expectedContract: { contractId: input.contract.contractId, contractHash: input.contract.frozenHash },
    expectedBindings: { sceneContentHash: contentHash, commitManifestHash: input.manifestHash, stateDeltaHash: input.deltaHash },
    ledgerClaims: []
  }
  const evidence = sourceSpanEvidence(span)
  const card = buildSceneMemoryCard({
    schemaVersion: 1,
    status: 'canonical',
    cardId: `${input.scaleId}:commit:card`,
    storyId: input.storyId,
    projectId: input.projectId,
    branchId: 'main',
    validityEpoch: 1,
    storyRevision: 1,
    runId: input.runId,
    sceneId: input.contract.sceneId,
    sceneOrder: input.contract.order,
    contractId: input.contract.contractId,
    contractHash: input.contract.frozenHash,
    sceneContentHash: contentHash,
    commitManifestHash: input.manifestHash,
    stateDeltaHash: input.deltaHash,
    povCharacterId: null,
    participants: [{ id: '林舟', role: '林舟', evidence: [evidence] }],
    locations: [],
    objects: [],
    dramaticQuestion: null,
    valueShift: null,
    decisiveAction: '林舟抵达灯塔',
    turn: null,
    cost: null,
    factsEstablished: [],
    beliefChanges: [],
    relationshipChanges: [],
    threads: [],
    motifs: [],
    distinctivePhrases: [],
    sourceSegments: [source],
    sourceSpans: [span],
    fieldEvidence: { decisiveAction: [evidence] },
    expectedScope: context.expectedScope,
    expectedValidityEpoch: 1,
    expectedStoryRevision: 1,
    expectedContract: context.expectedContract,
    expectedBindings: context.expectedBindings,
    ledgerClaims: [],
    createdAt: 1
  })
  return { card, context }
}

function setupCommitFixture(scaleId: string, dbPath: string, hooks: RepositoryTestHooks = {}): { repo: Repository; runId: string; storyId: string; projectId: string; contract: SceneContract; commit: CommitEnvelope } {
  const repo = createRepository(dbPath, hooks)
  repo.open()
  const lower = scaleId.toLowerCase()
  const runId = `wp8-${lower}-commit-run`
  const sessionId = `wp8-${lower}-commit-session`
  const storyId = `wp8-${lower}-commit-story`
  const projectId = `wp8-${lower}-commit-project`
  repo.createRun(commitRunRow(runId, sessionId, storyId, projectId))
  const plan = makeContractPlan(scaleId)
  const contract = plan.contracts[0]
  if (!contract) throw new Error(`commit contract missing for ${scaleId}`)
  repo.ensureSceneStates(runId, plan, 1)
  repo.transitionSceneState({ runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: 1, from: 'planned', to: 'writing', at: 2 })
  const candidate = commitSegment(runId, sessionId, contract.sceneId)
  repo.saveManuscriptSegment(manuscriptRow(candidate))
  const writing = repo.getSceneStates(runId)[0]
  if (!writing) throw new Error('commit scene state missing after writing')
  repo.transitionSceneState({ runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: writing.revision, from: 'writing', to: 'candidate', candidateSegmentId: candidate.segmentId, candidateHash: candidate.contentHash, at: 3 })
  const decision = buildSceneCompletionDecision(contract, candidate.content, { candidateSegmentId: candidate.segmentId, scenePrefix: '', at: 4 })
  if (decision.status !== 'complete') throw new Error(`commit candidate decision=${decision.status}`)
  const delta = buildEmptyNarrativeStateDelta({ runId, sceneId: contract.sceneId, acceptedSegmentId: candidate.segmentId, acceptedContentHash: candidate.contentHash, contractHash: contract.frozenHash })
  const rawManifest = commitManifest(contract, runId, candidate, decision, delta.deltaHash)
  const manifestHash = manuscriptSegmentHash(stableNarrativeJson(rawManifest))
  const projection = commitProjection({ scaleId, runId, storyId, projectId, contract, candidate, manifestHash, deltaHash: delta.deltaHash })
  repo.saveRunEvidence(runId, `scene_completion_decision:${candidate.segmentId}`, JSON.stringify({ schemaVersion: 1, runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, candidateSegmentId: candidate.segmentId, candidateHash: candidate.contentHash, decision, stateDeltaHash: delta.deltaHash, manifestHash, savedAt: 4 }))
  const evidenceIdentity = manuscriptAcceptanceEvidenceIdentity({ runId, segmentId: candidate.segmentId, candidateHash: candidate.contentHash, candidateCharCount: candidate.charCount, evidenceRevision: candidate.revision, sceneId: contract.sceneId, evidenceRefs: {} })
  repo.saveRunEvidence(runId, 'manuscript_acceptance_ready', JSON.stringify({ schemaVersion: 1, runId, segmentId: candidate.segmentId, candidateHash: candidate.contentHash, candidateCharCount: candidate.charCount, evidenceRevision: candidate.revision, evidenceIdentity, sceneId: contract.sceneId, evidenceRefs: {}, preparedAt: 4 }))
  const freshness = repo.getStoryLedgerFreshness(runId)
  if (!freshness) throw new Error('commit freshness missing')
  const state = repo.getSceneStates(runId)[0]
  if (!state) throw new Error('commit candidate state missing')
  const commit: CommitEnvelope = {
    acceptance: { runId, segmentId: candidate.segmentId, expectedContentHash: candidate.contentHash, expectedCharCount: candidate.charCount, evidenceRevision: candidate.revision, evidenceIdentity, sceneId: contract.sceneId, acceptedAt: 5 },
    contractId: contract.contractId,
    contractHash: contract.frozenHash,
    expectedSceneRevision: state.revision,
    decision,
    completionEvidenceHash: decision.evidenceHash,
    stateDelta: delta,
    manifest: rawManifest,
    expectedLedgerFence: { expectedRevision: freshness.runRevision, expectedEpoch: freshness.validityEpoch, expectedHeadRevision: freshness.headRevision, expectedHeadHash: freshness.headHash },
    committedAt: 5,
    projection
  }
  return { repo, runId, storyId, projectId, contract, commit }
}

function commitCounts(fixture: { repo: Repository; runId: string; storyId: string; projectId: string }): Record<string, unknown> {
  const state = fixture.repo.getSceneStates(fixture.runId)[0]
  const segments = fixture.repo.getManuscriptSegmentsByRun(fixture.runId)
  const commits = fixture.repo.getNarrativeCommits(fixture.runId)
  const ledger = fixture.repo.getNarrativeLedger(fixture.runId)
  const cards = fixture.repo.listSceneMemoryCards({ storyId: fixture.storyId, projectId: fixture.projectId, branchId: 'main', validityEpoch: 1, includeHidden: true })
  return {
    lifecycle: state?.lifecycle ?? null,
    acceptedSegments: segments.filter((segment) => segment.status === 'accepted').length,
    commits: commits.length,
    ledger: ledger.length,
    manifest: fixture.repo.getSceneCommitManifest(fixture.runId, state?.sceneId ?? '') ? 1 : 0,
    cards: cards.length,
    canonicalCards: cards.filter((card) => card.status === 'canonical').length,
    headRevision: fixture.repo.getStoryLedgerFreshness(fixture.runId)?.headRevision ?? null
  }
}

function sameCounts(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return stableSceneMemoryJson(left) === stableSceneMemoryJson(right)
}

function closeRepository(repo: Repository): void {
  try { repo.close() } catch { return }
}

async function runCommitChecks(scaleId: ScaleId, root: string): Promise<Record<string, unknown>> {
  const baseline = setupCommitFixture(scaleId, path.join(root, `${scaleId.toLowerCase()}-baseline.sqlite`))
  try {
    let baselineError = ''
    try { baseline.repo.commitScene(baseline.commit) } catch (error) { baselineError = error instanceof Error ? error.message : String(error) }
    const committed = commitCounts(baseline)
    check(`${scaleId} production commit succeeds`, !baselineError && committed.lifecycle === 'committed' && committed.commits === 1 && committed.cards === 1 && committed.canonicalCards === 1, JSON.stringify({ baselineError, committed }))
    let replayError = ''
    try { baseline.repo.commitScene(structuredClone(baseline.commit) as CommitEnvelope) } catch (error) { replayError = error instanceof Error ? error.message : String(error) }
    const replayed = commitCounts(baseline)
    check(`${scaleId} production commit replay is idempotent`, !replayError && sameCounts(committed, replayed), JSON.stringify({ replayError, committed, replayed }))
  } finally {
    closeRepository(baseline.repo)
  }
  const rollback = setupCommitFixture(scaleId, path.join(root, `${scaleId.toLowerCase()}-rollback.sqlite`), { beforeSceneMemoryCardInsert: () => { throw new Error('wp8-injected-card-write') } })
  try {
    const before = commitCounts(rollback)
    let rollbackError = ''
    try { rollback.repo.commitScene(rollback.commit) } catch (error) { rollbackError = error instanceof Error ? error.message : String(error) }
    const after = commitCounts(rollback)
    check(`${scaleId} production commit rollback is atomic`, rollbackError === 'wp8-injected-card-write' && sameCounts(before, after), JSON.stringify({ rollbackError, before, after }))
  } finally {
    closeRepository(rollback.repo)
  }
  const epoch = setupCommitFixture(scaleId, path.join(root, `${scaleId.toLowerCase()}-epoch.sqlite`))
  try {
    const before = commitCounts(epoch)
    const stale = structuredClone(epoch.commit) as CommitEnvelope
    stale.expectedLedgerFence = { ...stale.expectedLedgerFence!, expectedEpoch: 2 }
    let epochError = ''
    try { epoch.repo.commitScene(stale) } catch (error) { epochError = error instanceof Error ? error.message : String(error) }
    const after = commitCounts(epoch)
    check(`${scaleId} invalid epoch refuses commit without writes`, epochError === 'story_ledger_epoch_invalidated' && sameCounts(before, after), JSON.stringify({ epochError, before, after }))
    return { baseline: 'committed', replay: 'idempotent', rollback: 'atomic', invalidEpoch: 'rejected', rollbackCountsEqual: sameCounts(before, after) }
  } finally {
    closeRepository(epoch.repo)
  }
}

async function main(): Promise<void> {
  if (manifest.status !== 'synthetic' || manifest.qualityClaims !== 'advisory_only' || manifest.realRequests !== 0) throw new Error('fixture manifest must remain synthetic/advisory with zero requests')
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-wp8-t0-'))
  const fixtureResults: Array<Record<string, unknown>> = []
  try {
    for (const raw of manifest.scales) {
      const spec = raw as ScaleSpec
      const data = makeFixture(spec)
      const expectedSceneCounts: Record<ScaleId, number> = { P10: 20, P30: 40, P100: 100, L20: 20 }
      const minimumSyntheticChars: Record<ScaleId, number> = { P10: 10000, P30: 30000, P100: 90000, L20: 20000 }
      check(`${spec.id} scene cardinality follows T0`, spec.sceneCount === expectedSceneCounts[spec.id])
      check(`${spec.id} synthetic volume floor follows T0`, data.syntheticChars >= minimumSyntheticChars[spec.id], `actual=${data.syntheticChars} floor=${minimumSyntheticChars[spec.id]}`)
      check(`${spec.id} synthetic constraint count follows T0`, data.constraintCount === spec.constraintCount && (spec.id !== 'P100' || data.constraintCount >= 100))
      check(`${spec.id} synthetic gap count follows T0`, data.gapCount === spec.gapCount)
      if (spec.targetChars !== undefined) check(`${spec.id} synthetic scene chars follow T0 target`, data.syntheticChars === spec.targetChars, `actual=${data.syntheticChars} target=${spec.targetChars}`)
      const recallUse = runRecallAndUse(data)
      const commit = await runCommitChecks(spec.id, root)
      fixtureResults.push({
        id: spec.id,
        sceneCount: spec.sceneCount,
        status: 'synthetic',
        qualityClaim: 'advisory_only',
        realRequests: 0,
        coverage: manifest.coverage,
        corpusCards: data.corpus.length,
        syntheticChars: data.syntheticChars,
        constraintCount: data.constraintCount,
        gapCount: data.gapCount,
        write: { status: 'synthetic', qualityClaim: 'advisory_only', executed: false, realRequests: 0 },
        aliasCardId: data.aliasCardId,
        timeJumpCardId: data.timeJumpCardId,
        recall: recallUse.recall,
        use: recallUse.use,
        commit,
        latency: recallUse.latency,
        gaps: [
          'alias result is lexical evidence only; no alias resolver is claimed',
          'time-jump result is lexical evidence only; no temporal reasoner is claimed',
          'writer/quality and blind pairwise preference are not run without a provider'
        ]
      })
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
  const report = {
    schemaVersion: 1,
    fixtureId: manifest.fixtureId,
    status: 'synthetic',
    qualityClaims: 'advisory_only',
    realRequests: 0,
    qualityWin: null,
    fixtureResults,
    passed,
    failed
  }
  console.log(`WP8_T0_REPORT=${JSON.stringify(report)}`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error) => {
  console.error(`WP8_T0_FATAL=${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
