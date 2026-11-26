import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const EVIDENCE = path.join(ROOT, 'tmp', 'r36-longwrite-e2e')
const expectRed = process.argv.includes('--expect-red')
const exeArg = process.argv.find((arg) => arg.startsWith('--exe='))?.slice('--exe='.length)
const executablePath = path.resolve(ROOT, exeArg || path.join('dist-r36', 'win-unpacked', 'DeepWriter.exe'))

interface Check { name: string; ok: boolean; detail?: string }
interface Mock { server: http.Server; port: number; requests: Array<{ messages: Array<{ role: string; content: string }> }> }

const checks: Check[] = []

function codePointLength(text: string): number {
  return Array.from(text).length
}

function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, ...(detail ? { detail } : {}) })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function roundText(round: number): string {
  const start = 0x3400 + (round - 1) * 1000
  return Array.from({ length: 1000 }, (_, index) => String.fromCodePoint(start + index)).join('')
}

async function startMock(): Promise<Mock> {
  const requests: Mock['requests'] = []
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      let parsed: { messages: Array<{ role: string; content: string }> }
      try {
        parsed = JSON.parse(body) as typeof parsed
      } catch {
        res.writeHead(400).end()
        return
      }
      requests.push(parsed)
      const round = requests.length
      const content = roundText(round)
      const chunks = Array.from({ length: 5 }, (_, index) => Array.from(content).slice(index * 200, (index + 1) * 200).join(''))
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const write = (data: unknown): void => { res.write(`data: ${JSON.stringify(data)}\n\n`) }
      let index = 0
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer)
          return
        }
        if (index < chunks.length) {
          write({ id: `r36-${round}`, choices: [{ index: 0, delta: { role: 'assistant', content: chunks[index++] }, finish_reason: null }], usage: null })
          return
        }
        clearInterval(timer)
        write({ id: `r36-${round}`, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 1000, total_tokens: 1020, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20 } })
        res.write('data: [DONE]\n\n')
        res.end()
      }, 90)
      res.on('close', () => clearInterval(timer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as { port: number }).port, requests }
}

async function configure(page: Page, port: number): Promise<void> {
  await page.evaluate(async (p) => {
    const ds = (window as unknown as { ds: { getSettings: () => Promise<Record<string, unknown>>; setSettings: (s: Record<string, unknown>) => Promise<boolean> } }).ds
    const current = await ds.getSettings()
    await ds.setSettings({ ...current, apiKey: 'r36-synthetic-only', baseUrl: `http://127.0.0.1:${p}`, model: 'deepseek-v4-flash', thinkingEnabled: false, toolsEnabled: false, planMode: false })
  }, port)
}

async function chooseLongwrite(page: Page): Promise<void> {
  await page.locator('.mode-popover-wrap > .modebar-btn').click()
  await page.locator('.mode-item', { hasText: '长文' }).click()
  const panel = page.locator('[aria-label="深度写作控制"]')
  await panel.waitFor()
  const toggle = panel.locator('input[type="checkbox"]').first()
  if (!(await toggle.isChecked())) await toggle.check({ force: true })
  await panel.locator('input[type="range"]').first().fill('4000')
}

async function switchToAgentLegacyPath(page: Page): Promise<void> {
  await page.locator('.mode-popover-wrap > .modebar-btn').click()
  await page.locator('.mode-item', { hasText: 'Agent' }).click()
}

async function waitForRequests(mock: Mock, count: number, page: Page): Promise<void> {
  const deadline = Date.now() + 30000
  while (mock.requests.length < count && Date.now() < deadline) await page.waitForTimeout(80)
}

async function waitForTerminal(page: Page): Promise<void> {
  await page.waitForFunction(() => !document.querySelector('.composer .btn.stop'), undefined, { timeout: 60000 })
  await page.waitForTimeout(300)
}

async function inspectDb(userData: string): Promise<{
  run: { run_id: string; status: string; config_json: string }
  assistantTurns: string[]
  canonical: string
}> {
  const db = new DatabaseSync(path.join(userData, 'deepwriter.db'))
  try {
    const run = db.prepare('SELECT run_id, status, config_json FROM runs ORDER BY started_at DESC LIMIT 1').get() as { run_id: string; status: string; config_json: string }
    const assistantTurns = (db.prepare("SELECT content FROM turns WHERE run_id = ? AND role = 'assistant' ORDER BY turn_seq").all(run.run_id) as Array<{ content: string }>).map((row) => row.content)
    const canonical = (db.prepare("SELECT content FROM session_messages WHERE session_id = (SELECT session_id FROM runs WHERE run_id = ?) AND role = 'assistant' ORDER BY seq DESC LIMIT 1").get(run.run_id) as { content?: string } | undefined)?.content ?? ''
    return { run, assistantTurns, canonical }
  } finally {
    db.close()
  }
}

async function quit(app: ElectronApplication): Promise<number> {
  const child = app.process()
  const exit = new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? 0)))
  await app.evaluate(({ app: electronApp }) => { electronApp.quit() }).catch(() => undefined)
  return Promise.race([exit, new Promise<number>((resolve) => setTimeout(() => resolve(255), 15000))])
}

async function main(): Promise<void> {
  await fsp.mkdir(EVIDENCE, { recursive: true })
  const userData = await fsp.mkdtemp(path.join(EVIDENCE, expectRed ? 'red-userdata-' : 'green-userdata-'))
  const mock = await startMock()
  let app: ElectronApplication | null = null
  let topTitle = ''
  let uiText = ''
  let runningDetail = ''
  let terminalDetailVisible = false
  try {
    app = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`], env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userData } })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForSelector('.composer', { timeout: 15000 })
    await configure(page, mock.port)
    await chooseLongwrite(page)
    if (expectRed) await switchToAgentLegacyPath(page)
    topTitle = (await page.locator('.dw-view-title').innerText()).trim()
    await page.locator('.composer textarea').fill('请严格写成四千字，并在结尾自然收束。')
    await page.locator('.composer .btn.primary').click()

    if (!expectRed) {
      const progress = page.locator('[data-testid="stream-progress"]')
      await progress.waitFor({ state: 'visible', timeout: 12000 })
      await waitForRequests(mock, 2, page)
      const detail = page.locator('[data-testid="stream-detail-button"]')
      await detail.click()
      const dialog = page.locator('.run-inspector[role="dialog"]')
      await dialog.waitFor({ state: 'visible' })
      runningDetail = await dialog.innerText()
      await page.locator('[aria-label="关闭任务详情"]').click()
    }

    await waitForTerminal(page)
    uiText = await page.locator('.msg.assistant .msg-bubble').last().innerText()
    if (!expectRed) {
      const terminalDetail = page.locator('.ghost-btn', { hasText: '查看任务详情' }).last()
      terminalDetailVisible = await terminalDetail.isVisible()
      await terminalDetail.click()
      await page.locator('.run-inspector[role="dialog"]').waitFor({ state: 'visible' })
    }
    const exitCode = await quit(app)
    check('app.quit exit 0', exitCode === 0, `exit=${exitCode}`)
  } finally {
    if (app) await app.close().catch(() => undefined)
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
  }

  const db = await inspectDb(userData)
  const config = JSON.parse(db.run.config_json) as { runMode?: string; longMode?: boolean; targetChars?: number; workspace?: string; deepWrite?: { targetChars?: number } }
  const uiChars = codePointLength(uiText)
  const durable = db.assistantTurns.join('')
  const durableChars = codePointLength(durable)
  const canonicalChars = codePointLength(db.canonical)

  if (expectRed) {
    check('RED 顶部错误显示 Agent', topTitle === 'Agent', topTitle)
    check('RED provider 只请求一轮', mock.requests.length === 1, `requests=${mock.requests.length}`)
    check('RED UI 正文不足 4000', uiChars > 0 && uiChars < 4000, `uiChars=${uiChars}`)
    check('RED 不足正文仍假 completed', db.run.status === 'completed', db.run.status)
    check('RED 快照 runMode=agent 但 longMode=true', config.runMode === 'agent' && config.longMode === true && config.deepWrite?.targetChars === 4000, JSON.stringify(config))
  } else {
    check('长文发送后顶部保持长文', topTitle === '长文', topTitle)
    check('stop-short 自动续作四轮', mock.requests.length === 4, `requests=${mock.requests.length}`)
    check('UI 正文严格 4000 code points', uiChars === 4000, `uiChars=${uiChars}`)
    check('durable turns 严格 4000 code points', durableChars === 4000 && db.assistantTurns.length === 4, `turns=${db.assistantTurns.length} chars=${durableChars}`)
    check('canonical 投影严格 4000 code points', canonicalChars === 4000, `canonicalChars=${canonicalChars}`)
    check('运行 completed 且快照单一真源', db.run.status === 'completed' && config.runMode === 'longwrite' && config.longMode === true && config.deepWrite?.targetChars === 4000 && config.workspace === 'novel', `${db.run.status} ${JSON.stringify(config)}`)
    check('运行中任务详情展示阶段与活动记录', /任务详情/.test(runningDetail) && /活动记录/.test(runningDetail) && /(生成正文|校验中|运行中)/.test(runningDetail), runningDetail.slice(0, 180))
    check('结束后仍可查看任务详情', terminalDetailVisible)
  }

  const result = {
    expectation: expectRed ? 'red' : 'green',
    executablePath,
    userData,
    topTitle,
    requestCount: mock.requests.length,
    uiChars,
    durableChars,
    canonicalChars,
    runStatus: db.run.status,
    config,
    checks,
    passed: checks.filter((item) => item.ok).length,
    failed: checks.filter((item) => !item.ok).length
  }
  const out = path.join(EVIDENCE, expectRed ? 'red-result.json' : 'green-result.json')
  await fsp.writeFile(out, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`\nR36 ${result.expectation}: ${result.passed} PASS / ${result.failed} FAIL`)
  console.log(`evidence: ${out}`)
  if (result.failed > 0) process.exitCode = 1
}

await main()
