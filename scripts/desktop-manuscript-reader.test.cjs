// A real desktop/SQLite fixture. No model, no delivery artifact and no visible
// native window; screenshots are rendered by the actual Electron page.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron, expect } = require('@playwright/test')
const root = path.resolve(__dirname,'..')
const isolatedMain = `
const Module = require('node:module'), electron = require('electron');
const OriginalWindow = electron.BrowserWindow;
const HiddenWindow = new Proxy(OriginalWindow, {
 construct(Target, [options]) {
  const win = new Target({ ...options, show:false, focusable:false, webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false} });
  win.show = win.showInactive = win.focus = () => {}; return win;
 },
 get(Target,key) { const value = Reflect.get(Target,key); return typeof value === 'function' && key !== 'prototype' ? value.bind(Target) : value; }
});
const isolatedElectron = Object.create(electron);
Object.defineProperty(isolatedElectron,'BrowserWindow',{value:HiddenWindow});
const load = Module._load;
Module._load = function(request,parent,main) { return request === 'electron' ? isolatedElectron : load.call(this,request,parent,main); };
require(process.env.DW_READER_ENTRY);
`

test('任务中心与长文直达已收稿：80 章目录、筛选、Unicode 分页、返回写作及重启后阅读', {timeout:90000}, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'dw-reader-desktop-'))
  let app, db
  const launch = async () => {
    app = await _electron.launch({cwd:root,args:[path.join(home,'isolated-main.cjs')],env:{...process.env,DEEPWRITER_API_KEY:'',NODE_ENV:'test',DW_TEST_MODE:'1',DW_TEST_USERDATA:home,DW_READER_ENTRY:path.resolve(root,process.env.DW_UI_BUILD_DIR || 'out','main/index.js')}})
    const page = await app.firstWindow(); page.setDefaultTimeout(12000)
    await page.getByRole('textbox',{name:'任务内容'}).waitFor()
    assert((await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(win=>({visible:win.isVisible(),focused:win.isFocused()})))).every(win=>!win.visible&&!win.focused))
    return page
  }
  try {
    await fs.writeFile(path.join(home,'isolated-main.cjs'),isolatedMain)
    let page = await launch()
    db = new DatabaseSync(path.join(home,'deepwriter.db')); db.exec('PRAGMA busy_timeout=3000')
    const sections = Array.from({length:80},(_,index)=>({id:'c'+index,title:index===36?'第三十七章 渡口的旧账':`第${index+1}章 ${index===0?'潮水以前':'河岸来信'}`}))
    const config = {runMode:'longwrite',longMode:true,grillMe:{writingForm:'expository',approvedOutline:{title:'河岸调查手记',sections}}}
    const time = Date.now()
    db.prepare('INSERT INTO sessions(session_id,title,created_at,updated_at) VALUES(?,?,?,?)').run('reader-session','河岸调查手记',time,time)
    db.prepare('INSERT INTO runs(run_id,session_id,status,phase,started_at,updated_at,config_json) VALUES(?,?,?,?,?,?,?)').run('reader-run','reader-session','failed','failed',time,time,JSON.stringify(config))
    const firstBody = '天还没亮，渡口已经有人等船。\n\n' + '河上的雾压得很低。守船人把旧账本摊在木凳上，指尖停在那一行褪了色的日期。我记下他的原话，没有替他补出遗漏的姓名。远处响起一声汽笛，水面先亮了一小块，接着才看见船。🌊\n\n'.repeat(100)
    const insert = db.prepare('INSERT INTO manuscript_segments(segment_id,run_id,session_id,chunk_index,revision,status,kind,content,content_hash,char_count,section_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    for (let index=0;index<80;index++) {
      const body = index===0 ? firstBody : index===36 ? '旧账本第三十七页记录了一次没有署名的修船支出。\n\n守船人把纸页朝灯光抬起，背面的字迹慢慢显了出来。这一页先记下可核对的日期，再保留他尚未确认的那句话。' : `这是第${index+1}章的已收稿正文。\n\n河水落下以后，石阶露出了原来的颜色。`
      insert.run('segment-'+index,'reader-run','reader-session',index,1,'accepted','prose',body,'a'.repeat(64),Array.from(body).length,'c'+index,time,time)
    }
    insert.run('candidate','reader-run','reader-session',80,1,'candidate','prose','不可显示的候选草稿','b'.repeat(64),10,'c80',time,time)
    const before = db.prepare('SELECT status,config_json FROM runs WHERE run_id=?').get('reader-run')
    await page.reload(); await page.getByRole('button',{name:'任务中心',exact:true}).click()
    await page.getByRole('button',{name:/河岸调查手记.*查看详情/}).click()
    await page.getByRole('tab',{name:'稿件',exact:true}).click()
    const reader = page.getByTestId('manuscript-reader'), prose = page.getByTestId('manuscript-prose')
    await expect(reader).toContainText('80 节'); await expect(reader).toContainText('1 段草稿或候选尚未接纳')
    await expect(prose).toContainText('天还没亮'); assert.equal(Array.from(await prose.textContent()).length,6000)
    await page.getByRole('spinbutton',{name:'页码',exact:true}).fill('2'); await page.getByRole('button',{name:'前往',exact:true}).click()
    await expect.poll(async()=>await page.getByRole('spinbutton',{name:'页码',exact:true}).inputValue()).toBe('2')
    await expect(prose).toBeVisible()
    assert.equal(await prose.textContent(),Array.from(firstBody).slice(6000,12000).join(''))
    await page.getByRole('searchbox',{name:'查找章节'}).fill('旧账')
    await expect(page.getByRole('navigation',{name:'已收稿目录'}).getByRole('button')).toHaveCount(1)
    await page.getByRole('navigation',{name:'已收稿目录'}).getByRole('button',{name:/第三十七章/}).click()
    await expect(prose).toContainText('旧账本第三十七页')
    assert(!(await reader.textContent()).includes('不可显示的候选草稿'))
    const evidence = path.join(root,'out/manuscript-reader-evidence'); await fs.mkdir(evidence,{recursive:true})
    await page.screenshot({path:path.join(evidence,'chapter-37.png'),animations:'disabled',scale:'css'})
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,720))
    await expect.poll(()=>page.evaluate(()=>window.innerWidth)).toBe(800)
    const bounds = await reader.boundingBox(); assert(bounds.x>=0 && bounds.x+bounds.width<=800)
    assert(await page.getByRole('button',{name:'返回写作',exact:true}).isVisible())
    assert(await page.getByRole('button',{name:'下一页',exact:true}).isVisible())
    await page.screenshot({path:path.join(evidence,'chapter-37-800.png'),animations:'disabled',scale:'css'})
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,900))
    await page.getByRole('searchbox',{name:'查找章节'}).fill('没有这一章')
    await expect(reader).toContainText('未找到章节')
    await page.getByRole('searchbox',{name:'查找章节'}).fill('')
    await page.getByRole('button',{name:'返回写作',exact:true}).click()
    await expect(page.getByTestId('longform-workflow-shell')).toBeVisible()
    await page.getByRole('button',{name:'阅读已收稿',exact:true}).click()
    await expect(prose).toContainText('天还没亮')
    await page.keyboard.press('Escape'); await expect(reader).toBeHidden()
    // The same record remains available from task history after a cold restart.
    await app.close(); app=null; page=await launch()
    await page.getByRole('button',{name:'任务中心',exact:true}).click()
    await page.getByRole('button',{name:/河岸调查手记.*查看详情/}).click()
    await page.getByRole('tab',{name:'稿件',exact:true}).click()
    await expect(page.getByTestId('manuscript-prose')).toContainText('天还没亮')
    assert.deepEqual(db.prepare('SELECT status,config_json FROM runs WHERE run_id=?').get('reader-run'),before)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM provider_call_attempts').get().n,0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM artifacts').get().n,0)
  } finally {
    db?.close(); if(app) await app.close().catch(()=>{})
    assert.equal(path.dirname(home),os.tmpdir()); assert(path.basename(home).startsWith('dw-reader-desktop-'))
    await fs.rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:100})
  }
})
