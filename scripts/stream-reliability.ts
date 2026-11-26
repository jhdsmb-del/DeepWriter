import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStreamBatcher, type ChatStreamEvent } from '../src/renderer/src/streamBatcher'

function fixture() {
  const delivered: ChatStreamEvent[] = []
  let scheduled: (() => void) | null = null
  const batcher = createStreamBatcher((event) => delivered.push(event), (flush) => {
    scheduled = flush
    return () => { scheduled = null }
  })
  return { batcher, delivered, tick: () => scheduled?.() }
}
const text = (delta: string, id = 'one'): ChatStreamEvent => ({ id, ev: { type: 'text', delta } })

test('a burst of 1,000 deltas renders once without changing Unicode or whitespace', () => {
  const { batcher, delivered, tick } = fixture()
  const deltas = Array.from({ length: 1000 }, (_, index) => `${index} 👩🏽‍💻\n `)
  for (const delta of deltas) batcher.push(text(delta))
  assert.deepEqual(delivered, [])
  tick()
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]?.ev.delta, deltas.join(''))
})

test('reasoning, text, tools, replacement and terminal boundaries retain exact order', () => {
  const { batcher, delivered, tick } = fixture()
  batcher.push({ id: 'one', ev: { type: 'reasoning', delta: '先思考' } })
  batcher.push(text('前半段'))
  batcher.push({ id: 'one', ev: { type: 'tool_call', tool: { id: 'tool-one', name: 'read_file', arguments: '{}' } } })
  batcher.push(text('后半段'))
  batcher.push({ id: 'one', ev: { type: 'text_replace', delta: '完整修订', replaceRevision: 2 } })
  batcher.push(text('，补充。'))
  batcher.push({ id: 'one', ev: { type: 'done', finishReason: 'stop' } })
  tick()
  assert.deepEqual(delivered.map(({ ev }) => ev.type), ['reasoning', 'text', 'tool_call', 'text', 'text_replace', 'text', 'done'])
  assert.deepEqual(delivered.filter(({ ev }) => ev.type === 'text').map(({ ev }) => ev.delta), ['前半段', '后半段', '，补充。'])
})

test('different run ids never merge; flushing a terminal activity delivers pending text', () => {
  const { batcher, delivered } = fixture()
  batcher.push(text('旧任务', 'old'))
  batcher.push(text('新任务', 'new'))
  batcher.flush()
  assert.deepEqual(delivered.map(({ id, ev }) => [id, ev.delta]), [['old', '旧任务'], ['new', '新任务']])
})

test('cancelling a subscription cancels its scheduled callback and cannot leak into another session', () => {
  const { batcher, delivered, tick } = fixture()
  batcher.push(text('待取消'))
  batcher.cancel()
  tick()
  assert.deepEqual(delivered, [])
  batcher.push(text('下一条', 'new'))
  tick()
  assert.equal(delivered[0]?.id, 'new')
})

;(globalThis as any).window = { ds: {} }
const { useStore } = await import('../src/renderer/src/store')
const initial = useStore.getState()
let onChat!: (event: ChatStreamEvent) => void
let onError!: (event: { id: string; message: string }) => void
let releaseSettings!: (value: unknown) => void
const settings = new Promise((resolve) => { releaseSettings = resolve })
;(window as any).ds = {
  getSettings: () => settings,
  onChatEvent: (callback: typeof onChat) => { onChat = callback; return () => undefined },
  onChatError: (callback: typeof onError) => { onError = callback; return () => undefined }
}
const init = useStore.getState().init()
await test('chat listeners are installed before settings resolve; concurrent init shares the same subscription', async () => {
  assert.equal(typeof onChat, 'function')
  assert.equal(typeof onError, 'function')
  assert.equal(useStore.getState().init(), init)
  releaseSettings({})
  await init
})

const message = (id: string) => ({ id, role: 'assistant' as const, content: '', reasoning: '', status: 'streaming' as const, usage: null, rounds: 0, toolEvents: [] })
await test('a delayed error for an old task cannot clear a newer task owner; pending text flushes first', () => {
  useStore.setState({ ...initial, running: true, runningId: 'new', messages: [message('old'), message('new')] })
  onChat(text('待显示的正文', 'old'))
  onError({ id: 'old', message: '旧任务错误' })
  assert.equal(useStore.getState().running, true)
  assert.equal(useStore.getState().runningId, 'new')
  assert.equal(useStore.getState().messages[0]?.content, '待显示的正文')
  assert.equal(useStore.getState().messages[0]?.status, 'error')
})

await test('tool updates cannot mutate prior message snapshots used by memoized rows', () => {
  const previous = { ...message('one'), toolEvents: [{ id: 'tool', name: 'read_file', argsPreview: '旧参数', status: 'running' as const }] }
  useStore.setState({ ...initial, messages: [previous] })
  onChat({ id: 'one', ev: { type: 'tool_call', tool: { id: 'tool', name: 'read_file', arguments: '{"path":"new"}' } } })
  assert.equal(previous.toolEvents[0]?.argsPreview, '旧参数')
  const current = useStore.getState().messages[0]!
  onChat({ id: 'one', ev: { type: 'tool_result', toolResult: { toolId: 'tool', name: 'read_file', ok: false, result: '故障', durationMs: 1 } } })
  assert.equal(current.toolEvents[0]?.status, 'running')
  assert.equal(useStore.getState().messages[0]?.toolEvents[0]?.status, 'error')
})

await test('the final event flushes every delta before unlocking the owning task', () => {
  useStore.setState({ ...initial, running: true, runningId: 'final', messages: [message('final')] })
  for (let i = 0; i < 100; i++) onChat(text('完整。', 'final'))
  onChat({ id: 'final', ev: { type: 'done', finishReason: 'stop' } })
  assert.equal(useStore.getState().messages[0]?.content, '完整。'.repeat(100))
  assert.equal(useStore.getState().messages[0]?.status, 'done')
  assert.equal(useStore.getState().running, false)
})
