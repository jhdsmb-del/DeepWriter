import { promises as fs } from 'node:fs'
import { createInflateRaw } from 'node:zlib'
import { createHash } from 'node:crypto'
import { isProjectTextName } from '../shared/fileFormats'
import { readFileIdentity, readOutputBudget, type ReadPageRequest } from './fileReadPage'
import { extractedTextPage } from './extractedTextPage'
import { sourceFromReadPage } from './fileEvidence'
import { basename, resolve } from 'node:path'
import type { FileSourceEvidence } from '../shared/fileEvidence'
import { zipCrc32 } from './archiveSafety'
export { zipCrc32 } from './archiveSafety'

export const PROJECT_ZIP_MAX_BYTES = 50 * 1024 * 1024
const MAX_ENTRIES = 10000, MAX_TOTAL = 256 * 1024 * 1024, MAX_ENTRY = 8 * 1024 * 1024
const MAX_RATIO = 200, PREVIEW_UNITS = 60000, PREVIEW_FILES = 12, PREVIEW_BYTES = 24 * 1024 * 1024
type Status = 'text' | 'directory' | 'binary' | 'encrypted' | 'unsupported' | 'oversized' | 'unsafe' | 'corrupt'
type Entry = { name: string; flags: number; method: number; crc: number; size: number; compressed: number; offset: number; data: number; status: Status; reason?: string }
export type ProjectArchive = { buffer: Buffer; entries: Entry[]; total: number }
const labels: Record<Status, string> = { text: '文本候选', directory: '目录', binary: '二进制/非文本格式', encrypted: '加密，未读取', unsupported: '不支持的压缩/链接', oversized: '过限，未读取', unsafe: '不安全/重名路径', corrupt: '损坏，未读取' }
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
async function legacyDecode(buffer: Buffer, encoding: string): Promise<string> {
  const mod = await import('iconv-lite')
  return (mod.default ?? mod).decode(buffer, encoding)
}
async function entryName(raw: Buffer, flags: number, extra: Buffer): Promise<string> {
  for (let pos = 0; pos + 4 <= extra.length;) {
    const id = extra.readUInt16LE(pos), size = extra.readUInt16LE(pos + 2)
    if (pos + 4 + size > extra.length) throw new Error('ZIP 条目附加字段损坏')
    if (id === 0x7075 && size >= 5 && extra[pos + 4] === 1 && extra.readUInt32LE(pos + 5) === zipCrc32(raw)) return utf8.decode(extra.subarray(pos + 9, pos + 4 + size))
    pos += 4 + size
  }
  if (flags & 0x800) return utf8.decode(raw)
  try { return utf8.decode(raw) } catch { /* Legacy Windows archives commonly use GBK. */ }
  const mod = await import('iconv-lite'), iconv = mod.default ?? mod, gbk = iconv.decode(raw, 'gbk')
  if (/[\u3400-\u9fff]/.test(gbk) && iconv.encode(gbk, 'gbk').equals(raw)) return gbk
  return iconv.decode(raw, 'cp437')
}

/** Index only the central directory. No archive entry is inflated by indexing,
 * and no extracted filename is ever passed to the filesystem. */
export async function indexProjectArchive(buffer: Buffer, signal?: AbortSignal): Promise<ProjectArchive> {
  signal?.throwIfAborted()
  if (buffer.length > PROJECT_ZIP_MAX_BYTES) throw new Error('ZIP 超过 50MB 压缩文件限制')
  let end = -1
  for (let p = buffer.length - 22; p >= Math.max(0, buffer.length - 65557); p--) {
    if (buffer.readUInt32LE(p) === 0x06054b50 && p + 22 + buffer.readUInt16LE(p + 20) === buffer.length) { end = p; break }
  }
  if (end < 0) throw new Error('ZIP 损坏：未找到完整中央目录尾记录')
  const count = buffer.readUInt16LE(end + 10), length = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16)
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count) throw new Error('不支持分卷 ZIP')
  if (count === 0xffff || length === 0xffffffff || start === 0xffffffff) throw new Error('不支持 ZIP64，请提供普通 ZIP')
  if (count > MAX_ENTRIES) throw new Error(`ZIP 条目过多（${count} > ${MAX_ENTRIES}），未扫描目录或正文`)
  if (start + length !== end) throw new Error('ZIP 损坏：中央目录位置/长度不符')
  const entries: Entry[] = [], names = new Map<string, Entry>()
  let pos = start, total = 0
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted()
    if (pos + 46 > end || buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('ZIP 中央目录条目损坏')
    const flags = buffer.readUInt16LE(pos + 8), method = buffer.readUInt16LE(pos + 10), crc = buffer.readUInt32LE(pos + 16)
    const compressed = buffer.readUInt32LE(pos + 20), size = buffer.readUInt32LE(pos + 24), nameLen = buffer.readUInt16LE(pos + 28)
    const extraLen = buffer.readUInt16LE(pos + 30), commentLen = buffer.readUInt16LE(pos + 32), offset = buffer.readUInt32LE(pos + 42)
    if (pos + 46 + nameLen + extraLen + commentLen > end || !nameLen) throw new Error('ZIP 中央目录名称/范围损坏')
    if ([compressed, size, offset].includes(0xffffffff) || buffer.readUInt16LE(pos + 34)) throw new Error('不支持 ZIP64 或分卷条目')
    total += size
    if (total > MAX_TOTAL) throw new Error('ZIP 声明解压总量超过 256MB，未解压正文；请缩小工程包')
    const raw = buffer.subarray(pos + 46, pos + 46 + nameLen), extra = buffer.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen)
    let name: string, status: Status = 'text', reason: string | undefined
    try { name = (await entryName(raw, flags, extra)).replaceAll('\\', '/') } catch { name = `[无效名称#${i + 1}]`; status = 'unsafe'; reason = '名称编码或附加字段无效' }
    if (name.length > 512 || !name || /[\x00-\x1f\x7f:]/.test(name) || name.startsWith('/') || name.split('/').some(s => s === '..' || s === '.')) { status = 'unsafe'; reason = '路径不安全或超过512字符' }
    else if (status === 'text') {
      if (flags & 0x41) status = 'encrypted'
      else if ((buffer.readUInt32LE(pos + 38) >>> 16 & 0xf000) === 0xa000 || ![0, 8].includes(method)) status = 'unsupported'
      else if (name.endsWith('/')) status = 'directory'
      else if (size > MAX_ENTRY || (method !== 0 && size > Math.max(1, compressed) * MAX_RATIO)) { status = 'oversized'; reason = size > MAX_ENTRY ? '单条目超过8MB' : '压缩比超过200x' }
      else if (!isProjectTextName(name)) status = 'binary'
    }
    const entry: Entry = { name, flags, method, crc, size, compressed, offset, data: 0, status, reason }
    const previous = names.get(name)
    if (previous) { previous.status = entry.status = 'unsafe'; previous.reason = entry.reason = '重复条目路径，不能唯一引用' }
    names.set(name, entry)
    // Even skipped entries are structurally checked, without reading payloads.
    if (offset + 30 > start || buffer.readUInt32LE(offset) !== 0x04034b50) { entry.status = 'corrupt'; entry.reason = '本地条目头损坏' }
    else {
      const localNameLen = buffer.readUInt16LE(offset + 26), localExtraLen = buffer.readUInt16LE(offset + 28)
      entry.data = offset + 30 + localNameLen + localExtraLen
      if (entry.data + compressed > start || buffer.readUInt16LE(offset + 6) !== flags || buffer.readUInt16LE(offset + 8) !== method
        || !buffer.subarray(offset + 30, offset + 30 + localNameLen).equals(raw)
        || (!(flags & 8) && (buffer.readUInt32LE(offset + 14) !== crc || buffer.readUInt32LE(offset + 18) !== compressed || buffer.readUInt32LE(offset + 22) !== size))) {
        entry.status = 'corrupt'; entry.reason = '本地头与中央目录不一致/越界'
      }
    }
    entries.push(entry); pos += 46 + nameLen + extraLen + commentLen
  }
  if (pos !== end) throw new Error('ZIP 中央目录条目数/长度不符')
  const ranges = entries.filter(e => e.status !== 'corrupt').slice().sort((a, b) => a.offset - b.offset)
  let covering: Entry | undefined, coveredEnd = 0
  for (const entry of ranges) {
    if (covering && entry.offset < coveredEnd) { entry.status = covering.status = 'corrupt'; entry.reason = covering.reason = '条目数据范围重叠' }
    if (entry.data + entry.compressed > coveredEnd) { covering = entry; coveredEnd = entry.data + entry.compressed }
  }
  return { buffer, entries, total }
}

async function inflateEntry(archive: ProjectArchive, entry: Entry, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  const input = archive.buffer.subarray(entry.data, entry.data + entry.compressed)
  const output = entry.method === 0 ? input : await new Promise<Buffer>((resolve, reject) => {
    const stream = createInflateRaw({ chunkSize: 32768 }), chunks: Buffer[] = []
    let size = 0
    const abort = () => stream.destroy(new Error('ZIP 读取已取消'))
    signal?.addEventListener('abort', abort, { once: true })
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_ENTRY || size > entry.size) stream.destroy(new Error('ZIP 实际解压大小超过条目声明或8MB限制'))
      else chunks.push(chunk)
    })
    stream.once('error', reject)
    stream.once('end', () => stream.bytesWritten !== input.length ? reject(new Error('ZIP 压缩数据含未消费内容')) : resolve(Buffer.concat(chunks, size)))
    stream.once('close', () => signal?.removeEventListener('abort', abort))
    stream.end(input)
  })
  signal?.throwIfAborted()
  if (output.length !== entry.size || zipCrc32(output) !== entry.crc) throw new Error('ZIP 条目损坏：实际大小或CRC校验不符')
  return output
}
export async function readArchiveEntry(archive: ProjectArchive, name: string, signal?: AbortSignal): Promise<string> {
  const entry = archive.entries.find(e => e.name === name)
  if (!entry) throw new Error('ZIP 没有该条目；请原样使用目录返回的 archive_entry 路径（区分大小写）')
  if (entry.status !== 'text') throw new Error(`ZIP 条目不可读：${labels[entry.status]}${entry.reason ? `（${entry.reason}）` : ''}`)
  const buffer = await readArchiveEntryBytes(archive, name, signal)
  let text: string
  if (buffer[0] === 0xff && buffer[1] === 0xfe) text = await legacyDecode(buffer.subarray(2), 'utf16le')
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) text = await legacyDecode(buffer.subarray(2), 'utf16be')
  else {
    if (buffer.includes(0)) throw new Error('ZIP 条目实际包含二进制NUL，未作为文本读取')
    try { text = utf8.decode(buffer) } catch {
      const mod = await import('iconv-lite'), iconv = mod.default ?? mod
      text = iconv.decode(buffer, 'gb18030')
      if (!iconv.encode(text, 'gb18030').equals(buffer)) throw new Error('ZIP 条目不是有效UTF-8/GB18030文本，请转换编码')
    }
  }
  if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new Error('ZIP 条目含二进制控制字符，未作为文本读取')
  return text
}
/** Office importers may name their own XML/.rels parts. Binary candidates are
 * allowed here only: their explicit caller interprets bytes; generic project
 * text reading still rejects them. All structural/size/CRC gates stay shared. */
export async function readArchiveEntryBytes(archive: ProjectArchive, name: string, signal?: AbortSignal): Promise<Buffer> {
  const entry = archive.entries.find(e => e.name === name)
  if (!entry) throw new Error('ZIP 没有指定条目')
  if (entry.status !== 'text' && entry.status !== 'binary') throw new Error(`ZIP 条目不可读：${labels[entry.status]}${entry.reason ? `（${entry.reason}）` : ''}`)
  return inflateEntry(archive, entry, signal)
}
function summary(archive: ProjectArchive): string {
  const counts = new Map<Status, number>()
  for (const entry of archive.entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1)
  return `ZIP 工程目录：${archive.entries.length}条，声明解压${archive.total}字节；${Array.from(counts, ([status, n]) => `${labels[status]}${n}条`).join('；')}。\n仅按需读文本，不落地解压/不执行/不递归解析压缩包。文本候选未读前不保证可解码或校验通过。限制：压缩≤50MB、目录≤10000条、总声明≤256MB、单条文本≤8MB、压缩比≤200x。`
}
const listingLine = (entry: Entry) => `${JSON.stringify(entry.name)} ${entry.size}字节 [${labels[entry.status]}${entry.reason ? `：${entry.reason}` : ''}]`
const priority = (name: string): number => /(^|\/)readme(?:\.|$)/i.test(name) ? 0 : /(^|\/)(package\.json|cargo\.toml|pyproject\.toml|go\.mod|cmakelists\.txt)$/i.test(name) ? 1 : 2
/** Selection grants the archive, not an instruction to paste its credentials
 * into every prompt. An explicitly named member remains a separate read. */
const sensitivePath = (name: string): boolean => /(^|\/)(?:\.git|\.svn|\.hg|\.ssh|\.aws|\.azure|\.kube)(?:\/|$)/i.test(name)
  || /(^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]*(?:credentials|secrets|service[-_]account)[^/]*)(?:\/|$)/i.test(name)
  || /\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(name)
const credentialText = (text: string): boolean => /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text)
  || /\bAKIA[0-9A-Z]{16}\b/.test(text)
  || /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[=:]\s*["'](?:sk-[\w-]{12,}|[^"'\s]{20,})["']/i.test(text)

/** Bounded attachment representation: paths and actual source excerpts, never
 * an apparently complete dump. Its coverage warning travels with the text. */
export async function previewProjectArchive(archive: ProjectArchive, maxChars = PREVIEW_UNITS, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const budget = Math.min(PREVIEW_UNITS, Math.max(1, Math.floor(maxChars))), ordered = archive.entries.slice().sort((a, b) => priority(a.name) - priority(b.name))
  if (budget < 2000) return { text: 'ZIP预览预算不足；正文/目录尚未读取，请增大预览预算或在工作区指定archive_entry分页读取。'.slice(0, budget), truncated: true }
  const protectedCount = archive.entries.filter(entry => sensitivePath(entry.name) && entry.status === 'text').length
  const parts = [summary(archive), `自动取材不读取凭据/版本库等敏感路径（${protectedCount}个文本候选）；若确需此类条目，请明确点名读取，不把自动跳过视为内容为空。`, '目录预览（最多80条；条目路径用于引用）：']
  let shown = 0, catalogUnits = 0
  for (const entry of ordered.slice(0, 80)) {
    const line = listingLine(entry) + (sensitivePath(entry.name) ? ' [敏感路径，不自动摘录]' : '')
    if (catalogUnits + line.length > Math.min(8000, budget / 4)) break
    parts.push(line); catalogUnits += line.length; shown++
  }
  let used = parts.join('\n').length, read = 0, bytes = 0, partial = 0, failed = 0, protectedContent = 0
  for (const entry of ordered) {
    signal?.throwIfAborted()
    if (entry.status !== 'text' || sensitivePath(entry.name)) continue
    if (read >= PREVIEW_FILES || used > budget - 1200 || bytes + entry.size > PREVIEW_BYTES) break
    bytes += entry.size; read++
    try {
      const text = await readArchiveEntry(archive, entry.name, signal)
      if (credentialText(text)) { protectedContent++; parts.push(`条目 ${JSON.stringify(entry.name)} 含潜在凭据，未自动摘录正文；如需读取请明确点名。`); used = parts.join('\n').length; continue }
      const page = extractedTextPage(text, { max_chars: Math.min(6000, Math.floor((budget - used - 1000) / 2)), line_count: 100 }, 'preview', 'z1', signal)
      const chunk = `\n--- ZIP条目 ${JSON.stringify(entry.name)}；文本范围 [${page.first}:${page.firstColumn}, ${page.endLine}:${page.endColumn})${page.cursor ? '；此条目仅摘录，后续未读' : '；此条目全文'} ---\n${page.text}`
      if (page.cursor) partial++
      parts.push(chunk); used += chunk.length
    } catch (error) { signal?.throwIfAborted(); failed++; const line = `条目 ${JSON.stringify(entry.name)} 读取失败：${(error as Error).message}`; parts.push(line); used += line.length }
  }
  const candidates = archive.entries.filter(e => e.status === 'text').length, truncated = archive.entries.length > shown || read < candidates || partial > 0 || failed > 0 || protectedContent > 0
  parts.push(`\n读取覆盖：尝试${read}/${candidates}个文本候选；失败${failed}条；敏感路径跳过${protectedCount}条、潜在凭据正文跳过${protectedContent}条；正文仅摘录${partial}条；目录显示${shown}/${archive.entries.length}条。${truncated ? '并未读完整包，未展示部分不能据此判断不存在。' : '以上列出的可读文本已读完；跳过类型仍未读取。'}可用 read_file(path=当前附件提供的path或工作区ZIP路径, archive_entry=条目原路径) 按行/列或cursor续读；不指定archive_entry时分页列目录。`)
  const text = parts.join('\n')
  // Never chop off the coverage warning. For very small requested previews,
  // return a summary plus explicit truncation, rather than half a source quote.
  return text.length <= budget ? { text, truncated } : { text: `${summary(archive)}\n预览预算不足，正文和目录未完整展示；请在工作区指定 archive_entry 分页读取。`, truncated: true }
}

export async function readProjectArchiveResult(file: string, request: ReadPageRequest & { archive_entry?: unknown }, signal?: AbortSignal, expectedSha256?: string,
  sourcePath = resolve(file), displayName = basename(file), outputBudget?: number): Promise<{ ok: boolean; message: string; sources?: FileSourceEvidence[] }> {
  signal?.throwIfAborted()
  const before = await fs.stat(file, { bigint: true }), tag = readFileIdentity(before)
  if (!before.isFile() || before.size > BigInt(PROJECT_ZIP_MAX_BYTES)) throw new Error('ZIP 必须是≤50MB的普通文件')
  const handle = await fs.open(file, 'r')
  let buffer: Buffer
  try {
    const cap = Number(before.size), bytes = Buffer.alloc(cap + 1)
    let offset = 0
    while (offset < bytes.length) {
      signal?.throwIfAborted()
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    if (offset !== cap) throw new Error('ZIP 在读取时改变，请重新读取')
    buffer = bytes.subarray(0, offset)
  } finally { await handle.close() }
  if (expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/i.test(expectedSha256) || createHash('sha256').update(buffer).digest('hex') !== expectedSha256.toLowerCase())) throw new Error('ZIP附件内容与本任务保存的版本不符，请重新选择附件并发起任务')
  const archive = await indexProjectArchive(buffer, signal)
  let result: string, sources: FileSourceEvidence[] = []
  if (request.archive_entry !== undefined) {
    if (typeof request.archive_entry !== 'string' || !request.archive_entry || request.archive_entry.length > 512) throw new Error('archive_entry 必须是目录返回的条目原路径')
    const name = request.archive_entry, index = archive.entries.findIndex(entry => entry.name === name)
    const text = await readArchiveEntry(archive, name, signal), page = extractedTextPage(text, request, `${tag}.${index.toString(36)}`, 'z1', signal, outputBudget)
    if (page.budgetLimited) return { ok: false, message: `read_input_budget_insufficient：本次未展示ZIP条目 ${JSON.stringify(name)}（${JSON.stringify(displayName)}）的正文。原定位 ${page.first}:${page.firstColumn}；请精确定位/缩小本次输入或使用更大窗口后重读，不自动重复同一续读。` }
    sources = sourceFromReadPage({ path: sourcePath, displayName: basename(displayName), kind: 'zip_entry', archive_entry: name, page })
    result = `ZIP条目 ${JSON.stringify(name)}（来源 ${JSON.stringify(displayName)}）；仅条目解码文本，行列从1按Unicode码点，LF换行；不是压缩包偏移或文档页码。\n文本范围 [${page.first}:${page.firstColumn}, ${page.endLine}:${page.endColumn})；${page.budgetLimited ? '本次模型输入预算不足，正文未展示；' : ''}${page.cursor ? `尚未读完，续读时保留archive_entry并用 cursor=${page.cursor}` : '该条目文本已读完（不代表整包已读完）'}\n${page.text}`
  } else {
    if (request.start_line !== undefined || request.start_column !== undefined) throw new Error('ZIP目录不使用文本行列；先指定 archive_entry 再按行列读取')
    let start = 0
    if (request.cursor !== undefined) {
      const match = typeof request.cursor === 'string' && request.cursor.length <= 200 ? /^zl1:([0-9a-z.\-]+):(\d{1,5})$/.exec(request.cursor) : null
      if (!match) throw new Error('ZIP目录cursor无效；条目续读须保留 archive_entry')
      if (match[1] !== tag) throw new Error('ZIP已改变或不是上一页的压缩包，请重新读取目录')
      start = Number(match[2])
      if (start >= archive.entries.length) throw new Error('ZIP目录cursor超出条目范围')
    }
    const requested = typeof request.max_chars === 'number' && Number.isSafeInteger(request.max_chars) && request.max_chars > 0 ? Math.min(10000, request.max_chars) : 10000
    const lines: string[] = [], limit = outputBudget === undefined ? requested : Math.min(requested, readOutputBudget(outputBudget))
    let end = start, used = 0
    while (end < archive.entries.length && end - start < 100) {
      const line = listingLine(archive.entries[end]), cost = JSON.stringify(line).length
      if (used + cost > limit && (end > start || outputBudget !== undefined)) break
      lines.push(line); used += cost; end++
    }
    if (end === start && archive.entries.length) return { ok: false, message: `read_input_budget_insufficient：本次未展示ZIP目录条目（共${archive.entries.length}项，起点第${start + 1}项）。需要缩小本次输入或使用更大窗口；不能据此判断没有文件，未自动重复续读。` }
    result = `${summary(archive)}\n目录条目 ${archive.entries.length ? end > start ? `${start + 1}-${end}/${archive.entries.length}` : `本页0/${archive.entries.length}（模型输入预算不足，条目未展示）` : '0/0（空包）'}（仅目录，不是正文）。\n${lines.join('\n')}\n${end < archive.entries.length ? `目录尚未列完，续列 cursor=zl1:${tag}:${end}` : '目录已列完，正文尚未读取。'}\n读取正文：保留path并指定 archive_entry=目录中的条目原路径；可用start_line/start_column/max_chars，后续用返回cursor。`
  }
  if (readFileIdentity(await fs.stat(file, { bigint: true })) !== tag) throw new Error('ZIP在读取过程中已改变，请重新读取')
  signal?.throwIfAborted()
  return { ok: true, message: result, ...(sources.length ? { sources } : {}) }
}

/** Preserve the existing string reader for import/legacy callers. */
export async function readProjectArchivePage(file: string, request: ReadPageRequest & { archive_entry?: unknown }, signal?: AbortSignal, expectedSha256?: string): Promise<string> {
  return (await readProjectArchiveResult(file, request, signal, expectedSha256)).message
}
