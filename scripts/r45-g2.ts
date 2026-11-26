import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.5 Gate 2：角色监护开关真实接线（红灯先行） ====================
// 复审 B-02：开关只改 Zustand 布尔；payload 不带值；快照写死 false；engine 无 orchestrator 调用——
// 用户开启后输出与关闭时完全相同（UX 欺骗）。本测试验收：
//  EXP-PAYLOAD-01        chatStartSchema：longwrite+enabled 通过；galgame+enabled 拒绝；参数上限
//  EXP-SNAPSHOT-01       payload → snapshot 冻结（enabled/maxConcurrent/subagentTokenRatio/characters）；未传默认关
//  EXP-ENGINE-OFF-01     off → experimentRun 零调用
//  EXP-ENGINE-ON-01      on → 每轮调用（round≥2）、建议注入 system、usage 入 ledger、正文唯一主模型
//  EXP-ENGINE-ON-NOCARD-01 on 且无角色卡 → hook 收到空 characters（引擎按快照传）
//  EXP-DEGRADE-01        hook 抛错 → 降级不阻断主链（run 仍 completed）
//  EXP-RESTORE-01        强杀恢复后继续（hook 幂等重跑无副作用——正文唯一作者是主模型）

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
  const outfile = path.resolve(__dirname, '..', 'out', `r45g2-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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
  restore(runId: string): Promise<void>
  getState(runId: string): Promise<{ run: { status: string; errorCode?: string; phase: string } | null }>
}

interface SpyCall {
  round: number
  characters: unknown[]
  draftSoFar: string
}

const SNAPSHOT_SETTINGS = {
  model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', maxTokens: 8192, temperature: 1, topP: 1,
  thinkingEnabled: true, reasoningEffort: 'high' as const, workDir: 'C:/w', docDir: 'C:/d', novelMode: false,
  galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000
}

async function buildSnap(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const snapMod = await loadTsModule('src/main/executionSnapshot.ts')
  const buildExecutionSnapshot = snapMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  return buildExecutionSnapshot({
    payload,
    settings: SNAPSHOT_SETTINGS as never,
    sessionId: 's-exp',
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
}

async function makeEngine(
  repo: { open(): void; close(): void },
  artifactDir: string,
  outputs: string[],
  cfg: Record<string, unknown>,
  experimentRun: ((input: SpyCall & { runId: string; targetChars: number }) => Promise<{ ok: boolean; degraded: boolean; injectedSystemLines: string[]; usage?: { inputTokens: number; outputTokens: number } }>) | undefined
): Promise<{ engine: EngineLike; events: Array<{ type: string; phase?: string; title?: string; state?: string }> }> {
  const engineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => EngineLike
  const storePortMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createRunStorePort = storePortMod.createRunStorePort as (r: unknown, artifactDir?: string) => Record<string, unknown>
  const events: Array<{ type: string; phase?: string; title?: string; state?: string }> = []
  let callIdx = 0
  const engine = createAgentRunEngine({
    store: createRunStorePort(repo as never, artifactDir),
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; delta?: string; finishReason?: string }> {
        yield { type: 'text', delta: outputs[Math.min(callIdx++, outputs.length - 1)] }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => cfg,
    onEvent: (_r: string, ev: { type: string; phase?: string; title?: string; state?: string }) => events.push(ev as never),
    onRunUpdate: () => undefined,
    artifactDir,
    ...(experimentRun ? { experimentRun } : {})
  })
  return { engine, events }
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r45-g2-'))
  const artifactDir = path.join(tmp, 'artifacts')

  console.log('\n[R4.5-G2] 角色监护开关真实接线（payload → snapshot → engine 场景级监护 hook）')

  // ---- EXP-PAYLOAD-01：chatStartSchema 校验（仅 longwrite；安全上限） ----
  {
    const schemasMod = await loadTsModule('src/shared/ipcSchemas.ts')
    const schemas = schemasMod as { chatStartSchema: { safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } } } }
    const okLong = schemas.chatStartSchema.safeParse({
      id: 'r1', mode: 'longwrite', longMode: true, targetChars: 10000, text: '写',
      deepWriteExperiment: { enabled: true, characters: [{ id: 'c1', name: 'A', bible: 'b', knownFacts: ['f1'] }] }
    })
    check('EXP-PAYLOAD-01 longwrite + enabled → schema 通过', okLong.success, JSON.stringify(okLong.error?.issues ?? []))
    const badMode = schemas.chatStartSchema.safeParse({
      id: 'r2', mode: 'galgame', deepWriteExperiment: { enabled: true }
    })
    check('EXP-PAYLOAD-01 galgame + enabled → schema 拒绝（仅长文模式允许）', !badMode.success && (badMode.error?.issues ?? []).some((i) => i.message.includes('仅长文模式')), JSON.stringify(badMode.error?.issues ?? []))
    const overChars = schemas.chatStartSchema.safeParse({
      id: 'r3', mode: 'longwrite', deepWriteExperiment: { enabled: true, characters: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, name: 'A', bible: 'b' })) }
    })
    check('EXP-PAYLOAD-01 characters 超 8 个 → 拒绝（安全上限）', !overChars.success, '')
    const badRatio = schemas.chatStartSchema.safeParse({
      id: 'r4', mode: 'longwrite', deepWriteExperiment: { enabled: true, subagentTokenRatio: 0.9 }
    })
    check('EXP-PAYLOAD-01 subagentTokenRatio 超 0.5 → 拒绝（安全上限）', !badRatio.success, '')
  }

  // ---- EXP-SNAPSHOT-01：payload → snapshot 冻结；未传默认关 ----
  {
    const snapOn = await buildSnap({
      id: 'sn1', mode: 'longwrite', longMode: true, targetChars: 10000,
      deepWriteExperiment: { enabled: true, maxConcurrent: 2, subagentTokenRatio: 0.2, characters: [{ id: 'c1', name: 'A', bible: 'b', knownFacts: ['f1'], forbiddenKnowledge: ['fk'] }] }
    })
    const exp = snapOn.deepWrite as { experiment: { enabled: boolean; maxConcurrent: number; subagentTokenRatio: number; characters: unknown[] } }
    check('EXP-SNAPSHOT-01 payload.enabled=true → snapshot.experiment.enabled=true（不再写死 false）', exp.experiment.enabled === true, JSON.stringify(exp.experiment))
    check('EXP-SNAPSHOT-01 maxConcurrent/subagentTokenRatio 冻结', exp.experiment.maxConcurrent === 2 && exp.experiment.subagentTokenRatio === 0.2, '')
    check('EXP-SNAPSHOT-01 characters 冻结（快照含角色卡）', exp.experiment.characters.length === 1 && (exp.experiment.characters[0] as { id: string }).id === 'c1', '')
    const snapOff = await buildSnap({ id: 'sn2', mode: 'longwrite', longMode: true, targetChars: 10000 })
    const expOff = snapOff.deepWrite as { experiment: { enabled: boolean } }
    check('EXP-SNAPSHOT-01 未传 deepWriteExperiment → 默认关闭（向后兼容）', expOff.experiment.enabled === false, '')
    const snapAg = await buildSnap({ id: 'sn3', mode: 'agent', deepWriteExperiment: { enabled: true } })
    const expAg = snapAg.deepWrite as { experiment: { enabled: boolean } }
    check('EXP-SNAPSHOT-01 非长文 payload 即使带 enabled 也按关闭冻结（schema 已拦，快照双保险）', expAg.experiment.enabled === false, '')
  }

  // ---- EXP-ENGINE-OFF-01：off → experimentRun 零调用 ----
  {
    const repoMod = await loadTsModule('src/main/db/repository.ts')
    const createRepository = repoMod.createRepository as (p: string) => { open(): void; close(): void }
    const repo = createRepository(path.join(tmp, 'off.db'))
    repo.open()
    const cfg = await buildSnap({ id: 'off1', mode: 'longwrite', longMode: true, targetChars: 2000, text: '写' })
    let spyCalls = 0
    const { engine } = await makeEngine(repo, artifactDir, ['x'.repeat(3000)], { maxTurns: 4, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite }, async () => {
      spyCalls++
      return { ok: true, degraded: false, injectedSystemLines: ['[角色监护] test'], usage: { inputTokens: 10, outputTokens: 5 } }
    })
    await engine.start({ sessionId: 's-off', runId: 'run-off', config: { maxTurns: 4, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite } })
    await engine.step('run-off')
    const st = await engine.getState('run-off')
    check('EXP-ENGINE-OFF-01 开关 off → experimentRun 零调用', spyCalls === 0, `spyCalls=${spyCalls}`)
    check('EXP-ENGINE-OFF-01 off 主链正常完成', st.run?.status === 'completed', JSON.stringify(st.run))
    repo.close()
  }

  // ---- EXP-ENGINE-ON-01：on → 每轮调用（round≥2）、建议注入、usage 入 ledger、正文唯一主模型 ----
  {
    const repoMod = await loadTsModule('src/main/db/repository.ts')
    const createRepository = repoMod.createRepository as (p: string) => { open(): void; close(): void; getUsageByRun(runId: string): Array<{ call_type: string }> }
    const repo = createRepository(path.join(tmp, 'on.db'))
    repo.open()
    const cfg = await buildSnap({
      id: 'on1', mode: 'longwrite', longMode: true, targetChars: 10000, text: '写',
      deepWriteExperiment: { enabled: true, characters: [{ id: 'c1', name: 'A', bible: 'b', knownFacts: ['f1'] }] }
    })
    const calls: Array<{ round: number; characters: unknown[]; draftSoFar: string }> = []
    const { engine, events } = await makeEngine(
      repo, artifactDir, ['x'.repeat(6000), 'y'.repeat(5000)],
      { maxTurns: 4, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite, model: 'deepseek-v4-flash' },
      async (input) => {
        calls.push({ round: input.round, characters: input.characters, draftSoFar: input.draftSoFar })
        return { ok: true, degraded: false, injectedSystemLines: ['[角色监护] c1：推进对话；风险：无'], usage: { inputTokens: 40, outputTokens: 20 } }
      }
    )
    await engine.start({ sessionId: 's-on', runId: 'run-on', config: { maxTurns: 4, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite, model: 'deepseek-v4-flash' } })
    await engine.step('run-on')
    const st = await engine.getState('run-on')
    // 第一轮 6000 未达标 → 续作 → 第二轮 5000 累计 11000 ≥ 9500 → completed
    check('EXP-ENGINE-ON-01 开关 on → 监护 hook 被调用（round≥2，续作轮）', calls.length >= 1 && calls[0].round >= 2, JSON.stringify(calls))
    check('EXP-ENGINE-ON-01 hook 收到快照冻结的角色卡', calls.length > 0 && (calls[0].characters as Array<{ id: string }>).some((c) => c.id === 'c1'), JSON.stringify(calls[0]?.characters))
    check('EXP-ENGINE-ON-01 hook 收到当前正文（draftSoFar 非空）', calls.length > 0 && calls[0].draftSoFar.length > 0, `len=${calls[0]?.draftSoFar.length}`)
    check('EXP-ENGINE-ON-01 监护 hook 不产正文（唯一正文作者是主模型）', (calls as Array<{ draftSoFar: string }>).every((c) => !c.draftSoFar.includes('[角色监护]')), '')
    check('EXP-ENGINE-ON-01 角色检查阶段事件已发出（validating + 标题，不泄露角色卡原文）', events.some((e) => e.type === 'phase' && e.phase === 'validating' && e.title === '角色检查中'), JSON.stringify(events.filter((e) => e.phase === 'validating').slice(0, 2)))
    const usageRows = repo.getUsageByRun('run-on')
    check('EXP-ENGINE-ON-01 监护用量计入同一 run usage ledger（deepwrite-custodian）', usageRows.some((u) => u.call_type === 'deepwrite-custodian'), JSON.stringify(usageRows.map((u) => u.call_type)))
    check('EXP-ENGINE-ON-01 on 主链正常完成', st.run?.status === 'completed', JSON.stringify(st.run))
    repo.close()
  }

  // ---- EXP-ENGINE-ON-NOCARD-01：on 但无角色卡 → hook 收到空 characters（降级由 hook 决定） ----
  {
    const repoMod = await loadTsModule('src/main/db/repository.ts')
    const createRepository = repoMod.createRepository as (p: string) => { open(): void; close(): void }
    const repo = createRepository(path.join(tmp, 'noc.db'))
    repo.open()
    const cfg = await buildSnap({ id: 'nc1', mode: 'longwrite', longMode: true, targetChars: 10000, text: '写', deepWriteExperiment: { enabled: true } })
    let charsSeen: unknown[] | null = null
    const { engine } = await makeEngine(repo, artifactDir, ['x'.repeat(6000), 'y'.repeat(5000)], { maxTurns: 4, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite }, async (input) => {
      charsSeen = input.characters
      return { ok: true, degraded: true, injectedSystemLines: [] }
    })
    await engine.start({ sessionId: 's-nc', runId: 'run-nc', config: { maxTurns: 4, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite } })
    await engine.step('run-nc')
    check('EXP-ENGINE-ON-NOCARD-01 开关 on 无角色卡 → hook 收到空 characters（引擎照常调用，降级语义清晰）', charsSeen !== null && Array.isArray(charsSeen) && charsSeen.length === 0, JSON.stringify(charsSeen))
    repo.close()
  }

  // ---- EXP-DEGRADE-01：hook 抛错 → 降级不阻断主链 ----
  {
    const repoMod = await loadTsModule('src/main/db/repository.ts')
    const createRepository = repoMod.createRepository as (p: string) => { open(): void; close(): void }
    const repo = createRepository(path.join(tmp, 'deg.db'))
    repo.open()
    const cfg = await buildSnap({ id: 'dg1', mode: 'longwrite', longMode: true, targetChars: 2000, text: '写', deepWriteExperiment: { enabled: true, characters: [{ id: 'c1', name: 'A', bible: 'b' }] } })
    const { engine } = await makeEngine(repo, artifactDir, ['x'.repeat(3000)], { maxTurns: 4, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite }, async () => {
      throw new Error('custodian 崩溃（模拟模型调用失败）')
    })
    await engine.start({ sessionId: 's-dg', runId: 'run-dg', config: { maxTurns: 4, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite } })
    await engine.step('run-dg')
    const st = await engine.getState('run-dg')
    check('EXP-DEGRADE-01 监护 hook 抛错 → 降级不阻断主链（run 仍 completed）', st.run?.status === 'completed', JSON.stringify(st.run))
    repo.close()
  }

  // ---- EXP-RESTORE-01：强杀恢复后继续（hook 幂等重跑，无重复副作用——正文唯一作者是主模型） ----
  // 模拟进程死亡于第二轮流中：engine A 的第二轮模型流永久挂起（step 不 await）；
  // 丢弃 A（内存态消失，DB 中 run 状态 running）→ engine B restore + step 继续完成。
  {
    const repoMod = await loadTsModule('src/main/db/repository.ts')
    const createRepository = repoMod.createRepository as (p: string) => { open(): void; close(): void }
    const repo = createRepository(path.join(tmp, 'rst.db'))
    repo.open()
    const cfg = await buildSnap({ id: 'rs1', mode: 'longwrite', longMode: true, targetChars: 10000, text: '写', deepWriteExperiment: { enabled: true, characters: [{ id: 'c1', name: 'A', bible: 'b' }] } })
    const engineCfg = { maxTurns: 4, completionContract: cfg.completionContract, deepWrite: cfg.deepWrite }
    const engineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
    const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => EngineLike
    const storePortMod = await loadTsModule('src/main/runKernelAdapter.ts')
    const createRunStorePort = storePortMod.createRunStorePort as (r: unknown, artifactDir?: string) => Record<string, unknown>
    const hook = async (input: { round: number; characters: unknown[]; draftSoFar: string }): Promise<{ ok: boolean; degraded: boolean; injectedSystemLines: string[]; usage: { inputTokens: number; outputTokens: number } }> => {
      // 幂等：每次调用只产建议（无副作用）；恢复后重跑一次无害
      return { ok: true, degraded: false, injectedSystemLines: ['[角色监护] c1：推进'], usage: { inputTokens: 30, outputTokens: 10 } }
    }
    // engine A：第二轮流永久挂起（模拟进程死亡于流中）
    let callIdxA = 0
    const engineA = createAgentRunEngine({
      store: createRunStorePort(repo as never, artifactDir),
      modelCall: async () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; delta?: string; finishReason?: string }> {
          const idx = callIdxA++
          if (idx === 0) {
            yield { type: 'text', delta: 'x'.repeat(6000) }
            yield { type: 'finish', finishReason: 'stop' }
            return
          }
          // 第二轮：永久挂起（模拟流中进程死亡）
          await new Promise(() => undefined)
        }
      }),
      toolExecutor: async () => '',
      getConfig: () => engineCfg,
      onEvent: () => undefined,
      onRunUpdate: () => undefined,
      artifactDir,
      experimentRun: hook
    })
    await engineA.start({ sessionId: 's-rs', runId: 'run-rs', config: engineCfg })
    const stepP = engineA.step('run-rs').catch(() => undefined)
    // 等待第一轮完成、第二轮挂起（run 非终态，DB 状态 running）
    await new Promise((r) => setTimeout(r, 1500))
    // 进程死亡：丢弃 A（内存态消失），用新实例 B 恢复并继续
    const engineB = createAgentRunEngine({
      store: createRunStorePort(repo as never, artifactDir),
      modelCall: async () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; delta?: string; finishReason?: string }> {
          yield { type: 'text', delta: 'y'.repeat(5000) }
          yield { type: 'finish', finishReason: 'stop' }
        }
      }),
      toolExecutor: async () => '',
      getConfig: () => engineCfg,
      onEvent: () => undefined,
      onRunUpdate: () => undefined,
      artifactDir,
      experimentRun: hook
    })
    await engineB.restore('run-rs')
    await engineB.step('run-rs')
    const st2 = await engineB.getState('run-rs')
    check('EXP-RESTORE-01 强杀（流中）后新实例恢复 → 主链继续并完成（无重复正文副作用）', st2.run?.status === 'completed', JSON.stringify(st2.run))
    void stepP
    repo.close()
  }

  console.log(`\n===== R4.5-G2 红灯测试：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('R4.5-G2 运行异常（红灯阶段预期：目标接口尚未实现）:', e instanceof Error ? e.message : String(e))
  process.exitCode = 2
})
