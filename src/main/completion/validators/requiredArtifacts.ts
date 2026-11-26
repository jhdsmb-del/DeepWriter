// ==================== R4.3 Gate 4：必需产物 validator ====================
// 按 kind 计数 evidence.artifacts；数量 < minCount（默认 1）→ hard 'missing_artifact'（含缺失明细）。
// 判定只依赖 evidence.artifacts——与 measuredChars 等其他字段无关（测试可传不同 measuredChars 验证）。

import { createHash } from 'node:crypto'
import type { CompletionEvidence, Finding } from '../types'

function findingHash(id: string, code: string, message: string): string {
  return createHash('sha256').update(`${id}\u0000${code}\u0000${message}`, 'utf8').digest('hex')
}

export function validateRequiredArtifacts(required: Array<{ kind: string; pathRef?: string; minCount?: number }>, evidence: CompletionEvidence): Finding[] {
  const findings: Finding[] = []
  for (const req of required) {
    const minCount = req.minCount ?? 1
    const count = evidence.artifacts.filter((a) => a.kind === req.kind).length
    if (count < minCount) {
      const message = `必需产物缺失：kind=${req.kind}${req.pathRef ? `（pathRef=${req.pathRef}）` : ''}，期望数量 ≥ ${minCount}，实际 ${count}`
      findings.push({
        id: 'requiredArtifacts',
        severity: 'hard',
        code: 'missing_artifact',
        message,
        evidence: `kind=${req.kind} expected=${minCount} actual=${count}`,
        hash: findingHash('requiredArtifacts', 'missing_artifact', message)
      })
    }
  }
  return findings
}
