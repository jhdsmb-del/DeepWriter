import type { ToolCallRecord } from './jobs/types'

function object(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { /* Plain tool output and old receipts remain readable. */ }
}
export function unwrapToolResult(resultJson: string | null | undefined): { text: string; payload?: Record<string, unknown> } {
  const text = resultJson ?? ''
  const outer = object(text)
  if (!outer || typeof outer.error === 'string' || typeof outer.content !== 'string') return { text, payload: outer }
  return { text: outer.content, payload: object(outer.content) ?? outer }
}

export function decodeToolResult(record: Pick<ToolCallRecord, 'status' | 'resultJson'>): { ok: boolean; result: string; exitCode: number | null } {
  const { text, payload } = unwrapToolResult(record.resultJson)
  const error = payload?.error, message = payload?.message, code = payload?.exitCode
  return { ok: record.status === 'completed' && typeof error !== 'string' && payload?.ok !== false,
    result: typeof error === 'string' ? error : typeof message === 'string' ? message : text,
    exitCode: typeof error !== 'string' && typeof code === 'number' && Number.isInteger(code) ? code : null }
}

export type AppliedFileChange = { file: string; summary: string; before?: string; after?: string }
const sample = (s: string): string => {
  const snippet = Array.from(s.slice(0, 322)).slice(0, 160).join('')
  return snippet + (snippet.length < s.length ? '…' : '')
}

export function appliedFileChange(tool: { status: string; name: string; argsJson: string; resultJson?: string | null }): AppliedFileChange | undefined {
  if (tool.status !== 'completed' || !['write_file', 'edit_file'].includes(tool.name)) return undefined
  const { payload } = unwrapToolResult(tool.resultJson)
  if (payload?.ok !== true || typeof payload.message !== 'string') return undefined
  const edit = payload.edit as { count?: unknown } | undefined
  if (edit?.count === 0) return undefined
  let args: Record<string, unknown>
  try { args = JSON.parse(tool.argsJson) } catch { return undefined }
  if (!args || typeof args.path !== 'string') return undefined
  const entry: AppliedFileChange = { file: args.path, summary: payload.message }
  // Only new, literal edits support an accurate excerpt from the stored request.
  if (tool.name === 'edit_file' && typeof edit?.count === 'number' && edit.count > 0 && typeof args.old_text === 'string' && typeof args.new_text === 'string') {
    entry.before = sample(args.old_text); entry.after = sample(args.new_text)
  }
  return entry
}
