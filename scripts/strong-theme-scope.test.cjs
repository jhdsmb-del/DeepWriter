const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
const originalTask = JSON.parse(readFileSync(path.join(root, 'scripts/eval-tasks/tasks.json'), 'utf8')).tasks.find((task) => task.id === 'failure-recovery').stages[0].template
before(async () => {
  const built = await esbuild.build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    export {buildStrongConstraintSnapshot,evaluateStrongConstraints} from './src/main/strongConstraints';
    export {buildExecutionSnapshot} from './src/main/executionSnapshot';
    export {createRepository} from './src/main/db/repository';
    export {createRunStorePort,createModelCallAdapter} from './src/main/runKernelAdapter';
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {publishCliManuscript} from './src/cli/manuscript';
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: {}, logLevel: 'silent', plugins: [{ name: 'actual-theme-scope-source', setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (!args.path.startsWith('.') && args.path !== 'electron') return { path: args.path, external: true }
      const target = args.path === 'electron' ? path.join(root, 'src/cli/host.ts') : path.resolve(args.resolveDir, args.path)
      const source = ['', '.ts', '.js', '/index.ts'].map((suffix) => target + suffix).find(existsSync)
      if (!source || !source.startsWith(root + path.sep)) throw new Error('Source outside workspace')
      return { path: source, namespace: 'source' }
    })
    build.onLoad({ filter: /.*/, namespace: 'source' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }))
  } }] })
  const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports); api = loaded.exports
})
const strong = (task, visible = {}) => api.buildStrongConstraintSnapshot({ runMode: 'longwrite', phase: 'execute', task, story: null, settings: { strongConstraintEnabled: true, strongConstraintLevel: 'balanced', themeLockMode: 'strong' }, visible })
const evaluate = (snapshot, text) => api.evaluateStrongConstraints(snapshot, text, text, { atTarget: true, requireThemeInSegment: true })
test('真实failure-recovery任务的【前文】对白和禁复读残句不成为正向主题', () => {
  const snapshot = strong(originalTask)
  assert.equal(snapshot.enabled, true); assert.equal(snapshot.themeLockMode, 'strong')
  assert.deepEqual(snapshot.themeAnchors, [])
  assert.equal(evaluate(snapshot, '老周。他把马灯放在开关旁，林默转过身，看清了旧机房深处的影子。').ok, true)
  const minimal = strong('不要重述或复制前文的结尾（“是——”之后），直接从断裂处继续。')
  assert.deepEqual(minimal.themeAnchors, [])
  const reference = strong('从断裂处（「是——」之后）续写这段话，保持人物与语感一致，不重述前文结尾。')
  assert.deepEqual(reference.themeAnchors, [])
})
test('混合正向灯塔与否定旧句仍锁灯塔，跑偏拒绝；quoted正向主题可核验', () => {
  const snapshot = strong('围绕“灯塔”写作，别重复旧句“是——”，不要写关于“城堡”的例子。')
  assert.ok(snapshot.themeAnchors.includes('灯塔'))
  assert.ok(!snapshot.themeAnchors.some((anchor) => anchor.includes('是——') || anchor.includes('城堡')))
  assert.equal(evaluate(snapshot, '灯塔的光穿过雾层，她关上生锈的门。').ok, true)
  assert.ok(evaluate(snapshot, '城堡里的人谈起新的宴会。').violations.some((item) => item.code === 'topic_anchor_missing'))
  assert.ok(strong('围绕“回声”写一个故事。').themeAnchors.includes('回声'))
})
test('主题只从冻结正向sourceTask抽取；显式mustKeep/avoid硬约束不降级', () => {
  const snapshot = strong('围绕“城堡”写作。', { task: '围绕“灯塔”写作，别重复旧句“是——”。', mustKeep: '铜钥匙', avoid: '是——' })
  assert.ok(snapshot.themeAnchors.includes('灯塔')); assert.ok(!snapshot.themeAnchors.includes('城堡'))
  const missing = evaluate(snapshot, '灯塔仍然亮着。')
  assert.ok(missing.violations.some((item) => item.code === 'must_keep_missing' && item.severity === 'hard'))
  const forbidden = evaluate(snapshot, '灯塔旁，他握住铜钥匙，是——。')
  assert.ok(forbidden.violations.some((item) => item.code === 'forbidden_expression' && item.severity === 'hard'))
})

async function run(task, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-theme-scope-'))
  let requests = 0
  const text = Array.from(prefix + Array.from({ length: 150 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join('')).slice(0, 149).join('') + '。'
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', (chunk) => { raw += chunk }); request.on('end', () => {
      requests++
      const body = JSON.parse(raw); const last = [...body.messages].reverse().find((item) => item.role === 'user')
      let review; try { review = JSON.parse(last.content) } catch {}
      const output = review?.candidateHash && typeof review.candidate === 'string' ? JSON.stringify({ schemaVersion: 1, candidateHash: review.candidateHash, issues: [] }) : text
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\n'); response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const repo = api.createRepository(path.join(dir, 'run.db')); repo.open(); repo.createSession('s', '主题scope', 'fixture')
  const config = api.buildExecutionSnapshot({ payload: { id: 'theme-scope', sessionId: 's', text: task, mode: 'longwrite', phase: 'execute', longMode: true, targetChars: 150 }, sessionId: 's', memory: { projectPath: '', projectContent: '', userContent: '' }, settings: {
    model: 'fixture', baseUrl, maxTokens: 256, temperature: .7, topP: .9, thinkingEnabled: false, reasoningEffort: 'high', workDir: dir, docDir: path.join(dir, 'documents'), historyBudgetTokens: 8000, novelMode: false, galgame: { enabled: false, projectDir: '', sdkPath: '' }, strongConstraintEnabled: true, strongConstraintLevel: 'balanced', themeLockMode: 'strong'
  } })
  config.providerCallBudget = { maxCalls: 8, maxTokens: 200000, maxCost: null, maxCostCny: null, maxWallClockMs: 15000 }
  if (config.completionContract) config.completionContract.providerCallBudget = config.providerCallBudget
  let engine
  const adapter = api.createModelCallAdapter({ getApi: () => ({ apiKey: '', baseUrl, model: 'fixture', maxTokens: 256, temperature: .7, topP: .9, thinking: { enabled: false, effort: 'high' }, supportsTools: false, protocol: 'deepseek-chat', adapterId: 'builtin.deepseek', chatPath: '/chat/completions', authStyle: 'none', transportPolicy: { scope: 'loopback_http', allowNonDefaultPort: true } }), getConfig: () => config, getSignal: () => engine.abortSignal('theme-scope'), buildPrefix: async () => config.frozenSystemMessages })
  const store = api.createRunStorePort(repo, path.join(dir, 'artifacts'))
  engine = api.createAgentRunEngine({ store, modelCall: adapter, getConfig: () => config, toolExecutor: async () => '', onEvent: () => {}, onRunUpdate: () => {}, publishLongwriteArtifact: api.publishCliManuscript })
  try {
    assert.equal((await engine.start({ runId: 'theme-scope', sessionId: 's', config })).ok, true)
    await store.appendTurn({ runId: 'theme-scope', turnId: 'u', turnSeq: 1, role: 'user', content: task, createdAt: Date.now() }); await engine.step('theme-scope')
    const row = repo.getRun('theme-scope'), accepted = repo.getManuscriptSegmentsByRun('theme-scope').filter((segment) => segment.status === 'accepted' && segment.kind === 'prose').map((segment) => segment.content).join(''), artifact = repo.getArtifactsByRun('theme-scope').find((item) => item.artifact_type === 'manuscript')
    const fileText = artifact ? await fs.readFile(artifact.relative_path, 'utf8') : null
    return { row, config, requests, accepted, artifact, fileText, strongEvidence: await store.getRunEvidence('theme-scope', 'strong_constraint_latest') }
  } finally { repo.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); assert.equal(path.dirname(dir), os.tmpdir()); assert.match(path.basename(dir), /^dw-theme-scope-/); await fs.rm(dir, { recursive: true, force: true }) }
}
test('原任务经共享Engine/actual SSE/SQLite完成自然续写+真实文件，不要求复读旧残句', async () => {
  const f = await run(originalTask, '老周。他把马灯放在开关旁，林默转过身。')
  assert.equal(f.config.strongConstraints.enabled, true); assert.equal(f.config.strongConstraints.themeLockMode, 'strong')
  assert.equal(f.row.status, 'completed', f.row.error_message)
  assert.equal(f.accepted.length, 150); assert.ok(!f.accepted.includes('是——') && !f.accepted.includes('你不该来这里'))
  assert.equal(f.fileText, f.accepted); assert.equal(f.artifact.hash, createHash('sha256').update(f.fileText).digest('hex')); assert.equal(f.requests, 2)
})
test('混合正向主题的真实SSE连写：灯塔完成，持续跑偏保留审校证据而不假completed/交付', async () => {
  const task = '围绕“灯塔”写作，别重复旧句“是——”。'
  const good = await run(task, '灯塔的光落在水面，她推开铁门。')
  assert.equal(good.row.status, 'completed', good.row.error_message); assert.equal(good.fileText, good.accepted)
  const bad = await run(task, '城堡里的宴会还没有结束，他端起酒杯。')
  assert.equal(bad.row.status, 'waiting_user'); assert.equal(bad.row.error_code, 'run_no_progress')
  assert.ok(bad.strongEvidence.json.includes('topic_anchor_missing'))
  // The existing pipeline preserves soft advisory prose, unlike explicit hard
  // mustKeep/avoid. Do not pretend its paused accepted prefix is an empty draft.
  assert.equal(bad.accepted.length, 150); assert.equal(bad.artifact, undefined); assert.equal(bad.fileText, null); assert.ok(bad.requests <= 8)
})
