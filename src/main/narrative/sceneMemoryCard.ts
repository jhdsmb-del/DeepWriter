import { createHash } from 'node:crypto'
import type {
  EvidenceBoundBeliefChange,
  EvidenceBoundFact,
  EvidenceBoundRelationshipChange,
  EvidenceBoundText,
  EvidenceBoundThreadChange,
  SceneMemoryCard,
  SceneMemoryCardBuildInput,
  SceneMemoryCardValidationContext,
  SceneMemoryCardValidationResult,
  SceneMemoryEmbedding,
  SceneMemoryEvidenceRef,
  SceneMemoryLedgerClaim,
  SceneMemoryParticipant,
  SceneMemorySourceSegment,
  SceneMemorySourceSpan
} from '../../shared/types'

const HASH_RE = /^[0-9a-f]{64}$/u
// Outline scene IDs may contain Chinese text. Keep the same bounded identifier
// shape while rejecting whitespace, control characters and path separators.
const STRUCTURAL_ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,239}$/u
const MAX_TEXT = 16_000

/** Error thrown by the builder and append-only projection when a card is not
 * completely source-bound.  The individual errors are deliberately stable so
 * the worker and the red tests can distinguish a real refusal from a crash. */
export class SceneMemoryCardValidationError extends Error {
  readonly code = 'scene_memory_card_invalid'
  readonly errors: string[]

  constructor(errors: readonly string[]) {
    const values = [...new Set(errors)]
    super(values[0] ?? 'scene_memory_card_invalid')
    this.name = 'SceneMemoryCardValidationError'
    this.errors = values
  }
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Stable, recursive JSON used for card hashes and manifests. */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(object).sort(compareText).map((key) => [key, stableValue(object[key])]))
  }
  return value
}

export function stableSceneMemoryJson(value: unknown): string {
  return JSON.stringify(stableValue(value)) ?? 'null'
}

function sortedText(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].map((value) => value.trim()).sort(compareText)
}

function evidenceKey(value: SceneMemoryEvidenceRef): string {
  return `${value.kind}\u0000${value.id}\u0000${value.hash}\u0000${value.spanId ?? ''}`
}

function canonicalEvidence(values: readonly SceneMemoryEvidenceRef[] | undefined): SceneMemoryEvidenceRef[] {
  return [...(values ?? [])]
    .map((value) => ({ ...value }))
    .sort((left, right) => compareText(evidenceKey(left), evidenceKey(right)))
}

function canonicalParticipants(values: readonly SceneMemoryParticipant[] | undefined): SceneMemoryParticipant[] {
  return [...(values ?? [])]
    .map((value) => ({ id: value.id, role: value.role, evidence: canonicalEvidence(value.evidence) }))
    .sort((left, right) => compareText(`${left.id}\u0000${left.role}`, `${right.id}\u0000${right.role}`))
}

function canonicalCard(value: Partial<SceneMemoryCard>): Partial<SceneMemoryCard> {
  const fieldEvidence = value.fieldEvidence
    ? Object.fromEntries(Object.keys(value.fieldEvidence).sort(compareText).map((key) => [key, canonicalEvidence(value.fieldEvidence?.[key])]))
    : undefined
  const embedding = value.embedding
    ? {
      status: value.embedding.status,
      version: value.embedding.version,
      modelId: value.embedding.modelId,
      dimensions: value.embedding.dimensions,
      vectorHash: value.embedding.vectorHash
    }
    : undefined
  return {
    ...value,
    ...(value.participants !== undefined ? { participants: canonicalParticipants(value.participants) } : {}),
    ...(value.locations !== undefined ? { locations: sortedText(value.locations) } : {}),
    ...(value.objects !== undefined ? { objects: sortedText(value.objects) } : {}),
    ...(value.factsEstablished !== undefined ? {
      factsEstablished: [...value.factsEstablished]
        .map((item) => ({ ...item, evidence: canonicalEvidence(item.evidence) }))
        .sort((left, right) => compareText(`${left.factId}\u0000${left.statement}`, `${right.factId}\u0000${right.statement}`))
    } : {}),
    ...(value.beliefChanges !== undefined ? {
      beliefChanges: [...value.beliefChanges]
        .map((item) => ({ ...item, evidence: canonicalEvidence(item.evidence) }))
        .sort((left, right) => compareText(`${left.characterId}\u0000${left.from ?? ''}\u0000${left.to ?? ''}`, `${right.characterId}\u0000${right.from ?? ''}\u0000${right.to ?? ''}`))
    } : {}),
    ...(value.relationshipChanges !== undefined ? {
      relationshipChanges: [...value.relationshipChanges]
        .map((item) => ({ ...item, evidence: canonicalEvidence(item.evidence) }))
        .sort((left, right) => compareText(`${left.fromCharacterId}\u0000${left.toCharacterId}\u0000${left.dimension}`, `${right.fromCharacterId}\u0000${right.toCharacterId}\u0000${right.dimension}`))
    } : {}),
    ...(value.threads !== undefined ? {
      threads: [...value.threads]
        .map((item) => ({ ...item, evidence: canonicalEvidence(item.evidence) }))
        .sort((left, right) => compareText(`${left.threadId}\u0000${left.lifecycle}\u0000${left.summary ?? ''}`, `${right.threadId}\u0000${right.lifecycle}\u0000${right.summary ?? ''}`))
    } : {}),
    ...(value.motifs !== undefined ? {
      motifs: [...value.motifs]
        .map((item) => ({ text: item.text, evidence: canonicalEvidence(item.evidence) }))
        .sort((left, right) => compareText(left.text, right.text))
    } : {}),
    ...(value.distinctivePhrases !== undefined ? {
      distinctivePhrases: [...value.distinctivePhrases]
        .map((item) => ({ text: item.text, evidence: canonicalEvidence(item.evidence) }))
        .sort((left, right) => compareText(left.text, right.text))
    } : {}),
    ...(value.sourceSegmentIds !== undefined ? { sourceSegmentIds: sortedText(value.sourceSegmentIds) } : {}),
    ...(value.sourceSpans !== undefined ? {
      sourceSpans: [...value.sourceSpans]
        .map((item) => ({ ...item }))
        .sort((left, right) => compareText(`${left.segmentId}\u0000${left.segmentRevision}\u0000${String(left.startUtf16).padStart(12, '0')}\u0000${String(left.endUtf16).padStart(12, '0')}\u0000${left.spanId}`, `${right.segmentId}\u0000${right.segmentRevision}\u0000${String(right.startUtf16).padStart(12, '0')}\u0000${String(right.endUtf16).padStart(12, '0')}\u0000${right.spanId}`))
    } : {}),
    ...(embedding !== undefined ? { embedding } : {}),
    ...(fieldEvidence !== undefined ? { fieldEvidence } : {})
  }
}

function cardHashPayload(card: Partial<SceneMemoryCard>): Partial<SceneMemoryCard> {
  const { cardHash: _cardHash, createdAt: _createdAt, ...withoutVolatile } = card
  return canonicalCard(withoutVolatile)
}

/** cardHash covers every card field except the explicitly volatile timestamp. */
export function sceneMemoryCardHash(card: Partial<SceneMemoryCard>): string {
  return sha256Text(stableSceneMemoryJson(cardHashPayload(card)))
}

export const memoryCardHash = sceneMemoryCardHash

export function stableSceneMemoryCardJson(card: SceneMemoryCard): string {
  return stableSceneMemoryJson(canonicalCard(card))
}

export const serializeSceneMemoryCard = stableSceneMemoryCardJson

export function sourceSpanEvidence(span: SceneMemorySourceSpan): SceneMemoryEvidenceRef {
  return { kind: 'source_span', id: span.spanId, spanId: span.spanId, hash: span.spanHash }
}

export const makeSourceSpanEvidence = sourceSpanEvidence

export function contractEvidence(contractId: string, contractHash: string): SceneMemoryEvidenceRef {
  return { kind: 'contract', id: contractId, hash: contractHash }
}

export function ledgerEvidence(id: string, hash: string): SceneMemoryEvidenceRef {
  return { kind: 'ledger', id, hash }
}

/**
 * Canonical content address for a ledger claim.  The stored `hash` is excluded
 * from its own preimage; all authority fields and semantic endpoints remain
 * bound.  Repository persistence and the WP1 validator use this same helper,
 * so changing an opaque hash or one claim field cannot remain self-consistent.
 */
export function sceneMemoryLedgerClaimHash(claim: Omit<SceneMemoryLedgerClaim, 'hash'>): string {
  return sha256Text(stableSceneMemoryJson(claim))
}

export const memoryLedgerClaimHash = sceneMemoryLedgerClaimHash

export function makeSceneMemorySourceSpan(input: {
  spanId: string
  segmentId: string
  segmentHash: string
  segmentRevision: number
  manifestHash: string
  content: string
  startUtf16: number
  endUtf16: number
}): SceneMemorySourceSpan {
  const text = input.content.slice(input.startUtf16, input.endUtf16)
  return {
    spanId: input.spanId,
    segmentId: input.segmentId,
    segmentHash: input.segmentHash,
    segmentRevision: input.segmentRevision,
    manifestHash: input.manifestHash,
    startUtf16: input.startUtf16,
    endUtf16: input.endUtf16,
    text,
    spanHash: sha256Text(text)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value)
}

function validStructuralId(value: unknown): value is string {
  return typeof value === 'string' && STRUCTURAL_ID_RE.test(value)
}

function validTextIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isSurrogateBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false
  const previous = text.charCodeAt(offset - 1)
  const next = text.charCodeAt(offset)
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
}

function add(errors: string[], code: string, path: string): void {
  errors.push(`${code}:${path}`)
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isUnknown(value: unknown): boolean {
  return typeof value === 'string' && ['unknown', '未知', '不明', '未确认', 'pending'].includes(value.trim().toLocaleLowerCase())
}

function normalizeClaim(value: string): string {
  return value.replace(/\s+/gu, '').trim()
}

function sourceTextsForRefs(refs: readonly SceneMemoryEvidenceRef[], spans: Map<string, SceneMemorySourceSpan>): string[] {
  return refs
    .filter((ref) => ref.kind === 'source_span')
    .map((ref) => spans.get(ref.spanId ?? ref.id)?.text ?? '')
}

function hasSourceEvidence(refs: readonly SceneMemoryEvidenceRef[] | undefined): boolean {
  return Boolean(refs?.some((ref) => ref.kind === 'source_span'))
}

function validateContextShape(context: unknown, errors: string[]): context is SceneMemoryCardValidationContext {
  if (!isRecord(context)) {
    add(errors, 'scene_memory_validation_context_missing', 'context')
    return false
  }
  if (!Array.isArray(context.sourceSegments)) add(errors, 'scene_memory_validation_source_segments_missing', 'context.sourceSegments')
  if (!isRecord(context.expectedScope) || !validStructuralId(context.expectedScope.storyId) || !validStructuralId(context.expectedScope.projectId) || !validStructuralId(context.expectedScope.branchId)) add(errors, 'scene_memory_validation_scope_missing', 'context.expectedScope')
  if (!Number.isInteger(context.expectedValidityEpoch) || Number(context.expectedValidityEpoch) < 1) add(errors, 'scene_memory_validation_epoch_missing', 'context.expectedValidityEpoch')
  if (!Number.isInteger(context.expectedStoryRevision) || Number(context.expectedStoryRevision) < 1) add(errors, 'scene_memory_validation_revision_missing', 'context.expectedStoryRevision')
  if (!isRecord(context.expectedContract) || !validStructuralId(context.expectedContract.contractId) || !validHash(context.expectedContract.contractHash)) add(errors, 'scene_memory_validation_contract_missing', 'context.expectedContract')
  if (!isRecord(context.expectedBindings) || !validHash(context.expectedBindings.sceneContentHash) || !validHash(context.expectedBindings.commitManifestHash) || !validHash(context.expectedBindings.stateDeltaHash)) add(errors, 'scene_memory_validation_bindings_missing', 'context.expectedBindings')
  if (!Array.isArray(context.ledgerClaims)) add(errors, 'scene_memory_validation_ledger_claims_missing', 'context.ledgerClaims')
  else validateLedgerClaims(context.ledgerClaims, errors)
  return errors.length === 0
}

function validateLedgerClaims(claims: readonly unknown[], errors: string[]): void {
  const ids = new Set<string>()
  const hashes = new Set<string>()
  claims.forEach((claim, index) => {
    if (!isRecord(claim) || !['relationship', 'foreshadow'].includes(String(claim.kind))) {
      add(errors, 'scene_memory_ledger_claim_invalid', `ledgerClaims[${index}]`)
      return
    }
    if (!validStructuralId(claim.id)) add(errors, 'scene_memory_ledger_claim_id_invalid', `ledgerClaims[${index}].id`)
    if (!validHash(claim.hash)) add(errors, 'scene_memory_ledger_claim_hash_invalid', `ledgerClaims[${index}].hash`)
    if (!Number.isInteger(claim.revision) || Number(claim.revision) < 1) add(errors, 'scene_memory_ledger_claim_revision_invalid', `ledgerClaims[${index}].revision`)
    if (!Number.isInteger(claim.validityEpoch) || Number(claim.validityEpoch) < 1) add(errors, 'scene_memory_ledger_claim_epoch_invalid', `ledgerClaims[${index}].validityEpoch`)
    for (const field of ['storyId', 'projectId', 'branchId'] as const) if (!validStructuralId(claim[field])) add(errors, 'scene_memory_ledger_claim_scope_invalid', `ledgerClaims[${index}].${field}`)
    if (!validHash(claim.stateDeltaHash)) add(errors, 'scene_memory_ledger_claim_state_delta_invalid', `ledgerClaims[${index}].stateDeltaHash`)
    if (!validHash(claim.commitManifestHash)) add(errors, 'scene_memory_ledger_claim_manifest_invalid', `ledgerClaims[${index}].commitManifestHash`)
    if (claim.kind === 'relationship') {
      if (!validTextIdentifier(claim.fromCharacterId) || !validTextIdentifier(claim.toCharacterId) || !isNonEmpty(claim.dimension)) add(errors, 'scene_memory_ledger_relationship_fields_invalid', `ledgerClaims[${index}]`)
    } else if (!validStructuralId(claim.threadId) || !['open', 'advanced', 'delayed', 'resolved', 'abandoned'].includes(String(claim.lifecycle))) {
      add(errors, 'scene_memory_ledger_foreshadow_fields_invalid', `ledgerClaims[${index}]`)
    }
    if (validStructuralId(claim.id) && validHash(claim.hash) && validHash(claim.stateDeltaHash) && validHash(claim.commitManifestHash) && Number.isInteger(claim.revision) && Number(claim.revision) >= 1 && Number.isInteger(claim.validityEpoch) && Number(claim.validityEpoch) >= 1 && ['relationship', 'foreshadow'].includes(String(claim.kind))) {
      const { hash: _hash, ...withoutHash } = claim
      if (sceneMemoryLedgerClaimHash(withoutHash as Omit<SceneMemoryLedgerClaim, 'hash'>) !== claim.hash) add(errors, 'scene_memory_ledger_claim_hash_mismatch', `ledgerClaims[${index}].hash`)
    }
    if (validStructuralId(claim.id)) {
      if (ids.has(claim.id)) add(errors, 'scene_memory_duplicate_ledger_claim_id', `ledgerClaims[${index}].id`)
      ids.add(claim.id)
    }
    if (validHash(claim.hash)) {
      if (hashes.has(claim.hash)) add(errors, 'scene_memory_duplicate_ledger_claim_hash', `ledgerClaims[${index}].hash`)
      hashes.add(claim.hash)
    }
  })
}

function validateLedgerClaimsAgainstContext(context: SceneMemoryCardValidationContext, errors: string[]): void {
  for (const claim of context.ledgerClaims) {
    if (claim.revision !== context.expectedStoryRevision) add(errors, 'scene_memory_ledger_claim_revision_mismatch', `ledgerClaims.${claim.id}`)
    if (claim.validityEpoch !== context.expectedValidityEpoch) add(errors, 'scene_memory_ledger_claim_epoch_mismatch', `ledgerClaims.${claim.id}`)
    if (claim.storyId !== context.expectedScope.storyId || claim.projectId !== context.expectedScope.projectId || claim.branchId !== context.expectedScope.branchId) add(errors, 'scene_memory_ledger_claim_scope_mismatch', `ledgerClaims.${claim.id}`)
    if (claim.stateDeltaHash !== context.expectedBindings.stateDeltaHash) add(errors, 'scene_memory_ledger_claim_state_delta_mismatch', `ledgerClaims.${claim.id}`)
    if (claim.commitManifestHash !== context.expectedBindings.commitManifestHash) add(errors, 'scene_memory_ledger_claim_manifest_mismatch', `ledgerClaims.${claim.id}`)
  }
}

function validateSourceSegments(segments: readonly SceneMemorySourceSegment[] | undefined, errors: string[]): Map<string, SceneMemorySourceSegment> {
  const map = new Map<string, SceneMemorySourceSegment>()
  if (!Array.isArray(segments) || segments.length === 0) {
    add(errors, 'scene_memory_source_segments_missing', 'sourceSegments')
    return map
  }
  segments.forEach((segment, index) => {
    if (!isRecord(segment)) {
      add(errors, 'scene_memory_segment_invalid', `sourceSegments[${index}]`)
      return
    }
    const id = segment.segmentId
    if (!validStructuralId(id)) add(errors, 'scene_memory_segment_id_invalid', `sourceSegments[${index}].segmentId`)
    if (typeof segment.content !== 'string' || segment.content.length > MAX_TEXT * 32) add(errors, 'scene_memory_segment_content_invalid', `sourceSegments[${index}].content`)
    if (!validHash(segment.contentHash)) add(errors, 'scene_memory_segment_hash_invalid', `sourceSegments[${index}].contentHash`)
    if (!Number.isInteger(segment.segmentRevision) || Number(segment.segmentRevision) < 1) add(errors, 'scene_memory_segment_revision_invalid', `sourceSegments[${index}].segmentRevision`)
    if (segment.status !== 'accepted') add(errors, 'scene_memory_segment_status_invalid', `sourceSegments[${index}].status`)
    if (!validStructuralId(segment.sceneId)) add(errors, 'scene_memory_segment_scene_invalid', `sourceSegments[${index}].sceneId`)
    if (!validStructuralId(segment.commitId)) add(errors, 'scene_memory_segment_commit_invalid', `sourceSegments[${index}].commitId`)
    if (!validHash(segment.commitManifestHash)) add(errors, 'scene_memory_segment_manifest_invalid', `sourceSegments[${index}].commitManifestHash`)
    if (!Number.isInteger(segment.chunkIndex) || Number(segment.chunkIndex) < 0) add(errors, 'scene_memory_segment_chunk_invalid', `sourceSegments[${index}].chunkIndex`)
    if (validStructuralId(id)) {
      if (map.has(id)) add(errors, 'scene_memory_duplicate_segment_id', `sourceSegments[${index}].segmentId`)
      else map.set(id, segment as unknown as SceneMemorySourceSegment)
    }
    if (typeof segment.content === 'string' && validHash(segment.contentHash) && sha256Text(segment.content) !== segment.contentHash) add(errors, 'scene_memory_segment_hash_mismatch', `sourceSegments[${index}].contentHash`)
  })
  return map
}

function selectedSegmentContentHash(ids: readonly string[], segments: Map<string, SceneMemorySourceSegment>): string {
  const selected = ids
    .map((id) => segments.get(id))
    .filter((segment): segment is SceneMemorySourceSegment => Boolean(segment))
    .sort((left, right) => left.chunkIndex - right.chunkIndex || left.segmentRevision - right.segmentRevision || compareText(left.segmentId, right.segmentId))
  return sha256Text(selected.map((segment) => segment.content).join(''))
}

export function sceneContentHashForSegments(segments: readonly SceneMemorySourceSegment[]): string {
  const sorted = [...segments].sort((left, right) => left.chunkIndex - right.chunkIndex || left.segmentRevision - right.segmentRevision || compareText(left.segmentId, right.segmentId))
  return sha256Text(sorted.map((segment) => segment.content).join(''))
}

function validateSourceSpans(card: Partial<SceneMemoryCard>, context: SceneMemoryCardValidationContext, errors: string[]): { spans: Map<string, SceneMemorySourceSpan>; segments: Map<string, SceneMemorySourceSegment> } {
  const segments = validateSourceSegments(context.sourceSegments, errors)
  const spanMap = new Map<string, SceneMemorySourceSpan>()
  const ids = card.sourceSegmentIds
  const spans = card.sourceSpans
  const selected = new Set<string>()
  if (!Array.isArray(ids) || ids.length === 0) add(errors, 'scene_memory_source_segment_ids_missing', 'sourceSegmentIds')
  else ids.forEach((id, index) => {
    if (!validStructuralId(id)) add(errors, 'scene_memory_source_segment_id_invalid', `sourceSegmentIds[${index}]`)
    if (selected.has(id)) add(errors, 'scene_memory_duplicate_source_segment_id', `sourceSegmentIds[${index}]`)
    selected.add(id)
    if (!segments.has(id)) add(errors, 'scene_memory_source_segment_missing', `sourceSegmentIds[${index}]`)
  })
  if (!Array.isArray(spans) || spans.length === 0) {
    add(errors, 'scene_memory_source_spans_missing', 'sourceSpans')
    return { spans: spanMap, segments }
  }
  spans.forEach((span, index) => {
    if (!isRecord(span)) {
      add(errors, 'scene_memory_span_invalid', `sourceSpans[${index}]`)
      return
    }
    const spanId = span.spanId
    const segmentId = span.segmentId
    const segment = typeof segmentId === 'string' ? segments.get(segmentId) : undefined
    if (!validStructuralId(spanId)) add(errors, 'scene_memory_span_id_invalid', `sourceSpans[${index}].spanId`)
    if (!validStructuralId(segmentId)) add(errors, 'scene_memory_span_segment_id_invalid', `sourceSpans[${index}].segmentId`)
    if (typeof segmentId === 'string' && !selected.has(segmentId)) add(errors, 'scene_memory_span_segment_unlisted', `sourceSpans[${index}].segmentId`)
    if (typeof spanId === 'string') {
      if (spanMap.has(spanId)) add(errors, 'scene_memory_duplicate_span_id', `sourceSpans[${index}].spanId`)
      else spanMap.set(spanId, span as unknown as SceneMemorySourceSpan)
    }
    if (!validHash(span.segmentHash)) add(errors, 'scene_memory_span_segment_hash_invalid', `sourceSpans[${index}].segmentHash`)
    if (!Number.isInteger(span.segmentRevision) || Number(span.segmentRevision) < 1) add(errors, 'scene_memory_span_revision_invalid', `sourceSpans[${index}].segmentRevision`)
    if (!validHash(span.manifestHash)) add(errors, 'scene_memory_span_manifest_invalid', `sourceSpans[${index}].manifestHash`)
    if (typeof span.text !== 'string' || span.text.length === 0 || span.text.length > MAX_TEXT) add(errors, 'scene_memory_span_text_invalid', `sourceSpans[${index}].text`)
    if (!Number.isInteger(span.startUtf16) || !Number.isInteger(span.endUtf16) || span.startUtf16 < 0 || span.endUtf16 <= span.startUtf16) {
      add(errors, 'scene_memory_span_range_invalid', `sourceSpans[${index}]`)
      return
    }
    if (segment && span.endUtf16 > segment.content.length) add(errors, 'scene_memory_span_range_invalid', `sourceSpans[${index}]`)
    if (segment && span.segmentHash !== segment.contentHash) add(errors, 'scene_memory_segment_hash_mismatch', `sourceSpans[${index}].segmentHash`)
    if (segment && span.segmentRevision !== segment.segmentRevision) add(errors, 'scene_memory_span_revision_mismatch', `sourceSpans[${index}].segmentRevision`)
    if (segment && span.manifestHash !== segment.commitManifestHash) add(errors, 'scene_memory_span_manifest_mismatch', `sourceSpans[${index}].manifestHash`)
    if (segment && isSurrogateBoundary(segment.content, span.startUtf16)) add(errors, 'scene_memory_span_boundary_invalid', `sourceSpans[${index}].startUtf16`)
    if (segment && isSurrogateBoundary(segment.content, span.endUtf16)) add(errors, 'scene_memory_span_boundary_invalid', `sourceSpans[${index}].endUtf16`)
    if (segment && typeof span.text === 'string' && segment.content.slice(span.startUtf16, span.endUtf16) !== span.text) add(errors, 'scene_memory_span_text_mismatch', `sourceSpans[${index}].text`)
    if (typeof span.text === 'string' && validHash(span.spanHash) && sha256Text(span.text) !== span.spanHash) add(errors, 'scene_memory_span_hash_mismatch', `sourceSpans[${index}].spanHash`)
  })
  selected.forEach((id) => {
    if (!spans.some((span) => isRecord(span) && span.segmentId === id)) add(errors, 'scene_memory_segment_without_span', id)
  })
  return { spans: spanMap, segments }
}

function validateEvidenceRef(value: unknown, card: Partial<SceneMemoryCard>, spans: Map<string, SceneMemorySourceSpan>, context: SceneMemoryCardValidationContext, errors: string[], path: string): value is SceneMemoryEvidenceRef {
  if (!isRecord(value)) {
    add(errors, 'scene_memory_evidence_invalid', path)
    return false
  }
  if (!['source_span', 'contract', 'ledger'].includes(String(value.kind))) add(errors, 'scene_memory_evidence_kind_invalid', `${path}.kind`)
  if (!validStructuralId(value.id)) add(errors, 'scene_memory_evidence_id_invalid', `${path}.id`)
  if (!validHash(value.hash)) add(errors, 'scene_memory_evidence_hash_invalid', `${path}.hash`)
  if (value.kind === 'source_span') {
    if (typeof value.spanId !== 'string' || value.spanId !== value.id) add(errors, 'scene_memory_evidence_span_id_invalid', `${path}.spanId`)
    const span = spans.get(String(value.spanId ?? value.id))
    if (!span) add(errors, 'scene_memory_evidence_span_missing', path)
    else if (value.hash !== span.spanHash) add(errors, 'scene_memory_evidence_span_hash_mismatch', path)
  } else if (value.kind === 'contract') {
    if (value.id !== card.contractId || value.hash !== card.contractHash) add(errors, 'scene_memory_evidence_contract_mismatch', path)
  } else if (value.kind === 'ledger') {
    const matches = context.ledgerClaims.filter((claim) => claim.id === value.id && claim.hash === value.hash)
    if (matches.length === 0) add(errors, 'scene_memory_evidence_ledger_claim_missing', path)
    else if (matches.length !== 1) add(errors, 'scene_memory_evidence_ledger_claim_ambiguous', path)
  }
  return true
}

function validateEvidenceList(values: unknown, card: Partial<SceneMemoryCard>, spans: Map<string, SceneMemorySourceSpan>, context: SceneMemoryCardValidationContext, errors: string[], path: string, allowUnknown = false): SceneMemoryEvidenceRef[] {
  if (!Array.isArray(values)) {
    if (!(allowUnknown && values === undefined)) add(errors, 'scene_memory_evidence_missing', path)
    return []
  }
  if (values.length === 0) {
    if (!allowUnknown) add(errors, 'scene_memory_evidence_missing', path)
    return []
  }
  const seen = new Set<string>()
  const refs: SceneMemoryEvidenceRef[] = []
  values.forEach((value, index) => {
    if (isRecord(value) && typeof value.kind === 'string' && typeof value.id === 'string' && typeof value.hash === 'string') {
      const key = evidenceKey(value as unknown as SceneMemoryEvidenceRef)
      if (seen.has(key)) add(errors, 'scene_memory_duplicate_evidence_id', `${path}[${index}]`)
      seen.add(key)
    }
    if (validateEvidenceRef(value, card, spans, context, errors, `${path}[${index}]`)) refs.push(value as unknown as SceneMemoryEvidenceRef)
  })
  if (card.status === 'canonical' && !hasSourceEvidence(refs)) add(errors, 'scene_memory_canonical_source_evidence_missing', path)
  return refs
}

function ledgerClaimsForRefs(refs: readonly SceneMemoryEvidenceRef[], context: SceneMemoryCardValidationContext, kind: SceneMemoryLedgerClaim['kind']): SceneMemoryLedgerClaim[] {
  return refs
    .filter((ref) => ref.kind === 'ledger')
    .map((ref) => context.ledgerClaims.find((claim) => claim.id === ref.id && claim.hash === ref.hash))
    .filter((claim): claim is SceneMemoryLedgerClaim => Boolean(claim && claim.kind === kind))
}

function validateLedgerAuthority(claim: SceneMemoryLedgerClaim, card: Partial<SceneMemoryCard>, context: SceneMemoryCardValidationContext, errors: string[], path: string): void {
  if (claim.revision !== card.storyRevision || claim.revision !== context.expectedStoryRevision) add(errors, 'scene_memory_ledger_claim_revision_mismatch', path)
  if (claim.validityEpoch !== card.validityEpoch || claim.validityEpoch !== context.expectedValidityEpoch) add(errors, 'scene_memory_ledger_claim_epoch_mismatch', path)
  if (claim.storyId !== card.storyId || claim.projectId !== card.projectId || claim.branchId !== card.branchId || claim.storyId !== context.expectedScope.storyId || claim.projectId !== context.expectedScope.projectId || claim.branchId !== context.expectedScope.branchId) add(errors, 'scene_memory_ledger_claim_scope_mismatch', path)
  if (claim.stateDeltaHash !== card.stateDeltaHash || claim.stateDeltaHash !== context.expectedBindings.stateDeltaHash) add(errors, 'scene_memory_ledger_claim_state_delta_mismatch', path)
  if (claim.commitManifestHash !== card.commitManifestHash || claim.commitManifestHash !== context.expectedBindings.commitManifestHash) add(errors, 'scene_memory_ledger_claim_manifest_mismatch', path)
}

function validateClaimSupport(claims: readonly string[], refs: readonly SceneMemoryEvidenceRef[], spans: Map<string, SceneMemorySourceSpan>, errors: string[], path: string): void {
  // A claim must be wholly recoverable from one cited span.  Joining several
  // spans would allow an attacker to manufacture a phrase that never occurs
  // in the manuscript (for example first-span "甲" + second-span "乙").
  const sourceTexts = sourceTextsForRefs(refs, spans).map(normalizeClaim)
  for (const claim of claims) {
    if (!isNonEmpty(claim) || isUnknown(claim)) continue
    if (!sourceTexts.some((source) => source.includes(normalizeClaim(claim)))) add(errors, 'scene_memory_evidence_claim_mismatch', path)
  }
}

function validateBoundText(value: unknown, card: Partial<SceneMemoryCard>, spans: Map<string, SceneMemorySourceSpan>, context: SceneMemoryCardValidationContext, errors: string[], path: string): void {
  if (!isRecord(value) || !isNonEmpty(value.text) || value.text.length > MAX_TEXT) {
    add(errors, 'scene_memory_text_invalid', path)
    return
  }
  const refs = validateEvidenceList(value.evidence, card, spans, context, errors, `${path}.evidence`, isUnknown(value.text))
  if (!isUnknown(value.text)) validateClaimSupport([value.text], refs, spans, errors, path)
}

function validateFacts(values: unknown, card: Partial<SceneMemoryCard>, spans: Map<string, SceneMemorySourceSpan>, context: SceneMemoryCardValidationContext, errors: string[]): void {
  if (!Array.isArray(values)) {
    add(errors, 'scene_memory_facts_invalid', 'factsEstablished')
    return
  }
  const ids = new Set<string>()
  values.forEach((value, index) => {
    if (!isRecord(value) || !validStructuralId(value.factId) || !isNonEmpty(value.statement) || value.statement.length > MAX_TEXT) {
      add(errors, 'scene_memory_fact_invalid', `factsEstablished[${index}]`)
      return
    }
    if (ids.has(value.factId)) add(errors, 'scene_memory_duplicate_fact_id', `factsEstablished[${index}].factId`)
    ids.add(value.factId)
    const refs = validateEvidenceList(value.evidence, card, spans, context, errors, `factsEstablished[${index}].evidence`)
    validateClaimSupport([value.statement], refs, spans, errors, `factsEstablished[${index}].statement`)
  })
}

function validateBeliefs(values: unknown, card: Partial<SceneMemoryCard>, spans: Map<string, SceneMemorySourceSpan>, context: SceneMemoryCardValidationContext, errors: string[]): void {
  if (!Array.isArray(values)) {
    add(errors, 'scene_memory_beliefs_invalid', 'beliefChanges')
    return
  }
  values.forEach((value, index) => {
    if (!isRecord(value) || !validTextIdentifier(value.characterId) || (value.from !== null && !isNonEmpty(value.from)) || (value.to !== null && !isNonEmpty(value.to)) || (value.from === null && value.to === null)) {
      add(errors, 'scene_memory_belief_invalid', `beliefChanges[${index}]`)
      return
    }
    const refs = validateEvidenceList(value.evidence, card, spans, context, errors, `beliefChanges[${index}].evidence`)
    validateClaimSupport([value.characterId, value.from ?? '', value.to ?? ''], refs, spans, errors, `beliefChanges[${index}]`)
  })
}

function validateRelationships(values: unknown, card: Partial<SceneMemoryCard>, spans: Map<string, SceneMemorySourceSpan>, context: SceneMemoryCardValidationContext, errors: string[]): void {
  if (!Array.isArray(values)) {
    add(errors, 'scene_memory_relationships_invalid', 'relationshipChanges')
    return
  }
  values.forEach((value, index) => {
    if (!isRecord(value) || !validTextIdentifier(value.fromCharacterId) || !validTextIdentifier(value.toCharacterId) || !isNonEmpty(value.dimension) || (value.from !== null && !isNonEmpty(value.from)) || (value.to !== null && !isNonEmpty(value.to)) || (value.from === null && value.to === null)) {
      add(errors, 'scene_memory_relationship_invalid', `relationshipChanges[${index}]`)
      return
    }
    const refs = validateEvidenceList(value.evidence, card, spans, context, errors, `relationshipChanges[${index}].evidence`)
    // A relationship is a semantic claim, not merely a pair of IDs.  Its
    // dimension and values must be recoverable from one cited span, while the
    // ledger remains the authority for the internal endpoint identity.
    validateClaimSupport([value.dimension, value.from ?? '', value.to ?? ''], refs, spans, errors, `relationshipChanges[${index}]`)
    const claims = ledgerClaimsForRefs(refs, context, 'relationship')
    if (refs.filter((ref) => ref.kind === 'ledger').length !== 1 || claims.length !== 1) add(errors, 'scene_memory_relationship_ledger_evidence_missing', `relationshipChanges[${index}].evidence`)
    else {
      const claim = claims[0]!
      if (claim.kind !== 'relationship') add(errors, 'scene_memory_relationship_ledger_evidence_missing', `relationshipChanges[${index}].evidence`)
      else {
        validateLedgerAuthority(claim, card, context, errors, `relationshipChanges[${index}].evidence`)
        if (claim.fromCharacterId !== value.fromCharacterId || claim.toCharacterId !== value.toCharacterId || claim.dimension !== value.dimension) add(errors, 'scene_memory_relationship_ledger_claim_mismatch', `relationshipChanges[${index}]`)
      }
    }
  })
}

function validateThreads(values: unknown, card: Partial<SceneMemoryCard>, spans: Map<string, SceneMemorySourceSpan>, context: SceneMemoryCardValidationContext, errors: string[]): void {
  if (!Array.isArray(values)) {
    add(errors, 'scene_memory_threads_invalid', 'threads')
    return
  }
  const ids = new Set<string>()
  values.forEach((value, index) => {
    if (!isRecord(value) || !validStructuralId(value.threadId) || !['open', 'advanced', 'delayed', 'resolved', 'abandoned'].includes(String(value.lifecycle)) || (value.summary !== null && value.summary !== undefined && !isNonEmpty(value.summary))) {
      add(errors, 'scene_memory_thread_invalid', `threads[${index}]`)
      return
    }
    if (ids.has(value.threadId)) add(errors, 'scene_memory_duplicate_thread_id', `threads[${index}].threadId`)
    ids.add(value.threadId)
    const refs = validateEvidenceList(value.evidence, card, spans, context, errors, `threads[${index}].evidence`)
    // threadId/lifecycle are ledger metadata and therefore require a verified
    // ledger reference.  A supplied summary remains an ordinary prose claim.
    const claims = ledgerClaimsForRefs(refs, context, 'foreshadow')
    if (refs.filter((ref) => ref.kind === 'ledger').length !== 1 || claims.length !== 1) add(errors, 'scene_memory_thread_ledger_evidence_missing', `threads[${index}].evidence`)
    else {
      const claim = claims[0]!
      if (claim.kind !== 'foreshadow') add(errors, 'scene_memory_thread_ledger_evidence_missing', `threads[${index}].evidence`)
      else {
        validateLedgerAuthority(claim, card, context, errors, `threads[${index}].evidence`)
        if (claim.threadId !== value.threadId || claim.lifecycle !== value.lifecycle) add(errors, 'scene_memory_thread_ledger_evidence_claim_mismatch', `threads[${index}]`)
      }
    }
    validateClaimSupport([value.summary ?? ''], refs, spans, errors, `threads[${index}]`)
  })
}

function fieldRefs(fieldEvidence: Record<string, SceneMemoryEvidenceRef[]> | undefined, field: string, value?: string, index?: number): SceneMemoryEvidenceRef[] | undefined {
  if (!fieldEvidence) return undefined
  const candidates = [
    value === undefined ? '' : `${field}:${value}`,
    index === undefined ? '' : `${field}[${index}]`,
    field
  ].filter(Boolean)
  for (const key of candidates) if (fieldEvidence[key] !== undefined) return fieldEvidence[key]
  return undefined
}

function validateScalarEvidence(card: Partial<SceneMemoryCard>, spans: Map<string, SceneMemorySourceSpan>, context: SceneMemoryCardValidationContext, errors: string[]): void {
  const evidence = card.fieldEvidence
  if (!isRecord(evidence)) {
    add(errors, 'scene_memory_field_evidence_invalid', 'fieldEvidence')
    return
  }
  for (const [key, refs] of Object.entries(evidence)) validateEvidenceList(refs, card, spans, context, errors, `fieldEvidence.${key}`)
  const requireValue = (field: string, value: string | null | undefined, index?: number): void => {
    if (!isNonEmpty(value) || isUnknown(value)) return
    const refs = fieldRefs(evidence, field, value, index)
    const checked = validateEvidenceList(refs, card, spans, context, errors, `fieldEvidence.${field}${index === undefined ? '' : `[${index}]`}`)
    validateClaimSupport([value], checked, spans, errors, `fieldEvidence.${field}`)
  }
  requireValue('povCharacterId', card.povCharacterId)
  const participants = card.participants ?? []
  participants.forEach((participant, index) => {
    const refs = participant.evidence.length > 0 ? participant.evidence : fieldRefs(evidence, 'participants', participant.id, index)
    const checked = validateEvidenceList(refs, card, spans, context, errors, `participants[${index}].evidence`)
    validateClaimSupport([participant.id, participant.role], checked, spans, errors, `participants[${index}]`)
  })
  ;(card.locations ?? []).forEach((value, index) => {
    const refs = fieldRefs(evidence, 'locations', value, index)
    const checked = validateEvidenceList(refs, card, spans, context, errors, `fieldEvidence.locations[${index}]`)
    validateClaimSupport([value], checked, spans, errors, `fieldEvidence.locations[${index}]`)
  })
  ;(card.objects ?? []).forEach((value, index) => {
    const refs = fieldRefs(evidence, 'objects', value, index)
    const checked = validateEvidenceList(refs, card, spans, context, errors, `fieldEvidence.objects[${index}]`)
    validateClaimSupport([value], checked, spans, errors, `fieldEvidence.objects[${index}]`)
  })
  requireValue('dramaticQuestion', card.dramaticQuestion)
  requireValue('valueShift.from', card.valueShift?.from)
  requireValue('valueShift.to', card.valueShift?.to)
  requireValue('decisiveAction', card.decisiveAction)
  requireValue('turn', card.turn)
  requireValue('cost', card.cost)
}

function validateEmbedding(value: unknown, errors: string[]): void {
  if (!isRecord(value) || !['ready', 'unavailable', 'stale'].includes(String(value.status))) {
    add(errors, 'scene_memory_embedding_invalid', 'embedding')
    return
  }
  const status = String(value.status)
  if (value.version !== null && typeof value.version !== 'string') add(errors, 'scene_memory_embedding_version_invalid', 'embedding.version')
  if (value.modelId !== null && typeof value.modelId !== 'string') add(errors, 'scene_memory_embedding_model_invalid', 'embedding.modelId')
  if (value.dimensions !== null && (!Number.isInteger(value.dimensions) || Number(value.dimensions) <= 0)) add(errors, 'scene_memory_embedding_dimensions_invalid', 'embedding.dimensions')
  if (value.vectorHash !== null && !validHash(value.vectorHash)) add(errors, 'scene_memory_embedding_hash_invalid', 'embedding.vectorHash')
  if (status === 'ready' && (typeof value.version !== 'string' || typeof value.modelId !== 'string' || !Number.isInteger(value.dimensions) || !validHash(value.vectorHash))) add(errors, 'scene_memory_embedding_ready_incomplete', 'embedding')
  if (status === 'unavailable' && (value.version !== null || value.modelId !== null || value.dimensions !== null || value.vectorHash !== null)) add(errors, 'scene_memory_embedding_unavailable_has_data', 'embedding')
}

function validateSemanticFields(value: Partial<SceneMemoryCard>, spans: Map<string, SceneMemorySourceSpan>, context: SceneMemoryCardValidationContext, errors: string[]): void {
  if (!Array.isArray(value.motifs)) add(errors, 'scene_memory_motifs_invalid', 'motifs')
  else value.motifs.forEach((item, index) => validateBoundText(item, value, spans, context, errors, `motifs[${index}]`))
  if (!Array.isArray(value.distinctivePhrases)) add(errors, 'scene_memory_phrases_invalid', 'distinctivePhrases')
  else value.distinctivePhrases.forEach((item, index) => validateBoundText(item, value, spans, context, errors, `distinctivePhrases[${index}]`))
  validateFacts(value.factsEstablished, value, spans, context, errors)
  validateBeliefs(value.beliefChanges, value, spans, context, errors)
  validateRelationships(value.relationshipChanges, value, spans, context, errors)
  validateThreads(value.threads, value, spans, context, errors)
  validateScalarEvidence(value, spans, context, errors)
}

function hasNonEmptyClaim(card: Partial<SceneMemoryCard>): boolean {
  const scalar = [card.povCharacterId, card.dramaticQuestion, card.decisiveAction, card.turn, card.cost, card.valueShift?.from, card.valueShift?.to]
  if (scalar.some((value) => isNonEmpty(value) && !isUnknown(value))) return true
  if ((card.locations ?? []).some((value) => isNonEmpty(value) && !isUnknown(value))) return true
  if ((card.objects ?? []).some((value) => isNonEmpty(value) && !isUnknown(value))) return true
  if ((card.participants ?? []).length > 0 || (card.factsEstablished ?? []).length > 0 || (card.beliefChanges ?? []).length > 0 || (card.relationshipChanges ?? []).length > 0 || (card.threads ?? []).length > 0) return true
  return [...(card.motifs ?? []), ...(card.distinctivePhrases ?? [])].some((value) => isNonEmpty(value.text) && !isUnknown(value.text))
}

/** Validate a card against a required, authoritative scope/epoch/revision. */
export function validateSceneMemoryCard(card: unknown, context: SceneMemoryCardValidationContext): SceneMemoryCardValidationResult {
  const errors: string[] = []
  if (!validateContextShape(context, errors)) return { ok: false, errors: [...new Set(errors)] }
  validateLedgerClaimsAgainstContext(context, errors)
  if (!isRecord(card)) return { ok: false, errors: ['scene_memory_card_invalid:card'] }
  const value = card as Partial<SceneMemoryCard>
  if (value.schemaVersion !== 1) add(errors, 'scene_memory_schema_invalid', 'schemaVersion')
  if (!['canonical', 'partial', 'pending_review', 'legacy_unverified'].includes(String(value.status))) add(errors, 'scene_memory_status_invalid', 'status')
  for (const field of ['cardId', 'storyId', 'projectId', 'branchId', 'runId', 'sceneId', 'contractId'] as const) if (!validStructuralId(value[field])) add(errors, 'scene_memory_id_invalid', field)
  if (!validHash(value.contractHash)) add(errors, 'scene_memory_contract_hash_invalid', 'contractHash')
  if (!validHash(value.sceneContentHash)) add(errors, 'scene_memory_scene_content_hash_invalid', 'sceneContentHash')
  if (!validHash(value.commitManifestHash)) add(errors, 'scene_memory_commit_manifest_hash_invalid', 'commitManifestHash')
  if (!validHash(value.stateDeltaHash)) add(errors, 'scene_memory_state_delta_hash_invalid', 'stateDeltaHash')
  if (!Number.isInteger(value.validityEpoch) || Number(value.validityEpoch) < 1) add(errors, 'scene_memory_epoch_invalid', 'validityEpoch')
  if (!Number.isInteger(value.storyRevision) || Number(value.storyRevision) < 1) add(errors, 'scene_memory_revision_invalid', 'storyRevision')
  if (!Number.isInteger(value.sceneOrder) || Number(value.sceneOrder) < 1) add(errors, 'scene_memory_scene_order_invalid', 'sceneOrder')
  if (value.povCharacterId !== null && value.povCharacterId !== undefined && !validTextIdentifier(value.povCharacterId)) add(errors, 'scene_memory_pov_invalid', 'povCharacterId')
  if (!Array.isArray(value.participants)) add(errors, 'scene_memory_participants_invalid', 'participants')
  else {
    const ids = new Set<string>()
    value.participants.forEach((participant, index) => {
      if (!isRecord(participant) || !validTextIdentifier(participant.id) || !isNonEmpty(participant.role) || participant.role.length > MAX_TEXT || !Array.isArray(participant.evidence)) add(errors, 'scene_memory_participant_invalid', `participants[${index}]`)
      if (isRecord(participant) && typeof participant.id === 'string') {
        if (ids.has(participant.id)) add(errors, 'scene_memory_duplicate_participant_id', `participants[${index}].id`)
        ids.add(participant.id)
      }
    })
  }
  for (const field of ['locations', 'objects'] as const) if (!Array.isArray(value[field]) || value[field]?.some((item) => !isNonEmpty(item) || item.length > MAX_TEXT)) add(errors, 'scene_memory_list_invalid', field)
  for (const field of ['dramaticQuestion', 'decisiveAction', 'turn', 'cost'] as const) if (value[field] !== null && value[field] !== undefined && (!isNonEmpty(value[field]) || value[field].length > MAX_TEXT)) add(errors, 'scene_memory_text_invalid', field)
  if (value.valueShift !== null && value.valueShift !== undefined && (!isRecord(value.valueShift) || !isNonEmpty(value.valueShift.from) || !isNonEmpty(value.valueShift.to))) add(errors, 'scene_memory_value_shift_invalid', 'valueShift')

  const source = validateSourceSpans(value, context, errors)
  if (validStructuralId(value.sceneId)) {
    for (const segment of source.segments.values()) if (segment.sceneId !== value.sceneId && value.sourceSegmentIds?.includes(segment.segmentId)) add(errors, 'scene_memory_source_scene_mismatch', segment.segmentId)
  }
  if (Array.isArray(value.sourceSegmentIds) && validHash(value.sceneContentHash) && selectedSegmentContentHash(value.sourceSegmentIds, source.segments) !== value.sceneContentHash) add(errors, 'scene_memory_scene_content_binding_mismatch', 'sceneContentHash')
  if (Array.isArray(value.sourceSegmentIds)) {
    for (const id of value.sourceSegmentIds) {
      const segment = source.segments.get(id)
      if (segment && validHash(value.commitManifestHash) && segment.commitManifestHash !== value.commitManifestHash) add(errors, 'scene_memory_commit_manifest_binding_mismatch', id)
    }
  }
  if (value.status === 'legacy_unverified') {
    if (hasNonEmptyClaim(value)) add(errors, 'scene_memory_legacy_claim_not_allowed', 'status')
  } else {
    if (value.sceneContentHash !== context.expectedBindings.sceneContentHash || value.commitManifestHash !== context.expectedBindings.commitManifestHash || value.stateDeltaHash !== context.expectedBindings.stateDeltaHash) add(errors, 'scene_memory_binding_mismatch', 'expectedBindings')
    validateSemanticFields(value, source.spans, context, errors)
  }
  if (value.storyId !== context.expectedScope.storyId || value.projectId !== context.expectedScope.projectId || value.branchId !== context.expectedScope.branchId) add(errors, 'scene_memory_scope_mismatch', 'scope')
  if (value.validityEpoch !== context.expectedValidityEpoch) add(errors, 'scene_memory_epoch_mismatch', 'validityEpoch')
  if (value.storyRevision !== context.expectedStoryRevision) add(errors, 'scene_memory_revision_mismatch', 'storyRevision')
  if (value.contractId !== context.expectedContract.contractId || value.contractHash !== context.expectedContract.contractHash) add(errors, 'scene_memory_contract_mismatch', 'contract')
  validateEmbedding(value.embedding, errors)
  if (!Number.isFinite(value.createdAt) || !Number.isInteger(value.createdAt) || Number(value.createdAt) < 0) add(errors, 'scene_memory_created_at_invalid', 'createdAt')
  if (!validHash(value.cardHash)) add(errors, 'scene_memory_card_hash_invalid', 'cardHash')
  else if (sceneMemoryCardHash(value) !== value.cardHash) add(errors, 'scene_memory_card_hash_mismatch', 'cardHash')
  return { ok: errors.length === 0, errors: [...new Set(errors)] }
}

export function sceneMemoryCardValid(card: unknown, context: SceneMemoryCardValidationContext): card is SceneMemoryCard {
  return validateSceneMemoryCard(card, context).ok
}

export function assertSceneMemoryCard(card: unknown, context: SceneMemoryCardValidationContext): asserts card is SceneMemoryCard {
  const result = validateSceneMemoryCard(card, context)
  if (!result.ok) throw new SceneMemoryCardValidationError(result.errors)
}

function normalizeEvidence(values: readonly SceneMemoryEvidenceRef[]): SceneMemoryEvidenceRef[] {
  return canonicalEvidence(values)
}

type NormalizedBuild = {
  card: Omit<SceneMemoryCard, 'cardHash' | 'createdAt'>
  context: SceneMemoryCardValidationContext
  createdAt: number
}

function normalizeCardInput(input: SceneMemoryCardBuildInput): NormalizedBuild {
  const normalizeBoundText = (item: EvidenceBoundText): EvidenceBoundText => ({ text: item.text.trim(), evidence: normalizeEvidence(item.evidence) })
  const normalizeFacts = (items: readonly EvidenceBoundFact[]): EvidenceBoundFact[] => items.map((item) => ({ factId: item.factId.trim(), statement: item.statement.trim(), evidence: normalizeEvidence(item.evidence) }))
  const normalizeBeliefs = (items: readonly EvidenceBoundBeliefChange[]): EvidenceBoundBeliefChange[] => items.map((item) => ({ characterId: item.characterId.trim(), from: item.from === null ? null : item.from.trim(), to: item.to === null ? null : item.to.trim(), evidence: normalizeEvidence(item.evidence) }))
  const normalizeRelationships = (items: readonly EvidenceBoundRelationshipChange[]): EvidenceBoundRelationshipChange[] => items.map((item) => ({ fromCharacterId: item.fromCharacterId.trim(), toCharacterId: item.toCharacterId.trim(), dimension: item.dimension.trim(), from: item.from === null ? null : item.from.trim(), to: item.to === null ? null : item.to.trim(), evidence: normalizeEvidence(item.evidence) }))
  const normalizeThreads = (items: readonly EvidenceBoundThreadChange[]): EvidenceBoundThreadChange[] => items.map((item) => ({ threadId: item.threadId.trim(), lifecycle: item.lifecycle, summary: item.summary === null ? null : item.summary.trim(), evidence: normalizeEvidence(item.evidence) }))
  const fieldEvidence = Object.fromEntries(Object.entries(input.fieldEvidence).map(([key, refs]) => [key, normalizeEvidence(refs)]))
  const sourceSegmentIds = sortedText(input.sourceSegmentIds ?? input.sourceSegments.map((segment) => segment.segmentId))
  const embedding: SceneMemoryEmbedding = input.embedding ?? { status: 'unavailable', version: null, modelId: null, dimensions: null, vectorHash: null }
  const card: Omit<SceneMemoryCard, 'cardHash' | 'createdAt'> = {
    schemaVersion: 1,
    status: input.status,
    cardId: input.cardId.trim(),
    storyId: input.storyId.trim(),
    projectId: input.projectId.trim(),
    branchId: input.branchId.trim(),
    validityEpoch: input.validityEpoch,
    storyRevision: input.storyRevision,
    runId: input.runId.trim(),
    sceneId: input.sceneId.trim(),
    sceneOrder: input.sceneOrder,
    contractId: input.contractId.trim(),
    contractHash: input.contractHash,
    sceneContentHash: input.sceneContentHash,
    commitManifestHash: input.commitManifestHash,
    stateDeltaHash: input.stateDeltaHash,
    povCharacterId: input.povCharacterId === null || input.povCharacterId === undefined ? null : input.povCharacterId.trim(),
    participants: canonicalParticipants(input.participants),
    locations: sortedText(input.locations),
    objects: sortedText(input.objects),
    dramaticQuestion: input.dramaticQuestion === null || input.dramaticQuestion === undefined ? null : input.dramaticQuestion.trim(),
    valueShift: input.valueShift === null || input.valueShift === undefined ? null : { from: input.valueShift.from.trim(), to: input.valueShift.to.trim() },
    decisiveAction: input.decisiveAction === null || input.decisiveAction === undefined ? null : input.decisiveAction.trim(),
    turn: input.turn === null || input.turn === undefined ? null : input.turn.trim(),
    cost: input.cost === null || input.cost === undefined ? null : input.cost.trim(),
    factsEstablished: normalizeFacts(input.factsEstablished),
    beliefChanges: normalizeBeliefs(input.beliefChanges),
    relationshipChanges: normalizeRelationships(input.relationshipChanges),
    threads: normalizeThreads(input.threads),
    motifs: input.motifs.map(normalizeBoundText),
    distinctivePhrases: input.distinctivePhrases.map(normalizeBoundText),
    sourceSegmentIds,
    sourceSpans: input.sourceSpans.map((span) => ({ ...span })),
    embedding,
    fieldEvidence
  }
  const context: SceneMemoryCardValidationContext = {
    sourceSegments: input.sourceSegments,
    expectedScope: input.expectedScope,
    expectedValidityEpoch: input.expectedValidityEpoch,
    expectedStoryRevision: input.expectedStoryRevision,
    expectedContract: input.expectedContract,
    expectedBindings: input.expectedBindings,
    ledgerClaims: input.ledgerClaims
  }
  return { card, context, createdAt: input.createdAt ?? Date.now() }
}

export function buildSceneMemoryCard(input: SceneMemoryCardBuildInput): SceneMemoryCard {
  const normalized = normalizeCardInput(input)
  const cardWithoutHash: Omit<SceneMemoryCard, 'cardHash'> = { ...normalized.card, createdAt: normalized.createdAt }
  const card: SceneMemoryCard = { ...cardWithoutHash, cardHash: sceneMemoryCardHash(cardWithoutHash) }
  const result = validateSceneMemoryCard(card, normalized.context)
  if (!result.ok) throw new SceneMemoryCardValidationError(result.errors)
  return card
}

export const makeSceneMemoryCard = buildSceneMemoryCard

function cardContext(base: SceneMemoryCardValidationContext, card: SceneMemoryCard): SceneMemoryCardValidationContext {
  return {
    ...base,
    expectedValidityEpoch: card.validityEpoch,
    expectedStoryRevision: card.storyRevision,
    expectedContract: { contractId: card.contractId, contractHash: card.contractHash },
    expectedBindings: { sceneContentHash: card.sceneContentHash, commitManifestHash: card.commitManifestHash, stateDeltaHash: card.stateDeltaHash },
    ledgerClaims: base.ledgerClaims.filter((claim) => claim.revision === card.storyRevision && claim.validityEpoch === card.validityEpoch && claim.storyId === card.storyId && claim.projectId === card.projectId && claim.branchId === card.branchId && claim.stateDeltaHash === card.stateDeltaHash && claim.commitManifestHash === card.commitManifestHash)
  }
}

/** Append-only cards cannot replace a revision or move an epoch backwards. */
export function appendSceneMemoryCard(existing: readonly SceneMemoryCard[], next: SceneMemoryCard, context: SceneMemoryCardValidationContext): SceneMemoryCard[] {
  const errors: string[] = []
  const seenIds = new Set<string>()
  const revisions = new Map<string, number>()
  const scopeKey = (card: SceneMemoryCard): string => `${card.storyId}\u0000${card.projectId}\u0000${card.branchId}`
  existing.forEach((card, index) => {
    const result = validateSceneMemoryCard(card, cardContext(context, card))
    if (!result.ok) errors.push(...result.errors.map((error) => `existing[${index}].${error}`))
    if (seenIds.has(card.cardId)) add(errors, 'scene_memory_duplicate_card_id', `existing[${index}].cardId`)
    seenIds.add(card.cardId)
    const key = scopeKey(card)
    const prior = revisions.get(key)
    if (prior !== undefined && card.storyRevision <= prior) add(errors, 'scene_memory_revision_not_append_only', `existing[${index}].storyRevision`)
    revisions.set(key, Math.max(prior ?? 0, card.storyRevision))
  })
  // A history append is a collection-level operation: its revision fence is
  // the append-only comparison below, rather than a single-card equality
  // fence.  Keep all other authority (scope, epoch, contract, and bindings)
  // mandatory; tolerate an old JS caller that omitted only this collection
  // fence by deriving it from the candidate that is immediately validated.
  const nextContext: SceneMemoryCardValidationContext = {
    ...context,
    expectedStoryRevision: Number.isInteger(context.expectedStoryRevision) ? context.expectedStoryRevision : next.storyRevision,
    ledgerClaims: context.ledgerClaims.filter((claim) => claim.revision === next.storyRevision && claim.validityEpoch === next.validityEpoch && claim.storyId === next.storyId && claim.projectId === next.projectId && claim.branchId === next.branchId && claim.stateDeltaHash === next.stateDeltaHash && claim.commitManifestHash === next.commitManifestHash)
  }
  const nextResult = validateSceneMemoryCard(next, nextContext)
  if (!nextResult.ok) errors.push(...nextResult.errors.map((error) => `next.${error}`))
  if (seenIds.has(next.cardId)) add(errors, 'scene_memory_duplicate_card_id', 'next.cardId')
  const key = scopeKey(next)
  const priorRevision = revisions.get(key)
  if (priorRevision !== undefined && next.storyRevision <= priorRevision) add(errors, 'scene_memory_revision_not_append_only', 'next.storyRevision')
  const priorEpoch = existing.filter((card) => scopeKey(card) === key).reduce((max, card) => Math.max(max, card.validityEpoch), 0)
  if (priorEpoch > 0 && next.validityEpoch < priorEpoch) add(errors, 'scene_memory_epoch_not_append_only', 'next.validityEpoch')
  if (errors.length > 0) throw new SceneMemoryCardValidationError(errors)
  return [...existing, next]
}

export const appendMemoryCard = appendSceneMemoryCard

function dense(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function cardToDenseText(card: SceneMemoryCard, options: { maxChars?: number } | number = {}): string {
  const maxChars = typeof options === 'number' ? options : options.maxChars ?? 12_000
  const value = canonicalCard(card) as SceneMemoryCard
  const lines: string[] = [`场景 ${value.sceneId} · 状态 ${value.status} · 修订 ${value.storyRevision} · 纪元 ${value.validityEpoch}`]
  if (value.povCharacterId) lines.push(`视角：${dense(value.povCharacterId)}`)
  if (value.participants.length > 0) lines.push(`人物：${value.participants.map((item) => `${dense(item.id)}（${dense(item.role)}）`).join('、')}`)
  if (value.locations.length > 0) lines.push(`地点：${value.locations.map(dense).join('、')}`)
  if (value.objects.length > 0) lines.push(`对象：${value.objects.map(dense).join('、')}`)
  if (value.dramaticQuestion) lines.push(`戏剧问题：${dense(value.dramaticQuestion)}`)
  if (value.valueShift) lines.push(`价值变化：${dense(value.valueShift.from)} → ${dense(value.valueShift.to)}`)
  if (value.decisiveAction) lines.push(`决定性行动：${dense(value.decisiveAction)}`)
  if (value.turn) lines.push(`转折：${dense(value.turn)}`)
  if (value.cost) lines.push(`代价：${dense(value.cost)}`)
  if (value.factsEstablished.length > 0) lines.push(`已确立事实：${value.factsEstablished.map((item) => dense(item.statement)).join('；')}`)
  if (value.beliefChanges.length > 0) lines.push(`信念变化：${value.beliefChanges.map((item) => `${dense(item.characterId)}：${dense(item.from ?? 'unknown')}→${dense(item.to ?? 'unknown')}`).join('；')}`)
  if (value.relationshipChanges.length > 0) lines.push(`关系变化：${value.relationshipChanges.map((item) => `${dense(item.fromCharacterId)}→${dense(item.toCharacterId)} ${dense(item.dimension)} ${dense(item.from ?? 'unknown')}→${dense(item.to ?? 'unknown')}`).join('；')}`)
  if (value.threads.length > 0) lines.push(`线程：${value.threads.map((item) => `${dense(item.threadId)}（${item.lifecycle}）${item.summary ? ` ${dense(item.summary)}` : ''}`).join('；')}`)
  if (value.motifs.length > 0) lines.push(`母题：${value.motifs.map((item) => dense(item.text)).join('、')}`)
  if (value.distinctivePhrases.length > 0) lines.push(`特色措辞：${value.distinctivePhrases.map((item) => dense(item.text)).join('、')}`)
  const result = lines.join('\n')
  return result.length > maxChars ? result.slice(0, Math.max(0, maxChars)) : result
}
