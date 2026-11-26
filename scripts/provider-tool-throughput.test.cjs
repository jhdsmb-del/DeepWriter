const assert = require('node:assert/strict')
const { test, before } = require('node:test')
const { build } = require('esbuild')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http')
const root = path.resolve(__dirname, '..')
let api
async function compile({ baseline, instrument = false } = {}) {
  const sources = new Map()
  for (const name of ['providerAdapters.ts', 'providerPerformance.ts', 'deepseek.ts']) {
    sources.set(name, baseline ? execFileSync('git', ['show', `${baseline}:src/main/${name}`], { cwd: root, encoding: 'utf8' }) : await fs.readFile(path.join(root, 'src/main', name), 'utf8'))
  }
  const built = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `export {streamChat} from './src/main/deepseek'; export * from './src/main/providerPerformance';` },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent', plugins: [{ name: 'tool-stream-candidate', setup(builder) {
      builder.onLoad({ filter: /[\\/](providerAdapters|providerPerformance|deepseek)\.ts$/ }, args => {
        const name = path.basename(args.path)
        let contents = sources.get(name)
        if (instrument && name === 'providerPerformance.ts') contents = contents.replace('for (const ch of text)', 'globalThis.__toolWeightScanned = (globalThis.__toolWeightScanned ?? 0) + text.length; for (const ch of text)')
        if (instrument) contents = contents.replace(/const snapshot = JSON\.stringify\((entry|acc)\)/g, (_, value) => `globalThis.__toolSerialized = (globalThis.__toolSerialized ?? 0) + ${value}.name.length + ${value}.arguments.length; const snapshot = JSON.stringify(${value})`)
        return { contents, loader: 'ts', resolveDir: path.dirname(args.path) }
      })
    } }] })
  const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
  return loaded.exports
}
before(async () => { api = await compile() })
const weight = text => [...text].reduce((sum, ch) => sum + (ch.codePointAt(0) >= 0x3000 && ch.codePointAt(0) <= 0x9fff ? 4 : 1), 0)

test('incremental meter equals scanner for split surrogates, field seams, duplicates, changes and metadata-free fallback', () => {
  let now = 0
  const fast = [], scanned = []
  const a = api.createProviderPerformance(s => fast.push(s), () => now, 'same')
  const b = api.createProviderPerformance(s => scanned.push(s), () => now, 'same')
  const start = { type: 'started', innerAttempt: 1, startedAt: 1000 }
  a.lifecycle(start); b.lifecycle(start)
  const meter = api.createToolOutputMeter()
  let name = '', args = ''
  const frame = (nameDelta, argsDelta, index = 0) => {
    name += nameDelta; args += argsDelta; meter.name(nameDelta); meter.arguments(argsDelta)
    const event = meter.event({ type: 'tool_call', tool: { index, id: 'call', name, arguments: args } })
    assert.deepEqual(Object.keys(event), ['type', 'tool'], 'internal metadata never enters public event serialization')
    now += 30
    a.chunk(event); b.chunk(JSON.parse(JSON.stringify(event)))
    a.lifecycle({ type: 'terminal', innerAttempt: 999, outcome: 'success' }) // unrelated attempt is a no-op
  }
  for (const deltas of [['tool\ud83d', '\ude00'], ['\ude00', '中'], ['', '\ud83d'], ['', '\ude00'], ['', 'ab'], ['', 'ab'], ['', '}}'], ['', '}}'], ['\ud800', ''], ['', '']]) frame(...deltas)
  // A downstream producer may clone or replace a snapshot, or send a smaller
  // full value. Without matching process-local metadata, preserve old rules.
  for (const event of [
    { type: 'tool_call', tool: { index: 0, id: 'call', name: 'r', arguments: '{}' } },
    { type: 'tool_call', tool: { index: 0, id: 'call', name: 'r', arguments: '{中文}' } },
    { type: 'tool_call', tool: { index: 1, id: 'other', name: '中文', arguments: '😀' } },
  ]) { now += 30; a.chunk(event); b.chunk(event) }
  const mutated = meter.event({ type: 'tool_call', tool: { index: 0, id: 'call', name, arguments: args } })
  mutated.tool.arguments = '另一份替换快照'
  a.chunk(mutated); b.chunk(JSON.parse(JSON.stringify(mutated)))
  now = 500
  const terminal = { type: 'terminal', innerAttempt: 1, outcome: 'success', performanceUsage: api.readPerformanceUsage('openai-chat', { usage: { completion_tokens: 37 } }) }
  a.lifecycle(terminal); b.lifecycle(terminal)
  assert.deepEqual(fast, scanned)
  assert.equal(fast.at(-1).actualTokensPerSecond, 74)
  a.close(); b.close()
})

const sse = (value, event) => `${event ? `event: ${event}\n` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
function wire(protocol, fragments, { replay = false, snapshots = false } = {}) {
  const frames = [], full = fragments.join(''), name = 'write_file'
  if (protocol === 'openai-responses') {
    frames.push(sse({ output_index: 0, item: { type: 'function_call', id: 'item', call_id: 'call', name, arguments: '' } }, 'response.output_item.added'))
    fragments.forEach((delta, index) => {
      const json = { output_index: 0, item_id: 'item', delta, ...(replay ? { sequence_number: index + 1 } : {}) }
      frames.push(sse(json, 'response.function_call_arguments.delta'))
      if (replay && index === 1) frames.push(sse(json, 'response.function_call_arguments.delta'))
    })
    if (snapshots) {
      frames.push(sse({ output_index: 0, item_id: 'item', arguments: full }, 'response.function_call_arguments.done'))
      frames.push(sse({ output_index: 0, item: { type: 'function_call', id: 'item', call_id: 'call', name, arguments: full } }, 'response.output_item.done'))
    }
    frames.push(sse({ response: { usage: { input_tokens: 10, output_tokens: 37 } } }, 'response.completed'))
  } else if (protocol === 'anthropic-messages') {
    frames.push(sse({ index: 0, content_block: { type: 'tool_use', id: 'call', name } }, 'content_block_start'))
    fragments.forEach((partial_json, index) => {
      const json = { index: 0, delta: { type: 'input_json_delta', partial_json }, ...(replay ? { sequence_number: index + 1 } : {}) }
      frames.push(sse(json, 'content_block_delta'))
      if (replay && index === 1) frames.push(sse(json, 'content_block_delta'))
    })
    frames.push(sse({ delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 37 } }, 'message_delta'), sse({}, 'message_stop'))
  } else {
    frames.push(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name, arguments: '' } }] } }] }))
    fragments.forEach((delta, index) => {
      const json = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: delta } }] } }], ...(replay ? { sequence_number: index + 1 } : {}) }
      frames.push(sse(json)); if (replay && index === 1) frames.push(sse(json))
    })
    frames.push(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 37 } }), sse('[DONE]'))
  }
  return frames.join('')
}
const params = (baseUrl, protocol) => ({ apiKey: 'synthetic-tool-throughput-key', baseUrl, model: 'fixture-model', messages: [{ role: 'user', content: 'local tool fixture' }],
  thinking: { enabled: false, effort: 'high' }, maxTokens: 128,
  provider: { adapterId: 'custom.openai-compatible-chat', protocol, chatPath: '/stream', authStyle: 'bearer', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true }, reasoning: { mode: 'default', effort: null } } })
async function withServer(fn) {
  let payload = ''
  const server = http.createServer(async (req, res) => { for await (const _ of req) {} res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(payload) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { return await fn(`http://127.0.0.1:${server.address().port}`, value => { payload = value }) }
  finally { await new Promise(resolve => server.close(resolve)) }
}

test('real wire emits unchanged cumulative public snapshots and exact terminal weights across four protocols', () => withServer(async (url, setPayload) => {
  const fragments = ['{"text":"\ud83d', '\ude00中', 'ab', 'ab', '}}', '}}', '"}']
  for (const protocol of ['deepseek-chat', 'openai-chat', 'openai-responses', 'anthropic-messages']) {
    setPayload(wire(protocol, fragments, { replay: true, snapshots: true }))
    const events = []
    const result = await api.streamChat(params(url, protocol), event => events.push(event))
    const tools = events.filter(event => event.type === 'tool_call')
    assert.equal(result.finishReason, 'tool_calls')
    assert.equal(tools.length, fragments.length + 1, protocol)
    let args = ''
    tools.forEach((event, index) => {
      if (index) args += fragments[index - 1]
      assert.equal(event.tool.arguments, args)
      assert.equal(event.tool.name, 'write_file'); assert.equal(event.tool.id, 'call')
      assert.deepEqual(Object.keys(event), ['type', 'tool'])
    })
    const terminal = events.filter(event => event.type === 'performance').at(-1).performance
    assert.equal(terminal.estimatedOutputTokens, Math.ceil(weight('write_file' + args) / 4))
    assert.equal(terminal.outputTokens, 37)
    assert.equal(terminal.actualTokensPerSecond, 37000 / terminal.elapsedMs)
    assert.equal(terminal.estimateMethod, 'visible_cjk_1_other_quarter_v1')
  }
}))

test('late IDs, empty no-ops and interleaved tools retain their snapshot and metering semantics', () => withServer(async (url, setPayload) => {
  const event = call => sse({ choices: [{ delta: { tool_calls: [call] } }] })
  const payload = [event({ index: 0, function: { name: 'read', arguments: '{' } }), event({ index: 0, function: { arguments: '' } }),
    event({ index: 0, id: 'late' }), event({ index: 1, id: 'other', function: { name: 'write', arguments: '{}' } }), event({ index: 0, function: { arguments: '}' } }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), sse('[DONE]')].join('')
  for (const protocol of ['deepseek-chat', 'openai-chat']) {
    setPayload(payload)
    const events = []; await api.streamChat(params(url, protocol), event => events.push(event))
    assert.deepEqual(events.filter(e => e.type === 'tool_call').map(e => [e.tool.index, e.tool.id, e.tool.arguments]), [[0, '', '{'], [0, 'late', '{'], [1, 'other', '{}'], [0, 'late', '{}']])
    assert.equal(events.filter(e => e.type === 'performance').at(-1).performance.estimatedOutputTokens, Math.ceil(weight('read{}write{}') / 4))
  }
}))

test('a consumer modifying its public snapshot cannot change producer deduplication state', () => withServer(async (url, setPayload) => {
  const call = { index: 0, id: 'call', function: { name: 'read', arguments: '{}' } }
  const payload = sse({ choices: [{ delta: { tool_calls: [call] } }] }) + sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call' }] } }] }) +
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + sse('[DONE]')
  for (const protocol of ['deepseek-chat', 'openai-chat']) {
    setPayload(payload)
    let tools = 0, terminal
    await api.streamChat(params(url, protocol), event => {
      if (event.type === 'tool_call') { tools++; event.tool.id = 'local-view'; event.tool.arguments = 'local decoration' }
      if (event.type === 'performance') terminal = event.performance
    })
    assert.equal(tools, 1)
    assert.equal(terminal.estimatedOutputTokens, Math.ceil(weight('read{}') / 4))
  }
}))

test('Responses authoritative snapshots may extend a prefix, but conflicting snapshots/IDs/replays still fail closed', () => withServer(async (url, setPayload) => {
  const prefix = '{"text":"\ud83d', full = '{"text":"😀中"}'
  const initial = sse({ output_index: 0, item: { type: 'function_call', id: 'item', call_id: 'call', name: 'read', arguments: prefix } }, 'response.output_item.added')
  setPayload(initial + sse({ item_id: 'item', name: 'read_file', arguments: full }, 'response.function_call_arguments.done') +
    sse({ output_index: 0, item: { type: 'function_call', id: 'item', call_id: 'call', name: 'read_file', arguments: full } }, 'response.output_item.done') +
    sse({}, 'response.completed'))
  const events = []; await api.streamChat(params(url, 'openai-responses'), event => events.push(event))
  assert.deepEqual(events.filter(e => e.type === 'tool_call').map(e => [e.tool.name, e.tool.arguments]), [['read', prefix], ['read_file', full]])
  assert.equal(events.filter(e => e.type === 'performance').at(-1).performance.estimatedOutputTokens, Math.ceil(weight('read_file' + full) / 4))
  const frame = (call, sequence_number) => sse({ sequence_number, choices: [{ delta: { tool_calls: [call] } }] })
  for (const [protocol, payload] of [
    ['openai-responses', initial + sse({ item_id: 'item', arguments: '{"other":1}' }, 'response.function_call_arguments.done')],
    ['deepseek-chat', frame({ index: 0, id: 'call', function: { name: 'read', arguments: 'ab' } }, 1) + frame({ index: 0, function: { arguments: 'xy' } }, 1)],
    ['openai-chat', frame({ index: 0, id: 'call', function: { name: 'read', arguments: 'ab' } }, 1) + frame({ index: 0, id: 'other' }, 2)],
  ]) {
    setPayload(payload)
    const received = []
    await assert.rejects(api.streamChat(params(url, protocol), event => received.push(event)), /provider_protocol_mismatch/)
    assert.equal(received.filter(e => e.type === 'tool_call').length, 1)
    assert.equal(received.filter(e => e.type === 'performance').at(-1).performance.status, 'failed')
  }
}))

test('optional historical wire-to-sampler throughput comparison', { skip: !process.env.DW_TOOL_BASELINE_COMMIT }, async t => {
  const baseline = await compile({ baseline: process.env.DW_TOOL_BASELINE_COMMIT, instrument: true })
  const candidate = await compile({ instrument: true })
  await withServer(async (url, setPayload) => {
    for (const language of ['English', 'Chinese']) for (const protocol of ['deepseek-chat', 'openai-chat']) {
      const fragments = ['{"text":"', ...Array(2048).fill((language === 'Chinese' ? '正文汉字' : 'abcd').repeat(16)), '"}']
      setPayload(wire(protocol, fragments))
      const runs = []
      for (const implementation of [baseline, candidate]) {
        globalThis.__toolWeightScanned = 0; globalThis.__toolSerialized = 0
        let finalTool, terminal, count = 0
        const started = performance.now()
        await implementation.streamChat(params(url, protocol), event => {
          if (event.type === 'tool_call') { finalTool = event.tool; count++ }
          if (event.type === 'performance') terminal = event.performance
        })
        runs.push({ elapsedMs: +(performance.now() - started).toFixed(2), weightInputUnits: globalThis.__toolWeightScanned, serializedToolUnits: globalThis.__toolSerialized,
          count, finalTool, estimatedOutputTokens: terminal.estimatedOutputTokens, reportedOutputTokens: terminal.outputTokens })
      }
      const [before, after] = runs
      assert.deepEqual(after.finalTool, before.finalTool)
      for (const key of ['count', 'estimatedOutputTokens', 'reportedOutputTokens']) assert.equal(after[key], before[key])
      assert.ok(after.weightInputUnits < fragments.join('').length + 100, 'append-delta metering scans only new content')
      assert.equal(after.serializedToolUnits, 0)
      const summary = runs.map(({ finalTool, ...rest }) => rest)
      t.diagnostic(`${protocol} ${language}, ${fragments.join('').length} final argument UTF16 units: before/after ${JSON.stringify(summary)}`)
    }
  })
  delete globalThis.__toolWeightScanned; delete globalThis.__toolSerialized
})
