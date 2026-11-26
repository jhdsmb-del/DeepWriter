import { desktopSourceExternals } from './desktop-source-boundary.mjs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import type { SceneContractPlan, StoryConfig } from '../src/shared/types'

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
  const outfile = path.join(ROOT, 'out', `wp7-phase3-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

function makeOutline(): GrillMeOutline {
  return {
    title: 'WP7 localized revision phase3',
    premise: '守灯人必须在灯塔门前作出选择。',
    targetChars: 120,
    sections: [{
      id: 's1',
      title: '门前',
      purpose: '留下可继续的场景压力。',
      targetChars: 120,
      beats: ['守灯人抵达灯塔'],
      sourceSlotIds: ['goal'],
      scenes: [{
        id: 'scene-1',
        title: '抵达灯塔',
        purpose: '守灯人抵达灯塔。',
        targetChars: 120,
        beats: ['守灯人抵达灯塔'],
        sourceSlotIds: ['goal']
      }]
    }]
  }
}

type RevisionMode = 'normal' | 'must-preserve' | 'out-of-bounds'

async function main(): Promise<void> {
  const [sceneMod, repoMod, portMod, engineMod, runtimeMod, constraintsMod, writingMod] = await Promise.all([
    loadTsModule('src/main/narrative/sceneContract.ts'),
    loadTsModule('src/main/db/repository.ts'),
    loadTsModule('src/main/runKernelAdapter.ts'),
    loadTsModule('src/main/jobs/AgentRunEngine.ts'),
    loadTsModule('src/main/narrative/wp7Runtime.ts'),
    loadTsModule('src/main/strongConstraints.ts'),
    loadTsModule('src/main/writingPipeline.ts')
  ])
  const buildSceneContractPlan = sceneMod.buildSceneContractPlan as (input: Record<string, unknown>) => SceneContractPlan
  const createRepository = repoMod.createRepository as (dbPath: string) => Record<string, any>
  const createRunStorePort = portMod.createRunStorePort as (repository: unknown, artifactDir: string) => Record<string, any>
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => any
  const buildStrongConstraintSnapshot = constraintsMod.buildStrongConstraintSnapshot as (input: Record<string, unknown>) => Record<string, any>
  const buildWritingPipelinePolicy = writingMod.buildWritingPipelinePolicy as (snapshot: Record<string, unknown>) => Record<string, any>
  const baseRuntime = runtimeMod.wp7Runtime as Record<string, any>

  const outline = makeOutline()
  const outlineHash = grillMeOutlineHash(outline)
  const plan = buildSceneContractPlan({
    outline,
    outlineHash,
    outlineRevision: 1,
    answers: [{ slotId: 'goal', value: '抵达灯塔', source: 'user' }],
    characterNames: ['守灯人'],
    strongConstraints: { forbiddenTerms: [], mustKeep: [] }
  })
  const contract = plan.contracts[0]!
  const story: StoryConfig = {
    enabled: true,
    genre: '悬疑故事',
    tone: '冷静',
    structure: 'kishotenketsu',
    intensity: 'standard',
    outputFormat: 'prose',
    worldSetting: '海边灯塔',
    targetLength: 120,
    characters: []
  }
  const snapshot = buildStrongConstraintSnapshot({
    runMode: 'longwrite',
    task: '写守灯人抵达灯塔的悬疑场景。',
    story,
    settings: {
      strongConstraintEnabled: true,
      strongConstraintLevel: 'balanced',
      strongConstraintGenre: '悬疑故事',
      strongConstraintPerspective: 'auto',
      strongConstraintMustKeep: '',
      strongConstraintAvoid: ''
    }
  })
  const writingPipeline = buildWritingPipelinePolicy(snapshot)
  const enabledFlags = { sceneContractV2: true, deterministicDirector: true, dramaticCritic: true, localizedRevision: true, reorientation: false }
  const disabledFlags = { sceneContractV2: false, deterministicDirector: false, dramaticCritic: false, localizedRevision: false, reorientation: false }
  const baseConfig = {
    runMode: 'longwrite',
    longMode: true,
    maxTurns: 1,
    maxTokens: 512,
    targetChars: 0,
    model: 'wp7-phase3',
    sceneContracts: plan,
    manuscriptSegmentsVersion: 1,
    strongConstraints: snapshot,
    writingPipeline,
    wp7FeatureFlags: enabledFlags
  }
  const candidateText = '守灯人抵达灯塔，他把旧钥匙攥在掌心，听见潮声从石阶下涌来，命运的齿轮转动。'
  const targetText = '命运的齿轮转动'
  const replacementText = '潮声压过风声'
  const targetStart = Array.from(candidateText).join('').indexOf(targetText)
  const targetStartCp = Array.from(candidateText.slice(0, targetStart)).length
  const targetEndCp = targetStartCp + Array.from(targetText).length

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-wp7-phase3-'))

  const production = async (runId: string, flags: Record<string, boolean>, mode: RevisionMode = 'normal', withoutCas = false): Promise<Record<string, any>> => {
    const repo = createRepository(path.join(tmpDir, `${runId}.db`))
    repo.open()
    const rawStore = createRunStorePort(repo, path.join(tmpDir, `${runId}-artifacts`))
    const evidenceKinds: string[] = []
    let localizedCasCalls = 0
    let localizedOrdinarySaveCalls = 0
    const store = withoutCas
      ? {
        ...rawStore,
        saveRunEvidenceIfAbsent: undefined,
        saveRunEvidence: async (evidenceRunId: string, kind: string, json: string) => {
          if (kind.startsWith('wp7_localized_revision:')) localizedOrdinarySaveCalls += 1
          return rawStore.saveRunEvidence(evidenceRunId, kind, json)
        }
      }
      : {
        ...rawStore,
        saveRunEvidenceIfAbsent: async (evidenceRunId: string, kind: string, json: string) => {
          if (kind.startsWith('wp7_')) evidenceKinds.push(kind)
          if (kind.startsWith('wp7_localized_revision:')) localizedCasCalls += 1
          return rawStore.saveRunEvidenceIfAbsent(evidenceRunId, kind, json)
        }
      }
    const counters = { director: 0, critic: 0, localRevision: 0 }
    const runtime = Object.freeze({
      ...baseRuntime,
      runDirector: (input: unknown, runtimeFlags: unknown) => {
        counters.director += 1
        return baseRuntime.runDirector(input, runtimeFlags)
      },
      runCritic: (input: any, runtimeFlags: unknown) => {
        counters.critic += 1
        const report = baseRuntime.runCritic(input, runtimeFlags)
        if (mode === 'normal') return report
        const span = baseRuntime.makeExactTextSpanFromCodePoints(input.candidate, targetStartCp, targetEndCp)
        if (!span) return report
        if (mode === 'must-preserve') {
          return {
            ...report,
            mustPreserveSpans: [span],
            issues: report.issues.map((issue: Record<string, unknown>) => ({ ...issue, mustPreserveSpans: [span] }))
          }
        }
        const narrow = baseRuntime.makeExactTextSpanFromCodePoints(input.candidate, 0, 1)
        if (!narrow) return report
        const narrowTargets = report.revisionTargets.map((target: Record<string, unknown>) => ({ ...target, allowedSpan: narrow }))
        return {
          ...report,
          revisionTargets: narrowTargets,
          issues: report.issues.map((issue: Record<string, unknown>) => ({ ...issue, revisionTargets: narrowTargets }))
        }
      },
      runLocalRevision: (input: unknown, runtimeFlags: unknown) => {
        counters.localRevision += 1
        return baseRuntime.runLocalRevision(input, runtimeFlags)
      }
    })
    let providerCalls = 0
    let criticCalls = 0
    const purposes: string[] = []
    const requests: string[] = []
    const config = { ...baseConfig, sessionId: `${runId}-workflow`, wp7FeatureFlags: flags }
    const modelCall = async (input: { purpose?: string; messages: Array<{ content: unknown }> }) => {
      providerCalls += 1
      purposes.push(input.purpose ?? 'writer')
      requests.push(JSON.stringify(input.messages))
      const last = input.messages.at(-1)?.content
      let request: Record<string, unknown> = {}
      try { request = typeof last === 'string' ? JSON.parse(last) as Record<string, unknown> : {} } catch { request = {} }
      const candidate = typeof request.candidate === 'string' ? request.candidate : candidateText
      const candidateHash = typeof request.candidateHash === 'string' ? request.candidateHash : hashText(candidate)
      if (input.purpose === 'writer' || input.purpose === undefined) {
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
            yield { type: 'text', delta: candidateText }
            yield { type: 'finish', finishReason: 'stop' }
          }
        }
      }
      if (input.purpose === 'editor') {
        const issue = (request.issue ?? {}) as Record<string, unknown>
        const patch = JSON.stringify({ schemaVersion: 1, candidateHash, patches: [{ issueId: issue.issueId, startCp: issue.startCp, endCp: issue.endCp, quote: issue.quote, replacement: replacementText }] })
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
            yield { type: 'text', delta: patch }
            yield { type: 'finish', finishReason: 'stop' }
          }
        }
      }
      if (input.purpose === 'critic') {
        criticCalls += 1
        const report = criticCalls === 1
          ? { schemaVersion: 1, candidateHash, issues: [{ issueId: 'phase3-local', code: 'cliche_language', severity: 'advisory', basis: 'quality', startCp: targetStartCp, endCp: targetEndCp, quote: targetText, reason: '测试局部修订边界', repairIntent: '只替换命中短语' }] }
          : { schemaVersion: 1, candidateHash, issues: [] }
        const critic = JSON.stringify(report)
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
            yield { type: 'text', delta: critic }
            yield { type: 'finish', finishReason: 'stop' }
          }
        }
      }
      const verificationHash = hashText(candidate)
      const critic = JSON.stringify({ schemaVersion: 1, candidateHash: verificationHash, issues: [] })
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
          yield { type: 'text', delta: critic }
          yield { type: 'finish', finishReason: 'stop' }
        }
      }
    }
    const engine = createAgentRunEngine({
      store,
      wp7Runtime: runtime,
      getConfig: () => config,
      modelCall,
      toolExecutor: async () => '',
      onEvent: () => undefined,
      onRunUpdate: () => undefined
    })
    const started = await engine.start({ sessionId: config.sessionId, runId, config })
    await engine.step(runId).catch(() => undefined)
    const rows = repo.getManuscriptSegmentsByRun(runId) as Array<Record<string, unknown>>
    const evidence = repo.getRunEvidence(runId, evidenceKinds.find((kind) => kind.startsWith('wp7_localized_revision:')) ?? '')
    const criticEvidence = repo.getRunEvidence(runId, evidenceKinds.find((kind) => kind.startsWith('wp7_dramatic_critic:')) ?? '')
    const replayInserted = evidence ? await rawStore.saveRunEvidenceIfAbsent(runId, evidence.kind, evidence.json) : null
    const concurrentKind = `wp7_phase3_concurrent:${runId}`
    const concurrentResults = await Promise.all([
      rawStore.saveRunEvidenceIfAbsent(runId, concurrentKind, JSON.stringify({ winner: 'first' })),
      rawStore.saveRunEvidenceIfAbsent(runId, concurrentKind, JSON.stringify({ winner: 'second' }))
    ])
    const concurrentEvidence = await rawStore.getRunEvidence(runId, concurrentKind)
    const pipelineEvidence = repo.getRunEvidence(runId, 'writing_pipeline_latest')
    const qualityEvidence = rows.flatMap((row) => [
      repo.getRunEvidence(runId, `narrative_quality_segment:${String(row.segment_id)}:candidate`),
      repo.getRunEvidence(runId, `narrative_quality_segment:${String(row.segment_id)}:accepted`),
      repo.getRunEvidence(runId, `narrative_quality_segment:${String(row.segment_id)}:rejected`)
    ]).filter(Boolean)
    const sceneEvidence = rows.flatMap((row) => [
      repo.getRunEvidence(runId, `scene_contract_segment:${String(row.segment_id)}`),
      repo.getRunEvidence(runId, `scene_contract_segment:${String(row.segment_id)}:candidate`),
      repo.getRunEvidence(runId, `scene_contract_segment:${String(row.segment_id)}:accepted`),
      repo.getRunEvidence(runId, `scene_contract_segment:${String(row.segment_id)}:rejected`)
    ]).filter(Boolean)
    const sceneLatest = repo.getRunEvidence(runId, 'scene_contract_latest')
    const commits = repo.getNarrativeCommits(runId) as Array<Record<string, unknown>>
    const states = repo.getSceneStates(runId)
    const finishedRun = repo.getRun(runId)
    const stableRows = rows.map((row) => ({ segmentId: row.segment_id, content: row.content, contentHash: row.content_hash, status: row.status, revision: row.revision, supersedesSegmentId: row.supersedes_segment_id }))
    repo.close()
    return { started, counters, providerCalls, purposes, requests, evidenceKinds, evidence, criticEvidence, replayInserted, localizedCasCalls, localizedOrdinarySaveCalls, concurrentResults, concurrentEvidence, pipelineEvidence, qualityEvidence, sceneEvidence, sceneLatest, rows: stableRows, commits, states, finishedRun }
  }

  const off = await production('wp7-phase3-off', disabledFlags)
  const on = await production('wp7-phase3-on', enabledFlags)
  const fallbackPreserve = await production('wp7-phase3-preserve', enabledFlags, 'must-preserve')
  const fallbackBounds = await production('wp7-phase3-bounds', enabledFlags, 'out-of-bounds')
  const missingCas = await production('wp7-phase3-missing-cas', enabledFlags, 'normal', true)

  check('off/on keep provider requests and commit path equivalent', off.providerCalls === on.providerCalls && JSON.stringify(off.purposes) === JSON.stringify(on.purposes) && JSON.stringify(off.requests) === JSON.stringify(on.requests) && off.commits.length === on.commits.length)
  check('off does not call WP7 critic/local revision or persist WP7 evidence', off.counters.critic === 0 && off.counters.localRevision === 0 && off.evidenceKinds.length === 0)
  check('on calls critic once and local revision once', on.counters.critic === 1 && on.counters.localRevision === 1, JSON.stringify({ counters: on.counters, providerCalls: on.providerCalls, purposes: on.purposes, evidenceKinds: on.evidenceKinds, pipelineEvidence: on.pipelineEvidence, rows: on.rows }))
  check('allowed local revision keeps original and creates superseding candidate', on.rows.length >= 2 && on.rows.some((row: Record<string, unknown>) => row.content === candidateText && row.revision === 1) && on.rows.some((row: Record<string, unknown>) => row.content !== candidateText && row.revision === 2 && row.supersedesSegmentId), JSON.stringify(on.rows))
  check('applied revision evidence is bound and stable gates rerun', typeof on.evidence?.json === 'string' && JSON.parse(on.evidence.json).status === 'applied' && on.qualityEvidence.length > 0 && on.sceneEvidence.length > 0, JSON.stringify({ pipeline: on.pipelineEvidence, quality: on.qualityEvidence, scene: on.sceneEvidence, sceneLatest: on.sceneLatest, states: on.states, finishedRun: on.finishedRun }))
  check('localized revision evidence replay is CAS-idempotent', on.replayInserted === false && on.rows.filter((row: Record<string, unknown>) => row.revision === 2).length === 1)
  check('localized revision evidence requires CAS and missing CAS fails closed', missingCas.localizedCasCalls === 0 && missingCas.localizedOrdinarySaveCalls === 0 && missingCas.evidence === null && missingCas.rows.length === 1 && missingCas.rows[0]?.content === candidateText && missingCas.providerCalls === off.providerCalls && missingCas.qualityEvidence.length > 0 && missingCas.sceneEvidence.length > 0, JSON.stringify({ counters: missingCas.counters, providerCalls: missingCas.providerCalls, ordinary: missingCas.localizedOrdinarySaveCalls, evidenceKinds: missingCas.evidenceKinds, rows: missingCas.rows, quality: missingCas.qualityEvidence, scene: missingCas.sceneEvidence, finishedRun: missingCas.finishedRun }))
  check('concurrent localized evidence CAS keeps first payload', on.concurrentResults[0] === true && on.concurrentResults[1] === false && on.concurrentEvidence?.json === JSON.stringify({ winner: 'first' }), JSON.stringify({ results: on.concurrentResults, evidence: on.concurrentEvidence }))
  check('must-preserve violation falls back without a new candidate', fallbackPreserve.counters.critic === 1 && fallbackPreserve.counters.localRevision === 1 && fallbackPreserve.rows.length === 1 && JSON.parse(fallbackPreserve.evidence?.json ?? '{}').status === 'fallback' && fallbackPreserve.rows[0]?.content === candidateText)
  check('out-of-bounds revision falls back without a new candidate', fallbackBounds.counters.critic === 1 && fallbackBounds.counters.localRevision === 1 && fallbackBounds.rows.length === 1 && JSON.parse(fallbackBounds.evidence?.json ?? '{}').status === 'fallback' && fallbackBounds.rows[0]?.content === candidateText)
  check('fallback keeps provider and commit path stable', fallbackPreserve.providerCalls === off.providerCalls && fallbackBounds.providerCalls === off.providerCalls && fallbackPreserve.commits.length === off.commits.length && fallbackBounds.commits.length === off.commits.length)
  check('applied candidate carries deterministic hash and revision identity', on.rows.some((row: Record<string, unknown>) => row.contentHash === hashText(String(row.content)) && row.revision === 2 && row.supersedesSegmentId === on.rows.find((candidate: Record<string, unknown>) => candidate.revision === 1)?.segmentId))

  console.log(`WP7 Phase3: ${passed} PASS, ${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
