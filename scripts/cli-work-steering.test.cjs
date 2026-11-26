const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { spawn } = require('node:child_process'), { DatabaseSync } = require('node:sqlite')
const root = path.resolve(__dirname, '..')
const parseEvents = text => text.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line))
function launch(file, args, cwd) {
  const child = spawn(process.execPath, [file, ...args], { cwd, env: { ...process.env, DEEPWRITER_API_KEY: '', STEERING_TEST_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    const timer = setTimeout(() => child.kill(), 30_000)
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, events: parseEvents(stdout) }) })
  })
  return { child, done }
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
test('bundled CLI accepts ordered steering from another process without replaying a completed write; pause keeps pending input for restart/resume', { timeout: 60000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-cli-steering-')), dir = await fs.realpath(temporary)
  const data = path.join(dir, 'data'), work = path.join(dir, 'work'), bundle = path.join(dir, 'deepwriter.cjs')
  const requests = [], firstBoundary = deferred(), pauseBoundary = deferred()
  let server, releaseFirst, heldPause, runProcess, phase = 'ordered'
  try {
    await Promise.all([fs.mkdir(data), fs.mkdir(work)])
    const built = await launch(path.join(root, 'src/cli/build.mjs'), ['--outfile=' + bundle], root).done
    assert.equal(built.code, 0, built.stderr)
    const send = (res, delta, finish = 'stop') => {
      res.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n')
      res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } }) + '\n\ndata: [DONE]\n\n')
    }
    server = http.createServer((req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const request = JSON.parse(body); requests.push(request)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const users = request.messages.filter(message => message.role === 'user').map(message => message.content)
        if (phase === 'ordered') {
          if (requests.length === 1) return send(res, { tool_calls: [{ index: 0, id: 'once-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'once.md', content: '只写一次。' }) } }] }, 'tool_calls')
          if (requests.length === 2) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '原回复。' }, finish_reason: null }] }) + '\n\n')
            releaseFirst = () => send(res, {}, 'stop'); firstBoundary.resolve(); return
          }
          return send(res, { content: users.includes('第二条：保留第一人称。') ? '两条补充均已处理。' : '已收到第一条补充。' })
        }
        if (phase === 'pause') {
          heldPause = res
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '尚未完的回复。' }, finish_reason: null }] }) + '\n\n')
          pauseBoundary.resolve(); return
        }
        send(res, { content: '已在恢复后处理保存的补充。' })
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const configPath = path.join(data, 'config.json')
    const config = { workDir: work, baseUrl: `http://127.0.0.1:${server.address().port}`, loopback: true, keyEnv: 'STEERING_TEST_KEY', supportsTools: true }
    await fs.writeFile(configPath, JSON.stringify(config))
    const local = args => launch(bundle, [...args, '--data-dir', data, '--json'], dir).done
    const runFromDb = () => {
      const db = new DatabaseSync(path.join(data, 'deepwriter.sqlite'))
      try { return db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get() } finally { db.close() }
    }
    runProcess = launch(bundle, ['chat', '写一次文件，然后回答。', '--tools', '--no-web', '--data-dir', data, '--json'], dir)
    await firstBoundary.promise
    const row = runFromDb(), runId = row.run_id
    assert.equal(await fs.readFile(path.join(work, 'once.md'), 'utf8'), '只写一次。')
    const first = await local(['steer', runId, '第一条：不要再改文件。', '--request-id', 'correction1'])
    assert.equal(first.code, 0, first.stderr); assert.equal(first.events[0].data.messages[0].status, 'pending')
    const second = await local(['steer', runId, '第二条：保留第一人称。', '--request-id', 'correction2'])
    assert.equal(second.code, 0, second.stderr)
    const repeat = await local(['steer', runId, '第一条：不要再改文件。', '--request-id', 'correction1'])
    assert.equal(repeat.code, 0); assert.equal(repeat.events[0].data.messages.length, 2)
    const sameText = await local(['steer', runId, '写一次文件，然后回答。', '--request-id', 'correction3'])
    assert.equal(sameText.code, 0, sameText.stderr)
    releaseFirst()
    const completed = await runProcess.done; assert.equal(completed.code, 0, completed.stderr)
    assert.equal(requests.length, 5)
    assert.equal(requests[2].messages.filter(m => m.role === 'user' && m.content === '第一条：不要再改文件。').length, 1)
    assert.equal(requests[2].messages.filter(m => m.role === 'user' && m.content === '第二条：保留第一人称。').length, 0)
    for (const content of ['第一条：不要再改文件。', '第二条：保留第一人称。']) assert.equal(requests[3].messages.filter(m => m.role === 'user' && m.content === content).length, 1)
    assert.deepEqual(requests[4].messages.filter(m => m.role === 'user').map(m => m.content), ['写一次文件，然后回答。', '第一条：不要再改文件。', '第二条：保留第一人称。', '写一次文件，然后回答。'])
    const snapshot = new DatabaseSync(path.join(data, 'deepwriter.sqlite'))
    try {
      assert.equal(snapshot.prepare("SELECT COUNT(*) n FROM toolcalls WHERE run_id=? AND name='write_file'").get(runId).n, 1)
      assert.equal(snapshot.prepare("SELECT COUNT(*) n FROM turns WHERE run_id=? AND turn_id LIKE 'steer_%'").get(runId).n, 3)
      const session = snapshot.prepare('SELECT * FROM session_messages WHERE session_id=? ORDER BY seq').all(row.session_id)
      assert.equal(session.at(-1).role, 'assistant')
    } finally { snapshot.close() }
    await fs.writeFile(configPath, JSON.stringify({ workDir: work, baseUrl: 'invalid', protocol: 'invalid' }))
    const listed = await local(['steering', runId]); assert.equal(listed.code, 0, listed.stderr)
    assert.equal(listed.events[0].data.messages.every(m => m.status === 'applied'), true)
    assert.equal(requests.length, 5)

    await fs.writeFile(configPath, JSON.stringify(config)); phase = 'pause'
    runProcess = launch(bundle, ['chat', '允许暂停的任务', '--tools', '--no-web', '--data-dir', data, '--json'], dir)
    await pauseBoundary.promise
    const pausedId = runFromDb().run_id
    const saved = await local(['steer', pausedId, '停止前保存的补充。', '--request-id', 'saved'])
    assert.equal(saved.code, 0, saved.stderr)
    const paused = await local(['pause', pausedId]); assert.equal(paused.code, 0, paused.stderr)
    const owner = await runProcess.done; assert.equal(owner.code, 2, owner.stderr)
    heldPause.destroy()
    const beforeResume = await local(['steering', pausedId])
    assert.equal(beforeResume.events[0].data.messages[0].status, 'pending')
    const oldRequests = requests.length
    phase = 'resume'
    const resumed = await local(['resume', pausedId]); assert.equal(resumed.code, 0, resumed.stderr)
    assert.equal(requests.length, oldRequests + 1, JSON.stringify(requests.slice(oldRequests).map(request => request.messages.map(message => ({ role: message.role, content: message.content?.slice(-250) })))))
    assert.equal(requests.at(-1).messages.filter(m => m.role === 'user' && m.content === '停止前保存的补充。').length, 1)
    assert.equal((await local(['steering', pausedId])).events[0].data.messages[0].status, 'applied')
    assert.equal(await fs.readFile(path.join(work, 'once.md'), 'utf8'), '只写一次。')
  } finally {
    releaseFirst?.(); heldPause?.destroy()
    if (runProcess?.child.exitCode === null) runProcess.child.kill()
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
    await fs.rm(temporary, { recursive: true, force: true })
  }
})
