import { desktopSourceExternals } from './desktop-source-boundary.mjs'
/** P1 focused regression: durable token reservation/settlement at the
 * provider boundary. Covers cap-minus-one preflight rejection, usage-absent
 * upper settlement, independent inner retries, restart recovery, concurrent
 * duplicate callbacks, and a deliberately under-estimated usage overrun.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import type { DsMessage } from '../src/shared/types'
import type { ModelEvent, RunConfig, RunStorePort } from '../src/main/jobs/types'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

async function loadTsModule(relativePath: string): Promise<Record<string, unknown>> {
  const outfile = path.join(ROOT, 'out', `p1-token-budget-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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
          contents: 'export const app={getPath:(name)=>String(name),isPackaged:false}; export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]}),showSaveDialog:async()=>({canceled:true})}; export const ipcMain={handle:()=>undefined,on:()=>undefined}; export const safeStorage={isEncryptionAvailable:()=>false,encryptString:()=>null,decryptString:()=>""}; export const shell={openExternal:()=>undefined,openPath:async()=>""}; export const clipboard={writeText:()=>undefined}; export const Menu={buildFromTemplate:(template)=>({popup:()=>undefined,template})};',
          loader: 'js'
        }))
      }
    }]
  })
  try {
    return await import(url.pathToFileURL(outfile).href) as Record<string, unknown>
  } finally {
    await fsp.unlink(outfile).catch(() => undefined)
  }
}

type TestEngine = {
  start(input: { sessionId: string; runId: string; config: RunConfig }): Promise<unknown>
  step(runId: string): Promise<void>
  restore(runId: string): Promise<unknown>
  getState(runId: string): Promise<{ run?: { status?: string; errorCode?: string } | null }>
}
type EngineFactory = (opts: Record<string, unknown>) => TestEngine
type TokenRequest = { bodyJson: string; model: string; maxTokens: number }
type BeforeAttempt = (input: { innerAttempt: number; logicalCallId?: string; request?: TokenRequest }) => void | Promise<void>
type ModelInput = { messages: DsMessage[]; logicalCallId?: string; beforeProviderAttempt?: BeforeAttempt }

let passed = 0
let failed = 0

function check(name: string, value: boolean, detail = ''): void {
  if (value) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function config(runId: string, tokenCap: number, outputMax = 4): RunConfig {
  return {
    clientRequestId: runId,
    sessionId: `session-${runId}`,
    runMode: 'agent',
    maxTurns: 1,
    maxTokens: outputMax,
    completionContract: {
      schemaVersion: 1,
      runId: '',
      validators: [],
      maxRepairAttempts: 0,
      providerCallBudget: { maxCalls: 8, maxTokens: tokenCap, maxWallClockMs: 300000 },
      createdAt: Date.now()
    }
  }
}

function requestBody(messages: DsMessage[], outputMax: number): string {
  return JSON.stringify({
    model: 'mock-model',
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: outputMax,
    thinking: { type: 'disabled' },
    temperature: 1,
    top_p: 1
  })
}

interface ProviderBehavior {
  output?: string
  outputMax?: number
  usage?: { inputTokens: number; outputTokens: number } | null
  retry?: boolean
  duplicateCallbacks?: number
}

function makeEngine(
  createAgentRunEngine: EngineFactory,
  store: RunStorePort,
  runId: string,
  cfg: RunConfig,
  behavior: ProviderBehavior
): { engine: TestEngine; stats: { modelCalls: number; fetches: number; callbackCalls: number } } {
  const stats = { modelCalls: 0, fetches: 0, callbackCalls: 0 }
  const outputMax = behavior.outputMax ?? (typeof cfg.maxTokens === 'number' ? cfg.maxTokens : 4)
  const engine = createAgentRunEngine({
    store,
    modelCall: async (input: ModelInput) => {
      stats.modelCalls += 1
      const bodyJson = requestBody(input.messages, outputMax)
      const invoke = async (innerAttempt: number): Promise<void> => {
        stats.callbackCalls += 1
        await input.beforeProviderAttempt?.({
          innerAttempt,
          logicalCallId: input.logicalCallId,
          request: { bodyJson, model: 'mock-model', maxTokens: outputMax }
        })
      }
      const duplicateCount = Math.max(1, behavior.duplicateCallbacks ?? 1)
      await Promise.all(Array.from({ length: duplicateCount }, () => invoke(1)))
      stats.fetches += 1
      if (behavior.retry) {
        await invoke(2)
        stats.fetches += 1
      }
      const events: ModelEvent[] = [{ type: 'text', delta: behavior.output ?? '灯。' }]
      if (behavior.usage !== null) {
        const usage = behavior.usage ?? { inputTokens: 2, outputTokens: 1 }
        events.push({ type: 'usage', usage })
      }
      events.push({ type: 'finish', finishReason: 'stop' })
      return (async function* (): AsyncGenerator<ModelEvent> {
        for (const event of events) yield event
      })()
    },
    toolExecutor: async () => '',
    getConfig: () => cfg,
    onEvent: () => undefined,
    onRunUpdate: () => undefined
  })
  return { engine, stats }
}

function readBudget(repo: { getRunEvidence(runId: string, kind: string): { json: string } | null }, runId: string): Record<string, any> | null {
  const row = repo.getRunEvidence(runId, 'run_provider_budget_v1')
  if (!row) return null
  try { return JSON.parse(row.json) as Record<string, any> } catch { return null }
}

async function main(): Promise<void> {
  const [repoMod, portMod, engineMod] = await Promise.all([
    loadTsModule('src/main/db/repository.ts'),
    loadTsModule('src/main/runKernelAdapter.ts'),
    loadTsModule('src/main/jobs/AgentRunEngine.ts')
  ])
  const createRepository = repoMod.createRepository as (dbPath: string) => {
    open(): void
    close(): void
    getRunEvidence(runId: string, kind: string): { json: string } | null
    saveRunEvidence(runId: string, kind: string, json: string): void
  }
  const createRunStorePort = portMod.createRunStorePort as (repository: unknown) => RunStorePort
  const createAgentRunEngine = engineMod.createAgentRunEngine as EngineFactory
  const estimateProviderTokenUpperBound = engineMod.estimateProviderTokenUpperBound as (input: { bodyJson?: string; messages?: DsMessage[]; maxTokens?: number }) => { inputTokens: number; outputTokens: number; totalTokens: number } | null
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p1-token-budget-'))
  const repo = createRepository(path.join(tmpDir, 'run.db'))
  repo.open()
  const store = createRunStorePort(repo)
  try {
    const unicodeMessages: DsMessage[] = [{ role: 'user', content: '重复😀字符与中文' }]
    const unicodeBody = requestBody(unicodeMessages, 7)
    const unicodeBound = estimateProviderTokenUpperBound({ bodyJson: unicodeBody, messages: unicodeMessages, maxTokens: 7 })
    check('估算使用实际 UTF-8 body/messages 且包含 max output', unicodeBound !== null && unicodeBound.outputTokens === 7 && unicodeBound.inputTokens >= Buffer.byteLength(unicodeBody, 'utf8') && unicodeBound.totalTokens === unicodeBound.inputTokens + 7, JSON.stringify(unicodeBound))
    check('非法/缺失 request 无法形成 token 上界时 fail-closed', estimateProviderTokenUpperBound({ maxTokens: 4 }) === null && estimateProviderTokenUpperBound({ bodyJson: '{}', maxTokens: Number.NaN }) === null)

    // The cap is exactly one below the bound for the final exact body. The
    // fallback reservation may enter modelCall, but exact beforeAttempt must
    // reject before the simulated fetch marker is reached.
    const capBody = requestBody([], 1)
    const capBound = estimateProviderTokenUpperBound({ bodyJson: capBody, messages: [], maxTokens: 1 })
    const capRun = 'p1-token-cap-minus-one'
    const capCfg = config(capRun, Math.max(1, (capBound?.totalTokens ?? 100) - 1), 1)
    const cap = makeEngine(createAgentRunEngine, store, capRun, capCfg, { outputMax: 1, usage: { inputTokens: 1, outputTokens: 1 } })
    await cap.engine.start({ sessionId: capCfg.sessionId as string, runId: capRun, config: capCfg })
    await cap.engine.step(capRun)
    const capState = await cap.engine.getState(capRun)
    const capBudget = readBudget(repo, capRun)
    check('cap-1 在 fetch 前拒绝', cap.stats.fetches === 0 && capState.run?.status === 'waiting_user' && capState.run.errorCode === 'run_token_budget', JSON.stringify({ stats: cap.stats, run: capState.run, budget: capBudget }))

    const absentRun = 'p1-token-usage-absent'
    const absentCfg = config(absentRun, 1000, 4)
    const absent = makeEngine(createAgentRunEngine, store, absentRun, absentCfg, { outputMax: 4, usage: null })
    await absent.engine.start({ sessionId: absentCfg.sessionId as string, runId: absentRun, config: absentCfg })
    await absent.engine.step(absentRun)
    const absentBudget = readBudget(repo, absentRun)
    const absentSettled = Array.isArray(absentBudget?.settledTokenReservations) ? absentBudget.settledTokenReservations : []
    check('usage absent 按预留上界结算且不释放容量', absent.stats.fetches === 1 && absentBudget?.reservedTokenAttempts === 0 && absentSettled.length === 1 && absentSettled[0].chargedTokens > 0 && absentBudget.spentTokenUpper === absentSettled[0].chargedTokens, JSON.stringify({ stats: absent.stats, budget: absentBudget }))

    const retryRun = 'p1-token-inner-retry'
    const retryCfg = config(retryRun, 1000, 4)
    const retry = makeEngine(createAgentRunEngine, store, retryRun, retryCfg, { outputMax: 4, retry: true, usage: { inputTokens: 2, outputTokens: 1 } })
    await retry.engine.start({ sessionId: retryCfg.sessionId as string, runId: retryRun, config: retryCfg })
    await retry.engine.step(retryRun)
    const retryBudget = readBudget(repo, retryRun)
    const retrySettled = Array.isArray(retryBudget?.settledTokenReservations) ? retryBudget.settledTokenReservations : []
    check('每个 inner retry 独立预留/结算', retry.stats.fetches === 2 && retryBudget?.totalCalls === 2 && retryBudget?.retryCalls === 1 && retryBudget?.reservedTokenAttempts === 0 && retrySettled.length === 2 && retrySettled[0].chargedTokens > 3 && retrySettled[1].chargedTokens === 3, JSON.stringify({ stats: retry.stats, budget: retryBudget }))

    // Inject one durable in-flight reservation, then restore with a fresh
    // engine. It must remain visible and consume capacity; the next request
    // is refused before fetch rather than resetting the ledger to zero.
    const restartRun = 'p1-token-restart'
    const restartCfg = config(restartRun, 100, 4)
    const seed = makeEngine(createAgentRunEngine, store, restartRun, restartCfg, { outputMax: 4, usage: { inputTokens: 1, outputTokens: 1 } })
    await seed.engine.start({ sessionId: restartCfg.sessionId as string, runId: restartRun, config: restartCfg })
    const seedBudget = readBudget(repo, restartRun)
    const reservation = { reservationId: 'restart-call\u00001', logicalCallId: 'restart-call', innerAttempt: 1, inputTokens: 80, outputTokens: 10, totalTokens: 90, requestHash: 'restart', reservedAt: Date.now() }
    repo.saveRunEvidence(restartRun, 'run_provider_budget_v1', JSON.stringify({
      ...(seedBudget ?? {}),
      totalCalls: 0,
      spentTokenUpper: 0,
      reservedInputTokens: 80,
      reservedOutputTokens: 10,
      reservedTokenAttempts: 1,
      tokenReservations: [reservation],
      settledTokenReservations: [],
      tokenReservationCorrupt: false,
      limits: { ...(seedBudget?.limits ?? {}), maxTokens: 100 }
    }))
    const restored = makeEngine(createAgentRunEngine, store, restartRun, restartCfg, { outputMax: 4, usage: { inputTokens: 1, outputTokens: 1 } })
    await restored.engine.restore(restartRun)
    await restored.engine.step(restartRun)
    const restartState = await restored.engine.getState(restartRun)
    const restartBudget = readBudget(repo, restartRun)
    check('restart 恢复未结 reservation 且不归零', restored.stats.fetches === 0 && restartState.run?.status === 'waiting_user' && restartState.run.errorCode === 'run_token_budget' && restartBudget?.reservedTokenAttempts === 1 && restartBudget?.reservedInputTokens === 80 && restartBudget?.reservedOutputTokens === 10 && restartBudget?.spentTokenUpper === 0, JSON.stringify({ stats: restored.stats, run: restartState.run, budget: restartBudget }))

    const duplicateRun = 'p1-token-duplicate-callback'
    const duplicateCfg = config(duplicateRun, 1000, 4)
    const duplicate = makeEngine(createAgentRunEngine, store, duplicateRun, duplicateCfg, { outputMax: 4, duplicateCallbacks: 8, usage: { inputTokens: 2, outputTokens: 1 } })
    await duplicate.engine.start({ sessionId: duplicateCfg.sessionId as string, runId: duplicateRun, config: duplicateCfg })
    await duplicate.engine.step(duplicateRun)
    const duplicateBudget = readBudget(repo, duplicateRun)
    const duplicateSettled = Array.isArray(duplicateBudget?.settledTokenReservations) ? duplicateBudget.settledTokenReservations : []
    check('并发/重复 beforeAttempt 幂等且不超发', duplicate.stats.fetches === 1 && duplicate.stats.callbackCalls === 8 && duplicateBudget?.totalCalls === 1 && duplicateBudget?.reservedTokenAttempts === 0 && duplicateSettled.length === 1, JSON.stringify({ stats: duplicate.stats, budget: duplicateBudget }))

    const overrunRun = 'p1-token-estimate-overrun'
    const overrunCfg = config(overrunRun, 1000, 4)
    const overrun = makeEngine(createAgentRunEngine, store, overrunRun, overrunCfg, { outputMax: 4, usage: { inputTokens: 1, outputTokens: 1000 } })
    await overrun.engine.start({ sessionId: overrunCfg.sessionId as string, runId: overrunRun, config: overrunCfg })
    await overrun.engine.step(overrunRun)
    const overrunState = await overrun.engine.getState(overrunRun)
    const overrunBudget = readBudget(repo, overrunRun)
    check('估算偏差超出上界时保留超支证据并 fail-closed', overrun.stats.fetches === 1 && overrunState.run?.status === 'waiting_user' && overrunState.run.errorCode === 'run_token_budget' && overrunBudget?.tokenReservationCorrupt === true && overrunBudget?.reservedTokenAttempts === 0 && overrunBudget.spentTokenUpper > 1000, JSON.stringify({ stats: overrun.stats, run: overrunState.run, budget: overrunBudget }))
  } finally {
    repo.close()
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nP1 token budget: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('P1 token budget 执行异常：', error)
  process.exitCode = 2
})
