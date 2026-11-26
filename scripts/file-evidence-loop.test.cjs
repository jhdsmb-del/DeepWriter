const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const { zip } = require('./fixtures/project-archive.cjs')
const { Document, Paragraph, Packer } = require('docx')
const root = path.resolve(__dirname, '..')
const built = buildSync({ stdin: { contents: `export {agentTools} from './src/main/agentTools'; export {configureTerminalHost} from './src/cli/host'; export * from './src/shared/fileEvidence'; export {createToolExecutor,createChunkTranslator} from './src/main/runKernelAdapter'; export {prepareToolTurnOutput,replayToolTurnOutput,modelVisibleOutput} from './src/main/jobs/toolTurnOutput'; export {unwrapToolResult} from './src/main/toolResultView'; export {FileRefRegistry} from './src/main/fileRef'; export {readAttachedZipResult,attachmentZipHandle} from './src/main/attachedZip'`, resolveDir: root, loader: 'ts' }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false })
const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
const api = loaded.exports
const call = (name, args, env) => api.agentTools.find(tool => tool.name === name).execute(args, env.docDir, env)
async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-evidence-loop-'))
  try {
    const work = path.join(directory, 'work'), docs = path.join(directory, 'docs')
    await fs.mkdir(work); await fs.mkdir(docs); api.configureTerminalHost({ dataDir: path.join(directory, 'host'), docDir: docs })
    await run(directory, work, { workDir: work, docDir: docs, sessionId: 'evidence-session', runId: 'evidence-run', pagedFileReads: true })
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('dw-evidence-loop-'))
    await fs.rm(directory, { recursive: true, force: true })
  }
}
async function writeSources(work, newline = '\r\n') {
  for (const [area, person, box] of [['北区', '叶棠', 'A-17'], ['南区', '周禾', 'B-29']]) {
    await fs.mkdir(path.join(work, area), { recursive: true })
    await fs.writeFile(path.join(work, area, '记录.md'), '\ufeff开头不含保管结论。' + newline + '巡检🌊'.repeat(2200) + '确认[甲+7]' + newline + `保管人🌊：${person}；柜号${box}。` + newline + '后记。')
  }
}
test('multiline literal evidence beyond a long Unicode prefix round-trips each same-named file without guessing paths or columns', async () => fixture(async (directory, work, env) => {
  await writeSources(work)
  const found = await call('search_files', { path: '.', literal: true, pattern: '确认[甲+7]\r\n保管人🌊：' }, env)
  assert.equal(found.ok, true, found.message); assert.match(found.message, /命中范围 \[2:6601, 3:6\)/)
  assert.equal(found.sources.length, 2); assert.equal(new Set(found.sources.map(source => source.path)).size, 2)
  assert.ok(found.sources.every(source => source.displayName === '记录.md' && source.excerpt.includes('\r\n')))
  const read = await call('read_files', { files: found.sources.map(source => source.read) }, env)
  assert.equal(read.ok, true, read.message); assert.equal(read.sources.length, 2)
  const entries = JSON.parse(read.message).files
  for (const [i, source] of found.sources.entries()) {
    assert.equal(api.parseFileSource(source)?.excerpt, source.excerpt)
    assert.equal(entries[i].message.slice(entries[i].message.indexOf('\n') + 1), source.excerpt)
    assert.equal(read.sources[i].path, source.path); assert.deepEqual(read.sources[i].range, source.range)
    assert.equal(api.parseFileSource({ ...source, range: { ...source.range, end_column: source.range.end_column + 1 } }), undefined)
    assert.equal(api.parseFileSource({ ...source, read: { ...source.read, path: '另一个文件.md' } }), undefined)
  }
  assert.ok(found.sources.some(source => source.path.includes('北区') && source.excerpt.includes('叶棠')))
  assert.ok(found.sources.some(source => source.path.includes('南区') && source.excerpt.includes('周禾')))
  const wrongNewline = await call('search_files', { literal: true, pattern: '确认[甲+7]\n保管人🌊：' }, env)
  assert.match(wrongNewline.message, /^未找到匹配/)
  assert.equal((await call('search_files', { literal: true, pattern: '\uDE42' }, env)).ok, false)
  const binary = path.join(work, '伪装正文.md'); await fs.writeFile(binary, '%PDF-1.4\n确认[甲+7]\r\n保管人🌊：不能当作正文。')
  const binaryHit = await call('search_files', { path: binary, literal: true, pattern: '确认[甲+7]' }, env)
  assert.equal(binaryHit.ok, false); assert.equal(binaryHit.sources, undefined); assert.match(binaryHit.message, /与read_file一致/)
  await fs.appendFile(found.sources[0].path, '作者已修改。')
  const stale = await call('read_file', found.sources[0].read, env)
  assert.equal(stale.ok, false); assert.match(stale.message, /已更改/)
  assert.ok(found.sources[0].excerpt.includes('确认[甲+7]'), 'the saved evidence stays readable after source mutation')
}))

test('captured page ranges and reread cursors preserve BOM/CRLF/Unicode without loss at page boundaries', async () => fixture(async (directory, work, env) => {
  const original = '\ufeff' + '甲𠮷🙂'.repeat(3100) + '\r\n\r\n末尾[证+3]。', file = path.join(work, '分页.md')
  await fs.writeFile(file, original)
  let cursor, joined = '', count = 0
  do {
    const result = await call('read_file', { path: file, max_chars: 1500, line_count: 100, ...(cursor ? { cursor } : {}) }, env)
    assert.equal(result.ok, true, result.message); const [source] = api.parseFileSources(result.sources)
    assert.ok(source); assert.equal(source.excerpt, result.message.slice(result.message.indexOf('\n') + 1))
    const reread = await call('read_file', source.read, env)
    assert.equal(reread.ok, true, reread.message); assert.equal(reread.sources[0].excerpt, source.excerpt); assert.deepEqual(reread.sources[0].range, source.range)
    joined += source.excerpt; count++; cursor = /cursor=(p1:[0-9a-z.:-]+)/.exec(result.message.split('\n')[0])?.[1]
    assert.ok(api.modelVisibleOutput('read_file', JSON.stringify(result)).length < 20000)
  } while (cursor)
  assert.equal(joined, original); assert.ok(count > 1)
}))

test('host read budget shrinks only the allocated page, splits batch bodies, and zero reports unread instead of an empty file or looping cursor', async () => fixture(async (directory, work, env) => {
  await fs.writeFile(path.join(work, '正文.md'), '波🌊'.repeat(5000))
  const normal = await call('read_file', { path: '正文.md', line_count: 1 }, env)
  const large = await call('read_file', { path: '正文.md', line_count: 1 }, { ...env, readBudgetChars: 14000 })
  assert.equal(large.sources[0].excerpt, normal.sources[0].excerpt)
  const small = await call('read_file', { path: '正文.md', max_chars: 8000 }, { ...env, readBudgetChars: 128 })
  assert.equal(small.ok, true, small.message); assert.ok(JSON.stringify(small.sources[0].excerpt).length - 2 <= 128); assert.ok(small.message.includes('续读 cursor='))
  const batch = await call('read_files', { files: [{ path: '正文.md' }, { path: '正文.md' }] }, { ...env, readBudgetChars: 256 })
  assert.equal(batch.ok, true, batch.message); assert.ok(batch.sources.reduce((sum, source) => sum + (JSON.stringify(source.excerpt).length - 2) * 2, 0) <= 256)
  const oldBatch = await call('read_files', { files: [{ path: '正文.md' }, { path: '正文.md' }] }, env)
  const roomyBatch = await call('read_files', { files: [{ path: '正文.md' }, { path: '正文.md' }] }, { ...env, readBudgetChars: 16000 })
  assert.equal(roomyBatch.message, oldBatch.message, 'a roomy model keeps the established batch page sizes')
  await fs.writeFile(path.join(work, '文档.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('不能把预算零当作没有正文。')] }] })))
  await fs.writeFile(path.join(work, '工程.zip'), zip([{ name: 'README.md', text: '必须保留真实未读状态。' }]))
  for (const args of [{ path: '正文.md' }, { path: '文档.docx' }, { path: '工程.zip', archive_entry: 'README.md' }, { path: '工程.zip' }]) {
    const emptyBudget = await call('read_file', args, { ...env, readBudgetChars: 0 })
    assert.equal(emptyBudget.ok, false); assert.match(emptyBudget.message, /read_input_budget_insufficient/); assert.equal(emptyBudget.sources?.length ?? 0, 0); assert.doesNotMatch(emptyBudget.message, /cursor=/)
  }
  for (const [name, args] of [['read_files', { files: [{ path: '正文.md' }] }], ['search_files', { pattern: '波', literal: true }], ['find_files', { pattern: '*.md' }]]) {
    const zero = await call(name, args, { ...env, readBudgetChars: 0 }); assert.equal(zero.ok, false); assert.match(zero.message, /read_input_budget_insufficient/); assert.doesNotMatch(zero.message, /cursor=|next_index/)
  }
}))

test('selected ZIP entry sources keep handle, display name and entry identity; durable snapshots do not duplicate excerpts on live or replayed provider wire', async () => fixture(async (directory, work, env) => {
  const buffer = zip([{ name: '北/记录.md', text: '北条目实际原文。' }, { name: '南/记录.md', text: '南条目实际原文。' }])
  const file = path.join(directory, '已选工程.zip'); await fs.writeFile(file, buffer)
  const registry = new api.FileRefRegistry(), { refs } = await registry.register([file], { kind: 'session', sessionId: env.sessionId, draftId: 'current' }, 'dialog')
  const ref = { name: refs[0].displayName, fileRefId: refs[0].fileRefId, hash: createHash('sha256').update(buffer).digest('hex') }, handle = api.attachmentZipHandle(ref)
  const execute = api.createToolExecutor({ getSignal: () => undefined, getEnv: () => env, getAllowList: () => ['read_file', 'read_files'],
    readAttachedZip: (_run, request, signal) => api.readAttachedZipResult(registry, { sessionId: env.sessionId, attachments: [ref] }, request, signal) })
  const raw = await execute('read_files', JSON.stringify({ files: ['北/记录.md', '南/记录.md'].map(archive_entry => ({ path: handle, archive_entry })) }), 'zip-batch', env.runId)
  const payload = JSON.parse(raw); assert.equal(payload.sources.length, 2)
  for (const source of payload.sources) {
    assert.equal(source.path, handle); assert.equal(source.displayName, '已选工程.zip'); assert.ok(!JSON.stringify(source).includes(directory))
    const exact = JSON.parse(await execute('read_file', JSON.stringify(source.read), 'exact', env.runId))
    assert.equal(exact.sources[0].excerpt, source.excerpt)
  }
  await assert.rejects(execute('read_file', JSON.stringify({ ...payload.sources[0].read, archive_entry: '南/记录.md' }), 'forged', env.runId), /不是上一页的文件\/条目/)

  let artifacts = 0
  const output = await api.prepareToolTurnOutput('read_files', raw, async text => { if (text.length > 20000) { artifacts++; return 'artifact stub' } return text })
  assert.equal(artifacts, 0); assert.equal(JSON.parse(output.content).sources, undefined)
  assert.equal(api.unwrapToolResult(output.resultJson).payload.sources.length, 2)
  assert.equal(api.replayToolTurnOutput({ name: 'read_files', resultJson: output.resultJson }), output.content)
  const tc = { toolCallId: 'zip-batch', runId: env.runId, name: 'read_files', argsJson: '{}', status: 'completed', resultJson: output.resultJson, startedAt: 1, completedAt: 2 }
  const event = api.createChunkTranslator()({ type: 'tool', toolCall: tc }, env.runId)[0]
  assert.equal(event.toolResult.sourceCount, 2); assert.equal(event.toolResult.sources, undefined)
}))

function launch(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env: { ...process.env, DEEPWRITER_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => child.kill(), 30000)
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}
test('actual CLI searches a multiline quote, batch-rereads two same-named files and cites source-derived line ranges in three local provider calls', async () => fixture(async (directory, work) => {
  await writeSources(work, '\n')
  const bundle = path.join(directory, 'deepwriter.cjs'), build = await launch(path.join(root, 'src/cli/build.mjs'), [`--outfile=${bundle}`], root)
  assert.equal(build.code, 0, build.stderr)
  const requests = [], faults = []
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', bytes => { raw += bytes }); req.on('end', () => {
      try {
        const body = JSON.parse(raw); requests.push(body)
        const receipts = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
        assert.ok(receipts.every(receipt => receipt.sources === undefined))
        let name, args, answer
        if (!receipts.length) { name = 'search_files'; args = { path: '.', pattern: '确认[甲+7]\n保管人🌊：', literal: true } }
        else if (receipts.length === 1) {
          const reads = [...receipts[0].message.matchAll(/读取原文：read_file ([^\n]+)/g)].map(match => JSON.parse(match[1])); assert.equal(reads.length, 2)
          name = 'read_files'; args = { files: reads }
        } else {
          const files = JSON.parse(receipts.at(-1).message).files; assert.equal(files.length, 2)
          answer = files.map(file => {
            assert.equal(file.ok, true)
            const fact = /保管人🌊：([^；]+)；柜号([^。]+)。/.exec(file.message), span = /Unicode码点范围 \[(\d+):\d+, (\d+):(\d+)\)/.exec(file.message)
            assert.ok(fact && span)
            return `${file.path} 第${span[1]}–${Number(span[2]) - (span[3] === '1' ? 1 : 0)}行：${fact[1]}保管，柜号${fact[2]}。`
          }).join('\n')
        }
        const delta = name ? { tool_calls: [{ index: 0, id: 'evidence-' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: answer }
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
      } catch (error) { faults.push(error); res.writeHead(500); res.end('local evidence fixture failed') }
    })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const dataDir = path.join(directory, 'cli-data'), result = await launch(bundle, ['agent', '跨北区和南区两份记录，核对确认[甲+7]后的保管人和柜号，引用真实路径及行段。', '--work-dir', work, '--data-dir', dataDir, '--base-url', `http://127.0.0.1:${server.address().port}`, '--loopback', '--no-web', '--json'], directory)
    assert.deepEqual(faults, []); assert.equal(result.code, 0, result.stderr); assert.equal(requests.length, 3)
    assert.match(result.stdout, /北区[\\/]+记录.md 第2–3行：叶棠保管，柜号A-17/); assert.match(result.stdout, /南区[\\/]+记录.md 第2–3行：周禾保管，柜号B-29/)
    const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
    try { const rows = db.prepare('SELECT name, result_json FROM toolcalls ORDER BY started_at').all(); assert.deepEqual(rows.map(row => api.parseFileSources(api.unwrapToolResult(row.result_json).payload.sources).length), [2, 2]) } finally { db.close() }
    process.stdout.write('# citation loop: real CLI, 3 local provider calls; 2 same-named files; match at Unicode 2:6601 across LF; 4 durable sources; no duplicate source text on provider wire\n')
  } finally { await new Promise(resolve => server.close(resolve)) }
}))
