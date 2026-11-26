import { validateProviderEndpointSyntax, validateProviderPath } from './providerSecurity'
import { COMPATIBILITY_MAPPINGS, type DeepWriterProviderBundleV1, type ProviderRecord } from '../shared/providerRegistry'

export class ProviderRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ProviderRegistryError'
  }
}

const secretLike = /(^|_)(api_?key|token|secret|password|authorization|cookie|credential|encrypted)(_id|_ref)?$/i

function assertNoSecretLikeKeys(value: unknown, path = '$'): void {
  if (Array.isArray(value)) return value.forEach((entry, index) => assertNoSecretLikeKeys(entry, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (secretLike.test(key)) throw new ProviderRegistryError('bundle_contains_secret', `导入文件含不允许的敏感字段：${path}.${key}`)
    assertNoSecretLikeKeys(child, `${path}.${key}`)
  }
}

export function assertOnlyKeys(value: unknown, allowed: string[], path: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderRegistryError('bundle_invalid', `${path} 必须是对象`)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!allowed.includes(key)) throw new ProviderRegistryError('bundle_unknown_field', `导入文件含不允许的字段：${path}.${key}`)
  }
}

const SAFE_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const SECURITY_HEADER = /^(authorization|proxy-authorization|cookie|host|content-length|content-type|accept|connection|transfer-encoding|x-api-key|api-key|x-goog-api-key|anthropic-version)$/i
const SECRET_HEADER_NAME = /(api[-_]?key|token|secret|password|credential|authorization|cookie)/i

const PRESET_FIXED_HEADERS: Record<string, Record<string, string>> = {
  'anthropic-messages': { 'anthropic-version': '2023-06-01' }
}

export function normalizeProviderPolicy(policy: ProviderRecord['transportPolicy']): ProviderRecord['transportPolicy'] {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new ProviderRegistryError('policy_invalid', 'Provider 网络策略无效')
  const protocol = policy.protocol ?? 'openai-chat'
  if (!['deepseek-chat', 'openai-chat', 'openai-responses', 'anthropic-messages'].includes(protocol)) throw new ProviderRegistryError('protocol_unsupported', 'Provider 协议不受支持')
  const authHeaderName = policy.authHeaderName == null
    ? undefined
    : typeof policy.authHeaderName === 'string'
      ? policy.authHeaderName.trim()
      : (() => { throw new ProviderRegistryError('header_invalid', '认证 Header 名称无效') })()
  if (authHeaderName && (!SAFE_HEADER_NAME.test(authHeaderName) || SECURITY_HEADER.test(authHeaderName) && !/^(authorization|x-api-key|api-key|x-goog-api-key)$/i.test(authHeaderName))) throw new ProviderRegistryError('header_invalid', '认证 Header 名称无效')
  if (policy.extraHeaders !== undefined && (!policy.extraHeaders || typeof policy.extraHeaders !== 'object' || Array.isArray(policy.extraHeaders))) throw new ProviderRegistryError('header_invalid', '额外 Header 必须是对象')
  const extraNames = new Set<string>()
  const extraHeaders = policy.extraHeaders ? Object.fromEntries(Object.entries(policy.extraHeaders).map(([key, value]) => {
    if (typeof value !== 'string') throw new ProviderRegistryError('header_invalid', '额外 Header 值必须是文本')
    if (!SAFE_HEADER_NAME.test(key) || SECRET_HEADER_NAME.test(key) || SECURITY_HEADER.test(key)) throw new ProviderRegistryError('header_unsafe', '额外 Header 不能覆盖安全关键头或凭据字段')
    if (value.length > 4096 || /[\r\n\u0000]/.test(value)) throw new ProviderRegistryError('header_invalid', '额外 Header 值过长或含换行')
    const lower = key.toLowerCase()
    if (extraNames.has(lower)) throw new ProviderRegistryError('header_invalid', '额外 Header 名称重复')
    extraNames.add(lower)
    return [lower, value]
  })) : undefined
  if (policy.fixedHeaders !== undefined && (!policy.fixedHeaders || typeof policy.fixedHeaders !== 'object' || Array.isArray(policy.fixedHeaders))) throw new ProviderRegistryError('fixed_header_invalid', 'Provider 预设 Header 必须是对象')
  const fixedHeaders = policy.fixedHeaders ? Object.fromEntries(Object.entries(policy.fixedHeaders).map(([key, value]) => {
    if (typeof value !== 'string' || value.length > 4096 || !SAFE_HEADER_NAME.test(key)) throw new ProviderRegistryError('fixed_header_invalid', 'Provider 预设 Header 无效')
    const expected = PRESET_FIXED_HEADERS[protocol]?.[key.toLowerCase()]
    if (!expected || value !== expected) throw new ProviderRegistryError('fixed_header_unsupported', '只允许受控协议预设 Header')
    return [key.toLowerCase(), value]
  })) : undefined
  return { ...policy, protocol, ...(authHeaderName ? { authHeaderName } : {}), ...(fixedHeaders ? { fixedHeaders } : {}), ...(extraHeaders ? { extraHeaders } : {}) }
}

export function exportSafePolicy(policy: ProviderRecord['transportPolicy']): ProviderRecord['transportPolicy'] {
  const extraHeaders = Object.fromEntries(Object.entries(policy.extraHeaders ?? {}).filter(([key]) => !SECRET_HEADER_NAME.test(key) && !SECURITY_HEADER.test(key)))
  const fixedHeaders = Object.fromEntries(Object.entries(policy.fixedHeaders ?? {}).filter(([key, value]) => PRESET_FIXED_HEADERS[policy.protocol ?? 'openai-chat']?.[key.toLowerCase()] === value).map(([key, value]) => [key.toLowerCase(), value]))
  return { scope: policy.scope, allowNonDefaultPort: policy.allowNonDefaultPort, ...(policy.protocol ? { protocol: policy.protocol } : {}), ...(policy.authHeaderName ? { authHeaderName: policy.authHeaderName } : {}), ...(Object.keys(fixedHeaders).length ? { fixedHeaders } : {}), ...(Object.keys(extraHeaders).length ? { extraHeaders } : {}) }
}

/** Validate and normalize an owned import snapshot without SQLite, credentials or network access. */
export function parseProviderBundle(raw: unknown): DeepWriterProviderBundleV1 {
  assertNoSecretLikeKeys(raw)
  assertOnlyKeys(raw, ['kind', 'version', 'exportedAt', 'providers', 'models', 'profiles'], '$')
  const bundle = structuredClone(raw) as Partial<DeepWriterProviderBundleV1>
  if (bundle.kind !== 'deepwriter.provider-bundle' || bundle.version !== 1 || !Array.isArray(bundle.providers) || !Array.isArray(bundle.models) || !Array.isArray(bundle.profiles)) throw new ProviderRegistryError('bundle_invalid', '导入文件格式或版本不受支持')
  const providerIds = new Set<string>()
  const modelIds = new Set<string>()
  const modelIdentity = (providerId: string, remoteModelId: string): string => JSON.stringify([providerId, remoteModelId])
  for (const provider of bundle.providers) {
    assertOnlyKeys(provider, ['externalId', 'displayName', 'adapterId', 'baseUrl', 'chatPath', 'modelsPath', 'authStyle', 'transportPolicy'], '$.providers[]')
    assertOnlyKeys(provider.transportPolicy, ['scope', 'allowNonDefaultPort', 'protocol', 'authHeaderName', 'fixedHeaders', 'extraHeaders'], '$.providers[].transportPolicy')
    normalizeProviderPolicy(provider.transportPolicy)
    if (typeof provider.externalId !== 'string' || !/^[a-zA-Z0-9._-]{1,200}$/.test(provider.externalId) || typeof provider.displayName !== 'string' || !provider.displayName.trim() || provider.displayName.length > 100) throw new ProviderRegistryError('bundle_invalid', 'Provider ID 或名称无效')
    if (providerIds.has(provider.externalId)) throw new ProviderRegistryError('bundle_invalid', '导入文件含重复的 Provider ID')
    providerIds.add(provider.externalId)
    if (provider.adapterId !== 'custom.openai-compatible-chat') throw new ProviderRegistryError('adapter_unsupported', 'P0 只导入受控 OpenAI-compatible Chat provider')
    validateProviderEndpointSyntax(provider.baseUrl, provider.transportPolicy)
    validateProviderPath(provider.chatPath, 'Chat Completions 路径')
    validateProviderPath(provider.modelsPath, '模型列表路径')
    if (provider.externalId === 'provider.deepseek.builtin') throw new ProviderRegistryError('builtin_locked', '导入文件不能覆盖内置 DeepSeek')
  }
  for (const model of bundle.models) {
    assertOnlyKeys(model, ['providerExternalId', 'remoteModelId', 'displayName', 'declarations'], '$.models[]')
    assertOnlyKeys(model.declarations, ['contextWindow', 'maxOutputTokens', 'capabilities'], '$.models[].declarations')
    if (typeof model.providerExternalId !== 'string' || typeof model.remoteModelId !== 'string' || !model.remoteModelId || model.remoteModelId.length > 200 || typeof model.displayName !== 'string') throw new ProviderRegistryError('bundle_invalid', '模型声明无效')
    // Use the same identity as addManualModel, including profile references.
    model.remoteModelId = model.remoteModelId.trim()
    if (!model.remoteModelId || /[\u0000-\u001f]/.test(model.remoteModelId)) throw new ProviderRegistryError('model_id_invalid', '模型 ID 无效')
    if (!providerIds.has(model.providerExternalId)) throw new ProviderRegistryError('bundle_invalid', '模型引用了导入文件中不存在的 Provider')
    const identity = modelIdentity(model.providerExternalId, model.remoteModelId)
    if (modelIds.has(identity)) throw new ProviderRegistryError('bundle_invalid', '导入文件含重复的模型 ID')
    modelIds.add(identity)
  }
  for (const profile of bundle.profiles) {
    assertOnlyKeys(profile, ['name', 'providerExternalId', 'remoteModelId', 'generation', 'reasoning', 'compatibilityMappingId'], '$.profiles[]')
    if (typeof profile.providerExternalId !== 'string' || typeof profile.remoteModelId !== 'string') throw new ProviderRegistryError('bundle_invalid', '配置引用的模型无效')
    profile.remoteModelId = profile.remoteModelId.trim()
    if (!modelIds.has(modelIdentity(profile.providerExternalId, profile.remoteModelId))) throw new ProviderRegistryError('bundle_invalid', '配置引用了导入文件中不存在的模型')
    assertOnlyKeys(profile.generation, ['temperature', 'topP', 'maxOutputTokens', 'stream'], '$.profiles[].generation')
    assertOnlyKeys(profile.reasoning, ['mode', 'effort', 'budgetTokens'], '$.profiles[].reasoning')
    if (profile.compatibilityMappingId !== null && !COMPATIBILITY_MAPPINGS.includes(profile.compatibilityMappingId)) throw new ProviderRegistryError('mapping_unsupported', '导入文件含未受控的 reasoning 映射')
  }
  return bundle as DeepWriterProviderBundleV1
}
