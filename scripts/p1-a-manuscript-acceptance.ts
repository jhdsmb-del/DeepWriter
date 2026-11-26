import { createHash } from 'node:crypto'
import { createRepository, type ManuscriptSegmentRow, type Repository, type RunRow, type TurnRow } from '../src/main/db/repository'
import { buildExecutionSnapshot } from '../src/main/executionSnapshot'
import { createAgentRunEngine } from '../src/main/jobs/AgentRunEngine'
import type { ArtifactRecord, RecoveryDecisionRecord, RunConfig, RunRecord, RunStorePort, ToolCallRecord, TurnRecord } from '../src/main/jobs/types'
import type { ManuscriptAcceptanceInput, ManuscriptSegment, Settings } from '../src/shared/types'
import { codePointLength } from '../src/shared/textMetrics'
import { classifyAssistantOutput, makeManuscriptSegment, manuscriptAcceptanceEvidenceIdentity, manuscriptSegmentHash } from '../src/main/manuscript'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function asRow(segment: ManuscriptSegment): ManuscriptSegmentRow {
  return {
    segment_id: segment.segmentId,
    run_id: segment.runId,
    session_id: segment.sessionId,
    source_turn_id: segment.sourceTurnId ?? null,
    section_id: segment.sectionId ?? null,
    scene_id: segment.sceneId ?? null,
    chunk_index: segment.chunkIndex,
    revision: segment.revision,
    status: segment.status,
    kind: segment.kind,
    content: segment.content,
    content_hash: segment.contentHash,
    char_count: segment.charCount,
    supersedes_segment_id: segment.supersedesSegmentId ?? null,
    created_at: segment.createdAt,
    updated_at: segment.updatedAt,
    accepted_at: segment.acceptedAt ?? null
  }
}

function runRow(runId: string, sessionId: string, configJson = '{}'): RunRow {
  return {
    run_id: runId,
    session_id: sessionId,
    status: 'recoverable',
    phase: 'writing',
    started_at: 1,
    updated_at: 1,
    config_json: configJson,
    parent_run_id: null,
    error_code: null,
    error_message: null
  }
}

function turnRow(runId: string, turnId: string, turnSeq: number, role: TurnRow['role'], content: string): TurnRow {
  return {
    turn_id: turnId,
    run_id: runId,
    turn_seq: turnSeq,
    role,
    content,
    reasoning_content: null,
    tool_calls_json: null,
    tool_result_json: null,
    plan_state: null,
    created_at: turnSeq
  }
}

function makeReadyEvidence(input: {
  runId: string
  segment: ManuscriptSegment
  evidenceRefs?: Record<string, string | null>
  sceneId?: string | null
}): { input: ManuscriptAcceptanceInput; json: string } {
  const sceneId = input.sceneId ?? null
  const evidenceRefs = input.evidenceRefs ?? {}
  const evidenceIdentity = manuscriptAcceptanceEvidenceIdentity({
    runId: input.runId,
    segmentId: input.segment.segmentId,
    candidateHash: input.segment.contentHash,
    candidateCharCount: input.segment.charCount,
    evidenceRevision: input.segment.revision,
    sceneId,
    evidenceRefs
  })
  const json = JSON.stringify({
    schemaVersion: 1,
    runId: input.runId,
    segmentId: input.segment.segmentId,
    candidateHash: input.segment.contentHash,
    candidateCharCount: input.segment.charCount,
    evidenceRevision: input.segment.revision,
    evidenceIdentity,
    sceneId,
    evidenceRefs
  })
  return {
    input: {
      runId: input.runId,
      segmentId: input.segment.segmentId,
      expectedContentHash: input.segment.contentHash,
      expectedCharCount: input.segment.charCount,
      evidenceRevision: input.segment.revision,
      evidenceIdentity,
      sceneId,
      acceptedAt: 100
    },
    json
  }
}

function makeSegment(input: {
  runId: string
  sessionId: string
  turnId: string
  chunkIndex: number
  content: string
  status?: ManuscriptSegment['status']
  kind?: ManuscriptSegment['kind']
  sceneId?: string
}): ManuscriptSegment {
  return makeManuscriptSegment({
    runId: input.runId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    chunkIndex: input.chunkIndex,
    content: input.content,
    status: input.status ?? 'candidate',
    kind: input.kind ?? 'prose',
    ...(input.sceneId ? { sceneId: input.sceneId } : {}),
    createdAt: input.chunkIndex,
    updatedAt: input.chunkIndex
  })
}

async function acceptanceTransactionCase(): Promise<void> {
  const tempRoot = `${process.env.TEMP ?? process.env.TMP ?? '.'}/deepwriter-p1-a-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const dbPath = `${tempRoot}/acceptance.sqlite`
  const runId = 'p1-a-acceptance'
  const sessionId = 'p1-a-session'
  let repository: Repository | null = null
  try {
    const fs = await import('node:fs/promises')
    await fs.mkdir(tempRoot, { recursive: true })
    repository = createRepository(dbPath)
    repository.open()
    repository.createSession(sessionId, 'P1-A acceptance', 'fixture')
    repository.createRun(runRow(runId, sessionId))

    const first = makeSegment({ runId, sessionId, turnId: 'p1-a-turn-1', chunkIndex: 1, content: '第一候选完整收束。' })
    const second = makeSegment({ runId, sessionId, turnId: 'p1-a-turn-2', chunkIndex: 2, content: '第二候选也完整收束！' })
    const meta = makeSegment({ runId, sessionId, turnId: 'p1-a-turn-3', chunkIndex: 3, content: '说明：这不是正文。' })
    const scene = makeSegment({ runId, sessionId, turnId: 'p1-a-turn-4', chunkIndex: 4, content: '场景候选完整收束。', sceneId: 'scene-a' })
    for (const segment of [first, second, meta, scene]) {
      repository.appendTurn(turnRow(runId, segment.sourceTurnId ?? segment.segmentId, segment.chunkIndex, 'assistant', segment.content))
      repository.saveManuscriptSegment(asRow(segment))
    }

    const evidenceJson = JSON.stringify({ stage: 'strong-passed', status: 'passed', segmentId: first.segmentId, latestSegmentHash: first.contentHash, fullSegment: first.content })
    const evidenceKind = 'strong_constraint_latest'
    repository.saveRunEvidence(runId, evidenceKind, evidenceJson)
    const prepared = makeReadyEvidence({
      runId,
      segment: first,
      evidenceRefs: { [evidenceKind]: manuscriptSegmentHash(evidenceJson) }
    })
    repository.saveRunEvidence(runId, 'manuscript_acceptance_ready', prepared.json)
    repository.acceptManuscriptSegment(prepared.input)

    let rows = repository.getManuscriptSegmentsByRun(runId)
    check('P1-A 单候选事务只接受明确 segmentId', rows.find((row) => row.segment_id === first.segmentId)?.status === 'accepted' && rows.find((row) => row.segment_id === second.segmentId)?.status === 'candidate')
    check('P1-A 其他完整 candidate 保持未接受', rows.filter((row) => row.status === 'candidate').map((row) => row.segment_id).includes(second.segmentId), JSON.stringify(rows.map((row) => ({ id: row.segment_id, status: row.status }))))

    repository.acceptManuscriptSegment(prepared.input)
    rows = repository.getManuscriptSegmentsByRun(runId)
    check('P1-A 同一 evidence 重放幂等且不重复接受', rows.filter((row) => row.status === 'accepted').length === 1 && rows.find((row) => row.segment_id === first.segmentId)?.accepted_at === 100)

    const secondInput = makeReadyEvidence({ runId, segment: second }).input
    let wrongCandidateRejected = false
    try { repository.acceptManuscriptSegment(secondInput) } catch { wrongCandidateRejected = true }
    check('P1-A 未被当前 evidence 验证的第二 candidate 拒绝', wrongCandidateRejected && repository.getManuscriptSegmentsByRun(runId).find((row) => row.segment_id === second.segmentId)?.status === 'candidate')

    const badHashInput = { ...prepared.input, expectedContentHash: manuscriptSegmentHash('篡改。') }
    let wrongHashRejected = false
    try { repository.acceptManuscriptSegment(badHashInput) } catch { wrongHashRejected = true }
    check('P1-A expected contentHash 不匹配时拒绝', wrongHashRejected && repository.getManuscriptSegmentsByRun(runId).find((row) => row.segment_id === first.segmentId)?.status === 'accepted')

    const tamperedEvidence = JSON.stringify({ stage: 'strong-passed', segmentId: first.segmentId, fullSegment: '证据被改写。' })
    repository.saveRunEvidence(runId, evidenceKind, tamperedEvidence)
    let staleEvidenceRejected = false
    try { repository.acceptManuscriptSegment(prepared.input) } catch { staleEvidenceRejected = true }
    check('P1-A evidence revision/hash 变化时拒绝旧验收请求', staleEvidenceRejected && repository.getManuscriptSegmentsByRun(runId).find((row) => row.segment_id === first.segmentId)?.status === 'accepted')

    const foreignEvidence = JSON.stringify({ stage: 'strong-passed', status: 'passed', latestSegmentHash: second.contentHash })
    repository.saveRunEvidence(runId, evidenceKind, foreignEvidence)
    const foreign = makeReadyEvidence({ runId, segment: first, evidenceRefs: { [evidenceKind]: manuscriptSegmentHash(foreignEvidence) } })
    repository.saveRunEvidence(runId, 'manuscript_acceptance_ready', foreign.json)
    let foreignRejected = false
    try { repository.acceptManuscriptSegment(foreign.input) } catch { foreignRejected = true }
    check('P1-A evidence 内容绑定另一 candidate 时拒绝', foreignRejected && repository.getManuscriptSegmentsByRun(runId).find((row) => row.segment_id === first.segmentId)?.status === 'accepted')

    const metaReady = makeReadyEvidence({ runId, segment: meta })
    repository.saveRunEvidence(runId, 'manuscript_acceptance_ready', metaReady.json)
    let metaRejected = false
    try { repository.acceptManuscriptSegment(metaReady.input) } catch { metaRejected = true }
    check('P1-A row.content 重新分类后拒绝伪标 prose/meta', metaRejected && repository.getManuscriptSegmentsByRun(runId).find((row) => row.segment_id === meta.segmentId)?.status === 'candidate')

    const sceneReady = makeReadyEvidence({ runId, segment: scene, sceneId: null })
    repository.saveRunEvidence(runId, 'manuscript_acceptance_ready', sceneReady.json)
    let sceneRejected = false
    try { repository.acceptManuscriptSegment(sceneReady.input) } catch { sceneRejected = true }
    check('P1-A sceneId 不一致时拒绝并保留 candidate', sceneRejected && repository.getManuscriptSegmentsByRun(runId).find((row) => row.segment_id === scene.segmentId)?.status === 'candidate')
  } finally {
    repository?.close()
    const fs = await import('node:fs/promises')
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

class RestartStore implements RunStorePort {
  private readonly runs = new Map<string, RunRecord>()
  private readonly turns = new Map<string, TurnRecord[]>()
  private readonly segments = new Map<string, ManuscriptSegment[]>()
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
  async saveManuscriptSegment(segment: ManuscriptSegment): Promise<void> {
    const list = this.segments.get(segment.runId) ?? []
    const index = list.findIndex((item) => item.segmentId === segment.segmentId)
    if (index >= 0) list[index] = { ...segment }
    else list.push({ ...segment })
    list.sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt)
    this.segments.set(segment.runId, list)
  }
  async getManuscriptSegments(runId: string): Promise<ManuscriptSegment[]> { return (this.segments.get(runId) ?? []).map((segment) => ({ ...segment })) }
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

function boundaryText(target: number): string {
  const points = Array.from('灯塔')
  while (points.length < target - 1) points.push(String.fromCodePoint(0x10000 + (points.length % 0xd0000)))
  points.length = Math.max(0, target - 1)
  points.push('。')
  return points.join('')
}

function engineConfig(runId: string, targetChars: number): RunConfig {
  const settings = {
    model: 'p1-a-synthetic',
    baseUrl: 'http://127.0.0.1',
    maxTokens: 4096,
    temperature: 0.7,
    topP: 0.9,
    thinkingEnabled: false,
    reasoningEffort: 'low',
    workDir: 'C:/p1-a-work',
    docDir: 'C:/p1-a-docs',
    novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' },
    historyBudgetTokens: 60000,
    strongConstraintEnabled: true,
    completionTokenBudget: 0,
    completionWallClockMs: 0
  } as unknown as Settings
  const snapshot = buildExecutionSnapshot({
    payload: { id: runId, mode: 'longwrite', workspace: 'novel', longMode: true, targetChars, phase: 'execute', text: '继续写作' },
    settings,
    sessionId: `${runId}-session`,
    memory: { projectPath: '', projectContent: '', userContent: '' },
    now: 1700000000000
  }) as unknown as RunConfig
  // This fixture starts after writer/pipeline acceptance. Leaving a pipeline
  // evidence record out intentionally exercises the manuscript recovery path.
  delete snapshot.writingPipeline
  return snapshot
}

async function runBoundaryCase(targetChars: number): Promise<void> {
  const runId = `p1-a-boundary-${targetChars}`
  const sessionId = `${runId}-session`
  const content = boundaryText(targetChars)
  const config = engineConfig(runId, targetChars)
  const strong = config.strongConstraints as { enabled?: boolean; hash?: string } | undefined
  const store = new RestartStore()
  const run: RunRecord = {
    runId,
    sessionId,
    status: 'recoverable',
    phase: 'writing',
    startedAt: 1,
    updatedAt: 1,
    configJson: JSON.stringify(config)
  }
  await store.createRun(run)
  const assistantTurn: TurnRecord = { runId, turnId: `${runId}:assistant`, turnSeq: 2, role: 'assistant', content, createdAt: 2 }
  await store.appendTurn({ runId, turnId: `${runId}:user`, turnSeq: 1, role: 'user', content: '继续写作', createdAt: 1 })
  await store.appendTurn(assistantTurn)
  const segment = makeSegment({ runId, sessionId, turnId: assistantTurn.turnId, chunkIndex: 2, content, status: 'accepted' })
  await store.saveManuscriptSegment(segment)
  await store.saveRunEvidence(runId, 'strong_constraint_latest', JSON.stringify({
    schemaVersion: 1,
    status: 'passed',
    constraintHash: strong?.hash,
    draftHash: manuscriptSegmentHash(content),
    latestSegmentHash: manuscriptSegmentHash(content),
    // Deliberately record the full code-point segment; a 12000-code-point
    // regression would make the 12001/30000 cases fail closed on restore.
    evidenceChars: codePointLength(content)
  }))
  let providerCalls = 0
  const makeEngine = () => createAgentRunEngine({
    store,
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'finish'; finishReason: 'stop' }> {
        providerCalls += 1
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => config,
    onEvent: () => undefined,
    onRunUpdate: () => undefined,
    publishLongwriteArtifact: async () => ({ displayName: `${runId}.md`, relativePath: `${runId}.md` })
  })

  // Hydrate once, then create a fresh engine and hydrate again before the
  // actual step. This models a process restart while retaining only durable
  // run/turn/segment/evidence state.
  await makeEngine().restore(runId)
  const restarted = makeEngine()
  await restarted.restore(runId)
  await restarted.step(runId)
  const state = await restarted.getState(runId)
  const rows = await store.getManuscriptSegments(runId)
  const artifacts = await store.getArtifactsByRun(runId)
  const artifact = artifacts.find((item) => item.artifactType === 'manuscript' && item.status === 'completed')
  const accepted = rows.filter((row) => row.status === 'accepted' && row.kind === 'prose').map((row) => row.content).join('')
  check(`P1-A 完整段 hash 边界 ${targetChars} code points 重启后仍通过`, state.run?.status === 'completed' && providerCalls === 0 && accepted === content, JSON.stringify({ status: state.run?.status, providerCalls, chars: codePointLength(accepted) }))
  check(`P1-A ${targetChars} code points artifact 与 accepted 同源`, artifact?.hash === manuscriptSegmentHash(content) && artifact?.charCount === targetChars && artifact?.content === content, JSON.stringify({ artifactHash: artifact?.hash, expected: manuscriptSegmentHash(content), artifactChars: artifact?.charCount }))
}

async function main(): Promise<void> {
  console.log('P1-A manuscript acceptance / full-segment evidence')
  await acceptanceTransactionCase()
  for (const boundary of [11999, 12000, 12001, 30000]) await runBoundaryCase(boundary)
  console.log(`\nP1-A manuscript acceptance: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

void main().catch((error) => {
  console.error('P1-A manuscript acceptance 执行异常：', error)
  process.exitCode = 2
})
