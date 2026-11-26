import { createHash } from 'node:crypto'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import {
  buildSceneContractPlan,
  buildSceneContractPrompt,
  buildSceneContractRepairInstruction,
  evaluateSceneContract,
  sceneContractPlanValid,
  sceneContractStartChars,
  selectSceneContract
} from '../src/main/narrative/sceneContract'

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
    premise: '守灯人必须在暴雨前交接一把失而复得的灯塔钥匙。',
    targetChars: 1200,
    sections: [
      {
        id: 's1',
        title: '雨夜换班',
        purpose: '林舟抵达灯塔并找到沈遥，确认钥匙确实回来了。',
        targetChars: 600,
        beats: ['林舟抵达灯塔', '林舟找到沈遥', '确认钥匙回来了'],
        sourceSlotIds: ['goal', 'characters']
      },
      {
        id: 's2',
        title: '潮声里的决定',
        purpose: '两人决定在风暴前守住灯塔，并留下下一步承接。',
        targetChars: 600,
        beats: ['两人作出决定', '灯塔在风暴前亮起'],
        sourceSlotIds: ['conflict', 'ending']
      }
    ]
  }
  const outlineHash = grillMeOutlineHash(outline)
  const input = {
    outline,
    outlineHash,
    outlineRevision: 3,
    answers: [
      { slotId: 'goal', value: '完成一次有代价的交接', source: 'user' },
      { slotId: 'characters', value: '林舟、沈遥', source: 'user' },
      { slotId: 'conflict', value: '暴雨和互不信任', source: 'user' },
      { slotId: 'setting', value: '雾港灯塔', source: 'user' },
      { slotId: 'scope', value: '不要出现魔法；不要让林舟离开灯塔', source: 'user' },
      { slotId: 'ending', value: '让灯塔继续照向海面', source: 'user' }
    ],
    characterNames: ['林舟', '沈遥'],
    strongConstraints: { forbiddenTerms: ['魔法'], mustKeep: ['灯塔钥匙'] }
  } as const
  const plan = buildSceneContractPlan(input)
  const planAgain = buildSceneContractPlan(input)
  const first = plan.contracts[0]
  const second = plan.contracts[1]
  if (!first || !second) throw new Error('scene contract test fixture incomplete')

  check('R58 approved outline 编译为可验证的版本化 SceneContract', sceneContractPlanValid(plan) && plan.schemaVersion === 1 && plan.outlineHash === outlineHash && first.revision === 3 && first.order === 1)
  check('R58 contract 冻结哈希与 plan 哈希稳定', JSON.stringify(plan) === JSON.stringify(planAgain) && first.frozenHash.length === 64 && plan.planHash.length === 64)
  check('R58 contract 覆盖目标/角色/冲突/承接/目标字数', first.objective.includes('林舟') && first.activeCharacterIds.join('、') === '林舟、沈遥' && first.conflict.includes('暴雨') && first.handoff.includes('潮声里的决定') && first.targetChars.ideal === 600)
  check('R58 禁止项、来源和 mustKeep 进入契约证据', first.mustNotHappen.some((item) => item.includes('魔法')) && first.requiredFactIds.includes('goal') && first.sourceIds.includes('characters') && first.acceptanceCriteria.some((item) => item.includes('灯塔钥匙')))
  check('R58 accepted chars 按稳定场景顺序选择契约', selectSceneContract(plan, 0)?.sceneId === first.sceneId && selectSceneContract(plan, 600)?.sceneId === second.sceneId && sceneContractStartChars(plan, second) === 600)

  const candidate = '林舟抵达灯塔，林舟找到沈遥，确认钥匙回来了。'
  const good = evaluateSceneContract(first, candidate, { sceneChars: 600, completed: true })
  const bad = evaluateSceneContract(first, `${candidate} 魔法在墙上闪烁。`, { sceneChars: 600, completed: true })
  const candidateHash = createHash('sha256').update(candidate, 'utf8').digest('hex')
  check('R58 完整候选生成通过证据且 hash/字数可复算', good.status === 'passed' && good.candidateHash === candidateHash && good.candidateChars === Array.from(candidate).length && good.frozenHash === first.frozenHash, JSON.stringify(good))
  check('R58 偏航只产生 blocking deviation，不接受候选', bad.status === 'deviated' && bad.violations.some((item) => item.code === 'forbidden_fact' && item.severity === 'blocking'))
  const prompt = buildSceneContractPrompt(first, 240)
  const repair = buildSceneContractRepairInstruction(first, bad)
  check('R58 每次写作调用可注入冻结契约与定向修复指令', prompt.includes(first.frozenHash) && prompt.includes('只输出当前场景紧接正文') && repair.includes('已接受正文不变') && repair.includes(first.handoff))

  let mismatchRejected = false
  try {
    buildSceneContractPlan({ ...input, outlineHash: 'tampered' })
  } catch (error) {
    mismatchRejected = error instanceof Error && error.message === 'scene_contract_outline_hash_mismatch'
  }
  const tampered = { ...plan, contracts: plan.contracts.map((contract, index) => index === 0 ? { ...contract, objective: '被篡改' } : contract) }
  check('R58 outline hash 不匹配被拒绝且篡改契约无法通过校验', mismatchRejected && !sceneContractPlanValid(tampered))

  console.log(`\nR58 scene contract: ${passed} PASS / ${failed} FAIL`)
  process.exitCode = failed > 0 ? 1 : 0
}

try {
  main()
} catch (error) {
  console.error('R58 scene contract 执行异常：', error)
  process.exitCode = 2
}
