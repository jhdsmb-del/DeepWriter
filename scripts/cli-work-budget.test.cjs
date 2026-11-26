const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { test } = require('node:test')
const root = path.resolve(__dirname, '..')
const launch = (file, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], { cwd, env: { ...process.env, DEEPWRITER_API_KEY: '' }, stdio: ['ignore','pipe','pipe'] })
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk});child.stderr.on('data',chunk=>{stderr+=chunk})
  const timer=setTimeout(()=>child.kill(),180000);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})})
})
function read(dataDir, work) { const db=new DatabaseSync(path.join(dataDir,'deepwriter.sqlite'),{readOnly:true});try{return work(db)}finally{db.close()} }

test('real CLI loopback crosses old round/count and 20M cumulative tokens by default; explicit calls/rounds/token/time/money still stop', {timeout:240000}, async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dw-cli-work-budget-')),bundle=path.join(dir,'deepwriter.cjs')
  try {
    const built=await launch(path.join(root,'src/cli/build.mjs'),[`--outfile=${bundle}`],root);assert.equal(built.code,0,built.stderr)
    for(const mode of ['default','calls','rounds','token','time','money','preserve-rounds']) {
      const work=path.join(dir,mode),data=path.join(work,'data');await fs.mkdir(work);await fs.writeFile(path.join(work,'evidence.md'),'仅据本地文件实际原文。')
      let calls=0;const faults=[]
      const server=http.createServer((request,response)=>{let raw='';request.on('data',chunk=>{raw+=chunk});request.on('end',()=>{try{
        const body=JSON.parse(raw);calls++
        assert.equal(body.max_tokens,256,'native output bound is independent of work budget')
        const delta=mode==='default'&&calls===40?{content:'已穿过旧次数及累计token阈值完成任务。'}:{tool_calls:[{index:0,id:'step-'+calls,type:'function',function:{name:'read_file',arguments:'{"path":"evidence.md"}'}}]}
        response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.content?'stop':'tool_calls'}],usage:{prompt_tokens:600000,completion_tokens:1}})+'\n\ndata: [DONE]\n\n')
        if(mode==='default'&&calls%16===0)process.stdout.write(`# default Agent real local endpoint: ${calls} calls, ${calls*600001} provider-reported tokens\n`)
      }catch(error){faults.push(error);response.writeHead(500);response.end('fixture failure')}})})
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
      const flags=['--data-dir',data,'--work-dir',work,'--doc-dir',work,'--base-url',`http://127.0.0.1:${server.address().port}`,'--loopback','--context','1048576','--max-tokens','256','--no-web','--json']
      const limits=mode==='calls'?['--max-calls','3']:mode==='rounds'?['--max-turns','3']:mode==='token'?['--token-budget','1']:mode==='time'?['--time-budget-ms','1']:mode==='money'?['--cost-budget','1','--cost-currency','USD']:mode==='preserve-rounds'?['--max-calls','2','--max-turns','3']:[]
      try {
        const result=await launch(bundle,['agent','读取本地证据并按实际工具结果继续工作。',...flags,...limits],work)
        assert.deepEqual(faults,[])
        const row=read(data,db=>db.prepare('select * from runs').get()),config=JSON.parse(row.config_json),ledger=read(data,db=>JSON.parse(db.prepare("select json from run_evidence where kind='run_provider_budget_v1'").get().json))
        assert.equal(config.workBudgetPolicy,'explicit_v1');assert.equal(config.maxTokens,256)
        if(mode==='default') {
          assert.equal(result.code,0,result.stderr+result.stdout.slice(-2000));assert.equal(row.status,'completed');assert.equal(calls,40);assert.equal(ledger.totalCalls,40)
          assert.ok(ledger.knownInputTokens+ledger.knownOutputTokens>20_000_000);assert.deepEqual(ledger.limits,{maxCalls:null,maxTokens:null,maxCost:null,maxCostCny:null,maxWallClockMs:null});assert.equal(config.maxTurns,null)
        } else {
          assert.notEqual(result.code,0)
          const errors={calls:'run_provider_call_cap',rounds:'max_turns',token:'run_token_budget',time:'run_wall_clock_budget',money:'run_cost_unknown_price','preserve-rounds':'run_provider_call_cap'}
          assert.equal(row.error_code,errors[mode],result.stdout.slice(-2000))
          assert.equal(calls,mode==='calls'||mode==='rounds'?3:mode==='preserve-rounds'?2:0)
          if(mode==='calls') { const resumed=await launch(bundle,['resume',row.run_id,...flags],work);assert.notEqual(resumed.code,0);assert.equal(calls,3);assert.equal(read(data,db=>db.prepare('select config_json from runs').get().config_json),row.config_json) }
          if(mode==='preserve-rounds') { const resumed=await launch(bundle,['resume',row.run_id,'--max-calls','unlimited',...flags],work);assert.notEqual(resumed.code,0);assert.equal(calls,3);const frozen=read(data,db=>JSON.parse(db.prepare('select config_json from runs').get().config_json));assert.equal(frozen.maxTurns,3);assert.equal(frozen.providerCallBudget.maxCalls,null);assert.equal(read(data,db=>db.prepare('select error_code from runs').get().error_code),'max_turns') }
        }
        process.stdout.write(`# ${mode}: ${calls} actual loopback requests, ${row.status}/${row.error_code??'completed'}\n`)
      }finally{await new Promise(resolve=>server.close(resolve))}
    }
  } finally {assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('dw-cli-work-budget-'));await fs.rm(dir,{recursive:true,force:true})}
})
