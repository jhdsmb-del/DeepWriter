import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildSceneContractPlan } from '../src/main/narrative/sceneContract'
import { buildNarrativeContextManifest } from '../src/main/narrative/narrativeContext'
import { buildNarrativeFactsFromGrill, narrativeFactRegistryHash, narrativeFactReference } from '../src/main/narrative/factRegistry'
import { createContextService } from '../src/main/contextService'
import { ContextV2Service } from '../src/main/contextV2'
import { createRepository, type RunRow } from '../src/main/db/repository'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import { buildNarrativeStateDelta, normalizeNarrativeStateDelta } from '../src/main/narrative/stateDelta'
import type { NarrativeFact, NarrativeStateChange, SceneContractPlan } from '../src/shared/types'

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

function runRow(runId: string, sessionId: string): RunRow {
  return { run_id: runId, session_id: sessionId, status: 'running', phase: 'writing', started_at: 1, updated_at: 1, config_json: '{}', parent_run_id: null, error_code: null, error_message: null }
}

function plan(): SceneContractPlan {
  const outline: GrillMeOutline = {
    title: '雾港交接',
    premise: '林舟在灯塔把钥匙交给沈遥。',
    targetChars: 600,
    sections: [{ id: 'section-1', title: '雨夜交接', purpose: '完成灯塔钥匙交接。', targetChars: 600, beats: ['林舟抵达灯塔'], sourceSlotIds: ['goal'] }]
  }
  const outlineHash = grillMeOutlineHash(outline)
  return buildSceneContractPlan({ outline, outlineHash, outlineRevision: 1, answers: [{ slotId: 'goal', value: '林舟必须把钥匙交给沈遥', source: 'user' }], characterNames: ['林舟', '沈遥'], strongConstraints: { forbiddenTerms: [], mustKeep: [] } })
}

function makeKnowledgeChange(runId: string, sceneId: string, segmentId: string, contentHash: string, contractHash: string, fact: NarrativeFact): NarrativeStateChange {
  const ref = narrativeFactReference(fact)
  return {
    changeId: 'fact-e2e-knowledge', revision: 1, kind: 'knowledge', entityId: `lin:${fact.factId}`, runId, sceneId,
    acceptedSegmentId: segmentId, acceptedContentHash: contentHash, contractHash,
    factId: fact.factId, factRef: ref, knowerId: '林舟', stance: 'knows', certainty: 1,
    sourceSceneId: sceneId, effectiveTime: null, confidence: 1
  }
}

async function main(): Promise<void> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-p1-6-7-fact-context-'))
  const dbPath = path.join(tempRoot, 'facts.db')
  const repository = createRepository(dbPath)
  const context = new ContextV2Service(dbPath)
  try {
    repository.open()
    const runId = 'p1-6-7-run'
    const sessionId = 'p1-6-7-session'
    const scenePlan = plan()
    const contract = scenePlan.contracts[0]!
    repository.createSession(sessionId, 'P1 fact context', 'synthetic')
    repository.createRun(runRow(runId, sessionId))
    repository.ensureSceneStates(runId, scenePlan, 10)

    const facts = buildNarrativeFactsFromGrill({ sessionId, runId, answers: [{ slotId: 'goal', value: '林舟必须把钥匙交给沈遥', source: 'user' }] })
    for (const fact of facts) repository.upsertNarrativeFact(fact)
    const stored = repository.getNarrativeFacts(sessionId)
    const fact = stored[0]!
    check('P1-7 Grill confirmed answer 写入 versioned fact registry', stored.length === 1 && fact.factId.startsWith('fact_') && fact.canonicalStatement === '林舟必须把钥匙交给沈遥' && fact.sourceSlotIds.includes('goal') && fact.sources[0]?.sourceType === 'answer', JSON.stringify(stored))
    check('P1-7 fact hash/provenance 可复算且引用可解析', fact.canonicalHash.length === 64 && narrativeFactRegistryHash(stored) === narrativeFactRegistryHash([...stored].reverse()) && repository.resolveNarrativeFactReference(narrativeFactReference(fact))?.canonicalStatement === fact.canonicalStatement)

    const changed = buildNarrativeFactsFromGrill({ sessionId, runId, answers: [{ slotId: 'goal', value: '林舟必须把旧钥匙交给沈遥', source: 'user' }] })[0]!
    const changedStored = repository.upsertNarrativeFact(changed)
    const versions = repository.getNarrativeFacts(sessionId, true)
    check('P1-7 同一 slot 改写生成新版本而不覆盖旧事实', changedStored.version === 2 && repository.getNarrativeFact(fact.factId, 1)?.status === 'superseded' && versions.some((item) => item.version === 2 && item.canonicalStatement.includes('旧钥匙')))

    let missingRejected = false
    try {
      buildNarrativeContextManifest({ runId, sessionId, contract, ledger: [], facts: [], requireFactRegistry: true, mode: 'minimal', budget: { maxChars: 20_000, maxTokens: 8_000 } })
    } catch (error) { missingRejected = error instanceof Error && error.message === 'narrative_context_fact_missing' }
    check('P1-7 required fact 缺失时 context fail-closed', missingRejected)

    const factForContext = repository.getNarrativeFact(fact.factId, 2)!
    const contextService = createContextService(repository, context)
    let expectedRevision = 0
    const modes = ['full', 'optimized', 'minimal'] as const
    for (const mode of modes) {
      const preference = context.setMode(sessionId, mode, expectedRevision, 128)
      expectedRevision = preference.revision
      const frozenContext = context.freezeForRun({ sessionId, draftText: '继续写作', attachments: [], outputReserveTokens: 128, capabilityFingerprint: `p1-${mode}` })
      const config: Record<string, unknown> = {
        clientRequestId: runId, sessionId, runMode: 'longwrite', longMode: true, model: 'synthetic',
        sceneContracts: scenePlan, frozenContext,
        contextPolicy: { contextWindowTokens: 40_000, outputReserveTokens: 128 },
        strongConstraints: { enabled: false },
        grillMe: { answers: [{ slotId: 'goal', value: factForContext.canonicalStatement, source: 'user' }] }
      }
      const requestId = `p1-${mode}`
      const assembled = await contextService.assembleRunContext(config, expectedRevision, [{ role: 'user', content: '继续写作' }], [{ role: 'system', content: '只输出正文。' }], 'writer', requestId, 'writing')
      // Modern longwrite uses the source-bound Working Set, not the old
      // narrative_context_manifest. Validate the actual persisted projection.
      const reference = assembled.contextV2?.narrativeWorkingSet
      const record = reference ? repository.getSceneWorkingSet(reference.workingSetId) : null
      const evidenceRow = repository.getRunEvidence(runId, `scene_working_set:${requestId}`)
      const evidence = evidenceRow ? JSON.parse(evidenceRow.json) as { requiredFacts?: Array<{ factId: string; version: number; canonicalStatement: string; canonicalHash: string; provenanceHash: string }> } : null
      const factItem = evidence?.requiredFacts?.find((item) => item.factId === factForContext.factId)
      check(`P1-6 ${mode} writer 注入 current SceneContract 与 readable fact`, assembled.contextV2?.mode === mode && record?.manifest?.contractHash === contract.frozenHash && factItem?.version === factForContext.version && factItem?.canonicalHash === factForContext.canonicalHash && factItem?.provenanceHash === factForContext.provenanceHash && factItem?.canonicalStatement === factForContext.canonicalStatement && assembled.messages.some((message) => message.content.includes(factForContext.canonicalStatement)), JSON.stringify({ mode, fact: factItem }))
      assembled.sceneWorkingSetFence?.(assembled.messages, 'prebind')
      assembled.persistSceneEnvelope?.(assembled.messages)
      assembled.sceneWorkingSetFence?.(assembled.messages)
      const durable = reference ? repository.getSceneWorkingSet(reference.workingSetId) : null
      check(`P1-6 ${mode} manifest 可校验且 omitted 可见`, Boolean(durable?.manifest && durable.finalEnvelopeHash) && durable?.manifest?.manifestHash === reference?.manifestHash && Array.isArray(durable?.manifest?.omitted) && durable!.manifest!.estimatedTokens <= durable!.manifest!.budgetTokens && durable!.manifest!.sections.every((section) => !section.required || section.included))
    }

    const segmentId = 'fact-e2e-segment'
    const segmentHash = 'a'.repeat(64)
    const delta = buildNarrativeStateDelta({ schemaVersion: 1, runId, sceneId: contract.sceneId, acceptedSegmentId: segmentId, acceptedContentHash: segmentHash, contractHash: contract.frozenHash, changes: [makeKnowledgeChange(runId, contract.sceneId, segmentId, segmentHash, contract.frozenHash, factForContext)] })
    const normalized = normalizeNarrativeStateDelta(delta)
    check('P1-7 knowledge edge 携带完整 factRef（statement/hash/provenance）', normalized.changes[0]?.kind === 'knowledge' && normalized.changes[0].factRef?.canonicalStatement === factForContext.canonicalStatement && normalized.changes[0].factRef?.provenanceHash === factForContext.provenanceHash)
    let badRefRejected = false
    try { normalizeNarrativeStateDelta({ ...delta, changes: [{ ...delta.changes[0], factRef: { ...narrativeFactReference(factForContext), canonicalStatement: '篡改事实' } }] }) } catch { badRefRejected = true }
    check('P1-7 篡改 factRef canonical statement/hash fail-closed', badRefRejected)
  } finally {
    context.close()
    repository.close()
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\nP1-6/P1-7 fact context: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('P1-6/P1-7 fact context 执行异常：', error)
  process.exitCode = 2
})
