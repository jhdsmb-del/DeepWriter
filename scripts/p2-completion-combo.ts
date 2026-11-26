import { desktopSourceExternals } from './desktop-source-boundary.mjs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import { buildNarrativeFactsFromGrill } from '../src/main/narrative/factRegistry'
import type { NarrativeFact } from '../src/shared/types'
import { publishCliManuscript } from '../src/cli/manuscript'

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

async function loadTsModule(relativePath: string): Promise<Record<string, unknown>> {
  const outfile = path.join(ROOT, 'out', `p2-combo-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

function exactProse(length: number, prefix: string, seed: number): string {
  const points = Array.from(prefix)
  const target = Math.max(1, Math.floor(length))
  while (points.length < target - 1) points.push(String.fromCodePoint(0x20000 + seed + points.length))
  points.length = Math.max(0, target - 1)
  points.push('。')
  return points.join('')
}

interface EngineState {
  run: { status: string; phase?: string; errorCode?: string; errorMessage?: string } | null
}

interface Repo {
  open(): void
  close(): void
  getRun(runId: string): Record<string, unknown> | null
  getSceneStates(runId: string): Array<Record<string, unknown>>
  getManuscriptSegmentsByRun(runId: string): Array<Record<string, unknown>>
  getRunEvidence(runId: string, kind: string): { json: string } | null
  getCompletionAttempts(runId: string): Array<Record<string, unknown>>
  upsertNarrativeFact(fact: NarrativeFact): NarrativeFact
  getNarrativeFacts(sessionId: string, includeInactive?: boolean): NarrativeFact[]
  getArtifactsByRun(runId: string): Array<Record<string, unknown>>
}

async function main(): Promise<void> {
  const [snapshotMod, repoMod, portMod, engineMod] = await Promise.all([
    loadTsModule('src/main/executionSnapshot.ts'),
    loadTsModule('src/main/db/repository.ts'),
    loadTsModule('src/main/runKernelAdapter.ts'),
    loadTsModule('src/main/jobs/AgentRunEngine.ts')
  ])
  const buildExecutionSnapshot = snapshotMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  const createRepository = repoMod.createRepository as (dbPath: string) => Repo
  const createRunStorePort = portMod.createRunStorePort as (repository: unknown, artifactDir: string) => Record<string, unknown>
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => {
    start(input: Record<string, unknown>): Promise<{ ok: boolean }>
    step(runId: string): Promise<void>
    getState(runId: string): Promise<EngineState>
  }

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p2-completion-combo-'))
  const targetChars = 180
  const outline: GrillMeOutline = {
    title: '完成门事故回归',
    premise: '林舟在灯塔等待沈遥，但交接 beat 仍未发生。',
    targetChars,
    sections: [{
      id: 's1',
      title: '等待交接',
      purpose: '林舟把钥匙交给沈遥。',
      targetChars,
      beats: ['林舟把钥匙交给沈遥'],
      sourceSlotIds: ['goal']
    }]
  }
  const outlineHash = grillMeOutlineHash(outline)
  const answers = [
    { slotId: 'goal', value: '完成钥匙交接', source: 'user' },
    { slotId: 'characters', value: '林舟、沈遥', source: 'user' }
  ]
  const settings = {
    model: 'synthetic-p2-completion-combo',
    baseUrl: 'http://127.0.0.1:9',
    maxTokens: 1024,
    temperature: 0.7,
    topP: 1,
    thinkingEnabled: false,
    reasoningEffort: 'high',
    workDir: path.join(tempRoot, 'work'),
    docDir: path.join(tempRoot, 'documents'),
    novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' },
    historyBudgetTokens: 12000,
    strongConstraintEnabled: false
  }

  const runIds = ['p2-combo-empty', 'p2-combo-meta', 'p2-combo-missing-fact', 'p2-combo-missing-beat', 'p2-combo-valid', 'p2-combo-repaired']
  const configs = new Map<string, Record<string, unknown>>()
  for (const runId of runIds) {
    const caseSessionId = `${runId}-session`
    configs.set(runId, buildExecutionSnapshot({
      payload: {
        id: runId,
        mode: 'longwrite',
        workspace: 'novel',
        phase: 'execute',
        longMode: true,
        targetChars,
        text: '请继续当前场景，只输出正文。',
        grillMe: {
          stateId: `${runId}-grill`,
          originalTask: '完成灯塔钥匙交接场景。',
          targetChars,
          answers,
          assumptions: [],
          approvedOutline: outline,
          outlineRevision: 1,
          outlineHash
        },
        strongConstraints: { enabled: false }
      },
      settings,
      sessionId: caseSessionId,
      memory: { projectPath: '', projectContent: '', userContent: '' }
    }))
  }

  const repo = createRepository(path.join(tempRoot, 'run.db'))
  repo.open()
  const store = createRunStorePort(repo, path.join(tempRoot, 'artifacts'))
  const calls = new Map<string, number>()
  const acceptedBeforeCalls = new Map<string, number[]>()
  const publications = new Map<string, number>()
  const missingBeat = (seed: number): string => exactProse(targetChars, '灯塔外的雨声渐密，石阶被水光染亮。', seed)
  const handoff = exactProse(targetChars, '林舟把钥匙交给沈遥，沈遥接过钥匙。灯塔外的雨声渐密，石阶被水光染亮。', 10)
  const outputs = new Map<string, string[]>([
    // Preserve the original full-length missing-beat drafts. The new guard
    // correctly keeps them out of accepted prose before empty/meta rewrites.
    ['p2-combo-empty', [missingBeat(1), '', '']],
    ['p2-combo-meta', [missingBeat(2), '说明：我会继续处理当前场景。', '']],
    ['p2-combo-missing-fact', [missingBeat(3)]],
    ['p2-combo-missing-beat', [missingBeat(4), missingBeat(5), missingBeat(6)]],
    ['p2-combo-valid', [handoff]],
    ['p2-combo-repaired', [missingBeat(7), handoff]]
  ])
  const engine = createAgentRunEngine({
    store,
    modelCall: async (input: { runId: string }) => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
        const index = calls.get(input.runId) ?? 0
        calls.set(input.runId, index + 1)
        const before = acceptedBeforeCalls.get(input.runId) ?? []
        before.push(repo.getManuscriptSegmentsByRun(input.runId).filter(row => row.status === 'accepted').length)
        acceptedBeforeCalls.set(input.runId, before)
        const text = outputs.get(input.runId)?.[index] ?? ''
        if (text) yield { type: 'text', delta: text }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: (runId: string) => configs.get(runId)!,
    onEvent: () => undefined,
    onRunUpdate: () => undefined,
    publishLongwriteArtifact: async (input: Parameters<typeof publishCliManuscript>[0]) => {
      publications.set(input.runId, (publications.get(input.runId) ?? 0) + 1)
      return publishCliManuscript(input)
    }
  })

  try {
    for (const runId of runIds) {
      const config = configs.get(runId)!
      // Match ContextService's production materialization: derive provenance,
      // hashes and active status from the actual user-confirmed answers, never
      // handcraft an active fact or remove the frozen sourceSlotIds. The one
      // negative deliberately omits only the required goal registry entry.
      for (const fact of buildNarrativeFactsFromGrill({ sessionId: `${runId}-session`, runId, answers })) {
        if (runId.endsWith('missing-fact') && fact.sourceSlotIds.includes('goal')) continue
        repo.upsertNarrativeFact(fact)
      }
      const started = await engine.start({ sessionId: `${runId}-session`, runId, config })
      try { await engine.step(runId) } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'narrative_state_pending_review') throw error
      }
      const final = await engine.getState(runId)
      const states = repo.getSceneStates(runId)
      const segments = repo.getManuscriptSegmentsByRun(runId)
      const accepted = segments.filter((segment) => segment.status === 'accepted' && segment.kind === 'prose')
      const scene = states[0]
      const decision = scene?.completionDecision
        ? (scene.completionDecision as { status?: string; missingBeatIds?: string[] })
        : null
      const budget = repo.getRunEvidence(runId, 'run_provider_budget_v1')
      const budgetJson = budget ? JSON.parse(budget.json) as { totalCalls?: number; zeroProgressRounds?: number; targetWindowRepairAttempts?: number; lastWriterRound?: { measuredChars?: number } } : {}
      const contract = (config.sceneContracts as { contracts: Array<{ sceneId: string; requiredFactIds: string[] }> }).contracts[0]!
      const repairRow = repo.getRunEvidence(runId, `scene_beat_repair:${contract.sceneId}`)
      const repair = repairRow ? JSON.parse(repairRow.json) as { attempts: unknown[]; maxAttempts: number } : null
      const evaluationRow = repo.getRunEvidence(runId, 'scene_contract_latest')
      const evaluation = evaluationRow ? JSON.parse(evaluationRow.json) as { beatEvidence?: Array<{ status: string }> } : null
      const facts = repo.getNarrativeFacts(`${runId}-session`)
      const activeGoal = facts.find(fact => fact.status === 'active' && fact.sourceSlotIds.includes('goal'))
      const artifacts = repo.getArtifactsByRun(runId)
      const positive = runId.endsWith('valid') || runId.endsWith('repaired')
      check(`${runId}：冻结 goal 保留且注册表无伪造补齐`, contract.requiredFactIds.includes('goal') && (runId.endsWith('missing-fact') ? activeGoal === undefined : activeGoal?.canonicalStatement === answers[0]!.value && activeGoal.sources.some(source => source.sourceType === 'answer' && source.sourceSlotId === 'goal' && source.sourceHash === activeGoal.canonicalHash)))
      if (positive) {
        const repaired = runId.endsWith('repaired')
        check(`${runId}：只有真实交接正文完整完成并 commit`, started.ok && final.run?.status === 'completed' && accepted.length === 1 && accepted[0]?.content === handoff && Number(accepted[0]?.char_count) === targetChars && scene?.lifecycle === 'committed' && decision?.status === 'complete', JSON.stringify({ run: final.run, accepted: accepted.length, lifecycle: scene?.lifecycle, decision }))
        check(`${runId}：实际模型调用/定向修订有界且缺 beat 从未成为 prefix`, calls.get(runId) === (repaired ? 2 : 1) && budgetJson.totalCalls === calls.get(runId) && repair?.attempts.length === (repaired ? 1 : 0) && acceptedBeforeCalls.get(runId)?.every(count => count === 0) === true && (!repaired || segments.some(row => row.status === 'rejected' && row.content === outputs.get(runId)![0])), JSON.stringify({ calls: calls.get(runId), repairs: repair?.attempts.length, acceptedBeforeCalls: acceptedBeforeCalls.get(runId) }))
        const delivered = artifacts.length === 1 ? await fsp.readFile(String(artifacts[0]!.relative_path), 'utf8') : ''
        check(`${runId}：真实 publisher 文件/哈希等于 accepted 正文`, publications.get(runId) === 1 && artifacts.length === 1 && delivered === handoff && createHash('sha256').update(delivered).digest('hex') === artifacts[0]?.hash && Number(artifacts[0]?.char_count) === targetChars && path.dirname(String(artifacts[0]?.relative_path)) === await fsp.realpath(settings.docDir))
        continue
      }

      // Reaching the length target never certifies an unresolved event. The
      // original accepted/unresolved expectation is intentionally migrated to
      // the stricter production candidate gate, not restored by a fake fact.
      check(`${runId}：足字数缺 beat 原稿保留但零 accepted/零交付`, accepted.length === 0 && !scene?.acceptedSegmentId && decision?.status !== 'complete' && segments.some(row => row.kind === 'prose' && row.content === outputs.get(runId)![0] && Number(row.char_count) === targetChars) && evaluation?.beatEvidence?.some(beat => beat.status === 'missing') === true && artifacts.length === 0 && (publications.get(runId) ?? 0) === 0, JSON.stringify({ accepted: accepted.length, lifecycle: scene?.lifecycle, decision, artifacts: artifacts.length, beatEvidence: evaluation?.beatEvidence }))
      if (runId.endsWith('missing-fact') || runId.endsWith('missing-beat')) {
        const missingFact = runId.endsWith('missing-fact')
        check(`${runId}：真实事实缺失/持续缺 beat 精确有界暂停`, started.ok && final.run?.status === 'waiting_user' && final.run.errorCode === 'narrative_state_pending_review' && final.run.errorMessage === (missingFact ? 'scene_beat_repair_required_fact_missing' : 'scene_beat_repair_exhausted:2') && calls.get(runId) === (missingFact ? 1 : 3) && budgetJson.totalCalls === calls.get(runId) && repair?.maxAttempts === 2 && repair.attempts.length === (missingFact ? 0 : 2), JSON.stringify({ run: final.run, calls: calls.get(runId), repairs: repair?.attempts.length }))
        continue
      }
      const expectedMeta = runId.endsWith('meta')
      const expectedError = final.run?.errorCode === 'run_no_progress'
      check(`${expectedMeta ? '元话术' : '空串'}事故：启动且在有界场景修复门 waiting_user`, started.ok && final.run?.status === 'waiting_user' && expectedError, JSON.stringify({ runId, status: final.run?.status, errorCode: final.run?.errorCode, calls: calls.get(runId) }))
      check(`${expectedMeta ? '元话术' : '空串'}事故：Provider 三次有界，零进度不冒充目标修复`, calls.get(runId) === 3 && Number(budgetJson.totalCalls ?? 0) === 3 && Number(budgetJson.zeroProgressRounds ?? 0) === 2 && Number(budgetJson.targetWindowRepairAttempts ?? 0) === 0 && Number(budgetJson.lastWriterRound?.measuredChars ?? 0) === 0 && repair?.attempts.length === 1, JSON.stringify({ calls: calls.get(runId), budget: budgetJson, repairs: repair?.attempts.length }))
      if (expectedMeta) {
        const rejected = segments.filter((segment) => segment.status === 'rejected')
        check('元话术未进入正式正文', rejected.length >= 1 && accepted.every((row) => !String(row.content).includes('说明：')), JSON.stringify({ rejected: rejected.map((row) => ({ kind: row.kind, content: row.content })) }))
      }
    }
  } finally {
    repo.close()
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\nP2 completion combo: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('P2 completion combo 执行异常：', error)
  process.exitCode = 2
})
