// ==================== R11 二分定位：DeepWriter 退出 handler 层 ====================
// 最小程序（纯 close+quit）10/10 自然退出；DeepWriter 六状态 outcome 波动。
// 本程序复制 DeepWriter 的退出 handler 逻辑（before-quit 状态机 preventDefault /
// window-all-closed / 窗口 close prevent+hide），其余模块不加载——
// 若本程序也不退 → handler 层（状态机/时序）问题；若退 → DeepWriter 其他模块残留。
// 运行：node scripts/repro-exit-handlers.mjs <rounds=5>

const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')
const { _electron: electron } = require('@playwright/test')
const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'repro', 'repro-handlers-main.js')
const rounds = Number(process.argv[2] || 5)

async function main() {
  await fs.promises.mkdir(path.dirname(MAIN), { recursive: true })
  await fs.promises.writeFile(MAIN, `
const { app, BrowserWindow } = require('electron')
let quitState = 'idle'   // idle → coordinating → quitting（模拟 DeepWriter）
let appQuitting = false

async function runShutdownCoordinator() {
  if (quitState !== 'idle') return
  quitState = 'coordinating'
  // 模拟协调器：等 300ms（cancel/settle 的近似）→ 关窗口 → quit
  await new Promise((r) => setTimeout(r, 300))
  appQuitting = true
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.close()
  }
  quitState = 'quitting'
  app.quit()
}

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 200, height: 100, show: false })
  win.on('close', (event) => {
    process.stdout.write('window-close\\n')
    if (!appQuitting) { event.preventDefault(); win.hide() }
  })
  app.on('before-quit', (e) => {
    process.stdout.write('before-quit state=' + quitState + '\\n')
    if (quitState === 'coordinating') { e.preventDefault(); return }
    if (quitState === 'idle') {
      e.preventDefault()
      process.stdout.write('shutdown-requested\\n')
      runShutdownCoordinator()
      return
    }
    // quitting：允许
  })
  app.on('window-all-closed', () => {
    process.stdout.write('window-all-closed state=' + quitState + '\\n')
    if (process.platform !== 'darwin' && quitState === 'idle') runShutdownCoordinator()
  })
  app.on('will-quit', () => { process.stdout.write('will-quit\\n') })
  process.on('exit', () => { process.stdout.write('process-exit\\n') })
  setTimeout(() => {
    process.stdout.write('closing\\n')
    app.quit()   // 经 before-quit idle 分支（与 testShutdown 触发协调器等价）
  }, 500)
})
`, 'utf-8')

  const results = []
  for (let i = 1; i <= rounds; i++) {
    const t0 = Date.now()
    let appPid = 0
    let outcome = 'timeout'
    try {
      const app = await electron.launch({ args: [MAIN] })
      appPid = app.process().pid
      const closeP = app.waitForEvent('close', { timeout: 12000 }).then(() => true).catch(() => false)
      const closed = await closeP
      if (closed) outcome = 'natural_close'
      else { try { execSync('taskkill /F /T /PID ' + app.process().pid, { stdio: 'ignore' }); outcome = 'forced_cleanup' } catch { outcome = 'timeout' } }
      try { await app.close() } catch { /* 已退出 */ }
    } catch (e) { outcome = 'launch_error' }
    results.push({ round: i, outcome, ms: Date.now() - t0 })
    console.log(`round ${i}: ${outcome} (${Date.now() - t0}ms)`)
    if (appPid) { try { execSync('taskkill /F /T /PID ' + appPid + ' 2>nul', { stdio: 'ignore' }) } catch { /* 无 */ } }
    await new Promise((r) => setTimeout(r, 400))
  }
  const natural = results.filter((r) => r.outcome === 'natural_close').length
  console.log(`\n===== handler 层复现 ${rounds} 轮：natural_close=${natural} / ${rounds} =====`)
  await fs.promises.writeFile(path.join(ROOT, 'docs', 'repro-exit-handlers-results.json'), JSON.stringify(results, null, 2), 'utf-8')
}

main().catch((e) => { console.error('异常:', e.message); process.exit(2) })
