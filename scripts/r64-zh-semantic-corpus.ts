/**
 * R64/P1-01 independent Chinese transfer-vs-disposal oracle.
 *
 * The pairs below are hand-labelled minimal contrasts.  The production
 * compiler is only the system under test; expected labels come from this
 * fixture's separately reviewed predicate oracle.  Each pair changes the
 * predicate while keeping the participants/object and, where practical, the
 * construction family constant.
 *
 * The corpus is registered in the release-candidate gate and can also be
 * audited or expanded independently. Run directly with:
 *   npx esbuild scripts/r64-zh-semantic-corpus.ts --bundle --format=esm --platform=node --outfile=out/r64-zh-semantic-corpus.mjs
 *   node out/r64-zh-semantic-corpus.mjs
 */
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'
import { buildSceneContractPlan, evaluateSceneContract } from '../src/main/narrative/sceneContract'

type PairFamily = '把' | '被' | '连动' | '兼语' | '省主语' | '倒装' | '否定' | '计划' | '传闻' | '回忆' | '梦境'

interface MinimalPair {
  family: PairFamily
  transfer: string
  nonTransfer: string
}

/**
 * The old corpus used “transfer” as a lexical predicate label.  That label is
 * still useful for testing event extraction, but it must not imply that the
 * event actually happened.  These families deliberately contain transfer
 * mentions whose event actuality is non-actual (notably 兼语 commands/requests).
 */
const NON_ACTUAL_TRANSFER_FAMILIES = new Set<PairFamily>(['兼语', '否定', '计划', '传闻', '回忆', '梦境'])

/**
 * Reviewed independently of BEAT_ACTIONS.  “把/将” and the ordinary
 * disposal predicates deliberately do not occur here.  `给` by itself is
 * also excluded: only explicit transfer predicates are positive evidence.
 */
const TRANSFER_ORACLE = /(?:交出|交给|交到|递给|递出|递过|转交|移交|给予|给与|借给|借出|借走)/u

/** 110 pairs = 220 hand-labelled sentences. */
const MINIMAL_PAIRS: readonly MinimalPair[] = [
  // 把字处置式 vs explicit transfer predicate.
  { family: '把', transfer: '林舟把钥匙交给沈遥', nonTransfer: '林舟把钥匙放在桌上' },
  { family: '把', transfer: '沈遥把密信递给林舟', nonTransfer: '沈遥把密信折好' },
  { family: '把', transfer: '卫川把徽章转交给守门人', nonTransfer: '卫川把徽章藏进盒子' },
  { family: '把', transfer: '林舟把文件移交给沈遥', nonTransfer: '林舟把文件撕碎' },
  { family: '把', transfer: '沈遥把药瓶递出窗外', nonTransfer: '沈遥把药瓶放到窗台' },
  { family: '把', transfer: '卫川把地图交到林舟手中', nonTransfer: '卫川把地图摊开' },
  { family: '把', transfer: '林舟把信物交出', nonTransfer: '林舟把信物收进衣袋' },
  { family: '把', transfer: '沈遥把戒指递过栅栏', nonTransfer: '沈遥把戒指丢进草地' },
  { family: '把', transfer: '卫川把录音笔给予沈遥', nonTransfer: '卫川把录音笔摆在桌边' },
  { family: '把', transfer: '林舟把借据借给沈遥', nonTransfer: '林舟把借据压在书下' },

  // 被字式：受事相同，改变谓词是否表达交接。
  { family: '被', transfer: '钥匙被沈遥递给林舟', nonTransfer: '钥匙被沈遥放到桌上' },
  { family: '被', transfer: '密信被林舟转交给守门人', nonTransfer: '密信被林舟收进抽屉' },
  { family: '被', transfer: '徽章被卫川移交给沈遥', nonTransfer: '徽章被卫川藏进盒子' },
  { family: '被', transfer: '文件被沈遥交给林舟', nonTransfer: '文件被沈遥撕成碎片' },
  { family: '被', transfer: '药瓶被林舟递出窗外', nonTransfer: '药瓶被林舟留在窗台' },
  { family: '被', transfer: '地图被门卫交到林舟手中', nonTransfer: '地图被门卫摊在桌面' },
  { family: '被', transfer: '信物被卫川交出', nonTransfer: '信物被卫川锁进箱子' },
  { family: '被', transfer: '戒指被沈遥递过栅栏', nonTransfer: '戒指被沈遥埋在土里' },
  { family: '被', transfer: '录音笔被林舟给予沈遥', nonTransfer: '录音笔被林舟摆在桌边' },
  { family: '被', transfer: '借据被沈遥借给卫川', nonTransfer: '借据被沈遥夹进书中' },

  // 连动：前一动作保留，后一动作决定是否发生交接。
  { family: '连动', transfer: '林舟取出钥匙，递给沈遥', nonTransfer: '林舟取出钥匙，放在桌上' },
  { family: '连动', transfer: '沈遥拆开信封，交给林舟', nonTransfer: '沈遥拆开信封，撕成两半' },
  { family: '连动', transfer: '卫川拿起徽章，转交给守门人', nonTransfer: '卫川拿起徽章，收入盒中' },
  { family: '连动', transfer: '林舟找到文件，移交给沈遥', nonTransfer: '林舟找到文件，烧成灰烬' },
  { family: '连动', transfer: '沈遥取下药瓶，递出窗外', nonTransfer: '沈遥取下药瓶，放回柜里' },
  { family: '连动', transfer: '卫川收好地图，交到林舟手里', nonTransfer: '卫川收好地图，压在桌上' },
  { family: '连动', transfer: '林舟捡起信物，交出给卫川', nonTransfer: '林舟捡起信物，塞进衣袋' },
  { family: '连动', transfer: '沈遥摘下戒指，递过栅栏', nonTransfer: '沈遥摘下戒指，丢入草丛' },
  { family: '连动', transfer: '卫川取来录音笔，给予沈遥', nonTransfer: '卫川取来录音笔，放在桌上' },
  { family: '连动', transfer: '林舟拿出借据，借给沈遥', nonTransfer: '林舟拿出借据，夹回书里' },

  // 兼语：让/请/命令后的第二主语不能改变谓词类别。
  { family: '兼语', transfer: '林舟让沈遥把钥匙交给卫川', nonTransfer: '林舟让沈遥把钥匙放进抽屉' },
  { family: '兼语', transfer: '沈遥请卫川把密信递给林舟', nonTransfer: '沈遥请卫川把密信烧掉' },
  { family: '兼语', transfer: '卫川命守门人把徽章转交给沈遥', nonTransfer: '卫川命守门人把徽章锁起来' },
  { family: '兼语', transfer: '林舟叫沈遥把文件移交给卫川', nonTransfer: '林舟叫沈遥把文件撕碎' },
  { family: '兼语', transfer: '沈遥请林舟把药瓶递出窗外', nonTransfer: '沈遥请林舟把药瓶放回柜中' },
  { family: '兼语', transfer: '卫川命林舟把地图交到沈遥手中', nonTransfer: '卫川命林舟把地图摊开' },
  { family: '兼语', transfer: '林舟让卫川把信物交出', nonTransfer: '林舟让卫川把信物藏好' },
  { family: '兼语', transfer: '沈遥叫林舟把戒指递过栅栏', nonTransfer: '沈遥叫林舟把戒指埋下' },
  { family: '兼语', transfer: '卫川请沈遥把录音笔给予林舟', nonTransfer: '卫川请沈遥把录音笔摆好' },
  { family: '兼语', transfer: '林舟命沈遥把借据借给卫川', nonTransfer: '林舟命沈遥把借据收起来' },

  // 省主语：省略第二分句主语，不得因此丢掉后续 recipient。
  { family: '省主语', transfer: '取出钥匙，递给沈遥', nonTransfer: '取出钥匙，放在桌上' },
  { family: '省主语', transfer: '拆开信封，交给林舟', nonTransfer: '拆开信封，撕成两半' },
  { family: '省主语', transfer: '拿起徽章，转交给守门人', nonTransfer: '拿起徽章，收入盒中' },
  { family: '省主语', transfer: '找到文件，移交给沈遥', nonTransfer: '找到文件，烧成灰烬' },
  { family: '省主语', transfer: '取下药瓶，递出窗外', nonTransfer: '取下药瓶，放回柜里' },
  { family: '省主语', transfer: '收好地图，交到林舟手里', nonTransfer: '收好地图，压在桌上' },
  { family: '省主语', transfer: '捡起信物，交出给卫川', nonTransfer: '捡起信物，塞进衣袋' },
  { family: '省主语', transfer: '摘下戒指，递过栅栏', nonTransfer: '摘下戒指，丢入草丛' },
  { family: '省主语', transfer: '取来录音笔，给予沈遥', nonTransfer: '取来录音笔，放在桌边' },
  { family: '省主语', transfer: '拿出借据，借给沈遥', nonTransfer: '拿出借据，夹回书里' },

  // 倒装：物品前置，事件角色仍由局部分句绑定。
  { family: '倒装', transfer: '钥匙，林舟递给沈遥', nonTransfer: '钥匙，林舟放在桌上' },
  { family: '倒装', transfer: '密信，沈遥交给林舟', nonTransfer: '密信，沈遥撕成两半' },
  { family: '倒装', transfer: '徽章，卫川转交给守门人', nonTransfer: '徽章，卫川收入盒中' },
  { family: '倒装', transfer: '文件，林舟移交给沈遥', nonTransfer: '文件，林舟烧成灰烬' },
  { family: '倒装', transfer: '药瓶，沈遥递出窗外', nonTransfer: '药瓶，沈遥留在窗台' },
  { family: '倒装', transfer: '地图，卫川交到林舟手中', nonTransfer: '地图，卫川摊在桌面' },
  { family: '倒装', transfer: '信物，林舟交出给卫川', nonTransfer: '信物，林舟锁进箱子' },
  { family: '倒装', transfer: '戒指，沈遥递过栅栏', nonTransfer: '戒指，沈遥埋在土里' },
  { family: '倒装', transfer: '录音笔，卫川给予沈遥', nonTransfer: '录音笔，卫川摆在桌边' },
  { family: '倒装', transfer: '借据，林舟借给沈遥', nonTransfer: '借据，林舟夹进书中' },

  // 否定：同一否定框架下只替换谓词；transfer 表示仍含明确交接谓词，
  // evaluator 还必须把它当作“未发生”，不能把否定当作完成。
  { family: '否定', transfer: '林舟没有把钥匙交给沈遥', nonTransfer: '林舟没有把钥匙放到桌上' },
  { family: '否定', transfer: '沈遥并未把密信递给林舟', nonTransfer: '沈遥并未把密信折好' },
  { family: '否定', transfer: '卫川未将徽章转交给守门人', nonTransfer: '卫川未将徽章藏进盒子' },
  { family: '否定', transfer: '林舟没把文件移交给沈遥', nonTransfer: '林舟没把文件撕碎' },
  { family: '否定', transfer: '沈遥不能把药瓶递出窗外', nonTransfer: '沈遥不能把药瓶放回柜中' },
  { family: '否定', transfer: '地图没有交到林舟手中', nonTransfer: '地图没有摊在桌面' },
  { family: '否定', transfer: '信物并未交出', nonTransfer: '信物并未锁起来' },
  { family: '否定', transfer: '戒指不曾递过栅栏', nonTransfer: '戒指不曾落入草丛' },
  { family: '否定', transfer: '录音笔未给予沈遥', nonTransfer: '录音笔未摆在桌边' },
  { family: '否定', transfer: '借据没有借给沈遥', nonTransfer: '借据没有夹回书里' },

  // 计划/将来：词类不是 transfer 的替代品；计划事件仍保留谓词，
  // 但 modality 必须是 planned，不能伪装成 actual。
  { family: '计划', transfer: '林舟计划把钥匙交给沈遥', nonTransfer: '林舟计划把钥匙放到桌上' },
  { family: '计划', transfer: '沈遥打算把密信递给林舟', nonTransfer: '沈遥打算把密信折好' },
  { family: '计划', transfer: '卫川准备把徽章转交给守门人', nonTransfer: '卫川准备把徽章收进盒子' },
  { family: '计划', transfer: '林舟将要把文件移交给沈遥', nonTransfer: '林舟将要把文件烧掉' },
  { family: '计划', transfer: '沈遥准备把药瓶递出窗外', nonTransfer: '沈遥准备把药瓶放回柜中' },
  { family: '计划', transfer: '卫川打算把地图交到林舟手中', nonTransfer: '卫川打算把地图摊开' },
  { family: '计划', transfer: '林舟想把信物交出给卫川', nonTransfer: '林舟想把信物藏好' },
  { family: '计划', transfer: '沈遥准备把戒指递过栅栏', nonTransfer: '沈遥准备把戒指埋下' },
  { family: '计划', transfer: '卫川预备把录音笔给予沈遥', nonTransfer: '卫川预备把录音笔摆好' },
  { family: '计划', transfer: '林舟打算把借据借给沈遥', nonTransfer: '林舟打算把借据收起来' },

  // 传闻：来源词不能把 transfer 改写为已发生；谓词仍需独立保留。
  { family: '传闻', transfer: '据说林舟把钥匙交给了沈遥', nonTransfer: '据说林舟把钥匙放在了桌上' },
  { family: '传闻', transfer: '传闻沈遥把密信递给了林舟', nonTransfer: '传闻沈遥把密信折好了' },
  { family: '传闻', transfer: '有人说卫川把徽章转交给守门人', nonTransfer: '有人说卫川把徽章藏进盒子' },
  { family: '传闻', transfer: '据传林舟把文件移交给沈遥', nonTransfer: '据传林舟把文件撕碎' },
  { family: '传闻', transfer: '消息称沈遥把药瓶递出窗外', nonTransfer: '消息称沈遥把药瓶放回柜中' },
  { family: '传闻', transfer: '据说地图交到了林舟手中', nonTransfer: '据说地图摊在了桌面' },
  { family: '传闻', transfer: '所谓信物已经交出给卫川', nonTransfer: '所谓信物已经锁进箱子' },
  { family: '传闻', transfer: '听说戒指递过了栅栏', nonTransfer: '听说戒指埋在了土里' },
  { family: '传闻', transfer: '据称录音笔给予了沈遥', nonTransfer: '据称录音笔摆在了桌边' },
  { family: '传闻', transfer: '传言借据借给了沈遥', nonTransfer: '传言借据夹进了书里' },

  // 回忆：叙述的是记忆中的关系，不得与当前实际事件混淆。
  { family: '回忆', transfer: '林舟回忆起把钥匙交给沈遥的那天', nonTransfer: '林舟回忆起把钥匙放在桌上的那天' },
  { family: '回忆', transfer: '沈遥想起自己把密信递给林舟', nonTransfer: '沈遥想起自己把密信折好' },
  { family: '回忆', transfer: '卫川记得把徽章转交给守门人', nonTransfer: '卫川记得把徽章藏进盒子' },
  { family: '回忆', transfer: '林舟回想曾把文件移交给沈遥', nonTransfer: '林舟回想曾把文件撕碎' },
  { family: '回忆', transfer: '沈遥记得把药瓶递出窗外', nonTransfer: '沈遥记得把药瓶放回柜中' },
  { family: '回忆', transfer: '卫川回忆地图交到林舟手中', nonTransfer: '卫川回忆地图摊在桌面' },
  { family: '回忆', transfer: '林舟想起信物已经交出给卫川', nonTransfer: '林舟想起信物已经锁起来' },
  { family: '回忆', transfer: '沈遥记得戒指递过栅栏', nonTransfer: '沈遥记得戒指埋在土里' },
  { family: '回忆', transfer: '卫川回忆录音笔给予沈遥', nonTransfer: '卫川回忆录音笔摆在桌边' },
  { family: '回忆', transfer: '林舟记得借据借给沈遥', nonTransfer: '林舟记得借据夹进书里' },

  // 梦境：同样的词形必须保留 dream modality。
  { family: '梦境', transfer: '梦里林舟把钥匙交给沈遥', nonTransfer: '梦里林舟把钥匙放在桌上' },
  { family: '梦境', transfer: '梦中沈遥把密信递给林舟', nonTransfer: '梦中沈遥把密信折好' },
  { family: '梦境', transfer: '梦里卫川把徽章转交给守门人', nonTransfer: '梦里卫川把徽章藏进盒子' },
  { family: '梦境', transfer: '梦中林舟把文件移交给沈遥', nonTransfer: '梦中林舟把文件撕碎' },
  { family: '梦境', transfer: '梦里沈遥把药瓶递出窗外', nonTransfer: '梦里沈遥把药瓶放回柜中' },
  { family: '梦境', transfer: '梦中地图交到林舟手中', nonTransfer: '梦中地图摊在桌面' },
  { family: '梦境', transfer: '梦里信物交出给卫川', nonTransfer: '梦里信物锁进箱子' },
  { family: '梦境', transfer: '梦中戒指递过栅栏', nonTransfer: '梦中戒指埋在土里' },
  { family: '梦境', transfer: '梦里录音笔给予沈遥', nonTransfer: '梦里录音笔摆在桌边' },
  { family: '梦境', transfer: '梦中借据借给沈遥', nonTransfer: '梦中借据夹进书里' }
]

const TRANSFER_ACTIONS = new Set(['handover', 'give', 'lend'])

function outlineFor(text: string): GrillMeOutline {
  return {
    title: 'R64 中文最小对立语料',
    premise: '区分真实交接谓词与普通处置式。',
    targetChars: 100,
    sections: [{ id: 'semantic', title: text, purpose: text, targetChars: 100, beats: [text], sourceSlotIds: [] }]
  }
}

function compile(text: string) {
  const outline = outlineFor(text)
  const contract = buildSceneContractPlan({
    outline,
    outlineHash: grillMeOutlineHash(outline),
    characterNames: ['林舟', '沈遥', '卫川', '守门人']
  }).contracts[0]!
  const requirement = contract.requiredBeatEvidence?.[0]
  const evaluation = evaluateSceneContract(contract, `${text}。`, { completed: true })
  return { contract, requirement, evaluation }
}

function checkCorpus(): void {
  const all = MINIMAL_PAIRS.flatMap((pair) => [
    { family: pair.family, text: pair.transfer, expectedPredicate: true },
    { family: pair.family, text: pair.nonTransfer, expectedPredicate: false }
  ])
  const familyCounts = new Map<PairFamily, number>()
  let falsePositive = 0
  let falseNegative = 0
  let falseIntercept = 0
  let nonActualActualityCasesChecked = 0
  let nonActualTransferCases = 0
  let nonActualTransferAccepted = 0
  const nonActualTransferAcceptedExamples: string[] = []
  const failures: string[] = []

  for (const item of all) {
    const actualOracle = TRANSFER_ORACLE.test(item.text)
    if (actualOracle !== item.expectedPredicate) failures.push(`fixture oracle mismatch: ${item.text}`)
    const result = compile(item.text)
    const actions = result.requirement?.action ?? []
    const compiledTransfer = actions.some((action) => TRANSFER_ACTIONS.has(action))
    if (item.expectedPredicate && !compiledTransfer) {
      falseNegative += 1
      failures.push(`missed transfer [${item.family}]: ${item.text} -> ${JSON.stringify(actions)}`)
    }
    if (!item.expectedPredicate && compiledTransfer) {
      falsePositive += 1
      failures.push(`false transfer [${item.family}]: ${item.text} -> ${JSON.stringify(actions)}`)
    }
    // “False interception” is stricter than lexical false positive: a normal
    // disposal sentence must neither compile a transfer nor enter uncertain
    // review.  Missing/ordinary advisory is safe and remains visible to the
    // caller rather than being treated as an unverified handover.
    if (!item.expectedPredicate && (compiledTransfer || result.evaluation.beatEvidence?.[0]?.status === 'uncertain')) falseIntercept += 1
    if (item.expectedPredicate && NON_ACTUAL_TRANSFER_FAMILIES.has(item.family)) {
      nonActualTransferCases += 1
      if (result.requirement?.actuality === 'asserted_actual' || result.requirement?.eventGroups?.some((group) => group.actuality === 'asserted_actual')) {
        nonActualTransferAccepted += 1
        nonActualTransferAcceptedExamples.push(`${item.family}:${item.text} -> ${result.requirement?.actuality}/${result.requirement?.eventGroups?.map((group) => group.actuality).join('|')}`)
      }
    }
    if (item.expectedPredicate && NON_ACTUAL_TRANSFER_FAMILIES.has(item.family) && result.requirement?.actuality !== 'asserted_actual') nonActualActualityCasesChecked += 1
    familyCounts.set(item.family, (familyCounts.get(item.family) ?? 0) + 1)
  }

  const chain = compile('林舟从口袋里取出钥匙，递给沈遥')
  const chainGroups = chain.requirement?.eventGroups ?? []
  const chainSatisfied = chain.evaluation.beatEvidence?.[0]?.status === 'satisfied' &&
    chain.requirement?.recipient?.includes('沈遥') === true &&
    chainGroups.some((group) => group.action === 'discover') &&
    chainGroups.some((group) => group.action === 'handover' && group.recipient.includes('沈遥'))
  if (!chainSatisfied) failures.push(`event-group chain did not satisfy: ${JSON.stringify({ requirement: chain.requirement, evidence: chain.evaluation.beatEvidence })}`)

  const ordinary = ['林舟把门关上', '林舟把灯点亮', '沈遥把信烧掉', '林舟把话说完']
  for (const text of ordinary) {
    const result = compile(text)
    if ((result.requirement?.action ?? []).includes('handover') || result.evaluation.beatEvidence?.[0]?.status === 'uncertain') failures.push(`ordinary 把 false interception: ${text}`)
  }

  const total = all.length
  const negativeTotal = all.filter((item) => !item.expectedPredicate).length
  const falseInterceptRate = negativeTotal === 0 ? 0 : falseIntercept / negativeTotal
  console.log(JSON.stringify({
    corpusSentences: total,
    minimalPairs: MINIMAL_PAIRS.length,
    families: Object.fromEntries(familyCounts),
    // Keep predicate extraction counts separate from actuality.  The
    // non-actual transfer families intentionally remain lexical positives;
    // their predicate must compile while their event actuality must not be
    // asserted_actual.
    transferPredicateExpected: all.filter((item) => item.expectedPredicate).length,
    nonTransferPredicateExpected: negativeTotal,
    falsePositive,
    falseNegative,
    falseIntercept,
    falseInterceptRate,
    nonActualActualityCasesChecked,
    nonActualTransferCases,
    nonActualTransferAccepted,
    eventGroupChainSatisfied: chainSatisfied,
    failures: failures.slice(0, 12),
    nonActualTransferAcceptedExamples: nonActualTransferAcceptedExamples.slice(0, 20)
  }))
  if (MINIMAL_PAIRS.length < 100 || total < 200 || familyCounts.size !== 11 || falsePositive > 0 || falseNegative > 0 || falseInterceptRate >= 0.01 || nonActualActualityCasesChecked !== nonActualTransferCases || nonActualTransferAccepted > 0 || !chainSatisfied || failures.length > 0) process.exitCode = 1
}

try {
  checkCorpus()
} catch (error) {
  console.error('R64 中文语义语料执行异常：', error)
  process.exitCode = 2
}
