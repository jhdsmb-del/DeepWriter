import { buildExecutionSnapshot } from '../src/main/executionSnapshot'
import { buildLongWriteCheckpoint, buildLongWriteContextMessages, deriveLongWritePlan, LONGWRITE_MAX_TURNS_CAP } from '../src/main/longformPlanner'
import { createContextService } from '../src/main/contextService'
import { createAgentRunEngine } from '../src/main/jobs/AgentRunEngine'
import type { ArtifactRecord, RecoveryDecisionRecord, RunConfig, RunRecord, RunStorePort, ToolCallRecord, TurnRecord } from '../src/main/jobs/types'
import type { Repository } from '../src/main/db/repository'
import type { DsMessage, Settings } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
}

function cp(value: string): number { return Array.from(value).length }

const settings: Settings = {
  apiKey: 'synthetic-only',
  userPresetPrompt: '',
  model: 'r55-synthetic',
  baseUrl: 'http://127.0.0.1',
  thinkingEnabled: false,
  reasoningEffort: 'low',
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 4096,
  toolsEnabled: false,
  docDir: 'C:/r55-docs',
  historyBudgetTokens: 64000,
  workDir: 'C:/r55-work',
  planMode: false,
  permissionMode: 'safe',
  novelMode: false,
  galgame: { enabled: false, projectDir: '', sdkPath: '' },
  completionTokenBudget: 200000,
  completionWallClockMs: 0,
  strongConstraintEnabled: false,
  themeLockMode: 'off',
  expressionFreedom: 'high',
  antiMoralizingEnabled: false
}

function makeConfig(runId: string, targetChars: number): RunConfig {
  return buildExecutionSnapshot({
    payload: { id: runId, sessionId: `${runId}-session`, mode: 'longwrite', workspace: 'novel', longMode: true, targetChars, phase: 'execute', text: `写一篇 ${targetChars} 字的长文` },
    settings,
    sessionId: `${runId}-session`,
    memory: { projectPath: '', projectContent: '', userContent: '' },
    now: 1700000000000
  }) as unknown as RunConfig
}

function uniqueSegment(runId: string, round: number, length = 900): string {
  const marker = `【R55-${runId}-${round}】`
  const points = Array.from(marker)
  const markerLength = points.length
  // Keep a round-specific code point in every 8-gram.  A single sequential
  // Unicode range wraps after ~917k points, which would make a 2m synthetic
  // run look repetitive even though the engine is making real progress.
  for (let i = markerLength; i < length; i++) {
    const relative = i - markerLength
    const point = relative % 8 === 0
      ? 0x10000 + round * 8000 + Math.floor(relative / 8)
      : 0x20000 + ((round * length + relative) % 0xd0000)
    points.push(String.fromCodePoint(point))
  }
  for (let i = 119; i < points.length; i += 120) points[i] = '。'
  if (points.length > 0) points[points.length - 1] = '。'
  return points.slice(0, length).join('')
}

class MemoryStore implements RunStorePort {
  private readonly runs = new Map<string, RunRecord>()
  private readonly turns = new Map<string, TurnRecord[]>()
  private readonly tools = new Map<string, ToolCallRecord[]>()
  private readonly artifacts = new Map<string, ArtifactRecord[]>()
  private readonly evidence = new Map<string, { json: string; created_at: number }>()
  private readonly evaluations = new Map<string, { revision: number; state: string; json: string }>()
  private readonly attempts = new Map<string, Array<{ attempt: number; json: string; createdAt: number }>>()

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
    const list = this.artifacts.get(artifact.runId) ?? []
    const index = list.findIndex((item) => item.artifactId === artifact.artifactId)
    if (index >= 0) list[index] = { ...artifact }
    else list.push({ ...artifact })
    this.artifacts.set(artifact.runId, list)
  }
  async getArtifactsByRun(runId: string): Promise<ArtifactRecord[]> { return (this.artifacts.get(runId) ?? []).map((artifact) => ({ ...artifact })) }
  async getArtifactContent(hash: string): Promise<string | null> {
    for (const list of this.artifacts.values()) {
      const artifact = list.find((item) => item.hash === hash)
      if (artifact) return artifact.content ?? null
    }
    return null
  }
  async saveCompletionEvaluation(runId: string, revision: number, state: string, json: string): Promise<void> { this.evaluations.set(runId, { revision, state, json }) }
  getLatestCompletionEvaluation(runId: string): { revision: number; state: string; json: string } | null { return this.evaluations.get(runId) ?? null }
  async appendCompletionAttempt(runId: string, attempt: number, json: string): Promise<void> {
    const list = this.attempts.get(runId) ?? []
    list.push({ attempt, json, createdAt: Date.now() })
    this.attempts.set(runId, list)
  }
  async getCompletionAttempts(runId: string): Promise<Array<{ attempt: number; json: string; createdAt: number }>> { return [...(this.attempts.get(runId) ?? [])] }
  async saveRunEvidence(runId: string, kind: string, json: string): Promise<void> { this.evidence.set(`${runId}:${kind}`, { json, created_at: Date.now() }) }
  async getRunEvidence(runId: string, kind: string): Promise<{ json: string; created_at: number } | null> { return this.evidence.get(`${runId}:${kind}`) ?? null }
  async getUsageTotalTokens(_runId: string): Promise<number> { return 0 }
  async appendUsage(_input: { runId: string; callType: string; model: string; inputTokens: number; outputTokens: number; cacheHit: number; cacheMiss: number; createdAt: number }): Promise<void> {}
}

for (const targetChars of [8000, 20000, 50000, 100000]) {
  const plan = deriveLongWritePlan({ targetChars, modelOutputTokens: 4096 })
  check(`R55-PLAN-${targetChars} 章节预算合计目标`, plan.chapters.reduce((sum, chapter) => sum + chapter.targetChars, 0) === targetChars, JSON.stringify(plan))
  check(`R55-PLAN-${targetChars} 轮次由目标与模型输出推导`, plan.maxTurns >= 4 && plan.maxTurns <= LONGWRITE_MAX_TURNS_CAP, JSON.stringify(plan))
  check(`R55-PLAN-${targetChars} 章节可执行`, plan.chapters.length >= 1 && plan.chapters.every((chapter) => chapter.targetChars > 0), JSON.stringify(plan.chapters))
}
const plan8 = deriveLongWritePlan({ targetChars: 8000, modelOutputTokens: 4096 })
const plan100 = deriveLongWritePlan({ targetChars: 100000, modelOutputTokens: 4096 })
const plan500 = deriveLongWritePlan({ targetChars: 500000, modelOutputTokens: 4096 })
const plan2m = deriveLongWritePlan({ targetChars: 2000000, modelOutputTokens: 4096 })
check('R55-PLAN-SCALE 100k/500k/2m 不被固定 128 轮截断', plan100.maxTurns > plan8.maxTurns && plan500.maxTurns > plan100.maxTurns && plan2m.maxTurns > plan500.maxTurns, `${plan8.maxTurns}/${plan100.maxTurns}/${plan500.maxTurns}/${plan2m.maxTurns}`)
check('R55-PLAN-SCALE 2m 章节仍受合理绝对上限保护', plan2m.chapters.length <= 64 && plan2m.maxTurns <= LONGWRITE_MAX_TURNS_CAP, JSON.stringify(plan2m))
const plan2mMinimumProvider = deriveLongWritePlan({ targetChars: 2000000, modelOutputTokens: 128 })
check('R55-PLAN-MIN 128-token provider 的 2m 目标不被绝对 cap 截断', plan2mMinimumProvider.maxTurns >= 8001 && plan2mMinimumProvider.maxTurns < LONGWRITE_MAX_TURNS_CAP, JSON.stringify(plan2mMinimumProvider))

const contextTurns: Array<{ role: DsMessage['role']; content: string; turnId?: string }> = [
  { role: 'system', content: '冻结人物约束：主角林岚必须保留灯塔秘密；已批准大纲：发现、追查、收束。' },
  { role: 'user', content: '写作任务：围绕灯塔秘密完成长文。' }
]
for (let i = 0; i < 120; i++) contextTurns.push({ role: 'assistant', content: `章节素材 ${i} ${'甲'.repeat(980)} 中段标记-${i}`, turnId: `turn-${i}` })
const projection = buildLongWriteContextMessages(contextTurns, plan100, 80)
check('R55-CONTEXT 大正文不按轮次线性携带', projection.contextChars < 30000 && projection.contextChars < 120 * 1000, `${projection.contextChars}`)
check('R55-CONTEXT 保留冻结约束与最近正文', projection.messages.some((message) => message.content.includes('冻结人物约束')) && projection.messages.some((message) => message.content.includes('中段标记-119')), 'working set missing')
check('R55-CONTEXT 生成可审计章节摘要', projection.summaryHash.length === 64 && projection.chapterSummaries.length > 0 && projection.compressionApplied, JSON.stringify(projection))
const checkpoint = buildLongWriteCheckpoint('r55-checkpoint', contextTurns, plan100, 1700000000000)
check('R55-CHECKPOINT checkpoint 记录完整测量与当前章节', checkpoint.measuredChars > 0 && checkpoint.currentChapter >= 1 && checkpoint.chapters.length === plan100.chapters.length, JSON.stringify(checkpoint))
check('R55-CHECKPOINT checkpoint 不复制完整正文', JSON.stringify(checkpoint).length < 30000, `${JSON.stringify(checkpoint).length}`)

const manyChapterPlan = deriveLongWritePlan({ targetChars: 260000, modelOutputTokens: 128 })
const manyChapterText = '甲'.repeat(manyChapterPlan.chapters[Math.min(59, manyChapterPlan.chapters.length - 1)].startChars + 100)
const manyChapterProjection = buildLongWriteContextMessages([
  { role: 'system', content: '冻结人物约束与全局大纲：灯塔秘密必须在结尾回收。' },
  { role: 'assistant', content: manyChapterText, turnId: 'many-chapters' }
], manyChapterPlan, 60)
check('R55-CONTEXT 64章时仍保留当前 60+ 章节摘要', manyChapterPlan.chapters.length === 64 && manyChapterProjection.messages.some((message) => message.content.includes('chapter-60')), JSON.stringify({ chapters: manyChapterPlan.chapters.length, current: manyChapterProjection.currentChapter }))
check('R55-CONTEXT 64章摘要选择仍有界', manyChapterProjection.contextChars < 30000 && manyChapterProjection.messages.some((message) => message.content.includes('chapter-59')), `${manyChapterProjection.contextChars}`)

const legacyHistory = Array.from({ length: 120 }, (_, index) => ({
  msg_id: `history-${index}`, session_id: 'r55-context-session', seq: index + 1, role: 'assistant',
  content: `HISTORY-DURABLE-${index}-${'乙'.repeat(1200)}`, reasoning: '', status: 'completed', usage_json: '{}', rounds: 1, tool_names_json: '[]', plan: null, created_at: index
}))
const contextRepo = {
  getSessionMessages: () => legacyHistory,
  saveContextManifest: () => undefined
} as unknown as Repository
const contextService = createContextService(contextRepo)
const assembledLongwriteContext = await contextService.assembleRunContext({
  clientRequestId: 'r55-context-run', sessionId: 'r55-context-session', runMode: 'longwrite', longMode: true,
  contextPolicy: { contextWindowTokens: 100000, outputReserveTokens: 4096 }
}, 1, [
  { role: 'user', content: '继续长文' },
  { role: 'assistant', content: 'WORKING-SET-TAIL' }
], [{ role: 'system', content: '冻结长文约束与计划' }], 'writer')
check('R55-CONTEXT-PRODUCTION ContextService 不重新装载完整 durable session', !assembledLongwriteContext.messages.some((message) => message.content.includes('HISTORY-DURABLE')), `${assembledLongwriteContext.messages.length} messages`)

async function runSynthetic(targetChars: number, segmentLength = 900): Promise<{ status: string; errorCode?: string; errorMessage?: string; chars: number; calls: number; maxContextChars: number; artifact: ArtifactRecord | undefined; checkpoint: Record<string, unknown> | null }> {
  const runId = `r55-${targetChars}`
  const config = makeConfig(runId, targetChars)
  const store = new MemoryStore()
  let calls = 0
  let maxContextChars = 0
  const engine = createAgentRunEngine({
    store,
    modelCall: async ({ messages, purpose }) => {
      if (purpose === undefined) {
        calls++
        maxContextChars = Math.max(maxContextChars, JSON.stringify(messages).length)
      }
      const segment = uniqueSegment(runId, calls, segmentLength)
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
          yield { type: 'text', delta: segment }
          yield { type: 'finish', finishReason: 'stop' }
        }
      }
    },
    toolExecutor: async () => '',
    getConfig: () => config,
    publishLongwriteArtifact: async ({ runId: artifactRunId, content }) => ({ displayName: `${artifactRunId}.md`, relativePath: `C:/r55-docs/${artifactRunId}.md` }),
    onEvent: () => undefined,
    onRunUpdate: () => undefined
  })
  await engine.start({ sessionId: `${runId}-session`, runId, config })
  await store.appendTurn({ turnId: `${runId}-user`, runId, turnSeq: 1, role: 'user', content: `写 ${targetChars} 字`, createdAt: 1700000000001 })
  await engine.step(runId)
  const state = await engine.getState(runId)
  const chars = state.turns.filter((turn) => turn.role === 'assistant').reduce((sum, turn) => sum + cp(turn.content), 0)
  const artifacts = await store.getArtifactsByRun(runId)
  const rawCheckpoint = await store.getRunEvidence(runId, 'longwrite_checkpoint')
  return { status: state.run?.status ?? 'missing', errorCode: state.run?.errorCode, errorMessage: state.run?.errorMessage, chars, calls, maxContextChars, artifact: artifacts.find((item) => item.artifactType === 'manuscript'), checkpoint: rawCheckpoint ? JSON.parse(rawCheckpoint.json) as Record<string, unknown> : null }
}

for (const targetChars of [8000, 20000, 50000, 100000]) {
  const result = await runSynthetic(targetChars)
  check(`R55-ENGINE-${targetChars} 短响应自动续写至完成`, result.status === 'completed' && result.chars >= targetChars, JSON.stringify(result))
  check(`R55-ENGINE-${targetChars} provider working set 有界`, result.maxContextChars < 30000, `${result.maxContextChars}`)
  check(`R55-ENGINE-${targetChars} 目标窗口生成稿件文件`, result.artifact?.artifactType === 'manuscript' && result.artifact.charCount >= targetChars, JSON.stringify(result.artifact))
  check(`R55-ENGINE-${targetChars} durable checkpoint 存在`, result.checkpoint !== null && typeof result.checkpoint?.currentChapter === 'number', JSON.stringify(result.checkpoint))
}

// Accelerated large-target smoke runs use ~30k unique code points per writer
// segment.  They still traverse the real engine, completion gate, artifact
// delivery, and bounded working-set path without requiring thousands of mock
// provider calls.
const acceleratedResults: Array<{ targetChars: number; result: Awaited<ReturnType<typeof runSynthetic>> }> = []
for (const targetChars of [500000, 2000000]) {
  const result = await runSynthetic(targetChars, 30000)
  acceleratedResults.push({ targetChars, result })
  const detail = JSON.stringify({ status: result.status, errorCode: result.errorCode, errorMessage: result.errorMessage, chars: result.chars, calls: result.calls, maxContextChars: result.maxContextChars, artifactChars: result.artifact?.charCount ?? 0 })
  check(`R55-ENGINE-ACCEL-${targetChars} 30k 分段自动完成并交付`, result.status === 'completed' && result.chars >= targetChars && (result.artifact?.charCount ?? 0) >= targetChars, detail)
  check(`R55-ENGINE-ACCEL-${targetChars} provider working set 有界`, result.maxContextChars < 30000, `${result.maxContextChars}`)
}
const accelerated500k = acceleratedResults.find((entry) => entry.targetChars === 500000)?.result
const accelerated2m = acceleratedResults.find((entry) => entry.targetChars === 2000000)?.result
check('R55-ENGINE-ACCEL 调用数随目标规模增长', Boolean(accelerated500k && accelerated2m && accelerated500k.calls > 0 && accelerated2m.calls > accelerated500k.calls), JSON.stringify({ calls500k: accelerated500k?.calls, calls2m: accelerated2m?.calls }))

{
  const runId = 'r55-recovery'
  const targetChars = 8000
  const config = makeConfig(runId, targetChars)
  const store = new MemoryStore()
  await store.createRun({ runId, sessionId: `${runId}-session`, status: 'recoverable', phase: 'writing', startedAt: 1700000000000, updatedAt: 1700000000001, configJson: JSON.stringify(config) })
  await store.appendTurn({ turnId: `${runId}-user`, runId, turnSeq: 1, role: 'user', content: '恢复后继续写作', createdAt: 1700000000001 })
  await store.appendTurn({ turnId: `${runId}-partial`, runId, turnSeq: 2, role: 'assistant', content: uniqueSegment(runId, 1), createdAt: 1700000000002 })
  let calls = 1
  const engine = createAgentRunEngine({
    store,
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
        calls++
        yield { type: 'text', delta: uniqueSegment(runId, calls) }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => config,
    publishLongwriteArtifact: async ({ runId: artifactRunId }) => ({ displayName: `${artifactRunId}.md`, relativePath: `C:/r55-docs/${artifactRunId}.md` }),
    onEvent: () => undefined,
    onRunUpdate: () => undefined
  })
  await engine.restore(runId)
  await engine.step(runId)
  const state = await engine.getState(runId)
  const chars = state.turns.filter((turn) => turn.role === 'assistant').reduce((sum, turn) => sum + cp(turn.content), 0)
  check('R55-RECOVERY 恢复后沿用 durable partial 并自动完成', state.run?.status === 'completed' && chars >= targetChars && calls > 1, JSON.stringify({ status: state.run?.status, chars, calls }))
}

console.log(`R55 longform core: ${passed} PASS / ${failed} FAIL`)
if (failed > 0) process.exitCode = 1
