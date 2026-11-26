// Disposable desktop recovery-button check. The synthetic profile has no key or target model.
const { test }=require('node:test')
const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), assert=require('node:assert/strict')
const {DatabaseSync}=require('node:sqlite'), { _electron,expect }=require('@playwright/test')
const root=path.resolve(__dirname,'..'), home=fs.mkdtempSync(path.join(os.tmpdir(),'dw-331-recovery-')), id='81ad533c-8d69-4bfe-a01b-08dbb14dd169'
const bundle=require('esbuild').buildSync({entryPoints:[path.join(root,'src/main/jobs/providerBudgetPolicy.ts')],bundle:true,platform:'node',format:'cjs',write:false})
const mod={exports:{}};new Function('module','exports','require',bundle.outputFiles[0].text)(mod,mod.exports,require)
test('cold desktop recovery remains reachable without an activity replay', async () => {let app,db
try {
 app=await _electron.launch({executablePath:require('electron'),args:[path.join(root,'out/main/index.js'),'--user-data-dir='+home],env:{...process.env,DW_TEST_USERDATA:home,DW_TEST_MODE:'1',NODE_ENV:'test'}})
 const page=await app.firstWindow();page.setDefaultTimeout(6500)
 assert.equal(fs.realpathSync(await app.evaluate(({app})=>app.getPath('userData'))), fs.realpathSync(home))
 await page.getByRole('textbox',{name:'任务内容'}).waitFor()
 const time=Date.now(), session='synthetic-16', cfg={snapshotVersion:4,sessionId:session,runMode:'agent',maxTurns:6,baseUrl:'http://127.0.0.1:1',providerProfileSnapshots:{version:1,draft:null,planning:null},providerCallBudget:{maxCalls:16,maxTokens:102400,maxRetries:3,maxWallClockMs:10800000}}
 db=new DatabaseSync(path.join(home,'deepwriter.db')); db.exec('PRAGMA busy_timeout=3000')
 db.prepare('INSERT INTO sessions(session_id,title,created_at,updated_at) VALUES(?,?,?,?)').run(session,'网页研究（本地夹具）',time,time)
 db.prepare('INSERT INTO runs(run_id,session_id,status,phase,started_at,updated_at,config_json,error_code,error_message) VALUES(?,?,?,?,?,?,?,?,?)').run(id,session,'waiting_user','waiting_user',time,time,JSON.stringify(cfg),'run_provider_call_cap','已达到本次运行的 Provider 调用硬上限 16')
 const b=mod.exports.makeRunBudgetState(id,cfg,time,time);b.totalCalls=16;b.callsByActor.writer=16
 db.prepare('INSERT INTO run_evidence(run_id,kind,json,created_at) VALUES(?,?,?,?)').run(id,mod.exports.RUN_BUDGET_EVIDENCE_KIND,JSON.stringify(b),time)
 await page.reload();await page.getByRole('textbox',{name:'任务内容'}).waitFor()
 await page.locator('.recover-item').filter({hasText:id.slice(0,8)}).getByRole('button',{name:'查看',exact:true}).click()
 const action=page.getByRole('button',{name:'解除调用次数限制并继续',exact:true})
 await expect(action).toBeVisible();await action.scrollIntoViewIfNeeded()
 await action.click()
 await expect.poll(()=>{const v=db.prepare("SELECT json FROM run_evidence WHERE run_id=? AND kind=?").get(id,'run_provider_call_limit_authorization_v1');return !!v},{timeout:8500}).toBe(true)
 const budget=JSON.parse(db.prepare('SELECT json FROM run_evidence WHERE run_id=? AND kind=?').get(id,mod.exports.RUN_BUDGET_EVIDENCE_KIND).json)
 assert.ok(budget.totalCalls === 16 || budget.totalCalls === 17, "16 past calls must survive; a resumed attempt can consume the next");assert.equal(budget.limits.maxCalls,null);assert.equal(budget.limits.maxTokens,102400)
} finally {
  db?.close()
  if (app) await app.close()
  if (path.dirname(home) === os.tmpdir() && path.basename(home).startsWith('dw-331-recovery-')) {
    fs.rmSync(home, {recursive:true, force:true, maxRetries:3, retryDelay:100})
  }
}
})