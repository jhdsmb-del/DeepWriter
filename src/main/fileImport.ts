import { promises as fs } from 'fs'
import * as path from 'path'
import type { ImportedFileInfo } from '../shared/types'
import { preflightZip } from './archiveSafety'
import { indexProjectArchive, previewProjectArchive, PROJECT_ZIP_MAX_BYTES } from './projectArchive'
import { extractOfficeText } from './officeText'
import { extractEpubText } from './epubText'
import { extractPdfText } from './pdfText'
import { isProjectTextName } from '../shared/fileFormats'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const ONE_MB = 1024 * 1024
const LIMIT_ALL = 200 * ONE_MB
const LIMIT_TEXT = 20 * ONE_MB
const LIMIT_DOC = 100 * ONE_MB
const LIMIT_EPUB = 50 * ONE_MB
const EPUB_MAX_ENTRIES = 500

export { preflightZip } from './archiveSafety'

async function decodeLegacy(buf: Buffer, encoding: string): Promise<string> {
  const mod = await import('iconv-lite')
  return (mod.default ?? mod).decode(buf, encoding)
}

async function decodeText(buf: Buffer): Promise<{ text: string; source: 'utf8' | 'gbk' }> {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf-8'), source: 'utf8' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: await decodeLegacy(buf.subarray(2), 'utf16le'), source: 'utf8' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: await decodeLegacy(buf.subarray(2), 'utf16be'), source: 'utf8' }
  }
  const utf8 = buf.toString('utf-8')
  let bad = 0
  for (const ch of utf8) {
    if (ch === '\uFFFD') bad++
  }
  if (bad / Math.max(utf8.length, 1) > 0.005) {
    return { text: await decodeLegacy(buf, 'gbk'), source: 'gbk' }
  }
  return { text: utf8, source: 'utf8' }
}

async function extractDocx(buf: Buffer, maxUncompressed?: number): Promise<string> {
  if (maxUncompressed !== undefined) {
    const refusal = preflightZip(buf, EPUB_MAX_ENTRIES, maxUncompressed, maxUncompressed)
    if (refusal) throw new Error(`DOCX 预检拒绝：${refusal}`)
  }
  const mod: any = await import('mammoth')
  const mammoth = mod.default ?? mod
  const res = await mammoth.extractRawText({ buffer: buf }, { externalFileAccess: false })
  return res?.value ?? ''
}

export async function importFile(
  filePath: string,
  maxChars = 300000,
  limits: { maxBytes?: number; docxMaxUncompressed?: number; signal?: AbortSignal } = {}
): Promise<{ ok: true; info: ImportedFileInfo } | { ok: false; error: string }> {
  let name: string
  let size: number
  try {
    name = path.basename(filePath)
    const st = await fs.stat(filePath)
    size = st.size
  } catch (e) {
    return { ok: false, error: `无法读取文件: ${(e as Error).message}` }
  }
  const ext = path.extname(name).toLowerCase()
  if (limits.maxBytes !== undefined && size > limits.maxBytes) return { ok: false, error: `文件超过本次读取的 ${Math.round(limits.maxBytes / ONE_MB)}MB 限制` }
  if (size > LIMIT_ALL) return { ok: false, error: '文件超过 200MB 限制' }
  if (isProjectTextName(name) && size > LIMIT_TEXT) return { ok: false, error: '文本文件超过 20MB 限制' }
  if ((ext === '.pdf' || ext === '.docx') && size > LIMIT_DOC) return { ok: false, error: '文件超过 100MB 限制' }
  if ((ext === '.xlsx' || ext === '.pptx') && size > LIMIT_TEXT) return { ok: false, error: 'Office 文件超过本次只读提取的 20MB 限制' }
  if (ext === '.zip' && size > PROJECT_ZIP_MAX_BYTES) return { ok: false, error: 'ZIP 超过 50MB 压缩文件限制' }
  if (ext === '.epub' && size > LIMIT_EPUB) return { ok: false, error: 'EPUB 超过 50MB 限制' }
  const maxBytes = /\.(zip|xlsx|pptx)$/i.test(ext) ? Math.min(ext === '.zip' ? PROJECT_ZIP_MAX_BYTES : LIMIT_TEXT, limits.maxBytes ?? PROJECT_ZIP_MAX_BYTES) : limits.maxBytes
  let buf: Buffer
  try {
    if (maxBytes === undefined) buf = await fs.readFile(filePath, { signal: limits.signal })
    else {
      const handle = await fs.open(filePath, 'r')
      try {
        const bytes = Buffer.alloc(Math.min(size + 1, maxBytes + 1))
        let loaded = 0
        while (loaded < bytes.length) {
          limits.signal?.throwIfAborted()
          const { bytesRead } = await handle.read(bytes, loaded, bytes.length - loaded, loaded)
          if (!bytesRead) break
          loaded += bytesRead
        }
        if (loaded > maxBytes || loaded > size) throw new Error('文件在读取时增长或超过本次读取上限，请重新读取')
        buf = bytes.subarray(0, loaded)
      } finally { await handle.close() }
    }
  } catch (e) {
    return { ok: false, error: `无法读取文件: ${(e as Error).message}` }
  }
  if (IMAGE_EXTS.has(ext)) {
    const text = `[图片素材: ${name}]（${size} 字节），模型无法直接查看图片内容。请注明用途（立绘/背景/UI）以便正确引用文件名。`
    return { ok: true, info: { name, path: filePath, size, text, truncated: false, source: 'image' } }
  }
  try {
    if (ext === '.zip') {
      const archive = await indexProjectArchive(buf, limits.signal)
      const preview = await previewProjectArchive(archive, maxChars, limits.signal)
      return { ok: true, info: { name, path: filePath, size, source: 'zip', ...preview } }
    }
    if (ext === '.xlsx' || ext === '.pptx') {
      const extracted = await extractOfficeText(buf, ext.slice(1) as 'xlsx' | 'pptx', { maxChars, signal: limits.signal })
      return { ok: true, info: { name, path: filePath, size, source: ext.slice(1) as 'xlsx' | 'pptx', ...extracted } }
    }
    if (ext === '.docx') {
      limits.signal?.throwIfAborted()
      const text = await extractDocx(buf, limits.docxMaxUncompressed)
      limits.signal?.throwIfAborted()
      return finish(name, filePath, size, text, maxChars, 'docx')
    }
    if (ext === '.pdf') {
      const { text, truncated } = await extractPdfText(buf, maxChars, limits.signal)
      return { ok: true, info: { name, path: filePath, size, source: 'pdf', text, truncated } }
    }
    if (ext === '.epub') {
      const extracted = await extractEpubText(buf, maxChars, limits.signal)
      return { ok: true, info: { name, path: filePath, size, source: 'epub', ...extracted } }
    }
    if (/\.(doc|xls|ppt|odt|ods|odp|rar|7z)$/i.test(ext)) return { ok: false, error: `暂不支持 ${ext} 二进制格式，未提取正文；请另存为支持的 DOCX/XLSX/PPTX 或纯文本后读取` }
    if (isProjectTextName(name) || (size < ONE_MB && !buf.includes(0))) {
      const dec = await decodeText(buf)
      return finish(name, filePath, size, dec.text, maxChars, dec.source)
    }
    return { ok: false, error: '不支持的格式或文件过大' }
  } catch (e) {
    return { ok: false, error: `解析失败: ${(e as Error).message}` }
  }
}

function finish(
  name: string,
  filePath: string,
  size: number,
  text: string,
  maxChars: number,
  source: ImportedFileInfo['source']
): { ok: true; info: ImportedFileInfo } {
  const truncated = text.length > maxChars
  return { ok: true, info: { name, path: filePath, size, text: truncated ? text.slice(0, maxChars) : text, truncated, source } }
}
