// R52 核心可靠性回归：验证 chat:start 在事务提交后发生引擎/step 异常时，
// durable run 不会停在无诊断的 queued；同时验证跨重启幂等重放不重复启动。
// 全部使用临时 SQLite + 注入 engine，不联网、不读取生产数据库。

import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'

const scriptDir = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

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

async function loadTsModule(relativePath: string): Promise<Record<string, unknown>> {
  const entry = path.resolve(scriptDir, '..', relativePath)
  const outfile = path.resolve(scriptDir, '..', 'out', `r52-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', target: 'node20',
      write: true, outfile, external: ['node:sqlite'], logLevel: 'silent'
    })
    return await import(url.pathToFileURL(outfile).href) as Record<string, unknown>
  } finally {
    await fsp.unlink(outfile).catch(() => undefined)
  }
}

type Row = { run_id: string; status: string; phase: string; error_code: string | null; error_message: string | null; started_at: number }
type Repo = {
  open(): void
  close(): void
  getRun(id: string): Row | null
  updateRun(id: string, patch: Record<string, unknown>): void
  acceptChatStart(input: unknown): { ok: boolean; reason?: string; runId?: string }
}
type StartChatRun = (deps: unknown, payload: Record<string, unknown>) => Promise<{ runId: string; status: string; idempotent: boolean }>

const payload = (id: string, sessionId: string): Record<string, unknown> => ({
  id, sessionId, text: 'R52 reliability probe', longMode: false
})

const depsFor = (repository: Repo, engine: { start(input: unknown): Promise<{ ok: boolean; error?: string }>; step(id: string): Promise<void> }): Record<string, unknown> => ({
  repository,
  runKernel: engine,
  loadSettings: async () => ({ model: 'deepseek-v4-flash', historyBudgetTokens: 60000 }),
  buildConfig: (p: { id: string }, _settings: unknown, sessionId: string) => ({ schemaVersion: 1, clientRequestId: p.id, sessionId, runMode: 'agent' })
})

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r52-reliability-'))
  let repo: Repo | null = null
  try {
    const repoModule = await loadTsModule('src/main/db/repository.ts')
    const createRepository = repoModule.createRepository as (dbPath: string) => Repo
    repo = createRepository(path.join(tmp, 'reliability.db'))
    repo.open()
    const startChatRun = (await loadTsModule('src/main/chatStart.ts')).startChatRun as StartChatRun

    // P0-01：accept 已提交后 engine.start 拒绝，必须把 queued 转为带诊断的 failed。
    const rejectedEngine = {
      start: async () => ({ ok: false, error: 'boot_failed' }),
      step: async () => undefined
    }
    let rejected = false
    try { await startChatRun(depsFor(repo, rejectedEngine), payload('r52-start-rejected', 'r52-s1')) } catch { rejected = true }
    const rejectedRow = repo.getRun('r52-start-rejected')
    check('engine.start 拒绝仍向 renderer 抛错', rejected)
    check('engine.start 拒绝 durable 终态为 failed', rejectedRow?.status === 'failed' && rejectedRow.phase === 'failed', JSON.stringify(rejectedRow))
    check('engine.start 拒绝写入稳定 error_code/message', rejectedRow?.error_code === 'run_engine_start_rejected' && rejectedRow.error_message?.includes('boot_failed') === true, JSON.stringify(rejectedRow))

    // P0-01：engine.start 抛异常同样不能留下无诊断 queued。
    const throwingEngine = {
      start: async () => { throw new Error('registry unavailable') },
      step: async () => undefined
    }
    let startThrew = false
    try { await startChatRun(depsFor(repo, throwingEngine), payload('r52-start-throw', 'r52-s2')) } catch { startThrew = true }
    const thrownRow = repo.getRun('r52-start-throw')
    check('engine.start 异常仍向 renderer 抛错', startThrew)
    check('engine.start 异常 durable 记录失败原因', thrownRow?.status === 'failed' && thrownRow.error_code === 'run_engine_start_failed' && thrownRow.error_message === 'registry unavailable', JSON.stringify(thrownRow))

    // A start failure can race with a durable pause/side-effect decision. The
    // generic post-accept fallback must not erase either explicit state.
    for (const protectedStatus of ['waiting_user', 'recovery_required']) {
      const protectedId = `r52-start-${protectedStatus}`
      const protectedEngine = {
        start: async () => {
          repo.updateRun(protectedId, { status: protectedStatus, phase: protectedStatus === 'waiting_user' ? 'paused' : protectedStatus })
          throw new Error('late start failure')
        },
        step: async () => undefined
      }
      try { await startChatRun(depsFor(repo, protectedEngine), payload(protectedId, `r52-${protectedStatus}`)) } catch { /* expected */ }
      const protectedRow = repo.getRun(protectedId)
      check(`start 兜底不覆盖 ${protectedStatus}`, protectedRow?.status === protectedStatus && protectedRow.error_code === null, JSON.stringify(protectedRow))
    }

    // P0-02：step 是 fire-and-forget，拒绝不能被 catch(() => undefined) 吞掉。
    const stepEngine = {
      start: async () => ({ ok: true }),
      step: async () => { throw new Error('local SSE disconnected') }
    }
    const stepResult = await startChatRun(depsFor(repo, stepEngine), payload('r52-step-throw', 'r52-s3'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const stepRow = repo.getRun('r52-step-throw')
    check('step 异常不阻塞 chat:start ACK', stepResult.runId === 'r52-step-throw')
    check('step 异常 durable 记录失败原因', stepRow?.status === 'failed' && stepRow.error_code === 'run_step_failed' && stepRow.error_message === 'local SSE disconnected', JSON.stringify(stepRow))

    // P1：同一持久幂等键重放只返回既有 run，不重复 engine.start/step。
    let starts = 0
    let steps = 0
    const idempotentEngine = {
      start: async () => { starts += 1; return { ok: true } },
      step: async () => { steps += 1 }
    }
    const first = await startChatRun(depsFor(repo, idempotentEngine), payload('r52-idempotent', 'r52-s4'))
    const second = await startChatRun(depsFor(repo, idempotentEngine), payload('r52-idempotent', 'r52-s4'))
    check('幂等重放返回既有 run', first.runId === second.runId && second.idempotent === true, JSON.stringify(second))
    check('幂等重放不重复启动/step', starts === 1 && steps === 1, `starts=${starts} steps=${steps}`)

    // The ACK status must survive both orchestration layers.  A recoverable
    // durable run is not a new queued run, even when the replay happens in
    // the same process and the in-memory fast path is populated.
    repo.updateRun('r52-idempotent', { status: 'recoverable', phase: 'paused' })
    const orchestrationModule = await loadTsModule('src/main/chatOrchestration.ts')
    const createChatOrchestration = orchestrationModule.createChatOrchestration as (options: Record<string, unknown>) => {
      handleChatStart(payload: Record<string, unknown>): Promise<{ status: string; idempotent: boolean }>
    }
    const orchestrationDeps = {
      repository: repo,
      runKernel: idempotentEngine,
      loadSettings: async () => ({ model: 'deepseek-v4-flash' }),
      buildConfig: (p: Record<string, unknown>, _settings: unknown, sessionId: string) => ({ clientRequestId: p.id, sessionId }),
      startedChats: new Set<string>()
    }
    const orchestrated = await createChatOrchestration(orchestrationDeps).handleChatStart(payload('r52-idempotent', 'r52-s4'))
    check('编排层保留 durable recoverable ACK', orchestrated.status === 'recoverable' && orchestrated.idempotent === true, JSON.stringify(orchestrated))
    const memoryReplay = await createChatOrchestration({ ...orchestrationDeps, startedChats: new Set(['r52-idempotent']) }).handleChatStart(payload('r52-idempotent', 'r52-s4'))
    check('内存幂等路径也保留 recoverable ACK', memoryReplay.status === 'recoverable' && memoryReplay.idempotent === true, JSON.stringify(memoryReplay))

    // 终态不能伪装成 queued ACK，否则 renderer 会创建永远收不到事件的假运行。
    repo.updateRun('r52-idempotent', { status: 'completed', phase: 'completed' })
    let terminalRejected = false
    try { await startChatRun(depsFor(repo, idempotentEngine), payload('r52-idempotent', 'r52-s4')) } catch { terminalRejected = true }
    check('终态幂等重放明确拒绝而不伪装 queued', terminalRejected)

    // P0-02：直接调用 engine.step（runs:resume 等入口）时，越过 doCycle 的
    // 异常也必须落 durable failure，而不是只由上层 fire-and-forget 吞掉。
    const engineModule = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
    const createAgentRunEngine = engineModule.createAgentRunEngine as (options: Record<string, unknown>) => { start(input: Record<string, unknown>): Promise<unknown>; step(id: string): Promise<void> }
    let turnReads = 0
    let engineRun: Record<string, unknown> = {
      runId: 'r52-engine-step', sessionId: 'r52-s5', status: 'queued', phase: 'queued',
      startedAt: Date.now(), updatedAt: Date.now(), configJson: '{}'
    }
    const engineUpdates: Array<Record<string, unknown>> = []
    const engineStore = {
      getRunEvidence: async () => null,
      saveRunEvidence: async () => undefined,
      getRun: async () => engineRun,
      getTurns: async () => {
        turnReads += 1
        if (turnReads === 1) return []
        throw new Error('turn store unavailable')
      },
      updateRun: async (_id: string, patch: Record<string, unknown>) => {
        engineUpdates.push(patch)
        engineRun = { ...engineRun, ...patch }
      }
    }
    const engine = createAgentRunEngine({
      store: engineStore,
      modelCall: async () => { throw new Error('model should not be called') },
      toolExecutor: async () => '',
      getConfig: () => ({}), onEvent: () => undefined, onRunUpdate: () => undefined
    })
    await engine.start({ sessionId: 'r52-s5', runId: 'r52-engine-step', config: {}, alreadyCreated: true })
    let engineRejected = false
    try { await engine.step('r52-engine-step') } catch { engineRejected = true }
    check('engine.step 越界异常仍向调用方抛错', engineRejected)
    check('engine.step 越界异常 durable 记录 run_step_failed', engineUpdates.some((patch) => patch.status === 'failed' && patch.errorCode === 'run_step_failed'), JSON.stringify(engineUpdates))

    // The same guard applies to a direct resume/step rejection: preserve a
    // deliberate waiting_user or recovery_required state.
    for (const protectedStatus of ['waiting_user', 'recovery_required']) {
      let protectedRun: Record<string, unknown> = {
        runId: `r52-engine-${protectedStatus}`, sessionId: `r52-${protectedStatus}`, status: 'queued', phase: 'queued',
        startedAt: Date.now(), updatedAt: Date.now(), configJson: '{}'
      }
      let protectedReads = 0
      const protectedUpdates: Array<Record<string, unknown>> = []
      const protectedStore = {
        getRunEvidence: async () => null,
        saveRunEvidence: async () => undefined,
        getRun: async () => protectedRun,
        getTurns: async () => {
          protectedReads += 1
          if (protectedReads === 1) return []
          throw new Error('protected state probe')
        },
        updateRun: async (_id: string, patch: Record<string, unknown>) => {
          protectedUpdates.push(patch)
          protectedRun = { ...protectedRun, ...patch }
        }
      }
      const protectedEngine = createAgentRunEngine({
        store: protectedStore,
        modelCall: async () => { throw new Error('model should not be called') },
        toolExecutor: async () => '',
        getConfig: () => ({}), onEvent: () => undefined, onRunUpdate: () => undefined
      })
      await protectedEngine.start({ sessionId: String(protectedRun.sessionId), runId: String(protectedRun.runId), config: {}, alreadyCreated: true })
      protectedRun.status = protectedStatus
      protectedRun.phase = protectedStatus === 'waiting_user' ? 'paused' : protectedStatus
      let protectedRejected = false
      try { await protectedEngine.step(String(protectedRun.runId)) } catch { protectedRejected = true }
      check(`engine.step 保留 ${protectedStatus}`, protectedRejected && protectedRun.status === protectedStatus && !protectedUpdates.some((patch) => patch.status === 'failed'), JSON.stringify({ run: protectedRun, updates: protectedUpdates }))
    }
  } finally {
    repo?.close()
    await fsp.rm(tmp, { recursive: true, force: true })
  }
  console.log(`\n===== R52 reliability：${passed} PASS / ${failed} FAIL =====`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('R52 reliability 执行异常：', error)
  process.exit(2)
})
