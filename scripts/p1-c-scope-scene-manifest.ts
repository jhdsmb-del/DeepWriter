import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CURRENT_SCHEMA_VERSION, openDb, runMigrations } from '../src/main/db/migrations'
import { createRepository, type ManuscriptSegmentRow, type Repository, type RunRow } from '../src/main/db/repository'
import { buildSceneContractPlan, buildSceneCompletionDecision } from '../src/main/narrative/sceneContract'
import { buildEmptyNarrativeStateDelta, stableNarrativeJson } from '../src/main/narrative/stateDelta'
import { classifyAssistantOutput, legacyBackfillSourceSummaryHash, manuscriptAcceptanceEvidenceIdentity, manuscriptSegmentHash } from '../src/main/manuscript'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import type { ManuscriptSegment, SceneCommitManifest, SceneContract, SceneContractPlan } from '../src/shared/types'
import { codePointLength } from '../src/shared/textMetrics'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
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

function makeSegment(input: {
  runId: string
  sessionId: string
  segmentId: string
  sceneId: string
  chunkIndex: number
  revision: number
  content: string
  status: ManuscriptSegment['status']
}): ManuscriptSegment {
  const at = 100 + input.revision + input.chunkIndex
  const classified = classifyAssistantOutput(input.content)
  return {
    schemaVersion: 1,
    segmentId: input.segmentId,
    runId: input.runId,
    sessionId: input.sessionId,
    sectionId: 'section-1',
    sceneId: input.sceneId,
    chunkIndex: input.chunkIndex,
    revision: input.revision,
    status: input.status,
    kind: classified.kind === 'prose' ? 'prose' : 'meta',
    content: input.content,
    contentHash: manuscriptSegmentHash(input.content),
    charCount: codePointLength(input.content),
    createdAt: at,
    updatedAt: at,
    ...(input.status === 'accepted' ? { acceptedAt: at } : {})
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
    error_message: null,
    client_request_id: null
  }
}

function plan(): SceneContractPlan {
  const outline: GrillMeOutline = {
    title: '雾港账本',
    premise: '林舟抵达灯塔。',
    targetChars: 300,
    sections: [{ id: 'section-1', title: '雨夜', purpose: '林舟抵达灯塔。', targetChars: 300, beats: ['林舟抵达灯塔'], sourceSlotIds: [] }]
  }
  return buildSceneContractPlan({
    outline,
    outlineHash: grillMeOutlineHash(outline),
    outlineRevision: 1,
    answers: [],
    characterNames: ['林舟'],
    strongConstraints: { forbiddenTerms: [], mustKeep: [] }
  })
}

function prepareAcceptance(repository: Repository, segment: ManuscriptSegment, replacement?: string): void {
  const evidenceRefs: Record<string, string | null> = {}
  const evidenceIdentity = manuscriptAcceptanceEvidenceIdentity({
    runId: segment.runId,
    segmentId: segment.segmentId,
    candidateHash: segment.contentHash,
    candidateCharCount: segment.charCount,
    evidenceRevision: segment.revision,
    sceneId: segment.sceneId ?? null,
    evidenceRefs,
    supersedesAcceptedSegmentId: replacement
  })
  repository.saveRunEvidence(segment.runId, 'manuscript_acceptance_ready', JSON.stringify({
    schemaVersion: 1,
    runId: segment.runId,
    segmentId: segment.segmentId,
    candidateHash: segment.contentHash,
    candidateCharCount: segment.charCount,
    evidenceRevision: segment.revision,
    evidenceIdentity,
    sceneId: segment.sceneId ?? null,
    ...(replacement ? { supersedesAcceptedSegmentId: replacement } : {}),
    evidenceRefs,
    preparedAt: 200
  }))
  repository.acceptManuscriptSegment({
    runId: segment.runId,
    segmentId: segment.segmentId,
    expectedContentHash: segment.contentHash,
    expectedCharCount: segment.charCount,
    evidenceRevision: segment.revision,
    evidenceIdentity,
    sceneId: segment.sceneId ?? null,
    ...(replacement ? { supersedesAcceptedSegmentId: replacement } : {}),
    acceptedAt: 201
  })
}

function seedMigrationConflict(dbPath: string): void {
  const runId = 'migration-conflict-run'
  const sessionId = 'migration-conflict-session'
  const sceneId = 'migration-scene'
  const raw = new DatabaseSync(dbPath)
  runMigrations(raw, 19)
  raw.prepare('INSERT INTO sessions (session_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?)').run(sessionId, 'migration', 'fixture', 1, 1)
  raw.prepare('INSERT INTO runs (run_id,session_id,status,phase,started_at,updated_at,config_json,parent_run_id,error_code,error_message,client_request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(runId, sessionId, 'completed', 'completed', 1, 1, '{}', null, null, null, null)
  const insertTurn = raw.prepare('INSERT INTO turns (turn_id,run_id,turn_seq,role,content,reasoning_content,tool_calls_json,tool_result_json,plan_state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
  insertTurn.run('old:turn', runId, 1, 'assistant', '旧稿。', null, null, null, null, 1)
  insertTurn.run('new:turn', runId, 2, 'assistant', '新稿。', null, null, null, null, 2)
  raw.prepare(`INSERT INTO scene_states (run_id,scene_id,section_id,contract_id,contract_hash,scene_order,lifecycle,revision,candidate_segment_id,candidate_hash,accepted_segment_id,accepted_hash,completion_decision_json,completion_evidence_hash,created_at,updated_at,completed_at,committed_at) VALUES (?,?,?,?,?,?, 'accepted', 2, NULL,NULL,NULL,NULL,NULL,NULL,1,1,NULL,NULL)`).run(runId, sceneId, 'section-1', 'contract-1', 'a'.repeat(64), 1)
  const insert = raw.prepare(`INSERT INTO manuscript_segments (segment_id,run_id,session_id,source_turn_id,section_id,scene_id,chunk_index,revision,status,kind,content,content_hash,char_count,supersedes_segment_id,created_at,updated_at,accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (const [id, revision, content, acceptedAt] of [['old', 1, '旧稿。', 10], ['new', 2, '新稿。', 20]] as const) {
    insert.run(id, runId, sessionId, `${id}:turn`, 'section-1', sceneId, 1, revision, 'accepted', 'prose', content, manuscriptSegmentHash(content), codePointLength(content), null, acceptedAt, acceptedAt, acceptedAt)
  }
  raw.close()
}

function buildManifest(contract: SceneContract, runId: string, segments: ManuscriptSegment[], decision: ReturnType<typeof buildSceneCompletionDecision>, deltaHash: string): SceneCommitManifest {
  const ordered = [...segments].sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.segmentId.localeCompare(b.segmentId))
  const content = ordered.map((segment) => segment.content).join('')
  return {
    schemaVersion: 1,
    runId,
    sceneId: contract.sceneId,
    contractId: contract.contractId,
    contractHash: contract.frozenHash,
    acceptedSegments: ordered.map((segment) => ({ segmentId: segment.segmentId, contentHash: segment.contentHash, charCount: segment.charCount, chunkIndex: segment.chunkIndex, revision: segment.revision })),
    sceneContentHash: manuscriptSegmentHash(content),
    sceneCharCount: codePointLength(content),
    completionDecisionHash: manuscriptSegmentHash(stableNarrativeJson(decision)),
    stateDeltaHash: deltaHash
  }
}

async function main(): Promise<void> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dw-p1-c-'))
  try {
    const migrationDb = path.join(root, 'migration.sqlite')
    seedMigrationConflict(migrationDb)
    let migrated: ReturnType<typeof openDb> | null = null
    try {
      migrated = openDb(migrationDb)
      const accepted = migrated.prepare("SELECT segment_id FROM manuscript_segments WHERE run_id='migration-conflict-run' AND status='accepted' AND kind='prose'").all() as Array<{ segment_id: string }>
      const superseded = migrated.prepare("SELECT segment_id FROM manuscript_segments WHERE run_id='migration-conflict-run' AND status='superseded'").all() as Array<{ segment_id: string }>
      const conflict = migrated.prepare("SELECT winner_segment_id,loser_segment_id FROM manuscript_scope_conflicts WHERE run_id='migration-conflict-run'").all() as Array<{ winner_segment_id: string; loser_segment_id: string }>
      check('v20 迁移对历史重复 accepted 确定性保留高 revision 并记录冲突证据', accepted.length === 1 && accepted[0]?.segment_id === 'new' && superseded.some((row) => row.segment_id === 'old') && conflict.length === 1 && conflict[0]?.winner_segment_id === 'new' && conflict[0]?.loser_segment_id === 'old')
      const index = migrated.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ux_manuscript_segments_accepted_scope'").get()
      check('v20 安装 accepted scope partial unique index 且推进到当前 schema', Boolean(index) && (migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version === CURRENT_SCHEMA_VERSION)
    } finally {
      migrated?.close()
    }

    const dbPath = path.join(root, 'scope.sqlite')
    const repository = createRepository(dbPath)
    repository.open()
    const scopeRun = 'scope-run'
    const scopeSession = 'scope-session'
    repository.createRun(runRow(scopeRun, scopeSession))
    const first = makeSegment({ runId: scopeRun, sessionId: scopeSession, segmentId: 'scope:first', sceneId: 'scene-1', chunkIndex: 1, revision: 1, content: '第一版正文。', status: 'candidate' })
    const second = makeSegment({ runId: scopeRun, sessionId: scopeSession, segmentId: 'scope:second', sceneId: 'scene-1', chunkIndex: 1, revision: 2, content: '第二版正文。', status: 'candidate' })
    repository.saveManuscriptSegment(row(first))
    repository.saveManuscriptSegment(row(second))
    prepareAcceptance(repository, first)
    check('同一 scope 第一候选可 evidence-bound accepted', repository.getManuscriptSegmentsByRun(scopeRun).find((item) => item.segment_id === first.segmentId)?.status === 'accepted')
    let duplicateRejected = false
    try { prepareAcceptance(repository, second) } catch (error) { duplicateRejected = error instanceof Error && error.message === 'manuscript_scope_accepted_conflict' }
    check('同一 scope 第二候选普通 accept fail-closed 且不覆盖第一版', duplicateRejected && repository.getManuscriptSegmentsByRun(scopeRun).filter((item) => item.status === 'accepted').map((item) => item.segment_id).join(',') === first.segmentId)
    prepareAcceptance(repository, second, first.segmentId)
    const scopeRows = repository.getManuscriptSegmentsByRun(scopeRun)
    check('正文替换必须显式 supersede 且在同一事务完成', scopeRows.find((item) => item.segment_id === first.segmentId)?.status === 'superseded' && scopeRows.find((item) => item.segment_id === second.segmentId)?.status === 'accepted')
    repository.close()

    const sceneDb = path.join(root, 'scene.sqlite')
    const sceneRepo = createRepository(sceneDb)
    sceneRepo.open()
    const sceneRun = 'manifest-run'
    const sceneSession = 'manifest-session'
    const scenePlan = plan()
    const contract = scenePlan.contracts[0]!
    sceneRepo.createRun(runRow(sceneRun, sceneSession))
    sceneRepo.ensureSceneStates(sceneRun, scenePlan, 1)
    sceneRepo.transitionSceneState({ runId: sceneRun, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: 1, from: 'planned', to: 'writing', at: 2 })
    const prefixOne = makeSegment({ runId: sceneRun, sessionId: sceneSession, segmentId: 'manifest:one', sceneId: contract.sceneId, chunkIndex: 1, revision: 1, content: '雨落在灯塔外。', status: 'accepted' })
    const prefixTwo = makeSegment({ runId: sceneRun, sessionId: sceneSession, segmentId: 'manifest:two', sceneId: contract.sceneId, chunkIndex: 2, revision: 1, content: '林舟推开门。', status: 'accepted' })
    sceneRepo.saveManuscriptSegment(row(prefixOne))
    sceneRepo.saveManuscriptSegment(row(prefixTwo))
    const final = makeSegment({ runId: sceneRun, sessionId: sceneSession, segmentId: 'manifest:final', sceneId: contract.sceneId, chunkIndex: 3, revision: 1, content: '林舟抵达灯塔。', status: 'candidate' })
    sceneRepo.saveManuscriptSegment(row(final))
    const beforeCandidate = sceneRepo.getSceneStates(sceneRun)[0]!
    sceneRepo.transitionSceneState({ runId: sceneRun, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: beforeCandidate.revision, from: 'writing', to: 'candidate', candidateSegmentId: final.segmentId, candidateHash: final.contentHash, at: 3 })
    const decision = buildSceneCompletionDecision(contract, final.content, { candidateSegmentId: final.segmentId, scenePrefix: prefixOne.content + prefixTwo.content, at: 4 })
    const delta = buildEmptyNarrativeStateDelta({ runId: sceneRun, sceneId: contract.sceneId, acceptedSegmentId: final.segmentId, acceptedContentHash: final.contentHash, contractHash: contract.frozenHash })
    sceneRepo.saveRunEvidence(sceneRun, `scene_completion_decision:${final.segmentId}`, JSON.stringify({ schemaVersion: 1, runId: sceneRun, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, candidateSegmentId: final.segmentId, candidateHash: final.contentHash, decision, stateDeltaHash: delta.deltaHash, savedAt: 4 }))
    const evidenceRefs: Record<string, string | null> = {}
    const evidenceIdentity = manuscriptAcceptanceEvidenceIdentity({ runId: sceneRun, segmentId: final.segmentId, candidateHash: final.contentHash, candidateCharCount: final.charCount, evidenceRevision: final.revision, sceneId: contract.sceneId, evidenceRefs })
    sceneRepo.saveRunEvidence(sceneRun, 'manuscript_acceptance_ready', JSON.stringify({ schemaVersion: 1, runId: sceneRun, segmentId: final.segmentId, candidateHash: final.contentHash, candidateCharCount: final.charCount, evidenceRevision: final.revision, evidenceIdentity, sceneId: contract.sceneId, evidenceRefs, preparedAt: 4 }))
    const manifest = buildManifest(contract, sceneRun, [prefixOne, prefixTwo, final], decision, delta.deltaHash)
    const commitInput = { acceptance: { runId: sceneRun, segmentId: final.segmentId, expectedContentHash: final.contentHash, expectedCharCount: final.charCount, evidenceRevision: final.revision, evidenceIdentity, sceneId: contract.sceneId, acceptedAt: 5 }, contractId: contract.contractId, contractHash: contract.frozenHash, expectedSceneRevision: sceneRepo.getSceneStates(sceneRun)[0]!.revision, decision, completionEvidenceHash: decision.evidenceHash, stateDelta: delta, manifest, committedAt: 5 } as Parameters<Repository['commitScene']>[0]
    const staleManifest = buildManifest(contract, sceneRun, [prefixOne, final], decision, delta.deltaHash)
    let staleRejected = false
    try { sceneRepo.commitScene({ ...commitInput, manifest: staleManifest }) } catch (error) { staleRejected = error instanceof Error && error.message === 'scene_commit_manifest_stale' }
    check('Scene Commit 对 stale accepted prefix fail-closed 且不接纳 candidate', staleRejected && sceneRepo.getManuscriptSegmentsByRun(sceneRun).find((item) => item.segment_id === final.segmentId)?.status === 'candidate')
    // The production decision carries scenePrefixHash, so the same stale
    // prefix must be rejected even when a caller omits the optional manifest.
    // Inject it through the repository's normal segment writer, then remove
    // only the fixture row after the atomic rejection has been observed.
    const stalePrefix = makeSegment({ runId: sceneRun, sessionId: sceneSession, segmentId: 'manifest:stale-prefix', sceneId: contract.sceneId, chunkIndex: 0, revision: 1, content: '不属于本次前缀的旧稿。', status: 'accepted' })
    sceneRepo.saveManuscriptSegment(row(stalePrefix))
    let staleWithoutManifestRejected = false
    try { sceneRepo.commitScene({ ...commitInput, manifest: undefined }) } catch (error) { staleWithoutManifestRejected = error instanceof Error && error.message === 'scene_commit_manifest_stale' }
    check('不传 manifest 时仍按 decision.scenePrefixHash 拒绝 stale accepted prefix', staleWithoutManifestRejected && sceneRepo.getManuscriptSegmentsByRun(sceneRun).find((item) => item.segment_id === final.segmentId)?.status === 'candidate')
    sceneRepo.close()
    const cleanup = new DatabaseSync(sceneDb)
    cleanup.prepare("UPDATE manuscript_segments SET status='superseded', updated_at=? WHERE segment_id=? AND status='accepted'").run(6, stalePrefix.segmentId)
    cleanup.close()
    sceneRepo.open()
    sceneRepo.commitScene(commitInput)
    const storedManifest = sceneRepo.getSceneCommitManifest(sceneRun, contract.sceneId)
    check('Scene Commit 同事务绑定完整有序 segment manifest、scene hash/字数、decision/state delta hash', Boolean(storedManifest) && storedManifest?.acceptedSegments.map((item) => item.segmentId).join(',') === 'manifest:one,manifest:two,manifest:final' && storedManifest.sceneContentHash === manuscriptSegmentHash(prefixOne.content + prefixTwo.content + final.content) && storedManifest.sceneCharCount === codePointLength(prefixOne.content + prefixTwo.content + final.content) && storedManifest.completionDecisionHash === manifest.completionDecisionHash && storedManifest.stateDeltaHash === delta.deltaHash)
    sceneRepo.close()

    const corruptDb = path.join(root, 'corrupt.sqlite')
    const corruptRepo = createRepository(corruptDb)
    corruptRepo.open()
    const corruptRun = 'corrupt-run'
    const corruptSession = 'corrupt-session'
    corruptRepo.createRun(runRow(corruptRun, corruptSession))
    const sourceTurns = [
      { sourceTurnId: 'turn-a', sourceTurnSeq: 1, sourceContentHash: manuscriptSegmentHash('甲。'), sourceCharCount: 2 },
      { sourceTurnId: 'turn-b', sourceTurnSeq: 2, sourceContentHash: manuscriptSegmentHash('乙。'), sourceCharCount: 2 }
    ]
    const corruptState = { schemaVersion: 1 as const, runId: corruptRun, status: 'in_progress' as const, verification: 'active_run' as const, sourceTurns, sourceSummaryHash: legacyBackfillSourceSummaryHash(sourceTurns), expectedSourceCount: 2, expectedSegmentCount: 2, expectedAcceptedCharCount: 0, expectedAcceptedContentHash: null, expectedArtifactId: null, expectedArtifactHash: null, expectedArtifactCharCount: null, processedSourceTurnIds: ['turn-b'], acceptedSegmentIds: [], completionMarker: null, createdAt: 1, updatedAt: 1, completedAt: null }
    corruptRepo.close()
    const rawCorrupt = new DatabaseSync(corruptDb)
    rawCorrupt.prepare(`INSERT INTO manuscript_backfills (run_id,schema_version,status,verification,source_turns_json,source_summary_hash,expected_source_count,expected_segment_count,expected_accepted_char_count,expected_accepted_content_hash,expected_artifact_id,expected_artifact_hash,expected_artifact_char_count,processed_source_turn_ids_json,accepted_segment_ids_json,completion_marker,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(corruptRun, corruptState.schemaVersion, corruptState.status, corruptState.verification, JSON.stringify(corruptState.sourceTurns), corruptState.sourceSummaryHash, corruptState.expectedSourceCount, corruptState.expectedSegmentCount, corruptState.expectedAcceptedCharCount, null, null, null, null, JSON.stringify(corruptState.processedSourceTurnIds), '[]', null, 1, 1, null)
    rawCorrupt.close()
    const reopenedCorrupt = createRepository(corruptDb)
    reopenedCorrupt.open()
    let corruptRejected = false
    let corruptDetail = ''
    try { const loaded = reopenedCorrupt.getManuscriptBackfill(corruptRun); corruptDetail = JSON.stringify(loaded) } catch (error) { corruptRejected = error instanceof Error && error.message === 'manuscript_backfill_corrupt'; corruptDetail = error instanceof Error ? error.message : String(error) }
    check('backfill 损坏进度（非严格前缀）读取时 fail-closed', corruptRejected, corruptDetail)
    reopenedCorrupt.close()
  } finally {
    try { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) } catch (error) { console.error('P1-C cleanup warning:', error) }
  }
  console.log(`\nP1-C scope/scene manifest: ${passed} PASS / ${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error) => {
  console.error('P1-C 执行异常：', error)
  process.exitCode = 1
})
