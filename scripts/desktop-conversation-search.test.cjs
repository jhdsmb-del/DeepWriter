const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{buildSync}=require('esbuild'),{_electron,expect}=require('@playwright/test')
const root=path.resolve(__dirname,'..')

test('real desktop Agent retrieves an invisible cold quote within the frozen same-session boundary and keeps simple chat one-call', {timeout:75000}, async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dw-recall-desktop-'));let app,server;const requests=[],errors=[]
 try{
  const b=buildSync({stdin:{resolveDir:root,loader:'ts',contents:`export {createRepository} from './src/main/db/repository'`},bundle:true,platform:'node',format:'cjs',packages:'external',write:false,logLevel:'silent'}),m={exports:{}}
  new Function('require','module','exports',b.outputFiles[0].text)(require,m,m.exports)
  const repo=m.exports.createRepository(path.join(home,'deepwriter.db'));repo.open();repo.createSession('desktop-retrieval','历史标记','local-recall');repo.createSession('desktop-other','历史标记','local-recall')
  for(let seq=1;seq<=460;seq++)repo.appendSessionMessage({msg_id:'h-'+seq,session_id:'desktop-retrieval',seq,role:seq%2?'user':'assistant',status:'done',created_at:seq,content:seq===41?'reference-17: GLASS-LYNX-914.':seq%2?`Ordinary archive entry ${seq}.`:'一般历史正文，仅为压力夹具，不包含标记。'.repeat(90)})
  repo.appendSessionMessage({msg_id:'other',session_id:'desktop-other',seq:1,role:'user',status:'done',created_at:1,content:'reference-17: ALIEN-SESSION-SENTINEL.'});repo.close()
  await fs.writeFile(path.join(home,'settings.json'),JSON.stringify({workDir:home,docDir:home,planMode:false,toolsEnabled:true,webAccessEnabled:false,maxTokens:1024}))
  server=http.createServer((req,res)=>{let raw='';req.on('data',x=>raw+=x);req.on('end',()=>{try{const body=JSON.parse(raw)
   if(!body.stream&&body.tools?.[0]?.function?.name==='deepwriter_tool_probe'){const nonce=body.tools[0].function.parameters.properties.nonce.enum[0];res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'probe',type:'function',function:{name:'deepwriter_tool_probe',arguments:JSON.stringify({nonce})}}]}}]}))}
   requests.push(body);let delta,finish_reason='stop'
   if(requests.length===1){assert(body.tools.some(t=>t.function.name==='search_conversation'));assert(!JSON.stringify(body.messages).includes('GLASS-LYNX-914'));delta={tool_calls:[{index:0,id:'desktop-recall',type:'function',function:{name:'search_conversation',arguments:'{"query":"reference-17"}'}}]};finish_reason='tool_calls'}
   else if(requests.length===2){const receipt=body.messages.find(m=>m.role==='tool'&&m.tool_call_id==='desktop-recall');assert(receipt);const result=JSON.parse(receipt.content);assert.equal(result.ok,true,receipt.content);assert.equal(result.conversation.hits[0].seq,41,receipt.content);assert(receipt.content.includes('GLASS-LYNX-914'));assert(!receipt.content.includes('ALIEN'));delta={content:'查回原文：reference-17: GLASS-LYNX-914.（用户，seq 41）'}}
   else delta={content:'你好。'}
   res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta,finish_reason}],usage:{prompt_tokens:200,completion_tokens:40}})+'\n\ndata: [DONE]\n\n')
  }catch(e){errors.push(e);res.writeHead(500);res.end('fixture failed')}})})
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  app=await _electron.launch({args:[path.join(root,process.env.DW_UI_BUILD_DIR||'out','main/index.js'),'--user-data-dir='+home],env:{...process.env,DEEPWRITER_API_KEY:'',NODE_ENV:'test',DW_TEST_MODE:'1',DW_TEST_USERDATA:home}})
  const page=await app.firstWindow();page.setDefaultTimeout(12000);await page.getByRole('textbox',{name:'任务内容'}).waitFor()
  await page.evaluate(async baseUrl=>{const ds=window.ds,saved=await ds.providerCreateSetup({displayName:'本机历史检索模型',baseUrl,apiKey:'',protocol:'openai-chat',modelIds:['local-recall']});if(!saved.ok)throw Error(saved.error.message)
   let snapshot=(await ds.providerSnapshot()).data,profile=snapshot.profiles.find(p=>p.providerId===saved.data.id)
   const model=await ds.modelAddManual({providerId:saved.data.id,remoteModelId:'local-recall',displayName:'8k历史夹具',contextWindow:8192,maxOutputTokens:1024});if(!model.ok)throw Error(model.error.message)
   const probe=await ds.modelProbeTools(profile.modelId,saved.data.defaultCredentialRefId,true);if(!probe.ok||probe.data.outcome!=='supported')throw Error('fixture tool probe failed')
   const {createdAt,updatedAt,...input}=profile;const savedProfile=await ds.profileUpsert({...input,generation:{...input.generation,maxOutputTokens:1024}});if(!savedProfile.ok)throw Error(savedProfile.error.message)
   await ds.profileSetBindings({...snapshot.bindings,defaultProfileId:profile.id,draftProfileId:profile.id});window.dispatchEvent(new Event('deepwriter:provider-registry-changed'))
  },`http://127.0.0.1:${server.address().port}/v1`)
  const start=async(id,sessionId,text)=>page.evaluate(async({id,sessionId,text})=>{const p={id,sessionId,text,phase:'execute',fixedPrefix:[],history:[],story:null,longMode:false,targetChars:0,mode:'agent'};let result=await window.ds.chatStart(p);if(result.status==='cost_confirmation_required')result=await window.ds.chatStart({...p,unknownCostConsent:{nonce:result.challenge.nonce,decision:'accept_unknown_cost'}});return result},{id,sessionId,text})
  const accepted=await start('desktop-recall-run','desktop-retrieval','查回之前随手提过的一条标记，返回原文。');assert.equal(accepted.runId,'desktop-recall-run',JSON.stringify(accepted))
  await expect.poll(async()=>{const detail=await page.evaluate(id=>window.ds.runsGet(id),'desktop-recall-run');return detail?.status},{timeout:20000}).toBe('completed')
  assert.deepEqual(errors,[]);assert.equal(requests.length,2)
  const plain=await start('desktop-plain-run','desktop-plain','你好，不需要查历史。');assert.equal(plain.runId,'desktop-plain-run')
  await expect.poll(async()=>{const detail=await page.evaluate(id=>window.ds.runsGet(id),'desktop-plain-run');return detail?.status},{timeout:20000}).toBe('completed')
  assert.equal(requests.length,3)
  await fs.mkdir(path.join(root,'out/harness-50'),{recursive:true});await fs.writeFile(path.join(root,'out/harness-50/conversation-retrieval-desktop.json'),JSON.stringify({synthetic:true,modelWindow:8192,requests,extraSummaryModelCalls:0},null,2))
 }finally{if(app)await app.close().catch(()=>{});if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}assert.equal(path.dirname(home),os.tmpdir());assert(path.basename(home).startsWith('dw-recall-desktop-'));await fs.rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:100})}
})
