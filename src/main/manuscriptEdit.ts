/** Exact, literal manuscript edits. Offsets for search use LF; splicing always
 * uses the original file so mixed line endings and untouched bytes survive. */
export interface ManuscriptEdit {
  text: string
  count: number
  lines: number[]
}

export interface ManuscriptEditCandidate {
  start_line: number
  start_column: number
  end_line: number
  end_column: number
  /** Exact original text, never the typography-normalized search view. */
  retry?: { old_text: string; at_line: number }
  read_file: { start_line: number; start_column: number; line_count: number }
}
export interface ManuscriptEditRecovery {
  kind: 'formatting_candidates'
  count: number
  candidates: ManuscriptEditCandidate[]
}
export class ManuscriptEditMatchError extends Error {
  constructor(message: string, readonly recovery?: ManuscriptEditRecovery) { super(message) }
}

// A search-only view: no compatibility folding, dash/ellipsis normalization,
// case folding, word similarity, or removal of line/paragraph boundaries.
// Even a unique formatting candidate must be retried with its actual original.
const horizontal = /[\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+|[\u2018\u2019\u201c\u201d]/g
type ViewSpan = { start: number; end: number; originalStart: number; originalEnd: number }
function formattingView(text: string): { text: string; spans: ViewSpan[] } {
  const parts: string[] = [], spans: ViewSpan[] = []
  let previous = 0, length = 0
  const append = (value: string, start: number, end: number): void => {
    if (!value) return
    parts.push(value); spans.push({ start: length, end: length + value.length, originalStart: start, originalEnd: end }); length += value.length
  }
  for (const match of text.matchAll(horizontal)) {
    const start = match.index, end = start + match[0].length
    append(text.slice(previous, start), previous, start)
    const quote = /[\u2018\u2019]/.test(match[0]) ? "'" : /[\u201c\u201d]/.test(match[0]) ? '"' : undefined
    append(quote ?? (start === 0 || text[start - 1] === '\n' || end === text.length || text[end] === '\n' ? '' : ' '), start, end)
    previous = end
  }
  append(text.slice(previous), previous, text.length)
  return { text: parts.join(''), spans }
}
function originalBoundary(spans: ViewSpan[], offset: number, end: boolean): number {
  // End boundaries are left-biased so discarded trailing spaces are not added
  // to a selection; start boundaries are right-biased past discarded indent.
  const character = end ? offset - 1 : offset
  let left = 0, right = spans.length
  while (left + 1 < right) { const mid = Math.floor((left + right) / 2); if (spans[mid].start <= character) left = mid; else right = mid }
  const span = spans[left]
  if (span.end - span.start !== span.originalEnd - span.originalStart) return end ? span.originalEnd : span.originalStart
  return span.originalStart + offset - span.start
}

const normalize = (text: string): string => text.replace(/\r\n/g, '\n')
const sampleSize = 6
export function planManuscriptEdit(text: string, args: Record<string, unknown>): ManuscriptEdit {
  if (typeof args.old_text !== 'string' || args.old_text === '') throw new Error('old_text 不能为空，请提供摘自稿件的原文')
  if (typeof args.new_text !== 'string') throw new Error('缺少 new_text；若要删除这段原文，请明确传入空字符串')
  if (/[\uD800-\uDFFF]/u.test(args.new_text) || args.new_text.includes('\0')) throw new Error('替换内容包含无效的文本字符，未修改')
  if (args.replace_all !== undefined && typeof args.replace_all !== 'boolean') throw new Error('replace_all 必须是布尔值')
  const all = args.replace_all === true, at = args.at_line
  if (at !== undefined && (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 1 || all)) throw new Error('at_line 必须是从 1 开始的行号，不能与全文替换同用')

  const source = normalize(text), from = normalize(args.old_text), to = normalize(args.new_text)
  const raw = [0], norm = [0]
  let cr = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (text[i - 1] === '\r') cr++
    raw.push(i + 1); norm.push(i + 1 - cr)
  }
  const lineOf = (offset: number): number => {
    let l = 0, r = norm.length
    while (l + 1 < r) { const mid = Math.floor((l + r) / 2); if (norm[mid] <= offset) l = mid; else r = mid }
    return l
  }
  const rawOffset = (offset: number, row: number): number => raw[row] + offset - norm[row]
  // Keep new lines consistent with the passage. At EOF, inherit the preceding line ending.
  const eolAt = (row: number): string => {
    const end = raw[row + 1] ?? raw[row]
    return end >= 2 && text[end - 2] === '\r' ? '\r\n' : '\n'
  }
  const first = typeof at === 'number' ? norm[at - 1] : 0
  const stop = typeof at === 'number' ? (norm[at] ?? source.length) : source.length
  let count = 0, prev = 0, lastEnd = -1, growth = 0
  const pieces: string[] = [], lines: number[] = []
  for (let i = first === undefined ? -1 : source.indexOf(from, first); i !== -1 && i < stop; i = source.indexOf(from, i + 1)) {
    const row = lineOf(i)
    if (lines.length < sampleSize && lines.at(-1) !== row + 1) lines.push(row + 1)
    count++
    if (all && i < lastEnd) throw new Error('原文匹配位置彼此重叠，请使用更长的片段定位')
    lastEnd = i + from.length
    if (!all && count > 1) continue
    const begin = rawOffset(i, row), end = rawOffset(lastEnd, lineOf(lastEnd))
    // A literal no-op must preserve even mixed line endings inside the selection.
    const value = from === to ? text.slice(begin, end) : (to.includes('\n') && eolAt(row) === '\r\n' ? to.replace(/\n/g, '\r\n') : to)
    growth += value.length - (end - begin)
    if (all && growth > 16_000_000) throw new Error('单次全文替换将新增超过 1600 万字符；请缩小修改范围')
    pieces.push(text.slice(prev, begin), value); prev = end
  }
  if (!count) {
    const view = formattingView(source), needle = formattingView(from).text
    const candidates: ManuscriptEditCandidate[] = []
    let candidateCount = 0, remaining = 4000
    // Whitespace-only requests have no useful typography-equivalent anchor.
    if (needle.trim()) for (let i = view.text.indexOf(needle); i !== -1; i = view.text.indexOf(needle, i + 1)) {
      const begin = originalBoundary(view.spans, i, false), end = originalBoundary(view.spans, i + needle.length, true)
      if (first === undefined || begin < first || begin >= stop) continue
      candidateCount++
      if (candidates.length >= 3) continue
      const startRow = lineOf(begin), endRow = lineOf(end)
      const original = text.slice(rawOffset(begin, startRow), rawOffset(end, endRow))
      const startColumn = Array.from(source.slice(norm[startRow], begin)).length + 1
      const endColumn = Array.from(source.slice(norm[endRow], end)).length + 1
      const retry = !all && original.length <= remaining ? { old_text: original, at_line: startRow + 1 } : undefined
      if (retry) remaining -= original.length
      candidates.push({ start_line: startRow + 1, start_column: startColumn, end_line: endRow + 1, end_column: endColumn,
        ...(retry ? { retry } : {}), read_file: { start_line: startRow + 1, start_column: startColumn, line_count: endRow - startRow + 1 } })
    }
    const message = '未找到匹配原文' + (at === undefined ? '' : '（第 ' + at + ' 行）')
    if (candidateCount) throw new ManuscriptEditMatchError(message + '；发现 ' + candidateCount + ' 处仅引号或水平空白排版不同的候选，未修改。请核对行段后，用候选 retry 的原文和行号重新调用；没有 retry 时先按 read_file 定位重读，全文替换须重新确认全部原文。',
      { kind: 'formatting_candidates', count: candidateCount, candidates })
    throw new ManuscriptEditMatchError(message + '，请用 read_file 读取当前段落后再改')
  }
  if (!all && count !== 1) throw new Error('匹配到 ' + count + ' 处（第 ' + lines.join('、') + ' 行' + (lines.length === sampleSize ? '等' : '') + '），请用 at_line 或更长的原文定位；只有全文都要改时才用 replace_all')
  pieces.push(text.slice(prev))
  return { text: pieces.join(''), count, lines }
}

export function decodeManuscript(bytes: Buffer): string {
  if (bytes.includes(0)) throw new Error('不是 UTF-8 文本稿件，未修改；请先另存为 UTF-8')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new Error('不是有效的 UTF-8 文本，未修改；请先另存为 UTF-8') }
}
