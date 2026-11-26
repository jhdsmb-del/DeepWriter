import type { CompletionEvidence, Finding } from '../types'

export function validateStrongConstraints(config: Record<string, unknown>, evidence: CompletionEvidence): Finding[] {
  const expectedHash = typeof config.constraintHash === 'string' ? config.constraintHash : ''
  const expectedRulesVersion = typeof config.rulesVersion === 'number' ? config.rulesVersion : 1
  const actual = evidence.strongConstraints
  if (!actual) {
    return [{ id: 'strongConstraints', severity: 'hard', code: 'constraint_evidence_missing', message: '缺少强约束检查证据，不能标记完成', hash: `strongConstraints:missing:${expectedHash}` }]
  }
  if (!expectedHash || actual.constraintHash !== expectedHash || actual.rulesVersion !== expectedRulesVersion) {
    return [{ id: 'strongConstraints', severity: 'hard', code: 'constraint_evidence_mismatch', message: '强约束检查与本次冻结配置不一致，不能标记完成', hash: `strongConstraints:mismatch:${expectedHash}:${actual.constraintHash}:${actual.rulesVersion}` }]
  }
  // R42：自动词法锚点/说教/节奏属于 advisory；只有用户明确硬边界
  // 或 strong 主题最终门可以阻断 completed。
  return actual.violations.filter((violation) => violation.severity !== 'soft').map((violation) => ({
    id: 'strongConstraints',
    severity: 'hard',
    code: `constraint_${violation.code}`,
    message: `${violation.category}：${violation.message}`,
    hash: `strongConstraints:${expectedHash}:${violation.code}`
  }))
}
