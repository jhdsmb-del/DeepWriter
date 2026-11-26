import { createHash } from 'node:crypto'
import { unknownModelCapabilities, type ModelCapabilities, type PricingRecord } from '../shared/providerRegistry'

export interface DiscoveryEndpoint { id: string; baseUrl: string; modelsPath: string | null }
export interface DiscoveredProviderMetadata {
  remoteModelId: string
  displayName: string
  contextWindow: number | null
  maxOutputTokens: number | null
  capabilities: ModelCapabilities
  pricing: PricingRecord | null
  pricingReview: string[]
}
export interface ParsedProviderDiscovery {
  models: DiscoveredProviderMetadata[]
  family: 'openrouter' | 'moonshot' | 'minimax' | 'groq' | 'azure' | 'anthropic' | 'mistral' | 'generic'
  catalogComplete: boolean
  nextPage: { kind: 'after_id'; value: string } | null
}
export class ProviderDiscoveryError extends Error {
  readonly code = 'model_discovery_invalid'
  constructor(message: string) { super(message); this.name = 'ProviderDiscoveryError' }
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const positive = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100_000_000 ? value : null
const minimum = (...values: Array<number | null>): number | null => { const known = values.filter((value): value is number => value !== null); return known.length ? Math.min(...known) : null }

/** Decimal unit scaling only; never a currency conversion. Missing/negative/sentinel rates stay unknown. */
export function tokenRatePerMillion(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 80 || !/^\d+(?:\.\d+)?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const digits = (whole + fraction).replace(/^0+(?=\d)/, '')
  const scaled = fraction.length <= 6
    ? digits + '0'.repeat(6 - fraction.length)
    : digits.padStart(fraction.length - 6 + 1, '0').slice(0, -(fraction.length - 6)) + '.' + digits.padStart(fraction.length - 6 + 1, '0').slice(-(fraction.length - 6))
  const number = Number(scaled)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function familyFor(provider: DiscoveryEndpoint): ParsedProviderDiscovery['family'] {
  let origin: string
  try { const url = new URL(provider.baseUrl); if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return 'generic'; origin = url.origin }
  catch { throw new ProviderDiscoveryError('模型发现 Provider origin 无效') }
  const path = provider.modelsPath
  if (origin === 'https://openrouter.ai' && path === '/api/v1/models') return 'openrouter'
  if (['https://api.moonshot.ai', 'https://api.moonshot.cn'].includes(origin) && path === '/v1/models') return 'moonshot'
  if (['https://api.minimax.io', 'https://api.minimax.cn'].includes(origin) && path === '/v1/models') return 'minimax'
  if (origin === 'https://api.groq.com' && path === '/openai/v1/models') return 'groq'
  if (/^https:\/\/[a-z0-9-]+\.(?:openai|services\.ai)\.azure\.com$/.test(origin) && path === '/openai/v1/models') return 'azure'
  if (origin === 'https://api.anthropic.com' && path === '/v1/models') return 'anthropic'
  if (origin === 'https://api.mistral.ai' && path === '/v1/models') return 'mistral'
  return 'generic'
}

function openRouterPrice(provider: DiscoveryEndpoint, remoteModelId: string, raw: Record<string, unknown>, now: string): { pricing: PricingRecord | null; review: string[] } {
  const quote = object(raw.pricing)
  const review: string[] = []
  const allowed = new Set(['prompt', 'completion', 'input_cache_read', 'input_cache_write'])
  for (const [name, value] of Object.entries(quote)) {
    if (allowed.has(name)) continue
    // An absent dimension isn't assumed free. Explicit numeric zero is a quoted zero.
    if (tokenRatePerMillion(value) !== 0) review.push('additional_or_unknown_billing_dimension')
  }
  const input = tokenRatePerMillion(quote.prompt), output = tokenRatePerMillion(quote.completion)
  if (input === null || output === null || review.length) return { pricing: null, review: [...new Set([...review, 'price_upper_bound_unknown'])] }
  const hit = tokenRatePerMillion(quote.input_cache_read)
  const write = tokenRatePerMillion(quote.input_cache_write)
  if (hit === null) review.push('cache_hit_price_unknown')
  if (write !== null && write > input) review.push('cache_write_upper_bound_not_represented')
  // Directory prices are catalog evidence, not a guarantee of the eventual routed endpoint/bill.
  review.push('openrouter_route_not_frozen')
  const base = {
    providerId: provider.id, remoteModelId, canonicalOrigin: new URL(provider.baseUrl).origin,
    currency: 'USD', unit: 'per_1m_tokens' as const, pricingTier: 'standard' as const, contextBucket: 'default' as const,
    inputMissPerMillion: input, cacheHitPerMillion: hit, cacheWritePerMillion: write,
    outputPerMillion: output, reasoningPerMillion: null,
    reasoningBillingRule: 'unknown' as const, source: 'official_provider' as const,
    sourceUrl: 'https://openrouter.ai/api/v1/models', effectiveAt: null, retrievedAt: now
  }
  const hash = createHash('sha256').update(JSON.stringify(base)).digest('hex')
  return { pricing: { id: `price.discovery.${hash}`, ...base, priceProfileHash: hash }, review }
}

/** Facts are selected by verified endpoint/schema, never by a model name or an imported preset label. */
export function parseProviderDiscovery(provider: DiscoveryEndpoint, payload: unknown, now = new Date().toISOString()): ParsedProviderDiscovery {
  if (!provider.id || !Number.isFinite(Date.parse(now))) throw new ProviderDiscoveryError('模型发现身份/时间无效')
  const family = familyFor(provider)
  const envelope = object(payload)
  const data = family === 'mistral' && Array.isArray(payload) ? payload : envelope.data
  if (!Array.isArray(data) || data.length > 500) throw new ProviderDiscoveryError('模型列表结构不兼容或超过安全上限')
  const seen = new Set<string>()
  const evidence = (supported: boolean, detailCode: string) => ({ state: supported ? 'supported' as const : 'unsupported' as const, source: 'models_endpoint' as const, verifiedAt: now, probeId: null, detailCode })
  const models = data.map((value): DiscoveredProviderMetadata => {
    const row = object(value)
    if (typeof row.id !== 'string' || !row.id.trim() || row.id.length > 200 || /[\u0000-\u001f\u007f]/.test(row.id) || seen.has(row.id)) throw new ProviderDiscoveryError('模型列表含空值、重复或不安全 ID')
    seen.add(row.id)
    const caps = unknownModelCapabilities()
    caps.text = evidence(true, 'data[].id')
    let context = positive(row.context_window), output = positive(row.max_output_tokens)
    let pricing: PricingRecord | null = null
    let pricingReview = ['price_unknown']
    if (family === 'openrouter') {
      const top = object(row.top_provider), architecture = object(row.architecture)
      context = minimum(positive(row.context_length), positive(top.context_length))
      output = positive(top.max_completion_tokens)
      const modalities = architecture.input_modalities
      if (Array.isArray(modalities)) caps.vision = evidence(modalities.includes('image'), 'architecture.input_modalities')
      const parameters = row.supported_parameters
      if (Array.isArray(parameters) && parameters.every(item => typeof item === 'string')) {
        caps.toolUse = evidence(parameters.includes('tools'), 'supported_parameters.tools')
        caps.structuredOutput = evidence(parameters.includes('structured_outputs'), 'supported_parameters.structured_outputs')
        if (parameters.includes('reasoning')) caps.reasoning = { ...caps.reasoning, ...evidence(true, 'supported_parameters.reasoning') }
      }
      const parsed = openRouterPrice(provider, row.id, row, now); pricing = parsed.pricing; pricingReview = parsed.review
    } else if (family === 'moonshot') {
      context = positive(row.context_length)
      if (typeof row.supports_reasoning === 'boolean') caps.reasoning = { ...caps.reasoning, ...evidence(row.supports_reasoning, 'supports_reasoning') }
      if (typeof row.supports_image_in === 'boolean') caps.vision = evidence(row.supports_image_in, 'supports_image_in')
    } else if (family === 'minimax' || family === 'azure') {
      // These official directories do not establish per-model generation limits in their basic schema.
      context = null; output = null
    } else if (family === 'anthropic') {
      context = positive(row.max_input_tokens); output = positive(row.max_tokens)
      const metadata = object(row.capabilities)
      if (typeof object(metadata.image_input).supported === 'boolean') caps.vision = evidence(object(metadata.image_input).supported as boolean, 'capabilities.image_input')
      if (typeof object(metadata.structured_outputs).supported === 'boolean') caps.structuredOutput = evidence(object(metadata.structured_outputs).supported as boolean, 'capabilities.structured_outputs')
      if (typeof object(metadata.thinking).supported === 'boolean') caps.reasoning = { ...caps.reasoning, ...evidence(object(metadata.thinking).supported as boolean, 'capabilities.thinking') }
    } else if (family === 'mistral') {
      context = positive(row.max_context_length)
      const metadata = object(row.capabilities)
      if (typeof metadata.completion_chat === 'boolean') caps.text = evidence(metadata.completion_chat, 'capabilities.completion_chat')
      if (typeof metadata.function_calling === 'boolean') caps.toolUse = evidence(metadata.function_calling, 'capabilities.function_calling')
      if (typeof metadata.vision === 'boolean') caps.vision = evidence(metadata.vision, 'capabilities.vision')
    }
    return { remoteModelId: row.id, displayName: typeof row.display_name === 'string' && row.display_name ? row.display_name : typeof row.name === 'string' && row.name ? row.name : row.id, contextWindow: context, maxOutputTokens: output, capabilities: caps, pricing, pricingReview }
  })
  let nextPage: ParsedProviderDiscovery['nextPage'] = null
  if (family === 'anthropic' && envelope.has_more === true) {
    if (typeof envelope.last_id !== 'string' || !envelope.last_id || envelope.last_id.length > 200 || /[\u0000-\u001f\u007f]/.test(envelope.last_id)) throw new ProviderDiscoveryError('模型发现分页游标无效')
    nextPage = { kind: 'after_id', value: envelope.last_id }
  }
  return { models, family, catalogComplete: !nextPage && envelope.has_more !== true && !envelope.nextPageToken, nextPage }
}
