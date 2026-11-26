import type { FrozenProviderCallBudget, ProviderCallBudgetInput } from '../src/main/executionSnapshot'

export interface EvaluationSnapshotRuntime {
  buildExecutionSnapshot(input: Record<string, unknown>): Record<string, unknown>
  deriveProviderCallBudget(input: ProviderCallBudgetInput): FrozenProviderCallBudget
}

/** Paid evaluations have their own authorization, independent of product defaults. */
export function buildEvaluationSnapshot(runtime: EvaluationSnapshotRuntime, input: Record<string, unknown>, maxCostCny?: number | null): Record<string, unknown> {
  if (maxCostCny != null && (!Number.isFinite(maxCostCny) || maxCostCny <= 0)) throw new Error('Evaluation maxCostCny must be a finite positive amount')
  const settings = input.settings as { maxTokens: number; completionTokenBudget?: number; completionWallClockMs?: number }
  // Evaluation sampling declares a real wire output cap, not just local reserve.
  const explicitInput = { ...input, settings: { ...settings, outputTokenLimit: settings.maxTokens } }
  const snapshot = runtime.buildExecutionSnapshot(explicitInput)
  const context = snapshot.contextPolicy as { contextWindowTokens: number }
  const budget = runtime.deriveProviderCallBudget({
    maxCalls: null,
    maxTokens: settings.completionTokenBudget,
    maxInputTokens: context.contextWindowTokens,
    maxOutputTokens: snapshot.maxTokens as number,
    pricingSnapshots: input.pricingSnapshots as ProviderCallBudgetInput['pricingSnapshots']
  })
  // A CNY declaration never converts another currency or supplies missing prices.
  const maxCost = maxCostCny == null ? budget.maxCost
    : budget.maxCost?.currency === 'CNY'
      ? { ...budget.maxCost, amount: Math.min(budget.maxCost.amount, maxCostCny) }
      : { amount: 0, currency: null, unknownPolicy: 'deny' as const }
  return runtime.buildExecutionSnapshot({
    ...explicitInput,
    now: snapshot.createdAt,
    workBudget: {
      maxCalls: budget.maxCalls, maxTurns: snapshot.maxTurns ?? null,
      maxTokens: budget.maxTokens, maxWallClockMs: settings.completionWallClockMs || 30 * 60 * 1000,
      maxCost
    }
  })
}
