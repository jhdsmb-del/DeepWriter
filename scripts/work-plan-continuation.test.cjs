// Exercise the ordinary Agent against a local provider through the shipped CLI path.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path'), os = require('node:os'), http = require('node:http')
const { promisify } = require('node:util')
const exec = promisify(require('node:child_process').execFile)
const root = path.resolve(__dirname, '..')
test('unfinished work follows actual progress, consumes a real source, and does not replay superseded checklists', {timeout: 55000}, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-work-continue-'))
  const seen = []
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
      const body = JSON.parse(raw); seen.push(body)
      const n = seen.length
      const plan = status => ({steps:[{text:'核对批号',status}]})
      const tools = (name, args) => ({ tool_calls:[{index:0, id:'c'+n,type:'function',function:{name,arguments:JSON.stringify(args)}}]})
      const delta = n === 7 ? tools('update_work_plan',plan('pending')) :
        (n === 8 || n === 9) ? {content:'我先停在这里。'} : n === 10 ? tools('update_work_plan',plan('done')) :
        n === 1 ? tools('update_work_plan',plan('in_progress')) :
        n === 2 ? {content:'先到这里。'} : n === 3 ? tools('read_file',{path:'batch.txt'}) :
        n === 4 ? {content:'文件找到了。'} : n === 5 ? tools('update_work_plan',plan('done')) : {content:'批号是 ZQ73。'}
      res.writeHead(200, {'content-type':'text/event-stream'})
      res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:18,completion_tokens:12}})+'\n\ndata: [DONE]\n\n')
    })
  })
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
    await fs.writeFile(path.join(home,'batch.txt'),'批号 ZQ73')
    await fs.writeFile(path.join(home,'config.json'),JSON.stringify({baseUrl:'http://127.0.0.1:'+server.address().port,loopback:true,keyEnv:'DW_WORK_TEST_UNUSED',supportsTools:true,workDir:home}))
    const bin = path.join(home,'cli.cjs')
    await exec(process.execPath,['src/cli/build.mjs','--outfile='+bin],{cwd:root})
    const {stdout} = await exec(process.execPath,[bin,'agent','先找到批号，再核对并交付','--data-dir',home,'--no-web','--json'],{cwd:home,timeout:35000,env:{...process.env, DW_WORK_TEST_UNUSED:'',DEEPWRITER_API_KEY:''}})
    assert.equal(seen.length,6,stdout.slice(-2300))
    assert.ok(seen[2].messages.some(m=>m.role==='system' && m.content.includes('清单还留有未完成项')))
    assert.ok(seen[3].messages.some(m=>m.role==='tool' && m.content.includes('ZQ73')))
    assert.equal(seen[4].messages.filter(m=>m.role==='system' && m.content.includes('清单还留有未完成项')).length,2,'another real tool result enables continued work')
    const calls = seen[5].messages.flatMap(m=>m.tool_calls??[]).filter(t=>t.function.name==='update_work_plan')
    assert.equal(calls.length,1,'only newest standalone snapshot crosses wire')
    assert.equal(JSON.parse(calls[0].function.arguments).steps[0].status,'done')
    assert.match(stdout, /completed/)
    // A non-cooperating model does not spin or turn a partial task green.
    const cli = async args => {
      try { return await exec(process.execPath,[bin,...args,'--data-dir',home,'--json'],{cwd:home,timeout:12000,env:{...process.env,DW_WORK_TEST_UNUSED:'',DEEPWRITER_API_KEY:''}}) }
      catch (error) { if (error.code !== 2) throw error; return error }
    }
    const partial = await cli(['agent','接手第二份核对任务','--no-web'])
    const readResult = text => text.trim().split(/\r?\n/).map(line=>JSON.parse(line)).find(e=>e.type==='result')?.data
    const stop = readResult(partial.stdout)
    assert.equal(seen.length,9)
    assert.equal(stop.status,'waiting_user')
    assert.equal(stop.errorCode,'work_plan_open')
    const continued = await cli(['resume',stop.runId])
    assert.equal(readResult(continued.stdout).status,'completed','resume uses the saved checklist and turns')
    assert.equal(seen.length,11)

  } finally {
    await new Promise(resolve=>server.close(resolve))
    await fs.rm(home,{recursive:true,force:true})
  }
})
