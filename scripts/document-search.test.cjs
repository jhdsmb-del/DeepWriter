const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), http = require('node:http')
const { before, test } = require('node:test'), { build } = require('esbuild')
const { Document, Paragraph, Packer } = require('docx'), PDFDocument = require('pdfkit')
const { zipSync, strToU8 } = require('fflate')
const root = path.resolve(__dirname, '..'), needle = 'custody[Q+7]'
let api
before(async () => {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
    export {agentTools} from './src/main/agentTools'; export {configureTerminalHost} from './src/cli/host';
    export {createCliRuntime} from './src/cli/runtime'; export {loadCliConfig} from './src/cli/config';
    export {parseFileSource,parseFileSources} from './src/shared/fileEvidence'; export {unwrapToolResult} from './src/main/toolResultView';
    export {modelVisibleOutput} from './src/main/jobs/toolTurnOutput';
  ` }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const module = { exports: {} }; new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports); api = module.exports
})
const call = (name, args, env) => api.agentTools.find(tool => tool.name === name).execute(args, env.docDir, env)
const fact = name => `${needle} owner=${name} vault=V-${name}.`
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const archive = parts => Buffer.from(zipSync(Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, strToU8(value)]))))
const relationships = (type, target) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`
const contentTypes = (part, type) => `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/></Types>`
async function docx(paragraphs) { return Packer.toBuffer(new Document({ sections: [{ children: paragraphs.map(text => new Paragraph(text)) }] })) }
async function pdf(text) {
  const document = new PDFDocument(), chunks = []
  const result = new Promise((resolve, reject) => { document.on('data', chunk => chunks.push(chunk)); document.on('end', () => resolve(Buffer.concat(chunks))); document.on('error', reject) })
  if (text) document.text(text); else document.rect(20, 20, 30, 30).fill()
  document.end(); return result
}
async function writeCollection(work) {
  const docs = path.join(work, '资料'); await fs.mkdir(docs)
  await fs.writeFile(path.join(docs, '同名.docx'), await docx(['前文😀'.repeat(1400) + fact('DOCX'), fact('DOCX')]))
  await fs.writeFile(path.join(docs, '同名.pdf'), await pdf(fact('PDF') + '\n' + fact('PDF')))
  await fs.writeFile(path.join(docs, '同名.xlsx'), archive({
    '[Content_Types].xml': contentTypes('xl/workbook.xml', 'spreadsheetml.sheet.main'), '_rels/.rels': relationships('officeDocument', 'xl/workbook.xml'),
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="交接" sheetId="1" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': relationships('worksheet', 'worksheets/sheet1.xml'),
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${xml(fact('XLSX'))}</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>${xml(fact('XLSX'))}</t></is></c></row></sheetData></worksheet>`
  }))
  await fs.writeFile(path.join(docs, '同名.pptx'), archive({
    '[Content_Types].xml': contentTypes('ppt/presentation.xml', 'presentationml.presentation.main'), '_rels/.rels': relationships('officeDocument', 'ppt/presentation.xml'),
    'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="r1"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': relationships('slide', 'slides/slide1.xml'),
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${xml(fact('PPTX'))}</a:t></a:r></a:p><a:p><a:r><a:t>${xml(fact('PPTX'))}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
  }))
  await fs.writeFile(path.join(docs, '同名.epub'), archive({
    mimetype: 'application/epub+zip', 'META-INF/container.xml': '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'book.opf': '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="one" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>',
    'chapter.xhtml': `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${xml(fact('EPUB'))}</p><p>${xml(fact('EPUB'))}</p></body></html>`
  }))
  return docs
}
async function fixture(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-document-search-')), work = path.join(dir, 'work'), docs = path.join(dir, 'docs')
  await fs.mkdir(work); await fs.mkdir(docs); api.configureTerminalHost({ dataDir: path.join(dir, 'host'), docDir: docs })
  try { await body(dir, work, { workDir: work, docDir: docs, pagedFileReads: true, sessionId: 'search', runId: 'search-run' }) }
  finally { assert.equal(path.dirname(dir), os.tmpdir()); assert.match(path.basename(dir), /^dw-document-search-/); await fs.rm(dir, { recursive: true, force: true }) }
}

test('opt-in document collection extracts each file once, preserves text defaults and round-trips all five formats through same-source locators', async t => fixture(async (_dir, work, env) => {
  await writeCollection(work)
  await fs.writeFile(path.join(work, '纯文本.md'), '普通文本不含交接结论。')
  const opened = new Map(), open = fs.open.bind(fs)
  t.mock.method(fs, 'open', async (file, ...args) => { if (/\.(docx|pdf|xlsx|pptx|epub)$/i.test(String(file))) opened.set(String(file), (opened.get(String(file)) ?? 0) + 1); return open(file, ...args) })
  const plain = await call('search_files', { pattern: needle, literal: true }, env)
  assert.equal(plain.ok, true, plain.message); assert.match(plain.message, /^未找到匹配/); assert.match(plain.message, /5 个文档未提取/); assert.equal(opened.size, 0)
  const unscoped = await call('search_files', { documents: true, pattern: needle, literal: true }, env)
  assert.equal(unscoped.ok, false); assert.match(unscoped.message, /显式提供path或include/); assert.equal(opened.size, 0)
  const narrow = await call('search_files', { path: '.', include: '资料/**/*.DOCX', documents: true, pattern: needle, literal: true }, env)
  assert.equal(narrow.ok, true, narrow.message); assert.equal(narrow.sources.length, 2); assert.equal(opened.size, 1)
  assert([...opened.values()].every(count => count === 1), 'multiple hits must share one extraction')
  opened.clear()
  const found = await call('search_files', { path: '资料', documents: true, pattern: needle, literal: true }, env)
  assert.equal(found.ok, true, found.message); assert.equal(found.sources.length, 10, found.message)
  assert.doesNotMatch(found.message, /输入≤|提取上限|每文件只提取一次/, 'normal results carry locations, not parser implementation limits')
  assert.equal(opened.size, 5); assert([...opened.values()].every(count => count === 1))
  assert.equal(new Set(found.sources.map(source => path.extname(source.path))).size, 5)
  for (const source of found.sources) {
    assert.equal(source.kind, 'document'); assert(api.parseFileSource(source)); assert.match(source.read.cursor, /^(d1|o1):/)
    const read = await call('read_file', source.read, env)
    assert.equal(read.ok, true, read.message); assert.equal(read.sources[0].excerpt, source.excerpt); assert.deepEqual(read.sources[0].range, source.range)
  }
  const explicit = await call('search_files', { path: '资料/同名.docx', pattern: needle, literal: true }, env)
  assert.equal(explicit.sources.length, 2, 'an explicit document path does not need directory opt-in')
  const wrongScope = await call('search_files', { path: '资料', include: '*.md', documents: true, pattern: needle, literal: true }, env)
  assert.equal(wrongScope.ok, true); assert.match(wrongScope.message, /^未找到匹配/)
  const exactGlob = await call('find_files', { path: '.', pattern: '资料/**/*.DOCX' }, env)
  assert.equal(JSON.parse(exactGlob.message).matches.length, 1)
  await fs.appendFile(explicit.sources[0].path, 'source changed')
  const stale = await call('read_file', explicit.sources[0].read, env)
  assert.equal(stale.ok, false); assert.match(stale.message, /已更改/)
}))

test('no match, truncated extraction, image-only PDF, parse failure, read budget, authorization and cancellation remain different outcomes', async t => fixture(async (dir, work, env) => {
  const good = path.join(work, 'good.docx'); await fs.writeFile(good, await docx([fact('DOCX')]))
  const noMatch = await call('search_files', { path: good, literal: true, pattern: 'MISSING' }, env)
  assert.equal(noMatch.ok, true); assert.match(noMatch.message, /^未找到匹配/)
  const blank = path.join(work, 'scan.pdf'); await fs.writeFile(blank, await pdf())
  const scanned = await call('search_files', { path: blank, literal: true, pattern: needle }, env)
  assert.equal(scanned.ok, false); assert.match(scanned.message, /没有可提取文字层.*扫描件/); assert.doesNotMatch(scanned.message, /^未找到匹配/)
  const bad = path.join(work, 'bad.docx'); await fs.writeFile(bad, 'not a valid document')
  const failed = await call('search_files', { path: bad, literal: true, pattern: needle }, env)
  assert.equal(failed.ok, false); assert.match(failed.message, /未能读取/); assert.doesNotMatch(failed.message, /没有可提取文字层/)
  const longText = Array.from({ length: 40000 }, (_, index) => `${index.toString(36)}-文档原文${(index * 8191).toString(36)};`).join('')
  assert(longText.length > 300000)
  const large = path.join(work, 'truncated.docx'); await fs.writeFile(large, await docx([fact('DOCX'), longText, 'UNREAD_TAIL']))
  const truncated = await call('search_files', { path: large, literal: true, pattern: 'UNREAD_TAIL' }, env)
  assert.equal(truncated.ok, false); assert.match(truncated.message, /文档提取已截断.*后续原文尚未搜索/)
  const prefix = await call('search_files', { path: large, literal: true, pattern: needle }, env)
  assert.equal(prefix.ok, true); assert(prefix.sources.every(source => source.excerpt_truncated))
  const open = fs.open.bind(fs); let opens = 0
  const mock = t.mock.method(fs, 'open', async (...args) => { opens++; return open(...args) })
  const noBudget = await call('search_files', { path: good, literal: true, pattern: needle }, { ...env, readBudgetChars: 0 })
  assert.equal(noBudget.ok, false); assert.match(noBudget.message, /read_input_budget_insufficient/); assert.equal(opens, 0)
  const outside = path.join(dir, 'outside.docx'); await fs.writeFile(outside, await docx(['PRIVATE_NEVER_READ']))
  const denied = await call('search_files', { path: outside, documents: true, literal: true, pattern: 'PRIVATE' }, { ...env, nonInteractiveLocalRead: true })
  assert.equal(denied.ok, false); assert.match(denied.message, /未执行|未获|授权/); assert.equal(opens, 0)
  const badInclude = await call('search_files', { include: '../outside.docx', documents: true, literal: true, pattern: needle }, env)
  assert.equal(badInclude.ok, false); assert.match(badInclude.message, /include 无效/); assert.equal(opens, 0)
  const budget = await call('search_files', { path: good, literal: true, pattern: needle }, { ...env, readBudgetChars: 800 })
  assert.equal(budget.ok, true, budget.message); assert(api.modelVisibleOutput('search_files', JSON.stringify(budget)).length < 20000)
  assert(budget.sources.every(source => JSON.stringify(source.excerpt).length - 2 <= 800))
  mock.mock.restore()
  const controller = new AbortController()
  t.mock.method(fs, 'open', async (...args) => { const handle = await open(...args); controller.abort(); return handle })
  const cancelled = await call('search_files', { path: good, literal: true, pattern: needle }, { ...env, signal: controller.signal })
  assert.equal(cancelled.ok, false); assert.match(cancelled.message, /已停止.*未完成/); assert.doesNotMatch(cancelled.message, /未找到匹配/)
}))

test('actual model-visible search → locator reread works in ordinary Agent and read-only plan with five source formats and no edits', { timeout: 60000 }, async () => fixture(async (dir, work) => {
  await writeCollection(work)
  const expectedFiles = (await fs.readdir(path.join(work, '资料'))).sort(), requests = { AGENT: [], PLAN: [] }, errors = []
  const server = http.createServer((request, response) => { let raw = ''; request.on('data', chunk => raw += chunk); request.on('end', () => {
    try {
      const body = JSON.parse(raw), mode = body.messages.some(message => message.role === 'user' && message.content.includes('PLAN')) ? 'PLAN' : 'AGENT'
      requests[mode].push(body)
      const receipts = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
      assert(receipts.every(receipt => receipt.sources === undefined), 'evidence must not duplicate excerpts on the model wire')
      let name, args, answer
      if (!receipts.length) {
        const search = body.tools.find(tool => tool.function.name === 'search_files').function
        assert(search.parameters.properties.documents && search.parameters.properties.include); assert.match(search.description, /目录默认只搜文本.*显式documents:true/)
        if (mode === 'PLAN') assert(body.tools.every(tool => !['write_file', 'run_command'].includes(tool.function.name)))
        name = 'search_files'; args = { path: '资料', documents: true, include: '同名.*', pattern: needle, literal: true }
      } else if (receipts.length === 1) {
        assert.equal(receipts[0].ok, true, receipts[0].message)
        const seen = new Set(), files = [...receipts[0].message.matchAll(/读取原文：read_file ([^\n]+)/g)].map(match => JSON.parse(match[1])).filter(read => { const extension = path.extname(read.path); if (seen.has(extension)) return false; seen.add(extension); return true })
        assert.equal(files.length, 5); assert(files.every(read => /^[do]1:/.test(read.cursor)))
        name = 'read_files'; args = { files }
      } else {
        const files = JSON.parse(receipts.at(-1).message).files; assert.equal(files.length, 5)
        answer = (mode === 'PLAN' ? '## 只读核对方案\n' : '') + files.map(file => {
          assert.equal(file.ok, true, file.message)
          const matched = /owner=([A-Z]+) vault=(V-[A-Z]+)/.exec(file.message), range = /提取范围 \[([^\]]+)\)/.exec(file.message)
          assert(matched && range); return `${file.path} 提取文本[${range[1]})：${matched[1]}保管，${matched[2]}。`
        }).join('\n')
      }
      const delta = name ? { tool_calls: [{ index: 0, id: mode + '-' + requests[mode].length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: answer }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n')
    } catch (error) { errors.push(error); response.writeHead(500); response.end('local document search fixture failure') }
  }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const mode of ['AGENT', 'PLAN']) {
      const dataDir = path.join(dir, mode), options = { 'base-url': `http://127.0.0.1:${server.address().port}`, loopback: true, protocol: 'openai-chat', model: 'document-search-fixture', context: '65536', 'max-tokens': '1024', 'work-dir': work, 'doc-dir': work, 'no-web': true, 'tool-support': true, 'key-env': 'DW_DOCUMENT_SEARCH_NO_KEY' }
      const { config } = await api.loadCliConfig(dataDir, options), runtime = await api.createCliRuntime({ dataDir, config, secret: '', options, emit: () => {} })
      try {
        await runtime[mode === 'PLAN' ? 'plan' : 'agent'](`${mode}：核对资料里的custody[Q+7]，先搜文档再按实际返回定位回读，逐份列保管人/柜号和提取文本位置；不得写盘。`)
        assert.deepEqual(errors, []); assert.equal(requests[mode].length, 3)
        const row = runtime.repo.listRecentRuns(1)[0]; assert.equal(row.status, 'completed')
        const calls = runtime.repo.getToolCallsByRun(row.run_id); assert.deepEqual(calls.map(call => call.name), ['search_files', 'read_files'])
        const evidence = calls.map(call => api.parseFileSources(api.unwrapToolResult(call.result_json).payload.sources))
        assert.equal(evidence[0].length, 10); assert.equal(evidence[1].length, 5)
        assert(evidence.flat().every(source => source.kind === 'document'))
      } finally { await runtime.close() }
    }
    assert.deepEqual((await fs.readdir(path.join(work, '资料'))).sort(), expectedFiles)
    console.log('# document search evidence: 5 real document formats; ordinary Agent and read-only plan each 3 loopback requests, search_files→read_files, 10 search + 5 reread durable sources; no OCR or edits')
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}))
