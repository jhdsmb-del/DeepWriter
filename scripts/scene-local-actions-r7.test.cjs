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
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent', plugins: [{ name: 'r7-source-only', setup(build) {
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
  '23:00，林舟在值班室按下手电筒开关，光柱扫过墙上停摆的挂钟和顾岚手中的档案柜钥匙。',
  '顾岚将钥匙插入值班台抽屉锁孔，转动后取出关停灯塔的操作手册，放在台面上。',
  '林舟走近值班台，伸手将手电筒光束停在手册封面，问起旧海难档案附页的下落。',
  '顾岚合上手册，用钥匙轻敲台面，说附页不在值班室，并提醒林舟灯塔必须按时关停。'
]
function contractFor(items, names = []) {
  const outline = { title: 'R7 local event fixture', premise: '', targetChars: 1700, sections: [{ id: 's1', title: '现场', purpose: '从明确起点推进', targetChars: 1700, beats: Array.isArray(items) ? items : [items], sourceSlotIds: [] }] }
  return api.buildSceneContractPlan({ outline, characterNames: names, answers: [] }).contracts[0]
}
function evaluate(contract, candidate) { return api.evaluateSceneContract(contract, candidate, { completed: true, sceneChars: Array.from(candidate).length, scenePrefix: '' }) }
function status(beat, text, names) { return evaluate(contractFor(beat, names), text).beatEvidence[0].status }
// Immutable decoded writer-32 prose; never reads or rewrites paid R7 data.
const candidate = `二十三点整，林舟按下了手电筒的开关。

光柱从金属筒口里笔直地劈出来，先落在值班室斑驳的东墙上，那里挂着一只停摆的挂钟。钟面蒙着薄灰，指针卡在十一点差一刻的位置，像是很多年前就被人从时间里摘了下来。光柱慢慢往右移，掠过墙上泛黄的值班表、一枚锈死的挂钩、半卷垂落的防水胶带，最后停在顾岚的手上。

她正站在值班台后面，右手握着一把黄铜钥匙。钥匙不长，齿纹磨得发亮，柄端系着一截褪色的红绳。光打上去的时候，她没有躲，只是把手指收拢了一点，指节泛白。

“你还是这个习惯。”顾岚说，声音不高，像是不想让墙听见，“进门先照一圈。”

“确认一下有没有别人。”

“这里只有我。”

林舟把手电筒往下一压，光柱贴着地面扫过水泥地坪，扫过两把并排的折叠椅，扫过墙角一只倒扣的铁皮桶。值班室不大，一张值班台，两排铁柜，一扇朝北的窄窗。窗外是海，黑得没有轮廓，只有浪声一下一下拍在礁石上，闷而规律，像有人在很远的地方翻动一本厚书。

顾岚把钥匙插进值班台抽屉的锁孔。锁芯涩了一下，她手腕一沉，咔嗒一声，抽屉弹开半寸。她从里面取出一本硬壳操作手册，深蓝色封面，边角卷起，烫金的字已经剥落得只剩“关停”两个字还认得清。她把手册放在台面上，钥匙没有拔，仍旧插在锁孔里，红绳垂下来，搭在抽屉沿口。

林舟走近了。他的脚步在水泥地上发出干燥的声响。手电筒的光束抬起来，越过顾岚的手背，落在手册封面上。深蓝色被照得发白，像一块被海水泡久的布。

“旧海难那批档案，”他说，“附页在哪？”

顾岚低头看着手册封面，手指在边角上抚了一下，把卷起的地方压平。值班室里安静了几秒，只有海浪声从窄窗的缝隙里渗进来。

“附页不在值班室。”她说。

“我知道不在值班室。我是问在哪。”

“你今晚来，是为了这个？”

“我今晚来，是因为你打电话说灯塔要关停。”林舟把手电筒的光从手册上移开，照向顾岚的脸。她没有眯眼，光停在颧骨上方，照出她眼下的一层青影，像很久没有睡好。“你说要交接，让我来一趟。我来了。”

顾岚把手册合上，封面对齐，动作很慢。然后她拿起插在锁孔里的钥匙，用柄端在台面上轻轻敲了两下。黄铜磕在木头上，声音短而脆。

“灯塔必须按时关停。”她说，“凌晨四点五十，主灯熄灭，控制箱上锁。这是程序。你不能因为别的事耽误。”

“我没有说要耽误。”

“你也没说要帮忙。”

林舟把手电筒垂下来，光柱斜斜地指向台面与地面之间的空隙。他看见值班台的抽屉开着一道缝，里面除了几支笔、一盒回形针，还有一叠用橡皮筋捆住的纸。纸的边缘发黄，像是从某个更厚的卷宗里拆出来的。他没有立刻去碰。

“那批旧海难档案，”他说，“去年移交的时候少了一张附页。清单上有，柜子里没有。”

“你查过清单？”

“我看过移交记录。”

顾岚把钥匙放在台面上，红绳散开，像一小段被抽出来的血线。她两只手撑住台沿，身体微微前倾，看着林舟。值班室里那盏顶灯没有开，唯一的光源就是林舟手里的电筒，两个人的影子被拉长，投在背后的铁柜上，交叠又分开。

“移交记录是内部文件。”她说。

“你在档案室做过三年。”

“所以我知道那批东西有多脆。”顾岚的声音仍旧平，但语速比刚才慢了半拍，“纸一碰就碎，潮气一重就霉。附页就算在，也不该随便拿出来。”

“在不在，你说了不算。”林舟说，“清单说了算。”

顾岚直起身，把钥匙从台面上拿起来，握回掌心。她转身走向值班室北侧的铁门，门后是一条通往档案室的窄廊。走到门口时，她停了一下，没有回头。

“你要跟来，就把手电筒关小一点。”她说，“档案室的灯管坏了，但纸怕强光。”

林舟没有立刻跟上去。他站在原地，手电筒的光落在值班台抽屉那道缝里，那叠捆着橡皮筋的纸还在原处，边缘被光照出一层毛茸茸的暗黄。他伸手把抽屉推回去，锁舌弹进孔里，发出一声轻响。

然后他抬起手电筒，光柱重新劈开黑暗，照着顾岚的背影消失在窄廊尽头。

他听见钥匙在远处响了一下，像是什么锁被打开了。海浪声从窗缝里挤进来，一下，又一下。墙上那只停摆的挂钟在光柱边缘闪了一下，指针仍旧卡在十一点差一刻，仿佛从他们进门到现在，时间根本没有动过。

林舟跟了上去。`
test('immutable R7 actual actions have local evidence; unresolved topics defer into bounded repair', () => {
  assert.equal(Array.from(candidate).length, 1700)
  assert.equal(createHash('sha256').update(candidate).digest('hex'), '60318a1bdfdc5f92654b27fdc97341aa8a42bb3dcb9c1a035c7ac0b465eb4a49')
  const contract = contractFor(beats)
  const result = evaluate(contract, candidate)
  assert.equal(contract.requiredBeatEvidence.some(api.isOpaqueSceneBeatRequirement), false)
  assert.equal(contract.requiredBeatEvidence.some(beat => beat.eventGroups.some(group => group.agent.length === 0)), false)
  assert.equal(contract.requiredBeatEvidence[2].actuality, 'asserted_actual')
  assert.deepEqual(result.beatEvidence.map(beat => beat.status), ['missing', 'missing', 'missing', 'satisfied'])
  const press = result.beatEvidence[0].eventGroups.find(group => group.action === 'press')
  assert.deepEqual(press.agent, ['林舟'])
  assert.deepEqual(press.patient, ['手电筒的开关'])
  assert.deepEqual(press.location, ['值班室'])
  assert.equal(api.sceneBeatRepairEligible(contract, result, true), true)
  assert.equal(api.buildSceneCompletionDecision(contract, candidate, { candidateSegmentId: 'r7-replay', evaluation: result, scenePrefix: '' }).status, 'defer')
  assert.ok(result.beatEvidence.every(beat => Object.values(beat.matched).flat().every(value => value.length <= 80)))
  console.log('R7 structured replay', JSON.stringify({ statuses: result.beatEvidence.map(beat => beat.status), repairEligible: api.sceneBeatRepairEligible(contract, result, true) }))
})
test('close/knock/beam/ask are local asserted narrator acts, independent of topic truth', () => {
  for (const name of ['沈遥', '许澈']) for (const [beat, text] of [
    [`${name}合上手册。`, `${name}把手册关合。`],
    [`${name}用钥匙轻敲台面。`, `${name}拿起钥匙，用柄端在台面上轻轻敲了两下。`],
    [`${name}将手电筒光束停在手册封面。`, `${name}站在桌前。手电筒的光束抬起来，落在手册封面上。`],
    [`${name}问起档案附页的下落。`, `${name}询问档案附页的下落。`],
    [`${name}取出手册。`, `${name}站在桌前。她从里面取出手册。`]
  ]) assert.equal(status(beat, text), 'satisfied', text)
  assert.equal(status('沈遥将钥匙插入锁孔，转动后取出手册。', '沈遥站在桌前。她从抽屉取出手册。'), 'satisfied')
})
test('negation, plans, other subjects, mixed patients and ambiguous pronouns cannot pass', () => {
  for (const [beat, text] of [
    ['沈遥合上手册。', '沈遥没有合上手册。'],
    ['沈遥用钥匙轻敲台面。', '沈遥想用钥匙敲击台面，却未敲。'],
    ['沈遥问起附页的下落。', '沈遥站在门口。许澈问起附页的下落。'],
    ['沈遥用钥匙轻敲台面。', '沈遥拿起手册，用柄端敲击台面。钥匙在桌上。'],
    ['沈遥合上手册。', '沈遥合上钥匙盒。许澈拿着手册。'],
    ['沈遥合上手册。', '沈遥和许澈站在桌前。她合上手册。'],
    ['沈遥按下手电筒开关。', '沈遥按下台灯的开关。'],
    ['沈遥问起附页的下落。', '“沈遥问起附页的下落。”许澈说。'],
    ['沈遥打开手册。', '沈遥询问许澈是否打开手册。'],
    ['沈遥合上手册。', '“沈遥合上手册。”许澈说。她合上手册。']
  ]) assert.notEqual(status(beat, text), 'satisfied', text)
})
test('initial clock/spatial frame is bounded, never global location or quoted patient borrowing', () => {
  const beat = '23:00，沈遥在库房按下手电筒开关。'
  assert.equal(status(beat, '二十三点整，沈遥按下手电筒的开关。光柱落在库房的墙上。'), 'satisfied')
  for (const text of [
    '二十三点整，沈遥按下手电筒的开关。“光柱落在库房的墙上。”许澈说。',
    '二十三点整，沈遥离开库房。沈遥在走廊按下手电筒开关。',
    '二十三点整，沈遥在走廊按下手电筒开关。许澈站在库房。',
    '二十三点整，沈遥在走廊按下手电筒开关。过了一小时，光柱落在库房的墙上。',
    '二十三点整，沈遥按下手电筒的开关。远处光柱落在库房的墙上。'
  ]) assert.notEqual(status(beat, text), 'satisfied', text)
  const separate = contractFor([beat, '许澈在库房合上手册。'], ['沈遥', '许澈'])
  const separated = evaluate(separate, '二十三点整，沈遥按下手电筒的开关。光柱落在库房的墙上。许澈站在走廊。她合上手册。')
  assert.equal(separated.beatEvidence[0].status, 'satisfied')
  assert.notEqual(separated.beatEvidence[1].status, 'satisfied')
  const opaque = evaluate(contractFor('窗外海面漆黑。'), candidate).beatEvidence[0]
  assert.deepEqual(opaque.matched.patient, [])
})
