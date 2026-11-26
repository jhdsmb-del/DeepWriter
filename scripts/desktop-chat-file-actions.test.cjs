// QA inventory: inline names/relative Markdown links, native right-click + keyboard
// entry, exact shell targets, old-session reload, frozen cwd, duplicate basenames,
// plain/fenced code and URLs, unknown legacy dialogs, failed/foreign receipts,
// missing files, safe shell allowlist, artifact integrity. Shell calls are recorded,
// never delegated to an uncontrolled external application.
const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path')
const {DatabaseSync}=require('node:sqlite'),{createHash}=require('node:crypto')
const {_electron,expect}=require('@playwright/test')
const root=path.resolve(__dirname,'..')
async function createChatFileFixture(){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dw-chat-files-ui-')),work=path.join(home,'old-work'),doc=path.join(home,'old-doc'),current=path.join(home,'current'),chosen=path.join(home,'chosen')
 for(const dir of [work,doc,current,chosen,path.join(work,'资料')]) await fs.mkdir(dir,{recursive:true})
 const paths={generated:path.join(chosen,'具身智能与世界模型-深度资料档.md'),legacy:path.join(work,'资料','旧稿.md'),workspace:path.join(work,'已有资料.pdf'),artifact:path.join(doc,'长稿.md')}
 for(const [key,file] of Object.entries(paths)) await fs.writeFile(file,key==='artifact'?'已验收长稿。':'# '+key)
 for(const dir of [work,doc]) await fs.writeFile(path.join(dir,'同名.md'),'不同文件')
 await fs.writeFile(path.join(work,'旧对话.md'),'不是旧dialog实际位置')
 await fs.writeFile(path.join(current,'只在新目录.md'),'不能从当前cwd打开')
 await fs.writeFile(path.join(work,'危险.exe'),'不能启动')
 await fs.writeFile(path.join(home,'settings.json'),JSON.stringify({workDir:current,docDir:current,webAccessEnabled:false}))
 let app,page,db
 const stub=async()=>app.evaluate(({shell,Menu,BrowserWindow})=>{
  globalThis.__chatFiles={calls:[],menus:[]};const fixture=globalThis.__chatFiles
  shell.openPath=async p=>{fixture.calls.push({action:'open',path:p});return ''}
  shell.showItemInFolder=p=>fixture.calls.push({action:'reveal',path:p})
  const build=Menu.buildFromTemplate.bind(Menu)
  Menu.buildFromTemplate=template=>{const menu=build(template);if(template[0]?.label==='打开文件'){fixture.menu=menu;fixture.menus.push(template.map(i=>i.label||i.type))}return menu}
  BrowserWindow.getAllWindows()[0].setTitle('DeepWriter 文件菜单 QA')
 })
 const launch=async()=>{app=await _electron.launch({args:[path.join(root,process.env.DW_UI_BUILD_DIR||'out','main/index.js'),'--user-data-dir='+home],env:{...process.env,DEEPWRITER_API_KEY:'',NODE_ENV:'test',DW_TEST_MODE:'1',DW_TEST_USERDATA:home}});page=await app.firstWindow();page.setDefaultTimeout(12000);await page.getByRole('textbox',{name:'任务内容'}).waitFor();await stub()}
 await launch();db=new DatabaseSync(path.join(home,'deepwriter.db'));db.exec('PRAGMA busy_timeout=3000')
 const sid='file-menu-session',rid='file-menu-run',now=Date.now()
 const body='文档已写入：`具身智能与世界模型-深度资料档.md`\n\n旧会话改稿：`资料/旧稿.md`；[查看原有资料](已有资料.pdf)。\n\n无法确认的条目：`同名.md`、`旧对话.md`、`只在新目录.md`、`危险.exe`、`npm test`。\n\n[网站](https://example.com/a.md)\n\n```txt\n具身智能与世界模型-深度资料档.md\n```'
 db.prepare('INSERT INTO sessions(session_id,title,created_at,updated_at) VALUES(?,?,?,?)').run(sid,'文件菜单旧会话',now,now)
 db.prepare('INSERT INTO runs(run_id,session_id,status,phase,started_at,updated_at,config_json) VALUES(?,?,?,?,?,?,?)').run(rid,sid,'completed','completed',now,now,JSON.stringify({workDir:work,docDir:doc,runMode:'agent'}))
 db.prepare('INSERT INTO turns(turn_id,run_id,turn_seq,role,content,created_at) VALUES(?,?,?,?,?,?)').run('file-menu-turn',rid,1,'assistant',body,now)
 db.prepare('INSERT INTO session_messages(msg_id,session_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)').run('m_'+rid+'_assistant',sid,1,'assistant',body,now)
 const tool=(id,name,args,result,status='completed')=>db.prepare('INSERT INTO toolcalls(tool_call_id,turn_id,run_id,name,args_json,args_hash,status,result_json,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'file-menu-turn',rid,name,JSON.stringify(args),id,status,JSON.stringify(result),now,now)
 tool('new-generator','generate_markdown_doc',{filename:path.basename(paths.generated)},{ok:true,path:paths.generated,name:path.basename(paths.generated),size:10})
 tool('old-write','write_file',{path:'资料/旧稿.md',content:'do not project this body'},{content:JSON.stringify({ok:true,message:'已写入'})})
 tool('old-dialog','generate_markdown_doc',{filename:'旧对话.md'},{ok:true})
 tool('failed-write','write_file',{path:'同名.md'},{ok:false})
 db.prepare('INSERT INTO artifacts(artifact_id,run_id,session_id,artifact_type,display_name,relative_path,hash,char_count,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('file-artifact',rid,sid,'manuscript','长稿',paths.artifact,createHash('sha256').update('已验收长稿。').digest('hex'),6,'completed',now)
 await page.reload();await page.getByRole('textbox',{name:'任务内容'}).waitFor();await page.locator('.session-item').filter({hasText:'文件菜单旧会话'}).click()
 const fixture={home,paths,sid,rid,get app(){return app},get page(){return page},db,
  async reopen(){db.close();db=null;await app.close();await launch();await page.locator('.session-item').filter({hasText:'文件菜单旧会话'}).click()},
  async close(){db?.close();await app?.close().catch(()=>{});assert.equal(path.dirname(home),os.tmpdir());assert(path.basename(home).startsWith('dw-chat-files-ui-'));await fs.rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:100})}}
 return fixture
}
async function verifyChatFileActions(){
 const f=await createChatFileFixture();try{
  let p=f.page;await expect(p.locator('.msg.assistant .file-action-link')).toHaveCount(3)
  const links=()=>p.locator('.msg.assistant .file-action-link')
  assert.equal(await links().first().getAttribute('title'),f.paths.generated)
  await links().first().click({button:'right'})
  await expect.poll(()=>f.app.evaluate(()=>globalThis.__chatFiles.menus.length)).toBe(1)
  assert.deepEqual(await f.app.evaluate(()=>globalThis.__chatFiles.menus[0]),['打开文件','在文件资源管理器中显示','separator','复制路径'])
  await f.app.evaluate(()=>{const menu=globalThis.__chatFiles.menu;menu.items[0].click();menu.closePopup()})
  await expect.poll(()=>f.app.evaluate(()=>globalThis.__chatFiles.calls.length)).toBe(1)
  assert.deepEqual(await f.app.evaluate(()=>globalThis.__chatFiles.calls[0]),{action:'open',path:f.paths.generated})
  await links().nth(1).focus();await p.keyboard.press('Shift+F10')
  await expect.poll(()=>f.app.evaluate(()=>globalThis.__chatFiles.menus.length)).toBe(2)
  await f.app.evaluate(()=>{const menu=globalThis.__chatFiles.menu;menu.items[1].click();menu.closePopup()})
  await expect.poll(()=>f.app.evaluate(()=>globalThis.__chatFiles.calls.length)).toBe(2)
  assert.deepEqual(await f.app.evaluate(()=>globalThis.__chatFiles.calls[1]),{action:'reveal',path:f.paths.legacy})
  await links().last().click();assert.deepEqual(await f.app.evaluate(()=>globalThis.__chatFiles.calls.at(-1)),{action:'open',path:f.paths.workspace})
  const forged=await p.evaluate(({sid,rid})=>window.ds.chatFileAction({kind:'message',sessionId:sid,messageId:'m_'+rid+'_assistant',candidate:'长稿.md'},'open'),{sid:f.sid,rid:f.rid})
  assert.equal(forged.ok,false,'unmentioned filename is not an arbitrary-path capability')
  assert.equal((await p.evaluate(({rid})=>window.ds.chatFileAction({kind:'artifact',runId:rid,artifactId:'file-artifact'},'reveal'),{rid:f.rid})).ok,true)
  assert.deepEqual(await f.app.evaluate(()=>globalThis.__chatFiles.calls.at(-1)),{action:'reveal',path:f.paths.artifact})
  await f.reopen();p=f.page;await expect(links()).toHaveCount(3);await links().nth(1).click()
  assert.deepEqual(await f.app.evaluate(()=>globalThis.__chatFiles.calls.at(-1)),{action:'open',path:f.paths.legacy})
  await fs.rm(f.paths.generated);await links().first().click();await expect(p.getByText('文件已移动或删除，请确认原文件位置',{exact:true})).toBeVisible()
  assert.equal(await f.app.evaluate(()=>globalThis.__chatFiles.calls.length),1)
  assert.equal((await p.evaluate(()=>window.ds.chatFilesResolve({sessionId:'other',messageId:'m_file-menu-run_assistant',candidates:['资料/旧稿.md']}))).length,0)
 }finally{await f.close()}
}
module.exports={createChatFileFixture,verifyChatFileActions}
if(require.main===module)test('Electron native menu entry resolves real generated/legacy/workspace files across cold reopen and reports moved files',{timeout:60000},verifyChatFileActions)
