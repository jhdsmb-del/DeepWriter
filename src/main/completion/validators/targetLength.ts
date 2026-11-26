// ==================== R4.3 Gate 4：目标字数 validator ====================
// - measured 缺失 → hard 'no_measurement'（没有任何"模型自述完成"可替代实测）；
// - measured < min*(1-tolerance) → hard 'below_target'；
// - measured > max → hard 'over_target'（max 缺省不查）；
// - tolerance 默认 0.05。
// R4.5 Gate 3（复审 S-01）：finding identity 与动态测量值分离——below_target 的稳定 hash
// 只依赖 validator/code/目标区间（min/max/tolerance），**不含每轮实测字数**：
// 8000→8100 是低进展但 finding identity 稳定（hash 不变）；进展由
// CompletionController 的 lastDeltaChars 单独记录（monotonicity 水位）。

import { createHash } from 'node:crypto'
import type { Finding } from '../types'

const DEFAULT_TOLERANCE = 0.05

function findingHash(id: string, code: string, stableKey: string): string {
  return createHash('sha256').update(`${id}\u0000${code}\u0000${stableKey}`, 'utf8').digest('hex')
}

export function validateTargetChars(cfg: { min: number; max?: number; tolerance: number }, measured: number | undefined): Finding[] {
  if (typeof cfg.min !== 'number' || !Number.isFinite(cfg.min)) {
    // 契约缺 min 视为未配置该门禁（防御：不误报）
    return []
  }
  const tolerance = cfg.tolerance ?? DEFAULT_TOLERANCE
  if (measured === undefined || !Number.isFinite(measured)) {
    const message = '缺少目标字数测量（measuredChars 未提供），无法验证完成契约'
    return [
      {
        id: 'targetChars',
        severity: 'hard',
        code: 'no_measurement',
        message,
        evidence: `min=${cfg.min}`,
        hash: findingHash('targetChars', 'no_measurement', 'no_measurement')
      }
    ]
  }
  const findings: Finding[] = []
  const floor = cfg.min * (1 - tolerance)
  if (measured < floor) {
    const message = `实际 ${measured} 字符低于下限 ${Math.round(floor)}（min=${cfg.min}，容差 ${Math.round(tolerance * 100)}%）`
    findings.push({
      id: 'targetChars',
      severity: 'hard',
      code: 'below_target',
      message,
      evidence: `measured=${measured} floor=${floor}`,
      // R4.5 Gate 3：稳定 key 不含 measured（8000/8100/8200 同一 identity）——低增长不是 finding 改变
      hash: findingHash('targetChars', 'below_target', `min=${cfg.min} tolerance=${tolerance}`)
    })
  }
  if (cfg.max !== undefined && Number.isFinite(cfg.max) && measured > cfg.max) {
    const message = `实际 ${measured} 字符超过上限 ${cfg.max}`
    findings.push({
      id: 'targetChars',
      severity: 'hard',
      code: 'over_target',
      message,
      evidence: `measured=${measured} max=${cfg.max}`,
      hash: findingHash('targetChars', 'over_target', `max=${cfg.max}`)
    })
  }
  return findings
}
