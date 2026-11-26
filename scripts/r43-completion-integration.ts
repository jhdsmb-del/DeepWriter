import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.3 Gate 4 集成红灯回归：completed 只能由 CompletionController 产生 ====================
// 复审 S-03：模型 finish stop 直接 completed，无外部完成契约。本测试证明（engine 集成层）：
//  1) COMPLETE-ENGINE-01：目标 10000 字、模型输出 8000 字自称完成 → run 不 completed（继续 + 缺口注入）；
//     补足到达标 → completed；
//  2) COMPLETE-ENGINE-02：一轮达标 → completed（契约判定，非模型自述）；
//  3) COMPLETE-ENGINE-03：连续无进展（每轮 8000）→ 单调性判定 blocked → run failed(completion_blocked)；
//  4) COMPLETE-CANCEL-01：继续中用户取消 → cancelled（用户停止优先于"不达字数不停止"）。
// 运行：npx esbuild scripts/r43-completion-integration.ts --bundle --format=esm --platform=node --outfile=out/r43-ci.mjs && node out/r43-ci.mjs

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(__dirname, '..', rel)
  const outfile = path.resolve(__dirname, '..', 'out', `r42mod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: true,
      outfile,
      external: desktopSourceExternals(abs, ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite']),
      logLevel: 'silent',
      plugins: [
        {
          name: 'electron-shim',
          setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
            build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
            build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
              contents: [
                'export const app = { getPath: (n) => String(n), isPackaged: false };',
                'export const dialog = { showMessageBox: async () => ({ response: 1 }) };',
                'export const ipcMain = { handle: () => undefined, on: () => undefined };',
                'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => null, decryptString: () => "" };',
                'export const shell = { openExternal: () => undefined, openPath: async () => "" };',
                'export const clipboard = { writeText: () => undefined };',
                'export const Menu = { buildFromTemplate: (t) => ({ popup: () => undefined, template: t }) };'
              ].join('\n'),
              loader: 'js'
            }))
          }
        }
      ]
    })
    const mod = await import(url.pathToFileURL(outfile).href)
    return mod as Record<string, unknown>
  } finally {
    try {
      await fs.promises.unlink(outfile)
    } catch {
      /* 清理失败忽略 */
    }
  }
}

interface EngineLike {
  start(input: Record<string, unknown>): Promise<{ ok: boolean }>
  step(runId: string): Promise<void>
  cancel(runId: string): Promise<void>
  getState(runId: string): Promise<{ run: { status: string; errorCode?: string; phase: string } | null; turns: Array<{ role: string; content: string }> }>
}

async function makeEngine(repo: { open(): void; close(): void }, artifactDir: string, outputs: string[], delayMs = 0, cfgOverride?: Record<string, unknown>): Promise<{ engine: EngineLike; events: Array<{ type: string; state?: string }> }> {
  const engineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => EngineLike
  const storePortMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createRunStorePort = storePortMod.createRunStorePort as (r: unknown, artifactDir?: string) => Record<string, unknown>
  const events: Array<{ type: string; state?: string }> = []
  let callIdx = 0
  const engineCfg = { ...(await makeRealLongConfig()), maxTurns: 8 }
  const engine = createAgentRunEngine({
    store: createRunStorePort(repo as never, artifactDir),
    modelCall: async () => {
      const content = outputs[Math.min(callIdx++, outputs.length - 1)]
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; delta?: string; finishReason?: string }> {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
          yield { type: 'text', delta: content }
          yield { type: 'finish', finishReason: 'stop' }
        }
      }
    },
    toolExecutor: async () => '',
    getConfig: () => cfgOverride ?? engineCfg,
    onEvent: (_r: string, ev: { type: string; state?: string }) => events.push(ev as never),
    onRunUpdate: () => undefined,
    artifactDir
  })
  return { engine, events }
}

const SNAPSHOT_SETTINGS = {
  model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', maxTokens: 8192, temperature: 1, topP: 1,
  thinkingEnabled: true, reasoningEffort: 'high' as const, workDir: 'C:/w', docDir: 'C:/d', novelMode: false,
  galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000
}

/** R4.4 Gate 1（COMP-CONTRACT-DRIFT-01）：契约必须由真实 buildExecutionSnapshot 生成（禁止手写） */
async function makeRealLongConfig(): Promise<Record<string, unknown>> {
  const snapMod = await loadTsModule('src/main/executionSnapshot.ts')
  const buildExecutionSnapshot = snapMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  const snap = buildExecutionSnapshot({
    payload: { id: 'req-drift', mode: 'longwrite', longMode: true, targetChars: 10000 },
    settings: SNAPSHOT_SETTINGS as never,
    sessionId: 's-drift',
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  return { maxTurns: 8, completionContract: snap.completionContract, strongConstraints: snap.strongConstraints }
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r43-ci-'))
  const artifactDir = path.join(tmp, 'artifacts')

  console.log('\n[R4.3-G4 集成] COMPLETE-ENGINE-01/02/03 + COMPLETE-CANCEL-01（completed 只由契约产生）')
  const lintMod = await loadTsModule('src/main/completion/validators/renpyLint.ts')
  const validateRenpyLint = lintMod.validateRenpyLint as (evidence: Record<string, unknown>) => Array<{ code: string }>
  const repoMod = await loadTsModule('src/main/db/repository.ts')
  const createRepository = repoMod.createRepository as (p: string) => {
    open(): void
    close(): void
    getLatestCompletionEvaluation(runId: string): { revision: number; state: string } | null
    getTurnsByRun(runId: string): Array<{ role: string; content: string }>
  }

  // ---- COMPLETE-ENGINE-01：8000 字自称完成 → 不 completed（继续+缺口）；补足 → completed ----
  {
    const repo = createRepository(path.join(tmp, 'ci1.db'))
    repo.open()
    const outputs = ['x'.repeat(8000), 'y'.repeat(10000)]
    const { engine, events } = await makeEngine(repo, artifactDir, outputs)
    await engine.start({ sessionId: 's-ci1', runId: 'run-ci1', config: await makeRealLongConfig() })
    await engine.step('run-ci1')
    const st1 = await engine.getState('run-ci1')
    check('COMPLETE-ENGINE-01 8000 字（<9500）被完成门拦截（completion continuing 事件发出）', events.some((e) => e.type === 'completion' && e.state === 'continuing'), JSON.stringify(events.filter((e) => e.type === 'completion')))
    check('COMPLETE-ENGINE-01 续作缺口已注入（system turn 含完成校验未通过）', st1.turns.some((t) => t.role === 'system' && t.content.includes('完成校验未通过')), JSON.stringify(st1.turns.map((t) => t.role)))
    const ev1 = repo.getLatestCompletionEvaluation('run-ci1')
    check('COMPLETE-ENGINE-01 评估已 durable 落库（revision>=2：validating+completed）', ev1 !== null && ev1.revision >= 2, JSON.stringify(ev1))
    check('COMPLETE-ENGINE-01 补足到 10000 字后 → completed（契约判定，非模型自述）', st1.run?.status === 'completed', JSON.stringify(st1.run))
    repo.close()
  }

  // ---- COMPLETE-ENGINE-02：一轮达标直接 completed ----
  {
    const repo = createRepository(path.join(tmp, 'ci2.db'))
    repo.open()
    const outputs = ['z'.repeat(12000)]
    const { engine, events: events2 } = await makeEngine(repo, artifactDir, outputs)
    await engine.start({ sessionId: 's-ci2', runId: 'run-ci2', config: await makeRealLongConfig() })
    await engine.step('run-ci2')
    const st2 = await engine.getState('run-ci2')
    check('COMPLETE-ENGINE-02 一轮 12000 字达标 → completed（非模型自述，契约校验通过）', st2.run?.status === 'completed', JSON.stringify(st2.run))
    check('COMPLETE-ENGINE-02 一轮达标无续作事件（无多余轮次）', !events2.some((e) => e.type === 'completion' && e.state === 'continuing'), '')
    repo.close()
  }

  // ---- COMPLETE-ENGINE-03：连续无进展 → pause_user（R4.5 Gate 4：不笼统 failed，等用户决策） ----
  {
    const repo = createRepository(path.join(tmp, 'ci3.db'))
    repo.open()
    const outputs = ['x'.repeat(8000), '', '']  // 续作轮 0 增量 → 累计不变 → 单调性判定 pause_user
    const { engine } = await makeEngine(repo, artifactDir, outputs)
    await engine.start({ sessionId: 's-ci3', runId: 'run-ci3', config: await makeRealLongConfig() })
    await engine.step('run-ci3')
    const st3 = await engine.getState('run-ci3')
    check('COMPLETE-ENGINE-03 连续同量输出 → waiting_user（pause_user：无进展不无限循环，等用户决策非笼统 failed）', st3.run?.status === 'waiting_user' && st3.run?.phase === 'paused', JSON.stringify(st3.run))
    const ev3 = repo.getLatestCompletionEvaluation('run-ci3')
    check('COMPLETE-ENGINE-03 pause 评估已落库（state=waiting_user）', ev3 !== null && ev3.state === 'waiting_user', JSON.stringify(ev3))
    repo.close()
  }

  // ---- COMPLETE-CANCEL-01：继续中用户取消 → cancelled（用户停止优先） ----
  {
    const repo = createRepository(path.join(tmp, 'ci4.db'))
    repo.open()
    const outputs = ['x'.repeat(8000), '']
    const { engine } = await makeEngine(repo, artifactDir, outputs, 200)
    await engine.start({ sessionId: 's-ci4', runId: 'run-ci4', config: await makeRealLongConfig() })
    const stepP = engine.step('run-ci4')
    await new Promise((r) => setTimeout(r, 50)) // 第一轮流式延迟中取消（用户停止优先）
    await engine.cancel('run-ci4')
    await stepP.catch(() => undefined)
    const st4 = await engine.getState('run-ci4')
    check('COMPLETE-CANCEL-01 继续中用户取消 → cancelled（不达字数不停止不覆盖用户意图）', st4.run?.status === 'cancelled', JSON.stringify(st4.run))
    repo.close()
  }

  console.log('\n[R4.4-G1] COMP-PROD-LONGWRITE-ARTIFACT-01 / COMP-PROD-GALGAME-LINT-01 / COMP-CONTRACT-DRIFT-01')
  {
    const snapMod = await loadTsModule('src/main/executionSnapshot.ts')
    const buildExecutionSnapshot = snapMod.buildExecutionSnapshot as (input: Record<string, unknown>) => { completionContract: { validators: Array<{ id: string }>; requiredArtifacts?: unknown } | null }
    const driftSnap = buildExecutionSnapshot({
      payload: { id: 'req-drift', mode: 'longwrite', longMode: true, targetChars: 10000 },
      settings: SNAPSHOT_SETTINGS as never,
      sessionId: 's-drift',
      memory: { projectPath: '', projectContent: '', userContent: '' }
    })
    const driftContract = driftSnap.completionContract
    check('COMP-CONTRACT-DRIFT-01 生产长文契约不要求不存在的 novel artifact（B-01）', driftContract !== null && !('requiredArtifacts' in driftContract), JSON.stringify(driftContract))
    check('COMP-CONTRACT-DRIFT-01 生产长文契约含 targetChars+noPendingTools（与实现字节一致）', Array.isArray(driftContract?.validators) && driftContract.validators.some((v) => v.id === 'targetChars') && driftContract.validators.some((v) => v.id === 'noPendingTools') && !driftContract.validators.some((v) => v.id === 'requiredArtifacts'), JSON.stringify(driftContract?.validators))

    // COMP-PROD-LONGWRITE-ARTIFACT-01：真实引擎 + 真实快照契约 → 达标 completed（不再因 novel 永久 blocked）
    const lRepo = createRepository(path.join(tmp, 'prod-lw.db'))
    lRepo.open()
    const cfg = await makeRealLongConfig()
    const { engine: lwEngine } = await makeEngine(lRepo, artifactDir, ['x'.repeat(12000)])
    await lwEngine.start({ sessionId: 's-prod-lw', runId: 'run-prod-lw', config: cfg })
    await lwEngine.step('run-prod-lw')
    const lwSt = await lwEngine.getState('run-prod-lw')
    check('COMP-PROD-LONGWRITE-ARTIFACT-01 真实长文契约：达标 → completed（不因缺 novel artifact 阻塞）', lwSt.run?.status === 'completed', JSON.stringify(lwSt.run))
    lRepo.close()

    // COMP-PROD-GALGAME-LINT-01：galgame 契约 lint evidence 闭环
    const gRepo = createRepository(path.join(tmp, 'prod-gg.db'))
    gRepo.open()
    const ggSnap = buildExecutionSnapshot({
      payload: { id: 'req-gg', mode: 'galgame' },
      settings: SNAPSHOT_SETTINGS as never,
      sessionId: 's-gg',
      memory: { projectPath: '', projectContent: '', userContent: '' }
    })
    // R4.5 Gate 1（B-01 修复）：契约 fail-closed——galgame 必须要求 renpy 产物；无产物不许 completed
    check('COMP-PROD-GALGAME-LINT-01 生产 galgame 契约含 renpyLint+requiredArtifacts+noPendingTools', ggSnap.completionContract !== null && ggSnap.completionContract.validators.some((v) => v.id === 'renpyLint') && ggSnap.completionContract.validators.some((v) => v.id === 'noPendingTools') && (ggSnap.completionContract.requiredArtifacts as Array<{ kind: string; minCount?: number }> | undefined)?.some((a) => a.kind === 'renpy' && (a.minCount ?? 0) >= 1), JSON.stringify(ggSnap.completionContract?.validators))
    const ggCfg = { maxTurns: 4, completionContract: ggSnap.completionContract }
    // 无 renpy 产物（纯聊天输出）→ fail-closed blocked（不允许跳过 lint 完成）
    const { engine: ggEngine } = await makeEngine(gRepo, artifactDir, ['z'.repeat(300), 'z'.repeat(300), 'z'.repeat(300)], 0, ggCfg)
    await ggEngine.start({ sessionId: 's-gg2', runId: 'run-gg2', config: ggCfg })
    await ggEngine.step('run-gg2')
    const ggSt = await ggEngine.getState('run-gg2')
    check('COMP-PROD-GALGAME-LINT-01 无 renpy 产物 → 完成门不 completed（fail-closed：无产物不许 completed）', ggSt.run?.status !== 'completed', JSON.stringify(ggSt.run))
    gRepo.close()

    // 有 renpy artifact 无 evidence → lint_not_run；写入 run_evidence（file_hash 匹配）→ 通过；hash 变化 → 失效
    const evRepo = createRepository(path.join(tmp, 'prod-ev.db'))
    evRepo.open()
    const storePortMod2 = await loadTsModule('src/main/runKernelAdapter.ts')
    const createRunStorePort2 = storePortMod2.createRunStorePort as (r: unknown, artifactDir?: string) => { saveArtifact(a: Record<string, unknown>): Promise<void> }
    const sp = createRunStorePort2(evRepo as never, path.join(tmp, 'ev-artifacts'))
    const nowTs = Date.now()
    ;(evRepo as unknown as { createRun(r: Record<string, unknown>): void }).createRun({ run_id: 'run-ev', session_id: 's-ev', status: 'queued', phase: 'queued', started_at: nowTs, updated_at: nowTs, config_json: JSON.stringify(ggCfg), parent_run_id: null, error_code: null, error_message: null, client_request_id: 'run-ev' })
    await sp.saveArtifact({ artifactId: 'h1', runId: 'run-ev', sessionId: 's-ev', artifactType: 'renpy', displayName: 'scene.rpy', relativePath: 'game/scene.rpy', hash: 'file-hash-A', charCount: 100, status: 'completed', createdAt: nowTs })
    // 无 lint evidence → validator 读不到 → lint_not_run
    const noLint = await validateRenpyLint({ measuredChars: 100, artifacts: [{ kind: 'renpy', path: 'game/scene.rpy', hash: 'file-hash-A' }], pendingToolCount: 0, pendingToolNames: [] })
    check('COMP-PROD-GALGAME-LINT-01 有 renpy 产物无 evidence → lint_not_run hard', noLint.some((f) => f.code === 'lint_not_run'), JSON.stringify(noLint))
    // 写入 matching evidence（manifest_hash，R4.5 Gate 1）→ validator 层通过（gate 层比对 hash）
    ;(evRepo as unknown as { saveRunEvidence(runId: string, kind: string, json: string): void }).saveRunEvidence('run-ev', 'renpy_lint', JSON.stringify({ manifest_hash: 'mh-A', sdk_version: 'test', ok: true, errorCount: 0, warningCount: 1, output: 'lint ok' }))
    const withLint = await validateRenpyLint({ measuredChars: 100, artifacts: [{ kind: 'renpy', path: 'game/scene.rpy', hash: 'file-hash-A' }], pendingToolCount: 0, pendingToolNames: [], renpyLint: { ok: true, errorCount: 0, warningCount: 1, output: 'lint ok' } })
    check('COMP-PROD-GALGAME-LINT-01 有效 lint evidence → 校验通过', withLint.length === 0, JSON.stringify(withLint))
    // 源码 hash 变化 → 旧 evidence 失效（engine 层比对 run_evidence.manifest_hash 与当前 artifact manifest）
    // artifact 更新为 file-hash-B（同文件内容变更）→ engine 读 run_evidence(file-hash-A) → 不匹配 → lint_not_run → blocked
    const evEngineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
    const createEvEngine = evEngineMod.createAgentRunEngine as (opts: Record<string, unknown>) => EngineLike
    const evStorePort = createRunStorePort2(evRepo as never, path.join(tmp, 'ev-artifacts'))
    const ggContract = ggSnap.completionContract
    const evEngine = createEvEngine({
      store: evStorePort as never,
      modelCall: async () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; delta?: string; finishReason?: string }> {
          yield { type: 'text', delta: 'y'.repeat(100) }
          yield { type: 'finish', finishReason: 'stop' }
        }
      }),
      toolExecutor: async () => '',
      getConfig: () => ({ maxTurns: 2, completionContract: ggContract }),
      onEvent: () => undefined,
      onRunUpdate: () => undefined,
      artifactDir: path.join(tmp, 'ev-artifacts')
    })
    // run-ev2 预置：renpy artifact(hash-B，内容已变更) + 旧 lint evidence(file-hash-A) → 不匹配即失效
    ;(evRepo as unknown as { createRun(r: Record<string, unknown>): void }).createRun({ run_id: 'run-ev2', session_id: 's-ev2', status: 'queued', phase: 'queued', started_at: Date.now(), updated_at: Date.now(), config_json: JSON.stringify({ maxTurns: 2, completionContract: ggContract }), parent_run_id: null, error_code: null, error_message: null, client_request_id: 'run-ev2' })
    await evStorePort.saveArtifact({ artifactId: 'hB', runId: 'run-ev2', sessionId: 's-ev2', artifactType: 'renpy', displayName: 'scene.rpy', relativePath: 'game/scene.rpy', hash: 'file-hash-B', charCount: 100, status: 'completed', createdAt: Date.now() })
    ;(evRepo as unknown as { saveRunEvidence(runId: string, kind: string, json: string): void }).saveRunEvidence('run-ev2', 'renpy_lint', JSON.stringify({ manifest_hash: 'mh-old-content', sdk_version: 'test', ok: true, errorCount: 0, warningCount: 0, output: 'lint ok' }))
    await evEngine.start({ sessionId: 's-ev2', runId: 'run-ev2', config: { maxTurns: 2, completionContract: ggContract }, alreadyCreated: true })
    await evEngine.step('run-ev2')
    const ev2 = await evEngine.getState('run-ev2')
    check('COMP-PROD-GALGAME-LINT-01 源码 hash 变化 → 旧 lint evidence 失效（lint 校验不通过，不 completed）', ev2.run?.status !== 'completed', JSON.stringify(ev2.run))
    evRepo.close()
  }
  console.log('\n[R4.4-G2] COMP-CONTRACT-DURABLE-01 / COMP-BUDGET-RESTORE-01')
  {
    // COMP-CONTRACT-DURABLE-01：acceptChatStart 同事务写 completion contract（S-02 消除双真相）
    const chatStartMod2 = await loadTsModule('src/main/chatStart.ts')
    const startChatRun2 = chatStartMod2.startChatRun as (deps: Record<string, unknown>, payload: Record<string, unknown>) => Promise<unknown>
    const durRepo = createRepository(path.join(tmp, 'dur.db'))
    durRepo.open()
    const realCfg = await makeRealLongConfig()
    await startChatRun2(
      {
        repository: durRepo,
        runKernel: { start: async () => ({ ok: true }), step: async () => undefined },
        loadSettings: async () => ({ model: 'deepseek-v4-flash', historyBudgetTokens: 60000 }),
        buildConfig: () => realCfg
      },
      { id: 'run-dur', sessionId: 's-dur', text: '长文任务' }
    )
    const storedContract = (durRepo as unknown as { getCompletionContract(runId: string): { run_id: string; version: number; json: string } | null }).getCompletionContract('run-dur')
    check('COMP-CONTRACT-DURABLE-01 契约与 run 同事务落库（版本化权威，非死表）', storedContract !== null && storedContract.version === 1, JSON.stringify(storedContract))
    check('COMP-CONTRACT-DURABLE-01 落库契约与生产快照字节一致（审计可证明 evaluation 对应契约）', storedContract !== null && JSON.stringify(JSON.parse(storedContract.json).validators) === JSON.stringify(realCfg.completionContract.validators), '')
    durRepo.close()

    // COMP-BUDGET-RESTORE-01：恢复后墙钟从评估时间恢复、成本可注入（不因重启重置）
    const compMod2 = await loadTsModule('src/main/completion/CompletionController.ts')
    const CompletionController2 = compMod2.CompletionController as typeof CompletionController
    const budgetStore = (() => {
      let evs: CompletionEvaluation[] = []
      return {
        saveEvaluation: (r: string, ev: CompletionEvaluation) => { evs.push(ev) },
        getLatestEvaluation: () => (evs.length ? evs[evs.length - 1] : null)
      }
    })()
    let wallNow = 1_000_000
    const budgetContract = { schemaVersion: 1, runId: 'r-budget', targetChars: { min: 10000, tolerance: 0.05 }, validators: [{ id: 'targetChars', severity: 'hard', config: {} }], maxRepairAttempts: 3, wallClockBudgetMs: 10000, createdAt: wallNow }
    const a = new CompletionController2({ contract: budgetContract, store: budgetStore, now: () => wallNow })
    a.submitCandidate({ measuredChars: 8000, artifacts: [], pendingToolCount: 0, pendingToolNames: [] })
    wallNow += 2000 // 运行 2s 后"强杀"
    const b = CompletionController2.fromStore({ contract: budgetContract, store: budgetStore, now: () => wallNow }, budgetStore.getLatestEvaluation())
    check('COMP-BUDGET-RESTORE-01 恢复后 revision 从评估继续（1）', b.getRevision() === 1, 'rev=' + b.getRevision())
    b.setAccumulatedCost(1500) // 真实 usage 由 engine 注入（Gate 5）
    check('COMP-BUDGET-RESTORE-01 成本可从外部注入（真实 usage ledger 挂钩点）', b.getAccumulatedCost() === 1500, '')
    // 墙钟预算：恢复起点 = 评估时间（2000ms 已流逝），再走 9000ms → 超预算 blocked
    wallNow += 9000
    const ev2 = b.submitCandidate({ measuredChars: 9000, artifacts: [], pendingToolCount: 0, pendingToolNames: [] })
    const cont = b.requestContinuation()
    check('COMP-BUDGET-RESTORE-01 恢复后墙钟预算从评估时间续算（不再重置→超限 pause_user）', cont.state === 'waiting_user' && cont.blockedReason === 'budget_exhausted', JSON.stringify(cont))
  }
  // ==================== R4.4 补：COMP-BUDGET-RESTORE 集成（restore 后真实 usage 成本恢复，预算不重置） ====================
  console.log('\n[R4.4-G5 补] restore 后 completion token 成本从 usage_log 恢复（预算不因重启重置）')
  {
    const budgetRepo = createRepository(path.join(tmp, 'budget-restore.db'))
    budgetRepo.open()
    const budgetCfg = {
      maxTurns: 4,
      completionContract: {
        schemaVersion: 1,
        runId: 'run-budget-r',
        targetChars: { min: 10000, tolerance: 0.05 },
        validators: [{ id: 'targetChars', severity: 'hard', config: {} }],
        maxRepairAttempts: 3,
        tokenBudget: 2000,
        createdAt: Date.now()
      }
    }
    // 真实引擎 + 真实 usage 事件（每轮 inputTokens=1000）→ 第一轮 8000 字 continuing（usage 已落 usage_log）
    const engineMod3 = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
    const createEngine3 = engineMod3.createAgentRunEngine as (opts: Record<string, unknown>) => EngineLike
    const storePortModBR = await loadTsModule('src/main/runKernelAdapter.ts')
    const createRunStorePortBR = storePortModBR.createRunStorePort as (r: unknown, artifactDir?: string) => Record<string, unknown>
    const sp3 = createRunStorePortBR(budgetRepo as never, path.join(tmp, 'budget-artifacts'))
    const usageRepo = budgetRepo as unknown as { getUsageByRun(runId: string): Array<{ input_tokens: number; output_tokens: number }> }
    let round = 0
    const engineA = createEngine3({
      store: sp3 as never,
      modelCall: async () => {
        round += 1
        const content = round === 1 ? 'x'.repeat(8000) : 'y'.repeat(12000)
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; delta?: string; finishReason?: string; usage?: { inputTokens?: number; outputTokens?: number } }> {
            await new Promise((r) => setTimeout(r, 1500))
            yield { type: 'text', delta: content }
            yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } }
            // 第一轮正常 finish（→ continuing + revision 1 + 注入）；
            // 第二轮不 finish——A 永久挂起（模拟"强杀前"的进行中状态，run 保持 running 非终态）
            if (round === 1) yield { type: 'finish', finishReason: 'stop' }
          }
        }
      },
      toolExecutor: async () => '',
      getConfig: () => budgetCfg,
      onEvent: () => undefined,
      onRunUpdate: () => undefined,
      artifactDir: path.join(tmp, 'budget-artifacts')
    })
    const stepP = engineA.start({ sessionId: 's-br', runId: 'run-br', config: budgetCfg }).then(() => engineA.step('run-br'))
    // 等第一轮 usage 落库（usage_log）且 evaluation revision 1（continuing）
    const budgetDeadline = Date.now() + 10000
    let usageRecorded = false
    let revision1 = false
    while (Date.now() < budgetDeadline) {
      usageRecorded = usageRepo.getUsageByRun('run-br').length > 0
      const latest = (budgetRepo as unknown as { getLatestCompletionEvaluation(r: string): { revision: number } | null }).getLatestCompletionEvaluation('run-br')
      revision1 = latest !== null && latest.revision >= 1
      if (usageRecorded && revision1) break
      await new Promise((r) => setTimeout(r, 200))
    }
    check('COMP-BUDGET-RESTORE 集成 强杀前 usage 已落 usage_log 且 evaluation revision>=1', usageRecorded && revision1, `usage=${usageRecorded} rev=${revision1}`)
    // "强杀"：丢弃 engineA（其第一轮流仍在慢速中；B 用同 repo restore）
    void stepP
    const engineB = createEngine3({
      store: sp3 as never,
      modelCall: async () => {
        round += 1
        const content = '' // 0 增量（累计 8000 未达标）→ requestContinuation → token 预算（恢复 cost 2200>2000 → blocked；若未恢复则 1100<2000 → continuing）
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; delta?: string; finishReason?: string; usage?: { inputTokens?: number; outputTokens?: number } }> {
            yield { type: 'text', delta: content }
            yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } }
            yield { type: 'finish', finishReason: 'stop' }
          }
        }
      },
      toolExecutor: async () => '',
      getConfig: () => budgetCfg,
      onEvent: () => undefined,
      onRunUpdate: () => undefined,
      artifactDir: path.join(tmp, 'budget-artifacts')
    })
    await engineB.restore('run-br')
    await engineB.step('run-br')
    const brSt = await engineB.getState('run-br')
    check('COMP-BUDGET-RESTORE 集成 restore 后 token 预算从 usage_log 恢复（cost 1000>=500 → pause_user 不重置）', brSt.run?.status === 'waiting_user', JSON.stringify(brSt.run))
    budgetRepo.close()
  }
  await fsp.rm(tmp, { recursive: true, force: true })

  // ==================== R4.4 Gate 1：真实契约（COMP-PROD-LONGWRITE-ARTIFACT / COMP-PROD-GALGAME-LINT / COMP-CONTRACT-DRIFT） ====================


  // ==================== R4.4 Gate 2：契约同事务落库 + 恢复不重置预算（COMP-CONTRACT-DURABLE / COMP-BUDGET-RESTORE） ====================



  console.log(`\n===== R4.3-G4 集成红灯回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细（修绿目标）：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.3-G4 集成红灯回归执行异常：', e)
  process.exit(2)
})
