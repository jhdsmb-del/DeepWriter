import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createAgentRunEngine } from '../src/main/jobs/AgentRunEngine'
import type { ModelEvent, RunRecord, RunStorePort, ToolCallRecord, TurnRecord } from '../src/main/jobs/types'

let passed = 0
let failed = 0

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时: ${label}`)
}

function createMemStore(): RunStorePort & { runs: Map<string, RunRecord>; turns: TurnRecord[]; toolCalls: ToolCallRecord[] } {
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
    turns,
    toolCalls,
    async createRun(run) { runs.set(run.runId, run) },
    async getRun(runId) { return runs.get(runId) ?? null },
    async updateRun(runId, patch) {
      const run = runs.get(runId)
      if (run) runs.set(runId, { ...run, ...patch, updatedAt: Date.now() })
    },
    async listActiveRuns() { return [...runs.values()] },
    async appendTurn(turn) {
      const index = turns.findIndex((row) => row.turnId === turn.turnId)
      if (index >= 0) turns[index] = turn
      else turns.push(turn)
    },
    async getTurns(runId) { return turns.filter((turn) => turn.runId === runId) },
    async upsertToolCall(toolCall) {
      const index = toolCalls.findIndex((row) => row.toolCallId === toolCall.toolCallId)
      if (index >= 0) toolCalls[index] = toolCall
      else toolCalls.push(toolCall)
    },
    async getToolCalls(runId) { return toolCalls.filter((toolCall) => toolCall.runId === runId) },
    async appendRecoveryDecision(decision) { recoveryDecisions.push(decision) },
    async getRecoveryDecisions(runId) { return recoveryDecisions.filter((decision) => decision.run_id === runId) },
    async saveArtifact(artifact) {
      const index = artifacts.findIndex((row) => row.artifactId === artifact.artifactId)
      if (index >= 0) artifacts[index] = artifact
      else artifacts.push(artifact)
    },
    async getArtifactsByRun(runId) { return artifacts.filter((artifact) => artifact.runId === runId) },
    async getArtifactContent(hash) { return artifacts.find((artifact) => artifact.hash === hash)?.content ?? null },
    async saveCompletionEvaluation(runId, revision, state, json) { completionEvaluations.set(runId, { revision, state, json }) },
    getLatestCompletionEvaluation(runId) { return completionEvaluations.get(runId) ?? null },
    async appendCompletionAttempt(runId, attempt, json) {
      const rows = completionAttempts.get(runId) ?? []
      rows.push({ attempt, json, createdAt: Date.now() })
      completionAttempts.set(runId, rows)
    },
    async getCompletionAttempts(runId) { return completionAttempts.get(runId) ?? [] },
    async saveRunEvidence(runId, kind, json) { evidence.set(`${runId}:${kind}`, { json, created_at: Date.now() }) },
    async getRunEvidence(runId, kind) { return evidence.get(`${runId}:${kind}`) ?? null },
    async getUsageTotalTokens(runId) { return usage.get(runId) ?? 0 },
    async appendUsage(row) { usage.set(row.runId, (usage.get(row.runId) ?? 0) + row.inputTokens + row.outputTokens) }
  }
}

function runConfig(): Record<string, unknown> {
  return { maxTurns: 2, cancelFallbackMs: 100 }
}

async function pauseAndResumeKeepsPartial(): Promise<void> {
  const store = createMemStore()
  let engine: ReturnType<typeof createAgentRunEngine>
  let providerCalls = 0
  let abortSeen = false
  const modelCall = async ({ runId }: { runId: string }): Promise<AsyncIterable<ModelEvent>> => {
    providerCalls += 1
    const call = providerCalls
    return {
      async *[Symbol.asyncIterator]() {
        if (call === 1) {
          yield { type: 'text', delta: '已保存的半成品' }
          await new Promise<void>((resolve) => {
            const signal = engine.abortSignal(runId)
            if (signal?.aborted) resolve()
            else signal?.addEventListener('abort', () => { abortSeen = true; resolve() }, { once: true })
          })
          return
        }
        yield { type: 'text', delta: '，恢复后的续写。' }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }
  }
  engine = createAgentRunEngine({
    store,
    modelCall,
    toolExecutor: async () => 'unused',
    getConfig: () => runConfig(),
    onEvent: () => undefined,
    onRunUpdate: () => undefined
  })
  await engine.start({ sessionId: 'wp6-session', runId: 'wp6-pause-run', config: runConfig() })
  const step = engine.step('wp6-pause-run')
  await waitFor(() => store.turns.some((turn) => turn.role === 'assistant' && turn.content === '已保存的半成品'), 2000, 'partial 持久化')
  await engine.pause('wp6-pause-run')
  await step
  const paused = await engine.getState('wp6-pause-run')
  check('WP6 pause 真实流持久化 partial 并进入 waiting_user/paused', () => {
    assert.equal(abortSeen, true)
    assert.equal(paused.run?.status, 'waiting_user')
    assert.equal(paused.run?.phase, 'paused')
    assert.equal(paused.turns.at(-1)?.content, '已保存的半成品')
  })
  check('WP6 pause 不产生工具副作用', () => assert.equal(paused.toolCalls.length, 0))
  await engine.restore('wp6-pause-run')
  await engine.step('wp6-pause-run')
  const resumed = await engine.getState('wp6-pause-run')
  check('WP6 resume 恢复同一 run 并发起新的 Provider 续写', () => {
    assert.equal(providerCalls, 2)
    assert.equal(resumed.run?.runId, 'wp6-pause-run')
    assert.equal(resumed.run?.status, 'completed')
    assert.match(resumed.turns.at(-1)?.content ?? '', /已保存的半成品，恢复后的续写。/)
  })
}

async function pauseRejectsInFlightTool(): Promise<void> {
  const store = createMemStore()
  let releaseTool: (() => void) | null = null
  let toolCalls = 0
  let providerCalls = 0
  const engine = createAgentRunEngine({
    store,
    modelCall: async (): Promise<AsyncIterable<ModelEvent>> => {
      providerCalls += 1
      return {
        async *[Symbol.asyncIterator]() {
          if (providerCalls === 1) {
            yield { type: 'tool_call', tool: { index: 0, id: 'wp6-tool-1', name: 'slow_tool', arguments: '{}' } }
            yield { type: 'finish', finishReason: 'tool_calls' }
          } else {
            yield { type: 'finish', finishReason: 'stop' }
          }
        }
      }
    },
    toolExecutor: async () => {
      toolCalls += 1
      await new Promise<void>((resolve) => { releaseTool = resolve })
      return 'ok'
    },
    getConfig: () => runConfig(),
    onEvent: () => undefined,
    onRunUpdate: () => undefined
  })
  await engine.start({ sessionId: 'wp6-tool-session', runId: 'wp6-tool-run', config: runConfig() })
  const step = engine.step('wp6-tool-run')
  await waitFor(async () => (await store.getToolCalls('wp6-tool-run')).some((tool) => tool.status === 'running'), 2000, 'tool running')
  await assert.rejects(() => engine.pause('wp6-tool-run'), (error: unknown) => (error as { code?: string }).code === 'pause_tool_in_flight')
  check('WP6 pause 工具 in-flight 时拒绝并保持运行', () => {
    assert.equal(store.runs.get('wp6-tool-run')?.status, 'running')
    assert.equal(toolCalls, 1)
  })
  releaseTool?.()
  await step
}

function checkpointCancelBoundary(): void {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
  const start = source.indexOf("registerIpc('activity:cancel'")
  const end = source.indexOf("registerIpc('activity:pause'")
  assert.ok(start >= 0 && end > start)
  const block = source.slice(start, end)
  assert.ok(block.indexOf('await stopLongformWorkflowForRun') < block.indexOf('await runKernel?.cancel'))
  assert.match(block, /longform_checkpoint_failed/)
}

async function main(): Promise<void> {
  await pauseAndResumeKeepsPartial()
  await pauseRejectsInFlightTool()
  check('WP6 cancel checkpoint 失败边界 fail-closed', checkpointCancelBoundary)
  console.log(`\nWP6 pause regression: ${passed} PASS / ${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error) => {
  failed += 1
  console.error(error)
  process.exitCode = 1
})
