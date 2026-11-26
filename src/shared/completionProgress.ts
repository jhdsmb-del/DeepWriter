// ==================== R4.4 Gate 3：completion 进度 reducer（纯函数，可单测） ====================
// renderer store 与测试共用：revision 去重（迟到/重复丢弃）；只累计最新客观进度，不改 lifecycle。

export interface CompletionProgress {
  runId: string
  subtype: string
  state: string
  measuredChars?: number
  targetChars?: number
  validatorPassed?: number
  validatorTotal?: number
  remainingWork: Array<{ code: string; message: string }>
  blockedReason?: string
  pausedMessage?: string
  revision: number
}

export interface CompletionChunkInput {
  subtype: string
  state: string
  revision: number
  measuredChars?: number
  targetChars?: number
  validatorPassed?: number
  validatorTotal?: number
  remainingWork?: Array<{ code: string; message: string }>
  blockedReason?: string
  pausedMessage?: string
}

/**
 * 应用 completion chunk：revision 必须严格递增（同 run 内）；
 * 迟到（revision <= 已见最大）返回 null（丢弃，不覆盖新进度）。
 */
export function applyCompletionChunk(runId: string, chunk: CompletionChunkInput, current: CompletionProgress | undefined): CompletionProgress | null {
  if (current && chunk.revision <= current.revision) return null
  return {
    runId,
    subtype: chunk.subtype,
    state: chunk.state,
    measuredChars: chunk.measuredChars,
    targetChars: chunk.targetChars,
    validatorPassed: chunk.validatorPassed,
    validatorTotal: chunk.validatorTotal,
    remainingWork: chunk.remainingWork ?? [],
    blockedReason: chunk.blockedReason,
    pausedMessage: chunk.pausedMessage,
    revision: chunk.revision
  }
}
