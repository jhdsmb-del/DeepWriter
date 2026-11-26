const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { isBuiltin } = require('node:module')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const { Document, Paragraph, Packer } = require('docx')
const root = path.resolve(__dirname, '..')
const built = buildSync({ stdin: { contents: `export {modelVisibleOutput} from './src/main/jobs/toolTurnOutput'; export {agentTools} from './src/main/agentTools'; export {configureTerminalHost} from './src/cli/host'; export {importFile} from './src/main/fileImport'`, resolveDir: root, loader: 'ts' }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false })
const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
const api = loaded.exports, tool = name => api.agentTools.find(item => item.name === name)
const docx = paragraphs => Packer.toBuffer(new Document({ sections: [{ children: paragraphs.map(text => new Paragraph(text)) }] }))
const cursorOf = message => message.match(/续读 cursor=(d1:[0-9a-z.:-]+)/)?.[1]
async function fixture(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-docx-read-'))
  try {
    const work = path.join(dir, 'work'), docs = path.join(dir, 'docs')
    await fs.mkdir(work); await fs.mkdir(docs)
    api.configureTerminalHost({ dataDir: path.join(dir, 'data'), docDir: docs })
    await run(dir, work, { workDir: work, docDir: docs, pagedFileReads: true })
  } finally {
    assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('dw-docx-read-'))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('production read_file extracts a real DOCX middle paragraph with honest text positions, cursors and authorization', async () => fixture(async (dir, work, env) => {
  const paragraphs = ['开头只说明天气，不含保管结论。', '中段🌊：交接[杉+7]确认，保管人是“叶棠”；柜号是“储柜-49”。', '末段只说明次日复核安排。']
  const file = path.join(work, '交接记录.docx'), bytes = await docx(paragraphs)
  await fs.writeFile(file, bytes)
  const imported = await api.importFile(file)
  assert.equal(imported.ok, true, imported.error)
  assert.equal(imported.info.text, paragraphs.join('\n\n') + '\n\n')
  const first = await tool('read_file').execute({ path: file, line_count: 2 }, env.docDir, env)
  assert.equal(first.ok, true, first.message); assert.match(first.message, /行号不是Word页码/)
  assert.ok(!first.message.includes('叶棠'))
  const cursor = cursorOf(first.message); assert.ok(cursor)
  const middle = await tool('read_file').execute({ path: file, cursor, line_count: 1 }, env.docDir, env)
  assert.equal(middle.ok, true, middle.message)
  assert.ok(middle.message.endsWith(paragraphs[1] + '\n'))
  assert.match(middle.message, /提取范围 \[3:1, 4:1\)/)
  const exact = await tool('read_file').execute({ path: file, start_line: 3, start_column: 5, max_chars: 10, line_count: 1 }, env.docDir, env)
  assert.equal(exact.ok, true); assert.ok(exact.message.endsWith('交接[杉+7]确认，'))
  const edit = await tool('edit_file').execute({ path: file, old_text: '叶棠', new_text: '不应写入' }, env.docDir, env)
  assert.equal(edit.ok, false); assert.deepEqual(await fs.readFile(file), bytes)
  const outside = path.join(dir, '未授权.docx'); await fs.writeFile(outside, bytes)
  assert.equal((await tool('read_file').execute({ path: outside }, env.docDir, env)).ok, false)
  const stopped = await tool('read_file').execute({ path: file }, env.docDir, { ...env, signal: AbortSignal.abort() })
  assert.equal(stopped.ok, false)
  await fs.writeFile(file, await docx(['作者后来修改了文档。', ...paragraphs]))
  const stale = await tool('read_file').execute({ path: file, cursor }, env.docDir, env)
  assert.equal(stale.ok, false); assert.match(stale.message, /文档已更改/)
}))

test('DOCX pages honor output and extraction limits instead of treating a capped prefix as the whole document', async () => fixture(async (dir, work, env) => {
  const long = Array.from({ length: 50000 }, (_, i) => `条目${i.toString(36)}🌊`).join('，')
  const file = path.join(work, '长记录.docx'); await fs.writeFile(file, await docx(['开头。', long, '截断后面的结论不得冒充已读。']))
  const imported = await api.importFile(file, 300000)
  assert.equal(imported.ok, true, imported.error); assert.equal(imported.info.truncated, true)
  const first = await tool('read_file').execute({ path: file }, env.docDir, env)
  assert.equal(first.ok, true, first.message)
  assert.ok(api.modelVisibleOutput('read_file', JSON.stringify(first)).length < 19000); assert.ok(JSON.stringify(first).length < 50000); assert.ok(cursorOf(first.message)); assert.match(first.message, /提取已截断/)
  const extractedLine = Array.from(imported.info.text.split('\n')[2].replace(/[\uD800-\uDBFF]$/, ''))
  const last = await tool('read_file').execute({ path: file, start_line: 3, start_column: extractedLine.length - 10, max_chars: 100 }, env.docDir, env)
  assert.equal(last.ok, true, last.message); assert.equal(cursorOf(last.message), undefined)
  assert.match(last.message, /后续未读取，不能视为全文完毕/); assert.ok(last.message.length < 1000)
  const tooLarge = await api.importFile(file, 100, { maxBytes: 8 })
  assert.equal(tooLarge.ok, false); assert.match(tooLarge.error, /本次读取/)
  const bad = path.join(work, '不是压缩包.docx'); await fs.writeFile(bad, 'not a docx')
  const refused = await tool('read_file').execute({ path: bad }, env.docDir, env)
  assert.equal(refused.ok, false); assert.match(refused.message, /DOCX 预检拒绝/)
}))

test('shared legacy import encodings remain usable with lazy registered codecs', async () => fixture(async (dir, work) => {
  for (const [name, bytes] of [['gbk.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4])], ['utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')])]]) {
    const file = path.join(work, name); await fs.writeFile(file, bytes)
    const result = await api.importFile(file)
    assert.equal(result.ok, true, result.error); assert.equal(result.info.text, '中文')
  }
}))

function launch(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env: { ...process.env, DEEPWRITER_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), 30000)
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

test('standalone actual CLI bundle reads DOCX middle evidence and derives its answer without runtime npm dependencies', async () => fixture(async (dir, work) => {
  const quote = '交接[杉+7]确认：保管人是“陶澈”；柜号是“储柜-512”。'
  await fs.writeFile(path.join(work, '交接记录.docx'), await docx(['第一段只记会议地点。', quote, '第三段只记后续日期。']))
  const bundle = path.join(dir, 'deepwriter.cjs')
  const build = await launch(path.join(root, 'src/cli/build.mjs'), [`--outfile=${bundle}`], root)
  assert.equal(build.code, 0, build.stderr)
  const meta = JSON.parse(await fs.readFile(bundle + '.meta.json', 'utf8'))
  assert.ok(Object.keys(meta.inputs).some(file => file.includes('node_modules/mammoth/')))
  for (const output of Object.values(meta.outputs)) for (const item of output.imports) assert.ok(item.external && isBuiltin(item.path), item.path)
  const requests = [], faults = []
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', bytes => { raw += bytes }); req.on('end', () => {
      try {
        const body = JSON.parse(raw); requests.push(body)
        const receipts = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
        let args, answer
        if (requests.length === 1) args = { path: '交接记录.docx', line_count: 2 }
        else if (requests.length === 2) {
          assert.equal(receipts.at(-1).ok, true, receipts.at(-1).message)
          const cursor = cursorOf(receipts.at(-1).message); assert.ok(cursor)
          assert.ok(!receipts.at(-1).message.includes('陶澈'))
          args = { path: '交接记录.docx', cursor, line_count: 1 }
        } else {
          assert.equal(requests.length, 3)
          const receipt = receipts.at(-1); assert.equal(receipt.ok, true, receipt.message)
          assert.ok(receipt.message.endsWith(quote + '\n'))
          const person = /保管人是“([^”]+)”/.exec(receipt.message)?.[1], cabinet = /柜号是“([^”]+)”/.exec(receipt.message)?.[1]
          assert.ok(person && cabinet)
          answer = `DOCX提取文本第3行记载：${person}保管，柜号${cabinet}。`
        }
        const delta = args ? { tool_calls: [{ index: 0, id: `docx-read-${requests.length}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify(args) } }] } : { content: answer }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: args ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
      } catch (error) { faults.push(error); res.writeHead(500); res.end('local DOCX fixture failed') }
    })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const result = await launch(bundle, ['agent', '读取交接记录.docx，中段交接结论由谁保管，柜号是什么？', '--work-dir', work, '--data-dir', path.join(dir, 'cli-data'), '--base-url', `http://127.0.0.1:${server.address().port}`, '--loopback', '--no-web', '--json'], dir)
    assert.deepEqual(faults, []); assert.equal(result.code, 0, result.stderr); assert.equal(requests.length, 3)
    assert.ok(result.stdout.includes('陶澈保管，柜号储柜-512'))
    process.stdout.write('# DOCX evidence: actual standalone bundle; 3 requests, 2 bounded reads; middle paragraph at extracted line 3, not Word page 3\n')
  } finally { await new Promise(resolve => server.close(resolve)) }
}))
