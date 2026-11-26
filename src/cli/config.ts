import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { validateProviderEndpoint, validateProviderEndpointSyntax, validateProviderPath } from '../main/providerSecurity'
import { buildProviderAuthHeaders } from '../main/providerAuth'
import type { KernelApi } from '../main/runKernelAdapter'
import { normalizeDeepSeekReasoningEffort } from '../shared/deepseekReasoning'
import { resolveProviderCapability, resolveRegistryContextCapability, trustedBuiltinMaxOutputTokens, type RegistryContextCapability } from '../main/providerCapability'
import { providerSetupEndpoint } from '../shared/providerSetup'
import { normalizeAgentRunBudget, type AgentRunBudgetSettings } from '../shared/agentRunBudget'
import { storedOutputTokenLimit } from '../shared/outputTokenPolicy'

export interface CliConfig {
  outputTokenLimit?: number | null
  outputLimitSource?: 'user_explicit' | 'provider_default' | 'model_declaration' | 'protocol_required_fallback'
  modelMaxOutputTokens?: number | null
  workBudgetPolicy?: 'explicit_v1'
  schemaVersion: 1
  baseUrl: string
  chatPath: string
  model: string
  protocol: 'deepseek-chat' | 'openai-chat' | 'openai-responses' | 'anthropic-messages'
  maxTokens: number
  contextWindow: number
  contextSource?: RegistryContextCapability['contextSource']
  contextModel?: string
  contextOrigin?: string
  /** null persists unlimited; historical finite settings remain finite. */
  maxCalls: number | null
  tokenBudget: number | null
  maxTurns?: number | null
  timeBudgetMs?: number | null
  costBudget?: number | null
  costCurrency?: string | null
  workDir: string
  docDir: string
  loopback: boolean
  keyEnv: string
  /** Environment credential selection is scoped to one origin, never a path. */
  keyEnvOrigin?: string
  thinking: boolean | null
  effort: 'default' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  thinkingBudget?: number | null
  authHeaderName: string
  /** Explicit false disables both generated schemas and execution in new runs. */
  supportsTools?: boolean
  /** New-run preference; an explicit offline choice survives config reload. */
  webAccessEnabled?: boolean
}

export type CliOptions = Record<string, string | boolean>
export function validateCliModel(config: Pick<CliConfig, 'model' | 'thinking' | 'protocol'>): void {
  if (!config.model.trim() || config.model.length > 200 || /[\u0000-\u001f]/.test(config.model)) throw new Error('CLI 模型名称无效')
  if (config.thinking && config.protocol === 'deepseek-chat' && !['deepseek-flash', 'deepseek-pro'].includes(config.model)) throw new Error('DeepSeek 原生思考仅支持已验证的 deepseek-flash/pro')
  if (config.thinking && config.protocol === 'openai-chat') throw new Error('OpenAI兼容Chat思考需要模型专用mapping；不能仅凭协议猜测支持')
}
export const credentialFingerprint = (key: string, origin: string, authHeaderName?: string): string => createHash('sha256').update(authHeaderName
  ? `deepwriter-cli:v2\u0000${origin}\u0000${authHeaderName.toLowerCase()}\u0000${key}`
  : `deepwriter-cli:v1\u0000${origin}\u0000${key}`).digest('hex')
const numberOption = (value: unknown, fallback: number, min: number, max: number, name: string): number => {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} 必须为 ${min}–${max} 的整数`)
  return parsed
}

const OFFICIAL_ORIGIN = 'https://api.deepseek.com'
export const callLimitOption = (value: unknown, name = 'max-calls'): number | null => {
  if (value === undefined || value === null || value === 'unlimited') return null
  return numberOption(value, 1, 1, Number.MAX_SAFE_INTEGER, `${name}（或 unlimited）`)
}
export function cliAgentRunBudget(config: CliConfig): AgentRunBudgetSettings {
  return normalizeAgentRunBudget({ maxCalls: config.maxCalls, maxTokens: config.tokenBudget, maxTurns: config.maxTurns ?? null,
    maxWallClockMs: config.timeBudgetMs ?? null, maxCost: config.costBudget == null ? null : { amount: config.costBudget, currency: config.costCurrency ?? null, unknownPolicy: 'deny' } })
}

export function cliModelContext(config: CliConfig): RegistryContextCapability {
  const declared = (config.contextSource === undefined || config.contextSource === 'model_declaration') &&
    (config.contextModel === undefined || config.contextModel === config.model) &&
    (config.contextOrigin === undefined || config.contextOrigin === config.baseUrl)
    ? config.contextWindow : null
  const official = config.baseUrl === OFFICIAL_ORIGIN && config.protocol === 'deepseek-chat'
  return resolveRegistryContextCapability({ providerKind: official ? 'builtin' : 'custom', adapterId: official ? 'builtin.deepseek' : 'custom.openai-compatible-chat',
    remoteModelId: config.model, declaredContextWindow: declared, profileMaxOutputTokens: config.maxTokens, allowConservativeFallback: true })
}
const DEFAULT_KEY_ENV = 'DEEPWRITER_API_KEY'
export function cliEnvironmentSecret(config: Pick<CliConfig, 'baseUrl' | 'keyEnv' | 'keyEnvOrigin'>): string {
  // Missing binding is retained only for historical frozen runs. Every newly
  // loaded configuration below receives an explicit binding.
  if (config.keyEnvOrigin !== undefined && config.keyEnvOrigin !== new URL(config.baseUrl).origin) return ''
  return process.env[config.keyEnv] ?? ''
}

export function redactCliSecrets(text: string, secrets: Iterable<string>): string {
  const forms = new Set<string>()
  for (const secret of secrets) if (secret) {
    forms.add(secret)
    forms.add(JSON.stringify(secret).slice(1, -1))
  }
  for (const secret of [...forms].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]')
  return text
}

export async function loadCliConfig(dataDir: string, options: CliOptions, rememberSecret?: (secret: string) => void): Promise<{ config: CliConfig; secret: string }> {
  let saved: Partial<CliConfig> & { apiKey?: string } = {}
  const configPath = typeof options.config === 'string' ? path.resolve(options.config) : path.join(dataDir, 'config.json')
  try {
    const text = await fs.readFile(configPath, 'utf8')
    if (text.length > 64_000) throw new Error('CLI 配置文件过大')
    let parsed: unknown
    try { parsed = JSON.parse(text) as unknown } catch { throw new Error('CLI 配置 JSON 无效（不显示源内容）') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CLI 配置必须为 JSON 对象')
    saved = parsed as typeof saved
    if (typeof saved.apiKey === 'string') rememberSecret?.(saved.apiKey)
    if ('apiKey' in saved && typeof saved.apiKey !== 'string') throw new Error('显式配置的 apiKey 必须为字符串；不回退到其他密钥来源')
    if ('extraHeaders' in saved || 'fixedHeaders' in saved) throw new Error('CLI 不接受额外Header或Header中的秘密；只配置认证Header名，值来自独立密钥来源')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.config) throw error
  }
  const rawEffort = String(options.effort ?? saved.effort ?? 'default')
  const selectedProtocol = String(options.protocol ?? saved.protocol ?? 'deepseek-chat')
  const effort = rawEffort === 'default' ? 'default' : selectedProtocol === 'deepseek-chat' ? normalizeDeepSeekReasoningEffort(rawEffort) : ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(rawEffort) ? rawEffort as CliConfig['effort'] : null
  if (effort === null || effort === 'none') throw new Error('effort 必须为 low / high / max（兼容 minimal / medium / xhigh / ultra）；关闭思考请用 --no-thinking')
  const protocolChanged = options.protocol !== undefined && options.protocol !== (saved.protocol ?? 'deepseek-chat')
  const config: CliConfig = {
    workBudgetPolicy: 'explicit_v1',
    schemaVersion: 1,
    webAccessEnabled: options['no-web'] === true ? false : options.web === true ? true : saved.webAccessEnabled ?? true,
    supportsTools: options['no-tool-support'] === true ? false : options['tool-support'] === true ? true : saved.supportsTools ?? resolveProviderCapability(String(options.model ?? saved.model ?? 'deepseek-flash')).supportsTools,
    baseUrl: String(options['base-url'] ?? saved.baseUrl ?? 'https://api.deepseek.com'),
    protocol: String(options.protocol ?? saved.protocol ?? 'deepseek-chat') as CliConfig['protocol'],
    chatPath: String(options['chat-path'] ?? saved.chatPath ?? '/chat/completions'),
    model: String(options.model ?? saved.model ?? 'deepseek-flash'),
    maxTokens: Math.min(numberOption(options['max-tokens'] ?? saved.maxTokens, 4096, 256, 1000000, 'max-tokens'), 8192),
    outputTokenLimit: options['max-tokens'] !== undefined ? numberOption(options['max-tokens'], 4096, 1, 1000000, 'max-tokens')
      : !Object.hasOwn(saved, 'outputTokenLimit') && saved.contextSource === 'conservative_default' && saved.maxTokens === 2048 ? null : storedOutputTokenLimit(saved as Record<string, unknown>, 4096),
    modelMaxOutputTokens: saved.modelMaxOutputTokens ?? null,
    contextWindow: 8192,
    maxCalls: callLimitOption(options['max-calls'] !== undefined ? options['max-calls'] : saved.maxCalls),
    tokenBudget: callLimitOption(options['token-budget'] !== undefined ? options['token-budget'] : saved.workBudgetPolicy === undefined && saved.tokenBudget === 200000 ? null : saved.tokenBudget, 'token-budget'),
    maxTurns: callLimitOption(options['max-turns'] !== undefined ? options['max-turns'] : saved.maxTurns, 'max-turns'),
    timeBudgetMs: callLimitOption(options['time-budget-ms'] !== undefined ? options['time-budget-ms'] : saved.timeBudgetMs, 'time-budget-ms'),
    costBudget: options['cost-budget'] === 'unlimited' ? null : options['cost-budget'] !== undefined ? Number(options['cost-budget']) : saved.costBudget ?? null,
    costCurrency: options['cost-currency'] !== undefined ? String(options['cost-currency']).toUpperCase() : saved.costCurrency ?? null,
    workDir: path.resolve(String(options['work-dir'] ?? saved.workDir ?? process.cwd())),
    docDir: path.resolve(String(options['doc-dir'] ?? saved.docDir ?? path.join(dataDir, 'documents'))),
    loopback: options.loopback === true ? true : options['no-loopback'] === true ? false : saved.loopback === true,
    keyEnv: String(options['key-env'] ?? saved.keyEnv ?? 'DEEPWRITER_API_KEY'),
    thinking: options.thinking === true ? true : options['no-thinking'] === true ? false : options.effort === 'default' ? null : options.effort !== undefined || options['thinking-budget'] !== undefined ? true : saved.thinking ?? null,
    effort,
    thinkingBudget: options['thinking-budget'] !== undefined ? numberOption(options['thinking-budget'], 1024, 1024, 10_000_000, 'thinking-budget') : saved.thinkingBudget ?? null,
    authHeaderName: String(options['auth-header'] ?? (protocolChanged ? undefined : saved.authHeaderName) ?? ((options.protocol ?? saved.protocol) === 'anthropic-messages' ? 'x-api-key' : 'Authorization')).toLowerCase()
  }
  cliAgentRunBudget(config)
  if (options.web && options['no-web']) throw new Error('--web 与 --no-web 不能同时指定')
  if (typeof config.webAccessEnabled !== 'boolean') throw new Error('webAccessEnabled 必须为布尔值')
  if (options['tool-support'] && options['no-tool-support']) throw new Error('--tool-support 与 --no-tool-support 不能同时指定')
  if (typeof config.supportsTools !== 'boolean') throw new Error('supportsTools 必须为布尔值')
  if (options.thinking && options['no-thinking']) throw new Error('--thinking 与 --no-thinking 不能同时指定')
  if (options.loopback && options['no-loopback']) throw new Error('--loopback 与 --no-loopback 不能同时指定')
  if (!['deepseek-chat', 'openai-chat', 'openai-responses', 'anthropic-messages'].includes(config.protocol)) throw new Error('CLI Provider 协议无效')
  validateCliModel(config)
  if (config.thinkingBudget != null && (config.protocol !== 'anthropic-messages' || !Number.isSafeInteger(config.thinkingBudget) || config.thinkingBudget < 1024 || config.thinkingBudget >= config.maxTokens)) throw new Error('thinking-budget 只用于 Anthropic Messages，须至少 1024 且低于 max-tokens')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.keyEnv)) throw new Error('key-env 必须是环境变量名称')
  const policy = { scope: config.loopback ? 'loopback_http' as const : 'public_https' as const, allowNonDefaultPort: config.loopback }
  // Preserve legacy saved origin + chatPath, but a newly supplied conventional
  // Base URL takes precedence over a stale saved path. DeepSeek's bare origin
  // retains its historical /chat/completions endpoint.
  const rawBaseUrl = config.baseUrl
  const endpoint = providerSetupEndpoint(rawBaseUrl, config.protocol === 'deepseek-chat' ? 'openai-chat' : config.protocol)
  const explicitPath = options['chat-path'] ?? (options['base-url'] === undefined && !protocolChanged ? saved.chatPath : undefined)
  config.chatPath = explicitPath !== undefined ? String(explicitPath)
    : config.protocol === 'deepseek-chat' && new URL(rawBaseUrl).pathname.replace(/\/+$/, '') === '' ? '/chat/completions' : endpoint.chatPath
  const syntax = validateProviderEndpointSyntax(endpoint.baseUrl, policy)
  config.baseUrl = syntax.url.origin
  // A CLI --context/file declaration is model/origin-bound metadata, not a
  // global tuning slider. Automatically derived values must not become a
  // fake declaration when saved or when a different model is selected.
  const sameModel = (saved.model === undefined || saved.model === config.model) && (saved.contextModel === undefined || saved.contextModel === config.model)
  const sameOrigin = (() => { try { return (saved.baseUrl === undefined || new URL(saved.baseUrl).origin === config.baseUrl) && (saved.contextOrigin === undefined || saved.contextOrigin === config.baseUrl) } catch { return false } })()
  if (!sameModel || !sameOrigin) config.modelMaxOutputTokens = null
  if (config.modelMaxOutputTokens != null && (!Number.isSafeInteger(config.modelMaxOutputTokens) || config.modelMaxOutputTokens <= 0 || config.modelMaxOutputTokens > 1_000_000)) throw new Error('modelMaxOutputTokens 必须为当前模型的正整数规格')
  const savedDeclaration = saved.contextWindow !== undefined && (saved.contextSource === undefined || saved.contextSource === 'model_declaration') && sameModel && sameOrigin
  const declared = options.context !== undefined ? numberOption(options.context, 8192, 1024, 10_000_000, 'context')
    : savedDeclaration ? numberOption(saved.contextWindow, 8192, 1024, 10_000_000, 'context') : null
  const official = config.baseUrl === OFFICIAL_ORIGIN && config.protocol === 'deepseek-chat'
  const modelContext = resolveRegistryContextCapability({ providerKind: official ? 'builtin' : 'custom', adapterId: official ? 'builtin.deepseek' : 'custom.openai-compatible-chat',
    remoteModelId: config.model, declaredContextWindow: declared, profileMaxOutputTokens: config.maxTokens, allowConservativeFallback: true })
  config.contextWindow = modelContext.maxContextTokens ?? 8192
  config.maxTokens = modelContext.outputReserveTokens
  config.contextSource = modelContext.contextSource
  config.contextModel = config.model
  config.contextOrigin = config.baseUrl
  config.outputLimitSource = config.outputTokenLimit != null ? 'user_explicit'
    : config.protocol === 'anthropic-messages' ? config.modelMaxOutputTokens != null ? 'model_declaration' : 'protocol_required_fallback' : 'provider_default'
  let savedOrigin = OFFICIAL_ORIGIN
  try { if (saved.baseUrl) savedOrigin = new URL(saved.baseUrl).origin } catch { savedOrigin = '' }
  if (typeof options['key-env'] === 'string') config.keyEnvOrigin = config.baseUrl
  else if (saved.keyEnvOrigin !== undefined) {
    try {
      const origin = new URL(saved.keyEnvOrigin)
      if (origin.origin !== saved.keyEnvOrigin) throw new Error()
      config.keyEnvOrigin = origin.origin
    } catch { throw new Error('keyEnvOrigin 必须为环境密钥已授权的完整 origin；可用 --key-env NAME 重新选择') }
  } else if (saved.keyEnv && (saved.keyEnv !== DEFAULT_KEY_ENV || (options.config && !saved.baseUrl))) {
    // Old custom environment names were an explicit choice for that saved
    // endpoint. A key-only explicitly selected config can be paired by flags.
    config.keyEnvOrigin = saved.baseUrl ? savedOrigin : options.config ? config.baseUrl : OFFICIAL_ORIGIN
  } else config.keyEnvOrigin = OFFICIAL_ORIGIN
  validateProviderPath(config.chatPath, 'chat-path')
  buildProviderAuthHeaders({
    baseUrl: config.baseUrl, authStyle: 'bearer', authHeaderName: config.authHeaderName, protocol: config.protocol, transportPolicy: policy,
    ...(config.protocol === 'anthropic-messages' ? { fixedHeaders: { 'anthropic-version': '2023-06-01' } } : {})
  }, 'cli-header-validation', { targetUrl: config.baseUrl + config.chatPath, jsonBody: true })
  if (config.protocol === 'deepseek-chat' && config.authHeaderName !== 'authorization') throw new Error('deepseek-chat 当前真实路径仅支持Authorization；专用api-key Header请明确选openai-chat/responses协议')
  if ('apiKey' in saved && !options.config) throw new Error('默认 CLI 配置不允许存储密钥；请移除 apiKey 并使用环境变量或显式 --config')
  // Only explicitly named configuration files may supply a plaintext key.
  // Saved CLI preferences never become an implicit credential store.
  const secret = typeof options.config === 'string' && typeof saved.apiKey === 'string'
    ? saved.apiKey
    : cliEnvironmentSecret(config)
  rememberSecret?.(secret)
  if (typeof options.config === 'string' && typeof saved.apiKey === 'string' && saved.baseUrl && savedOrigin !== config.baseUrl) throw new Error('显式配置的 apiKey 属于文件中的原 origin；不能随 --base-url 发送到另一服务，请使用对应服务的配置或移除 apiKey 后显式 --key-env NAME')
  if (secret && Object.values(config).some(value => value === secret)) throw new Error('非密钥配置字段中出现了密钥值，未保存或发送；请检查模型名称、端点和目录')
  if (secret) buildProviderAuthHeaders({ baseUrl: config.baseUrl, authStyle: 'bearer', authHeaderName: config.authHeaderName, protocol: config.protocol, transportPolicy: policy }, secret, { targetUrl: config.baseUrl + config.chatPath })
  return { config, secret }
}

export async function validateCliProvider(config: CliConfig): Promise<void> {
  await validateProviderEndpoint(config.baseUrl, { scope: config.loopback ? 'loopback_http' : 'public_https', allowNonDefaultPort: config.loopback })
}

export function kernelApi(config: CliConfig, secret: string, supportsTools = false): KernelApi {
  // Resolve the wire representation without rewriting a restored run's frozen
  // provider config/fingerprint; older `medium` pins already sent `high`.
  const effort = config.effort === 'default' ? 'default' : config.protocol === 'deepseek-chat' ? normalizeDeepSeekReasoningEffort(config.effort) : config.effort
  if (effort === null || effort === 'none') throw new Error('冻结CLI推理强度无效；未发送请求')
  return {
    apiKey: secret, baseUrl: config.baseUrl, model: config.model, maxTokens: config.maxTokens,
    outputTokenLimit: config.outputTokenLimit,
    modelMaxOutputTokens: config.modelMaxOutputTokens ?? (config.baseUrl === OFFICIAL_ORIGIN && config.protocol === 'deepseek-chat' ? trustedBuiltinMaxOutputTokens('builtin', 'builtin.deepseek', config.model) : null),
    thinking: { enabled: config.thinking !== false, effort: effort as KernelApi['thinking']['effort'] }, temperature: 0.7, topP: 0.9,
    providerId: new URL(config.baseUrl).hostname,
    profileId: 'cli-frozen-provider',
    adapterId: config.protocol === 'deepseek-chat' ? 'builtin.deepseek' : 'custom.openai-compatible-chat',
    protocol: config.protocol, chatPath: config.chatPath,
    authHeaderName: config.authHeaderName ?? (config.protocol === 'anthropic-messages' ? 'x-api-key' : 'Authorization'),
    authStyle: secret ? 'bearer' : 'none',
    transportPolicy: { scope: config.loopback ? 'loopback_http' : 'public_https', allowNonDefaultPort: config.loopback, protocol: config.protocol,
      ...(config.protocol === 'anthropic-messages' ? { fixedHeaders: { 'anthropic-version': '2023-06-01' } } : {}) },
    reasoningMode: config.thinking == null ? 'default' : config.thinking ? 'enabled' : 'disabled',
    reasoningBudgetTokens: config.thinkingBudget ?? null,
    ...(config.protocol === 'anthropic-messages' && config.thinkingBudget != null ? { compatibilityMappingId: 'anthropic.thinking' as const } : {}),
    supportsTools: supportsTools && config.supportsTools !== false,
  }
}
