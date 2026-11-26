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
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent', plugins: [{ name: 'r8-source-only', setup(build) {
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
function contractFor(items, names = []) {
  return api.buildSceneContractPlan({ outline: { title: 'Local event scope fixture', premise: '', targetChars: 1400, sections: [{ id: 's1', title: '当前场', purpose: '推进局部动作', targetChars: 1400, beats: Array.isArray(items) ? items : [items], sourceSlotIds: [] }] }, characterNames: names, answers: [] }).contracts[0]
}
function evaluate(contract, candidate) {
  return api.evaluateSceneContract(contract, candidate, { completed: true, sceneChars: Array.from(candidate).length, scenePrefix: '' })
}
function status(beat, text) { return evaluate(contractFor(beat, ['陆沉', '许澈']), text).beatEvidence[0].status }
// Immutable decoded R8 writer-35 prose; no dependency on paid evidence at test time.
const candidate = "二十三时整，灯塔值班室的挂钟发出一声干涩的咔嗒，分针跳过最后一格。林舟推亮手电筒，一束白光从掌心炸开，扫过斑驳的水泥墙面，掠过两把并排的折叠椅、一张铁架桌、桌角一只搪瓷杯，杯底沉着隔夜的茶渍。光柱在房间四角各停了一瞬，门后、柜侧、窗台，没有第三个人的影子，也没有第三个人的呼吸。海风从窗缝里钻进来，带着咸腥和铁锈味，把墙上一张褪色的潮汐表吹得微微掀起一角。\n\n他把手电筒搁在桌上，光仍亮着，斜斜地打向天花板，把整个房间照成一种半明半暗的灰白。值班室不大，一张桌、两把椅、一排档案柜，外加角落里的铁皮柜，几乎占满了所有能站人的地方。窗外是海，黑得像一块没有纹路的石头，偶尔有浪拍在礁石上，声音闷闷地传进来，像是有人在很远的地方敲一扇关死的门。\n\n顾岚站在铁皮柜前，手里握着一把黄铜钥匙，钥匙齿磨得发亮，柄上缠着一圈发黑的胶布。她没有看林舟，只把钥匙插进锁孔，手腕一转，锁芯发出清脆的一声。柜门开了，里面码着几本硬壳登记簿，脊背上的标签褪了色，编号只剩最后一位还能辨认。她抽出最上面那本，翻到中间某页，低头看了几秒，然后合上，把钥匙从锁孔里拔出来，收回外套右边的口袋。动作很稳，像是做过很多遍。\n\n林舟坐在桌边，手搭在桌沿，指尖离手电筒大约一掌的距离。他看着她把钥匙收好，没有开口。两人认识太久，久到沉默本身已经是一种语言。他知道她不会无缘无故在这个点来灯塔，她也知道他不该在这个点出现在这里。但谁都没有先问。\n\n“关停的事，”林舟终于说，声音压得很低，像是怕被海风带走，“怎么安排？”\n\n顾岚把登记簿抱在胸前，侧过身来。灯光从桌面斜照上去，在她脸上切出一道明暗分界，鼻梁以下沉在暗处，眼睛却亮着，反着一点手电筒的白光。“零点开始，逐项断电，主灯最后关。”她说，“控制台在塔顶，步骤我背得下来。你不需要上去。”\n\n“我没问需不需要。”\n\n“我知道你没问。”她顿了一下，“我只是先说清楚。”\n\n林舟把手从桌沿收回来，搁到膝盖上。他注意到她抱登记簿的姿势，两只手都压在封面上，指节微微发白。那本簿子他见过，记录灯塔日常运行，每天的开关时间、电压、异常情况，都有人用蓝黑墨水一笔一画填进去。他记得那场海难发生的月份，也记得那几页应该有的记录。但此刻他不能直接要，直接要就等于把底牌摊开。\n\n“灯塔关停之后，”他说，“档案怎么处理？”\n\n顾岚的目光在他脸上停了一瞬，又移开，落到墙角那排档案柜上。“该封存的封存，该移交的移交。上面有流程。”\n\n“旧海难那批呢？”\n\n她没有立刻回答。窗外一道浪打上来，比刚才那声更响，水花溅在玻璃上，留下几道蜿蜒的水痕。顾岚走到桌边，伸手去够手电筒，像是要借光看清登记簿上的某行字迹。她的手指刚碰到筒身，林舟的手已经先一步覆上去，把电筒拿回自己手里，光柱顺势一转，打向对面的墙壁，照出一片空白的水泥和一道细长的裂缝。\n\n顾岚的手停在半空，停了两秒，然后若无其事地收回去，插进外套口袋。她的右手在口袋里握住了那把钥匙，林舟听见金属轻轻碰了一下布料。\n\n“那批档案在档案室。”她说，语气没有起伏，“附页不在登记簿里，你知道的。”\n\n“我知道附页不在登记簿里。”林舟把手电筒换到左手，光柱压低，照在两人之间的地面上，形成一个晃动的圆。“所以我才问。”\n\n顾岚低头看了一眼那个光圈，又抬起头。她的表情没有变化，但林舟认识她太久了，久到能看出她下颌线绷紧了一点点，像是咬住了后槽牙。她转身走回铁皮柜前，把登记簿放回原位，动作比刚才慢了一些，书脊对准原来的位置，分毫不差。然后她掏出钥匙，重新锁上柜门，钥匙转到底，又往回拧了半圈确认锁死，才把钥匙收回口袋。\n\n“档案室在楼下。”她说，“你要去，现在就去。我零点前要上塔顶。”\n\n林舟站起来，手电筒的光柱随着他的动作扫过桌面，扫过那两只折叠椅，最后落在门口。门板上有一道旧划痕，从把手一直延伸到地面，像是有人用钥匙或别的什么硬物反复刮过。他走过去，拉开门，海风立刻灌进来，把他额前的头发吹得往后倒。走廊里没有灯，只有他手里这一束光，照出水泥台阶一级一级往下延伸，通向更深的黑暗。\n\n“你先。”他说。\n\n顾岚从他身边走过，肩膀离他大约半尺，没有碰到。她走得很稳，脚步落在台阶上几乎没有声音。林舟跟在她身后，手电筒的光越过她的头顶，照亮前方转角处的墙壁。墙上挂着一只锈蚀的灭火器，旁边贴着一张泛黄的疏散图，图上的箭头已经模糊得看不清方向。\n\n下到一半，顾岚忽然停了一步。林舟差点撞上她的后背，及时收住脚。她没有回头，只是说了一句：“附页的事，你从谁那里听来的？”\n\n“没人告诉我。”林舟说，“我自己查的。”\n\n顾岚沉默了几秒，继续往下走。她的声音从前面传回来，被楼梯间的回声拉得有些变形：“那你查得挺深。”\n\n林舟没有接话。手电筒的光柱在她后背上晃了一下，又稳住。他能看见她外套右口袋里钥匙的轮廓，一个方方正正的凸起，随着她下楼的节奏轻轻晃动。那里面还有别的东西，一小叠折起来的纸，边角从口袋缝里露出一线白。他没有问那是什么。\n\n到了楼梯底部，一扇铁门横在面前，门上的漆剥落了大半，露出底下暗红色的锈。顾岚伸手推门，门轴发出一声长长的呻吟，像是很久没有上油。门后是档案室，比值班室更小，四面墙有三面都是档案柜，铁皮柜门一排排锁着，编号用白漆刷在柜门上，有些已经斑驳得只剩半个数字。空气里有一股陈年的纸味，混着潮湿和铁锈，沉甸甸地压在鼻腔里。\n\n林舟把手电筒举高，光柱扫过柜门上的编号，从A排到F，又从F扫回来。他停在一排柜子前，编号是D-7，柜门上的白漆数字比其他柜子新一些，像是后来补刷的。他伸手在柜门上敲了两下，声音发闷，里面塞得很满。\n\n“钥匙。”他说，没有回头。\n\n顾岚站在他身后半步远的地方，从口袋里掏出那把黄铜钥匙。她没有立刻递过去，而是自己走上前，把钥匙插进D-7的锁孔。锁芯比值班室那个涩，她拧了两下才转开，柜门弹开一条缝，一股更浓的旧纸气味涌出来。\n\n林舟把手电筒照进柜内。里面码着一叠叠牛皮纸档案袋，袋口用棉线缠着，标签上的字迹已经褪成浅褐色。最上面那一叠，标签上写着“海难调查·附卷”，日期是十几年前。顾岚伸手去抽那叠档案，林舟同时伸出手，按住了最上面一页的边缘。两人的手叠在一起，谁都没有先松开。档案袋的纸边有些脆，被两股力道同时作用，发出细微的窸窣声。僵持了大约三四秒，林舟先松了手。顾岚把档案袋抽出来，抱在怀里，退后半步。\n\n“你要找的附页，”她说，“不在这叠里。”\n\n“我知道。”林舟把手电筒的光从她脸上移开，照向柜子底部。D-7柜底积了一层薄灰，灰面上有一道清晰的压痕，长方形，比普通信纸略窄，边缘整齐。压痕旁边的灰被蹭掉了一小片，露出铁皮底色，上面沾着几粒细碎的纸屑，白色的，像是从某张纸的折痕处掉下来的。他用手指碰了碰那道压痕，灰很干，但压痕的边缘有些模糊，说明东西被抽走又放回来过，时间不算太久。\n\n他把手电筒转回顾岚的方向。光柱打在她胸口，照亮她怀里那叠档案袋的标签。她没有躲光，只是微微眯起眼睛。\n\n“柜底的压痕，”林舟说，“是附页的尺寸。”\n\n顾岚低头看了一眼柜底，又抬起头。她的表情仍然平静，但抱着档案袋的手指收紧了，指甲在牛皮纸上掐出几道浅印。她没有否认，也没有解释，只是把怀里的档案袋放回柜中，动作很轻，像是怕弄碎那些脆纸。然后她侧过身，伸手探进D-7旁边那格柜子的夹层——那格柜门没有锁，只是虚掩着，里面塞着一卷旧海图。她的手指在海图卷和柜壁之间摸索了几秒，抽出一张对折的纸。\n\n纸很旧，折痕处已经发毛，边缘有一圈深褐色的水渍。她把纸展开，手电筒的光正好落在上面。那是一张手写的记录附页，格式和登记簿相似，但墨迹不同，是更深的蓝黑色，笔压很重，有些笔画几乎划破了纸面。附页上列着几行时间与操作记录，其中一行写着“23:47 开闸”，后面跟着一个签名缩写，两个字，第一个字是“顾”。\n\n林舟看清了那个时间。23:47。那场海难发生的夜晚，灯塔的开闸记录。他的手电筒没有晃，光柱稳稳地停在那行字上。顾岚也没有动，只是把附页举在两人之间，像是让他看，又像是在等他伸手。\n\n他没有伸手。\n\n“23:47。”他说，声音很平。\n\n顾岚把附页重新对折，折痕压得很实。她没有看他，只是把那张纸塞回海图卷和柜壁之间的夹层，动作和取出时一样，不紧不慢。然后她关上D-7的柜门，用钥匙锁好，钥匙转到底，又往回拧了半圈。她把钥匙收回口袋，和值班室那把放在一起，金属在布料下碰出轻轻一声。\n\n两人站在档案室里，谁都没有说话。手电筒的光柱垂向地面，在水泥地上照出一个晃动的圆。头顶某处传来海浪拍打塔基的声音，闷而远，像是从另一个世界传来的。林舟听见自己的呼吸，也听见顾岚的呼吸，两个人的节奏不一样，但都在这个狭小的空间里被放大了。\n\n“走吧。”顾岚说，“我该上去了。”\n\n她先转身走向门口，脚步比来时快了一些。林舟跟在她身后，手电筒的光照着她的后背，照见她外套右口袋里钥匙和那叠纸的轮廓。铁门在两人身后合上，门轴又发出一声长长的呻吟，像是一声没有说完的话。\n\n楼梯向上延伸，通往塔顶。顾岚走在前面，脚步落在铁踏板上，发出有节奏的轻响。林舟跟在后面，手电筒的光越过她的肩头，照亮前方一级级向上的台阶。他没有再提附页的事，也没有提23:47。有些东西已经摊开了，但还没有到收拢的时候。\n\n塔顶的铁门在头顶上方，门缝里透出一线微弱的红光，那是灯塔主灯还在运转的余晖。顾岚伸手推门，海风立刻灌满楼梯间，带着破晓前最浓的凉意。林舟把手电筒换到右手，光柱穿过门缝，照向塔顶平台的水泥地面。那里有一台控制台，面板上亮着几盏指示灯，红的绿的，在黑暗里像几只不眨的眼睛。\n\n顾岚走上平台，径直走向控制台。林舟跟上去，手电筒的光照着她的操作。她先按下主电源的切换钮，面板上一排指示灯依次熄灭，只剩最后一盏绿灯还在闪。然后她伸手去够控制台侧面的一个铁盒，盒盖上积了灰，她用袖子擦了一下，打开盒盖，里面是一叠旧操作单，最上面那张已经发黄，边缘卷曲。\n\n林舟的手电筒光落在铁盒里。最上面那张操作单上，有一行手写的记录，时间写着“23:47”，后面跟着“开闸”两个字，签名缩写和附页上的一模一样。顾岚的手停在铁盒上方，没有立刻去拿那张单子。林舟看见她的手指微微蜷了一下，又松开。\n\n他后退一步，把手电筒和那张操作单一起举高。光柱从高处照下来，照出顾岚停在半空的手，照出她脸上第一次出现的、无法完全压住的动摇。她的嘴唇动了一下，像是要说什么，但没有发出声音。\n\n“23:47。”林舟说，声音在塔顶的风里显得很轻，“附页上也是这个时间。”\n\n顾岚的手慢慢放下来，垂在身侧。她没有去抢那张单子，也没有转身走开。她只是站在那里，背对着灯塔主灯最后那点余晖，看着林舟手里那张发黄的纸。\n\n“是我签的。”她说，“那晚开闸的人是我。”\n\n海风从平台边缘吹上来，把操作单的一角吹得翻卷起来。林舟用拇指压住纸边，光柱没有晃。他看着她，没有追问为什么，也没有说别的。他只是把操作单从铁盒里抽出来，和口袋里那张从档案室带出来的附页——他在顾岚转身锁柜时从夹层边角抽走的——并排放在控制台的台面上。两张纸上的时间挨在一起，23:47，像两道对不上的伤口。\n\n顾岚低头看着那两张纸，看了很久。然后她伸手按下控制台上最后一盏绿灯。主灯发出一声低沉的嗡鸣，光柱在塔顶旋转了几圈，慢慢暗下去。海面上最后那点红光消失了，塔顶只剩林舟手电筒的白光，照着两个人的脸，照着控制台上那两张并排的纸。\n\n“关停了。”顾岚说。\n\n林舟把手电筒的光从她脸上移开，照向控制台旁边的档案袋——那是他上楼前从值班室柜子里取出来的，空白的，牛皮纸，棉线封口。他把操作单和附页一起收进档案袋，缠好棉线。顾岚看着他做这些，没有阻止，也没有帮忙。她只是站在控制台前，一只手按在台面上，手指微微发颤。\n\n天边开始发灰，海平线上露出一线极淡的青白。破晓前的风最冷，从平台边缘灌上来，把两个人的衣角吹得猎猎作响。林舟把档案袋夹在腋下，拿起手电筒，转身走向塔顶的铁门。顾岚跟在他身后，脚步比来时慢了很多。两人一前一后走下楼梯，谁都没有再提那两张纸，也没有提那晚的事。\n\n回到值班室时，窗外的天已经亮了大半，灰蓝色的光从窗缝里渗进来，和手电筒的白光混在一起，把整个房间照得有些发白。林舟走到桌边，关掉手电筒，把它放在桌面正中。顾岚从口袋里掏出那把黄铜钥匙，放在手电筒旁边，钥匙和金属筒身碰出清脆的一声。\n\n她走到铁皮柜前，打开柜门——锁已经开了，她刚才在楼上时就用钥匙开过。林舟把腋下的档案袋取下来，放进柜中，和那几本登记簿并排靠在一起。顾岚伸手把档案袋往里推了推，让它的边和登记簿对齐，然后关上柜门，用钥匙重新锁上。锁芯转到底，又往回拧了半圈。\n\n林舟拿起手电筒，走向门口。他走到门边，手搭在把手上，停了一下。身后没有脚步声跟上来。他回过头，看见顾岚还站在铁皮柜前，一只手按在锁好的柜门上，手指贴着冰冷的铁皮。窗外的天光已经亮起来，照在她侧脸上，照出眼角一道很细的纹路。她没有看他，也没有说话。\n\n林舟拉开门，海风灌进来，带着破晓后第一缕暖意。他走出去，门在身后慢慢合上。走廊里已经能看清台阶的轮廓，水泥地面泛着灰白的光。他往下走了两级，又停下来，回头看了一眼那扇关上的门。门缝里透出一线光，很细，很静。\n\n他把手电筒收进口袋，继续往下走。脚步声在楼梯间里回荡，一级，又一级，最后消失在灯塔底部的出口处。外面，海面已经亮成一片银灰色，浪一层层推上来，又退回去，像是要把什么留在岸上，又像是要把什么带走。"
const beats = [
  "23:00，林舟在值班室推亮手电筒，光柱扫过墙面与桌面，确认值班室没有第三人在场。",
  "顾岚用档案柜钥匙打开值班室角落的柜门，取出登记簿翻到某页后合上，把钥匙收回口袋。",
  "林舟把手电筒搁在桌上，光仍亮着，他问顾岚关停灯塔的安排，顾岚只答时间与步骤，不答原因。",
  "顾岚伸手去够手电筒查看登记簿字迹，林舟先一步将手电筒拿回手中，光柱转向别处。",
  "林舟提及旧海难档案附页，顾岚把登记簿放回柜中，用钥匙重新锁上柜门。"
]
test('R8 actual candidate is not contradicted by confirming absence; unresolved actions enter bounded rewrite', () => {
  assert.equal(Array.from(candidate).length, 5490)
  assert.equal(createHash('sha256').update(candidate).digest('hex'), '213aa1dad4e88acb2e6d076fb30555c6bb26c26c5ebbce73f5eaeda3d8c2e93e')
  const contract = contractFor(beats)
  assert.equal(contract.requiredBeatEvidence.some(api.isOpaqueSceneBeatRequirement), false)
  assert.equal(contract.requiredBeatEvidence.some(beat => beat.eventGroups.some(group => !group.agent.length || group.agent.some(agent => !['林舟', '顾岚'].includes(agent)))), false)
  assert.equal(contract.requiredBeatEvidence[0].negation, false)
  assert.equal(contract.requiredBeatEvidence[0].actuality, 'asserted_actual')
  const result = evaluate(contract, candidate)
  assert.deepEqual(result.beatEvidence[0].matched.time, ['23:00'], 'actual Chinese 时整 and outline numeric clock already denote the same instant')
  console.log('R8 structured replay', JSON.stringify({ statuses: result.beatEvidence.map(beat => beat.status), codes: result.violations.map(violation => violation.code), boundedRepairEligible: api.sceneBeatRepairEligible(contract, result, true) }))
  assert.equal(result.beatEvidence.every(beat => ['satisfied', 'missing'].includes(beat.status)), true)
  assert.equal(result.violations.some(violation => ['beat_contradicted', 'beat_uncertain'].includes(violation.code)), false)
  assert.equal(api.sceneBeatRepairEligible(contract, result, true), true)
  assert.equal(api.buildSceneCompletionDecision(contract, candidate, { candidateSegmentId: 'r8-replay', evaluation: result, scenePrefix: '' }).status, 'defer')
})
test('local placement, recovery, reach and inquiry preserve subject/patient and nonactual guards', () => {
  for (const action of ['推亮手电筒', '把手电筒搁在桌上', '伸手去够手电筒', '将手电筒拿回手中', '问许澈关停的安排', '将光柱转向门口']) {
    const beat = `陆沉${action}。`
    assert.equal(status(beat, beat), 'satisfied', beat)
    for (const text of [`陆沉没有${action}。`, `“陆沉${action}。”许澈说。`, `陆沉计划${action}。`, `如果陆沉${action}，许澈就离开。`, `许澈${action}。陆沉站在门口。`]) assert.notEqual(status(beat, text), 'satisfied', text)
  }
  assert.notEqual(status('陆沉将手电筒拿回手中。', '陆沉将钥匙拿回手中。许澈拿着手电筒。'), 'satisfied')
  assert.notEqual(status('陆沉将光柱转向门口。', '陆沉将钥匙转向门口。光柱在墙上。'), 'satisfied')
  assert.notEqual(status('陆沉问许澈关停的安排。', '许澈问陆沉附页的位置。陆沉站在门口。'), 'satisfied')
  assert.notEqual(status('陆沉按下开关。', '许澈问：“陆沉按下开关了吗？”'), 'satisfied')
})
test('confirming a negative proposition is actual confirmation, not negation of the confirmer action', () => {
  const beat = '陆沉确认库房没有第三人在场。'
  assert.equal(status(beat, beat), 'satisfied')
  for (const text of ['陆沉没有确认库房没有第三人在场。', '陆沉计划确认库房没有第三人在场。', '“陆沉确认库房没有第三人在场。”许澈说。', '许澈确认库房没有第三人在场。陆沉站在门口。', '陆沉确认库房有第三人在场。', '陆沉确认库房没有第三人在场这件事并非事实。']) assert.notEqual(status(beat, text), 'satisfied', text)
})
test('patient-leading same-subject chains do not create noun actors or borrow another character', () => {
  const beat = '陆沉取出记录簿翻到某页后合上，把钥匙收回口袋。'
  const contract = contractFor(beat, ['陆沉', '许澈'])
  assert.ok(contract.requiredBeatEvidence[0].eventGroups.every(group => group.agent.length === 1 && group.agent[0] === '陆沉'))
  assert.notEqual(status('陆沉把记录簿合上。', '陆沉取出记录簿，许澈把记录簿合上。'), 'satisfied')
})
