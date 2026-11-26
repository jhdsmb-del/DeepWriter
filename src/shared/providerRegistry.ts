export type ProviderAdapterId = 'builtin.deepseek' | 'custom.openai-compatible-chat'
/** Wire protocol selected by a Provider.  The adapter id remains backward compatible
 * with the v12 database while this field lets native protocols share the registry. */
export type ProviderProtocol = 'deepseek-chat' | 'openai-chat' | 'openai-responses' | 'anthropic-messages'
export type ProviderPresetId = 'openai' | 'anthropic' | 'gemini' | 'xai' | 'qwen' | 'glm' | 'mistral' | 'siliconflow' | 'openrouter' | 'moonshot' | 'minimax' | 'groq' | 'azure' | 'custom'
export type CapabilityState = 'supported' | 'unsupported' | 'unknown'
export type EvidenceSource = 'builtin_manifest' | 'models_endpoint' | 'model_catalog' | 'protocol_probe' | 'manual_declaration' | 'imported_declaration'

export interface CapabilityEvidence {
  state: CapabilityState
  source: EvidenceSource | null
  verifiedAt: string | null
  probeId: string | null
  detailCode: string | null
}

export interface ModelCapabilities {
  text: CapabilityEvidence
  streaming: CapabilityEvidence
  reasoning: CapabilityEvidence & {
    modes: Array<'default' | 'disabled' | 'enabled' | 'adaptive'>
    efforts: string[]
    budget: { min: number; max: number; step: number } | null
    mappingId?: CompatibilityMappingId | null
  }
  toolUse: CapabilityEvidence
  vision: CapabilityEvidence
  structuredOutput: CapabilityEvidence
}

export interface PricingRecord {
  id: string
  providerId: string
  remoteModelId: string
  canonicalOrigin: string
  currency: string
  unit: 'per_1m_tokens'
  pricingTier: 'standard' | 'peak' | 'off_peak'
  contextBucket: 'default'
  inputMissPerMillion: number | null
  cacheHitPerMillion: number | null
  cacheWritePerMillion: number | null
  outputPerMillion: number | null
  reasoningPerMillion: number | null
  reasoningBillingRule: 'included_in_output' | 'separate' | 'unknown'
  source: 'official_provider' | 'user_supplied'
  sourceUrl: string | null
  effectiveAt: string | null
  retrievedAt: string
  priceProfileHash: string
}

/** A user reference, never an official tariff or a provider bill. Identity and hash
 * are resolved by the main process from the saved model, not supplied by UI. */
export interface UserPricingInput {
  modelId: string
  currency: string
  unit: 'per_1m_tokens'
  inputPrice: number
  outputPrice: number
  cacheHitInputPrice?: number | null
  cacheWriteInputPrice?: number | null
  reasoningPrice?: number | null
  reasoningBillingRule: PricingRecord['reasoningBillingRule']
  validFrom: string
  sourceUrl?: string | null
  acknowledgeReferenceOnly: true
}

export interface ProviderRecord {
  id: string
  kind: 'builtin' | 'custom'
  adapterId: ProviderAdapterId
  displayName: string
  baseUrl: string
  chatPath: string
  modelsPath: string | null
  authStyle: 'bearer' | 'none'
  defaultCredentialRefId: string | null
  enabled: boolean
  builtinLocked: boolean
  transportPolicy: {
    scope: 'public_https' | 'loopback_http'
    allowNonDefaultPort: boolean
    /** Optional protocol/auth metadata stored in the JSON policy for v12 DB compatibility. */
    protocol?: ProviderProtocol
    authHeaderName?: string
    /** Trusted protocol-owned headers; never accepted from the custom-provider UI. */
    fixedHeaders?: Record<string, string>
    extraHeaders?: Record<string, string>
  }
  createdAt: string
  updatedAt: string
}

export interface CredentialRefView {
  id: string
  providerId: string
  label: string
  maskedHint: string | null
  status: 'ready' | 'locked' | 'invalid' | 'missing'
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export interface ModelRecord {
  catalog?: { sourceUrl: string; providerId: string; modelId: string; fetchedAt: string }
  id: string
  providerId: string
  remoteModelId: string
  displayName: string
  source: 'builtin' | 'discovered' | 'manual' | 'imported'
  enabled: boolean
  contextWindow: number | null
  maxOutputTokens: number | null
  capabilities: ModelCapabilities
  pricing: PricingRecord | null
  createdAt: string
  updatedAt: string
}

export interface ReasoningIntent {
  mode: 'default' | 'disabled' | 'enabled' | 'adaptive'
  effort: string | null
  budgetTokens: number | null
}

export const COMPATIBILITY_MAPPINGS = ['openai_chat.reasoning_effort_top_level', 'openai_responses.reasoning_effort', 'anthropic.thinking', 'anthropic.thinking_effort', 'anthropic.adaptive', 'openai_chat.thinking', 'openai_chat.enable_thinking', 'openai_chat.reasoning'] as const
export type CompatibilityMappingId = typeof COMPATIBILITY_MAPPINGS[number]

export interface ProfileRecord {
  id: string
  name: string
  providerId: string
  modelId: string
  credentialRefId: string | null
  generation: { temperature: number | null; topP: number | null; maxOutputTokens: number | null; stream: boolean }
  reasoning: ReasoningIntent
  compatibilityMappingId: CompatibilityMappingId | null
  createdAt: string
  updatedAt: string
}

export interface StageProfileBindings {
  defaultProfileId: string
  planningProfileId?: string
  draftProfileId?: string
  reviewProfileId?: string
  polishProfileId?: string
}

/**
 * Durable, non-secret credential pointer captured when a run is accepted.
 * `version` addresses an append-only encrypted blob; replacing the credential
 * must never change what an already accepted run decrypts.
 */
export interface FrozenCredentialReference {
  credentialRefId: string
  providerId: string
  version: number
}

/** Wire-ready provider/model/profile state. This is persisted in runs.config_json. */
export interface FrozenExecutableProfile {
  version: 1
  profileId: string
  profileName: string
  fingerprint: string
  /** Frozen execution budget, distinct from the model's declared specs.
   * Optional for previously saved runs. */
  contextBudget?: { contextWindowTokens: number | null; outputReserveTokens: number; source: string }
  provider: {
    id: string
    adapterId: ProviderAdapterId
    baseUrl: string
    chatPath: string
    authStyle: 'bearer' | 'none'
    transportPolicy: ProviderRecord['transportPolicy']
  }
    model: {
      id: string
      remoteModelId: string
      contextWindow: number | null
      maxOutputTokens: number | null
      capabilityProof: ModelCapabilities
      /** Price snapshot captured with the executable profile. It is
       * optional for old snapshots and unknown/custom models. */
      pricing?: PricingRecord | null
    }
  credential: FrozenCredentialReference | null
  generation: {
    outputTokenLimit?: number | null
    outputLimitSource?: 'user_explicit' | 'provider_default' | 'model_declaration' | 'protocol_required_fallback'
    temperature: number
    topP: number
    maxOutputTokens: number
    stream: boolean
  }
  reasoning: ReasoningIntent
  wireReasoning: {
    thinking: { enabled: boolean; effort: 'default' | 'low' | 'medium' | 'high' | 'max' }
    budgetTokens?: number | null
    mode: ReasoningIntent['mode']
    compatibilityMappingId: CompatibilityMappingId | null
  }
  appliedMappings: string[]
  omittedControls: string[]
  supportsTools: boolean
}

/**
 * Official endpoint presets.  Model IDs are intentionally not baked into this
 * list: models change faster than the endpoint contract, so users discover or
 * enter a model ID and the registry keeps pricing unknown until a dated source
 * is supplied.  Qwen's workspace/region path remains editable by design.
 */
export interface ProviderPreset {
  id: Exclude<ProviderPresetId, 'custom'>
  displayName: string
  adapterId: ProviderAdapterId
  protocol: Exclude<ProviderProtocol, 'deepseek-chat'>
  baseUrl: string
  chatPath: string
  modelsPath: string | null
  authStyle: 'bearer' | 'none'
  authHeaderName?: string
  /** Trusted headers required by the preset protocol, kept separate from user input. */
  fixedHeaders?: Record<string, string>
  sourceUrl: string
  note: string
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai', displayName: 'OpenAI（Responses）', adapterId: 'custom.openai-compatible-chat', protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com', chatPath: '/v1/responses', modelsPath: '/v1/models', authStyle: 'bearer',
    sourceUrl: 'https://developers.openai.com/api/reference/resources/responses/methods/create', note: '原生 Responses API；支持流式、usage 与 reasoning effort。'
  },
  {
    id: 'anthropic', displayName: 'Anthropic Claude（Messages）', adapterId: 'custom.openai-compatible-chat', protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com', chatPath: '/v1/messages', modelsPath: '/v1/models', authStyle: 'bearer', authHeaderName: 'x-api-key',
    fixedHeaders: { 'anthropic-version': '2023-06-01' }, sourceUrl: 'https://platform.claude.com/docs/en/api/messages/create', note: '原生 Messages API；reasoning 使用 thinking，不能套用 OpenAI 参数。'
  },
  {
    id: 'gemini', displayName: 'Google Gemini（兼容）', adapterId: 'custom.openai-compatible-chat', protocol: 'openai-chat',
    baseUrl: 'https://generativelanguage.googleapis.com', chatPath: '/v1beta/openai/chat/completions', modelsPath: '/v1beta/openai/models', authStyle: 'bearer',
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/partner-integration', note: '官方 OpenAI 兼容层；高级 Gemini 专属能力需使用原生 API。'
  },
  {
    id: 'xai', displayName: 'xAI Grok（Responses）', adapterId: 'custom.openai-compatible-chat', protocol: 'openai-responses',
    baseUrl: 'https://api.x.ai', chatPath: '/v1/responses', modelsPath: '/v1/models', authStyle: 'bearer',
    sourceUrl: 'https://docs.x.ai/developers/rest-api-reference/inference/chat', note: '官方推荐 Responses API；Chat Completions 仍可作为兼容路径。'
  },
  {
    id: 'qwen', displayName: '阿里云百炼 Qwen（兼容）', adapterId: 'custom.openai-compatible-chat', protocol: 'openai-chat',
    baseUrl: 'https://dashscope.aliyuncs.com', chatPath: '/compatible-mode/v1/chat/completions', modelsPath: '/compatible-mode/v1/models', authStyle: 'bearer',
    sourceUrl: 'https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope', note: '官方兼容 Chat；区域/Workspace Host 与 /compatible-mode/v1 路径可编辑，Key 与 Endpoint 受区域/Workspace 约束。'
  },
  {
    id: 'glm', displayName: '智谱 GLM（兼容）', adapterId: 'custom.openai-compatible-chat', protocol: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn', chatPath: '/api/paas/v4/chat/completions', modelsPath: null, authStyle: 'bearer',
    sourceUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction', note: '官方 OpenAI Chat Completions 兼容接口；模型可手动添加。'
  },
  {
    id: 'mistral', displayName: 'Mistral（Chat）', adapterId: 'custom.openai-compatible-chat', protocol: 'openai-chat',
    baseUrl: 'https://api.mistral.ai', chatPath: '/v1/chat/completions', modelsPath: '/v1/models', authStyle: 'bearer',
    sourceUrl: 'https://docs.mistral.ai/api/endpoint/chat', note: '官方 Chat Completions；stream 与 usage 走 SSE。'
  },
  {
    id: 'siliconflow', displayName: 'SiliconFlow（兼容）', adapterId: 'custom.openai-compatible-chat', protocol: 'openai-chat',
    baseUrl: 'https://api.siliconflow.com', chatPath: '/v1/chat/completions', modelsPath: '/v1/models', authStyle: 'bearer',
    sourceUrl: 'https://docs.siliconflow.com/en/userguide/capabilities/text-generation', note: '官方 OpenAI 兼容接口；模型列表可发现，也可手动添加。'
  },
  {
    id: 'openrouter', displayName: 'OpenRouter（Chat）', adapterId: 'custom.openai-compatible-chat', protocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai', chatPath: '/api/v1/chat/completions', modelsPath: '/api/v1/models', authStyle: 'bearer',
    sourceUrl: 'https://openrouter.ai/docs/quickstart', note: '模型目录的能力/美元报价仅为目录证据；路由与高级 reasoning 未冻结，运行须明确参考价。'
  },
  {
    id: 'moonshot', displayName: 'Moonshot / Kimi（国际站）', adapterId: 'custom.openai-compatible-chat', protocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.ai', chatPath: '/v1/chat/completions', modelsPath: '/v1/models', authStyle: 'bearer',
    sourceUrl: 'https://platform.kimi.ai/docs/api/overview', note: '国际/中国平台 Key 不互通；目录读取真实 context_length，思考与采样按模型核验。'
  },
  {
    id: 'minimax', displayName: 'MiniMax（国际站）', adapterId: 'custom.openai-compatible-chat', protocol: 'openai-chat',
    baseUrl: 'https://api.minimax.io', chatPath: '/v1/chat/completions', modelsPath: '/v1/models', authStyle: 'bearer',
    sourceUrl: 'https://platform.minimax.io/docs/api-reference/text-openai-api', note: '目录不提供完整上下文/输出/价格，需明确模型规格与参考价；高级 thinking 按模型另行核验。'
  },
  {
    id: 'groq', displayName: 'Groq（Chat）', adapterId: 'custom.openai-compatible-chat', protocol: 'openai-chat',
    baseUrl: 'https://api.groq.com', chatPath: '/openai/v1/chat/completions', modelsPath: '/openai/v1/models', authStyle: 'bearer',
    sourceUrl: 'https://console.groq.com/docs/openai', note: '有限 OpenAI 兼容；目录缺失的模型上限与价格保持未知，不按模型名称猜测。'
  },
  {
    id: 'azure', displayName: 'Azure OpenAI v1（需资源 Host）', adapterId: 'custom.openai-compatible-chat', protocol: 'openai-responses',
    baseUrl: 'https://your-resource.openai.azure.com', chatPath: '/openai/v1/responses', modelsPath: null, authStyle: 'bearer', authHeaderName: 'api-key',
    sourceUrl: 'https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle', note: 'Host 是待填写占位符；使用实际资源 Host 与 deployment 名称，不把目录 ID 当部署；Entra/OAuth 未实现。'
  }
] as const

/** Every stage is materialized, even when it falls back to the default profile. */
export interface FrozenStageProfileSnapshots {
  version: 1
  frozenAt: string
  default: FrozenExecutableProfile | null
  planning: FrozenExecutableProfile | null
  draft: FrozenExecutableProfile | null
  review: FrozenExecutableProfile | null
  polish: FrozenExecutableProfile | null
}

export type ExecutableProfileStage = 'default' | 'planning' | 'draft' | 'review' | 'polish'

export function frozenExecutableProfiles(profiles: FrozenStageProfileSnapshots): FrozenExecutableProfile[] {
  return [profiles.default, profiles.planning, profiles.draft, profiles.review, profiles.polish].filter((profile): profile is FrozenExecutableProfile => profile != null)
}

/** Freeze only stages reachable under this immutable execution contract. */
export function executableProfileStages(config: { planMode?: unknown; writingPipeline?: unknown; strongConstraints?: unknown; deepWrite?: unknown }): ExecutableProfileStage[] {
  const stages: ExecutableProfileStage[] = [config.planMode === true ? 'planning' : 'draft']
  const strong = config.strongConstraints as { enabled?: unknown } | undefined
  if (config.writingPipeline && strong?.enabled) stages.push('review', 'polish')
  if ((config.deepWrite as { experiment?: { enabled?: unknown } } | undefined)?.experiment?.enabled === true && !stages.includes('review')) stages.push('review')
  return stages
}

export interface ProviderRegistrySnapshot {
  providers: ProviderRecord[]
  credentials: CredentialRefView[]
  models: ModelRecord[]
  profiles: ProfileRecord[]
  bindings: StageProfileBindings | null
}

export interface EffectiveProfile {
  provider: ProviderRecord
  model: ModelRecord
  profile: ProfileRecord
  credentialRefId: string | null
  capabilities: ModelCapabilities
  appliedMappings: string[]
  omittedControls: string[]
}

export interface DiscoveredModel {
  remoteModelId: string
  displayName: string
  contextWindow: number | null
  maxOutputTokens: number | null
  capabilities?: ModelCapabilities
  pricing?: PricingRecord | null
  pricingReview?: string[]
}

export interface DiscoveryPreview {
  discoveryId: string
  providerId: string
  models: DiscoveredModel[]
  expiresAt: number
  /** Partial catalogs are never silently represented as a complete account/model directory. */
  catalogComplete?: boolean
}

export interface ProbeResult {
  probeId: string
  modelId: string
  outcome: 'supported' | 'unsupported' | 'inconclusive'
  capabilities: ModelCapabilities
  usage: { inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null }
}

export interface ModelConnectionResult {
  status: 'connected'
  modelId: string
  testedAt: string
  durationMs: number
  usage: { inputTokens: number | null; outputTokens: number | null }
}

export interface DeepWriterProviderBundleV1 {
  kind: 'deepwriter.provider-bundle'
  version: 1
  exportedAt: string
  providers: Array<{
    externalId: string
    displayName: string
    adapterId: 'custom.openai-compatible-chat'
    baseUrl: string
    chatPath: string
    modelsPath: string | null
    authStyle: 'bearer' | 'none'
    transportPolicy: ProviderRecord['transportPolicy']
  }>
  models: Array<{
    providerExternalId: string
    remoteModelId: string
    displayName: string
    declarations: { contextWindow: number | null; maxOutputTokens: number | null; capabilities: ModelCapabilities }
  }>
  profiles: Array<{
    name: string
    providerExternalId: string
    remoteModelId: string
    generation: ProfileRecord['generation']
    reasoning: ReasoningIntent
    compatibilityMappingId: CompatibilityMappingId | null
  }>
}

export interface ImportPreview {
  previewId: string
  bundle: DeepWriterProviderBundleV1
  collisions: string[]
  expiresAt: number
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } }

export const UNKNOWN_EVIDENCE: CapabilityEvidence = {
  state: 'unknown', source: null, verifiedAt: null, probeId: null, detailCode: null
}

export function unknownModelCapabilities(): ModelCapabilities {
  const evidence = (): CapabilityEvidence => ({ ...UNKNOWN_EVIDENCE })
  return {
    text: evidence(),
    streaming: evidence(),
    reasoning: { ...evidence(), modes: ['default'], efforts: [], budget: null },
    toolUse: evidence(),
    vision: evidence(),
    structuredOutput: evidence()
  }
}
