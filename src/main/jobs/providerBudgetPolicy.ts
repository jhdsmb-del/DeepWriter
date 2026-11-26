import { createHash } from 'node:crypto'
import { AGENT_WORK_BUDGET_POLICY, normalizeAgentRunBudget } from '../../shared/agentRunBudget'
import type { DsMessage } from '../../shared/types'
import type { CompletionContract } from '../completion/types'
import type { ProviderCostQuote, RunBudgetActor, RunBudgetState, RunConfig, RunCostLimit, RunCostReservation, RunTokenReservation, SettledRunTokenReservation } from './types'

/** Durable provider-budget policy. No store, provider, lock, or wall-clock IO
 * lives here. Callers serialize changes, supply observation times, and persist
 * the resulting ledger before allowing the provider boundary to proceed.
 * The durable v1 shape and reservation keys also cover pre-2.0 snapshots. */
export const RUN_BUDGET_EVIDENCE_KIND = 'run_provider_budget_v1'
/** Bounds finite author-supplied counts; null has no call-count ceiling. */
export const RUN_PROVIDER_CALL_ABSOLUTE_CAP = 512
/** Unmarked legacy/synthetic configs retain their historical limit. New
 * snapshots explicitly freeze null rather than relying on an absent field. */
const DEFAULT_RUN_PROVIDER_CALL_CAP = 16
const DEFAULT_RUN_TOKEN_CAP = 2_000_000
/** A restored evidence row is untrusted input.  Keep a process-wide token
 * ceiling so a damaged row cannot turn a continuation into an unbounded run. */
const ABSOLUTE_RUN_TOKEN_CAP = 20_000_000
/** Keep the idempotency ledger bounded. An oversized or malformed ledger is
 * a hard deny; silently truncating it could reopen already-spent capacity. */
const MAX_TOKEN_LEDGER_ITEMS = 4096
const MAX_TOKEN_RESERVATION_ID_CHARS = 512
/** Same fail-closed principle for an optional cost ceiling. */
const ABSOLUTE_RUN_COST_CNY = 100_000
const DEFAULT_RUN_WALL_CLOCK_MS = 30 * 60 * 1000
const ABSOLUTE_RUN_WALL_CLOCK_MS = 24 * 60 * 60 * 1000
export const MAX_PROGRESS_ROUNDS = 8
export const MAX_TARGET_WINDOW_REPAIRS = 2

export type ProviderBudgetFailureCode = 'run_provider_call_cap' | 'run_token_budget' | 'run_cost_budget' | 'run_cost_currency_mismatch' | 'run_cost_unknown_price' | 'run_cost_reservation_overrun' | 'run_wall_clock_budget' | 'run_budget_persistence' | 'run_target_window_repair_exhausted'

export class RunBudgetExceededError extends Error {
  readonly code: ProviderBudgetFailureCode

  constructor(code: ProviderBudgetFailureCode, message: string) {
    super(message)
    this.name = 'RunBudgetExceededError'
    this.code = code
  }
}

function positiveFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function integerAtLeast(value: unknown, fallback: number, max: number): number {
  const n = positiveFinite(value)
  return n === null ? fallback : Math.min(max, Math.max(1, Math.floor(n)))
}

function budgetActor(value: unknown): RunBudgetActor {
  return value === 'critic' || value === 'editor' ? value : 'writer'
}

function emptyActorCounts(): Record<RunBudgetActor, number> {
  return { writer: 0, critic: 0, editor: 0 }
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const currency = value.trim().toUpperCase()
  return /^[A-Z][A-Z0-9_-]{0,15}$/.test(currency) ? currency : null
}

export interface ProviderTokenRequestBoundary {
  /** Exact serialized request body at the provider fetch boundary. */
  bodyJson?: string
  /** Fallback request messages for synthetic/test seams that do not expose a
   * serialized body. The production adapter always supplies bodyJson. */
  messages?: DsMessage[]
  maxTokens?: number
}

export interface ProviderTokenUpperBound {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requestHash: string
}

/**
 * Return a deliberately conservative pre-fetch token bound. UTF-8 bytes are
 * an upper bound on token count for a serialized request (and avoid the
 * optimistic chars/token estimates used for UI/context hints). The message
 * serialization is also considered so a test seam cannot accidentally pass a
 * body that omits part of the request. Invalid/overflowing input returns null
 * so the caller can fail closed before fetch.
 */
export function estimateProviderTokenUpperBound(input: ProviderTokenRequestBoundary): ProviderTokenUpperBound | null {
  const maxTokens = input.maxTokens
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens < 0 || maxTokens > Number.MAX_SAFE_INTEGER) return null
  let bodyBytes = 0
  let messageBytes = 0
  let messageJson = ''
  if (input.bodyJson !== undefined) {
    if (typeof input.bodyJson !== 'string') return null
    bodyBytes = Buffer.byteLength(input.bodyJson, 'utf8')
    if (!Number.isSafeInteger(bodyBytes)) return null
  }
  if (input.messages !== undefined) {
    if (!Array.isArray(input.messages)) return null
    try {
      messageJson = JSON.stringify(input.messages)
      messageBytes = Buffer.byteLength(messageJson, 'utf8')
    } catch {
      return null
    }
    if (!Number.isSafeInteger(messageBytes)) return null
  }
  if (input.bodyJson === undefined && input.messages === undefined) return null
  // Include a fixed framing allowance and per-message role/content framing;
  // the exact body path normally dominates this value. This is intentionally
  // conservative and is not used as a context-window estimate.
  const messageCount = input.messages?.length ?? 0
  const framing = 32 + messageCount * 8
  const inputTokens = Math.max(1, Math.max(bodyBytes, messageBytes) + framing)
  const outputTokens = Math.ceil(maxTokens)
  const totalTokens = inputTokens + outputTokens
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || !Number.isSafeInteger(totalTokens)) return null
  const requestHash = createHash('sha256')
    .update(input.bodyJson ?? '')
    .update('\u0000')
    .update(messageJson)
    .update('\u0000')
    .update(String(maxTokens))
    .digest('hex')
  return { inputTokens, outputTokens, totalTokens, requestHash }
}

function normalizedTokenNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null
  return Math.floor(value)
}

function normalizedReservationId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_RESERVATION_ID_CHARS ? value : null
}

function normalizeTokenLedger(state: RunBudgetState): {
  spentTokenUpper: number
  reservedInputTokens: number
  reservedOutputTokens: number
  reservedTokenAttempts: number
  tokenReservations: RunTokenReservation[]
  settledTokenReservations: SettledRunTokenReservation[]
  tokenReservationCorrupt: boolean
} {
  const raw = state as RunBudgetState & {
    spentTokenUpper?: unknown
    reservedInputTokens?: unknown
    reservedOutputTokens?: unknown
    reservedTokenAttempts?: unknown
    tokenReservations?: unknown
    settledTokenReservations?: unknown
    tokenReservationCorrupt?: unknown
  }
  let corrupt = raw.tokenReservationCorrupt === true
  const spentTokenUpper = normalizedTokenNumber(raw.spentTokenUpper) ?? (raw.spentTokenUpper === undefined ? 0 : (corrupt = true, 0))
  const rawReservations = raw.tokenReservations
  const reservations: RunTokenReservation[] = []
  const reservationIds = new Set<string>()
  if (rawReservations !== undefined && !Array.isArray(rawReservations)) corrupt = true
  if (Array.isArray(rawReservations)) {
    if (rawReservations.length > MAX_TOKEN_LEDGER_ITEMS) corrupt = true
    for (const candidate of rawReservations.slice(-MAX_TOKEN_LEDGER_ITEMS)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { corrupt = true; continue }
      const value = candidate as Partial<RunTokenReservation>
      const reservationId = normalizedReservationId(value.reservationId)
      const logicalCallId = normalizedReservationId(value.logicalCallId)
      const innerAttempt = normalizedTokenNumber(value.innerAttempt)
      const inputTokens = normalizedTokenNumber(value.inputTokens)
      const outputTokens = normalizedTokenNumber(value.outputTokens)
      const reservedAt = normalizedTokenNumber(value.reservedAt)
      if (!reservationId || !logicalCallId || innerAttempt === null || innerAttempt < 1 || inputTokens === null || outputTokens === null || reservedAt === null) { corrupt = true; continue }
      if (reservationIds.has(reservationId)) { corrupt = true; continue }
      reservationIds.add(reservationId)
      const totalTokens = inputTokens + outputTokens
      if (!Number.isSafeInteger(totalTokens) || (typeof value.totalTokens === 'number' && value.totalTokens !== totalTokens)) corrupt = true
      reservations.push({
        reservationId,
        logicalCallId,
        innerAttempt,
        inputTokens,
        outputTokens,
        totalTokens,
        requestHash: typeof value.requestHash === 'string' ? value.requestHash.slice(0, 128) : '',
        reservedAt
      })
    }
  }
  const rawSettled = raw.settledTokenReservations
  const settled: SettledRunTokenReservation[] = []
  const settledIds = new Set<string>()
  if (rawSettled !== undefined && !Array.isArray(rawSettled)) corrupt = true
  if (Array.isArray(rawSettled)) {
    if (rawSettled.length > MAX_TOKEN_LEDGER_ITEMS) corrupt = true
    for (const candidate of rawSettled.slice(-MAX_TOKEN_LEDGER_ITEMS)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { corrupt = true; continue }
      const value = candidate as Partial<SettledRunTokenReservation>
      const reservationId = normalizedReservationId(value.reservationId)
      const chargedTokens = normalizedTokenNumber(value.chargedTokens)
      const settledAt = normalizedTokenNumber(value.settledAt)
      if (!reservationId || chargedTokens === null || settledAt === null) { corrupt = true; continue }
      if (settledIds.has(reservationId)) { corrupt = true; continue }
      settledIds.add(reservationId)
      settled.push({ reservationId, chargedTokens, settledAt })
    }
  }
  if (reservations.some((reservation) => settledIds.has(reservation.reservationId))) corrupt = true
  const { reservedInputTokens, reservedOutputTokens, reservedTokenAttempts } = tokenReservationTotals(reservations)
  if (!Number.isSafeInteger(reservedInputTokens) || !Number.isSafeInteger(reservedOutputTokens)) corrupt = true
  return {
    spentTokenUpper,
    reservedInputTokens: Number.isSafeInteger(reservedInputTokens) ? reservedInputTokens : Number.MAX_SAFE_INTEGER,
    reservedOutputTokens: Number.isSafeInteger(reservedOutputTokens) ? reservedOutputTokens : Number.MAX_SAFE_INTEGER,
    reservedTokenAttempts,
    tokenReservations: reservations,
    settledTokenReservations: settled.slice(-MAX_TOKEN_LEDGER_ITEMS),
    tokenReservationCorrupt: corrupt
  }
}

function normalizeCostLimit(value: unknown, explicit = false): RunCostLimit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<RunCostLimit>
  const amount = explicit && raw.amount === 0 ? 0 : positiveFinite(raw.amount)
  if (amount === null) return null
  const currency = normalizeCurrency(raw.currency)
  if (raw.currency !== null && raw.currency !== undefined && currency === null) return null
  return { amount: explicit ? amount : Math.min(ABSOLUTE_RUN_COST_CNY, amount), currency, unknownPolicy: 'deny' }
}

function normalizeCostLedger(state: RunBudgetState): Pick<RunBudgetState, 'costReservations' | 'costReservationCorrupt'> {
  const rows = state.costReservations
  const reservations: RunCostReservation[] = []
  const ids = new Set<string>()
  let corrupt = state.costReservationCorrupt === true
  if (rows !== undefined && !Array.isArray(rows)) corrupt = true
  if (Array.isArray(rows)) {
    if (state.workBudgetPolicy !== AGENT_WORK_BUDGET_POLICY && rows.length > MAX_TOKEN_LEDGER_ITEMS) corrupt = true
    for (const row of state.workBudgetPolicy === AGENT_WORK_BUDGET_POLICY ? rows : rows.slice(-MAX_TOKEN_LEDGER_ITEMS)) {
      if (!row || typeof row !== 'object') { corrupt = true; continue }
      const reservationId = normalizedReservationId(row.reservationId)
      const logicalCallId = normalizedReservationId(row.logicalCallId)
      const innerAttempt = normalizedTokenNumber(row.innerAttempt)
      const currency = normalizeCurrency(row.currency)
      const reservedAt = normalizedTokenNumber(row.reservedAt)
      const settledAt = row.settledAt === null ? null : normalizedTokenNumber(row.settledAt)
      if (!reservationId || !logicalCallId || innerAttempt === null || innerAttempt < 1 || reservationId !== `${logicalCallId}\u0000${innerAttempt}` || ids.has(reservationId) ||
          !currency || typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount < 0 || reservedAt === null || (row.settledAt !== null && settledAt === null)) { corrupt = true; continue }
      ids.add(reservationId)
      reservations.push({ reservationId, logicalCallId, innerAttempt, amount: row.amount, currency,
        priceSnapshotId: typeof row.priceSnapshotId === 'string' ? row.priceSnapshotId : null, reservedAt, settledAt })
    }
  }
  const pending = reservations.filter(row => row.settledAt === null)
  const settled = reservations.filter(row => row.settledAt !== null)
  const exceeds = (rows: RunCostReservation[], amount: number): boolean => rows.reduce((sum, row) => sum + row.amount, 0) > amount + Number.EPSILON * Math.max(1, amount) * Math.max(1, rows.length)
  if (pending.length > state.reservedCostAttempts || exceeds(pending, state.reservedCost) || exceeds(settled, state.spentCostUpper) ||
      reservations.some(row => row.currency !== state.spentCostCurrency || (state.limits.maxCost?.currency != null && row.currency !== state.limits.maxCost.currency)) ||
      pending.some(row => row.currency !== normalizeCurrency(state.reservedCostCurrency))) corrupt = true
  return { costReservations: reservations, costReservationCorrupt: corrupt }
}

export function validBudgetState(value: unknown, runId: string): value is RunBudgetState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<RunBudgetState>
  const limits = state.limits as Partial<RunBudgetState['limits']> | undefined
  const byActor = state.callsByActor as Partial<Record<RunBudgetActor, unknown>> | undefined
  const retries = state.retriesByActor as Partial<Record<RunBudgetActor, unknown>> | undefined
  return state.schemaVersion === 1 && state.runId === runId && Number.isFinite(state.startedAt) &&
    (limits?.maxCalls === null || Number.isFinite(limits?.maxCalls)) && (Number.isFinite(limits?.maxWallClockMs) || (state.workBudgetPolicy === AGENT_WORK_BUDGET_POLICY && limits?.maxWallClockMs === null)) &&
    Number.isFinite(state.totalCalls) && Number.isFinite(state.retryCalls) &&
    Number.isFinite(byActor?.writer) && Number.isFinite(byActor?.critic) && Number.isFinite(byActor?.editor) &&
    Number.isFinite(retries?.writer) && Number.isFinite(retries?.critic) && Number.isFinite(retries?.editor) &&
    Array.isArray(state.recentWriterRounds)
}

/**
 * Evidence is durable input, not a trusted configuration source.  Preserve
 * counters (including an already-exceeded counter) but clamp every limit to
 * the process-wide ceiling before the next reservation.  This prevents a
 * damaged/old evidence row from reopening the dynamic planner escape hatch.
 */
export function normalizeBudgetState(state: RunBudgetState, observedAt: number): RunBudgetState {
  const nonNegative = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  const actorCounts = (value: unknown): Record<RunBudgetActor, number> => {
    const raw = value as Partial<Record<RunBudgetActor, unknown>> | undefined
    return {
      writer: nonNegative(raw?.writer),
      critic: nonNegative(raw?.critic),
      editor: nonNegative(raw?.editor)
    }
  }
  const explicit = state.workBudgetPolicy === AGENT_WORK_BUDGET_POLICY
  const maxCalls = state.limits.maxCalls === null ? null : integerAtLeast(state.limits.maxCalls, DEFAULT_RUN_PROVIDER_CALL_CAP, explicit ? Number.MAX_SAFE_INTEGER : RUN_PROVIDER_CALL_ABSOLUTE_CAP)
  const maxTokens = state.limits.maxTokens === null
    ? null
    : Math.min(explicit ? Number.MAX_SAFE_INTEGER : ABSOLUTE_RUN_TOKEN_CAP, positiveFinite(state.limits.maxTokens) ?? DEFAULT_RUN_TOKEN_CAP)
  const rawCost = state.limits.maxCostCny === null ? null : positiveFinite(state.limits.maxCostCny)
  // A non-null but malformed cost limit is safer as an immediately exhausted
  // limit than as an accidental unlimited run.  Valid values are bounded.
  const maxCostCny = state.limits.maxCostCny === null
    ? null
    : Math.min(explicit ? Number.MAX_VALUE : ABSOLUTE_RUN_COST_CNY, rawCost ?? 0)
  // New evidence carries an explicit currency-safe limit. Old evidence only
  // has maxCostCny and is interpreted as CNY; malformed non-null values stay
  // exhausted instead of silently becoming unlimited.
  const rawMaxCost = (state.limits as RunBudgetState['limits'] & { maxCost?: unknown }).maxCost
  const maxCost = rawMaxCost === undefined
    ? (maxCostCny === null ? null : { amount: maxCostCny, currency: 'CNY', unknownPolicy: 'deny' as const })
    : (rawMaxCost === null ? null : normalizeCostLimit(rawMaxCost, explicit) ?? { amount: 0, currency: null, unknownPolicy: 'deny' as const })
  const costNumber = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  const spentCostUpper = costNumber((state as RunBudgetState & { spentCostUpper?: unknown }).spentCostUpper)
  const reservedCost = costNumber((state as RunBudgetState & { reservedCost?: unknown }).reservedCost)
  const reservedCostAttempts = Math.floor(costNumber((state as RunBudgetState & { reservedCostAttempts?: unknown }).reservedCostAttempts))
  const spentCostCurrency = normalizeCurrency((state as RunBudgetState & { spentCostCurrency?: unknown }).spentCostCurrency)
  const reservedCostCurrency = normalizeCurrency((state as RunBudgetState & { reservedCostCurrency?: unknown }).reservedCostCurrency)
  const tokenLedger = normalizeTokenLedger(state)
  const costLedger = normalizeCostLedger({ ...state, limits: { ...state.limits, maxCost }, spentCostUpper, reservedCost, reservedCostAttempts, spentCostCurrency })
  const maxWallClockMs = explicit && state.limits.maxWallClockMs === null ? null : integerAtLeast(state.limits.maxWallClockMs, DEFAULT_RUN_WALL_CLOCK_MS, explicit ? Number.MAX_SAFE_INTEGER : ABSOLUTE_RUN_WALL_CLOCK_MS)
  const rawStartedAt = typeof state.startedAt === 'number' && Number.isFinite(state.startedAt) ? Math.max(0, Math.floor(state.startedAt)) : observedAt
  // A future timestamp would otherwise bypass the wall-clock gate after a
  // restart.  Treat it as starting now; never let restored evidence grant
  // extra wall-clock time.
  const startedAt = Math.min(rawStartedAt, observedAt)
  const recentWriterRounds = Array.isArray(state.recentWriterRounds)
    ? state.recentWriterRounds
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => {
        const raw = entry as Partial<RunBudgetState['recentWriterRounds'][number]>
        return {
          round: nonNegative(raw.round),
          beforeChars: nonNegative(raw.beforeChars),
          afterChars: nonNegative(raw.afterChars),
          acceptedDelta: nonNegative(raw.acceptedDelta),
          observedAt: typeof raw.observedAt === 'number' && Number.isFinite(raw.observedAt) ? raw.observedAt : observedAt
        }
      })
      .slice(-MAX_PROGRESS_ROUNDS)
    : []
  const rawLast = state.lastWriterRound
  const lastWriterRound = rawLast && typeof rawLast === 'object' && Number.isFinite(rawLast.round) && Number.isFinite(rawLast.measuredChars)
    ? { round: Math.max(0, Math.floor(rawLast.round)), measuredChars: Math.max(0, Math.floor(rawLast.measuredChars)) }
    : null
  return {
    ...state,
    ...(explicit ? { writerRounds: nonNegative(state.writerRounds) } : {}),
    startedAt,
    limits: { maxCalls, maxTokens, maxCost, maxCostCny, maxWallClockMs },
    totalCalls: nonNegative(state.totalCalls),
    callsByActor: actorCounts(state.callsByActor),
    retryCalls: nonNegative(state.retryCalls),
    retriesByActor: actorCounts(state.retriesByActor),
    knownInputTokens: nonNegative(state.knownInputTokens),
    knownOutputTokens: nonNegative(state.knownOutputTokens),
    unknownTokenCalls: nonNegative(state.unknownTokenCalls),
    spentCostUpper,
    spentCostCurrency,
    reservedCost,
    reservedCostCurrency,
    reservedCostAttempts,
    ...costLedger,
    spentTokenUpper: tokenLedger.spentTokenUpper,
    reservedInputTokens: tokenLedger.reservedInputTokens,
    reservedOutputTokens: tokenLedger.reservedOutputTokens,
    reservedTokenAttempts: tokenLedger.reservedTokenAttempts,
    tokenReservations: tokenLedger.tokenReservations,
    settledTokenReservations: tokenLedger.settledTokenReservations,
    tokenReservationCorrupt: tokenLedger.tokenReservationCorrupt,
    knownCostCny: state.knownCostCny === null
      ? null
      : (typeof state.knownCostCny === 'number' && Number.isFinite(state.knownCostCny) && state.knownCostCny >= 0 ? state.knownCostCny : null),
    unknownCostCalls: nonNegative(state.unknownCostCalls),
    targetWindowRepairAttempts: nonNegative(state.targetWindowRepairAttempts),
    zeroProgressRounds: nonNegative(state.zeroProgressRounds),
    lastWriterRound,
    recentWriterRounds,
    updatedAt: Number.isFinite(state.updatedAt) ? state.updatedAt : observedAt
  }
}

export function runBudgetLimits(config: RunConfig): RunBudgetState['limits'] {
  const contract = config.completionContract as CompletionContract | undefined
  const configured = contract?.providerCallBudget ?? config.providerCallBudget as CompletionContract['providerCallBudget'] | undefined
  if (config.workBudgetPolicy === AGENT_WORK_BUDGET_POLICY) {
    const explicit = normalizeAgentRunBudget(configured)
    return { maxCalls: explicit.maxCalls, maxTokens: explicit.maxTokens, maxWallClockMs: explicit.maxWallClockMs,
      maxCost: explicit.maxCost, maxCostCny: explicit.maxCost?.currency === 'CNY' ? explicit.maxCost.amount : null }
  }
  // Missing/invalid historical fields retain their old fail-closed limit.
  // Only a frozen explicit null grants unlimited calls.
  const maxCalls = configured?.maxCalls === null ? null : integerAtLeast(configured?.maxCalls, DEFAULT_RUN_PROVIDER_CALL_CAP, RUN_PROVIDER_CALL_ABSOLUTE_CAP)
  const maxTokens = Math.min(ABSOLUTE_RUN_TOKEN_CAP, positiveFinite(configured?.maxTokens) ?? positiveFinite(contract?.tokenBudget) ?? DEFAULT_RUN_TOKEN_CAP)
  const configuredWallClock = positiveFinite(configured?.maxWallClockMs) ?? positiveFinite(contract?.wallClockBudgetMs)
  const maxWallClockMs = Math.min(ABSOLUTE_RUN_WALL_CLOCK_MS, configuredWallClock ?? DEFAULT_RUN_WALL_CLOCK_MS)
  const maxCostCny = configured?.maxCostCny === null || configured?.maxCostCny === undefined
    ? null
    : Math.min(ABSOLUTE_RUN_COST_CNY, positiveFinite(configured.maxCostCny) ?? 0)
  const configuredCost = (configured as (CompletionContract['providerCallBudget'] & { maxCost?: unknown }) | undefined)?.maxCost
  const maxCost = configuredCost !== undefined
    ? (configuredCost === null ? null : normalizeCostLimit(configuredCost) ?? { amount: 0, currency: null, unknownPolicy: 'deny' as const })
    : (maxCostCny === null ? null : { amount: maxCostCny, currency: 'CNY', unknownPolicy: 'deny' as const })
  return { maxCalls, maxTokens, maxCost, maxCostCny, maxWallClockMs }
}

export function tighterRunBudgetLimits(
  restored: RunBudgetState['limits'],
  configured: RunBudgetState['limits']
): RunBudgetState['limits'] {
  const minNullable = (left: number | null, right: number | null): number | null => {
    if (left === null) return right
    if (right === null) return left
    return Math.min(left, right)
  }
  const tightenCost = (left: RunCostLimit | null, right: RunCostLimit | null): RunCostLimit | null => {
    if (left === null) return right
    if (right === null) return left
    // A restored run is immutable. Different currencies cannot be converted
    // without a user-supplied rate, so preserve the old limit and let the
    // first quote raise a durable currency-mismatch block.
    if (left.currency !== null && right.currency !== null && left.currency !== right.currency) return { amount: 0, currency: null, unknownPolicy: 'deny' }
    return {
      amount: Math.min(left.amount, right.amount),
      currency: left.currency ?? right.currency,
      unknownPolicy: 'deny'
    }
  }
  return {
    maxCalls: minNullable(restored.maxCalls, configured.maxCalls),
    maxTokens: minNullable(restored.maxTokens, configured.maxTokens),
    maxCost: tightenCost(restored.maxCost, configured.maxCost),
    maxCostCny: minNullable(restored.maxCostCny, configured.maxCostCny),
    maxWallClockMs: minNullable(restored.maxWallClockMs, configured.maxWallClockMs)
  }
}

export function makeRunBudgetState(runId: string, config: RunConfig, startedAt: number, observedAt: number): RunBudgetState {
  return {
    ...(config.workBudgetPolicy === AGENT_WORK_BUDGET_POLICY ? { workBudgetPolicy: AGENT_WORK_BUDGET_POLICY, writerRounds: 0 } : {}),
    schemaVersion: 1,
    runId,
    startedAt,
    limits: runBudgetLimits(config),
    totalCalls: 0,
    callsByActor: emptyActorCounts(),
    retryCalls: 0,
    retriesByActor: emptyActorCounts(),
    knownInputTokens: 0,
    knownOutputTokens: 0,
    unknownTokenCalls: 0,
    spentCostUpper: 0,
    spentCostCurrency: null,
    reservedCost: 0,
    reservedCostCurrency: null,
    reservedCostAttempts: 0,
    costReservations: [],
    costReservationCorrupt: false,
    spentTokenUpper: 0,
    reservedInputTokens: 0,
    reservedOutputTokens: 0,
    reservedTokenAttempts: 0,
    tokenReservations: [],
    settledTokenReservations: [],
    tokenReservationCorrupt: false,
    knownCostCny: null,
    unknownCostCalls: 0,
    targetWindowRepairAttempts: 0,
    zeroProgressRounds: 0,
    lastWriterRound: null,
    recentWriterRounds: [],
    updatedAt: observedAt
  }
}

export interface ProviderBudgetAttempt {
  actor: RunBudgetActor
  logicalCallId?: string
  attemptNo: number
  outcome: string
  inputTokens: number | null
  outputTokens: number | null
  costStatus: 'actual' | 'estimated' | 'unknown'
  costAmount: number | null
  costCurrency?: string | null
  startedAt: number
}

export function deriveBudgetFromProviderAttempts(state: RunBudgetState, attempts: ProviderBudgetAttempt[], observedAt: number): RunBudgetState {
  if (attempts.length === 0) return state
  state = { ...state, costReservations: (state.costReservations ?? []).map(row => ({ ...row })) }
  const costByAttempt = new Map(state.costReservations!.map(row => [row.reservationId, row]))
  const attemptKey = (attempt: ProviderBudgetAttempt): string => `${attempt.logicalCallId ?? ''}\u0000${attempt.attemptNo}`
  // Recovery can observe the durable terminal attempt before the engine's
  // finally block persisted settlement. Charge its own reservation once.
  settleProviderCostBudget(state, attempts.filter(attempt => terminalProviderAttempt(attempt.outcome)).map(attemptKey), observedAt)
  const callsByActor = emptyActorCounts()
  const retriesByActor = emptyActorCounts()
  let knownInputTokens = 0
  let knownOutputTokens = 0
  let unknownTokenCalls = 0
  let knownCost = 0
  let hasKnownCost = false
  let knownCurrency: string | null = null
  let mixedCurrency = false
  let unknownCostCalls = 0
  let uncoveredKnownCost = 0
  for (const row of state.costReservations ?? []) {
    if (knownCurrency !== null && knownCurrency !== row.currency) mixedCurrency = true
    knownCurrency ??= row.currency
  }
  for (const attempt of attempts) {
    const actor = budgetActor(attempt.actor)
    callsByActor[actor] += 1
    if (attempt.attemptNo > 1) retriesByActor[actor] += 1
    if (typeof attempt.inputTokens === 'number' && Number.isFinite(attempt.inputTokens)) knownInputTokens += Math.max(0, attempt.inputTokens)
    else unknownTokenCalls += 1
    if (typeof attempt.outputTokens === 'number' && Number.isFinite(attempt.outputTokens)) knownOutputTokens += Math.max(0, attempt.outputTokens)
    else unknownTokenCalls += 1
    const currency = normalizeCurrency(attempt.costCurrency)
    const bound = state.costReservationCorrupt ? undefined : costByAttempt.get(attemptKey(attempt))
    const covered = bound !== undefined && (currency === null || currency === bound.currency)
    if (attempt.costStatus === 'unknown' || attempt.costAmount === null || !Number.isFinite(attempt.costAmount) || attempt.costAmount < 0 || currency === null) {
      if (!covered) unknownCostCalls += 1
    }
    else {
      if (knownCurrency !== null && knownCurrency !== currency) mixedCurrency = true
      knownCurrency ??= currency
      hasKnownCost = true
      knownCost += Math.max(0, attempt.costAmount)
      if (!covered) uncoveredKnownCost += attempt.costAmount
      else if (bound.settledAt !== null && attempt.costAmount > bound.amount) {
        // A real amount larger than its reservation must increase the ledger,
        // not hide underneath another attempt's unused conservative margin.
        state.spentCostUpper += attempt.costAmount - bound.amount
        bound.amount = attempt.costAmount
      }
    }
  }
  if (state.spentCostCurrency !== null && knownCurrency !== null && state.spentCostCurrency !== knownCurrency) mixedCurrency = true
  const settledUpper = (state.costReservations ?? []).filter(row => row.settledAt !== null).reduce((sum, row) => sum + row.amount, 0)
  return {
    ...state,
    totalCalls: Math.max(state.totalCalls, attempts.length),
    callsByActor: {
      writer: Math.max(state.callsByActor.writer, callsByActor.writer),
      critic: Math.max(state.callsByActor.critic, callsByActor.critic),
      editor: Math.max(state.callsByActor.editor, callsByActor.editor)
    },
    retryCalls: Math.max(state.retryCalls, retriesByActor.writer + retriesByActor.critic + retriesByActor.editor),
    retriesByActor: {
      writer: Math.max(state.retriesByActor.writer, retriesByActor.writer),
      critic: Math.max(state.retriesByActor.critic, retriesByActor.critic),
      editor: Math.max(state.retriesByActor.editor, retriesByActor.editor)
    },
    knownInputTokens: Math.max(state.knownInputTokens, knownInputTokens),
    knownOutputTokens: Math.max(state.knownOutputTokens, knownOutputTokens),
    unknownTokenCalls: Math.max(state.unknownTokenCalls, unknownTokenCalls),
    // Never sum amounts whose currencies differ.  A mixed legacy ledger is
    // retained as an unknown-cost block until the user supplies a single
    // explicit currency policy.
    knownCostCny: !mixedCurrency && knownCurrency === 'CNY' && hasKnownCost ? Math.max(state.knownCostCny ?? 0, knownCost) : state.knownCostCny,
    spentCostCurrency: mixedCurrency ? null : (state.spentCostCurrency ?? knownCurrency),
    spentCostUpper: !mixedCurrency ? Math.max(state.spentCostUpper, settledUpper + uncoveredKnownCost) : state.spentCostUpper,
    // The repository supplies the complete attempt inventory. Missing billing
    // detail is unresolved only when neither a known cost nor that attempt's
    // durable pre-fetch bound covers it; never borrow another call's bound.
    unknownCostCalls: unknownCostCalls + (mixedCurrency || state.costReservationCorrupt ? 1 : 0),
    updatedAt: observedAt
  }
}

export function tokenConsumedUpper(state: RunBudgetState): number {
  return Math.max(state.spentTokenUpper, state.knownInputTokens + state.knownOutputTokens)
}

export function tokenReservedUpper(state: RunBudgetState): number {
  return state.reservedInputTokens + state.reservedOutputTokens
}

function terminalProviderAttempt(outcome: string): boolean {
  return outcome !== 'in_flight'
}

/** Reconcile a reservation with a durable provider attempt after restart.
 * In-flight rows retain their reservation. Terminal rows with missing usage
 * consume the original upper bound, so a crash cannot turn unknown usage into
 * free capacity. */
export function reconcileTokenReservationsFromProviderAttempts(
  state: RunBudgetState,
  attempts: ProviderBudgetAttempt[],
  observedAt: number
): RunBudgetState {
  if (state.tokenReservations.length === 0 || attempts.length === 0) return state
  const remaining: RunTokenReservation[] = []
  const settled = [...state.settledTokenReservations]
  const settledIds = new Set(settled.map((entry) => entry.reservationId))
  let spentTokenUpper = state.spentTokenUpper
  let tokenReservationCorrupt = state.tokenReservationCorrupt
  for (const reservation of state.tokenReservations) {
    const attempt = attempts.find((candidate) => candidate.logicalCallId === reservation.logicalCallId && candidate.attemptNo === reservation.innerAttempt && terminalProviderAttempt(candidate.outcome))
    if (!attempt) {
      remaining.push(reservation)
      continue
    }
    const hasActual = typeof attempt.inputTokens === 'number' && Number.isFinite(attempt.inputTokens) && attempt.inputTokens >= 0 &&
      typeof attempt.outputTokens === 'number' && Number.isFinite(attempt.outputTokens) && attempt.outputTokens >= 0
    const actual = hasActual ? Math.floor(attempt.inputTokens as number) + Math.floor(attempt.outputTokens as number) : reservation.totalTokens
    if (!Number.isSafeInteger(actual)) {
      tokenReservationCorrupt = true
      spentTokenUpper = Number.MAX_SAFE_INTEGER
    } else {
      spentTokenUpper = Math.min(Number.MAX_SAFE_INTEGER, spentTokenUpper + actual)
      if (hasActual && actual > reservation.totalTokens) tokenReservationCorrupt = true
    }
    if (!settledIds.has(reservation.reservationId)) {
      settled.push({ reservationId: reservation.reservationId, chargedTokens: Number.isSafeInteger(actual) ? actual : Number.MAX_SAFE_INTEGER, settledAt: observedAt })
      settledIds.add(reservation.reservationId)
    } else {
      tokenReservationCorrupt = true
    }
  }
  return {
    ...state,
    spentTokenUpper,
    tokenReservations: remaining,
    ...tokenReservationTotals(remaining),
    settledTokenReservations: settled.slice(-MAX_TOKEN_LEDGER_ITEMS),
    tokenReservationCorrupt,
    updatedAt: observedAt
  }
}

function tokenReservationTotals(reservations: RunTokenReservation[]): Pick<RunBudgetState, 'reservedInputTokens' | 'reservedOutputTokens' | 'reservedTokenAttempts'> {
  return {
    reservedInputTokens: reservations.reduce((sum, entry) => sum + entry.inputTokens, 0),
    reservedOutputTokens: reservations.reduce((sum, entry) => sum + entry.outputTokens, 0),
    reservedTokenAttempts: reservations.length
  }
}

export const budgetMessage = (code: ProviderBudgetFailureCode, state: RunBudgetState): string => {
  if (code === 'run_provider_call_cap') return `已达到本次运行的 Provider 调用硬上限 ${state.limits.maxCalls}（writer ${state.callsByActor.writer}、critic ${state.callsByActor.critic}、editor ${state.callsByActor.editor}、inner retry ${state.retryCalls}），已暂停以避免失控调用`
  if (code === 'run_token_budget') return `已达到本次运行的 token 硬上限 ${state.limits.maxTokens ?? 0}（已结算上界 ${tokenConsumedUpper(state)}、已保留 ${tokenReservedUpper(state)}），未发送请求`
  if (code === 'run_cost_currency_mismatch') return `Provider 费用币种与本次运行预算不一致（预算 ${state.limits.maxCost?.currency ?? '未知'}，账本 ${state.spentCostCurrency ?? state.reservedCostCurrency ?? '未知'}），未发送请求`
  if (code === 'run_cost_unknown_price') return 'Provider 价格或用量未知，无法在费用硬上限下安全继续，已暂停（请为该模型提供带币种的价格快照）'
  if (code === 'run_cost_reservation_overrun') return 'Provider 实际费用超过预请求保留上限，已暂停并保留超支证据'
  if (code === 'run_cost_budget') {
    const limit = state.limits.maxCost
    const currency = state.spentCostCurrency ?? state.reservedCostCurrency ?? limit?.currency ?? ''
    return `已达到本次运行的费用硬上限 ${currency ? `${currency} ` : ''}${limit?.amount.toFixed(6) ?? '未知'}（已保留/计入上限 ${state.spentCostUpper.toFixed(6)}），已暂停`
  }
  if (code === 'run_budget_persistence') return '运行预算账本无法持久化，已拒绝继续调用 Provider；请检查存储后重试'
  if (code === 'run_target_window_repair_exhausted') return `正文已达到目标窗口，但场景仍有未完成 beat；已完成 ${MAX_TARGET_WINDOW_REPAIRS} 次有界修复，等待你的决定`
  return `已达到本次运行的墙钟硬上限 ${state.limits.maxWallClockMs}ms，已暂停以避免失控调用`
}

/** Reserve the worst-case spend for one provider attempt before fetch.  The
 * quote is produced from the exact request envelope and a frozen price
 * snapshot by runKernelAdapter; no amount from another currency is ever
 * converted or added. */
export const assertCostReservation = (state: RunBudgetState, quote: ProviderCostQuote | undefined): void => {
  const limit = state.limits.maxCost
  if (!limit) return
  if (state.costReservationCorrupt || state.unknownCostCalls > 0) throw new RunBudgetExceededError('run_cost_unknown_price', budgetMessage('run_cost_unknown_price', state))
  if (!quote || quote.status !== 'estimated' || quote.amount === null || !Number.isFinite(quote.amount) || quote.amount < 0) {
    throw new RunBudgetExceededError('run_cost_unknown_price', budgetMessage('run_cost_unknown_price', state))
  }
  const currency = normalizeCurrency(quote.currency)
  if (!currency) throw new RunBudgetExceededError('run_cost_unknown_price', budgetMessage('run_cost_unknown_price', state))
  if (limit.currency !== null && limit.currency !== currency) {
    throw new RunBudgetExceededError('run_cost_currency_mismatch', budgetMessage('run_cost_currency_mismatch', { ...state, reservedCostCurrency: currency }))
  }
  if (state.spentCostCurrency !== null && state.spentCostCurrency !== currency) {
    throw new RunBudgetExceededError('run_cost_currency_mismatch', budgetMessage('run_cost_currency_mismatch', { ...state, reservedCostCurrency: currency }))
  }
  if (state.reservedCostCurrency !== null && state.reservedCostCurrency !== currency) {
    throw new RunBudgetExceededError('run_cost_currency_mismatch', budgetMessage('run_cost_currency_mismatch', { ...state, reservedCostCurrency: currency }))
  }
  const amount = Math.max(0, quote.amount)
  const projected = state.spentCostUpper + state.reservedCost + amount
  if (projected > limit.amount + Number.EPSILON) {
    throw new RunBudgetExceededError('run_cost_budget', budgetMessage('run_cost_budget', { ...state, reservedCostCurrency: currency }))
  }
  state.reservedCostCurrency = currency
  state.reservedCost += amount
  state.reservedCostAttempts += 1
  state.spentCostCurrency ??= currency
}

/** Preserve the full frozen quote by attempt identity, including zero-priced
 * calls. Repeated callbacks may top up a bound but cannot reserve it twice. */
export function reserveProviderCostBudget(state: RunBudgetState, logicalCallId: string, innerAttempt: number, quote: ProviderCostQuote | undefined, observedAt: number): boolean {
  if (!state.limits.maxCost) return false
  const reservationId = `${logicalCallId}\u0000${innerAttempt}`
  if (!normalizedReservationId(logicalCallId) || !normalizedReservationId(reservationId) || !Number.isSafeInteger(innerAttempt) || innerAttempt < 1 || (state.workBudgetPolicy !== AGENT_WORK_BUDGET_POLICY && (state.costReservations?.length ?? 0) >= MAX_TOKEN_LEDGER_ITEMS)) {
    throw new RunBudgetExceededError('run_cost_unknown_price', budgetMessage('run_cost_unknown_price', state))
  }
  const existing = state.costReservations?.find(row => row.reservationId === reservationId)
  if (existing && existing.settledAt !== null) return false
  if (!quote || quote.status !== 'estimated' || quote.amount === null || !Number.isFinite(quote.amount) || quote.amount < 0) {
    throw new RunBudgetExceededError('run_cost_unknown_price', budgetMessage('run_cost_unknown_price', state))
  }
  if (existing) {
    if (normalizeCurrency(quote.currency) !== existing.currency) {
      throw new RunBudgetExceededError('run_cost_unknown_price', budgetMessage('run_cost_unknown_price', state))
    }
    if (quote.amount <= existing.amount) return false
  }
  const amount = Math.max(0, (quote?.amount ?? 0) - (existing?.amount ?? 0))
  assertCostReservation(state, quote ? { ...quote, amount } : quote)
  if (existing) {
    existing.amount += amount
    state.reservedCostAttempts -= 1
  } else {
    ;(state.costReservations ??= []).push({ reservationId, logicalCallId, innerAttempt, amount, currency: state.reservedCostCurrency!,
      priceSnapshotId: quote?.priceSnapshotId ?? null, reservedAt: observedAt, settledAt: null })
  }
  state.updatedAt = observedAt
  return true
}

/** Settle only the caller's reservations, retaining their identity as durable
 * proof. Other concurrent attempts remain held; duplicate finalizers are no-ops. */
export function settleProviderCostBudget(state: RunBudgetState, reservationIds: readonly string[], observedAt: number): boolean {
  if (state.costReservationCorrupt) return false
  const ids = new Set(reservationIds)
  let changed = false
  for (const row of state.costReservations ?? []) {
    if (row.settledAt !== null || !ids.has(row.reservationId)) continue
    state.spentCostUpper += row.amount
    state.spentCostCurrency ??= row.currency
    state.reservedCost = Math.max(0, state.reservedCost - row.amount)
    state.reservedCostAttempts -= 1
    row.settledAt = observedAt
    changed = true
  }
  if (state.reservedCostAttempts === 0) { state.reservedCost = 0; state.reservedCostCurrency = null }
  if (changed) state.updatedAt = observedAt
  return changed
}

export const reserveProviderAttemptBudget = (state: RunBudgetState, actor: RunBudgetActor, innerAttempt: number, targetWindowRepair: boolean, observedAt: number): void => {
  const elapsed = Math.max(0, observedAt - state.startedAt)
  if (state.limits.maxWallClockMs !== null && elapsed >= state.limits.maxWallClockMs) throw new RunBudgetExceededError('run_wall_clock_budget', budgetMessage('run_wall_clock_budget', state))
  if (state.tokenReservationCorrupt) throw new RunBudgetExceededError('run_token_budget', budgetMessage('run_token_budget', state))
  const projectedTokens = tokenConsumedUpper(state) + tokenReservedUpper(state)
  if (state.limits.maxTokens !== null && projectedTokens >= state.limits.maxTokens) throw new RunBudgetExceededError('run_token_budget', budgetMessage('run_token_budget', state))
  if (state.limits.maxCost !== null && (state.unknownCostCalls > 0 || state.costReservationCorrupt)) {
    throw new RunBudgetExceededError('run_cost_unknown_price', budgetMessage('run_cost_unknown_price', state))
  }
  // amount=0/currency=null is the deny-until-priced sentinel. Enforce that
  // sentinel at the exact pre-fetch quote boundary below; doing it here
  // would also reject synthetic/test model calls that never reach fetch.
  if (state.limits.maxCost !== null && state.limits.maxCost.amount > 0 && state.spentCostUpper >= state.limits.maxCost.amount && state.reservedCostAttempts === 0) {
    throw new RunBudgetExceededError('run_cost_budget', budgetMessage('run_cost_budget', state))
  }
  if (targetWindowRepair && actor === 'writer' && state.targetWindowRepairAttempts >= MAX_TARGET_WINDOW_REPAIRS) {
    throw new RunBudgetExceededError('run_target_window_repair_exhausted', budgetMessage('run_target_window_repair_exhausted', state))
  }
  if (state.limits.maxCalls !== null && state.totalCalls >= state.limits.maxCalls) throw new RunBudgetExceededError('run_provider_call_cap', budgetMessage('run_provider_call_cap', state))
  state.totalCalls += 1
  state.callsByActor[actor] += 1
  if (innerAttempt > 1) {
    state.retryCalls += 1
    state.retriesByActor[actor] += 1
  }
  // Count a bounded scene repair at the actual logical provider reservation,
  // after all other hard gates pass.  Merely observing a pending scene (or
  // reaching the loop head after a restart) is not a repair attempt.
  if (targetWindowRepair && actor === 'writer') state.targetWindowRepairAttempts += 1
}

/** `corrupt` requires persistence before reporting denial; `unchanged`
 * must not enqueue a write (duplicate callbacks and settlement tombstones). */
export function reserveProviderTokenBudget(
  state: RunBudgetState,
  logicalCallId: string,
  innerAttempt: number,
  request: ProviderTokenRequestBoundary,
  observedAt: number
): 'changed' | 'unchanged' | 'corrupt' {
  if (state.limits.maxTokens === null) return 'unchanged'
  if (state.tokenReservationCorrupt) throw new RunBudgetExceededError('run_token_budget', budgetMessage('run_token_budget', state))
  if (!logicalCallId || logicalCallId.length > MAX_TOKEN_RESERVATION_ID_CHARS || !Number.isInteger(innerAttempt) || innerAttempt < 1) {
    state.tokenReservationCorrupt = true
    return 'corrupt'
  }
  const reservationId = `${logicalCallId}\u0000${innerAttempt}`
  if (reservationId.length > MAX_TOKEN_RESERVATION_ID_CHARS) {
    state.tokenReservationCorrupt = true
    return 'corrupt'
  }
  if (state.settledTokenReservations.some((entry) => entry.reservationId === reservationId)) return 'unchanged'
  const estimate = estimateProviderTokenUpperBound(request)
  if (!estimate) throw new RunBudgetExceededError('run_token_budget', budgetMessage('run_token_budget', state))
  const existing = state.tokenReservations.find((entry) => entry.reservationId === reservationId)
  const currentInput = existing?.inputTokens ?? 0
  const currentOutput = existing?.outputTokens ?? 0
  const nextInput = Math.max(currentInput, estimate.inputTokens)
  const nextOutput = Math.max(currentOutput, estimate.outputTokens)
  const additional = nextInput - currentInput + nextOutput - currentOutput
  if (additional <= 0) return 'unchanged'
  if (state.tokenReservations.length >= MAX_TOKEN_LEDGER_ITEMS && !existing) {
    state.tokenReservationCorrupt = true
    throw new RunBudgetExceededError('run_token_budget', budgetMessage('run_token_budget', state))
  }
  const elapsed = Math.max(0, observedAt - state.startedAt)
  if (state.limits.maxWallClockMs !== null && elapsed >= state.limits.maxWallClockMs) throw new RunBudgetExceededError('run_wall_clock_budget', budgetMessage('run_wall_clock_budget', state))
  const projected = tokenConsumedUpper(state) + tokenReservedUpper(state) + additional
  if (projected > state.limits.maxTokens) throw new RunBudgetExceededError('run_token_budget', budgetMessage('run_token_budget', state))
  if (existing) {
    existing.inputTokens = nextInput
    existing.outputTokens = nextOutput
    existing.totalTokens = nextInput + nextOutput
    existing.requestHash = estimate.requestHash
  } else {
    state.tokenReservations.push({
      reservationId,
      logicalCallId,
      innerAttempt,
      inputTokens: estimate.inputTokens,
      outputTokens: estimate.outputTokens,
      totalTokens: estimate.totalTokens,
      requestHash: estimate.requestHash,
      reservedAt: observedAt
    })
  }
  Object.assign(state, tokenReservationTotals(state.tokenReservations))
  return 'changed'
}

/** Mutate each reservation at most once; failed retries consume their upper
 * bound and only the final attempt receives a complete terminal usage pair. */
export function settleProviderTokenBudget(
  state: RunBudgetState,
  reservations: Array<{ reservationId: string; innerAttempt: number }>,
  usage: { inputTokens?: number; outputTokens?: number } | null,
  observedAt: number
): { changed: boolean; overrun: boolean } {
  let overrun = false
  const validUsage = usage !== null && typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0 &&
    typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0
  const finalReservation = reservations.reduce<{ reservationId: string; innerAttempt: number } | null>((latest, item) => !latest || item.innerAttempt > latest.innerAttempt ? item : latest, null)
  let changed = false
  for (const item of reservations) {
    const index = state.tokenReservations.findIndex((entry) => entry.reservationId === item.reservationId)
    if (index < 0) continue
    const reservation = state.tokenReservations[index]
    const actual = validUsage && finalReservation?.reservationId === item.reservationId
      ? Math.floor(usage.inputTokens as number) + Math.floor(usage.outputTokens as number)
      : reservation.totalTokens
    const charged = Number.isSafeInteger(actual) ? actual : Number.MAX_SAFE_INTEGER
    if (validUsage && finalReservation?.reservationId === item.reservationId && charged > reservation.totalTokens) overrun = true
    state.spentTokenUpper = Math.min(Number.MAX_SAFE_INTEGER, state.spentTokenUpper + charged)
    state.tokenReservations.splice(index, 1)
    state.settledTokenReservations = state.settledTokenReservations.filter((entry) => entry.reservationId !== item.reservationId)
    state.settledTokenReservations.push({ reservationId: item.reservationId, chargedTokens: charged, settledAt: observedAt })
    if (state.settledTokenReservations.length > MAX_TOKEN_LEDGER_ITEMS) state.settledTokenReservations.splice(0, state.settledTokenReservations.length - MAX_TOKEN_LEDGER_ITEMS)
    changed = true
  }
  if (!changed) return { changed, overrun }
  if (overrun) state.tokenReservationCorrupt = true
  Object.assign(state, tokenReservationTotals(state.tokenReservations))
  return { changed, overrun }
}
