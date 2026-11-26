const assert = require('node:assert/strict')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
before(async () => {
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    export {buildSceneContractPlan,evaluateSceneContract,buildSceneCompletionDecision,isOpaqueSceneBeatRequirement} from './src/main/narrative/sceneContract';
    export {sceneBeatRepairEligible} from './src/main/narrative/sceneBeatRepair';
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent', plugins: [{ name: 'r6-source-only', setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (!args.path.startsWith('.')) return { path: args.path, external: true }
      const target = path.resolve(args.resolveDir, args.path)
      const source = ['', '.ts', '.js', '/index.ts'].map(suffix => target + suffix).find(existsSync)
      if (!source || !source.startsWith(root + path.sep)) throw new Error('Source outside workspace')
      return { path: source, namespace: 'source' }
    })
    build.onLoad({ filter: /.*/, namespace: 'source' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }))
  } }] })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
  api = loaded.exports
})
const beats = [
  '23:00，林舟在值班室用手电筒照向墙上的值班表，确认旧海难档案附页的存放位置。',
  '顾岚进入值班室，将档案柜钥匙放入自己外套口袋，同时把灯塔关停通知放在桌上。',
  '林舟用手电筒照向通知，顾岚伸手将通知翻面，两人对关停时间与取档目的进行简短对白。',
  '顾岚拿起值班室电话听筒又放下，林舟注意到她未拨号却先看档案柜方向。'
]
function contractFor(items, names = []) {
  const outline = { title: 'R6 local event fixture', premise: '', targetChars: 1200, sections: [{ id: 'sec1', title: '值班室', purpose: '建立起点与双重目的', targetChars: 1200, beats: Array.isArray(items) ? items : [items], sourceSlotIds: [] }] }
  return api.buildSceneContractPlan({ outline, characterNames: names, answers: [] }).contracts[0]
}
function evaluate(contract, candidate) { return api.evaluateSceneContract(contract, candidate, { completed: true, sceneChars: Array.from(candidate).length, scenePrefix: '' }) }
function status(beat, candidate, names) { return evaluate(contractFor(beat, names), candidate).beatEvidence[0].status }

// Immutable prose decoded from R6 response-evidence/attempt-000027.json.
// No historical task, completion decision, or captured response is rewritten.
const candidate = `二十三时整，灯塔的值班室里只有一盏台灯亮着，灯罩压得很低，光被切成一截梯形，落在桌面上那本翻开的潮汐日志上。林舟没有坐下。他站在桌前，右手握着一支铝壳手电筒，筒身被掌心焐得温热，指腹压在开关上，没有按下去。

墙上的值班表钉在一块软木板上，纸角被海风从窗缝里钻进来吹得微微掀起。林舟把手电筒举起来，按下开关，一束白光斜斜打上去，照见表格里密密麻麻的名字和班次。他的目光从下往上移，停在一行被蓝笔圈过的日期上。那行字旁边用铅笔写了三个字：附页，柜。

他没有出声，只是把手电筒的光往下压了压，照见值班表底端一行褪色的小字，是档案室柜号的编排规则。看完，他关掉手电，光柱消失，台灯那截梯形光重新成为房间里唯一的光源。

门外传来脚步声。不快，也不慢，鞋底踩在水泥地上，带着海边夜里的潮气。门被推开，顾岚走进来。她穿一件深色外套，领子竖着，右手插在口袋里，左手拎着一只牛皮纸信封，进门后随手把信封放在桌上，动作很轻，纸角几乎没有发出声音。

林舟看了那只信封一眼。信封正面朝上，印着灯塔管理处的抬头，右下角一行打印字：关于灯塔关停的通知。

“你来得早。”顾岚说。她走到桌边，右手仍插在口袋里，没有拿出来。

“潮汐表该对一遍。”林舟说。

顾岚的目光在值班表上停了半秒，又移开。她伸手把那只信封翻了个面，背面朝上，抬头那行字被压在了下面。

“关停时间定了。”她说，“凌晨四点。上面要求先把灯停了，再做设备封存。”

林舟没有接话。他重新按亮手电筒，光打在信封背面，照见纸背透出的几行字影。顾岚的手伸过来，掌心盖在信封上，把那片光挡住了一部分。

“你照它做什么。”

“看看有没有附件。”林舟说，“关停通知一般会附设备清单。”

“没有。”顾岚说，“就一张纸。”

她的手从信封上移开，插回外套口袋。林舟注意到她右手进去之后，指节在布料下动了一下，像是把什么东西往里推了推。

“档案室还开着？”他问。

“锁着。”顾岚说，“钥匙在我这儿。”

她说这话时语气平常，但林舟看见她左手无意识地碰了碰外套右侧口袋的位置。那是一个很轻的动作，手指隔着布料按了一下，像确认钥匙还在。

“我要取一份旧档案。”林舟说，“九七年那场海难的附页。值班表上标了存放位置。”

顾岚没有立刻回答。她走到桌角，拿起值班室的电话听筒，举到耳边。听筒里没有拨号音，线是断的，这一点林舟早就知道。顾岚把听筒贴了一会儿，眼睛却越过桌面，看向走廊尽头档案室的方向。她没有拨号，也没有说话，只是听着那片沉默，然后慢慢把听筒放回机座。

“附页不在档案盒里。”她说。

“你翻过？”

“前阵子整理过。”顾岚说，“档案盒在，附页的位置只剩装订孔。”

林舟把手电筒在手里转了一圈，筒尾磕在桌沿，发出很轻的一声。他没有追问她为什么整理，也没有追问她怎么知道装订孔的事。他只是把潮汐日志合上，推到桌边，然后拿起手电筒，往门口走了一步。

“那我去看看装订孔。”他说。

顾岚站在原地，看着他的背影。台灯的光从她侧面照过去，把她半边脸留在暗处。她右手从口袋里抽出来，指尖夹着一枚铜色钥匙，钥匙齿上沾着一点灰。她低头看了一眼，又把它收回口袋。

“档案室潮。”她说，“别用手电筒照太久，纸脆。”

林舟已经走到门口。他停下来，没有回头。

“你关灯的时候，”他说，“是四点整？”

“通知上写的是四点。”顾岚说。

“我问的是你。”

值班室里安静了几秒。窗外传来海浪拍礁的声音，一下，又一下，间隔均匀，像某种被校准过的节拍。顾岚走到桌边，把那只翻面朝上的信封又翻回来，抬头那行字重新露出来。她用指尖沿着“关停”两个字划了一下，没有回答他的问题。

“走吧。”她说，“钥匙在我这儿，你打手电。”

林舟推开门，走廊里的空气比值班室更冷，带着档案室特有的霉味和旧纸味。他按亮手电筒，光柱投在前方水泥地上，照出一小片圆形光斑。身后，顾岚关掉了台灯，值班室陷入黑暗，只剩走廊里那一束移动的光。

她的脚步声跟在他后面，不快不慢，鞋底踩过光斑的边缘，又退回到暗处。林舟没有回头看她，但他听见钥匙在口袋里轻轻碰了一下，声音很细，像硬币落在木头上。

走廊尽头，档案室的门关着，门把手上挂着一块褪色的塑料牌。林舟把手电筒光照上去，牌子上写着编号，和值班表底端那行小字对得上。他站在门前，等顾岚走上来。

顾岚从他身侧经过，右手伸进口袋，掏出那枚铜色钥匙。钥匙插进锁孔时，她停了一下，侧头看了林舟一眼。手电筒的光从下往上打，照见她下颌的线条和眼底一点很淡的青色。

“进去以后，”她说，“你找你的附页。我关我的灯。各做各的。”

“好。”林舟说。

钥匙转动，锁芯发出一声干涩的响。门推开，档案室里更黑，更潮，更安静。林舟把手电筒举高，光柱扫过一排排铁皮档案柜，柜门上贴着泛黄的编号标签。他的目光在编号之间移动，最后停在其中一排的中段。

顾岚先他一步走进去，钥匙串还握在手里，没有收回口袋。`

test('R6 immutable prose still defers; real local actions do not certify missing notice/cabinet relations', () => {
  assert.equal(Array.from(candidate).length, 2017)
  assert.equal(createHash('sha256').update(candidate).digest('hex'), '2def9a8e0144875d3ae4cc68545db00b6a551e9287d26df04fc179ee067099a8')
  const contract = contractFor(beats)
  assert.deepEqual(contract.requiredBeatEvidence[0].time, ['23:00'])
  assert.equal(api.isOpaqueSceneBeatRequirement(contract.requiredBeatEvidence[2]), false)
  const phone = contract.requiredBeatEvidence[3].eventGroups.filter(group => ['pickup', 'place'].includes(group.action))
  assert.deepEqual(phone.map(group => group.agent), [['顾岚'], ['顾岚']])
  assert.deepEqual(phone.map(group => group.patient), [['电话听筒'], ['电话听筒']])
  const result = evaluate(contract, candidate)
  console.log('R6 structured replay', JSON.stringify({ statuses: result.beatEvidence.map(beat => beat.status), codes: result.violations.map(violation => violation.code), boundedRepairEligible: api.sceneBeatRepairEligible(contract, result, true) }))
  for (const index of [0, 2, 3]) assert.notEqual(result.beatEvidence[index].status, 'satisfied')
  assert.equal(result.beatEvidence.every(beat => ['satisfied', 'missing'].includes(beat.status)), true)
  assert.equal(result.violations.some(violation => ['beat_uncertain', 'beat_evidence_invalid'].includes(violation.code)), false)
  assert.equal(contract.requiredBeatEvidence.some(api.isOpaqueSceneBeatRequirement), false)
  assert.equal(contract.requiredBeatEvidence.some(beat => beat.eventGroups.some(group => group.agent.length === 0)), false)
  assert.equal(api.sceneBeatRepairEligible(contract, result, true), true, 'R6 must enter existing bounded rewrite, not semantic pending review')
  assert.deepEqual(result.beatEvidence.map(beat => beat.status), ['missing', 'satisfied', 'missing', 'missing'])
  const groups = result.beatEvidence[3].eventGroups
  assert.ok(groups.some(group => group.action === 'pickup' && group.agent.includes('顾岚') && group.patient.includes('电话听筒')))
  assert.ok(groups.some(group => group.action === 'place' && group.agent.includes('顾岚') && group.patient.includes('听筒')))
  assert.ok(groups.some(group => group.action === 'look' && group.patient.some(patient => patient.includes('档案室'))))
  assert.equal(groups.some(group => group.action === 'look' && group.patient.includes('档案柜')), false)
  assert.equal(api.buildSceneCompletionDecision(contract, candidate, { candidateSegmentId: 'r6-replay', evaluation: result, scenePrefix: '' }).status, 'defer')
})
test('untyped short-clause names and complete physical predicates bind patients and instruments', () => {
  for (const [first, second] of [['沈遥', '卫川'], ['陆沉', '许澈']]) {
    for (const [beat, text] of [
      [`${first}用手电筒照向通知。`, `${first}用手电筒照着通知。`],
      [`${second}将通知翻面。`, `${second}伸手把那张通知翻了个面。`],
      [`${second}拿起值班室电话听筒又放下。`, `${second}走到桌角，拿起值班室的电话听筒。然后她慢慢把听筒放回机座。`],
      [`${first}把手电筒举起来。`, `${first}把手电筒举高。`],
      [`${first}按下开关。`, `${first}按下开关。`],
      [`${second}先看档案柜方向。`, `${second}看向档案柜的方向。`]
    ]) assert.equal(status(beat, text), 'satisfied', text)
  }
})
test('new local verbs retain negation, quote, hypothetical, speech and plans', () => {
  for (const action of ['用手电筒照向通知', '将通知翻面', '拿起电话听筒', '把听筒放回机座', '把手电筒举高', '按下开关', '看向档案柜']) {
    const beat = `陆沉${action}。`
    assert.equal(status(beat, beat), 'satisfied', beat)
    for (const text of [`陆沉没有${action}。`, `陆沉不${action}。`, `“陆沉${action}。”许澈说。`, `如果陆沉${action}，许澈就离开。`, `陆沉计划${action}。`, `许澈说陆沉${action}。`]) assert.notEqual(status(beat, text), 'satisfied', text)
  }
})
test('objects, omitted patients and subjects cannot be borrowed across unrelated events', () => {
  for (const [beat, text] of [
    ['陆沉用手电筒照向通知。', '陆沉用台灯照向通知。'],
    ['陆沉用手电筒照向通知。', '陆沉用手电筒照向信封。许澈拿着通知。'],
    ['陆沉将通知翻面。', '陆沉把信封翻了个面。通知在桌上。'],
    ['陆沉拿起电话听筒又放下。', '陆沉拿起电话听筒，许澈放下电话听筒。'],
    ['陆沉拿起电话听筒又放下。', '陆沉拿起电话听筒。陆沉放下钥匙。'],
    ['陆沉看向档案柜方向。', '陆沉看向档案室方向。档案柜在身后。'],
    ['陆沉将通知翻面。', '陆沉站在门口。许澈将通知翻面。'],
    ['陆沉将通知翻面。', '陆沉光将通知翻面。陆沉站在门口。']
  ]) assert.notEqual(status(beat, text), 'satisfied', text)
  const beat = '向志远将通知翻面。'
  assert.equal(status(beat, '向志远将通知翻面。', ['向志远', '向志远山']), 'satisfied')
  assert.notEqual(status(beat, '向志远山将通知翻面。向志远站在门口。', ['向志远', '向志远山']), 'satisfied')
  assert.notEqual(status(beat, '向志远站在门口。向志远山将通知翻面。', ['向志远', '向志远山']), 'satisfied')
})
test('Chinese 时整/时分 clock anchors survive CRLF without accepting a wrong hour', () => {
  const beat = '23:00，陆沉在库房拿起电话听筒。'
  assert.equal(status(beat, '二十三时整，陆沉走进库房。\r\n他拿起电话听筒。'), 'satisfied')
  assert.equal(status('23:15，陆沉拿起电话听筒。', '二十三时十五分，陆沉拿起电话听筒。'), 'satisfied')
  assert.notEqual(status(beat, '二十二时整，陆沉走进库房。他拿起电话听筒。'), 'satisfied')
})
