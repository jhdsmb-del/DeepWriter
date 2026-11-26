const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs/promises')
const { before, test } = require('node:test')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
before(async () => {
  const built = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
    export * from './src/main/toolReadBudget';
    export {fitOlderReadBatches,continuedReadReserveTokens,projectOlderReadResults} from './src/main/liveToolProjection';
    export {estimateTokens} from './src/shared/types';
    export {createModelCallAdapter,createToolExecutor,createRunStorePort} from './src/main/runKernelAdapter';
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {createRepository} from './src/main/db/repository';
    export {getTool} from './src/main/tools';
    export {configureTerminalHost} from './src/cli/host';` }, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    write: false, logLevel: 'silent', alias: { electron: path.join(root, 'src/cli/host.ts') } })
  const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports); api = module.exports
})

test('continued reads reclaim only complete successful old batches early; new batch tools preserve partial failures and latest dependencies', () => {
  const batch = (id, name, message, ok = true) => [
    { role: 'assistant', content: '', tool_calls: [{ id, name, arguments: '{}' }] },
    { role: 'tool', tool_call_id: id, content: JSON.stringify({ ok, message, exitCode: null, backupId: null }) }
  ]
  const messages = [{ role: 'user', content: '原任务不可删除' },
    ...batch('old-find', 'find_files', JSON.stringify({ matches: [{ path: '旧路径'.repeat(800) }], coverage: { unreadable: 0, unprintable_paths: 0 } })),
    ...batch('old-batch', 'read_files', JSON.stringify({ files: [{ ok: true, message: '旧的已读正文'.repeat(500) }] })),
    ...batch('partial', 'read_files', JSON.stringify({ files: [{ ok: true, message: '成功部分'.repeat(1200) }, { ok: false, message: '未授权，未读' }] })),
    ...batch('unreadable', 'find_files', JSON.stringify({ matches: [], coverage: { unreadable: 1, unprintable_paths: 0 } })),
    ...batch('write', 'write_file', '实际写入回执'),
    ...batch('error', 'read_file', '实际失败', false),
    ...batch('recent-1', 'read_file', '文件 fixture（已读）：\n最近依赖一'),
    ...batch('recent-2', 'read_file', 'ZIP条目 "fixture"\n文本范围 [2:100, 2:200)；尚未读完，续读时保留archive_entry并用 cursor=z1:abc:200\n最近依赖二')]
  const before = structuredClone(messages), tokens = items => items.reduce((sum, item) => sum + api.estimateTokens(JSON.stringify(item)), 0)
  assert.equal(api.fitOlderReadBatches(messages, tokens(messages) + 100), null, 'old input gate alone does not reclaim anything')
  const reserved = api.continuedReadReserveTokens(messages, 6000)
  assert.equal(reserved, 2048)
  const projected = api.fitOlderReadBatches(messages, tokens(messages) - reserved)
  assert.ok(projected)
  assert.deepEqual(messages, before)
  const ids = projected.projection.dropped.filter(m => m.role === 'tool').map(m => m.tool_call_id)
  assert.ok(ids.includes('old-find') || ids.includes('old-batch'))
  for (const id of ['partial', 'unreadable', 'write', 'error', 'recent-1', 'recent-2']) {
    assert.ok(!ids.includes(id), id)
    assert.ok(projected.messages.some(m => m.tool_call_id === id))
  }
  const excerpted = api.projectOlderReadResults(messages)
  assert.ok(!excerpted || excerpted.messages.find(m => m.tool_call_id === 'partial').content === messages.find(m => m.tool_call_id === 'partial').content)
  assert.equal(api.continuedReadReserveTokens(batch('end', 'read_file', '文件 fixture（已到文件末尾）：\n续读 cursor=z1:source-text:4'), 6000), 0, 'source text is not a host cursor')
  assert.equal(api.continuedReadReserveTokens(batch('fail', 'read_file', '续读 cursor=z1:abc:4', false), 6000), 0)
  assert.equal(api.continuedReadReserveTokens(messages, 0), 0)
})

test('read allowance uses frozen window and exact schemas/live/output/assistant, without lifting small or shrinking large models globally', () => {
  const config = { contextPolicy: { contextWindowTokens: 131072 }, providerProfileSnapshots: { draft: { profileId: 'selected', model: { contextWindow: 8192 } } } }
  assert.equal(api.frozenToolReadWindow(config, 'selected'), 8192)
  assert.equal(api.frozenToolReadWindow({ cliProvider: { config: { contextWindow: 8192 } } }), 8192)
  assert.equal(api.frozenToolReadWindow({}, undefined), null)
  const small = { windowTokens: 8192, bodyJson: JSON.stringify({ messages: [{ role: 'user', content: '现有上下文'.repeat(100) }], tools: [{ schema: '架构'.repeat(100) }], max_tokens: 2048 }), maxOutputTokens: 2048,
    assistant: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"fixture.zip"}' }] }, toolCount: 1 }
  const remaining = api.deriveToolReadBudgetChars(small)
  assert.ok(remaining > 0 && remaining < 2000)
  assert.ok(api.deriveToolReadBudgetChars({ ...small, windowTokens: 131072 }) > 14000)
  assert.ok(api.deriveToolReadBudgetChars({ ...small, bodyJson: small.bodyJson.replace('现有上下文', '额外live工具正文'.repeat(100)) }) < remaining)
  assert.ok(api.deriveToolReadBudgetChars({ ...small, assistant: { role: 'assistant', content: '额外生成内容'.repeat(100) } }) < remaining)
  assert.ok(api.deriveToolReadBudgetChars({ ...small, bodyJson: small.bodyJson.replace('2048', '4096') }) < remaining)
  assert.ok(api.deriveToolReadBudgetChars({ ...small, toolCount: 3 }) < remaining)
  assert.ok(api.deriveToolReadBudgetChars({ ...small, observedInputTokens: 4000 }) < remaining)
  assert.equal(api.deriveToolReadBudgetChars({ ...small, observedInputTokens: 1 }), remaining)
  for (const changed of [{ windowTokens: null }, { windowTokens: 1024 }, { bodyJson: null }, { bodyJson: '{invalid' }]) assert.equal(api.deriveToolReadBudgetChars({ ...small, ...changed }), 0)
})

test('actual adapter → engine per-turn split → shared desktop/CLI executor passes host-only budget to normal and attached reads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-read-budget-'))
  api.configureTerminalHost({ dataDir: dir, docDir: dir })
  const repo = api.createRepository(path.join(dir, 'fixture.db')); repo.open()
  const config = runId => ({ sessionId: runId, model: 'fixture-model', runMode: 'agent', maxTokens: 2048, maxTurns: 4, pagedFileReads: true,
    contextPolicy: { contextWindowTokens: runId === 'large' ? 131072 : runId === 'full' ? 2800 : 8192, outputReserveTokens: 2048 },
    toolPolicy: { allowList: ['read_file'] }, providerCallBudget: { maxTokens: 500000, maxWallClockMs: 300000 } })
  const observed = [], requests = new Map(); let engine
  const read = api.getTool('read_file'), originalExecute = read.execute
  read.execute = async (_args, _dir, env) => { observed.push({ runId: env.runId, kind: 'file', budget: env.readBudgetChars }); return { ok: true, message: '合成普通文件正文' } }
  const adapter = api.createModelCallAdapter({
    getConfig: config, getSignal: runId => engine.abortSignal(runId), buildPrefix: async () => [{ role: 'system', content: '冻结系统前缀'.repeat(20) }],
    getApi: () => ({ profileId: 'fixture-profile', apiKey: 'synthetic-only', baseUrl: 'https://fixture.invalid', model: 'fixture-model', maxTokens: 2048,
      thinking: { enabled: false, effort: 'high' }, temperature: 1, topP: 1, supportsTools: true }),
    streamChatImpl: async (params, emit, _signal, _retry, _attempt, _lifecycle, before) => {
      const runId = params.messages.find(m => m.role === 'user').content
      const call = (requests.get(runId) ?? 0) + 1; requests.set(runId, call)
      await before(1, { bodyJson: JSON.stringify({ model: params.model, messages: params.messages, tools: params.tools, max_tokens: params.maxTokens }), model: params.model, maxTokens: params.maxTokens })
      if (call === 1) {
        emit({ type: 'tool_call', tool: { index: 0, id: `${runId}-normal`, name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt', readBudgetChars: 9999999 }) } })
        emit({ type: 'tool_call', tool: { index: 1, id: `${runId}-attached`, name: 'read_file', arguments: JSON.stringify({ path: 'attachment:fixture', readBudgetChars: 9999999 }) } })
        emit({ type: 'done', finishReason: 'tool_calls', usage: null })
      } else { emit({ type: 'text', delta: '本地任务完成。' }); emit({ type: 'done', finishReason: 'stop', usage: null }) }
    }
  })
  const host = api.createToolExecutor({ getSignal: runId => engine.abortSignal(runId), getAllowList: () => ['read_file'],
    getEnv: runId => ({ pagedFileReads: true, workDir: dir, docDir: dir, sessionId: runId }),
    readAttachedZip: async (runId, _args, _signal, budget) => { observed.push({ runId, kind: 'attached', budget }); return '合成附件正文' } })
  const store = api.createRunStorePort(repo)
  engine = api.createAgentRunEngine({ store, modelCall: adapter, toolExecutor: host, getConfig: config, onEvent: () => {}, onRunUpdate: () => {} })
  try {
    for (const runId of ['small', 'large', 'full']) {
      const cfg = config(runId)
      await engine.start({ runId, sessionId: runId, config: cfg })
      await store.appendTurn({ turnId: `${runId}-user`, runId, turnSeq: 1, role: 'user', content: runId, createdAt: Date.now() })
      await engine.step(runId)
      const state = await engine.getState(runId)
      assert.equal(state.run.status, 'completed', JSON.stringify(state.run))
      const values = observed.filter(o => o.runId === runId)
      assert.equal(values.length, 2); assert.equal(values[0].budget, values[1].budget)
      assert.ok(Number.isSafeInteger(values[0].budget))
      if (runId === 'small') assert.ok(values[0].budget > 0 && values[0].budget < 1500)
      if (runId === 'large') assert.ok(values[0].budget > 14000)
      if (runId === 'full') assert.equal(values[0].budget, 0)
      const rows = repo.getToolCallsByRun(runId)
      const saved = JSON.parse(repo.getRunEvidence(runId, `tool_read_budget:${rows[0].turn_id}`).json)
      assert.equal(saved.readBudgetChars, values[0].budget)
      assert.equal(requests.get(runId), 2)
    }
  } finally {
    read.execute = originalExecute; repo.close()
    assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('dw-read-budget-'))
    await fs.rm(dir, { recursive: true, force: true })
  }
})
