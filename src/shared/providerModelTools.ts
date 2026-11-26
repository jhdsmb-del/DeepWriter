import type { ProviderAdapterId, ModelCapabilities } from './providerRegistry'

export function supportsAgentTools(adapter: ProviderAdapterId, capabilities: ModelCapabilities): boolean {
  const evidence = capabilities.toolUse
  return adapter === 'builtin.deepseek' || evidence.state === 'supported' &&
    ['protocol_probe', 'models_endpoint', 'model_catalog'].includes(evidence.source ?? '')
}
