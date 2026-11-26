const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{DatabaseSync}=require('node:sqlite'),{createHash}=require('node:crypto'),{buildSync}=require('esbuild')
const root=path.resolve(__dirname,'..')
function load(source){const mod={exports:{}};new Function('require','module','exports',source)(require,mod,mod.exports);return mod.exports}
const current=load(buildSync({stdin:{contents:"export {createRepository} from './src/main/db/repository';export {resolveChatFiles,readyChatFile,prepareChatFileMenu} from './src/main/chatFiles';",resolveDir:root,loader:'ts'},bundle:true,packages:'external',platform:'node',format:'cjs',write:false}).outputFiles[0].text)
async function measureFileLatency({beforePath=process.env.DW_CHAT_FILE_BASELINE}={}){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dw-file-latency-check-')),work=path.join(home,'work');await fs.mkdir(work)
 let repo,db;const originals={},prepare=DatabaseSync.prototype.prepare
 try{
  repo=current.createRepository(path.join(home,'test.db'));repo.open();db=new DatabaseSync(path.join(home,'test.db'))
  const n=64,names=Array.from({length:n},(_,i)=>'doc-'+i+'.md'),now=Date.now(),body='较长旧会话正文。'.repeat(16000)+'\n'+names.map(s=>'`'+s+'`').join(' ')
  db.prepare('INSERT INTO sessions(session_id,title,created_at,updated_at) VALUES(?,?,?,?)').run('s','fixture',now,now)
  db.prepare('INSERT INTO runs(run_id,session_id,status,phase,started_at,updated_at,config_json) VALUES(?,?,?,?,?,?,?)').run('r','s','completed','completed',now,now,JSON.stringify({workDir:work,docDir:work}))
  db.prepare('INSERT INTO turns(turn_id,run_id,turn_seq,role,content,created_at) VALUES(?,?,?,?,?,?)').run('t','r',1,'assistant',body,now)
  db.prepare('INSERT INTO session_messages(msg_id,session_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)').run('m_r_assistant','s',1,'assistant',body,now)
  for(let i=0;i<n;i++){const p=path.join(work,names[i]);await fs.writeFile(p,'fixture '+i)
   if(i<n/2)db.prepare('INSERT INTO toolcalls(tool_call_id,turn_id,run_id,name,args_json,args_hash,status,result_json,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('tc'+i,'t','r','write_file',JSON.stringify({path:names[i],content:'a'.repeat(65536)}),'h'+i,'completed',JSON.stringify({ok:true,path:p,canonicalPath:await fs.realpath(p)}),now,now)
  }
  const artifact=path.join(work,'long-manuscript.md'),text=Buffer.from('已写成的长稿正文。'.repeat(300000))
  await fs.writeFile(artifact,text);db.prepare('INSERT INTO artifacts(artifact_id,run_id,session_id,artifact_type,display_name,relative_path,hash,char_count,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('a','r','s','manuscript','long',artifact,createHash('sha256').update(text).digest('hex'),3000000,'completed',now)
  let counts;DatabaseSync.prototype.prepare=function(sql){if(/^\s*(?:SELECT|WITH)/i.test(sql))counts.sql++;return prepare.call(this,sql)}
  for(const k of ['realpath','stat','readFile']){originals[k]=fs[k];fs[k]=(...a)=>{counts[k]++;return originals[k](...a)}}
  const measure=async fn=>{counts={sql:0,realpath:0,stat:0,readFile:0};const start=performance.now(),result=await fn();return{ms:performance.now()-start,counts:{...counts},result}}
  const input={sessionId:'s',messageId:'m_r_assistant',candidates:names},anchor={kind:'artifact',runId:'r',artifactId:'a'}
  let before,beforeArtifact
  if(beforePath){const old=load(await originals.readFile(beforePath,'utf8'));before=await measure(()=>Promise.all(names.map(candidate=>old.resolveChatFile(repo,{kind:'message',sessionId:'s',messageId:'m_r_assistant',candidate}))));beforeArtifact=await measure(()=>old.readyChatFile(repo,anchor));assert.equal(before.result.filter(r=>r.ok).length,n)}
  const after=await measure(()=>current.resolveChatFiles(repo,input));assert.equal(after.result.length,n)
  assert.deepEqual(after.counts,{sql:3,realpath:65,stat:64,readFile:0},'one reply batch, one root canonicalization, no file-body reads')
  const menu=await measure(()=>current.prepareChatFileMenu(repo,{kind:'message',sessionId:'s',messageId:'m_r_assistant',candidate:names[0]}));assert.equal(menu.result.ok,true);assert.deepEqual(menu.counts,{sql:3,realpath:0,stat:0,readFile:0})
  const afterArtifact=await measure(()=>current.prepareChatFileMenu(repo,anchor));assert.equal(afterArtifact.result.ok,true);assert.equal(afterArtifact.counts.readFile,0)
  const checkedArtifact=await measure(()=>current.readyChatFile(repo,anchor));assert.equal(checkedArtifact.result.ok,true);assert.equal(checkedArtifact.counts.readFile,1,'chosen artifact actions still verify full manuscript integrity')
  await fs.rm(path.join(work,names[0]));const moved=await current.readyChatFile(repo,{kind:'message',sessionId:'s',messageId:'m_r_assistant',candidate:names[0]},menu.result.path);assert.equal(moved.ok,false);assert.match(moved.message,/移动或删除/)
  const snippet=await current.resolveChatFiles(repo,{...input,candidates:[names[1],'unmentioned.md',names[1]]});assert.equal(snippet.length,1,'reply ownership and dedup are preserved')
  assert.deepEqual(await current.resolveChatFiles(repo,{...input,sessionId:'other'}),[])
  const summary=r=>r?{ms:r.ms,counts:r.counts}:undefined
  return{n,replyChars:body.length,receiptBodyBytes:32*65536,artifactBytes:text.length,before:summary(before),after:summary(after),receiptMenu:summary(menu),beforeArtifactMenu:summary(beforeArtifact),afterArtifactMenu:summary(afterArtifact),actionArtifact:summary(checkedArtifact)}
 }finally{
  DatabaseSync.prototype.prepare=prepare;for(const k of Object.keys(originals))fs[k]=originals[k]
  db?.close();repo?.close();assert.equal(path.dirname(home),os.tmpdir());assert(path.basename(home).startsWith('dw-file-latency-check-'));await fs.rm(home,{recursive:true,force:true})
 }
}
module.exports={measureFileLatency}
if(require.main===module)test('file reply batch bounds DB and filesystem work while selected actions revalidate',async()=>{const result=await measureFileLatency();console.log(JSON.stringify(result,null,2))})
