import { desktopSourceExternals } from './desktop-source-boundary.mjs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import { buildNarrativeContextManifest, validateNarrativeContextManifest } from '../src/main/narrative/narrativeContext'
import { buildNarrativeFactsFromGrill } from '../src/main/narrative/factRegistry'
import { extractNarrativeStateDelta, type NarrativeStateExtractionInput } from '../src/main/narrative/stateExtractor'
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
  const outfile = path.join(ROOT, 'out', `p1-2-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

function exactProse(length: number, prefix: string, seed: number): string {
  const points = Array.from(prefix)
  while (points.length < length - 1) points.push(String.fromCodePoint(0x20000 + seed + points.length))
  points.length = Math.max(0, length - 1)
  points.push('。')
  return points.join('')
}

async function main(): Promise<void> {
  const [sceneMod, snapshotMod, repoMod, portMod, engineMod] = await Promise.all([
    loadTsModule('src/main/narrative/sceneContract.ts'),
    loadTsModule('src/main/executionSnapshot.ts'),
    loadTsModule('src/main/db/repository.ts'),
    loadTsModule('src/main/runKernelAdapter.ts'),
    loadTsModule('src/main/jobs/AgentRunEngine.ts')
  ])
  const buildSceneContractPlan = sceneMod.buildSceneContractPlan as (input: Record<string, unknown>) => SceneContractPlan
  const buildExecutionSnapshot = snapshotMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  const createRepository = repoMod.createRepository as (dbPath: string) => {
    open(): void
    close(): void
    getSceneStates(runId: string): Array<Record<string, unknown>>
    getNarrativeCommits(runId: string, sceneId?: string): Array<Record<string, unknown>>
    getNarrativeLedger(runId: string, sceneId?: string): Array<Record<string, unknown>>
    upsertNarrativeFact(fact: Record<string, unknown>): Record<string, unknown>
    getManuscriptSegmentsByRun(runId: string): Array<Record<string, unknown>>
    getRunEvidence(runId: string, kind: string): { json: string } | null
    getLatestCompletionEvaluation(runId: string): { state: string; json: string } | null
  }
  const createRunStorePort = portMod.createRunStorePort as (repository: unknown, artifactDir: string) => Record<string, unknown>
  const createAgentRunEngine = engineMod.createAgentRunEngine as (opts: Record<string, unknown>) => {
    start(input: Record<string, unknown>): Promise<{ ok: boolean }>
    step(runId: string): Promise<void>
    getState(runId: string): Promise<{ run: { status: string; phase?: string; errorCode?: string; errorMessage?: string } | null }>
  }

  const targetChars = 720
  const outline: GrillMeOutline = {
    title: '雾港交接',
    premise: '守灯人抵达灯塔，在暴雨前完成钥匙交接并点亮灯火。',
    targetChars,
    sections: [{
      id: 's1',
      title: '灯塔夜班',
      purpose: '完成交接并留下可承接的决定。',
      targetChars,
      beats: ['林舟抵达灯塔', '林舟把钥匙交给沈遥'],
      sourceSlotIds: ['goal', 'characters', 'setting', 'mustKeep'],
      scenes: [
        {
          id: 'arrival',
          title: '抵达与交接',
          purpose: '林舟抵达灯塔并完成钥匙交接。',
          targetChars: 360,
          beats: ['林舟抵达灯塔', '林舟把钥匙交给沈遥'],
          sourceSlotIds: ['goal', 'characters', 'setting', 'mustKeep']
        },
        {
          id: '灯火',
          title: '灯火与承接',
          purpose: '沈遥与林舟点亮灯塔，为下一场留下结果。',
          targetChars: 360,
          beats: ['沈遥与林舟点亮灯塔'],
          sourceSlotIds: ['goal', 'characters', 'setting', 'mustKeep']
        }
      ]
    }]
  }
  const outlineHash = grillMeOutlineHash(outline)
  const structuredFacts = JSON.stringify({ facts: [
    { kind: 'character_state', entityId: 'char-lin', characterId: '林舟', status: '疲惫但清醒', locationId: '灯塔', goals: ['完成交接'], evidenceTerms: ['林舟', '灯塔'] },
    { kind: 'object_state', entityId: 'obj-key', objectId: '钥匙', holderId: '沈遥', locationId: '灯塔', condition: '已交接', evidenceTerms: ['钥匙', '交给'] },
    { kind: 'relationship', entityId: 'rel-lin-yao-trust', fromCharacterId: '林舟', toCharacterId: '沈遥', dimension: 'trust', value: 0.7, reason: '两人完成守灯交接', evidenceTerms: ['信任', '林舟', '沈遥'] },
    { kind: 'knowledge', entityId: 'knowledge-storm', factId: 'fact-storm', knowerId: '林舟', stance: 'knows', certainty: 0.9, confidence: 0.95, effectiveTime: '当夜', evidenceTerms: ['真相', '林舟'] },
    { kind: 'timeline_event', entityId: 'event-storm', eventType: 'storm_approach', actorIds: ['林舟', '沈遥'], objectIds: [], locationId: '灯塔', storyTime: '当夜', causeEventIds: [], consequenceEventIds: [], summary: '暴雨逼近，交接必须在夜里完成。', evidenceTerms: ['暴雨', '逼近'] },
    { kind: 'foreshadow', entityId: 'thread-storm', threadId: 'thread-storm', lifecycle: 'advanced', reason: '暴雨逼近成为后续压力', evidenceTerms: ['暴雨', '逼近'] }
  ] })
  const answers = [
    { slotId: 'goal', value: '完成有代价的灯塔交接', source: 'user' },
    { slotId: 'characters', value: '林舟、沈遥', source: 'user' },
    { slotId: 'setting', value: '雾港灯塔', source: 'user' },
    { slotId: 'mustKeep', value: structuredFacts, source: 'user' }
  ]
  const plan = buildSceneContractPlan({ outline, outlineHash, outlineRevision: 1, answers, characterNames: [], strongConstraints: { forbiddenTerms: [], mustKeep: [] } })
  check('P1-2 contract 编译为可追溯的两个 scene', plan.contracts.length === 2 && plan.contracts.every((contract, index) => contract.order === index + 1 && contract.sourceIds.includes('mustKeep')), JSON.stringify(plan.contracts.map((contract) => ({ id: contract.sceneId, sources: contract.sourceIds }))))

  const runId = 'p1-2-production-run'
  const sessionId = 'p1-2-production-session'
  const settings = {
    model: 'synthetic-p1-2',
    baseUrl: 'http://127.0.0.1:9',
    maxTokens: 4096,
    temperature: 0.7,
    topP: 1,
    thinkingEnabled: false,
    reasoningEffort: 'high',
    workDir: 'C:/p1-2-work',
    docDir: 'C:/p1-2-docs',
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
      text: '请依据已确认大纲完成长文。',
      grillMe: {
        stateId: 'p1-2-grill-state',
        originalTask: '写一篇雾港灯塔交接小说。',
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
    sessionId,
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  // Each scene is intentionally a complete provider candidate.  The first
  // sentence carries all six evidence terms, while the remaining code points
  // make the exact scene budget deterministic without pretending arbitrary
  // free prose is a state assertion.
  const outputs = [
    exactProse(360, '林舟抵达灯塔，林舟把钥匙交给沈遥。暴雨逼近，林舟知道真相，二人的信任改变。', 1),
    exactProse(360, '沈遥与林舟点亮灯塔。钥匙交给沈遥，暴雨逼近，林舟知道真相，二人的信任改变。', 2001)
  ]
  let providerCalls = 0
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p1-2-narrative-'))
  const repo = createRepository(path.join(tmpDir, 'run.db'))
  repo.open()
  const artifactDir = path.join(tmpDir, 'artifacts')
  const store = createRunStorePort(repo, artifactDir)
  const engine = createAgentRunEngine({
    store,
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
        const text = outputs[Math.min(providerCalls, outputs.length - 1)]!
        providerCalls += 1
        for (let offset = 0; offset < text.length; offset += 512) yield { type: 'text', delta: text.slice(offset, offset + 512) }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => config,
    onEvent: () => undefined,
    onRunUpdate: () => undefined,
    publishLongwriteArtifact: async () => ({ displayName: 'p1-2.md', relativePath: 'p1-2.md' })
  })

  try {
    const started = await engine.start({ sessionId, runId, config })
    // Mirror the production ContextService fact materialization so this
    // engine-level proof exercises the real knowledge-edge resolver and
    // immutable factRef, not only the pre-registry compatibility path.
    const registeredFacts = buildNarrativeFactsFromGrill({ sessionId, runId, answers, now: Date.now() })
    for (const fact of registeredFacts) repo.upsertNarrativeFact(fact as unknown as Record<string, unknown>)
    await engine.step(runId)
    const final = await engine.getState(runId)
    const states = repo.getSceneStates(runId)
    const rows = repo.getManuscriptSegmentsByRun(runId)
    const commits = repo.getNarrativeCommits(runId)
    const ledger = repo.getNarrativeLedger(runId)
    const acceptedRows = rows.filter((row) => row.status === 'accepted' && row.kind === 'prose')
    const acceptedTextByScene = (sceneId: string): string => acceptedRows
      .filter((row) => row.scene_id === sceneId)
      .sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index) || Number(a.revision) - Number(b.revision) || String(a.segment_id).localeCompare(String(b.segment_id)))
      .map((row) => String(row.content ?? ''))
      .join('')
    const kinds = new Set(ledger.map((entry) => entry.kind))
    check('P1-2 真实 AgentRunEngine 入口完成两个 scene', started.ok && final.run?.status === 'completed' && states.length === 2 && states.every((state) => state.lifecycle === 'committed'), JSON.stringify({ status: final.run?.status, error: final.run?.errorCode, calls: providerCalls, segments: rows.map((row) => ({ status: row.status, chars: row.char_count, scene: row.scene_id })), completion: repo.getLatestCompletionEvaluation(runId), states }))
    const knowledgeChanges = commits.flatMap((commit) => commit.stateDelta.changes).filter((change) => change.kind === 'knowledge')
    check('P1-2 accepted scene 产生非空 delta/commit，而非 buildEmpty', commits.length === 2 && commits.every((commit) => commit.stateDelta.changes.length > 0) && ledger.length > 0 && ledger.every((entry) => entry.deltaHash === commits.find((commit) => commit.sceneId === entry.sceneId)?.deltaHash) && knowledgeChanges.length > 0 && knowledgeChanges.every((change) => {
      const factRef = change.factRef as Record<string, unknown> | undefined
      return Boolean(factRef?.factId && Number(factRef.version) >= 1 && factRef.canonicalStatement && factRef.canonicalHash && factRef.provenanceHash)
    }), JSON.stringify({ commits: commits.map((commit) => ({ sceneId: commit.sceneId, changes: commit.stateDelta.changes.length, deltaHash: commit.deltaHash })), ledger: ledger.length, knowledge: knowledgeChanges.map((change) => ({ factId: change.factId, factRef: change.factRef })) }))
    check('P1-2 角色/知识/物品/关系/时间线/伏笔六类均由生产提交', ['character_state', 'knowledge', 'object_state', 'relationship', 'timeline_event', 'foreshadow'].every((kind) => kinds.has(kind)), JSON.stringify([...kinds]))
    const extractionReports = commits.map((commit) => {
      const evidence = repo.getRunEvidence(runId, `scene_completion_decision:${String(commit.acceptedSegmentId)}`)
      if (!evidence) return null
      try {
        const payload = JSON.parse(evidence.json) as { narrativeStateExtraction?: { sceneId?: string; sceneContentHash?: string; sceneCharCount?: number; acceptedSegments?: Array<{ segmentId: string }>; changeIds?: string[]; changeBindings?: Array<{ changeId: string; acceptedSegmentId: string; acceptedContentHash: string; sceneContentHash: string; acceptedSegmentIds: string[] }> } }
        return payload.narrativeStateExtraction ?? null
      } catch {
        return null
      }
    })
    check('P1-2 每个 change 绑定 candidate segment + full scene manifest evidence', extractionReports.every((report, index) => {
      const commit = commits[index]!
      const sceneText = acceptedTextByScene(String(commit.sceneId))
      const bindings = report?.changeBindings ?? []
      const changes = commit.stateDelta.changes
      return Boolean(report) && hashText(sceneText) === report!.sceneContentHash && report!.sceneCharCount === Array.from(sceneText).length && report!.acceptedSegments?.length >= 1 && bindings.length === changes.length && bindings.every((binding) => {
        const change = changes.find((item) => item.changeId === binding.changeId)
        return Boolean(change) && binding.acceptedSegmentId === change!.acceptedSegmentId && binding.acceptedContentHash === change!.acceptedContentHash && binding.sceneContentHash === report!.sceneContentHash && binding.acceptedSegmentIds.length === report!.acceptedSegments!.length
      })
    }) && commits.every((commit) => commit.stateDelta.changes.every((change) => change.acceptedSegmentId && change.acceptedContentHash && change.contractHash)), JSON.stringify(commits.map((commit) => ({ sceneId: commit.sceneId, acceptedSegmentId: commit.acceptedSegmentId, acceptedContentHash: commit.acceptedContentHash }))))

    const nextContract = plan.contracts[1]!
    const allAccepted = acceptedRows.map((row) => ({
      segmentId: String(row.segment_id),
      runId,
      sceneId: String(row.scene_id),
      content: String(row.content),
      contentHash: String(row.content_hash),
      contractHash: String(commits.find((commit) => commit.sceneId === row.scene_id)?.contractHash ?? nextContract.frozenHash),
      revision: Number(row.revision)
    }))
    const nextContext = buildNarrativeContextManifest({
      runId,
      contract: nextContract,
      ledger,
      recentProse: allAccepted,
      acceptedPrefixHash: hashText(acceptedRows.map((row) => String(row.content)).join('')),
      // This assertion is about cross-scene state visibility, not the
      // optional-context truncation policy.  Leave enough budget for the
      // frozen contract's structured semantic fields plus all six state
      // projections, then let the dedicated P3/P4 checks cover truncation.
      budget: { maxChars: 50000, maxTokens: 20000 }
    })
    validateNarrativeContextManifest(nextContext)
    const contextWire = JSON.stringify(nextContext)
    const registeredKnowledgeFactId = String(knowledgeChanges[0]?.factId ?? '')
    const recentProseSection = nextContext.sections.find((section) => section.section === 'recent_prose')
    const hasAcceptedSegmentSource = Boolean(recentProseSection?.items.some((item) => item.provenance.some((provenance) => provenance.sourceType === 'accepted_segment')))
    check('P1-2 下一 scene 可读回上一 scene 的结构化状态/正文来源', nextContext.sceneId === nextContract.sceneId && nextContext.sections.some((section) => section.section === 'knowledge' && section.includedCount > 0) && nextContext.sections.some((section) => section.section === 'world_state' && section.includedCount > 0) && registeredKnowledgeFactId.length > 0 && contextWire.includes(registeredKnowledgeFactId) && hasAcceptedSegmentSource, `scene=${nextContext.sceneId} sections=${nextContext.sections.map((section) => `${section.section}:${section.includedCount}`).join(',')} acceptedSource=${hasAcceptedSegmentSource}`)

    const pendingInput: NarrativeStateExtractionInput = {
      runId: 'p1-2-pending',
      sceneId: String(plan.contracts[0]!.sceneId),
      contract: plan.contracts[0]!,
      decision: {
        schemaVersion: 1,
        decisionId: 'pending',
        sceneId: String(plan.contracts[0]!.sceneId),
        contractId: plan.contracts[0]!.contractId,
        contractHash: plan.contracts[0]!.frozenHash,
        candidateSegmentId: 'pending-segment',
        candidateHash: hashText('accepted'),
        candidateCharCount: 8,
        status: 'complete',
        requiredBeatIds: [],
        satisfiedBeatIds: [],
        missingBeatIds: [],
        evidenceHash: hashText('decision'),
        decidedAt: Date.now(),
        scenePrefixHash: hashText('')
      },
      candidateSegmentId: 'pending-segment',
      candidateContentHash: hashText('accepted'),
      acceptedSegments: [{ segmentId: 'pending-segment', content: 'accepted。', contentHash: hashText('accepted。'), charCount: 9, chunkIndex: 1, revision: 1 }],
      confirmedAnswers: [{ slotId: 'mustKeep', source: 'user', value: 'narrative-fact: {not-json}' }]
    }
    const pending = extractNarrativeStateDelta(pendingInput)
    check('P1-2 无法解析的结构化事实落 pending_review，不伪造空 delta', pending.status === 'pending_review' && pending.delta === null && pending.report.pendingReasons.some((reason) => reason.includes('confirmed_fact_json_invalid')), JSON.stringify(pending.report))

    const firstCommit = commits[0]!
    const firstAccepted = acceptedRows.find((row) => row.segment_id === firstCommit.acceptedSegmentId)
    const firstDecisionEvidence = repo.getRunEvidence(runId, `scene_completion_decision:${String(firstCommit.acceptedSegmentId)}`)
    const firstDecisionPayload = firstDecisionEvidence ? JSON.parse(firstDecisionEvidence.json) as { decision?: Record<string, unknown> } : null
    const missingRegistry = firstAccepted && firstDecisionPayload?.decision
      ? extractNarrativeStateDelta({
          runId: 'p1-2-missing-fact-registry',
          sceneId: String(firstCommit.sceneId),
          contract: plan.contracts[0]!,
          decision: firstDecisionPayload.decision as NarrativeStateExtractionInput['decision'],
          candidateSegmentId: String(firstAccepted.segment_id),
          candidateContentHash: String(firstAccepted.content_hash),
          acceptedSegments: [{
            segmentId: String(firstAccepted.segment_id),
            content: String(firstAccepted.content),
            contentHash: String(firstAccepted.content_hash),
            charCount: Number(firstAccepted.char_count),
            chunkIndex: Number(firstAccepted.chunk_index),
            revision: Number(firstAccepted.revision)
          }],
          confirmedAnswers: [{
            slotId: 'mustKeep',
            source: 'user',
            value: JSON.stringify({ facts: [{ kind: 'knowledge', entityId: 'missing-fact', factId: 'not-registered', knowerId: '林舟', stance: 'knows', certainty: 0.8, confidence: 0.8, evidenceTerms: ['林舟', '真相'] }] })
          }],
          confirmedFacts: []
        })
      : null
    check('P1-2 knowledge 找不到 Fact Registry 时 pending_review，不写 bare factId', missingRegistry?.status === 'pending_review' && missingRegistry.delta === null && missingRegistry.report.pendingReasons.some((reason) => reason.includes('confirmed_fact_registry_reference_missing')), JSON.stringify(missingRegistry?.report ?? { reason: 'missing first decision evidence' }))

    // The production boundary must pause for review, not turn an unresolved
    // state projection into a terminal run failure. Drive the real engine with
    // an otherwise complete scene and a malformed confirmed fact marker.
    const pendingRunId = 'p1-2-engine-pending-run'
    const pendingSessionId = 'p1-2-engine-pending-session'
    const pendingConfig = buildExecutionSnapshot({
      payload: {
        id: pendingRunId,
        mode: 'longwrite',
        workspace: 'novel',
        phase: 'execute',
        longMode: true,
        targetChars: 360,
        text: '请依据已确认大纲完成当前场景。',
        grillMe: {
          stateId: 'p1-2-engine-pending-grill-state',
          originalTask: '写一篇雾港灯塔交接小说。',
          targetChars: 360,
          answers: [
            { slotId: 'goal', value: '完成灯塔交接', source: 'user' },
            { slotId: 'characters', value: '林舟、沈遥', source: 'user' },
            { slotId: 'mustKeep', value: 'narrative-fact: {not-json}', source: 'user' }
          ],
          assumptions: [],
          approvedOutline: outline,
          outlineRevision: 1,
          outlineHash
        },
        strongConstraints: { enabled: false }
      },
      settings,
      sessionId: pendingSessionId,
      memory: { projectPath: '', projectContent: '', userContent: '' }
    })
    const pendingText = exactProse(360, '林舟抵达灯塔，林舟把钥匙交给沈遥。', 5000)
    const pendingEngine = createAgentRunEngine({
      store,
      modelCall: async () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<{ type: 'text' | 'finish'; delta?: string; finishReason?: 'stop' }> {
          yield { type: 'text', delta: pendingText }
          yield { type: 'finish', finishReason: 'stop' }
        }
      }),
      toolExecutor: async () => '',
      getConfig: () => pendingConfig,
      onEvent: () => undefined,
      onRunUpdate: () => undefined,
      publishLongwriteArtifact: async () => ({ displayName: 'p1-2-pending.md', relativePath: 'p1-2-pending.md' })
    })
    const pendingStarted = await pendingEngine.start({ sessionId: pendingSessionId, runId: pendingRunId, config: pendingConfig })
    let pendingEngineThrew = false
    try {
      await pendingEngine.step(pendingRunId)
    } catch {
      pendingEngineThrew = true
    }
    const pendingEngineState = await pendingEngine.getState(pendingRunId)
    const pendingEngineEvidence = repo.getRunEvidence(pendingRunId, 'narrative_state_pending_review')
    check('P1-2 生产入口 pending_review 持久化并暂停 waiting_user，而非宣称 failed', pendingStarted.ok && pendingEngineThrew && pendingEngineState.run?.status === 'waiting_user' && pendingEngineState.run.phase === 'paused' && pendingEngineState.run.errorCode === 'narrative_state_pending_review' && pendingEngineEvidence !== null, JSON.stringify({ started: pendingStarted.ok, threw: pendingEngineThrew, run: pendingEngineState.run, evidence: Boolean(pendingEngineEvidence) }))
  } finally {
    repo.close()
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\nP1-2 narrative state: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('P1-2 narrative state 执行异常：', error)
  process.exitCode = 2
})
