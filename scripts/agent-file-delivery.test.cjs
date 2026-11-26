'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { build, buildSync } = require('esbuild')
const { DatabaseSync } = require('node:sqlite')
const root = path.resolve(__dirname, '..')

test('ordinary chat never stats historical writes; an old run cannot prove a new delivery, and destination binding preserves source names', async t => {
  const built = buildSync({ entryPoints: [path.join(root, 'src/main/jobs/fileDelivery.ts')], bundle: true, platform: 'node', format: 'cjs', write: false })
  const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
  const api = loaded.exports, config = { workDir: root }, input = { runId: 'current', config, state: api.newFileDeliveryState(), tools: [{ runId: 'old-run', toolCallId: 'old-write', name: 'write_file', status: 'completed', resultJson: JSON.stringify({ ok: true, path: path.join(root, 'source.md'), size: 10 }) }] }
  let stats = 0
  t.mock.method(fs, 'stat', async () => { stats++; throw new Error('This path must not be probed') })
  let value = await api.assessFileDelivery({ ...input, tools: input.tools.map(tool => ({ ...tool, runId: 'current' })), turns: [{ role: 'user', content: '介绍一下城市历史。' }] })
  assert.equal(value.ready, true); assert.equal(stats, 0)
  value = await api.assessFileDelivery({ ...input, turns: [{ role: 'user', content: '请创建 source.md 文件。' }] })
  assert.equal(value.ready, false); assert.equal(stats, 0)
  assert.deepEqual(api.fileDeliveryObligation('请读取「素材.md」，把总结写入「source.md」。', 'user').targets, ['source.md'])
  assert.deepEqual(api.fileDeliveryObligation('不要改「素材.md」，只把总结保存为「结果.md」。', 'user').targets, ['结果.md'])
})

test('real Agent file delivery rejects self-report, failed/old/wrong-target evidence, corrects to actual tools, and leaves tutorial chat alone', { timeout: 90000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-file-delivery-'))
  const built = await build({ stdin: { contents: `export {createCliRuntime} from './src/cli/runtime'; export {loadCliConfig} from './src/cli/config'; export {createChunkTranslator} from './src/main/runKernelAdapter'`, resolveDir: root, loader: 'ts' }, bundle: true, packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
  const api = loaded.exports
  let scenario, phase, seen = []
  const write = (file, content = '实际文件内容') => ({ tool_calls: [{ index: 0, id: 'write-' + phase, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content }) } }] })
  const server = http.createServer((req, res) => { let raw = ''; req.on('data', part => { raw += part }); req.on('end', () => {
    const request = JSON.parse(raw), index = phase++; seen.push(request)
    let delta, finish = 'stop'
    if (scenario === 'build-artifact' && index === 0) { delta = { tool_calls: [{ index: 0, id: 'package', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: `node -e "require('fs').writeFileSync('build.zip',Buffer.from('504b0506000000000000000000000000000000000000','hex'))"` }) } }] }; finish = 'tool_calls' }
    else if (scenario === 'build-artifact') delta = { content: '已生成 `build.zip`，打包完成。' }
    else if (scenario === 'wrong-report' && index === 0) { delta = write('wanted/note.md'); finish = 'tool_calls' }
    else if (scenario === 'wrong-report') delta = { content: index === 1 ? '已写入 `other/note.md`。虚构完成。' : '已写入 `wanted/note.md`。可检查文件。' }
    else if (['source-output', 'negative-source'].includes(scenario) && index === 0) { delta = { tool_calls: [{ index: 0, id: 'source-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '素材.md' }) } }] }; finish = 'tool_calls' }
    else if (['source-output', 'negative-source'].includes(scenario) && index === 1) { delta = write('结果.md'); finish = 'tool_calls' }
    else if (['source-output', 'negative-source'].includes(scenario)) delta = { content: '已将「素材.md」的总结写入「结果.md」，源文件没有改动。' }
    else if (scenario === 'correct' && index === 0) delta = { content: '已写入 `note.md`。这是未执行的旧假话。' }
    else if (scenario === 'correct' && index === 1) { delta = write('note.md'); finish = 'tool_calls' }
    else if (scenario === 'wrong' && index === 0) { delta = write('other/note.md'); finish = 'tool_calls' }
    else if (scenario === 'failed' && index === 0) { delta = write('blocked.md'); finish = 'tool_calls' }
    else if (['refused', 'cancel'].includes(scenario) && index === 0) { delta = { content: '已写入 `note.md`。虚构完成。', ...write('note.md') }; finish = 'tool_calls' }
    else if (scenario === 'tutorial') delta = { content: '示例：把文本传给 write_file 即可；这里只解释如何保存 note.md，不执行写入。' }
    else if (scenario === 'report-text') delta = { content: '报告已经生成，以下是正文：本次调查关注城市生活。' }
    else if (scenario === 'read-only' && index === 0) { delta = { tool_calls: [{ index: 0, id: 'read-existing', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.md' }) } }] }; finish = 'tool_calls' }
    else delta = { content: scenario === 'wrong' ? '已写入 `wanted/note.md`。虚构完成。' : scenario === 'correct' ? '已写入 `note.md`。可检查文件。' : '已写入 `note.md`。虚构完成。' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n')
  }) })
  const run = async (directory, prompt, resumeRunId) => {
    const events = [], options = { 'no-web': true }, { config, secret } = await api.loadCliConfig(directory, options)
    let runtime
    runtime = await api.createCliRuntime({ dataDir: directory, config, secret, options, emit: (type, data) => events.push({ type, data }), ask: async () => {
      if (scenario === 'cancel') { await runtime.interrupt('cancel'); return false }
      return scenario !== 'refused'
    } })
    try { if (resumeRunId) await runtime.resume(resumeRunId); else await runtime.agent(prompt); return { events, result: events.find(event => event.type === 'result')?.data } }
    finally { await runtime.close() }
  }
  const database = async (directory, callback) => {
    const filename = (await fs.readdir(directory)).find(file => /\.(?:db|sqlite)$/u.test(file))
    const db = new DatabaseSync(path.join(directory, filename), { readOnly: true })
    try { return callback(db) } finally { db.close() }
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    for (scenario of ['correct', 'stalled', 'wrong', 'failed', 'refused', 'cancel', 'old', 'read-only', 'tutorial', 'report-text', 'source-output', 'negative-source', 'build-artifact', 'wrong-report']) {
      phase = 0; seen = []
      const directory = path.join(home, scenario); await fs.mkdir(directory)
      await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, loopback: true, keyEnv: 'DW_FILE_TEST_KEY', supportsTools: true, contextWindow: 8192, maxTokens: 2048, workDir: directory, docDir: directory }))
      if (scenario === 'failed') await fs.mkdir(path.join(directory, 'blocked.md'))
      if (['old', 'read-only'].includes(scenario)) await fs.writeFile(path.join(directory, 'note.md'), '旧文件，不是本次写入')
      if (['source-output', 'negative-source'].includes(scenario)) await fs.writeFile(path.join(directory, '素材.md'), '不可覆盖的原素材')
      const prompt = scenario === 'build-artifact' ? '请通过命令把空项目打包为 build.zip。' : scenario === 'source-output' ? '请读取「素材.md」，把总结写入「结果.md」。' : scenario === 'negative-source' ? '不要改「素材.md」，只把总结保存为「结果.md」。' : scenario === 'tutorial' ? '解释如何保存 note.md，给一个示例文本，不要写盘。' : scenario === 'report-text' ? '请生成一份调查报告。' : ['wrong', 'wrong-report'].includes(scenario) ? '请创建 `wanted/note.md` 并写入结果。' : scenario === 'failed' ? '请创建 `blocked.md` 文件。' : '请创建 `note.md` 文件并实际写入结果。'
      const { result, events } = await run(directory, prompt)
      assert.ok(result, scenario)
      const turns = await database(directory, db => db.prepare("SELECT content,plan_state FROM turns WHERE run_id=? AND role='assistant' ORDER BY turn_seq").all(result.runId))
      const body = turns.map(turn => turn.content).join('')
      const translate = api.createChunkTranslator()
      const chunks = events.filter(event => event.type === 'event').flatMap(event => translate(event.data, result.runId))
      if (['waiting_user', 'cancelled'].includes(result.status)) {
        assert.ok(!chunks.some(chunk => chunk.type === 'done' && chunk.finishReason === 'stop'))
        const finalReplace = chunks.filter(chunk => chunk.type === 'text_replace').at(-1)
        assert.ok(finalReplace && !finalReplace.delta.includes('虚构完成'))
      }
      if (scenario === 'correct') {
        assert.equal(result.status, 'completed', JSON.stringify({ result, phase, body, calls: seen.map(request => request.messages.slice(-2)) })); assert.equal(phase, 3)
        assert.equal(await fs.readFile(path.join(directory, 'note.md'), 'utf8'), '实际文件内容')
        assert.ok(body.includes(path.join(directory, 'note.md'))); assert.ok(!body.includes('未执行的旧假话'))
        const projected = await database(directory, db => db.prepare("SELECT content FROM session_messages WHERE role='assistant' ORDER BY seq DESC LIMIT 1").get())
        assert.equal(projected.content, body)
        assert.ok(events.some(event => JSON.stringify(event).includes('content_replace')))
        assert.ok(seen[1].messages.some(message => message.role === 'system' && message.content.includes('文件交付尚未完成')))
      } else if (['tutorial', 'report-text'].includes(scenario)) { assert.equal(result.status, 'completed'); assert.equal(phase, 1) }
      else if (scenario === 'build-artifact') {
        assert.equal(result.status, 'completed'); assert.equal(phase, 2)
        assert.equal((await fs.readFile(path.join(directory, 'build.zip'))).subarray(0, 2).toString(), 'PK')
        assert.ok(!seen.some(request => request.messages.some(message => message.content?.includes('文件交付尚未完成'))))
      }
      else if (scenario === 'wrong-report') {
        assert.equal(result.status, 'completed'); assert.equal(phase, 3)
        assert.equal(await fs.readFile(path.join(directory, 'wanted/note.md'), 'utf8'), '实际文件内容')
        await assert.rejects(fs.access(path.join(directory, 'other/note.md')))
        assert.ok(!body.includes('虚构完成')); assert.ok(!body.includes('other/note.md'))
        assert.equal(await database(directory, db => db.prepare("SELECT COUNT(*) n FROM toolcalls WHERE run_id=? AND name='write_file'").get(result.runId).n), 1, 'a false path claim must not manufacture a new write obligation')
      }
      else if (['source-output', 'negative-source'].includes(scenario)) {
        assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(phase, 3)
        assert.equal(await fs.readFile(path.join(directory, '素材.md'), 'utf8'), '不可覆盖的原素材')
        assert.equal(await fs.readFile(path.join(directory, '结果.md'), 'utf8'), '实际文件内容')
        const record = await database(directory, db => JSON.parse(db.prepare('SELECT json FROM run_evidence WHERE run_id=? AND kind=?').get(result.runId, 'file_delivery_v1').json))
        assert.equal(record.targets.length, 1); assert.ok(record.targets[0].endsWith('结果.md'))
      }
      else if (scenario === 'cancel') { assert.equal(result.status, 'cancelled'); assert.ok(!body.includes('虚构完成')); await assert.rejects(fs.access(path.join(directory, 'note.md'))) }
      else {
        assert.equal(result.status, 'waiting_user', scenario); assert.equal(result.errorCode, 'file_delivery_unverified', scenario)
        assert.ok(phase <= 3, scenario + ' must not loop under unlimited budgets')
        assert.ok(!body.includes('虚构完成')); assert.ok(body.includes('文件尚未交付'))
        if (scenario === 'wrong') await assert.rejects(fs.access(path.join(directory, 'wanted/note.md')))
        if (scenario === 'stalled') {
          scenario = 'correct'; phase = 1
          const resumed = await run(directory, undefined, result.runId)
          assert.equal(resumed.result.status, 'completed')
          assert.equal(await fs.readFile(path.join(directory, 'note.md'), 'utf8'), '实际文件内容')
          const projected = await database(directory, db => db.prepare("SELECT content FROM session_messages WHERE role='assistant' ORDER BY seq DESC LIMIT 1").get())
          assert.ok(!projected.content.includes('文件尚未交付'), JSON.stringify({ projected, turns: await database(directory, db => db.prepare("SELECT role,content,plan_state FROM turns WHERE run_id=? ORDER BY turn_seq").all(result.runId)) })); assert.ok(!projected.content.includes('虚构完成'))
        }
      }
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(home, { recursive: true, force: true }) }
})
