import { providerRequestBody } from './providerAdapters'
import type { ModelRecord, ProbeResult, ProviderProtocol, ProviderRecord } from '../shared/providerRegistry'

const TOOL_NAME = 'deepwriter_tool_probe'
const record = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const filtered = (value: unknown): boolean => Array.isArray(value) ? value.some(filtered)
  : value !== null && typeof value === 'object' && (record(value).filtered === true || Object.values(record(value)).some(filtered))

/** One request only. The declared function is never executed or passed to the agent tool dispatcher. */
export function toolProbeRequest(provider: ProviderRecord, model: ModelRecord, nonce: string): Record<string, unknown> {
  const protocol = provider.transportPolicy.protocol ?? 'openai-chat'
  const mapping = model.capabilities.reasoning.mappingId ?? null
  const body = providerRequestBody({
    model: model.remoteModelId,
    messages: [{ role: 'user', content: `Call ${TOOL_NAME} once with nonce "${nonce}". This is a capability test; the function is not executed and has no side effects.` }],
    maxTokens: Math.min(512, model.maxOutputTokens ?? 512), apiKey: '', thinking: { enabled: false, effort: 'low' },
    provider: { adapterId: provider.adapterId, protocol, chatPath: provider.chatPath, authStyle: provider.authStyle, transportPolicy: provider.transportPolicy,
      reasoning: { mode: mapping && model.capabilities.reasoning.modes.includes('disabled') ? 'disabled' : 'default', effort: null }, compatibilityMappingId: mapping },
    tools: [{ type: 'function', function: { name: TOOL_NAME, description: 'Harmless capability test. This function is not executed.',
      parameters: { type: 'object', properties: { nonce: { type: 'string', enum: [nonce] } }, required: ['nonce'], additionalProperties: false } } }],
    toolChoice: 'required'
  }, protocol === 'deepseek-chat' ? 'openai-chat' : protocol)
  body.stream = false
  delete body.stream_options; delete body.temperature; delete body.top_p
  body.tool_choice = protocol === 'anthropic-messages' ? { type: 'tool', name: TOOL_NAME }
    : protocol === 'openai-responses' ? { type: 'function', name: TOOL_NAME }
      : { type: 'function', function: { name: TOOL_NAME } }
  return body
}

/** Only a completed, correctly structured tool call is proof; echoed text and filtered/partial replies are not. */
export function readToolProbeResponse(raw: unknown, protocol: ProviderProtocol, nonce: string): Pick<ProbeResult, 'outcome' | 'usage'> {
  const payload = record(raw)
  const tokens = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
  const usage = record(payload.usage)
  const result: Pick<ProbeResult, 'outcome' | 'usage'> = { outcome: 'inconclusive', usage: {
    inputTokens: tokens(usage.input_tokens ?? usage.prompt_tokens), outputTokens: tokens(usage.output_tokens ?? usage.completion_tokens),
    reasoningTokens: tokens(record(usage.output_tokens_details).reasoning_tokens ?? record(usage.completion_tokens_details).reasoning_tokens)
  } }
  if (payload.error != null || payload.refusal || filtered(payload.prompt_filter_results) || filtered(payload.content_filter_results)) return result
  let calls: unknown[] = []
  if (protocol === 'anthropic-messages') {
    if (payload.stop_reason !== 'tool_use' || list(payload.content).some(part => record(part).type === 'refusal')) return result
    calls = list(payload.content).filter(part => record(part).type === 'tool_use').map(part => ({ ...record(part), arguments: record(part).input }))
  } else if (protocol === 'openai-responses') {
    if (payload.status !== 'completed' || payload.incomplete_details != null || list(payload.output).some(part => list(record(part).content).some(content => record(content).type === 'refusal'))) return result
    calls = list(payload.output).filter(part => record(part).type === 'function_call').map(part => ({ ...record(part), id: record(part).call_id }))
  } else {
    const choice = record(list(payload.choices)[0])
    const message = record(choice.message)
    if (choice.finish_reason !== 'tool_calls' || message.role !== 'assistant' || message.refusal || filtered(choice.content_filter_results)) return result
    calls = list(message.tool_calls).filter(part => record(part).type === 'function').map(part => ({ ...record(record(part).function), id: record(part).id }))
    if (calls.length !== list(message.tool_calls).length) return result
  }
  if (calls.length !== 1) return result
  const call = record(calls[0])
  if (call.name !== TOOL_NAME || typeof call.id !== 'string' || !call.id.trim() || (call.status && call.status !== 'completed')) return result
  let args: unknown = call.arguments
  if (protocol === 'anthropic-messages' ? args === null || typeof args !== 'object' || Array.isArray(args) : typeof args !== 'string') return result
  try { if (typeof args === 'string') args = JSON.parse(args) } catch { return result }
  const input = record(args)
  if (Object.keys(input).length === 1 && input.nonce === nonce) result.outcome = 'supported'
  return result
}
