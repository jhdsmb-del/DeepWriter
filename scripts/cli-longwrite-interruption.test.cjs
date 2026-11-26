const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const {createHash} = require('node:crypto')
const syncFs = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const { test } = require('node:test')
const root = path.resolve(__dirname, '..')
const cp = text => Array.from(text).length
const first = '先确认你所在的位置，再看消息的范围。07:10发布的通知说，北站至江湾停运。这句话描述的是一个区间，不是整条线路，也没有说区间外各站的列车是否照常运行。你可以把通知上的站名与你原本的路线对照，但不要从“停运”两个字推出自己所有路段都走不了。\n\n车站屏幕可能还有别的提示。读到新提示时，先看发布时间，再看它是否针对同一个区间。一张没有时间的转发图片，不足以替代刚刚看到的车站通知。你不必抢着从人群里得出答案，先把手上能确认的几句话分开。还有一条边界要留住：目前没有恢复时间。没有公布，不等于很快恢复，也不等于全天停运。你可以据此调整眼前的安排，但不要替通知填上一个时刻。'
const second = '接下来比较你能实际选择的路。材料给出的接驳车间隔约15分钟，指的是相邻班次的大致间隔，不是你此刻还要等15分钟。你到站时已经过去多久、上车位置在哪里，这些都没有提供。先向现场工作人员确认候车点，再决定是否等下一班。\n\n如果要改走地面交通，就把步行到站、候车和换乘分别考虑。别把地图上的行驶时间直接当作到达时间，也别假定接驳车一定能一次坐上。你可以向等你的人说明已经确认的停运区间，以及自己正在核对替代路线；还没确认的部分，暂时留空。这样报出的不是一个好听的承诺，而是对方可以据此安排事情的信息。'
const partial = second.slice(0, 43)

async function scenario(permanent = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-cli-longwrite-interruption-'))
  const bundle = path.join(dir, 'deepwriter.cjs'), dataDir = path.join(dir, 'data'), output = path.join(dir, 'finished.md')
  const requests = [], scopes = [], headers = []
  let writers = 0, failure, collision
  const docs = path.join(dir, 'documents'); await fs.mkdir(docs)
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk }); request.on('end', () => {
      try {
        const body = JSON.parse(raw); requests.push(body); headers.push(request.headers)
        const system = body.messages.map(message => message.content).join('\n')
        let text
        if (system.includes('你是文章规划师')) {
          text = JSON.stringify({ title: '地铁停运后怎样决定路线', premise: '先说明可确认的信息，再说明转乘选择的边界。', sections: [
            { id: 'section-known', title: '读清通知', purpose: '区分停运区间与未知恢复时间，不编造数据。', beats: ['解释已知范围和信息边界。'], targetChars: cp(first), sourceSlotIds: ['original_task'] },
            { id: 'section-action', title: '比较路线', purpose: '解释接驳间隔与个人等待时间的区别，给出谨慎行动。', beats: ['比较实际路线，不承诺恢复时间。'], targetChars: cp(second), sourceSlotIds: ['original_task'] }
          ] })
        } else if (system.includes('你是文字审校员')) {
          const input = JSON.parse(body.messages.find(message => message.role === 'user').content), review = input.sectionReview
          text = JSON.stringify({ schemaVersion: 1, anchorMode: 'exact_quote', candidateHash: input.candidateHash, issues: [], ...(review ? {
            sectionCoverage: { sectionId: review.sectionId, outlineHash: review.outlineHash, candidateHash: input.candidateHash, prefixHash: review.prefixHash, status: 'covered', quote: input.candidate, reason: '本节原文已展开确认目的。' }
          } : {}) })
        } else {
          const scope = body.messages.find(message => message.content.startsWith('## 本轮正文节范围'))?.content
          assert(scope, 'native writer receives the actual confirmed section')
          writers++; scopes.push(scope)
          if (writers === 1) { assert(scope.includes('section-known')); text = first }
          else {
            assert(scope.includes('section-action'), 'accepted first section must never restart')
            if (writers === 2) {
              if (permanent) { response.writeHead(400, {'content-type':'application/json'}); response.end(JSON.stringify({error:{message:'synthetic invalid request'}})); return }
              response.writeHead(200, { 'content-type': 'text/event-stream' })
              response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: partial }, finish_reason: null }] }) + '\n\n')
              setTimeout(() => response.end(), 15); return // Real EOF without a provider terminal event.
            }
            assert.equal(writers, 3, 'explicit recovery adds exactly one writer request')
            assert(body.messages.some(message => message.content.includes(partial)), 'cold continuation receives the durable partial, not a fresh chapter')
            text = second.slice(partial.length)
            const writingRun = read(db => db.prepare('select run_id from runs').get().run_id)
            collision = path.join(docs, '地铁停运后怎样决定路线-' + createHash('sha256').update(writingRun).digest('hex').slice(0,12) + '.md')
            syncFs.writeFileSync(collision, '用户已有稿件，不可覆盖。', {flag:'wx'})
          }
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 } }) + '\n\ndata: [DONE]\n\n')
      } catch (error) { failure = error; response.writeHead(500); response.end('local fixture failed') }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const flags = ['--data-dir', dataDir, '--base-url', baseUrl, '--loopback', '--key-env', 'DW_LONGWRITE_SYNTHETIC_KEY', '--context', '65536', '--doc-dir', docs, '--token-budget', '2000000', '--json']
  const run = (args, key = 'synthetic-longwrite-key-A') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args, ...flags], { cwd: dir, env: { ...process.env, DEEPWRITER_API_KEY: '', DW_LONGWRITE_SYNTHETIC_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), 15000)
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); resolve({ code, stderr, stdout, events: stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line)) }) })
  })
  const stateOf = result => { if (failure) throw failure; assert.equal(result.code, 0, result.stderr); return result.events.find(event => event.type === 'state').data }
  const read = work => { const db = new DatabaseSync(path.join(dataDir, 'deepwriter.sqlite'), { readOnly: true }); try { return work(db) } finally { db.close() } }
  try {
    const build = spawn(process.execPath, ['src/cli/build.mjs', '--outfile=' + bundle], { cwd: root, stdio: 'ignore' })
    await new Promise((resolve, reject) => build.on('exit', code => code === 0 ? resolve() : reject(new Error('CLI build failed'))))
    let state = stateOf(await run(['write', '写一篇说明文章，给第一次遇到地铁停运的上班族。材料只有：07:10发布通知，北站至江湾停运，接驳车间隔约15分钟，没有恢复时间。用平静短句称呼“你”，先读清通知再比较路线，不新增事实。', '--target', String(cp(first + second))]))
    for (let index = 0; index < 20 && state.status !== 'outline_ready'; index++) {
      state = stateOf(await run(state.status === 'assumption_review' ? ['assumptions', state.sessionId, '--accept'] : ['answer', state.sessionId, '--question', state.currentQuestion.id, ...(state.currentQuestion.kind === 'final_check' ? ['--text', '没有了'] : ['--decision', 'decide'])]))
    }
    assert.equal(state.status, 'outline_ready')
    state = stateOf(await run(['outline', state.sessionId]))
    const interrupted = await run(['confirm', state.sessionId, '--hash', state.outlineHash])
    if (failure) throw failure
    const result = interrupted.events.find(event => event.type === 'result').data, runId = result.runId
    if (permanent) {
      assert.equal(result.status, 'failed', JSON.stringify(result)); assert.equal(interrupted.code, 1)
      const failedCalls = requests.length
      const saved = await run(['export', runId, '--draft'], '')
      assert.equal(saved.code, 0, saved.stderr); assert.equal(saved.events.find(event => event.type === 'export').data.content, first)
      assert.equal((await run(['resume', runId])).code, 1)
      assert.equal((await run(['export', runId])).code, 1)
      assert.equal(requests.length, failedCalls, 'a permanent 400 never acquires automatic or explicit generic replay')
      return
    }
    assert.equal(result.status, 'waiting_user', JSON.stringify(result))
    assert.equal(result.errorCode, 'longwrite_provider_interrupted')
    assert.equal(interrupted.code, 2)
    const before = read(db => ({ accepted: db.prepare("select segment_id,content_hash,content from manuscript_segments where run_id=? and status='accepted'").all(runId), config: db.prepare('select config_json from runs where run_id=?').get(runId).config_json, calls: db.prepare('select * from provider_call_attempts where run_id=? order by started_at,attempt_id').all(runId) }))
    assert.equal(before.accepted.map(segment => segment.content).join(''), first)
    assert.equal(read(db => db.prepare("select count(*) n from artifacts where run_id=? and artifact_type='manuscript'").get(runId).n), 0)
    const count = requests.length
    const draft = await run(['export', runId, '--draft'], '')
    assert.equal(draft.code, 0, draft.stderr); assert.equal(draft.events.find(event => event.type === 'export').data.content, first)
    assert.equal(draft.events.find(event => event.type === 'export').data.kind, 'draft')
    assert.equal((await run(['export', runId])).code, 1, 'a draft is never a final export')
    assert.equal(requests.length, count, 'reading a draft does not call Provider')
    assert.equal((await run(['resume', runId], 'synthetic-other-key')).code, 1); assert.equal(requests.length, count)
    const blockedDelivery = await run(['resume', runId, '--output', output])
    if (failure) throw failure
    assert.equal(blockedDelivery.code, 2, blockedDelivery.stderr)
    assert.equal(blockedDelivery.events.find(event => event.type === 'result').data.errorCode, 'longwrite_delivery_failed')
    assert.equal(await fs.readFile(collision, 'utf8'), '用户已有稿件，不可覆盖。')
    await assert.rejects(fs.stat(output), {code:'ENOENT'})
    const generatedCount = requests.length
    await fs.rename(collision, collision + '.user-backup')
    const recovered = await run(['resume', runId, '--output', output])
    assert.equal(requests.length, generatedCount, 'retrying publication sends no additional Provider request')
    if (failure) throw failure
    assert.equal(recovered.code, 0, recovered.stderr + '\n' + recovered.stdout.slice(-1800))
    assert.equal(recovered.events.find(event => event.type === 'result').data.status, 'completed')
    const expected = first + '\n\n' + second
    assert.equal(await fs.readFile(output, 'utf8'), expected)
    const finished = read(db => ({ accepted: db.prepare("select segment_id,content_hash,content from manuscript_segments where run_id=? and status='accepted'").all(runId), artifacts: db.prepare("select * from artifacts where run_id=? and artifact_type='manuscript'").all(runId), config: db.prepare('select config_json from runs where run_id=?').get(runId).config_json, calls: db.prepare('select * from provider_call_attempts where run_id=? order by started_at,attempt_id').all(runId) }))
    assert(finished.accepted.some(segment => segment.segment_id === before.accepted[0].segment_id && segment.content_hash === before.accepted[0].content_hash))
    assert.equal(finished.accepted.map(segment => segment.content).join(''), first + second)
    assert.equal(finished.config, before.config); assert.deepEqual(finished.calls.slice(0, before.calls.length), before.calls)
    assert.equal(finished.artifacts.length, 1); assert.equal(await fs.readFile(finished.artifacts[0].relative_path, 'utf8'), expected)
    const finalCount = requests.length, exported = await run(['export', runId], '')
    assert.equal(exported.events.find(event => event.type === 'export').data.content, expected)
    assert.equal((await run(['resume', runId])).code, 1); assert.equal(requests.length, finalCount)
    assert(headers.every(header => header.authorization === 'Bearer synthetic-longwrite-key-A'))
    console.log(`LONGWRITE_RECOVERY accepted=${cp(first + second)} file=${cp(expected)} chars; sections=2; writer HTTP=${writers}; original accepted IDs retained; one manuscript artifact`)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }) }
}

test('real CLI confirmed manuscript survives writer EOF and file collision, exports accepted draft and cold-resumes to exact delivered Markdown', () => scenario())
test('real CLI preserves permanent Provider rejection as failed; accepted chapters remain explicitly recoverable as a draft without replay', () => scenario(true))
