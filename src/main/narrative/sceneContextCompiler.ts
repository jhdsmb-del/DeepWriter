import { createHash } from 'node:crypto'
import { estimateTokens, type SceneContract, type SceneContextCompileResult, type SceneContextCompilerInput, type SceneContextSectionDecision, type SceneContextSectionId, type SceneContextSectionInput, type SceneRecallCorpusItem, type SceneRecallOmission, type SceneRecallCandidate, type SceneWorkingSet, type SceneRecallIndexResult, type SceneWorkingSetMessage, type SceneRecallRequiredFact, type SceneRecallCurrentSceneTail } from '../../shared/types'
import { sha256Text, stableSceneMemoryJson } from './sceneMemoryCard'
import { buildDeterministicRecallIndex, sceneRecallSourceCardSetHash, sceneRecallSourceSnapshotHash } from './recallIndex'
import { buildSceneContractPrompt, sceneContractValid } from './sceneContract'
import { codePointLength } from '../../shared/textMetrics'

export const SCENE_WORKING_SET_MIN_TOKENS = 3072
export const SCENE_WORKING_SET_MAX_TOKENS = 8192
export const SCENE_WORKING_SET_DEFAULT_TOKENS = 4096
export const SCENE_WORKING_SET_ESTIMATOR_VERSION = 'deepwriter-estimate-tokens-v1'
export const SCENE_PREVIOUS_ENDING_CHARS = 640

const HASH_RE = /^[0-9a-f]{64}$/u
const SECTION_ORDER: readonly SceneContextSectionId[] = [
  'hard_constraints',
  'scene_contract',
  'pov_state',
  'world_state',
  'causal_memories',
  'payoff',
  'exact_anchors',
  'recent_tail',
  'anti_repetition',
  'omitted'
]

export type SceneContextCompilerErrorCode =
  | 'scene_working_set_invalid_budget'
  | 'scene_working_set_required_overflow'
  | 'scene_working_set_required_source'
  | 'scene_working_set_recall_blocked'
  | 'scene_working_set_recall_mismatch'
  | 'scene_working_set_snapshot_mismatch'
  | 'scene_working_set_candidate_invalid'

export class SceneContextCompilerError extends Error {
  readonly code: SceneContextCompilerErrorCode

  constructor(code: SceneContextCompilerErrorCode, message: string = code) {
    super(message)
    this.name = 'SceneContextCompilerError'
    this.code = code
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableSceneMemoryJson(value), 'utf8').digest('hex')
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left)
  const rightPoints = Array.from(right)
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const delta = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!
    if (delta !== 0) return delta
  }
  return leftPoints.length - rightPoints.length
}

export function sceneRecallSourceSnapshotSetHash(corpus: readonly SceneRecallCorpusItem[]): string {
  return hash([...corpus].map((item) => ({ cardId: item.card.cardId, cardHash: item.card.cardHash, sourceSnapshotHash: item.authority.sourceSnapshotHash })).sort((left, right) => compareCodePoints(`${left.cardId}\u0000${left.cardHash}`, `${right.cardId}\u0000${right.cardHash}`)))
}

function text(value: string | readonly string[] | null | undefined): string {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).join('\n')
  return typeof value === 'string' ? value.trim() : ''
}

function contractData(contract: SceneContextCompilerInput['contract']): { contractId: string; contractHash: string; text: string; contentHash: string } {
  if (!sceneContractValid(contract)) throw new SceneContextCompilerError('scene_working_set_snapshot_mismatch', 'scene_working_set_contract_invalid')
  const prompt = buildSceneContractPrompt(contract)
  return { contractId: contract.contractId, contractHash: contract.frozenHash, text: prompt, contentHash: hash({ contractId: contract.contractId, contractHash: contract.frozenHash, text: prompt }) }
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value)
}

function prefix(prefixValue: readonly string[], value: readonly string[]): boolean {
  return prefixValue.length <= value.length && prefixValue.every((part, index) => part === value[index])
}

function assertRecallResult(input: SceneContextCompilerInput): SceneRecallIndexResult {
  let recomputed: SceneRecallIndexResult
  try {
    recomputed = buildDeterministicRecallIndex({ corpus: input.snapshot.corpus, query: input.recallQuery })
  } catch {
    throw new SceneContextCompilerError('scene_working_set_recall_mismatch')
  }
  if (stableSceneMemoryJson(recomputed) !== stableSceneMemoryJson(input.recall)) throw new SceneContextCompilerError('scene_working_set_recall_mismatch')
  return recomputed
}

function assertRequiredFacts(input: SceneContextCompilerInput): readonly SceneRecallRequiredFact[] {
  const facts = input.requiredFacts ?? []
  const queryFacts = input.recallQuery.requiredFacts ?? []
  if (stableSceneMemoryJson(facts) !== stableSceneMemoryJson(queryFacts)) throw new SceneContextCompilerError('scene_working_set_recall_mismatch', 'scene_working_set_required_fact_binding_mismatch')
  const seen = new Set<string>()
  for (const fact of facts) {
    if (!fact || typeof fact.requiredId !== 'string' || fact.requiredId.length === 0 || typeof fact.factId !== 'string' || fact.factId.length === 0 || !Number.isInteger(fact.version) || fact.version < 1 || typeof fact.canonicalStatement !== 'string' || fact.canonicalStatement.length === 0 || !validHash(fact.canonicalHash) || sha256Text(fact.canonicalStatement) !== fact.canonicalHash || !validHash(fact.provenanceHash) || !Array.isArray(fact.sourceSlotIds) || fact.sourceSlotIds.length === 0 || fact.sourceSlotIds.some((id) => typeof id !== 'string' || id.length === 0) || new Set(fact.sourceSlotIds).size !== fact.sourceSlotIds.length) throw new SceneContextCompilerError('scene_working_set_recall_mismatch', 'scene_working_set_required_fact_invalid')
    const key = `${fact.requiredId}\u0000${fact.factId}\u0000${fact.version}`
    if (seen.has(key)) throw new SceneContextCompilerError('scene_working_set_recall_mismatch', 'scene_working_set_required_fact_duplicate')
    seen.add(key)
  }
  return facts
}

function assertCurrentSceneTail(input: SceneContextCompilerInput): SceneRecallCurrentSceneTail | null {
  const tail = input.snapshot.currentSceneTail
  if (!tail) return null
  if (tail.schemaVersion !== 1 || tail.sceneId !== input.snapshot.sceneId || tail.contractHash !== input.contract.frozenHash || tail.closing !== undefined && tail.closing !== true || !validHash(tail.acceptedPrefixHash) || !validHash(tail.tailHash) || !Array.isArray(tail.segments)) {
    throw new SceneContextCompilerError('scene_working_set_snapshot_mismatch', 'scene_working_set_current_tail_invalid')
  }
  const seen = new Set<string>()
  for (const segment of tail.segments) {
    if (!segment || typeof segment.segmentId !== 'string' || segment.segmentId.length === 0 || seen.has(segment.segmentId) || segment.runId !== input.snapshot.runId || !(segment.sceneId === tail.sceneId || tail.closing === true && segment.sceneId === null) || segment.contractHash !== tail.contractHash || !['accepted', 'partial'].includes(segment.status) || typeof segment.content !== 'string' || !validHash(segment.contentHash) || sha256Text(segment.content) !== segment.contentHash || !validHash(segment.fullContentHash) || !Number.isInteger(segment.sourceStartCp) || segment.sourceStartCp < 0 || !Number.isInteger(segment.sourceEndCp) || segment.sourceEndCp <= segment.sourceStartCp || segment.sourceEndCp - segment.sourceStartCp !== codePointLength(segment.content) || !Number.isInteger(segment.charCount) || segment.sourceEndCp > segment.charCount || (segment.sourceStartCp === 0 && segment.sourceEndCp === segment.charCount && segment.fullContentHash !== segment.contentHash) || !Number.isInteger(segment.chunkIndex) || segment.chunkIndex < 0 || !Number.isInteger(segment.revision) || segment.revision < 1) {
      throw new SceneContextCompilerError('scene_working_set_snapshot_mismatch', 'scene_working_set_current_tail_invalid')
    }
    seen.add(segment.segmentId)
  }
  const expectedHash = hash({ schemaVersion: 1, sceneId: tail.sceneId, contractHash: tail.contractHash, ...(tail.closing ? { closing: true } : {}), acceptedPrefixHash: tail.acceptedPrefixHash, segments: tail.segments })
  if (expectedHash !== tail.tailHash) throw new SceneContextCompilerError('scene_working_set_snapshot_mismatch', 'scene_working_set_current_tail_hash_mismatch')
  return tail
}

function assertSnapshot(input: SceneContextCompilerInput): SceneRecallIndexResult {
  const { snapshot } = input
  const scope = snapshot.scope
  if (snapshot.schemaVersion !== 1 || !snapshot.runId || !snapshot.sceneId || snapshot.sceneId !== scope.sceneId || scope.expectedSourceCardSetHash !== snapshot.sourceCardSetHash || !validHash(snapshot.sourceSnapshotHash) || !validHash(snapshot.sourceCardSetHash) || sceneRecallSourceCardSetHash(snapshot.corpus) !== snapshot.sourceCardSetHash || sceneRecallSourceSnapshotSetHash(snapshot.corpus) !== snapshot.sourceSnapshotHash) {
    throw new SceneContextCompilerError('scene_working_set_snapshot_mismatch')
  }
  if (!Number.isInteger(scope.validityEpoch) || scope.validityEpoch < 1 || !Number.isInteger(scope.storyRevision) || scope.storyRevision < 0 || !Number.isInteger(scope.headRevision) || scope.headRevision < scope.storyRevision || !validHash(scope.headHash) || input.recallQuery.scope.storyId !== scope.storyId || input.recallQuery.scope.projectId !== scope.projectId || input.recallQuery.scope.branchId !== scope.branchId || input.recallQuery.scope.sceneId !== scope.sceneId || input.recallQuery.scope.validityEpoch !== scope.validityEpoch || input.recallQuery.scope.storyRevision !== scope.storyRevision || input.recallQuery.scope.headRevision !== scope.headRevision || input.recallQuery.scope.headHash !== scope.headHash || input.recallQuery.scope.expectedSourceCardSetHash !== snapshot.sourceCardSetHash) {
    throw new SceneContextCompilerError('scene_working_set_snapshot_mismatch')
  }
  const recomputed = assertRecallResult(input)
  assertRequiredFacts(input)
  assertCurrentSceneTail(input)
  if (recomputed.status === 'blocked_required_sources' || recomputed.blockedHardDependencies.length > 0) {
    throw new SceneContextCompilerError('scene_working_set_recall_blocked')
  }
  const byId = new Map<string, SceneRecallCorpusItem>()
  for (const item of snapshot.corpus) {
    const authority = item.authority
    const sameBranch = authority.branchId === scope.branchId
    if (byId.has(item.card.cardId) || item.card.status !== 'canonical' || item.stale === true || item.retracted === true || item.card.branchId !== authority.branchId || authority.storyId !== scope.storyId || authority.projectId !== scope.projectId || authority.validityEpoch !== scope.validityEpoch || authority.storyRevision > scope.storyRevision || authority.headRevision !== scope.headRevision || authority.headHash !== scope.headHash || authority.cardHash !== item.card.cardHash || !prefix(authority.branchLineage, scope.branchLineage) || (sameBranch ? authority.branchLineage.length !== scope.branchLineage.length : authority.branchLineage.length >= scope.branchLineage.length) || item.sourceValidated !== true || !Array.isArray(item.sourceSegments) || sceneRecallSourceSnapshotHash(item.card, item.sourceSegments) !== authority.sourceSnapshotHash) {
      throw new SceneContextCompilerError('scene_working_set_snapshot_mismatch')
    }
    byId.set(item.card.cardId, item)
  }
  const seen = new Set(recomputed.candidates.map((candidate) => candidate.cardId))
  for (const id of input.requiredCardIds ?? []) {
    if (!byId.has(id) || !seen.has(id)) throw new SceneContextCompilerError('scene_working_set_required_source', `scene_working_set_required_source:${id}`)
  }
  return recomputed
}

function normalizedClaim(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim()
}

function sourceSpanSupports(card: SceneRecallCandidate['card'], refs: readonly { kind: string; id: string; hash: string; spanId?: string }[] | undefined, claim: string | null | undefined): boolean {
  const normalized = typeof claim === 'string' ? normalizedClaim(claim) : ''
  if (!normalized || !Array.isArray(refs) || refs.length === 0) return false
  return refs.some((ref) => {
    if (ref.kind !== 'source_span' || !ref.spanId || ref.id !== ref.spanId) return false
    const span = card.sourceSpans.find((item) => item.spanId === ref.spanId)
    if (!span || ref.hash !== span.spanHash || sha256Text(span.text) !== span.spanHash) return false
    return normalizedClaim(span.text).includes(normalized)
  })
}

function scalarFieldSupports(card: SceneRecallCandidate['card'], field: string, value: string | null): boolean {
  if (!value || !card.fieldEvidence || typeof card.fieldEvidence !== 'object') return false
  const evidence = card.fieldEvidence
  const refs = [evidence[`${field}:${value}`], evidence[field]].find((item) => Array.isArray(item))
  return sourceSpanSupports(card, refs, value)
}

function sourceCardText(candidate: SceneRecallCandidate): { summary: string; anchors: string } {
  const card = candidate.card
  const summary = [
    scalarFieldSupports(card, 'dramaticQuestion', card.dramaticQuestion) ? `问题：${card.dramaticQuestion}` : '',
    scalarFieldSupports(card, 'decisiveAction', card.decisiveAction) ? `行动：${card.decisiveAction}` : '',
    scalarFieldSupports(card, 'turn', card.turn) ? `转折：${card.turn}` : '',
    scalarFieldSupports(card, 'cost', card.cost) ? `代价：${card.cost}` : '',
    card.factsEstablished.filter((item) => sourceSpanSupports(card, item.evidence, item.statement)).map((item) => `事实：${item.statement}`).join('\n'),
    card.threads.filter((item) => item.summary && sourceSpanSupports(card, item.evidence, item.summary)).map((item) => `线索：${item.summary}`).join('\n')
  ].filter(Boolean).join('\n')
  const spans = [...card.sourceSpans].sort((a, b) => a.startUtf16 - b.startUtf16 || a.endUtf16 - b.endUtf16 || compareCodePoints(a.spanId, b.spanId))
  const anchors = spans.map((span) => `【${span.spanId}】${span.text}`).join('\n')
  return { summary: summary || anchors, anchors }
}

function candidateSection(candidate: SceneRecallCandidate): SceneContextSectionId {
  if (candidate.reasonCodes.includes('hard_fact') || candidate.reasonCodes.includes('location_object')) return 'world_state'
  if (candidate.reasonCodes.includes('causal_parent')) return 'causal_memories'
  if (candidate.reasonCodes.includes('payoff_due') || candidate.reasonCodes.includes('open_thread')) return 'payoff'
  if (candidate.reasonCodes.includes('recent_tail')) return 'recent_tail'
  if (candidate.reasonCodes.includes('pov_knowledge') || candidate.reasonCodes.includes('active_entity')) return 'pov_state'
  return 'causal_memories'
}

function appendSection(map: Map<SceneContextSectionId, { requiredLines: string[]; optionalLines: string[]; requiredCardIds: string[]; optionalCardIds: string[] }>, id: SceneContextSectionId, line: string, cardId: string, required: boolean): void {
  const current = map.get(id) ?? { requiredLines: [], optionalLines: [], requiredCardIds: [], optionalCardIds: [] }
  const lines = required ? current.requiredLines : current.optionalLines
  const cardIds = required ? current.requiredCardIds : current.optionalCardIds
  lines.push(line)
  if (!cardIds.includes(cardId)) cardIds.push(cardId)
  map.set(id, current)
}

function renderSection(id: SceneContextSectionId, body: string): string {
  return `## ${id}\n${body || '（无）'}`
}

/** A scene opening needs its actual predecessor, not whichever old scene wins
 * semantic recall. Reuse the authenticated corpus and its prefilter decisions;
 * ranking/top-K may omit this small excerpt, but knowledge/branch/source
 * exclusions must never be bypassed. No additional persistent projection. */
function previousSceneEnding(input: SceneContextCompilerInput, recall: SceneRecallIndexResult, currentTail: SceneRecallCurrentSceneTail | null): { lines: string[]; cardIds: string[] } {
  // Once this scene has its own durable continuation, that bounded local tail
  // takes over. Do not stack another old-scene excerpt onto a 2K partial.
  if (currentTail?.segments.length) return { lines: [], cardIds: [] }
  const previous = input.snapshot.corpus.filter(item => item.card.runId === input.snapshot.runId && item.card.sceneOrder === input.contract.order - 1)
    .sort((a, b) => b.card.storyRevision - a.card.storyRevision || compareCodePoints(a.card.cardId, b.card.cardId))[0]
  if (!previous || recall.omitted.some(item => item.cardId === previous.card.cardId && item.reason !== 'budget_omitted')) return { lines: [], cardIds: [] }
  const selected = [...previous.sourceSegments!].sort((a, b) => b.chunkIndex - a.chunkIndex || b.segmentRevision - a.segmentRevision || compareCodePoints(b.segmentId, a.segmentId))
  const lines: string[] = []
  let remaining = SCENE_PREVIOUS_ENDING_CHARS
  for (const segment of selected.slice(0, 2)) {
    const points = Array.from(segment.content)
    if (!points.length) continue
    const start = Math.max(0, points.length - remaining)
    lines.unshift(`[previous-scene:${previous.card.sceneId} card:${previous.card.cardId} commit:${segment.commitManifestHash} segment:${segment.segmentId} revision:${segment.segmentRevision} source:${start}-${points.length}/${points.length}] ${points.slice(start).join('')}`)
    remaining -= points.length - start
    if (remaining === 0) break
  }
  return { lines, cardIds: lines.length ? [previous.card.cardId] : [] }
}

/**
 * Compile one immutable, auditable provider context.  This module is pure:
 * persistence and fence checks belong to Repository/runKernelAdapter, so a
 * caller can safely run it before making any provider request.
 */
export function compileSceneWorkingSet(input: SceneContextCompilerInput): SceneContextCompileResult {
  const recall = assertSnapshot(input)
  const requiredFacts = assertRequiredFacts(input)
  const currentSceneTail = assertCurrentSceneTail(input)
  const previousEnding = previousSceneEnding(input, recall, currentSceneTail)
  const budgetTokens = input.budgetTokens ?? SCENE_WORKING_SET_DEFAULT_TOKENS
  if (!Number.isInteger(budgetTokens) || budgetTokens < SCENE_WORKING_SET_MIN_TOKENS || budgetTokens > SCENE_WORKING_SET_MAX_TOKENS) throw new SceneContextCompilerError('scene_working_set_invalid_budget')
  const contract = contractData(input.contract)
  const requiredIds = new Set(input.requiredCardIds ?? [])
  const grouped = new Map<SceneContextSectionId, { requiredLines: string[]; optionalLines: string[]; requiredCardIds: string[]; optionalCardIds: string[] }>()
  for (const candidate of recall.candidates) {
    const rendered = sourceCardText(candidate)
    if (!rendered.summary && !rendered.anchors) throw new SceneContextCompilerError('scene_working_set_candidate_invalid', `scene_working_set_candidate_empty:${candidate.cardId}`)
    const id = candidateSection(candidate)
    const marker = `[${candidate.cardId}] ${rendered.summary}`
    appendSection(grouped, id, marker, candidate.cardId, requiredIds.has(candidate.cardId))
  }
  const anchors = recall.candidates.map((candidate) => {
    const rendered = sourceCardText(candidate)
    return rendered.anchors ? `[${candidate.cardId}]\n${rendered.anchors}` : ''
  }).filter(Boolean).join('\n')
  const anchorCardIds = recall.candidates.filter((candidate) => sourceCardText(candidate).anchors).map((candidate) => candidate.cardId)
  for (const id of ['pov_state', 'world_state', 'causal_memories', 'payoff', 'recent_tail'] as const) {
    if (input.sections?.[id]?.trim()) throw new SceneContextCompilerError('scene_working_set_snapshot_mismatch', 'scene_working_set_unbound_section')
  }
  const customRequired = new Map<SceneContextSectionId, SceneContextSectionInput>()
  for (const section of input.requiredSections ?? []) {
    if (!SECTION_ORDER.includes(section.id) || customRequired.has(section.id) || !['hard_constraints', 'scene_contract', 'exact_anchors'].includes(section.id)) throw new SceneContextCompilerError('scene_working_set_snapshot_mismatch', 'scene_working_set_required_section_unbound')
    if (section.id === 'exact_anchors' && (!section.sourceCardIds || section.sourceCardIds.length === 0 || section.sourceCardIds.some((cardId) => !recall.candidates.some((candidate) => candidate.cardId === cardId)) || !anchors.includes(section.text.trim()))) throw new SceneContextCompilerError('scene_working_set_snapshot_mismatch', 'scene_working_set_anchor_unbound')
    if (section.id === 'hard_constraints' && section.text.trim() !== text(input.hardConstraints)) throw new SceneContextCompilerError('scene_working_set_snapshot_mismatch', 'scene_working_set_hard_constraint_mismatch')
    if (section.id === 'scene_contract' && section.text.trim() !== contract.text.trim()) throw new SceneContextCompilerError('scene_working_set_snapshot_mismatch', 'scene_working_set_contract_mismatch')
    customRequired.set(section.id, section)
  }
  const hard = text(input.hardConstraints) || '（未提供硬约束；不得自行补写。）'
  if (input.sections?.exact_anchors?.trim() && !anchors.includes(input.sections.exact_anchors.trim())) throw new SceneContextCompilerError('scene_working_set_snapshot_mismatch', 'scene_working_set_anchor_unbound')
  const sectionEntries = SECTION_ORDER.map((id) => {
    const groupedSection = grouped.get(id) ?? { requiredLines: [], optionalLines: [], requiredCardIds: [], optionalCardIds: [] }
    const custom = customRequired.get(id)
    let requiredBody = ''
    let optionalBody = ''
    let required = false
    if (id === 'hard_constraints') {
      requiredBody = custom?.text.trim() || hard
      required = true
    } else if (id === 'scene_contract') {
      requiredBody = currentSceneTail?.closing
        ? `所有已确认场景均已提交；最后合同 ${contract.contractId} / ${contract.contractHash} 仅是已完成边界，不重新执行其推进点。\n本轮只承接 recent_tail，补全残句或用短小的自然尾声达到全稿目标；不要重写已接受正文、重新开场或重新执行旧场景。`
        : custom?.text.trim() || `合同 ${contract.contractId}\n${contract.text}`
      required = true
    } else if (id === 'exact_anchors') {
      requiredBody = custom?.text.trim() || ''
      optionalBody = custom ? '' : input.sections?.exact_anchors?.trim() || anchors
      required = Boolean(custom)
      if (!custom) groupedSection.optionalCardIds.push(...anchorCardIds.filter((cardId) => !groupedSection.optionalCardIds.includes(cardId)))
      else groupedSection.requiredCardIds.push(...custom.sourceCardIds!.filter((cardId) => !groupedSection.requiredCardIds.includes(cardId)))
    } else if (id === 'omitted') {
      const omittedText = recall.omitted.length > 0 ? recall.omitted.map((item) => `${item.cardId}: ${item.reason}`).join('\n') : '无'
      optionalBody = omittedText
    } else if (id === 'anti_repetition' && (previousEnding.lines.length || currentSceneTail?.segments.length)) {
      requiredBody = '接笔边界：previous-scene 是上一场已提交结尾；recent_tail 中标记 accepted 的是已收稿。承接结尾动作、人物位置、物件归属和时序，不重抄引用、不重新开场或重置既成状态。partial 仅供补全残句，不把未接受内容当作已发生事实；以本轮执行边界决定下一步。'
      optionalBody = input.sections?.anti_repetition?.trim() ?? ''
      required = true
    } else {
      const requiredFactLines = id === 'world_state'
        ? requiredFacts.map((fact) => `[fact:${fact.factId} source:${fact.requiredId} v${fact.version}] ${hard.startsWith('## 作者已确认的写作约定\n') && hard.includes(fact.canonicalStatement) ? '原话见上述作者约定（同一来源，不重复抄写）' : fact.canonicalStatement}\ncanonicalHash=${fact.canonicalHash}\nprovenanceHash=${fact.provenanceHash}`)
        : []
      const currentTailLines = id === 'recent_tail' && currentSceneTail
        ? currentSceneTail.segments.map((segment) => `[${currentSceneTail.closing ? 'manuscript-tail' : 'current-scene'}:${segment.segmentId} scene:${segment.sceneId ?? 'unscoped'} status:${segment.status} revision:${segment.revision} source:${segment.sourceStartCp}-${segment.sourceEndCp}/${segment.charCount} contentHash:${segment.contentHash} fullContentHash:${segment.fullContentHash}] ${segment.content}`)
        : []
      requiredBody = [...(id === 'recent_tail' ? previousEnding.lines : []), ...currentTailLines, ...requiredFactLines, ...groupedSection.requiredLines].join('\n')
      if (id === 'recent_tail') groupedSection.requiredCardIds.push(...previousEnding.cardIds)
      optionalBody = groupedSection.optionalLines.join('\n')
      const explicit = input.sections?.[id]
      if (explicit !== undefined && explicit.trim()) optionalBody = [optionalBody, `【未认证上下文：不得作为事实】\n${explicit.trim()}`].filter(Boolean).join('\n')
    }
    return { id, requiredBody, optionalBody, required: required || (id === 'world_state' && requiredFacts.length > 0) || (id === 'recent_tail' && (previousEnding.lines.length > 0 || currentSceneTail !== null && currentSceneTail.segments.length > 0)), requiredCardIds: groupedSection.requiredCardIds, optionalCardIds: groupedSection.optionalCardIds }
  })
  const requiredRendered = sectionEntries.filter((entry) => entry.requiredBody).map((entry) => renderSection(entry.id, entry.requiredBody))
  const requiredTokens = requiredRendered.reduce((sum, value) => sum + estimateTokens(value), 0)
  if (requiredTokens > budgetTokens) throw new SceneContextCompilerError('scene_working_set_required_overflow', `scene_working_set_required_overflow:${requiredTokens}>${budgetTokens}`)
  const omitted: SceneRecallOmission[] = [...recall.omitted]
  const selectedBodies = new Map<SceneContextSectionId, string>(sectionEntries.map((entry) => [entry.id, entry.requiredBody]))
  const selectedCardIds = new Map<SceneContextSectionId, string[]>(sectionEntries.map((entry) => [entry.id, [...entry.requiredCardIds]]))
  const omittedSections = new Set<SceneContextSectionId>()
  const selectedTokenEstimate = (): number => estimateTokens(sectionEntries.map((entry) => {
    const body = selectedBodies.get(entry.id) ?? ''
    return body ? renderSection(entry.id, body) : ''
  }).filter(Boolean).join('\n\n'))
  const optionalOrder = sectionEntries
  for (const entry of optionalOrder) {
    if (!entry.optionalBody) continue
    const combined = [entry.requiredBody, entry.optionalBody].filter(Boolean).join('\n')
    const previousBody = selectedBodies.get(entry.id) ?? ''
    selectedBodies.set(entry.id, combined)
    const candidateEstimate = selectedTokenEstimate()
    if (candidateEstimate <= budgetTokens) {
      selectedBodies.set(entry.id, combined)
      selectedCardIds.set(entry.id, [...(selectedCardIds.get(entry.id) ?? []), ...entry.optionalCardIds].filter((value, index, values) => values.indexOf(value) === index))
    } else {
      selectedBodies.set(entry.id, previousBody)
      omittedSections.add(entry.id)
      for (const cardId of entry.optionalCardIds) if (!omitted.some((item) => item.cardId === cardId)) omitted.push({ cardId, reason: 'budget_omitted' })
    }
  }
  const decisions: SceneContextSectionDecision[] = []
  const renderedSections: string[] = []
  for (const entry of sectionEntries) {
    const selectedBody = selectedBodies.get(entry.id) ?? ''
    const rendered = selectedBody ? renderSection(entry.id, selectedBody) : ''
    const tokens = rendered ? estimateTokens(rendered) : 0
    if (rendered) renderedSections.push(rendered)
    const sourceCardIds = selectedCardIds.get(entry.id) ?? []
    const omissionReason = omittedSections.has(entry.id) && entry.requiredBody.length === 0 ? 'budget_omitted' : null
    decisions.push({ id: entry.id, required: entry.required || entry.requiredCardIds.length > 0, included: Boolean(rendered), estimatedTokens: tokens, contentHash: hash(selectedBody), sourceCardIds, omissionReason })
  }
  const scope = input.snapshot.scope
  const identityCore = { runId: input.snapshot.runId, sceneId: input.snapshot.sceneId, storyId: scope.storyId, projectId: scope.projectId, branchId: scope.branchId, validityEpoch: scope.validityEpoch, storyRevision: scope.storyRevision, headRevision: scope.headRevision, headHash: scope.headHash, sourceSnapshotHash: input.snapshot.sourceSnapshotHash, sourceCardSetHash: input.snapshot.sourceCardSetHash, queryHash: recall.queryHash, indexHash: recall.indexHash, contractId: contract.contractId, contractHash: contract.contractHash, contractContentHash: contract.contentHash, budgetTokens, estimatorVersion: SCENE_WORKING_SET_ESTIMATOR_VERSION }
  const identity = currentSceneTail ? { ...identityCore, currentSceneTailHash: currentSceneTail.tailHash } : identityCore
  const content = renderedSections.join('\n\n')
  const used = estimateTokens(content)
  if (used > budgetTokens) throw new SceneContextCompilerError('scene_working_set_required_overflow', `scene_working_set_required_overflow:final:${used}>${budgetTokens}`)
  const workingSetMessageHash = hash([{ role: 'system', content }])
  const workingSetHash = hash({ identity, sections: decisions.map(({ id, required, included, contentHash, sourceCardIds, omissionReason }) => ({ id, required, included, contentHash, sourceCardIds, omissionReason })), omitted })
  const workingSetId = input.workingSetId ?? `ws_${hash({ ...identity, workingSetHash }).slice(0, 24)}`
  const manifestCore = { schemaVersion: 1 as const, ...identity, estimatedTokens: used, sections: decisions, omitted, workingSetHash, workingSetMessageHash }
  const manifestHash = hash(manifestCore)
  const manifest = { ...manifestCore, manifestHash }
  const workingSetMessage: SceneWorkingSetMessage = { schemaVersion: 1, runId: input.snapshot.runId, sceneId: input.snapshot.sceneId, manifestHash, messages: [{ role: 'system' as const, content }], messageHash: workingSetMessageHash }
  const workingSet: SceneWorkingSet = { schemaVersion: 1, workingSetId, ...identity, estimatedTokens: used, sections: decisions, omitted, workingSetHash, manifestHash, workingSetMessageHash, status: 'ready' }
  return { workingSet, manifest, workingSetMessage }
}

export const compileSceneContext = compileSceneWorkingSet
export const estimateSceneWorkingSetTokens = (content: string): number => estimateTokens(content)
export const sceneWorkingSetHash = (value: unknown): string => hash(value)
