const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { before, test } = require('node:test')
const { zipSync, strToU8 } = require('fflate')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let extractOfficeText
before(() => {
  const built = esbuild.buildSync({ entryPoints: [path.join(root, 'src/main/officeText.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
  extractOfficeText = loaded.exports.extractOfficeText
})
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const TYPE = 'http://schemas.openxmlformats.org/package/2006/content-types'
const rels = items => `<Relationships xmlns="${REL}">${items.map(([Id, kind, Target, external]) => `<Relationship Id="${Id}" Type="${R}/${kind}" Target="${Target}"${external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`
const zip = parts => Buffer.from(zipSync(Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value]))))

function workbookParts() {
  return {
    '[Content_Types].xml': `<Types xmlns="${TYPE}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet9.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    '_rels/.rels': rels([['main', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="先看结论" sheetId="9" r:id="r9"/><sheet name="隐藏预算" sheetId="1" state="hidden" r:id="r1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels([['r1', 'worksheet', 'worksheets/sheet1.xml'], ['strings', 'sharedStrings', 'sharedStrings.xml'], ['r9', 'worksheet', 'worksheets/sheet9.xml'], ['network', 'hyperlink', 'https://never-load.invalid/private', true]]),
    'xl/sharedStrings.xml': `<sst xmlns="${S}" count="2" uniqueCount="2"><si><r><t>中文</t></r><r><t xml:space="preserve"> 姓名😀</t></r><rPh sb="0" eb="2"><t>zhongwen</t></rPh></si><si><t>第一行_x000A_第二行 &amp; _x005F_x0041_</t></si></sst>`,
    'xl/worksheets/sheet9.xml': `<worksheet xmlns="${S}"><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"/><c r="D1" t="inlineStr"><is><r><t>柜号</t></r><r><t> C-17</t></r></is></c></row>
      <row r="3"><c r="AA3" t="b"><v>1</v></c><c r="AC3"><f>SUM(2,3)</f><v>5</v></c><c r="AD3"><f>SUM(A1:A2)</f></c><c r="AE3"><f t="shared" si="0"/><v>7</v></c><c r="AF3" t="s"><v>1</v></c><c r="AG3"><v>1234567890123456789</v></c><c r="AH3" t="e"><v>#DIV/0!</v></c></row>
      <row r="1048576"><c r="XFD1048576" t="inlineStr"><is><t>稀疏尾部</t></is></c></row>
    </sheetData></worksheet>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>最后的预算</t></is></c><c r="B1"><v>300</v></c></row></sheetData></worksheet>`
  }
}
function presentationParts() {
  const slide = inner => `<s:sld xmlns:s="${P}" xmlns:d="${A}"><s:cSld><s:spTree>${inner}</s:spTree></s:cSld></s:sld>`
  const shape = paragraphs => `<s:sp><s:txBody>${paragraphs}</s:txBody></s:sp>`
  return {
    '[Content_Types].xml': `<Types xmlns="${TYPE}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide10.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    '_rels/.rels': rels([['main', 'officeDocument', '/ppt/presentation.xml']]),
    'ppt/presentation.xml': `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="first"/><p:sldId id="257" r:id="second"/><p:sldId id="258" r:id="third"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['second', 'slide', 'slides/slide2.xml'], ['third', 'slide', 'slides/slide3.xml'], ['first', 'slide', 'slides/slide10.xml'], ['network', 'image', 'https://never-load.invalid/remote.png', true]]),
    'ppt/slides/slide10.xml': slide(shape('<d:p><d:r><d:t>先看</d:t></d:r><d:r><d:t>结论😀</d:t></d:r><d:br/><d:fld id="field"><d:t>第二行</d:t></d:fld></d:p><d:p><d:r><d:t>负责人：小禾 &amp; 小舟</d:t></d:r></d:p>')),
    'ppt/slides/slide2.xml': slide('<s:graphicFrame><d:graphic><d:graphicData><d:tbl><d:tr><d:tc><d:txBody><d:p><d:r><d:t>后页表格</d:t></d:r></d:p></d:txBody></d:tc></d:tr></d:tbl></d:graphicData></d:graphic></s:graphicFrame>'),
    'ppt/slides/slide3.xml': slide('<s:pic/>'),
    'ppt/notesSlides/notesSlide1.xml': slide(shape('<d:p><d:r><d:t>不应冒充正文的备注</d:t></d:r></d:p>')),
    'ppt/media/unused.bin': Buffer.from('not an image, never decoded')
  }
}

test('XLSX reads shared/inline strings, explicit blanks, sparse positions, formulas and workbook sheet order', async () => {
  const result = await extractOfficeText(zip(workbookParts()), 'xlsx')
  assert.equal(result.truncated, false)
  assert.match(result.text, /【"先看结论"!A1】"中文 姓名😀"/)
  assert.match(result.text, /【"先看结论"!B1】（空）/)
  assert.match(result.text, /【"先看结论"!D1】"柜号 C-17"/)
  assert.match(result.text, /【"先看结论"!AA3】TRUE/)
  assert.match(result.text, /AC3】公式："=SUM\(2,3\)"；缓存结果（未重算，可能过期）：5/)
  assert.match(result.text, /AD3】公式：.*缓存结果（未重算，可能过期）：未提供/)
  assert.match(result.text, /AE3】公式：共享或数组公式.*缓存结果.*：7/)
  assert.match(result.text, /第一行\\n第二行 & _x0041_/)
  assert.match(result.text, /1234567890123456789/)
  assert.match(result.text, /单元格错误：#DIV\/0!/)
  assert.match(result.text, /【"先看结论"!XFD1048576】"稀疏尾部"/)
  assert.match(result.text, /【"隐藏预算"!A1】"最后的预算"/)
  assert.match(result.text, /【"隐藏预算"!B1】300/)
  assert.ok(result.text.indexOf('先看结论') < result.text.indexOf('隐藏预算'))
  assert.ok(result.text.length < 2500, 'a far-away sparse cell must not expand empty rows or columns')
  assert.doesNotMatch(result.text, /zhongwen|never-load/)
})

test('PPTX follows presentation relationships, preserves rich text/breaks and marks textless slides', async () => {
  const result = await extractOfficeText(zip(presentationParts()), 'pptx')
  assert.equal(result.truncated, false)
  assert.match(result.text, /【幻灯片 1·段落 1】"先看结论😀\\n第二行"/)
  assert.match(result.text, /【幻灯片 1·段落 2】"负责人：小禾 & 小舟"/)
  assert.match(result.text, /【幻灯片 2·段落 1】"后页表格"/)
  assert.match(result.text, /【幻灯片 3】\n（没有可提取的幻灯片正文；未执行 OCR）/)
  assert.ok(result.text.indexOf('先看结论') < result.text.indexOf('后页表格'))
  assert.doesNotMatch(result.text, /不应冒充正文的备注|never-load|unused/)
})

test('real-format files are read locally without mutations or network access', async () => {
  const evidenceDir = process.env.DW_OFFICE_EVIDENCE_DIR
  let dir = evidenceDir ? path.resolve(evidenceDir) : await fs.mkdtemp(path.join(os.tmpdir(), 'dw-office-real-'))
  if (evidenceDir) {
    // The workspace itself may live below the author's Documents junction.
    dir = await fs.realpath(dir).catch(async () => path.join(await fs.realpath(path.dirname(dir)), path.basename(dir)))
    const relative = path.relative(await fs.realpath(path.join(root, 'out')), dir)
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'test evidence must stay under this repository out/')
    await fs.mkdir(dir, { recursive: true })
  }
  const fetch = global.fetch
  global.fetch = () => { throw new Error('Office extraction attempted a network call') }
  try {
    for (const [format, parts] of [['xlsx', workbookParts()], ['pptx', presentationParts()]]) {
      const file = path.join(dir, '中文资料.' + format), input = zip(parts)
      await fs.writeFile(file, input)
      const before = await fs.stat(file)
      const result = await extractOfficeText(await fs.readFile(file), format)
      assert.match(result.text, /先看结论/)
      assert.deepEqual(await fs.readFile(file), input)
      assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs)
      if (evidenceDir) await fs.writeFile(path.join(dir, format + '-text.json'), JSON.stringify(result, null, 2))
      console.log(`REAL ${format}: ${input.length} bytes, extracted ${result.text.length} units, local read only`)
    }
  } finally { global.fetch = fetch; if (!evidenceDir) await fs.rm(dir, { recursive: true, force: true }) }
  // Independently open the synthesized XLSX with the existing public Office
  // library. It confirms this fixture is a workbook, not XML renamed .xlsx.
  const ExcelJS = require('exceljs'), workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(zip(workbookParts()))
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['先看结论', '隐藏预算'])
  assert.equal(workbook.getWorksheet('先看结论').getCell('D1').text, '柜号 C-17')
})

test('XML parser rejects malformed XML, DTD/entity declarations and missing referenced parts', async () => {
  const dtd = workbookParts()
  dtd['xl/worksheets/sheet9.xml'] = `<!DOCTYPE worksheet [<!ENTITY local SYSTEM "file:///private">]><worksheet xmlns="${S}"><sheetData/></worksheet>`
  await assert.rejects(extractOfficeText(zip(dtd), 'xlsx'), /DTD|实体/)
  const malformed = presentationParts()
  malformed['ppt/slides/slide10.xml'] = `<p:sld xmlns:p="${P}"><mismatched></p:sld>`
  await assert.rejects(extractOfficeText(zip(malformed), 'pptx'), /XML 无效/)
  const missing = workbookParts(); delete missing['xl/worksheets/sheet9.xml']
  await assert.rejects(extractOfficeText(zip(missing), 'xlsx'), /缺少引用的 XML 条目/)
})

test('external/traversing slide and sheet targets and macro masquerades do not yield guessed contents', async () => {
  for (const target of ['../../outside.xml', 'https://never-load.invalid/sheet.xml']) {
    const parts = workbookParts()
    parts['xl/_rels/workbook.xml.rels'] = rels([['r9', 'worksheet', target, target.startsWith('https:')]])
    await assert.rejects(extractOfficeText(zip(parts), 'xlsx'), /越出文档包|外部内容/)
  }
  const external = presentationParts()
  external['ppt/_rels/presentation.xml.rels'] = rels([['first', 'slide', 'https://never-load.invalid/slide.xml', true]])
  await assert.rejects(extractOfficeText(zip(external), 'pptx'), /外部内容/)
  const macro = workbookParts()
  macro['[Content_Types].xml'] = macro['[Content_Types].xml'].replace('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'application/vnd.ms-excel.sheet.macroEnabled.main+xml')
  await assert.rejects(extractOfficeText(zip(macro), 'xlsx'), /不读取旧版二进制或宏格式/)
  await assert.rejects(extractOfficeText(zip(workbookParts()), 'pptx'), /不是标准 .pptx/)
})

test('bad shared-string indexes and contradictory cell addresses fail rather than shift columns', async () => {
  const inferred = workbookParts()
  inferred['xl/worksheets/sheet1.xml'] = `<worksheet xmlns="${S}"><sheetData><row><c t="inlineStr"><is><t>省略地址仍从A1开始</t></is></c><c><v>300</v></c></row></sheetData></worksheet>`
  const inferredText = (await extractOfficeText(zip(inferred), 'xlsx')).text
  assert.match(inferredText, /【"隐藏预算"!A1】"省略地址仍从A1开始"/)
  assert.match(inferredText, /【"隐藏预算"!B1】300/)
  const invalid = workbookParts()
  invalid['xl/worksheets/sheet9.xml'] = `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="s"><v>99</v></c></row></sheetData></worksheet>`
  await assert.rejects(extractOfficeText(zip(invalid), 'xlsx'), /共享字符串索引无效/)
  invalid['xl/worksheets/sheet9.xml'] = `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A2"><v>1</v></c></row></sheetData></worksheet>`
  await assert.rejects(extractOfficeText(zip(invalid), 'xlsx'), /单元格位置矛盾/)
})

test('bounded output is explicit, does not split emoji, and cancellation happens before parsing', async () => {
  const bytes = zip(workbookParts()), full = (await extractOfficeText(bytes, 'xlsx')).text
  const cutoff = full.indexOf('😀') + 1
  const clipped = await extractOfficeText(bytes, 'xlsx', { maxChars: cutoff })
  assert.equal(clipped.truncated, true)
  assert.ok(clipped.text.length <= cutoff)
  assert.ok(!/[\uD800-\uDBFF]$/u.test(clipped.text))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(extractOfficeText(bytes, 'xlsx', { signal: controller.signal }), /abort/i)
  await assert.rejects(extractOfficeText(Buffer.from('not a ZIP'), 'xlsx'), /ZIP 预检拒绝/)
})

function alterZipPart(buffer, name, change) {
  const bytes = Buffer.from(buffer), end = bytes.length - 22
  let central = bytes.readUInt32LE(end + 16)
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const length = bytes.readUInt16LE(central + 28), extra = bytes.readUInt16LE(central + 30), comment = bytes.readUInt16LE(central + 32)
    if (bytes.subarray(central + 46, central + 46 + length).toString('utf8') === name) {
      const local = bytes.readUInt32LE(central + 42), data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
      change(bytes, central, local, data)
      return bytes
    }
    central += 46 + length + extra + comment
  }
  throw new Error('Fixture ZIP entry missing')
}

test('actual inflate is bounded against lying sizes, while unrelated media is never inflated', async () => {
  const selected = alterZipPart(zip(workbookParts()), 'xl/worksheets/sheet9.xml', (bytes, central, local) => {
    bytes.writeUInt32LE(10, central + 24); bytes.writeUInt32LE(10, local + 22)
  })
  await assert.rejects(extractOfficeText(selected, 'xlsx'), /实际解压大小|CRC|实际大小/)
  const parts = presentationParts()
  parts['ppt/media/unused.bin'] = Buffer.from('not decoded; repeated media fixture '.repeat(20))
  const corruptMedia = alterZipPart(zip(parts), 'ppt/media/unused.bin', (bytes, _central, _local, data) => { bytes[data] = 7 /* invalid deflate block, only harmful if inflated */ })
  const result = await extractOfficeText(corruptMedia, 'pptx')
  assert.match(result.text, /先看结论/)
  assert.equal(result.truncated, false)
})

module.exports = { workbookParts, presentationParts, zip }
