import { desktopSourceExternals } from './desktop-source-boundary.mjs'
/** P0-1 focused regression: durable provider budget, retry accounting and
 * zero-progress stop.  Run with:
 *   npx esbuild scripts/p0-1-provider-budget.ts --bundle --format=esm --platform=node --outfile=out/p0-1-provider-budget.mjs && node out/p0-1-provider-budget.mjs
 */
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import type { ModelEvent, RunConfig, RunStorePort } from '../src/main/jobs/types'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

async function loadTsModule(relativePath: string): Promise<Record<string, unknown>> {
  const outfile = path.join(ROOT, 'out', `p0-1-provider-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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
  getState(runId: string): Promise<{ run?: { status?: string; errorCode?: string; startedAt?: number } | null }>
}
type EngineFactory = (opts: Record<string, unknown>) => TestEngine

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

function prose(length: number, seed: string): string {
  const points = Array.from(seed)
  const offset = points.reduce((sum, point) => (sum * 31 + (point.codePointAt(0) ?? 0)) % 0x0fff, 0)
  while (points.length < Math.max(1, length - 1)) points.push(String.fromCodePoint(0x10000 + offset + points.length))
  points.length = Math.max(0, length - 1)
  points.push('。')
  return points.join('')
}

function config(runId: string, targetChars: number, maxCalls: number): RunConfig {
  return {
    clientRequestId: runId,
    sessionId: `session-${runId}`,
    runMode: 'longwrite',
    workspace: 'novel',
    longMode: true,
    maxTurns: 4,
    maxTokens: 128,
    targetChars,
    deepWrite: { targetChars, continueOnLength: true, maxRounds: 4 },
    completionContract: {
      schemaVersion: 1,
      runId: '',
      targetChars: { min: targetChars, max: targetChars, tolerance: 0 },
      validators: [
        { id: 'targetChars', severity: 'hard', config: {} },
        { id: 'noPendingTools', severity: 'hard', config: {} }
      ],
      maxRepairAttempts: 2,
      providerCallBudget: { maxCalls, maxTokens: 100000, maxWallClockMs: 300000 },
      createdAt: Date.now()
    },
    deliveryContract: { manuscriptFile: false }
  }
}

function delayedStore(base: RunStorePort, delayMs: number): RunStorePort {
  return {
    ...base,
    async saveRunEvidence(runId, kind, json) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      await base.saveRunEvidence(runId, kind, json)
    }
  }
}

function makeEngine(createAgentRunEngine: EngineFactory, store: RunStorePort, runId: string, cfg: RunConfig, outputs: string[], options?: { retry?: boolean }): { engine: TestEngine; calls: { count: number } } {
  const calls = { count: 0 }
  const engine = createAgentRunEngine({
    store,
    modelCall: async (input) => {
      if (options?.retry) await input.beforeProviderAttempt?.({ innerAttempt: 2 })
      const output = outputs[Math.min(calls.count, outputs.length - 1)] ?? ''
      calls.count += 1
      const events: ModelEvent[] = [
        { type: 'text', delta: output },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: Array.from(output).length } },
        { type: 'finish', finishReason: 'stop' }
      ]
      return (async function* (): AsyncGenerator<ModelEvent> {
        for (const event of events) yield event
      })()
    },
    toolExecutor: async () => '',
    getConfig: () => cfg,
    onEvent: () => undefined,
    onRunUpdate: () => undefined
  })
  return { engine, calls }
}

async function main(): Promise<void> {
  const fixtureStartedAt = Date.now()
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
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p0-1-budget-'))
  const repo = createRepository(path.join(tmpDir, 'run.db'))
  repo.open()
  try {
    // A delayed evidence writer proves that the reservation is awaited before
    // the synthetic model boundary, and that restart cannot observe a stale
    // counter.
    const runId = 'p0-budget-cap'
    const cfg = config(runId, 2000, 2)
    const store = delayedStore(createRunStorePort(repo), 15)
    const first = makeEngine(createAgentRunEngine, store, runId, cfg, [prose(400, '第一轮'), prose(400, '第二轮'), prose(400, '第三轮')])
    const startedAt = Date.now()
    await first.engine.start({ sessionId: cfg.sessionId as string, runId, config: cfg })
    await first.engine.step(runId)
    const elapsed = Date.now() - startedAt
    const stopped = await first.engine.getState(runId)
    const evidence1 = repo.getRunEvidence(runId, 'run_provider_budget_v1')
    const budget1 = evidence1 ? JSON.parse(evidence1.json) as { totalCalls: number; callsByActor: { writer: number }; retryCalls: number; limits: { maxCalls: number } } : null
    check('P0 cap 首次运行在 hard cap 处 waiting_user', stopped.run?.status === 'waiting_user' && stopped.run.errorCode === 'run_provider_call_cap', JSON.stringify(stopped.run))
    check('P0 cap synthetic provider calls ≤ hard cap', first.calls.count === 2 && budget1?.totalCalls === 2 && budget1.limits.maxCalls === 2, JSON.stringify({ calls: first.calls.count, budget: budget1 }))
    check('P0 reservation 在延迟 evidence 写入完成后才允许 provider boundary', elapsed >= 15 && budget1?.callsByActor.writer === 2, `elapsed=${elapsed} budget=${JSON.stringify(budget1)}`)

    // Simulate evidence written by an older build with looser limits.  The
    // persisted counters remain authoritative, but restore must re-clamp the
    // limits to this run's frozen configuration.
    if (budget1) {
      repo.saveRunEvidence(runId, 'run_provider_budget_v1', JSON.stringify({
        ...budget1,
        limits: { maxCalls: 512, maxTokens: 20_000_000, maxCostCny: null, maxWallClockMs: 86_400_000 },
        startedAt: startedAt + 60_000
      }))
    }

    const second = makeEngine(createAgentRunEngine, store, runId, cfg, [prose(400, '重启后不应调用')])
    await second.engine.restore(runId)
    await second.engine.step(runId)
    const resumed = await second.engine.getState(runId)
    const evidence2 = repo.getRunEvidence(runId, 'run_provider_budget_v1')
    const budget2 = evidence2 ? JSON.parse(evidence2.json) as { totalCalls: number; retryCalls: number; zeroProgressRounds: number; startedAt: number; limits: { maxCalls: number } } : null
    check('P0 restart 不归零、重夹紧且不再发 provider', resumed.run?.status === 'waiting_user' && second.calls.count === 0 && budget2?.totalCalls === 2 && budget2.limits.maxCalls === 2 && budget2.startedAt <= (stopped.run?.startedAt ?? Number.MAX_SAFE_INTEGER), JSON.stringify({ run: resumed.run, calls: second.calls.count, budget: budget2 }))

    // Native adapters invoke this seam only for inner retry attempts.  The
    // synthetic call intentionally invokes it before yielding any event.
    const retryId = 'p0-budget-retry'
    const retryCfg = config(retryId, 400, 2)
    const retry = makeEngine(createAgentRunEngine, store, retryId, retryCfg, [prose(400, '重试统计')], { retry: true })
    await retry.engine.start({ sessionId: retryCfg.sessionId as string, runId: retryId, config: retryCfg })
    await retry.engine.step(retryId)
    const retryEvidence = repo.getRunEvidence(retryId, 'run_provider_budget_v1')
    const retryBudget = retryEvidence ? JSON.parse(retryEvidence.json) as { totalCalls: number; retryCalls: number; callsByActor: { writer: number }; retriesByActor: { writer: number }; targetWindowRepairAttempts: number } : null
    check('P0 inner retry 纳入总 cap 且不误增 logical repair', retryBudget?.totalCalls === 2 && retryBudget.retryCalls === 1 && retryBudget.callsByActor.writer === 2 && retryBudget.retriesByActor.writer === 1 && retryBudget.targetWindowRepairAttempts === 0, JSON.stringify(retryBudget))

    // Two actual rounds with zero accepted delta must stop before a fourth
    // provider call, even though the planner's maxTurns is still available.
    const zeroId = 'p0-budget-zero'
    const zeroCfg = config(zeroId, 2000, 16)
    const zero = makeEngine(createAgentRunEngine, store, zeroId, zeroCfg, [prose(400, '有进展'), '{"meta":"拒绝进入正文"}', '残句未完'])
    await zero.engine.start({ sessionId: zeroCfg.sessionId as string, runId: zeroId, config: zeroCfg })
    await zero.engine.step(zeroId)
    const zeroState = await zero.engine.getState(zeroId)
    const zeroEvidence = repo.getRunEvidence(zeroId, 'run_provider_budget_v1')
    const zeroBudget = zeroEvidence ? JSON.parse(zeroEvidence.json) as { totalCalls: number; zeroProgressRounds: number } : null
    check('P0 连续两轮 0 accepted delta 不扩轮并暂停', zeroState.run?.status === 'waiting_user' && zeroState.run.errorCode === 'run_no_progress' && zero.calls.count === 3 && zeroBudget?.zeroProgressRounds >= 2, JSON.stringify({ run: zeroState.run, calls: zero.calls.count, budget: zeroBudget }))

    const totalProviderCalls = first.calls.count + second.calls.count + retry.calls.count + zero.calls.count
    check('P0 fixture 有界（≤16 provider calls，<30s）', totalProviderCalls <= 16 && Date.now() - fixtureStartedAt < 30_000, `calls=${totalProviderCalls} elapsedMs=${Date.now() - fixtureStartedAt}`)
  } finally {
    repo.close()
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nP0-1 provider budget: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('P0-1 provider budget 执行异常：', error)
  process.exitCode = 2
})
