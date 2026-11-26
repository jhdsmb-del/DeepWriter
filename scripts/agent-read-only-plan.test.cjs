const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { before, after, test } = require('node:test')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..')
let dir, bundle, target, server, baseUrl, api
const requests = []
const original = '灯塔原稿：海鸥绕过旧钟。'
const revised = '灯塔新稿：海鸥绕过晨钟。'
const proposal = '## 执行方案\n将“旧钟”改为“晨钟”，保留其余稿件。'
function response(res, text, tools) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const delta = tools ? { tool_calls: tools.map((tool, index) => ({ index, id: tool.name + '-' + requests.length, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) } : { content: text }
  res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
}
async function run(args) {
  const child = spawn(process.execPath, [bundle, ...args], { cwd: dir, env: { ...process.env, DEEPWRITER_API_KEY: 'synthetic-plan-key' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  return { code, stdout, stderr, events: stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line)) }
}
const flags = dataDir => ['--data-dir', dataDir, '--work-dir', dir, '--base-url', baseUrl, '--loopback', '--no-web', '--json']
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-readonly-plan-'))
  target = path.join(dir, 'source.md'); await fs.writeFile(target, original)
  bundle = path.join(dir, 'deepwriter.cjs')
  const builder = spawn(process.execPath, ['src/cli/build.mjs', `--outfile=${bundle}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; builder.stderr.on('data', chunk => { log += chunk })
  await new Promise((resolve, reject) => builder.once('close', code => code === 0 ? resolve() : reject(new Error(log))))
  const built = await build({ stdin: { contents: `export * from './src/cli/config'; export {createCliRuntime} from './src/cli/runtime'; export {startChatRun} from './src/main/chatStart'; export * from './src/shared/agentPlanPolicy'; export {allowListFromConfig} from './src/main/runKernelAdapter'`, resolveDir: root, loader: 'ts' }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports); api = module.exports
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
      const body = JSON.parse(raw); requests.push(body)
      const planning = body.messages.some(message => message.role === 'system' && message.content.includes('当前是只读查稿与方案阶段'))
      const tools = body.messages.filter(message => message.role === 'tool')
      if (!tools.length) response(res, '', planning ? [
        { name: 'read_file', args: { path: target } },
        { name: 'write_file', args: { path: target, content: '禁止覆盖' } },
        { name: 'run_command', args: { command: 'echo forbidden' } },
        { name: 'dw_fake_delete', args: {} }
      ] : [{ name: 'write_file', args: { path: target, content: revised } }])
      else {
        if (planning) assert.ok(tools.some(tool => tool.content.includes('海鸥绕过旧钟')), 'review must consume actual file contents')
        response(res, planning ? proposal : tools.some(tool => tool.content.includes('agent_write_approval_required')) ? '修改未获授权，原稿保留。' : '按批准方案完成修改。')
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise(resolve => server.close(resolve))
  assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('dw-readonly-plan-'))
  await fs.rm(dir, { recursive: true, force: true })
})

test('旧计划仍无工具，新只读方案仅保留原授权的读取和可选联网', () => {
  assert.deepEqual(api.allowListFromConfig({ planMode: true, toolPolicy: { allowList: ['*', 'web_search'] } }), [])
  const config = { planMode: true, runMode: 'agent', agentPlan: { schemaVersion: 1, access: 'read_only' }, toolPolicy: { allowList: ['*', 'web_search', 'dw_fake_delete'] } }
  assert.deepEqual(api.planToolAllowList(config), ['read_file', 'list_files', 'search_files', 'web_search'])
  assert.deepEqual(api.allowListFromConfig(config), ['read_file', 'list_files', 'search_files'], '工具名不代替供应商联网冻结授权')
  assert.deepEqual(api.allowListFromConfig({ ...config, runMode: 'longwrite' }), [])
  assert.deepEqual(api.allowListFromConfig({ ...config, toolPolicy: { allowList: ['read_file'] } }), ['read_file'])
})

test('真实CLI只读查稿→保存方案→明确批准；拒写/伪造命令/扩展，批准不代替正常写入授权', async () => {
  const dataDir = path.join(dir, 'cli')
  await run(['plugins', 'install', 'builtin:deepwriter/manuscript-inspector', ...flags(dataDir)])
  await run(['plugins', 'enable', 'deepwriter/manuscript-inspector', ...flags(dataDir)])
  const before = requests.length
  const result = await run(['plan', '只读查稿，提出钟声修改方案。', '--plugin', 'deepwriter/manuscript-inspector', '--allow-plugin-start', 'deepwriter/manuscript-inspector', ...flags(dataDir)])
  assert.equal(result.code, 0, result.stderr)
  const plan = result.events.find(event => event.type === 'result').data.plan
  assert.equal(plan.text, proposal); assert.equal(plan.decision, 'pending')
  assert.equal(await fs.readFile(target, 'utf8'), original)
  assert.deepEqual(requests[before].tools.map(tool => tool.function.name).sort(), ['read_file', 'list_files', 'search_files', 'find_files', 'read_files'].sort())
  assert.ok(requests.at(-1).messages.filter(message => message.role === 'tool').slice(1).every(message => message.content.includes('plan_read_only')))
  assert.ok(!result.events.some(event => event.type === 'extension' && event.data.state === 'started'))
  let count = requests.length
  const invalid = await run(['approve', plan.runId, '--hash', '0'.repeat(64), ...flags(dataDir)])
  assert.equal(invalid.code, 1); assert.equal(requests.length, count)
  const approved = await run(['approve', plan.runId, '--hash', plan.hash, ...flags(dataDir)])
  assert.equal(approved.code, 0, approved.stderr)
  assert.equal(await fs.readFile(target, 'utf8'), original, 'approval never auto-grants write consent in a pipe')
  assert.ok(requests[count].tools.some(tool => tool.function.name === 'write_file'))
  const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
  const cfg = JSON.parse(db.prepare('select config_json from runs where run_id=?').get(approved.events.find(event => event.type === 'result').data.runId).config_json)
  assert.equal(cfg.planMode, false); assert.equal(cfg.planText, proposal); assert.equal(cfg.planApproval.runId, plan.runId)
  assert.equal(db.prepare("select count(*) n from run_evidence where kind like 'extension_host_started_%'").get().n, 0)
  db.close()
  count = requests.length
  assert.equal((await run(['approve', plan.runId, '--hash', plan.hash, ...flags(dataDir)])).code, 1)
  assert.equal(requests.length, count, 'repeated approval cannot spawn a second run')
})

test('共享真实运行批准后按正常授权写入；拒绝与目录/项目约定漂移均拒绝启动', async () => {
  const dataDir = path.join(dir, 'runtime'); await fs.mkdir(dataDir)
  const { config, secret } = await api.loadCliConfig(dataDir, { 'base-url': baseUrl, loopback: true, 'work-dir': dir, 'key-env': 'DW_PLAN_UNUSED_KEY' })
  const results = [], asks = []
  const runtime = await api.createCliRuntime({ dataDir, config, secret, options: { 'no-web': true }, emit: (type, data) => { if (type === 'result') results.push(data) }, ask: async message => { asks.push(message); return true } })
  try {
    await runtime.plan('查稿并提出修改方案')
    let plan = results.at(-1).plan
    assert.equal(asks.length, 0, 'forged write requests in a plan never reach permission prompts')
    await runtime.approvePlan(plan.runId, plan.hash)
    assert.equal(await fs.readFile(target, 'utf8'), revised)
    assert.equal(asks.length, 1, 'normal execution asks exactly once')
    await fs.writeFile(target, original)
    await runtime.plan('再次只读查稿')
    plan = results.at(-1).plan
    runtime.rejectPlan(plan.runId, plan.hash)
    const count = requests.length
    await assert.rejects(runtime.approvePlan(plan.runId, plan.hash), /已拒绝/)
    assert.equal(requests.length, count)
  } finally { await runtime.close() }
  // The actual CLI reloads directory and DEEPWRITER.md for every command.
  const sharedFlags = flags(dataDir)
  let result = await run(['plan', '检查当前目录约定', ...sharedFlags])
  let plan = result.events.find(event => event.type === 'result').data.plan
  const other = path.join(dir, 'other'); await fs.mkdir(other)
  let count = requests.length
  result = await run(['approve', plan.runId, '--hash', plan.hash, ...sharedFlags, '--work-dir', other])
  assert.equal(result.code, 1); assert.match(result.stderr, /目录已变化/); assert.equal(requests.length, count)
  await fs.writeFile(path.join(dir, 'DEEPWRITER.md'), '保持冷静的第三人称。')
  result = await run(['approve', plan.runId, '--hash', plan.hash, ...sharedFlags])
  assert.equal(result.code, 1); assert.match(result.stderr, /项目约定已变化/); assert.equal(requests.length, count)
  await fs.unlink(path.join(dir, 'DEEPWRITER.md'))
  result = await run(['approve', plan.runId, '--hash', plan.hash, ...sharedFlags])
  assert.equal(result.code, 0, result.stderr)
})

test('批准在接受事务内再次核验：落库失败回滚授权，异步准备期间的拒绝不能抢跑', async () => {
  const dataDir = path.join(dir, 'approval-fence'); await fs.mkdir(dataDir)
  const { config, secret } = await api.loadCliConfig(dataDir, { 'base-url': baseUrl, loopback: true, 'work-dir': dir, 'key-env': 'DW_PLAN_UNUSED_KEY' })
  let plan, terminal
  const runtime = await api.createCliRuntime({ dataDir, config, secret, options: { 'no-web': true }, emit: (type, data) => { if (type === 'result') { plan = data.plan; terminal = data } } })
  try {
    await runtime.plan('只读检查授权事务边界')
    assert.ok(plan, JSON.stringify(terminal))
    const source = JSON.parse(runtime.repo.getRun(plan.runId).config_json)
    const count = runtime.repo.listRunsBySession(plan.sessionId).length
    let starts = 0
    const deps = { repository: runtime.repo, runKernel: { start: async () => { starts++; return { ok: true } }, step: async () => {} }, loadSettings: async () => ({ model: config.model }),
      buildConfig: payload => ({ ...source, planMode: false, agentPlan: undefined, planText: payload.planText, planApproval: payload.planApproval }) }
    const payload = { id: 'approval-insert-fails', sessionId: plan.sessionId, mode: 'agent', phase: 'execute', planApproval: { runId: plan.runId, hash: plan.hash } }
    await assert.rejects(api.startChatRun(deps, { ...payload, planText: '未保存的替换方案' }), /未保存/)
    await assert.rejects(api.startChatRun(deps, { ...payload, sessionId: 'other-session' }), /身份或内容已变化/)
    await assert.rejects(api.startChatRun(deps, payload, { beforeInsertTurn: () => { throw new Error('fixture insert failure') } }), /fixture insert failure/)
    assert.equal(runtime.savedPlan(plan.runId).decision, 'pending')
    assert.equal(runtime.repo.listRunsBySession(plan.sessionId).length, count)
    await assert.rejects(api.startChatRun({ ...deps, buildConfig: payload => { runtime.rejectPlan(plan.runId, plan.hash); return deps.buildConfig(payload) } }, { ...payload, id: 'approval-rejected-during-prepare' }), /已拒绝/)
    assert.equal(runtime.repo.listRunsBySession(plan.sessionId).length, count)
    assert.equal(starts, 0)
    assert.equal(runtime.savedPlan(plan.runId).decision, 'rejected')
  } finally { await runtime.close() }
})
