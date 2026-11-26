export const LONGFORM_WORKFLOW_SCHEMA_VERSION = 1 as const

/** Product stages are deliberately independent from low-level RunPhase. */
export const LONGFORM_WORKFLOW_STAGES = [
  'requirements',
  'outline',
  'scene_direction',
  'recall',
  'draft',
  'critique',
  'revision',
  'semantic_review',
  'commit',
  'reorientation',
  'export'
] as const

export type LongformWorkflowStage = (typeof LONGFORM_WORKFLOW_STAGES)[number]

/** Names used by the pre-v1.2.5 scene workbench. They are accepted at the
 * boundary and normalized before they enter the durable projection. */
export const LONGFORM_WORKFLOW_STAGE_ALIASES = {
  director: 'scene_direction',
  writing: 'draft',
  check: 'critique',
  review: 'semantic_review'
} as const

export type LongformWorkflowStageInput = LongformWorkflowStage | keyof typeof LONGFORM_WORKFLOW_STAGE_ALIASES

export type LongformWorkflowStageStatus =
  | 'locked'
  | 'ready'
  | 'running'
  | 'waiting_user'
  | 'blocked'
  | 'completed'
  | 'needs_recovery'
  | 'cancelled'

/** `draft`, `provider_failed`, and `export_failed` are workflow-level pause
 * labels. The stage remains authoritative in `stage`/`stageStatus`. */
export type LongformWorkflowStatus = LongformWorkflowStageStatus | 'draft' | 'provider_failed' | 'export_failed' | 'candidate' | 'review'

export interface LongformWorkflowRecallCandidate {
  cardId: string
  status?: string
  visibility?: string
  validityEpoch: number
  storyRevision?: number
  sceneId: string
  /** Stable source identity and content hash are surfaced in the audit. */
  source?: string | null
  hash?: string | null
}

/** Omission vocabulary is intentionally the same vocabulary emitted by the
 * repository-authenticated SceneRecallIndex.  Keeping the source reason
 * instead of collapsing everything to "invalid" makes a restart audit useful
 * to a human reviewer. */
export type LongformWorkflowRecallOmissionReason =
  | 'invalid_scope'
  | 'invalid_source'
  | 'stale'
  | 'retracted'
  | 'old_epoch'
  | 'future_revision'
  | 'current_scene'
  | 'already_injected'
  | 'knowledge_boundary'
  | 'unknown_hard_source'
  | 'legacy_unverified'
  | 'budget_omitted'
  | 'blocked_required_sources'

export interface LongformWorkflowRecallAuditEntry {
  cardId: string
  included: boolean
  reason: string | null
  reasonCode: LongformWorkflowRecallOmissionReason | null
  source: string | null
  hash: string | null
}

export interface LongformWorkflowRecallResult {
  included: string[]
  omitted: Array<{ cardId: string; reason: LongformWorkflowRecallOmissionReason; reasonText: string; source: string | null; hash: string | null }>
  audit: LongformWorkflowRecallAuditEntry[]
}

export type LongformWorkflowAction =
  | 'resolve_stage'
  | 'advance'
  | 'answer_requirements'
  | 'update_outline'
  | 'confirm_outline'
  | 'accept_candidate'
  | 'retry_provider'
  | 'retry_export'
  | 'approve_review'
  | 'accept_delta'
  | 'accept_unknown'
  | 'accept_prose_no_state'
  | 'reject_rewrite'
  | 'start_recall'
  | 'start_draft'
  | 'submit_candidate'
  | 'start_critique'
  | 'start_revision'
  /** Main-only semantic-review lifecycle projections. */
  | 'review_pending'
  | 'review_next_scene'
  | 'review_decision_applied'
  | 'review_rewrite'
  | 'review_abandon'
  | 'commit'
  | 'export'
  | 'reorient'
  | 'recover'
  | 'resume_draft'
  | 'stop'
  | 'abandon'

export type LongformRecoveryAction =
  | 'resume_draft'
  | 'retry_provider'
  | 'retry_export'
  | 'review_pending_operation'
  | 'rebase_story'
  | 'reopen_workflow'
  | 'abandon'

export type LongformPendingOperationStatus = 'pending' | 'applied' | 'failed'

export interface LongformPendingOperation {
  operationId: string
  action: LongformWorkflowAction
  expectedRevision: number
  canonicalPayloadHash: string
  status: LongformPendingOperationStatus
  startedAt: number
  finishedAt: number | null
  /** The main process may expose a human-readable failure code, but never a
   * provider secret or raw request body. */
  errorCode: string | null
}

export interface LongformWorkflowDraft {
  text: string
  contentHash: string
  segmentId?: string | null
  sceneId?: string | null
  savedAt: number
}

/** A semantic-review decision is the only authority that may open the
 * review -> commit gate.  Keeping the packet hash and revision together
 * prevents a decision id copied from one candidate from authorizing another. */
export interface LongformWorkflowDecisionFence {
  decisionId: string
  packetHash: string
  expectedRevision: number
  canonicalPayloadHash: string
}

/** Main-process-owned semantic-review fence.  The renderer may display this
 * evidence through the snapshot, but it cannot submit or alter it through
 * the generic workflow mutation IPC.  Keeping the packet identity and the
 * engine decision identity together makes review projection restart-safe. */
export type LongformSemanticReviewFenceStatus = 'pending' | 'accepted' | 'rewrite_requested' | 'abandoned' | 'failed'

export interface LongformSemanticReviewFence {
  runId: string
  sceneId: string
  candidateSegmentId: string
  candidateHash: string
  contractHash: string
  packetRevision: number
  packetHash: string
  decisionId: string | null
  decisionRevision: number | null
  decisionCanonicalPayloadHash: string | null
  decision: 'accept_delta' | 'accept_unknown' | 'accept_prose_no_state' | 'reject_rewrite' | 'abandon' | null
  status: LongformSemanticReviewFenceStatus
}

export interface LongformWorkflowSnapshot {
  schemaVersion: typeof LONGFORM_WORKFLOW_SCHEMA_VERSION
  kind: 'longform-workflow'
  workflowId: string
  storyId: string
  projectId: string
  branchId: string
  sessionId: string | null
  activeRunId: string | null
  chapterIndex: number | null
  sceneIndex: number | null
  sceneId: string | null
  stage: LongformWorkflowStage
  stageStatus: LongformWorkflowStageStatus
  /** Compatibility/readability alias for callers that render a single status. */
  status: LongformWorkflowStatus
  outlineRevision: number
  outlineHash: string | null
  contractRevision: number
  contractHash: string | null
  workingSetHash: string | null
  manifestHash: string | null
  validityEpoch: number
  candidateId: string | null
  acceptedSegmentId: string | null
  commitId: string | null
  pendingOperation: LongformPendingOperation | null
  allowedActions: LongformWorkflowAction[]
  blockedReason: string | null
  recoveryAction: LongformRecoveryAction | null
  authoritativeRevision: number
  eventSeq: number
  draft: LongformWorkflowDraft | null
  /** Null for workflows that have not crossed a narrative-review boundary. */
  reviewDecisionFence?: LongformWorkflowDecisionFence | null
  /** Main-only semantic-review packet/decision fence. */
  semanticReviewFence: LongformSemanticReviewFence | null
  /** Last deterministic recall decision; it is evidence, not a hidden prompt. */
  recallAudit: LongformWorkflowRecallResult | null
  /** Operation hashes are retained in the projection so replay after a
   * process restart has exactly the same idempotency result. */
  appliedOperations: Record<string, string>
  updatedAt: number
}

export interface LongformWorkflowCreateInput {
  workflowId: string
  storyId?: string
  projectId?: string
  branchId?: string
  sessionId?: string | null
  activeRunId?: string | null
  chapterIndex?: number | null
  sceneIndex?: number | null
  sceneId?: string | null
  validityEpoch?: number
  outlineRevision?: number
  outlineHash?: string | null
  contractRevision?: number
  contractHash?: string | null
  now?: number
}

export interface LongformWorkflowMutation {
  workflowId: string
  runId?: string | null
  /** Explicitly bind a pre-run workflow to a real persisted run. */
  activeRunId?: string | null
  storyId?: string
  projectId?: string
  branchId?: string
  sceneId?: string | null
  operationId: string
  /** Internal main-process projection marker; never exposed through renderer IPC. */
  mainOnly?: boolean
  /** Some existing callers call this `decisionId`; both names are hashed. */
  decisionId?: string | null
  action: LongformWorkflowAction
  expectedRevision: number
  targetStage?: LongformWorkflowStageInput
  targetStatus?: LongformWorkflowStatus
  contractHash?: string | null
  workingSetHash?: string | null
  manifestHash?: string | null
  validityEpoch?: number | null
  delta?: unknown
  note?: string | null
  payload?: unknown
  blockedReason?: string | null
  recoveryAction?: LongformRecoveryAction | null
  draft?: LongformWorkflowDraft | null
  reviewDecisionFence?: LongformWorkflowDecisionFence | null
  /** Internal main-process projection; never accepted from renderer IPC. */
  semanticReviewFence?: LongformSemanticReviewFence | null
  recallAudit?: LongformWorkflowRecallResult | null
  canonicalPayloadHash: string
}

export interface LongformWorkflowMutationInput extends Omit<LongformWorkflowMutation, 'canonicalPayloadHash'> {
  canonicalPayloadHash?: string
}

/** Renderer-facing mutation contract.  Internal projection fields (target
 * stage/status, run binding, hashes, audit, and recovery metadata) deliberately
 * do not exist in this type; the main process derives them from the durable
 * snapshot or from authenticated repository observers. */
export type LongformWorkflowPublicAction =
  | 'accept_candidate'
  | 'retry_provider'
  | 'retry_export'
  | 'recover'
  | 'resume_draft'
  | 'export'
  | 'reorient'

export interface LongformWorkflowPublicMutationInput {
  workflowId: string
  operationId: string
  decisionId?: string | null
  action: LongformWorkflowPublicAction
  expectedRevision: number
  delta?: unknown
  note?: string | null
  payload?: unknown
}

export interface LongformWorkflowMutationResult {
  snapshot: LongformWorkflowSnapshot
  idempotent: boolean
}

export interface LongformWorkflowActionCapability {
  allowed: boolean
  disabledReason: string | null
}

export type LongformWorkflowActionCapabilities = Partial<Record<LongformWorkflowAction, LongformWorkflowActionCapability>>

export class LongformWorkflowError extends Error {
  readonly code: string

  constructor(code: string, message = code) {
    super(message)
    this.name = 'LongformWorkflowError'
    this.code = code
  }
}

const HASH_RE = /^[0-9a-f]{64}$/u
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u
const ACTIONS = new Set<LongformWorkflowAction>([
  'resolve_stage', 'advance', 'answer_requirements', 'update_outline', 'confirm_outline',
  'accept_candidate', 'retry_provider', 'retry_export', 'approve_review', 'accept_delta',
  'accept_unknown', 'accept_prose_no_state', 'reject_rewrite', 'start_recall', 'start_draft',
  'submit_candidate', 'start_critique', 'start_revision', 'review_pending', 'review_next_scene', 'review_decision_applied',
  'review_rewrite', 'review_abandon', 'commit', 'export', 'reorient',
  'recover', 'resume_draft', 'stop', 'abandon'
])

const STAGE_STATUS = new Set<LongformWorkflowStageStatus>(['locked', 'ready', 'running', 'waiting_user', 'blocked', 'completed', 'needs_recovery', 'cancelled'])
const WORKFLOW_STATUS = new Set<LongformWorkflowStatus>([...STAGE_STATUS, 'draft', 'provider_failed', 'export_failed', 'candidate', 'review'])
const RECOVERY_ACTIONS = new Set<LongformRecoveryAction>(['resume_draft', 'retry_provider', 'retry_export', 'review_pending_operation', 'rebase_story', 'reopen_workflow', 'abandon'])

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new LongformWorkflowError('longform_payload_non_finite')
    if (typeof value === 'undefined') throw new LongformWorkflowError('longform_payload_undefined')
    return value
  }
  if (seen.has(value)) throw new LongformWorkflowError('longform_payload_cycle')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => stableValue(item, seen))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new LongformWorkflowError('longform_payload_non_plain_object')
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort(compareKeys).map((key) => [key, stableValue((value as Record<string, unknown>)[key], seen)]))
  } finally {
    seen.delete(value)
  }
}

/** Canonical JSON is shared by IPC and main so hashes do not depend on key order. */
export function stableLongformWorkflowJson(value: unknown): string {
  return JSON.stringify(stableValue(value)) ?? 'null'
}

/** Small synchronous SHA-256 implementation so this shared contract can run
 * in both preload/renderer and Node without importing a Node-only module. */
function sha256Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const words = new Uint32Array(64)
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
    0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
    0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
    0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]
  const bitLength = bytes.length * 8
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const high = Math.floor(bitLength / 0x100000000)
  const low = bitLength >>> 0
  padded[paddedLength - 8] = high >>> 24
  padded[paddedLength - 7] = high >>> 16
  padded[paddedLength - 6] = high >>> 8
  padded[paddedLength - 5] = high
  padded[paddedLength - 4] = low >>> 24
  padded[paddedLength - 3] = low >>> 16
  padded[paddedLength - 2] = low >>> 8
  padded[paddedLength - 1] = low
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4
      words[index] = ((padded[at]! << 24) | (padded[at + 1]! << 16) | (padded[at + 2]! << 8) | padded[at + 3]!) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const lower = (rotr(words[index - 15]!, 7) ^ rotr(words[index - 15]!, 18) ^ (words[index - 15]! >>> 3)) >>> 0
      const upper = (rotr(words[index - 2]!, 17) ^ rotr(words[index - 2]!, 19) ^ (words[index - 2]! >>> 10)) >>> 0
      words[index] = (words[index - 16]! + lower + words[index - 7]! + upper) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const choice = ((e & f) ^ (~e & g)) >>> 0
      const temp1 = (h + sigma1 + choice + k[index]! + words[index]!) >>> 0
      const sigma0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const temp2 = (sigma0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    hash[0] = (hash[0]! + a) >>> 0
    hash[1] = (hash[1]! + b) >>> 0
    hash[2] = (hash[2]! + c) >>> 0
    hash[3] = (hash[3]! + d) >>> 0
    hash[4] = (hash[4]! + e) >>> 0
    hash[5] = (hash[5]! + f) >>> 0
    hash[6] = (hash[6]! + g) >>> 0
    hash[7] = (hash[7]! + h) >>> 0
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join('')
}

export function longformWorkflowHash(value: unknown): string {
  return sha256Utf8(stableLongformWorkflowJson(value))
}

export function normalizeLongformWorkflowStage(value: unknown): LongformWorkflowStage {
  if (typeof value !== 'string') throw new LongformWorkflowError('longform_stage_invalid')
  const alias = (LONGFORM_WORKFLOW_STAGE_ALIASES as Record<string, LongformWorkflowStage | undefined>)[value]
  const normalized = alias ?? value
  if (!(LONGFORM_WORKFLOW_STAGES as readonly string[]).includes(normalized)) throw new LongformWorkflowError('longform_stage_invalid')
  return normalized as LongformWorkflowStage
}

export function nextLongformWorkflowStage(stage: LongformWorkflowStageInput): LongformWorkflowStage | null {
  const normalized = normalizeLongformWorkflowStage(stage)
  const index = LONGFORM_WORKFLOW_STAGES.indexOf(normalized)
  return index >= 0 && index + 1 < LONGFORM_WORKFLOW_STAGES.length ? LONGFORM_WORKFLOW_STAGES[index + 1]! : null
}

const recallReasonText: Record<LongformWorkflowRecallOmissionReason, string> = {
  invalid_scope: '来源卡的召回范围校验失败',
  invalid_source: '来源卡缺少可审计的有效来源身份',
  stale: '来源卡已标记为过期',
  retracted: '来源卡已撤回',
  old_epoch: '来源卡属于旧故事有效性世代',
  current_scene: '来源卡属于当前场景，避免自我回忆污染',
  future_revision: '来源卡来自当前故事头之后的未来修订',
  already_injected: '来源卡已在当前上下文中注入',
  knowledge_boundary: '来源卡超出当前视角的知识边界',
  unknown_hard_source: '必需来源卡未能在权威语料中解析',
  legacy_unverified: '来源卡是未验证的旧格式数据',
  budget_omitted: '来源卡因上下文预算被省略',
  blocked_required_sources: '必需来源卡校验失败，召回被阻断'
}

/** Deterministic recall gate shared by main and preload-facing callers.  Every
 * omission carries both a machine reason and the exact source/hash evidence,
 * so the selected context can be audited after a restart. */
export function selectLongformWorkflowRecall(
  cards: readonly LongformWorkflowRecallCandidate[],
  validityEpoch: number,
  currentSceneId: string,
  storyRevision?: number
): LongformWorkflowRecallResult {
  if (!Number.isInteger(validityEpoch) || validityEpoch < 1 || !validId(currentSceneId)) throw new LongformWorkflowError('longform_recall_scope_invalid')
  if (storyRevision !== undefined && (!Number.isInteger(storyRevision) || storyRevision < 0)) throw new LongformWorkflowError('longform_recall_revision_invalid')
  const included: string[] = []
  const omitted: LongformWorkflowRecallResult['omitted'] = []
  const audit: LongformWorkflowRecallAuditEntry[] = []
  for (const card of cards) {
    const cardId = typeof card?.cardId === 'string' ? card.cardId : ''
    const source = typeof card?.source === 'string' && card.source.length > 0 ? card.source : cardId || null
    const hash = typeof card?.hash === 'string' && card.hash.length > 0 ? card.hash : null
    let reasonCode: LongformWorkflowRecallOmissionReason | null = null
    if (!cardId || !validId(cardId) || !source || typeof card.sceneId !== 'string' || !card.sceneId || !Number.isInteger(card.validityEpoch) || card.validityEpoch < 1) reasonCode = 'invalid_source'
    else if (card.visibility === 'stale') reasonCode = 'stale'
    else if (card.visibility === 'retracted') reasonCode = 'retracted'
    else if (card.validityEpoch !== validityEpoch) reasonCode = 'old_epoch'
    else if (card.sceneId === currentSceneId) reasonCode = 'current_scene'
    else if (storyRevision !== undefined && card.storyRevision !== undefined && (!Number.isInteger(card.storyRevision) || card.storyRevision > storyRevision)) reasonCode = 'future_revision'
    else if (!hash || !HASH_RE.test(hash)) reasonCode = 'invalid_source'
    else if (card.status !== undefined && card.status !== 'canonical') reasonCode = 'invalid_source'
    if (reasonCode) {
      omitted.push({ cardId: cardId || '(unknown)', reason: reasonCode, reasonText: recallReasonText[reasonCode], source, hash })
      audit.push({ cardId: cardId || '(unknown)', included: false, reason: recallReasonText[reasonCode], reasonCode, source, hash })
    } else {
      included.push(cardId)
      audit.push({ cardId, included: true, reason: null, reasonCode: null, source, hash })
    }
  }
  return { included, omitted, audit }
}

/** Compatibility aliases for existing recall callers and audit discovery. */
export const longformWorkflowRecallAudit = selectLongformWorkflowRecall
export const selectRecall = selectLongformWorkflowRecall
export const recallSelect = selectLongformWorkflowRecall

/**
 * Project the *real* repository recall/index result into the durable workflow
 * snapshot.  This is deliberately separate from the small boundary selector
 * above: production callers pass the Scene Working Set's authenticated corpus
 * and deterministic index result, so an included card must carry both a
 * stable source identity and the card's cryptographic hash.  A malformed
 * candidate is fail-closed into an auditable omission rather than becoming
 * untraceable prompt context.
 */
export function projectLongformWorkflowRecallAudit(input: {
  recall: import('./types').SceneRecallIndexResult
  corpus: readonly import('./types').SceneRecallCorpusItem[]
}): LongformWorkflowRecallResult {
  const byId = new Map(input.corpus.map((item) => [item.card.cardId, item]))
  const included: string[] = []
  const omitted: LongformWorkflowRecallResult['omitted'] = []
  const audit: LongformWorkflowRecallAuditEntry[] = []
  const evidenceFor = (cardId: string): { source: string | null; hash: string | null } => {
    const item = byId.get(cardId)
    const source = typeof item?.card.cardId === 'string' && item.card.cardId.length > 0 ? item.card.cardId : null
    const hash = typeof item?.card.cardHash === 'string' && HASH_RE.test(item.card.cardHash) ? item.card.cardHash : null
    return { source, hash }
  }
  const addOmission = (cardId: string, reason: LongformWorkflowRecallOmissionReason, source: string | null, hash: string | null): void => {
    const safeId = validId(cardId) ? cardId : '(unknown)'
    omitted.push({ cardId: safeId, reason, reasonText: recallReasonText[reason], source, hash })
    audit.push({ cardId: safeId, included: false, reason: recallReasonText[reason], reasonCode: reason, source, hash })
  }
  for (const candidate of input.recall.candidates) {
    const cardId = typeof candidate?.cardId === 'string' ? candidate.cardId : ''
    const evidence = evidenceFor(cardId)
    // A candidate reaching this function should have been validated by the
    // SceneRecallIndex.  Still enforce the production audit contract here so a
    // future adapter cannot silently persist an unbound source.
    if (!validId(cardId) || !evidence.source || !evidence.hash) {
      addOmission(cardId, 'invalid_source', evidence.source, evidence.hash)
      continue
    }
    included.push(cardId)
    audit.push({ cardId, included: true, reason: null, reasonCode: null, source: evidence.source, hash: evidence.hash })
  }
  for (const item of input.recall.omitted) {
    const cardId = typeof item?.cardId === 'string' ? item.cardId : ''
    const evidence = evidenceFor(cardId)
    const reason = ['invalid_scope', 'invalid_source', 'stale', 'retracted', 'old_epoch', 'future_revision', 'current_scene', 'already_injected', 'knowledge_boundary', 'unknown_hard_source', 'legacy_unverified', 'budget_omitted', 'blocked_required_sources'].includes(item?.reason)
      ? item.reason as LongformWorkflowRecallOmissionReason
      : 'invalid_source'
    addOmission(cardId, reason, evidence.source, evidence.hash)
  }
  return { included, omitted, audit }
}

function copyJson<T>(value: T): T {
  return JSON.parse(stableLongformWorkflowJson(value)) as T
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

function validHash(value: unknown): boolean {
  return value === null || value === undefined || typeof value === 'string' && HASH_RE.test(value)
}

function normalizeOptionalHash(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw new LongformWorkflowError(code)
  return value
}

function normalizeStatus(value: unknown, fallback: LongformWorkflowStatus): LongformWorkflowStatus {
  const candidate = value ?? fallback
  if (typeof candidate !== 'string' || !WORKFLOW_STATUS.has(candidate as LongformWorkflowStatus)) throw new LongformWorkflowError('longform_status_invalid')
  return candidate as LongformWorkflowStatus
}

function normalizeStageStatus(value: unknown, fallback: LongformWorkflowStageStatus): LongformWorkflowStageStatus {
  const candidate = value ?? fallback
  if (typeof candidate !== 'string' || !STAGE_STATUS.has(candidate as LongformWorkflowStageStatus)) throw new LongformWorkflowError('longform_stage_status_invalid')
  return candidate as LongformWorkflowStageStatus
}

function normalizeAction(value: unknown): LongformWorkflowAction {
  if (typeof value !== 'string' || !ACTIONS.has(value as LongformWorkflowAction)) throw new LongformWorkflowError('longform_action_invalid')
  return value as LongformWorkflowAction
}

function actionListFor(stage: LongformWorkflowStage, status: LongformWorkflowStatus): LongformWorkflowAction[] {
  if (status === 'completed' || status === 'cancelled') return []
  if (status === 'draft') return ['resume_draft', 'stop']
  if (status === 'provider_failed' || status === 'blocked' && stage !== 'export') return ['retry_provider', 'stop']
  if (status === 'export_failed') return ['retry_export', 'stop']
  if (status === 'needs_recovery') return ['recover', 'stop']
  if (status === 'candidate') return ['accept_candidate', 'stop']
  if (status === 'review') return ['approve_review', 'accept_delta', 'accept_unknown', 'accept_prose_no_state', 'reject_rewrite', 'stop']
  if (stage === 'export') return ['export', 'stop']
  if (stage === 'semantic_review') return ['approve_review', 'accept_delta', 'accept_unknown', 'accept_prose_no_state', 'reject_rewrite', 'stop']
  if (stage === 'commit') return ['commit', 'stop']
  if (stage === 'reorientation') return ['reorient', 'stop']
  if (stage === 'recall') return ['start_recall', 'stop']
  if (stage === 'draft') return ['start_draft', 'stop']
  if (stage === 'critique') return ['start_critique', 'stop']
  if (stage === 'revision') return ['start_revision', 'stop']
  return ['resolve_stage', 'stop']
}

export function allowedLongformWorkflowActions(snapshot: Pick<LongformWorkflowSnapshot, 'stage' | 'status' | 'stageStatus'>): LongformWorkflowAction[] {
  // Keep the durable alias/status projection deterministic. The short status
  // values ('candidate', 'review') are accepted for old callers even though
  // the canonical stageStatus remains a documented WorkflowStageStatus.
  return actionListFor(snapshot.stage, snapshot.status)
}

function deriveStageStatus(status: LongformWorkflowStatus): LongformWorkflowStageStatus {
  if (status === 'draft') return 'waiting_user'
  if (status === 'provider_failed' || status === 'export_failed') return 'blocked'
  if (status === 'candidate' || status === 'review') return 'waiting_user'
  if (STAGE_STATUS.has(status as LongformWorkflowStageStatus)) return status as LongformWorkflowStageStatus
  return 'waiting_user'
}

function normalizeDraft(value: unknown, now: number): LongformWorkflowDraft | null {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LongformWorkflowError('longform_draft_invalid')
  const draft = value as Record<string, unknown>
  if (typeof draft.text !== 'string' || typeof draft.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(draft.contentHash) || draft.contentHash !== longformWorkflowHash(draft.text)) throw new LongformWorkflowError('longform_draft_invalid')
  return {
    text: draft.text,
    contentHash: draft.contentHash,
    ...(draft.segmentId === undefined ? {} : { segmentId: draft.segmentId === null ? null : String(draft.segmentId) }),
    ...(draft.sceneId === undefined ? {} : { sceneId: draft.sceneId === null ? null : String(draft.sceneId) }),
    savedAt: typeof draft.savedAt === 'number' && Number.isFinite(draft.savedAt) ? draft.savedAt : now
  }
}

function normalizeDecisionFence(value: unknown): LongformWorkflowDecisionFence | null {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LongformWorkflowError('longform_review_fence_invalid')
  const fence = value as Record<string, unknown>
  if (!validId(fence.decisionId) || typeof fence.packetHash !== 'string' || !HASH_RE.test(fence.packetHash) ||
    !Number.isInteger(fence.expectedRevision) || (fence.expectedRevision as number) < 1 ||
    typeof fence.canonicalPayloadHash !== 'string' || !HASH_RE.test(fence.canonicalPayloadHash)) throw new LongformWorkflowError('longform_review_fence_invalid')
  return {
    decisionId: fence.decisionId,
    packetHash: fence.packetHash,
    expectedRevision: fence.expectedRevision as number,
    canonicalPayloadHash: fence.canonicalPayloadHash
  }
}

function normalizeSemanticReviewFence(value: unknown): LongformSemanticReviewFence | null {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LongformWorkflowError('longform_semantic_review_fence_invalid')
  const fence = value as Record<string, unknown>
  const decisions = ['accept_delta', 'accept_unknown', 'accept_prose_no_state', 'reject_rewrite', 'abandon'] as const
  const statuses = ['pending', 'accepted', 'rewrite_requested', 'abandoned', 'failed'] as const
  if (!validId(fence.runId) || !validId(fence.sceneId) || !validId(fence.candidateSegmentId) ||
    typeof fence.candidateHash !== 'string' || !HASH_RE.test(fence.candidateHash) ||
    typeof fence.contractHash !== 'string' || !HASH_RE.test(fence.contractHash) ||
    !Number.isInteger(fence.packetRevision) || (fence.packetRevision as number) < 1 ||
    typeof fence.packetHash !== 'string' || !HASH_RE.test(fence.packetHash) ||
    fence.decisionId !== null && fence.decisionId !== undefined && !validId(fence.decisionId) ||
    fence.decisionRevision !== null && fence.decisionRevision !== undefined && (!Number.isInteger(fence.decisionRevision) || (fence.decisionRevision as number) < 1) ||
    fence.decisionCanonicalPayloadHash !== null && fence.decisionCanonicalPayloadHash !== undefined && (typeof fence.decisionCanonicalPayloadHash !== 'string' || !HASH_RE.test(fence.decisionCanonicalPayloadHash)) ||
    fence.decision !== null && fence.decision !== undefined && !decisions.includes(fence.decision as typeof decisions[number]) ||
    !statuses.includes(fence.status as typeof statuses[number])) throw new LongformWorkflowError('longform_semantic_review_fence_invalid')
  const status = fence.status as LongformSemanticReviewFenceStatus
  const decisionId = fence.decisionId === undefined ? null : fence.decisionId as string | null
  const decisionRevision = fence.decisionRevision === undefined ? null : fence.decisionRevision as number | null
  const decisionCanonicalPayloadHash = fence.decisionCanonicalPayloadHash === undefined ? null : fence.decisionCanonicalPayloadHash as string | null
  const decision = fence.decision === undefined ? null : fence.decision as LongformSemanticReviewFence['decision']
  if (status === 'pending' && (decisionId === null || decisionRevision !== null || decisionCanonicalPayloadHash !== null || decision !== null)) throw new LongformWorkflowError('longform_semantic_review_fence_invalid')
  if (status !== 'pending' && (decisionId === null || decisionRevision === null || decisionCanonicalPayloadHash === null || decision === null)) throw new LongformWorkflowError('longform_semantic_review_fence_invalid')
  return {
    runId: fence.runId,
    sceneId: fence.sceneId,
    candidateSegmentId: fence.candidateSegmentId,
    candidateHash: fence.candidateHash,
    contractHash: fence.contractHash,
    packetRevision: fence.packetRevision as number,
    packetHash: fence.packetHash,
    decisionId,
    decisionRevision,
    decisionCanonicalPayloadHash,
    decision,
    status
  }
}

function normalizeRecallAudit(value: unknown): LongformWorkflowRecallResult | null {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LongformWorkflowError('longform_recall_audit_invalid')
  const raw = value as Partial<LongformWorkflowRecallResult>
  if (!Array.isArray(raw.included) || raw.included.some((id) => !validId(id)) || !Array.isArray(raw.omitted) || !Array.isArray(raw.audit)) throw new LongformWorkflowError('longform_recall_audit_invalid')
  const recallReasons = ['invalid_scope', 'invalid_source', 'stale', 'retracted', 'old_epoch', 'future_revision', 'current_scene', 'already_injected', 'knowledge_boundary', 'unknown_hard_source', 'legacy_unverified', 'budget_omitted', 'blocked_required_sources'] as const
  for (const item of raw.omitted) {
    if (!item || typeof item !== 'object' || !validId(item.cardId) && item.cardId !== '(unknown)' || !recallReasons.includes(item.reason as typeof recallReasons[number]) || typeof item.reasonText !== 'string' || item.reasonText.length === 0 || item.source !== null && typeof item.source !== 'string' || item.hash !== null && (typeof item.hash !== 'string' || !HASH_RE.test(item.hash))) throw new LongformWorkflowError('longform_recall_audit_invalid')
  }
  for (const item of raw.audit) {
    if (!item || typeof item !== 'object' || !validId(item.cardId) && item.cardId !== '(unknown)' || typeof item.included !== 'boolean' || item.reason !== null && typeof item.reason !== 'string' || item.reasonCode !== null && !recallReasons.includes(item.reasonCode as typeof recallReasons[number]) || item.source !== null && typeof item.source !== 'string' || item.hash !== null && (typeof item.hash !== 'string' || !HASH_RE.test(item.hash)) || item.included && (typeof item.source !== 'string' || !HASH_RE.test(item.hash ?? ''))) throw new LongformWorkflowError('longform_recall_audit_invalid')
  }
  return copyJson(raw as LongformWorkflowRecallResult)
}

export function createLongformWorkflowSnapshot(input: LongformWorkflowCreateInput): LongformWorkflowSnapshot {
  if (!validId(input.workflowId)) throw new LongformWorkflowError('longform_workflow_id_invalid')
  const storyId = input.storyId ?? `story_${input.workflowId}`
  const projectId = input.projectId ?? `project_${input.workflowId}`
  const branchId = input.branchId ?? 'main'
  if (!validId(storyId) || !validId(projectId) || !validId(branchId)) throw new LongformWorkflowError('longform_scope_invalid')
  const now = input.now ?? Date.now()
  if (!Number.isFinite(now)) throw new LongformWorkflowError('longform_timestamp_invalid')
  const snapshot: LongformWorkflowSnapshot = {
    schemaVersion: LONGFORM_WORKFLOW_SCHEMA_VERSION,
    kind: 'longform-workflow',
    workflowId: input.workflowId,
    storyId,
    projectId,
    branchId,
    sessionId: input.sessionId ?? null,
    activeRunId: input.activeRunId ?? null,
    chapterIndex: input.chapterIndex ?? null,
    sceneIndex: input.sceneIndex ?? null,
    sceneId: input.sceneId ?? null,
    stage: 'requirements',
    stageStatus: 'ready',
    status: 'ready',
    outlineRevision: input.outlineRevision ?? 0,
    outlineHash: normalizeOptionalHash(input.outlineHash, 'longform_outline_hash_invalid'),
    contractRevision: input.contractRevision ?? 0,
    contractHash: normalizeOptionalHash(input.contractHash, 'longform_contract_hash_invalid'),
    workingSetHash: null,
    manifestHash: null,
    validityEpoch: input.validityEpoch ?? 1,
    candidateId: null,
    acceptedSegmentId: null,
    commitId: null,
    pendingOperation: null,
    allowedActions: ['resolve_stage', 'stop'],
    blockedReason: null,
    recoveryAction: null,
    authoritativeRevision: 0,
    eventSeq: 0,
    draft: null,
    reviewDecisionFence: null,
    semanticReviewFence: null,
    recallAudit: null,
    appliedOperations: {},
    updatedAt: now
  }
  if (!Number.isInteger(snapshot.validityEpoch) || snapshot.validityEpoch < 1 || !Number.isInteger(snapshot.outlineRevision) || snapshot.outlineRevision < 0 || !Number.isInteger(snapshot.contractRevision) || snapshot.contractRevision < 0) throw new LongformWorkflowError('longform_revision_invalid')
  return snapshot
}

/** Full mutation payload hash. Do not reduce this to `payload`/`delta`: all
 * operation identity and optimistic-concurrency fields are included. */
export function longformMutationCanonicalPayload(input: LongformWorkflowMutationInput | LongformWorkflowMutation): Record<string, unknown> {
  const value = input as unknown as Record<string, unknown>
  const rest = Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== 'canonicalPayloadHash' && item !== undefined))
  return { schemaVersion: LONGFORM_WORKFLOW_SCHEMA_VERSION, ...rest }
}

export function longformMutationPayloadHash(input: LongformWorkflowMutationInput | LongformWorkflowMutation): string {
  return longformWorkflowHash(longformMutationCanonicalPayload(input))
}

export function buildLongformWorkflowMutation(input: LongformWorkflowMutationInput): LongformWorkflowMutation {
  const operationId = input.operationId
  if (!validId(input.workflowId) || !validId(operationId)) throw new LongformWorkflowError('longform_mutation_identity_invalid')
  if (input.decisionId !== undefined && input.decisionId !== null && !validId(input.decisionId)) throw new LongformWorkflowError('longform_decision_id_invalid')
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new LongformWorkflowError('longform_revision_invalid')
  const action = normalizeAction(input.action)
  const candidate: LongformWorkflowMutation = {
    ...input,
    workflowId: input.workflowId,
    operationId,
    action,
    canonicalPayloadHash: ''
  }
  const computed = longformMutationPayloadHash(candidate)
  if (input.canonicalPayloadHash !== undefined && input.canonicalPayloadHash !== computed) throw new LongformWorkflowError('longform_payload_hash_mismatch')
  candidate.canonicalPayloadHash = computed
  return candidate
}

function assertMutation(input: LongformWorkflowMutation): LongformWorkflowMutation {
  const candidate = buildLongformWorkflowMutation(input)
  if (!HASH_RE.test(candidate.canonicalPayloadHash)) throw new LongformWorkflowError('longform_payload_hash_invalid')
  return candidate
}

function isCandidateStatus(value: LongformWorkflowStatus): boolean {
  return value === 'candidate' || value === 'review'
}

function allowedForMutation(snapshot: LongformWorkflowSnapshot, action: LongformWorkflowAction, input?: LongformWorkflowMutation, targetStage?: LongformWorkflowStage): boolean {
  if (input?.semanticReviewFence !== undefined && input.mainOnly !== true) return false
  if (input?.reviewDecisionFence !== undefined && input.mainOnly !== true) return false
  if (input?.mainOnly === true && (action === 'resolve_stage' || action === 'accept_delta' || action === 'accept_unknown' || action === 'accept_prose_no_state' || action === 'reject_rewrite' || action === 'abandon' || action === 'review_pending' || action === 'review_next_scene' || action === 'review_decision_applied' || action === 'review_rewrite' || action === 'review_abandon')) return true
  if (snapshot.allowedActions.includes(action) || action === 'advance' && snapshot.allowedActions.includes('resolve_stage')) return true
  // Grill's durable interview/outline projections are edits within their
  // current stage.  They intentionally do not appear in the user action list
  // (which remains the compact recovery UI contract), but are still strict
  // reducer actions and cannot jump stages.
  if (input && targetStage === snapshot.stage && action === 'answer_requirements' && snapshot.stage === 'requirements') return true
  if (input && targetStage === snapshot.stage && action === 'update_outline' && snapshot.stage === 'outline') return true
  // Binding a pre-run Grill projection to the real run is metadata-only.  It
  // increments the authoritative revision and is permitted in every live
  // stage without exposing a synthetic run or a hidden stage jump.
  if (input && targetStage === snapshot.stage && action === 'resolve_stage' && input.activeRunId !== undefined && (input.targetStatus === undefined || input.targetStatus === snapshot.status)) return true
  return false
}

function statusForMutation(current: LongformWorkflowSnapshot, input: LongformWorkflowMutation, targetStage: LongformWorkflowStage): LongformWorkflowStatus {
  if (input.action === 'stop') return 'draft'
  if (input.action === 'review_pending' || input.action === 'review_next_scene') return 'review'
  if (input.action === 'review_decision_applied') return 'ready'
  if (input.action === 'review_rewrite') return 'running'
  if (input.action === 'review_abandon') return 'cancelled'
  if (input.targetStatus !== undefined) return normalizeStatus(input.targetStatus, current.status)
  if (input.action === 'retry_provider' || input.action === 'retry_export' || input.action === 'resume_draft' || input.action === 'recover') return 'running'
  if (input.action === 'accept_candidate' || input.action === 'submit_candidate') return 'ready'
  if (input.action === 'approve_review' || input.action === 'accept_delta' || input.action === 'accept_unknown' || input.action === 'accept_prose_no_state') return targetStage === 'commit' ? 'ready' : 'completed'
  if (input.action === 'reject_rewrite') return 'provider_failed'
  if (input.action === 'commit') return 'completed'
  if (input.action === 'export') return 'completed'
  return current.status === 'ready' || current.status === 'locked' ? 'running' : current.status
}

function assertTransition(current: LongformWorkflowSnapshot, input: LongformWorkflowMutation, targetStage: LongformWorkflowStage, targetStatus: LongformWorkflowStatus): void {
  const expectedNext = nextLongformWorkflowStage(current.stage)
  const advancing = new Set<LongformWorkflowAction>(['resolve_stage', 'advance', 'accept_candidate', 'approve_review', 'accept_delta', 'accept_unknown', 'accept_prose_no_state', 'commit', 'export', 'reorient'])
  const retrying = new Set<LongformWorkflowAction>(['retry_provider', 'retry_export', 'resume_draft', 'recover', 'start_recall', 'start_draft', 'start_critique', 'start_revision', 'submit_candidate'])
  if (input.action === 'review_next_scene') {
    const previous = current.semanticReviewFence
    const next = input.semanticReviewFence
    if ((input.storyId ?? current.storyId) !== current.storyId || (input.projectId ?? current.projectId) !== current.projectId || (input.branchId ?? current.branchId) !== current.branchId || (input.validityEpoch ?? current.validityEpoch) !== current.validityEpoch) throw new LongformWorkflowError('longform_scope_invalid')
    if (input.mainOnly !== true || !['reorientation', 'export'].includes(current.stage) || current.status !== 'ready' || targetStage !== 'semantic_review' || targetStatus !== 'review' || previous?.status !== 'accepted' || next?.status !== 'pending' || previous.runId !== current.activeRunId || next.runId !== previous.runId || input.activeRunId !== previous.runId || next.sceneId === previous.sceneId || input.sceneId !== next.sceneId || next.packetRevision <= previous.packetRevision || !current.reviewDecisionFence || current.reviewDecisionFence.decisionId !== previous.decisionId || current.reviewDecisionFence.canonicalPayloadHash !== previous.decisionCanonicalPayloadHash || input.reviewDecisionFence !== null) throw new LongformWorkflowError('longform_review_transition_invalid')
    return
  }
  if (input.action === 'review_pending') {
    if (input.mainOnly !== true || targetStage !== 'semantic_review' || targetStatus !== 'review' || !['draft', 'critique', 'revision', 'semantic_review'].includes(current.stage)) throw new LongformWorkflowError('longform_review_transition_invalid')
    return
  }
  if (input.action === 'review_decision_applied') {
    if (input.mainOnly !== true || current.stage !== 'semantic_review' || targetStage !== 'commit' || targetStatus !== 'ready' || current.semanticReviewFence?.status !== 'pending') throw new LongformWorkflowError('longform_review_transition_invalid')
    return
  }
  if (input.action === 'review_rewrite') {
    if (input.mainOnly !== true || current.stage !== 'semantic_review' || targetStage !== 'draft' || targetStatus !== 'running' || current.semanticReviewFence?.status !== 'pending') throw new LongformWorkflowError('longform_review_transition_invalid')
    return
  }
  if (input.action === 'review_abandon') {
    if (input.mainOnly !== true || current.stage !== 'semantic_review' || targetStage !== 'semantic_review' || targetStatus !== 'cancelled' || current.semanticReviewFence?.status !== 'pending') throw new LongformWorkflowError('longform_review_transition_invalid')
    return
  }
  if (input.action === 'stop' || input.action === 'abandon') {
    if (targetStage !== current.stage) throw new LongformWorkflowError('longform_stage_transition_invalid')
    return
  }
  if (input.action === 'answer_requirements' || input.action === 'update_outline') {
    if (targetStage !== current.stage) throw new LongformWorkflowError('longform_stage_transition_invalid')
    return
  }
  if (input.action === 'commit' && !current.reviewDecisionFence && !input.reviewDecisionFence) throw new LongformWorkflowError('longform_review_fence_required')
  if (advancing.has(input.action)) {
    // A stage may be re-projected while a human/provider is still working in
    // it (for example each Grill answer).  It is still a valid transition as
    // long as it does not jump over the next canonical stage.
    if (targetStage !== current.stage && targetStage !== expectedNext && !(input.action === 'commit' && current.stage === 'commit') && !(input.action === 'export' && current.stage === 'export')) throw new LongformWorkflowError('longform_stage_transition_invalid')
    return
  }
  if (retrying.has(input.action) && targetStage !== current.stage) throw new LongformWorkflowError('longform_stage_transition_invalid')
  if (targetStatus === 'completed' && targetStage !== 'export') throw new LongformWorkflowError('longform_stage_transition_invalid')
}

export function applyLongformWorkflowMutation(current: LongformWorkflowSnapshot, rawInput: LongformWorkflowMutation, now = Date.now()): LongformWorkflowSnapshot {
  const input = assertMutation(rawInput)
  if (input.workflowId !== current.workflowId) throw new LongformWorkflowError('longform_workflow_id_mismatch')
  const priorHash = current.appliedOperations[input.operationId]
  if (priorHash !== undefined) {
    if (priorHash === input.canonicalPayloadHash) return current
    throw new LongformWorkflowError('longform_operation_conflict')
  }
  if (input.expectedRevision !== current.authoritativeRevision) throw new LongformWorkflowError('longform_revision_conflict')
  const targetStage = normalizeLongformWorkflowStage(input.targetStage ?? current.stage)
  const targetStatus = statusForMutation(current, input, targetStage)
  if (!allowedForMutation(current, input.action, input, targetStage)) throw new LongformWorkflowError('longform_action_not_allowed')
  assertTransition(current, input, targetStage, targetStatus)
  const draft = input.action === 'stop' ? normalizeDraft(input.draft ?? (input.payload as { draft?: unknown } | null | undefined)?.draft, now) : input.draft === undefined ? current.draft : normalizeDraft(input.draft, now)
  const isStop = input.action === 'stop'
  const reviewDecisionFence = input.reviewDecisionFence === undefined
    ? targetStage === current.stage ? (current.reviewDecisionFence ?? null) : null
    : normalizeDecisionFence(input.reviewDecisionFence)
  const semanticReviewFence = input.semanticReviewFence === undefined
    ? (current.semanticReviewFence ?? null)
    : normalizeSemanticReviewFence(input.semanticReviewFence)
  if ((input.action === 'review_pending' || input.action === 'review_next_scene') && (!semanticReviewFence || semanticReviewFence.status !== 'pending')) throw new LongformWorkflowError('longform_semantic_review_fence_invalid')
  if (input.action === 'review_decision_applied' && (!semanticReviewFence || semanticReviewFence.status !== 'accepted')) throw new LongformWorkflowError('longform_semantic_review_fence_invalid')
  if (input.action === 'review_rewrite' && (!semanticReviewFence || semanticReviewFence.status !== 'rewrite_requested')) throw new LongformWorkflowError('longform_semantic_review_fence_invalid')
  if (input.action === 'review_abandon' && (!semanticReviewFence || semanticReviewFence.status !== 'abandoned')) throw new LongformWorkflowError('longform_semantic_review_fence_invalid')
  if (input.action === 'commit' && !reviewDecisionFence) throw new LongformWorkflowError('longform_review_fence_required')
  if (input.action === 'commit' && current.reviewDecisionFence && input.reviewDecisionFence && stableLongformWorkflowJson(current.reviewDecisionFence) !== stableLongformWorkflowJson(reviewDecisionFence)) throw new LongformWorkflowError('longform_review_fence_conflict')
  const stageStatus = isStop ? 'waiting_user' : deriveStageStatus(targetStatus)
  const blockedReason = input.blockedReason === undefined ? (targetStatus === 'provider_failed' || targetStatus === 'export_failed' ? input.note ?? null : null) : input.blockedReason
  const recoveryAction = input.recoveryAction === undefined
    ? targetStatus === 'draft' ? 'resume_draft' : targetStatus === 'provider_failed' ? 'retry_provider' : targetStatus === 'export_failed' ? 'retry_export' : null
    : input.recoveryAction
  if (recoveryAction !== null && !RECOVERY_ACTIONS.has(recoveryAction)) throw new LongformWorkflowError('longform_recovery_action_invalid')
  const pendingOperation: LongformPendingOperation | null = targetStatus === 'running' && input.action !== 'resume_draft'
    ? { operationId: input.operationId, action: input.action, expectedRevision: input.expectedRevision, canonicalPayloadHash: input.canonicalPayloadHash, status: 'pending', startedAt: now, finishedAt: null, errorCode: null }
    : null
  const next: LongformWorkflowSnapshot = {
    ...copyJson(current),
    stage: targetStage,
    stageStatus,
    status: isStop ? 'draft' : targetStatus,
    pendingOperation,
    allowedActions: [],
    blockedReason,
    recoveryAction,
    draft,
    authoritativeRevision: current.authoritativeRevision + 1,
    eventSeq: current.eventSeq + 1,
    appliedOperations: { ...current.appliedOperations, [input.operationId]: input.canonicalPayloadHash },
    updatedAt: now
  }
  next.reviewDecisionFence = reviewDecisionFence
  next.semanticReviewFence = semanticReviewFence
  if (input.action === 'review_pending' || input.action === 'review_next_scene') next.sceneId = semanticReviewFence!.sceneId
  if (input.activeRunId !== undefined) next.activeRunId = input.activeRunId === null ? null : (validId(input.activeRunId) ? input.activeRunId : (() => { throw new LongformWorkflowError('longform_run_id_invalid') })())
  if (input.storyId !== undefined || input.projectId !== undefined || input.branchId !== undefined) {
    const storyId = input.storyId ?? next.storyId
    const projectId = input.projectId ?? next.projectId
    const branchId = input.branchId ?? next.branchId
    if (!validId(storyId) || !validId(projectId) || !validId(branchId)) throw new LongformWorkflowError('longform_scope_invalid')
    next.storyId = storyId
    next.projectId = projectId
    next.branchId = branchId
  }
  if (input.contractHash !== undefined) next.contractHash = normalizeOptionalHash(input.contractHash, 'longform_contract_hash_invalid')
  if (input.workingSetHash !== undefined) next.workingSetHash = normalizeOptionalHash(input.workingSetHash, 'longform_working_set_hash_invalid')
  if (input.manifestHash !== undefined) next.manifestHash = normalizeOptionalHash(input.manifestHash, 'longform_manifest_hash_invalid')
  if (input.validityEpoch !== undefined && input.validityEpoch !== null) {
    if (!Number.isInteger(input.validityEpoch) || input.validityEpoch < 1) throw new LongformWorkflowError('longform_epoch_invalid')
    next.validityEpoch = input.validityEpoch
  }
  const payload = input.payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>
    if (typeof record.candidateId === 'string') next.candidateId = record.candidateId
    if (typeof record.acceptedSegmentId === 'string') next.acceptedSegmentId = record.acceptedSegmentId
    if (typeof record.commitId === 'string') next.commitId = record.commitId
  }
  if (input.recallAudit !== undefined) next.recallAudit = normalizeRecallAudit(input.recallAudit)
  next.allowedActions = allowedLongformWorkflowActions(next)
  return next
}

export function validateLongformWorkflowSnapshot(value: unknown): LongformWorkflowSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LongformWorkflowError('longform_snapshot_invalid')
  const raw = value as Partial<LongformWorkflowSnapshot>
  if (raw.schemaVersion !== LONGFORM_WORKFLOW_SCHEMA_VERSION || raw.kind !== 'longform-workflow' || !validId(raw.workflowId) || !validId(raw.storyId) || !validId(raw.projectId) || !validId(raw.branchId)) throw new LongformWorkflowError('longform_snapshot_invalid')
  const stage = normalizeLongformWorkflowStage(raw.stage)
  const stageStatus = normalizeStageStatus(raw.stageStatus, 'ready')
  const status = normalizeStatus(raw.status, stageStatus)
  const reviewDecisionFence = normalizeDecisionFence(raw.reviewDecisionFence)
  const semanticReviewFence = normalizeSemanticReviewFence(raw.semanticReviewFence)
  if (!Number.isInteger(raw.authoritativeRevision) || (raw.authoritativeRevision as number) < 0 || !Number.isInteger(raw.eventSeq) || (raw.eventSeq as number) < 0 || !Number.isInteger(raw.validityEpoch) || (raw.validityEpoch as number) < 1 || !Number.isFinite(raw.updatedAt)) throw new LongformWorkflowError('longform_snapshot_invalid')
  if (!validHash(raw.outlineHash) || !validHash(raw.contractHash) || !validHash(raw.workingSetHash) || !validHash(raw.manifestHash)) throw new LongformWorkflowError('longform_snapshot_invalid')
  if (!Array.isArray(raw.allowedActions) || raw.allowedActions.some((action) => !ACTIONS.has(action))) throw new LongformWorkflowError('longform_snapshot_invalid')
  if (!raw.appliedOperations || typeof raw.appliedOperations !== 'object' || Array.isArray(raw.appliedOperations)) throw new LongformWorkflowError('longform_snapshot_invalid')
  const recallAudit = normalizeRecallAudit(raw.recallAudit)
  const normalized = copyJson({ ...raw, stage, stageStatus, status, recallAudit, reviewDecisionFence, semanticReviewFence }) as LongformWorkflowSnapshot
  return normalized
}
