import assert from 'node:assert/strict'
import { useStore } from '../src/renderer/src/store'

const initial = useStore.getState()
let request: { id: string } | undefined
let resolveAck: (value: unknown) => void
let rejectAck: (reason: unknown) => void
const bridge = { chatStart: (input: { id: string }) => {
  request = input
  return new Promise((resolve, reject) => { resolveAck = resolve; rejectAck = reject })
} }
;(globalThis as any).window = { ds: bridge }
function reset(): void {
  request = undefined
  useStore.setState({ ...initial, currentSessionId: 'session-one', activeRunId: 'plan-run', settings: {} as any,
    messages: [{ id: 'plan-message', role: 'assistant', content: '原计划', plan: 'pending', status: 'done', reasoning: '', usage: null, rounds: 0, toolEvents: [] }] as any,
    pendingPlan: { messageId: 'plan-message', planId: 'plan-one', planText: '原计划' },
    pendingStoryScope: { storyId: 'keep-scope' } as any,
    previewContext: async () => ({ mode: 'optimized', policyRevision: 0, previewId: 'preview-one', budget: { status: 'ready' } }) as any,
    showToast: (text, kind) => { useStore.setState({ toast: { text, kind: kind ?? 'info' } as any }) }
  })
}
async function start(): Promise<Promise<void>[]> {
  const operation = useStore.getState().approvePlan('修改后的计划')
  await Promise.resolve()
  assert.ok(request)
  return [operation]
}

reset()
let [operation] = await start()
let completed = false
operation.then(() => { completed = true })
await Promise.resolve()
assert.equal(completed, false, 'approval must wait for the main acknowledgement')
resolveAck!({ runId: request!.id, status: 'queued' })
await operation
assert.equal(useStore.getState().running, true)
assert.equal(useStore.getState().pendingPlan, null)
assert.equal(useStore.getState().pendingStoryScope, null)
console.log('PASS success waits for ACK and keeps the accepted run active')

for (const outcome of ['reject', 'invalid', 'cost'] as const) {
  reset()
  ;[operation] = await start()
  if (outcome === 'reject') rejectAck!(new Error('synthetic rejection'))
  else resolveAck!(outcome === 'cost' ? { status: 'cost_confirmation_required' } : { ok: false })
  await operation
  const state = useStore.getState()
  assert.equal(state.running, false)
  assert.equal(state.runningId, null)
  assert.equal(state.activeRunId, 'plan-run')
  assert.equal(state.pendingPlan?.planText, '修改后的计划')
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].plan, 'pending')
  assert.ok(state.pendingStoryScope)
  assert.ok(state.toast)
}
console.log('PASS rejected, invalid and legacy cost ACK restore a retryable plan without unhandled rejection')

for (const outcome of ['resolve', 'reject'] as const) {
  for (const sessionId of ['session-one', 'session-two']) {
    reset()
    ;[operation] = await start()
    useStore.setState({ currentSessionId: sessionId, runningId: 'new-run', activeRunId: 'new-run', pendingStoryScope: { storyId: 'new-scope' } as any })
    const before = useStore.getState()
    if (outcome === 'resolve') resolveAck!({ runId: request!.id })
    else rejectAck!(new Error('late rejection'))
    await operation
    assert.equal(useStore.getState(), before, 'late result must not mutate a newer session or run')
  }
}
console.log('PASS late success and failure cannot overwrite another session or newer run')
