'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { test } = require('node:test'), { build } = require('esbuild')
const root = path.resolve(__dirname, '..')
const evidenceDir = path.join(root, 'out/stable-prefix')

async function production(legacyMemoryBudget = false) {
  const bundled = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
    export {createCliRuntime} from './src/cli/runtime'; export {loadCliConfig} from './src/cli/config';
    export {createRepository} from './src/main/db/repository'; export {ContextV2Service} from './src/main/contextV2';
    export {estimateTokens} from './src/shared/types';
  ` }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { electron: path.join(root, 'src/cli/host.ts') }, write: false, logLevel: 'silent',
    plugins: legacyMemoryBudget ? [{ name: 'before-memory-budget', setup(builder) {
      // Reproduce the former production call contract: it supplied no stable
      // target, so the same selector sized memory from each shrinking request.
      builder.onLoad({ filter: /[\\/]src[\\/]main[\\/]contextService\.ts$/ }, async args => {
        const source = await fs.readFile(args.path, 'utf8')
        const changed = source.replace('ContextV2Service, selectContextCandidates, type ContextCandidate', 'ContextV2Service, selectContextCandidates as currentSelectContextCandidates, type ContextCandidate')
          .replace('const MEMORY_PREFIX_RE =', `const selectContextCandidates = (input: Parameters<typeof currentSelectContextCandidates>[0]) => {
            const { memoryBudgetTokens: _stableTarget, ...beforeInput } = input
            return currentSelectContextCandidates(beforeInput)
          }; const MEMORY_PREFIX_RE =`)
        assert.notEqual(changed, source)
        return { contents: changed, loader: 'ts', resolveDir: path.dirname(args.path) }
      })
    }}] : [] })
  const module = { exports: {} }; new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, module, module.exports)
  return module.exports
}

function common(a, b) {
  const left = Buffer.from(a, 'utf8'), right = Buffer.from(b, 'utf8')
  let bytes = 0; while (bytes < Math.min(left.length, right.length) && left[bytes] === right[bytes]) bytes++
  return { utf8Bytes: bytes, leftUtf8Bytes: left.length, rightUtf8Bytes: right.length }
}
function checkpoint(request) { return request.messages.find(message => message.content?.startsWith('## 会话历史原文摘录'))?.content ?? null }
function seed(repo, session, long, correction) {
  repo.createSession(session, 'Same visible title', 'stable-prefix-fixture')
  if (!long) return
  for (let seq = 1; seq <= 90; seq++) repo.appendSessionMessage({ msg_id: 'history-' + seq, session_id: session, seq, role: seq % 2 ? 'user' : 'assistant', status: 'done', created_at: seq,
    content: correction && seq === 61 ? '更正：标记改为蓝色，旧的红色约定已撤回；离线与只读要求保留。' : seq % 2 ? `约定${seq}：必须保留这项早期边界；` + '固定来源不可擅自改写。'.repeat(5) : `回复${seq}：` + '供长窗口压力测试的一般性历史说明。'.repeat(65) })
}

async function run(api, home, variant, { long = true, correction = false, prompt = 'Read both local notes and return the two observed notes.', session = 'frozen-session', changedPrefix = false } = {}) {
  const data = path.join(home, variant); await fs.mkdir(data)
  const repo = api.createRepository(path.join(data, 'deepwriter.sqlite')); repo.open(); seed(repo, session, long, correction)
  repo.createSession('other-session', 'Same visible title', 'stable-prefix-fixture')
  repo.appendSessionMessage({ msg_id: 'alien', session_id: 'other-session', seq: 1, role: 'user', content: 'ALIEN-SESSION-SENTINEL', status: 'done', created_at: 1 }); repo.close()
  const raw = [], errors = []; let initialFrozenContext
  const server = http.createServer((req, res) => { let text = ''; req.on('data', part => text += part); req.on('end', () => {
    try {
      const body = JSON.parse(text); raw.push(text)
      if (raw.length === 1) {
        const database = api.createRepository(path.join(data, 'deepwriter.sqlite')); database.open()
        const saved = database.listRecentRuns(1)[0]; initialFrozenContext = JSON.parse(saved.config_json).frozenContext
        database.appendSessionMessage({ msg_id: 'future-message', session_id: session, seq: 10000, role: 'user', content: 'FUTURE-SENTINEL', status: 'done', created_at: 10000 })
        database.close()
      }
      const n = raw.length
      const delta = n < 3 ? { content: 'Inspecting the requested note before composing the answer. '.repeat(5), tool_calls: [{ index: 0, id: 'read-' + n, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: n === 1 ? 'first.md' : 'second.md' }) } }] } : { content: 'Observed both notes without changing files.' }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: n < 3 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } }) + '\n\ndata: [DONE]\n\n')
    } catch (error) { errors.push(error); res.writeHead(500); res.end('fixture failed') }
  }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let runtime
  try {
    const options = { 'base-url': `http://127.0.0.1:${server.address().port}`, protocol: 'openai-chat', model: 'stable-prefix-fixture', loopback: true, context: '8192', 'max-tokens': '256', 'work-dir': home, 'doc-dir': home, 'no-web': true, 'tool-support': true, 'key-env': 'DW_STABLE_PREFIX_NO_KEY' }
    const { config } = await api.loadCliConfig(data, options)
    runtime = await api.createCliRuntime({ dataDir: data, config, secret: '', options, emit: () => {} })
    if (changedPrefix) await fs.writeFile(path.join(home, 'DEEPWRITER.md'), 'For this case use the changed, explicit project boundary.\n')
    await runtime.agent(prompt, session)
    assert.deepEqual(errors, []); assert.equal(raw.length, 3)
    const bodies = raw.map(text => JSON.parse(text))
    for (const body of bodies) {
      assert(!JSON.stringify(body.messages).includes('ALIEN-SESSION-SENTINEL'))
      assert(!JSON.stringify(body.messages).includes('FUTURE-SENTINEL'))
      const toolIds = body.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)
      for (const id of toolIds) assert(body.messages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === id)))
      assert.equal(body.max_tokens, 256)
      assert(api.estimateTokens(JSON.stringify(body)) + body.max_tokens <= 8192, 'the original model-input/output window still bounds every request')
    }
    const currentFrozenContext = JSON.parse(runtime.repo.listRecentRuns(1)[0].config_json).frozenContext
    assert.deepEqual(currentFrozenContext, initialFrozenContext, 'assembly cannot mutate the frozen summary, pins or history watermark')
    assert.equal(currentFrozenContext.historyHighWatermark, long ? 90 : 0)
    return { raw, bodies, frozenContext: currentFrozenContext, pairs: [common(raw[0], raw[1]), common(raw[1], raw[2])], checkpointLengths: bodies.map(body => checkpoint(body)?.length ?? 0), status: runtime.repo.listRecentRuns(1)[0].status }
  } finally { if (runtime) await runtime.close(); if (changedPrefix) await fs.rm(path.join(home, 'DEEPWRITER.md')); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}

function assertSourcePreservation(before, after) {
  for (let index = 0; index < 3; index++) {
    const isMemory = message => message.content?.startsWith('## 会话历史原文摘录')
    assert.deepEqual(after.bodies[index].messages.filter(message => !isMemory(message)), before.bodies[index].messages.filter(message => !isMemory(message)), 'no admitted history, instruction, live user or tool pair is traded for cache reuse')
    const sourceLines = text => text.split(/\r?\n/).filter(line => line.startsWith('{'))
    assert(sourceLines(checkpoint(before.bodies[index])).length > 0)
    for (const line of sourceLines(checkpoint(before.bodies[index]))) assert(sourceLines(checkpoint(after.bodies[index])).includes(line), 'baseline quotes must survive promotion')
  }
}

test('production-boundary three-turn Agent requests compare rolling checkpoint prefix before/after without paid traffic', { timeout: 30000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-stable-prefix-'))
  try {
    await fs.writeFile(path.join(home, 'first.md'), 'FIRST: bounded, read-only local observation.\n')
    await fs.writeFile(path.join(home, 'second.md'), 'SECOND: another bounded local observation.\n')
    await fs.mkdir(evidenceDir, { recursive: true })
    const baseline = await production(true), candidate = await production()
    const before = await run(baseline, home, 'before')
    const after = await run(candidate, home, 'after')
    assert.equal(before.status, 'completed'); assert.equal(after.status, 'completed')
    assert.equal(before.raw[0], after.raw[0], 'identical initial input, source selection and native limits')
    assert(before.checkpointLengths.some((length, i) => i && length !== before.checkpointLengths[i - 1]), 'baseline checkpoint really churns across tool turns')
    assert.equal(checkpoint(after.bodies[0]), checkpoint(after.bodies[1]))
    assert(after.pairs[0].utf8Bytes > before.pairs[0].utf8Bytes * 2)
    assertSourcePreservation(before, after)
    // A shorter quote can newly fit after a tool turn. Verify this independently
    // from the stable case: preserving the newly admitted correction wins.
    const correctionBefore = await run(baseline, home, 'correction-before', { correction: true })
    const correctionAfter = await run(candidate, home, 'correction-after', { correction: true })
    assertSourcePreservation(correctionBefore, correctionAfter)
    const correctionTurn = correctionBefore.bodies.findIndex((body, index) => index > 0 && checkpoint(body).includes('旧的红色约定已撤回') && !checkpoint(correctionBefore.bodies[index - 1]).includes('旧的红色约定已撤回'))
    assert(correctionTurn > 0, 'a real later request newly admits the shorter correction')
    assert.equal(correctionBefore.raw[correctionTurn], correctionAfter.raw[correctionTurn], 'fall back to the original projection rather than exclude the newly fitting quote')
    const shortBefore = await run(baseline, home, 'short-before', { long: false, session: 'short-session' })
    const shortAfter = await run(candidate, home, 'short-after', { long: false, session: 'short-session' })
    assert.deepEqual(shortBefore.raw, shortAfter.raw, 'ordinary fitting conversations remain byte-identical')
    const changed = await run(candidate, home, 'changed-prefix', { long: false, session: 'changed-session', changedPrefix: true, prompt: 'Read both local notes under the new project instructions.' })
    assert(changed.bodies[0].messages.some(message => message.role === 'system' && message.content.includes('changed, explicit project boundary')))
    assert.notEqual(changed.raw[0], shortAfter.raw[0], 'a real instruction/input change must not reuse stale content')
    console.log(JSON.stringify({ before: { pairs: before.pairs, checkpointLengths: before.checkpointLengths, status: before.status }, after: { pairs: after.pairs, checkpointLengths: after.checkpointLengths, status: after.status } }))
    await fs.writeFile(path.join(evidenceDir, 'requests-comparison.json'), JSON.stringify({ metric: 'common prefix of exact outbound HTTP JSON, measured in UTF-8 bytes; not provider token cache hits, latency or billing', baselineMethod: 'same production pipeline with only the new optional memory target omitted at the selector boundary; reproduces the pre-change per-request memory budget', before, after, correction: { before: correctionBefore, after: correctionAfter, fallbackTurn: correctionTurn + 1 }, short: { identical: true, before: shortBefore.raw, after: shortAfter.raw }, changedPrefix: changed.bodies[0], invariants: { admittedSourcesPreserved: true, priorQuotesPreserved: true, watermarkFrozen: true, futureAndOtherSessionExcluded: true, nativeOutputLimitUnchanged: true } }, null, 2))
  } finally { assert.equal(path.dirname(home), os.tmpdir()); assert(path.basename(home).startsWith('dw-stable-prefix-')); await fs.rm(home, { recursive: true, force: true }) }
})
