import { desktopSourceExternals } from './desktop-source-boundary.mjs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
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
  const outfile = path.join(ROOT, 'out', `wp7-phase2-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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
    title: 'WP7 critic phase2',
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
  const persistCritic = engineMod.persistWp7DramaticCriticEvidence as (input: Record<string, unknown>) => Promise<boolean>
  const baseRuntime = runtimeMod.wp7Runtime as Record<string, any>
  const makeRuntime = (counters: { director: number; critic: number }): Record<string, any> => Object.freeze({
    ...baseRuntime,
    runDirector: (input: unknown, flags: unknown) => {
      counters.director += 1
      return baseRuntime.runDirector(input, flags)
    },
    runCritic: (input: unknown, flags: unknown) => {
      counters.critic += 1
      return baseRuntime.runCritic(input, flags)
    }
  })

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
  const flags = { sceneContractV2: true, deterministicDirector: true, dramaticCritic: true, localizedRevision: false, reorientation: false }
  const baseConfig = {
    runMode: 'longwrite',
    longMode: true,
    maxTurns: 1,
    maxTokens: 128,
    targetChars: 0,
    model: 'wp7-phase2',
    sceneContracts: plan,
    strongConstraints: { enabled: false },
    wp7FeatureFlags: flags
  }
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-wp7-phase2-'))

  const production = async (runId: string, enabled: boolean): Promise<Record<string, unknown>> => {
    const repo = createRepository(path.join(tmpDir, `${runId}.db`))
    repo.open()
    const rawStore = createRunStorePort(repo, path.join(tmpDir, `${runId}-artifacts`))
    const criticKinds: string[] = []
    const store = {
      ...rawStore,
      saveRunEvidenceIfAbsent: async (evidenceRunId: string, kind: string, json: string) => {
        if (kind.startsWith('wp7_dramatic_critic:')) criticKinds.push(kind)
        return rawStore.saveRunEvidenceIfAbsent(evidenceRunId, kind, json)
      }
    }
    const counters = { director: 0, critic: 0 }
    let providerCalls = 0
    const requests: string[] = []
    const config = { ...baseConfig, sessionId: `${runId}-workflow`, wp7FeatureFlags: enabled ? flags : { sceneContractV2: false, deterministicDirector: false, dramaticCritic: false } }
    const engine = createAgentRunEngine({
      store,
      wp7Runtime: makeRuntime(counters),
      getConfig: () => config,
      modelCall: async (input: { messages: unknown[] }) => {
        providerCalls += 1
        requests.push(JSON.stringify(input.messages))
        return {
        async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
          // Deliberately omit the authored beat.  The stable v1 path keeps
          // this complete candidate for its ordinary defer/continuation flow,
          // which makes the critic's non-mutating boundary observable.
          yield { type: 'text', delta: '守灯人站在灯塔门前。' }
          yield { type: 'finish', finishReason: 'stop' }
        }
        }
      },
      toolExecutor: async () => '',
      onEvent: () => undefined,
      onRunUpdate: () => undefined
    })
    const started = await engine.start({ sessionId: config.sessionId, runId, config })
    // The engine's model callback is deliberately one-shot; the run reaches
    // its configured max-turn boundary after the deferred candidate.
    await engine.step(runId).catch(() => undefined)
    const criticEvidence = criticKinds.length > 0 ? repo.getRunEvidence(runId, criticKinds[0]!) : null
    const rows = repo.getManuscriptSegmentsByRun(runId) as Array<Record<string, unknown>>
    const stableRows = rows.map((row) => ({ content: row.content, content_hash: row.content_hash, char_count: row.char_count, kind: row.kind, status: row.status, scene_id: row.scene_id, revision: row.revision }))
    const commits = repo.getNarrativeCommits(runId) as Array<Record<string, unknown>>
    const states = repo.getSceneStates(runId)
    repo.close()
    return { started, counters, providerCalls, requests, criticKinds, criticEvidence, rows: stableRows, commits, states }
  }

  const off = await production('wp7-phase2-off', false)
  const on = await production('wp7-phase2-on', true)
  const stableStates = (value: unknown): unknown[] => Array.isArray(value)
    ? value.map((state) => {
      const item = state as Record<string, unknown>
      return {
        sceneId: item.sceneId,
        lifecycle: item.lifecycle,
        revision: item.revision,
        candidateHash: item.candidateHash,
        acceptedHash: item.acceptedHash,
        completionEvidenceHash: item.completionEvidenceHash
      }
    })
    : []
  check('off/on production runtime boundary', off.counters.director === 0 && off.counters.critic === 0 && on.counters.director === 1 && on.counters.critic === 1, JSON.stringify({ off: off.counters, on: on.counters, offProvider: off.providerCalls, onProvider: on.providerCalls, onRows: on.rows, onStarted: on.started }))
  check('off emits zero critic evidence', off.criticKinds.length === 0 && off.criticEvidence === null)
  check('on emits exactly one critic evidence', on.criticKinds.length === 1 && on.criticEvidence !== null, JSON.stringify({ kinds: on.criticKinds, evidence: on.criticEvidence }))
  check('critic does not alter writer candidate or commit path', off.providerCalls === on.providerCalls && JSON.stringify(off.requests) === JSON.stringify(on.requests) && JSON.stringify(off.rows) === JSON.stringify(on.rows) && JSON.stringify(off.commits) === JSON.stringify(on.commits) && JSON.stringify(stableStates(off.states)) === JSON.stringify(stableStates(on.states)) && on.states.some((state: Record<string, unknown>) => state.lifecycle === 'pending_review' || state.lifecycle === 'candidate' || state.lifecycle === 'writing'))

  const projection = baseRuntime.runDirector({
    contractId: 'phase2-contract:v2',
    sceneId: 'phase2-scene',
    sceneFunction: 'decision',
    entrySituation: '林舟站在门前。',
    dramaticQuestion: '林舟是否开门？',
    desires: { pov: '保护同伴', opposition: '拖延' },
    escalation: { pressure: '暴雨逼近' },
    choice: { actor: '林舟', action: '开门', irreversible: true },
    cost: { payer: '林舟', immediate: '暴露位置' },
    turn: { from: '犹豫', to: '行动' },
    valueShift: { from: '恐惧', to: '决心' },
    revelationAndInterpretation: '门后没有退路。',
    hardConstraints: [],
    softIntent: [],
    sourceHash: contract.frozenHash
  }, flags)
  const candidateContent = '林舟走进门。'
  const candidate = { schemaVersion: 1, segmentId: 'phase2-candidate', runId: 'phase2-run', sessionId: 'phase2-workflow', chunkIndex: 1, revision: 1, status: 'candidate', kind: 'prose', content: candidateContent, contentHash: hashText(candidateContent), charCount: Array.from(candidateContent).length, createdAt: 1, updatedAt: 1 }
  const evidenceRows = new Map<string, { json: string }>()
  let casCalls = 0
  const criticStore = {
    saveRunEvidenceIfAbsent: async (_runId: string, kind: string, json: string) => {
      casCalls += 1
      if (evidenceRows.has(kind)) return false
      evidenceRows.set(kind, { json })
      return true
    },
    getRunEvidence: async (_runId: string, kind: string) => evidenceRows.get(kind) ?? null,
    getStoryLedgerFreshness: async () => ({ validityEpoch: 7 })
  }
  const criticCounters = { director: 0, critic: 0 }
  const criticRuntime = makeRuntime(criticCounters)
  const projectionInput = { runId: 'phase2-run', config: { ...baseConfig, sessionId: 'phase2-workflow' }, workflowId: 'phase2-workflow', sceneId: 'phase2-scene', sceneRevision: 1, contractHash: contract.frozenHash, candidate, contract: projection, runtime: criticRuntime, store: criticStore }
  const first = await persistCritic(projectionInput)
  const saved = [...evidenceRows.values()][0]!.json
  const second = await persistCritic(projectionInput)
  check('critic restart replay is CAS-idempotent', first === true && second === false && evidenceRows.size === 1 && casCalls === 2)
  const criticKind = [...evidenceRows.keys()][0]!
  evidenceRows.set(criticKind, { json: saved.replace('"epoch":7', '"epoch":8') })
  let conflict = false
  try { await persistCritic(projectionInput) } catch { conflict = true }
  check('critic stale epoch/conflict never overwrites', conflict && evidenceRows.get(criticKind)?.json.includes('"epoch":8') === true)

  const invalidRuntime = Object.freeze({
    ...criticRuntime,
    runCritic: (input: unknown, runtimeFlags: unknown) => {
      const valid = baseRuntime.runCritic(input, runtimeFlags)
      if (valid.issues.length > 0) return { ...valid, issues: [{ ...valid.issues[0], span: { ...valid.issues[0].span, text: 'tampered' } }] }
      return {
        ...valid,
        issues: [{ issueId: 'invalid-span', code: 'choice_missing', impact: 'major', span: { startUtf16: 0, endUtf16: 2, text: 'tampered', textHash: hashText('tampered') }, mustPreserveSpans: [], revisionTargets: [] }]
      }
    }
  })
  const invalidRows = new Map<string, { json: string }>()
  let invalidCasCalls = 0
  let invalidSaveCalls = 0
  const invalidStore = {
    saveRunEvidenceIfAbsent: async (_runId: string, kind: string, json: string) => { invalidCasCalls += 1; invalidRows.set(kind, { json }); return true },
    getRunEvidence: async (_runId: string, kind: string) => invalidRows.get(kind) ?? null,
    getStoryLedgerFreshness: async () => ({ validityEpoch: 7 })
  }
  try { await persistCritic({ ...projectionInput, runtime: invalidRuntime, store: invalidStore }) } catch { invalidSaveCalls += invalidCasCalls }
  check('invalid exact spans never persist evidence', invalidCasCalls === 0 && invalidSaveCalls === 0 && invalidRows.size === 0)

  const expectIdentityRejection = async (name: string, override: Record<string, unknown>): Promise<void> => {
    const identityRows = new Map<string, { json: string }>()
    let identityCasCalls = 0
    const identityStore = {
      saveRunEvidenceIfAbsent: async (_runId: string, kind: string, json: string) => { identityCasCalls += 1; identityRows.set(kind, { json }); return true },
      getRunEvidence: async (_runId: string, kind: string) => identityRows.get(kind) ?? null,
      getStoryLedgerFreshness: async () => ({ validityEpoch: 7 })
    }
    let rejected = false
    try { await persistCritic({ ...projectionInput, ...override, store: identityStore }) } catch { rejected = true }
    check(name, rejected && identityCasCalls === 0 && identityRows.size === 0)
  }
  await expectIdentityRejection('forged v1 input contractHash fails before CAS', { contractHash: hashText('forged-v1-binding') })
  await expectIdentityRejection('forged V2 sourceHash fails before CAS', { contract: { ...projection, sourceHash: hashText('forged-source-binding') } })
  await expectIdentityRejection('forged V2 frozenHash fails before CAS', { contract: { ...projection, frozenHash: hashText('forged-v2-hash') } })

  let missingCasReads = 0
  let missingCasCritics = 0
  const missingCasRuntime = Object.freeze({ ...criticRuntime, runCritic: (input: unknown, runtimeFlags: unknown) => { missingCasCritics += 1; return baseRuntime.runCritic(input, runtimeFlags) } })
  const missingCasStore = { getRunEvidence: async () => { missingCasReads += 1; return null }, getStoryLedgerFreshness: async () => ({ validityEpoch: 7 }) }
  let missingCasCode = ''
  try { await persistCritic({ ...projectionInput, runtime: missingCasRuntime, store: missingCasStore }) } catch (error) { missingCasCode = error instanceof Error ? error.message : String(error) }
  check('missing CAS fails closed before critic/read/write', missingCasCode === 'wp7_dramatic_critic_cas_unavailable' && missingCasReads === 0 && missingCasCritics === 0)

  console.log(`WP7 Phase2: ${passed} PASS, ${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
