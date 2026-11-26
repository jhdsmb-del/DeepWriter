import { desktopSourceExternals } from './desktop-source-boundary.mjs'
import { DatabaseSync } from 'node:sqlite'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { createRepository, type ManuscriptSegmentRow, type Repository, type RunRow } from '../src/main/db/repository'
import { runMigrations } from '../src/main/db/migrations'
import { createAgentRunEngine } from '../src/main/jobs/AgentRunEngine'
import type { RunConfig, RunRecord, RunStorePort, TurnRecord } from '../src/main/jobs/types'
import { buildExecutionSnapshot } from '../src/main/executionSnapshot'
import { applyTargetedEdit, writingTextHash } from '../src/main/writingPipeline'
import type { ManuscriptSegment, ManuscriptAcceptanceInput, Settings } from '../src/shared/types'
import { codePointLength } from '../src/shared/textMetrics'
import { makeManuscriptSegment, manuscriptAcceptanceEvidenceIdentity, manuscriptSegmentHash } from '../src/main/manuscript'

let passed = 0
let failed = 0

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)
const esbuild = nodeRequire('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

async function loadTsModule(relativePath: string): Promise<Record<string, unknown>> {
  const outfile = path.join(ROOT, 'out', `p1-b-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, relativePath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
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
  const output = (result as { outputFiles?: Array<{ contents: Uint8Array }> }).outputFiles?.[0]
  if (!output) throw new Error('p1-b_loader_no_output')
  await fsp.writeFile(outfile, output.contents)
  // Keep the short-lived bundle available for the duration of module
  // evaluation. Node may defer resolving a dynamic import's file URL on a
  // different loader turn; deleting it in `finally` can race that resolution
  // on Node 24. The generated file is under the ignored out/ directory.
  return await import(url.pathToFileURL(outfile).href) as Record<string, unknown>
}

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function toRow(segment: ManuscriptSegment): ManuscriptSegmentRow {
  return {
    segment_id: segment.segmentId,
    run_id: segment.runId,
    session_id: segment.sessionId,
    source_turn_id: segment.sourceTurnId ?? null,
    section_id: segment.sectionId ?? null,
    scene_id: segment.sceneId ?? null,
    chunk_index: segment.chunkIndex,
    revision: segment.revision,
    status: segment.status,
    kind: segment.kind,
    content: segment.content,
    content_hash: segment.contentHash,
    char_count: segment.charCount,
    supersedes_segment_id: segment.supersedesSegmentId ?? null,
    created_at: segment.createdAt,
    updated_at: segment.updatedAt,
    accepted_at: segment.acceptedAt ?? null
  }
}

function row(runId: string, sessionId: string): RunRow {
  return {
    run_id: runId,
    session_id: sessionId,
    status: 'running',
    phase: 'writing',
    started_at: 1,
    updated_at: 1,
    config_json: '{}',
    parent_run_id: null,
    error_code: null,
    error_message: null
  }
}

function segment(input: {
  runId: string
  sessionId: string
  id: string
  content: string
  status: ManuscriptSegment['status']
  chunkIndex: number
  revision?: number
  supersedesSegmentId?: string
  sceneId?: string
}): ManuscriptSegment {
  return makeManuscriptSegment({
    runId: input.runId,
    sessionId: input.sessionId,
    segmentId: input.id,
    turnId: `${input.id}:turn`,
    chunkIndex: input.chunkIndex,
    revision: input.revision ?? 1,
    content: input.content,
    status: input.status,
    kind: 'prose',
    ...(input.supersedesSegmentId ? { supersedesSegmentId: input.supersedesSegmentId } : {}),
    ...(input.sceneId ? { sceneId: input.sceneId } : {}),
    createdAt: input.chunkIndex,
    updatedAt: input.chunkIndex
  })
}

function appendSourceTurn(repository: Repository, item: ManuscriptSegment, seq: number): void {
  if (!item.sourceTurnId) return
  repository.appendTurn({
    turn_id: item.sourceTurnId,
    run_id: item.runId,
    turn_seq: seq,
    role: 'assistant',
    content: item.content,
    reasoning_content: null,
    tool_calls_json: null,
    tool_result_json: null,
    plan_state: null,
    created_at: item.createdAt
  })
}

function readyEvidence(runId: string, candidate: ManuscriptSegment): { input: ManuscriptAcceptanceInput; json: string } {
  const evidenceRefs: Record<string, string | null> = {}
  const evidenceIdentity = manuscriptAcceptanceEvidenceIdentity({
    runId,
    segmentId: candidate.segmentId,
    candidateHash: candidate.contentHash,
    candidateCharCount: candidate.charCount,
    evidenceRevision: candidate.revision,
    sceneId: candidate.sceneId ?? null,
    evidenceRefs
  })
  const json = JSON.stringify({
    schemaVersion: 1,
    runId,
    segmentId: candidate.segmentId,
    candidateHash: candidate.contentHash,
    candidateCharCount: candidate.charCount,
    evidenceRevision: candidate.revision,
    evidenceIdentity,
    sceneId: candidate.sceneId ?? null,
    evidenceRefs
  })
  return {
    json,
    input: {
      runId,
      segmentId: candidate.segmentId,
      expectedContentHash: candidate.contentHash,
      expectedCharCount: candidate.charCount,
      evidenceRevision: candidate.revision,
      evidenceIdentity,
      sceneId: candidate.sceneId ?? null,
      acceptedAt: 100
    }
  }
}

function settings(strongConstraintEnabled: boolean): Settings {
  return {
    model: 'p1-b-synthetic',
    baseUrl: 'http://127.0.0.1:9',
    maxTokens: 4096,
    temperature: 0.7,
    topP: 1,
    thinkingEnabled: false,
    reasoningEffort: 'low',
    workDir: 'C:/p1-b-work',
    docDir: 'C:/p1-b-docs',
    novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' },
    historyBudgetTokens: 60000,
    strongConstraintEnabled,
    themeLockMode: strongConstraintEnabled ? 'guided' : 'off',
    completionTokenBudget: 0,
    completionWallClockMs: 0
  } as unknown as Settings
}

function longwriteConfig(runId: string, targetChars: number, withPipeline: boolean): RunConfig {
  const config = buildExecutionSnapshot({
    payload: {
      id: runId,
      mode: 'longwrite',
      workspace: 'novel',
      phase: 'execute',
      longMode: true,
      targetChars,
      text: '围绕灯塔继续写作。',
      ...(withPipeline ? { strongConstraints: { themeLockMode: 'guided' } } : { strongConstraints: { enabled: false } })
    },
    settings: settings(withPipeline),
    sessionId: `${runId}-session`,
    memory: { projectPath: '', projectContent: '', userContent: '' },
    now: 1700000000000
  }) as unknown as RunConfig
  if (!withPipeline) delete config.writingPipeline
  return config
}

async function partialChainCase(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepwriter-p1-b-chain-'))
  const dbPath = path.join(root, 'chain.sqlite')
  const runId = 'p1-b-chain-run'
  const sessionId = 'p1-b-chain-session'
  const run2 = 'p1-b-foreign-run'
  const run3 = 'p1-b-cycle-run'
  let repository: Repository | null = null
  try {
    repository = createRepository(dbPath)
    repository.open()
    for (const [sid, title] of [[sessionId, 'P1-B chain'], [`${run2}-session`, 'P1-B foreign'], [`${run3}-session`, 'P1-B cycle']] as const) {
      repository.createSession(sid, title, 'fixture')
    }
    repository.createRun(row(runId, sessionId))
    repository.createRun(row(run2, `${run2}-session`))
    repository.createRun(row(run3, `${run3}-session`))

    const p1 = segment({ runId, sessionId, id: 'p1-b-p1', content: '潮声压低了灯火', status: 'partial', chunkIndex: 1, sceneId: 'scene-a' })
    const candidate = segment({ runId, sessionId, id: 'p1-b-candidate', content: '潮声压低了灯火，门轴轻响。', status: 'candidate', chunkIndex: 1, revision: 2, supersedesSegmentId: p1.segmentId, sceneId: 'scene-a' })
    const p2 = segment({ runId, sessionId, id: 'p1-b-p2', content: '潮声压低了灯火，门轴轻响', status: 'partial', chunkIndex: 1, revision: 3, supersedesSegmentId: p1.segmentId, sceneId: 'scene-a' })
    const p3 = segment({ runId, sessionId, id: 'p1-b-p3', content: '潮声压低了灯火，门轴轻响，雨幕后的船鸣渐近', status: 'partial', chunkIndex: 1, revision: 4, supersedesSegmentId: p2.segmentId, sceneId: 'scene-a' })
    for (const [item, seq] of [[p1, 1], [candidate, 2], [p2, 3], [p3, 4]] as const) appendSourceTurn(repository, item, seq)
    repository.saveManuscriptSegment(toRow(p1))
    repository.saveManuscriptSegment(toRow(candidate))
    let rows = repository.getManuscriptSegmentsByRun(runId)
    check('P1-B candidate 持久化不提前吞掉 active partial', rows.find((item) => item.segment_id === p1.segmentId)?.status === 'partial' && rows.find((item) => item.segment_id === candidate.segmentId)?.status === 'candidate')
    repository.saveManuscriptSegment(toRow(p2))
    rows = repository.getManuscriptSegmentsByRun(runId)
    check('P1-B partial2 同事务 supersede 祖先且每 scope 一个 active', rows.filter((item) => item.status === 'partial').length === 1 && rows.find((item) => item.segment_id === p1.segmentId)?.status === 'superseded')
    repository.saveManuscriptSegment(toRow(p3))
    rows = repository.getManuscriptSegmentsByRun(runId)
    check('P1-B partial3 链接 partial2 并保持零重复祖先', rows.find((item) => item.segment_id === p2.segmentId)?.status === 'superseded' && rows.filter((item) => item.status === 'partial').map((item) => item.segment_id).join() === p3.segmentId)

    const foreign = segment({ runId: run2, sessionId: `${run2}-session`, id: 'p1-b-foreign-partial', content: '异 run 残句', status: 'partial', chunkIndex: 1, sceneId: 'scene-a' })
    appendSourceTurn(repository, foreign, 1)
    repository.saveManuscriptSegment(toRow(foreign))
    let crossRunRejected = false
    try { repository.saveManuscriptSegment(toRow(segment({ runId, sessionId, id: 'p1-b-cross', content: '跨 run。', status: 'partial', chunkIndex: 1, revision: 8, supersedesSegmentId: foreign.segmentId, sceneId: 'scene-a' }))) } catch (error) { crossRunRejected = error instanceof Error && error.message === 'manuscript_partial_chain_cross_run' }
    check('P1-B 检测跨 run partial 链', crossRunRejected)
    let brokenRejected = false
    try { repository.saveManuscriptSegment(toRow(segment({ runId, sessionId, id: 'p1-b-broken', content: '断链。', status: 'partial', chunkIndex: 1, revision: 9, supersedesSegmentId: 'missing-parent', sceneId: 'scene-a' }))) } catch (error) { brokenRejected = error instanceof Error && error.message === 'manuscript_partial_chain_broken' }
    check('P1-B 检测断链 partial', brokenRejected)

    const finalCandidate = segment({ runId, sessionId, id: 'p1-b-final', content: '潮声压低了灯火，门轴轻响，雨幕后的船鸣渐近，沈遥终于抬头。', status: 'candidate', chunkIndex: 1, revision: 5, supersedesSegmentId: p3.segmentId, sceneId: 'scene-a' })
    appendSourceTurn(repository, finalCandidate, 5)
    repository.saveManuscriptSegment(toRow(finalCandidate))
    const ready = readyEvidence(runId, finalCandidate)
    repository.saveRunEvidence(runId, 'manuscript_acceptance_ready', ready.json)
    repository.acceptManuscriptSegment(ready.input)
    rows = repository.getManuscriptSegmentsByRun(runId)
    check('P1-B final acceptance 原子 supersede 整条祖先链', rows.find((item) => item.segment_id === finalCandidate.segmentId)?.status === 'accepted' && rows.filter((item) => item.status === 'partial').length === 0 && rows.filter((item) => item.status === 'superseded').length >= 3)

    const cycle = segment({ runId: run3, sessionId: `${run3}-session`, id: 'p1-b-cycle', content: '环。', status: 'partial', chunkIndex: 1 })
    appendSourceTurn(repository, cycle, 1)
    repository.saveManuscriptSegment(toRow(cycle))
    repository.close()
    repository = null
    const raw = new DatabaseSync(dbPath)
    raw.prepare('UPDATE manuscript_segments SET supersedes_segment_id = ? WHERE segment_id = ?').run(cycle.segmentId, cycle.segmentId)
    raw.close()
    repository = createRepository(dbPath)
    repository.open()
    let cycleRejected = false
    try { repository.getManuscriptSegmentsByRun(run3) } catch (error) { cycleRejected = error instanceof Error && error.message === 'manuscript_partial_chain_cycle' }
    check('P1-B 检测 partial 环', cycleRejected)
  } finally {
    repository?.close()
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

type StorePortFactory = (repository: Repository, artifactDir: string) => RunStorePort

async function enginePartialContinuationCase(createStorePort: StorePortFactory): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepwriter-p1-b-engine-'))
  const dbPath = path.join(root, 'engine.sqlite')
  const artifactDir = path.join(root, 'artifacts')
  const runId = 'p1-b-engine-run'
  const sessionId = 'p1-b-engine-session'
  const outputs = ['潮声压低了灯火', '，门轴轻响', '，雨幕后的船鸣渐近', '，沈遥终于抬头。', '林舟把钥匙收进掌心。']
  const expected = outputs.join('')
  const expectedPartial = outputs.slice(0, 2).join('')
  const config = longwriteConfig(runId, codePointLength(expected), false)
  const repository = createRepository(dbPath)
  repository.open()
  repository.createSession(sessionId, 'P1-B engine', 'fixture')
  const store = createStorePort(repository, artifactDir)
  let calls = 0
  const captured: Array<Array<{ role: string; content: string }>> = []
  const engine = createAgentRunEngine({
    store,
    modelCall: async (input) => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
        const text = outputs[calls] ?? outputs[outputs.length - 1]
        calls += 1
        captured.push(input.messages.map((message) => ({ role: message.role, content: message.content })))
        yield { type: 'text', delta: text }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => config,
    onEvent: () => undefined,
    onRunUpdate: () => undefined,
    publishLongwriteArtifact: async () => ({ displayName: 'p1-b-engine.md', relativePath: 'p1-b-engine.md' })
  })
  try {
    const started = await engine.start({ sessionId, runId, config })
    await store.appendTurn({ runId, turnId: `${runId}:user`, turnSeq: 1, role: 'user', content: '继续写灯塔故事。', createdAt: 1 })
    await engine.step(runId)
    const state = await engine.getState(runId)
    const rows = repository.getManuscriptSegmentsByRun(runId)
    const accepted = rows.filter((item) => item.status === 'accepted' && item.kind === 'prose').sort((a, b) => a.chunk_index - b.chunk_index || a.revision - b.revision)
    const acceptedText = accepted.map((item) => item.content).join('')
    const artifact = repository.getArtifactsByRun(runId).find((item) => item.artifact_type === 'manuscript' && item.status === 'completed')
    const activePartials = rows.filter((item) => item.status === 'partial')
    const latestContext = captured.at(-1)?.map((item) => item.content).join('\n') ?? ''
    // The durable no-progress guard intentionally stops two consecutive
    // writer rounds that have not produced accepted prose.  This fixture uses
    // two incomplete chunks to verify that recovery keeps the carried partial
    // instead of spending a third provider call or pretending the run is done.
    check('P1-B 真实 engine 两轮 incomplete 后有界暂停', started.ok && state.run?.status === 'waiting_user' && state.run?.errorCode === 'run_no_progress' && calls === 2, JSON.stringify({ status: state.run?.status, errorCode: state.run?.errorCode, calls }))
    check('P1-B continuation base 保留且正文零污染', accepted.length === 0 && acceptedText === '' && activePartials.length === 1 && activePartials[0]?.content === expectedPartial, `accepted=${accepted.length} partials=${activePartials.length} partial=${activePartials[0]?.content ?? ''}`)
    check('P1-B 未达完成不生成 artifact 且不丢残句', artifact === undefined && activePartials.length === 1 && latestContext.includes(outputs[0]), JSON.stringify({ partials: activePartials.length, artifact: artifact?.hash }))
  } catch (error) {
    const debugRows = repository.getManuscriptSegmentsByRun(runId).map((item) => ({ id: item.segment_id, source: item.source_turn_id, status: item.status, revision: item.revision, content: item.content }))
    check('P1-B 真实 engine 两轮 incomplete 后有界暂停', false, `${error instanceof Error ? error.message : String(error)} calls=${calls} rows=${JSON.stringify(debugRows)}`)
  } finally {
    repository.close()
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

type RecoveryStage = 'candidate_persisted' | 'critic_started' | 'edit_prepared' | 'accepted'

async function legacyRecoveryCase(stage: RecoveryStage, createStorePort: StorePortFactory): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `deepwriter-p1-b-recovery-${stage}-`))
  const dbPath = path.join(root, 'legacy.sqlite')
  const artifactDir = path.join(root, 'artifacts')
  await fsp.mkdir(artifactDir, { recursive: true })
  const runId = `p1-b-${stage}`
  const sessionId = `${runId}-session`
  const turnId = `${runId}:assistant`
  const original = '灯塔里传来脚步。'
  const targetChars = codePointLength(original)
  const config = longwriteConfig(runId, targetChars, true)
  delete config.manuscriptSegmentsVersion
  const configJson = JSON.stringify(config)
  // The production wall-clock budget is measured from the durable run
  // start, including time spent while the app was closed.  This recovery
  // fixture represents a run that has just been interrupted, so seed the
  // durable timestamp at test start instead of the old Unix-epoch sentinel.
  // Keeping the real clock semantics here prevents the fixture from making
  // an already-expired run look recoverable.
  const fixtureStartedAt = Date.now()
  const raw = new DatabaseSync(dbPath)
  runMigrations(raw, 15)
  raw.prepare('INSERT INTO sessions (session_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?)').run(sessionId, 'P1-B legacy', 'fixture', 1, 2)
  raw.prepare('INSERT INTO runs (run_id,session_id,status,phase,started_at,updated_at,config_json,parent_run_id,error_code,error_message,client_request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(runId, sessionId, 'running', 'writing', fixtureStartedAt, fixtureStartedAt, configJson, null, null, null, null)
  raw.prepare('INSERT INTO turns (turn_id,run_id,turn_seq,role,content,reasoning_content,tool_calls_json,tool_result_json,plan_state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(`${runId}:user`, runId, 1, 'user', '继续写灯塔故事。', null, null, null, null, 1)
  raw.prepare('INSERT INTO turns (turn_id,run_id,turn_seq,role,content,reasoning_content,tool_calls_json,tool_result_json,plan_state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(turnId, runId, 2, 'assistant', original, null, null, null, null, 2)
  raw.close()

  let repository: Repository | null = createRepository(dbPath)
  repository.open()
  const policy = config.writingPipeline as { hash: string }
  const beforeHash = writingTextHash(original)
  let finalContent = original
  let patch: { issueId: string; startCp: number; endCp: number; quote: string; replacement: string } | undefined
  if (stage === 'edit_prepared') {
    const startCp = Array.from(original.slice(0, original.indexOf('脚步'))).length
    patch = { issueId: 'p1-b-edit', startCp, endCp: startCp + 2, quote: '脚步', replacement: '回声' }
    finalContent = applyTargetedEdit(original, { schemaVersion: 1, candidateHash: beforeHash, patches: [patch] }).content
  }
  const evidence = {
    schemaVersion: 1,
    policyHash: policy.hash,
    turnId,
    turnSeq: 2,
    round: 1,
    replaceRevision: 0,
    stage,
    candidateHash: stage === 'edit_prepared' ? beforeHash : writingTextHash(finalContent),
    ...(stage === 'critic_started' ? { callAttempts: 1 } : {}),
    ...(stage === 'edit_prepared' ? { beforeHash, afterHash: writingTextHash(finalContent), patch, verified: true } : {})
  }
  const seedEvidenceJson = JSON.stringify(evidence)
  repository.saveRunEvidence(runId, 'writing_pipeline_latest', seedEvidenceJson)
  repository.close()
  repository = createRepository(dbPath)
  repository.open()
  const store = createStorePort(repository, artifactDir)
  let providerCalls = 0
  let publishCalls = 0
  const engine = createAgentRunEngine({
    store,
    modelCall: async (input) => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
        providerCalls += 1
        // A system prompt can contain a complete, valid example report. Only
        // the current critic user payload identifies this recovery candidate.
        const message = input.messages.filter((item) => item.role === 'user').at(-1)
        const body = JSON.parse(message?.content ?? '') as { candidate?: unknown; candidateHash?: unknown }
        if (input.purpose !== 'critic' || typeof body.candidate !== 'string' ||
          body.candidate !== finalContent || body.candidateHash !== writingTextHash(body.candidate)) {
          throw new Error('fixture_critic_candidate_identity_mismatch')
        }
        const candidateHash = body.candidateHash
        yield { type: 'text', delta: JSON.stringify({ schemaVersion: 1, candidateHash, issues: [] }) }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => config,
    onEvent: () => undefined,
    onRunUpdate: () => undefined,
    publishLongwriteArtifact: async () => { publishCalls += 1; return { displayName: `${stage}.md`, relativePath: `${stage}.md` } }
  })
  try {
    await engine.restore(runId)
    await engine.step(runId)
    const state = await engine.getState(runId)
    const rows = repository.getManuscriptSegmentsByRun(runId)
    const accepted = rows.filter((item) => item.status === 'accepted' && item.kind === 'prose')
    const artifact = repository.getArtifactsByRun(runId).find((item) => item.artifact_type === 'manuscript' && item.status === 'completed')
    const runError = `${state.run?.errorCode ?? ''} ${state.run?.errorMessage ?? ''}`
    if (stage === 'candidate_persisted' || stage === 'critic_started') {
      check(`P1-B 旧不明 ${stage} 安全暂停不制造审校额度`, state.run?.status === 'waiting_user' && state.run?.errorCode === 'writing_critic_retry_exhausted', JSON.stringify({ status: state.run?.status, error: runError }))
      check(`P1-B 旧不明 ${stage} 零 provider replay 且原 evidence 不改`, providerCalls === 0 && publishCalls === 0 && (await store.getRunEvidence(runId, 'writing_pipeline_latest'))?.json === seedEvidenceJson, `providerCalls=${providerCalls} publishCalls=${publishCalls}`)
      const savedTurn = state.turns.find(item => item.turnId === turnId)
      check(`P1-B 旧不明 ${stage} 原稿和 hash 完整保留`, savedTurn?.content === original && writingTextHash(savedTurn.content) === beforeHash)
      check(`P1-B 旧不明 ${stage} 无伪 accepted/artifact`, accepted.length === 0 && repository.getArtifactsByRun(runId).length === 0)
    } else {
      check(`P1-B 活跃旧 run 恢复 ${stage} 不进入 immutable/run_step_failed`, state.run?.status === 'completed' && !runError.includes('manuscript_segment_immutable') && !runError.includes('run_step_failed'), JSON.stringify({ status: state.run?.status, error: runError }))
      check(`P1-B ${stage} accepted/artifact 只来自可验证正文`, accepted.length === 1 && accepted[0].content === finalContent && artifact?.hash === manuscriptSegmentHash(finalContent) && artifact?.char_count === codePointLength(finalContent), JSON.stringify({ accepted: accepted.length, artifact: artifact?.hash }))
      check(`P1-B ${stage} provider 恢复调用受限`, providerCalls <= (stage === 'accepted' ? 0 : 1), `providerCalls=${providerCalls}`)
    }
  } catch (error) {
    const debugRows = repository.getManuscriptSegmentsByRun(runId).map((item) => ({ id: item.segment_id, source: item.source_turn_id, status: item.status, revision: item.revision, content: item.content }))
    check(`P1-B 活跃旧 run 恢复 ${stage} 不进入 immutable/run_step_failed`, false, `${error instanceof Error ? error.message : String(error)} rows=${JSON.stringify(debugRows)}`)
  } finally {
    repository.close()
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function canonicalRecoveryCase(stage: 'candidate_persisted' | 'critic_started', createStorePort: StorePortFactory, driftHead = false): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `deepwriter-p1-b-canonical-${stage}-`))
  const dbPath = path.join(root, 'upgraded.sqlite')
  const artifactDir = path.join(root, 'artifacts')
  const runId = `p1-b-canonical-${stage}${driftHead ? '-head-drift' : ''}`
  const sessionId = `${runId}-session`
  const original = '灯塔里传来脚步。'
  const config = longwriteConfig(runId, codePointLength(original), true)
  // Upgrade an empty v15 DB, then start a NEW normal run. No old packet is
  // rewritten or supplied with invented provider/critic completion evidence.
  const raw = new DatabaseSync(dbPath)
  runMigrations(raw, 15)
  raw.close()
  let repository = createRepository(dbPath)
  repository.open()
  repository.createSession(sessionId, 'P1-B canonical cold recovery', 'fixture')
  const baseStore = createStorePort(repository, artifactDir)
  let writerCalls = 0
  let criticCalls = 0
  let publishCalls = 0
  let interrupted = false
  const interruption = new Error('fixture_provider_journal_interruption')
  const interruptedStore: RunStorePort = {
    ...baseStore,
    saveRunEvidence: async (id, kind, json) => {
      if (interrupted) throw interruption
      await baseStore.saveRunEvidence(id, kind, json)
      const record = JSON.parse(json) as Record<string, unknown>
      if ((stage === 'candidate_persisted' && kind === 'writing_pipeline_latest' && record.stage === 'candidate_persisted') ||
        (stage === 'critic_started' && kind.startsWith('writing_pipeline_critic_') && record.finishReason === 'stop')) {
        interrupted = true
        throw interruption
      }
    },
    updateRun: async (id, update) => {
      if (interrupted) throw interruption
      await baseStore.updateRun(id, update)
    }
  }
  const makeEngine = (store: RunStorePort) => createAgentRunEngine({
    store,
    modelCall: async input => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
        if (input.purpose === 'critic') {
          criticCalls += 1
          const body = JSON.parse(input.messages.filter(item => item.role === 'user').at(-1)?.content ?? '') as { candidate?: unknown; candidateHash?: unknown }
          if (body.candidate !== original || body.candidateHash !== writingTextHash(original)) throw new Error('fixture_critic_candidate_identity_mismatch')
          yield { type: 'text', delta: JSON.stringify({ schemaVersion: 1, candidateHash: body.candidateHash, issues: [] }) }
        } else {
          if (input.purpose && input.purpose !== 'writer') throw new Error('fixture_unexpected_provider_purpose')
          writerCalls += 1
          yield { type: 'text', delta: original }
        }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '', getConfig: () => config, onEvent: () => undefined, onRunUpdate: () => undefined,
    publishLongwriteArtifact: async () => { publishCalls += 1; return { displayName: `${runId}.md`, relativePath: `${runId}.md` } }
  })
  try {
    const warm = makeEngine(interruptedStore)
    const started = await warm.start({ runId, sessionId, config })
    await baseStore.appendTurn({ runId, turnId: `${runId}:user`, turnSeq: 1, role: 'user', content: '继续写灯塔故事。', createdAt: Date.now() })
    try { await warm.step(runId) } catch (error) { if (error !== interruption) throw error }
    const journalJson = (await baseStore.getRunEvidence(runId, 'writing_pipeline_latest'))?.json ?? '{}'
    const journal = JSON.parse(journalJson) as Record<string, unknown>
    const provider = journal.providerFence as { candidateHash?: string; segmentId?: string; fence?: { expectedHeadHash?: string | null } } | undefined
    const candidate = repository.getManuscriptSegmentsByRun(runId).find(item => item.segment_id === journal.criticSegmentId)
    check(`P1-B canonical ${stage} 正常 writer 原子写出 candidate-bound Provider fence`, started.ok && interrupted && writerCalls === 1 &&
      journal.stage === stage && journal.criticCallAttempts === (stage === 'candidate_persisted' ? 0 : 1) &&
      provider?.candidateHash === writingTextHash(original) && provider.segmentId === candidate?.segment_id && candidate?.status === 'candidate' &&
      candidate.content === original && publishCalls === 0 && repository.getArtifactsByRun(runId).length === 0)
    if (stage === 'critic_started') {
      const receiptJson = (await baseStore.getRunEvidence(runId, `writing_pipeline_critic_${journal.turnId}_${journal.candidateHash}_1`))?.json ?? '{}'
      const receipt = JSON.parse(receiptJson) as Record<string, unknown>
      check('P1-B canonical critic_started raw/hash/finish 由实际 collector 写入且同原 fence', criticCalls === 1 && receipt.criticCallAttempts === 1 &&
        receipt.finishReason === 'stop' && receipt.error === null && typeof receipt.raw === 'string' && writingTextHash(receipt.raw) === receipt.rawHash &&
        JSON.stringify(receipt.providerFence) === JSON.stringify(provider))
    }
    const beforeColdCritics = criticCalls
    repository.close()
    if (driftHead) {
      // Fault-inject a changed authoritative head, not a replacement fence.
      // This private test DB is the only target; the old journal stays intact.
      const fault = new DatabaseSync(dbPath)
      fault.prepare('UPDATE story_ledger_heads SET head_hash=? WHERE story_id=(SELECT story_id FROM story_ledger_runs WHERE run_id=?)').run('a'.repeat(64), runId)
      fault.close()
    }
    repository = createRepository(dbPath)
    repository.open()
    const cold = makeEngine(createStorePort(repository, artifactDir))
    let restoreError = ''
    try { await cold.restore(runId) } catch (error) { restoreError = error instanceof Error ? error.message : String(error) }
    if (!restoreError) await cold.step(runId)
    const state = await cold.getState(runId)
    const accepted = repository.getManuscriptSegmentsByRun(runId).filter(item => item.kind === 'prose' && item.status === 'accepted')
    const artifacts = repository.getArtifactsByRun(runId)
    if (driftHead) {
      check('P1-B canonical 冷恢复拒绝 head 漂移且不借当前 head 祝福原 fence', restoreError.includes('story_ledger_concurrent_head_conflict') && state.run?.status === 'recovery_required' &&
        writerCalls === 1 && criticCalls === beforeColdCritics && publishCalls === 0 && accepted.length === 0 && artifacts.length === 0 &&
        repository.getRunEvidence(runId, 'writing_pipeline_latest')?.json === journalJson, JSON.stringify({ restoreError, status: state.run?.status }))
    } else {
      const artifact = artifacts.find(item => item.artifact_type === 'manuscript' && item.status === 'completed')
      check(`P1-B canonical ${stage} 真正冷 DB 恢复完成不进入 immutable/run_step_failed`, !restoreError && state.run?.status === 'completed', JSON.stringify({ restoreError, status: state.run?.status, error: state.run?.errorMessage }))
      check(`P1-B canonical ${stage} accepted/artifact 只来自可验证正文`, accepted.length === 1 && accepted[0].content === original &&
        artifact?.hash === manuscriptSegmentHash(original) && artifact.char_count === codePointLength(original))
      check(`P1-B canonical ${stage} writer 不重放且 critic 实际总共一次`, writerCalls === 1 && criticCalls === 1 &&
        criticCalls - beforeColdCritics === (stage === 'candidate_persisted' ? 1 : 0), `writerCalls=${writerCalls} criticCalls=${criticCalls} coldCritics=${criticCalls - beforeColdCritics}`)
    }
  } finally {
    repository.close()
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function main(): Promise<void> {
  console.log('P1-B manuscript partial graph / legacy recovery')
  const adapterModule = await loadTsModule('src/main/runKernelAdapter.ts')
  const createStorePort = adapterModule.createRunStorePort as StorePortFactory
  await partialChainCase()
  await enginePartialContinuationCase(createStorePort)
  for (const stage of ['candidate_persisted', 'critic_started', 'edit_prepared', 'accepted'] as RecoveryStage[]) await legacyRecoveryCase(stage, createStorePort)
  for (const stage of ['candidate_persisted', 'critic_started'] as const) await canonicalRecoveryCase(stage, createStorePort)
  await canonicalRecoveryCase('candidate_persisted', createStorePort, true)
  console.log(`\nP1-B manuscript recovery: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

void main().catch((error) => {
  console.error('P1-B manuscript recovery 执行异常：', error)
  process.exitCode = 2
})
