const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let source

function declaration(name) {
  const text = readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  const start = new RegExp(`^(?:async )?function ${name}(?=[\\s(<])`, 'm').exec(text)
  assert.ok(start, `missing real main declaration: ${name}`)
  const end = /^}\r?$/m.exec(text.slice(start.index))
  assert.ok(end)
  return text.slice(start.index, start.index + end.index + 1)
}

before(async () => {
  const main = readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  const handlerStart = main.indexOf("registerIpc('chat:start'")
  const handlerEnd = main.indexOf("registerIpcOn('chat:stop'", handlerStart)
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart)
  const built = await esbuild.build({
    absWorkingDir: root, stdin: { contents: `
      export { DesktopCostConsentGate, desktopMissingPriceEligible } from './src/main/desktopCostConsent';
      export { buildExecutionSnapshot, deriveProviderCallBudget } from './src/main/executionSnapshot';
      export { startChatRun } from './src/main/chatStart';
      export { createRepository } from './src/main/db/repository';
      export { useStore } from './src/renderer/src/store';
      import { DesktopCostConsentGate, DesktopCostConsentError } from './src/main/desktopCostConsent';
      import { buildExecutionSnapshot, applyFrozenProviderPricing } from './src/main/executionSnapshot';
      import { createChatOrchestration } from './src/main/chatOrchestration';
      import { contextPrefixHash } from './src/main/contextV2';
      import { ProviderRegistryError } from './src/main/providerConfiguration';
      import { AgentPlanError } from './src/main/agentPlan';
      import { freezeRunWebAccess } from './src/main/runWebAccess';
      import { normalizeUserPresetPrompt } from './src/shared/userPresetPrompt';
      import { agentRunBudgetFromStoredSettings, completionTokenBudgetFromStoredSettings } from './src/shared/agentRunBudget';
      import { storedOutputTokenLimit } from './src/shared/outputTokenPolicy';
      import * as schemas from './src/shared/ipcSchemas';
      export { schemas };
      import { createHash } from 'node:crypto';
      let route, repository, rawSettings, DEFAULT_SETTINGS, currentSettings, pricing = [];
      let counts;
      const fs = { readFile: async (file) => { if (!String(file).includes('isolated')) throw new Error('unexpected file'); return rawSettings; } };
      const settingsPath = () => '/isolated/settings.json';
      const app = { getPath: () => '/isolated' };
      const safeStorage = { isEncryptionAvailable: () => true };
      const decryptApiKey = (cipher) => { if (cipher !== 'synthetic-cipher') throw new Error('not a fixture'); counts.decrypt++; return 'synthetic-test-key'; };
      import { findSettingsSource, parseSettingsObject, SessionCredential } from './src/main/desktopSettingsFile';
      const sessionCredential = new SessionCredential();
      const saveSettings = async () => { counts.save++; };
      const migrateLegacyDefaultDocDir = (value) => ({ migrated: false, value });
      const DEFAULT_WP7_FEATURE_FLAGS = { sceneContractV2: false, deterministicDirector: false, dramaticCritic: false, localizedRevision: false, reorientation: false };
      ${declaration('loadSettingsMetadata')}
      ${declaration('parseSettingsFile')}
      export { loadSettingsMetadata };
      class IpcError extends Error { constructor(code, message) { super(message); this.code = code; } }
      ${declaration('publicModelSetupError')}
      ${declaration('agentPlanIpc')}
      export { publicModelSetupError, ProviderRegistryError };
      const BrowserWindow = { fromWebContents: () => ({}) };
      const registerIpc = (_channel, _options, handler) => { route = handler; };
      const grillMeGateRequired = () => false;
      const canonicalizeGrillMePayload = () => { throw new Error('not an Agent fixture'); };
      const kernelStorePort = {};
      const startedChats = new Set();
      let desktopCostConsentGate = new DesktopCostConsentGate();
      const desktopStartingIds = new Set();
      const loadMemory = async () => ({});
      const fileRefRegistry = { resolveForOperation: () => { throw new Error('no real files'); } };
      const sessionScope = () => ({});
      const testMockPricingSnapshots = () => pricing;
      const credentialRegistry = { register: () => { counts.register++; return { slotId: 'fixture-slot', version: 1, issuedAt: 1 }; } };
      const providerRegistry = null;
      const contextV2Service = { freezeForRun: () => ({ schemaVersion: 2, mode: 'optimized', policyRevision: 0 }) };
      const ensureDesktopExtensions = () => ({ freezeForNewRun: async () => {} });
      const contextCapability = () => ({ outputReserveTokens: 1024, maxContextTokens: 8192, fingerprint: 'fixture-capability' });
      ${declaration('buildRunPrefix')}
      const requireLongformWorkflowAuthority = () => { throw new Error('not a longwrite fixture'); };
      const bindAndStartLongformWorkflowRun = () => { throw new Error('not a longwrite fixture'); };
      const kernelWins = new Map(), kernelConfigs = new Map();
      const runKernel = { start: async () => { counts.start++; return { ok: true }; }, step: async () => { counts.step++; } };
      let floatingRunState;
      const floatingProjectName = () => 'isolated';
      const broadcastFloatingState = () => {};
      const surfaceFloatingRunOnStart = () => {};
      ${main.slice(handlerStart, handlerEnd)}
      export function mainFixture(repo, settings, records = []) {
        repository = repo; DEFAULT_SETTINGS = { ...settings, apiKey: '' };
        rawSettings = JSON.stringify({ ...settings, apiKeyEnc: 'synthetic-cipher' });
        currentSettings = { identity: 'unchanged' }; pricing = records;
        counts = { decrypt: 0, register: 0, start: 0, step: 0, save: 0, migrate: 0 };
        startedChats.clear(); desktopStartingIds.clear(); kernelConfigs.clear();
        desktopCostConsentGate = new DesktopCostConsentGate();
      }
      export const mainCounts = () => ({ ...counts, currentSettings });
      export const changeMainSettings = (settings) => { rawSettings = JSON.stringify({ ...settings, apiKeyEnc: 'synthetic-cipher' }); };
      export const mainStart = (payload, senderId = 7) => route({ sender: { id: senderId } }, schemas.chatStartSchema.parse(payload));
    `, loader: 'ts', resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', tsconfigRaw: {}, write: false, logLevel: 'silent',
    plugins: [{ name: 'isolated-source', setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (!args.path.startsWith('.')) return { path: args.path, external: true }
        const target = path.resolve(args.resolveDir, args.path)
        const resolved = ['', '.ts', '.tsx', '.js', '/index.ts'].map(ext => target + ext).find(existsSync)
        if (!resolved || !resolved.startsWith(root + path.sep)) throw new Error(`Unexpected import: ${args.path}`)
        // Keep the workspace boundary but let esbuild select TS/TSX/JSON by
        // the real file extension, including the checked-in model catalog.
        return { path: resolved }
      })
    }}]
  })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
  source = loaded.exports
})

function fixture(prices = []) {
  const payload = { id: 'new-isolated-run', sessionId: 'isolated-session', text: '本次请求', mode: 'agent', phase: 'execute', attachments: [] }
  const settings = { model: 'isolated-model', baseUrl: 'http://127.0.0.1:1', maxTokens: 1024, temperature: 0.7, topP: 1,
    thinkingEnabled: false, reasoningEffort: 'low', workDir: '', docDir: '', novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 4096,
    providerCapabilityOverride: { contextWindowTokens: 8192 }, completionTokenBudget: 6000 }
  const config = source.buildExecutionSnapshot({ payload, settings, sessionId: payload.sessionId,
    memory: { projectPath: '', projectContent: '', userContent: '' }, pricingSnapshots: prices, now: 1 })
  // This gate's legacy automatic policy is intentionally distinct from the
  // new ordinary-Agent explicit-only work budget exercised in its own tests.
  delete config.workBudgetPolicy
  config.providerCallBudget = source.deriveProviderCallBudget({ maxCalls: null, maxTokens: 6000, maxInputTokens: 8192, maxOutputTokens: 1024, pricingSnapshots: prices })
  return { senderId: 7, payload, config, settings, settingsIdentity: 'settings-file-digest', existingRun: false }
}

function price(changes = {}) {
  const record = { id: 'isolated-price', providerId: 'isolated-provider', remoteModelId: 'isolated-model', canonicalOrigin: 'http://127.0.0.1:1',
    currency: 'USD', unit: 'per_1m_tokens', pricingTier: 'standard', contextBucket: 'default', inputMissPerMillion: 1,
    cacheHitPerMillion: 0.1, cacheWritePerMillion: null, outputPerMillion: 2, reasoningPerMillion: null,
    reasoningBillingRule: 'included_in_output', source: 'user_supplied', sourceUrl: null, retrievedAt: '2026-10-01T00:00:00Z',
    effectiveFrom: '2026-10-01T00:00:00Z', effectiveTo: null, ...changes }
  record.priceProfileHash = createHash('sha256').update(JSON.stringify({ ...record, id: undefined, priceProfileHash: undefined })).digest('hex')
  return record
}

function incomplete(record) {
  const input = fixture()
  // Snapshots intentionally discard unverified legacy prices; registry stages
  // retain unknown rates. Materialize those exact stage records for the gate.
  const stage = { provider: { id: 'isolated-provider', baseUrl: input.config.baseUrl }, model: { remoteModelId: 'isolated-model', contextWindow: 8192, pricing: record }, generation: { maxOutputTokens: 1024 } }
  input.config.providerProfileSnapshots = { version: 1, frozenAt: 'now', default: stage, planning: stage, draft: stage, review: stage, polish: stage }
  input.config.providerCallBudget = source.deriveProviderCallBudget({ maxCalls: 16, maxTokens: 6000, maxInputTokens: 8192, maxOutputTokens: 1024, pricingSnapshots: [record] })
  return input
}

function confirm(gate, input, challenge) {
  return gate.prepare({ ...input, payload: { ...input.payload, unknownCostConsent: { nonce: challenge.nonce, decision: 'accept_unknown_cost' } } })
}

test('real public setup mapper publishes only known registry failures without copying private error details', () => {
  const known = source.publicModelSetupError(new source.ProviderRegistryError('credential_missing', 'synthetic-private-detail'))
  assert.equal(known.code, 'credential_missing')
  assert.match(known.message, /当前供应商/)
  assert.equal(known.message.includes('synthetic-private-detail'), false)
  assert.equal(source.publicModelSetupError(new Error('synthetic-private-detail')), undefined)
  assert.equal(source.publicModelSetupError({ code: 'credential_missing', message: 'synthetic-private-detail' }), undefined)
})

test('new missing-price prompt is bounded; explicit one-use consent freezes null cost without changing other caps', () => {
  const gate = new source.DesktopCostConsentGate(() => 100)
  const input = fixture()
  const original = structuredClone(input.config)
  const prompt = gate.prepare(input)
  assert.equal(prompt.status, 'cost_confirmation_required')
  assert.match(prompt.challenge.nonce, /^[a-f0-9]{64}$/)
  assert.equal(prompt.challenge.expiresAt, 120100)
  assert.equal(prompt.challenge.runId, input.payload.id)
  assert.deepEqual(input.config, original)
  const accepted = confirm(gate, input, prompt.challenge)
  assert.equal(accepted.status, 'allowed')
  assert.equal(accepted.config.providerCallBudget.maxCost, null)
  assert.equal(accepted.config.providerCallBudget.maxCostCny, null)
  assert.equal(accepted.config.providerCallBudget.maxCalls, original.providerCallBudget.maxCalls)
  assert.equal(accepted.config.providerCallBudget.maxTokens, 6000)
  assert.equal(accepted.config.desktopCostAuthorization.amountCapGuaranteed, false)
  assert.throws(() => confirm(gate, input, prompt.challenge), /费用确认已失效/)
  assert.equal(gate.prepare({ ...input, payload: { ...input.payload, id: 'next-new-run' } }).status, 'cost_confirmation_required')
})

test('sender, request/run/session/draft/assets/context/model/settings/price identities cannot drift', () => {
  const mutations = [
    input => { input.senderId++ }, input => { input.payload.id += '-other' }, input => { input.payload.sessionId += '-other' },
    input => { input.payload.text += '-changed' }, input => { input.payload.attachments.push({ fileRefId: 'changed', name: 'other', size: 1 }) },
    input => { input.config.frozenContext = { schemaVersion: 2, policyRevision: 9 } }, input => { input.config.model += '-other' },
    input => { input.settingsIdentity += '-changed' }, input => { input.config.memory.hash += '-changed' },
    input => { input.config.providerProfileSnapshots = { fingerprint: 'different' } }
  ]
  for (const mutate of mutations) {
    const gate = new source.DesktopCostConsentGate(() => 100)
    const input = fixture()
    const prompt = gate.prepare(input)
    const changed = structuredClone(input)
    mutate(changed)
    assert.throws(() => confirm(gate, changed, prompt.challenge))
    assert.deepEqual(input.config.providerCallBudget.maxCost, { amount: 0, currency: null, unknownPolicy: 'deny' })
  }
  const gate = new source.DesktopCostConsentGate(() => 100)
  const input = incomplete(price({ cacheHitPerMillion: null }))
  const prompt = gate.prepare(input)
  input.config.providerProfileSnapshots.default.model.pricing = price({ cacheHitPerMillion: null, effectiveFrom: '2026-10-02T00:00:00Z' })
  assert.throws(() => confirm(gate, input, prompt.challenge), /费用确认已失效/)
})

test('TTL, replacement, process restart, existing runs and renderer booleans never authorize', () => {
  let time = 100
  const gate = new source.DesktopCostConsentGate(() => time, 5)
  const input = fixture()
  const expired = gate.prepare(input).challenge
  time = 105
  assert.throws(() => confirm(gate, input, expired), /费用确认已失效/)
  const replaced = gate.prepare(input).challenge
  const current = gate.prepare(input).challenge
  assert.throws(() => confirm(gate, input, replaced), /费用确认已失效/)
  assert.throws(() => confirm(new source.DesktopCostConsentGate(() => time), input, current), /费用确认已失效/)
  assert.throws(() => confirm(gate, { ...input, existingRun: true }, current), /费用确认已失效/)
  assert.throws(() => gate.prepare({ ...input, payload: { ...input.payload, unknownCostConsent: { approved: true } } }), /费用确认已失效/)
})

test('complete prices keep money caps; explicit hard caps, malformed/hash-tampered/mixed prices stay denied', () => {
  assert.equal(source.desktopMissingPriceEligible(fixture([price()]).config), false)
  assert.equal(source.desktopMissingPriceEligible(incomplete(price({ cacheHitPerMillion: null })).config), true)
  assert.equal(source.desktopMissingPriceEligible(incomplete(price({ reasoningBillingRule: 'unknown' })).config), true)
  for (const bad of [price({ cacheHitPerMillion: -1 }), price({ currency: 'USD', priceProfileHash: 'wrong' }), price({ remoteModelId: 'wrong', cacheHitPerMillion: null })]) {
    if (bad.priceProfileHash !== 'wrong' && bad.cacheHitPerMillion === 0.1) bad.priceProfileHash = 'tampered'
    assert.equal(source.desktopMissingPriceEligible(incomplete(bad).config), false)
  }
  const mixed = incomplete(price({ cacheHitPerMillion: null }))
  mixed.config.providerProfileSnapshots.review = { ...mixed.config.providerProfileSnapshots.review, model: { ...mixed.config.providerProfileSnapshots.review.model, pricing: price({ currency: 'CNY', cacheHitPerMillion: null }) } }
  assert.equal(source.desktopMissingPriceEligible(mixed.config), false)
  const unknownContext = incomplete(null)
  unknownContext.config.providerProfileSnapshots.default.model.contextWindow = null
  assert.equal(source.desktopMissingPriceEligible(unknownContext.config), false)
  for (const maxCost of [{ amount: 1, currency: 'USD', unknownPolicy: 'deny' }, { amount: 0, currency: 'USD', unknownPolicy: 'deny' }, null]) {
    const input = fixture()
    input.config.providerCallBudget.maxCost = maxCost
    assert.equal(source.desktopMissingPriceEligible(input.config), false)
  }
})

test('unknown model with a frozen finite operating budget gets consent instead of a silently paused run', () => {
  const input = incomplete(null)
  for (const name of ['default', 'planning', 'draft', 'review', 'polish']) {
    const stage = input.config.providerProfileSnapshots[name]
    stage.model.contextWindow = null
    stage.contextBudget = { contextWindowTokens: 8192, outputReserveTokens: stage.generation.maxOutputTokens, source: 'conservative_default' }
  }
  assert.equal(source.desktopMissingPriceEligible(input.config), true)
  const gate = new source.DesktopCostConsentGate(() => 100)
  const prompt = gate.prepare(input)
  assert.equal(prompt.status, 'cost_confirmation_required')
  const accepted = confirm(gate, input, prompt.challenge)
  assert.equal(accepted.config.providerCallBudget.maxCost, null)
  assert.equal(accepted.config.providerCallBudget.maxTokens, input.config.providerCallBudget.maxTokens)
  input.config.providerProfileSnapshots.default.contextBudget.contextWindowTokens = 128000
  assert.equal(source.desktopMissingPriceEligible(input.config), false)
  input.config.providerProfileSnapshots.default.contextBudget.contextWindowTokens = 8192
  input.config.providerProfileSnapshots.default.contextBudget.outputReserveTokens = 4096
  assert.equal(source.desktopMissingPriceEligible(input.config), false)
})

test('real atomic acceptance has zero key/engine/upstream spy/accepted run before challenge; consent persists exact run budget', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-desktop-cost-'))
  const repo = source.createRepository(path.join(dir, 'isolated.db'))
  repo.open()
  const input = fixture()
  const gate = new source.DesktopCostConsentGate(() => 100)
  let keys = 0, starts = 0, http = 0, prompt
  const deps = { repository: repo, loadSettings: async () => ({ model: input.config.model }),
    buildConfig: async payload => {
      const prepared = gate.prepare({ ...input, payload, existingRun: Boolean(repo.getRun(payload.id)) })
      if (prepared.status === 'cost_confirmation_required') { prompt = prepared.challenge; throw new Error('challenge-required') }
      keys++ // the main handler resolves secrets only below the same gate
      return prepared.config
    }, runKernel: { start: async () => { starts++; return { ok: true } }, step: async () => { http++ } } }
  try {
    await assert.rejects(source.startChatRun(deps, input.payload), /challenge-required/)
    assert.equal(repo.getRun(input.payload.id), null)
    assert.equal(keys + starts + http, 0)
    const payload = { ...input.payload, unknownCostConsent: { nonce: prompt.nonce, decision: 'accept_unknown_cost' } }
    const ack = await source.startChatRun(deps, payload)
    assert.equal(ack.runId, input.payload.id)
    assert.equal(keys, 1)
    assert.equal(starts, 1)
    assert.equal(http, 1)
    const frozen = JSON.parse(repo.getRun(ack.runId).config_json)
    assert.equal(frozen.providerCallBudget.maxCost, null)
    assert.equal(frozen.providerCallBudget.maxTokens, 6000)
    assert.equal(frozen.desktopCostAuthorization.clientRequestId, ack.runId)
    assert.equal(frozen.desktopCostAuthorization.amountCapGuaranteed, false)
    assert.equal(JSON.stringify(frozen).includes(prompt.nonce), false)
    await assert.rejects(source.startChatRun(deps, payload), /费用确认已失效/)
    assert.equal(keys + starts + http, 3)
    assert.deepEqual(JSON.parse(repo.getRun(ack.runId).config_json), frozen)
  } finally { repo.close(); await fs.rm(dir, { recursive: true, force: true }) }
})

async function mainFixture(body, records = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-real-cost-handler-'))
  const repo = source.createRepository(path.join(dir, 'isolated.db'))
  repo.open()
  const input = fixture()
  source.mainFixture(repo, input.settings, records)
  try { await body(repo, input) } finally { repo.close(); await fs.rm(dir, { recursive: true, force: true }) }
}

test('actual metadata parser never decrypts/migrates/saves/updates settings; explicit resolve uses captured bytes', async () => {
  await mainFixture(async (_repo, input) => {
    const meta = await source.loadSettingsMetadata()
    assert.equal(meta.settings.apiKey, '')
    assert.match(meta.identity, /^[a-f0-9]{64}$/)
    assert.deepEqual(source.mainCounts(), { decrypt: 0, register: 0, start: 0, step: 0, save: 0, migrate: 0, currentSettings: { identity: 'unchanged' } })
    source.changeMainSettings({ ...input.settings, model: 'later-mutable-model' })
    const captured = await meta.resolveSecrets()
    assert.equal(captured.model, input.settings.model)
    assert.equal(captured.apiKey, 'synthetic-test-key')
    assert.equal(source.mainCounts().decrypt, 1)
    assert.equal(source.mainCounts().save + source.mainCounts().migrate, 0)
    assert.deepEqual(source.mainCounts().currentSettings, { identity: 'unchanged' })
  })
})

test('actual metadata parser cannot resurrect merged defaults or the known old factory budget', async () => {
  await mainFixture(async (_repo, input) => {
    for (const value of [undefined, 200000]) {
      const saved = { ...input.settings }
      if (value === undefined) delete saved.completionTokenBudget
      else saved.completionTokenBudget = value
      source.changeMainSettings(saved)
      const parsed = (await source.loadSettingsMetadata()).settings
      assert.equal(parsed.completionTokenBudget, 0)
      assert.deepEqual(parsed.agentRunBudget, { maxCalls:null,maxTurns:null,maxTokens:null,maxWallClockMs:null,maxCost:null })
    }
    source.changeMainSettings({ ...input.settings, completionTokenBudget:250000 })
    const parsed = (await source.loadSettingsMetadata()).settings
    assert.equal(parsed.completionTokenBudget,250000);assert.equal(parsed.agentRunBudget.maxTokens,250000)
  })
})

test('desktop ordinary Agent preserves migrated token limit without inventing a money cap or authorization', async () => {
  await mainFixture(async (repo, input) => {
    const ack = await source.mainStart(input.payload)
    const frozen = JSON.parse(repo.getRun(ack.runId).config_json)
    assert.equal(frozen.providerCallBudget.maxCost, null)
    assert.equal(frozen.providerCallBudget.maxTokens, 6000)
    assert.equal(frozen.workBudgetPolicy, 'explicit_v1')
    assert.equal(frozen.desktopCostAuthorization, undefined)
    assert.equal(source.mainCounts().decrypt, 1)
    assert.equal(source.mainCounts().register, 1)
    assert.equal(source.mainCounts().start, 1)
    assert.equal(source.mainCounts().step, 1)
    await assert.rejects(source.mainStart({ ...input.payload, unknownCostConsent: { nonce: 'a'.repeat(64), decision: 'accept_unknown_cost' } }), error => error.code === 'cost_confirmation_invalid')
    assert.deepEqual(JSON.parse(repo.getRun(ack.runId).config_json), frozen)
    const next = await source.mainStart({ ...input.payload, id: 'next-run-no-extra-confirmation', sessionId: 'next-session' })
    assert.equal(next.runId, 'next-run-no-extra-confirmation')
    assert.equal(source.mainCounts().decrypt, 2)
  })
})

test('main strict IPC rejects arbitrary caps and duplicate submit without mutating accepted snapshots', async () => {
  await mainFixture(async (repo, input) => {
    for (const invalid of [{ unknownCostConsent: { approved: true } }, { providerCallBudget: { maxCost: null } }, { unknownCostConsent: { nonce: 'a'.repeat(64), decision: 'accept_unknown_cost', maxCost: null } }]) {
      assert.throws(() => source.mainStart({ ...input.payload, ...invalid }))
    }
    const parallel = await Promise.allSettled([source.mainStart(input.payload), source.mainStart(input.payload)])
    assert.equal(parallel.filter(value => value.status === 'fulfilled').length, 1)
    assert.equal(parallel.filter(value => value.status === 'rejected' && value.reason.code === 'request_submitting').length, 1)
    const ack = parallel.find(value => value.status === 'fulfilled').value
    assert.equal(ack.runId, input.payload.id)
    const frozen = repo.getRun(ack.runId).config_json
    const accepted = { ...input.payload, unknownCostConsent: { nonce: 'a'.repeat(64), decision: 'accept_unknown_cost' } }
    await assert.rejects(source.mainStart(accepted, 8), error => error.code === 'cost_confirmation_invalid')
    source.changeMainSettings({ ...input.settings, temperature: 0.2 })
    await assert.rejects(source.mainStart(accepted), error => error.code === 'cost_confirmation_invalid')
    assert.equal(repo.getRun(input.payload.id).config_json, frozen)
    assert.equal(source.mainCounts().decrypt + source.mainCounts().register + source.mainCounts().start + source.mainCounts().step, 4)
  })
})

test('bounded desktop policy only relaxes an automatic missing-price denial, never an explicit amount or malformed quote', () => {
  const gate = new source.DesktopCostConsentGate()
  const input = incomplete(null)
  input.missingPricePolicy = 'bounded_requests'
  const profiles = input.config.providerProfileSnapshots
  input.config.providerProfileSnapshots = { ...profiles, default: null, planning: null, review: null, polish: null }
  const result = gate.prepare(input)
  assert.equal(result.status, 'allowed')
  assert.equal(result.config.providerCallBudget.maxCost, null)
  assert.equal(result.config.providerCallBudget.maxTokens, 6000)
  assert.equal(result.config.providerCallBudget.maxCalls, 16)
  assert.equal(result.config.completionContract?.providerCallBudget.maxCost ?? null, null)
  assert.equal(input.config.providerCallBudget.maxCost.amount, 0)
  for (const maxCost of [{ amount: 1, currency: 'USD', unknownPolicy: 'deny' }, { amount: 0, currency: 'USD', unknownPolicy: 'deny' }]) {
    const capped = structuredClone(input)
    capped.config.providerCallBudget.maxCost = maxCost
    assert.deepEqual(gate.prepare(capped).config.providerCallBudget.maxCost, maxCost)
  }
  const malformed = incomplete(price({ cacheHitPerMillion: -1 }))
  malformed.missingPricePolicy = 'bounded_requests'
  assert.equal(gate.prepare(malformed).config.providerCallBudget.maxCost.amount, 0)
  const mixed = incomplete(price({ cacheHitPerMillion: null }))
  mixed.config.providerProfileSnapshots.review = { ...mixed.config.providerProfileSnapshots.review, model: { ...mixed.config.providerProfileSnapshots.review.model, pricing: price({ currency: 'CNY', cacheHitPerMillion: null }) } }
  assert.equal(source.desktopMissingPriceEligible(mixed.config), false)
  assert.equal(gate.prepare({ ...mixed, missingPricePolicy: 'bounded_requests' }).config.providerCallBudget.maxCost, null)
})

test('priced new Agent does not invent an amount cap; old deny run cannot acquire a waiver', async () => {
  await mainFixture(async (repo, input) => {
    const ack = await source.mainStart(input.payload)
    assert.equal(ack.runId, input.payload.id)
    const frozen = JSON.parse(repo.getRun(ack.runId).config_json)
    assert.equal(frozen.providerCallBudget.maxCost, null)
    assert.equal(frozen.desktopCostAuthorization, undefined)
  }, [price()])
  await mainFixture(async (repo, input) => {
    repo.createRun({ run_id: input.payload.id, session_id: input.payload.sessionId, status: 'waiting_user', phase: 'paused', started_at: 1,
      updated_at: 1, config_json: JSON.stringify(input.config), parent_run_id: null, error_code: 'run_cost_unknown_price', error_message: 'unknown' })
    const before = repo.getRun(input.payload.id).config_json
    await assert.rejects(source.mainStart({ ...input.payload, unknownCostConsent: { nonce: 'a'.repeat(64), decision: 'accept_unknown_cost' } }), error => error.code === 'cost_confirmation_invalid')
    assert.equal(repo.getRun(input.payload.id).config_json, before)
    assert.equal(source.mainCounts().decrypt + source.mainCounts().register + source.mainCounts().start, 0)
  })
})

function rendererFixture() {
  const calls = []
  const store = source.useStore
  global.window = { setTimeout, clearTimeout, ds: { chatStart: async request => {
    calls.push(structuredClone(request))
    if (!request.unknownCostConsent) return { status: 'cost_confirmation_required', challenge: { nonce: 'a'.repeat(64), runId: request.id, expiresAt: Date.now() + 5000, maxCalls: 16, maxTokens: 6000 } }
    return { runId: request.id, status: 'queued', acceptedAt: Date.now() }
  } } }
  store.setState({ ...store.getInitialState(), settings: fixture().settings, currentSessionId: 'isolated-session', composerText: '原草稿',
    pendingAttachments: [{ fileRefId: 'isolated-ref', name: '资料.txt', size: 1, state: 'ready' }], messages: [],
    activeRunId: 'previous-run', flushComposerDrafts: async () => {}, loadContext: async () => {},
    previewContext: async () => ({ mode: 'optimized', policyRevision: 0, previewId: 'isolated-preview', budget: { status: 'ready' } }) })
  return { store, calls }
}

async function awaitPrompt(store) {
  for (let i = 0; i < 20; i++) {
    if (store.getState().unknownCostPrompt) return
    await new Promise(setImmediate)
  }
  assert.fail('actual store did not publish the confirmation prompt')
}

test('real store cancellation/settings preserve drafts and attachments; duplicate send stays busy', async () => {
  for (const choice of ['cancel', 'settings']) {
    const { store, calls } = rendererFixture()
    const originalAttachments = structuredClone(store.getState().pendingAttachments)
    const sending = store.getState().send('原草稿', originalAttachments)
    await awaitPrompt(store)
    assert.equal(store.getState().submitting, true)
    assert.equal(store.getState().running, false)
    assert.equal(store.getState().messages.length, 0)
    assert.equal(store.getState().activeRunId, 'previous-run')
    assert.equal((await store.getState().send('重复提交')).reason, 'busy')
    store.getState().decideUnknownCost(choice)
    assert.equal((await sending).ok, false)
    assert.equal(calls.length, 1)
    assert.equal(store.getState().composerText, '原草稿')
    assert.deepEqual(store.getState().pendingAttachments, originalAttachments)
    assert.equal(store.getState().submitting, false)
  }
})

test('real store retries identical full request only after consent; each next send needs its own prompt', async () => {
  const { store, calls } = rendererFixture()
  const sending = store.getState().send('原草稿', store.getState().pendingAttachments)
  await awaitPrompt(store)
  store.getState().decideUnknownCost('accept')
  assert.equal((await sending).ok, true)
  assert.equal(calls.length, 2)
  const { unknownCostConsent, ...retried } = calls[1]
  assert.deepEqual(retried, calls[0])
  assert.deepEqual(unknownCostConsent, { nonce: 'a'.repeat(64), decision: 'accept_unknown_cost' })
  assert.deepEqual(calls[0].attachments, [{ fileRefId: 'isolated-ref', name: '资料.txt', size: 1 }])
  assert.equal(store.getState().composerText, '原草稿') // Composer clears only after the successful ACK.
  assert.equal(store.getState().pendingAttachments.length, 0)
  store.setState({ running: false, runningId: null })
  const next = store.getState().send('下一次请求')
  await awaitPrompt(store)
  assert.equal(calls[2].unknownCostConsent, undefined)
  store.getState().decideUnknownCost('cancel')
  assert.equal((await next).ok, false)
})

test('real store draft/attachment/model/session/closing races never submit a stale confirmation or erase another session', async () => {
  for (const mutation of [
    store => store.getState().setComposerText('变更草稿'),
    store => store.getState().setPendingAttachments(items => [...items, { fileRefId: 'new-async-ref', name: '异步附件', size: 2 }]),
    store => store.setState({ settings: { ...store.getState().settings, model: 'changed-model' } }),
    store => store.setState({ currentSessionId: 'other-session', composerText: '别的会话草稿', messages: [{ id: 'other-message', content: '别的会话' }], pendingAttachments: [] }),
    store => store.setState({ closing: true })
  ]) {
    const { store, calls } = rendererFixture()
    const sending = store.getState().send('原草稿', store.getState().pendingAttachments)
    await awaitPrompt(store)
    mutation(store)
    const before = { text: store.getState().composerText, attachments: structuredClone(store.getState().pendingAttachments), messages: structuredClone(store.getState().messages) }
    store.getState().decideUnknownCost('accept')
    assert.equal((await sending).reason, 'cost_confirmation_stale')
    assert.equal(calls.length, 1)
    assert.equal(store.getState().composerText, before.text)
    assert.deepEqual(store.getState().pendingAttachments, before.attachments)
    assert.deepEqual(store.getState().messages, before.messages)
    assert.equal(store.getState().submitting, false)
  }
})
