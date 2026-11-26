const http = require('node:http')

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const c of chunks) {
    res.write(`data: ${JSON.stringify(c)}\n\n`)
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

function err(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message, type: 'mock_api_error', code: 'err' + status } }))
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    const { messages = [] } = JSON.parse(body || '{}')
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool')
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
    const joined = messages.map((m) => m.content ?? '').join(' ')

    if (joined.includes('err401')) return err(res, 401, 'Invalid API key provided')
    if (joined.includes('err429')) return err(res, 429, 'Rate limit reached, please retry later')
    if (joined.includes('err500')) return err(res, 500, 'Internal server error')
    const promptTokens = Math.ceil(joined.length / 3)
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: 10,
      total_tokens: promptTokens + 10,
      prompt_cache_hit_tokens: 6,
      prompt_cache_miss_tokens: Math.max(0, promptTokens - 6),
      completion_tokens_details: { reasoning_tokens: 4 }
    }

    if (lastTool) {
      return sse(res, [
        { id: 'm', choices: [{ index: 0, delta: { content: '工具执行完成，文档已生成。', reasoning_content: 'r', role: 'assistant' }, finish_reason: null }], usage: null },
        { id: 'm', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }], usage }
      ])
    }
    if (joined.includes('总结历史')) {
      return sse(res, [
        { id: 'm', choices: [{ index: 0, delta: { content: '【摘要】历史要点：主角决定出发。', role: 'assistant' }, finish_reason: null }], usage: null },
        { id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }
      ])
    }
    if (lastAssistant && joined.includes('续写')) {
      return sse(res, [
        { id: 'm', choices: [{ index: 0, delta: { content: '第二段内容，剧情继续推进。', role: 'assistant' }, finish_reason: null }], usage: null },
        { id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }
      ])
    }
    if (joined.includes('生成文档')) {
      return sse(res, [
        { id: 'm', choices: [{ index: 0, delta: { content: '我来生成文档。', reasoning_content: 'r', role: 'assistant' }, finish_reason: null }], usage: null },
        {
          id: 'm',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'generate_markdown_', arguments: '{"filename":"a.md","con' } }] }, finish_reason: null }],
          usage: null
        },
        { id: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'doc', arguments: 'tent":"hi"}' } }] }, finish_reason: null }], usage: null },
        { id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }
      ])
    }
    return sse(res, [
      { id: 'm', choices: [{ index: 0, delta: { content: '第一段内容。', reasoning_content: 'thinking…', role: 'assistant' }, finish_reason: null }], usage: null },
      { id: 'm', choices: [{ index: 0, delta: { content: '（截断处）', role: 'assistant' }, finish_reason: null }], usage: null },
      { id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage }
    ])
  })
})

server.listen(18789, '127.0.0.1', () => console.log('mock v4 api on 127.0.0.1:18789'))
