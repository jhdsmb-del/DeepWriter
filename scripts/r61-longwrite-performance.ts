/**
 * R61/P2-4: production-shaped SQLite longform context benchmark.
 *
 * This is intentionally a real Repository + ContextService run, not a pure
 * function benchmark.  It creates 2,000 accepted ~1,000-code-point segments,
 * warms the durable accepted-prefix cursor, then performs hundreds of writer
 * context assemblies.  The report exposes p50/p95 latency, accepted-body
 * bytes read by the cursor, heap delta, and CPU time.  A direct DB mutation
 * must invalidate the cursor and fail closed.
 *
 * Run directly with:
 *   npx esbuild scripts/r61-longwrite-performance.ts --bundle --format=esm --platform=node --outfile=out/r61-longwrite-performance.mjs --external:node:sqlite && node out/r61-longwrite-performance.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { buildNarrativeFactsFromGrill } from '../src/main/narrative/factRegistry'
import { buildSceneContractPlan } from '../src/main/narrative/sceneContract'
import { createContextService } from '../src/main/contextService'
import { ContextV2Service } from '../src/main/contextV2'
import { createRepository, type Repository, type RunRow } from '../src/main/db/repository'
import { manuscriptSegmentHash } from '../src/main/manuscript'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import type { SceneContractPlan } from '../src/shared/types'

const SEGMENT_COUNT = 2_000
const SEGMENT_CHARS = 1_000
const SAMPLE_COUNT = Math.max(100, Math.min(1_000, Number(process.env.DW_R61_PERF_SAMPLES ?? 240)))

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`r61 performance assertion failed: ${message}`)
}

function p50(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.50)] ?? 0
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

function plan(): SceneContractPlan {
  const outline: GrillMeOutline = {
    title: 'R61 长篇性能基准',
    premise: '林舟在雾港灯塔继续写作。',
    targetChars: 2_000_000,
    sections: [{ id: 'section-r61', title: '连续写作', purpose: '保持场景连续。', targetChars: 2_000_000, beats: ['林舟继续写作'], sourceSlotIds: ['goal'] }]
  }
  return buildSceneContractPlan({
    outline,
    outlineHash: grillMeOutlineHash(outline),
    outlineRevision: 1,
    answers: [{ slotId: 'goal', value: '林舟继续写作', source: 'user' }],
    characterNames: ['林舟'],
    strongConstraints: { forbiddenTerms: [], mustKeep: [] }
  })
}

function runRow(runId: string, sessionId: string): RunRow {
  return { run_id: runId, session_id: sessionId, status: 'running', phase: 'writing', started_at: 1, updated_at: 1, config_json: '{}', parent_run_id: null, error_code: null, error_message: null }
}

function segmentContent(index: number): string {
  const head = `第${index + 1}段，林舟沿着雾港石阶继续向灯塔走去；这是一段用于长篇上下文基准的稳定正文。`
  const chars = Array.from(head)
  return head + '景'.repeat(Math.max(0, SEGMENT_CHARS - chars.length - 1)) + '。'
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'dw-r61-longwrite-perf-'))
  const dbPath = path.join(root, 'r61-performance.db')
  const runId = 'r61-performance-run'
  const sessionId = 'r61-performance-session'
  const scenePlan = plan()
  const contract = scenePlan.contracts[0]!
  let repository: Repository | null = null
  let context: ContextV2Service | null = null
  try {
    repository = createRepository(dbPath)
    repository.open()
    repository.createSession(sessionId, 'R61 performance', 'synthetic')
    repository.createRun(runRow(runId, sessionId))
    repository.ensureSceneStates(runId, scenePlan, 10)
    repository.transitionSceneState({ runId, sceneId: contract.sceneId, contractId: contract.contractId, contractHash: contract.frozenHash, expectedRevision: 1, from: 'planned', to: 'writing', at: 11 })
    repository.close()
    repository = null

    // Fixture insertion is deliberately outside the production write path so
    // ingestion/partial-graph validation cannot dominate the assembly metric.
    // The rows are still real SQLite rows and carry exact content hash/count.
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const insert = db.prepare(`INSERT INTO manuscript_segments (
      segment_id, run_id, session_id, source_turn_id, section_id, scene_id,
      chunk_index, revision, status, kind, content, content_hash, char_count,
      supersedes_segment_id, created_at, updated_at, accepted_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    db.exec('BEGIN')
    let expectedBodyBytes = 0
    for (let index = 0; index < SEGMENT_COUNT; index += 1) {
      const content = segmentContent(index)
      const bytes = Buffer.byteLength(content, 'utf8')
      expectedBodyBytes += bytes
      insert.run(`r61-segment-${index + 1}`, runId, sessionId, null, contract.sectionId, contract.sceneId, index + 1, 1, 'accepted', 'prose', content, manuscriptSegmentHash(content), Array.from(content).length, null, 100 + index, 100 + index, 100 + index)
    }
    db.exec('COMMIT')
    db.close()

    repository = createRepository(dbPath)
    repository.open()
    context = new ContextV2Service(dbPath)
    context.setMode(sessionId, 'minimal', 0, 128)
    const frozenContext = context.freezeForRun({ sessionId, draftText: '继续写作', attachments: [], outputReserveTokens: 128, capabilityFingerprint: 'r61-performance' })
    const config: Record<string, unknown> = {
      clientRequestId: runId,
      sessionId,
      runMode: 'longwrite',
      longMode: true,
      model: 'synthetic',
      sceneContracts: scenePlan,
      frozenContext,
      contextPolicy: { contextWindowTokens: 100_000, outputReserveTokens: 128 },
      strongConstraints: { enabled: false }
    }
    for (const fact of buildNarrativeFactsFromGrill({ sessionId, runId, answers: [{ slotId: 'goal', value: '林舟继续写作', source: 'user' }] })) repository.upsertNarrativeFact(fact)
    const readPrefix = () => repository!.getAcceptedNarrativePrefixSnapshot!({ runId, recentChars: 12_000, currentSceneId: contract.sceneId, currentContractHash: contract.frozenHash, ledger: [] })
    const service = createContextService(repository, context)
    const live = [{ role: 'user' as const, content: '继续写作' }]
    const prefix = [{ role: 'system' as const, content: '只输出正文。' }]

    const firstPrefix = readPrefix()
    const first = await service.assembleRunContext(config, 0, live, prefix, 'writer', 'r61-perf-warmup-0', 'writing')
    check(firstPrefix?.cacheHit === false, `first assembly should rebuild cache: ${JSON.stringify(firstPrefix)}`)
    check(firstPrefix?.acceptedSegmentCount === SEGMENT_COUNT, 'first assembly accepted count')
    check(firstPrefix?.acceptedCharCount === SEGMENT_COUNT * SEGMENT_CHARS, 'first assembly accepted char count')
    check((firstPrefix?.readBytes ?? 0) >= expectedBodyBytes, 'first assembly reads the canonical bodies once')

    const latency: number[] = []
    const bytes: number[] = []
    const heap: number[] = []
    const cpu: number[] = []
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const beforeHeap = process.memoryUsage().heapUsed
      const beforeCpu = process.cpuUsage()
      const started = performance.now()
      const prefixSnapshot = readPrefix()
      const result = await service.assembleRunContext(config, index + 1, live, prefix, 'writer', `r61-perf-${index + 1}`, 'writing')
      check(Boolean(result.contextV2?.narrativeWorkingSet), `actual production Working Set at ${index}`)
      latency.push(performance.now() - started)
      bytes.push(prefixSnapshot?.readBytes ?? Number.NaN)
      const usedCpu = process.cpuUsage(beforeCpu)
      cpu.push((usedCpu.user + usedCpu.system) / 1_000)
      heap.push(process.memoryUsage().heapUsed - beforeHeap)
      check(prefixSnapshot?.cacheHit === true, `steady-state cache hit at ${index}`)
      check(prefixSnapshot?.acceptedSegmentCount === SEGMENT_COUNT, `steady-state segment count at ${index}`)
    }
    check(bytes.every((value) => Number.isFinite(value) && value < expectedBodyBytes / 8), `steady-state accepted body read is bounded: ${JSON.stringify({ max: Math.max(...bytes), total: expectedBodyBytes })}`)
    check(p95(latency) < 250, `p95 assembly latency ${p95(latency).toFixed(2)}ms`)

    // A normal Repository append advances the same cache in O(1), and changes
    // the prefix identity without forcing the next assembly to re-read 2,000
    // old bodies.
    const appended = segmentContent(SEGMENT_COUNT)
    repository.saveManuscriptSegment({
      segment_id: 'r61-segment-2001', run_id: runId, session_id: sessionId, source_turn_id: null,
      section_id: contract.sectionId, scene_id: contract.sceneId, chunk_index: SEGMENT_COUNT + 1, revision: 1,
      status: 'accepted', kind: 'prose', content: appended, content_hash: manuscriptSegmentHash(appended),
      char_count: Array.from(appended).length, supersedes_segment_id: null, created_at: 10_000, updated_at: 10_000, accepted_at: 10_000
    })
    const appendedPrefix = readPrefix()
    const afterAppend = await service.assembleRunContext(config, SAMPLE_COUNT + 1, live, prefix, 'writer', 'r61-perf-after-append', 'writing')
    check(appendedPrefix?.cacheHit === true && appendedPrefix.acceptedSegmentCount === SEGMENT_COUNT + 1, 'append advances durable cursor')
    check(afterAppend.contextV2?.narrativeWorkingSet?.workingSetHash !== first.contextV2?.narrativeWorkingSet?.workingSetHash, 'append changes the source-bound current scene tail')
    check((appendedPrefix?.readBytes ?? expectedBodyBytes) < expectedBodyBytes / 8, 'append assembly remains tail bounded')

    // An older partial is outside the continuation tail and has no accepted
    // prefix authority. It must still be validated on every context request.
    const partialContent = '旧的未完成正文。'
    const partialDb = new DatabaseSync(dbPath)
    try {
      partialDb.prepare(`INSERT INTO manuscript_segments (
        segment_id, run_id, session_id, source_turn_id, section_id, scene_id,
        chunk_index, revision, status, kind, content, content_hash, char_count,
        supersedes_segment_id, created_at, updated_at, accepted_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        'r61-old-partial', runId, sessionId, null, contract.sectionId, contract.sceneId,
        0, 1, 'partial', 'prose', partialContent, manuscriptSegmentHash(partialContent),
        Array.from(partialContent).length, null, 50, 50, null
      )
    } finally { partialDb.close() }
    const withOldPartial = await service.assembleRunContext(config, SAMPLE_COUNT + 2, live, prefix, 'writer', 'r61-perf-old-partial', 'writing')
    check(withOldPartial.contextV2?.narrativeWorkingSet?.workingSetHash === afterAppend.contextV2?.narrativeWorkingSet?.workingSetHash, 'valid partial outside the selected tail does not change the envelope')
    const corruptPartialDb = new DatabaseSync(dbPath)
    try { corruptPartialDb.prepare('UPDATE manuscript_segments SET content=? WHERE run_id=? AND segment_id=?').run('篡改未完成正文。', runId, 'r61-old-partial') } finally { corruptPartialDb.close() }
    let partialFailClosed = false
    try { await service.assembleRunContext(config, SAMPLE_COUNT + 3, live, prefix, 'writer', 'r61-perf-corrupt-partial', 'writing') } catch (error) { partialFailClosed = error instanceof Error && error.message.includes('scene_recall_snapshot_current_tail_segment_invalid') }
    check(partialFailClosed, 'corrupt partial outside the selected tail blocks production context')
    const cleanPartialDb = new DatabaseSync(dbPath)
    try { cleanPartialDb.prepare('DELETE FROM manuscript_segments WHERE run_id=? AND segment_id=?').run(runId, 'r61-old-partial') } finally { cleanPartialDb.close() }
    const afterPartialRemoval = await service.assembleRunContext(config, SAMPLE_COUNT + 4, live, prefix, 'writer', 'r61-perf-partial-removed', 'writing')
    check(afterPartialRemoval.contextV2?.narrativeWorkingSet?.workingSetHash === afterAppend.contextV2?.narrativeWorkingSet?.workingSetHash, 'removing the invalid old partial restores the same source-bound envelope')

    // Direct mutation of an old accepted body outside the selected tail must
    // invalidate prefix authority, despite the optimized bounded body reads.
    const tamperDb = new DatabaseSync(dbPath)
    tamperDb.prepare("UPDATE manuscript_segments SET content=? WHERE run_id=? AND segment_id=?").run('篡改。', runId, 'r61-segment-1')
    tamperDb.close()
    let failClosed = false
    try { repository.getAcceptedNarrativePrefixSnapshot!({ runId, recentChars: 12_000, currentSceneId: contract.sceneId, currentContractHash: contract.frozenHash, ledger: [] }) } catch (error) { failClosed = error instanceof Error && error.message === 'narrative_prefix_cache_invalid' }
    let contextFailClosed = false
    try { await service.assembleRunContext(config, SAMPLE_COUNT + 5, live, prefix, 'writer', 'r61-perf-tampered', 'writing') } catch (error) { contextFailClosed = error instanceof Error && error.message.includes('scene_recall_snapshot_current_tail_prefix_invalid') }
    check(failClosed && contextFailClosed, 'external accepted-body mutation invalidates cache and blocks context assembly')

    console.log(JSON.stringify({
      schemaVersion: 1,
      fixture: { acceptedSegments: SEGMENT_COUNT, charsPerSegment: SEGMENT_CHARS, acceptedChars: SEGMENT_COUNT * SEGMENT_CHARS, bodyBytes: expectedBodyBytes },
      samples: SAMPLE_COUNT,
      assembly: { readMetric: 'accepted-prefix cursor only; excludes Working Set source validation', p50Ms: Number(p50(latency).toFixed(3)), p95Ms: Number(p95(latency).toFixed(3)), maxReadBytes: Math.max(...bytes), p50ReadBytes: p50(bytes), p95ReadBytes: p95(bytes), heapDeltaP95: p95(heap), cpuMsP95: p95(cpu) },
      afterAppend: { acceptedSegments: appendedPrefix?.acceptedSegmentCount, readBytes: appendedPrefix?.readBytes, cacheHit: appendedPrefix?.cacheHit },
      correctness: { firstRebuild: true, steadyStateCacheHits: true, appendCursorAdvanced: true, unselectedPartialFailClosed: partialFailClosed, unselectedAcceptedMutationFailClosed: failClosed && contextFailClosed },
      thresholds: { p95AssemblyMsLt: 250, steadyStateReadBytesLt: Math.floor(expectedBodyBytes / 8), sampleCountGte: 100 }
    }, null, 2))
  } finally {
    context?.close()
    repository?.close()
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
