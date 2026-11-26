// ==================== R4.6 Gate 5（复审退回整改）：六状态优雅退出验证 ====================
// 落实复审 G5-R01~R08：
//  R04 mock.calls 用 getter（值快照不再失真）
//  R05 主窗口隐藏/悬浮窗可见经 ElectronApplication 主进程 API 建立并断言
//  R06 工具运行中：run_command 无限 ping（真实可追踪子进程），断言 tool running + 子进程存在，
//      退出后 child_process_tree_terminated 带实际 killed 数
//  R07 close promise 在触发 shutdown 前创建；graceful/timeout/fallback-kill 三分；fallback 必须 FAIL
//  R08 每场景原始 trace/前置快照/结果复制到 docs/r46-g5-report/（清理临时 userData 前）
// 六场景强制前置：idle（无 active run+主窗口存在）/streaming（active run+流未结束）/
//  tool-running（tool running+子进程活动）/waiting-user（phase=waiting_user）/
//  floating-window（悬浮窗存在且可见）/main-hidden（主窗口隐藏+悬浮窗可见）
// 任何 fallback kill → 该场景 FAIL（不记为 graceful PASS）

import * as path from 'node:path'
import * as url from 'node:url'
import * as http from 'node:http'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { execSync } from 'node:child_process'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const REPORT_DIR = path.join(ROOT, 'docs', 'r46-g5-report-r13')

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** G5-R04：mock 用 getter（内部计数实时可见） */
interface MockModel {
  server: http.Server
  port: number
  readonly calls: number
}

async function startSlowMock(firstLen: number, secondLen = 0): Promise<MockModel> {
  let callCount = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.url?.includes('/chat/completions') && req.method === 'POST') {
        callCount++
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const write = (data: unknown): void => res.write(`data: ${JSON.stringify(data)}\n\n`)
        const content = callCount === 1 ? 'x'.repeat(firstLen) : 'y'.repeat(secondLen || firstLen)
        const chunks: string[] = []
        for (let i = 0; i < content.length; i += 2000) chunks.push(content.slice(i, i + 2000))
        let ci = 0
        const timer = setInterval(() => {
          if (ci < chunks.length) {
            write({ id: 'm', choices: [{ index: 0, delta: { content: chunks[ci], role: 'assistant' }, finish_reason: null }], usage: null })
            ci++
            return
          }
          clearInterval(timer)
          write({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } })
          res.write('data: [DONE]\n\n')
          res.end()
        }, 500)
      } else {
        res.writeHead(404).end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as { port: number }).port, get calls() { return callCount } }
}

/** 工具调用 mock：第一轮 run_command（无限 ping——真实子进程），第二轮文本 */
async function startToolMock(): Promise<MockModel> {
  let callCount = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.url?.includes('/chat/completions') && req.method === 'POST') {
        callCount++
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const write = (data: unknown): void => res.write(`data: ${JSON.stringify(data)}\n\n`)
        if (callCount === 1) {
          write({ id: 'm', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'tc_g5_tool', type: 'function', function: { name: 'mock_tracked_child_tool', arguments: JSON.stringify({}) } }] }, finish_reason: null }], usage: null })
          write({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } })
        } else {
          write({ id: 'm', choices: [{ index: 0, delta: { content: '完成', role: 'assistant' }, finish_reason: null }], usage: null })
          write({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } })
        }
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(404).end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as { port: number }).port, get calls() { return callCount } }
}

async function launchApp(userDataDir: string, mockPort: number, nodeEnv = 'test'): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: nodeEnv, DW_TEST_USERDATA: userDataDir, ...(nodeEnv === 'test' ? { DW_TEST_PRICING_ORIGIN: `http://127.0.0.1:${mockPort}` } : {}) }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.composer', { timeout: 15000 })
  await page.evaluate(async (p: number) => {
    const ds = (window as any).ds
    const cur = await ds.getSettings()
    await ds.setSettings({ ...cur, baseUrl: `http://127.0.0.1:${p}` })
    await ds.setSettings({ ...(await ds.getSettings()), apiKey: 'e2e-key' })
  }, mockPort)
  await page.waitForTimeout(300)
  return { app, page }
}

// 实际顺序：协调器 cancel→abort→child→db close→close 窗口（windows_close_requested→window_close_received）
// →app.quit()（before_quit）→will-quit（windows_closed_settled→app_quit_completed；window-all-closed 在
// quit 流程中不触发，settled 由 will-quit 记录——Electron 43 实测行为）
const TRACE_SEQ_WITH_RUN = ['active_run_cancel_requested', 'stream_tool_abort_settled', 'CHILD', 'db_checkpoint_close_completed', 'windows_close_requested', 'window_close_received', 'before_quit', 'windows_closed_settled', 'app_quit_completed']
const TRACE_SEQ_IDLE = ['stream_tool_abort_settled', 'CHILD', 'db_checkpoint_close_completed', 'windows_close_requested', 'window_close_received', 'before_quit', 'windows_closed_settled', 'app_quit_completed']
const childSeq = (expected: 'none' | 'terminated'): string[] => (expected === 'none' ? ['child_process_none'] : ['child_process_tree_terminated'])
function fillChild(seq: string[], expected: 'none' | 'terminated'): string[] { return seq.map((e) => (e === 'CHILD' ? (expected === 'none' ? 'child_process_none' : 'child_process_tree_terminated') : e)) }

/**
 * R11（R10-R03 §5.3）+ R12（R11-R04）：结构化严格 trace 校验——按阶段计数 + 精确窗口 ID 集合 + 顺序。
 * 规则：shutdown_requested ≤1；active_run_cancel_requested 活动场景恰 1 / idle 0；
 * stream_tool_abort_settled 恰 1；child 恰 1（none 或 terminated，工具场景必须 terminated 且 meta 完整）；
 * db_checkpoint_close_completed 恰 1；windows_close_requested 恰 1（winIds=预期集合）；
 * window_close_received 每个预期 winId 恰 1；before_quit 恰 1；windows_closed_settled 恰 1（winIds=预期）；
 * app_quit_completed 恰 1；未知/重复/错误事件（shutdown_error/db_close_failed/
 * stream_tool_abort_timeout/windows_closed_timeout）FAIL；阶段顺序按规范。
 */
function traceStrictPass(
  trace: Array<{ event: string; meta?: Record<string, unknown> }>,
  opts: {
    expectActiveRun: boolean
    requireChildTerminated: boolean
    expectedWindowIds: number[]
  }
): { ok: boolean; reason: string } {
  const forbidden = ['shutdown_error', 'db_close_failed', 'stream_tool_abort_timeout', 'windows_closed_timeout']
  const events = trace.map((e) => e.event)
  for (const ev of events) {
    if (forbidden.includes(ev)) return { ok: false, reason: 'forbidden:' + ev }
  }
  // 阶段计数（每事件类型恰好一次；window_close/shutdown_requested 特殊）
  const count = (ev: string): number => events.filter((e) => e === ev).length
  if (count('stream_tool_abort_settled') !== 1) return { ok: false, reason: 'abort_settled count=' + count('stream_tool_abort_settled') }
  if (count('db_checkpoint_close_completed') !== 1) return { ok: false, reason: 'db_close count=' + count('db_checkpoint_close_completed') }
  if (count('windows_close_requested') !== 1) return { ok: false, reason: 'windows_close_requested count=' + count('windows_close_requested') }
  if (count('windows_closed_settled') !== 1) return { ok: false, reason: 'windows_closed_settled count=' + count('windows_closed_settled') }
  if (count('before_quit') !== 1) return { ok: false, reason: 'before_quit count=' + count('before_quit') }
  if (count('app_quit_completed') !== 1) return { ok: false, reason: 'app_quit count=' + count('app_quit_completed') }
  if (count('shutdown_requested') !== 1) return { ok: false, reason: 'shutdown_requested count=' + count('shutdown_requested') }
  if (opts.expectActiveRun) {
    if (count('active_run_cancel_requested') !== 1) return { ok: false, reason: 'cancel count=' + count('active_run_cancel_requested') }
  } else if (count('active_run_cancel_requested') !== 0) {
    return { ok: false, reason: 'idle 不应有 cancel' }
  }
  // child 事件：恰好一个（none 或 terminated）
  const childEvs = events.filter((e) => e.startsWith('child_process'))
  if (childEvs.length !== 1) return { ok: false, reason: 'child count=' + childEvs.length }
  if (opts.requireChildTerminated) {
    if (childEvs[0] !== 'child_process_tree_terminated') return { ok: false, reason: 'child=' + childEvs[0] }
    const meta = trace.find((e) => e.event === 'child_process_tree_terminated')?.meta ?? {}
    const killed = meta.killed as number | undefined
    const remaining = meta.remaining as number | undefined
    if (typeof killed !== 'number' || killed < 1 || typeof remaining !== 'number' || remaining !== 0) {
      return { ok: false, reason: 'child meta killed=' + String(killed) + ' remaining=' + String(remaining) }
    }
  } else if (childEvs[0] !== 'child_process_none') {
    return { ok: false, reason: 'child=' + childEvs[0] }
  }
  // window close：每个预期 winId 恰好一次（多窗口集合精确）
  const closedWinIds = trace.filter((e) => e.event === 'window_close_received').map((e) => e.meta?.winId).filter((v): v is number => typeof v === 'number')
  const expected = [...opts.expectedWindowIds].sort((a, b) => a - b)
  const closed = [...closedWinIds].sort((a, b) => a - b)
  if (closed.length !== expected.length || closed.some((v, i) => v !== expected[i])) {
    return { ok: false, reason: 'window closed=' + JSON.stringify(closed) + ' expected=' + JSON.stringify(expected) }
  }
  // R12：windows_close_requested/settled 的 winIds 集合必须与预期一致（冻结目标 = 实际关闭目标）
  for (const phase of ['windows_close_requested', 'windows_closed_settled'] as const) {
    const ids = trace.find((e) => e.event === phase)?.meta?.winIds
    if (!Array.isArray(ids) || ids.length !== expected.length || [...ids].sort((a, b) => (a as number) - (b as number)).some((v, i) => v !== expected[i])) {
      return { ok: false, reason: phase + ' winIds=' + JSON.stringify(ids) + ' expected=' + JSON.stringify(expected) }
    }
  }
  // 顺序：阶段按规范（windows_close_requested→window_close_received→before_quit→windows_closed_settled→
  // app_quit_completed；settled 由 will-quit 记录——window-all-closed 在 quit 流程中不触发）
  const orderSeq = opts.expectActiveRun
    ? ['shutdown_requested', 'active_run_cancel_requested', 'stream_tool_abort_settled', 'CHILD', 'db_checkpoint_close_completed', 'windows_close_requested', 'window_close_received', 'before_quit', 'windows_closed_settled', 'app_quit_completed']
    : ['shutdown_requested', 'stream_tool_abort_settled', 'CHILD', 'db_checkpoint_close_completed', 'windows_close_requested', 'window_close_received', 'before_quit', 'windows_closed_settled', 'app_quit_completed']
  let idx = 0
  const windowDone = new Set<number>()
  for (const ev of trace) {
    if (ev.event === 'window_close_received') {
      const winId = ev.meta?.winId
      if (typeof winId !== 'number') return { ok: false, reason: 'window close 无 winId' }
      if (windowDone.has(winId)) return { ok: false, reason: 'window close 重复 winId=' + winId }
      windowDone.add(winId)
      if (idx < orderSeq.length && orderSeq[idx] === 'window_close_received') idx++
      else if (idx > 0 && orderSeq[idx - 1] === 'window_close_received') { /* 多窗口聚合：不推进 */ }
      else return { ok: false, reason: 'window close 越序（seq idx ' + idx + '）' }
      continue
    }
    const step = orderSeq[idx]
    const isChild = ev.event.startsWith('child_process')
    if (isChild && (step === 'CHILD' || orderSeq[idx - 1] === 'CHILD')) {
      if (step === 'CHILD') idx++
      continue
    }
    if (ev.event === step) {
      idx++
      continue
    }
    // seq 匹配完成后（idx>=len）的任何非 window_close 事件 → FAIL（未知/重复）
    if (idx >= orderSeq.length) return { ok: false, reason: 'seq 后未知事件: ' + ev.event }
    return { ok: false, reason: '越序/未知: ' + ev.event + '（seq idx ' + idx + '，期望 ' + String(orderSeq[idx]) + '）' }
  }
  if (idx < orderSeq.length) return { ok: false, reason: 'missing:' + orderSeq.slice(idx).join(',') }
  return { ok: true, reason: '' }
}

interface GracefulResult {
  graceful: boolean
  outcome: 'natural_graceful_close' | 'forced_cleanup' | 'timeout'
  trace: Array<{ at: number; event: string; meta?: Record<string, unknown> }> | null
  killed: boolean
}

/** G5-R07：close promise 在触发 shutdown 前创建；三分结果；fallback kill 必须 FAIL */
async function gracefulClose(app: ElectronApplication, page: Page, ud: string, scenario: string, runDir: string, timeoutMs = 60000): Promise<GracefulResult> {
  const tracePath = path.join(ud, 'shutdown-trace.json')
  // R12 诊断：收集主进程 stdout（协调器阶段时间戳），随报告留存
  const stdoutChunks: string[] = []
  app.process().stdout?.on('data', (d) => stdoutChunks.push(String(d)))
  const closePromise = app.waitForEvent('close', { timeout: timeoutMs + 3000 }).then(() => true).catch(() => false)
  // Trigger the real production entry. The previous test-only IPC entered the coordinator
  // directly and therefore could not detect before-quit re-entrancy regressions.
  const evalRet = await app
    .evaluate((electronMod: typeof import('electron')) => {
      electronMod.app.quit()
      return 'app.quit-called'
    })
    .catch((e: unknown) => 'evaluate-error: ' + String(e))
  const pid = app.process().pid
  const closed = await closePromise
  let trace: Array<{ at: number; event: string; meta?: Record<string, unknown> }> | null = null
  try {
    trace = JSON.parse(await fsp.readFile(tracePath, 'utf-8'))
  } catch {
    /* trace 未就绪（可能未写） */
  }
  let outcome: GracefulResult['outcome'] = 'timeout'
  let killed = false
  if (closed && trace) {
    outcome = 'natural_graceful_close'
  } else {
    try {
      if (process.platform === 'win32') execSync('taskkill /F /T /PID ' + pid, { stdio: 'ignore' })
      else process.kill(pid, 'SIGKILL')
      killed = true
      outcome = 'forced_cleanup'
    } catch {
      outcome = 'timeout'
    }
  }
  // R12（R11-R03）：报告目录版本化——docs/r46-g5-report-r12/run-<NN>/<scenario>/，不覆盖旧轮次；
  // manifest 含 commit/bundle hash/Electron/Node/平台（供复算与追溯）
  const reportDir = path.join(runDir, scenario)
  await fsp.mkdir(reportDir, { recursive: true })
  try {
    if (trace) await fsp.writeFile(path.join(reportDir, 'shutdown-trace.json'), JSON.stringify(trace, null, 2), 'utf-8')
    await fsp.writeFile(path.join(reportDir, 'outcome.json'), JSON.stringify({ scenario, outcome, killed, evalRet, pid, at: Date.now() }, null, 2), 'utf-8')
    // R12（R11-R04）：协调器实时进度（recordShutdown 每步落盘）——will-quit 未触发时诊断卡点
    try {
      const prog = JSON.parse(await fsp.readFile(path.join(ud, 'shutdown-trace-progress.json'), 'utf-8'))
      await fsp.writeFile(path.join(reportDir, 'shutdown-trace-progress.json'), JSON.stringify(prog, null, 2), 'utf-8')
    } catch {
      /* 无 progress */
    }
    if (stdoutChunks.length > 0) await fsp.writeFile(path.join(reportDir, 'main-stdout.log'), stdoutChunks.join(''), 'utf-8')
  } catch (e) {
    console.log('  [report] 留存失败:', e instanceof Error ? e.message : String(e))
  }
  try { await app.close() } catch { /* 已关闭 */ }
  return { graceful: outcome === 'natural_graceful_close', outcome, trace, killed }
}

/** R12：报告目录与 manifest（runId/commit/bundle hash/Electron/Node/平台） */
async function initReportRun(): Promise<{ runDir: string; runId: string }> {
  const runId = 'run-' + String(Date.now()).slice(-8)
  const runDir = path.join(REPORT_DIR, runId)
  await fsp.mkdir(runDir, { recursive: true })
  let commit = ''
  try { commit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim() } catch { /* 非 git */ }
  let dirty = true
  try { dirty = execSync('git status --porcelain', { encoding: 'utf-8' }).trim().length > 0 } catch { /* 非 git */ }
  let mainSha = ''
  let e2eSha = ''
  let mainSourceSha = ''
  let e2eSourceSha = ''
  let electronVersion = 'unknown'
  try {
    const { createHash } = await import('node:crypto')
    mainSha = createHash('sha256').update(await fsp.readFile(path.join(ROOT, 'out', 'main', 'index.js'))).digest('hex').slice(0, 16)
    e2eSha = createHash('sha256').update(await fsp.readFile(path.join(ROOT, 'out', 'e2e-r46-g5.mjs'))).digest('hex').slice(0, 16)
    mainSourceSha = createHash('sha256').update(await fsp.readFile(path.join(ROOT, 'src', 'main', 'index.ts'))).digest('hex').slice(0, 16)
    e2eSourceSha = createHash('sha256').update(await fsp.readFile(path.join(ROOT, 'scripts', 'e2e-r46-g5.ts'))).digest('hex').slice(0, 16)
  } catch { /* 文件缺失 */ }
  try { electronVersion = JSON.parse(await fsp.readFile(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf-8')).version ?? 'unknown' } catch { /* 依赖缺失 */ }
  const manifest = {
    runId,
    commit,
    dirty,
    mainBundleSha256: mainSha || 'missing',
    e2eBundleSha256: e2eSha || 'missing',
    mainSourceSha256: mainSourceSha || 'missing',
    e2eSourceSha256: e2eSourceSha || 'missing',
    electronVersion,
    nodeVersion: process.version,
    platform: process.platform,
    startedAt: new Date().toISOString()
  }
  await fsp.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  return { runDir, runId }
}

async function main(): Promise<void> {
  await fsp.mkdir(REPORT_DIR, { recursive: true })
  const { runDir, runId } = await initReportRun()
  console.log('  [run] ' + runId + ' @ ' + runDir)
  // 清理上次工具证据残留
  try {
    const tmpFiles = await fsp.readdir(os.tmpdir())
    for (const f of tmpFiles) if (f.startsWith('dw-r46-g5-child-')) await fsp.rm(path.join(os.tmpdir(), f), { force: true }).catch(() => undefined)
  } catch { /* 忽略 */ }
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r46-g5-'))
  console.log('\n[R4.6-G5（复审整改）] 六状态优雅退出（G5-R01~R08）')

  // ============ production parity：真实权限初始化 + 真实 app.quit 入口 ============
  console.log('  [production parity] idle + permission manager')
  {
    const mock = await startSlowMock(2000)
    const ud = await fsp.mkdtemp(path.join(tmpRoot, 'production-idle-'))
    const { app, page } = await launchApp(ud, mock.port, 'production')
    const permissions = await page.evaluate(async () => (window as any).ds.permissionsGet())
    check('G5-PROD 前置：production 权限设置已加载', permissions?.mode === 'safe' || permissions?.mode === 'auto', JSON.stringify(permissions))
    const expectedWindowIds = (await app.evaluate(async (electronMod: typeof import('electron')) => electronMod.BrowserWindow.getAllWindows().map((w) => w.id)).catch(() => [] as number[])) as number[]
    const r = await gracefulClose(app, page, ud, 'production-idle', runDir)
    check('G5-PROD 真实 app.quit 自然退出', r.outcome === 'natural_graceful_close', `outcome=${r.outcome}`)
    check('G5-PROD trace 完整（含 shutdown_requested）', r.trace !== null && traceStrictPass(r.trace ?? [], { expectActiveRun: false, requireChildTerminated: false, expectedWindowIds }).ok, JSON.stringify(r.trace?.map((e) => e.event)))
    await new Promise<void>((r2) => { mock.server.closeAllConnections?.(); mock.server.close(() => r2()) })
    await fsp.rm(ud, { recursive: true, force: true }).catch(() => undefined)
  }

  // ============ 状态 1：idle（无 active run + 主窗口存在） ============
  console.log('  [状态1] idle')
  {
    const mock = await startSlowMock(2000)
    const ud = await fsp.mkdtemp(path.join(tmpRoot, 'idle-'))
    const { app, page } = await launchApp(ud, mock.port)
    await page.waitForTimeout(500)
    const rec = await page.evaluate(async () => (window as any).ds.runsRecoverable?.() ?? [])
    const windows = app.windows()
    check('G5-IDLE 前置：无 active run', Array.isArray(rec) && rec.length === 0, JSON.stringify(rec))
    check('G5-IDLE 前置：主窗口存在', windows.some((w) => !w.url().includes('window=float')), `windows=${windows.length}`)
      // R11（R10-R03）：触发 shutdown 前获取预期窗口 ID 集合（真实窗口）
      const expectedWindowIds = (await app.evaluate(async (electronMod: typeof import('electron')) => electronMod.BrowserWindow.getAllWindows().map((w) => w.id)).catch(() => [] as number[])) as number[]
    const r = await gracefulClose(app, page, ud, 'idle', runDir)
    check('G5-IDLE 优雅退出（graceful_close，非 fallback kill）', r.outcome === 'natural_graceful_close', `outcome=${r.outcome}`)
    check('G5-IDLE trace 完整（idle 序列）', r.trace !== null && traceStrictPass(r.trace ?? [], { expectActiveRun: false, requireChildTerminated: false, expectedWindowIds }).ok, JSON.stringify(r.trace?.map((e) => e.event)))
    await new Promise<void>((r2) => { mock.server.closeAllConnections?.(); mock.server.close(() => r2()) })
    await fsp.rm(ud, { recursive: true, force: true }).catch(() => undefined)
  }

  // ============ 状态 2：streaming（active run + 流未结束） ============
  console.log('  [状态2] streaming')
  {
    const mock = await startSlowMock(20000)
    const ud = await fsp.mkdtemp(path.join(tmpRoot, 'stream-'))
    const { app, page } = await launchApp(ud, mock.port)
    const chatId = `run-g5-stream-${Date.now()}`
    await page.evaluate(
      async (args: { id: string }) => {
        const ds = (window as any).ds
        await ds.chatStart({ id: args.id, sessionId: 's-g5s', mode: 'longwrite', longMode: true, targetChars: 10000, text: '写', fixedPrefix: [], attachments: [], quickBypass: true })
      },
      { id: chatId }
    )
    const d1 = Date.now() + 15000
    while (mock.calls < 1 && Date.now() < d1) await new Promise((r) => setTimeout(r, 200))
    await page.waitForTimeout(1200)
    const st = await page.evaluate(async (id: string) => (window as any).ds.runsGet(id), chatId).catch(() => null)
    const streaming = st !== null && st.status === 'running' && mock.calls === 1
    check('G5-STREAM 前置：active run 存在且模型流未结束', streaming, JSON.stringify({ status: st?.status, calls: mock.calls }))
      // R11（R10-R03）：触发 shutdown 前获取预期窗口 ID 集合（真实窗口）
      const expectedWindowIds = (await app.evaluate(async (electronMod: typeof import('electron')) => electronMod.BrowserWindow.getAllWindows().map((w) => w.id)).catch(() => [] as number[])) as number[]
    const r = await gracefulClose(app, page, ud, 'streaming', runDir)
    check('G5-STREAM 优雅退出（graceful_close，非 fallback kill）', r.outcome === 'natural_graceful_close', `outcome=${r.outcome}`)
    check('G5-STREAM trace 完整（含 active run cancel + abort settled）', r.trace !== null && traceStrictPass(r.trace ?? [], { expectActiveRun: true, requireChildTerminated: false, expectedWindowIds }).ok, JSON.stringify(r.trace?.map((e) => e.event)))
    await new Promise<void>((r2) => { mock.server.closeAllConnections?.(); mock.server.close(() => r2()) })
    await fsp.rm(ud, { recursive: true, force: true }).catch(() => undefined)
  }

  // ============ 状态 3：tool-running（run_command 无限 ping——真实子进程） ============
  console.log('  [状态3] tool-running')
  {
    const mock = await startToolMock()
    const ud = await fsp.mkdtemp(path.join(tmpRoot, 'tool-'))
    const { app, page } = await launchApp(ud, mock.port)
    const chatId = `run-g5-tool-${Date.now()}`
    await page.evaluate(
      async (args: { id: string }) => {
        const ds = (window as any).ds
        await ds.chatStart({ id: args.id, sessionId: 's-g5t', mode: 'longwrite', longMode: true, targetChars: 5000, text: '写', fixedPrefix: [], attachments: [], quickBypass: true })
      },
      { id: chatId }
    )
    const d1 = Date.now() + 15000
    while (mock.calls < 1 && Date.now() < d1) await new Promise((r) => setTimeout(r, 200))
    // R11（R10-R01）：轮询唯一 PID 前置证据（工具写盘：<tmp>/dw-r46-g5-child-<sessionId>.json）
    const evidencePath = path.join(os.tmpdir(), 'dw-r46-g5-child-s-g5t.json')
    const evDeadline = Date.now() + 15000
    let evidence: { pid?: number | null; rootPid?: number | null; treePids?: number[]; activePids?: number[]; alive: boolean; registered: boolean; spawnError?: string | null } | null = null
    while (Date.now() < evDeadline) {
      try {
        evidence = JSON.parse(await fsp.readFile(evidencePath, 'utf-8'))
        if (evidence && typeof evidence.rootPid === 'number' && evidence.alive === true && evidence.registered === true) break
      } catch {
        /* 证据未就绪 */
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    const st = await page.evaluate(async (id: string) => (window as any).ds.runsGet(id), chatId).catch(() => null)
    const act = await page.evaluate(async (id: string) => (window as any).ds.activityGetSnapshot?.(id) ?? null, chatId).catch(() => null)
    const toolRunning = st !== null && st.status === 'running'
    const snapStatus = (act as { status?: string; currentTitle?: string } | null)?.status
    const snapTitle = (act as { currentTitle?: string } | null)?.currentTitle ?? ''
    const toolPid = evidence?.rootPid ?? evidence?.pid ?? null
    const treePids = evidence?.treePids ?? []
    const activePids = evidence?.activePids ?? []
    const registryContainsPid = toolPid !== null && activePids.includes(toolPid)
    check('G5-TOOL 前置：唯一 PID 证据存在且 alive + registered（真实 registry 查询）', evidence !== null && toolPid !== null && evidence.alive === true && evidence.registered === true, JSON.stringify(evidence))
    check('G5-TOOL 前置：tool 运行中（run running）', toolRunning, JSON.stringify({ status: st?.status }))
    check('G5-TOOL 前置：活动快照 executing_tool（受控阻塞工具真实执行中）', snapStatus === 'executing_tool' || snapTitle.includes('执行工具'), JSON.stringify({ status: snapStatus, title: snapTitle }))
    // R12（R11-R01）：前置全部条件——executing_tool + run active + PID alive + registry 精确包含 + promise pending（工具未自然完成）
    const activityExecuting = snapStatus === 'executing_tool' || snapTitle.includes('执行工具')
    const pidAlive = evidence !== null && toolPid !== null && evidence.alive === true
    const promisePending = evidence !== null && evidence.alive === true && (evidence as { spawnError?: string | null }).spawnError === null
    const preconditionsOk = activityExecuting && toolRunning && pidAlive && registryContainsPid && promisePending
    if (!preconditionsOk) {
      check('G5-TOOL 前置不成立 → 场景 FAIL（不进入 shutdown 判定）', false, 'preconditions failed')
      try { await app.close() } catch { /* 已关闭 */ }
      await new Promise<void>((r2) => { mock.server.closeAllConnections?.(); mock.server.close(() => r2()) })
      await fsp.rm(ud, { recursive: true, force: true }).catch(() => undefined)
    } else {
    // R11（R10-R03）：触发 shutdown 前获取预期窗口 ID 集合（真实窗口）
    const expectedWindowIds = (await app.evaluate(async (electronMod: typeof import('electron')) => electronMod.BrowserWindow.getAllWindows().map((w) => w.id)).catch(() => [] as number[])) as number[]
    const r = await gracefulClose(app, page, ud, 'tool-running', runDir)
    check('G5-TOOL 优雅退出（natural_graceful_close，非 forced/timeout）', r.outcome === 'natural_graceful_close', `outcome=${r.outcome}`)
    // R11（R10-R01）：trace 必须 terminated 且 meta 完整（attempted/killed/pids/remaining）
    const childTerm = r.trace?.find((e) => e.event === 'child_process_tree_terminated')
    const childMeta = childTerm?.meta as { attempted?: number; killed?: number; alreadyExited?: number; remaining?: number; pids?: number[]; remainingPids?: number[] } | undefined
    check('G5-TOOL trace：child_process_tree_terminated 实际 killed≥1 且 remaining=0（真实 tracked child）', childTerm !== undefined && typeof childMeta?.attempted === 'number' && childMeta.attempted >= 1 && typeof childMeta.killed === 'number' && childMeta.killed >= 1 && childMeta.remaining === 0, JSON.stringify(childTerm))
    check('G5-TOOL trace：terminated pids 含捕获的唯一 PID（' + String(toolPid) + '）', childTerm !== undefined && Array.isArray(childMeta?.pids) && toolPid !== null && childMeta.pids.includes(toolPid), JSON.stringify(childMeta?.pids))
    check('G5-TOOL 严格 trace 顺序（含 terminated，拒绝错误/越序/重复）', r.trace !== null && traceStrictPass(r.trace ?? [], { expectActiveRun: true, requireChildTerminated: true, expectedWindowIds }).ok, JSON.stringify(r.trace?.map((e) => e.event)))
    await new Promise((r2) => setTimeout(r2, 800))
    // R12（R11-R01）：退出后验证 root+descendant 全部不存在（精确 PID，禁止进程名/模糊查询）
    const stillAlive = treePids.filter((p) => {
      try { return execSync(`tasklist /FI "PID eq ${p}" /NH`, { encoding: 'utf-8' }).includes(String(p)) } catch { return false }
    })
    check(`G5-TOOL 退出后进程树（root+${treePids.length - 1} descendants）全部不存在（无孤儿）`, toolPid !== null && stillAlive.length === 0, JSON.stringify({ treePids, stillAlive }))
    }

    await new Promise<void>((r2) => { mock.server.closeAllConnections?.(); mock.server.close(() => r2()) })
    await fsp.rm(ud, { recursive: true, force: true }).catch(() => undefined)
  }

  // ============ 状态 4：waiting-user（完成校验暂停） ============
  console.log('  [状态4] waiting-user')
  {
    const mock = await startSlowMock(8000, 100)
    const ud = await fsp.mkdtemp(path.join(tmpRoot, 'wait-'))
    const { app, page } = await launchApp(ud, mock.port)
    const chatId = `run-g5-wait-${Date.now()}`
    await page.evaluate(
      async (args: { id: string }) => {
        const ds = (window as any).ds
        await ds.chatStart({ id: args.id, sessionId: 's-g5w', mode: 'longwrite', longMode: true, targetChars: 20000, text: '写', fixedPrefix: [], attachments: [], quickBypass: true })
      },
      { id: chatId }
    )
    const d1 = Date.now() + 30000
    let status = ''
    while (Date.now() < d1) {
      const st = await page.evaluate(async (id: string) => (window as any).ds.runsGet(id), chatId).catch(() => null)
      if (st?.status === 'waiting_user') { status = st.status; break }
      await new Promise((r) => setTimeout(r, 400))
    }
    check('G5-WAIT 前置：run 已进入 waiting_user（完成校验暂停）', status === 'waiting_user', `status=${status}`)
      // R11（R10-R03）：触发 shutdown 前获取预期窗口 ID 集合（真实窗口）
      const expectedWindowIds = (await app.evaluate(async (electronMod: typeof import('electron')) => electronMod.BrowserWindow.getAllWindows().map((w) => w.id)).catch(() => [] as number[])) as number[]
    const r = await gracefulClose(app, page, ud, 'waiting-user', runDir)
    check('G5-WAIT 优雅退出（graceful_close，非 fallback kill）', r.outcome === 'natural_graceful_close', `outcome=${r.outcome}`)
    check('G5-WAIT trace 完整（含 active run cancel）', r.trace !== null && traceStrictPass(r.trace ?? [], { expectActiveRun: true, requireChildTerminated: false, expectedWindowIds }).ok, JSON.stringify(r.trace?.map((e) => e.event)))
    await new Promise<void>((r2) => { mock.server.closeAllConnections?.(); mock.server.close(() => r2()) })
    await fsp.rm(ud, { recursive: true, force: true }).catch(() => undefined)
  }

  // ============ 状态 5：floating-window（悬浮窗存在且可见） ============
  console.log('  [状态5] floating-window')
  {
    const mock = await startSlowMock(8000, 8000)
    const ud = await fsp.mkdtemp(path.join(tmpRoot, 'float-'))
    const { app, page } = await launchApp(ud, mock.port)
    const chatId = `run-g5-f-${Date.now()}`
    await page.evaluate(
      async (args: { id: string }) => {
        const ds = (window as any).ds
        await ds.chatStart({ id: args.id, sessionId: 's-g5f', mode: 'longwrite', longMode: true, targetChars: 10000, text: '写', fixedPrefix: [], attachments: [], quickBypass: true })
      },
      { id: chatId }
    )
    const d1 = Date.now() + 15000
    while (mock.calls < 1 && Date.now() < d1) await new Promise((r) => setTimeout(r, 200))
    await page.waitForTimeout(800)
    const fDeadline = Date.now() + 10000
    let fp: Page | undefined
    while (Date.now() < fDeadline) {
      await page.evaluate(async () => (window as any).ds.floatToggle?.()).catch(() => undefined)
      await page.waitForTimeout(800)
      fp = app.windows().find((c) => c.url().includes('window=float'))
      if (fp) break
    }
    const floatState = await app.evaluate(async (electronMod: typeof import('electron')) => {
      const wins = electronMod.BrowserWindow.getAllWindows()
      return { count: wins.length, visibles: wins.map((w) => w.isVisible()) }
    }).catch(() => null)
    check('G5-FLOAT 前置：悬浮窗窗口存在且可见', fp !== undefined && floatState !== null && floatState.count >= 2 && floatState.visibles.some((v) => v), JSON.stringify(floatState))
      // R11（R10-R03）：触发 shutdown 前获取预期窗口 ID 集合（真实窗口）
      const expectedWindowIds = (await app.evaluate(async (electronMod: typeof import('electron')) => electronMod.BrowserWindow.getAllWindows().map((w) => w.id)).catch(() => [] as number[])) as number[]
    const r = await gracefulClose(app, page, ud, 'floating-window', runDir)
    check('G5-FLOAT 优雅退出（graceful_close，非 fallback kill）', r.outcome === 'natural_graceful_close', `outcome=${r.outcome}`)
    check('G5-FLOAT trace 完整', r.trace !== null && traceStrictPass(r.trace ?? [], { expectActiveRun: true, requireChildTerminated: false, expectedWindowIds }).ok, JSON.stringify(r.trace?.map((e) => e.event)))
    await new Promise<void>((r2) => { mock.server.closeAllConnections?.(); mock.server.close(() => r2()) })
    await fsp.rm(ud, { recursive: true, force: true }).catch(() => undefined)
  }

  // ============ 状态 6：main-hidden（主窗口隐藏 + 悬浮窗可见，应用仍存活） ============
  console.log('  [状态6] main-hidden')
  {
    const mock = await startSlowMock(8000, 8000)
    const ud = await fsp.mkdtemp(path.join(tmpRoot, 'hidden-'))
    const { app, page } = await launchApp(ud, mock.port)
    const chatId = `run-g5-h-${Date.now()}`
    await page.evaluate(
      async (args: { id: string }) => {
        const ds = (window as any).ds
        await ds.chatStart({ id: args.id, sessionId: 's-g5h', mode: 'longwrite', longMode: true, targetChars: 10000, text: '写', fixedPrefix: [], attachments: [], quickBypass: true })
      },
      { id: chatId }
    )
    const d1 = Date.now() + 15000
    while (mock.calls < 1 && Date.now() < d1) await new Promise((r) => setTimeout(r, 200))
    await page.waitForTimeout(800)
    // G5-R05：经主进程 API 隐藏主窗口（不依赖 renderer remote）
    const hideRet = await app.evaluate(async (electronMod: typeof import('electron')) => {
      const wins = electronMod.BrowserWindow.getAllWindows()
      const main = wins.find((w) => !w.webContents.getURL().includes('window=float'))
      if (!main) return 'no-main'
      main.hide()
      return { mainVisible: main.isVisible(), winCount: wins.length }
    }).catch((e: unknown) => 'err:' + String(e))
    await page.waitForTimeout(1200)
    const fDeadline = Date.now() + 10000
    let fp: Page | undefined
    while (Date.now() < fDeadline) {
      fp = app.windows().find((c) => c.url().includes('window=float'))
      if (fp) break
      await new Promise((r) => setTimeout(r, 500))
    }
    const winState = await app.evaluate(async (electronMod: typeof import('electron')) => {
      const wins = electronMod.BrowserWindow.getAllWindows()
      return { count: wins.length, visibles: wins.map((w) => w.isVisible()) }
    }).catch(() => null)
    check('G5-HIDDEN 前置：主窗口已隐藏（isVisible=false）', typeof hideRet === 'object' && hideRet !== null && (hideRet as { mainVisible?: boolean }).mainVisible === false, JSON.stringify(hideRet))
    check('G5-HIDDEN 前置：悬浮窗存在且可见（应用仍存活）', fp !== undefined && winState !== null && winState.count >= 2, JSON.stringify(winState))
      // R11（R10-R03）：触发 shutdown 前获取预期窗口 ID 集合（真实窗口）
      const expectedWindowIds = (await app.evaluate(async (electronMod: typeof import('electron')) => electronMod.BrowserWindow.getAllWindows().map((w) => w.id)).catch(() => [] as number[])) as number[]
    const r = await gracefulClose(app, page, ud, 'main-hidden', runDir)
    check('G5-HIDDEN 优雅退出（graceful_close，非 fallback kill）', r.outcome === 'natural_graceful_close', `outcome=${r.outcome}`)
    check('G5-HIDDEN trace 完整', r.trace !== null && traceStrictPass(r.trace ?? [], { expectActiveRun: true, requireChildTerminated: false, expectedWindowIds }).ok, JSON.stringify(r.trace?.map((e) => e.event)))
    await new Promise<void>((r2) => { mock.server.closeAllConnections?.(); mock.server.close(() => r2()) })
    await fsp.rm(ud, { recursive: true, force: true }).catch(() => undefined)
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n===== R4.6-G5 生命周期 E2E（复审整改）：${passed} PASS / ${failed} FAIL =====`)
  console.log('报告目录：' + REPORT_DIR)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('R4.6-G5 运行异常:', e instanceof Error ? e.message : String(e))
  process.exitCode = 2
})
