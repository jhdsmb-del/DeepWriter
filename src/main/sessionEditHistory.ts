import type { SessionEditHistoryPage, ToolEventUI } from '../shared/types'
import type { Repository, ToolCallRow } from './db/repository'
import { appliedFileChange, decodeToolResult, unwrapToolResult } from './toolResultView'
import { fileEditUndoRef } from './editUndo'

function editEvent(repo: Parameters<typeof fileEditUndoRef>[0], row: ToolCallRow): ToolEventUI {
  const record = { name: row.name, status: row.status, argsJson: row.args_json, resultJson: row.result_json }
  const decoded = decodeToolResult({ status: row.status === 'completed' ? 'completed' : 'failed', resultJson: row.result_json ?? undefined })
  const change = decoded.ok ? appliedFileChange(record) : undefined
  const payload = unwrapToolResult(row.result_json).payload
  let file = '文件'
  try { const path = JSON.parse(row.args_json).path; if (typeof path === 'string') file = path.split(/[\\/]/).pop() || file } catch { /* unavailable old argument */ }
  const confirmed = Boolean(change)
  const failure = ['failed', 'cancelled'].includes(row.status) || payload?.ok === false || typeof payload?.error === 'string'
  const noChange = row.status === 'completed' && payload?.ok === true && decoded.ok
    && (payload?.edit as { count?: unknown } | undefined)?.count === 0
  const detail = decoded.result !== row.result_json ? decoded.result.slice(0, 240).replace(/请用\s*read_file\s*读取当前段落后再改/g, '请先读取当前段落再修改').replace(/\bread_file\b/g, '读取文件') : ''
  const unconfirmed = row.status === 'side_effect_unknown' || (!failure && !noChange)
  return {
    id: row.tool_call_id, name: row.name, argsPreview: '',
    ...(confirmed ? { editUndo: fileEditUndoRef(repo, row) } : {}),
    status: confirmed || noChange ? 'done' : 'error', resultOk: confirmed || noChange,
    result: noChange ? `${file}：内容没有变化，未写盘` : change?.summary ?? (unconfirmed ? `修改结果待确认：${file}` : `未修改 ${file}${detail ? `：${detail}` : ''}`),
    ...(change?.before !== undefined && change.after !== undefined ? { editReceipt: { before: change.before, after: change.after } } : {}),
    ...(row.started_at !== null && row.completed_at !== null ? { durationMs: Math.max(0, row.completed_at - row.started_at) } : {})
  }
}

export function sessionEditHistory(repo: Pick<Repository, 'getSessionEditTools'> & Parameters<typeof fileEditUndoRef>[0], sessionId: string, messageId: string, offset = 0): SessionEditHistoryPage {
  const rows = repo.getSessionEditTools(sessionId, messageId, offset)
  return { events: rows.slice(0, 40).map(row => editEvent(repo, row)), nextOffset: rows.length > 40 ? offset + 40 : null }
}
