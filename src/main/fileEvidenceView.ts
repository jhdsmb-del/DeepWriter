import { basename, isAbsolute, relative, sep } from 'node:path'
import { parseFileSources, type FileSourceEvidence } from '../shared/fileEvidence'
import type { FileEvidenceEntry, FileEvidencePage } from '../shared/fileEvidenceView'
import type { FileEvidenceRow, Repository } from './db/repository'

function displayPath(source: FileSourceEvidence, rootsJson: string): string {
  if (source.path.startsWith('attachment:')) return `附件 / ${source.displayName} · ${source.path.slice(-6)}`
  let roots: { workDir?: string; docDir?: string } = {}
  try { roots = JSON.parse(rootsJson) } catch { /* An old record keeps its actual recorded path. */ }
  for (const [root, label] of [[roots.workDir, '工作目录'], [roots.docDir, '文稿目录']] as const) {
    if (!root || !isAbsolute(source.path)) continue
    const path = relative(root, source.path)
    if (path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)) return `${label} / ${path.split(sep).join(' / ')}`
  }
  return source.path
}

/** Strip reread capabilities and expose only the excerpt that was actually stored. */
export function toolFileEvidence(row: FileEvidenceRow): FileEvidenceEntry[] {
  let sources: FileSourceEvidence[] = []
  try { sources = parseFileSources([JSON.parse(row.source_json)]) } catch { return [] }
  return sources.map(source => {
    const range = source.range
    const lastLine = range.end_column === 1 && range.end_line > range.start_line ? range.end_line - 1 : range.end_line
    const lineLabel = lastLine === range.start_line ? `第 ${range.start_line} 行` : `第 ${range.start_line}–${lastLine} 行`
    // A line can be thousands of columns long. Keep whole-line excerpts quiet,
    // but distinguish two readings starting at different points on the same line.
    const locator = range.start_column === 1 ? lineLabel : range.end_line === range.start_line
      ? `${lineLabel} · 第 ${range.start_column}–${range.end_column - 1} 列`
      : `${lineLabel} · 从第 ${range.start_column} 列起`
    return {
      runId: row.run_id, toolCallId: row.tool_call_id, sourceIndex: row.source_index,
      path: displayPath(source, row.roots_json), displayName: source.archive_entry ? basename(source.archive_entry.replace(/\\/g, '/')) : source.displayName,
      range, kind: row.name === 'search_files' ? 'search' : 'read', locator,
      excerpt: source.excerpt, truncated: source.excerpt_truncated,
      ...(source.archive_entry ? { archiveEntry: source.archive_entry } : {})
    }
  })
}

export function runFileEvidence(repo: Pick<Repository, 'getRunFileEvidenceRows'>, runId: string, offset = 0): FileEvidencePage {
  const start = Math.max(0, Math.trunc(offset))
  const rows = repo.getRunFileEvidenceRows(runId, start)
  return { entries: rows.slice(0, 8).flatMap(toolFileEvidence), nextOffset: rows.length > 8 ? start + 8 : null }
}

export function sessionFileEvidence(repo: Pick<Repository, 'getRunFileEvidenceRows' | 'getSessionFileEvidenceRunId'>, sessionId: string, messageId: string, offset = 0): FileEvidencePage {
  const runId = repo.getSessionFileEvidenceRunId(sessionId, messageId)
  return runId ? runFileEvidence(repo, runId, offset) : { entries: [], nextOffset: null }
}
