import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../src/main/db/migrations'
import { createRepository, type ManuscriptSegmentRow, type Repository } from '../src/main/db/repository'
import type { LegacyBackfillArtifact } from '../src/main/manuscriptBackfill'
import { advanceLegacyBackfillState, buildLegacyBackfillPlan, legacyBackfillSegment } from '../src/main/manuscriptBackfill'
import { legacyBackfillCompletionMarker, manuscriptSegmentHash } from '../src/main/manuscript'
import type { RunRecord, TurnRecord } from '../src/main/jobs/types'
import type { LegacyManuscriptBackfillState, ManuscriptSegment } from '../src/shared/types'
import { codePointLength } from '../src/shared/textMetrics'

type Check = (name: string, ok: boolean, detail?: string) => void

let passed = 0
let failed = 0
const check: Check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${name}${detail ? `: ${detail}` : ''}`)
  }
}

interface Fixture {
  root: string
  dbPath: string
  artifactDir: string
  run: RunRecord
  turns: TurnRecord[]
  prose: string
  artifact: LegacyBackfillArtifact | null
}

function turn(runId: string, id: string, seq: number, role: TurnRecord['role'], content: string): TurnRecord {
  return { runId, turnId: id, turnSeq: seq, role, content, createdAt: 1000 + seq }
}

function makeFixture(status: RunRecord['status'], artifactText: string | null): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwriter-p0-2-'))
  const dbPath = path.join(root, 'deepwriter.sqlite')
  const artifactDir = path.join(root, 'artifacts')
  fs.mkdirSync(artifactDir, { recursive: true })
  const runId = `p0-2-${status}-${Math.random().toString(36).slice(2)}`
  const sessionId = `${runId}-session`
  const proseParts = [
    '风穿过旧站的窗缝。',
    '林舟握紧钥匙。',
    status === 'running' ? '门在雨声里打开' : '门在雨声里打开。'
  ]
  const prose = proseParts.join('')
  const sourceTurns = [
    turn(runId, `${runId}-user`, 1, 'user', '继续写作'),
    turn(runId, `${runId}-a`, 2, 'assistant', proseParts[0]),
    turn(runId, `${runId}-b`, 3, 'assistant', proseParts[1]),
    turn(runId, `${runId}-c`, 4, 'assistant', proseParts[2]),
    turn(runId, `${runId}-tool`, 5, 'tool', 'tool output'),
    turn(runId, `${runId}-d`, 6, 'assistant', '注：模型已完成。')
  ]
  const run: RunRecord = {
    runId,
    sessionId,
    status,
    phase: status === 'completed' ? 'completed' : 'writing',
    startedAt: 900,
    updatedAt: 2000,
    configJson: JSON.stringify({ runMode: 'longwrite', longMode: true }),
  }
  const raw = new DatabaseSync(dbPath)
  raw.exec('PRAGMA foreign_keys = ON')
  runMigrations(raw, 15)
  raw.prepare('INSERT INTO sessions (session_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?)').run(sessionId, 'P0-2 fixture', 'fixture', 1, 2)
  raw.prepare('INSERT INTO runs (run_id,session_id,status,phase,started_at,updated_at,config_json,parent_run_id,error_code,error_message,client_request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    runId, sessionId, status, run.phase, run.startedAt, run.updatedAt, run.configJson, null, null, null, null
  )
  for (const item of sourceTurns) {
    raw.prepare('INSERT INTO turns (turn_id,run_id,turn_seq,role,content,reasoning_content,tool_calls_json,tool_result_json,plan_state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      item.turnId, item.runId, item.turnSeq, item.role, item.content, null, null, null, null, item.createdAt
    )
  }
  let artifact: LegacyBackfillArtifact | null = null
  if (artifactText !== null) {
    const hash = manuscriptSegmentHash(artifactText)
    artifact = { artifactId: `${runId}:manuscript`, hash, charCount: codePointLength(artifactText), content: artifactText }
    raw.prepare('INSERT INTO artifacts (artifact_id,run_id,session_id,artifact_type,display_name,relative_path,hash,char_count,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      artifact.artifactId, runId, sessionId, 'manuscript', 'fixture.md', null, artifact.hash, artifact.charCount, 'completed', 3
    )
    fs.writeFileSync(path.join(artifactDir, `${hash}.txt`), artifactText, 'utf8')
  }
  raw.close()
  return { root, dbPath, artifactDir, run, turns: sourceTurns, prose, artifact }
}

function openVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath)
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  db.close()
  return row.user_version
}

function sourceTurnsFor(repo: Repository, runId: string): TurnRecord[] {
  return repo.getTurnsByRun(runId).map((item) => ({
    runId: item.run_id,
    turnId: item.turn_id,
    turnSeq: item.turn_seq,
    role: item.role as TurnRecord['role'],
    content: item.content,
    ...(item.tool_calls_json ? { toolCallsJson: item.tool_calls_json } : {}),
    ...(item.reasoning_content ? { reasoningContent: item.reasoning_content } : {}),
    createdAt: item.created_at
  }))
}

function toSegmentRow(segment: ManuscriptSegment): ManuscriptSegmentRow {
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

async function persistPlan(
  repo: Repository,
  plan: ReturnType<typeof buildLegacyBackfillPlan>,
  faultAt: number | null
): Promise<{ crashed: boolean }> {
  repo.saveManuscriptBackfillStep(plan.state)
  let state = plan.state
  let crashed = false
  for (let i = 0; i < plan.segments.length; i += 1) {
    const segment = plan.segments[i]
    const sourceId = segment.sourceTurnId
    if (!sourceId) continue
    const next = advanceLegacyBackfillState(state, sourceId, 200 + i)
    try {
      repo.saveManuscriptBackfillStep(next, toSegmentRow(segment), faultAt === i ? {
        afterSegmentWrite: () => { throw new Error('injected_backfill_crash') }
      } : undefined)
      state = next
    } catch (error) {
      if (faultAt !== i || !(error instanceof Error) || error.message !== 'injected_backfill_crash') throw error
      crashed = true
      break
    }
  }
  return { crashed }
}

function toRunRecord(run: NonNullable<ReturnType<Repository['getRun']>>): RunRecord {
  return {
    runId: run.run_id,
    sessionId: run.session_id,
    status: run.status as RunRecord['status'],
    phase: run.phase as RunRecord['phase'],
    startedAt: run.started_at,
    updatedAt: run.updated_at,
    configJson: run.config_json,
    ...(run.parent_run_id ? { parentRunId: run.parent_run_id } : {}),
    ...(run.error_code ? { errorCode: run.error_code } : {}),
    ...(run.error_message ? { errorMessage: run.error_message } : {})
  }
}

function resumeToCompletion(repo: Repository, runId: string, originalPlan: ReturnType<typeof buildLegacyBackfillPlan>): { state: LegacyManuscriptBackfillState; content: string } {
  let state = repo.getManuscriptBackfill(runId)
  if (!state) throw new Error('backfill state missing')
  const segments = repo.getManuscriptSegmentsByRun(state.runId).map((segment) => ({
    segmentId: segment.segment_id,
    sourceTurnId: segment.source_turn_id ?? undefined,
    chunkIndex: segment.chunk_index,
    revision: segment.revision,
    status: segment.status,
    kind: segment.kind,
    content: segment.content
  }))
  const bySource = new Map(segments.flatMap((segment) => segment.sourceTurnId ? [[segment.sourceTurnId, segment]] as const : []))
  for (const source of state.sourceTurns) {
    if (state.processedSourceTurnIds.includes(source.sourceTurnId)) continue
    const segment = bySource.get(source.sourceTurnId) ?? originalPlan.segments.find((item) => item.sourceTurnId === source.sourceTurnId)
    if (!segment) continue
    const next = advanceLegacyBackfillState(state, source.sourceTurnId, 500 + source.sourceTurnSeq)
    const missingSegment = originalPlan.segments.find((item) => item.sourceTurnId === source.sourceTurnId)
    repo.saveManuscriptBackfillStep(next, bySource.has(source.sourceTurnId) || !missingSegment ? undefined : toSegmentRow(missingSegment))
    state = next
  }
  const finalState = repo.getManuscriptBackfill(state.runId)
  if (!finalState) throw new Error('final backfill state missing')
  const finalSegments = repo.getManuscriptSegmentsByRun(state.runId).map((segment) => ({
    chunkIndex: segment.chunk_index,
    revision: segment.revision,
    status: segment.status,
    kind: segment.kind,
    content: segment.content
  }))
  const content = finalSegments
    .filter((segment) => segment.status === 'accepted' && segment.kind === 'prose')
    .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision)
    .map((segment) => segment.content)
    .join('')
  return { state: finalState, content }
}

async function runFaultCase(faultAt: number): Promise<void> {
  const fixture = makeFixture('completed', null)
  const run = fixture.run
  const exactArtifact: LegacyBackfillArtifact = {
    artifactId: `${run.runId}:manuscript`,
    hash: manuscriptSegmentHash(fixture.prose),
    charCount: codePointLength(fixture.prose),
    content: fixture.prose
  }
  const raw = new DatabaseSync(fixture.dbPath)
  raw.prepare('INSERT INTO artifacts (artifact_id,run_id,session_id,artifact_type,display_name,relative_path,hash,char_count,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    exactArtifact.artifactId, run.runId, run.sessionId, 'manuscript', 'fixture.md', null, exactArtifact.hash, exactArtifact.charCount, 'completed', 3
  )
  fs.writeFileSync(path.join(fixture.artifactDir, `${exactArtifact.hash}.txt`), exactArtifact.content, 'utf8')
  raw.close()
  const repo = createRepository(fixture.dbPath)
  repo.open()
  const freshRow = repo.getRun(run.runId)
  const fresh = freshRow ? toRunRecord(freshRow) : null
  const turns = sourceTurnsFor(repo, run.runId)
  if (!fresh) throw new Error('fixture run missing')
  const plan = buildLegacyBackfillPlan(fresh, turns, exactArtifact)
  const result = await persistPlan(repo, plan, faultAt)
  check(`故障注入第 ${faultAt + 1} 个写入点后关闭/重开`, result.crashed, `crashed=${result.crashed}`)
  repo.close()
  const reopened = createRepository(fixture.dbPath)
  reopened.open()
  const resumed = resumeToCompletion(reopened, run.runId, plan)
  const state = resumed.state
  const segments = reopened.getManuscriptSegmentsByRun(run.runId).map((segment) => ({
    segmentId: segment.segment_id,
    sourceTurnId: segment.source_turn_id ?? undefined,
    chunkIndex: segment.chunk_index,
    revision: segment.revision,
    status: segment.status,
    kind: segment.kind,
    content: segment.content
  }))
  check(`故障点 ${faultAt + 1} backfill 最终 complete`, state.status === 'complete' && state.completionMarker === legacyBackfillCompletionMarker(state), JSON.stringify(state))
  check(`故障点 ${faultAt + 1} 全文/顺序/hash 不变`, resumed.content === fixture.prose && manuscriptSegmentHash(resumed.content) === exactArtifact.hash && codePointLength(resumed.content) === exactArtifact.charCount && segments.filter((s) => s.status === 'accepted').length === 3)
  const again = resumeToCompletion(reopened, run.runId, plan)
  check(`故障点 ${faultAt + 1} 重跑幂等`, JSON.stringify(again.state) === JSON.stringify(state) && again.content === resumed.content)
  reopened.close()
  fs.rmSync(fixture.root, { recursive: true, force: true })
}

async function runSemanticCases(): Promise<void> {
  const exact = makeFixture('completed', null)
  const exactArtifact: LegacyBackfillArtifact = {
    artifactId: `${exact.run.runId}:manuscript`,
    hash: manuscriptSegmentHash(exact.prose),
    charCount: codePointLength(exact.prose),
    content: exact.prose
  }
  const exactRaw = new DatabaseSync(exact.dbPath)
  exactRaw.prepare('INSERT INTO artifacts (artifact_id,run_id,session_id,artifact_type,display_name,relative_path,hash,char_count,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    exactArtifact.artifactId, exact.run.runId, exact.run.sessionId, 'manuscript', 'fixture.md', null, exactArtifact.hash, exactArtifact.charCount, 'completed', 3
  )
  fs.mkdirSync(exact.artifactDir, { recursive: true })
  fs.writeFileSync(path.join(exact.artifactDir, `${exactArtifact.hash}.txt`), exact.prose, 'utf8')
  exactRaw.close()
  const repo = createRepository(exact.dbPath)
  repo.open()
  const runRow = repo.getRun(exact.run.runId)
  const run = runRow ? toRunRecord(runRow) : null
  if (!run) throw new Error('exact run missing')
  const turns = sourceTurnsFor(repo, exact.run.runId)
  const plan = buildLegacyBackfillPlan(run, turns, exactArtifact)
  await persistPlan(repo, plan, null)
  const final = resumeToCompletion(repo, exact.run.runId, plan)
  const state = final.state
  check('v15→当前 schema 迁移版本达到唯一当前版本', openVersion(exact.dbPath) === CURRENT_SCHEMA_VERSION)
  check('完成态旧 run 仅在 artifact 精确对账后 accepted', state.status === 'complete' && state.verification === 'artifact_exact' && state.expectedArtifactHash === exactArtifact.hash && final.content === exact.prose)
  check('完成标记绑定 source summary/顺序/accepted hash', state.sourceSummaryHash.length === 64 && state.processedSourceTurnIds.join(',') === state.sourceTurns.map((s) => s.sourceTurnId).join(',') && state.acceptedSegmentIds.length === 3 && state.completionMarker === legacyBackfillCompletionMarker(state))
  const persistedAgain = resumeToCompletion(repo, exact.run.runId, plan)
  check('无故障重跑不重复、不截断', JSON.stringify(persistedAgain.state) === JSON.stringify(state) && persistedAgain.content === final.content)
  repo.close()
  fs.rmSync(exact.root, { recursive: true, force: true })

  const active = makeFixture('running', null)
  const activeRepo = createRepository(active.dbPath)
  activeRepo.open()
  const activeRunRow = activeRepo.getRun(active.run.runId)
  const activeRun = activeRunRow ? toRunRecord(activeRunRow) : null
  if (!activeRun) throw new Error('active run missing')
  const activeTurns = sourceTurnsFor(activeRepo, active.run.runId)
  const activePlan = buildLegacyBackfillPlan(activeRun, activeTurns, null)
  const staleAccepted = legacyBackfillSegment(activeRun, activeTurns[1], true)
  activeRepo.saveManuscriptSegment(toSegmentRow(staleAccepted))
  await persistPlan(activeRepo, activePlan, null)
  const activeState = activeRepo.getManuscriptBackfill(active.run.runId)
  const activeSegments = activeRepo.getManuscriptSegmentsByRun(active.run.runId)
  check('活跃旧 run 不按标点自动 accepted', activeState?.status === 'unverified' && activeState.verification === 'active_run' && activeSegments.every((segment) => segment.status !== 'accepted') && activeSegments.some((segment) => segment.status === 'candidate'))
  check('活跃旧 run 的 partial 保留为 partial', activeSegments.some((segment) => segment.status === 'partial'))
  activeRepo.close()
  fs.rmSync(active.root, { recursive: true, force: true })

  const mismatch = makeFixture('completed', '另一份稿件。')
  const mismatchRepo = createRepository(mismatch.dbPath)
  mismatchRepo.open()
  const mismatchRunRow = mismatchRepo.getRun(mismatch.run.runId)
  const mismatchRun = mismatchRunRow ? toRunRecord(mismatchRunRow) : null
  if (!mismatchRun) throw new Error('mismatch run missing')
  const mismatchTurns = sourceTurnsFor(mismatchRepo, mismatch.run.runId)
  const mismatchPlan = buildLegacyBackfillPlan(mismatchRun, mismatchTurns, mismatch.artifact)
  await persistPlan(mismatchRepo, mismatchPlan, null)
  const mismatchState = mismatchRepo.getManuscriptBackfill(mismatch.run.runId)
  const mismatchSegments = mismatchRepo.getManuscriptSegmentsByRun(mismatch.run.runId)
  check('完成态无法与旧 artifact 对账时不得 accepted', mismatchState?.status === 'unverified' && mismatchState.verification === 'source_mismatch' && mismatchSegments.every((segment) => segment.status !== 'accepted'))
  mismatchRepo.close()
  fs.rmSync(mismatch.root, { recursive: true, force: true })
}

async function main(): Promise<void> {
  console.log('P0-2 manuscript backfill')
  for (const point of [0, 1, 2]) await runFaultCase(point)
  await runSemanticCases()
  console.log(`\nP0-2 manuscript backfill: ${passed} PASS / ${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error) => {
  console.error('P0-2 manuscript backfill 执行异常：', error)
  process.exitCode = 1
})
