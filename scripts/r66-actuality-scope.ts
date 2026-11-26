import { desktopSourceExternals } from './desktop-source-boundary.mjs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import { buildSceneCompletionDecision, buildSceneContractPlan, evaluateSceneContract } from '../src/main/narrative/sceneContract'
import { extractNarrativeStateDelta } from '../src/main/narrative/stateExtractor'

type AnyRecord = Record<string, any>
type Case = { label: string; text: string; actual: boolean }

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }
let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log('  PASS  ' + name)
  } else {
    failed += 1
    console.error('  FAIL  ' + name + (detail ? ' — ' + detail : ''))
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function loadTsModule(relativePath: string, tag: string): Promise<Record<string, unknown>> {
  const outfile = path.join(ROOT, 'out', 'r66-' + tag + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mjs')
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
          contents: 'export const app={getPath:(name)=>String(name),isPackaged:false}; export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]}),showSaveDialog:async()=>({canceled:true})}; export const ipcMain={handle:()=>undefined,on:()=>undefined}; export const safeStorage={isEncryptionAvailable:()=>false,encryptString:()=>null,decryptString:()=>String()}; export const shell={openExternal:()=>undefined,openPath:async()=>String()}; export const clipboard={writeText:()=>undefined}; export const Menu={buildFromTemplate:(template)=>({popup:()=>undefined,template})};',
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

const CASES: readonly Case[] = [
  { label: '本来要却收回', text: '林舟本来要把钥匙交给沈遥，却临时收回。', actual: false },
  { label: '正要被打断', text: '林舟正要把钥匙交给沈遥，门突然关上了。', actual: false },
  { label: '以为其实', text: '林舟以为自己已经把钥匙交给沈遥，其实钥匙还在口袋里。', actual: false },
  { label: '误以为', text: '林舟误以为自己把钥匙交给了沈遥。', actual: false },
  { label: '谎称', text: '林舟谎称自己把钥匙交给了沈遥。', actual: false },
  { label: '否认', text: '林舟否认自己把钥匙交给沈遥。', actual: false },
  { label: '阻止', text: '卫川阻止林舟把钥匙交给沈遥。', actual: false },
  { label: '避免', text: '林舟避免把钥匙交给沈遥。', actual: false },
  { label: '来不及', text: '林舟来不及把钥匙交给沈遥。', actual: false },
  { label: '证据不足', text: '证据不足以证明林舟把钥匙交给沈遥。', actual: false },
  { label: '没有犹豫便', text: '林舟没有犹豫便把钥匙交给沈遥。', actual: true },
  { label: '不愿再等便', text: '林舟不愿再等便把钥匙交给沈遥。', actual: true },
  { label: '拒绝后', text: '林舟拒绝卫川的提议后把钥匙交给沈遥。', actual: true },
  { label: '无视警告后', text: '林舟无视警告后把钥匙交给沈遥。', actual: true },
  { label: '让开道路后', text: '林舟让开道路后把钥匙交给沈遥。', actual: true },
  { label: '请示完毕后', text: '林舟请示完毕后把钥匙交给沈遥。', actual: true },
  { label: '使命完成随后', text: '林舟的使命已经完成随后把钥匙交给沈遥。', actual: true },
  { label: '准备妥当后', text: '林舟准备妥当后把钥匙交给沈遥。', actual: true },
  { label: '提出建议后', text: '林舟提出建议后把钥匙交给沈遥。', actual: true },
  { label: '想办法绕过后', text: '林舟想办法绕过守卫后把钥匙交给沈遥。', actual: true },
  { label: '确认没有追兵后', text: '林舟确认没有追兵后把钥匙交给沈遥。', actual: true }
]

// Generalisation probes deliberately sit outside the original R65/R66
// wording.  They exercise predicate-local questions, cognition, speech
// framing, bare negative disposal forms and ordinary positive aspect.  A
// keyword table that only memorises the historical 21 examples must fail at
// least one of these cases; the production path must keep the same
// fail-closed result as the pure evaluator.
const GENERALISATION_CASES: readonly Case[] = [
  { label: 'bare 不把', text: '林舟不把钥匙交给沈遥。', actual: false },
  { label: 'imperative 不要把', text: '林舟不要把钥匙交给沈遥。', actual: false },
  { label: '不可能', text: '林舟不可能把钥匙交给沈遥。', actual: false },
  { label: '未必', text: '林舟未必把钥匙交给沈遥。', actual: false },
  { label: 'trailing question particle', text: '林舟把钥匙交给沈遥吗？', actual: false },
  { label: 'question punctuation', text: '林舟把钥匙交给沈遥？', actual: false },
  { label: 'unquoted speech', text: '卫川说林舟把钥匙交给沈遥。', actual: false },
  { label: 'epistemic belief', text: '林舟觉得自己把钥匙交给沈遥。', actual: false },
  { label: 'failed plan', text: '林舟把钥匙交给沈遥的计划没有成功。', actual: false },
  { label: 'ambiguous trailing report', text: '林舟把钥匙交给沈遥，听说。', actual: false },
  { label: 'positive aspect', text: '林舟已经把钥匙交给了沈遥。', actual: true },
  { label: 'positive finally', text: '林舟终于把钥匙交给沈遥。', actual: true },
  { label: 'actual then unrelated negative', text: '林舟把钥匙交给沈遥，随后没有说话。', actual: true },
  { label: 'actual after quoted plan', text: '卫川说把钥匙交给沈遥，林舟随后把钥匙交给了沈遥。', actual: true },
  { label: 'planned through backdoor compound', text: '林舟本来要从后门把钥匙交给沈遥。', actual: false },
  { label: 'involuntary actual', text: '林舟不由得把钥匙交给沈遥。', actual: true }
]

const ALL_CASES: readonly Case[] = [...CASES, ...GENERALISATION_CASES]

function outlineFor(): GrillMeOutline {
  return {
    title: 'R66 actuality scope',
    premise: '只有谓词局部被高置信断言的事件才能写入世界状态。',
    targetChars: 100,
    sections: [{ id: 's1', title: '钥匙交接', purpose: '林舟把钥匙交给沈遥', targetChars: 100, beats: ['林舟把钥匙交给沈遥'], sourceSlotIds: [] }]
  }
}

function extractFor(contract: AnyRecord, decision: AnyRecord, text: string): AnyRecord {
  const contentHash = sha256(text)
  return extractNarrativeStateDelta({
    runId: 'r66-pure-run',
    sceneId: contract.sceneId,
    contract,
    decision,
    candidateSegmentId: String(decision.candidateSegmentId ?? 'r66-segment'),
    candidateContentHash: contentHash,
    acceptedSegments: [{ segmentId: String(decision.candidateSegmentId ?? 'r66-segment'), content: text, contentHash, charCount: Array.from(text).length, chunkIndex: 1, revision: 1 }]
  }) as AnyRecord
}

async function runEngineCase(
  modules: { buildExecutionSnapshot: (input: AnyRecord) => AnyRecord; createRepository: (dbPath: string) => AnyRecord; createRunStorePort: (repository: unknown, artifactDir: string) => AnyRecord; createAgentRunEngine: (opts: AnyRecord) => AnyRecord },
  root: string,
  runId: string,
  output: string
): Promise<{ run: AnyRecord | null; ledger: AnyRecord[]; segments: AnyRecord[]; stepError: { name: string; message: string; code?: string } | null }> {
  const targetChars = Array.from(output).length
  const sessionId = runId + '-session'
  const outline = outlineFor()
  outline.targetChars = targetChars
  outline.sections[0]!.targetChars = targetChars
  const outlineHash = grillMeOutlineHash(outline)
  const settings = {
    model: 'synthetic-r66',
    baseUrl: 'http://127.0.0.1:9',
    maxTokens: 4096,
    temperature: 0.7,
    topP: 1,
    thinkingEnabled: false,
    reasoningEffort: 'high',
    workDir: 'C:/r66-work',
    docDir: 'C:/r66-docs',
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
      grillMe: { stateId: runId + '-grill', originalTask: '完成钥匙交接。', targetChars, answers: [], assumptions: [], approvedOutline: outline, outlineRevision: 1, outlineHash },
      strongConstraints: { enabled: false }
    },
    settings,
    sessionId,
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  const repo = modules.createRepository(path.join(root, runId + '.db')) as AnyRecord
  repo.open()
  const engine = modules.createAgentRunEngine({
    store: modules.createRunStorePort(repo, path.join(root, runId + '-artifacts')),
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<AnyRecord> {
        yield { type: 'text', delta: output }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => config,
    onEvent: () => undefined,
    onRunUpdate: () => undefined,
    publishLongwriteArtifact: async () => ({ displayName: runId + '.md', relativePath: runId + '.md' })
  })
  try {
    await engine.start({ sessionId, runId, config })
    let stepError: { name: string; message: string; code?: string } | null = null
    try { await engine.step(runId) } catch (error) {
      const value = error as AnyRecord
      stepError = { name: typeof value?.name === 'string' ? value.name : 'Error', message: error instanceof Error ? error.message : String(error), ...(typeof value?.code === 'string' ? { code: value.code } : {}) }
    }
    return { run: repo.getRun(runId), ledger: repo.getNarrativeLedger(runId), segments: repo.getManuscriptSegmentsByRun(runId), stepError }
  } finally {
    try { repo.close() } catch { /* idempotent */ }
  }
}

function expectedSemanticPause(stepError: { name: string; message: string; code?: string } | null): boolean {
  return stepError === null || stepError.code === 'narrative_state_pending_review' || stepError.message === 'narrative_state_pending_review' || stepError.message.startsWith('scene_semantic_pending_review:')
}

async function main(): Promise<void> {
  const outline = outlineFor()
  const contract = buildSceneContractPlan({ outline, outlineHash: grillMeOutlineHash(outline), characterNames: ['林舟', '沈遥', '卫川'] }).contracts[0] as AnyRecord
  for (const item of ALL_CASES) {
    const evaluation = evaluateSceneContract(contract, item.text, { completed: true }) as AnyRecord
    const evidence = evaluation.beatEvidence?.[0] as AnyRecord
    const decision = buildSceneCompletionDecision(contract, item.text, { candidateSegmentId: 'r66-' + item.label, evaluation }) as AnyRecord
    const extraction = extractFor(contract, decision, item.text)
    const holder = extraction.delta?.changes?.find((change: AnyRecord) => change.kind === 'object_state' && change.holderId) as AnyRecord | undefined
    const groupsBound = evidence?.eventGroups?.every((group: AnyRecord) => group.predicateSpan && group.scope && Array.isArray(group.cueSpans)) === true
    if (item.actual) {
      check('R66 pure actual ' + item.label, evidence?.actuality === 'asserted_actual' && evidence?.status === 'satisfied' && decision.status === 'complete' && extraction.status === 'ready' && holder?.holderId === '沈遥', JSON.stringify({ evidence, decision: decision.status, extraction: extraction.status, holder }))
    } else {
      check('R66 pure nonactual ' + item.label, evidence?.actuality !== 'asserted_actual' && evidence?.assertion !== 'asserted' && evidence?.status !== 'satisfied' && decision.status !== 'complete' && extraction.status !== 'ready' && !holder, JSON.stringify({ evidence, decision: decision.status, extraction: extraction.status, holder }))
    }
    check('R66 explicit predicate/cue scope ' + item.label, groupsBound, JSON.stringify(evidence?.eventGroups))
  }

  // A model/critic packet is not a second authority for world state.  This is
  // deliberately adversarial: the structured packet claims that a planned
  // handover is already actual, but its spans/polarity do not bind to an
  // asserted-actual local event group.  The evaluator must reject the packet
  // before the completion decision or state extractor can see a holder edge.
  const modelAttackText = '林舟本来要把钥匙交给沈遥。'
  const modelAttackEvidence = [{
    beatId: String(contract.requiredBeatIds[0]),
    scenePrefixHash: sha256(''),
    candidateHash: sha256(modelAttackText),
    status: 'satisfied' as const,
    rationale: 'model claims the plan completed',
    actor: ['林舟'],
    action: ['handover'],
    object: ['钥匙'],
    location: [],
    result: [],
    time: [],
    agent: ['林舟'],
    patient: ['钥匙'],
    sourceRole: [],
    recipient: ['沈遥'],
    beneficiary: [],
    modality: 'actual' as const,
    actuality: 'asserted_actual' as const,
    assertion: 'asserted' as const,
    negation: false,
    spans: [{ start: 0, end: modelAttackText.length, text: modelAttackText }]
  }]
  const modelAttackEvaluation = evaluateSceneContract(contract, modelAttackText, { completed: true, modelEvidence: modelAttackEvidence }) as AnyRecord
  const modelAttackDecision = buildSceneCompletionDecision(contract, modelAttackText, { candidateSegmentId: 'r66-model-attack', evaluation: modelAttackEvaluation }) as AnyRecord
  const modelAttackExtraction = extractFor(contract, modelAttackDecision, modelAttackText)
  const modelAttackHolder = modelAttackExtraction.delta?.changes?.find((change: AnyRecord) => change.kind === 'object_state' && change.holderId) as AnyRecord | undefined
  check('R66 model evidence cannot promote planned event', modelAttackEvaluation.status === 'deviated' && modelAttackEvaluation.beatEvidence?.[0]?.status === 'contradicted' && modelAttackDecision.status === 'defer' && modelAttackExtraction.status !== 'ready' && !modelAttackHolder, JSON.stringify({ evaluation: modelAttackEvaluation, decision: modelAttackDecision.status, extraction: modelAttackExtraction.status, holder: modelAttackHolder }))

  // A model packet without a candidate hash or exact candidate spans is
  // opaque: it must not be allowed to turn a deterministic missing beat into
  // a satisfied beat or to donate a fabricated holder.
  const opaqueModelEvidence = [{
    beatId: String(contract.requiredBeatIds[0]),
    scenePrefixHash: sha256(''),
    status: 'satisfied' as const,
    actor: ['林舟'], action: ['handover'], object: ['钥匙'], recipient: ['沈遥'],
    actuality: 'asserted_actual' as const, assertion: 'asserted' as const, negation: false
  }]
  const opaqueModelText = '林舟在门口看见钥匙。'
  const opaqueModelEvaluation = evaluateSceneContract(contract, opaqueModelText, { completed: true, modelEvidence: opaqueModelEvidence }) as AnyRecord
  const opaqueModelDecision = buildSceneCompletionDecision(contract, opaqueModelText, { candidateSegmentId: 'r66-opaque-model', evaluation: opaqueModelEvaluation }) as AnyRecord
  const opaqueModelExtraction = extractFor(contract, opaqueModelDecision, opaqueModelText)
  const opaqueModelHolder = opaqueModelExtraction.delta?.changes?.find((change: AnyRecord) => change.kind === 'object_state' && change.holderId) as AnyRecord | undefined
  check('R66 opaque model evidence cannot satisfy missing beat', opaqueModelEvaluation.status === 'deviated' && opaqueModelDecision.status === 'defer' && opaqueModelExtraction.status !== 'ready' && !opaqueModelHolder, JSON.stringify({ evaluation: opaqueModelEvaluation, decision: opaqueModelDecision.status, extraction: opaqueModelExtraction.status, holder: opaqueModelHolder }))

  const multiCases: Array<{ label: string; text: string; actual: boolean }> = [
    { label: 'comma turn', text: '林舟拒绝把钥匙交给沈遥，随后林舟把钥匙交给沈遥。', actual: true },
    { label: 'unpunctuated turn', text: '林舟拒绝把钥匙交给沈遥却把钥匙交给沈遥。', actual: true },
    { label: 'unpunctuated refusal', text: '林舟拒绝把钥匙交给沈遥随后收回。', actual: false },
    { label: 'nested quote', text: '林舟说：「沈遥说：“把钥匙交给卫川。”」', actual: false },
    { label: 'double negation', text: '并非没有把钥匙交给沈遥。', actual: false },
    { label: 'long scope', text: '林舟本来要在暴雨压低塔窗、守卫换岗、潮水漫过石阶之后把钥匙交给沈遥。', actual: false },
    { label: 'long detached scope', text: '林舟拒绝卫川的提议之后，穿过三道门、避开巡逻、确认灯火熄灭，随后把钥匙交给沈遥。', actual: true },
    { label: 'homograph let', text: '林舟让开道路后把钥匙交给沈遥。', actual: true },
    { label: 'homograph ask', text: '林舟请示完毕后把钥匙交给沈遥。', actual: true },
    { label: 'epistemic uncertainty', text: '没有足够证据确认林舟把钥匙交给沈遥。', actual: false }
  ]
  for (const item of multiCases) {
    const evaluation = evaluateSceneContract(contract, item.text, { completed: true }) as AnyRecord
    const evidence = evaluation.beatEvidence?.[0] as AnyRecord
    const decision = buildSceneCompletionDecision(contract, item.text, { candidateSegmentId: 'r66-' + item.label, evaluation }) as AnyRecord
    const extraction = extractFor(contract, decision, item.text)
    const holder = extraction.delta?.changes?.find((change: AnyRecord) => change.kind === 'object_state' && change.holderId) as AnyRecord | undefined
    const expected = item.actual
      ? evidence?.actuality === 'asserted_actual' && evidence?.status === 'satisfied' && decision.status === 'complete' && extraction.status === 'ready' && holder?.holderId === '沈遥'
      : evidence?.actuality !== 'asserted_actual' && evidence?.status !== 'satisfied' && decision.status !== 'complete' && extraction.status !== 'ready' && !holder
    check('R66 scope combination ' + item.label, expected, JSON.stringify({ evidence, decision: decision.status, extraction: extraction.status, holder }))
  }

  const repeatedTransferText = '林舟把钥匙交给沈遥，又把钥匙交给卫川。'
  const repeatedTransferEvaluation = evaluateSceneContract(contract, repeatedTransferText, { completed: true }) as AnyRecord
  const repeatedTransferDecision = buildSceneCompletionDecision(contract, repeatedTransferText, { candidateSegmentId: 'r66-repeated-transfer', evaluation: repeatedTransferEvaluation }) as AnyRecord
  const repeatedTransferExtraction = extractFor(contract, repeatedTransferDecision, repeatedTransferText)
  const repeatedTransferHolder = repeatedTransferExtraction.delta?.changes?.find((change: AnyRecord) => change.kind === 'object_state' && change.holderId) as AnyRecord | undefined
  check('R66 repeated actual transfer uses latest predicate-local holder', repeatedTransferEvaluation.status === 'passed' && repeatedTransferDecision.status === 'complete' && repeatedTransferExtraction.status === 'ready' && repeatedTransferHolder?.holderId === '卫川', JSON.stringify({ evaluation: repeatedTransferEvaluation, decision: repeatedTransferDecision.status, extraction: repeatedTransferExtraction.status, holder: repeatedTransferHolder }))

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
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r66-actuality-scope-'))
  try {
    for (const item of ALL_CASES) {
      const result = await runEngineCase(modules, tmpDir, 'r66-engine-' + item.label, item.text)
      const holders = result.ledger.filter((change: AnyRecord) => change.kind === 'object_state' && change.holderId)
    if (item.actual) {
      check('R66 Engine+Repository actual ' + item.label, result.stepError === null && result.run?.status === 'completed' && holders.length === 1 && holders[0]?.holderId === '沈遥', JSON.stringify({ run: result.run, holders, stepError: result.stepError, segments: result.segments.map((row: AnyRecord) => ({ status: row.status, kind: row.kind })) }))
    } else {
      check('R66 Engine+Repository nonactual ' + item.label, expectedSemanticPause(result.stepError) && result.run?.status !== 'completed' && holders.length === 0 && !result.ledger.some((change: AnyRecord) => change.kind === 'object_state' && change.holderId), JSON.stringify({ run: result.run, holders, stepError: result.stepError, segments: result.segments.map((row: AnyRecord) => ({ status: row.status, kind: row.kind })) }))
      }
    }
    const repeatedTransferResult = await runEngineCase(modules, tmpDir, 'r66-engine-repeated-transfer', repeatedTransferText)
    const repeatedTransferHolders = repeatedTransferResult.ledger.filter((change: AnyRecord) => change.kind === 'object_state' && change.holderId)
    check('R66 Engine+Repository repeated transfer uses latest holder', repeatedTransferResult.stepError === null && repeatedTransferResult.run?.status === 'completed' && repeatedTransferHolders.length === 1 && repeatedTransferHolders[0]?.holderId === '卫川', JSON.stringify({ run: repeatedTransferResult.run, holders: repeatedTransferHolders, stepError: repeatedTransferResult.stepError }))
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log('\\nR66 actuality scope: ' + passed + ' PASS / ' + failed + ' FAIL')
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('R66 actuality scope 执行异常：', error)
  process.exitCode = 2
})
