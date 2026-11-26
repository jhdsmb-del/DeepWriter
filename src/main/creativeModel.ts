import type { ChatParams } from '../shared/types'
import type { EffectiveProfile, FrozenExecutableProfile } from '../shared/providerRegistry'
import type { ProviderRegistryService } from './providerRegistry'
import { ProviderRegistryError } from './providerRegistry'

export type CreativeStage = 'planning' | 'draft' | 'review' | 'polish'
export type CreativeApi = Pick<ChatParams, 'apiKey' | 'model' | 'provider' | 'temperature' | 'topP'> & { baseUrl: string; thinking?: ChatParams['thinking']; maxTokens: number; userPresetPrompt?: string }

export function isCreativeAuthError(error: unknown): boolean {
  const value = error as { status?: number; code?: string }
  return value?.status === 401 || value?.status === 403 || ['credential_missing', 'credential_locked', 'auth_required'].includes(value?.code ?? '')
}

/** One complete executable provider envelope for non-chat creative callers. */
export function creativeApiFromEffectiveProfile(effective: EffectiveProfile & { secret: string }, userPresetPrompt = ''): CreativeApi {
  if (!effective.provider.enabled || !effective.model.enabled) throw new ProviderRegistryError('profile_target_disabled', '所选 Provider 或模型已禁用')
  if (effective.provider.authStyle === 'bearer' && !effective.secret) throw new ProviderRegistryError('credential_missing', '当前创作 Profile 没有可用凭据')
  const { provider, profile, model } = effective
  const reasoning = profile.reasoning
  return {
    apiKey: provider.authStyle === 'none' ? '' : effective.secret, baseUrl: provider.baseUrl, model: model.remoteModelId,
    maxTokens: profile.generation.maxOutputTokens ?? model.maxOutputTokens ?? 4096,
    thinking: { enabled: reasoning.mode === 'enabled' || reasoning.mode === 'adaptive', effort: (reasoning.effort ?? 'default') as ChatParams['thinking']['effort'] },
    temperature: profile.generation.temperature ?? 0.6, topP: profile.generation.topP ?? 0.9,
    provider: { adapterId: provider.adapterId, protocol: provider.transportPolicy.protocol, chatPath: provider.chatPath,
      authStyle: provider.authStyle, transportPolicy: provider.transportPolicy, authHeaderName: provider.transportPolicy.authHeaderName,
      extraHeaders: provider.transportPolicy.extraHeaders, reasoning: { mode: reasoning.mode, effort: reasoning.effort, budgetTokens: reasoning.budgetTokens }, compatibilityMappingId: profile.compatibilityMappingId },
    userPresetPrompt
  }
}

export async function resolveCreativeStageForRequest(input: {
  registry: Pick<ProviderRegistryService, 'shouldUseRegistry' | 'snapshot' | 'resolveForRequest'> | null
  stage: CreativeStage
  legacy: () => Promise<CreativeApi>
  userPresetPrompt?: string
}): Promise<CreativeApi> {
  if (!input.registry?.shouldUseRegistry()) return input.legacy()
  const bindings = input.registry.snapshot().bindings
  const profileId = bindings?.[`${input.stage}ProfileId`] ?? bindings?.defaultProfileId
  if (!profileId) throw new ProviderRegistryError('profile_binding_missing', '请先为当前创作阶段选择模型 Profile')
  // Missing/locked selected credentials are errors, never permission to borrow
  // the legacy DeepSeek key or another stage's provider.
  return creativeApiFromEffectiveProfile(input.registry.resolveForRequest(profileId), input.userPresetPrompt)
}

export function creativeApiFromFrozenProfile(profile: FrozenExecutableProfile, secret: string, userPresetPrompt = ''): CreativeApi {
  if (profile.version !== 1) throw new ProviderRegistryError('profile_snapshot_invalid', '创作阶段执行快照不兼容')
  if (profile.provider.authStyle === 'bearer' && !secret) throw new ProviderRegistryError('credential_missing', '冻结创作阶段的凭据不可用')
  const { provider } = profile
  return {
    apiKey: provider.authStyle === 'none' ? '' : secret, baseUrl: provider.baseUrl, model: profile.model.remoteModelId,
    maxTokens: profile.generation.maxOutputTokens, thinking: profile.wireReasoning.thinking,
    temperature: profile.generation.temperature, topP: profile.generation.topP,
    provider: { adapterId: provider.adapterId, protocol: provider.transportPolicy.protocol, chatPath: provider.chatPath, authStyle: provider.authStyle,
      transportPolicy: provider.transportPolicy, authHeaderName: provider.transportPolicy.authHeaderName, extraHeaders: provider.transportPolicy.extraHeaders,
      reasoning: { mode: profile.wireReasoning.mode, effort: profile.reasoning.effort, ...(profile.wireReasoning.budgetTokens !== undefined ? { budgetTokens: profile.wireReasoning.budgetTokens } : {}) }, compatibilityMappingId: profile.wireReasoning.compatibilityMappingId },
    userPresetPrompt
  }
}
