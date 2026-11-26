import { createHash } from 'node:crypto'
import type { ChatParams, ChunkEvent, DsMessage, Usage } from '../shared/types'
import { canonicalJoin, secureProviderFetch } from './providerSecurity'
import { buildProviderAuthHeaders, providerHttpErrorMessage } from './providerAuth'
import { createToolOutputMeter, readPerformanceUsage } from './providerPerformance'
import type { ProviderPerformanceUsage } from '../shared/performanceTelemetry'
import { providerPromptCacheKey } from './providerPromptCache'

type AdapterProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages'
type AttemptOutcome = 'success' | 'http_error' | 'transport_error' | 'aborted'
type AttemptUsage = Record<string, number | null> | null

export interface AdapterAttemptInfo {
  innerAttempt: number
  outcome: AttemptOutcome
  httpStatus: number | null
  usagePresent: boolean
  usage: AttemptUsage
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

export type AdapterLifecycleEvent =
  | { type: 'started'; innerAttempt: number; startedAt: number }
  | { type: 'first_token'; innerAttempt: number; firstTokenAt: number }
  | { type: 'terminal'; innerAttempt: number; outcome: 'success' | 'http_error' | 'transport_error' | 'timeout' | 'cancelled'; httpStatus: number | null; providerRequestId: string | null; endedAt: number; usage: AttemptUsage; performanceUsage?: ProviderPerformanceUsage }

const MAX_RETRIES = 1
const RETRY_DELAY_MS = 2000
const OVERALL_TIMEOUT_MS = 30 * 60 * 1000
const FIRST_BYTE_TIMEOUT_MS = Number(process.env.DEEPSEEK_EVAL_FIRST_BYTE_TIMEOUT_MS ?? 60 * 1000)
const IDLE_TIMEOUT_MS = Number(process.env.DEEPSEEK_EVAL_IDLE_TIMEOUT_MS ?? 120 * 1000)

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

function actualHashes(messages: DsMessage[]): Pick<AdapterAttemptInfo, 'actualMessageRoles' | 'actualUserHash' | 'actualHistoryHash' | 'actualSystemHash' | 'actualAssembledHash' | 'actualMessageContentHashes' | 'actualHistoryTurnHashes'> {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { lastUser = i; break }
  const history = lastUser > 0 ? messages.slice(0, lastUser).filter((m) => m.role === 'user' || m.role === 'assistant') : []
  const text = (m: DsMessage): string => m.content ?? ''
  return {
    actualMessageRoles: messages.map((m) => m.role),
    actualUserHash: sha256(messages.filter((m) => m.role === 'user').map(text).join('\n')),
    actualHistoryHash: sha256(JSON.stringify(history.map((m) => ({ role: m.role, content: text(m) })))),
    actualSystemHash: sha256(messages.filter((m) => m.role === 'system').map(text).join('\n')),
    actualAssembledHash: sha256(JSON.stringify(messages.map((m) => ({ role: m.role, content: text(m) })))),
    actualMessageContentHashes: messages.map((m) => sha256(text(m))),
    actualHistoryTurnHashes: history.map((m) => ({ role: m.role as 'user' | 'assistant', sha256: sha256(text(m)) }))
  }
}

function providerError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number }
  error.name = 'ApiStatusError'
  error.status = status
  return error
}

function retryable(error: unknown): boolean {
  const e = error as Error & { status?: number }
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return false
  return typeof e.status === 'number' ? e.status === 429 || e.status >= 500 : /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|Failed to fetch/i.test(e.message ?? '')
}

function convertOpenAiTools(tools: ChatParams['tools']): unknown[] | undefined {
  return tools?.map((tool) => ({ type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }))
}

function convertAnthropicMessages(messages: DsMessage[]): { system: string | undefined; messages: unknown[] } {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).filter(Boolean).join('\n\n') || undefined
  const result: unknown[] = []
  const append = (entry: { role: 'user' | 'assistant'; content: unknown }): void => {
    const previous = result[result.length - 1] as { role?: string; content?: unknown } | undefined
    if (!previous || previous.role !== entry.role) {
      result.push(entry)
      return
    }
    // Anthropic requires alternating user/assistant turns. Tool results are
    // user content, so merge adjacent same-role blocks before sending.
    const previousContent = Array.isArray(previous.content) ? previous.content : previous.content ? [{ type: 'text', text: previous.content }] : []
    const nextContent = Array.isArray(entry.content) ? entry.content : entry.content ? [{ type: 'text', text: entry.content }] : []
    previous.content = [...previousContent, ...nextContent]
  }
  for (const message of messages.filter((entry) => entry.role !== 'system')) {
    if (message.role === 'tool') {
      append({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id ?? 'unknown', content: message.content }] })
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const content: unknown[] = []
    if (message.content) content.push({ type: 'text', text: message.content })
    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        let input: unknown = {}
        try { input = JSON.parse(call.arguments || '{}') } catch { input = {} }
        content.push({ type: 'tool_use', id: call.id, name: call.name, input })
      }
    }
    append({ role: message.role, content: content.length === 1 && (content[0] as { type?: string }).type === 'text' ? message.content : content })
  }
  return { system, messages: result }
}

function openAiResponseInput(messages: DsMessage[]): unknown[] {
  const result: unknown[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      // Responses uses a first-class function_call_output item rather than
      // the Chat Completions `tool_call_id` message field.
      result.push({ type: 'function_call_output', call_id: message.tool_call_id ?? 'unknown', output: message.content })
      continue
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      if (message.content) result.push({ role: 'assistant', content: message.content })
      for (const call of message.tool_calls) result.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })
      continue
    }
    result.push({ role: message.role, content: message.content })
  }
  return result
}

function readUsage(protocol: AdapterProtocol, json: any, previous: Usage | null): Usage | null {
  const u = protocol === 'anthropic-messages' ? json?.usage : protocol === 'openai-responses' ? json?.response?.usage ?? json?.usage : json?.usage
  if (!u || typeof u !== 'object') return previous
  if (protocol === 'anthropic-messages') {
    const input = u.input_tokens ?? previous?.prompt_tokens ?? 0
    const output = u.output_tokens ?? previous?.completion_tokens ?? 0
    return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_cache_hit_tokens: u.cache_read_input_tokens ?? 0, prompt_cache_miss_tokens: u.cache_creation_input_tokens ?? input, reasoning_tokens: 0, cache_tokens_known: u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null, reasoning_tokens_known: false }
  }
  const details = protocol === 'openai-responses' ? u.output_tokens_details : u.completion_tokens_details
  const input = u.input_tokens ?? u.prompt_tokens ?? previous?.prompt_tokens ?? 0
  const output = u.output_tokens ?? u.completion_tokens ?? previous?.completion_tokens ?? 0
  // Both OpenAI protocols include cached input in the reported input total.
  // Don't lose Chat Completions' cache reads when persisting the attempt.
  const hit = u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens
  const miss = u.prompt_cache_miss_tokens ?? (Number.isSafeInteger(hit) && hit >= 0 && hit <= input && (u.input_tokens ?? u.prompt_tokens) != null ? input - hit : undefined)
  return { prompt_tokens: input, completion_tokens: output, total_tokens: u.total_tokens ?? input + output, prompt_cache_hit_tokens: hit ?? 0, prompt_cache_miss_tokens: miss ?? 0, reasoning_tokens: details?.reasoning_tokens ?? u.reasoning_tokens ?? 0, cache_tokens_known: Number.isSafeInteger(hit) && Number.isSafeInteger(miss) && hit >= 0 && miss >= 0 && hit + miss === input, reasoning_tokens_known: details?.reasoning_tokens != null || u.reasoning_tokens != null }
}

export function providerRequestBody(params: ChatParams, protocol: AdapterProtocol): Record<string, unknown> {
  const rawEffort = params.provider?.reasoning.effort ?? params.thinking.effort
  const selectedEffort = rawEffort === 'default' || rawEffort === 'enabled' ? undefined : rawEffort
  if (protocol === 'anthropic-messages') {
    const converted = convertAnthropicMessages(params.messages)
    const requestedMaxTokens = params.maxTokens ?? 8192
    const mode = params.provider?.reasoning.mode
    // Anthropic requires an enabled thinking budget to be at least 1024 and
    // strictly below max_tokens.  A small UI cap must not produce a request
    // the native Messages API rejects before it can stream anything.
    const thinkingEnabled = mode !== 'default' && (params.thinking.enabled || mode === 'enabled' || mode === 'adaptive')
    const legacyBudget = params.provider?.reasoning.budgetTokens === undefined
    const maxTokens = thinkingEnabled && legacyBudget ? Math.max(requestedMaxTokens, 1025) : requestedMaxTokens
    const body: Record<string, unknown> = {
      model: params.model, messages: converted.messages, max_tokens: maxTokens, stream: true
    }
    if (converted.system) body.system = converted.system
    if (params.tools?.length) {
      body.tools = params.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }))
      body.tool_choice = params.toolChoice === 'required' ? { type: 'any' } : params.toolChoice === 'none' ? { type: 'none' } : { type: 'auto' }
    }
    if (thinkingEnabled && (mode === 'adaptive' || params.provider?.compatibilityMappingId === 'anthropic.adaptive')) {
      body.thinking = { type: 'adaptive' }
      if (selectedEffort) body.output_config = { effort: selectedEffort }
    } else if (thinkingEnabled) {
      const priorBudget = ({ low: 2048, medium: 8192, high: 16384 } as Record<string, number>)[selectedEffort ?? ''] ?? Math.floor(maxTokens * 0.5)
      const budget = legacyBudget ? Math.min(maxTokens - 1, Math.max(1024, priorBudget)) : params.provider?.reasoning.budgetTokens
      if (budget == null || !Number.isSafeInteger(budget) || budget < 1024 || budget >= maxTokens) throw new Error('此模型的推理预算须至少 1024 tokens 且低于最大输出；请设置预算或使用模型默认')
      body.thinking = { type: 'enabled', budget_tokens: budget }
      if (params.provider?.compatibilityMappingId === 'anthropic.thinking_effort' && selectedEffort) body.output_config = { effort: selectedEffort }
    } else if (mode === 'disabled') body.thinking = { type: 'disabled' }
    if (!thinkingEnabled && !params.provider?.compatibilityMappingId) {
      body.temperature = params.temperature ?? 1
      body.top_p = params.topP ?? 1
    }
    return body
  }
  if (protocol === 'openai-responses') {
    const body: Record<string, unknown> = { model: params.model, input: openAiResponseInput(params.messages), stream: true, ...(!params.omitOutputTokenLimit ? { max_output_tokens: params.maxTokens ?? 8192 } : {}), store: false }
    const cacheKey = providerPromptCacheKey(params, protocol)
    if (cacheKey) body.prompt_cache_key = cacheKey
    if (params.thinking.enabled && params.provider?.reasoning.mode !== 'default' && selectedEffort) body.reasoning = { effort: selectedEffort }
    else if (params.provider?.reasoning.mode === 'disabled') body.reasoning = { effort: 'none' }
    if (!params.thinking.enabled && !params.provider?.compatibilityMappingId && params.temperature != null) body.temperature = params.temperature
    if (params.tools?.length) body.tools = convertOpenAiTools(params.tools)
    return body
  }
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages.map((m) => m.tool_calls?.length ? { ...m, tool_calls: m.tool_calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : m),
    stream: true, stream_options: { include_usage: true }, ...(!params.omitOutputTokenLimit ? { max_tokens: params.maxTokens ?? 8192 } : {})
  }
  const cacheKey = providerPromptCacheKey(params, protocol)
  if (cacheKey) body.prompt_cache_key = cacheKey
  const mapping = params.provider?.compatibilityMappingId
  if (mapping === 'openai_chat.reasoning_effort_top_level' && body.max_tokens !== undefined) {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
  }
  const controlled = params.provider?.reasoning.mode !== 'default' && Boolean(mapping)
  if (controlled) {
    const enabled = params.thinking.enabled
    const effort = selectedEffort === 'enabled' ? undefined : selectedEffort
    if (mapping === 'openai_chat.reasoning_effort_top_level') body.reasoning_effort = enabled ? effort : 'none'
    else if (mapping === 'openai_chat.thinking') {
      body.thinking = { type: enabled ? 'enabled' : 'disabled' }
      if (enabled && effort) body.reasoning_effort = effort
    } else if (mapping === 'openai_chat.enable_thinking') body.enable_thinking = enabled
    else if (mapping === 'openai_chat.reasoning') body.reasoning = { enabled, ...(enabled && effort ? { effort } : {}) }
  }
  if (!params.thinking.enabled && !mapping) { body.temperature = params.temperature ?? 1; body.top_p = params.topP ?? 1 }
  if (params.tools?.length) { body.tools = params.tools; body.tool_choice = params.toolChoice ?? 'auto' }
  return body
}

function finishReasonFor(protocol: AdapterProtocol, json: any): string | null {
  if (protocol === 'anthropic-messages') {
    const reason = json?.delta?.stop_reason ?? json?.stop_reason ?? null
    if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop'
    if (reason === 'max_tokens') return 'length'
    if (reason === 'tool_use') return 'tool_calls'
    return reason
  }
  if (protocol === 'openai-responses') {
    if (json?.type === 'response.completed') return 'stop'
    if (json?.type === 'response.incomplete') {
      const reason = json?.response?.incomplete_details?.reason
      return reason === 'max_output_tokens' || reason === 'length' ? 'length' : reason ?? 'length'
    }
    return null
  }
  return json?.choices?.[0]?.finish_reason ?? null
}

type ProviderToolSnapshot = {
  index: number
  id: string
  name: string
  arguments: string
  callId?: string
  itemId?: string
}

/**
 * Delta fields are ordered protocol fragments.  In particular, two adjacent
 * fragments may legitimately have identical text (`ab` + `ab`, `}}` + `}}`,
 * or the same Unicode chunk), so their content must never be used as a
 * de-duplication key.  Only an explicit provider event identity can make a
 * replay idempotent.
 */
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

function replaceToolSnapshot(previous: string, incoming: string, field: string): string {
  if (incoming === previous) return previous
  if (!previous) return incoming
  // A cumulative/full snapshot may only advance the already received prefix.
  // A shorter or divergent snapshot is an explicit protocol conflict, never
  // a reason to silently choose whichever value arrived last.
  if (incoming.startsWith(previous)) return incoming
  throw protocolMismatch(field)
}

function optionalToolText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw protocolMismatch(field)
  return value
}

export async function streamWithProviderAdapter(
  params: ChatParams,
  onEvent: (event: ChunkEvent) => void,
  signal?: AbortSignal,
  onRetry?: (attempt: number) => void,
  onAttempt?: (info: AdapterAttemptInfo) => void,
  onAttemptLifecycle?: (event: AdapterLifecycleEvent) => void,
  beforeAttempt?: (innerAttempt: number, request?: { bodyJson: string; model: string; maxTokens: number }) => void | Promise<void>
): Promise<{ finishReason: string | null; usage: Usage | null }> {
  const protocol = (params.provider?.protocol ?? 'openai-chat') as AdapterProtocol
  if (!params.provider) throw new Error('Provider 协议配置缺失')
  const requestUrl = canonicalJoin(params.baseUrl ?? '', params.provider.chatPath)
  const bodyJson = JSON.stringify(providerRequestBody(params, protocol))
  const hashes = onAttempt ? actualHashes(params.messages) : null
  let finalUsage: Usage | null = null
  let finalFinish: string | null = null
  let receivedAny = false

  for (let attempt = 0; ; attempt++) {
    const innerAttempt = attempt + 1
    let startedAt = Date.now()
    let status: number | null = null
    let outcome: AttemptOutcome = 'transport_error'
    let attemptUsage: AttemptUsage = null
    let performanceUsage: ProviderPerformanceUsage | undefined
    let finishReason: string | null = null
    let providerRequestId: string | null = null
    let firstToken = false
    let terminalSeen = false
    let timedOut = false
    let attemptStarted = false
    let timeoutMessage = '请求超时'
    let lifecycleTerminalEmitted = false
    let attemptInfoEmitted = false
    let firstTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const overallTimer = setTimeout(() => { timedOut = true; timeoutMessage = '请求超时（30 分钟）'; controller.abort() }, OVERALL_TIMEOUT_MS)
    const preGate = (globalThis as unknown as { __evalPreRequest?: (bodyJson: string, model: string, maxTokens: number) => { blocked: boolean; reason?: string; reservedCny: number } }).__evalPreRequest
    const postGate = (globalThis as unknown as { __evalPostRequest?: (usage: AttemptUsage, reservedCny: number, outcome: AttemptOutcome | 'budget_blocked') => void }).__evalPostRequest
    let reservation = 0
    const settle = (): void => { if (postGate) { postGate(attemptUsage, reservation, outcome); reservation = 0 } }
    const emitAttemptInfo = (): void => {
      if (attemptInfoEmitted || !attemptStarted) return
      attemptInfoEmitted = true
      if (onAttempt && hashes) onAttempt({ innerAttempt, outcome, httpStatus: status, usagePresent: attemptUsage != null, usage: attemptUsage, ...hashes, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt })
      if (!lifecycleTerminalEmitted && attemptStarted) {
        lifecycleTerminalEmitted = true
        onAttemptLifecycle?.({ type: 'terminal', innerAttempt, outcome: timedOut ? 'timeout' : outcome === 'aborted' ? 'cancelled' : outcome, httpStatus: status, providerRequestId, endedAt: Date.now(), usage: attemptUsage, performanceUsage })
      }
    }
    try {
      // Check the run-level budget before creating the provider attempt row or
      // issuing fetch.  A blocked retry must not be allowed to escape via the
      // adapter's own retry loop.  Keep this inside the try/finally boundary
      // so a rejected async reservation cannot leak timers/listeners.
      await beforeAttempt?.(innerAttempt, { bodyJson, model: params.model, maxTokens: params.outputTokenUpperBound ?? params.maxTokens ?? 8192 })
      if (preGate) {
        const gate = preGate(bodyJson, params.model, params.outputTokenUpperBound ?? params.maxTokens ?? 8192)
        if (gate.blocked) { outcome = 'aborted'; throw new Error(gate.reason ?? 'budget exhausted') }
        reservation = gate.reservedCny ?? 0
      }
      const headers = buildProviderAuthHeaders({
        baseUrl: params.baseUrl!, authStyle: params.provider.authStyle,
        authHeaderName: params.provider.authHeaderName ?? params.provider.transportPolicy.authHeaderName, protocol,
        transportPolicy: params.provider.transportPolicy,
        extraHeaders: params.provider.extraHeaders ?? params.provider.transportPolicy.extraHeaders, fixedHeaders: params.provider.transportPolicy.fixedHeaders
      }, params.apiKey, { targetUrl: requestUrl, accept: 'text/event-stream', jsonBody: true })
      // TTFT excludes asynchronous budget/credential validation, like the
      // DeepSeek boundary. No waiting sample for a request rejected pre-fetch.
      startedAt = Date.now()
      attemptStarted = true
      onAttemptLifecycle?.({ type: 'started', innerAttempt, startedAt })
      const response = await secureProviderFetch(requestUrl, { method: 'POST', headers, body: bodyJson, signal: controller.signal }, params.provider.transportPolicy, undefined, { timeoutMs: OVERALL_TIMEOUT_MS, maxBodyBytes: 64 * 1024 * 1024 })
      status = response.status
      if (!response.ok) { outcome = 'http_error'; throw providerError(status, providerHttpErrorMessage(status)) }
      if (!response.body) throw new Error('Provider 未返回流')
      const fail = (message: string): void => { timedOut = true; timeoutMessage = message; controller.abort() }
      firstTimer = setTimeout(() => fail('等待首字节超时'), FIRST_BYTE_TIMEOUT_MS)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let eventName = ''
      let eventData = ''
      // One canonical accumulator per provider call index.  Responses also
      // has an item_id, so aliases point at this same object rather than
      // creating duplicate calls when the stream switches identifiers.
      const toolAcc = new Map<number, ProviderToolSnapshot>()
      const toolAliases = new Map<string, ProviderToolSnapshot>()
      // A missing event id/sequence number is deliberately not considered a
      // duplicate.  OpenAI-compatible delta streams commonly omit both, and
      // equal adjacent fragments are valid data rather than replay evidence.
      const seenToolEvents = new Map<string, string>()
      const emittedToolSnapshots = new Map<number, ProviderToolSnapshot>()
      const toolMeters = new Map<number, ReturnType<typeof createToolOutputMeter>>()
      const emitFirst = (): void => { if (!firstToken) { firstToken = true; receivedAny = true; clearTimeout(firstTimer); firstTimer = undefined; onAttemptLifecycle?.({ type: 'first_token', innerAttempt, firstTokenAt: Date.now() }) } }
      const emitTool = (entry: ProviderToolSnapshot): void => {
        const previous = emittedToolSnapshots.get(entry.index)
        if (previous && previous.id === entry.id && previous.name === entry.name && previous.arguments === entry.arguments && previous.callId === entry.callId && previous.itemId === entry.itemId) return
        const snapshot = { ...entry }
        emittedToolSnapshots.set(entry.index, { ...snapshot })
        onEvent(toolMeters.get(entry.index)!.event({ type: 'tool_call', tool: snapshot }))
      }
      const updateToolText = (acc: ProviderToolSnapshot, field: 'name' | 'arguments', incoming: string, mode: 'delta' | 'snapshot', diagnostic: string): void => {
        const previous = acc[field]
        const next = mode === 'snapshot' ? replaceToolSnapshot(previous, incoming, diagnostic) : appendToolDelta(previous, incoming)
        // Snapshot prefix validation above remains authoritative. Only its new
        // suffix needs measuring, just as an actual wire delta does.
        const delta = mode === 'snapshot' ? next.slice(previous.length) : incoming
        toolMeters.get(acc.index)![field](delta)
        acc[field] = next
      }
      const rememberToolEvent = (name: string, json: any): boolean => {
        const authority = eventAuthority(json)
        if (authority === null) return true
        const key = `${name}\u0000${authority}`
        const fingerprint = canonicalJson(json)
        const previous = seenToolEvents.get(key)
        if (previous !== undefined) {
          if (previous !== fingerprint) throw protocolMismatch('event_replay')
          return false
        }
        seenToolEvents.set(key, fingerprint)
        return true
      }
      const toolIndex = (value: unknown, fallback: number): number => Number.isInteger(value) ? Number(value) : fallback
      const ensureTool = (input: { index?: number; id?: string; callId?: string; itemId?: string; name?: string; arguments?: string; nameMode?: 'delta' | 'snapshot'; argumentsMode?: 'delta' | 'snapshot' }): ProviderToolSnapshot => {
        const byAlias = [input.callId, input.itemId, input.id].filter((value): value is string => typeof value === 'string' && value.length > 0).map((value) => toolAliases.get(value)).find(Boolean)
        const index = input.index ?? byAlias?.index ?? toolAcc.size
        const indexed = toolAcc.get(index)
        if (byAlias && indexed && byAlias !== indexed) throw protocolMismatch('tool_identity')
        const acc = byAlias ?? toolAcc.get(index) ?? { index, id: input.callId ?? input.id ?? input.itemId ?? '', name: '', arguments: '' }
        if (!toolMeters.has(acc.index)) toolMeters.set(acc.index, createToolOutputMeter())
        if (input.index !== undefined && acc.index !== input.index) throw protocolMismatch('tool_index')
        if (input.callId) {
          if (acc.callId && acc.callId !== input.callId) throw protocolMismatch('tool_call_id')
          acc.callId = input.callId
          if (acc.id && acc.id !== input.callId) throw protocolMismatch('tool_id')
          acc.id = input.callId
        } else if (input.id) {
          if (acc.id && acc.id !== input.id) throw protocolMismatch('tool_id')
          acc.id = input.id
        }
        if (input.itemId) {
          if (acc.itemId && acc.itemId !== input.itemId) throw protocolMismatch('tool_item_id')
          acc.itemId = input.itemId
        }
        if (input.name !== undefined) updateToolText(acc, 'name', input.name, input.nameMode ?? 'delta', 'tool_name_snapshot')
        if (input.arguments !== undefined) updateToolText(acc, 'arguments', input.arguments, input.argumentsMode ?? 'delta', 'tool_arguments_snapshot')
        toolAcc.set(acc.index, acc)
        for (const alias of [acc.id, acc.callId, acc.itemId]) if (alias) toolAliases.set(alias, acc)
        return acc
      }
      const handleEvent = (name: string, raw: string): void => {
        const normalized = raw.trim()
        if (!normalized || normalized === '[DONE]') { if (normalized === '[DONE]') terminalSeen = true; return }
        let json: any
        try { json = JSON.parse(normalized) } catch { return }
        if (json.usage || json.message?.usage || json.response?.usage)
          performanceUsage = readPerformanceUsage(protocol, json, performanceUsage)
        if (typeof json.id === 'string' && json.id) providerRequestId = json.id
        if (protocol === 'anthropic-messages') {
          if (name === 'message_start') { providerRequestId = json.message?.id ?? providerRequestId; finalUsage = readUsage(protocol, json.message, finalUsage) }
          else if (name === 'content_block_start' && json.content_block?.type === 'tool_use') {
            if (!rememberToolEvent(name, json)) return
            const acc = ensureTool({ index: toolIndex(json.index, toolAcc.size), id: optionalToolText(json.content_block.id, 'tool_id') ?? '', name: optionalToolText(json.content_block.name, 'tool_name_snapshot') ?? '', nameMode: 'snapshot' })
            // A tool-use block is already a real provider call even when its
            // input arrives in later chunks. Emit its empty snapshot so the
            // downstream call identity is never lost on an empty-args call.
            emitFirst(); emitTool(acc)
          }
          else if (name === 'content_block_delta') {
            const delta = json.delta
            if (delta?.type === 'text_delta' && delta.text) { emitFirst(); onEvent({ type: 'text', delta: delta.text }) }
            else if (delta?.type === 'thinking_delta' && delta.thinking) { emitFirst(); onEvent({ type: 'reasoning', delta: delta.thinking }) }
            else if (delta?.type === 'input_json_delta') {
              if (!rememberToolEvent(name, json)) return
              const partialJson = optionalToolText(delta.partial_json, 'tool_arguments_delta') ?? ''
              const acc = ensureTool({ index: toolIndex(json.index, toolAcc.size), arguments: partialJson, argumentsMode: 'delta' })
              emitFirst(); emitTool(acc)
            }
          } else if (name === 'message_delta') { finalUsage = readUsage(protocol, json, finalUsage); finishReason = finishReasonFor(protocol, json) }
          else if (name === 'message_stop') { terminalSeen = true; finishReason = finishReason ?? 'stop' }
          else if (name === 'error') throw new Error('Provider 流错误（详情已脱敏）')
          return
        }
        if (protocol === 'openai-responses') {
          if (name === 'response.output_text.delta' && json.delta) { emitFirst(); onEvent({ type: 'text', delta: json.delta }) }
          else if ((name === 'response.reasoning_summary_text.delta' || name === 'response.reasoning_text.delta') && json.delta) { emitFirst(); onEvent({ type: 'reasoning', delta: json.delta }) }
          else if (name === 'response.output_item.added' && json.item?.type === 'function_call') {
            const item = json.item
            if (!rememberToolEvent(name, json)) return
            const acc = ensureTool({ index: toolIndex(json.output_index, toolAcc.size), id: optionalToolText(item.call_id ?? item.id, 'tool_id') ?? '', callId: optionalToolText(item.call_id, 'tool_call_id'), itemId: optionalToolText(item.id, 'tool_item_id'), name: optionalToolText(item.name, 'tool_name_snapshot') ?? '', nameMode: 'snapshot', arguments: optionalToolText(item.arguments, 'tool_arguments_snapshot') ?? '', argumentsMode: 'snapshot' })
            emitFirst(); emitTool(acc)
          } else if (name === 'response.function_call_arguments.delta' || name === 'response.function_call_arguments.done') {
            const index = Number.isInteger(json.output_index) ? Number(json.output_index) : undefined
            if (!rememberToolEvent(name, json)) return
            const acc = ensureTool({ index, id: optionalToolText(json.call_id, 'tool_call_id') ?? '', callId: optionalToolText(json.call_id, 'tool_call_id'), itemId: optionalToolText(json.item_id, 'tool_item_id'), name: optionalToolText(json.name, 'tool_name_snapshot'), nameMode: 'snapshot' })
            // Responses `.done` is an authoritative full snapshot, unlike
            // `.delta`, which is a fragment.  Never append the full value.
            if (name.endsWith('.done')) {
              const fullArguments = optionalToolText(json.arguments, 'tool_arguments_done')
              if (fullArguments !== undefined) updateToolText(acc, 'arguments', fullArguments, 'snapshot', 'tool_arguments_done')
            } else {
              updateToolText(acc, 'arguments', optionalToolText(json.delta, 'tool_arguments_delta') ?? '', 'delta', 'tool_arguments_delta')
            }
            toolAcc.set(acc.index, acc)
            emitFirst(); emitTool(acc)
          }
          else if (name === 'response.output_item.done' && json.item?.type === 'function_call') {
            const item = json.item
            if (!rememberToolEvent(name, json)) return
            const acc = ensureTool({ index: toolIndex(json.output_index, toolAcc.size), id: optionalToolText(item.call_id ?? item.id, 'tool_id') ?? '', callId: optionalToolText(item.call_id, 'tool_call_id'), itemId: optionalToolText(item.id, 'tool_item_id'), name: optionalToolText(item.name, 'tool_name_snapshot') ?? '', nameMode: 'snapshot' })
            const fullArguments = optionalToolText(item.arguments, 'tool_arguments_item_done')
            if (fullArguments !== undefined) updateToolText(acc, 'arguments', fullArguments, 'snapshot', 'tool_arguments_item_done')
            emitFirst(); emitTool(acc)
          }
          else if (name === 'response.completed' || name === 'response.incomplete') {
            finalUsage = readUsage(protocol, json, finalUsage)
            // Responses completes the response envelope even when it asks the
            // client to execute a function. The engine must receive tool_calls,
            // not stop, or it silently discards the emitted function snapshots.
            // Incomplete/truncated responses retain their original finish reason.
            finishReason = name === 'response.completed' && toolAcc.size > 0 ? 'tool_calls' : finishReasonFor(protocol, json)
            terminalSeen = true
          }
          else if (name === 'response.failed' || name === 'error') throw new Error('Provider 流错误（详情已脱敏）')
          return
        }
        const choice = json.choices?.[0]
        if (choice?.delta?.content) { emitFirst(); onEvent({ type: 'text', delta: choice.delta.content }) }
        const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
        if (typeof reasoning === 'string' && reasoning) { emitFirst(); onEvent({ type: 'reasoning', delta: reasoning }) }
        if (choice?.delta?.tool_calls) {
          if (rememberToolEvent(name, json)) {
            for (const call of choice.delta.tool_calls) {
              const acc = ensureTool({ index: toolIndex(call.index, toolAcc.size), id: optionalToolText(call.id, 'tool_id'), name: optionalToolText(call.function?.name, 'tool_name_delta'), arguments: optionalToolText(call.function?.arguments, 'tool_arguments_delta'), nameMode: 'delta', argumentsMode: 'delta' })
              emitFirst(); emitTool(acc)
            }
          }
        }
        finishReason = finishReason ?? finishReasonFor(protocol, json)
        finalUsage = readUsage(protocol, json, finalUsage)
        if (json.usage) attemptUsage = { prompt_tokens: json.usage.prompt_tokens ?? null, completion_tokens: json.usage.completion_tokens ?? null, total_tokens: json.usage.total_tokens ?? null, prompt_cache_hit_tokens: json.usage.prompt_cache_hit_tokens ?? null, prompt_cache_miss_tokens: json.usage.prompt_cache_miss_tokens ?? null, reasoning_tokens: json.usage.completion_tokens_details?.reasoning_tokens ?? null }
      }
      while (true) {
        const next = await reader.read()
        if (next.done) break
        if (firstTimer) { clearTimeout(firstTimer); firstTimer = undefined }
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => fail('流响应空闲超时'), IDLE_TIMEOUT_MS)
        buffer += decoder.decode(next.value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) { handleEvent(eventName, eventData); eventName = ''; eventData = ''; continue }
          if (line.startsWith('event:')) eventName = line.slice(6).trim()
          else if (line.startsWith('data:')) eventData += `${line.slice(5).trim()}\n`
        }
      }
      if (eventData) handleEvent(eventName, eventData.trim())
      if (!terminalSeen || !finishReason) { outcome = 'transport_error'; throw new Error('incomplete_stream: provider stream ended without terminal event') }
      outcome = 'success'
      finalFinish = finishReason
      const usageForAttempt = finalUsage as Usage | null
      attemptUsage = usageForAttempt ? { prompt_tokens: usageForAttempt.prompt_tokens, completion_tokens: usageForAttempt.completion_tokens, total_tokens: usageForAttempt.total_tokens, prompt_cache_hit_tokens: usageForAttempt.cache_tokens_known ? usageForAttempt.prompt_cache_hit_tokens : null, prompt_cache_miss_tokens: usageForAttempt.cache_tokens_known ? usageForAttempt.prompt_cache_miss_tokens : null, reasoning_tokens: usageForAttempt.reasoning_tokens_known ? usageForAttempt.reasoning_tokens : null } : attemptUsage
    } catch (error) {
      if (timedOut) { outcome = 'aborted'; settle(); emitAttemptInfo(); throw Object.assign(new Error(timeoutMessage), { name: 'TimeoutError' }) }
      if ((error as Error)?.name === 'AbortError' || signal?.aborted) outcome = 'aborted'
      if (attempt < MAX_RETRIES && !receivedAny && retryable(error)) { settle(); emitAttemptInfo(); onRetry?.(attempt + 1); await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS)); continue }
      settle(); emitAttemptInfo(); throw error
    } finally {
      clearTimeout(overallTimer); clearTimeout(firstTimer); clearTimeout(idleTimer); signal?.removeEventListener('abort', abort)
    }
    settle()
    emitAttemptInfo()
    break
  }
  onEvent({ type: 'done', finishReason: finalFinish, usage: finalUsage })
  return { finishReason: finalFinish, usage: finalUsage }
}
