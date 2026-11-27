import type { RunPhase } from '../../shared/activity'
import type { LegacyManuscriptBackfillState, ManuscriptAcceptanceInput, ManuscriptSegment, NarrativeCommitRecord, NarrativeFact, NarrativeLedgerEntry, NarrativeLedgerScope, NarrativeLedgerScopeInfo, SceneCommitInput, SceneCommitManifest, SceneContractPlan, SceneStateRecord, SceneStateTransitionInput } from '../../shared/types'
import type { ManuscriptBackfillWriteHooks } from '../db/repository'
import type { StoryLedgerFreshness, StoryLedgerFreshnessExpectation } from '../narrative/storyLedger'
import type { ProviderPerformanceSnapshot } from '../../shared/performanceTelemetry'

// R4.1 S-04：cancel_requested=取消意图已持久化（协作取消进行中）；
// recovery_required=存在未确认的工具副作用，需人工恢复（非自动重放，仍算 active 可恢复 run）
export type RunStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'cancel_requested'
  | 'recovery_required'
  | 'recoverable'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ModelFinishReason = 'stop' | 'tool_calls' | 'length' | 'error'

export interface ModelToolEvent {
  index: number
  id: string
  name: string
  arguments: string
  /** Provider call_id when the wire protocol exposes a separate item id. */
  callId?: string
  /** OpenAI Responses item id, retained only for stream identity/audit. */
  itemId?: string
}

export interface UsageSegment {
  label: string
  tokens: number
  /** 静态/可缓存段（参与 prefix cache） */
  cacheable: boolean
}

export interface ModelUsageEvent {
  inputTokens?: number
  outputTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  reasoningTokens?: number
  cost?: number
  /** R4.1 TOKEN-METRICS-01：context segment token 拆分 */
  segmentBreakdown?: UsageSegment[]
  /** 静态前缀（system+记忆+计划）拼接哈希——验证 prefix cache 前缀稳定 */
  cacheablePrefixHash?: string
  /** R4.2 A6：usage 更新序号（每次 emit 递增；迟到/重连判定） */
  revision?: number
  /** R4.2 A6：partial=流中估算 / actual=provider 实测 */
  kind?: 'partial' | 'actual'
}

export interface ModelEvent {
  type: 'text' | 'reasoning' | 'tool_call' | 'usage' | 'finish' | 'performance'
  delta?: string
  tool?: ModelToolEvent
  usage?: ModelUsageEvent
  performance?: ProviderPerformanceSnapshot
  finishReason?: ModelFinishReason
  errorCode?: string
  errorMessage?: string
  /** Host-only allowance for all tool bodies produced by this model turn. */
  toolReadBudgetChars?: number
}

export interface RunConfig {
  goalMode?: import('../../shared/goalMode').GoalMode
  allowParallel?: boolean
  maxTurns?: number | null
  continueOnLength?: boolean
  sceneContracts?: SceneContractPlan
  [key: string]: unknown
}

export type RunBudgetActor = 'writer' | 'critic' | 'editor'

/** Cost information known at the provider boundary.  A quote is deliberately
 * separate from provider-attempt usage: it is an upper-bound reservation made
 * before fetch, while usage is only available after the provider returns. */
export interface ProviderCostQuote {
  status: 'estimated' | 'unknown'
  amount: number | null
  currency: string | null
  priceSnapshotId: string | null
}

/** Exact paid-tool boundary. Native services must await it before transport. */
export interface ToolExecutionHooks {
  /** Host-only boundary for parallel local reads: never prompt or use paid transport. */
  readonly nonInteractiveLocalRead?: boolean
  /** Host-only JSON-escaped body character allowance; 0 means metadata only. */
  readonly readBudgetChars?: number
  beforeProviderRequest(requestId: string, quote: ProviderCostQuote): Promise<void>
}

export interface RunCostLimit {
  /** The amount is expressed only in `currency`; it is never converted or
   * added to another currency. */
  amount: number
  currency: string | null
  /** Unknown pricing is always rejected: no monetary bound exists. */
  unknownPolicy: 'deny'
}

/** A conservative token upper bound held from the final request envelope
 * boundary until the provider attempt reaches a terminal state.  The key is
 * stable for one logical call/inner attempt so duplicate callbacks are
 * idempotent, including after a process restart. */
export interface RunTokenReservation {
  reservationId: string
  logicalCallId: string
  innerAttempt: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requestHash: string
  reservedAt: number
}

/** Settlement tombstones are deliberately retained in the run evidence. A
 * late/repeated beforeAttempt callback must not reopen a token reservation. */
export interface SettledRunTokenReservation {
  reservationId: string
  chargedTokens: number
  settledAt: number
}

/** Attempt-bound monetary proof retained after settlement. Missing usage does
 * not erase the full pre-fetch upper bound already charged to this run. */
export interface RunCostReservation {
  reservationId: string
  logicalCallId: string
  innerAttempt: number
  amount: number
  currency: string
  priceSnapshotId: string | null
  reservedAt: number
  settledAt: number | null
}

/** Durable run-level spend/attempt guard.  This is intentionally separate
 * from the in-memory engine state: a process restart must not reset any of
 * these counters. */
export interface RunBudgetState {
  workBudgetPolicy?: 'explicit_v1'
  /** Logical writer requests only; excludes retries and paid tool transport. */
  writerRounds?: number
  schemaVersion: 1
  runId: string
  startedAt: number
  limits: {
    /** null is an explicitly unlimited, JSON-safe attempt count. */
    maxCalls: number | null
    maxTokens: number | null
    /** New currency-safe cost cap.  `null` is retained for old runs that did
     * not carry a cost policy; legacy maxCostCny is only a compatibility view. */
    maxCost: RunCostLimit | null
    maxCostCny: number | null
    maxWallClockMs: number | null
  }
  totalCalls: number
  callsByActor: Record<RunBudgetActor, number>
  retryCalls: number
  retriesByActor: Record<RunBudgetActor, number>
  knownInputTokens: number
  knownOutputTokens: number
  unknownTokenCalls: number
  /** Upper-bound spend already consumed by completed provider attempts. */
  spentCostUpper: number
  spentCostCurrency: string | null
  /** Reservation held between the pre-fetch gate and terminal provider event. */
  reservedCost: number
  reservedCostCurrency: string | null
  reservedCostAttempts: number
  /** Optional on legacy v1 evidence, which cannot prove coverage per attempt. */
  costReservations?: RunCostReservation[]
  costReservationCorrupt?: boolean
  /** Conservative token upper bound already charged by terminal attempts. */
  spentTokenUpper: number
  /** Token capacity held by attempts that have crossed beforeAttempt but have
   * not yet reached a terminal provider boundary. */
  reservedInputTokens: number
  reservedOutputTokens: number
  reservedTokenAttempts: number
  tokenReservations: RunTokenReservation[]
  settledTokenReservations: SettledRunTokenReservation[]
  /** Corrupt/unbounded token evidence is a hard deny, never a reason to drop
   * reservations and continue.  Absent in old evidence => false. */
  tokenReservationCorrupt: boolean
  knownCostCny: number | null
  unknownCostCalls: number
  targetWindowRepairAttempts: number
  zeroProgressRounds: number
  lastWriterRound: { round: number; measuredChars: number } | null
  recentWriterRounds: Array<{ round: number; beforeChars: number; afterChars: number; acceptedDelta: number; observedAt: number }>
  updatedAt: number
}

export interface RunRecord {
  runId: string
  sessionId: string
  status: RunStatus
  phase: RunPhase
  startedAt: number
  updatedAt: number
  configJson: string
  parentRunId?: string
  errorCode?: string
  errorMessage?: string
}

export interface TurnRecord {
  turnId: string
  runId: string
  turnSeq: number
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoningContent?: string
  toolCallsJson?: string
  toolResultJson?: string
  planState?: string
  createdAt: number
}

// R4.1 S-04：running=工具已开始执行（结果未确认）；side_effect_unknown=取消时工具在副作用中，结果未知
export type ToolCallStatus = 'requested' | 'running' | 'completed' | 'failed' | 'cancelled' | 'side_effect_unknown'

export interface ToolCallRecord {
  toolCallId: string
  turnId: string
  runId: string
  name: string
  argsJson: string
  status: ToolCallStatus
  resultJson?: string
  argsHash: string
  startedAt?: number
  completedAt?: number
}

export interface RunStorePort {
  createRun(run: RunRecord): Promise<void>
  getRun(runId: string): Promise<RunRecord | null>
  updateRun(runId: string, patch: Partial<RunRecord>): Promise<void>
  listActiveRuns(): Promise<RunRecord[]>
  appendTurn(turn: TurnRecord): Promise<void>
  getTurns(runId: string): Promise<TurnRecord[]>
  consumeWorkSteering?(runId: string, sessionId: string): Promise<TurnRecord[]>
  hasPendingWorkSteering?(runId: string, sessionId: string): Promise<boolean>
  saveAssistantTurnWithSegment?(turn: TurnRecord, segment: ManuscriptSegment): Promise<void>
  saveManuscriptSegment?(segment: ManuscriptSegment): Promise<void>
  getManuscriptSegments?(runId: string): Promise<ManuscriptSegment[]>
  acceptManuscriptSegment?(input: ManuscriptAcceptanceInput): Promise<void>
  ensureSceneStates?(runId: string, plan: SceneContractPlan, at: number): Promise<void>
  getSceneStates?(runId: string): Promise<SceneStateRecord[]>
  transitionSceneState?(input: SceneStateTransitionInput): Promise<SceneStateRecord>
  commitScene?(input: SceneCommitInput): Promise<void>
  getSceneCommitManifest?(runId: string, sceneId: string): Promise<SceneCommitManifest | null>
  getNarrativeCommits?(runId: string, sceneId?: string): Promise<NarrativeCommitRecord[]>
  getNarrativeLedger?(runId: string, sceneId?: string): Promise<NarrativeLedgerEntry[]>
  getNarrativeLedgerScope?(runId: string): Promise<NarrativeLedgerScopeInfo | null>
  /** Provider/commit fence: read the durable story cursor and authoritative head. */
  getStoryLedgerFreshness?(runId: string): Promise<StoryLedgerFreshness | null>
  /** Re-check the exact snapshot captured before a provider call. */
  assertStoryLedgerFresh?(input: StoryLedgerFreshnessExpectation): Promise<StoryLedgerFreshness>
  getNarrativeLedgerByScope?(scope: NarrativeLedgerScope, throughRevision?: number): Promise<NarrativeLedgerEntry[]>
  /** Fact Registry rows materialized from confirmed Grill Me answers. */
  getNarrativeFacts?(sessionId: string, includeInactive?: boolean): Promise<NarrativeFact[]>
  getManuscriptBackfill?(runId: string): Promise<LegacyManuscriptBackfillState | null>
  saveManuscriptBackfillStep?(state: LegacyManuscriptBackfillState, segment?: ManuscriptSegment, hooks?: ManuscriptBackfillWriteHooks): Promise<void>
  upsertToolCall(tc: ToolCallRecord): Promise<void>
  getToolCalls(runId: string): Promise<ToolCallRecord[]>
  /** R4.2 A4：recovery decision durable 事件 */
  appendRecoveryDecision(d: RecoveryDecisionRecord): Promise<void>
  getRecoveryDecisions(runId: string): Promise<RecoveryDecisionRecord[]>
  /** R4.2 A5 补充：工具大输出 artifact（元数据 + 内容落盘由 store port 注入的 artifactDir 承担） */
  saveArtifact(a: ArtifactRecord): Promise<void>
  /** R4.3 Gate 4：artifact 列表（completion evidence 用） */
  getArtifactsByRun(runId: string): Promise<ArtifactRecord[]>
  /** R4.6 Gate 3：按 hash 读回 artifact 内容（磁盘；缺失/损坏返回 null） */
  getArtifactContent(hash: string): Promise<string | null>
  /** R4.3 Gate 4：completion evaluation durable（先落库再对外） */
  saveCompletionEvaluation(runId: string, revision: number, state: string, json: string): Promise<void>
  getLatestCompletionEvaluation(runId: string): { revision: number; state: string; json: string } | null
  appendCompletionAttempt(runId: string, attempt: number, json: string): Promise<void>
  getCompletionAttempts(runId: string): Promise<Array<{ attempt: number; json: string; createdAt: number }>>
  /** Provider-attempt source used to rebuild the run budget after a crash. */
  getProviderAttempts?(runId: string): Promise<Array<{
    actor: RunBudgetActor
    logicalCallId?: string
    attemptNo: number
    outcome: string
    inputTokens: number | null
    outputTokens: number | null
    costStatus: 'actual' | 'estimated' | 'unknown'
    costAmount: number | null
    costCurrency: string | null
    startedAt: number
  }>>
  /** R4.4 Gate 1：run-scoped durable evidence（renpy_lint 等） */
  saveRunEvidence(runId: string, kind: string, json: string): Promise<void>
  /** Atomically publish the canonical review packet and its rebuildable mirrors. */
  saveRunEvidenceBundle?(runId: string, entries: Array<{ kind: string; json: string }>): Promise<void>
  /** Append-only evidence claim.  Returns false when the (run, kind) key was
   * already written; semantic review uses this for revision/decision CAS so a
   * stale or concurrent renderer cannot overwrite the winning audit record. */
  saveRunEvidenceIfAbsent?(runId: string, kind: string, json: string): Promise<boolean>
  getRunEvidence(runId: string, kind: string): Promise<{ json: string; created_at: number } | null>
  /** R4.4 Gate 5：真实 usage 累计（token 预算判定；restore 时从 ledger 恢复不重置） */
  getUsageTotalTokens(runId: string): Promise<number>
  /** R4.4 Gate 5：usage ledger 落库（kernel run 每轮 usage 事件写入——强杀时预算证据已在） */
  appendUsage(u: { runId: string; callType: string; model: string; inputTokens: number; outputTokens: number; cacheHit: number; cacheMiss: number; createdAt: number }): Promise<void>
}

/** R4.2 A5 补充：artifact 记录（内容寻址；content 由 store port 写 artifactDir/<hash>） */
export interface ArtifactRecord {
  artifactId: string
  runId: string
  sessionId: string
  artifactType: 'tool-output' | 'chapter' | 'scene' | 'renpy' | 'document' | 'file' | 'manuscript'
  displayName: string
  relativePath: string | null
  hash: string
  charCount: number
  status: 'started' | 'completed' | 'failed'
  createdAt: number
  /** 完整内容（仅落盘，不入 DB） */
  content?: string
}

/** R4.2 A4：恢复决策 typed union（S-03：没有显式决策不得继续 step） */
export type RecoveryDecision = 'confirm_applied' | 'retry_not_applied' | 'rollback_then_retry' | 'abandon'

export interface RecoveryDecisionRecord {
  decisionId: string
  runId: string
  toolCallId: string
  decision: RecoveryDecision
  actor: string
  note: string
  checkpointId: string | null
  createdAt: number
}

export type StartResult =
  | { ok: true; run: RunRecord }
  | { ok: false; error: 'session_busy' | 'run_exists'; runId: string }

export type RunEngineEvent =
  | { type: 'goal_updated'; runId: string }
  | { type: 'turn'; turn: TurnRecord }
  /** 强约束撤回未通过候选后，用当前 durable assistant 投影纠正 renderer。 */
  | { type: 'content_replace'; content: string; revision: number; contentHash: string }
  | { type: 'tool'; toolCall: ToolCallRecord }
  | { type: 'phase'; phase: RunPhase; title?: string; detail?: string }
  | { type: 'usage'; usage: ModelUsageEvent }
  | { type: 'performance'; performance: ProviderPerformanceSnapshot }
  | { type: 'artifact'; artifact: ArtifactRecord; targetChars?: number }
  | { type: 'terminal'; run: RunRecord }
  | {
      type: 'completion'
      /** contract_created / validator_result / continuation_required / completion_blocked / completion_accepted */
      subtype: string
      state: string
      remainingWork: Array<{ code: string; message: string }>
      revision: number
      /** R4.3 补：客观进度（UI 只显示结构化事实，不显示模型自述） */
      measuredChars?: number
      targetChars?: number
      validatorPassed?: number
      validatorTotal?: number
      blockedReason?: string
      pausedMessage?: string
    }
