import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { streamChat, longGenerate } from '../src/main/deepseek'
import { streamWithProviderAdapter } from '../src/main/providerAdapters'
import type { ChatParams, ChunkEvent } from '../src/shared/types'

type Check = { name: string; ok: boolean; detail?: string }
const checks: Check[] = []
const check = (name: string, ok: boolean, detail = ''): void => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const params = (port: number, protocol: NonNullable<ChatParams['provider']>['protocol'], path: string): ChatParams => ({
  apiKey: 'fixture-key',
  baseUrl: `http://127.0.0.1:${port}`,
  model: 'p1-tool-fixture',
  messages: [{ role: 'user', content: 'fixture' }],
  thinking: { enabled: false, effort: 'low' },
  maxTokens: 128,
  provider: {
    adapterId: 'custom.openai-compatible-chat',
    protocol,
    chatPath: path,
    authStyle: 'bearer',
    transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true, protocol },
    reasoning: { mode: 'default', effort: null },
    compatibilityMappingId: protocol === 'openai-responses' ? 'openai_responses.reasoning_effort' : null
  }
})

const sse = (res: ServerResponse, events: Array<{ event?: string; data: unknown }>): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
  for (const item of events) {
    res.write(`${item.event ? `event: ${item.event}\n` : ''}data: ${typeof item.data === 'string' ? item.data : JSON.stringify(item.data)}\n\n`)
  }
  res.end()
}

const chatToolEvents = (): Array<{ data: unknown }> => [
  { data: { id: 'chat-tool', sequence_number: 1, choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-zero', function: { name: 'lookup', arguments: '{"q"' } }] }, finish_reason: null }] } },
  // Exact duplicate delivery is ignored only because the provider supplied
  // the same authoritative sequence number.
  { data: { id: 'chat-tool', sequence_number: 1, choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-zero', function: { name: 'lookup', arguments: '{"q"' } }] }, finish_reason: null }] } },
  { data: { id: 'chat-tool', sequence_number: 2, choices: [{ delta: { tool_calls: [{ index: 2, id: 'call-two', function: { name: 'write', arguments: '{"x":' } }] }, finish_reason: null }] } },
  { data: { id: 'chat-tool', sequence_number: 3, choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: null }] } },
  { data: { id: 'chat-tool', sequence_number: 4, choices: [{ delta: { tool_calls: [{ index: 2, function: { arguments: '"ok"}' } }] }, finish_reason: null }] } },
  { data: { id: 'chat-tool', sequence_number: 5, choices: [{ delta: {}, finish_reason: 'tool_calls' }] } },
  { data: '[DONE]' }
]

const responseToolEvents = (): Array<{ event: string; data: unknown }> => [
  { event: 'response.output_item.added', data: { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { type: 'function_call', id: 'item-zero', call_id: 'call-zero', name: 'lookup', arguments: '' } } },
  { event: 'response.output_item.added', data: { type: 'response.output_item.added', sequence_number: 2, output_index: 2, item: { type: 'function_call', id: 'item-two', call_id: 'call-two', name: 'write', arguments: '' } } },
  { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', sequence_number: 3, output_index: 0, item_id: 'item-zero', delta: '{"q"' } },
  { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', sequence_number: 4, output_index: 2, item_id: 'item-two', delta: '{"x":' } },
  // Exact duplicate delivery of a delta is ignored only with its sequence.
  { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', sequence_number: 4, output_index: 2, item_id: 'item-two', delta: '{"x":' } },
  { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', sequence_number: 5, output_index: 0, item_id: 'item-zero', delta: ':1}' } },
  // `.done` carries the complete argument JSON and must replace, not append.
  { event: 'response.function_call_arguments.done', data: { type: 'response.function_call_arguments.done', sequence_number: 6, output_index: 0, item_id: 'item-zero', call_id: 'call-zero', arguments: '{"q":1}' } },
  { event: 'response.output_item.done', data: { type: 'response.output_item.done', sequence_number: 7, output_index: 2, item: { type: 'function_call', id: 'item-two', call_id: 'call-two', name: 'write', arguments: '{"x":"ok"}' } } },
  { event: 'response.completed', data: { type: 'response.completed', sequence_number: 8, response: { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } } }
]

const anthropicToolEvents = (): Array<{ event: string; data: unknown }> => [
  { event: 'message_start', data: { type: 'message_start', message: { id: 'msg-tool', usage: { input_tokens: 3 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', event_id: 'evt-1', index: 0, content_block: { type: 'tool_use', id: 'call-zero', name: 'lookup', input: {} } } },
  { event: 'content_block_start', data: { type: 'content_block_start', event_id: 'evt-2', index: 2, content_block: { type: 'tool_use', id: 'call-two', name: 'write', input: {} } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', event_id: 'evt-3', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q"' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', event_id: 'evt-4', index: 2, delta: { type: 'input_json_delta', partial_json: '{"x":' } } },
  // Exact duplicate delivery of a delta is ignored only with its event id.
  { event: 'content_block_delta', data: { type: 'content_block_delta', event_id: 'evt-4', index: 2, delta: { type: 'input_json_delta', partial_json: '{"x":' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', event_id: 'evt-5', index: 0, delta: { type: 'input_json_delta', partial_json: ':1}' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', event_id: 'evt-6', index: 2, delta: { type: 'input_json_delta', partial_json: '"ok"}' } } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } } },
  { event: 'message_stop', data: { type: 'message_stop' } }
]

// Equal fragments are deliberately repeated without an event id.  They are
// valid deltas, not replay evidence: the final values must retain both `ab`,
// both Unicode chunks, and both `}}` fragments while tools remain interleaved.
const losslessDeltaEvents = (): Array<{ data: unknown }> => [
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-repeat-zero', function: { name: 'e', arguments: '{"x":"' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 2, id: 'call-repeat-two', function: { name: 'r', arguments: '{"u":"' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 4, id: 'call-repeat-name', function: { name: 'x', arguments: '{}' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ab' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 2, function: { name: 'e', arguments: '雪' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 4, function: { name: 'x' } }] }, finish_reason: null }] } },
  // This wire event is byte-for-byte identical to the preceding `ab` event;
  // without an authoritative id it is still a legitimate second delta.
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ab' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 2, function: { name: 'a', arguments: '雪' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 4, function: { name: 'x' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'o', arguments: '}}' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 2, function: { name: 'd', arguments: '}}' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}}' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 2, function: { arguments: '}}' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: { tool_calls: [{ index: 2, function: { arguments: '"}' } }] }, finish_reason: null }] } },
  { data: { id: 'repeat-tool', choices: [{ delta: {}, finish_reason: 'tool_calls' }] } },
  { data: '[DONE]' }
]

const conflictingResponseEvents = (): Array<{ event: string; data: unknown }> => [
  { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item-conflict', call_id: 'call-conflict', name: 'lookup', arguments: '' } } },
  { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item-conflict', delta: '{"a"' } },
  // `.done` is a full snapshot.  It diverges from the already received delta
  // and must fail explicitly instead of silently selecting one value.
  { event: 'response.function_call_arguments.done', data: { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'item-conflict', call_id: 'call-conflict', arguments: '{"b":1}' } },
  { event: 'response.completed', data: { type: 'response.completed', response: {} } }
]

const bodyOf = async (req: IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

async function runAdapterCase(label: string, input: ChatParams, expected: Record<number, { id: string; name: string; arguments: string }>): Promise<void> {
  const snapshots = new Map<number, Array<{ id: string; name: string; arguments: string }>>()
  let finish: string | null = null
  await streamWithProviderAdapter(input, (event: ChunkEvent) => {
    if (event.type === 'tool_call' && event.tool) {
      const list = snapshots.get(event.tool.index) ?? []
      list.push({ id: event.tool.id, name: event.tool.name, arguments: event.tool.arguments })
      snapshots.set(event.tool.index, list)
    }
    if (event.type === 'done') finish = event.finishReason ?? null
  })
  const final = [...snapshots.entries()].map(([index, list]) => [index, list[list.length - 1]] as const)
  const actual = Object.fromEntries(final)
  const exact = Object.entries(expected).every(([index, value]) => JSON.stringify(actual[index]) === JSON.stringify(value)) && Object.keys(actual).length === Object.keys(expected).length
  check(`${label} 交错工具由 index 合并且参数 JSON 精确`, exact, JSON.stringify({ actual, finish }))
  check(`${label} 重复事件不重复发射`, [...snapshots.values()].every((list) => new Set(list.map((item) => JSON.stringify(item))).size === list.length), JSON.stringify(Object.fromEntries(snapshots)))
}

async function runLosslessDeltaCase(port: number): Promise<void> {
  const snapshots = new Map<number, { id: string; name: string; arguments: string }>()
  await streamWithProviderAdapter(params(port, 'openai-chat', '/repeat'), (event: ChunkEvent) => {
    if (event.type === 'tool_call' && event.tool) snapshots.set(event.tool.index, { id: event.tool.id, name: event.tool.name, arguments: event.tool.arguments })
  })
  const zero = snapshots.get(0)
  const two = snapshots.get(2)
  const four = snapshots.get(4)
  let zeroParsed: any = null
  let twoParsed: any = null
  try { zeroParsed = JSON.parse(zero?.arguments ?? '') } catch { /* assertion below reports malformed output */ }
  try { twoParsed = JSON.parse(two?.arguments ?? '') } catch { /* assertion below reports malformed output */ }
  check('Chat delta 相同 ab 片段按协议追加且保留重复 }}', zeroParsed?.x === 'abab}}}}', JSON.stringify(zero))
  check('Chat delta 重复 Unicode/}} 片段按协议追加', twoParsed?.u === '雪雪}}}}', JSON.stringify(two))
  check('Chat delta 重复 }} 片段不被内容去重', zero?.arguments === '{"x":"abab}}}}"}' && two?.arguments === '{"u":"雪雪}}}}"}', JSON.stringify({ zero, two }))
  check('Chat delta 相同 name 片段按协议追加', four?.name === 'xxx', JSON.stringify(four))
  check('Chat delta 多 tool 交错仍按 index 隔离', snapshots.size === 3 && zero?.id === 'call-repeat-zero' && two?.id === 'call-repeat-two' && four?.id === 'call-repeat-name', JSON.stringify(Object.fromEntries(snapshots)))
}

async function runSnapshotConflictCase(port: number): Promise<void> {
  let errorCode = ''
  try {
    await streamWithProviderAdapter(params(port, 'openai-responses', '/responses-conflict'), () => undefined)
  } catch (error) {
    errorCode = String((error as { code?: unknown }).code ?? '')
  }
  check('Responses full snapshot 与 delta 冲突显式失败', errorCode === 'provider_protocol_mismatch', errorCode)
}

async function runLongGenerateCase(): Promise<void> {
  let executorCalls = 0
  let executedArgs = ''
  let request = 0
  const fakeStream = async (_params: ChatParams, onEvent: (event: ChunkEvent) => void): Promise<{ finishReason: string; usage: null }> => {
    request += 1
    if (request === 1) {
      const first = { type: 'tool_call' as const, tool: { index: 2, id: 'call-two', name: 'write', arguments: '{"x":' } }
      onEvent(first)
      onEvent(first)
      onEvent({ type: 'tool_call', tool: { index: 2, id: 'call-two', name: 'write', arguments: '{"x":"ok"}' } })
      onEvent({ type: 'done', finishReason: 'tool_calls', usage: null })
      return { finishReason: 'tool_calls', usage: null }
    }
    onEvent({ type: 'text', delta: '完成。' })
    onEvent({ type: 'done', finishReason: 'stop', usage: null })
    return { finishReason: 'stop', usage: null }
  }
  const result = await longGenerate({
    params: params(1, 'deepseek-chat', '/chat/completions'),
    messages: [{ role: 'user', content: '继续' }],
    streamChatImpl: fakeStream as never,
    executor: async (_name, args, tool) => { executorCalls += 1; executedArgs = JSON.stringify({ args, tool }); return 'ok' },
    onEvent: () => undefined,
    onRound: () => undefined,
    maxRounds: 3
  })
  check('longGenerate 对快照重复/最终全量参数只执行一次', executorCalls === 1 && executedArgs.includes('{"x":"ok"}') && result.rounds === 2, JSON.stringify({ executorCalls, executedArgs, rounds: result.rounds }))
}

async function runCancelResumeCase(port: number): Promise<void> {
  const controller = new AbortController()
  let toolEvents = 0
  let doneEvents = 0
  const pending = streamWithProviderAdapter(params(port, 'openai-chat', '/abort-tool'), (event) => {
    if (event.type === 'tool_call') toolEvents += 1
    if (event.type === 'done') doneEvents += 1
  }, controller.signal).catch(() => undefined)
  setTimeout(() => controller.abort(), 40)
  await pending
  check('取消中的工具流不伪造完成且不重复发射', controller.signal.aborted && toolEvents === 1 && doneEvents === 0, JSON.stringify({ toolEvents, doneEvents }))

  // A resumed stream may replay the provider snapshot.  The consumer-facing
  // identity remains the same call id, so replacing by id yields one call.
  const resumed = new Map<string, { name: string; arguments: string }>()
  await streamWithProviderAdapter(params(port, 'openai-chat', '/native'), (event) => {
    if (event.type === 'tool_call' && event.tool?.id) resumed.set(event.tool.id, { name: event.tool.name, arguments: event.tool.arguments })
  })
  check('恢复后按 call_id 合并，不重复工具调用', resumed.size === 2 && resumed.get('call-two')?.arguments === '{"x":"ok"}', JSON.stringify(Object.fromEntries(resumed)))
}

async function main(): Promise<void> {
  const server = createServer(async (req, res) => {
    const path = req.url ?? ''
    await bodyOf(req)
    if (path === '/chat') return sse(res, [...chatToolEvents(), { data: { id: 'chat-tool', choices: [{ delta: {}, finish_reason: 'tool_calls' }] } }, { data: '[DONE]' }])
    if (path === '/native') return sse(res, [...chatToolEvents()])
    if (path === '/repeat') return sse(res, losslessDeltaEvents())
    if (path === '/responses') return sse(res, responseToolEvents())
    if (path === '/responses-conflict') return sse(res, conflictingResponseEvents())
    if (path === '/anthropic') return sse(res, anthropicToolEvents())
    if (path === '/abort-tool') {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      res.write(`data: ${JSON.stringify({ id: 'abort-tool', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-abort', function: { name: 'lookup', arguments: '{"q"' } }] }, finish_reason: null }] })}\n\n`)
      const timer = setTimeout(() => res.end(), 500)
      req.on('close', () => { clearTimeout(timer); res.end() })
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  try {
    await runAdapterCase('OpenAI-compatible Chat', params(port, 'openai-chat', '/chat'), {
      0: { id: 'call-zero', name: 'lookup', arguments: '{"q":1}' },
      2: { id: 'call-two', name: 'write', arguments: '{"x":"ok"}' }
    })
    await runAdapterCase('OpenAI Responses', params(port, 'openai-responses', '/responses'), {
      0: { id: 'call-zero', name: 'lookup', arguments: '{"q":1}' },
      2: { id: 'call-two', name: 'write', arguments: '{"x":"ok"}' }
    })
    await runAdapterCase('Anthropic Messages', params(port, 'anthropic-messages', '/anthropic'), {
      0: { id: 'call-zero', name: 'lookup', arguments: '{"q":1}' },
      2: { id: 'call-two', name: 'write', arguments: '{"x":"ok"}' }
    })
    await runLosslessDeltaCase(port)
    await runSnapshotConflictCase(port)
    const nativeRepeatSnapshots = new Map<number, { id: string; name: string; arguments: string }>()
    const nativeRepeatParams = params(port, 'deepseek-chat', '/repeat')
    await streamChat(nativeRepeatParams, (event) => {
      if (event.type === 'tool_call' && event.tool) nativeRepeatSnapshots.set(event.tool.index, { id: event.tool.id, name: event.tool.name, arguments: event.tool.arguments })
    })
    let nativeRepeatZero: any = null
    try { nativeRepeatZero = JSON.parse(nativeRepeatSnapshots.get(0)?.arguments ?? '') } catch { /* assertion below reports malformed output */ }
    check('DeepSeek Chat 合法重复 delta 保留 ab/}}', nativeRepeatZero?.x === 'abab}}}}', JSON.stringify(nativeRepeatSnapshots.get(0)))
    const nativeSnapshots: ChunkEvent[] = []
    await streamChat({ ...params(port, 'deepseek-chat', '/native'), provider: { ...params(port, 'deepseek-chat', '/native').provider!, protocol: 'deepseek-chat' } }, (event) => { if (event.type === 'tool_call') nativeSnapshots.push(event) })
    const nativeFinal = nativeSnapshots.filter((event) => event.tool?.index === 2).at(-1)?.tool?.arguments
    check('DeepSeek Chat 流沿用快照契约且不重复参数', nativeFinal === '{"x":"ok"}', JSON.stringify(nativeSnapshots))
    await runLongGenerateCase()
    await runCancelResumeCase(port)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  const failed = checks.filter((item) => !item.ok)
  console.log(`\nP1 provider tool stream: ${checks.length - failed.length} PASS / ${failed.length} FAIL`)
  if (failed.length) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
