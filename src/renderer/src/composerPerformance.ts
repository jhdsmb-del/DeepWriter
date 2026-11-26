import type { ProviderPerformanceSnapshot } from '../../shared/performanceTelemetry'

export interface ComposerPerformanceState {
  snapshot: ProviderPerformanceSnapshot
  retiredRequests: string[]
}

/** Only the visible run owns the footer. Retired requests cannot reclaim it. */
export function projectComposerPerformance(current: ComposerPerformanceState | null, next: ProviderPerformanceSnapshot, runId: string): ComposerPerformanceState | null {
  if (next.scope?.runId !== runId) return current
  if (current?.snapshot.scope?.runId !== runId) current = null
  if (!current) return { snapshot: next, retiredRequests: [] }
  const previous = current.snapshot
  if (previous.requestId === next.requestId) return next.revision > previous.revision ? { ...current, snapshot: next } : current
  if (current.retiredRequests.includes(next.requestId)) return current
  const previousScope = previous.scope!
  if (next.scope.turnSeq < previousScope.turnSeq || next.scope.turnSeq === previousScope.turnSeq && next.scope.round < previousScope.round) return current
  if (next.scope.turnSeq === previousScope.turnSeq && next.scope.round === previousScope.round && next.startedAt < previous.startedAt) return current
  return { snapshot: next, retiredRequests: [...current.retiredRequests, previous.requestId].slice(-32) }
}

export function performanceLabels(snapshot?: ProviderPerformanceSnapshot) {
  const waiting = !snapshot || snapshot.status === 'waiting'
  const actual = !waiting && snapshot.actualTokensPerSecond != null
  const speed = waiting ? null : actual ? snapshot.actualTokensPerSecond : snapshot.estimatedTokensPerSecond
  const cache = waiting ? undefined : snapshot.cache
  return {
    speed: speed == null ? '输出 — tok/s' : `输出 ${actual ? '' : '≈'}${speed.toFixed(1)} tok/s`,
    speedTitle: waiting ? '等待模型输出和用量' : actual ? '接口报告的输出 Token ÷ 整个请求耗时（含等待首字）' : '最近 1 秒可见文字与工具调用的 Token 估算，不用于计费',
    cache: cache?.status !== 'reported' ? '缓存命中 未知' : cache.hitRate != null ? `缓存命中 ${(cache.hitRate * 100).toFixed(0)}%` : cache.hitTokens != null ? `缓存命中 ${cache.hitTokens.toLocaleString()} tokens` : '缓存命中 未知'
  }
}
