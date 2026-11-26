import { FILE_EVIDENCE_MAX_EXCERPT_UNITS, fileSourceRange, parseFileSource, type FileSourceEvidence } from '../shared/fileEvidence'
import type { ReadPage } from './fileReadPage'

export function sourceFromReadPage(input: { path: string; displayName: string; kind: FileSourceEvidence['kind']; archive_entry?: string; page: ReadPage; extractionTruncated?: boolean }): FileSourceEvidence[] {
  const { page } = input
  if (!page.text) return []
  const excerpt = page.text.slice(0, FILE_EVIDENCE_MAX_EXCERPT_UNITS).replace(/[\uD800-\uDBFF]$/, '')
  const range = fileSourceRange(page.first, page.firstColumn, excerpt)
  const source = parseFileSource({ version: 1, kind: input.kind, path: input.path, displayName: input.displayName,
    ...(input.archive_entry ? { archive_entry: input.archive_entry } : {}), range, excerpt,
    excerpt_truncated: excerpt.length < page.text.length || !!page.cursor || page.first !== 1 || page.firstColumn !== 1 || input.extractionTruncated === true,
    read: { path: input.path, ...(input.archive_entry ? { archive_entry: input.archive_entry } : {}),
      ...(page.readCursor ? { cursor: page.readCursor } : { start_line: page.first, start_column: page.firstColumn }),
      line_count: Math.min(1000, range.end_line - range.start_line + 1), max_chars: Array.from(excerpt).length } })
  return source ? [source] : []
}
