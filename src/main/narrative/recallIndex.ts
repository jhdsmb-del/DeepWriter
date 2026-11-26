import {
  sceneMemoryCardHash,
  sha256Text,
  stableSceneMemoryJson
} from './sceneMemoryCard'
import type {
  SceneMemoryCard,
  SceneMemorySourceSegment,
  SceneRecallAuthorityTag,
  SceneRecallCandidate,
  SceneRecallCorpusItem,
  SceneRecallCausalEdge,
  SceneRecallHardDependency,
  SceneRecallIndexInput,
  SceneRecallIndexResult,
  SceneRecallKnowledgeBoundary,
  SceneRecallOmission,
  SceneRecallQuery,
  SceneRecallRequiredFact,
  SceneRecallReasonCode,
  SceneRecallSortTuple
} from '../../shared/types'

/** Pure WP3 selector. Its corpus must be a trusted, committed Repository projection; it never reads or writes DB state. */
export const SCENE_RECALL_TOKENIZER_VERSION = 'unicode-char-nfkc-lower-v2'
export const SCENE_RECALL_BM25_VERSION = 'bm25-k1.2-b0.75-v1'
export const SCENE_RECALL_TUPLE_VERSION = 'tuple-v1'
export const SCENE_RECALL_INDEX_ALGORITHM_VERSION = 'recall-index-v3'

const HASH_RE = /^[0-9a-f]{64}$/u
const MAX_TOP_K = 200

export class SceneRecallIndexError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'SceneRecallIndexError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new SceneRecallIndexError(code)
}

function hash(value: unknown): string {
  return sha256Text(stableSceneMemoryJson(value))
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function finiteInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= minimum
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  if (!values) return []
  if (!Array.isArray(values)) fail('scene_recall_scope_invalid')
  if (values.some((value) => !nonEmpty(value))) fail('scene_recall_scope_invalid')
  return [...new Set(values)].sort(compareText)
}

function normalizedTerms(values: readonly string[] | undefined): string[] {
  if (!values) return []
  if (!Array.isArray(values)) fail('scene_recall_scope_invalid')
  return [...new Set(values.map((value) => {
    if (!nonEmpty(value)) fail('scene_recall_scope_invalid')
    return normalizeSearchText(value)
  }))].sort(compareText)
}

function normalizedRequiredFacts(values: readonly SceneRecallRequiredFact[] | undefined): SceneRecallRequiredFact[] {
  if (!values) return []
  if (!Array.isArray(values)) fail('scene_recall_scope_invalid')
  const seen = new Set<string>()
  return [...values].map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !nonEmpty(value.requiredId) || !nonEmpty(value.factId) || !finiteInteger(value.version, 1) || !nonEmpty(value.canonicalStatement) || !validHash(value.canonicalHash) || value.canonicalHash !== sha256Text(value.canonicalStatement) || !validHash(value.provenanceHash) || !Array.isArray(value.sourceSlotIds) || value.sourceSlotIds.some((id: unknown) => !nonEmpty(id)) || new Set(value.sourceSlotIds).size !== value.sourceSlotIds.length) fail('scene_recall_required_fact_invalid')
    const key = `${value.requiredId}\u0000${value.factId}\u0000${value.version}`
    if (seen.has(key)) fail('scene_recall_required_fact_duplicate')
    seen.add(key)
    return {
      requiredId: value.requiredId,
      factId: value.factId,
      version: value.version,
      canonicalStatement: value.canonicalStatement,
      canonicalHash: value.canonicalHash,
      provenanceHash: value.provenanceHash,
      sourceSlotIds: [...value.sourceSlotIds].sort(compareText)
    }
  }).sort((left, right) => compareText(`${left.requiredId}\u0000${left.factId}\u0000${left.version}`, `${right.requiredId}\u0000${right.factId}\u0000${right.version}`))
}

function lineageIsValid(lineage: unknown, branchId: unknown): lineage is readonly string[] {
  return Array.isArray(lineage) && nonEmpty(branchId) && lineage.length > 0 && new Set(lineage).size === lineage.length && lineage.every(nonEmpty) && lineage[lineage.length - 1] === branchId
}

function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((branch, index) => branch === value[index])
}

function surrogateBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false
  const previous = text.charCodeAt(offset - 1)
  const next = text.charCodeAt(offset)
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
}

function canonicalWithoutHash(value: Record<string, unknown>): Record<string, unknown> {
  const { authorityHash: _authorityHash, ...withoutHash } = value
  return withoutHash
}

export function sceneRecallAuthorityHash(value: Record<string, unknown>): string {
  return hash(canonicalWithoutHash(value))
}

export function sceneRecallSourceSnapshotHash(card: SceneMemoryCard, segments: readonly SceneMemorySourceSegment[]): string {
  const sourceSegments = [...segments]
    .map((segment) => ({ segmentId: segment.segmentId, contentHash: segment.contentHash, segmentRevision: segment.segmentRevision, status: segment.status, sceneId: segment.sceneId, commitId: segment.commitId, commitManifestHash: segment.commitManifestHash, chunkIndex: segment.chunkIndex }))
    .sort((left, right) => compareText(left.segmentId, right.segmentId))
  const sourceSpans = card.sourceSpans
    .map((span) => ({ spanId: span.spanId, segmentId: span.segmentId, segmentHash: span.segmentHash, segmentRevision: span.segmentRevision, manifestHash: span.manifestHash, startUtf16: span.startUtf16, endUtf16: span.endUtf16, text: span.text, spanHash: span.spanHash }))
    .sort((left, right) => compareText(left.spanId, right.spanId))
  return hash({ cardHash: card.cardHash, sourceSegments, sourceSpans })
}

function isSurrogateBoundary(text: string, offset: number): boolean {
  return surrogateBoundary(text, offset)
}

function sourceSnapshotValid(item: SceneRecallCorpusItem): boolean {
  try {
    if (!item || !item.card || !item.authority || typeof item.authority !== 'object') return false
    const card = item.card
    if (item.sourceValidated !== true || !Array.isArray(item.sourceSegments) || item.sourceSegments.length === 0) return false
    if (card.status !== 'canonical' || !validHash(card.cardHash) || sceneMemoryCardHash(card) !== card.cardHash) return false
    const segments = item.sourceSegments
    const byId = new Map<string, SceneMemorySourceSegment>()
    for (const segment of segments) {
      if (!nonEmpty(segment.segmentId) || byId.has(segment.segmentId) || segment.status !== 'accepted' || !validHash(segment.contentHash) || sha256Text(segment.content) !== segment.contentHash || !finiteInteger(segment.segmentRevision, 1) || !validHash(segment.commitManifestHash) || !nonEmpty(segment.commitId) || !finiteInteger(segment.chunkIndex, 0) || segment.sceneId !== card.sceneId) return false
      byId.set(segment.segmentId, segment)
    }
    if (!Array.isArray(card.sourceSegmentIds) || card.sourceSegmentIds.length === 0 || new Set(card.sourceSegmentIds).size !== card.sourceSegmentIds.length || card.sourceSegmentIds.some((id) => !byId.has(id))) return false
    if (!Array.isArray(card.sourceSpans)) return false
    const spanIds = new Set<string>()
    for (const span of card.sourceSpans) {
      const segment = byId.get(span.segmentId)
      if (!segment || spanIds.has(span.spanId) || span.segmentHash !== segment.contentHash || span.segmentRevision !== segment.segmentRevision || span.manifestHash !== segment.commitManifestHash || !finiteInteger(span.startUtf16) || !finiteInteger(span.endUtf16, 1) || span.endUtf16 > segment.content.length || isSurrogateBoundary(segment.content, span.startUtf16) || isSurrogateBoundary(segment.content, span.endUtf16) || segment.content.slice(span.startUtf16, span.endUtf16) !== span.text || !validHash(span.spanHash) || sha256Text(span.text) !== span.spanHash) return false
      spanIds.add(span.spanId)
    }
    if (spanIds.size === 0 || card.sourceSpans.some((span) => !card.sourceSegmentIds.includes(span.segmentId))) return false
    return nonEmpty(item.authority.sourceSnapshotHash) && validHash(item.authority.sourceSnapshotHash) && item.authority.sourceSnapshotHash === sceneRecallSourceSnapshotHash(card, segments)
  } catch {
    return false
  }
}

function authorityMatchesQuery(item: SceneRecallCorpusItem, query: SceneRecallQuery): boolean {
  if (!item || !item.card || !item.authority || typeof item.authority !== 'object') return false
  const authority = item.authority
  const scope = query.scope
  if (!nonEmpty(authority.storyId) || !nonEmpty(authority.projectId) || !nonEmpty(authority.branchId) || !finiteInteger(authority.validityEpoch, 1) || !finiteInteger(authority.storyRevision, 1) || !finiteInteger(authority.headRevision, 1) || !validHash(authority.headHash) || !validHash(authority.sourceSnapshotHash) || !validHash(authority.cardHash) || !lineageIsValid(authority.branchLineage, authority.branchId) || !validHash(authority.authorityHash) || sceneRecallAuthorityHash(authority as unknown as Record<string, unknown>) !== authority.authorityHash) return false
  if (authority.storyId !== scope.storyId || authority.projectId !== scope.projectId || authority.validityEpoch !== scope.validityEpoch || authority.headRevision !== scope.headRevision || authority.headHash !== scope.headHash || authority.cardHash !== item.card.cardHash || authority.storyRevision !== item.card.storyRevision || authority.branchId !== item.card.branchId) return false
  if (!lineageIsValid(scope.branchLineage, scope.branchId)) return false
  if (authority.branchId === scope.branchId) {
    if (authority.branchLineage.length !== scope.branchLineage.length || !isPrefix(authority.branchLineage, scope.branchLineage)) return false
  } else if (authority.branchLineage.length >= scope.branchLineage.length || !isPrefix(authority.branchLineage, scope.branchLineage)) return false
  return true
}

function metadataAuthorityValid(value: Record<string, unknown>, item: SceneRecallCorpusItem, query: SceneRecallQuery, sourceCardHash: string): boolean {
  if (!nonEmpty(value.storyId) || !nonEmpty(value.projectId) || !nonEmpty(value.branchId) || !validHash(value.sourceCardHash) || !validHash(value.authorityHash) || sceneRecallAuthorityHash(value) !== value.authorityHash) return false
  if (value.sourceCardHash !== sourceCardHash || value.storyId !== query.scope.storyId || value.projectId !== query.scope.projectId || value.branchId !== item.card.branchId || value.validityEpoch !== query.scope.validityEpoch || value.headRevision !== query.scope.headRevision || value.headHash !== query.scope.headHash) return false
  if (!finiteInteger(value.storyRevision, 1) || value.storyRevision !== item.card.storyRevision || value.storyRevision > query.scope.storyRevision) return false
  if (!validHash(value.evidenceHash) || !item.card.sourceSpans.some((span) => span.spanHash === value.evidenceHash)) return false
  return true
}

function payoffUrgencyValue(item: SceneRecallCorpusItem, query: SceneRecallQuery): number {
  const urgency = item.payoffUrgency
  if (!urgency || typeof urgency !== 'object') return 0
  const value = urgency as unknown as Record<string, unknown>
  if (!finiteInteger(value.value, 0) || value.value > 1000 || !metadataAuthorityValid(value, item, query, item.card.cardHash)) return 0
  return value.value
}

function embeddingAuthorityValid(item: SceneRecallCorpusItem, query: SceneRecallQuery): boolean {
  const embedding = item.embedding
  if (!embedding || typeof embedding !== 'object') return false
  if (!['ready', 'unavailable', 'stale'].includes(embedding.status) || embedding.version !== null && !nonEmpty(embedding.version) || embedding.status === 'ready' && !nonEmpty(embedding.version) || !validHash(embedding.sourceCardHash) || embedding.sourceCardHash !== item.card.cardHash || embedding.storyId !== query.scope.storyId || embedding.projectId !== query.scope.projectId || embedding.branchId !== item.card.branchId || embedding.validityEpoch !== query.scope.validityEpoch || embedding.storyRevision !== item.card.storyRevision || embedding.headRevision !== query.scope.headRevision || embedding.headHash !== query.scope.headHash || !validHash(embedding.authorityHash) || sceneRecallAuthorityHash(embedding as unknown as Record<string, unknown>) !== embedding.authorityHash) return false
  if (embedding.similarity !== undefined && (!finiteNumber(embedding.similarity) || embedding.similarity < 0 || embedding.similarity > 1)) return false
  if (embedding.dimensions !== null && !finiteInteger(embedding.dimensions, 1)) return false
  if (embedding.vector !== undefined && embedding.vector !== null) {
    if (!Array.isArray(embedding.vector) || embedding.vector.some((value) => !finiteNumber(value)) || embedding.dimensions !== embedding.vector.length || !validHash(embedding.vectorHash) || embedding.vectorHash !== hash(embedding.vector)) return false
  } else if (embedding.vectorHash !== null) return false
  return true
}

function validateHardDependencies(item: SceneRecallCorpusItem, query: SceneRecallQuery): boolean {
  for (const dependency of item.hardDependencies ?? []) {
    const value = dependency as unknown as Record<string, unknown>
    if (!nonEmpty(dependency.key) || !['fact', 'beat', 'entity', 'location', 'object', 'thread', 'callback'].includes(dependency.kind) || !metadataAuthorityValid(value, item, query, item.card.cardHash)) return false
  }
  return true
}

function validateCausalEdges(item: SceneRecallCorpusItem, query: SceneRecallQuery): boolean {
  for (const edge of item.causalEdges ?? []) {
    const value = edge as unknown as Record<string, unknown>
    if (edge.fromCardId !== item.card.cardId || !nonEmpty(edge.fromCardId) || !nonEmpty(edge.toCardId) || !['depends_on', 'causes', 'pays_off'].includes(edge.relationType) || !metadataAuthorityValid(value, item, query, item.card.cardHash)) return false
  }
  return true
}

function validateTags(tags: readonly SceneRecallAuthorityTag[] | undefined, item: SceneRecallCorpusItem, query: SceneRecallQuery): boolean {
  for (const tag of tags ?? []) {
    if (!nonEmpty(tag.key) || !['entity', 'thread', 'location', 'object', 'payoff'].includes(tag.kind) || !metadataAuthorityValid(tag as unknown as Record<string, unknown>, item, query, item.card.cardHash)) return false
  }
  return true
}

function validateKnowledge(value: SceneRecallKnowledgeBoundary | undefined, item: SceneRecallCorpusItem, query: SceneRecallQuery): boolean {
  if (!value) return query.povCharacterId === undefined || query.povCharacterId === null
  const base = value as unknown as Record<string, unknown>
  if (!['known', 'unknown', 'not_applicable'].includes(value.status) || value.status === 'unknown' || query.povCharacterId === null && value.status === 'known' || query.povCharacterId !== null && value.status !== 'known' || value.status === 'known' && value.povCharacterId !== query.povCharacterId || !metadataAuthorityValid(base, item, query, item.card.cardHash)) return false
  const unknownEntityIds = value.unknownEntityIds ?? []
  if (!Array.isArray(unknownEntityIds) || unknownEntityIds.some((id) => !nonEmpty(id))) return false
  const knownEntityIds = new Set(query.knownEntityIds ?? [])
  return unknownEntityIds.length === 0 || unknownEntityIds.every((id) => knownEntityIds.has(id))
}

function prefilter(item: SceneRecallCorpusItem, query: SceneRecallQuery): string | null {
  try {
    if (!item || !item.card || typeof item.card !== 'object') return 'invalid_source'
    if (!finiteInteger(item.card.validityEpoch, 1) || item.card.validityEpoch !== query.scope.validityEpoch) return item.card.validityEpoch < query.scope.validityEpoch ? 'old_epoch' : 'invalid_scope'
    if (item.card.status === 'legacy_unverified') return 'legacy_unverified'
    if (!authorityMatchesQuery(item, query) || !sourceSnapshotValid(item) || !validateHardDependencies(item, query) || !validateCausalEdges(item, query) || !validateTags(item.entityTags, item, query) || !validateTags(item.threadTags, item, query) || !validateTags(item.payoffTags, item, query)) return 'invalid_source'
    if (item.card.storyId !== query.scope.storyId || item.card.projectId !== query.scope.projectId || item.card.validityEpoch !== query.scope.validityEpoch || item.card.storyRevision > query.scope.storyRevision || item.card.branchId !== item.authority.branchId) return item.card.storyRevision > query.scope.storyRevision ? 'future_revision' : 'invalid_scope'
    if (item.card.sceneId === query.scope.sceneId) return 'current_scene'
    if (item.stale) return 'stale'
    if (item.retracted) return 'retracted'
    if (query.alreadyInjectedCardIds?.includes(item.card.cardId)) return 'already_injected'
    if (item.unknownHardSource || item.knowledgeBoundary?.unknownHardSource || item.povKnowledge?.unknownHardSource) return 'unknown_hard_source'
    if (!validateKnowledge(item.povKnowledge ?? item.knowledgeBoundary, item, query)) return 'knowledge_boundary'
    return null
  } catch {
    return 'invalid_source'
  }
}

function dependencyKeys(item: SceneRecallCorpusItem): Set<string> {
  return new Set((item.hardDependencies ?? []).map((dependency) => dependency.key))
}

function tags(tags: readonly SceneRecallAuthorityTag[] | undefined): Set<string> {
  return new Set((tags ?? []).map((tag) => tag.key))
}

type NormalizedRecallQuery = Record<string, unknown> & { scope: SceneRecallQuery['scope'] }

function normalizeQuery(query: SceneRecallQuery): NormalizedRecallQuery {
  if (!query || typeof query !== 'object') fail('scene_recall_scope_invalid')
  const scope = query.scope
  if (!scope || !nonEmpty(scope.storyId) || !nonEmpty(scope.projectId) || !nonEmpty(scope.branchId) || !nonEmpty(scope.sceneId) || !finiteInteger(scope.validityEpoch, 1) || !finiteInteger(scope.storyRevision, 0) || !finiteInteger(scope.headRevision, 0) || scope.headRevision < scope.storyRevision || !validHash(scope.headHash) || !validHash(scope.expectedSourceCardSetHash) || !lineageIsValid(scope.branchLineage, scope.branchId)) fail('scene_recall_scope_invalid')
  if (query.tokenizerVersion !== SCENE_RECALL_TOKENIZER_VERSION || query.bm25Version !== SCENE_RECALL_BM25_VERSION || !finiteInteger(query.topK, 1) || query.topK > MAX_TOP_K || query.budget !== undefined && !finiteInteger(query.budget, 0)) fail('scene_recall_scope_invalid')
  if (typeof query.queryText !== 'undefined' && typeof query.queryText !== 'string' || query.embedding && (!nonEmpty(query.embedding.version) || query.embedding.vector !== undefined && (!Array.isArray(query.embedding.vector) || query.embedding.vector.some((value) => !finiteNumber(value))))) fail('scene_recall_scope_invalid')
  if (query.povCharacterId !== undefined && query.povCharacterId !== null && !nonEmpty(query.povCharacterId)) fail('scene_recall_scope_invalid')
  return {
    scope: { ...scope, branchLineage: [...scope.branchLineage] },
    hardDependencyKeys: sortedUnique(query.hardDependencyKeys),
    requiredCardIds: sortedUnique(query.requiredCardIds),
    requiredFactIds: sortedUnique(query.requiredFactIds),
    requiredFacts: normalizedRequiredFacts(query.requiredFacts),
    requiredBeatIds: sortedUnique(query.requiredBeatIds),
    activeEntityIds: sortedUnique(query.activeEntityIds),
    locations: sortedUnique(query.locations),
    objects: sortedUnique(query.objects),
    entityIds: sortedUnique(query.entityIds),
    threadIds: sortedUnique(query.threadIds),
    openThreadIds: sortedUnique(query.openThreadIds),
    payoffThreadIds: sortedUnique(query.payoffThreadIds),
    causalSeedCardIds: sortedUnique(query.causalSeedCardIds),
    queryText: query.queryText === undefined ? '' : normalizeSearchText(query.queryText),
    queryTerms: normalizedTerms(query.queryTerms),
    alreadyInjectedCardIds: sortedUnique(query.alreadyInjectedCardIds),
    povCharacterId: query.povCharacterId ?? null,
    knownEntityIds: sortedUnique(query.knownEntityIds),
    embedding: query.embedding ? { version: query.embedding.version, vector: query.embedding.vector ? [...query.embedding.vector] : null } : null,
    tokenizerVersion: query.tokenizerVersion,
    bm25Version: query.bm25Version,
    topK: query.topK,
    budget: query.budget ?? null
  }
}

function hardKeys(query: SceneRecallQuery): Set<string> {
  const directFactIds = new Set((query.requiredFacts ?? []).map((fact) => fact.factId))
  const values = [
    ...(query.hardDependencyKeys ?? []),
    ...(query.requiredFactIds ?? []).filter((id) => !directFactIds.has(id)).map((id) => `fact:${id}`),
    ...(query.requiredBeatIds ?? []).map((id) => `beat:${id}`),
    ...(query.activeEntityIds ?? []).map((id) => `entity:${id}`),
    ...(query.locations ?? []).map((id) => `location:${id}`),
    ...(query.objects ?? []).map((id) => `object:${id}`),
    ...(query.openThreadIds ?? []).map((id) => `thread:${id}`),
    ...(query.requiredCardIds ?? []).map((id) => `card:${id}`)
  ]
  return new Set(values)
}

function tokenize(value: string): string[] {
  const output: string[] = []
  const lower = normalizeSearchText(value)
  for (const match of lower.matchAll(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu)) output.push(match[0]!)
  return output
}

function cardSearchText(card: SceneMemoryCard): string {
  return card.sourceSpans.map((span) => span.text).join('\n')
}

function bm25Scores(items: readonly SceneRecallCorpusItem[], query: SceneRecallQuery): Map<string, number> {
  const terms = [...(query.queryTerms ?? []), ...tokenize(query.queryText ?? '')].flatMap((term) => tokenize(term))
  const uniqueTerms = [...new Set(terms)].sort(compareText)
  const documents = items.map((item) => tokenize(cardSearchText(item.card)))
  const averageLength = documents.length === 0 ? 0 : documents.reduce((sum, document) => sum + document.length, 0) / documents.length
  const documentFrequency = new Map<string, number>()
  for (const document of documents) for (const term of new Set(document)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
  const scores = new Map<string, number>()
  items.forEach((item, index) => {
    const document = documents[index]!
    const frequencies = new Map<string, number>()
    for (const term of document) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
    let score = 0
    for (const term of uniqueTerms) {
      const frequency = frequencies.get(term) ?? 0
      if (frequency === 0) continue
      const df = documentFrequency.get(term) ?? 0
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
      const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * (averageLength === 0 ? 1 : document.length / averageLength))
      score += idf * (frequency * 2.2) / denominator
    }
    scores.set(item.card.cardId, finiteNumber(score) ? Math.max(0, Math.round(score * 1000)) : 0)
  })
  return scores
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length || left.some((value) => !finiteNumber(value)) || right.some((value) => !finiteNumber(value))) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!
    leftNorm += left[index]! * left[index]!
    rightNorm += right[index]! * right[index]!
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0
  const value = dot / Math.sqrt(leftNorm * rightNorm)
  return finiteNumber(value) ? Math.max(0, Math.min(1, value)) : 0
}

function embeddingScore(item: SceneRecallCorpusItem, query: SceneRecallQuery): number {
  const embedding = item.embedding
  if (!embeddingAuthorityValid(item, query) || !embedding || embedding.status !== 'ready' || !query.embedding || embedding.version !== query.embedding.version) return 0
  if (embedding.vector) {
    if (!Array.isArray(embedding.vector) || !validHash(embedding.vectorHash) || embedding.vectorHash !== hash(embedding.vector) || embedding.dimensions !== embedding.vector.length || !query.embedding.vector || !Array.isArray(query.embedding.vector) || embedding.vector.length !== query.embedding.vector.length) return 0
    return Math.round(cosine(embedding.vector, query.embedding.vector) * 1000)
  }
  if (embedding.dimensions !== undefined && embedding.dimensions !== null && (!finiteInteger(embedding.dimensions, 1) || query.embedding.vector && embedding.dimensions !== query.embedding.vector.length)) return 0
  return finiteNumber(embedding.similarity) ? Math.round(Math.max(0, Math.min(1, embedding.similarity)) * 1000) : 0
}

function causalDistances(items: readonly SceneRecallCorpusItem[], seeds: readonly string[]): Map<string, number> {
  const graph = new Map<string, Set<string>>()
  const knownCardIds = new Set(items.map((item) => item.card.cardId))
  const connect = (from: string, to: string): void => {
    const values = graph.get(from) ?? new Set<string>()
    values.add(to)
    graph.set(from, values)
  }
  for (const item of items) for (const edge of item.causalEdges ?? []) {
    if (!knownCardIds.has(edge.fromCardId) || !knownCardIds.has(edge.toCardId)) continue
    connect(edge.toCardId, edge.fromCardId)
  }
  const distances = new Map<string, number>()
  const queue = [...new Set(seeds)].filter((cardId) => knownCardIds.has(cardId)).sort(compareText).map((cardId) => ({ cardId, distance: 0 }))
  for (const entry of queue) distances.set(entry.cardId, 0)
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!
    if (current.distance >= 2) continue
    for (const next of [...(graph.get(current.cardId) ?? [])].sort(compareText)) {
      if (distances.has(next)) continue
      distances.set(next, current.distance + 1)
      queue.push({ cardId: next, distance: current.distance + 1 })
    }
  }
  return distances
}

function candidateComparator(left: SceneRecallCandidate, right: SceneRecallCandidate): number {
  const leftScores = left.sortTuple.slice(0, 9) as number[]
  const rightScores = right.sortTuple.slice(0, 9) as number[]
  for (let index = 0; index < 9; index += 1) {
    const delta = rightScores[index]! - leftScores[index]!
    if (delta !== 0) return delta
  }
  return compareText(left.cardId, right.cardId)
}

function reasonCodes(input: { hard: boolean; causal: number; entity: number; thread: number; locationObject: boolean; payoff: boolean; pov: boolean; bm25: number; embedding: number }): SceneRecallReasonCode[] {
  const reasons: SceneRecallReasonCode[] = []
  if (input.hard) reasons.push('hard_fact')
  if (input.causal > 0) reasons.push('causal_parent')
  if (input.entity > 0) reasons.push('active_entity')
  if (input.thread > 0) reasons.push('open_thread')
  if (input.locationObject) reasons.push('location_object')
  if (input.payoff) reasons.push('payoff_due')
  if (input.pov) reasons.push('pov_knowledge')
  if (input.bm25 > 0) reasons.push('bm25_support')
  if (input.embedding > 0) reasons.push('semantic_match')
  if (reasons.length === 0) reasons.push('recent_tail')
  return reasons
}

function compareMetadata<T>(key: (value: T) => string, left: T, right: T): number {
  return compareText(key(left), key(right)) || compareText(stableSceneMemoryJson(left), stableSceneMemoryJson(right))
}

function canonicalFingerprint(item: SceneRecallCorpusItem): Record<string, unknown> {
  const hardDependencies = Array.isArray(item.hardDependencies) ? item.hardDependencies : item.hardDependencies ?? null
  const causalEdges = Array.isArray(item.causalEdges) ? item.causalEdges : item.causalEdges ?? null
  const entityTags = Array.isArray(item.entityTags) ? item.entityTags : item.entityTags ?? null
  const threadTags = Array.isArray(item.threadTags) ? item.threadTags : item.threadTags ?? null
  const payoffTags = Array.isArray(item.payoffTags) ? item.payoffTags : item.payoffTags ?? null
  const sourceSegments = Array.isArray(item.sourceSegments)
    ? item.sourceSegments.map((segment) => ({
      segmentId: segment.segmentId,
      contentHash: segment.contentHash,
      computedContentHash: typeof segment.content === 'string' ? sha256Text(segment.content) : null,
      segmentRevision: segment.segmentRevision,
      status: segment.status,
      sceneId: segment.sceneId,
      commitId: segment.commitId,
      commitManifestHash: segment.commitManifestHash,
      chunkIndex: segment.chunkIndex
    })).sort((left, right) => compareText(left.segmentId, right.segmentId))
    : item.sourceSegments ?? null
  return {
    cardId: item.card.cardId,
    cardHash: item.card.cardHash,
    stale: item.stale ?? false,
    retracted: item.retracted ?? false,
    authority: item.authority,
    sourceValidated: item.sourceValidated ?? false,
    sourceSegments,
    hardDependencies: Array.isArray(hardDependencies) ? [...hardDependencies].sort((left, right) => compareMetadata((value) => value.key, left, right)) : hardDependencies,
    causalEdges: Array.isArray(causalEdges) ? [...causalEdges].sort((left, right) => compareMetadata((value) => `${value.fromCardId}\u0000${value.toCardId}\u0000${value.relationType}`, left, right)) : causalEdges,
    entityTags: Array.isArray(entityTags) ? [...entityTags].sort((left, right) => compareMetadata((value) => value.key, left, right)) : entityTags,
    threadTags: Array.isArray(threadTags) ? [...threadTags].sort((left, right) => compareMetadata((value) => value.key, left, right)) : threadTags,
    payoffTags: Array.isArray(payoffTags) ? [...payoffTags].sort((left, right) => compareMetadata((value) => value.key, left, right)) : payoffTags,
    payoffUrgency: item.payoffUrgency ?? 0,
    povKnowledge: item.povKnowledge ?? item.knowledgeBoundary ?? null,
    embedding: item.embedding ? { status: item.embedding.status, version: item.embedding.version, similarity: item.embedding.similarity ?? null, vector: item.embedding.vector ?? null, dimensions: item.embedding.dimensions ?? null, vectorHash: item.embedding.vectorHash ?? null, sourceCardHash: item.embedding.sourceCardHash ?? null, authorityHash: item.embedding.authorityHash ?? null } : null
  }
}

function canonicalSourceCardSet(corpus: readonly SceneRecallCorpusItem[]): Record<string, unknown>[] {
  if (!Array.isArray(corpus)) fail('scene_recall_source_set_invalid')
  const seen = new Set<string>()
  return corpus.map((item) => {
    if (!item?.card || !nonEmpty(item.card.cardId) || seen.has(item.card.cardId)) fail('scene_recall_source_set_invalid')
    seen.add(item.card.cardId)
    return canonicalFingerprint(item)
  }).sort((left, right) => compareText(`${String(left.cardHash)}\u0000${String(left.cardId)}`, `${String(right.cardHash)}\u0000${String(right.cardId)}`))
}

export function sceneRecallSourceCardSetHash(corpus: readonly SceneRecallCorpusItem[]): string {
  return hash(canonicalSourceCardSet(corpus))
}

export function buildDeterministicRecallIndex(input: SceneRecallIndexInput): SceneRecallIndexResult {
  if (!input || !Array.isArray(input.corpus)) fail('scene_recall_index_corrupt')
  const normalizedQuery = normalizeQuery(input.query)
  const sourceCardSet = canonicalSourceCardSet(input.corpus)
  const sourceCardSetHash = hash(sourceCardSet)
  if (normalizedQuery.scope.expectedSourceCardSetHash !== sourceCardSetHash) fail('scene_recall_source_set_mismatch')
  const seen = new Set<string>()
  const omitted: SceneRecallOmission[] = []
  const eligible: SceneRecallCorpusItem[] = []
  for (const item of input.corpus) {
    if (!item?.card || !nonEmpty(item.card.cardId) || seen.has(item.card.cardId)) fail('scene_recall_index_corrupt')
    seen.add(item.card.cardId)
    const reason = prefilter(item, input.query)
    if (reason) {
      omitted.push({ cardId: item.card.cardId, reason: reason as SceneRecallOmission['reason'] })
      continue
    }
    eligible.push(item)
  }
  const algorithmBinding = {
    indexAlgorithmVersion: SCENE_RECALL_INDEX_ALGORITHM_VERSION,
    tokenizerVersion: SCENE_RECALL_TOKENIZER_VERSION,
    bm25Version: SCENE_RECALL_BM25_VERSION,
    tupleVersion: SCENE_RECALL_TUPLE_VERSION
  }
  const queryHash = hash({ ...algorithmBinding, expectedSourceCardSetHash: normalizedQuery.scope.expectedSourceCardSetHash, sourceCardSetHash, query: normalizedQuery, sourceCardSet })
  const indexHash = hash({ ...algorithmBinding, sourceCardSet })
  const scores = bm25Scores(eligible, input.query)
  const causal = causalDistances(eligible, input.query.causalSeedCardIds ?? [])
  const hard = hardKeys(input.query)
  const queryEntities = new Set([...(input.query.activeEntityIds ?? []), ...(input.query.entityIds ?? [])])
  const queryLocationsObjects = new Set([...(input.query.locations ?? []), ...(input.query.objects ?? [])])
  const queryThreads = new Set([...(input.query.openThreadIds ?? []), ...(input.query.threadIds ?? [])])
  const queryPayoffs = new Set(input.query.payoffThreadIds ?? [])
  const candidates: SceneRecallCandidate[] = eligible.map((item) => {
    const keys = dependencyKeys(item)
    const hardMatch = [...hard].some((key) => key === `card:${item.card.cardId}` || keys.has(key))
    const entityScore = [...(item.entityTags ?? [])].filter((tag) => tag.kind === 'entity' && queryEntities.has(tag.key)).length
    const locationObjectScore = [...(item.entityTags ?? [])].filter((tag) => (tag.kind === 'location' || tag.kind === 'object') && queryLocationsObjects.has(tag.key)).length
    const threadScore = [...tags(item.threadTags)].filter((key) => queryThreads.has(key)).length
    const payoffLink = [...tags(item.payoffTags)].some((key) => queryPayoffs.has(key))
    const causalScore = Math.max(0, 3 - (causal.get(item.card.cardId) ?? 3))
    const payoffUrgency = payoffUrgencyValue(item, input.query)
    const povEvidence = item.povKnowledge ?? item.knowledgeBoundary
    const povScore = povEvidence?.status === 'known' ? 1 : 0
    const bm25 = scores.get(item.card.cardId) ?? 0
    const embedding = embeddingScore(item, input.query)
    const recency = Math.max(0, 1000 - Math.min(1000, (input.query.scope.headRevision - item.card.storyRevision) * 10))
    const tuple: SceneRecallSortTuple = [hardMatch ? 1 : 0, payoffUrgency, causalScore, entityScore + locationObjectScore, payoffLink ? 1 : 0, povScore, bm25, embedding, recency, item.card.cardId]
    return { cardId: item.card.cardId, card: item.card, sortTuple: tuple, reasonCodes: reasonCodes({ hard: hardMatch, causal: causalScore, entity: entityScore, thread: threadScore, locationObject: locationObjectScore > 0, payoff: payoffLink || payoffUrgency > 0, pov: povScore > 0, bm25, embedding }) }
  }).sort(candidateComparator)
  const blockedHardDependencies = [...hard].filter((key) => !candidates.some((candidate) => candidate.sortTuple[0] === 1 && (key === `card:${candidate.cardId}` || dependencyKeys(eligible.find((item) => item.card.cardId === candidate.cardId)!).has(key)))).sort(compareText)
  if (blockedHardDependencies.length > 0) {
    for (const candidate of candidates) omitted.push({ cardId: candidate.cardId, reason: 'blocked_required_sources' })
    omitted.sort((left, right) => compareText(left.cardId, right.cardId) || compareText(left.reason, right.reason))
    return { queryHash, indexHash, status: 'blocked_required_sources', candidates: [], omitted, blockedHardDependencies }
  }
  const selected = candidates.slice(0, input.query.topK)
  for (const candidate of candidates.slice(input.query.topK)) omitted.push({ cardId: candidate.cardId, reason: 'budget_omitted' })
  omitted.sort((left, right) => compareText(left.cardId, right.cardId) || compareText(left.reason, right.reason))
  return { queryHash, indexHash, status: 'ready', candidates: selected, omitted, blockedHardDependencies }
}

export const buildRecallIndex = buildDeterministicRecallIndex
export const selectSceneRecall = buildDeterministicRecallIndex
