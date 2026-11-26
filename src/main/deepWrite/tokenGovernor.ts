// ==================== R4.3 Gate 5 token 总督（tokenGovernor） ====================
// 纯 Node 模块（不 import electron）：控制监护者 subagent 开销。
// 规则：subagent 输入+输出投影不得超过 writerBudgetTokens × subagentTokenRatio；
// 超限则全部角色走规则卡（降级单主笔）；未超限则按场景重要度（importance 降序）
// 截断到 maxConcurrent 个活跃监护者。

/** token 总督配置（defaults：maxConcurrent=3, ratio=0.35, advice=1200, director=1200） */
export interface TokenGovernorOpts {
  maxConcurrent: number       // 默认 3
  subagentTokenRatio: number  // 默认 0.35：subagent 输入+输出不得超过主笔预算比例
  writerBudgetTokens: number
  adviceTokenCap: number      // 默认 1200/角色
  directorTokenCap: number    // 默认 1200
}

/** 总督决策结果 */
export interface GovernorDecision {
  activeCharacterIds: string[]       // 按场景重要度排序后启用（<= maxConcurrent）
  skippedCharacterIds: string[]      // 次要角色走规则卡
  allowed: boolean                   // 是否允许启动 subagents（预算允许）
  reason: string
}

/** 用默认值补全配置（writerBudgetTokens 无默认，调用方必须给定） */
export function createGovernorOpts(over: Partial<TokenGovernorOpts>): TokenGovernorOpts {
  return {
    maxConcurrent: over.maxConcurrent ?? 3,
    subagentTokenRatio: over.subagentTokenRatio ?? 0.35,
    writerBudgetTokens: over.writerBudgetTokens ?? 0,
    adviceTokenCap: over.adviceTokenCap ?? 1200,
    directorTokenCap: over.directorTokenCap ?? 1200
  }
}

/**
 * 决定监护者启用名单。
 * - projectedSubagentTokens > writerBudgetTokens × subagentTokenRatio → allowed=false，
 *   active 为空、全部角色 skipped（降级单主笔）。
 * - 预算允许 → 按 importance 降序（并列按 characterId 字典序，保证确定性）截断到 maxConcurrent。
 */
export function decideGovernor(
  opts: TokenGovernorOpts,
  present: Array<{ characterId: string; importance: number }>,
  projectedSubagentTokens: number
): GovernorDecision {
  const budget = Math.floor(opts.writerBudgetTokens * opts.subagentTokenRatio)
  const allowed = projectedSubagentTokens <= budget

  if (!allowed) {
    const skipped = present.map((p) => p.characterId)
    return {
      activeCharacterIds: [],
      skippedCharacterIds: skipped,
      allowed: false,
      reason: `subagent 投影 ${projectedSubagentTokens} > 预算 ${budget}（ratio=${opts.subagentTokenRatio}，writerBudget=${opts.writerBudgetTokens}）；跳过全部 ${skipped.length} 个角色，降级为单主笔`
    }
  }

  const sorted = [...present].sort((a, b) => b.importance - a.importance || a.characterId.localeCompare(b.characterId))
  const max = Math.max(0, Math.floor(opts.maxConcurrent))
  const active = sorted.slice(0, max).map((p) => p.characterId)
  const skipped = sorted.slice(max).map((p) => p.characterId)
  return {
    activeCharacterIds: active,
    skippedCharacterIds: skipped,
    allowed: true,
    reason: `subagent 投影 ${projectedSubagentTokens} ≤ 预算 ${budget}（ratio=${opts.subagentTokenRatio}）；启用 ${active.length}/${present.length} 个角色监护者（maxConcurrent=${max}），跳过 ${skipped.length} 个次要角色走规则卡`
  }
}
