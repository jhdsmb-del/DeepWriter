export const FILE_EVIDENCE_TOOLS = ['read_file', 'read_files', 'search_files'] as const
export const FILE_EVIDENCE_MAX_SOURCES = 64
export const FILE_EVIDENCE_MAX_EXCERPT_UNITS = 14000
export interface FileSourceRange { start_line: number; start_column: number; end_line: number; end_column: number }
export interface FileSourceRead {
  path: string; archive_entry?: string; cursor?: string; start_line?: number; start_column?: number
  line_count: number; max_chars: number
}
/** Captured by a successful host read, never inferred from assistant prose.
 * The path/cursor is a locator, not permission to perform another read. */
export interface FileSourceEvidence {
  version: 1
  kind: 'text' | 'document' | 'zip_entry'
  path: string
  displayName: string
  archive_entry?: string
  range: FileSourceRange
  excerpt: string
  excerpt_truncated: boolean
  read: FileSourceRead
}
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
export function fileSourceRange(startLine: number, startColumn: number, excerpt: string): FileSourceRange {
  let line = startLine, column = startColumn
  for (const point of excerpt) { if (point === '\n') { line++; column = 1 } else column++ }
  return { start_line: startLine, start_column: startColumn, end_line: line, end_column: column }
}
/** Bound and project only the canonical fields; unknown/plugin data does not
 * acquire source authority merely by resembling a free-text citation. */
export function parseFileSource(value: unknown): FileSourceEvidence | undefined {
  const v = record(value), range = record(v?.range), read = record(v?.read)
  if (!v || v.version !== 1 || !['text', 'document', 'zip_entry'].includes(String(v.kind)) || !text(v.path, 4096) || !text(v.displayName, 512)
    || !text(v.excerpt, FILE_EVIDENCE_MAX_EXCERPT_UNITS) || typeof v.excerpt_truncated !== 'boolean' || !range || !read) return undefined
  if (!['start_line', 'start_column', 'end_line', 'end_column'].every(key => positive(range[key]))) return undefined
  const expected = fileSourceRange(range.start_line as number, range.start_column as number, v.excerpt)
  if (expected.end_line !== range.end_line || expected.end_column !== range.end_column) return undefined
  const points = Array.from(v.excerpt)
  if (points.some(point => point.length === 1 && /[\uD800-\uDFFF]/.test(point)) || read.path !== v.path || !positive(read.max_chars) || read.max_chars !== points.length || read.max_chars > 8000
    || !positive(read.line_count) || read.line_count > 1000 || read.line_count < Math.max(1, expected.end_line - expected.start_line + (expected.end_column === 1 ? 0 : 1))) return undefined
  if (v.kind === 'zip_entry' ? !text(v.archive_entry, 512) || read.archive_entry !== v.archive_entry : v.archive_entry !== undefined || read.archive_entry !== undefined) return undefined
  let locator: Pick<FileSourceRead, 'cursor' | 'start_line' | 'start_column'>
  if (read.cursor !== undefined) {
    if (!text(read.cursor, 200) || !/^(?:p1:[0-9a-z.\-]+:\d{1,16}:\d{1,16}|[doz]1:[0-9a-z.\-]+:\d{1,10})$/.test(read.cursor)
      || read.start_line !== undefined || read.start_column !== undefined) return undefined
    if (v.kind === 'text' ? !read.cursor.startsWith('p1:') : v.kind === 'zip_entry' ? !read.cursor.startsWith('z1:') : !/^[do]1:/.test(read.cursor)) return undefined
    locator = { cursor: read.cursor }
  } else {
    if (read.start_line !== expected.start_line || read.start_column !== expected.start_column) return undefined
    locator = { start_line: expected.start_line, start_column: expected.start_column }
  }
  return { version: 1, kind: v.kind as FileSourceEvidence['kind'], path: v.path, displayName: v.displayName,
    ...(v.kind === 'zip_entry' ? { archive_entry: v.archive_entry as string } : {}), range: expected, excerpt: v.excerpt, excerpt_truncated: v.excerpt_truncated,
    read: { path: v.path, ...(v.kind === 'zip_entry' ? { archive_entry: v.archive_entry as string } : {}), ...locator, line_count: read.line_count, max_chars: read.max_chars } }
}
export function parseFileSources(value: unknown): FileSourceEvidence[] {
  return Array.isArray(value) ? value.slice(0, FILE_EVIDENCE_MAX_SOURCES).map(parseFileSource).filter((item): item is FileSourceEvidence => !!item) : []
}
