import type { ProviderRegistrySnapshot } from '../../shared/providerRegistry'
import { supportsAgentTools } from '../../shared/providerModelTools'
import { getProviderWebCapability } from '../../shared/providerWebCapability'

export function composerWeb(snapshot: ProviderRegistrySnapshot | null, planning: boolean) {
  const unavailable = (hint: string) => ({ ready: false, hint })
  if (!snapshot) return unavailable('正在读取模型设置')
  const bindings = snapshot.bindings
  const profileId = (planning ? bindings?.planningProfileId : bindings?.draftProfileId) ?? bindings?.defaultProfileId
  const profile = snapshot.profiles.find(p => p.id === profileId)
  const model = snapshot.models.find(m => m.id === profile?.modelId && m.enabled)
  const provider = snapshot.providers.find(p => p.id === model?.providerId && p.enabled)
  if (!model || !provider || !profile) return unavailable('先在模型设置中选择供应商和模型')
  const capability = getProviderWebCapability({ provider, model })
  if (!capability.supported) return unavailable('此模型和接口组合未接入供应商联网服务')
  if (!supportsAgentTools(provider.adapterId, model.capabilities)) return unavailable('在模型设置中确认此模型可调用工具')
  const credential = profile.credentialRefId ?? provider.defaultCredentialRefId
  if (!snapshot.credentials.some(c => c.id === credential && c.providerId === provider.id && c.status === 'ready')) return unavailable('请先配置此供应商的 API Key')
  return { ready: true, hint: '使用' + provider.displayName + '账户搜索' + (capability.operations.includes('fetch') ? '和读取网页' : '') + '，费用由该供应商收取' }
}
