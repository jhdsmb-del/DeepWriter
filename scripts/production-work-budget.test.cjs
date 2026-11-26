const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http')
const {test}=require('node:test'),{buildSync}=require('esbuild')
const root=path.resolve(__dirname,'..')
const built=buildSync({stdin:{resolveDir:root,loader:'ts',contents:`export {buildExecutionSnapshot} from './src/main/executionSnapshot';export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';export {createRepository} from './src/main/db/repository';export {createRunStorePort,createModelCallAdapter,createToolExecutor,allowListFromConfig} from './src/main/runKernelAdapter';export {loadCliConfig,kernelApi,cliModelContext} from './src/cli/config';export {configureTerminalHost} from './src/cli/host'`},bundle:true,packages:'external',platform:'node',format:'cjs',write:false,logLevel:'silent',alias:{electron:path.join(root,'src/cli/host.ts')}})
const loaded={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(require,loaded,loaded.exports);const api=loaded.exports

test('production longwrite and Galgame reach 18 real local model requests without a derived round/token/time/money cap', {timeout:30000},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dw-production-work-budget-'))
 const prose='到车站时，屏幕上写着北站至江湾暂时停运。我先看了发布时间，再把通知里的两个站名与自己的路线对照。现场工作人员指向另一侧的接驳车候车点，我沿着标识走过去，没有把相邻班次的间隔当成自己还要等多久。给同事发消息时，我只说明已确认的停运区间，以及自己正在核对替代路线；通知没有公布恢复时间，那一栏便暂时留空。'
 try{for(const mode of ['longwrite','galgame']){
  const work=path.join(dir,mode);await fs.mkdir(work);await fs.writeFile(path.join(work,'evidence.md'),'真实本地资料。');api.configureTerminalHost({dataDir:work,docDir:work})
  const repo=api.createRepository(path.join(work,'fixture.db'));repo.open();let engine,calls=0;const faults=[]
  const server=http.createServer((req,res)=>{let raw='';req.on('data',chunk=>{raw+=chunk});req.on('end',()=>{try{JSON.parse(raw);calls++;res.writeHead(200,{'content-type':'text/event-stream'})
   if(calls===18&&mode==='galgame'){res.write('data: '+JSON.stringify({choices:[{delta:{content:'正在处理真实项目，等待用户取消。'},finish_reason:null}]})+'\n\n');setTimeout(()=>{void engine.cancel(mode);res.end()},15);return}
   const delta=calls<18?{tool_calls:[{index:0,id:mode+'-'+calls,type:'function',function:{name:'read_file',arguments:'{"path":"evidence.md"}'}}]}:{content:prose}
   res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:calls<18?'tool_calls':'stop'}],usage:{prompt_tokens:500000,completion_tokens:100}})+'\n\ndata: [DONE]\n\n')
  }catch(error){faults.push(error);res.writeHead(500);res.end('fixture failure')}})})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
   const {config}=await api.loadCliConfig(work,{'base-url':`http://127.0.0.1:${server.address().port}`,loopback:true,'max-tokens':'256',context:'1048576','work-dir':work,'doc-dir':work})
   const snapshot=api.buildExecutionSnapshot({payload:{id:mode,mode,longMode:mode==='longwrite',targetChars:Array.from(prose).length,text:'按材料核对，保持目标。',attachments:[]},settings:{model:config.model,baseUrl:config.baseUrl,maxTokens:config.maxTokens,temperature:1,topP:1,thinkingEnabled:false,reasoningEffort:'low',workDir:work,docDir:work,novelMode:false,galgame:{enabled:mode==='galgame',projectDir:work,sdkPath:''},historyBudgetTokens:4096,completionTokenBudget:0,completionWallClockMs:0,strongConstraintEnabled:false},sessionId:mode,modelContext:api.cliModelContext(config),memory:{projectPath:'',projectContent:'',userContent:''}})
   assert.equal(snapshot.maxTurns,null);assert.equal(snapshot.workBudgetPolicy,'explicit_v1');assert.deepEqual(snapshot.providerCallBudget,{maxCalls:null,maxTokens:null,maxWallClockMs:null,maxCost:null,maxCostCny:null})
   assert.equal(snapshot.completionContract.tokenBudget,undefined);assert.equal(snapshot.completionContract.wallClockBudgetMs,undefined)
   const store=api.createRunStorePort(repo)
   const model=api.createModelCallAdapter({getApi:()=>api.kernelApi(config,'',true),getConfig:()=>snapshot,getSignal:()=>engine.abortSignal(mode),buildPrefix:async()=>snapshot.frozenSystemMessages})
   const host=api.createToolExecutor({getSignal:()=>engine.abortSignal(mode),getAllowList:()=>api.allowListFromConfig(snapshot),getEnv:()=>({workDir:work,docDir:work,sessionId:mode,pagedFileReads:true})})
   engine=api.createAgentRunEngine({store,modelCall:model,toolExecutor:host,getConfig:()=>snapshot,onEvent:()=>{},onRunUpdate:()=>{},publishLongwriteArtifact:async({content})=>{await fs.writeFile(path.join(work,'finished.md'),content);return{displayName:'finished.md',relativePath:'finished.md'}}})
   await engine.start({runId:mode,sessionId:mode,config:snapshot});await store.appendTurn({turnId:mode+'-user',runId:mode,turnSeq:1,role:'user',content:'核对材料并完成已确认的目标。',createdAt:Date.now()});await engine.step(mode)
   assert.deepEqual(faults,[]);const state=await engine.getState(mode);assert.equal(calls,18,JSON.stringify(state.run));assert.equal(state.run.status,mode==='longwrite'?'completed':'cancelled',JSON.stringify(state.run))
   if(mode==='longwrite')assert.equal(await fs.readFile(path.join(work,'finished.md'),'utf8'),prose)
   process.stdout.write(`# ${mode}: 18 actual loopback requests, ${state.run.status}; default work limits all null; target/validation/cancel contract retained\n`)
  }finally{await new Promise(resolve=>server.close(resolve));repo.close()}
 }}finally{assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('dw-production-work-budget-'));await fs.rm(dir,{recursive:true,force:true})}
})
