import { createHash } from 'node:crypto'
import type { PricingRecord } from '../src/shared/providerRegistry'
import { matchPriceEntry, priceProfileHash, priceProfileValidate, type PriceProfile } from './eval-preflight'

/** Explicit owner-authorized reference configuration; never inferred official evidence. */
export interface FrozenEvalPricing {
  record: Readonly<PricingRecord>
  provenance: Readonly<{
    profileId: string; profileHash: string; providerId: string; canonicalOrigin: string
    model: string; currency: string; referenceUrl: string | null; declaredUpdatedAt: string
    officialEvidence: false
  }>
}
export const evalProfileHash = priceProfileHash
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
function canonicalOrigin(value: string): boolean {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.origin === value }
  catch { return false }
}
function referenceUrl(source: string): string | null {
  const found = source.match(/https?:\/\/[^\s\u4e00-\u9fff）)]+/)?.[0]
  if (!found) return null
  const url = new URL(found)
  if (url.username || url.password || url.search || url.hash) throw new Error('Eval price reference URL is not safe')
  return url.href
}
export function freezeEvalPricing(input: {
  profile: PriceProfile | null; providerId: string; model: string; canonicalOrigin: string
  currency: string; trustedProfileHash: string
}): FrozenEvalPricing {
  const profile = input.profile
  if (!profile || !priceProfileValidate(profile).ok || profile.unit !== 'per-1M-tokens' || !canonicalOrigin(input.canonicalOrigin) || !input.providerId || profile.providerId !== input.providerId || !/^[a-f0-9]{64}$/.test(input.trustedProfileHash) || priceProfileHash(profile) !== input.trustedProfileHash) throw new Error('Eval price profile lacks explicit trusted identity/hash authorization')
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(profile.updatedAt) || !Number.isFinite(Date.parse(profile.updatedAt))) throw new Error('Eval price profile declaration date is invalid')
  const match = matchPriceEntry(profile, input.model, input.canonicalOrigin, input.currency)
  if (!match.ok) throw new Error('Eval price profile does not match the exact request identity')
  const url = referenceUrl(profile.source)
  const base = {
    providerId: input.providerId, remoteModelId: input.model, canonicalOrigin: input.canonicalOrigin,
    currency: input.currency, unit: 'per_1m_tokens' as const, pricingTier: 'standard' as const, contextBucket: 'default' as const,
    inputMissPerMillion: match.entry.inputPer1M, cacheHitPerMillion: match.entry.cacheHitPer1M,
    cacheWritePerMillion: null, outputPerMillion: match.entry.outputPer1M, reasoningPerMillion: null,
    reasoningBillingRule: 'included_in_output' as const, source: 'user_supplied' as const,
    sourceUrl: url, effectiveAt: null, retrievedAt: ''
  }
  const priceHash = sha(JSON.stringify(base))
  const record: Readonly<PricingRecord> = Object.freeze({ id: `price.eval.${input.trustedProfileHash}.${priceHash.slice(0, 16)}`, ...base, priceProfileHash: priceHash })
  return Object.freeze({ record, provenance: Object.freeze({
    profileId: profile.profileId, profileHash: input.trustedProfileHash, providerId: input.providerId,
    canonicalOrigin: input.canonicalOrigin, model: input.model, currency: input.currency,
    referenceUrl: url, declaredUpdatedAt: profile.updatedAt, officialEvidence: false as const
  }) })
}
/** A local synthetic model has no provider bill; explicit --mock authorizes this test reference. */
export function createSyntheticEvalPriceProfile(origin: string, model: string): PriceProfile {
  if (!canonicalOrigin(origin) || new URL(origin).protocol !== 'http:' || new URL(origin).hostname !== '127.0.0.1' || !new URL(origin).port) throw new Error('Synthetic eval prices only bind the newly created local mock origin')
  return {
    schemaVersion: 1, profileId: 'eval-synthetic-local-reference', providerId: 'eval.synthetic.local',
    endpointOrigins: [origin], currency: 'CNY', unit: 'per-1M-tokens',
    source: 'Explicit --mock synthetic local positive-rate reference; not an official price or bill',
    updatedAt: new Date().toISOString().slice(0, 10), prices: [{ model, inputPer1M: 1, outputPer1M: 1, cacheHitPer1M: 1 }]
  }
}
/** Resolve only the accepted config's price, never a later mutable profile. */
export function pricingForFrozenEvalConfig(config: Record<string, unknown>, providerId: string, currency: string): PricingRecord | null {
  const prices = config.providerPricingSnapshots
  if (!Array.isArray(prices) || prices.length !== 1 || typeof config.baseUrl !== 'string') return null
  const record = prices[0] as PricingRecord | null
  if (!record || record.source !== 'user_supplied' || record.providerId !== providerId || record.remoteModelId !== config.model || record.currency !== currency || record.unit !== 'per_1m_tokens' || record.reasoningBillingRule !== 'included_in_output') return null
  try { if (new URL(config.baseUrl).origin !== record.canonicalOrigin) return null } catch { return null }
  if (![record.inputMissPerMillion, record.cacheHitPerMillion, record.outputPerMillion].every(rate => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0)) return null
  const hashPayload = { ...record, id: undefined, priceProfileHash: undefined }
  if (!record.id || record.priceProfileHash !== sha(JSON.stringify(hashPayload))) return null
  return structuredClone(record)
}
export function isEvalDurablePause(status: string | undefined): boolean {
  return status === 'waiting_user' || status === 'recovery_required'
}
