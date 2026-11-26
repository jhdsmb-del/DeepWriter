import { AGENT_OUTPUT_PART, AGENT_OUTPUT_CONTINUE, AGENT_TOOL_REISSUE, progressSinceReminder, projectAgentOutputTail } from './agentContinuation'
import { assessFileDelivery, FILE_DELIVERY_EVIDENCE, newFileDeliveryState, type FileDeliveryState } from './fileDelivery'
import { appendStreamText, streamText } from './streamText'
import { compactWorkPlanHistory, latestActivePlan, WORK_PLAN_CONTINUE } from '../workPlan'
import { WORK_PLAN_TOOL } from '../../shared/workPlan'
import { isWorkSteeringConfig } from '../../shared/workSteering'
import { modelVisibleOutput, prepareToolTurnOutput, replayToolTurnOutput } from './toolTurnOutput'
import { planToolAllowList } from '../../shared/agentPlanPolicy'
import { WORK_FILE_TOOL_NAMES } from '../../shared/workFileTools'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { currentEditorialSection, editorialManuscriptMarkdown, editorialSectionPrompt, frozenWritingForm, isEditorialWriting, sectionReviewEvidenceKind, sectionReviewRequest, validateSectionCoverage, type WritingSectionReview } from '../writingContext'
import { recoverableManuscriptDeliveryError } from '../manuscriptDelivery'
import { CompletionController } from '../completion/CompletionController'
import type { CompletionContract, CompletionEvidence, CompletionEvaluation, CompletionStore } from '../completion/types'
import type { CompletionControllerOpts } from '../completion/CompletionController'
import { computeManifestHash } from '../completion/validators/renpyLint'
import type { DsMessage, LegacyManuscriptBackfillState, ManuscriptAcceptanceInput, ManuscriptSegment, ManuscriptSegmentStatus, NarrativeFact, NarrativeReviewDecisionCapabilities, NarrativeReviewPendingOperation, NarrativeSemanticReviewDecision, NarrativeSemanticReviewDecisionInput, NarrativeSemanticReviewDecisionRecord, NarrativeSemanticReviewPacket, NarrativeSemanticReviewDecisionResult, NarrativeStateDelta, SceneCommitInput, SceneCommitManifest, SceneCompletionDecision, SceneContract, SceneContractPlan, SceneLifecycle, SceneStateRecord, SceneMemoryCard, SceneMemoryCardValidationContext, SceneMemoryLedgerClaim, SceneMemorySourceSegment } from '../../shared/types'
import type { StrongConstraintSnapshot } from '../../shared/types'
import type { RunPhase } from '../../shared/activity'
import type { FrozenContextSnapshotV2 } from '../../shared/contextV2'
import type { ProviderPerformanceSnapshot } from '../../shared/performanceTelemetry'
import { projectOlderReadResults, type LiveToolProjection } from '../liveToolProjection'
import { codePointLength, selectNaturalEnding, takeCodePoints } from '../../shared/textMetrics'
import { acceptedManuscriptSegments, classifyAssistantOutput, hasNaturalProseEnding, legacyBackfillCompletionMarker, legacyBackfillSourceSummaryHash, makeManuscriptSegment, manuscriptAcceptanceEvidenceIdentity, manuscriptSegmentHash, mergeContinuationText, validateManuscriptPartialGraph } from '../manuscript'
import { advanceLegacyBackfillState, buildLegacyBackfillPlan, legacyBackfillSegment, legacyBackfillSourceTurns } from '../manuscriptBackfill'
import { deriveLongwriteMaxTurns } from '../executionSnapshot'
import { buildLongWriteCheckpoint, buildLongWriteContextMessages, buildLongWriteProgressInstruction, deriveLongWritePlan, LONGWRITE_MAX_TURNS_CAP as LONGWRITE_PLAN_MAX_TURNS_CAP } from '../longformPlanner'
import type { LongWritePlan } from '../../shared/types'
import { buildStrongConstraintRepairInstruction, evaluateStrongConstraints } from '../strongConstraints'
import { bindSceneBeatCriticEvidence, buildSceneCompletionDecision, buildSceneContractPrompt, buildSceneContractRepairInstruction, deriveSceneBeatRequiredParts, evaluateSceneContract, isOpaqueSceneBeatRequirement, sceneContractPlanValid, validateSceneBeatSemanticEvidence } from '../narrative/sceneContract'
import type { SceneContractEvaluation } from '../narrative/sceneContract'
import { buildSceneBeatRepairPrompt, makeSceneBeatRepairRequest, readSceneBeatRepairLedger, reserveSceneBeatRepair, sceneBeatRepairEligible, sceneBeatRepairEvidenceKind, scheduleSceneBeatRepair, type SceneBeatRepairRequest } from '../narrative/sceneBeatRepair'
import type { StoryLedgerFreshness, StoryLedgerFreshnessExpectation } from '../narrative/storyLedger'
import { storyLedgerRevisionHashV2, validateNarrativeLedgerScope } from '../narrative/storyLedger'
import { buildEmptyNarrativeStateDelta, normalizeNarrativeStateDelta, narrativeStateDeltaHash, stableNarrativeJson } from '../narrative/stateDelta'
import { buildSceneMemoryCard, ledgerEvidence, makeSceneMemorySourceSpan, sceneMemoryLedgerClaimHash, sha256Text, sourceSpanEvidence, stableSceneMemoryJson } from '../narrative/sceneMemoryCard'
import { extractNarrativeStateDelta, isRoleBindingAmbiguityOnly, type AcceptedSceneSegmentInput, type ConfirmedGrillAnswerInput } from '../narrative/stateExtractor'
import { buildNarrativeQualityPrompt, buildNarrativeQualityRepairInstruction, evaluateNarrativeQualityGate, narrativeQualityEvidenceMatches as matchesNarrativeQualityEvidence } from '../narrative/narrativeQualityGate'
import type { NarrativeQualityEvaluation } from '../../shared/types'
import type { DramaticCriticReport, ExactTextSpan } from '../../shared/narrativeV2'
import { factMatchesRequiredId, factReferenceMatches } from '../narrative/factRegistry'
import { wp7Runtime, type Wp7Runtime } from '../narrative/wp7Runtime'
import {
  applyTargetedEdit,
  assessAutoEditBoundary,
  buildCriticMessages,
  buildCriticFormatRepairMessages,
  buildEditorMessages,
  criticJsonPayload,
  detectZombieStyleIssues,
  filterIssuesForPolicy,
  issuesFromDeterministic,
  mergeCriticIssues,
  parseCriticReport,
  parseCorrectedCriticReport,
  prepareCriticFormatRepair,
  prepareCriticSemanticRepair,
  readWritingCriticAttempts,
  parseEditorPlan,
  writingTextHash,
  writingPipelinePolicyValid,
  type WritingCriticIssue,
  type WritingCriticReportV1,
  type WritingCriticSemanticIssue,
  type WritingPipelinePolicyV1
} from '../writingPipeline'
import type {
  ArtifactRecord,
  ModelEvent,
  RecoveryDecision,
  RecoveryDecisionRecord,
  RunConfig,
  RunBudgetActor,
  ProviderCostQuote,
  RunBudgetState,
  RunEngineEvent,
  RunRecord,
  RunStatus,
  RunStorePort,
  StartResult,
  ToolCallRecord,
  ToolExecutionHooks,
  TurnRecord
} from './types'

import {
  RUN_BUDGET_EVIDENCE_KIND,
  MAX_PROGRESS_ROUNDS,
  MAX_TARGET_WINDOW_REPAIRS,
  RunBudgetExceededError,
  budgetMessage,
  deriveBudgetFromProviderAttempts,
  makeRunBudgetState,
  normalizeBudgetState,
  reconcileTokenReservationsFromProviderAttempts,
  reserveProviderAttemptBudget,
  reserveProviderCostBudget,
  reserveProviderTokenBudget,
  runBudgetLimits,
  settleProviderTokenBudget,
  settleProviderCostBudget,
  tighterRunBudgetLimits,
  tokenConsumedUpper,
  tokenReservedUpper,
  validBudgetState,
  type ProviderBudgetFailureCode,
  type ProviderTokenRequestBoundary
} from './providerBudgetPolicy'

// Preserve the established engine import path for adapters and older callers.
export { estimateProviderTokenUpperBound, RUN_PROVIDER_CALL_ABSOLUTE_CAP } from './providerBudgetPolicy'
export type { ProviderTokenRequestBoundary, ProviderTokenUpperBound } from './providerBudgetPolicy'

/** R4.2 A4：幂等工具集——重试无需回滚也不会产生二次副作用（读取/生成类） */
export const IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  'list_files',
  'read_file',
  'search_conversation',
  'search_files',
  ...WORK_FILE_TOOL_NAMES,
  WORK_PLAN_TOOL,
  'generate_markdown_doc',
  'generate_docx_doc',
  'generate_pdf_doc'
])

// ---- R4.2 A5 补充：工具大输出落 artifact，只向模型发摘要 ----
export const ARTIFACT_SPILL_CHARS = 20000
export const ARTIFACT_SUMMARY_CHARS = 2000
export const ARTIFACT_DIR_HINT = 'artifacts'

/**
 * 工具输出 > ARTIFACT_SPILL_CHARS 时：模型消息只放摘要 + artifact 引用（完整内容由
 * saveArtifact 落盘/落库）；小输出原样返回。restore 重建 turn 时复用同一函数保证一致。
 */
export function summarizeToolOutput(result: string, toolName: string): string {
  if (result.length <= ARTIFACT_SPILL_CHARS) return result
  const hash = createHash('sha256').update(result).digest('hex')
  const head = result.slice(0, ARTIFACT_SUMMARY_CHARS)
  return `${head}\n…（工具 ${toolName} 输出过长：${result.length} 字符）\n[完整输出已存 artifact ${hash}]`
}

export interface EngineMemory {
  run: RunRecord
  controller: AbortController
  stepping: Promise<void> | null
  nextTurnSeq: number
  currentAssistant: { turnId: string; turnSeq: number } | null
  /** R42：恢复后先审读/验收已持久化候选，禁止把它当 partial 继续追加。 */
  writingPipelineResume: { turnId: string; stage: string; criticAttempt?: number } | null
  manuscriptResume: boolean
  usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number; cacheMissTokens: number; reasoningTokens: number; cost: number }
  /** Active-run cache of the durable segment projection. It is invalidated on
   * every segment/status write, so repeated completion/context reads do not
   * re-sort and re-materialize the entire manuscript on every turn. */
  manuscriptCache: { segments: ManuscriptSegment[]; acceptedSegments: ManuscriptSegment[]; acceptedText: string } | null
  /** R4.2 A6：usage 更新序号（每次 emit 递增） */
  usageRevision: number
  /** Cooperative activity pause: aborts the current provider request while
   * preserving the non-terminal run and its durable partial turn. */
  pauseRequested: boolean
  done: boolean
}

/** Durable revision claim envelope.  Kept separate from the final decision
 * record because claims are written before scene completion and therefore
 * intentionally contain only the identity fields needed for idempotency. */
type NarrativeReviewClaimRecord = {
  schemaVersion?: number
  runId?: string
  expectedRevision?: number
  revision?: number
  packetHash?: string
  operationId?: string
  decisionId?: string
  decision?: NarrativeSemanticReviewDecision
  canonicalPayloadHash?: string
  /** v1.2.4 compatibility alias; new claims write both names. */
  payloadHash?: string
  claimedAt?: number
}

export interface CreateAgentRunEngineOpts {
  store: RunStorePort
  modelCall: (opts: {
    runId: string
    phase: RunPhase
    turnSeq: number
    /** 当前模型调用在本次 run 中的轮次（1 起；首轮用于注入前缀/附件） */
    round: number
    messages: DsMessage[]
    purpose?: 'writer' | 'critic' | 'editor'
    liveToolProjection?: LiveToolProjection
    /** Stable identity shared by all inner attempts of this logical call. */
    logicalCallId?: string
    /** Called immediately before every provider boundary.  The engine
     * accounts for attempt 1 before invoking modelCall so synthetic providers
     * are covered too; the adapter supplies a currency-bound upper quote when
     * it has a trusted price snapshot. */
    beforeProviderAttempt?: (input: { innerAttempt: number; logicalCallId?: string; request?: ProviderTokenRequestBoundary; costQuote?: ProviderCostQuote }) => void | Promise<void>
  }) => Promise<AsyncIterable<ModelEvent>>
  toolExecutor: (name: string, argsJson: string, toolCallId: string, runId: string, hooks?: ToolExecutionHooks) => Promise<string>
  getConfig: (runId: string) => RunConfig
  onEvent: (runId: string, ev: RunEngineEvent) => void
  onRunUpdate: (run: RunRecord) => void
  /** Optional WP7 adapter for focused production/runtime boundary tests. */
  wp7Runtime?: Wp7Runtime
  rollback?: (runId: string, toolCalls: ToolCallRecord[]) => Promise<{ ok: boolean; error?: string; checkpointId?: string }>
  /** R4.2 A5 补充：工具大输出 artifact 磁盘目录（store port saveArtifact 写文件） */
  artifactDir?: string
  /** Production delivery gate: atomically materialize a user-visible long-form manuscript. */
  publishLongwriteArtifact?: (input: {
    runId: string
    sessionId: string
    content: string
    contentHash: string
    config: RunConfig
  }) => Promise<{ displayName: string; relativePath: string }>
  /**
   * R4.5 Gate 2（B-02）：角色监护实验 hook——snapshot.deepWrite.experiment.enabled 且本 hook 存在时，
   * 每轮主模型调用前调用（round≥2 且有正文时）。监护者只产结构化建议（injectedSystemLines），
   * 正文唯一作者仍是主模型；失败抛错由引擎降级（不阻断主链）；用量计入同一 run usage ledger。
   */
  experimentRun?: (input: {
    runId: string
    round: number
    draftSoFar: string
    targetChars: number
    characters: Array<{ id: string; name: string; bible: string; knownFacts: string[]; forbiddenKnowledge: string[] }>
    signal?: AbortSignal
  }) => Promise<{
    ok: boolean
    degraded: boolean
    injectedSystemLines: string[]
    usage?: { inputTokens: number; outputTokens: number }
  }>
}

export interface AgentRunEngine {
  start(opts: { sessionId: string; runId: string; config: RunConfig; parentRunId?: string; alreadyCreated?: boolean; newlyAccepted?: boolean }): Promise<StartResult>
  step(runId: string): Promise<void>
  cancel(runId: string): Promise<void>
  /** Stop the in-flight provider request at a safe boundary without creating
   * a terminal cancelled run. Resume is a separate run-level request. */
  pause(runId: string): Promise<void>
  restore(runId: string): Promise<void>
  listRecoverable(): Promise<RunRecord[]>
  listActive(): RunRecord[]
  getState(runId: string): Promise<{ run: RunRecord | null; turns: TurnRecord[]; toolCalls: ToolCallRecord[] }>
  abortSignal(runId: string): AbortSignal | undefined
  /** R4.2 A4：恢复决策门——结构化事实（run + 待决策工具 + 历史决策），不自动 step */
  recoverInfo(runId: string): Promise<{ run: RunRecord | null; pendingToolCalls: ToolCallRecord[]; decisions: RecoveryDecisionRecord[] }>
  /** R4.2 A4：应用 typed recovery decision（confirm_applied/retry_not_applied/rollback_then_retry/abandon） */
  applyRecoveryDecision(runId: string, decision: RecoveryDecision, opts?: { actor?: string; note?: string }): Promise<{ ok: true } | { ok: false; error: string }>
  /** Scene/narrative semantic review is a durable decision gate. */
  getNarrativeReview(runId: string): Promise<NarrativeSemanticReviewPacket | null>
  applyNarrativeReviewDecision(input: NarrativeSemanticReviewDecisionInput, opts?: { actor?: string }): Promise<NarrativeSemanticReviewDecisionResult | { ok: false; error: string }>
}

export type NarrativeSemanticReviewStatusResult = Exclude<import('../../shared/types').NarrativeSemanticReviewStatus, 'pending_review'>

const TERMINAL_STATUSES = new Set<RunStatus>(['completed', 'failed', 'cancelled'])

const isTerminal = (s: RunStatus): boolean => TERMINAL_STATUSES.has(s)

const now = (): number => Date.now()

const narrativeReviewDecisionPayloadHash = (input: {
  runId: string
  sceneId: string
  contractId: string
  contractHash: string
  packetHash: string
  expectedRevision: number
  revision: number
  candidateSegmentId: string
  candidateHash: string
  candidateCharCount: number
  decisionId: string
  decision: NarrativeSemanticReviewDecision
  deltaHash: string | null
  note: string
}): string => createHash('sha256').update(stableNarrativeJson({
  schemaVersion: 1,
  runId: input.runId,
  sceneId: input.sceneId,
  contractId: input.contractId,
  contractHash: input.contractHash,
  packetHash: input.packetHash,
  expectedRevision: input.expectedRevision,
  revision: input.revision,
  candidateSegmentId: input.candidateSegmentId,
  candidateHash: input.candidateHash,
  candidateCharCount: input.candidateCharCount,
  decisionId: input.decisionId,
  decision: input.decision,
  deltaHash: input.deltaHash,
  note: input.note
}), 'utf8').digest('hex')

const narrativeReviewDecisionNames: NarrativeSemanticReviewDecision[] = [
  'accept_delta',
  'accept_unknown',
  'accept_prose_no_state',
  'reject_rewrite',
  'abandon'
]

const NARRATIVE_REVIEW_OPERATION_ID_MAX_CHARS = 128
const sha256Hex = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const reviewOperationIdValid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= NARRATIVE_REVIEW_OPERATION_ID_MAX_CHARS

/**
 * The pre-claim id is derived from the immutable packet identity.  It is
 * deliberately kept in the engine as well as main so a packet parser can
 * reject a hash-rewritten arbitrary operation before the IPC authority sees
 * it.  A durable claim may carry the caller's already-issued id; that id is
 * checked against the claim and decision records below.
 */
export const provisionalNarrativeReviewOperationId = (review: Pick<NarrativeSemanticReviewPacket, 'runId' | 'revision' | 'packetHash'>): string => {
  const digest = createHash('sha256')
    .update(`narrative-review-operation:v1\u0000${review.runId}\u0000${review.revision}\u0000${review.packetHash}`, 'utf8')
    .digest('hex')
  return `nreview_${digest.slice(0, 48)}`
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const errCode = (e: unknown, fallback = 'model_error'): string => {
  const code = (e as { code?: unknown })?.code
  return typeof code === 'string' && code.trim() ? code : fallback
}

/** A complete prose scene with unresolved structured state is recoverable, not
 * a failed run. The durable pending evidence tells the user what to confirm
 * before the same candidate can be retried. */
class NarrativeStatePendingReviewError extends Error {
  readonly code = 'narrative_state_pending_review'

  constructor(message = 'narrative_state_pending_review') {
    super(message)
    this.name = 'NarrativeStatePendingReviewError'
  }
}

function positiveFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

const hashArgs = (name: string, argsJson: string): string =>
  createHash('sha256').update(`${name}\u0000${argsJson}`).digest('hex')

const LOCAL_READ_CONCURRENCY = 4
type PendingTool = { id: string; name: string; arguments: string }

/** Scheduling proof, not authority. The executor rechecks its real path roots
 * with nonInteractiveLocalRead, so a changed path cannot open a parallel prompt.
 * Containers, attachments, directory walks and unknown tools remain barriers. */
async function independentLocalReadPath(tool: PendingTool, config: RunConfig): Promise<string | null> {
  if (tool.name !== 'read_file' || typeof config.workDir !== 'string' || typeof config.docDir !== 'string') return null
  const planTools = planToolAllowList(config)
  if (planTools && !planTools.includes(tool.name)) return null
  const local = (value: string): boolean => path.isAbsolute(value) && !/^(?:\\\\|\/\/)/u.test(value)
  if (!local(config.workDir) || !local(config.docDir)) return null
  try {
    const args = JSON.parse(tool.arguments) as Record<string, unknown>
    if (!args || typeof args.path !== 'string' || !args.path || args.path.startsWith('attachment:') || args.archive_entry !== undefined) return null
    const file = path.resolve(config.workDir, args.path)
    if (!local(file) || !/\.(?:txt|md|markdown|json|jsonl|csv|tsv|yaml|yml|log|rst|text|js|ts|tsx|jsx|css|html|xml)$/iu.test(file)) return null
    const real = await fs.realpath(file)
    if (!local(real) || !(await fs.stat(real)).isFile()) return null
    for (const root of [config.workDir, config.docDir]) {
      const realRoot = await fs.realpath(root)
      const relative = path.relative(realRoot, real)
      if (local(realRoot) && relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        return process.platform === 'win32' ? real.toLowerCase() : real
      }
    }
  } catch { /* Malformed/unknown paths retain the original serial executor. */ }
  return null
}

function validateTransition(from: RunStatus, to: RunStatus): void {
  if (from === to) return
  if (isTerminal(from)) throw new Error(`run 已终态，状态不可变: ${from}`)
  // R4.1 S-04：cancel_requested（取消意图已提交）/recovery_required（副作用未确认）为可恢复中间态
  // R4.5 Gate 4：waiting_user（完成校验暂停等用户决策）为可恢复中间态
  if (
    to !== 'running' &&
    to !== 'recoverable' &&
    to !== 'cancel_requested' &&
    to !== 'recovery_required' &&
    to !== 'waiting_user' &&
    !isTerminal(to)
  ) {
    throw new Error(`非法状态转换: ${from} -> ${to}`)
  }
}

function buildMessages(turns: TurnRecord[]): DsMessage[] {
  const out: DsMessage[] = []
  const fileCalls = new Map<string, string>()
  for (const t of turns) {
    if (t.role !== 'tool') fileCalls.clear()
    if (t.role === 'assistant') {
      const msg: DsMessage = { role: 'assistant', content: t.content }
      if (t.reasoningContent) msg.reasoning_content = t.reasoningContent
      if (t.toolCallsJson) {
        try {
          msg.tool_calls = (JSON.parse(t.toolCallsJson) as { id: string; name: string; arguments: string }[]).map(
            (c) => ({ id: c.id, name: c.name, arguments: c.arguments })
          )
        } catch {
          msg.tool_calls = []
        }
      }
      for (const call of msg.tool_calls ?? []) {
        if (call.name === 'edit_file' || call.name === 'write_file') fileCalls.set(call.id, call.name)
      }
      out.push(msg)
    } else if (t.role === 'tool' && t.toolResultJson) {
      try {
        const r = JSON.parse(t.toolResultJson) as { toolCallId: string; content: string }
        const name = fileCalls.get(r.toolCallId)
        out.push({ role: 'tool', tool_call_id: r.toolCallId, content: name ? modelVisibleOutput(name, r.content) : r.content })
      } catch {
        out.push({ role: 'tool', tool_call_id: '', content: t.content })
      }
    } else {
      out.push({ role: t.role, content: t.content })
    }
  }
  return out
}

function isLongWriteConfig(config: RunConfig): boolean {
  return config.runMode === 'longwrite' && config.longMode === true
}

type Wp7SceneDirectorInput = Parameters<Wp7Runtime['runDirector']>[0]

/**
 * Translate the already-frozen v1 scene contract into the deterministic WP7
 * director input.  This is a projection only: the v1 contract remains the
 * sole writer constraint and this object never enters the provider request.
 */
function buildWp7SceneDirectorInput(contract: SceneContract): Wp7SceneDirectorInput {
  const clean = (value: unknown): string => String(value ?? '').replace(/\s+/gu, ' ').trim()
  const firstCharacter = contract.povCharacterId ?? contract.activeCharacterIds[0] ?? contract.characterIds[0] ?? ''
  const objective = clean(contract.objective)
  const obstacle = clean(contract.obstacle)
  const conflict = clean(contract.conflict)
  const expectedTurn = clean(contract.expectedTurn ?? objective)
  const desire = clean(contract.desire)
  const reveal = clean(contract.reveal ?? objective)
  const hardConstraints = [
    ...contract.requiredBeatIds.map((id) => ({ id: `required-beat:${id}`, kind: 'required' as const, statement: id })),
    ...contract.requiredFactIds.map((id) => ({ id: `required-fact:${id}`, kind: 'fact' as const, statement: id })),
    ...contract.forbiddenFactIds.map((id) => ({ id: `forbidden-fact:${id}`, kind: 'forbidden' as const, statement: id })),
    ...contract.mustHappen.map((statement, index) => ({ id: `must-happen:${index + 1}`, kind: 'required' as const, statement: clean(statement) })),
    ...contract.mustNotHappen.map((statement, index) => ({ id: `must-not-happen:${index + 1}`, kind: 'forbidden' as const, statement: clean(statement) }))
  ]
  return {
    contractId: `${contract.contractId}:v2`,
    sceneId: contract.sceneId,
    revision: contract.revision,
    sceneFunction: 'other',
    povCharacterId: firstCharacter || null,
    entrySituation: objective,
    dramaticQuestion: conflict || obstacle || objective,
    desires: { pov: desire || objective, opposition: obstacle || conflict || objective },
    failureStrategies: { pov: [], opposition: [] },
    escalation: { pressure: conflict || obstacle || objective, stakes: objective, irreversibleIfIgnored: expectedTurn },
    choice: { actor: firstCharacter || 'scene', action: expectedTurn, alternatives: [], irreversible: true },
    cost: { payer: firstCharacter || 'scene', immediate: obstacle || conflict || objective },
    turn: { from: objective, to: expectedTurn, trigger: conflict || obstacle || null },
    valueShift: { from: desire || objective, to: expectedTurn },
    revelationAndInterpretation: reveal,
    readerStateDelta: { before: [], after: contract.requiredFactIds.map(clean).filter(Boolean) },
    characterKnowledgeDelta: [],
    relationshipDelta: [],
    threadsToAdvance: contract.threadActions.filter((action) => action.action === 'advance' || action.action === 'open').map((action) => action.threadId),
    threadsNotToResolve: contract.threadActions.filter((action) => action.action === 'delay' || action.action === 'close').map((action) => action.threadId),
    exitVector: {
      unresolvedQuestion: clean(contract.handoff) || expectedTurn,
      nextPressure: conflict || obstacle || objective,
      requiredDirection: expectedTurn,
      forbiddenResolution: contract.mustNotHappen.map(clean).filter(Boolean).join('; ') || null
    },
    hardConstraints,
    softIntent: contract.acceptanceCriteria.map((statement, index) => ({ id: `acceptance:${index + 1}`, kind: 'structure' as const, statement: clean(statement), priority: 1 })),
    sourceHash: contract.frozenHash
  }
}

export interface Wp7SceneContractProjectionContext {
  runId: string
  config: RunConfig
  contract: SceneContract
  state?: SceneStateRecord
  runtime: Wp7Runtime
  store: Pick<RunStorePort, 'saveRunEvidenceIfAbsent' | 'getRunEvidence' | 'getStoryLedgerFreshness'>
}

/** Persist one deterministic V2 projection without allowing it to become a
 * writer/canonical side effect.  Replays accept the exact same bytes; any
 * hash/epoch conflict is fail-closed and never overwrites the first row. */
export async function persistWp7SceneContractProjection(input: Wp7SceneContractProjectionContext): Promise<boolean> {
  const flags = input.runtime.parseWp7FeatureFlags(input.config.wp7FeatureFlags)
  if (!flags.sceneContractV2 || !flags.deterministicDirector) return false
  if (!input.store.saveRunEvidenceIfAbsent) throw new Error('wp7_scene_contract_v2_projection_cas_unavailable')
  const directorInput = buildWp7SceneDirectorInput(input.contract)
  const inputHash = createHash('sha256').update(stableNarrativeJson(directorInput), 'utf8').digest('hex')
  const freshness = input.store.getStoryLedgerFreshness ? await input.store.getStoryLedgerFreshness(input.runId) : null
  const epoch = freshness && Number.isInteger(freshness.validityEpoch) && freshness.validityEpoch >= 0 ? freshness.validityEpoch : 0
  const projection = input.runtime.runDirector(directorInput, flags)
  if (!projection) return false
  const outputHash = createHash('sha256').update(stableNarrativeJson(projection), 'utf8').digest('hex')
  const workflowId = typeof input.config.sessionId === 'string' && input.config.sessionId.trim() ? input.config.sessionId : input.runId
  const kind = `wp7_scene_contract_v2_projection:${input.contract.contractId}:${input.contract.revision}`
  const payload = JSON.stringify({
    schemaVersion: 1,
    stage: 'projection',
    runId: input.runId,
    workflowId,
    sceneId: input.contract.sceneId,
    revision: input.state?.revision ?? input.contract.revision,
    contractRevision: input.contract.revision,
    contractHash: input.contract.frozenHash,
    epoch,
    flagsHash: input.runtime.hashWp7FeatureFlags(flags),
    inputHash,
    outputHash,
    projection
  })
  const inserted = await input.store.saveRunEvidenceIfAbsent(input.runId, kind, payload)
  if (inserted) return true
  const existing = await input.store.getRunEvidence(input.runId, kind)
  if (!existing) throw new Error('wp7_scene_contract_v2_projection_missing_after_cas')
  if (existing.json !== payload) throw new Error('wp7_scene_contract_v2_projection_conflict')
  return false
}

type Wp7SceneContractV2 = NonNullable<ReturnType<Wp7Runtime['runDirector']>>

export interface Wp7DramaticCriticEvidenceContext {
  runId: string
  config: RunConfig
  workflowId: string
  sceneId: string
  sceneRevision: number
  contractHash: string
  candidate: ManuscriptSegment
  contract: Wp7SceneContractV2
  runtime: Wp7Runtime
  store: Pick<RunStorePort, 'saveRunEvidenceIfAbsent' | 'getRunEvidence' | 'getStoryLedgerFreshness'>
}

/** Persist one candidate-local critic report.  The report is advisory only:
 * this function never mutates the candidate, scene lifecycle, review state,
 * manuscript, or canonical ledger. */
export async function persistWp7DramaticCriticEvidence(input: Wp7DramaticCriticEvidenceContext): Promise<boolean> {
  const flags = input.runtime.parseWp7FeatureFlags(input.config.wp7FeatureFlags)
  if (!flags.dramaticCritic) return false
  if (!input.store.saveRunEvidenceIfAbsent) throw new Error('wp7_dramatic_critic_cas_unavailable')
  const contractValidation = input.runtime.validateSceneContractV2(input.contract)
  if (!contractValidation.ok || !contractValidation.hashValid) throw new Error('wp7_dramatic_critic_contract_invalid')
  if (!/^[0-9a-f]{64}$/u.test(input.contractHash) || input.contract.sourceHash !== input.contractHash) throw new Error('wp7_dramatic_critic_source_hash_mismatch')
  if (input.candidate.status !== 'candidate' || input.candidate.kind !== 'prose' || !input.candidate.content.trim()) return false
  const candidateHash = manuscriptSegmentHash(input.candidate.content)
  if (input.candidate.contentHash !== candidateHash) throw new Error('wp7_dramatic_critic_candidate_hash_mismatch')
  const freshness = input.store.getStoryLedgerFreshness ? await input.store.getStoryLedgerFreshness(input.runId) : null
  const epoch = freshness && Number.isInteger(freshness.validityEpoch) && freshness.validityEpoch >= 0 ? freshness.validityEpoch : 0
  const criticInput = { candidate: input.candidate.content, contract: input.contract }
  const inputHash = createHash('sha256').update(stableNarrativeJson(criticInput), 'utf8').digest('hex')
  const report = input.runtime.runCritic(criticInput, flags)
  if (!input.runtime.validateCriticReport(input.candidate.content, report, input.contract.frozenHash)) throw new Error('wp7_dramatic_critic_invalid_report')
  const outputHash = createHash('sha256').update(stableNarrativeJson(report), 'utf8').digest('hex')
  const kind = `wp7_dramatic_critic:${input.candidate.segmentId}:${input.candidate.revision}`
  const payload = JSON.stringify({
    schemaVersion: 1,
    stage: 'candidate_critic',
    runId: input.runId,
    workflowId: input.workflowId,
    sceneId: input.sceneId,
    candidateSegmentId: input.candidate.segmentId,
    candidateHash,
    contractHash: input.contractHash,
    criticContractHash: input.contract.frozenHash,
    revision: input.candidate.revision,
    sceneRevision: input.sceneRevision,
    epoch,
    flagsHash: input.runtime.hashWp7FeatureFlags(flags),
    inputHash,
    outputHash,
    report
  })
  const inserted = await input.store.saveRunEvidenceIfAbsent(input.runId, kind, payload)
  if (inserted) return true
  const existing = await input.store.getRunEvidence(input.runId, kind)
  if (!existing) throw new Error('wp7_dramatic_critic_missing_after_cas')
  if (existing.json !== payload) throw new Error('wp7_dramatic_critic_conflict')
  return false
}

/** Confirmed SceneContract longwrite path used by v1.2.5 WP4.  Legacy
 * longwrite snapshots and quick-bypass runs intentionally retain their old
 * summary/recent projection. */
function isLongwriteV2Config(config: RunConfig): boolean {
  if (isEditorialWriting(config)) return false
  if (!isLongWriteConfig(config)) return false
  if (config.longwrite_v2 === true || config.longwriteV2 === true || config.narrativeContextVersion === 2 || config.contextVersion === 2) return true
  const frozen = config.frozenContext as { schemaVersion?: unknown; mode?: unknown } | undefined
  return frozen?.schemaVersion === 2 && frozen.mode !== 'legacy_v1' && config.sceneContracts !== undefined && config.sceneContracts !== null
}

function modelOutputTokensFromConfig(config: RunConfig): number {
  const snapshots = config.providerProfileSnapshots as { draft?: { generation?: { maxOutputTokens?: unknown } } } | undefined
  const frozen = snapshots?.draft?.generation?.maxOutputTokens
  if (typeof frozen === 'number' && Number.isFinite(frozen) && frozen > 0) return frozen
  const configured = config.maxTokens
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : 4096
}

function validLongWritePlan(value: unknown): value is LongWritePlan {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<LongWritePlan>
  return candidate.schemaVersion === 1 && typeof candidate.targetChars === 'number' && Number.isFinite(candidate.targetChars) &&
    typeof candidate.maxTurns === 'number' && Number.isFinite(candidate.maxTurns) && Array.isArray(candidate.chapters) && candidate.chapters.length > 0
}

function longWritePlanFromConfig(config: RunConfig, targetChars: number): LongWritePlan {
  if (validLongWritePlan(config.longWritePlan)) return config.longWritePlan
  return deriveLongWritePlan({ targetChars, modelOutputTokens: modelOutputTokensFromConfig(config) })
}

interface CompletionTargetWindow {
  min: number
  max: number
  tolerance: number
  floor: number
}

function targetWindow(contract: CompletionContract | undefined): CompletionTargetWindow | null {
  const rawMin = positiveFinite(contract?.targetChars?.min)
  if (rawMin === null) return null
  const rawMax = positiveFinite(contract?.targetChars?.max)
  const max = Math.max(rawMin, rawMax ?? rawMin)
  const tolerance = typeof contract?.targetChars?.tolerance === 'number' && Number.isFinite(contract.targetChars.tolerance)
    ? Math.min(1, Math.max(0, contract.targetChars.tolerance))
    : 0
  return { min: Math.floor(rawMin), max: Math.floor(max), tolerance, floor: Math.floor(rawMin * (1 - tolerance)) }
}

export function createAgentRunEngine(opts: CreateAgentRunEngineOpts): AgentRunEngine {
  const { store, modelCall, toolExecutor, getConfig: suppliedGetConfig, onEvent, onRunUpdate, rollback } = opts
  const narrativeRuntime = opts.wp7Runtime ?? wp7Runtime
  const mem = new Map<string, EngineMemory>()
  const fallbackSegments = new Map<string, Map<string, ManuscriptSegment>>()
  const fallbackBackfills = new Map<string, LegacyManuscriptBackfillState>()
  const fallbackSceneStates = new Map<string, SceneStateRecord[]>()
  const runBudgets = new Map<string, RunBudgetState>()
  const budgetSaveChains = new Map<string, Promise<void>>()
  const budgetMutationChains = new Map<string, Promise<void>>()
  /** A review decision spans several awaited repository writes.  Serialize
   * the complete operation per run so two renderer windows cannot both pass
   * the same waiting_user/revision check and race their commits. */
  const narrativeReviewMutationChains = new Map<string, Promise<void>>()
  /** Snapshot captured before the active provider call.  Scene acceptance
   * must re-use this exact fence instead of observing a newer cursor after a
   * concurrent story-ledger write. */
  type StoryLedgerFenceSnapshot = StoryLedgerFreshnessExpectation & { scope: StoryLedgerFreshness['scope'] }
  const storyLedgerFences = new Map<string, StoryLedgerFenceSnapshot>()
  let recoverNarrativeReview: ((packet: NarrativeSemanticReviewPacket) => Promise<NarrativeSemanticReviewPacket | null>) | null = null

  const withRunBudgetLock = <T>(runId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = budgetMutationChains.get(runId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(() => undefined, () => undefined)
    budgetMutationChains.set(runId, tail)
    void tail.finally(() => {
      if (budgetMutationChains.get(runId) === tail) budgetMutationChains.delete(runId)
    })
    return result
  }

  const withNarrativeReviewLock = <T>(runId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = narrativeReviewMutationChains.get(runId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(() => undefined, () => undefined)
    narrativeReviewMutationChains.set(runId, tail)
    void tail.finally(() => {
      if (narrativeReviewMutationChains.get(runId) === tail) narrativeReviewMutationChains.delete(runId)
    })
    return result
  }

  /**
   * Serialize budget snapshots per run.  A provider reservation is not
   * complete until this promise resolves; taking a JSON snapshot at enqueue
   * time also prevents a later mutation from making an older queued write
   * overwrite the newer counter after a delayed store call.
   */
  const persistRunBudget = (state: RunBudgetState): Promise<void> => {
    state.updatedAt = now()
    const snapshot = JSON.stringify({
      ...state,
      limits: { ...state.limits },
      callsByActor: { ...state.callsByActor },
      retriesByActor: { ...state.retriesByActor },
      recentWriterRounds: state.recentWriterRounds.map((entry) => ({ ...entry })),
      tokenReservations: state.tokenReservations.map((entry) => ({ ...entry })),
      settledTokenReservations: state.settledTokenReservations.map((entry) => ({ ...entry }))
    })
    const previous = budgetSaveChains.get(state.runId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => store.saveRunEvidence(state.runId, RUN_BUDGET_EVIDENCE_KIND, snapshot))
    budgetSaveChains.set(state.runId, next)
    return next
  }

  const loadRunBudget = async (runId: string, config: RunConfig, startedAt: number): Promise<RunBudgetState> => {
    const cached = runBudgets.get(runId)
    if (cached) return cached
    let state: RunBudgetState | null = null
    const durable = await store.getRunEvidence(runId, RUN_BUDGET_EVIDENCE_KIND)
    if (durable) {
      try {
        const parsed = JSON.parse(durable.json) as unknown
        if (validBudgetState(parsed, runId)) state = normalizeBudgetState(parsed, now())
      } catch {
        state = null
      }
    }
    if (!state) state = makeRunBudgetState(runId, config, startedAt, now())
    else {
      // A restored snapshot may have been produced by an older or looser
      // configuration.  Restart must never widen a frozen run cap or reset its
      // wall-clock origin.
      state.limits = tighterRunBudgetLimits(state.limits, runBudgetLimits(config))
      state.startedAt = Math.min(state.startedAt, startedAt)
    }
    if (config.workBudgetPolicy === 'explicit_v1') {
      const turns = await store.getTurns(runId)
      state.writerRounds = Math.max(state.writerRounds ?? 0, turns.filter(turn => turn.role === 'assistant').length)
    }
    // A provider-attempt record is written at the actual request boundary.
    // Reconcile it on every fresh engine instance so a crash between an
    // evidence write and the next checkpoint cannot reset the call count.
    if (store.getProviderAttempts) {
      const attempts = await store.getProviderAttempts(runId)
      state = deriveBudgetFromProviderAttempts(state, attempts, now())
      state = reconcileTokenReservationsFromProviderAttempts(state, attempts, now())
    }
    runBudgets.set(runId, state)
    await persistRunBudget(state)
    return state
  }

  const reconcileRunBudgetUnlocked = async (runId: string): Promise<RunBudgetState> => {
    const m = mem.get(runId)
    let state = runBudgets.get(runId)
    if (!state) throw new Error(`run budget 未初始化: ${runId}`)
    if (store.getProviderAttempts) {
      const attempts = await store.getProviderAttempts(runId)
      state = deriveBudgetFromProviderAttempts(state, attempts, now())
      state = reconcileTokenReservationsFromProviderAttempts(state, attempts, now())
      runBudgets.set(runId, state)
    }
    if (m) {
      const usageTokens = await store.getUsageTotalTokens(runId)
      // usage_log is the token source of truth.  A missing/zero provider
      // usage value is never converted into a fake cost or token credit.
      const knownTokens = Number.isFinite(usageTokens) ? Math.max(0, usageTokens) : 0
      const recordedTokens = state.knownInputTokens + state.knownOutputTokens
      if (knownTokens > recordedTokens) {
        state.knownOutputTokens += knownTokens - recordedTokens
        state.updatedAt = now()
      }
    }
    await persistRunBudget(state)
    return state
  }

  /** Convert all reservations belonging to the current logical call into a
   * durable upper-bound spend.  A missing terminal usage is intentionally not
   * released as free: a provider may have charged an interrupted request. */
  const settleCostReservations = async (runId: string, logicalCallId: string): Promise<void> => {
    await withRunBudgetLock(runId, async () => {
      const state = runBudgets.get(runId)
      if (!state || state.reservedCostAttempts <= 0) return
      const ids = (state.costReservations ?? []).filter(row => row.logicalCallId === logicalCallId).map(row => row.reservationId)
      if (!settleProviderCostBudget(state, ids, now())) return
      try {
        await persistRunBudget(state)
      } catch (error) {
        throw new RunBudgetExceededError('run_budget_persistence', `运行费用账本无法持久化：${errMsg(error)}`)
      }
    })
  }

  /** Reserve the complete input+output upper bound for one logical provider
   * attempt. The durable key is the adapter's logicalCallId plus innerAttempt;
   * an equal callback is a no-op, while a larger exact envelope may only top
   * up the existing reservation. */
  const reserveProviderTokens = async (
    runId: string,
    logicalCallId: string,
    innerAttempt: number,
    request: ProviderTokenRequestBoundary
  ): Promise<void> => {
    await withRunBudgetLock(runId, async () => {
      const state = runBudgets.get(runId)
      if (!state) throw new RunBudgetExceededError('run_provider_call_cap', 'run Provider budget 尚未初始化，已拒绝继续调用')
      const result = reserveProviderTokenBudget(state, logicalCallId, innerAttempt, request, now())
      if (result === 'unchanged') return
      if (result === 'corrupt') {
        try {
          await persistRunBudget(state)
        } catch (error) {
          throw new RunBudgetExceededError('run_budget_persistence', `运行 token 账本无法持久化，已拒绝调用 Provider：${errMsg(error)}`)
        }
        throw new RunBudgetExceededError('run_token_budget', budgetMessage('run_token_budget', state))
      }
      try {
        await persistRunBudget(state)
      } catch (error) {
        throw new RunBudgetExceededError('run_budget_persistence', `运行 token 预算无法持久化，已拒绝调用 Provider：${errMsg(error)}`)
      }
    })
  }

  /** Settle each attempt exactly once. A terminal usage pair is charged to the
   * final attempt; failed/retried attempts and missing/partial usage consume
   * their own reserved upper bound. An observed overrun is retained and
   * converted to a hard deny for subsequent attempts. */
  const settleProviderTokens = async (
    runId: string,
    reservations: Array<{ reservationId: string; innerAttempt: number }>,
    usage: { inputTokens?: number; outputTokens?: number } | null
  ): Promise<void> => {
    if (reservations.length === 0) return
    let overrun = false
    await withRunBudgetLock(runId, async () => {
      const state = runBudgets.get(runId)
      if (!state) return
      const result = settleProviderTokenBudget(state, reservations, usage, now())
      overrun = result.overrun
      if (!result.changed) return
      try {
        await persistRunBudget(state)
      } catch (error) {
        throw new RunBudgetExceededError('run_budget_persistence', `运行 token 账本无法持久化：${errMsg(error)}`)
      }
    })
    if (overrun) throw new RunBudgetExceededError('run_token_budget', 'Provider 实际 token 用量超过预留上界，已保留超支证据并暂停')
  }

  const assertProviderAttempt = async (state: RunBudgetState, actor: RunBudgetActor, innerAttempt: number, targetWindowRepair: boolean, logicalWriterRound = false): Promise<void> => {
    reserveProviderAttemptBudget(state, actor, innerAttempt, targetWindowRepair, now())
    if (state.workBudgetPolicy === 'explicit_v1' && actor === 'writer' && logicalWriterRound) state.writerRounds = (state.writerRounds ?? 0) + 1
    try {
      await persistRunBudget(state)
    } catch (error) {
      throw new RunBudgetExceededError('run_budget_persistence', `运行预算账本无法持久化，已拒绝继续调用 Provider：${errMsg(error)}`)
    }
  }

  const reserveProviderAttempt = async (runId: string, actor: RunBudgetActor, targetWindowRepair = false): Promise<void> => {
    try {
      await withRunBudgetLock(runId, async () => {
        const state = await reconcileRunBudgetUnlocked(runId)
        await assertProviderAttempt(state, actor, 1, targetWindowRepair, true)
      })
    } catch (error) {
      if (error instanceof RunBudgetExceededError) throw error
      throw new RunBudgetExceededError('run_budget_persistence', `运行预算账本无法持久化，已拒绝继续调用 Provider：${errMsg(error)}`)
    }
  }

  const reserveRetryAttempt = async (runId: string, actor: RunBudgetActor): Promise<void> => {
    await withRunBudgetLock(runId, async () => {
      if (!runBudgets.has(runId)) throw new RunBudgetExceededError('run_provider_call_cap', 'run Provider budget 尚未初始化，已拒绝继续调用')
      const state = await reconcileRunBudgetUnlocked(runId)
      await assertProviderAttempt(state, actor, 2, false)
    })
  }

  const reserveProviderCost = async (runId: string, logicalCallId: string, innerAttempt: number, quote: ProviderCostQuote | undefined): Promise<void> => {
    await withRunBudgetLock(runId, async () => {
      const state = runBudgets.get(runId)
      if (!state) throw new RunBudgetExceededError('run_provider_call_cap', 'run Provider budget 尚未初始化，已拒绝继续调用')
      try {
        if (!reserveProviderCostBudget(state, logicalCallId, innerAttempt, quote, now())) return
        await persistRunBudget(state)
      } catch (error) {
        if (error instanceof RunBudgetExceededError) throw error
        throw new RunBudgetExceededError('run_budget_persistence', `运行费用预算无法持久化，已拒绝调用 Provider：${errMsg(error)}`)
      }
    })
  }

  const readWriterProgress = async (runId: string): Promise<{ state: RunBudgetState; recentDeltas: number[] }> => {
    return withRunBudgetLock(runId, async () => {
      let state: RunBudgetState
      try {
        state = await reconcileRunBudgetUnlocked(runId)
      } catch (error) {
        if (error instanceof RunBudgetExceededError) throw error
        throw new RunBudgetExceededError('run_budget_persistence', `运行预算账本无法持久化，已暂停写作：${errMsg(error)}`)
      }
      return { state, recentDeltas: state.recentWriterRounds.map((entry) => entry.acceptedDelta) }
    })
  }

  const observeWriterRound = async (runId: string, round: number, measuredChars: number): Promise<{ state: RunBudgetState; previousDelta: number | null; recentDeltas: number[] }> => {
    return withRunBudgetLock(runId, async () => {
      let state: RunBudgetState
      try {
        state = await reconcileRunBudgetUnlocked(runId)
      } catch (error) {
        if (error instanceof RunBudgetExceededError) throw error
        throw new RunBudgetExceededError('run_budget_persistence', `运行预算账本无法持久化，已暂停写作：${errMsg(error)}`)
      }
      const previous = state.lastWriterRound
      const observedRound = previous ? Math.max(round, previous.round + 1) : Math.max(1, round)
      let previousDelta: number | null = null
    // `round` is local to one step invocation.  On restore it starts at 1
    // again, so comparing it with the durable round would silently discard a
    // zero-progress sample.  Every call to this observer is one completed
    // writer round; keep the durable sequence monotonic instead.
      if (previous) {
        previousDelta = Math.max(0, measuredChars - previous.measuredChars)
        state.recentWriterRounds.push({ round: observedRound, beforeChars: previous.measuredChars, afterChars: measuredChars, acceptedDelta: previousDelta, observedAt: now() })
        if (state.recentWriterRounds.length > MAX_PROGRESS_ROUNDS) state.recentWriterRounds.splice(0, state.recentWriterRounds.length - MAX_PROGRESS_ROUNDS)
        state.zeroProgressRounds = previousDelta === 0 ? state.zeroProgressRounds + 1 : 0
      } else {
        // A first completed writer output with no accepted text is already
        // one zero-progress round; it must not get a free uncounted attempt.
        state.zeroProgressRounds = measuredChars === 0 ? 1 : 0
      }
      state.lastWriterRound = { round: observedRound, measuredChars }
      try {
        await persistRunBudget(state)
      } catch (error) {
        if (error instanceof RunBudgetExceededError) throw error
        throw new RunBudgetExceededError('run_budget_persistence', `运行预算账本无法持久化，已暂停写作：${errMsg(error)}`)
      }
      return { state, previousDelta, recentDeltas: state.recentWriterRounds.map((entry) => entry.acceptedDelta) }
    })
  }

  const observeAcceptedWriterRound = async (runId: string, round: number): Promise<void> => {
    const segments = await getManuscriptSegments(runId)
    const acceptedChars = acceptedManuscriptSegments(segments).reduce((sum, segment) => sum + segment.charCount, 0)
    await observeWriterRound(runId, round, acceptedChars)
  }

  const usesUnboundedRejectedWritingProgress = (runId: string): boolean => {
    const config = getConfig(runId)
    // This guard fills the new uncapped repair path only. Existing finite or
    // legacy runs retain their frozen budget/review/recovery boundaries.
    if (config.workBudgetPolicy !== 'explicit_v1' || config.maxTurns !== null) return false
    const contract = config.completionContract as CompletionContract | undefined
    if ((contract?.tokenBudget ?? 0) > 0 || (contract?.wallClockBudgetMs ?? 0) > 0) return false
    const limits = runBudgets.get(runId)?.limits
    return Boolean(limits && limits.maxCalls === null && limits.maxTokens === null &&
      limits.maxWallClockMs === null && limits.maxCost === null && limits.maxCostCny === null)
  }

  /** Rejected drafts never reach the accepted-text progress observer. Compare
   * otherwise unbounded rejected work, without replacing a bounded repair.
   * Prefix/contract/evidence changes are distinct work, not an attempt budget. */
  const observeRejectedWritingCandidate = async (runId: string, turnId: string, stage: 'scene_contract' | 'narrative_quality', candidate: string, contractHash: string, evidence: unknown): Promise<void> => {
    if (!usesUnboundedRejectedWritingProgress(runId)) return
    const acceptedPrefix = await acceptedTextForRun(runId)
    const identity = { stage, candidateHash: manuscriptSegmentHash(candidate), acceptedPrefixHash: manuscriptSegmentHash(acceptedPrefix), contractHash, evidence }
    const fingerprint = writingTextHash(stableNarrativeJson(identity))
    const kind = 'rejected_writing_progress_v1'
    const saved = await store.getRunEvidence(runId, kind)
    let previous: { schemaVersion?: number; fingerprint?: string; turnId?: string } | null = null
    try { previous = saved ? JSON.parse(saved.json) : null } catch { /* No prior identity can be proved. */ }
    const stalled = previous?.schemaVersion === 1 && previous.fingerprint === fingerprint && previous.turnId !== turnId
    // The latch precedes the run-row update so restart cannot reopen the
    // same rejected work if the process dies between those two writes.
    await store.saveRunEvidence(runId, kind, JSON.stringify({ schemaVersion: 1, ...identity, fingerprint, turnId, stalled, observedAt: now() }))
    if (stalled && !mem.get(runId)?.controller.signal.aborted && !mem.get(runId)?.done) {
      await pauseForRunBudget(runId, 'writing_rejected_no_progress', '相同拒绝稿与校验失败证据没有变化，已暂停自动重试。请检查保存的候选与场景要求后调整任务，或停止当前任务。')
    }
  }

  const pauseForRunBudget = async (runId: string, errorCode: string, message: string): Promise<void> => {
    const m = mem.get(runId)
    if (!m || m.done || isTerminal(m.run.status)) return
    await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode, errorMessage: message })
    emit(runId, { type: 'phase', phase: 'paused', title: '等待你的决定', detail: message })
  }

  const storyEpochInvalidationMessage = '故事线撤回使当前运行所在的旧有效期失效；请基于当前安全故事线新建分支'
  const storyLedgerConcurrentHeadMessage = '故事线在模型调用期间发生变化；当前结果未被接纳，请基于最新故事线重试'

  type StoryLedgerFenceErrorCode = 'story_ledger_epoch_invalidated' | 'story_ledger_concurrent_head_conflict'

  /**
   * A story retraction is an execution boundary as well as a ledger write.
   * Keep the durable run state and the in-memory controller aligned before
   * surfacing the error, so a late provider stream cannot continue normally
   * and the generic step-failure path cannot downgrade it to `failed`.
   */
  const invalidateStoryLedger = async (
    runId: string,
    errorCode: StoryLedgerFenceErrorCode,
    errorMessage: string,
    title: string
  ): Promise<never> => {
    storyLedgerFences.delete(runId)
    const m = mem.get(runId)
    try {
      await store.updateRun(runId, {
        status: 'recovery_required',
        phase: 'recovery_required',
        errorCode,
        errorMessage
      })
    } catch {
      // The repository already performs the durable invalidation. A transport
      // failure here must not allow the in-memory loop to keep writing.
    }
    if (m && !isTerminal(m.run.status)) {
      m.run = {
        ...m.run,
        status: 'recovery_required',
        phase: 'recovery_required',
        errorCode,
        errorMessage,
        updatedAt: now()
      }
      m.done = true
      m.controller.abort()
      onRunUpdate(m.run)
      emit(runId, { type: 'phase', phase: 'recovery_required', title, detail: errorMessage })
    }
    const error = new Error(errorCode) as Error & { code?: string }
    error.code = errorCode
    throw error
  }

  const invalidateStoryEpoch = async (runId: string): Promise<never> => invalidateStoryLedger(
    runId,
    'story_ledger_epoch_invalidated',
    storyEpochInvalidationMessage,
    '故事线已失效'
  )

  const invalidateStoryHead = async (runId: string): Promise<never> => invalidateStoryLedger(
    runId,
    'story_ledger_concurrent_head_conflict',
    storyLedgerConcurrentHeadMessage,
    '故事线发生并发变化'
  )

  const assertStoryLedgerEpoch = async (runId: string): Promise<void> => {
    if (!store.getNarrativeLedgerScope) return
    let scope: Awaited<ReturnType<NonNullable<RunStorePort['getNarrativeLedgerScope']>>>
    try {
      scope = await store.getNarrativeLedgerScope(runId)
    } catch (error) {
      if (errCode(error) === 'story_ledger_epoch_invalidated' || errMsg(error) === 'story_ledger_epoch_invalidated') return await invalidateStoryEpoch(runId)
      throw error
    }
    if (scope && (scope.epochValid === false || scope.validityEpoch !== scope.headValidityEpoch)) await invalidateStoryEpoch(runId)
  }

  /** Capture the complete cursor/head/epoch tuple before a provider request.
   * A null result is reserved for compatibility stores that predate the
   * exact freshness port; production's repository adapter always returns the
   * tuple and therefore takes the strict path below. */
  const captureStoryLedgerFence = async (runId: string): Promise<StoryLedgerFenceSnapshot | null> => {
    if (!store.getStoryLedgerFreshness) {
      await assertStoryLedgerEpoch(runId)
      return null
    }
    let freshness: Awaited<ReturnType<NonNullable<RunStorePort['getStoryLedgerFreshness']>>>
    try {
      freshness = await store.getStoryLedgerFreshness(runId)
    } catch (error) {
      if (errCode(error) === 'story_ledger_epoch_invalidated' || errMsg(error) === 'story_ledger_epoch_invalidated') return await invalidateStoryEpoch(runId)
      if (errCode(error) === 'story_ledger_concurrent_head_conflict' || errMsg(error) === 'story_ledger_concurrent_head_conflict') return await invalidateStoryHead(runId)
      throw error
    }
    if (!freshness) {
      await assertStoryLedgerEpoch(runId)
      return null
    }
    if (!freshness.epochValid || freshness.validityEpoch !== freshness.headValidityEpoch) await invalidateStoryEpoch(runId)
    if (!freshness.headMatchesCursor || !freshness.fresh) await invalidateStoryHead(runId)
    return {
      runId,
      expectedRevision: freshness.runRevision,
      expectedEpoch: freshness.validityEpoch,
      expectedHeadRevision: freshness.headRevision,
      expectedHeadHash: freshness.headHash,
      scope: freshness.scope
    }
  }

  /** Re-check the exact tuple captured before the provider call.  The
   * repository implementation performs this check against its current
   * transaction snapshot; the fallback keeps synthetic/legacy stores
   * compatible without weakening the production path. */
  const assertStoryLedgerFence = async (fence: StoryLedgerFreshnessExpectation): Promise<void> => {
    try {
      if (store.assertStoryLedgerFresh) {
        await store.assertStoryLedgerFresh(fence)
        return
      }
      if (!store.getStoryLedgerFreshness) {
        await assertStoryLedgerEpoch(fence.runId)
        return
      }
      const current = await store.getStoryLedgerFreshness(fence.runId)
      if (!current) {
        await assertStoryLedgerEpoch(fence.runId)
        return
      }
      if (!current.epochValid || current.validityEpoch !== fence.expectedEpoch || current.headValidityEpoch !== fence.expectedEpoch) await invalidateStoryEpoch(fence.runId)
      if (!current.fresh || !current.headMatchesCursor || current.runRevision !== fence.expectedRevision || current.headRevision !== fence.expectedHeadRevision || current.headHash !== fence.expectedHeadHash) await invalidateStoryHead(fence.runId)
    } catch (error) {
      if (errCode(error) === 'story_ledger_epoch_invalidated' || errMsg(error) === 'story_ledger_epoch_invalidated') return await invalidateStoryEpoch(fence.runId)
      if (errCode(error) === 'story_ledger_concurrent_head_conflict' || errMsg(error) === 'story_ledger_concurrent_head_conflict') return await invalidateStoryHead(fence.runId)
      throw error
    }
  }

  /** Use the provider fence when one exists; otherwise retain the older
   * epoch-only compatibility boundary for test stores without the port. */
  const assertProviderStoryLedgerFence = async (runId: string, fence: StoryLedgerFreshnessExpectation | null): Promise<void> => {
    if (fence) {
      await assertStoryLedgerFence(fence)
      return
    }
    await assertStoryLedgerEpoch(runId)
  }

  /** A review decision may be replayed after a restart, but a durable review
   * packet is not a provider-time ledger fence.  Production must therefore
   * fail closed when the in-memory provider snapshot is gone instead of
   * silently blessing a newer head.  Compatibility stores without the exact
   * freshness port retain only their older epoch check. */
  const assertLatestStoryLedgerFence = async (runId: string): Promise<void> => {
    const captured = storyLedgerFences.get(runId)
    if (captured) {
      await assertStoryLedgerFence(captured)
      return
    }
    if (store.getStoryLedgerFreshness) throw new Error('story_ledger_fence_missing')
    await assertStoryLedgerEpoch(runId)
  }

  // Written inside the candidate/critic journal's single atomic evidence row.
  // Only the original provider snapshot is eligible, never today's head.
  const writingProviderFence = (input: { runId: string; turnId: string; policyHash: string; candidate: string; segmentId?: string; revision?: number }): object | null => {
    const fence = storyLedgerFences.get(input.runId)
    if (!fence) return null
    const body = { schemaVersion: 1, runId: input.runId, turnId: input.turnId, policyHash: input.policyHash,
      candidateHash: writingTextHash(input.candidate), candidateCharCount: codePointLength(input.candidate),
      segmentId: input.segmentId ?? null, segmentRevision: input.segmentId ? input.revision ?? null : null, fence }
    return { ...body, hash: createHash('sha256').update(stableNarrativeJson(body)).digest('hex') }
  }

  const restoreWritingProviderFence = async (runId: string, turn: TurnRecord, policyHash: string, evidence: Record<string, unknown>, candidateHash: string): Promise<void> => {
    if (!store.getStoryLedgerFreshness) return // Legacy compatibility ports only.
    const corrupt = (): never => { throw new Error('writing_provider_fence_corrupt') }
    const value = evidence.providerFence
    if (value === undefined || value === null) throw new Error('writing_provider_fence_missing')
    if (typeof value !== 'object' || Array.isArray(value)) corrupt()
    const record = value as Record<string, unknown>
    const keys = ['schemaVersion', 'runId', 'turnId', 'policyHash', 'candidateHash', 'candidateCharCount', 'segmentId', 'segmentRevision', 'fence', 'hash']
    const { hash, ...body } = record
    if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key)) ||
      record.schemaVersion !== 1 || record.runId !== runId || record.turnId !== turn.turnId || record.policyHash !== policyHash ||
      record.candidateHash !== candidateHash || !Number.isSafeInteger(record.candidateCharCount) || Number(record.candidateCharCount) < 1 ||
      !sha256Hex(hash) || createHash('sha256').update(stableNarrativeJson(body)).digest('hex') !== hash ||
      record.segmentId !== (evidence.criticSegmentId ?? null)) corrupt()
    if (typeof record.segmentId === 'string') {
      const currentSegments = store.getManuscriptSegments ? await store.getManuscriptSegments(runId) : [...fallbackSegmentsFor(runId).values()]
      const segment = currentSegments.find(item => item.segmentId === record.segmentId)
      if (!segment || segment.sourceTurnId !== turn.turnId || segment.kind !== 'prose' || segment.status !== 'candidate' ||
        segment.revision !== record.segmentRevision || segment.contentHash !== candidateHash || manuscriptSegmentHash(segment.content) !== candidateHash ||
        segment.charCount !== record.candidateCharCount || codePointLength(segment.content) !== record.candidateCharCount) corrupt()
    } else if (record.segmentId !== null || record.segmentRevision !== null || isLongWriteConfig(getConfig(runId)) ||
      writingTextHash(turn.content) !== candidateHash || codePointLength(turn.content) !== record.candidateCharCount) corrupt()
    if (!record.fence || typeof record.fence !== 'object' || Array.isArray(record.fence)) corrupt()
    const fence = record.fence as StoryLedgerFenceSnapshot
    const fenceKeys = ['runId', 'expectedRevision', 'expectedEpoch', 'expectedHeadRevision', 'expectedHeadHash', 'scope']
    if (Object.keys(fence).length !== fenceKeys.length || Object.keys(fence).some(key => !fenceKeys.includes(key)) || fence.runId !== runId ||
      !Number.isSafeInteger(fence.expectedRevision) || fence.expectedRevision < 0 || !Number.isSafeInteger(fence.expectedEpoch) || fence.expectedEpoch < 1 ||
      !Number.isSafeInteger(fence.expectedHeadRevision) || fence.expectedHeadRevision < fence.expectedRevision ||
      (fence.expectedHeadRevision === 0 ? fence.expectedHeadHash !== null : !sha256Hex(fence.expectedHeadHash))) corrupt()
    let scope: StoryLedgerFreshness['scope']
    try { scope = validateNarrativeLedgerScope(fence.scope) } catch { corrupt() }
    if (Object.keys(fence.scope).length !== 4 || stableNarrativeJson(scope!) !== stableNarrativeJson(fence.scope)) corrupt()
    const configuredScope = getConfig(runId).storyScope
    if (configuredScope && stableNarrativeJson(validateNarrativeLedgerScope(configuredScope as StoryLedgerFreshness['scope'])) !== stableNarrativeJson(scope!)) corrupt()
    const authority = await store.getStoryLedgerFreshness(runId)
    if (!authority || stableNarrativeJson(authority.scope) !== stableNarrativeJson(scope!)) corrupt()
    await assertStoryLedgerFence(fence)
    storyLedgerFences.set(runId, fence)
  }

  const callModel = async (input: {
    runId: string
    phase: RunPhase
    turnSeq: number
    round: number
    messages: DsMessage[]
    purpose?: RunBudgetActor
    targetWindowRepair?: boolean
    sceneBeatRepair?: SceneBeatRepairRequest
  }): Promise<AsyncIterable<ModelEvent>> => {
    const storyFence = await captureStoryLedgerFence(input.runId)
    if (storyFence) storyLedgerFences.set(input.runId, storyFence)
    else storyLedgerFences.delete(input.runId)
    const actor = input.purpose ?? 'writer'
    const config = getConfig(input.runId)
    const frozenContext = config.frozenContext as FrozenContextSnapshotV2 | undefined
    const agentMessages = actor === 'writer' && config.runMode === 'agent' && !config.longMode ? compactWorkPlanHistory(input.messages) : input.messages
    const shortened = actor === 'writer' && config.runMode === 'agent' && config.longMode !== true &&
      frozenContext?.mode === 'optimized' && frozenContext.policy?.olderToolReads === 'excerpt_v1'
      ? projectOlderReadResults(agentMessages) : null
    const messages = shortened?.messages ?? agentMessages
    await reserveProviderAttempt(input.runId, actor, input.targetWindowRepair === true)
    const logicalCallId = randomUUID()
    const fallbackRequest: ProviderTokenRequestBoundary = {
      messages,
      maxTokens: modelOutputTokensFromConfig(config)
    }
    // Reserve a conservative fallback before invoking a synthetic model seam.
    // The native adapter immediately tops this up with the exact serialized
    // body, while a test/provider implementation that omits the hook remains
    // covered by the same hard token gate.
    const tokenReservations = new Map<number, { reservationId: string; innerAttempt: number }>()
    const fallbackReservationId = `${logicalCallId}\u00001`
    tokenReservations.set(1, { reservationId: fallbackReservationId, innerAttempt: 1 })
    await reserveProviderTokens(input.runId, logicalCallId, 1, fallbackRequest)
    // A provider/test seam must be allowed to report a retry exactly once.
    // Keep the logical call's reservation identity local so a duplicate
    // callback cannot double-count either the hard call cap or a scene repair.
    const reservedInnerAttempts = new Set<number>([1])
    let sceneRepairReserved = false
    const reserveSceneRepair = async (): Promise<void> => {
      if (!input.sceneBeatRepair || sceneRepairReserved) return
      await withRunBudgetLock(input.runId, async () => {
        const m = mem.get(input.runId)
        if (m?.controller.signal.aborted) throw new Error('scene_beat_repair_aborted')
        const request = input.sceneBeatRepair!
        const plan = getConfig(input.runId).sceneContracts as SceneContractPlan | undefined
        const contract = plan?.contracts.find(item => item.sceneId === request.sceneId && item.frozenHash === request.contractHash)
        if (!contract || !sceneContractPlanValid(plan)) throw new RunBudgetExceededError('run_budget_persistence', '场景修订冻结契约已变化，未调用 Provider')
        try {
          const row = await store.getRunEvidence(input.runId, sceneBeatRepairEvidenceKind(contract.sceneId))
          const ledger = readSceneBeatRepairLedger(row?.json, input.runId, contract)
          const reserved = reserveSceneBeatRepair(ledger, request.requestHash, logicalCallId, now())
          await store.saveRunEvidence(input.runId, sceneBeatRepairEvidenceKind(contract.sceneId), JSON.stringify(reserved))
          sceneRepairReserved = true
        } catch (error) {
          throw new RunBudgetExceededError('run_budget_persistence', `场景修订预算无法验证或持久化，未调用 Provider：${errMsg(error)}`)
        }
      })
    }
    let iterable: AsyncIterable<ModelEvent>
    try {
      iterable = await modelCall({
        runId: input.runId,
        phase: input.phase,
        turnSeq: input.turnSeq,
        round: input.round,
        messages,
        ...(shortened ? { liveToolProjection: shortened.projection } : {}),
        purpose: input.purpose,
        logicalCallId,
        beforeProviderAttempt: async ({ innerAttempt, logicalCallId: callbackLogicalCallId, request, costQuote }) => {
          await assertProviderStoryLedgerFence(input.runId, storyFence)
          // Attempt 1 was reserved immediately above. Only retries need a
          // second call reservation; every inner attempt gets its own token
          // reservation, even when a provider reports the callback twice.
          if (!Number.isInteger(innerAttempt) || innerAttempt < 1) return
          if (!reservedInnerAttempts.has(innerAttempt)) {
            await reserveRetryAttempt(input.runId, actor)
            reservedInnerAttempts.add(innerAttempt)
          }
          // The adapter is expected to echo the outer logical id. If a custom
          // seam supplies another id, keep the local id so the pre-call
          // fallback reservation is topped up rather than orphaned.
          const reservationLogicalCallId = callbackLogicalCallId === logicalCallId ? callbackLogicalCallId : logicalCallId
          const reservationId = `${reservationLogicalCallId}\u0000${innerAttempt}`
          tokenReservations.set(innerAttempt, { reservationId, innerAttempt })
          // Keep the existing cost gate in front of token top-up. If token
          // capacity rejects, any cost reservation is settled conservatively
          // by the surrounding failure/finally path and no fetch is reached.
          await reserveProviderCost(input.runId, reservationLogicalCallId, innerAttempt, costQuote)
          await reserveProviderTokens(input.runId, reservationLogicalCallId, innerAttempt, request ?? fallbackRequest)
          // Charge once per logical rewrite, only after the actual pre-fetch
          // cost/token/call gates passed. Retry callbacks cannot charge twice.
          await reserveSceneRepair()
        }
      })
      // The retraction/head-write may race with a provider returning its
      // stream handle. Settle reservations through this same failure path
      // before exposing the stale stream to the caller.
      await assertProviderStoryLedgerFence(input.runId, storyFence)
      // Synthetic model seams may omit beforeProviderAttempt. Their stream
      // still cannot be consumed until the same durable rewrite reservation.
      await reserveSceneRepair()
    } catch (error) {
      let settlementError: unknown = null
      try {
        await settleProviderTokens(input.runId, [...tokenReservations.values()], null)
      } catch (settleError) {
        settlementError = settleError
      }
      try {
        await settleCostReservations(input.runId, logicalCallId)
      } catch (settleError) {
        settlementError ??= settleError
      }
      throw settlementError ?? error
    }
    // Keep a cost reservation until the provider stream reaches a terminal
    // boundary (or is interrupted).  Converting it to spent upper-bound in a
    // finally block means failures and cancellations cannot leak a free
    // reservation that a restart could spend again.
    return (async function* (): AsyncGenerator<ModelEvent> {
      let observedUsage: { inputTokens?: number; outputTokens?: number } | null = null
      let terminalError: unknown = null
      let lastPerformance: ProviderPerformanceSnapshot | undefined
      let lastPerformanceAt = 0
      try {
        for await (const event of iterable) {
          if (event.type === 'performance' && event.performance) {
            lastPerformance = { ...event.performance, scope: { runId: input.runId, turnSeq: input.turnSeq, round: input.round, actor } }
            lastPerformanceAt = performance.now()
            emit(input.runId, { type: 'performance', performance: lastPerformance })
            continue
          }
          await assertProviderStoryLedgerFence(input.runId, storyFence)
          if (event.type === 'usage' && event.usage) {
            observedUsage = {
              ...(event.usage.inputTokens !== undefined ? { inputTokens: event.usage.inputTokens } : {}),
              ...(event.usage.outputTokens !== undefined ? { outputTokens: event.usage.outputTokens } : {})
            }
          }
          yield event
        }
        // Catch a head/revision write that lands after the final provider
        // event but before the caller turns that stream into a scene commit.
        await assertProviderStoryLedgerFence(input.runId, storyFence)
      } catch (error) {
        terminalError = error
      } finally {
        // A consumer may stop iterating immediately on abort, before the wire
        // terminal reaches its queue. Close the display sample without making
        // up usage; the independent durable attempt callback still bills it.
        if (lastPerformance && (lastPerformance.status === 'waiting' || lastPerformance.status === 'streaming')) {
          const cancelled = mem.get(input.runId)?.controller.signal.aborted === true
          emit(input.runId, { type: 'performance', performance: { ...lastPerformance, revision: lastPerformance.revision + 1,
            status: cancelled ? 'cancelled' : 'failed', elapsedMs: lastPerformance.elapsedMs + Math.max(0, performance.now() - lastPerformanceAt),
            estimatedTokensPerSecond: null, actualTokensPerSecond: null } })
        }
        try {
          await settleProviderTokens(input.runId, [...tokenReservations.values()], observedUsage)
        } catch (error) {
          terminalError ??= error
        }
        try {
          await settleCostReservations(input.runId, logicalCallId)
        } catch (error) {
          terminalError ??= error
        }
      }
      if (terminalError) throw terminalError
    })()
  }

  // chat:start starts the asynchronous step immediately after the accept
  // transaction.  The production config cache is populated by the IPC layer
  // after the ACK, so the first cycle must be able to use the immutable config
  // already persisted on the run row.  This also makes restore/restart robust:
  // an empty in-memory cache never silently becomes an empty execution config.
  const getConfig = (runId: string): RunConfig => {
    const cached = suppliedGetConfig(runId)
    if (cached && Object.keys(cached).length > 0) return cached
    const persisted = mem.get(runId)?.run.configJson
    if (!persisted) return cached
    try {
      const parsed = JSON.parse(persisted) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RunConfig : cached
    } catch {
      return cached
    }
  }

  const emit = (runId: string, ev: RunEngineEvent): void => onEvent(runId, ev)

  const saveFallbackSegment = (segment: ManuscriptSegment): void => {
    if (segment.contentHash !== manuscriptSegmentHash(segment.content) || segment.charCount !== codePointLength(segment.content)) throw new Error('manuscript_segment_integrity_mismatch')
    const segments = fallbackSegmentsFor(segment.runId)
    const existing = segments.get(segment.segmentId)
    if (existing && ['accepted', 'rejected', 'superseded'].includes(existing.status)) {
      const same = existing.status === segment.status && existing.kind === segment.kind && existing.content === segment.content && existing.contentHash === segment.contentHash && existing.charCount === segment.charCount
      if (!same) throw new Error('manuscript_segment_immutable')
      return
    }
    if (segment.status === 'accepted' && (segment.kind !== 'prose' || !hasNaturalProseEnding(segment.content))) throw new Error('manuscript_segment_not_complete')
    const chain: ManuscriptSegment[] = []
    const visited = new Set<string>([segment.segmentId])
    let parentId = segment.supersedesSegmentId
    while (parentId) {
      if (visited.has(parentId)) throw new Error('manuscript_partial_chain_cycle')
      const previous = segments.get(parentId)
      if (!previous) throw new Error('manuscript_partial_chain_broken')
      if (previous.runId !== segment.runId) throw new Error('manuscript_partial_chain_cross_run')
      if (previous.chunkIndex !== segment.chunkIndex || (previous.sceneId ?? null) !== (segment.sceneId ?? null)) throw new Error('manuscript_partial_chain_scope_mismatch')
      if (previous.status === 'accepted') throw new Error('manuscript_segment_accepted_cannot_supersede')
      chain.push(previous)
      visited.add(previous.segmentId)
      parentId = previous.supersedesSegmentId
    }
    if ((segment.status === 'partial' || segment.status === 'accepted') && chain.some((parent) => parent.status === 'candidate')) {
      throw new Error('manuscript_partial_candidate_ancestor')
    }
    // Keep a carried partial visible while a replacement is still only a
    // candidate. Acceptance below performs the replacement atomically in the
    // repository; this compatibility store mirrors the same graph semantics.
    if (segment.status === 'partial' || segment.status === 'accepted') {
      for (const previous of chain) {
        if (previous.status === 'partial') segments.set(previous.segmentId, { ...previous, status: 'superseded', updatedAt: segment.updatedAt })
      }
    }
    segments.set(segment.segmentId, segment)
    validateManuscriptPartialGraph([...segments.values()].map((item) => ({
      segmentId: item.segmentId,
      runId: item.runId,
      sceneId: item.sceneId,
      chunkIndex: item.chunkIndex,
      status: item.status,
      supersedesSegmentId: item.supersedesSegmentId
    })))
  }

  const fallbackSegmentsFor = (runId: string): Map<string, ManuscriptSegment> => {
    let segments = fallbackSegments.get(runId)
    if (!segments) {
      segments = new Map<string, ManuscriptSegment>()
      fallbackSegments.set(runId, segments)
    }
    return segments
  }

  const saveSegment = async (segment: ManuscriptSegment): Promise<void> => {
    if (store.saveManuscriptSegment) await store.saveManuscriptSegment(segment)
    else saveFallbackSegment(segment)
    // A small test/embedding store may expose the write port without the read
    // port. Keep the in-memory compatibility projection in that case so
    // accepted-only completion/context logic still has a source of truth.
    if (!store.getManuscriptSegments && store.saveManuscriptSegment) saveFallbackSegment(segment)
    const m = mem.get(segment.runId)
    if (m) m.manuscriptCache = null
  }

  const saveAssistantTurnWithSegment = async (turn: TurnRecord, segment: ManuscriptSegment): Promise<void> => {
    if (store.saveAssistantTurnWithSegment) await store.saveAssistantTurnWithSegment(turn, segment)
    else {
      await store.appendTurn(turn)
      saveFallbackSegment(segment)
    }
    if (!store.getManuscriptSegments && store.saveAssistantTurnWithSegment) saveFallbackSegment(segment)
    const m = mem.get(segment.runId)
    if (m) m.manuscriptCache = null
  }

  const getBackfillState = async (runId: string): Promise<LegacyManuscriptBackfillState | null> => {
    if (store.getManuscriptBackfill) return store.getManuscriptBackfill(runId)
    return fallbackBackfills.get(runId) ?? null
  }

  const saveBackfillStep = async (state: LegacyManuscriptBackfillState, segment?: ManuscriptSegment): Promise<void> => {
    if (store.saveManuscriptBackfillStep) {
      await store.saveManuscriptBackfillStep(state, segment)
    } else {
      if (segment) saveFallbackSegment(segment)
      fallbackBackfills.set(state.runId, state)
    }
    const m = mem.get(state.runId)
    if (m) m.manuscriptCache = null
  }

  const legacyArtifactForRun = async (runId: string): Promise<{ artifact: ArtifactRecord; content: string } | null> => {
    const artifacts = (await store.getArtifactsByRun(runId))
      .filter((artifact) => artifact.artifactType === 'manuscript' && artifact.status === 'completed' && Boolean(artifact.hash))
      .sort((a, b) => a.createdAt - b.createdAt || a.artifactId.localeCompare(b.artifactId))
    for (const artifact of artifacts) {
      const content = await store.getArtifactContent(artifact.hash).catch(() => null)
      if (content === null) continue
      if (manuscriptSegmentHash(content) !== artifact.hash || codePointLength(content) !== artifact.charCount) continue
      return { artifact, content }
    }
    return null
  }

  const shouldUseLegacyBackfill = (config: RunConfig, run: RunRecord): boolean =>
    isLongWriteConfig(config) && config.manuscriptSegmentsVersion !== 1 && run.status !== 'failed' && run.status !== 'cancelled'

  const ensureLegacyBackfill = async (run: RunRecord, turns: TurnRecord[], durable: ManuscriptSegment[], state: LegacyManuscriptBackfillState | null): Promise<void> => {
    const sources = legacyBackfillSourceTurns(turns)
    if (sources.length === 0 && !state) return
    const existingBySource = new Map(durable.flatMap((segment) => segment.sourceTurnId ? [[segment.sourceTurnId, segment]] as const : []))
    const alignWithExistingSegment = (planned: ManuscriptSegment): ManuscriptSegment => {
      const existing = planned.sourceTurnId ? existingBySource.get(planned.sourceTurnId) : undefined
      if (!existing) return planned
      return {
        ...planned,
        segmentId: existing.segmentId,
        revision: existing.revision,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        ...(planned.status === 'accepted' ? { acceptedAt: existing.acceptedAt } : { acceptedAt: undefined }),
        supersedesSegmentId: undefined
      }
    }
    let current = state
    let plannedSegments: ManuscriptSegment[] = []
    if (!current) {
      const artifact = run.status === 'completed' ? await legacyArtifactForRun(run.runId) : null
      const plan = buildLegacyBackfillPlan(run, turns, artifact ? { artifactId: artifact.artifact.artifactId, hash: artifact.artifact.hash, charCount: artifact.artifact.charCount, content: artifact.content } : null)
      plannedSegments = plan.segments.map(alignWithExistingSegment)
      current = {
        ...plan.state,
        acceptedSegmentIds: plannedSegments.filter((segment) => segment.status === 'accepted').map((segment) => segment.segmentId)
      }
      await saveBackfillStep(current)
    } else {
      const expectedHash = legacyBackfillSourceSummaryHash(current.sourceTurns)
      if (expectedHash !== current.sourceSummaryHash) throw new Error('manuscript_backfill_corrupt')
      for (const source of current.sourceTurns) {
        const turn = turns.find((item) => item.turnId === source.sourceTurnId)
        if (turn && (manuscriptSegmentHash(turn.content) !== source.sourceContentHash || codePointLength(turn.content) !== source.sourceCharCount)) {
          throw new Error('manuscript_backfill_source_mismatch')
        }
      }
      if (current.status === 'complete') {
        if (!current.completionMarker || legacyBackfillCompletionMarker(current) !== current.completionMarker) throw new Error('manuscript_backfill_corrupt')
        if (current.verification !== 'artifact_exact') throw new Error('manuscript_backfill_not_verified')
        const artifact = await legacyArtifactForRun(run.runId)
        if (!artifact || artifact.artifact.hash !== current.expectedArtifactHash || artifact.artifact.charCount !== current.expectedArtifactCharCount || artifact.content !== (await Promise.resolve(durable.filter((segment) => current?.acceptedSegmentIds.includes(segment.segmentId)).sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision).map((segment) => segment.content).join('')))) {
          throw new Error('manuscript_backfill_artifact_mismatch')
        }
      }
      plannedSegments = turns
        .filter((turn) => current?.sourceTurns.some((source) => source.sourceTurnId === turn.turnId))
        .map((turn) => alignWithExistingSegment(legacyBackfillSegment(run, turn, current?.verification === 'artifact_exact')))
    }
    for (const source of current.sourceTurns) {
      if (current.processedSourceTurnIds.includes(source.sourceTurnId)) continue
      const turn = turns.find((item) => item.turnId === source.sourceTurnId)
      if (!turn) continue
      const existing = existingBySource.get(source.sourceTurnId)
      const segment = plannedSegments.find((item) => item.sourceTurnId === source.sourceTurnId) ?? existing
      if (!segment) continue
      const next = advanceLegacyBackfillState(current, source.sourceTurnId)
      await saveBackfillStep(next, alignWithExistingSegment(segment))
      current = next
    }
  }

  const getManuscriptSegments = async (runId: string, suppliedTurns?: TurnRecord[]): Promise<ManuscriptSegment[]> => {
    const run = mem.get(runId)?.run ?? await store.getRun(runId)
    if (!run) return []
    const config = getConfig(runId)
    const legacy = shouldUseLegacyBackfill(config, run)
    const cached = mem.get(runId)?.manuscriptCache
    const durable = store.getManuscriptSegments ? await store.getManuscriptSegments(runId) : [...fallbackSegmentsFor(runId).values()]
    const state = legacy ? await getBackfillState(runId) : null
    const turns = suppliedTurns ?? await store.getTurns(runId)
    if (legacy && (state || legacyBackfillSourceTurns(turns).length > 0)) {
      await ensureLegacyBackfill(run, turns, durable, state)
      const refreshed = store.getManuscriptSegments ? await store.getManuscriptSegments(runId) : [...fallbackSegmentsFor(runId).values()]
      const m = mem.get(runId)
      const acceptedSegments = acceptedManuscriptSegments(refreshed)
      if (m) m.manuscriptCache = { segments: refreshed, acceptedSegments, acceptedText: acceptedSegments.map((segment) => segment.content).join('') }
      return refreshed
    }
    if (cached) return cached.segments
    const m = mem.get(runId)
    const acceptedSegments = acceptedManuscriptSegments(durable)
    if (m) m.manuscriptCache = { segments: durable, acceptedSegments, acceptedText: acceptedSegments.map((segment) => segment.content).join('') }
    return durable
  }

  const acceptedTextForRun = async (runId: string, suppliedTurns?: TurnRecord[]): Promise<string> => {
    const cached = mem.get(runId)?.manuscriptCache
    if (cached && suppliedTurns === undefined) return cached.acceptedText
    const segments = await getManuscriptSegments(runId, suppliedTurns)
    const accepted = acceptedManuscriptSegments(segments)
    const acceptedText = accepted.map((segment) => segment.content).join('')
    const m = mem.get(runId)
    if (m && suppliedTurns === undefined) m.manuscriptCache = { segments, acceptedSegments: accepted, acceptedText }
    return acceptedText
  }

  const ensureScenePlan = async (runId: string, plan: SceneContractPlan): Promise<SceneStateRecord[]> => {
    if (store.ensureSceneStates && store.getSceneStates) {
      await store.ensureSceneStates(runId, plan, now())
      return await store.getSceneStates(runId)
    }
    let states = fallbackSceneStates.get(runId)
    if (!states || states.length !== plan.contracts.length) {
      states = plan.contracts.map((contract) => ({
        schemaVersion: 1,
        runId,
        sceneId: contract.sceneId,
        sectionId: contract.sectionId,
        contractId: contract.contractId,
        contractHash: contract.frozenHash,
        order: contract.order,
        lifecycle: 'planned' as const,
        revision: 1,
        candidateSegmentId: null,
        candidateHash: null,
        acceptedSegmentId: null,
        acceptedHash: null,
        completionDecision: null,
        completionEvidenceHash: null,
        createdAt: now(),
        updatedAt: now(),
        completedAt: null,
        committedAt: null
      }))
      fallbackSceneStates.set(runId, states)
    }
    return states
  }

  const scenePlanHasPending = async (runId: string, config: RunConfig): Promise<boolean> => {
    const plan = config.sceneContracts
    if (!sceneContractPlanValid(plan)) return false
    const states = await ensureScenePlan(runId, plan)
    return states.some((state) => state.lifecycle !== 'committed')
  }

  const transitionScene = async (input: Parameters<NonNullable<RunStorePort['transitionSceneState']>>[0]): Promise<SceneStateRecord | null> => {
    if (store.transitionSceneState) return await store.transitionSceneState(input)
    const states = fallbackSceneStates.get(input.runId) ?? []
    const state = states.find((item) => item.sceneId === input.sceneId)
    if (!state) throw new Error('scene_state_missing')
    const from = Array.isArray(input.from) ? input.from : [input.from]
    if (state.revision !== input.expectedRevision || !from.includes(state.lifecycle)) throw new Error('scene_state_revision_mismatch')
    const sameLifecycle = state.lifecycle === input.to
    state.lifecycle = input.to
    if (!sameLifecycle) state.revision += 1
    if (input.candidateSegmentId !== undefined) state.candidateSegmentId = input.candidateSegmentId
    if (input.candidateHash !== undefined) state.candidateHash = input.candidateHash
    if (input.to === 'accepted' || input.to === 'committed') {
      state.acceptedSegmentId = input.acceptedSegmentId ?? state.candidateSegmentId
      state.acceptedHash = input.acceptedHash ?? state.candidateHash
    }
    if (input.completionDecision !== undefined) state.completionDecision = input.completionDecision
    if (input.completionEvidenceHash !== undefined) state.completionEvidenceHash = input.completionEvidenceHash
    state.updatedAt = input.at
    if (input.to === 'committed') { state.completedAt ??= input.at; state.committedAt ??= input.at }
    return state
  }

  const sceneContractForRun = async (runId: string, config: RunConfig, suppliedTurns?: TurnRecord[]): Promise<{
    plan: SceneContractPlan
    contract: SceneContract
    state: SceneStateRecord
    acceptedChars: number
    sceneChars: number
  } | null> => {
    const plan = config.sceneContracts
    if (!sceneContractPlanValid(plan)) return null
    const states = await ensureScenePlan(runId, plan)
    const state = states.filter((item) => item.lifecycle !== 'committed').sort((a, b) => a.order - b.order)[0]
    if (!state) return null
    const contract = plan.contracts.find((item) => item.sceneId === state.sceneId)
    if (!contract || contract.contractId !== state.contractId || contract.frozenHash !== state.contractHash) throw new Error('scene_state_contract_mismatch')
    const acceptedChars = codePointLength(await acceptedTextForRun(runId, suppliedTurns))
    const segments = await getManuscriptSegments(runId, suppliedTurns)
    const acceptedSceneSegment = state.acceptedSegmentId
      ? segments.find((segment) => segment.segmentId === state.acceptedSegmentId && segment.status === 'accepted')
      : undefined
    // A pending semantic/state review is a durable user boundary.  Restore
    // must not turn its candidate back into `writing`, otherwise a generic
    // resume can spend a provider call before the decision is made.
    const pendingReview = await getNarrativeReview(runId)
    const reviewBlocksTransition = pendingReview?.status === 'pending_review' && pendingReview.sceneId === state.sceneId && pendingReview.candidate.segmentId === state.candidateSegmentId
    const shouldResumeWriting = !reviewBlocksTransition && (state.lifecycle === 'planned' || state.lifecycle === 'accepted' || (state.lifecycle === 'candidate' && !acceptedSceneSegment))
    if (shouldResumeWriting) {
      const next = await transitionScene({
        runId,
        sceneId: state.sceneId,
        contractId: contract.contractId,
        contractHash: contract.frozenHash,
        expectedRevision: state.revision,
        from: state.lifecycle,
        to: 'writing',
        at: now()
      })
      if (next) Object.assign(state, next)
    }
    const sceneChars = segments
      .filter((segment) => segment.kind === 'prose' && segment.status === 'accepted' && segment.sceneId === contract.sceneId)
      .reduce((sum, segment) => sum + segment.charCount, 0)
    return { plan, contract, state, acceptedChars, sceneChars }
  }

  const saveSceneContractFrozenEvidence = async (
    runId: string,
    context: { plan: SceneContractPlan; contract: SceneContract; state?: SceneStateRecord; acceptedChars: number; sceneChars: number },
    round: number,
    purpose: 'writer' | 'critic' | 'editor'
  ): Promise<void> => {
    const payload = {
      schemaVersion: 1,
      stage: 'frozen',
      purpose,
      runId,
      round,
      planHash: context.plan.planHash,
      outlineHash: context.plan.outlineHash,
      outlineRevision: context.plan.outlineRevision,
      acceptedChars: context.acceptedChars,
      sceneChars: context.sceneChars,
      sceneLifecycle: context.state?.lifecycle ?? null,
      sceneRevision: context.state?.revision ?? null,
      contract: context.contract,
      frozenHash: context.contract.frozenHash,
      frozenAt: now()
    }
    await store.saveRunEvidence(runId, 'scene_contract_frozen', JSON.stringify(payload))
    await store.saveRunEvidence(runId, `scene_contract_frozen:${context.contract.contractId}`, JSON.stringify(payload))
  }

  const projectSceneContractV2 = async (
    runId: string,
    config: RunConfig,
    context: { contract: SceneContract; state?: SceneStateRecord }
  ): Promise<void> => {
    await persistWp7SceneContractProjection({
      runId,
      config,
      contract: context.contract,
      state: context.state,
      runtime: narrativeRuntime,
      store
    })
  }

  const readWp7SceneContractV2 = async (runId: string, contract: SceneContract): Promise<Wp7SceneContractV2 | null> => {
    const kind = `wp7_scene_contract_v2_projection:${contract.contractId}:${contract.revision}`
    const evidence = await store.getRunEvidence(runId, kind)
    if (!evidence) return null
    try {
      const payload = JSON.parse(evidence.json) as Record<string, unknown>
      if (payload.runId !== runId || payload.sceneId !== contract.sceneId || payload.contractHash !== contract.frozenHash || payload.contractRevision !== contract.revision) return null
      const projection = payload.projection
      if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return null
      const candidate = projection as Record<string, unknown>
      if (candidate.contractId !== `${contract.contractId}:v2` || candidate.sceneId !== contract.sceneId || candidate.revision !== contract.revision || candidate.sourceHash !== contract.frozenHash || typeof candidate.frozenHash !== 'string') return null
      const validation = narrativeRuntime.validateSceneContractV2(projection)
      if (!validation.ok || !validation.hashValid) return null
      return projection as Wp7SceneContractV2
    } catch {
      return null
    }
  }

  const projectDramaticCritic = async (
    runId: string,
    config: RunConfig,
    context: { contract: SceneContract; state?: SceneStateRecord },
    candidate: ManuscriptSegment
  ): Promise<void> => {
    const flags = narrativeRuntime.parseWp7FeatureFlags(config.wp7FeatureFlags)
    if (!flags.sceneContractV2 || !flags.deterministicDirector || !flags.dramaticCritic) return
    if (!store.saveRunEvidenceIfAbsent) throw new Error('wp7_dramatic_critic_cas_unavailable')
    const projection = await readWp7SceneContractV2(runId, context.contract)
    if (!projection) return
    const workflowId = typeof config.sessionId === 'string' && config.sessionId.trim() ? config.sessionId : runId
    await persistWp7DramaticCriticEvidence({
      runId,
      config,
      workflowId,
      sceneId: context.contract.sceneId,
      sceneRevision: context.state?.revision ?? context.contract.revision,
      contractHash: context.contract.frozenHash,
      candidate,
      contract: projection,
      runtime: narrativeRuntime,
      store
    })
  }

  type Wp7DramaticCriticEvidenceRead = {
    report: DramaticCriticReport
    criticContractHash: string
    epoch: number
    flagsHash: string
  }

  const wp7CurrentEpoch = async (runId: string): Promise<number> => {
    const freshness = store.getStoryLedgerFreshness ? await store.getStoryLedgerFreshness(runId) : null
    return freshness && Number.isInteger(freshness.validityEpoch) && freshness.validityEpoch >= 0 ? freshness.validityEpoch : 0
  }

  const readWp7DramaticCriticEvidence = async (input: {
    runId: string
    config: RunConfig
    sceneContract: SceneContract
    candidateSegmentId: string
    candidateRevision: number
    candidate: string
  }): Promise<Wp7DramaticCriticEvidenceRead | null> => {
    const flags = narrativeRuntime.parseWp7FeatureFlags(input.config.wp7FeatureFlags)
    if (!flags.dramaticCritic) return null
    const candidateHash = manuscriptSegmentHash(input.candidate)
    const kind = `wp7_dramatic_critic:${input.candidateSegmentId}:${input.candidateRevision}`
    const evidence = await store.getRunEvidence(input.runId, kind)
    if (!evidence) return null
    try {
      const payload = JSON.parse(evidence.json) as Record<string, unknown>
      const criticContractHash = payload.criticContractHash
      const report = payload.report
      const flagsHash = narrativeRuntime.hashWp7FeatureFlags(flags)
      if (payload.schemaVersion !== 1 || payload.stage !== 'candidate_critic' || payload.runId !== input.runId || payload.sceneId !== input.sceneContract.sceneId || payload.candidateSegmentId !== input.candidateSegmentId || payload.revision !== input.candidateRevision || payload.candidateHash !== candidateHash || payload.contractHash !== input.sceneContract.frozenHash || typeof criticContractHash !== 'string' || typeof payload.epoch !== 'number' || payload.epoch !== await wp7CurrentEpoch(input.runId) || payload.flagsHash !== flagsHash || !narrativeRuntime.validateCriticReport(input.candidate, report, criticContractHash)) return null
      if (typeof payload.outputHash !== 'string' || payload.outputHash !== createHash('sha256').update(stableNarrativeJson(report), 'utf8').digest('hex')) return null
      return { report, criticContractHash, epoch: payload.epoch, flagsHash }
    } catch {
      return null
    }
  }

  type Wp7LocalizedRevisionDecision =
    | { status: 'applied'; beforeHash: string; afterHash: string; span: ExactTextSpan; epoch: number; flagsHash: string; criticContractHash: string }
    | { status: 'fallback'; reason: string; beforeHash: string; epoch: number; flagsHash: string }

  const deriveWp7LocalizedRevision = async (input: {
    runId: string
    config: RunConfig
    sceneContract?: SceneContract
    candidateSegmentId: string
    candidateRevision: number
    candidate: string
    revised: string
    patch: { issueId: string; startCp: number; endCp: number; quote: string; replacement: string }
  }): Promise<Wp7LocalizedRevisionDecision> => {
    const flags = narrativeRuntime.parseWp7FeatureFlags(input.config.wp7FeatureFlags)
    const beforeHash = manuscriptSegmentHash(input.candidate)
    const fallback = async (reason: string): Promise<Wp7LocalizedRevisionDecision> => ({ status: 'fallback', reason, beforeHash, epoch: await wp7CurrentEpoch(input.runId), flagsHash: narrativeRuntime.hashWp7FeatureFlags(flags) })
    if (!input.sceneContract) return fallback('scene_contract_missing')
    const evidence = await readWp7DramaticCriticEvidence({
      runId: input.runId,
      config: input.config,
      sceneContract: input.sceneContract,
      candidateSegmentId: input.candidateSegmentId,
      candidateRevision: input.candidateRevision,
      candidate: input.candidate
    })
    if (!evidence) return fallback('critic_evidence_missing_or_stale')
    const span = narrativeRuntime.makeExactTextSpanFromCodePoints(input.candidate, input.patch.startCp, input.patch.endCp)
    if (!span || span.text !== input.patch.quote) return fallback('editor_span_not_exact')
    const result = narrativeRuntime.runLocalRevision({
      originalText: input.candidate,
      revisions: [{ revisionId: input.patch.issueId, targetId: input.patch.issueId, span, replacement: input.patch.replacement, sourceHash: beforeHash }],
      allowedRevisionSpans: evidence.report.revisionTargets,
      mustPreserveSpans: [
        ...evidence.report.mustPreserveSpans,
        ...evidence.report.issues.flatMap((issue) => issue.mustPreserveSpans)
      ],
      expectedSourceHash: beforeHash,
      expectedCandidateHash: beforeHash
    }, flags)
    if (!result.ok || !result.changed || result.text !== input.revised || result.contentHash !== manuscriptSegmentHash(input.revised)) return fallback(result.ok ? 'localized_revision_output_mismatch' : `localized_revision_${result.error}`)
    return { status: 'applied', beforeHash, afterHash: result.contentHash, span, epoch: evidence.epoch, flagsHash: evidence.flagsHash, criticContractHash: evidence.criticContractHash }
  }

  const persistWp7LocalizedRevisionEvidence = async (input: {
    runId: string
    candidateSegmentId: string
    candidateRevision: number
    contractHash: string
    candidateHash: string
    decision: Wp7LocalizedRevisionDecision
  }): Promise<void> => {
    const kind = `wp7_localized_revision:${input.candidateSegmentId}:${input.candidateRevision}`
    const payload = input.decision.status === 'applied'
      ? { schemaVersion: 1, stage: 'localized_revision', status: 'applied', runId: input.runId, candidateSegmentId: input.candidateSegmentId, candidateRevision: input.candidateRevision, contractHash: input.contractHash, candidateHash: input.candidateHash, beforeHash: input.decision.beforeHash, afterHash: input.decision.afterHash, span: input.decision.span, epoch: input.decision.epoch, flagsHash: input.decision.flagsHash, criticContractHash: input.decision.criticContractHash }
      : { schemaVersion: 1, stage: 'localized_revision', status: 'fallback', runId: input.runId, candidateSegmentId: input.candidateSegmentId, candidateRevision: input.candidateRevision, contractHash: input.contractHash, candidateHash: input.candidateHash, reason: input.decision.reason, epoch: input.decision.epoch, flagsHash: input.decision.flagsHash }
    const json = JSON.stringify(payload)
    if (!store.saveRunEvidenceIfAbsent) throw new Error('wp7_localized_revision_cas_unavailable')
    const inserted = await store.saveRunEvidenceIfAbsent(input.runId, kind, json)
    if (inserted) return
    const existing = await store.getRunEvidence(input.runId, kind)
    if (!existing) throw new Error('wp7_localized_revision_missing_after_cas')
    if (existing.json !== json) throw new Error('wp7_localized_revision_conflict')
  }

  const saveSceneContractEvaluation = async (runId: string, segmentId: string, evaluation: ReturnType<typeof evaluateSceneContract>, extra: Record<string, unknown> = {}): Promise<void> => {
    const payload = { ...evaluation, ...extra, evaluatedAt: now() }
    await store.saveRunEvidence(runId, 'scene_contract_latest', JSON.stringify(payload))
    await store.saveRunEvidence(runId, `scene_contract_segment:${segmentId}`, JSON.stringify(payload))
    const stage = typeof extra.stage === 'string' && extra.stage.trim() ? extra.stage.trim() : 'evaluation'
    await store.saveRunEvidence(runId, `scene_contract_segment:${segmentId}:${stage}`, JSON.stringify(payload))
  }

  /**
   * A complete-looking scene with an unresolved semantic beat is not safe to
   * accept and retrying the provider is not a semantic decision.  Persist a
   * compact, content-addressed review packet before raising the recoverable
   * error.  The packet contains the ordered prefix segment identities and the
   * hash of the exact prefix used by the evaluator; it deliberately does not
   * copy prose into run_evidence or ask the model to self-certify.
   */
  const opaqueBeatIds = (contract: SceneContract): Set<string> => new Set(
    (contract.requiredBeatEvidence ?? []).filter(isOpaqueSceneBeatRequirement).map((beat) => beat.beatId)
  )

  const sceneSemanticReviewReasons = (evaluation: ReturnType<typeof evaluateSceneContract>, contract: SceneContract): string[] => {
    const direct = evaluation.violations.filter((violation) => violation.code === 'beat_uncertain' || violation.code === 'beat_evidence_invalid').map((violation) => violation.code)
    // A normal missing beat is an ordinary bounded writing/defer condition.
    // Only an authored beat with no deterministic event anchor at all is a
    // genuine semantic ambiguity and therefore a user decision boundary.
    const opaque = opaqueBeatIds(contract)
    if (evaluation.violations.some((violation) => violation.code === 'missing_required_beat') && (evaluation.beatEvidence ?? []).some((beat) => beat.status === 'missing' && opaque.has(beat.beatId))) direct.push('missing_required_beat')
    return [...new Set(direct)]
  }

  const sceneSemanticReviewRequired = (evaluation: ReturnType<typeof evaluateSceneContract>, contract: SceneContract, complete: boolean): boolean =>
    complete && sceneSemanticReviewReasons(evaluation, contract).length > 0

  const isOpaqueReviewPacket = (packet: Pick<NarrativeSemanticReviewPacket, 'reason' | 'status' | 'missingBeatIds' | 'contract' | 'reasons'>): boolean => {
    if (packet.reason !== 'scene_semantic_ambiguous' || packet.status !== 'pending_review' || packet.missingBeatIds.length === 0) return false
    const opaque = opaqueBeatIds(packet.contract)
    const reasonCodes = new Set(packet.reasons.map((reason) => reason.code))
    return packet.missingBeatIds.every((beatId) => opaque.has(beatId)) && reasonCodes.size === 1 && reasonCodes.has('missing_required_beat')
  }

  const reviewDecisionCapabilities = (packet: Pick<NarrativeSemanticReviewPacket, 'reason' | 'status' | 'missingBeatIds' | 'contract' | 'reasons'>): NarrativeReviewDecisionCapabilities => {
    const pending = packet.status === 'pending_review'
    const unavailable = pending ? null : '该复核已经处理，不能重复决定'
    const noStateAllowed = isOpaqueReviewPacket(packet)
    const unknownAllowed = pending && isRoleBindingAmbiguityOnly(packet.reasons.map((reason) => reason.code))
    return {
      accept_delta: { allowed: pending, disabledReason: unavailable },
      accept_unknown: { allowed: unknownAllowed, disabledReason: unknownAllowed ? null : pending ? '接受未知仅适用于角色绑定歧义；缺失 beat、事实或状态不能降级' : unavailable },
      accept_prose_no_state: {
        allowed: noStateAllowed,
        disabledReason: noStateAllowed ? null : pending ? '只有全部缺口都是无结构化状态的文学性 beat 才能接受正文而不写入状态' : unavailable
      },
      reject_rewrite: { allowed: pending, disabledReason: unavailable },
      abandon: { allowed: pending, disabledReason: unavailable }
    }
  }

  const reviewPacketHashInput = (packet: Omit<NarrativeSemanticReviewPacket, 'packetHash'> | NarrativeSemanticReviewPacket): Omit<NarrativeSemanticReviewPacket, 'packetHash'> => {
    const { content: _content, ...candidate } = packet.candidate
    return {
      schemaVersion: packet.schemaVersion,
      status: packet.status,
      reason: packet.reason,
      runId: packet.runId,
      sceneId: packet.sceneId,
      contractId: packet.contractId,
      contractHash: packet.contractHash,
      revision: packet.revision,
      candidate,
      acceptedCharsBefore: packet.acceptedCharsBefore,
      sceneChars: packet.sceneChars,
      scenePrefixHash: packet.scenePrefixHash,
      scenePrefixCharCount: packet.scenePrefixCharCount,
      sceneContentHash: packet.sceneContentHash,
      contract: packet.contract,
      completionDecision: packet.completionDecision,
      evaluation: packet.evaluation,
      missingBeatIds: packet.missingBeatIds,
      conflictBeatIds: packet.conflictBeatIds,
      reasons: packet.reasons,
      proposedDelta: packet.proposedDelta,
      ...(packet.allowedDecisions ? { allowedDecisions: packet.allowedDecisions } : {}),
      recordedAt: packet.recordedAt,
      ...(packet.decision ? { decision: packet.decision } : {}),
      ...(packet.pendingOperation ? { pendingOperation: packet.pendingOperation } : {})
    }
  }

  const reviewPacketHash = (packet: Omit<NarrativeSemanticReviewPacket, 'packetHash'> | NarrativeSemanticReviewPacket): string =>
    createHash('sha256').update(stableNarrativeJson(reviewPacketHashInput(packet)), 'utf8').digest('hex')

  const makeNarrativeReviewPacket = async (input: {
    runId: string
    context: { contract: SceneContract; acceptedChars?: number; sceneChars: number }
    segment: ManuscriptSegment
    scenePrefix: string
    evaluation: ReturnType<typeof evaluateSceneContract>
    completionDecision: SceneCompletionDecision
    reason: NarrativeSemanticReviewPacket['reason']
    reasons: NarrativeSemanticReviewPacket['reasons']
    proposedDelta?: NarrativeStateDelta | null
    acceptedSegments: NarrativeSemanticReviewPacket['candidate']['acceptedSegments']
    recordedAt?: number
  }): Promise<NarrativeSemanticReviewPacket> => {
    const missingBeatIds = [...new Set(input.completionDecision.missingBeatIds)]
    const conflictBeatIds = input.evaluation.violations
      .filter((violation) => violation.code === 'beat_contradicted' || violation.code === 'beat_evidence_invalid')
      .flatMap((violation) => violation.evidence)
    // Review claims/revision records are run-wide. A later scene must not
    // reuse revision 1 and inherit an earlier candidate's durable claim.
    const previousEvidence = await store.getRunEvidence(input.runId, 'narrative_semantic_review')
    let previous: NarrativeSemanticReviewPacket | null = null
    if (previousEvidence) {
      try { previous = parseNarrativeReviewPacket(JSON.parse(previousEvidence.json)) } catch { /* rejected below */ }
      if (!previous || previous.runId !== input.runId) throw new Error('narrative_review_previous_packet_corrupt')
      const sameCandidate = previous.sceneId === input.context.contract.sceneId
        && previous.contractHash === input.context.contract.frozenHash
        && previous.reason === input.reason
        && previous.candidate.segmentId === input.segment.segmentId
        && previous.candidate.contentHash === input.segment.contentHash
        && previous.candidate.charCount === input.segment.charCount
        && previous.scenePrefixHash === (input.evaluation.scenePrefixHash ?? createHash('sha256').update(input.scenePrefix, 'utf8').digest('hex'))
        && previous.scenePrefixCharCount === codePointLength(input.scenePrefix)
        && previous.sceneContentHash === input.evaluation.candidateHash
        && stableNarrativeJson(previous.candidate.acceptedSegments) === stableNarrativeJson(input.acceptedSegments)
      if (sameCandidate) {
        if (previous.status !== 'pending_review') throw new Error('narrative_review_candidate_already_decided')
        // Rehydrating the exact unresolved candidate is idempotent, including
        // its hash/timestamp and claimed operation; never mint a new fence.
        return previous
      }
    }
    const revision = previous ? previous.revision + 1 : 1
    if (!Number.isSafeInteger(revision)) throw new Error('narrative_review_revision_exhausted')
    const base: Omit<NarrativeSemanticReviewPacket, 'packetHash'> = {
      schemaVersion: 1,
      status: 'pending_review',
      reason: input.reason,
      runId: input.runId,
      sceneId: input.context.contract.sceneId,
      contractId: input.context.contract.contractId,
      contractHash: input.context.contract.frozenHash,
      revision,
      candidate: {
        segmentId: input.segment.segmentId,
        contentHash: input.segment.contentHash,
        charCount: input.segment.charCount,
        acceptedSegments: input.acceptedSegments
      },
      acceptedCharsBefore: input.context.acceptedChars ?? codePointLength(input.scenePrefix),
      sceneChars: input.context.sceneChars + input.segment.charCount,
      scenePrefixHash: input.evaluation.scenePrefixHash ?? createHash('sha256').update(input.scenePrefix, 'utf8').digest('hex'),
      scenePrefixCharCount: codePointLength(input.scenePrefix),
      sceneContentHash: input.evaluation.candidateHash,
      contract: input.context.contract,
      completionDecision: input.completionDecision,
      evaluation: input.evaluation,
      missingBeatIds,
      conflictBeatIds: [...new Set(conflictBeatIds)],
      reasons: input.reasons,
      proposedDelta: input.proposedDelta ?? null,
      allowedDecisions: reviewDecisionCapabilities({
        reason: input.reason,
        status: 'pending_review',
        missingBeatIds,
        contract: input.context.contract,
        reasons: input.reasons
      }),
      recordedAt: input.recordedAt ?? now()
    }
    return { ...base, packetHash: reviewPacketHash(base) }
  }

  const reviewDurablePayload = (packet: NarrativeSemanticReviewPacket): Record<string, unknown> => {
    const { effectiveAllowedDecisions: _effectiveAllowedDecisions, ...durablePacket } = packet
    const { content: _content, ...candidate } = packet.candidate
    return {
    ...durablePacket,
    candidate,
    // Keep the R62 top-level shape readable by existing evidence consumers.
    candidateSegmentId: packet.candidate.segmentId,
    candidateContentHash: packet.candidate.contentHash,
    candidateCharCount: packet.candidate.charCount,
    acceptedSegments: packet.candidate.acceptedSegments,
    acceptedCharsBefore: packet.acceptedCharsBefore,
    scenePrefixCharCount: packet.scenePrefixCharCount,
    sceneContentHash: packet.sceneContentHash
    }
  }

  const reviewPacketEvidenceEntries = (packet: NarrativeSemanticReviewPacket): Array<{ kind: string; json: string }> => {
    const encoded = JSON.stringify(reviewDurablePayload(packet))
    const entries = [
      { kind: 'narrative_semantic_review', json: encoded },
      { kind: `narrative_semantic_review:${packet.candidate.segmentId}`, json: encoded }
    ]
    // Keep the scene-specific index as a rebuildable mirror for both pending
    // and terminal packets.  A terminal value in this key is preferable to a
    // stale pending marker: restore can then prove that all mirrors describe
    // the same packet without needing a destructive delete operation.
    if (packet.reason === 'scene_semantic_ambiguous') {
      entries.push(
        { kind: 'scene_semantic_pending_review', json: encoded },
        { kind: `scene_semantic_pending_review:${packet.candidate.segmentId}`, json: encoded }
      )
    }
    return entries
  }

  const persistNarrativeReviewPacket = async (packet: NarrativeSemanticReviewPacket): Promise<void> => {
    const entries = reviewPacketEvidenceEntries(packet)
    if (packet.status === 'pending_review' && store.getStoryLedgerFreshness) {
      // Persist the *original provider* tuple, not a new head read at approval
      // or restore time. The canonical packet and this binding commit together.
      const fence = storyLedgerFences.get(packet.runId)
      if (!fence) throw new Error('story_ledger_fence_missing')
      await assertStoryLedgerFence(fence)
      const body = { schemaVersion: 1 as const, runId: packet.runId, packetHash: packet.packetHash, revision: packet.revision,
        sceneId: packet.sceneId, contractHash: packet.contractHash, candidateSegmentId: packet.candidate.segmentId,
        candidateHash: packet.candidate.contentHash, fence }
      const json = JSON.stringify({ ...body, hash: reviewStoryFenceHash(body) })
      const kind = `narrative_review_story_fence:${packet.packetHash}`
      const prior = await store.getRunEvidence(packet.runId, kind)
      if (prior && prior.json !== json) throw new Error('narrative_review_story_fence_conflict')
      if (!store.saveRunEvidenceBundle) throw new Error('narrative_review_story_fence_atomic_store_missing')
      entries.push({ kind, json })
    }
    if (store.saveRunEvidenceBundle) {
      await store.saveRunEvidenceBundle(packet.runId, entries)
      return
    }
    await store.saveRunEvidence(packet.runId, 'narrative_semantic_review', entries[0].json)
  }

  const reviewStoryFenceHash = (body: object): string => createHash('sha256').update(stableNarrativeJson(body), 'utf8').digest('hex')

  const readNarrativeReviewStoryFence = async (packet: NarrativeSemanticReviewPacket): Promise<StoryLedgerFenceSnapshot | null> => {
    if (!store.getStoryLedgerFreshness || packet.status !== 'pending_review') return null
    const raw = await store.getRunEvidence(packet.runId, `narrative_review_story_fence:${packet.packetHash}`)
    if (!raw) throw new Error('story_ledger_fence_missing:审批缺少原Provider栅栏，请重写候选')
    const corrupt = (): never => { throw new Error('narrative_review_story_fence_corrupt:拒绝恢复审批') }
    let parsed: unknown
    try { parsed = JSON.parse(raw.json) } catch { corrupt() }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) corrupt()
    const record = parsed as Record<string, unknown>
    const keys = ['schemaVersion', 'runId', 'packetHash', 'revision', 'sceneId', 'contractHash', 'candidateSegmentId', 'candidateHash', 'fence', 'hash']
    if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) corrupt()
    const { hash, ...body } = record
    if (record.schemaVersion !== 1 || !sha256Hex(hash) || reviewStoryFenceHash(body) !== hash ||
      record.runId !== packet.runId || record.packetHash !== packet.packetHash || record.revision !== packet.revision ||
      record.sceneId !== packet.sceneId || record.contractHash !== packet.contractHash ||
      record.candidateSegmentId !== packet.candidate.segmentId || record.candidateHash !== packet.candidate.contentHash) corrupt()
    if (!record.fence || typeof record.fence !== 'object' || Array.isArray(record.fence)) corrupt()
    const fence = record.fence as StoryLedgerFenceSnapshot
    const fenceKeys = ['runId', 'expectedRevision', 'expectedEpoch', 'expectedHeadRevision', 'expectedHeadHash', 'scope']
    if (Object.keys(fence).length !== fenceKeys.length || Object.keys(fence).some((key) => !fenceKeys.includes(key)) || fence.runId !== packet.runId ||
      !Number.isSafeInteger(fence.expectedRevision) || fence.expectedRevision < 0 || !Number.isSafeInteger(fence.expectedEpoch) || fence.expectedEpoch < 1 ||
      !Number.isSafeInteger(fence.expectedHeadRevision) || fence.expectedHeadRevision < fence.expectedRevision ||
      (fence.expectedHeadRevision === 0 ? fence.expectedHeadHash !== null : !sha256Hex(fence.expectedHeadHash))) corrupt()
    let scope: StoryLedgerFreshness['scope']
    try { scope = validateNarrativeLedgerScope(fence.scope) } catch { corrupt() }
    if (Object.keys(fence.scope).length !== 4 || stableNarrativeJson(scope!) !== stableNarrativeJson(fence.scope)) corrupt()
    const configuredScope = getConfig(packet.runId).storyScope
    if (configuredScope && stableNarrativeJson(validateNarrativeLedgerScope(configuredScope as StoryLedgerFreshness['scope'])) !== stableNarrativeJson(scope!)) corrupt()
    const authority = await store.getStoryLedgerFreshness(packet.runId)
    if (!authority || stableNarrativeJson(authority.scope) !== stableNarrativeJson(scope!)) corrupt()
    return fence
  }

  const restoreNarrativeReviewStoryFence = async (packet: NarrativeSemanticReviewPacket): Promise<void> => {
    const fence = await readNarrativeReviewStoryFence(packet)
    if (!fence) return
    // This read validates the old tuple; it never promotes the current tuple
    // into a replacement fence. The repository's atomic freshness gate stays.
    await assertStoryLedgerFence(fence)
    const candidate = (await getManuscriptSegments(packet.runId)).find((segment) => segment.segmentId === packet.candidate.segmentId)
    if (!candidate || candidate.status !== 'candidate' || candidate.contentHash !== packet.candidate.contentHash || candidate.charCount !== packet.candidate.charCount ||
      candidate.sceneId !== packet.sceneId || manuscriptSegmentHash(candidate.content) !== packet.candidate.contentHash) throw new Error('narrative_review_story_fence_corrupt:拒绝恢复审批')
    storyLedgerFences.set(packet.runId, fence)
  }

  /** A committed review may forward-complete its missing final packet, but
   * only the exact +1 node produced by that scene may supersede the original
   * provider tuple. Never hydrate a replacement fence from today's head. */
  const assertNarrativeReviewOwnCommitFence = async (packet: NarrativeSemanticReviewPacket, deltaHash: string): Promise<void> => {
    const fence = await readNarrativeReviewStoryFence(packet)
    if (!fence || !store.getStoryLedgerFreshness) return
    const authority = await store.getStoryLedgerFreshness(packet.runId)
    if (!authority || !authority.epochValid || authority.validityEpoch !== fence.expectedEpoch || authority.headValidityEpoch !== fence.expectedEpoch) return invalidateStoryEpoch(packet.runId)
    const manifest = store.getSceneCommitManifest ? await store.getSceneCommitManifest(packet.runId, packet.sceneId) : null
    const candidate = (await getManuscriptSegments(packet.runId)).find((segment) => segment.segmentId === packet.candidate.segmentId)
    if (!manifest || manifest.runId !== packet.runId || manifest.sceneId !== packet.sceneId || manifest.contractId !== packet.contractId ||
      manifest.contractHash !== packet.contractHash || manifest.stateDeltaHash !== deltaHash || manifest.sceneContentHash !== packet.sceneContentHash ||
      manifest.sceneCharCount !== packet.sceneChars || !candidate || candidate.status !== 'accepted' || candidate.sceneId !== packet.sceneId ||
      candidate.contentHash !== packet.candidate.contentHash || candidate.charCount !== packet.candidate.charCount || manuscriptSegmentHash(candidate.content) !== packet.candidate.contentHash ||
      !manifest.acceptedSegments.some((segment) => segment.segmentId === candidate.segmentId && segment.contentHash === candidate.contentHash && segment.charCount === candidate.charCount)) {
      throw new Error('narrative_review_own_commit_binding_missing')
    }
    const manifestHash = createHash('sha256').update(stableNarrativeJson(manifest), 'utf8').digest('hex')
    const node = { ...fence.scope, revision: fence.expectedHeadRevision + 1, parentRevision: fence.expectedHeadRevision,
      parentHash: fence.expectedHeadHash, runId: packet.runId, sceneId: packet.sceneId, deltaHash, manifestHash, hashSchemaVersion: 2 as const }
    const { schemaVersion: _scopeSchema, ...nodeBody } = node
    // Both existing ledger node kinds preserve the same exact parent and own
    // commit identity; the authoritative hash proves which one was written.
    const ownHashes = ['revision' as const, 'rebase' as const].map((nodeType) => storyLedgerRevisionHashV2({ ...nodeBody, nodeType }))
    if (fence.expectedRevision !== fence.expectedHeadRevision || !authority.fresh || !authority.headMatchesCursor ||
      authority.runRevision !== fence.expectedRevision + 1 || authority.headRevision !== fence.expectedHeadRevision + 1 ||
      authority.runHash !== authority.headHash || !ownHashes.includes(authority.headHash ?? '')) return invalidateStoryHead(packet.runId)
  }

  /** Reconcile all packet mirrors from the canonical generic row.  The
   * generic packet remains the read source; candidate/scene rows are indexes
   * and can always be rebuilt after a partial legacy write or crash. */
  const reconcileNarrativeReviewMirrors = async (packet: NarrativeSemanticReviewPacket): Promise<void> => {
    if (!store.getRunEvidence) return
    const expected = reviewPacketEvidenceEntries(packet)
    const rows = await Promise.all(expected.map((entry) => store.getRunEvidence(packet.runId, entry.kind)))
    if (rows.every((row, index) => row?.json === expected[index].json)) return
    if (store.saveRunEvidenceBundle) {
      await store.saveRunEvidenceBundle(packet.runId, expected)
      return
    }
    // Stores without a transaction-capable bundle deliberately use the
    // generic row as the single source of truth; never recreate a second
    // independently writable mirror in that fallback mode.
    await store.saveRunEvidence(packet.runId, 'narrative_semantic_review', expected[0].json)
  }

  const pendingOperationShapeValid = (value: unknown): value is NarrativeReviewPendingOperation => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const operation = value as Partial<NarrativeReviewPendingOperation>
    return reviewOperationIdValid(operation.operationId) &&
      reviewOperationIdValid(operation.decisionId) &&
      operation.operationId === operation.decisionId &&
      typeof operation.expectedRevision === 'number' && Number.isInteger(operation.expectedRevision) && operation.expectedRevision >= 1 &&
      (operation.canonicalPayloadHash === null || sha256Hex(operation.canonicalPayloadHash)) &&
      (operation.durable === undefined || typeof operation.durable === 'boolean')
  }

  const decisionRecordShapeValid = (packet: Partial<NarrativeSemanticReviewPacket>, value: unknown): value is NarrativeSemanticReviewDecisionRecord => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Partial<NarrativeSemanticReviewDecisionRecord>
    if (!reviewOperationIdValid(record.decisionId) || record.runId !== packet.runId ||
      typeof record.decision !== 'string' || !narrativeReviewDecisionNames.includes(record.decision as NarrativeSemanticReviewDecision) ||
      typeof record.actor !== 'string' || typeof record.note !== 'string' ||
      typeof record.expectedRevision !== 'number' || !Number.isInteger(record.expectedRevision) || record.expectedRevision < 1 ||
      typeof record.revision !== 'number' || !Number.isInteger(record.revision) || record.revision !== record.expectedRevision + 1 || record.revision !== packet.revision ||
      !sha256Hex(record.packetHash) || record.candidateHash !== packet.candidate?.contentHash || record.contractHash !== packet.contractHash ||
      (record.deltaHash !== null && !sha256Hex(record.deltaHash)) || !sha256Hex(record.canonicalPayloadHash) ||
      !sha256Hex(record.decisionHash) || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return false
    try {
      const { decisionHash, ...body } = record as NarrativeSemanticReviewDecisionRecord
      if (createHash('sha256').update(stableNarrativeJson(body), 'utf8').digest('hex') !== decisionHash) return false
      return record.canonicalPayloadHash === narrativeReviewDecisionPayloadHash({
        runId: packet.runId!,
        sceneId: packet.sceneId!,
        contractId: packet.contractId!,
        contractHash: packet.contractHash!,
        packetHash: record.packetHash,
        expectedRevision: record.expectedRevision,
        revision: record.revision,
        candidateSegmentId: packet.candidate!.segmentId,
        candidateHash: packet.candidate!.contentHash,
        candidateCharCount: packet.candidate!.charCount,
        decisionId: record.decisionId,
        decision: record.decision as NarrativeSemanticReviewDecision,
        deltaHash: record.deltaHash ?? null,
        note: record.note
      })
    } catch {
      return false
    }
  }

  const pendingOperationMatchesPacket = (packet: NarrativeSemanticReviewPacket, operation: NarrativeReviewPendingOperation): boolean => {
    if (packet.status === 'pending_review') {
      if (operation.expectedRevision !== packet.revision) return false
      // A durable pending operation is checked against the immutable claim
      // evidence in getNarrativeReview.  A non-durable operation must be the
      // deterministic pre-claim identity; it may never be caller-selected.
      if (operation.durable === true) return true
      return operation.canonicalPayloadHash === null && operation.operationId === provisionalNarrativeReviewOperationId(packet)
    }
    const decision = packet.decision
    return Boolean(decision && operation.durable !== false && operation.expectedRevision === decision.expectedRevision &&
      operation.operationId === decision.decisionId && operation.canonicalPayloadHash === decision.canonicalPayloadHash)
  }

  const durableClaimOperation = (packet: NarrativeSemanticReviewPacket, value: unknown): NarrativeReviewPendingOperation | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const claim = value as NarrativeReviewClaimRecord
    const canonicalPayloadHash = claim.canonicalPayloadHash ?? claim.payloadHash
    if (claim.canonicalPayloadHash !== undefined && !sha256Hex(claim.canonicalPayloadHash)) return null
    if (claim.payloadHash !== undefined && !sha256Hex(claim.payloadHash)) return null
    if (claim.canonicalPayloadHash !== undefined && claim.payloadHash !== undefined && claim.canonicalPayloadHash !== claim.payloadHash) return null
    if (claim.schemaVersion !== 2 || claim.runId !== packet.runId || claim.expectedRevision !== packet.revision ||
      claim.revision !== packet.revision + 1 || claim.packetHash !== packet.packetHash || !sha256Hex(claim.packetHash) ||
      !reviewOperationIdValid(claim.operationId) || !reviewOperationIdValid(claim.decisionId) || claim.operationId !== claim.decisionId ||
      typeof claim.decision !== 'string' || !narrativeReviewDecisionNames.includes(claim.decision as NarrativeSemanticReviewDecision) ||
      !sha256Hex(canonicalPayloadHash) || typeof claim.claimedAt !== 'number' || !Number.isFinite(claim.claimedAt)) return null
    if (packet.allowedDecisions && packet.allowedDecisions[claim.decision as NarrativeSemanticReviewDecision]?.allowed !== true) return null
    return {
      operationId: claim.operationId,
      decisionId: claim.decisionId,
      expectedRevision: packet.revision,
      canonicalPayloadHash,
      durable: true
    }
  }

  const pendingOperationEqual = (left: NarrativeReviewPendingOperation, right: NarrativeReviewPendingOperation): boolean =>
    left.operationId === right.operationId && left.decisionId === right.decisionId && left.expectedRevision === right.expectedRevision &&
    left.canonicalPayloadHash === right.canonicalPayloadHash && (left.durable ?? false) === (right.durable ?? false)

  const parseNarrativeReviewPacket = (value: unknown): NarrativeSemanticReviewPacket | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const packet = value as Partial<NarrativeSemanticReviewPacket>
    if (packet.schemaVersion !== 1 || !['scene_semantic_ambiguous', 'narrative_state_pending_review'].includes(String(packet.reason)) || !['pending_review', 'accepted', 'unknown_accepted', 'rewrite_requested', 'abandoned'].includes(String(packet.status)) || typeof packet.runId !== 'string' || typeof packet.sceneId !== 'string' || typeof packet.contractHash !== 'string' || typeof packet.revision !== 'number' || !Number.isInteger(packet.revision) || packet.revision < 1 || typeof packet.packetHash !== 'string' || !/^[0-9a-f]{64}$/u.test(packet.packetHash)) return null
    if (!packet.candidate || typeof packet.candidate !== 'object' || typeof packet.candidate.segmentId !== 'string' || typeof packet.candidate.contentHash !== 'string' || !/^[0-9a-f]{64}$/u.test(packet.candidate.contentHash) || typeof packet.candidate.charCount !== 'number' || !Number.isInteger(packet.candidate.charCount) || packet.candidate.charCount < 0 || !Array.isArray(packet.candidate.acceptedSegments)) return null
    if (!packet.contract || typeof packet.contract !== 'object' || !packet.completionDecision || typeof packet.completionDecision !== 'object') return null
    if (packet.allowedDecisions !== undefined && (!packet.allowedDecisions || typeof packet.allowedDecisions !== 'object' || narrativeReviewDecisionNames.some((name) => {
      const capability = packet.allowedDecisions?.[name]
      return !capability || typeof capability.allowed !== 'boolean' || (capability.disabledReason !== null && typeof capability.disabledReason !== 'string')
    }))) return null
    if (packet.status === 'pending_review' && packet.decision !== undefined) return null
    if (packet.status !== 'pending_review' && !decisionRecordShapeValid(packet, packet.decision)) return null
    if (packet.pendingOperation !== undefined && !pendingOperationShapeValid(packet.pendingOperation)) return null
    const { packetHash, ...withoutHash } = packet as NarrativeSemanticReviewPacket
    if (reviewPacketHash(withoutHash) !== packetHash) return null
    if (packet.pendingOperation && !pendingOperationMatchesPacket(packet as NarrativeSemanticReviewPacket, packet.pendingOperation)) return null
    return packet as NarrativeSemanticReviewPacket
  }

  const getNarrativeReview = async (runId: string): Promise<NarrativeSemanticReviewPacket | null> => {
    const raw = await store.getRunEvidence(runId, 'narrative_semantic_review')
    if (!raw) return null
    let parsed: unknown
    try { parsed = JSON.parse(raw.json) } catch { return null }
    let packet = parseNarrativeReviewPacket(parsed)
    if (!packet || packet.runId !== runId) return null

    // Claims are the only durable source for an operation that has crossed
    // the pre-claim boundary.  A malformed claim must not be silently
    // ignored and replaced with a fresh provisional id: that would let a
    // damaged/tampered packet reopen an already-owned revision.
    let pendingOperation: NarrativeReviewPendingOperation | undefined
    if (packet.status === 'pending_review') {
      const claim = await store.getRunEvidence(runId, `narrative_semantic_review:claim:${packet.revision}`)
      if (claim) {
        let parsedClaim: unknown
        try { parsedClaim = JSON.parse(claim.json) } catch { return null }
        const durable = durableClaimOperation(packet, parsedClaim)
        if (!durable) return null
        if (packet.pendingOperation && !pendingOperationEqual(packet.pendingOperation, durable)) return null
        pendingOperation = durable
      } else if (packet.pendingOperation) {
        // Persisted pre-claim identities are accepted only when they are the
        // deterministic projection of this packet.  They are never an
        // arbitrary operation id supplied by the renderer or a stale row.
        if (packet.pendingOperation.durable === true || packet.pendingOperation.canonicalPayloadHash !== null || !pendingOperationMatchesPacket(packet, packet.pendingOperation)) return null
        pendingOperation = packet.pendingOperation
      }
    }
    if (packet.status === 'pending_review' && recoverNarrativeReview) {
      try {
        const recovered = await recoverNarrativeReview(packet)
        if (recovered) {
          packet = recovered
          pendingOperation = undefined
        }
      } catch {
        /* Keep the durable pending packet visible when reconciliation is incomplete. */
      }
    }
    try {
      await reconcileNarrativeReviewMirrors(packet)
    } catch {
      // Mirror repair is best-effort at read time.  The canonical generic row
      // has already passed its packet hash check and remains authoritative;
      // the next resume retries the rebuild.
    }
    const segments = await getManuscriptSegments(runId)
    const candidate = segments.find((segment) => segment.segmentId === packet.candidate.segmentId)
    // Historical allowedDecisions belongs to packetHash/claim/revision. Never
    // rewrite it in a read projection. Current, non-persisted hints may only
    // narrow that historical advertisement; the decision gate remains final.
    const effectiveAllowedDecisions = reviewDecisionCapabilities(packet)
    for (const name of narrativeReviewDecisionNames) {
      if (packet.allowedDecisions?.[name].allowed === false) effectiveAllowedDecisions[name] = packet.allowedDecisions[name]
    }
    return {
      ...packet,
      effectiveAllowedDecisions,
      ...(pendingOperation ? { pendingOperation } : {}),
      candidate: {
        ...packet.candidate,
        ...(candidate && candidate.contentHash === packet.candidate.contentHash ? { content: candidate.content } : {})
      }
    }
  }

  const persistSceneSemanticPendingReview = async (
    runId: string,
    context: { contract: SceneContract; acceptedChars?: number; sceneChars: number },
    segment: ManuscriptSegment,
    scenePrefix: string,
    evaluation: ReturnType<typeof evaluateSceneContract>,
    completionDecision: SceneCompletionDecision
  ): Promise<void> => {
    const sceneSegments = (await getManuscriptSegments(runId))
      .filter((item) => item.kind === 'prose' && item.sceneId === context.contract.sceneId && item.segmentId !== segment.segmentId && item.status === 'accepted')
      .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt || a.segmentId.localeCompare(b.segmentId))
      .map((item) => ({
        segmentId: item.segmentId,
        contentHash: item.contentHash,
        charCount: item.charCount,
        chunkIndex: item.chunkIndex,
        revision: item.revision
      }))
    const reasons = sceneSemanticReviewReasons(evaluation, context.contract).map((code) => evaluation.violations.find((violation) => violation.code === code)).filter((violation): violation is NonNullable<typeof violation> => Boolean(violation))
      .map((violation) => ({ code: violation.code, severity: violation.severity, evidence: violation.evidence, message: violation.message }))
    const packet = await makeNarrativeReviewPacket({
      runId,
      context,
      segment,
      scenePrefix,
      evaluation,
      completionDecision,
      reason: 'scene_semantic_ambiguous',
      reasons,
      acceptedSegments: sceneSegments
    })
    await persistNarrativeReviewPacket(packet)
  }

  const sceneCriticEvidenceKind = (contract: SceneContract, candidate: string, scenePrefix: string): string =>
    `scene_beat_critic:${contract.frozenHash}:${writingTextHash(candidate)}:${writingTextHash(scenePrefix)}`

  const readSceneCriticOptions = async (runId: string, contract: SceneContract, candidate: string, scenePrefix: string): Promise<NonNullable<Parameters<typeof evaluateSceneContract>[2]>> => {
    const row = await store.getRunEvidence(runId, sceneCriticEvidenceKind(contract, candidate, scenePrefix))
    if (!row) return {}
    const receipt = JSON.parse(row.json) as Record<string, unknown>
    if (receipt.schemaVersion !== 1 || receipt.runId !== runId || receipt.sceneId !== contract.sceneId || receipt.contractHash !== contract.frozenHash || receipt.candidateHash !== writingTextHash(candidate) || receipt.scenePrefixHash !== writingTextHash(scenePrefix) || receipt.rawHash !== writingTextHash(JSON.stringify(receipt.raw))) throw new Error('scene_beat_critic_identity_mismatch')
    const evidence = bindSceneBeatCriticEvidence(contract, candidate, scenePrefix, receipt.raw)
    // Repeat validation at every candidate/accepted/commit boundary. Invalid
    // entries must remain in modelEvidence so they cannot disappear as green.
    validateSceneBeatSemanticEvidence(contract, candidate, scenePrefix, evidence)
    return { modelEvidence: evidence, semanticReview: true }
  }

  const persistSceneCriticEvidence = async (input: { runId: string; contract: SceneContract; candidate: string; scenePrefix: string; raw: unknown; criticHash: string }): Promise<void> => {
    // Old critics for entirely machine-proven scenes keep their compatibility
    // path. Empty style issues never prove an opaque authored requirement.
    if (input.raw === undefined && !(input.contract.requiredBeatEvidence ?? []).some(isOpaqueSceneBeatRequirement)) return
    const raw = input.raw ?? null
    const evidence = bindSceneBeatCriticEvidence(input.contract, input.candidate, input.scenePrefix, raw)
    const validated = validateSceneBeatSemanticEvidence(input.contract, input.candidate, input.scenePrefix, evidence)
    await store.saveRunEvidence(input.runId, sceneCriticEvidenceKind(input.contract, input.candidate, input.scenePrefix), JSON.stringify({
      schemaVersion: 1, runId: input.runId, sceneId: input.contract.sceneId, contractHash: input.contract.frozenHash,
      candidateHash: writingTextHash(input.candidate), scenePrefixHash: writingTextHash(input.scenePrefix),
      raw, rawHash: writingTextHash(JSON.stringify(raw)), criticHash: input.criticHash,
      invalidBeatIds: validated.invalidBeatIds, recordedAt: now()
    }))
  }

  const evaluateSceneSegment = async (
    runId: string,
    context: { plan: SceneContractPlan; contract: SceneContract; acceptedChars: number; sceneChars: number },
    segment: ManuscriptSegment,
    stage: 'candidate' | 'rejected' | 'accepted',
    completed: boolean
  ): Promise<ReturnType<typeof evaluateSceneContract>> => {
    // Evaluate the candidate against the accepted prefix of this scene.  A
    // scene may span several provider turns; checking each chunk in isolation
    // would make a beat satisfied in an earlier chunk disappear from the next
    // evaluation.  Exclude the segment itself when replaying an accepted
    // evidence record so the candidate is never counted twice.
    const scenePrefix = (await getManuscriptSegments(runId))
      .filter((item) => item.kind === 'prose' && item.status === 'accepted' && item.sceneId === context.contract.sceneId && item.segmentId !== segment.segmentId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt)
      .map((item) => item.content)
      .join('')
    const evaluation = evaluateSceneContract(context.contract, segment.content, {
      sceneChars: codePointLength(scenePrefix) + segment.charCount,
      completed,
      scenePrefix,
      ...await readSceneCriticOptions(runId, context.contract, segment.content, scenePrefix)
    })
    await saveSceneContractEvaluation(runId, segment.segmentId, evaluation, {
      stage,
      segmentId: segment.segmentId,
      segmentHash: segment.contentHash,
      acceptedCharsBefore: context.acceptedChars,
      acceptedCharsAfter: stage === 'accepted' ? context.acceptedChars + segment.charCount : context.acceptedChars
    })
    return evaluation
  }

  const markSceneCandidate = async (
    context: { contract: SceneContract; state: SceneStateRecord },
    segment: ManuscriptSegment,
    at: number
  ): Promise<SceneStateRecord> => {
    const state = context.state
    const next = await transitionScene({
      runId: segment.runId,
      sceneId: context.contract.sceneId,
      contractId: context.contract.contractId,
      contractHash: context.contract.frozenHash,
      expectedRevision: state.revision,
      from: state.lifecycle,
      to: 'candidate',
      candidateSegmentId: segment.segmentId,
      candidateHash: segment.contentHash,
      at
    })
    if (next) {
      Object.assign(state, next)
      return next
    }
    return state
  }

  const narrativeQualityContextForRun = (runId: string): {
    perspective: StrongConstraintSnapshot['perspective'] | undefined
    knownCharacterIds: string[]
  } => {
    const config = getConfig(runId)
    const strong = config.strongConstraints as StrongConstraintSnapshot | undefined
    const story = config.story as { enabled?: boolean; characters?: Array<{ name?: string }> } | undefined
    return {
      perspective: strong?.perspective,
      knownCharacterIds: story?.enabled === true && Array.isArray(story.characters)
        ? story.characters.map((character) => String(character.name ?? '')).filter(Boolean)
        : []
    }
  }

  const evaluateNarrativeSegment = async (
    runId: string,
    segment: ManuscriptSegment,
    sceneContract: SceneContract | null | undefined,
    stage: 'candidate' | 'rejected' | 'accepted',
    acceptedPrefixOverride?: string
  ): Promise<{ evaluation: NarrativeQualityEvaluation; acceptedPrefix: string }> => {
    const acceptedPrefix = acceptedPrefixOverride ?? await acceptedTextForRun(runId)
    const qualityContext = narrativeQualityContextForRun(runId)
    const evaluation = evaluateNarrativeQualityGate({
      candidate: segment.content,
      acceptedPrefix,
      sceneContract,
      perspective: qualityContext.perspective,
      knownCharacterIds: qualityContext.knownCharacterIds
    })
    const payload = {
      ...evaluation,
      stage,
      segmentId: segment.segmentId,
      segmentHash: segment.contentHash,
      evaluatedAt: now()
    }
    await store.saveRunEvidence(runId, 'narrative_quality_latest', JSON.stringify(payload))
    await store.saveRunEvidence(runId, `narrative_quality_segment:${segment.segmentId}`, JSON.stringify(payload))
    await store.saveRunEvidence(runId, `narrative_quality_segment:${segment.segmentId}:${stage}`, JSON.stringify(payload))
    return { evaluation, acceptedPrefix }
  }

  const workingTextForRun = async (runId: string, excludeTurnId?: string): Promise<string> => (await getManuscriptSegments(runId))
    .filter((segment) => segment.sourceTurnId !== excludeTurnId && segment.kind === 'prose' && (segment.status === 'accepted' || segment.status === 'partial'))
    .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt)
    .map((segment) => segment.content)
    .join('')

  const narrativeProjectionTurns = async (runId: string, turns: TurnRecord[], includePending: boolean): Promise<TurnRecord[]> => {
    const segments = await getManuscriptSegments(runId, turns)
    const usable = segments
      .filter((segment) => segment.kind === 'prose' && (segment.status === 'accepted' || (includePending && segment.status === 'partial')))
      .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt)
    const accepted = usable.filter((segment) => segment.status === 'accepted').map((segment) => ({
      turnId: segment.sourceTurnId ?? segment.segmentId,
      runId,
      turnSeq: segment.chunkIndex,
      role: 'assistant' as const,
      content: segment.content,
      createdAt: segment.createdAt
    }))
    const partial = includePending ? usable.filter((segment) => segment.status === 'partial').at(-1) : undefined
    const pending = partial ? [{
      turnId: partial.segmentId,
      runId,
      turnSeq: partial.chunkIndex,
      role: 'system' as const,
      content: `## 待补全残句（尚未接受，不计入正文）\n${partial.content}`,
      createdAt: partial.createdAt
    }] : []
    return [...turns.filter((turn) => turn.role !== 'assistant'), ...accepted, ...pending]
  }

  const acceptanceEvidenceKinds = (segmentId: string, hasScene: boolean): string[] => [
    'strong_constraint_latest',
    'writing_pipeline_latest',
    ...(hasScene ? ['scene_contract_latest', `scene_contract_segment:${segmentId}:candidate`] : []),
    'narrative_quality_latest',
    `narrative_quality_segment:${segmentId}:candidate`
  ]

  const acceptVerifiedProse = async (
    runId: string,
    input: Omit<ManuscriptAcceptanceInput, 'runId' | 'evidenceIdentity' | 'acceptedAt'>,
    sceneCommit?: Omit<SceneCommitInput, 'acceptance' | 'committedAt'> & { committedAt?: number }
  ): Promise<string> => {
    const segments = await getManuscriptSegments(runId)
    const candidate = segments.find((segment) => segment.segmentId === input.segmentId)
    if (!candidate || candidate.status !== 'candidate' || candidate.kind !== 'prose' || !candidate.content.trim()) throw new Error('manuscript_acceptance_candidate_missing')
    if (candidate.runId !== runId || candidate.contentHash !== input.expectedContentHash || candidate.charCount !== input.expectedCharCount ||
      (candidate.sceneId ?? null) !== input.sceneId || candidate.revision !== input.evidenceRevision) {
      throw new Error('manuscript_acceptance_candidate_mismatch')
    }
    const classified = classifyAssistantOutput(candidate.content)
    if (classified.kind !== 'prose' || !classified.complete || classified.content !== candidate.content ||
      manuscriptSegmentHash(candidate.content) !== input.expectedContentHash || codePointLength(candidate.content) !== input.expectedCharCount) {
      throw new Error('manuscript_acceptance_candidate_boundary')
    }
    const config = getConfig(runId)
    const strong = config.strongConstraints as StrongConstraintSnapshot | undefined
    if (strong?.enabled) {
      // The wire fragment can differ from the durable candidate after wrapper
      // trimming, carried-partial merging, sentence clipping or editor commit.
      // Recheck that exact projection; an old passed hash is not transferable.
      const raw = await store.getRunEvidence(runId, 'strong_constraint_latest')
      let previous: Record<string, unknown> | null = null
      try { previous = raw ? JSON.parse(raw.json) as Record<string, unknown> : null } catch { previous = null }
      const prefix = await acceptedTextForRun(runId)
      const draft = `${prefix}${candidate.content}`
      const pipeline = config.writingPipeline as WritingPipelinePolicyV1 | undefined
      // A reviewed pipeline must have finished its own verified stage. Legacy
      // length continuations can reach acceptance before their old wire check;
      // the real projection check below supplies their evidence, not a bypass.
      if (pipeline && (previous?.status !== 'passed' || previous.constraintHash !== strong.hash)) throw new Error('manuscript_constraint_evidence_missing')
      const targetChars = Math.max(0, Number((config.deepWrite as { targetChars?: number } | undefined)?.targetChars) || 0)
      const check = evaluateStrongConstraints(strong, draft, candidate.content, {
        writingForm: frozenWritingForm(config),
        atTarget: targetChars > 0 && codePointLength(draft) >= targetChars,
        requireThemeInSegment: !prefix || strong.level === 'strict',
        checkSegmentPerspective: strong.perspective !== 'auto', qualityReview: Boolean(pipeline)
      })
      const blocking = pipeline ? check.violations.filter((finding) => finding.severity === 'hard') : check.violations
      if (blocking.length) {
        await store.saveRunEvidence(runId, 'strong_constraint_latest', JSON.stringify({ ...previous, status: 'paused', draftHash: writingTextHash(draft), latestSegmentHash: candidate.contentHash, violations: check.violations }))
        await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'manuscript_constraint_projection_blocked', errorMessage: '最终正文投影未通过冻结强约束，未接受或交付；请检查裁切/续写后的正文' })
        throw new Error('manuscript_constraint_projection_blocked')
      }
      await store.saveRunEvidence(runId, 'strong_constraint_latest', JSON.stringify({ ...previous, schemaVersion: 1, status: 'passed', constraintHash: strong.hash, draftHash: writingTextHash(draft), latestSegmentHash: candidate.contentHash, violations: check.violations }))
    }
    const evidenceRefs: Record<string, string | null> = {}
    for (const kind of acceptanceEvidenceKinds(input.segmentId, input.sceneId !== null)) {
      const evidence = await store.getRunEvidence(runId, kind)
      // A no-scene continuation must not inherit the previous accepted scene's
      // evidence. A scene candidate, conversely, requires both newly generated
      // records; the repository still validates their exact identity/hash.
      if (input.sceneId !== null && kind.startsWith('scene_contract_') && !evidence) throw new Error('manuscript_scene_evidence_missing')
      evidenceRefs[kind] = evidence ? writingTextHash(evidence.json) : null
    }
    const evidenceIdentity = manuscriptAcceptanceEvidenceIdentity({
      runId,
      segmentId: input.segmentId,
      candidateHash: input.expectedContentHash,
      candidateCharCount: input.expectedCharCount,
      evidenceRevision: input.evidenceRevision,
      sceneId: input.sceneId,
      evidenceRefs
    })
    await store.saveRunEvidence(runId, 'manuscript_acceptance_ready', JSON.stringify({
      schemaVersion: 1,
      runId,
      segmentId: input.segmentId,
      candidateHash: input.expectedContentHash,
      candidateCharCount: input.expectedCharCount,
      evidenceRevision: input.evidenceRevision,
      evidenceIdentity,
      sceneId: input.sceneId,
      evidenceRefs,
      preparedAt: now()
    }))
    const acceptedAt = now()
    const acceptance: ManuscriptAcceptanceInput = { runId, ...input, evidenceIdentity, acceptedAt }
    if (sceneCommit && store.commitScene) {
      // The acceptance evidence is prepared above, but the story commit must
      // still be fenced against the exact cursor/head used by the provider.
      // Repository.commitScene repeats the check atomically as the final race
      // boundary; this pre-check prevents stale work from reaching it.
      await assertLatestStoryLedgerFence(runId)
      await store.commitScene({ acceptance, ...sceneCommit, committedAt: sceneCommit.committedAt ?? acceptedAt })
    } else if (store.acceptManuscriptSegment) {
      await store.acceptManuscriptSegment(acceptance)
    } else {
      // Compatibility stores without the production acceptance port still
      // enforce the same single-candidate boundary; they cannot provide a
      // cross-process transaction, so production uses the port above.
      const latest = (await getManuscriptSegments(runId)).find((segment) => segment.segmentId === input.segmentId)
      if (!latest || latest.status !== 'candidate' || latest.contentHash !== input.expectedContentHash || latest.charCount !== input.expectedCharCount || (latest.sceneId ?? null) !== input.sceneId) {
        throw new Error('manuscript_acceptance_candidate_stale')
      }
      await saveSegment({ ...latest, status: 'accepted', acceptedAt, updatedAt: acceptedAt })
    }
    const m = mem.get(runId)
    if (m) m.manuscriptCache = null
    return acceptedTextForRun(runId)
  }

  const acceptCurrentCandidate = async (runId: string, turnId: string, sceneId: string | null, sceneCommit?: Omit<SceneCommitInput, 'acceptance' | 'committedAt'> & { committedAt?: number }): Promise<string> => {
    const candidateSegments = await getManuscriptSegments(runId)
    const candidate = candidateSegments
      .filter((segment) => segment.sourceTurnId === turnId && segment.status === 'candidate' && segment.kind === 'prose')
      .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.updatedAt - b.updatedAt)
      .at(-1)
    if (!candidate) throw new Error('manuscript_acceptance_candidate_missing')
    return acceptVerifiedProse(runId, {
      segmentId: candidate.segmentId,
      expectedContentHash: candidate.contentHash,
      expectedCharCount: candidate.charCount,
      evidenceRevision: candidate.revision,
      sceneId
    }, sceneCommit)
  }

  const sourceBoundSceneProjection = (input: {
    runId: string
    contract: SceneContract
    segments: readonly AcceptedSceneSegmentInput[]
    manifest: SceneCommitManifest
    stateDelta: NarrativeStateDelta
    storyId: string
    projectId: string
    branchId: string
    validityEpoch: number
    storyRevision: number
    createdAt: number
  }): NonNullable<SceneCommitInput['projection']> => {
    const manifestHash = sha256Text(stableSceneMemoryJson(input.manifest))
    const sourceSegments: SceneMemorySourceSegment[] = input.segments.map((segment) => ({
      segmentId: segment.segmentId,
      content: segment.content,
      contentHash: segment.contentHash,
      segmentRevision: segment.revision,
      status: 'accepted',
      sceneId: input.contract.sceneId,
      commitId: `${input.runId}:${input.contract.sceneId}`,
      commitManifestHash: manifestHash,
      chunkIndex: segment.chunkIndex
    }))
    const sourceSpans = sourceSegments.flatMap((segment) => {
      const spans: ReturnType<typeof makeSceneMemorySourceSpan>[] = []
      let startUtf16 = 0
      let chunk = 0
      while (startUtf16 < segment.content.length) {
        let endUtf16 = Math.min(segment.content.length, startUtf16 + 16_000)
        // Never split a UTF-16 surrogate pair.  This is also the same bound
        // enforced by the card validator for source-backed text.
        if (endUtf16 < segment.content.length && endUtf16 > startUtf16 && segment.content.charCodeAt(endUtf16 - 1) >= 0xd800 && segment.content.charCodeAt(endUtf16 - 1) <= 0xdbff) endUtf16 -= 1
        if (endUtf16 <= startUtf16) endUtf16 = Math.min(segment.content.length, startUtf16 + 1)
        spans.push(makeSceneMemorySourceSpan({
          spanId: `scene-span:${segment.segmentId}:${chunk}`,
          segmentId: segment.segmentId,
          segmentHash: segment.contentHash,
          segmentRevision: segment.segmentRevision,
          manifestHash,
          content: segment.content,
          startUtf16,
          endUtf16
        }))
        startUtf16 = endUtf16
        chunk += 1
      }
      return spans
    })
    const expectedScope = { storyId: input.storyId, projectId: input.projectId, branchId: input.branchId }
    const expectedContract = { contractId: input.contract.contractId, contractHash: input.contract.frozenHash }
    const expectedBindings = { sceneContentHash: input.manifest.sceneContentHash, commitManifestHash: manifestHash, stateDeltaHash: input.manifest.stateDeltaHash }
    const normalizeClaimText = (value: string): string => value.replace(/\s+/gu, '').trim()
    const sourceSpanFor = (...claims: Array<string | null | undefined>) => {
      const required = claims.filter((claim): claim is string => typeof claim === 'string' && claim.trim().length > 0).map(normalizeClaimText)
      return sourceSpans.find((span) => required.every((claim) => normalizeClaimText(span.text).includes(claim)))
    }
    const claimBase = {
      revision: input.storyRevision,
      validityEpoch: input.validityEpoch,
      storyId: input.storyId,
      projectId: input.projectId,
      branchId: input.branchId,
      stateDeltaHash: input.stateDelta.deltaHash,
      commitManifestHash: manifestHash
    }
    const ledgerClaims: SceneMemoryLedgerClaim[] = []
    const factsEstablished: SceneMemoryCard['factsEstablished'] = []
    const relationshipChanges: SceneMemoryCard['relationshipChanges'] = []
    const threads: SceneMemoryCard['threads'] = []
    const threadProjections = new Map<string, {
      changeRevision: number
      changeId: string
      thread: SceneMemoryCard['threads'][number]
    }>()
    const seenFactIds = new Set<string>()
    for (const change of input.stateDelta.changes) {
      if (change.kind === 'knowledge') {
        const statement = change.factRef?.canonicalStatement?.trim() ?? ''
        const span = statement ? sourceSpanFor(statement) : undefined
        if (!span || seenFactIds.has(change.factId)) continue
        seenFactIds.add(change.factId)
        factsEstablished.push({ factId: change.factId, statement, evidence: [sourceSpanEvidence(span)] })
        continue
      }
      if (change.kind === 'relationship') {
        const value = String(change.value)
        const span = sourceSpanFor(change.dimension, value)
        if (!span) continue
        const claimWithoutHash = {
          id: change.changeId,
          kind: 'relationship' as const,
          ...claimBase,
          fromCharacterId: change.fromCharacterId,
          toCharacterId: change.toCharacterId,
          dimension: change.dimension
        }
        const claim = { ...claimWithoutHash, hash: sceneMemoryLedgerClaimHash(claimWithoutHash) }
        ledgerClaims.push(claim)
        relationshipChanges.push({
          fromCharacterId: change.fromCharacterId,
          toCharacterId: change.toCharacterId,
          dimension: change.dimension,
          from: null,
          to: value,
          evidence: [sourceSpanEvidence(span), ledgerEvidence(claim.id, claim.hash)]
        })
        continue
      }
      if (change.kind === 'foreshadow') {
        const span = sourceSpans[0]
        if (!span) continue
        const claimWithoutHash = {
          id: change.changeId,
          kind: 'foreshadow' as const,
          ...claimBase,
          threadId: change.threadId,
          lifecycle: change.lifecycle
        }
        const claim = { ...claimWithoutHash, hash: sceneMemoryLedgerClaimHash(claimWithoutHash) }
        ledgerClaims.push(claim)
        const thread = {
          threadId: change.threadId,
          lifecycle: change.lifecycle,
          summary: null,
          evidence: [sourceSpanEvidence(span), ledgerEvidence(claim.id, claim.hash)]
        }
        const previous = threadProjections.get(change.threadId)
        if (!previous || change.revision > previous.changeRevision ||
          (change.revision === previous.changeRevision && change.changeId.localeCompare(previous.changeId) > 0)) {
          threadProjections.set(change.threadId, { changeRevision: change.revision, changeId: change.changeId, thread })
        }
      }
    }
    threads.push(...[...threadProjections.values()]
      .sort((left, right) => left.thread.threadId.localeCompare(right.thread.threadId))
      .map((projection) => projection.thread))
    const context: SceneMemoryCardValidationContext = {
      sourceSegments,
      expectedScope,
      expectedValidityEpoch: input.validityEpoch,
      expectedStoryRevision: input.storyRevision,
      expectedContract,
      expectedBindings,
      ledgerClaims
    }
    const card = buildSceneMemoryCard({
      schemaVersion: 1,
      status: 'canonical',
      cardId: `scene-memory:${sha256Text(stableSceneMemoryJson({ runId: input.runId, sceneId: input.contract.sceneId, validityEpoch: input.validityEpoch, storyRevision: input.storyRevision, manifestHash })).slice(0, 48)}`,
      storyId: input.storyId,
      projectId: input.projectId,
      branchId: input.branchId,
      validityEpoch: input.validityEpoch,
      storyRevision: input.storyRevision,
      runId: input.runId,
      sceneId: input.contract.sceneId,
      sceneOrder: input.contract.order,
      contractId: input.contract.contractId,
      contractHash: input.contract.frozenHash,
      sceneContentHash: input.manifest.sceneContentHash,
      commitManifestHash: manifestHash,
      stateDeltaHash: input.manifest.stateDeltaHash,
      povCharacterId: null,
      participants: [],
      locations: [],
      objects: [],
      dramaticQuestion: null,
      valueShift: null,
      decisiveAction: null,
      turn: null,
      cost: null,
      factsEstablished,
      beliefChanges: [],
      relationshipChanges,
      threads,
      motifs: [],
      distinctivePhrases: [],
      sourceSegments,
      sourceSpans,
      fieldEvidence: {},
      expectedScope,
      expectedValidityEpoch: input.validityEpoch,
      expectedStoryRevision: input.storyRevision,
      expectedContract,
      expectedBindings,
      ledgerClaims,
      createdAt: input.createdAt
    })
    return { card, context }
  }

  const acceptSceneCandidate = async (
    runId: string,
    turnId: string,
    context: { contract: SceneContract; state: SceneStateRecord; sceneChars: number },
    lengthContinuation = false
  ): Promise<{ acceptedText: string; decision: SceneCompletionDecision }> => {
    const segments = await getManuscriptSegments(runId)
    const candidate = segments
      .filter((segment) => segment.sourceTurnId === turnId && (segment.status === 'candidate' || segment.status === 'accepted') && segment.kind === 'prose' && segment.sceneId === context.contract.sceneId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.updatedAt - b.updatedAt)
      .at(-1)
    if (!candidate) throw new Error('manuscript_acceptance_candidate_missing')
    const alreadyAccepted = candidate.status === 'accepted'
    if (!alreadyAccepted && context.state.lifecycle === 'writing') await markSceneCandidate(context, candidate, now())
    const scenePrefix = segments
      .filter((segment) => segment.kind === 'prose' && segment.status === 'accepted' && segment.sceneId === context.contract.sceneId && segment.segmentId !== candidate.segmentId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt)
      .map((segment) => segment.content)
      .join('')
    const evaluation = evaluateSceneContract(context.contract, candidate.content, {
      sceneChars: codePointLength(scenePrefix) + candidate.charCount,
      completed: true,
      scenePrefix,
      ...await readSceneCriticOptions(runId, context.contract, candidate.content, scenePrefix)
    })
    const decision = buildSceneCompletionDecision(context.contract, candidate.content, {
      candidateSegmentId: candidate.segmentId,
      scenePrefix,
      evaluation,
      at: now()
    })
    if (sceneSemanticReviewRequired(evaluation, context.contract, true) || (!alreadyAccepted && !lengthContinuation && evaluation.status !== 'deviated' && evaluation.violations.some(item => item.code === 'missing_required_beat'))) {
      // Do not transition the candidate to accepted, build a state delta, or
      // enter the next provider cycle until the unresolved beat is confirmed.
      // The evidence packet is durable and prefix-bound, so a restart can
      // surface the same decision without re-running the model.
      await persistSceneSemanticPendingReview(runId, context, candidate, scenePrefix, evaluation, decision)
      const reasons = sceneSemanticReviewReasons(evaluation, context.contract).join(',')
      throw new NarrativeStatePendingReviewError(`scene_semantic_pending_review:${reasons || 'ambiguous'}`)
    }
    // P1-2: a complete scene must carry a real, auditable narrative delta.
    // The candidate is still unaccepted at this point, so the extractor gets
    // the accepted prefix plus this candidate as a provisional full-scene
    // manifest.  The repository rechecks that exact manifest inside its
    // commit transaction after the candidate is accepted.
    const sceneSegments: AcceptedSceneSegmentInput[] = segments
      .filter((item) => item.kind === 'prose' && item.sceneId === context.contract.sceneId && (item.status === 'accepted' || item.segmentId === candidate.segmentId))
      .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt || a.segmentId.localeCompare(b.segmentId))
      .map((item) => ({
        segmentId: item.segmentId,
        contentHash: item.contentHash,
        charCount: item.charCount,
        chunkIndex: item.chunkIndex,
        revision: item.revision,
        content: item.content
      }))
    const runConfig = getConfig(runId) as RunConfig & {
      grillMe?: { answers?: ConfirmedGrillAnswerInput[] }
    }
    // ContextService normally materializes the confirmed Grill answers before
    // this point. Read the durable registry here as a second boundary so a
    // knowledge edge cannot bypass factRef validation during scene commit.
    // An empty/absent registry is intentionally passed through as an empty
    // list (or unavailable marker): structured knowledge then pauses in the
    // extractor instead of producing a bare factId.
    const registryStore = store as RunStorePort & { getNarrativeFacts?: (sessionId: string, includeInactive?: boolean) => Promise<NarrativeFact[]> }
    let confirmedFacts: NarrativeFact[] | undefined
    if (Array.isArray(runConfig.grillMe?.answers) && typeof runConfig.sessionId === 'string' && typeof registryStore.getNarrativeFacts === 'function') {
      const loadedFacts = await registryStore.getNarrativeFacts(runConfig.sessionId, false)
      confirmedFacts = loadedFacts
    }
    const extractedState = decision.status === 'complete'
      ? extractNarrativeStateDelta({
          runId,
          sceneId: context.contract.sceneId,
          contract: context.contract,
          decision,
          candidateSegmentId: candidate.segmentId,
          candidateContentHash: candidate.contentHash,
          acceptedSegments: sceneSegments,
          confirmedAnswers: runConfig.grillMe?.answers,
          confirmedFacts,
          now: now()
        })
      : null
    if (extractedState?.status === 'pending_review') {
      // This evidence is deliberately written before surfacing the error. It
      // gives recovery/UI a bound explanation and prevents a caller from
      // mistaking an empty delta for a successful state projection.
      const packet = await makeNarrativeReviewPacket({
        runId,
        context,
        segment: candidate,
        scenePrefix,
        evaluation,
        completionDecision: decision,
        reason: 'narrative_state_pending_review',
        reasons: extractedState.report.pendingReasons.map((message) => ({ code: message.split(':', 1)[0] || 'narrative_state_pending_review', severity: 'blocking' as const, evidence: [message], message })),
        acceptedSegments: sceneSegments
      })
      await persistNarrativeReviewPacket(packet)
      await store.saveRunEvidence(runId, 'narrative_state_pending_review', JSON.stringify({ ...extractedState.report, reviewPacketHash: packet.packetHash, reviewRevision: packet.revision }))
      await store.saveRunEvidence(runId, `narrative_state_pending_review:${candidate.segmentId}`, JSON.stringify({ ...extractedState.report, reviewPacketHash: packet.packetHash, reviewRevision: packet.revision }))
      throw new NarrativeStatePendingReviewError()
    }
    const stateDelta = extractedState?.delta ?? buildEmptyNarrativeStateDelta({
      runId,
      sceneId: context.contract.sceneId,
      acceptedSegmentId: candidate.segmentId,
      acceptedContentHash: candidate.contentHash,
      contractHash: context.contract.frozenHash
    })
    if (extractedState?.status === 'ready') {
      await store.saveRunEvidence(runId, 'narrative_state_delta_ready', JSON.stringify(extractedState.report))
    }
    await store.saveRunEvidence(runId, `scene_completion_decision:${candidate.segmentId}`, JSON.stringify({
      schemaVersion: 1,
      runId,
      sceneId: context.contract.sceneId,
      contractId: context.contract.contractId,
      contractHash: context.contract.frozenHash,
      candidateSegmentId: candidate.segmentId,
      candidateHash: candidate.contentHash,
      decision,
      evaluation,
      stateDeltaHash: stateDelta.deltaHash,
      ...(extractedState?.status === 'ready' ? {
        narrativeStateExtraction: extractedState.report,
        narrativeSceneManifest: extractedState.manifest
      } : {}),
      savedAt: now()
    }))
    const commitFence = storyLedgerFences.get(runId) ?? null
    if (decision.status === 'complete' && store.commitScene && store.getStoryLedgerFreshness && !commitFence) throw new Error('story_ledger_fence_missing')
    const projection = decision.status === 'complete' && extractedState?.status === 'ready' && extractedState.manifest && commitFence
      ? sourceBoundSceneProjection({
          runId,
          contract: context.contract,
          segments: sceneSegments,
          manifest: extractedState.manifest,
          stateDelta,
          storyId: commitFence.scope.storyId,
          projectId: commitFence.scope.projectId,
          branchId: commitFence.scope.branchId,
          validityEpoch: commitFence.expectedEpoch,
          storyRevision: commitFence.expectedHeadRevision + 1,
          createdAt: now()
        })
      : undefined
    const sceneCommit = decision.status === 'complete'
      ? {
          contractId: context.contract.contractId,
          contractHash: context.contract.frozenHash,
          expectedSceneRevision: context.state.revision,
          decision,
          completionEvidenceHash: decision.evidenceHash,
          stateDelta,
          ...(extractedState?.status === 'ready' && extractedState.manifest ? { manifest: extractedState.manifest } : {}),
          ...(projection ? { projection } : {}),
          ...(commitFence ? { expectedLedgerFence: { expectedRevision: commitFence.expectedRevision, expectedEpoch: commitFence.expectedEpoch, expectedHeadRevision: commitFence.expectedHeadRevision, expectedHeadHash: commitFence.expectedHeadHash } } : {}),
          committedAt: now()
        }
      : undefined
    const acceptedText = alreadyAccepted
      ? await acceptedTextForRun(runId)
      : await acceptCurrentCandidate(runId, turnId, context.contract.sceneId, sceneCommit)
    if (alreadyAccepted && decision.status === 'complete' && store.commitScene) {
      const prepared = await store.getRunEvidence(runId, 'manuscript_acceptance_ready')
      let evidenceIdentity = ''
      try {
        const parsed = prepared ? JSON.parse(prepared.json) as { segmentId?: unknown; candidateHash?: unknown; candidateCharCount?: unknown; evidenceRevision?: unknown; evidenceIdentity?: unknown; sceneId?: unknown } : null
        if (parsed?.segmentId === candidate.segmentId && parsed.candidateHash === candidate.contentHash && parsed.candidateCharCount === candidate.charCount && parsed.evidenceRevision === candidate.revision && (parsed.sceneId ?? null) === context.contract.sceneId && typeof parsed.evidenceIdentity === 'string') evidenceIdentity = parsed.evidenceIdentity
      } catch {
        evidenceIdentity = ''
      }
      if (!evidenceIdentity) throw new Error('manuscript_acceptance_evidence_missing')
      await assertLatestStoryLedgerFence(runId)
      await store.commitScene({
        acceptance: {
          runId,
          segmentId: candidate.segmentId,
          expectedContentHash: candidate.contentHash,
          expectedCharCount: candidate.charCount,
          evidenceRevision: candidate.revision,
          evidenceIdentity,
          sceneId: context.contract.sceneId,
          acceptedAt: now()
        },
        contractId: context.contract.contractId,
        contractHash: context.contract.frozenHash,
        expectedSceneRevision: context.state.revision,
        decision,
        completionEvidenceHash: decision.evidenceHash,
        stateDelta,
        ...(extractedState?.status === 'ready' && extractedState.manifest ? { manifest: extractedState.manifest } : {}),
        ...(projection ? { projection } : {}),
        ...(commitFence ? { expectedLedgerFence: { expectedRevision: commitFence.expectedRevision, expectedEpoch: commitFence.expectedEpoch, expectedHeadRevision: commitFence.expectedHeadRevision, expectedHeadHash: commitFence.expectedHeadHash } } : {}),
        committedAt: now()
      })
    }
    if (decision.status === 'defer') {
      const next = await transitionScene({
        runId,
        sceneId: context.contract.sceneId,
        contractId: context.contract.contractId,
        contractHash: context.contract.frozenHash,
        expectedRevision: context.state.revision,
        from: ['candidate', 'writing'],
        to: 'accepted',
        candidateSegmentId: candidate.segmentId,
        candidateHash: candidate.contentHash,
        acceptedSegmentId: candidate.segmentId,
        acceptedHash: candidate.contentHash,
        completionDecision: decision,
        completionEvidenceHash: decision.evidenceHash,
        at: now()
      })
      if (next) Object.assign(context.state, next)
    } else if (!store.commitScene) {
      const next = await transitionScene({
        runId,
        sceneId: context.contract.sceneId,
        contractId: context.contract.contractId,
        contractHash: context.contract.frozenHash,
        expectedRevision: context.state.revision,
        from: ['candidate', 'accepted'],
        to: 'committed',
        candidateSegmentId: candidate.segmentId,
        candidateHash: candidate.contentHash,
        acceptedSegmentId: candidate.segmentId,
        acceptedHash: candidate.contentHash,
        completionDecision: decision,
        completionEvidenceHash: decision.evidenceHash,
        at: now()
      })
      if (next) Object.assign(context.state, next)
    }
    return { acceptedText, decision }
  }

  interface AuxCallResult {
    text: string
    durationMs: number
    ttftMs: number | null
    usage: { inputTokens: number | null; outputTokens: number | null; cacheHitTokens: number | null; cacheMissTokens: number | null; reasoningTokens: number | null; cost: number | null }
  }

  /** critic/editor 是隐藏的结构化 provider 调用：不写 turn、不向 renderer 发文本/reasoning。 */
  const collectAuxCall = async (
    runId: string,
    purpose: 'critic' | 'editor',
    messages: DsMessage[],
    turnSeq: number,
    round: number
  ): Promise<AuxCallResult> => {
    const startedAt = now()
    let firstTokenAt: number | null = null
    let text = ''
    let finishReason: string | null = null
    let usage: AuxCallResult['usage'] = { inputTokens: null, outputTokens: null, cacheHitTokens: null, cacheMissTokens: null, reasoningTokens: null, cost: null }
    const iter = await callModel({ runId, phase: 'validating', turnSeq, round, messages, purpose })
    for await (const ev of iter) {
      if ((ev.type === 'text' || ev.type === 'reasoning') && firstTokenAt === null) firstTokenAt = now()
      if (ev.type === 'text') text += ev.delta ?? ''
      else if (ev.type === 'tool_call') throw new Error(`${purpose}_tool_call_rejected`)
      else if (ev.type === 'usage' && ev.usage) {
        usage = {
          inputTokens: ev.usage.inputTokens ?? null,
          outputTokens: ev.usage.outputTokens ?? null,
          cacheHitTokens: ev.usage.cacheHitTokens ?? null,
          cacheMissTokens: ev.usage.cacheMissTokens ?? null,
          reasoningTokens: ev.usage.reasoningTokens ?? null,
          cost: ev.usage.cost ?? null
        }
      } else if (ev.type === 'finish') finishReason = ev.finishReason ?? null
    }
    if (finishReason !== 'stop') throw new Error(`${purpose}_finish_${finishReason ?? 'missing'}`)
    const durationMs = Math.max(0, now() - startedAt)
    const m = mem.get(runId)
    if (m && usage.inputTokens !== null && usage.outputTokens !== null) {
      m.usage.inputTokens += usage.inputTokens
      m.usage.outputTokens += usage.outputTokens
      m.usage.cacheHitTokens += usage.cacheHitTokens ?? 0
      m.usage.cacheMissTokens += usage.cacheMissTokens ?? 0
      m.usage.reasoningTokens += usage.reasoningTokens ?? 0
      if (usage.cost !== null) m.usage.cost += usage.cost
      const modelName = typeof (getConfig(runId).model ?? '') === 'string' ? String(getConfig(runId).model ?? '') : ''
      await store.appendUsage({
        runId,
        callType: `kernel-${purpose}`,
        model: modelName,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheHit: usage.cacheHitTokens ?? 0,
        cacheMiss: usage.cacheMissTokens ?? 0,
        createdAt: now()
      })
      m.usageRevision += 1
      emit(runId, {
        type: 'usage',
        usage: {
          inputTokens: m.usage.inputTokens,
          outputTokens: m.usage.outputTokens,
          cacheHitTokens: m.usage.cacheHitTokens,
          cacheMissTokens: m.usage.cacheMissTokens,
          ...(usage.reasoningTokens !== null ? { reasoningTokens: m.usage.reasoningTokens } : {}),
          ...(usage.cost !== null ? { cost: m.usage.cost } : {}),
          revision: m.usageRevision,
          kind: 'actual'
        }
      })
    }
    return { text, durationMs, ttftMs: firstTokenAt === null ? null : Math.max(0, firstTokenAt - startedAt), usage }
  }

  const usageFact = (label: string, round: number, call: AuxCallResult): string => {
    const u = call.usage
    const token = (value: number | null): string => value === null ? '未知' : String(value)
    const cost = u.cost === null ? '费用未知' : `实际费用 ¥${u.cost.toFixed(6)}`
    return `${label} 第${round}轮 ${call.durationMs} ms / TTFT ${call.ttftMs === null ? '未知' : `${call.ttftMs} ms`} / 输入${token(u.inputTokens)} 输出${token(u.outputTokens)} 缓存命中${token(u.cacheHitTokens)} 未命中${token(u.cacheMissTokens)} 推理${token(u.reasoningTokens)} tokens / ${cost}`
  }

  const runWritingPipeline = async (input: {
    runId: string
    round: number
    turnId: string
    turnSeq: number
    candidate: string
    acceptedPrefix: string
    targetChars: number
    snapshot: StrongConstraintSnapshot
    policy: WritingPipelinePolicyV1
    atTarget: boolean
    sceneContract?: SceneContract
    sceneChars?: number
    candidateSegmentId?: string
    candidateRevision?: number
    narrativeQuality?: NarrativeQualityEvaluation
    /** 首次为 0；格式纠正与中断恢复共用同一 durable 两次额度。 */
    criticAttempt?: number
    sectionReview?: WritingSectionReview
    onCommit: (content: string, localizedRevision?: Wp7LocalizedRevisionDecision) => Promise<void>
  }): Promise<{ status: 'accepted'; content: string; advisories: WritingCriticIssue[] } | { status: 'paused' }> => {
    const pipelineStartedAt = now()
    const candidateHash = writingTextHash(input.candidate)
    const persistSectionReview = async (content: string, rawCoverage: unknown): Promise<void> => {
      if (!input.sectionReview) return
      const coverage = validateSectionCoverage(rawCoverage, input.sectionReview, content)
      await store.saveRunEvidence(input.runId, sectionReviewEvidenceKind(input.turnId, writingTextHash(content)), JSON.stringify({ schemaVersion: 1,
        sectionId: input.sectionReview.sectionId, outlineHash: input.sectionReview.outlineHash,
        candidateHash: writingTextHash(content), contentHash: writingTextHash(input.sectionReview.acceptedPrefix + content),
        coverage, rawCoverage: rawCoverage ?? null }))
      emit(input.runId, { type: 'phase', phase: 'validating', title: '本节覆盖意见', detail: `${coverage.status === 'covered' ? '审校认为目的已覆盖' : coverage.status === 'needs_attention' ? '审校建议继续补足' : '覆盖意见未验证'} · ${coverage.reason || '逐字引用只证明意见来源，不代表事实核验'}` })
    }
    const scenePrefix = input.sceneContract ? (await getManuscriptSegments(input.runId))
      .filter(segment => segment.kind === 'prose' && segment.status === 'accepted' && segment.sceneId === input.sceneContract!.sceneId && segment.segmentId !== input.candidateSegmentId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt)
      .map(segment => segment.content).join('') : ''
    const sceneBeatReview = input.sceneContract ? {
      semanticVersion: 2 as const, contractHash: input.sceneContract.frozenHash, scenePrefixHash: writingTextHash(scenePrefix), scenePrefix,
      requiredBeats: deriveSceneBeatRequiredParts(input.sceneContract)
    } : undefined
    const sceneCriticProtocolIssues = (value: WritingCriticReportV1): WritingCriticSemanticIssue[] => {
      if (!input.sceneContract) return []
      const raw = bindSceneBeatCriticEvidence(input.sceneContract, input.candidate, scenePrefix, value.sceneBeatEvidence)
      const checked = validateSceneBeatSemanticEvidence(input.sceneContract, input.candidate, scenePrefix, raw)
      return [...checked.issues, ...checked.invalidBeatIds.filter(id => !checked.issues.some(issue => issue.beatId === id)).map(beatId => ({ beatId, reason: 'evidence_invalid' })),
        ...raw.filter(beat => beat?.semanticVersion !== 2).map(beat => ({ beatId: beat?.beatId ?? 'unknown', reason: 'semantic_version_invalid' })),
        ...input.sceneContract.requiredBeatIds.filter(id => !raw.some(beat => beat?.beatId === id))
        .map(beatId => ({ beatId, reason: 'beat_missing' }))]
    }
    const withSceneContract = (messages: DsMessage[]): DsMessage[] => [
      ...(input.sceneContract ? [{ role: 'system' as const, content: buildSceneContractPrompt(input.sceneContract, input.sceneChars) }] : []),
      ...(input.narrativeQuality ? [{ role: 'system' as const, content: buildNarrativeQualityPrompt(input.narrativeQuality) }] : []),
      ...messages
    ]
    if (input.sceneContract) {
      const config = getConfig(input.runId)
      const plan = sceneContractPlanValid(config.sceneContracts) ? config.sceneContracts : null
      if (plan) {
        const acceptedChars = codePointLength(await acceptedTextForRun(input.runId))
        await saveSceneContractFrozenEvidence(input.runId, { plan, contract: input.sceneContract, acceptedChars, sceneChars: input.sceneChars ?? 0 }, input.round, 'critic')
      }
    }
    const priorEvidence = await store.getRunEvidence(input.runId, 'writing_pipeline_latest')
    let priorReplaceRevision = 0
    // A conservative default survives even failure to decode legacy evidence.
    // callAttempts on editor_started belongs to the editor, never this allowance.
    const evidenceBase = { schemaVersion: 1, policyHash: input.policy.hash, turnId: input.turnId, turnSeq: input.turnSeq, round: input.round, replaceRevision: 0, criticCandidateHash: candidateHash, criticSegmentId: input.candidateSegmentId ?? null, criticCallAttempts: 2,
      ...(store.getStoryLedgerFreshness ? { providerFence: writingProviderFence({ runId: input.runId, turnId: input.turnId, policyHash: input.policy.hash, candidate: input.candidate, segmentId: input.candidateSegmentId, revision: input.candidateRevision }) } : {}) }
    const assertCriticIdentity = async (): Promise<void> => {
      const m = mem.get(input.runId)
      if (!m || m.controller.signal.aborted || m.pauseRequested || m.run.status === 'cancel_requested' || m.run.status === 'cancelled') throw new Error('critic_aborted')
      const policy = getConfig(input.runId).writingPipeline as WritingPipelinePolicyV1 | undefined
      if (!writingPipelinePolicyValid(policy) || policy?.hash !== evidenceBase.policyHash) throw new Error('critic_policy_identity_mismatch')
      if (isLongWriteConfig(getConfig(input.runId)) && input.candidateSegmentId) {
        // The raw provider turn may contain a carried/clipped tail. The exact
        // durable prose segment, not that UI/source projection, is the critic input.
        // Security/identity rechecks must not reuse the manuscript projection
        // cache: another durable writer can update a still-unaccepted candidate.
        const currentSegments = store.getManuscriptSegments ? await store.getManuscriptSegments(input.runId) : [...fallbackSegmentsFor(input.runId).values()]
        const segment = currentSegments.find(item => item.segmentId === input.candidateSegmentId)
        if (!segment || segment.sourceTurnId !== input.turnId || segment.kind !== 'prose' || segment.contentHash !== candidateHash || writingTextHash(segment.content) !== candidateHash ||
          (input.candidateRevision !== undefined && segment.revision !== input.candidateRevision)) throw new Error('critic_candidate_identity_mismatch')
      } else {
        const turn = (await store.getTurns(input.runId)).find(item => item.turnId === input.turnId)
        if (!turn || writingTextHash(turn.content) !== candidateHash) throw new Error('critic_candidate_identity_mismatch')
      }
      await assertLatestStoryLedgerFence(input.runId)
    }
    const localCheck = evaluateStrongConstraints(input.snapshot, `${input.acceptedPrefix}${input.candidate}`, input.candidate, {
      writingForm: input.policy.writingForm,
      atTarget: input.atTarget,
      requireThemeInSegment: codePointLength(input.acceptedPrefix) === 0,
      checkSegmentPerspective: input.snapshot.perspective !== 'auto',
      qualityReview: true
    })
    emit(input.runId, { type: 'phase', phase: 'validating', title: '审校当前片段', detail: '检查主题边界、人物声音与收束方式；正文暂不撤回' })
    let critic!: AuxCallResult
    let report: WritingCriticReportV1 | null = null
    try {
      const prior = priorEvidence ? JSON.parse(priorEvidence.json) as Record<string, unknown> : null
      if (prior && typeof prior.turnId !== 'string') throw new Error('critic_attempt_evidence_invalid')
      priorReplaceRevision = Math.max(0, Number(prior?.replaceRevision ?? 0))
      evidenceBase.replaceRevision = priorReplaceRevision
      const persistedAttempts = prior?.turnId === input.turnId
        ? readWritingCriticAttempts(prior, { turnId: input.turnId, policyHash: input.policy.hash, candidateHash }) : 0
      const resumeAttempts = input.criticAttempt ?? 0
      if (!Number.isInteger(resumeAttempts) || resumeAttempts < 0 || resumeAttempts > 2) throw new Error('critic_attempt_evidence_invalid')
      evidenceBase.criticCallAttempts = Math.max(persistedAttempts, resumeAttempts)
      await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify({ ...evidenceBase, stage: 'candidate_persisted', candidateHash }))
      let repair: ReturnType<typeof prepareCriticFormatRepair> = null
      if (evidenceBase.criticCallAttempts === 1) {
        const completed = await store.getRunEvidence(input.runId, `writing_pipeline_critic_${input.turnId}_${candidateHash}_1`)
        if (completed) {
          const saved = JSON.parse(completed.json) as Record<string, unknown>
          if (readWritingCriticAttempts(saved, { turnId: input.turnId, policyHash: input.policy.hash, candidateHash }) !== 1 || saved.finishReason !== 'stop' ||
            typeof saved.raw !== 'string' || writingTextHash(saved.raw) !== saved.rawHash ||
            (store.getStoryLedgerFreshness && stableNarrativeJson(saved.providerFence) !== stableNarrativeJson(evidenceBase.providerFence))) throw new Error('critic_attempt_evidence_invalid')
          if (saved.error === null) {
            report = parseCriticReport(criticJsonPayload(saved.raw), input.candidate, candidateHash, input.policy.maxIssues)
            critic = { text: saved.raw, durationMs: Number(saved.durationMs ?? 0), ttftMs: null, usage: saved.usage as AuxCallResult['usage'] }
            const problems = sceneCriticProtocolIssues(report)
            if (problems.length) {
              repair = prepareCriticSemanticRepair(saved.raw, input.candidate, candidateHash, problems, input.policy.maxIssues)
              if (!repair) throw new Error('critic_attempt_evidence_invalid')
              report = null
            }
          } else {
            repair = String(saved.error).startsWith('critic_semantic_evidence_invalid:')
              ? prepareCriticSemanticRepair(saved.raw, input.candidate, candidateHash,
                sceneCriticProtocolIssues(parseCriticReport(criticJsonPayload(saved.raw), input.candidate, candidateHash, input.policy.maxIssues)), input.policy.maxIssues)
              : prepareCriticFormatRepair(saved.raw, String(saved.error), input.candidate, candidateHash, input.policy.maxIssues)
            if (!repair) throw new Error('critic_attempt_evidence_invalid')
          }
        } else throw new Error('critic_attempt_evidence_invalid')
      }
      while (!report) {
        await assertCriticIdentity()
        if (evidenceBase.criticCallAttempts >= 2) throw new Error('critic_retry_budget_exhausted')
        evidenceBase.criticCallAttempts += 1
        await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify({ ...evidenceBase, stage: 'critic_started', candidateHash, callAttempts: evidenceBase.criticCallAttempts }))
        await assertCriticIdentity()
        // Transport/non-stop/abort failures never enter the format-repair path.
        critic = await collectAuxCall(input.runId, 'critic', withSceneContract(repair
          ? buildCriticFormatRepairMessages({ policy: input.policy, candidate: input.candidate, repair, sceneBeatReview })
          : buildCriticMessages({ policy: input.policy, snapshot: input.snapshot, candidate: input.candidate, candidateHash, sceneBeatReview, sectionReview: input.sectionReview })), input.turnSeq, 100000 + input.round * 10 + (evidenceBase.criticCallAttempts - 1) * 3)
        let parseError: unknown = null
        let semanticProblems: WritingCriticSemanticIssue[] = []
        try {
          report = repair ? parseCorrectedCriticReport(critic.text, input.candidate, repair, input.policy.maxIssues)
            : parseCriticReport(criticJsonPayload(critic.text), input.candidate, candidateHash, input.policy.maxIssues)
          if (repair && !repair.semanticCorrection && filterIssuesForPolicy(report.issues, input.policy).length !== report.issues.length) throw new Error('critic_format_repair_findings_filtered')
          semanticProblems = sceneCriticProtocolIssues(report)
          if (semanticProblems.length) {
            if (input.sceneContract) await persistSceneCriticEvidence({ runId: input.runId, contract: input.sceneContract, candidate: input.candidate, scenePrefix, raw: report.sceneBeatEvidence, criticHash: writingTextHash(critic.text) })
            throw new Error(`critic_semantic_evidence_invalid:${JSON.stringify(semanticProblems)}`)
          }
        } catch (error) { report = null; parseError = error }
        const kind = `writing_pipeline_critic_${input.turnId}_${candidateHash}_${evidenceBase.criticCallAttempts}`
        if (await store.getRunEvidence(input.runId, kind)) throw new Error('critic_attempt_evidence_conflict')
        await store.saveRunEvidence(input.runId, kind, JSON.stringify({ ...evidenceBase, candidateHash, finishReason: 'stop', raw: critic.text, rawHash: writingTextHash(critic.text), error: parseError ? errMsg(parseError) : null, durationMs: critic.durationMs, usage: critic.usage }))
        await assertCriticIdentity()
        if (!parseError) break
        if (repair || evidenceBase.criticCallAttempts >= 2) throw parseError
        repair = semanticProblems.length
          ? prepareCriticSemanticRepair(critic.text, input.candidate, candidateHash, semanticProblems, input.policy.maxIssues)
          : prepareCriticFormatRepair(critic.text, errMsg(parseError), input.candidate, candidateHash, input.policy.maxIssues)
        if (!repair) throw parseError
      }
      await assertCriticIdentity()
      if (!report) throw new Error('critic_report_missing')
      if (input.sceneContract) await persistSceneCriticEvidence({ runId: input.runId, contract: input.sceneContract, candidate: input.candidate, scenePrefix, raw: report.sceneBeatEvidence, criticHash: writingTextHash(critic!.text) })
    } catch (error) {
      // A denied reservation/actual usage overrun is a budget stop, not a
      // malformed critic response. Preserve its actionable durable run code.
      if (error instanceof RunBudgetExceededError) throw error
      const message = `文字审校未返回可验证结果（${errMsg(error)}）；原稿已保留，等待你决定是否重试`
      await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify({ ...evidenceBase, stage: 'paused', candidateHash, errorCode: 'critic_invalid', message }))
      if (mem.get(input.runId)?.controller.signal.aborted) {
        if (!mem.get(input.runId)?.pauseRequested) await finalizeCancel(input.runId)
        return { status: 'paused' }
      }
      await patchRun(input.runId, { status: 'waiting_user', phase: 'paused', errorCode: 'writing_critic_invalid', errorMessage: message })
      emit(input.runId, { type: 'phase', phase: 'paused', title: '文字审校已暂停', detail: message })
      return { status: 'paused' }
    }
    const localIssues = [
      ...issuesFromDeterministic(input.candidate, localCheck.violations),
      ...detectZombieStyleIssues(input.candidate, input.policy.expressionFreedom)
    ]
    const issues = filterIssuesForPolicy(mergeCriticIssues(localIssues, report.issues, input.policy.maxIssues), input.policy)
    await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify({
      ...evidenceBase,
      stage: 'critic_done',
      candidateHash,
      issues,
      critic: { rawHash: writingTextHash(critic.text), durationMs: critic.durationMs, ttftMs: critic.ttftMs, usage: critic.usage }
    }))
    if (issues.length === 0) {
      const providerOrigin = (() => { try { return new URL(String(getConfig(input.runId).baseUrl ?? '')).host || '未知 provider' } catch { return '未知 provider' } })()
      const model = String(getConfig(input.runId).model ?? '未知模型')
      const acceptedEvidence = { ...evidenceBase, stage: 'accepted', candidateHash, issues: [], critic: { durationMs: critic.durationMs, ttftMs: critic.ttftMs, usage: critic.usage }, totalDurationMs: Math.max(0, now() - pipelineStartedAt) }
      await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify(acceptedEvidence))
      await store.saveRunEvidence(input.runId, `writing_pipeline_cycle_${String(input.round).padStart(6, '0')}`, JSON.stringify(acceptedEvidence))
      emit(input.runId, { type: 'phase', phase: 'validating', title: '审校完成', detail: `未发现需要改动的片段 · ${providerOrigin} · ${model} · ${usageFact('critic', input.round, critic)} · 审校总计 ${Math.max(0, now() - pipelineStartedAt)} ms` })
      await persistSectionReview(input.candidate, report.sectionCoverage)
      return { status: 'accepted', content: input.candidate, advisories: [] }
    }
    const issue = [...issues].sort((a, b) => (a.severity === b.severity ? a.startCp - b.startCp : a.severity === 'hard' ? -1 : 1))[0]
    const issueLabel: Record<string, string> = {
      explicit_forbidden: '用户禁项', explicit_must_keep: '必须保持', explicit_perspective: '叙事视角', explicit_genre: '体裁边界', topic_drift: '主题偏移',
      preachy_template: '说教式收尾', formulaic_rhythm: '节奏模板化', emotion_explained: '情绪解释过密', cliche_language: '套话过密'
    }
    const categoryLabel = issueLabel[issue.code] ?? issue.code
    const acceptOriginalWithAdvisory = async (reason: string, advisoryIssues = issues): Promise<{ status: 'accepted'; content: string; advisories: WritingCriticIssue[] }> => {
      const acceptedEvidence = {
        ...evidenceBase, stage: 'accepted', candidateHash, issues: advisoryIssues,
        acceptedWithAdvisory: true, autoEditSkippedReason: reason,
        critic: { durationMs: critic.durationMs, ttftMs: critic.ttftMs, usage: critic.usage },
        totalDurationMs: Math.max(0, now() - pipelineStartedAt)
      }
      await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify(acceptedEvidence))
      await store.saveRunEvidence(input.runId, `writing_pipeline_cycle_${String(input.round).padStart(6, '0')}`, JSON.stringify(acceptedEvidence))
      emit(input.runId, { type: 'phase', phase: 'validating', title: '审校建议已记录', detail: `${categoryLabel} · 原稿保留 · ${reason}` })
      await persistSectionReview(input.candidate, report.sectionCoverage)
      return { status: 'accepted', content: input.candidate, advisories: advisoryIssues }
    }
    const boundary = assessAutoEditBoundary(input.candidate, issue)
    if (!boundary.ok) {
      if (issue.severity === 'hard') {
        const message = `${categoryLabel}属于用户明确硬边界，但命中范围不适合自动局部修订；原稿保留，等待你确认`
        await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify({ ...evidenceBase, stage: 'paused', candidateHash, issues, errorCode: boundary.reason, message }))
        await patchRun(input.runId, { status: 'waiting_user', phase: 'paused', errorCode: 'writing_hard_boundary_requires_user', errorMessage: message })
        emit(input.runId, { type: 'phase', phase: 'paused', title: '硬边界需要确认', detail: message })
        return { status: 'paused' }
      }
      return acceptOriginalWithAdvisory(boundary.reason ?? '超出自动局部修订边界')
    }
    emit(input.runId, {
      type: 'phase', phase: 'validating', title: '局部修订中',
      detail: `${categoryLabel} · ${issue.startCp}–${issue.endCp} 字 · 只改命中范围`
    })
    let editor: AuxCallResult
    let applied
    let proposedPatch: { issueId: string; startCp: number; endCp: number; quote: string; replacement: string }
    try {
      // editor 没有盲重放：调用前先 durable 标记；若进程中断，恢复时暂停，
      // 避免对同一候选无限付费或把不确定的远端结果重复应用。
      await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify({
        ...evidenceBase, stage: 'editor_started', candidateHash, issues, callAttempts: 1
      }))
      editor = await collectAuxCall(input.runId, 'editor', withSceneContract(buildEditorMessages({ policy: input.policy, candidate: input.candidate, candidateHash, issue })), input.turnSeq, 100001 + input.round * 10)
      const plan = parseEditorPlan(editor.text, input.candidate, issue, candidateHash)
      proposedPatch = plan.patches[0]
      applied = applyTargetedEdit(input.candidate, plan)
      const revisedDraft = `${input.acceptedPrefix}${applied.content}`
      if (input.targetChars > 0 && codePointLength(revisedDraft) > input.targetChars) throw new Error('editor_target_overflow')
      // 修订稿尚未通过 deterministic + verification critic，不能写 turn/canonical/UI。
      await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify({
        ...evidenceBase, stage: 'edit_proposed', candidateHash, beforeHash: applied.beforeHash, afterHash: applied.afterHash,
        patch: plan.patches[0], issues,
        editor: { rawHash: writingTextHash(editor.text), durationMs: editor.durationMs, ttftMs: editor.ttftMs, usage: editor.usage }
      }))
    } catch (error) {
      if (issue.severity !== 'hard') return acceptOriginalWithAdvisory(`自动局部修订未通过校验：${errMsg(error)}`)
      const message = `用户明确硬边界的局部修订未通过校验（${errMsg(error)}）；原稿保留，等待你决定`
      await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify({ ...evidenceBase, stage: 'paused', candidateHash, issues, errorCode: 'editor_invalid', message }))
      await patchRun(input.runId, { status: 'waiting_user', phase: 'paused', errorCode: 'writing_editor_invalid', errorMessage: message })
      emit(input.runId, { type: 'phase', phase: 'paused', title: '硬边界修订已暂停', detail: message })
      return { status: 'paused' }
    }
    const revised = applied.content
    const revisedHash = writingTextHash(revised)
    const postEditAdvisories: WritingCriticIssue[] = []
    const finalCheck = evaluateStrongConstraints(input.snapshot, `${input.acceptedPrefix}${revised}`, revised, {
      writingForm: input.policy.writingForm,
      atTarget: input.targetChars > 0 && codePointLength(input.acceptedPrefix) + codePointLength(revised) >= input.targetChars,
      requireThemeInSegment: codePointLength(input.acceptedPrefix) === 0,
      checkSegmentPerspective: input.snapshot.perspective !== 'auto',
      qualityReview: true
    })
    const finalIssues = filterIssuesForPolicy(issuesFromDeterministic(revised, finalCheck.violations), input.policy)
    if (finalIssues.length > 0) {
      const hard = finalIssues.some((item) => item.severity === 'hard')
      if (!hard) {
        if (issue.severity !== 'hard') return acceptOriginalWithAdvisory('局部修订后仍有软性建议，未经接受的修订稿已丢弃', finalIssues)
        postEditAdvisories.push(...finalIssues)
      }
      if (hard) {
        const categories = [...new Set(finalIssues.map((v) => v.code))]
        const message = `局部修订后仍未满足用户明确硬边界（${categories.join('、')}）；未经接受的修订稿已丢弃，原稿保留`
        await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify({ ...evidenceBase, stage: 'paused', candidateHash, rejectedRevisionHash: revisedHash, issues: finalIssues, message }))
        await patchRun(input.runId, { status: 'waiting_user', phase: 'paused', errorCode: 'writing_review_not_resolved', errorMessage: message })
        emit(input.runId, { type: 'phase', phase: 'paused', title: '硬边界仍未满足', detail: message })
        return { status: 'paused' }
      }
    }
    let verificationCritic: AuxCallResult
    let verificationSectionCoverage: unknown
    try {
      verificationCritic = await collectAuxCall(
        input.runId,
        'critic',
        withSceneContract(buildCriticMessages({ policy: input.policy, snapshot: input.snapshot, candidate: revised, candidateHash: revisedHash, sceneBeatReview, sectionReview: input.sectionReview })),
        input.turnSeq,
        100002 + input.round * 10
      )
      const verificationReport = parseCriticReport(criticJsonPayload(verificationCritic.text), revised, revisedHash, input.policy.maxIssues)
      verificationSectionCoverage = verificationReport.sectionCoverage
      if (input.sceneContract) await persistSceneCriticEvidence({ runId: input.runId, contract: input.sceneContract, candidate: revised, scenePrefix, raw: verificationReport.sceneBeatEvidence, criticHash: writingTextHash(verificationCritic.text) })
      const verificationIssues = filterIssuesForPolicy(mergeCriticIssues(detectZombieStyleIssues(revised, input.policy.expressionFreedom), verificationReport.issues, input.policy.maxIssues), input.policy)
      if (verificationIssues.length > 0) {
        const hard = verificationIssues.some((item) => item.severity === 'hard')
        if (!hard) {
          if (issue.severity !== 'hard') return acceptOriginalWithAdvisory('复核仍有软性建议，未经接受的修订稿已丢弃', verificationIssues)
          postEditAdvisories.push(...verificationIssues)
        } else {
          const message = `复核仍发现用户明确硬边界问题；未经接受的修订稿已丢弃，原稿保留`
          await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify({ ...evidenceBase, stage: 'paused', candidateHash, rejectedRevisionHash: revisedHash, issues: verificationIssues, message }))
          await patchRun(input.runId, { status: 'waiting_user', phase: 'paused', errorCode: 'writing_review_not_resolved', errorMessage: message })
          emit(input.runId, { type: 'phase', phase: 'paused', title: '硬边界仍未满足', detail: message })
          return { status: 'paused' }
        }
      }
    } catch (error) {
      if (issue.severity !== 'hard') return acceptOriginalWithAdvisory(`复核不可验证，未经接受的修订稿已丢弃：${errMsg(error)}`)
      const message = `用户明确硬边界的修订复核不可验证（${errMsg(error)}）；未经接受的修订稿已丢弃，原稿保留`
      await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify({ ...evidenceBase, stage: 'paused', candidateHash, rejectedRevisionHash: revisedHash, errorCode: 'critic_recheck_invalid', message }))
      await patchRun(input.runId, { status: 'waiting_user', phase: 'paused', errorCode: 'writing_critic_recheck_invalid', errorMessage: message })
      emit(input.runId, { type: 'phase', phase: 'paused', title: '硬边界复核已暂停', detail: message })
      return { status: 'paused' }
    }
    let localizedRevision: Wp7LocalizedRevisionDecision | undefined
    const localizedFlags = narrativeRuntime.parseWp7FeatureFlags(getConfig(input.runId).wp7FeatureFlags)
    if (localizedFlags.localizedRevision) {
      const candidateSegmentId = input.candidateSegmentId ?? `${input.runId}:${input.turnId}`
      const candidateRevision = input.candidateRevision ?? 1
      const decision = await deriveWp7LocalizedRevision({
        runId: input.runId,
        config: getConfig(input.runId),
        sceneContract: input.sceneContract,
        candidateSegmentId,
        candidateRevision,
        candidate: input.candidate,
        revised,
        patch: proposedPatch
      })
      if (decision.status === 'fallback') {
        await persistWp7LocalizedRevisionEvidence({ runId: input.runId, candidateSegmentId, candidateRevision, contractHash: input.sceneContract?.frozenHash ?? '', candidateHash, decision }).catch(() => undefined)
        return acceptOriginalWithAdvisory(`WP7 局部修订回退：${decision.reason}`)
      }
      try {
        await persistWp7LocalizedRevisionEvidence({ runId: input.runId, candidateSegmentId, candidateRevision, contractHash: input.sceneContract?.frozenHash ?? '', candidateHash, decision })
      } catch {
        const fallback = { status: 'fallback' as const, reason: 'localized_revision_evidence_conflict', beforeHash: candidateHash, epoch: decision.epoch, flagsHash: decision.flagsHash }
        await persistWp7LocalizedRevisionEvidence({ runId: input.runId, candidateSegmentId, candidateRevision, contractHash: input.sceneContract?.frozenHash ?? '', candidateHash, decision: fallback }).catch(() => undefined)
        return acceptOriginalWithAdvisory(`WP7 局部修订回退：${fallback.reason}`)
      }
      localizedRevision = decision
    }
    const providerOrigin = (() => { try { return new URL(String(getConfig(input.runId).baseUrl ?? '')).host || '未知 provider' } catch { return '未知 provider' } })()
    const model = String(getConfig(input.runId).model ?? '未知模型')
    const totalDurationMs = Math.max(0, now() - pipelineStartedAt)
    const detail = `${categoryLabel} · 修订 ${issue.startCp}–${issue.endCp} 字 · 保留率 ${(applied.retentionRate * 100).toFixed(1)}% · ${providerOrigin} · ${model} · ${usageFact('critic', input.round, critic)} · ${usageFact('editor', input.round, editor)} · ${usageFact('复核', input.round, verificationCritic)} · 审校总计 ${totalDurationMs} ms`
    const acceptedEvidence = {
      ...evidenceBase, replaceRevision: priorReplaceRevision + 1, stage: 'accepted', candidateHash: revisedHash, beforeHash: applied.beforeHash, afterHash: applied.afterHash,
      prefixHash: applied.prefixHash, suffixHash: applied.suffixHash, repairedIssue: issue,
      preservedCodePoints: applied.preservedCodePoints, retentionRate: applied.retentionRate,
      criticDurationMs: critic.durationMs, editorDurationMs: editor.durationMs, verificationDurationMs: verificationCritic.durationMs,
      totalDurationMs,
      criticUsage: critic.usage, editorUsage: editor.usage, verificationUsage: verificationCritic.usage,
      advisories: postEditAdvisories,
      ...(localizedRevision ? { wp7LocalizedRevision: localizedRevision } : {})
    }
    // 只有两道复核都通过，才把 verified patch durable 化并发布 content_replace。
    await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify({
      ...acceptedEvidence, stage: 'edit_prepared', candidateHash: applied.beforeHash, patch: proposedPatch, verified: true
    }))
    await input.onCommit(revised, localizedRevision)
    emit(input.runId, { type: 'content_replace', content: `${input.acceptedPrefix}${revised}`, revision: priorReplaceRevision + 1, contentHash: writingTextHash(`${input.acceptedPrefix}${revised}`) })
    await store.saveRunEvidence(input.runId, 'writing_pipeline_latest', JSON.stringify(acceptedEvidence))
    await store.saveRunEvidence(input.runId, `writing_pipeline_cycle_${String(input.round).padStart(6, '0')}`, JSON.stringify(acceptedEvidence))
    emit(input.runId, { type: 'phase', phase: 'validating', title: '局部修订完成', detail })
    await persistSectionReview(revised, verificationSectionCoverage)
    return { status: 'accepted', content: revised, advisories: postEditAdvisories }
  }

  /**
   * R4.2 A5 补充：工具大输出落 artifact（元数据+内容），返回模型可见摘要。
   * executeTools 与 reExecuteTool（恢复重试）共用，保证摘要一致性。
   */
  const spillToolResult = async (runId: string, tc: { name: string }, raw: string): Promise<string> => {
    if (raw.length <= ARTIFACT_SPILL_CHARS) return raw
    const hash = createHash('sha256').update(raw).digest('hex')
    const memRun = mem.get(runId)?.run
    const sessionId = memRun?.sessionId ?? ((await store.getRun(runId))?.sessionId ?? '')
    await store.saveArtifact({
      artifactId: hash,
      runId,
      sessionId,
      artifactType: 'tool-output',
      displayName: tc.name,
      relativePath: null,
      hash,
      charCount: raw.length,
      status: 'completed',
      createdAt: now(),
      content: raw
    })
    return summarizeToolOutput(raw, tc.name)
  }

  const patchRun = async (runId: string, patch: Partial<RunRecord>): Promise<RunRecord> => {
    const m = mem.get(runId)
    if (!m) throw new Error(`run 不存在: ${runId}`)
    if (patch.status) validateTransition(m.run.status, patch.status)
    const updated: RunRecord = { ...m.run, ...patch, updatedAt: now() }
    await store.updateRun(runId, patch)
    m.run = updated
    onRunUpdate(updated)
    return updated
  }

  /**
   * R4.3 Gate 4（S-03）：完成校验门——模型 finish stop 只是 candidate_complete；
   * 由 CompletionController 按外部契约判定：
   *  - completed → true（允许 finalize completed）；
   *  - validating → requestContinuation（单调性/上限/预算）→ continuing 注入结构化缺口续作；
   *  - blocked   → 'blocked'（无进展/达上限/预算耗尽，finalize failed）。
   * controller 按 run 缓存（跨轮保持 revision 与单调性状态）；评估先落库再对外。
   */
  /** R4.3 补：completion 事件统一构造（subtype + 客观进度；UI 不显示模型自述） */
  const completionEvent = (
    subtype: 'contract_created' | 'validator_result' | 'continuation_required' | 'continuation_paused' | 'completion_blocked' | 'completion_accepted',
    ev: CompletionEvaluation,
    contract: CompletionContract
  ): RunEngineEvent => ({
    type: 'completion',
    subtype,
    state: ev.state,
    remainingWork: ev.remainingWork.map((w) => ({ code: w.code, message: w.message })),
    revision: ev.revision,
    measuredChars: ev.measuredChars ?? undefined,
    targetChars: contract.targetChars?.min,
    validatorPassed: Math.max(0, contract.validators.length - ev.hardFailures.length),
    validatorTotal: contract.validators.length,
    blockedReason: ev.blockedReason,
    pausedMessage: ev.pausedMessage
  })

  /**
   * R4.5 Gate 4：重复率计算——本轮新增文本的 8-gram 中出现在历史正文集合中的比例。
   * 轻量近似（O(n) 集合查重），供 ContinuationPolicy 判断"低效续写"（重复率高 = 有效新内容少）。
   */
  const computeRepetitionRatio = (history: string[], latestDelta: string): number => {
    const latestPoints = Array.from(latestDelta)
    if (!latestDelta || latestPoints.length < 8) return 0
    const histGrams = new Set<string>()
    for (const h of history) {
      const points = Array.from(h)
      for (let i = 0; i + 8 <= points.length; i++) histGrams.add(points.slice(i, i + 8).join(''))
    }
    let repeated = 0
    let total = 0
    for (let i = 0; i + 8 <= latestPoints.length; i++) {
      total++
      if (histGrams.has(latestPoints.slice(i, i + 8).join(''))) repeated++
    }
    return total > 0 ? repeated / total : 0
  }

  const completionControllers = new Map<string, CompletionController>()
  const saveLongWriteCheckpoint = async (runId: string, suppliedTurns?: TurnRecord[]): Promise<void> => {
    const config = getConfig(runId)
    if (!isLongWriteConfig(config)) return
    const contract = config.completionContract as CompletionContract | undefined
    const deepWrite = config.deepWrite as { targetChars?: unknown } | undefined
    const targetChars = typeof deepWrite?.targetChars === 'number'
      ? deepWrite.targetChars
      : contract?.targetChars?.min ?? contract?.targetChars?.max ?? 0
    const plan = longWritePlanFromConfig(config, targetChars)
    const turns = suppliedTurns ?? await store.getTurns(runId)
    const checkpointTurns = await narrativeProjectionTurns(runId, turns, false)
    const checkpoint = buildLongWriteCheckpoint(runId, checkpointTurns, plan, now())
    await store.saveRunEvidence(runId, 'longwrite_checkpoint', JSON.stringify(checkpoint))
  }

  /** A transport interruption is not a failed manuscript. Preserve the
   * accepted chapters and unaccepted partial, then require explicit resume.
   * Existing adapter retry limits and every frozen budget remain unchanged. */
  const pauseInterruptedLongwrite = async (runId: string, error: unknown, startedAt: number, turnId: string): Promise<boolean> => {
    if (!isLongWriteConfig(getConfig(runId))) return false
    const status = (error as { status?: unknown })?.status
    const code = errCode(error)
    if (typeof status === 'number' && status !== 429 && (status < 500 || status >= 600)) return false
    if (['provider_protocol_mismatch', 'content_filter', 'credential_missing'].includes(code)) return false
    const attempts = store.getProviderAttempts ? await store.getProviderAttempts(runId) : []
    const latest = attempts.filter(attempt => attempt.actor === 'writer' && attempt.startedAt >= startedAt).at(-1)
    const interrupted = code === 'incomplete_stream' || (error as Error)?.name === 'TimeoutError' ||
      (typeof status === 'number' && (status === 429 || status >= 500 && status < 600)) ||
      latest?.outcome === 'transport_error' || latest?.outcome === 'timeout'
    if (!interrupted) return false
    await saveLongWriteCheckpoint(runId)
    const accepted = acceptedManuscriptSegments(await getManuscriptSegments(runId))
    const acceptedChars = accepted.reduce((sum, segment) => sum + segment.charCount, 0)
    await store.saveRunEvidence(runId, 'longwrite_provider_interruption', JSON.stringify({
      schemaVersion: 1, runId, turnId, interruptedAt: now(), originalErrorCode: code,
      logicalCallId: latest?.logicalCallId ?? null, outcome: latest?.outcome ?? null,
      acceptedChars, acceptedSegmentIds: accepted.map(segment => segment.segmentId)
    }))
    const message = `正文连接中断，已收稿 ${acceptedChars} 字及当前未提交草稿均已保存；可继续写作，或先导出已收稿部分。继续沿用原模型、密钥和剩余预算，不会重写已收稿章节。`
    await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'longwrite_provider_interrupted', errorMessage: message })
    emit(runId, { type: 'phase', phase: 'paused', title: '连接中断，稿件已保存', detail: message })
    return true
  }
  /**
   * Long-form delivery must reach the requested floor before the manuscript
   * can be published.  The legacy completion contract intentionally allows a
   * small tolerance for ordinary responses, but applying that tolerance to a
   * large manuscript makes a 100k target complete at 99k without another
   * writer turn.  Keep the frozen public snapshot backwards compatible and
   * tighten only the in-engine validator copy for longwrite runs.
   */
  const completionContractForRun = (runId: string, contract: CompletionContract): CompletionContract => {
    if (!isLongWriteConfig(getConfig(runId)) || !contract.targetChars) return contract
    // A sentence may straddle the configured upper edge when a previous
    // provider segment ended mid-sentence.  The persisted/public contract
    // remains the requested 1% window, but the in-engine copy needs a small
    // bounded natural-ending allowance so it can accept the first complete
    // sentence instead of repeatedly appending one code point at a time.
    const naturalCeiling = (getConfig(runId).deliveryContract as { manuscriptFile?: unknown } | undefined)?.manuscriptFile !== true || contract.targetChars.max === undefined
      ? undefined
      : Math.max(contract.targetChars.max, contract.targetChars.min + 1024)
    return {
      ...contract,
      targetChars: { ...contract.targetChars, ...(naturalCeiling === undefined ? {} : { max: naturalCeiling }), tolerance: 0 },
      validators: contract.validators.map((validator) => validator.id === 'targetChars'
        ? { ...validator, config: { ...validator.config, ...(naturalCeiling === undefined ? {} : { max: naturalCeiling }), tolerance: 0 } }
        : validator)
    }
  }
  /** R4.6 Gate 3：按 hash 读回 artifact 内容（磁盘；缺失返回 undefined——fileEvidence 判 file_corrupt） */
  const loadArtifactContents = async (artifacts: ArtifactRecord[]): Promise<Record<string, string>> => {
    const out: Record<string, string> = {}
    for (const a of artifacts) {
      const c = await store.getArtifactContent(a.hash).catch(() => null)
      if (c !== null) out[a.hash] = c
    }
    return out
  }
  const tryCompletionGate = async (runId: string, cc: CompletionContract, options: { resumeWaitingUser?: boolean } = {}): Promise<boolean | 'blocked' | 'paused'> => {
    // The user-facing snapshot still records its compatibility tolerance;
    // evaluation of an active longwrite uses the strict target floor above.
    cc = completionContractForRun(runId, cc)
    const turns = await store.getTurns(runId)
    const segmentRows = await getManuscriptSegments(runId, turns)
    const cachedSegments = mem.get(runId)?.manuscriptCache
    const acceptedSegments = cachedSegments?.segments === segmentRows
      ? cachedSegments.acceptedSegments
      : acceptedManuscriptSegments(segmentRows)
    const measuredChars = acceptedSegments.reduce((sum, segment) => sum + segment.charCount, 0)
    // Repetition is a quality signal for the current addition, not a reason
    // to rescan an unbounded novel on every completion check. Compare against
    // a bounded recent window; this keeps continuation cost linear in the
    // current provider segment as the manuscript grows.
    const latestSegmentForEvidence = acceptedSegments.length > 0 ? acceptedSegments[acceptedSegments.length - 1].content : ''
    const latestDeltaForRepetition = takeCodePoints(latestSegmentForEvidence, 12000)
    const historyTexts = acceptedSegments.slice(Math.max(0, acceptedSegments.length - 9), -1).map((segment) => takeCodePoints(segment.content, 4096))
    const repetitionRatio = computeRepetitionRatio(historyTexts, latestDeltaForRepetition)
    const artifacts = await store.getArtifactsByRun(runId)
    const tcs = await store.getToolCalls(runId)
    const pending = tcs.filter((tc) => tc.status === 'running' || tc.status === 'requested' || tc.status === 'side_effect_unknown')
    // R4.5 Gate 1（B-01 修复）：renpyLint evidence 从 durable run_evidence 读取，且必须与
    // 当前 artifact 集合的 manifest hash 匹配——文件变化（补丁应用/内容修改）后 manifest
    // 不匹配 → evidence 失效（不允许用旧 lint 结果完成）。manifest 公式与 lint 写入侧一致：
    // sha256(sorted(path \u0000 contentHash))。
    const renpyArtifacts = artifacts.filter((a) => a.artifactType === 'renpy')
    let renpyLint: CompletionEvidence['renpyLint']
    if (renpyArtifacts.length > 0) {
      const ev = await store.getRunEvidence(runId, 'renpy_lint')
      const parsed = ev
        ? (JSON.parse(ev.json) as { manifest_hash?: string; ok?: boolean; errorCount?: number; warningCount?: number; output?: string; sdk_version?: string })
        : null
      const currentManifest = computeManifestHash(renpyArtifacts.map((a) => ({ path: a.relativePath ?? a.hash, hash: a.hash })))
      const hashMatch = parsed?.manifest_hash !== undefined && currentManifest === parsed.manifest_hash
      renpyLint = parsed && hashMatch
        ? { ok: parsed.ok ?? false, errorCount: parsed.errorCount ?? 0, warningCount: parsed.warningCount ?? 0, output: parsed.output ?? '', sdkVersion: parsed.sdk_version }
        : undefined
    }
    const strongConstraints = getConfig(runId).strongConstraints as StrongConstraintSnapshot | undefined
    const strongDraft = acceptedSegments.map((segment) => segment.content).join('')
    const strongDraftHash = createHash('sha256').update(strongDraft).digest('hex')
    const strongLatestHash = createHash('sha256').update(latestSegmentForEvidence, 'utf8').digest('hex')
    const strongCheck = strongConstraints?.enabled
      ? evaluateStrongConstraints(strongConstraints, strongDraft, latestSegmentForEvidence, { atTarget: true, writingForm: frozenWritingForm(getConfig(runId)) })
      : null
    const durableStrongRaw = strongConstraints?.enabled ? await store.getRunEvidence(runId, 'strong_constraint_latest') : null
    type DurableStrongEvidence = { constraintHash?: string; draftHash?: string; latestSegmentHash?: string; status?: string }
    let durableStrong: DurableStrongEvidence | null = null
    try { durableStrong = durableStrongRaw ? JSON.parse(durableStrongRaw.json) as DurableStrongEvidence : null } catch { durableStrong = null }
    const durableStrongMatches = durableStrong?.status === 'passed' &&
      durableStrong.constraintHash === strongConstraints?.hash &&
      durableStrong.draftHash === strongDraftHash &&
      durableStrong.latestSegmentHash === strongLatestHash
    const strongEvidence: CompletionEvidence['strongConstraints'] = strongConstraints?.enabled
      ? {
          constraintHash: strongConstraints.hash,
          rulesVersion: strongConstraints.schemaVersion,
          draftHash: strongDraftHash,
          latestSegmentHash: strongLatestHash,
          violations: durableStrongMatches
            ? (strongCheck?.violations ?? []).map((v) => ({ code: v.code, category: v.category, message: v.message, severity: v.severity }))
            : [{ code: 'constraint_evidence_stale', category: '检查证据', message: '强约束检查证据缺失、损坏或不属于当前正文' }],
          repairAttempt: (await store.getCompletionAttempts(runId)).filter((a) => a.attempt < 0).length
        }
      : undefined
    const evidence: CompletionEvidence = {
      measuredChars,
      repetitionRatio,
      artifacts: artifacts.map((a) => ({ kind: a.artifactType, path: a.relativePath ?? '', hash: a.hash })),
      pendingToolCount: pending.length,
      pendingToolNames: pending.map((tc) => tc.name),
      renpyLint,
      // R4.6 Gate 3：产物文件证据——按登记 hash 从磁盘读回内容（fileEvidence 校验存在/损坏/可解析）
      artifactContents: (cc.requiredFiles ?? []).length > 0 ? await loadArtifactContents(artifacts) : undefined,
      strongConstraints: strongEvidence
    }
    // Delivery can be interrupted after the completed evaluation is durable
    // but before the terminal run row. Re-submitting to that terminal controller
    // yields run_not_active. Replay its decision only after checking the current
    // accepted projection against this run's frozen contract with fresh evidence;
    // a completed row is not itself proof that today's candidate still passes.
    const completedRecord = store.getLatestCompletionEvaluation(runId)
    if (completedRecord?.state === 'completed') {
      let completed: CompletionEvaluation | null = null
      try { completed = JSON.parse(completedRecord.json) as CompletionEvaluation } catch { /* fail closed below */ }
      if (!completed || completed.state !== 'completed' || completed.revision !== completedRecord.revision ||
        completed.startedAt !== cc.createdAt || completed.measuredChars !== measuredChars ||
        !Array.isArray(completed.hardFailures) || completed.hardFailures.length > 0 ||
        isLongWriteConfig(getConfig(runId)) && await scenePlanHasPending(runId, getConfig(runId))) return 'blocked'
      const verification = new CompletionController({
        contract: { ...cc, runId },
        // This is a read-only replay check, not a new attempt or a budget reset.
        store: { saveEvaluation: () => undefined, getLatestEvaluation: () => null }
      }).submitCandidate(evidence)
      if (verification.state !== 'completed') return 'blocked'
      emit(runId, completionEvent('completion_accepted', completed, cc))
      return true
    }
    // R4.4 Gate 5（S-03）：真实 token 预算——从 usage ledger 累计（input+output），非 artifact hash×1000；
    // 无内存态（restore 后首轮）从 durable usage_log 恢复（预算不因重启重置）
    const memRun = mem.get(runId)
    const usedTokens = memRun ? memRun.usage.inputTokens + memRun.usage.outputTokens : (await store.getUsageTotalTokens(runId))
    let controller = completionControllers.get(runId)
    if (!controller) {
      // R4.4 Gate 2（B-03）：生产路径用 fromStore 从 durable evaluation 恢复（强杀重启不重置
      // revision/repairAttempts/单调性水位/墙钟起点）；进程内首次启动且无历史评估时等价新实例
      const ctrlOpts: CompletionControllerOpts = {
        // 契约 runId 必须为实际 run（durable evaluation 外键）
        contract: { ...cc, runId },
        store: {
          saveEvaluation: (r, ev) => void store.saveCompletionEvaluation(r, ev.revision, ev.state, JSON.stringify(ev)),
          getLatestEvaluation: (r) => {
            const l = store.getLatestCompletionEvaluation(r)
            return l ? (JSON.parse(l.json) as CompletionEvaluation) : null
          }
        }
      }
      controller = CompletionController.fromStore(ctrlOpts, ctrlOpts.store.getLatestEvaluation(runId))
      completionControllers.set(runId, controller)
    }
    // R4.4 Gate 5：每轮注入真实 usage cost（恢复后也从 ledger 取——不因重启重置）
    controller.setAccumulatedCost(usedTokens)
    // A budget amendment is an explicit user decision.  Re-submitting the
    // already persisted candidate would manufacture a zero-length delta and
    // immediately pause again as no_progress; resume the controller's durable
    // continuation state instead.
    const ev = options.resumeWaitingUser
      ? controller.resumeAfterUserDecision()
      : controller.submitCandidate(evidence)
    if (ev.state === 'completed') {
      emit(runId, completionEvent('completion_accepted', ev, cc))
      return true
    }
    if (ev.state === 'blocked') {
      emit(runId, completionEvent('completion_blocked', ev, cc))
      return 'blocked'
    }
    // validating → ContinuationPolicy 决策（单调性/上限/预算/低进展——R4.5 Gate 4）
    // resumeAfterUserDecision already committed the continuing evaluation;
    // requesting it a second time would see state=continuing and manufacture
    // a not_validating block before the next writer call.
    const cont = options.resumeWaitingUser && ev.state === 'continuing'
      ? ev
      : controller.requestContinuation({ repetitionRatio })
    if (cont.state === 'waiting_user') {
      // pause_user：run 挂起非终态（用户选择增加预算/降低目标/停止；不伪 completed、不笼统 failed）
      emit(runId, completionEvent('continuation_paused', cont, cc))
      return 'paused'
    }
    if (cont.state === 'blocked') {
      emit(runId, completionEvent('completion_blocked', cont, cc))
      return 'blocked'
    }
    // continuing → 结构化缺口注入（最小 delta 续作，不重传全文）
    await store.appendCompletionAttempt(runId, cont.revision, JSON.stringify(cont))
    const workLines = cont.remainingWork.map((w) => `- [${w.code}] ${w.message}`).join('\n')
    const target = cc.targetChars?.min ?? cc.targetChars?.max ?? 0
    const ceiling = cc.targetChars?.max ?? target
    const measuredNow = ev.measuredChars ?? 0
    const remainingChars = target > 0 ? Math.max(0, target - measuredNow) : 0
    const exactLengthInstruction = target > 0 && remainingChars > 0
      ? `\n本轮续写硬约束：当前正文已完成 ${measuredNow} 个 Unicode code point，目标约 ${target} 字，允许的自然收束上限为 ${ceiling} 字。只输出紧接正文的自然续写；必须用完整句子自然收尾，不要输出“字数不足”“还差字数”或任何元话语。`
      : ''
    const config = getConfig(runId)
    const longWriteInstruction = isLongWriteConfig(config)
      ? `\n${buildLongWriteProgressInstruction(longWritePlanFromConfig(config, target), measuredNow)}`
      : ''
    const curTurns = await store.getTurns(runId)
    const nextSeq = curTurns.length ? Math.max(...curTurns.map((t) => t.turnSeq)) + 1 : 1
    await store.appendTurn({
      turnId: randomUUID(),
      runId,
      turnSeq: nextSeq,
      role: 'system',
      content: `[完成校验未通过，继续写作]\n尚缺（仅修补缺口，不要重写已通过部分）：\n${workLines}${exactLengthInstruction}${longWriteInstruction}`,
      createdAt: now()
    })
    const mm = mem.get(runId)
    if (mm) mm.nextTurnSeq = nextSeq + 1
    emit(runId, completionEvent('continuation_required', cont, cc))
    return false
  }

  /** A model's stop/claim is a candidate, never a local file write receipt. */
  const guardFileDelivery = async (runId: string, mode: 'candidate' | 'observe' | 'terminal' | 'final'): Promise<boolean> => {
    const config = getConfig(runId)
    if ((config.deliveryContract as { manuscriptFile?: unknown } | undefined)?.manuscriptFile === true) return true // Existing manuscript publisher owns this gate.
    const turns = await store.getTurns(runId)
    let previous = newFileDeliveryState()
    const saved = await store.getRunEvidence(runId, FILE_DELIVERY_EVIDENCE)
    if (saved) previous = JSON.parse(saved.json) as FileDeliveryState
    const assessed = await assessFileDelivery({ runId, config, turns, tools: await store.getToolCalls(runId), state: previous })
    if (!assessed.state.required) return true
    const state = assessed.state
    const replacing = new Map<string, TurnRecord>()
    if (assessed.ready) {
      for (const turn of turns.filter(turn => turn.planState === 'file_delivery_notice' && turn.content)) {
        const cleared = { ...turn, content: '' }; await store.appendTurn(cleared); replacing.set(turn.turnId, cleared)
      }
    }
    if (!assessed.ready) {
      for (const turn of assessed.claims) {
        if (!state.rejected.some(item => item.turnId === turn.turnId)) state.rejected.push({ turnId: turn.turnId, content: turn.content })
        const corrected = { ...turn, content: '', planState: 'file_delivery_unverified' }
        await store.appendTurn(corrected)
        replacing.set(turn.turnId, corrected)
      }
    }
    const m = mem.get(runId)
    const visible = (): string => turns.map(turn => replacing.get(turn.turnId) ?? turn).filter(turn => turn.role === 'assistant').map(turn => turn.content).join('')
    const replaceVisible = (content: string): void => {
      state.replaceRevision = Math.max(now(), (state.replaceRevision ?? 0) + 1)
      emit(runId, { type: 'content_replace', content, revision: state.replaceRevision, contentHash: writingTextHash(content) })
    }
    if (replacing.size) replaceVisible(visible())
    if (assessed.ready) {
      if (mode !== 'observe' && assessed.files.length > 0) {
        // Bind the visible completion to the actual receipt paths, including
        // after restart. Never revive an earlier rejected model statement.
        const last = turns.findLast(turn => turn.role === 'assistant' && !turn.toolCallsJson && turn.content)
        if (last && last.planState !== 'file_delivery_confirmed') {
          const actual = assessed.files.map(file => `\`${file.path}\``).join('\n')
          const corrected = { ...last, content: `${last.content}\n\n实际文件：\n${actual}`, planState: 'file_delivery_confirmed' }
          await store.appendTurn(corrected); replacing.set(last.turnId, corrected); replaceVisible(visible())
        }
      }
      await store.saveRunEvidence(runId, FILE_DELIVERY_EVIDENCE, JSON.stringify(state))
      return true
    }
    if (mode === 'observe') {
      await store.saveRunEvidence(runId, FILE_DELIVERY_EVIDENCE, JSON.stringify(state))
      return true
    }
    state.noProgress = assessed.progress ? 0 : state.noProgress + 1
    state.proofIds = assessed.proofIds
    const target = assessed.missing.length > 0 ? assessed.missing.join('\n') : '本次承诺交付的本地文件'
    const actualPaths = assessed.files.map(file => file.path).join('\n')
    const reportOnly = assessed.missing.length === 0 && assessed.files.length > 0 && assessed.missingClaims.length > 0
    const blocked = mode !== 'candidate' || assessed.refused || assessed.readOnly || state.noProgress >= 2
    await store.saveRunEvidence(runId, FILE_DELIVERY_EVIDENCE, JSON.stringify(state))
    const nextSeq = Math.max(0, ...turns.map(turn => turn.turnSeq)) + 1
    if (blocked) {
      if (mode === 'terminal' && turns.some(turn => turn.planState === 'file_delivery_notice')) return false
      const reason = assessed.readOnly ? '当前为只读模式，不能执行写入。' : assessed.refused ? '写入被拒绝或取消，不能报告已完成。' : '连续回复未产生相符的成功写入证据。'
      const message = reportOnly ? `文件已经写入，但完成说明仍指向未验证文件。实际文件：\n${actualPaths}\n请根据实际路径继续，也可以停止。` : `文件尚未交付：\n${target}\n${reason}请确认路径或写入权限后继续，也可以停止。`
      await store.appendTurn({ turnId: randomUUID(), runId, turnSeq: nextSeq, role: 'assistant', content: message, planState: 'file_delivery_notice', createdAt: now() })
      replaceVisible(`${visible()}${message}`)
      await store.saveRunEvidence(runId, FILE_DELIVERY_EVIDENCE, JSON.stringify(state))
      if (m) m.nextTurnSeq = nextSeq + 1
      if (mode !== 'terminal') {
        // This is a complete host notice, not an interrupted assistant stream.
        // A resume starts a fresh model turn instead of appending to the notice.
        await store.appendTurn({ turnId: randomUUID(), runId, turnSeq: nextSeq + 1, role: 'system', content: '[文件交付已暂停，等待用户明确继续；恢复后根据实际工具结果完成交付，不续写暂停通知。]', createdAt: now() })
        if (m) m.nextTurnSeq = nextSeq + 2
        await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'file_delivery_unverified', errorMessage: message })
        emit(runId, { type: 'phase', phase: 'paused', title: '文件尚未交付', detail: message })
      }
      return false
    }
    await store.appendTurn({ turnId: randomUUID(), runId, turnSeq: nextSeq, role: 'system', content: `[文件交付尚未完成]\n用户目标：\n${target}\n当前确认的实际文件：\n${actualPaths || '无'}\n未证实的完成声明路径：\n${assessed.missingClaims.join('\n') || '无'}\n上轮未验证的完成声明已撤回，不是写入证据。${reportOnly ? '用户目标已经写成，只纠正完成说明，报告真实路径；禁止为补齐错误声明另写文件。' : '使用实际写入/文档生成工具完成用户目标，再根据工具返回的实际路径作答。'}不要重复虚构已保存；权限不足则如实说明并等待用户决定。`, createdAt: now() })
    if (m) m.nextTurnSeq = nextSeq + 1
    return false
  }

  const finalize = async (
    runId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'recovery_required',
    extra: Partial<RunRecord> = {}
  ): Promise<void> => {
    completionControllers.delete(runId)
    storyLedgerFences.delete(runId)
    const m = mem.get(runId)
    if (!m || m.done) return
    if (status !== 'completed') await guardFileDelivery(runId, 'terminal')
    m.done = true
    const run = await patchRun(runId, { status, phase: status, ...extra })
    emit(runId, { type: 'terminal', run })
  }

  /**
   * Long-form delivery is a second, external completion gate. A run is not
   * completed until the canonical assistant draft is durably written to the
   * user's document directory and registered as a manuscript artifact.
   */
  const finalizeCompleted = async (runId: string): Promise<void> => {
    const config = getConfig(runId)
    if (!await guardFileDelivery(runId, 'final')) return
    const delivery = config.deliveryContract as { manuscriptFile?: unknown } | undefined
    if (delivery?.manuscriptFile === true) {
      try {
        const contract = config.completionContract as CompletionContract | undefined
        if (contract && await tryCompletionGate(runId, contract) !== true) throw new Error('完成校验证据与当前冻结契约或正式正文不一致')
        const existing = (await store.getArtifactsByRun(runId)).find((item) => item.artifactType === 'manuscript' && item.status === 'completed')
        const canonical = await acceptedTextForRun(runId)
        const rendered = isEditorialWriting(config) ? editorialManuscriptMarkdown(config, acceptedManuscriptSegments(await getManuscriptSegments(runId))) : canonical
        // Already-published drafts retain their original bytes during crash
        // recovery. Formatting never rewrites an existing manuscript file.
        const content = existing?.hash === writingTextHash(canonical) && existing.charCount === codePointLength(canonical) ? canonical : rendered
        if (!content.trim()) throw new Error('没有可交付的正文')
        const hash = createHash('sha256').update(content).digest('hex')
        const charCount = codePointLength(content)
        if (existing) {
          // A prior crash may have persisted the artifact row just before the
          // terminal run update. Re-running delivery is idempotent only when
          // that row still describes the current accepted projection.
          if (existing.hash !== hash || existing.charCount !== charCount) throw new Error('长文稿件 artifact 与 accepted manuscript 不一致')
          const stored = await store.getArtifactContent(existing.hash).catch(() => null)
          if (stored !== null && (stored !== content || createHash('sha256').update(stored).digest('hex') !== hash)) throw new Error('长文稿件 artifact 内容校验失败')
          // The hash object cache may survive a deleted/modified document.
          // Only the existing idempotent publisher verifies the delivery path
          // (and recreates a missing file without overwriting a user edit).
          if (!opts.publishLongwriteArtifact) throw new Error('长文稿件发布器未配置')
          const run = mem.get(runId)?.run ?? await store.getRun(runId)
          if (!run) throw new Error('运行记录不存在')
          const published = await opts.publishLongwriteArtifact({ runId, sessionId: run.sessionId, content, contentHash: hash, config })
          if (published.relativePath !== existing.relativePath || published.displayName !== existing.displayName) throw new Error('长文稿件发布路径与已登记 artifact 不一致')
        } else {
          if (!opts.publishLongwriteArtifact) throw new Error('长文稿件发布器未配置')
          const run = mem.get(runId)?.run ?? await store.getRun(runId)
          if (!run) throw new Error('运行记录不存在')
          emit(runId, { type: 'phase', phase: 'validating', title: '正在生成稿件文件', detail: '写入文档目录并校验内容' })
          const published = await opts.publishLongwriteArtifact({ runId, sessionId: run.sessionId, content, contentHash: hash, config })
          const artifact: ArtifactRecord = {
            artifactId: `${runId}:manuscript`,
            runId,
            sessionId: run.sessionId,
            artifactType: 'manuscript',
            displayName: published.displayName,
            relativePath: published.relativePath,
            hash,
            charCount,
            status: 'completed',
            createdAt: now(),
            content
          }
          await store.saveArtifact(artifact)
          emit(runId, { type: 'artifact', artifact, targetChars: (config.completionContract as CompletionContract | undefined)?.targetChars?.min })
        }
        if (content !== canonical) emit(runId, { type: 'content_replace', content, revision: now(), contentHash: hash })
      } catch (error) {
        if (!recoverableManuscriptDeliveryError(error)) {
          await finalize(runId, 'failed', { errorCode: 'longwrite_delivery_failed', errorMessage: `正文已保留，但稿件文件生成失败：${errMsg(error)}` })
          return
        }
        const message = `正文已收稿，但稿件文件生成失败：${errMsg(error)}。修复目录或同名文件冲突后继续即可重试交付，不会重新生成正文；也可先导出已收稿部分。`
        await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'longwrite_delivery_failed', errorMessage: message })
        emit(runId, { type: 'phase', phase: 'paused', title: '正文已保存，等待完成文件交付', detail: message })
        return
      }
    }
    await finalize(runId, 'completed')
  }

  /**
   * An explicit semantic-review decision may commit the last scene while the
   * run remains resumable in memory.  Re-entering `doCycle` must first run the
   * completion gate against that durable accepted projection; otherwise a
   * stale resume would spend one more Provider call after all scenes are
   * already committed.
   */
  const finishIfScenePlanComplete = async (runId: string, config: RunConfig): Promise<boolean> => {
    if (!isLongWriteConfig(config) || !sceneContractPlanValid(config.sceneContracts)) return false
    if (await scenePlanHasPending(runId, config)) return false
    const cc = (config.completionContract as CompletionContract | undefined) ?? null
    if (!cc) {
      await finalizeCompleted(runId)
      return true
    }
    const gate = await tryCompletionGate(runId, cc)
    if (gate === true) {
      await finalizeCompleted(runId)
      return true
    }
    if (gate === 'blocked') {
      await finalize(runId, 'failed', { errorCode: 'completion_blocked', errorMessage: '完成校验阻塞（无进展/达上限/预算耗尽），请人工介入' })
      return true
    }
    if (gate === 'paused') {
      const latest = store.getLatestCompletionEvaluation(runId)
      let pauseMessage = '完成校验已暂停，请调整预算或目标后重新发起，或停止此任务'
      let pauseReason = 'paused'
      try {
        const parsed = latest ? JSON.parse(latest.json) as CompletionEvaluation : null
        if (parsed?.pausedMessage) pauseMessage = parsed.pausedMessage
        if (parsed?.blockedReason) pauseReason = parsed.blockedReason
      } catch {
        // A malformed evaluation is not a reason to call the Provider. Keep
        // the conservative generic user boundary.
      }
      await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: `completion_${pauseReason}`, errorMessage: pauseMessage })
      emit(runId, { type: 'phase', phase: 'paused', title: '等待你的决定', detail: pauseMessage })
      return true
    }
    // The gate appended a bounded continuation request. The existing cycle
    // may proceed to Provider only when more global completion work remains.
    return false
  }

  /**
   * R4.1 S-04：取消终态决策（协作路径与 5s 兜底共用）。
   * - 存在 status='running' 的 toolCall（工具已在副作用中、结果未确认）→ 该工具标 side_effect_unknown，
   *   run 进入 recovery_required（不谎称安全取消，需人工恢复）；
   * - requested（未开始执行/结果未知）同样如实标 side_effect_unknown（引擎无法确认其是否产生副作用）；
   * - 无未确认工具 → cancelled。
   */
  const finalizeCancel = async (runId: string): Promise<void> => {
    const m = mem.get(runId)
    if (!m || m.done) return
    const tcs = await store.getToolCalls(runId)
    const unconfirmed = tcs.filter((tc) => tc.status === 'running' || tc.status === 'requested')
    for (const tc of unconfirmed) {
      const marked: ToolCallRecord = { ...tc, status: 'side_effect_unknown', completedAt: now() }
      await store.upsertToolCall(marked)
    }
    if (unconfirmed.some((tc) => tc.status === 'running')) {
      const names = [...new Set(unconfirmed.filter((tc) => tc.status === 'running').map((tc) => tc.name))].join(', ')
      await finalize(runId, 'recovery_required', {
        errorCode: 'cancel_side_effect',
        errorMessage: `取消时工具（${names}）副作用未确认，需人工恢复`
      })
    } else {
      await finalize(runId, 'cancelled')
    }
  }

  const executeBudgetedTool = async (name: string, argsJson: string, toolCallId: string, runId: string, readBudgetChars?: number, nonInteractiveLocalRead?: boolean): Promise<string> => {
    const requests = new Set<string>()
    const hooks: ToolExecutionHooks = { readBudgetChars, nonInteractiveLocalRead, beforeProviderRequest: async (requestId, quote) => {
      if (nonInteractiveLocalRead) throw new Error('parallel_local_read_transport_denied')
      if (requests.has(requestId)) return
      if (!requestId || requestId.length > 240 || mem.get(runId)?.controller.signal.aborted) throw new Error('paid_tool_request_invalid_or_cancelled')
      await withRunBudgetLock(runId, async () => {
        if (requests.has(requestId)) return
        // Stage the cost and call reservations together: a denial must not
        // record a spent call or send transport. No token usage is invented
        // for a fixed-price service operation.
        const state = structuredClone(await reconcileRunBudgetUnlocked(runId))
        reserveProviderCostBudget(state, requestId, 1, quote, now())
        reserveProviderAttemptBudget(state, 'writer', 1, false, now())
        try { await persistRunBudget(state) } catch (error) { throw new RunBudgetExceededError('run_budget_persistence', `联网调用预算无法持久化，未发送请求：${errMsg(error)}`) }
        runBudgets.set(runId, state)
        requests.add(requestId)
      })
    } }
    try { return await toolExecutor(name, argsJson, toolCallId, runId, hooks) }
    finally { for (const requestId of requests) await settleCostReservations(runId, requestId) }
  }

  const executeTools = async (
    runId: string,
    pending: PendingTool[],
    assistantTurnId: string,
    readBudgetChars?: number
  ): Promise<void> => {
    const m = mem.get(runId)
    if (!m || m.done) return
    const perToolReadBudget = readBudgetChars === undefined ? undefined : Math.max(0, Math.floor(readBudgetChars / Math.max(1, pending.length)))
    if (perToolReadBudget !== undefined) await store.saveRunEvidence(runId, `tool_read_budget:${assistantTurnId}`,
      JSON.stringify({ schemaVersion: 1, turnId: assistantTurnId, readBudgetChars: perToolReadBudget }))
    const batchBudgetFailure: { current: RunBudgetExceededError | null } = { current: null }
    const stopped = async (): Promise<boolean> => {
      if (m.done) return true
      if (!m.controller.signal.aborted) return false
      if (!m.pauseRequested) await finalizeCancel(runId)
      return true
    }
    const prepare = async (t: PendingTool): Promise<ToolCallRecord> => {
      const hash = hashArgs(t.name, t.arguments)
      // Gate 2：禁用 name+args 幂等复用（读取类工具修改后复用旧结果会造成错误语义）；
      // argsHash 仍记录用于审计，但每次工具调用都真实执行并绑定本次 toolCallId
      const toolCallId = t.id
      const requested: ToolCallRecord = {
        toolCallId,
        turnId: assistantTurnId,
        runId,
        name: t.name,
        argsJson: t.arguments,
        status: 'requested',
        argsHash: hash,
        startedAt: now()
      }
      await store.upsertToolCall(requested)
      emit(runId, { type: 'tool', toolCall: requested })
      // R4.1 S-04：工具真正开始执行前提交 durable intent（requested 已落库），
      // 开始执行时更新为 running——running 即"副作用可能已发生、结果未确认"（取消兜底依据）
      await store.upsertToolCall({ ...requested, status: 'running' })
      await patchRun(runId, { phase: 'executing_tool' })
      emit(runId, { type: 'phase', phase: 'executing_tool', title: `执行工具: ${t.name}` })
      return requested
    }
    const execute = async (requested: ToolCallRecord, nonInteractiveLocalRead: boolean): Promise<{ completed: ToolCallRecord; result: string; budgetFailure: RunBudgetExceededError | null } | null> => {
      const t = { name: requested.name, arguments: requested.argsJson }
      let status: 'completed' | 'failed' | 'cancelled' = 'completed'
      let resultJson = ''
      let result = ''
      let toolBudgetFailure: RunBudgetExceededError | null = null
      try {
        if (batchBudgetFailure.current) throw batchBudgetFailure.current
        const planTools = planToolAllowList(getConfig(runId))
        if (planTools && !planTools.includes(t.name)) throw new Error('plan_read_only：只读审阅拒绝写盘、命令和扩展工具；请先批准保存的方案，再按正常权限执行')
        m.controller.signal.throwIfAborted()
        const raw = await executeBudgetedTool(t.name, t.arguments, requested.toolCallId, runId, perToolReadBudget, nonInteractiveLocalRead)
        if (nonInteractiveLocalRead) m.controller.signal.throwIfAborted()
        // R4.2 A5 补充（任务书 A5.7）：工具大输出先落 artifact，只向模型发送摘要与必要片段
        const output = await prepareToolTurnOutput(t.name, raw, text => spillToolResult(runId, t, text))
        result = output.content
        resultJson = output.resultJson
      } catch (e) {
        if (e instanceof RunBudgetExceededError) toolBudgetFailure = e
        if (m.controller.signal.aborted) {
          if (m.pauseRequested) return null
          // 协作取消：工具响应了 abort（promise 已 settle）→ 视为已取消而非 failed；
          // 未响应 abort 的工具由 5s 兜底按 recovery_required 处理
          status = 'cancelled'
          result = '已取消'
          resultJson = JSON.stringify({ error: result })
        } else {
          status = 'failed'
          result = errMsg(e)
          resultJson = JSON.stringify({ error: result })
        }
      }
      if (m.done) return null // 兜底已提交，禁止迟到结果覆盖 side_effect_unknown
      const completed: ToolCallRecord = { ...requested, status, resultJson, completedAt: now() }
      return { completed, result, budgetFailure: toolBudgetFailure }
    }
    const commit = async (outcome: Awaited<ReturnType<typeof execute>>): Promise<void> => {
      if (!outcome || m.done) return
      const { completed, result, budgetFailure } = outcome
      await store.upsertToolCall(completed)
      emit(runId, { type: 'tool', toolCall: completed })
      const toolTurn: TurnRecord = {
        turnId: randomUUID(),
        runId,
        turnSeq: m.nextTurnSeq++,
        role: 'tool',
        content: result,
        toolResultJson: JSON.stringify({ toolCallId: completed.toolCallId, content: result }),
        createdAt: now()
      }
      await store.appendTurn(toolTurn)
      emit(runId, { type: 'turn', turn: toolTurn })
      if (budgetFailure) {
        // Complete the protocol responses for the already-declared batch,
        // without executing later operations after the budget refusal.
        batchBudgetFailure.current = budgetFailure
      }
    }
    for (let index = 0; index < pending.length;) {
      if (await stopped()) return
      const group = [pending[index]]
      // Preparation stays serial; only proven, distinct local file reads may
      // overlap. An unsafe call divides the batch, never overtaken by reads.
      if (!batchBudgetFailure.current) {
        const firstPath = await independentLocalReadPath(pending[index], getConfig(runId))
        if (firstPath) {
          const paths = new Set([firstPath])
          while (group.length < LOCAL_READ_CONCURRENCY && index + group.length < pending.length) {
            const next = pending[index + group.length]
            const nextPath = await independentLocalReadPath(next, getConfig(runId))
            if (!nextPath || paths.has(nextPath)) break
            paths.add(nextPath)
            group.push(next)
          }
        }
      }
      if (await stopped()) return
      if (group.length > 1) await store.saveRunEvidence(runId, `parallel_local_reads:${assistantTurnId}`,
        JSON.stringify({ schemaVersion: 1, turnId: assistantTurnId }))
      const prepared: ToolCallRecord[] = []
      for (const tool of group) {
        if (await stopped()) return
        prepared.push(await prepare(tool))
      }
      // All intents are durable before any parallel read starts. Drain every
      // worker before a barrier/failure; history is committed in request order.
      const outcomes = await Promise.allSettled(prepared.map(tool => execute(tool, group.length > 1)))
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') throw outcome.reason
        await commit(outcome.value)
      }
      index += group.length
    }
    if (await stopped()) return
    if (batchBudgetFailure.current) await pauseForRunBudget(runId, batchBudgetFailure.current.code, batchBudgetFailure.current.message)
  }

  /** A partial ordered commit can end in a tool turn rather than its assistant.
   * Recover the declared batch, never re-execute it. Absent intent proves that
   * an operation was not dispatched; report that failure after unresolved reads.
   * Only batches written by the new scheduler use this recovery contract. */
  const reconcileParallelReadBatch = async (runId: string, turns: TurnRecord[], nextSeq: number): Promise<number | null> => {
    const batchTurn = [...turns].reverse().find(turn => turn.role !== 'tool')
    if (!batchTurn?.toolCallsJson || batchTurn.role !== 'assistant') return null
    const evidence = await store.getRunEvidence(runId, `parallel_local_reads:${batchTurn.turnId}`)
    if (!evidence) return null
    let calls: PendingTool[]
    try { calls = JSON.parse(batchTurn.toolCallsJson) as PendingTool[] } catch { throw new Error('parallel_read_batch_corrupt') }
    const records = new Map((await store.getToolCalls(runId)).map(tc => [tc.toolCallId, tc]))
    const historyIds = new Set(turns.filter(turn => turn.role === 'tool' && turn.toolResultJson).map(turn => {
      try { return (JSON.parse(turn.toolResultJson!) as { toolCallId: string }).toolCallId } catch { return '' }
    }))
    let unresolved = false
    for (const call of calls) {
      let tc = records.get(call.id)
      if (!tc) {
        tc = { toolCallId: call.id, runId, turnId: batchTurn.turnId, name: call.name, argsJson: call.arguments,
          argsHash: hashArgs(call.name, call.arguments), status: 'failed', startedAt: now(), completedAt: now(),
          resultJson: JSON.stringify({ error: 'tool_not_executed_after_interruption：运行中断，此工具尚未执行；未自动重放' }) }
        await store.upsertToolCall(tc)
      } else if (tc.status === 'running' || tc.status === 'requested') {
        tc = { ...tc, status: 'side_effect_unknown', completedAt: now() }
        await store.upsertToolCall(tc)
      }
      if (tc.status === 'side_effect_unknown') unresolved = true
      if (unresolved || historyIds.has(call.id)) continue
      const content = replayToolTurnOutput(tc)
      const turn: TurnRecord = { turnId: randomUUID(), runId, turnSeq: nextSeq++, role: 'tool', content,
        toolResultJson: JSON.stringify({ toolCallId: call.id, content }), createdAt: now() }
      await store.appendTurn(turn)
      emit(runId, { type: 'turn', turn })
    }
    if (unresolved) await patchRun(runId, { status: 'recovery_required', phase: 'recovery_required',
      errorCode: 'parallel_read_interrupted', errorMessage: '本批读取在结果提交前中断；已保留工具顺序，未自动重放，请选择恢复决策' })
    return nextSeq
  }

  const admitWorkSteering = async (runId: string): Promise<boolean> => {
    const m = mem.get(runId)
    if (!m || m.done || m.controller.signal.aborted || !isWorkSteeringConfig(getConfig(runId)) || !store.consumeWorkSteering) return false
    // A host-authorized resume enters this cycle with a durable paused row.
    // Establish the same ready state the ordinary request path would set,
    // before taking its input snapshot, not one stale model request later.
    if (m.run.status === 'waiting_user' || m.run.status === 'recoverable') await patchRun(runId, { status: 'running', phase: 'thinking' })
    const added = await store.consumeWorkSteering(runId, m.run.sessionId)
    for (const turn of added) {
      m.nextTurnSeq = Math.max(m.nextTurnSeq, turn.turnSeq + 1)
      emit(runId, { type: 'turn', turn })
    }
    return added.length > 0
  }
  const pendingWorkSteering = async (runId: string): Promise<boolean> => {
    const m = mem.get(runId)
    return Boolean(m && !m.done && !m.controller.signal.aborted && isWorkSteeringConfig(getConfig(runId)) &&
      await store.hasPendingWorkSteering?.(runId, m.run.sessionId))
  }

  const doCycle = async (runId: string): Promise<void> => {
    const m = mem.get(runId)
    if (!m) throw new Error(`run 未启动: ${runId}`)
    await assertStoryLedgerEpoch(runId)
    if (m.run.status === 'waiting_user' && (m.run.errorCode === 'narrative_state_pending_review' || m.run.errorCode === 'writing_critic_invalid' || m.run.errorCode === 'writing_critic_retry_exhausted' || m.run.errorCode === 'writing_rejected_no_progress')) {
      // A saved review/protocol boundary takes precedence over progress
      // evidence, including evidence left by an earlier repair attempt.
      return
    }
    const rejectedProgressRow = usesUnboundedRejectedWritingProgress(runId)
      ? await store.getRunEvidence(runId, 'rejected_writing_progress_v1') : null
    if (rejectedProgressRow && !m.controller.signal.aborted && !m.done) {
      let rejectedProgress: { schemaVersion?: number; stalled?: boolean; acceptedPrefixHash?: string } | null = null
      try { rejectedProgress = JSON.parse(rejectedProgressRow.json) } catch { /* Existing recovery paths retain malformed evidence. */ }
      if (rejectedProgress?.schemaVersion === 1 && rejectedProgress.stalled === true &&
          rejectedProgress.acceptedPrefixHash === manuscriptSegmentHash(await acceptedTextForRun(runId)) && !m.controller.signal.aborted && !m.done) {
        await pauseForRunBudget(runId, 'writing_rejected_no_progress', '相同拒绝稿与校验失败证据没有变化，已暂停自动重试。请检查保存的候选与场景要求后调整任务，或停止当前任务。')
        return
      }
    }
    const runConfig = getConfig(runId)
    if (runConfig.sceneContracts !== undefined && runConfig.sceneContracts !== null && !sceneContractPlanValid(runConfig.sceneContracts)) {
      await finalize(runId, 'failed', { errorCode: 'scene_contract_plan_invalid', errorMessage: '已冻结的场景契约计划非法；不会降级为无场景约束的普通长文或发起模型调用。' })
      return
    }
    // null is the new no-count-limit contract; absent legacy fields keep
    // their historical bound rather than silently widening authorization.
    const configuredMaxTurns = runConfig.maxTurns === null ? null : runConfig.maxTurns ?? 12
    const runContract = runConfig.completionContract as CompletionContract | undefined
    // One target-window source feeds planning, clipping, and completion
    // validation.  Using `max` for planning while clipping at `min` was the
    // trigger for the 0-byte scene-defer loop.
    const runTargetWindow = targetWindow(runContract)
    const completionTarget = runTargetWindow?.min ?? 0
    const longWrite = isLongWriteConfig(runConfig)
    const longWritePlan = longWrite ? longWritePlanFromConfig(runConfig, completionTarget) : null
    // 旧/手写 config 也不能把 exact longwrite 压回 4 轮：以目标篇幅推导
    // 保守轮数，且不降低调用方显式更高的安全上限。token/wall-clock/低进展
    // 仍在 CompletionController 内生效，故这不是取消预算闸门。
    const explicitWorkBudget = runConfig.workBudgetPolicy === 'explicit_v1'
    let maxTurns = explicitWorkBudget ? configuredMaxTurns : completionTarget > 0
      ? Math.max(configuredMaxTurns ?? 0, longWritePlan?.maxTurns ?? deriveLongwriteMaxTurns(completionTarget, modelOutputTokensFromConfig(runConfig)))
      : configuredMaxTurns
    if (!explicitWorkBudget && longWrite && maxTurns !== null) maxTurns = Math.min(LONGWRITE_PLAN_MAX_TURNS_CAP, maxTurns)
    if (await finishIfScenePlanComplete(runId, runConfig)) return
    // R42：恢复时先完成已经落盘候选的审校/完成门，绝不能把候选当作
    // partial stream 再向同一 assistant turn 追加。
    const pipelineResume = m.writingPipelineResume
    m.writingPipelineResume = null
    if (pipelineResume) {
      const turns = await store.getTurns(runId)
      const turn = turns.find((t) => t.turnId === pipelineResume.turnId && t.role === 'assistant')
      const recoveredSceneContext = longWrite ? await sceneContractForRun(runId, runConfig, turns) : null
      const recoveredSegments = longWrite ? await getManuscriptSegments(runId, turns) : []
      const recoveredSegment = recoveredSegments
        .filter((segment) => segment.sourceTurnId === pipelineResume.turnId)
        .sort((a, b) => a.revision - b.revision || a.updatedAt - b.updatedAt)
        .at(-1)
      const policy = runConfig.writingPipeline as WritingPipelinePolicyV1 | undefined
      const snapshot = runConfig.strongConstraints as StrongConstraintSnapshot | undefined
      if (!turn || !policy || !snapshot || !writingPipelinePolicyValid(policy)) {
        await patchRun(runId, { status: 'recovery_required', phase: 'recovery_required', errorCode: 'writing_pipeline_recovery_mismatch', errorMessage: '写作审校恢复证据与正文不一致，请人工处理' })
        return
      }
      let recoveredAccepted = pipelineResume.stage === 'accepted'
      let recoveredQuality: { evaluation: NarrativeQualityEvaluation; acceptedPrefix: string } | undefined
      if (pipelineResume.stage === 'accepted') {
        const prefix = await workingTextForRun(runId, turn.turnId)
        if (longWrite && recoveredSegment?.kind === 'prose') {
          recoveredQuality = await evaluateNarrativeSegment(runId, recoveredSegment, recoveredSceneContext?.contract, 'candidate', prefix)
          if (recoveredQuality.evaluation.status === 'blocked') {
            await saveSegment({ ...recoveredSegment, status: 'rejected', acceptedAt: undefined, updatedAt: now() })
            await store.appendTurn({ ...turn, content: '' })
            await store.saveRunEvidence(runId, `narrative_quality_segment:${recoveredSegment.segmentId}:rejected`, JSON.stringify({ ...recoveredQuality.evaluation, stage: 'rejected', segmentId: recoveredSegment.segmentId, segmentHash: recoveredSegment.contentHash, evaluatedAt: now() }))
            await patchRun(runId, { status: 'recovery_required', phase: 'recovery_required', errorCode: 'narrative_quality_recovery_blocked', errorMessage: '恢复时发现候选段存在叙事质量硬冲突，候选已撤回，请继续定向修复' })
            return
          }
          if (recoveredSceneContext) {
            await evaluateSceneSegment(runId, recoveredSceneContext, recoveredSegment, 'candidate', classifyAssistantOutput(recoveredSegment.content).complete)
          }
        }
        // The prepared-edit recovery may keep the legacy source turn
        // immutable while promoting a separate candidate segment. Bind the
        // reconstructed strong evidence to that candidate, not to the stale
        // source projection, so the acceptance transaction cannot be tricked
        // by a hash that describes a different text.
        const recoveredSegmentContent = recoveredSegment?.kind === 'prose' ? recoveredSegment.content : turn.content
        const draft = `${prefix}${recoveredSegmentContent}`
        await store.saveRunEvidence(runId, 'strong_constraint_latest', JSON.stringify({
          schemaVersion: 1, status: 'passed', constraintHash: snapshot.hash, pipelineHash: policy.hash,
          draftHash: writingTextHash(draft), latestSegmentHash: writingTextHash(recoveredSegmentContent), violations: [], repairAttempt: 0
        }))
      }
      if (pipelineResume.stage !== 'accepted') {
        const prefix = await workingTextForRun(runId, turn.turnId)
        const resumedSection = await currentEditorialSection(runConfig, await getManuscriptSegments(runId, turns), kind => store.getRunEvidence(runId, kind))
        if (longWrite && recoveredSegment?.kind === 'prose') {
          recoveredQuality = await evaluateNarrativeSegment(runId, recoveredSegment, recoveredSceneContext?.contract, 'candidate', prefix)
          if (recoveredQuality.evaluation.status === 'blocked') {
            await saveSegment({ ...recoveredSegment, status: 'rejected', acceptedAt: undefined, updatedAt: now() })
            await store.appendTurn({ ...turn, content: '' })
            await store.saveRunEvidence(runId, `narrative_quality_segment:${recoveredSegment.segmentId}:rejected`, JSON.stringify({ ...recoveredQuality.evaluation, stage: 'rejected', segmentId: recoveredSegment.segmentId, segmentHash: recoveredSegment.contentHash, evaluatedAt: now() }))
            await patchRun(runId, { status: 'recovery_required', phase: 'recovery_required', errorCode: 'narrative_quality_recovery_blocked', errorMessage: '恢复时发现候选段存在叙事质量硬冲突，候选已撤回，请继续定向修复' })
            return
          }
        }
        const resumed = await runWritingPipeline({
          runId, round: 1, turnId: turn.turnId, turnSeq: turn.turnSeq, candidate: recoveredSegment?.content ?? turn.content, acceptedPrefix: prefix,
          targetChars: completionTarget, snapshot, policy,
          sceneContract: recoveredSceneContext?.contract,
          sceneChars: recoveredSceneContext?.sceneChars,
          narrativeQuality: recoveredQuality?.evaluation,
          candidateSegmentId: recoveredSegment?.segmentId,
          candidateRevision: recoveredSegment?.revision,
          criticAttempt: pipelineResume.criticAttempt,
          sectionReview: resumedSection && resumedSection.id === recoveredSegment?.sectionId && (resumedSection.acceptedChars + codePointLength(recoveredSegment.content) >= resumedSection.targetChars || codePointLength(prefix) + codePointLength(recoveredSegment.content) >= completionTarget || Boolean(await store.getRunEvidence(runId, `writing_section_overflow:${turn.turnId}`)))
            ? sectionReviewRequest(resumedSection) : undefined,
          atTarget: completionTarget > 0 && codePointLength(prefix) + codePointLength(recoveredSegment?.content ?? turn.content) >= completionTarget,
          onCommit: async (content) => {
            const updatedTurn = { ...turn, content }
            const classified = classifyAssistantOutput(content)
            const segment = makeManuscriptSegment({
              runId,
              sessionId: m.run.sessionId,
              turnId: turn.turnId,
              chunkIndex: turn.turnSeq,
              ...(recoveredSegment?.sectionId || recoveredSceneContext?.contract.sectionId ? { sectionId: recoveredSegment?.sectionId ?? recoveredSceneContext?.contract.sectionId } : {}),
              ...(recoveredSegment?.sceneId || recoveredSceneContext?.contract.sceneId ? { sceneId: recoveredSegment?.sceneId ?? recoveredSceneContext?.contract.sceneId } : {}),
              content: classified.content,
              status: classified.kind === 'prose' ? 'candidate' : 'rejected',
              kind: classified.kind,
              createdAt: turn.createdAt,
              ...(recoveredSegment?.supersedesSegmentId ? { supersedesSegmentId: recoveredSegment.supersedesSegmentId } : {})
            })
            await saveAssistantTurnWithSegment(updatedTurn, segment)
            emit(runId, { type: 'turn', turn: updatedTurn })
          }
        })
        if (resumed.status === 'paused') return
        if (longWrite) {
          const latestSegment = (await getManuscriptSegments(runId)).filter((segment) => segment.sourceTurnId === turn.turnId).sort((a, b) => a.revision - b.revision || a.updatedAt - b.updatedAt).at(-1)
          if (latestSegment?.kind === 'prose') {
            recoveredQuality = await evaluateNarrativeSegment(runId, latestSegment, recoveredSceneContext?.contract, 'candidate', prefix)
            if (recoveredQuality.evaluation.status === 'blocked') {
              await saveSegment({ ...latestSegment, status: 'rejected', acceptedAt: undefined, updatedAt: now() })
              await store.appendTurn({ ...turn, content: '' })
              await store.saveRunEvidence(runId, `narrative_quality_segment:${latestSegment.segmentId}:rejected`, JSON.stringify({ ...recoveredQuality.evaluation, stage: 'rejected', segmentId: latestSegment.segmentId, segmentHash: latestSegment.contentHash, evaluatedAt: now() }))
              await patchRun(runId, { status: 'recovery_required', phase: 'recovery_required', errorCode: 'narrative_quality_recovery_blocked', errorMessage: '恢复后的候选段命中叙事质量硬冲突，候选已撤回，请继续定向修复' })
              return
            }
            if (recoveredSceneContext) {
              await evaluateSceneSegment(runId, recoveredSceneContext, latestSegment, 'candidate', classifyAssistantOutput(latestSegment.content).complete)
            }
          }
        }
        recoveredAccepted = true
        const draft = `${prefix}${resumed.content}`
        await store.saveRunEvidence(runId, 'strong_constraint_latest', JSON.stringify({ schemaVersion: 1, status: 'passed', constraintHash: snapshot.hash, pipelineHash: policy.hash, draftHash: writingTextHash(draft), latestSegmentHash: writingTextHash(resumed.content), violations: resumed.advisories, repairAttempt: 0 }))
      }
      // An already-accepted durable segment is the recovery boundary itself.
      // Re-accepting it would look for a candidate that no longer exists and
      // turn an idempotent completion replay into candidate_missing.
      if (recoveredAccepted && longWrite && !recoveredSegment) {
        await patchRun(runId, { status: 'recovery_required', phase: 'recovery_required', errorCode: 'manuscript_recovery_segment_missing', errorMessage: '写作审校证据存在，但对应正文段缺失，已停止自动恢复' })
        return
      }
      if (recoveredAccepted && longWrite && recoveredSegment?.status !== 'accepted') {
        const acceptedPrefixForQuality = recoveredQuality?.acceptedPrefix
        if (recoveredSceneContext) await acceptSceneCandidate(runId, turn.turnId, recoveredSceneContext)
        else await acceptCurrentCandidate(runId, turn.turnId, null)
        const acceptedSegment = (await getManuscriptSegments(runId)).find((segment) => segment.segmentId === `${runId}:${turn.turnId}` && segment.status === 'accepted')
        if (acceptedSegment && acceptedPrefixForQuality !== undefined) {
          await evaluateNarrativeSegment(runId, acceptedSegment, recoveredSceneContext?.contract, 'accepted', acceptedPrefixForQuality)
        }
        if (recoveredSceneContext) {
          if (acceptedSegment) await evaluateSceneSegment(runId, recoveredSceneContext, acceptedSegment, 'accepted', true)
        }
      }
      if (runContract && !(longWrite && await scenePlanHasPending(runId, runConfig))) {
        const latestEvaluation = store.getLatestCompletionEvaluation(runId)
        if (recoveredAccepted && latestEvaluation?.state === 'completed') {
          // accepted evidence 的 turn/hash 已在 restore 与上方 strong evidence 重建中
          // 绑定当前正文；同一 completed evaluation 可以安全恢复，不再付费调用。
          await finalizeCompleted(runId)
          return
        }
        const budgetExtensions = runConfig.budgetExtensions
        const gate = await tryCompletionGate(runId, runContract, {
          resumeWaitingUser: Array.isArray(budgetExtensions) && budgetExtensions.length > 0
        })
        if (gate === true) { await finalizeCompleted(runId); return }
        if (gate === 'paused' || gate === 'blocked') {
          await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'writing_pipeline_recovery_blocked', errorMessage: '恢复后的正文仍未满足完成条件，请确认后继续' })
          return
        }
      }
    }
    if (m.manuscriptResume) {
      m.manuscriptResume = false
      if (runContract) {
        const gate = await tryCompletionGate(runId, runContract)
        if (gate === true) {
          await finalizeCompleted(runId)
          return
        }
        if (gate === 'paused' || gate === 'blocked') {
          await patchRun(runId, {
            status: 'waiting_user',
            phase: 'paused',
            errorCode: 'manuscript_recovery_blocked',
            errorMessage: '恢复的正式正文仍未满足完成条件，请确认后继续'
          })
          return
        }
      } else {
        await finalizeCompleted(runId)
        return
      }
    }
    // A crash can occur after CompletionController durably records a terminal
    // evaluation but before finalizeCompleted persists the manuscript/terminal
    // run state.  Do not treat that accepted assistant turn as a resumable
    // partial: re-entering the writer would either duplicate the正文 or submit
    // against a completed controller and turn a recoverable run into failed.
    // Re-running finalizeCompleted is idempotent (the publisher and artifact
    // store both reuse the same content hash).
    const latestCompletionRecord = runContract ? store.getLatestCompletionEvaluation(runId) : null
    let latestCompletion: CompletionEvaluation | null = null
    try { latestCompletion = latestCompletionRecord ? JSON.parse(latestCompletionRecord.json) as CompletionEvaluation : null } catch { latestCompletion = null }
    if (latestCompletion?.state === 'completed') {
      await finalizeCompleted(runId)
      return
    }
    // Likewise, if the evaluation was durably paused but the run-row patch was
    // interrupted, preserve the user boundary.  An explicit runs:resume keeps
    // the row in waiting_user while it deliberately re-enters this cycle.
    if (latestCompletion?.state === 'waiting_user' && m.run.status !== 'waiting_user') {
      const message = latestCompletion.pausedMessage ?? '完成校验已暂停，请确认后继续或停止此任务'
      await patchRun(runId, {
        status: 'waiting_user',
        phase: 'paused',
        errorCode: `completion_${latestCompletion.blockedReason ?? 'paused'}`,
        errorMessage: message
      })
      emit(runId, { type: 'phase', phase: 'paused', title: '等待你的决定', detail: message })
      return
    }
    // Explicit Agent round limits count logical writer calls across restart;
    // network retries remain part of maxCalls, not a fresh writer round.
    const priorBudget = explicitWorkBudget ? (await readWriterProgress(runId)).state : null
    let rounds = priorBudget?.writerRounds ?? 0
    while (!m.done) {
      if (m.run.status === 'waiting_user' && m.run.errorCode === 'writing_rejected_no_progress') return
      if (m.controller.signal.aborted) {
        if (m.pauseRequested) return
        await finalizeCancel(runId)
        return
      }
      rounds++
      const roundTurns = await store.getTurns(runId)
      const roundSegments = await getManuscriptSegments(runId, roundTurns)
      const roundAcceptedChars = acceptedManuscriptSegments(roundSegments).reduce((sum, segment) => sum + segment.charCount, 0)
      const roundScenePending = longWrite ? await scenePlanHasPending(runId, getConfig(runId)) : false
      const roundTarget = targetWindow((getConfig(runId).completionContract as CompletionContract | undefined))
      const targetWindowRepairAtStart = longWrite && roundScenePending && roundTarget !== null && roundAcceptedChars >= roundTarget.floor
      // Reading/recovery/completion re-entry is not a writer round. Progress
      // samples come from actual writer outputs, including rejected outputs.
      const roundProgress = await readWriterProgress(runId)
      if (targetWindowRepairAtStart && roundProgress.state.targetWindowRepairAttempts >= MAX_TARGET_WINDOW_REPAIRS) {
        await pauseForRunBudget(runId, 'run_target_window_repair_exhausted', `正文已达到目标窗口，但场景仍有未完成 beat；已完成 ${MAX_TARGET_WINDOW_REPAIRS} 次有界修复，等待你的决定`)
        return
      }
      if (roundProgress.state.zeroProgressRounds >= 2) {
        await pauseForRunBudget(runId, 'run_no_progress', '最近两轮实际写作的 accepted delta 均为 0，已暂停以避免无效调用；请调整场景要求或停止此任务')
        return
      }
      if (maxTurns !== null && rounds > maxTurns) {
        // 目标型写作耗尽轮数时不再伪装成普通 max_turns failed；
        // 交给用户决定增加预算/降低目标/停止，保留 durable partial。
        if (completionTarget > 0 && !explicitWorkBudget) {
          const currentTurns = await store.getTurns(runId)
          const segmentRows = await getManuscriptSegments(runId, currentTurns)
          const cachedSegments = mem.get(runId)?.manuscriptCache
          const assistantLengths = (cachedSegments?.segments === segmentRows ? cachedSegments.acceptedSegments : acceptedManuscriptSegments(segmentRows)).map((segment) => segment.charCount)
          const measured = assistantLengths.reduce((sum, length) => sum + length, 0)
          if (measured < completionTarget) {
            // Provider 能力不能预设成“每轮 1000 字”。短答 provider 可能稳定只给
            // 900 字，且最后一轮会按剩余目标截取；当实际进展仍为正时，按最近
            // 几轮的有效增量动态补足所需轮数，并留两轮安全余量。重复/停滞仍
            // 由 CompletionController 的 repetition/no-progress 门负责暂停，
            // 这里的扩展只解决“安全轮数估计过小”而不是绕过完成校验。
            // Only recent actual writer-round deltas may justify an
            // extension.  Zero accepted delta is evidence of no progress,
            // never something to filter out in favour of old successful
            // segments.
            const observed = roundProgress.recentDeltas.slice(-4)
            const effectiveDelta = observed.length > 0 && observed.every((delta) => delta > 0)
              ? Math.max(1, Math.min(...observed))
              : 0
            const remaining = completionTarget - measured
            const safetyRounds = 2
            const neededRounds = effectiveDelta > 0 ? Math.ceil(remaining / effectiveDelta) + safetyRounds : 0
            const extendedLimit = Math.min(LONGWRITE_PLAN_MAX_TURNS_CAP, Math.max(maxTurns, rounds - 1 + neededRounds))
            if (effectiveDelta > 0 && extendedLimit >= rounds && extendedLimit > maxTurns) {
              const previousLimit = maxTurns
              maxTurns = extendedLimit
              emit(runId, {
                type: 'phase',
                phase: 'writing',
                title: '根据实际进展延长写作轮数',
                detail: `已完成 ${measured}/${completionTarget} 字；最近有效增量约 ${effectiveDelta} 字，安全上限由 ${previousLimit} 轮调整为 ${maxTurns} 轮`
              })
              // Continue into this newly permitted round. It remains subject to
              // the token/wall-clock/repetition gates below.
            } else {
              const message = '已达到本次写作的安全轮数上限（' + maxTurns + ' 轮），当前 ' + measured + '/' + completionTarget + ' 字；请选择增加预算、降低目标或停止'
              await patchRun(runId, {
                status: 'waiting_user',
                phase: 'paused',
                errorCode: 'completion_max_turns',
                errorMessage: message
              })
              emit(runId, { type: 'phase', phase: 'paused', title: '等待你的决定', detail: message })
              return
            }
          }
        }
        if (rounds > maxTurns) {
          await finalize(runId, 'failed', { errorCode: 'max_turns', errorMessage: '达到最大轮数上限' })
          return
        }
      }
      let resume = m.currentAssistant
      m.currentAssistant = null
      // Complete tools and their durable protocol responses before admitting
      // another real user turn. The frozen tool/approval policy is unchanged.
      if (await admitWorkSteering(runId)) resume = null
      if (m.controller.signal.aborted) { if (!m.pauseRequested) await finalizeCancel(runId); return }
      const turns = await store.getTurns(runId)
      const prevTurn = resume ? turns.find((t) => t.turnId === resume.turnId) : undefined
      // Gate 2：恢复时保留 partial 内容（不再从 messages 中剔除并清空重写）。
      // R55 长文只把冻结约束、章节摘要和最近正文尾部送入 provider；完整正文
      // 仍在 durable turns/artifact 中用于完成校验和交付，避免 envelope 随轮次线性膨胀。
      const longwriteV2 = isLongwriteV2Config(runConfig)
      // Working Set is assembled by ContextService from the repository
      // snapshot.  Keep only the current user request in this engine payload;
      // the old chapter-summary/recent-tail projection would otherwise be
      // appended as live messages by the adapter and duplicate narrative
      // context.
      const currentCanonicalUserTurn = longwriteV2
        ? turns
          .filter((turn) => turn.role === 'user')
          .sort((a, b) => a.turnSeq - b.turnSeq || a.createdAt - b.createdAt || a.turnId.localeCompare(b.turnId))
          .at(-1)
        : undefined
      const contextTurns = longwriteV2
        ? currentCanonicalUserTurn ? [currentCanonicalUserTurn] : []
        : longWritePlan ? await narrativeProjectionTurns(runId, turns, true)
        : runConfig.agentOutputContinuation === true ? projectAgentOutputTail(turns, Math.max(0,
          ((runConfig.contextPolicy as { contextWindowTokens?: number } | undefined)?.contextWindowTokens ?? 8192) - modelOutputTokensFromConfig(runConfig))) : turns
      const editorialSection = isEditorialWriting(runConfig)
        ? await currentEditorialSection(runConfig, await getManuscriptSegments(runId, turns), kind => store.getRunEvidence(runId, kind)) : null
      if (editorialSection?.coverage?.status === 'needs_attention' && editorialSection.acceptedChars >= editorialSection.targetChars &&
        codePointLength(await acceptedTextForRun(runId)) >= completionTarget) {
        await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'writing_section_attention',
          errorMessage: `正文已到目标篇幅，本节仍有审校建议：${editorialSection.coverage.reason}。原稿已保留；请决定修订范围或接受现稿，未把覆盖意见当作事实核验。` })
        return
      }
      if (editorialSection && completionTarget > 0 && codePointLength(await acceptedTextForRun(runId)) >= completionTarget) {
        await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'writing_section_budget',
          errorMessage: `正文已到目标篇幅，但已确认的“${editorialSection.title}”尚未完成。原稿已保留，未导出为完成稿；请决定压缩前文或调整修订范围。` })
        return
      }
      // New marked forms have one canonical frozen prefix supplied by the
      // adapter; do not append the old interview/strong prompt again as live.
      const frozenContents = new Set(Array.isArray(runConfig.frozenSystemMessages) ? (runConfig.frozenSystemMessages as DsMessage[]).map(message => message.content) : [])
      const writerContextTurns = frozenWritingForm(runConfig) ? contextTurns.filter(turn => turn.role !== 'system' || !frozenContents.has(turn.content)) : contextTurns
      const contextProjection = longwriteV2
        ? null
        : longWritePlan
          ? buildLongWriteContextMessages(writerContextTurns, longWritePlan, rounds)
          : null
      const messages = contextProjection?.messages ?? buildMessages(contextTurns)
      if (isEditorialWriting(runConfig)) {
        for (const message of messages) if (message.role === 'system' && message.content.startsWith('当前长文编排进度：')) message.content = message.content.replace('大纲、人物和约束', '大纲、材料与作者约定')
      }
      if (longwriteV2 && messages.filter((message) => message.role === 'user').length > 1) {
        throw new Error('scene_working_set_old_user_history_present')
      }
      const sceneContext = longWrite ? await sceneContractForRun(runId, runConfig, turns) : null
      if (editorialSection) messages.push({ role: 'system', content: editorialSectionPrompt(editorialSection) })
      let sceneBeatRepairRequest: SceneBeatRepairRequest | undefined
      if (sceneContext) {
        try {
          const repairRow = await store.getRunEvidence(runId, sceneBeatRepairEvidenceKind(sceneContext.contract.sceneId))
          const repairLedger = readSceneBeatRepairLedger(repairRow?.json, runId, sceneContext.contract)
          if (repairLedger.pending) {
            const pendingRepair = repairLedger.pending
            const repairSegments = await getManuscriptSegments(runId)
            const original = repairSegments.find(item => item.segmentId === pendingRepair.candidateSegmentId)
            const prefix = repairSegments.filter(item => item.kind === 'prose' && item.status === 'accepted' && item.sceneId === sceneContext.contract.sceneId)
              .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt || a.segmentId.localeCompare(b.segmentId))
              .map(item => item.content).join('')
            if (!original || original.status !== 'rejected' || original.revision !== pendingRepair.candidateRevision || original.contentHash !== pendingRepair.candidateHash || manuscriptSegmentHash(prefix) !== pendingRepair.scenePrefixHash) throw new Error('scene_beat_repair_candidate_or_prefix_changed')
            sceneBeatRepairRequest = pendingRepair
            messages.push({ role: 'system', content: buildSceneBeatRepairPrompt(sceneContext.contract, pendingRepair) })
          }
        } catch (error) {
          throw new RunBudgetExceededError('run_budget_persistence', `场景修订证据无法验证，未调用 Provider：${errMsg(error)}`)
        }
        await saveSceneContractFrozenEvidence(runId, sceneContext, rounds, 'writer')
        try {
          await projectSceneContractV2(runId, runConfig, sceneContext)
        } catch {
          // WP7 is an evidence-only projection.  A disabled/failed/conflicting
          // projection must never change the stable v1 writer path.
        }
        if (!longwriteV2) {
          messages.push({ role: 'system', content: buildSceneContractPrompt(sceneContext.contract, sceneContext.sceneChars) })
          // Keep the canonical task intact in storage and in this same user
          // message. Appending a second user would let the adapter re-append
          // the original whole-manuscript request after the scoped one.
          const currentUser = [...messages].reverse().find(message => message.role === 'user')
          if (currentUser) {
            const contract = sceneContext.contract
            const acceptedSceneChars = Math.max(0, Math.floor(sceneContext.sceneChars))
            const remaining = (value: number): number => Math.max(0, value - acceptedSceneChars)
            const finalScene = sceneContext.plan.contracts.every(item => item.order <= contract.order)
            currentUser.content = [
              '【全稿任务背景（原任务保持不变；不是要求本轮写完全篇）】',
              currentUser.content,
              '',
              '【本轮唯一正文执行范围】',
              `全稿目标仍为 ${completionTarget} 个 Unicode code point；本轮只写 ${contract.sceneId} · ${contract.title}（第 ${contract.order} 场）。`,
              `全稿已接受 ${sceneContext.acceptedChars} 个 Unicode code point；本场已接受 ${acceptedSceneChars}。本场累计范围 ${contract.targetChars.min}–${contract.targetChars.max}，理想 ${contract.targetChars.ideal}。`,
              `本轮新增正文范围 ${remaining(contract.targetChars.min)}–${remaining(contract.targetChars.max)} 个 Unicode code point，理想 ${remaining(contract.targetChars.ideal)}；这是本场剩余篇幅，不是全稿剩余篇幅。`,
              '只依赖已确认事实与已接受正文作为既成状态；人物位置、物品数量/归属/位置及持有状态的改变必须先在正文实际发生，不能把后续大纲或未接受候选当作已发生。',
              finalScene ? '这是最后一场，可在本场完成后自然收束全篇。' : '不要写下一场，不要提前写全篇结尾；本场验收后程序会自动继续后续场景，不需用户另发续写指令。',
              sceneBeatRepairRequest ? '按本场定向修订提示只重写未接受候选，保持已接受正文不变。' : '只输出紧接已接受正文的本场自然小说内容，完整句段自然收束；不复写前文，不解释范围，不输出进度或 JSON。'
            ].join('\n')
          }
        }
      }
      // R4.5 Gate 2（B-02）：角色监护实验——每轮主模型调用前跑监护 hook（结构化建议注入；
      // 失败降级不阻断主链；用量计入同一 run usage ledger；监护者绝不产正文——唯一正文作者仍是主模型）
      const dwPolicy = getConfig(runId).deepWrite as { targetChars?: number; experiment?: { enabled?: boolean; characters?: Array<{ id: string; name: string; bible: string; knownFacts: string[]; forbiddenKnowledge: string[] }> } } | undefined
      if (dwPolicy?.experiment?.enabled === true && opts.experimentRun && rounds > 1) {
        const draftSoFar = contextProjection
          ? contextProjection.messages.filter((message) => message.role === 'assistant').map((message) => message.content).join('')
          : turns.filter((t) => t.role === 'assistant').map((t) => t.content).join('')
        if (draftSoFar.length > 0) {
          try {
            const er = await opts.experimentRun({
              runId,
              round: rounds,
              draftSoFar,
              targetChars: typeof dwPolicy.targetChars === 'number' ? dwPolicy.targetChars : 0,
              characters: dwPolicy.experiment.characters ?? [],
              signal: m.controller.signal
            })
            if (er.usage && er.usage.inputTokens + er.usage.outputTokens > 0) {
              m.usage.inputTokens += er.usage.inputTokens
              m.usage.outputTokens += er.usage.outputTokens
              const modelName = typeof (getConfig(runId).model ?? '') === 'string' ? String(getConfig(runId).model ?? '') : ''
              void store
                .appendUsage({
                  runId,
                  callType: 'deepwrite-custodian',
                  model: modelName,
                  inputTokens: er.usage.inputTokens,
                  outputTokens: er.usage.outputTokens,
                  cacheHit: 0,
                  cacheMiss: er.usage.inputTokens,
                  createdAt: now()
                })
                .catch(() => undefined)
            }
            if (er.injectedSystemLines.length > 0) {
              messages.push({ role: 'system', content: er.injectedSystemLines.join('\n') })
            }
            if (er.ok) {
              // 角色检查阶段：emit 阶段事件（UI/activity 展示；run 状态机 phase 不落 validating——
              // 与 completion 事件同模式，避免非法转换）；title 不泄露角色卡私有原文
              // R4.6 Gate 2：degraded 时证据层必须显示"部分降级"（不得显示完全成功）
              emit(runId, { type: 'phase', phase: 'validating', title: er.degraded ? '角色检查部分降级' : '角色检查中' })
            }
          } catch {
            // 失败降级：实验功能绝不破坏主链可用性（不 fail run）
          }
        }
      }
      const turnId = resume ? resume.turnId : randomUUID()
      const turnSeq = resume ? resume.turnSeq : turns.length ? Math.max(...turns.map((t) => t.turnSeq)) + 1 : 1
      m.nextTurnSeq = turnSeq + 1
      const turnCreatedAt = prevTurn?.createdAt ?? now()
      let content = prevTurn?.content ?? ''
      let streamedContent = streamText(content)
      const existingSegments = longWrite ? await getManuscriptSegments(runId, turns) : []
      const existingCurrentSegment = longWrite
        ? [...existingSegments].filter((segment) => segment.sourceTurnId === turnId).sort((a, b) => a.revision - b.revision || a.updatedAt - b.updatedAt).at(-1)
        : undefined
      const closingSourceBoundary = longwriteV2 && !sceneContext
        ? Math.max(-1, ...existingSegments.filter(segment => segment.status === 'accepted' && segment.kind === 'prose' && segment.sceneId).map(segment => segment.chunkIndex))
        : -1
      const continuationBase = longWrite && existingCurrentSegment?.status !== 'candidate'
        ? [...existingSegments]
          .filter((segment) => segment.sourceTurnId !== turnId && segment.kind === 'prose' && segment.status === 'partial' &&
            (segment.sceneId ?? null) === (sceneContext?.contract.sceneId ?? null) && segment.chunkIndex > closingSourceBoundary)
          .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt)
          .at(-1)
        : undefined
      const continuationPrefix = continuationBase?.content ?? ''
      let segmentContent = existingCurrentSegment?.content ?? content
      let streamSegmentDirty = false
      let segmentStatus: ManuscriptSegmentStatus = existingCurrentSegment?.status === 'partial' ? 'partial' : 'partial'
      let segmentKind: ManuscriptSegment['kind'] = 'prose'
      // 长文交付使用 Unicode code point 口径。流阶段只在窄容差窗口的上沿
      // 限流；provider 结束后再选择完整句末，绝不在目标点直接切出半句话。
      const cycleConfig = getConfig(runId)
      const completionContract = cycleConfig.completionContract as CompletionContract | undefined
      const naturalFileDelivery = (cycleConfig.deliveryContract as { manuscriptFile?: unknown } | undefined)?.manuscriptFile === true
      const cycleTargetWindow = targetWindow(completionContract)
      const targetChars = cycleTargetWindow?.min ?? 0
      // Hand-written/legacy low-level configs without the delivery contract retain
      // their historical exact cap; every new production longwrite snapshot opts in.
      // If this turn is completing a carried partial, allow the selector to
      // look a little beyond the public window for the first complete sentence
      // (the completion controller receives the same bounded internal copy).
      const naturalContinuationCeiling = continuationBase && cycleTargetWindow
        ? Math.max(cycleTargetWindow.max, targetChars + 1024)
        : cycleTargetWindow?.max
      const targetCeiling = naturalFileDelivery ? (naturalContinuationCeiling ?? targetChars) : targetChars
      const targetTolerance = naturalFileDelivery ? (cycleTargetWindow?.tolerance ?? 0) : 0
      const targetFloor = cycleTargetWindow?.floor ?? 0
      const baseAssistantChars = longWrite
        ? existingSegments
          .filter((segment) => segment.sourceTurnId !== turnId && segment.kind === 'prose' && segment.status === 'accepted')
          .reduce((sum, segment) => sum + segment.charCount, 0)
        : turns.filter((turn) => turn.role === 'assistant' && turn.turnId !== turnId).reduce((sum, turn) => sum + codePointLength(turn.content), 0)
      const pendingCarryChars = continuationPrefix ? codePointLength(continuationPrefix) : 0
      const partialContinuationMargin = pendingCarryChars > 0 ? Math.max(256, Math.min(1024, pendingCarryChars + 256)) : 0
      const currentTargetLimit = targetChars > 0
        // Stop the ordinary stream at the requested floor.  The natural-ending
        // window is still available when a provider returns a complete segment,
        // while a carried partial receives a bounded margin to close its sentence.
        ? Math.max(0, targetChars - baseAssistantChars - pendingCarryChars + partialContinuationMargin)
        : 0
      const nextChunkIndex = Math.max(turnSeq, ...existingSegments.map(segment => segment.chunkIndex + 1))
      let segmentChunkIndex = continuationBase?.chunkIndex ?? existingCurrentSegment?.chunkIndex ?? nextChunkIndex
      let segmentRevision = continuationBase ? continuationBase.revision + 1 : existingCurrentSegment?.revision ?? 1
      // Link the first durable partial write to the carried ancestor.  The
      // repository supersedes that chain only for partial/accepted writes;
      // candidate writes therefore remain a non-destructive review state.
      let segmentSupersedesSegmentId: string | undefined = continuationBase?.segmentId
      const segmentSectionId = continuationBase?.sectionId ?? existingCurrentSegment?.sectionId ?? sceneContext?.contract.sectionId ?? editorialSection?.id
      const segmentSceneId = continuationBase?.sceneId ?? existingCurrentSegment?.sceneId ?? sceneContext?.contract.sceneId
      let activeCandidateSegmentId = existingCurrentSegment?.segmentId ?? `${runId}:${turnId}`
      let targetCapReached = targetChars > 0 && baseAssistantChars + codePointLength(content) >= targetChars
      let reasoning = prevTurn?.reasoningContent ?? ''
      const toolAcc = new Map<number, { id: string; name: string; arguments: string }>()
      let finishReason: string | null = null
      let cycleReadBudgetChars: number | undefined
      let errorCode: string | undefined
      let errorMessage: string | undefined
      let cycleUsage: { inputTokens: number | null; outputTokens: number | null; cacheHitTokens: number | null; cacheMissTokens: number | null; reasoningTokens: number | null; cost: number | null } | null = null
      let cycleCostKnown = false
      let sawContent = false
      let currentProseComplete = false
      let partialTailContent: string | null = null
      let deferCompletionGate = false
      let narrativeQualityResult: { evaluation: NarrativeQualityEvaluation; acceptedPrefix: string } | undefined
      let editorialBoundaryReached = false

      await patchRun(runId, { status: 'running', phase: 'thinking' })
      emit(runId, { type: 'phase', phase: 'thinking', title: '模型思考中' })

      const upsertTurn = async (extra?: { toolCallsJson?: string; planState?: string }): Promise<TurnRecord> => {
        // Continuation overlap checks operate on whole prose. Do them at a
        // durable checkpoint, not again for every tiny provider fragment.
        if (streamSegmentDirty) {
          segmentContent = continuationPrefix ? mergeContinuationText(continuationPrefix, content) : content
          streamSegmentDirty = false
        }
        const turn: TurnRecord = {
          turnId,
          runId,
          turnSeq,
          role: 'assistant',
          content,
          reasoningContent: reasoning || undefined,
          toolCallsJson: extra?.toolCallsJson,
          ...(extra?.planState ? { planState: extra.planState } : {}),
          createdAt: turnCreatedAt
        }
        if (longWrite) {
          // Do not let a streaming refusal/plan/meta prefix consume a carried
          // partial before the final classifier has seen the whole output.
          // Such provisional non-prose is kept in the turn projection only;
          // the final classified write below records it as rejected without
          // touching the ancestor chain.
          const provisional = content.trim() ? classifyAssistantOutput(content) : null
          const provisionalNonProse = provisional !== null && provisional.kind !== 'prose'
          const segment = makeManuscriptSegment({
            runId,
            sessionId: m.run.sessionId,
            turnId,
            chunkIndex: segmentChunkIndex,
            ...(segmentSectionId ? { sectionId: segmentSectionId } : {}),
            ...(segmentSceneId ? { sceneId: segmentSceneId } : {}),
            content: segmentContent,
            status: segmentStatus,
            kind: segmentKind,
            createdAt: turnCreatedAt,
            revision: segmentRevision,
            ...(segmentSupersedesSegmentId ? { supersedesSegmentId: segmentSupersedesSegmentId } : {})
          })
          if (!provisionalNonProse || finishReason !== null || segmentStatus !== 'partial') await saveAssistantTurnWithSegment(turn, segment)
          else await store.appendTurn(turn)
        } else await store.appendTurn(turn)
        emit(runId, { type: 'turn', turn })
        return turn
      }

      // Checkpoint after 250ms or 4096 new prose code points; first reasoning
      // and first nonblank text are immediate. These are not model tokens.
      let lastPersistAt = 0
      let lastPersistedLen = 0
      const persistTurn = (force = false): Promise<TurnRecord> | undefined => {
        const nowMs = Date.now()
        const grew = streamedContent.codePoints - lastPersistedLen
        if (!force && nowMs - lastPersistAt < 250 && grew < 4096) return
        lastPersistAt = nowMs
        lastPersistedLen = streamedContent.codePoints
        return upsertTurn()
      }

      const checkSceneContractCandidate = async (): Promise<boolean> => {
        if (!longWrite || !sceneContext || segmentKind !== 'prose' || !segmentContent.trim()) return true
        const currentSegmentId = activeCandidateSegmentId
        const persistedCandidate = (await getManuscriptSegments(runId)).find((segment) => segment.segmentId === currentSegmentId)
        const candidateSegment = persistedCandidate ?? makeManuscriptSegment({
          runId,
          sessionId: m.run.sessionId,
          turnId,
          chunkIndex: segmentChunkIndex,
          sectionId: segmentSectionId,
          sceneId: segmentSceneId,
          content: segmentContent,
          status: segmentStatus,
          kind: 'prose',
          createdAt: turnCreatedAt,
          revision: segmentRevision,
          ...(segmentSupersedesSegmentId ? { supersedesSegmentId: segmentSupersedesSegmentId } : {})
        })
        const contractEvaluation = await evaluateSceneSegment(runId, sceneContext, candidateSegment, 'candidate', currentProseComplete)
        let beatRepair: SceneBeatRepairRequest | null = null
        if (candidateSegment.status === 'candidate' && finishReason === 'stop' && !contractEvaluation.violations.some(item => item.code === 'beat_evidence_invalid') && sceneBeatRepairEligible(sceneContext.contract, contractEvaluation, currentProseComplete)) {
          const facts = store.getNarrativeFacts ? await store.getNarrativeFacts(m.run.sessionId, false) : []
          const requiredFactsAvailable = sceneContext.contract.requiredFactIds.every(id => facts.some(fact => fact.status === 'active' && factMatchesRequiredId(fact, id)))
          const scenePrefix = (await getManuscriptSegments(runId))
            .filter(item => item.kind === 'prose' && item.status === 'accepted' && item.sceneId === sceneContext.contract.sceneId)
            .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt || a.segmentId.localeCompare(b.segmentId))
            .map(item => item.content).join('')
          const decision = buildSceneCompletionDecision(sceneContext.contract, candidateSegment.content, { candidateSegmentId: candidateSegment.segmentId, scenePrefix, evaluation: contractEvaluation, at: now() })
          const row = await store.getRunEvidence(runId, sceneBeatRepairEvidenceKind(sceneContext.contract.sceneId))
          const ledger = readSceneBeatRepairLedger(row?.json, runId, sceneContext.contract)
          if (!row || !requiredFactsAvailable || ledger.attempts.length >= ledger.maxAttempts) {
            await persistSceneSemanticPendingReview(runId, sceneContext, candidateSegment, scenePrefix, contractEvaluation, decision)
            throw new NarrativeStatePendingReviewError(!row ? 'scene_beat_repair_frozen_budget_missing' : requiredFactsAvailable ? `scene_beat_repair_exhausted:${ledger.maxAttempts}` : 'scene_beat_repair_required_fact_missing')
          }
          beatRepair = makeSceneBeatRepairRequest(sceneContext.contract, candidateSegment, scenePrefix, contractEvaluation)
          await store.saveRunEvidence(runId, sceneBeatRepairEvidenceKind(sceneContext.contract.sceneId), JSON.stringify(scheduleSceneBeatRepair(ledger, beatRepair)))
        }
        if (candidateSegment.status === 'candidate' && currentProseComplete && finishReason === 'stop' && !beatRepair && contractEvaluation.status !== 'deviated' && contractEvaluation.violations.some(item => item.code === 'missing_required_beat')) {
          // A parsed action with unknown actors is no safer than an opaque
          // beat. It cannot enter the ordinary accepted/defer continuation.
          const scenePrefix = (await getManuscriptSegments(runId)).filter(item => item.kind === 'prose' && item.status === 'accepted' && item.sceneId === sceneContext.contract.sceneId)
            .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt || a.segmentId.localeCompare(b.segmentId)).map(item => item.content).join('')
          const decision = buildSceneCompletionDecision(sceneContext.contract, candidateSegment.content, { candidateSegmentId: candidateSegment.segmentId, scenePrefix, evaluation: contractEvaluation, at: now() })
          await persistSceneSemanticPendingReview(runId, sceneContext, candidateSegment, scenePrefix, contractEvaluation, decision)
          throw new NarrativeStatePendingReviewError('scene_semantic_pending_review:missing_required_beat')
        }
        const criticFlags = narrativeRuntime.parseWp7FeatureFlags(getConfig(runId).wp7FeatureFlags)
        if (currentProseComplete && candidateSegment.status === 'candidate' && !criticFlags.localizedRevision) {
          try {
            await projectDramaticCritic(runId, getConfig(runId), sceneContext, candidateSegment)
          } catch {
            // WP7 critic is advisory evidence only.  Invalid/failed/conflicting
            // reports must not alter the stable candidate/review/commit path.
          }
        }
        // A natural stop with a missing/uncertain/invalid semantic beat is an
        // ambiguity boundary, not a prompt to spend another provider call.
        // Keep the candidate out of accepted正文 and persist the exact prefix
        // evidence before the error reaches the durable pause handler.
        if (!beatRepair && sceneSemanticReviewRequired(contractEvaluation, sceneContext.contract, currentProseComplete)) {
          const scenePrefix = (await getManuscriptSegments(runId))
            .filter((item) => item.kind === 'prose' && item.status === 'accepted' && item.sceneId === sceneContext.contract.sceneId && item.segmentId !== candidateSegment.segmentId)
            .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt || a.segmentId.localeCompare(b.segmentId))
            .map((item) => item.content)
            .join('')
          const completionDecision = buildSceneCompletionDecision(sceneContext.contract, candidateSegment.content, { candidateSegmentId: candidateSegment.segmentId, scenePrefix, evaluation: contractEvaluation, at: now() })
          await persistSceneSemanticPendingReview(runId, sceneContext, candidateSegment, scenePrefix, contractEvaluation, completionDecision)
          const reasons = sceneSemanticReviewReasons(contractEvaluation, sceneContext.contract).join(',')
          throw new NarrativeStatePendingReviewError(`scene_semantic_pending_review:${reasons || 'ambiguous'}`)
        }
        if (contractEvaluation.status !== 'deviated' && !beatRepair) {
          // A partial is still a continuation base, never a scene candidate.
          // Only a complete prose candidate enters the durable scene lifecycle.
          if (currentProseComplete && candidateSegment.status === 'candidate') {
            await markSceneCandidate(sceneContext, candidateSegment, now())
          }
          return true
        }
        // A contract violation is a candidate-only failure. Keep the exact
        // rejected payload for audit, retract it from the assistant projection,
        // and ask for a focused replacement while preserving accepted text and
        // any carried partial.
        const rejectedContent = segmentContent
        segmentStatus = 'rejected'
        segmentKind = 'prose'
        await upsertTurn()
        content = ''
        reasoning = ''
        await upsertTurn()
        await saveSceneContractEvaluation(runId, currentSegmentId, contractEvaluation, {
          stage: 'rejected',
          segmentId: currentSegmentId,
          segmentHash: manuscriptSegmentHash(rejectedContent),
          acceptedCharsBefore: sceneContext.acceptedChars,
          acceptedCharsAfter: sceneContext.acceptedChars
        })
        const canonical = await acceptedTextForRun(runId)
        emit(runId, { type: 'content_replace', content: canonical, revision: rounds, contentHash: createHash('sha256').update(canonical).digest('hex') })
        const latestTurns = await store.getTurns(runId)
        const nextSeq = latestTurns.length ? Math.max(...latestTurns.map((turn) => turn.turnSeq)) + 1 : 1
        await store.appendTurn({
          turnId: randomUUID(),
          runId,
          turnSeq: nextSeq,
          role: 'system',
          content: beatRepair ? `[SceneContract 缺失推进点修订已安排]\n请求 ${beatRepair.requestHash}；原候选 ${beatRepair.candidateHash} 不属于 accepted 正文。下一轮只修订原候选，保留已接受正文。` : buildSceneContractRepairInstruction(sceneContext.contract, contractEvaluation),
          createdAt: now()
        })
        m.nextTurnSeq = nextSeq + 1
        if (longWritePlan) await saveLongWriteCheckpoint(runId)
        emit(runId, { type: 'phase', phase: 'validating', title: beatRepair ? '正在补足场景推进点' : '场景偏航已隔离', detail: '仅撤回当前候选段，已接受正文与残句保持不变' })
        // The frozen scene-beat repair ledger already bounds these rewrites
        // and supplies a resumable semantic review packet when exhausted.
        if (!beatRepair) await observeRejectedWritingCandidate(runId, turnId, 'scene_contract', rejectedContent, contractEvaluation.frozenHash, {
          violations: contractEvaluation.violations.filter(item => item.severity === 'blocking').map(item => ({ code: item.code, evidence: [...item.evidence].sort() })).sort((a, b) => stableNarrativeJson(a).localeCompare(stableNarrativeJson(b))),
          beats: contractEvaluation.beatEvidence?.map(item => ({ beatId: item.beatId, status: item.status, actuality: item.actuality, assertion: item.assertion, negation: item.negation })).sort((a, b) => a.beatId.localeCompare(b.beatId))
        })
        return false
      }

      const checkNarrativeQualityCandidate = async (): Promise<{
        ok: boolean
        result?: { evaluation: NarrativeQualityEvaluation; acceptedPrefix: string }
      }> => {
        if (!longWrite || segmentKind !== 'prose' || !segmentContent.trim()) return { ok: true }
        const currentSegmentId = activeCandidateSegmentId
        const persistedCandidate = (await getManuscriptSegments(runId)).find((segment) => segment.segmentId === currentSegmentId)
        const candidateSegment = makeManuscriptSegment({
          runId,
          sessionId: m.run.sessionId,
          turnId,
          chunkIndex: persistedCandidate?.chunkIndex ?? segmentChunkIndex,
          ...(persistedCandidate?.sectionId ?? segmentSectionId ? { sectionId: persistedCandidate?.sectionId ?? segmentSectionId } : {}),
          ...(persistedCandidate?.sceneId ?? segmentSceneId ? { sceneId: persistedCandidate?.sceneId ?? segmentSceneId } : {}),
          content: segmentContent,
          status: segmentStatus,
          kind: 'prose',
          createdAt: persistedCandidate?.createdAt ?? turnCreatedAt,
          revision: persistedCandidate?.revision ?? segmentRevision,
          ...(persistedCandidate?.supersedesSegmentId ?? segmentSupersedesSegmentId
            ? { supersedesSegmentId: persistedCandidate?.supersedesSegmentId ?? segmentSupersedesSegmentId }
            : {})
        })
        const result = await evaluateNarrativeSegment(runId, candidateSegment, sceneContext?.contract, 'candidate')
        if (result.evaluation.status !== 'blocked') return { ok: true, result }
        // Only deterministic blocking findings withdraw the current candidate.
        // Advisory repetition/meta/role findings remain available to the normal
        // critic/editor pipeline and never contaminate accepted正文.
        segmentStatus = 'rejected'
        segmentKind = 'prose'
        await upsertTurn()
        content = ''
        reasoning = ''
        await upsertTurn()
        await evaluateNarrativeSegment(runId, candidateSegment, sceneContext?.contract, 'rejected', result.acceptedPrefix)
        const canonical = await acceptedTextForRun(runId)
        emit(runId, { type: 'content_replace', content: canonical, revision: rounds, contentHash: createHash('sha256').update(canonical).digest('hex') })
        const latestTurns = await store.getTurns(runId)
        const nextSeq = latestTurns.length ? Math.max(...latestTurns.map((turn) => turn.turnSeq)) + 1 : 1
        await store.appendTurn({
          turnId: randomUUID(),
          runId,
          turnSeq: nextSeq,
          role: 'system',
          content: buildNarrativeQualityRepairInstruction(result.evaluation),
          createdAt: now()
        })
        m.nextTurnSeq = nextSeq + 1
        if (longWritePlan) await saveLongWriteCheckpoint(runId)
        emit(runId, { type: 'phase', phase: 'validating', title: '叙事质量硬冲突已隔离', detail: '仅撤回当前候选段，已接受正文与残句保持不变' })
        await observeRejectedWritingCandidate(runId, turnId, 'narrative_quality', candidateSegment.content, result.evaluation.sceneContractHash,
          result.evaluation.findings.filter(item => item.severity === 'blocking').map(item => ({ code: item.code, evidence: item.evidence, startCp: item.startCp, endCp: item.endCp })))
        return { ok: false }
      }

      let iter: AsyncIterable<ModelEvent>
      const writerStartedAt = now()
      let writerFirstTokenAt: number | null = null
      try {
        iter = await callModel({ runId, phase: 'thinking', turnSeq, round: rounds, messages, targetWindowRepair: targetWindowRepairAtStart, sceneBeatRepair: sceneBeatRepairRequest })
      } catch (e) {
        if (sceneBeatRepairRequest && m.controller.signal.aborted && !m.pauseRequested) {
          await finalizeCancel(runId)
          return
        }
        // R4.5 Gate 5（S-03）：凭据缺失/版本不匹配（CredentialMissingError code）→
        // waiting_user/auth_required（fail-closed，绝不退回当前任意 key；用户重新授权后 resume）
        if (m.pauseRequested && m.controller.signal.aborted) {
          await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'activity_paused', errorMessage: '已安全暂缓；当前网络流已结束，继续时会从已保存草稿发起新的生成请求/续写' })
          emit(runId, { type: 'phase', phase: 'paused', title: '已安全暂缓', detail: '当前网络流已结束，继续时会从已保存草稿发起新的生成请求/续写' })
          return
        }
        if ((e as { code?: string })?.code === 'credential_missing') {
          const msg = e instanceof Error ? e.message : '凭据缺失，请重新授权'
          await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'auth_required', errorMessage: msg })
          emit(runId, { type: 'phase', phase: 'paused', title: '等待授权：凭据已更换或删除' })
          return
        }
        if (e instanceof RunBudgetExceededError || errCode(e).startsWith('run_')) {
          const code = e instanceof RunBudgetExceededError ? e.code : errCode(e)
          await pauseForRunBudget(runId, code, errMsg(e))
          return
        }
        if (await pauseInterruptedLongwrite(runId, e, writerStartedAt, turnId)) return
        await finalize(runId, 'failed', { errorCode: errCode(e), errorMessage: errMsg(e) })
        return
      }

      try {
        for await (const ev of iter) {
          if (m.controller.signal.aborted || m.pauseRequested) break
          if (ev.type === 'text') {
            if (writerFirstTokenAt === null) writerFirstTokenAt = now()
            const delta = ev.delta ?? ''
            const appended = appendStreamText(streamedContent, delta, targetChars > 0 ? currentTargetLimit : undefined)
            streamedContent = appended
            content = streamedContent.text
            if (appended.clipped) targetCapReached = true
            streamSegmentDirty = true
            const firstContent = !sawContent && Boolean(content.trim())
            if (firstContent) {
              sawContent = true
              await patchRun(runId, { phase: 'writing' })
              emit(runId, { type: 'phase', phase: 'writing', title: '生成内容中', detail: targetChars > 0 ? `按目标篇幅持续收束（还差 ${Math.max(0, targetChars - baseAssistantChars - streamedContent.codePoints)} 字）` : undefined })
            }
            const persisted = persistTurn(firstContent)
            if (persisted) await persisted
          } else if (ev.type === 'reasoning') {
            if (writerFirstTokenAt === null) writerFirstTokenAt = now()
            reasoning += ev.delta ?? ''
            const persisted = persistTurn()
            if (persisted) await persisted
          } else if (ev.type === 'tool_call' && ev.tool) {
            const acc = toolAcc.get(ev.tool.index) ?? { id: '', name: '', arguments: '' }
            // ModelEvent.tool is a cumulative provider snapshot. Replacing
            // fields here prevents the previous snapshot from being appended
            // again (the old path produced duplicated JSON arguments).
            toolAcc.set(ev.tool.index, {
              id: ev.tool.id || acc.id,
              name: ev.tool.name ?? acc.name,
              arguments: ev.tool.arguments ?? acc.arguments
            })
          } else if (ev.type === 'usage') {
            const u = ev.usage
            if (u) {
              const cur: { inputTokens: number | null; outputTokens: number | null; cacheHitTokens: number | null; cacheMissTokens: number | null; reasoningTokens: number | null; cost: number | null } = cycleUsage ?? { inputTokens: null, outputTokens: null, cacheHitTokens: null, cacheMissTokens: null, reasoningTokens: null, cost: null }
              cycleUsage = {
                inputTokens: u.inputTokens ?? cur.inputTokens,
                outputTokens: u.outputTokens ?? cur.outputTokens,
                cacheHitTokens: u.cacheHitTokens ?? cur.cacheHitTokens,
                cacheMissTokens: u.cacheMissTokens ?? cur.cacheMissTokens,
                reasoningTokens: u.reasoningTokens ?? cur.reasoningTokens,
                cost: u.cost ?? cur.cost
              }
              if (u.cost !== undefined) cycleCostKnown = true
              // R4.2 A6：每次更新 revision 递增（迟到/重连判定依据）
              m.usageRevision += 1
              // R4.4 Gate 5：usage ledger 落库（每轮写入——预算判定与强杀恢复都从真实 ledger 取）
              const modelName = typeof (getConfig(runId).model ?? '') === 'string' ? String(getConfig(runId).model ?? '') : ''
              if (u.inputTokens !== undefined && u.outputTokens !== undefined) {
                // The next continuation/repair gate must observe this usage
                // before it can reserve another provider call.  Fire-and-
                // forget here made a delayed ledger writer look like zero
                // spend and allowed the following round to cross the gate.
                try {
                  await store.appendUsage({
                    runId,
                    callType: 'kernel-chat',
                    model: modelName,
                    inputTokens: u.inputTokens,
                    outputTokens: u.outputTokens,
                    cacheHit: u.cacheHitTokens ?? 0,
                    cacheMiss: u.cacheMissTokens ?? 0,
                    createdAt: now()
                  })
                } catch (error) {
                  throw new RunBudgetExceededError('run_budget_persistence', `运行用量账本无法持久化，已拒绝继续调用 Provider：${errMsg(error)}`)
                }
              }
              emit(runId, {
                type: 'usage',
                usage: {
                  ...(cycleUsage.inputTokens !== null ? { inputTokens: cycleUsage.inputTokens } : {}),
                  ...(cycleUsage.outputTokens !== null ? { outputTokens: cycleUsage.outputTokens } : {}),
                  ...(cycleUsage.cacheHitTokens !== null ? { cacheHitTokens: cycleUsage.cacheHitTokens } : {}),
                  ...(cycleUsage.cacheMissTokens !== null ? { cacheMissTokens: cycleUsage.cacheMissTokens } : {}),
                  ...(cycleUsage.reasoningTokens !== null ? { reasoningTokens: cycleUsage.reasoningTokens } : {}),
                  ...(cycleCostKnown && cycleUsage.cost !== null ? { cost: cycleUsage.cost } : {}),
                  revision: m.usageRevision,
                  kind: u.kind ?? 'actual',
                  segmentBreakdown: u.segmentBreakdown,
                  cacheablePrefixHash: u.cacheablePrefixHash
                }
              })
            }
          } else if (ev.type === 'finish') {
            finishReason = ev.finishReason ?? finishReason
            if (ev.toolReadBudgetChars !== undefined) cycleReadBudgetChars = Number.isSafeInteger(ev.toolReadBudgetChars) && ev.toolReadBudgetChars >= 0 ? ev.toolReadBudgetChars : 0
            if (ev.errorCode) errorCode = ev.errorCode
            if (ev.errorMessage) errorMessage = ev.errorMessage
          }
        }
      } catch (e) {
        if (m.controller.signal.aborted) {
          // 流中断时也落下已经收到的正文；否则取消/网络错误会让用户看到
          // UI 中的半成品，但 durable session 里凭空消失。
          if (content || reasoning) await upsertTurn()
          if (m.pauseRequested) {
            await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'activity_paused', errorMessage: '已保存未提交草稿；继续时会从已保存草稿发起新的生成请求/续写' })
            emit(runId, { type: 'phase', phase: 'paused', title: '已安全暂缓', detail: '已保存未提交草稿；继续时会从已保存草稿发起新的生成请求/续写' })
          } else {
            await finalizeCancel(runId)
          }
        } else if (e instanceof RunBudgetExceededError || errCode(e).startsWith('run_')) {
          if (content || reasoning) await upsertTurn()
          const code = e instanceof RunBudgetExceededError ? e.code : errCode(e)
          await pauseForRunBudget(runId, code, errMsg(e))
        } else {
          if (content || reasoning) await upsertTurn()
          if (await pauseInterruptedLongwrite(runId, e, writerStartedAt, turnId)) return
          await finalize(runId, 'failed', { errorCode: errCode(e), errorMessage: errMsg(e) })
        }
        return
      }
      if (m.done) return
      if (m.controller.signal.aborted) {
        if (content || reasoning) await upsertTurn()
        if (m.pauseRequested) {
          await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'activity_paused', errorMessage: '已保存未提交草稿；继续时会从已保存草稿发起新的生成请求/续写' })
          emit(runId, { type: 'phase', phase: 'paused', title: '已安全暂缓', detail: '已保存未提交草稿；继续时会从已保存草稿发起新的生成请求/续写' })
        } else {
          await finalizeCancel(runId)
        }
        return
      }
      if (cycleUsage) {
        m.usage.inputTokens += cycleUsage.inputTokens ?? 0
        m.usage.outputTokens += cycleUsage.outputTokens ?? 0
        m.usage.cacheHitTokens += cycleUsage.cacheHitTokens ?? 0
        m.usage.cacheMissTokens += cycleUsage.cacheMissTokens ?? 0
        m.usage.reasoningTokens += cycleUsage.reasoningTokens ?? 0
        m.usage.cost += cycleUsage.cost ?? 0
      }
      const writerDurationMs = Math.max(0, now() - writerStartedAt)
      const providerOrigin = (() => { try { return new URL(String(getConfig(runId).baseUrl ?? '')).host || '未知 provider' } catch { return '未知 provider' } })()
      const writerModel = String(getConfig(runId).model ?? '未知模型')
      const writerToken = (value: number | null | undefined): string => value == null ? '未知' : String(value)
      const writerUsageDetail = cycleUsage
        ? `输入${writerToken(cycleUsage.inputTokens)} 输出${writerToken(cycleUsage.outputTokens)} 缓存命中${writerToken(cycleUsage.cacheHitTokens)} 未命中${writerToken(cycleUsage.cacheMissTokens)} 推理${writerToken(cycleUsage.reasoningTokens)} tokens · ${cycleCostKnown && cycleUsage.cost !== null ? `实际费用 ¥${cycleUsage.cost.toFixed(6)}` : '费用未知'}`
        : '用量未知 · 费用未知'
      emit(runId, {
        type: 'phase', phase: 'validating', title: '正文生成完成',
        detail: `${providerOrigin} · ${writerModel} · writer 第${rounds}轮 ${writerDurationMs} ms · TTFT ${writerFirstTokenAt === null ? '未知' : `${Math.max(0, writerFirstTokenAt - writerStartedAt)} ms`} · ${writerUsageDetail}`
      })
      // A provider retry/reconnect must not turn one call_id into two
      // executions. Prefer the latest snapshot for a duplicate id while
      // retaining index-distinct calls that genuinely differ.
      const pendingById = new Map<string, { id: string; name: string; arguments: string }>()
      for (const tool of toolAcc.values()) {
        if (!tool.id || !tool.name) continue
        pendingById.set(tool.id, tool)
      }
      const pending = [...pendingById.values()]
      const clipped = runConfig.agentOutputContinuation === true && !longWrite && !runConfig.planMode && finishReason === 'length'
      await upsertTurn({
        ...(clipped ? {planState: AGENT_OUTPUT_PART} : {}),
        toolCallsJson: !clipped && pending.length
          ? JSON.stringify(pending.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments })))
          : undefined
      })
      if (longWrite && pending.length === 0 && (finishReason === 'stop' || finishReason === 'length')) {
        const classified = classifyAssistantOutput(content)
        segmentKind = classified.kind
        currentProseComplete = classified.kind === 'prose' && classified.complete
        segmentStatus = classified.kind === 'prose' ? (classified.complete ? 'candidate' : 'partial') : 'rejected'
        if (classified.kind === 'prose') {
          content = classified.content
          segmentContent = continuationPrefix ? mergeContinuationText(continuationPrefix, classified.content) : classified.content
          segmentSupersedesSegmentId = continuationBase?.segmentId
          segmentChunkIndex = continuationBase?.chunkIndex ?? existingCurrentSegment?.chunkIndex ?? nextChunkIndex
          segmentRevision = continuationBase ? continuationBase.revision + 1 : existingCurrentSegment?.revision ?? 1
        } else {
          segmentContent = ''
          segmentSupersedesSegmentId = undefined
          segmentChunkIndex = existingCurrentSegment?.chunkIndex ?? nextChunkIndex
          segmentRevision = existingCurrentSegment?.revision ?? 1
        }
        if (classified.kind === 'prose' && editorialSection) {
          const sections = (runConfig.grillMe as { approvedOutline?: { sections?: Array<{ id: string }> } } | undefined)?.approvedOutline?.sections ?? []
          const hasLaterSection = sections.findIndex(section => section.id === editorialSection.id) < sections.length - 1
          // A whole-manuscript response to the first section cannot consume
          // the budgets for all later author-approved purposes. Retain a
          // natural local boundary before critic/acceptance; the overflow is
          // an unaccepted draft, never silently reused as the next section.
          const remaining = Math.max(0, editorialSection.targetChars - editorialSection.acceptedChars)
          const localIdeal = remaining || Math.min(512, Math.max(128, Math.ceil(editorialSection.targetChars * 0.2)))
          const localCeiling = localIdeal + Math.min(128, Math.max(1, Math.ceil(editorialSection.targetChars * 0.05)))
          if (hasLaterSection && codePointLength(segmentContent) > localCeiling) {
            const selected = selectNaturalEnding(segmentContent, localIdeal, Math.max(1, Math.floor(localIdeal * 0.85)), localCeiling, 1)
            if (selected) {
              const original = segmentContent
              segmentContent = selected.text
              content = continuationPrefix && selected.text.startsWith(continuationPrefix) ? selected.text.slice(continuationPrefix.length) : selected.text
              currentProseComplete = true
              segmentStatus = 'candidate'
              editorialBoundaryReached = true
              await store.saveRunEvidence(runId, `writing_section_overflow:${turnId}`, JSON.stringify({ schemaVersion: 1,
                sectionId: editorialSection.id, outlineHash: editorialSection.outlineHash, sourceCandidateHash: writingTextHash(original),
                retainedCandidateHash: writingTextHash(selected.text), excludedContent: Array.from(original).slice(selected.endCodePoint).join('') }))
              const projected = `${await acceptedTextForRun(runId)}${segmentContent}`
              emit(runId, { type: 'content_replace', content: projected, revision: rounds, contentHash: writingTextHash(projected) })
            }
          }
        }
        await upsertTurn()
        if (classified.kind !== 'prose') {
          const canonical = await acceptedTextForRun(runId)
          emit(runId, { type: 'content_replace', content: canonical, revision: rounds, contentHash: createHash('sha256').update(canonical).digest('hex') })
          const latestTurns = await store.getTurns(runId)
          const nextSeq = latestTurns.length ? Math.max(...latestTurns.map((turn) => turn.turnSeq)) + 1 : 1
          await store.appendTurn({
            turnId: randomUUID(),
            runId,
            turnSeq: nextSeq,
            role: 'system',
            content: `上一轮输出属于${classified.kind === 'refusal' ? '拒绝或说明' : '计划或元话语'}，没有计入正式正文。${isEditorialWriting(runConfig) ? '按作者确认的写法继续当前节，只输出正文' : '直接继续当前故事，只输出小说正文'}，不解释、不汇报字数。`,
            createdAt: now()
          })
          m.nextTurnSeq = nextSeq + 1
          emit(runId, { type: 'phase', phase: 'writing', title: '已隔离非正文输出', detail: '这部分不会计字数，也不会进入最终稿' })
          if (!targetWindowRepairAtStart) await observeAcceptedWriterRound(runId, rounds)
          continue
        }
        const initialNarrativeQuality = await checkNarrativeQualityCandidate()
        if (!initialNarrativeQuality.ok) continue
        narrativeQualityResult = initialNarrativeQuality.result
        const localizedFlags = narrativeRuntime.parseWp7FeatureFlags(getConfig(runId).wp7FeatureFlags)
        if (localizedFlags.localizedRevision && sceneContext && currentProseComplete && segmentStatus === 'candidate') {
          const criticCandidate = (await getManuscriptSegments(runId)).find((segment) => segment.segmentId === activeCandidateSegmentId)
          if (criticCandidate) {
            try {
              await projectDramaticCritic(runId, getConfig(runId), sceneContext, criticCandidate)
            } catch {
              // Localized revision remains fail-closed when advisory critic
              // evidence is unavailable; the stable writer path continues.
            }
          }
        }
      }
      // At the delivery window, persist only a complete sentence. If this
      // segment has no usable sentence end, retract it and let CompletionController
      // request a short closing continuation instead of falsely completing a
      // mid-sentence hard cut.
      if (naturalFileDelivery && targetChars > 0 && pending.length === 0 && segmentKind === 'prose' && (finishReason === 'stop' || finishReason === 'length')) {
        const acceptedPrefixText = await acceptedTextForRun(runId)
        const acceptedPrefixChars = codePointLength(acceptedPrefixText)
        const draft = `${acceptedPrefixText}${segmentContent}`
        if (codePointLength(draft) >= targetFloor) {
          // The completion validator keeps a small natural-ending tolerance
          // for legacy runs, but a new longwrite must still reach the user
          // requested target before delivery.  Prefer a sentence at/above the
          // target; if none exists, keep a safe prefix and let the internal
          // continuation supply the next complete sentence.
          const selected = selectNaturalEnding(draft, targetChars, Math.max(targetFloor, targetChars), targetCeiling, acceptedPrefixChars + 1)
          const selectedContent = selected && selected.endCodePoint > acceptedPrefixChars
            ? Array.from(selected.text).slice(acceptedPrefixChars).join('')
            : null
          if (selectedContent !== null && selectedContent !== segmentContent) {
            const fullSegmentPoints = Array.from(segmentContent)
            const selectedSegmentPoints = Array.from(selectedContent)
            partialTailContent = fullSegmentPoints.length > selectedSegmentPoints.length
              ? fullSegmentPoints.slice(selectedSegmentPoints.length).join('')
              : null
            segmentContent = selectedContent
            currentProseComplete = true
            segmentStatus = 'candidate'
            reasoning = ''
            await upsertTurn()
            emit(runId, { type: 'content_replace', content: `${acceptedPrefixText}${selectedContent}`, revision: rounds, contentHash: createHash('sha256').update(`${acceptedPrefixText}${selectedContent}`).digest('hex') })
          }
          targetCapReached = selected?.withinWindow === true
          // A safe sentence before the requested floor is still useful
          // durable progress, but feeding that small delta to the completion
          // controller would look like low progress/max-repair before the
          // carried tail gets its closing continuation. Continue one writer
          // cycle first; the next cycle can then accept the full sentence.
          deferCompletionGate = selected !== null && selected?.withinWindow !== true
        }
      }
      if (longWritePlan) {
        // Checkpoint after every provider segment, including length/tool
        // continuations, so a crash can resume from durable正文 without
        // replaying already accepted output.
        await saveLongWriteCheckpoint(runId)
      }
      if (finishReason === 'error') {
        await finalize(runId, 'failed', { errorCode: errorCode ?? 'model_error', errorMessage: errorMessage ?? '模型调用失败' })
        return
      }
      if (finishReason === 'tool_calls') {
        if (pending.length === 0) {
          await finalize(runId, 'failed', { errorCode: 'invalid_tool_calls', errorMessage: '模型声明工具调用但未提供完整工具' })
          return
        }
        await guardFileDelivery(runId, 'observe')
        await executeTools(runId, pending, turnId, cycleReadBudgetChars)
        if (m.run.status === 'waiting_user' || m.run.status === 'recovery_required' || m.done) return
        continue
      }
      if (finishReason === null) {
        if (await pauseInterruptedLongwrite(runId, Object.assign(new Error('模型流未返回结束原因'), { code: 'incomplete_stream' }), writerStartedAt, turnId)) return
        await finalize(runId, 'failed', { errorCode: 'incomplete_stream', errorMessage: '模型流未返回结束原因' })
        return
      }
      // Input submitted while this model request streamed gets the next safe
      // request, even when the assistant would otherwise end the work run.
      if (finishReason === 'stop' && await pendingWorkSteering(runId)) { await upsertTurn(); continue }
      if (finishReason === 'stop' && !longWrite && !await guardFileDelivery(runId, 'candidate')) {
        if (m.run.status === 'waiting_user') return
        continue
      }
      const strongConstraints = getConfig(runId).strongConstraints as StrongConstraintSnapshot | undefined
      const writingPipeline = getConfig(runId).writingPipeline as WritingPipelinePolicyV1 | undefined
      if (clipped) {
        // Provider output caps apply per response, not to the entire task.
        // Never dispatch an incomplete tool frame, even if its prefix parses.
        const toolFrame = toolAcc.size > 0
        const reminder = toolFrame ? AGENT_TOOL_REISSUE : AGENT_OUTPUT_CONTINUE
        const previous = turns.at(-1)
        const previousChunk = turns.at(-2)
        const stalled = (toolFrame ? previous?.content === AGENT_TOOL_REISSUE && !content.trim()
          : !content.trim() || (previous?.content === AGENT_OUTPUT_CONTINUE && previousChunk?.content.trim() === content.trim()))
        if (stalled) {
          const message = toolFrame ? '模型重复截断工具参数，本次操作未执行。' : '模型已用完单次输出空间，但没有交付新的内容。'
          await patchRun(runId, { status:'waiting_user',phase:'paused',errorCode:'agent_output_stalled',errorMessage:message })
          emit(runId,{type:'phase',phase:'paused',title:'输出未取得进展',detail:message})
          return
        }
        await store.appendTurn({turnId:randomUUID(),runId,turnSeq:turnSeq+1,role:'system',content:reminder,createdAt:now()})
        m.nextTurnSeq = turnSeq+2
        continue
      }
      // A course correction follows actual progress, rather than a fixed run-wide quota.
      // The marker survives recovery; a real dependency yields to the user immediately.
      if (finishReason === 'stop' && runConfig.runMode === 'agent' && !longWrite && !runConfig.planMode &&
        (runConfig.toolPolicy as { allowList?: string[] } | undefined)?.allowList?.includes(WORK_PLAN_TOOL)) {
        const plan = latestActivePlan(messages)
        if (plan && plan.steps.some(step => step.status !== 'done')) {
          await upsertTurn()
          if (plan.blockedOn || !progressSinceReminder(messages)) {
            const reason = plan.blockedOn ?? '还有未完成的步骤，本次回复没有继续执行。'
            await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: plan.blockedOn ? 'work_plan_blocked' : 'work_plan_open', errorMessage: reason })
            emit(runId, { type: 'phase', phase: 'paused', title: '任务尚未完成', detail: reason })
            return
          }
          await store.appendTurn({ turnId: randomUUID(), runId, turnSeq: turnSeq + 1, role: 'system', content: WORK_PLAN_CONTINUE, createdAt: now() })
          m.nextTurnSeq = turnSeq + 2
          continue
        }
      }
      const needsLengthContinuation = finishReason === 'length' && getConfig(runId).continueOnLength && !targetCapReached && !(targetChars > 0 && baseAssistantChars + codePointLength(content) >= targetChars)
      // R42 新快照：每一个 provider segment（包括 finish=length 的中间段）都先经过
      // critic/editor；旧 snapshot v4 无 writingPipeline 时保持 R39 原顺序与语义。
      if (writingPipeline && strongConstraints?.enabled && content.trim()) {
        if (!writingPipelinePolicyValid(writingPipeline)) {
          await patchRun(runId, { status: 'recovery_required', phase: 'recovery_required', errorCode: 'writing_pipeline_incompatible', errorMessage: '写作审校快照版本不兼容，请放弃后重新发起' })
          emit(runId, { type: 'phase', phase: 'recovery_required', title: '写作审校快照不兼容' })
          return
        }
        const checkedTurns = await store.getTurns(runId)
        const checkedSegments = await getManuscriptSegments(runId, checkedTurns)
        const acceptedPrefix = checkedSegments
          .filter((segment) => segment.sourceTurnId !== turnId && segment.kind === 'prose' && (segment.status === 'accepted' || segment.status === 'candidate' || segment.status === 'partial'))
          .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt)
          .map((segment) => segment.content)
          .join('')
        const pipelineResult = await runWritingPipeline({
          runId,
          round: rounds,
          turnId,
          turnSeq,
          candidate: longWrite ? segmentContent : content,
          acceptedPrefix,
          targetChars,
          snapshot: strongConstraints,
          policy: writingPipeline,
          sceneContract: sceneContext?.contract,
          sectionReview: editorialSection && (editorialBoundaryReached || editorialSection.acceptedChars + codePointLength(segmentContent) >= editorialSection.targetChars || baseAssistantChars + codePointLength(segmentContent) >= targetChars)
            ? sectionReviewRequest(editorialSection) : undefined,
          sceneChars: sceneContext?.sceneChars,
          candidateSegmentId: activeCandidateSegmentId,
          candidateRevision: segmentRevision,
          narrativeQuality: narrativeQualityResult?.evaluation,
          atTarget: targetChars > 0 && codePointLength(acceptedPrefix) + codePointLength(longWrite ? segmentContent : content) >= targetChars,
          onCommit: async (edited, localizedRevision) => {
            if (localizedRevision?.status === 'applied' && longWrite) {
              const original = (await getManuscriptSegments(runId)).find((segment) => segment.segmentId === activeCandidateSegmentId)
              if (!original) throw new Error('wp7_localized_revision_candidate_missing')
              const nextRevision = original.revision + 1
              const nextSegmentId = `${runId}:${turnId}:wp7:${nextRevision}`
              const nextContent = edited
              const nextSegment = makeManuscriptSegment({
                runId,
                sessionId: m.run.sessionId,
                turnId,
                segmentId: nextSegmentId,
                sourceTurnId: turnId,
                chunkIndex: original.chunkIndex,
                ...(original.sectionId ? { sectionId: original.sectionId } : {}),
                ...(original.sceneId ? { sceneId: original.sceneId } : {}),
                content: nextContent,
                status: 'candidate',
                kind: 'prose',
                revision: nextRevision,
                supersedesSegmentId: original.segmentId,
                createdAt: original.createdAt
              })
              await saveSegment(nextSegment)
              activeCandidateSegmentId = nextSegmentId
              segmentRevision = nextRevision
              segmentSupersedesSegmentId = original.segmentId
              content = edited
              segmentContent = nextContent
              currentProseComplete = classifyAssistantOutput(segmentContent).kind === 'prose' && classifyAssistantOutput(segmentContent).complete
              segmentStatus = currentProseComplete ? 'candidate' : 'partial'
              reasoning = ''
              const updatedTurn: TurnRecord = { turnId, runId, turnSeq, role: 'assistant', content: edited, reasoningContent: undefined, createdAt: turnCreatedAt }
              await store.appendTurn(updatedTurn)
              emit(runId, { type: 'turn', turn: updatedTurn })
              return
            }
            content = edited
            segmentContent = edited
            currentProseComplete = classifyAssistantOutput(segmentContent).kind === 'prose' && classifyAssistantOutput(segmentContent).complete
            segmentStatus = currentProseComplete ? 'candidate' : 'partial'
            reasoning = ''
            await upsertTurn()
          }
        })
        if (pipelineResult.status === 'paused') return
        content = pipelineResult.content
        const acceptedDraft = `${acceptedPrefix}${content}`
        await store.saveRunEvidence(runId, 'strong_constraint_latest', JSON.stringify({
          schemaVersion: 1,
          status: 'passed',
          constraintHash: strongConstraints.hash,
          pipelineHash: writingPipeline.hash,
          draftHash: writingTextHash(acceptedDraft),
          latestSegmentHash: writingTextHash(content),
          violations: pipelineResult.advisories,
          repairAttempt: 0
        }))
        const postPipelineNarrativeQuality = await checkNarrativeQualityCandidate()
        if (!postPipelineNarrativeQuality.ok) continue
        narrativeQualityResult = postPipelineNarrativeQuality.result
        if (needsLengthContinuation || (finishReason === 'length' && targetChars > 0 && codePointLength(acceptedDraft) < targetChars)) {
          if (!(await checkSceneContractCandidate())) continue
          if (currentProseComplete) {
            const acceptedPrefixForQuality = narrativeQualityResult?.acceptedPrefix
            if (sceneContext) await acceptSceneCandidate(runId, turnId, sceneContext, true)
            else await acceptCurrentCandidate(runId, turnId, null)
            await observeAcceptedWriterRound(runId, rounds)
            const acceptedSegment = (await getManuscriptSegments(runId)).find((segment) => segment.segmentId === activeCandidateSegmentId && segment.status === 'accepted')
            if (acceptedSegment && acceptedPrefixForQuality !== undefined) {
              await evaluateNarrativeSegment(runId, acceptedSegment, sceneContext?.contract, 'accepted', acceptedPrefixForQuality)
            }
            if (sceneContext) {
              if (acceptedSegment) await evaluateSceneSegment(runId, sceneContext, acceptedSegment, 'accepted', true)
            }
          }
          if (longWritePlan) await saveLongWriteCheckpoint(runId)
          continue
        }
      } else if (needsLengthContinuation) {
        if (!(await checkSceneContractCandidate())) continue
        if (longWrite && currentProseComplete) {
          const acceptedPrefixForQuality = narrativeQualityResult?.acceptedPrefix
          if (sceneContext) await acceptSceneCandidate(runId, turnId, sceneContext, true)
          else await acceptCurrentCandidate(runId, turnId, null)
          await observeAcceptedWriterRound(runId, rounds)
          const acceptedSegment = (await getManuscriptSegments(runId)).find((segment) => segment.segmentId === activeCandidateSegmentId && segment.status === 'accepted')
          if (acceptedSegment && acceptedPrefixForQuality !== undefined) {
            await evaluateNarrativeSegment(runId, acceptedSegment, sceneContext?.contract, 'accepted', acceptedPrefixForQuality)
          }
          if (sceneContext) {
            if (acceptedSegment) await evaluateSceneSegment(runId, sceneContext, acceptedSegment, 'accepted', true)
          }
        }
        if (longWritePlan) await saveLongWriteCheckpoint(runId)
        continue
      }
      if (!writingPipeline && strongConstraints?.enabled && content.trim()) {
        emit(runId, { type: 'phase', phase: 'validating', title: '检查是否偏题', detail: '按本次冻结的主题、体裁、视角和禁止项检查候选段' })
        const checkedTurns = await store.getTurns(runId)
        const checkedSegments = await getManuscriptSegments(runId, checkedTurns)
        const usableSegments = checkedSegments
          .filter((segment) => segment.kind === 'prose' && (segment.status === 'accepted' || segment.status === 'candidate' || segment.status === 'partial'))
          .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt)
        const draft = usableSegments.map((segment) => segment.content).join('')
        const acceptedBeforeCandidate = usableSegments.filter((segment) => segment.sourceTurnId !== turnId).reduce((sum, segment) => sum + segment.charCount, 0)
        const atTarget = targetChars > 0 && codePointLength(draft) >= targetChars
        const check = evaluateStrongConstraints(strongConstraints, draft, content, {
          writingForm: frozenWritingForm(getConfig(runId)),
          atTarget,
          // balanced 只要求第一个有效正文候选落到主题；strict 则每段都检查。
          // 这样能挡住“前三段跑题、末段补关键词”，又不要求正常长文每段机械复读。
          requireThemeInSegment: acceptedBeforeCandidate === 0 || strongConstraints.level === 'strict',
          checkSegmentPerspective: strongConstraints.perspective !== 'auto'
        })
        const durableRepairAttempts = (await store.getCompletionAttempts(runId)).filter((a) => a.attempt < 0)
        const previousRepairs = durableRepairAttempts.length
        if (!check.ok) {
          const categories = [...new Set(check.violations.map((v) => v.category))]
          const repairAttempt = previousRepairs + 1
          const candidateHash = createHash('sha256').update(content).digest('hex')
          const findingHashes = check.violations.map((v) => createHash('sha256').update(`${strongConstraints.hash}\u0000${v.code}\u0000${v.message}`).digest('hex'))
          await store.appendCompletionAttempt(runId, -repairAttempt, JSON.stringify({
            kind: 'strong_constraint_repair',
            status: 'detected',
            constraintHash: strongConstraints.hash,
            candidateHash,
            findingHashes,
            categories,
            repairAttempt,
            maxRepairAttempts: strongConstraints.maxRepairAttempts
          }))
          await store.saveRunEvidence(runId, 'strong_constraint_latest', JSON.stringify({
            schemaVersion: 1,
            status: 'detected',
            constraintHash: strongConstraints.hash,
            draftHash: createHash('sha256').update(draft).digest('hex'),
            latestSegmentHash: candidateHash,
            violations: check.violations.map((v) => ({ code: v.code, category: v.category, message: v.message })),
            repairAttempt
          }))
          // 未通过的候选不能留在 durable/canonical/UI 正文里。先覆盖为空，再用当前
          // durable assistant 投影纠正 renderer；下一轮只生成替换段。
          const rejectedContent = content
          segmentContent = rejectedContent
          segmentStatus = 'rejected'
          await upsertTurn()
          content = ''
          reasoning = ''
          await upsertTurn()
          const validDraft = await acceptedTextForRun(runId)
          emit(runId, { type: 'content_replace', content: validDraft, revision: repairAttempt, contentHash: createHash('sha256').update(validDraft).digest('hex') })
          await store.appendCompletionAttempt(runId, -repairAttempt, JSON.stringify({
            kind: 'strong_constraint_repair',
            status: 'retracted',
            constraintHash: strongConstraints.hash,
            candidateHash,
            validDraftHash: createHash('sha256').update(validDraft).digest('hex'),
            findingHashes,
            categories,
            repairAttempt,
            maxRepairAttempts: strongConstraints.maxRepairAttempts
          }))
          await store.saveRunEvidence(runId, 'strong_constraint_latest', JSON.stringify({
            schemaVersion: 1,
            status: repairAttempt > strongConstraints.maxRepairAttempts ? 'paused' : 'retracted',
            constraintHash: strongConstraints.hash,
            draftHash: createHash('sha256').update(validDraft).digest('hex'),
            latestSegmentHash: createHash('sha256').update('').digest('hex'),
            violations: check.violations.map((v) => ({ code: v.code, category: v.category, message: v.message })),
            repairAttempt
          }))
          if (repairAttempt > strongConstraints.maxRepairAttempts) {
            const message = `强约束检查连续 ${strongConstraints.maxRepairAttempts} 次未通过（${categories.join('、')}）；未通过段已撤回，请调整约束或补充写作要求后继续`
            await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'strong_constraint_repair_exhausted', errorMessage: message })
            emit(runId, { type: 'phase', phase: 'paused', title: '约束修复已暂停', detail: message })
            return
          }
          const remainingChars = targetChars > 0 ? Math.max(0, targetChars - codePointLength(validDraft)) : 0
          const latestTurns = await store.getTurns(runId)
          const nextSeq = latestTurns.length ? Math.max(...latestTurns.map((t) => t.turnSeq)) + 1 : 1
          await store.appendTurn({
            turnId: randomUUID(),
            runId,
            turnSeq: nextSeq,
            role: 'system',
            content: buildStrongConstraintRepairInstruction({ snapshot: strongConstraints, violations: check.violations, remainingChars, repairAttempt, writingForm: frozenWritingForm(getConfig(runId)) }),
            createdAt: now()
          })
          m.nextTurnSeq = nextSeq + 1
          emit(runId, { type: 'phase', phase: 'validating', title: '正在纠正偏移', detail: `${categories.join('、')} · 第 ${repairAttempt}/${strongConstraints.maxRepairAttempts} 次` })
          continue
        }
        emit(runId, {
          type: 'phase',
          phase: 'validating',
          title: previousRepairs > 0 ? '偏移已纠正' : '约束检查通过',
          detail: previousRepairs > 0 ? `已完成 ${previousRepairs} 次修复，候选段重新通过检查` : '主题、体裁、视角和禁止项未发现阻断'
        })
        await store.saveRunEvidence(runId, 'strong_constraint_latest', JSON.stringify({
          schemaVersion: 1,
          status: 'passed',
          constraintHash: strongConstraints.hash,
          draftHash: createHash('sha256').update(draft).digest('hex'),
          latestSegmentHash: createHash('sha256').update(content).digest('hex'),
          violations: [],
          repairAttempt: previousRepairs
        }))
        if (previousRepairs > 0) {
          const latest = durableRepairAttempts[durableRepairAttempts.length - 1]
          let prior: Record<string, unknown> = {}
          try { prior = latest ? JSON.parse(latest.json) as Record<string, unknown> : {} } catch { prior = {} }
          await store.appendCompletionAttempt(runId, -previousRepairs, JSON.stringify({ ...prior, status: 'passed', passedDraftHash: createHash('sha256').update(draft).digest('hex') }))
        }
      }
      const finalNarrativeQuality = await checkNarrativeQualityCandidate()
      if (!finalNarrativeQuality.ok) continue
      narrativeQualityResult = finalNarrativeQuality.result
      if (!(await checkSceneContractCandidate())) continue
      if (longWrite) {
        if (!currentProseComplete) {
          segmentStatus = 'partial'
          segmentKind = 'prose'
          segmentContent = segmentContent || content
          await upsertTurn()
          const canonical = await acceptedTextForRun(runId)
          emit(runId, { type: 'content_replace', content: canonical, revision: rounds, contentHash: createHash('sha256').update(canonical).digest('hex') })
          const latestTurns = await store.getTurns(runId)
          const nextSeq = latestTurns.length ? Math.max(...latestTurns.map((turn) => turn.turnSeq)) + 1 : 1
          await store.appendTurn({
            turnId: randomUUID(),
            runId,
            turnSeq: nextSeq,
            role: 'system',
            content: `上一生成分片停在未完成句中，暂不计入正式正文。紧接已有文字补全当前句并继续${isEditorialWriting(runConfig) ? '当前节' : '场景'}，只输出正文。`,
            createdAt: now()
          })
          m.nextTurnSeq = nextSeq + 1
          if (longWritePlan) await saveLongWriteCheckpoint(runId)
          emit(runId, { type: 'phase', phase: 'writing', title: '正在补全未完成句', detail: '残句不会提前计入正文或最终稿' })
          if (!targetWindowRepairAtStart) await observeAcceptedWriterRound(runId, rounds)
          continue
        }
        segmentStatus = 'candidate'
        segmentKind = 'prose'
        segmentContent = segmentContent || content
        await upsertTurn()
        if (partialTailContent) {
          // The selected complete prefix is about to be accepted. Its carried
          // remainder is a new chunk, not a competing revision of that same
          // accepted chunk (nor a second superseder of a prior partial).
          const tailChunkIndex = Math.max(segmentChunkIndex, ...(await getManuscriptSegments(runId)).map(segment => segment.chunkIndex)) + 1
          let tailSceneId = segmentSceneId
          if (sceneContext && sceneContext.plan.contracts.every(contract => contract.order <= sceneContext.contract.order)) {
            const scenePrefix = (await getManuscriptSegments(runId)).filter(segment => segment.status === 'accepted' && segment.kind === 'prose' && segment.sceneId === sceneContext.contract.sceneId)
              .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt).map(segment => segment.content).join('')
            const evaluation = evaluateSceneContract(sceneContext.contract, segmentContent, { completed: true, scenePrefix,
              sceneChars: codePointLength(scenePrefix + segmentContent), ...await readSceneCriticOptions(runId, sceneContext.contract, segmentContent, scenePrefix) })
            if (buildSceneCompletionDecision(sceneContext.contract, segmentContent, { candidateSegmentId: activeCandidateSegmentId, scenePrefix, evaluation, at: now() }).status === 'complete') {
              // This remainder is outside the soon-to-be committed final scene
              // manifest. The no-scene closing continuation must carry it,
              // without mutating or borrowing that manifest's scene evidence.
              tailSceneId = undefined
            }
          }
          await saveSegment(makeManuscriptSegment({
            runId,
            sessionId: m.run.sessionId,
            turnId: `${turnId}:partial-tail`,
            sourceTurnId: turnId,
            chunkIndex: tailChunkIndex,
            revision: 1,
            ...(segmentSectionId ? { sectionId: segmentSectionId } : {}),
            ...(tailSceneId ? { sceneId: tailSceneId } : {}),
            content: partialTailContent,
            status: 'partial',
            kind: 'prose',
            createdAt: turnCreatedAt
          }))
        }
        const acceptedPrefixForQuality = narrativeQualityResult?.acceptedPrefix
        const acceptedDraft = sceneContext
          ? (await acceptSceneCandidate(runId, turnId, sceneContext)).acceptedText
          : await acceptCurrentCandidate(runId, turnId, null)
        await observeAcceptedWriterRound(runId, rounds)
        const acceptedSegment = (await getManuscriptSegments(runId)).find((segment) => segment.segmentId === activeCandidateSegmentId && segment.status === 'accepted')
        if (editorialSection && acceptedSegment && (!writingPipeline || !strongConstraints?.enabled) &&
          (editorialBoundaryReached || editorialSection.acceptedChars + acceptedSegment.charCount >= editorialSection.targetChars || codePointLength(acceptedDraft) >= targetChars)) {
          const request = sectionReviewRequest(editorialSection)
          await store.saveRunEvidence(runId, sectionReviewEvidenceKind(turnId, acceptedSegment.contentHash), JSON.stringify({ schemaVersion: 1,
            sectionId: request.sectionId, outlineHash: request.outlineHash, candidateHash: acceptedSegment.contentHash,
            contentHash: writingTextHash(request.acceptedPrefix + acceptedSegment.content), coverage: { status: 'unavailable', reason: '本路径未启用 critic；未生成目的覆盖意见', quote: '' }, rawCoverage: null }))
          emit(runId, { type: 'phase', phase: 'validating', title: '本节按篇幅推进', detail: '未启用审校；按已确认节范围收稿，不声称目的覆盖或事实核验已通过' })
        }
        if (acceptedSegment && acceptedPrefixForQuality !== undefined) {
          await evaluateNarrativeSegment(runId, acceptedSegment, sceneContext?.contract, 'accepted', acceptedPrefixForQuality)
        }
        if (sceneContext) {
          if (acceptedSegment) await evaluateSceneSegment(runId, sceneContext, acceptedSegment, 'accepted', true)
        }
        emit(runId, { type: 'content_replace', content: acceptedDraft, revision: rounds, contentHash: createHash('sha256').update(acceptedDraft).digest('hex') })
      }
      if (longWrite && deferCompletionGate) {
        if (longWritePlan) await saveLongWriteCheckpoint(runId)
        continue
      }
      // A longwrite scene is not complete merely because the manuscript has
      // reached a character budget.  Stay on the durable scene plan until an
      // explicit completion decision has committed every scene; this also
      // keeps a deferred/missing-beat scene from silently crossing its edge.
      if (longWrite && await scenePlanHasPending(runId, getConfig(runId))) {
        if (longWritePlan) await saveLongWriteCheckpoint(runId)
        continue
      }
      if (longWrite && await currentEditorialSection(getConfig(runId), await getManuscriptSegments(runId), kind => store.getRunEvidence(runId, kind))) {
        if (longWritePlan) await saveLongWriteCheckpoint(runId)
        continue
      }
      if (longWritePlan) await saveLongWriteCheckpoint(runId)
      // R4.3 Gate 4（S-03）：completed 只能由外部完成契约产生——模型 finish stop 只是候选；
      // 有 completionContract 的 run 必须经 CompletionController 校验，未通过则注入缺口继续，绝不自我宣布完成
      const cc = (getConfig(runId).completionContract as CompletionContract | undefined) ?? null
      if (cc) {
        const gate = await tryCompletionGate(runId, cc)
        if (gate === 'paused') {
          // R4.5 Gate 4：等待用户决策（预算耗尽/低进展/达上限）——挂起非终态，不 finalize；
          // phase 用现有 'paused'（RunPhase 全键 Record、renderer 受保护不新增枚举）
          const latest = store.getLatestCompletionEvaluation(runId)
          let pauseMessage = '完成校验已暂停，请调整预算或目标后重新发起，或停止此任务'
          try {
            const parsed = latest ? (JSON.parse(latest.json) as CompletionEvaluation) : null
            if (parsed?.pausedMessage) pauseMessage = parsed.pausedMessage
          } catch {
            // 评估正文损坏不应把可恢复暂停误升级为失败；保留安全、可操作的默认说明。
          }
          let pauseReason = 'paused'
          try {
            const parsed = latest ? (JSON.parse(latest.json) as CompletionEvaluation) : null
            pauseReason = parsed?.blockedReason ?? pauseReason
          } catch {
            // 上方已用默认文案降级；错误码同样保持通用 paused。
          }
          await patchRun(runId, {
            status: 'waiting_user',
            phase: 'paused',
            errorCode: `completion_${pauseReason}`,
            errorMessage: pauseMessage
          })
          emit(runId, { type: 'phase', phase: 'paused', title: '等待你的决定', detail: pauseMessage })
          return
        }
        if (gate === 'blocked') {
          await finalize(runId, 'failed', { errorCode: 'completion_blocked', errorMessage: '完成校验阻塞（无进展/达上限/预算耗尽），请人工介入' })
          return
        }
        if (!gate) continue // validating → 下一轮（缺口已注入）
      }
      await finalizeCompleted(runId)
      return
    }
  }

  const freezeNewSceneBeatRepairPolicy = async (runId: string, config: RunConfig): Promise<void> => {
    const plan = config.sceneContracts as SceneContractPlan | undefined
    if (plan === undefined || plan === null) return
    if (!sceneContractPlanValid(plan)) throw new Error('scene_contract_plan_invalid')
    if (!store.saveRunEvidenceIfAbsent) throw new Error('scene_beat_repair_policy_cas_unavailable')
    for (const contract of plan.contracts) {
      const kind = sceneBeatRepairEvidenceKind(contract.sceneId)
      const initial = readSceneBeatRepairLedger(null, runId, contract)
      const inserted = await store.saveRunEvidenceIfAbsent(runId, kind, JSON.stringify(initial))
      if (inserted) continue
      const existing = await store.getRunEvidence(runId, kind)
      if (!existing || stableNarrativeJson(readSceneBeatRepairLedger(existing.json, runId, contract)) !== stableNarrativeJson(initial)) {
        throw new Error('scene_beat_repair_new_run_policy_conflict')
      }
    }
  }

  const start = async (input: {
    sessionId: string
    runId: string
    config: RunConfig
    parentRunId?: string
    /** R4.2 A1：run 行与首个 user turn 已由 acceptChatStart 在单事务内落库；start 只装载不创建（PERSIST-ATOMIC-02） */
    alreadyCreated?: boolean
    /** Internal post-insert signal from startChatRun, never an IPC/payload field. */
    newlyAccepted?: boolean
  }): Promise<StartResult> => {
    if (input.alreadyCreated) {
      // 事务提交后才允许装载：run 必须真实存在（禁止伪造）；绝不在此处 createRun
      const pre = await store.getRun(input.runId)
      if (!pre) throw new Error(`run 不存在（acceptChatStart 未提交）: ${input.runId}`)
      const preTurns = await store.getTurns(input.runId)
      if (input.newlyAccepted) {
        if (pre.sessionId !== input.sessionId || pre.status !== 'queued' || pre.phase !== 'queued' ||
          stableNarrativeJson(JSON.parse(pre.configJson)) !== stableNarrativeJson(input.config) ||
          preTurns.length !== 1 || preTurns[0]?.role !== 'user' || preTurns[0].runId !== input.runId) {
          throw new Error('scene_beat_repair_new_run_identity_invalid')
        }
        await freezeNewSceneBeatRepairPolicy(input.runId, input.config)
      }
      mem.set(input.runId, {
        run: pre,
        controller: new AbortController(),
        stepping: null,
        nextTurnSeq: preTurns.length ? Math.max(...preTurns.map((t) => t.turnSeq)) + 1 : 1,
        currentAssistant: null,
        writingPipelineResume: null,
        manuscriptResume: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, cost: 0 },
        manuscriptCache: null,
        usageRevision: 0,
        pauseRequested: false,
        done: false
      })
      await loadRunBudget(input.runId, input.config, pre.startedAt)
      onRunUpdate(pre)
      emit(input.runId, { type: 'phase', phase: 'queued', title: '任务已开始' })
      const preCc = (input.config.completionContract as CompletionContract | undefined) ?? null
      if (preCc) {
        emit(input.runId, completionEvent('contract_created', { revision: 0, state: 'planning', hardFailures: [], softWarnings: [], measuredChars: null, artifactHashes: [], remainingWork: [] }, preCc))
      }
      return { ok: true, run: pre }
    }
    const existing = await store.getRun(input.runId)
    if (existing) return { ok: false, error: 'run_exists', runId: input.runId }
    const actives = await store.listActiveRuns()
    const busy = actives.find((r) => r.sessionId === input.sessionId && !isTerminal(r.status))
    if (busy && !input.config.allowParallel) return { ok: false, error: 'session_busy', runId: busy.runId }
    const run: RunRecord = {
      runId: input.runId,
      sessionId: input.sessionId,
      status: 'queued',
      phase: 'queued',
      startedAt: now(),
      updatedAt: now(),
      configJson: JSON.stringify(input.config),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {})
    }
    await store.createRun(run)
    await freezeNewSceneBeatRepairPolicy(input.runId, input.config)
    mem.set(input.runId, {
      run,
      controller: new AbortController(),
      stepping: null,
      nextTurnSeq: 1,
      currentAssistant: null,
      writingPipelineResume: null,
      manuscriptResume: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, cost: 0 },
      manuscriptCache: null,
        usageRevision: 0,
      pauseRequested: false,
      done: false
    })
    await loadRunBudget(input.runId, input.config, run.startedAt)
    onRunUpdate(run)
    emit(input.runId, { type: 'phase', phase: 'queued', title: '任务已开始' })
    return { ok: true, run }
  }

  /**
   * step is intentionally fire-and-forget at the IPC boundary.  Any exception
   * which escapes doCycle therefore needs its own durable terminal projection;
   * otherwise the caller sees a failed task while the run remains queued/running
   * forever with no error_code or error_message to explain it.
   */
  const persistUnexpectedStepFailure = async (runId: string, error: unknown): Promise<void> => {
    const m = mem.get(runId)
    // waiting_user/recovery_required are deliberate durable pauses, not
    // unexpected failures.  A stale resume/step rejection must not erase the
    // user's pending decision or an unresolved side-effect boundary.
    if (!m || m.done || m.controller.signal.aborted || m.run.status === 'cancel_requested' || m.run.status === 'waiting_user' || m.run.status === 'recovery_required') return
    const message = errMsg(error).trim().slice(0, 1000) || '运行执行失败'
    const code = errCode(error)
    if (error instanceof RunBudgetExceededError || code.startsWith('run_') || error instanceof NarrativeStatePendingReviewError || code === 'narrative_state_pending_review') {
      try {
        const durable = await store.getRun(runId)
        if (!durable || isTerminal(durable.status) || durable.status === 'waiting_user' || durable.status === 'recovery_required') return
        const pauseCode = error instanceof RunBudgetExceededError ? error.code : code
        const pauseTitle = pauseCode === 'narrative_state_pending_review' ? '叙事状态等待复核' : '运行预算已暂停'
        await store.updateRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: pauseCode, errorMessage: message })
        m.run = { ...m.run, status: 'waiting_user', phase: 'paused', errorCode: pauseCode, errorMessage: message, updatedAt: now() }
        onRunUpdate(m.run)
        emit(runId, { type: 'phase', phase: 'paused', title: pauseTitle, detail: message })
      } catch {
        // If the run row itself is unavailable, preserve the original error;
        // the durable budget evidence/provider attempt remains inspectable.
      }
      return
    }
    try {
      const durable = await store.getRun(runId)
      if (!durable || isTerminal(durable.status) || durable.status === 'waiting_user' || durable.status === 'recovery_required') return
      await store.updateRun(runId, { status: 'failed', phase: 'failed', errorCode: 'run_step_failed', errorMessage: message })
      m.run = { ...m.run, status: 'failed', phase: 'failed', errorCode: 'run_step_failed', errorMessage: message, updatedAt: now() }
      m.done = true
      completionControllers.delete(runId)
      onRunUpdate(m.run)
      emit(runId, { type: 'terminal', run: m.run })
    } catch {
      // 保留原始异常给调用方；若 DB 本身已不可写，不能再用兜底异常覆盖它。
    }
  }

  const step = async (runId: string): Promise<void> => {
    const m = mem.get(runId)
    if (!m) throw new Error(`run 未启动: ${runId}`)
    if (isTerminal(m.run.status)) throw new Error(`run 已终态: ${runId}`)
    if (m.stepping) return m.stepping
    const p = doCycle(runId).catch(async (error: unknown) => {
      await persistUnexpectedStepFailure(runId, error)
      throw error
    }).finally(() => {
      const cur: EngineMemory | undefined = mem.get(runId)
      if (cur && cur.stepping === p) cur.stepping = null
    })
    m.stepping = p
    return p
  }

  const cancel = async (runId: string): Promise<void> => {
    const m = mem.get(runId)
    if (!m || isTerminal(m.run.status)) return
    // R4.5 Gate 4：waiting_user（完成校验暂停等用户决策）无活跃模型流/工具——
    // 用户取消即时终态（无需 abort 协作路径；无未确认工具 → cancelled）
    if (m.run.status === 'waiting_user') {
      await finalizeCancel(runId)
      return
    }
    // R4.1 S-04：先提交 durable 取消意图（cancel_requested，phase stopping）再 abort；
    // 终态由协作路径（流/工具循环检测到信号后 finalizeCancel）或 5s 兜底确认
    m.run.status = 'cancel_requested'
    await patchRun(runId, { status: 'cancel_requested', phase: 'stopping' })
    m.controller.abort()
    // 兜底：模型流/工具未及时响应时强制终态（不无限悬挂）。
    // 有未确认工具副作用（running/requested）→ recovery_required；否则 cancelled
    const cfg = getConfig(runId)
    const fallbackMs = typeof cfg.cancelFallbackMs === 'number' ? (cfg.cancelFallbackMs as number) : 5000
    setTimeout(() => {
      const cur = mem.get(runId)
      if (cur && cur.run.status === 'cancel_requested' && !cur.done) {
        void finalizeCancel(runId)
      }
    }, fallbackMs)
  }

  const pause = async (runId: string): Promise<void> => {
    let m = mem.get(runId)
    if (!m) {
      const existing = await store.getRun(runId)
      if (!existing || isTerminal(existing.status) || existing.status === 'waiting_user') return
      await restore(runId)
      m = mem.get(runId)
    }
    if (!m || m.done || isTerminal(m.run.status) || m.run.status === 'waiting_user') return
    const toolCalls = await store.getToolCalls(runId)
    if (toolCalls.some((tc) => tc.status === 'running' || tc.status === 'requested')) {
      const error = new Error('pause_tool_in_flight') as Error & { code?: string }
      error.code = 'pause_tool_in_flight'
      throw error
    }
    m.pauseRequested = true
    const message = '已保存未提交草稿；继续时会从已保存草稿发起新的生成请求/续写'
    await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'activity_paused', errorMessage: message })
    m.controller.abort()
    const stepping = m.stepping
    if (stepping) await stepping.catch(() => undefined)
    // A compliant model stream settles at the abort boundary and persists its
    // partial turn in doCycle. The durable waiting_user row is still the safe
    // boundary if a provider ignores AbortSignal; no same-stream pause is
    // claimed.
  }

  const restoring = new Map<string, Promise<void>>()
  const restore = (runId: string): Promise<void> => {
    const pending = restoring.get(runId)
    if (pending) return pending
    const current = mem.get(runId)
    // Duplicate resume must join the existing cycle, not replace its memory
    // and dispatch a second provider/tool attempt.
    if (current?.stepping || (current?.run.status === 'running' && !current.controller.signal.aborted && !current.done)) return Promise.resolve()
    const task = restoreUnlocked(runId).finally(() => { if (restoring.get(runId) === task) restoring.delete(runId) })
    restoring.set(runId, task)
    return task
  }

  const restoreUnlocked = async (runId: string): Promise<void> => {
    const run = await store.getRun(runId)
    if (!run) throw new Error(`run 不存在: ${runId}`)
    if (isTerminal(run.status)) throw new Error(`run 已终态，不可恢复: ${runId}`)
    // Story-invalidated runs are durable recovery records, not ordinary
    // interruptions. Do not reconstruct an executable memory state that a
    // restart could accidentally step; the UI must create a safe branch.
    if (run.errorCode === 'story_ledger_epoch_invalidated') return
    if (store.getNarrativeLedgerScope) {
      const scope = await store.getNarrativeLedgerScope(runId)
      if (scope && (scope.epochValid === false || scope.validityEpoch !== scope.headValidityEpoch)) {
        await store.updateRun(runId, { status: 'recovery_required', phase: 'recovery_required', errorCode: 'story_ledger_epoch_invalidated', errorMessage: storyEpochInvalidationMessage })
        onRunUpdate({ ...run, status: 'recovery_required', phase: 'recovery_required', errorCode: 'story_ledger_epoch_invalidated', errorMessage: storyEpochInvalidationMessage, updatedAt: now() })
        return
      }
    }
    mem.set(runId, {
      run,
      controller: new AbortController(),
      stepping: null,
      nextTurnSeq: 1,
      currentAssistant: null,
      writingPipelineResume: null,
      manuscriptResume: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, cost: 0 },
      manuscriptCache: null,
        usageRevision: 0,
      pauseRequested: false,
      done: false
    })
    // Explicit amendments are committed with the durable ledger. Reload it
    // on actual restore; retaining a pre-amendment cached cap would reblock.
    runBudgets.delete(runId)
    await loadRunBudget(runId, getConfig(runId), run.startedAt)
    const m = mem.get(runId)!
    const turns = await store.getTurns(runId)
    if (isLongWriteConfig(getConfig(runId))) await saveLongWriteCheckpoint(runId, turns)
    const toolCalls = await store.getToolCalls(runId)
    let nextTurnSeq = turns.length ? Math.max(...turns.map((t) => t.turnSeq)) + 1 : 1
    const last = turns[turns.length - 1]
    let pipelineHandled = false
    const parallelReadNextSeq = await reconcileParallelReadBatch(runId, turns, nextTurnSeq)
    if (parallelReadNextSeq !== null) {
      nextTurnSeq = parallelReadNextSeq
      pipelineHandled = true
    }
    const policy = getConfig(runId).writingPipeline as WritingPipelinePolicyV1 | undefined
    // A completion/continuation system turn may be newer than the assistant
    // candidate named by durable pipeline evidence. Recovery must follow the
    // evidence-bound assistant, not merely the last row in the transcript.
    let pipelineEvidenceTurnId = ''
    if (policy) {
      const raw = await store.getRunEvidence(runId, 'writing_pipeline_latest')
      try {
        const parsed = raw ? JSON.parse(raw.json) as Record<string, unknown> : null
        pipelineEvidenceTurnId = typeof parsed?.turnId === 'string' ? parsed.turnId : ''
      } catch {
        pipelineEvidenceTurnId = ''
      }
    }
    const latestPlainAssistant = [...turns].reverse().find((turn) => turn.role === 'assistant' && !turn.toolCallsJson)
    const pipelineTurn = (pipelineEvidenceTurnId ? turns.find((turn) => turn.turnId === pipelineEvidenceTurnId) : undefined) ?? latestPlainAssistant
    if (policy && pipelineTurn?.role === 'assistant' && !pipelineTurn.toolCallsJson) {
      const last = pipelineTurn
      pipelineHandled = true
      if (!writingPipelinePolicyValid(policy)) {
        await patchRun(runId, { status: 'recovery_required', phase: 'recovery_required', errorCode: 'writing_pipeline_incompatible', errorMessage: '写作审校快照损坏或版本不兼容，不能静默降级' })
      } else {
        const raw = await store.getRunEvidence(runId, 'writing_pipeline_latest')
        let evidence: Record<string, unknown> | null = null
        try { evidence = raw ? JSON.parse(raw.json) as Record<string, unknown> : null } catch { evidence = null }
        const evidenceTurnId = typeof evidence?.turnId === 'string' ? evidence.turnId : ''
        const stage = typeof evidence?.stage === 'string' ? evidence.stage : 'candidate_persisted'
        const criticSegment = typeof evidence?.criticSegmentId === 'string'
          ? (store.getManuscriptSegments ? await store.getManuscriptSegments(runId) : [...fallbackSegmentsFor(runId).values()])
            .find(segment => segment.segmentId === evidence?.criticSegmentId && segment.sourceTurnId === last.turnId) : null
        const criticCandidateHash = typeof evidence?.criticSegmentId === 'string'
          ? (criticSegment && criticSegment.contentHash === writingTextHash(criticSegment.content) ? criticSegment.contentHash : '') : writingTextHash(last.content)
        if (evidenceTurnId && evidenceTurnId !== last.turnId) {
          await patchRun(runId, { status: 'recovery_required', phase: 'recovery_required', errorCode: 'writing_pipeline_turn_mismatch', errorMessage: '写作审校证据不属于当前正文，不能自动恢复' })
        } else if (stage === 'edit_prepared') {
          try {
            if (evidence?.verified !== true) throw new Error('prepared_revision_not_verified')
            const beforeHash = String(evidence?.beforeHash ?? '')
            const afterHash = String(evidence?.afterHash ?? '')
            const currentHash = writingTextHash(last.content)
            if (currentHash === beforeHash) {
              const patch = evidence?.patch as { issueId: string; startCp: number; endCp: number; quote: string; replacement: string }
              const applied = applyTargetedEdit(last.content, { schemaVersion: 1, candidateHash: beforeHash, patches: [patch] })
              if (applied.afterHash !== afterHash) throw new Error('prepared_after_hash_mismatch')
              // An active legacy run may already have a backfill segment for
              // this source turn. Keep that source turn immutable, and create
              // (or replay) one candidate revision linked to the legacy
              // partial. Inserting a second segment at the same chunk/revision
              // violates the durable uniqueness invariant; mutating the old
              // source turn would invalidate the P0-2 backfill hash.
              const recoverySegments = isLongWriteConfig(getConfig(runId))
                ? (await getManuscriptSegments(runId, turns))
                  .filter((segment) => segment.sourceTurnId === last.turnId)
                  .sort((a, b) => a.revision - b.revision || a.updatedAt - b.updatedAt)
                : []
              const existingRecoverySegment = recoverySegments.at(-1)
              const legacyRecoverySegment = recoverySegments.find((segment) => segment.segmentId.includes(':legacy:'))
              const preparedCandidate = recoverySegments.find((segment) => segment.status === 'candidate' && segment.kind === 'prose' && segment.contentHash === afterHash)
              const isLegacyRecovery = legacyRecoverySegment !== undefined
              const legacyPartialAncestor = legacyRecoverySegment?.status === 'partial' ? legacyRecoverySegment : undefined
              const updatedTurn = isLegacyRecovery ? last : { ...last, content: applied.content }
              const segment = makeManuscriptSegment({
                runId,
                sessionId: run.sessionId,
                turnId: last.turnId,
                ...(preparedCandidate?.segmentId
                  ? { segmentId: preparedCandidate.segmentId }
                  : isLegacyRecovery
                    ? { segmentId: `${runId}:${last.turnId}` }
                    : existingRecoverySegment?.segmentId
                      ? { segmentId: existingRecoverySegment.segmentId }
                      : {}),
                chunkIndex: preparedCandidate?.chunkIndex ?? legacyRecoverySegment?.chunkIndex ?? existingRecoverySegment?.chunkIndex ?? last.turnSeq,
                ...(preparedCandidate?.revision
                  ? { revision: preparedCandidate.revision }
                  : isLegacyRecovery
                    ? { revision: (legacyRecoverySegment?.revision ?? 0) + 1 }
                    : existingRecoverySegment?.revision
                      ? { revision: existingRecoverySegment.revision }
                      : {}),
                ...(preparedCandidate?.supersedesSegmentId
                  ? { supersedesSegmentId: preparedCandidate.supersedesSegmentId }
                  : legacyPartialAncestor
                    ? { supersedesSegmentId: legacyPartialAncestor.segmentId }
                    : existingRecoverySegment?.supersedesSegmentId
                      ? { supersedesSegmentId: existingRecoverySegment.supersedesSegmentId }
                      : {}),
                content: applied.content,
                status: 'candidate',
                kind: 'prose',
                createdAt: last.createdAt
              })
              await saveAssistantTurnWithSegment(updatedTurn, segment)
              const prefix = await workingTextForRun(runId, last.turnId)
              emit(runId, { type: 'content_replace', content: `${prefix}${applied.content}`, revision: Number(evidence?.replaceRevision ?? 1), contentHash: writingTextHash(`${prefix}${applied.content}`) })
            } else if (currentHash !== afterHash) {
              throw new Error('prepared_current_hash_mismatch')
            }
            await store.saveRunEvidence(runId, 'writing_pipeline_latest', JSON.stringify({ ...evidence, stage: 'accepted', candidateHash: afterHash }))
            m.writingPipelineResume = { turnId: last.turnId, stage: 'accepted' }
          } catch (error) {
            await patchRun(runId, { status: 'recovery_required', phase: 'recovery_required', errorCode: 'writing_pipeline_prepared_mismatch', errorMessage: `定点修订恢复校验失败：${errMsg(error)}` })
          }
        } else if (stage === 'edit_proposed') {
          // editor 已返回，但修订稿尚未通过 deterministic + verification critic；
          // canonical 仍是原候选。恢复时不能重放整条 pipeline（会再次调用
          // critic/editor 并产生重复费用），也不能应用未验收 patch。
          await patchRun(runId, {
            status: 'waiting_user', phase: 'paused', errorCode: 'writing_edit_verification_interrupted',
            errorMessage: '局部修订已返回，但复核在完成前中断；原稿仍在，已停止自动重放以免重复计费'
          })
        } else if (stage === 'editor_started') {
          await patchRun(runId, {
            status: 'waiting_user', phase: 'paused', errorCode: 'writing_editor_interrupted',
            errorMessage: '局部修订在返回前中断；原稿仍在，已停止自动重放以免重复计费'
          })
        } else if (stage === 'paused' || (stage !== 'accepted' && await (async () => {
          try {
            if (!evidence) return true
            const attempts = readWritingCriticAttempts(evidence, { turnId: last.turnId, policyHash: policy.hash, candidateHash: criticCandidateHash })
            if (attempts >= 2) return true
            return attempts === 1 && !await store.getRunEvidence(runId, `writing_pipeline_critic_${last.turnId}_${criticCandidateHash}_1`)
          } catch { return true }
        })())) {
          await patchRun(runId, {
            status: 'waiting_user', phase: 'paused', errorCode: 'writing_critic_retry_exhausted',
            errorMessage: '文字审校两次额度已用尽或持久化证据不明；原稿仍在，不能自动重放'
          })
        } else {
          const candidateHash = typeof evidence?.candidateHash === 'string' ? evidence.candidateHash : ''
          if (stage === 'accepted' && candidateHash !== writingTextHash(last.content)) {
            await patchRun(runId, { status: 'recovery_required', phase: 'recovery_required', errorCode: 'writing_pipeline_candidate_mismatch', errorMessage: '已验收审校证据与当前正文 hash 不一致，不能自动完成' })
          } else {
            if (stage !== 'accepted' && evidence) {
              try { await restoreWritingProviderFence(runId, last, policy.hash, evidence, criticCandidateHash) } catch (error) {
                if (errCode(error) === 'story_ledger_epoch_invalidated' || errCode(error) === 'story_ledger_concurrent_head_conflict' ||
                  errMsg(error) === 'story_ledger_epoch_invalidated' || errMsg(error) === 'story_ledger_concurrent_head_conflict') throw error
                await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: 'writing_provider_fence_invalid', errorMessage: `原Provider栅栏不可验证（${errMsg(error)}）；原稿已保留，不能自动重放` })
                return
              }
            }
            m.writingPipelineResume = {
              turnId: last.turnId,
              stage,
              ...(stage !== 'accepted' && evidence ? { criticAttempt: readWritingCriticAttempts(evidence, { turnId: last.turnId, policyHash: policy.hash, candidateHash: criticCandidateHash }) } : {})
            }
          }
        }
      }
    }
    if (!pipelineHandled && last && last.role === 'assistant' && !last.toolCallsJson) {
      if (isLongWriteConfig(getConfig(runId))) {
        const segments = await getManuscriptSegments(runId, turns)
        const lastSegment = [...segments].reverse().find((segment) => segment.sourceTurnId === last.turnId)
        if (lastSegment?.status === 'accepted') {
          m.manuscriptResume = true
          pipelineHandled = true
        } else if (lastSegment?.status === 'candidate') {
          const strong = getConfig(runId).strongConstraints as StrongConstraintSnapshot | undefined
          let evidenceMatches = !strong?.enabled
          const sceneContext = sceneContractForRun(runId, getConfig(runId), turns)
          let sceneEvidence: Record<string, unknown> | null = null
          let sceneEvidenceMatches = true
          const qualityContext = narrativeQualityContextForRun(runId)
          const acceptedPrefixForQuality = await acceptedTextForRun(runId)
          let narrativeQualityEvidence: Record<string, unknown> | null = null
          let narrativeQualityEvaluation: NarrativeQualityEvaluation | null = null
          let narrativeQualityEvidenceValid = false
          if (strong?.enabled) {
            const raw = await store.getRunEvidence(runId, 'strong_constraint_latest')
            try {
              const evidence = raw ? JSON.parse(raw.json) as { status?: string; constraintHash?: string; draftHash?: string; latestSegmentHash?: string } : null
              const working = await workingTextForRun(runId)
              evidenceMatches = evidence?.status === 'passed' && evidence.constraintHash === strong.hash && evidence.draftHash === writingTextHash(working) && evidence.latestSegmentHash === writingTextHash(lastSegment.content)
            } catch {
              evidenceMatches = false
            }
          }
          const resolvedSceneContext = await sceneContext
          let sceneSemanticPending = false
          if (resolvedSceneContext) {
            try {
              const raw = await store.getRunEvidence(runId, `scene_contract_segment:${lastSegment.segmentId}:candidate`)
              sceneEvidence = raw ? JSON.parse(raw.json) as Record<string, unknown> : null
              sceneEvidenceMatches = sceneEvidence?.stage === 'candidate' && sceneEvidence.frozenHash === resolvedSceneContext.contract.frozenHash && sceneEvidence.candidateHash === createHash('sha256').update(lastSegment.content).digest('hex')
              const pendingRaw = await store.getRunEvidence(runId, `scene_semantic_pending_review:${lastSegment.segmentId}`)
              let pendingEvidence: Record<string, unknown> | null = null
              try { pendingEvidence = pendingRaw ? JSON.parse(pendingRaw.json) as Record<string, unknown> : null } catch { pendingEvidence = null }
              const semanticReasons = sceneEvidence
                ? sceneSemanticReviewReasons(sceneEvidence as unknown as ReturnType<typeof evaluateSceneContract>, resolvedSceneContext.contract)
                : []
              sceneSemanticPending = pendingEvidence?.status === 'pending_review' || semanticReasons.length > 0
            } catch {
              sceneEvidenceMatches = false
            }
          }
          try {
            const raw = await store.getRunEvidence(runId, `narrative_quality_segment:${lastSegment.segmentId}:candidate`)
            narrativeQualityEvidence = raw ? JSON.parse(raw.json) as Record<string, unknown> : null
            narrativeQualityEvaluation = narrativeQualityEvidence as NarrativeQualityEvaluation | null
            narrativeQualityEvidenceValid = narrativeQualityEvidence?.stage === 'candidate' && matchesNarrativeQualityEvidence({
              evaluation: narrativeQualityEvaluation,
              candidate: lastSegment.content,
              acceptedPrefix: acceptedPrefixForQuality,
              sceneContract: resolvedSceneContext?.contract,
              perspective: qualityContext.perspective,
              knownCharacterIds: qualityContext.knownCharacterIds
            })
          } catch {
            narrativeQualityEvidenceValid = false
          }
          if (resolvedSceneContext && sceneSemanticPending) {
            await patchRun(runId, {
              status: 'waiting_user',
              phase: 'paused',
              errorCode: 'narrative_state_pending_review',
              errorMessage: '场景语义证据未完成确认；已接受正文保持不变，恢复前不会继续调用 Provider'
            })
            pipelineHandled = true
          } else if (classifyAssistantOutput(lastSegment.content).complete && evidenceMatches && sceneEvidenceMatches && narrativeQualityEvidenceValid && sceneEvidence?.status !== 'deviated') {
            await acceptVerifiedProse(runId, {
              segmentId: lastSegment.segmentId,
              expectedContentHash: lastSegment.contentHash,
              expectedCharCount: lastSegment.charCount,
              evidenceRevision: lastSegment.revision,
              sceneId: resolvedSceneContext?.contract.sceneId ?? null
            })
            const acceptedSegment = (await getManuscriptSegments(runId)).find((segment) => segment.segmentId === lastSegment.segmentId && segment.status === 'accepted')
            if (acceptedSegment) await evaluateNarrativeSegment(runId, acceptedSegment, resolvedSceneContext?.contract, 'accepted', acceptedPrefixForQuality)
            if (resolvedSceneContext) {
              if (acceptedSegment) await evaluateSceneSegment(runId, resolvedSceneContext, acceptedSegment, 'accepted', true)
            }
            m.manuscriptResume = true
          } else if (narrativeQualityEvaluation?.status === 'blocked') {
            await saveSegment({ ...lastSegment, status: 'rejected', acceptedAt: undefined, updatedAt: now() })
            await store.appendTurn({ ...last, content: '' })
            await store.saveRunEvidence(runId, `narrative_quality_segment:${lastSegment.segmentId}:rejected`, JSON.stringify({
              ...narrativeQualityEvidence,
              stage: 'rejected',
              evaluatedAt: now()
            }))
            const canonical = await acceptedTextForRun(runId)
            emit(runId, { type: 'content_replace', content: canonical, revision: Number(narrativeQualityEvidence?.evaluatedAt ?? 1), contentHash: createHash('sha256').update(canonical).digest('hex') })
            const latestTurns = await store.getTurns(runId)
            const repairSeq = latestTurns.length ? Math.max(...latestTurns.map((turn) => turn.turnSeq)) + 1 : 1
            await store.appendTurn({ turnId: randomUUID(), runId, turnSeq: repairSeq, role: 'system', content: buildNarrativeQualityRepairInstruction(narrativeQualityEvaluation), createdAt: now() })
            m.nextTurnSeq = repairSeq + 1
            pipelineHandled = true
          } else if (resolvedSceneContext && sceneEvidence?.status === 'deviated') {
            await saveSegment({ ...lastSegment, status: 'rejected', acceptedAt: undefined, updatedAt: now() })
            await store.appendTurn({ ...last, content: '' })
            const canonical = await acceptedTextForRun(runId)
            emit(runId, { type: 'content_replace', content: canonical, revision: Number(sceneEvidence?.evaluatedAt ?? 1), contentHash: createHash('sha256').update(canonical).digest('hex') })
            const latestTurns = await store.getTurns(runId)
            const repairSeq = latestTurns.length ? Math.max(...latestTurns.map((turn) => turn.turnSeq)) + 1 : 1
            await store.appendTurn({ turnId: randomUUID(), runId, turnSeq: repairSeq, role: 'system', content: buildSceneContractRepairInstruction(resolvedSceneContext.contract, sceneEvidence as unknown as SceneContractEvaluation), createdAt: now() })
            m.nextTurnSeq = repairSeq + 1
            pipelineHandled = true
          } else {
            await patchRun(runId, {
              status: 'recovery_required',
              phase: 'recovery_required',
              errorCode: 'manuscript_acceptance_evidence_missing',
              errorMessage: '候选正文的完整句或验收证据在中断前没有提交，已停止自动接受'
            })
          }
          pipelineHandled = true
        } else if (lastSegment?.status === 'rejected') {
          pipelineHandled = true
        }
      }
      if (!pipelineHandled) {
        m.currentAssistant = { turnId: last.turnId, turnSeq: last.turnSeq }
        nextTurnSeq = last.turnSeq + 1
      }
    } else if (!pipelineHandled && last && last.role === 'assistant' && last.toolCallsJson) {
      let calls: { id: string }[] = []
      try {
        calls = JSON.parse(last.toolCallsJson) as { id: string }[]
      } catch {
        calls = []
      }
      const callIds = new Set(calls.map((c) => c.id))
      const toolTurnIds = new Set<string>()
      for (const t of turns) {
        if (t.role !== 'tool' || !t.toolResultJson) continue
        try {
          toolTurnIds.add((JSON.parse(t.toolResultJson) as { toolCallId: string }).toolCallId)
        } catch {
          continue
        }
      }
      for (const tc of toolCalls) {
        if (!callIds.has(tc.toolCallId) || tc.status !== 'completed' || toolTurnIds.has(tc.toolCallId)) continue
        const content = replayToolTurnOutput(tc)
        const toolTurn: TurnRecord = {
          turnId: randomUUID(),
          runId,
          turnSeq: nextTurnSeq++,
          role: 'tool',
          content,
          toolResultJson: JSON.stringify({ toolCallId: tc.toolCallId, content }),
          createdAt: now()
        }
        await store.appendTurn(toolTurn)
        emit(runId, { type: 'turn', turn: toolTurn })
      }
      // R4.1 S-04：恢复只还原状态，不自动重放工具——未确认（running/requested）的工具调用
      // 如实标记 side_effect_unknown（结果未知，禁止自动重跑非幂等副作用），等待用户决策
      for (const tc of toolCalls) {
        if (!callIds.has(tc.toolCallId)) continue
        if (tc.status === 'running' || tc.status === 'requested') {
          const marked: ToolCallRecord = { ...tc, status: 'side_effect_unknown', completedAt: now() }
          await store.upsertToolCall(marked)
        }
      }
    }
    m.nextTurnSeq = nextTurnSeq
    // R4.2 A4（S-03）：restore 只装载、不静默提升状态——recovery_required 保持 recovery_required，
    // 是否继续由用户显式决策（runs:resume 只领养展示；applyRecoveryDecision 后才 step）
    // R4.4 Gate 2（B-03）：恢复 completion controller（强杀于 validating/continuing 后重启，
    // revision/预算/单调性水位从 durable evaluation 恢复）
    const rawCc = (getConfig(runId).completionContract as CompletionContract | undefined) ?? null
    const cc = rawCc ? completionContractForRun(runId, rawCc) : null
    if (cc) {
      const ctrlOpts: CompletionControllerOpts = {
        contract: { ...cc, runId },
        store: {
          saveEvaluation: (r, ev) => void store.saveCompletionEvaluation(r, ev.revision, ev.state, JSON.stringify(ev)),
          getLatestEvaluation: (r) => {
            const l = store.getLatestCompletionEvaluation(r)
            return l ? (JSON.parse(l.json) as CompletionEvaluation) : null
          }
        }
      }
      const restoredController = CompletionController.fromStore(ctrlOpts, ctrlOpts.store.getLatestEvaluation(runId))
      // R4.4 Gate 5（S-03）：restore 后从 durable usage_log 恢复真实 token 成本（预算不因重启重置）
      const restoredTokens = await store.getUsageTotalTokens(runId)
      restoredController.setAccumulatedCost(restoredTokens)
      // 同步恢复引擎内存 usage 水位——后续轮次累加基于此（tryCompletionGate 的 usedTokens = mem.usage 累计）
      m.usage.inputTokens = restoredTokens
      m.usage.outputTokens = 0
      completionControllers.set(runId, restoredController)
    }
    if (m.run.status === 'waiting_user' && m.run.errorCode === 'narrative_state_pending_review') {
      const packet = await getNarrativeReview(runId)
      if (!packet) throw new Error('narrative_review_packet_corrupt:拒绝恢复审批')
      await restoreNarrativeReviewStoryFence(packet)
    }
  }

  const listRecoverable = async (): Promise<RunRecord[]> => {
    const actives = await store.listActiveRuns()
    const out: RunRecord[] = []
    for (const r of actives) {
      // R4.1 S-04：cancelling/cancel_requested 同为可恢复的 active runs——提升为 recoverable 供恢复入口列举
      // R4.5 Gate 4：waiting_user（完成校验暂停等用户决策）同样可从恢复入口 resume
      if (r.status === 'waiting_user' && (r.errorCode === 'narrative_state_pending_review' || r.errorCode === 'run_provider_call_cap')) {
        // Semantic review is an explicit user decision boundary. Keep the
        // durable waiting_user state instead of relabelling it recoverable;
        // the generic resume UI must not auto-step this run after restart.
        out.push(r)
      } else if (r.status === 'running' || r.status === 'queued' || r.status === 'cancelling' || r.status === 'cancel_requested' || r.status === 'waiting_user') {
        const updated: RunRecord = { ...r, status: 'recoverable', updatedAt: now() }
        await store.updateRun(r.runId, { status: 'recoverable' })
        onRunUpdate(updated)
        out.push(updated)
      } else if (r.status === 'recoverable' || r.status === 'recovery_required') {
        // R4.2 A4（S-03）：recovery_required 保持原状态，绝不静默提升为普通 recoverable
        out.push(r)
      }
    }
    return out
  }

  const listActive = (): RunRecord[] =>
    [...mem.values()].map((m) => m.run).filter((r) => !isTerminal(r.status))

  const getState = async (runId: string): Promise<{ run: RunRecord | null; turns: TurnRecord[]; toolCalls: ToolCallRecord[] }> => {
    const run = await store.getRun(runId)
    if (!run) return { run: null, turns: [], toolCalls: [] }
    const [turns, toolCalls] = await Promise.all([store.getTurns(runId), store.getToolCalls(runId)])
    return { run, turns, toolCalls }
  }

  const abortSignal = (runId: string): AbortSignal | undefined => mem.get(runId)?.controller.signal

  // ---- R4.2 A4：recovery decision gate（S-03） ----

  const recoverInfo = async (runId: string): Promise<{ run: RunRecord | null; pendingToolCalls: ToolCallRecord[]; decisions: RecoveryDecisionRecord[] }> => {
    const run = await store.getRun(runId)
    if (!run) return { run: null, pendingToolCalls: [], decisions: [] }
    const toolCalls = await store.getToolCalls(runId)
    const decisions = await store.getRecoveryDecisions(runId)
    return {
      run,
      pendingToolCalls: toolCalls.filter((tc) => tc.status === 'side_effect_unknown'),
      decisions
    }
  }

  /** 决策处理后的工具结果 turn（模型可见：副作用已确认发生 / 重试结果） */
  const appendToolResultTurn = async (runId: string, tc: ToolCallRecord, content: string): Promise<void> => {
    let m = mem.get(runId)
    let nextSeq = 1
    if (m) {
      nextSeq = m.nextTurnSeq
      m.nextTurnSeq += 1
    } else {
      const turns = await store.getTurns(runId)
      nextSeq = turns.length ? Math.max(...turns.map((t) => t.turnSeq)) + 1 : 1
    }
    const toolTurn: TurnRecord = {
      turnId: randomUUID(),
      runId,
      turnSeq: nextSeq,
      role: 'tool',
      content,
      toolResultJson: JSON.stringify({ toolCallId: tc.toolCallId, content }),
      createdAt: now()
    }
    await store.appendTurn(toolTurn)
    emit(runId, { type: 'turn', turn: toolTurn })
  }

  /** 重新执行工具（retry_not_applied / rollback_then_retry 共用）；失败返回错误串 */
  const reExecuteTool = async (runId: string, tc: ToolCallRecord): Promise<string | null> => {
    let result: string, resultJson: string
    try {
      const savedBudget = await store.getRunEvidence(runId, `tool_read_budget:${tc.turnId}`)
      let readBudgetChars: number | undefined
      if (savedBudget) {
        try {
          const budget = JSON.parse(savedBudget.json)
          readBudgetChars = budget.schemaVersion === 1 && budget.turnId === tc.turnId && Number.isSafeInteger(budget.readBudgetChars) && budget.readBudgetChars >= 0 ? budget.readBudgetChars : 0
        } catch { readBudgetChars = 0 }
      }
      const raw = await executeBudgetedTool(tc.name, tc.argsJson, tc.toolCallId, runId, readBudgetChars)
      // R4.2 A5 补充：恢复重试的大输出同样落 artifact + 摘要（与首次执行一致）
      const output = await prepareToolTurnOutput(tc.name, raw, text => spillToolResult(runId, tc, text))
      result = output.content
      resultJson = output.resultJson
    } catch (e) {
      const error = errMsg(e)
      const failed: ToolCallRecord = { ...tc, status: 'failed', resultJson: JSON.stringify({ error }), completedAt: now() }
      await store.upsertToolCall(failed)
      emit(runId, { type: 'tool', toolCall: failed })
      await appendToolResultTurn(runId, tc, error)
      return error
    }
    const parsed = ((): { ok?: boolean } => {
      try {
        return JSON.parse(result) as { ok?: boolean }
      } catch {
        return {}
      }
    })()
    const status: ToolCallRecord['status'] = parsed.ok === false ? 'failed' : 'completed'
    const completed = { ...tc, status, resultJson, completedAt: now() }
    await store.upsertToolCall(completed)
    emit(runId, { type: 'tool', toolCall: completed })
    await appendToolResultTurn(runId, tc, result)
    return null
  }

  const reviewCompletionDecision = (packet: NarrativeSemanticReviewPacket, candidate: ManuscriptSegment): SceneCompletionDecision => {
    const requiredBeatIds = [...packet.completionDecision.requiredBeatIds]
    const beatEvidence = (packet.completionDecision.beatEvidence ?? []).map((item) => ({ ...item, status: 'satisfied' as const }))
    const base: SceneCompletionDecision = {
      ...packet.completionDecision,
      decisionId: `${packet.contract.sceneId}:${candidate.segmentId}:review:${packet.revision + 1}`,
      candidateSegmentId: candidate.segmentId,
      candidateHash: candidate.contentHash,
      candidateCharCount: candidate.charCount,
      status: 'complete',
      requiredBeatIds,
      satisfiedBeatIds: requiredBeatIds,
      missingBeatIds: [],
      decidedAt: now(),
      beatEvidence
    }
    const { evidenceHash: _ignored, ...withoutHash } = base
    return {
      ...base,
      evidenceHash: createHash('sha256').update(JSON.stringify(withoutHash), 'utf8').digest('hex')
    }
  }

  const rewriteBudgetAvailable = async (runId: string): Promise<boolean> => {
    const run = await store.getRun(runId)
    if (!run) return false
    try {
      const state = runBudgets.get(runId) ?? await loadRunBudget(runId, getConfig(runId), run.startedAt)
      const refreshed = await withRunBudgetLock(runId, async () => reconcileRunBudgetUnlocked(runId))
      const tokens = tokenConsumedUpper(refreshed) + tokenReservedUpper(refreshed)
      if (refreshed.limits.maxCalls !== null && refreshed.totalCalls >= refreshed.limits.maxCalls) return false
      if (refreshed.tokenReservationCorrupt) return false
      if (refreshed.limits.maxTokens !== null && tokens >= refreshed.limits.maxTokens) return false
      if (refreshed.limits.maxCost !== null && (refreshed.unknownCostCalls > 0 || refreshed.costReservationCorrupt)) return false
      if (refreshed.limits.maxCost !== null && refreshed.limits.maxCost.amount > 0 && refreshed.spentCostUpper >= refreshed.limits.maxCost.amount) return false
      return refreshed.limits.maxWallClockMs === null || now() - refreshed.startedAt < refreshed.limits.maxWallClockMs
    } catch {
      return false
    }
  }

  const finishNarrativeReview = async (packet: NarrativeSemanticReviewPacket, record: NarrativeSemanticReviewDecisionRecord, status: NarrativeSemanticReviewStatusResult): Promise<NarrativeSemanticReviewPacket> => {
    const { packetHash: _oldPacketHash, pendingOperation: _oldPendingOperation, effectiveAllowedDecisions: _effectiveAllowedDecisions, ...packetWithoutHash } = packet
    const withoutHash: Omit<NarrativeSemanticReviewPacket, 'packetHash'> = {
      ...packetWithoutHash,
      status,
      revision: record.revision,
      allowedDecisions: reviewDecisionCapabilities({
        reason: packet.reason,
        status,
        missingBeatIds: packet.missingBeatIds,
        contract: packet.contract,
        reasons: packet.reasons
      }),
      // Once the decision payload is claimed, carry the durable operation in
      // the final packet and bind it into packetHash.  The next restart can
      // therefore validate the operation against both the claim and decision
      // records instead of trusting an arbitrary packet field.
      pendingOperation: {
        operationId: record.decisionId,
        decisionId: record.decisionId,
        expectedRevision: record.expectedRevision,
        canonicalPayloadHash: record.canonicalPayloadHash,
        durable: true
      },
      decision: record
    }
    const finalPacket: NarrativeSemanticReviewPacket = { ...withoutHash, packetHash: reviewPacketHash(withoutHash) }
    await persistNarrativeReviewPacket(finalPacket)
    // Keep an immutable decision record and revision snapshot in addition to
    // the latest packet.  The generic packet is convenient for restart/UI,
    // while these keyed records make the actor/revision/hash chain auditable
    // even after a later review packet is created for another candidate.
    const decisionWritten = await saveNarrativeReviewEvidenceIfAbsent(packet.runId, `narrative_semantic_review_decision:${record.decisionId}`, JSON.stringify(record))
    if (!decisionWritten) throw new Error('narrative_review_decision_id_conflict')
    const revisionWritten = await saveNarrativeReviewEvidenceIfAbsent(packet.runId, `narrative_semantic_review:revision:${record.revision}`, JSON.stringify(finalPacket))
    if (!revisionWritten) throw new Error('narrative_review_revision_conflict')
    return finalPacket
  }

  const clearRunError = async (runId: string): Promise<void> => {
    // RunStorePort's optional error fields intentionally omit undefined
    // patches; null is the durable SQL clear operation used by the adapter.
    await store.updateRun(runId, { errorCode: null as unknown as string, errorMessage: null as unknown as string })
    const m = mem.get(runId)
    if (m) {
      delete m.run.errorCode
      delete m.run.errorMessage
    }
  }

  const narrativeReviewResult = async (runId: string, status: NarrativeSemanticReviewStatusResult): Promise<NarrativeSemanticReviewDecisionResult> => {
    const run = await store.getRun(runId)
    if (!run) throw new Error('运行在复核决策完成前消失')
    const terminal = isTerminal(run.status)
    return {
      ok: true,
      status,
      decisionStatus: status,
      runStatus: run.status,
      phase: run.phase,
      terminal,
      needsStep: run.status === 'running' && !terminal
    }
  }

  /** Use a database INSERT ... DO NOTHING when the production repository is
   * present.  The read-before-write fallback keeps lightweight test stores
   * compatible while production still gets a real CAS at the SQLite boundary. */
  const saveNarrativeReviewEvidenceIfAbsent = async (runId: string, kind: string, json: string): Promise<boolean> => {
    if (store.saveRunEvidenceIfAbsent) return store.saveRunEvidenceIfAbsent(runId, kind, json)
    if (await store.getRunEvidence(runId, kind)) return false
    await store.saveRunEvidence(runId, kind, json)
    return true
  }

  const ensureNarrativeReviewRevisionEvidence = async (packet: NarrativeSemanticReviewPacket): Promise<void> => {
    const revision = packet.decision?.revision
    if (!packet.decision || typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) throw new Error('narrative_review_revision_missing')
    const kind = `narrative_semantic_review:revision:${revision}`
    const expected = JSON.stringify(packet)
    const existing = await store.getRunEvidence(packet.runId, kind)
    if (existing) {
      let parsed: Partial<NarrativeSemanticReviewPacket>
      try { parsed = JSON.parse(existing.json) as Partial<NarrativeSemanticReviewPacket> } catch { throw new Error('narrative_review_revision_corrupt') }
      if (parsed.packetHash !== packet.packetHash || parsed.runId !== packet.runId || parsed.revision !== packet.revision || parsed.decision?.decisionId !== packet.decision.decisionId) throw new Error('narrative_review_revision_conflict')
      return
    }
    if (!await saveNarrativeReviewEvidenceIfAbsent(packet.runId, kind, expected)) {
      const after = await store.getRunEvidence(packet.runId, kind)
      if (!after) throw new Error('narrative_review_revision_missing_after_retry')
      let parsed: Partial<NarrativeSemanticReviewPacket>
      try { parsed = JSON.parse(after.json) as Partial<NarrativeSemanticReviewPacket> } catch { throw new Error('narrative_review_revision_corrupt') }
      if (parsed.packetHash !== packet.packetHash || parsed.runId !== packet.runId || parsed.revision !== packet.revision || parsed.decision?.decisionId !== packet.decision.decisionId) throw new Error('narrative_review_revision_conflict')
    }
  }

  /** Validate registry-backed knowledge edges before claiming the review
   * revision.  Repository commitScene repeats these checks inside its
   * transaction, but doing the same fail-closed preflight here prevents an
   * invalid manual delta from consuming the only revision claim and blocking
   * a later valid delta/rewrite/abandon decision. */
  const validateManualNarrativeDelta = async (runId: string, stateDelta: NarrativeStateDelta): Promise<string | null> => {
    const knowledgeChanges = stateDelta.changes.filter((change) => change.kind === 'knowledge')
    if (knowledgeChanges.length === 0) return null
    const registryStore = store as RunStorePort & { getNarrativeFacts?: (sessionId: string, includeInactive?: boolean) => Promise<NarrativeFact[]> }
    if (typeof registryStore.getNarrativeFacts !== 'function') return 'narrative_knowledge_fact_registry_unavailable'
    const run = await store.getRun(runId)
    const sessionId = run?.sessionId
    if (!sessionId) return 'narrative_knowledge_fact_registry_missing'
    let facts: NarrativeFact[]
    try {
      facts = await registryStore.getNarrativeFacts(sessionId, false)
    } catch {
      return 'narrative_knowledge_fact_registry_unavailable'
    }
    for (const change of knowledgeChanges) {
      if (change.kind !== 'knowledge') continue
      const fact = facts.find((item) => item.factId === change.factId && item.version === (change.factRef?.version ?? item.version))
      if (!fact) return 'narrative_knowledge_fact_registry_missing'
      if (!change.factRef || fact.status !== 'active' || !factReferenceMatches(fact, change.factRef)) return 'narrative_knowledge_fact_reference_mismatch'
    }
    return null
  }

  const reviewDecisionStatus = (decision: NarrativeSemanticReviewDecision): NarrativeSemanticReviewStatusResult => {
    if (decision === 'accept_delta') return 'accepted'
    if (decision === 'accept_unknown') return 'unknown_accepted'
    if (decision === 'accept_prose_no_state') return 'accepted'
    if (decision === 'reject_rewrite') return 'rewrite_requested'
    return 'abandoned'
  }

  /**
   * A scene commit and the review packet are intentionally separate durable
   * stores.  If the process dies after commitScene but before the final
   * packet, the candidate is no longer a candidate and the ordinary decision
   * path must not reject the retry.  This reconciler only accepts an exact
   * content-addressed match: the completion evidence carries the claimed
   * decision, while the committed scene/segment/ledger rows provide the
   * independent post-commit proof.  It never invents a delta or repairs a
   * mismatched decision.
   */
  const reconcileNarrativeReviewAfterCommit = async (input: {
    runId: string
    packet: NarrativeSemanticReviewPacket
    decisionId: string
    decision: NarrativeSemanticReviewDecision
    expectedRevision: number
    delta?: NarrativeStateDelta | null
    note?: string
  }): Promise<NarrativeSemanticReviewDecisionRecord | null> => {
    if (input.decision === 'reject_rewrite' || input.decision === 'abandon') return null
    const completionEvidence = await store.getRunEvidence(input.runId, `scene_completion_decision:${input.packet.candidate.segmentId}`)
    if (!completionEvidence) return null
    let evidence: Record<string, unknown>
    try { evidence = JSON.parse(completionEvidence.json) as Record<string, unknown> } catch { return null }
    const rawRecord = evidence.semanticReviewDecision
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) return null
    const record = rawRecord as NarrativeSemanticReviewDecisionRecord
    if (record.runId !== input.runId || record.decisionId !== input.decisionId || record.decision !== input.decision ||
      record.expectedRevision !== input.expectedRevision || record.revision !== input.expectedRevision + 1 ||
      record.packetHash !== input.packet.packetHash || record.candidateHash !== input.packet.candidate.contentHash ||
      record.contractHash !== input.packet.contractHash || evidence.runId !== input.runId ||
      evidence.sceneId !== input.packet.sceneId || evidence.contractHash !== input.packet.contractHash ||
      evidence.candidateSegmentId !== input.packet.candidate.segmentId || evidence.candidateHash !== input.packet.candidate.contentHash ||
      evidence.stateDeltaHash !== record.deltaHash ||
      (input.note !== undefined && input.note !== record.note)) return null
    try {
      const { decisionHash, ...recordBody } = record
      if (typeof decisionHash !== 'string' || createHash('sha256').update(stableNarrativeJson(recordBody), 'utf8').digest('hex') !== decisionHash) return null
    } catch { return null }
    if (typeof record.canonicalPayloadHash !== 'string' || record.canonicalPayloadHash !== narrativeReviewDecisionPayloadHash({
      runId: input.runId,
      sceneId: input.packet.sceneId,
      contractId: input.packet.contractId,
      contractHash: input.packet.contractHash,
      packetHash: input.packet.packetHash,
      expectedRevision: input.expectedRevision,
      revision: input.expectedRevision + 1,
      candidateSegmentId: input.packet.candidate.segmentId,
      candidateHash: input.packet.candidate.contentHash,
      candidateCharCount: input.packet.candidate.charCount,
      decisionId: input.decisionId,
      decision: input.decision,
      deltaHash: record.deltaHash ?? null,
      note: record.note ?? ''
    })) return null
    if (input.decision === 'accept_delta') {
      if (!input.delta) return null
      try {
        const supplied = normalizeNarrativeStateDelta(input.delta)
        if (supplied.deltaHash !== record.deltaHash || supplied.runId !== input.runId || supplied.sceneId !== input.packet.sceneId ||
          supplied.acceptedSegmentId !== input.packet.candidate.segmentId || supplied.acceptedContentHash !== input.packet.candidate.contentHash ||
          supplied.contractHash !== input.packet.contractHash) return null
      } catch { return null }
    } else if (input.delta !== undefined && input.delta !== null) {
      return null
    }
    const segments = await getManuscriptSegments(input.runId)
    const candidate = segments.find((segment) => segment.segmentId === input.packet.candidate.segmentId)
    if (!candidate || candidate.kind !== 'prose' || candidate.status !== 'accepted' || candidate.contentHash !== input.packet.candidate.contentHash || candidate.charCount !== input.packet.candidate.charCount) return null
    const states = store.getSceneStates ? await store.getSceneStates(input.runId) : []
    const state = states.find((item) => item.sceneId === input.packet.sceneId)
    if (!state || state.lifecycle !== 'committed' || state.candidateSegmentId !== candidate.segmentId || state.candidateHash !== candidate.contentHash ||
      state.acceptedSegmentId !== candidate.segmentId || state.acceptedHash !== candidate.contentHash || state.contractHash !== input.packet.contractHash) return null
    if (store.getNarrativeCommits) {
      const commits = await store.getNarrativeCommits(input.runId, input.packet.sceneId)
      const commit = commits.find((item) => item.sceneId === input.packet.sceneId && item.acceptedSegmentId === candidate.segmentId && item.acceptedContentHash === candidate.contentHash)
      if (!commit || commit.contractHash !== input.packet.contractHash || commit.deltaHash !== record.deltaHash) return null
    }
    if (typeof record.deltaHash !== 'string') return null
    await assertNarrativeReviewOwnCommitFence(input.packet, record.deltaHash)
    return record
  }

  const recoverNarrativeReviewFromDurableState = async (packet: NarrativeSemanticReviewPacket): Promise<NarrativeSemanticReviewPacket | null> => {
    if (packet.status !== 'pending_review') return null
    const claimEvidence = await store.getRunEvidence(packet.runId, `narrative_semantic_review:claim:${packet.revision}`)
    const completionEvidence = await store.getRunEvidence(packet.runId, `scene_completion_decision:${packet.candidate.segmentId}`)
    if (!claimEvidence || !completionEvidence) return null
    let claim: NarrativeReviewClaimRecord
    let evidence: Record<string, unknown>
    try {
      claim = JSON.parse(claimEvidence.json) as NarrativeReviewClaimRecord
      evidence = JSON.parse(completionEvidence.json) as Record<string, unknown>
    } catch {
      return null
    }
    const rawRecord = evidence.semanticReviewDecision
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) return null
    const record = rawRecord as Partial<NarrativeSemanticReviewDecisionRecord>
    const canonicalPayloadHash = typeof claim.canonicalPayloadHash === 'string' ? claim.canonicalPayloadHash : claim.payloadHash
    const operationId = claim.operationId ?? claim.decisionId
    if (claim.schemaVersion !== 2 || claim.runId !== packet.runId || claim.expectedRevision !== packet.revision || claim.packetHash !== packet.packetHash || typeof operationId !== 'string' || operationId.length === 0 || operationId !== record.decisionId || claim.decisionId !== record.decisionId || claim.decision !== record.decision || typeof canonicalPayloadHash !== 'string' || !/^[0-9a-f]{64}$/u.test(canonicalPayloadHash)) return null
    if (record.runId !== packet.runId || record.expectedRevision !== packet.revision || record.revision !== packet.revision + 1 || record.packetHash !== packet.packetHash || record.candidateHash !== packet.candidate.contentHash || record.contractHash !== packet.contractHash || typeof record.decision !== 'string' || !narrativeReviewDecisionNames.includes(record.decision as NarrativeSemanticReviewDecision) || typeof record.canonicalPayloadHash !== 'string') return null
    const expectedPayloadHash = narrativeReviewDecisionPayloadHash({
      runId: packet.runId,
      sceneId: packet.sceneId,
      contractId: packet.contractId,
      contractHash: packet.contractHash,
      packetHash: packet.packetHash,
      expectedRevision: packet.revision,
      revision: record.revision,
      candidateSegmentId: packet.candidate.segmentId,
      candidateHash: packet.candidate.contentHash,
      candidateCharCount: packet.candidate.charCount,
      decisionId: record.decisionId,
      decision: record.decision as NarrativeSemanticReviewDecision,
      deltaHash: record.deltaHash ?? null,
      note: record.note ?? ''
    })
    if (record.canonicalPayloadHash !== expectedPayloadHash || canonicalPayloadHash !== expectedPayloadHash) return null
    if (evidence.runId !== packet.runId || evidence.sceneId !== packet.sceneId || evidence.contractHash !== packet.contractHash || evidence.candidateSegmentId !== packet.candidate.segmentId || evidence.candidateHash !== packet.candidate.contentHash || evidence.stateDeltaHash !== (record.deltaHash ?? null)) return null
    if (record.decision === 'reject_rewrite' || record.decision === 'abandon') return null
    if (!store.getNarrativeCommits) return null
    const commits = await store.getNarrativeCommits(packet.runId, packet.sceneId)
    const commit = commits.find((item) => item.sceneId === packet.sceneId && item.acceptedSegmentId === packet.candidate.segmentId && item.acceptedContentHash === packet.candidate.contentHash && item.contractHash === packet.contractHash)
    if (!commit || commit.deltaHash !== record.deltaHash) return null
    const recovered = await reconcileNarrativeReviewAfterCommit({
      runId: packet.runId,
      packet,
      decisionId: record.decisionId,
      decision: record.decision as NarrativeSemanticReviewDecision,
      expectedRevision: packet.revision,
      ...(record.decision === 'accept_delta' ? { delta: commit.stateDelta } : {}),
      note: record.note ?? ''
    })
    if (!recovered) return null
    const status = reviewDecisionStatus(record.decision as NarrativeSemanticReviewDecision)
    const finalPacket = await finishNarrativeReview(packet, recovered, status)
    try {
      await completeAcceptedNarrativeReview(packet.runId, status)
    } catch {
      /* The final packet remains the durable recovery boundary; a later resume can retry lifecycle completion. */
    }
    return finalPacket
  }
  recoverNarrativeReview = recoverNarrativeReviewFromDurableState

  const completeAcceptedNarrativeReview = async (runId: string, status: NarrativeSemanticReviewStatusResult): Promise<NarrativeSemanticReviewDecisionResult> => {
    const current = await store.getRun(runId)
    if (current && !isTerminal(current.status) && !mem.has(runId)) await restore(runId)
    await clearRunError(runId)
    const config = getConfig(runId)
    const committedStates = await ensureScenePlan(runId, config.sceneContracts as SceneContractPlan)
    const allScenesCommitted = committedStates.length > 0 && committedStates.every((item) => item.lifecycle === 'committed')
    if (allScenesCommitted) {
      const completionContract = config.completionContract as CompletionContract | undefined
      if (!completionContract) {
        await finalizeCompleted(runId)
        return narrativeReviewResult(runId, status)
      }
      const gate = await tryCompletionGate(runId, completionContract)
      if (gate === true) {
        await finalizeCompleted(runId)
        return narrativeReviewResult(runId, status)
      }
      if (gate === 'paused') {
        const latest = store.getLatestCompletionEvaluation(runId)
        let reason = 'paused'
        let message = '完成校验已暂停，请调整预算或目标后重新发起，或停止此任务'
        try {
          const evaluation = latest ? JSON.parse(latest.json) as CompletionEvaluation : null
          reason = evaluation?.blockedReason ?? reason
          message = evaluation?.pausedMessage ?? message
        } catch { /* keep safe defaults */ }
        await patchRun(runId, { status: 'waiting_user', phase: 'paused', errorCode: `completion_${reason}`, errorMessage: message })
        return narrativeReviewResult(runId, status)
      }
      if (gate === 'blocked') {
        await finalize(runId, 'failed', { errorCode: 'completion_blocked', errorMessage: '完成校验阻塞（无进展/达上限/预算耗尽），请人工介入' })
        return narrativeReviewResult(runId, status)
      }
    }
    await patchRun(runId, { status: 'running', phase: 'thinking' })
    return narrativeReviewResult(runId, status)
  }

  const reviewDecisionInputMatches = (input: NarrativeSemanticReviewDecisionInput, record: Partial<NarrativeSemanticReviewDecisionRecord>, packet: NarrativeSemanticReviewPacket, requirePacketHash: boolean, decisionIdOverride?: string): boolean => {
    const decisionId = decisionIdOverride ?? input.decisionId ?? packet.pendingOperation?.decisionId ?? packet.decision?.decisionId ?? ''
    if (record.runId !== input.runId || record.decision !== input.decision || record.expectedRevision !== input.expectedRevision ||
      record.revision !== input.expectedRevision + 1 || record.candidateHash !== packet.candidate.contentHash || record.contractHash !== packet.contractHash ||
      record.decisionId !== decisionId || (requirePacketHash && record.packetHash !== packet.packetHash) || (input.note !== undefined && record.note !== input.note) || typeof record.canonicalPayloadHash !== 'string') return false
    let effectiveDeltaHash = record.deltaHash ?? null
    if (input.decision === 'accept_delta') {
      if (!input.delta || typeof record.deltaHash !== 'string') return false
      try {
        const delta = normalizeNarrativeStateDelta(input.delta)
        if (delta.deltaHash !== record.deltaHash || delta.runId !== input.runId || delta.sceneId !== packet.sceneId ||
          delta.acceptedSegmentId !== packet.candidate.segmentId || delta.acceptedContentHash !== packet.candidate.contentHash || delta.contractHash !== packet.contractHash) return false
        effectiveDeltaHash = delta.deltaHash
      } catch { return false }
    } else if (input.delta !== undefined && input.delta !== null) {
      return false
    }
    const packetHash = requirePacketHash ? packet.packetHash : record.packetHash
    if (typeof packetHash !== 'string') return false
    return record.canonicalPayloadHash === narrativeReviewDecisionPayloadHash({
      runId: input.runId,
      sceneId: packet.sceneId,
      contractId: packet.contractId,
      contractHash: packet.contractHash,
      packetHash,
      expectedRevision: input.expectedRevision,
      revision: input.expectedRevision + 1,
      candidateSegmentId: packet.candidate.segmentId,
      candidateHash: packet.candidate.contentHash,
      candidateCharCount: packet.candidate.charCount,
      decisionId,
      decision: input.decision,
      deltaHash: effectiveDeltaHash,
      note: input.note ?? ''
    })
  }

  const reviewConflict = (message = '复核决策冲突：该版本已由另一操作处理，请重新打开复核证据'): { ok: false; error: string } => ({ ok: false, error: `narrative_review_conflict:${message}` })

  const applyNarrativeReviewDecision = async (
    input: NarrativeSemanticReviewDecisionInput,
    opts: { actor?: string } = {}
  ): Promise<NarrativeSemanticReviewDecisionResult | { ok: false; error: string }> => withNarrativeReviewLock(input.runId, async () => {
    const run = await store.getRun(input.runId)
    if (!run) return { ok: false, error: '运行不存在' }
    const packet = await getNarrativeReview(input.runId)
    if (!packet) return { ok: false, error: '待复核证据不存在或已损坏' }
    // The main process allocates and persists the operation identity.  The
    // engine must never manufacture a new id: doing so turns a retry after a
    // partial write into a different operation and defeats idempotency.
    const decisionId = input.decisionId
    if (!decisionId || decisionId.length > 128) return { ok: false, error: '复核决策 id 无效' }
    const decisionEvidence = await store.getRunEvidence(input.runId, `narrative_semantic_review_decision:${decisionId}`)
    if (decisionEvidence) {
      try {
        const prior = JSON.parse(decisionEvidence.json) as Partial<NarrativeSemanticReviewDecisionRecord>
        const packetStillRepresentsDecision = packet.decision?.decisionId === decisionId
        if (!reviewDecisionInputMatches(input, prior, packet, !packetStillRepresentsDecision, decisionId)) return reviewConflict('decisionId 已用于另一份复核操作')
        if (packet.status === 'pending_review' && (input.decision === 'accept_delta' || input.decision === 'accept_unknown' || input.decision === 'accept_prose_no_state')) {
          const recovered = await reconcileNarrativeReviewAfterCommit({ runId: input.runId, packet, decisionId, decision: input.decision, expectedRevision: input.expectedRevision, delta: input.delta, note: input.note })
          if (recovered) {
            await finishNarrativeReview(packet, recovered, reviewDecisionStatus(input.decision))
            return completeAcceptedNarrativeReview(input.runId, reviewDecisionStatus(input.decision))
          }
        }
        if (packet.status !== 'pending_review' && (input.decision === 'accept_delta' || input.decision === 'accept_unknown' || input.decision === 'accept_prose_no_state')) {
          await ensureNarrativeReviewRevisionEvidence(packet)
          return completeAcceptedNarrativeReview(input.runId, reviewDecisionStatus(input.decision))
        }
        return narrativeReviewResult(input.runId, reviewDecisionStatus(input.decision))
      } catch {
        return reviewConflict('decisionId 证据损坏，拒绝覆盖')
      }
    }
    // A process can die after the immutable revision claim (or after the
    // final packet is written) but before the decision evidence write.  A
    // matching claim/final packet is an idempotent retry of the same logical
    // operation; a mismatch is always a conflict and must never be adopted.
    const finalDecision = packet.decision
    if (packet.status !== 'pending_review' && finalDecision?.decisionId === decisionId) {
      if (!reviewDecisionInputMatches(input, finalDecision, packet, false, decisionId)) return reviewConflict('decisionId 的最终证据与当前请求不一致')
      await saveNarrativeReviewEvidenceIfAbsent(input.runId, `narrative_semantic_review_decision:${decisionId}`, JSON.stringify(finalDecision))
      await ensureNarrativeReviewRevisionEvidence(packet)
      return (input.decision === 'accept_delta' || input.decision === 'accept_unknown' || input.decision === 'accept_prose_no_state')
        ? completeAcceptedNarrativeReview(input.runId, packet.status as NarrativeSemanticReviewStatusResult)
        : narrativeReviewResult(input.runId, packet.status as NarrativeSemanticReviewStatusResult)
    }
    const claimEvidence = await store.getRunEvidence(input.runId, `narrative_semantic_review:claim:${input.expectedRevision}`)
    let matchingClaim = false
    let claim: NarrativeReviewClaimRecord | null = null
    if (claimEvidence) {
      try {
        claim = JSON.parse(claimEvidence.json) as NarrativeReviewClaimRecord
        if (claim.schemaVersion !== 2 || claim.runId !== input.runId || claim.expectedRevision !== input.expectedRevision || claim.packetHash !== packet.packetHash || (claim.operationId ?? claim.decisionId) !== decisionId || claim.decisionId !== decisionId || claim.decision !== input.decision) return reviewConflict('revision claim 已被另一复核操作占用')
      } catch {
        return reviewConflict('revision claim 证据损坏，拒绝覆盖')
      }
    }
    if (packet.status !== 'pending_review' || run.status !== 'waiting_user' || run.errorCode !== 'narrative_state_pending_review') return reviewConflict()
    if (packet.revision !== input.expectedRevision) return reviewConflict('复核证据 revision 已变化，请重新打开后再决定')
    const recovered = await reconcileNarrativeReviewAfterCommit({ runId: input.runId, packet, decisionId, decision: input.decision, expectedRevision: input.expectedRevision, delta: input.delta, note: input.note })
    if (recovered) {
      await finishNarrativeReview(packet, recovered, reviewDecisionStatus(input.decision))
      return completeAcceptedNarrativeReview(input.runId, reviewDecisionStatus(input.decision))
    }
    const candidate = (await getManuscriptSegments(input.runId)).find((segment) => segment.segmentId === packet.candidate.segmentId)
    if (!candidate || candidate.status !== 'candidate' || candidate.contentHash !== packet.candidate.contentHash || candidate.charCount !== packet.candidate.charCount) return { ok: false, error: '候选正文已变化，无法安全复核' }
    const actor = opts.actor ?? 'user'
    const ts = now()
    const baseRecord = (deltaHash: string | null): Omit<NarrativeSemanticReviewDecisionRecord, 'decisionHash'> => ({
      decisionId,
      runId: input.runId,
      decision: input.decision,
      actor,
      expectedRevision: input.expectedRevision,
      revision: input.expectedRevision + 1,
      packetHash: packet.packetHash,
      candidateHash: candidate.contentHash,
      contractHash: packet.contractHash,
      deltaHash,
      note: input.note ?? '',
      canonicalPayloadHash: narrativeReviewDecisionPayloadHash({
        runId: input.runId,
        sceneId: packet.sceneId,
        contractId: packet.contractId,
        contractHash: packet.contractHash,
        packetHash: packet.packetHash,
        expectedRevision: input.expectedRevision,
        revision: input.expectedRevision + 1,
        candidateSegmentId: candidate.segmentId,
        candidateHash: candidate.contentHash,
        candidateCharCount: candidate.charCount,
        decisionId,
        decision: input.decision,
        deltaHash,
        note: input.note ?? ''
      }),
      createdAt: ts
    })
    const recordFor = (deltaHash: string | null): NarrativeSemanticReviewDecisionRecord => {
      const base = baseRecord(deltaHash)
      return { ...base, decisionHash: createHash('sha256').update(stableNarrativeJson(base), 'utf8').digest('hex') }
    }
    let claimPayloadHash: string | null = null
    const claimRevision = async (): Promise<boolean> => {
      if (!claimPayloadHash) return false
      if (claim) {
        const existingHash = typeof claim.canonicalPayloadHash === 'string' ? claim.canonicalPayloadHash : claim.payloadHash
        matchingClaim = claim.schemaVersion === 2 && claim.runId === input.runId && claim.expectedRevision === input.expectedRevision && claim.packetHash === packet.packetHash && (claim.operationId ?? claim.decisionId) === decisionId && claim.decisionId === decisionId && claim.decision === input.decision && existingHash === claimPayloadHash
        return matchingClaim
      }
      const wrote = await saveNarrativeReviewEvidenceIfAbsent(
        input.runId,
        `narrative_semantic_review:claim:${input.expectedRevision}`,
        JSON.stringify({ schemaVersion: 2, runId: input.runId, expectedRevision: input.expectedRevision, revision: input.expectedRevision + 1, packetHash: packet.packetHash, operationId: decisionId, decisionId, decision: input.decision, canonicalPayloadHash: claimPayloadHash, payloadHash: claimPayloadHash, claimedAt: ts })
      )
      if (wrote) return true
      const raced = await store.getRunEvidence(input.runId, `narrative_semantic_review:claim:${input.expectedRevision}`)
      if (!raced) return false
      try {
        const parsed = JSON.parse(raced.json) as NarrativeReviewClaimRecord
        const existingHash = typeof parsed.canonicalPayloadHash === 'string' ? parsed.canonicalPayloadHash : parsed.payloadHash
        return parsed.schemaVersion === 2 && parsed.runId === input.runId && parsed.expectedRevision === input.expectedRevision && parsed.packetHash === packet.packetHash && (parsed.operationId ?? parsed.decisionId) === decisionId && parsed.decisionId === decisionId && parsed.decision === input.decision && existingHash === claimPayloadHash
      } catch {
        return false
      }
    }

    if (input.decision === 'abandon') {
      const record = recordFor(null)
      claimPayloadHash = record.canonicalPayloadHash
      if (!(await claimRevision())) return reviewConflict()
      await finishNarrativeReview(packet, record, 'abandoned')
      const m = mem.get(input.runId)
      if (m) m.done = true
      await store.updateRun(input.runId, { status: 'cancelled', phase: 'cancelled', errorCode: 'narrative_review_abandoned', errorMessage: '用户放弃叙事语义复核' })
      const updated = await store.getRun(input.runId)
      if (updated) emit(input.runId, { type: 'terminal', run: updated })
      return narrativeReviewResult(input.runId, 'abandoned')
    }

    if (input.decision === 'reject_rewrite' && !(await rewriteBudgetAvailable(input.runId))) {
      return { ok: false, error: '本次运行没有可用的重写预算，未调用 Provider；请接受正文或放弃运行' }
    }

    if (!mem.has(input.runId)) await restore(input.runId)
    const states = await ensureScenePlan(input.runId, getConfig(input.runId).sceneContracts as SceneContractPlan)
    const state = states.find((item) => item.sceneId === packet.sceneId)
    if (!state || state.revision < 1) return { ok: false, error: '场景状态不存在或已变化' }

    if (input.decision === 'reject_rewrite') {
      const record = recordFor(null)
      claimPayloadHash = record.canonicalPayloadHash
      if (!(await claimRevision())) return reviewConflict()
      const turns = await store.getTurns(input.runId)
      const sourceTurn = turns.find((turn) => turn.turnId === candidate.sourceTurnId)
      await saveSegment({ ...candidate, status: 'rejected', acceptedAt: undefined, updatedAt: ts })
      if (sourceTurn) await store.appendTurn({ ...sourceTurn, content: '' })
      const repairSeq = turns.length ? Math.max(...turns.map((turn) => turn.turnSeq)) + 1 : 1
      await store.appendTurn({
        turnId: randomUUID(),
        runId: input.runId,
        turnSeq: repairSeq,
        role: 'system',
        content: `[叙事语义复核重写]\n候选正文未被接受。请保持已接受正文不变，重新完成场景“${packet.contract.objective}”，并明确绑定 agent、patient、source、recipient、beneficiary；不得猜测未出现的行动者。`,
        createdAt: ts
      })
      const m = mem.get(input.runId)
      if (m) m.nextTurnSeq = repairSeq + 1
      await finishNarrativeReview(packet, record, 'rewrite_requested')
      await patchRun(input.runId, { status: 'running', phase: 'thinking' })
      await clearRunError(input.runId)
      return narrativeReviewResult(input.runId, 'rewrite_requested')
    }

    const decision = reviewCompletionDecision(packet, candidate)
    const segments = await getManuscriptSegments(input.runId)
    const sceneSegments: AcceptedSceneSegmentInput[] = segments
      .filter((item) => item.kind === 'prose' && item.sceneId === packet.sceneId && (item.status === 'accepted' || item.segmentId === candidate.segmentId))
      .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt || a.segmentId.localeCompare(b.segmentId))
      .map((item) => ({ segmentId: item.segmentId, contentHash: item.contentHash, charCount: item.charCount, chunkIndex: item.chunkIndex, revision: item.revision, content: item.content }))
    // The ambiguity gate is raised before the normal writer cycle marks a
    // complete candidate.  An explicit accept decision must perform that
    // durable writing -> candidate transition before commitScene; otherwise
    // the repository correctly rejects the transaction as not ready.
    if (state.lifecycle === 'writing') {
      const candidateState = await transitionScene({
        runId: input.runId,
        sceneId: packet.sceneId,
        contractId: packet.contractId,
        contractHash: packet.contractHash,
        expectedRevision: state.revision,
        from: 'writing',
        to: 'candidate',
        candidateSegmentId: candidate.segmentId,
        candidateHash: candidate.contentHash,
        at: ts
      })
      if (candidateState) Object.assign(state, candidateState)
    }
    if (state.lifecycle !== 'candidate' && state.lifecycle !== 'accepted') return { ok: false, error: '场景候选状态已变化，请重新打开复核' }
    if (input.decision === 'accept_prose_no_state' && !isOpaqueReviewPacket(packet)) {
      return { ok: false, error: '仅可对没有结构化世界状态的文学性 beat 选择“接受正文，不产生状态变更”' }
    }
    let stateDelta: NarrativeStateDelta
    if (input.decision === 'accept_delta') {
      if (!input.delta) return { ok: false, error: '接受修正 delta 需要提供完整 delta' }
      try { stateDelta = normalizeNarrativeStateDelta(input.delta) } catch (error) { return { ok: false, error: `delta 无效：${errMsg(error)}` } }
      if (stateDelta.runId !== input.runId || stateDelta.sceneId !== packet.sceneId || stateDelta.acceptedSegmentId !== candidate.segmentId || stateDelta.acceptedContentHash !== candidate.contentHash || stateDelta.contractHash !== packet.contractHash || narrativeStateDeltaHash(stateDelta) !== stateDelta.deltaHash) return { ok: false, error: 'delta 未绑定当前候选、契约或运行' }
      if (stateDelta.changes.length === 0) return { ok: false, error: '修正 delta 不能为空；请提供经过校验的结构化状态，或选择重写/放弃' }
      const deltaRegistryError = await validateManualNarrativeDelta(input.runId, stateDelta)
      if (deltaRegistryError) return { ok: false, error: `delta 无效：${deltaRegistryError}` }
    } else if (input.decision === 'accept_prose_no_state') {
      if (input.delta !== undefined && input.delta !== null) return { ok: false, error: '接受正文、不产生状态变更不能携带 narrative delta' }
      stateDelta = buildEmptyNarrativeStateDelta({
        runId: input.runId,
        sceneId: packet.sceneId,
        acceptedSegmentId: candidate.segmentId,
        acceptedContentHash: candidate.contentHash,
        contractHash: packet.contractHash
      })
    } else {
      const config = getConfig(input.runId) as RunConfig & { grillMe?: { answers?: ConfirmedGrillAnswerInput[] } }
      const registryStore = store as RunStorePort & { getNarrativeFacts?: (sessionId: string, includeInactive?: boolean) => Promise<NarrativeFact[]> }
      let confirmedFacts: NarrativeFact[] | undefined
      if (Array.isArray(config.grillMe?.answers) && typeof config.sessionId === 'string' && typeof registryStore.getNarrativeFacts === 'function') confirmedFacts = await registryStore.getNarrativeFacts(config.sessionId, false)
      const extracted = extractNarrativeStateDelta({
        runId: input.runId,
        sceneId: packet.sceneId,
        contract: packet.contract,
        decision,
        candidateSegmentId: candidate.segmentId,
        candidateContentHash: candidate.contentHash,
        acceptedSegments: sceneSegments,
        confirmedAnswers: config.grillMe?.answers,
        confirmedFacts,
        allowUnknownSemanticRoles: true,
        now: ts
      })
      if (extracted.status !== 'ready' || !extracted.delta) {
        const reasons = extracted.report.pendingReasons
        if (!isRoleBindingAmbiguityOnly(reasons)) return { ok: false, error: `accept_unknown 仅允许角色绑定歧义；当前原因不可降级：${reasons.join(', ') || 'unknown'}` }
        return { ok: false, error: '角色绑定歧义未生成显式 unknown 状态，拒绝提交空 delta' }
      }
      stateDelta = extracted.delta
      const hasExplicitUnknown = stateDelta.changes.some((change) =>
        (change.kind === 'object_state' && change.holderStatus === 'unknown') ||
        (change.kind === 'timeline_event' && (change.unknownRoles?.length ?? 0) > 0)
      )
      if (!hasExplicitUnknown) return { ok: false, error: 'accept_unknown 需要显式 unknown 角色状态，不能用无变化 delta 表示' }
    }
    const record = recordFor(stateDelta.deltaHash)
    claimPayloadHash = record.canonicalPayloadHash
    if (!(await claimRevision())) return reviewConflict()
    await store.saveRunEvidence(input.runId, `scene_completion_decision:${candidate.segmentId}`, JSON.stringify({ schemaVersion: 1, runId: input.runId, sceneId: packet.sceneId, contractId: packet.contractId, contractHash: packet.contractHash, candidateSegmentId: candidate.segmentId, candidateHash: candidate.contentHash, decision, evaluation: packet.evaluation, stateDeltaHash: stateDelta.deltaHash, semanticReviewDecision: record, savedAt: ts }))
    if (input.decision === 'accept_prose_no_state') {
      await store.saveRunEvidence(input.runId, `narrative_prose_no_state:${candidate.segmentId}`, JSON.stringify({
        schemaVersion: 1,
        runId: input.runId,
        sceneId: packet.sceneId,
        contractId: packet.contractId,
        contractHash: packet.contractHash,
        candidateSegmentId: candidate.segmentId,
        candidateHash: candidate.contentHash,
        decisionId,
        disposition: 'prose_accepted_without_structured_state',
        unresolvedBeatIds: packet.missingBeatIds,
        note: input.note ?? '',
        stateDeltaHash: stateDelta.deltaHash,
        savedAt: ts
      }))
    }
    const context = { contract: packet.contract, state, sceneChars: Math.max(0, packet.sceneChars - candidate.charCount), acceptedChars: packet.acceptedCharsBefore }
    await acceptVerifiedProse(input.runId, { segmentId: candidate.segmentId, expectedContentHash: candidate.contentHash, expectedCharCount: candidate.charCount, evidenceRevision: candidate.revision, sceneId: packet.sceneId }, {
      contractId: packet.contractId,
      contractHash: packet.contractHash,
      expectedSceneRevision: state.revision,
      decision,
      completionEvidenceHash: decision.evidenceHash,
      stateDelta,
      committedAt: ts
    })
    if (!store.commitScene) {
      const next = await transitionScene({ runId: input.runId, sceneId: packet.sceneId, contractId: packet.contractId, contractHash: packet.contractHash, expectedRevision: state.revision, from: ['candidate', 'accepted'], to: 'committed', candidateSegmentId: candidate.segmentId, candidateHash: candidate.contentHash, acceptedSegmentId: candidate.segmentId, acceptedHash: candidate.contentHash, completionDecision: decision, completionEvidenceHash: decision.evidenceHash, at: ts })
      if (next) Object.assign(state, next)
    }
    await finishNarrativeReview(packet, record, reviewDecisionStatus(input.decision))
    await clearRunError(input.runId)
    // A review decision happens outside the normal writer cycle.  If this
    // was the final scene, run the ordinary completion gate now so the IPC
    // follow-up does not open a needless provider turn (or mark a finished
    // run failed merely because its controller had not been submitted yet).
    const committedStates = await ensureScenePlan(input.runId, getConfig(input.runId).sceneContracts as SceneContractPlan)
    const allScenesCommitted = committedStates.length > 0 && committedStates.every((item) => item.lifecycle === 'committed')
    if (allScenesCommitted) {
      const completionContract = getConfig(input.runId).completionContract as CompletionContract | undefined
      if (!completionContract) {
        await finalizeCompleted(input.runId)
        return narrativeReviewResult(input.runId, reviewDecisionStatus(input.decision))
      }
      const gate = await tryCompletionGate(input.runId, completionContract)
      if (gate === true) {
        await finalizeCompleted(input.runId)
        return narrativeReviewResult(input.runId, reviewDecisionStatus(input.decision))
      }
      if (gate === 'paused') {
        const latest = store.getLatestCompletionEvaluation(input.runId)
        let reason = 'paused'
        let message = '完成校验已暂停，请调整预算或目标后重新发起，或停止此任务'
        try {
          const evaluation = latest ? JSON.parse(latest.json) as CompletionEvaluation : null
          reason = evaluation?.blockedReason ?? reason
          message = evaluation?.pausedMessage ?? message
        } catch { /* keep safe defaults */ }
        await patchRun(input.runId, { status: 'waiting_user', phase: 'paused', errorCode: `completion_${reason}`, errorMessage: message })
        return narrativeReviewResult(input.runId, reviewDecisionStatus(input.decision))
      }
      if (gate === 'blocked') {
        await finalize(input.runId, 'failed', { errorCode: 'completion_blocked', errorMessage: '完成校验阻塞（无进展/达上限/预算耗尽），请人工介入' })
        return narrativeReviewResult(input.runId, reviewDecisionStatus(input.decision))
      }
    }
    await patchRun(input.runId, { status: 'running', phase: 'thinking' })
    return narrativeReviewResult(input.runId, reviewDecisionStatus(input.decision))
  })

  const applyRecoveryDecision = async (
    runId: string,
    decision: RecoveryDecision,
    opts: { actor?: string; note?: string } = {}
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    const run = await store.getRun(runId)
    if (!run) return { ok: false, error: '运行不存在' }
    if (run.status !== 'recovery_required') return { ok: false, error: `当前状态 ${run.status} 无需恢复决策` }
    const tcs = await store.getToolCalls(runId)
    const pending = tcs.filter((tc) => tc.status === 'side_effect_unknown')
    if (decision !== 'abandon' && pending.length === 0) return { ok: false, error: '没有待决策的工具调用（可能已处理）' }
    const actor = opts.actor ?? 'user'
    const note = opts.note ?? ''
    const ts = now()
    const record = (tc: ToolCallRecord, checkpointId: string | null): void => {
      void store.appendRecoveryDecision({
        decisionId: randomUUID(),
        runId,
        toolCallId: tc.toolCallId,
        decision,
        actor,
        note,
        checkpointId,
        createdAt: ts
      })
    }

    try {
      if (decision === 'abandon') {
        for (const tc of pending) {
          await store.upsertToolCall({ ...tc, status: 'cancelled', completedAt: ts })
          record(tc, null)
        }
        await store.updateRun(runId, { status: 'cancelled', phase: 'cancelled', errorCode: 'recovery_abandoned', errorMessage: '用户放弃该运行' })
        const updated = await store.getRun(runId)
        if (updated) emit(runId, { type: 'terminal', run: updated })
        return { ok: true }
      }

      for (const tc of pending) {
        if (decision === 'confirm_applied') {
          // 用户确认副作用已发生：标 completed + 写入确认 turn，模型据此继续
          const confirmed: ToolCallRecord = {
            ...tc,
            status: 'completed',
            resultJson: JSON.stringify({ content: `[人工确认] 工具 ${tc.name} 已由用户确认执行完成（副作用视为已发生）`, confirmed: true }),
            completedAt: ts
          }
          await store.upsertToolCall(confirmed)
          emit(runId, { type: 'tool', toolCall: confirmed })
          await appendToolResultTurn(runId, tc, `[人工确认] 工具 ${tc.name} 已由用户确认执行完成（副作用视为已发生）`)
          record(tc, null)
        } else if (decision === 'retry_not_applied' || decision === 'rollback_then_retry') {
          if (decision === 'retry_not_applied' && !IDEMPOTENT_TOOLS.has(tc.name)) {
            // 非幂等工具默认不能自动 retry（无回滚保护的自动重试可能产生二次副作用）
            return { ok: false, error: `工具 ${tc.name} 非幂等，不允许自动重试（请选择「确认已执行」「回滚后重试」或「放弃」）` }
          }
          let checkpointId: string | null = null
          if (decision === 'rollback_then_retry') {
            if (!rollback) return { ok: false, error: '回滚能力未初始化（rollback_then_retry 不可用）' }
            const rb = await rollback(runId, [tc])
            if (!rb.ok) return { ok: false, error: `回滚失败，已中止重试：${rb.error ?? '未知错误'}` }
            checkpointId = rb.checkpointId ?? null
          }
          // 标记未执行（原工具调用作废），随后重新执行
          await store.upsertToolCall({ ...tc, status: 'cancelled', resultJson: JSON.stringify({ note: decision }), completedAt: ts })
          const err = await reExecuteTool(runId, tc)
          if (err) {
            record(tc, checkpointId)
            return { ok: false, error: `重试执行失败：${err}` }
          }
          record(tc, checkpointId)
        }
      }
      // Append any known, never-dispatched suffix only after the unresolved
      // prefix decisions, retaining the provider's original tool-call order.
      const recoveryTurns = await store.getTurns(runId)
      const recoveryMem = mem.get(runId)
      const recoveryNextSeq = await reconcileParallelReadBatch(runId, recoveryTurns, recoveryMem?.nextTurnSeq ?? Math.max(0, ...recoveryTurns.map(turn => turn.turnSeq)) + 1)
      if (recoveryNextSeq !== null && recoveryMem) recoveryMem.nextTurnSeq = recoveryNextSeq
      // 决策完成：run 恢复可继续（running；是否 step 由调用方/UI 决定——决策本身即显式授权）
      await store.updateRun(runId, { status: 'running', phase: 'thinking' })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  }

  return { start, step, cancel, pause, restore, listRecoverable, listActive, getState, abortSignal, recoverInfo, applyRecoveryDecision, getNarrativeReview, applyNarrativeReviewDecision }
}
