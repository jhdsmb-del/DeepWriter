const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const esbuild = require('esbuild')
const source = esbuild.buildSync({ entryPoints: [path.join(__dirname, '../src/main/sessionEditHistory.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const loaded = { exports: {} }
new Function('require', 'module', 'exports', source)(require, loaded, loaded.exports)
const { sessionEditHistory } = loaded.exports
const project = (status, payload) => sessionEditHistory({ getSessionEditTools: () => [{ tool_call_id: 'zero-edit', turn_id: 'turn', run_id: 'run', name: 'edit_file', args_json: JSON.stringify({ path: '河岸.md', old_text: '小曲', new_text: '小曲' }), args_hash: 'fixture', status, result_json: JSON.stringify(payload), started_at: 1, completed_at: 2 }] }, 'session', 'message').events[0]

test('完成且成功的零次替换是正常未写入记录，不生成已改动回执', () => {
  const event = project('completed', { ok: true, message: '河岸.md：内容没有变化，未写盘', edit: { count: 0 } })
  assert.equal(event.status, 'done')
  assert.equal(event.resultOk, true)
  assert.equal(event.result, '河岸.md：内容没有变化，未写盘')
  assert.equal(event.editReceipt, undefined)
})

test('零次替换不能覆盖工具失败、拒绝或矛盾错误', () => {
  for (const [status, extra] of [['failed', {}], ['completed', { ok: false }], ['completed', { error: '拒绝写入' }]]) {
    const event = project(status, { ok: true, message: '失败', edit: { count: 0 }, ...extra })
    assert.equal(event.status, 'error')
    assert.equal(event.resultOk, false)
    assert.equal(event.editReceipt, undefined)
    assert.doesNotMatch(event.result, /内容没有变化/)
  }
})
