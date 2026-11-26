import { promises as fs } from 'node:fs'
import { importFile } from './fileImport'
import { readFileIdentity, type ReadPage, type ReadPageRequest } from './fileReadPage'
import { extractedTextPage } from './extractedTextPage'

const EXTRACTED_UNITS = 300_000
const INPUT_BYTES = 20 * 1024 * 1024
const UNCOMPRESSED_BYTES = 32 * 1024 * 1024

/** Document positions address extracted text, never layout coordinates. No disk
 * cache or generated sidecar is required, including in read-only plans. */
export async function extractDocumentText(file: string, signal?: AbortSignal): Promise<{ text: string; identity: string; cursorKind: 'd1' | 'o1'; truncated: boolean }> {
  signal?.throwIfAborted()
  if (!/\.(docx|xlsx|pptx|pdf|epub)$/i.test(file)) throw new Error('此文件不是支持正文提取的文档格式，未读取')
  const before = await fs.stat(file, { bigint: true })
  const office = /\.(xlsx|pptx)$/i.test(file)
  if (!before.isFile()) throw new Error('不是普通文档文件')
  const tag = readFileIdentity(before)
  const result = await importFile(file, EXTRACTED_UNITS, { maxBytes: INPUT_BYTES, docxMaxUncompressed: UNCOMPRESSED_BYTES, signal })
  signal?.throwIfAborted()
  if (!result.ok) {
    const error = new Error(result.error)
    if (/PDF 未提取到文字层/.test(result.error)) Object.assign(error, { code: 'document_text_unavailable' })
    throw error
  }
  if (readFileIdentity(await fs.stat(file, { bigint: true })) !== tag) throw new Error('文档在提取时已改变，请重新读取')
  // The established importer counts UTF-16 units. Keep any capped surrogate
  // whole before applying the same code-point page contract as read_file.
  const text = result.info.text.replace(/[\uD800-\uDBFF]$/, '')
  if (!text.trim()) throw Object.assign(new Error('文档没有可提取正文；不代表图片或扫描内容为空（本工具不做 OCR）'), { code: 'document_text_unavailable' })
  return { text, identity: tag, cursorKind: office ? 'o1' : 'd1', truncated: result.info.truncated }
}

export async function readDocumentPage(file: string, request: ReadPageRequest, signal?: AbortSignal, outputBudget?: number): Promise<ReadPage & { truncated: boolean }> {
  const document = await extractDocumentText(file, signal)
  return { ...extractedTextPage(document.text, request, document.identity, document.cursorKind, signal, outputBudget), truncated: document.truncated }
}
