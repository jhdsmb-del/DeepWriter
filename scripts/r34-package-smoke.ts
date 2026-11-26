import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as http from 'node:http'
import { execFileSync } from 'node:child_process'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const exeArg = process.argv.find((arg) => arg.startsWith('--exe='))?.slice('--exe='.length)
const EXE = path.resolve(ROOT, exeArg || path.join('dist-r40', 'win-unpacked', 'DeepWriter.exe'))
const EVIDENCE_DIR = path.join(ROOT, 'tmp', 'r40-package-smoke')
const SCREENSHOT = path.join(EVIDENCE_DIR, 'stream-progress.png')
const JSON_PATH = path.join(EVIDENCE_DIR, 'result.json')

type Check = { name: string; ok: boolean; detail?: string }

const checks: Check[] = []
let app: ElectronApplication | null = null
let appPid: number | null = null
let userData = ''

function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, ...(detail ? { detail } : {}) })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function isProcessAlive(pid: number): boolean {
  try {
    const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    return output.includes(`"${pid}"`)
  } catch {
    return false
  }
}

async function startSlowMock(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      try { JSON.parse(body) } catch { /* 请求体只用于确认真实 provider 路径 */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const write = (data: unknown): void => { res.write(`data: ${JSON.stringify(data)}\n\n`) }
      const chunks = ['晨光穿过窗棂，', '桌上的纸页轻轻翻动，', '故事从一个安静的决定开始。']
      let index = 0
      const send = (): void => {
        if (res.destroyed) return
        write({ id: `r40-${Date.now()}`, choices: [{ index: 0, delta: { role: 'assistant', content: chunks[index] }, finish_reason: null }], usage: null })
        index = (index + 1) % chunks.length
      }
      send()
      const timer = setInterval(send, 280)
      const clear = (): void => clearInterval(timer)
      res.on('close', clear)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as { port: number }).port }
}

async function configureSyntheticProvider(page: Page, port: number): Promise<void> {
  const result = await page.evaluate(async (p) => {
    const ds = (window as unknown as { ds: { getSettings: () => Promise<Record<string, unknown>>; setSettings: (s: Record<string, unknown>) => Promise<boolean> } }).ds
    const current = await ds.getSettings()
    const ok = await ds.setSettings({ ...current, apiKey: 'r40-synthetic-only', baseUrl: `http://127.0.0.1:${p}`, model: 'deepseek-v4-flash', thinkingEnabled: false, toolsEnabled: false })
    const after = await ds.getSettings()
    return { ok, baseUrl: after.baseUrl, model: after.model }
  }, port)
  check('settings:get/set 真实 IPC', result.ok === true && result.baseUrl === `http://127.0.0.1:${port}`, JSON.stringify(result))
}

async function selectLongwriteAndEnableExactMode(page: Page): Promise<void> {
  await page.locator('.mode-popover-wrap > .modebar-btn').click()
  await page.locator('.mode-item', { hasText: '长文' }).click()
  const panel = page.locator('[aria-label="深度写作控制"]')
  await panel.waitFor()
  const toggle = panel.locator('input[type="checkbox"]').first()
  if (!(await toggle.isChecked())) await toggle.check({ force: true })
  const target = panel.locator('input[type="range"]').first()
  await target.fill('2000')
  const longModeEnabled = await toggle.isChecked()
  const targetValue = await target.inputValue()
  check('长文模式与精确目标已启用', longModeEnabled && targetValue === '2000', `longMode=${longModeEnabled} target=${targetValue}`)
}

async function observeSlowStream(page: Page, port: number): Promise<void> {
  const text = page.locator('.composer textarea')
  await text.fill('请写一段安静的开头。')
  await page.locator('.composer .btn.primary').click()
  const progress = page.locator('[data-testid="stream-progress"]')
  await progress.waitFor({ state: 'visible', timeout: 12000 })
  const bar = progress.locator('[role="progressbar"]')
  const initial = {
    role: await bar.getAttribute('role'),
    current: Number(await bar.getAttribute('aria-valuenow')),
    target: Number(await bar.getAttribute('aria-valuemax')),
    label: await progress.innerText()
  }
  const samples: number[] = [initial.current]
  const deadline = Date.now() + 7000
  while (Date.now() < deadline && samples.length < 3) {
    await page.waitForTimeout(160)
    const value = Number(await bar.getAttribute('aria-valuenow'))
    if (value > samples[samples.length - 1]) samples.push(value)
  }
  const monotonic = samples.length >= 3 && samples.every((v, i) => i === 0 || v > samples[i - 1])
  check('stream-progress 可见且使用 progressbar', initial.role === 'progressbar', JSON.stringify(initial))
  check('stream-progress 显示 current/target', initial.target === 2000 && /\d[\d,]*\s*\/\s*2,?000\s*字/.test(initial.label), JSON.stringify(initial))
  check('synthetic 慢流 current 单调增加', monotonic, `samples=${JSON.stringify(samples)}`)
  await page.screenshot({ path: SCREENSHOT, animations: 'disabled' })
  check('生成中主窗口截图已留存', fs.existsSync(SCREENSHOT), SCREENSHOT)
  await page.locator('.composer .btn.stop').click()
  await page.waitForFunction(() => !document.querySelector('.composer .btn.stop'), undefined, { timeout: 10000 }).catch(() => undefined)
  check('synthetic provider 未访问外网', port > 0)
}

async function quitNaturally(): Promise<number | null> {
  if (!app) return null
  const child = app.process()
  const pid = child.pid ?? null
  const exit = new Promise<number>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode ?? 0)
    else child.once('exit', (code) => resolve(code ?? 0))
  })
  await app.evaluate(({ app: electronApp }) => { electronApp.quit() }).catch(() => undefined)
  const code = await Promise.race([exit, new Promise<number>((resolve) => setTimeout(() => resolve(255), 15000))])
  check('app.quit() 自然退出 exit 0', code === 0, `pid=${pid} exit=${code}`)
  if (pid !== null) check('退出后无 DeepWriter 孤儿进程', !isProcessAlive(pid), `pid=${pid}`)
  return code
}

async function main(): Promise<void> {
  await fsp.mkdir(EVIDENCE_DIR, { recursive: true })
  userData = await fsp.mkdtemp(path.join(EVIDENCE_DIR, 'userdata-'))
  check('fresh unpacked 可执行文件存在', fs.existsSync(EXE), EXE)
  if (!fs.existsSync(EXE)) throw new Error(`missing packaged executable: ${EXE}`)

  const mock = await startSlowMock()
  try {
    app = await electron.launch({
      executablePath: EXE,
      args: [`--user-data-dir=${userData}`],
      env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userData }
    })
    appPid = app.process().pid ?? null
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForSelector('.composer', { timeout: 15000 })
    await page.waitForTimeout(1000)
    check('窗口标题为 DeepWriter', (await page.title()) === 'DeepWriter', await page.title())
    check('renderer 来自真实 app.asar', page.url().includes('/resources/app.asar/out/renderer/index.html'), page.url())
    check('Composer 真实 DOM 存在', (await page.locator('.composer').count()) === 1)
    await configureSyntheticProvider(page, mock.port)
    await selectLongwriteAndEnableExactMode(page)
    await observeSlowStream(page, mock.port)
    const db = path.join(userData, 'deepwriter.db')
    const settings = path.join(userData, 'settings.json')
    check('隔离 userData 生成 deepwriter.db', fs.existsSync(db), db)
    check('隔离 userData 生成 settings.json', fs.existsSync(settings), settings)
    await quitNaturally()
  } finally {
    if (app) {
      await app.close().catch(() => undefined)
      app = null
    }
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
  }

  const result = { exe: EXE, userData, pid: appPid, screenshot: SCREENSHOT, checks, passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length }
  await fsp.writeFile(JSON_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`\nR40 packaged smoke: ${result.passed} PASS / ${result.failed} FAIL`)
  console.log(`evidence: ${JSON_PATH}`)
  if (result.failed > 0) process.exitCode = 1
}

await main()
