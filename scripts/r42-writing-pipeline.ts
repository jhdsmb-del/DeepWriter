import { createHash } from 'node:crypto'
import { createAgentRunEngine } from '../src/main/jobs/AgentRunEngine'
import { buildExecutionSnapshot } from '../src/main/executionSnapshot'
import type { ArtifactRecord, RecoveryDecisionRecord, RunRecord, RunStorePort, ToolCallRecord, TurnRecord } from '../src/main/jobs/types'
import type { ManuscriptAcceptanceInput, ManuscriptSegment } from '../src/shared/types'
import { codePointLength } from '../src/shared/textMetrics'

let pass = 0
let fail = 0
function check(id: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`PASS ${id}`) } else { fail++; console.error(`FAIL ${id}${detail ? `: ${detail}` : ''}`) }
}

class MemoryStore implements RunStorePort {
  runs = new Map<string, RunRecord>()
  turns = new Map<string, TurnRecord[]>()
  tools = new Map<string, ToolCallRecord[]>()
  evidence = new Map<string, { json: string; created_at: number }>()
  evaluations = new Map<string, { revision: number; state: string; json: string }>()
  attempts = new Map<string, Array<{ attempt: number; json: string; createdAt: number }>>()
  usage: Array<{ runId: string; callType: string; model: string; inputTokens: number; outputTokens: number; cacheHit: number; cacheMiss: number; createdAt: number }> = []
  artifacts = new Map<string, ArtifactRecord[]>()
  segments = new Map<string, ManuscriptSegment[]>()
  async createRun(run: RunRecord): Promise<void> { this.runs.set(run.runId, { ...run }) }
  async getRun(id: string): Promise<RunRecord | null> { return this.runs.get(id) ?? null }
  async updateRun(id: string, patch: Partial<RunRecord>): Promise<void> { const cur = this.runs.get(id); if (cur) this.runs.set(id, { ...cur, ...patch }) }
  async listActiveRuns(): Promise<RunRecord[]> { return [...this.runs.values()].filter((r) => !['completed', 'failed', 'cancelled'].includes(r.status)) }
  async appendTurn(turn: TurnRecord): Promise<void> { const list = this.turns.get(turn.runId) ?? []; const at = list.findIndex((x) => x.turnId === turn.turnId); if (at >= 0) list[at] = { ...turn }; else list.push({ ...turn }); list.sort((a, b) => a.turnSeq - b.turnSeq); this.turns.set(turn.runId, list) }
  async getTurns(id: string): Promise<TurnRecord[]> { return (this.turns.get(id) ?? []).map((x) => ({ ...x })) }
  async saveAssistantTurnWithSegment(turn: TurnRecord, segment: ManuscriptSegment): Promise<void> { await this.appendTurn(turn); await this.saveManuscriptSegment(segment) }
  async saveManuscriptSegment(segment: ManuscriptSegment): Promise<void> {
    const list = this.segments.get(segment.runId) ?? []
    const at = list.findIndex((item) => item.segmentId === segment.segmentId)
    const existing = list[at]
    if (existing && ['accepted', 'rejected', 'superseded'].includes(existing.status)) {
      const same = existing.status === segment.status && existing.kind === segment.kind && existing.content === segment.content &&
        existing.contentHash === segment.contentHash && existing.charCount === segment.charCount && existing.revision === segment.revision
      if (!same) throw new Error('manuscript_segment_immutable')
      return
    }
    if (at >= 0) list[at] = { ...segment }
    else list.push({ ...segment })
    this.segments.set(segment.runId, list)
  }
  async getManuscriptSegments(id: string): Promise<ManuscriptSegment[]> { return (this.segments.get(id) ?? []).map((segment) => ({ ...segment })) }
  async acceptManuscriptSegment(input: ManuscriptAcceptanceInput): Promise<void> {
    const list = this.segments.get(input.runId) ?? []
    const at = list.findIndex((segment) => segment.segmentId === input.segmentId)
    const candidate = list[at]
    if (!candidate || candidate.status !== 'candidate' || candidate.contentHash !== input.expectedContentHash || candidate.charCount !== input.expectedCharCount || candidate.revision !== input.evidenceRevision || (candidate.sceneId ?? null) !== input.sceneId) throw new Error('test_acceptance_mismatch')
    const superseded = new Set<string>()
    let ancestor = candidate.supersedesSegmentId
    while (ancestor) {
      superseded.add(ancestor)
      ancestor = list.find((segment) => segment.segmentId === ancestor)?.supersedesSegmentId
    }
    if (input.supersedesAcceptedSegmentId) superseded.add(input.supersedesAcceptedSegmentId)
    this.segments.set(input.runId, list.map((segment, index) => {
      if (index === at) return { ...segment, status: 'accepted', acceptedAt: input.acceptedAt, updatedAt: input.acceptedAt }
      if (superseded.has(segment.segmentId)) return { ...segment, status: 'superseded', acceptedAt: undefined, updatedAt: input.acceptedAt }
      return segment
    }))
  }
  async upsertToolCall(tc: ToolCallRecord): Promise<void> { const list = this.tools.get(tc.runId) ?? []; const at = list.findIndex((x) => x.toolCallId === tc.toolCallId); if (at >= 0) list[at] = tc; else list.push(tc); this.tools.set(tc.runId, list) }
  async getToolCalls(id: string): Promise<ToolCallRecord[]> { return this.tools.get(id) ?? [] }
  async appendRecoveryDecision(_d: RecoveryDecisionRecord): Promise<void> {}
  async getRecoveryDecisions(_id: string): Promise<RecoveryDecisionRecord[]> { return [] }
  async saveArtifact(a: ArtifactRecord): Promise<void> { this.artifacts.set(a.runId, [...(this.artifacts.get(a.runId) ?? []), a]) }
  async getArtifactsByRun(id: string): Promise<ArtifactRecord[]> { return this.artifacts.get(id) ?? [] }
  async getArtifactContent(_hash: string): Promise<string | null> { return null }
  async saveCompletionEvaluation(id: string, revision: number, state: string, json: string): Promise<void> { this.evaluations.set(id, { revision, state, json }) }
  getLatestCompletionEvaluation(id: string): { revision: number; state: string; json: string } | null { return this.evaluations.get(id) ?? null }
  async appendCompletionAttempt(id: string, attempt: number, json: string): Promise<void> { this.attempts.set(id, [...(this.attempts.get(id) ?? []), { attempt, json, createdAt: Date.now() }]) }
  async getCompletionAttempts(id: string): Promise<Array<{ attempt: number; json: string; createdAt: number }>> { return this.attempts.get(id) ?? [] }
  async saveRunEvidence(id: string, kind: string, json: string): Promise<void> { this.evidence.set(`${id}:${kind}`, { json, created_at: Date.now() }) }
  async getRunEvidence(id: string, kind: string): Promise<{ json: string; created_at: number } | null> { return this.evidence.get(`${id}:${kind}`) ?? null }
  async getUsageTotalTokens(id: string): Promise<number> { return this.usage.filter((u) => u.runId === id).reduce((n, u) => n + u.inputTokens + u.outputTokens, 0) }
  async appendUsage(u: { runId: string; callType: string; model: string; inputTokens: number; outputTokens: number; cacheHit: number; cacheMiss: number; createdAt: number }): Promise<void> { this.usage.push(u) }
}

function fillUnique(prefix: string, count: number, seed = 0): string {
  const rest = Math.max(0, count - codePointLength(prefix))
  const chars = Array.from({ length: rest }, (_, i) => String.fromCodePoint(0x4e00 + ((seed + i) % 18000))).join('')
  return Array.from(prefix + chars).slice(0, count).join('')
}

function fillUniqueSentence(prefix: string, count: number, seed = 0): string {
  if (count <= 0) return ''
  const chars = Array.from(fillUnique(prefix, count, seed))
  chars[chars.length - 1] = '。'
  return chars.join('')
}

async function publishLongwriteArtifact(input: { runId: string }): Promise<{ displayName: string; relativePath: string }> {
  return { displayName: `${input.runId}.md`, relativePath: `${input.runId}.md` }
}

function config(id: string, input?: { mode?: 'agent' | 'longwrite'; target?: number; theme?: 'strong' | 'guided' | 'off'; anti?: boolean; avoid?: string }): Record<string, any> {
  const mode = input?.mode ?? 'longwrite'
  const theme = input?.theme ?? 'strong'
  const anti = input?.anti ?? true
  return buildExecutionSnapshot({
    payload: {
      id, mode, workspace: mode === 'longwrite' ? 'novel' : 'chat', longMode: mode === 'longwrite', targetChars: input?.target ?? (mode === 'longwrite' ? 400 : 0),
      text: '写一个发生在海边灯塔的守夜人悬疑故事，400字',
      strongConstraints: mode === 'longwrite' ? { task: '写一个发生在海边灯塔的守夜人悬疑故事，400字', enabled: theme !== 'off' || anti, level: 'balanced', themeLockMode: theme, expressionFreedom: 'high', antiMoralizingEnabled: anti, perspective: 'auto', genre: '悬疑故事', mustKeep: '', avoid: input?.avoid ?? '' } : undefined
    },
    settings: {
      model: 'synthetic-r42', baseUrl: 'http://127.0.0.1:1', maxTokens: 8192, temperature: 1, topP: 1, thinkingEnabled: false, reasoningEffort: 'high', workDir: 'C:/w', docDir: 'C:/d', novelMode: false,
      galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 64000, completionTokenBudget: 200000, completionWallClockMs: 0,
      strongConstraintEnabled: theme !== 'off', strongConstraintLevel: 'balanced', themeLockMode: theme, expressionFreedom: 'high', antiMoralizingEnabled: anti,
      strongConstraintPerspective: 'auto', strongConstraintGenre: '悬疑故事', strongConstraintMustKeep: '', strongConstraintAvoid: input?.avoid ?? ''
    },
    sessionId: `${id}-session`, memory: { projectPath: '', projectContent: '', userContent: '' }, now: 1700000000000
  })
}

async function runCase(name: string, opts?: { editorInvalid?: boolean; recheckSoft?: boolean; mode?: 'agent' | 'longwrite'; theme?: 'strong' | 'guided' | 'off'; anti?: boolean; avoid?: string }): Promise<{ store: MemoryStore; state: any; calls: string[]; rendered: string; phases: Array<{ title?: string; detail?: string }>; config: Record<string, any> }> {
  const runId = `r42-${name}`
  const cfg = config(runId, { mode: opts?.mode, theme: opts?.theme, anti: opts?.anti, avoid: opts?.avoid })
  const store = new MemoryStore()
  const calls: string[] = []
  const phases: Array<{ title?: string; detail?: string }> = []
  let criticRound = 0
  let rendered = ''
  const goodPrefix = fillUnique('海边灯塔的守夜人把旧钥匙压在掌心，潮声从门缝里一阵阵涌来。', 400, 300)
  const badTail = '人生的意义在于不断前进。这告诉我们，每个人都应该超越眼前的小事，唯有坚持才能抵达彼岸。'
  const writerText = modeText(cfg.runMode, cfg.deepWrite.targetChars, goodPrefix, badTail)
  const engine = createAgentRunEngine({
    store,
    publishLongwriteArtifact,
    modelCall: async (request) => {
      const purpose = request.purpose ?? 'writer'
      calls.push(purpose)
      let output: string
      if (purpose === 'writer') output = writerText
      else if (purpose === 'critic') {
        criticRound++
        const body = JSON.parse(request.messages.find((m) => m.role === 'user')?.content ?? '{}') as { candidateHash?: string; candidate?: string }
        const chars = Array.from(body.candidate ?? '')
        const issues = opts?.recheckSoft && criticRound > 1
          ? [{ issueId: 'recheck-soft', code: 'preachy_template', severity: 'advisory', basis: 'quality', startCp: Math.max(0, chars.length - 8), endCp: chars.length, quote: chars.slice(-8).join(''), reason: '模型仍有软建议', repairIntent: '继续改写' }]
          : []
        output = JSON.stringify({ schemaVersion: 1, candidateHash: body.candidateHash, issues })
      } else if (opts?.editorInvalid) output = '{not-json'
      else {
        const body = JSON.parse(request.messages.find((m) => m.role === 'user')?.content ?? '{}') as any
        const issue = body.issue
        const replacement = fillUniqueSentence('灯影掠过潮面，他把那句未出口的话留给了风。', issue.endCp - issue.startCp, 9000)
        output = JSON.stringify({ schemaVersion: 1, candidateHash: body.candidateHash, patches: [{ issueId: issue.issueId, startCp: issue.startCp, endCp: issue.endCp, quote: issue.quote, replacement }] })
      }
      return { async *[Symbol.asyncIterator](): AsyncGenerator<any> { yield { type: 'text', delta: output }; yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, cacheHitTokens: 3, cacheMissTokens: 8, kind: 'actual' } }; yield { type: 'finish', finishReason: 'stop' } } }
    },
    toolExecutor: async () => '', getConfig: () => cfg, onRunUpdate: () => undefined,
    onEvent: (_id, event) => {
      if (event.type === 'turn' && event.turn.role === 'assistant') rendered = event.turn.content
      if (event.type === 'content_replace') rendered = event.content
      if (event.type === 'phase') phases.push({ title: event.title, detail: event.detail })
    }
  })
  await engine.start({ sessionId: `${runId}-session`, runId, config: cfg })
  await store.appendTurn({ turnId: `${runId}-user`, runId, turnSeq: 1, role: 'user', content: '写灯塔故事', createdAt: 1700000000001 })
  await engine.step(runId)
  return { store, state: await engine.getState(runId), calls, rendered, phases, config: cfg }
}

/**
 * 反例：首轮局部修订故意缩短正文，迫使完成控制器再开一个 writer turn；
 * 第二轮只返回跑题/说教坏尾，第二次 editor 再故意给坏 JSON。正确实现必须
 * 重新 critic 新 turn 并暂停，不能沿用首轮 passed evidence 假完成。
 */
async function runShortEditContinuation(kind: 'bad-hard' | 'good-exact'): Promise<{ runId: string; store: MemoryStore; state: any; calls: string[] }> {
  const runId = `r42-short-edit-${kind}`
  const target = kind === 'good-exact' ? 4000 : 400
  const cfg = config(runId, { target, ...(kind === 'bad-hard' ? { avoid: '成功学' } : {}) })
  const store = new MemoryStore()
  const calls: string[] = []
  let writerRound = 0
  let editorRound = 0
  let remainingAfterEdit = 0
  const goodPrefix = fillUnique('海边灯塔的守夜人摸到门闩上的盐粒，潮声正在楼梯下转弯。', target, 1200)
  const sermon = '人生的意义在于不断前进。这告诉我们，唯有坚持才能抵达彼岸。'
  const firstWriter = modeText('longwrite', target, goodPrefix, sermon)
  const engine = createAgentRunEngine({
    store,
    publishLongwriteArtifact,
    modelCall: async (request) => {
      const purpose = request.purpose ?? 'writer'
      calls.push(purpose)
      let output = ''
      if (purpose === 'writer') {
        writerRound++
        output = writerRound === 1
          ? firstWriter
          : kind === 'bad-hard'
            ? '成功学口号突然盖过灯塔和守夜人的处境。'
            : fillUniqueSentence('潮声贴着石阶退去，守夜人重新扶正灯罩。', Math.max(1, remainingAfterEdit), 17000)
      } else if (purpose === 'critic') {
        const body = JSON.parse(request.messages.find((m) => m.role === 'user')?.content ?? '{}') as { candidateHash?: string }
        output = JSON.stringify({ schemaVersion: 1, candidateHash: body.candidateHash, issues: [] })
      } else {
        editorRound++
        if (editorRound === 2) output = '{invalid-second-editor'
        else {
          const body = JSON.parse(request.messages.find((m) => m.role === 'user')?.content ?? '{}') as any
          const issue = body.issue
          // 明显短于命中 span，确保完成控制器必须再开 writer turn。
          const replacementLength = Math.max(1, Math.ceil((issue.endCp - issue.startCp) * 0.5))
          const replacement = fillUniqueSentence('灯影落在潮面。', replacementLength, 15000)
          remainingAfterEdit = Math.max(0, target - (target - (issue.endCp - issue.startCp) + replacementLength))
          output = JSON.stringify({ schemaVersion: 1, candidateHash: body.candidateHash, patches: [{ issueId: issue.issueId, startCp: issue.startCp, endCp: issue.endCp, quote: issue.quote, replacement }] })
        }
      }
      return { async *[Symbol.asyncIterator](): AsyncGenerator<any> { yield { type: 'text', delta: output }; yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, kind: 'actual' } }; yield { type: 'finish', finishReason: 'stop' } } }
    },
    toolExecutor: async () => '', getConfig: () => cfg, onEvent: () => undefined, onRunUpdate: () => undefined
  })
  await engine.start({ sessionId: `${runId}-session`, runId, config: cfg })
  await store.appendTurn({ turnId: `${runId}-user`, runId, turnSeq: 1, role: 'user', content: '写灯塔故事', createdAt: 1700000000001 })
  await engine.step(runId)
  return { runId, store, state: await engine.getState(runId), calls }
}

function modeText(mode: string, target: number, prefix: string, tail: string): string {
  if (mode !== 'longwrite') return '普通 Agent 回答。'
  const tailLength = codePointLength(tail)
  return `${Array.from(prefix).slice(0, Math.max(0, target - tailLength - 1)).join('')}\n${tail}`
}

async function main(): Promise<void> {
  const green = await runCase('green')
  const final = green.state.turns.filter((t: TurnRecord) => t.role === 'assistant').map((t: TurnRecord) => t.content).join('')
  check('engine-writer-critic-editor-order', green.calls.join(',') === 'writer,critic,editor,critic', green.calls.join(','))
  check('engine-final-exact-target', green.state.run?.status === 'completed' && codePointLength(final) === 400, `${green.state.run?.status}/${codePointLength(final)}`)
  check('engine-ui-durable-identical', green.rendered === final)
  check('engine-removes-only-bad-tail', final.startsWith('海边灯塔的守夜人') && !final.includes('人生的意义') && !final.includes('这告诉我们'))
  check('engine-critic-editor-not-turns', !green.state.turns.some((t: TurnRecord) => t.content.includes('candidateHash') || t.content.includes('schemaVersion')))
  check('engine-usage-ledger-three-call-types', ['kernel-chat', 'kernel-critic', 'kernel-editor'].every((kind) => green.store.usage.some((u) => u.callType === kind)), JSON.stringify(green.store.usage.map((u) => u.callType)))
  const ev = await green.store.getRunEvidence('r42-green', 'writing_pipeline_latest')
  const evidence = JSON.parse(ev?.json ?? '{}') as any
  check('engine-evidence-retention-and-hashes', evidence.stage === 'accepted' && evidence.retentionRate > 0.7 && evidence.prefixHash?.length === 64 && evidence.suffixHash?.length === 64)
  check('engine-run-inspector-facts', green.phases.some((p) => p.title === '局部修订中' && p.detail?.includes('只改命中范围')) && green.phases.some((p) => p.title === '局部修订完成' && p.detail?.includes('保留率')))

  // accepted 候选强杀恢复：必须先重入完成门，不得把已审正文当 partial 再写一轮。
  const greenRun = green.store.runs.get('r42-green')!
  green.store.runs.set('r42-green', { ...greenRun, status: 'recoverable', phase: 'paused' })
  let recoveryCalls = 0
  const recovered = createAgentRunEngine({
    store: green.store,
    publishLongwriteArtifact,
    modelCall: async () => { recoveryCalls++; throw new Error('accepted recovery must not call provider') },
    toolExecutor: async () => '', getConfig: () => green.config, onEvent: () => undefined, onRunUpdate: () => undefined
  })
  await recovered.restore('r42-green')
  await recovered.step('r42-green')
  const recoveredState = await recovered.getState('r42-green')
  check('engine-accepted-recovery-no-extra-provider', recoveredState.run?.status === 'completed' && recoveryCalls === 0, `status=${recoveredState.run?.status} error=${recoveredState.run?.errorCode}/${recoveredState.run?.errorMessage} calls=${recoveryCalls}`)

  const prepared = await runCase('prepared-base')
  const preparedTurn = prepared.state.turns.find((t: TurnRecord) => t.role === 'assistant') as TurnRecord
  const before = preparedTurn.content
  const chars = Array.from(before)
  // Keep the terminal punctuation intact: a prepared edit must still satisfy
  // the production complete-sentence acceptance boundary after restart.
  const startCp = Math.max(0, chars.length - 2)
  const replacement = chars[startCp] === '海' ? '风' : '海'
  const after = `${chars.slice(0, startCp).join('')}${replacement}${chars.slice(startCp + 1).join('')}`
  await prepared.store.saveRunEvidence('r42-prepared-base', 'writing_pipeline_latest', JSON.stringify({
    schemaVersion: 1, policyHash: prepared.config.writingPipeline.hash, turnId: preparedTurn.turnId, turnSeq: preparedTurn.turnSeq, round: 1,
    stage: 'edit_prepared', candidateHash: createHash('sha256').update(before).digest('hex'), beforeHash: createHash('sha256').update(before).digest('hex'), afterHash: createHash('sha256').update(after).digest('hex'), replaceRevision: 2,
    patch: { issueId: 'recover-q1', startCp, endCp: startCp + 1, quote: chars[startCp], replacement }, verified: true
  }))
  // edit_prepared is a pre-acceptance crash boundary. Rebuild the in-memory
  // Map as the database snapshot at that point: the source turn and verified
  // evidence exist, while its manuscript row is still a candidate. This is
  // deliberately a snapshot replacement, not saveManuscriptSegment(), since
  // production rows in terminal states cannot be changed back to candidates.
  const preparedSegmentsAtCrash = prepared.store.segments.get('r42-prepared-base') ?? []
  prepared.store.segments.set('r42-prepared-base', preparedSegmentsAtCrash.map((segment) => segment.sourceTurnId === preparedTurn.turnId
    ? { ...segment, status: 'candidate', acceptedAt: undefined, updatedAt: segment.createdAt }
    : { ...segment }))
  // The helper case completed a whole run, so remove completion/delivery
  // records that would not yet exist at this crash boundary.
  prepared.store.evaluations.delete('r42-prepared-base')
  prepared.store.artifacts.delete('r42-prepared-base')
  const preparedRun = prepared.store.runs.get('r42-prepared-base')!
  prepared.store.runs.set('r42-prepared-base', { ...preparedRun, status: 'recoverable', phase: 'paused' })
  const preparedBeforeRestoreSegments = await prepared.store.getManuscriptSegments('r42-prepared-base')
  const preparedBeforeRestoreTurns = await prepared.store.getTurns('r42-prepared-base')
  const preparedBeforeRestoreEvidence = JSON.parse((await prepared.store.getRunEvidence('r42-prepared-base', 'writing_pipeline_latest'))?.json ?? '{}') as { stage?: string; turnId?: string }
  check('engine-prepared-crash-snapshot-is-pre-acceptance',
    preparedBeforeRestoreSegments.some((segment) => segment.sourceTurnId === preparedTurn.turnId && segment.status === 'candidate' && segment.contentHash === createHash('sha256').update(before).digest('hex')) &&
      preparedBeforeRestoreTurns.some((turn) => turn.turnId === preparedTurn.turnId && turn.content === before) &&
      preparedBeforeRestoreEvidence.stage === 'edit_prepared' && preparedBeforeRestoreEvidence.turnId === preparedTurn.turnId,
    JSON.stringify({ segments: preparedBeforeRestoreSegments.map((segment) => ({ status: segment.status, hash: segment.contentHash })), evidence: preparedBeforeRestoreEvidence }))
  let preparedCalls = 0
  const preparedEngine = createAgentRunEngine({
    store: prepared.store,
    publishLongwriteArtifact,
    modelCall: async (request) => {
      preparedCalls++
      const body = JSON.parse(request.messages.find((m) => m.role === 'user')?.content ?? '{}') as { candidateHash: string }
      const output = JSON.stringify({ schemaVersion: 1, candidateHash: body.candidateHash, issues: [] })
      return { async *[Symbol.asyncIterator](): AsyncGenerator<any> { yield { type: 'text', delta: output }; yield { type: 'finish', finishReason: 'stop' } } }
    },
    toolExecutor: async () => '', getConfig: () => prepared.config, onEvent: () => undefined, onRunUpdate: () => undefined
  })
  await preparedEngine.restore('r42-prepared-base')
  const preparedAfterRestoreTurns = await prepared.store.getTurns('r42-prepared-base')
  const preparedAfterRestoreSegments = await prepared.store.getManuscriptSegments('r42-prepared-base')
  const preparedAfterRestoreEvidence = JSON.parse((await prepared.store.getRunEvidence('r42-prepared-base', 'writing_pipeline_latest'))?.json ?? '{}') as { stage?: string; turnId?: string }
  const preparedAfterRestoreRun = await prepared.store.getRun('r42-prepared-base')
  check('engine-prepared-restore-leaves-candidate',
    preparedAfterRestoreSegments.some((segment) => segment.sourceTurnId === preparedTurn.turnId && segment.status === 'candidate' && segment.contentHash === createHash('sha256').update(after).digest('hex')),
    JSON.stringify(preparedAfterRestoreSegments.map((segment) => ({ id: segment.segmentId, status: segment.status, hash: segment.contentHash })))
  )
  await preparedEngine.step('r42-prepared-base')
  const preparedState = await preparedEngine.getState('r42-prepared-base')
  const preparedSegmentsAfterStep = await prepared.store.getManuscriptSegments('r42-prepared-base')
  const preparedAcceptedSegment = preparedSegmentsAfterStep.find((segment) => segment.sourceTurnId === preparedTurn.turnId && segment.status === 'accepted')
  const preparedFinal = preparedSegmentsAfterStep
    .filter((segment) => segment.status === 'accepted')
    .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision)
    .map((segment) => segment.content)
    .join('')
  const preparedAssistantFinal = preparedState.turns.find((turn: TurnRecord) => turn.role === 'assistant')?.content ?? ''
  check('engine-prepared-step-accepts-candidate', Boolean(preparedAcceptedSegment && preparedAcceptedSegment.content === after))
  check('engine-prepared-recovery-exactly-once', preparedState.run?.status === 'completed' && preparedFinal === after && preparedAssistantFinal === after && preparedCalls === 0, JSON.stringify({
    status: preparedState.run?.status,
    calls: preparedCalls,
    restoreInput: { status: preparedRun.status, errorCode: preparedRun.errorCode, hasPolicy: Boolean(prepared.config.writingPipeline) },
    beforeHash: createHash('sha256').update(before).digest('hex'),
    expectedHash: createHash('sha256').update(after).digest('hex'),
    actualHash: createHash('sha256').update(preparedFinal).digest('hex'),
    afterRestoreAssistantHash: createHash('sha256').update(preparedAfterRestoreTurns.find((turn) => turn.turnId === preparedTurn.turnId)?.content ?? '').digest('hex'),
    afterRestoreEvidence: preparedAfterRestoreEvidence,
    afterRestoreRun: preparedAfterRestoreRun ? { status: preparedAfterRestoreRun.status, errorCode: preparedAfterRestoreRun.errorCode, errorMessage: preparedAfterRestoreRun.errorMessage } : null,
    afterRestoreSegments: preparedAfterRestoreSegments.map((segment) => ({ id: segment.segmentId, revision: segment.revision, status: segment.status, hash: segment.contentHash })),
    assistantHash: createHash('sha256').update(preparedAssistantFinal).digest('hex'),
    segments: preparedSegmentsAfterStep.map((segment) => ({ id: segment.segmentId, revision: segment.revision, status: segment.status, hash: segment.contentHash, chars: segment.charCount }))
  }))

  // 远端调用返回前强杀的费用边界：critic 只允许一次恢复重试；editor 不盲重放。
  const criticCrash = await runCase('critic-crash-budget-base')
  const criticTurn = criticCrash.state.turns.find((t: TurnRecord) => t.role === 'assistant') as TurnRecord
  await criticCrash.store.saveRunEvidence('r42-critic-crash-budget-base', 'writing_pipeline_latest', JSON.stringify({
    schemaVersion: 1, policyHash: criticCrash.config.writingPipeline.hash, turnId: criticTurn.turnId, turnSeq: criticTurn.turnSeq,
    round: 1, stage: 'critic_started', candidateHash: createHash('sha256').update(criticTurn.content).digest('hex'), callAttempts: 2
  }))
  const criticRun = criticCrash.store.runs.get('r42-critic-crash-budget-base')!
  criticCrash.store.runs.set('r42-critic-crash-budget-base', { ...criticRun, status: 'recoverable', phase: 'paused' })
  let criticCrashCalls = 0
  const criticCrashEngine = createAgentRunEngine({
    store: criticCrash.store, publishLongwriteArtifact, modelCall: async () => { criticCrashCalls++; throw new Error('must not replay exhausted critic') },
    toolExecutor: async () => '', getConfig: () => criticCrash.config, onEvent: () => undefined, onRunUpdate: () => undefined
  })
  await criticCrashEngine.restore('r42-critic-crash-budget-base')
  const criticCrashState = await criticCrashEngine.getState('r42-critic-crash-budget-base')
  check('engine-critic-crash-retry-budget', criticCrashState.run?.status === 'waiting_user' && criticCrashState.run?.errorCode === 'writing_critic_retry_exhausted' && criticCrashCalls === 0)

  const criticHash = createHash('sha256').update(criticTurn.content).digest('hex')
  for (const [name, patch] of [
    ['paused-two', { stage: 'paused', criticCallAttempts: 2 }],
    ['done-two', { stage: 'critic_done', criticCallAttempts: 2 }],
    ['legacy-paused-unknown', { stage: 'paused' }],
    ['missing-counter', { stage: 'critic_started' }],
    ['zero-started', { stage: 'critic_started', criticCallAttempts: 0 }],
    ['bad-counter', { stage: 'critic_started', criticCallAttempts: '1' }],
    ['wrong-policy', { stage: 'critic_started', criticCallAttempts: 1, policyHash: '0'.repeat(64) }],
    ['wrong-candidate', { stage: 'critic_started', criticCallAttempts: 1, criticCandidateHash: '0'.repeat(64) }]
  ] as const) {
    await criticCrash.store.saveRunEvidence('r42-critic-crash-budget-base', 'writing_pipeline_latest', JSON.stringify({
      schemaVersion: 1, policyHash: criticCrash.config.writingPipeline.hash, turnId: criticTurn.turnId, turnSeq: criticTurn.turnSeq,
      round: 1, candidateHash: criticHash, criticCandidateHash: criticHash, ...patch
    }))
    criticCrash.store.runs.set('r42-critic-crash-budget-base', { ...criticRun, status: 'recoverable', phase: 'paused' })
    let calls = 0
    const restored = createAgentRunEngine({ store: criticCrash.store, publishLongwriteArtifact,
      modelCall: async () => { calls++; throw new Error('unknown/exhausted allowance must not replay') },
      toolExecutor: async () => '', getConfig: () => criticCrash.config, onEvent: () => undefined, onRunUpdate: () => undefined })
    await restored.restore('r42-critic-crash-budget-base'); await restored.step('r42-critic-crash-budget-base')
    const state = await restored.getState('r42-critic-crash-budget-base')
    check(`engine-critic-durable-${name}`, calls === 0 && state.run?.errorCode === 'writing_critic_retry_exhausted')
  }

  const initialCriticKind = `writing_pipeline_critic_${criticTurn.turnId}_${criticHash}_1`
  const priorComplete = criticCrash.store.evidence.get(`r42-critic-crash-budget-base:${initialCriticKind}`)
  criticCrash.store.evidence.delete(`r42-critic-crash-budget-base:${initialCriticKind}`)
  await criticCrash.store.saveRunEvidence('r42-critic-crash-budget-base', 'writing_pipeline_latest', JSON.stringify({
    schemaVersion: 1, policyHash: criticCrash.config.writingPipeline.hash, turnId: criticTurn.turnId, turnSeq: criticTurn.turnSeq,
    round: 1, stage: 'critic_started', candidateHash: criticHash, criticCandidateHash: criticHash, criticCallAttempts: 1, callAttempts: 1
  }))
  criticCrash.store.runs.set('r42-critic-crash-budget-base', { ...criticRun, status: 'recoverable', phase: 'paused' })
  let unknownCalls = 0
  const unknownRecovery = createAgentRunEngine({ store: criticCrash.store, publishLongwriteArtifact,
    modelCall: async () => { unknownCalls++; throw new Error('missing complete record cannot authorize another call') },
    toolExecutor: async () => '', getConfig: () => criticCrash.config, onEvent: () => undefined, onRunUpdate: () => undefined })
  await unknownRecovery.restore('r42-critic-crash-budget-base'); await unknownRecovery.step('r42-critic-crash-budget-base')
  check('engine-critic-missing-complete-record-no-replay', unknownCalls === 0 && (await unknownRecovery.getState('r42-critic-crash-budget-base')).run?.errorCode === 'writing_critic_retry_exhausted')
  if (priorComplete) criticCrash.store.evidence.set(`r42-critic-crash-budget-base:${initialCriticKind}`, priorComplete)

  // Snapshot a crash after the complete invalid response was saved, before the
  // correction reservation. The one remaining call must carry the old findings,
  // not start a new review that can erase q1 with issues:[].
  const invalidCriticRaw = JSON.stringify({ schemaVersion: 1, anchorMode: 'exact_quote', candidateHash: criticHash, issues: [{
    issueId: 'q1', code: 'pov_conflict', basis: 'inferred', severity: 'advisory', quote: criticTurn.content,
    reason: '原问题必须保留', repairIntent: '不改原候选事实'
  }] })
  const durableBase = { schemaVersion: 1, policyHash: criticCrash.config.writingPipeline.hash, turnId: criticTurn.turnId, turnSeq: criticTurn.turnSeq,
    round: 1, candidateHash: criticHash, criticCandidateHash: criticHash, criticCallAttempts: 1 }
  await criticCrash.store.saveRunEvidence('r42-critic-crash-budget-base', 'writing_pipeline_latest', JSON.stringify({ ...durableBase, stage: 'critic_started', callAttempts: 1 }))
  await criticCrash.store.saveRunEvidence('r42-critic-crash-budget-base', `writing_pipeline_critic_${criticTurn.turnId}_${criticHash}_1`, JSON.stringify({
    ...durableBase, raw: invalidCriticRaw, rawHash: createHash('sha256').update(invalidCriticRaw).digest('hex'), finishReason: 'stop', error: 'critic_issue_code_invalid:1', durationMs: 1,
    usage: { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1, reasoningTokens: null, cost: null }
  }))
  criticCrash.store.runs.set('r42-critic-crash-budget-base', { ...criticRun, status: 'recoverable', phase: 'paused' })
  let formatRecoveryCalls = 0, oldFindingsCarried = false
  const formatRecovery = createAgentRunEngine({ store: criticCrash.store, publishLongwriteArtifact, modelCall: async request => {
    formatRecoveryCalls++
    const payload = JSON.parse(request.messages.find(message => message.role === 'user')?.content ?? '{}')
    oldFindingsCarried = payload.formatCorrection?.invalidReport === invalidCriticRaw && payload.candidateHash === criticHash
    return { async *[Symbol.asyncIterator](): AsyncGenerator<any> {
      yield { type: 'text', delta: JSON.stringify({ schemaVersion: 1, anchorMode: 'exact_quote', candidateHash: criticHash, issues: [] }) }
      yield { type: 'finish', finishReason: 'stop' }
    } }
  }, toolExecutor: async () => '', getConfig: () => criticCrash.config, onEvent: () => undefined, onRunUpdate: () => undefined })
  await formatRecovery.restore('r42-critic-crash-budget-base'); await formatRecovery.step('r42-critic-crash-budget-base')
  const formatRecoveryState = await formatRecovery.getState('r42-critic-crash-budget-base')
  const formatRecoveryEvidence = JSON.parse((await criticCrash.store.getRunEvidence('r42-critic-crash-budget-base', 'writing_pipeline_latest'))?.json ?? '{}')
  check('engine-format-crash-retains-original-findings-and-budget', formatRecoveryCalls === 1 && oldFindingsCarried && formatRecoveryState.run?.errorCode === 'writing_critic_invalid' && formatRecoveryEvidence.criticCallAttempts === 2)

  const editorCrash = await runCase('editor-crash-budget-base')
  const editorTurn = editorCrash.state.turns.find((t: TurnRecord) => t.role === 'assistant') as TurnRecord
  await editorCrash.store.saveRunEvidence('r42-editor-crash-budget-base', 'writing_pipeline_latest', JSON.stringify({
    schemaVersion: 1, policyHash: editorCrash.config.writingPipeline.hash, turnId: editorTurn.turnId, turnSeq: editorTurn.turnSeq,
    round: 1, stage: 'editor_started', candidateHash: createHash('sha256').update(editorTurn.content).digest('hex'), callAttempts: 1
  }))
  const editorRun = editorCrash.store.runs.get('r42-editor-crash-budget-base')!
  editorCrash.store.runs.set('r42-editor-crash-budget-base', { ...editorRun, status: 'recoverable', phase: 'paused' })
  let editorCrashCalls = 0
  const editorCrashEngine = createAgentRunEngine({
    store: editorCrash.store, publishLongwriteArtifact, modelCall: async () => { editorCrashCalls++; throw new Error('must not blindly replay editor') },
    toolExecutor: async () => '', getConfig: () => editorCrash.config, onEvent: () => undefined, onRunUpdate: () => undefined
  })
  await editorCrashEngine.restore('r42-editor-crash-budget-base')
  const editorCrashState = await editorCrashEngine.getState('r42-editor-crash-budget-base')
  check('engine-editor-crash-no-blind-replay', editorCrashState.run?.status === 'waiting_user' && editorCrashState.run?.errorCode === 'writing_editor_interrupted' && editorCrashCalls === 0)

  // editor 已经返回并落下 edit_proposed，但复核 critic 尚未完成时崩溃：
  // 恢复不得从头重跑 critic/editor，也不得把未验收 patch 写入 canonical。
  const proposedCrash = await runCase('edit-proposed-crash-base')
  const proposedTurn = proposedCrash.state.turns.find((t: TurnRecord) => t.role === 'assistant') as TurnRecord
  const proposedBefore = proposedTurn.content
  const proposedChars = Array.from(proposedBefore)
  const proposedStart = proposedChars.length - 1
  const proposedReplacement = proposedChars[proposedStart] === '海' ? '风' : '海'
  const proposedAfter = `${proposedChars.slice(0, proposedStart).join('')}${proposedReplacement}`
  await proposedCrash.store.saveRunEvidence('r42-edit-proposed-crash-base', 'writing_pipeline_latest', JSON.stringify({
    schemaVersion: 1, policyHash: proposedCrash.config.writingPipeline.hash,
    turnId: proposedTurn.turnId, turnSeq: proposedTurn.turnSeq, round: 1,
    stage: 'edit_proposed', candidateHash: createHash('sha256').update(proposedBefore).digest('hex'),
    beforeHash: createHash('sha256').update(proposedBefore).digest('hex'),
    afterHash: createHash('sha256').update(proposedAfter).digest('hex'),
    patch: { issueId: 'interrupted-q1', startCp: proposedStart, endCp: proposedStart + 1, quote: proposedChars[proposedStart], replacement: proposedReplacement },
    issues: [{ issueId: 'interrupted-q1', code: 'preachy_template', severity: 'advisory', basis: 'quality', startCp: proposedStart, endCp: proposedStart + 1, quote: proposedChars[proposedStart], reason: '待复核', repairIntent: '局部改写' }]
  }))
  const proposedRun = proposedCrash.store.runs.get('r42-edit-proposed-crash-base')!
  proposedCrash.store.runs.set('r42-edit-proposed-crash-base', { ...proposedRun, status: 'recoverable', phase: 'paused' })
  let proposedCrashCalls = 0
  const proposedEngine = createAgentRunEngine({
    store: proposedCrash.store,
    publishLongwriteArtifact,
    modelCall: async () => { proposedCrashCalls++; throw new Error('edit_proposed recovery must not call provider') },
    toolExecutor: async () => '', getConfig: () => proposedCrash.config, onEvent: () => undefined, onRunUpdate: () => undefined
  })
  await proposedEngine.restore('r42-edit-proposed-crash-base')
  let proposedState = await proposedEngine.getState('r42-edit-proposed-crash-base')
  if (proposedState.run?.status !== 'waiting_user') {
    await proposedEngine.step('r42-edit-proposed-crash-base')
    proposedState = await proposedEngine.getState('r42-edit-proposed-crash-base')
  }
  const proposedFinal = proposedState.turns.find((t: TurnRecord) => t.turnId === proposedTurn.turnId)?.content ?? ''
  check('engine-edit-proposed-recovery-no-provider-replay', proposedState.run?.status === 'waiting_user' && proposedState.run?.errorCode === 'writing_edit_verification_interrupted' && proposedCrashCalls === 0, `status=${proposedState.run?.status} error=${proposedState.run?.errorCode} calls=${proposedCrashCalls}`)
  check('engine-edit-proposed-recovery-keeps-canonical', proposedFinal === proposedBefore && createHash('sha256').update(proposedFinal).digest('hex') === createHash('sha256').update(proposedBefore).digest('hex'))

  const invalid = await runCase('editor-invalid', { editorInvalid: true })
  const invalidText = invalid.state.turns.filter((t: TurnRecord) => t.role === 'assistant').map((t: TurnRecord) => t.content).join('')
  const invalidEvidence = JSON.parse((await invalid.store.getRunEvidence('r42-editor-invalid', 'writing_pipeline_latest'))?.json ?? '{}') as any
  check('engine-soft-editor-failure-is-advisory', invalid.state.run?.status === 'completed' && invalidEvidence.acceptedWithAdvisory === true)
  check('engine-editor-failure-keeps-original', invalidText.includes('人生的意义') && codePointLength(invalidText) === 400)

  const recheckSoft = await runCase('recheck-soft', { recheckSoft: true })
  const recheckText = recheckSoft.state.turns.filter((t: TurnRecord) => t.role === 'assistant').map((t: TurnRecord) => t.content).join('')
  const recheckEvidence = JSON.parse((await recheckSoft.store.getRunEvidence('r42-recheck-soft', 'writing_pipeline_latest'))?.json ?? '{}') as any
  check('engine-soft-recheck-rolls-back-unaccepted-edit', recheckSoft.state.run?.status === 'completed' && recheckText.includes('人生的意义') && recheckSoft.rendered === recheckText && recheckEvidence.acceptedWithAdvisory === true)

  const hardAvoid = await runCase('hard-avoid', { avoid: '人生的意义' })
  const hardEvidence = JSON.parse((await hardAvoid.store.getRunEvidence('r42-hard-avoid', 'writing_pipeline_latest'))?.json ?? '{}') as any
  check('engine-explicit-avoid-remains-hard', hardAvoid.state.run?.status === 'completed' && hardEvidence.repairedIssue?.code === 'explicit_forbidden' && hardEvidence.repairedIssue?.severity === 'hard', `${hardAvoid.state.run?.status}/${hardAvoid.state.run?.errorCode}/${JSON.stringify(hardEvidence.repairedIssue)}`)

  const disabled = await runCase('disabled', { theme: 'off', anti: false })
  check('engine-bidirectional-off-skips-review', disabled.calls.join(',') === 'writer' && disabled.state.run?.status === 'completed')
  const agent = await runCase('agent', { mode: 'agent' })
  check('engine-agent-unaffected', agent.calls.join(',') === 'writer' && agent.state.run?.status === 'completed')

  const goodContinuation = await runShortEditContinuation('good-exact')
  const goodTurns = goodContinuation.state.turns.filter((t: TurnRecord) => t.role === 'assistant') as TurnRecord[]
  const goodDraft = goodTurns.map((t) => t.content).join('')
  const goodStrong = JSON.parse((await goodContinuation.store.getRunEvidence(goodContinuation.runId, 'strong_constraint_latest'))?.json ?? '{}') as any
  check('engine-short-edit-continuation-exact-4000', goodContinuation.state.run?.status === 'completed' && codePointLength(goodDraft) === 4000 && goodContinuation.calls.join(',') === 'writer,critic,editor,critic,writer,critic', `${goodContinuation.state.run?.status}/${codePointLength(goodDraft)}/${goodContinuation.calls.join(',')}`)
  check('engine-short-edit-final-evidence-binds-4000', goodStrong.draftHash === createHash('sha256').update(goodDraft).digest('hex') && goodStrong.latestSegmentHash === createHash('sha256').update(goodTurns[goodTurns.length - 1]?.content ?? '').digest('hex'))

  const badContinuation = await runShortEditContinuation('bad-hard')
  const badTurns = badContinuation.state.turns.filter((t: TurnRecord) => t.role === 'assistant') as TurnRecord[]
  const badDraft = badTurns.map((t) => t.content).join('')
  const badStrong = JSON.parse((await badContinuation.store.getRunEvidence(badContinuation.runId, 'strong_constraint_latest'))?.json ?? '{}') as any
  check('engine-every-new-writer-turn-is-reviewed', badContinuation.calls.join(',') === 'writer,critic,editor,critic,writer,critic', badContinuation.calls.join(','))
  check('engine-bad-final-continuation-cannot-complete', badContinuation.state.run?.status === 'waiting_user' && badContinuation.state.run?.errorCode === 'writing_hard_boundary_requires_user' && badDraft.includes('成功学'), `${badContinuation.state.run?.status}/${badContinuation.state.run?.errorCode}/${codePointLength(badDraft)}`)
  check('engine-stale-first-pass-evidence-does-not-bind-final', badStrong.status === 'passed' && badStrong.draftHash !== createHash('sha256').update(badDraft).digest('hex'), `old=${badStrong.draftHash} final=${createHash('sha256').update(badDraft).digest('hex')}`)

  console.log(`R42 pipeline: ${pass} PASS / ${fail} FAIL`)
  if (fail > 0) process.exit(1)
}

main().catch((error) => { console.error(error); process.exit(2) })
