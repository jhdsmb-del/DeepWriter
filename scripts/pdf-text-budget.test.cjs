const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { once } = require('node:events')
const { test } = require('node:test')
const { createRequire } = require('node:module')
const processes = require('node:child_process')
const { buildSync } = require('esbuild')
const PDFDocument = require('pdfkit')
const root = path.resolve(__dirname, '..')
const children = []
const nativeSpawn = processes.spawn
// Optional packaged-runtime probe: invoke this test with DeepWriter.exe in
// ELECTRON_RUN_AS_NODE mode and point this variable at resources/app.asar.
const appRequire = process.env.DEEPWRITER_PDF_PROBE_ASAR
  ? createRequire(path.join(path.resolve(process.env.DEEPWRITER_PDF_PROBE_ASAR), 'out/main/index.js')) : require
processes.spawn = (file, args, options) => {
  const child = nativeSpawn(file, args, options)
  child.pdfLaunch = { file, options }
  child.closed = false
  child.once('close', () => { child.closed = true })
  children.push(child)
  return child
}
const code = buildSync({
  stdin: { contents: `export {extractPdfText} from './src/main/pdfText'; export {importFile} from './src/main/fileImport'`, resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
  // The ESM resolver branch is intentionally unused in this CJS source harness.
  logOverride: { 'empty-import-meta': 'silent' }
}).outputFiles[0].text
function load(localRequire = appRequire) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports)
  return module.exports
}
const api = load()
async function pdf(pages) {
  const document = new PDFDocument({ autoFirstPage: false }), chunks = []
  document.on('data', chunk => chunks.push(chunk))
  const finished = once(document, 'end')
  for (const body of pages) {
    document.addPage()
    if (body) document.text(body)
    else document.rect(20, 20, 100, 100).fill()
  }
  document.end()
  await finished
  return Buffer.concat(chunks)
}
async function temporary(body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-pdf-budget-'))
  try { await body(directory) }
  finally { await fs.rm(directory, { recursive: true, force: true }) }
}

test('actual multipage PDF stops after the page filling maxChars; attachment keeps truthful scope', () => temporary(async directory => {
  const bytes = await pdf(['FIRST-PAGE ' + 'bounded text '.repeat(40), '', 'FINAL-PAGE retained only in the full read'])
  const small = await api.extractPdfText(bytes, 100)
  assert.deepEqual([small.pagesRead, small.totalPages, small.truncated, small.text.length], [1, 3, true, 100])
  assert.match(small.text, /PDF 第 1 页·文字层.*\nFIRST-PAGE/u)
  assert.doesNotMatch(small.text, /第 2 页|FINAL-PAGE/)
  const complete = await api.extractPdfText(bytes)
  assert.deepEqual([complete.pagesRead, complete.totalPages, complete.truncated], [3, 3, false])
  assert.match(complete.text, /PDF 第 2 页·文字层】\n（本页无可提取文字；未执行 OCR）/u)
  assert.match(complete.text, /PDF 第 3 页·文字层】\nFINAL-PAGE/u)
  const file = path.join(directory, 'real-three-pages.pdf')
  await fs.writeFile(file, bytes)
  const oldCwd = process.cwd()
  let imported
  try { process.chdir(directory); imported = await api.importFile(file, 100) }
  finally { process.chdir(oldCwd) }
  assert.equal(imported.ok, true, imported.error)
  assert.equal(imported.info.source, 'pdf')
  assert.equal(imported.info.text, small.text)
  assert.equal(imported.info.truncated, true)
  assert.ok(children.every(child => child.closed))
  assert.ok(children.every(child => child.pdfLaunch.file === process.execPath))
  assert.ok(children.every(child => child.pdfLaunch.options.cwd === path.dirname(process.execPath)))
  assert.deepEqual(await fs.readFile(file), bytes)
  console.log('REAL PDF: 3 pages; maxChars=100 read exactly page 1; full read retained blank-page location and final-page text; all parser processes exited')
}))

test('bounded textless prefix is not a whole-document scan verdict; entirely textless PDF is explicit', async () => {
  const mixed = await pdf(['', '', 'READABLE LATER PAGE'])
  const small = await api.extractPdfText(mixed, 32)
  assert.deepEqual([small.pagesRead, small.totalPages, small.truncated], [1, 3, true])
  assert.match(small.text, /本页无可提取文字/u)
  assert.doesNotMatch(small.text, /已检查 3 页|没有内容/u)
  const full = await api.extractPdfText(mixed)
  assert.match(full.text, /READABLE LATER PAGE/u)
  assert.equal(full.truncated, false)
  await assert.rejects(api.extractPdfText(await pdf(['', ''])), /未提取到文字层；已检查 2 页.*不做 OCR.*不能据此判断文档没有内容/u)
  assert.ok(children.every(child => child.closed))
})

test('abort during real PDF page loading returns only after the parser process closes', async () => {
  const bytes = await pdf(Array.from({ length: 80 }, (_, i) => `PAGE-${i + 1} ` + 'actual document text '.repeat(40)))
  const controller = new AbortController(), start = children.length
  const pending = api.extractPdfText(bytes, 300_000, controller.signal)
  const child = children[start]
  const [message] = await Promise.race([
    once(child, 'message'),
    pending.then(() => { throw new Error('PDF completed before the cancellation observation') })
  ])
  assert.equal(message.started, true)
  const started = Date.now()
  controller.abort(new Error('author cancelled real PDF'))
  await assert.rejects(pending, /author cancelled real PDF/u)
  assert.equal(child.closed, true)
  assert.ok(Date.now() - started < 2000, 'abort did not promptly release parser process')
  const already = new AbortController(); already.abort()
  await assert.rejects(api.extractPdfText(bytes, 100, already.signal), { name: 'AbortError' })
  assert.equal(children.length, start + 1, 'pre-aborted reads must not create a parser process')
  console.log('REAL PDF CANCEL: 80-page document; page loading started -> abort -> process closed before return')
})

test('cancellation also interrupts a parser stuck inside one synchronous page, not just between pages', () => temporary(async directory => {
  const marker = path.join(directory, 'entered-page'), parserFile = path.join(directory, 'slow-parser.cjs')
  await fs.writeFile(parserFile, `exports.PDFParse=class {async getText(options){require('node:assert/strict').deepEqual(options.partial,[1]);require('node:fs').writeFileSync(${JSON.stringify(marker)},'page 1');while(true){}};async destroy(){}}`)
  const localRequire = name => appRequire(name)
  localRequire.resolve = name => name === 'pdf-parse' ? parserFile : appRequire.resolve(name)
  const slow = load(localRequire), controller = new AbortController(), before = children.length
  const pending = slow.extractPdfText(await pdf(['real PDF passed to parser']), 100, controller.signal)
  // Observe the actual process entering getText, rather than relying on a delay.
  const deadline = Date.now() + 5000
  try {
    while (!(await fs.stat(marker).catch(() => null))) {
      if (Date.now() > deadline) throw new Error('parser did not enter page extraction')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  } finally { controller.abort(new Error('cancel synchronous page')) }
  await assert.rejects(pending, /cancel synchronous page/u)
  assert.equal(children[before].closed, true)
}))
