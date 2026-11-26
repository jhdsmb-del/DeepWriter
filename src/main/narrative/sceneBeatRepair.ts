import { createHash } from 'node:crypto'
import type { ManuscriptSegment, SceneContract, SceneBeatRequirement } from '../../shared/types'
import type { SceneContractEvaluation } from './sceneContract'
import { isOpaqueSceneBeatRequirement } from './sceneContract'

/** This is a rewrite budget, never permission to accept or manufacture facts. */
export const SCENE_BEAT_REPAIR_MAX_ATTEMPTS = 2
export interface SceneBeatRepairRequest {
  runId: string
  sceneId: string
  contractHash: string
  candidateSegmentId: string
  candidateRevision: number
  candidateHash: string
  scenePrefixHash: string
  candidate: string
  scenePrefix: string
  missingBeatIds: string[]
  requestHash: string
}
export interface SceneBeatRepairLedger {
  schemaVersion: 1
  runId: string
  sceneId: string
  contractHash: string
  maxAttempts: 2
  attempts: Array<{ requestHash: string; candidateHash: string; scenePrefixHash: string; logicalCallId: string; reservedAt: number }>
  pending: SceneBeatRepairRequest | null
  hash: string
}
const digest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const hashValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
export const sceneBeatRepairEvidenceKind = (sceneId: string): string => `scene_beat_repair:${sceneId}`

const unknownAgent = /^(?:有人|某人|谁|他|她|它|他们|她们|对方|这人|那人|一个人)$/u
function requirementRepairable(beat: SceneBeatRequirement, knownAgents: Set<string>): boolean {
  if (isOpaqueSceneBeatRequirement(beat) || beat.negation || beat.modality !== 'actual' || beat.actuality !== 'asserted_actual' || beat.assertion !== 'asserted') return false
  // Empty agents/uncertain predicate scopes are not an authored action that a
  // writer can safely supply. The ordinary semantic review remains in charge.
  if (!(beat.agent ?? beat.actor).length || !(beat.eventGroups ?? []).length) return false
  if ((beat.agent ?? beat.actor).some(agent => unknownAgent.test(agent) || (/^(?:两人|二人|双方)$/u.test(agent) && knownAgents.size < 2))) return false
  return beat.eventGroups!.every(group => group.agent.length > 0 && !group.negation && group.actuality === 'asserted_actual' && group.assertion === 'asserted' && group.scope?.confidence === 'high')
}

export function sceneBeatRepairEligible(contract: SceneContract, evaluation: SceneContractEvaluation, complete: boolean): boolean {
  if (!complete || !evaluation.completed || evaluation.frozenHash !== contract.frozenHash || evaluation.sceneId !== contract.sceneId) return false
  const review = evaluation.semanticReview
  if ((review?.version === 1 || review?.version === 2) && review.contractHash === contract.frozenHash && review.scenePrefixHash === evaluation.scenePrefixHash && hashValid(review.candidateHash) &&
    review.unresolvedBeatIds.length > 0 && review.unresolvedBeatIds.every(id => contract.requiredBeatIds.includes(id))) {
    // Missing/invalid semantic evidence authorizes only the existing bounded
    // rewrite. It cannot erase a real contradiction or forbidden fact.
    return !evaluation.violations.some(item => !['missing_required_beat', 'beat_uncertain', 'beat_evidence_invalid', 'target_underflow', 'target_overflow', 'handoff_missing'].includes(item.code)) &&
      !(evaluation.beatEvidence ?? []).some(item => item.status === 'contradicted')
  }
  if (!evaluation.violations.some(item => item.code === 'missing_required_beat')) return false
  if (evaluation.violations.some(item => item.severity === 'blocking' || !['missing_required_beat', 'target_underflow', 'target_overflow', 'handoff_missing'].includes(item.code))) return false
  const evidence = evaluation.beatEvidence ?? []
  if (!evidence.length || evidence.some(item => item.status !== 'satisfied' && item.status !== 'missing')) return false
  const requirements = contract.requiredBeatEvidence ?? []
  const knownAgents = new Set(requirements.flatMap(beat => beat.agent ?? beat.actor).filter(agent => !unknownAgent.test(agent) && !/^(?:两人|二人|双方)$/u.test(agent)))
  const missing = evidence.filter(item => item.status === 'missing')
  return missing.length > 0 && missing.every(item => {
    const requirement = requirements.find(beat => beat.beatId === item.beatId)
    return requirement !== undefined && requirementRepairable(requirement, knownAgents)
  })
}

export function makeSceneBeatRepairRequest(contract: SceneContract, candidate: ManuscriptSegment, scenePrefix: string, evaluation: SceneContractEvaluation): SceneBeatRepairRequest {
  if (!sceneBeatRepairEligible(contract, evaluation, true) || candidate.status !== 'candidate' || candidate.sceneId !== contract.sceneId || candidate.contentHash !== digest(candidate.content) || evaluation.candidateHash !== digest(scenePrefix + candidate.content) || evaluation.scenePrefixHash !== digest(scenePrefix)) throw new Error('scene_beat_repair_binding_invalid')
  if (evaluation.semanticReview && evaluation.semanticReview.candidateHash !== candidate.contentHash) throw new Error('scene_beat_repair_binding_invalid')
  const base = {
    runId: candidate.runId, sceneId: contract.sceneId, contractHash: contract.frozenHash,
    candidateSegmentId: candidate.segmentId, candidateRevision: candidate.revision,
    candidateHash: candidate.contentHash, scenePrefixHash: digest(scenePrefix),
    candidate: candidate.content, scenePrefix,
    missingBeatIds: evaluation.semanticReview?.unresolvedBeatIds ?? (evaluation.beatEvidence ?? []).filter(item => item.status === 'missing').map(item => item.beatId)
  }
  return { ...base, requestHash: digest(base) }
}

function requestValid(request: SceneBeatRepairRequest, runId: string, contract: SceneContract): boolean {
  if (!request || request.runId !== runId || request.sceneId !== contract.sceneId || request.contractHash !== contract.frozenHash || typeof request.candidateSegmentId !== 'string' || !request.candidateSegmentId || !Number.isSafeInteger(request.candidateRevision) || request.candidateRevision < 1 || typeof request.candidate !== 'string' || typeof request.scenePrefix !== 'string' || !hashValid(request.candidateHash) || !hashValid(request.scenePrefixHash) || !Array.isArray(request.missingBeatIds) || !request.missingBeatIds.length || request.missingBeatIds.some(id => !contract.requiredBeatIds.includes(id))) return false
  const { requestHash, ...base } = request
  return requestHash === digest(base) && request.candidateHash === digest(request.candidate) && request.scenePrefixHash === digest(request.scenePrefix)
}

function seal(base: Omit<SceneBeatRepairLedger, 'hash'>): SceneBeatRepairLedger { return { ...base, hash: digest(base) } }
export function readSceneBeatRepairLedger(json: string | null | undefined, runId: string, contract: SceneContract): SceneBeatRepairLedger {
  if (json === null || json === undefined) return seal({ schemaVersion: 1, runId, sceneId: contract.sceneId, contractHash: contract.frozenHash, maxAttempts: SCENE_BEAT_REPAIR_MAX_ATTEMPTS, attempts: [], pending: null })
  let ledger: SceneBeatRepairLedger
  try { ledger = JSON.parse(json) as SceneBeatRepairLedger } catch { throw new Error('scene_beat_repair_ledger_invalid') }
  if (!ledger || ledger.schemaVersion !== 1 || ledger.runId !== runId || ledger.sceneId !== contract.sceneId || ledger.contractHash !== contract.frozenHash || ledger.maxAttempts !== SCENE_BEAT_REPAIR_MAX_ATTEMPTS || !Array.isArray(ledger.attempts) || ledger.attempts.length > ledger.maxAttempts) throw new Error('scene_beat_repair_ledger_invalid')
  const { hash, ...base } = ledger
  if (hash !== digest(base) || ledger.attempts.some(item => !hashValid(item.requestHash) || !hashValid(item.candidateHash) || !hashValid(item.scenePrefixHash) || typeof item.logicalCallId !== 'string' || !item.logicalCallId || !Number.isFinite(item.reservedAt)) || new Set(ledger.attempts.map(item => item.logicalCallId)).size !== ledger.attempts.length || (ledger.pending !== null && !requestValid(ledger.pending, runId, contract))) throw new Error('scene_beat_repair_ledger_invalid')
  return ledger
}

export function scheduleSceneBeatRepair(ledger: SceneBeatRepairLedger, request: SceneBeatRepairRequest): SceneBeatRepairLedger {
  if (ledger.attempts.length >= ledger.maxAttempts) throw new Error('scene_beat_repair_exhausted')
  if (ledger.pending && ledger.pending.requestHash !== request.requestHash) throw new Error('scene_beat_repair_pending_conflict')
  const { hash: _hash, ...base } = ledger
  return seal({ ...base, pending: request })
}

export function reserveSceneBeatRepair(ledger: SceneBeatRepairLedger, requestHash: string, logicalCallId: string, at: number): SceneBeatRepairLedger {
  if (ledger.attempts.some(item => item.logicalCallId === logicalCallId)) return ledger
  if (!ledger.pending || ledger.pending.requestHash !== requestHash) throw new Error('scene_beat_repair_pending_conflict')
  if (ledger.attempts.length >= ledger.maxAttempts) throw new Error('scene_beat_repair_exhausted')
  const { hash: _hash, ...base } = ledger
  const request = ledger.pending
  return seal({ ...base, pending: null, attempts: [...ledger.attempts, { requestHash, candidateHash: request.candidateHash, scenePrefixHash: request.scenePrefixHash, logicalCallId, reservedAt: at }] })
}

export function buildSceneBeatRepairPrompt(contract: SceneContract, request: SceneBeatRepairRequest): string {
  return [
    '[SceneContract 缺失推进点定向修订]',
    '下面是尚未被接受的原候选。请自然补足缺少的动作，返回完整修订候选，不是另接一段续写。',
    '保留原候选已经完成的动作、人物声音、事实、物品归属、时间和叙事风格；已接受前文逐字不改、也不要重复输出。',
    '不得把合同字面清单粘进正文，不得用关键词、总结说明或填充文字冒充真实行动。不得猜测行动者或未给出的初始事实。',
    '修订仍须重新通过文字审稿、场景证据和叙事状态校验；你不能声明任何 beat 已通过。只输出自然正文。',
    JSON.stringify({ requestHash: request.requestHash, contractHash: contract.frozenHash, scenePrefixHash: request.scenePrefixHash,
      candidateHash: request.candidateHash, candidateSegmentId: request.candidateSegmentId, candidateRevision: request.candidateRevision,
      missingBeats: request.missingBeatIds.map(id => ({ beatId: id, requirement: contract.requiredBeatEvidence!.find(beat => beat.beatId === id)!.source })),
      acceptedScenePrefix: request.scenePrefix, originalCandidate: request.candidate })
  ].join('\n')
}
