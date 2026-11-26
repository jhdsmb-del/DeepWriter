import assert from 'node:assert/strict'
import { useStore } from '../src/renderer/src/store'
import type { ActivityEvent, RunSnapshot } from '../src/shared/activity'

const initial = useStore.getState()
let onActivity: (event: ActivityEvent) => void = () => { throw new Error('missing listener') }
let snapshot: RunSnapshot
;(globalThis as any).window = { ds: {
  onActivityEvent: (listener: typeof onActivity) => { onActivity = listener; return () => {} },
  onChatEvent: () => () => {}, onChatError: () => () => {},
  getSettings: async () => ({}),
  activityGetSnapshot: async () => snapshot
} }
useStore.setState({ loadSessions: async () => {}, loadRecoverable: async () => {}, loadPermissions: async () => {}, loadMemory: async () => {}, loadStyle: async () => {}, loadPresets: async () => {} })
await useStore.getState().init()
const callbacks = useStore.getState()
function reset(): void {
  useStore.setState({ ...initial, init: callbacks.init, loadRecoverable: callbacks.loadRecoverable,
    currentSessionId: 'session-one', running: true, runningId: 'stopped-run', activeRunId: 'stopped-run',
    messages: [{ id: 'stopped-run', role: 'assistant', content: '停止前已有稿件', reasoning: '', status: 'streaming', toolEvents: [] }] as any
  })
}
function snap(status: RunSnapshot['status'], lastSeq = 0): RunSnapshot {
  return { runId: 'stopped-run', sessionId: 'session-one', status, startedAt: 1, lastSeq, steps: [], toolsById: {}, artifactsById: {}, usage: { source: 'estimated' } }
}

reset()
onActivity({ schemaVersion: 1, runId: 'stopped-run', sessionId: 'session-one', seq: 0, timestamp: 1, type: 'phase.changed', phase: 'recovery_required', title: '副作用待确认' })
assert.equal(useStore.getState().running, false)
assert.equal(useStore.getState().runningId, null)
assert.equal(useStore.getState().runs['stopped-run'].status, 'recovery_required')
assert.equal(useStore.getState().runs['stopped-run'].terminal, undefined)
assert.equal(useStore.getState().messages[0].content, '停止前已有稿件')
console.log('PASS recovery-required releases composer without declaring cancellation or discarding manuscript')

for (const status of ['paused', 'recovery_required'] as const) {
  reset()
  snapshot = snap(status)
  await useStore.getState().resyncRun('stopped-run')
  assert.equal(useStore.getState().running, false)
  assert.equal(useStore.getState().runningId, null)
}
reset()
snapshot = { ...snap('cancelled'), terminal: { state: 'cancelled' } }
await useStore.getState().resyncRun('stopped-run')
assert.equal(useStore.getState().running, false)
console.log('PASS durable resync repairs missed paused/recovery/terminal lifecycle events')

reset()
useStore.setState({ runningId: 'new-run', activeRunId: 'new-run' })
snapshot = snap('recovery_required')
await useStore.getState().resyncRun('stopped-run')
assert.equal(useStore.getState().runningId, 'new-run')
assert.equal(useStore.getState().running, true)
reset()
useStore.setState({ runs: { 'stopped-run': snap('thinking', 5) } })
snapshot = snap('recovery_required', 4)
await useStore.getState().resyncRun('stopped-run')
assert.equal(useStore.getState().running, true)
assert.equal(useStore.getState().runs['stopped-run'].status, 'thinking')
console.log('PASS background and stale snapshots cannot unlock or overwrite a newer active run')
