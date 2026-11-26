'use strict'
// Runs the installed public libraries, never a model endpoint or mocked XLSX parser.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { Readable } = require('node:stream')
const { test } = require('node:test')
const ExcelJS = require('exceljs')
const excelRequire = createRequire(require.resolve('exceljs'))
const unzipper = excelRequire('unzipper')
const packagePath = excelRequire.resolve('unzipper/package.json')
const installed = JSON.parse(fs.readFileSync(packagePath))
function input(bytes) {
  const chunks = []
  for (let offset = 0; offset < bytes.length; offset += 137) chunks.push(bytes.subarray(offset, offset + 137))
  return Readable.from(chunks, { objectMode: false, highWaterMark: 137 })
}
async function workbookBytes() {
  const book = new ExcelJS.Workbook()
  const first = book.addWorksheet('中文内容')
  first.addRow(['标题', '数量', '公式', '真假'])
  first.addRow(['海雾与灯塔 🌊', 42.25, { formula: 'B2*2', result: 84.5 }, true])
  const second = book.addWorksheet('第二页')
  second.addRow(['跨页中文', -7, { formula: "'中文内容'!B2+7", result: 49.25 }])
  const third = book.addWorksheet('Empty')
  third.addRow(['完整第三页'])
  return Buffer.from(await book.xlsx.writeBuffer())
}
async function parseEntries(bytes) {
  const parser = unzipper.Parse({ forceStream: true })
  const source = input(bytes)
  const entries = new Map()
  source.pipe(parser)
  try {
    for await (const entry of parser) entries.set(entry.path, await entry.buffer())
    return entries
  } finally { source.destroy(); parser.destroy() }
}
test('ExcelJS production require resolves exactly the scoped public unzipper 0.12.5 without unknown binary closure', () => {
  assert.equal(installed.name, 'unzipper')
  assert.equal(installed.version, '0.12.5')
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json')))
  assert.deepEqual(pkg.overrides.exceljs, { unzipper: '0.12.5' })
  const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package-lock.json')))
  for (const name of ['binary', 'buffers', 'chainsaw']) assert.equal(Object.keys(lock.packages).some(location => location.endsWith('/node_modules/' + name)), false, name)
  assert.equal(['binary', 'buffers', 'chainsaw'].some(name => installed.dependencies[name]), false)
})
test('real ExcelJS XLSX export and import preserve multiple sheets, Chinese values and formula results', async () => {
  const bytes = await workbookBytes()
  const restored = new ExcelJS.Workbook()
  await restored.xlsx.load(bytes)
  assert.deepEqual(restored.worksheets.map(sheet => sheet.name), ['中文内容', '第二页', 'Empty'])
  assert.equal(restored.getWorksheet('中文内容').getCell('A2').value, '海雾与灯塔 🌊')
  assert.equal(restored.getWorksheet('中文内容').getCell('B2').value, 42.25)
  assert.deepEqual(restored.getWorksheet('中文内容').getCell('C2').value, { formula: 'B2*2', result: 84.5 })
  assert.equal(restored.getWorksheet('中文内容').getCell('D2').value, true)
  assert.equal(restored.getWorksheet('第二页').getCell('A1').value, '跨页中文')
  assert.deepEqual(restored.getWorksheet('第二页').getCell('C1').value, { formula: "'中文内容'!B2+7", result: 49.25 })
})
test('installed forceStream parser preserves fragmented ZIP bytes and public ExcelJS xlsx.read preserves exact semantic values', async () => {
  const bytes = await workbookBytes()
  const entries = await parseEntries(bytes)
  for (const name of ['xl/workbook.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml']) assert.ok(entries.has(name), name)
  assert.match(entries.get('xl/sharedStrings.xml').toString(), /海雾与灯塔 🌊/)
  assert.match(entries.get('xl/worksheets/sheet1.xml').toString(), /<f>B2\*2<\/f>/)
  // Product uses writeBuffer; this public read API aggregates binary chunks
  // before XML decoding. Do not claim arbitrary UTF8-fragment WorkbookReader support.
  const restored = new ExcelJS.Workbook()
  await restored.xlsx.read(input(bytes))
  assert.deepEqual(restored.worksheets.map(sheet => sheet.name), ['中文内容', '第二页', 'Empty'])
  assert.deepEqual(restored.getWorksheet('中文内容').getRow(2).values.slice(1), ['海雾与灯塔 🌊', 42.25, { formula: 'B2*2', result: 84.5 }, true])
  assert.deepEqual(restored.getWorksheet('第二页').getRow(1).values.slice(1), ['跨页中文', -7, { formula: "'中文内容'!B2+7", result: 49.25 }])
  assert.equal(restored.getWorksheet('Empty').getCell('A1').value, '完整第三页')
})
test('corrupt and truncated ZIP inputs are rejected by the actual installed forceStream parser and XLSX import', { timeout: 10000 }, async () => {
  const bytes = await workbookBytes()
  const corrupt = Buffer.from(bytes)
  corrupt.writeUInt32LE(0xdeadbeef, 0)
  await assert.rejects(parseEntries(corrupt), /signature|invalid|unexpected|FILE_ENDED/i)
  await assert.rejects(parseEntries(bytes.subarray(0, 40)), /FILE_ENDED|unexpected|invalid/i)
  await assert.rejects(new ExcelJS.Workbook().xlsx.load(Buffer.from('not-a-ZIP')))
})
