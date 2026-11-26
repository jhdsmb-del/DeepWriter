import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { buildSceneContractPlan } from '../src/main/narrative/sceneContract'
import { buildNarrativeContextManifest, type NarrativeContextRecentProse } from '../src/main/narrative/narrativeContext'
import { createContextService } from '../src/main/contextService'
import { buildNarrativeFactsFromGrill } from '../src/main/narrative/factRegistry'
import { ContextV2Service } from '../src/main/contextV2'
import { createRepository, type ManuscriptSegmentRow, type Repository, type RunRow, type TurnRow } from '../src/main/db/repository'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import type { ManuscriptSegment, NarrativeLedgerEntry, NarrativeStateChange, SceneContractPlan } from '../src/shared/types'
import { makeManuscriptSegment } from '../src/main/manuscript'

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
  return { run_id: runId, session_id: sessionId, status: 'running', phase: 'writing', started_at: 1, updated_at: 1, config_json: '{}', parent_run_id: null, error_code: null, error_message: null }
}

function turnRow(runId: string, turnId: string, content: string, seq: number): TurnRow {
  return { turn_id: turnId, run_id: runId, turn_seq: seq, role: 'assistant', content, reasoning_content: null, tool_calls_json: null, tool_result_json: null, plan_state: null, created_at: seq }
}

function makePlan(): SceneContractPlan {
  const outline: GrillMeOutline = {
    title: '雾港接班',
    premise: '守灯人抵达灯塔，下一班守灯人接过钥匙。',
    targetChars: 600,
    sections: [{
      id: 'section-1',
      title: '雨夜交接',
      purpose: '完成灯塔交接。',
      targetChars: 600,
      beats: ['林舟抵达灯塔'],
      sourceSlotIds: ['goal'],
      scenes: [
        { id: 'arrival', title: '抵达', purpose: '林舟抵达灯塔。', targetChars: 300, beats: ['林舟抵达灯塔'], sourceSlotIds: ['goal'] },
        { id: 'handoff', title: '交接', purpose: '沈遥交出钥匙。', targetChars: 300, beats: ['沈遥交出钥匙'], sourceSlotIds: ['goal'] }
      ]
    }]
  }
  const outlineHash = grillMeOutlineHash(outline)
  return buildSceneContractPlan({ outline, outlineHash, outlineRevision: 4, answers: [{ slotId: 'goal', value: '完成灯塔交接', source: 'user' }], characterNames: ['林舟', '沈遥'], strongConstraints: { forbiddenTerms: [], mustKeep: [] } })
}

function perfLedger(runId: string, contractHash: string, count: number): NarrativeLedgerEntry[] {
  const acceptedContentHash = hashText('accepted-performance-segment')
  return Array.from({ length: count }, (_unused, index) => {
    const revision = index + 1
    const change: NarrativeStateChange = {
      changeId: `perf-event-${revision}`,
      revision,
      kind: 'timeline_event',
      entityId: `perf-event-${revision}`,
      runId,
      sceneId: `scene:perf:${revision}`,
      acceptedSegmentId: `perf-segment-${revision}`,
      acceptedContentHash,
      contractHash,
      eventType: 'movement',
      actorIds: ['林舟'],
      objectIds: [],
      locationId: `loc-${revision % 17}`,
      storyTime: revision,
      causeEventIds: [],
      consequenceEventIds: [],
      summary: `林舟在第${revision}个时间点移动。`
    }
    return { ...change, deltaHash: hashText(`perf-delta-${revision}`), committedAt: revision }
  })
}

function perfProse(runId: string, contractHash: string, count: number): NarrativeContextRecentProse[] {
  return Array.from({ length: count }, (_unused, index) => {
    const content = `第${index + 1}段已接受正文，林舟走过雾中的石阶。`
    return { segmentId: `perf-segment-${index + 1}`, runId, sceneId: `scene:perf:${index + 1}`, content, contentHash: hashText(content), contractHash, revision: index + 1 }
  })
}

async function main(): Promise<void> {
  const plan = makePlan()
  const currentContract = plan.contracts[1]!
  const performanceStart = performance.now()
  const perfManifest = buildNarrativeContextManifest({ runId: 'p4-perf', contract: currentContract, ledger: perfLedger('p4-perf', currentContract.frozenHash, 2000), recentProse: perfProse('p4-perf', currentContract.frozenHash, 2000), budget: { maxChars: 100_000, maxTokens: 40_000 } })
  const performanceMs = performance.now() - performanceStart
  const perfAgain = buildNarrativeContextManifest({ runId: 'p4-perf', contract: currentContract, ledger: perfLedger('p4-perf', currentContract.frozenHash, 2000).reverse(), recentProse: perfProse('p4-perf', currentContract.frozenHash, 2000).reverse(), budget: { maxChars: 100_000, maxTokens: 40_000 } })
  check('P4 2000 accepted segments + ledger entries在有界时间内完成且不全文拼接', performanceMs < 5000 && perfManifest.sections.reduce((sum, section) => sum + section.usedChars, 0) <= 100_000 && perfManifest.sections.reduce((sum, section) => sum + section.usedTokens, 0) <= 40_000, `${performanceMs.toFixed(1)} ms`)
  check('P4 2000规模输入反转后 manifest hash/预算结果稳定', perfManifest.manifestHash === perfAgain.manifestHash && JSON.stringify(perfManifest.sections) === JSON.stringify(perfAgain.sections))
  check('P4 当前 SceneContract 是强制项，预算不足明确拒绝', perfManifest.sections.find((section) => section.section === 'current_scene')?.includedCount === 1 && (() => {
    try {
      buildNarrativeContextManifest({ runId: 'p4-overflow', contract: currentContract, ledger: [], budget: { maxChars: 10, maxTokens: 10 } })
      return false
    } catch (error) {
      return error instanceof Error && error.message === 'narrative_context_current_scene_overflow'
    }
  })())

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p4-context-'))
  const dbPath = path.join(tempRoot, 'context.db')
  let repository: Repository | null = null
  let contextV2: ContextV2Service | null = null
  try {
    repository = createRepository(dbPath)
    repository.open()
    const runId = 'p4-production-run'
    const sessionId = 'p4-production-session'
    // The 1.2.5 production path compiles a Scene Working Set, rather than
    // re-injecting the older narrative_manifest. Start at the durable genesis
    // scene: historical thread recall is verified by the R72 live-path suite.
    const activeContract = plan.contracts[0]!
    repository.createRun(runRow(runId, sessionId))
    repository.ensureSceneStates(runId, plan, 10)
    repository.transitionSceneState({ runId, sceneId: activeContract.sceneId, contractId: activeContract.contractId, contractHash: activeContract.frozenHash, expectedRevision: 1, from: 'planned', to: 'writing', at: 11 })
    repository.createSession(sessionId, 'P4', 'synthetic')
    contextV2 = new ContextV2Service(dbPath)
    contextV2.setMode(sessionId, 'optimized', 0, 128)
    const frozenContext = contextV2.freezeForRun({ sessionId, draftText: '继续写作', attachments: [], outputReserveTokens: 128, capabilityFingerprint: 'p4-test' })
    const config: Record<string, unknown> = {
      clientRequestId: runId,
      sessionId,
      runMode: 'longwrite',
      longMode: true,
      model: 'synthetic',
      planMode: false,
      task: '依据已确认场景继续写作',
      sceneContracts: plan,
      frozenContext,
      contextPolicy: { contextWindowTokens: 40_000, outputReserveTokens: 128 },
      strongConstraints: { enabled: false }
    }
    const contextService = createContextService(repository, contextV2)
    let missingFactError = ''
    try {
      await contextService.assembleRunContext(config, 0, [{ role: 'user', content: '继续写作' }], [{ role: 'system', content: '只输出正文。' }], 'writer', 'p4-request-missing', 'writing')
    } catch (error) { missingFactError = error instanceof Error ? error.message : String(error) }
    check('P4 生产入口拒绝缺失的必需事实', missingFactError === 'scene_working_set_required_fact_missing:goal', missingFactError)
    for (const fact of buildNarrativeFactsFromGrill({ sessionId, runId, answers: [{ slotId: 'goal', value: '完成灯塔交接', source: 'user' }], now: 17 })) repository.upsertNarrativeFact(fact)
    const baseline = await contextService.assembleRunContext(config, 0, [{ role: 'user', content: '继续写作' }], [{ role: 'system', content: '只输出正文。' }], 'writer', 'p4-request-baseline', 'writing')
    const unboundContent = '未绑定的旧稿正文不应穿过叙事清单边界。'
    const unboundTurnId = `${runId}-unbound-turn`
    repository.appendTurn(turnRow(runId, unboundTurnId, unboundContent, 2))
    const unbound = makeManuscriptSegment({ runId, sessionId, turnId: unboundTurnId, chunkIndex: 0, content: unboundContent, status: 'accepted', kind: 'prose', sceneId: 'scene:legacy-unbound', sectionId: activeContract.sectionId, createdAt: 17, updatedAt: 17 })
    repository.saveManuscriptSegment(asRow(unbound))
    const assembled = await contextService.assembleRunContext(config, 1, [{ role: 'user', content: '继续写作' }], [{ role: 'system', content: '只输出正文。' }], 'writer', 'p4-request-1', 'writing')
    const reference = assembled.contextV2?.narrativeWorkingSet
    const record = reference ? repository.getSceneWorkingSet(reference.workingSetId) : null
    check('P4 optimized writer 生产入口只注入一份 durable/frozen Working Set 与必需事实', Boolean(record?.manifest && record.workingSetMessage && reference) && record?.manifest?.sceneId === activeContract.sceneId && record.manifest.contractHash === activeContract.frozenHash && assembled.messages.filter((message) => message.content === record?.workingSetMessage?.messages[0]?.content).length === 1 && assembled.messages.some((message) => message.content.includes('完成灯塔交接')), JSON.stringify(reference))
    check('P4 无 ledger/contract 绑定的 accepted 旧稿不进入 provider，亦不改变 canonical source hash', !assembled.messages.some((message) => message.content.includes(unboundContent)) && Boolean(reference && reference.sourceSnapshotHash === baseline.contextV2?.narrativeWorkingSet?.sourceSnapshotHash && reference.sourceCardSetHash === baseline.contextV2?.narrativeWorkingSet?.sourceCardSetHash))
    assembled.sceneWorkingSetFence?.(assembled.messages, 'prebind')
    assembled.persistSceneEnvelope?.(assembled.messages)
    assembled.sceneWorkingSetFence?.(assembled.messages)
    const persisted = assembled.contextV2 ? contextService.persistContext(assembled.contextV2, assembled.messages, []) : null
    const durableManifest = persisted ? contextV2.getManifest(persisted.manifestId) : null
    check('P4 ContextV2 durable manifest 绑定 Working Set hash、预算和最终 envelope', Boolean(durableManifest && record?.manifest && reference) && durableManifest?.narrativeWorkingSet?.manifestHash === record?.manifest?.manifestHash && durableManifest?.narrativeWorkingSet?.workingSetHash === reference?.workingSetHash && durableManifest?.envelopeHash === repository.getSceneWorkingSet(reference!.workingSetId)?.finalEnvelopeHash && record!.manifest!.estimatedTokens <= record!.manifest!.budgetTokens)
    const fullResult = await contextService.assembleRunContext({ ...config, frozenContext: { ...frozenContext, mode: 'full', policy: { ...frozenContext.policy!, mode: 'full' } } }, 2, [{ role: 'user', content: '继续写作' }], [{ role: 'system', content: '只输出正文。' }], 'writer', 'p4-request-full', 'writing')
    const minimalResult = await contextService.assembleRunContext({ ...config, frozenContext: { ...frozenContext, mode: 'minimal', policy: { ...frozenContext.policy!, mode: 'minimal' } } }, 3, [{ role: 'user', content: '继续写作' }], [{ role: 'system', content: '只输出正文。' }], 'writer', 'p4-request-minimal', 'writing')
    check('P4 full/minimal 均保留当前 SceneContract 与同一份 canonical Working Set', Boolean(reference) && fullResult.contextV2?.narrativeWorkingSet?.workingSetHash === reference?.workingSetHash && minimalResult.contextV2?.narrativeWorkingSet?.workingSetHash === reference?.workingSetHash)

  } finally {
    contextV2?.close()
    repository?.close()
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nP4 narrative context: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('P4 narrative context 执行异常：', error)
  process.exitCode = 2
})
