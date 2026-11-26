import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepository, type RunRow } from '../src/main/db/repository'
import { createGrillMeState, type GrillMeState } from '../src/shared/grillMe'

let passed = 0
function ok(condition: unknown, message: string): void {
  assert.ok(condition, message)
  passed += 1
  console.log(`PASS ${message}`)
}

const makeState = (stateId: string, status: GrillMeState['status'], updatedAt: number): GrillMeState => ({
  ...createGrillMeState({
    stateId,
    sessionId: `session-${stateId}`,
    originalTask: `恢复测试：${stateId}`,
    targetChars: 4000,
    genre: '文章'
  }),
  stateId,
  status,
  updatedAt
})

const makeRun = (runId: string, stateId: string, now: number): RunRow => ({
  run_id: runId,
  session_id: `session-${stateId}`,
  status: 'queued',
  phase: 'execute',
  started_at: now,
  updated_at: now,
  config_json: JSON.stringify({ grillMe: { stateId } }),
  parent_run_id: null,
  error_code: null,
  error_message: null,
  client_request_id: null
})

const dir = mkdtempSync(join(tmpdir(), 'deepwriter-r49-grill-recovery-'))
const repo = createRepository(join(dir, 'grill.db'))
repo.open()
try {
  const now = Date.now()
  const oldConfirmed = makeState('old-confirmed', 'confirmed', now - 20)
  const latestInterview = makeState('latest-interview', 'interviewing', now - 1)
  const preferredDraft = makeState('preferred-draft', 'outline_ready', now - 50)
  const boundConfirmed = makeState('bound-confirmed', 'confirmed', now - 2)
  const cancelled = makeState('cancelled', 'cancelled', now + 1000)
  repo.saveGrillMeState(oldConfirmed)
  repo.saveGrillMeState(latestInterview)
  repo.saveGrillMeState(preferredDraft)
  repo.saveGrillMeState(boundConfirmed)
  repo.saveGrillMeState(cancelled)
  repo.createRun(makeRun('run-bound-confirmed', boundConfirmed.stateId, now))

  const first = repo.getLatestUnconsumedGrillMeState()
  ok(first?.stateId === latestInterview.stateId, '未消费恢复按 updated_at 选择最新状态，排除已有 run 绑定的 confirmed')
  ok(first?.sessionId === latestInterview.sessionId, '恢复结果携带 durable Grill sessionId')
  const preferred = repo.getLatestUnconsumedGrillMeState(preferredDraft.sessionId)
  ok(preferred?.stateId === preferredDraft.stateId, '当前会话有未消费状态时优先恢复当前会话')

  repo.createRun(makeRun('run-latest-interview', latestInterview.stateId, now + 1))
  const fallback = repo.getLatestUnconsumedGrillMeState()
  ok(fallback?.stateId === oldConfirmed.stateId, '最新采访已消费后回退到仍未消费的旧 confirmed')

  repo.saveGrillMeState({ ...latestInterview, status: 'cancelled', updatedAt: now + 2 })
  ok(repo.getLatestUnconsumedGrillMeState()?.stateId === oldConfirmed.stateId, 'cancelled 与已绑定状态都不会被恢复')
} finally {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
}

const readSource = (relativePath: string): string => readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8')
const repositorySource = readSource('src/main/db/repository.ts')
const mainSource = readSource('src/main/index.ts')
const preloadSource = readSource('src/preload/index.ts')
const composerSource = readSource('src/renderer/src/components/Composer.tsx')
const storeSource = readSource('src/renderer/src/store.ts')
ok(repositorySource.includes('getLatestUnconsumedGrillMeState'), 'repository 暴露只读未消费 Grill 查询')
ok(mainSource.includes("registerIpc('grill:latestUnconsumed'"), 'main 注册跨重启 Grill 恢复 IPC')
ok(preloadSource.includes('grillLatestUnconsumed'), 'preload 暴露跨重启 Grill 恢复桥')
ok(composerSource.includes('grillLatestUnconsumed'), '长文页进入时查询 durable 未消费 Grill 状态')
ok(composerSource.includes('restoreGrillSession'), '恢复状态绑定 renderer currentSessionId')
ok(storeSource.includes('restoreGrillSession:'), 'store 提供 durable Grill session 恢复动作')

console.log(`R49 Grill recovery ${passed} PASS`)
