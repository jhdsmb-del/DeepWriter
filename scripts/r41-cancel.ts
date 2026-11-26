// ==================== R4.1 S-04 取消/恢复语义补全回归 ====================
// 覆盖：
//   CANCEL-SLOW-01         协作取消（工具响应 abort）→ cancel_requested → cancelled，无副作用残留
//   CANCEL-UNCOOPERATIVE-01 工具不响应 abort → 5s（可配置 cancelFallbackMs）兜底 → recovery_required，
//                           toolCall 标 side_effect_unknown（不谎称安全取消）
//   RECOVERY-NONIDEMPOTENT-01 recovery_required 的 run 在 listRecoverable 中列出，
//                           但 restore 只恢复状态、不自动重放工具（toolExecutor 不再被调用）
// 运行：npx esbuild scripts/r41-cancel.ts --bundle --format=esm --platform=node --outfile=out/r41c.mjs && node out/r41c.mjs

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { createAgentRunEngine } from '../src/main/jobs/AgentRunEngine'
import type { ModelEvent, RunRecord, RunStorePort, ToolCallRecord, TurnRecord } from '../src/main/jobs/types'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

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

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`等待超时: ${label}`)
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------- 内存 RunStorePort（listActiveRuns 不排除任何状态——等价于
// R4.1 S-04 要求的 store 过滤：cancelling/cancel_requested/recovery_required 均属 active） ----------------

function createMemStore(): RunStorePort & { runs: Map<string, RunRecord>; toolCalls: ToolCallRecord[] } {
  const runs = new Map<string, RunRecord>()
  const turns: TurnRecord[] = []
  const toolCalls: ToolCallRecord[] = []
  const evidence = new Map<string, { json: string; created_at: number }>()
  const usage = new Map<string, number>()
  const recoveryDecisions: Array<Parameters<RunStorePort['appendRecoveryDecision']>[0]> = []
  const artifacts: Array<Parameters<RunStorePort['saveArtifact']>[0]> = []
  const completionEvaluations = new Map<string, { revision: number; state: string; json: string }>()
  const completionAttempts = new Map<string, Array<{ attempt: number; json: string; createdAt: number }>>()
  return {
    runs,
    toolCalls,
    async createRun(r) {
      runs.set(r.runId, r)
    },
    async getRun(id) {
      return runs.get(id) ?? null
    },
    async updateRun(id, patch) {
      const r = runs.get(id)
      if (r) runs.set(id, { ...r, ...patch })
    },
    async listActiveRuns() {
      return [...runs.values()]
    },
    async appendTurn(t) {
      turns.push(t)
    },
    async getTurns(id) {
      return turns.filter((t) => t.runId === id)
    },
    async upsertToolCall(tc) {
      const i = toolCalls.findIndex((t) => t.toolCallId === tc.toolCallId)
      if (i >= 0) toolCalls[i] = tc
      else toolCalls.push(tc)
    },
    async getToolCalls(id) {
      return toolCalls.filter((t) => t.runId === id)
    },
    async appendRecoveryDecision(decision) {
      recoveryDecisions.push(decision)
    },
    async getRecoveryDecisions(runId) {
      return recoveryDecisions.filter((decision) => decision.run_id === runId)
    },
    async saveArtifact(artifact) {
      const index = artifacts.findIndex((item) => item.artifactId === artifact.artifactId)
      if (index >= 0) artifacts[index] = artifact
      else artifacts.push(artifact)
    },
    async getArtifactsByRun(runId) {
      return artifacts.filter((artifact) => artifact.runId === runId)
    },
    async getArtifactContent(hash) {
      return artifacts.find((artifact) => artifact.hash === hash)?.content ?? null
    },
    async saveCompletionEvaluation(runId, revision, state, json) {
      completionEvaluations.set(runId, { revision, state, json })
    },
    getLatestCompletionEvaluation(runId) {
      return completionEvaluations.get(runId) ?? null
    },
    async appendCompletionAttempt(runId, attempt, json) {
      const rows = completionAttempts.get(runId) ?? []
      rows.push({ attempt, json, createdAt: Date.now() })
      completionAttempts.set(runId, rows)
    },
    async getCompletionAttempts(runId) {
      return completionAttempts.get(runId) ?? []
    },
    async saveRunEvidence(runId, kind, json) {
      evidence.set(`${runId}:${kind}`, { json, created_at: Date.now() })
    },
    async getRunEvidence(runId, kind) {
      return evidence.get(`${runId}:${kind}`) ?? null
    },
    async getUsageTotalTokens(runId) {
      return usage.get(runId) ?? 0
    },
    async appendUsage(row) {
      usage.set(row.runId, (usage.get(row.runId) ?? 0) + row.inputTokens + row.outputTokens)
    }
  }
}

interface Scenario {
  engine: ReturnType<typeof createAgentRunEngine>
  store: ReturnType<typeof createMemStore>
  statuses: string[]
  toolExecCalls: () => number
}

/** 单工具场景：模型第一轮发出 tool_call(slow_tool)，第二轮直接 stop */
function makeScenario(opts: {
  toolImpl: (name: string, argsJson: string, toolCallId: string, runId: string, signal: AbortSignal | undefined) => Promise<string>
  fallbackMs?: number
}): Scenario {
  const store = createMemStore()
  const statuses: string[] = []
  let toolCalls = 0
  let modelCalls = 0
  let engineRef: ReturnType<typeof createAgentRunEngine> | undefined
  const engine = createAgentRunEngine({
    store,
    modelCall: async (): Promise<AsyncIterable<ModelEvent>> => {
      const first = modelCalls === 0
      modelCalls++
      return {
        async *[Symbol.asyncIterator]() {
          if (first) {
            yield { type: 'tool_call', tool: { index: 0, id: 'tc-1', name: 'slow_tool', arguments: '{}' } }
            yield { type: 'finish', finishReason: 'tool_calls' }
          } else {
            yield { type: 'finish', finishReason: 'stop' }
          }
        }
      }
    },
    toolExecutor: async (name, argsJson, toolCallId, runId) => {
      toolCalls++
      return opts.toolImpl(name, argsJson, toolCallId, runId, engineRef?.abortSignal(runId))
    },
    getConfig: () => ({ cancelFallbackMs: opts.fallbackMs ?? 5000 }),
    onEvent: () => {},
    onRunUpdate: (r) => {
      statuses.push(r.status)
    }
  })
  engineRef = engine
  return { engine, store, statuses, toolExecCalls: () => toolCalls }
}

async function main(): Promise<void> {
  console.log('\n[R41 S-04] CANCEL-SLOW-01：慢工具（800ms、响应 abort）协作取消 → cancel_requested → cancelled')
  {
    const sc = makeScenario({
      fallbackMs: 600,
      toolImpl: (name, args, id, runId, signal) =>
        new Promise<string>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | null = null
          const onAbort = (): void => {
            if (timer) clearTimeout(timer)
            reject(new Error('已取消'))
          }
          if (signal?.aborted) return onAbort()
          signal?.addEventListener('abort', onAbort, { once: true })
          timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve('ok:done')
          }, 800)
        })
    })
    const started = await sc.engine.start({ sessionId: 's1', runId: 'r1', config: {} })
    check('CANCEL-SLOW-01 start ok', started.ok === true, JSON.stringify(started))
    const stepP = sc.engine.step('r1')
    await waitFor(async () => (await sc.store.getToolCalls('r1'))[0]?.status === 'running', 2000, '工具进入 running')
    await sc.engine.cancel('r1')
    await stepP
    await waitFor(async () => (await sc.store.getRun('r1'))?.status === 'cancelled', 3000, '终态 cancelled')
    const run = (await sc.store.getRun('r1')) as RunRecord
    const tcs = await sc.store.getToolCalls('r1')
    check('CANCEL-SLOW-01 状态序列含 cancel_requested', sc.statuses.includes('cancel_requested'), JSON.stringify(sc.statuses))
    check(
      'CANCEL-SLOW-01 状态序列 cancel_requested 先于 cancelled',
      sc.statuses.indexOf('cancel_requested') < sc.statuses.indexOf('cancelled'),
      JSON.stringify(sc.statuses)
    )
    check('CANCEL-SLOW-01 终态为 cancelled', run.status === 'cancelled' && run.phase === 'cancelled', `${run.status}/${run.phase}`)
    check(
      'CANCEL-SLOW-01 无副作用残留（无 running/requested/side_effect_unknown）',
      tcs.length === 1 && tcs[0].status === 'cancelled',
      JSON.stringify(tcs.map((t) => t.status))
    )
  }

  console.log('\n[R41 S-04] CANCEL-UNCOOPERATIVE-01：工具不响应 abort（2s，远超 600ms 兜底）→ recovery_required + side_effect_unknown')
  {
    const sc = makeScenario({
      fallbackMs: 600,
      toolImpl: async () => {
        await delay(2000) // 不监听 abort——协作路径无法确认，拖过兜底时限
        return 'ok:eventually'
      }
    })
    await sc.engine.start({ sessionId: 's2', runId: 'r2', config: {} })
    const stepP = sc.engine.step('r2')
    await waitFor(async () => (await sc.store.getToolCalls('r2'))[0]?.status === 'running', 2000, '工具进入 running')
    await sc.engine.cancel('r2')
    await waitFor(async () => (await sc.store.getRun('r2'))?.status === 'recovery_required', 3000, '兜底进入 recovery_required')
    const run = (await sc.store.getRun('r2')) as RunRecord
    const tcs = await sc.store.getToolCalls('r2')
    check('CANCEL-UNCOOPERATIVE-01 兜底后为 recovery_required（非 cancelled）', run.status === 'recovery_required', `status=${run.status}`)
    check('CANCEL-UNCOOPERATIVE-01 phase 为 recovery_required', run.phase === 'recovery_required', `phase=${run.phase}`)
    check('CANCEL-UNCOOPERATIVE-01 状态序列含 cancel_requested', sc.statuses.includes('cancel_requested'), JSON.stringify(sc.statuses))
    check(
      'CANCEL-UNCOOPERATIVE-01 状态序列未以 cancelled 收尾',
      sc.statuses[sc.statuses.length - 1] !== 'cancelled',
      JSON.stringify(sc.statuses)
    )
    check('CANCEL-UNCOOPERATIVE-01 未确认工具标 side_effect_unknown', tcs.length === 1 && tcs[0].status === 'side_effect_unknown', JSON.stringify(tcs.map((t) => t.status)))
    await stepP
    // 工具迟到 settle：兜底已 finalize，引擎不得覆盖 side_effect_unknown
    const after = await sc.store.getToolCalls('r2')
    check('CANCEL-UNCOOPERATIVE-01 工具迟到结果不覆盖 side_effect_unknown', after[0].status === 'side_effect_unknown', `status=${after[0]?.status}`)
  }

  console.log('\n[R41 S-04] RECOVERY-NONIDEMPOTENT-01：recovery_required 在可恢复列表，但 restore 不自动重放工具')
  {
    const sc = makeScenario({
      fallbackMs: 600,
      toolImpl: async () => {
        await delay(2000)
        return 'ok:eventually'
      }
    })
    await sc.engine.start({ sessionId: 's3', runId: 'r3', config: {} })
    const stepP = sc.engine.step('r3')
    await waitFor(async () => (await sc.store.getToolCalls('r3'))[0]?.status === 'running', 2000, '工具进入 running')
    await sc.engine.cancel('r3')
    await waitFor(async () => (await sc.store.getRun('r3'))?.status === 'recovery_required', 3000, '兜底进入 recovery_required')
    const execBefore = sc.toolExecCalls()
    check('RECOVERY-NONIDEMPOTENT-01 原始执行恰一次', execBefore === 1, `calls=${execBefore}`)
    const rec = await sc.engine.listRecoverable()
    check(
      'RECOVERY-NONIDEMPOTENT-01 listRecoverable 返回 recovery_required run（保持原状态，R4.2 A4 不静默提升）',
      rec.some((r) => r.runId === 'r3' && r.status === 'recovery_required'),
      JSON.stringify(rec.map((r) => ({ id: r.runId, status: r.status })))
    )
    await sc.engine.restore('r3')
    const restored = (await sc.store.getRun('r3')) as RunRecord
    const tcsAfter = await sc.store.getToolCalls('r3')
    check('RECOVERY-NONIDEMPOTENT-01 restore 后未自动重放工具', sc.toolExecCalls() === execBefore, `calls=${sc.toolExecCalls()}`)
    check('RECOVERY-NONIDEMPOTENT-01 restore 保持 recovery_required（R4.2 A4 不静默提升）', restored.status === 'recovery_required' && restored.phase === 'recovery_required', `${restored.status}/${restored.phase}`)
    check('RECOVERY-NONIDEMPOTENT-01 未确认工具保持 side_effect_unknown', tcsAfter.length === 1 && tcsAfter[0].status === 'side_effect_unknown', JSON.stringify(tcsAfter.map((t) => t.status)))
    const stepP2 = sc.engine.step('r3')
    await stepP2
    await waitFor(async () => (await sc.store.getRun('r3'))?.status === 'completed', 3000, '恢复后正常完成')
    const final = (await sc.store.getRun('r3')) as RunRecord
    check('RECOVERY-NONIDEMPOTENT-01 恢复后续跑不再触发工具执行', final.status === 'completed' && sc.toolExecCalls() === execBefore, `status=${final.status} calls=${sc.toolExecCalls()}`)
    await stepP
  }

  console.log('\n[R41 S-04] RECOVER-LIST-01：cancelling/cancel_requested 也列入可恢复 active runs（引擎侧提升）')
  {
    const sc = makeScenario({ toolImpl: async () => 'ok', fallbackMs: 600 })
    // 直接向 store 注入历史遗留状态 run（等价于 store port 返回 cancelling/cancel_requested）
    await sc.store.createRun({
      runId: 'legacy-c',
      sessionId: 's9',
      status: 'cancelling',
      phase: 'stopping',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      configJson: '{}'
    })
    await sc.store.createRun({
      runId: 'legacy-cr',
      sessionId: 's9',
      status: 'cancel_requested',
      phase: 'stopping',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      configJson: '{}'
    })
    const rec = await sc.engine.listRecoverable()
    const ids = rec.map((r) => r.runId)
    check('RECOVER-LIST-01 cancelling run 列入可恢复列表', ids.includes('legacy-c'), JSON.stringify(ids))
    check('RECOVER-LIST-01 cancel_requested run 列入可恢复列表', ids.includes('legacy-cr'), JSON.stringify(ids))
    check('RECOVER-LIST-01 均提升为 recoverable', rec.every((r) => r.status === 'recoverable'), JSON.stringify(rec.map((r) => r.status)))
  }

  console.log(`\n===== R4.1 S-04 取消/恢复回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('失败明细：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.1 S-04 取消/恢复回归执行异常：', e)
  process.exit(2)
})
