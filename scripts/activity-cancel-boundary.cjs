const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('esbuild')

// Exercise the actual registered handler without booting Electron or reading credentials.
const source = process.argv.includes('--baseline')
  ? execFileSync('git', ['show', 'HEAD:src/main/index.ts'], { encoding: 'utf8' })
  : readFileSync('src/main/index.ts', 'utf8')
const begin = source.indexOf("registerIpc('activity:cancel',")
const end = source.indexOf("registerIpc('activity:pause',", begin)
assert.ok(begin >= 0 && end > begin)
const handlerSource = transformSync(source.slice(begin, end), { loader: 'ts', format: 'cjs' }).code

function fixture({ status = 'running', engineOwnsRun = false, tools = [], checkpointFails = false, afterCancel = 'cancel_requested' } = {}) {
  let handler
  let cancelCalls = 0
  let cancelEvents = 0
  let releaseCalls = 0
  const phases = []
  const writes = []
  const row = { run_id: 'run-one', session_id: 'session-one', status, phase: status }
  const manuscript = '停止之前的已有稿件，必须保留。'
  const toolRows = tools.map((toolStatus, index) => ({ tool_call_id: `tool-${index}`, status: toolStatus, completed_at: null }))
  runInNewContext(handlerSource, {
    registerIpc: (_name, _options, callback) => { handler = callback }, schemas: { activityRunIdSchema: {} },
    activeChats: new Map(), activeGrillRuns: new Map(), activeGrillControllers: new Map(),
    repository: {
      getRun: () => ({ ...row }),
      updateRun: (_id, patch) => { writes.push(patch); Object.assign(row, patch) },
      getToolCallsByRun: () => toolRows,
      upsertToolCall: tool => Object.assign(toolRows.find(existing => existing.tool_call_id === tool.tool_call_id), tool)
    },
    stopLongformWorkflowForRun: async () => { if (checkpointFails) throw new Error('synthetic checkpoint failure') },
    runKernel: {
      abortSignal: () => engineOwnsRun ? new AbortController().signal : undefined,
      cancel: async () => { cancelCalls++; if (engineOwnsRun) row.status = row.phase = afterCancel }
    },
    activityBus: { cancelRun: async () => { cancelEvents++ }, startRun: () => ({ setPhase: async phase => { phases.push(phase) } }) },
    credentialRegistry: { release: () => { releaseCalls++ } }, permissionManager: { revokeLeasesByRunId: () => {} },
    floatingRunState: { runId: 'run-one' }, updateFloatingRun: () => {}, console: { warn: () => {} }
  })
  return { invoke: () => handler({}, { runId: 'run-one' }), row, toolRows, writes, phases, manuscript,
    counters: () => ({ cancelCalls, cancelEvents, releaseCalls }) }
}

;(async () => {
  for (const afterCancel of ['cancel_requested', 'recovery_required']) {
    const f = fixture({ engineOwnsRun: true, afterCancel, tools: ['running'] })
    assert.equal((await f.invoke()).ok, true)
    assert.equal(f.row.status, afterCancel)
    assert.equal(f.counters().cancelEvents, 0)
    assert.equal(f.writes.length, 0)
    assert.equal(f.counters().releaseCalls, 0)
  }
  console.log('PASS live cancellation and engine recovery are not overwritten by fake cancelled terminals')

  for (const status of ['running', 'side_effect_unknown', 'requested']) {
    const f = fixture({ status: 'recoverable', tools: [status] })
    await f.invoke()
    assert.equal(f.row.status, 'recovery_required')
    assert.equal(f.toolRows[0].status, 'side_effect_unknown')
    assert.equal(f.counters().cancelEvents, 0)
    assert.equal(f.phases[0], 'recovery_required')
    assert.equal(f.manuscript, '停止之前的已有稿件，必须保留。')
  }
  console.log('PASS restarted runs retain unknown side effects and publish a recoverable phase')

  const recovering = fixture({ status: 'recovery_required', engineOwnsRun: true, tools: ['side_effect_unknown'] })
  await recovering.invoke()
  assert.equal(recovering.row.status, 'recovery_required')
  assert.equal(recovering.counters().cancelCalls, 0)
  assert.equal(recovering.counters().cancelEvents, 0)
  console.log('PASS repeated stop does not mutate an existing recovery decision boundary')

  const safe = fixture({ status: 'recoverable', tools: ['completed'] })
  await safe.invoke()
  assert.equal(safe.row.status, 'cancelled')
  assert.equal(safe.counters().cancelEvents, 1)
  assert.equal(safe.counters().releaseCalls, 1)
  console.log('PASS detached runs without uncertain tools can finish cancellation')

  const blocked = fixture({ checkpointFails: true, engineOwnsRun: true })
  assert.equal((await blocked.invoke()).error, 'longform_checkpoint_failed')
  assert.equal(blocked.row.status, 'running')
  assert.equal(blocked.counters().cancelCalls, 0)
  assert.equal(blocked.counters().cancelEvents, 0)
  console.log('PASS checkpoint failure preserves the draft boundary and blocks engine cancellation')
})().catch(error => { console.error(error.message); process.exitCode = 1 })
