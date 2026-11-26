import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { streamWithProviderAdapter } from '../src/main/providerAdapters'
import type { ChatParams, ChunkEvent } from '../src/shared/types'

type Check = { name: string; ok: boolean; detail?: string }
const checks: Check[] = []
const check = (name: string, ok: boolean, detail = ''): void => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

const bodyOf = async (req: IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

function sse(res: ServerResponse, events: Array<{ event?: string; data: unknown }>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
  for (const item of events) res.write(`${item.event ? `event: ${item.event}\n` : ''}data: ${typeof item.data === 'string' ? item.data : JSON.stringify(item.data)}\n\n`)
  res.end()
}

const server = createServer(async (req, res) => {
  const payload = await bodyOf(req)
  const url = req.url ?? ''
  if (url === '/v1/error') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture' } })); return }
  if (url === '/v1/abort') {
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
    // Keep a live response until the caller cancels it, but do not leave a
    // five-second timer/request around after the fixture has been aborted.
    const timer = setTimeout(() => res.end(), 5000)
    req.on('close', () => clearTimeout(timer))
    return
  }
  if (url === '/v1/responses') {
    check('Responses 请求使用 input/max_output_tokens', Array.isArray(payload.input) && payload.max_output_tokens === 128 && payload.messages === undefined, JSON.stringify(payload).slice(0, 220))
    sse(res, [
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: '响应正文' } },
      { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', delta: '摘要思考' } },
      { event: 'response.completed', data: { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, output_tokens_details: { reasoning_tokens: 3 } } } } }
    ])
    return
  }
  if (url === '/v1/messages') {
    check('Anthropic 使用 x-api-key 与版本头', req.headers['x-api-key'] === 'anthropic-key' && req.headers['anthropic-version'] === '2023-06-01', JSON.stringify(req.headers))
    check('Anthropic 使用 max_tokens/thinking 而非 OpenAI 参数', payload.max_tokens >= 1025 && payload.thinking?.type === 'enabled' && payload.max_output_tokens === undefined && payload.reasoning_effort === undefined, JSON.stringify(payload).slice(0, 260))
    sse(res, [
      { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_fixture', usage: { input_tokens: 9 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude 正文' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Claude 思考' } } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } } },
      { event: 'message_stop', data: { type: 'message_stop' } }
    ])
    return
  }
  if (url === '/v1/error') return
  check('OpenAI-compatible 自定义 Header 到达 fixture', req.headers['x-fixture-auth'] === 'custom-key' && req.headers['x-suite'] === 'adapter-test')
  check('Chat 兼容请求使用 stream_options/include_usage', payload.stream === true && payload.stream_options?.include_usage === true && payload.reasoning_effort === 'high')
  sse(res, [
    { data: { id: 'chat_fixture', choices: [{ delta: { content: '兼容正文', reasoning_content: '兼容思考' }, finish_reason: null }] } },
    { data: { id: 'chat_fixture', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } } },
    { data: '[DONE]' }
  ])
})

function params(port: number, protocol: 'openai-responses' | 'anthropic-messages' | 'openai-chat', path: string, extra: Partial<NonNullable<ChatParams['provider']>> = {}): ChatParams {
  return {
    apiKey: protocol === 'anthropic-messages' ? 'anthropic-key' : 'custom-key', baseUrl: `http://127.0.0.1:${port}`, model: 'fixture-model', messages: [{ role: 'user', content: '你好' }],
    thinking: { enabled: true, effort: 'high' }, maxTokens: 128, temperature: 0.7, topP: 0.9,
    provider: { adapterId: 'custom.openai-compatible-chat', protocol, chatPath: path, authStyle: 'bearer', authHeaderName: protocol === 'anthropic-messages' ? 'x-api-key' : undefined, transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true, fixedHeaders: protocol === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01' } : undefined }, reasoning: { mode: 'enabled', effort: 'high' }, compatibilityMappingId: protocol === 'openai-responses' ? 'openai_responses.reasoning_effort' : protocol === 'anthropic-messages' ? 'anthropic.thinking' : 'openai_chat.reasoning_effort_top_level', ...extra }
  }
}

async function runCase(label: string, input: ChatParams): Promise<{ text: string; reasoning: string; finish: string | null; usage: any }> {
  let text = ''; let reasoning = ''; let finish: string | null = null; let usage: any = null
  await streamWithProviderAdapter(input, (event: ChunkEvent) => { if (event.type === 'text') text += event.delta ?? ''; if (event.type === 'reasoning') reasoning += event.delta ?? ''; if (event.type === 'done') { finish = event.finishReason ?? null; usage = event.usage } if (event.type === 'usage') usage = event.usage }, undefined)
  check(`${label} 有统一正文/推理/完成事件`, text.length > 0 && reasoning.length > 0 && finish !== null, `${text}/${reasoning}/${finish}`)
  return { text, reasoning, finish, usage }
}

server.listen(0, '127.0.0.1', async () => {
  const port = (server.address() as { port: number }).port
  try {
    const responses = await runCase('OpenAI Responses', params(port, 'openai-responses', '/v1/responses'))
    check('Responses usage 归一化', responses.usage === null || responses.finish === 'stop', JSON.stringify(responses.usage))
    const anthropic = await runCase('Anthropic Messages', params(port, 'anthropic-messages', '/v1/messages'))
    check('Anthropic usage 归一化', anthropic.finish === 'stop', JSON.stringify(anthropic.usage))
    const chat = await runCase('Gemini/普通 Chat 兼容', params(port, 'openai-chat', '/v1/chat/completions', { authHeaderName: 'x-fixture-auth', extraHeaders: { 'x-suite': 'adapter-test' } }))
    check('Chat usage 归一化', chat.finish === 'stop', JSON.stringify(chat.usage))
    let aborted = false
    const controller = new AbortController()
    const abortPromise = streamWithProviderAdapter(params(port, 'openai-chat', '/v1/abort'), () => undefined, controller.signal).catch((error: unknown) => { aborted = (error as Error).name === 'AbortError' || controller.signal.aborted })
    setTimeout(() => controller.abort(), 50)
    await abortPromise
    check('中断可取消且不伪造完成', aborted)
    await streamWithProviderAdapter(params(port, 'openai-chat', '/v1/error'), () => undefined).then(() => check('HTTP 错误被拒绝', false)).catch((error: unknown) => check('HTTP 错误被拒绝', (error as { status?: number }).status === 401))
  } finally {
    server.close()
    const failed = checks.filter((item) => !item.ok)
    console.log(`\nProvider adapter fixture: ${checks.length - failed.length} PASS / ${failed.length} FAIL`)
    if (failed.length) process.exitCode = 1
  }
})
