import path from 'node:path'
import { SaxesParser, type SaxesAttributeNS } from 'saxes'
import { preflightZip } from './archiveSafety'
import { indexProjectArchive, readArchiveEntryBytes, type ProjectArchive } from './projectArchive'

export interface OfficeTextOptions { maxChars?: number; signal?: AbortSignal }
export interface OfficeTextResult { text: string; truncated: boolean }

const MB = 1024 * 1024
const MAX_XML_PART = 8 * MB
const MAX_XML_TOTAL = 32 * MB
const SHEET_NS = new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'])
const SLIDE_NS = new Set(['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main'])
const DRAWING_NS = new Set(['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'])
const REL_ATTR_NS = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'])
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CONTENT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const MAIN_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
}

interface XmlNode { local: string; uri: string; attrs: SaxesAttributeNS[]; children: Array<XmlNode | string> }
function attr(node: XmlNode, local: string, namespaces?: Set<string>): string | undefined {
  return node.attrs.find(value => value.local === local && (namespaces ? namespaces.has(value.uri) : value.uri === ''))?.value
}
const is = (node: XmlNode, local: string, namespaces: Set<string>): boolean => node.local === local && namespaces.has(node.uri)
function children(node: XmlNode, local: string, namespaces: Set<string>): XmlNode[] {
  return node.children.filter((child): child is XmlNode => typeof child !== 'string' && is(child, local, namespaces))
}
function* descendants(node: XmlNode): Generator<XmlNode> {
  for (const child of node.children) if (typeof child !== 'string') { yield child; yield* descendants(child) }
}
function text(node: XmlNode): string { return node.children.map(child => typeof child === 'string' ? child : text(child)).join('') }

function parseXml(bytes: Uint8Array, name: string, signal?: AbortSignal): XmlNode {
  if (bytes.length > MAX_XML_PART) throw new Error(`Office XML 条目超过 8MB：${name}`)
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0x3c && bytes[1] === 0 ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c ? 'utf-16be' : 'utf-8'
  const source = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  const parser = new SaxesParser({ xmlns: true, fileName: name })
  const stack: XmlNode[] = []
  let root: XmlNode | undefined, count = 0
  parser.on('doctype', () => { throw new Error('Office XML 不允许 DTD 或实体声明') })
  parser.on('error', error => { throw new Error(`Office XML 无效（${name}）：${error.message}`) })
  parser.on('opentag', tag => {
    if (++count > 200_000 || stack.length >= 128) throw new Error(`Office XML 结构超过读取限制：${name}`)
    const node: XmlNode = { local: tag.local, uri: tag.uri, attrs: Object.values(tag.attributes), children: [] }
    if (stack.length) stack[stack.length - 1].children.push(node)
    else root = node
    stack.push(node)
  })
  const addText = (value: string): void => { if (stack.length) stack[stack.length - 1].children.push(value) }
  parser.on('text', addText); parser.on('cdata', addText)
  parser.on('closetag', () => { stack.pop() })
  for (let offset = 0; offset < source.length; offset += 65_536) {
    signal?.throwIfAborted(); parser.write(source.slice(offset, offset + 65_536))
  }
  parser.close()
  if (!root) throw new Error(`Office XML 为空：${name}`)
  return root
}

/** OPC targets are package URI paths, never filesystem paths or fetch URLs. */
function partTarget(from: string, target: string): string {
  let decoded: string
  try { decoded = decodeURIComponent(target) } catch { throw new Error('Office 关系包含无效的路径编码') }
  if (!decoded || /[\\\u0000?#]/u.test(decoded) || /^[a-z][a-z\d+.-]*:/iu.test(decoded) || decoded.startsWith('//')) throw new Error('Office 关系不是可读取的包内路径')
  const resolved = path.posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(path.posix.dirname(from), decoded))
  if (!resolved || resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) throw new Error('Office 关系路径越出文档包')
  return resolved
}

interface Relationship { id: string; type: string; target: string; external: boolean }
class OfficePackage {
  private readBytes = 0
  private constructor(private readonly archive: ProjectArchive, private readonly signal?: AbortSignal) {}
  static async open(buffer: Buffer, signal?: AbortSignal): Promise<OfficePackage> {
    signal?.throwIfAborted()
    if (buffer.length > 20 * MB) throw new Error('Office 文件超过本次只读提取的 20MB 限制')
    const refusal = preflightZip(buffer, 5000, 128 * MB, 32 * MB, 200)
    if (refusal) throw new Error(`Office ZIP 预检拒绝：${refusal}`)
    // The same validated central/local-header index and bounded inflater used
    // by project ZIP reads. Indexing never inflates media or unrelated XML.
    return new OfficePackage(await indexProjectArchive(buffer, signal), signal)
  }
  async xml(name: string): Promise<XmlNode> {
    this.signal?.throwIfAborted()
    const entry = this.archive.entries.find(item => item.name === name)
    if (!entry) throw new Error(`Office 文档缺少引用的 XML 条目：${name}`)
    if (entry.size > MAX_XML_PART || this.readBytes + entry.size > MAX_XML_TOTAL) throw new Error('Office XML 展开大小超过读取限制')
    const bytes = await readArchiveEntryBytes(this.archive, name, this.signal)
    this.readBytes += bytes.length
    if (bytes.length > MAX_XML_PART || this.readBytes > MAX_XML_TOTAL) throw new Error('Office XML 实际展开大小超过读取限制')
    return parseXml(bytes, name, this.signal)
  }
  async relationships(part: string): Promise<Relationship[]> {
    const name = part ? path.posix.join(path.posix.dirname(part), '_rels', path.posix.basename(part) + '.rels') : '_rels/.rels'
    const root = await this.xml(name)
    if (root.local !== 'Relationships' || root.uri !== PACKAGE_REL_NS) throw new Error(`Office 关系文件无效：${name}`)
    const seen = new Set<string>()
    return root.children.filter((node): node is XmlNode => typeof node !== 'string' && node.local === 'Relationship' && node.uri === PACKAGE_REL_NS).map(node => {
      const id = attr(node, 'Id'), type = attr(node, 'Type'), target = attr(node, 'Target')
      if (!id || !type || !target || seen.has(id)) throw new Error(`Office 关系标识缺失或重复：${name}`)
      seen.add(id)
      return { id, type, target, external: attr(node, 'TargetMode') === 'External' }
    })
  }
  resolve(from: string, relation: Relationship | undefined, kind: string): string {
    if (!relation || !relation.type.endsWith('/' + kind)) throw new Error(`Office 文档缺少正确的 ${kind} 关系`)
    if (relation.external) throw new Error(`Office ${kind} 指向外部内容，未访问或加载`)
    return partTarget(from, relation.target)
  }
  async main(format: 'xlsx' | 'pptx'): Promise<string> {
    const relations = await this.relationships('')
    const mains = relations.filter(relation => relation.type.endsWith('/officeDocument'))
    if (mains.length !== 1) throw new Error('Office 文档的主部件关系缺失或不唯一')
    const main = this.resolve('', mains[0], 'officeDocument')
    const types = await this.xml('[Content_Types].xml')
    if (types.local !== 'Types' || types.uri !== CONTENT_NS) throw new Error('Office 文档类型声明无效')
    const declaration = types.children.find((node): node is XmlNode => typeof node !== 'string' && node.local === 'Override' && node.uri === CONTENT_NS && partTarget('', attr(node, 'PartName') ?? '') === main)
    if (!declaration || attr(declaration, 'ContentType') !== MAIN_TYPES[format]) throw new Error(`文档不是标准 .${format}；不读取旧版二进制或宏格式`)
    return main
  }
}

class Output {
  text = ''
  truncated = false
  constructor(private readonly limit: number) {}
  add(value: string): void {
    const available = this.limit - this.text.length
    if (value.length > available) {
      this.text += value.slice(0, Math.max(0, available)).replace(/[\uD800-\uDBFF]$/u, '')
      this.truncated = true
    } else this.text += value
  }
  line(value: string): void { this.add(value + '\n') }
}

/** OOXML spreadsheet escapes are decoded once, including escaped underscores. */
const excelString = (value: string): string => value.replace(/_x([\da-f]{4})_/giu, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
function richString(node: XmlNode): string {
  const visit = (item: XmlNode): string => {
    if (is(item, 'rPh', SHEET_NS)) return '' // phonetic guides are not repeated cell text
    if (is(item, 't', SHEET_NS)) return text(item)
    return item.children.map(child => typeof child === 'string' ? '' : visit(child)).join('')
  }
  return excelString(visit(node))
}
function cellPosition(value: string): { column: number; row: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/u.exec(value)
  const column = match ? [...match[1]].reduce((number, ch) => number * 26 + ch.charCodeAt(0) - 64, 0) : 0
  const row = match ? Number(match[2]) : 0
  if (!column || column > 16384 || row > 1048576) throw new Error(`工作表单元格位置无效：${value}`)
  return { column, row }
}
function columnName(column: number): string {
  let name = ''
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name
  return name
}

async function extractWorkbook(pkg: OfficePackage, output: Output): Promise<void> {
  const part = await pkg.main('xlsx'), workbook = await pkg.xml(part)
  if (!is(workbook, 'workbook', SHEET_NS)) throw new Error('Excel 主部件不是工作簿')
  const relations = await pkg.relationships(part), stringsRelation = relations.find(relation => relation.type.endsWith('/sharedStrings'))
  let strings: string[] = []
  if (stringsRelation) {
    const shared = await pkg.xml(pkg.resolve(part, stringsRelation, 'sharedStrings'))
    if (!is(shared, 'sst', SHEET_NS)) throw new Error('Excel 共享字符串表无效')
    strings = children(shared, 'si', SHEET_NS).map(richString)
  }
  output.line('【XLSX 只读提取】位置为工作表名!单元格；保留原始值，不应用日期/数值显示格式，不计算公式或加载外部链接。未列出的稀疏单元格不展开。')
  const sheets = children(workbook, 'sheets', SHEET_NS)[0]
  if (!sheets) throw new Error('Excel 缺少工作表清单')
  for (const sheet of children(sheets, 'sheet', SHEET_NS)) {
    if (output.truncated) break
    const name = attr(sheet, 'name'), relationId = attr(sheet, 'id', REL_ATTR_NS)
    if (!name || !relationId) throw new Error('Excel 工作表名称或关系标识缺失')
    const worksheet = await pkg.xml(pkg.resolve(part, relations.find(relation => relation.id === relationId), 'worksheet'))
    if (!is(worksheet, 'worksheet', SHEET_NS)) throw new Error('Excel 工作表部件无效')
    output.line(`【工作表 ${JSON.stringify(name)}】${attr(sheet, 'state') && attr(sheet, 'state') !== 'visible' ? '（隐藏）' : ''}`)
    let lastRow = 0, cellCount = 0
    const seen = new Set<string>(), data = children(worksheet, 'sheetData', SHEET_NS)[0]
    for (const row of data ? children(data, 'row', SHEET_NS) : []) {
      if (output.truncated) break
      const cells = children(row, 'c', SHEET_NS), rawRow = attr(row, 'r'), firstReference = cells[0] ? attr(cells[0], 'r') : undefined
      const rowNumber = rawRow === undefined ? (firstReference ? cellPosition(firstReference).row : lastRow + 1) : Number(rawRow)
      if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rowNumber > 1048576) throw new Error('Excel 行位置无效')
      lastRow = rowNumber
      let lastColumn = 0
      for (const cell of cells) {
        if (output.truncated) break
        const reference = attr(cell, 'r') ?? `${columnName(lastColumn + 1)}${rowNumber}`, position = cellPosition(reference)
        if (position.row !== rowNumber || seen.has(reference)) throw new Error(`Excel 单元格位置矛盾或重复：${reference}`)
        seen.add(reference); lastColumn = position.column; cellCount++
        const type = attr(cell, 't'), valueNode = children(cell, 'v', SHEET_NS)[0], formula = children(cell, 'f', SHEET_NS)[0]
        const raw = valueNode ? text(valueNode) : ''
        let value: string
        if (type === 's' && valueNode) {
          if (!/^\d+$/u.test(raw) || Number(raw) >= strings.length) throw new Error(`Excel 共享字符串索引无效：${reference}`)
          value = JSON.stringify(strings[Number(raw)])
        } else if (type === 'inlineStr') {
          const inline = children(cell, 'is', SHEET_NS)[0]
          value = JSON.stringify(inline ? richString(inline) : '')
        } else if (type === 'b' && valueNode) {
          if (raw !== '0' && raw !== '1') throw new Error(`Excel 布尔值无效：${reference}`)
          value = raw === '1' ? 'TRUE' : 'FALSE'
        } else if (type === 'e') value = `单元格错误：${raw}`
        else if (type === 'str') value = JSON.stringify(excelString(raw))
        else value = valueNode ? raw : '（空）'
        const formulaText = formula ? text(formula) : ''
        output.line(`【${JSON.stringify(name)}!${reference}】${formula ? `公式：${formulaText ? JSON.stringify('=' + formulaText) : '共享或数组公式（本单元格未存储公式文本）'}；缓存结果（未重算，可能过期）：${valueNode ? value : '未提供'}` : value}`)
      }
    }
    if (!cellCount) output.line('（没有存储的单元格正文）')
  }
}

function slideParagraph(node: XmlNode): string {
  return node.children.map(child => {
    if (typeof child === 'string') return ''
    if (is(child, 'br', DRAWING_NS)) return '\n'
    if (is(child, 't', DRAWING_NS)) return text(child)
    return slideParagraph(child)
  }).join('')
}
async function extractSlides(pkg: OfficePackage, output: Output): Promise<void> {
  const part = await pkg.main('pptx'), presentation = await pkg.xml(part)
  if (!is(presentation, 'presentation', SLIDE_NS)) throw new Error('PowerPoint 主部件不是演示文稿')
  const relations = await pkg.relationships(part), list = children(presentation, 'sldIdLst', SLIDE_NS)[0]
  output.line('【PPTX 只读提取】按演示文稿的幻灯片顺序及页内文本对象顺序提取；不含备注、图表源数据或图片 OCR。')
  if (!list) throw new Error('PowerPoint 缺少幻灯片顺序清单')
  let index = 0
  for (const item of children(list, 'sldId', SLIDE_NS)) {
    if (output.truncated) break
    const relationId = attr(item, 'id', REL_ATTR_NS)
    const slide = await pkg.xml(pkg.resolve(part, relations.find(relation => relation.id === relationId), 'slide'))
    if (!is(slide, 'sld', SLIDE_NS)) throw new Error('PowerPoint 幻灯片部件无效')
    output.line(`【幻灯片 ${++index}】${attr(slide, 'show') === '0' ? '（隐藏）' : ''}`)
    let paragraph = 0
    for (const node of descendants(slide)) {
      if (output.truncated) break
      if (!is(node, 'p', DRAWING_NS)) continue
      const value = slideParagraph(node)
      if (value.trim()) output.line(`【幻灯片 ${index}·段落 ${++paragraph}】${JSON.stringify(value)}`)
    }
    if (!paragraph) output.line('（没有可提取的幻灯片正文；未执行 OCR）')
  }
}

/** Both attachment import and read_file use this bounded, offline extractor.
 * It returns stored text/positions only: no Office process, macros, formula
 * evaluation, external relationship loading, OCR or filesystem writes. */
export async function extractOfficeText(buffer: Buffer, format: 'xlsx' | 'pptx', options: OfficeTextOptions = {}): Promise<OfficeTextResult> {
  options.signal?.throwIfAborted()
  const limit = options.maxChars ?? 300_000
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) throw new Error('Office 提取字符上限必须为 1 到 1000000')
  const pkg = await OfficePackage.open(buffer, options.signal), output = new Output(limit)
  if (format === 'xlsx') await extractWorkbook(pkg, output)
  else if (format === 'pptx') await extractSlides(pkg, output)
  else throw new Error('仅支持 .xlsx 与 .pptx 的只读文本提取')
  return { text: output.text, truncated: output.truncated }
}
