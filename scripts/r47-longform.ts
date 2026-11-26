import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { streamChat, longGenerate } from '../src/main/deepseek'
import { deriveWriterRequestPlan, mapProviderFinishReason } from '../src/main/writerRequestPlan'
import { CompletionController } from '../src/main/completion/CompletionController'
import { createAgentRunEngine } from '../src/main/jobs/AgentRunEngine'
import { buildExecutionSnapshot } from '../src/main/executionSnapshot'
import type { ArtifactRecord, RecoveryDecisionRecord, RunConfig, RunRecord, RunStorePort, ToolCallRecord, TurnRecord } from '../src/main/jobs/types'
import type { CompletionContract, CompletionEvaluation, CompletionStore } from '../src/main/completion/types'
import type { DsMessage, Usage } from '../src/shared/types'
import { selectNaturalEnding } from '../src/shared/textMetrics'

let passed = 0

function ok(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL ${message}`)
  passed++
  console.log(`PASS ${message}`)
}

function cpLength(value: string): number {
  return Array.from(value).length
}

function count(value: string, needle: string): number {
  let at = 0
  let hits = 0
  while ((at = value.indexOf(needle, at)) >= 0) {
    hits++
    at += needle.length
  }
  return hits
}

const baseParams = {
  apiKey: 'synthetic-only',
  model: 'r47-fake-model',
  thinking: { enabled: false as const, effort: 'low' as const },
  maxTokens: 4096
}
const baseMessages: DsMessage[] = [{ role: 'system', content: '按已确认大纲写作；每轮从断点自然推进。' }, { role: 'user', content: '目标 8000 字，输出正文。' }]

/** Fake SSE：每次只给 900 code points，验证 stop/length 都不会被误当成完成。 */
async function runFakeContinuation(finishReason: 'stop' | 'length'): Promise<void> {
  let calls = 0
  let observed = ''
  const fakeStream: typeof streamChat = async (_params, onEvent) => {
    calls++
    const marker = `【R47-${finishReason}-${calls}】`
    const fillChar = String.fromCodePoint(0x4e00 + calls)
    const points = Array.from(marker + fillChar.repeat(900 - cpLength(marker)))
    for (let i = 99; i < points.length; i += 100) points[i] = '。'
    const segment = points.join('')
    onEvent({ type: 'text', delta: segment })
    const usage: Usage = {
      prompt_tokens: 120,
      completion_tokens: 900,
      total_tokens: 1020,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 120,
      reasoning_tokens: 0,
      cache_tokens_known: true,
      reasoning_tokens_known: true
    }
    onEvent({ type: 'done', finishReason, usage })
    return { finishReason, usage }
  }
  const result = await longGenerate({
    params: baseParams,
    messages: baseMessages,
    targetChars: 8000,
    maxRounds: 12,
    onRound: () => undefined,
    onEvent: (event) => { if (event.type === 'text') observed += event.delta ?? '' },
    onContentReplace: (content) => { observed = content },
    streamChatImpl: fakeStream
  })
  ok(result.reachedTarget, `finish=${finishReason} 续写达到 8000 字`)
  ok(result.measuredChars === 8000 && cpLength(observed) === 8000, `finish=${finishReason} 单一正文累计 8000 字，无覆盖`)
  ok(result.rounds === 9 && calls === 9, `finish=${finishReason} 900 字短响应自动拆为 9 轮`)
  for (let i = 1; i <= calls; i++) {
    const marker = `【R47-${finishReason}-${i}】`
    ok(count(observed, marker) === 1, `finish=${finishReason} 第 ${i} 段只追加一次`)
  }
  ok(!result.needsContinuation, `finish=${finishReason} 达标后才结束，不留下假完成续作标记`)
}

await runFakeContinuation('stop')
await runFakeContinuation('length')

/**
 * 这组测试故意不调用 legacy longGenerate：它驱动真正的生产 AgentRunEngine
 * 和 CompletionController，只替换 modelCall 为本地合成 provider。这样 stop
 * 短答与 length 短答都必须经过主链的续写、完成校验、持久化投影后才算完成。
 */
class EngineMemoryStore implements RunStorePort {
  private readonly runs = new Map<string, RunRecord>()
  private readonly turns = new Map<string, TurnRecord[]>()
  private readonly tools = new Map<string, ToolCallRecord[]>()
  private readonly artifacts = new Map<string, ArtifactRecord[]>()
  private readonly evidence = new Map<string, { json: string; created_at: number }>()
  private readonly evaluations = new Map<string, { revision: number; state: string; json: string }>()
  private readonly attempts = new Map<string, Array<{ attempt: number; json: string; createdAt: number }>>()
  private readonly usage: Array<{ runId: string; inputTokens: number; outputTokens: number }> = []

  async createRun(run: RunRecord): Promise<void> { this.runs.set(run.runId, { ...run }) }
  async getRun(runId: string): Promise<RunRecord | null> { return this.runs.get(runId) ?? null }
  async updateRun(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const run = this.runs.get(runId)
    if (run) this.runs.set(runId, { ...run, ...patch, updatedAt: Date.now() })
  }
  async listActiveRuns(): Promise<RunRecord[]> { return [...this.runs.values()].filter((run) => !['completed', 'failed', 'cancelled'].includes(run.status)) }
  async appendTurn(turn: TurnRecord): Promise<void> {
    const list = this.turns.get(turn.runId) ?? []
    const index = list.findIndex((item) => item.turnId === turn.turnId)
    if (index >= 0) list[index] = { ...turn }
    else list.push({ ...turn })
    list.sort((a, b) => a.turnSeq - b.turnSeq)
    this.turns.set(turn.runId, list)
  }
  async getTurns(runId: string): Promise<TurnRecord[]> { return (this.turns.get(runId) ?? []).map((turn) => ({ ...turn })) }
  async upsertToolCall(tool: ToolCallRecord): Promise<void> {
    const list = this.tools.get(tool.runId) ?? []
    const index = list.findIndex((item) => item.toolCallId === tool.toolCallId)
    if (index >= 0) list[index] = { ...tool }
    else list.push({ ...tool })
    this.tools.set(tool.runId, list)
  }
  async getToolCalls(runId: string): Promise<ToolCallRecord[]> { return (this.tools.get(runId) ?? []).map((tool) => ({ ...tool })) }
  async appendRecoveryDecision(_decision: RecoveryDecisionRecord): Promise<void> {}
  async getRecoveryDecisions(_runId: string): Promise<RecoveryDecisionRecord[]> { return [] }
  async saveArtifact(artifact: ArtifactRecord): Promise<void> {
    this.artifacts.set(artifact.runId, [...(this.artifacts.get(artifact.runId) ?? []), { ...artifact }])
  }
  async getArtifactsByRun(runId: string): Promise<ArtifactRecord[]> { return (this.artifacts.get(runId) ?? []).map((artifact) => ({ ...artifact })) }
  async getArtifactContent(_hash: string): Promise<string | null> { return null }
  async saveCompletionEvaluation(runId: string, revision: number, state: string, json: string): Promise<void> {
    this.evaluations.set(runId, { revision, state, json })
  }
  getLatestCompletionEvaluation(runId: string): { revision: number; state: string; json: string } | null { return this.evaluations.get(runId) ?? null }
  async appendCompletionAttempt(runId: string, attempt: number, json: string): Promise<void> {
    const list = this.attempts.get(runId) ?? []
    list.push({ attempt, json, createdAt: Date.now() })
    this.attempts.set(runId, list)
  }
  async getCompletionAttempts(runId: string): Promise<Array<{ attempt: number; json: string; createdAt: number }>> { return [...(this.attempts.get(runId) ?? [])] }
  async saveRunEvidence(runId: string, kind: string, json: string): Promise<void> { this.evidence.set(`${runId}:${kind}`, { json, created_at: Date.now() }) }
  async getRunEvidence(runId: string, kind: string): Promise<{ json: string; created_at: number } | null> { return this.evidence.get(`${runId}:${kind}`) ?? null }
  async getUsageTotalTokens(runId: string): Promise<number> { return this.usage.filter((item) => item.runId === runId).reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0) }
  async appendUsage(input: { runId: string; callType: string; model: string; inputTokens: number; outputTokens: number; cacheHit: number; cacheMiss: number; createdAt: number }): Promise<void> {
    this.usage.push({ runId: input.runId, inputTokens: input.inputTokens, outputTokens: input.outputTokens })
  }
}

function engineConfig(runId: string): RunConfig {
  const snapshot = buildExecutionSnapshot({
    payload: { id: runId, mode: 'longwrite', workspace: 'novel', longMode: true, targetChars: 8000, text: '写一篇灯塔守夜人的长文。' },
    settings: {
      model: 'r47-engine-fake', baseUrl: 'http://127.0.0.1', maxTokens: 8192, temperature: 0.7, topP: 0.9,
      thinkingEnabled: true, reasoningEffort: 'high', workDir: 'C:/r47-work', docDir: 'C:/r47-docs', novelMode: false,
      galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000,
      completionTokenBudget: 200000, completionWallClockMs: 0, strongConstraintEnabled: false,
      themeLockMode: 'off', expressionFreedom: 'high', antiMoralizingEnabled: false
    } as never,
    sessionId: `${runId}-session`,
    memory: { projectPath: '', projectContent: '', userContent: '' },
    now: 1700000000000
  })
  // 900-character synthetic segments need nine calls; the production snapshot's
  // derived cap assumes roughly 1000/call, so this explicit safety cap is part of
  // the test fixture, not a production bypass.
  return { ...snapshot, maxTurns: 8 }
}

async function runAgentEngineContinuation(finishReason: 'stop' | 'length'): Promise<void> {
  const runId = `r47-engine-${finishReason}`
  const store = new EngineMemoryStore()
  const config = engineConfig(runId)
  let calls = 0
  const segments: string[] = []
  const engine = createAgentRunEngine({
    store,
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' | 'length' }> {
        calls += 1
        const marker = `【ENGINE-${finishReason}-${calls}】`
        const chars = Array.from(marker)
        while (chars.length < 900) chars.push(String.fromCodePoint(0x10000 + calls * 1000 + chars.length))
        for (let i = 99; i < chars.length; i += 100) chars[i] = '。'
        const segment = chars.slice(0, 900).join('')
        segments.push(segment)
        yield { type: 'text', delta: segment }
        yield { type: 'finish', finishReason }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => config,
    publishLongwriteArtifact: async ({ runId: artifactRunId }) => ({ displayName: 'R47-稿件.md', relativePath: `C:/r47-docs/${artifactRunId}.md` }),
    onEvent: () => undefined,
    onRunUpdate: () => undefined
  })
  await engine.start({ sessionId: `${runId}-session`, runId, config })
  await store.appendTurn({ turnId: `${runId}-user`, runId, turnSeq: 1, role: 'user', content: '写灯塔长文', createdAt: 1700000000001 })
  await engine.step(runId)
  const state = await engine.getState(runId)
  const assistant = state.turns.filter((turn) => turn.role === 'assistant').map((turn) => turn.content).join('')
  ok(state.run?.status === 'completed', `AgentRunEngine finish=${finishReason} 最终由 CompletionController 完成（status=${state.run?.status ?? 'none'} error=${state.run?.errorCode ?? 'none'} calls=${calls}）`)
  ok(cpLength(assistant) === 8000, `AgentRunEngine finish=${finishReason} durable 正文精确 8000 字`)
  ok(calls === 9, `AgentRunEngine finish=${finishReason} 900 字短段自动续写 9 轮`)
  ok(new Set(segments).size === segments.length, `AgentRunEngine finish=${finishReason} 每轮候选只落盘一次`)
  const artifacts = await store.getArtifactsByRun(runId)
  ok(artifacts.length === 1 && artifacts[0].artifactType === 'manuscript' && artifacts[0].charCount === 8000, `AgentRunEngine finish=${finishReason} 完成前登记 8000 字稿件`)
}

await runAgentEngineContinuation('stop')
await runAgentEngineContinuation('length')

const midSentenceAtTarget = selectNaturalEnding(`${'甲'.repeat(8000)}乙。尾声`, 8000, 7920, 8080)
ok(midSentenceAtTarget?.endCodePoint === 8002 && midSentenceAtTarget.text.endsWith('。'), '目标点落在半句时延伸到窗口内完整句末')
const fallbackSentence = selectNaturalEnding(`前句。${'乙'.repeat(8000)}`, 8000, 7920, 8080)
ok(fallbackSentence?.withinWindow === false && fallbackSentence.text === '前句。', '窗口内没有句末时回退到安全前缀并要求下一轮收尾')

async function runDeliveryFailure(): Promise<void> {
  const runId = 'r47-delivery-failure'
  const store = new EngineMemoryStore()
  const config = engineConfig(runId)
  let calls = 0
  const engine = createAgentRunEngine({
    store,
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
        calls++
        const points = Array.from(String.fromCodePoint(0x4e00 + calls).repeat(900))
        for (let i = 99; i < points.length; i += 100) points[i] = '。'
        yield { type: 'text', delta: points.join('') }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => config,
    publishLongwriteArtifact: async () => { throw new Error('synthetic disk failure') },
    onEvent: () => undefined,
    onRunUpdate: () => undefined
  })
  await engine.start({ sessionId: `${runId}-session`, runId, config })
  await store.appendTurn({ turnId: `${runId}-user`, runId, turnSeq: 1, role: 'user', content: '写作', createdAt: 1700000000001 })
  await engine.step(runId)
  const state = await engine.getState(runId)
  ok(calls === 9, '交付失败发生在正文与完成校验之后')
  ok(state.run?.status === 'failed' && state.run.errorCode === 'longwrite_delivery_failed', '写盘失败阻止 completed 并留下明确错误码')
  ok(cpLength(state.turns.filter((turn) => turn.role === 'assistant').map((turn) => turn.content).join('')) === 8000, '写盘失败仍保留完整 durable 正文')
  ok((await store.getArtifactsByRun(runId)).length === 0, '写盘失败不登记假 manuscript')
}

await runDeliveryFailure()

let exhaustedCalls = 0
const exhaustedStream: typeof streamChat = async (_params, onEvent) => {
  exhaustedCalls++
  const delta = `【R47-exhausted-${exhaustedCalls}】` + '字'.repeat(880)
  onEvent({ type: 'text', delta })
  return { finishReason: 'stop', usage: null }
}
const exhausted = await longGenerate({
  params: baseParams,
  messages: baseMessages,
  targetChars: 8000,
  maxRounds: 2,
  onRound: () => undefined,
  onEvent: () => undefined,
  streamChatImpl: exhaustedStream
})
ok(exhausted.measuredChars < 8000 && exhausted.needsContinuation, '轮数耗尽时保持未完成并要求用户继续，不假装完成')

const evaluations: CompletionEvaluation[] = []
const completionStore: CompletionStore = {
  saveEvaluation: (_runId, evaluation) => evaluations.push(evaluation),
  getLatestEvaluation: () => evaluations.at(-1) ?? null
}
const contract: CompletionContract = {
  schemaVersion: 1,
  runId: 'r47-exhaustion',
  targetChars: { min: 8000, max: 8000, tolerance: 0 },
  validators: [{ id: 'targetChars', severity: 'hard', config: {} }],
  maxRepairAttempts: 20,
  tokenBudget: 1,
  createdAt: Date.now()
}
const controller = new CompletionController({ contract, store: completionStore })
const firstEvaluation = controller.submitCandidate({ measuredChars: 1000, artifacts: [], pendingToolCount: 0, pendingToolNames: [] })
ok(firstEvaluation.state === 'validating', '不足目标时完成控制器只进入 validating')
controller.setAccumulatedCost(1)
const waiting = controller.requestContinuation({ effectiveDeltaChars: 900 })
ok(waiting.state === 'waiting_user' && waiting.blockedReason === 'budget_exhausted', '续作预算耗尽进入 waiting_user，不转 completed')
contract.tokenBudget = 20001
controller.setAccumulatedCost(7135)
const resumedAfterBudget = controller.resumeAfterUserDecision()
ok(resumedAfterBudget.state === 'continuing' && resumedAfterBudget.blockedReason === undefined, '用户扩展预算后 waiting_user 只产生一条 continuing，不二次 blocked')

const writerPlan = deriveWriterRequestPlan(
  { runMode: 'longwrite', longMode: true, targetChars: 8000, providerProfileSnapshots: { draft: { model: { maxOutputTokens: 16384 } } } },
  { apiKey: 'synthetic', baseUrl: 'http://127.0.0.1', model: 'fake', maxTokens: 8192, thinking: { enabled: true, effort: 'high' }, temperature: 0.3, topP: 0.9 },
  [{ role: 'user', content: '写作任务' }],
  { schemaVersion: 1, runId: 'r47', round: 1, createdAt: Date.now(), totalTokens: 1000, budgetTokens: 19000, contextWindowTokens: 20000, outputReserveTokens: 8192, promptHash: '', cacheablePrefixHash: '', overBudget: false, segments: [] },
  'writer'
)
ok(writerPlan.maxTokens === 8192 && writerPlan.thinking.enabled === false && writerPlan.remainingChars === 8000, '长文 writer 以 profile 上限为硬上限并关闭思考旁路，优先可见正文预算')
let narrowContextRejected = false
try {
  deriveWriterRequestPlan(
    { runMode: 'longwrite', longMode: true, targetChars: 8000 },
    { apiKey: 'synthetic', baseUrl: 'http://127.0.0.1', model: 'fake', maxTokens: 8192, thinking: { enabled: false, effort: 'low' }, temperature: 0.3, topP: 0.9 },
    [{ role: 'user', content: '写作任务' }],
    { schemaVersion: 1, runId: 'r47', round: 1, createdAt: Date.now(), totalTokens: 19900, budgetTokens: 100, contextWindowTokens: 20000, outputReserveTokens: 8192, promptHash: '', cacheablePrefixHash: '', overBudget: false, segments: [] },
    'writer'
  )
} catch { narrowContextRejected = true }
ok(narrowContextRejected, '上下文剩余输出空间不足时在 provider 前 fail-closed')
ok(mapProviderFinishReason('stop').finishReason === 'stop', '显式 stop 保留为可续写/完成信号')
ok(mapProviderFinishReason(undefined).errorCode === 'incomplete_stream' && mapProviderFinishReason(undefined).finishReason === 'error', '未知或缺失 finish_reason 不再降级为 stop')
ok(mapProviderFinishReason('content_filter').finishReason === 'error', '内容过滤结束不伪造完成')

const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const novelPanel = source('../src/renderer/src/components/NovelPanel.tsx')
const composer = source('../src/renderer/src/components/Composer.tsx')
const storeSource = source('../src/renderer/src/store.ts')
const main = source('../src/main/index.ts')
const preload = source('../src/preload/index.ts')
const engine = source('../src/main/jobs/AgentRunEngine.ts')
const adapter = source('../src/main/runKernelAdapter.ts')
const deepseek = source('../src/main/deepseek.ts')
const runInspector = source('../src/renderer/src/components/RunInspector/RunInspector.tsx')
ok(novelPanel.includes('startGuidedLongwrite') && novelPanel.includes('开始梳理') && novelPanel.includes('基于对话梳理') && !novelPanel.includes('novelDirect') && !novelPanel.includes('novelExport'), 'NovelPanel 两种入口都只投递 Grill Me，不再暴露旧成书旁路')
ok(composer.includes('grillLaunchRequest') && composer.includes('grillStart'), 'Composer 消费侧栏请求并启动 Grill Me 采访')
ok(storeSource.includes('startGuidedLongwrite: (prompt)') && storeSource.includes('transitionLongMode(current, true)'), '侧栏入口自动切换到长文工作区，确保默认模式也能启动 Grill Me')
ok(!main.includes("registerIpcOn('novel:direct'") && !main.includes("registerIpcOn('novel:start'") && !preload.includes('novelDirect') && !preload.includes('novelStart'), '主进程与 preload 均删除旧长文 IPC 旁路')
ok(main.includes('canonicalizeGrillMePayload') && main.includes('grill_confirmation_required'), '正文 chat:start 仍由 durable Grill 确认门禁保护')
ok(engine.includes('runWritingPipeline') && engine.includes('tryCompletionGate') && engine.includes('completion_accepted'), '正文只走 AgentRunEngine + CompletionController + R42 writer/critic/editor/verification 链')
ok(!adapter.includes("?? 'stop'") && !deepseek.includes("finishReason = finishReason ?? 'stop'"), '生产适配层与 SSE 层均禁止缺失 finish_reason 假装 stop')
ok(main.includes("registerIpc('artifacts:open'") && main.includes('await fs.realpath(docDir)') && main.includes("artifact.artifact_type !== 'manuscript'") && main.includes("createHash('sha256').update(content)"), '稿件打开入口按 run/artifact 身份、真实路径边界和内容哈希校验')
ok(preload.includes("ipcRenderer.invoke('artifacts:open'") && runInspector.includes('ds?.artifactOpen') && runInspector.includes('open(runId, artifact.artifactId)') && !runInspector.includes('openPath?.(artifact.relativePath)'), 'renderer 不再把裸 artifact 路径误传给 FileRef IPC')

console.log(`R47 longform ${passed} PASS; synthetic provider calls only`)
