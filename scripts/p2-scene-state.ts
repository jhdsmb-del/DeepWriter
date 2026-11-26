import { desktopSourceExternals } from './desktop-source-boundary.mjs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import { buildNarrativeFactsFromGrill } from '../src/main/narrative/factRegistry'
import { publishCliManuscript } from '../src/cli/manuscript'
import type { NarrativeFact } from '../src/shared/types'

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
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function loadTsModule(relativePath: string): Promise<Record<string, unknown>> {
  const outfile = path.join(ROOT, 'out', `p2-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

function prose(length: number, prefix: string, seed: number): string {
  const points = Array.from(prefix)
  while (points.length < length - 1) points.push(String.fromCodePoint(0x3400 + ((seed + points.length) % 2000)))
  points.length = Math.max(0, length - 1)
  points.push('。')
  return points.join('')
}

async function main(): Promise<void> {
  const [sceneMod, repoMod, portMod, engineMod, snapshotMod] = await Promise.all([
    loadTsModule('src/main/narrative/sceneContract.ts'),
    loadTsModule('src/main/db/repository.ts'),
    loadTsModule('src/main/runKernelAdapter.ts'),
    loadTsModule('src/main/jobs/AgentRunEngine.ts'),
    loadTsModule('src/main/executionSnapshot.ts')
  ])
  const buildSceneContractPlan = sceneMod.buildSceneContractPlan as (input: Record<string, unknown>) => { contracts: Array<{ sceneId: string; contractId: string; frozenHash: string; order: number }> }
  const createRepository = repoMod.createRepository as (dbPath: string) => {
    open(): void
    close(): void
    createRun(input: Record<string, unknown>): void
    ensureSceneStates(runId: string, plan: Record<string, unknown>, at: number): void
    getSceneStates(runId: string): Array<Record<string, unknown>>
    getManuscriptSegmentsByRun(runId: string): Array<Record<string, unknown>>
    getLatestCompletionEvaluation(runId: string): { state: string; json: string } | null
    upsertNarrativeFact(fact: NarrativeFact): NarrativeFact
    getNarrativeFacts(sessionId: string): NarrativeFact[]
    getRunEvidence(runId: string, kind: string): { json: string } | null
    getArtifactsByRun(runId: string): Array<Record<string, unknown>>
  }
  const createRunStorePort = portMod.createRunStorePort as (repository: unknown, artifactDir: string) => Record<string, unknown>
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => {
    start(input: Record<string, unknown>): Promise<{ ok: boolean }>
    step(runId: string): Promise<void>
    getState(runId: string): Promise<{ run: { status: string; errorCode?: string; errorMessage?: string } | null }>
  }
  const buildExecutionSnapshot = snapshotMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>

  const targetChars = 360
  const outline: GrillMeOutline = {
    title: '雾港夜班',
    premise: '守灯人必须在暴雨前完成灯塔钥匙交接。',
    targetChars,
    sections: [
      {
        id: 's1', title: '雨夜交接', purpose: '完成灯塔交接并留下决定。', targetChars: 240,
        beats: ['林舟抵达灯塔'], sourceSlotIds: ['goal'],
        scenes: [
          { id: 'arrival', title: '抵达', purpose: '林舟抵达灯塔。', targetChars: 120, beats: ['林舟抵达灯塔'], sourceSlotIds: ['goal'] },
          { id: 'handoff', title: '交接', purpose: '沈遥交出钥匙。', targetChars: 120, beats: ['沈遥交出钥匙'], sourceSlotIds: ['goal'] }
        ]
      },
      { id: 's2', title: '灯塔亮起', purpose: '灯塔亮起并承接结尾。', targetChars: 120, beats: ['灯塔亮起'], sourceSlotIds: ['goal'] }
    ]
  }
  const outlineHash = grillMeOutlineHash(outline)
  const sceneInput = {
    outline,
    outlineHash,
    outlineRevision: 2,
    answers: [{ slotId: 'goal', value: '完成灯塔交接', source: 'user' }],
    characterNames: ['林舟', '沈遥'],
    strongConstraints: { forbiddenTerms: [], mustKeep: [] }
  }
  const plan = buildSceneContractPlan(sceneInput)
  const planAgain = buildSceneContractPlan(sceneInput)
  check('P2 section.scenes 编译为多场且顺序/身份稳定', plan.contracts.length === 3 && JSON.stringify(plan.contracts.map((item) => item.sceneId)) === JSON.stringify(planAgain.contracts.map((item) => item.sceneId)) && plan.contracts.every((item, index) => item.order === index + 1), JSON.stringify(plan.contracts.map((item) => item.sceneId)))
  check('P2 不确认 POV/location 时保持为空', !('povCharacterId' in plan.contracts[0]!) && !('locationId' in plan.contracts[0]!), JSON.stringify(plan.contracts[0]))

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p2-scene-'))
  const dbPath = path.join(tmpDir, 'run.db')
  const repo = createRepository(dbPath)
  repo.open()
  const runId = 'p2-db-run'
  const engineRunId = 'p2-engine-run'
  const sessionId = 'p2-session'
  repo.createRun({ run_id: runId, session_id: 'p2-db-session', status: 'queued', phase: 'queued', started_at: 1, updated_at: 1, config_json: '{}', parent_run_id: null, error_code: null, error_message: null, client_request_id: null })
  repo.ensureSceneStates(runId, plan as unknown as Record<string, unknown>, 10)
  const initialStates = repo.getSceneStates(runId)
  check('P2 migration 建立 durable scene_states 且按 order 初始化 planned', initialStates.length === 3 && initialStates.every((item) => item.lifecycle === 'planned') && initialStates[0]?.revision === 1)
  const firstSceneId = String(plan.contracts[0]!.sceneId)
  const firstContract = plan.contracts[0]!
  const restartDb = path.join(tmpDir, 'restart.db')
  const restartRepo = createRepository(restartDb)
  restartRepo.open()
  restartRepo.createRun({ run_id: 'p2-restart', session_id: 'p2-db-session', status: 'running', phase: 'thinking', started_at: 1, updated_at: 1, config_json: '{}', parent_run_id: null, error_code: null, error_message: null, client_request_id: null })
  restartRepo.ensureSceneStates('p2-restart', plan as unknown as Record<string, unknown>, 10)
  const state0 = restartRepo.getSceneStates('p2-restart')[0]!
  restartRepo.close()
  const restartRepo2 = createRepository(restartDb)
  restartRepo2.open()
  const stateAfterRestart = restartRepo2.getSceneStates('p2-restart')[0]!
  check('P2 重启保持同一 scene identity/lifecycle（不靠 acceptedChars）', stateAfterRestart.sceneId === state0.sceneId && stateAfterRestart.contractHash === state0.contractHash && stateAfterRestart.lifecycle === 'planned')
  restartRepo2.close()

  const settings = {
    model: 'synthetic-p2', baseUrl: 'http://127.0.0.1:9', maxTokens: 4096, temperature: 0.7, topP: 1,
    thinkingEnabled: false, reasoningEffort: 'high', workDir: path.join(tmpDir, 'work'), docDir: path.join(tmpDir, 'documents'), novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' }, historyBudgetTokens: 60000, strongConstraintEnabled: false
  }
  const makeConfig = (caseRunId: string, caseSessionId: string): Record<string, unknown> => buildExecutionSnapshot({
    payload: {
      id: caseRunId, mode: 'longwrite', workspace: 'novel', phase: 'execute', longMode: true, targetChars,
      text: '请依据已确认大纲完成长文。',
      grillMe: {
        stateId: caseRunId === engineRunId ? 'p2-grill' : `${caseRunId}-grill`, originalTask: '写一篇灯塔交接小说。', targetChars,
        answers: [{ slotId: 'goal', value: '完成灯塔交接', source: 'user' }], assumptions: [], approvedOutline: outline,
        outlineRevision: 2, outlineHash
      },
      strongConstraints: { enabled: false }
    },
    settings, sessionId: caseSessionId, memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  const config = makeConfig(engineRunId, sessionId)
  const missingHandoff = prose(70, '海风沉默地掠过海面，', 1001)
  const explicitHandoff = prose(100, '沈遥把钥匙交给林舟，', 2001)
  const outputs = [
    prose(100, '林舟抵达灯塔，', 1),
    // The original missing draft is rejected, not an accepted continuation.
    missingHandoff,
    // A complete replacement retains the original background and supplies
    // the original explicit transfer. The final accepted text is unchanged;
    // dropping the background would put the 360-char task below its window.
    missingHandoff + explicitHandoff,
    prose(94, '灯塔亮起，', 3001)
  ]
  let calls = 0
  let handoffAcceptedBeforeRepair = -1
  let handoffMissingBeforeRepair = false
  let publisherCalls = 0
  const artifactDir = path.join(tmpDir, 'artifacts')
  const store = createRunStorePort(repo, artifactDir)
  const engine = createAgentRunEngine({
    store,
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
        if (calls === 2) {
          handoffAcceptedBeforeRepair = repo.getManuscriptSegmentsByRun(engineRunId).filter(row => row.scene_id === plan.contracts[1]!.sceneId && row.status === 'accepted').length
          const evidence = repo.getRunEvidence(engineRunId, 'scene_contract_latest')
          handoffMissingBeforeRepair = evidence !== null && (JSON.parse(evidence.json) as { beatEvidence: Array<{ status: string }> }).beatEvidence.some(beat => beat.status === 'missing')
        }
        const output = outputs[Math.min(calls, outputs.length - 1)]!
        calls++
        if (calls > 12) throw new Error('p2_test_provider_call_cap')
        yield { type: 'text', delta: output }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => config,
    onEvent: () => undefined,
    onRunUpdate: () => undefined,
    publishLongwriteArtifact: async (input: Parameters<typeof publishCliManuscript>[0]) => { publisherCalls++; return publishCliManuscript(input) }
  })
  try {
    // Match production ContextService: confirmed answers are materialized by
    // the actual builder, with canonical/provenance hashes and source slots.
    for (const fact of buildNarrativeFactsFromGrill({ sessionId, runId: engineRunId, answers: sceneInput.answers })) repo.upsertNarrativeFact(fact)
    const started = await engine.start({ sessionId, runId: engineRunId, config })
    await engine.step(engineRunId)
    const final = await engine.getState(engineRunId)
    const states = repo.getSceneStates(engineRunId)
    const rows = repo.getManuscriptSegmentsByRun(engineRunId)
    const latestCompletion = repo.getLatestCompletionEvaluation(engineRunId)
    check('P2 真实 engine 按 durable scene 顺序完成并切换两次', started.ok && final.run?.status === 'completed' && states.length === 3 && states.every((item) => item.lifecycle === 'committed'), JSON.stringify({ status: final.run?.status, calls, rows: rows.map((row) => ({ status: row.status, kind: row.kind, chars: row.char_count, scene: row.scene_id })), completion: latestCompletion?.json, states }))
    check('P2 缺 beat 原候选 rejected/零 accepted prefix，真实完整改稿补齐才 commit', handoffAcceptedBeforeRepair === 0 && handoffMissingBeforeRepair && rows.some(row => row.content === missingHandoff && row.status === 'rejected') && states.some((item) => item.sceneId === firstSceneId && item.lifecycle === 'committed') && states[1]?.acceptedSegmentId && states[1]?.completionDecision && (states[1]!.completionDecision as { status?: string }).status === 'complete', JSON.stringify({ handoffAcceptedBeforeRepair, handoffMissingBeforeRepair, states }))
    check('P2 字数仅作预算提示：scene identity 不受 provider 单轮上限影响', String(states[0]?.contractId).includes(firstContract.contractId.split(':').slice(0, 2).join(':')) && plan.contracts[0]?.sceneId === firstSceneId && calls <= outputs.length + 1, `calls=${calls} first=${JSON.stringify(states[0])}`)
    const goalFact = repo.getNarrativeFacts(sessionId).find(fact => fact.status === 'active' && fact.sourceSlotIds.includes('goal'))
    check('P2 原冻结 sourceSlot/goal 绑定生产 builder 的真实确认答案', plan.contracts.every(contract => (contract as unknown as { requiredFactIds: string[] }).requiredFactIds.includes('goal')) && goalFact?.canonicalStatement === sceneInput.answers[0]!.value && goalFact.sources.some(source => source.sourceType === 'answer' && source.sourceSlotId === 'goal' && source.sourceHash === goalFact.canonicalHash))
    const acceptedText = rows.filter(row => row.status === 'accepted' && row.kind === 'prose').map(row => String(row.content)).join('')
    const artifact = repo.getArtifactsByRun(engineRunId)[0]
    const delivered = artifact ? await fsp.readFile(String(artifact.relative_path), 'utf8') : ''
    check('P2 真实 publisher 文件/哈希等于原完整 accepted 正文和目标窗口', publisherCalls === 1 && acceptedText === outputs[0]! + missingHandoff + explicitHandoff + outputs[3]! && delivered === acceptedText && Array.from(delivered).length === 364 && createHash('sha256').update(delivered).digest('hex') === artifact?.hash && path.dirname(String(artifact?.relative_path)) === await fsp.realpath(settings.docDir))

    // Independent negatives retain the same outline/required goal. Neither
    // an absent registry nor repeatedly missing authored events can be fixed
    // by granting an active fact, accepting prose or invoking the publisher.
    for (const missingFact of [true, false]) {
      const negativeRun = missingFact ? 'p2-goal-missing' : 'p2-beat-missing'
      const negativeSession = `${negativeRun}-session`
      const negativeConfig = makeConfig(negativeRun, negativeSession)
      if (!missingFact) for (const fact of buildNarrativeFactsFromGrill({ sessionId: negativeSession, runId: negativeRun, answers: sceneInput.answers })) repo.upsertNarrativeFact(fact)
      let negativeCalls = 0; let negativePublications = 0
      const negativeEngine = createAgentRunEngine({
        store, getConfig: () => negativeConfig, toolExecutor: async () => '', onEvent: () => undefined, onRunUpdate: () => undefined,
        modelCall: async () => ({ async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
          if (++negativeCalls > 3) throw new Error('p2_negative_provider_call_cap')
          yield { type: 'text', delta: missingHandoff }; yield { type: 'finish', finishReason: 'stop' }
        } }),
        publishLongwriteArtifact: async (input: Parameters<typeof publishCliManuscript>[0]) => { negativePublications++; return publishCliManuscript(input) }
      })
      const negativeStarted = await negativeEngine.start({ runId: negativeRun, sessionId: negativeSession, config: negativeConfig })
      try { await negativeEngine.step(negativeRun) } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'narrative_state_pending_review') throw error
      }
      const negativeFinal = await negativeEngine.getState(negativeRun)
      const repairRow = repo.getRunEvidence(negativeRun, `scene_beat_repair:${firstSceneId}`)
      const repair = repairRow ? JSON.parse(repairRow.json) as { attempts: unknown[] } : null
      check(`P2 ${missingFact ? '缺真实 goal' : '持续缺 beat'}保持精确有界 pending/零 accepted/零交付`, negativeStarted.ok && negativeFinal.run?.status === 'waiting_user' && negativeFinal.run.errorCode === 'narrative_state_pending_review' && negativeFinal.run.errorMessage === (missingFact ? 'scene_beat_repair_required_fact_missing' : 'scene_beat_repair_exhausted:2') && negativeCalls === (missingFact ? 1 : 3) && repair?.attempts.length === (missingFact ? 0 : 2) && !repo.getManuscriptSegmentsByRun(negativeRun).some(row => row.status === 'accepted') && repo.getArtifactsByRun(negativeRun).length === 0 && negativePublications === 0, JSON.stringify({ run: negativeFinal.run, calls: negativeCalls, attempts: repair?.attempts.length }))
    }
  } finally {
    repo.close()
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nP2 scene state: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('P2 scene state 执行异常：', error)
  process.exitCode = 2
})
