import { createProviderWebClient, type ProviderWebAttemptEvent, type ProviderWebDependencies } from './providerWeb'
import type { FrozenCredentialReference } from '../shared/providerRegistry'
import type { ToolExecutionHooks } from './jobs/types'
import type { Repository } from './db/repository'
import { frozenRunWebAccess } from './runWebAccess'
import type { ProviderWebToolExecutor } from './publicWebTools'

/** Reuse the provider-attempt ledger consumed by billing and budget recovery.
 * The receipt is a reference estimate, not proof of the account's debit. */
function recordAttempt(repo: Repository, runId: string, toolCallId: string, event: ProviderWebAttemptEvent): void {
  const id = `${event.requestId}:1`
  if (event.type === 'started') {
    repo.startProviderAttempt({ attempt_id: id, run_id: runId, logical_call_id: event.requestId, attempt_no: 1,
      actor: 'writer', stage_id: `web:${event.operation}`, subtype: event.operation === 'search' ? 'web_search' : 'read_web_page',
      provider_id: event.providerId, provider_endpoint_origin: event.endpointOrigin, model_id: event.modelId, provider_request_id: null,
      outcome: 'in_flight', http_status: null, started_at: event.startedAt, first_token_at: null, ended_at: null,
      input_tokens: null, output_tokens: null, cache_hit_tokens: null, cache_miss_tokens: null, reasoning_tokens: null,
      cost_status: 'unknown', cost_amount: null, cost_currency: event.costQuote.currency, price_snapshot_id: event.costQuote.priceSnapshotId,
      adapter_id: null, profile_id: event.profileId, credential_ref_id: event.credentialRefId,
      applied_mappings_json: '[]', omitted_controls_json: '[]', context_manifest_id: null, context_mode: null })
  } else {
    const amount = event.billable === false ? 0 : event.costAmount
    repo.finishProviderAttempt(id, { outcome: event.outcome === 'invalid_response' ? 'transport_error' : event.outcome, http_status: event.httpStatus, provider_request_id: null, ended_at: event.endedAt,
      input_tokens: event.usage?.inputTokens ?? null, output_tokens: event.usage?.outputTokens ?? null,
      cache_hit_tokens: event.usage?.cacheReadTokens ?? null, cache_miss_tokens: null, reasoning_tokens: null,
      cost_status: amount === null ? 'unknown' : event.billable === false ? 'actual' : 'estimated', cost_amount: amount,
      cost_currency: event.costQuote.currency, price_snapshot_id: event.costQuote.priceSnapshotId })
  }
  repo.saveRunEvidence(runId, `provider_web:${toolCallId}:${event.requestId}`, JSON.stringify({ runId, toolCallId, ...event }))
}

export function createRunProviderWeb(input: {
  repository: Repository
  runId: string
  toolCallId: string
  config: Record<string, unknown>
  resolveCredential: (reference: FrozenCredentialReference) => string | Promise<string>
  hooks?: ToolExecutionHooks
  /** Fixture-only transport and DNS seams; never persisted or renderer supplied. */
  dependencies?: Pick<ProviderWebDependencies, 'transport' | 'lookup'>
}): ProviderWebToolExecutor | undefined {
  const access = frozenRunWebAccess(input.config)
  if (!access || !input.hooks) return undefined
  const client = createProviderWebClient({ ...input.dependencies, resolveCredential: input.resolveCredential,
    beforeRequest: boundary => input.hooks!.beforeProviderRequest(boundary.requestId, boundary.costQuote),
    onAttempt: event => recordAttempt(input.repository, input.runId, input.toolCallId, event) })
  return { execute: async (operation, args, signal) => {
    if (!access.grant.operations.includes(operation)) throw new Error('本次运行未冻结授权此联网操作')
    return client.execute({ profile: access.profile, operation, args, signal, billingCurrency: access.grant.billingCurrency })
  } }
}
