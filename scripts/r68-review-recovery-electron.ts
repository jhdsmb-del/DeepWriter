import { desktopSourceExternals } from './desktop-source-boundary.mjs'
// R68 WP0-C：语义复核恢复的真实 Electron/IPC 运行态交叉验证。
//
// 本脚本不读取源码字符串作断言。它先用真实 AgentRunEngine 在临时 userData
// 中构造一个 waiting_user/narrative_state_pending_review 证据，再启动构建后的
// Electron 主进程，所有恢复、主进程操作身份、Renderer reload/recreate 和拒绝
// 决策均走真实 preload IPC。fixture 只替代了 chat:start 的前置写作，以便把
// 测试焦点限定在 WP0-C 的恢复边界；Provider 端点始终是本地悬挂 SSE，不联网。
//
// 运行（先保证 out/main/index.js 是当前构建）：
//   npx esbuild scripts/r68-review-recovery-electron.ts --bundle --format=esm --platform=node --outfile=out/r68-review-recovery-electron.mjs --external:@playwright/test --external:node:sqlite
//   node out/r68-review-recovery-electron.mjs

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { execFileSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { grillMeOutlineHash, type GrillMeOutline } from '../src/shared/grillMe'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
    return
  }
  failed += 1
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function exactProse(length: number, prefix: string, seed: number): string {
  const points = Array.from(prefix)
  while (points.length < length - 1) points.push(String.fromCodePoint(0x20000 + seed + points.length))
  points.length = Math.max(0, length - 1)
  points.push('。')
  return points.join('')
}

const ELECTRON_SHIM = {
  name: 'r68-electron-shim',
  setup(build: {
    onResolve(options: unknown, callback: (result: { path: string; namespace: string }) => unknown): void
    onLoad(options: unknown, callback: () => unknown): void
  }): void {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
    build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
      contents: [
        'export const app={getPath:(name)=>String(name),isPackaged:false};',
        'export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]}),showSaveDialog:async()=>({canceled:true}),showMessageBox:async()=>({response:0})};',
        'export const ipcMain={handle:()=>undefined,on:()=>undefined};',
        'export const safeStorage={isEncryptionAvailable:()=>false,encryptString:()=>null,decryptString:()=>""};',
        'export const shell={openExternal:()=>undefined,openPath:async()=>""};',
        'export const clipboard={writeText:()=>undefined};',
        'export const Menu={buildFromTemplate:(template)=>({popup:()=>undefined,template})};'
      ].join('\n'),
      loader: 'js'
    }))
  }
}

async function loadTsModule(relativePath: string): Promise<Record<string, unknown>> {
  const outfile = path.join(os.tmpdir(), `dw-r68-module-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await esbuild.build({
    entryPoints: [path.join(ROOT, relativePath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: true,
    outfile,
    external: desktopSourceExternals(path.join(ROOT, relativePath), ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite']),
    logLevel: 'silent',
    plugins: [ELECTRON_SHIM]
  })
  try {
    return await import(url.pathToFileURL(outfile).href) as Record<string, unknown>
  } finally {
    await fsp.unlink(outfile).catch(() => undefined)
  }
}

/**
 * Load the production Zustand store into the real renderer as a test-only
 * second instance. This gives the test a controllable owner state while its
 * calls to `window.ds` still cross the actual contextBridge and main IPC.
 */
async function buildRendererStoreProbe(): Promise<string> {
  const result = await esbuild.build({
    stdin: {
      contents: "import { useStore } from './src/renderer/src/store.ts'; window.__r68InjectedStore = useStore;",
      resolveDir: ROOT,
      sourcefile: 'r68-renderer-store-probe.ts'
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent'
  }) as { outputFiles?: Array<{ contents: Uint8Array }> }
  const bytes = result.outputFiles?.[0]?.contents
  if (!bytes) throw new Error('无法构建 renderer store probe')
  return new TextDecoder().decode(bytes)
}

type RepositoryLike = {
  open(): void
  close(): void
  createRun(run: Record<string, unknown>): void
  getRun(runId: string): Record<string, unknown> | null
  getRunEvidence(runId: string, kind: string): { json: string } | null
  getNarrativeCommits(runId: string, sceneId?: string): Array<Record<string, unknown>>
}

type EngineLike = {
  start(input: { sessionId: string; runId: string; config: Record<string, unknown> }): Promise<{ ok: boolean }>
  step(runId: string): Promise<void>
  getState(runId: string): Promise<{ run: Record<string, unknown> | null }>
}

/** Build a real durable pending-review row without using the production IPC as a fixture shortcut. */
async function createPendingFixture(userDataDir: string): Promise<{ runId: string; dbPath: string; otherRunId: string }> {
  const [snapshotMod, repoMod, portMod, engineMod] = await Promise.all([
    loadTsModule('src/main/executionSnapshot.ts'),
    loadTsModule('src/main/db/repository.ts'),
    loadTsModule('src/main/runKernelAdapter.ts'),
    loadTsModule('src/main/jobs/AgentRunEngine.ts')
  ])
  const buildExecutionSnapshot = snapshotMod.buildExecutionSnapshot as (input: Record<string, unknown>) => Record<string, unknown>
  const createRepository = repoMod.createRepository as (dbPath: string) => RepositoryLike
  const createRunStorePort = portMod.createRunStorePort as (repository: unknown, artifactDir: string) => Record<string, unknown>
  const createAgentRunEngine = engineMod.createAgentRunEngine as (input: Record<string, unknown>) => EngineLike

  const runId = 'r68-electron-pending-review'
  const sessionId = 'r68-electron-session'
  const targetChars = 360
  const outline: GrillMeOutline = {
    title: '雾港交接',
    premise: '守灯人抵达灯塔，在暴雨前完成钥匙交接。',
    targetChars,
    sections: [{
      id: 's1',
      title: '灯塔夜班',
      purpose: '完成交接并留下可承接的决定。',
      targetChars,
      beats: ['林舟抵达灯塔', '林舟把钥匙交给沈遥'],
      sourceSlotIds: ['goal', 'characters', 'setting', 'mustKeep'],
      scenes: [{
        id: 'arrival',
        title: '抵达与交接',
        purpose: '林舟抵达灯塔并完成钥匙交接。',
        targetChars,
        beats: ['林舟抵达灯塔', '林舟把钥匙交给沈遥'],
        sourceSlotIds: ['goal', 'characters', 'setting', 'mustKeep']
      }]
    }]
  }
  const outlineHash = grillMeOutlineHash(outline)
  const answers = [
    { slotId: 'goal', value: '完成有代价的灯塔交接', source: 'user' },
    { slotId: 'characters', value: '林舟、沈遥', source: 'user' },
    { slotId: 'setting', value: '雾港灯塔', source: 'user' },
    // This is intentionally malformed confirmed state. The production engine
    // must pause for review instead of writing a guessed empty delta.
    { slotId: 'mustKeep', value: 'narrative-fact: {not-json}', source: 'user' }
  ]
  const settings = {
    model: 'deepseek-v4-flash',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'fixture-only',
    maxTokens: 4096,
    temperature: 0.7,
    topP: 1,
    thinkingEnabled: false,
    reasoningEffort: 'medium',
    workDir: path.join(userDataDir, 'fixture-work'),
    docDir: path.join(userDataDir, 'fixture-docs'),
    novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' },
    historyBudgetTokens: 60000,
    strongConstraintEnabled: false,
    strongConstraintLevel: 'balanced',
    themeLockMode: 'off',
    expressionFreedom: 'high',
    antiMoralizingEnabled: true
  }
  const config = buildExecutionSnapshot({
    payload: {
      id: runId,
      mode: 'longwrite',
      workspace: 'novel',
      phase: 'execute',
      longMode: true,
      targetChars,
      text: '请依据已确认大纲完成当前场景。',
      grillMe: {
        stateId: 'r68-grill-state',
        originalTask: '写一篇雾港灯塔交接小说。',
        targetChars,
        answers,
        assumptions: [],
        approvedOutline: outline,
        outlineRevision: 1,
        outlineHash
      },
      strongConstraints: { enabled: false }
    },
    settings,
    sessionId,
    memory: { projectPath: '', projectContent: '', userContent: '' }
  })
  const dbPath = path.join(userDataDir, 'deepwriter.db')
  const otherRunId = 'r68-other-active-run'
  const repo = createRepository(dbPath)
  repo.open()
  const store = createRunStorePort(repo, path.join(userDataDir, 'fixture-artifacts'))
  const prose = exactProse(targetChars, '林舟抵达灯塔，林舟把钥匙交给沈遥。', 5000)
  let providerCalls = 0
  const engine = createAgentRunEngine({
    store,
    modelCall: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>> {
        providerCalls += 1
        yield { type: 'text', delta: prose }
        yield { type: 'finish', finishReason: 'stop' }
      }
    }),
    toolExecutor: async () => '',
    getConfig: () => config,
    onEvent: () => undefined,
    onRunUpdate: () => undefined,
    publishLongwriteArtifact: async () => ({ displayName: 'r68-pending.md', relativePath: 'r68-pending.md' })
  })
  try {
    const started = await engine.start({ sessionId, runId, config })
    if (!started.ok) throw new Error('fixture engine.start returned ok=false')
    try {
      await engine.step(runId)
    } catch {
      // Expected: malformed confirmed state is a durable review boundary.
    }
    const state = await engine.getState(runId)
    const row = repo.getRun(runId)
    const evidence = repo.getRunEvidence(runId, 'narrative_semantic_review')
    if (providerCalls !== 1 || state.run?.status !== 'waiting_user' || state.run?.errorCode !== 'narrative_state_pending_review' || !evidence) {
      throw new Error(`fixture did not produce a pending review: ${JSON.stringify({ providerCalls, state: state.run, row, evidence: Boolean(evidence) })}`)
    }
    // This second durable row is intentionally still active. The injected
    // renderer probe below starts with this run as its UI owner, then asks the
    // real store's recovery path to restore the pending review. It verifies
    // the owner guard without inventing a parallel app or bypassing IPC.
    repo.createRun({
      run_id: otherRunId,
      session_id: 'r68-other-session',
      status: 'running',
      phase: 'thinking',
      started_at: Date.now(),
      updated_at: Date.now(),
      config_json: JSON.stringify({ storyScope: { schemaVersion: 1, storyId: 'r68-other-story', projectId: 'r68-other-project', branchId: 'main' } }),
      parent_run_id: null,
      error_code: null,
      error_message: null,
      client_request_id: null
    })
  } finally {
    repo.close()
  }
  return { runId, dbPath, otherRunId }
}

type HeldMock = { server: http.Server; port: number; readonly calls: number; close(): Promise<void> }

/** Local SSE never sends DONE. It keeps a normal user run active during the renderer race. */
async function startHeldMock(): Promise<HeldMock> {
  let callCount = 0
  const server = http.createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => {
      callCount += 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const chunk = { id: 'r68-held', choices: [{ index: 0, delta: { role: 'assistant', content: '正在保持另一个任务运行' }, finish_reason: null }], usage: null }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      // Deliberately keep this response open. App teardown uses the exact app PID.
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return {
    server,
    port: address.port,
    get calls(): number { return callCount },
    async close(): Promise<void> {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

async function writeSettings(userDataDir: string, port: number): Promise<void> {
  await fsp.mkdir(userDataDir, { recursive: true })
  const settings = {
    apiKey: 'r68-local-only',
    userPresetPrompt: '',
    model: 'deepseek-v4-flash',
    baseUrl: `http://127.0.0.1:${port}`,
    thinkingEnabled: false,
    reasoningEffort: 'medium',
    temperature: 0.7,
    topP: 1,
    maxTokens: 1024,
    toolsEnabled: false,
    docDir: path.join(userDataDir, 'docs'),
    historyBudgetTokens: 60000,
    workDir: path.join(userDataDir, 'work'),
    planMode: false,
    permissionMode: 'safe',
    novelMode: false,
    galgame: { enabled: false, projectDir: '', sdkPath: '' },
    completionTokenBudget: 200000,
    completionWallClockMs: 0,
    strongConstraintEnabled: false,
    strongConstraintLevel: 'balanced',
    themeLockMode: 'off',
    expressionFreedom: 'high',
    antiMoralizingEnabled: true,
    strongConstraintPerspective: 'auto',
    strongConstraintGenre: '',
    strongConstraintMustKeep: '',
    strongConstraintAvoid: ''
  }
  await fsp.writeFile(path.join(userDataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
}

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const mainEntry = path.join(ROOT, 'out', 'main', 'index.js')
  if (!(await fsp.stat(mainEntry).catch(() => null))) throw new Error(`构建缺失：${mainEntry}`)
  const app = await electron.launch({
    args: [mainEntry],
    env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userDataDir }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.composer', { timeout: 20000 })
  return { app, page }
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 15000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  let last: T | null = null
  while (Date.now() < deadline) {
    last = await read()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return last
}

async function killApp(app: ElectronApplication): Promise<void> {
  const pid = app.process().pid
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
  } catch {
    // The process may already be gone; the exact PID was still the only target.
  }
  await app.close().catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 800))
}

async function readReview(page: Page, runId: string): Promise<Record<string, any> | null> {
  const value = await page.evaluate(async (id: string) => (window as any).ds.runsNarrativeReview(id), runId).catch(() => null)
  return value && typeof value === 'object' ? value.review ?? null : null
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.error('R68 WP0-C 需要 Windows Electron 运行态（当前平台不满足）')
    process.exitCode = 2
    return
  }
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r68-electron-'))
  const mock = await startHeldMock()
  let app: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  try {
    await writeSettings(userDataDir, mock.port)
    const fixture = await createPendingFixture(userDataDir)
    const { app: firstApp, page } = await launchApp(userDataDir)
    app = firstApp

    console.log('\n[R68-C1] 主进程 authority + disabled action（真实 IPC）')
    const initialReview = await waitFor(
      () => readReview(page, fixture.runId),
      (review) => Boolean(review?.status === 'pending_review' && review?.pendingOperation?.operationId),
      15000
    )
    check('主进程 IPC 返回 pending_review + main-issued operation', Boolean(initialReview?.status === 'pending_review' && initialReview?.pendingOperation?.operationId), JSON.stringify(initialReview))
    const operationId = String(initialReview?.pendingOperation?.operationId ?? '')
    const revision = Number(initialReview?.revision ?? 0)
    check('operation ID 具备主进程前缀且非 Renderer UUID', operationId.startsWith('nreview_') && operationId.length > 16, operationId)

    const resumed = await page.evaluate(async (id: string) => (window as any).ds.runsResume(id), fixture.runId).catch((error) => ({ ok: false, error: String(error) })) as Record<string, any>
    check('runs:resume 真实 IPC 自动恢复仍停在 waiting_user', resumed.ok === true && resumed.waitingUser === true && resumed.semanticReview?.pendingOperation?.operationId === operationId, JSON.stringify(resumed))
    const reviewAfterResume = resumed.semanticReview ?? initialReview
    const disabledCapability = reviewAfterResume?.allowedDecisions?.accept_prose_no_state
    check('主进程权威 capability 禁止当前证据的 accept_prose_no_state', disabledCapability?.allowed === false, JSON.stringify(disabledCapability))

    await page.waitForTimeout(500)
    const disabledButtons = await page.getByRole('button', { name: '接受正文而不写入状态' }).count().catch(() => 0)
    check('Renderer 不渲染 disabled 决策按钮（UI 不发送）', disabledButtons === 0, `count=${disabledButtons}`)
    const rejectedDisabled = await page.evaluate(async (input: Record<string, unknown>) => {
      try {
        return await (window as any).ds.runsNarrativeReviewDecide(input)
      } catch (error) {
        return { ok: false, error: String((error as { message?: string })?.message ?? error) }
      }
    }, { runId: fixture.runId, decision: 'accept_prose_no_state', expectedRevision: revision, decisionId: operationId }) as Record<string, any>
    check('disabled action 经真实 IPC 在 provider/commit 前被拒绝', rejectedDisabled.ok === false && /not_allowed|不允许|正文而不写入状态/i.test(String(rejectedDisabled.error)), JSON.stringify(rejectedDisabled))
    check('disabled action 未触发本地 Provider', mock.calls === 0, `calls=${mock.calls}`)

    console.log('\n[R68-C2] Renderer reload 时 pending review 不抢占 other active run')
    // Use the production store module in a second real renderer-side instance.
    // Its IPC calls are not mocked: the pending packet and the unrelated
    // active row are both read from the live Electron main process.
    const rendererStoreProbe = await buildRendererStoreProbe()
    await page.reload()
    await page.waitForSelector('.composer', { timeout: 20000 })
    // The production renderer intentionally disallows inline scripts via CSP.
    // Playwright's execution context is the test's explicit browser control
    // seam and does not weaken the page policy or modify the shipped bundle.
    await page.evaluate((bundle) => {
      // eslint-disable-next-line no-eval
      ;(0, eval)(bundle)
    }, rendererStoreProbe)
    const injected = await page.evaluate(() => Boolean((window as any).__r68InjectedStore?.getState)).catch(() => false)
    check('真实 Renderer 可加载生产 store probe', injected)
    const storeState = await page.evaluate(async (input: { pendingRunId: string; otherRunId: string }) => {
      const store = (window as any).__r68InjectedStore
      store.setState({ running: true, runningId: input.otherRunId, activeRunId: input.otherRunId, narrativeReview: null })
      await store.getState().loadRecoverable()
      const afterFirst = store.getState()
      await store.getState().loadRecoverable()
      const afterSecond = store.getState()
      return {
        first: { running: afterFirst.running, runningId: afterFirst.runningId, activeRunId: afterFirst.activeRunId, reviewRunId: afterFirst.narrativeReview?.runId ?? null },
        second: { running: afterSecond.running, runningId: afterSecond.runningId, activeRunId: afterSecond.activeRunId, reviewRunId: afterSecond.narrativeReview?.runId ?? null },
        recoverable: afterSecond.recoverableRuns
      }
    }, { pendingRunId: fixture.runId, otherRunId: fixture.otherRunId }).catch((error) => ({ error: String(error) }))
    const statePayload = storeState as Record<string, any>
    check('Renderer 启动自动恢复不抢占 other active owner', statePayload.first?.running === true && statePayload.first?.runningId === fixture.otherRunId && statePayload.first?.reviewRunId === fixture.runId, JSON.stringify(statePayload.first))
    check('重复 Renderer 恢复保持 owner 与 review 稳定', statePayload.second?.running === true && statePayload.second?.runningId === fixture.otherRunId && statePayload.second?.reviewRunId === fixture.runId, JSON.stringify(statePayload.second))
    check('真实 main IPC 同时返回 pending 与 other active run', Array.isArray(statePayload.recoverable) && statePayload.recoverable.some((run: any) => run.runId === fixture.runId && run.status === 'waiting_user') && statePayload.recoverable.some((run: any) => run.runId === fixture.otherRunId && run.status === 'running'), JSON.stringify(statePayload.recoverable))

    console.log('\n[R68-C3] 精确 PID 重启 + operation/commit/provider 不重复')
    await killApp(app)
    app = null
    const relaunched = await launchApp(userDataDir)
    secondApp = relaunched.app
    const page2 = relaunched.page
    const restartedReview = await waitFor(
      () => readReview(page2, fixture.runId),
      (review) => Boolean(review?.status === 'pending_review' && review?.pendingOperation?.operationId),
      15000
    )
    check('重启后主进程仍恢复同一 pending review', restartedReview?.status === 'pending_review', JSON.stringify(restartedReview))
    check('重启后沿用同一个 main-issued operation ID', restartedReview?.pendingOperation?.operationId === operationId && restartedReview?.pendingOperation?.decisionId === operationId, JSON.stringify(restartedReview?.pendingOperation))
    const resumeAgain = await page2.evaluate(async (id: string) => (window as any).ds.runsResume(id), fixture.runId).catch((error) => ({ ok: false, error: String(error) })) as Record<string, any>
    const resumeAgain2 = await page2.evaluate(async (id: string) => (window as any).ds.runsResume(id), fixture.runId).catch((error) => ({ ok: false, error: String(error) })) as Record<string, any>
    check('重启后重复恢复仍是 waiting_user，未偷偷 step', resumeAgain.ok === true && resumeAgain.waitingUser === true && resumeAgain2.ok === true && resumeAgain2.waitingUser === true, JSON.stringify({ first: resumeAgain, second: resumeAgain2 }))
    // This scenario only recovers a durable review boundary. It must not
    // resume/step the unrelated active row, so the held provider sees no
    // request before or after either repeated recovery call.
    check('重复恢复没有调用 Provider', mock.calls === 0, `calls=${mock.calls}`)
    const restartedOperation = String(resumeAgain.semanticReview?.pendingOperation?.operationId ?? restartedReview?.pendingOperation?.operationId ?? '')
    const rejectedAfterRestart = await page2.evaluate(async (input: Record<string, unknown>) => {
      try {
        return await (window as any).ds.runsNarrativeReviewDecide(input)
      } catch (error) {
        return { ok: false, error: String((error as { message?: string })?.message ?? error) }
      }
    }, { runId: fixture.runId, decision: 'accept_prose_no_state', expectedRevision: revision, decisionId: restartedOperation }) as Record<string, any>
    check('重启后 disabled action 仍被 authority 拒绝', rejectedAfterRestart.ok === false, JSON.stringify(rejectedAfterRestart))

    await killApp(secondApp)
    secondApp = null
    const [repoMod] = await Promise.all([loadTsModule('src/main/db/repository.ts')])
    const createRepository = repoMod.createRepository as (dbPath: string) => RepositoryLike
    const verifyRepo = createRepository(fixture.dbPath)
    verifyRepo.open()
    try {
      const pendingRow = verifyRepo.getRun(fixture.runId)
      const commits = verifyRepo.getNarrativeCommits(fixture.runId)
      check('重启恢复后 DB 仍保留 waiting_user pending 边界', pendingRow?.status === 'waiting_user' && pendingRow?.error_code === 'narrative_state_pending_review', JSON.stringify(pendingRow))
      check('重复恢复未产生 scene commit', commits.length === 0, JSON.stringify(commits))
    } finally {
      verifyRepo.close()
    }
  } catch (error) {
    check('R68 Electron harness 未发生未声明异常', false, String((error as Error)?.stack ?? error))
  } finally {
    if (secondApp) await killApp(secondApp)
    else if (app) await killApp(app)
    await mock.close().catch(() => undefined)
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\n===== R68 WP0-C Electron：${passed} PASS / ${failed} FAIL =====`)
  if (failures.length) {
    console.log('红灯明细：')
    for (const failure of failures) console.log(`  - ${failure}`)
  }
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('R68 WP0-C Electron 执行异常：', error)
  process.exitCode = 2
})
