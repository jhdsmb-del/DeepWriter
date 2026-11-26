import { desktopSourceExternals } from './desktop-source-boundary.mjs'
/**
 * R65/P1-01 actuality/assertion cross-product gate.
 *
 * This gate keeps the reviewed event oracle separate from the implementation:
 * an actual handover contract is evaluated against non-actual candidates, the
 * projection boundary is exercised, and a small production-shaped
 * AgentRunEngine + Repository pair confirms that the same distinction survives
 * the durable path.  It intentionally does not call a real provider.
 */
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import { buildSceneCompletionDecision, buildSceneContractPlan, evaluateSceneContract } from '../src/main/narrative/sceneContract'
import { extractNarrativeStateDelta } from '../src/main/narrative/stateExtractor'

type AnyRecord = Record<string, any>

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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function loadTsModule(relativePath: string, tag: string): Promise<Record<string, unknown>> {
  const outfile = path.join(ROOT, 'out', `r65-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

const CASES: readonly Array<{ label: string; text: string; actuality: string }> = [
  { label: 'refused', text: '林舟拒绝把钥匙交给沈遥。', actuality: 'refused' },
  { label: 'proposed', text: '林舟只是提议把钥匙交给沈遥。', actuality: 'proposed' },
  { label: 'questioned', text: '林舟询问是否应把钥匙交给沈遥。', actuality: 'questioned' },
  { label: 'near_miss', text: '林舟差点把钥匙交给沈遥。', actuality: 'near_miss' },
  { label: 'pretended', text: '林舟假装把钥匙交给沈遥。', actuality: 'pretended' },
  { label: 'quoted', text: '林舟说：“把钥匙交给沈遥。”', actuality: 'quoted' },
  { label: 'attempted', text: '林舟试图把钥匙交给沈遥。', actuality: 'attempted' },
  { label: 'threatened', text: '林舟威胁要把钥匙交给沈遥。', actuality: 'threatened' },
  { label: 'requested', text: '林舟请求沈遥把钥匙交给卫川。', actuality: 'requested' },
  { label: 'imperative', text: '林舟命令沈遥把钥匙交给卫川。', actuality: 'imperative' },
  { label: 'negated', text: '林舟没有把钥匙交给沈遥。', actuality: 'negated' },
  { label: 'planned', text: '林舟计划把钥匙交给沈遥。', actuality: 'planned' },
  { label: 'reported', text: '据说林舟把钥匙交给了沈遥。', actuality: 'reported' },
  { label: 'remembered', text: '林舟回忆起把钥匙交给沈遥的那天。', actuality: 'remembered' },
  { label: 'dreamed', text: '梦里林舟把钥匙交给沈遥。', actuality: 'dreamed' },
  { label: 'conditional', text: '如果林舟把钥匙交给沈遥，卫川就会离开。', actuality: 'conditional' }
]

function outlineFor(beat: string): GrillMeOutline {
  return {
    title: 'R65 事件现实性门禁',
    premise: '只有明确断言已经发生的事件才能改写当前故事状态。',
    targetChars: Array.from(beat).length,
    sections: [{ id: 's1', title: '钥匙交接', purpose: beat, targetChars: Array.from(beat).length, beats: [beat], sourceSlotIds: [] }]
  }
}

function forcedDecision(contract: AnyRecord, text: string): AnyRecord {
  const evaluation = evaluateSceneContract(contract, text, { completed: true }) as AnyRecord
  const decision = buildSceneCompletionDecision(contract, text, { candidateSegmentId: 'r65-segment', evaluation }) as AnyRecord
  // Deliberately force the extractor boundary for malformed/upstream callers:
  // even if a stale caller labels a non-actual evidence item “satisfied”, no
  // current holder may be emitted.
  return {
    ...decision,
    status: 'complete',
    satisfiedBeatIds: [...decision.requiredBeatIds],
    missingBeatIds: [],
    beatEvidence: (decision.beatEvidence ?? []).map((item: AnyRecord) => ({ ...item, status: 'satisfied' }))
  }
}

function extractFor(contract: AnyRecord, decision: AnyRecord, text: string): AnyRecord {
  const contentHash = sha256(text)
  return extractNarrativeStateDelta({
    runId: 'r65-projection-run',
    sceneId: contract.sceneId,
    contract,
    decision,
    candidateSegmentId: 'r65-segment',
    candidateContentHash: contentHash,
    acceptedSegments: [{ segmentId: 'r65-segment', content: text, contentHash, charCount: Array.from(text).length, chunkIndex: 1, revision: 1 }]
  }) as AnyRecord
}

async function runEngineCase(
  modules: { buildExecutionSnapshot: (input: AnyRecord) => AnyRecord; createRepository: (dbPath: string) => AnyRecord; createRunStorePort: (repository: unknown, artifactDir: string) => AnyRecord; createAgentRunEngine: (opts: AnyRecord) => AnyRecord },
  root: string,
  runId: string,
  output: string | string[],
  options: { forbidden?: string; auditPause?: boolean; legacySnapshot?: boolean; finiteCallCap?: number } = {}
): Promise<{ run: AnyRecord | null; ledger: AnyRecord[]; segments: AnyRecord[]; cards: AnyRecord[]; outboxPublished: number; indexReady: number; calls: number; rejectedProgress?: AnyRecord }> {
  const outputs = typeof output === 'string' ? [output] : output
  const targetChars = Array.from(outputs[outputs.length - 1]!).length
  const sessionId = `${runId}-session`
  const outline: GrillMeOutline = outlineFor('林舟把钥匙交给沈遥')
  outline.targetChars = targetChars
  outline.sections[0]!.targetChars = targetChars
  outline.sections[0]!.purpose = '林舟把钥匙交给沈遥'
  outline.sections[0]!.beats = ['林舟把钥匙交给沈遥']
  const outlineHash = grillMeOutlineHash(outline)
  const settings = {
    model: 'synthetic-r65',
    baseUrl: 'http://127.0.0.1:9',
    maxTokens: 4096,
    temperature: 0.7,
    topP: 1,
    thinkingEnabled: false,
    reasoningEffort: 'high',
    workDir: 'C:/r65-work',
    docDir: 'C:/r65-docs',
    novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' },
    historyBudgetTokens: 60000,
    strongConstraintEnabled: false
  }
  const config = modules.buildExecutionSnapshot({
    payload: {
      id: runId,
      mode: 'longwrite',
      workspace: 'novel',
      phase: 'execute',
      longMode: true,
      targetChars,
      text: '请依据已确认场景继续写作。',
      grillMe: { stateId: `${runId}-grill`, originalTask: '完成钥匙交接。', targetChars, answers: [], assumptions: [], approvedOutline: outline, outlineRevision: 1, outlineHash },
      strongConstraints: { enabled: false, ...(options.forbidden ? { avoid: options.forbidden } : {}) }
    },
    settings,
    sessionId,
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  if (options.legacySnapshot) {
    delete config.workBudgetPolicy
    config.maxTurns = 4
    config.providerCallBudget = { maxCalls: 16, maxTokens: 2000000, maxCost: null, maxCostCny: null, maxWallClockMs: 1800000 }
    config.completionContract.providerCallBudget = config.providerCallBudget
  }
  if (options.finiteCallCap !== undefined) {
    config.providerCallBudget = { ...config.providerCallBudget, maxCalls: options.finiteCallCap }
    config.completionContract.providerCallBudget = config.providerCallBudget
  }
  const repo = modules.createRepository(path.join(root, `${runId}.db`)) as AnyRecord
  repo.open()
  let calls = 0
  const engineOptions = {
    store: modules.createRunStorePort(repo, path.join(root, `${runId}-artifacts`)),
    modelCall: async () => {
      calls += 1
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<AnyRecord> {
          yield { type: 'text', delta: outputs[Math.min(calls - 1, outputs.length - 1)] }
          yield { type: 'finish', finishReason: 'stop' }
        }
      }
    },
    toolExecutor: async () => '',
    getConfig: () => config,
    onEvent: () => undefined,
    onRunUpdate: () => undefined,
    publishLongwriteArtifact: async () => ({ displayName: `${runId}.md`, relativePath: `${runId}.md` })
  }
  const engine = modules.createAgentRunEngine(engineOptions)
  try {
    await engine.start({ sessionId, runId, config })
    try { await engine.step(runId) } catch { /* semantic review may pause the run */ }
    const scope = repo.getNarrativeLedgerScope(runId) as AnyRecord | null
    const cards = scope
      ? repo.listSceneMemoryCards({ storyId: scope.storyId, projectId: scope.projectId, branchId: scope.branchId, validityEpoch: scope.validityEpoch }) as AnyRecord[]
      : []
    const db = new DatabaseSync(path.join(root, `${runId}.db`))
    const outboxPublished = Number((db.prepare("SELECT COUNT(*) AS count FROM scene_memory_card_outbox WHERE status='published' AND story_revision>=1").get() as AnyRecord | undefined)?.count ?? 0)
    const indexReady = Number((db.prepare("SELECT COUNT(*) AS count FROM scene_recall_index_meta WHERE status='ready' AND story_revision>=1").get() as AnyRecord | undefined)?.count ?? 0)
    db.close()
    const rejectedProgress = repo.getRunEvidence(runId, 'rejected_writing_progress_v1')
    const result = {
      run: repo.getRun(runId),
      ledger: repo.getNarrativeLedger(runId),
      segments: repo.getManuscriptSegmentsByRun(runId),
      cards,
      outboxPublished,
      indexReady,
      calls,
      rejectedProgress: rejectedProgress ? JSON.parse(rejectedProgress.json) as AnyRecord : undefined
    }
    if (options.auditPause && result.run?.error_code === 'writing_rejected_no_progress') {
      await engine.step(runId)
      const cold = modules.createAgentRunEngine(engineOptions)
      await cold.restore(runId)
      await cold.step(runId)
      check('R65 unchanged rejected pending state survives direct step and cold restore without another model request', calls === result.calls && repo.getRun(runId)?.status === 'waiting_user', JSON.stringify({ calls, run: repo.getRun(runId) }))
      repo.updateRun(runId, { status: 'recoverable', phase: 'recoverable', error_code: null, error_message: null })
      const crashGap = modules.createAgentRunEngine(engineOptions)
      await crashGap.restore(runId)
      await crashGap.step(runId)
      check('R65 durable rejection latch closes the crash gap before the paused run-row write', calls === result.calls && repo.getRun(runId)?.error_code === 'writing_rejected_no_progress', JSON.stringify({ calls, run: repo.getRun(runId) }))
      await crashGap.cancel(runId)
      check('R65 user cancellation remains available at unchanged-rejection pause', repo.getRun(runId)?.status === 'cancelled', JSON.stringify(repo.getRun(runId)))
    }
    return result
  } finally {
    try { repo.close() } catch { /* idempotent */ }
  }
}

async function main(): Promise<void> {
  const actualOutline = outlineFor('林舟把钥匙交给沈遥')
  const actualPlan = buildSceneContractPlan({ outline: actualOutline, outlineHash: grillMeOutlineHash(actualOutline), characterNames: ['林舟', '沈遥', '卫川'] })
  const actualContract = actualPlan.contracts[0] as AnyRecord
  let semanticFailures = 0
  for (const item of CASES) {
    const evaluation = evaluateSceneContract(actualContract, item.text, { completed: true }) as AnyRecord
    const evidence = evaluation.beatEvidence?.[0] as AnyRecord | undefined
    const decision = buildSceneCompletionDecision(actualContract, item.text, { candidateSegmentId: 'r65-segment', evaluation }) as AnyRecord
    const forced = forcedDecision(actualContract, item.text)
    const extraction = extractFor(actualContract, forced, item.text)
    const holders = (extraction.delta?.changes ?? [])
      .filter((change: AnyRecord) => change.kind === 'object_state' && change.holderId)
      .map((change: AnyRecord) => change.holderId)
    const expectedRejected = evidence?.actuality === item.actuality && evidence?.actuality !== 'asserted_actual' && evidence?.status !== 'satisfied' && decision.status !== 'complete' && holders.length === 0
    if (!expectedRejected) semanticFailures += 1
    check(`R65 actual contract rejects ${item.label}`, expectedRejected, JSON.stringify({ item, actuality: evidence?.actuality, status: evidence?.status, decision: decision.status, extraction: extraction.status, holders }))
  }

  const positiveText = '林舟把钥匙交给沈遥。'
  const positiveEvaluation = evaluateSceneContract(actualContract, positiveText, { completed: true }) as AnyRecord
  const positiveDecision = buildSceneCompletionDecision(actualContract, positiveText, { candidateSegmentId: 'r65-positive', evaluation: positiveEvaluation }) as AnyRecord
  const positiveHash = sha256(positiveText)
  const positiveExtraction = extractNarrativeStateDelta({
    runId: 'r65-positive-run',
    sceneId: actualContract.sceneId,
    contract: actualContract,
    decision: positiveDecision,
    candidateSegmentId: 'r65-positive',
    candidateContentHash: positiveHash,
    acceptedSegments: [{ segmentId: 'r65-positive', content: positiveText, contentHash: positiveHash, charCount: Array.from(positiveText).length, chunkIndex: 1, revision: 1 }]
  }) as AnyRecord
  const positiveHolder = positiveExtraction.delta?.changes.find((change: AnyRecord) => change.kind === 'object_state') as AnyRecord | undefined
  check('R65 asserted_actual handover still satisfies and writes holder=沈遥', positiveEvaluation.beatEvidence?.[0]?.actuality === 'asserted_actual' && positiveEvaluation.beatEvidence?.[0]?.status === 'satisfied' && positiveDecision.status === 'complete' && positiveHolder?.holderId === '沈遥' && positiveHolder?.holderStatus === 'known', JSON.stringify({ evidence: positiveEvaluation.beatEvidence?.[0], decision: positiveDecision.status, extraction: positiveExtraction.status, holder: positiveHolder }))

  const commandText = '林舟让沈遥把钥匙交给卫川。'
  const commandEvaluation = evaluateSceneContract(actualContract, commandText, { completed: true }) as AnyRecord
  const commandDecision = buildSceneCompletionDecision(actualContract, commandText, { candidateSegmentId: 'r65-command', evaluation: commandEvaluation }) as AnyRecord
  check('R65 command is recorded as imperative/requested, never actual handover', ['imperative', 'requested'].includes(commandEvaluation.beatEvidence?.[0]?.actuality) && commandEvaluation.beatEvidence?.[0]?.status !== 'satisfied' && commandDecision.status !== 'complete', JSON.stringify({ evidence: commandEvaluation.beatEvidence?.[0], decision: commandDecision.status }))

  // Predicate-locality regression: an earlier refusal must not poison a later
  // completed handover, while a nested quotation must not mutate the world.
  const mixedText = '林舟拒绝把钥匙交给沈遥，随后林舟把钥匙交给沈遥。'
  const mixedEvaluation = evaluateSceneContract(actualContract, mixedText, { completed: true }) as AnyRecord
  const mixedDecision = buildSceneCompletionDecision(actualContract, mixedText, { candidateSegmentId: 'r65-mixed', evaluation: mixedEvaluation }) as AnyRecord
  const mixedHash = sha256(mixedText)
  const mixedExtraction = extractNarrativeStateDelta({
    runId: 'r65-mixed-run',
    sceneId: actualContract.sceneId,
    contract: actualContract,
    decision: mixedDecision,
    candidateSegmentId: 'r65-mixed',
    candidateContentHash: mixedHash,
    acceptedSegments: [{ segmentId: 'r65-mixed', content: mixedText, contentHash: mixedHash, charCount: Array.from(mixedText).length, chunkIndex: 1, revision: 1 }]
  }) as AnyRecord
  const mixedHolder = mixedExtraction.delta?.changes.find((change: AnyRecord) => change.kind === 'object_state' && change.holderId) as AnyRecord | undefined
  check('R65 local actual event wins over preceding refusal', mixedEvaluation.beatEvidence?.[0]?.actuality === 'asserted_actual' && mixedEvaluation.beatEvidence?.[0]?.status === 'satisfied' && mixedDecision.status === 'complete' && mixedHolder?.holderId === '沈遥', JSON.stringify({ evidence: mixedEvaluation.beatEvidence?.[0], decision: mixedDecision.status, holder: mixedHolder }))

  const nestedQuoteText = '林舟说：「沈遥说：“把钥匙交给卫川。”」'
  const nestedQuoteEvaluation = evaluateSceneContract(actualContract, nestedQuoteText, { completed: true }) as AnyRecord
  check('R65 nested quote remains quoted and cannot satisfy actual contract', nestedQuoteEvaluation.beatEvidence?.[0]?.actuality === 'quoted' && nestedQuoteEvaluation.beatEvidence?.[0]?.status !== 'satisfied', JSON.stringify({ evidence: nestedQuoteEvaluation.beatEvidence?.[0] }))

  // Load and exercise the same production Engine + Repository path for the
  // positive and every reviewed non-actual candidate.  This is intentionally
  // a local synthetic provider: it proves wiring and durable projection, not
  // writing quality or provider performance.
  const [snapshotMod, repoMod, portMod, engineMod] = await Promise.all([
    loadTsModule('src/main/executionSnapshot.ts', 'snapshot'),
    loadTsModule('src/main/db/repository.ts', 'repo'),
    loadTsModule('src/main/runKernelAdapter.ts', 'port'),
    loadTsModule('src/main/jobs/AgentRunEngine.ts', 'engine')
  ])
  const modules = {
    buildExecutionSnapshot: snapshotMod.buildExecutionSnapshot as (input: AnyRecord) => AnyRecord,
    createRepository: repoMod.createRepository as (dbPath: string) => AnyRecord,
    createRunStorePort: portMod.createRunStorePort as (repository: unknown, artifactDir: string) => AnyRecord,
    createAgentRunEngine: engineMod.createAgentRunEngine as (opts: AnyRecord) => AnyRecord
  }
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r65-actuality-'))
  try {
    const enginePositive = await runEngineCase(modules, tmpDir, 'r65-engine-positive', positiveText)
    const positiveEngineHolder = enginePositive.ledger.find((change: AnyRecord) => change.kind === 'object_state') as AnyRecord | undefined
    check('R65 Engine+Repository positive path persists asserted holder', positiveEngineHolder?.holderId === '沈遥' && positiveEngineHolder?.holderStatus === 'known', JSON.stringify({ run: enginePositive.run, holder: positiveEngineHolder, calls: enginePositive.calls }))
    const positiveCard = enginePositive.cards.find((card: AnyRecord) => card.status === 'canonical' && card.visibility === undefined) as AnyRecord | undefined
    check('R73 single-scene live path atomically publishes accepted prose, ledger, card, outbox, and index', enginePositive.segments.some((segment: AnyRecord) => segment.status === 'accepted' && segment.kind === 'prose') && enginePositive.ledger.length > 0 && enginePositive.cards.length === 1 && enginePositive.outboxPublished === 1 && enginePositive.indexReady === 1, JSON.stringify({ segments: enginePositive.segments.map((segment: AnyRecord) => ({ status: segment.status, kind: segment.kind })), ledger: enginePositive.ledger.length, cards: enginePositive.cards.length, outboxPublished: enginePositive.outboxPublished, indexReady: enginePositive.indexReady }))
    check('R73 duplicate foreshadow history collapses to one final thread projection', positiveCard?.threads?.length === 1 && positiveCard.threads[0]?.threadId === 'thread:s1' && positiveCard.threads[0]?.lifecycle === 'resolved', JSON.stringify({ card: positiveCard }))
    // Exercise every reviewed non-actual transfer form through the production
    // Engine + Repository path, not only through the pure extractor. A
    // failed/paused run is expected; no object_state holder may be durable.
    for (const [index, item] of CASES.slice(0, 8).entries()) {
      const engineCase = await runEngineCase(modules, tmpDir, `r65-engine-${item.label}-${index + 1}`, item.text, { auditPause: index === 0 })
      const engineHolders = engineCase.ledger.filter((change: AnyRecord) => change.kind === 'object_state' && change.holderId)
      check(`R65 Engine+Repository ${item.label} has no holder mutation`, engineHolders.length === 0 && engineCase.run?.status !== 'completed' && !engineCase.ledger.some((change: AnyRecord) => change.kind === 'object_state'), JSON.stringify({ run: engineCase.run, holders: engineHolders, segments: engineCase.segments.map((row: AnyRecord) => ({ status: row.status, kind: row.kind })), calls: engineCase.calls }))
      check(`R65 Engine+Repository ${item.label} stops unchanged rejected work without a turn budget`, engineCase.run?.status === 'waiting_user' && engineCase.calls <= 2, JSON.stringify({ run: engineCase.run, calls: engineCase.calls }))
    }
    const advancing = await runEngineCase(modules, tmpDir, 'r65-engine-advancing-repair', [CASES[0]!.text, CASES[1]!.text, positiveText])
    check('R65 changed rejected candidates can advance to a valid scene without a numeric retry cap', advancing.calls === 3 && advancing.run?.status === 'completed' && advancing.ledger.some((change: AnyRecord) => change.kind === 'object_state' && change.holderId === '沈遥'), JSON.stringify({ run: advancing.run, calls: advancing.calls, ledger: advancing.ledger }))
    const forbidden = await runEngineCase(modules, tmpDir, 'r65-engine-narrative-rejected', '魔法在墙上闪烁。', { forbidden: '魔法', auditPause: true })
    check('R65 unchanged deterministic narrative-quality rejection also pauses without accepting or mutating world state', forbidden.calls === 2 && forbidden.run?.error_code === 'writing_rejected_no_progress' && forbidden.rejectedProgress?.stage === 'narrative_quality' && !forbidden.segments.some((row: AnyRecord) => row.status === 'accepted') && forbidden.ledger.length === 0, JSON.stringify({ run: forbidden.run, calls: forbidden.calls, rejectedProgress: forbidden.rejectedProgress }))
    const legacyPositive = await runEngineCase(modules, tmpDir, 'r65-engine-legacy-positive', positiveText, { legacySnapshot: true })
    check('R65 legacy frozen finite-budget snapshot still accepts genuine scene progress', legacyPositive.run?.status === 'completed' && legacyPositive.calls === 1, JSON.stringify({ run: legacyPositive.run, calls: legacyPositive.calls }))
    for (const legacySnapshot of [false, true]) {
      const bounded = await runEngineCase(modules, tmpDir, `r65-engine-bounded-rejection-${legacySnapshot}`, CASES[0]!.text, { legacySnapshot, finiteCallCap: 3 })
      check(`R65 ${legacySnapshot ? 'legacy frozen' : 'explicit finite'} rejected work keeps its original provider-budget pause`, bounded.calls === 3 && bounded.run?.error_code === 'run_provider_call_cap' && bounded.rejectedProgress === undefined && bounded.ledger.length === 0 && !bounded.segments.some((row: AnyRecord) => row.status === 'accepted'), JSON.stringify({ run: bounded.run, calls: bounded.calls, rejectedProgress: bounded.rejectedProgress }))
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\nR65 actuality contract: ${passed} PASS / ${failed} FAIL (semanticFailures=${semanticFailures})`)
  process.exitCode = failed > 0 || semanticFailures > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('R65 actuality contract 执行异常：', error)
  process.exitCode = 2
})
