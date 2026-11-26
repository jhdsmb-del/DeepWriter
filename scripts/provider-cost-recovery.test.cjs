const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { before, test } = require('node:test')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..')
let api
before(async () => {
  const result = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
    export {createRepository} from './src/main/db/repository';
    export {createRunStorePort,createModelCallAdapter} from './src/main/runKernelAdapter';
    export {createAgentRunEngine} from './src/main/jobs/AgentRunEngine';
    export {configureTerminalHost} from './src/cli/host';` },
    bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false, logLevel: 'silent', alias: { electron: path.join(root, 'src/cli/host.ts') } })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
  api = module.exports
})

// The real adapter's beforeAttempt quote is based on this exact synthetic wire
// envelope. No HTTP, DNS, user settings or credentials are accessed.
const bodyJson = JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: '检查稿件。' }], stream: true, max_tokens: 16 })
const quoteAmount = (Buffer.byteLength(bodyJson) * 2 + 16 * 3) / 1_000_000
const price = { id: 'fixture-price', providerId: 'provider.fixture', remoteModelId: 'fixture-model', canonicalOrigin: 'https://budget.fixture.invalid',
  currency: 'USD', unit: 'per_1m_tokens', inputMissPerMillion: 2, cacheHitPerMillion: 1, outputPerMillion: 3, reasoningBillingRule: 'included_in_output' }

function attemptRow(runId, logicalCallId, innerAttempt, startedAt) {
  return { attempt_id: `${logicalCallId}:${innerAttempt}`, run_id: runId, logical_call_id: logicalCallId, attempt_no: innerAttempt,
    stage_id: 'execute', actor: 'writer', subtype: null, provider_id: 'provider.fixture', provider_endpoint_origin: price.canonicalOrigin, model_id: 'fixture-model',
    provider_request_id: null, outcome: 'in_flight', http_status: null, started_at: startedAt, first_token_at: null, ended_at: null,
    input_tokens: null, output_tokens: null, cache_hit_tokens: null, cache_miss_tokens: null, reasoning_tokens: null,
    cost_status: 'unknown', cost_amount: null, cost_currency: null, price_snapshot_id: null }
}
const terminalPatch = endedAt => ({ outcome: 'success', http_status: 200, provider_request_id: null, ended_at: endedAt,
  input_tokens: 10, output_tokens: 5, cache_hit_tokens: null, cache_miss_tokens: null, reasoning_tokens: null,
  cost_status: 'unknown', cost_amount: null, cost_currency: null, price_snapshot_id: null })

async function scenario(limit, addUnboundedAttempt = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-cost-recovery-'))
  const database = path.join(directory, 'run.db')
  api.configureTerminalHost({ dataDir: directory, docDir: directory })
  let repo = api.createRepository(database); repo.open()
  const runId = 'fixture-run'
  const config = { runMode: 'agent', sessionId: 'fixture-session', model: 'fixture-model', baseUrl: price.canonicalOrigin, maxTokens: 16, maxTurns: 4,
    providerCallBudget: { maxCalls: 8, maxTokens: 100000, maxWallClockMs: 300000, maxCost: { amount: limit, currency: 'USD', unknownPolicy: 'deny' } } }
  let requests = 0
  let engine, pausePromise
  const makeEngine = pauseAfterFirst => {
    const modelCall = api.createModelCallAdapter({
      getApi: () => ({ profileId: 'fixture-profile', providerId: 'provider.fixture', apiKey: 'synthetic-only', baseUrl: price.canonicalOrigin, model: 'fixture-model',
        maxTokens: 16, thinking: { enabled: false, effort: 'high' }, temperature: 1, topP: 1, pricing: price }),
      buildPrefix: async () => [], getSignal: () => engine?.abortSignal(runId), getConfig: () => config,
      onProviderAttempt: attempt => {
        const event = attempt.event
        if (event.type === 'started') repo.startProviderAttempt(attemptRow(runId, attempt.logicalCallId, event.innerAttempt, event.startedAt))
        if (event.type === 'terminal') {
          assert.equal(event.usage.prompt_cache_hit_tokens, undefined)
          assert.equal(event.usage.prompt_cache_miss_tokens, undefined)
          // Same durable host outcome as index.ts when cache billing detail is absent.
          repo.finishProviderAttempt(`${attempt.logicalCallId}:${event.innerAttempt}`, terminalPatch(event.endedAt))
        }
      },
      streamChatImpl: async (_params, onEvent, _signal, _onRetry, _onAttempt, onLifecycle, beforeAttempt) => {
        await beforeAttempt(1, { bodyJson, model: 'fixture-model', maxTokens: 16 })
        requests++
        onLifecycle({ type: 'started', innerAttempt: 1, startedAt: Date.now() })
        const usage = { prompt_tokens: 10, completion_tokens: 5 }
        onEvent({ type: 'text', delta: '检查完成。' })
        onEvent({ type: 'done', finishReason: 'stop', usage })
        onLifecycle({ type: 'terminal', innerAttempt: 1, outcome: 'success', httpStatus: 200, providerRequestId: null, endedAt: Date.now(), usage })
        if (pauseAfterFirst) {
          pausePromise = engine.pause(runId)
          await new Promise(resolve => setImmediate(resolve))
        }
      }
    })
    return api.createAgentRunEngine({ store: api.createRunStorePort(repo), modelCall, toolExecutor: async () => '', getConfig: () => config,
      onEvent: () => {}, onRunUpdate: () => {} })
  }
  try {
    engine = makeEngine(true)
    await engine.start({ runId, sessionId: config.sessionId, config })
    await engine.step(runId)
    await pausePromise
    assert.equal(requests, 1)
    const first = JSON.parse(repo.getRunEvidence(runId, 'run_provider_budget_v1').json)
    assert.ok(Math.abs(first.spentCostUpper - quoteAmount) < 1e-12)
    assert.equal(first.reservedCostAttempts, 0)
    assert.equal(first.costReservations[0].amount, quoteAmount)
    assert.notEqual(first.costReservations[0].settledAt, null)
    assert.equal(repo.getProviderAttempts(runId)[0].cost_status, 'unknown')
    if (addUnboundedAttempt) {
      repo.startProviderAttempt(attemptRow(runId, 'legacy-unbounded-attempt', 1, Date.now()))
      repo.finishProviderAttempt('legacy-unbounded-attempt:1', terminalPatch(Date.now()))
    }
    // Close and reopen the real SQLite repository, then create a fresh engine.
    repo.close(); repo = api.createRepository(database); repo.open()
    engine = makeEngine(false)
    await engine.restore(runId)
    await engine.step(runId)
    const run = await engine.getState(runId)
    const ledger = JSON.parse(repo.getRunEvidence(runId, 'run_provider_budget_v1').json)
    return { requests, run: run.run, ledger, attempts: repo.getProviderAttempts(runId) }
  } finally {
    repo.close()
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('dw-cost-recovery-'))
    await fs.rm(directory, { recursive: true, force: true })
  }
}

test('real adapter → unknown cache-split attempt → durable full upper → SQLite reopen → next reserve succeeds', async () => {
  const result = await scenario(0.684196)
  assert.equal(result.requests, 2)
  assert.equal(result.run.status, 'completed')
  assert.equal(result.ledger.unknownCostCalls, 0)
  assert.equal(result.ledger.costReservations.length, 2)
  assert.ok(Math.abs(result.ledger.spentCostUpper - 2 * quoteAmount) < 1e-12)
  assert.ok(result.attempts.every(attempt => attempt.cost_status === 'unknown' && attempt.input_tokens === 10 && attempt.cache_hit_tokens === null))
})

test('SQLite-reloaded genuine cumulative cost excess stops before the second provider request', async () => {
  const result = await scenario(quoteAmount * 1.5)
  assert.equal(result.requests, 1)
  assert.equal(result.run.status, 'waiting_user'); assert.equal(result.run.errorCode, 'run_cost_budget')
  assert.equal(result.ledger.spentCostUpper, quoteAmount)
})

test('SQLite-reloaded unknown attempt without its own trusted upper still stops, despite another charged bound', async () => {
  const result = await scenario(0.684196, true)
  assert.equal(result.requests, 1)
  assert.equal(result.run.status, 'waiting_user'); assert.equal(result.run.errorCode, 'run_cost_unknown_price')
  assert.equal(result.ledger.unknownCostCalls, 1)
})
