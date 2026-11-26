import { desktopSourceExternals } from './desktop-source-boundary.mjs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import type { SceneContractPlan } from '../src/shared/types'

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
  const outfile = path.join(ROOT, 'out', `wp7-phase1-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

function makeOutline(): GrillMeOutline {
  return {
    title: 'WP7 runtime phase1',
    premise: '守灯人完成一次有代价的交接。',
    targetChars: 120,
    sections: [{
      id: 's1',
      title: '交接',
      purpose: '完成交接并留下下一步压力。',
      targetChars: 120,
      beats: ['守灯人抵达灯塔', '守灯人交出钥匙'],
      sourceSlotIds: ['goal'],
      scenes: [{
        id: 'scene-1',
        title: '灯塔交接',
        purpose: '守灯人抵达灯塔并交出钥匙。',
        targetChars: 120,
        beats: ['守灯人抵达灯塔', '守灯人交出钥匙'],
        sourceSlotIds: ['goal']
      }]
    }]
  }
}

async function main(): Promise<void> {
  const [sceneMod, repoMod, portMod, engineMod, runtimeMod] = await Promise.all([
    loadTsModule('src/main/narrative/sceneContract.ts'),
    loadTsModule('src/main/db/repository.ts'),
    loadTsModule('src/main/runKernelAdapter.ts'),
    loadTsModule('src/main/jobs/AgentRunEngine.ts'),
    loadTsModule('src/main/narrative/wp7Runtime.ts')
  ])
  const buildSceneContractPlan = sceneMod.buildSceneContractPlan as (input: Record<string, unknown>) => SceneContractPlan
  const createRepository = repoMod.createRepository as (dbPath: string) => Record<string, any>
  const createRunStorePort = portMod.createRunStorePort as (repository: unknown, artifactDir: string) => Record<string, any>
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => any
  const persistProjection = engineMod.persistWp7SceneContractProjection as (input: Record<string, unknown>) => Promise<boolean>
  const baseRuntime = runtimeMod.wp7Runtime as Record<string, any>
  const makeRuntime = (onDirector: () => void): Record<string, any> => Object.freeze({
    ...baseRuntime,
    runDirector: (input: unknown, flags: unknown) => {
      onDirector()
      return baseRuntime.runDirector(input, flags)
    }
  })

  const outline = makeOutline()
  const outlineHash = grillMeOutlineHash(outline)
  const plan = buildSceneContractPlan({
    outline,
    outlineHash,
    outlineRevision: 1,
    answers: [{ slotId: 'goal', value: '完成有代价的灯塔交接', source: 'user' }],
    characterNames: ['守灯人'],
    strongConstraints: { forbiddenTerms: [], mustKeep: [] }
  })
  const contract = plan.contracts[0]!
  const baseConfig = {
    sessionId: 'wp7-phase1-session',
    runMode: 'longwrite',
    longMode: true,
    maxTurns: 1,
    maxTokens: 128,
    targetChars: 0,
    model: 'wp7-phase1',
    sceneContracts: plan,
    strongConstraints: { enabled: false },
    wp7FeatureFlags: { sceneContractV2: true, deterministicDirector: true, dramaticCritic: false, localizedRevision: false, reorientation: false }
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-wp7-phase1-'))
  const production = async (runId: string, enabled: boolean, withoutCas = false): Promise<Record<string, unknown>> => {
    const repo = createRepository(path.join(tmpDir, `${runId}.db`))
    repo.open()
    const rawStore = createRunStorePort(repo, path.join(tmpDir, `${runId}-artifacts`))
    let projectionSaveCalls = 0
    const store = withoutCas
      ? {
        ...rawStore,
        saveRunEvidenceIfAbsent: undefined,
        saveRunEvidence: async (evidenceRunId: string, kind: string, json: string) => {
          if (kind.startsWith('wp7_scene_contract_v2_projection:')) projectionSaveCalls += 1
          return rawStore.saveRunEvidence(evidenceRunId, kind, json)
        }
      }
      : rawStore
    let directorCalls = 0
    let providerCalls = 0
    const requests: string[] = []
    const flags = enabled ? baseConfig.wp7FeatureFlags : { sceneContractV2: false, deterministicDirector: false }
    const config = { ...baseConfig, sessionId: `${runId}-workflow`, wp7FeatureFlags: flags }
    const runtime = makeRuntime(() => { directorCalls += 1 })
    const engine = createAgentRunEngine({
      store,
      wp7Runtime: runtime,
      getConfig: () => config,
      modelCall: async (input: { messages: unknown[] }) => {
        providerCalls += 1
        requests.push(JSON.stringify(input.messages))
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'finish'; finishReason: 'error'; errorCode: string; errorMessage: string }> {
            yield { type: 'finish', finishReason: 'error', errorCode: 'phase1_test', errorMessage: 'phase1 stop before candidate' }
          }
        }
      },
      toolExecutor: async () => '',
      onEvent: () => undefined,
      onRunUpdate: () => undefined
    })
    const started = await engine.start({ sessionId: config.sessionId, runId, config })
    await engine.step(runId).catch(() => undefined)
    const kind = `wp7_scene_contract_v2_projection:${contract.contractId}:${contract.revision}`
    const evidence = repo.getRunEvidence(runId, kind)
    const rows = repo.getManuscriptSegmentsByRun(runId) as Array<Record<string, unknown>>
    const commits = repo.getNarrativeCommits(runId) as Array<Record<string, unknown>>
    repo.close()
    return { started, directorCalls, providerCalls, requests, evidence, candidates: rows.filter((row) => row.status === 'candidate'), commits, projectionSaveCalls }
  }

  const off = await production('wp7-phase1-off', false)
  const on = await production('wp7-phase1-on', true)
  check('production import boundary uses injected runtime', off.directorCalls === 0 && on.directorCalls === 1)
  check('default-off emits no V2 evidence', off.evidence === null)
  check('enabled emits one immutable V2 evidence projection', on.evidence !== null && on.commits.length === 0)
  check('director projection does not add provider/candidate work', off.providerCalls === on.providerCalls && JSON.stringify(off.requests) === JSON.stringify(on.requests) && off.candidates.length === on.candidates.length)

  const noCasProduction = await production('wp7-phase1-no-cas', true, true)
  check('missing CAS keeps production provider path alive without projection write', noCasProduction.directorCalls === 0 && noCasProduction.providerCalls === on.providerCalls && noCasProduction.evidence === null && noCasProduction.projectionSaveCalls === 0)

  const evidenceRows = new Map<string, { json: string }>()
  let casCalls = 0
  const projectionStore = {
    saveRunEvidence: async (_runId: string, kind: string, json: string) => { evidenceRows.set(kind, { json }) },
    saveRunEvidenceIfAbsent: async (_runId: string, kind: string, json: string) => {
      casCalls += 1
      if (evidenceRows.has(kind)) return false
      evidenceRows.set(kind, { json })
      return true
    },
    getRunEvidence: async (_runId: string, kind: string) => evidenceRows.get(kind) ?? null,
    getStoryLedgerFreshness: async () => ({ validityEpoch: 7 })
  }
  const replayRuntime = makeRuntime(() => undefined)
  const projectionInput = { runId: 'wp7-phase1-replay', config: { ...baseConfig, sessionId: 'workflow-replay' }, contract, state: { revision: 1 }, runtime: replayRuntime, store: projectionStore }
  const first = await persistProjection(projectionInput)
  const saved = [...evidenceRows.values()][0]!.json
  const second = await persistProjection(projectionInput)
  check('restart replay is CAS-idempotent', first === true && second === false && casCalls === 2 && evidenceRows.size === 1)
  const kind = [...evidenceRows.keys()][0]!
  evidenceRows.set(kind, { json: saved.replace('"epoch":7', '"epoch":8') })
  let conflict = false
  try { await persistProjection(projectionInput) } catch { conflict = true }
  check('hash/epoch conflict fails closed without overwrite', conflict && evidenceRows.get(kind)?.json.includes('"epoch":8') === true)

  const concurrentRows = new Map<string, { json: string }>()
  const concurrentStore = {
    saveRunEvidenceIfAbsent: async (_runId: string, concurrentKind: string, json: string) => {
      if (concurrentRows.has(concurrentKind)) return false
      concurrentRows.set(concurrentKind, { json })
      return true
    },
    getRunEvidence: async (_runId: string, concurrentKind: string) => concurrentRows.get(concurrentKind) ?? null,
    getStoryLedgerFreshness: async () => ({ validityEpoch: 7 })
  }
  const concurrentInput = { ...projectionInput, store: concurrentStore }
  const concurrentResults = await Promise.all([persistProjection(concurrentInput), persistProjection(concurrentInput)])
  check('concurrent CAS keeps one first payload', concurrentResults.filter(Boolean).length === 1 && concurrentRows.size === 1)

  let missingCasSaveCalls = 0
  let missingCasReadCalls = 0
  const missingCasStore = {
    saveRunEvidence: async () => { missingCasSaveCalls += 1 },
    getRunEvidence: async () => { missingCasReadCalls += 1; return null },
    getStoryLedgerFreshness: async () => ({ validityEpoch: 7 })
  }
  let missingCasCode = ''
  try {
    await persistProjection({ ...projectionInput, store: missingCasStore })
  } catch (error) {
    missingCasCode = error instanceof Error ? error.message : String(error)
  }
  check('missing CAS fails before director/read/write capability use', missingCasCode === 'wp7_scene_contract_v2_projection_cas_unavailable' && missingCasSaveCalls === 0 && missingCasReadCalls === 0)

  console.log(`WP7 Phase1: ${passed} PASS, ${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
