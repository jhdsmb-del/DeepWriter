import { supportsAgentTools } from '../shared/providerModelTools'
import { createHash, randomUUID } from 'node:crypto'
import type { SqliteDb } from './db/migrations'
import { closeDb, openDb } from './db/migrations'
import { canonicalJoin, secureProviderFetch, validateProviderEndpoint, validateProviderEndpointSyntax, validateProviderPath, type AddressResolver } from './providerSecurity'
import { buildProviderAuthHeaders, providerHttpErrorMessage } from './providerAuth'
import { resolveRegistryContextCapability, trustedBuiltinMaxOutputTokens, type CapabilityOverride } from './providerCapability'
import { providerRequestBody } from './providerAdapters'
import { readToolProbeResponse, toolProbeRequest } from './providerToolProbe'
import { parseProviderDiscovery, type ParsedProviderDiscovery } from './providerDiscovery'
import { providerSetupEndpoint, type ProviderSetupInput, type ProviderSetupUpdateInput } from '../shared/providerSetup'
import { assertOnlyKeys, exportSafePolicy, normalizeProviderPolicy, parseProviderBundle, ProviderRegistryError } from './providerConfiguration'
import catalogSnapshot from '../shared/modelCatalog.generated.json'
import { enrichModelFromCatalog, normalizeModelCatalog, MODEL_CATALOG_URL, type ModelCatalog } from '../shared/modelCatalog'
import { MODELS } from '../shared/types'
import { DEEPSEEK_REASONING_EFFORTS, normalizeDeepSeekReasoningEffort } from '../shared/deepseekReasoning'
import {
  unknownModelCapabilities,
  COMPATIBILITY_MAPPINGS,
  type CompatibilityMappingId,
  type CredentialRefView,
  type DeepWriterProviderBundleV1,
  type DiscoveryPreview,
  type EffectiveProfile,
  type FrozenCredentialReference,
  type FrozenExecutableProfile,
  type FrozenStageProfileSnapshots,
  type ImportPreview,
  type ModelCapabilities,
  type ModelRecord,
  type ModelConnectionResult,
  type PricingRecord,
  type UserPricingInput,
  type ProbeResult,
  type ProfileRecord,
  type ProviderRecord,
  type ProviderRegistrySnapshot,
  PROVIDER_PRESETS,
  type StageProfileBindings
} from '../shared/providerRegistry'

export { ProviderRegistryError } from './providerConfiguration'

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface ProviderRow {
  id: string; kind: 'builtin' | 'custom'; adapter_id: ProviderRecord['adapterId']; display_name: string; base_url: string
  chat_path: string; models_path: string | null; auth_style: ProviderRecord['authStyle']; default_credential_ref_id: string | null
  enabled: number; builtin_locked: number; transport_policy_json: string; created_at: string; updated_at: string
}
interface CredentialRow {
  id: string; provider_id: string; label: string; encrypted_blob_key: string; masked_hint: string | null
  status: CredentialRefView['status']; current_version: number; created_at: string; updated_at: string; last_used_at: string | null
}
interface ModelRow {
  id: string; provider_id: string; remote_model_id: string; display_name: string; source: ModelRecord['source']; enabled: number
  context_window: number | null; max_output_tokens: number | null; capabilities_json: string; pricing_id: string | null
  created_at: string; updated_at: string
}
interface ProfileRow {
  id: string; name: string; provider_id: string; model_id: string; credential_ref_id: string | null
  generation_json: string; reasoning_json: string; compatibility_mapping_id: CompatibilityMappingId | null; created_at: string; updated_at: string
}
interface PricingRow {
  id: string; provider_id: string; remote_model_id: string; canonical_origin: string; currency: string; unit: 'per_1m_tokens'
  pricing_tier: PricingRecord['pricingTier']; context_bucket: 'default'; input_per_million: number | null
  cached_input_per_million: number | null; cache_write_per_million: number | null; output_per_million: number | null
  reasoning_per_million: number | null; reasoning_billing_rule: PricingRecord['reasoningBillingRule']; source: PricingRecord['source']
  source_url: string | null; effective_at: string | null; retrieved_at: string; profile_hash: string
}

const nowIso = (): string => new Date().toISOString()
const safeJson = <T>(value: string, fallback: T): T => { try { return JSON.parse(value) as T } catch { return fallback } }
const maskSecret = (secret: string): string | null => secret.length >= 4 ? `••••${secret.slice(-4)}` : null

function providerFromRow(row: ProviderRow): ProviderRecord {
  const rawPolicy = safeJson<ProviderRecord['transportPolicy']>(row.transport_policy_json, { scope: 'public_https', allowNonDefaultPort: false })
  return {
    id: row.id, kind: row.kind, adapterId: row.adapter_id, displayName: row.display_name, baseUrl: row.base_url,
    chatPath: row.chat_path, modelsPath: row.models_path, authStyle: row.auth_style, defaultCredentialRefId: row.default_credential_ref_id,
    enabled: row.enabled === 1, builtinLocked: row.builtin_locked === 1,
    // v12 custom rows predate protocol metadata. Treat them as ordinary
    // OpenAI-compatible Chat so they enter the hardened adapter path without
    // changing their endpoint or credential references.
    transportPolicy: { ...rawPolicy, protocol: rawPolicy.protocol ?? 'openai-chat' },
    createdAt: row.created_at, updatedAt: row.updated_at
  }
}

function credentialFromRow(row: CredentialRow): CredentialRefView {
  return { id: row.id, providerId: row.provider_id, label: row.label, maskedHint: row.masked_hint, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at }
}

function pricingFromRow(row: PricingRow): PricingRecord {
  return {
    id: row.id, providerId: row.provider_id, remoteModelId: row.remote_model_id, canonicalOrigin: row.canonical_origin,
    currency: row.currency, unit: row.unit, pricingTier: row.pricing_tier, contextBucket: row.context_bucket,
    inputMissPerMillion: row.input_per_million, cacheHitPerMillion: row.cached_input_per_million,
    cacheWritePerMillion: row.cache_write_per_million, outputPerMillion: row.output_per_million, reasoningPerMillion: row.reasoning_per_million,
    reasoningBillingRule: row.reasoning_billing_rule, source: row.source, sourceUrl: row.source_url,
    effectiveAt: row.effective_at, retrievedAt: row.retrieved_at, priceProfileHash: row.profile_hash
  }
}

export class ProviderRegistryService {
  private readonly db: SqliteDb
  private readonly discovery = new Map<string, DiscoveryPreview>()
  private readonly imports = new Map<string, ImportPreview>()
  private catalog: ModelCatalog = catalogSnapshot as unknown as ModelCatalog

  constructor(
    dbPath: string,
    private readonly safeStorage: SafeStoragePort,
    private readonly resolver?: AddressResolver
  ) {
    this.db = openDb(dbPath)
    const cached = this.db.prepare("SELECT value_json FROM provider_registry_state WHERE key='model_catalog'").get() as { value_json: string } | undefined
    if (cached) {
      // Cache the original directory, never arbitrary executable request options.
      const value = safeJson<{ raw: unknown; fetchedAt: string } | null>(cached.value_json, null)
      if (value && Date.parse(value.fetchedAt) > Date.parse(this.catalog.fetchedAt)) { try { this.catalog = normalizeModelCatalog(value.raw, value.fetchedAt) } catch { /* use bundled specifications */ } }
    }
    this.upgradeBuiltinReasoningMetadata()
  }

  close(): void { closeDb(this.db) }

  private upgradeBuiltinReasoningMetadata(): void {
    const rows = this.db.prepare(`SELECT m.* FROM provider_models m JOIN provider_registry p ON p.id=m.provider_id
      WHERE m.source='builtin' AND p.kind='builtin' AND p.builtin_locked=1 AND p.adapter_id='builtin.deepseek' AND p.base_url='https://api.deepseek.com'`).all() as unknown as ModelRow[]
    for (const row of rows) {
      if (!MODELS.some(model => model.id === row.remote_model_id)) continue
      const capabilities = safeJson(row.capabilities_json, unknownModelCapabilities())
      if (capabilities.reasoning.state !== 'supported' || capabilities.reasoning.source !== 'builtin_manifest' || !['deepseek-golden-v1', 'deepseek-thinking-mode-2026-10-03'].includes(capabilities.reasoning.detailCode ?? '')) continue
      if (JSON.stringify(capabilities.reasoning.efforts) === JSON.stringify(DEEPSEEK_REASONING_EFFORTS)) continue
      const updated = { ...capabilities, reasoning: { ...capabilities.reasoning, efforts: [...DEEPSEEK_REASONING_EFFORTS], verifiedAt: '2026-10-03T00:00:00.000Z', detailCode: 'deepseek-thinking-mode-2026-10-03' } }
      this.db.prepare('UPDATE provider_models SET capabilities_json=?,updated_at=? WHERE id=?').run(JSON.stringify(updated), nowIso(), row.id)
    }
  }

  private getProviderRow(providerId: string): ProviderRow {
    const row = this.db.prepare('SELECT * FROM provider_registry WHERE id = ?').get(providerId) as ProviderRow | undefined
    if (!row) throw new ProviderRegistryError('provider_not_found', '未找到 Provider')
    return row
  }

  private getModelRow(modelId: string): ModelRow {
    const row = this.db.prepare('SELECT * FROM provider_models WHERE id = ?').get(modelId) as ModelRow | undefined
    if (!row) throw new ProviderRegistryError('model_not_found', '未找到模型')
    return row
  }

  private getProfileRow(profileId: string): ProfileRow {
    const row = this.db.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(profileId) as ProfileRow | undefined
    if (!row) throw new ProviderRegistryError('profile_not_found', '未找到 Profile')
    return row
  }

  private modelFromRow(row: ModelRow): ModelRecord {
    const price = row.pricing_id
      ? this.db.prepare('SELECT * FROM provider_pricing WHERE id = ?').get(row.pricing_id) as PricingRow | undefined
      : undefined
    return enrichModelFromCatalog({
      id: row.id, providerId: row.provider_id, remoteModelId: row.remote_model_id, displayName: row.display_name,
      source: row.source, enabled: row.enabled === 1, contextWindow: row.context_window, maxOutputTokens: row.max_output_tokens,
      capabilities: safeJson(row.capabilities_json, unknownModelCapabilities()), pricing: price ? pricingFromRow(price) : null,
      createdAt: row.created_at, updatedAt: row.updated_at
    }, providerFromRow(this.getProviderRow(row.provider_id)), this.catalog)
  }

  async refreshModelCatalog(): Promise<{ fetchedAt: string; modelCount: number }> {
    try {
      const response = await secureProviderFetch(MODEL_CATALOG_URL, {}, { scope: 'public_https', allowNonDefaultPort: false }, this.resolver, { timeoutMs: 20_000, maxBodyBytes: 16 * 1024 * 1024 })
      if (!response.ok) throw new Error('http')
      const raw: unknown = await response.json()
      const catalog = normalizeModelCatalog(raw)
      this.db.prepare("INSERT INTO provider_registry_state (key,value_json,updated_at) VALUES ('model_catalog',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").run(JSON.stringify({ raw, fetchedAt: catalog.fetchedAt }), catalog.fetchedAt)
      this.catalog = catalog
      return { fetchedAt: catalog.fetchedAt, modelCount: catalog.models.length }
    } catch { throw new ProviderRegistryError('model_catalog_refresh_failed', '规格库暂时无法更新，已保留本地规格。') }
  }

  private profileFromRow(row: ProfileRow): ProfileRecord {
    return {
      id: row.id, name: row.name, providerId: row.provider_id, modelId: row.model_id, credentialRefId: row.credential_ref_id,
      generation: safeJson(row.generation_json, { temperature: null, topP: null, maxOutputTokens: null, stream: true }),
      reasoning: safeJson(row.reasoning_json, { mode: 'default', effort: null, budgetTokens: null }),
      compatibilityMappingId: row.compatibility_mapping_id, createdAt: row.created_at, updatedAt: row.updated_at
    }
  }

  async bootstrapDeepSeek(input: { baseUrl: string; model: string; apiKey: string; thinkingEnabled: boolean; reasoningEffort: string; temperature: number; topP: number; maxTokens: number; outputTokenLimit?: number | null }): Promise<void> {
    const legacy = input
    const officialLegacy = input.baseUrl.trim().replace(/\/+$/, '') === 'https://api.deepseek.com'
    // A legacy compatible endpoint owns its own key/model; it is not a native
    // DeepSeek credential just because the settings predate the registry.
    if (!officialLegacy) input = { ...input, model: MODELS[0].id, apiKey: '' }
    const time = nowIso()
    const providerId = 'provider.deepseek.builtin'
    const modelId = `model.deepseek.${input.model.replace(/[^a-zA-Z0-9_-]/g, '-') || 'default'}`
    const profileId = 'profile.deepseek.default'
    const explicitOutput = this.db.prepare("SELECT value_json FROM provider_registry_state WHERE key=?").get(`profile_output_limit:${profileId}`) as { value_json: string } | undefined
    const bootstrapOutputLimit = explicitOutput ? safeJson<number | null>(explicitOutput.value_json, null)
      : input.outputTokenLimit === undefined ? input.maxTokens : input.outputTokenLimit
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`INSERT INTO provider_registry (id,kind,adapter_id,display_name,base_url,chat_path,models_path,auth_style,default_credential_ref_id,enabled,builtin_locked,transport_policy_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,updated_at=excluded.updated_at`).run(
        providerId, 'builtin', 'builtin.deepseek', 'DeepSeek（内置）', 'https://api.deepseek.com', '/chat/completions', '/models', 'bearer', null, 1, 1,
        JSON.stringify({ scope: 'public_https', allowNonDefaultPort: false, protocol: 'deepseek-chat' }), time, time
      )
      const builtinEvidence = { state: 'supported', source: 'builtin_manifest', verifiedAt: time, probeId: null, detailCode: 'deepseek-golden-v1' } as const
      const capabilities: ModelCapabilities = MODELS.some(model => model.id === input.model) ? {
        text: { ...builtinEvidence }, streaming: { ...builtinEvidence },
        reasoning: { ...builtinEvidence, modes: ['default', 'disabled', 'enabled'], efforts: [...DEEPSEEK_REASONING_EFFORTS], budget: null },
        toolUse: { ...builtinEvidence }, vision: { ...unknownModelCapabilities().vision }, structuredOutput: { ...unknownModelCapabilities().structuredOutput }
      } : unknownModelCapabilities()
      this.db.prepare(`INSERT INTO provider_models (id,provider_id,remote_model_id,display_name,source,enabled,context_window,max_output_tokens,capabilities_json,pricing_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_id,remote_model_id) DO UPDATE SET display_name=excluded.display_name,updated_at=excluded.updated_at`).run(
        modelId, providerId, input.model, input.model, 'builtin', 1, null, null, JSON.stringify(capabilities), null, time, time
      )
      // The legacy settings model is authoritative for the built-in compatibility
      // profile. Update model + generation in the same transaction as the model
      // upsert, while preserving the credential reference. Explicit user stage
      // bindings below are never rewritten.
      this.db.prepare(`INSERT INTO provider_profiles (id,name,provider_id,model_id,credential_ref_id,generation_json,reasoning_json,compatibility_mapping_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,model_id=excluded.model_id,generation_json=excluded.generation_json,reasoning_json=excluded.reasoning_json,compatibility_mapping_id=excluded.compatibility_mapping_id,updated_at=excluded.updated_at`).run(
        profileId, '默认 DeepSeek', providerId, modelId, null,
        JSON.stringify({ temperature: input.temperature, topP: input.topP, maxOutputTokens: bootstrapOutputLimit, stream: true }),
        JSON.stringify({ mode: 'default', effort: input.reasoningEffort === 'default' ? null : input.reasoningEffort, budgetTokens: null }), null, time, time
      )
      if (!this.db.prepare("SELECT 1 FROM provider_registry_state WHERE key='bindings'").get()) {
        this.db.prepare("INSERT INTO provider_registry_state (key,value_json,updated_at) VALUES ('bindings',?,?)").run(JSON.stringify({ defaultProfileId: profileId }), time)
      }
      this.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('provider_registry_migration',?)").run(JSON.stringify({ schemaVersion: 13, providerId, modelId, profileId, completedAt: time }))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    if (input.apiKey && this.safeStorage.isEncryptionAvailable()) {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM provider_credential_refs WHERE provider_id = ?').get(providerId) as { n: number }
      if (count.n === 0) {
        const credential = this.createCredential(providerId, '默认凭据', input.apiKey)
        this.setDefaultCredential(providerId, credential.id)
      }
    }
    const migratedCredential = (this.db.prepare('SELECT COUNT(*) AS n FROM provider_credential_refs WHERE provider_id=?').get(providerId) as { n: number }).n > 0
    const migrationCompatible = input.baseUrl.replace(/\/$/, '') === 'https://api.deepseek.com' && input.apiKey !== '' && migratedCredential
    this.db.prepare(`INSERT INTO provider_registry_state (key,value_json,updated_at) VALUES ('migration_compatible',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(migrationCompatible ? 'true' : 'false', nowIso())
    // Add current price identities without rewriting historical USD rows or
    // accepted run snapshots. Refresh every saved builtin alias, not only the
    // legacy settings selection; stage bindings may still reference another.
    // CNY rates come directly from the official Chinese table, not conversion.
    const savedBuiltins = this.db.prepare("SELECT id,remote_model_id FROM provider_models WHERE provider_id=? AND source='builtin'").all(providerId) as Pick<ModelRow, 'id' | 'remote_model_id'>[]
    for (const model of savedBuiltins) {
      const price = MODELS.find((entry) => entry.id === model.remote_model_id)
      if (!price) continue
      this.db.prepare('UPDATE provider_models SET display_name=?,updated_at=? WHERE id=?').run(price.name, time, model.id)
      for (const [index, tier] of (['off_peak', 'peak'] as const).entries()) {
        const multiplier = index === 0 ? 1 : 2
        const base = {
          providerId, remoteModelId: model.remote_model_id, canonicalOrigin: 'https://api.deepseek.com', currency: 'CNY', unit: 'per_1m_tokens' as const,
          pricingTier: tier, contextBucket: 'default' as const, inputMissPerMillion: price.cacheMiss * multiplier, cacheHitPerMillion: price.cacheHit * multiplier,
          cacheWritePerMillion: null, outputPerMillion: price.out * multiplier, reasoningPerMillion: null,
          reasoningBillingRule: 'included_in_output' as const, source: 'official_provider' as const,
          sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', effectiveAt: null,
          retrievedAt: '2026-10-03T00:00:00.000Z'
        }
        const priceProfileHash = createHash('sha256').update(JSON.stringify(base)).digest('hex')
        // Retain the peak pointer for a conservative frozen run budget.
        this.upsertPricing({ id: `price.deepseek.${model.remote_model_id}.${tier}.2026-10-03`, ...base, priceProfileHash })
      }
    }
    this.ensureOfficialPresets()
    if (!officialLegacy) this.bootstrapLegacyCompatibleProvider(legacy)
  }

  private bootstrapLegacyCompatibleProvider(input: { baseUrl: string; model: string; apiKey: string }): void {
    // Older releases could copy this non-official key into the builtin slot.
    // Only the auto-migration label is ambiguous; explicitly entered official
    // credentials and immutable versions held by accepted runs stay intact.
    const ambiguous = this.db.prepare("SELECT id FROM provider_credential_refs WHERE provider_id='provider.deepseek.builtin' AND label='默认凭据' AND status='ready'").all() as { id: string }[]
    for (const row of ambiguous) this.retireCredential(row.id)
    let url: URL
    let chatPath: string
    let modelsPath: string
    let policy: ProviderRecord['transportPolicy']
    try {
      url = new URL(input.baseUrl.trim())
      if (url.username || url.password || url.search || url.hash) return
      const rawPath = input.baseUrl.trim().match(/^[a-z][a-z\d+.-]*:\/\/[^/?#]+([^?#]*)$/i)?.[1]
      if (rawPath === undefined) return
      const prefix = rawPath.replace(/\/+$/, '')
      chatPath = validateProviderPath(prefix + '/chat/completions', '旧配置调用路径')!
      modelsPath = validateProviderPath(prefix + '/models', '旧配置模型路径')!
      const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      policy = { scope: local ? 'loopback_http' : 'public_https', allowNonDefaultPort: local, protocol: 'openai-chat' }
      validateProviderEndpointSyntax(url.origin, policy)
    } catch { return } // Unsupported legacy addresses must be rebound, never rewritten to the official host.
    const saved = this.db.prepare("SELECT value_json FROM provider_registry_state WHERE key='legacy_provider_setup'").get() as { value_json: string } | undefined
    const previous = saved ? safeJson<{ providerId?: string }>(saved.value_json, {}) : {}
    let provider = previous.providerId ? (this.db.prepare('SELECT * FROM provider_registry WHERE id=?').get(previous.providerId) as ProviderRow | undefined) : undefined
    if (provider && (provider.base_url !== url.origin || provider.chat_path !== chatPath || provider.adapter_id !== 'custom.openai-compatible-chat')) provider = undefined
    this.db.exec('BEGIN')
    try {
      if (!provider) {
        const created = this.insertCustomProvider({ displayName: '原配置供应商', baseUrl: url.origin, chatPath, modelsPath, authStyle: input.apiKey.trim() ? 'bearer' : policy.scope === 'loopback_http' ? 'none' : 'bearer', transportPolicy: policy }, url.origin)
        provider = this.getProviderRow(created.id)
      }
      const credentials = this.db.prepare('SELECT COUNT(*) AS n FROM provider_credential_refs WHERE provider_id=?').get(provider.id) as { n: number }
      // Tombstones prevent a stale legacy settings key resurrecting after clear.
      if (credentials.n === 0 && input.apiKey.trim() && this.safeStorage.isEncryptionAvailable()) this.createCredential(provider.id, '原配置凭据', input.apiKey.trim())
      const model = this.addManualModel({ providerId: provider.id, remoteModelId: input.model, displayName: input.model })
      if (!this.isExplicitlyEnabled()) {
        this.db.prepare("INSERT INTO provider_registry_state (key,value_json,updated_at) VALUES ('bindings',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").run(JSON.stringify({ defaultProfileId: this.ensureModelProfile(model.id).id }), nowIso())
      }
      this.db.prepare("INSERT OR REPLACE INTO provider_registry_state (key,value_json,updated_at) VALUES ('legacy_provider_setup',?,?)").run(JSON.stringify({ providerId: provider.id }), nowIso())
      this.db.prepare("INSERT OR REPLACE INTO provider_registry_state (key,value_json,updated_at) VALUES ('migration_compatible','true',?)").run(nowIso())
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private ensureOfficialPresets(): void {
    const time = nowIso()
    for (const preset of PROVIDER_PRESETS) {
      const policy = normalizeProviderPolicy({
        scope: 'public_https', allowNonDefaultPort: false, protocol: preset.protocol,
        ...(preset.authHeaderName ? { authHeaderName: preset.authHeaderName } : {}),
        ...(preset.fixedHeaders ? { fixedHeaders: preset.fixedHeaders } : {})
      })
      this.db.prepare(`INSERT OR IGNORE INTO provider_registry (id,kind,adapter_id,display_name,base_url,chat_path,models_path,auth_style,default_credential_ref_id,enabled,builtin_locked,transport_policy_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        `provider.preset.${preset.id}`, 'custom', preset.adapterId, preset.displayName, preset.baseUrl, preset.chatPath, preset.modelsPath,
        preset.authStyle, null, 1, 0, JSON.stringify(policy), time, time
      )
    }
  }

  snapshot(): ProviderRegistrySnapshot {
    const providers = (this.db.prepare('SELECT * FROM provider_registry ORDER BY builtin_locked DESC,display_name').all() as unknown as ProviderRow[]).map(providerFromRow)
    const credentials = (this.db.prepare('SELECT * FROM provider_credential_refs ORDER BY provider_id,created_at').all() as unknown as CredentialRow[]).map(credentialFromRow)
    const models = (this.db.prepare('SELECT * FROM provider_models ORDER BY provider_id,display_name').all() as unknown as ModelRow[]).map((row) => this.modelFromRow(row))
    const profiles = (this.db.prepare('SELECT * FROM provider_profiles ORDER BY name').all() as unknown as ProfileRow[]).map((row) => this.profileFromRow(row))
    const state = this.db.prepare("SELECT value_json FROM provider_registry_state WHERE key='bindings'").get() as { value_json: string } | undefined
    return { providers, credentials, models, profiles, bindings: state ? safeJson<StageProfileBindings | null>(state.value_json, null) : null }
  }

  isExplicitlyEnabled(): boolean {
    const state = this.db.prepare("SELECT value_json FROM provider_registry_state WHERE key='bindings_explicit'").get() as { value_json: string } | undefined
    return state?.value_json === 'true'
  }

  shouldUseRegistry(): boolean {
    if (this.isExplicitlyEnabled()) return true
    const state = this.db.prepare("SELECT value_json FROM provider_registry_state WHERE key='migration_compatible'").get() as { value_json: string } | undefined
    if (state?.value_json === 'true') return true
    const saved = this.db.prepare("SELECT value_json FROM provider_registry_state WHERE key='bindings'").get() as { value_json: string } | undefined
    const bindings = saved ? safeJson<StageProfileBindings | null>(saved.value_json, null) : null
    if (!bindings) return false
    // Saving a key configures the already-bound provider; it does not require
    // selecting the same model again. Include pre-marker UI saves on upgrade.
    // Unbound suppliers must not opt the current model into another auth path.
    for (const profileId of [bindings.defaultProfileId, bindings.planningProfileId, bindings.draftProfileId, bindings.reviewProfileId, bindings.polishProfileId]) {
      if (!profileId) continue
      const profile = this.getProfileRow(profileId)
      const provider = this.getProviderRow(profile.provider_id)
      if (profile.credential_ref_id !== null || provider.default_credential_ref_id !== null) return true
      const authority = this.db.prepare('SELECT value_json FROM provider_registry_state WHERE key=?').get(`credential_authority:${provider.id}`) as { value_json: string } | undefined
      if (authority?.value_json === 'true') return true
    }
    return false
  }

  private markCredentialAuthority(providerId: string): void {
    // Keep this provider-scoped marker after clear/delete. Missing or locked
    // managed credentials must fail closed, never revive a legacy settings key.
    this.db.prepare("INSERT INTO provider_registry_state (key,value_json,updated_at) VALUES (?,'true',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").run(`credential_authority:${providerId}`, nowIso())
  }

  async createCustomProvider(input: Omit<ProviderRecord, 'id' | 'kind' | 'adapterId' | 'defaultCredentialRefId' | 'enabled' | 'builtinLocked' | 'createdAt' | 'updatedAt'>): Promise<ProviderRecord> {
    const validated = await validateProviderEndpoint(input.baseUrl, input.transportPolicy, this.resolver)
    return this.insertCustomProvider(input, validated.baseUrl)
  }

  async createProviderSetup(input: ProviderSetupInput): Promise<ProviderRecord> {
    let endpoint: ReturnType<typeof providerSetupEndpoint>
    try { endpoint = providerSetupEndpoint(input.baseUrl, input.protocol) }
    catch { throw new ProviderRegistryError('base_url_invalid', '请填写有效的 Base URL，并选择对应的 API 格式') }
    const ids = [...new Set(input.modelIds.map(id => id.trim()))]
    if (!ids.length || ids.length > 100 || ids.some(id => !id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id))) throw new ProviderRegistryError('model_id_invalid', '请添加有效的模型 ID')
    if (input.authStyle === 'none' && (!endpoint.local || input.apiKey.trim())) throw new ProviderRegistryError('auth_mode_invalid', '仅本机接口可明确免 Key，且不能同时填写 API Key')
    if (!input.apiKey.trim() && (!endpoint.local || input.authStyle === 'bearer')) throw new ProviderRegistryError('credential_missing', '请填写 API Key')
    const transportPolicy = { scope: endpoint.local ? 'loopback_http' as const : 'public_https' as const, allowNonDefaultPort: endpoint.local, protocol: input.protocol,
      ...(input.protocol === 'anthropic-messages' ? { authHeaderName: 'x-api-key', fixedHeaders: { 'anthropic-version': '2023-06-01' } } : {}) }
    const validated = await validateProviderEndpoint(endpoint.baseUrl, transportPolicy, this.resolver)
    this.db.exec('BEGIN')
    try {
      const provider = this.insertCustomProvider({ displayName: input.displayName, baseUrl: validated.baseUrl, chatPath: endpoint.chatPath, modelsPath: endpoint.modelsPath, authStyle: input.apiKey.trim() ? 'bearer' : 'none', transportPolicy }, validated.baseUrl)
      this.markCredentialAuthority(provider.id)
      if (input.apiKey.trim()) this.createCredential(provider.id, 'API Key', input.apiKey.trim())
      for (const remoteModelId of ids) this.addManualModel({ providerId: provider.id, remoteModelId, displayName: remoteModelId })
      this.db.exec('COMMIT')
      return providerFromRow(this.getProviderRow(provider.id))
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async updateProviderSetup(input: ProviderSetupUpdateInput): Promise<ProviderRecord> {
    const previous = providerFromRow(this.getProviderRow(input.providerId))
    const displayBase = previous.baseUrl.replace(/\/$/, '') + previous.chatPath.replace(/\/(?:chat\/completions|responses|messages)$/, '')
    const previousProtocol = previous.transportPolicy.protocol === 'deepseek-chat' ? 'openai-chat' : previous.transportPolicy.protocol ?? 'openai-chat'
    const changed = input.baseUrl.trim().replace(/\/+$/, '') !== displayBase || input.protocol !== previousProtocol
    const secret = input.apiKey?.trim() ?? ''
    if (secret && (input.clearApiKey || input.authStyle === 'none')) throw new ProviderRegistryError('credential_action_conflict', '清除或免 Key 不能同时填写新 API Key')
    if (input.authStyle === 'none' && previous.transportPolicy.scope !== 'loopback_http' && !changed) throw new ProviderRegistryError('auth_mode_invalid', '仅本机接口可明确免 Key')
    // Key-only edits must preserve non-/v1 native endpoints and preset metadata.
    if (!changed) {
      if (secret || input.clearApiKey || input.authStyle !== undefined) {
        this.db.exec('BEGIN')
        try {
          if (input.clearApiKey) this.clearProviderCredentials(previous.id)
          if (secret) {
            if (previous.defaultCredentialRefId) this.replaceCredential(previous.defaultCredentialRefId, secret)
            else this.createCredential(previous.id, 'API Key', secret)
          }
          const authStyle = input.authStyle ?? (secret ? 'bearer' : previous.authStyle)
          if (authStyle === 'bearer' && !secret && !input.clearApiKey && !previous.defaultCredentialRefId) throw new ProviderRegistryError('credential_missing', '请填写 API Key')
          this.db.prepare('UPDATE provider_registry SET auth_style=?,updated_at=? WHERE id=?').run(authStyle, nowIso(), previous.id)
          this.markCredentialAuthority(previous.id)
          this.db.exec('COMMIT')
        } catch (error) { this.db.exec('ROLLBACK'); throw error }
      }
      return providerFromRow(this.getProviderRow(previous.id))
    }
    let endpoint: ReturnType<typeof providerSetupEndpoint>
    try { endpoint = providerSetupEndpoint(input.baseUrl, input.protocol) }
    catch { throw new ProviderRegistryError('base_url_invalid', '请填写有效的 Base URL，并选择对应的 API 格式') }
    const originChanged = new URL(previous.baseUrl).origin !== new URL(endpoint.baseUrl).origin
    if (input.authStyle === 'none' && !endpoint.local) throw new ProviderRegistryError('auth_mode_invalid', '仅本机接口可明确免 Key')
    if (input.authStyle === 'bearer' && !secret && !previous.defaultCredentialRefId && !input.clearApiKey) throw new ProviderRegistryError('credential_missing', '请填写 API Key')
    const hasCredentials = Boolean(this.db.prepare('SELECT 1 FROM provider_credential_refs WHERE provider_id=?').get(previous.id))
    if (originChanged && hasCredentials && !secret && !input.clearApiKey) throw new ProviderRegistryError('credential_new_origin_required', '更换供应商地址时请重新填写 API Key，避免旧 Key 发往新的地址。')
    if (!endpoint.local && !secret && !previous.defaultCredentialRefId && !input.clearApiKey) throw new ProviderRegistryError('credential_missing', '请填写 API Key')
    if (previous.builtinLocked) {
      // Preserve the immutable native adapter; endpoint customization creates a
      // normal compatible provider and moves matching current selections to it.
      const originalModels = (this.db.prepare('SELECT * FROM provider_models WHERE provider_id=?').all(previous.id) as unknown as ModelRow[])
      const key = secret || (!originChanged && !input.clearApiKey && input.authStyle !== 'none' ? this.decryptCredential(previous.defaultCredentialRefId, previous) : '')
      const clone = await this.createProviderSetup({ displayName: previous.displayName + '（自定义）', baseUrl: input.baseUrl, protocol: input.protocol, apiKey: key, authStyle: input.authStyle, modelIds: originalModels.map(model => model.remote_model_id) })
      const bindings = this.snapshot().bindings
      if (bindings) {
        const next = { ...bindings }
        for (const stage of Object.keys(next) as Array<keyof StageProfileBindings>) {
          const profileId = next[stage]
          if (!profileId) continue
          const profile = this.getProfileRow(profileId)
          if (profile.provider_id !== previous.id) continue
          const remoteId = this.getModelRow(profile.model_id).remote_model_id
          const target = this.db.prepare('SELECT id FROM provider_models WHERE provider_id=? AND remote_model_id=?').get(clone.id, remoteId) as { id: string } | undefined
          if (target) next[stage] = this.ensureModelProfile(target.id).id
        }
        this.setBindings(next)
      }
      return clone
    }
    const transportPolicy = normalizeProviderPolicy({ ...previous.transportPolicy, scope: endpoint.local ? 'loopback_http' : 'public_https', allowNonDefaultPort: endpoint.local,
      protocol: input.protocol, authHeaderName: input.protocol === previousProtocol ? previous.transportPolicy.authHeaderName : input.protocol === 'anthropic-messages' ? 'x-api-key' : 'Authorization',
      fixedHeaders: input.protocol === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01' } : {},
      ...(originChanged ? { extraHeaders: {} } : {}) })
    const validated = await validateProviderEndpoint(endpoint.baseUrl, transportPolicy, this.resolver)
    this.db.exec('BEGIN')
    try {
      if (input.clearApiKey || originChanged) this.clearProviderCredentials(previous.id)
      this.db.prepare('UPDATE provider_registry SET base_url=?,chat_path=?,models_path=?,transport_policy_json=?,auth_style=?,updated_at=? WHERE id=?').run(
        validated.baseUrl, endpoint.chatPath, endpoint.modelsPath, JSON.stringify(transportPolicy), input.authStyle ?? (secret ? 'bearer' : previous.authStyle), nowIso(), previous.id)
      this.markCredentialAuthority(previous.id)
      if (secret) {
        if (previous.defaultCredentialRefId && !originChanged) this.replaceCredential(previous.defaultCredentialRefId, secret)
        else this.createCredential(previous.id, 'API Key', secret)
      }
      if (originChanged) {
        this.db.prepare('UPDATE provider_profiles SET credential_ref_id=NULL,updated_at=? WHERE provider_id=?').run(nowIso(), previous.id)
        this.db.prepare('UPDATE provider_models SET pricing_id=NULL,updated_at=? WHERE provider_id=?').run(nowIso(), previous.id)
      }
      // Directory/probe observations belonged to the old endpoint. Keep user
      // declarations, but re-enrich public specifications for the new dialect.
      const rows = this.db.prepare('SELECT * FROM provider_models WHERE provider_id=?').all(previous.id) as unknown as ModelRow[]
      for (const row of rows) {
        const caps = safeJson(row.capabilities_json, unknownModelCapabilities())
        const unknown = unknownModelCapabilities()
        for (const feature of Object.keys(caps) as Array<keyof ModelCapabilities>) {
          if (['models_endpoint', 'protocol_probe', 'model_catalog'].includes(caps[feature].source ?? '')) Object.assign(caps, { [feature]: unknown[feature] })
        }
        this.db.prepare('UPDATE provider_models SET capabilities_json=?,context_window=?,max_output_tokens=?,updated_at=? WHERE id=?').run(
          JSON.stringify(caps), row.source === 'discovered' ? null : row.context_window, row.source === 'discovered' ? null : row.max_output_tokens, nowIso(), row.id)
      }
      if (input.protocol !== previousProtocol) this.db.prepare("UPDATE provider_profiles SET reasoning_json=?,compatibility_mapping_id=NULL,updated_at=? WHERE provider_id=?").run(
        JSON.stringify({ mode: 'default', effort: null, budgetTokens: null }), nowIso(), previous.id)
      this.db.exec('COMMIT')
      return providerFromRow(this.getProviderRow(previous.id))
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private insertCustomProvider(input: Omit<ProviderRecord, 'id' | 'kind' | 'adapterId' | 'defaultCredentialRefId' | 'enabled' | 'builtinLocked' | 'createdAt' | 'updatedAt'>, normalizedBaseUrl: string): ProviderRecord {
    const chatPath = validateProviderPath(input.chatPath, 'Chat Completions 路径')!
    const modelsPath = validateProviderPath(input.modelsPath, '模型列表路径')
    const transportPolicy = normalizeProviderPolicy(input.transportPolicy)
    if (input.authStyle === 'none' && transportPolicy.scope !== 'loopback_http') throw new ProviderRegistryError('auth_mode_invalid', '仅本机接口可明确免 Key')
    const time = nowIso()
    const id = `provider.custom.${randomUUID()}`
    this.db.prepare(`INSERT INTO provider_registry (id,kind,adapter_id,display_name,base_url,chat_path,models_path,auth_style,default_credential_ref_id,enabled,builtin_locked,transport_policy_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, 'custom', 'custom.openai-compatible-chat', input.displayName.trim(), normalizedBaseUrl, chatPath, modelsPath, input.authStyle, null, 1, 0, JSON.stringify(transportPolicy), time, time
    )
    return providerFromRow(this.getProviderRow(id))
  }

  createCredential(providerId: string, label: string, secret: string): CredentialRefView {
    this.getProviderRow(providerId)
    if (!secret.trim()) throw new ProviderRegistryError('secret_empty', '凭据不能为空')
    if (secret.length > 4096) throw new ProviderRegistryError('secret_too_large', '凭据超过长度上限')
    if (!this.safeStorage.isEncryptionAvailable()) throw new ProviderRegistryError('safe_storage_unavailable', '系统安全存储不可用，凭据未保存')
    let encrypted: Buffer
    try { encrypted = this.safeStorage.encryptString(secret) } catch { throw new ProviderRegistryError('safe_storage_failed', '凭据加密失败，未保存') }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new ProviderRegistryError('safe_storage_failed', '凭据加密失败，未保存')
    const id = `credential.${randomUUID()}`
    const blobKey = `secret.${randomUUID()}`
    const time = nowIso()
    this.db.exec('SAVEPOINT credential_create')
    try {
      this.db.prepare('INSERT INTO provider_credential_secrets (encrypted_blob_key,encrypted_blob,created_at) VALUES (?,?,?)').run(blobKey, encrypted, time)
      this.db.prepare(`INSERT INTO provider_credential_refs (id,provider_id,label,encrypted_blob_key,masked_hint,status,current_version,created_at,updated_at,last_used_at) VALUES (?,?,?,?,?,'ready',1,?,?,NULL)`).run(id, providerId, label.trim(), blobKey, maskSecret(secret), time, time)
      this.db.prepare('INSERT INTO provider_credential_versions (credential_ref_id,version,encrypted_blob,created_at) VALUES (?,1,?,?)').run(id, encrypted, time)
      this.db.prepare('UPDATE provider_registry SET default_credential_ref_id=?,updated_at=? WHERE id=? AND default_credential_ref_id IS NULL').run(id, time, providerId)
      this.markCredentialAuthority(providerId)
      this.db.exec('RELEASE credential_create')
    } catch (error) {
      this.db.exec('ROLLBACK TO credential_create; RELEASE credential_create')
      throw error
    }
    return credentialFromRow(this.db.prepare('SELECT * FROM provider_credential_refs WHERE id=?').get(id) as unknown as CredentialRow)
  }

  replaceCredential(credentialRefId: string, secret: string): CredentialRefView {
    const row = this.db.prepare('SELECT * FROM provider_credential_refs WHERE id=?').get(credentialRefId) as CredentialRow | undefined
    if (!row) throw new ProviderRegistryError('credential_not_found', '未找到凭据')
    if (!secret.trim()) throw new ProviderRegistryError('secret_empty', '凭据不能为空')
    if (secret.length > 4096) throw new ProviderRegistryError('secret_too_large', '凭据超过长度上限')
    if (!this.safeStorage.isEncryptionAvailable()) throw new ProviderRegistryError('safe_storage_unavailable', '系统安全存储不可用，凭据未更换')
    let encrypted: Buffer
    try { encrypted = this.safeStorage.encryptString(secret) } catch { throw new ProviderRegistryError('safe_storage_failed', '凭据加密失败，未更换') }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new ProviderRegistryError('safe_storage_failed', '凭据加密失败，未更换')
    const time = nowIso()
    const nextVersion = row.current_version + 1
    this.db.exec('SAVEPOINT credential_replace')
    try {
      this.db.prepare('INSERT INTO provider_credential_versions (credential_ref_id,version,encrypted_blob,created_at) VALUES (?,?,?,?)').run(credentialRefId, nextVersion, encrypted, time)
      this.db.prepare('INSERT INTO provider_credential_secrets (encrypted_blob_key,encrypted_blob,created_at) VALUES (?,?,?) ON CONFLICT(encrypted_blob_key) DO UPDATE SET encrypted_blob=excluded.encrypted_blob,created_at=excluded.created_at').run(row.encrypted_blob_key, encrypted, time)
      this.db.prepare("UPDATE provider_credential_refs SET masked_hint=?,status='ready',current_version=?,updated_at=? WHERE id=? AND current_version=?").run(maskSecret(secret), nextVersion, time, credentialRefId, row.current_version)
      this.markCredentialAuthority(row.provider_id)
      this.db.exec('RELEASE credential_replace')
    } catch (error) {
      this.db.exec('ROLLBACK TO credential_replace; RELEASE credential_replace')
      throw error
    }
    return credentialFromRow(this.db.prepare('SELECT * FROM provider_credential_refs WHERE id=?').get(credentialRefId) as unknown as CredentialRow)
  }

  deleteCredential(credentialRefId: string): void {
    const row = this.db.prepare('SELECT * FROM provider_credential_refs WHERE id=?').get(credentialRefId) as CredentialRow | undefined
    if (!row) return
    const referenced = this.db.prepare('SELECT COUNT(*) AS n FROM provider_profiles WHERE credential_ref_id=?').get(credentialRefId) as { n: number }
    if (referenced.n > 0) throw new ProviderRegistryError('credential_in_use', '凭据仍被 Profile 引用，请先更换')
    this.db.exec('BEGIN')
    try {
      this.retireCredential(credentialRefId)
      this.markCredentialAuthority(row.provider_id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private retireCredential(credentialRefId: string): void {
    const row = this.db.prepare('SELECT encrypted_blob_key FROM provider_credential_refs WHERE id=?').get(credentialRefId) as { encrypted_blob_key: string } | undefined
    if (!row) return
    this.db.prepare('UPDATE provider_registry SET default_credential_ref_id=NULL,updated_at=? WHERE default_credential_ref_id=?').run(nowIso(), credentialRefId)
    this.db.prepare('UPDATE provider_profiles SET credential_ref_id=NULL,updated_at=? WHERE credential_ref_id=?').run(nowIso(), credentialRefId)
    // Accepted runs retain their exact immutable version; only current selection is cleared.
    this.db.prepare("UPDATE provider_credential_refs SET status='missing',masked_hint=NULL,updated_at=? WHERE id=?").run(nowIso(), credentialRefId)
    this.db.prepare('DELETE FROM provider_credential_secrets WHERE encrypted_blob_key=?').run(row.encrypted_blob_key)
  }

  private clearProviderCredentials(providerId: string): void {
    const rows = this.db.prepare('SELECT id FROM provider_credential_refs WHERE provider_id=?').all(providerId) as { id: string }[]
    for (const row of rows) this.retireCredential(row.id)
    this.markCredentialAuthority(providerId)
  }

  setDefaultCredential(providerId: string, credentialRefId: string): void {
    const credential = this.db.prepare('SELECT provider_id,status FROM provider_credential_refs WHERE id=?').get(credentialRefId) as { provider_id: string; status: CredentialRefView['status'] } | undefined
    if (!credential || credential.provider_id !== providerId) throw new ProviderRegistryError('credential_provider_mismatch', '凭据不属于该 Provider')
    if (credential.status !== 'ready') throw new ProviderRegistryError('credential_missing', '凭据不可用')
    this.db.exec('SAVEPOINT credential_default')
    try {
      this.db.prepare('UPDATE provider_registry SET default_credential_ref_id=?,updated_at=? WHERE id=?').run(credentialRefId, nowIso(), providerId)
      this.markCredentialAuthority(providerId)
      this.db.exec('RELEASE credential_default')
    } catch (error) { this.db.exec('ROLLBACK TO credential_default; RELEASE credential_default'); throw error }
  }

  private decryptCredential(credentialRefId: string | null, provider: ProviderRecord): string {
    const id = credentialRefId ?? provider.defaultCredentialRefId
    if (provider.authStyle === 'none') return ''
    if (!id) throw new ProviderRegistryError('credential_missing', '当前 Profile 没有可用凭据')
    const row = this.db.prepare('SELECT * FROM provider_credential_refs WHERE id=?').get(id) as CredentialRow | undefined
    if (!row || row.provider_id !== provider.id || row.status !== 'ready') throw new ProviderRegistryError('credential_missing', '当前 Profile 的凭据不可用')
    return this.resolveFrozenCredential({ credentialRefId: id, providerId: provider.id, version: row.current_version })
  }

  /** Resolve one immutable encrypted version; never follows the current pointer. */
  resolveFrozenCredential(reference: FrozenCredentialReference): string {
    const row = this.db.prepare(`SELECT r.provider_id,v.encrypted_blob
      FROM provider_credential_refs r
      JOIN provider_credential_versions v ON v.credential_ref_id=r.id
      WHERE r.id=? AND v.version=?`).get(reference.credentialRefId, reference.version) as { provider_id: string; encrypted_blob: Uint8Array } | undefined
    if (!row || row.provider_id !== reference.providerId) throw new ProviderRegistryError('credential_missing', '运行冻结的凭据版本不存在，需要重新授权')
    if (!this.safeStorage.isEncryptionAvailable()) throw new ProviderRegistryError('credential_locked', '系统安全存储当前不可用')
    let secret: string
    try { secret = this.safeStorage.decryptString(Buffer.from(row.encrypted_blob)) } catch { throw new ProviderRegistryError('credential_locked', '运行冻结的凭据版本无法解密，需要重新授权') }
    this.db.prepare('UPDATE provider_credential_refs SET last_used_at=? WHERE id=?').run(nowIso(), reference.credentialRefId)
    return secret
  }

  addManualModel(input: { providerId: string; remoteModelId: string; displayName: string; contextWindow?: number | null; maxOutputTokens?: number | null; capabilities?: ModelCapabilities }): ModelRecord {
    this.getProviderRow(input.providerId)
    const remoteId = input.remoteModelId.trim()
    if (!remoteId || remoteId.length > 200 || /[\u0000-\u001f]/.test(remoteId)) throw new ProviderRegistryError('model_id_invalid', '模型 ID 无效')
    const existing = this.db.prepare('SELECT * FROM provider_models WHERE provider_id=? AND remote_model_id=?').get(input.providerId, remoteId) as ModelRow | undefined
    if (existing) { this.ensureModelProfile(existing.id); return this.modelFromRow(existing) }
    const id = `model.custom.${randomUUID()}`
    const time = nowIso()
    const capabilities = input.capabilities ?? unknownModelCapabilities()
    this.db.exec('SAVEPOINT model_create')
    try {
      this.db.prepare(`INSERT INTO provider_models (id,provider_id,remote_model_id,display_name,source,enabled,context_window,max_output_tokens,capabilities_json,pricing_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, input.providerId, remoteId, input.displayName.trim() || remoteId, 'manual', 1, input.contextWindow ?? null, input.maxOutputTokens ?? null, JSON.stringify(capabilities), null, time, time
      )
      this.ensureModelProfile(id)
      this.db.exec('RELEASE model_create')
    } catch (error) {
      this.db.exec('ROLLBACK TO model_create; RELEASE model_create')
      throw error
    }
    return this.modelFromRow(this.getModelRow(id))
  }

  ensureModelProfile(modelId: string): ProfileRecord {
    const existing = this.db.prepare('SELECT * FROM provider_profiles WHERE model_id=? ORDER BY created_at LIMIT 1').get(modelId) as ProfileRow | undefined
    if (existing) return this.profileFromRow(existing)
    const model = this.modelFromRow(this.getModelRow(modelId))
    return this.upsertProfile({ id: `profile.model.${modelId}`, name: model.displayName, providerId: model.providerId, modelId, credentialRefId: null,
      generation: { temperature: null, topP: null, maxOutputTokens: null, stream: true },
      reasoning: { mode: 'default', effort: null, budgetTokens: null }, compatibilityMappingId: null })
  }

  upsertProfile(input: Omit<ProfileRecord, 'createdAt' | 'updatedAt'>, allowUnverifiedImport = false): ProfileRecord {
    const provider = providerFromRow(this.getProviderRow(input.providerId))
    const model = this.modelFromRow(this.getModelRow(input.modelId))
    if (model.providerId !== provider.id) throw new ProviderRegistryError('model_provider_mismatch', '模型不属于所选 Provider')
    if (!provider.enabled || !model.enabled) throw new ProviderRegistryError('profile_target_disabled', '所选 Provider 或模型已禁用')
    if (input.credentialRefId) {
      const credential = this.db.prepare('SELECT provider_id,status FROM provider_credential_refs WHERE id=?').get(input.credentialRefId) as { provider_id: string; status: CredentialRefView['status'] } | undefined
      if (!credential || credential.provider_id !== provider.id) throw new ProviderRegistryError('credential_provider_mismatch', '凭据不属于所选 Provider')
      if (credential.status !== 'ready') throw new ProviderRegistryError('credential_missing', '所选凭据不可用')
    }
    const reasoning = input.reasoning
    if (reasoning.budgetTokens !== null) {
      const proof = model.capabilities.reasoning
      const range = proof.budget
      if (provider.transportPolicy.protocol !== 'anthropic-messages' || !['anthropic.thinking', 'anthropic.thinking_effort'].includes(input.compatibilityMappingId ?? '') || proof.state !== 'supported' || !['model_catalog', 'protocol_probe'].includes(proof.source ?? '') || !range || reasoning.mode !== 'enabled') throw new ProviderRegistryError('reasoning_budget_unsupported', '该模型未提供可设置的推理 token 预算')
      if (!Number.isSafeInteger(reasoning.budgetTokens) || reasoning.budgetTokens < range.min || reasoning.budgetTokens > range.max || (reasoning.budgetTokens - range.min) % range.step !== 0) throw new ProviderRegistryError('reasoning_budget_invalid', `推理预算须为 ${range.min}–${range.max} tokens，步长 ${range.step}`)
      const output = input.generation.maxOutputTokens ?? model.maxOutputTokens
      if (output !== null && reasoning.budgetTokens >= output) throw new ProviderRegistryError('reasoning_budget_invalid', '推理预算必须低于最大输出')
    }
    if (provider.adapterId === 'builtin.deepseek' && !['default', 'disabled', 'enabled'].includes(reasoning.mode)) throw new ProviderRegistryError('reasoning_mode_unsupported', 'DeepSeek P0 adapter 不支持该推理模式')
    if (provider.adapterId === 'builtin.deepseek' && reasoning.mode === 'enabled') {
      const effort = normalizeDeepSeekReasoningEffort(reasoning.effort)
      const proof = model.capabilities.reasoning
      if (proof.state !== 'supported' || !['builtin_manifest', 'protocol_probe'].includes(proof.source ?? '') || effort === null || effort === 'none' || !proof.efforts.includes(effort)) throw new ProviderRegistryError('reasoning_effort_unsupported', '必须选择已验证模型的实际推理强度')
    }
    if (provider.adapterId === 'custom.openai-compatible-chat' && reasoning.mode !== 'default') {
      const protocol = provider.transportPolicy.protocol ?? 'openai-chat'
      const allowedMappings = protocol === 'openai-responses'
        ? ['openai_responses.reasoning_effort']
        : protocol === 'anthropic-messages'
          ? ['anthropic.thinking', 'anthropic.thinking_effort', 'anthropic.adaptive']
          : ['openai_chat.reasoning_effort_top_level', 'openai_chat.thinking', 'openai_chat.enable_thinking', 'openai_chat.reasoning']
      const proof = model.capabilities.reasoning
      const trusted = ['protocol_probe', 'model_catalog', 'models_endpoint'].includes(proof.source ?? '')
      if (!allowUnverifiedImport && (!proof.modes.includes(reasoning.mode) || proof.state !== 'supported' || !trusted || !input.compatibilityMappingId || !allowedMappings.includes(input.compatibilityMappingId) || proof.mappingId && proof.mappingId !== input.compatibilityMappingId)) {
        throw new ProviderRegistryError('reasoning_unsupported', '该模型不支持所选思考方式，请使用模型提供的选项')
      }
      if (reasoning.mode !== 'disabled' && reasoning.effort && !proof.efforts.includes(reasoning.effort)) throw new ProviderRegistryError('reasoning_effort_unsupported', '请选择模型提供的思考强度')
      if (reasoning.mode === 'enabled' && ['anthropic.thinking', 'anthropic.thinking_effort'].includes(input.compatibilityMappingId ?? '') && reasoning.budgetTokens === null) throw new ProviderRegistryError('reasoning_budget_required', '此模型开启推理需要显式填写 token 预算；也可选按模型默认')
    }
    const existing = this.db.prepare('SELECT created_at FROM provider_profiles WHERE id=?').get(input.id) as { created_at: string } | undefined
    const time = nowIso()
    this.db.prepare(`INSERT INTO provider_profiles (id,name,provider_id,model_id,credential_ref_id,generation_json,reasoning_json,compatibility_mapping_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider_id=excluded.provider_id,model_id=excluded.model_id,credential_ref_id=excluded.credential_ref_id,generation_json=excluded.generation_json,reasoning_json=excluded.reasoning_json,compatibility_mapping_id=excluded.compatibility_mapping_id,updated_at=excluded.updated_at`).run(
      input.id, input.name.trim(), input.providerId, input.modelId, input.credentialRefId, JSON.stringify(input.generation), JSON.stringify(input.reasoning), input.compatibilityMappingId, existing?.created_at ?? time, time
    )
    if (input.id === 'profile.deepseek.default') this.db.prepare("INSERT INTO provider_registry_state (key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").run(`profile_output_limit:${input.id}`, JSON.stringify(input.generation.maxOutputTokens), time)
    return this.profileFromRow(this.getProfileRow(input.id))
  }

  setBindings(bindings: StageProfileBindings): void {
    const ids = [bindings.defaultProfileId, bindings.planningProfileId, bindings.draftProfileId, bindings.reviewProfileId, bindings.polishProfileId].filter(Boolean) as string[]
    for (const id of ids) this.getProfileRow(id)
    this.db.prepare(`INSERT INTO provider_registry_state (key,value_json,updated_at) VALUES ('bindings',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(JSON.stringify(bindings), nowIso())
    this.db.prepare(`INSERT INTO provider_registry_state (key,value_json,updated_at) VALUES ('bindings_explicit','true',?) ON CONFLICT(key) DO UPDATE SET value_json='true',updated_at=excluded.updated_at`).run(nowIso())
  }

  resolveEffective(profileId: string): EffectiveProfile {
    const profile = this.profileFromRow(this.getProfileRow(profileId))
    const provider = providerFromRow(this.getProviderRow(profile.providerId))
    const model = this.modelFromRow(this.getModelRow(profile.modelId))
    const appliedMappings: string[] = []
    const omittedControls: string[] = []
    if (profile.reasoning.mode === 'default') omittedControls.push('reasoning.default')
    else if (provider.adapterId === 'builtin.deepseek') appliedMappings.push('deepseek.thinking.type')
    else if (model.capabilities.reasoning.state === 'supported' && ['protocol_probe', 'model_catalog', 'models_endpoint'].includes(model.capabilities.reasoning.source ?? '') && profile.compatibilityMappingId && COMPATIBILITY_MAPPINGS.includes(profile.compatibilityMappingId) && (!model.capabilities.reasoning.mappingId || model.capabilities.reasoning.mappingId === profile.compatibilityMappingId)) appliedMappings.push(profile.compatibilityMappingId)
    else omittedControls.push('reasoning.unverified')
    if (profile.reasoning.effort && appliedMappings.length > 0) appliedMappings.push('reasoning.effort')
    if (profile.reasoning.budgetTokens !== null && appliedMappings.length) appliedMappings.push('reasoning.budget.explicit')
    return { provider, model, profile, credentialRefId: profile.credentialRefId ?? provider.defaultCredentialRefId, capabilities: model.capabilities, appliedMappings, omittedControls }
  }

  /**
   * Freeze complete wire-ready profiles before chat acceptance. Runtime model
   * calls may only decrypt the exact credential version referenced here; they
   * must not re-resolve mutable registry rows.
   */
  freezeStageProfiles(bindings: StageProfileBindings, legacy: {
    outputTokenLimit?: number | null
    maxTokens: number
    temperature: number
    topP: number
    thinking: { enabled: boolean; effort: 'default' | 'low' | 'medium' | 'high' | 'max' }
    providerCapabilityOverride?: CapabilityOverride
  }, activeStages?: ReadonlyArray<'default' | 'planning' | 'draft' | 'review' | 'polish'>): FrozenStageProfileSnapshots {
    const freezeOne = (profileId: string): FrozenExecutableProfile => {
      const effective = this.resolveEffective(profileId)
      if (!effective.provider.enabled || !effective.model.enabled) throw new ProviderRegistryError('profile_target_disabled', '所选 Provider 或模型已禁用')
      let credential: FrozenCredentialReference | null = null
      if (effective.provider.authStyle === 'bearer') {
        if (!effective.credentialRefId) throw new ProviderRegistryError('credential_missing', '当前 Profile 没有可用凭据')
        const row = this.db.prepare('SELECT provider_id,status,current_version FROM provider_credential_refs WHERE id=?').get(effective.credentialRefId) as Pick<CredentialRow, 'provider_id' | 'status' | 'current_version'> | undefined
        if (!row || row.provider_id !== effective.provider.id || row.status !== 'ready') throw new ProviderRegistryError('credential_missing', '当前 Profile 的凭据不可用')
        const versionExists = this.db.prepare('SELECT 1 FROM provider_credential_versions WHERE credential_ref_id=? AND version=?').get(effective.credentialRefId, row.current_version)
        if (!versionExists) throw new ProviderRegistryError('credential_missing', '当前凭据缺少可冻结版本')
        credential = { credentialRefId: effective.credentialRefId, providerId: effective.provider.id, version: row.current_version }
      }
      const reasoningDefault = effective.profile.reasoning.mode === 'default'
      const rawEffort = reasoningDefault ? 'default' : effective.profile.reasoning.effort ?? 'default'
      const builtinEffort = effective.provider.adapterId === 'builtin.deepseek' ? normalizeDeepSeekReasoningEffort(rawEffort) : undefined
      if (effective.provider.adapterId === 'builtin.deepseek' && builtinEffort === null) throw new ProviderRegistryError('reasoning_effort_unsupported', 'DeepSeek 推理强度未知，已拒绝冻结')
      const effort = (rawEffort === 'default' ? 'default' : builtinEffort === 'none' ? 'high' : builtinEffort ?? rawEffort) as 'default' | 'low' | 'medium' | 'high' | 'max'
      const mappedReasoning = effective.appliedMappings.some((mapping) => (COMPATIBILITY_MAPPINGS as readonly string[]).includes(mapping))
      const context = resolveRegistryContextCapability({
        providerKind: effective.provider.kind,
        adapterId: effective.provider.adapterId,
        remoteModelId: effective.model.remoteModelId,
        declaredContextWindow: effective.model.contextWindow,
        declaredMaxOutputTokens: effective.model.maxOutputTokens,
        profileMaxOutputTokens: effective.profile.generation.maxOutputTokens,
        settingsMaxOutputTokens: legacy.maxTokens,
        override: legacy.providerCapabilityOverride,
        allowConservativeFallback: true
      })
      const body: Omit<FrozenExecutableProfile, 'fingerprint'> = {
        version: 1,
        profileId: effective.profile.id,
        profileName: effective.profile.name,
        contextBudget: { contextWindowTokens: context.maxContextTokens, outputReserveTokens: Math.min(context.outputReserveTokens, 8192), source: context.contextSource },
        provider: {
          id: effective.provider.id,
          adapterId: effective.provider.adapterId,
          baseUrl: effective.provider.baseUrl,
          chatPath: effective.provider.chatPath,
          authStyle: effective.provider.authStyle,
          transportPolicy: structuredClone(effective.provider.transportPolicy)
        },
        model: {
          id: effective.model.id,
          remoteModelId: effective.model.remoteModelId,
          contextWindow: effective.model.contextWindow,
          maxOutputTokens: effective.model.maxOutputTokens ?? trustedBuiltinMaxOutputTokens(effective.provider.kind, effective.provider.adapterId, effective.model.remoteModelId),
          capabilityProof: structuredClone(effective.capabilities),
          // Freeze the price evidence beside endpoint/model identity. A
          // later registry edit must not change the budget semantics of an
          // already accepted run. Unknown/custom prices remain null.
          pricing: effective.model.pricing ? structuredClone(effective.model.pricing) : null
        },
        credential,
        generation: {
          outputTokenLimit: effective.profile.generation.maxOutputTokens,
          outputLimitSource: effective.profile.generation.maxOutputTokens !== null ? 'user_explicit'
            : effective.provider.transportPolicy.protocol === 'anthropic-messages' ? effective.model.maxOutputTokens !== null ? 'model_declaration' : 'protocol_required_fallback' : 'provider_default',
          maxOutputTokens: context.outputReserveTokens,
          temperature: reasoningDefault ? legacy.temperature : (effective.profile.generation.temperature ?? 1),
          topP: reasoningDefault ? legacy.topP : (effective.profile.generation.topP ?? 1),
          stream: effective.profile.generation.stream
        },
        reasoning: structuredClone(effective.profile.reasoning),
        wireReasoning: {
          thinking: effective.provider.adapterId === 'builtin.deepseek'
            ? { enabled: effective.profile.reasoning.mode !== 'disabled' && builtinEffort !== 'none', effort }
            : { enabled: effective.profile.reasoning.mode === 'enabled' || effective.profile.reasoning.mode === 'adaptive', effort },
          mode: effective.provider.adapterId === 'custom.openai-compatible-chat' && !mappedReasoning ? 'default' : effective.profile.reasoning.mode,
          budgetTokens: effective.profile.reasoning.budgetTokens,
          // A catalog mapping also tells the adapter which output-limit and
          // sampling dialect to use in default mode; it does not enable thinking.
          compatibilityMappingId: mappedReasoning ? effective.profile.compatibilityMappingId : effective.profile.reasoning.mode === 'default' ? effective.capabilities.reasoning.mappingId ?? null : null
        },
        appliedMappings: [...effective.appliedMappings],
        omittedControls: [...effective.omittedControls],
        supportsTools: supportsAgentTools(effective.provider.adapterId, effective.capabilities)
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      return { ...body, fingerprint }
    }
    const fallback = bindings.defaultProfileId
    const freezeStage = (stage: 'default' | 'planning' | 'draft' | 'review' | 'polish', profileId: string): FrozenExecutableProfile | null =>
      !activeStages || activeStages.includes(stage) ? freezeOne(profileId) : null
    const stages = {
      default: freezeStage('default', fallback),
      planning: freezeStage('planning', bindings.planningProfileId ?? fallback),
      draft: freezeStage('draft', bindings.draftProfileId ?? fallback),
      review: freezeStage('review', bindings.reviewProfileId ?? fallback),
      polish: freezeStage('polish', bindings.polishProfileId ?? fallback)
    }
    return { version: 1, frozenAt: nowIso(), ...stages }
  }

  resolveForRequest(profileId: string): EffectiveProfile & { secret: string } {
    const effective = this.resolveEffective(profileId)
    return { ...effective, secret: this.decryptCredential(effective.credentialRefId, effective.provider) }
  }

  private async providerHeaders(provider: ProviderRecord, credentialRefId?: string | null, targetUrl = canonicalJoin(provider.baseUrl, provider.modelsPath ?? provider.chatPath), stream = false): Promise<Record<string, string>> {
    const secret = provider.authStyle === 'none' ? null : this.decryptCredential(credentialRefId ?? null, provider)
    return buildProviderAuthHeaders({
      baseUrl: provider.baseUrl, authStyle: provider.authStyle,
      authHeaderName: provider.transportPolicy.authHeaderName, protocol: provider.transportPolicy.protocol,
      transportPolicy: provider.transportPolicy, extraHeaders: provider.transportPolicy.extraHeaders,
      fixedHeaders: provider.transportPolicy.fixedHeaders
    }, secret, { targetUrl, accept: stream ? 'text/event-stream' : 'application/json', jsonBody: stream })
  }

  private async readModelDirectory(provider: ProviderRecord, credentialRefId?: string | null): Promise<ParsedProviderDiscovery> {
    if (!provider.modelsPath) throw new ProviderRegistryError('models_endpoint_unsupported', '该 Provider 未配置模型列表接口，可手动添加模型')
    let target = canonicalJoin(provider.baseUrl, provider.modelsPath)
    const models: ParsedProviderDiscovery['models'] = []
    const ids = new Set<string>(), cursors = new Set<string>()
    for (let page = 0; page < 10; page++) {
      const response = await secureProviderFetch(target, { headers: await this.providerHeaders(provider, credentialRefId, target) }, provider.transportPolicy, this.resolver, { maxBodyBytes: 2 * 1024 * 1024 })
      if (!response.ok) throw new ProviderRegistryError(response.status === 404 ? 'models_endpoint_unsupported' : 'model_discovery_failed', `获取模型失败（HTTP ${response.status}）`)
      if (!(response.headers.get('content-type') ?? '').includes('json')) throw new ProviderRegistryError('model_discovery_invalid', '模型列表不是 JSON')
      const parsed = parseProviderDiscovery(provider, await response.json())
      for (const model of parsed.models) {
        if (ids.has(model.remoteModelId)) throw new ProviderRegistryError('model_discovery_invalid', '分页模型列表含重复 ID')
        ids.add(model.remoteModelId); models.push(model)
      }
      if (models.length > 500) throw new ProviderRegistryError('model_discovery_too_large', '模型总数超过安全上限')
      if (!parsed.nextPage) return { ...parsed, models }
      if (cursors.has(parsed.nextPage.value)) throw new ProviderRegistryError('model_discovery_invalid', '模型分页游标循环')
      cursors.add(parsed.nextPage.value)
      const next = new URL(canonicalJoin(provider.baseUrl, provider.modelsPath))
      // Only protocol-owned pagination parameters, never credentials or a server-returned URL.
      next.searchParams.set('after_id', parsed.nextPage.value); next.searchParams.set('limit', '100')
      target = next.toString()
    }
    throw new ProviderRegistryError('model_discovery_too_large', '模型分页超过安全上限')
  }

  async checkConnection(providerId: string, credentialRefId?: string | null): Promise<{ status: 'protocol_verified' | 'network_only' | 'unsupported'; modelCount: number | null }> {
    const provider = providerFromRow(this.getProviderRow(providerId))
    await validateProviderEndpoint(provider.baseUrl, provider.transportPolicy, this.resolver)
    if (!provider.modelsPath) return { status: 'network_only', modelCount: null }
    try {
      const parsed = await this.readModelDirectory(provider, credentialRefId)
      return { status: parsed.catalogComplete ? 'protocol_verified' : 'network_only', modelCount: parsed.models.length }
    } catch (error) {
      if (error instanceof ProviderRegistryError && error.code === 'models_endpoint_unsupported') return { status: 'unsupported', modelCount: null }
      throw error
    }
  }

  async discoverPreview(providerId: string, credentialRefId?: string | null): Promise<DiscoveryPreview> {
    const provider = providerFromRow(this.getProviderRow(providerId))
    const parsed = await this.readModelDirectory(provider, credentialRefId)
    const preview: DiscoveryPreview = { discoveryId: `discovery.${randomUUID()}`, providerId, models: parsed.models, catalogComplete: parsed.catalogComplete, expiresAt: Date.now() + 10 * 60_000 }
    this.discovery.set(preview.discoveryId, preview)
    return preview
  }

  acceptDiscovered(discoveryId: string, remoteModelIds: string[]): ModelRecord[] {
    const preview = this.discovery.get(discoveryId)
    if (!preview || preview.expiresAt < Date.now()) throw new ProviderRegistryError('discovery_expired', '模型发现预览已过期')
    const selected = preview.models.filter((model) => remoteModelIds.includes(model.remoteModelId))
    const output: ModelRecord[] = []
    for (const item of selected) {
      const existing = this.db.prepare('SELECT * FROM provider_models WHERE provider_id=? AND remote_model_id=?').get(preview.providerId, item.remoteModelId) as ModelRow | undefined
      if (existing) {
        const capabilities = safeJson(existing.capabilities_json, unknownModelCapabilities())
        if (item.capabilities) {
          for (const key of Object.keys(capabilities) as Array<keyof ModelCapabilities>) {
            const next = item.capabilities[key]
            const previous = capabilities[key]
            if (next.state !== 'unknown' && (previous.state === 'unknown' || ['models_endpoint', 'model_catalog', 'imported_declaration'].includes(previous.source ?? ''))) {
              Object.assign(capabilities, { [key]: next })
            }
          }
        }
        this.db.prepare('UPDATE provider_models SET context_window=?,max_output_tokens=?,capabilities_json=?,updated_at=? WHERE id=?').run(
          existing.context_window ?? item.contextWindow, existing.max_output_tokens ?? item.maxOutputTokens, JSON.stringify(capabilities), nowIso(), existing.id
        )
        if (item.pricing && !existing.pricing_id) this.upsertPricing(item.pricing)
        this.ensureModelProfile(existing.id); output.push(this.modelFromRow(this.getModelRow(existing.id))); continue
      }
      const id = `model.discovered.${randomUUID()}`
      const time = nowIso()
      const capabilities = item.capabilities ?? unknownModelCapabilities()
      if (!item.capabilities) capabilities.text = { state: 'supported', source: 'models_endpoint', verifiedAt: time, probeId: null, detailCode: 'data[].id' }
      this.db.prepare(`INSERT INTO provider_models (id,provider_id,remote_model_id,display_name,source,enabled,context_window,max_output_tokens,capabilities_json,pricing_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, preview.providerId, item.remoteModelId, item.displayName, 'discovered', 1, item.contextWindow, item.maxOutputTokens, JSON.stringify(capabilities), null, time, time
      )
      if (item.pricing) this.upsertPricing(item.pricing)
      this.ensureModelProfile(id)
      output.push(this.modelFromRow(this.getModelRow(id)))
    }
    this.discovery.delete(discoveryId)
    return output
  }

  async testModelConnection(modelId: string, credentialRefId: string | null | undefined, acknowledgeMayBill: true): Promise<ModelConnectionResult> {
    if (acknowledgeMayBill !== true) throw new ProviderRegistryError('probe_confirmation_required', '测试会发送一条短请求，请先确认')
    const model = this.modelFromRow(this.getModelRow(modelId))
    const provider = providerFromRow(this.getProviderRow(model.providerId))
    if (!model.enabled || !provider.enabled) throw new ProviderRegistryError('profile_target_disabled', '模型或供应商已禁用')
    const target = canonicalJoin(provider.baseUrl, provider.chatPath)
    const protocol = provider.transportPolicy.protocol ?? 'openai-chat'
    const mapping = model.capabilities.reasoning.mappingId ?? null
    const request = providerRequestBody({ model: model.remoteModelId, messages: [{ role: 'user', content: 'Reply with OK.' }],
      maxTokens: Math.min(512, model.maxOutputTokens ?? 512), apiKey: '', thinking: { enabled: false, effort: 'low' },
      provider: { adapterId: provider.adapterId, protocol, chatPath: provider.chatPath, authStyle: provider.authStyle, transportPolicy: provider.transportPolicy,
        reasoning: { mode: mapping && model.capabilities.reasoning.modes.includes('disabled') ? 'disabled' : 'default', effort: null }, compatibilityMappingId: mapping } }, protocol === 'deepseek-chat' ? 'openai-chat' : protocol)
    request.stream = false
    delete request.stream_options; delete request.temperature; delete request.top_p
    const startedAt = Date.now()
    const headers = { ...await this.providerHeaders(provider, credentialRefId, target), 'content-type': 'application/json' }
    try {
      const response = await secureProviderFetch(target, { method: 'POST', headers, body: JSON.stringify(request) }, provider.transportPolicy, this.resolver, { timeoutMs: 30_000, maxBodyBytes: 256 * 1024 })
      if (!response.ok) throw new ProviderRegistryError('model_connection_failed', providerHttpErrorMessage(response.status))
      // A successful directory lookup or empty HTTP 200 is not a generation test.
      const payload = await response.json() as Record<string, any>
      const text = protocol === 'anthropic-messages'
        ? (Array.isArray(payload.content) ? payload.content : []).filter((part: any) => part.type === 'text').map((part: any) => part.text ?? '').join('')
        : protocol === 'openai-responses'
          ? (Array.isArray(payload.output) ? payload.output : []).filter((part: any) => part.type === 'message').flatMap((part: any) => part.content ?? []).map((part: any) => part.text ?? '').join('')
          : payload.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim() || payload.error) throw new ProviderRegistryError('model_connection_invalid', '接口未返回有效模型回复，请检查 API 格式和模型 ID。')
      const tokens = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
      const testedAt = nowIso()
      return { status: 'connected', modelId, testedAt, durationMs: Date.now() - startedAt,
        usage: { inputTokens: tokens(payload.usage?.input_tokens ?? payload.usage?.prompt_tokens), outputTokens: tokens(payload.usage?.output_tokens ?? payload.usage?.completion_tokens) } }
    } catch (error) {
      if (error instanceof ProviderRegistryError) throw error
      // Server response bodies and transport errors can echo credentials. Do not forward them.
      throw new ProviderRegistryError('model_connection_failed', '模型调用未完成，请检查地址、API 格式和 Key 后重试。')
    }
  }

  async probeModelTools(modelId: string, credentialRefId: string | null | undefined, acknowledgeMayBill: true): Promise<ProbeResult> {
    if (acknowledgeMayBill !== true) throw new ProviderRegistryError('probe_confirmation_required', '工具调用测试会发送一条请求，可能产生少量费用，请先确认')
    const model = this.modelFromRow(this.getModelRow(modelId))
    const provider = providerFromRow(this.getProviderRow(model.providerId))
    if (!model.enabled || !provider.enabled) throw new ProviderRegistryError('profile_target_disabled', '模型或供应商已禁用')
    const target = canonicalJoin(provider.baseUrl, provider.chatPath)
    const credentialId = credentialRefId ?? provider.defaultCredentialRefId
    const headers = { ...await this.providerHeaders(provider, credentialId, target), 'content-type': 'application/json' }
    const nonce = randomUUID()
    const probeId = `probe.tools.${randomUUID()}`
    this.db.prepare(`INSERT INTO provider_probes (probe_id,provider_id,model_id,credential_ref_id,started_at,outcome,usage_json,cost_status) VALUES (?,?,?,?,?,'in_flight','{}','unknown')`).run(probeId, provider.id, model.id, credentialId, nowIso())
    let outcome: ProbeResult['outcome'] = 'inconclusive'
    let httpStatus: number | null = null
    let usage: ProbeResult['usage'] = { inputTokens: null, outputTokens: null, reasoningTokens: null }
    try {
      const response = await secureProviderFetch(target, { method: 'POST', headers, body: JSON.stringify(toolProbeRequest(provider, model, nonce)) },
        provider.transportPolicy, this.resolver, { timeoutMs: 30_000, maxBodyBytes: 256 * 1024 })
      httpStatus = response.status
      if (response.ok) ({ outcome, usage } = readToolProbeResponse(await response.json(), provider.transportPolicy.protocol ?? 'openai-chat', nonce))
    } catch { /* Transport errors and provider bodies may echo secrets; never return or persist them. */ }
    const currentProvider = providerFromRow(this.getProviderRow(provider.id))
    const currentModel = this.getModelRow(modelId)
    // A reply from an endpoint edited while the request was in flight cannot prove the new endpoint's capabilities.
    if (!currentProvider.enabled || currentModel.enabled !== 1 || currentProvider.baseUrl !== provider.baseUrl || currentProvider.chatPath !== provider.chatPath || JSON.stringify(currentProvider.transportPolicy) !== JSON.stringify(provider.transportPolicy)) outcome = 'inconclusive'
    if (outcome === 'supported') {
      const capabilities = safeJson(currentModel.capabilities_json, unknownModelCapabilities())
      capabilities.toolUse = { state: 'supported', source: 'protocol_probe', verifiedAt: nowIso(), probeId, detailCode: `${provider.transportPolicy.protocol ?? 'openai-chat'}.tool_call.accepted` }
      this.db.prepare('UPDATE provider_models SET capabilities_json=?,updated_at=? WHERE id=?').run(JSON.stringify(capabilities), nowIso(), modelId)
    }
    this.db.prepare('UPDATE provider_probes SET ended_at=?,outcome=?,http_status=?,usage_json=? WHERE probe_id=?').run(nowIso(), outcome, httpStatus, JSON.stringify(usage), probeId)
    return { probeId, modelId, outcome, capabilities: this.modelFromRow(this.getModelRow(modelId)).capabilities, usage }
  }

  async probeModel(modelId: string, credentialRefId: string | null | undefined, acknowledgeMayBill: true): Promise<ProbeResult> {
    if (acknowledgeMayBill !== true) throw new ProviderRegistryError('probe_confirmation_required', '能力探测可能产生一次最小费用，必须显式确认')
    const model = this.modelFromRow(this.getModelRow(modelId))
    const provider = providerFromRow(this.getProviderRow(model.providerId))
    const probeId = `probe.${randomUUID()}`
    const startedAt = nowIso()
    const credentialId = credentialRefId ?? provider.defaultCredentialRefId
    this.db.prepare(`INSERT INTO provider_probes (probe_id,provider_id,model_id,credential_ref_id,started_at,outcome,usage_json,cost_status) VALUES (?,?,?,?,?,'in_flight','{}','unknown')`).run(probeId, provider.id, model.id, credentialId, startedAt)
    let outcome: ProbeResult['outcome'] = 'inconclusive'
    let httpStatus: number | null = null
    let usage = { inputTokens: null as number | null, outputTokens: null as number | null, reasoningTokens: null as number | null }
    let capabilities = model.capabilities
    try {
      const target = canonicalJoin(provider.baseUrl, provider.chatPath)
      const headers = await this.providerHeaders(provider, credentialId, target, true)
      const protocol = provider.transportPolicy.protocol ?? 'openai-chat'
      const probeBody = protocol === 'anthropic-messages'
        ? { model: model.remoteModelId, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: true, max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 } }
        : protocol === 'openai-responses'
          ? { model: model.remoteModelId, input: [{ role: 'user', content: 'Reply with OK.' }], stream: true, max_output_tokens: 8, reasoning: { effort: 'high' }, store: false }
          : { model: model.remoteModelId, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: true, stream_options: { include_usage: true }, max_tokens: 1, reasoning_effort: 'high' }
      const response = await secureProviderFetch(target, {
        method: 'POST', headers,
        body: JSON.stringify(probeBody)
      }, provider.transportPolicy, this.resolver, { timeoutMs: 30_000, maxBodyBytes: 256 * 1024 })
      httpStatus = response.status
      if (response.ok) {
        const raw = await response.text()
        const payloads = raw.split('\n').filter((line) => line.trim().startsWith('data:')).flatMap((line) => {
          const value = line.trim().slice(5).trim()
          if (!value || value === '[DONE]') return []
          try { return [JSON.parse(value) as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } } }] } catch { return [] }
        })
        const payload = payloads.find((entry) => entry.usage || (entry as any).message?.usage || (entry as any).response?.usage) ?? {}
        const rawUsage = (payload as any).usage ?? (payload as any).message?.usage ?? (payload as any).response?.usage
        usage = {
          inputTokens: typeof rawUsage?.prompt_tokens === 'number' ? rawUsage.prompt_tokens : typeof rawUsage?.input_tokens === 'number' ? rawUsage.input_tokens : null,
          outputTokens: typeof rawUsage?.completion_tokens === 'number' ? rawUsage.completion_tokens : typeof rawUsage?.output_tokens === 'number' ? rawUsage.output_tokens : null,
          reasoningTokens: typeof rawUsage?.completion_tokens_details?.reasoning_tokens === 'number' ? rawUsage.completion_tokens_details.reasoning_tokens : typeof rawUsage?.output_tokens_details?.reasoning_tokens === 'number' ? rawUsage.output_tokens_details.reasoning_tokens : null
        }
        const actualReasoning = payloads.some((entry: any) =>
          typeof entry?.choices?.[0]?.delta?.reasoning_content === 'string' && entry.choices[0].delta.reasoning_content.length > 0 ||
          typeof entry?.choices?.[0]?.delta?.reasoning === 'string' && entry.choices[0].delta.reasoning.length > 0 ||
          entry?.delta?.type === 'thinking_delta' && typeof entry.delta.thinking === 'string' && entry.delta.thinking.length > 0 ||
          /^(response\.reasoning_summary_text\.delta|response\.reasoning_text\.delta)$/.test(entry?.type ?? '') && typeof entry.delta === 'string' && entry.delta.length > 0
        )
        // HTTP 200 can ignore an unsupported control; text-only SSE isn't reasoning proof.
        outcome = actualReasoning || usage.reasoningTokens !== null && usage.reasoningTokens > 0 ? 'supported' : 'inconclusive'
      } else if (response.status === 400) {
        const detail = (await response.text()).slice(0, 2000)
        outcome = /reasoning[_ .-]?effort|unsupported.*reason/i.test(detail) ? 'unsupported' : 'inconclusive'
      }
    } catch {
      outcome = 'inconclusive'
    }
    if (outcome !== 'inconclusive') {
      capabilities = structuredClone(model.capabilities)
      capabilities.reasoning = {
        state: outcome, source: 'protocol_probe', verifiedAt: nowIso(), probeId,
        detailCode: outcome === 'supported' ? `${provider.transportPolicy.protocol ?? 'openai-chat'}.reasoning.accepted` : `${provider.transportPolicy.protocol ?? 'openai-chat'}.reasoning.rejected`,
        modes: outcome === 'supported' ? ['default', 'enabled'] : ['default'],
        efforts: outcome === 'supported' ? ['high'] : [], budget: null
      }
      capabilities.streaming = {
        state: outcome, source: 'protocol_probe', verifiedAt: nowIso(), probeId,
        detailCode: outcome === 'supported' ? `${provider.transportPolicy.protocol ?? 'openai-chat'}.sse.accepted` : `${provider.transportPolicy.protocol ?? 'openai-chat'}.sse.inconclusive`
      }
      this.db.prepare('UPDATE provider_models SET capabilities_json=?,updated_at=? WHERE id=?').run(JSON.stringify(capabilities), nowIso(), model.id)
    }
    this.db.prepare('UPDATE provider_probes SET ended_at=?,outcome=?,http_status=?,usage_json=? WHERE probe_id=?').run(nowIso(), outcome, httpStatus, JSON.stringify(usage), probeId)
    return { probeId, modelId, outcome, capabilities, usage }
  }

  upsertPricing(record: PricingRecord): PricingRecord {
    if (record.source === 'official_provider' && (!record.sourceUrl || !record.retrievedAt)) throw new ProviderRegistryError('pricing_unverified', '官方价格必须包含一手来源和核验时间')
    const hashPayload = { ...record, id: undefined, priceProfileHash: undefined }
    const expectedHash = createHash('sha256').update(JSON.stringify(hashPayload)).digest('hex')
    if (record.priceProfileHash !== expectedHash) throw new ProviderRegistryError('pricing_hash_invalid', '价格快照 hash 校验失败')
    const model = this.db.prepare('SELECT id FROM provider_models WHERE provider_id=? AND remote_model_id=?').get(record.providerId, record.remoteModelId) as { id: string } | undefined
    if (!model) throw new ProviderRegistryError('pricing_model_not_found', '价格只能绑定精确匹配的已保存模型')
    this.db.prepare(`INSERT INTO provider_pricing (id,provider_id,remote_model_id,canonical_origin,currency,unit,pricing_tier,context_bucket,input_per_million,cached_input_per_million,cache_write_per_million,output_per_million,reasoning_per_million,reasoning_billing_rule,source,source_url,effective_at,retrieved_at,profile_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET canonical_origin=excluded.canonical_origin,currency=excluded.currency,unit=excluded.unit,pricing_tier=excluded.pricing_tier,context_bucket=excluded.context_bucket,input_per_million=excluded.input_per_million,cached_input_per_million=excluded.cached_input_per_million,cache_write_per_million=excluded.cache_write_per_million,output_per_million=excluded.output_per_million,reasoning_per_million=excluded.reasoning_per_million,reasoning_billing_rule=excluded.reasoning_billing_rule,source=excluded.source,source_url=excluded.source_url,effective_at=excluded.effective_at,retrieved_at=excluded.retrieved_at,profile_hash=excluded.profile_hash`).run(
      record.id, record.providerId, record.remoteModelId, record.canonicalOrigin, record.currency, record.unit, record.pricingTier, record.contextBucket,
      record.inputMissPerMillion, record.cacheHitPerMillion, record.cacheWritePerMillion, record.outputPerMillion, record.reasoningPerMillion,
      record.reasoningBillingRule, record.source, record.sourceUrl, record.effectiveAt, record.retrievedAt, record.priceProfileHash
    )
    this.db.prepare('UPDATE provider_models SET pricing_id=?,updated_at=? WHERE id=?').run(record.id, nowIso(), model.id)
    return record
  }

  upsertUserPricing(input: UserPricingInput): PricingRecord {
    assertOnlyKeys(input, ['modelId', 'currency', 'unit', 'inputPrice', 'outputPrice', 'cacheHitInputPrice', 'cacheWriteInputPrice', 'reasoningPrice', 'reasoningBillingRule', 'validFrom', 'sourceUrl', 'acknowledgeReferenceOnly'], '$.pricing')
    const rateValid = (value: unknown, optional = false): boolean => optional && (value === undefined || value === null) || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000
    const effectiveAt = Date.parse(input.validFrom)
    if (input.acknowledgeReferenceOnly !== true || input.unit !== 'per_1m_tokens' || !/^[A-Z]{3}$/.test(input.currency) ||
        !rateValid(input.inputPrice) || !rateValid(input.outputPrice) || !rateValid(input.cacheHitInputPrice, true) ||
        !rateValid(input.cacheWriteInputPrice, true) || !rateValid(input.reasoningPrice, true) ||
        !['included_in_output', 'separate', 'unknown'].includes(input.reasoningBillingRule) || !Number.isFinite(effectiveAt) || effectiveAt > Date.now()) {
      throw new ProviderRegistryError('pricing_input_invalid', '请确认参考价、币种、计价单位及生效时间；未知费率请留空')
    }
    let sourceUrl: string | null = null
    if (input.sourceUrl) {
      let url: URL
      try { url = new URL(input.sourceUrl) } catch { throw new ProviderRegistryError('pricing_source_invalid', '参考来源必须是无凭据的 HTTP(S) 地址') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || input.sourceUrl.length > 2048) throw new ProviderRegistryError('pricing_source_invalid', '参考来源不能包含凭据、查询参数或片段')
      sourceUrl = url.href
    }
    const model = this.getModelRow(input.modelId)
    const provider = this.getProviderRow(model.provider_id)
    const base: Omit<PricingRecord, 'id' | 'priceProfileHash'> = {
      providerId: provider.id, remoteModelId: model.remote_model_id, canonicalOrigin: new URL(provider.base_url).origin,
      currency: input.currency, unit: 'per_1m_tokens', pricingTier: 'standard', contextBucket: 'default',
      inputMissPerMillion: input.inputPrice,
      cacheHitPerMillion: input.cacheHitInputPrice ?? null, cacheWritePerMillion: input.cacheWriteInputPrice ?? null,
      outputPerMillion: input.outputPrice, reasoningPerMillion: input.reasoningPrice ?? null, reasoningBillingRule: input.reasoningBillingRule,
      source: 'user_supplied', sourceUrl, effectiveAt: new Date(effectiveAt).toISOString(), retrievedAt: nowIso()
    }
    const priceProfileHash = createHash('sha256').update(JSON.stringify(base)).digest('hex')
    const existing = this.db.prepare("SELECT id,source FROM provider_pricing WHERE provider_id=? AND canonical_origin=? AND remote_model_id=? AND pricing_tier='standard' AND context_bucket='default' AND effective_at=?").get(provider.id, base.canonicalOrigin, model.remote_model_id, base.effectiveAt) as { id: string; source: PricingRecord['source'] } | undefined
    if (existing && existing.source !== 'user_supplied') throw new ProviderRegistryError('pricing_source_conflict', '用户参考价不能覆盖官方来源记录，请选择不同的生效日期')
    // The table has one record per effective identity/date. A correction keeps
    // that record ID; accepted runs embed the complete old record/hash by value.
    return this.upsertPricing({ ...base, id: existing?.id ?? `price.user.${randomUUID()}`, priceProfileHash })
  }

  listUserPricing(modelId: string): PricingRecord[] {
    const model = this.getModelRow(modelId)
    const provider = this.getProviderRow(model.provider_id)
    return (this.db.prepare("SELECT * FROM provider_pricing WHERE provider_id=? AND remote_model_id=? AND canonical_origin=? AND source='user_supplied' ORDER BY retrieved_at DESC,id DESC LIMIT 100").all(
      provider.id, model.remote_model_id, new URL(provider.base_url).origin
    ) as unknown as PricingRow[]).map(pricingFromRow)
  }

  estimateCost(input: { providerId: string; canonicalOrigin: string; remoteModelId: string; startedAt: number; cacheHitTokens: number | null; cacheMissTokens: number | null; outputTokens: number | null }): { status: 'estimated' | 'unknown'; amount: number | null; currency: string | null; priceSnapshotId: string | null } {
    if (input.cacheHitTokens === null || input.cacheMissTokens === null || input.outputTokens === null) return { status: 'unknown', amount: null, currency: null, priceSnapshotId: null }
    const date = new Date(input.startedAt)
    const hour = date.getUTCHours()
    const day = date.getUTCDay()
    // Beijing weekday 09–12 / 14–18. The local reference does not maintain a
    // statutory holiday calendar: holiday weekdays may use the peak upper
    // bound. This remains an estimate, never a provider bill or exact debit.
    const tier = day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)) ? 'peak' : 'off_peak'
    const row = this.db.prepare(`SELECT * FROM provider_pricing WHERE provider_id=? AND canonical_origin=? AND remote_model_id=? AND pricing_tier IN (?, 'standard') AND context_bucket='default' AND (effective_at IS NULL OR effective_at<=?) ORDER BY CASE WHEN pricing_tier=? THEN 0 ELSE 1 END,retrieved_at DESC LIMIT 1`).get(
      input.providerId, input.canonicalOrigin, input.remoteModelId, tier, date.toISOString(), tier
    ) as PricingRow | undefined
    if (!row || row.input_per_million === null || row.cached_input_per_million === null || row.output_per_million === null) return { status: 'unknown', amount: null, currency: null, priceSnapshotId: null }
    const amount = (input.cacheMissTokens * row.input_per_million + input.cacheHitTokens * row.cached_input_per_million + input.outputTokens * row.output_per_million) / 1_000_000
    return { status: 'estimated', amount, currency: row.currency, priceSnapshotId: row.id }
  }

  exportBundle(providerIds?: string[]): DeepWriterProviderBundleV1 {
    const snapshot = this.snapshot()
    const providers = snapshot.providers.filter((provider) => provider.kind === 'custom' && (!providerIds || providerIds.includes(provider.id)))
    const providerSet = new Set(providers.map((provider) => provider.id))
    return {
      kind: 'deepwriter.provider-bundle', version: 1, exportedAt: nowIso(),
      providers: providers.map((provider) => ({
        externalId: provider.id, displayName: provider.displayName, adapterId: 'custom.openai-compatible-chat', baseUrl: provider.baseUrl,
        chatPath: provider.chatPath, modelsPath: provider.modelsPath, authStyle: provider.authStyle, transportPolicy: exportSafePolicy(provider.transportPolicy)
      })),
      models: snapshot.models.filter((model) => providerSet.has(model.providerId)).map((model) => ({
        providerExternalId: model.providerId, remoteModelId: model.remoteModelId, displayName: model.displayName,
        declarations: { contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, capabilities: model.capabilities }
      })),
      profiles: snapshot.profiles.filter((profile) => providerSet.has(profile.providerId)).flatMap((profile) => {
        const model = snapshot.models.find((entry) => entry.id === profile.modelId)
        return model ? [{ name: profile.name, providerExternalId: profile.providerId, remoteModelId: model.remoteModelId, generation: profile.generation, reasoning: profile.reasoning, compatibilityMappingId: profile.compatibilityMappingId }] : []
      })
    }
  }

  async importPreview(raw: unknown): Promise<ImportPreview> {
    const bundle = parseProviderBundle(raw)
    const existing = new Set(this.snapshot().providers.map((provider) => provider.id))
    const preview: ImportPreview = {
      previewId: `import.${randomUUID()}`, bundle,
      collisions: bundle.providers.filter((provider) => existing.has(provider.externalId)).map((provider) => provider.externalId),
      expiresAt: Date.now() + 10 * 60_000
    }
    this.imports.set(preview.previewId, preview)
    return structuredClone(preview)
  }

  async importCommit(previewId: string): Promise<{ providerIds: string[]; modelIds: string[]; profileIds: string[] }> {
    const preview = this.imports.get(previewId)
    if (!preview || preview.expiresAt < Date.now()) throw new ProviderRegistryError('import_expired', '导入预览已过期')
    if (preview.collisions.length > 0) throw new ProviderRegistryError('import_collision', '存在 ID 冲突，请先移除冲突项')
    const providerIds: string[] = []
    const modelIds: string[] = []
    const profileIds: string[] = []
    const providerMap = new Map<string, string>()
    this.db.exec('BEGIN')
    try {
    for (const item of preview.bundle.providers) {
      const parsed = validateProviderEndpointSyntax(item.baseUrl, item.transportPolicy)
      const provider = this.insertCustomProvider({ displayName: item.displayName, baseUrl: item.baseUrl, chatPath: item.chatPath, modelsPath: item.modelsPath, authStyle: item.authStyle, transportPolicy: item.transportPolicy }, parsed.url.origin)
      providerMap.set(item.externalId, provider.id); providerIds.push(provider.id)
    }
    for (const item of preview.bundle.models) {
      const providerId = providerMap.get(item.providerExternalId)
      if (!providerId) throw new ProviderRegistryError('bundle_invalid', '导入文件的 Provider 引用无效')
      const capabilities = structuredClone(item.declarations.capabilities)
      const markImported = (entry: { state: string; source: unknown; verifiedAt: unknown; probeId: unknown }): void => {
        if (entry.state !== 'unknown') entry.source = 'imported_declaration'
        entry.verifiedAt = null; entry.probeId = null
      }
      markImported(capabilities.text); markImported(capabilities.streaming); markImported(capabilities.reasoning); markImported(capabilities.toolUse); markImported(capabilities.vision); markImported(capabilities.structuredOutput)
      const model = this.addManualModel({ providerId, remoteModelId: item.remoteModelId, displayName: item.displayName, contextWindow: item.declarations.contextWindow, maxOutputTokens: item.declarations.maxOutputTokens, capabilities })
      this.db.prepare("UPDATE provider_models SET source='imported' WHERE id=?").run(model.id)
      modelIds.push(model.id)
    }
    for (const item of preview.bundle.profiles) {
      const providerId = providerMap.get(item.providerExternalId)
      if (!providerId) throw new ProviderRegistryError('bundle_invalid', '导入文件的 Provider 引用无效')
      const model = this.db.prepare('SELECT id FROM provider_models WHERE provider_id=? AND remote_model_id=?').get(providerId, item.remoteModelId) as { id: string } | undefined
      if (!model) throw new ProviderRegistryError('bundle_invalid', '导入文件的模型引用无效')
      const id = `profile.imported.${randomUUID()}`
      this.upsertProfile({ id, name: item.name, providerId, modelId: model.id, credentialRefId: null, generation: item.generation, reasoning: item.reasoning, compatibilityMappingId: item.compatibilityMappingId }, true)
      profileIds.push(id)
    }
    this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.imports.delete(previewId)
    return { providerIds, modelIds, profileIds }
  }
}
