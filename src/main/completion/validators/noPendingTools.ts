// ==================== R4.3 Gate 4：无待办工具 validator ====================
// pendingToolCount > 0 → hard 'pending_tool'（列出工具名）。

import { createHash } from 'node:crypto'
import type { CompletionEvidence, Finding } from '../types'

function findingHash(id: string, code: string, message: string): string {
  return createHash('sha256').update(`${id}\u0000${code}\u0000${message}`, 'utf8').digest('hex')
}

export function validateNoPendingTools(evidence: CompletionEvidence): Finding[] {
  const count = evidence.pendingToolCount ?? 0
  if (count <= 0) {
    return []
  }
  const names = (evidence.pendingToolNames ?? []).join('、') || String(count)
  const message = `仍有 ${count} 个未完成工具：${names}`
  return [
    {
      id: 'noPendingTools',
      severity: 'hard',
      code: 'pending_tool',
      message,
      evidence: names,
      hash: findingHash('noPendingTools', 'pending_tool', message)
    }
  ]
}
