// ==================== R4.3 Gate 4：Ren'Py lint validator ====================
// R4.5 Gate 1（复审 B-01 阻断项）：fail-closed——
// - 契约包含 renpyLint validator 的 run（galgame）必须有真实 renpy artifact：
//   无 artifact → hard 'missing_artifact'（不允许"无产物就不 lint"的绕过）；
// - 有 renpy artifact 但 evidence.renpyLint 缺失 → hard 'lint_not_run'；
// - lint ok=false 或 errorCount>0 → hard 'lint_failed'；
// - lint evidence 必须携带 manifest_hash（业务 run 侧从 artifact 集合重算比对；
//   文件变化后 hash 不匹配 → evidence 失效，不允许用旧 lint 结果完成）。

import { createHash } from 'node:crypto'
import type { CompletionEvidence, Finding } from '../types'

function findingHash(id: string, code: string, message: string): string {
  return createHash('sha256').update(`${id}\u0000${code}\u0000${message}`, 'utf8').digest('hex')
}

/**
 * R4.5 Gate 1：项目目标文件集合的稳定 manifest hash（路径+内容 hash+排序）。
 * - 业务 run 侧：从 run 登记的 renpy artifact（path+hash）重算；
 * - lint 写入侧：从磁盘文件（path+sha256(content)）计算。
 * 两侧公式一致 → 文件变化（artifact hash 变）→ manifest 不匹配 → evidence 失效。
 */
export function computeManifestHash(files: Array<{ path: string; hash: string }>): string {
  const lines = files.map((f) => `${f.path}\u0000${f.hash}`).sort()
  return createHash('sha256').update(lines.join('\u0001'), 'utf8').digest('hex')
}

export function validateRenpyLint(evidence: CompletionEvidence): Finding[] {
  // R4.5 Gate 1（B-01 修复）：fail-closed——契约包含本 validator 即要求真实产物与 lint 证据；
  // 无 renpy artifact 直接 hard fail（不再条件式跳过）
  const hasRenpyArtifact = evidence.artifacts.some((a) => a.kind === 'renpy')
  const lint = evidence.renpyLint
  if (!hasRenpyArtifact) {
    const message = 'Galgame 完成契约要求至少一个 renpy 产物；无产物时不允许跳过 Ren\'Py 校验（fail-closed）'
    return [
      {
        id: 'renpyLint',
        severity: 'hard',
        code: 'missing_artifact',
        message,
        hash: findingHash('renpyLint', 'missing_artifact', message)
      }
    ]
  }
  if (!lint) {
    const message = "Ren'Py lint 未运行（或 manifest 不匹配已失效），无法验证脚本语法"
    return [
      {
        id: 'renpyLint',
        severity: 'hard',
        code: 'lint_not_run',
        message,
        hash: findingHash('renpyLint', 'lint_not_run', message)
      }
    ]
  }
  if (lint.ok === false || lint.errorCount > 0) {
    const message = `Ren'Py lint 失败：${lint.errorCount} 错误 / ${lint.warningCount} 警告`
    return [
      {
        id: 'renpyLint',
        severity: 'hard',
        code: 'lint_failed',
        message,
        evidence: typeof lint.output === 'string' ? lint.output.slice(0, 500) : '',
        hash: findingHash('renpyLint', 'lint_failed', message)
      }
    ]
  }
  return []
}
