import type { Repository } from './db/repository'
import { RUN_BUDGET_EVIDENCE_KIND, validBudgetState } from './jobs/providerBudgetPolicy'
import type { RunBudgetState } from './jobs/types'

const AUTHORIZATION_KIND = 'run_provider_call_limit_authorization_v1'

/** Explicit per-task authorization, shared by desktop and CLI. Never infer
 * whether an old finite value was a default. Config, ledger and authority are
 * changed atomically; no request, tool replay or counter reset happens here. */
export function removeRunCallLimit(repository: Repository, runId: string): { config: Record<string, unknown>; resume: boolean } {
  let result: { config: Record<string, unknown>; resume: boolean } | undefined
  repository.tx(() => {
    const run = repository.getRun(runId)
    if (!run) throw new Error('运行不存在')
    const config = JSON.parse(run.config_json) as Record<string, unknown>
    const previousAuthorization = repository.getRunEvidence(runId, AUTHORIZATION_KIND)
    if (previousAuthorization) {
      // A repeated click/command never restarts a running or terminal task.
      result = { config, resume: ['waiting_user', 'recoverable'].includes(run.status) && run.error_code === 'run_provider_call_cap' }
      return
    }
    if (!['waiting_user', 'recoverable'].includes(run.status) || run.error_code !== 'run_provider_call_cap') throw new Error('仅可明确解除因 Provider 调用次数上限暂停的任务；未改动授权')
    const evidence = repository.getRunEvidence(runId, RUN_BUDGET_EVIDENCE_KIND)
    const budget: unknown = evidence ? JSON.parse(evidence.json) : null
    if (!validBudgetState(budget, runId)) throw new Error('原运行预算账本缺失或损坏；拒绝重置计数后继续')
    const previousMaxCalls = budget.limits.maxCalls
    const unlimitedAgentRounds = config.runMode === 'agent' && config.longMode !== true && config.workBudgetPolicy !== 'explicit_v1'
    const authorization = {
      schemaVersion: 1, runId, authorizedBy: 'user', authorizedAt: Date.now(),
      previousMaxCalls, maxCalls: null, previousMaxTurns: config.maxTurns ?? null, unlimitedAgentRounds
    }
    config.providerCallBudget = { ...(config.providerCallBudget as Record<string, unknown> | undefined), maxCalls: null }
    if (config.completionContract && typeof config.completionContract === 'object') {
      const contract = config.completionContract as Record<string, unknown>
      config.completionContract = { ...contract, providerCallBudget: { ...(contract.providerCallBudget as Record<string, unknown> | undefined), maxCalls: null } }
    }
    // The explicit action covers the Agent's old derived loop-count gate as
    // well. Longform target/progress/repair guards are not loosened.
    if (unlimitedAgentRounds) config.maxTurns = null
    const updatedBudget: RunBudgetState = { ...budget, limits: { ...budget.limits, maxCalls: null }, updatedAt: Date.now() }
    repository.saveRunEvidence(runId, RUN_BUDGET_EVIDENCE_KIND, JSON.stringify(updatedBudget))
    repository.saveRunEvidence(runId, AUTHORIZATION_KIND, JSON.stringify(authorization))
    if (config.completionContract) {
      const contract = repository.getCompletionContract(runId)
      repository.saveCompletionContract(runId, (contract?.version ?? 0) + 1, JSON.stringify(config.completionContract))
    }
    repository.updateRun(runId, { config_json: JSON.stringify(config) })
    result = { config, resume: true }
  }, 'immediate')
  return result!
}
