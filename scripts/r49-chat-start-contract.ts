import { createGrillMeState } from '../src/shared/grillMe'

type Check = { name: string; ok: boolean; detail?: string }
const checks: Check[] = []
const check = (name: string, ok: boolean, detail = ''): void => checks.push({ name, ok, detail })

const sessionId = 'grill-session-authoritative'
const oldSessionId = 'renderer-session-stale'
const requested: Array<Record<string, unknown>> = []

// The store is renderer code, but this probe only supplies a deterministic IPC
// seam. No provider/network request is possible here.
;(globalThis as any).window = {
  ds: {
    contextGetPreference: async (id: string) => {
      check('context preference is read for the Grill durable session', id === sessionId, id)
      return { sessionId: id, mode: 'optimized', revision: 0, pinRevision: 0, persisted: false }
    },
    contextListPins: async (id: string) => {
      check('context pins use the Grill durable session', id === sessionId, id)
      return []
    },
    contextPreview: async (input: Record<string, unknown>) => {
      requested.push(input)
      check('preview session is the Grill durable session', input.sessionId === sessionId, String(input.sessionId))
      check('preview mode/revision come from that session', input.mode === 'optimized' && input.preferenceRevision === 0, JSON.stringify({ mode: input.mode, revision: input.preferenceRevision }))
      return { previewId: 'preview-r49', sessionId, mode: 'optimized', policyRevision: 0, budget: { status: 'ready' } }
    },
    chatStart: async (input: Record<string, unknown>) => {
      requested.push(input)
      const grill = input.grillMe as { sessionId?: string; stateId?: string } | undefined
      check('chat:start session matches the Grill state', input.sessionId === sessionId, String(input.sessionId))
      check('chat:start carries the confirmed Grill payload', Boolean(grill?.stateId) && input.quickBypass !== true, JSON.stringify(grill ?? null))
      return { runId: input.id, status: 'queued' }
    }
  }
}

const { useStore } = await import('../src/renderer/src/store')
const initial = useStore.getState()
const grill = createGrillMeState({ stateId: 'grill-r49', sessionId, originalTask: '写一篇经过大纲确认的长文', targetChars: 8000, now: 1 })
const confirmed = {
  ...grill,
  status: 'confirmed' as const,
  slots: grill.slots.map((slot, index) => ({ ...slot, answer: index === 0 ? '明确主题' : '', source: index === 0 ? 'user' as const : slot.source })),
  approvedOutline: { title: '测试大纲', premise: '测试主旨', targetChars: 8000, sections: [{ id: 's1', title: '第一节', purpose: '测试', targetChars: 8000, beats: ['推进'], sourceSlotIds: ['goal'] }] },
  outlineHash: 'r49-outline-hash',
  outlineRevision: 1
}

useStore.setState({
  ...initial,
  settings: { planMode: false, strongConstraintEnabled: true, strongConstraintLevel: 'balanced', themeLockMode: 'strong', expressionFreedom: 'high', antiMoralizingEnabled: true } as any,
  mode: 'longwrite', workspace: 'novel', longMode: true, targetChars: 8000,
  currentSessionId: oldSessionId, contextMode: 'full', contextPreferenceRevision: 7,
  messages: [], running: false, pendingAttachments: []
})

const result = await useStore.getState().send(confirmed.originalTask, [], confirmed as any)
check('confirmed Grill handoff receives chat:start acknowledgement', result.ok === true, JSON.stringify(result))
check('renderer session is realigned to the Grill session', useStore.getState().currentSessionId === sessionId, useStore.getState().currentSessionId ?? '')
check('preview and chat:start were both reached', requested.length === 2, String(requested.length))

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
const failed = checks.filter((item) => !item.ok)
console.log(`R49 chat:start contract: ${checks.length - failed.length} PASS / ${failed.length} FAIL`)
if (failed.length > 0) process.exitCode = 1
