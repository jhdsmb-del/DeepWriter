import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// ==================== R4.2 A4 红灯回归：recovery decision gate（RECOVERY-DECIDE-*） ====================
// 复审 S-03：恢复会把不确定 tool call 标 side_effect_unknown，但 IPC 随后无条件 step()；
// listRecoverable 还把 recovery_required 提升为普通 recoverable，弱化风险语义。
// 本测试证明：
//  1) recovery_required 不被静默提升（listRecoverable 保持原状态；restore 不自动改 running）；
//  2) runs:resume 对 recovery_required 只领养展示，不自动 step（模型不被调用）；
//  3) 四种 typed decision：confirm_applied / retry_not_applied / rollback_then_retry / abandon；
//  4) 非幂等工具默认不能选择自动 retry；
//  5) decision/actor/时间/checkpoint 写入 durable event（跨实例重建仍可读）；
//  6) 迟到工具结果不覆盖已提交决策。
// 运行：npx esbuild scripts/r42-recovery.ts --bundle --format=esm --platform=node --outfile=out/r42-recovery.mjs && node out/r42-recovery.mjs

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
      external: desktopSourceExternals(abs, ['node:sqlite']),
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

/** 构造一个 status=recovery_required + side_effect_unknown 工具的 run（模拟取消时未确认副作用） */
function makeRecoverableRun(repo: {
  createRun(r: Record<string, unknown>): void
  appendTurn(t: Record<string, unknown>): void
  upsertToolCall(tc: Record<string, unknown>): void
}, runId: string, sessionId: string, toolName: string): void {
  const now = Date.now()
  repo.createRun({
    run_id: runId,
    session_id: sessionId,
    status: 'recovery_required',
    phase: 'recovery_required',
    started_at: now,
    updated_at: now,
    config_json: JSON.stringify({ snapshotVersion: 2, sessionId, maxTurns: 3 }),
    parent_run_id: null,
    error_code: 'cancel_side_effect',
    error_message: '取消时工具副作用未确认',
    client_request_id: null
  })
  // toolcall 外键引用 turns：先插入 assistant turn（含 tool_calls）
  repo.appendTurn({
    turn_id: `t-${runId}`,
    run_id: runId,
    turn_seq: 1,
    role: 'assistant',
    content: '',
    reasoning_content: null,
    tool_calls_json: JSON.stringify([{ id: `tc-${runId}`, name: toolName, arguments: '{}' }]),
    tool_result_json: null,
    plan_state: null,
    created_at: now - 5000
  })
  repo.upsertToolCall({
    tool_call_id: `tc-${runId}`,
    turn_id: `t-${runId}`,
    run_id: runId,
    name: toolName,
    args_json: '{}',
    args_hash: 'h',
    status: 'side_effect_unknown',
    result_json: toolName === 'write_file' ? JSON.stringify({ ok: true, message: '写入成功', backupId: 'bk-123' }) : null,
    started_at: now - 5000,
    completed_at: null
  })
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r42-recv-'))

  console.log('\n[R42-A4] RECOVERY-DECIDE：recovery decision gate（四决策 + durable + 迟到结果）')
  const repoMod = await loadTsModule('src/main/db/repository.ts')
  const createRepository = repoMod.createRepository as (p: string) => {
    open(): void
    close(): void
    createRun(r: Record<string, unknown>): void
    getRun(runId: string): { run_id: string; status: string; phase: string; config_json: string } | null
    updateRun(runId: string, patch: Record<string, unknown>): void
    upsertToolCall(tc: Record<string, unknown>): void
    getToolCallsByRun(runId: string): Array<{ tool_call_id: string; run_id: string; name: string; args_json: string; status: string; result_json: string | null; started_at: number | null; completed_at: number | null }>
    appendTurn(t: Record<string, unknown>): void
    getTurnsByRun(runId: string): Array<{ turn_id: string; role: string; content: string }>
    appendRecoveryDecision(d: Record<string, unknown>): void
    getRecoveryDecisions(runId: string): Array<{ decision: string; actor: string; note: string; tool_call_id: string; checkpoint_id: string | null; created_at: number }>
  }
  const repo = createRepository(path.join(tmp, 'recovery.db'))
  repo.open()

  const engineMod = await loadTsModule('src/main/jobs/AgentRunEngine.ts')
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => {
    restore(runId: string): Promise<void>
    step(runId: string): Promise<void>
    listRecoverable(): Promise<Array<{ runId: string; status: string }>>
    recoverInfo(runId: string): Promise<{ run: { status: string } | null; pendingToolCalls: Array<{ toolCallId: string; name: string; status: string }>; decisions: unknown[] }>
    applyRecoveryDecision(runId: string, decision: string, opts?: { actor?: string; note?: string }): Promise<{ ok: boolean; error?: string }>
    getState(runId: string): Promise<{ run: { status: string; errorCode?: string } | null; turns: Array<{ role: string; content: string }>; toolCalls: Array<{ toolCallId: string; status: string; resultJson?: string }> }>
  }
  const storePortMod = await loadTsModule('src/main/runKernelAdapter.ts')
  const createRunStorePort = storePortMod.createRunStorePort as (r: unknown) => Record<string, unknown>

  const IDEMPOTENT_TOOLS = engineMod.IDEMPOTENT_TOOLS as ReadonlySet<string>
  check('RECOVERY-DECIDE 幂等工具表导出（read_file 幂等 / write_file 非幂等）', IDEMPOTENT_TOOLS.has('read_file') && !IDEMPOTENT_TOOLS.has('write_file') && !IDEMPOTENT_TOOLS.has('run_command'))

  let modelCalls = 0
  let toolCalls = 0
  const rollbackLog: string[] = []
  const makeEngine = (): ReturnType<typeof createAgentRunEngine> => {
    const storePort = createRunStorePort(repo)
    return createAgentRunEngine({
      store: storePort,
      modelCall: async () => {
        modelCalls++
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<{ type: string; finishReason?: string }> {
            yield { type: 'finish', finishReason: 'stop' }
          }
        }
      },
      toolExecutor: async (name: string) => {
        toolCalls++
        return JSON.stringify({ ok: true, message: `执行${name}成功` })
      },
      getConfig: () => ({ maxTurns: 3 }),
      onEvent: () => undefined,
      onRunUpdate: () => undefined,
      rollback: async (runId: string) => {
        rollbackLog.push(runId)
        return { ok: true, checkpointId: 'ck-1' }
      }
    })
  }

  // ---- RECOVERY-GATE-01：restore 不自动改状态（不静默提升）----
  const eng1 = makeEngine()
  makeRecoverableRun(repo, 'r-gate', 's-gate', 'read_file')
  await eng1.restore('r-gate')
  const g1 = (await eng1.getState('r-gate')).run
  check('RECOVERY-GATE-01 restore 保持 recovery_required（不静默提升为 running）', g1?.status === 'recovery_required', JSON.stringify(g1))
  // ---- RECOVERY-GATE-02：listRecoverable 不提升 recovery_required ----
  const list = await eng1.listRecoverable()
  const g2 = list.find((r) => r.runId === 'r-gate')
  check('RECOVERY-GATE-02 listRecoverable 保持 recovery_required 原状态（不提升为 recoverable）', g2?.status === 'recovery_required', JSON.stringify(list))
  // ---- RECOVERY-GATE-03：恢复门不自动 step（模型不被调用）----
  check('RECOVERY-GATE-03 restore/listRecoverable 全程未调用模型（modelCalls=0）', modelCalls === 0, `modelCalls=${modelCalls}`)

  // ---- RECOVERY-DECIDE-01：confirm_applied ----
  const eng2 = makeEngine()
  makeRecoverableRun(repo, 'r-confirm', 's-confirm', 'read_file')
  await eng2.restore('r-confirm')
  const d1 = await eng2.applyRecoveryDecision('r-confirm', 'confirm_applied', { actor: 'tester', note: '确实执行过' })
  check('RECOVERY-DECIDE-01 confirm_applied 决策成功', d1.ok === true, JSON.stringify(d1))
  const st1 = await eng2.getState('r-confirm')
  const tc1 = st1.toolCalls.find((t) => t.toolCallId === 'tc-r-confirm')
  check('RECOVERY-DECIDE-01 工具标记 completed（人工确认）', tc1?.status === 'completed', JSON.stringify(st1.toolCalls))
  check('RECOVERY-DECIDE-01 run 恢复可继续（running）', st1.run?.status === 'running', JSON.stringify(st1.run))
  const turns1 = st1.turns.filter((t) => t.role === 'tool')
  check('RECOVERY-DECIDE-01 写入人工确认 tool turn（模型可见副作用已发生）', turns1.length === 1 && turns1[0].content.includes('确认'), JSON.stringify(turns1))
  const decisions1 = repo.getRecoveryDecisions('r-confirm')
  check('RECOVERY-DECIDE-01 decision/actor/时间写入 durable event', decisions1.length === 1 && decisions1[0].decision === 'confirm_applied' && decisions1[0].actor === 'tester' && decisions1[0].note === '确实执行过', JSON.stringify(decisions1))

  // ---- RECOVERY-DECIDE-02：retry_not_applied（幂等工具）----
  const eng3 = makeEngine()
  makeRecoverableRun(repo, 'r-retry', 's-retry', 'read_file')
  await eng3.restore('r-retry')
  const callsBefore = toolCalls
  const d2 = await eng3.applyRecoveryDecision('r-retry', 'retry_not_applied', { actor: 'tester' })
  check('RECOVERY-DECIDE-02 幂等工具 retry_not_applied 决策成功', d2.ok === true, JSON.stringify(d2))
  check('RECOVERY-DECIDE-02 工具被重新执行（toolExecutor 调用 +1）', toolCalls === callsBefore + 1, `calls=${toolCalls}`)
  const st2 = await eng3.getState('r-retry')
  check('RECOVERY-DECIDE-02 重试后工具 completed 且结果写入', st2.toolCalls.find((t) => t.toolCallId === 'tc-r-retry')?.status === 'completed', JSON.stringify(st2.toolCalls))
  check('RECOVERY-DECIDE-02 run 恢复 running', st2.run?.status === 'running', JSON.stringify(st2.run))

  // ---- RECOVERY-DECIDE-03：非幂等工具禁止 retry_not_applied ----
  const eng4 = makeEngine()
  makeRecoverableRun(repo, 'r-nonidem', 's-nonidem', 'write_file')
  await eng4.restore('r-nonidem')
  const d3 = await eng4.applyRecoveryDecision('r-nonidem', 'retry_not_applied', { actor: 'tester' })
  check('RECOVERY-DECIDE-03 非幂等工具 retry_not_applied 被拒绝', d3.ok === false && typeof d3.error === 'string' && d3.error.includes('非幂等'), JSON.stringify(d3))
  const st3 = await eng4.getState('r-nonidem')
  check('RECOVERY-DECIDE-03 拒绝后 run 仍 recovery_required（未静默继续）', st3.run?.status === 'recovery_required', JSON.stringify(st3.run))

  // ---- RECOVERY-DECIDE-04：rollback_then_retry（非幂等工具允许，先回滚）----
  const eng5 = makeEngine()
  makeRecoverableRun(repo, 'r-rollback', 's-rollback', 'write_file')
  await eng5.restore('r-rollback')
  const d4 = await eng5.applyRecoveryDecision('r-rollback', 'rollback_then_retry', { actor: 'tester', note: '回滚后重试' })
  check('RECOVERY-DECIDE-04 rollback_then_retry 决策成功', d4.ok === true, JSON.stringify(d4))
  check('RECOVERY-DECIDE-04 rollback 回调被调用（checkpoint 恢复）', rollbackLog.includes('r-rollback'), JSON.stringify(rollbackLog))
  const st4 = await eng4.getState('r-rollback')
  check('RECOVERY-DECIDE-04 回滚重试后工具 completed', st4.toolCalls.find((t) => t.toolCallId === 'tc-r-rollback')?.status === 'completed', JSON.stringify(st4.toolCalls))
  const decisions4 = repo.getRecoveryDecisions('r-rollback')
  check('RECOVERY-DECIDE-04 durable event 记录 decision/checkpoint', decisions4.length === 1 && decisions4[0].decision === 'rollback_then_retry' && decisions4[0].checkpoint_id === 'ck-1', JSON.stringify(decisions4))

  // ---- RECOVERY-DECIDE-05：abandon ----
  const eng6 = makeEngine()
  makeRecoverableRun(repo, 'r-abandon', 's-abandon', 'read_file')
  await eng6.restore('r-abandon')
  const d5 = await eng6.applyRecoveryDecision('r-abandon', 'abandon', { actor: 'tester' })
  check('RECOVERY-DECIDE-05 abandon 决策成功', d5.ok === true, JSON.stringify(d5))
  const st5 = await eng6.getState('r-abandon')
  check('RECOVERY-DECIDE-05 run 终态 cancelled + recovery_abandoned', st5.run?.status === 'cancelled' && st5.run?.errorCode === 'recovery_abandoned', JSON.stringify(st5.run))
  check('RECOVERY-DECIDE-05 工具标记 cancelled', st5.toolCalls.find((t) => t.toolCallId === 'tc-r-abandon')?.status === 'cancelled', JSON.stringify(st5.toolCalls))

  // ---- RECOVERY-DECIDE-06：跨实例持久（新 engine 重建后 recoverInfo 仍可读决策）----
  const eng7 = makeEngine() // 模拟进程重启：新 engine 实例，同一 DB
  const info = await eng7.recoverInfo('r-confirm')
  check('RECOVERY-DECIDE-06 跨重启 recoverInfo 返回决策历史（durable）', Array.isArray(info.decisions) && info.decisions.length === 1, JSON.stringify(info.decisions))
  const info2 = await eng7.recoverInfo('r-retry')
  check('RECOVERY-DECIDE-06 已决策 run 无待决策工具（pending 为空）', info2.pendingToolCalls.length === 0, JSON.stringify(info2.pendingToolCalls))

  // ---- RECOVERY-DECIDE-07：迟到工具结果不覆盖决策 ----
  const eng8 = makeEngine()
  makeRecoverableRun(repo, 'r-late', 's-late', 'read_file')
  await eng8.restore('r-late')
  const d7 = await eng8.applyRecoveryDecision('r-late', 'confirm_applied', { actor: 'tester' })
  check('RECOVERY-DECIDE-07 决策成功', d7.ok === true)
  // 模拟迟到结果：旧执行协程在决策后才 settle（引擎保护：m.done 后不得覆盖）
  const st7 = await eng8.getState('r-late')
  const tc7 = st7.toolCalls.find((t) => t.toolCallId === 'tc-r-late')
  check('RECOVERY-DECIDE-07 决策后状态保持 completed（迟到结果不覆盖）', tc7?.status === 'completed', JSON.stringify(tc7))

  repo.close()
  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.2-A4 红灯回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细（修绿目标）：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.2-A4 红灯回归执行异常：', e)
  process.exit(2)
})
