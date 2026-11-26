const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { isBuiltin } = require('node:module')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const { zip, createProjectFixture, sourceEntry, sourceColumn, sourceQuote } = require('./fixtures/project-archive.cjs')
const root = path.resolve(__dirname, '..')
const built = buildSync({ stdin: { contents: `export {estimateTokens} from './src/shared/types'; export {modelVisibleOutput} from './src/main/jobs/toolTurnOutput'; export {attachmentZipHandle,readAttachedZip} from './src/main/attachedZip'; export {agentTools} from './src/main/agentTools'; export {configureTerminalHost} from './src/cli/host'; export {importFile} from './src/main/fileImport'; export {indexProjectArchive,readArchiveEntry,readArchiveEntryBytes,readProjectArchivePage} from './src/main/projectArchive'; export {FileRefRegistry,checkModelReadPolicy} from './src/main/fileRef'; export {ContentAssetStore} from './src/main/assetStore'; export {createAttachmentService} from './src/main/attachmentService'`, resolveDir: root, loader: 'ts' }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false })
const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
const api = loaded.exports, loadPage = api.readProjectArchivePage, read = (args, env) => api.agentTools.find(t => t.name === 'read_file').execute(args, env.docDir, env)
async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-project-zip-'))
  try {
    const work = path.join(directory, 'work'), docs = path.join(directory, 'docs')
    await fs.mkdir(work); await fs.mkdir(docs)
    api.configureTerminalHost({ dataDir: path.join(directory, 'data'), docDir: docs })
    await run(directory, work, { workDir: work, docDir: docs, pagedFileReads: true })
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('dw-project-zip-'))
    await fs.rm(directory, { recursive: true, force: true })
  }
}
test('13.5MB project uses actual directory/text pages and the same authorized attachment representation', async () => fixture(async (directory, work, env) => {
  const project = await createProjectFixture(work)
  assert.ok(project.bytes > 13_500_000 && project.bytes < 13_600_000)
  const listing = await read({ path: project.file }, env)
  assert.equal(listing.ok, true, listing.message); assert.match(listing.message, /122条/); assert.match(listing.message, /二进制\/非文本格式3条/)
  const next = /cursor=(zl1:[0-9a-z.:-]+)/.exec(listing.message)?.[1]; assert.ok(next)
  const tail = await read({ path: project.file, cursor: next }, env)
  assert.equal(tail.ok, true, tail.message); assert.match(tail.message, /目录已列完，正文尚未读取/)
  const first = await read({ path: project.file, archive_entry: sourceEntry, max_chars: 1200 }, env)
  assert.equal(first.ok, true, first.message); assert.ok(!first.message.includes('闻澜'))
  const cursor = /cursor=(z1:[0-9a-z.:-]+)/.exec(first.message)?.[1]; assert.ok(cursor)
  const continued = await read({ path: project.file, archive_entry: sourceEntry, cursor }, env)
  assert.equal(continued.ok, true, continued.message); assert.ok(continued.message.includes(sourceQuote))
  assert.equal((await read({ path: project.file, cursor }, env)).ok, false)
  assert.equal((await read({ path: project.file, archive_entry: '潮汐工程/README.md', cursor }, env)).ok, false)
  const evidence = await read({ path: project.file, archive_entry: sourceEntry, start_line: 2, start_column: sourceColumn, max_chars: 200 }, env)
  assert.equal(evidence.ok, true, evidence.message); assert.ok(evidence.message.endsWith(sourceQuote + '\n')); assert.match(evidence.message, /不是压缩包偏移或文档页码/)
  assert.ok(api.modelVisibleOutput('read_file', JSON.stringify(evidence)).length < 19000); assert.ok(JSON.stringify(evidence).length < 50000)
  assert.equal((await read({ path: project.file, archive_entry: '潮汐工程/assets/样图-a.bin' }, env)).ok, false)
  const imported = await api.importFile(project.file)
  assert.equal(imported.ok, true, imported.error); assert.equal(imported.info.source, 'zip'); assert.equal(imported.info.truncated, true)
  assert.ok(imported.info.text.length <= 60000); assert.match(imported.info.text, /项目代号“潮汐档案”；启动入口是 src\/main.ts/)
  assert.match(imported.info.text, /读取覆盖：尝试12\/119个文本候选/); assert.match(imported.info.text, /并未读完整包/)
  assert.equal((await api.importFile(project.file, 100)).info.text.length <= 100, true)
  const registry = new api.FileRefRegistry(), scope = { kind: 'session', sessionId: 'zip-chat', draftId: 'draft-1' }
  const registered = await registry.register([project.file], scope, 'dialog'); assert.equal(registered.failed, 0)
  assert.equal(api.checkModelReadPolicy(project.file, project.bytes).ok, true)
  const store = new api.ContentAssetStore({ baseDir: path.join(directory, 'assets'), maxMemoryBytes: 2_000_000, spillThresholdBytes: 1_000_000, readText: api.importFile })
  const service = api.createAttachmentService(registry, store), ref = registered.refs[0], input = { name: ref.displayName, size: ref.size, fileRefId: ref.fileRefId }
  const attached = await service.read(input, scope.sessionId, scope.draftId)
  assert.equal(attached.ok, true, JSON.stringify(attached)); assert.equal(attached.text, imported.info.text)
  assert.match(attached.message.content, /ZIP条目 "潮汐工程\/README.md"/)
  assert.equal((await service.read(input, 'other-session', scope.draftId)).ok, false)
  const outside = path.join(directory, 'outside.zip'); await fs.copyFile(project.file, outside)
  assert.equal((await read({ path: outside }, env)).ok, false)
  assert.equal((await read({ path: project.file }, { ...env, signal: AbortSignal.abort() })).ok, false)
  await fs.writeFile(project.file, zip([{ name: 'README.md', text: '后来变更的工程' }]))
  const stale = await read({ path: project.file, archive_entry: sourceEntry, cursor }, env)
  assert.equal(stale.ok, false)
  assert.equal((await service.read(input, scope.sessionId, scope.draftId)).ok, false)
  assert.deepEqual((await fs.readdir(work)).sort(), [path.basename(project.file)])
  process.stdout.write(`# ZIP evidence: ${project.bytes} compressed bytes; 122 entries; 119 text candidates; 3 skipped binary/nested; attachment attempts 12; named Unicode column ${sourceColumn}\n`)
}))

test('automatic attachment excerpts do not disclose secret paths, keys or README.exe; frozen attachment reads verify the same loaded bytes', async () => fixture(async (directory, work, env) => {
  const { createHash } = require('node:crypto')
  const secret = 'sk-SYNTHETIC-NOT-A-REAL-CREDENTIAL-123456789'
  const buffer = zip([
    { name: 'README.md', text: '本工程的公开说明：入口 main.py。' },
    { name: '.env', text: `API_KEY=${secret}` },
    { name: '.git/config', text: `remote=${secret}` },
    { name: 'private/credentials.json', text: JSON.stringify({ apiKey: secret }) },
    { name: 'src/config.ts', text: `export const apiKey = "${secret}";` },
    { name: 'src/auth.json', text: JSON.stringify({ api_key: secret }) },
    { name: 'README.exe', bytes: Buffer.from([0x4d, 0x5a, 0, 1]) }
  ])
  const file = path.join(work, '隐私边界.zip'); await fs.writeFile(file, buffer)
  const preview = await api.importFile(file)
  assert.equal(preview.ok, true, preview.error); assert.ok(!preview.info.text.includes(secret))
  assert.match(preview.info.text, /敏感路径跳过2条、潜在凭据正文跳过2条/)
  assert.match(preview.info.text, /\.git\/config.*二进制\/非文本格式/)
  assert.match(preview.info.text, /README.exe.*二进制\/非文本格式/)
  assert.ok(!preview.info.text.includes('请将ZIP放入'))
  const explicit = await read({ path: file, archive_entry: '.env' }, env)
  assert.equal(explicit.ok, true, explicit.message); assert.ok(explicit.message.includes(secret))
  const apiPage = await loadPage(file, {}, undefined, createHash('sha256').update(buffer).digest('hex'))
  assert.match(apiPage, /目录已列完/)
  await assert.rejects(loadPage(file, {}, undefined, '0'.repeat(64)), /附件内容与本任务保存的版本不符/)
}))

test('ZIP reports encrypted, unsupported, unsafe, oversized and corrupt entries without inflating them as text', async () => fixture(async (directory, work, env) => {
  const entries = [
    { name: 'README.md', text: '可读的中文原文' }, { name: 'secret.txt', text: '不可读', flags: 0x801 },
    { name: 'method.txt', text: '不可读', method: 12 }, { name: '../escape.txt', text: '不应落盘' },
    { name: 'big.txt', text: '声明过大，不会解压', size: 9 * 1024 * 1024 },
    { name: 'bad-crc.txt', text: '校验不符', crc: 0 }, { name: 'binary.ts', bytes: Buffer.from([65, 0, 66]) },
    { name: 'same.txt', text: 'first' }, { name: 'same.txt', text: 'second' }
  ]
  const file = path.join(work, '边界.zip'); await fs.writeFile(file, zip(entries))
  const list = await read({ path: file }, env); assert.equal(list.ok, true, list.message)
  for (const expected of ['加密，未读取1条', '不支持的压缩/链接1条', '过限，未读取1条', '不安全/重名路径3条']) assert.ok(list.message.includes(expected), expected)
  for (const entry of entries.slice(1)) assert.equal((await read({ path: file, archive_entry: entry.name }, env)).ok, false, entry.name)
  const preview = await api.importFile(file); assert.equal(preview.ok, true, preview.error); assert.match(preview.info.text, /失败2条/); assert.match(preview.info.text, /CRC校验不符/); assert.match(preview.info.text, /二进制NUL/)
  const lies = zip([{ name: 'lie.txt', text: '正常的长文本。'.repeat(2000), size: 1 }])
  const indexed = await api.indexProjectArchive(lies)
  await assert.rejects(api.readArchiveEntryBytes(indexed, 'lie.txt'), /实际解压大小超过/)
  const bad = path.join(work, '损坏.zip'); await fs.writeFile(bad, Buffer.from('not zip'))
  const rejected = await read({ path: bad }, env); assert.equal(rejected.ok, false); assert.match(rejected.message, /ZIP 损坏/)
  const tooMany = zip(Array.from({ length: 10001 }, (_, i) => ({ name: `${i}.txt`, text: '' })))
  await assert.rejects(api.indexProjectArchive(tooMany), /10001 > 10000/)
  await assert.rejects(api.indexProjectArchive(zip([{ name: 'giant.bin', size: 257 * 1024 * 1024 }])) , /总量超过 256MB/)
  const gbk = require('iconv-lite').encode('中文路径.txt', 'gbk')
  const legacy = await api.indexProjectArchive(zip([{ name: gbk, flags: 0, bytes: require('iconv-lite').encode('中文原文', 'gbk') }]))
  assert.equal(await api.readArchiveEntry(legacy, '中文路径.txt'), '中文原文')
  assert.deepEqual((await fs.readdir(work)).sort(), ['损坏.zip', '边界.zip'].sort())
}))

function launch(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env: { ...process.env, DEEPWRITER_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => child.kill(), 30000)
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}
test('actual standalone CLI bundle reads the 13.5MB ZIP then answers from its real Chinese source entry', async () => fixture(async (directory, work) => {
  const project = await createProjectFixture(work), bundle = path.join(directory, 'deepwriter.cjs')
  const build = await launch(path.join(root, 'src/cli/build.mjs'), [`--outfile=${bundle}`], root); assert.equal(build.code, 0, build.stderr)
  const meta = JSON.parse(await fs.readFile(bundle + '.meta.json', 'utf8'))
  for (const output of Object.values(meta.outputs)) for (const item of output.imports) assert.ok(item.external && isBuiltin(item.path), item.path)
  const requests = [], faults = []
  const budgetSummary = () => requests.slice(-3).map((body, index) => ({ request: requests.length - 2 + index, inputEstimate: api.estimateTokens(JSON.stringify(body)),
    schemaEstimate: api.estimateTokens(JSON.stringify(body.tools ?? [])), outputReserve: body.max_tokens,
    lastReads: body.messages.filter(message => message.role === 'tool').slice(-2).map(message => ({ tokens: api.estimateTokens(message.content), escapedChars: JSON.stringify(JSON.parse(message.content).message).length - 2,
      range: /(?:文本范围|Unicode码点范围) ([^\n]+)/.exec(JSON.parse(message.content).message)?.[1]?.slice(0, 180) })) }))
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', bytes => { raw += bytes }); req.on('end', async () => {
      try {
        const body = JSON.parse(raw); requests.push(body)
        const receipts = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
        let args, answer
        if (requests.length === 1) args = { path: path.basename(project.file) }
        else if (requests.length === 2) {
          const receipt = receipts.at(-1); assert.equal(receipt.ok, true, receipt.message)
          assert.ok(receipt.message.includes(JSON.stringify(sourceEntry))); assert.ok(!receipt.message.includes('闻澜'))
          args = { path: path.basename(project.file), archive_entry: sourceEntry, start_line: 2 }
        } else {
          const receipt = receipts.at(-1); assert.equal(receipt.ok, true, receipt.message)
          const pages = receipts.filter(item => item.message.startsWith('ZIP条目')).map(item => item.message.split('\n').slice(2).join('\n')).join('')
          if (!pages.includes(sourceQuote)) {
            const cursor = /cursor=(z1:[0-9a-z.:-]+)/.exec(receipt.message)?.[1]; assert.ok(cursor, receipt.message)
            args = { path: path.basename(project.file), archive_entry: sourceEntry, cursor }
          } else {
            const keeper = /keeper: "([^"]+)"/.exec(pages)?.[1], cabinet = /cabinet: "([^"]+)"/.exec(pages)?.[1]
            assert.ok(keeper && cabinet); answer = `${sourceEntry} 第2行原文记录：${keeper}保管，柜号${cabinet}。`
          }
        }
        const delta = args ? { tool_calls: [{ index: 0, id: `zip-read-${requests.length}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify(args) } }] } : { content: answer }
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: args ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
      } catch (error) {
        faults.push(error)
        const capture = path.join(root, 'out/v400-zip-budget'); await fs.mkdir(capture, { recursive: true }); await fs.writeFile(path.join(capture, 'last-input.json'), JSON.stringify(budgetSummary(), null, 2) + '\n')
        res.writeHead(500); res.end('local ZIP fixture failed')
      }
    })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const result = await launch(bundle, ['agent', '读取潮汐工程ZIP里的src/中文目录/交接[杉+7].ts，实际保管人及柜号是什么？请引用原路径。', '--work-dir', work, '--data-dir', path.join(directory, 'cli-data'), '--base-url', `http://127.0.0.1:${server.address().port}`, '--loopback', '--no-web', '--json'], directory)
    assert.deepEqual(faults, []); assert.equal(result.code, 0, result.stderr || result.stdout.split('\n').filter(line => line.includes('"type":"result"')).join('\n')); assert.ok(requests.length > 3)
    assert.ok(result.stdout.includes('闻澜保管，柜号青柜-812')); assert.ok(result.stdout.includes(sourceEntry))
    process.stdout.write(`# ZIP CLI: ${project.bytes} compressed bytes; ${requests.length} local provider requests with actual 8192-token fallback, directory + cursor pages; answer derived from actual source; only Node builtin externals\n`)
  } finally { await new Promise(resolve => server.close(resolve)) }
}))

test('selected ZIP capability opens only its frozen bytes, never adjacent files or another session', () => fixture(async (dir) => {
  const filename = path.join(dir, '选中的.zip')
  const { zipSync, strToU8 } = require('fflate')
  const bytes = Buffer.from(zipSync({ 'entry.txt': strToU8('仅这份资料中的一行') }))
  await fs.writeFile(filename, bytes)
  const registry = new api.FileRefRegistry()
  const { refs: [view] } = await registry.register([filename], { kind: 'session', sessionId: 's', draftId: 'current' }, 'drop')
  const att = { fileRefId: view.fileRefId, name: '选中的.zip', hash: require('node:crypto').createHash('sha256').update(bytes).digest('hex') }
  const cfg = { sessionId: 's', attachments: [att] }, args = { path: api.attachmentZipHandle(att), archive_entry: 'entry.txt' }
  assert.match(await api.readAttachedZip(registry, cfg, args), /仅这份资料中的一行/)
  await assert.rejects(api.readAttachedZip(registry, { ...cfg, sessionId: 'other' }, args), /不再可读/)
  await assert.rejects(api.readAttachedZip(registry, { ...cfg, attachments: [] }, args), /不属于本次任务/)
  await assert.rejects(api.readAttachedZip(registry, { ...cfg, attachments: [{ ...att, hash: '0'.repeat(64) }] }, args))
  registry.revoke(view.fileRefId)
  await assert.rejects(api.readAttachedZip(registry, cfg, args), /不再可读/)
}))
