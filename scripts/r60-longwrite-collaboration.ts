import { desktopSourceExternals } from './desktop-source-boundary.mjs'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import { buildNarrativeFactsFromGrill } from '../src/main/narrative/factRegistry'
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
  const outfile = path.join(ROOT, 'out', `r60-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

function exactProse(length: number, seed: number, prefix: string): string {
  const points = Array.from(prefix)
  const target = Math.max(1, Math.floor(length))
  while (points.length < target - 1) points.push(String.fromCodePoint(0x20000 + seed + points.length))
  points.length = Math.max(0, target - 1)
  points.push('。')
  return points.join('')
}

function partialProse(length: number, seed: number, prefix: string): string {
  const points = Array.from(prefix)
  const target = Math.max(1, Math.floor(length))
  while (points.length < target) points.push(String.fromCodePoint(0x22000 + seed + points.length))
  points.length = target
  return points.join('')
}

async function main(): Promise<void> {
  const [snapshotMod, repoMod, portMod, engineMod] = await Promise.all([
    loadTsModule('src/main/executionSnapshot.ts'),
    loadTsModule('src/main/db/repository.ts'),
    loadTsModule('src/main/runKernelAdapter.ts'),
    loadTsModule('src/main/jobs/AgentRunEngine.ts')
  ])
  const buildExecutionSnapshot = snapshotMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  const createRepository = repoMod.createRepository as (dbPath: string) => {
    open(): void
    close(): void
    getManuscriptSegmentsByRun(runId: string): Array<Record<string, unknown>>
    getArtifactsByRun(runId: string): Array<Record<string, unknown>>
    getRunEvidence(runId: string, kind: string): { json: string } | null
    getNarrativeFacts(sessionId: string): NarrativeFact[]
    upsertNarrativeFact(fact: NarrativeFact): NarrativeFact
    getSceneStates(runId: string): Array<{ lifecycle: string; acceptedSegmentId: string | null; completionDecision: { status?: string } | null }>
  }
  const createRunStorePort = portMod.createRunStorePort as (repository: unknown, artifactDir: string) => {
    getArtifactContent(hash: string): Promise<string | null>
  }
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => {
    start(input: Record<string, unknown>): Promise<{ ok: boolean }>
    step(runId: string): Promise<void>
    getState(runId: string): Promise<{ run: { status: string; errorCode?: string } | null; turns: Array<{ role: string; content: string }> }>
  }

  const targetChars = 8000
  const outline: GrillMeOutline = {
    title: '雾港夜班',
    premise: '守灯人必须在暴雨前完成灯塔钥匙交接。',
    targetChars,
    sections: [{
      id: 's1',
      title: '雨夜交接',
      purpose: '林舟抵达灯塔，与沈遥完成钥匙交接。',
      targetChars,
      beats: ['林舟抵达灯塔', '沈遥交出钥匙'],
      sourceSlotIds: ['goal', 'characters', 'scope']
    }]
  }
  const outlineHash = grillMeOutlineHash(outline)
  const grillMe = {
    stateId: 'r60-grill-state',
    originalTask: '写一篇发生在雾港灯塔的长篇小说片段。',
    targetChars,
    answers: [
      { slotId: 'goal', value: '完成有代价的灯塔交接', source: 'user' },
      { slotId: 'characters', value: '林舟、沈遥', source: 'user' },
      { slotId: 'scope', value: '不要出现魔法', source: 'user' }
    ],
    assumptions: [],
    approvedOutline: outline,
    outlineRevision: 1,
    outlineHash
  }
  const settings = {
    model: 'synthetic-r60',
    baseUrl: 'http://127.0.0.1:9',
    maxTokens: 4096,
    temperature: 0.7,
    topP: 1,
    thinkingEnabled: false,
    reasoningEffort: 'high',
    workDir: 'C:/r60-work',
    docDir: 'C:/r60-docs',
    novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' },
    historyBudgetTokens: 60000,
    // The confirmed outline still freezes SceneContract, while this test
    // keeps the auxiliary critic/editor provider calls out of the fixture.
    strongConstraintEnabled: false
  }
  // Preserve the old fixture verbatim as a negative. These first three prose
  // rounds never perform the required handoff, so none may become accepted
  // prefix merely because it is complete, on-topic or adds characters.
  const first = exactProse(600, 1, '林舟抵达灯塔，')
  const pollution = '{"outline":["不应进入正文"]}'
  const partial = exactProse(500, 1000, '雨声压低了两人的呼吸，')
  const continuation = exactProse(700, 2000, '，门外的脚步声终于停住，')
  const deviation = '魔法在塔顶闪烁。'
  const final = exactProse(6200, 3000, '沈遥把钥匙交到他手里，林舟握紧钥匙，沈遥抬头看向海面，')
  const handoff = exactProse(targetChars, 3000, '林舟抵达灯塔，雨声压低了两人的呼吸，门外的脚步声终于停住，沈遥把钥匙交到他手里，林舟握紧钥匙，沈遥抬头看向海面，')
  const cases = [
    { id: 'original-draft', outputs: [first, pollution, partial, continuation, deviation, final], positive: false },
    { id: 'missing-fact', outputs: [first], positive: false },
    { id: 'valid', outputs: [handoff], positive: true },
    { id: 'repaired', outputs: [first, handoff], positive: true },
    { id: 'short-round', outputs: [partial, handoff], positive: true },
    { id: 'continuation-round', outputs: [continuation, handoff], positive: true },
    { id: 'meta-isolated', outputs: [pollution, handoff], positive: true },
    { id: 'deviation-isolated', outputs: [deviation, handoff], positive: true }
  ]
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r60-collaboration-'))
  const repo = createRepository(path.join(tmpDir, 'run.db'))
  repo.open()
  const artifactDir = path.join(tmpDir, 'artifacts')
  const store = createRunStorePort(repo, artifactDir)
  try {
    for (const scenario of cases) {
      const runId = `r60-${scenario.id}`
      const sessionId = `${runId}-session`
      const config = buildExecutionSnapshot({
        payload: {
          id: runId, mode: 'longwrite', workspace: 'novel', phase: 'execute',
          longMode: true, targetChars, text: '请依据已确认大纲完成长文。',
          grillMe, strongConstraints: { enabled: false }
        },
        settings, sessionId,
        memory: { projectPath: '', projectContent: '', userContent: '' }
      })
      // ContextService materializes these exact confirmed answers in production.
      // Do not grant semantic acceptance with hand-built facts or remove the
      // goal/characters/scope requirements. The negative omits only goal.
      for (const fact of buildNarrativeFactsFromGrill({ sessionId, runId, answers: grillMe.answers })) {
        if (scenario.id === 'missing-fact' && fact.sourceSlotIds.includes('goal')) continue
        repo.upsertNarrativeFact(fact)
      }
      let providerCalls = 0
      const acceptedBeforeCalls: number[] = []
      const capturedMessages: Array<Array<{ role: string; content: string }>> = []
      let published: { content: string; contentHash: string } | null = null
      let publications = 0
      const engine = createAgentRunEngine({
        store,
        modelCall: async (input: { messages: Array<{ role: string; content: string }> }) => ({
          async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
            const text = scenario.outputs[providerCalls] ?? ''
            acceptedBeforeCalls.push(repo.getManuscriptSegmentsByRun(runId).filter(row => row.status === 'accepted').length)
            providerCalls += 1
            capturedMessages.push(input.messages.map((message) => ({ role: message.role, content: message.content })))
            for (let offset = 0; offset < text.length; offset += 512) yield { type: 'text', delta: text.slice(offset, offset + 512) }
            yield { type: 'finish', finishReason: 'stop' }
          }
        }),
        toolExecutor: async () => '', getConfig: () => config,
        onEvent: () => undefined, onRunUpdate: () => undefined,
        publishLongwriteArtifact: async (input: { content: string; contentHash: string }) => {
          publications += 1
          published = { content: input.content, contentHash: input.contentHash }
          return { displayName: 'r60-manuscript.md', relativePath: 'r60-manuscript.md' }
        }
      })
      const started = await engine.start({ sessionId, runId, config })
      try { await engine.step(runId) } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'narrative_state_pending_review') throw error
      }
      const state = await engine.getState(runId)
      const rows = repo.getManuscriptSegmentsByRun(runId)
      const accepted = rows.filter((row) => row.status === 'accepted')
      const rejected = rows.filter((row) => row.status === 'rejected')
      const activePartial = rows.filter((row) => row.status === 'partial')
      const artifacts = repo.getArtifactsByRun(runId)
      const scene = repo.getSceneStates(runId)[0]
      const contract = (config.sceneContracts as { contracts: Array<{ sceneId: string; requiredFactIds: string[] }> }).contracts[0]!
      const repairRow = repo.getRunEvidence(runId, `scene_beat_repair:${contract.sceneId}`)
      const repair = repairRow ? JSON.parse(repairRow.json) as { attempts: unknown[]; maxAttempts: number } : null
      const facts = repo.getNarrativeFacts(sessionId)
      const missingFact = scenario.id === 'missing-fact'
      check(`${runId} 冻结 requirements 与真实 answer provenance 保留`, ['goal', 'characters', 'scope'].every(slotId => contract.requiredFactIds.includes(slotId)) && grillMe.answers.every(answer => {
        const fact = facts.find(item => item.status === 'active' && item.sourceSlotIds.includes(answer.slotId))
        return missingFact && answer.slotId === 'goal' ? fact === undefined : fact?.canonicalStatement === answer.value && fact.sources.some(source => source.sourceType === 'answer' && source.sourceSlotId === answer.slotId && source.sourceHash === fact.canonicalHash)
      }))
      if (!scenario.positive) {
        check(`${runId} 原未交接稿保留、零 accepted/零 artifact`, rows.some(row => row.content === first && row.kind === 'prose') && accepted.length === 0 && !scene?.acceptedSegmentId && scene?.completionDecision?.status !== 'complete' && artifacts.length === 0 && publications === 0, JSON.stringify({ accepted: accepted.length, scene, artifacts: artifacts.length, publications }))
        check(`${runId} required fact/缺 beat 精确有界暂停`, started.ok && state.run?.status === 'waiting_user' && (missingFact ? state.run.errorCode === 'narrative_state_pending_review' && (state.run as { errorMessage?: string }).errorMessage === 'scene_beat_repair_required_fact_missing' && providerCalls === 1 && repair?.attempts.length === 0 : state.run.errorCode === 'narrative_state_pending_review' && (state.run as { errorMessage?: string }).errorMessage === 'scene_beat_repair_exhausted:2' && providerCalls === 4 && repair?.attempts.length === 2) && repair?.maxAttempts === 2 && acceptedBeforeCalls.every(count => count === 0), JSON.stringify({ run: state.run, calls: providerCalls, repairs: repair?.attempts.length, acceptedBeforeCalls }))
        continue
      }
      const manuscript = artifacts.find((artifact) => artifact.artifact_type === 'manuscript' && artifact.status === 'completed')
      const artifactContent = manuscript ? await store.getArtifactContent(String(manuscript.hash ?? '')) : null
      const acceptedText = accepted
        .sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index) || Number(a.revision) - Number(b.revision))
        .map((row) => String(row.content ?? '')).join('')
      const finalAssistantContext = capturedMessages.at(-1)?.filter((message) => message.role === 'assistant').map((message) => message.content).join('') ?? ''
      const qualityEvidence = repo.getRunEvidence(runId, 'narrative_quality_latest')
      let qualityStage = ''
      try { qualityStage = String((JSON.parse(qualityEvidence?.json ?? '{}') as { stage?: unknown }).stage ?? '') } catch { qualityStage = '' }
      const expectedRepair = ['repaired', 'short-round', 'continuation-round'].includes(scenario.id)
      const expectedRejected = scenario.outputs.length === 2 ? scenario.outputs[0] : null

      check(`${runId} 真实 engine/repository 启动并完成、场景 commit`, started.ok && state.run?.status === 'completed' && scene?.lifecycle === 'committed' && scene.completionDecision?.status === 'complete', JSON.stringify(state.run))
      check(`${runId} 目标达到且仅一次内部流水线完成自然收尾`, providerCalls === scenario.outputs.length && acceptedText === handoff && Array.from(acceptedText).length === targetChars && acceptedText.endsWith('。'), `calls=${providerCalls} chars=${Array.from(acceptedText).length}`)
      check(`${runId} 只有真实交接 accepted prose 进入正文，rejected/partial 不泄漏`, accepted.length === 1 && accepted.every(row => row.kind === 'prose') && activePartial.length === 0 && !acceptedText.includes('魔法') && !acceptedText.includes('outline') && (!expectedRejected || rejected.some(row => scenario.id === 'meta-isolated' ? row.kind === 'plan' : row.content === expectedRejected)), JSON.stringify({ accepted: accepted.length, rejected: rejected.map(row => ({ kind: row.kind, content: String(row.content).slice(0, 20) })), partial: activePartial.length }))
      check(`${runId} 同义 beat、短段定向修订、污染/偏航隔离路径可审计`, acceptedText.includes('脚步声') && acceptedText.includes('把钥匙交到他手里') && qualityStage === 'accepted' && repair?.attempts.length === (expectedRepair ? 1 : 0), JSON.stringify({ qualityStage, repairs: repair?.attempts.length }))
      // No candidate was accepted before the final handoff. In particular the
      // original short drafts must not gain assistant-prefix authority.
      check(`${runId} 最终上下文只带 accepted assistant（此前空前缀），未带污染正文`, acceptedBeforeCalls.every(count => count === 0) && finalAssistantContext === '' && !finalAssistantContext.includes('魔法') && !finalAssistantContext.includes('outline'), JSON.stringify({ acceptedBeforeCalls, assistantContextChars: Array.from(finalAssistantContext).length }))
      check(`${runId} manuscript artifact 字数/hash 与 accepted projection 一致`, artifacts.length === 1 && publications === 1 && manuscript?.char_count === Array.from(acceptedText).length && manuscript?.hash === published?.contentHash && published?.content === acceptedText && artifactContent === acceptedText, JSON.stringify({ artifactChars: manuscript?.char_count, acceptedChars: Array.from(acceptedText).length, artifactHash: manuscript?.hash, publishedHash: published?.contentHash }))
      check(`${runId} CompletionController 以目标正文完成且无多余 provider 轮次`, state.run?.status === 'completed' && providerCalls <= 8 && repo.getRunEvidence(runId, 'longwrite_checkpoint') !== null, `calls=${providerCalls}`)
    }
  } finally {
    repo.close()
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\nR60 longwrite collaboration: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('R60 longwrite collaboration 执行异常：', error)
  process.exitCode = 2
})
