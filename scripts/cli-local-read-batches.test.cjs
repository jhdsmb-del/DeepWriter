const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const syncFs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { test } = require('node:test')
const root = path.resolve(__dirname, '..')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
function launch(args, cwd, extraEnv = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, DEEPWRITER_API_KEY: '', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), 25000)
    child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }) })
  })
  return { child, done }
}
function readDb(dataDir, work) {
  const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true }); try { return work(db) } finally { db.close() }
}
const read = n => ({ id: `read-${n}`, name: 'read_file', arguments: JSON.stringify({ path: `${n}.md` }) })
const write = { id: 'write-barrier', name: 'write_file', arguments: JSON.stringify({ path: '0.md', content: '实际写屏障后的正文。' }) }

test('real bundled CLI + loopback model: ordered bounded reads, write/failure barriers, external cancel and cold crash recovery', { timeout: 90000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-cli-read-batches-')), bundle = path.join(directory, 'deepwriter.cjs'), preload = path.join(directory, 'delayed-fs.cjs')
  try {
    const built = await launch([path.join(root, 'src/cli/build.mjs'), `--outfile=${bundle}`], root).done; assert.equal(built.code, 0, built.stderr)
    // Slow the actual read_file probe at the OS file boundary, not an engine
    // replacement. Every read still executes the bundled production tool.
    await fs.writeFile(preload, `const fs=require('node:fs'),path=require('node:path');
const original=fs.promises.open,seen=new Set();
fs.promises.open=async function(file,...args){const name=path.basename(String(file)), target=path.resolve(String(file));
if(/^\\d+\\.md$/.test(name)&&target.startsWith(path.resolve(process.env.DW_BATCH_WORK)+path.sep)&&!seen.has(target)){
seen.add(target);fs.appendFileSync(process.env.DW_BATCH_TRACE,JSON.stringify({event:'start',name})+'\\n');
await new Promise(resolve=>setTimeout(resolve,Number(process.env.DW_BATCH_DELAY)));
try{return await original.call(this,file,...args)}finally{fs.appendFileSync(process.env.DW_BATCH_TRACE,JSON.stringify({event:'end',name})+'\\n')}
}return original.call(this,file,...args)};`)
    for (const mode of ['normal', 'failure', 'cancel', 'crash']) {
      const area = path.join(directory, mode), work = path.join(area, 'work'), docs = path.join(area, 'docs'), data = path.join(area, 'data'), trace = path.join(area, 'trace.jsonl')
      await fs.mkdir(work, { recursive: true }); await fs.mkdir(docs)
      for (let i = 0; i < 8; i++) await fs.writeFile(path.join(work, `${i}.md`), `真实本地文件${i}的正文。`)
      const batch = mode === 'normal' ? [...Array.from({ length: 8 }, (_, i) => read(i)), write, { ...read(0), id: 'after-write' }]
        : mode === 'failure' ? [read(0), read(1), { id: 'missing', name: 'read_file', arguments: '{"path":"missing.md"}' }, read(2), read(3)]
        : [...Array.from({ length: 4 }, (_, i) => read(i)), write]
      const requests = [], faults = []
      const server = http.createServer((req, res) => {
        let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
          try {
            const body = JSON.parse(raw); requests.push(body)
            let delta, finish
            if (requests.length === 1) { delta = { tool_calls: batch.map((tool, index) => ({ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } })) }; finish = 'tool_calls' }
            else {
              assert.ok(['normal', 'failure'].includes(mode), 'cancelled/interrupted run must not issue another provider request')
              const tools = body.messages.filter(message => message.role === 'tool'); assert.deepEqual(tools.map(tool => tool.tool_call_id), batch.map(tool => tool.id))
              if (mode === 'normal') { assert.match(tools[8].content, /确认|授权|交互|批准/); assert.match(tools.at(-1).content, /真实本地文件0的正文/); assert.doesNotMatch(tools.at(-1).content, /实际写屏障后的正文/) }
              else assert.equal(JSON.parse(tools[2].content).ok, false)
              delta = { content: '已根据本地多文件实际结果完成核对。' }; finish = 'stop'
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 50 } }) + '\n\ndata: [DONE]\n\n')
          } catch (error) { faults.push(error); res.writeHead(500); res.end('fixture failed') }
        })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const flags = ['--work-dir', work, '--doc-dir', docs, '--data-dir', data, '--base-url', `http://127.0.0.1:${server.address().port}`, '--loopback', '--context', '65536', '--no-web', '--json']
      let running
      try {
        running = launch(['--require', preload, bundle, 'agent', '同批读取多份本地文件，按工具实际结果作答。', ...flags], area, { DW_BATCH_WORK: work, DW_BATCH_TRACE: trace, DW_BATCH_DELAY: ['cancel', 'crash'].includes(mode) ? '2500' : '160' })
        if (['cancel', 'crash'].includes(mode)) {
          let ready = false
          for (let attempt = 0; attempt < 300; attempt++) { if (syncFs.existsSync(trace) && syncFs.readFileSync(trace, 'utf8').trim().split('\n').filter(line => JSON.parse(line).event === 'start').length === 4) { ready = true; break }; await wait(20) }
          assert.equal(ready, true, `${mode}: four real file reads must start before external control`)
          const runId = readDb(data, db => db.prepare('select run_id from runs').get().run_id)
          if (mode === 'cancel') {
            const control = await launch([bundle, 'cancel', runId, ...flags], area).done; assert.equal(control.code, 0, control.stderr)
            const result = await running.done; assert.equal(result.code, 1, result.stderr)
            const row = readDb(data, db => db.prepare('select status from runs').get()); assert.equal(row.status, 'cancelled')
            const records = readDb(data, db => db.prepare('select status from toolcalls').all()); assert.equal(records.length, 4); assert.ok(records.every(record => record.status === 'cancelled'))
          } else {
            // SIGTERM is intentionally handled: it is a graceful stop on POSIX, not a crash.
            assert.equal(running.child.kill('SIGKILL'), true)
            const crash = await running.done
            if (process.platform !== 'win32') assert.equal(crash.signal, 'SIGKILL')
            const resumed = await launch([bundle, 'resume', runId, ...flags], area).done; assert.notEqual(resumed.code, 0)
            const row = readDb(data, db => db.prepare('select status,error_code from runs').get()); assert.equal(row.status, 'recovery_required'); assert.equal(row.error_code, 'parallel_read_interrupted')
            const records = readDb(data, db => db.prepare('select name,status from toolcalls').all()); assert.equal(records.filter(record => record.status === 'side_effect_unknown').length, 4); assert.equal(records.find(record => record.name === 'write_file').status, 'failed')
          }
          assert.equal(requests.length, 1); assert.equal(await fs.readFile(path.join(work, '0.md'), 'utf8'), '真实本地文件0的正文。')
        } else {
          const result = await running.done; assert.equal(result.code, 0, result.stderr + result.stdout); assert.equal(requests.length, 2)
          const records = readDb(data, db => db.prepare('select tool_result_json from turns where role=\'tool\' order by turn_seq').all()); assert.deepEqual(records.map(row => JSON.parse(row.tool_result_json).toolCallId), batch.map(tool => tool.id))
          const events = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); let active = 0, max = 0
          for (const event of events) { active += event.event === 'start' ? 1 : -1; max = Math.max(max, active) }
          assert.equal(active, 0); assert.equal(max, mode === 'normal' ? 4 : 2)
        }
        assert.deepEqual(faults, []); process.stdout.write(`# real CLI ${mode}: ${requests.length} local provider calls; ordered batch and operating-system read boundary verified\n`)
      } finally { if (running && running.child.exitCode === null && running.child.signalCode === null) running.child.kill(); await new Promise(resolve => server.close(resolve)) }
    }
  } finally { assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('dw-cli-read-batches-')); await fs.rm(directory, { recursive: true, force: true }) }
})
