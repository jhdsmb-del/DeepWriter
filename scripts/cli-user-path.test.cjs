const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { before, after, test } = require('node:test')
const root = path.resolve(__dirname, '..')
let suiteDir, bundle, server, baseUrl
let goalTurn = 0; let goalPaths; let goalSchemaErrors; let mode = 'normal'; let requests = []; let requestHeaders = []; let requestPaths = []; let scaleChunk = 0; let toolPath
const textHash = (text) => createHash('sha256').update(text).digest('hex')
const unique = (n, offset = 0) => Array.from({ length: n }, (_, index) => String.fromCodePoint(0x4e00 + offset + index)).join('')
const events = (stdout) => stdout.split(/\r?\n/).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
function launch(args, options = {}) {
  const child = spawn(process.execPath, [bundle, ...args], { cwd: options.cwd ?? root, env: { ...process.env, DEEPWRITER_API_KEY: 'synthetic-cli-key-A', ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  // For a deliberate multi-turn run, distinguish a silent child from one still emitting tool events.
  let timedOut = ''
  const stop = (reason) => { timedOut = reason; child.kill() }
  const timer = setTimeout(() => stop(options.longTask ? 'no CLI progress for 15s' : 'CLI fixture exceeded 15s'), 15000)
  const deadline = options.longTask ? setTimeout(() => stop('multi-turn fixture exceeded 60s'), 60000) : null
  child.stdout.on('data', (data) => { stdout += data; if (options.longTask) timer.refresh() })
  child.stderr.on('data', (data) => { stderr += data })
  child.stdin.end(options.stdin ?? '')
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => { clearTimeout(timer); clearTimeout(deadline); resolve({ code, signal, stdout, stderr: timedOut ? stderr + '\n' + timedOut : stderr, events: events(stdout) }) }) })
  return { child, done, stdout: () => stdout }
}
const run = (args, options) => launch(args, options).done
before(async () => {
  suiteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepwriter-cli-user-'))
  bundle = path.join(suiteDir, 'deepwriter.cjs')
  const build = spawn(process.execPath, ['src/cli/build.mjs', `--outfile=${bundle}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; build.stderr.on('data', (data) => { log += data })
  await new Promise((resolve, reject) => { build.on('error', reject); build.on('exit', (code) => code === 0 ? resolve() : reject(new Error(log))) })
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk }); req.on('end', () => {
      const request = JSON.parse(body); requests.push(request); requestHeaders.push(req.headers); requestPaths.push(req.url)
      const prompt = [request.system ?? '', ...request.messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))].join('\n')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let output
      if (prompt.includes('你是文章规划师')) {
        const match = prompt.match(/必须覆盖的来源 id：([^\n]+)/u)
        const source = JSON.parse(match[1]); const target = Number(prompt.match(/目标字数：(\d+)/u)[1])
        output = JSON.stringify({ title: '灯塔夜色', premise: '点亮灯塔后沿海景物在一夜之间形成具体可见的变化，清晨自然收束。', sections: [{ id: 's1', title: '灯塔夜景', purpose: '点亮灯塔并在灯塔的空间内描述具体景物变化与清晨收束。', beats: mode === 'opaque-review' ? ['产生一个可验证的现场变化'] : ['灯塔亮起'], targetChars: target, sourceSlotIds: source }] })
      } else {
        let review = null
        try { review = JSON.parse([...request.messages].reverse().find((message) => message.role === 'user').content) } catch {}
        if (review?.candidateHash && request.messages.some((message) => message.role === 'system' && message.content.includes('你是文字审校员'))) {
          const scene = review.sceneBeatReview
          const quote = '灯塔亮起'
          const satisfied = review.candidate.includes(quote)
          output = JSON.stringify({ schemaVersion: 1, candidateHash: review.candidateHash, issues: [], ...(scene ? {
            sceneBeatEvidence: { semanticVersion: 2, contractHash: scene.contractHash, candidateHash: review.candidateHash, scenePrefixHash: scene.scenePrefixHash,
              beats: scene.requiredBeats.map(beat => ({ beatId: beat.beatId, status: satisfied ? 'satisfied' : 'missing',
                partEvidence: beat.parts.map(part => ({ partId: part.partId, status: satisfied ? 'satisfied' : 'missing', spanIndexes: satisfied ? [0] : [] })),
                ...(satisfied ? { quote, quoteSource: 'candidate', semanticEvents: [{ spanIndex: 0, partIds: beat.parts.map(part => part.partId),
                  predicate: '亮起', agent: ['灯塔'], patient: [], agentBindings: [{ name: '灯塔', relation: 'explicit', mention: { spanIndex: 0, text: '灯塔' } }],
                  actuality: 'asserted_actual', assertion: 'asserted', negation: false }] } : {})
              })) }
          } : {}) })
        }
        else if (mode === 'goal-notice') {
          const writeText = '渡口更正：末班船在22:03离岸。'
          const sourceText = '值班记录：22:03，末班船离岸。'
          const evidence = (reference, quote, reason) => ({ kind: 'tool', reference, quote, reason })
          const check = (satisfied, ev) => ({ action: 'review', progress: satisfied ? '核对交付' : '继续补齐通知', originalObjectiveReview: '原要求有实物通知，且值班簿不得被改写。', originalSatisfied: satisfied, checks: [{ id: 'notice', satisfied, reason: '逐份对照交付和原件', evidence: ev }] })
          const script = [
            ['update_goal', { action: 'define', progress: '先明确文件交付', outcomes: [{ id:'notice', description:'生成通知.md，原值班记录不改', check:'读回通知.md和原值班簿，检查离岸时间', verification:'tool' }] }],
            '通知已经写好了。', // Intentionally false. No file and no tool evidence.
            ['update_goal', check(true, [evidence('invented-receipt', writeText, '声称已核对')])],
            ['update_goal', check(false, [])],
            ['read_file', { path: goalPaths.source }, 'source'],
            ['write_file', { path: goalPaths.notice, content: writeText }, 'write'],
            ['read_file', { path: goalPaths.notice }, 'notice-read'],
            ['read_file', { path: goalPaths.source }, 'original-read'],
            '已保存通知.md，通知记载22:03离岸。原值班簿保留原文。',
            ['update_goal', check(true, [evidence('notice-read', writeText, '新文件中有实际离岸时间'), evidence('original-read', sourceText, '原始值班记录不变')])]
          ]
          const action = script[goalTurn++]
          if (!action) { res.end('data: [DONE]\n\n'); return }
          if (typeof action === 'string') output = action
          else {
            const [name, args, id] = action
            if (!request.tools?.some(tool => tool.function?.name === name)) goalSchemaErrors.push(name + '@' + goalTurn)
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: id || 'goal-' + goalTurn, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + '\n\n')
            res.end('data: [DONE]\n\n'); return
          }
        }
        else if (mode === 'empty') output = ''
        else if (mode === 'slow') {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `灯塔${unique(90)}` }, finish_reason: null }] })}\n\n`)
          const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 20000)
          res.on('close', () => clearTimeout(timer)); return
        } else if (mode === 'edit-manuscript') {
          if (request.messages.some(m => m.role === 'tool')) output = '改稿结束。'
          else {
            const args = { path: '河岸.md', old_text: '小曲', new_text: '小禾$&', replace_all: true }
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'edit-manuscript', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + '\n\n')
            res.end('data: [DONE]\n\n'); return
          }
        } else if (mode === 'unlimited-tool-loop') {
          const numbers = request.messages.flatMap(message => message.tool_calls ?? []).map(call => /^loop-(\d+)$/.exec(call.id)).filter(Boolean).map(match => Number(match[1]))
          const count = numbers.length ? Math.max(...numbers) + 1 : 0
          if (count >= 20) output = '已按二十份工具结果完成任务。'
          else {
            assert.ok(request.tools?.some(tool => tool.function.name === 'read_file'))
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'loop-' + count, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: toolPath }) } }] }, finish_reason: 'tool_calls' }] }) + '\n\n')
            res.end('data: [DONE]\n\n'); return
          }
        } else if (mode === 'find-passage') {
          const outputs = request.messages.filter(m => m.role === 'tool')
          if (outputs.length === 2) output = '纸条写的是“从东门走”。'
          else {
            let name = 'search_files', args = { path: '稿件', pattern: '铜钥匙交给她' }
            if (outputs.length === 1) {
              const text = JSON.parse(outputs[0].content).message
              const match = /([^\r\n:]+\.md):(\d+):/.exec(text)
              assert.ok(match, text)
              name = 'read_file'; args = { path: match[1], start_line: Number(match[2]) - 1, line_count: 3 }
            }
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'passage-' + outputs.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + '\n\n')
            res.end('data: [DONE]\n\n'); return
          }
        } else if (mode === 'tool-read' || mode === 'tool-deny' || mode === 'tool-web-deny') {
          const name = mode === 'tool-web-deny' ? 'read_web_page' : mode === 'tool-read' ? 'read_file' : 'write_file'
          // A provider must see the real production declarations before our
          // synthetic response is allowed to request the tool.
          if (mode !== 'tool-web-deny') assert.ok(request.tools?.some((tool) => tool.function.name === name), `${name} schema not sent`)
          if (request.messages.some((message) => message.role === 'tool')) output = '灯塔工具请求已处理。'
          else {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool-boundary', type: 'function', function: { name, arguments: JSON.stringify({ ...(name === 'read_web_page' ? { url: baseUrl + '/must-not-fetch' } : { path: toolPath }), ...(name === 'write_file' ? { content: '不应写入' } : {}) }) } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
            res.end('data: [DONE]\n\n'); return
          }
        } else if (mode === 'scale') {
          const prefix = '灯塔亮起。灯塔夜景。'; const fill = 1000 - Array.from(prefix).length - 5
          const start = scaleChunk++ * 1000
          output = prefix + Array.from({ length: 5 }, (_, index) => unique(Math.floor(fill / 5) + (index < fill % 5 ? 1 : 0), start + index * 200) + '。').join('')
          assert.equal(Array.from(output).length, 1000)
        } else output = `灯塔亮起。灯塔夜景。${unique(189)}。${unique(199, 220)}。${unique(199, 450)}。${unique(199, 680)}。`
      }
      if (mode === 'anthropic') {
        for (const [event, data] of [
          ['message_start', { type: 'message_start', message: { id: 'msg-local', usage: { input_tokens: 10, output_tokens: 0 } } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: output } }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }],
          ['message_stop', { type: 'message_stop' }]
        ]) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        res.end(); return
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (suiteDir && process.env.DEEPWRITER_CLI_KEEP_FIXTURE === '1') process.stdout.write(`# fixture retained: ${suiteDir}\n`)
  else if (suiteDir) { assert.equal(path.dirname(suiteDir), os.tmpdir()); assert.ok(path.basename(suiteDir).startsWith('deepwriter-cli-user-')); await fs.rm(suiteDir, { recursive: true, force: true }) }
})
function flags(dataDir) { return ['--data-dir', dataDir, '--base-url', baseUrl, '--loopback', '--key-env', 'DEEPWRITER_API_KEY', '--max-tokens', '4096', '--token-budget', '2000000', '--json'] }
async function confirmedOutline(dataDir, target, extra = []) {
  const assignment = mode === 'opaque-review' ? '写一篇小说，描写灯塔夜景，只输出小说正文，不引入人物。' : '写灯塔夜景，只输出正文，不引入人物。'
  let reply = await run(['write', assignment, '--target', String(target), ...flags(dataDir), ...extra])
  let state = reply.events.find((event) => event.type === 'state').data
  for (let turn = 0; turn < 16 && state.status !== 'outline_ready'; turn++) {
    const args = state.status === 'assumption_review' ? ['assumptions', state.sessionId, '--accept'] : ['answer', state.sessionId, '--question', state.currentQuestion.id, '--text', state.currentQuestion.kind === 'final_check' ? '没有了' : '灯塔夜景，克制具体，只写灯塔内外景物，清晨自然收束。']
    reply = await run([...args, ...flags(dataDir), ...extra]); assert.equal(reply.code, 0, reply.stderr)
    state = reply.events.find((event) => event.type === 'state').data
  }
  assert.equal(state.status, 'outline_ready')
  reply = await run(['outline', state.sessionId, ...flags(dataDir), ...extra]); assert.equal(reply.code, 0, reply.stderr)
  return reply.events.find((event) => event.type === 'state').data
}
test('真正Node bundle无需Electron/node_modules，help/version同package且配置不保存密钥', async () => {
  const help = await run(['--help']); assert.equal(help.code, 0); assert.match(help.stdout, /DeepWriter CLI/)
  const version = await run(['--version']); const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(version.stdout.trim(), pkg.version)
  const dataDir = path.join(suiteDir, 'config')
  const set = await run(['config', 'set', ...flags(dataDir)])
  assert.equal(set.code, 0); assert.ok(!set.stdout.includes('synthetic-cli-key-A'))
  const raw = await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'); assert.ok(!raw.includes('synthetic-cli-key-A')); assert.ok(!raw.includes('apiKey'))
})
test('共享原子chat、流式输出、durable用量与终态拒绝重放', async () => {
  mode = 'normal'; const dataDir = path.join(suiteDir, 'chat')
  const reply = await run(['chat', '灯塔故事', ...flags(dataDir)])
  assert.equal(reply.code, 0, reply.stderr)
  assert.ok(reply.events.some((event) => event.type === 'delta' && event.data.provisional))
  const result = reply.events.find((event) => event.type === 'result').data
  assert.equal(result.status, 'completed')
  const usage = await run(['usage', result.runId, ...flags(dataDir)])
  assert.equal(usage.code, 0); assert.equal(usage.events[0].data.amount, null); assert.equal(usage.events[0].data.amountStatus, 'unknown')
  assert.equal(usage.events[0].data.tokens.inputTokens, 10)
  const count = requests.length
  assert.equal((await run(['resume', result.runId, ...flags(dataDir)])).code, 1); assert.equal(requests.length, count)
  const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
  assert.equal(db.prepare('select count(*) n from runs').get().n, 1)
  assert.equal(db.prepare('select count(*) n from session_messages').get().n, 2)
  assert.equal(db.prepare('select count(*) n from provider_call_attempts').get().n, 1)
  const snapshot = db.prepare('select config_json from runs').get().config_json
  assert.ok(!snapshot.includes('synthetic-cli-key-A')); db.close()
})
test('非TTY采访可跨进程回答；拒绝过期问题/伪确认；确认后真实正文文件与accepted hash一致', async () => {
  mode = 'normal'; const dataDir = path.join(suiteDir, 'longwrite')
  let reply = await run(['write', '写一篇灯塔夜景故事，只输出正文。', '--target', '800', ...flags(dataDir)])
  let state = reply.events.find((event) => event.type === 'state').data
  const session = state.sessionId
  const before = requests.length
  assert.equal((await run(['confirm', session, '--hash', 'fake', ...flags(dataDir)])).code, 1)
  assert.equal((await run(['answer', session, '--question', 'stale', '--text', '答案', ...flags(dataDir)])).code, 1)
  assert.equal(requests.length, before)
  for (let turn = 0; turn < 16 && state.status !== 'outline_ready'; turn++) {
    if (state.status === 'assumption_review') reply = await run(['assumptions', session, '--accept', ...flags(dataDir)])
    else {
      assert.ok(state.currentQuestion, JSON.stringify(state))
      const answer = state.currentQuestion.kind === 'final_check' ? '没有了' : '只描写灯塔景物与夜色，克制具体，不新增人物或事实。'
      reply = await run(['answer', session, '--question', state.currentQuestion.id, '--text', answer, ...flags(dataDir)])
    }
    assert.equal(reply.code, 0, reply.stderr); state = reply.events.find((event) => event.type === 'state').data
  }
  assert.equal(state.status, 'outline_ready')
  reply = await run(['outline', session, ...flags(dataDir)]); assert.equal(reply.code, 0, reply.stderr)
  state = reply.events.find((event) => event.type === 'state').data
  assert.equal(state.status, 'awaiting_outline_confirmation')
  reply = await run(['confirm', session, '--hash', state.outlineHash, ...flags(dataDir)])
  const diagnostics = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
  const evidence = diagnostics.prepare("select kind,json from run_evidence where kind in ('scene_contract_latest','narrative_quality_latest','strong_constraint_latest')").all().map((row) => { const value = JSON.parse(row.json); return { kind: row.kind, status: value.status, violations: value.violations, beatEvidence: value.beatEvidence } })
  diagnostics.close()
  assert.equal(reply.code, 0, reply.stderr + JSON.stringify({ result: reply.events.find((event) => event.type === 'result')?.data, evidence }))
  const result = reply.events.find((event) => event.type === 'result').data
  assert.equal(result.status, 'completed'); assert.equal(result.artifacts.length, 1)
  const file = await fs.readFile(result.artifacts[0].relative_path, 'utf8')
  assert.ok(Array.from(file).length >= 800); assert.equal(textHash(file), result.artifacts[0].hash)
  const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
  const accepted = db.prepare("select content from manuscript_segments where run_id=? and status='accepted' order by chunk_index,revision,created_at").all(result.runId).map((row) => row.content).join('')
  assert.equal(file, accepted)
  const count = requests.length
  const exported = await run(['export', result.runId, ...flags(dataDir)], { env: { DEEPWRITER_API_KEY: '' } })
  assert.equal(exported.code, 0, exported.stderr); assert.equal(exported.events[0].data.content, accepted); assert.equal(requests.length, count)
  assert.equal(JSON.parse(db.prepare('select config_json from runs where run_id=?').get(result.runId).config_json).grillMe.outlineHash, state.outlineHash)
  db.close()
})
test('跨终端pause保存流式分片，原冻结model恢复；更换密钥0调用，cancel保留终态', async () => {
  mode = 'slow'; const dataDir = path.join(suiteDir, 'pause')
  const outputFile = path.join(suiteDir, 'paused-not-final.md')
  const live = launch(['chat', '灯塔慢写', '--output', outputFile, ...flags(dataDir)])
  let runId
  for (let retry = 0; retry < 100; retry++) {
    const event = events(live.stdout()).find((item) => item.type === 'delta')
    if (event) { runId = event.data.runId; break }
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  assert.ok(runId)
  assert.equal((await run(['pause', runId, ...flags(dataDir)])).code, 0)
  const paused = await live.done; assert.equal(paused.code, 2, paused.stderr)
  const pausedResult = paused.events.find((event) => event.type === 'result').data
  assert.equal(pausedResult.usage.calls, 1); assert.equal(pausedResult.usage.input_tokens, null); assert.equal(pausedResult.usage.output_tokens, null)
  const count = requests.length
  await assert.rejects(fs.access(outputFile))
  const notFinal = await run(['export', runId, ...flags(dataDir)])
  assert.equal(notFinal.code, 1); assert.match(notFinal.events[0].data.message, /仅可导出 completed/)
  assert.equal(requests.length, count)
  const changed = await run(['resume', runId, ...flags(dataDir)], { env: { DEEPWRITER_API_KEY: 'synthetic-cli-key-B' } })
  assert.equal(changed.code, 1); assert.equal(requests.length, count)
  mode = 'normal'
  const resumed = await run(['resume', runId, '--model', 'new-model-must-not-be-used', '--no-web', ...flags(dataDir)])
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.equal(requests.at(-1).model, 'deepseek-flash')
  assert.equal(requests.at(-1).tools, undefined, 'an unsupported local provider cannot acquire paid web services on resume')
  mode = 'slow'
  const cancellable = launch(['chat', '取消灯塔', ...flags(dataDir)])
  let cancelId
  for (let retry = 0; retry < 100; retry++) {
    const event = events(cancellable.stdout()).find((item) => item.type === 'delta')
    if (event) { cancelId = event.data.runId; break }
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  assert.ok(cancelId)
  assert.equal((await run(['cancel', cancelId, ...flags(dataDir)])).code, 0)
  const cancelled = await cancellable.done; assert.equal(cancelled.code, 1)
  assert.equal(cancelled.events.find((item) => item.type === 'result').data.status, 'cancelled')
})
test('合成4k/8k/20k自动连写真实SQLite及文件；显式冻结足够调用预算，非质量验收', async () => {
  const evidence = []
  for (const target of [4000, 8000, 20000]) {
    mode = 'scale'; scaleChunk = 0
    const dataDir = path.join(suiteDir, `scale-${target}`)
    const extra = ['--no-review', '--max-calls', '64']
    const state = await confirmedOutline(dataDir, target, extra)
    const before = requests.length
    const reply = await run(['confirm', state.sessionId, '--hash', state.outlineHash, ...flags(dataDir), ...extra])
    const result = reply.events.find((event) => event.type === 'result')?.data
    assert.equal(reply.code, 0, JSON.stringify(result)); assert.equal(result.status, 'completed')
    assert.equal(result.artifacts.length, 1)
    const content = await fs.readFile(result.artifacts[0].relative_path, 'utf8')
    assert.equal(Array.from(content).length, target); assert.equal(textHash(content), result.artifacts[0].hash)
    const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
    const cfg = JSON.parse(db.prepare('select config_json from runs where run_id=?').get(result.runId).config_json)
    assert.equal(cfg.providerCallBudget.maxCalls, 64); assert.equal(cfg.providerCallBudget.maxTokens, 2000000)
    assert.equal(cfg.strongConstraints.enabled, false)
    const accepted = db.prepare("select content from manuscript_segments where run_id=? and status='accepted' and kind='prose' order by chunk_index,revision,created_at").all(result.runId).map((row) => row.content).join('')
    assert.equal(content, accepted); db.close()
    evidence.push({ target, chars: Array.from(content).length, bodyRequests: requests.length - before, sha256: textHash(content) })
  }
  process.stdout.write(`# synthetic-control-flow ${JSON.stringify(evidence)}\n`)
})
test('不足调用预算合法暂停，已接受正文不丢、不假completed/文件，resume不重置授权', async () => {
  mode = 'scale'; scaleChunk = 0
  const dataDir = path.join(suiteDir, 'scale-budget-stop'); const extra = ['--no-review', '--max-calls', '2']
  const state = await confirmedOutline(dataDir, 4000, extra)
  const before = requests.length
  const reply = await run(['confirm', state.sessionId, '--hash', state.outlineHash, ...flags(dataDir), ...extra])
  const result = reply.events.find((event) => event.type === 'result').data
  assert.equal(reply.code, 2); assert.equal(result.status, 'waiting_user'); assert.match(result.errorCode, /run_provider_call_cap/)
  assert.equal(result.artifacts.length, 0); assert.equal(requests.length - before, 2)
  const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
  const accepted = () => db.prepare("select content from manuscript_segments where run_id=? and status='accepted' and kind='prose' order by chunk_index,revision,created_at").all(result.runId).map((row) => row.content).join('')
  const saved = accepted(); assert.equal(Array.from(saved).length, 2000)
  const count = requests.length
  const resumed = await run(['resume', result.runId, ...flags(dataDir)])
  assert.equal(resumed.code, 1); assert.match(resumed.stderr, /--max-calls unlimited/); assert.equal(requests.length, count); assert.equal(accepted(), saved)
  assert.equal(JSON.parse(db.prepare('select config_json from runs where run_id=?').get(result.runId).config_json).providerCallBudget.maxCalls, 2)
  db.close()
})

test('独立CLI review共享真实restore：原provider栅栏合法审批0新增HTTP/真实文件；漂移拒绝不claim', async () => {
  mode = 'opaque-review'
  for (const drift of [false, true]) {
    const dataDir = path.join(suiteDir, drift ? 'review-fence-drift' : 'review-fence-restore')
    const extra = ['--no-review']; const state = await confirmedOutline(dataDir, 800, extra)
    const reply = await run(['confirm', state.sessionId, '--hash', state.outlineHash, ...flags(dataDir), ...extra])
    assert.equal(reply.code, 2, reply.stderr)
    const result = reply.events.find(event => event.type === 'result').data
    assert.equal(result.errorCode, 'narrative_state_pending_review'); assert.equal(result.status, 'waiting_user')
    const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'))
    try {
      const packet = JSON.parse(db.prepare("select json from run_evidence where run_id=? and kind='narrative_semantic_review'").get(result.runId).json)
      const kind = 'narrative_review_story_fence:' + packet.packetHash
      const original = db.prepare('select json from run_evidence where run_id=? and kind=?').get(result.runId, kind).json
      const count = requests.length
      if (drift) {
        const modified = JSON.parse(original); modified.candidateHash = '0'.repeat(64)
        db.prepare('update run_evidence set json=? where run_id=? and kind=?').run(JSON.stringify(modified), result.runId, kind)
      }
      const reviewed = await run(['review', result.runId, '--decision', 'accept_prose_no_state', '--revision', String(packet.revision), ...flags(dataDir)])
      assert.equal(requests.length, count)
      if (drift) {
        assert.equal(reviewed.code, 1); assert.match(reviewed.stderr, /narrative_review_story_fence_corrupt/)
        assert.equal(db.prepare("select count(*) n from run_evidence where run_id=? and kind like 'narrative_semantic_review:claim:%'").get(result.runId).n, 0)
        assert.equal(db.prepare("select count(*) n from manuscript_segments where run_id=? and status='accepted' and kind='prose'").get(result.runId).n, 0)
      } else {
        assert.equal(reviewed.code, 0, reviewed.stderr); assert.equal(reviewed.events.find(event => event.type === 'review').data.runStatus, 'completed')
        assert.equal(db.prepare('select json from run_evidence where run_id=? and kind=?').get(result.runId, kind).json, original)
        const artifact = db.prepare("select relative_path,hash from artifacts where run_id=? and artifact_type='manuscript'").get(result.runId)
        assert.ok(artifact); const content = await fs.readFile(artifact.relative_path, 'utf8'); assert.equal(Array.from(content).length, 800); assert.equal(textHash(content), artifact.hash)
      }
    } finally { db.close() }
  }
  mode = 'normal'
})
test('默认人类输出stdout仅正文与未知金额stderr；不要求费用确认但公共Provider仍需独立密钥', async () => {
  mode = 'normal'
  const dataDir = path.join(suiteDir, 'human-output')
  const reply = await run(['chat', '灯塔', ...flags(dataDir).filter((value) => value !== '--json')])
  assert.equal(reply.code, 0); assert.match(reply.stdout, /^灯塔亮起/); assert.ok(!reply.stdout.includes('"type"')); assert.match(reply.stderr, /金额未知/); assert.match(reply.stderr, /tokens/)
  const count = requests.length
  const denied = await run(['chat', '不应请求', '--data-dir', path.join(suiteDir, 'public-denied'), '--json'], { env: { DEEPWRITER_API_KEY: '' } })
  assert.equal(denied.code, 1); assert.match(denied.stderr, /提供密钥/); assert.ok(!denied.stderr.includes('accept-unknown-cost')); assert.equal(requests.length, count)
})

test('常规Base URL在真实本机HTTP路由中生效且费用保持未知', async () => {
  mode = 'normal'
  for (const endpoint of [`${baseUrl}/v1`, `${baseUrl}/v1/chat/completions`]) {
    const reply = await run(['chat', '灯塔', ...flags(path.join(suiteDir, `url-${requests.length}`)), '--protocol', 'openai-chat', '--base-url', endpoint])
    assert.equal(reply.code, 0, reply.stderr)
    assert.equal(requestPaths.at(-1), '/v1/chat/completions')
    const result = reply.events.find(event => event.type === 'result').data
    assert.equal(result.amount, null); assert.equal(result.amountStatus, 'unknown')
  }
})
test('CLI原生思考max进入真实HTTP，未知能力/超界预算0请求，保存模型不被默认值覆盖', async () => {
  mode = 'normal'; const dataDir = path.join(suiteDir, 'thinking')
  const reply = await run(['chat', '灯塔', ...flags(dataDir), '--thinking', '--effort', 'max'])
  assert.equal(reply.code, 0, reply.stderr); assert.equal(requests.at(-1).thinking.type, 'enabled'); assert.equal(requests.at(-1).reasoning_effort, 'max'); assert.equal(requests.at(-1).model, 'deepseek-flash')
  const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
  const cfg = JSON.parse(db.prepare('select config_json from runs').get().config_json)
  assert.equal(cfg.thinking.enabled, true); assert.equal(cfg.thinking.effort, 'max'); db.close()
  const count = requests.length
  for (const invalid of [['--protocol', 'openai-chat', '--thinking'], ['--model', 'unknown-model', '--thinking'], ['--effort', 'unknown', '--thinking'], ['--max-calls', '9007199254740992'], ['--token-budget', '9007199254740992']]) {
    assert.equal((await run(['chat', '不得调用', ...flags(dataDir), ...invalid])).code, 1)
    assert.equal(requests.length, count)
  }
  assert.equal((await run(['config', 'set', ...flags(dataDir), '--model', 'saved-user-model'])).code, 0)
  const shown = await run(['config', 'show', '--data-dir', dataDir, '--json'])
  assert.equal(shown.events[0].data.model, 'saved-user-model')
})

test('CLI下一次真实HTTP low/high/max与兼容别名共用唯一规范值；resume保持旧run思考身份', async () => {
  mode = 'normal'
  for (const [selected, expected] of [['low', 'low'], ['high', 'high'], ['max', 'max'], ['minimal', 'low'], ['medium', 'high'], ['xhigh', 'high'], ['ultra', 'max']]) {
    const dataDir = path.join(suiteDir, 'effort-' + selected); const before = requests.length
    const reply = await run(['chat', '灯塔', ...flags(dataDir), '--thinking', '--effort', selected])
    assert.equal(reply.code, 0, reply.stderr); assert.equal(requests.length, before + 1)
    assert.deepEqual(requests.at(-1).thinking, { type: 'enabled' }); assert.equal(requests.at(-1).reasoning_effort, expected)
    const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
    const config = JSON.parse(db.prepare('select config_json from runs').get().config_json); db.close()
    assert.equal(config.thinking.effort, expected); assert.equal(config.cliProvider.config.effort, expected)
  }
  mode = 'slow'
  const dataDir = path.join(suiteDir, 'effort-resume'); const live = launch(['chat', '持续灯塔稿件', ...flags(dataDir), '--thinking', '--effort', 'max'])
  for (let i = 0; i < 150 && !live.stdout().includes('灯塔'); i++) await new Promise(resolve => setTimeout(resolve, 20))
  const runId = events(live.stdout()).find(event => event.type === 'run').data.runId
  await run(['pause', runId, ...flags(dataDir)]); assert.equal((await live.done).code, 2)
  const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
  const original = db.prepare('select config_json from runs where run_id=?').get(runId).config_json
  mode = 'normal'; const before = requests.length
  const resumed = await run(['resume', runId, ...flags(dataDir), '--thinking', '--effort', 'low'])
  assert.equal(resumed.code, 0, resumed.stderr); assert.equal(requests.length, before + 1); assert.equal(requests.at(-1).reasoning_effort, 'max')
  assert.equal(db.prepare('select config_json from runs where run_id=?').get(runId).config_json, original); db.close()
})
test('坏显式JSON包含合成密钥时不泄露源片段，且0 HTTP', async () => {
  const file = path.join(suiteDir, 'malformed.json'); const sensitive = 'synthetic-key-must-not-leak-BAD-JSON'
  await fs.writeFile(file, `{ "apiKey": "${sensitive}", broken...`)
  const count = requests.length
  const reply = await run(['chat', '不得调用', '--config', file, '--data-dir', path.join(suiteDir, 'bad-config'), '--json'])
  assert.equal(reply.code, 1); assert.ok(!reply.stdout.includes(sensitive)); assert.ok(!reply.stderr.includes(sensitive)); assert.match(reply.stderr, /配置 JSON 无效/); assert.equal(requests.length, count)
})
test('--tools真实发送schema并执行范围内read；非TTY未授权write不改变用户文件', async () => {
  const workDir = path.join(suiteDir, 'tools-work'); await fs.mkdir(workDir)
  toolPath = path.join(workDir, 'source.txt'); await fs.writeFile(toolPath, '灯塔工具实际读取证据。')
  mode = 'tool-read'
  const dataDir = path.join(suiteDir, 'tools-read'); const before = requests.length
  const read = await run(['chat', '读取灯塔素材', ...flags(dataDir), '--tools', '--work-dir', workDir])
  assert.equal(read.code, 0, read.stderr)
  const calls = requests.slice(before); assert.ok(calls[0].tools.some((tool) => tool.function.name === 'read_file'))
  assert.ok(calls[1].messages.some((message) => message.role === 'tool' && message.content.includes('灯塔工具实际读取证据')))
  toolPath = path.join(suiteDir, 'protected.txt'); await fs.writeFile(toolPath, '用户已有文件，不得改动。')
  mode = 'tool-deny'; const denyData = path.join(suiteDir, 'tools-deny'); const deniedBefore = requests.length
  const denied = await run(['chat', '尝试修改外部文件', ...flags(denyData), '--tools', '--work-dir', workDir])
  assert.equal(denied.code, 0, denied.stderr) // Chat completion is not tool success.
  assert.equal(await fs.readFile(toolPath, 'utf8'), '用户已有文件，不得改动。')
  assert.ok(requests[deniedBefore].tools.some((tool) => tool.function.name === 'write_file'))
  const denyDb = new DatabaseSync(path.join(denyData, 'deepwriter.sqlite'), { readOnly: true })
  try {
    const tool = denyDb.prepare("select status,result_json from toolcalls where name='write_file'").get()
    assert.ok(tool)
    const receipt = JSON.parse(JSON.parse(tool.result_json).content)
    assert.equal(receipt.ok, false)
    assert.match(receipt.message, /需要交互授权.*未获批准/)
    assert.doesNotMatch(receipt.message, /用户(?:已)?拒绝/)
  } finally { denyDb.close() }
})
test('CLI专用auth-header真实raw api-key，无Bearer；不安全头/秘密extraHeaders及改头resume0fetch', async () => {
  mode = 'normal'; const dataDir = path.join(suiteDir, 'auth-header')
  const extra = ['--protocol', 'openai-chat', '--auth-header', 'api-key']
  const reply = await run(['chat', '灯塔', ...flags(dataDir), ...extra])
  assert.equal(reply.code, 0, reply.stderr); assert.equal(requestHeaders.at(-1)['api-key'], 'synthetic-cli-key-A'); assert.equal(requestHeaders.at(-1).authorization, undefined)
  assert.ok(!reply.stdout.includes('synthetic-cli-key-A')); assert.ok(!reply.stderr.includes('synthetic-cli-key-A'))
  const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true }); const cfg = JSON.parse(db.prepare('select config_json from runs').get().config_json); db.close()
  assert.equal(cfg.cliProvider.config.authHeaderName, 'api-key'); assert.ok(!JSON.stringify(cfg).includes('synthetic-cli-key-A'))
  let count = requests.length
  for (const name of ['Host', 'Cookie', 'Content-Length', 'proxy-authorization', 'anthropic-version', 'api-key\r\nInjected:yes']) {
    const invalid = await run(['chat', '不应发送', ...flags(dataDir), '--protocol', 'openai-chat', '--auth-header', name])
    assert.equal(invalid.code, 1); assert.equal(requests.length, count)
  }
  const secretExtra = path.join(suiteDir, 'secret-headers.json'); await fs.writeFile(secretExtra, JSON.stringify({ baseUrl, loopback: true, protocol: 'openai-chat', extraHeaders: { 'x-secret-token': 'synthetic-header-secret' } }))
  const invalid = await run(['chat', '不应发送', ...flags(dataDir), '--config', secretExtra]); assert.equal(invalid.code, 1); assert.ok(!invalid.stderr.includes('synthetic-header-secret')); assert.equal(requests.length, count)
  mode = 'slow'
  const live = launch(['chat', '持续稿件', ...flags(dataDir), ...extra])
  for (let i = 0; i < 150 && !live.stdout().includes('灯塔'); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  const runId = events(live.stdout()).find((event) => event.type === 'run').data.runId
  await run(['pause', runId, ...flags(dataDir), ...extra]); assert.equal((await live.done).code, 2)
  count = requests.length
  const changed = await run(['resume', runId, ...flags(dataDir), '--protocol', 'openai-chat', '--auth-header', 'x-api-key'])
  assert.equal(changed.code, 1); assert.match(changed.stderr, /认证Header与原冻结配置不一致/); assert.equal(requests.length, count)
  mode = 'normal'
  const restored = await run(['resume', runId, ...flags(dataDir), ...extra]); assert.equal(restored.code, 0, restored.stderr); assert.equal(requestHeaders.at(-1)['api-key'], 'synthetic-cli-key-A'); assert.equal(requestHeaders.at(-1).authorization, undefined)
})
test('CLI真实Anthropic chat/outline：x-api-key及受控版本头，不落extraHeaders不重复请求', async () => {
  mode = 'anthropic'; const dataDir = path.join(suiteDir, 'anthropic')
  const extra = ['--protocol', 'anthropic-messages', '--chat-path', '/v1/messages', '--model', 'fixture-claude']
  const count = requests.length
  const chat = await run(['chat', '灯塔', ...flags(dataDir), ...extra]); assert.equal(chat.code, 0, chat.stderr)
  assert.equal(requests.length, count + 1)
  assert.equal(requestHeaders.at(-1)['x-api-key'], 'synthetic-cli-key-A'); assert.equal(requestHeaders.at(-1)['anthropic-version'], '2023-06-01'); assert.equal(requestHeaders.at(-1).authorization, undefined); assert.equal(requestPaths.at(-1), '/v1/messages')
  const state = await confirmedOutline(path.join(suiteDir, 'anthropic-outline'), 800, extra)
  assert.equal(state.status, 'awaiting_outline_confirmation')
  assert.equal(requests.length, count + 2)
  assert.equal(requestHeaders.at(-1)['x-api-key'], 'synthetic-cli-key-A'); assert.equal(requestHeaders.at(-1)['anthropic-version'], '2023-06-01'); assert.equal(requestPaths.at(-1), '/v1/messages')
})


test('UTF-8文件/管道任务与最终正文可组合；export不需密钥也不重放模型', async () => {
  mode = 'normal'
  const dataDir = path.join(suiteDir, 'text-io')
  const source = path.join(suiteDir, '任务 有空格.md')
  const prompt = '请润色这两段，保留换行。\n\n灯塔和潮声。🌊'
  await fs.writeFile(source, prompt)
  const plainFlags = flags(dataDir).filter(value => value !== '--json')
  const stdout = await run(['chat', '--input', source, '--output', '-', ...plainFlags], { cwd: suiteDir })
  assert.equal(stdout.code, 0, stdout.stderr)
  assert.equal(requests.at(-1).messages.filter(message => message.role === 'user').at(-1).content, prompt)
  const rows = await run(['list', ...flags(dataDir)])
  const runId = rows.events[0].data.runs[0].runId
  const count = requests.length
  const exported = await run(['export', runId, ...flags(dataDir)], { env: { DEEPWRITER_API_KEY: '' }, cwd: suiteDir })
  assert.equal(exported.code, 0, exported.stderr)
  const result = exported.events[0]
  assert.equal(result.type, 'export')
  assert.equal(result.data.path, null)
  assert.equal(result.data.content, stdout.stdout)
  assert.equal(result.data.bytes, Buffer.byteLength(stdout.stdout))
  assert.equal(requests.length, count)
  const target = path.join(suiteDir, '最终稿 有空格.md')
  const file = await run(['export', runId, '--output', target, ...flags(dataDir)], { env: { DEEPWRITER_API_KEY: '' } })
  assert.equal(file.code, 0, file.stderr)
  assert.equal(await fs.readFile(target, 'utf8'), stdout.stdout)
  assert.equal(file.events[0].data.path, await fs.realpath(target))
  const refused = await run(['chat', '不应调用', '--output', target, ...flags(dataDir)])
  assert.equal(refused.code, 1)
  assert.equal(refused.events[0].type, 'error')
  assert.match(refused.events[0].data.message, /拒绝覆盖/)
  assert.equal(await fs.readFile(target, 'utf8'), stdout.stdout)
  assert.equal(requests.length, count)
  const chatFile = path.join(suiteDir, 'chat-final.md')
  const chat = await run(['chat', '-', '--output', chatFile, ...plainFlags], { stdin: '仅测试管道输入。🌊' })
  assert.equal(chat.code, 0, chat.stderr)
  assert.equal(chat.stdout, '')
  assert.equal(await fs.readFile(chatFile, 'utf8'), stdout.stdout)
  assert.equal(requests.at(-1).messages.filter(message => message.role === 'user').at(-1).content, '仅测试管道输入。🌊')
})

test('write和answer可从stdin/文件读取；无自动假设或大纲授权', async () => {
  const count = requests.length
  const dataDir = path.join(suiteDir, 'interview-stdin')
  const text = '灯塔夜景。\n\n只写景物，不引入人物。'
  const written = await run(['write', '-', '--target', '800', ...flags(dataDir)], { stdin: text })
  assert.equal(written.code, 0, written.stderr)
  const state = written.events.find(event => event.type === 'state').data
  assert.equal(state.originalTask, text)
  assert.equal(state.status, 'interviewing')
  const answer = await run(['answer', state.sessionId, '--question', state.currentQuestion.id, '--text', '-', ...flags(dataDir)], { stdin: '灯塔的夜景，潮声，清晨收束。' })
  assert.equal(answer.code, 0, answer.stderr)
  assert.notEqual(answer.events.find(event => event.type === 'state').data.currentQuestion?.id, state.currentQuestion.id)
  assert.equal(requests.length, count)
})

test('空/二进制输入、冲突来源与未知选项返回JSON错误，0模型调用', async () => {
  const count = requests.length
  const dataDir = path.join(suiteDir, 'invalid-text-io')
  for (const [args, stdin, pattern] of [
    [['chat', '-'], '', /不能为空/],
    [['chat'], Buffer.from([0xe4, 0xb8]), /UTF-8/],
    [['chat', '-'], Buffer.from([0x61, 0, 0x62]), /NUL/],
    [['chat', '任务', '--input', 'missing'], '', /不能与/],
    [['--unknown'], '', /未知选项/]
  ]) {
    const reply = await run([...args, ...flags(dataDir)], { stdin })
    assert.equal(reply.code, 1, reply.stderr)
    assert.equal(reply.events.length, 1)
    assert.equal(reply.events[0].type, 'error')
    assert.equal(reply.events[0].data.code, 'cli_error')
    assert.match(reply.events[0].data.message, pattern)
  }
  assert.equal(requests.length, count)
})


test('不支持账户联网的本地chat无联网工具；agent显式加入有范围的本地工具；--no-web拒绝伪造联网调用', async () => {
  mode = 'normal'
  let before = requests.length
  const dataDir = path.join(suiteDir, 'agent-default-web')
  const chat = await run(['chat', '普通任务', ...flags(dataDir)])
  assert.equal(chat.code, 0, chat.stderr)
  assert.equal(requests[before].tools, undefined)
  mode = 'tool-read'
  toolPath = path.join(suiteDir, 'agent-source.md')
  await fs.writeFile(toolPath, '范围内实际稿件。')
  before = requests.length
  const agent = await run(['agent', '读取范围内稿件', '--no-web', '--work-dir', suiteDir, ...flags(path.join(suiteDir, 'agent-local'))])
  assert.equal(agent.code, 0, agent.stderr)
  assert.deepEqual(requests[before].tools.map(tool => tool.function.name).sort(), ['read_file', 'list_files', 'search_files', 'find_files', 'read_files', 'write_file', 'edit_file', 'run_command', 'update_work_plan', 'search_conversation'].sort())
  assert.ok(requests.slice(before).at(-1).messages.some(message => message.role === 'tool' && String(message.content).includes('范围内实际稿件')))
  mode = 'tool-deny'
  const deniedWrite = await run(['agent', '写入须明确授权', '--no-web', '--work-dir', suiteDir, ...flags(path.join(suiteDir, 'agent-no-grant'))])
  assert.equal(deniedWrite.code, 0, deniedWrite.stderr)
  assert.equal(await fs.readFile(toolPath, 'utf8'), '范围内实际稿件。', 'agent must not auto-authorize writes in a pipe')
  mode = 'tool-web-deny'
  before = requests.length
  const noWebDir = path.join(suiteDir, 'no-web')
  const denied = await run(['chat', '不得联网', '--no-web', ...flags(noWebDir)])
  assert.equal(denied.code, 0, denied.stderr)
  assert.equal(requests[before].tools, undefined)
  assert.ok(requests.slice(before).at(-1).messages.some(message => message.role === 'tool' && String(message.content).includes('tool_not_allowed_by_mode')))
  const db = new DatabaseSync(path.join(noWebDir, 'deepwriter.sqlite'), { readOnly: true })
  const cfg = JSON.parse(db.prepare('select config_json from runs').get().config_json)
  assert.deepEqual(cfg.toolPolicy.allowList, [])
  assert.equal(cfg.cliProvider.tools, false)
  db.close()
})

test('声明不支持工具时不发送schema且不执行伪造工具，普通对话和agent均明确保持文本', async () => {
  mode = 'normal'
  const dataDir = path.join(suiteDir, 'unsupported-tools')
  const set = await run(['config', 'set', '--no-tool-support', ...flags(dataDir)])
  assert.equal(set.code, 0, set.stderr)
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'))).supportsTools, false)
  for (const command of ['chat', 'agent']) {
    const before = requests.length
    const result = await run([command, '纯文本任务', ...flags(dataDir)])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(requests[before].tools, undefined)
    assert.ok(result.events.some(event => event.type === 'notice' && event.data.message.includes('不支持工具')))
  }
  mode = 'tool-web-deny'
  const before = requests.length
  const forged = await run(['agent', '伪造工具不得执行', ...flags(dataDir)])
  assert.equal(forged.code, 0, forged.stderr)
  assert.equal(requests[before].tools, undefined)
  assert.ok(requests.slice(before).at(-1).messages.some(message => message.role === 'tool' && String(message.content).includes('tool_not_allowed_by_mode')))
  mode = 'normal'
  await run(['config', 'set', '--tool-support', ...flags(dataDir)])
  const enabled = requests.length
  assert.equal((await run(['chat', '重新声明支持工具', ...flags(dataDir)])).code, 0)
  assert.equal(requests[enabled].tools, undefined, 'declaring model tools support is not provider web-service authorization')
})


test('无联网权限的旧暂停快照在新版默认联网恢复时仍无schema、无新增权限', async () => {
  mode = 'slow'
  const dataDir = path.join(suiteDir, 'resume-no-web')
  const live = launch(['chat', '旧任务不得联网', '--no-web', ...flags(dataDir)])
  let runId
  for (let retry = 0; retry < 100; retry++) {
    const event = events(live.stdout()).find(event => event.type === 'delta')
    if (event) { runId = event.data.runId; break }
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  assert.ok(runId)
  assert.equal((await run(['pause', runId, ...flags(dataDir)])).code, 0)
  assert.equal((await live.done).code, 2)
  mode = 'normal'
  const before = requests.length
  const resumed = await run(['resume', runId, ...flags(dataDir)])
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.equal(requests[before].tools, undefined)
  const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
  assert.deepEqual(JSON.parse(db.prepare('select config_json from runs').get().config_json).toolPolicy.allowList, [])
  db.close()
})

test('Agent 真正把搜索命中附近三行送给模型，而非整份长稿', async () => {
  const work = path.join(suiteDir, 'passage')
  await fs.mkdir(path.join(work, '稿件'), { recursive: true })
  const lines = Array.from({ length: 1200 }, (_, i) => '无关史料'.repeat(10) + (i + 1))
  lines.splice(919, 3, '邮戳是昨天的。', '铜钥匙交给她。', '纸条只有四个字：从东门走。')
  await fs.writeFile(path.join(work, '稿件', '渡口.md'), lines.join('\r\n'))
  mode = 'find-passage'
  const start = requests.length
  const result = await run(['agent', '铜钥匙交给她时，纸条上写了什么？', '--no-web', '--work-dir', work, ...flags(path.join(suiteDir, 'find-passage-data'))])
  assert.equal(result.code, 0, result.stderr)
  const turns = requests.slice(start)
  assert.equal(turns.length, 3)
  const schema = turns[0].tools.find(tool => tool.function.name === 'read_file').function.parameters.properties
  assert.ok(schema.start_line && schema.line_count && schema.cursor)
  const msg = JSON.parse(turns[2].messages.filter(m => m.role === 'tool').at(-1).content).message
  assert.equal(msg.slice(msg.indexOf('\n') + 1), lines.slice(919, 922).join('\r\n') + '\r\n')
  assert.doesNotMatch(JSON.stringify(turns), /无关史料/)
  assert.match(result.stdout, /从东门走/)
  // Receipts describe what the completed task actually read, not the file as it exists now.
  const runId = result.events.find(e => e.type === 'result').data.runId
  const directory = path.join(suiteDir, 'find-passage-data'), countBefore = requests.length
  await fs.writeFile(path.join(work, '稿件', '渡口.md'), '新稿里没有旧纸条。')
  const receipts = await run(['sources', runId, '--data-dir', directory, '--json'], { env: { DEEPWRITER_API_KEY: '' } })
  assert.equal(receipts.code, 0, receipts.stderr)
  const sourcePage = receipts.events.find(e => e.type === 'sources').data
  assert.equal(sourcePage.runId, runId); assert.equal(sourcePage.nextOffset, null)
  assert.ok(sourcePage.entries.some(e => e.kind === 'read' && e.path.endsWith('渡口.md') && e.locator && e.excerpt.includes('从东门走')))
  assert.ok(sourcePage.entries.every(e => e.runId === runId && e.toolCallId && !e.excerpt.includes('新稿里没有')))
  const shown = await run(['sources', runId, '--data-dir', directory])
  assert.equal(shown.code, 0, shown.stderr); assert.match(shown.stdout, /渡口\.md/); assert.match(shown.stdout, /从东门走/)
  const missing = await run(['sources', 'no-such-run', '--data-dir', directory])
  assert.equal(missing.code, 1); assert.match(missing.stderr, /运行不存在/)
  assert.equal(requests.length, countBefore)
})

test('实际工具批量改稿后，另一进程 changes 按存档回看而非读取当前稿件', async () => {
  const work = path.join(suiteDir, 'changes-work'), data = path.join(suiteDir, 'changes-data')
  await fs.mkdir(work)
  const file = path.join(work, '河岸.md')
  await fs.writeFile(file, '小曲过桥。\r\n水向东流。\r\n小曲回头。')
  mode = 'edit-manuscript'; const start = requests.length
  // The established chat --tools path edits this disposable workspace locally.
  const task = await run(['chat', '把小曲全部改名', '--tools', '--no-web', '--work-dir', work, ...flags(data)])
  assert.equal(task.code, 0, task.stderr)
  assert.equal(await fs.readFile(file, 'utf8'), '小禾$&过桥。\r\n水向东流。\r\n小禾$&回头。')
  const receipt = JSON.parse(requests.at(-1).messages.findLast(m => m.role === 'tool').content)
  assert.deepEqual(receipt.edit, { count: 2, lines: [1, 3] })
  assert.ok(requests[start].tools.find(t => t.function.name === 'edit_file').function.parameters.properties.replace_all)
  const runId = task.events.find(e => e.type === 'result').data.runId, network = requests.length
  await fs.writeFile(file, '作者次日另写的新稿')
  const args = ['changes', runId, '--data-dir', data]
  const result = await run([...args, '--json'], { env: { DEEPWRITER_API_KEY: '' } })
  assert.equal(result.code, 0, result.stderr)
  const entries = result.events.find(e => e.type === 'changes').data.changes
  assert.equal(entries.length, 1)
  assert.equal(entries[0].file, '河岸.md'); assert.equal(entries[0].before, '小曲'); assert.equal(entries[0].after, '小禾$&')
  const human = await run(args, { env: { DEEPWRITER_API_KEY: '' } })
  assert.equal(human.code, 0, human.stderr)
  assert.match(human.stdout, /原稿第 1、3 行/); assert.ok(human.stdout.includes('小禾$&')); assert.equal(requests.length, network)
  const deniedData = path.join(suiteDir, 'changes-denied')
  const denied = await run(['agent', '改名', '--no-web', '--work-dir', work, ...flags(deniedData)])
  const deniedId = denied.events.find(e => e.type === 'result').data.runId
  const none = await run(['changes', deniedId, '--data-dir', deniedData, '--json'])
  assert.equal(none.code, 0); assert.deepEqual(none.events.find(e => e.type === 'changes').data.changes, [])
  assert.equal(await fs.readFile(file, 'utf8'), '作者次日另写的新稿')
})

test('作者约定按目录生效，采访、大纲与确认正文沿用同一稿，新对话使用新修订', async () => {
  const book = path.join(suiteDir, 'book-brief'), other = path.join(suiteDir, 'other-book'), data = path.join(suiteDir, 'book-data')
  await fs.mkdir(book); await fs.mkdir(other)
  const old = '铜铃只有三道刻痕。', next = '新稿把铜铃改为四道刻痕。'
  const input = path.join(suiteDir, 'author-brief.txt')
  await fs.writeFile(input, old)
  const base = ['--work-dir', book, '--data-dir', data, '--json']
  const n = requests.length
  const init = await run(['brief', 'init', '--input', input, ...base]); assert.equal(init.code, 0, init.stderr)
  const repeat = await run(['brief', 'init', ...base]); assert.notEqual(repeat.code, 0)
  assert.equal((await run(['brief', 'show', ...base])).events[0].data.text, old)
  assert.equal(requests.length, n)
  mode = 'normal'
  const extra = ['--work-dir', book]
  const state = await confirmedOutline(data, 800, extra)
  assert.equal(state.projectBrief, old)
  const includes = (req, s) => req.messages.some(m => typeof m.content === 'string' && m.content.includes(s))
  assert.ok(requests.slice(n).some(req => includes(req, '你是文章规划师') && includes(req, old)))
  await fs.writeFile(path.join(book, 'DEEPWRITER.md'), next)
  const firstBody = requests.length
  const writing = await run(['confirm', state.sessionId, '--hash', state.outlineHash, ...flags(data), ...extra])
  assert.equal(writing.code, 0, writing.stderr)
  assert.ok(requests.slice(firstBody).some(req => includes(req, old))); assert.ok(requests.slice(firstBody).every(req => !includes(req, next)))
  const fresh = requests.length
  await run(['agent','约定里怎么写的？','--no-web', ...flags(data), ...extra])
  assert.ok(includes(requests[fresh], next))
  const otherStart = requests.length
  await run(['chat', '另一个项目', '--no-web', ...flags(data), '--work-dir', other])
  assert.ok(!includes(requests[otherStart], next) && !includes(requests[otherStart], old))
})


test('CLI default unlimited actual local Provider crosses sixteen; explicit sixteen persists until task-only resume authorization', async () => {
  mode = 'unlimited-tool-loop'
  const workDir = path.join(suiteDir, 'unlimited-work'); await fs.mkdir(workDir)
  toolPath = path.join(workDir, 'source.txt'); await fs.writeFile(toolPath, '本地合成来源。')
  for (const finite of [false, true]) {
    const dataDir = path.join(suiteDir, finite ? 'explicit-sixteen' : 'default-unlimited')
    const start = requests.length
    const reply = await run(['agent', '按二十份逐次工具结果完成任务', '--work-dir', workDir, ...flags(dataDir), ...(finite ? ['--max-calls', '16'] : [])], { longTask: true })
    assert.equal(reply.code, finite ? 2 : 0, reply.stderr)
    const result = reply.events.find(event => event.type === 'result').data
    assert.equal(result.status, finite ? 'waiting_user' : 'completed')
    assert.equal(requests.length - start, finite ? 16 : 21)
    let db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
    const original = JSON.parse(db.prepare('select config_json from runs where run_id=?').get(result.runId).config_json)
    const billsBefore = db.prepare('select * from provider_call_attempts where run_id=? order by started_at,attempt_id').all(result.runId)
    assert.equal(original.providerCallBudget.maxCalls, finite ? 16 : null)
    db.close()
    if (!finite) continue
    const stoppedCount = requests.length
    const blocked = await run(['resume', result.runId, ...flags(dataDir)])
    assert.equal(blocked.code, 1); assert.match(blocked.stderr, /--max-calls unlimited/)
    assert.equal(requests.length, stoppedCount)
    const wrongKey = await run(['resume', result.runId, '--max-calls', 'unlimited', ...flags(dataDir)], { env: {DEEPWRITER_API_KEY: 'synthetic-other-key'} })
    assert.equal(wrongKey.code, 1); assert.equal(requests.length, stoppedCount)
    const continued = await run(['resume', result.runId, '--max-calls', 'unlimited', '--model', 'do-not-switch-frozen-model', ...flags(dataDir)])
    assert.equal(continued.code, 0, continued.stderr)
    assert.equal(continued.events.find(event => event.type === 'result').data.status, 'completed')
    assert.equal(requests.length - start, 21)
    assert(requests.slice(start).every(request => request.model === 'deepseek-flash'))
    db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true })
    const amended = JSON.parse(db.prepare('select config_json from runs where run_id=?').get(result.runId).config_json)
    assert.equal(amended.providerCallBudget.maxCalls, null)
    assert.deepEqual(amended.cliProvider, original.cliProvider)
    assert.equal(amended.providerCallBudget.maxTokens, original.providerCallBudget.maxTokens)
    const billsAfter = db.prepare('select * from provider_call_attempts where run_id=? order by started_at,attempt_id').all(result.runId)
    assert.equal(billsAfter.length, 21); assert.deepEqual(billsAfter.slice(0, billsBefore.length), billsBefore)
    const tools = db.prepare('select tool_call_id from toolcalls where run_id=?').all(result.runId)
    assert.equal(tools.length, 20); assert.equal(new Set(tools.map(row => row.tool_call_id)).size, 20)
    db.close()
    const completeCount = requests.length
    assert.equal((await run(['resume', result.runId, '--max-calls', 'unlimited', ...flags(dataDir)])).code, 1)
    assert.equal(requests.length, completeCount)
  }
})

test('Goal CLI refuses false completion, autonomously delivers the file, and does not carry consent to another task', async () => {
  mode = 'goal-notice'; goalTurn = 0; goalSchemaErrors = []
  const work = path.join(suiteDir, 'goal-project'), data = path.join(suiteDir, 'goal-data')
  await fs.mkdir(work)
  goalPaths = { source: path.join(work, '值班簿.md'), notice: path.join(work, '通知.md') }
  const original = '值班记录：22:03，末班船离岸。'
  await fs.writeFile(goalPaths.source, original)
  const args = ['--work-dir', work, '--no-web', ...flags(data)]
  const reply = await run(['agent','--goal','--no-questions','据值班簿撰写通知，存成通知.md，不改原件。','--max-calls','14',...args], {longTask:true})
  const result = reply.events.find(x => x.type === 'result')?.data
  assert.equal(reply.code, 0, JSON.stringify([reply.stderr, result, reply.events.slice(-8)]))
  assert.equal(result.goal.mode, 'autonomous'); assert.equal(result.goal.status, 'completed')
  assert.deepEqual(goalSchemaErrors, []); assert.equal(goalTurn, 10)
  const delivered = reply.events.find(e=>e.type==='goal_answer').data.content
  assert.ok(delivered.startsWith('已保存通知.md，通知记载22:03离岸。原值班簿保留原文。'))
  const paths = [...delivered.matchAll(/^`([^`\r\n]+)`$/gm)].map(match=>match[1])
  assert.equal(paths.length, 1, delivered)
  assert.ok(path.isAbsolute(paths[0]), delivered)
  // Windows 8.3 and macOS /var are valid user-facing spellings for the same file.
  assert.equal(await fs.realpath(paths[0]), await fs.realpath(goalPaths.notice))
  assert.deepEqual(result.goal.outcomes[0].evidence.map(e=>e.reference), ['notice-read','original-read'])
  const db = new DatabaseSync(path.join(data, 'deepwriter.sqlite'), { readOnly:true })
  try {
    const persisted = db.prepare('select content from session_messages where msg_id=?').get('m_'+result.runId+'_assistant')
    assert.equal(persisted.content, reply.events.find(e=>e.type==='goal_answer').data.content)
    assert.ok(!persisted.content.includes('通知已经写好了。'), '不得把验收退回的候选拼进最终会话')
  } finally { db.close() }
  assert.equal(await fs.readFile(goalPaths.source,'utf8'), original)
  assert.equal(await fs.readFile(goalPaths.notice,'utf8'), '渡口更正：末班船在22:03离岸。')
  const state = await run(['status', result.runId, '--data-dir', data, '--json'])
  assert.equal(state.events[0].data.goal.revision, result.goal.revision)
  mode = 'tool-deny'; toolPath = path.join(work,'下一条普通任务.md')
  const normal = await run(['agent','在目录内新建文件', '--session',result.sessionId,...args])
  assert.equal(normal.code,0,normal.stderr); assert.ok(!normal.events.find(x=>x.type==='result').data.goal)
  assert.ok(!requests.at(-1).tools.some(tool=>tool.function.name==='update_goal'))
  await assert.rejects(fs.access(toolPath), {code:'ENOENT'})
  const before = requests.length
  const bad = await run(['chat','--no-questions','普通对话',...args])
  assert.notEqual(bad.code,0); assert.equal(requests.length,before)
})
