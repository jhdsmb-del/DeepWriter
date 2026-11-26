const assert = require('node:assert/strict')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const path = require('node:path')
const built = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/cli/interactive.ts')], bundle: true,
  platform: 'node', format: 'cjs', write: false, define: { __DEEPWRITER_VERSION__: '"test"' }
})
const loaded = new Module(__filename)
loaded._compile(built.outputFiles[0].text, __filename)
const { runInteractive } = loaded.exports

test('REPL changes and undo-edit address the exact durable run/tool without invoking a model', async () => {
  const queued = ['/changes run-1', '/undo-edit run-1 "tool id with spaces"', '/undo-edit run-1 tool-2', '/exit']
  const calls = [], emitted = [], oldCode = process.exitCode
  try {
    await runInteractive({
      runtime: {
        repo: { listSessions: () => [{ session_id: 'session-1', title: '改稿', model: 'offline' }], getRun: id => id === 'run-1' ? { run_id: id } : null, getToolCallsByRun: () => [] },
        undoEdit: async (runId, toolCallId) => {
          calls.push([runId, toolCallId])
          const ok = calls.length === 2
          return { ok, status: ok ? 'undone' : 'blocked', code: ok ? 'undone' : 'file_changed', message: ok ? '已撤销这一笔改稿' : '稿件后来又有修改，未覆盖' }
        }
      }, config: { model: 'offline' }, options: { session: 'session-1' },
      emit: (type, data) => { emitted.push({ type, data }) }, question: async () => queued.shift(), redact: text => text,
      interrupted: () => false, beforePrompt: () => {}, busy: () => {}
    })
    assert.deepEqual(calls, [['run-1', 'tool id with spaces'], ['run-1', 'tool-2']])
    assert.deepEqual(emitted.map(event => event.type), ['changes', 'undo_edit', 'undo_edit'])
    assert.equal(emitted[1].data.status, 'blocked'); assert.equal(emitted[2].data.status, 'undone')
    assert.equal(process.exitCode, 0)
  } finally { process.exitCode = oldCode }
})
