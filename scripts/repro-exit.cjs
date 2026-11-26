// ==================== R11 §七：最小 Electron 自然退出复现（10 轮） ====================
// 无 DeepWriter DB/run kernel/preload/mock server——仅 BrowserWindow + window.close + app.quit，
// 同一 Electron 版本、同一 Playwright 启动方式；记录每轮 before-quit/will-quit/process exit。
// 目的：若自然退出在此环境稳定不收敛 → "环境/平台阻塞"证据成立；否则指向 DeepWriter 自身资源。
// 运行：node scripts/repro-exit.mjs

const path = require('path')
const fs = require('fs')
const os = require('os')
const { execSync } = require('child_process')
const { _electron: electron } = require('@playwright/test')
const ROOT = path.resolve(__dirname, '..')

const MAIN = path.join(ROOT, 'repro', 'repro-main.js')

async function main() {
  await fs.promises.mkdir(path.dirname(MAIN), { recursive: true })
  await fs.promises.writeFile(MAIN, `
const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 200, height: 100, show: false })
  app.on('before-quit', () => { process.stdout.write('before-quit\\n') })
  app.on('will-quit', () => { process.stdout.write('will-quit\\n') })
  process.on('exit', () => { process.stdout.write('process-exit\\n') })
  setTimeout(() => {
    process.stdout.write('closing\\n')
    win.close()
    app.quit()
  }, 500)
})
`, 'utf-8')

  const results = []
  for (let i = 1; i <= 10; i++) {
    const t0 = Date.now()
    let appPid = 0
    let outcome = 'timeout'
    let closed = false
    try {
      const app = await electron.launch({ args: [MAIN] })
      appPid = app.process().pid
      const closeP = app.waitForEvent('close', { timeout: 10000 }).then(() => true).catch(() => false)
      const stderr = []
      app.process().stderr?.on('data', (d) => stderr.push(String(d)))
      closed = await closeP
      if (closed) {
        outcome = 'natural_close'
      } else {
        try { execSync('taskkill /F /T /PID ' + app.process().pid, { stdio: 'ignore' }); outcome = 'forced_cleanup' } catch { outcome = 'timeout' }
      }
      try { await app.close() } catch { /* 已退出 */ }
    } catch (e) {
      outcome = 'launch_error:' + String(e).slice(0, 60)
    }
    const ms = Date.now() - t0
    results.push({ round: i, outcome, ms })
    console.log(`round ${i}: ${outcome} (${ms}ms)`)
    // 清理残留 electron（避免跨轮干扰）
    if (appPid) { try { execSync('taskkill /F /T /PID ' + appPid + ' 2>nul', { stdio: 'ignore' }) } catch { /* 无 */ } }
    await new Promise((r) => setTimeout(r, 500))
  }
  const natural = results.filter((r) => r.outcome === 'natural_close').length
  console.log(`\n===== 最小复现 10 轮：natural_close=${natural} / 10 =====`)
  await fs.promises.writeFile(path.join(ROOT, 'docs', 'repro-exit-results.json'), JSON.stringify(results, null, 2), 'utf-8')
  console.log('原始结果：docs/repro-exit-results.json')
}

main().catch((e) => { console.error('复现异常:', e.message); process.exit(2) })
