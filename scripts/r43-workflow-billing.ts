import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { classifyActivityTerminalStatus, createActivityBus } from '../src/main/activityBus'
import { createRepository, type ProviderAttemptRow, type Repository, type RunRow } from '../src/main/db/repository'
import { streamChat, type ProviderAttemptLifecycleEvent } from '../src/main/deepseek'
import { buildRunBillingView, type ProviderAttemptRecord } from '../src/shared/billing'

let passed = 0
function check(name: string, test: () => void): void {
  test()
  passed += 1
  console.log(`  PASS  ${name}`)
}

function runRow(runId: string, startedAt = 1_000): RunRow {
  return {
    run_id: runId,
    session_id: `session-${runId}`,
    status: 'running',
    phase: 'queued',
    started_at: startedAt,
    updated_at: startedAt,
    config_json: JSON.stringify({ model: 'deepseek-chat' }),
    parent_run_id: null,
    error_code: null,
    error_message: null,
    client_request_id: runId
  }
}

function attempt(input: Partial<ProviderAttemptRecord> & Pick<ProviderAttemptRecord, 'attemptId' | 'logicalCallId' | 'attemptNo' | 'actor'>): ProviderAttemptRecord {
  return {
    attemptId: input.attemptId,
    runId: input.runId ?? 'billing-pure',
    logicalCallId: input.logicalCallId,
    attemptNo: input.attemptNo,
    stageId: input.stageId ?? null,
    actor: input.actor,
    subtype: input.subtype ?? null,
    providerId: input.providerId ?? 'api.deepseek.com',
    endpointOrigin: input.endpointOrigin ?? 'https://api.deepseek.com',
    modelId: input.modelId ?? 'deepseek-chat',
    providerRequestId: input.providerRequestId ?? null,
    outcome: input.outcome ?? 'success',
    httpStatus: input.httpStatus ?? null,
    startedAt: input.startedAt ?? 1_000,
    firstTokenAt: input.firstTokenAt ?? null,
    endedAt: input.endedAt ?? null,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    cacheHitTokens: input.cacheHitTokens ?? null,
    cacheMissTokens: input.cacheMissTokens ?? null,
    reasoningTokens: input.reasoningTokens ?? null,
    costStatus: input.costStatus ?? 'unknown',
    costAmount: input.costAmount ?? null,
    costCurrency: input.costCurrency ?? null,
    priceSnapshotId: input.priceSnapshotId ?? null
  }
}

function providerRow(runId: string, value: ProviderAttemptRecord): ProviderAttemptRow {
  return {
    attempt_id: value.attemptId,
    run_id: runId,
    logical_call_id: value.logicalCallId,
    attempt_no: value.attemptNo,
    stage_id: value.stageId,
    actor: value.actor,
    subtype: value.subtype,
    provider_id: value.providerId,
    provider_endpoint_origin: value.endpointOrigin,
    model_id: value.modelId,
    provider_request_id: value.providerRequestId,
    outcome: value.outcome,
    http_status: value.httpStatus,
    started_at: value.startedAt,
    first_token_at: value.firstTokenAt,
    ended_at: value.endedAt,
    input_tokens: value.inputTokens,
    output_tokens: value.outputTokens,
    cache_hit_tokens: value.cacheHitTokens,
    cache_miss_tokens: value.cacheMissTokens,
    reasoning_tokens: value.reasoningTokens,
    cost_status: value.costStatus,
    cost_amount: value.costAmount,
    cost_currency: value.costCurrency,
    price_snapshot_id: value.priceSnapshotId
  }
}

function persistBus(repository: Repository, baseDir: string, pushed: number[]): ReturnType<typeof createActivityBus> {
  return createActivityBus({
    baseDir,
    persist: (event) => repository.appendWorkflowEvent(event),
    readEvents: (runId, afterSeq) => repository.getWorkflowEvents(runId, afterSeq),
    push: (event) => pushed.push(event.seq)
  })
}

async function main(): Promise<void> {
  console.log('\n[R43] durable provider billing + workflow replay')
  const pure = buildRunBillingView({
    runId: 'billing-pure', revision: 1, finalized: true, status: 'completed', startedAt: 1_000, endedAt: 2_000, toolCalls: 2,
    attempts: [
      attempt({ attemptId: 'a1', logicalCallId: 'l1', attemptNo: 1, actor: 'writer', endedAt: 1_100, outcome: 'http_error' }),
      attempt({ attemptId: 'a2', logicalCallId: 'l1', attemptNo: 2, actor: 'writer', startedAt: 1_200, firstTokenAt: 1_250, endedAt: 1_500, inputTokens: 10, outputTokens: 4, cacheHitTokens: 2, cacheMissTokens: 8, reasoningTokens: null })
    ]
  })
  check('unknown token propagates instead of becoming zero', () => {
    assert.equal(pure.tokens.input.value, null)
    assert.equal(pure.tokens.input.knownValue, 10)
    assert.equal(pure.tokens.input.unknownAttempts, 1)
    assert.equal(pure.tokens.reasoning.value, null)
  })
  check('provider TTFT uses first token minus request start', () => {
    assert.equal(pure.timing.ttftMs.value, null)
    assert.equal(pure.timing.ttftMs.knownValue, 50)
    assert.equal(pure.timing.ttftMs.unknownAttempts, 1)
  })
  check('retry is two attempts but one logical call', () => {
    assert.equal(pure.callCounts.attempts, 2)
    assert.equal(pure.callCounts.logicalCalls, 1)
    assert.equal(pure.callCounts.writer, 2)
    assert.equal(pure.callCounts.tool, 2)
  })
  check('unknown attempt makes aggregate cost unknown', () => {
    assert.equal(pure.cost.status, 'unknown')
    assert.equal(pure.cost.amount, null)
  })
  check('no provider attempt means token and timing fields are unknown, not zero', () => {
    const empty = buildRunBillingView({ runId: 'empty', revision: 1, finalized: false, status: 'queued', startedAt: 1_000, endedAt: null, toolCalls: 0, attempts: [] })
    assert.equal(empty.tokens.input.value, null)
    assert.equal(empty.tokens.output.value, null)
    assert.equal(empty.timing.ttftMs.value, null)
    assert.equal(empty.timing.attemptDurationMs.value, null)
  })
  check('recovery-required engine terminal maps to recoverable activity, never failure', () => {
    assert.equal(classifyActivityTerminalStatus('recovery_required'), 'recovery')
    assert.equal(classifyActivityTerminalStatus('waiting_user'), 'recovery')
    assert.equal(classifyActivityTerminalStatus('failed'), 'fail')
  })

  const lifecycle: ProviderAttemptLifecycleEvent[] = []
  const provider = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      'data: {"id":"provider-request-1","choices":[{"delta":{"content":"正文"},"finish_reason":null}]}',
      '',
      'data: {"id":"provider-request-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n'))
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  try {
    const address = provider.address()
    assert.ok(address && typeof address === 'object')
    await streamChat({
      apiKey: 'local-test-only',
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'test' }],
      thinking: { enabled: false, effort: 'low' }
    }, () => undefined, undefined, undefined, undefined, (event) => lifecycle.push(event))
  } finally {
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
  }
  check('real stream boundary emits started, first token and terminal exactly once', () => {
    assert.deepEqual(lifecycle.map((event) => event.type), ['started', 'first_token', 'terminal'])
    const terminal = lifecycle[2]
    assert.equal(terminal.type, 'terminal')
    if (terminal.type !== 'terminal') return
    assert.equal(terminal.outcome, 'success')
    assert.equal(terminal.providerRequestId, 'provider-request-1')
  })
  check('provider omitted cache/reasoning stay null at boundary', () => {
    const terminal = lifecycle[2]
    assert.equal(terminal.type, 'terminal')
    if (terminal.type !== 'terminal') return
    assert.equal(terminal.usage?.prompt_tokens, 9)
    assert.equal(terminal.usage?.completion_tokens, 2)
    assert.equal(terminal.usage?.prompt_cache_hit_tokens, null)
    assert.equal(terminal.usage?.prompt_cache_miss_tokens, null)
    assert.equal(terminal.usage?.reasoning_tokens, null)
  })

  const root = await mkdtemp(path.join(tmpdir(), 'deepwriter-r43-'))
  const migrationPath = path.join(root, 'migration-v10.db')
  const migrationSeed = createRepository(migrationPath)
  migrationSeed.open()
  migrationSeed.createRun(runRow('migration-preserved'))
  migrationSeed.close()
  const rawV10 = new DatabaseSync(migrationPath)
  rawV10.exec('DROP TABLE workflow_events; DROP TABLE run_billing_snapshots; DROP TABLE provider_call_attempts; PRAGMA user_version = 10')
  rawV10.close()
  const migratedV11 = createRepository(migrationPath)
  migratedV11.open()
  check('v10 database migrates append-only and preserves existing runs', () => {
    assert.equal(migratedV11.getRun('migration-preserved')?.run_id, 'migration-preserved')
    assert.deepEqual(migratedV11.getWorkflowEvents('migration-preserved'), [])
    assert.equal(migratedV11.getRunBilling('migration-preserved')?.tokens.input.value, null)
  })
  migratedV11.close()
  const dbPath = path.join(root, 'deepwriter.db')
  let repository = createRepository(dbPath)
  try {
    repository.open()
    const runId = 'durable-billing'
    repository.createRun(runRow(runId))
    const first = attempt({ attemptId: 'retry-1', runId, logicalCallId: 'logical-retry', attemptNo: 1, actor: 'writer', outcome: 'in_flight', startedAt: 2_000 })
    repository.startProviderAttempt(providerRow(runId, first))
    repository.finishProviderAttempt(first.attemptId, {
      outcome: 'http_error', http_status: 503, provider_request_id: 'req-failed', ended_at: 2_080,
      input_tokens: null, output_tokens: null, cache_hit_tokens: null, cache_miss_tokens: null, reasoning_tokens: null,
      cost_status: 'unknown', cost_amount: null, cost_currency: null, price_snapshot_id: null
    })
    const second = attempt({ attemptId: 'retry-2', runId, logicalCallId: 'logical-retry', attemptNo: 2, actor: 'writer', outcome: 'in_flight', startedAt: 2_100 })
    repository.startProviderAttempt(providerRow(runId, second))
    repository.markProviderAttemptFirstToken(second.attemptId, 2_145)
    repository.finishProviderAttempt(second.attemptId, {
      outcome: 'success', http_status: 200, provider_request_id: 'req-success', ended_at: 2_400,
      input_tokens: 120, output_tokens: 30, cache_hit_tokens: 20, cache_miss_tokens: 100, reasoning_tokens: null,
      cost_status: 'unknown', cost_amount: null, cost_currency: null, price_snapshot_id: null
    })
    for (const value of [
      attempt({ attemptId: 'critic-1', runId, logicalCallId: 'critic-logical', attemptNo: 1, actor: 'critic', startedAt: 2_500, firstTokenAt: 2_530, endedAt: 2_650, inputTokens: 40, outputTokens: 8 }),
      attempt({ attemptId: 'editor-1', runId, logicalCallId: 'editor-logical', attemptNo: 1, actor: 'editor', startedAt: 2_700, firstTokenAt: 2_740, endedAt: 2_900, inputTokens: 50, outputTokens: 12 })
    ]) {
      repository.startProviderAttempt(providerRow(runId, value))
      repository.markProviderAttemptFirstToken(value.attemptId, value.firstTokenAt!)
      repository.finishProviderAttempt(value.attemptId, {
        outcome: value.outcome, http_status: 200, provider_request_id: null, ended_at: value.endedAt,
        input_tokens: value.inputTokens, output_tokens: value.outputTokens, cache_hit_tokens: value.cacheHitTokens,
        cache_miss_tokens: value.cacheMissTokens, reasoning_tokens: value.reasoningTokens, cost_status: 'unknown',
        cost_amount: null, cost_currency: null, price_snapshot_id: null
      })
    }
    check('repository keeps failed retry and actor attribution', () => {
      const view = repository.getRunBilling(runId)!
      assert.equal(view.callCounts.attempts, 4)
      assert.equal(view.callCounts.logicalCalls, 3)
      assert.deepEqual([view.callCounts.writer, view.callCounts.critic, view.callCounts.editor], [2, 1, 1])
      assert.deepEqual(view.attempts.map((item) => item.outcome), ['http_error', 'success', 'success', 'success'])
    })

    const workflowRun = 'workflow-replay'
    repository.createRun(runRow(workflowRun, Date.now()))
    const pushed1: number[] = []
    const bus1 = persistBus(repository, root, pushed1)
    const handle1 = bus1.startRun({ runId: workflowRun, sessionId: `session-${workflowRun}` })
    const firstPhase = await handle1.emit({ type: 'phase.changed', phase: 'planning', title: '制定计划' })
    check('event is durable before renderer push', () => {
      assert.deepEqual(repository.getWorkflowEvents(workflowRun).map((event) => event.seq), [0, 1])
      assert.equal(firstPhase.seq, 1)
      assert.deepEqual(pushed1, [0, 1])
    })
    const pushed2: number[] = []
    const bus2 = persistBus(repository, root, pushed2)
    const handle2 = bus2.startRun({ runId: workflowRun, sessionId: `session-${workflowRun}` })
    const resumed = await handle2.emit({ type: 'phase.changed', phase: 'writing', title: '生成正文' })
    check('restart replay continues durable sequence without duplicate start', () => {
      assert.equal(resumed.seq, 2)
      assert.deepEqual(repository.getWorkflowEvents(workflowRun).map((event) => event.seq), [0, 1, 2])
      assert.deepEqual(pushed2, [2])
    })
    await handle2.complete('完成')
    const terminalSnapshot = await bus2.getSnapshot(workflowRun)
    check('terminal event and stage durations survive replay', () => {
      const view = repository.getRunBilling(workflowRun)!
      assert.equal(terminalSnapshot?.terminal?.state, 'completed')
      assert.equal(view.finalized, true)
      assert.notEqual(view.timing.runDurationMs, null)
      assert.ok(view.timing.stages.length >= 2)
      assert.ok(view.timing.stages.every((stage) => stage.durationMs !== null))
    })

    const legacyRun = 'legacy-jsonl-migration'
    repository.createRun(runRow(legacyRun, Date.now()))
    const legacyBus = createActivityBus({ baseDir: root, push: () => undefined })
    const legacyHandle = legacyBus.startRun({ runId: legacyRun, sessionId: `session-${legacyRun}` })
    await legacyHandle.setPhase('writing', '旧版写作事件')
    await legacyHandle.complete('旧版完成事件')
    assert.equal(repository.getWorkflowEvents(legacyRun).length, 0)
    const migratedBus = persistBus(repository, root, [])
    const migratedSnapshot = await migratedBus.getSnapshot(legacyRun)
    check('pre-R43 JSONL is migrated into durable workflow events before display', () => {
      assert.equal(migratedSnapshot?.terminal?.state, 'completed')
      assert.deepEqual(repository.getWorkflowEvents(legacyRun).map((event) => event.seq), [0, 1, 2])
      assert.equal(repository.getRunBilling(legacyRun)?.finalized, true)
    })

    const recoveryRun = 'recovery-non-terminal'
    repository.createRun(runRow(recoveryRun, Date.now()))
    const recoveryBus = persistBus(repository, root, [])
    const recoveryHandle = recoveryBus.startRun({ runId: recoveryRun, sessionId: `session-${recoveryRun}` })
    await recoveryHandle.setPhase('writing', '写入前')
    repository.updateRun(recoveryRun, { status: 'recovery_required', phase: 'recovery_required', error_code: 'side_effect_unknown', error_message: '需要人工确认' })
    await recoveryHandle.setPhase('recovery_required', '需要人工恢复', '需要人工确认')
    const recoverySnapshot = await recoveryBus.getSnapshot(recoveryRun)
    const replayedRecovery = await persistBus(repository, root, []).getSnapshot(recoveryRun)
    check('recovery phase persists and replays without run.failed/finalized billing', () => {
      const events = repository.getWorkflowEvents(recoveryRun)
      assert.equal(recoverySnapshot?.status, 'recovery_required')
      assert.equal(recoverySnapshot?.terminal, undefined)
      assert.equal(replayedRecovery?.status, 'recovery_required')
      assert.equal(events.some((event) => event.type === 'run.failed'), false)
      const billing = repository.getRunBilling(recoveryRun)!
      assert.equal(billing.status, 'recovery_required')
      assert.equal(billing.finalized, false)
      assert.equal(billing.endedAt, null)
    })

    const interruptedRun = 'interrupted-attempt'
    repository.createRun(runRow(interruptedRun))
    const dangling = attempt({ attemptId: 'dangling-1', runId: interruptedRun, logicalCallId: 'dangling-logical', attemptNo: 1, actor: 'writer', outcome: 'in_flight', startedAt: 4_000 })
    repository.startProviderAttempt(providerRow(interruptedRun, dangling))
    repository.close()
    repository = createRepository(dbPath)
    repository.open()
    const affected = repository.markDanglingProviderAttemptsInterrupted()
    check('restart marks in-flight attempt interrupted without inventing end/usage', () => {
      assert.deepEqual(affected, [interruptedRun])
      const restored = repository.getProviderAttempts(interruptedRun)[0]
      assert.equal(restored.outcome, 'interrupted')
      assert.equal(restored.ended_at, null)
      assert.equal(restored.input_tokens, null)
      assert.equal(repository.getRunBilling(interruptedRun)?.tokens.input.value, null)
    })

    const deleteRunId = 'delete-terminal-workflow'
    repository.createRun(runRow(deleteRunId, Date.now()))
    const deleteBus = persistBus(repository, root, [])
    const deleteHandle = deleteBus.startRun({ runId: deleteRunId, sessionId: `session-${deleteRunId}` })
    await deleteHandle.setPhase('writing', '正在写作')
    repository.updateRun(deleteRunId, { status: 'completed', phase: 'completed' })
    await deleteHandle.complete('完成')
    repository.tx(() => repository.deleteRun(deleteRunId), 'immediate')
    await deleteBus.forget(deleteRunId)
    check('删除终态工作流同时清理数据库事件和活动快照', () => {
      assert.equal(repository.getRun(deleteRunId), null)
      assert.deepEqual(repository.getWorkflowEvents(deleteRunId), [])
      assert.equal(repository.getRunBilling(deleteRunId), null)
    })
    const deletedSnapshot = await deleteBus.getSnapshot(deleteRunId)
    check('删除后的工作流不会被活动快照复活', () => assert.equal(deletedSnapshot, null))

    let activityListener: ((event: import('../src/shared/activity').ActivityEvent) => void) | null = null
    let resolveSettings!: (settings: Record<string, unknown>) => void
    const settingsGate = new Promise<Record<string, unknown>>((resolve) => { resolveSettings = resolve })
    const fullSnapshot: import('../src/shared/activity').RunSnapshot = {
      runId: 'subscribe-race', sessionId: 'session-race', status: 'writing', startedAt: 10, lastSeq: 2,
      currentTitle: '已同步正文', steps: [
        { seq: 0, type: 'run.started', phase: 'queued', title: '任务开始', timestamp: 10, elapsedMs: 0 },
        { seq: 1, type: 'phase.changed', phase: 'planning', title: '制定计划', timestamp: 20, elapsedMs: 10 },
        { seq: 2, type: 'activity.message', phase: 'writing', title: '已同步正文', timestamp: 30, elapsedMs: 20 }
      ], toolsById: {}, artifactsById: {}, usage: { source: 'estimated' }
    }
    const previousWindow = (globalThis as unknown as { window?: unknown }).window
    ;(globalThis as unknown as { window: unknown }).window = { ds: {
      onActivityEvent: (listener: typeof activityListener) => { activityListener = listener; return () => undefined },
      getSettings: () => settingsGate,
      activityGetSnapshot: async () => fullSnapshot,
      sessionsList: async () => [], runsRecoverable: async () => [], runsListRecent: async () => [],
      permissionsGet: async () => ({ mode: 'safe', rules: [] }), memoryGet: async () => null,
      styleList: async () => ({ profiles: [], sources: [], activeProfileId: '' }), presetsList: async () => [],
      onChatEvent: () => () => undefined, onChatError: () => () => undefined,
      onNovelEvent: () => () => undefined, onAttachmentAttached: () => () => undefined
    } }
    try {
      const { useStore } = await import('../src/renderer/src/store')
      const initPromise = useStore.getState().init()
      check('renderer subscribes before the first awaited settings/snapshot boundary', () => assert.ok(activityListener))
      activityListener!({ schemaVersion: 1, runId: 'subscribe-race', sessionId: 'session-race', seq: 2, timestamp: 30, elapsedMs: 20, type: 'activity.message', phase: 'writing', title: '窗口内事件' })
      for (let i = 0; i < 20 && useStore.getState().runs['subscribe-race']?.needsResync; i++) await new Promise((resolve) => setTimeout(resolve, 0))
      const reconciled = useStore.getState().runs['subscribe-race']
      check('event inserted during init gap triggers full snapshot replay and seq de-dup', () => {
        assert.equal(reconciled?.lastSeq, 2)
        assert.equal(reconciled?.needsResync, false)
        assert.deepEqual(reconciled?.steps.map((step) => step.seq), [0, 1, 2])
      })
      resolveSettings({})
      await initPromise
    } finally {
      ;(globalThis as unknown as { window?: unknown }).window = previousWindow
    }
  } finally {
    repository.close()
    await rm(root, { recursive: true, force: true })
  }
  console.log(`\nR43 targeted: ${passed}/${passed} PASS`)
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
