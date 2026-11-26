const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { test } = require('node:test')

const root = path.resolve(__dirname, '..')
const events = stdout => stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line))
function launch(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, DEEPWRITER_API_KEY: '', DEEPWRITER_UNDO_NO_KEY: '' }
    const child = spawn(process.execPath, [file, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => child.kill(), 20_000)
    child.on('error', reject)
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, events: events(stdout) }) })
  })
}

test('actual CLI model receives a typography miss, retries the returned original, then locally undoes after restart', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-cli-undo-recovery-'))
  const dir = await fs.realpath(temporary), bundle = path.join(dir, 'deepwriter.cjs')
  const workDir = path.join(dir, 'book'), dataDir = path.join(dir, 'data'), file = path.join(workDir, '河岸.md')
  const original = Buffer.from('\ufeff前记。\n她说：“别\u00a0走。”\t\r\n  她没有动。\r\n\n尾声 — ①。')
  const intended = '她说：“先走吧。”\n她没有动。'
  const requests = []
  let server, untouchedAtRecovery, recovery, serverError
  try {
    await Promise.all([fs.mkdir(workDir), fs.mkdir(dataDir)])
    await fs.writeFile(file, original)
    const built = await launch(path.join(root, 'src/cli/build.mjs'), [`--outfile=${bundle}`], root)
    assert.equal(built.code, 0, built.stderr)
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          const request = JSON.parse(body); requests.push(request)
          const lastTool = request.messages.findLast(message => message.role === 'tool')
          let args, id
          if (!lastTool) {
            args = { path: '河岸.md', old_text: '她说："别 走。"\n她没有动。', new_text: intended }; id = 'formatting-miss'
          } else if (!JSON.parse(lastTool.content).ok) {
            recovery = JSON.parse(lastTool.content).editRecovery
            untouchedAtRecovery = await fs.readFile(file)
            args = { path: '河岸.md', new_text: intended, ...recovery.candidates[0].retry }; id = 'formatting-retry'
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const delta = args ? { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'edit_file', arguments: JSON.stringify(args) } }] } : { content: '已改好这一段。' }
          res.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: args ? 'tool_calls' : 'stop' }] }) + '\n\n')
          res.end('data: [DONE]\n\n')
        } catch (error) { serverError = error; res.destroy(error) }
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const configPath = path.join(dataDir, 'config.json')
    await fs.writeFile(configPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, loopback: true, workDir, keyEnv: 'DEEPWRITER_UNDO_NO_KEY', supportsTools: true }))
    const local = args => launch(bundle, [...args, '--data-dir', dataDir, '--json'], dir)
    const result = await local(['chat', '修改别走这一段，不改其他段落', '--tools', '--no-web'])
    assert.ifError(serverError); assert.equal(result.code, 0, result.stderr)
    assert.equal(requests.length, 3)
    assert.deepEqual(untouchedAtRecovery, original, 'failed typography match must not write')
    assert.equal(recovery.count, 1)
    assert.equal(recovery.candidates[0].retry.old_text, '她说：“别\u00a0走。”\t\r\n  她没有动。')
    assert.equal(recovery.candidates[0].retry.at_line, 2)
    assert.equal(await fs.readFile(file, 'utf8'), '\ufeff前记。\n她说：“先走吧。”\r\n她没有动。\r\n\n尾声 — ①。')
    const receipt = JSON.parse(requests.at(-1).messages.findLast(message => message.role === 'tool').content)
    assert.deepEqual(receipt.edit, { count: 1, lines: [2] })
    assert.equal(receipt.editUndo, undefined); assert.equal(receipt.backupId, undefined)
    const runId = result.events.find(event => event.type === 'result').data.runId
    await fs.writeFile(configPath, JSON.stringify({ workDir, baseUrl: 'invalid', protocol: 'invalid' }))
    const changes = await local(['changes', runId])
    assert.equal(changes.code, 0, changes.stderr)
    assert.equal(changes.events[0].data.changes.length, 1, 'failed candidate receipt is not an applied edit')
    assert.equal(changes.events[0].data.changes[0].toolCallId, 'formatting-retry')
    const undo = await local(['undo-edit', runId, 'formatting-retry'])
    assert.equal(undo.code, 0, undo.stderr); assert.equal(undo.events[0].data.status, 'undone')
    assert.deepEqual(await fs.readFile(file), original)
    assert.equal(requests.length, 3, 'local undo must not ask the model')
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(temporary), os.tmpdir())
    assert.ok(path.basename(temporary).startsWith('deepwriter-cli-undo-recovery-'))
    await fs.rm(temporary, { recursive: true, force: true })
  }
})

test('bundled CLI discovers exact edits and undoes locally after restart without credentials or model requests', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-cli-undo-'))
  // Use the actual temporary volume rather than a host profile junction.
  const dir = await fs.realpath(temporary), bundle = path.join(dir, 'deepwriter.cjs')
  const workDir = path.join(dir, 'book'), dataDir = path.join(dir, 'data'), docDir = path.join(dataDir, 'documents')
  let server
  try {
    await Promise.all([fs.mkdir(workDir), fs.mkdir(dataDir)])
    const built = await launch(path.join(root, 'src/cli/build.mjs'), [`--outfile=${bundle}`], root)
    assert.equal(built.code, 0, built.stderr)
    const requests = []
    let editNumber = 0
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const request = JSON.parse(body); requests.push(request)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (request.messages.some(message => message.role === 'tool')) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '已改名。' }, finish_reason: null }] }) + '\n\n')
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }) + '\n\n')
        } else {
          const args = { path: '河岸.md', old_text: '小曲', new_text: '小禾$&', replace_all: true }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `actual-edit-${++editNumber}`, type: 'function', function: { name: 'edit_file', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + '\n\n')
        }
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const configPath = path.join(dataDir, 'config.json')
    // The unrelated default document root intentionally has never existed.
    const config = { baseUrl, loopback: true, workDir, keyEnv: 'DEEPWRITER_UNDO_NO_KEY', supportsTools: true }
    const saveConfig = value => fs.writeFile(configPath, JSON.stringify(value))
    await saveConfig(config)
    const local = (args, json = true) => launch(bundle, [...args, '--data-dir', dataDir, ...(json ? ['--json'] : [])], dir)
    const file = path.join(workDir, '河岸.md')
    const original = Buffer.from('\ufeff小曲过桥。\r\n' + '作者未展示的长段落。'.repeat(300) + '\r\n小曲回头。')
    await fs.writeFile(file, original)
    const help = await local(['--help'], false)
    assert.match(help.stdout, /undo-edit <RUN> <TOOL>/)
    const absent = path.join(dir, 'never-created')
    const missing = await launch(bundle, ['undo-edit', 'missing-run', 'missing-tool', '--data-dir', absent, '--json'], dir)
    assert.equal(missing.code, 1); assert.equal(missing.events[0].type, 'error')
    await assert.rejects(fs.access(absent), { code: 'ENOENT' })
    const edit = await local(['chat', '把小曲全部改名', '--tools', '--no-web'])
    assert.equal(edit.code, 0, edit.stderr)
    assert.match(await fs.readFile(file, 'utf8'), /小禾\$&过桥/)
    const runId = edit.events.find(event => event.type === 'result').data.runId
    assert.equal(requests.length, 2)
    const receipt = requests.at(-1).messages.findLast(message => message.role === 'tool').content
    assert.deepEqual(JSON.parse(receipt).edit, { count: 2, lines: [1, 3] })
    for (const internal of ['editUndo', 'backupId', workDir, docDir, dataDir]) assert.ok(!receipt.includes(internal), internal)
    const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'))
    let tool
    try { tool = db.prepare('SELECT * FROM toolcalls WHERE run_id = ?').get(runId) } finally { db.close() }
    assert.equal(tool.tool_call_id, 'actual-edit-1')
    assert.ok(tool.result_json.includes('editUndo')); assert.ok(tool.result_json.includes('backupId'))

    // Saved Provider settings are deliberately unusable. Author-local actions
    // still use only current directories and durable edit identity.
    await saveConfig({ ...config, baseUrl: 'not-a-provider-url', model: '', protocol: 'invalid', apiKey: 'must-never-print' })
    const changed = await local(['changes', runId])
    assert.equal(changed.code, 0, changed.stderr)
    const change = changed.events[0].data.changes[0]
    assert.equal(change.toolCallId, tool.tool_call_id); assert.equal(change.runId, runId)
    assert.equal(change.undo.status, 'available')
    assert.deepEqual(change.undo.command, ['undo-edit', runId, tool.tool_call_id, '--data-dir', dataDir])
    const human = await local(['changes', runId], false)
    assert.match(human.stdout, new RegExp(`撤销：undo-edit ${runId} actual-edit-1`))
    for (const output of [changed.stdout, human.stdout]) {
      assert.ok(output.length < 2500)
      for (const privateText of ['must-never-print', 'editUndo', 'backupId', '作者未展示的长段落']) assert.ok(!output.includes(privateText), privateText)
    }
    // A new project root is not permission to restore an old project's file.
    const other = path.join(dir, 'other'); await fs.mkdir(other)
    const wrongRoot = await local(['undo-edit', runId, tool.tool_call_id, '--work-dir', other])
    assert.equal(wrongRoot.code, 2, wrongRoot.stderr)
    assert.equal(wrongRoot.events[0].data.code, 'project_changed')
    const undone = await launch(bundle, [...change.undo.command, '--json'], dir)
    assert.equal(undone.code, 0, undone.stderr)
    assert.equal(undone.events[0].data.status, 'undone')
    assert.deepEqual(await fs.readFile(file), original)
    const reopened = await local(['changes', runId])
    assert.equal(reopened.events[0].data.changes[0].undo.status, 'undone')
    const repeated = await local(['undo-edit', runId, tool.tool_call_id])
    assert.equal(repeated.code, 0); assert.equal(repeated.events[0].data.status, 'already_undone')
    assert.equal(requests.length, 2, 'local author actions must not ask a model')

    // One more real edit supplies a distinct checkpoint for the external-change
    // conflict path; undo must leave the author's newer bytes untouched.
    await saveConfig(config)
    const second = await local(['chat', '再次改名', '--tools', '--no-web'])
    assert.equal(second.code, 0, second.stderr)
    const secondId = second.events.find(event => event.type === 'result').data.runId
    const afterSecond = requests.length
    assert.equal(afterSecond, 4)
    await saveConfig({ ...config, baseUrl: 'invalid', protocol: 'invalid' })
    const external = '作者次日另写的新稿\r\n不可覆盖。'
    await fs.writeFile(file, external)
    const conflict = await local(['undo-edit', secondId, 'actual-edit-2'])
    assert.equal(conflict.code, 2, conflict.stderr)
    assert.equal(conflict.events[0].data.status, 'blocked')
    assert.equal(conflict.events[0].data.code, 'file_changed')
    assert.equal(await fs.readFile(file, 'utf8'), external)
    const wrongIdentity = await local(['undo-edit', secondId, 'actual-edit-1'])
    assert.equal(wrongIdentity.code, 2); assert.equal(wrongIdentity.events[0].data.code, 'edit_not_found')
    assert.equal(requests.length, afterSecond)
    assert.ok(!(await fs.readdir(dataDir)).includes('execution.lock'))
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(temporary), os.tmpdir())
    assert.ok(path.basename(temporary).startsWith('deepwriter-cli-undo-'))
    await fs.rm(temporary, { recursive: true, force: true })
  }
})
