import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildDramaticCritic,
  buildReorientationPlan,
  buildSceneContractV2,
  contentHash,
  makeExactTextSpan,
  runDramaticCritic,
  runLocalizedRevision,
  runReorientation,
  sceneContractV2Valid,
  validateReorientationPlan,
  validateSceneContractV2,
  applyLocalizedRevision
} from '../src/main/narrative/wp7Experimental'

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

function fixtureContract() {
  return buildSceneContractV2({
    contractId: 'c-wp7-1',
    sceneId: 's-wp7-1',
    revision: 2,
    sceneFunction: 'confrontation',
    povCharacterId: 'linzhou',
    entrySituation: '林舟带着钥匙进入灯塔，沈遥已经等在门边。',
    dramaticQuestion: '林舟是否愿意用信任换取灯塔的安全？',
    desires: { pov: '保住灯塔并证明自己没有背叛', opposition: '逼林舟交出钥匙' },
    failureStrategies: { pov: ['解释', '拖延'], opposition: ['威胁'] },
    escalation: { pressure: '暴雨将在一小时内封港', stakes: '灯塔熄灭会让船只失去航标' },
    choice: { actor: '林舟', action: '交出钥匙', alternatives: ['转身离开'], irreversible: true },
    cost: { payer: '林舟', immediate: '失去沈遥的信任', lasting: '必须独自承担守灯责任' },
    turn: { from: '互相猜疑', to: '暂时结盟', trigger: '钥匙落入沈遥手中' },
    valueShift: { from: '怀疑', to: '脆弱的信任' },
    revelationAndInterpretation: '钥匙并不是偷来的，而是沈遥故意放在雨里。',
    readerStateDelta: { before: ['钥匙失踪'], after: ['钥匙曾被沈遥藏起'] },
    characterKnowledgeDelta: [{ characterId: 'linzhou', learns: ['沈遥测试过他的忠诚'], remainsUnknown: ['谁泄露了航线'] }],
    relationshipDelta: [{ relationship: '林舟—沈遥', from: '敌意', to: '暂时信任' }],
    threadsToAdvance: ['灯塔钥匙'],
    threadsNotToResolve: ['泄露航线的人'],
    exitVector: { unresolvedQuestion: '谁会在暴雨后追来？', nextPressure: '港口封锁倒计时继续', requiredDirection: '下一场必须先处理追兵' },
    hardConstraints: [
      { id: 'h1', kind: 'required', statement: '灯塔钥匙' },
      { id: 'h2', kind: 'must_preserve', statement: '暴雨' },
      { id: 'h3', kind: 'forbidden', statement: '魔法' }
    ],
    softIntent: [
      { id: 'soft1', kind: 'pacing', statement: '让选择发生在倒计时压力下', priority: 80 },
      { id: 'soft2', kind: 'tone', statement: '克制而紧张' }
    ]
  })
}

function main(): void {
  const contract = fixtureContract()
  const again = fixtureContract()
  check('WP7 V2 契约 deterministic builder 字节稳定', JSON.stringify(contract) === JSON.stringify(again) && contract.frozenHash.length === 64)
  check('WP7 hard/soft 明确分离且 validator 通过', contract.hardConstraints.length === 3 && contract.softIntent.length === 2 && sceneContractV2Valid(contract))
  const tampered = { ...contract, dramaticQuestion: '篡改后的问题' }
  check('WP7 contract hash 篡改 fail-closed', !validateSceneContractV2(tampered).ok && validateSceneContractV2(tampered).errors.includes('contract_hash_mismatch'))

  const candidate = '😀林舟握住灯塔钥匙。😀林舟握住灯塔钥匙。'
  const preserve = makeExactTextSpan(candidate, 2, 8)
  const activeCritic = buildDramaticCritic({ candidate, contract, mustPreserveSpans: [preserve] })
  check('WP7 critic 只输出问题码/精确 span/影响/保留区间/局部 targets', activeCritic.issues.length > 0 && activeCritic.issues.every((item) => item.code && item.span.startUtf16 >= 0 && item.span.endUtf16 <= candidate.length && item.span.endCodePoint >= item.span.startCodePoint && item.impact && Array.isArray(item.mustPreserveSpans) && Array.isArray(item.revisionTargets)))
  check('WP7 critic Unicode span 同时提供 UTF-16 与 codepoint', activeCritic.issues.some((item) => item.span.startUtf16 !== item.span.startCodePoint))
  check('WP7 default-off critic 保持空诊断', runDramaticCritic({ candidate, contract }).issues.length === 0)
  check('WP7 explicit critic flag 才开启局部诊断', runDramaticCritic({ candidate, contract }, { dramaticCritic: true }).issues.length === activeCritic.issues.length)
  const forgedAllowedSpan = { ...makeExactTextSpan(candidate, 0, candidate.length), text: '伪造的允许区间', textHash: contentHash('伪造的允许区间') }
  const forgedAllowedReport = buildDramaticCritic({ candidate, contract, allowedRevisionSpans: [forgedAllowedSpan] })
  check('WP7 critic 伪造 allowed span 不得进入 revision target', forgedAllowedReport.revisionTargets.length === 0 && forgedAllowedReport.issues.every((item) => item.revisionTargets.length === 0))

  const revisionStart = candidate.indexOf('😀', 2)
  const revisionSpan = makeExactTextSpan(candidate, revisionStart, candidate.length)
  const revision = {
    revisionId: 'rev-1',
    span: revisionSpan,
    replacement: '沈遥接过钥匙。',
    sourceHash: contentHash(candidate)
  }
  const allowed = makeExactTextSpan(candidate, revisionStart, candidate.length)
  const applied = applyLocalizedRevision({ originalText: candidate, revisions: [revision], allowedRevisionSpans: [allowed], mustPreserveSpans: [preserve], expectedSourceHash: contentHash(candidate) })
  check('WP7 local revision 只修改允许区间且保留 must-preserve', applied.ok && applied.text.startsWith('😀林舟握住') && applied.text.endsWith('沈遥接过钥匙。'))
  const offApplied = runLocalizedRevision({ originalText: candidate, revisions: [revision], allowedRevisionSpans: [allowed], mustPreserveSpans: [preserve], expectedSourceHash: contentHash(candidate) })
  check('WP7 default-off revision 字节不变', offApplied.ok && offApplied.text === candidate && !offApplied.changed)
  const enabledApplied = runLocalizedRevision({ originalText: candidate, revisions: [revision], allowedRevisionSpans: [allowed], mustPreserveSpans: [preserve], expectedSourceHash: contentHash(candidate) }, { localizedRevision: true })
  check('WP7 explicit revision flag 才允许局部修改', enabledApplied.ok && enabledApplied.changed && enabledApplied.text !== candidate)
  const overlap = applyLocalizedRevision({ originalText: candidate, revisions: [revision, { ...revision, revisionId: 'rev-2', span: makeExactTextSpan(candidate, revisionStart + 2, candidate.length), replacement: '冲突' }], allowedRevisionSpans: [makeExactTextSpan(candidate, revisionStart, candidate.length)] })
  check('WP7 overlapping targets fail-closed', !overlap.ok && overlap.error === 'revision_target_overlap' && overlap.text === candidate)
  const outside = applyLocalizedRevision({ originalText: candidate, revisions: [{ ...revision, span: makeExactTextSpan(candidate, 0, 2), revisionId: 'rev-out' }], allowedRevisionSpans: [makeExactTextSpan(candidate, revisionStart, candidate.length)] })
  check('WP7 out-of-bounds target fail-closed', !outside.ok && outside.error === 'revision_target_out_of_bounds' && outside.text === candidate)
  const hashWrong = applyLocalizedRevision({ originalText: candidate, revisions: [revision], allowedRevisionSpans: [allowed], expectedSourceHash: contentHash('tampered') })
  check('WP7 wrong hash fail-closed', !hashWrong.ok && hashWrong.error === 'revision_source_hash_mismatch' && hashWrong.text === candidate)
  const preserveViolation = applyLocalizedRevision({ originalText: candidate, revisions: [{ ...revision, span: makeExactTextSpan(candidate, 2, 8), revisionId: 'rev-preserve' }], allowedRevisionSpans: [makeExactTextSpan(candidate, 2, 8)], mustPreserveSpans: [preserve] })
  check('WP7 must-preserve intersection fail-closed', !preserveViolation.ok && preserveViolation.error === 'revision_must_preserve_violation')
  const aliasPreserve = { start: 0, end: 3, text: 'abc', textHash: contentHash('abc') } as any
  const aliasBypass = applyLocalizedRevision({
    originalText: 'abcdef',
    revisions: [{ revisionId: 'rev-alias', span: makeExactTextSpan('abcdef', 0, 1), replacement: 'X' }],
    allowedRevisionSpans: [makeExactTextSpan('abcdef', 0, 6)],
    mustPreserveSpans: [aliasPreserve]
  })
  check('WP7 start/end alias 不得绕过 must-preserve（abc 不得变成 Xbcdef）', !aliasBypass.ok && aliasBypass.text === 'abcdef' && aliasBypass.error === 'revision_must_preserve_violation')

  const acceptedHashes = ['h1', 'h2', 'h3']
  const reoriented = buildReorientationPlan({ completedSceneCount: 3, lastReorientationScene: 0, sceneIds: ['s1', 's2', 's3'], acceptedSceneHashes: acceptedHashes, chapterObjective: '逼近真相', agencyFocus: '让林舟主动选择', pressureToEscalate: '追兵逼近', nextIrreversibleChoice: '烧掉航图' })
  check('WP7 reorientation 3–5 场只生成未来 intent', reoriented.due && !reoriented.overdue && reoriented.futureIntent?.nextIrreversibleChoice === '烧掉航图' && validateReorientationPlan(reoriented).ok && JSON.stringify(reoriented.sourceSceneHashes) === JSON.stringify(acceptedHashes))
  check('WP7 reorientation future window 固定为 3–5 场', reoriented.futureWindow?.minScenes === 3 && reoriented.futureWindow?.maxScenes === 5)
  const missingFuture = buildReorientationPlan({ completedSceneCount: 3, lastReorientationScene: 0, sceneIds: ['s1', 's2', 's3'], acceptedSceneHashes: acceptedHashes })
  check('WP7 reorientation due=true 不得携带空 future intent', !missingFuture.due && missingFuture.futureIntent === null && validateReorientationPlan(missingFuture).ok)
  const notYet = buildReorientationPlan({ completedSceneCount: 2, lastReorientationScene: 0, chapterObjective: '尚未到点' })
  check('WP7 reorientation 少于 3 场不触发', !notYet.due && notYet.futureIntent === null)
  const reorientationOff = runReorientation({ completedSceneCount: 3, lastReorientationScene: 0, chapterObjective: '未来目标' })
  check('WP7 default-off reorientation 不产生未来意图', !reorientationOff.due && reorientationOff.futureIntent === null)
  const reorientationEnabled = runReorientation({ completedSceneCount: 3, lastReorientationScene: 0, chapterObjective: '未来目标', nextIrreversibleChoice: '作出选择' }, { reorientation: true })
  check('WP7 explicit reorientation flag 才产出未来意图', reorientationEnabled.due && reorientationEnabled.futureIntent?.nextIrreversibleChoice === '作出选择')

  const indexText = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
  const engineText = readFileSync(resolve(process.cwd(), 'src/main/jobs/AgentRunEngine.ts'), 'utf8')
  const productionImport = /^\s*import\s+.*(?:narrativeV2|sceneContractV2|dramaticCritic|localizedRevision|reorientation|wp7Experimental)/mu
  check('WP7 production-import red：主链尚未接入实验模块', !productionImport.test(indexText) && !productionImport.test(engineText))
  check('WP7 无第二 writer 接口', !/(writer2|secondaryWriter|multiWriter|parallelWriter)/iu.test(indexText + engineText))

  console.log(`\nWP7 experimental core: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

try {
  main()
} catch (error) {
  console.error('WP7 experimental core 执行异常：', error)
  process.exitCode = 2
}
