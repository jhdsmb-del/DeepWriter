import type { ProviderWebIdentity } from './providerWebCapability'

export type HostedSearchService = 'openai_hosted_search' | 'anthropic_hosted_search'
export type HostedSearchProtocol = 'openai-responses' | 'anthropic-messages'
export interface HostedSearchSupport {
  service: HostedSearchService
  provider: 'openai' | 'anthropic'
  endpointPath: '/v1/responses' | '/v1/messages'
  protocol: HostedSearchProtocol
  toolType: 'web_search' | 'web_search_20250305'
  docsUrl: string
}

// Explicit, dated evidence, not a model-name prefix heuristic. Adding a model requires
// checking its official model page as well as the tool guide. Account access can still fail.
// Verified 2026-11-25 against the guides below and /api/docs/models/<model>.
const OPENAI_SEARCH_MODELS = new Set([
  'gpt-6.2-astra',
  'gpt-5.4', 'gpt-5.4-2026-03-05',
  'gpt-5.2', 'gpt-5.2-2025-12-11',
  'gpt-5.1', 'gpt-5.1-2025-11-13',
  'gpt-5-mini', 'gpt-5-mini-2025-08-07'
])
// All these documented Claude models accept the basic search version, which does not
// provision code execution. Model IDs: https://platform.claude.com/docs/en/models/overview
const ANTHROPIC_SEARCH_MODELS = new Set([
  'claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
  // Official pinned IDs on /docs/en/models/sonnet-4-5/overview and /haiku-4-5/overview.
  'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'
])

export function describeHostedSearchSupport(identity: ProviderWebIdentity): HostedSearchSupport | null {
  const { provider, model } = identity
  if (provider.authStyle !== 'bearer' || provider.transportPolicy.scope !== 'public_https') return null
  let endpoint: URL
  try { endpoint = new URL(provider.baseUrl) } catch { return null }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') return null
  if (endpoint.origin === 'https://api.openai.com' && provider.chatPath === '/v1/responses' &&
    provider.transportPolicy.protocol === 'openai-responses' && OPENAI_SEARCH_MODELS.has(model.remoteModelId)) {
    return { service: 'openai_hosted_search', provider: 'openai', endpointPath: '/v1/responses', protocol: 'openai-responses',
      toolType: 'web_search', docsUrl: 'https://developers.openai.com/api/docs/guides/tools-web-search' }
  }
  if (endpoint.origin === 'https://api.anthropic.com' && provider.chatPath === '/v1/messages' &&
    provider.transportPolicy.protocol === 'anthropic-messages' && ANTHROPIC_SEARCH_MODELS.has(model.remoteModelId)) {
    return { service: 'anthropic_hosted_search', provider: 'anthropic', endpointPath: '/v1/messages', protocol: 'anthropic-messages',
      toolType: 'web_search_20250305', docsUrl: 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool' }
  }
  return null
}
