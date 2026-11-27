import { FILE_WRITE_TOOLS } from '../shared/chatFiles'
import { planToolAllowList } from '../shared/agentPlanPolicy'
import { toolAllowed, isWebTool } from '../shared/agentToolPolicy'
import { WORK_PLAN_TOOL } from '../shared/workPlan'
import { GOAL_TOOL, isGoalModeConfig, type GoalSnapshot } from '../shared/goalMode'
import { compactGoalToolSpecs, goalToolSpecForStage } from './goalMode'
import { consumeWorkSteering, workSteeringView } from './workSteering'
import { withoutCanonicalUser } from './liveUserContext'
import { isWorkFileTool } from '../shared/workFileTools'
// ==================== RunKernel 适配层（R4-4 完整接入） ====================
// 把 AgentRunEngine 接入生产主链：
// - RunStorePort ← repository（DB 为事实源）
// - modelCall ← streamChat（DeepSeek SSE 回调 → 异步迭代器）+ 首轮前缀组装
// - toolExecutor ← executeTool（协作取消：执行前/后检查 run signal）
// - RunEngineEvent → renderer ChunkEvent 转换

import type { RunStorePort, ModelEvent, ToolCallRecord, RunRecord, TurnRecord, RecoveryDecisionRecord, ArtifactRecord, ProviderCostQuote, ToolExecutionHooks } from './jobs/types'
import { filterFrozenWebTools } from './runWebAccess'
import type { ProviderWebToolExecutor } from './publicWebTools'
import type { ChunkEvent, DsMessage, DsTool, LegacyManuscriptBackfillState, ManuscriptAcceptanceInput, ManuscriptSegment, NarrativeCommitRecord, NarrativeFact, NarrativeLedgerEntry, NarrativeLedgerScope, NarrativeLedgerScopeInfo, SceneCommitInput, SceneContractPlan, SceneStateRecord, SceneStateTransitionInput } from '../shared/types'
import type { PricingRecord } from '../shared/providerRegistry'
import { estimateTokens } from '../shared/types'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { streamChat } from './deepseek'
import type { ProviderAttemptLifecycleEvent } from './deepseek'
import type { ManuscriptBackfillWriteHooks, ManuscriptSegmentRow, Repository } from './db/repository'
import { executeTool, buildToolSpecs } from './tools'
import type { ToolResult } from './tools'
import type { ContextManifest } from './contextAssembler'
import type { ContextManifestV2, ContextMode } from '../shared/contextV2'
import { continuedReadReserveTokens, fitOlderReadBatches, type LiveToolProjection } from './liveToolProjection'
import { fitLongWriteMemoryProjections } from './longformPlanner'
import { deriveAgentOutputPlan, deriveWriterRequestPlan, mapProviderFinishReason } from './writerRequestPlan'
import { appliedFileChange, decodeToolResult, unwrapToolResult } from './toolResultView'
import { CONVERSATION_SEARCH_TOOL, type ConversationSearchPage } from '../shared/conversationSearch'
import { FILE_EVIDENCE_TOOLS, parseFileSources } from '../shared/fileEvidence'
import { buildUserPresetSystemMessage, injectUserPresetSystemMessage } from '../shared/userPresetPrompt'
import type { ProviderPerformanceSnapshot } from '../shared/performanceTelemetry'
import { deriveToolReadBudgetChars, frozenToolReadWindow } from './toolReadBudget'
export { deriveWriterRequestPlan, mapProviderFinishReason } from './writerRequestPlan'

// ---------------- R4.3 Gate 2：toolPolicy 双层强制（B-02） ----------------

/**
 * 工具白名单判定：allowList 含 '*'（仅 agent 模式语义）或精确含 name 才允许。
 * schema 层（发给模型的 tools）与 executor 层（执行分发）共用同一判定，双层 fail-closed。
 */
export function checkToolAllowed(name: string, allowList: string[] | undefined): boolean {
  return toolAllowed(name, allowList)
}

/** 从 run 快照 config 读取工具白名单（无快照时返回 undefined → 调用方按安全策略处理） */
export function allowListFromConfig(config: Record<string, unknown> | undefined): string[] | undefined {
  if (!config) return undefined
  const planTools = planToolAllowList(config)
  const tp = config.toolPolicy as { allowList?: unknown } | undefined
  const raw = planTools ?? (Array.isArray(tp?.allowList) ? (tp.allowList as string[]) : undefined)
  const base = raw ? filterFrozenWebTools(config, raw) : undefined
  // R11：test seam——mock_slow_tool 与 getTool 的 NODE_ENV=test 注册对称放行（E2E 构造
  // 真实 tracked child 工具态用；生产 NODE_ENV !== test 不受影响）
  if (process.env.NODE_ENV === 'test' && base) {
    return [...base, 'mock_slow_tool', 'mock_tracked_child_tool']
  }
  return base
}

// ---------------- store port：repository → RunStorePort ----------------

function toManuscriptSegmentRow(segment: ManuscriptSegment): ManuscriptSegmentRow {
  return {
    segment_id: segment.segmentId,
    run_id: segment.runId,
    session_id: segment.sessionId,
    source_turn_id: segment.sourceTurnId ?? null,
    section_id: segment.sectionId ?? null,
    scene_id: segment.sceneId ?? null,
    chunk_index: segment.chunkIndex,
    revision: segment.revision,
    status: segment.status,
    kind: segment.kind,
    content: segment.content,
    content_hash: segment.contentHash,
    char_count: segment.charCount,
    supersedes_segment_id: segment.supersedesSegmentId ?? null,
    created_at: segment.createdAt,
    updated_at: segment.updatedAt,
    accepted_at: segment.acceptedAt ?? null
  }
}

export function createRunStorePort(repository: Repository, artifactDir?: string): RunStorePort {
  const toRunRecord = (r: {
    run_id: string
    session_id: string
    status: string
    phase: string
    started_at: number
    updated_at: number
    config_json: string
    parent_run_id: string | null
    error_code: string | null
    error_message: string | null
  }): RunRecord => ({
    runId: r.run_id,
    sessionId: r.session_id,
    status: r.status as RunRecord['status'],
    phase: r.phase as RunRecord['phase'],
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    configJson: r.config_json,
    parentRunId: r.parent_run_id ?? undefined,
    errorCode: r.error_code ?? undefined,
    errorMessage: r.error_message ?? undefined
  })
  return {
    async createRun(run) {
      // R4-4：幂等键必须真正落库——从 run 的不可变 config 提取 clientRequestId
      let clientRequestId: string | null = null
      try {
        const cfg = JSON.parse(run.configJson || '{}') as { clientRequestId?: unknown }
        clientRequestId = typeof cfg.clientRequestId === 'string' ? cfg.clientRequestId : null
      } catch {
        /* 解析失败按无幂等键处理 */
      }
      repository.createRun({
        run_id: run.runId,
        session_id: run.sessionId,
        status: run.status,
        phase: run.phase,
        started_at: run.startedAt,
        updated_at: run.updatedAt,
        config_json: run.configJson,
        parent_run_id: run.parentRunId ?? null,
        error_code: run.errorCode ?? null,
        error_message: run.errorMessage ?? null,
        client_request_id: clientRequestId
      })
    },
    async getRun(runId) {
      const r = repository.getRun(runId)
      return r ? toRunRecord(r) : null
    },
    async updateRun(runId, patch) {
      // R4.2：RunRecord 字段 camelCase → DB 列 snake_case（status/phase 同名，errorCode/errorMessage 必须映射）
      const dbPatch: Record<string, unknown> = {}
      if (patch.status !== undefined) dbPatch.status = patch.status
      if (patch.phase !== undefined) dbPatch.phase = patch.phase
      if (patch.errorCode !== undefined) dbPatch.error_code = patch.errorCode
      if (patch.errorMessage !== undefined) dbPatch.error_message = patch.errorMessage
      if (patch.configJson !== undefined) dbPatch.config_json = patch.configJson
      if (patch.parentRunId !== undefined) dbPatch.parent_run_id = patch.parentRunId
      if (patch.startedAt !== undefined) dbPatch.started_at = patch.startedAt
      repository.updateRun(runId, dbPatch)
    },
    async listActiveRuns() {
      return repository
        .listActiveRuns()
        .map(toRunRecord)
        .filter((r) => r.status !== 'completed' && r.status !== 'failed' && r.status !== 'cancelled')
    },
    async hasPendingWorkSteering(runId, sessionId) { return workSteeringView(repository, runId, sessionId).messages.some(item => item.status === 'pending') },
    async consumeWorkSteering(runId, sessionId) {
      return consumeWorkSteering(repository, runId, sessionId).map(turn => ({ turnId: turn.turn_id, runId: turn.run_id, turnSeq: turn.turn_seq,
        role: 'user' as const, content: turn.content, createdAt: turn.created_at }))
    },
    async appendTurn(turn) {
      repository.appendTurn({
        turn_id: turn.turnId,
        run_id: turn.runId,
        turn_seq: turn.turnSeq,
        role: turn.role,
        content: turn.content,
        reasoning_content: turn.reasoningContent ?? null,
        tool_calls_json: turn.toolCallsJson ?? null,
        tool_result_json: turn.toolResultJson ?? null,
        plan_state: turn.planState ?? null,
        created_at: turn.createdAt
      })
    },
    async getTurns(runId) {
      return repository.getTurnsByRun(runId).map((t) => ({
        turnId: t.turn_id,
        runId: t.run_id,
        turnSeq: t.turn_seq,
        role: t.role as TurnRecord['role'],
        content: t.content,
        reasoningContent: t.reasoning_content ?? undefined,
        toolCallsJson: t.tool_calls_json ?? undefined,
        toolResultJson: t.tool_result_json ?? undefined,
        planState: t.plan_state ?? undefined,
        createdAt: t.created_at
      }))
    },
    async saveAssistantTurnWithSegment(turn, segment) {
      repository.tx(() => {
        repository.appendTurn({
          turn_id: turn.turnId,
          run_id: turn.runId,
          turn_seq: turn.turnSeq,
          role: turn.role,
          content: turn.content,
          reasoning_content: turn.reasoningContent ?? null,
          tool_calls_json: turn.toolCallsJson ?? null,
          tool_result_json: turn.toolResultJson ?? null,
          plan_state: turn.planState ?? null,
          created_at: turn.createdAt
        })
        repository.saveManuscriptSegment(toManuscriptSegmentRow(segment))
      }, 'immediate')
    },
    async saveManuscriptSegment(segment) {
      repository.saveManuscriptSegment(toManuscriptSegmentRow(segment))
    },
    async getManuscriptSegments(runId) {
      return repository.getManuscriptSegmentsByRun(runId).map((segment) => ({
        schemaVersion: 1 as const,
        segmentId: segment.segment_id,
        runId: segment.run_id,
        sessionId: segment.session_id,
        sourceTurnId: segment.source_turn_id ?? undefined,
        sectionId: segment.section_id ?? undefined,
        sceneId: segment.scene_id ?? undefined,
        chunkIndex: segment.chunk_index,
        revision: segment.revision,
        status: segment.status,
        kind: segment.kind,
        content: segment.content,
        contentHash: segment.content_hash,
        charCount: segment.char_count,
        supersedesSegmentId: segment.supersedes_segment_id ?? undefined,
        createdAt: segment.created_at,
        updatedAt: segment.updated_at,
        acceptedAt: segment.accepted_at ?? undefined
      }))
    },
    async acceptManuscriptSegment(input: ManuscriptAcceptanceInput) {
      repository.acceptManuscriptSegment(input)
    },
    async ensureSceneStates(runId: string, plan: SceneContractPlan, at: number) {
      repository.ensureSceneStates(runId, plan, at)
    },
    async getSceneStates(runId: string): Promise<SceneStateRecord[]> {
      return repository.getSceneStates(runId)
    },
    async transitionSceneState(input: SceneStateTransitionInput): Promise<SceneStateRecord> {
      return repository.transitionSceneState(input)
    },
    async commitScene(input: SceneCommitInput) {
      repository.commitScene(input)
    },
    async getSceneCommitManifest(runId: string, sceneId: string) {
      return repository.getSceneCommitManifest(runId, sceneId)
    },
    async getNarrativeCommits(runId: string, sceneId?: string): Promise<NarrativeCommitRecord[]> {
      return repository.getNarrativeCommits(runId, sceneId)
    },
    async getNarrativeLedger(runId: string, sceneId?: string): Promise<NarrativeLedgerEntry[]> {
      return repository.getNarrativeLedger(runId, sceneId)
    },
    async getNarrativeLedgerScope(runId: string): Promise<NarrativeLedgerScopeInfo | null> {
      return repository.getNarrativeLedgerScope(runId)
    },
    async getStoryLedgerFreshness(runId) {
      return repository.getStoryLedgerFreshness(runId)
    },
    async assertStoryLedgerFresh(input) {
      return repository.assertStoryLedgerFresh(input)
    },
    async getNarrativeLedgerByScope(scope: NarrativeLedgerScope, throughRevision?: number): Promise<NarrativeLedgerEntry[]> {
      return repository.getNarrativeLedgerByScope(scope, throughRevision)
    },
    async getNarrativeFacts(sessionId: string, includeInactive = false): Promise<NarrativeFact[]> {
      return repository.getNarrativeFacts(sessionId, includeInactive)
    },
    async getManuscriptBackfill(runId) {
      return repository.getManuscriptBackfill(runId)
    },
    async saveManuscriptBackfillStep(state: LegacyManuscriptBackfillState, segment?: ManuscriptSegment, hooks?: ManuscriptBackfillWriteHooks) {
      repository.saveManuscriptBackfillStep(state, segment ? toManuscriptSegmentRow(segment) : undefined, hooks)
    },
    async upsertToolCall(tc) {
      repository.upsertToolCall({
        tool_call_id: tc.toolCallId,
        turn_id: tc.turnId,
        run_id: tc.runId,
        name: tc.name,
        args_json: tc.argsJson,
        args_hash: tc.argsHash,
        status: tc.status,
        result_json: tc.resultJson ?? null,
        started_at: tc.startedAt ?? null,
        completed_at: tc.completedAt ?? null
      })
    },
    async getToolCalls(runId) {
      return repository.getToolCallsByRun(runId).map((t) => ({
        toolCallId: t.tool_call_id,
        turnId: t.turn_id,
        runId: t.run_id,
        name: t.name,
        argsJson: t.args_json,
        status: t.status as ToolCallRecord['status'],
        resultJson: t.result_json ?? undefined,
        argsHash: t.args_hash,
        startedAt: t.started_at ?? undefined,
        completedAt: t.completed_at ?? undefined
      }))
    },
    async appendRecoveryDecision(d) {
      repository.appendRecoveryDecision({
        decision_id: d.decisionId,
        run_id: d.runId,
        tool_call_id: d.toolCallId,
        decision: d.decision,
        actor: d.actor,
        note: d.note,
        checkpoint_id: d.checkpointId,
        created_at: d.createdAt
      })
    },
    async getRecoveryDecisions(runId) {
      return repository.getRecoveryDecisions(runId).map((r) => ({
        decisionId: r.decision_id,
        runId: r.run_id,
        toolCallId: r.tool_call_id,
        decision: r.decision as RecoveryDecisionRecord['decision'],
        actor: r.actor,
        note: r.note,
        checkpointId: r.checkpoint_id,
        createdAt: r.created_at
      }))
    },
    async getArtifactsByRun(runId) {
      return repository.getArtifactsByRun(runId).map((a) => ({
        artifactId: a.artifact_id,
        runId: a.run_id,
        sessionId: a.session_id,
        artifactType: a.artifact_type as ArtifactRecord['artifactType'],
        displayName: a.display_name,
        relativePath: a.relative_path,
        hash: a.hash ?? '',
        charCount: a.char_count,
        status: a.status as ArtifactRecord['status'],
        createdAt: a.created_at
      }))
    },
    async getArtifactContent(hash) {
      // 内容对象始终按 hash 寻址；artifactId 只负责数据库身份，可稳定绑定 run。
      if (artifactDir) {
        try {
          return await fsp.readFile(path.join(artifactDir, hash + '.txt'), 'utf-8')
        } catch {
          /* legacy manuscript artifacts may live at their recorded document path */
        }
      }
      for (const artifact of repository.getArtifactsByHash(hash)) {
        if (!artifact.relative_path || !path.isAbsolute(artifact.relative_path)) continue
        try {
          return await fsp.readFile(artifact.relative_path, 'utf-8')
        } catch {
          /* try the next immutable artifact record */
        }
      }
      return null
    },
    async saveCompletionEvaluation(runId, revision, state, json) {
      repository.saveCompletionEvaluation(runId, revision, state, json)
    },
    getLatestCompletionEvaluation(runId) {
      const r = repository.getLatestCompletionEvaluation(runId)
      return r ? { revision: r.revision, state: r.state, json: r.json } : null
    },
    async appendCompletionAttempt(runId, attempt, json) {
      repository.appendCompletionAttempt(runId, attempt, json)
    },
    async getCompletionAttempts(runId) {
      return repository.getCompletionAttempts(runId).map((row) => ({ attempt: row.attempt, json: row.json, createdAt: row.created_at }))
    },
    async getProviderAttempts(runId) {
      return repository.getProviderAttempts(runId).map((row) => ({
        actor: row.actor,
        logicalCallId: row.logical_call_id,
        attemptNo: row.attempt_no,
        outcome: row.outcome,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        costStatus: row.cost_status,
        costAmount: row.cost_amount,
        costCurrency: row.cost_currency,
        startedAt: row.started_at
      }))
    },
    async getRunEvidence(runId, kind) {
      const r = repository.getRunEvidence(runId, kind)
      return r ? { json: r.json, created_at: r.created_at } : null
    },
    async saveRunEvidence(runId, kind, json) {
      repository.saveRunEvidence(runId, kind, json)
    },
    async saveRunEvidenceIfAbsent(runId, kind, json) {
      return repository.saveRunEvidenceIfAbsent(runId, kind, json)
    },
    async saveRunEvidenceBundle(runId, entries) {
      repository.saveRunEvidenceBundle(runId, entries)
    },
    async getUsageTotalTokens(runId) {
      const t = repository.getUsageTotals(runId)
      return t.input_tokens + t.output_tokens
    },
    async appendUsage(u) {
      repository.appendUsage({
        run_id: u.runId,
        call_type: u.callType,
        model: u.model,
        input_tokens: u.inputTokens,
        output_tokens: u.outputTokens,
        cache_hit: u.cacheHit,
        cache_miss: u.cacheMiss,
        cost: 0,
        pricing_version: '',
        created_at: u.createdAt
      })
    },
    async saveArtifact(a) {
      // R4.2 A5 补充：元数据落库 + 完整内容写磁盘对象（文件名=hash，无用户路径；不入 DB）
      repository.saveArtifact({
        artifact_id: a.artifactId,
        run_id: a.runId,
        session_id: a.sessionId,
        artifact_type: a.artifactType,
        display_name: a.displayName,
        relative_path: a.relativePath,
        hash: a.hash,
        char_count: a.charCount,
        status: a.status,
        created_at: a.createdAt
      })
      if (artifactDir && a.content !== undefined) {
        try {
          await fsp.mkdir(artifactDir, { recursive: true })
          await fsp.writeFile(path.join(artifactDir, `${a.hash}.txt`), a.content, 'utf-8')
        } catch (e) {
          // 落盘失败不阻断工具执行（元数据已入 DB；错误不含路径/正文）
          console.warn('[artifact] 落盘失败', (e as Error).message)
        }
      }
    }
  }
}

// ---------------- modelCall：DeepSeek SSE 回调 → ModelEvent 异步迭代器 ----------------

export interface KernelApi {
  /** Missing is legacy wire behavior; null delegates output length to provider. */
  outputTokenLimit?: number | null
  modelMaxOutputTokens?: number | null
  apiKey: string
  baseUrl: string
  model: string
  maxTokens: number
  thinking: { enabled: boolean; effort: 'default' | 'low' | 'medium' | 'high' | 'max' }
  temperature: number
  topP: number
  providerId?: string
  adapterId?: 'builtin.deepseek' | 'custom.openai-compatible-chat'
  protocol?: 'deepseek-chat' | 'openai-chat' | 'openai-responses' | 'anthropic-messages'
  profileId?: string
  credentialRefId?: string | null
  chatPath?: string
  authStyle?: 'bearer' | 'none'
  transportPolicy?: { scope: 'public_https' | 'loopback_http'; allowNonDefaultPort: boolean; protocol?: 'deepseek-chat' | 'openai-chat' | 'openai-responses' | 'anthropic-messages'; fixedHeaders?: Record<string, string> }
  authHeaderName?: string
  extraHeaders?: Record<string, string>
  reasoningMode?: 'default' | 'disabled' | 'enabled' | 'adaptive'
  reasoningBudgetTokens?: number | null
  compatibilityMappingId?: import('../shared/providerRegistry').CompatibilityMappingId | null
  appliedMappings?: string[]
  omittedControls?: string[]
  supportsTools?: boolean
  /** Price snapshot frozen with the selected executable profile. */
  pricing?: PricingRecord | null
}

export interface ModelCallOpts {
  /** R4.5 Gate 5：按 run 解析凭据——从 snapshot 的 credentialRef 解析同一 version 的 key；
   *  缺失/版本不匹配 → fail-closed 抛 CredentialMissingError（绝不退回当前任意 key） */
  getApi: (runId: string, purpose: 'writer' | 'critic' | 'editor', phase: string) => KernelApi
  /** 每轮组装稳定 system 前缀 + 首轮附件（R4.1 B-05：静态 system policy 每轮字节一致；附件仅首轮） */
  buildPrefix: (runConfig: Record<string, unknown>, round: number) => Promise<DsMessage[]>
  getSignal: (runId: string) => AbortSignal | undefined
  /** 取 run 的不可变 config（用于 buildPrefix） */
  getConfig: (runId: string) => Record<string, unknown>
  /** Additional frozen schemas. Merged before allowList and the exact-body
   * provider budget hook; skill metadata can never grant permissions. */
  getToolSpecs?: (runId: string) => DsTool[] | Promise<DsTool[]>
  /**
   * R4.2 A5：主进程上下文组装（总预算 + context manifest）。
   * 返回含 staticSystem/user/history 的完整消息与 manifest；adapter 负责：
   * - 跳过 live 中已被组装进 messages 的 user 消息（防重复）；
   * - 补 live 段并校正 totalTokens/overBudget；
   * - 硬预算兜底 fail-closed（组装后仍超窗口则拒绝发送）。
   */
  assembleContext?: (config: Record<string, unknown>, round: number, live: DsMessage[], prefix: DsMessage[], purpose: 'writer' | 'critic' | 'editor', requestId: string, stageId: string) => Promise<{ messages: DsMessage[]; manifest: ContextManifest; userContent: string | null; contextV2: ContextManifestV2 | null; sceneWorkingSetFence?: (messages: DsMessage[], phase?: 'prebind' | 'postbind') => void; persistSceneEnvelope?: (messages: DsMessage[]) => void; suppressLive?: boolean }>
  /** 清单必须在最终 provider envelope 确定后、streamChat 前 append-only 落库。 */
  persistContext?: (manifest: ContextManifestV2, fullMessages: DsMessage[], live: DsMessage[], projection?: LiveToolProjection) => ContextManifestV2
  onProviderAttempt?: (input: {
    runId: string
    logicalCallId: string
    actor: 'writer' | 'critic' | 'editor'
    subtype: string | null
    stageId: string
    providerId: string
    endpointOrigin: string
    modelId: string
    adapterId: string | null
    profileId: string | null
    credentialRefId: string | null
    appliedMappings: string[]
    omittedControls: string[]
    contextManifestId: string | null
    contextMode: ContextMode | null
    event: ProviderAttemptLifecycleEvent
  }) => void
  /** Run-level hard budget callback.  It is invoked immediately before each
   * provider attempt; the engine has already reserved attempt 1, so this is
   * primarily used for inner retries. */
  beforeProviderAttempt?: (input: { runId: string; logicalCallId: string; actor: 'writer' | 'critic' | 'editor'; stageId: string; innerAttempt: number; request?: { bodyJson: string; model: string; maxTokens: number }; costQuote?: ProviderCostQuote }) => void | Promise<void>
  /** Test seam for the provider boundary; production uses streamChat. */
  streamChatImpl?: typeof streamChat
}

export function createModelCallAdapter(opts: ModelCallOpts) {
  return async (input: { runId: string; phase: string; turnSeq: number; round: number; messages: DsMessage[]; purpose?: 'writer' | 'critic' | 'editor'; liveToolProjection?: LiveToolProjection; goalStage?: GoalSnapshot['status']; logicalCallId?: string; beforeProviderAttempt?: (input: { innerAttempt: number; logicalCallId: string; request?: { bodyJson: string; model: string; maxTokens: number }; costQuote?: ProviderCostQuote }) => void | Promise<void> }): Promise<AsyncIterable<ModelEvent>> => {
    // R4.1 SNAPSHOT-SETTINGS-01 / R4.2 A3：API 参数取自 run 创建时的不可变 config 快照，
    // 运行中修改全局设置不影响已启动 run；credential 与快照 origin 绑定（不存明文 key）。
    // R4.5 Gate 5（复审 S-03）：apiKey 一律由 getApi(runId) 按 snapshot 的 credentialRef 解析
    // （同一 slot 同一 version；缺失/更换 → CredentialMissingError fail-closed，绝不退回当前任意 key）。
    const config = opts.getConfig(input.runId)
    const purpose = input.purpose ?? 'writer'
    const current = opts.getApi(input.runId, purpose, input.phase)
    let api: KernelApi
    if (current.profileId) {
      api = current
    } else if (config && typeof config.model === 'string' && typeof config.baseUrl === 'string') {
      api = {
        apiKey: current.apiKey, // 由 getApi(runId) 按 ref 解析（快照不存明文 key）
        baseUrl: config.baseUrl as string,
        model: config.model as string,
        maxTokens: typeof config.maxTokens === 'number' ? (config.maxTokens as number) : current.maxTokens,
        outputTokenLimit: Object.hasOwn(config, 'outputTokenLimit') ? config.outputTokenLimit as number | null : current.outputTokenLimit,
        modelMaxOutputTokens: current.modelMaxOutputTokens,
        thinking: (config.thinking as { enabled: boolean; effort: 'low' | 'medium' | 'high' | 'max' }) ?? current.thinking,
        temperature: typeof config.temperature === 'number' ? (config.temperature as number) : current.temperature,
        topP: typeof config.topP === 'number' ? (config.topP as number) : current.topP,
        providerId: current.providerId,
        // Keep a price snapshot only when the legacy fallback still targets
        // the exact frozen endpoint/model. Otherwise force an unknown quote
        // instead of applying a price to a different endpoint.
        pricing: current.baseUrl === config.baseUrl && current.model === config.model ? (current.pricing ?? null) : null
      }
      // R4.2 A3（S-01）：credential reference 与 origin 绑定——快照 origin ≠ 当前凭据 origin 时
      // fail closed（绝不把 key 发送到错误 origin；运行中修改 provider 不影响已启动 run）
      if (api.baseUrl !== current.baseUrl && api.apiKey) {
        throw new Error(`模型凭据与执行快照 origin 不匹配：快照 ${api.baseUrl} ≠ 当前 ${current.baseUrl}（运行中修改 provider 不影响已启动 run，已拒绝发送）`)
      }
    } else {
      api = current
    }
    const signal = opts.getSignal(input.runId)
    // R4.1 TOKEN-METRICS-01：按段估算 token（供 segmentBreakdown 与硬预算兜底）
    const est = (msgs: DsMessage[]): number => msgs.reduce((a, m) => a + estimateTokens(m.content ?? ''), 0)
    // R4.1 B-05：每轮都注入稳定 system 前缀（安全策略/记忆不因轮次丢失；附件仅首轮避免重复）
    const logicalCallId = input.logicalCallId ?? randomUUID()
    const endpointOrigin = (() => { try { return new URL(api.baseUrl).origin } catch { return '' } })()
    const providerId = api.providerId ?? (() => { try { return new URL(api.baseUrl).hostname || 'unknown' } catch { return 'unknown' } })()
    const subtype = purpose === 'critic' && input.round >= 100000 && input.round % 10 === 2 ? 'verify' : null
    // critic/editor 是内部审校调用：它们不能伪装成 canonical 用户消息，也不能
    // 携带工具或把正文写进会话历史。冻结审校 prompt 已经直接包含在 messages。
    // The current-Agent preset is part of the frozen writer prefix.  Aux calls
    // use a complete purpose-specific envelope, so inject the same frozen
    // system message into their input instead of relying on writer-only prefix.
    // R4.3 Gate 2（B-02）：工具 schema 按快照 allowList 过滤（双层 fail-closed 第一层）；
    // 旧计划无工具；显式只读计划仅暴露冻结交集；'*' 仅普通 agent 模式语义。
    const allowList = allowListFromConfig(config)
    let tools: DsTool[] | undefined
    if (purpose === 'writer' && (allowList || isGoalModeConfig(config)) && api.supportsTools !== false) {
      const planningGoal = isGoalModeConfig(config) && (input.goalStage ?? 'planning') === 'planning'
      const merged = [...(planningGoal ? [] : buildToolSpecs(true)), ...(isGoalModeConfig(config) ? [goalToolSpecForStage(input.goalStage)] : []), ...await (opts.getToolSpecs?.(input.runId) ?? [])]
      const names = new Set<string>()
      for (const tool of merged) {
        const name = tool?.function?.name
        if (tool?.type !== 'function' || typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || !tool.function.parameters || typeof tool.function.parameters !== 'object') throw new Error('extension_tool_schema_invalid')
        if (names.has(name)) throw new Error('extension_tool_name_conflict')
        names.add(name)
      }
      tools = merged.filter((tool) => tool.function.name === GOAL_TOOL ? isGoalModeConfig(config) : checkToolAllowed(tool.function.name, allowList))
      if (isGoalModeConfig(config) && (frozenToolReadWindow(config,api.profileId) ?? 8192) <= 16384) tools = compactGoalToolSpecs(tools)
    }

    let prefix = purpose === 'writer' ? await opts.buildPrefix(config, input.round) : []
    const frozenPreset = buildUserPresetSystemMessage(config?.userPresetPrompt)
    if (purpose === 'writer' && frozenPreset && !prefix.some((message) => message.role === 'system' && message.content === frozenPreset.content)) {
      prefix = [frozenPreset, ...prefix]
    }
    let requestMessages = purpose === 'writer' ? input.messages : injectUserPresetSystemMessage(input.messages, config?.userPresetPrompt)
    const automatic = (config.contextPolicy as { management?: unknown } | undefined)?.management === 'model_auto_v1'
    const wireReserveTokens = automatic ? estimateTokens(JSON.stringify(tools ?? [])) + 256 : 0
    let nextReadReserveTokens = 0
    let conversationReadReserveTokens = 0
    let wireProjection = input.liveToolProjection
    if (automatic && purpose === 'writer') {
      const snapshots = config.providerProfileSnapshots as { planning?: { contextBudget?: { contextWindowTokens?: number }; model?: { contextWindow?: number } }; draft?: { contextBudget?: { contextWindowTokens?: number }; model?: { contextWindow?: number } } } | undefined
      const selected = config.planMode === true ? snapshots?.planning : snapshots?.draft
      const window = selected?.contextBudget?.contextWindowTokens ?? selected?.model?.contextWindow ?? (config.contextPolicy as { contextWindowTokens?: number } | undefined)?.contextWindowTokens ?? 8192
      const projectionBudget = window - api.maxTokens - wireReserveTokens - prefix.reduce((sum, message) => sum + estimateTokens(JSON.stringify(message)), 0)
      if (config.runMode === 'agent' && config.longMode !== true) {
        nextReadReserveTokens = continuedReadReserveTokens(requestMessages, projectionBudget)
        conversationReadReserveTokens = tools?.some(tool => tool.function.name === CONVERSATION_SEARCH_TOOL)
          ? Math.max(0, Math.min(1536, Math.max(0, Math.floor(projectionBudget / 3))) - nextReadReserveTokens) : 0
        const compacted = fitOlderReadBatches(requestMessages, projectionBudget - nextReadReserveTokens)
        if (compacted) {
          requestMessages = compacted.messages
          wireProjection = { excerpts: wireProjection?.excerpts ?? new Set(), dropped: compacted.projection.dropped,
            estimatedSavedTokens: (wireProjection?.estimatedSavedTokens ?? 0) + compacted.projection.estimatedSavedTokens }
        }
      } else if (config.runMode === 'longwrite' && config.longMode === true) {
        const compacted = fitLongWriteMemoryProjections(requestMessages, projectionBudget)
        if (compacted) {
          requestMessages = compacted.messages
          wireProjection = { excerpts: wireProjection?.excerpts ?? new Set(), estimatedSavedTokens: (wireProjection?.estimatedSavedTokens ?? 0) + compacted.savedTokens }
        }
      }
    }
    const assemblyConfig = automatic ? { ...config, contextAssemblyReserveTokens: wireReserveTokens + nextReadReserveTokens, contextOptionalReadReserveTokens: conversationReadReserveTokens } : config
    // R4.2 A5：总预算组装——assembler 产出完整消息（staticSystem+user+history），
    // live 中已被组装进 messages 的 user 消息跳过（防重复），其余 live（assistant/tool）追加在末
    let fullMessages: DsMessage[]
    let manifest: ContextManifest | null = null
    let contextV2: ContextManifestV2 | null = null
    let finalLive: DsMessage[] = []
    let sceneWorkingSetFence: ((messages: DsMessage[], phase?: 'prebind' | 'postbind') => void) | undefined
    let persistSceneEnvelope: ((messages: DsMessage[]) => void) | undefined
    if (opts.assembleContext) {
      // aux 使用负 round 独立保存 context manifest，避免覆盖 writer round；
      // ContextService 会把内部 prompt 标为 internal source，而不是 canonical 用户消息。
      const manifestRound = purpose === 'writer' ? input.round : -input.round
      const a = await opts.assembleContext(assemblyConfig, manifestRound, requestMessages, prefix, purpose, logicalCallId, input.phase)
      manifest = a.manifest
      const live = purpose === 'writer'
        ? a.suppressLive
          ? []
          : withoutCanonicalUser(requestMessages, a.userContent)
        : []
      finalLive = live
      contextV2 = a.contextV2 ?? null
      sceneWorkingSetFence = a.sceneWorkingSetFence
      persistSceneEnvelope = a.persistSceneEnvelope
      fullMessages = [...a.messages, ...live]
      // manifest 补 live 段 + 校正 totalTokens/promptHash（live 未计入 assembler 预算）
      const liveTokens = est(live)
      manifest.segments.push({
        id: `live-${input.round}`,
        kind: 'live',
        sourceIds: live.map((m, i) => `live:${i + 1}:${m.role}`),
        estimatedTokens: liveTokens,
        actualTokens: liveTokens,
        droppedReason: null,
        summaryVersion: null,
        hash: createHash('sha256').update(live.map((m) => m.content ?? '').join('\n')).digest('hex'),
        cacheable: false
      })
      manifest.totalTokens = (automatic ? fullMessages.reduce((sum, message) => sum + estimateTokens(JSON.stringify(message)), 0) : est(fullMessages)) + wireReserveTokens
      manifest.promptHash = createHash('sha256').update(fullMessages.map((m) => m.content ?? '').join('\n')).digest('hex')
      manifest.overBudget = manifest.totalTokens > manifest.budgetTokens
    } else {
      fullMessages = [...prefix, ...requestMessages]
    }
    const requestPlan = deriveWriterRequestPlan(config, api, requestMessages, manifest, purpose)
    const outputPlan = purpose === 'writer' ? deriveAgentOutputPlan(config, api, fullMessages, tools, manifest) : null
    if (manifest) {
      // 记录真实发送的输出余量，而不是沿用旧的 8192 默认值。
      manifest.outputReserveTokens = requestPlan.maxTokens
      manifest.budgetTokens = Math.max(0, manifest.contextWindowTokens - requestPlan.maxTokens)
      manifest.overBudget = manifest.totalTokens + requestPlan.maxTokens > manifest.contextWindowTokens
      // 硬预算 fail-closed：先按 provider/model/context 三方收窄输出预算，
      // 再判断 live 增长后的最终 envelope。否则旧的 8192 reserve 会在
      // deriveWriterRequestPlan 有机会安全收窄前把本可发送的请求误拒绝。
      if (manifest.overBudget) throw new Error('上下文硬预算超限：writer 输出预算与输入合计超过 provider 窗口（未发送）')
    }
    if (contextV2) {
      if (automatic) contextV2.wireReserveTokens = wireReserveTokens
      contextV2.outputReserveTokens = requestPlan.maxTokens
      contextV2.inputBudgetTokens = Math.max(0, (manifest?.contextWindowTokens ?? ((contextV2.inputBudgetTokens ?? 0) + requestPlan.maxTokens)) - requestPlan.maxTokens)
    }
    // A Working Set is immutable only after the exact final message sequence
    // is known.  Run its source/head/index/manifest/message fence before any
    // durable provider envelope append; the same fence is repeated for every
    // retry immediately before fetch below.
    sceneWorkingSetFence?.(fullMessages, 'prebind')
    // R45：真实发送 envelope 的唯一 durable 清单来源。失败即未调用 provider。
    if (contextV2) contextV2 = opts.persistContext?.(contextV2, fullMessages, finalLive, finalLive.length > 0 ? wireProjection : undefined) ?? (() => { throw new Error('上下文清单无法持久化，未发送') })()
    persistSceneEnvelope?.(fullMessages)
    sceneWorkingSetFence?.(fullMessages, 'postbind')
    const systemSeg = prefix.filter((m) => m.role === 'system')
    const attachSeg = prefix.filter((m) => m.role === 'user')
    const cacheablePrefixHash = createHash('sha256').update(systemSeg.map((m) => m.content ?? '').join('\n')).digest('hex')
    const segmentBreakdown = [
      { label: 'static-system', tokens: est(systemSeg), cacheable: true },
      { label: 'attachments', tokens: est(attachSeg), cacheable: false },
      { label: purpose === 'writer' ? 'history-and-user' : `writing-${purpose}`, tokens: est(requestMessages), cacheable: false }
    ]

    const queue: ModelEvent[] = []
    let wake: (() => void) | undefined
    const enqueue = (event: ModelEvent): void => {
      const tail = queue[queue.length - 1]
      // Coalesce only unconsumed adjacent deltas. No timer delays the first
      // token, and tool/usage/terminal ordering remains exact.
      if ((event.type === 'text' || event.type === 'reasoning') && tail?.type === event.type && (tail.delta?.length ?? 0) < 65536) tail.delta = (tail.delta ?? '') + (event.delta ?? '')
      else queue.push(event)
      wake?.(); wake = undefined
    }
    let streamDone = false
    let streamError: Error | null = null

    const streamChatCall = opts.streamChatImpl ?? streamChat
    let lastRequestBody: string | null = null
    let finalOutputReserve = requestPlan.maxTokens
    let observedInputTokens = 0
    let assistantContent = ''
    let assistantReasoning = ''
    const assistantTools = new Map<number, NonNullable<ModelEvent['tool']>>()
    const finish = (reason: string | null | undefined): ModelEvent => ({
      type: 'finish', ...mapProviderFinishReason(reason),
      ...(purpose === 'writer' ? { toolReadBudgetChars: deriveToolReadBudgetChars({
        windowTokens: frozenToolReadWindow(config, api.profileId, manifest?.contextWindowTokens), bodyJson: lastRequestBody,
        maxOutputTokens: finalOutputReserve, toolCount: assistantTools.size, observedInputTokens,
        assistant: { role: 'assistant', content: assistantContent, ...(assistantReasoning ? { reasoning_content: assistantReasoning } : {}),
          ...(assistantTools.size ? { tool_calls: [...assistantTools.values()].map(tool => ({ id: tool.id, name: tool.name, arguments: tool.arguments })) } : {}) }
      }) } : {})
    })
    void streamChatCall(
      {
        apiKey: api.apiKey,
        baseUrl: api.baseUrl,
        model: api.model,
        messages: fullMessages,
        thinking: requestPlan.thinking,
        maxTokens: outputPlan ? outputPlan.wireMaxTokens : requestPlan.maxTokens,
        ...(outputPlan ? { outputReserveTokens: requestPlan.maxTokens, outputTokenUpperBound: outputPlan.outputTokenUpperBound,
          omitOutputTokenLimit: outputPlan.omitOutputTokenLimit, outputLimitSource: outputPlan.outputLimitSource } : {}),
        temperature: api.temperature,
        topP: api.topP,
        tools: tools && tools.length > 0 ? tools : undefined,
        toolChoice: tools && tools.length > 0 ? 'auto' : undefined,
        ...(api.adapterId && api.chatPath && api.authStyle && api.transportPolicy ? {
          provider: {
            adapterId: api.adapterId,
            protocol: api.protocol,
            chatPath: api.chatPath,
            authStyle: api.authStyle,
            transportPolicy: api.transportPolicy,
            authHeaderName: api.authHeaderName,
            extraHeaders: api.extraHeaders,
            reasoning: { mode: api.reasoningMode ?? 'default', effort: api.thinking.effort === 'default' ? null : api.thinking.effort, ...(api.reasoningBudgetTokens !== undefined ? { budgetTokens: api.reasoningBudgetTokens } : {}) },
            compatibilityMappingId: api.compatibilityMappingId ?? null
          }
        } : {})
      },
      (ev) => {
        if (ev.type === 'performance' && ev.performance) {
          const inputTokens = ev.performance.inputTokens
          if (inputTokens !== null && Number.isSafeInteger(inputTokens) && inputTokens >= 0) observedInputTokens = Math.max(observedInputTokens, inputTokens)
          enqueue({ type: 'performance', performance: ev.performance })
        }
        else if (ev.type === 'text') { assistantContent += ev.delta ?? ''; enqueue({ type: 'text', delta: ev.delta ?? '' }) }
        else if (ev.type === 'reasoning') { assistantReasoning += ev.delta ?? ''; enqueue({ type: 'reasoning', delta: ev.delta ?? '' }) }
        else if (ev.type === 'tool_call' && ev.tool) {
          assistantTools.set(ev.tool.index, { ...ev.tool })
          enqueue({
            type: 'tool_call',
            // Provider adapters already normalized tool events to cumulative
            // snapshots. Preserve the real provider index/call identity while
            // forwarding that snapshot; replacing is done by AgentRunEngine.
            tool: { index: ev.tool.index, id: ev.tool.id, name: ev.tool.name, arguments: ev.tool.arguments, ...(ev.tool.callId ? { callId: ev.tool.callId } : {}), ...(ev.tool.itemId ? { itemId: ev.tool.itemId } : {}) }
          })
        } else if (ev.type === 'done' && ev.usage) {
          if (Number.isSafeInteger(ev.usage.prompt_tokens) && ev.usage.prompt_tokens >= 0) observedInputTokens = Math.max(observedInputTokens, ev.usage.prompt_tokens)
          enqueue({
            type: 'usage',
            usage: {
              inputTokens: ev.usage.prompt_tokens,
              outputTokens: ev.usage.completion_tokens,
              ...(ev.usage.cache_tokens_known ? {
                cacheHitTokens: ev.usage.prompt_cache_hit_tokens,
                cacheMissTokens: ev.usage.prompt_cache_miss_tokens
              } : {}),
              ...(ev.usage.reasoning_tokens_known ? { reasoningTokens: ev.usage.reasoning_tokens } : {}),
              segmentBreakdown,
              cacheablePrefixHash
            }
          })
          enqueue(finish(ev.finishReason))
        } else if (ev.type === 'done') {
          enqueue(finish(ev.finishReason))
        }
      },
      signal,
      undefined,
      undefined,
      (event) => opts.onProviderAttempt?.({
        runId: input.runId,
        logicalCallId,
        actor: purpose,
        subtype,
        stageId: input.phase,
            providerId,
            endpointOrigin,
            modelId: api.model,
            adapterId: api.adapterId ?? null,
            profileId: api.profileId ?? null,
            credentialRefId: api.credentialRefId ?? null,
            appliedMappings: api.appliedMappings ?? [],
            omittedControls: api.omittedControls ?? [],
            contextManifestId: contextV2?.manifestId ?? null,
            contextMode: contextV2?.mode ?? null,
            event
          }),
      async (innerAttempt, request) => {
        if (request) { lastRequestBody = request.bodyJson; finalOutputReserve = requestPlan.maxTokens; observedInputTokens = 0 }
        // Recheck after manifest persistence and before *each* real attempt;
        // a concurrent head/source mutation must result in zero provider calls
        // for that attempt.
        sceneWorkingSetFence?.(fullMessages, 'postbind')
        const boundary = {
          runId: input.runId,
          logicalCallId,
          actor: purpose,
          stageId: input.phase,
          innerAttempt,
          request,
          costQuote: request ? estimateMaximumProviderCost(api.pricing ?? null, request.bodyJson, request.maxTokens) : undefined
        }
        // The engine owns the durable hard budget. Top up its reservation from
        // the exact final wire body before any observer or real fetch. Keep
        // the optional host hook, but never invoke the same hook twice.
        await input.beforeProviderAttempt?.(boundary)
        if (opts.beforeProviderAttempt !== input.beforeProviderAttempt) await opts.beforeProviderAttempt?.(boundary)
      }
    )
      .then(() => {
        streamDone = true
        wake?.(); wake = undefined
      })
      .catch((e: unknown) => {
        streamError = e as Error
        streamDone = true
        wake?.(); wake = undefined
      })

    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<ModelEvent> {
        for (;;) {
          while (queue.length > 0) yield queue.shift() as ModelEvent
          if (streamError) throw streamError
          if (streamDone) return
          await new Promise<void>((resolve) => { wake = resolve })
        }
      }
    }
  }
}

// ---------------- toolExecutor：executeTool 包装（协作取消） ----------------

export interface ToolExecOpts {
  searchConversation?: (runId: string, args: Record<string, unknown>, readBudgetChars?: number) => ConversationSearchPage
  readAttachedZip?: (runId: string, args: Record<string, unknown>, signal?: AbortSignal, readBudgetChars?: number) => Promise<string | (Pick<ToolResult, 'message' | 'sources'> & { ok?: boolean })>
  getSignal: (runId: string) => AbortSignal | undefined
  getEnv: (runId: string) => { goalMode?: 'guided' | 'autonomous'; pagedFileReads?: boolean; workDir: string; docDir: string; permissionMode?: import('../shared/types').PermissionMode; permissionWorkspaceRoot?: string; sessionId: string; signal?: AbortSignal; webContentsId?: number }
  /** R4.3 Gate 2：快照工具白名单（executor 双层强制第二层）；undefined 表示无快照约束（兼容异常路径） */
  getAllowList?: (runId: string) => string[] | undefined
  getProviderWeb?: (runId: string, toolCallId: string, hooks?: ToolExecutionHooks) => ProviderWebToolExecutor | undefined
}

/** Compute a conservative pre-fetch upper quote from the exact serialized
 * envelope and a frozen price snapshot. UTF-8 bytes are intentionally treated
 * as a worst-case token count (never an optimistic chars/token estimate), and
 * the higher input rate is used because cache hit/miss is not known yet. */
function estimateMaximumProviderCost(pricing: PricingRecord | null, bodyJson: string, maxTokens: number): ProviderCostQuote {
  if (!pricing || pricing.unit !== 'per_1m_tokens' || pricing.inputMissPerMillion === null || pricing.cacheHitPerMillion === null || pricing.outputPerMillion === null) {
    return { status: 'unknown', amount: null, currency: null, priceSnapshotId: null }
  }
  const currency = pricing.currency.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9_-]{0,15}$/.test(currency) || !Number.isFinite(maxTokens) || maxTokens < 0) {
    return { status: 'unknown', amount: null, currency: null, priceSnapshotId: null }
  }
  const bodyBytes = Buffer.byteLength(bodyJson, 'utf8')
  const inputRate = Math.max(pricing.inputMissPerMillion, pricing.cacheHitPerMillion)
  const outputRate = pricing.outputPerMillion + (pricing.reasoningBillingRule === 'separate' ? (pricing.reasoningPerMillion ?? 0) : 0)
  if (!Number.isFinite(bodyBytes) || !Number.isFinite(inputRate) || !Number.isFinite(outputRate) || inputRate < 0 || outputRate < 0) {
    return { status: 'unknown', amount: null, currency: null, priceSnapshotId: null }
  }
  const amount = (bodyBytes * inputRate + Math.ceil(maxTokens) * outputRate) / 1_000_000
  if (!Number.isFinite(amount) || amount < 0) return { status: 'unknown', amount: null, currency: null, priceSnapshotId: null }
  return { status: 'estimated', amount, currency, priceSnapshotId: pricing.id }
}

export function createToolExecutor(opts: ToolExecOpts) {
  return async (name: string, argsJson: string, toolCallId: string, runId: string, hooks?: ToolExecutionHooks): Promise<string> => {
    const signal = opts.getSignal(runId)
    if (signal?.aborted) throw new Error('已取消')
    // R4.3 Gate 2（B-02）：executor 双层强制——快照白名单外工具拒绝（伪造 tool call 也拦得住）
    const allowList = opts.getAllowList?.(runId)
    if ((allowList || name === WORK_PLAN_TOOL || name === CONVERSATION_SEARCH_TOOL || isWebTool(name) || isWorkFileTool(name)) && !checkToolAllowed(name, allowList)) {
      throw new Error(`工具 tool_not_allowed_by_mode: ${name} 不在当前模式白名单（快照冻结），已拒绝执行`)
    }
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>
    } catch {
      throw new Error('工具参数 JSON 解析失败')
    }
    if (name === 'read_file' && typeof args.path === 'string' && args.path.startsWith('attachment:')) {
      if (!opts.readAttachedZip) throw new Error('本次运行没有此附件；工作目录里的 ZIP 请使用文件路径')
      const read = await opts.readAttachedZip(runId, args, signal, hooks?.readBudgetChars)
      return JSON.stringify({ ok: typeof read === 'string' || read.ok !== false, ...(typeof read === 'string' ? { message: read } : { message: read.message, sources: parseFileSources(read.sources) }), exitCode: null, backupId: null })
    }
    const env = opts.getEnv(runId)
    const providerWeb = isWebTool(name) ? opts.getProviderWeb?.(runId, toolCallId, hooks) : undefined
    if (isWebTool(name) && !providerWeb) throw new Error('当前运行没有冻结的供应商联网授权或预算边界，已拒绝执行')
    const readAttachment = opts.readAttachedZip ? (request: Record<string, unknown>, childBudget?: number) => {
      const requested = childBudget === undefined ? hooks?.readBudgetChars : Number.isSafeInteger(childBudget) && childBudget >= 0 ? childBudget : 0
      const budget = hooks?.readBudgetChars === undefined ? requested : requested === undefined ? hooks.readBudgetChars : Math.min(hooks.readBudgetChars, requested)
      return opts.readAttachedZip!(runId, request, signal, budget)
    } : undefined
    const res: ToolResult = await executeTool(name, args, env.docDir, { searchConversation: opts.searchConversation ? (query, budget) => opts.searchConversation!(runId, query, budget) : undefined, nonInteractiveLocalRead: hooks?.nonInteractiveLocalRead, includeFileDiff: false, pagedFileReads: env.pagedFileReads, readBudgetChars: hooks?.readBudgetChars, workDir: env.workDir, docDir: env.docDir, goalMode: env.goalMode, permissionMode: env.permissionMode, permissionWorkspaceRoot: env.permissionWorkspaceRoot, sessionId: env.sessionId, signal, webContentsId: env.webContentsId, runId, toolCallId, providerWeb, readAttachment })
    const writtenFile = res.ok && FILE_WRITE_TOOLS.some(tool => tool === name) && !(name === 'edit_file' && res.edit?.count === 0) && typeof res.path === 'string'
      ? { path: res.path, canonicalPath: await fsp.realpath(res.path).catch(() => undefined), ...(typeof res.name === 'string' ? { name: res.name } : {}), ...(typeof res.size === 'number' ? { size: res.size } : {}) } : undefined
    // R4.2 A4：backupId 随结果落库（rollback_then_retry 决策需要 checkpoint 恢复依据）
    return JSON.stringify({ ok: res.ok, message: res.message, ...(res.workPlan ? { workPlan: res.workPlan } : {}), ...(res.conversation ? { conversation: res.conversation } : {}), ...(res.edit ? { edit: res.edit } : {}), ...(res.editUndo ? { editUndo: res.editUndo } : {}),
      ...(res.editRecovery ? { editRecovery: res.editRecovery } : {}),
      ...(writtenFile ?? {}),
      ...(FILE_EVIDENCE_TOOLS.some(tool => tool === name) && res.sources?.length ? { sources: parseFileSources(res.sources) } : {}), exitCode: res.exitCode ?? null, backupId: res.backupId ?? null })
  }
}

// ---------------- RunEngineEvent → ChunkEvent（R4.1：增量协议 + terminal exactly-once） ----------------

export interface ChunkTranslator {
  (ev: {
    type: string
    turn?: { turnId?: string; role: string; content: string; reasoningContent?: string; toolCallsJson?: string }
    content?: string
    revision?: number
    contentHash?: string
    performance?: ProviderPerformanceSnapshot
    toolCall?: ToolCallRecord
    phase?: string
    usage?: {
      inputTokens?: number
      outputTokens?: number
      cacheHitTokens?: number
      cacheMissTokens?: number
      reasoningTokens?: number
      revision?: number
      kind?: 'partial' | 'actual'
      segmentBreakdown?: Array<{ label: string; tokens: number; cacheable: boolean }>
      cacheablePrefixHash?: string
    }
    run?: RunRecord
    completion?: { subtype: string; state: string; revision: number; measuredChars?: number; targetChars?: number; validatorPassed?: number; validatorTotal?: number; remainingWork: Array<{ code: string; message: string }>; blockedReason?: string; pausedMessage?: string }
  }, runId: string, planMode?: boolean): ChunkEvent[]
}

/**
 * 创建带状态的事件转换器（R4.1 / B-03）：
 * - text 事件只携带**新增 delta**（引擎 turn 事件是累计快照，不得整体标成 delta）；
 * - terminal exactly once（EVENT-TERMINAL-01）；终态后清理增量状态。
 */
export function createChunkTranslator(): ChunkTranslator {
  // 偏移必须绑定到 assistant turn，而不是只绑定 run：完成门续作会新建
  // assistant turn，其累计正文从 0 开始；沿用上一轮 offset 会吞掉新轮前缀。
  // 同一 turn 的 resume 仍保留 offset，避免重连/重复 checkpoint 重发正文。
  const sent = new Map<string, { turnId?: string; sentLen: number; sentReasoningLen: number }>()
  const seenTerminal = new Set<string>()
  return (ev, runId, planMode = false) => {
    // terminal 后的迟到 turn/replace/tool 一律丢弃，避免完成正文被旧修订覆盖。
    if (seenTerminal.has(runId)) return []
    switch (ev.type) {
      case 'performance':
        return ev.performance ? [{ type: 'performance', performance: ev.performance }] : []
      case 'turn': {
        const t = ev.turn
        if (!t || t.role !== 'assistant') return []
        const chunks: ChunkEvent[] = []
        const previous = sent.get(runId)
        // 旧事件没有 turnId 时保持 run 级兼容；生产事件总是带真实 turnId。
        const sameTurn = previous !== undefined &&
          (t.turnId === undefined || previous.turnId === undefined || previous.turnId === t.turnId)
        const prev = sameTurn ? previous.sentLen : 0
        // These are offsets into the same cumulative UTF-16 string, not
        // user-visible character counts. Slicing only the new tail avoids
        // allocating the entire manuscript again at every checkpoint. It
        // also preserves a surrogate pair split across two checkpoints.
        const currentLen = t.content.length
        const delta = t.content.slice(prev)
        const nextSentLen = sameTurn ? Math.max(prev, currentLen) : currentLen
        if (delta) chunks.push({ type: 'text', delta })
        // reasoning：R4.1 STREAM-REASONING-01——provider 实际返回的 reasoning 增量转发（不伪造）
        if (t.reasoningContent) {
          const prevR = sameTurn ? previous.sentReasoningLen : 0
          const rDelta = t.reasoningContent.slice(prevR)
          if (rDelta) chunks.push({ type: 'reasoning', delta: rDelta })
          const nextReasoningLen = sameTurn
            ? Math.max(prevR, t.reasoningContent.length)
            : t.reasoningContent.length
          sent.set(runId, { turnId: t.turnId, sentLen: nextSentLen, sentReasoningLen: nextReasoningLen })
        } else {
          sent.set(runId, { turnId: t.turnId, sentLen: nextSentLen, sentReasoningLen: sameTurn ? previous.sentReasoningLen : 0 })
        }
        return chunks
      }
      case 'content_replace': {
        sent.delete(runId)
        return [{ type: 'text_replace', delta: ev.content, replaceRevision: ev.revision, contentHash: ev.contentHash }]
      }
      case 'tool': {
        const tc = ev.toolCall
        if (!tc) return []
        if (tc.status === 'requested') {
          return [{ type: 'tool_call', tool: { index: 0, id: tc.toolCallId, name: tc.name, arguments: tc.argsJson } }]
        }
        const decoded = decodeToolResult(tc)
        const { ok, exitCode } = decoded
        const sourceCount = ok && FILE_EVIDENCE_TOOLS.some(tool => tool === tc.name) ? parseFileSources(unwrapToolResult(tc.resultJson).payload?.sources).length : 0
        const change = tc.name === 'edit_file' ? appliedFileChange(tc) : undefined
        const result = decoded.result
        const editReceipt = change?.before !== undefined && change.after !== undefined ? { before: change.before, after: change.after } : undefined
        const undo = unwrapToolResult(tc.resultJson).payload?.editUndo as import('../shared/editUndo').FileEditUndoMetadata | undefined
        const editUndo = change && undo?.schemaVersion === 1 && undo.runId === runId && undo.toolCallId === tc.toolCallId
          ? { sessionId: undo.sessionId, runId, toolCallId: tc.toolCallId, status: 'available' as const } : undefined
        return [
          {
            type: 'tool_result',
            toolResult: { toolId: tc.toolCallId, name: tc.name, ok, result, ...(sourceCount ? { sourceCount } : {}), ...(editReceipt ? { editReceipt } : {}), ...(editUndo ? { editUndo } : {}), durationMs: tc.completedAt && tc.startedAt ? tc.completedAt - tc.startedAt : 0, exitCode }
          }
        ]
      }
      case 'usage': {
        // R4.2 A6（S-06）：独立 usage chunk——metrics 与 lifecycle 分离，
        // 不再伪装 done/usage_snapshot；terminal 后迟到 usage 丢弃（防重复累计）
        const u = ev.usage
        if (!u) return []
        return [
          {
            type: 'usage',
            usageChunk: {
              revision: u.revision ?? 1,
              kind: u.kind ?? 'actual',
              inputTokens: u.inputTokens ?? 0,
              outputTokens: u.outputTokens ?? 0,
              cacheHitTokens: u.cacheHitTokens ?? 0,
              cacheMissTokens: u.cacheMissTokens ?? 0,
              reasoningTokens: u.reasoningTokens ?? 0,
              segmentBreakdown: u.segmentBreakdown,
              cacheablePrefixHash: u.cacheablePrefixHash
            }
          }
        ]
      }
      case 'completion': {
        // R4.4 Gate 3：completion 客观进度转发（不改变 lifecycle；terminal 后迟到丢弃——与 usage 同规则）
        const c = ev.completion
        if (!c) return []
        return [
          {
            type: 'completion',
            completionChunk: {
              revision: c.revision,
              subtype: c.subtype,
              state: c.state,
              measuredChars: c.measuredChars,
              targetChars: c.targetChars,
              validatorPassed: c.validatorPassed,
              validatorTotal: c.validatorTotal,
              remainingWork: c.remainingWork ?? [],
              blockedReason: c.blockedReason,
              pausedMessage: c.pausedMessage
            }
          }
        ]
      }
      case 'terminal': {
        const run = ev.run
        if (!run) return []
        // A recovery terminal is a durable pause, not the end of the
        // renderer stream: an explicit user decision may resume the same run
        // and emit another assistant turn.  Keep the translator reopenable
        // for that path; completed/failed/cancelled remain exactly-once.
        if (!['recovery_required', 'waiting_user', 'paused'].includes(run.status)) seenTerminal.add(runId)
        sent.delete(runId)
        if (run.status === 'completed') {
          if (planMode) return [{ type: 'plan_ready', plan: { planId: `plan_${run.runId}`, text: '' } }]
          return [{ type: 'done', finishReason: 'stop', usage: null }]
        }
        if (run.status === 'cancelled') return [{ type: 'done', finishReason: 'stopped', usage: null }]
        if (run.status === 'recovery_required') return [{ type: 'done', finishReason: 'error', usage: null, delta: '运行需人工恢复：存在未确认的工具副作用，不会自动重放' }]
        return [{ type: 'done', finishReason: 'error', usage: null, delta: run.errorMessage ?? '运行失败' }]
      }
      default:
        return []
    }
  }
}

/** 无状态版（兼容旧引用；R4.1 生产路径使用 createChunkTranslator） */
export function engineEventToChunk(ev: Parameters<ChunkTranslator>[0], planMode = false): ChunkEvent[] {
  return createChunkTranslator()(ev, 'legacy', planMode)
}
