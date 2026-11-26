import { promises as fs } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

// The encoded tool message must stay below the engine's 20k spill threshold,
// including JSON escaping. Otherwise the model sees an archive stub, not the page.
const MAX_POINTS = 8000
const ESCAPED_BUDGET = 14000
const SCAN_BLOCK = 65536
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export type ReadPageRequest = { start_line?: unknown; start_column?: unknown; line_count?: unknown; cursor?: unknown; max_chars?: unknown }
export interface ReadPage { text: string; first: number; last: number; firstColumn: number; endLine: number; endColumn: number; cursor?: string; readCursor?: string; budgetLimited?: boolean }

function positive(value: unknown, fallback: number, key: string, upper = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > upper) {
    throw new Error(`${key} 必须是 1 到 ${upper} 的整数`)
  }
  return value
}
export const readFileIdentity = (s: BigIntStats): string =>
  [s.dev, s.ino, s.size, s.mtimeNs].map(n => n.toString(36)).join('.')
export const readFileCursor = (tag: string, byte: number, line: number): string => `p1:${tag}:${byte}:${line}`
const utf8Width = (b: number): number => b < 128 ? 1 : b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0

export function readOutputBudget(value: number | undefined): number {
  return value === undefined ? ESCAPED_BUDGET : Number.isFinite(value) ? Math.max(0, Math.min(ESCAPED_BUDGET, Math.floor(value))) : 0
}
export function readPageOptions(request: ReadPageRequest, outputBudget?: number) {
  if (request.cursor !== undefined && (request.start_line !== undefined || request.start_column !== undefined)) throw new Error('cursor 和 start_line/start_column 请选择一种定位')
  return { lines: positive(request.line_count, 100, 'line_count', 1000),
    points: Math.min(MAX_POINTS, positive(request.max_chars, MAX_POINTS, 'max_chars', 400000), readOutputBudget(outputBudget)),
    first: positive(request.start_line, 1, 'start_line'), firstColumn: positive(request.start_column, 1, 'start_column'), escapedBudget: readOutputBudget(outputBudget) }
}

async function lineOffset(fh: FileHandle, first: number, size: number, signal?: AbortSignal): Promise<number> {
  if (first === 1) return 0
  const buf = Buffer.allocUnsafe(SCAN_BLOCK)
  let line = 1, pos = 0
  while (pos < size) {
    signal?.throwIfAborted()
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos)
    if (!bytesRead) break
    const chunk = buf.subarray(0, bytesRead)
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) {
      if (++line === first && pos + i + 1 < size) return pos + i + 1
    }
    pos += bytesRead
  }
  throw new Error(`文件没有第 ${first} 行，请使用 search_files 返回的行号`)
}

/** Columns count Unicode code points, not UTF-16 units or UTF-8 bytes. LF
 * separates lines; CR and a retained BOM remain ordinary code points. */
async function columnOffset(fh: FileHandle, start: number, column: number, size: number, signal?: AbortSignal): Promise<number> {
  let pos = start, current = 1
  const buffer = Buffer.allocUnsafe(SCAN_BLOCK)
  while (current < column && pos < size) {
    signal?.throwIfAborted()
    const { bytesRead } = await fh.read(buffer, 0, Math.min(buffer.length, size - pos), pos)
    let i = 0
    while (i < bytesRead && current < column) {
      const width = utf8Width(buffer[i])
      if (!width) throw new Error('不是有效的 UTF-8 文本，请检查编码')
      if (i + width > bytesRead) break
      if (buffer[i] === 10) throw new Error(`该行没有第 ${column} 列（列按 Unicode 码点计数）`)
      i += width; current++
    }
    try { decoder.decode(buffer.subarray(0, i)) } catch { throw new Error('不是有效的 UTF-8 文本，请检查编码') }
    if (!i) throw new Error('不是有效的 UTF-8 文本，请检查编码')
    pos += i
  }
  if (current !== column || (pos === size && column !== 1)) throw new Error(`该行没有第 ${column} 列（列按 Unicode 码点计数）`)
  return pos
}

async function columnAt(fh: FileHandle, start: number, end: number, signal?: AbortSignal): Promise<number> {
  if (end < start) throw new Error('续读位置与行号不一致')
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const buffer = Buffer.allocUnsafe(SCAN_BLOCK)
  let pos = start, column = 1
  while (pos < end) {
    signal?.throwIfAborted()
    const { bytesRead } = await fh.read(buffer, 0, Math.min(buffer.length, end - pos), pos)
    if (!bytesRead) throw new Error('文件在读取过程中发生变化，请重新读取')
    const text = utf8.decode(buffer.subarray(0, bytesRead), { stream: true })
    if (text.includes('\n')) throw new Error('续读位置与行号不一致')
    column += Array.from(text).length; pos += bytesRead
  }
  column += Array.from(utf8.decode()).length
  return column
}

/** A cursor is a seek hint, not a file reference. The calling tool must
 * authorize the path on every request, including continuations. */
export async function readFilePage(file: string, request: ReadPageRequest, signal?: AbortSignal, outputBudget?: number): Promise<ReadPage> {
  signal?.throwIfAborted()
  const { lines, points, escapedBudget, first: requestedLine, firstColumn: requestedColumn } = readPageOptions(request, outputBudget)
  let first = requestedLine, firstColumn = requestedColumn
  const handle = await fs.open(file, 'r')
  try {
    const st = await handle.stat({ bigint: true })
    if (!st.isFile()) throw new Error('不是普通文本文件')
    if (st.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('文件太大，无法寻址')
    const size = Number(st.size), tag = readFileIdentity(st)
    let start: number
    if (request.cursor !== undefined) {
      const cursor = typeof request.cursor === 'string' && request.cursor.length <= 160
        ? /^p1:([0-9a-z.\-]+):(\d{1,16}):(\d{1,16})$/.exec(request.cursor) : null
      if (!cursor) throw new Error('续读位置无效，请原样使用上页的 cursor')
      if (cursor[1] !== tag) throw new Error('文件已更改或不是上一页的文件，请重新定位段落')
      start = Number(cursor[2]); first = Number(cursor[3])
      if (!Number.isSafeInteger(start) || start < 0 || start >= size || first < 1 || !Number.isSafeInteger(first) || first > start + 1) throw new Error('续读位置超出文件范围')
      firstColumn = await columnAt(handle, await lineOffset(handle, first, size, signal), start, signal)
    } else start = await columnOffset(handle, await lineOffset(handle, first, size, signal), firstColumn, size, signal)

    const bytes = Buffer.allocUnsafe(Math.min(size - start, points * 4))
    let loaded = 0
    while (loaded < bytes.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(bytes, loaded, bytes.length - loaded, start + loaded)
      if (!bytesRead) throw new Error('文件在读取过程中发生变化，请重新读取')
      loaded += bytesRead
    }
    let i = 0, count = 0, escaped = 0, nextLine = first, nextColumn = firstColumn, last = first
    while (i < loaded && count < points && nextLine - first < lines) {
      const b = bytes[i]
      const width = utf8Width(b)
      if (!width || i + width > loaded) throw new Error('不是有效的 UTF-8 文本，请检查编码')
      // JSON wraps the message; escaped control characters can cost six units.
      const cost = b < 32 ? 6 : b === 34 || b === 92 || width === 4 ? 2 : 1
      if (escaped + cost > escapedBudget) break
      escaped += cost; last = nextLine
      if (b === 10) { nextLine++; nextColumn = 1 } else nextColumn++
      i += width; count++
    }
    let text: string
    try { text = decoder.decode(bytes.subarray(0, i)) } catch { throw new Error('不是有效的 UTF-8 文本，请检查编码') }
    signal?.throwIfAborted()
    if (readFileIdentity(await handle.stat({ bigint: true })) !== tag) throw new Error('文件在读取过程中发生变化，请重新读取')
    return { text, first, last, firstColumn, endLine: nextLine, endColumn: nextColumn,
      ...(text ? { readCursor: readFileCursor(tag, start, first) } : {}), ...(i === 0 && start < size ? { budgetLimited: true } : {}),
      cursor: start + i < size ? readFileCursor(tag, start + i, nextLine) : undefined }
  } finally { await handle.close() }
}
