'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { _electron, expect } = require('@playwright/test')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname,'..'), shots = path.join(root,'out/goal-mode')
const shutdown = { exports: {} }
new Function('require','module','exports',buildSync({ entryPoints:[path.join(root,'scripts/electron-shutdown.ts')], platform:'node',bundle:true,format:'cjs',write:false }).outputFiles[0].text)(require,shutdown,shutdown.exports)

test('actual Goal composer: guided clarification, durable acceptance, task-only autonomy and explicit recovery', {timeout:120000}, async () => {
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'dw-goal-desktop-')), home=await fs.realpath(temporary), project=path.join(home,'河畔阅览室')
  let app,page,held
  const calls=[], counts={}, stages={}
  const answer='河畔的阅览室周六九点开放，欢迎带上一本旧书交换。'
  const emit=(res,delta,finish='stop')=>res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:finish}],usage:{prompt_tokens:30,completion_tokens:20,total_tokens:50}})+'\n\ndata: [DONE]\n\n')
  const tool=(res,args,id)=>emit(res,{tool_calls:[{index:0,id,type:'function',function:{name:'update_goal',arguments:JSON.stringify(args)}}]},'tool_calls')
  const server=http.createServer((req,res)=>{
    let raw=''; req.setEncoding('utf8');req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
      const body=JSON.parse(raw);calls.push(body)
      res.writeHead(200,{'content-type':'text/event-stream'})
      const initial=body.messages.filter(m=>m.role==='user'&&/自主测试|普通消息/u.test(m.content||'')).at(-1)?.content||''
      const kind=initial.includes('自主测试')?'auto':initial.includes('普通消息')?'normal':'guided'
      counts[kind]=(counts[kind]||0)+1
      const n=counts[kind]
      if(kind==='normal')return emit(res,{content:'普通回复。'})
      if(kind==='auto') {
        if(!stages.autoDefine){stages.autoDefine=true;return tool(res,{action:'define',progress:'已明确项目交付目标。',outcomes:[{id:'announcement',description:'交付可直接发布的阅览室开放通知',check:'写清周六九点开放与旧书交换。',verification:'answer'}]},'auto-define')}
        if(!stages.autoBlocked){stages.autoBlocked=true;return tool(res,{action:'blocked',progress:'通知需要补入实际负责人，现有资料未提供。',blockedOn:{kind:'missing_input',reason:'缺少活动负责人姓名。',nextAction:'请提供负责人姓名后继续。'}},'auto-missing')}
        if(!body.messages.some(m=>m.role==='user'&&m.content==='负责人是小禾。'))return emit(res,{content:'请提供缺失的活动负责人。'})
        held=res;return res.write('data: '+JSON.stringify({choices:[{delta:{content:'正在准备自主通知。'},finish_reason:null}]})+'\n\n')
      }
      if(!body.messages.some(m=>m.role==='user'&&m.content==='周六九点开放。')) {
        if(!stages.guidedBlocked){stages.guidedBlocked=true;return tool(res,{action:'blocked',progress:'已检查需求，开放时间会影响通知正文。',blockedOn:{kind:'clarification',reason:'阅览室几点开放？',nextAction:'请补充开放时间后继续。',recommendation:'周六九点开放。'}},'guided-question')}
        return emit(res,{content:'请补充开放时间，建议周六九点。'})
      }
      if(!stages.guidedDefine){stages.guidedDefine=true;return tool(res,{action:'define',progress:'已采纳同一任务中的开放时间。',outcomes:[{id:'announcement',description:'交付可直接发布的阅览室开放通知',check:'写清周六九点开放与旧书交换。',verification:'answer'}]},'guided-define')}
      if(!stages.guidedBadAnswer){stages.guidedBadAnswer=true;return emit(res,{content:'通知已经写好，但这里没有实际通知正文。'})}
      if(stages.guidedRejected && !stages.guidedAnswer){stages.guidedAnswer=true;return emit(res,{content:answer})}
      const source=body.messages.map(m=>String(m.content||'')).join('\n')
      const candidate=source.match(/"candidateTurnId":"([^"]+)"/)?.[1] || [...source.matchAll(/candidateTurnId=([^。\s]+)/g)].at(-1)?.[1]
      if(!candidate){void fs.writeFile(path.join(shots,'candidate-request.json'),JSON.stringify(body,null,2));return emit(res,{content:'无法读取候选ID，等待检查。'})}
      if(!stages.guidedRejected){stages.guidedRejected=true;return tool(res,{action:'review',progress:'发现候选只声称写好，未交付通知，继续修复。',originalObjectiveReview:'原需求是可发布的实际通知；当前候选没有正文，未完成。',originalSatisfied:false,checks:[{id:'announcement',satisfied:false,reason:'没有实际通知正文，无法核对时间和旧书交换。',evidence:[]}]},'guided-reject')}
      return tool(res,{action:'review',progress:'已核对原始需求和实际通知正文。',originalObjectiveReview:'正文是可发布的通知，包含补充的开放时间与旧书交换，不以计划替代交付。',originalSatisfied:true,checks:[{id:'announcement',satisfied:true,reason:'实际正文已覆盖时间与交换安排。',evidence:[{kind:'answer',reference:candidate,quote:answer,reason:'已交付完整的开放通知，并包含九点与旧书交换。'}]}]},'guided-review')
    })
  })
  const launch=async()=>{
    app=await _electron.launch({args:[path.join(root,process.env.DW_UI_BUILD_DIR||'out','main/index.js'),'--user-data-dir='+home],env:{...process.env,NODE_ENV:'test',DW_TEST_MODE:'1',DW_TEST_USERDATA:home,DW_TEST_PRICING_ORIGIN:`http://127.0.0.1:${server.address().port}`}})
    page=await app.firstWindow();page.setDefaultTimeout(12000)
    page.on('pageerror',error=>console.error('PAGE_ERROR',error.stack))
    await page.getByRole('textbox',{name:'任务内容'}).waitFor()
  }
  try {
    await fs.mkdir(shots,{recursive:true});await fs.mkdir(project);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    await fs.writeFile(path.join(home,'settings.json'),JSON.stringify({workDir:home,docDir:home,baseUrl:`http://127.0.0.1:${server.address().port}`,model:'deepseek-v4-flash',toolsEnabled:true,webAccessEnabled:false,planMode:false}))
    await launch()
    await page.evaluate(async()=>window.ds.setSettings({...await window.ds.getSettings(),apiKey:'synthetic-local-goal-key'}))
    await page.reload()
    const goal=()=>page.getByRole('checkbox',{name:'Goal 模式',exact:true})
    const auto=()=>page.getByRole('checkbox',{name:'不提问，自主执行',exact:false})
    const input=()=>page.getByRole('textbox',{name:'任务内容'})
    await expect(goal()).not.toBeChecked()
    await goal().check();await expect(auto()).not.toBeChecked()
    await page.screenshot({path:path.join(shots,'goal-guided-composer.png'),animations:'disabled',scale:'css'})
    await input().fill('为河畔阅览室写一条可发布的开放通知，安排旧书交换。')
    await page.screenshot({path:path.join(shots,'goal-guided-ready.png'),animations:'disabled',scale:'css'})
    await input().press('Enter')
    const progress=()=>page.getByTestId('goal-progress').first()
    await expect(progress()).toContainText('阅览室几点开放？')
    await expect(page.getByRole('textbox',{name:'补充目标信息'})).toBeVisible()
    const guided=(await page.evaluate(()=>window.ds.runsListRecent(1)))[0]
    assert.equal((await page.evaluate(id=>window.ds.runsGet(id),guided.runId)).config.goalMode,'guided')
    await page.getByRole('textbox',{name:'补充目标信息'}).fill('周六九点开放。')
    await page.getByRole('button',{name:'提交并继续',exact:true}).click()
    await expect(progress()).toContainText('已验收完成')
    await expect(progress()).toContainText('1/1 项已验收')
    await expect(page.locator('.msg.assistant .msg-bubble')).toHaveText(answer)
    await expect(page.locator('.msg.assistant .msg-bubble')).not.toContainText('这里没有实际通知正文')
    assert.equal((await page.evaluate(()=>window.ds.runsListRecent(10))).length,1,'clarification resumes the same durable run')
    assert.equal(calls.find(body=>body.messages.some(m=>m.role==='user'&&m.content==='周六九点开放。')).messages.filter(m=>m.role==='user'&&m.content==='周六九点开放。').length,1)
    await expect(goal()).not.toBeChecked()
    await expect(page.getByTestId('work-steering-receipts')).toHaveCount(0)
    await page.screenshot({path:path.join(shots,'goal-completed.png'),animations:'disabled',scale:'css'})
    await page.reload();await page.locator('.session-item-main').first().click()
    await expect(progress()).toContainText('已验收完成')
    await expect(goal()).not.toBeChecked()
    await expect(page.locator('.msg.assistant .msg-bubble')).toHaveText(answer)
    await goal().check();await auto().check()
    await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]})},project)
    await page.getByRole('button',{name:'工作目录：'+home,exact:true}).click()
    await expect.poll(()=>page.evaluate(async()=>(await window.ds.getSettings()).permissionWorkspaceRoot)).toBeTruthy()
    await expect(page.locator('.toast')).toHaveCount(0,{timeout:6000})
    await expect(page.locator('#goal-autonomy-explanation')).toContainText('预授权')
    await expect(page.locator('#goal-autonomy-explanation')).toContainText('随时停止')
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>!win.webContents.getURL().includes('window='))?.setContentSize(860,720))
    await page.screenshot({path:path.join(shots,'goal-autonomous-composer-860.png'),animations:'disabled',scale:'css'})
    await input().fill('自主测试：为河畔阅览室写开放通知。');await input().press('Enter')
    const autoProgress=()=>page.getByTestId('goal-progress').last()
    await expect(autoProgress()).toContainText('缺少活动负责人姓名。')
    await expect(autoProgress().getByRole('button',{name:'恢复并授权',exact:true})).toBeDisabled()
    await page.screenshot({path:path.join(shots,'goal-autonomous-recovery-860.png'),animations:'disabled',scale:'css'})
    const autonomousPaused=(await page.evaluate(()=>window.ds.runsListRecent(1)))[0]
    const refused=await page.evaluate(id=>window.ds.runsResume(id),autonomousPaused.runId)
    assert.equal(refused.reason,'goal_authorization_required')
    await autoProgress().getByRole('textbox',{name:'补充目标信息'}).fill('负责人是小禾。')
    await autoProgress().getByRole('checkbox',{name:'重新授权此任务的项目工具',exact:true}).check()
    await autoProgress().getByRole('button',{name:'恢复并授权',exact:true}).click()
    await expect.poll(()=>Boolean(held)).toBe(true)
    await expect(page.getByRole('button',{name:'停止',exact:true})).toBeVisible()
    const autonomous=(await page.evaluate(()=>window.ds.runsListRecent(1)))[0]
    assert.equal((await page.evaluate(id=>window.ds.runsGet(id),autonomous.runId)).config.goalMode,'autonomous')
    await page.screenshot({path:path.join(shots,'goal-active-stop-860.png'),animations:'disabled',scale:'css'})
    await page.getByRole('button',{name:'停止',exact:true}).click();held.destroy();held=null
    await expect(page.getByRole('button',{name:'停止',exact:true})).toHaveCount(0)
    if(!await goal().isChecked())await goal().check()
    await expect(auto()).not.toBeChecked()
    await goal().uncheck()
    await input().fill('普通消息，不使用目标模式。');await input().press('Enter')
    await page.getByText('普通回复。',{exact:true}).waitFor()
    assert.equal((await page.evaluate(async()=>window.ds.runsGet((await window.ds.runsListRecent(1))[0].runId))).config.goalMode,undefined)
    await goal().check();await auto().check()
    await page.keyboard.press('Control+n')
    await expect(goal()).not.toBeChecked();await expect(auto()).toHaveCount(0)
    await page.getByTestId('composer-tools-trigger').click()
    await page.locator('label.dw-switch').filter({hasText:'只读审阅'}).click();await page.keyboard.press('Escape')
    await expect(goal()).toHaveCount(0)
    await page.getByTestId('composer-tools-trigger').click()
    await page.locator('label.dw-switch').filter({hasText:'只读审阅'}).click();await page.keyboard.press('Escape')
    await expect(goal()).not.toBeChecked()
    await goal().check();await auto().check()
    await input().fill('整理项目中的阅览室资料，写好周六开放通知，并检查时间与旧书交换安排是否完整。')
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>!win.webContents.getURL().includes('window='))?.setContentSize(1280,800))
    await expect(page.locator('.toast')).toHaveCount(0,{timeout:6000})
    await page.screenshot({path:path.join(shots,'goal-mode-overview.png'),animations:'disabled',scale:'css'})
    await fs.writeFile(path.join(shots,'desktop-result.json'),JSON.stringify({guidedRun:guided.runId,autonomousRun:autonomous.runId,calls:counts,checks:['default off','guided same-run reply','durable acceptance after reload','rejected candidate excluded from live and reloaded final reply','autonomy task-only','explicit autonomous reauthorization','actual stop','ordinary chat unchanged','860x720 layout','new session clears authorization','read-only excludes Goal']},null,2))
  } catch(error) {
    if(page){console.error((await page.locator('body').innerText().catch(()=>'' )).slice(-4500));await page.screenshot({path:path.join(shots,'desktop-failure.png'),animations:'disabled'}).catch(()=>{});console.error('RUNS',JSON.stringify(await page.evaluate(async()=>Promise.all((await window.ds.runsListRecent(4)).map(row=>window.ds.runsGet(row.runId)))).catch(()=>[])))}
    throw error
  } finally {
    held?.destroy();if(app)await shutdown.exports.closeElectronGracefully(app,{profile:home,diagnosticsDir:shots})
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
    assert.equal(path.dirname(temporary),os.tmpdir());assert.ok(path.basename(temporary).startsWith('dw-goal-desktop-'));await fs.rm(temporary,{recursive:true,force:true})
  }
})
