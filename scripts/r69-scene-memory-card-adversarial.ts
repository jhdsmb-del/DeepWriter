/**
 * R69/WP1 adversarial corpus for the source-bound SceneMemoryCard.
 *
 * This is intentionally independent from r69-scene-memory-card.ts.  It does
 * not inspect production source text or reproduce the validator.  Every
 * assertion exercises the exported builder/validator against a concrete
 * mutation of one accepted scene.
 *
 * Run without changing package scripts:
 *   npx esbuild scripts/r69-scene-memory-card-adversarial.ts --bundle --format=esm --platform=node --outfile=out/r69-scene-memory-card-adversarial.mjs
 *   node out/r69-scene-memory-card-adversarial.mjs
 */
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
  SceneMemoryForeshadowLedgerClaim,
  SceneMemoryRelationshipLedgerClaim,
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

function errorText(result: { errors?: string[] }): string {
  return (result.errors ?? []).join('|')
}

function rejects(name: string, value: unknown, context: SceneMemoryCardValidationContext, expected = ''): void {
  const result = validateSceneMemoryCard(value, context)
  check(name, !result.ok && (!expected || errorText(result).includes(expected)), errorText(result))
}

function throws(name: string, fn: () => unknown, expected = ''): void {
  try {
    fn()
    check(name, false, 'expected throw')
  } catch (error) {
    const text = error instanceof Error ? `${error.message}\n${JSON.stringify(error)}` : String(error)
    check(name, !expected || text.includes(expected), text)
  }
}

function makeFixture(sceneId = 'scene:r69:handover', contractId = 'contract-r69-adversarial'): {
  input: SceneMemoryCardBuildInput
  card: SceneMemoryCard
  segment: SceneMemorySourceSegment
  span: SceneMemorySourceSpan
  context: SceneMemoryCardValidationContext
} {
  const content = '甲😀乙（linzhou/林舟；shen-yao/沈遥；agent；recipient）在雨夜，林舟把钥匙交给沈遥。戏剧问题：钥匙能否安全交接？价值变化：不信任到暂时合作。决定性行动：交接钥匙。转折：沈遥取得钥匙。代价：林舟暴露行踪。事实：钥匙已交给沈遥。信念：不信任到暂时相信林舟。关系维度：trust；关系维度：respect；关系：不信任到暂时合作。第二线程：第二线程已开启。线程：钥匙交接线推进。母题：雨夜。特色措辞：把钥匙交给沈遥。'
  const contractHash = sha256(contractId)
  const commitManifestHash = sha256('manifest-r69-adversarial')
  const stateDeltaHash = sha256('delta-r69-adversarial')
  const segmentId = 'seg-r69-adversarial'
  const segment: SceneMemorySourceSegment = {
    segmentId,
    content,
    contentHash: sha256(content),
    segmentRevision: 7,
    status: 'accepted',
    sceneId,
    commitId: 'commit-r69-adversarial',
    commitManifestHash,
    chunkIndex: 0
  }
  // Use one accepted span for the fixture so each semantic claim is visibly
  // present in the cited prose.  Separate focused spans are used below for
  // the surrogate-boundary probes.
  const startUtf16 = 0
  const endUtf16 = content.length
  const spanText = content
  const span: SceneMemorySourceSpan = {
    spanId: 'span-r69-adversarial',
    segmentId,
    segmentHash: segment.contentHash,
    segmentRevision: segment.segmentRevision,
    manifestHash: commitManifestHash,
    startUtf16,
    endUtf16,
    text: spanText,
    spanHash: sha256(spanText)
  }
  const evidence = sourceSpanEvidence(span)
  const relationshipClaimBase = { kind: 'relationship' as const, id: 'ledger-rel-r69-adversarial', revision: 7, validityEpoch: 2, storyId: 'story-r69', projectId: 'project-r69', branchId: 'main', stateDeltaHash, commitManifestHash, fromCharacterId: 'linzhou', toCharacterId: 'shen-yao', dimension: 'trust' }
  const relationshipClaim = { ...relationshipClaimBase, hash: sceneMemoryLedgerClaimHash(relationshipClaimBase) }
  const threadClaimBase = { kind: 'foreshadow' as const, id: 'ledger-thread-r69-adversarial', revision: 7, validityEpoch: 2, storyId: 'story-r69', projectId: 'project-r69', branchId: 'main', stateDeltaHash, commitManifestHash, threadId: 'thread-r69-key', lifecycle: 'advanced' as const }
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
    cardId: 'card-r69-adversarial',
    storyId: 'story-r69',
    projectId: 'project-r69',
    branchId: 'main',
    validityEpoch: 2,
    storyRevision: 7,
    runId: 'run-r69-adversarial',
    sceneId: segment.sceneId,
    sceneOrder: 3,
    contractId,
    contractHash,
    sceneContentHash: segment.contentHash,
    commitManifestHash,
    stateDeltaHash,
    povCharacterId: 'linzhou',
    participants: [
      { id: 'linzhou', role: 'agent', evidence: [evidence] },
      { id: 'shen-yao', role: 'recipient', evidence: [evidence] }
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
  const { input, card, segment, span, context } = makeFixture()
  const chinese = makeFixture('scene:r69:灯火', 'contract:r69:灯火')
  check('Chinese outline IDs retain source-bound scene and contract identity', validateSceneMemoryCard(chinese.card, chinese.context).ok)
  for (const invalidId of ['scene:r69:灯火/其他', 'scene:r69:灯火\\其他', 'scene:r69:灯 火', 'scene:r69:灯火\u0000', `scene:${'灯'.repeat(240)}`]) {
    throws('unsafe or oversized outline ID remains rejected', () => makeFixture(invalidId), 'scene_memory')
  }
  const relationshipClaim = context.ledgerClaims.find((claim): claim is SceneMemoryRelationshipLedgerClaim => claim.kind === 'relationship')!
  const threadClaim = context.ledgerClaims.find((claim): claim is SceneMemoryForeshadowLedgerClaim => claim.kind === 'foreshadow')!

  check('valid source-bound card is accepted', validateSceneMemoryCard(card, context).ok, errorText(validateSceneMemoryCard(card, context)))
  check('card hash is lowercase SHA-256 and createdAt-independent', /^[0-9a-f]{64}$/u.test(card.cardHash) && card.cardHash === sceneMemoryCardHash({ ...card, createdAt: 999_999 }), card.cardHash)
  check('stable JSON and dense text contain no undefined', !stableSceneMemoryCardJson(card).includes('undefined') && !cardToDenseText(card).includes('undefined'))

  const reordered = Object.fromEntries(Object.entries({
    ...card,
    participants: [...card.participants].reverse(),
    locations: [...card.locations].reverse(),
    objects: [...card.objects].reverse()
  }).reverse()) as unknown as SceneMemoryCard
  reordered.cardHash = sceneMemoryCardHash(reordered)
  check('object keys and set-like array order are canonicalized', reordered.cardHash === card.cardHash && stableSceneMemoryCardJson(reordered) === stableSceneMemoryCardJson(card))
  check('generic stable serializer is deterministic for object-key permutations', stableSceneMemoryJson({ z: 1, nested: { b: 2, a: 1 }, a: 3 }) === stableSceneMemoryJson({ a: 3, nested: { a: 1, b: 2 }, z: 1 }))

  // The UTF-16 contract must reject a range which selects only one half of 😀.
  const emojiSegment: SceneMemorySourceSegment = {
    ...segment,
    segmentId: 'seg-r69-emoji',
    content: '甲😀乙',
    contentHash: sha256('甲😀乙')
  }
  const emojiSpan = (startUtf16: number, endUtf16: number, text: string): SceneMemorySourceSpan => ({
    ...span,
    spanId: `span-r69-emoji-${startUtf16}-${endUtf16}`,
    segmentId: emojiSegment.segmentId,
    segmentHash: emojiSegment.contentHash,
    startUtf16,
    endUtf16,
    text,
    spanHash: sha256(text)
  })
  const split = emojiSpan(2, 3, emojiSegment.content.slice(2, 3))
  rejects('UTF-16 span cannot cut a surrogate pair', { ...card, sourceSegmentIds: [emojiSegment.segmentId], sourceSpans: [split], cardHash: sceneMemoryCardHash({ ...card, sourceSegmentIds: [emojiSegment.segmentId], sourceSpans: [split] }) }, { ...context, sourceSegments: [emojiSegment] }, 'boundary')
  const outOfBounds = emojiSpan(0, emojiSegment.content.length + 1, emojiSegment.content)
  rejects('span end beyond accepted segment is rejected', { ...card, sourceSegmentIds: [emojiSegment.segmentId], sourceSpans: [outOfBounds], cardHash: sceneMemoryCardHash({ ...card, sourceSegmentIds: [emojiSegment.segmentId], sourceSpans: [outOfBounds] }) }, { ...context, sourceSegments: [emojiSegment] }, 'range')

  rejects('span text/offset mismatch is rejected', { ...card, sourceSpans: [{ ...span, text: '不在原文中的证据', spanHash: sha256('不在原文中的证据') }], cardHash: sceneMemoryCardHash({ ...card, sourceSpans: [{ ...span, text: '不在原文中的证据', spanHash: sha256('不在原文中的证据') }] }) }, context, 'span_text')
  rejects('segment content hash tamper is rejected', card, { ...context, sourceSegments: [{ ...segment, content: segment.content.replace('沈遥', '沈瑶') }] }, 'segment_hash')
  rejects('span segment hash tamper is rejected', { ...card, sourceSpans: [{ ...span, segmentHash: sha256('other-segment') }], cardHash: sceneMemoryCardHash({ ...card, sourceSpans: [{ ...span, segmentHash: sha256('other-segment') }] }) }, context, 'segment_hash')
  rejects('span manifest binding tamper is rejected', { ...card, sourceSpans: [{ ...span, manifestHash: sha256('other-manifest') }], cardHash: sceneMemoryCardHash({ ...card, sourceSpans: [{ ...span, manifestHash: sha256('other-manifest') }] }) }, context, 'manifest')
  rejects('span segment-revision binding tamper is rejected', { ...card, sourceSpans: [{ ...span, segmentRevision: span.segmentRevision + 1 }], cardHash: sceneMemoryCardHash({ ...card, sourceSpans: [{ ...span, segmentRevision: span.segmentRevision + 1 }] }) }, context, 'revision')
  rejects('span hash tamper is rejected', { ...card, sourceSpans: [{ ...span, spanHash: sha256('other-span') }], cardHash: sceneMemoryCardHash({ ...card, sourceSpans: [{ ...span, spanHash: sha256('other-span') }] }) }, context, 'span_hash')

  rejects('contract id/hash mismatch is rejected', card, { ...context, expectedContract: { contractId: 'contract-other', contractHash: context.expectedContract.contractHash } }, 'contract')
  rejects('validity epoch mismatch is rejected', card, { ...context, expectedValidityEpoch: 3 }, 'epoch')
  rejects('story scope mismatch is rejected', card, { ...context, expectedScope: { ...context.expectedScope, branchId: 'alternate' } }, 'scope')
  rejects('story revision mismatch is rejected', card, { ...context, expectedStoryRevision: 8 }, 'revision')
  rejects('scene content binding mismatch is rejected', card, { ...context, expectedBindings: { ...context.expectedBindings, sceneContentHash: sha256('other-content') } }, 'binding')
  rejects('commit manifest binding mismatch is rejected', card, { ...context, expectedBindings: { ...context.expectedBindings, commitManifestHash: sha256('other-manifest') } }, 'binding')
  rejects('state delta binding mismatch is rejected', card, { ...context, expectedBindings: { ...context.expectedBindings, stateDeltaHash: sha256('other-delta') } }, 'binding')

  // Every non-empty semantic field must carry evidence.  Exercise both
  // nested records and scalar/list fields, including a source span which does
  // not actually contain the claimed value.
  const noFactEvidence = clone(card)
  noFactEvidence.factsEstablished = [{ factId: 'fact-r69-guess', statement: '模型猜出的事实', evidence: [] }]
  noFactEvidence.cardHash = sceneMemoryCardHash(noFactEvidence)
  rejects('nested fact without evidence is rejected', noFactEvidence, context, 'evidence')
  const noScalarEvidence = clone(card)
  noScalarEvidence.objects = ['不存在的物件']
  noScalarEvidence.fieldEvidence = { ...noScalarEvidence.fieldEvidence, 'objects:不存在的物件': [] }
  noScalarEvidence.cardHash = sceneMemoryCardHash(noScalarEvidence)
  rejects('non-empty scalar without evidence is rejected', noScalarEvidence, context, 'evidence')
  const guessedScalar = clone(card)
  guessedScalar.locations = ['秘密基地']
  guessedScalar.fieldEvidence = { ...guessedScalar.fieldEvidence, 'locations:秘密基地': [sourceSpanEvidence(span)] }
  guessedScalar.cardHash = sceneMemoryCardHash(guessedScalar)
  rejects('source evidence that does not contain claimed scalar is rejected', guessedScalar, context, 'evidence')
  const guessedFact = clone(card)
  guessedFact.factsEstablished = [{ factId: 'fact-r69-guess', statement: '模型凭空猜出的事实', evidence: [sourceSpanEvidence(span)] }]
  guessedFact.cardHash = sceneMemoryCardHash(guessedFact)
  rejects('source evidence that does not contain claimed nested fact is rejected', guessedFact, context, 'evidence')
  const duplicateEvidence = clone(card)
  duplicateEvidence.factsEstablished[0]!.evidence = [sourceSpanEvidence(span), sourceSpanEvidence(span)]
  duplicateEvidence.cardHash = sceneMemoryCardHash(duplicateEvidence)
  rejects('duplicate evidence reference is rejected', duplicateEvidence, context, 'duplicate_evidence')
  const danglingEvidence = clone(card)
  danglingEvidence.factsEstablished[0]!.evidence = [{ ...sourceSpanEvidence(span), id: 'span-r69-missing', spanId: 'span-r69-missing' }]
  danglingEvidence.cardHash = sceneMemoryCardHash(danglingEvidence)
  rejects('evidence cannot reference an absent span', danglingEvidence, context, 'span_missing')
  const unknownFact = clone(card)
  unknownFact.factsEstablished = [{ factId: 'fact-r69-unknown', statement: 'unknown', evidence: [] }]
  unknownFact.cardHash = sceneMemoryCardHash(unknownFact)
  check('unknown is not silently turned into a sourced fact', !validateSceneMemoryCard(unknownFact, context).ok, errorText(validateSceneMemoryCard(unknownFact, context)))

  // Ledger metadata must not become an unreviewed semantic escape hatch.  A
  // forged card can otherwise keep the same accepted prose and simply rewrite
  // relationship dimensions, thread identity/lifecycle, or participant role
  // before recomputing cardHash.  These are deliberately red tests: a passing
  // validator here means the metadata mutation was accepted without evidence.
  const forgedRelationshipDimension = clone(card)
  forgedRelationshipDimension.relationshipChanges = [{
    ...forgedRelationshipDimension.relationshipChanges[0]!,
    dimension: 'hostility'
  }]
  forgedRelationshipDimension.cardHash = sceneMemoryCardHash(forgedRelationshipDimension)
  rejects('relationship dimension rewrite requires evidence', forgedRelationshipDimension, context, 'evidence')

  const forgedThreadMetadata = clone(card)
  forgedThreadMetadata.threads = [{
    ...forgedThreadMetadata.threads[0]!,
    threadId: 'thread-r69-invented',
    lifecycle: 'resolved'
  }]
  forgedThreadMetadata.cardHash = sceneMemoryCardHash(forgedThreadMetadata)
  rejects('thread id/lifecycle rewrite requires evidence', forgedThreadMetadata, context, 'evidence')

  const forgedParticipantRole = clone(card)
  forgedParticipantRole.participants = forgedParticipantRole.participants.map((participant) => participant.id === 'linzhou'
    ? { ...participant, role: 'antagonist' }
    : participant)
  forgedParticipantRole.cardHash = sceneMemoryCardHash(forgedParticipantRole)
  rejects('participant role rewrite requires evidence', forgedParticipantRole, context, 'evidence')

  // Two non-contiguous one-character spans must not be concatenated into a
  // new claim.  The accepted source starts with 甲😀乙, so no individual span
  // contains the forged location 甲乙; the current join-based checker does.
  const firstCrossSpan: SceneMemorySourceSpan = {
    ...span,
    spanId: 'span-r69-cross-first',
    startUtf16: 0,
    endUtf16: 1,
    text: segment.content.slice(0, 1),
    spanHash: sha256(segment.content.slice(0, 1))
  }
  const secondCrossSpan: SceneMemorySourceSpan = {
    ...span,
    spanId: 'span-r69-cross-second',
    startUtf16: 3,
    endUtf16: 4,
    text: segment.content.slice(3, 4),
    spanHash: sha256(segment.content.slice(3, 4))
  }
  const forgedCrossSpanClaim = clone(card)
  forgedCrossSpanClaim.locations = ['甲乙']
  forgedCrossSpanClaim.sourceSpans = [span, firstCrossSpan, secondCrossSpan]
  forgedCrossSpanClaim.fieldEvidence = {
    ...forgedCrossSpanClaim.fieldEvidence,
    'locations:甲乙': [sourceSpanEvidence(firstCrossSpan), sourceSpanEvidence(secondCrossSpan)]
  }
  forgedCrossSpanClaim.cardHash = sceneMemoryCardHash(forgedCrossSpanClaim)
  rejects('non-contiguous spans cannot manufacture one claim', forgedCrossSpanClaim, context, 'evidence')

  const { hash: _relationshipHashForExtras, ...relationshipClaimPayloadForExtras } = relationshipClaim
  const extraRelationshipPayload = { ...relationshipClaimPayloadForExtras, id: 'ledger-rel-r69-extra' }
  const extraRelationshipClaim: SceneMemoryRelationshipLedgerClaim = { ...extraRelationshipPayload, hash: sceneMemoryLedgerClaimHash(extraRelationshipPayload) }
  const { hash: _threadHashForExtras, ...threadClaimPayloadForExtras } = threadClaim
  const extraThreadPayload = { ...threadClaimPayloadForExtras, id: 'ledger-thread-r69-extra' }
  const extraThreadClaim: SceneMemoryForeshadowLedgerClaim = { ...extraThreadPayload, hash: sceneMemoryLedgerClaimHash(extraThreadPayload) }
  const secondRelationshipPayload = { ...relationshipClaimPayloadForExtras, id: 'ledger-rel-r69-second', dimension: 'respect' }
  const secondRelationshipClaim: SceneMemoryRelationshipLedgerClaim = { ...secondRelationshipPayload, hash: sceneMemoryLedgerClaimHash(secondRelationshipPayload) }
  const secondThreadPayload = { ...threadClaimPayloadForExtras, id: 'ledger-thread-r69-second', threadId: 'thread-r69-second', lifecycle: 'open' as const }
  const secondThreadClaim: SceneMemoryForeshadowLedgerClaim = { ...secondThreadPayload, hash: sceneMemoryLedgerClaimHash(secondThreadPayload) }
  const multiCard = clone(card)
  multiCard.relationshipChanges.push({ fromCharacterId: 'linzhou', toCharacterId: 'shen-yao', dimension: 'respect', from: '不信任', to: '暂时合作', evidence: [sourceSpanEvidence(span), ledgerEvidence(secondRelationshipClaim.id, secondRelationshipClaim.hash)] })
  multiCard.threads.push({ threadId: 'thread-r69-second', lifecycle: 'open', summary: '第二线程已开启', evidence: [sourceSpanEvidence(span), ledgerEvidence(secondThreadClaim.id, secondThreadClaim.hash)] })
  multiCard.cardHash = sceneMemoryCardHash(multiCard)
  check('multiple relationships and threads bind to distinct ledger claims', validateSceneMemoryCard(multiCard, { ...context, ledgerClaims: [...context.ledgerClaims, secondRelationshipClaim, secondThreadClaim] }).ok)
  const multiRelationship = clone(card)
  multiRelationship.relationshipChanges[0]!.evidence = [...multiRelationship.relationshipChanges[0]!.evidence, ledgerEvidence(extraRelationshipClaim.id, extraRelationshipClaim.hash)]
  multiRelationship.cardHash = sceneMemoryCardHash(multiRelationship)
  rejects('one relationship cannot cite multiple ledger claims', multiRelationship, { ...context, ledgerClaims: [...context.ledgerClaims, extraRelationshipClaim] }, 'relationship_ledger_evidence')
  const multiThread = clone(card)
  multiThread.threads[0]!.evidence = [...multiThread.threads[0]!.evidence, ledgerEvidence(extraThreadClaim.id, extraThreadClaim.hash)]
  multiThread.cardHash = sceneMemoryCardHash(multiThread)
  rejects('one thread cannot cite multiple ledger claims', multiThread, { ...context, ledgerClaims: [...context.ledgerClaims, extraThreadClaim] }, 'thread_ledger_evidence')

  const forgedEndpoint = clone(card)
  forgedEndpoint.relationshipChanges[0] = { ...forgedEndpoint.relationshipChanges[0]!, fromCharacterId: 'shen-yao' }
  forgedEndpoint.cardHash = sceneMemoryCardHash(forgedEndpoint)
  rejects('relationship endpoint rewrite is rejected by ledger claim', forgedEndpoint, context, 'relationship_ledger_claim_mismatch')
  const forgedLedgerRef = clone(card)
  forgedLedgerRef.relationshipChanges[0]!.evidence = [
    ...forgedLedgerRef.relationshipChanges[0]!.evidence,
    ledgerEvidence(relationshipClaim.id, sha256('wrong-ledger-hash'))
  ]
  forgedLedgerRef.cardHash = sceneMemoryCardHash(forgedLedgerRef)
  rejects('ledger ref with wrong hash is rejected', forgedLedgerRef, context, 'ledger_claim_missing')
  const duplicateLedgerClaimContext = {
    ...context,
    ledgerClaims: [...context.ledgerClaims, { ...relationshipClaim }]
  }
  rejects('duplicate ledger claim id/hash is rejected', card, duplicateLedgerClaimContext, 'duplicate_ledger_claim')
  rejects('ledger claims cannot cross story scope', card, { ...context, expectedScope: { ...context.expectedScope, branchId: 'alternate' } }, 'ledger_claim_scope')
  rejects('ledger claims cannot cross validity epoch', card, { ...context, expectedValidityEpoch: 3 }, 'ledger_claim_epoch')
  rejects('ledger claims cannot cross story revision', card, { ...context, expectedStoryRevision: 8 }, 'ledger_claim_revision')
  rejects('ledger claims cannot cross state binding', card, { ...context, expectedBindings: { ...context.expectedBindings, stateDeltaHash: sha256('other-delta') } }, 'ledger_claim_state_delta')
  rejects('ledger claims cannot cross manifest binding', card, { ...context, expectedBindings: { ...context.expectedBindings, commitManifestHash: sha256('other-manifest') } }, 'ledger_claim_manifest')

  // Repeated source IDs/spans and append-only invariants must fail closed.
  const duplicateSourceId = clone(card)
  duplicateSourceId.sourceSegmentIds = [segment.segmentId, segment.segmentId]
  duplicateSourceId.cardHash = sceneMemoryCardHash(duplicateSourceId)
  rejects('duplicate source segment id is rejected', duplicateSourceId, context, 'duplicate')
  const duplicateSpan = clone(card)
  duplicateSpan.sourceSpans = [span, { ...span }]
  duplicateSpan.cardHash = sceneMemoryCardHash(duplicateSpan)
  rejects('duplicate source span id is rejected', duplicateSpan, context, 'duplicate')
  throws('append-only rejects duplicate card id', () => appendSceneMemoryCard([card], card, context), 'duplicate')
  const sameRevision = buildSceneMemoryCard({ ...input, cardId: 'card-r69-same-revision', createdAt: 2000 })
  throws('append-only rejects same story revision', () => appendSceneMemoryCard([card], sameRevision, context), 'revision')
  const { hash: _relationshipHash, ...relationshipClaimPayload } = relationshipClaim
  const nextRelationshipPayload = { ...relationshipClaimPayload, id: 'ledger-rel-r69-adversarial-2', revision: 8 }
  const nextRelationshipClaim = { ...nextRelationshipPayload, hash: sceneMemoryLedgerClaimHash(nextRelationshipPayload) }
  const { hash: _threadHash, ...threadClaimPayload } = threadClaim
  const nextThreadPayload = { ...threadClaimPayload, id: 'ledger-thread-r69-adversarial-2', revision: 8 }
  const nextThreadClaim = { ...nextThreadPayload, hash: sceneMemoryLedgerClaimHash(nextThreadPayload) }
  const nextRevision = buildSceneMemoryCard({ ...input, cardId: 'card-r69-next', storyRevision: 8, sceneOrder: 4, createdAt: 3000, expectedStoryRevision: 8, ledgerClaims: [nextRelationshipClaim, nextThreadClaim], relationshipChanges: input.relationshipChanges.map((item) => ({ ...item, evidence: item.evidence.map((ref) => ref.id === relationshipClaim.id ? ledgerEvidence(nextRelationshipClaim.id, nextRelationshipClaim.hash) : ref) })), threads: input.threads.map((item) => ({ ...item, evidence: item.evidence.map((ref) => ref.id === threadClaim.id ? ledgerEvidence(nextThreadClaim.id, nextThreadClaim.hash) : ref) })) })
  // append validates a mixed-revision history in one call, so do not pass a
  // single-card expectedStoryRevision fence to this collection-level probe.
  const appendContext = { ...context, ledgerClaims: [...context.ledgerClaims, nextRelationshipClaim, nextThreadClaim] } as Omit<SceneMemoryCardValidationContext, 'expectedStoryRevision'> as SceneMemoryCardValidationContext
  delete (appendContext as Partial<SceneMemoryCardValidationContext>).expectedStoryRevision
  check('append-only accepts a strictly later revision', appendSceneMemoryCard([card], nextRevision, appendContext).length === 2)

  const retracted = { ...segment, status: 'superseded' as const }
  rejects('retracted/superseded source segment is rejected', card, { ...context, sourceSegments: [retracted] }, 'status')
  const crossScene = { ...segment, sceneId: 'scene:r69:other' }
  rejects('source segment from another scene is rejected', card, { ...context, sourceSegments: [crossScene] }, 'scene')

  // Non-finite values, undefined, and incomplete embeddings must never hash
  // into an apparently valid card.
  const nanEpoch = clone(card)
  nanEpoch.validityEpoch = Number.NaN
  nanEpoch.cardHash = sceneMemoryCardHash(nanEpoch)
  rejects('NaN epoch is rejected', nanEpoch, context, 'epoch')
  const infinityCreatedAt = clone(card)
  infinityCreatedAt.createdAt = Number.POSITIVE_INFINITY
  infinityCreatedAt.cardHash = sceneMemoryCardHash(infinityCreatedAt)
  rejects('Infinity createdAt is rejected', infinityCreatedAt, context, 'created_at')
  const undefinedContract = clone(card) as SceneMemoryCard & { contractHash?: string }
  undefinedContract.contractHash = undefined
  undefinedContract.cardHash = sceneMemoryCardHash(undefinedContract)
  rejects('undefined contract hash is rejected', undefinedContract, context, 'contract_hash')
  const nanEmbedding = clone(card)
  nanEmbedding.embedding = { ...nanEmbedding.embedding, dimensions: Number.NaN }
  nanEmbedding.cardHash = sceneMemoryCardHash(nanEmbedding)
  rejects('NaN embedding dimensions are rejected', nanEmbedding, context, 'embedding')
  const incompleteEmbedding = clone(card)
  incompleteEmbedding.embedding = { status: 'ready', version: 'v1', modelId: null, dimensions: 3, vectorHash: sha256('vector') }
  incompleteEmbedding.cardHash = sceneMemoryCardHash(incompleteEmbedding)
  rejects('ready embedding with missing identity is rejected', incompleteEmbedding, context, 'embedding')

  // A hash must commit every semantic field except the explicitly volatile
  // timestamp.  These mutations are deliberately computed with the card's
  // old hash: validator must catch them as tampering.
  const hashFields: Array<[string, (value: SceneMemoryCard) => void]> = [
    ['status', (value) => { value.status = 'partial' }],
    ['cardId', (value) => { value.cardId = 'card-r69-mutated' }],
    ['storyId', (value) => { value.storyId = 'story-other' }],
    ['projectId', (value) => { value.projectId = 'project-other' }],
    ['branchId', (value) => { value.branchId = 'branch-other' }],
    ['runId', (value) => { value.runId = 'run-other' }],
    ['sceneId', (value) => { value.sceneId = 'scene-other' }],
    ['sceneOrder', (value) => { value.sceneOrder = 4 }],
    ['sceneContentHash', (value) => { value.sceneContentHash = sha256('other-content') }],
    ['commitManifestHash', (value) => { value.commitManifestHash = sha256('other-manifest') }],
    ['stateDeltaHash', (value) => { value.stateDeltaHash = sha256('other-delta') }],
    ['semantic field', (value) => { value.cost = '另一种代价' }],
    ['sourceSegmentIds', (value) => { value.sourceSegmentIds = ['other-segment'] }],
    ['sourceSpans', (value) => { value.sourceSpans = [{ ...value.sourceSpans[0]!, spanId: 'span-r69-other' }] }],
    ['embedding', (value) => { value.embedding = { ...value.embedding, status: 'stale' } }]
  ]
  for (const [label, mutate] of hashFields) {
    const tampered = clone(card)
    mutate(tampered)
    check(`cardHash commits ${label}`, tampered.cardHash !== sceneMemoryCardHash(tampered))
  }

  console.log(`\nR69 SceneMemoryCard adversarial: ${passed} PASS / ${failed} FAIL`)
  console.log(failed === 0 ? 'R69 verdict: ACCEPT' : 'R69 verdict: RETURN')
  process.exitCode = failed > 0 ? 1 : 0
}

try {
  main()
} catch (error) {
  console.error('R69 adversarial execution error:', error)
  process.exitCode = 2
}
