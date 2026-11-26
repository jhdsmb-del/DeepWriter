import type { ToolCallRecord } from './types'
import { WORK_PLAN_TOOL } from '../../shared/workPlan'
import { FILE_EVIDENCE_TOOLS } from '../../shared/fileEvidence'

// The model needs the edit result, not the local checkpoint identifiers or file fingerprints.
export function modelVisibleOutput(name: string, raw: string): string {
  const fileRead = FILE_EVIDENCE_TOOLS.some(tool => tool === name)
  if (name !== 'edit_file' && name !== 'write_file' && name !== WORK_PLAN_TOOL && !fileRead) return raw
  let payload: unknown
  try { payload = JSON.parse(raw) } catch { return raw }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return raw
  const data = payload as Record<string, unknown>
  // Keep captured excerpts locally without doubling the model's already
  // bounded read message or turning an ordinary page into an artifact stub.
  if (name === WORK_PLAN_TOOL && data.ok === true && data.workPlan) return JSON.stringify({ ok: true, message: data.message })
  if (fileRead) {
    if (!Object.hasOwn(data, 'sources')) return raw
    const { sources: _sources, ...result } = data
    return JSON.stringify(result)
  }
  if (!Object.hasOwn(data, 'editUndo') && !Object.hasOwn(data, 'backupId')) return raw
  const { editUndo: _undo, backupId: _backup, ...result } = data
  return JSON.stringify(result)
}

/** Tool-call records feed the author and recovery; tool turns feed the model. */
export async function prepareToolTurnOutput(name: string, raw: string, spill: (s: string) => Promise<string>) {
  const visible = modelVisibleOutput(name, raw)
  const content = await spill(visible)
  // Only persist an explicit replay projection when the public text was also
  // spilled. Normal edit receipts can regenerate it without storing text twice.
  const resultJson = JSON.stringify(visible === raw ? { content } : {
    content: raw, ...(content !== visible ? { modelContent: content } : {})
  })
  return { content, resultJson }
}

export function replayToolTurnOutput(tc: Pick<ToolCallRecord, 'name' | 'resultJson'>): string {
  if (!tc.resultJson) return ''
  try {
    const r = JSON.parse(tc.resultJson) as { content?: string; error?: string; modelContent?: string }
    return r.modelContent ?? modelVisibleOutput(tc.name, r.content ?? r.error ?? '')
  } catch { return modelVisibleOutput(tc.name, tc.resultJson) }
}
