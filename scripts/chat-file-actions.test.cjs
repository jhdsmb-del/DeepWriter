const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { buildSync } = require('esbuild')
function load(entry) { const mod = {exports:{}}; new Function('require','module','exports',buildSync({entryPoints:[path.join(__dirname,'..',entry)],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text)(require,mod,mod.exports);return mod.exports }
const {chatFileCandidates,chatFileCandidate,chatFileCanOpen} = load('src/shared/chatFiles.ts')
const {resolveChatFile,readyChatFile} = load('src/main/chatFiles.ts')
test('local filename candidates never authorize launching; fenced code and URLs remain excluded',()=>{
 assert.deepEqual(chatFileCandidates('写入 `资料.md`、[查看](docs/a%20b.pdf)\n```txt\n`example.md`\n```\n`run.exe` [网页](https://x/a.md) `npm test`'),['资料.md','docs/a%20b.pdf','run.exe'])
 for(const p of ['https://x/a.md','file:///a.md','\\\\server\\a.md','//server/a.md','a.md:evil','%2F%2Fserver/a.md','a%00.md']) assert.equal(chatFileCandidate(p),null,p)
})
test('facts survive legacy envelopes; frozen roots, collisions, unknown dialog paths, deletion and symlink changes cannot select a wrong file',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dw-chat-file-unit-'));const work=path.join(home,'old'),doc=path.join(home,'doc');await fs.mkdir(work);await fs.mkdir(doc)
 const run={run_id:'r',session_id:'s',config_json:JSON.stringify({workDir:work,docDir:doc})};let facts=[]
 const repo={getRun:id=>id==='r'?run:null,chatFileMessageMentions:(s,r,c)=>s==='s',getRunWrittenFiles:()=>facts}
 const anchor=c=>({kind:'message',sessionId:'s',messageId:'m_r_assistant',candidate:c})
 try{
  await fs.writeFile(path.join(work,'same.md'),'work');await fs.writeFile(path.join(doc,'same.md'),'doc')
  assert.equal((await resolveChatFile(repo,anchor('same.md'))).ok,false)
  facts=[{name:'write_file',args_path:'same.md',result_path:null}]
  assert.equal((await readyChatFile(repo,anchor('same.md'))).path,await fs.realpath(path.join(work,'same.md')))
  facts.push({name:'generate_markdown_doc',result_path:path.join(doc,'same.md')})
  assert.equal((await resolveChatFile(repo,anchor('same.md'))).ok,false)
  assert.equal((await resolveChatFile(repo,anchor(path.join(doc,'same.md')))).path,await fs.realpath(path.join(doc,'same.md')))
  facts=[{name:'generate_markdown_doc',filename:'same.md',args_path:null,result_path:null}]
  assert.equal((await resolveChatFile(repo,anchor('same.md'))).ok,false,'legacy save-dialog filename is not evidence of target')
  facts=[{name:'write_file',args_path:'same.md',result_path:null}];await fs.rm(path.join(work,'same.md'))
  assert.equal((await resolveChatFile(repo,anchor('same.md'))).state,'missing')
  assert.match((await readyChatFile(repo,anchor('same.md'))).message,/移动或删除/)
  assert.equal((await resolveChatFile(repo,{...anchor('same.md'),sessionId:'other'})).ok,false)
  facts=[];assert.equal((await resolveChatFile(repo,anchor('../doc/same.md'))).path,path.join(doc,'same.md'))
  const outside=path.join(home,'outside.md');await fs.writeFile(outside,'outside');assert.equal((await resolveChatFile(repo,anchor(outside))).ok,false)
  await fs.symlink(home,path.join(work,'escape'),'junction');assert.equal((await resolveChatFile(repo,anchor('escape/outside.md'))).ok,false)
 }finally{await fs.rm(home,{recursive:true,force:true})}
})

test('new receipt canonical identity supports stable junctions; reveal uses that exact target and rejects retargeted junctions',async()=>{
 const {executeFileContextAction}=load('src/main/fileContextMenu.ts')
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dw-chat-junction-')),real=path.join(home,'real'),other=path.join(home,'other'),alias=path.join(home,'alias')
 try{
  await fs.mkdir(real);await fs.mkdir(other);await fs.writeFile(path.join(real,'稿件.md'),'original');await fs.writeFile(path.join(other,'稿件.md'),'different')
  await fs.symlink(real,alias,process.platform==='win32'?'junction':'dir')
  const original=path.join(alias,'稿件.md'),canonical=await fs.realpath(original)
  const facts=[{name:'generate_markdown_doc',result_path:original,canonical_path:canonical}]
  const repo={getRun:()=>({session_id:'s',config_json:JSON.stringify({workDir:alias,docDir:alias})}),chatFileMessageMentions:()=>true,getRunWrittenFiles:()=>facts}
  const anchor={kind:'message',sessionId:'s',messageId:'r',candidate:'稿件.md'}
  const menuTarget=await readyChatFile(repo,anchor);assert.equal(menuTarget.ok,true);assert.equal(menuTarget.path,canonical)
  let revealed;const actionTarget=await readyChatFile(repo,anchor,menuTarget.path)
  const result=await executeFileContextAction('reveal',{realpath:actionTarget.path,kind:'file'},alias,{showItemInFolder:p=>{revealed=p},writeClipboard:()=>{},openPath:async()=>{throw Error('Must not launch external application')},emitAttach:()=>{}})
  assert.equal(result.ok,true);assert.equal(revealed,canonical,'menu display and showItemInFolder consume the same canonical file')
  facts[0].canonical_path=undefined;assert.equal((await readyChatFile(repo,anchor)).ok,false,'old literal-only receipt is handled conservatively')
  facts[0].canonical_path=canonical
  await fs.unlink(alias);await fs.symlink(other,alias,process.platform==='win32'?'junction':'dir')
  const changed=await readyChatFile(repo,anchor,menuTarget.path);assert.equal(changed.ok,false);assert.match(changed.message,/路径已改变/)
 }finally{await fs.rm(home,{recursive:true,force:true})}
})

test('document/archive menus can open safely; exact code/program receipts offer locate/copy only, never shell launch',async()=>{
 const {buildChatFileContextActions,executeChatFileContextAction}=load('src/main/fileContextMenu.ts')
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dw-chat-file-actions-'))
 let facts=[];const repo={getRun:()=>({session_id:'s',config_json:JSON.stringify({workDir:home,docDir:home})}),chatFileMessageMentions:()=>true,getRunWrittenFiles:()=>facts}
 const anchor=c=>({kind:'message',sessionId:'s',messageId:'r',candidate:c})
 const recorded=[];const deps={showItemInFolder:p=>recorded.push(['reveal',p]),writeClipboard:p=>recorded.push(['copy',p]),openPath:async p=>{recorded.push(['open',p]);return true},emitAttach:()=>{}}
 try{
  for(const name of ['资料.md','data.json','config.yaml','book.epub','backup.zip']){
   const file=path.join(home,name);await fs.writeFile(file,'fixture');const target=await readyChatFile(repo,anchor(name))
   assert.equal(target.ok,true,name);assert.equal(target.canOpen,true,name)
   const menu=buildChatFileContextActions(target.canOpen);assert.deepEqual(menu.map(a=>a.id),['open','reveal','copy-absolute'])
   assert.deepEqual(menu.map(a=>a.label),['打开文件','在文件资源管理器中显示','复制路径'])
   for(const item of menu)assert.equal((await executeChatFileContextAction(item.id,{realpath:target.path,kind:'file',canOpen:target.canOpen},deps)).ok,true)
   assert.deepEqual(recorded.splice(0),[['open',file],['reveal',file],['copy',file]])
  }
  for(const name of ['source.ts','script.js','script.py','script.ps1','program.exe','shortcut.lnk','page.html','drawing.svg']){
   const file=path.join(home,name);await fs.writeFile(file,'not executable fixture')
   assert.equal(chatFileCandidate(name),name);assert.equal(chatFileCanOpen(name),false)
   facts=[];assert.equal((await readyChatFile(repo,anchor(name))).ok,false,'ordinary no-receipt code is not a file link: '+name)
   facts=[{name:'write_file',result_path:file,canonical_path:await fs.realpath(file)}]
   const target=await readyChatFile(repo,anchor(name));assert.equal(target.ok,true,name);assert.equal(target.canOpen,false,name)
   const menu=buildChatFileContextActions(target.canOpen);assert.deepEqual(menu.map(a=>a.id),['reveal','copy-absolute'])
   const cap={realpath:target.path,kind:'file',canOpen:target.canOpen}
   assert.equal((await executeChatFileContextAction('open',cap,deps)).ok,false,'even forged IPC open cannot launch '+name)
   for(const item of menu)assert.equal((await executeChatFileContextAction(item.id,cap,deps)).ok,true)
   assert.deepEqual(recorded.splice(0),[['reveal',file],['copy',file]])
  }
 }finally{await fs.rm(home,{recursive:true,force:true})}
})
