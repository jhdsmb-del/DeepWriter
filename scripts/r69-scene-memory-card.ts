import { createHash } from 'node:crypto'
import {
  appendSceneMemoryCard,
  buildSceneMemoryCard,
  cardToDenseText,
  ledgerEvidence,
  sceneMemoryCardHash,
  sourceSpanEvidence,
  stableSceneMemoryCardJson,
  stableSceneMemoryJson,
  sceneMemoryLedgerClaimHash,
  validateSceneMemoryCard
} from '../src/main/narrative/sceneMemoryCard'
import type {
  SceneMemoryCard,
  SceneMemoryCardBuildInput,
  SceneMemoryCardValidationContext,
  SceneMemorySourceSegment,
  SceneMemorySourceSpan
} from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function errorsOf(result: { errors: string[] }): string {
  return result.errors.join('|')
}

function rejects(name: string, value: unknown, context: SceneMemoryCardValidationContext, expected = ''): void {
  const result = validateSceneMemoryCard(value, context)
  check(name, !result.ok && (!expected || errorsOf(result).includes(expected)), errorsOf(result))
}

function throws(name: string, fn: () => unknown, expected = ''): void {
  try {
    fn()
    check(name, false, 'expected rejection')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, !expected || message.includes(expected), message)
  }
}

function fixture(): { input: SceneMemoryCardBuildInput; card: SceneMemoryCard; segment: SceneMemorySourceSegment; span: SceneMemorySourceSpan; context: SceneMemoryCardValidationContext } {
  const content = '甲😀乙（linzhou/林舟；shen-yao/沈遥；agent；recipient）在雨夜，林舟把钥匙交给沈遥。戏剧问题：钥匙能否安全交接？价值变化：不信任到暂时合作。决定性行动：交接钥匙。转折：沈遥取得钥匙。代价：林舟暴露行踪。事实：钥匙已交给沈遥。信念：不信任到暂时相信林舟。关系维度：trust；关系维度：respect；关系：不信任到暂时合作。第二线程：第二线程已开启。线程：钥匙交接线推进。母题：雨夜。特色措辞：把钥匙交给沈遥。'
  const contractId = 'contract-r69-1'
  const contractHash = sha256(contractId)
  const commitManifestHash = sha256('manifest-r69-1')
  const stateDeltaHash = sha256('delta-r69-1')
  const sceneId = 'scene:r69:handover'
  const segment: SceneMemorySourceSegment = {
    segmentId: 'seg-r69-1',
    content,
    contentHash: sha256(content),
    segmentRevision: 7,
    status: 'accepted',
    sceneId,
    commitId: 'commit-r69-1',
    commitManifestHash,
    chunkIndex: 0
  }
  const span: SceneMemorySourceSpan = {
    spanId: 'span-r69-all',
    segmentId: segment.segmentId,
    segmentHash: segment.contentHash,
    segmentRevision: segment.segmentRevision,
    manifestHash: segment.commitManifestHash,
    startUtf16: 0,
    endUtf16: content.length,
    text: content,
    spanHash: sha256(content)
  }
  const evidence = sourceSpanEvidence(span)
  const relationshipClaimBase = { kind: 'relationship' as const, id: 'ledger-rel-r69-1', revision: 7, validityEpoch: 2, storyId: 'story-r69', projectId: 'project-r69', branchId: 'main', stateDeltaHash, commitManifestHash, fromCharacterId: 'linzhou', toCharacterId: 'shen-yao', dimension: 'trust' }
  const relationshipClaim = { ...relationshipClaimBase, hash: sceneMemoryLedgerClaimHash(relationshipClaimBase) }
  const threadClaimBase = { kind: 'foreshadow' as const, id: 'ledger-thread-r69-1', revision: 7, validityEpoch: 2, storyId: 'story-r69', projectId: 'project-r69', branchId: 'main', stateDeltaHash, commitManifestHash, threadId: 'thread-r69-key', lifecycle: 'advanced' as const }
  const threadClaim = { ...threadClaimBase, hash: sceneMemoryLedgerClaimHash(threadClaimBase) }
  const relationshipRef = ledgerEvidence(relationshipClaim.id, relationshipClaim.hash)
  const threadRef = ledgerEvidence(threadClaim.id, threadClaim.hash)
  const fieldEvidence = {
    'povCharacterId': [evidence],
    'locations:雨夜': [evidence],
    'objects:钥匙': [evidence],
    'dramaticQuestion': [evidence],
    'valueShift.from': [evidence],
    'valueShift.to': [evidence],
    'decisiveAction': [evidence],
    'turn': [evidence],
    'cost': [evidence]
  }
  const input: SceneMemoryCardBuildInput = {
    schemaVersion: 1,
    status: 'canonical',
    cardId: 'card-r69-1',
    storyId: 'story-r69',
    projectId: 'project-r69',
    branchId: 'main',
    validityEpoch: 2,
    storyRevision: 7,
    runId: 'run-r69-1',
    sceneId,
    sceneOrder: 3,
    contractId,
    contractHash,
    sceneContentHash: segment.contentHash,
    commitManifestHash,
    stateDeltaHash,
    povCharacterId: 'linzhou',
    participants: [
      { id: 'shen-yao', role: 'recipient', evidence: [evidence] },
      { id: 'linzhou', role: 'agent', evidence: [evidence] }
    ],
    locations: ['雨夜'],
    objects: ['钥匙'],
    dramaticQuestion: '钥匙能否安全交接？',
    valueShift: { from: '不信任', to: '暂时合作' },
    decisiveAction: '交接钥匙',
    turn: '沈遥取得钥匙',
    cost: '林舟暴露行踪',
    factsEstablished: [{ factId: 'fact-r69-key', statement: '钥匙已交给沈遥', evidence: [evidence] }],
    beliefChanges: [{ characterId: 'shen-yao', from: '不信任', to: '暂时相信林舟', evidence: [evidence] }],
    relationshipChanges: [{ fromCharacterId: 'linzhou', toCharacterId: 'shen-yao', dimension: 'trust', from: '不信任', to: '暂时合作', evidence: [evidence, relationshipRef] }],
    threads: [{ threadId: 'thread-r69-key', lifecycle: 'advanced', summary: '钥匙交接线推进', evidence: [evidence, threadRef] }],
    motifs: [{ text: '雨夜', evidence: [evidence] }],
    distinctivePhrases: [{ text: '把钥匙交给沈遥', evidence: [evidence] }],
    sourceSegments: [segment],
    sourceSpans: [span],
    fieldEvidence,
    expectedScope: { storyId: 'story-r69', projectId: 'project-r69', branchId: 'main' },
    expectedValidityEpoch: 2,
    expectedStoryRevision: 7,
    expectedContract: { contractId, contractHash },
    expectedBindings: { sceneContentHash: segment.contentHash, commitManifestHash, stateDeltaHash },
    ledgerClaims: [relationshipClaim, threadClaim],
    createdAt: 1000
  }
  const card = buildSceneMemoryCard(input)
  const context: SceneMemoryCardValidationContext = {
    sourceSegments: [segment],
    expectedScope: input.expectedScope,
    expectedValidityEpoch: input.expectedValidityEpoch,
    expectedStoryRevision: input.expectedStoryRevision,
    expectedContract: input.expectedContract,
    expectedBindings: input.expectedBindings,
    ledgerClaims: [relationshipClaim, threadClaim]
  }
  return { input, card, segment, span, context }
}

function main(): void {
  const { input, card, segment, span, context } = fixture()
  const relationshipClaim = context.ledgerClaims.find((claim) => claim.kind === 'relationship')!
  const threadClaim = context.ledgerClaims.find((claim) => claim.kind === 'foreshadow')!
  check('R69 accepts an accepted, source-bound canonical card', validateSceneMemoryCard(card, context).ok, errorsOf(validateSceneMemoryCard(card, context)))
  check('card hash is SHA-256 and excludes createdAt', /^[0-9a-f]{64}$/u.test(card.cardHash) && card.cardHash === sceneMemoryCardHash({ ...card, createdAt: 999999 }))
  const reordered = buildSceneMemoryCard({ ...input, createdAt: 1000, participants: [...input.participants].reverse(), locations: [...input.locations].reverse(), objects: [...input.objects].reverse() })
  check('reordered set-like fields have identical hash', reordered.cardHash === card.cardHash)
  check('stable JSON and dense text are deterministic', stableSceneMemoryCardJson(card) === stableSceneMemoryCardJson(reordered) && cardToDenseText(card) === cardToDenseText(reordered) && !cardToDenseText(card).includes('undefined'))
  check('generic stable serializer ignores object key order', stableSceneMemoryJson({ z: 1, nested: { b: 2, a: 1 }, a: 3 }) === stableSceneMemoryJson({ a: 3, nested: { a: 1, b: 2 }, z: 1 }))

  const emojiSegment: SceneMemorySourceSegment = { ...segment, segmentId: 'seg-r69-emoji', content: '甲😀乙', contentHash: sha256('甲😀乙') }
  const split: SceneMemorySourceSpan = { ...span, spanId: span.spanId, segmentId: emojiSegment.segmentId, segmentHash: emojiSegment.contentHash, segmentRevision: emojiSegment.segmentRevision, manifestHash: emojiSegment.commitManifestHash, startUtf16: 2, endUtf16: 3, text: emojiSegment.content.slice(2, 3), spanHash: sha256(emojiSegment.content.slice(2, 3)) }
  const splitCard = { ...card, sourceSegmentIds: [emojiSegment.segmentId], sourceSpans: [split], sceneContentHash: emojiSegment.contentHash, cardHash: sceneMemoryCardHash({ ...card, sourceSegmentIds: [emojiSegment.segmentId], sourceSpans: [split], sceneContentHash: emojiSegment.contentHash }) }
  rejects('UTF-16 span cannot split an emoji surrogate pair', splitCard, { ...context, sourceSegments: [emojiSegment], expectedBindings: { ...context.expectedBindings, sceneContentHash: emojiSegment.contentHash } }, 'boundary')
  rejects('segment content hash tampering is rejected', card, { ...context, sourceSegments: [{ ...segment, content: segment.content.replace('沈遥', '沈瑶') }] }, 'segment_hash')
  rejects('span manifest tampering is rejected', { ...card, sourceSpans: [{ ...span, manifestHash: sha256('other-manifest') }], cardHash: sceneMemoryCardHash({ ...card, sourceSpans: [{ ...span, manifestHash: sha256('other-manifest') }] }) }, context, 'manifest')
  rejects('span revision tampering is rejected', { ...card, sourceSpans: [{ ...span, segmentRevision: 8 }], cardHash: sceneMemoryCardHash({ ...card, sourceSpans: [{ ...span, segmentRevision: 8 }] }) }, context, 'revision')
  rejects('each expected binding is independently enforced', card, { ...context, expectedBindings: { ...context.expectedBindings, sceneContentHash: sha256('other-content') } }, 'binding')
  rejects('commit manifest binding is independently enforced', card, { ...context, expectedBindings: { ...context.expectedBindings, commitManifestHash: sha256('other-manifest') } }, 'binding')
  rejects('state delta binding is independently enforced', card, { ...context, expectedBindings: { ...context.expectedBindings, stateDeltaHash: sha256('other-delta') } }, 'binding')
  rejects('contract, epoch, revision and scope fences are required', card, { ...context, expectedContract: { contractId: 'other-contract', contractHash: context.expectedContract.contractHash } }, 'contract')
  rejects('epoch fence rejects stale card', card, { ...context, expectedValidityEpoch: 3 }, 'epoch')
  rejects('revision fence rejects stale card', card, { ...context, expectedStoryRevision: 8 }, 'revision')
  rejects('scope fence rejects cross-branch card', card, { ...context, expectedScope: { ...context.expectedScope, branchId: 'alternate' } }, 'scope')

  throws('model-guessed fact without evidence is rejected', () => buildSceneMemoryCard({ ...input, factsEstablished: [{ factId: 'fact-r69-guess', statement: '模型凭空猜出的事实', evidence: [] }] }), 'evidence')
  const guessedFact = clone(card)
  guessedFact.factsEstablished = [{ factId: 'fact-r69-guess', statement: '模型凭空猜出的事实', evidence: [sourceSpanEvidence(span)] }]
  guessedFact.cardHash = sceneMemoryCardHash(guessedFact)
  rejects('source span must actually contain nested fact', guessedFact, context, 'evidence_claim')
  const guessedScalar = clone(card)
  guessedScalar.locations = ['秘密基地']
  guessedScalar.fieldEvidence = { ...guessedScalar.fieldEvidence, 'locations:秘密基地': [sourceSpanEvidence(span)] }
  guessedScalar.cardHash = sceneMemoryCardHash(guessedScalar)
  rejects('source span must actually contain scalar value', guessedScalar, context, 'evidence_claim')
  const noScalarEvidence = clone(card)
  noScalarEvidence.objects = ['不存在的物件']
  noScalarEvidence.fieldEvidence = { ...noScalarEvidence.fieldEvidence, 'objects:不存在的物件': [] }
  noScalarEvidence.cardHash = sceneMemoryCardHash(noScalarEvidence)
  rejects('non-empty scalar cannot omit evidence', noScalarEvidence, context, 'evidence')
  const contractOnly = clone(card)
  contractOnly.factsEstablished[0]!.evidence = [{ kind: 'contract', id: input.contractId, hash: input.contractHash }]
  contractOnly.cardHash = sceneMemoryCardHash(contractOnly)
  rejects('contract evidence cannot elevate a canonical fact', contractOnly, context, 'canonical_source')
  const superseded = { ...segment, status: 'superseded' as const }
  rejects('superseded source segment is never canonical', card, { ...context, sourceSegments: [superseded] }, 'status')
  rejects('cross-scene source segment is never canonical', card, { ...context, sourceSegments: [{ ...segment, sceneId: 'scene:r69:other' }] }, 'scene')

  const duplicateSpan = clone(card)
  duplicateSpan.sourceSpans = [span, { ...span }]
  duplicateSpan.cardHash = sceneMemoryCardHash(duplicateSpan)
  rejects('duplicate span IDs are rejected', duplicateSpan, context, 'duplicate')
  const duplicateSegment = clone(card)
  duplicateSegment.sourceSegmentIds = [segment.segmentId, segment.segmentId]
  duplicateSegment.cardHash = sceneMemoryCardHash(duplicateSegment)
  rejects('duplicate source segment IDs are rejected', duplicateSegment, context, 'duplicate')
  throws('append-only rejects duplicate card ID', () => appendSceneMemoryCard([card], card, context), 'duplicate')
  const sameRevision = buildSceneMemoryCard({ ...input, cardId: 'card-r69-same', createdAt: 3000 })
  throws('append-only rejects same story revision', () => appendSceneMemoryCard([card], sameRevision, context), 'revision')
  const { hash: _relationshipHash, ...relationshipClaimPayload } = relationshipClaim
  const nextRelationshipPayload = { ...relationshipClaimPayload, id: 'ledger-rel-r69-2', revision: 8 }
  const nextRelationshipClaim = { ...nextRelationshipPayload, hash: sceneMemoryLedgerClaimHash(nextRelationshipPayload) }
  const { hash: _threadHash, ...threadClaimPayload } = threadClaim
  const nextThreadPayload = { ...threadClaimPayload, id: 'ledger-thread-r69-2', revision: 8 }
  const nextThreadClaim = { ...nextThreadPayload, hash: sceneMemoryLedgerClaimHash(nextThreadPayload) }
  const next = buildSceneMemoryCard({ ...input, cardId: 'card-r69-next', storyRevision: 8, sceneOrder: 4, expectedStoryRevision: 8, ledgerClaims: [nextRelationshipClaim, nextThreadClaim], relationshipChanges: input.relationshipChanges.map((item) => ({ ...item, evidence: item.evidence.map((ref) => ref.id === relationshipClaim.id ? ledgerEvidence(nextRelationshipClaim.id, nextRelationshipClaim.hash) : ref) })), threads: input.threads.map((item) => ({ ...item, evidence: item.evidence.map((ref) => ref.id === threadClaim.id ? ledgerEvidence(nextThreadClaim.id, nextThreadClaim.hash) : ref) })), createdAt: 4000 })
  const nextContext = { ...context, expectedStoryRevision: 8, ledgerClaims: [relationshipClaim, threadClaim, nextRelationshipClaim, nextThreadClaim] }
  check('append-only accepts strictly later revision', appendSceneMemoryCard([card], next, nextContext).length === 2)

  const legacy = clone(card)
  legacy.status = 'legacy_unverified'
  legacy.povCharacterId = null
  legacy.participants = []
  legacy.locations = []
  legacy.objects = []
  legacy.dramaticQuestion = null
  legacy.valueShift = null
  legacy.decisiveAction = null
  legacy.turn = null
  legacy.cost = null
  legacy.factsEstablished = []
  legacy.beliefChanges = []
  legacy.relationshipChanges = []
  legacy.threads = []
  legacy.motifs = []
  legacy.distinctivePhrases = []
  legacy.fieldEvidence = {}
  legacy.cardHash = sceneMemoryCardHash(legacy)
  check('legacy_unverified card can carry no fabricated claims', validateSceneMemoryCard(legacy, context).ok)
  const fakeLegacy = { ...legacy, locations: ['秘密基地'], fieldEvidence: { 'locations:秘密基地': [] } }
  fakeLegacy.cardHash = sceneMemoryCardHash(fakeLegacy)
  rejects('legacy_unverified cannot carry a fabricated claim', fakeLegacy, context, 'legacy_claim')

  console.log(`\nR69 SceneMemoryCard: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

try {
  main()
} catch (error) {
  console.error('R69 SceneMemoryCard execution error:', error)
  process.exitCode = 2
}
