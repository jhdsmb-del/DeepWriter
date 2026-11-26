// ==================== R11 二分：最小复现 + DeepWriter DB（node:sqlite） ====================
// 已排除：纯 quit 10/10、handler 8/8、renderer（含可见）6/6、Node handles/requests 0。
// 本程序：纯 close+quit + 打开/关闭 node:sqlite DB（近似 DeepWriter 的 repository）。
// 退 → DB 层无关，剩余为复杂初始化组合的概率性；不退 → DB 层候选。
// 运行：node scripts/repro-exit-db.mjs <rounds=6>

const path = require('path')
const fs = require('fs')
const os = require('os')
const { execSync } = require('child_process')
const { _electron: electron } = require('@playwright/test')
const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'repro', 'repro-db-main.js')
const rounds = Number(process.argv[2] || 6)

async function main() {
  await fs.promises.mkdir(path.dirname(MAIN), { recursive: true })
  await fs.promises.writeFile(MAIN, `
const { app, BrowserWindow } = require('electron')
const { DatabaseSync } = require('node:sqlite')
const path = require('path')
const os = require('os')
app.whenReady().then(() => {
  const db = new DatabaseSync(path.join(os.tmpdir(), 'repro-db-' + Date.now() + '.db'))
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('x')
  const win = new BrowserWindow({ width: 300, height: 200, show: false })
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      try { db.close() } catch { /* 已关闭 */ }
      process.stdout.write('closing\\n')
      win.close()
      app.quit()
    }, 300)
  })
  win.loadURL('about:blank')
  app.on('before-quit', () => { process.stdout.write('before-quit\\n') })
  app.on('will-quit', () => { process.stdout.write('will-quit\\n') })
  process.on('exit', () => { process.stdout.write('process-exit\\n') })
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
  console.log(`\n===== DB 层复现 ${rounds} 轮：natural_close=${natural} / ${rounds} =====`)
  await fs.promises.writeFile(path.join(ROOT, 'docs', 'repro-exit-db-results.json'), JSON.stringify(results, null, 2), 'utf-8')
}

main().catch((e) => { console.error('异常:', e.message); process.exit(2) })
