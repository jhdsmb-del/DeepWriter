// ==================== R4.3 Gate 6：provider capability profile（S-04 修复） ====================
// 上下文窗口/输出能力不再由本地常量假设（1M 硬编码）——按 provider/model 解析：
// - 已知模型：内置 capability 表；
// - 未知 provider（代理网关/自定义 endpoint/不同账号）：保守上限（不默认 1M）；
// - 用户覆盖：允许（settings.providerCapabilityOverride），但校验危险值（过小/过大拒绝）。

export interface ProviderCapability {
  providerId: string
  contextWindowTokens: number
  maxOutputTokens: number
  supportsTools: boolean
  supportsThinking: boolean
}

export type CapabilityOverride = Partial<Pick<ProviderCapability, 'contextWindowTokens' | 'maxOutputTokens' | 'supportsTools' | 'supportsThinking'>>

/** 已知模型能力表（首次配置可用只读探测替代；此处为内置规格） */
const KNOWN_PROVIDERS: Record<string, ProviderCapability> = {
  // Official model IDs/aliases checked 2026-10-03; old Flash/vision IDs
  // now route to V4.1-Flash. Only the trusted builtin uses this evidence.
  // https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
  'deepseek-flash': {
    providerId: 'deepseek-flash',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 393_216,
    supportsTools: true,
    supportsThinking: true
  },
  'deepseek-v4-flash-vision-exp': {
    providerId: 'deepseek-v4-flash-vision-exp',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 393_216,
    supportsTools: true,
    supportsThinking: true
  },
  'deepseek-v4-flash': {
    providerId: 'deepseek-v4-flash',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 393_216,
    supportsTools: true,
    supportsThinking: true
  },
  'deepseek-v4-pro': {
    providerId: 'deepseek-v4-pro',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 393_216,
    supportsTools: true,
    supportsThinking: true
  }
}

export function trustedBuiltinMaxOutputTokens(providerKind: string, adapterId: string, model: string): number | null {
  return providerKind === 'builtin' && adapterId === 'builtin.deepseek' ? KNOWN_PROVIDERS[model]?.maxOutputTokens ?? null : null
}

/** 未知 provider 的保守上限（构造服务端必拒的请求比保守更糟） */
export const DEFAULT_PROVIDER_CAPABILITY: ProviderCapability = {
  providerId: 'unknown',
  contextWindowTokens: 128_000,
  maxOutputTokens: 32_768,
  supportsTools: true,
  supportsThinking: false
}

export const CAPABILITY_LIMITS = {
  minContextWindow: 8_000,
  maxContextWindow: 10_000_000,
  minMaxOutput: 256,
  maxMaxOutput: 1_000_000
}

export interface RegistryContextCapabilityInput {
  providerKind: 'builtin' | 'custom'
  adapterId: string
  remoteModelId: string
  declaredContextWindow?: number | null
  declaredMaxOutputTokens?: number | null
  profileMaxOutputTokens?: number | null
  settingsMaxOutputTokens?: number | null
  override?: CapabilityOverride
  /** Use a bounded operating budget for chat, not a claimed model capability. */
  allowConservativeFallback?: boolean
}

export interface RegistryContextCapability {
  maxContextTokens: number | null
  outputReserveTokens: number
  contextSource: 'model_declaration' | 'settings_override' | 'trusted_builtin' | 'conservative_default' | 'unknown'
}

function validContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= CAPABILITY_LIMITS.maxContextWindow
}

function validOutputLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= CAPABILITY_LIMITS.minMaxOutput && value <= CAPABILITY_LIMITS.maxMaxOutput
}

/** Resolve registry metadata without treating a custom model's name as proof of capability. */
export function resolveRegistryContextCapability(input: RegistryContextCapabilityInput): RegistryContextCapability {
  const declared = validContextWindow(input.declaredContextWindow) ? input.declaredContextWindow : null
  const trustedBuiltin = input.providerKind === 'builtin' && input.adapterId === 'builtin.deepseek'
    ? KNOWN_PROVIDERS[input.remoteModelId]
    : undefined
  // Global legacy tuning is not a model declaration. In particular an old
  // context/output override must not shrink a selected profile or replace a
  // custom model's imported specifications. Frozen older runs keep their own
  // contextBudget and do not call this resolver again.
  const fallback = input.allowConservativeFallback === true
  const maxContextTokens = declared ?? trustedBuiltin?.contextWindowTokens ?? (fallback ? 8192 : null)
  const contextSource = declared !== null
    ? 'model_declaration' as const
    : trustedBuiltin
        ? 'trusted_builtin' as const
        : fallback ? 'conservative_default' as const : 'unknown' as const

  const profileOutput = validOutputLimit(input.profileMaxOutputTokens) ? input.profileMaxOutputTokens : null
  const settingsOutput = validOutputLimit(input.settingsMaxOutputTokens) ? input.settingsMaxOutputTokens : null
  const modelOutput = validOutputLimit(input.declaredMaxOutputTokens) ? input.declaredMaxOutputTokens : null
  const trustedOutput = trustedBuiltin?.maxOutputTokens ?? null
  const configuredOutput = profileOutput ?? settingsOutput ?? modelOutput ?? trustedOutput ?? DEFAULT_PROVIDER_CAPABILITY.maxOutputTokens
  // Preview, frozen generation and runtime must reserve the same output.
  // Keep input headroom, respect declared output limits, and never turn an
  // unknown custom alias into an assumed 1M-context model.
  const outputReserveTokens = Math.min(
    configuredOutput,
    modelOutput ?? trustedOutput ?? Number.MAX_SAFE_INTEGER,
    maxContextTokens === null ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.floor(maxContextTokens / 2)),
    contextSource === 'conservative_default' ? 2048 : Number.MAX_SAFE_INTEGER
  )

  return {
    maxContextTokens,
    outputReserveTokens,
    contextSource
  }
}

/** 覆盖校验（危险值拒绝；非法返回 {ok:false,error}） */
export function validateCapabilityOverride(o: CapabilityOverride): { ok: true } | { ok: false; error: string } {
  if (o.contextWindowTokens !== undefined) {
    const v = o.contextWindowTokens
    if (!Number.isInteger(v) || v < CAPABILITY_LIMITS.minContextWindow || v > CAPABILITY_LIMITS.maxContextWindow) {
      return { ok: false, error: `contextWindowTokens 必须在 ${CAPABILITY_LIMITS.minContextWindow}-${CAPABILITY_LIMITS.maxContextWindow} 之间（当前 ${v}）` }
    }
  }
  if (o.maxOutputTokens !== undefined) {
    const v = o.maxOutputTokens
    if (!Number.isInteger(v) || v < CAPABILITY_LIMITS.minMaxOutput || v > CAPABILITY_LIMITS.maxMaxOutput) {
      return { ok: false, error: `maxOutputTokens 必须在 ${CAPABILITY_LIMITS.minMaxOutput}-${CAPABILITY_LIMITS.maxMaxOutput} 之间（当前 ${v}）` }
    }
  }
  if (o.supportsTools !== undefined && typeof o.supportsTools !== 'boolean') return { ok: false, error: 'supportsTools 必须是布尔值' }
  if (o.supportsThinking !== undefined && typeof o.supportsThinking !== 'boolean') return { ok: false, error: 'supportsThinking 必须是布尔值' }
  return { ok: true }
}

/** 解析 provider capability：已知表 → 用户覆盖合并（覆盖先校验，非法覆盖被忽略并返回 conservative） */
export function resolveProviderCapability(model: string, overrides?: CapabilityOverride): ProviderCapability {
  const base = KNOWN_PROVIDERS[model] ?? { ...DEFAULT_PROVIDER_CAPABILITY, providerId: model || 'unknown' }
  if (!overrides) return { ...base }
  const check = validateCapabilityOverride(overrides)
  if (!check.ok) return { ...base } // 非法覆盖：忽略，回退内置/保守值
  return { ...base, ...overrides }
}
