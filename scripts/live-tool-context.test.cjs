'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const built = esbuild.buildSync({
  absWorkingDir: root, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false,
  alias: { electron: path.join(root, 'src/cli/host.ts') },
  stdin: { resolveDir: root, loader: 'ts', contents: `
    export { projectOlderReadResults } from './src/main/liveToolProjection'
    export { createContextService } from './src/main/contextService'
    export { createModelCallAdapter } from './src/main/runKernelAdapter'
    export { estimateTokens } from './src/shared/types'
  ` }
})
const loaded = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
const { projectOlderReadResults, createContextService, createModelCallAdapter, estimateTokens } = loaded.exports

const payload = JSON.stringify({ ok: true, message: '文件 opening\n' + '旧资料😀'.repeat(1700) + '\nending', exitCode: null, backupId: null })
const failed = JSON.stringify({ ...JSON.parse(payload), ok: false })
const batch = entries => [
  { role: 'assistant', content: '', tool_calls: entries.map(([id, name]) => ({ id, name, arguments: '{}' })) },
  ...entries.map(([id, , content = payload]) => ({ role: 'tool', tool_call_id: id, content }))
]
const transcript = () => [
  { role: 'user', content: '整理几份文件的时间线。' },
  ...batch([['old', 'read_file'], ['write', 'write_file'], ['error', 'search_files', failed]]),
  ...batch([['recent1', 'list_files']]),
  ...batch([['recent2', 'read_file']])
]

test('shortens only complete older read results without changing receipts, IDs or stored data', () => {
  const original = transcript()
  const before = structuredClone(original)
  const { messages, projection } = projectOlderReadResults(original)
  assert.deepEqual(original, before)
  assert.equal(messages.length, original.length)
  assert.deepEqual(projection.excerpts, new Set([messages[2]]))
  for (const [index, item] of messages.entries()) {
    if (index !== 2) assert.equal(item, original[index])
  }
  assert.equal(messages[2].tool_call_id, 'old')
  const excerpt = JSON.parse(messages[2].content)
  assert.match(excerpt.message, /^文件 opening/)
  assert.match(excerpt.message, /省略 \d+ 字/)
  assert.match(excerpt.message, /ending$/)
  assert.doesNotMatch(excerpt.message, /[\uD800-\uDFFF]/u)
  assert.equal(excerpt.ok, true)
  assert.equal(projection.estimatedSavedTokens, estimateTokens(payload) - estimateTokens(messages[2].content))
  assert.ok(projection.estimatedSavedTokens > 1000)
  assert.equal(projectOlderReadResults(original.filter(message => message.tool_call_id !== 'error')), null)
  assert.equal(projectOlderReadResults(original.slice(5)), null)
})

test('the provider receives the shortened transcript and the durable manifest records the same savings', async () => {
  const original = transcript()
  const { messages, projection } = projectOlderReadResults(original)
  const persisted = []
  const service = createContextService({}, { appendManifest: value => persisted.push(value) })
  const currentInput = original[0]
  let wire
  const run = createModelCallAdapter({
    getApi: () => ({ model: 'fixture', profileId: 'fixture', baseUrl: 'http://127.0.0.1:1', apiKey: '', maxTokens: 256, thinking: { enabled: false, effort: 'low' } }),
    getConfig: () => ({ runMode: 'agent' }), getSignal: () => undefined, buildPrefix: async () => [],
    assembleContext: async () => ({
      messages: [currentInput], userContent: currentInput.content,
      manifest: { contextWindowTokens: 100_000, segments: [], outputReserveTokens: 256 },
      contextV2: {
        runId: 'fixture', requestId: 'fixture', mode: 'optimized', decisions: [],
        selectedEstimate: { value: estimateTokens(currentInput.content) },
        fullBaselineEstimate: { value: estimateTokens(currentInput.content) }
      }
    }),
    persistContext: service.persistContext,
    streamChatImpl: async (params, emit) => {
      assert.equal(persisted.length, 1, 'manifest is written before sending')
      wire = params.messages
      emit({ type: 'done', finishReason: 'stop' })
    }
  })
  for await (const _ of await run({ runId: 'fixture', phase: 'generating', round: 4, turnSeq: 8, messages, liveToolProjection: projection })) {}
  assert.deepEqual(wire, messages)
  assert.equal(persisted[0].estimatedSavedTokens, projection.estimatedSavedTokens)
  assert.equal(persisted[0].decisions.filter(entry => entry.source.displayLabel.endsWith('（摘录）')).length, 1)
})
