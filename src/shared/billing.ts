import type { ContextManifestV2, ContextRequestBillingView } from './contextV2'

export type ProviderActor = 'writer' | 'critic' | 'editor'
export type ProviderAttemptOutcome = 'in_flight' | 'success' | 'http_error' | 'transport_error' | 'timeout' | 'cancelled' | 'interrupted'
export type BillingCostStatus = 'actual' | 'estimated' | 'unknown'

export interface ProviderAttemptRecord {
  attemptId: string
  runId: string
  logicalCallId: string
  attemptNo: number
  stageId: string | null
  actor: ProviderActor
  subtype: string | null
  providerId: string
  endpointOrigin: string
  modelId: string
  providerRequestId: string | null
  outcome: ProviderAttemptOutcome
  httpStatus: number | null
  startedAt: number
  firstTokenAt: number | null
  endedAt: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheHitTokens: number | null
  cacheMissTokens: number | null
  reasoningTokens: number | null
  costStatus: BillingCostStatus
  costAmount: number | null
  costCurrency: string | null
  priceSnapshotId: string | null
  adapterId?: string | null
  profileId?: string | null
  credentialRefId?: string | null
  appliedMappings?: string[]
  omittedControls?: string[]
  contextManifestId?: string | null
  contextMode?: 'full' | 'optimized' | 'minimal' | null
}

export interface BillingMetric {
  value: number | null
  knownValue: number
  knownAttempts: number
  unknownAttempts: number
}

export interface RunBillingView {
  runId: string
  revision: number
  finalized: boolean
  status: string
  startedAt: number | null
  endedAt: number | null
  providers: Array<{ providerId: string; endpointOrigin: string; modelId: string; attempts: number }>
  callCounts: { attempts: number; logicalCalls: number; writer: number; critic: number; editor: number; tool: number }
  tokens: {
    input: BillingMetric
    output: BillingMetric
    cacheHit: BillingMetric
    cacheMiss: BillingMetric
    reasoning: BillingMetric
  }
  timing: {
    ttftMs: BillingMetric
    attemptDurationMs: BillingMetric
    runDurationMs: number | null
    outputTokensPerSecond: number | null
    stages: Array<{ phase: string; startedAt: number; endedAt: number | null; durationMs: number | null }>
  }
  cost: {
    status: BillingCostStatus
    amount: number | null
    knownAmount: number
    currency: string | null
    unknownAttempts: number
  }
  attempts: ProviderAttemptRecord[]
  context: { requests: ContextRequestBillingView[] }
}

interface WorkflowTimingEvent {
  seq: number
  timestamp: number
  phase: string
  type: string
}

function metric(attempts: ProviderAttemptRecord[], select: (attempt: ProviderAttemptRecord) => number | null): BillingMetric {
  const values = attempts.map(select)
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const knownValue = known.reduce((sum, value) => sum + value, 0)
  const unknownAttempts = values.length - known.length
  return { value: values.length > 0 && unknownAttempts === 0 ? knownValue : null, knownValue, knownAttempts: known.length, unknownAttempts }
}

export function buildRunBillingView(input: {
  runId: string
  revision: number
  finalized: boolean
  status: string
  startedAt: number | null
  endedAt: number | null
  toolCalls: number
  attempts: ProviderAttemptRecord[]
  workflowEvents?: WorkflowTimingEvent[]
  contextManifests?: ContextManifestV2[]
}): RunBillingView {
  const attempts = [...input.attempts].sort((a, b) => a.startedAt - b.startedAt || a.attemptNo - b.attemptNo)
  const providerMap = new Map<string, { providerId: string; endpointOrigin: string; modelId: string; attempts: number }>()
  for (const attempt of attempts) {
    const key = `${attempt.providerId}\u0000${attempt.endpointOrigin}\u0000${attempt.modelId}`
    const current = providerMap.get(key)
    if (current) current.attempts += 1
    else providerMap.set(key, { providerId: attempt.providerId, endpointOrigin: attempt.endpointOrigin, modelId: attempt.modelId, attempts: 1 })
  }
  const inputTokens = metric(attempts, (attempt) => attempt.inputTokens)
  const outputTokens = metric(attempts, (attempt) => attempt.outputTokens)
  const cacheHitTokens = metric(attempts, (attempt) => attempt.cacheHitTokens)
  const cacheMissTokens = metric(attempts, (attempt) => attempt.cacheMissTokens)
  const reasoningTokens = metric(attempts, (attempt) => attempt.reasoningTokens)
  const ttftMs = metric(attempts, (attempt) => attempt.firstTokenAt === null ? null : Math.max(0, attempt.firstTokenAt - attempt.startedAt))
  const attemptDurationMs = metric(attempts, (attempt) => attempt.endedAt === null ? null : Math.max(0, attempt.endedAt - attempt.startedAt))
  const costKnown = attempts.filter((attempt) => attempt.costStatus !== 'unknown' && attempt.costAmount !== null)
  const costUnknown = attempts.length - costKnown.length
  const currencies = [...new Set(costKnown.map((attempt) => attempt.costCurrency).filter((value): value is string => Boolean(value)))]
  const knownAmount = costKnown.reduce((sum, attempt) => sum + (attempt.costAmount ?? 0), 0)
  const costStatus: BillingCostStatus = costUnknown > 0 || currencies.length !== 1
    ? 'unknown'
    : costKnown.some((attempt) => attempt.costStatus === 'estimated') ? 'estimated' : costKnown.length > 0 ? 'actual' : 'unknown'
  const runDurationMs = input.startedAt !== null && input.endedAt !== null ? Math.max(0, input.endedAt - input.startedAt) : null
  const knownGenerationMs = attempts
    .filter((attempt) => attempt.outputTokens !== null && attempt.firstTokenAt !== null && attempt.endedAt !== null)
    .reduce((sum, attempt) => sum + Math.max(0, (attempt.endedAt ?? 0) - (attempt.firstTokenAt ?? 0)), 0)
  const outputTokensPerSecond = outputTokens.value !== null && knownGenerationMs > 0 ? outputTokens.value / (knownGenerationMs / 1000) : null
  const stages: RunBillingView['timing']['stages'] = []
  let current: { phase: string; startedAt: number } | null = null
  const phaseBoundaries = (input.workflowEvents ?? [])
    .filter((event) => event.type === 'run.started' || event.type === 'phase.changed' || event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled')
    .sort((a, b) => a.seq - b.seq)
  for (const event of phaseBoundaries) {
    if (!current) {
      current = { phase: event.phase, startedAt: event.timestamp }
      continue
    }
    if (event.phase === current.phase) continue
    stages.push({ phase: current.phase, startedAt: current.startedAt, endedAt: event.timestamp, durationMs: Math.max(0, event.timestamp - current.startedAt) })
    current = event.type.startsWith('run.') && ['completed', 'failed', 'cancelled'].includes(event.phase)
      ? null
      : { phase: event.phase, startedAt: event.timestamp }
  }
  if (current) {
    const endedAt = input.endedAt
    stages.push({ phase: current.phase, startedAt: current.startedAt, endedAt, durationMs: endedAt === null ? null : Math.max(0, endedAt - current.startedAt) })
  }
  return {
    runId: input.runId,
    revision: input.revision,
    finalized: input.finalized,
    status: input.status,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    providers: [...providerMap.values()],
    callCounts: {
      attempts: attempts.length,
      logicalCalls: new Set(attempts.map((attempt) => attempt.logicalCallId)).size,
      writer: attempts.filter((attempt) => attempt.actor === 'writer').length,
      critic: attempts.filter((attempt) => attempt.actor === 'critic').length,
      editor: attempts.filter((attempt) => attempt.actor === 'editor').length,
      tool: input.toolCalls
    },
    tokens: { input: inputTokens, output: outputTokens, cacheHit: cacheHitTokens, cacheMiss: cacheMissTokens, reasoning: reasoningTokens },
    timing: { ttftMs, attemptDurationMs, runDurationMs, outputTokensPerSecond, stages },
    cost: {
      status: costStatus,
      amount: costStatus === 'unknown' ? null : knownAmount,
      knownAmount,
      currency: currencies.length === 1 ? currencies[0] : null,
      unknownAttempts: costUnknown
    },
    attempts,
    context: {
      requests: (input.contextManifests ?? []).map((manifest) => {
        // The manifest id is the durable request-ledger join key.  Keep the
        // logical-call fallback only for pre-R45/manual records which cannot
        // carry the new foreign-key-like column; otherwise an outer attempt
        // sharing a logical call id could be counted alongside its inner
        // provider attempts.
        const direct = attempts.filter((attempt) => attempt.contextManifestId === manifest.manifestId)
        const linked = direct.length > 0
          ? direct
          : attempts.filter((attempt) => attempt.contextManifestId == null && attempt.logicalCallId === manifest.requestId)
        const actualInput = linked.length > 0 && linked.every((attempt) => attempt.inputTokens !== null)
          ? linked.reduce((sum, attempt) => sum + (attempt.inputTokens ?? 0), 0)
          : null
        const actualCached = linked.length > 0 && linked.every((attempt) => attempt.cacheHitTokens !== null)
          ? linked.reduce((sum, attempt) => sum + (attempt.cacheHitTokens ?? 0), 0)
          : null
        return {
          manifestId: manifest.manifestId,
          requestId: manifest.requestId,
          stageId: manifest.stageId,
          roundIndex: manifest.roundIndex,
          mode: manifest.mode,
          selectedInputEstimate: manifest.selectedEstimate.value,
          fullBaselineEstimate: manifest.fullBaselineEstimate.value,
          estimatedSavedTokens: manifest.estimatedSavedTokens,
          estimatedSavingsRatio: manifest.estimatedSavingsRatio,
          actualInputTokens: actualInput,
          actualCachedInputTokens: actualCached,
          actualSavedTokens: null,
          actualSavingsRatio: null,
          decisions: manifest.decisions,
          summaryRef: manifest.summaryRef,
          retrieval: manifest.retrieval,
          estimatorVersion: manifest.selectedEstimate.estimatorVersion,
          envelopeHash: manifest.envelopeHash
        }
      })
    }
  }
}
