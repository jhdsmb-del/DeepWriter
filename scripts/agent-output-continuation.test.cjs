// One real CLI / SQLite session per scenario; no API key or external transport.
const {test} = require('node:test')
const assert = require('node:assert/strict'), http=require('node:http')
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os')
const exec=require('node:util').promisify(require('node:child_process').execFile)
const {DatabaseSync}=require('node:sqlite')
const root=path.resolve(__dirname,'..')
test('work Agent continues token-clipped answers, never dispatches clipped tool frames, and preserves the full reply', {timeout:60000}, async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dw-output-')), bin=path.join(home,'cli.cjs')
 const fragment = i => '段'+i+'。'+'原'.repeat(1000)+'界'+i+'。'
 const seen=[]; let scenario, phase=0
 const server=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
   const body=JSON.parse(raw);seen.push(body);const i=phase++
   let delta,finish
   if(scenario==='text') {delta={content:fragment(i)};finish=i<6?'length':'stop'}
   else if(scenario==='tool' && !i){delta={tool_calls:[{index:0,id:'cut',type:'function',function:{name:'write_file',arguments:'{"path":"forbidden.txt"'}}]};finish='length'}
   else if(scenario==='empty'){delta={reasoning_content:'继续思考'};finish='length'}
   else {delta={content:'没有写入文件。'};finish='stop'}
   res.writeHead(200,{'content-type':'text/event-stream'})
   res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:finish}],usage:{prompt_tokens:25,completion_tokens:8}})+'\n\ndata: [DONE]\n\n')
 })})
 try{
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok)); await exec(process.execPath,['src/cli/build.mjs','--outfile='+bin],{cwd:root})
  for(scenario of ['text','tool','empty']){
    phase=0;seen.length=0
    const dir=path.join(home,scenario);await fs.mkdir(dir)
    await fs.writeFile(path.join(dir,'config.json'),JSON.stringify({baseUrl:'http://127.0.0.1:'+server.address().port,loopback:true,keyEnv:'DW_NULL_KEY',supportsTools:true,contextWindow:8192,maxTokens:2048,workDir:dir}))
    let stdout
    try{({stdout}=await exec(process.execPath,[bin,'agent','整理资料并交付','--no-web','--data-dir',dir,'--json'],{cwd:dir,timeout:15000,env:{...process.env,DW_NULL_KEY:'',DEEPWRITER_API_KEY:''}}))}
    catch(e){if(e.code!==2)throw e;stdout=e.stdout}
    const result=stdout.trim().split(/\r?\n/).map(l=>JSON.parse(l)).find(e=>e.type==='result').data
    if(scenario==='text'){
      assert.equal(phase,7);assert.equal(result.status,'completed')
      assert.ok(seen[6].messages.some(m=>m.content?.includes('界5。')))
      assert.ok(!seen[6].messages.some(m=>m.content?.includes('段0。')),'wire keeps a bounded tail, disk keeps the whole answer')
      const dbname=(await fs.readdir(dir)).find(s=>s.endsWith('.db')||s.endsWith('.sqlite'))
      const db=new DatabaseSync(path.join(dir,dbname),{readOnly:true})
      try{assert.equal(db.prepare("select content from session_messages where role='assistant' order by seq desc limit 1").get().content,Array.from({length:7},(_,i)=>fragment(i)).join(''))}finally{db.close()}
    }else if(scenario==='tool'){
      assert.equal(phase,2);assert.equal(result.status,'completed')
      assert.ok(seen[1].messages.some(m=>m.role==='system' && m.content.includes('没有执行')))
      assert.ok(!seen[1].messages.some(m=>m.tool_calls?.length||m.role==='tool'))
      await assert.rejects(fs.access(path.join(dir,'forbidden.txt')))
    }else{assert.equal(phase,1);assert.equal(result.status,'waiting_user');assert.equal(result.errorCode,'agent_output_stalled')}
  }
 }finally{await new Promise(ok=>server.close(ok));await fs.rm(home,{recursive:true,force:true})}
})
