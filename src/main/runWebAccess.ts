import { createHash } from 'node:crypto'
import { getProviderWebCapability } from '../shared/providerWebCapability'
import { WEB_TOOL_NAMES } from '../shared/agentToolPolicy'
import { unknownModelCapabilities, type FrozenExecutableProfile, type FrozenStageProfileSnapshots } from '../shared/providerRegistry'

type Config = Record<string, unknown>
const credentialBound = (profile: FrozenExecutableProfile): boolean => !!profile.credential && profile.credential.providerId === profile.provider.id &&
  !!profile.credential.credentialRefId && Number.isSafeInteger(profile.credential.version) && profile.credential.version >= 1
export interface FrozenRunWebAccess {
  schemaVersion: 1
  enabled: true
  stage: 'planning' | 'draft'
  profileFingerprint: string
  operations: Array<'search' | 'fetch'>
  billingCurrency: 'CNY' | 'USD'
}

/** CLI has an independently frozen endpoint/credential contract. Adapt those
 * same non-secret bytes, not today's CLI options or desktop registry. */
function cliProfile(config: Config): FrozenExecutableProfile | null {
  const frozen = config.cliProvider as { fingerprint?: string; tools?: boolean; config?: Record<string, unknown> } | undefined
  const cli = frozen?.config
  if (!cli || !frozen?.fingerprint || cli.schemaVersion !== 1 || typeof cli.baseUrl !== 'string' || typeof cli.model !== 'string') return null
  const origin = new URL(cli.baseUrl).origin
  const fingerprint = createHash('sha256').update(JSON.stringify({ fingerprint: frozen.fingerprint, config: cli, tools: frozen.tools })).digest('hex')
  const providerId = `cli:${origin}`
  const reasoningMode = cli.thinking === null ? 'default' : cli.thinking === true ? 'enabled' : 'disabled'
  const effort = cli.effort === 'default' ? null : String(cli.effort ?? 'high')
  const budgetTokens = cli.thinkingBudget == null ? null : cli.thinkingBudget as number
  const mapping = cli.protocol === 'anthropic-messages' && budgetTokens !== null ? 'anthropic.thinking' as const : null
  return {
    version: 1, profileId: 'cli:frozen', profileName: 'CLI frozen model', fingerprint,
    provider: { id: providerId, adapterId: cli.protocol === 'deepseek-chat' ? 'builtin.deepseek' : 'custom.openai-compatible-chat', baseUrl: cli.baseUrl,
      chatPath: String(cli.chatPath), authStyle: 'bearer', transportPolicy: { scope: cli.loopback === true ? 'loopback_http' : 'public_https', allowNonDefaultPort: cli.loopback === true,
        protocol: cli.protocol as FrozenExecutableProfile['provider']['transportPolicy']['protocol'], authHeaderName: String(cli.authHeaderName ?? 'Authorization') } },
    model: { id: String(cli.model), remoteModelId: String(cli.model), contextWindow: Number(cli.contextWindow) || null, maxOutputTokens: Object.hasOwn(cli, 'modelMaxOutputTokens') ? (typeof cli.modelMaxOutputTokens === 'number' ? cli.modelMaxOutputTokens : null) : Number(cli.maxTokens) || null, capabilityProof: unknownModelCapabilities() },
    credential: { credentialRefId: `cli:${frozen.fingerprint}`, providerId, version: 1 },
    generation: { ...(Object.hasOwn(cli, 'outputTokenLimit') ? { outputTokenLimit: cli.outputTokenLimit as number | null, outputLimitSource: cli.outputLimitSource as FrozenExecutableProfile['generation']['outputLimitSource'] } : {}), temperature: .7, topP: .9, maxOutputTokens: Number(cli.maxTokens) || 4096, stream: true },
    reasoning: { mode: reasoningMode, effort, budgetTokens },
    wireReasoning: { mode: reasoningMode, thinking: { enabled: reasoningMode !== 'disabled', effort: (effort ?? 'default') as FrozenExecutableProfile['wireReasoning']['thinking']['effort'] }, budgetTokens, compatibilityMappingId: mapping },
    appliedMappings: [], omittedControls: [], supportsTools: frozen.tools === true && cli.supportsTools !== false
  }
}

export function selectedWebProfile(config: Config): FrozenExecutableProfile | null {
  if (config.cliProvider) return cliProfile(config)
  const frozen = config.providerProfileSnapshots as FrozenStageProfileSnapshots | undefined
  return frozen?.version === 1 ? (config.planMode === true ? frozen.planning : frozen.draft) : null
}

export function freezeRunWebAccess(config: Config, enabled: boolean): void {
  const policy = config.toolPolicy as { allowList?: string[] } | undefined
  const local = (policy?.allowList ?? []).filter(name => !WEB_TOOL_NAMES.some(web => web === name))
  config.toolPolicy = { ...policy, allowList: local }
  delete config.webAccess
  const profile = selectedWebProfile(config)
  if (!enabled || config.runMode !== 'agent' || config.longMode === true || !profile || !profile.supportsTools || profile.provider.authStyle !== 'bearer' || !credentialBound(profile)) return
  const capability = getProviderWebCapability(profile)
  if (!capability.supported) return
  const operations = capability.operations.filter((operation): operation is 'search' | 'fetch' => operation === 'search' || operation === 'fetch')
  if (!operations.length) return
  const limit = (config.providerCallBudget as { maxCost?: { currency?: string } | null } | undefined)?.maxCost
  const currency = limit?.currency ?? profile.model.pricing?.currency
  config.webAccess = { schemaVersion: 1, enabled: true, stage: config.planMode === true ? 'planning' : 'draft', profileFingerprint: profile.fingerprint,
    operations, billingCurrency: currency === 'USD' ? 'USD' : currency === 'CNY' || capability.service === 'deepseek_search_fetch' ? 'CNY' : 'USD' } satisfies FrozenRunWebAccess
  config.toolPolicy = { ...policy, allowList: [...local, ...(operations.includes('search') ? ['web_search'] : []), ...(operations.includes('fetch') ? ['read_web_page'] : [])] }
}

export function frozenRunWebAccess(config: Config): { grant: FrozenRunWebAccess; profile: FrozenExecutableProfile } | null {
  const grant = config.webAccess as FrozenRunWebAccess | undefined
  const profile = selectedWebProfile(config)
  if (config.runMode !== 'agent' || config.longMode === true || grant?.schemaVersion !== 1 || grant.enabled !== true || !profile || grant.profileFingerprint !== profile.fingerprint ||
    grant.stage !== (config.planMode === true ? 'planning' : 'draft') || profile.provider.authStyle !== 'bearer' || !credentialBound(profile) || !profile.supportsTools) return null
  const capability = getProviderWebCapability(profile)
  if (!capability.supported || !Array.isArray(grant.operations) || grant.operations.some(op => !capability.operations.includes(op))) return null
  return { grant, profile }
}

export function filterFrozenWebTools(config: Config, names: string[]): string[] {
  const access = frozenRunWebAccess(config)
  return names.filter(name => name !== 'web_search' && name !== 'read_web_page' || !!access && access.grant.operations.includes(name === 'web_search' ? 'search' : 'fetch'))
}
