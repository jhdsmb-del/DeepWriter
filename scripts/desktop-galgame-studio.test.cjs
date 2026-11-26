const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { build } = require('esbuild')
const { _electron, expect } = require('@playwright/test')
const root = path.resolve(__dirname, '..')
const evidence = path.join(root, 'out/studio6-ui')
const source = String.raw`
import React from 'react'; import {createRoot} from 'react-dom/client';
import Studio from './src/renderer/src/components/GalgameStudio';
import {createGalgameStudioState} from './src/shared/galgameStudio';
import './src/renderer/src/styles.css'; import './src/renderer/src/ui-takeover.css';
const w=window as any; const counts:any={};
const base=(sessionId='s1')=>createGalgameStudioState({studioId:'studio-'+sessionId,sessionId,projectId:'ferry',projectDir:'D:/Games/last-ferry',projectMode:'create',projectName:'末班渡船'});
const assets={schemaVersion:1,characters:[{id:'keeper',name:'检票员',setting:'渡口窗口拆除前的最后一夜，收到一张三十年前的旧票。'},{id:'painter',name:'油漆工',setting:'带着姐姐画过的渡票赶到河边，想替她送回一声回应。'}],sprites:[{id:'sprite',characterId:'keeper',expression:'default',fileRefId:'sprite',displayName:'检票员.png'}],backgrounds:[{id:'bg',name:'渡口',fileRefId:'bg',displayName:'雨夜渡口.png'}],audio:[]};
const graph=__EXAMPLE_GRAPH__;
const outline={title:'末班渡船',premise:'一张五毛钱的旧渡票，两岸的末班铃声。替检票员做一次选择：敲铃，还是把票送过河？',targetChars:8000,sections:[{id:'a',title:'末班船解缆前',targetChars:2500,purpose:'油漆工送来一张旧票，对岸响起两短一长的铃声。',beats:[],sourceSlotIds:[]},{id:'b',title:'窗口前的选择',targetChars:3500,purpose:'玩家决定敲铃应他，或把票送过河，走向两条路线。',beats:[],sourceSlotIds:[]},{id:'c',title:'最后一笔账',targetChars:2000,purpose:'以空船离岸或五毛钱的最后一笔账，完成两种告别。',beats:[],sourceSlotIds:[]}]};
const interview={schemaVersion:2,stateId:'grill1',sessionId:'s1',originalTask:'末班渡船',targetChars:8000,genre:'Galgame',kind:'Galgame 剧本',slots:[],questions:[],answers:[],assumptions:[],coverage:1,round:1,noNewInfoRounds:0,readinessCooldown:0,status:'confirmed',currentQuestion:null,outline,outlineRevision:1,outlineHash:'outline',approvedOutline:outline,planning:{status:'success'},interview:{status:'success'},createdAt:1,updatedAt:1};
const snapshot=(state:any,embed=true)=>({state,sdk:{status:state.sdkReady?'ready':'missing'},assetCheck:null,branchHash:'branch',...(embed?{branchGraph:graph}:{})});
const complete=()=>({...base(),stage:'done',sdkReady:true,sdk:{version:'8.5.3',root:'D:/Tools/renpy',source:'explicit'},assetsReady:true,assets,grillConfirmed:true,outlineBranchConfirmed:true,outlineHash:'outline',branchHash:'branch',generatedFile:'game/deepwriter_generated.rpy',production:{status:'agent_applied',message:'剧情已写入并接入 start。',entryLabel:'dw_story',entryFile:'game/deepwriter_generated.rpy',integration:'connected'},lint:{ok:true,verified:true,errorCount:0,warningCount:0,output:'No errors found.',checkedAt:1}});
const f:any=w.__fixture={latest:null,grill:null,counts,graph,assets,base,complete,snapshot,play:{status:'stopped'},fail:{},delay:{},files:[],callbacks:[],interview};
const call=async(name:string,result:any)=>{counts[name]=(counts[name]||0)+1;if(f.delay[name])await new Promise(resolve=>f.delay[name]=resolve);if(f.fail[name])throw Error(f.fail[name]);return typeof result==='function'?result():result};
const get=()=>f.latest;
w.ds={
chooseDir:()=>call('chooseDir',{view:{fileRefId:'dir'},path:'D:/Games'}),openFiles:()=>call('openFiles',()=>f.files),
galgameStudioLatest:(id:string)=>call('latest',()=>id==='s2'?null:get()),galgameStudioGet:()=>call('get',get),
galgameStudioCreate:({sessionId}:any)=>call('create',()=>{f.latest=snapshot(base(sessionId),false);return f.latest.state}),
galgameStudioImport:({sessionId}:any)=>call('import',()=>{f.latest=snapshot({...base(sessionId),projectMode:'import'},false);return f.latest.state}),
galgameStudioOpenProject:()=>call('openProject',true),
galgameStudioSdkCheck:()=>call('sdkCheck',()=>{f.latest=snapshot({...f.latest.state,sdkReady:true,sdk:{version:'8.5.3'},stage:'assets_ready'},false);return {status:'ready'}}),
galgameStudioSdkChoose:()=>call('sdkChoose',{status:'cancelled'}),
galgameStudioSdkDownload:()=>call('sdkDownload',{}),galgameStudioSdkCancel:()=>{counts.cancel=(counts.cancel||0)+1;f.fail.sdkDownload='下载已取消。请重试。';if(typeof f.delay.sdkDownload==='function'){const release=f.delay.sdkDownload;delete f.delay.sdkDownload;release()}},
galgameStudioSetAssets:(_id:string,manifest:any)=>call('setAssets',()=>{f.latest=snapshot({...f.latest.state,assets:manifest,assetsReady:true,stage:'grill'},false);return {ok:true}}),
grillStart:()=>call('grillStart',()=>({...interview,status:'interviewing',approvedOutline:null,currentQuestion:{id:'question',text:'林为什么回到渡口？',options:[{id:'a',label:'向凪道歉',value:'道歉'}]}})),grillGet:()=>call('grillGet',()=>f.grill),grillCancel:()=>call('grillCancel',true),
renpyBranchGraph:()=>call('graph',graph),onGalgameStudioProgress:(cb:any)=>{f.callbacks.push(cb);return ()=>{f.callbacks=f.callbacks.filter((item:any)=>item!==cb)}},
galgameStudioConfirmPlan:(input:any)=>call('confirm',()=>{f.lastConfirm=input;f.latest=snapshot({...f.latest.state,outlineBranchConfirmed:true,stage:'generate'},false);return f.latest.state}),
galgameStudioGenerate:()=>call('generate',()=>{f.latest=snapshot({...complete(),stage:'lint/repair',lint:null},false);return {ok:true,generatedFile:'game/deepwriter_generated.rpy'}}),
galgameStudioLint:()=>call('lint',()=>{f.latest=snapshot({...f.latest.state,stage:'done',lint:complete().lint},false);return {ok:true,verified:true,errorCount:0,warningCount:0}}),
galgameStudioRepair:()=>call('repair',{ok:false,repairRounds:1,proposals:[{patch:{id:1},diff:'- jump missing\n+ jump riverbank',file:'game/deepwriter_generated.rpy',diagnostics:[]}]}),renpyApplyPatch:()=>call('apply',{ok:true}),
galgameStudioPlaytestStatus:()=>call('status',()=>f.play),galgameStudioPlaytestStart:()=>call('playStart',()=>{f.play={status:'running'};return f.play}),galgameStudioPlaytestStop:()=>call('playStop',()=>{f.play={status:'stopped',message:'试玩已停止。'};return f.play})};
const app=createRoot(document.getElementById('root')!); w.renderStudio=(id='s1')=>app.render(<main className='dw-shell' style={{height:'100vh',overflow:'auto'}}><Studio key={id+':'+(f.rev||0)} sessionId={id}/></main>);w.renderStudio();
`

test('6.0 studio actual React/Electron rendering, workflow, recovery, branch and session isolation', { timeout: 100000 }, async () => {
  await fs.mkdir(evidence, { recursive: true })
  const parser = await build({ entryPoints: [path.join(root,'src/main/renpyRoutes.ts')], bundle:true, platform:'node', format:'cjs', write:false })
  const parserModule={exports:{}}; new Function('require','module','exports',parser.outputFiles[0].text)(require,parserModule,parserModule.exports)
  const exampleGraph = await parserModule.exports.buildBranchGraph(path.join(root, 'examples/last-ferry'))
  await fs.writeFile(path.join(evidence, 'example-branch-graph.json'), JSON.stringify(exampleGraph,null,2))
  await build({ stdin: { contents: source.replace('__EXAMPLE_GRAPH__', JSON.stringify(exampleGraph)), resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(evidence, 'fixture.js'), jsx: 'automatic' })
  await fs.writeFile(path.join(evidence, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Galgame Studio component acceptance</title><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script></html>')
  await fs.writeFile(path.join(evidence, 'electron-main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const window=new BrowserWindow({width:1400,height:960,show:false,focusable:false,webPreferences:{offscreen:true,backgroundThrottling:false}});window.loadFile(${JSON.stringify(path.join(evidence, 'index.html'))})});`)
  let app
  const errors = []
  const result = { fixture: 'Production GalgameStudio, actual shared CSS and controls rendered in hidden Electron. Routes parsed from bundled examples/last-ferry with production buildBranchGraph. Controlled bridge for deterministic transitions; not a provider-quality claim.', checks: [] }
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ cwd: root, args: [path.join(evidence, 'electron-main.cjs')], env })
    const page = await app.firstWindow(); page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    const reset = async (setup = 'f.latest=null;f.grill=null') => { await page.evaluate(code => { const f=window.__fixture; new Function('f', code)(f); f.rev=(f.rev||0)+1; window.renderStudio() }, setup); await expect(page.getByText('正在恢复工作室…')).toHaveCount(0) }
    const shot = async name => { await page.screenshot({ path: path.join(evidence, name), animations: 'disabled', scale: 'css' }) }
    const fit = async () => assert(await page.locator('.galgame-studio').evaluate(el => el.scrollWidth <= el.clientWidth), 'studio has no horizontal overflow')
    const check = label => result.checks.push(label)
    await expect(page.getByRole('button', { name: '选择位置并创建', exact: true })).toBeVisible()
    await shot('galgame-studio-entry.png'); await fit(); check('Empty state has one direct create action and a separate import path')
    await page.getByLabel('项目名称').fill('末班渡船')
    await page.getByRole('button', { name: '选择位置并创建', exact: true }).click()
    await expect(page.getByRole('heading', { name: '先准备 Ren\'Py SDK' })).toBeVisible()
    assert.equal(await page.evaluate(() => window.__fixture.counts.create), 1); check('Choose directory → create reaches SDK')
    await page.getByRole('button', { name: '检查本机 SDK', exact: true }).click()
    await expect(page.getByRole('heading', { name: '人物与素材', exact: true })).toBeVisible()
    await shot('galgame-studio-assets.png'); check('SDK check advances to actual character and image controls')
    await page.getByRole('button', { name: /立绘 \/ 表情/ }).click()
    await expect(page.getByRole('alert')).toHaveCount(0); check('Cancelling a file picker preserves the draft without an error')
    await page.getByLabel('角色名').fill('凪'); await page.getByLabel('人物设定').fill('末班渡船售票员')
    await page.getByRole('button', { name: '确认素材，梳理剧情', exact: true }).click()
    await page.getByLabel('故事想法').fill('一个关于等待的渡口故事')
    await page.getByRole('button', { name: '开始提问', exact: true }).click()
    await expect(page.getByRole('heading', { name: '林为什么回到渡口？' })).toBeVisible(); check('Assets → story idea → real Grill workbench question')
    await page.getByRole('button', { name: '退出梳理' }).click(); await expect(page.getByRole('button', { name: '开始提问', exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => window.__fixture.counts.grillCancel), 1); check('Exit interview calls durable cancellation')
    await reset("f.latest=f.snapshot(f.base(),false);f.grill=null;f.delay.sdkDownload=true")
    await page.getByRole('button', { name: '下载官方 SDK 8.5.3', exact: true }).click()
    await expect(page.getByRole('button', { name: '取消下载', exact: true })).toBeVisible()
    await page.evaluate(() => window.__fixture.callbacks.forEach(cb => cb({studioId:'studio-s1',progress:{phase:'download',percent:42,message:'正在下载官方 SDK'}})))
    await expect(page.getByRole('progressbar', { name: 'SDK 下载进度' })).toHaveAttribute('value', '42')
    await page.getByRole('button', { name: '取消下载', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('下载已取消')
    await expect(page.getByRole('button', { name: '下载官方 SDK 8.5.3', exact: true })).toBeEnabled()
    check('SDK progress, explicit cancellation and retry remain reachable')
    await reset("f.latest=null;f.grill=null;delete f.fail.sdkDownload;f.counts.graph=0")
    await page.getByRole('button', { name: '导入现有项目', exact: true }).click()
    await expect(page.getByText('已导入项目', { exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => window.__fixture.counts.import), 1)
    await expect(page.getByRole('button', { name: '试玩原项目', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '检查本机 SDK', exact: true }).click()
    await expect(page.getByRole('button', { name: '试玩原项目', exact: true })).toBeVisible()
    await shot('galgame-studio-import-playtest.png')
    const generateCountBeforeOriginal = await page.evaluate(() => window.__fixture.counts.generate || 0)
    await page.getByRole('button', { name: '试玩原项目', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止试玩', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '停止试玩', exact: true }).click()
    await expect(page.getByRole('button', { name: '试玩原项目', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '试玩原项目', exact: true }).click()
    await page.evaluate(() => { window.__fixture.play={status:'stopped',message:'原项目已退出。'} })
    await expect(page.getByText('原项目已退出。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '试玩原项目', exact: true })).toBeEnabled()
    assert.equal(await page.evaluate(() => window.__fixture.latest.state.stage), 'assets_ready')
    assert.equal(await page.evaluate(() => window.__fixture.latest.state.generatedFile), null)
    assert.equal(await page.evaluate(() => window.__fixture.counts.generate || 0), generateCountBeforeOriginal)
    check('Import → SDK → play original supports stop/reopen/natural exit without assets, model generation or marking creation complete')

    await page.getByRole('button', { name: '2 剧情与分支' }).click()
    await expect(page.getByRole('button', { name: /敲铃应他/ })).toBeVisible()
    assert.equal(await page.evaluate(() => window.__fixture.counts.graph), 1)
    await page.getByRole('button', { name: /敲铃应他/ }).click()
    await expect(page.getByRole('heading', { name: 'bells', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '返回上一节点' }).click()
    await expect(page.getByRole('heading', { name: 'start', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '1 项目与素材' }).click(); await page.getByRole('button', { name: '2 剧情与分支' }).click()
    assert.equal(await page.evaluate(() => window.__fixture.counts.graph), 1); check('Import reads choices without generation gate; visiting/back works and tab reopen reuses graph')
    await reset("f.latest=f.snapshot({...f.complete(),stage:'grill',outlineBranchConfirmed:false,generatedFile:null,lint:null});f.grill=f.interview;f.counts.graph=0;f.counts.get=0")
    await expect(page.getByRole('button', { name: '确认并进入生成', exact: true })).toBeVisible()
    await page.evaluate(() => { window.__fixture.latest.branchHash='changed-branch' })
    await page.getByRole('button', { name: '刷新分支', exact: true }).click()
    await expect(page.getByRole('button', { name: '刷新分支', exact: true })).toBeEnabled()
    assert.equal(await page.evaluate(() => window.__fixture.counts.graph), 0)
    await page.getByRole('button', { name: '确认并进入生成', exact: true }).click()
    await expect(page.getByRole('button', { name: '开始生成剧本', exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => window.__fixture.lastConfirm.branchHash), 'changed-branch')
    check('Refresh for confirmation obtains graph and matching fresh branch hash in one snapshot')
    await reset("f.latest=f.snapshot(f.complete());f.grill=f.interview;f.counts.graph=0")
    await expect(page.getByRole('button', { name: '开始试玩', exact: true })).toBeVisible()
    await shot('galgame-studio-ready.png'); await fit()
    await page.getByRole('button', { name: '查看剧情分支', exact: true }).click()
    await expect(page.getByRole('button', { name: /把票送过河/ })).toBeVisible()
    assert.equal(await page.evaluate(() => window.__fixture.counts.graph), 0); check('Snapshot graph reused with no second full scan')
    await shot('galgame-studio-branches.png')
    await page.getByRole('button', { name: '4 检查与试玩' }).click()
    await page.getByRole('button', { name: '开始试玩', exact: true }).click(); await expect(page.getByRole('button', { name: '停止试玩', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '停止试玩', exact: true }).click(); await expect(page.getByRole('button', { name: '开始试玩', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '开始试玩', exact: true }).click()
    await page.evaluate(() => { window.__fixture.play={status:'stopped',message:'游戏已退出。'} })
    await expect(page.getByText('游戏已退出。', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '开始试玩', exact: true })).toBeVisible(); check('Start, stop and natural process exit update real controls')
    await reset("f.latest=f.snapshot({...f.complete(),projectMode:'import',stage:'generate',generatedFile:null,production:{...f.complete().production,integration:'required'}});f.grill=f.interview")
    await expect(page.getByRole('button', { name: '试玩原项目', exact: true })).toHaveCount(0)
    await reset("f.latest=f.snapshot({...f.complete(),production:{...f.complete().production,integration:'required'}});f.grill=f.interview")
    await expect(page.getByText('call dw_story', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '开始试玩', exact: true })).toHaveCount(0); check('Disconnected imported entry names the real file/call and does not falsely offer play')
    await reset("f.latest=f.snapshot({...f.complete(),stage:'generate',generatedFile:null,production:null,lint:null},false);f.grill=f.interview;f.fail.generate='模型暂不可用，请检查设置后重试';f.delay.generate=true")
    await page.getByRole('button', { name: '开始生成剧本', exact: true }).click(); await expect(page.getByText('正在生成并写入剧本…', { exact: true })).toBeVisible()
    await page.evaluate(() => { const f=window.__fixture; const release=f.delay.generate;delete f.delay.generate;release() })
    await expect(page.getByRole('alert')).toContainText('模型暂不可用'); await expect(page.getByRole('button', { name: '开始生成剧本', exact: true })).toBeEnabled()
    await page.evaluate(() => { delete window.__fixture.fail.generate })
    await page.getByRole('button', { name: '开始生成剧本', exact: true }).click(); await expect(page.getByRole('button', { name: '运行 Ren\'Py 检查', exact: true })).toBeVisible(); check('Generation immediately reports pending; failure retains recoverable action; retry writes and advances')
    await page.getByRole('button', { name: '生成修复提案', exact: true }).click(); await expect(page.getByText('修复提案 1', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: '应用并重新检查', exact: true }).click(); await expect(page.getByRole('button', { name: '开始试玩', exact: true })).toBeVisible(); check('Repair preview → explicit apply → Lint → play')
    await reset("f.latest=f.snapshot({...f.complete(),stage:'lint/repair',lint:null},false);f.grill=f.interview;f.delay.repair=true")
    await page.getByRole('button', { name: '生成修复提案', exact: true }).click(); await page.evaluate(() => window.renderStudio('s2'))
    await expect(page.getByRole('button', { name: '选择位置并创建', exact: true })).toBeVisible()
    await page.evaluate(() => { const f=window.__fixture; const release=f.delay.repair;delete f.delay.repair;release() })
    await expect(page.getByRole('button', { name: '应用并重新检查', exact: true })).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0); check('Session switch removes pending repair/drafts and late result cannot expose an apply button')
    await reset("f.latest=f.snapshot(f.complete());f.grill=f.interview")
    for (const width of [780, 420]) {
      await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 960), width)
      await fit(); await expect(page.getByRole('button', { name: '开始试玩', exact: true })).toBeVisible(); await shot('galgame-studio-ready-'+width+'.png')
    }
    check('780/420 widths retain play controls and no horizontal overflow')
    const native = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().map(w => ({visible:w.isVisible(),focused:w.isFocused()})))
    assert(native.every(w => !w.visible && !w.focused)); result.native=native
    assert.deepEqual(errors, []); result.pageErrors=errors
    await fs.writeFile(path.join(evidence, 'acceptance.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } finally { if (app) await app.close() }
})
