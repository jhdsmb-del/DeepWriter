const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const { Document, Paragraph, Packer } = require('docx')
const { zip } = require('./fixtures/project-archive.cjs')
const root = path.resolve(__dirname, '..')
const built = buildSync({ stdin: { contents: `export {modelVisibleOutput} from './src/main/jobs/toolTurnOutput'; export {agentTools} from './src/main/agentTools'; export {buildToolSpecs,getTool} from './src/main/tools'; export {configureTerminalHost} from './src/cli/host'; export {freezeAgentTools,toolAllowed} from './src/shared/agentToolPolicy'; export {planToolAllowList} from './src/shared/agentPlanPolicy'; export {createToolExecutor} from './src/main/runKernelAdapter'; export {IDEMPOTENT_TOOLS} from './src/main/jobs/AgentRunEngine'; export {FileRefRegistry} from './src/main/fileRef'; export {readAttachedZip,attachmentZipHandle} from './src/main/attachedZip'`, resolveDir: root, loader: 'ts' }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false })
const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
const api = loaded.exports
async function call(name, args, env) { return api.getTool(name).execute(args, env.docDir, env) }
async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-work-tools-'))
  try {
    const work = path.join(directory, 'work'), docs = path.join(directory, 'docs')
    await fs.mkdir(work); await fs.mkdir(docs)
    api.configureTerminalHost({ dataDir: path.join(directory, 'host-data'), docDir: docs })
    await run(directory, work, { workDir: work, docDir: docs, sessionId: 'work-tools', runId: 'work-run', pagedFileReads: true })
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('dw-work-tools-'))
    await fs.rm(directory, { recursive: true, force: true })
  }
}
test('find_files handles Chinese glob/literal punctuation, honest coverage, pages and path authorization without shell', async () => fixture(async (directory, work, env) => {
  await fs.mkdir(path.join(work, '资料', '子目录'), { recursive: true })
  await fs.mkdir(path.join(work, '.hidden')); await fs.mkdir(path.join(work, 'node_modules'))
  const names = Array.from({ length: 140 }, (_, i) => `交接记录-${String(i).padStart(3, '0')}-审阅后需引用原路径[甲+7].md`)
  await Promise.all(names.map(name => fs.writeFile(path.join(work, '资料', '子目录', name), '不需读取正文就能找文件。')))
  await fs.writeFile(path.join(work, '资料', '交接记录-诱饵甲.md'), '不符合字面括号/加号条件')
  await fs.writeFile(path.join(work, '.hidden', '隐藏[甲+7].md'), '隐藏稿')
  await fs.writeFile(path.join(work, 'node_modules', '生成[甲+7].md'), '生成稿')
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, '越界[甲+7].md'), '不应被自动枚举')
  let linked = true
  try { await fs.symlink(outside, path.join(work, '跳转目录'), process.platform === 'win32' ? 'junction' : 'dir') } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; linked = false }
  const seen = [], args = { pattern: '**/*[甲+7].md' }
  let page
  do {
    const result = await call('find_files', { ...args, ...(page?.next_after_path ? { after_path: page.next_after_path } : {}) }, env)
    assert.equal(result.ok, true, result.message); assert.ok(JSON.stringify(result).length < 16000)
    page = JSON.parse(result.message); assert.equal(page.coverage.matches_after_path, 140 - seen.length)
    assert.equal(page.coverage.skipped_hidden, 1); assert.equal(page.coverage.skipped_generated_directories, 1)
    if (linked) assert.equal(page.coverage.skipped_links, 1)
    seen.push(...page.matches.map(item => item.relative_path))
  } while (page.next_after_path)
  assert.equal(seen.length, 140); assert.equal(new Set(seen).size, 140)
  assert.deepEqual(seen, seen.slice().sort())
  const hidden = await call('find_files', { pattern: '*.md', include_hidden: true, include_generated: true }, env)
  const all = JSON.parse(hidden.message); assert.equal(all.coverage.matches_after_path, 143)
  assert.equal((await call('find_files', { path: outside, pattern: '*.md' }, env)).ok, false)
  assert.equal((await call('find_files', { pattern: '../*' }, env)).ok, false)
  const cancelled = await call('find_files', args, { ...env, signal: AbortSignal.abort() }); assert.equal(cancelled.ok, false)
}))

test('read_files reuses real document/ZIP/text readers, isolates denial/errors and continues output without a file-count cap', async () => fixture(async (directory, work, env) => {
  await fs.writeFile(path.join(work, '甲.md'), '第一份原文：保管人叶棠。\n')
  await fs.writeFile(path.join(work, '乙.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('第二份原文：柜号杉柜-47。')] }] })))
  await fs.writeFile(path.join(work, '丙.zip'), zip([{ name: '中文/README.md', text: '第三份原文：交接日期周五。' }]))
  const outside = path.join(directory, 'outside.md'); await fs.writeFile(outside, '不可从工作区擅自读取')
  const result = await call('read_files', { files: [{ path: '甲.md' }, { path: '乙.docx' }, { path: '丙.zip', archive_entry: '中文/README.md' }, { path: '不存在.md' }, { path: outside }] }, env)
  assert.equal(result.ok, true, result.message); const data = JSON.parse(result.message)
  assert.deepEqual(data.files.map(item => item.ok), [true, true, true, false, false])
  assert.ok(data.files[0].message.includes('叶棠')); assert.ok(data.files[1].message.includes('杉柜-47')); assert.ok(data.files[2].message.includes('周五'))
  assert.ok(!result.message.includes('不可从工作区擅自读取')); assert.equal(data.next_index, undefined)
  await fs.writeFile(path.join(work, '长稿.md'), '🌊具体原文'.repeat(3000))
  const files = Array.from({ length: 19 }, () => ({ path: '长稿.md', max_chars: 2000 })), indexes = []
  let start = 1, pages = 0
  do {
    const page = await call('read_files', { files, start_index: start }, env)
    assert.equal(page.ok, true, page.message); assert.ok(api.modelVisibleOutput('read_files', JSON.stringify(page)).length < 18000); assert.ok(JSON.stringify(page).length < 50000)
    const body = JSON.parse(page.message); assert.ok(body.files.length); assert.ok(body.files.every(item => item.message.includes('续读 cursor=')))
    indexes.push(...body.files.map(item => item.index)); start = body.next_index; pages++
  } while (start)
  assert.deepEqual(indexes, Array.from({ length: 19 }, (_, i) => i + 1)); assert.ok(pages > 1)
  const explicit = await call('read_files', { files: [{ path: '长稿.md', max_chars: 5000 }] }, env)
  assert.equal(explicit.ok, true, explicit.message); assert.ok(JSON.parse(explicit.message).files[0].message.length > 5000)
  await fs.writeFile(path.join(work, '转义.md'), '\\'.repeat(20000))
  const escaped = await call('read_files', { files: [{ path: '转义.md', max_chars: 8000 }] }, env)
  assert.equal(escaped.ok, true, escaped.message); assert.ok(api.modelVisibleOutput('read_files', JSON.stringify(escaped)).length < 18000); assert.ok(JSON.stringify(escaped).length < 50000)
  assert.ok(JSON.parse(escaped.message).files[0].message.includes('续读 cursor='))
  assert.equal((await call('read_files', { files: [{ path: '甲.md', command: 'do not run' }] }, env)).ok, false)
  assert.equal((await call('read_files', { files: [{ path: '甲.md' }] }, { ...env, signal: AbortSignal.abort() })).ok, false)
  assert.equal(await fs.readFile(path.join(work, '甲.md'), 'utf8'), '第一份原文：保管人叶棠。\n')
}))

test('production executor opts new runs in by exact names, preserves legacy scopes and reads only this run frozen attachment refs in a batch', async () => fixture(async (directory, work, env) => {
  const local = api.freezeAgentTools(true, false)
  for (const name of ['find_files', 'read_files']) {
    assert.ok(api.buildToolSpecs(true).some(spec => spec.function.name === name)); assert.ok(api.IDEMPOTENT_TOOLS.has(name))
    assert.equal(api.toolAllowed(name, ['*']), false); assert.equal(api.toolAllowed(name, local), true)
  }
  const plan = { planMode: true, runMode: 'agent', agentPlan: { schemaVersion: 1, access: 'read_only' }, toolPolicy: { allowList: [...local, 'write_file', 'run_command'] } }
  const allowList = api.planToolAllowList(plan)
  assert.ok(allowList.includes('find_files') && allowList.includes('read_files')); assert.ok(!allowList.includes('write_file') && !allowList.includes('run_command'))
  assert.deepEqual(api.planToolAllowList({ ...plan, toolPolicy: { allowList: ['*'] } }), ['read_file', 'list_files', 'search_files'])
  const registry = new api.FileRefRegistry(), buffer = zip([{ name: 'README.md', text: '附件范围内的原文，不能扩大到父目录。' }]), attachment = path.join(directory, '选中的.zip')
  await fs.writeFile(attachment, buffer)
  const { refs } = await registry.register([attachment], { kind: 'session', sessionId: env.sessionId, draftId: 'current' }, 'dialog')
  const ref = { fileRefId: refs[0].fileRefId, name: refs[0].displayName, hash: createHash('sha256').update(buffer).digest('hex') }
  const config = { sessionId: env.sessionId, attachments: [ref] }
  const execute = api.createToolExecutor({ getSignal: () => undefined, getEnv: () => env, getAllowList: () => allowList,
    readAttachedZip: (runId, request, signal) => { assert.equal(runId, env.runId); return api.readAttachedZip(registry, config, request, signal) } })
  const got = JSON.parse(await execute('read_files', JSON.stringify({ files: [{ path: api.attachmentZipHandle(ref), archive_entry: 'README.md' }, { path: 'attachment:' + '0'.repeat(32), archive_entry: 'README.md' }] }), 'batch', env.runId))
  assert.equal(got.ok, true); const body = JSON.parse(got.message)
  assert.deepEqual(body.files.map(item => item.ok), [true, false]); assert.ok(body.files[0].message.includes('附件范围内的原文'))
  await assert.rejects(execute('write_file', JSON.stringify({ path: '不要写.md', content: 'forbidden' }), 'write', env.runId), /tool_not_allowed_by_mode/)
  const old = api.createToolExecutor({ getSignal: () => undefined, getEnv: () => env, getAllowList: () => ['*'] })
  await assert.rejects(old('read_files', JSON.stringify({ files: [{ path: attachment }] }), 'old', env.runId), /tool_not_allowed_by_mode/)
  await fs.writeFile(attachment, zip([{ name: 'README.md', text: '后续替换的文档' }]))
  const changed = JSON.parse(await execute('read_files', JSON.stringify({ files: [{ path: api.attachmentZipHandle(ref), archive_entry: 'README.md' }] }), 'changed', env.runId))
  assert.equal(JSON.parse(changed.message).files[0].ok, false)
  assert.deepEqual(await fs.readdir(work), [])
}))

function launch(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env: { ...process.env, DEEPWRITER_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => child.kill(), 30000)
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}
test('actual bundled CLI and read-only plan find three sources and derive the same total with fewer serialized provider rounds', async () => fixture(async (directory, work) => {
  await fs.mkdir(path.join(work, '资料'))
  for (const [name, amount] of [['甲', 94], ['乙', 150], ['丙', 206]]) await fs.writeFile(path.join(work, '资料', `交接-${name}.md`), `原始交接记录${name}\n金额：${amount}元。\n`)
  await fs.writeFile(path.join(work, '资料', '草稿.md'), '诱饵，金额：99999元。')
  const bundle = path.join(directory, 'deepwriter.cjs'), built = await launch(path.join(root, 'src/cli/build.mjs'), [`--outfile=${bundle}`], root)
  assert.equal(built.code, 0, built.stderr)
  const calls = { SERIAL: [], BATCH: [], PLAN: [] }, faults = []
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
      try {
        const body = JSON.parse(raw), mode = Object.keys(calls).find(key => body.messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(key)))
        assert.ok(mode); calls[mode].push(body)
        const receipts = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
        let tool, args, answer
        if (!receipts.length) {
          tool = mode === 'SERIAL' ? 'list_files' : 'find_files'; args = mode === 'SERIAL' ? { path: '资料', depth: 2 } : { path: '资料', pattern: '**/交接-*.md' }
          assert.ok(body.tools.some(item => item.function.name === 'find_files') && body.tools.some(item => item.function.name === 'read_files'))
          if (mode === 'PLAN') assert.ok(body.tools.every(item => !['write_file', 'run_command'].includes(item.function.name)))
        } else if (mode === 'SERIAL') {
          const names = [...receipts[0].message.matchAll(/^\s*(交接-[^\n]+\.md)$/gm)].map(match => '资料/' + match[1]); assert.equal(names.length, 3)
          if (receipts.length <= names.length) { tool = 'read_file'; args = { path: names[receipts.length - 1] } }
          else answer = `三份交接原文合计${receipts.slice(1).reduce((sum, item) => sum + Number(/金额：(\d+)/.exec(item.message)[1]), 0)}元。`
        } else if (receipts.length === 1) {
          const found = JSON.parse(receipts[0].message); assert.equal(found.matches.length, 3)
          tool = 'read_files'; args = { files: found.matches.map(item => ({ path: item.path })) }
        } else {
          const batch = JSON.parse(receipts.at(-1).message); assert.equal(batch.files.length, 3); assert.ok(batch.files.every(item => item.ok))
          const total = batch.files.reduce((sum, item) => sum + Number(/金额：(\d+)/.exec(item.message)[1]), 0)
          answer = mode === 'PLAN' ? `## 只读方案\n三份交接原文合计${total}元；批准后可把统计写入汇总稿。` : `三份交接原文合计${total}元。`
        }
        const delta = tool ? { tool_calls: [{ index: 0, id: `${mode}-${calls[mode].length}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: answer }
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
      } catch (error) { faults.push(error); res.writeHead(500); res.end('local work-tool fixture failed') }
    })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    for (const mode of ['SERIAL', 'BATCH', 'PLAN']) {
      const result = await launch(bundle, [mode === 'PLAN' ? 'plan' : 'agent', `${mode}：找资料里的三份交接md，从真实原文算合计，排除草稿。`, '--work-dir', work, '--data-dir', path.join(directory, 'cli-' + mode), '--base-url', `http://127.0.0.1:${server.address().port}`, '--loopback', '--no-web', '--json'], directory)
      assert.equal(result.code, 0, result.stderr); assert.deepEqual(faults, []); assert.ok(result.stdout.includes('合计450元'))
    }
    assert.equal(calls.SERIAL.length, 5); assert.equal(calls.BATCH.length, 3); assert.equal(calls.PLAN.length, 3)
    assert.deepEqual((await fs.readdir(work)).sort(), ['资料'])
    process.stdout.write('# work-tool evidence: actual CLI, three source-derived amounts; one-tool-per-round baseline 5 requests/4 tool calls -> find_files+read_files 3 requests/2 tool calls; read-only plan also 3, no writes\n')
  } finally { await new Promise(resolve => server.close(resolve)) }
}))
