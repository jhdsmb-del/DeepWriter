export * from '../shared/types'
import type { ApiErrorInfo, ChatParams, ChunkEvent, DsMessage, ToolCall, Usage } from '../shared/types'
import { estimateTokens } from '../shared/types'
import { normalizeDeepSeekReasoningEffort } from '../shared/deepseekReasoning'
import { codePointLength, selectNaturalEnding, takeCodePoints } from '../shared/textMetrics'
import { createHash } from 'node:crypto'
import { canonicalJoin, secureProviderFetch } from './providerSecurity'
import { streamWithProviderAdapter } from './providerAdapters'
import { buildProviderAuthHeaders, providerHttpErrorMessage } from './providerAuth'
import { createProviderPerformance, createToolOutputMeter, readPerformanceUsage } from './providerPerformance'
import type { ProviderPerformanceUsage } from '../shared/performanceTelemetry'

export const DEFAULT_BASE_URL = 'https://api.deepseek.com'
export const BETA_BASE_URL = 'https://api.deepseek.com/beta'

/** OpenAI Chat tool fields are ordered deltas.  Equal adjacent fragments are
 * valid (`ab` + `ab`, repeated braces, or repeated Unicode), therefore only
 * a provider-supplied event id/sequence can justify de-duplication. */
function appendToolDelta(previous: string, incoming: string): string {
  return previous + incoming
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function eventAuthority(json: any): string | null {
  const value = json?.sequence_number ?? json?.event_id
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.length > 0) return value
  return null
}

function protocolMismatch(field: string): Error & { code: string } {
  const error = new Error(`provider_protocol_mismatch:${field}`) as Error & { code: string }
  error.name = 'ProviderProtocolError'
  error.code = 'provider_protocol_mismatch'
  return error
}

export class ApiStatusError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiStatusError'
    this.status = status
  }
  static [Symbol.hasInstance](obj: unknown): boolean {
    if (obj == null || typeof obj !== 'object') return false
    const err = obj as Error & { status?: unknown }
    return typeof err.status === 'number' && typeof err.message === 'string'
  }
}

const truncateMsg = (msg: string): string => (msg.length > 500 ? `${msg.slice(0, 500)}…` : msg)

const OVERALL_TIMEOUT_MS = 30 * 60 * 1000
// R25 反证 CE5 需要可快速触发的 abort/timeout 探针：测试环境可用 env 覆盖（生产不设置，保持 60s/120s 默认）
const FIRST_BYTE_TIMEOUT_MS = Number(process.env.DEEPSEEK_EVAL_FIRST_BYTE_TIMEOUT_MS ?? 60 * 1000)
const IDLE_TIMEOUT_MS = Number(process.env.DEEPSEEK_EVAL_IDLE_TIMEOUT_MS ?? 120 * 1000)
const RETRY_DELAY_MS = 2000
const MAX_RETRIES = 1

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** R23-R05：请求/费用硬熔断（eval runner 经 __evalPreRequest 钩子拦截；生产无钩子不触发） */
export class BudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetExhaustedError'
  }
}

const isRetryableError = (err: unknown): boolean => {
  const e = err as Error & { status?: unknown }
  if (e?.name === 'AbortError') return false
  if (e?.name === 'TimeoutError') return false
  if (e?.name === 'BudgetExhaustedError') return false
  if (typeof e?.status === 'number') {
    const status = e.status
    return status === 429 || (status >= 500 && status < 600)
  }
  if (e instanceof TypeError || /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|Failed to fetch/i.test(e?.message ?? '')) {
    return true
  }
  return false
}

export function classifyApiError(err: unknown): ApiErrorInfo {
  const e = err as Error & { status?: unknown }
  if (e?.name === 'AbortError') return { kind: 'timeout', message: '已停止', retryable: false }
  if (e?.name === 'TimeoutError') return { kind: 'timeout', message: '请求超时', retryable: true }
  if (typeof e?.status === 'number') {
    const status = e.status
    if (status === 401) return { kind: 'unauthorized', message: providerHttpErrorMessage(status), retryable: false }
    if (status === 402) return { kind: 'insufficient_balance', message: providerHttpErrorMessage(status), retryable: false }
    if (status === 429) return { kind: 'rate_limited', message: providerHttpErrorMessage(status), retryable: true }
    if (status >= 500 && status < 600) return { kind: 'server_error', message: providerHttpErrorMessage(status), retryable: true }
    return { kind: 'unknown', message: truncateMsg(e.message ?? String(err)), retryable: false }
  }
  if (e instanceof TypeError || /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|Failed to fetch/i.test(e?.message ?? '')) {
    return { kind: 'network', message: '网络连接失败，请检查网络或代理设置', retryable: true }
  }
  return { kind: 'unknown', message: truncateMsg(e?.message ?? String(err)), retryable: false }
}

export function isCjk(c: string): boolean {
  const code = c.codePointAt(0)!
  return code >= 0x3000 && code <= 0x9fff
}

// ---------------- R22 / Codex P0-02：provider 边界 request-attempt 回调 ----------------
// 记录点 = 最终 provider 请求边界（实际 fetch 调用前后），不反推。streamChat 在每次内层
// for-attempt 循环的 fetch 前后产出一次 ProviderAttemptInfo（innerAttempt 递增、outcome 由结果判定）。
// 语义说明：
//  - deepwriter 链经 runKernelAdapter.ts 的 createModelCallAdapter 调用 streamChat，该调用不传
//    onAttempt 参数（runKernelAdapter 不在本次改动面）。因此这里同时提供 globalThis 兜底缝
//    globalThis.__evalStreamAttempt——runner 在 bundle 边界设置它，两个 bundle 共享同一 Node
//    globalThis，从而 bridging 到真实 fetch 边界。onAttempt 参数若显式传入优先于 globalThis。
//  - 只在「实际发出 fetch」时回调；hash 字段由本模块按实际发往 provider 的 messages 就地计算，
//    与 scripts/eval-schema.ts 的 roleHash/systemHash/assembledHash/historyHash 严格同口径。

export interface StreamAttemptInfo {
  innerAttempt: number
  outcome: 'success' | 'http_error' | 'transport_error' | 'aborted'
  httpStatus: number | null
  usagePresent: boolean
  usage: Record<string, number | null> | null
  actualMessageRoles: string[]
  actualUserHash: string
  actualHistoryHash: string
  actualSystemHash: string
  actualAssembledHash: string
  actualMessageContentHashes: string[]
  actualHistoryTurnHashes: Array<{ role: 'user' | 'assistant'; sha256: string }>
  startedAt: string
  durationMs: number
}

/** Exact serialized request envelope available immediately before fetch. */
export interface ProviderRequestBoundary {
  bodyJson: string
  model: string
  maxTokens: number
}

export type StreamAttemptCallback = (info: StreamAttemptInfo) => void

export type ProviderAttemptLifecycleEvent =
  | { type: 'started'; innerAttempt: number; startedAt: number }
  | { type: 'first_token'; innerAttempt: number; firstTokenAt: number }
  | {
      type: 'terminal'
      innerAttempt: number
      outcome: 'success' | 'http_error' | 'transport_error' | 'timeout' | 'cancelled'
      httpStatus: number | null
      providerRequestId: string | null
      endedAt: number
      usage: Record<string, number | null> | null
      performanceUsage?: ProviderPerformanceUsage
    }

export type ProviderAttemptLifecycleCallback = (event: ProviderAttemptLifecycleEvent) => void

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex')

/** 规范化 messages 的 history 部分 hash（与 scripts/eval-schema.ts historyHash 严格同口径） */
function historyHashOf(messages: DsMessage[]): string {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break }
  }
  const history = lastUserIdx > 0
    ? messages.slice(0, lastUserIdx).filter((m) => m.role === 'user' || m.role === 'assistant')
    : []
  return sha256Hex(JSON.stringify(history.map((m) => ({ role: m.role, content: m.content ?? '' }))))
}

/** 由实际发往 provider 的 messages 就地计算四个 hash 与角色序列（不反推） */
function buildActualHashes(messages: DsMessage[]): {
  roles: string[]
  userHash: string
  historyHash: string
  systemHash: string
  assembledHash: string
  messageContentHashes: string[]
  historyTurnHashes: Array<{ role: 'user' | 'assistant'; sha256: string }>
} {
  const cnt = (m: DsMessage): string => m.content ?? ''
  // history 切片：最后一条 user 之前的 user/assistant 消息（与 historyHashOf 严格同口径）
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break }
  }
  const history = lastUserIdx > 0
    ? messages.slice(0, lastUserIdx).filter((m) => m.role === 'user' || m.role === 'assistant')
    : []
  return {
    roles: messages.map((m) => m.role),
    userHash: messages.some((m) => m.role === 'user')
      ? sha256Hex(messages.filter((m) => m.role === 'user').map(cnt).join('\n'))
      : sha256Hex(''),
    historyHash: historyHashOf(messages),
    systemHash: sha256Hex(messages.filter((m) => m.role === 'system').map(cnt).join('\n')),
    assembledHash: sha256Hex(JSON.stringify(messages.map((m) => ({ role: m.role, content: cnt(m) })))),
    messageContentHashes: messages.map((m) => sha256Hex(cnt(m))),
    historyTurnHashes: history.map((m) => ({ role: m.role as 'user' | 'assistant', sha256: sha256Hex(cnt(m)) }))
  }
}

export function formatFee(cny: number): string {
  if (cny < 0.01) return `${Math.round(cny * 1000) / 10} 厘`
  return `${cny.toFixed(4)} 元`
}

export async function streamChat(
  params: ChatParams,
  onEvent: (ev: ChunkEvent) => void,
  signal?: AbortSignal,
  onRetry?: (attempt: number) => void,
  onAttempt?: StreamAttemptCallback,
  onAttemptLifecycle?: ProviderAttemptLifecycleCallback,
  beforeAttempt?: (innerAttempt: number, request?: ProviderRequestBoundary) => void | Promise<void>
): Promise<{ finishReason: string | null; usage: Usage | null }> {
  const performance = createProviderPerformance(snapshot => onEvent({ type: 'performance', performance: snapshot }))
  try {
    return await streamChatInternal(params, event => { performance.chunk(event); onEvent(event) }, signal, onRetry, onAttempt,
      event => { performance.lifecycle(event); onAttemptLifecycle?.(event) }, beforeAttempt)
  } finally {
    performance.close()
  }
}

async function streamChatInternal(
  params: ChatParams,
  onEvent: (ev: ChunkEvent) => void,
  signal?: AbortSignal,
  onRetry?: (attempt: number) => void,
  onAttempt?: StreamAttemptCallback,
  onAttemptLifecycle?: ProviderAttemptLifecycleCallback,
  beforeAttempt?: (innerAttempt: number, request?: ProviderRequestBoundary) => void | Promise<void>
): Promise<{ finishReason: string | null; usage: Usage | null }> {
  // Native/official protocols are dispatched through their own wire adapter;
  // the legacy branch below remains the DeepSeek-compatible Chat path.
  if (params.provider?.protocol && params.provider.protocol !== 'deepseek-chat') {
    return streamWithProviderAdapter(params, onEvent, signal, onRetry, onAttempt, onAttemptLifecycle, beforeAttempt)
  }
  const customProvider = params.provider?.adapterId === 'custom.openai-compatible-chat'
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages.map((m) => {
      if (!m.tool_calls || m.tool_calls.length === 0) return m
      return {
        ...m,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments }
        }))
      }
    }),
    stream: true,
    stream_options: { include_usage: true },
    ...(!params.omitOutputTokenLimit ? { max_tokens: params.maxTokens ?? 8192 } : {})
  }
  if (!customProvider) {
    const automatic = params.thinking.effort === 'default' && params.provider?.reasoning.mode !== 'enabled' && params.provider?.reasoning.mode !== 'disabled'
    const effort = normalizeDeepSeekReasoningEffort(params.thinking.effort)
    if (params.thinking.enabled && effort === null) throw new Error('DeepSeek 推理强度不受支持，未发送请求')
    const enabled = params.thinking.enabled && effort !== 'none'
    if (!automatic) body.thinking = { type: enabled ? 'enabled' : 'disabled' }
    if (enabled && params.thinking.effort !== 'default') {
      body.reasoning_effort = effort
    }
  } else if (
    params.provider?.reasoning.mode === 'enabled' &&
    params.provider.compatibilityMappingId === 'openai_chat.reasoning_effort_top_level' &&
    params.provider.reasoning.effort
  ) {
    body.reasoning_effort = params.provider.reasoning.effort
  }
  if ((!params.thinking.enabled && (params.thinking.effort !== 'default' || params.provider?.reasoning.mode === 'disabled')) || customProvider) {
    body.temperature = params.temperature ?? 1
    body.top_p = params.topP ?? 1
  }
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools
    body.tool_choice = params.toolChoice ?? 'auto'
  }
  if (params.user) body.user_id = params.user

  // R25-P1-01：实际即将发送的 request body 序列化一次，fetch 与费用预留共用同一份字节口径
  const bodyJson = JSON.stringify(body)

  const innerAbort = new AbortController()
  if (signal?.aborted) innerAbort.abort()
  else signal?.addEventListener('abort', () => innerAbort.abort())

  let finishReason: string | null = null
  let usage: Usage | null = null
  let receivedAny = false

  // R22 / Codex P0-02：attempt 回调解析（显式参数优先；globalThis 兜底桥接 runKernelAdapter 路径）
  const attemptHook: StreamAttemptCallback | null =
    onAttempt ?? ((globalThis as unknown as { __evalStreamAttempt?: StreamAttemptCallback }).__evalStreamAttempt ?? null)
  // 实际发往 provider 的 messages 的四个 hash（retry 期间 body 不变，一次算足）
  const actualHashes = attemptHook ? buildActualHashes(params.messages) : null

  for (let attempt = 0; ; attempt++) {
    const innerAttempt = attempt + 1
    let attemptStartedAt: number | null = null
    let attemptOutcome: 'success' | 'http_error' | 'transport_error' | 'aborted' = 'transport_error'
    let attemptHttpStatus: number | null = null
    let attemptUsage: Record<string, number | null> | null = null
    let performanceUsage: ProviderPerformanceUsage | undefined
    let attemptFirstTokenAt: number | null = null
    let providerRequestId: string | null = null
    let lifecycleTerminalEmitted = false
    const emitAttempt = (): void => {
      if (attemptStartedAt == null) return
      const durationMs = Date.now() - attemptStartedAt
      if (attemptHook && actualHashes) {
        attemptHook({
          innerAttempt,
          outcome: attemptOutcome,
          httpStatus: attemptHttpStatus,
          usagePresent: attemptUsage != null,
          usage: attemptUsage,
          actualMessageRoles: actualHashes.roles,
          actualUserHash: actualHashes.userHash,
          actualHistoryHash: actualHashes.historyHash,
          actualSystemHash: actualHashes.systemHash,
          actualAssembledHash: actualHashes.assembledHash,
          actualMessageContentHashes: actualHashes.messageContentHashes,
          actualHistoryTurnHashes: actualHashes.historyTurnHashes,
          startedAt: new Date(attemptStartedAt).toISOString(),
          durationMs
        })
      }
      if (!lifecycleTerminalEmitted && onAttemptLifecycle) {
        lifecycleTerminalEmitted = true
        onAttemptLifecycle({
          type: 'terminal',
          innerAttempt,
          outcome: timedOut ? 'timeout' : attemptOutcome === 'aborted' ? 'cancelled' : attemptOutcome,
          httpStatus: attemptHttpStatus,
          providerRequestId,
          endedAt: Date.now(),
          usage: attemptUsage,
          performanceUsage
        })
      }
    }
    let timedOut = false
    let timeoutMsg = '请求超时（30 分钟）'
    const failTimeout = (msg: string): void => {
      timedOut = true
      timeoutMsg = msg
      innerAbort.abort()
    }
    const overallTimer = setTimeout(() => failTimeout('请求超时（30 分钟）'), OVERALL_TIMEOUT_MS)
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const clearTimers = (): void => {
      clearTimeout(overallTimer)
      if (firstByteTimer) clearTimeout(firstByteTimer)
      if (idleTimer) clearTimeout(idleTimer)
    }

    // R23-R05：每次 fetch 前的硬熔断钩子（eval runner 设置 globalThis.__evalPreRequest）。
    // blocked 时不发请求、不产生 attempt（attemptStartedAt 未置位 → emitAttempt 空操作）。
    // R24-P0-03/R25-P1-01：钩子接收实际即将发送的 request body JSON（byte ceiling 口径）+ model/maxTokens 做
    // fetch 前费用 reservation；返回 reservedCny 由本循环在 usage 到达后经 __evalPostRequest 对账。
    const preGate = (globalThis as unknown as {
      __evalPreRequest?: (bodyJson: string, model: string, maxTokens: number) => { blocked: boolean; reason?: string; reservedCny: number }
    }).__evalPreRequest
    let currentReservationCny = 0
    const postGate = (globalThis as unknown as {
      __evalPostRequest?: (usage: Record<string, number | null> | null, reservedCny: number, outcome: "success" | "http_error" | "transport_error" | "aborted" | "budget_blocked") => void
    }).__evalPostRequest
    const settleReservation = (usage: Record<string, number | null> | null): void => {
      // R25-P0-02：无论是否产生 reservation（无 cost cap 时 reservedCny=0）都必须 settle——
      // 否则无 cap 运行不会入账任何 actual/upper（spentActual 恒 0 却声称 costKnown=true）。
      if (postGate) {
        postGate(usage, currentReservationCny, attemptOutcome)
        currentReservationCny = 0
      }
    }

    try {
      // The run budget is checked immediately before the real request.  A
      // rejected retry never reaches fetch and therefore cannot be counted as
      // an additional provider call.
      await beforeAttempt?.(innerAttempt, { bodyJson, model: params.model, maxTokens: params.outputTokenUpperBound ?? params.maxTokens ?? 8192 })
      // Keep the external/evaluation reservation after the durable run-level
      // reservation above.  If either gate rejects, no provider fetch is
      // reached and no attempt is presented as started.
      if (preGate) {
        const gate = preGate(bodyJson, params.model, params.outputTokenUpperBound ?? params.maxTokens ?? 8192)
        if (gate.blocked) {
          throw new BudgetExhaustedError(gate.reason ?? 'budget exhausted')
        }
        currentReservationCny = gate.reservedCny ?? 0
      }
      attemptStartedAt = Date.now()
      onAttemptLifecycle?.({ type: 'started', innerAttempt, startedAt: attemptStartedAt })
      const requestUrl = params.provider
        ? canonicalJoin(params.baseUrl ?? DEFAULT_BASE_URL, params.provider.chatPath)
        : `${params.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`
      const headers: Record<string, string> = params.provider ? buildProviderAuthHeaders({
        baseUrl: params.baseUrl ?? DEFAULT_BASE_URL, authStyle: params.provider.authStyle, protocol: params.provider.protocol,
        authHeaderName: params.provider.authHeaderName ?? params.provider.transportPolicy.authHeaderName,
        transportPolicy: params.provider.transportPolicy, fixedHeaders: params.provider.transportPolicy.fixedHeaders,
        extraHeaders: params.provider.extraHeaders ?? params.provider.transportPolicy.extraHeaders
      }, params.apiKey, { targetUrl: requestUrl, accept: 'text/event-stream', jsonBody: true })
        : { 'Content-Type': 'application/json', Authorization: `Bearer ${params.apiKey}` }
      const requestInit = {
        method: 'POST',
        headers,
        body: bodyJson,
        signal: innerAbort.signal
      }
      const res = params.provider
        ? await secureProviderFetch(requestUrl, requestInit, params.provider.transportPolicy, undefined, { timeoutMs: OVERALL_TIMEOUT_MS, maxBodyBytes: 64 * 1024 * 1024 })
        : await fetch(requestUrl, requestInit)
      attemptHttpStatus = res.status

      if (!res.ok) {
        attemptOutcome = 'http_error'
        // Consume the response without returning provider text: errors can echo a key.
        await res.text()
        throw new ApiStatusError(res.status, providerHttpErrorMessage(res.status))
      }

      if (!res.body) {
        attemptOutcome = 'transport_error'
        throw new Error('No response body')
      }

      firstByteTimer = setTimeout(() => failTimeout('等待首字节超时（60 秒）'), FIRST_BYTE_TIMEOUT_MS)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let doneReceived = false
      const protocolErrors: { raw: string }[] = []

      // One entry per provider call index; emitted events are complete
      // snapshots, while wire fields are appended deltas.
      const toolAcc = new Map<number, { id: string; name: string; arguments: string }>()
      // Without an authoritative event id/sequence, equal wire deltas are
      // indistinguishable from valid repeated content and must be appended.
      const seenToolEvents = new Map<string, string>()
      const emittedToolSnapshots = new Map<number, { id: string; name: string; arguments: string }>()
      const toolMeters = new Map<number, ReturnType<typeof createToolOutputMeter>>()

      const handleLine = (rawLine: string): void => {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) return
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          doneReceived = true
          return
        }
        let json: any
        try {
          json = JSON.parse(data)
        } catch {
          protocolErrors.push({ raw: data.slice(0, 200) })
          return
        }
        const choice = json.choices?.[0]
        if (typeof json.id === 'string' && json.id) providerRequestId = json.id
        const hasFirstToken = Boolean(choice?.delta?.reasoning_content || choice?.delta?.content || choice?.delta?.tool_calls?.length)
        if (hasFirstToken && attemptFirstTokenAt === null) {
          attemptFirstTokenAt = Date.now()
          receivedAny = true
          onAttemptLifecycle?.({ type: 'first_token', innerAttempt, firstTokenAt: attemptFirstTokenAt })
        }
        if (choice?.delta?.reasoning_content) {
          receivedAny = true
          onEvent({ type: 'reasoning', delta: choice.delta.reasoning_content })
        }
        if (choice?.delta?.content) {
          receivedAny = true
          onEvent({ type: 'text', delta: choice.delta.content })
        }
        if (choice?.delta?.tool_calls) {
          receivedAny = true
          let processToolCalls = true
          const authority = eventAuthority(json)
          if (authority !== null) {
            const key = `${authority}\u0000${String(choice?.index ?? 0)}`
            const fingerprint = canonicalJson(json)
            const previous = seenToolEvents.get(key)
            if (previous !== undefined) {
              if (previous !== fingerprint) throw protocolMismatch('event_replay')
              processToolCalls = false
            } else {
              seenToolEvents.set(key, fingerprint)
            }
          }
          if (processToolCalls) {
            for (const tc of choice.delta.tool_calls) {
              if (tc.index !== undefined && !Number.isInteger(tc.index)) throw protocolMismatch('tool_index')
              const idx = tc.index ?? 0
              const acc = toolAcc.get(idx) ?? { id: tc.id ?? '', name: '', arguments: '' }
              const meter = toolMeters.get(idx) ?? createToolOutputMeter()
              toolMeters.set(idx, meter)
              if (tc.id !== undefined) {
                if (typeof tc.id !== 'string') throw protocolMismatch('tool_id')
                if (acc.id && acc.id !== tc.id) throw protocolMismatch('tool_id')
                acc.id = tc.id
              }
              if (tc.function?.name !== undefined) {
                if (typeof tc.function.name !== 'string') throw protocolMismatch('tool_name_delta')
                acc.name = appendToolDelta(acc.name, tc.function.name)
                meter.name(tc.function.name)
              }
              if (tc.function?.arguments !== undefined) {
                if (typeof tc.function.arguments !== 'string') throw protocolMismatch('tool_arguments_delta')
                acc.arguments = appendToolDelta(acc.arguments, tc.function.arguments)
                meter.arguments(tc.function.arguments)
              }
              toolAcc.set(idx, acc)
              const previous = emittedToolSnapshots.get(idx)
              if (previous && previous.id === acc.id && previous.name === acc.name && previous.arguments === acc.arguments) continue
              emittedToolSnapshots.set(idx, { ...acc })
              onEvent(meter.event({
                type: 'tool_call',
                tool: { index: idx, id: acc.id, name: acc.name, arguments: acc.arguments }
              }))
            }
          }
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason
        }
        if (json.usage) {
          const u = json.usage
          performanceUsage = readPerformanceUsage('deepseek-chat', json, performanceUsage)
          usage = {
            prompt_tokens: u.prompt_tokens ?? 0,
            completion_tokens: u.completion_tokens ?? 0,
            total_tokens: u.total_tokens ?? 0,
            prompt_cache_hit_tokens: u.prompt_cache_hit_tokens ?? 0,
            prompt_cache_miss_tokens: u.prompt_cache_miss_tokens ?? 0,
            reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
            cache_tokens_known: u.prompt_cache_hit_tokens != null && u.prompt_cache_miss_tokens != null,
            reasoning_tokens_known: u.completion_tokens_details?.reasoning_tokens != null
          }
          // 同步记录 attempt 的 usage（直接在 closure 内赋值，规避外层 CFA 窄化）
          // R25-P1-02：cache hit/miss 缺失时必须保持 null（不得归一成 0——0/0 与 prompt>0 会构成假矛盾，
          // 导致 actual 误判 unknown / 误入保守 upper）。此处读原始 provider 字段 u，非上方已归一化的 usage。
          attemptUsage = {
            prompt_tokens: u.prompt_tokens ?? null,
            completion_tokens: u.completion_tokens ?? null,
            total_tokens: u.total_tokens ?? null,
            prompt_cache_hit_tokens: u.prompt_cache_hit_tokens ?? null,
            prompt_cache_miss_tokens: u.prompt_cache_miss_tokens ?? null,
            reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? null
          }
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (firstByteTimer) {
          clearTimeout(firstByteTimer)
          firstByteTimer = undefined
        }
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => failTimeout('流响应空闲超时（120 秒）'), IDLE_TIMEOUT_MS)
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const rawLine of lines) handleLine(rawLine)
        if (doneReceived) break
      }

      if (!doneReceived) {
        const tail = buffer.trim()
        if (tail.startsWith('data:')) handleLine(tail)
      }
      // [DONE] is only a transport sentinel. It is not evidence that the
      // provider completed the answer; an explicit finish_reason is required.
      if (!finishReason) {
        attemptOutcome = 'transport_error'
        const incomplete = new Error('incomplete_stream: provider stream ended without finish_reason') as Error & { code?: string }
        incomplete.code = 'incomplete_stream'
        throw incomplete
      }
      // 流正常走到 finish → 成功
      attemptOutcome = 'success'
    } catch (err) {
      // 依据抛错类型补 outcome（http_error 已在非 ok 分支提前置位）
      if (attemptOutcome !== 'http_error') {
        if ((err as Error)?.name === 'AbortError' || timedOut || signal?.aborted) attemptOutcome = 'aborted'
        else attemptOutcome = 'transport_error'
      }
      if (timedOut) {
        // R22 主代理对账：超时/中止也是真实发生过的 provider attempt，必须先记 ledger 再抛
        //（否则端点实收 > ledger，请求账本少计）。R24-P0-03：reservation 对账（无 usage → fail-closed）。
        settleReservation(attemptUsage)
        emitAttempt()
        throw new TimeoutError(timeoutMsg)
      }
      if (attempt < MAX_RETRIES && !receivedAny && isRetryableError(err)) {
        if (onRetry) onRetry(attempt + 1)
        settleReservation(attemptUsage)
        emitAttempt()
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        continue
      }
      settleReservation(attemptUsage)
      emitAttempt()
      throw err
    } finally {
      clearTimers()
    }
    settleReservation(attemptUsage)
    emitAttempt()
    break
  }

  onEvent({ type: 'done', finishReason, usage })
  return { finishReason, usage }
}

export interface ToolExecutor {
  (name: string, args: unknown, tool: ToolCall): Promise<string>
}

export interface LongGenerateBudgetInfo {
  round: number
  estimatedTokens: number
  budget: number
  droppedChars: number
  summaryVersion: number
}

export interface RoundBudgetRecord {
  round: number
  estimatedTokens: number
  compressed: boolean
  droppedChars: number
}

export interface LongGenerateResult {
  totalUsage: Usage
  rounds: number
  finalFinishReason: string | null
  measuredChars: number
  targetChars: number
  reachedTarget: boolean
  needsContinuation: boolean
  partial: boolean
  /** 流中断时已生成的正文（partial=true 时非空） */
  partialContent: string
  /** 每轮请求前的上下文估算（含是否压缩/裁剪字数），红灯 1 断言 ≤ budget 用 */
  roundBudgets: RoundBudgetRecord[]
}

export interface LongGenerateOpts {
  params: Omit<ChatParams, 'messages'>
  messages: DsMessage[]
  onEvent: (ev: ChunkEvent) => void
  /** Correct the visible draft when natural-ending selection retracts a streamed suffix. */
  onContentReplace?: (content: string) => void
  onRound: (round: number, finishReason: string | null) => void
  executor?: ToolExecutor
  maxRounds?: number
  signal?: AbortSignal
  onRetry?: (attempt: number) => void
  /** C1：长文上下文硬预算（token），缺省 120000 */
  contextBudgetTokens?: number
  /** C1：为输出预留的 token 余量，缺省 8192 */
  outputReserveTokens?: number
  /** C2：目标字数（透传用于换算 token 达到判定） */
  targetChars?: number
  /** C1：预算压缩触发回调（不静默） */
  onBudgetCompression?: (info: LongGenerateBudgetInfo) => void
  /** provider 边界 request-attempt 回调（透传 streamChat 的 onAttempt） */
  onAttempt?: StreamAttemptCallback
  /** 测试注入：替换内部 streamChat（缺省用本模块 streamChat） */
  streamChatImpl?: typeof streamChat
}

/**
 * 超长输出模式：
 * 1. finish_reason=length 时自动续写（已生成内容作为 assistant 消息继续请求）
 * 2. 支持工具调用循环（文档生成等）
 * 3. 每次请求返回 usage 并累计
 */
const CONTINUE_SYSTEM = `你正在续写上一篇输出。规则：
1. 从上次断点处自然衔接，继续推进内容，绝不重复、不重写已生成的部分。
2. 不要输出"续写"、"继续"、"以下是上一段后续"之类的说明文字。
3. 直接输出新的正文内容。`

const CONTINUE_TOLERANCE = 0.01

/** C1：确定性的前文压缩（不引入模型摘要调用）。把最早的 assistant 正文压缩为结构化要点。 */
function buildHeuristicSummary(asstTexts: string[]): string {
  const heads: string[] = []
  for (const t of asstTexts) {
    const head = t.slice(0, 60).trim()
    if (head) heads.push(head)
  }
  const last = asstTexts[asstTexts.length - 1] ?? ''
  const tail = last.slice(-200)
  return `## 已压缩前文（heuristic 确定性摘要，非模型总结）
人物/时间线/伏笔/断点要点（各轮 assistant 首 60 字拼接）：
${heads.map((h, i) => `${i + 1}. ${h}`).join('\n')}

上一断点原文最后 200 字：
${tail}`
}

export function longGenerate(opts: LongGenerateOpts): Promise<LongGenerateResult> {
  return (async () => {
    const {
      params,
      messages,
      onEvent,
      onRound,
      executor,
      maxRounds = 20,
      onRetry,
      contextBudgetTokens = 120000,
      outputReserveTokens = 8192,
      targetChars = 0,
      onBudgetCompression,
      onAttempt,
      streamChatImpl = streamChat
    } = opts
    const totalUsage: Usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 0,
      reasoning_tokens: 0,
      cache_tokens_known: false,
      reasoning_tokens_known: false
    }
    const history: DsMessage[] = [...messages]
    let rounds = 0
    let finishReason: string | null = null
    let assistantContent = ''
    let lastReasoning = ''
    let emptyTextRounds = 0
    let measuredChars = 0
    let assembledContent = ''
    let partial = false
    let partialContent = ''
    let summaryVersion = 0
    const roundBudgets: RoundBudgetRecord[] = []

    const estimated = (msgs: DsMessage[]): number => msgs.reduce((a, m) => a + calcMessageTokensLike(m), 0)

    // C1：硬预算 + 压缩循环。每次只压缩“最早的一条 assistant 正文”，压缩后重算，仍超则再压更早一轮。
    const fitBudget = (round: number): void => {
      let compressed = false
      let totalDroppedChars = 0
      let passes = 0
      const MAX_COMPRESS_PASSES = 128
      while (passes++ < MAX_COMPRESS_PASSES) {
        const used = estimated(history)
        if (used <= contextBudgetTokens - outputReserveTokens) {
          roundBudgets.push({ round, estimatedTokens: used, compressed, droppedChars: totalDroppedChars })
          return
        }
        // 找最早的、可被摘要替换的 assistant 正文消息
        const idx = history.findIndex((m) => m.role === 'assistant' && (m.content ?? '').length > 0)
        if (idx < 0) {
          // 无 assistant 可压缩，但 user/system 仍超预算 → 无法满足（fail-closed，不静默发超窗请求）
          roundBudgets.push({ round, estimatedTokens: used, compressed, droppedChars: totalDroppedChars })
          throw new Error(`上下文预算无法满足：当前 ${used} tokens > 可用预算 ${contextBudgetTokens - outputReserveTokens}（且无可压缩的 assistant 正文）`)
        }
        const dropped = history[idx].content ?? ''
        const droppedChars = Array.from(dropped).length
        totalDroppedChars += droppedChars
        compressed = true
        summaryVersion++
        history.splice(idx, 1, { role: 'system', content: buildHeuristicSummary([dropped]) })
        if (onBudgetCompression) {
          onBudgetCompression({ round, estimatedTokens: used, budget: contextBudgetTokens - outputReserveTokens, droppedChars, summaryVersion })
        }
      }
      // 压缩轮次耗尽仍超预算 → 明确报错
      roundBudgets.push({ round, estimatedTokens: estimated(history), compressed, droppedChars: totalDroppedChars })
      throw new Error(`上下文预算无法满足：压缩 ${MAX_COMPRESS_PASSES} 轮后仍超可用预算 ${contextBudgetTokens - outputReserveTokens}`)
    }

    while (rounds < maxRounds) {
      rounds++
      fitBudget(rounds)
      const roundMessages: DsMessage[] = [...history]
      assistantContent = ''
      // streamChat emits cumulative tool snapshots keyed by provider index.
      // Keep one value per call index so a later snapshot replaces, rather
      // than concatenates, the earlier one (including a full `.done` value).
      const roundCollected = new Map<number, ToolCall>()
      let roundReasoning = ''

      try {
        const roundResult = await streamChatImpl(
          { ...params, messages: roundMessages },
          (ev) => {
            if (ev.type === 'text') {
              const before = assistantContent
              const candidate = before + (ev.delta ?? '')
              const effectiveTolerance = targetChars >= 100 ? CONTINUE_TOLERANCE : 0
              const targetCeiling = targetChars > 0 ? Math.ceil(targetChars * (1 + effectiveTolerance)) : 0
              const remaining = targetChars > 0 ? Math.max(0, targetCeiling - measuredChars) : Number.POSITIVE_INFINITY
              assistantContent = targetChars > 0 ? takeCodePoints(candidate, remaining) : candidate
              // Do not leak provider text beyond the requested delivery size to the UI.
              // The suffix is derived from the accepted prefix, so no padding/repetition
              // is ever invented and surrogate pairs remain intact.
              const acceptedDelta = Array.from(assistantContent).slice(codePointLength(before)).join('')
              if (acceptedDelta) onEvent({ ...ev, delta: acceptedDelta })
            }
            if (ev.type === 'reasoning') roundReasoning += ev.delta ?? ''
            if (ev.type === 'tool_call' && ev.tool) {
              const index = Number.isInteger(ev.tool.index) ? ev.tool.index : 0
              const previous = roundCollected.get(index)
              roundCollected.set(index, {
                id: ev.tool.id || previous?.id || '',
                name: ev.tool.name ?? previous?.name ?? '',
                arguments: ev.tool.arguments ?? previous?.arguments ?? ''
              })
            }
            if (ev.type !== 'text') onEvent(ev)
          },
          opts.signal,
          onRetry,
          onAttempt
        )
        if (roundResult.usage) {
          const numericUsageKeys = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'reasoning_tokens'] as const
          for (const k of numericUsageKeys) {
            totalUsage[k] += (roundResult.usage as Usage)[k]
          }
          totalUsage.cache_tokens_known ||= roundResult.usage.cache_tokens_known === true
          totalUsage.reasoning_tokens_known ||= roundResult.usage.reasoning_tokens_known === true
        }
        finishReason = roundResult.finishReason
      } catch (e) {
        finishReason = finishReason ?? 'error'
        // C5：流中断——保留本轮已收到的正文，不丢弃
        measuredChars += codePointLength(assistantContent)
        assembledContent += assistantContent
        if (assistantContent.trim()) {
          partial = true
          partialContent += assistantContent
        }
        onRound(rounds, finishReason)
        throw e
      }

      if (targetChars >= 100) {
        const targetFloor = Math.floor(targetChars * (1 - CONTINUE_TOLERANCE))
        const targetCeiling = Math.ceil(targetChars * (1 + CONTINUE_TOLERANCE))
        if (measuredChars + codePointLength(assistantContent) >= targetFloor) {
          const localFloor = Math.max(1, targetFloor - measuredChars)
          const localTarget = Math.max(localFloor, targetChars - measuredChars)
          const localCeiling = Math.max(localFloor, targetCeiling - measuredChars)
          const selected = selectNaturalEnding(assistantContent, localTarget, localFloor, localCeiling, 1)
          assistantContent = selected?.text ?? ''
          opts.onContentReplace?.(`${assembledContent}${assistantContent}`)
        }
      }
      measuredChars += codePointLength(assistantContent)
      assembledContent += assistantContent
      onRound(rounds, finishReason)

      const pendingById = new Map<string, ToolCall>()
      for (const tool of roundCollected.values()) {
        if (tool.id && tool.name) pendingById.set(tool.id, tool)
      }
      const pendingTools = [...pendingById.values()]
      if (pendingTools.length > 0 && executor) {
        const asstWithCalls: DsMessage = {
          role: 'assistant',
          content: assistantContent,
          tool_calls: pendingTools.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments }))
        }
        if (roundReasoning) asstWithCalls.reasoning_content = roundReasoning
        history.push(asstWithCalls)
        lastReasoning = roundReasoning
        for (const tool of pendingTools) {
          let result: string
          try {
            let args: unknown = {}
            try {
              args = tool.arguments ? JSON.parse(tool.arguments) : {}
            } catch {
              args = { raw: tool.arguments }
            }
            result = await executor(tool.name, args, tool)
          } catch (e) {
            result = `工具执行失败: ${(e as Error).message}`
          }
          history.push({ role: 'tool', tool_call_id: tool.id, content: result })
          onEvent({ type: 'done', finishReason: 'tool_calls', usage: null })
        }
        continue
      }

      lastReasoning = roundReasoning
      if (assistantContent.trim()) {
        const asst: DsMessage = { role: 'assistant', content: assistantContent }
        if (roundReasoning) asst.reasoning_content = roundReasoning
        history.push(asst)
      }
      const needsTargetContinuation = targetChars > 0 && measuredChars < targetChars
      if ((finishReason === 'length' || needsTargetContinuation) && !(targetChars > 0 && measuredChars >= targetChars)) {
        if (!assistantContent.trim()) {
          emptyTextRounds++
          if (emptyTextRounds >= 2) {
            finishReason = 'no_progress'
            break
          }
        } else {
          emptyTextRounds = 0
          const remaining = targetChars > 0 ? Math.max(0, targetChars - measuredChars) : 0
          history.push({
            role: 'system',
            content: targetChars > 0
              ? `${CONTINUE_SYSTEM}\n当前距离目标约 ${remaining} 字；请用完整句子自然续写并收束，允许在目标附近 1% 内结束，不要解释字数，不要重写前文。`
              : CONTINUE_SYSTEM
          })
        }
        continue
      }
      break
    }

    const reachedTarget = targetChars <= 0 ? true : measuredChars >= targetChars * (1 - CONTINUE_TOLERANCE)
    const needsContinuation = !reachedTarget && (rounds >= maxRounds || finishReason === 'length' || finishReason === 'no_progress')

    return {
      totalUsage,
      rounds,
      finalFinishReason: finishReason,
      measuredChars,
      targetChars,
      reachedTarget,
      needsContinuation,
      partial,
      partialContent,
      roundBudgets
    }
  })()
}

function calcMessageTokensLike(m: DsMessage): number {
  let t = estimateTokens(m.content ?? '')
  if (m.tool_calls) {
    for (const tc of m.tool_calls) t += estimateTokens(tc.name + tc.arguments)
  }
  return t
}
