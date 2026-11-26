import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildSceneContractPlan, buildSceneCompletionDecision } from '../src/main/narrative/sceneContract'
import { buildNarrativeStateDelta } from '../src/main/narrative/stateDelta'
import { createRepository, type ManuscriptSegmentRow, type Repository, type RunRow, type TurnRow } from '../src/main/db/repository'
import { manuscriptAcceptanceEvidenceIdentity, makeManuscriptSegment } from '../src/main/manuscript'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import type { ManuscriptSegment, NarrativeLedgerScopeInput, NarrativeStateChange, SceneContractPlan, SceneContract, SceneCommitInput } from '../src/shared/types'
import { codePointLength } from '../src/shared/textMetrics'
import { buildNarrativeContextManifest, validateNarrativeContextManifest } from '../src/main/narrative/narrativeContext'

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

function row(segment: ManuscriptSegment): ManuscriptSegmentRow {
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

function runRow(runId: string, sessionId: string, scope: NarrativeLedgerScopeInput): RunRow {
  return {
    run_id: runId,
    session_id: sessionId,
    status: 'running',
    phase: 'writing',
    started_at: Date.now(),
    updated_at: Date.now(),
    config_json: JSON.stringify({ storyScope: scope }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: null
  }
}

function plan(purpose = '林舟把钥匙交给沈遥。'): SceneContractPlan {
  const outline: GrillMeOutline = {
    title: '跨轮交接',
    premise: '林舟与沈遥在灯塔交接钥匙。',
    targetChars: 800,
    sections: [{
      id: 'section-1',
      title: '交接',
      purpose,
      targetChars: 800,
      // This fixture isolates ledger lineage.  Scene beat semantics are
      // covered by the dedicated P1-3/R62 checks; an empty beat list keeps the
      // three-run handover/question/return sequence from being reinterpreted
      // by the natural-language beat parser.
      beats: [],
      sourceSlotIds: ['goal']
    }]
  }
  return buildSceneContractPlan({
    outline,
    outlineHash: grillMeOutlineHash(outline),
    outlineRevision: 1,
    answers: [{ slotId: 'goal', value: '交接钥匙', source: 'user' }],
    characterNames: ['林舟', '沈遥'],
    strongConstraints: { forbiddenTerms: [], mustKeep: [] }
  })
}

function baseChange(runId: string, contract: SceneContract, segment: ManuscriptSegment, changeId: string): NarrativeStateChange {
  return {
    changeId,
    revision: 1,
    kind: 'object_state',
    entityId: '钥匙',
    runId,
    sceneId: contract.sceneId,
    acceptedSegmentId: segment.segmentId,
    acceptedContentHash: segment.contentHash,
    contractHash: contract.frozenHash,
    objectId: '钥匙',
    ownerId: null,
    holderId: null,
    locationId: '灯塔',
    condition: 'present'
  }
}

function prepare(repository: Repository, runId: string, sessionId: string, scope: NarrativeLedgerScopeInput, scenePlan: SceneContractPlan, content: string, changeId: string, holderId: string): { commit: SceneCommitInput; contract: SceneContract; segment: ManuscriptSegment } {
  repository.createRun(runRow(runId, sessionId, scope))
  repository.ensureSceneStates(runId, scenePlan, 10)
  const contract = scenePlan.contracts[0]!
  repository.transitionSceneState({ runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: 1, from: 'planned', to: 'writing', at: 11 })
  const segment = makeManuscriptSegment({ runId, sessionId, turnId: `${runId}-turn`, chunkIndex: 1, content, status: 'candidate', kind: 'prose', sceneId: contract.sceneId, sectionId: contract.sectionId, createdAt: 12, updatedAt: 12 })
  const turn: TurnRow = {
    turn_id: segment.sourceTurnId!,
    run_id: runId,
    turn_seq: 1,
    role: 'assistant',
    content,
    reasoning_content: null,
    tool_calls_json: null,
    tool_call_id: null,
    tool_result_json: null,
    plan_state: null,
    created_at: 12
  }
  repository.appendTurn(turn)
  repository.saveManuscriptSegment(row(segment))
  const writing = repository.getSceneStates(runId)[0]!
  repository.transitionSceneState({ runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: writing.revision, from: 'writing', to: 'candidate', candidateSegmentId: segment.segmentId, candidateHash: segment.contentHash, at: 13 })
  const change = baseChange(runId, contract, segment, changeId)
  ;(change as Extract<NarrativeStateChange, { kind: 'object_state' }>).holderId = holderId
  const stateDelta = buildNarrativeStateDelta({ schemaVersion: 1, runId, sceneId: contract.sceneId, acceptedSegmentId: segment.segmentId, acceptedContentHash: segment.contentHash, contractHash: contract.frozenHash, changes: [change] })
  const decision = buildSceneCompletionDecision(contract, content, { candidateSegmentId: segment.segmentId, at: 14 })
  if (decision.status !== 'complete') throw new Error(`story ledger fixture decision ${decision.status}: ${JSON.stringify({ contract, decision })}`)
  repository.saveRunEvidence(runId, `scene_completion_decision:${segment.segmentId}`, JSON.stringify({ schemaVersion: 1, runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, candidateSegmentId: segment.segmentId, candidateHash: segment.contentHash, decision, stateDeltaHash: stateDelta.deltaHash, savedAt: 14 }))
  const evidenceIdentity = manuscriptAcceptanceEvidenceIdentity({ runId, segmentId: segment.segmentId, candidateHash: segment.contentHash, candidateCharCount: segment.charCount, evidenceRevision: segment.revision, sceneId: contract.sceneId, evidenceRefs: {} })
  repository.saveRunEvidence(runId, 'manuscript_acceptance_ready', JSON.stringify({ schemaVersion: 1, runId, segmentId: segment.segmentId, candidateHash: segment.contentHash, candidateCharCount: segment.charCount, evidenceRevision: segment.revision, evidenceIdentity, sceneId: contract.sceneId, evidenceRefs: {}, preparedAt: 14 }))
  const state = repository.getSceneStates(runId)[0]!
  return {
    contract,
    segment,
    commit: {
      acceptance: { runId, segmentId: segment.segmentId, expectedContentHash: segment.contentHash, expectedCharCount: segment.charCount, evidenceRevision: segment.revision, evidenceIdentity, sceneId: contract.sceneId, acceptedAt: 15 },
      contractId: contract.contractId,
      contractHash: contract.frozenHash,
      expectedSceneRevision: state.revision,
      decision,
      completionEvidenceHash: decision.evidenceHash,
      stateDelta,
      committedAt: 15
    }
  }
}

async function main(): Promise<void> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p1-4-story-ledger-'))
  const dbPath = path.join(tempRoot, 'story.db')
  const sessionId = 'story-ledger-session'
  const story: NarrativeLedgerScopeInput = { schemaVersion: 1, storyId: 'story-ledger', projectId: 'project-ledger', branchId: 'main' }
    const firstPlan = plan('林舟把钥匙交给沈遥。')
    const questionPlan = plan('林舟把钥匙交给沈遥。沈遥询问持有人。')
    const returnPlan = plan('沈遥将钥匙归还林舟。')
  let repository: Repository | null = null
  try {
    repository = createRepository(dbPath)
    repository.open()
    const first = prepare(repository, 'story-run-1', sessionId, story, firstPlan, '林舟把钥匙交给沈遥。', 'handover-1', '沈遥')
    repository.commitScene(first.commit)
    const second = prepare(repository, 'story-run-2', sessionId, { ...story, parentRevision: 1 }, questionPlan, '林舟把钥匙交给沈遥。沈遥询问持有人。', 'handover-2', '沈遥')
    repository.commitScene(second.commit)
    const third = prepare(repository, 'story-run-3', sessionId, { ...story, parentRevision: 2 }, returnPlan, '沈遥将钥匙归还林舟。', 'handover-3', '林舟')
    repository.commitScene(third.commit)
    const ledger = repository.getNarrativeLedger('story-run-3')
    const info = repository.getNarrativeLedgerScope('story-run-3')
    const holders = ledger.filter((entry) => entry.kind === 'object_state').map((entry) => entry.holderId)
    check('三 run 同 session 按 committed parent 串联', ledger.length === 3 && holders.join(',') === '沈遥,沈遥,林舟', JSON.stringify({ holders, info }))
    check('run 仅 provenance，story revision 独立递增', ledger.every((entry, index) => entry.storyId === story.storyId && entry.projectId === story.projectId && entry.branchId === story.branchId && entry.storyRevision === index + 1 && entry.runId === `story-run-${index + 1}`))
    if (!info) throw new Error('story ledger scope missing')
    const context = buildNarrativeContextManifest({ runId: 'story-run-3', sessionId, contract: third.contract, ledger, storyScope: info, storyRevision: info.currentRevision, storyHighWatermark: info.highWatermark, acceptedPrefixHash: null, budget: { maxChars: 20000, maxTokens: 10000 } })
    validateNarrativeContextManifest(context)
    check('manifest 记录 story revision/high-watermark', context.storyRevision === 3 && context.storyHighWatermark === 3 && context.storyScope?.branchId === 'main')

    const branch = prepare(repository, 'story-run-branch', sessionId, { ...story, branchId: 'edit-1', parentBranchId: 'main', parentRevision: 1 }, firstPlan, '林舟把钥匙交给沈遥。分支编辑保留沈遥持有钥匙。', 'branch-1', '沈遥')
    repository.commitScene(branch.commit)
    const branchLedger = repository.getNarrativeLedger('story-run-branch')
    check('编辑旧 revision 只能进入显式分支', branchLedger.length === 2 && branchLedger.some((entry) => entry.runId === 'story-run-1') && branchLedger.some((entry) => entry.runId === 'story-run-branch') && !branchLedger.some((entry) => entry.runId === 'story-run-2'))
    let staleRejected = false
    try { repository.createRun(runRow('story-run-stale', sessionId, { ...story, parentRevision: 1 })) } catch (error) { staleRejected = error instanceof Error && error.message === 'story_ledger_parent_stale' }
    check('同 branch 旧 parent fail-closed', staleRejected)

    const concurrentA = prepare(repository, 'story-run-concurrent-a', sessionId, { ...story, parentRevision: 3 }, firstPlan, '林舟把钥匙交给沈遥。并发 A 继续持有钥匙。', 'concurrent-a', '林舟')
    const concurrentB = prepare(repository, 'story-run-concurrent-b', sessionId, { ...story, parentRevision: 3 }, firstPlan, '林舟把钥匙交给沈遥。并发 B 继续持有钥匙。', 'concurrent-b', '沈遥')
    repository.commitScene(concurrentA.commit)
    let concurrentRejected = false
    try { repository.commitScene(concurrentB.commit) } catch (error) { concurrentRejected = error instanceof Error && error.message === 'story_ledger_concurrent_head_conflict' }
    check('并发写入不盲混且后到者 fail-closed', concurrentRejected && repository.getNarrativeLedger('story-run-concurrent-b').length === 3)

    repository.close()
    const reopened = createRepository(dbPath)
    reopened.open()
    const afterRestart = reopened.getNarrativeLedger('story-run-3')
    const restartInfo = reopened.getNarrativeLedgerScope('story-run-3')
    check('重启后恢复同一 story ledger 游标', afterRestart.length === 3 && restartInfo?.currentRevision === 3 && afterRestart.at(-1)?.holderId === '林舟')
    reopened.close()
  } finally {
    repository?.close()
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nP1-4 story ledger: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('P1-4 story ledger 执行异常：', error)
  process.exitCode = 2
})
