import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import { buildSceneContractPlan } from '../src/main/narrative/sceneContract'
import {
  buildNarrativeQualityPrompt,
  buildNarrativeQualityRepairInstruction,
  evaluateNarrativeQualityGate,
  narrativeQualityEvidenceMatches
} from '../src/main/narrative/narrativeQualityGate'

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

function main(): void {
  const outline: GrillMeOutline = {
    title: '雾港夜班',
    premise: '守灯人必须在暴雨前交接灯塔钥匙。',
    targetChars: 800,
    sections: [{
      id: 's1',
      title: '雨夜换班',
      purpose: '林舟抵达灯塔并与沈遥完成交接。',
      targetChars: 800,
      beats: ['林舟抵达灯塔', '沈遥交出钥匙'],
      sourceSlotIds: ['goal', 'characters']
    }]
  }
  const answers = [
    { slotId: 'characters', value: '林舟、沈遥', source: 'user' },
    { slotId: 'scope', value: '不要出现魔法', source: 'user' }
  ] as const
  const outlineHash = grillMeOutlineHash(outline)
  const plan = buildSceneContractPlan({ outline, outlineHash, answers, characterNames: ['林舟', '沈遥'] })
  const contract = plan.contracts[0]
  if (!contract) throw new Error('r59 fixture contract missing')
  const context = { sceneContract: contract, perspective: undefined as undefined, knownCharacterIds: ['林舟', '沈遥', '顾岚'] }
  const acceptedPrefix = '前文已经写到雨水沿着石墙滑落，海潮在雾里一声声撞击礁石，远处渔火渐渐熄灭。'
  const goodCandidate = '林舟握紧钥匙，沈遥在门边侧身让开。'
  const good = evaluateNarrativeQualityGate({ candidate: goodCandidate, acceptedPrefix, ...context })
  check('R59 正常候选通过且 evidence hash/字数可复算', good.status === 'passed' && good.candidateHash.length === 64 && good.acceptedPrefixHash.length === 64 && good.sceneContractHash === contract.frozenHash && good.candidateChars === Array.from(goodCandidate).length)

  const advisory = evaluateNarrativeQualityGate({
    candidate: '林舟抬头看向远处的海面。林舟抬头看向远处的海面。以下是正文：顾岚站在门外。',
    acceptedPrefix,
    ...context
  })
  check('R59 重复/角色异常/说明腔仅 advisory，不撤回候选', advisory.status === 'advisory' && advisory.findings.some((item) => item.code === 'repetition') && advisory.findings.some((item) => item.code === 'character_conflict') && advisory.findings.some((item) => item.code === 'meta_language') && advisory.findings.every((item) => item.severity === 'advisory'))

  const echoHead = '雨水沿着灯塔石墙不断滑落，风声压过海潮回响，远处渔火在雾里一盏盏熄灭，夜色漫过礁石。'
  const echo = evaluateNarrativeQualityGate({ candidate: `${echoHead}林舟抬头。`, acceptedPrefix: `前文。${echoHead}`, ...context })
  check('R59 accepted prefix 尾部回声被确定性标为 advisory', echo.status === 'advisory' && echo.findings.some((item) => item.code === 'repetition' && item.message.includes('回声')))

  const forbidden = evaluateNarrativeQualityGate({ candidate: '魔法在墙上闪烁。', acceptedPrefix, ...context })
  const firstPersonOther = evaluateNarrativeQualityGate({ candidate: '我走进灯塔，他站在门边。', acceptedPrefix, ...context, perspective: 'first' })
  const thirdPersonDialogue = evaluateNarrativeQualityGate({ candidate: '林舟说：“我会留下。”', acceptedPrefix, ...context, perspective: 'third' })
  check('R59 显式禁止项保持 blocking，代词共现与对白自称只作 advisory', forbidden.status === 'blocked' && forbidden.findings.some((item) => item.code === 'continuity_conflict' && item.severity === 'blocking') && firstPersonOther.status === 'advisory' && firstPersonOther.findings.some((item) => item.code === 'pov_conflict' && item.severity === 'advisory') && thirdPersonDialogue.status === 'advisory' && thirdPersonDialogue.findings.some((item) => item.code === 'pov_conflict' && item.severity === 'advisory'))

  check('R59 evidence 恢复需同时匹配候选/accepted prefix/契约，篡改不可假绿', narrativeQualityEvidenceMatches({ evaluation: good, candidate: goodCandidate, acceptedPrefix, ...context }) && !narrativeQualityEvidenceMatches({ evaluation: good, candidate: `${goodCandidate}篡改`, acceptedPrefix, ...context }) && !narrativeQualityEvidenceMatches({ evaluation: good, candidate: goodCandidate, acceptedPrefix: `${acceptedPrefix}篡改`, ...context }) && !narrativeQualityEvidenceMatches({ evaluation: good, candidate: goodCandidate, acceptedPrefix, sceneContract: { ...contract, frozenHash: 'tampered' }, knownCharacterIds: context.knownCharacterIds }))

  const prompt = buildNarrativeQualityPrompt(advisory)
  const repair = buildNarrativeQualityRepairInstruction(forbidden)
  check('R59 诊断/修复提示绑定三类 hash 且保留 accepted prefix', prompt.includes(advisory.candidateHash) && prompt.includes(advisory.acceptedPrefixHash) && prompt.includes(advisory.sceneContractHash) && repair.includes(forbidden.candidateHash) && repair.includes(forbidden.acceptedPrefixHash) && repair.includes('accepted prefix 原样不变'))

  console.log(`\nR59 narrative quality: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

try {
  main()
} catch (error) {
  console.error('R59 narrative quality 执行异常：', error)
  process.exitCode = 2
}
