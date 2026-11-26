const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
before(() => {
  const built = buildSync({ stdin: { resolveDir: root, loader: 'ts', contents: "export {createRepository} from './src/main/db/repository'; export * from './src/main/workSteering'; export {workSteeringSchema} from './src/shared/ipcSchemas';" },
    bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false })
  const loaded = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports); api = loaded.exports
})
async function fixture(fn, config = { runMode: 'agent', longMode: false }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-steering-unit-')), db = path.join(dir, 'test.sqlite')
  const repo = api.createRepository(db); repo.open()
  repo.createSession('session', 'test', '')
  repo.createRun({ run_id: 'run', session_id: 'session', status: 'running', phase: 'thinking', started_at: 1, updated_at: 1, config_json: JSON.stringify(config), parent_run_id: null, error_code: null, error_message: null })
  repo.appendTurn({ turn_id: 'initial', run_id: 'run', turn_seq: 1, role: 'user', content: '原始任务', reasoning_content: null, tool_calls_json: null, tool_result_json: null, plan_state: null, created_at: 1 })
  repo.appendSessionMessage({ msg_id: 'm_run_assistant', session_id: 'session', seq: 1, role: 'assistant', content: '正在处理', status: 'thinking', created_at: 1 })
  const input = (id, text = id) => ({ runId: 'run', sessionId: 'session', requestId: id, text })
  try { await fn({ repo, db, input }) } finally { repo.close(); await fs.rm(dir, { recursive: true, force: true }) }
}
test('two SQLite clients persist ordered idempotent human inputs; admission appends each real user turn exactly once', () => fixture(async ({ repo, db, input }) => {
  api.queueWorkSteering(repo, input('first', '不要覆盖原稿。'))
  const other = api.createRepository(db); other.open()
  try { api.queueWorkSteering(other, input('second', '保留第一人称。')); api.queueWorkSteering(other, input('first', '不要覆盖原稿。')) } finally { other.close() }
  assert.throws(() => api.queueWorkSteering(repo, input('first', '别的内容')), /request_conflict/)
  assert.deepEqual(api.workSteeringView(repo, 'run', 'session').messages.map(m => [m.sequence, m.status]), [[1, 'pending'], [2, 'pending']])
  assert.equal(repo.getSessionMessages('session').at(-1).msg_id, 'm_run_assistant')
  assert.equal(repo.getSessionMessages('session').filter(m => m.role === 'user').every(m => m.status === 'thinking'), true, 'pending input is not accepted context for another run')
  assert.deepEqual(api.consumeWorkSteering(repo, 'run', 'session').map(t => t.content), ['不要覆盖原稿。'])
  assert.deepEqual(repo.getSessionMessages('session').filter(m => m.role === 'user').map(m => m.status), ['done', 'thinking'])
  assert.deepEqual(api.consumeWorkSteering(repo, 'run', 'session').map(t => t.content), ['保留第一人称。'])
  assert.deepEqual(api.consumeWorkSteering(repo, 'run', 'session'), [])
  assert.deepEqual(repo.getTurnsByRun('run').map(t => t.role), ['user', 'user', 'user'])
  assert.equal(api.workSteeringView(repo, 'run', 'session').messages.every(m => m.status === 'applied'), true)
}))
test('stop/pause and unknown tool effects preserve pending input across reopen without acknowledging or replaying tools', () => fixture(async ({ repo, db, input }) => {
  api.queueWorkSteering(repo, input('pending'))
  repo.upsertToolCall({ tool_call_id: 'write', run_id: 'run', turn_id: 'initial', name: 'write_file', args_json: '{}', args_hash: 'test', status: 'side_effect_unknown', started_at: 1, completed_at: 2, result_json: null })
  assert.deepEqual(api.consumeWorkSteering(repo, 'run', 'session'), [])
  repo.updateRun('run', { status: 'waiting_user' })
  assert.deepEqual(api.consumeWorkSteering(repo, 'run', 'session'), [])
  const other = api.createRepository(db); other.open()
  try { assert.equal(api.workSteeringView(other, 'run', 'session').messages[0].status, 'pending'); assert.equal(other.getToolCallsByRun('run')[0].status, 'side_effect_unknown') } finally { other.close() }
  repo.updateRun('run', { status: 'cancelled' })
  assert.equal(api.workSteeringView(repo, 'run', 'session').messages[0].status, 'pending')
  assert.throws(() => api.queueWorkSteering(repo, input('new')), /run_finished/)
  assert.equal(api.queueWorkSteering(repo, input('pending')).status, 'pending', 'retry returns original saved receipt even after stop')
}))
test('enqueue and admission are atomic with session history and durable turns', () => fixture(async ({ repo, input }) => {
  const failing = { ...repo, appendSessionMessage() { throw new Error('disk full') } }
  assert.throws(() => api.queueWorkSteering(failing, input('rollback')), /disk full/)
  assert.equal(api.workSteeringView(repo, 'run', 'session').messages.length, 0)
  api.queueWorkSteering(repo, input('kept'))
  assert.throws(() => api.consumeWorkSteering({ ...repo, saveRunEvidence() { throw new Error('disk full') } }, 'run', 'session'), /disk full/)
  assert.equal(repo.getTurnsByRun('run').length, 1)
  assert.equal(api.workSteeringView(repo, 'run', 'session').messages[0].status, 'pending')
}))
test('session/run, strict IPC, text validity and ordinary-work-only boundaries reject forged or unsupported inputs', async () => {
  await fixture(async ({ repo, input }) => {
    assert.throws(() => api.queueWorkSteering(repo, { ...input('bad'), sessionId: 'other' }), /run_not_found/)
    for (const text of ['', ' ', '\0', '\ud800', '甲'.repeat(8001)]) assert.throws(() => api.queueWorkSteering(repo, input('bad', text)), /invalid_input/)
    assert.equal(api.workSteeringSchema.safeParse({ ...input('bad'), toolPolicy: { allowList: ['*'] } }).success, false)
  })
  for (const config of [{ runMode: 'longwrite', longMode: true }, { runMode: 'agent', planMode: true }]) await fixture(async ({ repo, input }) => {
    assert.throws(() => api.queueWorkSteering(repo, input('not-work')), /work_agent_only/)
  }, config)
})

test('request identifiers are scoped to the run, not global transcript or turn identities', () => fixture(async ({ repo, input }) => {
  api.queueWorkSteering(repo, input('shared_id', '第一份任务'))
  const existing = repo.getRun('run')
  repo.createRun({ ...existing, run_id: 'run_shared' })
  api.queueWorkSteering(repo, { ...input('id', '另一份任务'), runId: 'run_shared' })
  assert.equal(api.consumeWorkSteering(repo, 'run', 'session')[0].content, '第一份任务')
  assert.equal(api.consumeWorkSteering(repo, 'run_shared', 'session')[0].content, '另一份任务')
  assert.equal(repo.getSessionMessages('session').filter(row => row.role === 'user').length, 2)
}))
