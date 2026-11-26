// ==================== R21-R02 / Codex P0-02：chat 编排可注入层 ====================
// 目标：生产 handler（index.ts registerIpc('chat:start')）与 eval candidate 必须运行
// 同一份编排实现（runtime 复用），禁止"读源码 hash 冒充 runtime 复用"。
//
// 设计（单一实现，零复制）：
//   createChatOrchestration(deps).handleChatStart(payload) 是唯一编排入口。
//   事务 → engine.start → void step 的事务/幂等/装载语义**全部委托**给 chatStart.startChatRun
//   （PERSIST-ATOMIC-02 权威实现），本模块只负责：
//     1) 内存幂等（startedChats 由调用方注入，缺省内部 Map）；
//     2) buildConfig 快照构建闭包（由 deps.buildConfig 注入）；
//     3) instrumentation spy 挂点（生产与 eval 用同一 function identity 计数）。
//   这样 chatStart.startChatRun 仍是唯一落库实现，orchestration 不复制第二份。
//
// 注意：本模块不 import electron，可被 electron-shim 直接 bundle 加载（同 chatStart）。

import { startChatRun } from './chatStart'
import type { ChatStartPayload } from './chatStart'
import type { Repository, AcceptChatStartHooks } from './db/repository'
import type { AgentRunEngine } from './jobs/AgentRunEngine'
import type { Settings } from '../shared/types'

// ---- runtime spy 挂点（生产与 eval 共用同一形状；function identity 由调用方断言） ----
export interface OrchestrationInstrumentation {
  /** 编排入参（handleChatStart 被调用即记录；payload.id 必在） */
  onOrchestrationStart?(payload: ChatStartPayload): void
  /** engine.start 成功装载后回调 */
  onRunStarted?(runId: string): void
  /** engine.step 触发后回调（void fire-and-forget，不代表完成） */
  onStep?(runId: string): void
}

export interface ChatOrchestrationDeps {
  repository: Repository
  runKernel: AgentRunEngine
  loadSettings(): Promise<Settings>
  /** 构建 run 的不可变执行快照；幂等键 clientRequestId 必须进 config（由 buildExecutionSnapshot 负责） */
  buildConfig(
    payload: ChatStartPayload,
    settings: Settings,
    sessionId: string
  ): Promise<Record<string, unknown>>
  instrumentation?: OrchestrationInstrumentation
  /** 内存幂等判定/登记（生产传 startedChats；缺省内部 Map，保证单实例内幂等一致） */
  startedChats?: Set<string>
  failureHooks?: AcceptChatStartHooks
}

export interface ChatOrchestrationHandle {
  handleChatStart(payload: ChatStartPayload): Promise<{
    runId: string
    acceptedAt: number
    status: 'queued' | 'recoverable'
    idempotent: boolean
  }>
  /** 供红测断言 function identity：生产与 eval 导出同一函数引用 */
  __orchestrationFingerprint: string
}

/** 模块级稳定指纹（同一 bundle 内恒等；跨 bundle 相等则证明存在源码级同一实现契约） */
export const ORCHESTRATION_FINGERPRINT = 'chatOrchestration.handleChatStart@R21-R02'

/**
 * 创建 chat 编排句柄。返回对象是生产与 eval 共用的单一实现：
 * production index.ts 与 eval runner 都只调用 `handleChatStart`（同一函数），
 * 差异仅在于注入的 deps（真 repository/engine 或临时 SQLite + mock SSE）。
 *
 * R23-R06-spy：handleChatStart 调用计数不再用手工自增的模块级 hitCounters，
 * 改由 instrumentation.onOrchestrationStart 回调（handleChatStart 入口第一条语句处触发）
 * 作为唯一权威计数来源——spy 从真实 instrumentation 事件读出 called/count。
 */
export function createChatOrchestration(deps: ChatOrchestrationDeps): ChatOrchestrationHandle {
  const startedChats = deps.startedChats ?? new Set<string>()
  const ackStatus = (status: string): 'queued' | 'recoverable' =>
    ['recoverable', 'recovery_required', 'waiting_user', 'cancel_requested', 'cancelling'].includes(status) ? 'recoverable' : 'queued'

  const handleChatStart = async (payload: ChatStartPayload): Promise<{
    runId: string
    acceptedAt: number
    status: 'queued' | 'recoverable'
    idempotent: boolean
  }> => {
    deps.instrumentation?.onOrchestrationStart?.(payload)
    // 内存快速幂等。只在 durable run 已存在时返回 ACK；否则让原子 DB
    // 接受路径决定，避免事务尚未提交时凭内存集合伪造 queued。
    if (startedChats.has(payload.id)) {
      const existing = deps.repository.getRun(payload.id)
      if (existing) {
        if (['completed', 'failed', 'cancelled'].includes(existing.status)) {
          throw new Error(`请求已结束（${existing.status}），请重新发起`)
        }
        return { runId: existing.run_id, acceptedAt: existing.started_at, status: ackStatus(existing.status), idempotent: true }
      }
      startedChats.delete(payload.id)
    }
    startedChats.add(payload.id)

    try {
      // 单一实现：事务/engine.start/step 全部委托 chatStart.startChatRun（PERSIST-ATOMIC-02）。
      const settings = await deps.loadSettings()
      // buildConfig 闭包同时把快照交给调用层（kernelConfigs/floatingRunState 由调用方在 resolve 后装载）。
      const result = await startChatRun(
        {
          repository: deps.repository,
          runKernel: deps.runKernel,
          loadSettings: async () => settings,
          buildConfig: async (p, _s, sessionId) => await deps.buildConfig(p as ChatStartPayload, settings as never, sessionId)
        },
        payload,
        deps.failureHooks
      )
      deps.instrumentation?.onRunStarted?.(result.runId)
      // engine.step 已在 startChatRun 内部 fire-and-forget 触发；这里再挂 instrumentation 计数
      deps.instrumentation?.onStep?.(result.runId)
      return {
        runId: result.runId,
        acceptedAt: result.acceptedAt,
        status: result.status,
        idempotent: result.idempotent === true
      }
    } catch (err) {
      startedChats.delete(payload.id)
      throw err
    }
  }

  return {
    handleChatStart,
    __orchestrationFingerprint: ORCHESTRATION_FINGERPRINT
  }
}
