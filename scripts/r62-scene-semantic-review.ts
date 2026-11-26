import { desktopSourceExternals } from './desktop-source-boundary.mjs'
/**
 * R62 production-shaped SceneContract semantic review.
 *
 * The writer is deliberately given a complete-looking, naturally ended
 * candidate whose authored beat has no deterministic event anchor.  A safe
 * engine must persist the full-prefix-bound review packet, leave the candidate
 * out of accepted正文, and stop before another provider call.  The same DB is
 * then loaded by a fresh engine instance to prove restart does not turn the
 * review boundary into an automatic continuation.
 */
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

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

async function loadTsModule(relativePath: string, tag: string): Promise<Record<string, unknown>> {
  const outfile = path.join(ROOT, 'out', `r62-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function completeProse(length: number): string {
  const points = Array.from('雨声压过空旷的堤岸，远处的灯火在雾里逐一熄灭。')
  while (points.length < length - 1) points.push(String.fromCodePoint(0x20000 + points.length))
  points.length = Math.max(0, length - 1)
  points.push('。')
  return points.join('')
}

async function main(): Promise<void> {
  const [snapshotMod, repoMod, portMod, engineMod, sceneMod, deltaMod, publisherMod] = await Promise.all([
    loadTsModule('src/main/executionSnapshot.ts', 'snapshot'),
    loadTsModule('src/main/db/repository.ts', 'repo'),
    loadTsModule('src/main/runKernelAdapter.ts', 'port'),
    loadTsModule('src/main/jobs/AgentRunEngine.ts', 'engine'),
    loadTsModule('src/main/narrative/sceneContract.ts', 'scene'),
    loadTsModule('src/main/narrative/stateDelta.ts', 'delta'),
    loadTsModule('src/cli/manuscript.ts', 'publisher')
  ])
  const buildExecutionSnapshot = snapshotMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  const createRepository = repoMod.createRepository as (dbPath: string) => {
    open(): void
    close(): void
    getRun(runId: string): Record<string, unknown> | null
    getSceneStates(runId: string): Array<Record<string, unknown>>
    getLatestCompletionEvaluation(runId: string): { state: string; json: string } | null
    getManuscriptSegmentsByRun(runId: string): Array<Record<string, unknown>>
    getRunEvidence(runId: string, kind: string): { json: string } | null
    getStoryLedgerFreshness(runId: string): Record<string, unknown> | null
    getArtifactsByRun(runId: string): Array<Record<string, unknown>>
  }
  const createRunStorePort = portMod.createRunStorePort as (repository: unknown, artifactDir: string) => Record<string, unknown>
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => {
    start(input: Record<string, unknown>): Promise<{ ok: boolean }>
    step(runId: string): Promise<void>
    restore(runId: string): Promise<void>
    getNarrativeReview(runId: string): Promise<Record<string, unknown> | null>
    applyNarrativeReviewDecision(input: Record<string, unknown>, opts?: { actor?: string }): Promise<{ ok: boolean; status?: string; error?: string }>
    getState(runId: string): Promise<{ run: { status: string; phase?: string; errorCode?: string; errorMessage?: string } | null }>
  }
  const buildSceneContractPlan = sceneMod.buildSceneContractPlan as (input: Record<string, unknown>) => { contracts: Array<Record<string, unknown>> }
  const evaluateSceneContract = sceneMod.evaluateSceneContract as (contract: Record<string, unknown>, candidate: string, opts: Record<string, unknown>) => Record<string, unknown>
  const buildNarrativeStateDelta = deltaMod.buildNarrativeStateDelta as (input: Record<string, unknown>) => Record<string, unknown>
  const stableNarrativeJson = deltaMod.stableNarrativeJson as (input: unknown) => string
  const publishCliManuscript = publisherMod.publishCliManuscript as (input: Record<string, unknown>) => Promise<{ displayName: string; relativePath: string }>

  const targetChars = 120
  const runId = 'r62-scene-semantic-production'
  const sessionId = 'r62-scene-semantic-session'
  const outline: GrillMeOutline = {
    title: '雾堤',
    premise: '验证一个没有明确动作锚点的场景不会被完整句子误判为完成。',
    targetChars,
    sections: [{
      id: 's1',
      title: '雾堤',
      purpose: '气氛变得压抑。',
      targetChars,
      beats: ['气氛变得压抑'],
      sourceSlotIds: []
    }]
  }
  const outlineHash = grillMeOutlineHash(outline)
  const plan = buildSceneContractPlan({ outline, outlineHash, outlineRevision: 1, answers: [], characterNames: [], strongConstraints: { forbiddenTerms: [], mustKeep: [] } })
  const contract = plan.contracts[0]!
  const opaqueEvaluation = evaluateSceneContract(contract, completeProse(120), { completed: true, scenePrefix: '' })
  check('R62 authored beat without an event anchor is unresolved, not vacuously satisfied', opaqueEvaluation.status === 'advisory' && (opaqueEvaluation.violations as Array<{ code?: string }>).some((v) => v.code === 'missing_required_beat'), JSON.stringify(opaqueEvaluation))

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r62-scene-semantic-'))
  const workDir = path.join(tmpDir, 'work')
  const docDir = path.join(tmpDir, 'documents')
  await Promise.all([fsp.mkdir(workDir), fsp.mkdir(docDir)])
  const settings = {
    model: 'synthetic-r62',
    baseUrl: 'http://127.0.0.1:9',
    maxTokens: 4096,
    temperature: 0.7,
    topP: 1,
    thinkingEnabled: false,
    reasoningEffort: 'high',
    workDir,
    docDir,
    novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' },
    historyBudgetTokens: 60000,
    strongConstraintEnabled: false
  }
  const config = buildExecutionSnapshot({
    payload: {
      id: runId,
      mode: 'longwrite',
      workspace: 'novel',
      phase: 'execute',
      longMode: true,
      targetChars,
      text: '请依据已确认场景继续写作。',
      grillMe: {
        stateId: 'r62-grill-state',
        originalTask: '写一段雾堤小说。',
        targetChars,
        answers: [],
        assumptions: [],
        approvedOutline: outline,
        outlineRevision: 1,
        outlineHash
      },
      strongConstraints: { enabled: false }
    },
    settings,
    sessionId,
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })

  const dbPath = path.join(tmpDir, 'run.db')
  const artifactDir = path.join(tmpDir, 'artifacts')
  const repo = createRepository(dbPath)
  repo.open()
  let providerCalls = 0
  const output = completeProse(120)
  const makeEngine = (store: Record<string, unknown>, restart = false) => createAgentRunEngine({
    store,
    modelCall: async () => {
      providerCalls += 1
      if (restart) throw new Error('R62 provider must not be called after restart')
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'length' }> {
          yield { type: 'text', delta: output }
          yield { type: 'finish', finishReason: 'length' }
        }
      }
    },
    toolExecutor: async () => '',
    getConfig: () => config,
    onEvent: () => undefined,
    onRunUpdate: () => undefined,
    publishLongwriteArtifact: publishCliManuscript
  })

  try {
    const store = createRunStorePort(repo, artifactDir)
    const engine = makeEngine(store)
    const started = await engine.start({ sessionId, runId, config })
    try { await engine.step(runId) } catch { /* expected semantic pause propagates through step */ }
    const state = await engine.getState(runId)
    const durableRun = repo.getRun(runId)
    const rows = repo.getManuscriptSegmentsByRun(runId)
    const pendingRaw = repo.getRunEvidence(runId, 'scene_semantic_pending_review')
    let pending: Record<string, unknown> | null = null
    try { pending = pendingRaw ? JSON.parse(pendingRaw.json) as Record<string, unknown> : null } catch { pending = null }
    const pendingSegments = pending?.acceptedSegments as Array<Record<string, unknown>> | undefined
    check('R62 real AgentRunEngine path enters waiting_user on semantic ambiguity', started.ok && state.run?.status === 'waiting_user' && durableRun?.status === 'waiting_user' && durableRun?.error_code === 'narrative_state_pending_review', JSON.stringify({ state: state.run, durableRun, providerCalls }))
    check('R62 unresolved candidate is never accepted and provider stops at one call', providerCalls === 1 && rows.some((row) => row.status === 'candidate') && !rows.some((row) => row.status === 'accepted' && row.kind === 'prose'), JSON.stringify({ calls: providerCalls, rows: rows.map((row) => ({ status: row.status, kind: row.kind, chars: row.char_count })) }))
    check('R62 pending evidence is structured, durable, and names the semantic reason', pending?.schemaVersion === 1 && pending.status === 'pending_review' && pending.reason === 'scene_semantic_ambiguous' && Array.isArray(pending.reasons) && (pending.reasons as Array<Record<string, unknown>>).some((reason) => reason.code === 'missing_required_beat'), JSON.stringify(pending))
    check('R62 evidence binds full current scene prefix and candidate identity', pending?.scenePrefixHash === hashText('') && pending.scenePrefixCharCount === 0 && pending.sceneContentHash === hashText(output) && pending.candidateContentHash === hashText(output) && pending.candidateCharCount === Array.from(output).length && Array.isArray(pendingSegments), JSON.stringify({ prefix: pending?.scenePrefixHash, scene: pending?.sceneContentHash, candidate: pending?.candidateContentHash }))

    const fenceKind = `narrative_review_story_fence:${String(pending?.packetHash)}`
    const originalFenceJson = repo.getRunEvidence(runId, fenceKind)?.json ?? ''
    const originalFenceRecord = JSON.parse(originalFenceJson) as Record<string, unknown>
    const { hash: originalFenceHash, ...originalFenceBody } = originalFenceRecord
    const originalFence = originalFenceRecord.fence as Record<string, unknown>
    const originalScope = originalFence.scope as { storyId: string; projectId: string; branchId: string }
    const originalAuthority = repo.getStoryLedgerFreshness(runId)
    check('R62 persisted provider fence digest binds original packet/candidate/contract and authoritative tuple', originalFenceHash === hashText(stableNarrativeJson(originalFenceBody)) && originalFenceRecord.runId === runId && originalFenceRecord.packetHash === pending?.packetHash && originalFenceRecord.revision === pending?.revision && originalFenceRecord.sceneId === pending?.sceneId && originalFenceRecord.candidateHash === hashText(output) && originalFenceRecord.contractHash === contract.frozenHash && originalFence.expectedRevision === originalAuthority?.runRevision && originalFence.expectedEpoch === originalAuthority?.validityEpoch && originalFence.expectedHeadRevision === originalAuthority?.headRevision && originalFence.expectedHeadHash === originalAuthority?.headHash && stableNarrativeJson(originalFence.scope) === stableNarrativeJson(originalAuthority?.scope))

    // A fresh engine instance simulates process restart.  restore() must keep
    // the durable pause, and a direct step must remain a no-op for this exact
    // semantic boundary (no hidden continuation path).
    repo.close()
    // A valid restart now restores the durable original tuple, not a fresh
    // head. Keep the old lost-fence negative contract explicit in real SQLite
    // clones; neither missing proof nor authority drift may mint a claim.
    for (const variant of ['missing-fence', 'head-drift']) {
      const negativePath = path.join(tmpDir, `${variant}.db`)
      await fsp.copyFile(dbPath, negativePath)
      const isolatedDb = new DatabaseSync(negativePath)
      try {
        if (variant === 'missing-fence') isolatedDb.prepare('DELETE FROM run_evidence WHERE run_id=? AND kind=?').run(runId, fenceKind)
        else isolatedDb.prepare('UPDATE story_ledger_heads SET head_hash=? WHERE story_id=? AND project_id=? AND branch_id=?').run('1'.repeat(64), originalScope.storyId, originalScope.projectId, originalScope.branchId)
      } finally { isolatedDb.close() }
      const negativeRepo = createRepository(negativePath)
      negativeRepo.open()
      try {
        const negativeEngine = makeEngine(createRunStorePort(negativeRepo, path.join(tmpDir, `${variant}-artifacts`)), true)
        let rejected = ''
        try { await negativeEngine.restore(runId) } catch (error) { rejected = error instanceof Error ? error.message : String(error) }
        check(`R62 ${variant} restart fails closed without a claim, accepted prose or Provider retry`, (variant === 'missing-fence' ? rejected.startsWith('story_ledger_fence_missing:') : rejected.includes('story_ledger_concurrent_head_conflict')) && negativeRepo.getRunEvidence(runId, `narrative_semantic_review:claim:${Number(pending?.revision)}`) === null && !negativeRepo.getManuscriptSegmentsByRun(runId).some(row => row.status === 'accepted' && row.kind === 'prose') && providerCalls === 1, rejected)
      } finally { negativeRepo.close() }
    }
    const repoAfterRestart = createRepository(dbPath)
    repoAfterRestart.open()
    try {
      const storeAfterRestart = createRunStorePort(repoAfterRestart, artifactDir)
      const restoredEngine = makeEngine(storeAfterRestart, true)
      await restoredEngine.restore(runId)
      const restored = await restoredEngine.getState(runId)
      check('R62 restart preserves waiting_user and pending semantic evidence', restored.run?.status === 'waiting_user' && restored.run?.errorCode === 'narrative_state_pending_review' && repoAfterRestart.getRunEvidence(runId, 'scene_semantic_pending_review') !== null, JSON.stringify(restored.run))
      check('R62 restart restores only the exact original provider fence JSON and authority, without replacing or claiming it', repoAfterRestart.getRunEvidence(runId, fenceKind)?.json === originalFenceJson && stableNarrativeJson(repoAfterRestart.getStoryLedgerFreshness(runId)) === stableNarrativeJson(originalAuthority) && repoAfterRestart.getRunEvidence(runId, `narrative_semantic_review:claim:${Number(pending?.revision)}`) === null && providerCalls === 1)
      try { await restoredEngine.step(runId) } catch { /* guard should make this a no-op */ }
      const afterStep = await restoredEngine.getState(runId)
      check('R62 stale retry after restart cannot invoke Provider', providerCalls === 1 && afterStep.run?.status === 'waiting_user', JSON.stringify({ calls: providerCalls, run: afterStep.run }))

      // v1.2.2 closure proof: accept_unknown is deliberately narrow.  A
      // scene-only ambiguity must not be turned into an empty delta; the user
      // must either provide a validated manual delta, request a rewrite, or
      // abandon the run.  The explicit delta path below proves the safe
      // alternative still commits without a hidden provider call.
      const review = await restoredEngine.getNarrativeReview(runId)
      const reviewCandidate = review?.candidate as Record<string, unknown> | undefined
      check('R62 restart surfaces candidate/contract/reasons as a hash-bound packet', review?.status === 'pending_review' && typeof review?.packetHash === 'string' && reviewCandidate?.contentHash === hashText(output) && Array.isArray(review?.missingBeatIds) && review?.contractHash === contract.frozenHash, JSON.stringify(review))
      const unknownDecision = review
        ? await restoredEngine.applyNarrativeReviewDecision({ runId, decision: 'accept_unknown', expectedRevision: Number(review.revision), decisionId: 'r62-scene-unknown-rejected' }, { actor: 'r62-restart-user' })
        : { ok: false, error: 'review missing' }
      const reviewForDelta = await restoredEngine.getNarrativeReview(runId)
      const reviewForDeltaCandidate = reviewForDelta?.candidate as Record<string, unknown> | undefined
      const candidateHash = String(reviewForDeltaCandidate?.contentHash ?? '')
      const manualDelta = reviewForDelta
        ? buildNarrativeStateDelta({
            schemaVersion: 1,
            runId,
            sceneId: String(reviewForDelta.sceneId),
            acceptedSegmentId: String(reviewForDeltaCandidate?.segmentId ?? ''),
            acceptedContentHash: candidateHash,
            contractHash: String(reviewForDelta.contractHash),
            changes: [{
              changeId: 'r62-manual-scene-observation',
              revision: 1,
              kind: 'character_state',
              entityId: 'scene-observation',
              runId,
              sceneId: String(reviewForDelta.sceneId),
              acceptedSegmentId: String(reviewForDeltaCandidate?.segmentId ?? ''),
              acceptedContentHash: candidateHash,
              contractHash: String(reviewForDelta.contractHash),
              characterId: 'scene-observation',
              status: 'observed',
              locationId: null,
              goals: [],
              physicalState: null,
              emotionalBaseline: null
            }]
          })
        : null
      // Only the fresh restored host may approve this candidate. Do not use
      // the old engine's ephemeral provider map as a fixture-only fallback.
      const decided = reviewForDelta && manualDelta
        ? await restoredEngine.applyNarrativeReviewDecision({ runId, decision: 'accept_delta', expectedRevision: Number(reviewForDelta.revision), decisionId: 'r62-scene-manual-delta', delta: manualDelta }, { actor: 'r62-restart-user' })
        : { ok: false, error: 'review missing' }
      const decidedRun = repoAfterRestart.getRun(runId)
      const finalReview = await restoredEngine.getNarrativeReview(runId)
      const decisionEvidence = repoAfterRestart.getRunEvidence(runId, 'narrative_semantic_review:revision:2')
      const acceptedAfterDecision = repoAfterRestart.getManuscriptSegmentsByRun(runId).some((row) => row.status === 'accepted' && row.kind === 'prose' && row.content_hash === hashText(output))
      const decidedStates = repoAfterRestart.getSceneStates(runId)
      const decisionEvaluation = repoAfterRestart.getLatestCompletionEvaluation(runId)
      const decidedRunErrorsClear = decidedRun?.error_code === null || decidedRun?.error_code === ''
      check('R62 scene-only ambiguity rejects unknown and accepts only an explicit manual delta with audit hashes', unknownDecision.ok === false && String(unknownDecision.error ?? '').includes('仅允许角色绑定歧义') && decided.ok && decided.status === 'accepted' && acceptedAfterDecision && decidedRunErrorsClear && finalReview?.status === 'accepted' && finalReview?.decision?.actor === 'r62-restart-user' && finalReview?.decision?.revision === 2 && typeof finalReview?.decision?.decisionHash === 'string' && decisionEvidence !== null, JSON.stringify({ unknownDecision, decided, run: { status: decidedRun?.status, errorCode: decidedRun?.error_code }, states: decidedStates.map((state) => ({ lifecycle: state.lifecycle, revision: state.revision, acceptedSegmentId: state.acceptedSegmentId })), completion: decisionEvaluation, finalReview: { status: finalReview?.status, decision: finalReview?.decision }, decisionEvidence: Boolean(decisionEvidence) }))
      const artifact = repoAfterRestart.getArtifactsByRun(runId).find(row => row.artifact_type === 'manuscript')
      const deliveredFile = artifact ? String(artifact.relative_path) : ''
      const deliveredText = deliveredFile ? await fsp.readFile(deliveredFile, 'utf8') : ''
      const acceptedText = repoAfterRestart.getManuscriptSegmentsByRun(runId).filter(row => row.status === 'accepted' && row.kind === 'prose').map(row => String(row.content)).join('')
      check('R62 restarted approval delivers an actual isolated file with accepted text, exact count and hash', Boolean(artifact) && path.dirname(deliveredFile) === await fsp.realpath(docDir) && deliveredText === output && deliveredText === acceptedText && Array.from(deliveredText).length === targetChars && hashText(deliveredText) === artifact?.hash && repoAfterRestart.getRunEvidence(runId, fenceKind)?.json === originalFenceJson && providerCalls === 1)
      try { await restoredEngine.step(runId) } catch { /* a committed one-scene run may finish without another call */ }
      const afterDecisionStep = await restoredEngine.getState(runId)
      check('R62 explicit decision continues/finishes without a Provider retry', providerCalls === 1 && afterDecisionStep.run?.status === 'completed', JSON.stringify({ calls: providerCalls, run: afterDecisionStep.run }))
    } finally {
      repoAfterRestart.close()
    }
  } finally {
    // repo is closed above in the restart branch; close() is idempotent in the
    // repository wrapper, and this also covers failures before that branch.
    try { repo.close() } catch { /* already closed */ }
    if (path.dirname(tmpDir) !== os.tmpdir() || !path.basename(tmpDir).startsWith('dw-r62-scene-semantic-')) throw new Error('R62 cleanup path is outside the isolated fixture')
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\nR62 scene semantic review: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('R62 scene semantic review 执行异常：', error)
  process.exitCode = 2
})
