import { createHash } from 'node:crypto'
import { sceneBeatActionForms, validateSceneBeatSemanticEvidence } from './sceneContract'
import type {
  NarrativeCharacterStateChange,
  NarrativeForeshadowChange,
  NarrativeFact,
  NarrativeKnowledgeChange,
  NarrativeFactReference,
  NarrativeLedgerChangeKind,
  NarrativeObjectStateChange,
  NarrativeRelationshipChange,
  NarrativeStateChange,
  NarrativeStateDelta,
  NarrativeSemanticRole,
  NarrativeTimelineEventChange,
  SceneBeatActuality,
  SceneBeatAssertion,
  SceneBeatSemanticRoles,
  SceneBeatEventGroup,
  SceneBeatModelEvidence,
  SceneCommitManifest,
  SceneCompletionDecision,
  SceneContract
} from '../../shared/types'
import { codePointLength } from '../../shared/textMetrics'
import { manuscriptSegmentHash } from '../manuscript'
import { buildNarrativeStateDelta, normalizeNarrativeStateDelta, stableNarrativeJson } from './stateDelta'
import { narrativeFactReference } from './factRegistry'

/**
 * P1-2 narrative projection boundary.
 *
 * This module intentionally does not try to understand arbitrary prose.  A
 * change is admitted only when it is backed by one of:
 *   - a satisfied, prefix-bound SceneContract beat;
 *   - an explicit thread action in the frozen contract; or
 *   - a user-confirmed, explicitly structured Grill Me fact whose evidence
 *     terms occur in the accepted scene.
 *
 * Free-form Grill Me answers are therefore ignored, not converted into facts.
 * A malformed structured marker or a structured fact whose evidence cannot be
 * found produces `state_pending_review` and must be handled before commit.
 */

const HASH_RE = /^[0-9a-f]{64}$/u
const MAX_TEXT = 4000
const MAX_CHANGES = 256
const STRUCTURED_FACT_MARKER = /(?:^|\n)\s*(?:narrative[-_ ]?fact|叙事事实)\s*[:：]/iu
const ROLE_BINDING_PENDING_RE = /^narrative_state_directional_(?:agent|recipient)_pending(?::|$)/u
const SCENE_BEAT_ACTUALITIES: readonly SceneBeatActuality[] = [
  'asserted_actual', 'negated', 'planned', 'reported', 'remembered', 'dreamed',
  'conditional', 'imperative', 'requested', 'attempted', 'near_miss', 'pretended',
  'quoted', 'refused', 'proposed', 'questioned', 'threatened', 'unknown'
]
const SCENE_BEAT_ASSERTIONS: readonly SceneBeatAssertion[] = ['asserted', 'negated', 'non_asserted', 'unknown']

function beatActuality(beat: SceneBeatModelEvidence): SceneBeatActuality {
  return beat.actuality && SCENE_BEAT_ACTUALITIES.includes(beat.actuality) ? beat.actuality : 'unknown'
}

function beatAssertion(beat: SceneBeatModelEvidence, actuality: SceneBeatActuality): SceneBeatAssertion {
  if (beat.assertion && SCENE_BEAT_ASSERTIONS.includes(beat.assertion)) return beat.assertion
  if (actuality === 'asserted_actual') return 'asserted'
  if (actuality === 'negated') return 'negated'
  return actuality === 'unknown' ? 'unknown' : 'non_asserted'
}

function isAssertedActualBeat(beat: SceneBeatModelEvidence): boolean {
  const actuality = beatActuality(beat)
  return actuality === 'asserted_actual' && beatAssertion(beat, actuality) === 'asserted' && beat.negation !== true
}

function isAssertedActualGroup(group: SceneBeatEventGroup): boolean {
  return group.actuality === 'asserted_actual' && group.assertion === 'asserted' && group.negation !== true && group.scope?.confidence === 'high'
}

/** `accept_unknown` is intentionally narrower than the generic pending
 * review gate.  Malformed facts, missing registry rows, bad manifests and
 * zero-change scenes must never be converted into an empty projection. */
export function isRoleBindingAmbiguityReason(reason: string): boolean {
  return ROLE_BINDING_PENDING_RE.test(reason)
}

export function isRoleBindingAmbiguityOnly(reasons: readonly string[]): boolean {
  return reasons.length > 0 && reasons.every(isRoleBindingAmbiguityReason)
}

export interface AcceptedSceneSegmentInput {
  segmentId: string
  contentHash: string
  charCount: number
  chunkIndex: number
  revision: number
  content: string
}

export interface ConfirmedGrillAnswerInput {
  slotId: string
  value: string
  source?: string | null
}

interface StructuredFactEvidence {
  /** Exact terms that must occur in the accepted scene, in addition to the
   * contract/beat binding.  This keeps facts from being asserted merely
   * because they were present in an interview answer. */
  evidenceTerms?: unknown
  source?: unknown
  [key: string]: unknown
}

export interface NarrativeFactInput extends StructuredFactEvidence {
  kind: NarrativeLedgerChangeKind
  entityId?: unknown
  changeId?: unknown
  revision?: unknown
  characterId?: unknown
  status?: unknown
  locationId?: unknown
  goals?: unknown
  physicalState?: unknown
  emotionalBaseline?: unknown
  objectId?: unknown
  ownerId?: unknown
  holderId?: unknown
  condition?: unknown
  fromCharacterId?: unknown
  toCharacterId?: unknown
  dimension?: unknown
  value?: unknown
  reason?: unknown
  factId?: unknown
  knowerId?: unknown
  stance?: unknown
  certainty?: unknown
  sourceSceneId?: unknown
  effectiveTime?: unknown
  confidence?: unknown
  threadId?: unknown
  lifecycle?: unknown
  setupChangeId?: unknown
  payoffChangeId?: unknown
  eventType?: unknown
  actorIds?: unknown
  objectIds?: unknown
  storyTime?: unknown
  causeEventIds?: unknown
  consequenceEventIds?: unknown
  summary?: unknown
}

export interface NarrativeStateExtractionReport {
  schemaVersion: 1
  status: 'ready' | 'pending_review'
  runId: string
  sceneId: string
  contractId: string
  contractHash: string
  acceptedSegmentId: string
  acceptedContentHash: string
  acceptedSegments: Array<Pick<AcceptedSceneSegmentInput, 'segmentId' | 'contentHash' | 'charCount' | 'chunkIndex' | 'revision'>>
  sceneContentHash: string
  sceneCharCount: number
  decisionEvidenceHash: string
  decisionScenePrefixHash: string
  source: 'scene_contract_and_bound_beat_evidence_and_confirmed_grill_facts'
  changeIds: string[]
  changeKinds: NarrativeLedgerChangeKind[]
  /**
   * Explicit per-change binding for audit consumers.  The ledger schema keeps
   * the accepted tail hash for backwards compatibility; this durable report
   * binds every emitted change to the complete accepted-scene manifest as
   * well, including all accepted segment ids.
   */
  changeBindings: Array<{
    changeId: string
    acceptedSegmentId: string
    acceptedContentHash: string
    sceneContentHash: string
    acceptedSegmentIds: string[]
  }>
  pendingReasons: string[]
  ignoredAnswers: string[]
  generatedAt: number
}

export interface NarrativeStateExtractionInput {
  runId: string
  sceneId: string
  contract: SceneContract
  decision: SceneCompletionDecision
  candidateSegmentId: string
  candidateContentHash: string
  acceptedSegments: readonly AcceptedSceneSegmentInput[]
  confirmedAnswers?: readonly ConfirmedGrillAnswerInput[]
  /** Active facts already materialized from confirmed Grill Me answers. A
   * structured knowledge change must bind to one immutable registry row; an
   * omitted registry is therefore a fail-closed pending-review condition. */
  confirmedFacts?: readonly NarrativeFact[]
  /** A user choice may explicitly preserve an unresolved directional role as
   * unknown. Normal production extraction keeps this false and pauses. */
  allowUnknownSemanticRoles?: boolean
  now?: number
}

export type NarrativeStateExtractionResult =
  | { status: 'ready'; delta: NarrativeStateDelta; manifest: SceneCommitManifest; report: NarrativeStateExtractionReport }
  | { status: 'pending_review'; delta: null; manifest: SceneCommitManifest | null; report: NarrativeStateExtractionReport }

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function clean(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : ''
}

function requiredText(value: unknown, field: string, max = MAX_TEXT): string {
  const result = clean(value, max)
  if (!result) throw new Error(`narrative_state_fact_${field}_missing`)
  return result
}

function optionalText(value: unknown, max = MAX_TEXT): string | null {
  const result = clean(value, max)
  return result || null
}

function stringList(value: unknown, field: string, max = 32): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > max) throw new Error(`narrative_state_fact_${field}_invalid`)
  return value.map((item) => requiredText(item, field, 240)).filter(Boolean)
}

function timeValue(value: unknown, field: string): string | number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 240)
  throw new Error(`narrative_state_fact_${field}_invalid`)
}

function probability(value: unknown, field: string, fallback: number | null = null): number {
  if (value === undefined || value === null) {
    if (fallback !== null) return fallback
    throw new Error(`narrative_state_fact_${field}_missing`)
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`narrative_state_fact_${field}_invalid`)
  return value
}

function validSource(source: unknown): boolean {
  return source === undefined || source === null || source === '' || source === 'user' || source === 'option' || source === 'final_check'
}

function sceneContent(segments: readonly AcceptedSceneSegmentInput[]): string {
  return [...segments]
    .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.segmentId.localeCompare(b.segmentId))
    .map((segment) => segment.content)
    .join('')
}

function sceneManifest(input: NarrativeStateExtractionInput, content: string): SceneCommitManifest | null {
  const segments = [...input.acceptedSegments]
    .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.segmentId.localeCompare(b.segmentId))
  if (segments.length === 0) return null
  return {
    schemaVersion: 1,
    runId: input.runId,
    sceneId: input.sceneId,
    contractId: input.contract.contractId,
    contractHash: input.contract.frozenHash,
    acceptedSegments: segments.map((segment) => ({
      segmentId: segment.segmentId,
      contentHash: segment.contentHash,
      charCount: segment.charCount,
      chunkIndex: segment.chunkIndex,
      revision: segment.revision
    })),
    sceneContentHash: manuscriptSegmentHash(content),
    sceneCharCount: codePointLength(content),
    completionDecisionHash: manuscriptSegmentHash(stableNarrativeJson(input.decision)),
    stateDeltaHash: ''
  }
}

function baseChange(input: NarrativeStateExtractionInput, id: string, revision: number, kind: NarrativeLedgerChangeKind, entityId: string): {
  changeId: string
  revision: number
  kind: NarrativeLedgerChangeKind
  entityId: string
  runId: string
  sceneId: string
  acceptedSegmentId: string
  acceptedContentHash: string
  contractHash: string
} {
  return {
    changeId: id,
    revision,
    kind,
    entityId,
    runId: input.runId,
    sceneId: input.sceneId,
    acceptedSegmentId: input.candidateSegmentId,
    acceptedContentHash: input.candidateContentHash,
    contractHash: input.contract.frozenHash
  }
}

function changeIdentity(sceneHash: string, kind: NarrativeLedgerChangeKind, entityId: string, suffix = ''): string {
  return `nchange_${hashText(`${sceneHash}\u0000${kind}\u0000${entityId}\u0000${suffix}`).slice(0, 24)}`
}

function normaliseMarkerValue(value: string): unknown {
  const trimmed = value.trim()
  const marker = trimmed.match(/^\s*(?:narrative[-_ ]?fact|叙事事实)\s*[:：]\s*([\s\S]+?)\s*$/iu)
  const jsonText = marker ? marker[1]!.trim() : trimmed
  return JSON.parse(jsonText)
}

/** Parse only explicit JSON fact envelopes from user-confirmed Grill Me
 * answers.  Ordinary natural-language answers are deliberately ignored. */
export function parseConfirmedNarrativeFacts(answers: readonly ConfirmedGrillAnswerInput[] | undefined): { facts: NarrativeFactInput[]; pendingReasons: string[]; ignoredAnswers: string[] } {
  const facts: NarrativeFactInput[] = []
  const pendingReasons: string[] = []
  const ignoredAnswers: string[] = []
  for (const answer of answers ?? []) {
    const value = String(answer.value ?? '').trim()
    if (!value) continue
    const hasMarker = STRUCTURED_FACT_MARKER.test(value) || /^\s*\{\s*"?(?:narrativeFacts|facts|kind)"?\s*:/iu.test(value)
    if (!hasMarker) {
      ignoredAnswers.push(answer.slotId)
      continue
    }
    if (!validSource(answer.source)) {
      pendingReasons.push(`confirmed_fact_source_invalid:${answer.slotId}`)
      continue
    }
    try {
      const parsed = normaliseMarkerValue(value) as unknown
      const rawFacts = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? ((parsed as Record<string, unknown>).narrativeFacts ?? (parsed as Record<string, unknown>).facts ?? parsed)
        : parsed
      if (!Array.isArray(rawFacts)) {
        if (!rawFacts || typeof rawFacts !== 'object') throw new Error('fact_envelope_invalid')
        if (typeof (rawFacts as Record<string, unknown>).kind !== 'string') throw new Error('fact_kind_missing')
        facts.push({ ...(rawFacts as Record<string, unknown>), source: answer.slotId } as NarrativeFactInput)
      } else {
        for (const raw of rawFacts) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('fact_invalid')
          if (typeof (raw as Record<string, unknown>).kind !== 'string') throw new Error('fact_kind_missing')
          facts.push({ ...(raw as Record<string, unknown>), source: answer.slotId } as NarrativeFactInput)
        }
      }
    } catch {
      pendingReasons.push(`confirmed_fact_json_invalid:${answer.slotId}`)
    }
  }
  return { facts, pendingReasons, ignoredAnswers }
}

function evidenceTerms(fact: NarrativeFactInput): string[] {
  return stringList(fact.evidenceTerms, 'evidence_terms', 16).map((item) => item.trim()).filter(Boolean)
}

function termsPresent(content: string, terms: readonly string[]): boolean {
  return terms.length > 0 && terms.every((term) => content.includes(term))
}

/** SceneContract beat actions are canonical labels, while accepted prose may
 * use their natural-language realization.  Keep the binding strict (every
 * supplied term must be observable) without requiring the model to emit the
 * internal English action key verbatim in Chinese prose. */
const LEGACY_ACTION_REALIZATIONS: Record<string, readonly string[]> = {
  arrive: ['抵达', '到达', '来到', '赶到'],
  depart: ['离开', '出发', '启程'],
  handover: ['交给', '交接', '递给', '移交', '交出', '交到'],
  give: ['交给', '给予', '递给', '给', '交出', '交到'],
  receive: ['收到', '接过', '接到', '拿到'],
  lend: ['借给', '借出', '借走'],
  take: ['拿走', '取走', '带走'],
  steal: ['偷走', '盗走', '窃取'],
  place: ['放置', '放下', '摆放', '搁置'],
  lose: ['遗失', '丢失', '丢掉', '弄丢'],
  exchange: ['交换', '互换', '换取'],
  discover: ['发现', '找到', '寻到', '寻得', '找到了', '看见', '看到', '瞧见', '撞见', '抽出', '取出', '翻出', '翻到', '拆出'],
  return: ['回来', '返回', '归来', '归还', '回到', '带回', '失而复得'],
  confirm: ['确认', '证实', '确定', '认定', '证明'],
  leave: ['离开', '离去', '出发', '奔赴', '撤离'],
  meet: ['遇到', '遇见', '会面', '重逢', '见到'],
  reveal: ['揭示', '揭开', '发现', '真相'],
  light: ['点亮', '点燃', '亮起'],
  illuminate: ['点亮', '照亮', '亮起'],
  decide: ['决定', '做出决定', '选择'],
  choose: ['选择', '选定'],
  confront: ['对峙', '面对'],
  promise: ['承诺', '答应'],
  resolve: ['解决', '化解', '完成']
}

/** Actions whose state meaning depends on who did what to whom.  The
 * extractor never falls back to the first visible character for these. */
const DIRECTIONAL_ACTIONS = new Set(['handover', 'give', 'receive', 'lend', 'take', 'steal', 'place', 'lose', 'exchange', 'return'])

function semanticRoles(beat: SceneBeatModelEvidence): SceneBeatSemanticRoles {
  return {
    agent: Array.isArray(beat.agent) ? beat.agent.filter((item) => typeof item === 'string' && item.trim()) : [],
    patient: Array.isArray(beat.patient) ? beat.patient.filter((item) => typeof item === 'string' && item.trim()) : (beat.object ?? []).filter((item) => typeof item === 'string' && item.trim()),
    source: Array.isArray(beat.sourceRole) ? beat.sourceRole.filter((item) => typeof item === 'string' && item.trim()) : [],
    recipient: Array.isArray(beat.recipient) ? beat.recipient.filter((item) => typeof item === 'string' && item.trim()) : [],
    beneficiary: Array.isArray(beat.beneficiary) ? beat.beneficiary.filter((item) => typeof item === 'string' && item.trim()) : []
  }
}

function directionalBeat(beat: SceneBeatModelEvidence): boolean {
  return (beat.action ?? []).some((action) => DIRECTIONAL_ACTIONS.has(action))
}

function eventGroupRoles(groups: readonly SceneBeatEventGroup[]): SceneBeatSemanticRoles {
  const merge = (key: 'agent' | 'patient' | 'recipient' | 'beneficiary'): string[] => [...new Set(groups.flatMap((group) => group[key] ?? []))]
  return {
    agent: merge('agent'),
    patient: merge('patient'),
    source: [...new Set(groups.flatMap((group) => group.sourceRole ?? []))],
    recipient: merge('recipient'),
    beneficiary: merge('beneficiary')
  }
}

function boundEventGroupValid(group: SceneBeatEventGroup, content: string): boolean {
  if (!group || typeof group !== 'object' || !group.predicateSpan || !group.scope) return false
  const predicate = group.predicateSpan
  if (!Number.isInteger(predicate.start) || !Number.isInteger(predicate.end) || predicate.start < 0 || predicate.end <= predicate.start || predicate.end > content.length || content.slice(predicate.start, predicate.end) !== predicate.text) return false
  if (!Number.isInteger(group.start) || !Number.isInteger(group.end) || group.start < 0 || group.end < group.start || group.end > content.length || content.slice(group.start, group.end).trim() !== group.source.trim() || predicate.start < group.start || predicate.end > group.end) return false
  if (!['high', 'uncertain'].includes(group.scope.confidence) || group.scope.start < 0 || group.scope.end < group.scope.start || group.scope.end > content.length || typeof group.scope.rationale !== 'string') return false
  if (group.scope.confidence === 'high' && (predicate.start < group.scope.start || predicate.end > group.scope.end)) return false
  if (!SCENE_BEAT_ACTUALITIES.includes(group.actuality) || !SCENE_BEAT_ASSERTIONS.includes(group.assertion)) return false
  if ((group.actuality === 'asserted_actual') !== (group.assertion === 'asserted')) return false
  if (group.actuality === 'asserted_actual' && (group.negation || group.scope.confidence !== 'high')) return false
  for (const cue of group.cueSpans ?? []) {
    if (!Number.isInteger(cue.start) || !Number.isInteger(cue.end) || !Number.isInteger(cue.scopeStart) || !Number.isInteger(cue.scopeEnd) || cue.start < 0 || cue.end <= cue.start || cue.end > content.length || cue.scopeStart < 0 || cue.scopeEnd < cue.scopeStart || cue.scopeEnd > content.length || content.slice(cue.start, cue.end) !== cue.text || !['governs', 'outside', 'ambiguous'].includes(cue.relation) || typeof cue.rationale !== 'string') return false
    if (cue.relation === 'governs' && (predicate.start < cue.scopeStart || predicate.end > cue.scopeEnd)) return false
    if (group.actuality === 'asserted_actual' && cue.relation === 'ambiguous') return false
  }
  // A current-world mutation requires a high-confidence predicate-local scope
  // and an explicit assertion.  Non-actual provenance may remain in the
  // timeline, but it can never pass this gate by being relabelled upstream.
  return group.actuality !== 'asserted_actual' || (group.assertion === 'asserted' && group.scope.confidence === 'high')
}

function beatEventScopeBound(beat: SceneBeatModelEvidence, content: string): boolean {
  const groups = beat.eventGroups
  if (!groups || groups.length === 0) return !directionalBeat(beat)
  return groups.every((group) => boundEventGroupValid(group, content))
}

type BoundDecisionBeatEvidence = SceneBeatModelEvidence & {
  candidateHash?: unknown
  spans?: unknown
}

/** Re-check model evidence at the state projection boundary.  Completion
 * decisions are durable/untrusted input here, so validating it only during
 * evaluation would leave a gap between “complete” and the actual holder
 * mutation.  Deterministic evidence has neither field and follows the normal
 * local-event checks above. */
function decisionModelEvidenceBound(input: NarrativeStateExtractionInput, beat: SceneBeatModelEvidence): boolean {
  const candidateBeat = beat as BoundDecisionBeatEvidence
  const hasCandidateHash = candidateBeat.candidateHash !== undefined
  const hasSpans = candidateBeat.spans !== undefined
  if (!hasCandidateHash && !hasSpans) return true
  if (typeof candidateBeat.candidateHash !== 'string' || !HASH_RE.test(candidateBeat.candidateHash)) return false
  if (candidateBeat.candidateHash !== input.candidateContentHash || candidateBeat.candidateHash !== input.decision.candidateHash) return false
  const segment = input.acceptedSegments.find((item) => item.segmentId === input.candidateSegmentId)
  if (!segment || segment.contentHash !== candidateBeat.candidateHash || hashText(segment.content) !== candidateBeat.candidateHash) return false
  if (beat.semanticVersion === 1 || beat.semanticVersion === 2) {
    const prefix = sceneContent(input.acceptedSegments.filter(item => item.segmentId !== input.candidateSegmentId))
    if (beat.contractHash !== input.contract.frozenHash || beat.scenePrefixHash !== hashText(prefix) || beat.scenePrefixHash !== input.decision.scenePrefixHash) return false
    const checked = validateSceneBeatSemanticEvidence(input.contract, segment.content, prefix, [beat])
    const expected = checked.evidence[0]
    if (checked.invalidBeatIds.length || !expected) return false
    // Reconstruct the local envelopes, not merely their quoted strings. A
    // durable packet cannot replace a checked role or scope before projection.
    return (['actor', 'action', 'object', 'location', 'result', 'time', 'agent', 'patient', 'sourceRole', 'recipient', 'beneficiary', 'eventGroups', 'actuality', 'assertion', 'negation', 'modality'] as const)
      .every(key => JSON.stringify(beat[key]) === JSON.stringify(expected[key]))
  }
  if (!Array.isArray(candidateBeat.spans) || candidateBeat.spans.length === 0) return false
  return candidateBeat.spans.every((raw) => {
    if (!raw || typeof raw !== 'object') return false
    const span = raw as { start?: unknown; end?: unknown; text?: unknown }
    return Number.isInteger(span.start) && Number.isInteger(span.end) && Number(span.start) >= 0 && Number(span.end) > Number(span.start) && Number(span.end) <= segment.content.length && typeof span.text === 'string' && span.text.length > 0 && segment.content.slice(Number(span.start), Number(span.end)) === span.text
  })
}

function beatTermPresent(content: string, term: string): boolean {
  if (content.includes(term)) return true
  const canonical = term.trim().toLowerCase()
  return [...sceneBeatActionForms(canonical), ...(LEGACY_ACTION_REALIZATIONS[canonical] ?? [])].some((realization) => content.includes(realization.trim()))
}

function factBase(input: NarrativeStateExtractionInput, sceneHash: string, fact: NarrativeFactInput, index: number): {
  id: string
  revision: number
  kind: NarrativeLedgerChangeKind
  entityId: string
  base: ReturnType<typeof baseChange>
} {
  const kind = fact.kind
  if (!['timeline_event', 'character_state', 'object_state', 'relationship', 'knowledge', 'foreshadow'].includes(kind)) throw new Error('narrative_state_fact_kind_invalid')
  const entityId = requiredText(fact.entityId, 'entity_id', 240)
  const id = changeIdentity(sceneHash, kind, entityId, String(fact.changeId ?? index))
  return { id, revision: index, kind, entityId, base: baseChange(input, id, index, kind, entityId) }
}

/**
 * Resolve a structured knowledge assertion to the durable Grill fact. The
 * structured payload may use its own semantic `factId`; the confirmed answer
 * slot remains authoritative, selected by exact id first or by the parser's
 * answer-slot provenance second. Ambiguity/missing rows are errors so the
 * caller records pending_review rather than writing a bare knowledge edge.
 */
function registeredKnowledgeFact(input: NarrativeStateExtractionInput, fact: NarrativeFactInput): NarrativeFact | null {
  if (input.confirmedFacts === undefined) throw new Error('confirmed_fact_registry_unavailable')
  const active = input.confirmedFacts.filter((candidate) => candidate.status === 'active')
  const requestedId = typeof fact.factId === 'string' ? fact.factId.trim() : ''
  const sourceSlot = typeof fact.source === 'string' ? fact.source.trim() : ''
  const sourceMatches = (candidate: NarrativeFact): boolean => sourceSlot.length === 0 || candidate.sourceSlotIds.includes(sourceSlot) || candidate.sources.some((source) => source.sourceSlotId === sourceSlot)
  const exact = requestedId ? active.filter((candidate) => candidate.factId === requestedId) : []
  if (exact.length === 1) {
    if (sourceMatches(exact[0]!)) return exact[0]!
    throw new Error(`confirmed_fact_registry_source_mismatch:${requestedId}`)
  }
  const bySlot = sourceSlot
    ? active.filter((candidate) => candidate.sourceSlotIds.includes(sourceSlot) || candidate.sources.some((source) => source.sourceSlotId === sourceSlot))
    : []
  if (bySlot.length === 1) return bySlot[0]!
  throw new Error(`confirmed_fact_registry_reference_missing:${requestedId || sourceSlot || 'unknown'}`)
}

function parseFactChange(input: NarrativeStateExtractionInput, sceneHash: string, fact: NarrativeFactInput, index: number): NarrativeStateChange {
  const common = factBase(input, sceneHash, fact, index)
  const base = common.base
  switch (common.kind) {
    case 'character_state':
      return {
        ...base,
        kind: 'character_state',
        characterId: requiredText(fact.characterId ?? common.entityId, 'character_id', 240),
        status: optionalText(fact.status, 240),
        locationId: optionalText(fact.locationId, 240),
        goals: stringList(fact.goals, 'goals'),
        physicalState: optionalText(fact.physicalState, 1000),
        emotionalBaseline: optionalText(fact.emotionalBaseline, 1000)
      } satisfies NarrativeCharacterStateChange
    case 'object_state':
      return {
        ...base,
        kind: 'object_state',
        objectId: requiredText(fact.objectId ?? common.entityId, 'object_id', 240),
        ownerId: optionalText(fact.ownerId, 240),
        holderId: optionalText(fact.holderId, 240),
        locationId: optionalText(fact.locationId, 240),
        condition: optionalText(fact.condition, 1000)
      } satisfies NarrativeObjectStateChange
    case 'relationship':
      return {
        ...base,
        kind: 'relationship',
        fromCharacterId: requiredText(fact.fromCharacterId, 'from_character_id', 240),
        toCharacterId: requiredText(fact.toCharacterId, 'to_character_id', 240),
        dimension: requiredText(fact.dimension, 'dimension', 240),
        value: typeof fact.value === 'number' && Number.isFinite(fact.value) ? fact.value : requiredText(fact.value, 'value', 1000),
        reason: requiredText(fact.reason, 'reason', 2000)
      } satisfies NarrativeRelationshipChange
    case 'knowledge': {
      const registered = registeredKnowledgeFact(input, fact)
      const factReference: NarrativeFactReference | undefined = registered ? narrativeFactReference(registered) : undefined
      return {
        ...base,
        kind: 'knowledge',
        factId: registered?.factId ?? requiredText(fact.factId, 'fact_id', 240),
        knowerId: requiredText(fact.knowerId, 'knower_id', 240),
        stance: fact.stance as NarrativeKnowledgeChange['stance'],
        certainty: probability(fact.certainty, 'certainty'),
        sourceSceneId: input.sceneId,
        effectiveTime: timeValue(fact.effectiveTime, 'effective_time'),
        confidence: probability(fact.confidence, 'confidence'),
        ...(factReference ? { factRef: factReference } : {})
      } satisfies NarrativeKnowledgeChange
    }
    case 'foreshadow':
      return {
        ...base,
        kind: 'foreshadow',
        threadId: requiredText(fact.threadId ?? common.entityId, 'thread_id', 240),
        lifecycle: fact.lifecycle as NarrativeForeshadowChange['lifecycle'],
        reason: optionalText(fact.reason, 2000),
        setupChangeId: optionalText(fact.setupChangeId, 240),
        payoffChangeId: optionalText(fact.payoffChangeId, 240)
      } satisfies NarrativeForeshadowChange
    case 'timeline_event':
      return {
        ...base,
        kind: 'timeline_event',
        eventType: requiredText(fact.eventType, 'event_type', 240),
        actorIds: stringList(fact.actorIds, 'actor_ids'),
        objectIds: stringList(fact.objectIds, 'object_ids'),
        locationId: optionalText(fact.locationId, 240),
        storyTime: timeValue(fact.storyTime, 'story_time'),
        causeEventIds: stringList(fact.causeEventIds, 'cause_event_ids'),
        consequenceEventIds: stringList(fact.consequenceEventIds, 'consequence_event_ids'),
        summary: requiredText(fact.summary, 'summary', 2000)
      } satisfies NarrativeTimelineEventChange
  }
}

function boundBeatEvidence(input: NarrativeStateExtractionInput, content: string): SceneBeatModelEvidence[] {
  const expectedPrefixHash = input.decision.scenePrefixHash
  if (!expectedPrefixHash || !HASH_RE.test(expectedPrefixHash)) throw new Error('narrative_state_scene_prefix_missing')
  const beats = input.decision.beatEvidence ?? []
  if (beats.length === 0) throw new Error('narrative_state_beat_evidence_missing')
  for (const beat of beats) {
    if (beat.scenePrefixHash !== expectedPrefixHash) throw new Error(`narrative_state_beat_prefix_mismatch:${beat.beatId}`)
    if (!decisionModelEvidenceBound(input, beat)) throw new Error(`narrative_state_model_evidence_unbound:${beat.beatId}`)
    if (beat.status !== 'satisfied') throw new Error(`narrative_state_beat_not_satisfied:${beat.beatId}`)
    if (!beatEventScopeBound(beat, content)) throw new Error('narrative_state_event_scope_unbound:' + beat.beatId)
    // New decisions carry predicate-local actuality. A legacy directional
    // record without it is not allowed to mutate a current holder.
    if (beatActuality(beat) === 'unknown' && directionalBeat(beat)) throw new Error(`narrative_state_event_actuality_missing:${beat.beatId}`)
    // A beat-level model label cannot promote a chain whose local event
    // envelopes are all reported/negated/planned.  Directional state is only
    // projected when one predicate-local group itself is asserted actual.
    if (directionalBeat(beat) && !(beat.eventGroups ?? []).some(isAssertedActualGroup)) {
      throw new Error(`narrative_state_event_actual_group_missing:${beat.beatId}`)
    }
    const roles = semanticRoles(beat)
    const terms = [...(beat.actor ?? []), ...(beat.action ?? []), ...(beat.object ?? []), ...(beat.location ?? []), ...(beat.result ?? []), ...(beat.time ?? []), ...roles.agent, ...roles.patient, ...roles.source, ...roles.recipient, ...roles.beneficiary].filter((term) => typeof term === 'string' && term.trim())
    if (terms.length === 0 || !terms.every((term) => beatTermPresent(content, term))) throw new Error(`narrative_state_beat_unbound:${beat.beatId}`)
    // A directional event without an explicit agent is intentionally not
    // resolved by the extractor.  It can only proceed through the explicit
    // “accept unknown” review decision; ordinary production extraction stays
    // pending so `林舟把钥匙交给沈遥` cannot silently become `沈遥` or vice
    // versa merely because one name appears first in the sentence.
    if (directionalBeat(beat) && roles.agent.length === 0 && !input.allowUnknownSemanticRoles) {
      throw new Error(`narrative_state_directional_agent_pending:${beat.beatId}`)
    }
  }
  return beats
}

function beatChanges(input: NarrativeStateExtractionInput, sceneHash: string, content: string, beats: readonly SceneBeatModelEvidence[], startRevision: number): NarrativeStateChange[] {
  const active = new Set(input.contract.activeCharacterIds)
  const changes: NarrativeStateChange[] = []
  let revision = startRevision
  for (const beat of beats) {
    const actorIds = (beat.actor ?? []).filter((actor) => active.size === 0 || active.has(actor) || input.contract.characterIds.includes(actor))
    const roles = semanticRoles(beat)
    const actuality = beatActuality(beat)
    const assertion = beatAssertion(beat, actuality)
    const currentStateEvent = isAssertedActualBeat(beat)
    const assertedGroups = (beat.eventGroups ?? []).filter(isAssertedActualGroup)
    // State projection uses only roles from predicate-local asserted groups.
    // Timeline provenance still records the aggregate beat, but a reported
    // or refused group must never donate its recipient/holder to the current
    // world state when another group in the same beat is actual.
    const stateRoles = currentStateEvent && assertedGroups.length > 0
      ? eventGroupRoles(assertedGroups)
      : semanticRoles(beat)
    const agentIds = stateRoles.agent.filter((actor) => active.size === 0 || active.has(actor) || input.contract.characterIds.includes(actor))
    const resolvedActorIds = agentIds.length > 0 ? agentIds : (!directionalBeat(beat) ? actorIds : [])
    const directional = directionalBeat(beat)
    const actionNames = new Set(beat.action ?? [])
    const unknownRoles: NarrativeSemanticRole[] = []
    if (directional && input.allowUnknownSemanticRoles && roles.agent.length === 0) unknownRoles.push('agent')
    if (input.allowUnknownSemanticRoles && (actionNames.has('handover') || actionNames.has('give') || actionNames.has('lend') || actionNames.has('exchange')) && roles.recipient.length === 0) unknownRoles.push('recipient')
    const eventId = `event:${beat.beatId}`
    const base = baseChange(input, changeIdentity(sceneHash, 'timeline_event', eventId), revision++, 'timeline_event', eventId)
    changes.push({
      ...base,
      kind: 'timeline_event',
      eventType: beat.action?.[0] ?? 'scene_beat',
      actorIds: resolvedActorIds.slice(0, 12),
      objectIds: [...new Set([...(roles.patient ?? []), ...(beat.object ?? [])])].slice(0, 12),
      locationId: beat.location?.[0] ?? input.contract.locationId ?? null,
      storyTime: beat.time?.[0] ?? input.contract.storyTime ?? null,
      causeEventIds: [],
      consequenceEventIds: [],
      summary: beat.rationale?.trim() || `已确认推进：${beat.beatId}`,
      actuality,
      assertion,
      ...(unknownRoles.length > 0 ? { unknownRoles } : {})
    } satisfies NarrativeTimelineEventChange)
    // Plans, requests, refusals, quotations, attempts, and other non-actual
    // readings remain useful timeline provenance, but they do not assert that
    // a character is present or that an object changed hands.  This is the
    // state-projection boundary that prevents a lexical “交给” from creating
    // a false current holder even if an upstream decision was malformed.
    if (!currentStateEvent) continue
    for (const characterId of [...new Set(agentIds.length > 0 ? agentIds : resolvedActorIds)]) {
      const charBase = baseChange(input, changeIdentity(sceneHash, 'character_state', characterId, beat.beatId), revision++, 'character_state', characterId)
      changes.push({
        ...charBase,
        kind: 'character_state',
        characterId,
        status: 'present_in_accepted_scene',
        locationId: beat.location?.[0] ?? input.contract.locationId ?? null,
        goals: input.contract.desire ? [input.contract.desire] : [],
        physicalState: null,
        emotionalBaseline: null
      } satisfies NarrativeCharacterStateChange)
    }
    const statePatients = assertedGroups.length > 0
      ? assertedGroups.flatMap((group) => [...group.patient, ...group.object])
      : [...(stateRoles.patient ?? []), ...(beat.object ?? [])]
    for (const objectId of [...new Set(statePatients)]) {
      const objectBase = baseChange(input, changeIdentity(sceneHash, 'object_state', objectId, beat.beatId), revision++, 'object_state', objectId)
      // A beat may contain more than one asserted transfer of the same
      // object.  The holder is a temporal fact, so use the last asserted
      // predicate-local group that mentions this object; taking the first
      // merged recipient would resurrect an earlier holder.  If that latest
      // group has no recipient, stay pending/unknown instead of borrowing a
      // recipient from an earlier event in the same beat.
      const latestObjectGroup = [...assertedGroups].reverse().find((group) => [...group.patient, ...group.object].includes(objectId))
      const recipientId = latestObjectGroup
        ? latestObjectGroup.recipient[0] ?? (latestObjectGroup.action === 'receive' || latestObjectGroup.action === 'take' || latestObjectGroup.action === 'steal'
          ? (latestObjectGroup.agent[0] ?? null)
          : null)
        : stateRoles.recipient[0] ?? ((beat.action ?? []).some((action) => action === 'receive' || action === 'take' || action === 'steal') ? (agentIds[0] ?? resolvedActorIds[0] ?? null) : null)
      const holderStatus: NarrativeObjectStateChange['holderStatus'] = recipientId ? 'known' : directional ? (input.allowUnknownSemanticRoles ? 'unknown' : 'pending_review') : undefined
      changes.push({
        ...objectBase,
        kind: 'object_state',
        objectId,
        ownerId: null,
        holderId: recipientId,
        ...(holderStatus ? { holderStatus } : {}),
        locationId: beat.location?.[0] ?? input.contract.locationId ?? null,
        condition: 'present_in_accepted_scene'
      } satisfies NarrativeObjectStateChange)
    }
  }
  return changes
}

function threadChanges(input: NarrativeStateExtractionInput, sceneHash: string, startRevision: number): NarrativeStateChange[] {
  const changes: NarrativeStateChange[] = []
  let revision = startRevision
  for (const action of input.contract.threadActions) {
    const key = `thread:${action.threadId}:${action.action}`
    const base = baseChange(input, changeIdentity(sceneHash, 'foreshadow', key), revision++, 'foreshadow', action.threadId)
    const lifecycle: NarrativeForeshadowChange['lifecycle'] = action.action === 'open' ? 'open' : action.action === 'advance' ? 'advanced' : action.action === 'delay' ? 'delayed' : 'resolved'
    changes.push({ ...base, kind: 'foreshadow', threadId: action.threadId, lifecycle, reason: input.contract.handoff || null, setupChangeId: null, payoffChangeId: null } satisfies NarrativeForeshadowChange)
  }
  return changes
}

function normaliseStructuredFacts(input: NarrativeStateExtractionInput, sceneHash: string, content: string, startRevision: number, parsed: NarrativeFactInput[]): { changes: NarrativeStateChange[]; pendingReasons: string[] } {
  const changes: NarrativeStateChange[] = []
  const pendingReasons: string[] = []
  let revision = startRevision
  for (const fact of parsed) {
    try {
      const terms = evidenceTerms(fact)
      if (!termsPresent(content, terms)) {
        pendingReasons.push(`confirmed_fact_evidence_missing:${String(fact.entityId ?? fact.factId ?? fact.threadId ?? 'unknown')}`)
        continue
      }
      if (fact.kind === 'knowledge' && fact.sourceSceneId !== undefined && fact.sourceSceneId !== null && fact.sourceSceneId !== input.sceneId) {
        pendingReasons.push(`confirmed_fact_source_scene_mismatch:${String(fact.factId ?? 'unknown')}`)
        continue
      }
      if (fact.kind === 'foreshadow' && !['open', 'advanced', 'delayed', 'resolved', 'abandoned'].includes(String(fact.lifecycle))) {
        pendingReasons.push(`confirmed_fact_foreshadow_lifecycle_invalid:${String(fact.threadId ?? 'unknown')}`)
        continue
      }
      if (fact.kind === 'knowledge' && !['knows', 'believes', 'disbelieves', 'unknown'].includes(String(fact.stance))) {
        pendingReasons.push(`confirmed_fact_knowledge_stance_invalid:${String(fact.factId ?? 'unknown')}`)
        continue
      }
      const change = parseFactChange(input, sceneHash, fact, revision++)
      changes.push(change)
    } catch (error) {
      pendingReasons.push(`${error instanceof Error ? error.message : 'confirmed_fact_invalid'}:${String(fact.entityId ?? fact.factId ?? fact.threadId ?? 'unknown')}`)
    }
  }
  return { changes, pendingReasons }
}

function validateInput(input: NarrativeStateExtractionInput, content: string): string[] {
  const errors: string[] = []
  if (!input.runId || !input.sceneId || input.contract.sceneId !== input.sceneId || !HASH_RE.test(input.contract.frozenHash)) errors.push('scene_contract_identity_invalid')
  if (input.decision.status !== 'complete' || input.decision.sceneId !== input.sceneId || input.decision.contractHash !== input.contract.frozenHash) errors.push('scene_completion_not_accepted')
  if (input.decision.candidateSegmentId !== input.candidateSegmentId || input.decision.candidateHash !== input.candidateContentHash || !HASH_RE.test(input.candidateContentHash)) errors.push('candidate_identity_invalid')
  const candidate = input.acceptedSegments.find((segment) => segment.segmentId === input.candidateSegmentId)
  if (!candidate || candidate.contentHash !== input.candidateContentHash || candidate.contentHash !== manuscriptSegmentHash(candidate.content) || candidate.charCount !== codePointLength(candidate.content)) errors.push('candidate_segment_integrity_invalid')
  for (const segment of input.acceptedSegments) {
    if (!segment.segmentId || !HASH_RE.test(segment.contentHash) || segment.contentHash !== manuscriptSegmentHash(segment.content) || segment.charCount !== codePointLength(segment.content) || !Number.isInteger(segment.chunkIndex) || !Number.isInteger(segment.revision) || segment.revision < 1) errors.push(`scene_segment_integrity_invalid:${segment.segmentId || 'unknown'}`)
  }
  if (!content || codePointLength(content) === 0) errors.push('accepted_scene_empty')
  return [...new Set(errors)]
}

function report(input: NarrativeStateExtractionInput, manifest: SceneCommitManifest | null, status: NarrativeStateExtractionReport['status'], pendingReasons: string[], changeIds: string[], changeKinds: NarrativeLedgerChangeKind[], ignoredAnswers: string[], now: number): NarrativeStateExtractionReport {
  const acceptedSegmentIds = [...input.acceptedSegments]
    .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.segmentId.localeCompare(b.segmentId))
    .map((segment) => segment.segmentId)
  return {
    schemaVersion: 1,
    status,
    runId: input.runId,
    sceneId: input.sceneId,
    contractId: input.contract.contractId,
    contractHash: input.contract.frozenHash,
    acceptedSegmentId: input.candidateSegmentId,
    acceptedContentHash: input.candidateContentHash,
    acceptedSegments: [...input.acceptedSegments].sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.segmentId.localeCompare(b.segmentId)).map((segment) => ({ segmentId: segment.segmentId, contentHash: segment.contentHash, charCount: segment.charCount, chunkIndex: segment.chunkIndex, revision: segment.revision })),
    sceneContentHash: manifest?.sceneContentHash ?? '',
    sceneCharCount: manifest?.sceneCharCount ?? 0,
    decisionEvidenceHash: input.decision.evidenceHash,
    decisionScenePrefixHash: input.decision.scenePrefixHash ?? '',
    source: 'scene_contract_and_bound_beat_evidence_and_confirmed_grill_facts',
    changeIds,
    changeKinds,
    changeBindings: changeIds.map((changeId) => ({
      changeId,
      acceptedSegmentId: input.candidateSegmentId,
      acceptedContentHash: input.candidateContentHash,
      sceneContentHash: manifest?.sceneContentHash ?? '',
      acceptedSegmentIds
    })),
    pendingReasons: [...new Set(pendingReasons)],
    ignoredAnswers,
    generatedAt: now
  }
}

/**
 * Build a non-empty delta for an already complete scene, or return a durable
 * pending-review result.  The caller must persist the report before throwing
 * on `pending_review`; it must never substitute an empty delta.
 */
export function extractNarrativeStateDelta(input: NarrativeStateExtractionInput): NarrativeStateExtractionResult {
  const content = sceneContent(input.acceptedSegments)
  const manifest = sceneManifest(input, content)
  const structuralErrors = validateInput(input, content)
  const parsed = parseConfirmedNarrativeFacts(input.confirmedAnswers)
  const pendingReasons = [...structuralErrors, ...parsed.pendingReasons]
  if (!manifest) {
    const pending = report(input, null, 'pending_review', pendingReasons.length > 0 ? pendingReasons : ['accepted_scene_manifest_missing'], [], [], parsed.ignoredAnswers, input.now ?? Date.now())
    return { status: 'pending_review', delta: null, manifest: null, report: pending }
  }
  if (pendingReasons.length > 0) {
    const pending = report(input, manifest, 'pending_review', pendingReasons, [], [], parsed.ignoredAnswers, input.now ?? Date.now())
    return { status: 'pending_review', delta: null, manifest, report: pending }
  }
  let beats: SceneBeatModelEvidence[]
  try {
    beats = boundBeatEvidence(input, content)
  } catch (error) {
    const pending = report(input, manifest, 'pending_review', [error instanceof Error ? error.message : 'narrative_state_beat_invalid'], [], [], parsed.ignoredAnswers, input.now ?? Date.now())
    return { status: 'pending_review', delta: null, manifest, report: pending }
  }
  const sceneHash = manifest.sceneContentHash
  const changes: NarrativeStateChange[] = []
  // Ledger revisions are global per logical entity in narrativeContext.  A
  // deterministic scene-order window avoids collisions when the same
  // character/thread appears in adjacent scenes, while remaining stable on
  // replay (no wall-clock revision source is used).
  const revisionSeed = Math.max(1, Math.floor(input.contract.order)) * (MAX_CHANGES + 1) + 1
  changes.push(...beatChanges(input, sceneHash, content, beats, revisionSeed))
  changes.push(...threadChanges(input, sceneHash, revisionSeed + changes.length))
  const structured = normaliseStructuredFacts(input, sceneHash, content, revisionSeed + changes.length, parsed.facts)
  if (structured.pendingReasons.length > 0) {
    const pending = report(input, manifest, 'pending_review', structured.pendingReasons, [], [], parsed.ignoredAnswers, input.now ?? Date.now())
    return { status: 'pending_review', delta: null, manifest, report: pending }
  }
  changes.push(...structured.changes)
  if (changes.length === 0) {
    const pending = report(input, manifest, 'pending_review', ['accepted_scene_produced_no_structured_state_change'], [], [], parsed.ignoredAnswers, input.now ?? Date.now())
    return { status: 'pending_review', delta: null, manifest, report: pending }
  }
  if (changes.length > MAX_CHANGES) {
    const pending = report(input, manifest, 'pending_review', ['accepted_scene_state_change_limit_exceeded'], [], [], parsed.ignoredAnswers, input.now ?? Date.now())
    return { status: 'pending_review', delta: null, manifest, report: pending }
  }
  const delta = buildNarrativeStateDelta({
    schemaVersion: 1,
    runId: input.runId,
    sceneId: input.sceneId,
    acceptedSegmentId: input.candidateSegmentId,
    acceptedContentHash: input.candidateContentHash,
    contractHash: input.contract.frozenHash,
    changes
  })
  try {
    // Run the same strict normalizer used by the repository before returning a
    // ready result.  This keeps the production path fail-closed even when a
    // future change adds a malformed extractor branch.
    normalizeNarrativeStateDelta(delta)
  } catch (error) {
    const pending = report(input, manifest, 'pending_review', [`narrative_state_delta_invalid:${error instanceof Error ? error.message : 'unknown'}`], [], [], parsed.ignoredAnswers, input.now ?? Date.now())
    return { status: 'pending_review', delta: null, manifest, report: pending }
  }
  const finalManifest = { ...manifest, stateDeltaHash: delta.deltaHash }
  const ready = report(input, finalManifest, 'ready', [], changes.map((change) => change.changeId), changes.map((change) => change.kind), parsed.ignoredAnswers, input.now ?? Date.now())
  return { status: 'ready', delta, manifest: finalManifest, report: ready }
}
