import { readPageOptions, type ReadPage, type ReadPageRequest } from './fileReadPage'

/** Positions belong to extracted text, not document layout. Offsets in cursors
 * are private UTF-16 offsets; public columns always count Unicode code points. */
export function extractedTextPage(text: string, request: ReadPageRequest, tag: string, kind: 'd1' | 'z1' | 'o1', signal?: AbortSignal, outputBudget?: number): ReadPage {
  const options = readPageOptions(request, outputBudget)
  let start = 0, first = options.first, firstColumn = options.firstColumn
  if (request.cursor !== undefined) {
    const cursor = typeof request.cursor === 'string' && request.cursor.length <= 200 ? /^(d1|z1|o1):([0-9a-z.\-]+):(\d{1,10})$/.exec(request.cursor) : null
    if (!cursor || cursor[1] !== kind) throw new Error('续读位置无效，请原样使用同一文件/条目返回的 cursor')
    if (cursor[2] !== tag) throw new Error('文档已更改或不是上一页的文件/条目，请重新定位')
    start = Number(cursor[3])
    if (start < 0 || start >= text.length || (/[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1] ?? ''))) throw new Error('续读位置超出提取范围')
    const prefix = text.slice(0, start)
    first = prefix.split('\n').length
    firstColumn = Array.from(prefix.slice(prefix.lastIndexOf('\n') + 1)).length + 1
  } else {
    for (let line = 1; line < first; line++) {
      const newline = text.indexOf('\n', start)
      if (newline < 0 || newline + 1 >= text.length) throw new Error(`提取文本没有第 ${first} 行（若提取已截断，后续尚未读取）`)
      start = newline + 1
    }
    for (let column = 1; column < firstColumn; column++) {
      if (start >= text.length || text[start] === '\n') throw new Error(`该提取行没有第 ${firstColumn} 列`)
      start += (text.codePointAt(start) as number) > 0xffff ? 2 : 1
    }
    if (start >= text.length && text.length) throw new Error(`该提取行没有第 ${firstColumn} 列`)
  }
  let end = start, line = first, column = firstColumn, last = first, count = 0, escaped = 0
  while (end < text.length && count < options.points && line - first < options.lines) {
    signal?.throwIfAborted()
    const point = String.fromCodePoint(text.codePointAt(end) as number), cost = JSON.stringify(point).length - 2
    if (escaped + cost > options.escapedBudget) break
    escaped += cost; count++; last = line; end += point.length
    if (point === '\n') { line++; column = 1 } else column++
  }
  return { text: text.slice(start, end), first, last, firstColumn, endLine: line, endColumn: column,
    ...(end > start ? { readCursor: `${kind}:${tag}:${start}` } : {}),
    ...(end === start && start < text.length ? { budgetLimited: true } : {}),
    ...(end < text.length ? { cursor: `${kind}:${tag}:${end}` } : {}) }
}
