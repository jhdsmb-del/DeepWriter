/**
 * R60/P1-3 independent beat corpus.
 *
 * This is intentionally separate from r58's happy-path contract test.  It is
 * a small adversarial corpus for the deterministic event envelope: natural
 * rewrites must pass, while a negation/rumour/conditional/dream/memory/plan
 * must never promote a scene to complete.  The model-evidence probes also
 * exercise full scene-prefix binding and the uncertain state.
 *
 * Run without changing package scripts:
 *   npx esbuild scripts/p1-3-scene-contract-semantics.ts --bundle --format=esm --platform=node --outfile=out/p1-3-scene-contract-semantics.mjs
 *   node out/p1-3-scene-contract-semantics.mjs
 */
import { createHash } from 'node:crypto'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import {
  buildSceneContractPlan,
  buildSceneCompletionDecision,
  evaluateSceneContract,
  sceneContractPlanValid
} from '../src/main/narrative/sceneContract'
import { extractNarrativeStateDelta } from '../src/main/narrative/stateExtractor'

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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function main(): void {
  const outline: GrillMeOutline = {
    title: '雾港夜班',
    premise: '守灯人必须在暴雨前完成一次代价很高的钥匙交接。',
    targetChars: 3200,
    sections: [
      {
        id: 'arrival',
        title: '抵达与密信',
        purpose: '林舟抵达灯塔并发现密信。',
        targetChars: 1000,
        beats: ['林舟抵达灯塔，发现密信'],
        sourceSlotIds: ['goal'],
        scenes: [
          { id: 'a', title: '雨夜靠岸', purpose: '林舟抵达灯塔并发现密信。', targetChars: 500, beats: ['林舟抵达灯塔，发现密信'], sourceSlotIds: [] },
          { id: 'b', title: '铁柜里的信', purpose: '林舟发现密信。', targetChars: 500, beats: ['林舟发现密信'], sourceSlotIds: [] },
          { id: 'c', title: '交接', purpose: '沈遥交出钥匙。', targetChars: 500, beats: ['沈遥交出钥匙'], sourceSlotIds: [] }
        ]
      },
      {
        id: 'decision',
        title: '潮声里的决定',
        purpose: '两人作出决定。',
        targetChars: 2200,
        beats: ['两人作出决定'],
        sourceSlotIds: []
      }
    ]
  }
  const outlineHash = grillMeOutlineHash(outline)
  const plan = buildSceneContractPlan({ outline, outlineHash, characterNames: ['林舟', '沈遥'] })
  check('P1-3 contract 编译出结构化 actor/action/object/location/result/negation/modality/time', sceneContractPlanValid(plan) && plan.contracts.every((contract) => contract.requiredBeatEvidence?.length === contract.mustHappen.length && contract.requiredBeatEvidence.every((beat) => Array.isArray(beat.actor) && Array.isArray(beat.action) && Array.isArray(beat.object) && Array.isArray(beat.location) && Array.isArray(beat.result) && Array.isArray(beat.time) && typeof beat.negation === 'boolean' && typeof beat.modality === 'string')))

  const first = plan.contracts.find((contract) => contract.sceneId === 'scene:arrival:a')
  const second = plan.contracts.find((contract) => contract.sceneId === 'scene:arrival:b')
  const third = plan.contracts.find((contract) => contract.sceneId === 'scene:arrival:c')
  const last = plan.contracts.find((contract) => contract.sceneId === 'scene:decision')
  if (!first || !second || !third || !last) throw new Error('P1-3 corpus scene fixture incomplete')

  check('P2-5 同一 thread 才 advance，首场 open，末场 close，新 section 重新 open', first.threadActions[0]?.action === 'open' && second.threadActions[0]?.action === 'advance' && third.threadActions[0]?.action === 'close' && last.threadActions[0]?.action === 'open' && last.threadActions.some((action) => action.action === 'close'), JSON.stringify(plan.contracts.map((contract) => ({ scene: contract.sceneId, thread: contract.threadActions }))))

  const arrivalPositive = evaluateSceneContract(first, '暴雨敲打塔窗，林舟从铁柜夹层抽出一封落满盐霜的信。', { completed: true })
  check('P1-3 同义改写/隐含到达证据通过', arrivalPositive.status === 'passed' && arrivalPositive.beatEvidence?.[0]?.status === 'satisfied' && arrivalPositive.beatEvidence[0]?.inferred.includes('arrive_from_presence') === true, JSON.stringify(arrivalPositive))

  const handoverPositive = evaluateSceneContract(third, '沈遥把钥匙交到他手里。', { completed: true })
  check('P1-3 把字句/交到改写通过', handoverPositive.status === 'passed' && handoverPositive.beatEvidence?.[0]?.status === 'satisfied', JSON.stringify(handoverPositive))

  const adversarial: Array<[string, string, typeof first]> = [
    ['negation', '沈遥没有交出钥匙。', third],
    ['partial-negation', '林舟抵达灯塔，但没有发现密信。', first],
    ['unable-negation', '林舟抵达灯塔，却未能发现密信。', first],
    ['negative-result', '林舟抵达灯塔，发现密信并不存在。', first],
    ['reported', '据说林舟抵达灯塔并发现密信。', first],
    ['hypothetical', '如果林舟抵达灯塔，也许就能发现密信。', first],
    ['dream', '梦里林舟抵达灯塔并发现密信。', first],
    ['memory', '林舟回忆起自己抵达灯塔、发现密信的那一天。', first],
    ['planned', '林舟计划抵达灯塔并寻找密信。', first]
  ]
  for (const [label, text, target] of adversarial) {
    const result = evaluateSceneContract(target, text, { completed: true })
    check(`P1-3 ${label} 不能冒充实际发生`, result.status === 'deviated' && result.beatEvidence?.[0]?.status === 'contradicted' && result.violations.some((item) => item.code === 'beat_contradicted'), JSON.stringify({ label, status: result.status, evidence: result.beatEvidence }))
  }

  // Predicate-local scope must not turn an ambiguous trailing attribution
  // into a confidently contradicted event. Both states still defer completion;
  // the explicit leading reported frame above remains a hard negative.
  const trailingReport = '林舟抵达灯塔只是传闻，所谓发现密信更是谣言。'
  const ambiguousReport = evaluateSceneContract(first, trailingReport, { completed: true })
  const ambiguousDecision = buildSceneCompletionDecision(first, trailingReport, { candidateSegmentId: 'p1-3-reported-ambiguous', evaluation: ambiguousReport })
  check('P1-3 后置传闻作用域不明保持 uncertain/defer，不断言发生或收尾', ambiguousReport.status === 'advisory' &&
    ambiguousReport.beatEvidence?.[0]?.status === 'uncertain' && ambiguousReport.beatEvidence[0]?.actuality === 'unknown' &&
    ambiguousReport.violations.some(item => item.code === 'beat_uncertain') && ambiguousDecision.status === 'defer' && ambiguousDecision.satisfiedBeatIds.length === 0, JSON.stringify(ambiguousReport))

  const nonNegated = evaluateSceneContract(first, '林舟抵达灯塔，四周不远处没有别的船，他从铁柜里抽出一封信，塔内寂静无声。', { completed: true })
  check('P1-3 普通“不/没有”描写不误判为事件否定', nonNegated.status === 'passed', JSON.stringify(nonNegated))

  const opaqueOutline: GrillMeOutline = {
    title: '无动作锚点',
    premise: '验证未知语义不会被空字段放行。',
    targetChars: 400,
    sections: [{ id: 'opaque', title: '压迫感', purpose: '气氛变得压抑。', targetChars: 400, beats: ['气氛变得压抑'], sourceSlotIds: [] }]
  }
  const opaquePlan = buildSceneContractPlan({ outline: opaqueOutline, outlineHash: grillMeOutlineHash(opaqueOutline) })
  const opaque = evaluateSceneContract(opaquePlan.contracts[0]!, '海风从破窗灌入，桌上的纸张被卷起。', { completed: true })
  check('P1-3 未识别动作的 beat 不得空字段自我满足', opaque.status === 'advisory' && opaque.beatEvidence?.[0]?.status === 'missing', JSON.stringify(opaque))

  const prefix = '前文中，灯塔的门已经被风暴撞开。'
  // Model evidence is candidate-local and content-addressed: the prefix hash
  // alone is not enough because every candidate in a run shares it.  Keep the
  // prose explicit enough for the cited role fields, while leaving the action
  // itself to the structured model packet.
  const modelCandidate = '林舟朝灯塔前行。'
  const modelCandidateHash = sha256(modelCandidate)
  const modelCandidateSpan = { start: 0, end: modelCandidate.length, text: modelCandidate }
  const boundEvidence = [{ beatId: first.requiredBeatIds[0]!, scenePrefixHash: sha256(prefix), candidateHash: modelCandidateHash, spans: [modelCandidateSpan], status: 'satisfied' as const, actor: ['林舟'], action: [], location: ['灯塔'], object: [], result: [], time: [], negation: false, modality: 'actual' as const }]
  const modelResolved = evaluateSceneContract(first, modelCandidate, { scenePrefix: prefix, completed: true, modelEvidence: boundEvidence })
  check('P1-3 结构化模型 evidence 绑定完整 scene prefix 后可解决本地不确定项', modelResolved.status === 'passed' && modelResolved.beatEvidence?.[0]?.source === 'deterministic+model', JSON.stringify(modelResolved))
  const wrongPrefix = evaluateSceneContract(first, modelCandidate, { scenePrefix: '被篡改的前文。', completed: true, modelEvidence: boundEvidence })
  check('P1-3 错 prefix 的模型 evidence fail-closed', wrongPrefix.status === 'deviated' && wrongPrefix.violations.some((item) => item.code === 'beat_evidence_invalid'), JSON.stringify(wrongPrefix))
  const uncertainEvidence = [{ beatId: first.requiredBeatIds[0]!, scenePrefixHash: sha256(prefix), candidateHash: modelCandidateHash, spans: [modelCandidateSpan], status: 'uncertain' as const, rationale: '无法确认是否真的走入灯塔' }]
  const uncertain = evaluateSceneContract(first, modelCandidate, { scenePrefix: prefix, completed: true, modelEvidence: uncertainEvidence })
  check('P1-3 uncertain evidence 保持 defer，不自动收尾', uncertain.status === 'advisory' && uncertain.violations.some((item) => item.code === 'beat_uncertain'), JSON.stringify(uncertain))

  const decision = buildSceneCompletionDecision(first, '林舟走进灯塔。', { candidateSegmentId: 'p1-3-candidate', scenePrefix: prefix, at: 1 })
  check('P1-3 completion decision 携带 prefix hash 与逐 beat evidence', decision.status === 'defer' && decision.scenePrefixHash === sha256(prefix) && decision.beatEvidence?.[0]?.scenePrefixHash === sha256(prefix), JSON.stringify(decision))

  // v1.2.2 production-shape corpus: a directional verb is not allowed to
  // borrow the first outline character as its agent.  Role evidence must be
  // explicit; the unresolved case is therefore uncertain/pending instead of
  // silently creating a false holder edge.
  const directionalPhrases = ['交给沈遥', '拿走钥匙', '借给沈遥', '归还钥匙', '偷走钥匙', '放置钥匙', '遗失钥匙', '交换钥匙和信']
  for (const phrase of directionalPhrases) {
    const directionalOutline: GrillMeOutline = {
      title: `方向性：${phrase}`,
      premise: '方向性事件必须绑定角色证据。',
      targetChars: 100,
      sections: [{ id: 'directional', title: phrase, purpose: phrase, targetChars: 100, beats: [phrase], sourceSlotIds: [] }]
    }
    const directionalContract = buildSceneContractPlan({ outline: directionalOutline, outlineHash: grillMeOutlineHash(directionalOutline), characterNames: ['林舟', '沈遥'] }).contracts[0]!
    const directionalRequirement = directionalContract.requiredBeatEvidence?.[0]
    const directionalEvaluation = evaluateSceneContract(directionalContract, `${phrase}。`, { completed: true })
    const directionalDecision = buildSceneCompletionDecision(directionalContract, `${phrase}。`, { candidateSegmentId: 'p1-3-unbound', evaluation: directionalEvaluation })
    check(`P1-3 directional “${phrase}” 无 agent 不猜第一个 actor`, directionalRequirement?.agent?.length === 0 && directionalEvaluation.beatEvidence?.[0]?.matched.agent.length === 0 && directionalEvaluation.beatEvidence?.[0]?.status === 'uncertain' && directionalDecision.status === 'defer' && directionalDecision.satisfiedBeatIds.length === 0, JSON.stringify({ requirement: directionalRequirement, evidence: directionalEvaluation.beatEvidence?.[0] }))
  }

  const explicitOutline: GrillMeOutline = {
    title: '方向绑定',
    premise: '显式 agent/patient/recipient 才能写入物品持有人。',
    targetChars: 100,
    sections: [{ id: 'directional', title: '交接', purpose: '林舟把钥匙交给沈遥。', targetChars: 100, beats: ['林舟把钥匙交给沈遥'], sourceSlotIds: [] }]
  }
  const explicitContract = buildSceneContractPlan({ outline: explicitOutline, outlineHash: grillMeOutlineHash(explicitOutline), characterNames: ['林舟', '沈遥'] }).contracts[0]!
  const explicitContent = '林舟把钥匙交给沈遥。'
  const explicitSegment = { segmentId: 'p1-3-directional-explicit', content: explicitContent, contentHash: sha256(explicitContent), charCount: Array.from(explicitContent).length, chunkIndex: 1, revision: 1 }
  const explicitDecision = buildSceneCompletionDecision(explicitContract, explicitContent, { candidateSegmentId: explicitSegment.segmentId, at: 2 })
  const explicitExtraction = extractNarrativeStateDelta({ runId: 'p1-3-directional-run', sceneId: explicitContract.sceneId, contract: explicitContract, decision: explicitDecision, candidateSegmentId: explicitSegment.segmentId, candidateContentHash: explicitSegment.contentHash, acceptedSegments: [explicitSegment], confirmedAnswers: [] })
  const explicitObject = explicitExtraction.status === 'ready' ? explicitExtraction.delta.changes.find((change) => change.kind === 'object_state') : undefined
  check('P1-3 显式 agent/patient/recipient 将 holder 绑定到 recipient', explicitExtraction.status === 'ready' && explicitObject?.kind === 'object_state' && explicitObject.holderId === '沈遥' && explicitObject.holderStatus === 'known', JSON.stringify({ status: explicitExtraction.status, object: explicitObject }))

  const unknownOutline: GrillMeOutline = {
    title: '方向未知',
    premise: '缺失行动者时只能显式保留 unknown。',
    targetChars: 100,
    sections: [{ id: 'directional', title: '拿走', purpose: '拿走钥匙。', targetChars: 100, beats: ['拿走钥匙'], sourceSlotIds: [] }]
  }
  const unknownContract = buildSceneContractPlan({ outline: unknownOutline, outlineHash: grillMeOutlineHash(unknownOutline), characterNames: ['林舟', '沈遥'] }).contracts[0]!
  const unknownContent = '拿走钥匙。'
  const unknownSegment = { segmentId: 'p1-3-directional-unknown', content: unknownContent, contentHash: sha256(unknownContent), charCount: Array.from(unknownContent).length, chunkIndex: 1, revision: 1 }
  const deferred = buildSceneCompletionDecision(unknownContract, unknownContent, { candidateSegmentId: unknownSegment.segmentId, at: 3 })
  const forcedComplete = { ...deferred, status: 'complete' as const, satisfiedBeatIds: [...deferred.requiredBeatIds], missingBeatIds: [], beatEvidence: deferred.beatEvidence?.map((item) => ({ ...item, status: 'satisfied' as const })) }
  const pendingUnknown = extractNarrativeStateDelta({ runId: 'p1-3-directional-pending', sceneId: unknownContract.sceneId, contract: unknownContract, decision: forcedComplete, candidateSegmentId: unknownSegment.segmentId, candidateContentHash: unknownSegment.contentHash, acceptedSegments: [unknownSegment], confirmedAnswers: [] })
  const acceptedUnknown = extractNarrativeStateDelta({ runId: 'p1-3-directional-accepted-unknown', sceneId: unknownContract.sceneId, contract: unknownContract, decision: forcedComplete, candidateSegmentId: unknownSegment.segmentId, candidateContentHash: unknownSegment.contentHash, acceptedSegments: [unknownSegment], confirmedAnswers: [], allowUnknownSemanticRoles: true })
  const unknownObject = acceptedUnknown.status === 'ready' ? acceptedUnknown.delta.changes.find((change) => change.kind === 'object_state') : undefined
  check('P1-3 缺失 agent 默认进入 pending，显式 accept_unknown 才写 holder unknown', pendingUnknown.status === 'pending_review' && pendingUnknown.report.pendingReasons.some((reason) => reason.includes('directional_agent_pending')) && acceptedUnknown.status === 'ready' && unknownObject?.kind === 'object_state' && unknownObject.holderId === null && unknownObject.holderStatus === 'unknown', JSON.stringify({ pending: pendingUnknown.report.pendingReasons, accepted: acceptedUnknown.status, object: unknownObject }))

  console.log(`\nP1-3/P2-5 scene semantics: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

try {
  main()
} catch (error) {
  console.error('P1-3/P2-5 scene semantics 执行异常：', error)
  process.exitCode = 2
}
