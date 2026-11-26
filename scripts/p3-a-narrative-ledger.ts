import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildSceneContractPlan } from '../src/main/narrative/sceneContract'
import { buildNarrativeStateDelta, buildEmptyNarrativeStateDelta } from '../src/main/narrative/stateDelta'
import { createRepository, type ManuscriptSegmentRow, type Repository, type RunRow, type TurnRow } from '../src/main/db/repository'
import { CURRENT_SCHEMA_VERSION, openDb } from '../src/main/db/migrations'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import type { ManuscriptSegment, NarrativeStateChange, SceneCompletionDecision, SceneContract, SceneContractPlan } from '../src/shared/types'
import { buildSceneCompletionDecision } from '../src/main/narrative/sceneContract'
import { makeManuscriptSegment, manuscriptAcceptanceEvidenceIdentity, manuscriptSegmentHash } from '../src/main/manuscript'

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

function asRow(segment: ManuscriptSegment): ManuscriptSegmentRow {
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

function runRow(runId: string, sessionId: string): RunRow {
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

function turnRow(runId: string, turnId: string, seq: number, content: string): TurnRow {
  return {
    turn_id: turnId,
    run_id: runId,
    turn_seq: seq,
    role: 'assistant',
    content,
    reasoning_content: null,
    tool_calls_json: null,
    tool_result_json: null,
    plan_state: null,
    created_at: seq
  }
}

function makePlan(): SceneContractPlan {
  const outline: GrillMeOutline = {
    title: '雾港账本',
    premise: '守灯人抵达灯塔并完成交接。',
    targetChars: 800,
    sections: [{
      id: 'section-1',
      title: '雨夜交接',
      purpose: '守灯人抵达灯塔并完成交接。',
      targetChars: 800,
      beats: ['林舟抵达灯塔'],
      sourceSlotIds: ['goal']
    }]
  }
  const outlineHash = grillMeOutlineHash(outline)
  return buildSceneContractPlan({
    outline,
    outlineHash,
    outlineRevision: 1,
    answers: [{ slotId: 'goal', value: '完成灯塔交接', source: 'user' }],
    characterNames: ['林舟', '沈遥'],
    strongConstraints: { forbiddenTerms: [], mustKeep: [] }
  })
}

function changesFor(runId: string, sceneId: string, segment: ManuscriptSegment, contract: SceneContract): NarrativeStateChange[] {
  const base = (changeId: string, revision: number, kind: NarrativeStateChange['kind'], entityId: string) => ({
    changeId,
    revision,
    kind,
    entityId,
    runId,
    sceneId,
    acceptedSegmentId: segment.segmentId,
    acceptedContentHash: segment.contentHash,
    contractHash: contract.frozenHash
  })
  return [
    {
      ...base('event-1', 1, 'timeline_event', 'event-1'),
      kind: 'timeline_event',
      eventType: 'arrival',
      actorIds: ['char-lin'],
      objectIds: ['obj-key'],
      locationId: 'loc-lighthouse',
      storyTime: 'night-1',
      causeEventIds: [],
      consequenceEventIds: [],
      summary: '林舟抵达灯塔。'
    },
    {
      ...base('char-1', 2, 'character_state', 'char-lin'),
      kind: 'character_state',
      characterId: 'char-lin',
      status: 'alive',
      locationId: 'loc-lighthouse',
      goals: ['完成交接'],
      physicalState: '疲惫',
      emotionalBaseline: '警觉'
    },
    {
      ...base('obj-1', 3, 'object_state', 'obj-key'),
      kind: 'object_state',
      objectId: 'obj-key',
      ownerId: 'char-lin',
      holderId: 'char-lin',
      locationId: 'loc-lighthouse',
      condition: '完整'
    },
    {
      ...base('rel-1', 4, 'relationship', 'char-lin->char-yao'),
      kind: 'relationship',
      fromCharacterId: 'char-lin',
      toCharacterId: 'char-yao',
      dimension: 'trust',
      value: 0.6,
      reason: '完成钥匙交接'
    },
    {
      ...base('know-1', 5, 'knowledge', 'char-lin:fact-storm'),
      kind: 'knowledge',
      factId: 'fact-storm',
      knowerId: 'char-lin',
      stance: 'knows',
      certainty: 0.9,
      sourceSceneId: sceneId,
      effectiveTime: 'night-1',
      confidence: 0.95
    },
    {
      ...base('thread-1', 6, 'foreshadow', 'thread-storm'),
      kind: 'foreshadow',
      threadId: 'thread-storm',
      lifecycle: 'advanced',
      reason: '暴雨逼近',
      setupChangeId: 'event-1',
      payoffChangeId: null
    }
  ]
}

function prepareScene(repository: Repository, runId: string, sessionId: string, plan: SceneContractPlan, content: string, chunkIndex: number): { contract: SceneContract; segment: ManuscriptSegment; stateRevision: number } {
  const contract = plan.contracts[0]!
  repository.createRun(runRow(runId, sessionId))
  repository.ensureSceneStates(runId, plan, 10)
  repository.transitionSceneState({ runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: 1, from: 'planned', to: 'writing', at: 11 })
  const turnId = `${runId}-turn-1`
  repository.appendTurn(turnRow(runId, turnId, chunkIndex, content))
  const segment = makeManuscriptSegment({ runId, sessionId, turnId, chunkIndex, content, status: 'candidate', kind: 'prose', sceneId: contract.sceneId, sectionId: contract.sectionId, createdAt: 12, updatedAt: 12 })
  repository.saveManuscriptSegment(asRow(segment))
  const writing = repository.getSceneStates(runId)[0]!
  repository.transitionSceneState({ runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: writing.revision, from: 'writing', to: 'candidate', candidateSegmentId: segment.segmentId, candidateHash: segment.contentHash, at: 13 })
  const state = repository.getSceneStates(runId)[0]!
  return { contract, segment, stateRevision: state.revision }
}

function readyEvidence(repository: Repository, runId: string, scene: { contract: SceneContract; segment: ManuscriptSegment; stateRevision: number }, stateDelta: ReturnType<typeof buildNarrativeStateDelta>): SceneCommitInputLike {
  const decision = buildSceneCompletionDecision(scene.contract, scene.segment.content, { candidateSegmentId: scene.segment.segmentId, at: 14 })
  if (decision.status !== 'complete') throw new Error(`fixture decision unexpectedly ${decision.status}`)
  repository.saveRunEvidence(runId, `scene_completion_decision:${scene.segment.segmentId}`, JSON.stringify({
    schemaVersion: 1,
    runId,
    sceneId: scene.contract.sceneId,
    contractId: scene.contract.contractId,
    contractHash: scene.contract.frozenHash,
    candidateSegmentId: scene.segment.segmentId,
    candidateHash: scene.segment.contentHash,
    decision,
    stateDeltaHash: stateDelta.deltaHash,
    savedAt: 14
  }))
  const evidenceRefs: Record<string, string | null> = {}
  const evidenceIdentity = manuscriptAcceptanceEvidenceIdentity({
    runId,
    segmentId: scene.segment.segmentId,
    candidateHash: scene.segment.contentHash,
    candidateCharCount: scene.segment.charCount,
    evidenceRevision: scene.segment.revision,
    sceneId: scene.contract.sceneId,
    evidenceRefs
  })
  repository.saveRunEvidence(runId, 'manuscript_acceptance_ready', JSON.stringify({
    schemaVersion: 1,
    runId,
    segmentId: scene.segment.segmentId,
    candidateHash: scene.segment.contentHash,
    candidateCharCount: scene.segment.charCount,
    evidenceRevision: scene.segment.revision,
    evidenceIdentity,
    sceneId: scene.contract.sceneId,
    evidenceRefs,
    preparedAt: 14
  }))
  return {
    acceptance: {
      runId,
      segmentId: scene.segment.segmentId,
      expectedContentHash: scene.segment.contentHash,
      expectedCharCount: scene.segment.charCount,
      evidenceRevision: scene.segment.revision,
      evidenceIdentity,
      sceneId: scene.contract.sceneId,
      acceptedAt: 15
    },
    contractId: scene.contract.contractId,
    contractHash: scene.contract.frozenHash,
    expectedSceneRevision: scene.stateRevision,
    decision: JSON.parse((repository.getRunEvidence(runId, `scene_completion_decision:${scene.segment.segmentId}`)!).json).decision as SceneCompletionDecision,
    completionEvidenceHash: JSON.parse((repository.getRunEvidence(runId, `scene_completion_decision:${scene.segment.segmentId}`)!).json).decision.evidenceHash as string,
    stateDelta,
    committedAt: 15
  }
}

type SceneCommitInputLike = Parameters<Repository['commitScene']>[0]

async function main(): Promise<void> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p3-a-ledger-'))
  const dbPath = path.join(tempRoot, 'narrative.db')
  const plan = makePlan()
  const runId = 'p3-a-run'
  const sessionId = 'p3-a-session'
  let repository: Repository | null = null
  try {
    repository = createRepository(dbPath)
    const migrationProbe = openDb(dbPath)
    const migratedVersion = (migrationProbe.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    const migratedTables = (migrationProbe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('narrative_commits','narrative_ledger') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)
    migrationProbe.close()
    check('P3-A 当前 migration 建立 durable commit/ledger 表', migratedVersion === CURRENT_SCHEMA_VERSION && migratedTables.join(',') === 'narrative_commits,narrative_ledger', JSON.stringify({ migratedVersion, migratedTables }))
    repository.open()
    const scene = prepareScene(repository, runId, sessionId, plan, '林舟抵达灯塔，沈遥把钥匙交到他手里。', 1)
    const changes = changesFor(runId, scene.contract.sceneId, scene.segment, scene.contract)
    const delta = buildNarrativeStateDelta({ schemaVersion: 1, runId, sceneId: scene.contract.sceneId, acceptedSegmentId: scene.segment.segmentId, acceptedContentHash: scene.segment.contentHash, contractHash: scene.contract.frozenHash, changes })
    const commit = readyEvidence(repository, runId, scene, delta)
    repository.commitScene(commit)
    const accepted = repository.getManuscriptSegmentsByRun(runId).find((row) => row.segment_id === scene.segment.segmentId)
    const state = repository.getSceneStates(runId)[0]!
    const commits = repository.getNarrativeCommits(runId, scene.contract.sceneId)
    const ledger = repository.getNarrativeLedger(runId, scene.contract.sceneId)
    check('P3-A 账本覆盖六类结构化变化并绑定来源', state.lifecycle === 'committed' && accepted?.status === 'accepted' && ledger.length === 6 && new Set(ledger.map((item) => item.kind)).size === 6 && ledger.every((item) => item.runId === runId && item.sceneId === scene.contract.sceneId && item.acceptedSegmentId === scene.segment.segmentId && item.acceptedContentHash === scene.segment.contentHash && item.contractHash === scene.contract.frozenHash), JSON.stringify({ lifecycle: state.lifecycle, kinds: ledger.map((item) => item.kind) }))
    check('P3-A commit 记录保存可审计 delta hash 与 revision', commits.length === 1 && commits[0]?.deltaHash === delta.deltaHash && commits[0]?.stateDelta.changes.length === 6 && commits[0]?.revision === state.revision, JSON.stringify(commits))
    repository.commitScene(commit)
    check('P3-A 同一 Scene Commit 重放幂等且不重复', repository.getNarrativeCommits(runId, scene.contract.sceneId).length === 1 && repository.getNarrativeLedger(runId, scene.contract.sceneId).length === 6 && repository.getManuscriptSegmentsByRun(runId).filter((row) => row.status === 'accepted').length === 1)
    const conflictDelta = buildEmptyNarrativeStateDelta({ runId, sceneId: scene.contract.sceneId, acceptedSegmentId: scene.segment.segmentId, acceptedContentHash: scene.segment.contentHash, contractHash: scene.contract.frozenHash })
    let conflictRejected = false
    try { repository.commitScene({ ...commit, stateDelta: conflictDelta }) } catch { conflictRejected = true }
    check('P3-A 冲突重放 fail-closed 且保留原账本', conflictRejected && repository.getNarrativeCommits(runId, scene.contract.sceneId)[0]?.deltaHash === delta.deltaHash && repository.getNarrativeLedger(runId, scene.contract.sceneId).length === 6)

    let failAfterLedger = true
    const hooked = createRepository(dbPath, { afterNarrativeLedgerInsert: () => { if (failAfterLedger) throw new Error('p3_a_fault_after_ledger') } })
    hooked.open()
    const rollbackRun = 'p3-a-rollback'
    const rollbackSession = 'p3-a-rollback-session'
    const rollbackScene = prepareScene(hooked, rollbackRun, rollbackSession, plan, '林舟抵达灯塔并看见风暴。', 1)
    const rollbackDelta = buildNarrativeStateDelta({ schemaVersion: 1, runId: rollbackRun, sceneId: rollbackScene.contract.sceneId, acceptedSegmentId: rollbackScene.segment.segmentId, acceptedContentHash: rollbackScene.segment.contentHash, contractHash: rollbackScene.contract.frozenHash, changes: changesFor(rollbackRun, rollbackScene.contract.sceneId, rollbackScene.segment, rollbackScene.contract).slice(0, 1) })
    const rollbackCommit = readyEvidence(hooked, rollbackRun, rollbackScene, rollbackDelta)
    let rolledBack = false
    try { hooked.commitScene(rollbackCommit) } catch { rolledBack = true }
    const rollbackRow = hooked.getManuscriptSegmentsByRun(rollbackRun).find((row) => row.segment_id === rollbackScene.segment.segmentId)
    check('P3-A 账本写入故障回滚正文接纳、scene 与 ledger', rolledBack && rollbackRow?.status === 'candidate' && hooked.getSceneStates(rollbackRun)[0]?.lifecycle === 'candidate' && hooked.getNarrativeCommits(rollbackRun).length === 0 && hooked.getNarrativeLedger(rollbackRun).length === 0)
    failAfterLedger = false
    hooked.commitScene(rollbackCommit)
    check('P3-A 回滚后重试可完整提交', hooked.getManuscriptSegmentsByRun(rollbackRun).find((row) => row.segment_id === rollbackScene.segment.segmentId)?.status === 'accepted' && hooked.getNarrativeLedger(rollbackRun).length === 1)
    hooked.close()

    const emptyRun = 'p3-a-empty'
    const emptySession = 'p3-a-empty-session'
    const emptyScene = prepareScene(repository, emptyRun, emptySession, plan, '林舟抵达灯塔。', 1)
    const emptyDelta = buildEmptyNarrativeStateDelta({ runId: emptyRun, sceneId: emptyScene.contract.sceneId, acceptedSegmentId: emptyScene.segment.segmentId, acceptedContentHash: emptyScene.segment.contentHash, contractHash: emptyScene.contract.frozenHash })
    const emptyCommit = readyEvidence(repository, emptyRun, emptyScene, emptyDelta)
    repository.commitScene(emptyCommit)
    const emptyRecord = repository.getNarrativeCommits(emptyRun, emptyScene.contract.sceneId)[0]
    check('P3-A 无可靠 extractor 时提交 empty-but-evidence-bound delta', emptyRecord?.stateDelta.changes.length === 0 && emptyRecord.deltaHash === emptyDelta.deltaHash && repository.getNarrativeLedger(emptyRun, emptyScene.contract.sceneId).length === 0)
    repository.close()
    const reopened = createRepository(dbPath)
    reopened.open()
    const readBack = reopened.getNarrativeCommits(runId, scene.contract.sceneId)
    const readLedger = reopened.getNarrativeLedger(runId, scene.contract.sceneId)
    check('P3-A 重启后按 run/scene 确定顺序读回账本', readBack.length === 1 && readBack[0]?.deltaHash === delta.deltaHash && readLedger.map((item) => item.changeId).join(',') === ['event-1', 'char-1', 'obj-1', 'rel-1', 'know-1', 'thread-1'].join(','))
    reopened.close()
  } finally {
    repository?.close()
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nP3-A narrative ledger: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('P3-A narrative ledger 执行异常：', error)
  process.exitCode = 2
})
