// ==================== R4.2 A6 补充：UI 端 usage revision 去重 ====================
// translator 层已在 terminal 后丢弃迟到 usage；UI 端按 revision 丢弃迟到/重复更新
// （partial→actual 覆盖规则：旧 revision 不得覆盖新值；重连 resync 后 reset 可重新累计）。
// 纯模块，renderer 与测试共用。

export interface UsageAccumulator {
  /**
   * 应用一次 usage 更新。revision 必须严格递增（同一 run 内）；
   * 迟到（revision <= 已见最大）返回 null（丢弃，不重复累计）。
   * 返回该次更新的值（{inputTokens, outputTokens}）。
   */
  apply(runId: string, revision: number, inputTokens: number, outputTokens: number): { inputTokens: number; outputTokens: number } | null
  /** 重连/新请求 resync：清除该 run 的 revision 水位 */
  reset(runId: string): void
}

export function createUsageAccumulator(): UsageAccumulator {
  const lastRevision = new Map<string, number>()
  return {
    apply(runId, revision, inputTokens, outputTokens) {
      const seen = lastRevision.get(runId) ?? 0
      if (revision <= seen) return null
      lastRevision.set(runId, revision)
      return { inputTokens, outputTokens }
    },
    reset(runId) {
      lastRevision.delete(runId)
    }
  }
}
