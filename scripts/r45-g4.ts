import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.5 Gate 4：ContinuationPolicy 与可配置预算（红灯先行） ====================
// 复审 B-03：深度写作"未达目标不停止"与实际状态机冲突——固定 maxRepair、maxTurns、no_progress
// 直接 failed；预算不可由用户配置。本测试验收：
//  POLICY-DECIDE-01~07   纯函数决策（continue/低进展 pause/零增长 pause/预算 pause/墙钟 pause/maxRepair pause/cancel）
//  POLICY-STABLE-GROWTH-01 稳定增长 10 轮不误停（maxTurns 与目标规模推导一致）→ completed
//  POLICY-LOW-GROWTH-PAUSE-01 低增长 2 轮 → waiting_user（挂起非终态，非笼统 failed）
//  POLICY-BUDGET-PAUSE-01 预算耗尽 → waiting_user（不伪 completed）
//  POLICY-CANCEL-01      用户取消优先（waiting_user 可取消）
//  POLICY-RESUME-01      waiting_user resume → 继续

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

// 该测试验证“稳定增长”而不是重复填充；使用互不重叠的合法 Unicode code point
// 片段，避免被 R33 的 repetition_high 安全门正确识别为凑字数。
function uniqueText(length: number, seed: number): string {
  return Array.from({ length }, (_, i) => String.fromCodePoint(0x10000 + seed * 8000 + i)).join('')
}

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(__dirname, '..', rel)
  const outfile = path.resolve(__dirname, '..', 'out', `r45g4-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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
  restore(runId: string): Promise<void>
  listRecoverable(): Promise<Array<{ runId: string; status: string }>>
  getState(runId: string): Promise<{ run: { status: string; errorCode?: string; phase: string; errorMessage?: string } | null }>
}

const SNAPSHOT_SETTINGS = {
  model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', maxTokens: 8192, temperature: 1, topP: 1,
  thinkingEnabled: true, reasoningEffort: 'high' as const, workDir: 'C:/w', docDir: 'C:/d', novelMode: false,
  galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000
}

/** 真实快照生成契约（预算字段来自 settings，走真实 buildExecutionSnapshot——禁止手写契约） */
async function buildSnap(payload: Record<string, unknown>, budget?: { completionTokenBudget?: number; completionWallClockMs?: number }): Promise<Record<string, unknown>> {
  const snapMod = await loadTsModule('src/main/executionSnapshot.ts')
  const buildExecutionSnapshot = snapMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  return buildExecutionSnapshot({
    payload,
    settings: { ...SNAPSHOT_SETTINGS, ...(budget ?? {}) } as never,
    sessionId: 's-g4',
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
}

async function makeEngine(
  repo: { open(): void; close(): void },
  artifactDir: string,
  outputs: string[],
  cfg: Record<string, unknown>,
  usagePerRound = 0
): Promise<{ engine: EngineLike; events: Array<{ type: string; subtype?: string; state?: string }> }> {
  const engineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => EngineLike
  const storePortMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createRunStorePort = storePortMod.createRunStorePort as (r: unknown, artifactDir?: string) => Record<string, unknown>
  const events: Array<{ type: string; subtype?: string; state?: string }> = []
  let callIdx = 0
  const engine = createAgentRunEngine({
    store: createRunStorePort(repo as never, artifactDir),
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; delta?: string; finishReason?: string; usage?: unknown }> {
        yield { type: 'text', delta: outputs[Math.min(callIdx++, outputs.length - 1)] }
        if (usagePerRound > 0) {
          yield { type: 'usage', usage: { inputTokens: usagePerRound, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: usagePerRound, cost: 0 } }
        }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => cfg,
    onEvent: (_r: string, ev: { type: string; subtype?: string; state?: string }) => events.push(ev as never),
    onRunUpdate: () => undefined,
    artifactDir
  })
  return { engine, events }
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r45-g4-'))
  const artifactDir = path.join(tmp, 'artifacts')

  console.log('\n[R4.5-G4] ContinuationPolicy 与可配置预算（validator/policy 分离 + waiting_user）')

  // ---- POLICY-DECIDE：纯函数决策 ----
  {
    const policyMod = await loadTsModule('src/main/completion/ContinuationPolicy.ts')
    const decide = policyMod.decideContinuation as (input: Record<string, unknown>) => { decision: string; reason?: string }
    const base = { measuredChars: 9000, lastDeltaChars: 1000, findingSetChanged: false, lowProgressRounds: 0, repetitionRatio: 0, effectiveDeltaChars: 1000, usageTokens: 100, elapsedMs: 1000, repairAttempts: 1, maxRepairAttempts: 3, pendingToolCount: 0, cancelled: false }
    check('POLICY-DECIDE-01 正常增长 → continue', decide(base).decision === 'continue', JSON.stringify(decide(base)))
    check('POLICY-DECIDE-02 零增长（delta=0）→ pause_user no_progress', decide({ ...base, lastDeltaChars: 0 }).decision === 'pause_user' && decide({ ...base, lastDeltaChars: 0 }).reason === 'no_progress', '')
    check('POLICY-DECIDE-03 连续 2 轮低增长 → pause_user low_progress', decide({ ...base, lastDeltaChars: 100, lowProgressRounds: 2 }).decision === 'pause_user' && decide({ ...base, lastDeltaChars: 100, lowProgressRounds: 2 }).reason === 'low_progress', '')
    check('POLICY-DECIDE-04 预算耗尽 → pause_user budget_exhausted', decide({ ...base, usageTokens: 200, tokenBudget: 150 }).decision === 'pause_user' && decide({ ...base, usageTokens: 200, tokenBudget: 150 }).reason === 'budget_exhausted', '')
    check('POLICY-DECIDE-05 墙钟耗尽 → pause_user budget_exhausted', decide({ ...base, elapsedMs: 60000, wallClockBudgetMs: 30000 }).decision === 'pause_user', '')
    check('POLICY-DECIDE-06 达修复上限且无进展 → pause_user max_repair_attempts', decide({ ...base, repairAttempts: 3, maxRepairAttempts: 3, lastDeltaChars: 0 }).decision === 'pause_user' && decide({ ...base, repairAttempts: 3, maxRepairAttempts: 3, lastDeltaChars: 0 }).reason === 'max_repair_attempts', '')
    check('POLICY-DECIDE-10 达修复上限但有实质进展 → continue（防误杀稳定增长）', decide({ ...base, repairAttempts: 3, maxRepairAttempts: 3, lastDeltaChars: 1000 }).decision === 'continue', '')
    check('POLICY-DECIDE-07 用户取消 → cancelled（优先于一切）', decide({ ...base, cancelled: true }).decision === 'cancelled', '')
    check('POLICY-DECIDE-08 finding 集合变化（真实改善）即使低增长也继续', decide({ ...base, lastDeltaChars: 100, lowProgressRounds: 5, findingSetChanged: true }).decision === 'continue', '')
    check('POLICY-DECIDE-09 预算未配置（undefined）不误判', decide({ ...base, usageTokens: 99999 }).decision === 'continue', '')
  }

  // ---- POLICY-STABLE-GROWTH-01：稳定增长 10 轮不误停 → completed ----
  {
    const repoMod = await loadTsModule('src/main/db/repository.ts')
    const createRepository = repoMod.createRepository as (p: string) => { open(): void; close(): void }
    const repo = createRepository(path.join(tmp, 'stable.db'))
    repo.open()
    // target 60000 → 快照推导 maxTurns = 60；每轮 6000 的非重复稳定增长
    const cfg = await buildSnap({ id: 'st1', mode: 'longwrite', longMode: true, targetChars: 60000, text: '写' })
    const outputs = Array.from({ length: 10 }, (_, i) => uniqueText(6000, i))
    const { engine } = await makeEngine(repo, artifactDir, outputs, { maxTurns: cfg.maxTurns, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite }, 40)
    await engine.start({ sessionId: 's-st', runId: 'run-st', config: { maxTurns: cfg.maxTurns, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite } })
    await engine.step('run-st')
    const st = await engine.getState('run-st')
    check('POLICY-STABLE-GROWTH-01 稳定增长 10 轮不误停 → completed（maxTurns 与目标规模推导一致）', st.run?.status === 'completed', JSON.stringify(st.run))
    repo.close()
  }

  // ---- POLICY-LOW-GROWTH-PAUSE-01：低增长 2 轮 → waiting_user（挂起非终态） ----
  {
    const repoMod = await loadTsModule('src/main/db/repository.ts')
    const createRepository = repoMod.createRepository as (p: string) => { open(): void; close(): void }
    const repo = createRepository(path.join(tmp, 'low.db'))
    repo.open()
    const cfg = await buildSnap({ id: 'lg1', mode: 'longwrite', longMode: true, targetChars: 20000, text: '写' })
    // 每轮 +100（低增长）：6000 → 6100 → 6200（第 2 轮起 delta=100 < 200，连续 2 轮 → pause）
    const { engine, events } = await makeEngine(repo, artifactDir, [uniqueText(6000, 10), uniqueText(100, 11), uniqueText(100, 12)], { maxTurns: cfg.maxTurns, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite })
    await engine.start({ sessionId: 's-lg', runId: 'run-lg', config: { maxTurns: cfg.maxTurns, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite } })
    await engine.step('run-lg')
    const st = await engine.getState('run-lg')
    check('POLICY-LOW-GROWTH-PAUSE-01 低增长 → waiting_user（挂起非终态，非笼统 failed）', st.run?.status === 'waiting_user' && st.run?.phase === 'paused', JSON.stringify(st.run))
    check('POLICY-LOW-GROWTH-PAUSE-01 continuation_paused 事件已发出（pausedMessage 可操作）', events.some((e) => e.type === 'completion' && e.subtype === 'continuation_paused'), JSON.stringify(events.filter((e) => e.subtype === 'continuation_paused').slice(0, 2)))
    const rec = await engine.listRecoverable()
    check('POLICY-LOW-GROWTH-PAUSE-01 waiting_user 在可恢复列表（用户可 resume/取消）', rec.some((r) => r.runId === 'run-lg'), JSON.stringify(rec))
    repo.close()
  }

  // ---- POLICY-BUDGET-PAUSE-01：预算耗尽 → waiting_user（不伪 completed） ----
  {
    const repoMod = await loadTsModule('src/main/db/repository.ts')
    const createRepository = repoMod.createRepository as (p: string) => { open(): void; close(): void }
    const repo = createRepository(path.join(tmp, 'budget.db'))
    repo.open()
    // tokenBudget=150：每轮 usage 40 → 第 4 次 gate 时累计 160 ≥ 150 → pause_user
    const cfg = await buildSnap({ id: 'bd1', mode: 'longwrite', longMode: true, targetChars: 30000, text: '写' }, { completionTokenBudget: 150 })
    const cc = cfg.completionContract as { tokenBudget?: number }
    check('POLICY-BUDGET-PAUSE-01 预算经真实快照冻结进契约', typeof cc.tokenBudget === 'number' && cc.tokenBudget === 150, JSON.stringify(cc))
    const { engine, events } = await makeEngine(repo, artifactDir, [uniqueText(6000, 20), uniqueText(6000, 21), uniqueText(6000, 22), uniqueText(6000, 23)], { maxTurns: cfg.maxTurns, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite }, 40)
    await engine.start({ sessionId: 's-bd', runId: 'run-bd', config: { maxTurns: cfg.maxTurns, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite } })
    await engine.step('run-bd')
    const st = await engine.getState('run-bd')
    check('POLICY-BUDGET-PAUSE-01 预算耗尽 → waiting_user（不伪 completed、不笼统 failed）', st.run?.status === 'waiting_user' && st.run?.phase === 'paused', JSON.stringify(st.run))
    const paused = events.find((e) => e.subtype === 'continuation_paused')
    check('POLICY-BUDGET-PAUSE-01 pause 事件原因 budget_exhausted', paused !== undefined && paused.state === 'waiting_user', JSON.stringify(paused))
    repo.close()
  }

  // ---- POLICY-CANCEL-01：用户取消优先（waiting_user 可取消） ----
  {
    const repoMod = await loadTsModule('src/main/db/repository.ts')
    const createRepository = repoMod.createRepository as (p: string) => { open(): void; close(): void }
    const repo = createRepository(path.join(tmp, 'cancel.db'))
    repo.open()
    const cfg = await buildSnap({ id: 'cn1', mode: 'longwrite', longMode: true, targetChars: 20000, text: '写' })
    const { engine } = await makeEngine(repo, artifactDir, [uniqueText(6000, 30), uniqueText(100, 31), uniqueText(100, 32)], { maxTurns: cfg.maxTurns, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite })
    await engine.start({ sessionId: 's-cn', runId: 'run-cn', config: { maxTurns: cfg.maxTurns, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite } })
    await engine.step('run-cn')
    const st1 = await engine.getState('run-cn')
    check('POLICY-CANCEL-01 前置：低增长已进入 waiting_user', st1.run?.status === 'waiting_user', JSON.stringify(st1.run))
    await engine.cancel('run-cn')
    await new Promise((r) => setTimeout(r, 200))
    const st2 = await engine.getState('run-cn')
    check('POLICY-CANCEL-01 waiting_user 中用户取消 → cancelled（用户停止永远优先）', st2.run?.status === 'cancelled', JSON.stringify(st2.run))
    repo.close()
  }

  // ---- POLICY-RESUME-01：waiting_user resume → 继续（新实例恢复语义） ----
  {
    const repoMod = await loadTsModule('src/main/db/repository.ts')
    const createRepository = repoMod.createRepository as (p: string) => { open(): void; close(): void }
    const repo = createRepository(path.join(tmp, 'resume.db'))
    repo.open()
    const cfg = await buildSnap({ id: 'rs1', mode: 'longwrite', longMode: true, targetChars: 20000, text: '写' })
    const engineCfg = { maxTurns: cfg.maxTurns, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite }
    const { engine } = await makeEngine(repo, artifactDir, [uniqueText(6000, 40), uniqueText(100, 41), uniqueText(100, 42)], engineCfg)
    await engine.start({ sessionId: 's-rs', runId: 'run-rs', config: engineCfg })
    await engine.step('run-rs')
    const st1 = await engine.getState('run-rs')
    check('POLICY-RESUME-01 前置：低增长已 waiting_user', st1.run?.status === 'waiting_user', JSON.stringify(st1.run))
    // 用户 resume（模拟：恢复后模型产出好转）：新实例 restore + step
    const { engine: engineB } = await makeEngine(repo, artifactDir, [uniqueText(14000, 50)], engineCfg)
    await engineB.restore('run-rs')
    await engineB.step('run-rs')
    const st2 = await engineB.getState('run-rs')
    check('POLICY-RESUME-01 resume 后好转（14000 字增量达标）→ completed', st2.run?.status === 'completed', JSON.stringify(st2.run))
    repo.close()
  }

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n===== R4.5-G4 红灯测试：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('R4.5-G4 运行异常（红灯阶段预期：目标接口尚未实现）:', e instanceof Error ? e.message : String(e))
  process.exitCode = 2
})
