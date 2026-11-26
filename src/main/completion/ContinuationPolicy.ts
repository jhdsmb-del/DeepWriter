// ==================== R4.5 Gate 4：ContinuationPolicy（与完成 validator 分离） ====================
// 复审 B-03：深度写作"未达目标不停止"与实际状态机冲突——固定 maxRepairAttempts=3、循环 maxTurns
// 和 no_progress 直接 failed；低效续写无法识别（finding hash 含测量值，少量增长被视为 finding 改变）。
// 本模块：
// - 完成 validator 只判定客观条件（CompletionController.validators）；
// - continuation policy 只决策"继续/暂停等用户/阻塞/取消"——输入 target/measured/delta、
//   重复率、有效新内容比例、usage、墙钟、修复次数、pending tools、用户取消；
// - 低进展（连续 N 轮增量过小）或预算/墙钟耗尽 → 优先 pause_user（用户选择增加预算/降低目标/停止），
//   不伪 completed、不只显示笼统 failed；
// - maxRepair 达到 → pause_user（用户决定），不再是静默 failed；
// - 重复率达到硬阈值且有正增量 → 立即 pause_user，不依赖 finding 集合是否变化；
// - 纯函数、无状态、无 electron 依赖（单测友好；controller 内部维护 lowProgressRounds 水位）。

export type ContinuationDecision =
  | { decision: 'continue' }
  | { decision: 'pause_user'; reason: 'low_progress' | 'no_progress' | 'budget_exhausted' | 'max_repair_attempts' | 'user_pause'; message: string }
  | { decision: 'blocked'; reason: string; message: string }
  | { decision: 'cancelled' }

export interface ContinuationPolicyInput {
  /** 本轮实测累计字符（null=无测量，由完成 validator 负责 no_measurement） */
  measuredChars: number | null
  /** 本轮增量（measured - 上轮 measured；null=无基准） */
  lastDeltaChars: number | null
  /** finding 集合是否较上轮变化（变化=真实改善，不判停滞） */
  findingSetChanged: boolean
  /** 连续低进展轮数（delta <= lowProgressDeltaChars 的累计轮数；controller 维护） */
  lowProgressRounds: number
  /** 重复率 0-1：本轮新增内容与历史正文的 n-gram 重复比例（engine 计算；未知传 0） */
  repetitionRatio: number
  /** 有效新内容比例 0-1：1 - repetitionRatio（或由调用方直接给 effectiveDeltaChars） */
  effectiveDeltaChars: number | null
  /** 累计 token 用量（usage ledger 真实累计） */
  usageTokens: number
  tokenBudget?: number
  /** 已流逝墙钟（now - startedAt；startedAt=contract.createdAt 权威起点） */
  elapsedMs: number
  wallClockBudgetMs?: number
  repairAttempts: number
  maxRepairAttempts: number
  pendingToolCount: number
  cancelled: boolean
  /** 低进展阈值（字符）；delta 低于该值且 finding 未变视为低效续写（默认 200） */
  lowProgressDeltaChars?: number
  /** 连续低进展多少轮进入 pause_user（默认 2） */
  lowProgressPauseRounds?: number
}

/** 决策优先级：用户取消 > 预算/墙钟 > 修复上限 > 零/负增长（finding 未变）> 低进展（finding 未变）> 继续 */
export function decideContinuation(input: ContinuationPolicyInput): ContinuationDecision {
  if (input.cancelled) return { decision: 'cancelled' }

  // 预算/墙钟耗尽 → pause_user（用户选择增加预算/降低目标/停止；不伪 completed）
  if (typeof input.tokenBudget === 'number' && input.tokenBudget > 0 && input.usageTokens >= input.tokenBudget) {
    return { decision: 'pause_user', reason: 'budget_exhausted', message: `token 预算 ${input.tokenBudget} 已耗尽（累计用量 ${input.usageTokens}）：请选择增加预算、降低目标或停止` }
  }
  if (typeof input.wallClockBudgetMs === 'number' && input.wallClockBudgetMs > 0 && input.elapsedMs >= input.wallClockBudgetMs) {
    return { decision: 'pause_user', reason: 'budget_exhausted', message: `墙钟预算 ${input.wallClockBudgetMs}ms 已耗尽（已用 ${input.elapsedMs}ms）：请选择增加预算、降低目标或停止` }
  }

  // 重复正文即使恰好达到 target 也不能完成；此判断必须早于 findingSetChanged
  // 分支，否则第二轮新增 repetition_high finding 会被当成"有改善"，放行到 completed。
  const positiveDelta = input.lastDeltaChars ?? input.effectiveDeltaChars ?? 0
  if (input.repetitionRatio >= 0.85 && positiveDelta > 0) {
    return { decision: 'pause_user', reason: 'low_progress', message: '续写与已有正文高度重复，已暂停以避免用重复内容凑字数；请调整提示或停止' }
  }

  // 修复次数达到上限：达上限但仍有实质进展（delta >= 低进展阈值）→ 继续（防误杀稳定增长；
  // 上限是防失控硬上限，不是"达标前必停"）；无进展才 pause_user
  const lowDelta0 = input.lowProgressDeltaChars ?? 200
  if (input.repairAttempts >= input.maxRepairAttempts && (input.lastDeltaChars ?? 0) < lowDelta0) {
    return { decision: 'pause_user', reason: 'max_repair_attempts', message: `已达最大修复次数 ${input.maxRepairAttempts}：请选择降低目标、增加预算或停止` }
  }

  // 零/负增长且 finding 未变（写作停滞）→ pause_user（不直接 blocked——用户介入）
  if (!input.findingSetChanged && input.lastDeltaChars !== null && input.lastDeltaChars <= 0) {
    return { decision: 'pause_user', reason: 'no_progress', message: '连续两轮 hard 失败且实测字数无增长：写作陷入停滞，请选择停止或调整目标' }
  }

  // 低进展（连续多轮增量过小且 finding 未变）→ pause_user
  const lowDelta = input.lowProgressDeltaChars ?? 200
  const lowRounds = input.lowProgressPauseRounds ?? 2
  if (!input.findingSetChanged && input.lastDeltaChars !== null && input.lastDeltaChars < lowDelta && input.lowProgressRounds >= lowRounds) {
    return { decision: 'pause_user', reason: 'low_progress', message: `连续 ${input.lowProgressRounds} 轮增量过小（<${lowDelta} 字）：写作效率过低，请选择降低目标、增加预算或停止` }
  }

  return { decision: 'continue' }
}
