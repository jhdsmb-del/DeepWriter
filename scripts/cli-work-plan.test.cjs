const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { spawn } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const moduleView = { exports: {} }
new Function('require', 'module', 'exports', buildSync({ entryPoints: [path.join(root, 'src/cli/presentation.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text)(require, moduleView, moduleView.exports)
const { humanText } = moduleView.exports

test('human status shows each checklist state without inventing a list or approval', () => {
  const steps = [{ text: '读取资料', status: 'done' }, { text: '整理比较', status: 'in_progress' }, { text: '核对交付', status: 'pending' }]
  assert.equal(humanText('status', { runId: 'r1', status: 'running', workPlan: { version: 1, steps } }), 'r1 · running\n任务清单\n✓ 读取资料\n● 整理比较\n○ 核对交付')
  assert.equal(humanText('status', { runId: 'r1', status: 'running', workPlan: null }), 'r1 · running')
  assert.equal(humanText('status', { runId: 'r1', status: 'running', workPlan: { version: 1, steps: [] } }), 'r1 · running')
  assert.match(humanText('status', { runId: 'r1', status: 'waiting_user', workPlan: { version: 1, steps, blockedOn: '收齐对方的确认件' } }), /等待：收齐对方的确认件$/)
})

function launch(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: root, env: { ...process.env, DEEPWRITER_API_KEY: '', DW_WORK_PLAN_NO_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => child.kill(), 20000)
    child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, events: stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line)) }) })
  })
}

test('status RUN reads the latest actual checklist receipt after CLI process restart, in JSON and human output', { timeout: 60000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-cli-work-plan-'))
  const bundle = path.join(home, 'deepwriter.cjs'), data = path.join(home, 'data')
  const steps = [{ text: '整理资料', status: 'done' }, { text: '核对交付', status: 'in_progress' }]
  let server, count = 0
  try {
    await fs.mkdir(data)
    const built = await launch(path.join(root, 'src/cli/build.mjs'), [`--outfile=${bundle}`]); assert.equal(built.code, 0, built.stderr)
    server = http.createServer((req, res) => { let raw = ''; req.on('data', part => { raw += part }); req.on('end', () => {
      const body = JSON.parse(raw)
      count++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let delta, finish_reason
      if (count <= 3) {
        assert.ok(body.tools.some(tool => tool.function.name === 'update_work_plan'))
        const input = count === 1 ? [{ text: '整理资料', status: 'in_progress' }, { text: '核对交付', status: 'pending' }] : count === 2 ? steps : [{ text: '不得覆盖上次清单', status: 'invalid' }]
        delta = { tool_calls: [{ index: 0, id: 'plan-' + count, type: 'function', function: { name: 'update_work_plan', arguments: JSON.stringify({ steps: input, ...(count === 2 ? { blockedOn: '收齐对方的确认件' } : {}) }) } }] }; finish_reason = 'tool_calls'
      } else { delta = { content: '已保存工作进度。' }; finish_reason = 'stop' }
      res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\ndata: [DONE]\n\n')
    }) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await fs.writeFile(path.join(data, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, loopback: true, keyEnv: 'DW_WORK_PLAN_NO_KEY', supportsTools: true, workDir: home }))
    const result = await launch(bundle, ['agent', '整理并核对这次任务', '--no-web', '--data-dir', data, '--json'])
    assert.equal(result.code, 2, result.stderr)
    const runResult = result.events.find(item => item.type === 'result').data
    assert.equal(runResult.status, 'waiting_user')
    const runId = runResult.runId
    const before = count
    const json = await launch(bundle, ['status', runId, '--data-dir', data, '--json'])
    assert.equal(json.code, 0, json.stderr)
    assert.deepEqual(json.events.find(item => item.type === 'status').data.workPlan, { version: 1, steps, blockedOn: '收齐对方的确认件' })
    const human = await launch(bundle, ['status', runId, '--data-dir', data])
    assert.equal(human.code, 0, human.stderr)
    assert.match(human.stdout, /任务清单\n✓ 整理资料\n● 核对交付/)
    assert.match(human.stdout, /等待：收齐对方的确认件/)
    assert.doesNotMatch(human.stdout, /不得覆盖|批准/)
    assert.equal(count, before, 'status must stay local and not call the provider')
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(home), os.tmpdir()); assert(path.basename(home).startsWith('dw-cli-work-plan-'))
    await fs.rm(home, { recursive: true, force: true })
  }
})
