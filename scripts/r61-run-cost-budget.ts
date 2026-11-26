import { desktopSourceExternals } from './desktop-source-boundary.mjs'
/** R61 focused regression for the durable provider cost policy.
 *
 * Run with:
 *   npx esbuild scripts/r61-run-cost-budget.ts --bundle --format=esm --platform=node --outfile=out/r61-run-cost-budget.mjs && node out/r61-run-cost-budget.mjs
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(options: Record<string, unknown>): Promise<unknown> }

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function loadTsModule(relativePath: string, prefix: string): Promise<Record<string, unknown>> {
  const outDir = path.join(ROOT, 'out')
  await fs.mkdir(outDir, { recursive: true })
  const outfile = path.join(outDir, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await esbuild.build({
    entryPoints: [path.join(ROOT, relativePath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: true,
    outfile,
    external: desktopSourceExternals(path.join(ROOT, relativePath), ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite']),
    logLevel: 'silent',
    plugins: [{
      name: 'electron-shim',
      setup(build: { onResolve(options: unknown, callback: (result: { path: string; namespace: string }) => unknown): void; onLoad(options: unknown, callback: () => unknown): void }): void {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
        build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
          contents: 'export const app={getPath:(name)=>String(name),isPackaged:false}; export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]}),showSaveDialog:async()=>({canceled:true}),showMessageBox:async()=>({response:1})}; export const ipcMain={handle:()=>undefined,on:()=>undefined}; export const safeStorage={isEncryptionAvailable:()=>false,encryptString:()=>null,decryptString:()=>""}; export const shell={openExternal:()=>undefined,openPath:async()=>""}; export const clipboard={writeText:()=>undefined}; export const Menu={buildFromTemplate:(template)=>({popup:()=>undefined,template})};',
          loader: 'js'
        }))
      }
    }]
  })
  try {
    return await import(url.pathToFileURL(outfile).href) as Record<string, unknown>
  } finally {
    await fs.unlink(outfile).catch(() => undefined)
  }
}

function price(currency: string, source: 'official_provider' | 'user_supplied' = 'user_supplied'): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: `price.fixture.${currency.toLowerCase()}`,
    providerId: 'provider.fixture',
    remoteModelId: 'fixture-model',
    canonicalOrigin: 'https://fixture.example',
    currency,
    unit: 'per_1m_tokens',
    pricingTier: 'standard',
    contextBucket: 'default',
    inputMissPerMillion: 2,
    cacheHitPerMillion: 1,
    cacheWritePerMillion: null,
    outputPerMillion: 3,
    reasoningPerMillion: null,
    reasoningBillingRule: 'included_in_output',
    source,
    sourceUrl: source === 'official_provider' ? 'https://fixture.example/pricing' : null,
    effectiveAt: null,
    retrievedAt: source === 'official_provider' ? '2026-09-01T00:00:00.000Z' : '',
    priceProfileHash: ''
  }
  const hashPayload = { ...base, id: undefined, priceProfileHash: undefined }
  return { ...base, priceProfileHash: createHash('sha256').update(JSON.stringify(hashPayload)).digest('hex') }
}

function stage(pricing: Record<string, unknown> | null, contextWindow = 1_000, maxOutputTokens = 256): Record<string, unknown> {
  return {
    model: { id: 'model.fixture', remoteModelId: 'fixture-model', contextWindow, maxOutputTokens, capabilityProof: {}, pricing },
    generation: { maxOutputTokens }
  }
}

function frozenStages(pricing: Record<string, unknown> | null, contextWindow = 1_000, maxOutputTokens = 256): Record<string, unknown> {
  const one = stage(pricing, contextWindow, maxOutputTokens)
  return { version: 1, frozenAt: '2026-09-01T00:00:00.000Z', default: one, planning: one, draft: one, review: one, polish: one }
}

function baseSettings(): Record<string, unknown> {
  return {
    model: 'fixture-model',
    baseUrl: 'https://fixture.example',
    maxTokens: 256,
    temperature: 1,
    topP: 1,
    thinkingEnabled: false,
    reasoningEffort: 'high',
    workDir: 'C:/fixture/work',
    docDir: 'C:/fixture/docs',
    novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' },
    historyBudgetTokens: 8_000,
    providerCapabilityOverride: { contextWindowTokens: 8_000, maxOutputTokens: 256 }
  }
}

async function main(): Promise<void> {
  const snapshotMod = await loadTsModule('src/main/executionSnapshot.ts', 'r61-snapshot')
  const buildExecutionSnapshot = snapshotMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, any>
  const deriveProviderCallBudget = snapshotMod.deriveProviderCallBudget as (input: Record<string, unknown>) => Record<string, any>
  const applyFrozenProviderPricing = snapshotMod.applyFrozenProviderPricing as (snapshot: Record<string, any>, profiles: Record<string, unknown>) => Record<string, any>

  const production = buildExecutionSnapshot({
    payload: { id: 'r61-default', mode: 'longwrite', workspace: 'chat', phase: 'execute', planText: '', text: 'fixture', longMode: true, targetChars: 512 },
    // Reference pricing does not create a total monetary work limit.
    settings: { ...baseSettings(), providerPricingSnapshots: [price('USD')] },
    sessionId: 'r61-session',
    memory: { projectPath: '', projectContent: '', userContent: '' },
    now: 1_000
  })
  const denied = production.providerCallBudget?.maxCost
  const contractDenied = production.completionContract?.providerCallBudget?.maxCost
  check('default production snapshot has no invented amount cap', denied === null && production.workBudgetPolicy === 'explicit_v1')
  check('completion contract receives the same explicit work policy', JSON.stringify(denied) === JSON.stringify(contractDenied))

  const usd = price('USD')
  const known = deriveProviderCallBudget({ maxCalls: 3, maxTokens: 999, maxInputTokens: 1_000, maxOutputTokens: 200, pricingSnapshots: [usd, usd, usd, usd, usd] })
  const expected = (((1_000 * 4 + 65_536) * 2 + 200 * 3) / 1_000_000) * 3
  check('known same-currency pricing derives a conservative bound', known.maxCost?.currency === 'USD' && Math.abs(known.maxCost.amount - expected) < 1e-12, JSON.stringify(known))
  check('user-supplied price with a valid identity/hash is usable', known.maxCost?.amount > 0, JSON.stringify(known.maxCost))

  const unknown = deriveProviderCallBudget({ maxCalls: 3, maxTokens: 999, maxInputTokens: 1_000, maxOutputTokens: 200, pricingSnapshots: [null, null, null, null, null] })
  check('missing pricing fails closed', unknown.maxCost?.amount === 0 && unknown.maxCost?.currency === null && unknown.maxCost?.unknownPolicy === 'deny')

  const mixed = deriveProviderCallBudget({ maxCalls: 3, maxTokens: 999, maxInputTokens: 1_000, maxOutputTokens: 200, pricingSnapshots: [usd, price('CNY'), usd, usd, usd] })
  check('mixed currencies fail closed without conversion', mixed.maxCost?.amount === 0 && mixed.maxCost?.currency === null && mixed.maxCost?.unknownPolicy === 'deny')

  check('reference pricing leaves new explicit-only work limits intact', applyFrozenProviderPricing(production, frozenStages(usd, 1_000, 200)).providerCallBudget.maxCost === null)
  const legacyProduction = { ...production, providerCallBudget: { ...known } }
  delete legacyProduction.workBudgetPolicy
  const applied = applyFrozenProviderPricing(legacyProduction, frozenStages(usd, 1_000, 200))
  const appliedCost = applied.providerCallBudget?.maxCost
  check('frozen profile pricing replaces the initial deny policy', appliedCost?.currency === 'USD' && appliedCost.amount > 0, JSON.stringify(appliedCost))
  check('provider and completion-contract budgets are atomically mirrored', JSON.stringify(applied.providerCallBudget) === JSON.stringify(applied.completionContract?.providerCallBudget))

  // Serialize the accepted config, then change the registry-side object. A
  // restart reads the durable snapshot and must retain its original bound.
  const persisted = JSON.parse(JSON.stringify(applied)) as Record<string, any>
  const beforeRestart = JSON.stringify(persisted.providerCallBudget)
  const changed = applyFrozenProviderPricing(legacyProduction, frozenStages(price('CNY'), 1_000, 200))
  check('restart keeps the frozen budget despite later registry pricing changes', JSON.stringify(persisted.providerCallBudget) === beforeRestart && changed.providerCallBudget?.maxCost?.currency === 'CNY' && persisted.providerCallBudget?.maxCost?.currency === 'USD')

  // The pre-fetch hook is invoked after the exact request envelope is built,
  // but before the provider implementation is allowed to perform its call.
  const kernelMod = await loadTsModule('src/main/runKernelAdapter.ts', 'r61-kernel')
  const createModelCallAdapter = kernelMod.createModelCallAdapter as (options: Record<string, unknown>) => (input: Record<string, unknown>) => Promise<AsyncIterable<unknown>>
  let hookCalls = 0
  let fetchCalls = 0
  const api = { apiKey: 'fixture-key', baseUrl: 'https://fixture.example', model: 'fixture-model', maxTokens: 256, thinking: { enabled: false, effort: 'high' }, temperature: 1, topP: 1, pricing: null }
  const adapter = createModelCallAdapter({
    getApi: () => api,
    buildPrefix: async () => [],
    getSignal: () => undefined,
    getConfig: () => ({ model: api.model, baseUrl: api.baseUrl, maxTokens: api.maxTokens, thinking: api.thinking, temperature: api.temperature, topP: api.topP }),
    beforeProviderAttempt: ({ costQuote }: { costQuote?: { status?: string } }) => {
      hookCalls += 1
      if (costQuote?.status === 'unknown') throw new Error('unknown cost denied before fetch')
    },
    streamChatImpl: async (_params: unknown, _onEvent: unknown, _signal: unknown, _onRetry: unknown, _onAttempt: unknown, _onLifecycle: unknown, beforeAttempt: ((innerAttempt: number, request: Record<string, unknown>) => void | Promise<void>) | undefined) => {
      await beforeAttempt?.(1, { bodyJson: '{}', model: 'fixture-model', maxTokens: 256 })
      fetchCalls += 1
      return { finishReason: 'stop', usage: null }
    }
  })
  let prevented = false
  try {
    const iterable = await adapter({ runId: 'r61-prefetch', phase: 'execute', turnSeq: 1, round: 1, messages: [{ role: 'user', content: 'fixture' }], purpose: 'writer' })
    for await (const _event of iterable) { /* expected to throw before fetch */ }
  } catch {
    prevented = true
  }
  check('unknown cost is rejected by the pre-fetch hook before provider call', prevented && hookCalls === 1 && fetchCalls === 0, JSON.stringify({ prevented, hookCalls, fetchCalls }))

  console.log(`\nR61 provider cost budget: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('R61 provider cost budget 执行异常：', error)
  process.exitCode = 2
})
