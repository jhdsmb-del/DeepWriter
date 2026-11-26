import { desktopSourceExternals } from './desktop-source-boundary.mjs'
/**
 * R64 focused narrative-review lifecycle matrix.
 *
 * This runs in the release-candidate gate. It drives the real
 * AgentRunEngine/repository path and
 * checks the post-decision snapshot rather than reconstructing lifecycle from
 * the decision label.
 */
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'

type AnyRecord = Record<string, any>

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

async function loadTsModule(relativePath: string, tag: string): Promise<Record<string, unknown>> {
  const outfile = path.join(ROOT, 'out', `r64-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await esbuild.build({
    entryPoints: [path.join(ROOT, relativePath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: true,
    outfile,
    external: desktopSourceExternals(path.join(ROOT, relativePath), ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite']),
    logLevel: 'silent',
    plugins: [{
      name: 'electron-shim',
      setup(build: { onResolve(options: unknown, callback: (result: { path: string; namespace: string }) => unknown): void; onLoad(options: unknown, callback: () => unknown): void }): void {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
        build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
          contents: 'export const app={getPath:(name)=>String(name),isPackaged:false}; export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]}),showSaveDialog:async()=>({canceled:true})}; export const ipcMain={handle:()=>undefined,on:()=>undefined}; export const safeStorage={isEncryptionAvailable:()=>false,encryptString:()=>null,decryptString:()=>""}; export const shell={openExternal:()=>undefined,openPath:async()=>""}; export const clipboard={writeText:()=>undefined}; export const Menu={buildFromTemplate:(template)=>({popup:()=>undefined,template})};',
          loader: 'js'
        }))
      }
    }]
  })
  try {
    return await import(url.pathToFileURL(outfile).href) as Record<string, unknown>
  } finally {
    await fsp.unlink(outfile).catch(() => undefined)
  }
}

let buildExecutionSnapshot: (input: Record<string, unknown>) => AnyRecord
let createRepository: (dbPath: string) => AnyRecord
let createRunStorePort: (repository: unknown, artifactDir: string) => AnyRecord
let createAgentRunEngine: (opts: Record<string, unknown>) => AnyRecord
let buildNarrativeStateDelta: (input: Record<string, unknown>) => AnyRecord

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

const hashText = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

function rewriteStoryHeadAtSameEpoch(dbPath: string, freshness: AnyRecord): void {
  const db = new DatabaseSync(dbPath)
  try {
    const head = db.prepare('SELECT high_watermark, validity_epoch FROM story_ledger_heads WHERE story_id=? AND project_id=? AND branch_id=?').get(
      freshness.scope.storyId,
      freshness.scope.projectId,
      freshness.scope.branchId
    ) as { high_watermark?: number; validity_epoch?: number } | undefined
    if (!head) throw new Error('r64 story-ledger head missing')
    db.prepare('UPDATE story_ledger_heads SET high_watermark=?, head_hash=?, validity_epoch=?, updated_at=? WHERE story_id=? AND project_id=? AND branch_id=?').run(
      Number(head.high_watermark ?? 0) + 1,
      'f'.repeat(64),
      Number(head.validity_epoch ?? freshness.validityEpoch ?? 1),
      Date.now(),
      freshness.scope.storyId,
      freshness.scope.projectId,
      freshness.scope.branchId
    )
  } finally {
    db.close()
  }
}

function completeProse(length: number): string {
  const points = Array.from('雨声压过空旷的堤岸，远处的灯火在雾里逐一熄灭。')
  while (points.length < length - 1) points.push(String.fromCodePoint(0x20000 + points.length))
  points.length = Math.max(0, length - 1)
  points.push('。')
  return points.join('')
}

function completeProseWithPrefix(prefix: string, length: number): string {
  const points = Array.from(prefix)
  while (points.length < length - 1) points.push(String.fromCodePoint(0x20000 + points.length))
  points.length = Math.max(0, length - 1)
  points.push('。')
  return points.join('')
}

type Fixture = {
  repo: AnyRecord
  engine: AnyRecord
  runId: string
  dbPath: string
  output: string
  events: AnyRecord[]
  close: () => void
}

type FixtureOptions = {
  completion?: 'paused' | 'failed'
  concreteBeat?: boolean
  outputPrefix?: string
  deferStep?: boolean
  onModelCall?: () => void
  onModelEvent?: () => void
  onAcceptanceReady?: () => void
  onCommitScene?: () => void
}

async function makeFixture(root: string, runId: string, opts: FixtureOptions = {}): Promise<Fixture> {
  const targetChars = 120
  const sessionId = `${runId}-session`
  const concreteBeat = opts.concreteBeat === true
  const scenePurpose = concreteBeat ? '林舟抵达灯塔。' : '气氛变得压抑。'
  const sceneBeat = concreteBeat ? '林舟抵达灯塔' : '气氛变得压抑'
  const outline: GrillMeOutline = {
    title: '雾堤',
    premise: '验证语义复核决定的生命周期快照。',
    targetChars,
    sections: [{ id: 's1', title: '雾堤', purpose: scenePurpose, targetChars, beats: [sceneBeat], sourceSlotIds: [] }]
  }
  const outlineHash = grillMeOutlineHash(outline)
  const settings = {
    model: 'synthetic-r64',
    baseUrl: 'http://127.0.0.1:9',
    maxTokens: 4096,
    temperature: 0.7,
    topP: 1,
    thinkingEnabled: false,
    reasoningEffort: 'high',
    workDir: 'C:/r64-work',
    docDir: 'C:/r64-docs',
    novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' },
    historyBudgetTokens: 60000,
    strongConstraintEnabled: false
  }
  const snapshot = buildExecutionSnapshot({
    payload: {
      id: runId,
      mode: 'longwrite',
      workspace: 'novel',
      phase: 'execute',
      longMode: true,
      targetChars,
      text: '请依据已确认场景继续写作。',
      grillMe: { stateId: `${runId}-grill`, originalTask: '写一段雾堤小说。', targetChars, answers: [], assumptions: [], approvedOutline: outline, outlineRevision: 1, outlineHash },
      strongConstraints: { enabled: false }
    },
    settings,
    sessionId,
    memory: { projectPath: '', projectContent: '', userContent: '' }
  }) as AnyRecord
  if (opts.completion === 'paused') {
    const cc = snapshot.completionContract as AnyRecord
    const validators = Array.isArray(cc?.validators)
      ? cc.validators.map((validator: AnyRecord) => validator.id === 'targetChars'
        ? { ...validator, config: { ...validator.config, min: 1000, max: 1000, tolerance: 0 } }
        : validator)
      : []
    snapshot.completionContract = { ...cc, targetChars: { min: 1000, max: 1000, tolerance: 0 }, validators, maxRepairAttempts: 0 }
  }
  const repo = createRepository(path.join(root, `${runId}.db`)) as AnyRecord
  repo.open()
  const events: AnyRecord[] = []
  const dbPath = path.join(root, `${runId}.db`)
  const output = opts.outputPrefix ? completeProseWithPrefix(opts.outputPrefix, targetChars) : completeProse(targetChars)
  const store = createRunStorePort(repo, path.join(root, `${runId}-artifacts`)) as AnyRecord
  if (opts.onAcceptanceReady && typeof store.saveRunEvidence === 'function') {
    const saveRunEvidence = store.saveRunEvidence
    store.saveRunEvidence = async (evidenceRunId: string, kind: string, json: string): Promise<void> => {
      await saveRunEvidence.call(store, evidenceRunId, kind, json)
      if (kind === 'manuscript_acceptance_ready') opts.onAcceptanceReady?.()
    }
  }
  if (opts.onCommitScene && typeof store.commitScene === 'function') {
    const commitScene = store.commitScene
    store.commitScene = async (...args: any[]): Promise<unknown> => {
      opts.onCommitScene?.()
      return commitScene.apply(store, args)
    }
  }
  const engine = createAgentRunEngine({
    store,
    modelCall: async () => {
      opts.onModelCall?.()
      return {
      async *[Symbol.asyncIterator](): AsyncGenerator<AnyRecord> {
          opts.onModelEvent?.()
          yield { type: 'text', delta: output }
          opts.onModelEvent?.()
          yield { type: 'finish', finishReason: 'length' }
      }
      }
    },
    toolExecutor: async () => '',
    getConfig: () => snapshot,
    onEvent: (_eventRunId: string, event: AnyRecord) => { events.push(event) },
    onRunUpdate: () => undefined,
    publishLongwriteArtifact: async () => ({ displayName: `${runId}.md`, relativePath: `${runId}.md` })
  }) as AnyRecord
  const started = await engine.start({ sessionId, runId, config: snapshot })
  check(`${runId} enters review boundary`, started.ok === true)
  if (!opts.deferStep) {
    try { await engine.step(runId) } catch { /* semantic review intentionally pauses */ }
  }
  return {
    repo,
    engine,
    runId,
    dbPath,
    output,
    events,
    close: () => { try { repo.close() } catch { /* idempotent */ } }
  }
}

function buildManualDelta(fixture: Fixture): AnyRecord {
  const row = fixture.repo.getManuscriptSegmentsByRun(fixture.runId).find((item: AnyRecord) => item.status === 'candidate') as AnyRecord
  const run = fixture.repo.getRun(fixture.runId) as AnyRecord
  const reviewRaw = fixture.repo.getRunEvidence(fixture.runId, 'narrative_semantic_review')
  const review = JSON.parse(reviewRaw.json) as AnyRecord
  return buildNarrativeStateDelta({
    schemaVersion: 1,
    runId: fixture.runId,
    sceneId: review.sceneId,
    acceptedSegmentId: row.segment_id,
    acceptedContentHash: row.content_hash,
    contractHash: review.contractHash,
    changes: [{
      changeId: `${fixture.runId}-manual-change`,
      revision: 1,
      kind: 'character_state',
      entityId: 'scene-observation',
      runId: fixture.runId,
      sceneId: review.sceneId,
      acceptedSegmentId: row.segment_id,
      acceptedContentHash: row.content_hash,
      contractHash: review.contractHash,
      characterId: 'scene-observation',
      status: 'observed',
      locationId: null,
      goals: [],
      physicalState: null,
      emotionalBaseline: null
    }]
  }) as AnyRecord
}

async function decide(fixture: Fixture, decision: 'accept_delta' | 'reject_rewrite' | 'abandon', decisionId: string): Promise<AnyRecord> {
  const review = await fixture.engine.getNarrativeReview(fixture.runId) as AnyRecord
  return fixture.engine.applyNarrativeReviewDecision({
    runId: fixture.runId,
    decision,
    decisionId,
    expectedRevision: Number(review.revision),
    ...(decision === 'accept_delta' ? { delta: buildManualDelta(fixture) } : {})
  }, { actor: 'r64-test' }) as Promise<AnyRecord>
}

async function main(): Promise<void> {
  const [snapshotMod, repoMod, portMod, engineMod, deltaMod] = await Promise.all([
    loadTsModule('src/main/executionSnapshot.ts', 'snapshot'),
    loadTsModule('src/main/db/repository.ts', 'repo'),
    loadTsModule('src/main/runKernelAdapter.ts', 'port'),
    loadTsModule('src/main/jobs/AgentRunEngine.ts', 'engine'),
    loadTsModule('src/main/narrative/stateDelta.ts', 'delta')
  ])
  buildExecutionSnapshot = snapshotMod.buildExecutionSnapshot as typeof buildExecutionSnapshot
  createRepository = repoMod.createRepository as typeof createRepository
  createRunStorePort = portMod.createRunStorePort as typeof createRunStorePort
  createAgentRunEngine = engineMod.createAgentRunEngine as typeof createAgentRunEngine
  buildNarrativeStateDelta = deltaMod.buildNarrativeStateDelta as typeof buildNarrativeStateDelta
  const rendererStoreMod = await loadTsModule('src/renderer/src/store.ts', 'renderer')
  const rendererStore = rendererStoreMod.useStore as AnyRecord
  const previousWindow = (globalThis as AnyRecord).window
  const rendererReviewOperation = {
    operationId: 'r64-renderer-operation',
    decisionId: 'r64-renderer-operation',
    expectedRevision: 1,
    canonicalPayloadHash: 'a'.repeat(64)
  }
  const rendererReviewDecisions = {
    accept_delta: { allowed: true, disabledReason: null },
    accept_unknown: { allowed: true, disabledReason: null },
    accept_prose_no_state: { allowed: true, disabledReason: null },
    reject_rewrite: { allowed: true, disabledReason: null },
    abandon: { allowed: true, disabledReason: null }
  }
  let rendererDecisionCall = 0
  ;(globalThis as AnyRecord).window = {
    ds: {
      runsNarrativeReviewDecide: async () => {
        rendererDecisionCall += 1
        return rendererDecisionCall === 1
          ? { ok: true, status: 'accepted', decisionStatus: 'accepted', runStatus: 'completed', phase: 'completed', terminal: true, needsStep: false }
          : { ok: true, status: 'rewrite_requested', decisionStatus: 'rewrite_requested', runStatus: 'running', phase: 'thinking', terminal: false, needsStep: true }
      }
    }
  }
  rendererStore.setState({ narrativeReview: { runId: 'reviewed-run', revision: 1, pendingOperation: rendererReviewOperation, allowedDecisions: rendererReviewDecisions }, running: true, runningId: 'other-run' })
  const unrelatedStateResult = await rendererStore.getState().decideNarrativeReview('accept_delta')
  const unrelatedState = rendererStore.getState()
  check('renderer preserves another run when review resolves terminal', unrelatedStateResult === true && unrelatedState.running === true && unrelatedState.runningId === 'other-run', JSON.stringify({ running: unrelatedState.running, runningId: unrelatedState.runningId }))
  rendererStore.setState({ narrativeReview: { runId: 'reviewed-run', revision: 2, pendingOperation: { ...rendererReviewOperation, expectedRevision: 2 }, allowedDecisions: rendererReviewDecisions }, running: false, runningId: null })
  const resumedStateResult = await rendererStore.getState().decideNarrativeReview('reject_rewrite')
  const resumedState = rendererStore.getState()
  check('renderer can reclaim the normal null runningId review boundary', resumedStateResult === true && resumedState.running === true && resumedState.runningId === 'reviewed-run', JSON.stringify({ running: resumedState.running, runningId: resumedState.runningId }))
  ;(globalThis as AnyRecord).window = previousWindow
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r64-review-'))
  const fixtures: Fixture[] = []
  try {
    let providerDrift: (() => void) | null = null
    let providerDrifted = false
    let providerStreamEvents = 0
    const providerFence = await makeFixture(tmpDir, 'r64-provider-head-fence', {
      concreteBeat: true,
      outputPrefix: '林舟抵达灯塔。',
      deferStep: true,
      onModelCall: () => providerDrift?.(),
      onModelEvent: () => { providerStreamEvents += 1 }
    })
    fixtures.push(providerFence)
    const providerBefore = providerFence.repo.getStoryLedgerFreshness(providerFence.runId) as AnyRecord
    providerDrift = () => {
      if (providerDrifted) return
      providerDrifted = true
      rewriteStoryHeadAtSameEpoch(providerFence.dbPath, providerBefore)
    }
    let providerThrew = false
    try { await providerFence.engine.step(providerFence.runId) } catch { providerThrew = true }
    const providerAfter = providerFence.repo.getStoryLedgerFreshness(providerFence.runId) as AnyRecord
    const providerRun = providerFence.repo.getRun(providerFence.runId) as AnyRecord
    const providerSegments = providerFence.repo.getManuscriptSegmentsByRun(providerFence.runId) as AnyRecord[]
    check('provider 返回后同 epoch head/revision drift 在首个流事件前 fail-closed', providerStreamEvents === 0 && providerRun.status === 'recovery_required' && providerRun.error_code === 'story_ledger_concurrent_head_conflict' && providerAfter.runRevision === providerBefore.runRevision && providerAfter.headRevision === providerBefore.headRevision + 1 && providerSegments.every((segment) => segment.status !== 'accepted'), JSON.stringify({ providerThrew, providerStreamEvents, providerRun, providerBefore, providerAfter, providerSegments }))

    let commitDrift: (() => void) | null = null
    let commitDrifted = false
    let commitCalled = false
    const commitFence = await makeFixture(tmpDir, 'r64-commit-head-fence', {
      concreteBeat: true,
      outputPrefix: '林舟抵达灯塔。',
      deferStep: true,
      onAcceptanceReady: () => commitDrift?.(),
      onCommitScene: () => { commitCalled = true }
    })
    fixtures.push(commitFence)
    const commitBefore = commitFence.repo.getStoryLedgerFreshness(commitFence.runId) as AnyRecord
    commitDrift = () => {
      if (commitDrifted) return
      commitDrifted = true
      rewriteStoryHeadAtSameEpoch(commitFence.dbPath, commitBefore)
    }
    let commitThrew = false
    try { await commitFence.engine.step(commitFence.runId) } catch { commitThrew = true }
    const commitAfter = commitFence.repo.getStoryLedgerFreshness(commitFence.runId) as AnyRecord
    const commitRun = commitFence.repo.getRun(commitFence.runId) as AnyRecord
    const commitSegments = commitFence.repo.getManuscriptSegmentsByRun(commitFence.runId) as AnyRecord[]
    check('scene commit 前同 epoch head/revision drift 被 Engine fence 拒绝且不推进旧游标', commitThrew && !commitCalled && commitRun.status === 'recovery_required' && commitRun.error_code === 'story_ledger_concurrent_head_conflict' && commitAfter.runRevision === commitBefore.runRevision && commitAfter.headRevision === commitBefore.headRevision + 1 && commitSegments.every((segment) => segment.status !== 'accepted'), JSON.stringify({ commitThrew, commitCalled, commitRun, commitBefore, commitAfter, commitSegments }))

    const complete = await makeFixture(tmpDir, 'r64-complete')
    fixtures.push(complete)
    const completeDelta = buildManualDelta(complete)
    const completeReview = await complete.engine.getNarrativeReview(complete.runId) as AnyRecord
    const completeResult = await complete.engine.applyNarrativeReviewDecision({ runId: complete.runId, decision: 'accept_delta', decisionId: 'r64-complete-decision', expectedRevision: Number(completeReview.revision), delta: completeDelta }, { actor: 'r64-test' }) as AnyRecord
    const completeRun = complete.repo.getRun(complete.runId) as AnyRecord
    const completeTerminal = complete.events.findIndex((event) => event.type === 'terminal')
    check('final complete returns authoritative completed snapshot', completeResult.ok && completeResult.status === 'accepted' && completeResult.decisionStatus === 'accepted' && completeResult.runStatus === 'completed' && completeResult.phase === 'completed' && completeResult.terminal === true && completeResult.needsStep === false && completeRun.status === 'completed', JSON.stringify(completeResult))
    complete.events.push({ type: 'ipc_resolved' })
    check('terminal event is observed before IPC decision resolves', completeTerminal >= 0 && completeTerminal < complete.events.length - 1, JSON.stringify(complete.events.map((event) => event.type)))
    const duplicate = await complete.engine.applyNarrativeReviewDecision({ runId: complete.runId, decision: 'accept_delta', decisionId: 'r64-complete-decision', expectedRevision: 1, delta: completeDelta }, { actor: 'r64-test' }) as AnyRecord
    check('same decisionId is idempotent and does not overwrite final decision', duplicate.ok && duplicate.runStatus === 'completed' && duplicate.terminal === true, JSON.stringify(duplicate))

    const paused = await makeFixture(tmpDir, 'r64-paused', { completion: 'paused' })
    fixtures.push(paused)
    const pausedResult = await decide(paused, 'accept_delta', 'r64-paused-decision')
    check('completion pause returns waiting_user/paused, never running', pausedResult.ok && pausedResult.status === 'accepted' && pausedResult.runStatus === 'waiting_user' && pausedResult.phase === 'paused' && pausedResult.terminal === false && pausedResult.needsStep === false, JSON.stringify(pausedResult))

    const failed = await makeFixture(tmpDir, 'r64-failed')
    fixtures.push(failed)
    const run = failed.repo.getRun(failed.runId) as AnyRecord
    failed.repo.saveCompletionEvaluation(failed.runId, 1, 'blocked', JSON.stringify({ revision: 1, state: 'blocked', hardFailures: [], softWarnings: [], measuredChars: 0, artifactHashes: [], remainingWork: [], repairAttempts: 0, startedAt: Date.now(), previousFindingKeys: [], currentFindingKeys: [], latestMeasuredChars: 0, lastDeltaChars: null }))
    const failedResult = await decide(failed, 'accept_delta', 'r64-failed-decision')
    const failedRun = failed.repo.getRun(failed.runId) as AnyRecord
    check('completion blocked returns failed terminal snapshot', failedResult.ok && failedResult.status === 'accepted' && failedResult.runStatus === 'failed' && failedResult.phase === 'failed' && failedResult.terminal === true && failedResult.needsStep === false && failedRun.status === 'failed', JSON.stringify(failedResult))

    const rewrite = await makeFixture(tmpDir, 'r64-rewrite')
    fixtures.push(rewrite)
    const rewriteResult = await decide(rewrite, 'reject_rewrite', 'r64-rewrite-decision')
    check('rewrite returns running snapshot and authorizes exactly one next step', rewriteResult.ok && rewriteResult.status === 'rewrite_requested' && rewriteResult.decisionStatus === 'rewrite_requested' && rewriteResult.runStatus === 'running' && rewriteResult.phase === 'thinking' && rewriteResult.terminal === false && rewriteResult.needsStep === true, JSON.stringify(rewriteResult))

    const abandon = await makeFixture(tmpDir, 'r64-abandon')
    fixtures.push(abandon)
    const abandonResult = await decide(abandon, 'abandon', 'r64-abandon-decision')
    const abandonTerminal = abandon.events.findIndex((event) => event.type === 'terminal')
    check('abandon returns cancelled terminal snapshot', abandonResult.ok && abandonResult.status === 'abandoned' && abandonResult.runStatus === 'cancelled' && abandonResult.phase === 'cancelled' && abandonResult.terminal === true && abandonResult.needsStep === false, JSON.stringify(abandonResult))
    check('abandon terminal event precedes IPC resolve boundary', abandonTerminal >= 0, JSON.stringify(abandon.events.map((event) => event.type)))

    const invalid = await makeFixture(tmpDir, 'r64-invalid-delta')
    fixtures.push(invalid)
    const invalidReview = await invalid.engine.getNarrativeReview(invalid.runId) as AnyRecord
    const validShape = buildManualDelta(invalid)
    const invalidDelta = buildNarrativeStateDelta({
      schemaVersion: 1,
      runId: invalid.runId,
      sceneId: String(invalidReview.sceneId),
      acceptedSegmentId: String(validShape.acceptedSegmentId),
      acceptedContentHash: String(validShape.acceptedContentHash),
      contractHash: String(validShape.contractHash),
      changes: [{
        changeId: `${invalid.runId}-missing-fact-change`,
        revision: 1,
        kind: 'knowledge',
        entityId: 'missing-fact',
        factId: 'missing-fact',
        knowerId: 'scene-observation',
        stance: 'knows',
        certainty: 1,
        sourceSceneId: invalidReview.sceneId,
        effectiveTime: null,
        confidence: 1,
        runId: invalid.runId,
        sceneId: String(invalidReview.sceneId),
        acceptedSegmentId: String(validShape.acceptedSegmentId),
        acceptedContentHash: String(validShape.acceptedContentHash),
        contractHash: String(validShape.contractHash)
      }]
    })
    const invalidResult = await invalid.engine.applyNarrativeReviewDecision({ runId: invalid.runId, decision: 'accept_delta', decisionId: 'r64-invalid-delta', expectedRevision: Number(invalidReview.revision), delta: invalidDelta }, { actor: 'r64-test' }) as AnyRecord
    const invalidAbandon = await invalid.engine.applyNarrativeReviewDecision({ runId: invalid.runId, decision: 'abandon', decisionId: 'r64-invalid-abandon', expectedRevision: Number(invalidReview.revision) }, { actor: 'r64-test' }) as AnyRecord
    check('missing Fact Registry rejects manual delta before consuming revision claim', invalidResult.ok === false && String(invalidResult.error).includes('fact_registry_missing') && invalidAbandon.ok && invalidAbandon.runStatus === 'cancelled', JSON.stringify({ invalidResult, invalidAbandon }))

    const interrupted = await makeFixture(tmpDir, 'r64-claim-recovery')
    fixtures.push(interrupted)
    const interruptedReview = await interrupted.engine.getNarrativeReview(interrupted.runId) as AnyRecord
    const interruptedDelta = buildManualDelta(interrupted)
    const originalSaveEvidence = interrupted.repo.saveRunEvidence
    let injectedFailure = false
    interrupted.repo.saveRunEvidence = function (runId: string, kind: string, json: string): void {
      if (!injectedFailure && kind.startsWith('scene_completion_decision:')) {
        injectedFailure = true
        throw new Error('r64-injected-post-claim-failure')
      }
      return originalSaveEvidence.call(interrupted.repo, runId, kind, json)
    }
    let firstAttemptThrew = false
    try {
      await interrupted.engine.applyNarrativeReviewDecision({ runId: interrupted.runId, decision: 'accept_delta', decisionId: 'r64-claim-retry', expectedRevision: Number(interruptedReview.revision), delta: interruptedDelta }, { actor: 'r64-test' })
    } catch {
      firstAttemptThrew = true
    }
    interrupted.repo.saveRunEvidence = originalSaveEvidence
    const recovered = await interrupted.engine.applyNarrativeReviewDecision({ runId: interrupted.runId, decision: 'accept_delta', decisionId: 'r64-claim-retry', expectedRevision: Number(interruptedReview.revision), delta: interruptedDelta }, { actor: 'r64-test' }) as AnyRecord
    check('post-claim persistence failure can be retried by the same decisionId', firstAttemptThrew && injectedFailure && recovered.ok && recovered.runStatus === 'completed' && recovered.terminal === true, JSON.stringify({ firstAttemptThrew, injectedFailure, recovered }))

    const concurrent = await makeFixture(tmpDir, 'r64-concurrent')
    fixtures.push(concurrent)
    const review = await concurrent.engine.getNarrativeReview(concurrent.runId) as AnyRecord
    const delta = buildManualDelta(concurrent)
    const [first, second] = await Promise.all([
      concurrent.engine.applyNarrativeReviewDecision({ runId: concurrent.runId, decision: 'accept_delta', decisionId: 'r64-concurrent-a', expectedRevision: Number(review.revision), delta }, { actor: 'r64-test' }),
      concurrent.engine.applyNarrativeReviewDecision({ runId: concurrent.runId, decision: 'abandon', decisionId: 'r64-concurrent-b', expectedRevision: Number(review.revision) }, { actor: 'r64-test' })
    ]) as [AnyRecord, AnyRecord]
    const outcomes = [first, second]
    check('concurrent accept/abandon has exactly one winner', outcomes.filter((result) => result.ok).length === 1 && outcomes.filter((result) => !result.ok && String(result.error).startsWith('narrative_review_conflict:')).length === 1, JSON.stringify(outcomes))
    const finalConcurrent = concurrent.repo.getRun(concurrent.runId) as AnyRecord
    check('CAS winner leaves one durable terminal/review decision', ['completed', 'cancelled'].includes(String(finalConcurrent.status)) && concurrent.repo.getRunEvidence(concurrent.runId, 'narrative_semantic_review:revision:2') !== null, JSON.stringify(finalConcurrent))
  } finally {
    for (const fixture of fixtures) fixture.close()
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nR64 narrative review lifecycle: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('R64 lifecycle matrix 执行异常：', error)
  process.exitCode = 2
})
