import { DatabaseSync } from 'node:sqlite'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { classifyAssistantOutput, buildAcceptedManuscript, makeManuscriptSegment, mergeContinuationText } from '../src/main/manuscript'
import { createRepository, type ManuscriptSegmentRow, type Repository, type RunRow, type TurnRow } from '../src/main/db/repository'
import type { ManuscriptSegment } from '../src/shared/types'
import { codePointLength } from '../src/shared/textMetrics'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function hash(value: string): string {
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
    config_json: JSON.stringify({ runMode: 'longwrite', longMode: true }),
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

function segment(input: {
  runId: string
  sessionId: string
  turnId: string
  chunkIndex: number
  content: string
  status: ManuscriptSegment['status']
  kind?: ManuscriptSegment['kind']
  revision?: number
  segmentId?: string
  sourceTurnId?: string
  supersedesSegmentId?: string
}): ManuscriptSegment {
  return makeManuscriptSegment({ ...input, createdAt: input.chunkIndex, updatedAt: input.chunkIndex })
}

async function main(): Promise<void> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r57-manuscript-'))
  const dbPath = path.join(tempDir, 'manuscript.db')
  const runId = 'r57-integrity'
  const sessionId = 'r57-session'
  let repository: Repository | null = null
  try {
    repository = createRepository(dbPath)
    repository.open()

    // Migration v16 must exist on a fresh database and remain usable through
    // the repository surface (not only through an untyped SQL probe).
    const probe = new DatabaseSync(dbPath)
    const version = Number((probe.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0)
    const table = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='manuscript_segments'").get()
    probe.close()
    check('R57 migration creates manuscript_segments at v16+', version >= 16 && Boolean(table), JSON.stringify({ version, table: Boolean(table) }))

    repository.createRun(runRow(runId, sessionId))

    // Classifier boundary: wrappers/metadata/refusals/structured output never
    // become prose, while a natural sentence is a complete candidate.
    const wrapped = classifyAssistantOutput('以下是正文：\n```markdown\n灯塔在雨里亮起。\n```')
    const meta = classifyAssistantOutput('下面是你要的小说正文如下：')
    const refusal = classifyAssistantOutput('抱歉，我不能继续执行这个要求。')
    const json = classifyAssistantOutput('{"outline":["收束"]}')
    const incomplete = classifyAssistantOutput('门外传来急促的脚步声')
    check('R57 classifier 剥离 wrapper/fence 后保留 prose', wrapped.kind === 'prose' && wrapped.complete && wrapped.content === '灯塔在雨里亮起。', JSON.stringify(wrapped))
    check('R57 classifier 隔离 meta/refusal/JSON', meta.kind === 'meta' && refusal.kind === 'refusal' && json.kind === 'plan', JSON.stringify({ meta, refusal, json }))
    check('R57 classifier 将明确残句保持 partial 语义', incomplete.kind === 'prose' && !incomplete.complete, JSON.stringify(incomplete))

    // Turn + segment are committed in one transaction. An integrity failure
    // rolls back both records, so a restart cannot observe a half checkpoint.
    const firstText = '第一段已完整收束。'
    const first = segment({ runId, sessionId, turnId: 'turn-1', chunkIndex: 1, content: firstText, status: 'candidate' })
    repository.tx(() => {
      repository!.appendTurn(turnRow(runId, 'turn-1', 1, firstText))
      repository!.saveManuscriptSegment(asRow(first))
    }, 'immediate')
    repository.acceptManuscriptSegmentsForTest(runId, [first.segmentId], 2)
    check('R57 turn+segment 原子提交', repository.getTurnsByRun(runId).some((turn) => turn.turn_id === 'turn-1') && repository.getManuscriptSegmentsByRun(runId).some((item) => item.segment_id === first.segmentId), '')

    const badText = '这条输出停在半句'
    const bad = segment({ runId, sessionId, turnId: 'turn-bad', chunkIndex: 2, content: badText, status: 'accepted' })
    let rolledBack = false
    try {
      repository.tx(() => {
        repository!.appendTurn(turnRow(runId, 'turn-bad', 2, badText))
        repository!.saveManuscriptSegment(asRow(bad))
      }, 'immediate')
    } catch {
      rolledBack = true
    }
    check('R57 非完整 accepted 拒绝并回滚 turn+segment', rolledBack && !repository.getTurnsByRun(runId).some((turn) => turn.turn_id === 'turn-bad') && !repository.getManuscriptSegmentsByRun(runId).some((item) => item.segment_id === bad.segmentId), '')

    // A partial is durable but cannot be accepted. Once the continuation makes
    // one complete segment, superseding and acceptance are idempotent.
    const partialText = '门外传来'
    const partial = segment({ runId, sessionId, turnId: 'turn-partial', chunkIndex: 3, content: partialText, status: 'partial' })
    repository.appendTurn(turnRow(runId, 'turn-partial', 3, partialText))
    repository.saveManuscriptSegment(asRow(partial))
    let partialRejected = false
    try { repository.acceptManuscriptSegmentsForTest(runId, [partial.segmentId], 10) } catch { partialRejected = true }
    check('R57 partial 落库但不能提前接受', partialRejected && repository.getManuscriptSegmentsByRun(runId).find((item) => item.segment_id === partial.segmentId)?.status === 'partial', '')

    const resumedText = mergeContinuationText(partialText, '脚步声越来越近。')
    const resumed = segment({
      runId,
      sessionId,
      turnId: 'turn-resume',
      sourceTurnId: 'turn-resume',
      chunkIndex: 3,
      revision: 2,
      segmentId: 'r57-resumed',
      content: resumedText,
      status: 'candidate',
      supersedesSegmentId: partial.segmentId
    })
    repository.appendTurn(turnRow(runId, 'turn-resume', 6, resumedText))
    repository.saveManuscriptSegment(asRow(resumed))
    repository.acceptManuscriptSegmentsForTest(runId, [resumed.segmentId], 11)
    repository.acceptManuscriptSegmentsForTest(runId, [resumed.segmentId], 12)
    const resumedRows = repository.getManuscriptSegmentsByRun(runId)
    check('R57 完整续写整体纳入且旧 partial 标为 superseded', resumedRows.find((item) => item.segment_id === partial.segmentId)?.status === 'superseded' && resumedRows.find((item) => item.segment_id === resumed.segmentId)?.status === 'accepted', '')

    const secondText = '第二段也已收束！'
    const second = segment({ runId, sessionId, turnId: 'turn-2', chunkIndex: 4, content: secondText, status: 'candidate' })
    repository.appendTurn(turnRow(runId, 'turn-2', 4, secondText))
    repository.saveManuscriptSegment(asRow(second))
    let batchRejected = false
    try { repository.acceptManuscriptSegmentsForTest(runId, [second.segmentId, 'r57-missing'], 13) } catch { batchRejected = true }
    check('R57 accepted batch 对缺失 id 全量回滚', batchRejected && repository.getManuscriptSegmentsByRun(runId).find((item) => item.segment_id === second.segmentId)?.status === 'candidate', '')
    repository.acceptManuscriptSegmentsForTest(runId, [second.segmentId], 14)

    const rejected = segment({ runId, sessionId, turnId: 'turn-rejected', chunkIndex: 5, content: '', status: 'rejected', kind: 'refusal' })
    repository.appendTurn(turnRow(runId, 'turn-rejected', 5, '拒绝输出'))
    repository.saveManuscriptSegment(asRow(rejected))
    const durable = repository.getManuscriptSegmentsByRun(runId).map((row) => ({
      schemaVersion: 1 as const,
      segmentId: row.segment_id,
      runId: row.run_id,
      sessionId: row.session_id,
      sourceTurnId: row.source_turn_id ?? undefined,
      chunkIndex: row.chunk_index,
      revision: row.revision,
      status: row.status,
      kind: row.kind,
      content: row.content,
      contentHash: row.content_hash,
      charCount: row.char_count,
      supersedesSegmentId: row.supersedes_segment_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      acceptedAt: row.accepted_at ?? undefined
    }))
    const canonical = buildAcceptedManuscript(durable)
    const expected = `${firstText}${resumedText}${secondText}`
    check('R57 canonical 仅由 accepted prose 构成', canonical === expected && !canonical.includes('turn-rejected'), JSON.stringify({ canonical, expected, canonicalChars: codePointLength(canonical), expectedChars: codePointLength(expected) }))
    check('R57 rejected/superseded/partial 不进入后续正文上下文', canonical === expected, canonical)

    // Artifact metadata is derived from the same accepted projection; its
    // Unicode count and content hash must agree exactly with the manuscript.
    const artifact = {
      artifact_id: `${runId}:manuscript`,
      run_id: runId,
      session_id: sessionId,
      artifact_type: 'manuscript',
      display_name: 'r57.md',
      relative_path: 'r57.md',
      hash: hash(canonical),
      char_count: codePointLength(canonical),
      status: 'completed',
      created_at: 20
    } as const
    repository.saveArtifact(artifact)
    const savedArtifact = repository.getArtifactsByRun(runId).find((item) => item.artifact_id === artifact.artifact_id)
    check('R57 accepted 字数与 artifact 字数/hash 一致', savedArtifact?.char_count === codePointLength(canonical) && savedArtifact.hash === hash(canonical), JSON.stringify({ canonicalChars: codePointLength(canonical), artifact: savedArtifact }))

    // Re-saving an identical final segment and accepting it again is a no-op;
    // changing an immutable final payload is rejected.
    const acceptedResumed = { ...resumed, status: 'accepted' as const, acceptedAt: 12 }
    repository.saveManuscriptSegment(asRow(acceptedResumed))
    let immutable = false
    try { repository.saveManuscriptSegment(asRow({ ...acceptedResumed, content: '篡改。' })) } catch { immutable = true }
    check('R57 crash/restore 重放不重复接受且 final segment 不可变', immutable && repository.getManuscriptSegmentsByRun(runId).filter((item) => item.status === 'accepted').length === 3, '')

  } finally {
    repository?.close()
    await fsp.rm(tempDir, { recursive: true, force: true })
  }

  console.log(`\nR57 manuscript integrity: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('R57 manuscript integrity 执行异常：', error)
  process.exitCode = 2
})
