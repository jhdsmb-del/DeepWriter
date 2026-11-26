import type { FileEvidencePage } from '../shared/fileEvidenceView'

export type SourceReceiptPage = FileEvidencePage & { runId: string; interactive?: boolean }

// Receipts contain text from files, not terminal instructions. Keep ordinary
// newlines in excerpts, but strip escape/bidi sequences in both excerpts and labels.
const safe = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
const label = (text: string) => safe(text).replace(/[\t\n]/g, ' ')

export function sourcePageText(page: SourceReceiptPage): string {
  const parts = page.entries.map(item => {
    const name = label(item.path) + (item.archiveEntry ? ' › ' + label(item.archiveEntry) : '')
    const where = item.locator ? ' · ' + label(item.locator) : ''
    if (item.kind === 'found' || !item.excerpt) return name + where + (item.kind === 'found' ? '（仅找到文件）' : '')
    return name + where + '\n' + safe(item.excerpt).split('\n').map(s => '  ' + s).join('\n') + (item.truncated ? '\n  …（摘录）' : '')
  })
  if (!parts.length) parts.push('没有已保存的文件来源。')
  if (page.nextOffset != null) parts.push(page.interactive
    ? '下一页：/sources ' + label(page.runId) + ' ' + page.nextOffset
    : '下一页：在原命令中使用 --offset ' + page.nextOffset)
  return parts.join('\n\n')
}
