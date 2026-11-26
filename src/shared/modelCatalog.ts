import { unknownModelCapabilities, type CompatibilityMappingId, type ModelCapabilities, type ModelRecord, type ProviderRecord } from './providerRegistry'

export const MODEL_CATALOG_URL = 'https://models.dev/api.json'
export interface CatalogModel {
  providerId: string; providerApi: string; id: string; canonicalId: string; name: string
  contextWindow: number | null; maxOutputTokens: number | null
  reasoning: boolean | null; efforts: string[]; toggle: boolean; budget: boolean
  toolUse: boolean | null; vision: boolean | null; structuredOutput: boolean | null
}
export interface ModelCatalog {
  version: 1; sourceUrl: string; fetchedAt: string; models: CatalogModel[]
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const positive = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 100_000_000 ? Number(value) : null
const boolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)

/** Normalize public specifications only. Prices and arbitrary request options are deliberately not imported. */
export function normalizeModelCatalog(raw: unknown, fetchedAt = new Date().toISOString()): ModelCatalog {
  const models: CatalogModel[] = []
  for (const [providerId, rawProvider] of Object.entries(object(raw))) {
    if (!identifier(providerId)) continue
    const provider = object(rawProvider)
    for (const [id, value] of Object.entries(object(provider.models))) {
      if (!identifier(id)) continue
      const row = object(value), limit = object(row.limit), modalities = object(row.modalities)
      if (Array.isArray(modalities.output) && !modalities.output.includes('text')) continue
      const options = Array.isArray(row.reasoning_options) ? row.reasoning_options.slice(0, 16).map(object) : []
      const efforts = [...new Set(options.filter(option => option.type === 'effort').flatMap(option => Array.isArray(option.values) ? option.values : []).filter((effort): effort is string => typeof effort === 'string' && /^[a-z][a-z0-9_-]{0,19}$/.test(effort)))].slice(0, 16)
      models.push({ providerId, providerApi: typeof provider.api === 'string' ? provider.api.slice(0, 2048) : '', id,
        canonicalId: identifier(row.canonical_model_id) ? row.canonical_model_id : '', name: typeof row.name === 'string' ? row.name.slice(0, 200) : id,
        contextWindow: positive(limit.context), maxOutputTokens: positive(limit.output), reasoning: boolean(row.reasoning), efforts,
        toggle: options.some(option => option.type === 'toggle'), budget: options.some(option => option.type === 'budget_tokens'),
        toolUse: boolean(row.tool_call), vision: Array.isArray(modalities.input) ? modalities.input.includes('image') : null, structuredOutput: boolean(row.structured_output) })
      if (models.length >= 30000) throw new Error('模型规格库超过容量上限')
    }
  }
  if (!models.length || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('模型规格库格式无效')
  return { version: 1, sourceUrl: MODEL_CATALOG_URL, fetchedAt, models }
}

const providerAliases: Record<string, string> = { claude: 'anthropic', google: 'google', gemini: 'google', moonshot: 'moonshotai', qwen: 'alibaba', glm: 'zai', zhipu: 'zai', 'x-ai': 'xai' }
const origin = (url: string): string => { try { return new URL(url).origin } catch { return '' } }
const canonicalOwner = (row: CatalogModel): string => providerAliases[row.canonicalId.split('/')[0]] ?? row.canonicalId.split('/')[0]
const aliases = (row: CatalogModel): string[] => [row.id, row.canonicalId, row.canonicalId.split('/').slice(1).join('/')].filter(Boolean).map(id => id.toLowerCase())
const indexes = new WeakMap<ModelCatalog, Map<string, CatalogModel[]>>()
function catalogIndex(catalog: ModelCatalog): Map<string, CatalogModel[]> {
  const previous = indexes.get(catalog)
  if (previous) return previous
  const index = new Map<string, CatalogModel[]>()
  for (const row of catalog.models) for (const alias of new Set(aliases(row))) {
    const entries = index.get(alias) ?? []
    entries.push(row); index.set(alias, entries)
  }
  indexes.set(catalog, index)
  return index
}

export function findCatalogModel(provider: Pick<ProviderRecord, 'id' | 'baseUrl' | 'chatPath'>, modelId: string, catalog: ModelCatalog): CatalogModel | null {
  const id = modelId.toLowerCase()
  const matches = catalogIndex(catalog).get(id) ?? []
  if (!matches.length) return null
  const target = new URL(provider.baseUrl + provider.chatPath)
  const routed = matches.filter(row => {
    try { const api = new URL(row.providerApi); const prefix = api.pathname.replace(/\/$/, ''); return api.origin === target.origin && (target.pathname === prefix || target.pathname.startsWith(prefix + '/')) } catch { return false }
  })
  if (routed.length) return routed.find(row => row.id.toLowerCase() === id) ?? routed[0]
  const preset = provider.id.replace(/^provider\.preset\./, '')
  const exactProvider = matches.find(row => row.providerId === (providerAliases[preset] ?? preset))
  if (exactProvider) return exactProvider
  const native = matches.filter(row => row.providerId === canonicalOwner(row))
  const exactNative = native.filter(row => row.id.toLowerCase() === id)
  if (exactNative.length === 1) return exactNative[0]
  const manufacturers = new Set(['openai', 'anthropic', 'deepseek', 'google', 'alibaba', 'zai', 'xai', 'moonshotai', 'mistral', 'minimax'])
  const manufacturer = matches.filter(row => manufacturers.has(row.providerId) && row.id.toLowerCase() === id)
  if (manufacturer.length === 1) return manufacturer[0]
  // A custom gateway can resolve a canonical model alias, but two different
  // canonical identities are never guessed from a prefix such as "gpt-4".
  const canonicalIds = new Set(matches.map(row => row.canonicalId).filter(Boolean))
  if (canonicalIds.size === 1 && native.length) return native[0]
  const nativeWithoutCanonical = matches.filter(row => !row.canonicalId && !row.providerId.includes('gateway'))
  if (nativeWithoutCanonical.length === 1) return nativeWithoutCanonical[0]
  return matches.length === 1 ? matches[0] : null
}

export function catalogReasoning(provider: Pick<ProviderRecord, 'baseUrl' | 'transportPolicy'>, row: CatalogModel): ModelCapabilities['reasoning'] {
  const protocol = provider.transportPolicy.protocol ?? 'openai-chat'
  let mappingId: CompatibilityMappingId | null = null
  let efforts = row.efforts.filter(effort => !['none', 'off', 'disabled'].includes(effort))
  let modes: ModelCapabilities['reasoning']['modes'] = ['default']
  if (row.reasoning === true) {
    if (protocol === 'anthropic-messages' && (row.budget || efforts.length)) {
      // Claude 4.6 exposes both legacy budget and effort. Prefer its documented
      // adaptive mode; 4.5 still needs a budget alongside native output effort.
      const adaptiveClaude = /^claude-(opus|sonnet)-4-6(?:-\d{8})?$/.test(row.id)
      mappingId = !row.budget || adaptiveClaude ? 'anthropic.adaptive' : efforts.length ? 'anthropic.thinking_effort' : 'anthropic.thinking'
    } else if (protocol === 'openai-responses' && efforts.length) mappingId = 'openai_responses.reasoning_effort'
    else if (protocol === 'openai-chat') {
      if (origin(provider.baseUrl) === 'https://openrouter.ai' && (efforts.length || row.toggle)) mappingId = 'openai_chat.reasoning'
      else if ((row.providerId === 'deepseek' || row.canonicalId.startsWith('deepseek/')) && (efforts.length || row.toggle)) mappingId = 'openai_chat.thinking'
      else if ((row.providerId === 'zai' || row.canonicalId.startsWith('zai/')) && row.toggle) mappingId = 'openai_chat.thinking'
      else if ((row.providerId.startsWith('alibaba') || row.canonicalId.startsWith('alibaba/')) && row.toggle) mappingId = 'openai_chat.enable_thinking'
      else if (efforts.length) mappingId = 'openai_chat.reasoning_effort_top_level'
    }
    if (mappingId) {
      modes = ['default', 'enabled']
      if (row.toggle || row.budget || row.efforts.includes('none')) modes.push('disabled')
      if (!efforts.length && row.toggle && !row.budget) efforts = ['enabled'] // a toggle stays a toggle, not three fictional strength levels
    }
  }
  return { ...unknownModelCapabilities().reasoning, state: row.reasoning === null ? 'unknown' : row.reasoning ? 'supported' : 'unsupported', source: 'model_catalog',
    verifiedAt: null, probeId: null, detailCode: `models.dev:${row.providerId}/${row.id}`, modes, efforts: mappingId ? efforts : [], mappingId,
    budget: row.budget && protocol === 'anthropic-messages' && mappingId !== 'anthropic.adaptive' && row.maxOutputTokens !== null && row.maxOutputTokens > 1024 ? { min: 1024, max: row.maxOutputTokens - 1, step: 1 } : null }
}

export function enrichModelFromCatalog(model: ModelRecord, provider: ProviderRecord, catalog: ModelCatalog): ModelRecord {
  if (model.source === 'builtin') return model
  const row = findCatalogModel(provider, model.remoteModelId, catalog)
  if (!row) return model
  const caps = structuredClone(model.capabilities)
  const proposed = catalogReasoning(provider, row)
  proposed.verifiedAt = catalog.fetchedAt
  // Actual endpoint rejection/probe and explicit local controls win over a public catalog.
  if (caps.reasoning.state === 'unknown' || ['model_catalog', 'imported_declaration'].includes(caps.reasoning.source ?? '') || caps.reasoning.source === 'models_endpoint' && caps.reasoning.state === 'supported' && !caps.reasoning.efforts.length) caps.reasoning = proposed
  for (const [key, value] of [['toolUse', row.toolUse], ['vision', row.vision], ['structuredOutput', row.structuredOutput]] as const) {
    if (value !== null && (caps[key].state === 'unknown' || caps[key].source === 'model_catalog')) caps[key] = { state: value ? 'supported' : 'unsupported', source: 'model_catalog', verifiedAt: catalog.fetchedAt, probeId: null, detailCode: `models.dev:${row.providerId}/${row.id}` }
  }
  return { ...model, contextWindow: model.contextWindow ?? row.contextWindow, maxOutputTokens: model.maxOutputTokens ?? row.maxOutputTokens, capabilities: caps,
    catalog: { sourceUrl: MODEL_CATALOG_URL, providerId: row.providerId, modelId: row.id, fetchedAt: catalog.fetchedAt } }
}
