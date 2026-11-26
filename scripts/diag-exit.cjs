// ==================== R12 诊断：idle 场景单点退出卡点定位 ====================
// 启动真实 app（idle，无 run），触发 testShutdown，收集主进程 stdout 15s，
// 打印协调器阶段时间戳 + watchdog，判断：事件循环是否挂死、窗口是否 closed。
// 用法：node scripts/diag-exit.cjs [轮数]
const path = require('path')
const os = require('os')
const fs = require('fs')
const { _electron } = require('@playwright/test')

const ROOT = path.resolve(__dirname, '..')
const rounds = parseInt(process.argv[2] || '1', 10)

const log = (...a) => process.stderr.write('[diag] ' + a.join(' ') + '\n')

async function oneRound(i) {
  log('round ' + i + ' start')
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-diag-'))
  log('ud=' + ud)
  const app = await _electron.launch({
    args: [path.join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: ud }
  })
  log('launched pid=' + app.process().pid)
  const page = await app.firstWindow()
  log('firstWindow ok')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.composer', { timeout: 15000 })
  log('composer ok')
  await page.waitForTimeout(500)
  const chunks = []
  app.process().stdout?.on('data', (d) => chunks.push(String(d)))
  const t0 = Date.now()
  const closeP = app.waitForEvent('close', { timeout: 25000 }).then(() => true).catch(() => false)
  log('triggering testShutdown')
  // 不 await evaluate——窗口销毁可能使 IPC reply 丢失导致 evaluate 挂起；close 事件才是判据
  const evalP = page.evaluate(async () => {
    const ds = window.ds
    if (typeof ds?.testShutdown !== 'function') return 'no-bridge'
    const r = await ds.testShutdown()
    return JSON.stringify(r)
  }).catch((e) => 'evaluate-error: ' + String(e))
  const closed = await closeP
  log('closed=' + closed + ' ms=' + (Date.now() - t0))
  const evalRet = await Promise.race([evalP, new Promise((r) => setTimeout(() => r('(evaluate-pending)'), 3000))])
  log('evaluate: ' + String(evalRet).slice(0, 60))
  // R12 诊断：close 超时后（app 仍存活）观察 electron 进程树——renderer/GPU 是否已退出
  try {
    const ps = require('child_process').execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'electron.exe\'\\" | ForEach-Object { $cl = $_.CommandLine; if ($cl.Length -gt 110) { $cl = $cl.Substring(0,110) }; \'{0} {1} | {2}\' -f $_.ProcessId, $_.ParentProcessId, $cl }"',
      { encoding: 'utf8', timeout: 10000 }
    )
    log('--- electron pids (pid ppid | cmdline) ---')
    log(ps.trim())
  } catch (e) {
    log('ps err: ' + String(e.message).slice(0, 80))
  }
  log('--- main stdout ---')
  log(chunks.join(''))
  let trace = null
  try { trace = JSON.parse(fs.readFileSync(path.join(ud, 'shutdown-trace.json'), 'utf8')) } catch {}
  let progress = null
  try { progress = JSON.parse(fs.readFileSync(path.join(ud, 'shutdown-trace-progress.json'), 'utf8')) } catch {}
  log('--- final trace ---')
  log(trace ? trace.map((e) => e.event).join(' -> ') : '(无 shutdown-trace.json — will-quit 未触发)')
  log('--- progress (最后 8) ---')
  log(progress ? progress.slice(-8).map((e) => e.event).join(' -> ') : '(无 progress)')
  log('app.close()...')
  // close 超时后直接杀 app 进程树（避免 Playwright close 等待卡死；诊断已拿全证据）
  if (!closed) {
    try { require('child_process').execSync('taskkill /F /T /PID ' + app.process().pid + ' 2>nul', { stdio: 'ignore' }) } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  try { await app.close() } catch (e) { log('app.close err: ' + String(e)) }
  log('closed app, cleanup')
  fs.rmSync(ud, { recursive: true, force: true })
  log('round ' + i + ' done, closed=' + closed + ' ms=' + (Date.now() - t0))
  return { closed, ms: Date.now() - t0 }
}

async function main() {
  log('diag start')
  for (let i = 1; i <= rounds; i++) await oneRound(i)
  log('diag all done')
}
main().catch((e) => { console.error('诊断异常:', e.message); process.exit(2) })
