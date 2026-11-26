const test = require('node:test')
const assert = require('node:assert/strict')
const { buildSync, transformSync } = require('esbuild')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
globalThis.window = { ds: {} }
const moduleValue = { exports: {} }
const built = buildSync({ entryPoints: [path.join(root, 'src/renderer/src/store.ts')], bundle: true, platform: 'node', format: 'cjs', write: false })
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, moduleValue, moduleValue.exports)
const store = moduleValue.exports.useStore
const initial = store.getState()
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function reset() { store.setState({ ...initial, currentSessionId: null, stop: () => {}, loadContext: async () => {} }); window.ds = { sessionsLoad: async () => [] } }

test('采访恢复的迟到上下文不会夺回新会话', async () => {
  reset(); const wait = deferred()
  store.setState({ currentSessionId: 'a', workspace: 'chat', loadContext: async () => wait.promise })
  const restoring = store.getState().restoreGrillSession({ sessionId: 'a' })
  store.getState().newSession(); const newer = store.getState().currentSessionId
  wait.resolve(); await restoring
  assert.equal(store.getState().currentSessionId, newer)
  assert.equal(store.getState().workspace, 'chat')
})

test('采访查询只改变仍在查看的会话，失败不清空已载入正文', async () => {
  reset(); const wait = deferred()
  window.ds.grillLatestUnconsumed = async id => id === 'a' ? wait.promise : null
  const a = store.getState().switchSession('a')
  await new Promise(resolve => setImmediate(resolve))
  await store.getState().switchSession('b')
  wait.resolve({ sessionId: 'a' }); await a
  assert.equal(store.getState().currentSessionId, 'b'); assert.equal(store.getState().workspace, 'chat')
  window.ds.sessionsLoad = async () => [{ id: 'm', role: 'assistant', content: '现有正文', toolNames: [] }]
  window.ds.grillLatestUnconsumed = async () => { throw new Error('temporary') }
  await store.getState().switchSession('c')
  assert.equal(store.getState().messages[0].content, '现有正文')
})

test('长文工作台不会把另一会话的活动运行当作当前稿件', () => {
  const source = readFileSync(path.join(root, 'src/renderer/src/components/LongformWorkflowShell.tsx'), 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf('function currentRun(')
  const end = source.indexOf('\n}\n', start) + 2
  const code = transformSync(source.slice(start, end) + '\nmodule.exports=currentRun;', { loader: 'ts', format: 'cjs' }).code
  const loaded = { exports: {} }
  new Function('module', 'isTerminalPhase', code)(loaded, status => ['completed', 'failed', 'cancelled'].includes(status))
  const a = { sessionId: 'a', status: 'writing', startedAt: 1 }, b = { sessionId: 'b', status: 'writing', startedAt: 2 }
  assert.equal(loaded.exports({ a, b }, 'a', 'b', 'b'), a)
  assert.equal(loaded.exports({ b }, 'a', 'b', 'b'), null)
  assert.equal(loaded.exports({ b }, null, 'b', 'b'), null)
})
