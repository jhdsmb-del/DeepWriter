const {test,before}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process'),{build}=require('esbuild')
const root=path.resolve(__dirname,'..');let api
before(async()=>{const b=await build({stdin:{resolveDir:root,loader:'ts',contents:`export {createRepository} from './src/main/db/repository';export {ContextV2Service} from './src/main/contextV2';export {searchRunConversation} from './src/main/conversationSearch';export {createToolExecutor} from './src/main/runKernelAdapter';export {freezeAgentTools,toolAllowed} from './src/shared/agentToolPolicy';`},bundle:true,packages:'external',platform:'node',format:'cjs',alias:{electron:path.join(root,'src/cli/host.ts')},write:false,logLevel:'silent'});const m={exports:{}};new Function('require','module','exports',b.outputFiles[0].text)(require,m,m.exports);api=m.exports})
function seed(database){const repo=api.createRepository(database);repo.open();repo.createSession('retrieval-session','相同标题','unknown-local');repo.createSession('other-session','相同标题','unknown-local');
 for(let seq=1;seq<=460;seq++)repo.appendSessionMessage({msg_id:'h-'+seq,session_id:'retrieval-session',seq,role:seq%2?'user':'assistant',status:'done',created_at:seq,content:seq===41?'reference-17: GLASS-LYNX-914.':seq%2?`Ordinary archive entry ${seq}.`:'一般历史正文，仅为压力夹具，不包含标记。'.repeat(90)})
 repo.appendSessionMessage({msg_id:'other',session_id:'other-session',seq:1,role:'user',status:'done',created_at:1,content:'reference-17: ALIEN-SESSION-SENTINEL.'});return repo}
function launch(file,args){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[file,...args],{cwd:root,env:{...process.env,DEEPWRITER_API_KEY:'',DW_RECALL_NO_KEY:''},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);const timer=setTimeout(()=>p.kill(),30000);p.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr,events:stdout.split(/\r?\n/).filter(s=>s.startsWith('{')).map(s=>JSON.parse(s))})})})}

test('frozen same-session search is structured, paged, exact, honest on empty/budget, and unavailable through old wildcard',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dw-recall-unit-')),db=path.join(home,'db.sqlite');const repo=seed(db),service=new api.ContextV2Service(db)
 try{const frozen=service.freezeForRun({automatic:true,sessionId:'retrieval-session',draftText:'继续',attachments:[],outputReserveTokens:1024,capabilityFingerprint:'test'}),config={runMode:'agent',sessionId:'retrieval-session',frozenContext:frozen}
 assert.equal(api.toolAllowed('search_conversation',['*']),false);assert(api.freezeAgentTools(true,false).includes('search_conversation'))
 const scope=(args,budget)=>api.searchRunConversation(service,config,args,budget)
 const page=scope({query:'reference-17'});assert.equal(page.hits.length,1);assert.equal(page.hits[0].seq,41);assert.equal(page.hits[0].role,'user');assert.equal(page.hits[0].quote,'reference-17: GLASS-LYNX-914.');assert(!JSON.stringify(page).includes('ALIEN'))
 assert.equal(scope({query:'missing-sentinel'}).totalHits,0);assert.equal(scope({query:'reference-17'},0).budgetLimited,true)
 const first=scope({query:'Ordinary archive',limit:2});assert.equal(first.hits.length,2);const next=scope({query:'Ordinary archive',limit:2,offset:first.nextOffset});assert(next.hits.every(hit=>!first.hits.some(old=>old.messageId===hit.messageId)))
 assert.throws(()=>scope({query:'reference-17',sessionId:'other-session'}),/不能指定会话/)
 repo.appendSessionMessage({msg_id:'future',session_id:'retrieval-session',seq:461,role:'user',status:'done',created_at:461,content:'reference-17 FUTURE-SENTINEL'})
 service.close();const reopened=new api.ContextV2Service(db);try{assert(!JSON.stringify(api.searchRunConversation(reopened,JSON.parse(JSON.stringify(config)),{query:'reference-17'})).includes('FUTURE'))}finally{reopened.close()}
 const execute=api.createToolExecutor({getSignal:()=>undefined,getEnv:()=>({workDir:home,docDir:home,sessionId:'retrieval-session'}),getAllowList:()=>['*'],searchConversation:()=>{throw new Error('must not execute')}})
 await assert.rejects(execute('search_conversation','{"query":"reference-17"}','t','r'),/tool_not_allowed/)
 }finally{service.close();repo.close();assert.equal(path.dirname(home),os.tmpdir());assert(path.basename(home).startsWith('dw-recall-unit-'));await fs.rm(home,{recursive:true,force:true})}
})

test('real CLI loopback queries an absent cold fact outside 8k; simple reply adds no retrieval/provider call', {timeout:60000},async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dw-recall-cli-')),data=path.join(home,'data'),bundle=path.join(home,'cli.cjs');await fs.mkdir(data);let server,activeChild
 try{const b=await launch(path.join(root,'src/cli/build.mjs'),['--outfile='+bundle]);assert.equal(b.code,0,b.stderr);seed(path.join(data,'deepwriter.sqlite')).close()
 const requests=[],errors=[];let held;let began;const pausedRequest=new Promise(resolve=>began=resolve)
 server=http.createServer((req,res)=>{let raw='';req.on('data',x=>raw+=x);req.on('end',()=>{try{const body=JSON.parse(raw);requests.push(body);let delta,reason='stop';
 if(requests.length===1){assert(body.tools.some(t=>t.function.name==='search_conversation'));assert(!JSON.stringify(body.messages).includes('GLASS-LYNX-914'),'cold fact must be absent before tool');delta={tool_calls:[{index:0,id:'recall-1',type:'function',function:{name:'search_conversation',arguments:'{"query":"reference-17"}'}}]};reason='tool_calls'}
 else if(requests.length===2){const tool=body.messages.find(m=>m.role==='tool'&&m.tool_call_id==='recall-1');assert(tool,JSON.stringify(body.messages));const receipt=JSON.parse(tool.content);assert.equal(receipt.ok,true,tool.content);assert.equal(receipt.conversation.hits[0].seq,41,tool.content);assert(tool.content.includes('GLASS-LYNX-914'));assert(!tool.content.includes('ALIEN'));delta={content:'查回原文：reference-17: GLASS-LYNX-914.（用户，seq 41）'}}
 else if(requests.length===3) delta={content:'你好。'}
 else if(requests.length===4){held=res;began();return}
 else if(requests.length===5){delta={tool_calls:[{index:0,id:'after-restart',type:'function',function:{name:'search_conversation',arguments:'{"query":"FUTURE-SENTINEL"}'}}]};reason='tool_calls'}
 else {const receipt=JSON.parse(body.messages.find(m=>m.role==='tool'&&m.tool_call_id==='after-restart').content);assert.equal(receipt.ok,true);assert.equal(receipt.conversation.totalHits,0);assert.deepEqual(receipt.conversation.hits,[]);delta={content:'原运行冻结范围内没有该记录。'}}
 res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:reason}],usage:{prompt_tokens:200,completion_tokens:40}})+'\n\ndata: [DONE]\n\n')
 }catch(e){errors.push(e);res.writeHead(500);res.end('test failure')}})})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const flags=['--data-dir',data,'--work-dir',home,'--doc-dir',home,'--base-url',`http://127.0.0.1:${server.address().port}`,'--loopback','--context','8192','--model','unknown-local','--max-tokens','1024','--no-web','--json']
 const result=await launch(bundle,['agent','查回之前随手提过的一条标记，返回原文。','--session','retrieval-session',...flags]);assert.deepEqual(errors,[]);assert.equal(result.code,0,result.stderr+result.stdout);assert.equal(requests.length,2)
 const plain=await launch(bundle,['agent','你好，不需要查历史。',...flags]);assert.equal(plain.code,0,plain.stderr+plain.stdout);assert.equal(requests.length,3,'simple reply must use one provider call only')
 const child=activeChild=spawn(process.execPath,[bundle,'agent','恢复检索边界检查。','--session','retrieval-session',...flags],{cwd:root,env:{...process.env,DEEPWRITER_API_KEY:'',DW_RECALL_NO_KEY:''},stdio:['ignore','pipe','pipe']});let captured='',failure='';child.stdout.on('data',b=>captured+=b);child.stderr.on('data',b=>failure+=b);const ended=new Promise(resolve=>child.on('close',code=>resolve({code,stdout:captured,stderr:failure})))
 await pausedRequest
 const controlRepo=api.createRepository(path.join(data,'deepwriter.sqlite'));controlRepo.open();const pausedRun=controlRepo.listRecentRuns(20).find(run=>run.status==='running');assert(pausedRun);controlRepo.close()
 const pause=await launch(bundle,['pause',pausedRun.run_id,...flags]);assert.equal(pause.code,0,pause.stderr);const stopped=await ended;assert.equal(stopped.code,2,stopped.stderr+stopped.stdout);held.destroy()
 const futureRepo=api.createRepository(path.join(data,'deepwriter.sqlite'));futureRepo.open();const max=Math.max(...futureRepo.getSessionMessages('retrieval-session').map(m=>m.seq));futureRepo.appendSessionMessage({msg_id:'late-future',session_id:'retrieval-session',seq:max+1,role:'user',status:'done',created_at:Date.now(),content:'FUTURE-SENTINEL: this user note arrived after the paused run was accepted.'});futureRepo.close()
 const resumed=await launch(bundle,['resume',pausedRun.run_id,...flags]);assert.deepEqual(errors,[]);assert.equal(resumed.code,0,resumed.stderr+resumed.stdout);assert.equal(requests.length,6)
 await fs.mkdir(path.join(root,'out/harness-50'),{recursive:true});await fs.writeFile(path.join(root,'out/harness-50/conversation-retrieval-cli.json'),JSON.stringify({synthetic:true,modelWindow:8192,requests,restartFutureBoundaryVerified:true,extraSummaryModelCalls:0},null,2))
 }finally{if(activeChild&&activeChild.exitCode===null)activeChild.kill();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}assert.equal(path.dirname(home),os.tmpdir());assert(path.basename(home).startsWith('dw-recall-cli-'));await fs.rm(home,{recursive:true,force:true})}
})
module.exports={seed}
