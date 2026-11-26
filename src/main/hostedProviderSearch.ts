import type { FrozenExecutableProfile } from '../shared/providerRegistry'
import { describeHostedSearchSupport, type HostedSearchProtocol } from '../shared/hostedSearchModels'
import { providerRequestBody } from './providerAdapters'
import { estimateTokens } from '../shared/types'
import { isIP } from 'node:net'
import { classifyAddress } from './providerSecurity'

/** Pure wire adapters. The caller owns frozen credentials, safe transport, preflight,
 * cancellation, durable usage accounting and the existing hard-cap policy. */
export interface HostedSearchRequest {
  endpointPath: string
  body: Record<string, unknown>
  protocol: HostedSearchProtocol
  maxSearchCalls: null
  pricingKnownUpperBound: false
}
export interface HostedSearchUsage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  searchRequests: number | null
}
export interface HostedSearchResult {
  ok: boolean
  text: string
  sources: Array<{ url: string; title: string }>
  proof: Array<{ id: string; type: string; status: string; action?: string }>
  billable: boolean | null
  usage: HostedSearchUsage
}

export function buildHostedSearchRequest(input: { frozen: FrozenExecutableProfile; query: string; maxOutputTokens?: number }): HostedSearchRequest {
  const support = describeHostedSearchSupport(input.frozen)
  if (!support) throw new Error('当前冻结供应商、接口协议或模型不支持已验证的原生网页搜索。')
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 1500 || /[\u0000-\u0008\u000B-\u001F]/.test(input.query)) {
    throw new Error('公开搜索 query 必须为 1 到 1500 字符，且不能包含控制字符。')
  }
  const query = input.query.trim()
  const common = { endpointPath: support.endpointPath, protocol: support.protocol, maxSearchCalls: null, pricingKnownUpperBound: false as const }
  if (support.protocol === 'openai-responses') return { ...common, body: applyHostedOutputLimit(input.frozen, {
    model: input.frozen.model.remoteModelId,
    input: query,
    tools: [{ type: 'web_search', external_web_access: true }],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'], stream: false, store: false
  }, input.maxOutputTokens) }
  return { ...common, body: applyHostedOutputLimit(input.frozen, {
    model: input.frozen.model.remoteModelId,
    messages: [{ role: 'user', content: query }],
    system: 'Use the web_search tool as needed to find public sources for the user query. Cite the sources. Do not answer from memory alone.',
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    // Automatic choice also works on models with always-on thinking. Success below
    // requires a real server_tool_use/result pair, never a claim in generated prose.
    tool_choice: { type: 'auto' }, stream: false
  }, input.maxOutputTokens) }
}

/** Output intent is distinct from the local context reserve. Old snapshots
 * retain their numeric contract; new Responses defaults omit the optional
 * field, while Messages supplies its protocol-required native/context bound. */
export function applyHostedOutputLimit(profile: FrozenExecutableProfile, body: Record<string, unknown>, explicitLimit?: number): Record<string, unknown> {
  const protocol = profile.provider.transportPolicy.protocol
  const field = protocol === 'anthropic-messages' ? 'max_tokens' : 'max_output_tokens'
  const { max_tokens: _messages, max_output_tokens: _responses, ...inputBody } = body
  const legacy = profile.generation.outputTokenLimit === undefined
  const requested = explicitLimit ?? (legacy ? profile.generation.maxOutputTokens : profile.generation.outputTokenLimit ?? null)
  if (requested !== null && (!Number.isSafeInteger(requested) || requested < 1)) throw new Error('原生联网的输出 token 上限必须为正整数。')
  if (!legacy && requested === null && protocol === 'openai-responses') return applyHostedReasoning(profile, inputBody)
  const nativeCap = profile.model.maxOutputTokens
  const declared = typeof nativeCap === 'number' && Number.isSafeInteger(nativeCap) && nativeCap > 0 ? nativeCap : null
  const target = requested ?? declared ?? profile.generation.maxOutputTokens
  const context = profile.model.contextWindow
  const available = !legacy && typeof context === 'number' && Number.isSafeInteger(context) && context > 0 ? context - estimateTokens(JSON.stringify(inputBody)) - 256 : null
  const limit = Math.floor(Math.min(target, legacy ? profile.generation.maxOutputTokens : declared ?? Number.MAX_SAFE_INTEGER, available ?? Number.MAX_SAFE_INTEGER))
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('原生联网请求没有可用输出空间，请缩小输入或补充真实模型规格。')
  return applyHostedReasoning(profile, { ...inputBody, [field]: limit })
}

/** Share the production protocol serializer's reasoning rules instead of
 * reinterpreting provider-default/null or inventing a thinking budget here. */
function applyHostedReasoning(profile: FrozenExecutableProfile, body: Record<string, unknown>): Record<string, unknown> {
  if (!profile.reasoning || !profile.wireReasoning || profile.reasoning.mode === 'default') return body
  // Historical native-web snapshots did not send these controls. Do not add
  // a new budget precondition unless new output intent or an explicit budget exists.
  if (profile.generation.outputTokenLimit === undefined && profile.reasoning.budgetTokens == null) return body
  const protocol = profile.provider.transportPolicy.protocol
  if (protocol !== 'openai-responses' && protocol !== 'anthropic-messages') return body
  const prepared = providerRequestBody({
    model: profile.model.remoteModelId, messages: [{ role: 'user', content: '' }],
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : profile.generation.maxOutputTokens,
    thinking: profile.wireReasoning.thinking, apiKey: '',
    provider: { adapterId: 'custom.openai-compatible-chat', protocol, chatPath: profile.provider.chatPath,
      authStyle: profile.provider.authStyle, transportPolicy: profile.provider.transportPolicy,
      reasoning: profile.reasoning, compatibilityMappingId: profile.wireReasoning.compatibilityMappingId }
  }, protocol)
  return { ...body, ...Object.fromEntries(['thinking', 'reasoning', 'output_config'].filter(key => Object.hasOwn(prepared, key)).map(key => [key, prepared[key]])) }
}

type Obj = Record<string, unknown>
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {}
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : []
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
const short = (v: unknown, max: number): string => typeof v === 'string' ? Array.from(v).slice(0, max).join('') : ''

function publicSource(raw: unknown): { url: string; title: string } | null {
  const item = object(raw)
  if (typeof item.url !== 'string' || item.url.length > 2048 || /[\u0000-\u0020\\]/.test(item.url)) return null
  let url: URL
  try { url = new URL(item.url) } catch { return null }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    (url.port && !['80', '443'].includes(url.port)) || (isIP(host) ? classifyAddress(host) !== 'public' : !host.includes('.')) ||
    /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    /\.(local|localhost|internal|intranet|lan|home|test|invalid|onion)$/.test(host)) return null
  return { url: url.href, title: short(item.title, 240).replace(/[\r\n]/g, ' ').trim() || host }
}

function initialUsage(raw: Obj, protocol: HostedSearchProtocol): HostedSearchUsage {
  const usage = object(raw.usage)
  return { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(protocol === 'anthropic-messages' ? usage.cache_read_input_tokens : object(usage.input_tokens_details).cached_tokens),
    cacheWriteTokens: count(protocol === 'anthropic-messages' ? usage.cache_creation_input_tokens : object(usage.input_tokens_details).cache_write_tokens),
    searchRequests: protocol === 'anthropic-messages' ? count(object(usage.server_tool_use).web_search_requests) : null }
}

function result(ok: boolean, text: string, sources: HostedSearchResult['sources'], proof: HostedSearchResult['proof'], usage: HostedSearchUsage): HostedSearchResult {
  const observed = Object.values(usage)
  const billable = observed.some(v => v !== null && v > 0) ? true : observed.every(v => v === 0) ? false : null
  return { ok, text: short(text, 20_000), sources, proof, usage, billable }
}

/** Parse only structured native search evidence. Model prose or a bare URL is not proof.
 * Preserve observed usage even for failed/unsearched responses: tokens may be billed. */
export function parseHostedSearchResponse(protocol: HostedSearchProtocol, rawValue: unknown): HostedSearchResult {
  const raw = object(rawValue), usage = initialUsage(raw, protocol)
  const proof: HostedSearchResult['proof'] = [], sources: HostedSearchResult['sources'] = []
  const addSource = (value: unknown): void => {
    const source = publicSource(value)
    if (source && sources.length < 20 && !sources.some(s => s.url === source.url)) sources.push(source)
  }
  const texts: string[] = []
  if (protocol === 'openai-responses') {
    const output = list(raw.output).map(object)
    const searches = output.filter(item => item.type === 'web_search_call' && ['search', 'open_page', 'find_in_page'].includes(String(object(item.action).type)))
    for (const item of searches) {
      const id = typeof item.id === 'string' && /^ws_[A-Za-z0-9_-]{1,160}$/.test(item.id) ? item.id : ''
      if (id && proof.some(entry => entry.id === id)) continue
      if (id) proof.push({ id, type: 'web_search_call', action: String(object(item.action).type), status: item.status === 'completed' ? 'completed' : 'incomplete' })
      if (id && item.status === 'completed') for (const source of list(object(item.action).sources)) addSource(source)
    }
    const completed = proof.filter(p => p.status === 'completed').length
    if (completed) usage.searchRequests = proof.filter(item => item.status === 'completed' && item.action === 'search').length
    if (raw.error || raw.status !== 'completed') return result(false, '供应商原生搜索未完整结束；请稍后重试。', [], proof, usage)
    if (!completed) return result(false, '供应商未返回真实的已完成搜索动作，不能把模型回答当作联网结果。', [], proof, usage)
    for (const item of output.filter(item => item.type === 'message' && item.role === 'assistant')) {
      for (const value of list(item.content)) {
        const block = object(value)
        if (block.type !== 'output_text' || typeof block.text !== 'string') continue
        texts.push(short(block.text, 20_000))
        for (const citation of list(block.annotations).map(object)) if (citation.type === 'url_citation') addSource(citation)
      }
    }
  } else if (protocol === 'anthropic-messages') {
    const blocks = list(raw.content).map(object)
    const calls = new Set(blocks.filter(b => b.type === 'server_tool_use' && b.name === 'web_search' &&
      typeof b.id === 'string' && /^srvtoolu_[A-Za-z0-9_-]{1,160}$/.test(b.id)).map(b => b.id))
    let successful = 0, failed = false
    for (const block of blocks.filter(b => b.type === 'web_search_tool_result' && calls.has(b.tool_use_id))) {
      if (proof.some(entry => entry.id === block.tool_use_id)) continue
      const error = object(block.content).type === 'web_search_tool_result_error'
      proof.push({ id: block.tool_use_id as string, type: 'server_tool_use', status: error || !Array.isArray(block.content) ? 'failed' : 'completed' })
      if (error || !Array.isArray(block.content)) { failed = true; continue }
      successful++
      for (const value of block.content) if (object(value).type === 'web_search_result') addSource(value)
    }
    // Failed searches do not incur the search fee. Do not invent zero token usage.
    if (usage.searchRequests === null && successful) usage.searchRequests = successful
    if (raw.type === 'error' || failed) return result(false, '供应商搜索工具返回失败或限流；请稍后重试。', [], proof, usage)
    if (!successful) return result(false, '供应商未返回真实的搜索调用与对应结果，不能把模型回答当作联网结果。', [], proof, usage)
    if (raw.stop_reason !== 'end_turn') return result(false, '供应商搜索尚未完整结束，没有可引用的最终结果。', [], proof, usage)
    for (const block of blocks.filter(b => b.type === 'text' && typeof b.text === 'string')) {
      texts.push(short(block.text, 20_000))
      for (const citation of list(block.citations).map(object)) if (citation.type === 'web_search_result_location') addSource(citation)
    }
  } else return result(false, '不支持此供应商原生搜索协议。', [], [], usage)
  if (!sources.length) return result(false, '供应商完成了搜索，但没有返回可引用的公开来源。', [], proof, usage)
  const text = texts.join('\n\n').trim() || '供应商已返回以下公开来源。'
  return result(true, text, sources, proof, usage)
}
