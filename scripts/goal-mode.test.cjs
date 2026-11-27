const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname,'..')
let api
before(() => {
  const built = buildSync({ stdin:{resolveDir:root,loader:'ts',contents:`
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {createRunStorePort,createModelCallAdapter} from './src/main/runKernelAdapter';
    export {createRepository} from './src/main/db/repository';
    export {queueWorkSteering} from './src/main/workSteering';
    export * from './src/main/goalMode'; export * from './src/shared/goalMode';`},
    bundle:true,platform:'node',format:'cjs',packages:'external',write:false,logLevel:'silent',alias:{electron:path.join(root,'src/cli/host.ts')} })
  const loaded={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(require,loaded,loaded.exports);api=loaded.exports
})
const outcome = {id:'answer',description:'解释风险并给出可执行建议',check:'答案含风险说明及两条行动建议',verification:'answer'}
const define = (outcomes=[outcome]) => ({action:'define',progress:'已将原目标转成具体成果',outcomes})
const tool = (id,name,args) => ({tools:[{id,name,arguments:JSON.stringify(args)}]})
const goalTool = (id,args) => tool(id,'update_goal',args)
const review = (goal,text,ok=true) => ({action:'review',progress:ok?'对照原始目标验收完成':'发现交付缺口，继续修正',originalObjectiveReview:ok?'原目标的风险说明和两条建议均已交付，未遗漏原要求':'原目标要求两条建议，候选只给了一条',originalSatisfied:ok,
  checks:[{id:'answer',satisfied:ok,reason:ok?'候选答案包含两项可执行行动':'尚缺第二条建议',evidence:ok?[{kind:'answer',reference:goal.candidateTurnId,quote:text,reason:'这段实际答案同时给出风险及两条可执行建议'}]:[]}]})
async function fixture(run,overrides={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dw-goal-test-'))
  const repo=api.createRepository(path.join(dir,'test.sqlite'));repo.open();repo.createSession('session','目标测试','')
  const config={runMode:'agent',goalMode:'guided',longMode:false,workDir:dir,docDir:dir,maxTurns:null,agentOutputContinuation:true,workBudgetPolicy:'explicit_v1',
    providerCallBudget:{maxCalls:null,maxTokens:null,maxCost:null,maxCostCny:null,maxWallClockMs:null},toolPolicy:{allowList:[]},...overrides}
  const store=api.createRunStorePort(repo), events=[], requests=[], external=[]
  let engine,calls=0,respond,executor=async(name,args,id)=>{external.push({name,args,id});return JSON.stringify({ok:true,message:'独特的实际观测：批号 ZQ73'})}
  const makeEngine=()=>api.createAgentRunEngine({store,getConfig:()=>config,onRunUpdate:()=>{},onEvent:(_id,e)=>events.push(e),
    toolExecutor:(...args)=>executor(...args),modelCall:async request=>{
      calls++;requests.push(request)
      assert.ok(calls<24,'supervision must not spin')
      const action=await respond({request,goal:api.getRunGoal(repo,'run'),calls})
      return (async function*(){
        if(action.tools){for(const[index,t]of action.tools.entries())yield{type:'tool_call',tool:{index,...t}};yield{type:'finish',finishReason:'tool_calls',toolReadBudgetChars:10000}}
        else {yield{type:'text',delta:action.text??''};yield{type:'finish',finishReason:action.finish??'stop'}}
      })()
    }})
  const f={repo,store,config,events,requests,external,dir,get calls(){return calls},get engine(){return engine},get goal(){return api.getRunGoal(repo,'run')},
    set respond(value){respond=value},set executor(value){executor=value},makeEngine,
    async start(objective='解释风险并给出两条建议，不要制造文件。'){engine=makeEngine();await engine.start({runId:'run',sessionId:'session',config});await store.appendTurn({turnId:'original',runId:'run',turnSeq:1,role:'user',content:objective,createdAt:1});return engine},
    async restore(){engine=makeEngine();await engine.restore('run');return engine}}
  try{await run(f)}finally{repo.close();assert.equal(path.dirname(dir),os.tmpdir());assert.match(path.basename(dir),/^dw-goal-test-/);await fs.rm(dir,{recursive:true,force:true})}
}

test('pure textual goal translates first, stop is only a candidate, then evidence review completes without local tools',async()=>fixture(async f=>{
  const answer='风险是误删原件。建议一：保留备份。建议二：先检查副本。'
  f.respond=({calls,goal})=>calls===1?goalTool('define',define()):calls===2?{text:answer}:goalTool('review',review(goal,answer))
  await(await f.start()).step('run')
  const state=await f.engine.getState('run')
  assert.equal(state.run.status,'completed');assert.equal(f.calls,3);assert.deepEqual(f.external,[])
  assert.equal(f.goal.status,'completed');assert.equal(f.goal.objective,'解释风险并给出两条建议，不要制造文件。')
  assert.equal(f.goal.outcomes[0].status,'done');assert.equal(f.goal.outcomes[0].evidence[0].quote,answer)
  assert.deepEqual(f.requests.map(r=>r.goalStage),['planning','active','reviewing'])
  assert.ok(f.events.some(e=>e.type==='goal_updated'))
}))

test('failed original-objective review follows through with a new result, never silently weakens the target',async()=>fixture(async f=>{
  const partial='风险是误删原件。建议一：保留备份。',full=partial+'建议二：先检查副本。'
  f.respond=({calls,goal})=>calls===1?goalTool('define',define()):calls===2?{text:partial}:calls===3?goalTool('reject',review(goal,partial,false)):calls===4?{text:full}:goalTool('accept',review(goal,full))
  await(await f.start()).step('run');assert.equal((await f.engine.getState('run')).run.status,'completed');assert.equal(f.calls,5)
  assert.equal(f.goal.outcomes[0].check,outcome.check);assert.equal(f.goal.outcomes[0].evidence[0].quote,full)
  assert.throws(()=>api.applyGoalUpdate({...f.goal,status:'active'},define([{...outcome,check:'只需要一条建议'}]),[],[]),/requirements_immutable/)
}))

test('bare done, bookkeeping-only loops, forged receipts and repeated unchanged repairs pause instead of turning green',async()=>{
  for(const scenario of ['bare','progress','forged','unchanged'])await fixture(async f=>{
    const partial='风险是误删原件。建议一：保留备份。'
    f.respond=({calls,goal})=>{
      if(scenario==='bare')return{text:'done'}
      if(calls===1)return goalTool('define',define())
      if(scenario==='progress')return goalTool('progress'+calls,{action:'progress',progress:'继续努力，第'+calls+'轮'})
      if(calls===2||scenario==='unchanged'&&goal.status==='active')return{text:partial}
      if(scenario==='forged')return goalTool('fake'+calls,review({...goal,candidateTurnId:'made_up'},partial))
      if(goal.status==='reviewing')return goalTool('negative'+calls,review(goal,partial,false))
      return{text:partial}
    }
    await(await f.start()).step('run');const state=await f.engine.getState('run')
    assert.equal(state.run.status,'waiting_user',scenario);assert.equal(state.run.errorCode,'goal_no_progress',scenario)
    assert.equal(f.goal.status,'blocked');assert.ok(f.calls<=7,scenario);assert.equal(f.goal.outcomes.some(o=>o.status==='done'),false)
  })
})

test('guided clarification persists and a real same-run steering reply resumes; autonomous preference questions cannot pause as clarification',async()=>{
  await fixture(async f=>{
    f.respond=()=>goalTool('question',{action:'blocked',progress:'缺少交付对象',blockedOn:{kind:'clarification',reason:'建议面向新员工还是管理者？',nextAction:'请确认目标读者',recommendation:'建议面向新员工。'}})
    await(await f.start()).step('run');assert.equal((await f.engine.getState('run')).run.status,'waiting_user')
    assert.equal((await f.engine.listRecoverable())[0].status,'waiting_user','a real goal question stays an explicit reply boundary across recovery inventory')
    api.queueWorkSteering(f.repo,{runId:'run',sessionId:'session',requestId:'answer',text:'面向新员工，请继续。'})
    const answer='新员工须防误删。建议一：保留备份。建议二：检查副本。'
    f.respond=({calls,goal})=>calls===2?goalTool('define',define()):calls===3?{text:answer}:goalTool('review',review(goal,answer))
    await f.engine.step('run');assert.equal((await f.engine.getState('run')).run.status,'completed')
    assert.ok(f.requests[1].messages.some(m=>m.role==='user'&&m.content==='面向新员工，请继续。'))
    assert.equal(f.goal.objective,'解释风险并给出两条建议，不要制造文件。')
  })
  await fixture(async f=>{
    await f.start();const g={schemaVersion:1,runId:'run',mode:'autonomous',objective:'任务',status:'planning',outcomes:[],progress:'开始',revision:0,updatedAt:1,stalledRounds:0}
    assert.throws(()=>api.applyGoalUpdate(g,{action:'blocked',progress:'决定格式',blockedOn:{kind:'clarification',reason:'要哪个风格？',nextAction:'请选择',recommendation:'简洁'}},[],[]),/preference_question/)
    f.respond=()=>goalTool('blocked',{action:'blocked',progress:'缺少必要输入',blockedOn:{kind:'missing_input',reason:'用户尚未提供必须处理的材料',nextAction:'提供原始材料后继续'}})
    await f.engine.step('run');assert.equal((await f.engine.getState('run')).run.status,'waiting_user');assert.equal(f.calls,1)
  },{goalMode:'autonomous'})
})

test('permission refusal stops remaining declared side effects with protocol receipts; cancellation, explicit caps and restart keep their authority',async()=>{
  await fixture(async f=>{
    f.respond=({calls})=>calls===1?goalTool('define',define([{...outcome,verification:'tool'}])):{tools:[...tool('denied','write_file',{path:'a.txt'}).tools,...tool('later','write_file',{path:'b.txt'}).tools]}
    f.executor=async(name,args,id)=>{f.external.push(id);return JSON.stringify({ok:false,message:'permission_denied：授权已失效'})}
    await(await f.start()).step('run');const state=await f.engine.getState('run')
    assert.equal(state.run.status,'waiting_user');assert.equal(state.run.errorCode,'goal_blocked');assert.deepEqual(f.external,['denied'])
    assert.equal(state.turns.filter(t=>t.role==='tool').length,3,'unexecuted later call still gets its failed protocol receipt')
    assert.equal(f.goal.blockedOn.kind,'permission')
    await f.restore();assert.equal((await f.engine.getState('run')).run.status,'waiting_user');assert.equal(f.calls,2)
  },{toolPolicy:{allowList:['write_file']}})
  await fixture(async f=>{await f.start();await f.engine.cancel('run');await f.engine.step('run');assert.equal((await f.engine.getState('run')).run.status,'cancelled');assert.equal(f.goal.status,'stopped');assert.equal(f.calls,0)})
  await fixture(async f=>{f.respond=()=>goalTool('define',define());await(await f.start()).step('run');const state=await f.engine.getState('run');assert.equal(state.run.status,'waiting_user');assert.equal(state.run.errorCode,'run_provider_call_cap');assert.equal(f.calls,1);assert.equal(f.goal.status,'blocked')},{providerCallBudget:{maxCalls:1,maxTokens:null,maxCost:null,maxCostCny:null,maxWallClockMs:null}})
})

test('file obligation cannot turn green through an answer-only goal review without a matching actual file',async()=>fixture(async f=>{
  f.respond=({calls,goal})=>calls===1?goalTool('define',define([{...outcome,description:'给出通知正文',check:'答案包含通知',verification:'answer'}])):
    goal.status==='reviewing'?goalTool('review'+calls,review(goal,'通知：末班船在22:03离岸。')):{text:'通知：末班船在22:03离岸。'}
  await(await f.start('请把通知保存为通知.md，不要仅给正文。')).step('run')
  const state=await f.engine.getState('run')
  assert.equal(state.run.status,'waiting_user');assert.notEqual(f.goal.status,'completed');assert.equal(f.goal.status,'blocked')
  await assert.rejects(fs.access(path.join(f.dir,'通知.md')))
  assert.equal(f.goal.outcomes[0].status,'pending')
}))

test('recovery never replays an unknown write, and a paused candidate with length fragments is reviewed and replaced as one answer',async()=>{
  await fixture(async f=>{
    await f.start();const g={schemaVersion:1,runId:'run',mode:'guided',objective:'原任务',status:'active',outcomes:[{...outcome,status:'pending',evidence:[]}],progress:'处理中',revision:1,updatedAt:1,stalledRounds:0}
    await f.store.saveRunEvidence('run','goal_mode_v1',JSON.stringify(g))
    await f.store.appendTurn({turnId:'write-turn',runId:'run',turnSeq:2,role:'assistant',content:'',toolCallsJson:JSON.stringify([{id:'write',name:'write_file',arguments:'{}'}]),createdAt:2})
    await f.store.upsertToolCall({toolCallId:'write',runId:'run',turnId:'write-turn',name:'write_file',argsJson:'{}',argsHash:'fixture',status:'running',startedAt:2})
    await f.restore();const state=await f.engine.getState('run')
    assert.equal(state.run.status,'recovery_required');assert.equal(state.toolCalls[0].status,'side_effect_unknown');assert.equal(f.calls,0);assert.deepEqual(f.external,[])
  })
  await fixture(async f=>{
    const first='风险是误删。建议一：保留备份。',tail='建议二：先检查副本。'
    f.respond=({calls,goal})=>calls===1?goalTool('define',define()):calls===2?{text:first,finish:'length'}:calls===3?{text:tail}:goalTool('review',review(goal,first+tail))
    await(await f.start()).step('run');const state=await f.engine.getState('run')
    assert.equal(state.run.status,'completed');assert.equal(f.goal.outcomes[0].evidence[0].quote,first+tail)
    assert.equal(f.events.filter(e=>e.type==='content_replace').at(-1).content,first+tail)
  })
})

test('tool evidence must be successful, real, quoted and fresh for a failed repair; arbitrary old success and plan marks do not prove a goal',()=>{
  const base={schemaVersion:1,runId:'r',mode:'guided',objective:'交付文件',status:'reviewing',outcomes:[{...outcome,verification:'tool',status:'pending',evidence:[]}],progress:'验收',revision:1,updatedAt:1,stalledRounds:0,candidateTurnId:'answer',definedAtTurnSeq:1,reviewAfterTurnSeq:3}
  const turns=[{turnId:'old',role:'assistant',turnSeq:2,content:''},{turnId:'answer',role:'assistant',turnSeq:4,content:'成果已经交付，请看内容。'},{turnId:'review',role:'assistant',turnSeq:6,content:''}]
  const old={toolCallId:'old_call',name:'read_file',turnId:'old',status:'completed',resultJson:JSON.stringify({ok:true,message:'真实原文 ZQ73'})}
  const req=review(base,'ignored');req.checks[0].evidence=[{kind:'tool',reference:'old_call',quote:'真实原文 ZQ73',reason:'这是读回内容'}]
  assert.throws(()=>api.applyGoalUpdate(base,req,turns,[old]),/evidence_invalid/)
  turns.push({turnId:'fresh',role:'assistant',turnSeq:5,content:''});const fresh={...old,toolCallId:'fresh_call',turnId:'fresh'}
  req.checks[0].evidence[0].reference='fresh_call';assert.equal(api.applyGoalUpdate(base,req,turns,[fresh]).status,'completed')
  assert.throws(()=>api.applyGoalUpdate(base,req,turns,[{...fresh,status:'failed'}]),/evidence_invalid/)
  assert.throws(()=>api.applyGoalUpdate(base,req,turns,[{...fresh,name:'update_work_plan'}]),/evidence_invalid/)
})

test('undefined mode remains ordinary execution; staged schemas and projected bookkeeping leave room for actual source evidence',async()=>{
  await fixture(async f=>{f.respond=()=>({text:'普通答复照常结束。'});await(await f.start()).step('run');assert.equal((await f.engine.getState('run')).run.status,'completed');assert.equal(f.calls,1);assert.equal(f.goal,null)},{goalMode:undefined})
  const planning=api.goalToolSpecForStage('planning'),active=api.goalToolSpecForStage('active'),reviewing=api.goalToolSpecForStage('reviewing')
  assert.equal(active.function.parameters.properties.checks,undefined);assert.equal(reviewing.function.parameters.properties.outcomes,undefined)
  assert.ok(JSON.stringify(active).length<JSON.stringify(api.goalToolSpec).length)
  assert.deepEqual(planning.function.parameters.properties.action.enum,['define','blocked'])
})
