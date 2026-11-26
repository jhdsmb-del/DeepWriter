import { desktopSourceExternals } from './desktop-source-boundary.mjs'
/** R65 production-path checks for opaque prose acceptance and post-commit review recovery. */
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }
type AnyRecord = Record<string, any>

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`) }
  else { failed += 1; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function loadTsModule(relativePath: string, tag: string): Promise<AnyRecord> {
  const outfile = path.join(ROOT, 'out', `r65-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await esbuild.build({
    entryPoints: [path.join(ROOT, relativePath)], bundle: true, format: 'esm', platform: 'node', target: 'node20', write: true,
    outfile, external: desktopSourceExternals(path.join(ROOT, relativePath), ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite']), logLevel: 'silent',
    plugins: [{
      name: 'electron-shim',
      setup(build: AnyRecord): void {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
        build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
          contents: 'export const app={getPath:(name)=>String(name),isPackaged:false}; export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]}),showSaveDialog:async()=>({canceled:true})}; export const ipcMain={handle:()=>undefined,on:()=>undefined}; export const safeStorage={isEncryptionAvailable:()=>false,encryptString:()=>null,decryptString:()=>""}; export const shell={openExternal:()=>undefined,openPath:async()=>""}; export const clipboard={writeText:()=>undefined}; export const Menu={buildFromTemplate:(template)=>({popup:()=>undefined,template})};', loader: 'js'
        }))
      }
    }]
  })
  try { return await import(url.pathToFileURL(outfile).href) as AnyRecord }
  finally { await fsp.unlink(outfile).catch(() => undefined) }
}

function completeProse(length: number): string {
  const chars = Array.from('雨声压过空旷的堤岸，远处的灯火在雾里逐一熄灭。')
  while (chars.length < length - 1) chars.push(String.fromCodePoint(0x20000 + chars.length))
  chars.length = Math.max(0, length - 1)
  chars.push('。')
  return chars.join('')
}

function completeProseWithPrefix(prefix: string, length: number): string {
  const chars = Array.from(prefix)
  while (chars.length < length - 1) chars.push(String.fromCodePoint(0x20000 + chars.length))
  chars.length = Math.max(0, length - 1)
  chars.push('。')
  return chars.join('')
}

async function main(): Promise<void> {
  const [snapshotMod, repoMod, portMod, engineMod, sceneMod, rendererMod, schemasMod] = await Promise.all([
    loadTsModule('src/main/executionSnapshot.ts', 'snapshot'),
    loadTsModule('src/main/db/repository.ts', 'repo'),
    loadTsModule('src/main/runKernelAdapter.ts', 'port'),
    loadTsModule('src/main/jobs/AgentRunEngine.ts', 'engine'),
    loadTsModule('src/main/narrative/sceneContract.ts', 'scene'),
    loadTsModule('src/renderer/src/store.ts', 'renderer'),
    loadTsModule('src/shared/ipcSchemas.ts', 'schemas')
  ])
  const buildExecutionSnapshot = snapshotMod.buildExecutionSnapshot as (input: AnyRecord) => AnyRecord
  const createRepository = repoMod.createRepository as (dbPath: string) => AnyRecord
  const createRunStorePort = portMod.createRunStorePort as (repository: AnyRecord, artifactDir: string) => AnyRecord
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: AnyRecord) => AnyRecord
  const buildSceneContractPlan = sceneMod.buildSceneContractPlan as (input: AnyRecord) => AnyRecord
  const rendererStore = rendererMod.useStore as AnyRecord
  const reviewDecisionSchema = schemasMod.narrativeReviewDecisionSchema as AnyRecord
  const targetChars = 120
  const outline: GrillMeOutline = {
    title: '雾堤', premise: '验证文学性 beat 接受与提交后复核恢复。', targetChars,
    sections: [{ id: 's1', title: '雾堤', purpose: '气氛变得压抑。', targetChars, beats: ['气氛变得压抑'], sourceSlotIds: [] }]
  }
  const outlineHash = grillMeOutlineHash(outline)
  const settings = { model: 'synthetic-r65', baseUrl: 'http://127.0.0.1:9', maxTokens: 4096, temperature: 0.7, topP: 1, thinkingEnabled: false, reasoningEffort: 'high', workDir: 'C:/r65-work', docDir: 'C:/r65-docs', novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000, strongConstraintEnabled: false }
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r65-review-'))
  const makeFixture = (runId: string, scenario: 'opaque' | 'unknown' | 'mixed' = 'opaque'): AnyRecord => {
    const sessionId = `${runId}-session`
    const fixtureOutline: GrillMeOutline = scenario === 'unknown'
      ? { title: '方向未知', premise: '缺失行动者时只能显式保留 unknown。', targetChars, sections: [{ id: 's1', title: '拿走', purpose: '拿走钥匙。', targetChars, beats: ['拿走钥匙'], sourceSlotIds: [] }] }
      : scenario === 'mixed'
        ? { title: '混合语义', premise: 'opaque 与角色绑定歧义不能混用无状态接受。', targetChars, sections: [{ id: 's1', title: '混合语义', purpose: '先形成氛围，再出现未绑定交接。', targetChars, beats: ['气氛变得压抑', '林舟把钥匙交给沈遥'], sourceSlotIds: [] }] }
        : outline
    const fixtureOutlineHash = grillMeOutlineHash(fixtureOutline)
    const fixturePlan = buildSceneContractPlan({ outline: fixtureOutline, outlineHash: fixtureOutlineHash, outlineRevision: 1, answers: [], characterNames: ['林舟', '沈遥'], strongConstraints: { forbiddenTerms: [], mustKeep: [] } })
    const config = buildExecutionSnapshot({
      payload: { id: runId, mode: 'longwrite', workspace: 'novel', phase: 'execute', longMode: true, targetChars, text: '请依据已确认场景继续写作。', grillMe: { stateId: `${runId}-grill`, originalTask: scenario === 'unknown' ? '写一段拿走钥匙的小说。' : '写一段雾堤小说。', targetChars, answers: [], assumptions: [], approvedOutline: fixtureOutline, outlineRevision: 1, outlineHash: fixtureOutlineHash }, strongConstraints: { enabled: false } },
      settings, sessionId, memory: { projectPath: '', projectContent: '', userContent: '' }
    })
    const repo = createRepository(path.join(tmpDir, `${runId}.db`))
    repo.open()
    const output = scenario === 'unknown'
      ? completeProseWithPrefix('拿走钥匙，风声盖过了脚步。', targetChars)
      : scenario === 'mixed'
        ? completeProseWithPrefix('林舟把钥匙交出。', targetChars)
        : completeProse(targetChars)
    let providerCalls = 0
    const engine = createAgentRunEngine({
      store: createRunStorePort(repo, path.join(tmpDir, `${runId}-artifacts`)),
      modelCall: async () => { providerCalls += 1; return { async *[Symbol.asyncIterator](): AsyncGenerator<AnyRecord> { yield { type: 'text', delta: output }; yield { type: 'finish', finishReason: 'length' } } } },
      toolExecutor: async () => '', getConfig: () => config, onEvent: () => undefined, onRunUpdate: () => undefined,
      publishLongwriteArtifact: async () => ({ displayName: `${runId}.md`, relativePath: `${runId}.md` })
    })
    return { repo, engine, runId, sessionId, config, output, plan: fixturePlan, get providerCalls() { return providerCalls } }
  }

  const previousWindow = (globalThis as AnyRecord).window
  const rendererCalls: AnyRecord[] = []
  const reviewOperation = {
    operationId: 'r65-ui-operation',
    decisionId: 'r65-ui-operation',
    expectedRevision: 3,
    canonicalPayloadHash: 'a'.repeat(64)
  }
  const allReviewDecisions = {
    accept_delta: { allowed: true, disabledReason: null },
    accept_unknown: { allowed: true, disabledReason: null },
    accept_prose_no_state: { allowed: true, disabledReason: null },
    reject_rewrite: { allowed: true, disabledReason: null },
    abandon: { allowed: true, disabledReason: null }
  }
  ;(globalThis as AnyRecord).window = {
    ds: {
      runsNarrativeReviewDecide: async (input: AnyRecord) => {
        rendererCalls.push(input)
        return { ok: true, status: input.decision === 'accept_unknown' ? 'unknown_accepted' : 'accepted', decisionStatus: input.decision === 'accept_unknown' ? 'unknown_accepted' : 'accepted', runStatus: 'completed', phase: 'completed', terminal: true, needsStep: false }
      }
    }
  }
  rendererStore.setState({ narrativeReview: { runId: 'r65-ui', revision: 3, pendingOperation: reviewOperation, allowedDecisions: allReviewDecisions }, running: false, runningId: null })
  const uiNoState = await rendererStore.getState().decideNarrativeReview('accept_prose_no_state', null, '正文已表达')
  rendererStore.setState({ narrativeReview: { runId: 'r65-ui', revision: 4, pendingOperation: { ...reviewOperation, expectedRevision: 4 }, allowedDecisions: allReviewDecisions }, running: false, runningId: null })
  const uiUnknown = await rendererStore.getState().decideNarrativeReview('accept_unknown')
  const noStatePayload = rendererCalls[0]
  const unknownPayload = rendererCalls[1]
  check('R65 renderer sends opaque acceptance directly without manual hashes', uiNoState === true && noStatePayload?.decision === 'accept_prose_no_state' && (noStatePayload?.delta === undefined || noStatePayload?.delta === null) && typeof noStatePayload?.decisionId === 'string', JSON.stringify(noStatePayload))
  check('R65 renderer sends accept_unknown through the IPC contract', uiUnknown === true && unknownPayload?.decision === 'accept_unknown' && unknownPayload?.delta === undefined && typeof unknownPayload?.decisionId === 'string', JSON.stringify(unknownPayload))
  const schemaNoState = reviewDecisionSchema.safeParse({ runId: 'r65-ui', decision: 'accept_prose_no_state', expectedRevision: 3, decisionId: 'r65-schema-no-state' })
  const schemaUnknown = reviewDecisionSchema.safeParse({ runId: 'r65-ui', decision: 'accept_unknown', expectedRevision: 4, decisionId: 'r65-schema-unknown' })
  const schemaMissingDecisionId = reviewDecisionSchema.safeParse({ runId: 'r65-ui', decision: 'accept_unknown', expectedRevision: 4 })
  check('R65 IPC schema accepts both user-facing review decisions', schemaNoState.success === true && schemaUnknown.success === true, JSON.stringify({ noState: schemaNoState.success, unknown: schemaUnknown.success }))
  check('R65 IPC requires the main-issued review operation id', schemaMissingDecisionId.success === false, JSON.stringify(schemaMissingDecisionId))
  rendererCalls.length = 0
  rendererStore.setState({ narrativeReview: { runId: 'r65-no-operation', revision: 1, allowedDecisions: allReviewDecisions }, running: false, runningId: null })
  const missingOperation = await rendererStore.getState().decideNarrativeReview('accept_unknown')
  check('R65 renderer refuses to invent a decision id when main has not supplied one', missingOperation === false && rendererCalls.length === 0, JSON.stringify({ missingOperation, calls: rendererCalls }))
  rendererStore.setState({ narrativeReview: { runId: 'r65-disabled', revision: 1, pendingOperation: { ...reviewOperation, expectedRevision: 1 }, allowedDecisions: { ...allReviewDecisions, accept_unknown: { allowed: false, disabledReason: '当前证据不允许保留 unknown' } } }, running: false, runningId: null })
  const disabledDecision = await rendererStore.getState().decideNarrativeReview('accept_unknown')
  check('R65 renderer obeys main allowedDecisions and does not invoke a disabled action', disabledDecision === false && rendererCalls.length === 0, JSON.stringify({ disabledDecision, calls: rendererCalls }))
  const autoResumeCalls: string[] = []
  const autoReviewPacket = {
    schemaVersion: 1,
    status: 'pending_review',
    reason: 'narrative_state_pending_review',
    runId: 'r65-auto-review',
    sceneId: 'scene-1',
    contractId: 'contract-1',
    contractHash: 'b'.repeat(64),
    revision: 1,
    candidate: { segmentId: 'segment-1', contentHash: 'c'.repeat(64), charCount: 1, acceptedSegments: [] },
    acceptedCharsBefore: 0,
    sceneChars: 1,
    scenePrefixHash: 'd'.repeat(64),
    scenePrefixCharCount: 0,
    sceneContentHash: 'e'.repeat(64),
    contract: {},
    completionDecision: {},
    evaluation: {},
    missingBeatIds: [],
    conflictBeatIds: [],
    reasons: [],
    proposedDelta: null,
    allowedDecisions: allReviewDecisions,
    packetHash: 'f'.repeat(64),
    recordedAt: 1,
    pendingOperation: { ...reviewOperation, expectedRevision: 1 }
  }
  ;(globalThis as AnyRecord).window = {
    ds: {
      runsRecoverable: async () => [{ runId: 'r65-auto-review', sessionId: 's1', status: 'waiting_user', phase: 'paused', errorCode: 'narrative_state_pending_review', errorMessage: '等待复核', startedAt: 1, updatedAt: 1, config: {} }],
      runsResume: async (runId: string) => { autoResumeCalls.push(runId); return { ok: true, waitingUser: true, semanticReview: autoReviewPacket } }
    }
  }
  rendererStore.setState({ narrativeReview: null, recoverableRuns: [], running: false, runningId: null })
  await rendererStore.getState().loadRecoverable()
  check('R65 renderer auto-restores semantic review packets after restart', autoResumeCalls.length === 1 && autoResumeCalls[0] === 'r65-auto-review' && rendererStore.getState().narrativeReview?.runId === 'r65-auto-review', JSON.stringify({ autoResumeCalls, reviewRunId: rendererStore.getState().narrativeReview?.runId }))
  const concurrentReviewRun = 'r65-background-review'
  const concurrentResumeCalls: string[] = []
  ;(globalThis as AnyRecord).window = {
    ds: {
      runsRecoverable: async () => [
        { runId: 'r65-other-active', sessionId: 's-active', status: 'running', phase: 'thinking', startedAt: 1, updatedAt: 1, config: {} },
        { runId: concurrentReviewRun, sessionId: 's-review', status: 'waiting_user', phase: 'paused', errorCode: 'narrative_state_pending_review', errorMessage: '等待复核', startedAt: 2, updatedAt: 2, config: {} }
      ],
      runsResume: async (runId: string) => { concurrentResumeCalls.push(runId); return { ok: true, waitingUser: true, semanticReview: { ...autoReviewPacket, runId: concurrentReviewRun } } }
    }
  }
  rendererStore.setState({ narrativeReview: null, recoverableRuns: [], running: true, runningId: 'r65-other-active', activeRunId: 'r65-other-active' })
  await rendererStore.getState().loadRecoverable()
  const concurrentState = rendererStore.getState()
  check('R65 background review restore preserves an unrelated active run owner', concurrentResumeCalls.length === 1 && concurrentState.running === true && concurrentState.runningId === 'r65-other-active', JSON.stringify({ concurrentResumeCalls, running: concurrentState.running, runningId: concurrentState.runningId }))
  ;(globalThis as AnyRecord).window = previousWindow

  try {
    const opaque = makeFixture('r65-opaque')
    const started = await opaque.engine.start({ sessionId: opaque.sessionId, runId: opaque.runId, config: opaque.config })
    try { await opaque.engine.step(opaque.runId) } catch { /* expected waiting_user boundary */ }
    const review = await opaque.engine.getNarrativeReview(opaque.runId)
    const invalidUnknown = await opaque.engine.applyNarrativeReviewDecision({ runId: opaque.runId, decision: 'accept_unknown', decisionId: 'r65-invalid-unknown', expectedRevision: Number(review.revision) }, { actor: 'r65-ui-user' })
    check('R65 accept_unknown rejects an opaque/non-role ambiguity', !invalidUnknown.ok && String(invalidUnknown.error).includes('仅允许角色绑定歧义'), JSON.stringify(invalidUnknown))
    const accepted = await opaque.engine.applyNarrativeReviewDecision({ runId: opaque.runId, decision: 'accept_prose_no_state', decisionId: 'r65-opaque-decision', expectedRevision: Number(review.revision), note: '用户确认氛围已表达' }, { actor: 'r65-ui-user' })
    const finalReview = await opaque.engine.getNarrativeReview(opaque.runId)
    const proseAudit = opaque.repo.getRunEvidence(opaque.runId, `narrative_prose_no_state:${String(review.candidate.segmentId)}`)
    const rows = opaque.repo.getManuscriptSegmentsByRun(opaque.runId)
    const states = opaque.repo.getSceneStates(opaque.runId)
    check('R65 opaque beat exposes a direct no-state acceptance path', started.ok && review?.status === 'pending_review' && accepted.ok && accepted.status === 'accepted', JSON.stringify(accepted))
    check('R65 no-state acceptance writes audit evidence but no fake state fact', proseAudit !== null && rows.some((row: AnyRecord) => row.status === 'accepted' && row.content_hash === review.candidate.contentHash) && states.some((state: AnyRecord) => state.lifecycle === 'committed'), JSON.stringify({ audit: Boolean(proseAudit), states }))
    check('R65 no-state acceptance is idempotent after the first terminal result', finalReview?.status === 'accepted' && opaque.providerCalls === 1, JSON.stringify({ review: finalReview?.status, providerCalls: opaque.providerCalls }))
    opaque.repo.close()

    const mixed = makeFixture('r65-mixed', 'mixed')
    const mixedStarted = await mixed.engine.start({ sessionId: mixed.sessionId, runId: mixed.runId, config: mixed.config })
    try { await mixed.engine.step(mixed.runId) } catch { /* expected waiting_user boundary */ }
    const mixedReview = await mixed.engine.getNarrativeReview(mixed.runId)
    const mixedNoState = await mixed.engine.applyNarrativeReviewDecision({ runId: mixed.runId, decision: 'accept_prose_no_state', decisionId: 'r65-mixed-no-state', expectedRevision: Number(mixedReview.revision) }, { actor: 'r65-ui-user' })
    check('R65 no-state acceptance rejects mixed opaque plus uncertain semantic reasons', mixedStarted.ok && mixedReview?.reasons.some((reason: AnyRecord) => reason.code === 'beat_uncertain') && !mixedNoState.ok, JSON.stringify({ reasons: mixedReview?.reasons, result: mixedNoState }))
    mixed.repo.close()

    const unknown = makeFixture('r65-unknown', 'unknown')
    const unknownStarted = await unknown.engine.start({ sessionId: unknown.sessionId, runId: unknown.runId, config: unknown.config })
    try { await unknown.engine.step(unknown.runId) } catch { /* expected waiting_user boundary */ }
    const unknownReview = await unknown.engine.getNarrativeReview(unknown.runId)
    const unknownAccepted = await unknown.engine.applyNarrativeReviewDecision({ runId: unknown.runId, decision: 'accept_unknown', decisionId: 'r65-unknown-decision', expectedRevision: Number(unknownReview.revision) }, { actor: 'r65-ui-user' })
    const unknownRows = unknown.repo.getManuscriptSegmentsByRun(unknown.runId)
    const unknownStates = unknown.repo.getSceneStates(unknown.runId)
    const unknownLedger = unknown.repo.getNarrativeLedger(unknown.runId)
    check('R65 accept_unknown succeeds through the real engine/repository path', unknownStarted.ok && unknownReview?.status === 'pending_review' && unknownAccepted.ok && unknownAccepted.status === 'unknown_accepted', JSON.stringify(unknownAccepted))
    check('R65 accept_unknown records explicit unknown binding without guessing a holder', unknownRows.some((row: AnyRecord) => row.status === 'accepted') && unknownStates.some((state: AnyRecord) => state.lifecycle === 'committed') && unknownLedger.some((entry: AnyRecord) => entry.kind === 'object_state' && entry.holderId === null && entry.holderStatus === 'unknown'), JSON.stringify({ states: unknownStates, ledger: unknownLedger }))
    unknown.repo.close()

    const recovery = makeFixture('r65-recovery')
    const recoveryStarted = await recovery.engine.start({ sessionId: recovery.sessionId, runId: recovery.runId, config: recovery.config })
    try { await recovery.engine.step(recovery.runId) } catch { /* expected waiting_user boundary */ }
    const recoveryReview = await recovery.engine.getNarrativeReview(recovery.runId)
    const originalSaveEvidenceBundle = recovery.repo.saveRunEvidenceBundle
    let injected = false
    recovery.repo.saveRunEvidenceBundle = function (runId: string, entries: Array<{ kind: string; json: string }>): void {
      if (!injected && entries.some((entry) => entry.kind === 'narrative_semantic_review')) { injected = true; throw new Error('r65-post-commit-final-packet-failure') }
      return originalSaveEvidenceBundle.call(recovery.repo, runId, entries)
    }
    let firstThrew = false
    try {
      await recovery.engine.applyNarrativeReviewDecision({ runId: recovery.runId, decision: 'accept_prose_no_state', decisionId: 'r65-recovery-decision', expectedRevision: Number(recoveryReview.revision), note: '恢复测试' }, { actor: 'r65-ui-user' })
    } catch { firstThrew = true }
    recovery.repo.saveRunEvidenceBundle = originalSaveEvidenceBundle
    const committedBeforeRestart = recovery.repo.getSceneStates(recovery.runId).some((state: AnyRecord) => state.lifecycle === 'committed') && recovery.repo.getManuscriptSegmentsByRun(recovery.runId).some((row: AnyRecord) => row.status === 'accepted')
    recovery.repo.close()
    const repoAfterRestart = createRepository(path.join(tmpDir, `${recovery.runId}.db`))
    repoAfterRestart.open()
    const restartedEngine = createAgentRunEngine({
      store: createRunStorePort(repoAfterRestart, path.join(tmpDir, `${recovery.runId}-artifacts`)),
      modelCall: async () => { throw new Error('R65 provider must not be called during recovery') },
      toolExecutor: async () => '', getConfig: () => recovery.config, onEvent: () => undefined, onRunUpdate: () => undefined,
      publishLongwriteArtifact: async () => ({ displayName: `${recovery.runId}.md`, relativePath: `${recovery.runId}.md` })
    })
    await restartedEngine.restore(recovery.runId)
    const recovered = await restartedEngine.applyNarrativeReviewDecision({ runId: recovery.runId, decision: 'accept_prose_no_state', decisionId: 'r65-recovery-decision', expectedRevision: Number(recoveryReview.revision), note: '恢复测试' }, { actor: 'r65-ui-user' })
    const retry = await restartedEngine.applyNarrativeReviewDecision({ runId: recovery.runId, decision: 'accept_prose_no_state', decisionId: 'r65-recovery-decision', expectedRevision: Number(recoveryReview.revision), note: '恢复测试' }, { actor: 'r65-ui-user' })
    const conflict = await restartedEngine.applyNarrativeReviewDecision({ runId: recovery.runId, decision: 'accept_prose_no_state', decisionId: 'r65-recovery-decision', expectedRevision: Number(recoveryReview.revision), note: '不同的决策载荷' }, { actor: 'r65-ui-user' })
    const recoveredReview = await restartedEngine.getNarrativeReview(recovery.runId)
    const recoveredRun = repoAfterRestart.getRun(recovery.runId)
    const recoveryEvidence = repoAfterRestart.getRunEvidence(recovery.runId, 'narrative_semantic_review:revision:2')
    check('R65 fault injection reaches the post-commit/pre-final-packet window', recoveryStarted.ok && firstThrew && injected && committedBeforeRestart, JSON.stringify({ firstThrew, injected, committedBeforeRestart }))
    check('R65 same decisionId forward-completes after restart', recovered.ok && recovered.status === 'accepted' && recoveredRun.status === 'completed' && recoveredReview?.status === 'accepted' && recoveryEvidence !== null, JSON.stringify({ recovered, run: recoveredRun, review: recoveredReview?.status }))
    check('R65 repeated retry returns the same authoritative terminal result', retry.ok && retry.status === 'accepted' && retry.runStatus === 'completed' && retry.terminal === true, JSON.stringify(retry))
    check('R65 same decisionId with a different payload is rejected', !conflict.ok && conflict.error.startsWith('narrative_review_conflict:'), JSON.stringify(conflict))
    repoAfterRestart.close()

    const integrity = makeFixture('r65-pending-operation-integrity')
    const integrityStarted = await integrity.engine.start({ sessionId: integrity.sessionId, runId: integrity.runId, config: integrity.config })
    try { await integrity.engine.step(integrity.runId) } catch { /* expected waiting_user boundary */ }
    const integrityReview = await integrity.engine.getNarrativeReview(integrity.runId)
    const integrityRaw = integrity.repo.getRunEvidence(integrity.runId, 'narrative_semantic_review')
    let integrityPacketRejected = false
    if (integrityRaw && integrityReview) {
      const tampered = JSON.parse(integrityRaw.json) as AnyRecord
      tampered.pendingOperation = {
        operationId: 'attacker-operation',
        decisionId: 'attacker-operation',
        expectedRevision: integrityReview.revision,
        canonicalPayloadHash: null,
        durable: false
      }
      integrity.repo.saveRunEvidence(integrity.runId, 'narrative_semantic_review', JSON.stringify(tampered))
      const afterTamper = await integrity.engine.getNarrativeReview(integrity.runId)
      integrityPacketRejected = afterTamper === null || afterTamper.pendingOperation === undefined
      check('R65 packet parser rejects or clears an unbound pending operation', integrityStarted.ok && integrityPacketRejected, JSON.stringify({ afterTamper }))
    } else {
      check('R65 packet parser rejects or clears an unbound pending operation', false, JSON.stringify({ integrityStarted: integrityStarted.ok, integrityReview: Boolean(integrityReview), integrityRaw: Boolean(integrityRaw) }))
    }
    integrity.repo.close()

    const revisionRecovery = makeFixture('r65-revision-recovery')
    const revisionStarted = await revisionRecovery.engine.start({ sessionId: revisionRecovery.sessionId, runId: revisionRecovery.runId, config: revisionRecovery.config })
    try { await revisionRecovery.engine.step(revisionRecovery.runId) } catch { /* expected waiting_user boundary */ }
    const revisionReview = await revisionRecovery.engine.getNarrativeReview(revisionRecovery.runId)
    const originalSaveIfAbsent = revisionRecovery.repo.saveRunEvidenceIfAbsent
    let revisionInjected = false
    revisionRecovery.repo.saveRunEvidenceIfAbsent = function (runId: string, kind: string, json: string): boolean {
      if (!revisionInjected && kind.startsWith('narrative_semantic_review:revision:')) { revisionInjected = true; throw new Error('r65-final-revision-failure') }
      return originalSaveIfAbsent.call(revisionRecovery.repo, runId, kind, json)
    }
    let revisionFirstThrew = false
    try {
      await revisionRecovery.engine.applyNarrativeReviewDecision({ runId: revisionRecovery.runId, decision: 'accept_prose_no_state', decisionId: 'r65-revision-decision', expectedRevision: Number(revisionReview.revision) }, { actor: 'r65-ui-user' })
    } catch { revisionFirstThrew = true }
    revisionRecovery.repo.saveRunEvidenceIfAbsent = originalSaveIfAbsent
    const revisionPacket = await revisionRecovery.engine.getNarrativeReview(revisionRecovery.runId)
    const revisionRetry = await revisionRecovery.engine.applyNarrativeReviewDecision({ runId: revisionRecovery.runId, decision: 'accept_prose_no_state', decisionId: 'r65-revision-decision', expectedRevision: Number(revisionReview.revision) }, { actor: 'r65-ui-user' })
    const revisionEvidence = revisionRecovery.repo.getRunEvidence(revisionRecovery.runId, 'narrative_semantic_review:revision:2')
    check('R65 decision-evidence-before-revision failure leaves a final packet', revisionStarted.ok && revisionFirstThrew && revisionInjected && revisionPacket?.status === 'accepted', JSON.stringify({ revisionFirstThrew, revisionInjected, status: revisionPacket?.status }))
    check('R65 retry repairs a missing final revision snapshot without a Provider call', revisionRetry.ok && revisionRetry.runStatus === 'completed' && revisionRetry.terminal === true && revisionEvidence !== null && revisionRecovery.providerCalls === 1, JSON.stringify({ revisionRetry, evidence: Boolean(revisionEvidence), providerCalls: revisionRecovery.providerCalls }))
    revisionRecovery.repo.close()
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nR65 review recovery: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => { console.error('R65 review recovery 执行异常：', error); process.exitCode = 2 })
