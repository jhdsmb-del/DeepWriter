import { createHash, randomBytes } from 'node:crypto'
import { deriveProviderCallBudget, type ProviderCallBudgetInput } from './executionSnapshot'
import { frozenExecutableProfiles, type FrozenStageProfileSnapshots, type PricingRecord } from '../shared/providerRegistry'
import type { DesktopCostChallenge, DesktopCostDecision } from '../shared/ipcSchemas'

type ScopeInput = {
  senderId: number
  payload: Record<string, unknown>
  config: Record<string, unknown>
  /** Digest of settings-file bytes, not the key or its decrypted value. */
  settingsIdentity: string
  /** Only a newly built desktop snapshot may enter this gate. */
  existingRun: boolean
  /** Main-process desktop policy, never accepted from renderer payloads.
   * Missing reference prices are accounting metadata, not a sending permission. */
  missingPricePolicy?: 'confirm' | 'bounded_requests'
}

export class DesktopCostConsentError extends Error {
  readonly code = 'cost_confirmation_invalid'
  constructor() { super('费用确认已失效或请求已变化，请保留草稿并重新发送确认') }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item ?? null)).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function scopeHash(input: ScopeInput): string {
  const payload = { ...input.payload }
  delete payload.unknownCostConsent
  const config = structuredClone(input.config)
  // These are issuance timestamps, not request semantics. Everything else,
  // including full frozen profiles/price identities, context and asset hashes,
  // must match the fresh candidate on confirmation.
  delete config.createdAt
  if (config.completionContract) delete (config.completionContract as Record<string, unknown>).createdAt
  if (config.providerProfileSnapshots) delete (config.providerProfileSnapshots as Record<string, unknown>).frozenAt
  if (config.credentialRef) delete (config.credentialRef as Record<string, unknown>).issuedAt
  return createHash('sha256').update(canonical({ senderId: input.senderId, payload, config, settingsIdentity: input.settingsIdentity })).digest('hex')
}

function pricingInput(config: Record<string, unknown>): ProviderCallBudgetInput {
  const budget = config.providerCallBudget as { maxCalls: number | null; maxTokens: number }
  const context = config.contextPolicy as { contextWindowTokens: number }
  const profiles = config.providerProfileSnapshots as FrozenStageProfileSnapshots | undefined
  const stages = profiles ? frozenExecutableProfiles(profiles) : []
  return {
    maxCalls: budget.maxCalls,
    maxTokens: budget.maxTokens,
    maxInputTokens: Math.max(context.contextWindowTokens, ...stages.map((stage) => stage.contextBudget?.contextWindowTokens ?? stage.model.contextWindow ?? 0)),
    maxOutputTokens: Math.max(config.maxTokens as number, ...stages.map((stage) => stage.generation.maxOutputTokens)),
    pricingSnapshots: stages.length ? stages.map((stage) => stage.model.pricing ?? null) : (config.providerPricingSnapshots as PricingRecord[] | undefined) ?? []
  }
}

/** Only intact automatic budget derivations qualify. Default/legacy consent
 * requires a single currency; ordinary desktop sends may also keep separate
 * currency accounting without inventing a conversion or a money cap. */
export function desktopMissingPriceEligible(config: Record<string, unknown>, allowMixedCurrencies = false): boolean {
  const budget = config.providerCallBudget as Record<string, unknown> | undefined
  if (!budget || !config.contextPolicy || typeof config.maxTokens !== 'number') return false
  const maxCost = budget.maxCost as { amount?: unknown; currency?: unknown; unknownPolicy?: unknown } | undefined
  if (!maxCost || maxCost.amount !== 0 || maxCost.currency !== null || maxCost.unknownPolicy !== 'deny' || budget.maxCostCny !== undefined) return false
  const input = pricingInput(config)
  if (!(Number.isFinite(input.maxInputTokens) && Number(input.maxInputTokens) > 0 && Number.isFinite(input.maxOutputTokens) && Number(input.maxOutputTokens) > 0)) return false
  const derived = deriveProviderCallBudget(input)
  // The candidate must still be the exact automatic snapshot budget, not a
  // manually amended hard cap or a completion-contract override.
  if (canonical(budget) !== canonical(derived)) return false
  const completion = config.completionContract as { providerCallBudget?: unknown } | undefined
  if (completion?.providerCallBudget && canonical(completion.providerCallBudget) !== canonical(budget)) return false
  const records = input.pricingSnapshots ?? []
  const profiles = config.providerProfileSnapshots as FrozenStageProfileSnapshots | undefined
  const stages = profiles ? frozenExecutableProfiles(profiles) : []
  if (profiles && stages.length === 0) return false
  // Unknown model specs may use the bounded budget frozen by main. This is
  // not a guessed price or a model capability claim; the same input/output
  // limits still govern preview and runtime after one-run cost consent.
  if (stages.some((stage) => {
    const window = stage.contextBudget?.contextWindowTokens ?? stage.model.contextWindow
    const output = stage.generation.maxOutputTokens
    if (!Number.isInteger(window) || Number(window) <= 0 || Number(window) > 10_000_000 || !Number.isInteger(output) || output <= 0 || output >= Number(window)) return true
    if (stage.contextBudget && stage.contextBudget.outputReserveTokens !== output) return true
    if (stage.contextBudget?.source === 'conservative_default' && (window !== 8192 || output > 2048)) return true
    return false
  })) return false
  const currencies = new Set<string>()
  let missing = records.length === 0
  for (const record of records) {
    if (!record) { missing = true; continue }
    if (!['official_provider', 'user_supplied'].includes(record.source) || record.unit !== 'per_1m_tokens' || !record.id || !record.providerId || !record.remoteModelId || !record.canonicalOrigin || typeof record.currency !== 'string') return false
    let identityMatches = false
    try {
      identityMatches = stages.length > 0
        ? stages.some((stage) => stage.provider.id === record.providerId && stage.model.remoteModelId === record.remoteModelId && new URL(stage.provider.baseUrl).origin === record.canonicalOrigin)
        : record.remoteModelId === config.model && new URL(config.baseUrl as string).origin === record.canonicalOrigin
    } catch { return false }
    if (!identityMatches) return false
    if (record.source === 'official_provider' && (!record.sourceUrl?.trim() || !record.retrievedAt?.trim())) return false
    if (!/^[A-Z][A-Z0-9_-]{0,15}$/.test(record.currency.trim().toUpperCase())) return false
    currencies.add(record.currency.trim().toUpperCase())
    const expectedHash = createHash('sha256').update(JSON.stringify({ ...record, id: undefined, priceProfileHash: undefined })).digest('hex')
    if (record.priceProfileHash !== expectedHash) return false
    if (!['unknown', 'included_in_output', 'separate'].includes(record.reasoningBillingRule)) return false
    const rates = [record.inputMissPerMillion, record.cacheHitPerMillion, record.outputPerMillion,
      ...(record.reasoningBillingRule === 'separate' ? [record.reasoningPerMillion] : [])]
    if (rates.some((rate) => rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0))) return false
    if (rates.some((rate) => rate === null) || record.reasoningBillingRule === 'unknown') missing = true
  }
  return (missing && currencies.size <= 1) || (allowMixedCurrencies && currencies.size > 1)
}

/** Preserve legacy one-use confirmation when requested. Desktop sends may
 * proceed with call/token limits when only the reference price is missing;
 * an explicit monetary cap is never eligible for this policy. */
export class DesktopCostConsentGate {
  private readonly pending = new Map<string, { senderId: number; hash: string; challenge: DesktopCostChallenge }>()
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 120_000) {}

  prepare(input: ScopeInput): { status: 'allowed'; config: Record<string, unknown> } | { status: 'cost_confirmation_required'; challenge: DesktopCostChallenge } {
    const decision = input.payload.unknownCostConsent as DesktopCostDecision | undefined
    const at = this.now()
    for (const [nonce, value] of this.pending) if (value.challenge.expiresAt <= at) this.pending.delete(nonce)
    if (input.existingRun) throw new DesktopCostConsentError()
    const eligible = desktopMissingPriceEligible(input.config, input.missingPricePolicy === 'bounded_requests')
    if (decision) {
      const pending = this.pending.get(decision.nonce)
      if (!pending || pending.senderId !== input.senderId) throw new DesktopCostConsentError()
      // Consume synchronously before any await/accept/key resolution. A failed
      // comparison also requires a fresh visible confirmation.
      this.pending.delete(decision.nonce)
      if (decision.decision !== 'accept_unknown_cost' || !eligible || pending.hash !== scopeHash(input)) throw new DesktopCostConsentError()
      const config = structuredClone(input.config)
      const budget = { ...(config.providerCallBudget as Record<string, unknown>), maxCost: null, maxCostCny: null }
      config.providerCallBudget = budget
      if (config.completionContract) config.completionContract = { ...(config.completionContract as Record<string, unknown>), providerCallBudget: budget }
      config.desktopCostAuthorization = {
        version: 1, decision: 'accept_unknown_cost', clientRequestId: input.payload.id,
        scopeHash: pending.hash, authorizedAt: at, amountCapGuaranteed: false,
        maxCalls: pending.challenge.maxCalls, maxTokens: pending.challenge.maxTokens
      }
      return { status: 'allowed', config }
    }
    if (!eligible) return { status: 'allowed', config: input.config }
    if (input.missingPricePolicy === 'bounded_requests') {
      const config = structuredClone(input.config)
      const budget = { ...(config.providerCallBudget as { maxCalls: number | null; maxTokens: number }), maxCost: null, maxCostCny: null }
      config.providerCallBudget = budget
      if (config.completionContract) config.completionContract = { ...(config.completionContract as Record<string, unknown>), providerCallBudget: budget }
      config.desktopCostAuthorization = {
        version: 1, decision: 'bounded_requests_without_price', clientRequestId: input.payload.id,
        amountCapGuaranteed: false,
        maxCalls: budget.maxCalls, maxTokens: budget.maxTokens
      }
      return { status: 'allowed', config }
    }
    // A session identity is required for a stable retry; chat:start can create
    // one for priced legacy callers, but must not invent it after consent.
    if (typeof input.payload.sessionId !== 'string' || !input.payload.sessionId) throw new DesktopCostConsentError()
    for (const [nonce, value] of this.pending) if (value.senderId === input.senderId) this.pending.delete(nonce)
    // At most 64 live prompts across desktop senders; fail closed at capacity.
    if (this.pending.size >= 64) throw new DesktopCostConsentError()
    const budget = input.config.providerCallBudget as { maxCalls: number | null; maxTokens: number }
    const challenge = { nonce: randomBytes(32).toString('hex'), runId: input.payload.id as string, expiresAt: at + this.ttlMs, maxCalls: budget.maxCalls, maxTokens: budget.maxTokens }
    this.pending.set(challenge.nonce, { senderId: input.senderId, hash: scopeHash(input), challenge })
    return { status: 'cost_confirmation_required', challenge }
  }
}
