const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { isBuiltin } = require('node:module')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const { zipSync, strToU8 } = require('fflate')
const PDFDocument = require('pdfkit')
const root = path.resolve(__dirname, '..')
const built = buildSync({ stdin: { contents: `export {agentTools} from './src/main/agentTools'; export {configureTerminalHost} from './src/cli/host'; export {importFile} from './src/main/fileImport'`, resolveDir: root, loader: 'ts' }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false })
const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
const api = loaded.exports, read = (args, env) => api.agentTools.find(tool => tool.name === 'read_file').execute(args, env.docDir, env)
const cursorOf = text => /续读 cursor=(d1:[0-9a-z.:-]+)/.exec(text)?.[1]
const epub = (parts = {}) => Buffer.from(zipSync(Object.fromEntries(Object.entries({
  mimetype: 'application/epub+zip',
  'META-INF/container.xml': '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  'OEBPS/book.opf': '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="last" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="first" href="chapter9.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="first"/><itemref idref="last"/></spine></package>',
  'OEBPS/chapter9.xhtml': '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>不应当作正文</title><style>不应读取CSS</style></head><body><h1>第一章🌊</h1><p>保管人：闻澜；柜号：青柜-812。</p><script>不应读取脚本</script><p hidden="hidden">不应读取隐藏内容</p><p>下一步&nbsp;&amp;&nbsp;复核。</p><img src="https://never-load.invalid/private.png"/></body></html>',
  'OEBPS/chapter1.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章</h1><p>最后按日期复核。</p></body></html>', ...parts
}).map(([name, text]) => [name, strToU8(text)]))))
async function pdf(text) {
  const document = new PDFDocument({ autoFirstPage: false }), chunks = []
  const result = new Promise((resolve, reject) => { document.on('data', chunk => chunks.push(chunk)); document.on('end', () => resolve(Buffer.concat(chunks))); document.on('error', reject) })
  document.addPage()
  if (text) {
    const font = 'C:/Windows/Fonts/simhei.ttf'
    if (await fs.stat(font).catch(() => null)) document.font(font)
    document.text(text)
  } else document.rect(20, 20, 30, 30).fill()
  document.end(); return result
}
async function fixture(body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-document-formats-'))
  const work = path.join(directory, 'work'), docs = path.join(directory, 'docs')
  await fs.mkdir(work); await fs.mkdir(docs)
  api.configureTerminalHost({ dataDir: path.join(directory, 'data'), docDir: docs })
  try { await body(directory, work, { workDir: work, docDir: docs, pagedFileReads: true }) }
  finally { await fs.rm(directory, { recursive: true, force: true }) }
}

test('EPUB attachment and work read_file share real spine-ordered text, pagination and immutable input', () => fixture(async (_dir, work, env) => {
  const file = path.join(work, '交接资料.epub'), bytes = epub()
  await fs.writeFile(file, bytes)
  const imported = await api.importFile(file)
  assert.equal(imported.ok, true, imported.error)
  const text = imported.info.text
  assert.ok(text.indexOf('第一章') < text.indexOf('第二章'))
  assert.match(text, /闻澜.*青柜-812/)
  assert.doesNotMatch(text, /不应|never-load/)
  const first = await read({ path: file, line_count: 2 }, env)
  assert.equal(first.ok, true, first.message); assert.match(first.message, /行号不是排版页码/)
  assert.ok(cursorOf(first.message)); assert.doesNotMatch(first.message, /闻澜/)
  const next = await read({ path: file, cursor: cursorOf(first.message) }, env)
  assert.equal(next.ok, true, next.message); assert.match(next.message, /闻澜.*青柜-812/)
  assert.deepEqual(await fs.readFile(file), bytes)
  const truncated = await api.importFile(file, 120)
  assert.equal(truncated.ok, true); assert.equal(truncated.info.truncated, true)
}))

test('desktop PDF reads the actual text layer; textless pages, old Office and images never become fake text', () => fixture(async (_dir, work, env) => {
  const file = path.join(work, '实际文字层.pdf'), bytes = await pdf('实际文字层：叶棠保管，柜号储柜-49。')
  await fs.writeFile(file, bytes)
  const imported = await api.importFile(file)
  assert.equal(imported.ok, true, imported.error)
  assert.match(imported.info.text, /PDF 第 1 页·文字层/)
  assert.match(imported.info.text, /叶棠.*储柜-49/)
  const result = await read({ path: file }, env)
  assert.equal(result.ok, true, result.message); assert.match(result.message, /叶棠.*储柜-49/)
  assert.deepEqual(await fs.readFile(file), bytes)
  const blank = path.join(work, '无文字图像页.pdf'); await fs.writeFile(blank, await pdf())
  const unread = await read({ path: blank }, env)
  assert.equal(unread.ok, false); assert.match(unread.message, /未提取到文字层.*不做 OCR/)
  for (const extension of ['doc', 'xls', 'ppt', 'png']) {
    const binary = path.join(work, '不能当正文.' + extension); await fs.writeFile(binary, Buffer.from([0, 1, 2, 3]))
    const blocked = await read({ path: binary }, env)
    assert.equal(blocked.ok, false); assert.match(blocked.message, /未提取正文|尚未读到图片中的文字/)
  }
  const unknown = path.join(work, '没有已知扩展.cache'); await fs.writeFile(unknown, Buffer.from([1, 0, 3, 4]))
  const rejected = await read({ path: unknown }, env)
  assert.equal(rejected.ok, false); assert.match(rejected.message, /未按普通正文读取/)
}))

test('EPUB external/unknown spine and entity tricks fail explicitly instead of guessing text', () => fixture(async (_dir, work) => {
  const file = path.join(work, '不安全.epub')
  const invalids = [
    { 'OEBPS/book.opf': '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="x" href="https://never-load.invalid/chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="x"/></spine></package>' },
    { 'OEBPS/chapter9.xhtml': '<!DOCTYPE html [<!ENTITY x SYSTEM "file:///private">]><html xmlns="http://www.w3.org/1999/xhtml"><body>&x;</body></html>' },
    { 'OEBPS/book.opf': '<package xmlns="http://www.idpf.org/2007/opf"><manifest/></package>' }
  ]
  for (const parts of invalids) {
    await fs.writeFile(file, epub(parts))
    const result = await api.importFile(file)
    assert.equal(result.ok, false); assert.match(result.error, /外部|实体|阅读顺序/)
  }
}))

function launch(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env: { ...process.env, DEEPWRITER_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => child.kill(), 30000)
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}
test('factory standalone CLI actually reads EPUB and explicitly reports PDF not read, with builtin-only external imports', () => fixture(async (dir, work) => {
  await fs.writeFile(path.join(work, '交接资料.epub'), epub())
  await fs.writeFile(path.join(work, '实际文字层.pdf'), await pdf('PDF text must not be silently decoded as plaintext'))
  const bundle = path.join(dir, 'deepwriter.cjs')
  const build = await launch(path.join(root, 'src/cli/build.mjs'), [`--outfile=${bundle}`], root)
  assert.equal(build.code, 0, build.stderr)
  const meta = JSON.parse(await fs.readFile(bundle + '.meta.json', 'utf8'))
  assert.ok(Object.keys(meta.inputs).some(name => name.endsWith('src/cli/pdfTextUnavailable.ts')))
  assert.ok(!Object.keys(meta.inputs).some(name => name.includes('node_modules/pdf-parse/')))
  for (const output of Object.values(meta.outputs)) for (const item of output.imports) assert.ok(item.external && isBuiltin(item.path), item.path)
  const faults = [], requests = []
  const server = http.createServer((req, res) => {
    req.setEncoding('utf8'); let raw = ''; req.on('data', bytes => { raw += bytes }); req.on('end', () => {
      try {
        const body = JSON.parse(raw); requests.push(body)
        const calls = requests.length === 1
        if (calls) for (const toolName of ['read_file', 'search_files']) {
          assert.match(body.tools.find(t => t.function.name === toolName).function.description, /PDF请用桌面版/)
        }
        const receipts = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
        let answer
        if (!calls) {
          assert.equal(requests.length, 2)
          const book = receipts.find(receipt => receipt.message.includes('EPUB'))
          const pdf = receipts.find(receipt => receipt.message.includes('独立 CLI'))
          assert.equal(book.ok, true, book.message); assert.match(book.message, /闻澜.*青柜-812/)
          assert.equal(pdf.ok, false, pdf.message); assert.match(pdf.message, /尚未读取此 PDF.*桌面.*无需移动文件/)
          const keeper = /保管人：([^；]+)；柜号：([^。]+)。/.exec(book.message)
          assert.ok(keeper); answer = `EPUB实际正文记录：${keeper[1]}保管，柜号${keeper[2]}。PDF当前CLI尚未读取，请在桌面直接打开同一文件。`
        }
        const delta = calls ? { tool_calls: ['交接资料.epub', '实际文字层.pdf'].map((name, index) => ({ index, id: 'read-format-' + index, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: name }) } })) } : { content: answer }
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
      } catch (error) { faults.push(error); res.writeHead(500); res.end('local document format fixture failed') }
    })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const result = await launch(bundle, ['agent', '读取交接资料.epub与实际文字层.pdf，只报告真实读到的内容；不能读取时明确说明。', '--work-dir', work, '--data-dir', path.join(dir, 'cli-data'), '--base-url', `http://127.0.0.1:${server.address().port}`, '--loopback', '--no-web', '--json'], dir)
    assert.deepEqual(faults, []); assert.equal(result.code, 0, result.stderr); assert.equal(requests.length, 2)
    assert.ok(result.stdout.includes('闻澜保管，柜号青柜-812')); assert.ok(result.stdout.includes('PDF当前CLI尚未读取'))
    console.log('FACTORY CLI: actual standalone bundle, 2 local provider calls, EPUB content read; PDF explicitly unread; builtin-only externals')
  } finally { await new Promise(resolve => server.close(resolve)) }
}))
