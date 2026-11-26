// ==================== R11 二分：最小复现 + 真实 renderer（preload） ====================
// handler 层 8/8 退；DeepWriter 不退（Node handles/requests 均 0）——
// 本程序：纯 close+quit（无 DeepWriter main 模块）+ 窗口加载真实 out/renderer/index.html
// 与 out/preload/index.js（sandbox/contextIsolation 同 DeepWriter）。
// 退 → main 模块层残留；不退 → renderer/preload 层。
// 运行：node scripts/repro-exit-renderer.mjs <rounds=5>

const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')
const { _electron: electron } = require('@playwright/test')
const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'repro', 'repro-renderer-main.js')
const rounds = Number(process.argv[2] || 5)

async function main() {
  await fs.promises.mkdir(path.dirname(MAIN), { recursive: true })
  await fs.promises.writeFile(MAIN, `
const { app, BrowserWindow } = require('electron')
const path = require('path')
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 400, height: 300, show: true,
    webPreferences: {
      preload: path.join(__dirname, '../out/preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  win.loadFile(path.join(__dirname, '../out/renderer/index.html'))
  win.webContents.once('did-finish-load', () => {
    process.stdout.write('renderer-loaded\\n')
    setTimeout(() => {
      process.stdout.write('closing\\n')
      win.close()
      app.quit()
    }, 500)
  })
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
      const closeP = app.waitForEvent('close', { timeout: 15000 }).then(() => true).catch(() => false)
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
  console.log(`\n===== renderer 层复现 ${rounds} 轮：natural_close=${natural} / ${rounds} =====`)
  await fs.promises.writeFile(path.join(ROOT, 'docs', 'repro-exit-renderer-results.json'), JSON.stringify(results, null, 2), 'utf-8')
}

main().catch((e) => { console.error('异常:', e.message); process.exit(2) })
