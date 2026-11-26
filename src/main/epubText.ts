import path from 'node:path'
import { SaxesParser, type SaxesTagNS } from 'saxes'
import { indexProjectArchive, readArchiveEntryBytes } from './projectArchive'

const OPF = 'http://www.idpf.org/2007/opf'
const CONTAINER = 'urn:oasis:names:tc:opendocument:xmlns:container'
const XHTML = 'http://www.w3.org/1999/xhtml'
const MB = 1024 * 1024

function attribute(tag: SaxesTagNS, name: string): string | undefined {
  return Object.values(tag.attributes).find(value => value.local === name && !value.uri)?.value
}
function parseXml(bytes: Buffer, name: string, handlers: { root: { local: string; namespaces: string[] }; open?: (tag: SaxesTagNS) => void; close?: (tag: SaxesTagNS) => void; text?: (value: string) => void }, signal?: AbortSignal): void {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0x3c && bytes[1] === 0 ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c ? 'utf-16be' : 'utf-8'
  const source = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  const parser = new SaxesParser({ xmlns: true, fileName: name })
  // Common XHTML entities are constants, never fetched from an external DTD.
  Object.assign(parser.ENTITIES, { nbsp: '\u00a0', copy: '©', reg: '®', mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', trade: '™', euro: '€', laquo: '«', raquo: '»' })
  let depth = 0, count = 0
  parser.on('doctype', declaration => { if (declaration.includes('[')) throw new Error('EPUB 不读取自定义实体声明或外部实体') })
  parser.on('error', error => { throw new Error(`EPUB XML 无效（${name}）：${error.message}`) })
  parser.on('opentag', tag => {
    if (++depth > 128 || ++count > 200_000) throw new Error('EPUB XML 结构超过读取上限')
    if (depth === 1 && (tag.local !== handlers.root.local || !handlers.root.namespaces.includes(tag.uri))) throw new Error(`EPUB ${name} 的 XML 主元素或命名空间不正确`)
    handlers.open?.(tag)
  })
  parser.on('closetag', tag => { handlers.close?.(tag); depth-- })
  parser.on('text', value => handlers.text?.(value)); parser.on('cdata', value => handlers.text?.(value))
  for (let start = 0; start < source.length; start += 65536) { signal?.throwIfAborted(); parser.write(source.slice(start, start + 65536)) }
  parser.close()
}
function packagePath(from: string, href: string): string {
  let decoded: string
  try { decoded = decodeURIComponent(href.split('#')[0]) } catch { throw new Error('EPUB 正文路径编码无效') }
  if (!decoded || /[\\\u0000?]/u.test(decoded) || decoded.startsWith('/') || /^[a-z][a-z\d+.-]*:/iu.test(decoded)) throw new Error('EPUB 正文指向外部或不安全路径，未访问')
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), decoded))
  if (target === '..' || target.startsWith('../')) throw new Error('EPUB 正文路径越出压缩包，未访问')
  return target
}

function xhtmlBody(bytes: Buffer, name: string, signal?: AbortSignal): string {
  const blocks = new Set(['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote', 'pre'])
  const excluded = new Set(['script', 'style', 'head', 'noscript', 'svg'])
  const parts: string[] = []
  let depth = 0, body = 0, skip = 0, pre = 0
  parseXml(bytes, name, {
    root: { local: 'html', namespaces: [XHTML, ''] },
    open(tag) {
      depth++
      if (body && !skip && excluded.has(tag.local)) { skip = depth; return }
      if (tag.uri !== XHTML && tag.uri !== '') return
      if (tag.local === 'body') body = depth
      if (!body || skip) return
      if (excluded.has(tag.local) || attribute(tag, 'hidden') !== undefined || attribute(tag, 'aria-hidden') === 'true') { skip = depth; return }
      if (tag.local === 'pre') pre = depth
      if (tag.local === 'br' || blocks.has(tag.local)) parts.push('\n')
      if (tag.local === 'td' || tag.local === 'th') parts.push('\t')
    },
    close(tag) {
      if (body && !skip && (tag.uri === XHTML || tag.uri === '') && blocks.has(tag.local)) parts.push('\n')
      if (depth === skip) skip = 0
      if (depth === pre) pre = 0
      if (depth === body) body = 0
      depth--
    },
    text(value) { if (body && !skip) parts.push(pre ? value : value.replace(/[ \r\n\t]+/gu, ' ')) }
  }, signal)
  return parts.join('').replace(/[ \t]+\n/gu, '\n').replace(/\n[ \t]+/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/** OCF container -> OPF spine -> referenced XHTML, using the shared bounded
 * ZIP reader. Images, scripts and external resources are never opened. */
export async function extractEpubText(buffer: Buffer, maxChars = 300_000, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  signal?.throwIfAborted()
  const archive = await indexProjectArchive(buffer, signal)
  let total = 0
  const read = async (name: string): Promise<Buffer> => {
    const entry = archive.entries.find(item => item.name === name)
    if (!entry || entry.size + total > 32 * MB) throw new Error('EPUB 缺少引用的正文或累计读取超过32MB')
    const bytes = await readArchiveEntryBytes(archive, name, signal)
    total += bytes.length
    return bytes
  }
  if ((await read('mimetype')).toString('utf8').trim() !== 'application/epub+zip') throw new Error('不是具有有效 mimetype 的 EPUB 文件')
  const rootfiles: string[] = []
  parseXml(await read('META-INF/container.xml'), 'META-INF/container.xml', { root: { local: 'container', namespaces: [CONTAINER] }, open(tag) {
    if (tag.uri === CONTAINER && tag.local === 'rootfile' && attribute(tag, 'media-type') === 'application/oebps-package+xml') {
      const target = attribute(tag, 'full-path'); if (target) rootfiles.push(packagePath('', target))
    }
  } }, signal)
  if (!rootfiles.length) throw new Error('EPUB container.xml 没有可读取的 OPF 主文档')
  const main = rootfiles[0], manifest = new Map<string, { href: string; type: string }>(), spine: Array<{ id: string; supplemental: boolean }> = []
  parseXml(await read(main), main, { root: { local: 'package', namespaces: [OPF] }, open(tag) {
    if (tag.uri !== OPF) return
    if (tag.local === 'item') {
      const id = attribute(tag, 'id'), href = attribute(tag, 'href'), type = attribute(tag, 'media-type')
      if (!id || !href || !type || manifest.has(id)) throw new Error('EPUB manifest 条目缺失或重复')
      manifest.set(id, { href, type })
    }
    if (tag.local === 'itemref') {
      const id = attribute(tag, 'idref'); if (!id) throw new Error('EPUB spine 缺少正文引用')
      spine.push({ id, supplemental: attribute(tag, 'linear') === 'no' })
    }
  } }, signal)
  if (!spine.length) throw new Error('EPUB 缺少 spine 正文阅读顺序，未猜测章节排序')
  let text = '', truncated = false, readable = false
  const add = (value: string): void => {
    if (text.length + value.length > maxChars) { text += value.slice(0, Math.max(0, maxChars - text.length)).replace(/[\uD800-\uDBFF]$/u, ''); truncated = true }
    else text += value
  }
  add('【EPUB 正文】按 OPF spine 顺序；章节标识为包内路径，不是排版页码。不执行脚本、不加载外部资源、不做图片 OCR。\n')
  for (const [index, item] of spine.entries()) {
    if (truncated) break
    const entry = manifest.get(item.id)
    if (!entry) throw new Error('EPUB spine 引用了缺失的正文条目')
    if (!['application/xhtml+xml', 'text/html'].includes(entry.type)) throw new Error(`EPUB 主正文类型 ${entry.type} 尚不支持；未把图片或扫描件当作已读`)
    const target = packagePath(main, entry.href), body = xhtmlBody(await read(target), target, signal)
    readable ||= Boolean(body.trim())
    add(`\n【EPUB 章节 ${index + 1}：${JSON.stringify(target)}】${item.supplemental ? '（补充内容）' : ''}\n${body || '（本章无可提取正文；未执行 OCR）'}\n`)
  }
  if (!readable && !truncated) throw new Error('EPUB 没有可提取正文，可能为图片内容；本工具不做 OCR，不能据此判断没有内容')
  return { text, truncated }
}
