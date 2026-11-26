/** Display-only telemetry. Estimates must never enter billing or hard budgets. */
export interface ProviderPerformanceUsage {
  inputTokens: number | null
  outputTokens: number | null
  cache: {
    status: 'unknown' | 'reported'
    inputTokens: number | null
    hitTokens: number | null
    missTokens: number | null
    writeTokens: number | null
    /** hit / total input; null for missing, inconsistent, or zero input. */
    hitRate: number | null
  }
}

export interface ProviderPerformanceSnapshot extends ProviderPerformanceUsage {
  requestId: string
  attempt: number
  /** Monotonic within requestId, including retries. */
  revision: number
  status: 'waiting' | 'streaming' | 'completed' | 'failed' | 'cancelled'
  scope?: { runId: string; turnSeq: number; round: number; actor: 'writer' | 'critic' | 'editor' }
  startedAt: number
  elapsedMs: number
  /** Fetch boundary to first nonempty text, reasoning, or tool-call output. */
  ttftMs: number | null
  /** CJK code points = 1; other code points = 1/4, rounded once per call.
   * Only visible text/reasoning/tool name+arguments, not hidden model tokens. */
  estimateMethod: 'visible_cjk_1_other_quarter_v1'
  estimatedOutputTokens: number
  /** Rolling <= 1s window, sampled every 250ms. Denominator is windowMs. */
  windowMs: number
  windowOutputTokens: number
  estimatedTokensPerSecond: number | null
  /** Provider outputTokens / full request elapsed time, including TTFT.
   * Actual tokens do not reveal when individual tokens were generated. */
  actualTokensPerSecond: number | null
}
