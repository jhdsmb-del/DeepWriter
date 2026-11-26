import assert from 'node:assert/strict'
import { createRepository } from '../src/main/db/repository'
import { sessionEditHistory } from '../src/main/sessionEditHistory'
const repo = createRepository(':memory:'); repo.open()
try {
  for (const [sid, rid] of [['a', 'run-a'], ['b', 'run-b']]) {
    repo.createSession(sid, sid, '')
    repo.createRun({ run_id: rid, session_id: sid, status: 'completed', phase: 'completed', started_at: 1, updated_at: 2, config_json: '{}', parent_run_id: null, error_code: null, error_message: null })
    repo.appendTurn({ turn_id: rid + '-turn', run_id: rid, turn_seq: 0, role: 'assistant', content: '回复', reasoning_content: null, tool_calls_json: null, tool_result_json: null, plan_state: null, created_at: 1 })
    repo.appendSessionMessage({ msg_id: `m_${rid}_assistant`, session_id: sid, seq: 1, role: 'assistant', content: '回复', created_at: 1 })
  }
  const put = (id: string, status: string, result: unknown, args: unknown = { path: '河岸.md', old_text: '小曲', new_text: '小禾' }, name = 'edit_file') => repo.upsertToolCall({ tool_call_id: id, turn_id: 'run-a-turn', run_id: 'run-a', name, args_json: JSON.stringify(args), args_hash: 'fixture-' + id, status, result_json: JSON.stringify(result), started_at: Number(id.slice(1)) || 1, completed_at: 3 })
  put('t1', 'completed', { content: JSON.stringify({ ok: true, message: '已修改 河岸.md：原稿第 1、3 行', edit: { count: 2, lines: [1, 3] } }) })
  put('t2', 'failed', { content: JSON.stringify({ ok: false, error: '用户拒绝修改' }) })
  put('t3', 'side_effect_unknown', { ok: true, message: '不得当成成功', edit: { count: 1 } })
  put('t4', 'completed', { ok: true, message: '没有命中', edit: { count: 0 } })
  put('t5', 'completed', { ok: true, message: '旧工具，没有对照片段' }, { path: '旧稿.md', content: '旧格式' })
  put('t6', 'completed', { ok: true, message: '已修改 长篇.md：原稿第 8 行', edit: { count: 1 } }, { path: '长篇.md', old_text: '前'.repeat(2000000), new_text: '后'.repeat(2000000) })
  put('t7', 'completed', { content: 'DO_NOT_RETURN_OTHER_TOOL_' + 'x'.repeat(2000000) }, { path: 'ignored' }, 'read_file')
  const page = sessionEditHistory(repo, 'a', 'm_run-a_assistant')
  assert.deepEqual(repo.getSessionEditMessageIds('a'), ['m_run-a_assistant'])
  assert.deepEqual(page.events[0].editReceipt, { before: '小曲', after: '小禾' })
  assert.match(page.events[0].result!, /原稿第 1、3 行/)
  assert.equal(page.events[0].status, 'done')
  for (const event of page.events.slice(1, 3)) { assert.equal(event.status, 'error'); assert.equal(event.editReceipt, undefined) }
  assert.match(page.events[1].result!, /未修改.*用户拒绝/)
  assert.match(page.events[2].result!, /待确认/)
  assert.equal(page.events[3].status, 'done')
  assert.equal(page.events[3].resultOk, true)
  assert.match(page.events[3].result!, /内容没有变化，未写盘/)
  assert.equal(page.events[3].editReceipt, undefined)
  assert.equal(page.events[4].editReceipt, undefined)
  assert.equal(page.events[5].editReceipt!.before.length, 161)
  assert.ok(JSON.stringify(page).length < 3500)
  assert.equal(page.events.length, 6)
  for (const [sid, mid] of [['b', 'm_run-a_assistant'], ['a', 'm_run-b_assistant'], ['a', 'invented']]) assert.deepEqual(sessionEditHistory(repo, sid, mid).events, [])
  put('t50', 'completed', { ok: true, error: '拒绝写入', message: '不得显示为成功', edit: { count: 1 } })
  put('t51', 'completed', {})
  put('t52', 'completed', { ok: true, message: { invalid: 'not a human receipt' }, edit: { count: 1 } })
  const edge = sessionEditHistory(repo, 'a', 'm_run-a_assistant').events
  assert.equal(edge.find(event => event.id === 't50')!.status, 'error')
  assert.equal(edge.find(event => event.id === 't50')!.editReceipt, undefined)
  assert.match(edge.find(event => event.id === 't51')!.result!, /待确认/)
  assert.equal(edge.find(event => event.id === 't52')!.status, 'error')
  for (let i = 8; i < 50; i++) put('t' + i, 'completed', { ok: true, message: '已修改', edit: { count: 1 } })
  assert.equal(sessionEditHistory(repo, 'a', 'm_run-a_assistant').events.length, 40)
  assert.equal(sessionEditHistory(repo, 'a', 'm_run-a_assistant').nextOffset, 40)
  assert.equal(sessionEditHistory(repo, 'a', 'm_run-a_assistant', 40).events.length, 11)
  console.log('PASS SQLite edit history: exact message/run/session scope, bounded excerpts/pages, no unrelated payloads, refusal/unknown/zero/legacy evidence')
} finally { repo.close() }

;(globalThis as any).window = { ds: {} }
const { useStore } = await import('../src/renderer/src/store')
const original = useStore.getState()
const snapshot = { id: 'm_run-a_assistant', role: 'assistant', content: '完成', reasoning: '', status: 'done', usage: null, rounds: 0, toolNames: ['edit_file'], createdAt: 1, hasEditHistory: true }
let resolve!: (value: unknown) => void
const pending = new Promise(yes => { resolve = yes })
;(window as any).ds = { sessionsLoad: async (id: string) => id === 'a' ? [snapshot] : [{ ...snapshot, id: 'legacy', hasEditHistory: false }], sessionsEditHistory: async () => pending }
useStore.setState({ ...original, currentSessionId: null, loadContext: async () => {}, stop: () => {} })
await useStore.getState().switchSession('a')
assert.equal(useStore.getState().messages[0].toolEvents.length, 0)
assert.equal(useStore.getState().messages[0].editHistory?.status, 'idle')
const read = useStore.getState().loadMessageEdits(snapshot.id)
await useStore.getState().switchSession('b')
await useStore.getState().switchSession('a') // ABA: same session, new view generation.
resolve({ events: [{ id: 'late', name: 'edit_file', argsPreview: '', status: 'done' }], nextOffset: null })
await read
assert.equal(useStore.getState().messages[0].editHistory?.status, 'idle')
assert.equal(useStore.getState().messages[0].toolEvents.length, 0)
;(window as any).ds.sessionsEditHistory = async () => ({ events: [{ id: 'real', name: 'edit_file', argsPreview: '', status: 'done', result: '已修改', editReceipt: { before: '小曲', after: '小禾' } }], nextOffset: null })
await useStore.getState().loadMessageEdits(snapshot.id)
assert.equal(useStore.getState().messages[0].toolEvents[0].editReceipt?.after, '小禾')
await useStore.getState().switchSession('b')
assert.equal(useStore.getState().messages[0].toolEvents.length, 0)
assert.equal(useStore.getState().messages[0].editHistory, undefined)
console.log('PASS renderer edit history: initial load, lazy projection, session/ABA race, old names never fabricated as completed tools')
