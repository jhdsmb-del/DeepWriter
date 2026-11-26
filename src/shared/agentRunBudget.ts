/** Ordinary Agent work limits. Model context/max output and tool concurrency are separate. */
export interface AgentRunBudgetSettings {
  maxCalls: number | null
  maxTurns: number | null
  maxTokens: number | null
  maxWallClockMs: number | null
  maxCost: { amount: number; currency: string | null; unknownPolicy: 'deny' } | null
}
export const AGENT_WORK_BUDGET_POLICY = 'explicit_v1' as const
export const LEGACY_FACTORY_COMPLETION_TOKEN_BUDGET = 200000
export function completionTokenBudgetFromStoredSettings(raw: Record<string, unknown>): number {
  if (!Object.hasOwn(raw, 'agentRunBudget') && raw.completionTokenBudget === LEGACY_FACTORY_COMPLETION_TOKEN_BUDGET) return 0
  return typeof raw.completionTokenBudget === 'number' ? raw.completionTokenBudget : 0
}
export function unlimitedAgentRunBudget(): AgentRunBudgetSettings {
  return { maxCalls: null, maxTurns: null, maxTokens: null, maxWallClockMs: null, maxCost: null }
}
export function normalizeAgentRunBudget(value: unknown): AgentRunBudgetSettings {
  if (value === undefined || value === null) return unlimitedAgentRunBudget()
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent 运行限制必须为对象')
  const raw = value as Record<string, unknown>, result = unlimitedAgentRunBudget()
  for (const key of ['maxCalls', 'maxTurns', 'maxTokens', 'maxWallClockMs'] as const) {
    const number = raw[key]
    if (number === undefined || number === null) continue
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) throw new Error(`${key} 必须为正整数，或留空关闭`)
    result[key] = number
  }
  if (raw.maxCost !== undefined && raw.maxCost !== null) {
    const cost = raw.maxCost as Record<string, unknown>
    if (!cost || typeof cost !== 'object' || typeof cost.amount !== 'number' || !Number.isFinite(cost.amount) || cost.amount < 0 || cost.unknownPolicy !== 'deny') throw new Error('金额限制必须为非负有限数，未知报价必须拒绝')
    const currency = cost.currency === null ? null : typeof cost.currency === 'string' ? cost.currency.trim().toUpperCase() : undefined
    if (currency === undefined || (currency !== null && !/^[A-Z][A-Z0-9_-]{0,15}$/u.test(currency))) throw new Error('金额限制币种无效')
    result.maxCost = { amount: cost.amount, currency, unknownPolicy: 'deny' }
  }
  return result
}
/** Pass disk fields, never a settings object already merged with defaults. */
export function agentRunBudgetFromStoredSettings(raw: Record<string, unknown>): AgentRunBudgetSettings {
  if (Object.hasOwn(raw, 'agentRunBudget')) return normalizeAgentRunBudget(raw.agentRunBudget)
  const result = unlimitedAgentRunBudget()
  if (Object.hasOwn(raw, 'completionTokenBudget') && typeof raw.completionTokenBudget === 'number' && raw.completionTokenBudget > 0 && raw.completionTokenBudget !== LEGACY_FACTORY_COMPLETION_TOKEN_BUDGET) result.maxTokens = raw.completionTokenBudget
  if (Object.hasOwn(raw, 'completionWallClockMs') && typeof raw.completionWallClockMs === 'number' && raw.completionWallClockMs > 0) result.maxWallClockMs = raw.completionWallClockMs
  return normalizeAgentRunBudget(result)
}
