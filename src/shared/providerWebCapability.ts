import type { ProviderRecord } from './providerRegistry'
import { describeHostedSearchSupport } from './hostedSearchModels'

export type ProviderWebService = 'deepseek_search_fetch' | 'openai_hosted_search' | 'anthropic_hosted_search'
export type ProviderWebOperation = 'search' | 'fetch'
export interface ProviderWebIdentity {
  provider: Pick<ProviderRecord, 'id' | 'adapterId' | 'baseUrl' | 'chatPath' | 'authStyle' | 'transportPolicy'>
  model: { remoteModelId: string }
}
export interface ProviderWebCapability {
  supported: boolean
  service: ProviderWebService | null
  mode: 'provider_api' | 'model_hosted' | null
  operations: ProviderWebOperation[]
  reason: string | null
  sourceUrl: string
  priceSourceUrl: string
}
export const DEEPSEEK_WEB_DOCS = 'https://api-docs.deepseek.com/guides/search/'
export const DEEPSEEK_WEB_PRICE_DOCS = 'https://api-docs.deepseek.com/quick_start/pricing/'
// DeepSeek Search/Fetch are account APIs with no model field. Their capability
// depends on the official account endpoint/protocol, not a chat model alias.
/** Pure metadata for UI and preflight. Execution must separately resolve the frozen key and authorize/budget the request. */
export function getProviderWebCapability(identity: ProviderWebIdentity): ProviderWebCapability {
  const denied = (reason: string): ProviderWebCapability => ({ supported: false, service: null, mode: null, operations: [], reason, sourceUrl: DEEPSEEK_WEB_DOCS, priceSourceUrl: DEEPSEEK_WEB_PRICE_DOCS })
  let origin: string
  try {
    const url = new URL(identity.provider.baseUrl)
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.protocol !== 'https:' || identity.provider.transportPolicy.scope !== 'public_https') return denied('当前端点没有经过核验的供应商账户联网接口；不会改用免费搜索。')
    origin = url.origin
  } catch { return denied('供应商地址无效，无法使用账户联网服务。') }
  if (identity.provider.authStyle !== 'bearer') return denied('供应商联网服务需要当前账户的 API Key；本机免 Key 模式不提供该能力。')
  const protocol = identity.provider.transportPolicy.protocol ?? (identity.provider.adapterId === 'builtin.deepseek' ? 'deepseek-chat' : 'openai-chat')
  if (origin === 'https://api.deepseek.com') {
    const paths = protocol === 'anthropic-messages' ? ['/anthropic/v1/messages']
      : protocol === 'openai-responses' ? ['/responses', '/v1/responses'] : ['/chat/completions', '/v1/chat/completions']
    if (!paths.includes(identity.provider.chatPath)) return denied('当前 DeepSeek 协议路径尚未核验，不能假定支持账户联网服务。')
    return { supported: true, service: 'deepseek_search_fetch', mode: 'provider_api', operations: ['search', 'fetch'], reason: null, sourceUrl: DEEPSEEK_WEB_DOCS, priceSourceUrl: DEEPSEEK_WEB_PRICE_DOCS }
  }
  const hosted = describeHostedSearchSupport(identity)
  if (hosted) return { supported: true, service: hosted.service, mode: 'model_hosted', operations: ['search'], reason: null, sourceUrl: hosted.docsUrl,
    priceSourceUrl: hosted.service === 'openai_hosted_search' ? 'https://developers.openai.com/api/docs/pricing' : 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool' }
  return denied('当前供应商、模型或协议没有已接入的账户联网能力；不会改用其他账户或免费搜索。')
}
