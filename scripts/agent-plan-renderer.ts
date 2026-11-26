import assert from 'node:assert/strict'
import { useStore } from '../src/renderer/src/store'

const initial = useStore.getState()
const approval = { runId: 'readonly-source', hash: 'a'.repeat(64) }
const message = { id: 'm_readonly-source_assistant', role: 'assistant', content: '已保存的实际方案', status: 'done', reasoning: '', usage: null, rounds: 0, toolNames: [], plan: 'pending', planApproval: approval }
let request: any
const preview = { mode: 'optimized', policyRevision: 0, previewId: 'preview-plan', budget: { status: 'ready' } }
function reset(): void {
  request = undefined
  ;(globalThis as any).window = { ds: { sessionsLoad: async () => [message], chatStart: async (input: unknown) => { request = input; return { runId: request.id, status: 'queued' } } } }
  useStore.setState({ ...initial, settings: { planMode: true } as any, currentSessionId: 'source-session', mode: 'agent', workspace: 'chat', longMode: false,
    messages: [{ ...message, toolEvents: [] }] as any, pendingPlan: { messageId: message.id, planId: 'plan_readonly-source', planText: message.content, approval },
    loadContext: async () => {}, previewContext: async () => preview as any, showToast: (text, kind) => { useStore.setState({ toast: { text, kind } as any }) } })
}

reset()
useStore.setState({ currentSessionId: null, messages: [], pendingPlan: null })
await useStore.getState().switchSession('source-session')
assert.deepEqual(useStore.getState().pendingPlan?.approval, approval)
assert.equal(useStore.getState().pendingPlan?.planText, message.content)
console.log('PASS saved session restores the durable plan identity and actual text')

reset()
useStore.setState({ workspace: 'novel', mode: 'longwrite', longMode: true })
await useStore.getState().approvePlan('未保存的替换方案', message.id)
assert.equal(request.mode, 'agent'); assert.equal(request.longMode, false)
assert.equal(request.phase, 'execute'); assert.equal(request.planAccess, undefined)
assert.equal(request.planText, message.content); assert.deepEqual(request.planApproval, approval)
console.log('PASS approval binds saved text and starts normal Agent even after workspace changes')

reset()
useStore.setState({ previewContext: async () => { useStore.setState({ contextPreviewError: '工作/文档目录已变化，请重新只读审阅' }); return null } })
await useStore.getState().approvePlan(message.content, message.id)
assert.equal(request, undefined); assert.match(useStore.getState().toast!.text, /目录已变化.*重新只读审阅/)
assert.ok(useStore.getState().pendingPlan)
console.log('PASS scope/project drift errors remain actionable and preserve the saved plan')

reset()
let finishReject!: () => void
;(window as any).ds.planReject = async (input: unknown) => { assert.deepEqual(input, approval); await new Promise<void>(resolve => { finishReject = resolve }); return true }
const rejecting = useStore.getState().rejectPlan(message.id)
assert.equal(useStore.getState().messages[0].plan, 'pending', 'UI rejection must wait for persistence')
finishReject(); await rejecting
assert.equal(useStore.getState().messages[0].plan, 'rejected'); assert.equal(useStore.getState().pendingPlan, null)
await useStore.getState().approvePlan(message.content, message.id)
assert.equal(request, undefined)
console.log('PASS rejected plans wait for durable ACK and cannot be approved from the stale card')

reset()
useStore.setState({ pendingPlan: null, messages: [], composerText: '只读查看真实稿件' })
const sent = await useStore.getState().send('只读查看真实稿件', [])
assert.equal(sent.ok, true); assert.equal(request.phase, 'plan'); assert.equal(request.planAccess, 'read_only'); assert.equal(request.mode, 'agent')
console.log('PASS composer submission explicitly opts only new Agent plans into read-only tool access')
