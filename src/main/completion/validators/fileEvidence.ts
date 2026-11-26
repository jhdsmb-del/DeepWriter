// ==================== R4.6 Gate 3：产物文件证据 validator（防自欺式完成） ====================
// 任务书：完成必须由独立 controller 根据可观察证据决定——"聊天声称完成但文件不存在，
// 必须拒绝完成"（COMP-EVIDENCE-01）；"文件写入后损坏或不可解析，必须拒绝完成"
// （COMP-ARTIFACT-01）。
// 本 validator 校验契约 requiredFiles 的每个条件：
// - 登记 artifact 中必须存在路径匹配的文件（relativePath 相等）→ 缺失 hard 'missing_file'；
// - 磁盘读回的内容（evidence.artifactContents[hash]）必须存在且非空（minChars 校验）→
//   hard 'file_corrupt'；
// - 读回内容重算 hash 必须与登记 hash 一致（登记后文件被改/损坏 → hash 漂移）→ hard 'file_corrupt'。
// 判定只依赖 evidence（gate 注入 artifactContents）——纯函数可测。

import { createHash } from 'node:crypto'
import type { CompletionEvidence, Finding } from '../types'

function findingHash(id: string, code: string, message: string): string {
  return createHash('sha256').update(`${id}\u0000${code}\u0000${message}`, 'utf8').digest('hex')
}

export interface RequiredFileSpec {
  path: string
  kind: 'text' | 'markdown' | 'renpy'
  minChars?: number
}

export function validateFileEvidence(required: RequiredFileSpec[], evidence: CompletionEvidence): Finding[] {
  const findings: Finding[] = []
  for (const spec of required) {
    const artifact = evidence.artifacts.find((a) => a.path === spec.path)
    if (!artifact) {
      const message = `必需产物文件缺失：${spec.path}（契约要求 ${spec.kind} 文件，登记 artifact 中不存在）`
      findings.push({
        id: 'fileEvidence',
        severity: 'hard',
        code: 'missing_file',
        message,
        evidence: `path=${spec.path}`,
        hash: findingHash('fileEvidence', 'missing_file', message)
      })
      continue
    }
    const content = evidence.artifactContents?.[artifact.hash]
    if (content === undefined || content === null) {
      const message = `产物文件不可读：${spec.path}（登记 hash=${artifact.hash}，磁盘读回为空）`
      findings.push({
        id: 'fileEvidence',
        severity: 'hard',
        code: 'file_corrupt',
        message,
        evidence: `path=${spec.path} hash=${artifact.hash}`,
        hash: findingHash('fileEvidence', 'file_corrupt', message)
      })
      continue
    }
    if (typeof spec.minChars === 'number' && spec.minChars > 0 && content.length < spec.minChars) {
      const message = `产物文件内容不足：${spec.path}（要求 ≥${spec.minChars} 字符，实际 ${content.length}）`
      findings.push({
        id: 'fileEvidence',
        severity: 'hard',
        code: 'file_corrupt',
        message,
        evidence: `path=${spec.path} min=${spec.minChars} actual=${content.length}`,
        hash: findingHash('fileEvidence', 'file_corrupt', message)
      })
      continue
    }
    // 损坏检测：读回内容重算 hash 必须与登记 hash 一致（登记后文件被改/截断 → 拒绝完成）
    const actualHash = createHash('sha256').update(content, 'utf8').digest('hex')
    if (actualHash !== artifact.hash) {
      const message = `产物文件内容与登记不符（可能已损坏/被修改）：${spec.path}`
      findings.push({
        id: 'fileEvidence',
        severity: 'hard',
        code: 'file_corrupt',
        message,
        evidence: `path=${spec.path} expected=${artifact.hash} actual=${actualHash}`,
        hash: findingHash('fileEvidence', 'file_corrupt', message)
      })
    }
  }
  return findings
}
