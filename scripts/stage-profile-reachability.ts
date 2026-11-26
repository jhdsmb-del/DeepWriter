import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { executableProfileStages } from '../src/shared/providerRegistry'
import { ProviderRegistryService, ProviderRegistryError } from '../src/main/providerRegistry'

const temp = await mkdtemp(path.join(tmpdir(), 'deepwriter-stage-reachability-'))
const dbPath = path.join(temp, 'registry.db')
const service = new ProviderRegistryService(dbPath, {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`test:${value}`),
  decryptString: value => value.toString().slice(5)
})
const legacy = { maxTokens: 2048, temperature: 1, topP: 1, thinking: { enabled: false, effort: 'high' as const } }
try {
  await service.bootstrapDeepSeek({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'synthetic-stage-key-v1', thinkingEnabled: false, reasoningEffort: 'high', temperature: 1, topP: 1, maxTokens: 2048 })
  const builtin = service.snapshot().bindings!.defaultProfileId
  const provider = await service.createCustomProvider({ displayName: 'Unused synthetic provider', baseUrl: 'https://example.com', chatPath: '/v1/chat/completions', modelsPath: null, authStyle: 'bearer', transportPolicy: { scope: 'public_https', allowNonDefaultPort: false } })
  const model = service.addManualModel({ providerId: provider.id, remoteModelId: 'unused-model', displayName: 'Unused model' })
  const unused = service.ensureModelProfile(model.id)
  const bindings = { defaultProfileId: unused.id, draftProfileId: builtin, planningProfileId: unused.id, reviewProfileId: unused.id, polishProfileId: unused.id }
  const ordinary = executableProfileStages({ planMode: false })
  assert.deepEqual(ordinary, ['draft'])
  const frozen = service.freezeStageProfiles(bindings, legacy, ordinary)
  assert.equal(frozen.draft!.profileId, builtin)
  for (const stage of ['default', 'planning', 'review', 'polish'] as const) assert.equal(frozen[stage], null)
  console.log('PASS ordinary chat freezes only the reachable draft, ignoring unused missing keys')

  const writing = executableProfileStages({ writingPipeline: {}, strongConstraints: { enabled: true } })
  assert.deepEqual(writing, ['draft', 'review', 'polish'])
  assert.throws(() => service.freezeStageProfiles(bindings, legacy, writing), (e: unknown) => e instanceof ProviderRegistryError && e.code === 'credential_missing')
  assert.deepEqual(executableProfileStages({ planMode: true }), ['planning'])
  assert.throws(() => service.freezeStageProfiles(bindings, legacy, ['planning']), (e: unknown) => e instanceof ProviderRegistryError && e.code === 'credential_missing')
  assert.throws(() => service.freezeStageProfiles(bindings, legacy), (e: unknown) => e instanceof ProviderRegistryError && e.code === 'credential_missing')
  console.log('PASS reachable review/planning and legacy all-stage freeze retain missing-credential rejection')

  const db = new DatabaseSync(dbPath)
  db.prepare('UPDATE provider_models SET enabled=0 WHERE id=?').run(model.id)
  service.freezeStageProfiles(bindings, legacy, ordinary)
  assert.throws(() => service.freezeStageProfiles(bindings, legacy, ['review']), (e: unknown) => e instanceof ProviderRegistryError && e.code === 'profile_target_disabled')
  db.close()
  console.log('PASS unused disabled target does not block chat; reachable disabled target still rejects')

  const reference = frozen.draft!.credential!
  service.replaceCredential(reference.credentialRefId, 'synthetic-stage-key-v2')
  assert.equal(service.resolveFrozenCredential(reference), 'synthetic-stage-key-v1')
  const next = service.freezeStageProfiles(bindings, legacy, ordinary)
  assert.equal(next.draft!.credential!.version, reference.version + 1)
  assert.equal(service.resolveFrozenCredential(next.draft!.credential!), 'synthetic-stage-key-v2')
  console.log('PASS reachable credentials retain immutable versions across replacement')
} finally {
  service.close()
  await rm(temp, { recursive: true, force: true })
}
