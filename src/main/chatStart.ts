// ==================== R4.2 A1：真正原子的 chat accept 编排（PERSIST-ATOMIC-02） ====================
// 旧实现（B-01）：runKernel.start 先创建 run → 另起事务写 session/历史/user → 失败再 cancel。
// cancel 不是 rollback：磁盘满/唯一键冲突/DB busy/两阶段间进程被杀都会留下半成品。
//
// 本模块保证：
//  1) session + run + user turn + user message + 幂等键在单一 SQLite 事务（BEGIN IMMEDIATE）内提交；
//  2) 事务提交前绝不调用模型或工具（engine.start 必须在事务之后）；
//  3) 任一写点失败 → 整个事务回滚，数据库业务状态与调用前逐行一致；
//  4) 同 (sessionId, clientRequestId) 幂等返回同一 run；
//  5) 同 session 并发启动只有一个成功（immediate 锁串行化，无 queued/busy 孤儿）。
//
// 本模块不 import electron，可纯 Node 测试（故障注入 hooks 由测试传入）。

import type { Repository, AcceptChatStartHooks, AcceptChatStartInput, TurnRow } from './db/repository'
import { sessionTitleFromFirstMessage } from './novelSession'
import type { StrongConstraintInput } from '../shared/types'
import type { NarrativeLedgerScopeInput } from '../shared/types'
import type { ContextMode } from '../shared/contextV2'
import type { GrillMeOutline } from '../shared/grillMe'
import { canonicalizeAgentPlanApproval, acceptAgentPlanApproval, validateAgentPlanExecution } from './agentPlan'
import type { AgentPlanApproval } from '../shared/agentPlanPolicy'
import { materializeConfirmedGrillFacts } from './contextService'

/** chat:start 的入参（与 shared/ipcSchemas.ts chatStartSchema 对齐的宽松子集） */
export interface ChatStartPayload {
  id: string
  sessionId?: string
  phase?: 'plan' | 'execute'
  /** Explicit consent for this new ordinary Agent task only; never a saved default. */
  goalMode?: 'guided' | 'autonomous'
  planText?: string
  planAccess?: 'read_only'
  planApproval?: AgentPlanApproval
  story?: unknown
  longMode?: boolean
  targetChars?: number
  mode?: 'agent' | 'longwrite' | 'style' | 'galgame'
  workspace?: string
  text?: string
  attachments?: Array<{ fileRefId: string; name: string; size: number }>
  maxTurns?: number
  continueOnLength?: boolean
  /** R4.6 Gate 3：用户目标的可验证产物条件（文件存在/可解析/内容下限） */
  requiredFiles?: Array<{ path: string; kind: 'text' | 'markdown' | 'renpy'; minChars?: number }>
  /** R4.5 Gate 2：角色监护实验结构化输入（仅 longwrite 允许 enabled；参数有安全上限） */
  deepWriteExperiment?: {
    enabled: boolean
    maxConcurrent?: number
    subagentTokenRatio?: number
    characters?: Array<{
      id: string
      name: string
      bible: string
      knownFacts?: string[]
      forbiddenKnowledge?: string[]
    }>
  }
  /** 仅 longwrite 消费；主进程与用户任务/StoryConfig 合并后冻结。 */
  strongConstraints?: StrongConstraintInput
  /** R45：发送前预览与会话偏好共同冻结；主进程会校验 preview 的所有版本指纹。 */
  contextSelection?: { mode: ContextMode; preferenceRevision: number; previewId: string }
  /** R4.6 Grill Me：只能携带已确认的大纲快照；quickBypass 是用户明确选择的快速直写旁路。 */
  grillMe?: {
    /** Main-only normalization from the saved interview, not trusted wire input. */
    attachments?: Array<{ fileRefId: string; name: string; size: number; hash: string }>
    writingForm?: import('../shared/writingForm').WritingForm
    projectBrief?: string
    stateId: string
    originalTask: string
    targetChars: number
    answers: Array<{ slotId: string; value: string; source: string }>
    assumptions: string[]
    approvedOutline: GrillMeOutline
    outlineRevision: number
    outlineHash: string
    quickBypass?: boolean
  }
  quickBypass?: boolean
  /** Stable story ledger ownership; a run is only provenance. */
  storyScope?: NarrativeLedgerScopeInput
}

/** engine 最小接口（测试可注入 spy；生产传 AgentRunEngine） */
export interface ChatStartEngine {
  start(input: { sessionId: string; runId: string; config: Record<string, unknown>; alreadyCreated?: boolean; newlyAccepted?: boolean }): Promise<{ ok: boolean; error?: string }>
  step(runId: string): Promise<void>
}

export interface ChatStartDeps {
  repository: Repository
  runKernel: ChatStartEngine
  loadSettings: () => Promise<{ model: string; historyBudgetTokens?: number }>
  /** 构建 run 的不可变执行快照（A3 executionSnapshot）；幂等键必须进 config */
  buildConfig: (payload: ChatStartPayload, settings: ReturnType<ChatStartDeps['loadSettings']> extends Promise<infer T> ? T : never, sessionId: string) => Record<string, unknown> | Promise<Record<string, unknown>>
}

export type ChatStartResult =
  | { runId: string; acceptedAt: number; status: 'queued' | 'recoverable'; idempotent: boolean }
  | { runId: string; status: 'queued' | 'recoverable'; idempotent: true; acceptedAt: number }

function newId(prefix: string): string {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${t}_${r}`
}

/**
 * 事务提交后启动引擎仍可能失败（例如主进程重启/数据库读回失败）。
 * 这时 acceptChatStart 已经把 queued run 提交，不能只把异常抛给 renderer，
 * 否则 UI 显示失败而 durable runs 行会永远停在 queued，恢复列表也无法解释。
 * 诊断写入是 best-effort：不能用二次写入异常遮蔽原始启动错误。
 */
function markPostAcceptFailure(
  repository: Repository,
  runId: string,
  errorCode: string,
  errorMessage: string
): void {
  try {
    const existing = repository.getRun(runId)
    // These states carry an explicit user/recovery decision.  A late
    // start/step failure must never erase that durable meaning with a generic
    // failed status (the caller can still surface the original exception).
    if (!existing || ['completed', 'failed', 'cancelled', 'recovery_required', 'waiting_user', 'cancel_requested', 'cancelling'].includes(existing.status)) return
    repository.updateRun(runId, {
      status: 'failed',
      phase: 'failed',
      error_code: errorCode,
      error_message: errorMessage.slice(0, 1000)
    })
  } catch {
    // 保留原始启动/step 异常；诊断写失败不能再制造一个不相关的错误。
  }
}

function errorText(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return (text.trim() || fallback).slice(0, 1000)
}

/**
 * 原子接受 chat 启动。
 * 顺序：buildConfig → acceptChatStart（单事务）→ 事务成功后 engine.start(alreadyCreated) → engine.step。
 * 事务失败：抛错，engine 从未被调用，数据库无任何新业务行。
 * hooks 仅测试故障注入用（生产调用方不传）。
 *
 * R21-R02 / Codex P0-02：本函数是事务/幂等/engine.start/step 的**唯一实现**。
 * 编排层 chatOrchestration.ts 通过 createChatOrchestration → handleChatStart 委托到本函数，
 * 不复制第二份事务逻辑 —— 生产 handler 与 eval candidate 共享同一份运行时实现。
 */
export async function startChatRun(
  deps: ChatStartDeps,
  payload: ChatStartPayload,
  hooks?: AcceptChatStartHooks
): Promise<ChatStartResult> {
  payload = canonicalizeAgentPlanApproval(deps.repository, payload)
  const sessionId = payload.sessionId ?? newId('s')
  const settings = await deps.loadSettings()
  const config = await deps.buildConfig(payload, settings as never, sessionId)
  validateAgentPlanExecution(deps.repository, payload, config)
  const now = Date.now()
  const newUserText = typeof payload.text === 'string' ? payload.text : ''
  // R4.2 A5（S-05）：run 只保存新增 turn——canonical 历史不再复制为 run turns；
  // 每轮请求的上下文由 ContextAssembler 从 canonical session_messages 组装并以 manifest 引用 message IDs。
  const runRow = {
    run_id: payload.id,
    session_id: sessionId,
    status: 'queued' as const,
    phase: 'queued' as const,
    started_at: now,
    updated_at: now,
    config_json: JSON.stringify(config),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: payload.id
  }
  const userTurn: TurnRow = {
    turn_id: `${payload.id}_user`,
    run_id: payload.id,
    turn_seq: 1,
    role: 'user',
    content: newUserText,
    reasoning_content: null,
    tool_calls_json: null,
    tool_result_json: null,
    plan_state: null,
    created_at: now
  }
  const input: AcceptChatStartInput = {
    sessionId,
    title: sessionTitleFromFirstMessage(newUserText),
    model: typeof settings.model === 'string' ? settings.model : '',
    run: runRow,
    // R4.4 Gate 2（S-02）：completion contract 与 run 同事务落库（来自执行快照，权威版本化）
    completionContract: (() => {
      const cc = config.completionContract as { schemaVersion?: number } | null | undefined
      return cc ? { version: cc.schemaVersion ?? 1, json: JSON.stringify(config.completionContract) } : null
    })(),
    userTurn,
    userMsg: newUserText.trim()
      ? {
          msg_id: `m_${payload.id}_user`,
          role: 'user',
          content: newUserText,
          created_at: now
        }
      : undefined
  }
  // 1) 单事务提交（幂等/busy 判定在锁内进行）
  const accept = deps.repository.acceptChatStart(input, payload.planApproval ? { ...hooks, beforeInsertRun: () => {
    acceptAgentPlanApproval(deps.repository, payload, config)
    hooks?.beforeInsertRun?.()
  } } : hooks)
  if (!accept.ok) {
    if (accept.reason === 'duplicate') {
      // 跨主进程重启的重放也必须返回既有 run，而不是把成功提交误报为失败。
      // 不再调用 engine.start/step，避免重复启动或重复模型费用。
      const existing = deps.repository.getRun(accept.runId)
      if (!existing) throw new Error('幂等请求指向的运行记录不存在')
      // 终态 run 不能伪装成 queued：renderer 会据此建立一个永远不会收到事件的
      // 新乐观消息。用户应以新的 request id 明确重试；非终态才可安全重放 ACK。
      if (['completed', 'failed', 'cancelled'].includes(existing.status)) {
        throw new Error(`请求已结束（${existing.status}），请重新发起`)
      }
      return {
        runId: accept.runId,
        acceptedAt: existing.started_at,
        status: ['recoverable', 'recovery_required', 'waiting_user', 'cancel_requested', 'cancelling'].includes(existing.status) ? 'recoverable' : 'queued',
        idempotent: true
      }
    }
    throw new Error('同会话已有进行中的运行')
  }
  // 2) 事务提交后 engine.start（alreadyCreated：只装载不创建，run 行真实存在）
  let res: { ok: boolean; error?: string }
  try {
    // Only the actual new transaction result reaches here. Duplicate/recovery
    // paths must not recreate facts or grant a fresh scene-repair allowance.
    materializeConfirmedGrillFacts(deps.repository, config, payload.id)
    res = await deps.runKernel.start({
      sessionId,
      runId: payload.id,
      config,
      alreadyCreated: true,
      newlyAccepted: true
    })
  } catch (error) {
    const message = errorText(error, '运行引擎启动失败')
    markPostAcceptFailure(deps.repository, payload.id, 'run_engine_start_failed', message)
    throw error
  }
  if (!res.ok) {
    const message = res.error === 'session_busy'
      ? '同会话已有进行中的运行'
      : res.error
        ? `运行引擎启动失败：${res.error}`
        : '运行引擎启动失败'
    markPostAcceptFailure(deps.repository, payload.id, 'run_engine_start_rejected', message)
    throw new Error(message)
  }
  // 3) 提交后才 step
  void deps.runKernel.step(payload.id).catch((error: unknown) => {
    // step 是 fire-and-forget，必须把未被引擎内部消费的异常转为 durable failure；
    // 已经完成/取消的 run 不会被这个兜底覆盖。
    markPostAcceptFailure(deps.repository, payload.id, 'run_step_failed', errorText(error, '运行执行失败'))
  })
  return { runId: payload.id, acceptedAt: now, status: 'queued' as const, idempotent: false }
}
