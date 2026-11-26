import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { buildSceneContractPlan } from '../src/main/narrative/sceneContract'
import { buildNarrativeStateDelta } from '../src/main/narrative/stateDelta'
import {
  buildNarrativeContextManifest,
  buildNarrativeContextManifestFromStore,
  materializeNarrativeState,
  validateNarrativeContextManifest,
  type NarrativeContextManifest,
  type NarrativeContextRecentProse
} from '../src/main/narrative/narrativeContext'
import { createRepository, type ManuscriptSegmentRow, type Repository, type RunRow, type TurnRow } from '../src/main/db/repository'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import type { ManuscriptSegment, NarrativeLedgerEntry, NarrativeStateChange, SceneContract, SceneContractPlan } from '../src/shared/types'
import { buildSceneCompletionDecision } from '../src/main/narrative/sceneContract'
import { makeManuscriptSegment, manuscriptAcceptanceEvidenceIdentity } from '../src/main/manuscript'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
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

function turnRow(runId: string, turnId: string, content: string): TurnRow {
  return {
    turn_id: turnId,
    run_id: runId,
    turn_seq: 1,
    role: 'assistant',
    content,
    reasoning_content: null,
    tool_calls_json: null,
    tool_result_json: null,
    plan_state: null,
    created_at: 2
  }
}

function makePlan(): SceneContractPlan {
  const outline: GrillMeOutline = {
    title: '雾港账本',
    premise: '守灯人抵达灯塔并完成交接。',
    targetChars: 360,
    sections: [{
      id: 'section-1',
      title: '雨夜交接',
      purpose: '守灯人抵达灯塔并完成交接。',
      targetChars: 360,
      beats: ['林舟抵达灯塔'],
      sourceSlotIds: ['goal'],
      scenes: [{ id: 'arrival', title: '抵达', purpose: '林舟抵达灯塔。', targetChars: 360, beats: ['林舟抵达灯塔'], sourceSlotIds: ['goal'] }]
    }]
  }
  const outlineHash = grillMeOutlineHash(outline)
  return buildSceneContractPlan({
    outline,
    outlineHash,
    outlineRevision: 3,
    answers: [{ slotId: 'goal', value: '完成灯塔交接', source: 'user' }],
    characterNames: ['林舟', '沈遥'],
    strongConstraints: { forbiddenTerms: [], mustKeep: [] }
  })
}

function baseChange(runId: string, sceneId: string, segmentId: string, contentHash: string, contractHash: string, changeId: string, revision: number, kind: NarrativeStateChange['kind'], entityId: string): Record<string, unknown> {
  return { changeId, revision, kind, entityId, runId, sceneId, acceptedSegmentId: segmentId, acceptedContentHash: contentHash, contractHash }
}

function makeLedger(runId: string, contract: SceneContract): NarrativeLedgerEntry[] {
  const segmentId = 'accepted-past-1'
  const acceptedContentHash = hashText('accepted-past-prose')
  const changes: NarrativeStateChange[] = [
    {
      ...baseChange(runId, 'scene:past', segmentId, acceptedContentHash, contract.frozenHash, 'event-arrival', 1, 'timeline_event', 'event-arrival'),
      kind: 'timeline_event', eventType: 'arrival', actorIds: ['林舟'], objectIds: ['钥匙'], locationId: '灯塔', storyTime: '夜一', causeEventIds: [], consequenceEventIds: ['event-storm'], summary: '林舟在远处的暴雨前抵达灯塔。'
    } as NarrativeStateChange,
    {
      ...baseChange(runId, 'scene:past', segmentId, acceptedContentHash, contract.frozenHash, 'char-lin-1', 2, 'character_state', '林舟'),
      kind: 'character_state', characterId: '林舟', status: 'alive', locationId: '灯塔', goals: ['完成交接'], physicalState: '疲惫', emotionalBaseline: '警觉'
    } as NarrativeStateChange,
    {
      ...baseChange(runId, 'scene:past', segmentId, acceptedContentHash, contract.frozenHash, 'object-key-1', 3, 'object_state', '钥匙'),
      kind: 'object_state', objectId: '钥匙', ownerId: '沈遥', holderId: '沈遥', locationId: '灯塔', condition: '完整'
    } as NarrativeStateChange,
    {
      ...baseChange(runId, 'scene:past', segmentId, acceptedContentHash, contract.frozenHash, 'relation-trust-1', 4, 'relationship', '林舟->沈遥'),
      kind: 'relationship', fromCharacterId: '林舟', toCharacterId: '沈遥', dimension: 'trust', value: 0.7, reason: '共同守过暴雨'
    } as NarrativeStateChange,
    {
      ...baseChange(runId, 'scene:past', segmentId, acceptedContentHash, contract.frozenHash, 'knowledge-storm-1', 5, 'knowledge', '林舟:暴雨'),
      kind: 'knowledge', factId: '暴雨', knowerId: '林舟', stance: 'knows', certainty: 0.9, sourceSceneId: 'scene:past', effectiveTime: '夜一', confidence: 0.95
    } as NarrativeStateChange,
    {
      ...baseChange(runId, 'scene:past', segmentId, acceptedContentHash, contract.frozenHash, 'thread-storm-open', 6, 'foreshadow', 'thread-storm'),
      kind: 'foreshadow', threadId: 'thread-storm', lifecycle: 'open', reason: '暴雨将至', setupChangeId: 'event-arrival', payoffChangeId: null
    } as NarrativeStateChange,
    {
      ...baseChange(runId, 'scene:later', segmentId, acceptedContentHash, contract.frozenHash, 'char-lin-2', 8, 'character_state', '林舟'),
      kind: 'character_state', characterId: '林舟', status: 'alive', locationId: '码头', goals: ['护送钥匙'], physicalState: '湿透', emotionalBaseline: '坚定'
    } as NarrativeStateChange,
    {
      ...baseChange(runId, 'scene:later', segmentId, acceptedContentHash, contract.frozenHash, 'thread-storm-close', 9, 'foreshadow', 'thread-storm'),
      kind: 'foreshadow', threadId: 'thread-storm', lifecycle: 'resolved', reason: '暴雨已被灯塔挡住', setupChangeId: 'event-arrival', payoffChangeId: 'event-storm'
    } as NarrativeStateChange,
    {
      ...baseChange(runId, 'scene:later', segmentId, acceptedContentHash, contract.frozenHash, 'event-storm', 10, 'timeline_event', 'event-storm'),
      kind: 'timeline_event', eventType: 'storm', actorIds: ['林舟'], objectIds: [], locationId: '码头', storyTime: '夜二', causeEventIds: ['event-arrival'], consequenceEventIds: [], summary: '远处的暴雨撞上码头。'
    } as NarrativeStateChange
  ]
  const delta = buildNarrativeStateDelta({ schemaVersion: 1, runId, sceneId: 'scene:past', acceptedSegmentId: segmentId, acceptedContentHash, contractHash: contract.frozenHash, changes })
  return delta.changes.map((change) => ({ ...change, deltaHash: delta.deltaHash, committedAt: change.revision }))
}

function recentProse(runId: string): NarrativeContextRecentProse[] {
  return Array.from({ length: 6 }, (_unused, index) => {
    const content = `第${index + 1}段已接受正文，林舟沿着潮湿石阶走向灯塔。`
    return { segmentId: `recent-${index + 1}`, runId, sceneId: `scene:past-${index + 1}`, content, contentHash: hashText(content), contractHash: hashText(`contract-${index + 1}`), revision: index + 1 }
  })
}

function prepareCommitted(repository: Repository, runId: string, sessionId: string, plan: SceneContractPlan): void {
  const contract = plan.contracts[0]!
  repository.createRun(runRow(runId, sessionId))
  repository.ensureSceneStates(runId, plan, 10)
  repository.transitionSceneState({ runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: 1, from: 'planned', to: 'writing', at: 11 })
  const content = '林舟抵达灯塔。'
  const turnId = `${runId}-turn-1`
  repository.appendTurn(turnRow(runId, turnId, content))
  const segment = makeManuscriptSegment({ runId, sessionId, turnId, chunkIndex: 1, content, status: 'candidate', kind: 'prose', sceneId: contract.sceneId, sectionId: contract.sectionId, createdAt: 12, updatedAt: 12 })
  repository.saveManuscriptSegment(asRow(segment))
  const writing = repository.getSceneStates(runId)[0]!
  repository.transitionSceneState({ runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: writing.revision, from: 'writing', to: 'candidate', candidateSegmentId: segment.segmentId, candidateHash: segment.contentHash, at: 13 })
  const decision = buildSceneCompletionDecision(contract, content, { candidateSegmentId: segment.segmentId, at: 14 })
  if (decision.status !== 'complete') throw new Error('p3_b_fixture_scene_not_complete')
  const acceptedDelta = buildNarrativeStateDelta({
    schemaVersion: 1,
    runId,
    sceneId: contract.sceneId,
    acceptedSegmentId: segment.segmentId,
    acceptedContentHash: segment.contentHash,
    contractHash: contract.frozenHash,
    changes: [{
      changeId: 'restart-event', revision: 1, kind: 'timeline_event', entityId: 'restart-event', runId, sceneId: contract.sceneId,
      acceptedSegmentId: segment.segmentId, acceptedContentHash: segment.contentHash, contractHash: contract.frozenHash,
      eventType: 'arrival', actorIds: ['林舟'], objectIds: [], locationId: '灯塔', storyTime: null, causeEventIds: [], consequenceEventIds: [], summary: '林舟抵达灯塔。'
    }]
  })
  repository.saveRunEvidence(runId, `scene_completion_decision:${segment.segmentId}`, JSON.stringify({ schemaVersion: 1, runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, candidateSegmentId: segment.segmentId, candidateHash: segment.contentHash, decision, stateDeltaHash: acceptedDelta.deltaHash, savedAt: 14 }))
  const evidenceRefs: Record<string, string | null> = {}
  const evidenceIdentity = manuscriptAcceptanceEvidenceIdentity({ runId, segmentId: segment.segmentId, candidateHash: segment.contentHash, candidateCharCount: segment.charCount, evidenceRevision: segment.revision, sceneId: contract.sceneId, evidenceRefs })
  repository.saveRunEvidence(runId, 'manuscript_acceptance_ready', JSON.stringify({ schemaVersion: 1, runId, segmentId: segment.segmentId, candidateHash: segment.contentHash, candidateCharCount: segment.charCount, evidenceRevision: segment.revision, evidenceIdentity, sceneId: contract.sceneId, evidenceRefs, preparedAt: 14 }))
  repository.commitScene({
    acceptance: { runId, segmentId: segment.segmentId, expectedContentHash: segment.contentHash, expectedCharCount: segment.charCount, evidenceRevision: segment.revision, evidenceIdentity, sceneId: contract.sceneId, acceptedAt: 15 },
    contractId: contract.contractId, contractHash: contract.frozenHash, expectedSceneRevision: repository.getSceneStates(runId)[0]!.revision, decision, completionEvidenceHash: decision.evidenceHash, stateDelta: acceptedDelta, committedAt: 15
  })
}

async function main(): Promise<void> {
  const runId = 'p3-b-run'
  const plan = makePlan()
  const contract = plan.contracts[0]!
  const ledger = makeLedger(runId, contract)
  const manifest = buildNarrativeContextManifest({ runId, contract, ledger, recentProse: recentProse(runId), acceptedPrefixHash: hashText('accepted-prefix'), budget: { maxChars: 12000, maxTokens: 6000 } })
  const materialized = materializeNarrativeState(runId, ledger)
  check('P3-B 账本物化保留远距人物/知识/物品/关系/时间线来源', materialized.characters.length === 1 && materialized.characters[0]?.data.locationId === '码头' && materialized.knowledge[0]?.provenance[0]?.sceneId === 'scene:past' && materialized.objects.length === 1 && materialized.relationships.length === 1 && materialized.timeline.length === 2, JSON.stringify(materialized))
  check('P3-B 伏笔只注入最新开放生命周期', manifest.sections.find((section) => section.section === 'open_foreshadow')?.items.length === 0 && materialized.foreshadowing.length === 1 && materialized.foreshadowing[0]?.data.lifecycle === 'resolved')
  check('P3-B optimized 分区包含当前 SceneContract 与结构化 provenance', manifest.sections.map((section) => section.section).join(',') === 'recent_prose,current_scene,active_characters,knowledge,open_foreshadow,recent_events,world_state' && manifest.sections.find((section) => section.section === 'current_scene')?.items[0]?.provenance[0]?.sourceType === 'scene_contract' && manifest.sections.find((section) => section.section === 'knowledge')?.items[0]?.provenance[0]?.sourceType === 'ledger')
  check('P3-B manifest hash 可复算且预算/省略计数一致', validateManifestNoThrow(manifest) && manifest.sections.every((section) => section.candidateCount === section.includedCount + section.omittedCount) && manifest.sections.reduce((sum, section) => sum + section.usedChars, 0) <= manifest.budget.maxChars)
  const budgeted = buildNarrativeContextManifest({ runId, contract, ledger, recentProse: recentProse(runId), budget: { maxChars: 1800, maxTokens: 480 } })
  check('P3-B 明确 char/token 预算裁剪并报告 omitted counts', budgeted.sections.some((section) => section.omittedCount > 0) && budgeted.sections.reduce((sum, section) => sum + section.usedChars, 0) <= 1800 && budgeted.sections.reduce((sum, section) => sum + section.usedTokens, 0) <= 480)
  const deterministic = buildNarrativeContextManifest({ runId, contract, ledger: [...ledger].reverse(), recentProse: [...recentProse(runId)].reverse(), acceptedPrefixHash: hashText('accepted-prefix'), budget: { maxChars: 12000, maxTokens: 6000 } })
  check('P3-B 输入顺序扰动不改变确定性 manifest hash', deterministic.manifestHash === manifest.manifestHash && JSON.stringify(deterministic) === JSON.stringify(manifest))
  const tampered = JSON.parse(JSON.stringify(manifest)) as NarrativeContextManifest
  const knowledgeSection = tampered.sections.find((section) => section.section === 'knowledge')!
  if (knowledgeSection.items[0]) knowledgeSection.items[0].data.factId = '伪造事实'
  let tamperRejected = false
  try { validateNarrativeContextManifest(tampered) } catch { tamperRejected = true }
  check('P3-B 篡改结构化事实或 provenance 时 fail-closed', tamperRejected)
  const empty = buildNarrativeContextManifest({ runId: 'p3-b-empty', contract, ledger: [], budget: { maxChars: 5000, maxTokens: 2000 } })
  check('P3-B 空账本保持为空，不创造状态', empty.materializedRevision === 0 && empty.sections.find((section) => section.section === 'active_characters')?.items.length === 0 && empty.sections.find((section) => section.section === 'knowledge')?.items.length === 0 && validateManifestNoThrow(empty))
  let conflictRejected = false
  try {
    materializeNarrativeState(runId, [...ledger, { ...ledger.find((item) => item.kind === 'character_state')!, changeId: 'conflict', acceptedSegmentId: 'other-segment', acceptedContentHash: hashText('other'), deltaHash: hashText('other-delta') }])
  } catch { conflictRejected = true }
  check('P3-B 同一实体同 revision 竞争来源不选一边而是拒绝', conflictRejected)

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p3-b-context-'))
  const dbPath = path.join(tempRoot, 'narrative.db')
  let repository: Repository | null = null
  try {
    repository = createRepository(dbPath)
    repository.open()
    prepareCommitted(repository, 'p3-b-restart', 'p3-b-session', plan)
    repository.close()
    const reopened = createRepository(dbPath)
    reopened.open()
    const readBack = await buildNarrativeContextManifestFromStore({ store: reopened, runId: 'p3-b-restart', contract, budget: { maxChars: 9000, maxTokens: 4000 } })
    check('P3-B SQLite 重启后从 durable ledger 生成同一结构化状态', readBack.materializedRevision === 1 && readBack.sections.find((section) => section.section === 'recent_events')?.items[0]?.provenance[0]?.acceptedSegmentId === 'p3-b-restart:p3-b-restart-turn-1', JSON.stringify(readBack))
    reopened.close()
  } finally {
    repository?.close()
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nP3-B narrative context: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

function validateManifestNoThrow(manifest: NarrativeContextManifest): boolean {
  try { validateNarrativeContextManifest(manifest); return true } catch { return false }
}

main().catch((error) => {
  console.error('P3-B narrative context 执行异常：', error)
  process.exitCode = 2
})
