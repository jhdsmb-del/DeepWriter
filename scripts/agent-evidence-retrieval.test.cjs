const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { randomInt } = require('node:crypto')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const built = buildSync({ stdin: { contents: `export {modelVisibleOutput} from './src/main/jobs/toolTurnOutput'; export {agentTools} from './src/main/agentTools'; export {configureTerminalHost} from './src/cli/host'; export {readFilePage} from './src/main/fileReadPage'`, resolveDir: root, loader: 'ts' }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false })
const loaded = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
const api = loaded.exports
const tool = name => api.agentTools.find(item => item.name === name)
const locate = message => JSON.parse(message.match(/读取原文：read_file ([^\n]+)/)[1])
async function fixture(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-evidence-'))
  try {
    api.configureTerminalHost({ dataDir: dir, docDir: dir })
    await run(dir, { workDir: dir, docDir: dir, pagedFileReads: true })
  } finally {
    assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('dw-evidence-'))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('literal evidence finds a named file beyond old 4000-unit cutoff and reads exact Unicode columns', async () => fixture(async (dir, env) => {
  const line = '巡检🌊'.repeat(2300) + '交接[杉+7]确认：保管人写作“叶棠”；柜号是“储柜-49”。'
  const file = path.join(dir, '正式记录.md'), original = '\ufeff开头没有答案。\r\n' + line + '\r\n下一段仍可续读。'
  await fs.writeFile(file, original)
  const args = { path: '正式记录.md', pattern: '交接[杉+7]确认', literal: true }
  const found = await tool('search_files').execute(args, dir, env)
  assert.equal(found.ok, true, found.message)
  assert.match(found.message, /正式记录\.md:2:6901:/)
  assert.match(found.message, /交接\[杉\+7\]确认/)
  assert.ok(!found.message.includes('开头没有答案'))
  assert.ok(JSON.stringify(found).length < 4000)
  const read = locate(found.message)
  const page = await tool('read_file').execute(read, dir, env)
  assert.equal(page.ok, true, page.message)
  const text = page.message.slice(page.message.indexOf('\n') + 1)
  assert.equal(text, Array.from(line).slice(6820).join('') + '\r\n')
  assert.match(page.message, /Unicode码点范围 \[2:6821, 3:1\)/)
  const located = await api.readFilePage(file, { start_line: 2, start_column: 6901, max_chars: 9, line_count: 1 })
  assert.equal(located.text, '交接[杉+7]确认')
  assert.equal(located.firstColumn, 6901); assert.equal(located.endColumn, 6910)
  const continued = await api.readFilePage(file, { cursor: located.cursor, max_chars: 8 })
  assert.equal(continued.text, '：保管人写作“叶')
  assert.equal(continued.firstColumn, 6910)
  await assert.rejects(api.readFilePage(file, { start_line: 2, start_column: 99999 }), /没有第/)
  await assert.rejects(api.readFilePage(file, { cursor: located.cursor, start_column: 1 }), /请选择一种定位/)
  await fs.appendFile(file, '作者补了一行')
  const stale = await tool('read_file').execute(read, dir, env)
  assert.equal(stale.ok, false); assert.match(stale.message, /已更改/)
}))

test('legacy regex remains case-insensitive while incomplete, unreadable and empty scopes stay distinct', async () => fixture(async (dir, env) => {
  await fs.writeFile(path.join(dir, 'source.md'), 'ABC42\nabc7\n普通行\n')
  const regex = await tool('search_files').execute({ path: 'source.md', pattern: '^abc\\d+$' }, dir, env)
  assert.equal(regex.ok, true); assert.match(regex.message, /找到 2 个匹配行/)
  const fromBeginning = await tool('read_file').execute(locate(regex.message), dir, env)
  assert.equal(fromBeginning.ok, true); assert.equal(fromBeginning.message.slice(fromBeginning.message.indexOf('\n') + 1), 'ABC42\n')
  const limited = await tool('search_files').execute({ pattern: 'abc', max_results: 1 }, dir, env)
  assert.match(limited.message, /搜索未完成/); assert.match(limited.message, /max_results/)
  const absent = await tool('search_files').execute({ path: 'missing.md', pattern: 'word', literal: true }, dir, env)
  assert.equal(absent.ok, false); assert.match(absent.message, /不存在/); assert.doesNotMatch(absent.message, /^未找到匹配/)
  await fs.writeFile(path.join(dir, 'bad.md'), Buffer.from([0xff, 0xfe, 0x41]))
  const bad = await tool('search_files').execute({ path: 'bad.md', pattern: 'A', literal: true }, dir, env)
  assert.equal(bad.ok, false); assert.match(bad.message, /未能读取/)
  await fs.writeFile(path.join(dir, 'huge.md'), 'x'.repeat(2_000_001))
  const huge = await tool('search_files').execute({ path: 'huge.md', pattern: 'word', literal: true }, dir, env)
  assert.equal(huge.ok, false); assert.match(huge.message, /大于 2 MB 的文件（未查/)
  const empty = path.join(dir, 'empty'); await fs.mkdir(empty)
  const none = await tool('search_files').execute({ path: 'empty', pattern: 'word', literal: true }, dir, env)
  assert.equal(none.ok, true); assert.match(none.message, /默认可搜索范围已查完/)
  const noLiteral = await tool('search_files').execute({ path: 'source.md', pattern: '[ABC+]', literal: true }, dir, env)
  assert.match(noLiteral.message, /^未找到匹配/)
  await fs.writeFile(path.join(dir, 'escapes.md'), ('"\\\t'.repeat(800) + 'needle\n').repeat(80))
  const escaped = await tool('search_files').execute({ path: 'escapes.md', pattern: 'needle', literal: true, max_results: 200 }, dir, env)
  assert.ok(api.modelVisibleOutput('search_files', JSON.stringify(escaped)).length < 19000); assert.ok(JSON.stringify(escaped).length < 64000); assert.match(escaped.message, /返回文本上限/)
  const cancelled = await tool('search_files').execute({ pattern: 'a' }, dir, { ...env, signal: AbortSignal.abort() })
  assert.equal(cancelled.ok, false); assert.match(cancelled.message, /搜索未完成/)
}))

test('long regex lines retain the old bounded window, label partial evidence and leave full literal lookup usable', async () => fixture(async (dir, env) => {
  const filler = '巡检🌊'.repeat(1500), ending = '尾部[证据+7]仍需核对。'
  await fs.writeFile(path.join(dir, 'long.md'), '前缀词。' + filler + ending + '\n' + filler + '另一条长行。')
  const prefix = await tool('search_files').execute({ path: 'long.md', pattern: '前缀词' }, dir, env)
  assert.equal(prefix.ok, true); assert.match(prefix.message, /窗口内正则候选列/)
  assert.match(prefix.message, /2 条长行未查完/); assert.match(prefix.message, /前 4000 个 UTF-16 单位/)
  assert.match(prefix.message, /literal:true/); assert.doesNotMatch(prefix.message, /默认可搜索范围已查完/)
  const tail = await tool('search_files').execute({ path: 'long.md', pattern: '尾部' }, dir, env)
  assert.equal(tail.ok, false); assert.match(tail.message, /其余内容尚未确认/)
  assert.doesNotMatch(tail.message, /^未找到匹配/)
  const literal = await tool('search_files').execute({ path: 'long.md', pattern: '尾部[证据+7]', literal: true }, dir, env)
  assert.equal(literal.ok, true); assert.match(literal.message, /默认可搜索范围已查完/)
  assert.match(literal.message, /long\.md:1:4505:/)
  const read = await tool('read_file').execute(locate(literal.message), dir, env)
  assert.equal(read.ok, true); assert.ok(read.message.includes(ending))
  await fs.writeFile(path.join(dir, 'edge.md'), '段'.repeat(3998) + '末尾' + '实际仍在继续。')
  const edge = await tool('search_files').execute({ path: 'edge.md', pattern: '末尾$' }, dir, env)
  assert.equal(edge.ok, false); assert.match(edge.message, /1 个窗口末尾候选可能截断/)
  assert.doesNotMatch(edge.message, /读取原文：|找到 1 个匹配/)
}))

function launch(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env: { ...process.env, DEEPWRITER_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), 20_000)
    child.once('error', reject)
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

test('actual CLI/provider derives the answer from search and read evidence, with decoys and only three requests', async () => fixture(async dir => {
  const materials = path.join(dir, '材料'); await fs.mkdir(materials)
  const person = ['叶棠', '周禾', '陶澈'][randomInt(3)], locker = '储柜-' + randomInt(100, 999)
  await fs.writeFile(path.join(materials, '00-传闻.md'), '交接杉确认：保管人写作“误导姓名”；柜号是“错误柜号”。\n交接[杉+8]确认：仍是诱饵。')
  const longLine = '巡检🌊'.repeat(2300) + `交接[杉+7]确认：保管人写作“${person}”；柜号是“${locker}”。`
  await fs.writeFile(path.join(materials, '正式记录.md'), '导言仅记天气，不包含交接结论。\r\n' + longLine + '\r\n后记。')
  const bundle = path.join(dir, 'deepwriter.cjs')
  const build = await launch(path.join(root, 'src/cli/build.mjs'), [`--outfile=${bundle}`], root)
  assert.equal(build.code, 0, build.stderr)
  const requests = [], faults = []
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
      try {
        const body = JSON.parse(raw); requests.push(body)
        const receipts = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
        let calls, answer
        if (requests.length === 1) {
          assert.ok(body.tools.find(spec => spec.function.name === 'search_files').function.parameters.properties.literal)
          assert.ok(body.tools.find(spec => spec.function.name === 'read_file').function.parameters.properties.start_column)
          calls = ['材料', '材料/正式记录.md'].map((target, index) => ({ index, id: 'evidence-search-' + index, type: 'function', function: { name: 'search_files', arguments: JSON.stringify({ path: target, pattern: '交接[杉+7]确认', literal: true }) } }))
        } else if (requests.length === 2) {
          assert.equal(receipts.length, 2)
          for (const receipt of receipts) {
            assert.equal(receipt.ok, true, receipt.message)
            assert.match(receipt.message, /6901:/); assert.ok(!receipt.message.includes('误导姓名'))
          }
          const read = locate(receipts.at(-1).message)
          calls = [{ index: 0, id: 'evidence-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify(read) } }]
        } else {
          assert.equal(requests.length, 3)
          const evidence = receipts.at(-1).message
          assert.match(evidence, /Unicode码点范围 \[2:6821, 3:1\)/)
          // Deliberately derive both values from the actual read tool reply,
          // not fixture closures or a hard-coded final response.
          const holder = /保管人写作“([^”]+)”/.exec(evidence)?.[1]
          const storage = /柜号是“([^”]+)”/.exec(evidence)?.[1]
          assert.ok(holder && storage, 'read reply must contain usable primary evidence')
          answer = `正式记录的原文记载：${holder}保管，编号为${storage}。`
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ choices: [{ delta: calls ? { tool_calls: calls } : { content: answer }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
      } catch (error) { faults.push(error); res.writeHead(500); res.end('local evidence fixture failed') }
    })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const result = await launch(bundle, ['agent', '正式记录中“交接[杉+7]确认”之后由谁保管，柜号是什么？请先找原文再回答。', '--work-dir', dir, '--data-dir', path.join(dir, 'data'), '--base-url', `http://127.0.0.1:${server.address().port}`, '--loopback', '--no-web', '--json'], dir)
    assert.deepEqual(faults, [])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(requests.length, 3)
    assert.ok(result.stdout.includes(`${person}保管，编号为${locker}`))
    const readReceipt = JSON.parse(requests[2].messages.findLast(message => message.role === 'tool').content)
    const evidence = readReceipt.message.slice(readReceipt.message.indexOf('\n') + 1)
    assert.equal(evidence, Array.from(longLine).slice(6820).join('') + '\r\n')
    assert.ok(!JSON.stringify(requests).includes('导言仅记天气'))
    process.stdout.write(`# evidence: 3 provider requests; 2 searches + 1 read; answer at Unicode column 6901; read ${Array.from(evidence).length} code points\n`)
  } finally { await new Promise(resolve => server.close(resolve)) }
}))
