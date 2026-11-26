// ==================== R4.3 Gate 4：外部可验证完成契约（纯核心类型） ====================
// 复审 S-03：长输出没有外部完成契约——模型说"完成"或 finish_reason=stop 时，
// 系统没有证明目标字数/章节/文件/lint 满足，直接进入 completed。
// 本轮修复：completed 只能由外部可验证完成契约产生；模型输出"已完成"没有状态权限。
// 本模块不依赖 electron、不依赖项目 DB 表（repository 以接口注入），纯 Node 可测。

export type CompletionState = 'planning' | 'running' | 'validating' | 'completed' | 'continuing' | 'blocked' | 'cancelled' | 'waiting_user'

export interface Finding {
  id: string                // 确定性 validator id，如 'targetChars'
  severity: 'hard' | 'soft'
  code: string              // 如 'below_target' / 'missing_artifact' / 'pending_tool' / 'lint_failed'
  message: string
  /** 稳定指纹：同 finding 重复出现时 hash 不变（单调性检测依据） */
  hash: string
  evidence?: string
}

export interface CompletionContract {
  schemaVersion: number     // 1
  runId: string
  targetChars?: { min: number; max?: number; tolerance: number }   // 默认 tolerance 0.05
  requiredArtifacts?: Array<{ kind: string; pathRef?: string; minCount?: number }>
  /**
   * R4.6 Gate 3：用户目标的可验证产物条件（防自欺式完成）——
   * 文件必须真实存在且内容与登记 hash 一致（损坏/不可解析 → 拒绝完成）。
   */
  requiredFiles?: Array<{ path: string; kind: 'text' | 'markdown' | 'renpy'; minChars?: number }>
  validators: Array<{ id: 'targetChars' | 'requiredArtifacts' | 'noPendingTools' | 'renpyLint' | 'fileEvidence' | 'strongConstraints'; severity: 'hard' | 'soft'; config: Record<string, unknown> }>
  maxRepairAttempts: number   // 默认 3
  tokenBudget?: number
  wallClockBudgetMs?: number
  /**
   * Run-level provider budget.  The values are frozen with the execution
   * snapshot and are never increased by continuation/budget amendments.
   * `maxCalls` counts every provider attempt, including inner retries.
   */
  providerCallBudget?: {
    maxCalls: number | null
    maxTokens?: number | null
    /** Currency-safe spend cap.  Amount is never compared with another
     * currency; a missing/unknown quote is handled by unknownPolicy. */
    maxCost?: { amount: number; currency: string | null; unknownPolicy: 'deny' } | null
    /** R25 compatibility field. New runs should use maxCost. */
    maxCostCny?: number | null
    maxWallClockMs?: number | null
  }
  createdAt: number
}

export interface CompletionEvidence {
  /** 最终 artifact 的用户可见字符数（Unicode code point），不由流式 UI 提供 */
  measuredChars?: number
  /** 最新续写与既有正文的 n-gram 重复率（由真实引擎计算；高重复不得完成） */
  repetitionRatio?: number
  artifacts: Array<{ kind: string; path: string; hash: string }>
  pendingToolCount: number
  pendingToolNames: string[]
  renpyLint?: { ok: boolean; errorCount: number; warningCount: number; output: string; sdkVersion?: string }
  /** R4.6 Gate 3：artifact 内容（hash → 磁盘读回；fileEvidence 校验存在性/损坏/可解析） */
  artifactContents?: Record<string, string>
  /** R39：确定性偏移检查的结构化事实；不含正文或隐藏推理。 */
  strongConstraints?: {
    constraintHash: string
    rulesVersion: number
    draftHash: string
    latestSegmentHash: string
    violations: Array<{ code: string; category: string; message: string; severity?: 'hard' | 'soft' }>
    repairAttempt: number
  }
}

export interface CompletionEvaluation {
  revision: number
  state: CompletionState
  hardFailures: Finding[]
  softWarnings: Finding[]
  measuredChars: number | null
  artifactHashes: string[]
  remainingWork: Array<{ code: string; message: string; hash: string }>   // 结构化缺口（不是自然语言结案）
  nextAttempt?: { focus: string[]; evidenceRefs: string[] }               // 最小 delta 续作任务
  blockedReason?: string
  /** R4.5 Gate 4：pause_user 的面向用户消息（预算耗尽/低进展/达上限时给用户可操作选项） */
  pausedMessage?: string
  /** R4.4 Gate 2：评估时间（先落库再对外） */
  createdAt?: number
  /**
   * R4.5 Gate 3（复审 S-01）：durable 精确恢复字段——
   * 进入 validating 的失败候选次数（非 revision 推导；fromStore 逐字段恢复）；
   * startedAt=contract.createdAt 权威墙钟起点（重启不刷新）；finding keys 与测量值分离
   * （below_target 稳定 hash 不含 measured）；lastDeltaChars 单独记录进展。
   */
  repairAttempts?: number
  startedAt?: number
  previousFindingKeys?: string[]
  currentFindingKeys?: string[]
  latestMeasuredChars?: number | null
  lastDeltaChars?: number | null
}

export interface CompletionStore {
  saveEvaluation(runId: string, ev: CompletionEvaluation): void
  getLatestEvaluation(runId: string): CompletionEvaluation | null
}
